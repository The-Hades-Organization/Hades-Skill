// Grupo canvas-clipboard: duplicar, copiar, colar e excluir (src/lib/canvas-clipboard.ts) — ids novos, deslocamento,
// nó vivo fora, conexões internas e externas, grupos, e a ida e volta exata pelo desfazer. Lógica pura.
import { describe, expect, test } from "bun:test";
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNode, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, createHistory, type CanvasOp, perform, undo } from "../../../src/lib/canvas-history";
import {
  type Clip,
  copyNodes,
  deleteNodes,
  duplicateNodes,
  type IdSource,
  pasteClip,
  PASTE_OFFSET,
  readClip,
  sequentialIds,
} from "../../../src/lib/canvas-clipboard";
import { ORG_ERRORS, OrgError } from "../../../src/lib/canvas-groups";

const node = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: "note", x: 0, y: 0, w: 100, h: 60, z: 0, data: { id }, locked: false, blurred: false, ...over });

const doc = (): CanvasDoc =>
  validateCanvasDoc({
    v: 1,
    rev: 2,
    nodes: [node("a", { x: 10, y: 20 }), node("b", { x: 200, z: 3, locked: true }), node("c", { x: 400 }), node("d", { x: 600 }), node("agent:p:x", { type: "agent", data: {}, x: 800 })],
    edges: [
      { id: "e1", from: "a", to: "b", kind: "link" },
      { id: "e2", from: "b", to: "c", kind: "link" },
      { id: "e3", from: "c", to: "agent:p:x", kind: "link" },
      { id: "e4", from: "d", to: "a", kind: "ref" },
    ],
    groups: [
      { id: "g1", label: "um", members: ["a", "b"] },
      { id: "g2", label: "dois", members: ["c", "d", "agent:p:x"] },
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

/** Aplica pela pilha, confere o documento válido e que desfazer devolve o original, igual até na ordem das listas. */
function run(original: CanvasDoc, op: CanvasOp | undefined): CanvasDoc {
  if (!op) throw new Error("esperava uma operação");
  const frozen = structuredClone(original);
  const done = perform(createHistory(), original, op);
  expect(validateCanvasDoc(done.doc)).toEqual(done.doc);
  expect(done.history.past).toHaveLength(1);
  expect(original).toEqual(frozen);
  expect(undo(done.history, done.doc)?.doc).toEqual(frozen);
  return done.doc;
}

describe("sequentialIds", () => {
  test("gera ids por tipo, em ordem, pulando o que o documento já usa", () => {
    const base = validateCanvasDoc({ v: 1, rev: 0, nodes: [node("c-node-1")], edges: [], groups: [] });
    const next = sequentialIds(base);
    expect([next("node"), next("node"), next("edge"), next("group")]).toEqual(["c-node-2", "c-node-3", "c-edge-1", "c-group-1"]);
    expect(sequentialIds(base, "x")("node")).toBe("x-node-1");
  });
});

describe("copyNodes", () => {
  test("copia os nós na ordem do documento, só as conexões internas e os grupos inteiros", () => {
    const { clip, skipped } = copyNodes(doc(), ["b", "a", "c"]);
    expect(clip.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(clip.edges.map((e) => e.id)).toEqual(["e1", "e2"]); // e3 e e4 tocam nós de fora da seleção
    expect(clip.groups.map((g) => g.id)).toEqual(["g1"]); // g2 só tem parte dos membros
    expect(skipped).toEqual([]);
  });

  test("a cópia é independente do documento", () => {
    const original = doc();
    const { clip } = copyNodes(original, ["a"]);
    (clip.nodes[0] as CanvasNode).data.id = "mudou";
    (clip.nodes[0] as CanvasNode).x = 999;
    expect(original.nodes[0]).toMatchObject({ x: 10, data: { id: "a" } });
  });

  test("nó vivo fica de fora e vai em skipped; a conexão com ele não entra", () => {
    const { clip, skipped } = copyNodes(doc(), ["c", "agent:p:x"]);
    expect(clip.nodes.map((n) => n.id)).toEqual(["c"]);
    expect(clip.edges).toEqual([]);
    expect(skipped).toEqual(["agent:p:x"]);
  });

  test("seleção vazia, só de nós vivos ou com id desconhecido", () => {
    expect(copyNodes(doc(), []).clip).toEqual({ nodes: [], edges: [], groups: [] });
    expect(copyNodes(doc(), ["agent:p:x"]).clip.nodes).toEqual([]);
    expect(code(() => copyNodes(doc(), ["zz"]))).toBe(ORG_ERRORS.unknownNode);
  });
});

describe("pasteClip e duplicateNodes", () => {
  test("cola com ids novos, deslocado, e refaz conexões e grupo entre os nós novos", () => {
    const original = doc();
    const { clip } = copyNodes(original, ["a", "b", "c"]);
    const result = pasteClip(original, clip, sequentialIds(original));
    expect(result.nodeIds).toEqual(["c-node-1", "c-node-2", "c-node-3"]);
    const after = run(original, result.op);
    const a2 = after.nodes.find((n) => n.id === "c-node-1");
    expect(a2).toMatchObject({ x: 10 + PASTE_OFFSET.dx, y: 20 + PASTE_OFFSET.dy, data: { id: "a" } });
    expect(after.nodes.find((n) => n.id === "c-node-2")).toMatchObject({ z: 3, locked: true }); // mantém o estado do original
    expect(after.edges.slice(-2)).toEqual([
      { id: "c-edge-1", from: "c-node-1", to: "c-node-2", kind: "link" },
      { id: "c-edge-2", from: "c-node-2", to: "c-node-3", kind: "link" },
    ]);
    expect(after.groups.at(-1)).toEqual({ id: "c-group-1", label: "um", members: ["c-node-1", "c-node-2"] });
    expect(after.nodes.slice(0, 5)).toEqual(original.nodes);
  });

  test("um nó fica em no máximo um grupo depois de colar", () => {
    const original = doc();
    const after = run(original, duplicateNodes(original, ["a", "b"], sequentialIds(original)).op);
    const members = after.groups.flatMap((g) => g.members);
    expect(new Set(members).size).toBe(members.length);
  });

  test("o deslocamento pode ser dado; o original fica no lugar", () => {
    const original = doc();
    const after = run(original, pasteClip(original, copyNodes(original, ["a"]).clip, sequentialIds(original), { dx: -5, dy: 7 }).op);
    expect(after.nodes.find((n) => n.id === "c-node-1")).toMatchObject({ x: 5, y: 27 });
    expect(after.nodes.find((n) => n.id === "a")).toMatchObject({ x: 10, y: 20 });
  });

  test("colar duas vezes gera ids diferentes pelo gerador do documento atualizado", () => {
    const original = doc();
    const first = run(original, duplicateNodes(original, ["a"], sequentialIds(original)).op);
    const second = duplicateNodes(first, ["a"], sequentialIds(first));
    expect(second.nodeIds).toEqual(["c-node-2"]);
  });

  test("duplicar pula o nó vivo e conta em skipped; só nó vivo não faz passo", () => {
    const original = doc();
    const mixed = duplicateNodes(original, ["c", "agent:p:x"], sequentialIds(original));
    expect(mixed.skipped).toEqual(["agent:p:x"]);
    expect(mixed.nodeIds).toHaveLength(1);
    const onlyLive = duplicateNodes(original, ["agent:p:x"], sequentialIds(original));
    expect(onlyLive).toEqual({ op: undefined, nodeIds: [], skipped: ["agent:p:x"] });
  });

  test("clipe vazio não faz passo", () => {
    expect(pasteClip(doc(), { nodes: [], edges: [], groups: [] }, sequentialIds(doc()))).toEqual({ op: undefined, nodeIds: [] });
  });

  test("dado gerador que devolve id repetido, inválido ou já usado, falha com o código certo", () => {
    const original = doc();
    const { clip } = copyNodes(original, ["a", "c"]);
    expect(code(() => pasteClip(original, clip, () => "novo"))).toBe(ORG_ERRORS.duplicateId);
    expect(code(() => pasteClip(original, clip, () => "a"))).toBe(ORG_ERRORS.duplicateId);
    expect(code(() => pasteClip(original, clip, () => "com espaço"))).toBe(ORG_ERRORS.invalidId);
    expect(code(() => pasteClip(original, clip, (() => "") as IdSource))).toBe(ORG_ERRORS.invalidId);
  });

  test("dado deslocamento que sai do documento, falha antes de montar o passo", () => {
    const original = doc();
    const { clip } = copyNodes(original, ["a"]);
    expect(code(() => pasteClip(original, clip, sequentialIds(original), { dx: CANVAS_LIMITS.coordinate, dy: 0 }))).toBe(ORG_ERRORS.invalidNumber);
    expect(code(() => pasteClip(original, clip, sequentialIds(original), { dx: Number.NaN, dy: 0 }))).toBe(ORG_ERRORS.invalidNumber);
  });

  test("dado clipe com nó vivo ou referência solta, recusa", () => {
    const original = doc();
    const live: Clip = { nodes: [node("agent:q:y", { type: "agent", data: {} })], edges: [], groups: [] };
    expect(code(() => pasteClip(original, live, sequentialIds(original)))).toBe(ORG_ERRORS.invalidClip);
    const dangling: Clip = { nodes: [node("a")], edges: [{ id: "e", from: "a", to: "fora", kind: "link" }], groups: [] };
    expect(code(() => pasteClip(original, dangling, sequentialIds(original)))).toBe(ORG_ERRORS.invalidClip);
  });

  test("passar do limite de nós é recusado", () => {
    const many = validateCanvasDoc({ v: 1, rev: 0, nodes: Array.from({ length: CANVAS_LIMITS.nodes }, (_, i) => node(`n${i}`)), edges: [], groups: [] });
    expect(code(() => pasteClip(many, copyNodes(many, ["n0"]).clip, sequentialIds(many)))).toBe(ORG_ERRORS.limitExceeded);
  });
});

describe("readClip", () => {
  test("aceita o clipe que a própria cópia produz, depois de ir e voltar por JSON", () => {
    const { clip } = copyNodes(doc(), ["a", "b"]);
    expect(readClip(JSON.parse(JSON.stringify(clip)))).toEqual(clip);
  });

  test("recusa o que não é clipe do documento", () => {
    for (const raw of [null, 3, [], {}, { nodes: "x", edges: [], groups: [] }, { nodes: [{ id: "a" }], edges: [], groups: [] }, { nodes: [node("a")], edges: [{ id: "e", from: "a", to: "z", kind: "link" }], groups: [] }]) {
      expect(code(() => readClip(raw))).toBe(ORG_ERRORS.invalidClip);
    }
    expect(code(() => readClip({ nodes: [node("agent:q:y", { type: "agent", data: {} })], edges: [], groups: [] }))).toBe(ORG_ERRORS.invalidClip);
  });
});

describe("deleteNodes", () => {
  test("exclui o nó com as conexões que o tocavam e tira o membro do grupo", () => {
    const original = doc();
    const result = deleteNodes(original, ["c"]);
    const after = run(original, result.op);
    expect(after.nodes.map((n) => n.id)).toEqual(["a", "b", "d", "agent:p:x"]);
    expect(after.edges.map((e) => e.id)).toEqual(["e1", "e4"]);
    expect(after.groups.find((g) => g.id === "g2")?.members).toEqual(["d", "agent:p:x"]);
  });

  test("o grupo que fica com um membro se desfaz no mesmo passo, e o desfazer devolve tudo", () => {
    const original = doc();
    const after = run(original, deleteNodes(original, ["a"]).op);
    expect(after.groups.map((g) => g.id)).toEqual(["g2"]);
  });

  test("grupo que já era pequeno e não foi tocado fica", () => {
    const small = { ...doc(), groups: [{ id: "solo", label: "s", members: ["d"] }, { id: "g1", label: "um", members: ["a", "b"] }] };
    const after = applyOp(small, deleteNodes(small, ["a"]).op as CanvasOp);
    expect(after.groups.map((g) => g.id)).toEqual(["solo"]);
  });

  test("nó vivo não se exclui: fica e vai em skipped", () => {
    const original = doc();
    const result = deleteNodes(original, ["d", "agent:p:x"]);
    expect(result.skipped).toEqual(["agent:p:x"]);
    expect(run(original, result.op).nodes.some((n) => n.id === "agent:p:x")).toBe(true);
    expect(deleteNodes(original, ["agent:p:x"])).toEqual({ op: undefined, skipped: ["agent:p:x"] });
  });

  test("nó travado pode ser excluído", () => {
    const original = doc();
    expect(run(original, deleteNodes(original, ["b"]).op).nodes.some((n) => n.id === "b")).toBe(false);
  });

  test("seleção vazia não faz passo e id desconhecido falha", () => {
    expect(deleteNodes(doc(), [])).toEqual({ op: undefined, skipped: [] });
    expect(code(() => deleteNodes(doc(), ["zz"]))).toBe(ORG_ERRORS.unknownNode);
  });
});
