// Grupos do canvas (reference/argos.md §Organização): criar, renomear, desfazer o grupo, mover com os membros e a caixa que
// os envolve. Funções puras sobre o documento: nada é alterado, cada operação devolve uma `CanvasOp` da pilha de desfazer
// (`undefined` quando não há o que mudar, para o chamador não registrar passo vazio). Sem Node e sem DOM.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasGroup, type CanvasNode } from "./canvas-doc.ts";
import { type AtomicOp, applyOp, type CanvasOp, type Frame, opBatch, opMove, opUngroup } from "./canvas-history.ts";

/** Códigos estáveis do conjunto de modelos de organização (grupos, alinhar, encaixe, área de transferência): só ganham valores. */
export const ORG_ERRORS = {
  unknownNode: "org_unknown_node",
  unknownGroup: "org_unknown_group",
  invalidLabel: "org_invalid_label",
  invalidId: "org_invalid_id",
  invalidNumber: "org_invalid_number",
  invalidMode: "org_invalid_mode",
  duplicateId: "org_duplicate_id",
  limitExceeded: "org_limit_exceeded",
  invalidClip: "org_invalid_clip",
} as const;
export type OrgErrorCode = (typeof ORG_ERRORS)[keyof typeof ORG_ERRORS];

export class OrgError extends Error {
  readonly code: OrgErrorCode;
  constructor(code: OrgErrorCode, message: string) {
    super(message);
    this.name = "OrgError";
    this.code = code;
  }
}

export const orgFail = (code: OrgErrorCode, message: string): never => {
  throw new OrgError(code, message);
};

/** Menos que isso não é grupo: o grupo de um membro só se desfaz. */
export const GROUP_MIN_MEMBERS = 2;
/** Folga, em unidades do canvas, entre os membros e a borda do grupo. */
export const GROUP_BOX_PADDING = 16;

export const ID_PATTERN = /^[\w.:-]+$/;

/** Número que vem de quem chama (deslocamento, zoom, grade): finito ou erro, nunca `NaN` gravado no documento. */
export function finiteOrFail(value: number, what: string): number {
  return Number.isFinite(value) ? value : orgFail(ORG_ERRORS.invalidNumber, `${what} precisa ser um número finito`);
}

/** Os nós de `ids` na ordem em que vieram, sem repetir. Id que o documento não tem lança `org_unknown_node`. */
export function pickNodes(doc: CanvasDoc, ids: readonly string[]): CanvasNode[] {
  const wanted = new Set(ids);
  if (wanted.size === 0) return [];
  const found = new Map<string, CanvasNode>();
  for (const node of doc.nodes) if (wanted.has(node.id)) found.set(node.id, node);
  const picked: CanvasNode[] = [];
  for (const id of wanted) {
    const node = found.get(id);
    if (!node) return orgFail(ORG_ERRORS.unknownNode, "nó não existe no documento");
    picked.push(node);
  }
  return picked;
}

/** Id do nó → id do grupo a que pertence. O documento admite que um nó apareça em dois grupos; vale o primeiro. */
export function groupIndex(doc: CanvasDoc): Map<string, string> {
  const index = new Map<string, string>();
  for (const group of doc.groups) for (const member of group.members) if (!index.has(member)) index.set(member, group.id);
  return index;
}

function groupOrFail(doc: CanvasDoc, groupId: string): { group: CanvasGroup; at: number } {
  const at = doc.groups.findIndex((candidate) => candidate.id === groupId);
  const group = doc.groups[at];
  return group ? { group, at } : orgFail(ORG_ERRORS.unknownGroup, "grupo não existe no documento");
}

function cleanLabel(label: string): string {
  const clean = label.trim();
  if (clean === "" || clean.length > CANVAS_LIMITS.labelChars) {
    return orgFail(ORG_ERRORS.invalidLabel, `o nome do grupo deve ter de 1 a ${CANVAS_LIMITS.labelChars} caracteres`);
  }
  return clean;
}

const groupAt = (at: number, item: CanvasGroup): AtomicOp => ({ kind: "group", group: { at, item } });

/**
 * Passos para trocar o grupo `groupId` por `members` na mesma posição da lista (grupo que fica com menos de
 * `GROUP_MIN_MEMBERS` some). `working` é o documento já com os passos anteriores; devolve também o documento depois dos
 * passos, porque dissolver um grupo desloca os índices dos seguintes.
 */
function replaceMembers(working: CanvasDoc, groupId: string, members: readonly string[], label?: string): { ops: AtomicOp[]; doc: CanvasDoc } {
  const { group, at } = groupOrFail(working, groupId);
  const ops: AtomicOp[] = [opUngroup(working, groupId)];
  if (members.length >= GROUP_MIN_MEMBERS) ops.push(groupAt(at, { id: group.id, label: label ?? group.label, members: [...members] }));
  return { ops, doc: ops.reduce(applyOp, working) };
}

const asOp = (ops: readonly AtomicOp[]): CanvasOp | undefined => (ops.length === 0 ? undefined : ops.length === 1 ? ops[0] : opBatch(ops));

export interface NewGroup {
  /** Id do grupo novo: quem cria escolhe (como nos demais construtores de operação). */
  id: string;
  label: string;
  members: readonly string[];
}

/**
 * Cria o grupo. Um nó fica em no máximo um grupo: quem já estava em outro sai dele (o grupo antigo que ficar com menos de
 * dois membros se desfaz). Com menos de dois nós distintos não há grupo e devolve `undefined`.
 * Erros: `org_unknown_node`, `org_invalid_id`, `org_duplicate_id`, `org_invalid_label`, `org_limit_exceeded`.
 */
export function createGroup(doc: CanvasDoc, request: NewGroup): CanvasOp | undefined {
  if (!ID_PATTERN.test(request.id) || request.id.length > CANVAS_LIMITS.idChars) return orgFail(ORG_ERRORS.invalidId, "id de grupo inválido");
  if (doc.groups.some((group) => group.id === request.id)) return orgFail(ORG_ERRORS.duplicateId, "já existe um grupo com esse id");
  const label = cleanLabel(request.label);
  const members = pickNodes(doc, request.members).map((node) => node.id);
  if (members.length < GROUP_MIN_MEMBERS) return undefined;
  if (members.length > CANVAS_LIMITS.groupMembers) return orgFail(ORG_ERRORS.limitExceeded, "grupo com membros demais");

  const taken = new Set(members);
  const ops: AtomicOp[] = [];
  let working = doc;
  for (const group of doc.groups) {
    const remaining = group.members.filter((member) => !taken.has(member));
    if (remaining.length === group.members.length) continue;
    const step = replaceMembers(working, group.id, remaining);
    ops.push(...step.ops);
    working = step.doc;
  }
  if (working.groups.length >= CANVAS_LIMITS.groups) return orgFail(ORG_ERRORS.limitExceeded, "documento passaria do limite de grupos");
  ops.push(groupAt(working.groups.length, { id: request.id, label, members }));
  return asOp(ops);
}

/** Desfaz o grupo (os membros ficam onde estão). `org_unknown_group` se o grupo não existe. */
export function ungroup(doc: CanvasDoc, groupId: string): CanvasOp {
  groupOrFail(doc, groupId);
  return opUngroup(doc, groupId);
}

/** Troca o nome mantendo a posição do grupo na lista; mesmo nome (depois de aparar) devolve `undefined`. */
export function renameGroup(doc: CanvasDoc, groupId: string, label: string): CanvasOp | undefined {
  const { group } = groupOrFail(doc, groupId);
  const clean = cleanLabel(label);
  if (clean === group.label) return undefined;
  return asOp(replaceMembers(doc, groupId, group.members, clean).ops);
}

/**
 * Passos que desfazem, entre `candidates` (ids de grupo), os que ficaram com menos de dois membros (depois de excluir nós,
 * por exemplo). `working` é o documento como estará quando estes passos forem aplicados. Grupo fora de `candidates` não é
 * tocado, mesmo pequeno: ele já era assim antes.
 */
export function dissolveSmallGroups(working: CanvasDoc, candidates: ReadonlySet<string>): AtomicOp[] {
  const ops: AtomicOp[] = [];
  let current = working;
  for (const group of working.groups) {
    if (!candidates.has(group.id) || group.members.length >= GROUP_MIN_MEMBERS) continue;
    const op = opUngroup(current, group.id);
    ops.push(op);
    current = applyOp(current, op);
  }
  return ops;
}

/**
 * Move o grupo inteiro: cada membro que não está travado anda `dx`, `dy`, em um passo só do desfazer. Membro travado
 * fica onde está. Sem membro livre (ou deslocamento zero) devolve `undefined`.
 */
export function moveGroup(doc: CanvasDoc, groupId: string, dx: number, dy: number): CanvasOp | undefined {
  finiteOrFail(dx, "dx");
  finiteOrFail(dy, "dy");
  const { group } = groupOrFail(doc, groupId);
  if (dx === 0 && dy === 0) return undefined;
  const free = pickNodes(doc, group.members).filter((node) => !node.locked);
  return asOp(free.map((node) => opMove(doc, node.id, { x: node.x + dx, y: node.y + dy })));
}

export interface GroupBoxOptions {
  /** Folga ao redor dos membros (padrão `GROUP_BOX_PADDING`). */
  padding?: number;
  /** Altura extra em cima para o cabeçalho com o nome (padrão 0). */
  header?: number;
}

/** O menor retângulo que contém os membros, com folga; `undefined` para grupo que não existe. Acompanha os membros a cada leitura. */
export function groupBox(doc: CanvasDoc, groupId: string, options: GroupBoxOptions = {}): Frame | undefined {
  const group = doc.groups.find((candidate) => candidate.id === groupId);
  if (!group) return undefined;
  const padding = finiteOrFail(options.padding ?? GROUP_BOX_PADDING, "padding");
  const header = finiteOrFail(options.header ?? 0, "header");
  const members = pickNodes(doc, group.members);
  if (members.length === 0) return undefined;
  const left = Math.min(...members.map((node) => node.x));
  const top = Math.min(...members.map((node) => node.y));
  const right = Math.max(...members.map((node) => node.x + node.w));
  const bottom = Math.max(...members.map((node) => node.y + node.h));
  return { x: left - padding, y: top - padding - header, w: right - left + 2 * padding, h: bottom - top + 2 * padding + header };
}
