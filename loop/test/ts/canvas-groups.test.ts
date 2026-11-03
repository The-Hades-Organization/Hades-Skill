// Grupo canvas-groups: grupos do canvas (src/lib/canvas-groups.ts) — criar, renomear, desagrupar, mover com os membros,
// caixa, nó em um grupo só, e a ida e volta exata pela pilha de desfazer. Lógica pura.
import { describe, expect, test } from "bun:test";
import { type CanvasDoc, type CanvasNode, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, createHistory, type CanvasOp, perform, undo } from "../../../src/lib/canvas-history";
import {
  createGroup,
  dissolveSmallGroups,
  groupBox,
  groupIndex,
  moveGroup,
  ORG_ERRORS,
  OrgError,
  pickNodes,
  renameGroup,
  ungroup,
} from "../../../src/lib/canvas-groups";

const node = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: "note", x: 0, y: 0, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false, ...over });

const doc = (): CanvasDoc =>
  validateCanvasDoc({
    v: 1,
    rev: 3,
    nodes: [node("a", { x: 10, y: 20 }), node("b", { x: 200, y: 40 }), node("c", { x: 400 }), node("d", { x: 600, locked: true }), node("agent:p:x", { type: "agent", x: 800 })],
    edges: [{ id: "e1", from: "a", to: "b", kind: "link" }],
    groups: [
      { id: "g1", label: "um", members: ["a", "b", "c"] },
      { id: "g2", label: "dois", members: ["d", "agent:p:x"] },
    ],
  });

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof OrgError ? error.code : "outro-erro";
  }
  return "não lançou";
};

/** Aplica, confere que o documento continua válido e que desfazer pela pilha devolve o original, igual até na ordem. */
function roundTrip(op: CanvasOp | undefined, original = doc()): CanvasDoc {
  if (!op) throw new Error("esperava uma operação");
  const frozen = structuredClone(original);
  const done = perform(createHistory(), original, op);
  expect(validateCanvasDoc(done.doc)).toEqual(done.doc);
  expect(original).toEqual(frozen);
  const back = undo(done.history, done.doc);
  expect(back?.doc).toEqual(frozen);
  return done.doc;
}

describe("createGroup", () => {
  test("dado dois nós livres, cria o grupo no fim da lista com o nome aparado", () => {
    const after = roundTrip(createGroup(doc(), { id: "g3", label: "  novo  ", members: ["a", "b"] }));
    expect(after.groups.at(-1)).toEqual({ id: "g3", label: "novo", members: ["a", "b"] });
  });

  test("dado um nó que já estava em outro grupo, ele passa para o novo e sai do antigo", () => {
    const after = roundTrip(createGroup(doc(), { id: "g3", label: "x", members: ["c", "d"] }));
    expect(after.groups.find((g) => g.id === "g1")?.members).toEqual(["a", "b"]);
    expect(after.groups.find((g) => g.id === "g3")?.members).toEqual(["c", "d"]);
    expect(after.groups.map((g) => g.id)).toEqual(["g1", "g3"]); // g2 ficou com um membro e se desfez
  });

  test("dado um grupo antigo que ficaria com um membro, ele se desfaz", () => {
    const after = roundTrip(createGroup(doc(), { id: "g3", label: "x", members: ["a", "b"] }));
    expect(after.groups.map((g) => g.id)).toEqual(["g2", "g3"]);
  });

  test("todo nó fica em no máximo um grupo depois de criar", () => {
    const after = roundTrip(createGroup(doc(), { id: "g3", label: "x", members: ["b", "d", "c"] }));
    const all = after.groups.flatMap((g) => g.members);
    expect(new Set(all).size).toBe(all.length);
  });

  test("dado membro vivo do Argos, ele pode agrupar", () => {
    const after = roundTrip(createGroup(doc(), { id: "g3", label: "x", members: ["a", "agent:p:x"] }));
    expect(after.groups.at(-1)?.members).toEqual(["a", "agent:p:x"]);
  });

  test("dado seleção vazia, um nó só ou o mesmo nó repetido, não há grupo", () => {
    expect(createGroup(doc(), { id: "g3", label: "x", members: [] })).toBeUndefined();
    expect(createGroup(doc(), { id: "g3", label: "x", members: ["a"] })).toBeUndefined();
    expect(createGroup(doc(), { id: "g3", label: "x", members: ["a", "a"] })).toBeUndefined();
  });

  test("dado entrada inválida, falha com o código certo", () => {
    expect(code(() => createGroup(doc(), { id: "g3", label: "x", members: ["a", "nao-existe"] }))).toBe(ORG_ERRORS.unknownNode);
    expect(code(() => createGroup(doc(), { id: "g1", label: "x", members: ["a", "b"] }))).toBe(ORG_ERRORS.duplicateId);
    expect(code(() => createGroup(doc(), { id: "g 3", label: "x", members: ["a", "b"] }))).toBe(ORG_ERRORS.invalidId);
    expect(code(() => createGroup(doc(), { id: "g3", label: "   ", members: ["a", "b"] }))).toBe(ORG_ERRORS.invalidLabel);
    expect(code(() => createGroup(doc(), { id: "g3", label: "x".repeat(201), members: ["a", "b"] }))).toBe(ORG_ERRORS.invalidLabel);
  });
});

describe("ungroup e renameGroup", () => {
  test("desagrupar tira o grupo e deixa os nós onde estão", () => {
    const original = doc();
    const after = roundTrip(ungroup(original, "g1"), original);
    expect(after.groups.map((g) => g.id)).toEqual(["g2"]);
    expect(after.nodes).toEqual(original.nodes);
  });

  test("dado grupo que não existe, desagrupar e renomear falham", () => {
    expect(code(() => ungroup(doc(), "zz"))).toBe(ORG_ERRORS.unknownGroup);
    expect(code(() => renameGroup(doc(), "zz", "x"))).toBe(ORG_ERRORS.unknownGroup);
  });

  test("renomear mantém a posição do grupo na lista e os membros", () => {
    const after = roundTrip(renameGroup(doc(), "g1", " Renomeado "));
    expect(after.groups[0]).toEqual({ id: "g1", label: "Renomeado", members: ["a", "b", "c"] });
    expect(after.groups[1]?.id).toBe("g2");
  });

  test("renomear para o mesmo nome (ou vazio) não faz passo", () => {
    expect(renameGroup(doc(), "g1", "um")).toBeUndefined();
    expect(code(() => renameGroup(doc(), "g1", ""))).toBe(ORG_ERRORS.invalidLabel);
  });
});

describe("moveGroup", () => {
  test("move os membros livres e deixa o travado onde está", () => {
    const after = roundTrip(moveGroup(doc(), "g2", 30, -10));
    expect(after.nodes.find((n) => n.id === "d")).toMatchObject({ x: 600, y: 0 });
    expect(after.nodes.find((n) => n.id === "agent:p:x")).toMatchObject({ x: 830, y: -10 });
  });

  test("move todos os membros em um passo só do desfazer", () => {
    const original = doc();
    const done = perform(createHistory(), original, moveGroup(original, "g1", 5, 5) as CanvasOp);
    expect(done.history.past).toHaveLength(1);
    expect(done.doc.nodes.filter((n) => ["a", "b", "c"].includes(n.id)).map((n) => [n.x, n.y])).toEqual([[15, 25], [205, 45], [405, 5]]);
  });

  test("grupo só de travados, ou deslocamento zero, não faz passo", () => {
    const locked = applyOp(doc(), { kind: "move", id: "agent:p:x", from: { x: 800, y: 0 }, to: { x: 800, y: 0 } });
    const allLocked: CanvasDoc = { ...locked, nodes: locked.nodes.map((n) => (n.id === "agent:p:x" ? { ...n, locked: true } : n)) };
    expect(moveGroup(allLocked, "g2", 10, 10)).toBeUndefined();
    expect(moveGroup(doc(), "g1", 0, 0)).toBeUndefined();
  });

  test("dado deslocamento que não é número, falha antes de montar passo", () => {
    expect(code(() => moveGroup(doc(), "g1", Number.NaN, 0))).toBe(ORG_ERRORS.invalidNumber);
    expect(code(() => moveGroup(doc(), "g1", 0, Number.POSITIVE_INFINITY))).toBe(ORG_ERRORS.invalidNumber);
    expect(code(() => moveGroup(doc(), "zz", 1, 1))).toBe(ORG_ERRORS.unknownGroup);
  });
});

describe("groupBox", () => {
  test("é a caixa dos membros com a folga padrão", () => {
    expect(groupBox(doc(), "g1")).toEqual({ x: -6, y: -16, w: 522, h: 132 });
  });

  test("aceita folga e cabeçalho, e acompanha os membros depois de mover", () => {
    const original = doc();
    const moved = applyOp(original, moveGroup(original, "g1", 100, 50) as CanvasOp);
    expect(groupBox(moved, "g1", { padding: 0, header: 24 })).toEqual({ x: 110, y: 26, w: 490, h: 124 });
  });

  test("grupo que não existe não tem caixa", () => {
    expect(groupBox(doc(), "zz")).toBeUndefined();
  });
});

describe("índice e dissolução", () => {
  test("groupIndex mapeia cada nó ao seu grupo", () => {
    const index = groupIndex(doc());
    expect(index.get("a")).toBe("g1");
    expect(index.get("agent:p:x")).toBe("g2");
    expect(index.get("nao")).toBeUndefined();
  });

  test("pickNodes tira repetidos e falha com id desconhecido", () => {
    expect(pickNodes(doc(), ["b", "a", "b"]).map((n) => n.id)).toEqual(["b", "a"]);
    expect(pickNodes(doc(), [])).toEqual([]);
    expect(code(() => pickNodes(doc(), ["zz"]))).toBe(ORG_ERRORS.unknownNode);
  });

  test("dissolveSmallGroups só toca os candidatos", () => {
    const small: CanvasDoc = { ...doc(), groups: [{ id: "g1", label: "um", members: ["a"] }, { id: "g2", label: "dois", members: ["d"] }] };
    const ops = dissolveSmallGroups(small, new Set(["g1"]));
    expect(ops).toHaveLength(1);
    expect(ops.reduce(applyOp, small).groups.map((g) => g.id)).toEqual(["g2"]);
  });
});
