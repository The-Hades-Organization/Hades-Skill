// Grupo canvas-area-grow: o terminal que mora numa área cria nós dentro dela (src/lib/canvas-area-grow.ts e o modo `grow`
// de src/lib/canvas-space.ts): cheia, a área cresce e afasta quem está no caminho, num passo só do desfazer; e o contexto
// do Argos que o agente lê (src/lib/canvas-context.ts). Lógica pura.
import { describe, expect, test } from "bun:test";
import { growAreaOps } from "../../../src/lib/canvas-area-grow";
import { AREA_TYPE, areaDataOf, areaMembers } from "../../../src/lib/canvas-areas";
import { argosContext } from "../../../src/lib/canvas-context";
import { type CanvasDoc, type CanvasNode, emptyCanvasDoc, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, invert } from "../../../src/lib/canvas-history";
import { identityPrompt, planNewNote, planRecruit } from "../../../src/lib/canvas-recruit";
import { planNewCardinal } from "../../../src/lib/canvas-recruit-cardinal";

const ORQ = "term-orq";
const SIZE = { w: 400, h: 240 };
const node = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, type: "terminal", x, y, w: SIZE.w, h: SIZE.h, z: 1, data: { name: id }, locked: false, blurred: false, ...extra });
const area = (id: string, x: number, y: number, w: number, h: number, members: string[] = []): CanvasNode =>
  ({ id, type: AREA_TYPE, x, y, w, h, z: -1000, data: areaDataOf({ title: id, color: "chart-1", members }), locked: false, blurred: false });
const orq = node(ORQ, 20, 60, { data: { name: ORQ, orchestrator: true, role: "impl", herdr: { session: "default", pane: "w1:p1" } } });
/** A área `squad` cabe só o orquestrador; abaixo dela, a área `vizinha` com um membro e um nó solto. */
const tight = (): CanvasDoc => ({
  ...emptyCanvasDoc(),
  nodes: [
    area("squad", 0, 0, 440, 320, [ORQ]), orq,
    area("vizinha", 0, 400, 440, 320, ["viz-1"]), node("viz-1", 20, 460),
    node("solto", 0, 800),
    node("longe", 2000, 0),
  ],
});
const overlap = (a: CanvasNode, b: CanvasNode): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const byId = (doc: CanvasDoc, id: string): CanvasNode => doc.nodes.find((n) => n.id === id) as CanvasNode;
const inside = (outer: CanvasNode, inner: CanvasNode): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

describe("área que cresce", () => {
  test("dado o orquestrador numa área cheia, quando recruta, então o recruta nasce nela, ela cresce e quem está abaixo desce sem sobrepor", () => {
    const doc = tight();
    const plan = planRecruit(doc, { orchestratorId: ORQ, data: { name: "r1" }, size: SIZE });
    const next = applyOp(doc, plan.op);
    expect(validateCanvasDoc(next)).toEqual(next);
    const squad = byId(next, "squad");
    const recruit = byId(next, plan.nodeId);
    expect(inside(squad, recruit)).toBe(true);
    expect(areaMembers(next, "squad").map((n) => n.id)).toEqual([ORQ, plan.nodeId]);
    expect(squad.h).toBeGreaterThan(320);
    const vizinha = byId(next, "vizinha");
    expect(overlap(squad, vizinha)).toBe(false);
    expect(byId(next, "viz-1").y - vizinha.y).toBe(60);
    expect(overlap(squad, byId(next, "solto")) || overlap(vizinha, byId(next, "solto"))).toBe(false);
    expect(byId(next, "longe")).toEqual(byId(doc, "longe"));
    expect(applyOp(next, invert(plan.op))).toEqual(doc);
  });

  test("dado o orquestrador numa área cheia, quando cria nota, então a nota entra na área e a área a cobre", () => {
    const doc = tight();
    const plan = planNewNote(doc, { callerId: ORQ, name: "briefing" });
    const next = applyOp(doc, plan.op);
    expect(inside(byId(next, "squad"), byId(next, plan.node.id))).toBe(true);
    expect(areaMembers(next, "squad").map((n) => n.id)).toContain(plan.node.id);
    expect(applyOp(next, invert(plan.op))).toEqual(doc);
  });

  test("dado o orquestrador numa área cheia, quando cria diagrama cardinal, então o nó entra na área, ela o cobre e o desfazer volta ao anterior", () => {
    const doc = tight();
    const plan = planNewCardinal(doc, { callerId: ORQ, name: "modelo", title: "Modelo" });
    const next = applyOp(doc, plan.op);
    expect(validateCanvasDoc(next)).toEqual(next);
    const squad = byId(next, "squad");
    expect(plan.node.type).toBe("cardinal");
    expect(inside(squad, byId(next, plan.node.id))).toBe(true);
    expect(areaMembers(next, "squad").map((n) => n.id)).toContain(plan.node.id);
    expect(squad.h).toBeGreaterThan(320);
    expect(overlap(squad, byId(next, "vizinha"))).toBe(false);
    expect(byId(next, "longe")).toEqual(byId(doc, "longe"));
    expect(next.edges.some((e) => e.from === ORQ && e.to === plan.node.id)).toBe(true);
    expect(applyOp(next, invert(plan.op))).toEqual(doc);
  });

  test("dado o orquestrador fora de área, quando cria diagrama cardinal, então nenhuma área cresce", () => {
    const doc: CanvasDoc = { ...emptyCanvasDoc(), nodes: [node(ORQ, 2000, 2000, { data: orq.data }), area("squad", 0, 0, 440, 320)] };
    const next = applyOp(doc, planNewCardinal(doc, { callerId: ORQ, name: "modelo" }).op);
    expect(byId(next, "squad")).toEqual(byId(doc, "squad"));
  });

  test("dado espaço livre na área, quando recruta, então a área não muda de tamanho", () => {
    const doc: CanvasDoc = { ...emptyCanvasDoc(), nodes: [area("squad", 0, 0, 1400, 900, [ORQ]), orq] };
    const next = applyOp(doc, planRecruit(doc, { orchestratorId: ORQ, data: { name: "r1" }, size: SIZE }).op);
    expect(byId(next, "squad")).toMatchObject({ x: 0, y: 0, w: 1400, h: 900 });
  });

  test("dado um nó travado no caminho, quando a área cresce, então ele não anda", () => {
    const doc: CanvasDoc = { ...emptyCanvasDoc(), nodes: [area("squad", 0, 0, 440, 320, [ORQ]), orq, node("fixo", 0, 400, { locked: true })] };
    const next = applyOp(doc, planRecruit(doc, { orchestratorId: ORQ, data: { name: "r1" }, size: SIZE }).op);
    expect(byId(next, "fixo")).toEqual(byId(doc, "fixo"));
  });

  test("dado o nó que já cabe, quando se pede o crescimento, então nada muda", () => {
    expect(growAreaOps(tight(), "squad", [ORQ])).toEqual([]);
    expect(growAreaOps(tight(), "nao-existe", [ORQ])).toEqual([]);
  });

  test("dado o orquestrador fora de área, quando recruta, então nenhuma área cresce", () => {
    const doc: CanvasDoc = { ...emptyCanvasDoc(), nodes: [node(ORQ, 2000, 2000, { data: orq.data }), area("squad", 0, 0, 440, 320)] };
    const next = applyOp(doc, planRecruit(doc, { orchestratorId: ORQ, data: { name: "r1" }, size: SIZE }).op);
    expect(byId(next, "squad")).toEqual(byId(doc, "squad"));
  });
});

describe("contexto do Argos", () => {
  test("dado o orquestrador numa área, então o contexto diz canvas, papel, área, vizinhos, notas e equipe", () => {
    const doc = tight();
    const lines = argosContext({ canvas: "default", doc, node: orq, prReady: "PR pronta: assignee x." });
    expect(lines[0]).toBe(`Argos: canvas default; você é ${ORQ} (nó ${ORQ}).`);
    expect(lines[1]).toContain("Papel: impl; orquestrador");
    expect(lines.find((l) => l.startsWith("Área:"))).toBe("Área: squad (squad). Também nela: ninguém.");
    expect(lines).toContain("Nenhuma nota ligada a você.");
    expect(lines).toContain("Nenhum recruta por enquanto.");
    expect(lines).toContain("PR pronta: assignee x.");
    expect(lines.at(-1)).toContain("hades canvas context --rules");
  });

  test("dado um nó fora de área, então o contexto diz que ele cria sem área", () => {
    const doc = tight();
    expect(argosContext({ canvas: "c1", doc, node: byId(doc, "solto") })).toContain("Fora de área: o que você criar pela CLI nasce perto de você, sem área.");
  });

  test("dado o recruta numa área, então a identidade cita a área", () => {
    expect(identityPrompt({ name: "r1", role: null, orchestrator: ORQ, notes: [], area: "squad" })).toContain("Você está na área squad do canvas");
    expect(identityPrompt({ name: "r1", role: null, orchestrator: ORQ, notes: [] })).not.toContain("área");
  });
});
