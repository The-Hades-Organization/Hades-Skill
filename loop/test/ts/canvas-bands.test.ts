// Grupo canvas-bands: bandas de agentes (src/lib/canvas-bands.ts) — lista de status, troca entre agentes, ligação da banda
// a uma nota e a ida e volta exata pela pilha de desfazer. Lógica pura.
import { describe, expect, test } from "bun:test";
import { type CanvasDoc, type CanvasNode, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, createHistory, invert as invertOp, perform, redo, undo } from "../../../src/lib/canvas-history";
import { addToBand, bandLinkId, bandNotes, bandsOf, bandStatus, isBand, linkBand, removeFromBand, stepBand, unlinkBand, waitingAcrossBands, type BandLive } from "../../../src/lib/canvas-bands";
import { ORG_ERRORS, OrgError } from "../../../src/lib/canvas-groups";

const node = (id: string, type = "note"): CanvasNode => ({ id, type, x: 0, y: 0, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false });
const doc = (): CanvasDoc =>
  validateCanvasDoc({
    v: 1,
    rev: 1,
    nodes: [node("agent:r:a1", "agent"), node("agent:r:a2", "agent"), node("agent:r:a3", "agent"), node("n1"), node("n2"), node("pr:r:1", "pr")],
    edges: [{ id: "x", from: "n1", to: "n2", kind: "link" }],
    groups: [
      { id: "band", label: "Banda", members: ["agent:r:a1", "agent:r:a2", "agent:r:a3"] },
      { id: "mixed", label: "Mista", members: ["agent:r:a1", "pr:r:1"] },
    ],
  });
const live: BandLive = new Map([
  ["agent:r:a1", { state: "idle", waitingOwner: false }],
  ["agent:r:a2", { state: "working", waitingOwner: false }],
  ["agent:r:a3", { state: "working", waitingOwner: true }],
]);
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof OrgError ? error.code : "outro-erro";
  }
  return "não lançou";
};

describe("bandas e status", () => {
  test("dado grupos, então só o de agentes é banda", () => {
    expect(bandsOf(doc()).map((g) => g.id)).toEqual(["band"]);
    expect(isBand(doc(), { id: "s", label: "s", members: ["agent:r:a1"] })).toBe(false);
  });
  test("dado o estado do grafo, então espera o dono vem primeiro, depois trabalha, depois o resto", () => {
    const status = bandStatus(doc(), "band", live);
    expect(status.members.map((m) => [m.id, m.rank])).toEqual([["agent:r:a3", "waiting"], ["agent:r:a2", "working"], ["agent:r:a1", "other"]]);
    expect(status.counts).toEqual({ waiting: 1, working: 1, other: 1 });
  });
  test("dado agente sem informação ou objeto simples, então unknown em other", () => {
    const status = bandStatus(doc(), "band", { "agent:r:a2": { state: "running", waitingOwner: false } });
    expect(status.members.find((m) => m.id === "agent:r:a1")).toMatchObject({ state: "unknown", rank: "other" });
    expect(status.members[0]?.id).toBe("agent:r:a2");
    expect(bandStatus(doc(), "band", { constructor: { state: "x", waitingOwner: true } }).counts.waiting).toBe(0);
  });
  test("dado grupo que não é banda ou inexistente, então erro de código estável", () => {
    expect(code(() => bandStatus(doc(), "mixed", live))).toBe(ORG_ERRORS.invalidMode);
    expect(code(() => bandStatus(doc(), "nope", live))).toBe(ORG_ERRORS.unknownGroup);
  });
  test("dado a espera em várias bandas, então cada agente aparece uma vez", () => {
    expect(waitingAcrossBands(doc(), live)).toEqual(["agent:r:a3"]);
  });
});

describe("stepBand", () => {
  const status = bandStatus(doc(), "band", live);
  test("dado a lista, então anda dando a volta nos dois sentidos", () => {
    expect(stepBand(status, "agent:r:a3")).toBe("agent:r:a2");
    expect(stepBand(status, "agent:r:a1")).toBe("agent:r:a3");
    expect(stepBand(status, "agent:r:a3", "previous")).toBe("agent:r:a1");
  });
  test("dado atual ausente ou fora da banda, então começa pelas pontas", () => {
    expect(stepBand(status, undefined)).toBe("agent:r:a3");
    expect(stepBand(status, "zz", "previous")).toBe("agent:r:a1");
  });
});

describe("ligar a banda a uma nota", () => {
  test("dado banda e nota, então uma conexão por agente e o desfazer volta exato", () => {
    const before = doc();
    const done = perform(createHistory(), before, linkBand(before, "band", "n1")!);
    expect(done.doc.edges.filter((e) => e.kind === "band").map((e) => [e.from, e.to])).toEqual([["agent:r:a1", "n1"], ["agent:r:a2", "n1"], ["agent:r:a3", "n1"]]);
    expect(done.doc.edges[2]?.id).toBe(bandLinkId("band", "agent:r:a2", "n1"));
    expect(validateCanvasDoc(done.doc)).toEqual(done.doc);
    expect(bandNotes(done.doc, "band")).toEqual(["n1"]);
    expect(undo(done.history, done.doc)!.doc).toEqual(before);
  });
  test("dado banda já ligada, então undefined; ligada pela metade, completa só o que falta", () => {
    const linked = applyOp(doc(), linkBand(doc(), "band", "n1")!);
    expect(linkBand(linked, "band", "n1")).toBeUndefined();
    const partial = { ...linked, edges: linked.edges.filter((e) => e.from !== "agent:r:a2") };
    expect(applyOp(partial, linkBand(partial, "band", "n1")!).edges.filter((e) => e.kind === "band")).toHaveLength(3);
  });
  test("dado nota inexistente, agente como alvo ou id de grupo enorme, então erro", () => {
    expect(code(() => linkBand(doc(), "band", "zz"))).toBe(ORG_ERRORS.unknownNode);
    expect(code(() => linkBand(doc(), "band", "agent:r:a1"))).toBe(ORG_ERRORS.invalidMode);
    const long = validateCanvasDoc({ ...doc(), groups: [{ id: "g".repeat(190), label: "x", members: ["agent:r:a1", "agent:r:a2"] }] });
    expect(code(() => linkBand(long, "g".repeat(190), "n1"))).toBe(ORG_ERRORS.invalidId);
  });
  test("dado banda ligada, então desligar remove só as conexões da banda e desfaz exato", () => {
    const base = applyOp(doc(), linkBand(doc(), "band", "n1")!);
    const done = perform(createHistory(), base, unlinkBand(base, "band", "n1")!);
    expect(done.doc.edges.map((e) => e.id)).toEqual(["x"]);
    expect(done.doc.nodes).toEqual(base.nodes);
    expect(undo(done.history, done.doc)!.doc).toEqual(base);
    expect(unlinkBand(doc(), "band", "n1")).toBeUndefined();
  });
});

describe("bandas: as operações são da pilha, sem recriar nó", () => {
  test("ligar vira um lote de edge-create e a nota não é recriada (nó, grupos e índices intactos)", () => {
    const before = doc();
    const op = linkBand(before, "band", "n1")!;
    expect(op.kind).toBe("batch");
    expect(op.kind === "batch" && op.ops.every((o) => o.kind === "edge-create")).toBe(true);
    const after = applyOp(before, op);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.groups).toEqual(before.groups);
  });
  test("ligar só um agente que falta vira um edge-create simples; refazer repete", () => {
    const linked = applyOp(doc(), linkBand(doc(), "band", "n1")!);
    const partial = { ...linked, edges: linked.edges.filter((e) => e.from !== "agent:r:a2") };
    const op = linkBand(partial, "band", "n1")!;
    expect(op.kind).toBe("edge-create");
    const first = perform(createHistory(), partial, op);
    const back = undo(first.history, first.doc)!;
    expect(back.doc).toEqual(partial);
    expect(redo(back.history, back.doc)?.doc).toEqual(first.doc);
  });
  test("desligar com ligações no meio de outras arestas desfaz na ordem original", () => {
    const base = applyOp(doc(), linkBand(doc(), "band", "n1")!);
    const withTail = { ...base, edges: [...base.edges, { id: "z", from: "n2", to: "n1", kind: "link" }] };
    const mixed = { ...withTail, edges: [withTail.edges[1]!, withTail.edges[0]!, withTail.edges[3]!, withTail.edges[2]!, withTail.edges[4]!] };
    const op = unlinkBand(mixed, "band", "n1")!;
    const after = applyOp(mixed, op);
    expect(after.edges.map((e) => e.id)).toEqual(["x", "z"]);
    expect(applyOp(after, invertOp(op))).toEqual(mixed);
  });
});

describe("bandas: trocar quem está na banda", () => {
  const solo = (): CanvasDoc => validateCanvasDoc({ ...doc(), nodes: [...doc().nodes, node("agent:r:a4", "agent")] });
  test("addToBand põe o agente no fim da lista (link) e o desfazer o tira; nó e arestas não mudam", () => {
    const before = solo();
    const done = perform(createHistory(), before, addToBand(before, "band", "agent:r:a4")!);
    expect(done.doc.groups[0]?.members).toEqual(["agent:r:a1", "agent:r:a2", "agent:r:a3", "agent:r:a4"]);
    expect(done.doc.nodes).toEqual(before.nodes);
    expect(undo(done.history, done.doc)!.doc).toEqual(before);
  });
  test("removeFromBand tira o agente do meio (unlink), mantém o nó e o desfazer o devolve ao mesmo lugar", () => {
    const before = doc();
    const done = perform(createHistory(), before, removeFromBand(before, "band", "agent:r:a2")!);
    expect(done.doc.groups[0]?.members).toEqual(["agent:r:a1", "agent:r:a3"]);
    expect(done.doc.nodes).toEqual(before.nodes);
    expect(undo(done.history, done.doc)!.doc).toEqual(before);
  });
  test("quem já está (ou já não está) na banda devolve undefined", () => {
    expect(addToBand(doc(), "band", "agent:r:a1")).toBeUndefined();
    expect(removeFromBand(solo(), "band", "agent:r:a4")).toBeUndefined();
  });
  test("recusa grupo que não é banda, nó que não é agente, nó inexistente e banda que ficaria com menos de dois", () => {
    expect(code(() => addToBand(doc(), "mixed", "agent:r:a2"))).toBe(ORG_ERRORS.invalidMode);
    expect(code(() => addToBand(doc(), "nope", "agent:r:a2"))).toBe(ORG_ERRORS.unknownGroup);
    expect(code(() => addToBand(solo(), "band", "n1"))).toBe(ORG_ERRORS.invalidMode);
    expect(code(() => addToBand(solo(), "band", "zz"))).toBe(ORG_ERRORS.unknownNode);
    const two = validateCanvasDoc({ ...doc(), groups: [{ id: "band", label: "B", members: ["agent:r:a1", "agent:r:a2"] }] });
    expect(code(() => removeFromBand(two, "band", "agent:r:a1"))).toBe(ORG_ERRORS.invalidMode);
    expect(code(() => removeFromBand(doc(), "mixed", "agent:r:a1"))).toBe(ORG_ERRORS.invalidMode);
  });
});
