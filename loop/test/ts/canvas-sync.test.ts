// Sincronia ao vivo (src/lib/canvas-sync.ts): nó novo perto do vizinho sem sobrepor, nó sumido sai, posição do dono vence,
// nada que já assentou se move, determinismo.
import { describe, expect, test } from "bun:test";
import { CANVAS_LIMITS, emptyCanvasDoc, validateCanvasDoc, type CanvasDoc, type CanvasNode } from "../../../src/lib/canvas-doc.ts";
import { FREE_LAYOUT, LAYOUT_GAP, type CanvasLayout } from "../../../src/lib/canvas-layout.ts";
import { SYNC_ERRORS, SyncError, syncWithGraph, type GraphSnapshot } from "../../../src/lib/canvas-sync.ts";

const SIZE = { w: 200, h: 66 };
const options = { layout: FREE_LAYOUT, sizeOf: () => ({ ...SIZE }) };
const placed = (id: string, x: number, y: number, over: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, type: id.split(":")[0] as string, x, y, ...SIZE, z: 0, data: {}, locked: false, blurred: false, ...over });
const docOf = (nodes: CanvasNode[], extra: Partial<CanvasDoc> = {}): CanvasDoc => ({ ...emptyCanvasDoc(), rev: 4, nodes, ...extra });
const graph = (nodes: string[], edges: [string, string][] = []): GraphSnapshot => ({
  nodes: nodes.map((id) => ({ id, type: id.split(":")[0] as string })),
  edges: edges.map(([from, to]) => ({ from, to })),
});
type Box = { x: number; y: number; w: number; h: number };
const boxOf = (n: CanvasNode): Box => ({ x: n.x, y: n.y, w: n.w, h: n.h });
const overlap = (a: Box, b: Box, gap = 0): boolean => a.x - gap < b.x + b.w && b.x < a.x + a.w + gap && a.y - gap < b.y + b.h && b.y < a.y + a.h + gap;
const byId = (doc: CanvasDoc, id: string): CanvasNode => doc.nodes.find((n) => n.id === id) as CanvasNode;

describe("sincronia: nó novo", () => {
  test("dado nó novo com aresta para um nó do documento, então entra perto dele, sem sobrepor ninguém", () => {
    const doc = docOf([placed("agent:p:a", 500, 300), placed("pr:p:1", 900, 300), placed("unit:p:u", 100, 100)]);
    const result = syncWithGraph(doc, graph(["agent:p:a", "pr:p:1", "unit:p:u", "gate:7"], [["agent:p:a", "gate:7"]]), options);
    expect(result.added).toEqual(["gate:7"]);
    const fresh = byId(result.doc, "gate:7");
    const near = byId(result.doc, "agent:p:a");
    expect(Math.hypot(fresh.x - near.x, fresh.y - near.y)).toBeLessThanOrEqual(2 * (SIZE.w + LAYOUT_GAP));
    for (const other of result.doc.nodes) if (other.id !== fresh.id) expect(overlap(boxOf(fresh), boxOf(other), LAYOUT_GAP)).toBe(false);
  });

  test("dado muitos nós novos com o mesmo vizinho, então nenhum sobrepõe outro", () => {
    const doc = docOf([placed("agent:p:hub", 0, 0)]);
    const ids = Array.from({ length: 12 }, (_, i) => `pr:p:${i}`);
    const result = syncWithGraph(doc, graph(["agent:p:hub", ...ids], ids.map((id): [string, string] => ["agent:p:hub", id])), options);
    expect(result.added).toHaveLength(12);
    const all = result.doc.nodes;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(boxOf(all[i] as CanvasNode), boxOf(all[j] as CanvasNode), LAYOUT_GAP)).toBe(false);
  });

  test("dado o nó novo, então tem o tamanho do tipo, data vazia, camada acima das existentes e não travado", () => {
    const doc = docOf([placed("agent:p:a", 0, 0, { z: 7 })]);
    const result = syncWithGraph(doc, graph(["agent:p:a", "pr:p:1"]), { layout: FREE_LAYOUT, sizeOf: () => ({ w: 123, h: 45 }) });
    expect(byId(result.doc, "pr:p:1")).toMatchObject({ type: "pr", w: 123, h: 45, z: 8, data: {}, locked: false, blurred: false });
  });

  test("dado o resultado, então é um documento válido e a revisão não muda (é do servidor)", () => {
    const doc = docOf([placed("agent:p:a", 0, 0)]);
    const result = syncWithGraph(doc, graph(["agent:p:a", "pr:p:1", "gate:2"]), options);
    expect(validateCanvasDoc(result.doc)).toEqual(result.doc);
    expect(result.doc.rev).toBe(4);
  });

  test("dado documento vazio e grafo com nós, então todos entram sem sobrepor", () => {
    const result = syncWithGraph(emptyCanvasDoc(), graph(["unit:p:u", "agent:p:a", "pr:p:1", "gate:2"], [["unit:p:u", "agent:p:a"], ["agent:p:a", "pr:p:1"]]), options);
    expect(result.doc.nodes).toHaveLength(4);
    const all = result.doc.nodes;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(boxOf(all[i] as CanvasNode), boxOf(all[j] as CanvasNode), LAYOUT_GAP)).toBe(false);
  });
});

describe("sincronia: nó que sumiu", () => {
  test("dado nó vivo fora do grafo novo, então sai do documento com a aresta e o membro de grupo (grupo vazio some)", () => {
    const doc = docOf([placed("agent:p:a", 0, 0), placed("agent:p:b", 300, 0), placed("note1", 0, 200, { type: "note" })], {
      edges: [{ id: "e1", from: "agent:p:a", to: "note1", kind: "link" }, { id: "e2", from: "agent:p:b", to: "note1", kind: "link" }],
      groups: [{ id: "g1", label: "x", members: ["agent:p:a"] }, { id: "g2", label: "y", members: ["agent:p:a", "agent:p:b"] }],
    });
    const result = syncWithGraph(doc, graph(["agent:p:b"]), options);
    expect(result.removed).toEqual(["agent:p:a"]);
    expect(result.doc.nodes.map((n) => n.id)).toEqual(["agent:p:b", "note1"]);
    expect(result.doc.edges.map((e) => e.id)).toEqual(["e2"]);
    expect(result.doc.groups).toEqual([{ id: "g2", label: "y", members: ["agent:p:b"] }]);
    expect(result.changed).toBe(true);
  });

  test("dado nó do usuário (nota) que o grafo não conhece, então nunca é removido nem movido", () => {
    const note = placed("note1", 40, 50, { type: "note", data: { text: "oi" }, locked: true });
    const result = syncWithGraph(docOf([note]), graph([]), options);
    expect(result.removed).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.doc.nodes).toEqual([note]);
  });
});

describe("sincronia: o que já assentou não se move", () => {
  test("dado nós com posição do dono, quando chegam nós novos e outros somem, então cada nó restante fica igual, campo a campo", () => {
    const owned = [
      placed("agent:p:a", 12_345, -999, { z: 3, blurred: true }),
      placed("agent:p:b", 0, 0, { locked: true }),
      placed("pr:p:1", 777, 888),
      placed("note1", 5, 5, { type: "note", data: { text: "x" } }),
    ];
    const doc = docOf(owned);
    const result = syncWithGraph(doc, graph(["agent:p:a", "agent:p:b", "gate:9", "unit:p:new"], [["agent:p:a", "gate:9"], ["agent:p:b", "unit:p:new"]]), options);
    for (const id of ["agent:p:a", "agent:p:b", "note1"]) expect(byId(result.doc, id)).toEqual(byId(doc, id));
    expect(result.doc.nodes.map((n) => n.id)).not.toContain("pr:p:1");
  });

  test("dado o documento de entrada, então não é alterado (imutável)", () => {
    const doc = docOf([placed("agent:p:a", 0, 0), placed("pr:p:gone", 400, 0)], { groups: [{ id: "g", label: "g", members: ["pr:p:gone", "agent:p:a"] }] });
    const before = JSON.stringify(doc);
    syncWithGraph(doc, graph(["agent:p:a", "gate:1"], [["agent:p:a", "gate:1"]]), options);
    expect(JSON.stringify(doc)).toBe(before);
  });

  test("dado grafo igual ao documento, então nada muda e devolve o mesmo objeto", () => {
    const doc = docOf([placed("agent:p:a", 0, 0)]);
    const result = syncWithGraph(doc, graph(["agent:p:a"]), options);
    expect(result.changed).toBe(false);
    expect(result.doc).toBe(doc);
    expect(result).toMatchObject({ added: [], removed: [], skipped: [] });
  });

  test("dado a sincronia repetida com o mesmo grafo, então a segunda vez não muda nada (idempotente)", () => {
    const doc = docOf([placed("agent:p:a", 0, 0)]);
    const g = graph(["agent:p:a", "pr:p:1", "gate:2"], [["agent:p:a", "pr:p:1"]]);
    const first = syncWithGraph(doc, g, options);
    const second = syncWithGraph(first.doc, g, options);
    expect(second.changed).toBe(false);
    expect(second.doc).toBe(first.doc);
  });

  test("dado nó que sai e volta ao grafo, então volta como novo (a posição antiga não é lembrada) sem mexer nos outros", () => {
    const doc = docOf([placed("agent:p:a", 0, 0), placed("pr:p:1", 400, 0)]);
    const out = syncWithGraph(doc, graph(["agent:p:a"]), options);
    const back = syncWithGraph(out.doc, graph(["agent:p:a", "pr:p:1"], [["agent:p:a", "pr:p:1"]]), options);
    expect(back.added).toEqual(["pr:p:1"]);
    expect(byId(back.doc, "agent:p:a")).toEqual(byId(doc, "agent:p:a"));
  });
});

describe("sincronia: determinismo e limites", () => {
  test("dado o mesmo grafo em ordens diferentes de nós e arestas, então o mesmo documento", () => {
    const doc = docOf([placed("agent:p:a", 0, 0), placed("agent:p:b", 600, 400)]);
    const ids = ["pr:p:1", "pr:p:2", "gate:3", "unit:p:4"];
    const edges: [string, string][] = [["agent:p:a", "pr:p:1"], ["agent:p:b", "pr:p:2"], ["agent:p:a", "gate:3"], ["pr:p:1", "unit:p:4"]];
    const one = syncWithGraph(doc, graph(["agent:p:a", "agent:p:b", ...ids], edges), options);
    const two = syncWithGraph(doc, graph([...ids].reverse().concat(["agent:p:b", "agent:p:a"]), [...edges].reverse().map(([a, b]): [string, string] => [b, a])), options);
    expect(two.doc).toEqual(one.doc);
    expect(syncWithGraph(doc, graph(["agent:p:a", "agent:p:b", ...ids], edges), options)).toEqual(one);
  });

  test("dado grafo com nó de tipo desconhecido ou id repetido, então ignora o desconhecido e entra uma vez só", () => {
    const g: GraphSnapshot = { nodes: [{ id: "pr:p:1", type: "pr" }, { id: "pr:p:1", type: "pr" }, { id: "weird:1", type: "weird" }], edges: [] };
    const result = syncWithGraph(emptyCanvasDoc(), g, options);
    expect(result.doc.nodes.map((n) => n.id)).toEqual(["pr:p:1"]);
  });

  test("dado aresta para nó que não existe em lugar nenhum ou para si mesmo, então é ignorada sem falhar", () => {
    const result = syncWithGraph(docOf([placed("agent:p:a", 0, 0)]), graph(["agent:p:a", "pr:p:1"], [["pr:p:1", "pr:p:1"], ["pr:p:1", "agent:p:fantasma"]]), options);
    expect(result.added).toEqual(["pr:p:1"]);
  });

  test("dado documento no teto de nós, então o nó novo fica em skipped e nenhum nó do dono sai", () => {
    const full = Array.from({ length: CANVAS_LIMITS.nodes }, (_, i) => placed(`note${i}`, (i % 50) * 300, Math.floor(i / 50) * 100, { type: "note" }));
    const doc = docOf(full);
    const result = syncWithGraph(doc, graph(["pr:p:1"]), options);
    expect(result.skipped).toEqual(["pr:p:1"]);
    expect(result.doc.nodes).toHaveLength(CANVAS_LIMITS.nodes);
    expect(result.changed).toBe(false);
  });

  test("dado muitos nós novos de uma vez, então termina e não sobrepõe (custo limitado)", () => {
    const ids = Array.from({ length: 300 }, (_, i) => `pr:p:${String(i).padStart(3, "0")}`);
    const edges = ids.map((id): [string, string] => ["agent:p:hub", id]);
    const result = syncWithGraph(docOf([placed("agent:p:hub", 0, 0)]), graph(["agent:p:hub", ...ids], edges), options);
    expect(result.added).toHaveLength(300);
    const boxes = result.doc.nodes.map(boxOf);
    const clash = boxes.some((a, i) => boxes.some((b, j) => j > i && overlap(a, b)));
    expect(clash).toBe(false);
  });
});

describe("sincronia: layout que descumpre o contrato", () => {
  const sync = (layout: CanvasLayout) => syncWithGraph(emptyCanvasDoc(), graph(["pr:p:1", "pr:p:2"]), { layout, sizeOf: options.sizeOf });
  const codeOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      if (error instanceof SyncError) return error.code;
      throw error;
    }
    throw new Error("não lançou");
  };

  test("dado layout que esquece um nó, ou devolve nó de fora, ou repete, então sync_invalid_layout", () => {
    expect(codeOf(() => sync({ id: "x", label: "x", place: () => [{ id: "pr:p:1", x: 0, y: 0 }] }))).toBe(SYNC_ERRORS.invalidLayout);
    expect(codeOf(() => sync({ id: "x", label: "x", place: () => [{ id: "pr:p:1", x: 0, y: 0 }, { id: "pr:p:3", x: 0, y: 0 }] }))).toBe(SYNC_ERRORS.invalidLayout);
    expect(codeOf(() => sync({ id: "x", label: "x", place: () => [{ id: "pr:p:1", x: 0, y: 0 }, { id: "pr:p:1", x: 9, y: 9 }] }))).toBe(SYNC_ERRORS.invalidLayout);
  });

  test("dado layout que devolve posição fora da faixa ou NaN, então falha alto (nada de documento inválido)", () => {
    const bad = (x: number): CanvasLayout => ({ id: "x", label: "x", place: ({ entering }) => entering.map((n) => ({ id: n.id, x, y: 0 })) });
    expect(() => sync(bad(CANVAS_LIMITS.coordinate + 1))).toThrow();
    expect(() => sync(bad(Number.NaN))).toThrow();
  });
});

describe("sincronia: agente alocado por um orquestrador do canvas", () => {
  const PAR = { session: "default", pane: "w1:p1" };
  const orq = placed("term-orq", 1000, 400, { type: "terminal", w: 400, h: 240, data: { herdr: PAR } });
  const withOrq = (ids: string[], by: Record<string, unknown> = PAR): GraphSnapshot => ({
    nodes: ids.map((id) => ({ id, type: id.split(":")[0] as string, orchestrator: by })),
    edges: [],
  });
  test("dado o agente novo com o pane do terminal, então entra na fileira abaixo dele, centrado", () => {
    const result = syncWithGraph(docOf([orq]), withOrq(["agent:p:a"]), options);
    const fresh = byId(result.doc, "agent:p:a");
    expect(fresh.y).toBeGreaterThan(orq.y + orq.h);
    expect(fresh.x + fresh.w / 2).toBe(orq.x + orq.w / 2);
  });
  test("dado um agente dele já no documento, então o novo vai ao lado e o antigo não se move", () => {
    const first = syncWithGraph(docOf([orq]), withOrq(["agent:p:a"]), options).doc;
    const before = byId(first, "agent:p:a");
    const result = syncWithGraph(first, withOrq(["agent:p:a", "agent:p:b"]), options);
    expect(byId(result.doc, "agent:p:a")).toEqual(before);
    const fresh = byId(result.doc, "agent:p:b");
    expect(fresh.y).toBe(before.y);
    expect(overlap(boxOf(fresh), boxOf(before))).toBe(false);
  });
  test("dado pane que nenhum terminal tem, então o layout comum decide (sem erro)", () => {
    const result = syncWithGraph(docOf([orq]), withOrq(["agent:p:a"], { session: "default", pane: "w9:p9" }), options);
    expect(result.added).toEqual(["agent:p:a"]);
    expect(overlap(boxOf(byId(result.doc, "agent:p:a")), boxOf(orq), LAYOUT_GAP)).toBe(false);
  });
});
