// Documento do canvas do Argos (reference/argos.md §Documento do canvas): formato versionado, validação na fronteira,
// migração por `v` e mescla com o grafo vivo. Lógica pura e sem dependência de Node: o mesmo módulo roda no servidor
// (rota /api/canvas) e no navegador do painel (React via htm, sem bundler).

export const CANVAS_VERSION = 1;

/** Teto de tudo que vem de fora: o servidor recusa acima disso antes de qualquer algoritmo sobre o documento. */
export const CANVAS_LIMITS = {
  bodyBytes: 1_048_576,
  nodes: 2000,
  edges: 5000,
  groups: 500,
  groupMembers: 2000,
  dataDepth: 8,
  idChars: 200,
  labelChars: 200,
  coordinate: 10_000_000,
  size: 1_000_000,
  layer: 1_000_000,
  revision: Number.MAX_SAFE_INTEGER,
  /** Abraçadeiras numa mesma conexão (`link`). */
  edgeClamps: 8,
  /** Nós ocultos (`hidden`): no máximo um por nó. */
  hidden: 2000,
} as const;

/** Códigos estáveis: só ganham valores, nunca renomeiam. Quem consome ramifica pelo código, não pela mensagem. */
export const CANVAS_ERRORS = {
  invalidJson: "canvas_invalid_json",
  tooLarge: "canvas_too_large",
  invalidShape: "canvas_invalid_shape",
  unsupportedVersion: "canvas_unsupported_version",
  invalidNode: "canvas_invalid_node",
  invalidEdge: "canvas_invalid_edge",
  invalidGroup: "canvas_invalid_group",
  duplicateId: "canvas_duplicate_id",
  danglingReference: "canvas_dangling_reference",
  limitExceeded: "canvas_limit_exceeded",
  staleRevision: "canvas_stale_revision",
  unreadable: "canvas_unreadable",
  massRemoval: "canvas_mass_removal",
} as const;
export type CanvasErrorCode = (typeof CANVAS_ERRORS)[keyof typeof CANVAS_ERRORS];

export class CanvasError extends Error {
  readonly code: CanvasErrorCode;
  constructor(code: CanvasErrorCode, message: string) {
    super(message);
    this.name = "CanvasError";
    this.code = code;
  }
}

/** Tipos de nó que vêm do grafo do Argos: o documento guarda só posição e estado visual deles. */
export const LIVE_NODE_TYPES = ["agent", "unit", "pr", "gate"] as const;
export type LiveNodeType = (typeof LIVE_NODE_TYPES)[number];

export interface CanvasNode {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  data: Record<string, unknown>;
  locked: boolean;
  blurred: boolean;
}

/** Aresta de conexão do dono (reference/argos.md §Conexões): a única que leva `style` e `clamps`. */
export const LINK_EDGE_KIND = "link";
export const LINK_STYLES = ["rope", "circuit"] as const;
export type LinkStyle = (typeof LINK_STYLES)[number];

/** Abraçadeira presa numa conexão: `t` é a fração da reta entre as pontas (0 e 1 exclusivos). Só visual. */
export interface EdgeClamp {
  id: string;
  t: number;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  /** Só em `link`; ausente vale `rope`. */
  style?: LinkStyle;
  /** Só em `link`; ausente é sem abraçadeira (lista vazia não existe). */
  clamps?: EdgeClamp[];
}

export interface CanvasGroup {
  id: string;
  label: string;
  members: string[];
}

export interface CanvasDoc {
  v: number;
  /** Revisão da gravação: o servidor soma 1 a cada `PUT`; o cliente devolve a que leu (409 se ficou velha). */
  rev: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  groups: CanvasGroup[];
  /**
   * Ids dos nós que o dono tirou do canvas (reference/argos.md §Ocultar e podar o canvas): o nó segue no documento, com a
   * posição, e só sai do desenho. Ausente é nada oculto (lista vazia não existe); documento antigo sem o campo segue válido.
   */
  hidden?: string[];
}

const ID = /^[\w.:-]+$/;
const KIND = /^[a-z][a-z0-9_-]{0,39}$/;
const NODE_KEYS = ["id", "type", "x", "y", "w", "h", "z", "data", "locked", "blurred"];
const EDGE_KEYS = ["id", "from", "to", "kind", "style", "clamps"];
const CLAMP_KEYS = ["id", "t"];
const GROUP_KEYS = ["id", "label", "members"];
const DOC_KEYS = ["v", "rev", "nodes", "edges", "groups", "hidden"];

export const emptyCanvasDoc = (): CanvasDoc => ({ v: CANVAS_VERSION, rev: 0, nodes: [], edges: [], groups: [] });

export const isLiveNodeType = (type: string): type is LiveNodeType => (LIVE_NODE_TYPES as readonly string[]).includes(type);

/** Os ocultos do documento como conjunto (vazio quando o campo não vem). */
export const hiddenIds = (doc: Pick<CanvasDoc, "hidden">): ReadonlySet<string> => new Set(doc.hidden ?? []);

/** O documento com a lista de ocultos dada; lista vazia tira o campo (a forma gravada não leva `hidden: []`). */
export function withHidden(doc: CanvasDoc, hidden: readonly string[]): CanvasDoc {
  const { hidden: _old, ...rest } = doc;
  return hidden.length > 0 ? { ...rest, hidden: [...hidden] } : rest;
}

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (code: CanvasErrorCode, message: string): never => {
  throw new CanvasError(code, message);
};

function onlyKeys(value: Dict, allowed: readonly string[], code: CanvasErrorCode, what: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(code, `${what}: campo desconhecido "${key.slice(0, 40)}"`);
}

function validId(value: unknown, code: CanvasErrorCode, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > CANVAS_LIMITS.idChars || !ID.test(value)) {
    return fail(code, `${what}: id inválido`);
  }
  return value;
}

function boundedNumber(value: unknown, min: number, max: number, code: CanvasErrorCode, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return fail(code, `${what}: número fora do intervalo`);
  return value;
}

function boundedInteger(value: unknown, min: number, max: number, code: CanvasErrorCode, what: string): number {
  const n = boundedNumber(value, min, max, code, what);
  return Number.isInteger(n) ? n : fail(code, `${what}: precisa ser inteiro`);
}

/** `data` de nó livre: JSON puro (sem undefined, NaN, função) e com profundidade limitada, para quem consome não recursar sem teto. */
function checkJsonValue(value: unknown, depth: number): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(CANVAS_ERRORS.invalidNode, "nó: data com número inválido");
    return;
  }
  if (depth >= CANVAS_LIMITS.dataDepth) fail(CANVAS_ERRORS.invalidNode, "nó: data profundo demais");
  if (Array.isArray(value)) {
    for (const item of value) checkJsonValue(item, depth + 1);
    return;
  }
  if (isDict(value)) {
    for (const item of Object.values(value)) checkJsonValue(item, depth + 1);
    return;
  }
  fail(CANVAS_ERRORS.invalidNode, "nó: data com valor que não é JSON");
}

function validateNode(raw: unknown): CanvasNode {
  if (!isDict(raw)) return fail(CANVAS_ERRORS.invalidNode, "nó: precisa ser objeto");
  onlyKeys(raw, NODE_KEYS, CANVAS_ERRORS.invalidNode, "nó");
  const id = validId(raw.id, CANVAS_ERRORS.invalidNode, "nó");
  if (typeof raw.type !== "string" || !KIND.test(raw.type)) return fail(CANVAS_ERRORS.invalidNode, "nó: type inválido");
  const { type } = raw;
  const { coordinate, size, layer } = CANVAS_LIMITS;
  const node: CanvasNode = {
    id,
    type,
    x: boundedNumber(raw.x, -coordinate, coordinate, CANVAS_ERRORS.invalidNode, "nó x"),
    y: boundedNumber(raw.y, -coordinate, coordinate, CANVAS_ERRORS.invalidNode, "nó y"),
    w: boundedNumber(raw.w, 1, size, CANVAS_ERRORS.invalidNode, "nó w"),
    h: boundedNumber(raw.h, 1, size, CANVAS_ERRORS.invalidNode, "nó h"),
    z: boundedInteger(raw.z, -layer, layer, CANVAS_ERRORS.invalidNode, "nó z"),
    data: {},
    locked: typeof raw.locked === "boolean" ? raw.locked : fail(CANVAS_ERRORS.invalidNode, "nó: locked precisa ser booleano"),
    blurred: typeof raw.blurred === "boolean" ? raw.blurred : fail(CANVAS_ERRORS.invalidNode, "nó: blurred precisa ser booleano"),
  };
  if (!isDict(raw.data)) return fail(CANVAS_ERRORS.invalidNode, "nó: data precisa ser objeto");
  if (isLiveNodeType(type)) {
    // o conteúdo do nó vivo vem sempre de /api/argos/graph; o id carrega o tipo (`agent:<registro>:<nome>`)
    if (Object.keys(raw.data).length > 0) return fail(CANVAS_ERRORS.invalidNode, "nó vivo não guarda conteúdo");
    if (!id.startsWith(`${type}:`)) return fail(CANVAS_ERRORS.invalidNode, "nó vivo: id não bate com o type");
  } else {
    checkJsonValue(raw.data, 0);
    node.data = structuredClone(raw.data);
  }
  return node;
}

function validateEdge(raw: unknown, nodeIds: ReadonlySet<string>): CanvasEdge {
  if (!isDict(raw)) return fail(CANVAS_ERRORS.invalidEdge, "aresta: precisa ser objeto");
  onlyKeys(raw, EDGE_KEYS, CANVAS_ERRORS.invalidEdge, "aresta");
  const edge: CanvasEdge = {
    id: validId(raw.id, CANVAS_ERRORS.invalidEdge, "aresta"),
    from: validId(raw.from, CANVAS_ERRORS.invalidEdge, "aresta from"),
    to: validId(raw.to, CANVAS_ERRORS.invalidEdge, "aresta to"),
    kind: typeof raw.kind === "string" && KIND.test(raw.kind) ? raw.kind : fail(CANVAS_ERRORS.invalidEdge, "aresta: kind inválido"),
  };
  if (raw.style !== undefined) edge.style = validLinkStyle(raw.style, edge.kind);
  if (raw.clamps !== undefined) edge.clamps = validClamps(raw.clamps, edge.kind);
  if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) fail(CANVAS_ERRORS.danglingReference, "aresta aponta para nó que não existe");
  return edge;
}

const isLinkStyle = (value: unknown): value is LinkStyle => typeof value === "string" && (LINK_STYLES as readonly string[]).includes(value);

function validLinkStyle(value: unknown, kind: string): LinkStyle {
  if (kind !== LINK_EDGE_KIND) return fail(CANVAS_ERRORS.invalidEdge, "aresta: style só existe em conexão");
  return isLinkStyle(value) ? value : fail(CANVAS_ERRORS.invalidEdge, "aresta: style desconhecido");
}

function validClamps(value: unknown, kind: string): EdgeClamp[] {
  if (kind !== LINK_EDGE_KIND) return fail(CANVAS_ERRORS.invalidEdge, "aresta: clamps só existe em conexão");
  if (!Array.isArray(value) || value.length === 0) return fail(CANVAS_ERRORS.invalidEdge, "aresta: clamps precisa ser lista não vazia");
  if (value.length > CANVAS_LIMITS.edgeClamps) return fail(CANVAS_ERRORS.limitExceeded, "aresta com abraçadeiras demais");
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    if (!isDict(raw)) return fail(CANVAS_ERRORS.invalidEdge, "abraçadeira: precisa ser objeto");
    onlyKeys(raw, CLAMP_KEYS, CANVAS_ERRORS.invalidEdge, "abraçadeira");
    const id = validId(raw.id, CANVAS_ERRORS.invalidEdge, "abraçadeira");
    if (seen.has(id)) fail(CANVAS_ERRORS.duplicateId, "abraçadeira repetida na aresta");
    seen.add(id);
    const t = raw.t;
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t >= 1) return fail(CANVAS_ERRORS.invalidEdge, "abraçadeira: t fora de (0, 1)");
    return { id, t };
  });
}

function validateGroup(raw: unknown, nodeIds: ReadonlySet<string>): CanvasGroup {
  if (!isDict(raw)) return fail(CANVAS_ERRORS.invalidGroup, "grupo: precisa ser objeto");
  onlyKeys(raw, GROUP_KEYS, CANVAS_ERRORS.invalidGroup, "grupo");
  const id = validId(raw.id, CANVAS_ERRORS.invalidGroup, "grupo");
  if (typeof raw.label !== "string" || raw.label.length > CANVAS_LIMITS.labelChars) return fail(CANVAS_ERRORS.invalidGroup, "grupo: label inválido");
  if (!Array.isArray(raw.members) || raw.members.length === 0) return fail(CANVAS_ERRORS.invalidGroup, "grupo: members precisa ser lista não vazia");
  if (raw.members.length > CANVAS_LIMITS.groupMembers) return fail(CANVAS_ERRORS.limitExceeded, "grupo com membros demais");
  const seen = new Set<string>();
  const members = raw.members.map((member: unknown) => {
    const memberId = validId(member, CANVAS_ERRORS.invalidGroup, "grupo member");
    if (seen.has(memberId)) fail(CANVAS_ERRORS.invalidGroup, "grupo: membro repetido");
    if (!nodeIds.has(memberId)) fail(CANVAS_ERRORS.danglingReference, "grupo aponta para nó que não existe");
    seen.add(memberId);
    return memberId;
  });
  return { id, label: raw.label, members };
}

function validateHidden(raw: unknown, nodeIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return fail(CANVAS_ERRORS.invalidShape, "hidden precisa ser lista não vazia");
  if (raw.length > CANVAS_LIMITS.hidden) return fail(CANVAS_ERRORS.limitExceeded, `hidden acima do limite de ${CANVAS_LIMITS.hidden}`);
  const seen = new Set<string>();
  return raw.map((item: unknown) => {
    const id = validId(item, CANVAS_ERRORS.invalidShape, "hidden");
    if (seen.has(id)) fail(CANVAS_ERRORS.duplicateId, "hidden: id repetido");
    if (!nodeIds.has(id)) fail(CANVAS_ERRORS.danglingReference, "hidden aponta para nó que não existe");
    seen.add(id);
    return id;
  });
}

function uniqueIds(items: readonly { id: string }[], what: string): void {
  const seen = new Set<string>();
  for (const { id } of items) {
    if (seen.has(id)) fail(CANVAS_ERRORS.duplicateId, `${what}: id repetido`);
    seen.add(id);
  }
}

function listOf(value: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(value)) return fail(CANVAS_ERRORS.invalidShape, `${what} precisa ser lista`);
  if (value.length > max) return fail(CANVAS_ERRORS.limitExceeded, `${what} acima do limite de ${max}`);
  return value;
}

/** Valida um documento **na versão atual** e devolve uma cópia normalizada (nunca o mesmo objeto). Lança `CanvasError`. */
export function validateCanvasDoc(raw: unknown): CanvasDoc {
  if (!isDict(raw)) return fail(CANVAS_ERRORS.invalidShape, "documento precisa ser objeto");
  onlyKeys(raw, DOC_KEYS, CANVAS_ERRORS.invalidShape, "documento");
  if (raw.v !== CANVAS_VERSION) return fail(CANVAS_ERRORS.unsupportedVersion, "versão do documento não suportada");
  const rev = boundedInteger(raw.rev, 0, CANVAS_LIMITS.revision, CANVAS_ERRORS.invalidShape, "documento rev");
  const nodes = listOf(raw.nodes, CANVAS_LIMITS.nodes, "nodes").map(validateNode);
  uniqueIds(nodes, "nó");
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = listOf(raw.edges, CANVAS_LIMITS.edges, "edges").map((edge) => validateEdge(edge, nodeIds));
  uniqueIds(edges, "aresta");
  const groups = listOf(raw.groups, CANVAS_LIMITS.groups, "groups").map((group) => validateGroup(group, nodeIds));
  uniqueIds(groups, "grupo");
  const doc: CanvasDoc = { v: CANVAS_VERSION, rev, nodes, edges, groups };
  if (raw.hidden !== undefined) doc.hidden = validateHidden(raw.hidden, nodeIds);
  return doc;
}

/** Passo `v` → `v + 1`; recebe o documento na forma da versão `v`. */
export type CanvasMigration = (doc: Dict) => Dict;

/** Tabela de migrações por versão de origem. Hoje só existe a v1: o caminho está pronto e testado, a tabela vazia. */
export const CANVAS_MIGRATIONS: Readonly<Record<number, CanvasMigration>> = {};

/**
 * Leva o documento de qualquer versão conhecida até `target`, passo a passo. Versão acima da `target` (escrita por uma
 * skill mais nova) ou sem passo de migração é `canvas_unsupported_version`: nunca se adivinha a forma.
 */
export function migrateCanvasDoc(raw: unknown, migrations: Readonly<Record<number, CanvasMigration>> = CANVAS_MIGRATIONS, target: number = CANVAS_VERSION): unknown {
  if (!isDict(raw)) return fail(CANVAS_ERRORS.invalidShape, "documento precisa ser objeto");
  let doc: Dict = raw;
  while (doc.v !== target) {
    const from = doc.v;
    if (typeof from !== "number" || !Number.isInteger(from) || from >= target) return fail(CANVAS_ERRORS.unsupportedVersion, "versão do documento não suportada");
    const step = migrations[from];
    if (!step) return fail(CANVAS_ERRORS.unsupportedVersion, "versão do documento não suportada");
    const next = step(doc);
    if (!isDict(next) || next.v !== from + 1) return fail(CANVAS_ERRORS.unsupportedVersion, "migração não avançou a versão");
    doc = next;
  }
  return doc;
}

/** Migra e valida: a entrada de tudo que vem de fora (corpo do `PUT`, arquivo em disco). */
export function readCanvasDoc(raw: unknown): CanvasDoc {
  return validateCanvasDoc(migrateCanvasDoc(raw));
}

/** Texto JSON → documento válido, com o teto de bytes conferido antes do `JSON.parse`. */
export function parseCanvasText(text: string): CanvasDoc {
  if (new TextEncoder().encode(text).length > CANVAS_LIMITS.bodyBytes) return fail(CANVAS_ERRORS.tooLarge, "documento acima do limite de bytes");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(CANVAS_ERRORS.invalidJson, "corpo não é JSON");
  }
  return readCanvasDoc(parsed);
}

/** O que a mescla precisa do grafo: `id` e `type` de cada nó de `GET /api/argos/graph` (campo a mais é ignorado). */
export interface GraphNodeRef {
  id: string;
  type: string;
}

/** Por que a mescla segurou a remoção de nós vivos (códigos estáveis: só ganham valores). */
export const HELD_REASONS = { empty: "graph_empty", partial: "graph_partial", untrusted: "graph_untrusted", unconfirmed: "graph_unconfirmed" } as const;
export type HeldReason = (typeof HELD_REASONS)[keyof typeof HELD_REASONS];

/**
 * Confiança no grafo para remover nó vivo (reference/argos.md §Quando um nó sai do canvas). Um grafo que perde muitos nós de uma
 * vez é leitura parcial (herdr reiniciando, registro ilegível), não o fim de tudo: nada sai e a próxima leitura decide.
 */
export const GRAPH_TRUST = {
  /** Remoção de pelo menos tantos nós vivos numa leitura só... */
  massMinRemoved: 3,
  /** ...que também passe da metade dos nós vivos do documento, é tratada como leitura parcial. */
  massShareOver: 0.5,
  /** Grafo sem nenhum nó vivo só vale como "vazio de verdade" quando o documento tem menos que isto de nós vivos. */
  emptyMinLive: 2,
} as const;

export interface MergeOptions {
  /** `false`: o chamador sabe que a leitura do grafo falhou ou veio incompleta; nenhum nó vivo sai. */
  trusted?: boolean;
  /** Ids de nós vivos do documento que o chamador já confirmou ausentes em leituras seguidas; só estes saem (ausente: todos os ausentes). */
  confirmedAbsent?: ReadonlySet<string>;
}

export interface MergeResult {
  /** O documento salvo sem os nós vivos que saíram do grafo (e as arestas e membros de grupo que apontavam para eles). */
  doc: CanvasDoc;
  /** Ids de nós vivos do grafo que o documento não conhece: o layout dá posição e tamanho (a mescla não escolhe). */
  unplaced: string[];
  /** Ids de nós vivos do documento que sumiram do grafo. */
  removed: string[];
  /** Nós vivos ausentes do grafo que ficaram no documento por falta de confiança na leitura (`heldReason` diz por quê). */
  held?: string[];
  heldReason?: HeldReason;
}

/**
 * Mescla o documento salvo com o grafo atual. Nó vivo que sumiu do grafo sai (e deixa a lista de ocultos) só quando a leitura é
 * confiável: grafo vazio, parcial (remoção em massa) ou marcado `trusted: false` não remove nada. Nó vivo novo vai em
 * `unplaced`. Nó oculto que segue no grafo fica oculto: o grafo nunca o devolve ao desenho. Nó que não é vivo (nota, desenho,
 * terminal…) nunca é tocado. Não escolhe posição e não altera `doc`.
 */
export function mergeWithGraph(doc: CanvasDoc, graphNodes: readonly GraphNodeRef[], options: MergeOptions = {}): MergeResult {
  const inGraph = new Set<string>();
  const unplaced: string[] = [];
  const saved = new Set(doc.nodes.map((node) => node.id));
  for (const ref of graphNodes) {
    if (!isLiveNodeType(ref.type) || inGraph.has(ref.id)) continue;
    inGraph.add(ref.id);
    if (!saved.has(ref.id)) unplaced.push(ref.id);
  }
  const live = doc.nodes.filter((node) => isLiveNodeType(node.type));
  const absent = live.filter((node) => !inGraph.has(node.id)).map((node) => node.id);
  const heldReason = absent.length === 0 ? undefined : holdReason(live.length, absent.length, inGraph.size, options.trusted !== false);
  if (heldReason !== undefined) return { doc: { ...doc }, unplaced, removed: [], held: absent, heldReason };
  const confirmed = options.confirmedAbsent;
  const removed = confirmed === undefined ? absent : absent.filter((id) => confirmed.has(id));
  const held = absent.filter((id) => !removed.includes(id));
  const kept = held.length > 0 ? { held, heldReason: HELD_REASONS.unconfirmed } : {};
  if (removed.length === 0) return { doc: { ...doc }, unplaced, removed, ...kept };
  return { doc: withoutNodes(doc, new Set(removed)), unplaced, removed, ...kept };
}

function holdReason(liveInDoc: number, absent: number, liveInGraph: number, trusted: boolean): HeldReason | undefined {
  if (!trusted) return HELD_REASONS.untrusted;
  if (liveInGraph === 0 && liveInDoc >= GRAPH_TRUST.emptyMinLive) return HELD_REASONS.empty;
  if (absent >= GRAPH_TRUST.massMinRemoved && absent > liveInDoc * GRAPH_TRUST.massShareOver) return HELD_REASONS.partial;
  return undefined;
}

/** O documento sem os nós `gone`, com as arestas, os membros de grupo (e grupos que ficam vazios) e os ocultos que apontavam para eles. */
export function withoutNodes(doc: CanvasDoc, gone: ReadonlySet<string>): CanvasDoc {
  const groups = doc.groups
    .map((group) => ({ ...group, members: group.members.filter((member) => !gone.has(member)) }))
    .filter((group) => group.members.length > 0);
  const merged: CanvasDoc = {
    ...doc,
    nodes: doc.nodes.filter((node) => !gone.has(node.id)),
    edges: doc.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to)),
    groups,
  };
  return doc.hidden ? withHidden(merged, doc.hidden.filter((id) => !gone.has(id))) : merged;
}

/** Chave de identidade de um pane do herdr: um pane, um nó. Reutilizada por quem junta nós ao mesmo processo. */
export const paneKey = (target: { session: string; pane: string }): string => `${target.session}\u0000${target.pane}`;

/** O que uma gravação tira do documento: nós (por tipo) e arestas que sumiram entre `before` e `after`. */
export interface Removals {
  nodes: { id: string; type: string }[];
  edges: string[];
}

export function removalsBetween(before: CanvasDoc, after: CanvasDoc): Removals {
  const keptNodes = new Set(after.nodes.map((node) => node.id));
  const keptEdges = new Set(after.edges.map((edge) => edge.id));
  return {
    nodes: before.nodes.filter((node) => !keptNodes.has(node.id)).map((node) => ({ id: node.id, type: node.type })),
    edges: before.edges.filter((edge) => !keptEdges.has(edge.id)).map((edge) => edge.id),
  };
}

/** Nós do usuário (nota, terminal, desenho…) que a gravação tira; nó vivo sai pelo grafo e tem a regra própria acima. */
export const userRemovals = (removals: Removals): { id: string; type: string }[] => removals.nodes.filter((node) => !isLiveNodeType(node.type));

/** Teto de remoção de nós do usuário (nota, terminal, desenho…) numa gravação só, sem confirmação do dono. */
export const USER_REMOVAL_GUARD = { minNodes: 5, shareOver: 0.5 } as const;

/**
 * Remoção em massa de nós do usuário numa gravação só: pelo menos `minNodes` e mais da metade dos nós do usuário que o documento
 * tinha. O servidor recusa sem confirmação (`canvas_mass_removal`): é o jeito de uma aba defasada ou um bug de cliente não
 * levar notas e terminais embora em silêncio.
 */
export function isMassUserRemoval(before: CanvasDoc, removals: Removals): boolean {
  const total = before.nodes.filter((node) => !isLiveNodeType(node.type)).length;
  const lost = userRemovals(removals).length;
  return lost >= USER_REMOVAL_GUARD.minNodes && lost > total * USER_REMOVAL_GUARD.shareOver;
}
