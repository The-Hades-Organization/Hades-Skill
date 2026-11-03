// Grupo canvas-align: alinhar, distribuir e encaixar na grade (src/lib/canvas-align.ts) — nó travado parado, passo único
// no desfazer, ida e volta exata. Lógica pura.
import { describe, expect, test } from "bun:test";
import { type CanvasDoc, type CanvasNode, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { createHistory, type CanvasOp, perform, undo } from "../../../src/lib/canvas-history";
import { alignNodes, type AlignMode, distributeNodes, GRID_SIZE, snapNodesToGrid } from "../../../src/lib/canvas-align";
import { ORG_ERRORS, OrgError } from "../../../src/lib/canvas-groups";

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

const at = (doc: CanvasDoc, id: string): [number, number] => {
  const found = doc.nodes.find((n) => n.id === id);
  return found ? [found.x, found.y] : [Number.NaN, Number.NaN];
};

/** Aplica pela pilha, confere o documento válido e que desfazer devolve o original; devolve o documento novo. */
function run(doc: CanvasDoc, op: CanvasOp | undefined): CanvasDoc {
  if (!op) throw new Error("esperava uma operação");
  const frozen = structuredClone(doc);
  const done = perform(createHistory(), doc, op);
  expect(validateCanvasDoc(done.doc)).toEqual(done.doc);
  expect(done.history.past).toHaveLength(1);
  expect(undo(done.history, done.doc)?.doc).toEqual(frozen);
  expect(doc).toEqual(frozen);
  return done.doc;
}

const three = (): CanvasDoc => docOf([node("a", { x: 10, y: 5, w: 50, h: 20 }), node("b", { x: 100, y: 40, w: 80, h: 60 }), node("c", { x: 300, y: 70, w: 20, h: 40 })]);

describe("alignNodes", () => {
  test.each<[AlignMode, Record<string, [number, number]>]>([
    ["left", { a: [10, 5], b: [10, 40], c: [10, 70] }],
    ["right", { a: [270, 5], b: [240, 40], c: [300, 70] }],
    ["center", { a: [140, 5], b: [125, 40], c: [155, 70] }],
    ["top", { a: [10, 5], b: [100, 5], c: [300, 5] }],
    ["bottom", { a: [10, 90], b: [100, 50], c: [300, 70] }],
    ["middle", { a: [10, 47.5], b: [100, 27.5], c: [300, 37.5] }],
  ])("dado %s, cada nó vai para a referência da caixa da seleção", (mode, expected) => {
    const after = run(three(), alignNodes(three(), ["a", "b", "c"], mode));
    for (const [id, position] of Object.entries(expected)) expect(at(after, id)).toEqual(position);
  });

  test("nó travado entra na caixa e não se move", () => {
    const doc = docOf([node("a", { x: 50 }), node("b", { x: 200 }), node("l", { x: 10, locked: true })]);
    const after = run(doc, alignNodes(doc, ["a", "b", "l"], "left"));
    expect(at(after, "l")).toEqual([10, 0]);
    expect(at(after, "a")).toEqual([10, 0]);
    expect(at(after, "b")).toEqual([10, 0]);
  });

  test("seleção só de travados, de um nó ou vazia não faz passo", () => {
    const locked = docOf([node("a", { x: 5, locked: true }), node("b", { x: 90, locked: true })]);
    expect(alignNodes(locked, ["a", "b"], "left")).toBeUndefined();
    expect(alignNodes(three(), ["a"], "left")).toBeUndefined();
    expect(alignNodes(three(), [], "left")).toBeUndefined();
  });

  test("quem já está alinhado não vira passo; um só que andou vira passo simples", () => {
    const doc = docOf([node("a", { x: 0 }), node("b", { x: 0 }), node("c", { x: 7 })]);
    const op = alignNodes(doc, ["a", "b", "c"], "left");
    expect(op?.kind).toBe("move");
    expect(at(run(doc, op), "c")).toEqual([0, 0]);
  });

  test("dado id desconhecido ou modo inválido, falha com o código certo", () => {
    expect(code(() => alignNodes(three(), ["a", "zz"], "left"))).toBe(ORG_ERRORS.unknownNode);
    expect(code(() => alignNodes(three(), ["a", "b"], "diagonal" as AlignMode))).toBe(ORG_ERRORS.invalidMode);
  });
});

describe("distributeNodes", () => {
  const row = (): CanvasDoc => docOf([node("a", { x: 0, w: 100 }), node("b", { x: 130, w: 100 }), node("c", { x: 500, w: 100 }), node("d", { x: 900, w: 100 })]);

  test("horizontal: pontas paradas e vãos iguais entre os nós", () => {
    const after = run(row(), distributeNodes(row(), ["a", "b", "c", "d"], "horizontal"));
    expect(at(after, "a")).toEqual([0, 0]);
    expect(at(after, "d")).toEqual([900, 0]);
    // espaço livre: 1000 - 4*100 = 600, em 3 vãos de 200
    expect(at(after, "b")).toEqual([300, 0]);
    expect(at(after, "c")).toEqual([600, 0]);
  });

  test("vertical usa a altura", () => {
    const col = docOf([node("a", { y: 0, h: 50 }), node("b", { y: 10, h: 50 }), node("c", { y: 300, h: 50 })]);
    const after = run(col, distributeNodes(col, ["a", "b", "c"], "vertical"));
    expect(at(after, "b")).toEqual([0, 150]);
  });

  test("a ordem é pelo centro, não pela ordem da seleção", () => {
    const after = run(row(), distributeNodes(row(), ["d", "c", "b", "a"], "horizontal"));
    expect(at(after, "b")).toEqual([300, 0]);
  });

  test("nó travado no meio é âncora: os livres dividem o espaço de cada lado", () => {
    const doc = docOf([node("a", { x: 0, w: 100 }), node("b", { x: 120, w: 100 }), node("l", { x: 500, w: 100, locked: true }), node("c", { x: 640, w: 100 }), node("d", { x: 1000, w: 100 })]);
    const after = run(doc, distributeNodes(doc, ["a", "b", "l", "c", "d"], "horizontal"));
    expect(at(after, "l")).toEqual([500, 0]);
    expect(at(after, "b")).toEqual([250, 0]); // entre a (fim 100) e l (início 500): vão de 150
    expect(at(after, "c")).toEqual([750, 0]); // entre l (fim 600) e d (início 1000): vão de 150
  });

  test("com menos de três nós ou já distribuído, não faz passo", () => {
    expect(distributeNodes(row(), ["a", "b"], "horizontal")).toBeUndefined();
    const even = docOf([node("a", { x: 0 }), node("b", { x: 200 }), node("c", { x: 400 })]);
    expect(distributeNodes(even, ["a", "b", "c"], "horizontal")).toBeUndefined();
    const locked = docOf([node("a", { x: 0 }), node("b", { x: 130, locked: true }), node("c", { x: 400 })]);
    expect(distributeNodes(locked, ["a", "b", "c"], "horizontal")).toBeUndefined();
  });

  test("dado eixo inválido ou id desconhecido, falha com o código certo", () => {
    expect(code(() => distributeNodes(row(), ["a", "b", "c"], "z" as "horizontal"))).toBe(ORG_ERRORS.invalidMode);
    expect(code(() => distributeNodes(row(), ["a", "b", "zz"], "horizontal"))).toBe(ORG_ERRORS.unknownNode);
  });
});

describe("snapNodesToGrid", () => {
  test("usa a grade de 20 e arredonda para o mais perto, inclusive negativos", () => {
    expect(GRID_SIZE).toBe(20);
    const doc = docOf([node("a", { x: 9, y: 11 }), node("b", { x: -31, y: -9 }), node("c", { x: 40, y: 60 })]);
    const after = run(doc, snapNodesToGrid(doc, ["a", "b", "c"]));
    expect(at(after, "a")).toEqual([0, 20]);
    expect(at(after, "b")).toEqual([-40, -0 + 0]);
    expect(Object.is(at(after, "b")[1], -0)).toBe(false);
    expect(at(after, "c")).toEqual([40, 60]);
  });

  test("grade pedida diferente da padrão vale", () => {
    const doc = docOf([node("a", { x: 12, y: 12 }), node("b", { x: 3, y: 3 })]);
    expect(at(run(doc, snapNodesToGrid(doc, ["a", "b"], 5)), "a")).toEqual([10, 10]);
  });

  test("nó travado fica; tudo na grade ou seleção vazia não faz passo", () => {
    const doc = docOf([node("a", { x: 9, locked: true }), node("b", { x: 40 })]);
    expect(snapNodesToGrid(doc, ["a", "b"])).toBeUndefined();
    expect(snapNodesToGrid(three(), [])).toBeUndefined();
  });

  test("dado grade inválida ou id desconhecido, falha com o código certo", () => {
    expect(code(() => snapNodesToGrid(three(), ["a"], 0))).toBe(ORG_ERRORS.invalidNumber);
    expect(code(() => snapNodesToGrid(three(), ["a"], Number.NaN))).toBe(ORG_ERRORS.invalidNumber);
    expect(code(() => snapNodesToGrid(three(), ["zz"]))).toBe(ORG_ERRORS.unknownNode);
  });
});
