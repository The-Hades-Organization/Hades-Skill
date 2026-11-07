// Conexões do dono no canvas do Argos (reference/argos.md §Conexões): aresta `link` com estilo corda ou circuito e
// abraçadeiras só visuais. Lógica pura, sem Node/DOM: quem pode ligar com quem e o que isso significa, as operações do
// desfazer (toda mudança sai como `AtomicOp` de `canvas-history`, e trocar estilo ou abraçadeira é apagar e recriar a
// aresta no mesmo índice, então desfazer volta exatamente ao anterior), a rota do circuito e a física leve da corda.
import type { Rect, Vec } from "./canvas-camera.ts";
import {
  CANVAS_LIMITS, type CanvasDoc, type CanvasEdge, type CanvasNode, type EdgeClamp, LINK_EDGE_KIND, LINK_STYLES, type LinkStyle,
} from "./canvas-doc.ts";
import { type AtomicOp, type CanvasOp, opBatch, opEdgeCreate, opEdgeDelete } from "./canvas-history.ts";
import { DRAWING_TYPE } from "./canvas-drawing.ts";
import { NOTE_TYPE } from "./canvas-note.ts";

export { LINK_EDGE_KIND, LINK_STYLES, type LinkStyle };

export const DEFAULT_LINK_STYLE: LinkStyle = "rope";

/**
 * O que cada ponta é para a conexão; tipo de nó fora desta tabela não conecta. `terminal` é o nó que a ferramenta
 * Terminal da barra cria (pane do herdr sem agente do loop): conecta como o `agent`.
 */
export type LinkEnd = "terminal" | "note" | "drawing";
const LINK_END_BY_TYPE: Readonly<Record<string, LinkEnd>> = { agent: "terminal", terminal: "terminal", [NOTE_TYPE]: "note", [DRAWING_TYPE]: "drawing" };

/**
 * O que a conexão dá a quem lê: `note-access` (o agente do terminal lê e escreve a nota pela CLI do painel) e `chain`
 * (nota encadeada: quem lê a nota de entrada percorre a cadeia). Terminal com terminal não tem leitor nesta versão e é
 * recusado (D5: conexão só onde há leitor).
 */
export type LinkMeaning = "note-access" | "chain" | "drawing-access" | "drawing-chain";
const MEANING_BY_PAIR: Readonly<Record<`${LinkEnd}|${LinkEnd}`, LinkMeaning | undefined>> = {
  "terminal|terminal": undefined,
  "terminal|note": "note-access",
  "note|terminal": "note-access",
  "note|note": "chain",
  "terminal|drawing": "drawing-access",
  "drawing|terminal": "drawing-access",
  "drawing|drawing": "drawing-chain",
  "note|drawing": undefined,
  "drawing|note": undefined,
};

/** Códigos estáveis: só ganham valores. */
export const LINK_ERRORS = {
  invalidId: "links_invalid_id",
  duplicateId: "links_duplicate_id",
  danglingNode: "links_dangling_node",
  selfLoop: "links_self_loop",
  duplicateLink: "links_duplicate_link",
  noReader: "links_no_reader",
  limitExceeded: "links_limit_exceeded",
  missingLink: "links_missing_link",
  notLink: "links_not_link",
  invalidStyle: "links_invalid_style",
  invalidClamp: "links_invalid_clamp",
  missingClamp: "links_missing_clamp",
  clampLimit: "links_clamp_limit",
} as const;
export type LinkErrorCode = (typeof LINK_ERRORS)[keyof typeof LINK_ERRORS];

export class LinkError extends Error {
  readonly code: LinkErrorCode;
  constructor(code: LinkErrorCode, message: string) {
    super(message);
    this.name = "LinkError";
    this.code = code;
  }
}

const fail = (code: LinkErrorCode, message: string): never => {
  throw new LinkError(code, message);
};

const ID = /^[\w.:-]+$/;
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= CANVAS_LIMITS.idChars && ID.test(id);

export const isLinkEdge = (edge: CanvasEdge): boolean => edge.kind === LINK_EDGE_KIND;
export const linkStyleOf = (edge: CanvasEdge): LinkStyle => edge.style ?? DEFAULT_LINK_STYLE;
export const isLinkStyle = (value: unknown): value is LinkStyle => typeof value === "string" && (LINK_STYLES as readonly string[]).includes(value);

export const linkEndOf = (type: string): LinkEnd | undefined => (Object.hasOwn(LINK_END_BY_TYPE, type) ? LINK_END_BY_TYPE[type] : undefined);

/** Significado da conexão entre dois tipos de nó; `undefined` quando o par não conecta. */
export function linkMeaning(fromType: string, toType: string): LinkMeaning | undefined {
  const a = linkEndOf(fromType);
  const b = linkEndOf(toType);
  return a && b ? MEANING_BY_PAIR[`${a}|${b}`] : undefined;
}

/** O nó pode começar uma conexão (é terminal, nota ou desenho). */
export const canStartLink = (node: CanvasNode | undefined): boolean => node !== undefined && linkEndOf(node.type) !== undefined;

const nodeById = (doc: CanvasDoc, id: string): CanvasNode | undefined => doc.nodes.find((node) => node.id === id);

const samePair = (edge: CanvasEdge, a: string, b: string): boolean => (edge.from === a && edge.to === b) || (edge.from === b && edge.to === a);

/** Por que `from` → `to` não conecta (o código do erro), ou `undefined` se conecta. A conexão não tem sentido: a↔b é uma só. */
export function linkRefusal(doc: CanvasDoc, from: string, to: string): LinkErrorCode | undefined {
  const a = nodeById(doc, from);
  const b = nodeById(doc, to);
  if (!a || !b) return LINK_ERRORS.danglingNode;
  if (from === to) return LINK_ERRORS.selfLoop;
  if (!linkMeaning(a.type, b.type)) return LINK_ERRORS.noReader;
  if (doc.edges.some((edge) => isLinkEdge(edge) && samePair(edge, from, to))) return LINK_ERRORS.duplicateLink;
  if (doc.edges.length >= CANVAS_LIMITS.edges) return LINK_ERRORS.limitExceeded;
  return undefined;
}

/** Mensagem de cada código (o texto ao dono sai daqui; quem consome ramifica pelo código). */
export const LINK_ERROR_TEXT: Readonly<Record<LinkErrorCode, string>> = {
  [LINK_ERRORS.invalidId]: "id inválido",
  [LINK_ERRORS.duplicateId]: "id já existe",
  [LINK_ERRORS.danglingNode]: "conexão para nó que não existe",
  [LINK_ERRORS.selfLoop]: "conexão de um nó para ele mesmo",
  [LINK_ERRORS.duplicateLink]: "os dois nós já estão conectados",
  [LINK_ERRORS.noReader]: "só terminal com nota ou desenho, nota com nota e desenho com desenho se conectam",
  [LINK_ERRORS.limitExceeded]: "documento passaria do limite de arestas",
  [LINK_ERRORS.missingLink]: "conexão não existe no documento",
  [LINK_ERRORS.notLink]: "a aresta não é uma conexão",
  [LINK_ERRORS.invalidStyle]: "estilo de conexão desconhecido",
  [LINK_ERRORS.invalidClamp]: "abraçadeira inválida",
  [LINK_ERRORS.missingClamp]: "abraçadeira não existe",
  [LINK_ERRORS.clampLimit]: "conexão com abraçadeiras demais",
};
const failCode = (code: LinkErrorCode): never => fail(code, LINK_ERROR_TEXT[code]);

export interface NewLink {
  id: string;
  from: string;
  to: string;
  style?: LinkStyle;
}

/** Cria a conexão `from` → `to`. O estilo padrão (corda) não é gravado: documento sem `style` abre como corda. */
export function opCreateLink(doc: CanvasDoc, link: NewLink): AtomicOp {
  if (!validId(link.id)) return failCode(LINK_ERRORS.invalidId);
  if (doc.edges.some((edge) => edge.id === link.id)) return failCode(LINK_ERRORS.duplicateId);
  if (link.style !== undefined && !isLinkStyle(link.style)) return failCode(LINK_ERRORS.invalidStyle);
  const refusal = linkRefusal(doc, link.from, link.to);
  if (refusal) return failCode(refusal);
  const edge: CanvasEdge = { id: link.id, from: link.from, to: link.to, kind: LINK_EDGE_KIND };
  if (link.style !== undefined && link.style !== DEFAULT_LINK_STYLE) edge.style = link.style;
  return opEdgeCreate(doc, edge);
}

function linkAt(doc: CanvasDoc, edgeId: string): { at: number; edge: CanvasEdge } {
  const at = doc.edges.findIndex((edge) => edge.id === edgeId);
  const edge = doc.edges[at];
  if (!edge) return failCode(LINK_ERRORS.missingLink);
  if (!isLinkEdge(edge)) return failCode(LINK_ERRORS.notLink);
  return { at, edge };
}

/** Remove a conexão (só `link`: as demais arestas têm dono próprio). */
export function opRemoveLink(doc: CanvasDoc, edgeId: string): AtomicOp {
  linkAt(doc, edgeId);
  return opEdgeDelete(doc, edgeId);
}

/** Apagar e recriar no mesmo índice: o par vale como troca no lugar, e o inverso devolve a aresta de antes. */
function replaceOps(doc: CanvasDoc, edgeId: string, next: (edge: CanvasEdge) => CanvasEdge): AtomicOp[] {
  const { at, edge } = linkAt(doc, edgeId);
  const item = next(structuredClone(edge));
  return [
    { kind: "edge-delete", edge: { at, item: structuredClone(edge) } },
    { kind: "edge-create", edge: { at, item } },
  ];
}

const asOp = (ops: readonly AtomicOp[]): CanvasOp | undefined => (ops.length === 0 ? undefined : opBatch(ops));

/** Troca o estilo de uma conexão; `undefined` se já está nele. Corda volta a não gravar `style`. */
export function opSetLinkStyle(doc: CanvasDoc, edgeId: string, style: LinkStyle): CanvasOp | undefined {
  if (!isLinkStyle(style)) return failCode(LINK_ERRORS.invalidStyle);
  const { edge } = linkAt(doc, edgeId);
  if (linkStyleOf(edge) === style) return undefined;
  return asOp(replaceOps(doc, edgeId, (current) => {
    const { style: _old, ...rest } = current;
    return style === DEFAULT_LINK_STYLE ? rest : { ...rest, style };
  }));
}

// ---- abraçadeiras (só visuais: prendem cordas num ponto, sem mudar quem está conectado a quem) ----

/** Folga das pontas: a abraçadeira não encosta no nó. */
export const CLAMP_T_MARGIN = 0.05;

export interface ClampHit {
  edgeId: string;
  t: number;
}

const validT = (t: unknown): t is number => typeof t === "number" && Number.isFinite(t) && t > 0 && t < 1;

/** Abraçadeiras do documento: id → conexões presas e o `t` de cada uma (na ordem das arestas). */
export function clampsOf(doc: CanvasDoc): Map<string, ClampHit[]> {
  const out = new Map<string, ClampHit[]>();
  for (const edge of doc.edges) {
    if (!isLinkEdge(edge) || !edge.clamps) continue;
    for (const clamp of edge.clamps) {
      const list = out.get(clamp.id);
      if (list) list.push({ edgeId: edge.id, t: clamp.t });
      else out.set(clamp.id, [{ edgeId: edge.id, t: clamp.t }]);
    }
  }
  return out;
}

const withClamps = (edge: CanvasEdge, clamps: readonly EdgeClamp[]): CanvasEdge => {
  const { clamps: _old, ...rest } = edge;
  return clamps.length === 0 ? rest : { ...rest, clamps: [...clamps] };
};

/** Prende as conexões cruzadas pelo traço numa abraçadeira nova. Cada conexão entra uma vez. */
export function opClampLinks(doc: CanvasDoc, clampId: string, hits: readonly ClampHit[]): CanvasOp {
  if (!validId(clampId)) return failCode(LINK_ERRORS.invalidId);
  if (clampsOf(doc).has(clampId)) return failCode(LINK_ERRORS.duplicateId);
  if (hits.length === 0) return failCode(LINK_ERRORS.invalidClamp);
  const seen = new Set<string>();
  const ops: AtomicOp[] = [];
  for (const hit of hits) {
    if (seen.has(hit.edgeId) || !validT(hit.t)) return failCode(LINK_ERRORS.invalidClamp);
    seen.add(hit.edgeId);
    ops.push(...replaceOps(doc, hit.edgeId, (edge) => {
      const clamps = edge.clamps ?? [];
      if (clamps.length >= CANVAS_LIMITS.edgeClamps) return failCode(LINK_ERRORS.clampLimit);
      return withClamps(edge, [...clamps, { id: clampId, t: hit.t }]);
    }));
  }
  return opBatch(ops);
}

/** Arrasta a abraçadeira: o novo `t` de cada conexão presa (conexão fora do mapa fica onde está). `undefined` se nada mudou. */
export function opMoveClamp(doc: CanvasDoc, clampId: string, ts: ReadonlyMap<string, number>): CanvasOp | undefined {
  const members = clampsOf(doc).get(clampId) ?? failCode(LINK_ERRORS.missingClamp);
  const ops: AtomicOp[] = [];
  for (const member of members) {
    const t = ts.get(member.edgeId);
    if (t === undefined || t === member.t) continue;
    if (!validT(t)) return failCode(LINK_ERRORS.invalidClamp);
    ops.push(...replaceOps(doc, member.edgeId, (edge) => withClamps(edge, (edge.clamps ?? []).map((clamp) => (clamp.id === clampId ? { id: clampId, t } : clamp)))));
  }
  return asOp(ops);
}

/** Solta a abraçadeira de todas as conexões. */
export function opReleaseClamp(doc: CanvasDoc, clampId: string): CanvasOp {
  const members = clampsOf(doc).get(clampId) ?? failCode(LINK_ERRORS.missingClamp);
  const ops = members.flatMap((member) => replaceOps(doc, member.edgeId, (edge) => withClamps(edge, (edge.clamps ?? []).filter((clamp) => clamp.id !== clampId))));
  return opBatch(ops);
}

/** Id livre com o prefixo: `<prefixo>-<semente>`, e `-2`, `-3`… se já existir (entre arestas e abraçadeiras). */
export function freshLinkId(doc: CanvasDoc, prefix: string, seed: string): string {
  const used = new Set<string>(doc.edges.map((edge) => edge.id));
  for (const clampId of clampsOf(doc).keys()) used.add(clampId);
  const base = `${prefix}-${seed}`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ---- popover de conexões ----

export const LINK_END_TEXT: Readonly<Record<LinkEnd, string>> = { terminal: "Terminal", note: "Nota", drawing: "Desenho" };
export const LINK_MEANING_TEXT: Readonly<Record<LinkMeaning, string>> = {
  "note-access": "o agente lê e escreve a nota",
  chain: "nota encadeada: a leitura segue a cadeia",
  "drawing-access": "o agente lê e edita o desenho",
  "drawing-chain": "desenho encadeado: a leitura segue a cadeia",
};
export const LINK_STYLE_TEXT: Readonly<Record<LinkStyle, string>> = { rope: "Corda", circuit: "Circuito" };

export interface LinkRow {
  edgeId: string;
  /** O nó do outro lado. */
  other: string;
  otherType: string;
  style: LinkStyle;
  meaning: LinkMeaning | undefined;
  clamps: readonly string[];
}

/** Conexões do nó, na ordem do documento. */
export function linksOf(doc: CanvasDoc, nodeId: string): LinkRow[] {
  const types = new Map(doc.nodes.map((node) => [node.id, node.type]));
  const own = types.get(nodeId);
  if (own === undefined) return [];
  return doc.edges.flatMap((edge): LinkRow[] => {
    if (!isLinkEdge(edge) || (edge.from !== nodeId && edge.to !== nodeId)) return [];
    const other = edge.from === nodeId ? edge.to : edge.from;
    const otherType = types.get(other);
    if (otherType === undefined) return [];
    return [{ edgeId: edge.id, other, otherType, style: linkStyleOf(edge), meaning: linkMeaning(own, otherType), clamps: (edge.clamps ?? []).map((clamp) => clamp.id) }];
  });
}

export const linkCount = (doc: CanvasDoc, nodeId: string): number =>
  doc.edges.reduce((n, edge) => n + (isLinkEdge(edge) && (edge.from === nodeId || edge.to === nodeId) ? 1 : 0), 0);

// ---- geometria ----

const center = (box: Rect): Vec => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
const dist = (a: Vec, b: Vec): number => Math.hypot(b.x - a.x, b.y - a.y);
const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Ponto da borda do retângulo na reta do centro até `toward` (o centro, se `toward` é o próprio centro). */
export function borderPoint(box: Rect, toward: Vec): Vec {
  const c = center(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const scale = Math.min(dx === 0 ? Infinity : box.w / 2 / Math.abs(dx), dy === 0 ? Infinity : box.h / 2 / Math.abs(dy));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** Pontas da corda: a borda de cada nó virada para o centro do outro. */
export function linkAnchors(a: Rect, b: Rect): [Vec, Vec] {
  return [borderPoint(a, center(b)), borderPoint(b, center(a))];
}

/** Fração da reta a→b mais perto de `p`, com a folga das pontas. */
export function projectT(a: Vec, b: Vec, p: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0.5 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  return Math.min(1 - CLAMP_T_MARGIN, Math.max(CLAMP_T_MARGIN, t));
}

/** Onde a abraçadeira fica: a média do ponto `t` na reta de cada conexão presa. */
export function clampPoint(members: readonly { a: Vec; b: Vec; t: number }[]): Vec | undefined {
  if (members.length === 0) return undefined;
  let x = 0;
  let y = 0;
  for (const { a, b, t } of members) {
    const p = lerp(a, b, t);
    x += p.x;
    y += p.y;
  }
  return { x: x / members.length, y: y / members.length };
}

/** Primeiro ponto em que o segmento p→q cruza a linha poligonal, ou `undefined`. */
export function strokeCrossing(p: Vec, q: Vec, line: readonly Vec[]): Vec | undefined {
  const rx = q.x - p.x;
  const ry = q.y - p.y;
  let best: { u: number; at: Vec } | undefined;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i] as Vec;
    const b = line[i + 1] as Vec;
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const denom = rx * sy - ry * sx;
    if (denom === 0) continue;
    const u = ((a.x - p.x) * sy - (a.y - p.y) * sx) / denom;
    const v = ((a.x - p.x) * ry - (a.y - p.y) * rx) / denom;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    if (!best || u < best.u) best = { u, at: { x: p.x + rx * u, y: p.y + ry * u } };
  }
  return best?.at;
}

/** Raio das curvas do circuito, em unidades de mundo (o desenho reduz em trecho curto). */
export const CIRCUIT_RADIUS = 14;

/**
 * Rota do circuito: trilhos nos eixos, de borda a borda, com no máximo duas curvas de 90°. Nós lado a lado saem pelas
 * laterais (horizontal, vertical no meio, horizontal); um sobre o outro, por cima e por baixo; sobrepostos nos dois
 * eixos, um L (uma curva). Pontas na mesma linha: reta.
 */
export function circuitRoute(a: Rect, b: Rect): Vec[] {
  const ca = center(a);
  const cb = center(b);
  const apartX = a.x + a.w < b.x || b.x + b.w < a.x;
  const apartY = a.y + a.h < b.y || b.y + b.h < a.y;
  if (apartX && (!apartY || Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y))) {
    const right = cb.x > ca.x;
    const start = { x: right ? a.x + a.w : a.x, y: ca.y };
    const end = { x: right ? b.x : b.x + b.w, y: cb.y };
    if (start.y === end.y) return [start, end];
    const mid = (start.x + end.x) / 2;
    return [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end];
  }
  if (apartY) {
    const down = cb.y > ca.y;
    const start = { x: ca.x, y: down ? a.y + a.h : a.y };
    const end = { x: cb.x, y: down ? b.y : b.y + b.h };
    if (start.x === end.x) return [start, end];
    const mid = (start.y + end.y) / 2;
    return [start, { x: start.x, y: mid }, { x: end.x, y: mid }, end];
  }
  return [ca, { x: cb.x, y: ca.y }, cb];
}

// ---- física leve da corda (Verlet com restrição de distância) ----

export const ROPE = {
  /** Trechos da corda (pontos = trechos + 1). */
  segments: 16,
  /** Comprimento da corda / distância entre as pontas: a barriga. */
  slack: 1.08,
  /** Unidades de mundo por s². */
  gravity: 1400,
  /** Fração da velocidade que sobra a cada passo. */
  damping: 0.9,
  iterations: 10,
  /** Deslocamento médio por passo (mundo, na janela `sleepWindow`) abaixo do qual a corda está parada e não pede quadro. */
  sleep: 0.05,
  /** Passos seguidos que a média de deslocamento olha: um passo só dorme no ponto morto de um balanço. */
  sleepWindow: 30,
  /** Passo fixo da simulação: Verlet com passo variável injeta energia e a corda nunca assenta. */
  step: 1 / 60,
  /** Tempo do quadro acumulado no máximo: aba em segundo plano não devolve um salto. */
  maxDt: 1 / 30,
  /** Fração da velocidade que sobra por passo quando a corda está quase parada (amortece a cauda do balanço). */
  restDamping: 0.8,
} as const;

export interface Rope {
  points: Vec[];
  prev: Vec[];
  /** Tempo de quadro ainda não consumido em passos fixos. */
  acc: number;
  /** Deslocamento máximo dos últimos passos (janela `ROPE.sleepWindow`), do mais antigo ao mais novo. */
  moves: number[];
}

/** Ponto preso da corda (abraçadeira): o índice do ponto e onde ele fica. */
export interface RopePin {
  index: number;
  at: Vec;
}

/** Índice do ponto da corda que a abraçadeira em `t` prende (nunca uma ponta). */
export const pinIndex = (t: number, segments: number = ROPE.segments): number => Math.min(segments - 1, Math.max(1, Math.round(t * segments)));

/** Pontos fixos da corda em ordem: as duas pontas e as abraçadeiras (índice repetido vale o primeiro). */
function fixedPoints(a: Vec, b: Vec, pins: readonly RopePin[], segments: number): RopePin[] {
  const inner = [...pins].filter((pin) => pin.index > 0 && pin.index < segments).sort((x, y) => x.index - y.index);
  const out: RopePin[] = [{ index: 0, at: a }];
  for (const pin of inner) if (pin.index !== (out[out.length - 1] as RopePin).index) out.push(pin);
  out.push({ index: segments, at: b });
  return out;
}

/** Barriga de parábola com o comprimento `slack × distância` (aproximação do arco: L ≈ d + 8s²/3d). */
const sagOf = (d: number, slack: number): number => d * Math.sqrt((3 * (slack - 1)) / 8);

/** Forma parada da corda, sem simular: cada vão entre pontos fixos é uma parábola caída. */
export function ropeRest(a: Vec, b: Vec, pins: readonly RopePin[] = [], segments: number = ROPE.segments, slack: number = ROPE.slack): Vec[] {
  const fixed = fixedPoints(a, b, pins, segments);
  const points: Vec[] = [];
  for (let k = 0; k + 1 < fixed.length; k++) {
    const p = fixed[k] as RopePin;
    const q = fixed[k + 1] as RopePin;
    const sag = sagOf(dist(p.at, q.at), slack);
    const span = q.index - p.index;
    for (let i = k === 0 ? 0 : 1; i <= span; i++) {
      const u = i / span;
      const base = lerp(p.at, q.at, u);
      points.push({ x: base.x, y: base.y + 4 * sag * u * (1 - u) });
    }
  }
  return points;
}

export function createRope(a: Vec, b: Vec, pins: readonly RopePin[] = []): Rope {
  const points = ropeRest(a, b, pins);
  return { points, prev: points.map((p) => ({ ...p })), acc: 0, moves: [] };
}

/** Volta a corda à forma parada (movimento reduzido, ou corda que volta à tela depois de ficar parada fora dela). */
export function restRopeInPlace(rope: Rope, a: Vec, b: Vec, pins: readonly RopePin[] = []): void {
  const rest = ropeRest(a, b, pins, rope.points.length - 1);
  rope.points = rest;
  rope.prev = rest.map((p) => ({ ...p }));
  rope.acc = 0;
  rope.moves = [];
}

/**
 * Um passo da simulação, mutando a corda no lugar (o motor guarda uma por conexão e a reusa a cada quadro). Pontas e
 * abraçadeiras ficam presas; cada vão entre pontos fixos tem o comprimento da sua reta × folga. Devolve o maior
 * deslocamento de um ponto no passo: abaixo de `ROPE.sleep`, a corda está parada.
 */
export function stepRopeInPlace(rope: Rope, a: Vec, b: Vec, pins: readonly RopePin[], dt: number, nearRest = false): number {
  const { points, prev } = rope;
  const segments = points.length - 1;
  const step = Math.min(Math.max(dt, 0), ROPE.maxDt);
  const fixed = fixedPoints(a, b, pins, segments);
  const pinnedAt = new Map(fixed.map((pin) => [pin.index, pin.at]));
  const before = points.map((p) => ({ ...p }));
  const rest: number[] = [];
  for (let k = 0; k + 1 < fixed.length; k++) {
    const p = fixed[k] as RopePin;
    const q = fixed[k + 1] as RopePin;
    const each = (dist(p.at, q.at) * ROPE.slack) / (q.index - p.index);
    for (let i = p.index; i < q.index; i++) rest[i] = each;
  }
  const g = ROPE.gravity * step * step;
  const damping = nearRest ? ROPE.restDamping : ROPE.damping;
  for (let i = 0; i <= segments; i++) {
    const p = points[i] as Vec;
    const o = prev[i] as Vec;
    const pinned = pinnedAt.get(i);
    if (pinned) {
      o.x = p.x;
      o.y = p.y;
      p.x = pinned.x;
      p.y = pinned.y;
      continue;
    }
    const vx = (p.x - o.x) * damping;
    const vy = (p.y - o.y) * damping;
    o.x = p.x;
    o.y = p.y;
    p.x += vx;
    p.y += vy + g;
  }
  for (let it = 0; it < ROPE.iterations; it++) {
    for (let i = 0; i < segments; i++) {
      const p = points[i] as Vec;
      const q = points[i + 1] as Vec;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.hypot(dx, dy) || 1e-9;
      // só tração: corda não empurra, então trecho folgado (d <= rest) não é corrigido
      if (d <= (rest[i] as number)) continue;
      const diff = (d - (rest[i] as number)) / d;
      const fixedP = pinnedAt.has(i);
      const fixedQ = pinnedAt.has(i + 1);
      if (fixedP && fixedQ) continue;
      const share = fixedP || fixedQ ? 1 : 0.5;
      if (!fixedP) {
        p.x += dx * diff * share;
        p.y += dy * diff * share;
      }
      if (!fixedQ) {
        q.x -= dx * diff * share;
        q.y -= dy * diff * share;
      }
    }
  }
  let moved = 0;
  for (let i = 0; i <= segments; i++) {
    const p = points[i] as Vec;
    const o = before[i] as Vec;
    moved = Math.max(moved, Math.abs(p.x - o.x), Math.abs(p.y - o.y));
  }
  return moved;
}

/** Deslocamento médio da janela de sono, ou `Infinity` enquanto ela não encheu (corda recém-criada não dorme). */
export function ropeEnergy(rope: Rope): number {
  if (rope.moves.length < ROPE.sleepWindow) return Number.POSITIVE_INFINITY;
  return rope.moves.reduce((sum, m) => sum + m, 0) / rope.moves.length;
}

/**
 * Avança a corda pelo tempo do quadro em passos fixos de `ROPE.step` (o resto fica no acumulador) e devolve a energia
 * (`ropeEnergy`): abaixo de `ROPE.sleep` a corda está parada. Quadro mais curto que um passo não anda nem muda a energia.
 */
export function advanceRope(rope: Rope, a: Vec, b: Vec, pins: readonly RopePin[], dt: number): { energy: number; steps: number } {
  rope.acc += Math.min(Math.max(dt, 0), ROPE.maxDt);
  let steps = 0;
  while (rope.acc >= ROPE.step) {
    rope.acc -= ROPE.step;
    const nearRest = ropeEnergy(rope) < ROPE.sleep * 20;
    rope.moves.push(stepRopeInPlace(rope, a, b, pins, ROPE.step, nearRest));
    if (rope.moves.length > ROPE.sleepWindow) rope.moves.shift();
    steps++;
  }
  return { energy: ropeEnergy(rope), steps };
}

/** Retângulo que a corda pode ocupar (as pontas, as abraçadeiras e a barriga): o recorte do que entra no quadro. */
export function ropeReach(a: Vec, b: Vec, pins: readonly RopePin[] = []): Rect {
  const xs = [a.x, b.x, ...pins.map((pin) => pin.at.x)];
  const ys = [a.y, b.y, ...pins.map((pin) => pin.at.y)];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  // a barriga cai abaixo da reta, e o balanço sai um pouco para os lados
  const sag = sagOf(Math.hypot(w, h), ROPE.slack) * 1.5;
  return { x: x - sag / 3, y: y - sag / 3, w: w + (2 * sag) / 3, h: h + sag * 1.4 };
}
