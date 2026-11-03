// Grupo canvas-blur: desfocar nós (src/lib/canvas-blur.ts) — seleção, o que continua visível, troca de nó pela pilha de
// desfazer com ida e volta exata. Lógica pura.
import { describe, expect, test } from "bun:test";
import { type CanvasDoc, type CanvasNode, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, createHistory, perform, redo, undo } from "../../../src/lib/canvas-history";
import { blurNodes, blurredNodeIds, blurView, nodeTitle, replaceNodes, toggleBlur, visibleNodeIds } from "../../../src/lib/canvas-blur";
import { ORG_ERRORS, OrgError } from "../../../src/lib/canvas-groups";

const node = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: "note", x: 0, y: 0, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false, ...over });
const doc = (): CanvasDoc =>
  validateCanvasDoc({
    v: 1,
    rev: 1,
    nodes: [node("a", { data: { title: " Título " } }), node("b", { locked: true }), node("c", { blurred: true }), node("d")],
    edges: [
      { id: "e1", from: "a", to: "b", kind: "link" },
      { id: "e2", from: "b", to: "c", kind: "link" },
      { id: "e3", from: "c", to: "d", kind: "link" },
    ],
    groups: [{ id: "g1", label: "g", members: ["a", "b"] }, { id: "g2", label: "h", members: ["c", "d"] }],
  });
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof OrgError ? error.code : "outro-erro";
  }
  return "não lançou";
};

describe("blurNodes", () => {
  test("dado nós visíveis, quando desfoca, então só o campo blurred muda e o resto do documento fica igual", () => {
    const before = doc();
    const op = blurNodes(before, ["a", "b"]);
    const after = applyOp(before, op!);
    expect(after.nodes.map((n) => n.blurred)).toEqual([true, true, true, false]);
    expect(after.nodes.map((n) => ({ ...n, blurred: false }))).toEqual(before.nodes.map((n) => ({ ...n, blurred: false })));
    expect(after.edges).toEqual(before.edges);
    expect(after.groups).toEqual(before.groups);
    expect(validateCanvasDoc(after)).toEqual(after);
  });
  test("dado desfazer e refazer, então volta exatamente ao anterior e ao posterior", () => {
    const before = doc();
    const done = perform(createHistory(), before, blurNodes(before, ["a", "b", "d"])!);
    const back = undo(done.history, done.doc)!;
    expect(back.doc).toEqual(before);
    expect(redo(back.history, back.doc)!.doc).toEqual(done.doc);
  });
  test("dado nós já no estado pedido, então devolve undefined", () => {
    expect(blurNodes(doc(), ["c"])).toBeUndefined();
    expect(blurNodes(doc(), ["a"], false)).toBeUndefined();
    expect(blurNodes(doc(), [])).toBeUndefined();
  });
  test("dado ids repetidos, então o nó entra uma vez", () => {
    const after = applyOp(doc(), blurNodes(doc(), ["a", "a"])!);
    expect(blurredNodeIds(after)).toEqual(["a", "c"]);
  });
  test("dado revelar, então desfoca de volta e a ida e volta é exata", () => {
    const before = doc();
    const op = blurNodes(before, ["c"], false)!;
    expect(applyOp(before, op).nodes[2]?.blurred).toBe(false);
    const done = perform(createHistory(), before, op);
    expect(undo(done.history, done.doc)!.doc).toEqual(before);
  });
  test("dado id inexistente ou lista acima do teto, então erro de código estável", () => {
    expect(code(() => blurNodes(doc(), ["zz"]))).toBe(ORG_ERRORS.unknownNode);
    expect(code(() => blurNodes(doc(), Array.from({ length: 2001 }, (_, i) => `n${i}`)))).toBe(ORG_ERRORS.limitExceeded);
  });
});

describe("blurNodes: a operação é patch do campo blurred", () => {
  test("dado um nó, então a operação é um patch só do campo blurred, com o valor de antes em from", () => {
    expect(blurNodes(doc(), ["a"])).toEqual({ kind: "patch", id: "a", from: { blurred: false }, to: { blurred: true } });
    expect(blurNodes(doc(), ["c"], false)).toEqual({ kind: "patch", id: "c", from: { blurred: true }, to: { blurred: false } });
  });
  test("dado vários nós, então um lote de patches na ordem do documento, sem os que já estão no estado pedido", () => {
    const op = blurNodes(doc(), ["d", "a", "c"])!;
    expect(op).toEqual({
      kind: "batch",
      ops: [
        { kind: "patch", id: "d", from: { blurred: false }, to: { blurred: true } },
        { kind: "patch", id: "a", from: { blurred: false }, to: { blurred: true } },
      ],
    });
  });
  test("dado nó travado, em grupo e com conexões, então desfazer e refazer voltam exatamente ao documento de antes e de depois", () => {
    const before = doc();
    const first = perform(createHistory(), before, blurNodes(before, ["a", "b", "d"])!);
    expect(first.doc.edges).toEqual(before.edges);
    expect(first.doc.groups).toEqual(before.groups);
    expect(first.doc.nodes.map((n) => n.blurred)).toEqual([true, true, true, true]);
    const back = undo(first.history, first.doc)!;
    expect(back.doc).toEqual(before);
    expect(redo(back.history, back.doc)!.doc).toEqual(first.doc);
    // revelar depois de desfocar também volta exato
    const reveal = perform(first.history, first.doc, blurNodes(first.doc, ["a", "b", "c", "d"], false)!);
    expect(undo(reveal.history, reveal.doc)!.doc).toEqual(first.doc);
  });
  test("dado toggleBlur, então a operação também é patch e a ida e volta é exata", () => {
    const before = doc();
    const op = toggleBlur(before, ["a", "b"])!;
    expect(op.kind).toBe("batch");
    const done = perform(createHistory(), before, op);
    expect(undo(done.history, done.doc)!.doc).toEqual(before);
  });
});

describe("toggleBlur e visibilidade", () => {
  test("dado seleção mista, então desfoca todos; com todos desfocados, revela", () => {
    const first = applyOp(doc(), toggleBlur(doc(), ["a", "c"])!);
    expect(blurredNodeIds(first)).toEqual(["a", "c"]);
    const second = applyOp(first, toggleBlur(first, ["a", "c"])!);
    expect(blurredNodeIds(second)).toEqual([]);
  });
  test("dado o documento, então visibleNodeIds lista só os não desfocados e respeita o recorte", () => {
    expect(visibleNodeIds(doc())).toEqual(["a", "b", "d"]);
    expect(visibleNodeIds(doc(), ["a", "c"])).toEqual(["a"]);
  });
  test("dado nó desfocado, então cabeçalho e nome ficam e o corpo some", () => {
    expect(blurView(doc().nodes[2]!)).toEqual({ blurred: true, showHeader: true, showName: true, showBody: false, title: "c" });
    expect(blurView(doc().nodes[0]!).title).toBe("Título");
    expect(nodeTitle(node("x", { data: { title: "  ", name: "nome" } }))).toBe("nome");
  });
});

describe("replaceNodes", () => {
  test("dado nó em grupo e com conexões, então grupos e conexões voltam nas mesmas posições", () => {
    const before = doc();
    const op = replaceNodes(before, ["b", "c"], { change: (n) => ({ ...n, z: 7 }) })!;
    const after = applyOp(before, op);
    expect(after.nodes.map((n) => n.z)).toEqual([0, 7, 7, 0]);
    expect(after.edges).toEqual(before.edges);
    expect(after.groups).toEqual(before.groups);
    expect(validateCanvasDoc(after)).toEqual(after);
  });
  test("dado keepEdge, então a conexão descartada some e o desfazer a devolve", () => {
    const before = doc();
    const history = createHistory();
    const done = perform(history, before, replaceNodes(before, ["b"], { keepEdge: (e) => e.id !== "e1" })!);
    expect(done.doc.edges.map((e) => e.id)).toEqual(["e2", "e3"]);
    expect(undo(done.history, done.doc)!.doc).toEqual(before);
  });
  test("dado nada a mudar, então undefined", () => {
    expect(replaceNodes(doc(), ["a"], {})).toBeUndefined();
  });
});
