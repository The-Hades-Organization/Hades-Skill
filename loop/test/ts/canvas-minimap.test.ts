// Grupo canvas-minimap: projeção do canvas e do viewport no minimapa, e câmera a partir de um clique
// (src/lib/canvas-minimap.ts). Lógica pura.
import { describe, expect, test } from "bun:test";
import { type Camera, type Rect, visibleRect } from "../../../src/lib/canvas-camera";
import { MINIMAP_LIMITS, minimapCamera, minimapToWorld, minimapView, projectMinimap, worldToMinimap } from "../../../src/lib/canvas-minimap";

const VIEW = { w: 800, h: 600 };
const SIZE = { w: 200, h: 150 };
const CAM: Camera = { x: 0, y: 0, k: 1 };
const r = (x: number, y: number, w = 100, h = 50): Rect => ({ x, y, w, h });

describe("minimapView", () => {
  test("dado nenhum nó, o quadro mostra só o viewport, centralizado", () => {
    const v = minimapView([], CAM, VIEW, SIZE);
    expect(v.nodes).toEqual([]);
    expect(v.viewport.x + v.viewport.w / 2).toBeCloseTo(SIZE.w / 2);
    expect(v.viewport.y + v.viewport.h / 2).toBeCloseTo(SIZE.h / 2);
  });

  test("um retângulo por nó, na ordem de entrada", () => {
    const rects = [r(0, 0), r(2000, 1000), r(500, 500)];
    const v = minimapView(rects, CAM, VIEW, SIZE);
    expect(v.nodes).toHaveLength(3);
    expect(v.nodes[1]!.x).toBeGreaterThan(v.nodes[2]!.x);
  });

  test("tudo cabe no quadro: nós e viewport ficam dentro do tamanho", () => {
    const v = minimapView([r(-3000, -2000), r(5000, 4000)], { x: 100, y: 100, k: 0.5 }, VIEW, SIZE);
    for (const box of [...v.nodes, v.viewport]) {
      expect(box.x).toBeGreaterThanOrEqual(-1e-6);
      expect(box.y).toBeGreaterThanOrEqual(-1e-6);
      expect(box.x + box.w).toBeLessThanOrEqual(SIZE.w + 1e-6);
      expect(box.y + box.h).toBeLessThanOrEqual(SIZE.h + 1e-6);
    }
  });

  test("viewport longe do conteúdo ainda entra no quadro", () => {
    const v = minimapView([r(0, 0)], { x: 9000, y: 9000, k: 1 }, VIEW, SIZE);
    expect(v.viewport.x + v.viewport.w).toBeLessThanOrEqual(SIZE.w + 1e-6);
  });

  test("nó minúsculo ganha o lado mínimo para não sumir", () => {
    const v = minimapView([r(0, 0, 1, 1), r(10000, 10000)], CAM, VIEW, SIZE);
    expect(v.nodes[0]!.w).toBeGreaterThanOrEqual(MINIMAP_LIMITS.minNodePx);
    expect(v.nodes[0]!.h).toBeGreaterThanOrEqual(MINIMAP_LIMITS.minNodePx);
  });

  test("o teto de nós passa e um acima dele é recusado", () => {
    const ok = Array.from({ length: MINIMAP_LIMITS.maxNodes }, (_, i) => r(i * 10, 0, 5, 5));
    expect(minimapView(ok, CAM, VIEW, SIZE).nodes).toHaveLength(MINIMAP_LIMITS.maxNodes);
    expect(() => minimapView([...ok, r(0, 0)], CAM, VIEW, SIZE)).toThrow(RangeError);
  });

  test("entrada inválida é recusada com RangeError", () => {
    expect(() => minimapView([], CAM, VIEW, { w: 0, h: 10 })).toThrow(RangeError);
    expect(() => minimapView([], CAM, { w: NaN, h: 10 }, SIZE)).toThrow(RangeError);
    expect(() => minimapView([], { x: 0, y: 0, k: 0 }, VIEW, SIZE)).toThrow(RangeError);
    expect(() => minimapView([r(NaN, 0)], CAM, VIEW, SIZE)).toThrow(RangeError);
    expect(() => minimapView([r(0, 0, -1, 5)], CAM, VIEW, SIZE)).toThrow(RangeError);
  });
});

describe("conversões", () => {
  test("mundo → minimapa → mundo volta ao mesmo ponto", () => {
    const p = projectMinimap([r(-500, -500), r(3000, 2000)], CAM, VIEW, SIZE);
    const back = minimapToWorld(p, worldToMinimap(p, { x: 1234, y: 567 }));
    expect(back.x).toBeCloseTo(1234);
    expect(back.y).toBeCloseTo(567);
  });
});

describe("minimapCamera", () => {
  const p = projectMinimap([r(0, 0), r(4000, 3000)], CAM, VIEW, SIZE);

  test("clique centraliza o viewport no ponto do mundo e mantém o zoom", () => {
    const cam: Camera = { x: 0, y: 0, k: 2 };
    const proj = projectMinimap([r(0, 0), r(4000, 3000)], cam, VIEW, SIZE);
    const target = worldToMinimap(proj, { x: 2000, y: 1500 });
    const next = minimapCamera(proj, target, cam, VIEW);
    expect(next.k).toBe(2);
    const vis = visibleRect(next, VIEW);
    expect(vis.x + vis.w / 2).toBeCloseTo(2000);
    expect(vis.y + vis.h / 2).toBeCloseTo(1500);
  });

  test("clicar no centro do viewport atual não move a câmera", () => {
    const vis = visibleRect(CAM, VIEW);
    const at = worldToMinimap(p, { x: vis.x + vis.w / 2, y: vis.y + vis.h / 2 });
    const next = minimapCamera(p, at, CAM, VIEW);
    expect(next.x).toBeCloseTo(CAM.x);
    expect(next.y).toBeCloseTo(CAM.y);
  });

  test("ponto fora do quadro vai à borda, igual ao ponto na borda", () => {
    const out = minimapCamera(p, { x: -500, y: 9999 }, CAM, VIEW);
    const edge = minimapCamera(p, { x: 0, y: SIZE.h }, CAM, VIEW);
    expect(out).toEqual(edge);
  });

  test("ponto não finito é recusado", () => {
    expect(() => minimapCamera(p, { x: NaN, y: 0 }, CAM, VIEW)).toThrow(RangeError);
    expect(() => minimapCamera(p, { x: 0, y: Infinity }, CAM, VIEW)).toThrow(RangeError);
  });
});
