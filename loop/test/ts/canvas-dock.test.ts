// Grupo canvas-dock: elevar e acoplar (src/lib/canvas-dock.ts) — estado imutável, limites, posições na tela e leitura de
// estado guardado. Lógica pura.
import { describe, expect, test } from "bun:test";
import { type CanvasDoc, type CanvasNode, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { dockEdgeAt, dockNode, DOCK_LIMITS, elevate, emptyDock, layoutDock, parseDock, reconcileDock, release, resizeColumn, toggleElevated, undock } from "../../../src/lib/canvas-dock";
import { ORG_ERRORS, OrgError } from "../../../src/lib/canvas-groups";

const node = (id: string): CanvasNode => ({ id, type: "note", x: 0, y: 0, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false });
const doc = (): CanvasDoc => validateCanvasDoc({ v: 1, rev: 1, nodes: ["a", "b", "c", "d", "e"].map(node), edges: [], groups: [] });
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof OrgError ? error.code : "outro-erro";
  }
  return "não lançou";
};
const view = { w: 1000, h: 600 };

describe("elevar", () => {
  test("dado um nó, então eleva, baixa e alterna sem mutar o estado antigo", () => {
    const start = emptyDock();
    const up = elevate(start, doc(), "a");
    expect(up.elevated).toBe("a");
    expect(start.elevated).toBeNull();
    expect(toggleElevated(up, doc(), "a").elevated).toBeNull();
    expect(toggleElevated(up, doc(), "b").elevated).toBe("b");
    expect(release(start)).toBe(start);
  });
  test("dado nó acoplado, então elevar tira da coluna", () => {
    const docked = dockNode(emptyDock(), doc(), "a", "left");
    expect(elevate(docked, doc(), "a")).toEqual({ elevated: "a", columns: [] });
  });
  test("dado nó inexistente, então org_unknown_node", () => {
    expect(code(() => elevate(emptyDock(), doc(), "zz"))).toBe(ORG_ERRORS.unknownNode);
  });
});

describe("acoplar", () => {
  test("dado nó, então vira coluna com a largura padrão e muda de borda sem duplicar", () => {
    const left = dockNode(emptyDock(), doc(), "a", "left");
    expect(left.columns).toEqual([{ id: "a", edge: "left", width: DOCK_LIMITS.defaultWidth }]);
    expect(dockNode(left, doc(), "a", "right", 200).columns).toEqual([{ id: "a", edge: "right", width: 200 }]);
    expect(dockNode(left, doc(), "a", "right").columns[0]?.width).toBe(DOCK_LIMITS.defaultWidth);
  });
  test("dado nó elevado, então acoplar baixa o painel", () => {
    expect(dockNode(elevate(emptyDock(), doc(), "a"), doc(), "a", "left").elevated).toBeNull();
    expect(dockNode(elevate(emptyDock(), doc(), "a"), doc(), "b", "left").elevated).toBe("a");
  });
  test("dado a borda cheia, então org_limit_exceeded; a outra borda segue livre", () => {
    let state = emptyDock();
    for (const id of ["a", "b", "c"]) state = dockNode(state, doc(), id, "left");
    expect(code(() => dockNode(state, doc(), "d", "left"))).toBe(ORG_ERRORS.limitExceeded);
    expect(dockNode(state, doc(), "d", "right").columns).toHaveLength(4);
  });
  test("dado borda ou largura inválidas, então erros de código estável", () => {
    expect(code(() => dockNode(emptyDock(), doc(), "a", "top"))).toBe(ORG_ERRORS.invalidMode);
    for (const width of [Number.NaN, 10, 5000, Number.POSITIVE_INFINITY]) expect(code(() => dockNode(emptyDock(), doc(), "a", "left", width))).toBe(ORG_ERRORS.invalidNumber);
  });
  test("dado coluna, então undock, resize e reconcile funcionam e erram no limite", () => {
    const state = dockNode(dockNode(emptyDock(), doc(), "a", "left"), doc(), "b", "right");
    expect(undock(state, "a").columns.map((c) => c.id)).toEqual(["b"]);
    expect(undock(state, "zz")).toBe(state);
    expect(resizeColumn(state, "b", 400).columns[1]?.width).toBe(400);
    expect(code(() => resizeColumn(state, "zz", 400))).toBe(ORG_ERRORS.unknownNode);
    expect(code(() => resizeColumn(state, "b", 1))).toBe(ORG_ERRORS.invalidNumber);
    const smaller = validateCanvasDoc({ ...doc(), nodes: doc().nodes.filter((n) => n.id !== "a") });
    expect(reconcileDock(state, smaller).columns.map((c) => c.id)).toEqual(["b"]);
    expect(reconcileDock(state, doc())).toBe(state);
    expect(reconcileDock(elevate(state, doc(), "c"), validateCanvasDoc({ ...doc(), nodes: [node("b")] })).elevated).toBeNull();
  });
});

describe("posição na tela", () => {
  test("dado um ponto, então a borda só vale dentro da faixa e da tela", () => {
    expect(dockEdgeAt({ x: 10, y: 100 }, view)).toBe("left");
    expect(dockEdgeAt({ x: 990, y: 100 }, view)).toBe("right");
    expect(dockEdgeAt({ x: 500, y: 100 }, view)).toBeUndefined();
    expect(dockEdgeAt({ x: -5, y: 100 }, view)).toBeUndefined();
    expect(code(() => dockEdgeAt({ x: Number.NaN, y: 0 }, view))).toBe(ORG_ERRORS.invalidNumber);
    expect(code(() => dockEdgeAt({ x: 1, y: 0 }, { w: 0, h: 10 }))).toBe(ORG_ERRORS.invalidNumber);
  });
  test("dado colunas nas duas bordas, então o canvas fica entre elas e o painel elevado no centro", () => {
    let state = dockNode(emptyDock(), doc(), "a", "left", 200);
    state = dockNode(state, doc(), "b", "right", 300);
    state = elevate(state, doc(), "c");
    const layout = layoutDock(state, view);
    expect(layout.columns.map((c) => c.frame)).toEqual([{ x: 0, y: 0, w: 200, h: 600 }, { x: 700, y: 0, w: 300, h: 600 }]);
    expect(layout.canvas).toEqual({ x: 200, y: 0, w: 500, h: 600 });
    const frame = layout.elevated!.frame;
    expect([frame.x, frame.y, frame.w, frame.h].map(Math.round)).toEqual([250, 60, 400, 480]);
  });
  test("dado colunas largas demais, então as últimas são recortadas ou omitidas e o canvas nunca é negativo", () => {
    let state = emptyDock();
    for (const id of ["a", "b", "c"]) state = dockNode(state, doc(), id, "left", 400);
    const layout = layoutDock(state, view);
    expect(layout.columns.map((c) => c.frame.w)).toEqual([400, 200]);
    expect(layout.canvas.w).toBe(400);
    expect(layout.canvas.w).toBeGreaterThan(0);
    expect(layoutDock(emptyDock(), view)).toEqual({ columns: [], canvas: { x: 0, y: 0, w: 1000, h: 600 }, elevated: null });
  });
});

describe("parseDock", () => {
  test("dado estado guardado válido, então ida e volta por JSON", () => {
    const state = elevate(dockNode(emptyDock(), doc(), "a", "left", 240), doc(), "b");
    expect(parseDock(JSON.parse(JSON.stringify(state)), doc())).toEqual(state);
  });
  test("dado estado corrompido, então org_invalid_mode ou o erro do campo", () => {
    for (const raw of [null, [], { elevated: 3, columns: [] }, { elevated: null, columns: [{ id: "a", edge: "left" }] }, { elevated: null, columns: [{ id: "a", edge: "left", width: 200 }, { id: "a", edge: "left", width: 200 }] }]) {
      expect(code(() => parseDock(raw, doc()))).toBe(ORG_ERRORS.invalidMode);
    }
    expect(code(() => parseDock({ elevated: null, columns: [{ id: "zz", edge: "left", width: 200 }] }, doc()))).toBe(ORG_ERRORS.unknownNode);
    expect(code(() => parseDock({ elevated: null, columns: [{ id: "a", edge: "left", width: 1 }] }, doc()))).toBe(ORG_ERRORS.invalidNumber);
  });
});
