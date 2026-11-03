// Grupo canvas-draw: formas, setas e traço à mão (src/lib/canvas-draw.ts) — criação pela pilha de desfazer, simplificação
// com teto, caixa envolvente e hit-test. Lógica pura.
import { describe, expect, test } from "bun:test";
import { emptyCanvasDoc, validateCanvasDoc, type CanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, createHistory, perform, undo, redo } from "../../../src/lib/canvas-history";
import {
  createArrow, createShape, createStroke, DrawError, drawBounds, drawingAt, drawingsBounds, drawPoints, hitDrawing,
  simplifyStroke, STROKE_INPUT_MAX, STROKE_POINTS_MAX,
} from "../../../src/lib/canvas-draw";

const doc0 = (): CanvasDoc => emptyCanvasDoc();
const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof DrawError ? e.code : `outro:${String(e)}`; }
  return undefined;
};

describe("criação", () => {
  test("retângulo por dois cantos em qualquer direção vira um nó válido do documento", () => {
    const { node, op } = createShape(doc0(), "r1", "rect", { x: 100, y: 80 }, { x: 40, y: 20 });
    expect(node).toMatchObject({ type: "draw-rect", x: 40, y: 20, w: 60, h: 60 });
    expect(() => validateCanvasDoc(applyOp(doc0(), op))).not.toThrow();
  });

  test("arrasto sem área ganha tamanho mínimo 1", () => {
    const { node } = createShape(doc0(), "e1", "ellipse", { x: 5, y: 5 }, { x: 5, y: 5 });
    expect(node).toMatchObject({ type: "draw-ellipse", w: 1, h: 1 });
  });

  test("seta guarda os pontos normalizados e devolve as coordenadas do canvas", () => {
    const { node } = createArrow(doc0(), "a1", { x: 100, y: 0 }, { x: 0, y: 50 });
    expect(drawPoints(node)).toEqual([{ x: 100, y: 0 }, { x: 0, y: 50 }]);
  });

  test("mover o nó leva a seta junto", () => {
    const doc = applyOp(doc0(), createArrow(doc0(), "a1", { x: 0, y: 0 }, { x: 10, y: 10 }).op);
    const moved = { ...doc.nodes[0]!, x: 50, y: 60 };
    expect(drawPoints(moved)).toEqual([{ x: 50, y: 60 }, { x: 60, y: 70 }]);
  });

  test("camada nova fica acima das existentes", () => {
    let doc = applyOp(doc0(), createShape(doc0(), "a", "rect", { x: 0, y: 0 }, { x: 1, y: 1 }).op);
    const b = createShape(doc, "b", "rect", { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(b.node.z).toBe(doc.nodes[0]!.z + 1);
  });

  test("criar, desfazer e refazer voltam exatamente ao documento anterior", () => {
    const base = doc0();
    const { op } = createStroke(base, "s1", [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]);
    const done = perform(createHistory(), base, op);
    const back = undo(done.history, done.doc)!;
    expect(back.doc).toEqual(base);
    expect(redo(back.history, back.doc)!.doc).toEqual(done.doc);
  });

  test("recusa ponto inválido, cor inválida, espessura fora e id repetido ou inválido", () => {
    expect(codeOf(() => createShape(doc0(), "r", "rect", { x: NaN, y: 0 }, { x: 1, y: 1 }))).toBe("draw_invalid_point");
    expect(codeOf(() => createShape(doc0(), "r", "rect", { x: 1e9, y: 0 }, { x: 1, y: 1 }))).toBe("draw_invalid_point");
    expect(codeOf(() => createShape(doc0(), "r", "rect", { x: 0, y: 0 }, { x: 1, y: 1 }, { stroke: "red" }))).toBe("draw_invalid_style");
    expect(codeOf(() => createShape(doc0(), "r", "rect", { x: 0, y: 0 }, { x: 1, y: 1 }, { width: 0 }))).toBe("draw_invalid_style");
    expect(codeOf(() => createShape(doc0(), "r", "rect", { x: 0, y: 0 }, { x: 1, y: 1 }, { fill: "#12" }))).toBe("draw_invalid_style");
    expect(codeOf(() => createShape(doc0(), "a b", "rect", { x: 0, y: 0 }, { x: 1, y: 1 }))).toBe("draw_invalid_id");
    const doc = applyOp(doc0(), createShape(doc0(), "r", "rect", { x: 0, y: 0 }, { x: 1, y: 1 }).op);
    expect(codeOf(() => createShape(doc, "r", "rect", { x: 0, y: 0 }, { x: 1, y: 1 }))).toBe("draw_duplicate_id");
  });

  test("documento cheio recusa novo desenho", () => {
    const nodes = Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}`, type: "note", x: 0, y: 0, w: 1, h: 1, z: 0, data: {}, locked: false, blurred: false }));
    expect(codeOf(() => createShape({ ...doc0(), nodes }, "x", "rect", { x: 0, y: 0 }, { x: 1, y: 1 }))).toBe("draw_limit_exceeded");
  });
});

describe("traço à mão", () => {
  test("linha reta com muitos pontos se reduz às duas pontas", () => {
    const line = Array.from({ length: 100 }, (_, i) => ({ x: i, y: i }));
    expect(simplifyStroke(line)).toEqual([{ x: 0, y: 0 }, { x: 99, y: 99 }]);
  });

  test("curva mantém os vértices que fogem da tolerância", () => {
    const out = simplifyStroke([{ x: 0, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 0 }]);
    expect(out).toHaveLength(3);
  });

  test("tira pontos repetidos consecutivos e aceita um ponto só", () => {
    expect(simplifyStroke([{ x: 3, y: 3 }, { x: 3, y: 3 }])).toEqual([{ x: 3, y: 3 }]);
  });

  test("zigue-zague acima do teto é reamostrado ao teto, mantendo as pontas", () => {
    const zig = Array.from({ length: 5000 }, (_, i) => ({ x: i, y: i % 2 === 0 ? 0 : 100 }));
    const out = simplifyStroke(zig, 0);
    expect(out).toHaveLength(STROKE_POINTS_MAX);
    expect(out[0]).toEqual(zig[0]!);
    expect(out[out.length - 1]).toEqual(zig[zig.length - 1]!);
  });

  test("vazio, acima do teto de entrada, NaN e tolerância inválida são recusados", () => {
    expect(codeOf(() => simplifyStroke([]))).toBe("draw_empty_stroke");
    expect(codeOf(() => simplifyStroke(Array.from({ length: STROKE_INPUT_MAX + 1 }, () => ({ x: 0, y: 0 }))))).toBe("draw_limit_exceeded");
    expect(codeOf(() => simplifyStroke([{ x: 0, y: 0 }, { x: Infinity, y: 0 }]))).toBe("draw_invalid_point");
    expect(codeOf(() => simplifyStroke([{ x: 0, y: 0 }], -1))).toBe("draw_invalid_style");
  });

  test("entrada no teto roda em tempo curto", () => {
    const wave = Array.from({ length: STROKE_INPUT_MAX }, (_, i) => ({ x: i, y: Math.sin(i / 7) * 50 }));
    // tempo de CPU, não de relógio: com a suíte em paralelo o processo espera a vez e o relógio mede a fila
    const t = process.cpuUsage();
    simplifyStroke(wave);
    const used = process.cpuUsage(t);
    // o teto pega a explosão quadrática; o linear mede ~0,5 s de CPU nesta faixa e passa de 1 s com a suíte em paralelo
    expect((used.user + used.system) / 1000).toBeLessThan(2500);
  });

  test("traço criado é um nó válido e os pontos voltam às coordenadas originais", () => {
    const pts = [{ x: 10, y: 10 }, { x: 60, y: 90 }, { x: 110, y: 10 }];
    const { node, op } = createStroke(doc0(), "s", pts);
    expect(() => validateCanvasDoc(applyOp(doc0(), op))).not.toThrow();
    const back = drawPoints(node);
    pts.forEach((p, i) => { expect(back[i]!.x).toBeCloseTo(p.x); expect(back[i]!.y).toBeCloseTo(p.y); });
  });
});

describe("caixa envolvente", () => {
  test("caixa do desenho e de vários desenhos; nó que não é desenho fica de fora", () => {
    let doc = applyOp(doc0(), createShape(doc0(), "a", "rect", { x: 0, y: 0 }, { x: 10, y: 10 }).op);
    doc = applyOp(doc, createShape(doc, "b", "ellipse", { x: 50, y: 50 }, { x: 70, y: 90 }).op);
    expect(drawBounds(doc.nodes[0]!)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(drawingsBounds(doc.nodes)).toEqual({ x: 0, y: 0, w: 70, h: 90 });
    expect(drawingsBounds([])).toBeUndefined();
    const note = { ...doc.nodes[0]!, type: "note" };
    expect(drawingsBounds([note])).toBeUndefined();
    expect(codeOf(() => drawBounds(note))).toBe("draw_not_drawing");
  });
});

describe("hit-test", () => {
  const make = (shape: "rect" | "ellipse", style?: { fill: string }) => createShape(doc0(), "s", shape, { x: 0, y: 0 }, { x: 100, y: 100 }, style).node;

  test("retângulo vazio acerta a borda e não o miolo; com preenchimento acerta o miolo", () => {
    expect(hitDrawing(make("rect"), { x: 0, y: 50 })).toBe(true);
    expect(hitDrawing(make("rect"), { x: 50, y: 50 })).toBe(false);
    expect(hitDrawing(make("rect", { fill: "#fff" }), { x: 50, y: 50 })).toBe(true);
    expect(hitDrawing(make("rect"), { x: 120, y: 50 })).toBe(false);
  });

  test("elipse vazia acerta o contorno; cheia acerta o interior; o canto da caixa fica fora", () => {
    expect(hitDrawing(make("ellipse"), { x: 100, y: 50 })).toBe(true);
    expect(hitDrawing(make("ellipse"), { x: 50, y: 50 })).toBe(false);
    expect(hitDrawing(make("ellipse", { fill: "#fff" }), { x: 50, y: 50 })).toBe(true);
    expect(hitDrawing(make("ellipse", { fill: "#fff" }), { x: 2, y: 2 })).toBe(false);
  });

  test("seta e traço acertam perto da linha, com a tolerância pedida", () => {
    const arrow = createArrow(doc0(), "a", { x: 0, y: 0 }, { x: 100, y: 0 }).node;
    expect(hitDrawing(arrow, { x: 50, y: 3 })).toBe(true);
    expect(hitDrawing(arrow, { x: 50, y: 10 })).toBe(false);
    expect(hitDrawing(arrow, { x: 50, y: 10 }, 12)).toBe(true);
    const dot = createStroke(doc0(), "d", [{ x: 5, y: 5 }]).node;
    expect(hitDrawing(dot, { x: 5, y: 7 })).toBe(true);
  });

  test("dado corrompido no data não acerta nada e ponto não finito também não", () => {
    const arrow = { ...createArrow(doc0(), "a", { x: 0, y: 0 }, { x: 10, y: 10 }).node, data: { from: "x" } };
    expect(drawPoints(arrow)).toEqual([]);
    expect(hitDrawing(arrow, { x: 0, y: 0 })).toBe(false);
    expect(hitDrawing(make("rect"), { x: NaN, y: 0 })).toBe(false);
  });

  test("drawingAt devolve o desenho do topo e ignora nós que não são desenho", () => {
    let doc = applyOp(doc0(), createShape(doc0(), "baixo", "rect", { x: 0, y: 0 }, { x: 100, y: 100 }, { fill: "#fff" }).op);
    doc = applyOp(doc, createShape(doc, "cima", "rect", { x: 0, y: 0 }, { x: 100, y: 100 }, { fill: "#000" }).op);
    expect(drawingAt(doc, { x: 50, y: 50 })?.id).toBe("cima");
    expect(drawingAt(doc, { x: 500, y: 500 })).toBeUndefined();
    expect(drawingAt(emptyCanvasDoc(), { x: 0, y: 0 })).toBeUndefined();
  });
});
