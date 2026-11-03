// Grupo canvas-snap: encaixe magnético do arrasto (src/lib/canvas-snap.ts) — paredes, centros e vãos iguais, limiar em
// pixels de tela, guias devolvidas e o arrasto de uma seleção do documento. Lógica pura.
import { describe, expect, test } from "bun:test";
import { type CanvasDoc, type CanvasNode, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, createHistory, perform, undo, type Frame } from "../../../src/lib/canvas-history";
import { ORG_ERRORS, OrgError } from "../../../src/lib/canvas-groups";
import { SNAP_THRESHOLD_PX, snapFrame, snapSelectionMove, type SnapGuide } from "../../../src/lib/canvas-snap";

const frame = (x: number, y: number, w: number, h: number): Frame => ({ x, y, w, h });
const node = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: "note", x: 0, y: 0, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false, ...over });
const docOf = (nodes: CanvasNode[]): CanvasDoc => validateCanvasDoc({ v: 1, rev: 0, nodes, edges: [], groups: [] });

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof OrgError ? error.code : "outro-erro";
  }
  return "não lançou";
};

const ONE = { zoom: 1 };
const lines = (guides: SnapGuide[]) => guides.filter((g) => g.kind !== "gap");
const gaps = (guides: SnapGuide[]) => guides.filter((g) => g.kind === "gap");

describe("paredes e centros", () => {
  const wall = frame(100, 0, 100, 50);

  test("parede esquerda com parede esquerda, com a guia cobrindo os dois quadros", () => {
    const result = snapFrame(frame(104, 300, 60, 40), [wall], ONE);
    expect(result).toMatchObject({ dx: -4, dy: 0, frame: frame(100, 300, 60, 40) });
    expect(result.guides).toEqual([{ kind: "edge", axis: "x", at: 100, from: 0, to: 340 }]);
  });

  test("lado oposto cola um quadro no outro (direita do puxado na esquerda do vizinho)", () => {
    expect(snapFrame(frame(50, 300, 46, 40), [wall], ONE).dx).toBe(4);
  });

  test("centro com centro, e a guia é de centro", () => {
    const result = snapFrame(frame(33, 300, 40, 20), [frame(0, 0, 100, 100)], ONE);
    expect(result.dx).toBe(-3);
    expect(result.guides).toEqual([{ kind: "center", axis: "x", at: 50, from: 0, to: 320 }]);
  });

  test("os dois eixos são decididos sozinhos", () => {
    const result = snapFrame(frame(103, -4, 30, 30), [wall], ONE);
    expect(result).toMatchObject({ dx: -3, dy: 4 });
    expect(lines(result.guides).map((g) => g.axis).sort()).toEqual(["x", "y"]);
  });

  test("fora do limiar não encaixa e não acende guia", () => {
    const result = snapFrame(frame(108, 300, 60, 40), [wall], ONE);
    expect(result).toMatchObject({ dx: 0, dy: 0, guides: [] });
  });

  test("sem vizinhos não há ajuste", () => {
    expect(snapFrame(frame(1, 2, 3, 4), [], ONE)).toEqual({ dx: 0, dy: 0, frame: frame(1, 2, 3, 4), guides: [] });
  });

  test("o limiar é em pixels de tela: com zoom 2 vale metade, com 0,5 vale o dobro", () => {
    expect(SNAP_THRESHOLD_PX).toBe(6);
    expect(snapFrame(frame(104, 300, 60, 40), [wall], { zoom: 2 }).dx).toBe(0); // 4 unidades = 8 px
    expect(snapFrame(frame(108, 300, 60, 40), [wall], { zoom: 0.5 }).dx).toBe(-8); // 8 unidades = 4 px
    expect(snapFrame(frame(108, 300, 60, 40), [wall], { zoom: 1, thresholdPx: 10 }).dx).toBe(-8);
  });

  test("dado o mesmo alinhamento com vários vizinhos, junta numa guia só", () => {
    const result = snapFrame(frame(101, 300, 60, 40), [wall, frame(100, 100, 50, 50)], ONE);
    expect(result.guides).toEqual([{ kind: "edge", axis: "x", at: 100, from: 0, to: 340 }]);
  });
});

describe("vãos iguais", () => {
  test("no meio de dois vizinhos, com os dois vãos nas guias", () => {
    const result = snapFrame(frame(218, 0, 60, 50), [frame(0, 0, 100, 50), frame(400, 0, 100, 50)], ONE);
    expect(result.dx).toBe(2);
    expect(gaps(result.guides)).toEqual([
      { kind: "gap", axis: "x", segments: [{ from: 100, to: 220, cross: 25 }, { from: 280, to: 400, cross: 25 }] },
    ]);
  });

  test("repetindo o vão que dois vizinhos já têm, à direita deles", () => {
    const result = snapFrame(frame(398, 0, 60, 50), [frame(0, 0, 100, 50), frame(200, 0, 100, 50)], ONE);
    expect(result.dx).toBe(2);
    expect(gaps(result.guides)).toHaveLength(1);
  });

  test("repetindo o vão à esquerda deles", () => {
    const result = snapFrame(frame(338, 0, 60, 50), [frame(500, 0, 100, 50), frame(700, 0, 100, 50)], ONE);
    expect(result.dx).toBe(2);
  });

  test("vizinho fora da faixa do puxado não forma vão", () => {
    const result = snapFrame(frame(218, 0, 60, 50), [frame(0, 500, 100, 50), frame(400, 500, 100, 50)], ONE);
    expect(result).toMatchObject({ dx: 0, guides: [] });
  });

  test("o vão pede espaço: puxado maior que o espaço entre os vizinhos não se encaixa nele", () => {
    const result = snapFrame(frame(100, 0, 300, 50), [frame(0, 0, 100, 50), frame(350, 0, 100, 50)], ONE);
    expect(gaps(result.guides)).toEqual([]);
  });

  test("parede mais perto ganha do vão", () => {
    // o centro do vão pediria -2; a parede do terceiro vizinho, +1
    const result = snapFrame(frame(222, 0, 60, 50), [frame(0, 0, 100, 50), frame(400, 0, 100, 50), frame(223, 200, 80, 50)], ONE);
    expect(result.dx).toBe(1);
    expect(gaps(result.guides)).toEqual([]);
  });
});

describe("entrada inválida", () => {
  test("zoom ou limiar que não servem falham com org_invalid_number", () => {
    for (const options of [{ zoom: 0 }, { zoom: -1 }, { zoom: Number.NaN }, { zoom: 1, thresholdPx: -1 }, { zoom: 1, thresholdPx: Number.POSITIVE_INFINITY }]) {
      expect(code(() => snapFrame(frame(0, 0, 1, 1), [], options))).toBe(ORG_ERRORS.invalidNumber);
    }
  });
});

describe("snapSelectionMove", () => {
  const doc = (): CanvasDoc => docOf([node("a"), node("wall", { x: 300 }), node("l", { x: 0, y: 200, locked: true }), node("agent:p:x", { type: "agent", x: 900, y: 500 })]);

  test("soma o ajuste ao deslocamento bruto e devolve o passo do desfazer", () => {
    const original = doc();
    const result = snapSelectionMove(original, ["a"], { dx: 198, dy: 0 }, ONE);
    expect(result).toMatchObject({ dx: 2, dy: 0 });
    expect(result.guides.length).toBeGreaterThan(0);
    const done = perform(createHistory(), original, result.op as NonNullable<typeof result.op>);
    expect(done.doc.nodes.find((n) => n.id === "a")).toMatchObject({ x: 200, y: 0 });
    expect(undo(done.history, done.doc)?.doc).toEqual(original);
  });

  test("o nó travado da seleção fica parado e vale como vizinho", () => {
    const original = doc();
    const result = snapSelectionMove(original, ["a", "l"], { dx: 0, dy: 138 }, ONE);
    // a vai de y 0 a 138; o travado l (y 200) é vizinho: a base de a (198) cola no topo de l (200)
    expect(result.dy).toBe(2);
    const after = applyOp(original, result.op as NonNullable<typeof result.op>);
    expect(after.nodes.find((n) => n.id === "a")?.y).toBe(140);
    expect(after.nodes.find((n) => n.id === "l")).toEqual(original.nodes.find((n) => n.id === "l"));
  });

  test("nó vivo também se move e é vizinho", () => {
    const result = snapSelectionMove(doc(), ["agent:p:x"], { dx: -1, dy: 0 }, ONE);
    expect(result.op).toBeDefined();
  });

  test("seleção vazia, só de travados ou deslocamento zero sem encaixe não faz passo", () => {
    expect(snapSelectionMove(doc(), [], { dx: 5, dy: 5 }, ONE).op).toBeUndefined();
    expect(snapSelectionMove(doc(), ["l"], { dx: 5, dy: 5 }, ONE)).toMatchObject({ op: undefined, guides: [] });
    expect(snapSelectionMove(docOf([node("a"), node("b", { x: 500, y: 500 })]), ["a"], { dx: 0, dy: 0 }, ONE).op).toBeUndefined();
  });

  test("dado id desconhecido ou deslocamento inválido, falha com o código certo", () => {
    expect(code(() => snapSelectionMove(doc(), ["zz"], { dx: 1, dy: 1 }, ONE))).toBe(ORG_ERRORS.unknownNode);
    expect(code(() => snapSelectionMove(doc(), ["a"], { dx: Number.NaN, dy: 1 }, ONE))).toBe(ORG_ERRORS.invalidNumber);
  });
});
