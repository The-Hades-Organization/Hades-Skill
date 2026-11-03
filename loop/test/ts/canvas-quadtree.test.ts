// Quadtree de Barnes–Hut do layout de forças (src/lib/canvas-quadtree.ts).
import { describe, expect, test } from "bun:test";
import { Quadtree, QUADTREE_MAX_DEPTH, separationDirection, type Force } from "../../../src/lib/canvas-quadtree.ts";

/** Gerador congruencial com semente: pontos de teste reproduzíveis. */
const lcg = (seed: number) => {
  let s = seed >>> 0;
  return (): number => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
};
const points = (n: number, seed = 3, spread = 5000): { xs: Float64Array; ys: Float64Array } => {
  const rnd = lcg(seed);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = (rnd() - 0.5) * spread;
    ys[i] = (rnd() - 0.5) * spread;
  }
  return { xs, ys };
};
const treeOf = (xs: Float64Array, ys: Float64Array): Quadtree => {
  const tree = new Quadtree();
  tree.build(xs, ys, xs.length);
  return tree;
};
const query = (self: number, theta: number) => ({ self, theta, strength: 1000, minDistance: 1 });
const repulsion = (tree: Quadtree, self: number, theta: number): Force => {
  const out = { fx: 0, fy: 0 };
  tree.repulsion(query(self, theta), out);
  return out;
};
/** Repulsão exata, par a par, com a mesma lei (strength / d², d com piso em minDistance). */
const bruteForce = (xs: Float64Array, ys: Float64Array, self: number): Force => {
  const out = { fx: 0, fy: 0 };
  for (let j = 0; j < xs.length; j++) {
    if (j === self) continue;
    const dx = (xs[self] as number) - (xs[j] as number);
    const dy = (ys[self] as number) - (ys[j] as number);
    const d = Math.hypot(dx, dy);
    const f = 1000 / Math.max(d * d, 1);
    out.fx += (f * dx) / d;
    out.fy += (f * dy) / d;
  }
  return out;
};

describe("quadtree: repulsão", () => {
  test("dada a árvore vazia, então a força é zero e a busca por raio não acha ninguém", () => {
    const tree = treeOf(new Float64Array(0), new Float64Array(0));
    const out: number[] = [99];
    tree.within(0, 0, 1000, out);
    expect(out).toEqual([]);
    expect(tree.cellCountInUse).toBe(0);
  });

  test("dado um corpo só, então ele não empurra a si mesmo", () => {
    const tree = treeOf(new Float64Array([10]), new Float64Array([20]));
    expect(repulsion(tree, 0, 0.8)).toEqual({ fx: 0, fy: 0 });
  });

  test("dado theta 0, então a força é a exata, par a par", () => {
    const { xs, ys } = points(200);
    const tree = treeOf(xs, ys);
    for (const self of [0, 57, 199]) {
      const got = repulsion(tree, self, 0);
      const want = bruteForce(xs, ys, self);
      expect(got.fx).toBeCloseTo(want.fx, 9);
      expect(got.fy).toBeCloseTo(want.fy, 9);
    }
  });

  test("dado theta 0.8, então a aproximação fica perto da exata (erro relativo médio abaixo de 5%)", () => {
    const { xs, ys } = points(1000);
    const tree = treeOf(xs, ys);
    let error = 0;
    for (let self = 0; self < 1000; self += 10) {
      const got = repulsion(tree, self, 0.8);
      const want = bruteForce(xs, ys, self);
      error += Math.hypot(got.fx - want.fx, got.fy - want.fy) / Math.hypot(want.fx, want.fy);
    }
    expect(error / 100).toBeLessThan(0.05);
  });

  test("dados dois corpos, então as forças são iguais e opostas, afastando um do outro", () => {
    const tree = treeOf(new Float64Array([0, 100]), new Float64Array([0, 0]));
    const a = repulsion(tree, 0, 0.8);
    const b = repulsion(tree, 1, 0.8);
    expect(a.fx).toBeLessThan(0);
    expect(b.fx).toBeCloseTo(-a.fx, 12);
    expect(a.fy).toBe(0);
  });

  test("dados dois corpos no mesmo ponto, então a força é finita, oposta e com a distância mínima", () => {
    const tree = treeOf(new Float64Array([5, 5]), new Float64Array([5, 5]));
    const a = repulsion(tree, 0, 0.8);
    const b = repulsion(tree, 1, 0.8);
    expect(Number.isFinite(a.fx) && Number.isFinite(a.fy)).toBe(true);
    expect(Math.hypot(a.fx, a.fy)).toBeCloseTo(1000, 6);
    expect(b.fx).toBeCloseTo(-a.fx, 12);
    expect(b.fy).toBeCloseTo(-a.fy, 12);
  });
});

describe("quadtree: limites de profundidade", () => {
  test("dados 500 corpos no mesmo ponto, então a árvore não se divide (uma folha só)", () => {
    const tree = treeOf(new Float64Array(500).fill(7), new Float64Array(500).fill(7));
    expect(tree.cellCountInUse).toBe(1);
    const out: number[] = [];
    tree.within(7, 7, 0, out);
    expect(out).toHaveLength(500);
  });

  test("dados corpos quase juntos (abaixo da resolução da profundidade máxima), então a divisão para no teto", () => {
    const xs = new Float64Array([0, 1e6, 1e-9, 2e-9, 3e-9]);
    const ys = new Float64Array(5);
    const tree = treeOf(xs, ys);
    expect(tree.cellCountInUse).toBeLessThanOrEqual(1 + 4 * QUADTREE_MAX_DEPTH);
    const out: number[] = [];
    tree.within(0, 0, 1, out);
    expect(out.sort()).toEqual([0, 2, 3, 4]);
  });

  test("dado um corpo fora do plano (NaN), então a construção falha alto", () => {
    expect(() => treeOf(new Float64Array([0, NaN]), new Float64Array([0, 0]))).toThrow(RangeError);
  });

  test("dado count maior que os vetores, então a construção falha alto", () => {
    expect(() => new Quadtree().build(new Float64Array(2), new Float64Array(2), 3)).toThrow(RangeError);
  });
});

describe("quadtree: busca por raio", () => {
  test("dado um raio, então devolve exatamente os corpos a essa distância, inclusive na borda", () => {
    const { xs, ys } = points(800, 11);
    xs[0] = 0;
    ys[0] = 0;
    xs[1] = 300;
    ys[1] = 0;
    const tree = treeOf(xs, ys);
    const out: number[] = [];
    tree.within(0, 0, 300, out);
    const want: number[] = [];
    for (let i = 0; i < xs.length; i++) if (Math.hypot(xs[i] as number, ys[i] as number) <= 300) want.push(i);
    expect([...out].sort((a, b) => a - b)).toEqual(want);
    expect(out).toContain(1);
  });

  test("dada a mesma entrada, então a mesma árvore dá o mesmo resultado (reconstruir não muda nada)", () => {
    const { xs, ys } = points(300, 5);
    const tree = new Quadtree();
    tree.build(xs, ys, xs.length);
    const first = repulsion(tree, 42, 0.8);
    tree.build(xs, ys, xs.length);
    expect(repulsion(tree, 42, 0.8)).toEqual(first);
  });
});

describe("separationDirection", () => {
  test("dado um par, então a direção é unitária, estável e invertida do outro lado", () => {
    const [ax, ay] = separationDirection(3, 8);
    const [bx, by] = separationDirection(8, 3);
    expect(Math.hypot(ax, ay)).toBeCloseTo(1, 12);
    expect(bx).toBeCloseTo(-ax, 12);
    expect(by).toBeCloseTo(-ay, 12);
    expect(separationDirection(3, 8)).toEqual([ax, ay]);
  });
});
