// Quadtree de Barnes–Hut para o layout de forças (reference/argos.md §Layout de forças). Corpos de peso 1, guardados
// em vetores planos e reconstruídos a cada passo da simulação: uma árvore de objetos geraria lixo demais a 2000 corpos.
// Lógica pura e sem Node: roda no painel e no navegador.

/**
 * Profundidade máxima da árvore. Corpos que ainda dividem a mesma célula aqui (ou que estão no mesmo ponto) ficam
 * encadeados numa folha só, em vez de dividir sem fim.
 */
export const QUADTREE_MAX_DEPTH = 24;

export interface Force { fx: number; fy: number }

export interface RepulsionQuery {
  /** Índice do corpo que recebe a força (ele mesmo fica de fora). */
  self: number;
  /** Abertura de Barnes–Hut: uma célula de lado `s` à distância `d` conta como um ponto só quando `s / d < theta`. 0 é exato. */
  theta: number;
  /** A força entre dois corpos é `strength / d²`, afastando um do outro. */
  strength: number;
  /** Distância mínima na conta da força, para dois corpos quase juntos não se lançarem ao infinito. */
  minDistance: number;
}

/** Direção estável para separar dois corpos no mesmo ponto: depende só do par, e inverte de um lado para o outro. */
export function separationDirection(a: number, b: number): [number, number] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  let h = Math.imul(lo + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(hi + 0x7f4a7c15, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  const angle = ((h >>> 0) / 0x1_0000_0000) * 2 * Math.PI;
  const sign = a < b ? 1 : -1;
  return [Math.cos(angle) * sign, Math.sin(angle) * sign];
}

export class Quadtree {
  private xs: Float64Array = new Float64Array(0);
  private ys: Float64Array = new Float64Array(0);
  private count = 0;
  private nextBody: Int32Array = new Int32Array(0);

  private cells = 0;
  private cellX: Float64Array = new Float64Array(0);
  private cellY: Float64Array = new Float64Array(0);
  private cellSize: Float64Array = new Float64Array(0);
  private cellDepth: Int32Array = new Int32Array(0);
  private cellCount: Int32Array = new Int32Array(0);
  private cellSumX: Float64Array = new Float64Array(0);
  private cellSumY: Float64Array = new Float64Array(0);
  /** Primeiro dos quatro filhos (contíguos), ou -1 na folha. */
  private cellChild: Int32Array = new Int32Array(0);
  /** Primeiro corpo da folha, ou -1; os seguintes vêm por `nextBody`. */
  private cellFirst: Int32Array = new Int32Array(0);
  private readonly stack: number[] = [];

  /** Reconstrói a árvore com os `count` primeiros corpos de `xs`/`ys` (os vetores são lidos, não copiados). */
  build(xs: Float64Array, ys: Float64Array, count: number): void {
    if (count > xs.length || count > ys.length) throw new RangeError("quadtree: count maior que os vetores");
    this.xs = xs;
    this.ys = ys;
    this.count = count;
    if (this.nextBody.length < count) this.nextBody = new Int32Array(count);
    this.cells = 0;
    if (count === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = xs[i] as number;
      const y = ys[i] as number;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError(`quadtree: corpo ${i} fora do plano`);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // folga de 1 para o corpo na borda máxima cair dentro do quadrado (o teste de quadrante é semiaberto)
    const size = Math.max(maxX - minX, maxY - minY, 1) + 1;
    this.addCell(minX, minY, size, 0);
    for (let i = 0; i < count; i++) this.insert(i);
  }

  /** Repulsão sobre o corpo `query.self`, de todos os outros, aproximada por Barnes–Hut. Escreve em `out`. */
  repulsion(query: RepulsionQuery, out: Force): void {
    out.fx = 0;
    out.fy = 0;
    if (this.cells === 0) return;
    const { self, strength } = query;
    const theta2 = query.theta * query.theta;
    const min2 = query.minDistance * query.minDistance;
    const px = this.xs[self] as number;
    const py = this.ys[self] as number;
    const stack = this.stack;
    stack.length = 0;
    stack.push(0);
    while (stack.length > 0) {
      const c = stack.pop() as number;
      const n = this.cellCount[c] as number;
      if (n === 0) continue;
      const child = this.cellChild[c] as number;
      if (child < 0) {
        for (let b = this.cellFirst[c] as number; b >= 0; b = this.nextBody[b] as number) {
          if (b !== self) this.push(out, px - (this.xs[b] as number), py - (this.ys[b] as number), 1, strength, min2, self, b);
        }
        continue;
      }
      const x0 = this.cellX[c] as number;
      const y0 = this.cellY[c] as number;
      const size = this.cellSize[c] as number;
      const inside = px >= x0 && px < x0 + size && py >= y0 && py < y0 + size;
      const dx = px - (this.cellSumX[c] as number) / n;
      const dy = py - (this.cellSumY[c] as number) / n;
      // a célula que contém o próprio corpo é sempre aberta: aproximá-la contaria ele mesmo
      if (!inside && size * size < theta2 * (dx * dx + dy * dy)) {
        this.push(out, dx, dy, n, strength, min2, self, -1);
        continue;
      }
      for (let k = 0; k < 4; k++) stack.push(child + k);
    }
  }

  /** Índices dos corpos a no máximo `radius` de `(x, y)` (inclusive o próprio, se estiver lá). Escreve em `out`. */
  within(x: number, y: number, radius: number, out: number[]): void {
    out.length = 0;
    if (this.cells === 0) return;
    const r2 = radius * radius;
    const stack = this.stack;
    stack.length = 0;
    stack.push(0);
    while (stack.length > 0) {
      const c = stack.pop() as number;
      if (this.cellCount[c] === 0) continue;
      const x0 = this.cellX[c] as number;
      const y0 = this.cellY[c] as number;
      const size = this.cellSize[c] as number;
      const nx = x < x0 ? x0 - x : x > x0 + size ? x - x0 - size : 0;
      const ny = y < y0 ? y0 - y : y > y0 + size ? y - y0 - size : 0;
      if (nx * nx + ny * ny > r2) continue;
      const child = this.cellChild[c] as number;
      if (child >= 0) {
        for (let k = 0; k < 4; k++) stack.push(child + k);
        continue;
      }
      for (let b = this.cellFirst[c] as number; b >= 0; b = this.nextBody[b] as number) {
        const dx = (this.xs[b] as number) - x;
        const dy = (this.ys[b] as number) - y;
        if (dx * dx + dy * dy <= r2) out.push(b);
      }
    }
  }

  /** Células em uso (para teste e medição). */
  get cellCountInUse(): number {
    return this.cells;
  }

  private push(out: Force, dx: number, dy: number, weight: number, strength: number, min2: number, self: number, other: number): void {
    let d2 = dx * dx + dy * dy;
    let ux: number;
    let uy: number;
    if (d2 === 0) {
      // célula aproximada nunca chega aqui com d = 0 (ela teria sido aberta); só o par de corpos no mesmo ponto
      [ux, uy] = separationDirection(self, other);
    } else {
      const d = Math.sqrt(d2);
      ux = dx / d;
      uy = dy / d;
    }
    if (d2 < min2) d2 = min2;
    const f = (strength * weight) / d2;
    out.fx += f * ux;
    out.fy += f * uy;
  }

  private insert(b: number): void {
    const x = this.xs[b] as number;
    const y = this.ys[b] as number;
    let c = 0;
    for (;;) {
      const child = this.cellChild[c] as number;
      if (child >= 0) {
        this.addBody(c, x, y);
        c = child + this.quadrant(c, x, y);
        continue;
      }
      const first = this.cellFirst[c] as number;
      if (first < 0) {
        this.cellFirst[c] = b;
        this.nextBody[b] = -1;
        this.addBody(c, x, y);
        return;
      }
      const same = this.xs[first] === x && this.ys[first] === y;
      if (same || (this.cellDepth[c] as number) >= QUADTREE_MAX_DEPTH) {
        this.nextBody[b] = first;
        this.cellFirst[c] = b;
        this.addBody(c, x, y);
        return;
      }
      this.split(c, first);
    }
  }

  /** Folha ocupada vira nó interno; a corrente de corpos dela (todos no mesmo ponto) desce inteira para um filho. */
  private split(c: number, first: number): void {
    const x0 = this.cellX[c] as number;
    const y0 = this.cellY[c] as number;
    const half = (this.cellSize[c] as number) / 2;
    const depth = (this.cellDepth[c] as number) + 1;
    const child = this.addCell(x0, y0, half, depth);
    this.addCell(x0 + half, y0, half, depth);
    this.addCell(x0, y0 + half, half, depth);
    this.addCell(x0 + half, y0 + half, half, depth);
    const target = child + this.quadrant(c, this.xs[first] as number, this.ys[first] as number);
    this.cellFirst[target] = first;
    this.cellCount[target] = this.cellCount[c] as number;
    this.cellSumX[target] = this.cellSumX[c] as number;
    this.cellSumY[target] = this.cellSumY[c] as number;
    this.cellFirst[c] = -1;
    this.cellChild[c] = child;
  }

  private quadrant(c: number, x: number, y: number): number {
    const half = (this.cellSize[c] as number) / 2;
    return (x >= (this.cellX[c] as number) + half ? 1 : 0) + (y >= (this.cellY[c] as number) + half ? 2 : 0);
  }

  private addBody(c: number, x: number, y: number): void {
    this.cellCount[c] = (this.cellCount[c] as number) + 1;
    this.cellSumX[c] = (this.cellSumX[c] as number) + x;
    this.cellSumY[c] = (this.cellSumY[c] as number) + y;
  }

  private addCell(x: number, y: number, size: number, depth: number): number {
    if (this.cells === this.cellX.length) this.grow();
    const c = this.cells++;
    this.cellX[c] = x;
    this.cellY[c] = y;
    this.cellSize[c] = size;
    this.cellDepth[c] = depth;
    this.cellCount[c] = 0;
    this.cellSumX[c] = 0;
    this.cellSumY[c] = 0;
    this.cellChild[c] = -1;
    this.cellFirst[c] = -1;
    return c;
  }

  private grow(): void {
    const capacity = Math.max(64, this.cellX.length * 2);
    const f64 = (old: Float64Array): Float64Array => {
      const next = new Float64Array(capacity);
      next.set(old);
      return next;
    };
    const i32 = (old: Int32Array): Int32Array => {
      const next = new Int32Array(capacity);
      next.set(old);
      return next;
    };
    this.cellX = f64(this.cellX);
    this.cellY = f64(this.cellY);
    this.cellSize = f64(this.cellSize);
    this.cellSumX = f64(this.cellSumX);
    this.cellSumY = f64(this.cellSumY);
    this.cellDepth = i32(this.cellDepth);
    this.cellCount = i32(this.cellCount);
    this.cellChild = i32(this.cellChild);
    this.cellFirst = i32(this.cellFirst);
  }
}
