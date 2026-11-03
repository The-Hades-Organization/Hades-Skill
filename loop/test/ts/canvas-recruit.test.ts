// Grupo canvas-recruit: orquestrador no canvas (src/lib/canvas-recruit.ts) e o acesso à nota pela conexão
// (src/lib/canvas-note.ts) — quem comanda quem, o auto-layout dos recrutas abaixo do orquestrador, o plano de cada
// subcomando com ida e volta exata pelo inverso, a identidade do recruta e a cadeia de notas sem laço. Lógica pura.
import { describe, expect, test } from "bun:test";
import { type CanvasDoc, type CanvasEdge, type CanvasNode, emptyCanvasDoc, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, type CanvasOp, invert } from "../../../src/lib/canvas-history";
import { LINK_EDGE_KIND, linkEndOf } from "../../../src/lib/canvas-links";
import { canWriteNote, directNotesOf, hasNoteAccess, NOTE_READER_TYPES, noteChainFrom, readableNotesOf } from "../../../src/lib/canvas-note";
import {
  findByRef, herdrTargetOf, identityPrompt, nodesAtTarget, ORCHESTRATES_EDGE_KIND, orchestrationEdges, orchestratorTerminals, planConnect, planDismiss, planReassign, planRecruit, RECRUIT_EDGE_KIND, RECRUIT_ERRORS, RECRUIT_LAYOUT,
  RecruitError, recruitSlots, recruitsOf, requireOrchestrator, requireRecruit,
} from "../../../src/lib/canvas-recruit";

const ORQ = "term-orq";
const terminal = (id: string, data: Record<string, unknown> = {}, x = 0, y = 0): CanvasNode =>
  ({ id, type: "terminal", x, y, w: 400, h: 240, z: 1, data: { name: id, ...data }, locked: false, blurred: false });
const note = (id: string, file: string): CanvasNode => ({ id, type: "note", x: 900, y: 0, w: 200, h: 120, z: 1, data: { note: file }, locked: false, blurred: false });
const link = (id: string, from: string, to: string): CanvasEdge => ({ id, from, to, kind: LINK_EDGE_KIND });
/** Orquestrador em (0,0) ligado à nota `briefing`; a nota `solta` não liga a ninguém. */
const docOf = (extra: { nodes?: CanvasNode[]; edges?: CanvasEdge[] } = {}): CanvasDoc => ({
  ...emptyCanvasDoc(),
  nodes: [terminal(ORQ, { orchestrator: true, agent: "claude", herdr: { session: "default", pane: "w1:p1" } }), note("n-brief", "briefing"), note("n-solta", "solta"), ...(extra.nodes ?? [])],
  edges: [link("l-brief", ORQ, "n-brief"), ...(extra.edges ?? [])],
});
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof RecruitError) return error.code;
    throw error;
  }
  return undefined;
};
function roundTrip(doc: CanvasDoc, op: CanvasOp): CanvasDoc {
  const next = applyOp(doc, op);
  expect(validateCanvasDoc(next)).toEqual(next);
  expect(applyOp(next, invert(op))).toEqual(doc);
  return next;
}

describe("acesso à nota pela conexão", () => {
  test("os leitores de nota são as pontas 'terminal' das conexões", () => {
    for (const type of NOTE_READER_TYPES) expect(linkEndOf(type)).toBe("terminal");
  });

  test("dado terminal ligado à nota, quando se pergunta o acesso, então lê e escreve só nela", () => {
    const doc = docOf();
    expect(directNotesOf(doc, ORQ)).toEqual(["n-brief"]);
    expect(hasNoteAccess(doc, "n-brief", ORQ)).toBe(true);
    expect(hasNoteAccess(doc, "n-solta", ORQ)).toBe(false);
    expect(canWriteNote(doc, "n-brief", { kind: "agent", id: ORQ })).toBe(true);
    expect(canWriteNote(doc, "n-solta", { kind: "agent", id: ORQ })).toBe(false);
  });

  test("dada cadeia nota↔nota em laço, quando se lê, então cada nota aparece uma vez", () => {
    const doc = docOf({ nodes: [note("n-c", "c")], edges: [link("l1", "n-brief", "n-solta"), link("l2", "n-solta", "n-c"), link("l3", "n-c", "n-brief")] });
    expect(noteChainFrom(doc, "n-brief")).toEqual([{ id: "n-brief", via: null }, { id: "n-solta", via: "n-brief" }, { id: "n-c", via: "n-brief" }]);
    expect(readableNotesOf(doc, ORQ).map((e) => e.id)).toEqual(["n-brief", "n-solta", "n-c"]);
    // a cadeia só se lê: escrever pede conexão direta
    expect(canWriteNote(doc, "n-solta", { kind: "agent", id: ORQ })).toBe(false);
  });

  test("dado o vínculo antigo da nota com o agente (data.agent), então ele conta como conexão direta", () => {
    const agent: CanvasNode = { ...terminal("agent:p:x"), type: "agent", data: {} };
    const bound: CanvasNode = { ...note("n-velha", "velha"), data: { note: "velha", agent: "agent:p:x" } };
    const doc = docOf({ nodes: [agent, bound] });
    expect(directNotesOf(doc, "agent:p:x")).toEqual(["n-velha"]);
    expect(hasNoteAccess(doc, "n-velha", "agent:p:x")).toBe(true);
    expect(directNotesOf(doc, ORQ)).toEqual(["n-brief"]);
  });

  test("dado nó que não lê nota, então não alcança nenhuma", () => {
    expect(directNotesOf(docOf(), "n-brief")).toEqual([]);
    expect(noteChainFrom(docOf(), ORQ)).toEqual([]);
  });
});

describe("quem é quem", () => {
  test("dado o pane do processo, então acha o terminal pelo data.herdr e o agente pelo grafo", () => {
    const agent: CanvasNode = { ...terminal("agent:p:x"), type: "agent", data: {} };
    const doc = docOf({ nodes: [agent] });
    expect(nodesAtTarget(doc, { session: "default", pane: "w1:p1" }).map((n) => n.id)).toEqual([ORQ]);
    expect(nodesAtTarget(doc, { session: "default", pane: "w9:p1" }, new Map([["agent:p:x", { session: "default", pane: "w9:p1" }]])).map((n) => n.id)).toEqual(["agent:p:x"]);
    expect(nodesAtTarget(doc, { session: "outra", pane: "w1:p1" })).toEqual([]);
  });

  test("dado terminal comum, quando comanda, então é recusado como não orquestrador", () => {
    const doc = docOf({ nodes: [terminal("t-comum")] });
    expect(codeOf(() => requireOrchestrator(doc, "t-comum"))).toBe(RECRUIT_ERRORS.notOrchestrator);
    expect(codeOf(() => requireOrchestrator(doc, "n-brief"))).toBe(RECRUIT_ERRORS.notOrchestrator);
    expect(codeOf(() => planRecruit(doc, { orchestratorId: "t-comum", data: {} }))).toBe(RECRUIT_ERRORS.notOrchestrator);
  });

  test("dado recruta de outro orquestrador, quando comanda, então é recusado", () => {
    const doc = docOf({ nodes: [terminal("orq2", { orchestrator: true }), terminal("r-alheio", { recruiter: "orq2" }), terminal("t-dono")] });
    expect(codeOf(() => requireRecruit(doc, ORQ, "r-alheio"))).toBe(RECRUIT_ERRORS.notYourRecruit);
    expect(codeOf(() => requireRecruit(doc, ORQ, "t-dono"))).toBe(RECRUIT_ERRORS.notYourRecruit);
    expect(codeOf(() => requireRecruit(doc, ORQ, "nada"))).toBe(RECRUIT_ERRORS.notRecruit);
    expect(requireRecruit(doc, "orq2", "r-alheio").id).toBe("r-alheio");
  });

  test("dado nome igual ao de um terminal alheio, quando o orquestrador comanda pelo nome, então acha o recruta dele", () => {
    const doc = docOf({ nodes: [terminal("orq2", { orchestrator: true }), terminal("r-meu", { name: "Testador", recruiter: ORQ }),
      terminal("r-alheio", { name: "Testador", recruiter: "orq2" }), terminal("t-dono", { name: "Doc" })] });
    expect(requireRecruit(doc, ORQ, "Testador").id).toBe("r-meu");
    expect(requireRecruit(doc, "orq2", "Testador").id).toBe("r-alheio");
    // o nome existe, mas não entre os recrutas de quem chama
    expect(codeOf(() => requireRecruit(doc, ORQ, "Doc"))).toBe(RECRUIT_ERRORS.notYourRecruit);
  });

  test("dado nome repetido, quando se busca pelo nome, então pede o id", () => {
    const doc = docOf({ nodes: [terminal("a", { name: "igual" }), terminal("b", { name: "igual" })] });
    expect(codeOf(() => findByRef(doc, "igual", () => true))).toBe(RECRUIT_ERRORS.ambiguous);
    expect(findByRef(doc, "a", () => true)?.id).toBe("a");
  });
});

describe("auto-layout", () => {
  const orq = { x: 0, y: 0, w: 400, h: 240 };

  test("dado nenhum recruta, então não há posição", () => {
    expect(recruitSlots(orq, [])).toEqual([]);
  });

  test("dado um recruta, então fica centrado abaixo do orquestrador", () => {
    expect(recruitSlots(orq, [{ w: 400, h: 240 }])).toEqual([{ x: 0, y: 240 + RECRUIT_LAYOUT.gapY }]);
  });

  test("dados dois recrutas, então ficam lado a lado com passo uniforme e centrados", () => {
    const [a, b] = recruitSlots(orq, [{ w: 400, h: 240 }, { w: 400, h: 240 }]);
    const step = 400 + RECRUIT_LAYOUT.gapX;
    expect(b!.x - a!.x).toBe(step);
    expect((a!.x + b!.x + 400) / 2).toBe(200);
    expect(a!.y).toBe(b!.y);
  });

  test("passando de uma fileira, então abre outra abaixo", () => {
    const slots = recruitSlots(orq, Array.from({ length: RECRUIT_LAYOUT.perRow + 1 }, () => ({ w: 400, h: 240 })));
    expect(slots[RECRUIT_LAYOUT.perRow]!.y - slots[0]!.y).toBe(240 + RECRUIT_LAYOUT.gapY);
    expect(slots[RECRUIT_LAYOUT.perRow]!.x).toBe(0);
  });
});

describe("planos dos subcomandos", () => {
  test("recrutar cria nó, aresta de recrutamento e conexão à nota, e desfazer volta exatamente", () => {
    const doc = docOf();
    const { op, nodeId } = planRecruit(doc, { orchestratorId: ORQ, data: { name: "rev" }, notes: ["briefing"] });
    const next = roundTrip(doc, op);
    const made = next.nodes.find((n) => n.id === nodeId)!;
    expect(made.data).toEqual({ name: "rev", recruiter: ORQ });
    expect(next.edges.some((e) => e.kind === RECRUIT_EDGE_KIND && e.from === ORQ && e.to === nodeId)).toBe(true);
    expect(hasNoteAccess(next, "n-brief", nodeId)).toBe(true);
  });

  test("dada a mesma nota pedida duas vezes (pelo nome e pelo id), então o recruta ganha uma conexão só", () => {
    const doc = docOf();
    const { op, nodeId } = planRecruit(doc, { orchestratorId: ORQ, data: { name: "rev" }, notes: ["briefing", "n-brief", "briefing"] });
    const next = roundTrip(doc, op);
    expect(next.edges.filter((e) => e.kind === LINK_EDGE_KIND && (e.from === nodeId || e.to === nodeId))).toHaveLength(1);
  });

  test("o segundo recruta redistribui o primeiro só no recrutamento", () => {
    const first = applyOp(docOf(), planRecruit(docOf(), { orchestratorId: ORQ, data: { name: "a" } }).op);
    const { op, nodeId } = planRecruit(first, { orchestratorId: ORQ, data: { name: "b" } });
    const next = roundTrip(first, op);
    const team = recruitsOf(next, ORQ);
    expect(team.map((n) => n.data.name)).toEqual(["a", "b"]);
    expect(team.map((n) => ({ x: n.x, y: n.y }))).toEqual(recruitSlots(next.nodes[0]!, team));
    expect(team[1]!.id).toBe(nodeId);
  });

  test("nota que não está ligada ao orquestrador não passa ao recruta", () => {
    expect(codeOf(() => planRecruit(docOf(), { orchestratorId: ORQ, data: {}, notes: ["solta"] }))).toBe(RECRUIT_ERRORS.noteNotShared);
    expect(codeOf(() => planRecruit(docOf(), { orchestratorId: ORQ, data: {}, notes: ["nenhuma"] }))).toBe(RECRUIT_ERRORS.missingNote);
  });

  test("connect liga o recruta; já ligado não faz nada", () => {
    const doc = docOf({ nodes: [terminal("r1", { recruiter: ORQ })] });
    const { op } = planConnect(doc, ORQ, "r1", "briefing");
    const next = roundTrip(doc, op!);
    expect(hasNoteAccess(next, "n-brief", "r1")).toBe(true);
    expect(planConnect(next, ORQ, "r1", "n-brief").op).toBeUndefined();
  });

  test("reassign troca só o papel do nó; o mesmo papel não faz nada", () => {
    const doc = docOf({ nodes: [terminal("r1", { recruiter: ORQ, role: "revisor" }, 10, 20)] });
    const next = roundTrip(doc, planReassign(doc, "r1", "testador")!);
    const r1 = next.nodes.find((n) => n.id === "r1")!;
    expect([r1.x, r1.y, r1.data.role, r1.data.name]).toEqual([10, 20, "testador", "r1"]);
    expect(planReassign(doc, "r1", "revisor")).toBeUndefined();
    expect(roundTrip(doc, planReassign(doc, "r1", null)!).nodes.find((n) => n.id === "r1")!.data.role).toBeUndefined();
  });

  test("dismiss tira o nó e as arestas dele, e desfazer devolve", () => {
    const doc = docOf({ nodes: [terminal("r1", { recruiter: ORQ })], edges: [link("l-r1", "r1", "n-brief"), { id: "e-r", from: ORQ, to: "r1", kind: RECRUIT_EDGE_KIND }] });
    const next = roundTrip(doc, planDismiss(doc, "r1"));
    expect(next.nodes.some((n) => n.id === "r1")).toBe(false);
    expect(next.edges.map((e) => e.id)).toEqual(["l-brief"]);
  });
});

describe("identidade do recruta", () => {
  test("leva nome, papel, orquestrador, notas e a tarefa no fim", () => {
    const text = identityPrompt({ name: "rev", role: "revisor", orchestrator: "chefe", notes: ["briefing"], task: "revise o módulo X" });
    expect(text).toContain("Você é rev, recruta do orquestrador chefe");
    expect(text).toContain("Papel: revisor.");
    expect(text).toContain("briefing");
    expect(text.endsWith("revise o módulo X")).toBe(true);
  });

  test("sem papel nem notas, diz isso em vez de inventar", () => {
    const text = identityPrompt({ name: "rev", role: null, orchestrator: "chefe", notes: [] });
    expect(text).toContain("sem papel definido");
    expect(text).toContain("Nenhuma nota ligada");
  });
});

describe("agente alocado pela CLI ligado ao orquestrador (orchestrates)", () => {
  const PAR = { session: "default", pane: "w1:p1" };
  test("dado o par do registro, então valida sessão e pane não vazios e recusa o resto", () => {
    expect(herdrTargetOf(PAR)).toEqual(PAR);
    expect(herdrTargetOf({ session: "default" })).toBeUndefined();
    expect(herdrTargetOf({ session: "", pane: "w1:p1" })).toBeUndefined();
    expect(herdrTargetOf("w1:p1")).toBeUndefined();
    expect(herdrTargetOf(null)).toBeUndefined();
  });
  test("dado agente com o pane do terminal orquestrador, então a aresta sai do terminal para o agente", () => {
    const edges = orchestrationEdges(docOf(), [{ id: "agent:_skill:a1", orchestrator: PAR }, { id: "agent:_skill:a2" }]);
    expect(edges).toEqual([{ from: ORQ, to: "agent:_skill:a1", kind: ORCHESTRATES_EDGE_KIND }]);
    expect(ORCHESTRATES_EDGE_KIND).toBe("orchestrates");
  });
  test("dado pane que nenhum terminal do canvas tem, ou outra sessão, então não há aresta", () => {
    expect(orchestrationEdges(docOf(), [{ id: "agent:_skill:a1", orchestrator: { session: "default", pane: "w9:p9" } }])).toEqual([]);
    expect(orchestrationEdges(docOf(), [{ id: "agent:_skill:a1", orchestrator: { session: "outra", pane: "w1:p1" } }])).toEqual([]);
  });
  test("dado o terminal sem a caixa Orquestrador, então liga do mesmo jeito (quem alocou é quem chamou a CLI)", () => {
    const doc = { ...emptyCanvasDoc(), nodes: [terminal("t1", { herdr: PAR })] };
    expect(orchestratorTerminals(doc, { id: "agent:_skill:a1", orchestrator: PAR }).map((n) => n.id)).toEqual(["t1"]);
  });
});
