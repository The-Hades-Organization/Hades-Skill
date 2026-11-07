// Grupo canvas-areas: áreas do canvas (src/lib/canvas-areas.ts) — criar/validar, encaixar e retirar, arrastar, desfazer num
// passo só, apagar, colar e documento antigo. Lógica pura.
import { describe, expect, test } from "bun:test";
import { type CanvasDoc, type CanvasNode, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, createHistory, perform, redo, undo } from "../../../src/lib/canvas-history";
import {
  AREA_ERRORS, AREA_LIMITS, AREA_Z, AreaError, areaAtPoint, areaIndex, areaLook, areaMembers, areaReport, checkAreas, createAreaNode, dockNodes,
  dropOps, nodesCenteredIn, readAreaData, recolorArea, renameArea, settleMove, undockNodes, withAreaMembers,
} from "../../../src/lib/canvas-areas";
import { copyNodes, deleteNodes, pasteClip, sequentialIds } from "../../../src/lib/canvas-clipboard";
import { opMoveMany } from "../../../src/lib/canvas-history";

const node = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: "note", x: 0, y: 0, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false, ...over });
const area = (id: string, over: Partial<CanvasNode> = {}, data: Record<string, unknown> = { title: "A", color: "chart-1" }): CanvasNode =>
  node(id, { type: "area", x: 0, y: 0, w: 500, h: 400, z: AREA_Z, data, ...over });
const docOf = (...nodes: CanvasNode[]): CanvasDoc => validateCanvasDoc({ v: 1, rev: 0, nodes, edges: [], groups: [] });
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof AreaError ? error.code : "outro-erro";
  }
  return "não lançou";
};
const membersOf = (doc: CanvasDoc, id: string): string[] => areaMembers(doc, id).map((n) => n.id);
const at = (doc: CanvasDoc, id: string): CanvasNode => doc.nodes.find((n) => n.id === id) as CanvasNode;

describe("canvas-areas: formato e criação", () => {
  test("documento sem área segue válido e o relatório é vazio", () => {
    const doc = docOf(node("a"));
    expect(areaReport(doc)).toEqual([]);
    expect(() => checkAreas(doc)).not.toThrow();
  });

  test("readAreaData recusa campo desconhecido, cor fora da paleta, título vazio e membro repetido", () => {
    expect(code(() => readAreaData({ title: "x", color: "chart-1", extra: 1 }))).toBe(AREA_ERRORS.invalidData);
    expect(code(() => readAreaData({ title: "x", color: "red" }))).toBe(AREA_ERRORS.invalidColor);
    expect(code(() => readAreaData({ title: "  ", color: "chart-2" }))).toBe(AREA_ERRORS.invalidTitle);
    expect(code(() => readAreaData({ title: "x", color: "chart-2", members: ["a", "a"] }))).toBe(AREA_ERRORS.invalidData);
    expect(readAreaData({ title: " ok ", color: "chart-3" })).toEqual({ title: "ok", color: "chart-3", members: [] });
  });

  test("createAreaNode põe a área atrás de tudo, com título e cor padrão, num passo só", () => {
    const doc = docOf(node("a"));
    const { op, node: made } = createAreaNode(doc, { id: "ar1", x: 0, y: 0 });
    expect(made.z).toBe(AREA_Z);
    expect(made.w).toBe(AREA_LIMITS.width);
    const next = applyOp(doc, op);
    expect(areaReport(next)).toEqual([{ id: "ar1", title: "Área 1", color: "chart-1", members: [] }]);
    const done = perform(createHistory(), doc, op);
    expect(undo(done.history, done.doc)!.doc.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  test("createAreaNode recusa id repetido, id inválido, moldura fora do intervalo, cor e membro desconhecido ou área", () => {
    const doc = docOf(node("a"), area("ar"));
    expect(code(() => createAreaNode(doc, { id: "a", x: 0, y: 0 }))).toBe(AREA_ERRORS.duplicateId);
    expect(code(() => createAreaNode(doc, { id: "x y", x: 0, y: 0 }))).toBe(AREA_ERRORS.invalidId);
    expect(code(() => createAreaNode(doc, { id: "n", x: 0, y: 0, w: 10 }))).toBe(AREA_ERRORS.invalidFrame);
    expect(code(() => createAreaNode(doc, { id: "n", x: 0, y: 0, color: "chart-9" as never }))).toBe(AREA_ERRORS.invalidColor);
    expect(code(() => createAreaNode(doc, { id: "n", x: 0, y: 0, members: ["zz"] }))).toBe(AREA_ERRORS.unknownNode);
    expect(code(() => createAreaNode(doc, { id: "n", x: 0, y: 0, members: ["ar"] }))).toBe(AREA_ERRORS.nested);
  });

  test("criar com members tira o nó da outra área", () => {
    const doc = docOf(area("ar", {}, { title: "A", color: "chart-1", members: ["a"] }), node("a", { x: 10, y: 50 }));
    const { op } = createAreaNode(doc, { id: "ar2", x: 600, y: 0, members: ["a"] });
    const next = applyOp(doc, op);
    expect(membersOf(next, "ar")).toEqual([]);
    expect(membersOf(next, "ar2")).toEqual(["a"]);
    expect(() => checkAreas(next)).not.toThrow();
  });

  test("renomear e recolorir: igual ao de agora não faz nada; inválido lança", () => {
    const doc = docOf(area("ar"));
    expect(renameArea(doc, "ar", "A")).toBeUndefined();
    expect(recolorArea(doc, "ar", "chart-1")).toBeUndefined();
    expect(at(applyOp(doc, renameArea(doc, "ar", "Novo")!), "ar").data.title).toBe("Novo");
    expect(at(applyOp(doc, recolorArea(doc, "ar", "chart-4")!), "ar").data.color).toBe("chart-4");
    expect(code(() => renameArea(doc, "ar", ""))).toBe(AREA_ERRORS.invalidTitle);
    expect(code(() => recolorArea(doc, "ar", "azul"))).toBe(AREA_ERRORS.invalidColor);
    expect(code(() => renameArea(doc, "nada", "x"))).toBe(AREA_ERRORS.unknownArea);
  });

  test("areaLook não quebra com data fora do formato", () => {
    expect(areaLook({ data: { title: 3, color: "rosa" } })).toEqual({ title: "", color: undefined });
    expect(areaLook({ data: { title: "T", color: "chart-2" } })).toEqual({ title: "T", color: "chart-2" });
  });

  test("checkAreas acusa nó em duas áreas e área dentro de área", () => {
    const two = docOf(area("p", {}, { title: "p", color: "chart-1", members: ["a"] }), area("q", {}, { title: "q", color: "chart-2", members: ["a"] }), node("a"));
    expect(code(() => checkAreas(two))).toBe(AREA_ERRORS.duplicateMember);
    const nested = docOf(area("p", {}, { title: "p", color: "chart-1", members: ["q"] }), area("q"));
    expect(code(() => checkAreas(nested))).toBe(AREA_ERRORS.nested);
  });
});

describe("canvas-areas: encaixe e retirada", () => {
  const base = () => docOf(area("ar", { x: 0, y: 0, w: 500, h: 400 }), node("in", { x: 50, y: 80 }), node("out", { x: 900, y: 900 }), node("lock", { x: 900, y: 0, locked: true }));

  test("dockNodes: quem está fora entra por baixo do título; quem está dentro fica; travado entra sem andar", () => {
    const doc = applyOp(base(), dockNodes(base(), ["in", "out", "lock"], "ar")!);
    expect(membersOf(doc, "ar")).toEqual(["in", "out", "lock"]);
    expect(at(doc, "in").x).toBe(50);
    expect(at(doc, "out").x).toBeLessThan(500);
    expect(at(doc, "out").y).toBeGreaterThan(0);
    expect(at(doc, "lock").x).toBe(900);
  });

  test("dockNodes numa área tira o nó da outra; de novo na mesma não muda nada", () => {
    const start = docOf(area("p", {}, { title: "p", color: "chart-1", members: ["a"] }), area("q", { x: 800 }), node("a", { x: 10, y: 50 }));
    const next = applyOp(start, dockNodes(start, ["a"], "q")!);
    expect(membersOf(next, "p")).toEqual([]);
    expect(membersOf(next, "q")).toEqual(["a"]);
    expect(dockNodes(next, ["a"], "q")).toBeUndefined();
  });

  test("dockNodes: erros de área, nó e aninhamento", () => {
    const doc = base();
    expect(code(() => dockNodes(doc, ["in"], "nada"))).toBe(AREA_ERRORS.unknownArea);
    expect(code(() => dockNodes(doc, ["zz"], "ar"))).toBe(AREA_ERRORS.unknownNode);
    expect(code(() => dockNodes(doc, ["ar"], "ar"))).toBe(AREA_ERRORS.nested);
  });

  test("undockNodes manda o nó para a direita da área e o tira da lista; quem não está em área é ignorado", () => {
    const docked = applyOp(base(), dockNodes(base(), ["in"], "ar")!);
    const out = applyOp(docked, undockNodes(docked, ["in"])!);
    expect(membersOf(out, "ar")).toEqual([]);
    expect(at(out, "in").x).toBe(500 + AREA_LIMITS.gap);
    expect(undockNodes(out, ["in", "out"])).toBeUndefined();
  });

  test("a menor área vence no ponto e `ignore` pula a área arrastada", () => {
    const doc = docOf(area("big", { w: 800, h: 800 }), area("small", { x: 100, y: 100, w: 200, h: 200 }));
    expect(areaAtPoint(doc, { x: 150, y: 150 })).toBe("small");
    expect(areaAtPoint(doc, { x: 150, y: 150 }, new Set(["small"]))).toBe("big");
    expect(areaAtPoint(doc, { x: 2000, y: 2000 })).toBeUndefined();
  });
});

describe("canvas-areas: soltar o arrasto", () => {
  const base = () => docOf(area("ar", { x: 0, y: 0, w: 500, h: 400 }), node("a", { x: 50, y: 80 }), node("b", { x: 900, y: 80 }));

  test("dropOps: entra quando o centro cai dentro, sai quando cai fora, troca de área", () => {
    const doc = base();
    const moved = validateCanvasDoc({ ...doc, nodes: doc.nodes.map((n) => (n.id === "b" ? { ...n, x: 100 } : n)) });
    const next = applyOp(moved, dropOps(moved, ["b"])!);
    expect(membersOf(next, "ar")).toEqual(["b"]);
    const away = validateCanvasDoc({ ...next, nodes: next.nodes.map((n) => (n.id === "b" ? { ...n, x: 1500 } : n)) });
    expect(membersOf(applyOp(away, dropOps(away, ["b"])!), "ar")).toEqual([]);
    expect(membersOf(applyOp(base(), dropOps(base(), ["a"])!), "ar")).toEqual(["a"]);
    expect(dropOps(base(), ["b"])).toBeUndefined();
  });

  test("troca de área ao soltar dentro de outra", () => {
    const start = docOf(area("p", {}, { title: "p", color: "chart-1", members: ["a"] }), area("q", { x: 800 }), node("a", { x: 850, y: 80 }));
    const next = applyOp(start, dropOps(start, ["a"])!);
    expect(membersOf(next, "p")).toEqual([]);
    expect(membersOf(next, "q")).toEqual(["a"]);
  });

  test("área arrastada leva os membros e a pertença não muda; área não entra em área", () => {
    const start = docOf(area("p", {}, { title: "p", color: "chart-1", members: ["a"] }), area("q", { x: 800, w: 300 }), node("a", { x: 50, y: 80 }));
    expect(withAreaMembers(start, ["p"])).toEqual(["p", "a"]);
    const move = opMoveMany(start, withAreaMembers(start, ["p"]), 820, 0);
    const settled = settleMove(start, move, ["p", "a"])!;
    const next = applyOp(start, settled);
    expect(membersOf(next, "p")).toEqual(["a"]);
    expect(membersOf(next, "q")).toEqual([]);
    expect(at(next, "a").x).toBe(870);
  });

  test("settleMove junta movimento e encaixe num passo só: um undo desfaz os dois", () => {
    const start = docOf(area("ar"), node("a", { x: 900, y: 900 }));
    const move = opMoveMany(start, ["a"], -800, -800);
    const step = settleMove(start, move, ["a"])!;
    let h = createHistory();
    const done = perform(h, start, step);
    expect(membersOf(done.doc, "ar")).toEqual(["a"]);
    const back = undo(done.history, done.doc)!;
    expect(at(back.doc, "a").x).toBe(900);
    expect(membersOf(back.doc, "ar")).toEqual([]);
    expect(membersOf(redo(back.history, back.doc)!.doc, "ar")).toEqual(["a"]);
    expect(settleMove(start, undefined, ["a"])).toBeUndefined();
  });
});

describe("canvas-areas: apagar e colar", () => {
  test("apagar a área não apaga os nós; apagar o nó poda a lista, e o undo devolve tudo num passo", () => {
    const start = docOf(area("ar", {}, { title: "A", color: "chart-1", members: ["a", "b"] }), node("a", { x: 10, y: 50 }), node("b", { x: 200, y: 50 }));
    const noArea = applyOp(start, deleteNodes(start, ["ar"]).op!);
    expect(noArea.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    const noNode = deleteNodes(start, ["a"]).op!;
    const after = applyOp(start, noNode);
    expect(membersOf(after, "ar")).toEqual(["b"]);
    const done = perform(createHistory(), start, noNode);
    const back = undo(done.history, done.doc)!.doc;
    expect(membersOf(back, "ar")).toEqual(["a", "b"]);
  });

  test("colar remapeia membros copiados juntos e solta os demais", () => {
    const doc = docOf(area("ar", {}, { title: "A", color: "chart-1", members: ["a", "b"] }), node("a", { x: 10, y: 50 }), node("b", { x: 200, y: 50 }));
    const { clip } = copyNodes(doc, ["ar", "a"]);
    const pasted = pasteClip(doc, clip, sequentialIds(doc));
    const next = applyOp(doc, pasted.op!);
    const copy = pasted.nodeIds.map((id) => at(next, id)).find((n) => n.type === "area")!;
    const copyA = pasted.nodeIds.map((id) => at(next, id)).find((n) => n.type === "note")!;
    expect(membersOf(next, copy.id)).toEqual([copyA.id]);
    expect(membersOf(next, "ar")).toEqual(["a", "b"]);
    expect(() => checkAreas(next)).not.toThrow();
  });

  test("areaIndex ignora membro que não existe mais", () => {
    const doc = docOf(area("ar", {}, { title: "A", color: "chart-1", members: ["fantasma", "a"] }), node("a"));
    expect([...areaIndex(doc)]).toEqual([["a", "ar"]]);
  });
});

describe("área desenhada pela barra", () => {
  test("dado um retângulo, nodesCenteredIn devolve os nós de centro dentro dele, borda inclusa, sem áreas", () => {
    const doc = docOf(
      area("ar1", { x: 0, y: 0, w: 300, h: 300 }),
      node("dentro", { x: 10, y: 10 }),
      node("borda", { x: 150, y: 170 }),
      node("meio-fora", { x: 220, y: 0 }),
      node("fora", { x: 500, y: 500 }),
    );
    expect(nodesCenteredIn(doc, { x: 0, y: 0, w: 200, h: 200 })).toEqual(["dentro", "borda"]);
  });

  test("dado um retângulo vazio, nodesCenteredIn devolve lista vazia e a área nasce sem membros", () => {
    const doc = docOf(node("n1", { x: 900, y: 900 }));
    const members = nodesCenteredIn(doc, { x: 0, y: 0, w: 200, h: 200 });
    expect(members).toEqual([]);
    const { op } = createAreaNode(doc, { id: "ar1", x: 0, y: 0, w: 200, h: 200, members });
    expect(membersOf(applyOp(doc, op), "ar1")).toEqual([]);
  });
});
