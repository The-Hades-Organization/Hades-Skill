// Grupo canvas-desenho-cardinal (U16): o nó `cardinal` que a ferramenta Desenho cria com o motor `cardinal` (caixa do
// retângulo solto) e a garantia de que criá-lo não toca os nós `drawing` já guardados no documento.
import { describe, expect, test } from "bun:test";
import { CARDINAL_FRAME, CARDINAL_TYPE, createCardinalNode } from "../../../src/lib/canvas-cardinal";
import { type CanvasDoc, emptyCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp } from "../../../src/lib/canvas-history";
import { createDrawingNode, DRAWING_TYPE } from "../../../src/lib/canvas-drawing";

const withDrawing = (): CanvasDoc => {
  const { op } = createDrawingNode(emptyCanvasDoc(), { id: "drawing-1", x: 10, y: 20, w: 300, h: 200 });
  return applyOp(emptyCanvasDoc(), op);
};

describe("createCardinalNode com caixa própria", () => {
  test("dado w e h, então o nó nasce com a caixa do retângulo; sem eles vale a moldura da CLI", () => {
    const sized = createCardinalNode(emptyCanvasDoc(), { id: "cardinal-1", name: "desenho", title: "Desenho", x: 5, y: 6, w: 320, h: 180 });
    expect(sized.node).toMatchObject({ type: CARDINAL_TYPE, x: 5, y: 6, w: 320, h: 180, data: { cardinal: "desenho", title: "Desenho" } });
    const framed = createCardinalNode(emptyCanvasDoc(), { id: "cardinal-2", name: "outro", x: 0, y: 0 });
    expect(framed.node).toMatchObject({ w: CARDINAL_FRAME.w, h: CARDINAL_FRAME.h });
  });
});

describe("nós drawing existentes com o motor cardinal", () => {
  test("dado documento com um drawing, então criar o nó cardinal só acrescenta e deixa o drawing igual", () => {
    const before = withDrawing();
    const snapshot = structuredClone(before);
    const { op } = createCardinalNode(before, { id: "cardinal-1", name: "desenho", title: "Desenho", x: 400, y: 0, w: 320, h: 180 });
    expect(before).toEqual(snapshot);
    const after = applyOp(before, op);
    expect(after.nodes.map((n) => n.type).sort()).toEqual([CARDINAL_TYPE, DRAWING_TYPE].sort());
    expect(after.nodes.find((n) => n.id === "drawing-1")).toEqual(before.nodes.find((n) => n.id === "drawing-1"));
  });
});
