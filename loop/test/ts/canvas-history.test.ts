// Grupo canvas-history: desfazer e refazer do canvas (src/lib/canvas-history.ts) — cada operação e o inverso exato,
// lote, limite da pilha, refazer limpo depois de operação nova e imutabilidade. Lógica pura.
import { describe, expect, test } from "bun:test";
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNode, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import {
  type AtomicOp,
  applyOp,
  canRedo,
  canUndo,
  createHistory,
  HISTORY_ERRORS,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  type History,
  invert,
  opBatch,
  opCreate,
  opDelete,
  opEdgeCreate,
  opEdgeDelete,
  opEdgesCreate,
  opEdgesDelete,
  opGroup,
  opHide,
  opLink,
  opMove,
  opMoveMany,
  opPatch,
  opResize,
  opUngroup,
  opUnhide,
  opUnhideAll,
  opUnlink,
  opUpdate,
  perform,
  record,
  redo,
  undo,
} from "../../../src/lib/canvas-history";

const node = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: "note", x: 0, y: 0, w: 100, h: 60, z: 0, data: { id }, locked: false, blurred: false, ...over });

const doc = (): CanvasDoc =>
  validateCanvasDoc({
    v: 1,
    rev: 5,
    nodes: [node("a", { x: 10, y: 20 }), node("b", { x: 200 }), node("c"), node("agent:p:x", { type: "agent", data: {} })],
    edges: [
      { id: "e1", from: "a", to: "b", kind: "link" },
      { id: "e2", from: "b", to: "c", kind: "link" },
      { id: "e3", from: "c", to: "agent:p:x", kind: "link" },
    ],
    groups: [
      { id: "g1", label: "um", members: ["a", "b", "c"] },
      { id: "g2", label: "dois", members: ["b"] },
    ],
  });

/** O nó da posição `at`; falha o teste se não existe (em vez de espalhar `undefined`). */
const nodeIn = (d: CanvasDoc, at: number): CanvasNode => d.nodes[at] ?? ((): never => { throw new Error(`sem nó na posição ${at}`); })();

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "sem-código";
  }
  return "não lançou";
};

/** Aplica, confere o resultado e que o inverso devolve o documento original, igual até na ordem das listas. */
function roundTrip(op: AtomicOp, original = doc()): CanvasDoc {
  const frozen = structuredClone(original);
  const after = applyOp(original, op);
  expect(original).toEqual(frozen);
  expect(applyOp(after, invert(op))).toEqual(frozen);
  expect(validateCanvasDoc(after)).toEqual(after);
  return after;
}

describe("canvas-history: operações e inversos", () => {
  test("move: muda x e y; o inverso volta", () => {
    const d = doc();
    const after = roundTrip(opMove(d, "a", { x: -5, y: 7.5 }));
    expect(after.nodes.find((n) => n.id === "a")).toMatchObject({ x: -5, y: 7.5, w: 100 });
  });

  test("resize: muda posição e tamanho juntos (puxar a quina de cima); o inverso volta", () => {
    const d = doc();
    const after = roundTrip(opResize(d, "b", { x: 190, y: -10, w: 250, h: 90 }));
    expect(after.nodes.find((n) => n.id === "b")).toMatchObject({ x: 190, y: -10, w: 250, h: 90 });
  });

  test("create: insere nó e aresta nova; o inverso (delete) tira os dois", () => {
    const d = doc();
    const op = opCreate(d, [node("n", { x: 1 })], [{ id: "e9", from: "n", to: "a", kind: "link" }]);
    const after = roundTrip(op);
    expect(after.nodes.at(-1)?.id).toBe("n");
    expect(after.edges.at(-1)?.id).toBe("e9");
    expect(invert(op).kind).toBe("delete");
  });

  test("delete: tira nó, arestas que o tocam e o membro dos grupos; grupo que ficou vazio some; o inverso restaura tudo no lugar", () => {
    const d = doc();
    const after = roundTrip(opDelete(d, ["b"]));
    expect(after.nodes.map((n) => n.id)).toEqual(["a", "c", "agent:p:x"]);
    expect(after.edges.map((e) => e.id)).toEqual(["e3"]);
    expect(after.groups).toEqual([{ id: "g1", label: "um", members: ["a", "c"] }]);
  });

  test("delete de vários nós, inclusive o último de um grupo e um nó vivo: o inverso restaura grupos e ordem", () => {
    const after = roundTrip(opDelete(doc(), ["c", "a", "agent:p:x"]));
    expect(after.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(after.groups).toEqual([{ id: "g1", label: "um", members: ["b"] }, { id: "g2", label: "dois", members: ["b"] }]);
  });

  test("group: acrescenta o grupo; o inverso (ungroup) o tira", () => {
    const d = doc();
    const after = roundTrip(opGroup(d, "g3", "novo", ["a", "c"]));
    expect(after.groups.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    expect(after.nodes).toEqual(d.nodes);
  });

  test("ungroup: tira o grupo do meio e o inverso o devolve ao mesmo índice", () => {
    const after = roundTrip(opUngroup(doc(), "g1"));
    expect(after.groups.map((g) => g.id)).toEqual(["g2"]);
    expect(after.nodes).toHaveLength(4);
  });

  test("o inverso do inverso é a operação original", () => {
    const d = doc();
    for (const op of [opMove(d, "a", { x: 1, y: 1 }), opDelete(d, ["a"]), opGroup(d, "g3", "", ["a"]), opUngroup(d, "g2")]) {
      expect(invert(invert(op))).toEqual(op);
    }
  });
});

describe("canvas-history: lote", () => {
  test("arrastar vários nós é um lote só; o inverso desfaz todos de uma vez", () => {
    const d = doc();
    const op = opMoveMany(d, ["a", "b", "c"], 15, -4);
    expect(op.kind).toBe("batch");
    const after = applyOp(d, op);
    expect(after.nodes.slice(0, 3).map((n) => [n.x, n.y])).toEqual([[25, 16], [215, -4], [15, -4]]);
    expect(applyOp(after, invert(op))).toEqual(d);
  });

  test("com um único id, o 'lote' é o move simples", () => {
    expect(opMoveMany(doc(), ["a"], 1, 1).kind).toBe("move");
  });

  test("o inverso do lote desfaz os passos em ordem reversa (mover e depois apagar o mesmo nó)", () => {
    const d = doc();
    const move = opMove(d, "a", { x: 99, y: 99 });
    const mid = applyOp(d, move);
    const batch = opBatch([move, opDelete(mid, ["a"])]);
    expect(applyOp(applyOp(d, batch), invert(batch))).toEqual(d);
  });

  test("lote com passo que falha é tudo ou nada: lança e o documento de entrada fica como estava", () => {
    const d = doc();
    const batch = opBatch([opMove(d, "a", { x: 1, y: 1 }), { kind: "move", id: "fantasma", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }]);
    const frozen = structuredClone(d);
    expect(code(() => applyOp(d, batch))).toBe(HISTORY_ERRORS.missingTarget);
    expect(d).toEqual(frozen);
  });

  test("lote vazio é recusado na construção e na aplicação", () => {
    expect(code(() => opBatch([]))).toBe(HISTORY_ERRORS.emptyBatch);
    expect(code(() => applyOp(doc(), { kind: "batch", ops: [] }))).toBe(HISTORY_ERRORS.emptyBatch);
  });

  test("no passo da pilha, o lote desfaz e refaz como um só", () => {
    const d = doc();
    const first = perform(createHistory(), d, opMoveMany(d, ["a", "b"], 5, 5));
    expect(first.history.past).toHaveLength(1);
    const back = undo(first.history, first.doc);
    expect(back?.doc).toEqual(d);
    expect(redo(back!.history, back!.doc)?.doc).toEqual(first.doc);
  });
});

describe("canvas-history: precondições (falha alto, nunca segue como se estivesse certo)", () => {
  const d = doc();
  const cases: [string, () => unknown, string][] = [
    ["mover nó que não existe", () => applyOp(d, { kind: "move", id: "zz", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }), HISTORY_ERRORS.missingTarget],
    ["construir move de nó que não existe", () => opMove(d, "zz", { x: 0, y: 0 }), HISTORY_ERRORS.missingTarget],
    ["mover para NaN", () => applyOp(d, opMove(d, "a", { x: Number.NaN, y: 0 })), HISTORY_ERRORS.invalidOp],
    ["mover para fora do intervalo", () => applyOp(d, opMove(d, "a", { x: CANVAS_LIMITS.coordinate + 1, y: 0 })), HISTORY_ERRORS.invalidOp],
    ["redimensionar para largura zero", () => applyOp(d, opResize(d, "a", { x: 0, y: 0, w: 0, h: 10 })), HISTORY_ERRORS.invalidOp],
    ["apagar nó que não existe", () => opDelete(d, ["zz"]), HISTORY_ERRORS.missingTarget],
    ["apagar sem ids", () => opDelete(d, []), HISTORY_ERRORS.invalidOp],
    ["criar sem nada", () => opCreate(d, []), HISTORY_ERRORS.invalidOp],
    ["criar nó com id que já existe", () => applyOp(d, opCreate(d, [node("a")])), HISTORY_ERRORS.duplicateTarget],
    ["criar aresta para nó que não existe", () => applyOp(d, opCreate(d, [], [{ id: "e9", from: "a", to: "zz", kind: "k" }])), HISTORY_ERRORS.danglingReference],
    ["criar aresta com id que já existe", () => applyOp(d, opCreate(d, [], [{ id: "e1", from: "a", to: "b", kind: "k" }])), HISTORY_ERRORS.duplicateTarget],
    ["agrupar com id que já existe", () => applyOp(d, opGroup(d, "g1", "", ["a"])), HISTORY_ERRORS.duplicateTarget],
    ["agrupar membro que não existe", () => applyOp(d, opGroup(d, "g3", "", ["zz"])), HISTORY_ERRORS.danglingReference],
    ["agrupar sem membros", () => applyOp(d, opGroup(d, "g3", "", [])), HISTORY_ERRORS.danglingReference],
    ["agrupar membro repetido", () => applyOp(d, opGroup(d, "g3", "", ["a", "a"])), HISTORY_ERRORS.danglingReference],
    ["desagrupar grupo que não existe", () => opUngroup(d, "gz"), HISTORY_ERRORS.missingTarget],
    ["desagrupar duas vezes", () => applyOp(applyOp(d, opUngroup(d, "g1")), opUngroup(d, "g1")), HISTORY_ERRORS.missingTarget],
    ["operação de tipo desconhecido", () => applyOp(d, { kind: "teleport" } as unknown as AtomicOp), HISTORY_ERRORS.invalidOp],
  ];
  test.each(cases)("dado %s, então o código é o estável", (_, fn, expected) => {
    expect(code(fn)).toBe(expected);
  });

  test("criar acima do limite de nós é limit_exceeded", () => {
    const full = validateCanvasDoc({ v: 1, rev: 0, nodes: Array.from({ length: CANVAS_LIMITS.nodes }, (_, i) => node(`n${i}`)), edges: [], groups: [] });
    expect(code(() => applyOp(full, opCreate(full, [node("extra")])))).toBe(HISTORY_ERRORS.limitExceeded);
  });

  test("criar acima do limite de grupos é limit_exceeded", () => {
    const groups = Array.from({ length: CANVAS_LIMITS.groups }, (_, i) => ({ id: `g${i}`, label: "", members: ["a"] }));
    const full = validateCanvasDoc({ v: 1, rev: 0, nodes: [node("a")], edges: [], groups });
    expect(code(() => applyOp(full, opGroup(full, "extra", "", ["a"])))).toBe(HISTORY_ERRORS.limitExceeded);
  });

  test("lote acima do teto é limit_exceeded", () => {
    const one = opMove(d, "a", { x: 0, y: 0 });
    expect(code(() => opBatch(Array.from({ length: 5001 }, () => one)))).toBe(HISTORY_ERRORS.limitExceeded);
  });
});

describe("canvas-history: pilha", () => {
  const moveTo = (history: History, d: CanvasDoc, x: number) => perform(history, d, opMove(d, "a", { x, y: 0 }));

  test("a pilha nasce vazia e desfazer/refazer sem passo devolvem undefined", () => {
    const h = createHistory();
    expect([h.limit, canUndo(h), canRedo(h)]).toEqual([HISTORY_LIMIT_DEFAULT, false, false]);
    expect(undo(h, doc())).toBeUndefined();
    expect(redo(h, doc())).toBeUndefined();
  });

  test("limite da pilha: ao passar dele o passo mais antigo cai, e o desfazer só volta até onde ela guarda", () => {
    let d = doc();
    let h = createHistory(3);
    for (const x of [1, 2, 3, 4, 5]) ({ doc: d, history: h } = moveTo(h, d, x));
    expect(h.past).toHaveLength(3);
    let steps = 0;
    for (let step = undo(h, d); step; step = undo(step.history, step.doc)) {
      d = step.doc;
      h = step.history;
      steps++;
    }
    expect(steps).toBe(3);
    expect(d.nodes.find((n) => n.id === "a")?.x).toBe(2); // os passos 1 e 2 caíram: volta ao estado depois do 2
    expect(canUndo(h)).toBe(false);
  });

  test("no limite exato (um passo) a pilha guarda só o último", () => {
    let d = doc();
    let h = createHistory(1);
    ({ doc: d, history: h } = moveTo(h, d, 1));
    ({ doc: d, history: h } = moveTo(h, d, 2));
    expect(h.past).toHaveLength(1);
    expect(undo(h, d)?.doc.nodes[0]?.x).toBe(1);
  });

  test("operação nova depois de desfazer limpa o refazer", () => {
    let d = doc();
    let h = createHistory();
    ({ doc: d, history: h } = moveTo(h, d, 1));
    ({ doc: d, history: h } = moveTo(h, d, 2));
    const back = undo(h, d)!;
    expect(canRedo(back.history)).toBe(true);
    const fresh = perform(back.history, back.doc, opMove(back.doc, "b", { x: 7, y: 7 }));
    expect(canRedo(fresh.history)).toBe(false);
    expect(redo(fresh.history, fresh.doc)).toBeUndefined();
    expect(fresh.history.past).toHaveLength(2);
  });

  test("desfazer tudo e refazer tudo reproduz o documento de cada etapa", () => {
    const states: CanvasDoc[] = [doc()];
    let h = createHistory();
    let d = states[0] as CanvasDoc;
    const ops = [(x: CanvasDoc) => opMove(x, "a", { x: 50, y: 50 }), (x: CanvasDoc) => opDelete(x, ["b"]), (x: CanvasDoc) => opGroup(x, "g9", "n", ["a", "c"]), (x: CanvasDoc) => opMoveMany(x, ["a", "c"], 3, 3)];
    for (const make of ops) {
      ({ doc: d, history: h } = perform(h, d, make(d)));
      states.push(d);
    }
    for (let i = states.length - 2; i >= 0; i--) {
      const step = undo(h, d)!;
      ({ doc: d, history: h } = step);
      expect(d).toEqual(states[i] as CanvasDoc);
    }
    for (let i = 1; i < states.length; i++) {
      const step = redo(h, d)!;
      ({ doc: d, history: h } = step);
      expect(d).toEqual(states[i] as CanvasDoc);
    }
    expect(canRedo(h)).toBe(false);
  });

  test("record registra o passo que o chamador já aplicou e limpa o refazer", () => {
    const d = doc();
    const op = opMove(d, "a", { x: 9, y: 9 });
    const moved = applyOp(d, op);
    const h = record(createHistory(), op);
    expect(undo(h, moved)?.doc).toEqual(d);
    const withFuture = undo(h, moved)!.history;
    expect(canRedo(withFuture)).toBe(true);
    expect(canRedo(record(withFuture, op))).toBe(false);
  });

  test("falha ao aplicar deixa a pilha como estava", () => {
    const d = doc();
    const h = createHistory();
    expect(code(() => perform(h, d, { kind: "move", id: "zz", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }))).toBe(HISTORY_ERRORS.missingTarget);
    expect(h.past).toHaveLength(0);
    const stale = perform(h, d, opMove(d, "a", { x: 1, y: 1 }));
    const wrongDoc = applyOp(stale.doc, opDelete(stale.doc, ["a"]));
    expect(code(() => undo(stale.history, wrongDoc))).toBe(HISTORY_ERRORS.missingTarget);
    expect(stale.history.past).toHaveLength(1);
  });

  test("as funções da pilha não alteram a pilha de entrada", () => {
    const d = doc();
    const h0 = createHistory(5);
    const h1 = perform(h0, d, opMove(d, "a", { x: 1, y: 1 })).history;
    const snapshot = structuredClone(h1);
    undo(h1, applyOp(d, opMove(d, "a", { x: 1, y: 1 })));
    expect(h1).toEqual(snapshot);
    expect(h0.past).toHaveLength(0);
  });

  test("limite fora do intervalo é recusado", () => {
    for (const limit of [0, -1, 1.5, HISTORY_LIMIT_MAX + 1, Number.NaN]) expect(code(() => createHistory(limit))).toBe(HISTORY_ERRORS.invalidOp);
    expect(createHistory(HISTORY_LIMIT_MAX).limit).toBe(HISTORY_LIMIT_MAX);
  });
});

describe("canvas-history: update (troca do data)", () => {
  test("troca o data inteiro; o inverso devolve o anterior e o nó segue no mesmo lugar", () => {
    const d = doc();
    const after = roundTrip(opUpdate(d, "a", { url: "http://x/", nested: { n: [1, 2] } }));
    expect(after.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "agent:p:x"]);
    expect(after.nodes[0]).toMatchObject({ x: 10, y: 20, data: { url: "http://x/", nested: { n: [1, 2] } } });
  });

  test("guarda cópia: mudar o objeto passado depois não muda a operação", () => {
    const d = doc();
    const data = { k: { v: 1 } };
    const op = opUpdate(d, "a", data);
    data.k.v = 2;
    expect(applyOp(d, op).nodes[0]?.data).toEqual({ k: { v: 1 } });
  });

  test("limites: data vazio vale; nó que não existe, valor que não é JSON, profundidade demais e nó vivo com conteúdo são recusados", () => {
    const d = doc();
    expect(roundTrip(opUpdate(d, "a", {})).nodes[0]?.data).toEqual({});
    expect(code(() => opUpdate(d, "zz", {}))).toBe(HISTORY_ERRORS.missingTarget);
    expect(code(() => opUpdate(d, "a", { f: undefined }))).toBe(HISTORY_ERRORS.invalidOp);
    expect(code(() => opUpdate(d, "a", { n: Number.NaN }))).toBe(HISTORY_ERRORS.invalidOp);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < CANVAS_LIMITS.dataDepth + 1; i++) deep = { d: deep };
    expect(code(() => opUpdate(d, "a", deep))).toBe(HISTORY_ERRORS.invalidOp);
    expect(code(() => opUpdate(d, "agent:p:x", { qualquer: 1 }))).toBe(HISTORY_ERRORS.invalidOp);
  });

  test("aplicar update escrito à mão com data inválido ou alvo ausente lança sem mudar o documento", () => {
    const d = doc();
    const frozen = structuredClone(d);
    expect(code(() => applyOp(d, { kind: "update", id: "zz", from: {}, to: {} }))).toBe(HISTORY_ERRORS.missingTarget);
    expect(code(() => applyOp(d, { kind: "update", id: "a", from: {}, to: { n: Number.POSITIVE_INFINITY } }))).toBe(HISTORY_ERRORS.invalidOp);
    expect(d).toEqual(frozen);
  });
});

describe("canvas-history: edge-create e edge-delete (aresta solta)", () => {
  test("criar põe a aresta no fim sem nó junto; o inverso a tira", () => {
    const d = doc();
    const after = roundTrip(opEdgeCreate(d, { id: "e9", from: "a", to: "c", kind: "manual" }));
    expect(after.edges.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e9"]);
    expect(after.nodes).toEqual(d.nodes);
    expect(invert(opEdgeCreate(d, { id: "e9", from: "a", to: "c", kind: "manual" })).kind).toBe("edge-delete");
  });

  test("remover tira só a aresta e o inverso a devolve ao mesmo índice", () => {
    const d = doc();
    const after = roundTrip(opEdgeDelete(d, "e2"));
    expect(after.edges.map((e) => e.id)).toEqual(["e1", "e3"]);
    expect(after.nodes).toEqual(d.nodes);
    expect(after.groups).toEqual(d.groups);
  });

  test("refazer repete e o inverso do inverso é a operação original", () => {
    const d = doc();
    const op = opEdgeDelete(d, "e1");
    const first = perform(createHistory(), d, op);
    const back = undo(first.history, first.doc)!;
    expect(back.doc).toEqual(d);
    expect(redo(back.history, back.doc)?.doc).toEqual(first.doc);
    expect(invert(invert(op))).toEqual(op);
  });

  test.each([
    ["criar com id em uso", () => opEdgeCreate(doc(), { id: "e1", from: "a", to: "b", kind: "k" }), HISTORY_ERRORS.duplicateTarget],
    ["criar para nó que não existe", () => opEdgeCreate(doc(), { id: "e9", from: "a", to: "zz", kind: "k" }), HISTORY_ERRORS.danglingReference],
    ["criar com id fora do formato", () => opEdgeCreate(doc(), { id: "com espaço", from: "a", to: "b", kind: "k" }), HISTORY_ERRORS.invalidOp],
    ["criar com kind fora do formato", () => opEdgeCreate(doc(), { id: "e9", from: "a", to: "b", kind: "Maiúscula" }), HISTORY_ERRORS.invalidOp],
    ["remover aresta que não existe", () => opEdgeDelete(doc(), "zz"), HISTORY_ERRORS.missingTarget],
    ["aplicar remoção que já saiu", () => applyOp(applyOp(doc(), opEdgeDelete(doc(), "e1")), opEdgeDelete(doc(), "e1")), HISTORY_ERRORS.missingTarget],
  ])("dado %s, então o código é o estável", (_, fn, expected) => {
    expect(code(fn)).toBe(expected);
  });

  test("no teto de arestas, criar é limit_exceeded", () => {
    const edges = Array.from({ length: CANVAS_LIMITS.edges }, (_, i) => ({ id: `x${i}`, from: "a", to: "b", kind: "k" }));
    const full = validateCanvasDoc({ ...doc(), edges });
    expect(code(() => opEdgeCreate(full, { id: "extra", from: "a", to: "b", kind: "k" }))).toBe(HISTORY_ERRORS.limitExceeded);
  });

  test("em lote: várias criações e várias remoções voltam exatamente, inclusive as do meio da lista", () => {
    const d = doc();
    const created = opEdgesCreate(d, [
      { id: "n1", from: "a", to: "c", kind: "k" },
      { id: "n2", from: "c", to: "a", kind: "k" },
    ]);
    expect(created.kind).toBe("batch");
    const withNew = applyOp(d, created);
    expect(withNew.edges.map((e) => e.id)).toEqual(["e1", "e2", "e3", "n1", "n2"]);
    expect(applyOp(withNew, invert(created))).toEqual(d);
    const removed = opEdgesDelete(withNew, ["e2", "n1", "e3"]);
    const after = applyOp(withNew, removed);
    expect(after.edges.map((e) => e.id)).toEqual(["e1", "n2"]);
    expect(applyOp(after, invert(removed))).toEqual(withNew);
  });

  test("lote de uma aresta só vira o passo simples; vazio e repetido na mesma lista são recusados", () => {
    expect(opEdgesCreate(doc(), [{ id: "e9", from: "a", to: "b", kind: "k" }]).kind).toBe("edge-create");
    expect(opEdgesDelete(doc(), ["e1", "e1"]).kind).toBe("edge-delete");
    expect(code(() => opEdgesCreate(doc(), []))).toBe(HISTORY_ERRORS.invalidOp);
    expect(code(() => opEdgesDelete(doc(), []))).toBe(HISTORY_ERRORS.invalidOp);
    expect(code(() => opEdgesCreate(doc(), [{ id: "e9", from: "a", to: "b", kind: "k" }, { id: "e9", from: "b", to: "a", kind: "k" }]))).toBe(HISTORY_ERRORS.duplicateTarget);
  });
});

describe("canvas-history: patch (campos do nó no lugar)", () => {
  test("troca só as chaves pedidas e o inverso devolve o valor anterior", () => {
    const d = doc();
    const after = roundTrip(opPatch(d, "b", { z: 7, blurred: true }));
    expect(after.nodes[1]).toEqual({ ...nodeIn(d, 1), z: 7, blurred: true });
    expect(after.nodes[1]?.locked).toBe(false);
    expect(opPatch(d, "b", { locked: true })).toMatchObject({ from: { locked: false }, to: { locked: true } });
  });

  test("o nó não é recriado: arestas e grupos que o tocam seguem como estavam", () => {
    const d = doc();
    const after = applyOp(d, opPatch(d, "b", { locked: true }));
    expect(after.edges).toEqual(d.edges);
    expect(after.groups).toEqual(d.groups);
  });

  test.each([
    ["patch vazio", () => opPatch(doc(), "a", {}), HISTORY_ERRORS.invalidOp],
    ["nó que não existe", () => opPatch(doc(), "zz", { z: 1 }), HISTORY_ERRORS.missingTarget],
    ["campo que não se troca por patch", () => opPatch(doc(), "a", { x: 5 } as never), HISTORY_ERRORS.invalidOp],
    ["camada fracionária", () => opPatch(doc(), "a", { z: 1.5 }), HISTORY_ERRORS.invalidOp],
    ["camada acima do teto", () => opPatch(doc(), "a", { z: CANVAS_LIMITS.layer + 1 }), HISTORY_ERRORS.invalidOp],
    ["locked que não é booleano", () => opPatch(doc(), "a", { locked: "sim" } as never), HISTORY_ERRORS.invalidOp],
    ["aplicar patch escrito à mão com camada NaN", () => applyOp(doc(), { kind: "patch", id: "a", from: {}, to: { z: Number.NaN } }), HISTORY_ERRORS.invalidOp],
  ])("dado %s, então o código é o estável", (_, fn, expected) => {
    expect(code(fn)).toBe(expected);
  });
});

describe("canvas-history: link e unlink (membro do grupo)", () => {
  test("unlink tira o nó da lista sem apagá-lo; o inverso o devolve ao mesmo índice", () => {
    const d = doc();
    const after = roundTrip(opUnlink(d, "g1", "b"));
    expect(after.groups[0]?.members).toEqual(["a", "c"]);
    expect(after.nodes).toEqual(d.nodes);
    expect(after.edges).toEqual(d.edges);
  });

  test("link põe no fim e o inverso tira", () => {
    const d = doc();
    const after = roundTrip(opLink(d, "g2", "c"));
    expect(after.groups[1]?.members).toEqual(["b", "c"]);
    expect(invert(opLink(d, "g2", "c")).kind).toBe("unlink");
  });

  test("o último membro não sai por unlink (grupo vazio não existe)", () => {
    expect(code(() => opUnlink(doc(), "g2", "b"))).toBe(HISTORY_ERRORS.invalidOp);
    expect(code(() => applyOp(doc(), { kind: "unlink", groupId: "g2", member: { at: 0, item: "b" } }))).toBe(HISTORY_ERRORS.invalidOp);
  });

  test.each([
    ["unlink de grupo que não existe", () => opUnlink(doc(), "gz", "a"), HISTORY_ERRORS.missingTarget],
    ["unlink de quem não é membro", () => opUnlink(doc(), "g2", "a"), HISTORY_ERRORS.missingTarget],
    ["link de grupo que não existe", () => opLink(doc(), "gz", "a"), HISTORY_ERRORS.missingTarget],
    ["link de nó que não existe", () => opLink(doc(), "g1", "zz"), HISTORY_ERRORS.danglingReference],
    ["link de quem já é membro", () => opLink(doc(), "g1", "a"), HISTORY_ERRORS.duplicateTarget],
  ])("dado %s, então o código é o estável", (_, fn, expected) => {
    expect(code(fn)).toBe(expected);
  });

  test("no teto de membros, link é limit_exceeded", () => {
    const nodes = Array.from({ length: CANVAS_LIMITS.groupMembers + 1 }, (_, i) => node(`m${i}`));
    const members = nodes.slice(0, CANVAS_LIMITS.groupMembers).map((n) => n.id);
    const big = { ...doc(), nodes: [...doc().nodes, ...nodes], groups: [{ id: "g", label: "", members }] };
    expect(code(() => opLink(big, "g", `m${CANVAS_LIMITS.groupMembers}`))).toBe(HISTORY_ERRORS.limitExceeded);
  });
});

describe("canvas-history: lote com os tipos novos e ida e volta pela pilha", () => {
  test("lote misto (update, patch, edge-create, unlink) desfaz e refaz como um passo", () => {
    const d = doc();
    const batch = opBatch([
      opUpdate(d, "a", { t: 1 }),
      opPatch(d, "b", { z: 3 }),
      opEdgeCreate(d, { id: "e9", from: "a", to: "c", kind: "manual" }),
      opUnlink(d, "g1", "b"),
    ]);
    const first = perform(createHistory(), d, batch);
    expect(first.doc.nodes[0]?.data).toEqual({ t: 1 });
    expect(first.doc.nodes[1]?.z).toBe(3);
    expect(first.doc.edges.at(-1)?.id).toBe("e9");
    expect(first.doc.groups[0]?.members).toEqual(["a", "c"]);
    expect(first.history.past).toHaveLength(1);
    const back = undo(first.history, first.doc)!;
    expect(back.doc).toEqual(d);
    expect(redo(back.history, back.doc)?.doc).toEqual(first.doc);
  });

  test("lote com um passo novo que falha é tudo ou nada", () => {
    const d = doc();
    const batch = opBatch([opPatch(d, "a", { z: 2 }), { kind: "edge-delete", edge: { at: 0, item: { id: "fantasma", from: "a", to: "b", kind: "k" } } }]);
    const frozen = structuredClone(d);
    expect(code(() => applyOp(d, batch))).toBe(HISTORY_ERRORS.missingTarget);
    expect(d).toEqual(frozen);
  });

  test("apagar um nó depois de ligar uma aresta solta nele: desfazer tudo volta exato", () => {
    const d = doc();
    const link = opEdgeCreate(d, { id: "e9", from: "a", to: "c", kind: "manual" });
    const mid = applyOp(d, link);
    const batch = opBatch([link, opDelete(mid, ["a"])]);
    expect(applyOp(applyOp(d, batch), invert(batch))).toEqual(d);
  });

  test("a pilha respeita o limite também com os tipos novos", () => {
    let history = createHistory(2);
    let current = doc();
    for (const z of [1, 2, 3]) ({ doc: current, history } = perform(history, current, opPatch(current, "a", { z })));
    expect(history.past).toHaveLength(2);
    expect(current.nodes[0]?.z).toBe(3);
  });
});

describe("canvas-history: ocultar e reexibir", () => {
  const hidden = (d: CanvasDoc): readonly string[] => d.hidden ?? [];

  test("dado ocultar em lote, então os ids entram na ordem dada e desfazer volta exatamente ao anterior", () => {
    const op = opHide(doc(), ["c", "a", "agent:p:x"]) as AtomicOp;
    const out = roundTrip(op);
    expect(hidden(out)).toEqual(["c", "a", "agent:p:x"]);
    expect(out.nodes).toEqual(doc().nodes);
    expect(out.edges).toEqual(doc().edges);
  });
  test("dado id repetido ou já oculto, então é ignorado; nada a mudar dá undefined", () => {
    const once = applyOp(doc(), opHide(doc(), ["a"]) as AtomicOp);
    expect(opHide(once, ["a", "a"])).toBeUndefined();
    expect(opHide(once, ["b", "a", "b"])).toEqual({ kind: "hide", ids: [{ at: 1, item: "b" }] });
    expect(opHide(doc(), [])).toBeUndefined();
  });
  test("dado id que o documento não tem, então ocultar é recusado", () => {
    expect(code(() => opHide(doc(), ["zz"]))).toBe(HISTORY_ERRORS.missingTarget);
  });
  test("dado reexibir um do meio, então os outros ficam no lugar e desfazer devolve ao índice", () => {
    const start = applyOp(doc(), opHide(doc(), ["a", "b", "c"]) as AtomicOp);
    const op = opUnhide(start, ["b"]) as AtomicOp;
    expect(hidden(roundTrip(op, start))).toEqual(["a", "c"]);
  });
  test("reexibir todos esvazia a lista e tira o campo; sem ocultos dá undefined", () => {
    const start = applyOp(doc(), opHide(doc(), ["a", "b"]) as AtomicOp);
    const out = roundTrip(opUnhideAll(start) as AtomicOp, start);
    expect("hidden" in out).toBe(false);
    expect(opUnhideAll(doc())).toBeUndefined();
    expect(opUnhide(start, ["c"])).toBeUndefined();
  });
  test("ocultar e reexibir são inversos um do outro", () => {
    const op = opHide(doc(), ["a"]) as AtomicOp;
    expect(invert(op)).toEqual({ kind: "unhide", ids: [{ at: 0, item: "a" }] });
    expect(invert(invert(op))).toEqual(op);
  });
  test("dado excluir nó oculto, então ele sai da lista e desfazer o devolve oculto no mesmo índice", () => {
    const start = applyOp(doc(), opHide(doc(), ["a", "b", "c"]) as AtomicOp);
    const op = opDelete(start, ["b"]);
    const out = roundTrip(op, start);
    expect(hidden(out)).toEqual(["a", "c"]);
  });
  test("ocultar é um passo do desfazer: perform + undo + redo", () => {
    let history: History = createHistory();
    let current = doc();
    ({ doc: current, history } = perform(history, current, opHide(current, ["a", "c"]) as AtomicOp));
    expect(hidden(current)).toEqual(["a", "c"]);
    ({ doc: current, history } = undo(history, current) ?? { doc: current, history });
    expect("hidden" in current).toBe(false);
    ({ doc: current, history } = redo(history, current) ?? { doc: current, history });
    expect(hidden(current)).toEqual(["a", "c"]);
  });
});
