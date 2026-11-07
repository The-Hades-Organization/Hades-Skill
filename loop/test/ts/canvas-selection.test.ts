// Grupo canvas-selection: seleção e manipulação direta do motor do canvas (src/lib/canvas-selection.ts) — acerto do
// ponteiro, clique, Shift, retângulo, limpar, mover vários = um lote (e um passo de desfazer), encaixe na grade, `locked`
// recusa, redimensionar, setas pela grade, ordem do Tab e nome acessível.
import { describe, expect, test } from "bun:test";
import { validateCanvasDoc, type CanvasDoc, type CanvasNode } from "../../../src/lib/canvas-doc";
import { applyOp, createHistory, perform, record, undo } from "../../../src/lib/canvas-history";
import {
  CORNER_SE, entersFirstNodeOnFocus, SELECTION_LIMITS, hitTest, keySelect, marqueeSelect, movableIds, moveOp, nextInOrder, nodeName, nudgeOp, pressEmpty,
  pressNode, pruneSelection, rectFrom, resizeCursor, resizeOp, resizePreview, sameSelection, snap, tabOrder,
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

describe("canvas-selection: bordas e cantos que redimensionam", () => {
  const term = [node("t", { x: 100, y: 100, w: 200, h: 160 })];
  const opts = { k: 1, detail: "full" as const, resizable: () => false, edgeResizable: () => true };
  const edgeOf = (x: number, y: number, over: Partial<typeof opts> = {}) => {
    const hit = hitTest(term, { x, y }, { ...opts, ...over });
    return hit?.region === "resize" ? hit.edge : undefined;
  };

  test("dado nó de borda, quando o ponteiro está na borda esquerda, direita ou de baixo, então redimensiona só aquele lado", () => {
    expect(edgeOf(102, 180)).toEqual({ left: true, right: false, bottom: false });
    expect(edgeOf(298, 180)).toEqual({ left: false, right: true, bottom: false });
    expect(edgeOf(200, 258)).toEqual({ left: false, right: false, bottom: true });
  });

  test("dado o canto de baixo, então os dois lados movem (esquerdo e direito)", () => {
    expect(edgeOf(102, 258)).toEqual({ left: true, right: false, bottom: true });
    expect(edgeOf(298, 258)).toEqual(CORNER_SE);
  });

  test("o topo continua sendo a alça de mover: nem a borda nem os cantos de cima redimensionam", () => {
    expect(hitTest(term, { x: 101, y: 101 }, opts)?.region).toBe("header");
    expect(hitTest(term, { x: 299, y: 101 }, opts)?.region).toBe("header");
    expect(hitTest(term, { x: 200, y: 101 }, opts)?.region).toBe("header");
    // logo abaixo do cabeçalho a faixa lateral já vale
    expect(edgeOf(101, 100 + SELECTION_LIMITS.header + 1)?.left).toBe(true);
  });

  test("o miolo do nó segue sendo conteúdo e nó fora da lista de borda não ganha borda", () => {
    expect(hitTest(term, { x: 200, y: 180 }, opts)?.region).toBe("body");
    expect(edgeOf(102, 180, { edgeResizable: () => false })).toBeUndefined();
  });

  test("a faixa tem tamanho fixo de tela: em k=0.5 cobre o dobro em unidades de mundo", () => {
    expect(edgeOf(108, 180, { k: 1 })).toBeUndefined();
    expect(edgeOf(108, 180, { k: 0.5 })?.left).toBe(true);
  });

  test("cursor segue a borda", () => {
    expect(resizeCursor({ left: true, right: false, bottom: false })).toBe("ew-resize");
    expect(resizeCursor({ left: false, right: true, bottom: false })).toBe("ew-resize");
    expect(resizeCursor({ left: false, right: false, bottom: true })).toBe("ns-resize");
    expect(resizeCursor({ left: true, right: false, bottom: true })).toBe("nesw-resize");
    expect(resizeCursor(CORNER_SE)).toBe("nwse-resize");
  });

  test("a borda esquerda muda x e w juntos e a direita do nó fica parada", () => {
    const doc = docOf(node("a", { x: 100, y: 0, w: 200, h: 80 }));
    const op = resizeOp(doc, "a", -41, 0, GRID, { left: true, right: false, bottom: false });
    expect(op).toEqual({ kind: "resize", id: "a", from: { x: 100, y: 0, w: 200, h: 80 }, to: { x: 60, y: 0, w: 240, h: 80 } });
    expect(resizePreview(doc.nodes[0]!, -30, 0, { left: true, right: false, bottom: false })).toEqual({ x: 70, y: 0, w: 230, h: 80 });
  });

  test("o canto de baixo esquerdo move x, w e h; o lado mínimo segura a borda esquerda com a direita parada", () => {
    const doc = docOf(node("a", { x: 100, y: 0, w: 200, h: 80 }));
    const edge = { left: true, right: false, bottom: true };
    const op = resizeOp(doc, "a", -20, 40, GRID, edge);
    expect(op?.kind === "resize" ? op.to : undefined).toEqual({ x: 80, y: 0, w: 220, h: 120 });
    const squeezed = resizePreview(doc.nodes[0]!, 900, 0, edge);
    expect(squeezed.x + squeezed.w).toBe(300);
    expect(squeezed.w).toBe(SELECTION_LIMITS.minSide);
  });

  test("o canto de baixo direito e a borda de baixo seguem o redimensionar de sempre; locked recusa", () => {
    const doc = docOf(node("a", { x: 10, y: 0, w: 100, h: 80 }));
    expect(resizeOp(doc, "a", 0, 40, GRID, { left: false, right: false, bottom: true })?.kind).toBe("resize");
    expect(resizeOp(doc, "a", 33, 27, GRID, CORNER_SE)).toEqual(resizeOp(doc, "a", 33, 27));
    expect(resizeOp(docOf(node("l", { locked: true })), "l", -60, 0, GRID, { left: true, right: false, bottom: false })).toBeUndefined();
  });

  test("um gesto de borda esquerda é uma operação só e o desfazer volta inteiro", () => {
    const doc = docOf(node("a", { x: 100, y: 0, w: 200, h: 80 }));
    const op = resizeOp(doc, "a", -40, 20, GRID, { left: true, right: false, bottom: true });
    if (!op) throw new Error("sem operação");
    const done = perform(createHistory(), doc, op);
    expect(posOf(done.doc, "a")).toEqual({ x: 60, y: 0, w: 240, h: 100 });
    const back = undo(done.history, done.doc);
    expect(back && posOf(back.doc, "a")).toEqual({ x: 100, y: 0, w: 200, h: 80 });
    expect(undo(back?.history ?? done.history, back?.doc ?? done.doc)).toBeUndefined();
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

  test("foco no host só entra pelo primeiro nó (e move a câmera) quando vem do Tab, não de clique nem de volta à janela", () => {
    expect(entersFirstNodeOnFocus({ pointer: false, windowReturn: false })).toBe(true);
    expect(entersFirstNodeOnFocus({ pointer: true, windowReturn: false })).toBe(false);
    expect(entersFirstNodeOnFocus({ pointer: false, windowReturn: true })).toBe(false);
  });

  test("nome acessível: rótulo, selecionado e bloqueado; sem rótulo, tipo e id", () => {
    expect(nodeName(node("n1", { locked: true }), "Nota de deploy", true)).toBe("Nota de deploy, selecionado, bloqueado");
    expect(nodeName(node("n1"), "", false)).toBe("note n1");
  });
});

describe("canvas-selection: nó oco (área)", () => {
  const ar = node("ar", { type: "area", w: 500, h: 400, z: -1000 });
  const inner = node("in", { x: 100, y: 100, z: 0 });
  const hollow = (n: CanvasNode) => n.type === "area";
  const opts = { k: 1, detail: "full" as const, resizable: () => false, edgeResizable: () => true, hollow };

  test("o interior deixa o clique passar; o cabeçalho acerta; sem hollow o interior acerta", () => {
    expect(hitTest([ar], { x: 250, y: 200 }, opts)).toBeUndefined();
    expect(hitTest([ar], { x: 250, y: 5 }, opts)?.region).toBe("header");
    expect(hitTest([ar], { x: 250, y: 200 }, { ...opts, hollow: undefined })?.id).toBe("ar");
  });

  test("a borda ainda redimensiona e o nó dentro da área é o acertado", () => {
    expect(hitTest([ar], { x: 499, y: 200 }, opts)?.region).toBe("resize");
    expect(hitTest([ar, inner], { x: 120, y: 120 }, opts)?.id).toBe("in");
  });

  test("afastado o cabeçalho oco tem ao menos 16px de tela", () => {
    expect(hitTest([ar], { x: 250, y: 30 }, { ...opts, k: 0.25, detail: "far" as never })?.id).toBe("ar");
    expect(hitTest([ar], { x: 250, y: 80 }, { ...opts, k: 0.25 })).toBeUndefined();
  });

  test("marquee só pega a área inteira", () => {
    const partial = marqueeSelect([ar, inner], { x: 50, y: 50, w: 200, h: 200 } as never, [], false, hollow);
    expect(partial).toEqual(["in"]);
    const whole = marqueeSelect([ar, inner], { x: -10, y: -10, w: 600, h: 500 } as never, [], false, hollow);
    expect([...whole].sort()).toEqual(["ar", "in"]);
  });
});
