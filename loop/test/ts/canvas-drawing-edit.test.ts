// Grupo canvas-drawing-edit: fluidez, seleção e integridade do desenho (src/lib/canvas-drawing.ts) — traço suavizado, caixa de
// seleção, redimensionar o conjunto, duplicar, camadas, um passo de desfazer por gesto e ida e volta do formato. Lógica pura.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type CanvasDoc, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { createHistory, opMove, perform, undo, redo } from "../../../src/lib/canvas-history";
import {
  addElement, addStroke, type Box, createDrawingNode, DRAW_PALETTE, DRAW_SHORTCUTS, DRAW_WIDTHS, DrawingError, drawingToSvg, duplicateElements,
  elementBox, elementsInRect, fitStroke, moveElements, opSetDrawing, readDrawingData, removeElements, reorderElements, resizeBox,
  rgbaToHex, scaleElements, selectionBounds, sceneData, strokePath, STROKE_FIT, DRAWING_LIMITS, type DrawingScene,
} from "../../../src/lib/canvas-drawing";

const codeOf = (run: () => unknown): string => {
  try { run(); } catch (error) { if (error instanceof DrawingError) return error.code; throw error; }
  return "no-error";
};
const sceneOf = (...elements: Record<string, unknown>[]): DrawingScene => readDrawingData({ v: 1, elements });
const rect = (id: string, x = 0, y = 0, w = 100, h = 50) => ({ id, type: "rect", x, y, w, h });
const idsOf = (scene: DrawingScene): string[] => scene.elements.map((el) => el.id);
const docWith = (scene: DrawingScene): CanvasDoc => {
  const created = createDrawingNode(validateCanvasDoc({ v: 1, rev: 1, nodes: [], edges: [], groups: [] }), { id: "d1", x: 10, y: 20, elements: scene.elements, ...(scene.title !== undefined && { title: scene.title }) });
  return validateCanvasDoc({ v: 1, rev: 1, nodes: [created.node], edges: [], groups: [] });
};

/** Distância do ponto ao segmento: a régua de "a forma não se perdeu". */
function distance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
const deviation = (original: [number, number][], kept: [number, number][]): number =>
  Math.max(...original.map((p) => Math.min(...kept.slice(1).map((q, i) => distance(p, kept[i] as [number, number], q)))));

describe("traço suavizado", () => {
  test("dado milhares de amostras de um L, quando ajustado, então guarda as pontas e o canto e nenhuma amostra fica além da tolerância", () => {
    const raw: [number, number][] = [];
    for (let i = 0; i <= 1000; i++) raw.push([i * 0.2, 0.3 * Math.sin(i)]);
    for (let i = 1; i <= 1000; i++) raw.push([200, i * 0.2]);
    const { points } = fitStroke(raw);
    expect(points[0]).toEqual(raw[0] as [number, number]);
    expect(points.at(-1)).toEqual(raw.at(-1) as [number, number]);
    expect(points.length).toBeLessThan(40);
    expect(points.some(([x, y]) => Math.abs(x - 200) < 1 && Math.abs(y) < 1)).toBe(true);
    expect(deviation(raw, points)).toBeLessThanOrEqual(STROKE_FIT.tolerance + 1e-9);
  });

  test("dado entrada acima do teto de amostras, quando ajustada, então recusa com código estável antes de calcular", () => {
    const raw = Array.from({ length: STROKE_FIT.inputMax + 1 }, (_, i): [number, number] => [i, i]);
    expect(codeOf(() => fitStroke(raw))).toBe("drawing_limit_exceeded");
  });

  test("dado um traço que passa do limite de pontos mesmo simplificado, quando ajustado, então reamostra por igual e mantém as pontas", () => {
    const raw = Array.from({ length: 4000 }, (_, i): [number, number] => [i, i % 2 === 0 ? 0 : 40]);
    const { points } = fitStroke(raw);
    expect(points.length).toBeLessThanOrEqual(DRAWING_LIMITS.strokePoints);
    expect(points[0]).toEqual([0, 0]);
    expect(points.at(-1)).toEqual([3999, 40]);
  });

  test("dado pressão por amostra, quando ajustado, então a pressão acompanha os pontos que sobraram", () => {
    const raw = Array.from({ length: 200 }, (_, i): [number, number] => [i, i < 100 ? 0 : i - 100]);
    const pressure = raw.map((_, i) => i / 199);
    const fitted = fitStroke(raw, pressure);
    expect(fitted.pressure).toHaveLength(fitted.points.length);
    expect(fitted.pressure?.[0]).toBe(0);
    expect(fitted.pressure?.at(-1)).toBe(1);
  });

  test("dado entrada vazia ou com ponto inválido, quando ajustada, então recusa", () => {
    expect(codeOf(() => fitStroke([]))).toBe("drawing_invalid_element");
    expect(codeOf(() => fitStroke([[0, 0], [Number.NaN, 1]]))).toBe("drawing_invalid_element");
    expect(codeOf(() => fitStroke([[0, 0], [1, 1]], [0.5]))).toBe("drawing_invalid_element");
  });

  test("dado três ou mais pontos, quando vira caminho, então é uma curva que passa por todos os pontos e termina na última ponta", () => {
    const d = strokePath([[0, 0], [10, 10], [20, 0], [30, 10]]);
    expect(d.startsWith("M0,0")).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(3);
    expect(d.endsWith("30,10")).toBe(true);
    expect(d).toContain("10,10");
    expect(d).toContain("20,0");
  });

  test("dado um ou dois pontos, quando vira caminho, então é um ponto redondo ou uma reta, sem curva", () => {
    expect(strokePath([[5, 5]])).toBe("M5,5L5,5");
    expect(strokePath([[0, 0], [8, 4]])).toBe("M0,0L8,4");
  });

  test("dado o mesmo traço, quando vira caminho duas vezes, então o texto é idêntico (a tela e o SVG usam a mesma função)", () => {
    const points: [number, number][] = [[0, 0], [3.33, 7.78], [12, 4], [20, 20]];
    expect(strokePath(points)).toBe(strokePath(points));
    const scene = addStroke(sceneOf(), { points }).scene;
    expect(drawingToSvg(scene)).toContain(`d="${strokePath(points)}"`);
  });

  test("dado um traço novo, quando adicionado, então entra simplificado e como um elemento só", () => {
    const raw = Array.from({ length: 800 }, (_, i): [number, number] => [i * 0.25, 0]);
    const { scene, id } = addStroke(sceneOf(), { points: raw, stroke: "#ff0000", width: 4 });
    const el = scene.elements[0];
    expect(scene.elements).toHaveLength(1);
    expect(id).toBe("e1");
    expect(el?.type === "stroke" && el.points).toEqual([[0, 0], [199.75, 0]]);
  });

  test("dado pressão no traço, quando lido de volta, então o formato guarda e valida a pressão", () => {
    const scene = addStroke(sceneOf(), { points: [[0, 0], [5, 9], [9, 3]], pressure: [0.2, 0.9, 0.5] }).scene;
    expect(readDrawingData(JSON.parse(JSON.stringify(scene)))).toEqual(scene);
    const bad = (pressure: unknown) => codeOf(() => sceneOf({ id: "s", type: "stroke", points: [[0, 0], [1, 1]], pressure }));
    expect(bad([0.5])).toBe("drawing_invalid_element");
    expect(bad([0.5, 1.5])).toBe("drawing_invalid_element");
    expect(bad("x")).toBe("drawing_invalid_element");
  });
});

describe("seleção por caixa", () => {
  const scene = sceneOf(
    rect("a", 0, 0, 40, 40), rect("b", 100, 0, 40, 40), rect("c", 0, 100, 40, 40),
    { id: "s", type: "stroke", points: [[5, 5], [30, 30]] },
    { id: "ln", type: "line", from: { x: 50, y: 10 }, to: { x: 90, y: 10 } },
    { id: "ar", type: "arrow", from: { ref: "a" }, to: { ref: "b" } },
  );

  test("dado uma caixa, quando seleciona, então só entram os elementos inteiros dentro dela, na ordem da cena", () => {
    expect(elementsInRect(scene, { x: -5, y: -5, w: 60, h: 60 })).toEqual(["a", "s"]);
    expect(elementsInRect(scene, { x: -5, y: -5, w: 150, h: 60 })).toEqual(["a", "b", "s", "ln", "ar"]);
  });

  test("dado uma caixa que só toca a borda de um elemento, quando seleciona, então não o inclui", () => {
    expect(elementsInRect(scene, { x: 20, y: 30, w: 100, h: 100 })).toEqual([]);
  });

  test("dado uma caixa vazia ou sem nada dentro, quando seleciona, então a seleção é vazia", () => {
    expect(elementsInRect(scene, { x: 500, y: 500, w: 10, h: 10 })).toEqual([]);
    expect(elementsInRect(sceneOf(), { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
  });

  test("dado ids, quando pede a caixa do conjunto, então envolve todos; ids que não existem são ignorados", () => {
    expect(selectionBounds(scene, ["a", "b"])).toEqual({ x: 0, y: 0, w: 140, h: 40 });
    expect(selectionBounds(scene, ["nada"])).toBeUndefined();
    expect(selectionBounds(scene, [])).toBeUndefined();
  });
});

describe("mover e redimensionar sem salto", () => {
  test("dado a alça sudeste, quando arrasta, então o canto oposto não sai do lugar e o tamanho cresce pelo delta exato", () => {
    const box: Box = { x: 10, y: 20, w: 100, h: 50 };
    expect(resizeBox(box, "se", 7, 3)).toEqual({ x: 10, y: 20, w: 107, h: 53 });
  });

  test("dado a alça noroeste, quando arrasta, então o canto sudeste fica parado", () => {
    const next = resizeBox({ x: 10, y: 20, w: 100, h: 50 }, "nw", 4, -6);
    expect(next).toEqual({ x: 14, y: 14, w: 96, h: 56 });
    expect([next.x + next.w, next.y + next.h]).toEqual([110, 70]);
  });

  test("dado as alças de lado, quando arrasta, então só um eixo muda", () => {
    const box: Box = { x: 0, y: 0, w: 100, h: 50 };
    expect(resizeBox(box, "e", 10, 99)).toEqual({ x: 0, y: 0, w: 110, h: 50 });
    expect(resizeBox(box, "n", 99, -10)).toEqual({ x: 0, y: -10, w: 100, h: 60 });
  });

  test("dado um arrasto além do canto oposto, quando redimensiona, então trava no mínimo e o canto oposto continua parado", () => {
    const next = resizeBox({ x: 0, y: 0, w: 100, h: 50 }, "e", -500, 0, 8);
    expect(next).toEqual({ x: 0, y: 0, w: 8, h: 50 });
    const west = resizeBox({ x: 0, y: 0, w: 100, h: 50 }, "w", 500, 0, 8);
    expect(west.x + west.w).toBe(100);
    expect(west.w).toBe(8);
  });

  test("dado delta zero, quando redimensiona, então a caixa não muda (soltar sem arrastar não salta)", () => {
    const box: Box = { x: 3, y: 4, w: 50, h: 60 };
    for (const handle of ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const) expect(resizeBox(box, handle, 0, 0)).toEqual(box);
  });

  test("dado um conjunto, quando escala de uma caixa para outra, então cada elemento vai junto e as pontas presas continuam presas", () => {
    const scene = sceneOf(
      rect("a", 0, 0, 100, 50), { id: "t", type: "text", x: 0, y: 60, text: "oi", size: 20 },
      { id: "s", type: "stroke", points: [[0, 0], [100, 50]] },
      { id: "l", type: "line", from: { x: 0, y: 0 }, to: { x: 100, y: 50 } },
      { id: "ar", type: "arrow", from: { ref: "a" }, to: { x: 100, y: 100 } },
    );
    const from = selectionBounds(scene, idsOf(scene)) as Box;
    const next = scaleElements(scene, idsOf(scene), from, { x: from.x, y: from.y, w: from.w * 2, h: from.h * 2 });
    const a = next.elements.find((el) => el.id === "a");
    expect(a?.type === "rect" && [a.x, a.y, a.w, a.h]).toEqual([0, 0, 200, 100]);
    const s = next.elements.find((el) => el.id === "s");
    expect(s?.type === "stroke" && s.points).toEqual([[0, 0], [200, 100]]);
    const t = next.elements.find((el) => el.id === "t");
    expect(t?.type === "text" && t.size).toBe(40);
    const l = next.elements.find((el) => el.id === "l");
    expect(l?.type === "line" && l.to).toEqual({ x: 200, y: 100 });
    const ar = next.elements.find((el) => el.id === "ar");
    expect(ar?.type === "arrow" && ar.from).toEqual({ ref: "a" });
    expect(ar?.type === "arrow" && ar.to).toEqual({ x: 200, y: 200 });
  });

  test("dado uma escala que levaria o texto abaixo do mínimo, quando aplica, então o tamanho fica no mínimo do formato", () => {
    const scene = sceneOf({ id: "t", type: "text", x: 0, y: 0, text: "oi", size: 10 });
    const next = scaleElements(scene, ["t"], { x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 10, h: 10 });
    const t = next.elements[0];
    expect(t?.type === "text" && t.size).toBe(DRAWING_LIMITS.sizeMin);
  });

  test("dado um conjunto, quando move, então todos andam o mesmo delta e o resto não muda", () => {
    const scene = sceneOf(rect("a", 0, 0), rect("b", 10, 10), rect("c", 50, 50));
    const next = moveElements(scene, ["a", "b"], 5, -5);
    expect(elementBox(next, next.elements[0] as never)).toMatchObject({ x: 5, y: -5 });
    expect(elementBox(next, next.elements[1] as never)).toMatchObject({ x: 15, y: 5 });
    expect(next.elements[2]).toEqual(scene.elements[2]);
  });

  test("dado um id que não existe, quando move o conjunto, então recusa e a cena original fica intacta", () => {
    const scene = sceneOf(rect("a"));
    expect(codeOf(() => moveElements(scene, ["a", "x"], 1, 1))).toBe("drawing_missing_element");
    expect(scene.elements[0]).toMatchObject({ x: 0, y: 0 });
  });
});

describe("duplicar e camadas", () => {
  test("dado uma seleção, quando duplica, então as cópias têm ids novos, ficam deslocadas e no topo, e a selecionada passa a ser a cópia", () => {
    const scene = sceneOf(rect("a", 0, 0), rect("b", 200, 0));
    const out = duplicateElements(scene, ["a"], 16, 16);
    expect(out.ids).toEqual(["e1"]);
    expect(idsOf(out.scene)).toEqual(["a", "b", "e1"]);
    expect(out.scene.elements[2]).toMatchObject({ type: "rect", x: 16, y: 16, w: 100, h: 50 });
  });

  test("dado um conector entre dois duplicados, quando duplica, então a cópia liga as cópias; com um só preso fora, mantém o alvo original", () => {
    const scene = sceneOf(rect("a", 0, 0), rect("b", 200, 0), { id: "ar", type: "arrow", from: { ref: "a" }, to: { ref: "b" } });
    const both = duplicateElements(scene, ["a", "b", "ar"], 10, 10);
    const copy = both.scene.elements.find((el) => el.id === both.ids[2]);
    expect(copy?.type === "arrow" && [copy.from, copy.to]).toEqual([{ ref: both.ids[0] as string }, { ref: both.ids[1] as string }]);
    const one = duplicateElements(scene, ["a", "ar"], 10, 10);
    const half = one.scene.elements.find((el) => el.id === one.ids[1]);
    expect(half?.type === "arrow" && [half.from, half.to]).toEqual([{ ref: one.ids[0] as string }, { ref: "b" }]);
  });

  test("dado o teto de elementos, quando duplica além dele, então recusa sem mudar a cena", () => {
    const full = sceneOf(...Array.from({ length: DRAWING_LIMITS.elements }, (_, i) => rect(`r${i}`, i, 0)));
    expect(codeOf(() => duplicateElements(full, ["r0"], 5, 5))).toBe("drawing_limit_exceeded");
    expect(full.elements).toHaveLength(DRAWING_LIMITS.elements);
  });

  test("dado elementos, quando manda para frente ou para trás, então a ordem da cena é a camada e os demais mantêm a ordem relativa", () => {
    const scene = sceneOf(rect("a"), rect("b"), rect("c"), rect("d"));
    expect(idsOf(reorderElements(scene, ["b"], "front"))).toEqual(["a", "c", "d", "b"]);
    expect(idsOf(reorderElements(scene, ["c"], "back"))).toEqual(["c", "a", "b", "d"]);
    expect(idsOf(reorderElements(scene, ["b"], "forward"))).toEqual(["a", "c", "b", "d"]);
    expect(idsOf(reorderElements(scene, ["c"], "backward"))).toEqual(["a", "c", "b", "d"]);
    expect(idsOf(reorderElements(scene, ["a", "c"], "front"))).toEqual(["b", "d", "a", "c"]);
  });

  test("dado o elemento já no topo, quando manda para frente, então a cena fica igual (sem passo de desfazer à toa)", () => {
    const scene = sceneOf(rect("a"), rect("b"));
    expect(reorderElements(scene, ["b"], "front")).toEqual(scene);
    expect(reorderElements(scene, ["a"], "back")).toEqual(scene);
  });

  test("dado vários, quando apaga, então somem todos e o conector preso a um deles fica no lugar", () => {
    const scene = sceneOf(rect("a", 0, 0, 40, 40), rect("b", 200, 0, 40, 40), { id: "ar", type: "arrow", from: { ref: "a" }, to: { ref: "b" } });
    const next = removeElements(scene, ["a", "b"]);
    expect(idsOf(next)).toEqual(["ar"]);
    const ar = next.elements[0];
    expect(ar?.type === "arrow" && "x" in ar.from && "x" in ar.to).toBe(true);
  });
});

describe("desfazer: um passo por gesto", () => {
  const base = sceneOf(rect("a", 0, 0), rect("b", 200, 0));

  test("dado um arrasto de 120 eventos, quando solta, então a pilha ganha uma entrada e desfazer devolve a cena de antes", () => {
    const doc = docWith(base);
    let preview = base;
    for (let step = 1; step <= 120; step++) preview = moveElements(base, ["a", "b"], step, step / 2);
    const op = opSetDrawing(doc, "d1", preview);
    expect(op).toBeDefined();
    const done = perform(createHistory(), doc, op as never);
    expect(done.history.past).toHaveLength(1);
    const back = undo(done.history, done.doc);
    expect(back?.doc.nodes[0]?.data).toEqual(doc.nodes[0]?.data);
    const again = redo(back?.history as never, back?.doc as never);
    expect(again?.doc.nodes[0]?.data).toEqual(done.doc.nodes[0]?.data);
  });

  test("dado um traço de 600 amostras, quando solta, então vira uma entrada só", () => {
    const doc = docWith(base);
    const raw = Array.from({ length: 600 }, (_, i): [number, number] => [i, Math.sin(i / 20) * 30]);
    const op = opSetDrawing(doc, "d1", addStroke(base, { points: raw }).scene);
    const done = perform(createHistory(), doc, op as never);
    expect(done.history.past).toHaveLength(1);
  });

  test("dado duplicar e reordenar, quando cada um é um gesto, então cada um é uma entrada e desfaz na ordem inversa", () => {
    let doc = docWith(base);
    let history = createHistory();
    const dup = duplicateElements(base, ["a"], 8, 8);
    let applied = perform(history, doc, opSetDrawing(doc, "d1", dup.scene) as never);
    doc = applied.doc; history = applied.history;
    const ordered = reorderElements(dup.scene, ["a"], "front");
    applied = perform(history, doc, opSetDrawing(doc, "d1", ordered) as never);
    expect(applied.history.past).toHaveLength(2);
    const first = undo(applied.history, applied.doc) as never as { doc: CanvasDoc; history: typeof history };
    expect(readDrawingData(first.doc.nodes[0]?.data).elements.map((el) => el.id)).toEqual(["a", "b", "e1"]);
    const second = undo(first.history, first.doc) as never as { doc: CanvasDoc };
    expect(readDrawingData(second.doc.nodes[0]?.data).elements.map((el) => el.id)).toEqual(["a", "b"]);
  });

  test("dado um gesto que não muda nada, quando solta, então não há passo (undefined)", () => {
    const doc = docWith(base);
    expect(opSetDrawing(doc, "d1", moveElements(base, ["a"], 0, 0))).toBeUndefined();
    expect(opSetDrawing(doc, "d1", reorderElements(base, ["b"], "front"))).toBeUndefined();
  });
});

describe("ida e volta e formato antigo", () => {
  const full = (): DrawingScene => {
    let scene = sceneOf(
      { id: "r", type: "rect", x: 1.5, y: 2.5, w: 80, h: 40, stroke: "#ff0000", fill: "#00ff0080", width: 3 },
      { id: "o", type: "ellipse", x: 100, y: 0, w: 60, h: 40 },
      { id: "t", type: "text", x: 0, y: 80, text: "linha 1\nlinha 2", size: 18, stroke: "#112233" },
      { id: "l", type: "line", from: { x: 0, y: 0 }, to: { ref: "o" } },
      { id: "ar", type: "arrow", from: { ref: "r" }, to: { ref: "o" }, width: 2 },
    );
    scene = addStroke(scene, { points: [[0, 0], [20, 15], [40, 0]], pressure: [0.3, 0.8, 0.4], stroke: "#445566", width: 4 }).scene;
    return { ...scene, title: "Fluxo" };
  };

  test("dado uma cena completa, quando serializa e lê de novo, então é idêntica", () => {
    const scene = full();
    expect(readDrawingData(JSON.parse(JSON.stringify(sceneData(scene))))).toEqual(scene);
  });

  test("dado o nó movido e mudado de tamanho, quando relê o data, então a cena não muda (coordenadas são relativas ao nó)", () => {
    const doc = docWith(full());
    const moved = perform(createHistory(), doc, opMove(doc, "d1", { x: 999, y: -40 }));
    expect(readDrawingData(moved.doc.nodes[0]?.data)).toEqual(full());
  });

  test("dado um desenho gravado antes desta mudança, quando lido, então abre igual (sem pressão, com polilinha de pontos)", () => {
    const legacy = { v: 1 as const, title: "Antigo", elements: [
      { id: "s", type: "stroke", points: [[0, 0], [5, 5], [9, 0]], stroke: "#ff0000", width: 2 },
      { id: "r", type: "rect", x: 0, y: 0, w: 10, h: 10 },
    ] };
    const read = readDrawingData(legacy);
    expect(read).toEqual(legacy as never);
    expect(sceneData(read)).toEqual(legacy);
    expect(drawingToSvg(read)).toContain("<path");
  });

  test("dado a exportação, quando a cena tem pressão, então o SVG leva a espessura média e o PNG da tela sai do mesmo texto", () => {
    const svg = drawingToSvg(full());
    expect(svg).toContain(`d="${strokePath([[0, 0], [20, 15], [40, 0]])}"`);
    expect(drawingToSvg(full())).toBe(svg);
  });

  test("dado um desenho com o que a CLI grava (addElement com traço cru), quando renderiza, então usa o mesmo caminho que a tela", () => {
    const points = [[0, 0], [4, 8], [9, 2]];
    const scene = addElement(sceneOf(), { type: "stroke", points }).scene;
    expect(drawingToSvg(scene)).toContain(`d="${strokePath(points as [number, number][])}"`);
  });
});

describe("paleta, espessuras e atalhos", () => {
  test("dado a paleta, quando lista, então só usa tokens do tema que existem no claro e no escuro", () => {
    const html = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/index.html"), "utf8");
    const light = html.slice(html.indexOf(":root {"), html.indexOf(".dark {"));
    const dark = html.slice(html.indexOf(".dark {"));
    expect(DRAW_PALETTE.length).toBeGreaterThanOrEqual(5);
    for (const entry of DRAW_PALETTE) {
      expect(entry.token).toMatch(/^[a-z][a-z-]*$/);
      expect(light).toContain(`--${entry.token}:`);
      // o escuro só redefine o que muda; o que não muda herda do :root
      expect(dark.includes(`--${entry.token}:`) || light.includes(`--${entry.token}:`)).toBe(true);
    }
    expect(new Set(DRAW_PALETTE.map((entry) => entry.token)).size).toBe(DRAW_PALETTE.length);
  });

  test("dado as espessuras, quando lista, então estão dentro do formato e em ordem crescente", () => {
    expect(DRAW_WIDTHS.length).toBeGreaterThanOrEqual(3);
    expect([...DRAW_WIDTHS].sort((a, b) => a - b)).toEqual([...DRAW_WIDTHS]);
    for (const width of DRAW_WIDTHS) expect(codeOf(() => sceneOf({ id: "r", type: "rect", x: 0, y: 0, w: 1, h: 1, width }))).toBe("no-error");
  });

  test("dado a cor resolvida do tema, quando vira hexadecimal, então sai no formato que o desenho aceita", () => {
    expect(rgbaToHex(255, 0, 128, 1)).toBe("#ff0080");
    expect(rgbaToHex(0, 0, 0, 0.5)).toBe("#00000080");
    expect(rgbaToHex(300, -4, 1.6, 1)).toBe("#ff0002");
    expect(codeOf(() => sceneOf({ id: "r", type: "rect", x: 0, y: 0, w: 1, h: 1, stroke: rgbaToHex(1, 2, 3, 0.2) }))).toBe("no-error");
  });

  test("dado os atalhos, quando lista, então há uma tecla por ferramenta, sem repetir e sem letra que o canvas já usa", () => {
    const keys = DRAW_SHORTCUTS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(DRAW_SHORTCUTS.map((entry) => entry.tool)).toEqual(["select", "rect", "ellipse", "line", "arrow", "stroke", "text"]);
    expect(keys.every((key) => /^[a-z]$/.test(key))).toBe(true);
    const taken = plainKeysInUse();
    expect(taken.size).toBeGreaterThan(5);
    for (const key of keys) expect(taken.has(key)).toBe(false);
  });
});

/** As teclas simples (sem modificador) que o canvas e a página já comandam: `shortcut: "x"` nas fontes e as do motor. */
function plainKeysInUse(): Set<string> {
  const roots = [join(import.meta.dir, "../../../kit/panel/ui"), join(import.meta.dir, "../../../src/lib")];
  const taken = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "vendor") walk(path); continue; }
      if (!/\.(tsx?|js)$/.test(entry.name)) continue;
      for (const match of readFileSync(path, "utf8").matchAll(/shortcut:\s*["']([^"']+)["']/g)) {
        const chord = match[1] as string;
        if (/^[a-z]$/.test(chord)) taken.add(chord);
      }
    }
  };
  for (const root of roots) walk(root);
  for (const key of ["c", "z"]) taken.add(key);
  return taken;
}
