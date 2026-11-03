// Bandas do canvas (reference/argos.md §Organização avançada): uma banda é um grupo só de agentes vivos. Aqui ficam a lista de
// status (quem trabalha, quem espera o dono), a troca entre os agentes da banda e a ligação da banda inteira a uma nota.
// Funções puras sobre o documento e sobre o estado que a página já tem do grafo; sem Node e sem DOM.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasEdge, type CanvasGroup, type CanvasNode } from "./canvas-doc.ts";
import { type CanvasOp, opEdgesCreate, opEdgesDelete, opLink, opUnlink } from "./canvas-history.ts";
import { ID_PATTERN, ORG_ERRORS, orgFail } from "./canvas-groups.ts";

export const BAND_NODE_TYPE = "agent";
export const BAND_MIN_MEMBERS = 2;
/** `kind` das conexões que ligam os agentes de uma banda à nota. */
export const BAND_LINK_KIND = "band";

/** O que a página sabe de cada agente vivo (do grafo, não do documento). */
export interface BandAgentInfo {
  state: string;
  /** O agente espera uma decisão ou resposta do dono (pedido de permissão, pergunta aberta). */
  waitingOwner: boolean;
}

export type BandRank = "waiting" | "working" | "other";

/** Estados do grafo que contam como trabalhando; qualquer outro (parado, concluído, desconhecido) é `other`. */
export const WORKING_STATES: readonly string[] = ["working", "running", "busy"];

export interface BandMemberStatus {
  id: string;
  state: string;
  waitingOwner: boolean;
  rank: BandRank;
}

export interface BandStatus {
  groupId: string;
  label: string;
  /** Quem espera o dono primeiro, depois quem trabalha, depois o resto; dentro de cada faixa, a ordem do grupo. */
  members: BandMemberStatus[];
  counts: Record<BandRank, number>;
}

export type BandLive = ReadonlyMap<string, BandAgentInfo> | Readonly<Record<string, BandAgentInfo>>;

const UNKNOWN_STATE = "unknown";
const RANK_ORDER: readonly BandRank[] = ["waiting", "working", "other"];

/** Banda: grupo com dois ou mais membros, todos agentes vivos que existem no documento. */
export function isBand(doc: CanvasDoc, group: CanvasGroup): boolean {
  if (group.members.length < BAND_MIN_MEMBERS) return false;
  const kinds = new Map(doc.nodes.map((node) => [node.id, node.type]));
  return group.members.every((member) => kinds.get(member) === BAND_NODE_TYPE);
}

/** As bandas do documento, na ordem dos grupos. */
export const bandsOf = (doc: CanvasDoc): CanvasGroup[] => doc.groups.filter((group) => isBand(doc, group));

function bandOrFail(doc: CanvasDoc, groupId: string): CanvasGroup {
  const group = doc.groups.find((candidate) => candidate.id === groupId);
  if (!group) return orgFail(ORG_ERRORS.unknownGroup, "banda não existe no documento");
  return isBand(doc, group) ? group : orgFail(ORG_ERRORS.invalidMode, "o grupo não é uma banda (só agentes)");
}

const infoOf = (live: BandLive, id: string): BandAgentInfo | undefined =>
  live instanceof Map ? live.get(id) : Object.hasOwn(live, id) ? (live as Readonly<Record<string, BandAgentInfo>>)[id] : undefined;

function rankOf(info: BandAgentInfo | undefined): BandRank {
  if (info?.waitingOwner) return "waiting";
  return info && WORKING_STATES.includes(info.state) ? "working" : "other";
}

/** Lista de status da banda. Agente sem informação do grafo aparece como `unknown`, em `other`. Erros: `org_unknown_group`, `org_invalid_mode`. */
export function bandStatus(doc: CanvasDoc, groupId: string, live: BandLive): BandStatus {
  const group = bandOrFail(doc, groupId);
  const members = group.members.map((id): BandMemberStatus => {
    const info = infoOf(live, id);
    return { id, state: info?.state ?? UNKNOWN_STATE, waitingOwner: info?.waitingOwner === true, rank: rankOf(info) };
  });
  const counts: Record<BandRank, number> = { waiting: 0, working: 0, other: 0 };
  for (const member of members) counts[member.rank] += 1;
  const sorted = RANK_ORDER.flatMap((rank) => members.filter((member) => member.rank === rank));
  return { groupId: group.id, label: group.label, members: sorted, counts };
}

/** Quem espera o dono em qualquer banda, na ordem das bandas (um agente em duas bandas aparece uma vez). */
export function waitingAcrossBands(doc: CanvasDoc, live: BandLive): string[] {
  const seen = new Set<string>();
  for (const group of bandsOf(doc)) {
    for (const member of bandStatus(doc, group.id, live).members) if (member.waitingOwner) seen.add(member.id);
  }
  return [...seen];
}

/**
 * Troca de agente com um clique: o próximo (ou o anterior) da lista de status, dando a volta. `current` fora da banda (ou
 * ausente) começa pelo primeiro; quem espera o dono vem primeiro na ordem, então o clique chega nele antes.
 */
export function stepBand(status: BandStatus, current: string | undefined, direction: "next" | "previous" = "next"): string | undefined {
  const ids = status.members.map((member) => member.id);
  if (ids.length === 0) return undefined;
  const at = current === undefined ? -1 : ids.indexOf(current);
  if (at === -1) return direction === "next" ? ids[0] : ids[ids.length - 1];
  return ids[(at + (direction === "next" ? 1 : -1) + ids.length) % ids.length];
}

export const bandLinkId = (groupId: string, memberId: string, noteId: string): string => `band:${groupId}:${memberId}:${noteId}`;

function noteOrFail(doc: CanvasDoc, noteId: string): CanvasNode {
  const note = doc.nodes.find((node) => node.id === noteId);
  if (!note) return orgFail(ORG_ERRORS.unknownNode, "nota não existe no documento");
  return note.type === BAND_NODE_TYPE ? orgFail(ORG_ERRORS.invalidMode, "a banda liga a uma nota, não a um agente") : note;
}

/**
 * Liga a banda inteira à nota: uma conexão `band` de cada agente para ela, em um passo só do desfazer (`edge-create` de cada conexão, a nota não é recriada). Quem já estava ligado
 * não duplica; banda já toda ligada devolve `undefined`.
 * Erros: `org_unknown_group`, `org_invalid_mode`, `org_unknown_node`, `org_invalid_id`, `org_duplicate_id`, `org_limit_exceeded`.
 */
export function linkBand(doc: CanvasDoc, groupId: string, noteId: string): CanvasOp | undefined {
  const group = bandOrFail(doc, groupId);
  noteOrFail(doc, noteId);
  const linked = new Set(doc.edges.filter((edge) => edge.kind === BAND_LINK_KIND && edge.to === noteId).map((edge) => edge.from));
  const used = new Set(doc.edges.map((edge) => edge.id));
  const fresh: CanvasEdge[] = [];
  for (const member of group.members) {
    if (linked.has(member)) continue;
    const id = bandLinkId(group.id, member, noteId);
    if (!ID_PATTERN.test(id) || id.length > CANVAS_LIMITS.idChars) return orgFail(ORG_ERRORS.invalidId, "id de ligação inválido ou grande demais");
    if (used.has(id)) return orgFail(ORG_ERRORS.duplicateId, "já existe uma conexão com esse id");
    fresh.push({ id, from: member, to: noteId, kind: BAND_LINK_KIND });
  }
  if (fresh.length === 0) return undefined;
  if (doc.edges.length + fresh.length > CANVAS_LIMITS.edges) return orgFail(ORG_ERRORS.limitExceeded, "documento passaria do limite de conexões");
  return opEdgesCreate(doc, fresh);
}

/** Desliga a banda da nota (só as conexões `band` dos agentes dela, um `edge-delete` cada, em um passo); sem ligação, `undefined`. */
export function unlinkBand(doc: CanvasDoc, groupId: string, noteId: string): CanvasOp | undefined {
  const group = bandOrFail(doc, groupId);
  noteOrFail(doc, noteId);
  const members = new Set(group.members);
  const links = doc.edges.filter((edge) => edge.kind === BAND_LINK_KIND && edge.to === noteId && members.has(edge.from));
  return links.length === 0 ? undefined : opEdgesDelete(doc, links.map((edge) => edge.id));
}

/**
 * Põe um agente na banda (`link`: só a lista de membros muda). Quem já é membro devolve `undefined`.
 * Erros: `org_unknown_group`, `org_invalid_mode` (grupo que não é banda, ou nó que não é agente), `org_unknown_node`.
 */
export function addToBand(doc: CanvasDoc, groupId: string, agentId: string): CanvasOp | undefined {
  const group = bandOrFail(doc, groupId);
  const agent = doc.nodes.find((node) => node.id === agentId);
  if (!agent) return orgFail(ORG_ERRORS.unknownNode, "agente não existe no documento");
  if (agent.type !== BAND_NODE_TYPE) return orgFail(ORG_ERRORS.invalidMode, "a banda só aceita agentes");
  return group.members.includes(agentId) ? undefined : opLink(doc, groupId, agentId);
}

/**
 * Tira um agente da banda (`unlink`: o nó e as conexões ficam). Quem não é membro devolve `undefined`. A banda precisa
 * seguir com dois agentes: para menos que isso, desfaça o grupo. Erros: `org_unknown_group`, `org_invalid_mode`.
 */
export function removeFromBand(doc: CanvasDoc, groupId: string, agentId: string): CanvasOp | undefined {
  const group = bandOrFail(doc, groupId);
  if (!group.members.includes(agentId)) return undefined;
  if (group.members.length <= BAND_MIN_MEMBERS) return orgFail(ORG_ERRORS.invalidMode, "a banda precisa de ao menos dois agentes; desfaça o grupo");
  return opUnlink(doc, groupId, agentId);
}

/** Notas ligadas à banda (por qualquer agente dela), na ordem do documento. */
export function bandNotes(doc: CanvasDoc, groupId: string): string[] {
  const group = bandOrFail(doc, groupId);
  const members = new Set(group.members);
  const notes = new Set(doc.edges.filter((edge) => edge.kind === BAND_LINK_KIND && members.has(edge.from)).map((edge) => edge.to));
  return doc.nodes.filter((node) => notes.has(node.id)).map((node) => node.id);
}
