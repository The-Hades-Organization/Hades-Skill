// Layout de forças do canvas (src/lib/canvas-force.ts).
import { describe, expect, test } from "bun:test";
import { CANVAS_LIMITS, emptyCanvasDoc, type CanvasDoc, type CanvasNode } from "../../../src/lib/canvas-doc.ts";
import { createLayoutRegistry, FREE_LAYOUT, LAYOUT_GAP, type EnteringNode, type Placement } from "../../../src/lib/canvas-layout.ts";
import {
  createForceLayout, FORCE_DEFAULTS, FORCE_ERRORS, FORCE_LAYOUT, FORCE_LAYOUT_ID, FORCE_LIMITS, forceArrange, ForceError, forcePlace, forceReheat,
  pinNode, releaseNode, resolveForceParams, startArrange, startReheat, type ForceErrorCode,
} from "../../../src/lib/canvas-force.ts";

const node = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: "agent", x, y, w: 200, h: 66, z: 0, data: {}, locked: false, blurred: false, ...extra });
const docOf = (...nodes: CanvasNode[]): CanvasDoc => ({ ...emptyCanvasDoc(), nodes });
const entering = (id: string): EnteringNode => ({ id, type: "agent", w: 200, h: 66 });
const links = (...pairs: [string, string][]): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const [a, b] of pairs) {
    out.set(a, [...(out.get(a) ?? []), b]);
    out.set(b, [...(out.get(b) ?? []), a]);
  }
  return out;
};
const chain = (n: number): [string, string][] => Array.from({ length: n - 1 }, (_, i): [string, string] => [`n${i}`, `n${i + 1}`]);
/** Nós em grade apertada (encostados), como um documento recém-montado à mão. */
const grid = (n: number): CanvasNode[] => Array.from({ length: n }, (_, i) => node(`n${i}`, (i % 5) * 210, Math.floor(i / 5) * 70));
const byPlacement = (placements: readonly Placement[]): Map<string, Placement> => new Map(placements.map((p) => [p.id, p]));
const distance = (a: Placement | undefined, b: Placement | undefined): number => Math.hypot((a?.x ?? NaN) - (b?.x ?? NaN), (a?.y ?? NaN) - (b?.y ?? NaN));
type Box = { x: number; y: number; w: number; h: number };
const touches = (a: Box, b: Box, gap: number): boolean => a.x - gap < b.x + b.w && b.x < a.x + a.w + gap && a.y - gap < b.y + b.h && b.y < a.y + a.h + gap;
const boxOf = (p: Placement): Box => ({ x: p.x, y: p.y, w: 200, h: 66 });
const anyTouch = (boxes: readonly Box[], gap: number): boolean => boxes.some((a, i) => boxes.some((b, j) => j > i && touches(a, b, gap)));
const errorCode = (fn: () => unknown): ForceErrorCode | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ForceError) return error.code;
    throw error;
  }
  return undefined;
};
/** Embaralha de forma reproduzível (sem acaso solto). */
const reversed = <T,>(items: readonly T[]): T[] => [...items].reverse();

describe("layout de forças: arrange", () => {
  test("dada uma cadeia encostada, então assenta antes do teto de passos e diz em quantos", () => {
    const run = forceArrange({ doc: docOf(...grid(10)), neighbors: links(...chain(10)) });
    expect(run.settled).toBe(true);
    expect(run.steps).toBeGreaterThan(0);
    expect(run.steps).toBeLessThan(FORCE_DEFAULTS.maxSteps);
    expect(run.energy).toBeLessThan(FORCE_DEFAULTS.energyThreshold);
  });

  test("dado um documento, então devolve uma posição inteira por nó, em ordem de id", () => {
    const run = forceArrange({ doc: docOf(...reversed(grid(7))), neighbors: links(...chain(7)) });
    expect(run.placements.map((p) => p.id)).toEqual(["n0", "n1", "n2", "n3", "n4", "n5", "n6"]);
    for (const p of run.placements) expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
  });

  test("dados nós encostados, então no fim nenhum encosta em outro (com a folga)", () => {
    const run = forceArrange({ doc: docOf(...grid(15)), neighbors: links(...chain(15)) });
    expect(anyTouch(run.placements.map(boxOf), LAYOUT_GAP)).toBe(false);
  });

  test("dados dois grupos sem aresta entre eles, então quem tem aresta fica mais perto que quem não tem", () => {
    const run = forceArrange({ doc: docOf(...grid(6)), neighbors: links(["n0", "n1"], ["n1", "n2"], ["n2", "n0"], ["n3", "n4"], ["n4", "n5"], ["n5", "n3"]) });
    const at = byPlacement(run.placements);
    const inside = Math.max(distance(at.get("n0"), at.get("n1")), distance(at.get("n3"), at.get("n4")));
    const across = Math.min(distance(at.get("n0"), at.get("n3")), distance(at.get("n1"), at.get("n4")), distance(at.get("n2"), at.get("n5")));
    expect(inside).toBeLessThan(across);
  });

  test("dado um nó travado no documento, então ele volta exatamente onde estava", () => {
    const nodes = grid(8);
    nodes[3] = node("n3", 777, -333, { locked: true });
    const run = forceArrange({ doc: docOf(...nodes), neighbors: links(...chain(8)) });
    expect(byPlacement(run.placements).get("n3")).toEqual({ id: "n3", x: 777, y: -333 });
  });

  test("dado um pin passado, então o nó fica, e soltá-lo deixa ele se mexer de novo", () => {
    const request = { doc: docOf(...grid(8)), neighbors: links(...chain(8)) };
    const pins = pinNode(new Set<string>(), "n0");
    expect(byPlacement(forceArrange(request, { pinned: pins }).placements).get("n0")).toEqual({ id: "n0", x: 0, y: 0 });
    const released = releaseNode(pins, "n0");
    expect(released.has("n0")).toBe(false);
    expect(byPlacement(forceArrange(request, { pinned: released }).placements).get("n0")).not.toEqual({ id: "n0", x: 0, y: 0 });
  });

  test("dado tudo fixado, então não simula: zero passos, assentado, posições intactas", () => {
    const nodes = grid(3).map((n) => ({ ...n, locked: true }));
    const run = forceArrange({ doc: docOf(...nodes), neighbors: links(...chain(3)) });
    expect(run).toEqual({ steps: 0, settled: true, energy: 0, placements: nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })) });
  });

  test("dado o documento vazio, então não há posição nem passo", () => {
    expect(forceArrange({ doc: emptyCanvasDoc(), neighbors: new Map() })).toEqual({ placements: [], steps: 0, settled: true, energy: 0 });
  });

  test("dado o teto de passos curto demais, então para nele e diz que não assentou", () => {
    const run = forceArrange({ doc: docOf(...grid(10)), neighbors: links(...chain(10)) }, { params: { maxSteps: 2 } });
    expect(run.steps).toBe(2);
    expect(run.settled).toBe(false);
  });

  test("dado vizinho fora do documento ou laço no próprio nó, então é ignorado", () => {
    const doc = docOf(...grid(4));
    const plain = forceArrange({ doc, neighbors: links(...chain(4)) });
    const noisy = forceArrange({ doc, neighbors: links(...chain(4), ["n0", "fantasma"], ["n2", "n2"]) });
    expect(noisy).toEqual(plain);
  });
});

describe("layout de forças: determinismo", () => {
  test("dada a mesma entrada, então a mesma saída", () => {
    const request = () => ({ doc: docOf(...grid(12)), neighbors: links(...chain(12), ["n0", "n7"]) });
    expect(forceArrange(request())).toEqual(forceArrange(request()));
  });

  test("dada a mesma entrada em outra ordem (nós e arestas), então a mesma saída", () => {
    const pairs: [string, string][] = [...chain(12), ["n0", "n7"]];
    const a = forceArrange({ doc: docOf(...grid(12)), neighbors: links(...pairs) });
    const b = forceArrange({ doc: docOf(...reversed(grid(12))), neighbors: links(...reversed(pairs).map(([x, y]): [string, string] => [y, x])) });
    expect(b).toEqual(a);
  });

  test("dada outra semente, então outro arranjo, ainda sem nó encostado", () => {
    const request = { doc: docOf(...grid(12)), neighbors: links(...chain(12)) };
    const a = forceArrange(request, { params: { seed: 1 } });
    const b = forceArrange(request, { params: { seed: 2 } });
    expect(b.placements).not.toEqual(a.placements);
    expect(anyTouch(b.placements.map(boxOf), LAYOUT_GAP)).toBe(false);
  });

  test("dados nós todos no mesmo ponto, então eles se separam do mesmo jeito a cada vez", () => {
    const request = () => ({ doc: docOf(...["a", "b", "c", "d"].map((id) => node(id, 0, 0))), neighbors: new Map<string, string[]>() });
    const run = forceArrange(request());
    expect(anyTouch(run.placements.map(boxOf), 0)).toBe(false);
    expect(forceArrange(request())).toEqual(run);
  });
});

describe("layout de forças: place", () => {
  test("dado um nó novo ligado a um assentado, então só ele recebe posição, perto do vizinho e sem encostar", () => {
    const doc = docOf(node("a", 0, 0), node("b", 1000, 0), node("c", 0, 1000));
    const run = forcePlace({ doc, entering: [entering("x")], neighbors: links(["a", "x"]) });
    expect(run.placements.map((p) => p.id)).toEqual(["x"]);
    const [x] = run.placements;
    expect(distance(x, { id: "a", x: 0, y: 0 })).toBeLessThan(distance(x, { id: "b", x: 1000, y: 0 }));
    expect(doc.nodes.some((n) => x !== undefined && touches(boxOf(x), n, LAYOUT_GAP))).toBe(false);
  });

  test("dados vários nós novos num mesmo vizinho, então nenhum encosta em outro nem no documento", () => {
    const doc = docOf(...grid(5));
    const ids = ["p", "q", "r", "s", "t", "u", "v", "w"];
    const run = forcePlace({ doc, entering: ids.map(entering), neighbors: links(...ids.map((id): [string, string] => ["n2", id])) });
    expect(run.placements).toHaveLength(ids.length);
    const placed = run.placements.map(boxOf);
    expect(anyTouch(placed, LAYOUT_GAP)).toBe(false);
    expect(placed.some((box) => doc.nodes.some((n) => touches(box, n, LAYOUT_GAP)))).toBe(false);
  });

  test("dada a mesma chegada em outra ordem, então as mesmas posições", () => {
    const doc = docOf(...grid(5));
    const ids = ["p", "q", "r", "s"];
    const neighbors = links(["n0", "p"], ["p", "q"], ["n4", "r"], ["r", "s"]);
    const a = forcePlace({ doc, entering: ids.map(entering), neighbors });
    const b = forcePlace({ doc: docOf(...reversed(grid(5))), entering: reversed(ids).map(entering), neighbors });
    expect(b).toEqual(a);
  });

  test("dado um nó novo fixado, então ele fica no lugar que o layout livre daria", () => {
    const request = { doc: docOf(node("a", 0, 0)), entering: [entering("x")], neighbors: links(["a", "x"]) };
    const run = forcePlace(request, { pinned: new Set(["x"]) });
    expect(run.placements).toEqual(FREE_LAYOUT.place(request));
    expect(run.steps).toBe(0);
  });

  test("dado nada entrando, então nenhuma posição e nenhum passo", () => {
    expect(forcePlace({ doc: docOf(node("a", 0, 0)), entering: [], neighbors: new Map() })).toEqual({ placements: [], steps: 0, settled: true, energy: 0 });
  });
});

describe("layout de forças: reaquecer local", () => {
  // n0 - n1 - n2 - n3 - n4 - n5 (cadeia), e n9 solto
  const doc = () => docOf(...grid(6), node("n9", 3000, 3000));
  const neighbors = links(...chain(6));

  test("dado um nó arrastado, então só a vizinhança até `hops` mexe; ele e o resto ficam", () => {
    const run = forceReheat({ doc: doc(), neighbors, from: "n2", hops: 1 });
    expect(run.placements.map((p) => p.id)).toEqual(["n1", "n3"]);
  });

  test("dado o padrão de hops, então vai a duas arestas", () => {
    expect(forceReheat({ doc: doc(), neighbors, from: "n2" }).placements.map((p) => p.id)).toEqual(["n0", "n1", "n3", "n4"]);
  });

  test("dado um vizinho travado ou com pin, então ele não está entre quem mexeu", () => {
    const nodes = doc().nodes.map((n) => (n.id === "n1" ? { ...n, locked: true } : n));
    const run = forceReheat({ doc: docOf(...nodes), neighbors, from: "n2" }, { pinned: new Set(["n4"]) });
    expect(run.placements.map((p) => p.id)).toEqual(["n0", "n3"]);
  });

  test("dado hops 0, então ninguém mexe", () => {
    expect(forceReheat({ doc: doc(), neighbors, from: "n2", hops: 0 })).toEqual({ placements: [], steps: 0, settled: true, energy: 0 });
  });

  test("dado um nó que não está no documento, então falha com force_invalid_input", () => {
    expect(errorCode(() => forceReheat({ doc: doc(), neighbors, from: "nada" }))).toBe(FORCE_ERRORS.invalidInput);
  });

  test("dado hops acima do teto, então falha com force_invalid_param", () => {
    expect(errorCode(() => forceReheat({ doc: doc(), neighbors, from: "n2", hops: FORCE_LIMITS.hops + 1 }))).toBe(FORCE_ERRORS.invalidParam);
  });
});

describe("layout de forças: em passos (fatias por quadro)", () => {
  const request = () => ({ doc: docOf(...grid(10)), neighbors: links(...chain(10)) });

  test("dado arrange avançado em fatias, então chega exatamente ao mesmo resultado que de uma vez", () => {
    const whole = forceArrange(request());
    const simulation = startArrange(request());
    let progress = simulation.step(7);
    while (!progress.done) progress = simulation.step(7);
    expect({ placements: simulation.placements(), steps: progress.steps, settled: progress.settled, energy: progress.energy }).toEqual(whole);
  });

  test("dada uma fatia, então avança só até ela e diz que não acabou; as posições já andaram", () => {
    const simulation = startArrange(request());
    const before = simulation.placements();
    const progress = simulation.step(3);
    expect(progress).toMatchObject({ steps: 3, done: false, settled: false });
    expect(simulation.placements()).not.toEqual(before);
  });

  test("dado o fim, então novo passo não faz nada", () => {
    const simulation = startArrange(request());
    const end = simulation.step(FORCE_LIMITS.steps);
    expect(end.done).toBe(true);
    expect(simulation.step(5)).toEqual(end);
  });

  test("dado o teto de passos, então acaba nele mesmo sem assentar", () => {
    const simulation = startArrange(request(), { params: { maxSteps: 4 } });
    simulation.step(3);
    expect(simulation.step(3)).toMatchObject({ steps: 4, done: true, settled: false });
  });

  test("dado reaquecer em fatias, então o mesmo resultado que de uma vez", () => {
    const reheat = { ...request(), from: "n4" };
    const whole = forceReheat(reheat);
    const simulation = startReheat(reheat);
    let progress = simulation.step(5);
    while (!progress.done) progress = simulation.step(5);
    expect(simulation.placements()).toEqual(whole.placements);
    expect(progress.steps).toBe(whole.steps);
  });

  test.each([0, -1, 1.5, FORCE_LIMITS.steps + 1])("dada fatia de %p passos, então falha com force_invalid_param", (n) => {
    expect(errorCode(() => startArrange(request()).step(n))).toBe(FORCE_ERRORS.invalidParam);
  });
});

describe("layout de forças: entrada limitada e erros", () => {
  test("dado um nó a mais que o teto, então falha com force_too_many_nodes antes de simular", () => {
    const nodes = Array.from({ length: FORCE_LIMITS.nodes + 1 }, (_, i) => node(`n${i}`, i * 300, 0));
    expect(errorCode(() => forceArrange({ doc: docOf(...nodes), neighbors: new Map() }))).toBe(FORCE_ERRORS.tooManyNodes);
    const full = docOf(...nodes.slice(0, FORCE_LIMITS.nodes));
    expect(errorCode(() => forcePlace({ doc: full, entering: [entering("x")], neighbors: new Map() }))).toBe(FORCE_ERRORS.tooManyNodes);
  });

  test("dados mais pares ligados que o teto, então falha com force_too_many_springs", () => {
    const ids = Array.from({ length: 150 }, (_, i) => `n${i}`);
    const pairs: [string, string][] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i] as string, ids[j] as string]);
    expect(pairs.length).toBeGreaterThan(FORCE_LIMITS.springs);
    const doc = docOf(...ids.map((id, i) => node(id, i * 300, 0)));
    expect(errorCode(() => forceArrange({ doc, neighbors: links(...pairs) }))).toBe(FORCE_ERRORS.tooManySprings);
  });

  test("dado maxSteps acima do teto, então falha com force_too_many_steps", () => {
    expect(errorCode(() => resolveForceParams({ maxSteps: FORCE_LIMITS.steps + 1 }))).toBe(FORCE_ERRORS.tooManySteps);
    expect(resolveForceParams({ maxSteps: FORCE_LIMITS.steps }).maxSteps).toBe(FORCE_LIMITS.steps);
  });

  test.each([
    ["maxSteps", 0],
    ["maxSteps", 1.5],
    ["damping", 1],
    ["cooling", -0.1],
    ["theta", Number.NaN],
    ["energyThreshold", 0],
    ["repulsion", Number.POSITIVE_INFINITY],
    ["seed", -1],
  ])("dado %s = %p, então falha com force_invalid_param e diz qual", (key, value) => {
    let caught: unknown;
    try {
      resolveForceParams({ [key]: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForceError);
    expect((caught as ForceError).code).toBe(FORCE_ERRORS.invalidParam);
    expect((caught as ForceError).subject).toBe(key);
  });

  test("dado um parâmetro desconhecido (inclusive nome herdado de objeto), então falha com force_invalid_param", () => {
    expect(errorCode(() => resolveForceParams(JSON.parse('{"gravidade": 1}')))).toBe(FORCE_ERRORS.invalidParam);
    expect(errorCode(() => resolveForceParams(JSON.parse('{"constructor": 1}')))).toBe(FORCE_ERRORS.invalidParam);
  });

  test("dado um nó com posição inválida ou id repetido, então falha com force_invalid_input", () => {
    expect(errorCode(() => forceArrange({ doc: docOf(node("a", Number.NaN, 0)), neighbors: new Map() }))).toBe(FORCE_ERRORS.invalidInput);
    expect(errorCode(() => forceArrange({ doc: docOf(node("a", 0, 0), node("a", 500, 0)), neighbors: new Map() }))).toBe(FORCE_ERRORS.invalidInput);
    expect(errorCode(() => forcePlace({ doc: docOf(node("a", 0, 0)), entering: [entering("a")], neighbors: new Map() }))).toBe(FORCE_ERRORS.invalidInput);
    expect(errorCode(() => forcePlace({ doc: emptyCanvasDoc(), entering: [entering("x"), entering("x")], neighbors: new Map() }))).toBe(FORCE_ERRORS.invalidInput);
  });

  test("dado um nó empurrado para fora da faixa do documento, então falha com force_diverged em vez de truncar", () => {
    const edge = CANVAS_LIMITS.coordinate;
    const doc = docOf(node("wall", edge - 150, 0, { locked: true }), node("a", edge - 50, 0));
    expect(errorCode(() => forceArrange({ doc, neighbors: new Map() }))).toBe(FORCE_ERRORS.diverged);
  });
});

describe("layout de forças: a interface CanvasLayout", () => {
  test("dado o registro de layouts, então o de forças entra com id force, place e arrange", () => {
    const registry = createLayoutRegistry();
    registry.register(FORCE_LAYOUT);
    expect(registry.get(FORCE_LAYOUT_ID)).toBe(FORCE_LAYOUT);
    expect(typeof FORCE_LAYOUT.arrange).toBe("function");
  });

  test("dado place pela interface, então é o mesmo que forcePlace, só as posições", () => {
    const request = { doc: docOf(node("a", 0, 0)), entering: [entering("x"), entering("y")], neighbors: links(["a", "x"], ["x", "y"]) };
    expect(FORCE_LAYOUT.place(request)).toEqual(forcePlace(request).placements);
  });

  test("dados parâmetros inválidos, então createForceLayout falha na criação, não no primeiro uso", () => {
    expect(errorCode(() => createForceLayout({ params: { damping: 2 } }))).toBe(FORCE_ERRORS.invalidParam);
  });

  test("dados pins na criação, então arrange os respeita", () => {
    const layout = createForceLayout({ pinned: new Set(["n0"]) });
    const placements = layout.arrange?.({ doc: docOf(...grid(5)), neighbors: links(...chain(5)) }) ?? [];
    expect(byPlacement(placements).get("n0")).toEqual({ id: "n0", x: 0, y: 0 });
  });
});

describe("layout de forças: escala", () => {
  test("dados 300 nós com ~1,5 aresta por nó, então assenta, sem posição inválida", () => {
    const nodes = Array.from({ length: 300 }, (_, i) => node(`n${String(i).padStart(3, "0")}`, (i % 20) * 220, Math.floor(i / 20) * 90));
    const pairs: [string, string][] = [];
    let s = 17;
    const next = (): number => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) % 300;
    for (let i = 1; i < 300; i++) pairs.push([nodes[i]?.id ?? "", nodes[next() % i]?.id ?? ""]);
    for (let k = 0; k < 150; k++) pairs.push([nodes[next()]?.id ?? "", nodes[next()]?.id ?? ""]);
    const run = forceArrange({ doc: docOf(...nodes), neighbors: links(...pairs) });
    expect(run.settled).toBe(true);
    expect(run.placements).toHaveLength(300);
    for (const p of run.placements) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});
