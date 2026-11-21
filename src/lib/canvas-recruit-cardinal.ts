// Planos do nó `cardinal` da CLI (`cardinal new|adopt|link|unlink`). Arquivo à parte: o canvas-recruit é importado pela página
// e a lista de módulos da UI não inclui o canvas-cardinal.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNode } from "./canvas-doc.ts";
import { type AtomicOp, type CanvasOp } from "./canvas-history.ts";
import { LINK_EDGE_KIND, opCreateLink, opRemoveLink } from "./canvas-links.ts";
import { CARDINAL_FRAME, CARDINAL_TYPE, createCardinalNode, findCardinalNode, readableCardinalsOf } from "./canvas-cardinal.ts";
import { freshId, noteSlot, RECRUIT_ERRORS, RecruitError, requireOrchestrator, requireRecruit, settleInArea } from "./canvas-recruit.ts";

const fail = (code: (typeof RECRUIT_ERRORS)[keyof typeof RECRUIT_ERRORS]): never => {
  throw new RecruitError(code as never);
};

export interface NewCardinalInput {
  callerId: string;
  /** Nome do arquivo `.cardinal` (o painel o cria à parte). */
  name: string;
  title?: string;
  linkTo?: readonly string[];
}

/**
 * `cardinal new` e `cardinal adopt`: o nó `cardinal` perto do orquestrador, ligado a ele e aos recrutas dele em `linkTo`
 * (`cardinal-access`). Se o orquestrador mora numa área, ela cresce até cobrir o nó. Um lote só: desfazer tira o nó e as ligações.
 */
export function planNewCardinal(doc: CanvasDoc, input: NewCardinalInput): { op: CanvasOp; node: CanvasNode; recruits: CanvasNode[] } {
  const orchestrator = requireOrchestrator(doc, input.callerId);
  const recruits = [...new Map((input.linkTo ?? []).map((ref) => requireRecruit(doc, orchestrator.id, ref)).map((n) => [n.id, n])).values()];
  const top = Math.min(CANVAS_LIMITS.layer - 1, doc.nodes.reduce((z, n) => Math.max(z, n.z), 0));
  const { op, node } = createCardinalNode(doc, { id: freshId(doc, "cardinal-r"), name: input.name, ...(input.title !== undefined && { title: input.title }), ...noteSlot(doc, orchestrator, CARDINAL_FRAME), z: top + 1 });
  const ops: AtomicOp[] = [op];
  let next = { ...doc, nodes: [...doc.nodes, node] };
  for (const from of new Set([orchestrator.id, ...recruits.map((n) => n.id)])) {
    const link = opCreateLink(next, { id: freshId(next, "link-r"), from, to: node.id });
    ops.push(link);
    if (link.kind === "edge-create") next = { ...next, edges: [...next.edges, link.edge.item] };
  }
  return { op: settleInArea(doc, ops, orchestrator, [node.id]), node, recruits };
}

/** O diagrama pelo id do nó ou pelo nome do arquivo (`data.cardinal`). */
export function findCardinal(doc: CanvasDoc, ref: string): CanvasNode | undefined {
  const nodes = doc.nodes.filter((node) => node.type === CARDINAL_TYPE && findCardinalNode(doc, node.id) !== undefined);
  return nodes.find((node) => node.id === ref) ?? nodes.find((node) => findCardinalNode(doc, node.id)?.data.cardinal === ref);
}

/** `cardinal link`: liga o recruta a um diagrama já ligado ao orquestrador. Já ligados: `op` indefinido. */
export function planLinkCardinal(doc: CanvasDoc, callerId: string, recruitRef: string, cardinalRef: string): { op: AtomicOp | undefined; recruit: CanvasNode; cardinal: CanvasNode } {
  const recruit = requireRecruit(doc, callerId, recruitRef);
  const cardinal = findCardinal(doc, cardinalRef);
  if (!cardinal || !readableCardinalsOf(doc, callerId).some((entry) => entry.id === cardinal.id && entry.via === null)) return fail(RECRUIT_ERRORS.missingCardinal);
  if (doc.edges.some((edge) => edge.kind === LINK_EDGE_KIND && ((edge.from === recruit.id && edge.to === cardinal.id) || (edge.to === recruit.id && edge.from === cardinal.id)))) return { op: undefined, recruit, cardinal };
  return { op: opCreateLink(doc, { id: freshId(doc, "link-r"), from: recruit.id, to: cardinal.id }), recruit, cardinal };
}

/** `cardinal unlink`: tira a ligação entre o recruta e o diagrama; sem ligação: `op` indefinido. */
export function planUnlinkCardinal(doc: CanvasDoc, callerId: string, recruitRef: string, cardinalRef: string): { op: AtomicOp | undefined; recruit: CanvasNode; cardinal: CanvasNode } {
  const recruit = requireRecruit(doc, callerId, recruitRef);
  const cardinal = findCardinal(doc, cardinalRef) ?? fail(RECRUIT_ERRORS.missingCardinal);
  const edge = doc.edges.find((e) => e.kind === LINK_EDGE_KIND && ((e.from === recruit.id && e.to === cardinal.id) || (e.to === recruit.id && e.from === cardinal.id)));
  return { op: edge ? opRemoveLink(doc, edge.id) : undefined, recruit, cardinal };
}
