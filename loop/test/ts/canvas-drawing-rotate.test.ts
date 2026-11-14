// Grupo canvas-drawing-rotate: girar, guias de alinhamento e conectores presos (src/lib/canvas-drawing.ts). Lógica pura.
import { describe, expect, test } from "bun:test";
import {
  anchorTarget, connectorEnds, describeDrawing, DrawingError, drawingToSvg, duplicateElements, elementBox, moveConnectorEnd, moveElements,
  normalizeAngle, readDrawingData, rotateElements, rotationDelta, rotatePoint, rotateTransform, scaleElements, snapMove, snapResize,
  SNAP_THRESHOLD, type ConnectorElement, type DrawingScene,
} from "../../../src/lib/canvas-drawing";

const sceneOf = (...elements: Record<string, unknown>[]): DrawingScene => readDrawingData({ v: 1, elements });
const rect = (id: string, x = 0, y = 0, w = 100, h = 50, extra: Record<string, unknown> = {}) => ({ id, type: "rect", x, y, w, h, ...extra });
const near = (a: number, b: number, digits = 1): void => expect(a).toBeCloseTo(b, digits);
const codeOf = (run: () => unknown): string => {
  try { run(); } catch (error) { if (error instanceof DrawingError) return error.code; throw error; }
  return "no-error";
};
const connector = (scene: DrawingScene, id: string): ConnectorElement => scene.elements.find((el) => el.id === id) as ConnectorElement;

describe("girar", () => {
  test("dado um retângulo, quando gira 90° em torno do centro, então grava o ângulo e o centro não anda", () => {
    const out = rotateElements(sceneOf(rect("a")), ["a"], 90);
    expect(out.elements[0]).toMatchObject({ id: "a", x: 0, y: 0, w: 100, h: 50, rotation: 90 });
  });

  test("dado desenho antigo sem ângulo, então abre igual e volta igual (ida e volta)", () => {
    const old = { v: 1, elements: [rect("a")] };
    expect(JSON.parse(JSON.stringify(readDrawingData(old)))).toEqual(old);
    const turned = readDrawingData(JSON.parse(JSON.stringify(rotateElements(readDrawingData(old), ["a"], 30))));
    expect(turned.elements[0]).toMatchObject({ rotation: 30 });
  });

  test("dado giro completo, então o ângulo some do elemento", () => {
    const out = rotateElements(rotateElements(sceneOf(rect("a")), ["a"], 200), ["a"], 160);
    expect("rotation" in (out.elements[0] as object)).toBe(false);
  });

  test("dado ângulo negativo, então normaliza para [0, 360)", () => {
    expect(normalizeAngle(-30)).toBe(330);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(725)).toBe(5);
  });

  test("dado um conjunto, quando gira 90°, então as posições giram em torno do centro da seleção", () => {
    const scene = sceneOf(rect("a", 0, 0, 20, 20), rect("b", 80, 0, 20, 20));
    const out = rotateElements(scene, ["a", "b"], 90);
    const a = out.elements[0] as { x: number; y: number; rotation?: number };
    const b = out.elements[1] as { x: number; y: number; rotation?: number };
    near(a.x + 10, 50); near(a.y + 10, -30);
    expect(a.rotation).toBe(90);
    near(b.x + 10, 50); near(b.y + 10, 50);
  });

  test("dado traço, então gira os pontos (não há campo de ângulo)", () => {
    const scene = sceneOf({ id: "s", type: "stroke", points: [[0, 0], [10, 0]] });
    const out = rotateElements(scene, ["s"], 90, { x: 0, y: 0 });
    const stroke = out.elements[0] as { points: [number, number][] };
    near(stroke.points[1]?.[0] ?? NaN, 0); near(stroke.points[1]?.[1] ?? NaN, 10);
    expect("rotation" in (out.elements[0] as object)).toBe(false);
  });

  test("dado texto, então guarda o ângulo e a caixa que o envolve cresce no giro de 45°", () => {
    const scene = sceneOf({ id: "t", type: "text", x: 0, y: 0, text: "abcdef" });
    const out = rotateElements(scene, ["t"], 45);
    expect(out.elements[0]).toMatchObject({ rotation: 45 });
    expect(elementBox(out, out.elements[0] as never).w).toBeGreaterThan(elementBox(scene, scene.elements[0] as never).h);
  });

  test("dado elipse girada 90°, então a caixa envolvente troca largura e altura", () => {
    const scene = sceneOf({ id: "e", type: "ellipse", x: 0, y: 0, w: 100, h: 40 });
    const box = elementBox(rotateElements(scene, ["e"], 90), rotateElements(scene, ["e"], 90).elements[0] as never);
    near(box.w, 40); near(box.h, 100);
  });

  test("dado ângulo ou id inválido, então falha com o código estável", () => {
    expect(codeOf(() => rotateElements(sceneOf(rect("a")), ["a"], Number.NaN))).toBe("drawing_invalid_element");
    expect(codeOf(() => rotateElements(sceneOf(rect("a")), ["zz"], 10))).toBe("drawing_missing_element");
    expect(codeOf(() => readDrawingData({ v: 1, elements: [rect("a", 0, 0, 10, 10, { rotation: 360 })] }))).toBe("drawing_invalid_element");
    expect(codeOf(() => readDrawingData({ v: 1, elements: [rect("a", 0, 0, 10, 10, { rotation: "90" })] }))).toBe("drawing_invalid_element");
  });

  test("dado Shift (passo de 15°), então o ângulo final trava no múltiplo, contando o ângulo atual", () => {
    const pivot = { x: 0, y: 0 };
    const to = { x: Math.cos(0.3), y: Math.sin(0.3) };
    const free = rotationDelta(pivot, { x: 1, y: 0 }, to);
    near(free, 17.19, 1);
    expect(rotationDelta(pivot, { x: 1, y: 0 }, to, 0, 15)).toBe(15);
    expect(rotationDelta(pivot, { x: 1, y: 0 }, to, 10, 15)).toBe(20); // 10 + 17,19 = 27,19 trava em 30
  });

  test("dado escala de elemento girado, então o centro escala e os lados seguem a projeção dos fatores", () => {
    const scene = sceneOf(rect("a", 0, 0, 100, 50, { rotation: 90 }));
    const out = scaleElements(scene, ["a"], { x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 200, h: 100 });
    const el = out.elements[0] as { w: number; h: number; rotation?: number };
    // girado 90°, o lado "w" aponta para baixo: o fator vertical (1) o governa; o lado "h" aponta na horizontal (fator 2)
    near(el.w, 100); near(el.h, 100);
    expect(el.rotation).toBe(90);
  });

  test("dado duplicar elemento girado, então a cópia guarda o mesmo ângulo", () => {
    const out = duplicateElements(sceneOf(rect("a", 0, 0, 10, 10, { rotation: 20 })), ["a"], 5, 5);
    expect(out.scene.elements[1]).toMatchObject({ rotation: 20, x: 5, y: 5 });
  });

  test("dado SVG da CLI, então o elemento girado leva o mesmo transform que a tela", () => {
    const scene = sceneOf(rect("a", 0, 0, 100, 50, { rotation: 30 }), { id: "t", type: "text", x: 0, y: 0, text: "x", rotation: 10 });
    const svg = drawingToSvg(scene);
    expect(svg).toContain(`transform="${rotateTransform(scene.elements[0] as never)}"`);
    expect(svg).toContain(`rotate(30 50 25)`);
    expect(svg).toContain(`transform="${rotateTransform(scene.elements[1] as never)}"`);
    expect(drawingToSvg(sceneOf(rect("a")))).not.toContain("transform");
    expect(describeDrawing(scene).elements[0]?.rotation).toBe(30);
  });

  test("dado rotatePoint, então gira no sentido horário com o eixo y para baixo", () => {
    const p = rotatePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, 90);
    near(p.x, 0); near(p.y, 1);
  });
});

describe("guias de alinhamento", () => {
  const scene = sceneOf(rect("a", 0, 0, 100, 50), rect("b", 200, 100, 60, 60));

  test("dado mover perto da borda de outro elemento, então encaixa e devolve a linha-guia", () => {
    const out = snapMove(scene, ["a"], 198, 3);
    expect(out.dx).toBe(200);
    expect(out.guides.some((g) => g.axis === "x" && g.at === 200)).toBe(true);
  });

  test("dado mover longe de tudo, então não encaixa nem desenha guia", () => {
    const out = snapMove(scene, ["a"], 40, 300);
    expect(out).toEqual({ dx: 40, dy: 300, guides: [] });
  });

  test("dado a borda direita perto do centro do outro, então encaixa no centro dele", () => {
    const out = snapMove(scene, ["a"], 132, 40);
    expect(out.dx).toBe(130);
    expect(out.guides.some((g) => g.axis === "x" && g.at === 230)).toBe(true);
  });

  test("dado limiar, então a distância exata no limite encaixa e um pouco além não", () => {
    expect(snapMove(scene, ["a"], 100 - SNAP_THRESHOLD, 500).dx).toBe(100);
    expect(snapMove(scene, ["a"], 100 - SNAP_THRESHOLD - 0.5, 500).dx).toBe(100 - SNAP_THRESHOLD - 0.5);
  });

  test("dado o próprio elemento arrastado, então ele não serve de alvo de si mesmo", () => {
    expect(snapMove(sceneOf(rect("a")), ["a"], 3, 3)).toEqual({ dx: 3, dy: 3, guides: [] });
  });

  test("dado redimensionar pela alça leste, então só a borda direita encaixa", () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    const out = snapResize(scene, ["a"], box, "e", 97, 0);
    expect(out.dx).toBe(100);
    expect(out.dy).toBe(0);
    expect(out.guides.some((g) => g.axis === "x" && g.at === 200)).toBe(true);
  });

  test("dado conector no desenho, então a caixa dele não vira alvo", () => {
    const withLine = sceneOf(rect("a"), { id: "l", type: "line", from: { x: 500, y: 500 }, to: { x: 600, y: 600 } });
    expect(snapMove(withLine, ["a"], 497, 497).guides).toEqual([]);
  });
});

describe("conectores presos", () => {
  const base = () => sceneOf(rect("a", 0, 0, 100, 50), rect("b", 300, 0, 100, 50), { id: "c", type: "arrow", from: { ref: "a" }, to: { ref: "b" } });

  test("dado mover o alvo, então a ponta acompanha", () => {
    const out = moveElements(base(), ["b"], 0, 100);
    const [, end] = connectorEnds(out, connector(out, "c"));
    expect(end.y).toBeGreaterThan(25);
  });

  test("dado redimensionar o alvo, então a ponta continua na borda dele", () => {
    const out = scaleElements(base(), ["b"], { x: 300, y: 0, w: 100, h: 50 }, { x: 300, y: 0, w: 200, h: 50 });
    expect(connector(out, "c").to).toEqual({ ref: "b" });
    const [, end] = connectorEnds(out, connector(out, "c"));
    near(end.x, 300);
  });

  test("dado girar o alvo, então a ponta presa fica na borda do elemento girado", () => {
    const out = rotateElements(base(), ["b"], 90, { x: 350, y: 25 });
    expect(connector(out, "c").to).toEqual({ ref: "b" });
    const [, end] = connectorEnds(out, connector(out, "c"));
    // girado 90°: a face voltada para a esquerda fica a 25 do centro (350), não a 50
    near(end.x, 325, 0);
  });

  test("dado soltar a ponta sobre um elemento, então prende; longe, então desancora no ponto", () => {
    const attached = moveConnectorEnd(sceneOf(rect("a"), rect("b", 300, 0), { id: "c", type: "line", from: { x: 500, y: 500 }, to: { x: 600, y: 600 } }), "c", "to", { x: 320, y: 20 });
    expect(connector(attached, "c").to).toEqual({ ref: "b" });
    const away = moveConnectorEnd(attached, "c", "to", { x: 700, y: 700 });
    expect(connector(away, "c").to).toEqual({ x: 700, y: 700 });
  });

  test("dado soltar a ponta sobre outro conector ou traço, então não prende", () => {
    const scene = sceneOf(rect("a"), { id: "s", type: "stroke", points: [[300, 300], [350, 350]] }, { id: "c", type: "line", from: { ref: "a" }, to: { x: 5, y: 5 } });
    expect(anchorTarget(scene, { x: 320, y: 320 })).toBeUndefined();
    expect(codeOf(() => moveConnectorEnd(scene, "a", "to", { x: 1, y: 1 }))).toBe("drawing_invalid_connector");
    expect(codeOf(() => moveConnectorEnd(scene, "zz", "to", { x: 1, y: 1 }))).toBe("drawing_missing_element");
  });

  test("dado elemento girado, então o ponto é testado no quadro do próprio elemento", () => {
    const scene = sceneOf(rect("a", 0, 0, 100, 20, { rotation: 90 }));
    expect(anchorTarget(scene, { x: 50, y: 40 })).toBe("a");
    expect(anchorTarget(scene, { x: 95, y: 10 })).toBeUndefined();
  });

  test("dado ida e volta da cena com conector preso a elemento girado, então é idêntica", () => {
    const scene = rotateElements(base(), ["b"], 33);
    expect(readDrawingData(JSON.parse(JSON.stringify(scene)))).toEqual(scene);
  });
});
