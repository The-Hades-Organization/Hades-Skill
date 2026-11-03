// Layout de forças do canvas (reference/argos.md §Layout de forças): repulsão por Barnes–Hut, molas nas arestas,
// gravidade fraca ao centro e amortecimento que para a simulação quando a energia cai abaixo do limiar. Implementa
// `CanvasLayout` (id `force`); `place` e `arrange` são as duas entradas dela, e `forceReheat` mexe só na vizinhança de
// um nó arrastado. Nó fixado (`locked` do documento ou o conjunto de pins) nunca se move.
// Determinístico: corpos e molas em ordem de id, perturbação inicial pela semente, sem relógio nem `Math.random`.
// Lógica pura e sem Node: roda no painel e no navegador.
import { CANVAS_LIMITS, type CanvasDoc } from "./canvas-doc.ts";
import { FREE_LAYOUT, LAYOUT_GAP, type ArrangeRequest, type CanvasLayout, type EnteringNode, type PlaceRequest, type Placement } from "./canvas-layout.ts";
import { Quadtree, separationDirection, type Force } from "./canvas-quadtree.ts";

export const FORCE_LAYOUT_ID = "force";

export const FORCE_ERRORS = {
  tooManyNodes: "force_too_many_nodes",
  tooManySprings: "force_too_many_springs",
  tooManySteps: "force_too_many_steps",
  invalidParam: "force_invalid_param",
  invalidInput: "force_invalid_input",
  diverged: "force_diverged",
} as const;
export type ForceErrorCode = (typeof FORCE_ERRORS)[keyof typeof FORCE_ERRORS];

export class ForceError extends Error {
  readonly code: ForceErrorCode;
  /** Parâmetro ou id que causou o erro, quando há um. */
  readonly subject: string | undefined;
  constructor(code: ForceErrorCode, message: string, subject?: string) {
    super(message);
    this.name = "ForceError";
    this.code = code;
    this.subject = subject;
  }
}

export const FORCE_LIMITS = {
  /** Nós na simulação (documento + entrando): o mesmo teto do documento. */
  nodes: CANVAS_LIMITS.nodes,
  /** Pares ligados distintos (molas). */
  springs: 10_000,
  /** Teto de `maxSteps`. */
  steps: 5000,
  /** Teto de `hops` no reaquecer. */
  hops: 8,
} as const;

export interface ForceParams {
  /** Comprimento de repouso da mola, entre centros (px). */
  springLength: number;
  /** Rigidez da mola: força = rigidez × (distância − repouso). */
  springStrength: number;
  /** Repulsão entre todo par: força = repulsão / distância². */
  repulsion: number;
  /** Puxão ao centro de massa: força = gravidade × distância. */
  gravity: number;
  /** Fração da sobreposição que vira velocidade de afastamento, por passo, entre nós que encostam (círculo da meia diagonal + metade da folga). */
  collision: number;
  /** Folga mínima entre nós (px). */
  gap: number;
  /** Fração da velocidade que sobra a cada passo, em [0, 1). */
  damping: number;
  /**
   * Resfriamento: a cada passo as forças (fora a colisão) são multiplicadas por `1 − cooling`. Sem ele, o ruído do
   * Barnes–Hut e o modo lento da gravidade seguram a energia acima do limiar por milhares de passos. 0 desliga.
   */
  cooling: number;
  /** Abertura de Barnes–Hut (0 é exato e quadrático). */
  theta: number;
  /** Deslocamento máximo de um nó por passo (px). */
  maxSpeed: number;
  /** Assenta quando a média de velocidade² por nó móvel cai abaixo disto (px²/passo²). */
  energyThreshold: number;
  maxSteps: number;
  /** Semente da perturbação inicial: outra semente, outro arranjo igualmente válido. */
  seed: number;
}

export const FORCE_DEFAULTS: Readonly<ForceParams> = Object.freeze({
  springLength: 280,
  springStrength: 0.04,
  repulsion: 500_000,
  gravity: 0.0002,
  collision: 0.8,
  gap: LAYOUT_GAP,
  damping: 0.6,
  cooling: 0.015,
  theta: 0.8,
  maxSpeed: 60,
  energyThreshold: 0.25,
  maxSteps: 1500,
  seed: 1,
});

type Range = { min: number; max: number; minOpen?: boolean; maxOpen?: boolean; integer?: boolean };
const PARAM_RANGES: Record<keyof ForceParams, Range> = {
  springLength: { min: 1, max: 100_000 },
  springStrength: { min: 0, max: 1 },
  repulsion: { min: 0, max: 1e12 },
  gravity: { min: 0, max: 1 },
  collision: { min: 0, max: 1 },
  gap: { min: 0, max: 10_000 },
  damping: { min: 0, max: 1, maxOpen: true },
  cooling: { min: 0, max: 1, maxOpen: true },
  theta: { min: 0, max: 2 },
  maxSpeed: { min: 0, max: 100_000, minOpen: true },
  energyThreshold: { min: 0, max: 1e12, minOpen: true },
  maxSteps: { min: 1, max: FORCE_LIMITS.steps, integer: true },
  seed: { min: 0, max: 0xffff_ffff, integer: true },
};

const fail = (code: ForceErrorCode, message: string, subject?: string): never => {
  throw new ForceError(code, message, subject);
};

/** Mescla `overrides` sobre os padrões e confere cada valor; lança `ForceError`. */
export function resolveForceParams(overrides: Partial<ForceParams> = {}): Readonly<ForceParams> {
  const out: ForceParams = { ...FORCE_DEFAULTS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(PARAM_RANGES, key)) return fail(FORCE_ERRORS.invalidParam, `parâmetro desconhecido "${key}"`, key);
    if (value === undefined) continue;
    const name = key as keyof ForceParams;
    const range = PARAM_RANGES[name];
    if (name === "maxSteps" && typeof value === "number" && Number.isInteger(value) && value > FORCE_LIMITS.steps) {
      return fail(FORCE_ERRORS.tooManySteps, `"maxSteps" passa do teto de ${FORCE_LIMITS.steps}`, key);
    }
    const ok = typeof value === "number" && Number.isFinite(value)
      && (range.minOpen ? value > range.min : value >= range.min)
      && (range.maxOpen ? value < range.max : value <= range.max)
      && (!range.integer || Number.isInteger(value));
    if (!ok) return fail(FORCE_ERRORS.invalidParam, `"${key}" fora da faixa ${range.min}..${range.max}`, key);
    out[name] = value;
  }
  return Object.freeze(out);
}

export interface ForceOptions {
  /** Ids fixados além dos `locked` do documento. Id que não está no pedido é ignorado. */
  pinned?: ReadonlySet<string>;
  params?: Partial<ForceParams>;
}

export interface ForceRun {
  placements: Placement[];
  /** Passos simulados (0 quando ninguém podia se mexer). */
  steps: number;
  /** A energia caiu abaixo do limiar antes do teto de passos. */
  settled: boolean;
  /** Média de velocidade² por nó móvel no último passo. */
  energy: number;
}

export interface ReheatRequest extends ArrangeRequest {
  /** O nó arrastado: fica onde o dono o soltou; a vizinhança dele volta a mexer. */
  from: string;
  /** Até quantas arestas de distância de `from` a vizinhança vai (padrão 2, teto `FORCE_LIMITS.hops`). */
  hops?: number;
}

export const REHEAT_HOPS = 2;
/** Distância mínima na conta da repulsão: dois nós quase no mesmo ponto não se lançam longe demais. */
const MIN_DISTANCE = 10;

/** Fixa o nó: devolve um conjunto novo. */
export function pinNode(pins: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return new Set(pins).add(id);
}

/**
 * Solta o nó (desfaz o pin): devolve um conjunto novo. O `locked` do documento não é pin e não sai por aqui: destravar
 * é um comando sobre o documento.
 */
export function releaseNode(pins: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(pins);
  next.delete(id);
  return next;
}

/** `x`, `y` são o centro, que a simulação move; `left`, `top` são a posição de partida, devolvida a quem fica fixo. */
interface Body { id: string; w: number; h: number; x: number; y: number; left: number; top: number; movable: boolean }

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Hash de 32 bits do id com a semente (FNV-1a com mistura final), para a perturbação inicial. */
function hashId(id: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

function checkBox(id: string, x: number, y: number, w: number, h: number): void {
  const finite = [x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v));
  if (!finite || w <= 0 || h <= 0) fail(FORCE_ERRORS.invalidInput, `nó "${id}" com posição ou tamanho inválido`, id);
}

function docBodies(doc: CanvasDoc, movable: (id: string, locked: boolean) => boolean): Body[] {
  const seen = new Set<string>();
  const bodies: Body[] = [];
  for (const node of doc.nodes) {
    if (seen.has(node.id)) return fail(FORCE_ERRORS.invalidInput, `nó "${node.id}" repetido`, node.id);
    seen.add(node.id);
    checkBox(node.id, node.x, node.y, node.w, node.h);
    bodies.push({ id: node.id, w: node.w, h: node.h, x: node.x + node.w / 2, y: node.y + node.h / 2, left: node.x, top: node.y, movable: movable(node.id, node.locked) });
  }
  return bodies;
}

function checkNodeCount(count: number): void {
  if (count > FORCE_LIMITS.nodes) fail(FORCE_ERRORS.tooManyNodes, `${count} nós passam do teto de ${FORCE_LIMITS.nodes}`);
}

/** Pares ligados distintos entre corpos da simulação, em ordem estável. Id de fora e laço no próprio nó ficam de fora. */
function springPairs(index: ReadonlyMap<string, number>, neighbors: ReadonlyMap<string, readonly string[]>): Int32Array {
  const keys = new Set<number>();
  const count = index.size;
  for (const [id, others] of neighbors) {
    const a = index.get(id);
    if (a === undefined) continue;
    for (const other of others) {
      const b = index.get(other);
      if (b === undefined || b === a) continue;
      keys.add(Math.min(a, b) * count + Math.max(a, b));
      if (keys.size > FORCE_LIMITS.springs) return fail(FORCE_ERRORS.tooManySprings, `mais de ${FORCE_LIMITS.springs} pares ligados`);
    }
  }
  const sorted = [...keys].sort((p, q) => p - q);
  const pairs = new Int32Array(sorted.length * 2);
  sorted.forEach((key, k) => {
    pairs[2 * k] = Math.floor(key / count);
    pairs[2 * k + 1] = key % count;
  });
  return pairs;
}

export interface ForceProgress {
  /** Passos simulados até agora. */
  steps: number;
  settled: boolean;
  energy: number;
  /** Acabou: assentou, bateu `maxSteps` ou ninguém podia se mexer. Passo pedido depois disso não faz nada. */
  done: boolean;
}

/** Simulação em andamento, para a página avançar em fatias por quadro (animada, e cancelável parando de chamar). */
export interface ForceSimulation {
  /** Avança até `n` passos (inteiro de 1 a `FORCE_LIMITS.steps`), parando antes se acabar. */
  step(n: number): ForceProgress;
  /** Posições atuais, no mesmo formato da função de uma vez só (`forceArrange` ou `forceReheat`). */
  placements(): Placement[];
}

interface Stepper { advance(limit: number): ForceProgress }

/**
 * Prepara a simulação dos corpos `movable` (posições de centro, gravadas de volta em `bodies` a cada avanço). Os fixos
 * empurram e puxam, mas não saem do lugar. Todas as forças do passo são calculadas antes de qualquer corpo andar.
 * Avançar em fatias dá exatamente o mesmo resultado que avançar de uma vez.
 */
function startSimulation(bodies: Body[], springs: Int32Array, params: Readonly<ForceParams>): Stepper {
  const n = bodies.length;
  const movers: number[] = [];
  for (let i = 0; i < n; i++) if (bodies[i]?.movable) movers.push(i);
  if (movers.length === 0) return { advance: () => ({ steps: 0, settled: true, energy: 0, done: true }) };

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const radius = new Float64Array(n);
  let maxRadius = 0;
  let cx = 0;
  let cy = 0;
  bodies.forEach((body, i) => {
    xs[i] = body.x;
    ys[i] = body.y;
    radius[i] = Math.hypot(body.w, body.h) / 2 + params.gap / 2;
    maxRadius = Math.max(maxRadius, radius[i] as number);
    cx += body.x;
    cy += body.y;
  });
  cx /= n;
  cy /= n;
  // perturbação de até meio pixel: quebra simetria exata (cadeia em linha reta, nós no mesmo ponto) sem mexer no desenho
  for (const i of movers) {
    const h = hashId((bodies[i] as Body).id, params.seed);
    xs[i] = (xs[i] as number) + ((h & 0xffff) / 0xffff - 0.5);
    ys[i] = (ys[i] as number) + ((h >>> 16) / 0xffff - 0.5);
  }

  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const sepX = new Float64Array(n);
  const sepY = new Float64Array(n);
  const tree = new Quadtree();
  const push: Force = { fx: 0, fy: 0 };
  const near: number[] = [];
  const query = { self: 0, theta: params.theta, strength: params.repulsion, minDistance: MIN_DISTANCE };
  const maxSpeed2 = params.maxSpeed * params.maxSpeed;

  // A colisão entra direto na velocidade, sem resfriamento: com resfriamento a sobreposição sobraria no fim. Medido:
  // como correção de posição fora da velocidade, nós encostados ficavam tremendo ~1 px e a simulação levava o dobro de
  // passos para assentar. Cada um leva a sua parte da sobreposição (tudo, se o outro está fixo).
  const separate = (i: number, out: number[]): void => {
    const xi = xs[i] as number;
    const yi = ys[i] as number;
    tree.within(xi, yi, (radius[i] as number) + maxRadius, out);
    for (const j of out) {
      if (j === i) continue;
      const dx = xi - (xs[j] as number);
      const dy = yi - (ys[j] as number);
      const d = Math.hypot(dx, dy);
      const overlap = (radius[i] as number) + (radius[j] as number) - d;
      if (overlap <= 0) continue;
      const [ux, uy] = d === 0 ? separationDirection(i, j) : [dx / d, dy / d];
      const share = (bodies[j] as Body).movable ? 0.5 : 1;
      sepX[i] = (sepX[i] as number) + params.collision * overlap * share * ux;
      sepY[i] = (sepY[i] as number) + params.collision * overlap * share * uy;
    }
  };

  let alpha = 1;
  let energy = 0;
  let steps = 0;
  let settled = false;
  const progress = (): ForceProgress => ({ steps, settled, energy, done: settled || steps >= params.maxSteps });

  const advance = (limit: number): ForceProgress => {
    for (let k = 0; k < limit && !progress().done; k++) {
      stepOnce();
      steps++;
      settled = energy < params.energyThreshold;
    }
    writeBack(bodies, movers, xs, ys);
    return progress();
  };

  function stepOnce(): void {
    tree.build(xs, ys, n);
    for (const i of movers) {
      query.self = i;
      tree.repulsion(query, push);
      fx[i] = push.fx + params.gravity * (cx - (xs[i] as number));
      fy[i] = push.fy + params.gravity * (cy - (ys[i] as number));
      if (params.collision > 0) separate(i, near);
    }
    for (let k = 0; k < springs.length; k += 2) {
      const a = springs[k] as number;
      const b = springs[k + 1] as number;
      const dx = (xs[b] as number) - (xs[a] as number);
      const dy = (ys[b] as number) - (ys[a] as number);
      const d = Math.hypot(dx, dy);
      if (d === 0) continue;
      const f = (params.springStrength * (d - params.springLength)) / d;
      fx[a] = (fx[a] as number) + f * dx;
      fy[a] = (fy[a] as number) + f * dy;
      fx[b] = (fx[b] as number) - f * dx;
      fy[b] = (fy[b] as number) - f * dy;
    }

    energy = 0;
    for (const i of movers) {
      let ux = ((vx[i] as number) + alpha * (fx[i] as number) + (sepX[i] as number)) * params.damping;
      let uy = ((vy[i] as number) + alpha * (fy[i] as number) + (sepY[i] as number)) * params.damping;
      const speed2 = ux * ux + uy * uy;
      if (speed2 > maxSpeed2) {
        const scale = params.maxSpeed / Math.sqrt(speed2);
        ux *= scale;
        uy *= scale;
      }
      vx[i] = ux;
      vy[i] = uy;
      xs[i] = (xs[i] as number) + ux;
      ys[i] = (ys[i] as number) + uy;
      energy += ux * ux + uy * uy;
    }
    energy /= movers.length;
    fx.fill(0);
    fy.fill(0);
    sepX.fill(0);
    sepY.fill(0);
    alpha *= 1 - params.cooling;
  }

  return { advance };
}

/** Roda até acabar. */
function simulate(bodies: Body[], springs: Int32Array, params: Readonly<ForceParams>): Omit<ForceProgress, "done"> {
  const { steps, settled, energy } = startSimulation(bodies, springs, params).advance(params.maxSteps);
  return { steps, settled, energy };
}

function checkSlice(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > FORCE_LIMITS.steps) fail(FORCE_ERRORS.invalidParam, `passos por fatia fora da faixa 1..${FORCE_LIMITS.steps}`, "n");
}

function simulationOf(bodies: Body[], springs: Int32Array, params: Readonly<ForceParams>, read: () => Placement[]): ForceSimulation {
  const stepper = startSimulation(bodies, springs, params);
  return {
    step(n) {
      checkSlice(n);
      return stepper.advance(n);
    },
    placements: read,
  };
}

function writeBack(bodies: Body[], movers: readonly number[], xs: Float64Array, ys: Float64Array): void {
  for (const i of movers) {
    const body = bodies[i] as Body;
    body.x = xs[i] as number;
    body.y = ys[i] as number;
  }
}

/** Canto superior esquerdo, inteiro, dentro da faixa do documento (fora dela é `force_diverged`, nunca truncado). */
function topLeft(body: Body): Placement {
  const x = Math.round(body.x - body.w / 2);
  const y = Math.round(body.y - body.h / 2);
  const limit = CANVAS_LIMITS.coordinate;
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > limit || Math.abs(y) > limit) {
    return fail(FORCE_ERRORS.diverged, `o nó "${body.id}" saiu da faixa do documento`, body.id);
  }
  return { id: body.id, x, y };
}

function indexOf(bodies: readonly Body[]): Map<string, number> {
  return new Map(bodies.map((body, i) => [body.id, i]));
}

type Pins = ReadonlySet<string>;
const isFixed = (pins: Pins) => (id: string, locked: boolean): boolean => locked || pins.has(id);

/** `place`: só os nós de `entering` se mexem, a partir do lugar que o layout livre daria; o documento fica parado. */
export function forcePlace(request: PlaceRequest, options: ForceOptions = {}): ForceRun {
  const params = resolveForceParams(options.params);
  const pins = options.pinned ?? new Set<string>();
  checkNodeCount(request.doc.nodes.length + request.entering.length);
  const bodies = docBodies(request.doc, () => false);
  const ids = new Set(bodies.map((body) => body.id));
  for (const node of request.entering) {
    if (ids.has(node.id)) return fail(FORCE_ERRORS.invalidInput, `nó "${node.id}" já está no documento ou repetido`, node.id);
    ids.add(node.id);
  }
  if (request.entering.length === 0) return { placements: [], steps: 0, settled: true, energy: 0 };

  const start = new Map(FREE_LAYOUT.place(request).map((spot) => [spot.id, spot]));
  const entering: EnteringNode[] = [...request.entering].sort(byId);
  for (const node of entering) {
    const spot = start.get(node.id);
    if (!spot) return fail(FORCE_ERRORS.invalidInput, `o layout livre não posicionou "${node.id}"`, node.id);
    checkBox(node.id, spot.x, spot.y, node.w, node.h);
    bodies.push({ id: node.id, w: node.w, h: node.h, x: spot.x + node.w / 2, y: spot.y + node.h / 2, left: spot.x, top: spot.y, movable: !pins.has(node.id) });
  }
  bodies.sort(byId);
  const run = simulate(bodies, springPairs(indexOf(bodies), request.neighbors), params);
  const enteringIds = new Set(entering.map((node) => node.id));
  const moved = bodies.filter((body) => enteringIds.has(body.id));
  undoOverlaps(bodies, moved, params.gap);
  return { ...run, placements: moved.map(topLeft) };
}

/**
 * Garantia do `place` (a mesma do layout livre): nó novo não encosta em ninguém. A colisão da simulação é macia; quem
 * ainda encostar volta ao lugar do layout livre, que não encosta no documento nem nos outros novos, e repete até
 * ninguém mais encostar (cada volta tira ao menos um nó do jogo, então termina).
 */
function undoOverlaps(bodies: Body[], moved: Body[], gap: number): void {
  const tree = new Quadtree();
  const xs = new Float64Array(bodies.length);
  const ys = new Float64Array(bodies.length);
  const index = indexOf(bodies);
  let maxHalf = 0;
  for (const body of bodies) maxHalf = Math.max(maxHalf, Math.hypot(body.w, body.h) / 2);
  const near: number[] = [];
  const settled = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    bodies.forEach((body, i) => {
      xs[i] = body.x;
      ys[i] = body.y;
    });
    tree.build(xs, ys, bodies.length);
    for (const body of moved) {
      if (settled.has(body.id)) continue;
      const self = index.get(body.id) as number;
      tree.within(body.x, body.y, Math.hypot(body.w, body.h) / 2 + maxHalf + gap, near);
      const touches = near.some((j) => j !== self && boxesTouch(body, bodies[j] as Body, gap));
      if (!touches) continue;
      body.x = body.left + body.w / 2;
      body.y = body.top + body.h / 2;
      settled.add(body.id);
      changed = true;
    }
  }
}

function boxesTouch(a: Body, b: Body, gap: number): boolean {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w + 2 * gap && Math.abs(a.y - b.y) * 2 < a.h + b.h + 2 * gap;
}

/** `arrange`: o documento inteiro se reorganiza a partir das posições atuais; os fixados ficam. Uma posição por nó. */
export function forceArrange(request: ArrangeRequest, options: ForceOptions = {}): ForceRun {
  return runToEnd(startArrange(request, options));
}

/** `arrange` em passos: a mesma simulação de `forceArrange`, para avançar em fatias. */
export function startArrange(request: ArrangeRequest, options: ForceOptions = {}): ForceSimulation {
  const params = resolveForceParams(options.params);
  checkNodeCount(request.doc.nodes.length);
  const fixed = isFixed(options.pinned ?? new Set<string>());
  const bodies = docBodies(request.doc, (id, locked) => !fixed(id, locked)).sort(byId);
  const read = (): Placement[] => bodies.map((body) => (body.movable ? topLeft(body) : { id: body.id, x: body.left, y: body.top }));
  return simulationOf(bodies, springPairs(indexOf(bodies), request.neighbors), params, read);
}

/** Roda até acabar (o avanço já para em `maxSteps`). */
function runToEnd(simulation: ForceSimulation): ForceRun {
  const { steps, settled, energy } = simulation.step(FORCE_LIMITS.steps);
  return { placements: simulation.placements(), steps, settled, energy };
}

/**
 * Reaquecer local: depois de arrastar `from`, só os nós a até `hops` arestas dele voltam a mexer (fora os fixados e o
 * próprio `from`, que fica onde o dono o soltou). Devolve a posição só de quem podia mexer.
 */
export function forceReheat(request: ReheatRequest, options: ForceOptions = {}): ForceRun {
  return runToEnd(startReheat(request, options));
}

/** Reaquecer local em passos: a mesma simulação de `forceReheat`, para avançar em fatias. */
export function startReheat(request: ReheatRequest, options: ForceOptions = {}): ForceSimulation {
  const params = resolveForceParams(options.params);
  const hops = request.hops ?? REHEAT_HOPS;
  if (!Number.isInteger(hops) || hops < 0 || hops > FORCE_LIMITS.hops) {
    return fail(FORCE_ERRORS.invalidParam, `"hops" fora da faixa 0..${FORCE_LIMITS.hops}`, "hops");
  }
  checkNodeCount(request.doc.nodes.length);
  const inDoc = new Set(request.doc.nodes.map((node) => node.id));
  if (!inDoc.has(request.from)) return fail(FORCE_ERRORS.invalidInput, `"${request.from}" não está no documento`, request.from);

  const reach = new Set([request.from]);
  let frontier = [request.from];
  for (let level = 0; level < hops && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of request.neighbors.get(id) ?? []) {
        if (!inDoc.has(other) || reach.has(other)) continue;
        reach.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  const fixed = isFixed(options.pinned ?? new Set<string>());
  const bodies = docBodies(request.doc, (id, locked) => id !== request.from && reach.has(id) && !fixed(id, locked)).sort(byId);
  const read = (): Placement[] => bodies.filter((body) => body.movable).map(topLeft);
  return simulationOf(bodies, springPairs(indexOf(bodies), request.neighbors), params, read);
}

/** O layout de forças como `CanvasLayout`, com os pins e parâmetros dados (conferidos aqui, na criação). */
export function createForceLayout(options: ForceOptions = {}): CanvasLayout {
  const resolved: ForceOptions = { pinned: options.pinned, params: resolveForceParams(options.params) };
  return Object.freeze({
    id: FORCE_LAYOUT_ID,
    label: "Forças",
    place: (request: PlaceRequest) => forcePlace(request, resolved).placements,
    arrange: (request: ArrangeRequest) => forceArrange(request, resolved).placements,
  });
}

export const FORCE_LAYOUT: CanvasLayout = createForceLayout();
