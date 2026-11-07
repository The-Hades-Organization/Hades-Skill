// Grupo canvas-space: vaga livre para nó criado por agente (src/lib/canvas-space.ts) e o uso dela em recrutar, trazer
// terminal, nota nova e sincronia de agentes. Lógica pura: nenhum nó novo cai em cima de outro nó nem de uma área.
import { describe, expect, test } from "bun:test";
import { AREA_TYPE, areaDataOf, areaMembers } from "../../../src/lib/canvas-areas";
import { type CanvasDoc, type CanvasNode, emptyCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, invert } from "../../../src/lib/canvas-history";
import { LAYOUT_GAP } from "../../../src/lib/canvas-layout";
import { JOIN_NODE_SIZE, planJoin, planNewNote, planRecruit, RECRUIT_LAYOUT, recruitSlots } from "../../../src/lib/canvas-recruit";
import { findFreeBox } from "../../../src/lib/canvas-space";

const GAP = { x: RECRUIT_LAYOUT.gapX, y: RECRUIT_LAYOUT.gapY };
const SIZE = { w: 400, h: 240 };
const ORQ = "term-orq";
const node = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, type: "terminal", x, y, w: SIZE.w, h: SIZE.h, z: 1, data: { name: id }, locked: false, blurred: false, ...extra });
const area = (id: string, x: number, y: number, w: number, h: number, members: string[] = []): CanvasNode =>
  ({ id, type: AREA_TYPE, x, y, w, h, z: -1, data: areaDataOf({ title: id, color: "chart-1", members }), locked: false, blurred: false });
const docOf = (...nodes: CanvasNode[]): CanvasDoc => ({ ...emptyCanvasDoc(), nodes: [node(ORQ, 0, 0, { data: { name: ORQ, orchestrator: true, herdr: { session: "default", pane: "w1:p1" } } }), ...nodes] });
const overlap = (a: CanvasNode, b: CanvasNode): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const solids = (doc: CanvasDoc): CanvasNode[] => doc.nodes.filter((n) => n.type !== AREA_TYPE);
const clashes = (doc: CanvasDoc): string[][] => {
  const out: string[][] = [];
  const all = doc.nodes;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (overlap(all[i] as CanvasNode, all[j] as CanvasNode)) out.push([(all[i] as CanvasNode).id, (all[j] as CanvasNode).id]);
  return out;
};

describe("findFreeBox", () => {
  test("dado o espaço de baixo livre, quando se procura, então vale a vaga preferida do chamador", () => {
    const doc = docOf();
    const preferred = recruitSlots(doc.nodes[0] as CanvasNode, [SIZE])[0] as { x: number; y: number };
    expect(findFreeBox(doc, SIZE, { anchor: doc.nodes[0] as CanvasNode, prefer: "below", gap: GAP, candidates: [preferred] })).toEqual(preferred);
  });

  test("dada a vaga preferida ocupada por outro nó, quando se procura, então a vaga nova não encosta em ninguém", () => {
    const orq = docOf().nodes[0] as CanvasNode;
    const preferred = recruitSlots(orq, [SIZE])[0] as { x: number; y: number };
    const doc = docOf(node("intruso", preferred.x, preferred.y));
    const at = findFreeBox(doc, SIZE, { anchor: orq, prefer: "below", gap: GAP, candidates: [preferred] });
    expect(at).not.toEqual(preferred);
    expect(clashes({ ...doc, nodes: [...doc.nodes, node("novo", at.x, at.y)] })).toEqual([]);
  });

  test("dado o mesmo documento, quando se procura duas vezes, então a resposta é a mesma", () => {
    const doc = docOf(node("a", -100, 400), node("b", 400, 400));
    const options = { anchor: doc.nodes[0] as CanvasNode, prefer: "below" as const, gap: GAP };
    expect(findFreeBox(doc, SIZE, options)).toEqual(findFreeBox(doc, SIZE, options));
  });

  test("dado o preferido 'acima', quando há espaço, então a vaga fica acima do âncora", () => {
    const doc = docOf();
    const at = findFreeBox(doc, SIZE, { anchor: doc.nodes[0] as CanvasNode, prefer: "above", gap: GAP });
    expect(at.y + SIZE.h).toBeLessThanOrEqual(0);
  });

  test("dadas vagas que o chamador já tomou (extra), quando se procura, então elas contam como ocupadas", () => {
    const doc = docOf();
    const orq = doc.nodes[0] as CanvasNode;
    const preferred = recruitSlots(orq, [SIZE])[0] as { x: number; y: number };
    const at = findFreeBox(doc, SIZE, { anchor: orq, prefer: "below", gap: GAP, candidates: [preferred], extra: [{ ...preferred, ...SIZE }] });
    expect(at).not.toEqual(preferred);
  });

  test("dado um orquestrador dentro de uma área, quando se procura, então a vaga fica dentro da área e fora do título", () => {
    const frame = area("a1", -100, -100, 1400, 900);
    const doc = docOf(frame);
    const at = findFreeBox(doc, SIZE, { anchor: doc.nodes[0] as CanvasNode, prefer: "below", gap: GAP });
    expect(at.x).toBeGreaterThanOrEqual(frame.x);
    expect(at.x + SIZE.w).toBeLessThanOrEqual(frame.x + frame.w);
    expect(at.y + SIZE.h).toBeLessThanOrEqual(frame.y + frame.h);
  });

  test("dada a área cheia, quando se procura, então a vaga sai da área sem tocá-la", () => {
    const frame = area("a1", -50, -50, 520, 330);
    const doc = docOf(frame);
    const at = findFreeBox(doc, SIZE, { anchor: doc.nodes[0] as CanvasNode, prefer: "below", gap: GAP });
    const placed = node("novo", at.x, at.y);
    expect(overlap(placed, frame)).toBe(false);
    expect(clashes({ ...doc, nodes: [...solids(doc), placed] })).toEqual([]);
  });

  test("dado um orquestrador fora de qualquer área, quando se procura, então nenhuma vaga invade uma área alheia", () => {
    const frame = area("a1", -100, 330, 1400, 900);
    const doc = docOf(frame);
    const at = findFreeBox(doc, SIZE, { anchor: doc.nodes[0] as CanvasNode, prefer: "below", gap: GAP });
    expect(overlap(node("novo", at.x, at.y), frame)).toBe(false);
  });

  test("dada vizinhança toda tomada, quando se procura, então cai na faixa abaixo de todo o conteúdo", () => {
    const wall = Array.from({ length: 30 * 45 }, (_, k) => node(`w${k}`, -7000 + (k % 30) * 480, -7000 + Math.floor(k / 30) * 336));
    const doc = docOf(...wall);
    const at = findFreeBox(doc, SIZE, { anchor: doc.nodes[0] as CanvasNode, prefer: "below", gap: GAP });
    const bottom = Math.max(...doc.nodes.map((n) => n.y + n.h));
    expect(at.y).toBe(bottom + LAYOUT_GAP);
  });

  test("dado documento sem nó além do âncora vazio, quando a lista é vazia, então não quebra", () => {
    const doc = { ...emptyCanvasDoc(), nodes: [] };
    expect(findFreeBox(doc, SIZE, { anchor: { x: 0, y: 0, ...SIZE }, prefer: "below", gap: GAP })).toEqual({ x: 0, y: SIZE.h + GAP.y });
  });
});

describe("recrutar sem sobrepor", () => {
  test("dado um nó parado onde a grade cairia, quando se recruta, então o recruta novo nasce livre e a equipe não anda", () => {
    const orq = docOf().nodes[0] as CanvasNode;
    const preferred = recruitSlots(orq, [SIZE])[0] as { x: number; y: number };
    const doc = docOf(node("intruso", preferred.x, preferred.y));
    const plan = planRecruit(doc, { orchestratorId: ORQ, data: { name: "r1" } });
    const next = applyOp(doc, plan.op);
    expect(clashes(next)).toEqual([]);
    expect(next.nodes.find((n) => n.id === "intruso")).toEqual(doc.nodes.find((n) => n.id === "intruso"));
    expect(applyOp(next, invert(plan.op))).toEqual(doc);
  });

  test("dados oito recrutas em sequência com um obstáculo no caminho, então nenhum nó se sobrepõe", () => {
    let doc = docOf(node("obstaculo", 300, 400, { w: 700, h: 300 }));
    for (let i = 0; i < 8; i++) doc = applyOp(doc, planRecruit(doc, { orchestratorId: ORQ, data: { name: `r${i}` } }).op);
    expect(doc.nodes).toHaveLength(10);
    expect(clashes(doc)).toEqual([]);
  });

  test("dada uma equipe de recrutas, quando a grade recentrada fica livre, então ela segue recentrando como antes", () => {
    let doc = docOf();
    for (let i = 0; i < 3; i++) doc = applyOp(doc, planRecruit(doc, { orchestratorId: ORQ, data: { name: `r${i}` } }).op);
    const team = doc.nodes.filter((n) => n.id.startsWith("term-r"));
    expect(team.map((n) => ({ x: n.x, y: n.y }))).toEqual(recruitSlots(doc.nodes[0] as CanvasNode, team));
  });

  test("dado um orquestrador numa área, quando se recruta, então o recruta nasce dentro dela e entra nos membros", () => {
    const frame = area("a1", -100, -100, 1400, 900);
    const doc = docOf(frame);
    const plan = planRecruit(doc, { orchestratorId: ORQ, data: { name: "r1" } });
    const next = applyOp(doc, plan.op);
    expect(areaMembers(next, "a1").map((n) => n.id)).toContain(plan.nodeId);
    expect(clashes({ ...next, nodes: solids(next) })).toEqual([]);
    expect(applyOp(next, invert(plan.op))).toEqual(doc);
  });
});

describe("nota nova e terminal trazido sem sobrepor", () => {
  test("dada a vaga acima do orquestrador tomada, quando se cria a nota, então ela nasce livre", () => {
    const doc = docOf(node("acima", -20, -340));
    const { op } = planNewNote(doc, { callerId: ORQ, name: "andamento" });
    expect(clashes(applyOp(doc, op))).toEqual([]);
  });

  test("dado join com --to e a vaga da grade tomada, então o terminal trazido nasce livre", () => {
    const orq = docOf().nodes[0] as CanvasNode;
    const preferred = recruitSlots(orq, [JOIN_NODE_SIZE])[0] as { x: number; y: number };
    const doc = docOf(node("intruso", preferred.x, preferred.y));
    const plan = planJoin(doc, { target: { session: "default", pane: "w9:p9" }, data: { name: "extra" }, to: ORQ });
    expect(plan.op).toBeDefined();
    expect(clashes(applyOp(doc, plan.op as NonNullable<typeof plan.op>))).toEqual([]);
  });
});
