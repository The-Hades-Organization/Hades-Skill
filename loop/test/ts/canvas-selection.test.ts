// Grupo canvas-selection: seleção e manipulação direta do motor do canvas (src/lib/canvas-selection.ts) — acerto do
// ponteiro, clique, Shift, retângulo, limpar, mover vários = um lote (e um passo de desfazer), encaixe na grade, `locked`
// recusa, redimensionar, setas pela grade, ordem do Tab e nome acessível.
import { describe, expect, test } from "bun:test";
import { validateCanvasDoc, type CanvasDoc, type CanvasNode } from "../../../src/lib/canvas-doc";
import { applyOp, createHistory, perform, record, undo } from "../../../src/lib/canvas-history";
import {
  SELECTION_LIMITS, hitTest, keySelect, marqueeSelect, movableIds, moveOp, nextInOrder, nodeName, nudgeOp, pressEmpty,
  pressNode, pruneSelection, rectFrom, resizeOp, resizePreview, sameSelection, snap, tabOrder,
} from "../../../src/lib/canvas-selection";

const GRID = SELECTION_LIMITS.grid;
const node = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: "note", x: 0, y: 0, w: 100, h: 80, z: 0, data: {}, locked: false, blurred: false, ...over });
const docOf = (...nodes: CanvasNode[]): CanvasDoc => validateCanvasDoc({ v: 1, rev: 0, nodes, edges: [], groups: [] });
const posOf = (doc: CanvasDoc, id: string) => {
  const n = doc.nodes.find((x) => x.id === id);
  return n ? { x: n.x, y: n.y, w: n.w, h: n.h } : undefined;
};

describe("canvas-selection: acerto do ponteiro", () => {
  const nodes = [node("baixo", { z: 0 }), node("cima", { x: 50, y: 40, z: 1 }), node("empate", { x: 300, z: 5 }), node("empate2", { x: 300, z: 5 })];
  const near = { k: 1, detail: "full" as const, resizable: () => false };

  test("no cruzamento vence o maior z; no empate de z, o que vem depois na lista (desenhado por cima)", () => {
    expect(hitTest(nodes, { x: 60, y: 50 }, near)?.id).toBe("cima");
    expect(hitTest(nodes, { x: 10, y: 10 }, near)?.id).toBe("baixo");
    expect(hitTest(nodes, { x: 310, y: 10 }, near)?.id).toBe("empate2");
  });

  test("ponto no vazio não acerta nada", () => {
    expect(hitTest(nodes, { x: 1000, y: 1000 }, near)).toBeUndefined();
    expect(hitTest([], { x: 0, y: 0 }, near)).toBeUndefined();
  });

  test("perto: cabeçalho move, corpo não; longe o nó inteiro vale como cabeçalho", () => {
    const one = [node("a", { h: 100 })];
    expect(hitTest(one, { x: 50, y: SELECTION_LIMITS.header - 1 }, near)?.region).toBe("header");
    expect(hitTest(one, { x: 50, y: 70 }, near)?.region).toBe("body");
    expect(hitTest(one, { x: 50, y: 70 }, { ...near, detail: "block" })?.region).toBe("header");
    expect(hitTest(one, { x: 50, y: 70 }, { ...near, detail: "dot" })?.region).toBe("header");
  });

  test("alça no canto inferior direito só para nó redimensionável, com tamanho fixo de tela", () => {
    const one = [node("a")];
    const corner = { x: 98, y: 78 };
    expect(hitTest(one, corner, near)?.region).toBe("body");
    expect(hitTest(one, corner, { ...near, resizable: () => true })?.region).toBe("resize");
    // em k=0.5 a alça de 12 px de tela cobre 24 unidades de mundo
    expect(hitTest(one, { x: 80, y: 60 }, { k: 0.5, detail: "full", resizable: () => true })?.region).toBe("resize");
    expect(hitTest(one, { x: 80, y: 60 }, { k: 1, detail: "full", resizable: () => true })?.region).toBe("body");
  });
});

describe("canvas-selection: clique, Shift, retângulo e limpar", () => {
  test("clique num nó fora da seleção seleciona só ele", () => {
    expect(pressNode(["a", "b"], "c", false)).toEqual({ selection: ["c"], onClick: undefined });
  });

  test("clique num nó já selecionado mantém o grupo (para arrastar) e, sem arrasto, fica só ele", () => {
    expect(pressNode(["a", "b"], "b", false)).toEqual({ selection: ["a", "b"], onClick: ["b"] });
    expect(pressNode(["b"], "b", false)).toEqual({ selection: ["b"], onClick: undefined });
  });

  test("Shift soma um nó novo na hora e tira um já selecionado ao soltar sem arrastar", () => {
    expect(pressNode(["a"], "b", true)).toEqual({ selection: ["a", "b"], onClick: undefined });
    expect(pressNode(["a", "b"], "a", true)).toEqual({ selection: ["a", "b"], onClick: ["b"] });
  });

  test("clique no vazio limpa; com Shift mantém", () => {
    expect(pressEmpty(["a", "b"], false)).toEqual([]);
    expect(pressEmpty(["a", "b"], true)).toEqual(["a", "b"]);
  });

  test("Espaço seleciona só o focado; Shift+Espaço alterna", () => {
    expect(keySelect(["a", "b"], "c", false)).toEqual(["c"]);
    expect(keySelect(["a"], "c", true)).toEqual(["a", "c"]);
    expect(keySelect(["a", "c"], "c", true)).toEqual(["a"]);
  });

  test("retângulo pega os nós que toca, na ordem do documento, de qualquer canto para qualquer canto", () => {
    const nodes = [node("a", { x: 0 }), node("b", { x: 200 }), node("c", { x: 400 })];
    const rect = rectFrom({ x: 250, y: 50 }, { x: 50, y: 10 });
    expect(rect).toEqual({ x: 50, y: 10, w: 200, h: 40 });
    expect(marqueeSelect(nodes, rect, ["c"], false)).toEqual(["a", "b"]);
  });

  test("retângulo com Shift soma à seleção de partida sem repetir", () => {
    const nodes = [node("a", { x: 0 }), node("b", { x: 200 }), node("c", { x: 400 })];
    expect(marqueeSelect(nodes, { x: 150, y: 0, w: 100, h: 10 }, ["c", "b"], true)).toEqual(["c", "b"]);
    expect(marqueeSelect(nodes, { x: -10, y: 0, w: 20, h: 10 }, ["c"], true)).toEqual(["c", "a"]);
  });

  test("retângulo no vazio dá seleção vazia (sem Shift)", () => {
    expect(marqueeSelect([node("a")], { x: 500, y: 500, w: 10, h: 10 }, ["a"], false)).toEqual([]);
  });

  test("seleção perde o que saiu do documento e devolve a mesma lista quando nada saiu", () => {
    const doc = docOf(node("a"), node("b"));
    const sel = ["a", "b"];
    expect(pruneSelection(sel, doc)).toBe(sel);
    expect(pruneSelection(["a", "x", "b"], doc)).toEqual(["a", "b"]);
    expect(sameSelection(["a"], ["a"])).toBe(true);
    expect(sameSelection(["a", "b"], ["b", "a"])).toBe(false);
  });
});

describe("canvas-selection: mover", () => {
  test("encaixe na grade arredonda para o múltiplo mais perto", () => {
    expect([snap(9), snap(10), snap(11), snap(-11), snap(0)]).toEqual([0, 20, 20, -20, 0]);
    expect(snap(37, 25)).toBe(25);
  });

  test("um nó: soltar encaixa a posição na grade e vira um move", () => {
    const doc = docOf(node("a", { x: 0, y: 0 }));
    const op = moveOp(doc, ["a"], "a", 47, 13);
    expect(op).toEqual({ kind: "move", id: "a", from: { x: 0, y: 0 }, to: { x: 40, y: 20 } });
  });

  test("vários: um lote só, todos com o mesmo delta (do nó pego, encaixado) e distâncias mantidas", () => {
    const doc = docOf(node("a", { x: 0, y: 0 }), node("b", { x: 205, y: 7 }), node("c", { x: 500, y: 300 }));
    const op = moveOp(doc, ["a", "b", "c"], "a", 31, -9);
    expect(op?.kind).toBe("batch");
    if (op?.kind !== "batch") throw new Error("esperava lote");
    expect(op.ops).toHaveLength(3);
    const next = applyOp(doc, op);
    expect(posOf(next, "a")).toMatchObject({ x: 40, y: 0 });
    expect(posOf(next, "b")).toMatchObject({ x: 245, y: 7 });
    expect(posOf(next, "c")).toMatchObject({ x: 540, y: 300 });
  });

  test("arrasto de vários desfaz num passo só", () => {
    const doc = docOf(node("a"), node("b", { x: 200 }), node("c", { x: 400 }));
    const op = moveOp(doc, ["a", "b", "c"], "b", 60, 60);
    if (!op) throw new Error("esperava operação");
    const done = perform(createHistory(), doc, op);
    expect(done.history.past).toHaveLength(1);
    expect(undo(done.history, done.doc)?.doc).toEqual(doc);
    // `record` registra o que a página já aplicou (o motor entrega a operação e o documento novo)
    expect(record(createHistory(), op).past).toEqual([op]);
  });

  test("soltar sem sair da célula da grade não gera operação", () => {
    const doc = docOf(node("a", { x: 0, y: 0 }));
    expect(moveOp(doc, ["a"], "a", 9, -9)).toBeUndefined();
  });

  test("nó locked não se move: pegá-lo não move ninguém, e no meio de uma seleção ele fica parado", () => {
    const doc = docOf(node("a"), node("trava", { x: 200, locked: true }), node("c", { x: 400 }));
    expect(movableIds(doc, ["a", "trava", "c"], "trava")).toEqual([]);
    expect(moveOp(doc, ["a", "trava", "c"], "trava", 100, 0)).toBeUndefined();
    expect(movableIds(doc, ["a", "trava", "c"], "a")).toEqual(["a", "c"]);
    const op = moveOp(doc, ["a", "trava", "c"], "a", 100, 0);
    if (!op) throw new Error("esperava operação");
    const next = applyOp(doc, op);
    expect(posOf(next, "trava")).toMatchObject({ x: 200 });
    expect(posOf(next, "c")).toMatchObject({ x: 500 });
  });

  test("pegar um nó fora da seleção move só ele", () => {
    const doc = docOf(node("a"), node("b", { x: 200 }));
    expect(movableIds(doc, ["a"], "b")).toEqual(["b"]);
    expect(movableIds(doc, [], "sumiu")).toEqual([]);
  });

  test("deslocamento não deixa nó sair da faixa de coordenadas do documento", () => {
    const doc = docOf(node("a", { x: 9_999_980 }));
    const op = moveOp(doc, ["a"], "a", 1000, 0);
    if (!op) throw new Error("esperava operação");
    expect(() => validateCanvasDoc(applyOp(doc, op))).not.toThrow();
  });

  test("deslocamento que não é número é erro", () => {
    const doc = docOf(node("a"));
    expect(() => moveOp(doc, ["a"], "a", Number.NaN, 0)).toThrow(RangeError);
  });
});

describe("canvas-selection: redimensionar", () => {
  test("soltar a alça encaixa a borda direita e a de baixo na grade", () => {
    const doc = docOf(node("a", { x: 10, y: 0, w: 100, h: 80 }));
    const op = resizeOp(doc, "a", 33, 27);
    expect(op).toEqual({ kind: "resize", id: "a", from: { x: 10, y: 0, w: 100, h: 80 }, to: { x: 10, y: 0, w: 130, h: 100 } });
  });

  test("lado mínimo ao vivo e ao soltar", () => {
    const n = node("a", { w: 100, h: 80 });
    expect(resizePreview(n, -500, -500)).toEqual({ x: 0, y: 0, w: SELECTION_LIMITS.minSide, h: SELECTION_LIMITS.minSide });
    const op = resizeOp(docOf(n), "a", -500, -500);
    expect(op?.kind === "resize" ? op.to : undefined).toEqual({ x: 0, y: 0, w: SELECTION_LIMITS.minSide, h: SELECTION_LIMITS.minSide });
  });

  test("nó locked recusa; sem mudança de tamanho não há operação", () => {
    expect(resizeOp(docOf(node("a", { locked: true })), "a", 100, 100)).toBeUndefined();
    expect(resizeOp(docOf(node("a")), "a", 5, -5)).toBeUndefined();
    expect(resizeOp(docOf(node("a")), "sumiu", 100, 100)).toBeUndefined();
  });
});

describe("canvas-selection: teclado", () => {
  test("seta anda uma grade e encaixa; Shift anda cinco", () => {
    const doc = docOf(node("a", { x: 0, y: 0 }), node("off", { x: 7, y: 0 }));
    expect(nudgeOp(doc, [], "a", "ArrowRight", false)).toMatchObject({ kind: "move", to: { x: GRID, y: 0 } });
    expect(nudgeOp(doc, [], "a", "ArrowUp", true)).toMatchObject({ kind: "move", to: { x: 0, y: -GRID * SELECTION_LIMITS.fastNudge } });
    expect(nudgeOp(doc, [], "off", "ArrowRight", false)).toMatchObject({ kind: "move", to: { x: 20, y: 0 } });
  });

  test("seta no nó focado e selecionado leva a seleção junto, num lote", () => {
    const doc = docOf(node("a"), node("b", { x: 200 }), node("c", { x: 400 }));
    const op = nudgeOp(doc, ["a", "b"], "a", "ArrowDown", false);
    expect(op?.kind).toBe("batch");
    if (!op) throw new Error("esperava operação");
    const next = applyOp(doc, op);
    expect([posOf(next, "a")?.y, posOf(next, "b")?.y, posOf(next, "c")?.y]).toEqual([GRID, GRID, 0]);
  });

  test("seta no nó focado fora da seleção move só ele", () => {
    const doc = docOf(node("a"), node("b", { x: 200 }));
    expect(nudgeOp(doc, ["b"], "a", "ArrowLeft", false)).toMatchObject({ kind: "move", id: "a" });
  });

  test("nó focado locked recusa; tecla que não é seta não faz nada", () => {
    const doc = docOf(node("a", { locked: true }));
    expect(nudgeOp(doc, [], "a", "ArrowRight", false)).toBeUndefined();
    expect(nudgeOp(docOf(node("b")), [], "b", "Enter", false)).toBeUndefined();
  });

  test("ordem do Tab é a de leitura (y, depois x), com desempate pelo id, sem depender da ordem do documento", () => {
    const nodes = [node("d", { x: 0, y: 200 }), node("b", { x: 300, y: 0 }), node("a", { x: 0, y: 0 }), node("c2", { x: 300, y: 0 }), node("c1", { x: 300, y: 0 })];
    expect(tabOrder(nodes)).toEqual(["a", "b", "c1", "c2", "d"]);
    expect(tabOrder([...nodes].reverse())).toEqual(tabOrder(nodes));
    expect(tabOrder([])).toEqual([]);
  });

  test("ordem do Tab: nós desalinhados por poucos pixels ficam na mesma linha e seguem da esquerda para a direita", () => {
    const nodes = [
      node("linha1-c", { x: 400, y: 0, h: 80 }), node("linha1-b", { x: 200, y: 40, h: 80 }), node("linha1-a", { x: 0, y: 20, h: 80 }),
      node("linha2-a", { x: 0, y: 160, h: 80 }), node("linha2-b", { x: 200, y: 150, h: 100 }),
    ];
    expect(tabOrder(nodes)).toEqual(["linha1-a", "linha1-b", "linha1-c", "linha2-a", "linha2-b"]);
  });

  test("ordem do Tab: nó que só encosta embaixo do primeiro da linha começa outra linha", () => {
    const nodes = [node("alto", { x: 500, y: 0, h: 80 }), node("baixo", { x: 0, y: 70, h: 80 })];
    expect(tabOrder(nodes)).toEqual(["alto", "baixo"]);
  });

  test("próximo do Tab: sem foco entra pelo primeiro (ou último com Shift); nas pontas devolve undefined para sair", () => {
    const order = ["a", "b", "c"];
    expect(nextInOrder(order, undefined, false)).toBe("a");
    expect(nextInOrder(order, undefined, true)).toBe("c");
    expect(nextInOrder(order, "a", false)).toBe("b");
    expect(nextInOrder(order, "b", true)).toBe("a");
    expect(nextInOrder(order, "c", false)).toBeUndefined();
    expect(nextInOrder(order, "a", true)).toBeUndefined();
    expect(nextInOrder(order, "sumiu", false)).toBe("a");
    expect(nextInOrder([], undefined, false)).toBeUndefined();
  });

  test("nome acessível: rótulo, selecionado e bloqueado; sem rótulo, tipo e id", () => {
    expect(nodeName(node("n1", { locked: true }), "Nota de deploy", true)).toBe("Nota de deploy, selecionado, bloqueado");
    expect(nodeName(node("n1"), "", false)).toBe("note n1");
  });
});
