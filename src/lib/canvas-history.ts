// Desfazer e refazer do canvas (reference/argos.md §Documento do canvas): operações sobre o documento, cada uma com o
// inverso exato, e a pilha com limite. Tudo puro e imutável (o documento e a pilha de entrada nunca mudam) e sem
// dependência de Node: roda no painel, no navegador. Ids novos chegam de fora (quem cria o nó escolhe o id).
import { CANVAS_LIMITS, type CanvasDoc, type CanvasEdge, type CanvasGroup, type CanvasNode, validateCanvasDoc, withHidden } from "./canvas-doc.ts";

export const HISTORY_LIMIT_DEFAULT = 100;
export const HISTORY_LIMIT_MAX = 1000;
export const BATCH_MAX = 5000;

/** Códigos estáveis: só ganham valores. */
export const HISTORY_ERRORS = {
  invalidOp: "history_invalid_op",
  missingTarget: "history_missing_target",
  duplicateTarget: "history_duplicate_target",
  danglingReference: "history_dangling_reference",
  limitExceeded: "history_limit_exceeded",
  emptyBatch: "history_empty_batch",
} as const;
export type HistoryErrorCode = (typeof HISTORY_ERRORS)[keyof typeof HISTORY_ERRORS];

export class HistoryError extends Error {
  readonly code: HistoryErrorCode;
  constructor(code: HistoryErrorCode, message: string) {
    super(message);
    this.name = "HistoryError";
    this.code = code;
  }
}

const fail = (code: HistoryErrorCode, message: string): never => {
  throw new HistoryError(code, message);
};

export interface Point {
  x: number;
  y: number;
}

export interface Frame extends Point {
  w: number;
  h: number;
}

/** Item e a posição que ele tinha (ou terá) na lista do documento: o inverso devolve cada um ao lugar de origem. */
export interface Placed<T> {
  at: number;
  item: T;
}

/**
 * O que `create` insere e `delete` tira. Em `delete`, `edges` são as arestas que tocavam os nós, `groups` o estado
 * anterior dos grupos que perderam membro (grupo que ficou vazio some; desfazer o devolve inteiro) e `hidden` o lugar
 * dos nós excluídos na lista de ocultos (ausente quando nenhum estava oculto).
 */
export interface Snapshot {
  nodes: Placed<CanvasNode>[];
  edges: Placed<CanvasEdge>[];
  groups: Placed<CanvasGroup>[];
  hidden?: Placed<string>[];
}

/** Campos escalares de um nó que `patch` troca no lugar (o nó não é recriado: id, posição, `data` e grupos seguem). */
export interface NodePatch {
  z?: number;
  locked?: boolean;
  blurred?: boolean;
}

export const PATCH_KEYS = ["z", "locked", "blurred"] as const satisfies readonly (keyof NodePatch)[];

/**
 * Toda mudança do documento é uma destas; o inverso de cada uma também. `update` troca o `data` inteiro de um nó;
 * `edge-create`/`edge-delete` mexem numa aresta solta (sem nó junto); `patch` troca campos escalares do nó; `link`/`unlink`
 * põem e tiram um nó da lista de membros de um grupo (banda) sem tocar no nó; `hide`/`unhide` põem e tiram ids da lista de
 * ocultos do documento (o nó fica onde está, só sai do desenho).
 */
export type AtomicOp =
  | { kind: "move"; id: string; from: Point; to: Point }
  | { kind: "resize"; id: string; from: Frame; to: Frame }
  | { kind: "create"; snapshot: Snapshot }
  | { kind: "delete"; snapshot: Snapshot }
  | { kind: "group"; group: Placed<CanvasGroup> }
  | { kind: "ungroup"; group: Placed<CanvasGroup> }
  | { kind: "update"; id: string; from: Record<string, unknown>; to: Record<string, unknown> }
  | { kind: "edge-create"; edge: Placed<CanvasEdge> }
  | { kind: "edge-delete"; edge: Placed<CanvasEdge> }
  | { kind: "patch"; id: string; from: NodePatch; to: NodePatch }
  | { kind: "link"; groupId: string; member: Placed<string> }
  | { kind: "unlink"; groupId: string; member: Placed<string> }
  | { kind: "hide"; ids: Placed<string>[] }
  | { kind: "unhide"; ids: Placed<string>[] };

/** Vários passos que desfazem e refazem juntos (arrastar vários nós). */
export interface BatchOp {
  kind: "batch";
  ops: AtomicOp[];
}

export type CanvasOp = AtomicOp | BatchOp;

// ---- construtores: leem o documento para guardar o que o inverso precisa ----

function nodeOf(doc: CanvasDoc, id: string): CanvasNode {
  return doc.nodes.find((node) => node.id === id) ?? fail(HISTORY_ERRORS.missingTarget, "nó não existe no documento");
}

export function opMove(doc: CanvasDoc, id: string, to: Point): AtomicOp {
  const node = nodeOf(doc, id);
  return { kind: "move", id, from: { x: node.x, y: node.y }, to: { x: to.x, y: to.y } };
}

export function opResize(doc: CanvasDoc, id: string, to: Frame): AtomicOp {
  const node = nodeOf(doc, id);
  return { kind: "resize", id, from: { x: node.x, y: node.y, w: node.w, h: node.h }, to: { x: to.x, y: to.y, w: to.w, h: to.h } };
}

/** Arrastar vários nós: um passo só. Com um único id devolve o `move` simples. */
export function opMoveMany(doc: CanvasDoc, ids: readonly string[], dx: number, dy: number): CanvasOp {
  const moves = ids.map((id) => {
    const node = nodeOf(doc, id);
    return opMove(doc, id, { x: node.x + dx, y: node.y + dy });
  });
  return moves.length === 1 ? (moves[0] as AtomicOp) : opBatch(moves);
}

export function opCreate(doc: CanvasDoc, nodes: readonly CanvasNode[], edges: readonly CanvasEdge[] = []): AtomicOp {
  if (nodes.length === 0 && edges.length === 0) return fail(HISTORY_ERRORS.invalidOp, "create vazio");
  return {
    kind: "create",
    snapshot: {
      nodes: nodes.map((node, i) => ({ at: doc.nodes.length + i, item: structuredClone(node) })),
      edges: edges.map((edge, i) => ({ at: doc.edges.length + i, item: { ...edge } })),
      groups: [],
    },
  };
}

export function opDelete(doc: CanvasDoc, ids: readonly string[]): AtomicOp {
  const gone = new Set(ids);
  if (gone.size === 0) return fail(HISTORY_ERRORS.invalidOp, "delete vazio");
  for (const id of gone) nodeOf(doc, id);
  const placed = <T>(items: readonly T[], hit: (item: T) => boolean): Placed<T>[] =>
    items.flatMap((item, at) => (hit(item) ? [{ at, item: structuredClone(item) }] : []));
  const snapshot: Snapshot = {
    nodes: placed(doc.nodes, (node) => gone.has(node.id)),
    edges: placed(doc.edges, (edge) => gone.has(edge.from) || gone.has(edge.to)),
    groups: placed(doc.groups, (group) => group.members.some((member) => gone.has(member))),
  };
  const hidden = placed(doc.hidden ?? [], (id) => gone.has(id));
  if (hidden.length > 0) snapshot.hidden = hidden;
  return { kind: "delete", snapshot };
}

export function opGroup(doc: CanvasDoc, id: string, label: string, members: readonly string[]): AtomicOp {
  return { kind: "group", group: { at: doc.groups.length, item: { id, label, members: [...members] } } };
}

export function opUngroup(doc: CanvasDoc, groupId: string): AtomicOp {
  const at = doc.groups.findIndex((group) => group.id === groupId);
  const group = doc.groups[at];
  if (!group) return fail(HISTORY_ERRORS.missingTarget, "grupo não existe no documento");
  return { kind: "ungroup", group: { at, item: structuredClone(group) } };
}

/** Troca o `data` do nó (cópia profunda dos dois lados). O inverso devolve o `data` anterior. */
export function opUpdate(doc: CanvasDoc, id: string, data: Record<string, unknown>): AtomicOp {
  const node = nodeOf(doc, id);
  checkData(node, data);
  return { kind: "update", id, from: structuredClone(node.data), to: structuredClone(data) };
}

/** Cria uma aresta solta, no fim da lista. Id repetido, ponta que não existe, forma inválida e o teto são recusados. */
export function opEdgeCreate(doc: CanvasDoc, edge: CanvasEdge): AtomicOp {
  const op: AtomicOp = { kind: "edge-create", edge: { at: doc.edges.length, item: { ...edge } } };
  checkEdgeCreate(doc, op.edge);
  return op;
}

/** Várias arestas soltas em um passo só (um `edge-create` se for uma): cada uma é conferida contra o documento já com as anteriores. */
export function opEdgesCreate(doc: CanvasDoc, edges: readonly CanvasEdge[]): CanvasOp {
  if (edges.length === 0) return fail(HISTORY_ERRORS.invalidOp, "create de arestas vazio");
  if (edges.length > BATCH_MAX) return fail(HISTORY_ERRORS.limitExceeded, "lote grande demais");
  const ops: AtomicOp[] = [];
  let current = doc;
  for (const edge of edges) {
    const op = opEdgeCreate(current, edge);
    ops.push(op);
    current = applyAtomic(current, op);
  }
  return ops.length === 1 ? (ops[0] as AtomicOp) : opBatch(ops);
}

/** Várias arestas soltas em um passo só. Saem do maior índice para o menor, para cada `at` valer no inverso em ordem reversa. */
export function opEdgesDelete(doc: CanvasDoc, edgeIds: readonly string[]): CanvasOp {
  const wanted = new Set(edgeIds);
  if (wanted.size === 0) return fail(HISTORY_ERRORS.invalidOp, "delete de arestas vazio");
  if (wanted.size > BATCH_MAX) return fail(HISTORY_ERRORS.limitExceeded, "lote grande demais");
  for (const id of wanted) if (!doc.edges.some((edge) => edge.id === id)) return fail(HISTORY_ERRORS.missingTarget, "aresta não existe no documento");
  const ops = doc.edges.flatMap((edge, at): AtomicOp[] => (wanted.has(edge.id) ? [{ kind: "edge-delete", edge: { at, item: { ...edge } } }] : [])).reverse();
  return ops.length === 1 ? (ops[0] as AtomicOp) : opBatch(ops);
}

/** Remove uma aresta solta; o inverso a devolve ao índice de origem. */
export function opEdgeDelete(doc: CanvasDoc, edgeId: string): AtomicOp {
  const at = doc.edges.findIndex((edge) => edge.id === edgeId);
  const edge = doc.edges[at];
  if (!edge) return fail(HISTORY_ERRORS.missingTarget, "aresta não existe no documento");
  return { kind: "edge-delete", edge: { at, item: { ...edge } } };
}

/** Troca campos escalares do nó; só as chaves de `to` entram (e o `from` guarda o valor delas agora). */
export function opPatch(doc: CanvasDoc, id: string, to: NodePatch): AtomicOp {
  const node = nodeOf(doc, id);
  const keys = Object.keys(to);
  if (keys.length === 0) return fail(HISTORY_ERRORS.invalidOp, "patch vazio");
  const from: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) return fail(HISTORY_ERRORS.invalidOp, "patch com campo que não é trocável");
    from[key] = node[key as keyof NodePatch];
  }
  const op: AtomicOp = { kind: "patch", id, from: from as NodePatch, to: { ...to } };
  checkPatch(to);
  return op;
}

/** Tira o nó da lista do grupo, sem apagar o nó. O último membro não sai por aqui (grupo vazio não existe: use `opUngroup`). */
export function opUnlink(doc: CanvasDoc, groupId: string, nodeId: string): AtomicOp {
  const group = doc.groups.find((candidate) => candidate.id === groupId) ?? fail(HISTORY_ERRORS.missingTarget, "grupo não existe no documento");
  const at = group.members.indexOf(nodeId);
  if (at === -1) return fail(HISTORY_ERRORS.missingTarget, "o nó não é membro do grupo");
  if (group.members.length === 1) return fail(HISTORY_ERRORS.invalidOp, "o último membro sai desfazendo o grupo");
  return { kind: "unlink", groupId, member: { at, item: nodeId } };
}

/** Põe o nó no fim da lista de membros do grupo. */
export function opLink(doc: CanvasDoc, groupId: string, nodeId: string): AtomicOp {
  const group = doc.groups.find((candidate) => candidate.id === groupId) ?? fail(HISTORY_ERRORS.missingTarget, "grupo não existe no documento");
  const op: AtomicOp = { kind: "link", groupId, member: { at: group.members.length, item: nodeId } };
  checkLink(doc, op.groupId, op.member);
  return op;
}

/**
 * Tira do desenho os nós dados (de qualquer tipo), num passo só: entram no fim da lista de ocultos, na ordem dada. Id
 * repetido ou já oculto é ignorado; `undefined` quando nada muda. Id que o documento não tem é recusado.
 */
export function opHide(doc: CanvasDoc, ids: readonly string[]): AtomicOp | undefined {
  const already = new Set(doc.hidden ?? []);
  const fresh = [...new Set(ids)].filter((id) => !already.has(id));
  for (const id of fresh) nodeOf(doc, id);
  if (fresh.length === 0) return undefined;
  const base = already.size;
  if (base + fresh.length > CANVAS_LIMITS.hidden) return fail(HISTORY_ERRORS.limitExceeded, "ocultos passariam do limite");
  return { kind: "hide", ids: fresh.map((item, i) => ({ at: base + i, item })) };
}

/** Devolve ao desenho os ocultos dados, num passo só; o que não está oculto é ignorado. `undefined` quando nada muda. */
export function opUnhide(doc: CanvasDoc, ids: readonly string[]): AtomicOp | undefined {
  const wanted = new Set(ids);
  const placedIds = (doc.hidden ?? []).flatMap((item, at) => (wanted.has(item) ? [{ at, item }] : []));
  return placedIds.length > 0 ? { kind: "unhide", ids: placedIds } : undefined;
}

/** Reexibe todos os ocultos; `undefined` sem nenhum. */
export const opUnhideAll = (doc: CanvasDoc): AtomicOp | undefined => opUnhide(doc, doc.hidden ?? []);

export function opBatch(ops: readonly AtomicOp[]): BatchOp {
  if (ops.length === 0) return fail(HISTORY_ERRORS.emptyBatch, "lote vazio");
  if (ops.length > BATCH_MAX) return fail(HISTORY_ERRORS.limitExceeded, "lote grande demais");
  return { kind: "batch", ops: [...ops] };
}

// ---- inverso ----

function invertAtomic(op: AtomicOp): AtomicOp {
  switch (op.kind) {
    case "move": return { kind: "move", id: op.id, from: op.to, to: op.from };
    case "resize": return { kind: "resize", id: op.id, from: op.to, to: op.from };
    case "create": return { kind: "delete", snapshot: op.snapshot };
    case "delete": return { kind: "create", snapshot: op.snapshot };
    case "group": return { kind: "ungroup", group: op.group };
    case "ungroup": return { kind: "group", group: op.group };
    case "update": return { kind: "update", id: op.id, from: op.to, to: op.from };
    case "edge-create": return { kind: "edge-delete", edge: op.edge };
    case "edge-delete": return { kind: "edge-create", edge: op.edge };
    case "patch": return { kind: "patch", id: op.id, from: op.to, to: op.from };
    case "link": return { kind: "unlink", groupId: op.groupId, member: op.member };
    case "unlink": return { kind: "link", groupId: op.groupId, member: op.member };
    case "hide": return { kind: "unhide", ids: op.ids };
    case "unhide": return { kind: "hide", ids: op.ids };
    default: return assertNever(op);
  }
}

function assertNever(value: never): never {
  return fail(HISTORY_ERRORS.invalidOp, `operação desconhecida: ${String((value as { kind?: unknown }).kind)}`);
}

/** O inverso exato: `applyOp(applyOp(doc, op), invert(op))` devolve um documento igual a `doc`. */
export function invert(op: CanvasOp): CanvasOp {
  if (op.kind === "batch") return { kind: "batch", ops: op.ops.map(invertAtomic).reverse() };
  return invertAtomic(op);
}

// ---- aplicação ----

const finiteIn = (value: number, min: number, max: number): boolean => Number.isFinite(value) && value >= min && value <= max;

function checkPoint(point: Point): void {
  const limit = CANVAS_LIMITS.coordinate;
  if (!finiteIn(point.x, -limit, limit) || !finiteIn(point.y, -limit, limit)) fail(HISTORY_ERRORS.invalidOp, "posição fora do intervalo");
}

function checkFrame(frame: Frame): void {
  checkPoint(frame);
  if (!finiteIn(frame.w, 1, CANVAS_LIMITS.size) || !finiteIn(frame.h, 1, CANVAS_LIMITS.size)) fail(HISTORY_ERRORS.invalidOp, "tamanho fora do intervalo");
}

function insertSorted<T>(list: readonly T[], placed: readonly Placed<T>[]): T[] {
  const out = [...list];
  for (const { at, item } of [...placed].sort((a, b) => a.at - b.at)) out.splice(Math.min(at, out.length), 0, structuredClone(item));
  return out;
}

function applyCreate(doc: CanvasDoc, snapshot: Snapshot): CanvasDoc {
  const known = new Set(doc.nodes.map((node) => node.id));
  for (const { item } of snapshot.nodes) {
    if (known.has(item.id)) fail(HISTORY_ERRORS.duplicateTarget, "nó já existe no documento");
    known.add(item.id);
  }
  const edgeIds = new Set(doc.edges.map((edge) => edge.id));
  for (const { item } of snapshot.edges) {
    if (edgeIds.has(item.id)) fail(HISTORY_ERRORS.duplicateTarget, "aresta já existe no documento");
    if (!known.has(item.from) || !known.has(item.to)) fail(HISTORY_ERRORS.danglingReference, "aresta aponta para nó que não existe");
  }
  for (const { item } of snapshot.groups) {
    if (item.members.some((member) => !known.has(member))) fail(HISTORY_ERRORS.danglingReference, "grupo aponta para nó que não existe");
  }
  const nodes = insertSorted(doc.nodes, snapshot.nodes);
  const edges = insertSorted(doc.edges, snapshot.edges);
  if (nodes.length > CANVAS_LIMITS.nodes || edges.length > CANVAS_LIMITS.edges) fail(HISTORY_ERRORS.limitExceeded, "documento passaria do limite");
  // grupo que já existe é trocado pelo estado guardado (perdeu só um membro); o que sumiu volta ao índice de origem
  const stored = new Map(snapshot.groups.map(({ item }) => [item.id, item]));
  const replaced = doc.groups.map((group) => stored.get(group.id) ?? group);
  const fresh = snapshot.groups.filter(({ item }) => !doc.groups.some((group) => group.id === item.id));
  const created: CanvasDoc = { ...doc, nodes, edges, groups: insertSorted(replaced, fresh) };
  return snapshot.hidden && snapshot.hidden.length > 0 ? applyHide(created, snapshot.hidden) : created;
}

function applyDelete(doc: CanvasDoc, snapshot: Snapshot): CanvasDoc {
  const gone = new Set(snapshot.nodes.map(({ item }) => item.id));
  const present = new Set(doc.nodes.map((node) => node.id));
  for (const id of gone) if (!present.has(id)) fail(HISTORY_ERRORS.missingTarget, "nó não existe no documento");
  const groups = doc.groups
    .map((group) => (group.members.some((member) => gone.has(member)) ? { ...group, members: group.members.filter((member) => !gone.has(member)) } : group))
    .filter((group) => group.members.length > 0);
  const kept: CanvasDoc = {
    ...doc,
    nodes: doc.nodes.filter((node) => !gone.has(node.id)),
    // aresta que tocava um nó removido sai junto (o documento não aceita ponta solta)
    edges: doc.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to)),
    groups,
  };
  // oculto que sai do documento sai da lista também (o documento não aceita oculto sem nó)
  return doc.hidden?.some((id) => gone.has(id)) ? withHidden(kept, doc.hidden.filter((id) => !gone.has(id))) : kept;
}

function applyHide(doc: CanvasDoc, ids: readonly Placed<string>[]): CanvasDoc {
  if (ids.length === 0) return fail(HISTORY_ERRORS.invalidOp, "ocultar sem nó");
  const known = new Set(doc.nodes.map((node) => node.id));
  const hidden = new Set(doc.hidden ?? []);
  for (const { item } of ids) {
    if (!known.has(item)) fail(HISTORY_ERRORS.danglingReference, "ocultar aponta para nó que não existe");
    if (hidden.has(item)) fail(HISTORY_ERRORS.duplicateTarget, "o nó já está oculto");
    hidden.add(item);
  }
  if (hidden.size > CANVAS_LIMITS.hidden) fail(HISTORY_ERRORS.limitExceeded, "ocultos passariam do limite");
  return withHidden(doc, insertSorted(doc.hidden ?? [], ids));
}

function applyUnhide(doc: CanvasDoc, ids: readonly Placed<string>[]): CanvasDoc {
  if (ids.length === 0) return fail(HISTORY_ERRORS.invalidOp, "reexibir sem nó");
  const hidden = new Set(doc.hidden ?? []);
  const gone = new Set<string>();
  for (const { item } of ids) {
    if (!hidden.has(item) || gone.has(item)) fail(HISTORY_ERRORS.missingTarget, "o nó não está oculto");
    gone.add(item);
  }
  return withHidden(doc, (doc.hidden ?? []).filter((id) => !gone.has(id)));
}

function applyGroup(doc: CanvasDoc, placed: Placed<CanvasGroup>): CanvasDoc {
  const { item } = placed;
  if (doc.groups.some((group) => group.id === item.id)) return fail(HISTORY_ERRORS.duplicateTarget, "grupo já existe no documento");
  const known = new Set(doc.nodes.map((node) => node.id));
  if (item.members.length === 0 || new Set(item.members).size !== item.members.length || item.members.some((member) => !known.has(member))) {
    return fail(HISTORY_ERRORS.danglingReference, "grupo com membro inválido");
  }
  if (doc.groups.length >= CANVAS_LIMITS.groups) return fail(HISTORY_ERRORS.limitExceeded, "documento passaria do limite de grupos");
  return { ...doc, groups: insertSorted(doc.groups, [placed]) };
}

function applyUngroup(doc: CanvasDoc, placed: Placed<CanvasGroup>): CanvasDoc {
  if (!doc.groups.some((group) => group.id === placed.item.id)) return fail(HISTORY_ERRORS.missingTarget, "grupo não existe no documento");
  return { ...doc, groups: doc.groups.filter((group) => group.id !== placed.item.id) };
}

/** `data` com as regras do documento (JSON puro, profundidade, nó vivo sem conteúdo): o próprio validador do documento decide. */
function checkData(node: CanvasNode, data: Record<string, unknown>): void {
  try {
    validateCanvasDoc({ v: 1, rev: 0, nodes: [{ ...node, data }], edges: [], groups: [] });
  } catch {
    fail(HISTORY_ERRORS.invalidOp, "data inválido para o nó");
  }
}

function checkPatch(patch: NodePatch): void {
  const { z, locked, blurred } = patch;
  const layer = CANVAS_LIMITS.layer;
  if (z !== undefined && !(Number.isInteger(z) && z >= -layer && z <= layer)) fail(HISTORY_ERRORS.invalidOp, "camada fora do intervalo");
  if ((locked !== undefined && typeof locked !== "boolean") || (blurred !== undefined && typeof blurred !== "boolean")) {
    fail(HISTORY_ERRORS.invalidOp, "locked e blurred precisam ser booleanos");
  }
}

/** Placa mínima de nó só para o validador do documento conferir id, kind e pontas de uma aresta. */
const stub = (id: string): CanvasNode => ({ id, type: "stub", x: 0, y: 0, w: 1, h: 1, z: 0, data: {}, locked: false, blurred: false });

function checkEdgeCreate(doc: CanvasDoc, placed: Placed<CanvasEdge>): void {
  const { item } = placed;
  if (doc.edges.some((edge) => edge.id === item.id)) fail(HISTORY_ERRORS.duplicateTarget, "aresta já existe no documento");
  const known = new Set(doc.nodes.map((node) => node.id));
  if (!known.has(item.from) || !known.has(item.to)) fail(HISTORY_ERRORS.danglingReference, "aresta aponta para nó que não existe");
  if (doc.edges.length >= CANVAS_LIMITS.edges) fail(HISTORY_ERRORS.limitExceeded, "documento passaria do limite de arestas");
  try {
    validateCanvasDoc({ v: 1, rev: 0, nodes: [...new Set([item.from, item.to])].map(stub), edges: [item], groups: [] });
  } catch {
    fail(HISTORY_ERRORS.invalidOp, "aresta com forma inválida");
  }
}

function checkLink(doc: CanvasDoc, groupId: string, member: Placed<string>): CanvasGroup {
  const group = doc.groups.find((candidate) => candidate.id === groupId) ?? fail(HISTORY_ERRORS.missingTarget, "grupo não existe no documento");
  if (!doc.nodes.some((node) => node.id === member.item)) return fail(HISTORY_ERRORS.danglingReference, "grupo aponta para nó que não existe");
  if (group.members.includes(member.item)) return fail(HISTORY_ERRORS.duplicateTarget, "o nó já é membro do grupo");
  if (group.members.length >= CANVAS_LIMITS.groupMembers) return fail(HISTORY_ERRORS.limitExceeded, "grupo passaria do limite de membros");
  return group;
}

function applyEdgeDelete(doc: CanvasDoc, placed: Placed<CanvasEdge>): CanvasDoc {
  if (!doc.edges.some((edge) => edge.id === placed.item.id)) return fail(HISTORY_ERRORS.missingTarget, "aresta não existe no documento");
  return { ...doc, edges: doc.edges.filter((edge) => edge.id !== placed.item.id) };
}

function applyUnlink(doc: CanvasDoc, groupId: string, member: Placed<string>): CanvasDoc {
  const group = doc.groups.find((candidate) => candidate.id === groupId) ?? fail(HISTORY_ERRORS.missingTarget, "grupo não existe no documento");
  if (!group.members.includes(member.item)) return fail(HISTORY_ERRORS.missingTarget, "o nó não é membro do grupo");
  if (group.members.length === 1) return fail(HISTORY_ERRORS.invalidOp, "o último membro sai desfazendo o grupo");
  const members = group.members.filter((id) => id !== member.item);
  return { ...doc, groups: doc.groups.map((candidate) => (candidate.id === groupId ? { ...candidate, members } : candidate)) };
}

function applyLink(doc: CanvasDoc, groupId: string, member: Placed<string>): CanvasDoc {
  const group = checkLink(doc, groupId, member);
  const members = [...group.members];
  members.splice(Math.min(member.at, members.length), 0, member.item);
  return { ...doc, groups: doc.groups.map((candidate) => (candidate.id === groupId ? { ...candidate, members } : candidate)) };
}

function applyAtomic(doc: CanvasDoc, op: AtomicOp): CanvasDoc {
  switch (op.kind) {
    case "move":
      checkPoint(op.to);
      nodeOf(doc, op.id);
      return { ...doc, nodes: doc.nodes.map((node) => (node.id === op.id ? { ...node, x: op.to.x, y: op.to.y } : node)) };
    case "resize":
      checkFrame(op.to);
      nodeOf(doc, op.id);
      return { ...doc, nodes: doc.nodes.map((node) => (node.id === op.id ? { ...node, ...op.to } : node)) };
    case "create": return applyCreate(doc, op.snapshot);
    case "delete": return applyDelete(doc, op.snapshot);
    case "group": return applyGroup(doc, op.group);
    case "ungroup": return applyUngroup(doc, op.group);
    case "update": {
      const node = nodeOf(doc, op.id);
      checkData(node, op.to);
      return { ...doc, nodes: doc.nodes.map((candidate) => (candidate.id === op.id ? { ...candidate, data: structuredClone(op.to) } : candidate)) };
    }
    case "edge-create":
      checkEdgeCreate(doc, op.edge);
      return { ...doc, edges: insertSorted(doc.edges, [op.edge]) };
    case "edge-delete": return applyEdgeDelete(doc, op.edge);
    case "patch":
      checkPatch(op.to);
      nodeOf(doc, op.id);
      return { ...doc, nodes: doc.nodes.map((node) => (node.id === op.id ? { ...node, ...op.to } : node)) };
    case "link": return applyLink(doc, op.groupId, op.member);
    case "unlink": return applyUnlink(doc, op.groupId, op.member);
    case "hide": return applyHide(doc, op.ids);
    case "unhide": return applyUnhide(doc, op.ids);
    default: return assertNever(op);
  }
}

/** Aplica a operação e devolve o documento novo; se qualquer passo falhar, lança e nada muda (o lote é tudo ou nada). */
export function applyOp(doc: CanvasDoc, op: CanvasOp): CanvasDoc {
  if (op.kind === "batch") {
    if (op.ops.length === 0) return fail(HISTORY_ERRORS.emptyBatch, "lote vazio");
    return op.ops.reduce(applyAtomic, doc);
  }
  return applyAtomic(doc, op);
}

// ---- pilha ----

export interface History {
  readonly limit: number;
  /** Passos já feitos, do mais antigo ao mais novo: o último é o que `undo` desfaz. */
  readonly past: readonly CanvasOp[];
  /** Passos desfeitos: o último é o que `redo` refaz. */
  readonly future: readonly CanvasOp[];
}

export interface Applied {
  doc: CanvasDoc;
  history: History;
}

export function createHistory(limit: number = HISTORY_LIMIT_DEFAULT): History {
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT_MAX) return fail(HISTORY_ERRORS.invalidOp, "limite da pilha fora do intervalo");
  return { limit, past: [], future: [] };
}

export const canUndo = (history: History): boolean => history.past.length > 0;
export const canRedo = (history: History): boolean => history.future.length > 0;

const trimmed = (past: readonly CanvasOp[], limit: number): readonly CanvasOp[] => (past.length > limit ? past.slice(past.length - limit) : past);

/** Registra um passo que o chamador já aplicou (arrastar mostra o movimento ao vivo e registra ao soltar). Limpa o refazer. */
export function record(history: History, op: CanvasOp): History {
  return { limit: history.limit, past: trimmed([...history.past, op], history.limit), future: [] };
}

/** Aplica e registra. Falhou ao aplicar: lança e a pilha fica como estava. */
export function perform(history: History, doc: CanvasDoc, op: CanvasOp): Applied {
  const next = applyOp(doc, op);
  return { doc: next, history: record(history, op) };
}

/** Desfaz o último passo; `undefined` se não há o que desfazer. */
export function undo(history: History, doc: CanvasDoc): Applied | undefined {
  const op = history.past[history.past.length - 1];
  if (!op) return undefined;
  const next = applyOp(doc, invert(op));
  return { doc: next, history: { limit: history.limit, past: history.past.slice(0, -1), future: [...history.future, op] } };
}

/** Refaz o último passo desfeito; `undefined` se não há o que refazer. */
export function redo(history: History, doc: CanvasDoc): Applied | undefined {
  const op = history.future[history.future.length - 1];
  if (!op) return undefined;
  const next = applyOp(doc, op);
  return { doc: next, history: { limit: history.limit, past: trimmed([...history.past, op], history.limit), future: history.future.slice(0, -1) } };
}
