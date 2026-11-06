// Orquestrador no canvas do Argos (reference/argos.md §Orquestrador no canvas, D7): quem é orquestrador e quem é recruta
// de quem, quem pode comandar quem, o auto-layout dos recrutas abaixo do orquestrador e a identidade que o recruta recebe no
// prompt inicial. Lógica pura, sem Node/DOM: a CLI `hades canvas` e o painel usam o mesmo módulo. Toda mudança do
// documento sai como `CanvasOp` de `canvas-history` (desfazer volta exatamente ao anterior).
import { CANVAS_LIMITS, type CanvasDoc, type CanvasEdge, type CanvasNode, paneKey } from "./canvas-doc.ts";
import { type AtomicOp, type CanvasOp, opBatch, opCreate, opDelete, opMove, opUpdate } from "./canvas-history.ts";
import { opCreateLink } from "./canvas-links.ts";
import { createNoteNode, directNotesOf, hasNoteAccess, NOTE_READER_TYPES, NOTE_TYPE, requireNoteName } from "./canvas-note.ts";

/** O nó que a ferramenta Terminal cria; só ele vira orquestrador ou recruta (tem processo que o canvas criou). */
export const TERMINAL_NODE_TYPE = "terminal";
/** Aresta do orquestrador para o recruta: hierarquia desenhada, sem leitor (não é `link`: terminal↔terminal segue recusado). */
export const RECRUIT_EDGE_KIND = "recruit";
/**
 * Aresta do orquestrador para o agente que ele alocou pela CLI (`hades agent new|skill-new|review|adopt` chamado de um pane
 * do herdr): o registro do agente guarda o par do pane de quem chamou (`orchestrator`) e a ligação nasce dele, sem passo manual.
 */
export const ORCHESTRATES_EDGE_KIND = "orchestrates";

export const RECRUIT_LAYOUT = {
  /** Espaço entre recrutas lado a lado e entre o orquestrador e a primeira fileira. */
  gapX: 48,
  gapY: 96,
  /** Recrutas por fileira; passando disso, abre outra fileira abaixo. */
  perRow: 4,
} as const;

/** Códigos estáveis: só ganham valores. */
export const RECRUIT_ERRORS = {
  notInCanvas: "recruit_not_in_canvas",
  notOrchestrator: "recruit_not_orchestrator",
  notRecruit: "recruit_not_recruit",
  notYourRecruit: "recruit_not_yours",
  missingNote: "recruit_missing_note",
  noteNotShared: "recruit_note_not_shared",
  ambiguous: "recruit_ambiguous",
  notOrchestratorTarget: "recruit_join_target_not_orchestrator",
  noteExists: "recruit_note_exists",
} as const;
export type RecruitErrorCode = (typeof RECRUIT_ERRORS)[keyof typeof RECRUIT_ERRORS];

export const RECRUIT_ERROR_TEXT: Readonly<Record<RecruitErrorCode, string>> = {
  [RECRUIT_ERRORS.notInCanvas]: "o seu terminal não está em nenhum canvas do painel",
  [RECRUIT_ERRORS.notOrchestrator]: "só o terminal com a caixa Orquestrador ligada comanda recrutas",
  [RECRUIT_ERRORS.notRecruit]: "recruta não encontrado no canvas",
  [RECRUIT_ERRORS.notYourRecruit]: "esse terminal não é recruta seu: só o orquestrador que o criou o comanda",
  [RECRUIT_ERRORS.missingNote]: "nota não encontrada no canvas",
  [RECRUIT_ERRORS.noteNotShared]: "a nota não está ligada ao orquestrador: ligue-a a você antes de passá-la ao recruta",
  [RECRUIT_ERRORS.ambiguous]: "mais de um nó com esse nome: use o id do nó",
  [RECRUIT_ERRORS.notOrchestratorTarget]: "--to pede um orquestrador deste canvas (nó terminal com a caixa Orquestrador): nome ou id não encontrado",
  [RECRUIT_ERRORS.noteExists]: "já existe uma nota com esse nome (no canvas ou em arquivo): escolha outro nome",
};

export class RecruitError extends Error {
  readonly code: RecruitErrorCode;
  constructor(code: RecruitErrorCode) {
    super(RECRUIT_ERROR_TEXT[code]);
    this.name = "RecruitError";
    this.code = code;
  }
}

const fail = (code: RecruitErrorCode): never => {
  throw new RecruitError(code);
};

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
const dataOf = (node: CanvasNode): Dict => (isDict(node.data) ? node.data : {});

export interface HerdrTarget {
  session: string;
  pane: string;
}

/** O par do herdr gravado no nó `terminal` (`data.herdr`), ou `undefined`. */
export function terminalTargetOf(node: CanvasNode): HerdrTarget | undefined {
  if (node.type !== TERMINAL_NODE_TYPE) return undefined;
  const herdr = dataOf(node).herdr;
  return isDict(herdr) && typeof herdr.session === "string" && typeof herdr.pane === "string" ? { session: herdr.session, pane: herdr.pane } : undefined;
}

/** O nome que o nó mostra (`data.name` do terminal; o id para os demais). */
export function nodeName(node: CanvasNode): string {
  const name = dataOf(node).name;
  return typeof name === "string" && name.trim() ? name.trim() : node.id;
}

export const isOrchestrator = (node: CanvasNode | undefined): boolean => node?.type === TERMINAL_NODE_TYPE && dataOf(node).orchestrator === true;

/** O id do orquestrador que criou o recruta, ou `undefined`. */
export function recruiterOf(node: CanvasNode | undefined): string | undefined {
  if (!node || node.type !== TERMINAL_NODE_TYPE) return undefined;
  const by = dataOf(node).recruiter;
  return typeof by === "string" && by ? by : undefined;
}

/** O par `{session, pane}` válido de um valor solto (o `orchestrator` do registro ou do nó do grafo), ou `undefined`. */
export function herdrTargetOf(value: unknown): HerdrTarget | undefined {
  return isDict(value) && typeof value.session === "string" && value.session !== "" && typeof value.pane === "string" && value.pane !== ""
    ? { session: value.session, pane: value.pane }
    : undefined;
}

const sameTarget = (a: HerdrTarget | undefined, b: HerdrTarget | undefined): boolean =>
  a !== undefined && b !== undefined && a.session === b.session && a.pane === b.pane;

/** Nó do grafo vivo como o canvas o recebe: o id e, no agente alocado por um orquestrador, o par do pane dele. */
export interface OrchestratedRef {
  id: string;
  orchestrator?: unknown;
}

/** Os terminais do documento que são o orquestrador do agente (o pane do terminal é o que o registro do agente gravou). */
export function orchestratorTerminals(doc: CanvasDoc, ref: OrchestratedRef): CanvasNode[] {
  const target = herdrTargetOf(ref.orchestrator);
  if (target === undefined) return [];
  return doc.nodes.filter((node) => node.id !== ref.id && sameTarget(terminalTargetOf(node), target));
}

/**
 * Arestas `orchestrates` terminal → agente para os nós do grafo que vieram de um orquestrador com nó `terminal` neste
 * documento. Agente → agente sai do próprio grafo; aqui só o terminal do canvas, que o servidor não conhece.
 */
export function orchestrationEdges(doc: CanvasDoc, graphNodes: readonly OrchestratedRef[]): { from: string; to: string; kind: string }[] {
  const edges: { from: string; to: string; kind: string }[] = [];
  for (const ref of graphNodes) for (const terminal of orchestratorTerminals(doc, ref)) edges.push({ from: terminal.id, to: ref.id, kind: ORCHESTRATES_EDGE_KIND });
  return edges;
}

/** Os recrutas do orquestrador, na ordem do documento. */
export const recruitsOf = (doc: CanvasDoc, orchestratorId: string): CanvasNode[] => doc.nodes.filter((node) => recruiterOf(node) === orchestratorId);

/**
 * Os nós do documento que são o processo no par `{session, pane}`: o terminal pelo `data.herdr`, e o agente do grafo pelo
 * par que o grafo vivo dá (`graphTargets`, id do nó → par).
 */
export function nodesAtTarget(doc: CanvasDoc, target: HerdrTarget, graphTargets: ReadonlyMap<string, HerdrTarget> = new Map()): CanvasNode[] {
  const same = (t: HerdrTarget | undefined): boolean => t !== undefined && t.session === target.session && t.pane === target.pane;
  return doc.nodes.filter((node) => NOTE_READER_TYPES.includes(node.type) && (same(terminalTargetOf(node)) || (node.type !== TERMINAL_NODE_TYPE && same(graphTargets.get(node.id)))));
}

/** O nó pelo id, ou pelo nome (único) entre os do tipo pedido; nome repetido é ambíguo. */
export function findByRef(doc: CanvasDoc, ref: string, accept: (node: CanvasNode) => boolean): CanvasNode | undefined {
  const byId = doc.nodes.find((node) => node.id === ref && accept(node));
  if (byId) return byId;
  const named = doc.nodes.filter((node) => accept(node) && nodeName(node) === ref);
  if (named.length > 1) return fail(RECRUIT_ERRORS.ambiguous);
  return named[0];
}

/** A nota pelo id do nó ou pelo nome do arquivo dela (`data.note`). */
export function findNote(doc: CanvasDoc, ref: string): CanvasNode | undefined {
  const notes = doc.nodes.filter((node) => node.type === NOTE_TYPE);
  return notes.find((node) => node.id === ref) ?? notes.find((node) => dataOf(node).note === ref);
}

/** O orquestrador que chama; agente comum (ou nó que não é terminal) é recusado. */
export function requireOrchestrator(doc: CanvasDoc, callerId: string): CanvasNode {
  const caller = doc.nodes.find((node) => node.id === callerId);
  return isOrchestrator(caller) ? (caller as CanvasNode) : fail(RECRUIT_ERRORS.notOrchestrator);
}

/**
 * O recruta `ref` do orquestrador `callerId`: o chamador tem de ser orquestrador e o recruta, dele. O nome se procura só
 * entre os recrutas dele (o mesmo nome num terminal alheio não o torna ambíguo); terminal alheio com o id ou o nome pedido
 * é recusado como de outro.
 */
export function requireRecruit(doc: CanvasDoc, callerId: string, ref: string): CanvasNode {
  requireOrchestrator(doc, callerId);
  const isTerminal = (n: CanvasNode): boolean => n.type === TERMINAL_NODE_TYPE;
  const mine = findByRef(doc, ref, (n) => isTerminal(n) && recruiterOf(n) === callerId);
  if (mine) return mine;
  const other = doc.nodes.some((n) => isTerminal(n) && (n.id === ref || nodeName(n) === ref));
  return fail(other ? RECRUIT_ERRORS.notYourRecruit : RECRUIT_ERRORS.notRecruit);
}

// ---- auto-layout ----

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Onde cada um dos `sizes` fica abaixo do orquestrador: fileiras de até `perRow`, centradas sob ele, com passo uniforme
 * (o maior tamanho mais o espaço). A ordem é a dos recrutas (o primeiro à esquerda na primeira fileira).
 */
export function recruitSlots(orchestrator: Box, sizes: readonly { w: number; h: number }[]): { x: number; y: number }[] {
  if (sizes.length === 0) return [];
  const stepX = Math.max(...sizes.map((s) => s.w)) + RECRUIT_LAYOUT.gapX;
  const stepY = Math.max(...sizes.map((s) => s.h)) + RECRUIT_LAYOUT.gapY;
  const center = orchestrator.x + orchestrator.w / 2;
  const top = orchestrator.y + orchestrator.h + RECRUIT_LAYOUT.gapY;
  return sizes.map((size, i) => {
    const row = Math.floor(i / RECRUIT_LAYOUT.perRow);
    const inRow = Math.min(RECRUIT_LAYOUT.perRow, sizes.length - row * RECRUIT_LAYOUT.perRow);
    const col = i % RECRUIT_LAYOUT.perRow;
    const slotCenter = center + (col - (inRow - 1) / 2) * stepX;
    return { x: Math.round(slotCenter - size.w / 2), y: Math.round(top + row * stepY) };
  });
}

/** Primeiro id livre `<prefixo><n>` (n ≥ 1) entre os nós e as arestas do documento. */
export function freshId(doc: CanvasDoc, prefix: string): string {
  const taken = new Set([...doc.nodes.map((n) => n.id), ...doc.edges.map((e) => e.id)]);
  let i = 1;
  while (taken.has(`${prefix}${i}`)) i += 1;
  return `${prefix}${i}`;
}

export interface RecruitInput {
  orchestratorId: string;
  /** `data` do nó novo (nome, agente, papel, `herdr`…); `recruiter` é posto aqui. */
  data: Dict;
  /** Tamanho do nó novo (padrão: o do orquestrador). */
  size?: { w: number; h: number };
  /** Notas já ligadas ao orquestrador que o recruta recebe ao nascer. */
  notes?: readonly string[];
  /** Nome de uma nota de andamento nova, ligada ao recruta e ao orquestrador no mesmo lote. */
  newNote?: string;
}

/**
 * O passo do recrutamento: o nó novo (com `recruiter`), a aresta do orquestrador até ele, as conexões às notas pedidas e o
 * auto-layout de todos os recrutas daquele orquestrador. Um lote só: desfazer tira o recruta e devolve as posições.
 */
export function planRecruit(doc: CanvasDoc, input: RecruitInput): { op: CanvasOp; nodeId: string; noteId?: string } {
  const orchestrator = requireOrchestrator(doc, input.orchestratorId);
  if (input.newNote !== undefined) requireFreshNoteName(doc, input.newNote);
  // a mesma nota pedida duas vezes (pelo nome e pelo id, ou repetida) vira uma conexão só
  const notes = [...new Map((input.notes ?? []).map((ref) => requireSharedNote(doc, orchestrator.id, ref)).map((n) => [n.id, n])).values()];
  const size = input.size ?? { w: orchestrator.w, h: orchestrator.h };
  const nodeId = freshId(doc, "term-r");
  const team = recruitsOf(doc, orchestrator.id);
  const slots = recruitSlots(orchestrator, [...team.map((n) => ({ w: n.w, h: n.h })), size]);
  const slot = slots[slots.length - 1] as { x: number; y: number };
  const top = Math.min(CANVAS_LIMITS.layer - 1, doc.nodes.reduce((z, n) => Math.max(z, n.z), 0));
  const node: CanvasNode = {
    id: nodeId, type: TERMINAL_NODE_TYPE, x: slot.x, y: slot.y, w: size.w, h: size.h, z: top + 1,
    data: { ...input.data, recruiter: orchestrator.id }, locked: false, blurred: false,
  };
  const edge: CanvasEdge = { id: freshId(doc, "recruit-e"), from: orchestrator.id, to: nodeId, kind: RECRUIT_EDGE_KIND };
  const ops: AtomicOp[] = [opCreate(doc, [node], [edge])];
  let next = { ...doc, nodes: [...doc.nodes, node], edges: [...doc.edges, edge] };
  for (const note of notes) {
    const op = opCreateLink(next, { id: freshId(next, "link-r"), from: nodeId, to: note.id });
    ops.push(op);
    if (op.kind === "edge-create") next = { ...next, edges: [...next.edges, op.edge.item] };
  }
  const progress = input.newNote === undefined ? undefined : planNoteNode(next, orchestrator, input.newNote, [orchestrator.id, nodeId]);
  if (progress) ops.push(...progress.ops);
  team.forEach((member, i) => {
    const to = slots[i] as { x: number; y: number };
    if (member.x !== to.x || member.y !== to.y) ops.push(opMove(doc, member.id, to));
  });
  return { op: opBatch(ops), nodeId, ...(progress && { noteId: progress.node.id }) };
}

/** Recusa nome fora do formato (`note_invalid_name`) e nome que já é nota do documento; o arquivo se confere na rota. */
export function requireFreshNoteName(doc: CanvasDoc, name: string): string {
  requireNoteName(name);
  return findNote(doc, name) === undefined ? name : fail(RECRUIT_ERRORS.noteExists);
}

/**
 * Onde a nota nova do orquestrador fica: a mesma grade dos recrutas (`recruitSlots`, passo e colunas), espelhada para cima
 * dele, para não cair em cima dos recrutas, que ocupam as fileiras de baixo. A posição conta as notas já ligadas direto a ele.
 */
export function noteSlot(doc: CanvasDoc, orchestrator: CanvasNode, size: { w: number; h: number }): { x: number; y: number } {
  const placed = directNotesOf(doc, orchestrator.id).flatMap((id) => doc.nodes.filter((n) => n.id === id));
  const sizes = [...placed.map((n) => ({ w: n.w, h: n.h })), size];
  // fileiras sempre cheias: o centramento de uma fileira incompleta deslocaria as notas que já estão no lugar
  const full = Array.from({ length: Math.ceil(sizes.length / RECRUIT_LAYOUT.perRow) * RECRUIT_LAYOUT.perRow }, (_, i) => sizes[i] ?? size);
  const slot = recruitSlots(orchestrator, full)[sizes.length - 1] as { x: number; y: number };
  const below = orchestrator.y + orchestrator.h + RECRUIT_LAYOUT.gapY;
  return { x: slot.x, y: orchestrator.y - RECRUIT_LAYOUT.gapY - size.h - (slot.y - below) };
}

/** O nó `note` novo perto do orquestrador, com uma ligação de cada nó em `linkFrom` até ele; as operações seguem o documento que cada uma viu. */
function planNoteNode(doc: CanvasDoc, orchestrator: CanvasNode, name: string, linkFrom: readonly string[]): { ops: AtomicOp[]; node: CanvasNode } {
  const frame = NEW_NOTE_SIZE;
  const top = Math.min(CANVAS_LIMITS.layer - 1, doc.nodes.reduce((z, n) => Math.max(z, n.z), 0));
  const { op, node } = createNoteNode(doc, { id: freshId(doc, "note-r"), note: name, ...noteSlot(doc, orchestrator, frame), ...frame, z: top + 1 });
  const ops: AtomicOp[] = [op];
  let next = { ...doc, nodes: [...doc.nodes, node] };
  for (const from of new Set(linkFrom)) {
    const link = opCreateLink(next, { id: freshId(next, "link-r"), from, to: node.id });
    ops.push(link);
    if (link.kind === "edge-create") next = { ...next, edges: [...next.edges, link.edge.item] };
  }
  return { ops, node };
}

/** Tamanho do nó de uma nota criada pela CLI (o mesmo da ferramenta Nota). */
const NEW_NOTE_SIZE = Object.freeze({ w: 280, h: 200 });

/**
 * `note new`: o nó `note` novo perto do orquestrador, ligado a ele e aos recrutas dele em `linkTo` (mesma regra e mesmas
 * recusas do `connect`). Um lote só: desfazer tira a nota e as ligações; o arquivo nasce na primeira gravação.
 */
export function planNewNote(doc: CanvasDoc, input: { callerId: string; name: string; linkTo?: readonly string[] }): { op: CanvasOp; node: CanvasNode; recruits: CanvasNode[] } {
  const orchestrator = requireOrchestrator(doc, input.callerId);
  const recruits = [...new Map((input.linkTo ?? []).map((ref) => requireRecruit(doc, orchestrator.id, ref)).map((n) => [n.id, n])).values()];
  requireFreshNoteName(doc, input.name);
  const { ops, node } = planNoteNode(doc, orchestrator, input.name, [orchestrator.id, ...recruits.map((n) => n.id)]);
  return { op: opBatch(ops), node, recruits };
}

/** A nota que o orquestrador pode passar ao recruta: existe e está ligada direto a ele. */
export function requireSharedNote(doc: CanvasDoc, orchestratorId: string, ref: string): CanvasNode {
  const note = findNote(doc, ref) ?? fail(RECRUIT_ERRORS.missingNote);
  if (!hasNoteAccess(doc, note.id, orchestratorId)) return fail(RECRUIT_ERRORS.noteNotShared);
  return note;
}

/** `connect`: liga o recruta a uma nota já ligada ao orquestrador. Já ligados: `undefined` (nada a fazer). */
export function planConnect(doc: CanvasDoc, callerId: string, recruitRef: string, noteRef: string): { op: AtomicOp | undefined; recruit: CanvasNode; note: CanvasNode } {
  const recruit = requireRecruit(doc, callerId, recruitRef);
  const note = requireSharedNote(doc, callerId, noteRef);
  if (hasNoteAccess(doc, note.id, recruit.id)) return { op: undefined, recruit, note };
  return { op: opCreateLink(doc, { id: freshId(doc, "link-r"), from: recruit.id, to: note.id }), recruit, note };
}

/** `dismiss`: tira o nó do recruta (com as arestas dele). O processo fecha antes, pela rota de fechar (D2). */
export const planDismiss = (doc: CanvasDoc, recruitId: string): AtomicOp => opDelete(doc, [recruitId]);

/** `reassign`: o papel novo no `data` do nó (`null` tira); posição, nome e conexões ficam. */
export function planReassign(doc: CanvasDoc, recruitId: string, role: string | null): AtomicOp | undefined {
  const node = doc.nodes.find((n) => n.id === recruitId) ?? fail(RECRUIT_ERRORS.notRecruit);
  const data = { ...dataOf(node) };
  if ((data.role ?? null) === role) return undefined;
  if (role === null) delete data.role;
  else data.role = role;
  return opUpdate(doc, recruitId, data);
}

// ---- join e leave ----

/** Tamanho do nó de um terminal trazido por `join` (o mesmo da ferramenta Terminal). */
export const JOIN_NODE_SIZE = Object.freeze({ w: 640, h: 420 });

export interface JoinInput {
  target: HerdrTarget;
  /** O que vai no `data` do nó novo (nome, agente, orquestrador…); no nó que já existe, só estes campos mudam. */
  data: Dict;
  /** Orquestrador (id ou nome) de quem o terminal passa a ser recruta. */
  to?: string;
  /** Notas (id ou nome do arquivo) a que o terminal se liga. */
  notes?: readonly string[];
  /** Nós `agent` do documento que são o mesmo pane (registrado com `agent adopt`): saem, o terminal fica no lugar deles. */
  agentIds?: readonly string[];
}

export interface JoinPlan {
  op: CanvasOp | undefined;
  nodeId: string;
  created: boolean;
}

const terminalsAt = (doc: CanvasDoc, target: HerdrTarget): CanvasNode[] =>
  doc.nodes.filter((node) => { const at = terminalTargetOf(node); return at !== undefined && paneKey(at) === paneKey(target); });

/** Onde o terminal de fora entra: à direita de tudo, na altura do nó mais alto (nada se move). */
function joinSlot(doc: CanvasDoc): { x: number; y: number } {
  if (doc.nodes.length === 0) return { x: 0, y: 0 };
  return { x: Math.max(...doc.nodes.map((n) => n.x + n.w)) + RECRUIT_LAYOUT.gapX, y: Math.min(...doc.nodes.map((n) => n.y)) };
}

/**
 * `join`: o terminal do pane vira nó `terminal` do documento, sem tocar no processo. Um pane, um nó: se o pane já é nó, o
 * plano só atualiza o que foi pedido (nome, papel, orquestrador, notas) e repetir não muda nada. Nó `agent` no mesmo pane
 * (registro de `agent adopt`) é trocado pelo terminal no mesmo lote. Com `to`, o terminal fica recruta do orquestrador.
 */
export function planJoin(doc: CanvasDoc, input: JoinInput): JoinPlan {
  const orchestrator = input.to === undefined ? undefined : findByRef(doc, input.to, isOrchestrator) ?? fail(RECRUIT_ERRORS.notOrchestratorTarget);
  const notes = [...new Map((input.notes ?? []).map((ref) => findNote(doc, ref) ?? fail(RECRUIT_ERRORS.missingNote)).map((n) => [n.id, n])).values()];
  const existing = terminalsAt(doc, input.target)[0];
  const nodeId = existing?.id ?? freshId(doc, "term-j");
  const ops: AtomicOp[] = [];
  let next = doc;
  if (existing === undefined) {
    const slot = orchestrator === undefined
      ? joinSlot(doc)
      : (recruitSlots(orchestrator, [...recruitsOf(doc, orchestrator.id), { w: JOIN_NODE_SIZE.w, h: JOIN_NODE_SIZE.h }].map((n) => ({ w: n.w, h: n.h }))).at(-1) as { x: number; y: number });
    const top = Math.min(CANVAS_LIMITS.layer - 1, doc.nodes.reduce((z, n) => Math.max(z, n.z), 0));
    const data = { ...input.data, herdr: input.target, ...(orchestrator && { recruiter: orchestrator.id }) };
    const node: CanvasNode = { id: nodeId, type: TERMINAL_NODE_TYPE, ...slot, ...JOIN_NODE_SIZE, z: top + 1, data, locked: false, blurred: false };
    const edges: CanvasEdge[] = orchestrator ? [{ id: freshId(doc, "recruit-e"), from: orchestrator.id, to: nodeId, kind: RECRUIT_EDGE_KIND }] : [];
    ops.push(opCreate(doc, [node], edges));
    next = { ...doc, nodes: [...doc.nodes, node], edges: [...doc.edges, ...edges] };
  } else {
    const data: Dict = { ...dataOf(existing), ...input.data };
    if (orchestrator && recruiterOf(existing) !== orchestrator.id) {
      data.recruiter = orchestrator.id;
      const edge: CanvasEdge = { id: freshId(doc, "recruit-e"), from: orchestrator.id, to: nodeId, kind: RECRUIT_EDGE_KIND };
      ops.push(opCreate(doc, [], [edge]));
      next = { ...doc, edges: [...doc.edges, edge] };
    }
    if (JSON.stringify(data) !== JSON.stringify(dataOf(existing))) ops.push(opUpdate(next, nodeId, data));
  }
  for (const note of notes) {
    if (hasNoteAccess(next, note.id, nodeId)) continue;
    const op = opCreateLink(next, { id: freshId(next, "link-r"), from: nodeId, to: note.id });
    ops.push(op);
    if (op.kind === "edge-create") next = { ...next, edges: [...next.edges, op.edge.item] };
  }
  // o nó `agent` do mesmo pane sai por último: os índices dos outros passos foram tirados do documento de antes
  const duplicated = (input.agentIds ?? []).filter((id) => doc.nodes.some((n) => n.id === id && n.id !== nodeId));
  if (duplicated.length > 0) ops.push(opDelete(doc, duplicated));
  return { op: ops.length === 0 ? undefined : opBatch(ops), nodeId, created: existing === undefined };
}

/** `leave`: tira do documento o nó `terminal` do pane (com as arestas dele); o processo não é tocado. */
export function planLeave(doc: CanvasDoc, target: HerdrTarget): { op: AtomicOp; nodes: CanvasNode[] } {
  const nodes = terminalsAt(doc, target);
  if (nodes.length === 0) return fail(RECRUIT_ERRORS.notInCanvas);
  return { op: opDelete(doc, nodes.map((n) => n.id)), nodes };
}

// ---- identidade ----

export interface Identity {
  name: string;
  /** Nome do papel (ou `null`, sem papel). */
  role: string | null;
  orchestrator: string;
  /** Nomes de arquivo das notas ligadas ao recruta. */
  notes: readonly string[];
  /** Bloco "PR pronta" (assignee, labels, reviewers); só quando o papel do recruta abre PR. */
  prReady?: string;
  /** Tarefa que o orquestrador passou, depois da identidade. */
  task?: string;
}

/** O prompt inicial do recruta: quem ele é, o papel, a quem responde, as notas e como lê-las. */
export function identityPrompt(identity: Identity): string {
  const lines = [
    `Você é ${identity.name}, recruta do orquestrador ${identity.orchestrator} neste canvas.`,
    `Papel: ${identity.role ?? "sem papel definido"}.`,
    identity.notes.length
      ? `Notas ligadas a você: ${identity.notes.join(", ")}. Leia com \`hades canvas note read <nota>\` e escreva com \`hades canvas note write <nota>\`.`
      : "Nenhuma nota ligada a você por enquanto (`hades canvas note list` mostra quando houver).",
    `Responda ao orquestrador ${identity.orchestrator}; não recrute, não dispense e não reatribua ninguém.`,
  ];
  if (identity.prReady) lines.push(identity.prReady);
  if (identity.task && identity.task.trim()) lines.push("", identity.task.trim());
  return lines.join("\n");
}

/** O que o aviso de "sessão encerrada ao concluir" lê do registro de um agente. */
export interface AgentRecordView {
  name: string;
  worktree: string;
  state: string;
  closedOnDone: boolean;
}

/** O agente já concluído cuja worktree é (ou contém) `cwd`: recrutar ali reaproveitaria uma sessão que não existe mais. */
export function concludedAgentAt(cwd: string, records: readonly AgentRecordView[]): string | undefined {
  const here = cwd.replace(/\/+$/, "");
  const found = records.find((r) => {
    const worktree = r.worktree.replace(/\/+$/, "");
    return worktree !== "" && (r.closedOnDone || r.state === "done") && (here === worktree || here.startsWith(`${worktree}/`));
  });
  return found?.name;
}
