// Desenho como entidade do canvas (reference/argos.md §Desenho): o nó `drawing` é um contêiner (retângulo com título) cujo
// `data` guarda a cena versionada `{ v, elements, title? }`, com coordenadas relativas ao canto do nó. Elementos: traço
// livre, retângulo, elipse, linha, seta (as duas, conectáveis a elementos) e texto livre. Lógica pura, sem Node/DOM: o mesmo
// módulo roda no servidor (rota de edição), na CLI e no navegador. Toda mudança do nó sai como `AtomicOp` do desfazer.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNode, LINK_EDGE_KIND, validateCanvasDoc } from "./canvas-doc.ts";
import { type AtomicOp, opCreate, opUpdate } from "./canvas-history.ts";
import { NOTE_READER_TYPES, type NoteWriter } from "./canvas-note.ts";

export const DRAWING_TYPE = "drawing";
/** Versão do formato da cena. Versão desconhecida é recusada (`drawing_unsupported_version`), nunca lida pela metade. */
export const DRAWING_VERSION = 1;

export const DRAWING_LIMITS = {
  /** Elementos por desenho. */
  elements: 300,
  /** Pontos de um traço. */
  strokePoints: 500,
  /** Pontos de todos os traços juntos (mantém o documento, de 1 MiB, longe do teto). */
  totalPoints: 6000,
  /** Texto livre, em caracteres. */
  textChars: 1000,
  titleChars: 80,
  idChars: 40,
  /** Coordenada relativa ao nó (cabe folgada na caixa de qualquer nó do documento). */
  coordinate: 1_000_000,
  widthMax: 64,
  sizeMin: 8,
  sizeMax: 200,
  /** Largura e altura iniciais do nó. */
  frameW: 480,
  frameH: 320,
} as const;

export const DRAWING_DEFAULTS = { width: 2, textSize: 16, stroke: "#1f2328" } as const;

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const DRAWING_ERRORS = {
  invalidData: "drawing_invalid_data",
  unsupportedVersion: "drawing_unsupported_version",
  limitExceeded: "drawing_limit_exceeded",
  invalidElement: "drawing_invalid_element",
  invalidId: "drawing_invalid_id",
  duplicateId: "drawing_duplicate_id",
  missingElement: "drawing_missing_element",
  invalidConnector: "drawing_invalid_connector",
  invalidNode: "drawing_invalid_node",
  invalidTitle: "drawing_invalid_title",
  titleExists: "drawing_title_exists",
} as const;
export type DrawingErrorCode = (typeof DRAWING_ERRORS)[keyof typeof DRAWING_ERRORS];

export class DrawingError extends Error {
  readonly code: DrawingErrorCode;
  constructor(code: DrawingErrorCode, message: string) {
    super(message);
    this.name = "DrawingError";
    this.code = code;
  }
}

const fail = (code: DrawingErrorCode, message: string): never => {
  throw new DrawingError(code, message);
};

// ---- tipos da cena ----

export const SHAPE_KINDS = ["rect", "ellipse"] as const;
export const CONNECTOR_KINDS = ["line", "arrow"] as const;
export const ELEMENT_KINDS = ["stroke", ...SHAPE_KINDS, ...CONNECTOR_KINDS, "text"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

export interface DrawingPoint {
  x: number;
  y: number;
}

/** Ponta de conector: ponto livre ou o id do elemento a que ela está presa (mover o elemento leva a ponta). */
export type ConnectorEnd = DrawingPoint | { ref: string };

interface Look {
  /** Cor `#rgb`, `#rrggbb` ou `#rrggbbaa`; ausente, o tom padrão do desenho. */
  stroke?: string;
  /** Preenchimento (só retângulo e elipse), mesmo formato. */
  fill?: string;
  /** Espessura em unidades do desenho, de 0.5 a 64. */
  width?: number;
}

/** `pressure` (opcional, aditivo): uma pressão de 0 a 1 por ponto, na mesma ordem; ausente, a espessura é a do `width`. */
export type StrokeElement = { id: string; type: "stroke"; points: [number, number][]; pressure?: number[] } & Pick<Look, "stroke" | "width">;
/** `rotation` (opcional, aditivo): graus no sentido horário, em [0, 360), em torno do centro do elemento; ausente, 0. */
export type ShapeElement = { id: string; type: "rect" | "ellipse"; x: number; y: number; w: number; h: number; rotation?: number } & Look;
export type ConnectorElement = { id: string; type: "line" | "arrow"; from: ConnectorEnd; to: ConnectorEnd } & Pick<Look, "stroke" | "width">;
export type TextElement = { id: string; type: "text"; x: number; y: number; text: string; size?: number; stroke?: string; rotation?: number };
export type DrawingElement = StrokeElement | ShapeElement | ConnectorElement | TextElement;

export interface DrawingScene {
  v: typeof DRAWING_VERSION;
  elements: DrawingElement[];
  /** Título do contêiner (o cabeçalho do nó). */
  title?: string;
}

// ---- leitura e validação (fronteira: tudo que vem de fora passa por aqui) ----

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

function onlyKeys(value: Dict, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(DRAWING_ERRORS.invalidElement, `${what}: campo desconhecido "${key.slice(0, 40)}"`);
}

const ELEMENT_ID = /^[A-Za-z0-9][\w-]*$/;
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const WIDTH_MIN = 0.5;
const FULL_TURN = 360;

export const isElementId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= DRAWING_LIMITS.idChars && ELEMENT_ID.test(value);

function coord(value: unknown, what: string): number {
  const limit = DRAWING_LIMITS.coordinate;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) return fail(DRAWING_ERRORS.invalidElement, `${what}: coordenada inválida`);
  return value;
}

function extent(value: unknown, what: string): number {
  const n = coord(value, what);
  return n > 0 ? n : fail(DRAWING_ERRORS.invalidElement, `${what}: precisa ser maior que zero`);
}

function colorOf(value: unknown, what: string): string {
  return typeof value === "string" && COLOR.test(value) ? value : fail(DRAWING_ERRORS.invalidElement, `${what}: cor inválida`);
}

function widthOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < WIDTH_MIN || value > DRAWING_LIMITS.widthMax) return fail(DRAWING_ERRORS.invalidElement, "espessura fora do intervalo");
  return value;
}

function textOf(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return fail(DRAWING_ERRORS.invalidElement, "texto não pode ser vazio");
  if ([...value].length > DRAWING_LIMITS.textChars) return fail(DRAWING_ERRORS.limitExceeded, "texto acima do limite de caracteres");
  if (CONTROL_CHARS.test(value)) return fail(DRAWING_ERRORS.invalidElement, "texto com caractere de controle");
  return value;
}

function sizeOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < DRAWING_LIMITS.sizeMin || value > DRAWING_LIMITS.sizeMax) return fail(DRAWING_ERRORS.invalidElement, "tamanho do texto fora do intervalo");
  return value;
}

function pressureOf(value: unknown, count: number): number[] {
  if (!Array.isArray(value) || value.length !== count) return fail(DRAWING_ERRORS.invalidElement, "pressão precisa ter um valor por ponto");
  return value.map((p): number => (typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1 ? p : fail(DRAWING_ERRORS.invalidElement, "pressão fora de 0 a 1")));
}

function rotationOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= FULL_TURN) return fail(DRAWING_ERRORS.invalidElement, "ângulo fora de 0 a 360");
  return value;
}

function endOf(value: unknown, what: string): ConnectorEnd {
  if (!isDict(value)) return fail(DRAWING_ERRORS.invalidConnector, `${what}: ponta precisa ser objeto`);
  if (value.ref !== undefined) {
    onlyKeys(value, ["ref"], what);
    return isElementId(value.ref) ? { ref: value.ref } : fail(DRAWING_ERRORS.invalidConnector, `${what}: ref inválida`);
  }
  onlyKeys(value, ["x", "y"], what);
  return { x: coord(value.x, what), y: coord(value.y, what) };
}

const LOOK_KEYS = ["stroke", "fill", "width"] as const;

function lookOf(raw: Dict, keys: readonly (keyof Look)[]): Look {
  const out: Look = {};
  if (keys.includes("stroke") && raw.stroke !== undefined) out.stroke = colorOf(raw.stroke, "stroke");
  if (keys.includes("fill") && raw.fill !== undefined) out.fill = colorOf(raw.fill, "fill");
  if (keys.includes("width") && raw.width !== undefined) out.width = widthOf(raw.width);
  return out;
}

function readElement(raw: unknown): DrawingElement {
  if (!isDict(raw)) return fail(DRAWING_ERRORS.invalidElement, "elemento precisa ser objeto");
  if (!isElementId(raw.id)) return fail(DRAWING_ERRORS.invalidId, "id de elemento inválido");
  const id = raw.id;
  const type = ELEMENT_KINDS.find((kind) => kind === raw.type);
  if (type === undefined) return fail(DRAWING_ERRORS.invalidElement, "tipo de elemento desconhecido");
  switch (type) {
    case "stroke": {
      onlyKeys(raw, ["id", "type", "points", "pressure", "stroke", "width"], type);
      if (!Array.isArray(raw.points) || raw.points.length === 0) return fail(DRAWING_ERRORS.invalidElement, "traço sem pontos");
      if (raw.points.length > DRAWING_LIMITS.strokePoints) return fail(DRAWING_ERRORS.limitExceeded, "traço com pontos demais");
      const points = raw.points.map((p): [number, number] => {
        if (!Array.isArray(p) || p.length !== 2) return fail(DRAWING_ERRORS.invalidElement, "ponto do traço precisa ser [x, y]");
        return [coord(p[0], "ponto"), coord(p[1], "ponto")];
      });
      const pressure = raw.pressure === undefined ? undefined : pressureOf(raw.pressure, points.length);
      return { id, type, points, ...(pressure !== undefined && { pressure }), ...lookOf(raw, ["stroke", "width"]) };
    }
    case "rect":
    case "ellipse": {
      onlyKeys(raw, ["id", "type", "x", "y", "w", "h", "rotation", ...LOOK_KEYS], type);
      return { id, type, x: coord(raw.x, "x"), y: coord(raw.y, "y"), w: extent(raw.w, "w"), h: extent(raw.h, "h"), ...(raw.rotation !== undefined && { rotation: rotationOf(raw.rotation) }), ...lookOf(raw, LOOK_KEYS) };
    }
    case "line":
    case "arrow": {
      onlyKeys(raw, ["id", "type", "from", "to", "stroke", "width"], type);
      return { id, type, from: endOf(raw.from, "from"), to: endOf(raw.to, "to"), ...lookOf(raw, ["stroke", "width"]) };
    }
    case "text": {
      onlyKeys(raw, ["id", "type", "x", "y", "text", "size", "stroke", "rotation"], type);
      const out: TextElement = { id, type, x: coord(raw.x, "x"), y: coord(raw.y, "y"), text: textOf(raw.text) };
      if (raw.size !== undefined) out.size = sizeOf(raw.size);
      if (raw.stroke !== undefined) out.stroke = colorOf(raw.stroke, "stroke");
      if (raw.rotation !== undefined) out.rotation = rotationOf(raw.rotation);
      return out;
    }
  }
}

export const isConnector = (el: DrawingElement): el is ConnectorElement => el.type === "line" || el.type === "arrow";

const isRef = (end: ConnectorEnd): end is { ref: string } => "ref" in end;

/** Ids únicos, conectores presos só a elementos que existem e que não são conectores (a ponta seguiria a si mesma). */
function checkRelations(elements: readonly DrawingElement[]): void {
  const byId = new Map<string, DrawingElement>();
  let points = 0;
  for (const el of elements) {
    if (byId.has(el.id)) fail(DRAWING_ERRORS.duplicateId, "id de elemento repetido");
    byId.set(el.id, el);
    if (el.type === "stroke") points += el.points.length;
  }
  if (points > DRAWING_LIMITS.totalPoints) fail(DRAWING_ERRORS.limitExceeded, "pontos de traço demais no desenho");
  for (const el of elements) {
    if (!isConnector(el)) continue;
    for (const end of [el.from, el.to]) {
      if (!isRef(end)) continue;
      const target = byId.get(end.ref);
      if (!target) fail(DRAWING_ERRORS.invalidConnector, "conector preso a elemento que não existe");
      else if (isConnector(target)) fail(DRAWING_ERRORS.invalidConnector, "conector não prende em outro conector");
    }
  }
}

function titleOf(value: unknown): string {
  if (typeof value !== "string") return fail(DRAWING_ERRORS.invalidTitle, "título precisa ser texto");
  const title = value.trim();
  if ([...title].length > DRAWING_LIMITS.titleChars || CONTROL_CHARS.test(title)) return fail(DRAWING_ERRORS.invalidTitle, "título inválido");
  return title;
}

/** Título fixado pelo dono: aparado, até `titleChars`, sem controle. Vazio = `undefined` (sem título). */
export function readDrawingTitle(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const title = titleOf(value);
  return title === "" ? undefined : title;
}

export function emptyScene(title?: string): DrawingScene {
  return { v: DRAWING_VERSION, elements: [], ...(title !== undefined && { title }) };
}

/** `data` de um nó `drawing` vindo de fora: cena `{ v, elements, title? }` completa. Devolve uma cópia nova. */
export function readDrawingData(raw: unknown): DrawingScene {
  if (!isDict(raw)) return fail(DRAWING_ERRORS.invalidData, "desenho: data precisa ser objeto");
  if (raw.v !== DRAWING_VERSION) return fail(DRAWING_ERRORS.unsupportedVersion, "desenho: versão do formato desconhecida");
  for (const key of Object.keys(raw)) if (!["v", "elements", "title"].includes(key)) fail(DRAWING_ERRORS.invalidData, `desenho: campo desconhecido "${key.slice(0, 40)}"`);
  if (!Array.isArray(raw.elements)) return fail(DRAWING_ERRORS.invalidData, "desenho: elements precisa ser lista");
  if (raw.elements.length > DRAWING_LIMITS.elements) return fail(DRAWING_ERRORS.limitExceeded, "desenho: elementos demais");
  const elements = raw.elements.map(readElement);
  checkRelations(elements);
  const title = readDrawingTitle(raw.title);
  return { v: DRAWING_VERSION, elements, ...(title !== undefined && { title }) };
}

/** O que vai para o `data` do nó (o mesmo formato que `readDrawingData` lê). */
export const sceneData = (scene: DrawingScene): Record<string, unknown> => structuredClone({ ...scene });

export const isDrawingNode = (node: CanvasNode): boolean => node.type === DRAWING_TYPE;

/** A cena do nó `drawing`; `undefined` se o nó não é desenho. Lança `DrawingError` se o `data` é inválido. */
export function sceneOfNode(node: CanvasNode): DrawingScene | undefined {
  return node.type === DRAWING_TYPE ? readDrawingData(node.data) : undefined;
}

/** Como `sceneOfNode`, mas dado corrompido responde `undefined` (quem só decide acesso não lança). */
export function sceneOfNodeSafe(node: CanvasNode | undefined): DrawingScene | undefined {
  if (!node || node.type !== DRAWING_TYPE) return undefined;
  try {
    return readDrawingData(node.data);
  } catch (error) {
    if (error instanceof DrawingError) return undefined;
    throw error;
  }
}

// ---- geometria ----

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TEXT_LINE_HEIGHT = 1.25;
const TEXT_CHAR_WIDTH = 0.6;

/** Caixa estimada do texto (a fonte real não se mede aqui): maior linha × número de linhas. */
function textBox(el: TextElement): Box {
  const size = el.size ?? DRAWING_DEFAULTS.textSize;
  const lines = el.text.split("\n");
  const longest = lines.reduce((max, line) => Math.max(max, [...line].length), 0);
  return { x: el.x, y: el.y, w: Math.max(1, longest * size * TEXT_CHAR_WIDTH), h: Math.max(1, lines.length * size * TEXT_LINE_HEIGHT) };
}

function pointsBox(points: readonly DrawingPoint[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y } of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

const centerOf = (box: Box): DrawingPoint => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

const RAD = Math.PI / 180;

/** Ângulo do elemento em graus (0 quando não gira). Traço e conector não têm: giram os pontos. */
export const rotationDegrees = (el: DrawingElement): number => (el.type === "rect" || el.type === "ellipse" || el.type === "text" ? (el.rotation ?? 0) : 0);

/** `p` girado `deg` graus (horário, eixo y para baixo) em torno de `pivot`. */
export function rotatePoint(p: DrawingPoint, pivot: DrawingPoint, deg: number): DrawingPoint {
  const cos = Math.cos(deg * RAD);
  const sin = Math.sin(deg * RAD);
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

/** Ângulo normalizado para [0, 360), com duas casas. */
export function normalizeAngle(deg: number): number {
  const turned = ((deg % FULL_TURN) + FULL_TURN) % FULL_TURN;
  const rounded = round2(turned);
  return rounded >= FULL_TURN ? 0 : rounded;
}

/** Caixa do elemento sem o giro (a que o formato guarda); o centro é o mesmo da caixa girada. */
function localBox(scene: DrawingScene, el: DrawingElement): Box {
  switch (el.type) {
    case "stroke": return pointsBox(el.points.map(([x, y]) => ({ x, y })));
    case "rect":
    case "ellipse": return { x: el.x, y: el.y, w: el.w, h: el.h };
    case "text": return textBox(el);
    case "line":
    case "arrow": return pointsBox(connectorEnds(scene, el));
  }
}

/** Caixa que envolve o elemento girado (elipse: extensão exata; texto e retângulo: os quatro cantos). */
function turnedBox(el: DrawingElement, box: Box): Box {
  const deg = rotationDegrees(el);
  if (deg === 0) return box;
  const c = centerOf(box);
  if (el.type === "ellipse") {
    const cos = Math.cos(deg * RAD);
    const sin = Math.sin(deg * RAD);
    const hw = Math.sqrt((box.w / 2 * cos) ** 2 + (box.h / 2 * sin) ** 2);
    const hh = Math.sqrt((box.w / 2 * sin) ** 2 + (box.h / 2 * cos) ** 2);
    return { x: c.x - hw, y: c.y - hh, w: Math.max(1, 2 * hw), h: Math.max(1, 2 * hh) };
  }
  const corners = [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }].map((p) => rotatePoint(p, c, deg));
  return pointsBox(corners);
}

/** Ponto da borda do alvo (retângulo ou elipse, girado ou não) na reta do centro até `toward`. */
function edgePoint(el: DrawingElement, box: Box, toward: DrawingPoint): DrawingPoint {
  const c = centerOf(box);
  const deg = rotationDegrees(el);
  const local = deg === 0 ? toward : rotatePoint(toward, c, -deg);
  const dx = local.x - c.x;
  const dy = local.y - c.y;
  if (dx === 0 && dy === 0) return c;
  let edge: DrawingPoint;
  if (el.type === "ellipse") {
    const scale = 1 / Math.sqrt((dx / (box.w / 2)) ** 2 + (dy / (box.h / 2)) ** 2);
    edge = { x: c.x + dx * scale, y: c.y + dy * scale };
  } else {
    const scale = Math.min(dx === 0 ? Infinity : box.w / 2 / Math.abs(dx), dy === 0 ? Infinity : box.h / 2 / Math.abs(dy));
    edge = { x: c.x + dx * scale, y: c.y + dy * scale };
  }
  return deg === 0 ? edge : rotatePoint(edge, c, deg);
}

const elementById = (scene: DrawingScene, id: string): DrawingElement | undefined => scene.elements.find((el) => el.id === id);

/**
 * Caixa do elemento em coordenadas do desenho (a que envolve o elemento girado). Conector: a dos dois extremos já resolvidos.
 * Cena que passou por `readDrawingData` nunca tem referência solta; defensivamente, ponta sem alvo cai na origem.
 */
export function elementBox(scene: DrawingScene, el: DrawingElement): Box {
  return turnedBox(el, localBox(scene, el));
}

/** As duas pontas do conector em coordenadas do desenho: ponto livre como está; ponta presa na borda do elemento (que pode estar girado), virada para a outra ponta. */
export function connectorEnds(scene: DrawingScene, el: ConnectorElement): [DrawingPoint, DrawingPoint] {
  const target = (end: ConnectorEnd): { el: DrawingElement; box: Box } | undefined => {
    if (!isRef(end)) return undefined;
    const found = elementById(scene, end.ref);
    return found && !isConnector(found) ? { el: found, box: localBox(scene, found) } : undefined;
  };
  const a = target(el.from);
  const b = target(el.to);
  const free = (end: ConnectorEnd): DrawingPoint => (isRef(end) ? { x: 0, y: 0 } : { x: end.x, y: end.y });
  const aim = (own: { el: DrawingElement; box: Box } | undefined, other: { el: DrawingElement; box: Box } | undefined, otherEnd: ConnectorEnd, ownEnd: ConnectorEnd): DrawingPoint => {
    if (!own) return free(ownEnd);
    return edgePoint(own.el, own.box, other ? centerOf(other.box) : free(otherEnd));
  };
  return [aim(a, b, el.to, el.from), aim(b, a, el.from, el.to)];
}

/** Caixa que envolve todos os elementos; `undefined` se o desenho está vazio. */
export function sceneBounds(scene: DrawingScene): Box | undefined {
  if (scene.elements.length === 0) return undefined;
  const corners = scene.elements.flatMap((el) => {
    const box = elementBox(scene, el);
    return [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y + box.h }];
  });
  return pointsBox(corners);
}

// ---- edição (funções puras sobre a cena; cada uma devolve a cena nova ou lança `DrawingError`) ----

const ROUND = 100;
const round2 = (n: number): number => Math.round(n * ROUND) / ROUND;

/** Id livre `e<n>` (o menor número acima dos já usados no formato). */
export function freshElementId(scene: DrawingScene): string {
  let max = 0;
  for (const el of scene.elements) {
    const match = /^e(\d+)$/.exec(el.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `e${max + 1}`;
}

/** Entrada crua de um elemento novo (o `id` é opcional: sem ele nasce `e<n>`). */
export type ElementInput = Dict;

/** Confere a cena inteira de novo (limites, ids, conectores) e a devolve. */
function checked(scene: DrawingScene): DrawingScene {
  return readDrawingData(scene);
}

/** Acrescenta um elemento. Erros: `drawing_limit_exceeded`, `drawing_duplicate_id`, `drawing_invalid_*`. */
export function addElement(scene: DrawingScene, input: ElementInput): { scene: DrawingScene; id: string } {
  const id = input.id === undefined ? freshElementId(scene) : input.id;
  const el = readElement({ ...input, id });
  return { scene: checked({ ...scene, elements: [...scene.elements, el] }), id: el.id };
}

function requireElement(scene: DrawingScene, id: string): DrawingElement {
  return elementById(scene, id) ?? fail(DRAWING_ERRORS.missingElement, "elemento não existe no desenho");
}

function replaceElement(scene: DrawingScene, id: string, next: DrawingElement): DrawingScene {
  return checked({ ...scene, elements: scene.elements.map((el) => (el.id === id ? next : el)) });
}

/**
 * Move o elemento por (dx, dy). Conector: só as pontas livres andam (as presas seguem o elemento a que estão presas, então
 * um conector com as duas pontas presas não tem o que mover). Mover um elemento leva, sem mais nada, as pontas dos conectores presos a ele.
 */
export function moveElement(scene: DrawingScene, id: string, dx: number, dy: number): DrawingScene {
  if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) return fail(DRAWING_ERRORS.invalidElement, "deslocamento inválido");
  const el = requireElement(scene, id);
  const shift = (end: ConnectorEnd): ConnectorEnd => (isRef(end) ? end : { x: round2(end.x + dx), y: round2(end.y + dy) });
  switch (el.type) {
    case "stroke": return replaceElement(scene, id, { ...el, points: el.points.map(([x, y]): [number, number] => [round2(x + dx), round2(y + dy)]) });
    case "rect":
    case "ellipse":
    case "text": return replaceElement(scene, id, { ...el, x: round2(el.x + dx), y: round2(el.y + dy) });
    case "line":
    case "arrow": return replaceElement(scene, id, { ...el, from: shift(el.from), to: shift(el.to) });
  }
}

/** Troca o texto de um elemento `text`. */
export function setElementText(scene: DrawingScene, id: string, text: string): DrawingScene {
  const el = requireElement(scene, id);
  if (el.type !== "text") return fail(DRAWING_ERRORS.invalidElement, "o elemento não é um texto");
  return replaceElement(scene, id, { ...el, text: textOf(text) });
}

/**
 * Apaga o elemento. Conector preso a ele fica no lugar: a ponta presa vira o ponto livre onde estava (apagar um
 * elemento não puxa a linha que o tocava).
 */
export function removeElement(scene: DrawingScene, id: string): DrawingScene {
  requireElement(scene, id);
  const elements = scene.elements.filter((el) => el.id !== id).map((el): DrawingElement => {
    if (!isConnector(el) || (!(isRef(el.from) && el.from.ref === id) && !(isRef(el.to) && el.to.ref === id))) return el;
    const [a, b] = connectorEnds(scene, el);
    const detach = (end: ConnectorEnd, at: DrawingPoint): ConnectorEnd => (isRef(end) && end.ref === id ? { x: round2(at.x), y: round2(at.y) } : end);
    return { ...el, from: detach(el.from, a), to: detach(el.to, b) };
  });
  return checked({ ...scene, elements });
}

// ---- traço à mão: ajuste das amostras do ponteiro ----

export const STROKE_FIT = {
  /** Desvio máximo, em unidades do desenho, entre qualquer amostra e o traço guardado. */
  tolerance: 0.8,
  /** Amostras aceitas de entrada: acima disso é recusado antes de qualquer cálculo (o laço do ponteiro limita antes). */
  inputMax: 20_000,
  /** Folga que a gravação com 2 casas decimais pode somar ao desvio. */
  roundingSlack: 0.01,
} as const;

export interface FittedStroke {
  points: [number, number][];
  pressure?: number[];
}

type Pair = readonly [number, number];

function pairDistance(p: Pair, a: Pair, b: Pair): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Índices que sobram de Ramer–Douglas–Peucker (iterativo, sem recursão sobre entrada externa); as pontas ficam sempre. */
function keptIndices(points: readonly Pair[], tolerance: number): number[] {
  const last = points.length - 1;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[last] = true;
  const stack: [number, number][] = [[0, last]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    let worst = -1;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = pairDistance(points[i] as Pair, points[lo] as Pair, points[hi] as Pair);
      if (d > worst) { worst = d; at = i; }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = true;
      stack.push([lo, at], [at, hi]);
    }
  }
  return keep.flatMap((kept, i) => (kept ? [i] : []));
}

/**
 * Amostras do ponteiro → traço guardado: tira repetidos, simplifica (nenhuma amostra fica além de `tolerance` do traço) e, se
 * ainda passar de `strokePoints`, reamostra por igual mantendo as pontas. A pressão, se vier, acompanha os pontos que sobram.
 * Erros: `drawing_limit_exceeded` (entrada acima de `STROKE_FIT.inputMax`) e `drawing_invalid_element`.
 */
export function fitStroke(raw: readonly (readonly [number, number])[], pressure?: readonly number[], tolerance: number = STROKE_FIT.tolerance): FittedStroke {
  if (!Array.isArray(raw) || raw.length === 0) return fail(DRAWING_ERRORS.invalidElement, "traço sem pontos");
  if (raw.length > STROKE_FIT.inputMax) return fail(DRAWING_ERRORS.limitExceeded, "traço com amostras demais");
  if (pressure !== undefined) pressureOf(pressure, raw.length);
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0) return fail(DRAWING_ERRORS.invalidElement, "tolerância inválida");
  const points: Pair[] = [];
  const source: number[] = [];
  raw.forEach((candidate, i) => {
    if (!Array.isArray(candidate) || candidate.length !== 2) return fail(DRAWING_ERRORS.invalidElement, "amostra do traço precisa ser [x, y]");
    const p: Pair = [coord(candidate[0], "ponto"), coord(candidate[1], "ponto")];
    const before = points[points.length - 1];
    if (before && before[0] === p[0] && before[1] === p[1]) return;
    points.push(p);
    source.push(i);
  });
  let picked = keptIndices(points, Math.max(0, tolerance - STROKE_FIT.roundingSlack));
  if (picked.length > DRAWING_LIMITS.strokePoints) {
    const last = picked.length - 1;
    picked = Array.from({ length: DRAWING_LIMITS.strokePoints }, (_, i) => picked[Math.round((i * last) / (DRAWING_LIMITS.strokePoints - 1))] as number);
  }
  const out: FittedStroke = { points: picked.map((i): [number, number] => [round2((points[i] as Pair)[0]), round2((points[i] as Pair)[1])]) };
  if (pressure !== undefined) out.pressure = picked.map((i) => round2(pressure[source[i] as number] as number));
  return out;
}

export interface StrokeInput {
  points: readonly (readonly [number, number])[];
  pressure?: readonly number[];
  stroke?: string;
  width?: number;
  id?: string;
}

/** Acrescenta um traço a partir das amostras cruas (`fitStroke`): é o que o gesto do ponteiro chama ao soltar. */
export function addStroke(scene: DrawingScene, input: StrokeInput): { scene: DrawingScene; id: string } {
  const fitted = fitStroke(input.points, input.pressure);
  return addElement(scene, {
    type: "stroke", points: fitted.points,
    ...(fitted.pressure !== undefined && { pressure: fitted.pressure }),
    ...(input.stroke !== undefined && { stroke: input.stroke }),
    ...(input.width !== undefined && { width: input.width }),
    ...(input.id !== undefined && { id: input.id }),
  });
}

// ---- seleção de vários, redimensionar, duplicar e camadas (cada função devolve a cena nova; o gesto vira UM passo do desfazer) ----

const requireAll = (scene: DrawingScene, ids: readonly string[]): ReadonlySet<string> => {
  const set = new Set(ids);
  for (const id of set) requireElement(scene, id);
  return set;
};

/** Ids dos elementos inteiramente dentro da caixa (arrastar a caixa de seleção), na ordem da cena. Tocar a borda não conta. */
export function elementsInRect(scene: DrawingScene, rect: Box): string[] {
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  return scene.elements.flatMap((el) => {
    const box = elementBox(scene, el);
    return box.x >= rect.x && box.y >= rect.y && box.x + box.w <= right && box.y + box.h <= bottom ? [el.id] : [];
  });
}

/** Caixa que envolve os elementos de `ids` que existem; `undefined` sem nenhum. */
export function selectionBounds(scene: DrawingScene, ids: readonly string[]): Box | undefined {
  const wanted = new Set(ids);
  const corners = scene.elements.filter((el) => wanted.has(el.id)).flatMap((el) => {
    const box = elementBox(scene, el);
    return [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y + box.h }];
  });
  return corners.length === 0 ? undefined : pointsBox(corners);
}

/** Todos andam o mesmo delta; ponta presa segue o alvo (se o alvo também anda, ela acompanha). `drawing_missing_element` se algum id não existe. */
export function moveElements(scene: DrawingScene, ids: readonly string[], dx: number, dy: number): DrawingScene {
  if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) return fail(DRAWING_ERRORS.invalidElement, "deslocamento inválido");
  const set = requireAll(scene, ids);
  return checked({ ...scene, elements: scene.elements.map((el) => (set.has(el.id) ? shifted(el, dx, dy) : el)) });
}

function shifted(el: DrawingElement, dx: number, dy: number): DrawingElement {
  const end = (e: ConnectorEnd): ConnectorEnd => (isRef(e) ? e : { x: round2(e.x + dx), y: round2(e.y + dy) });
  switch (el.type) {
    case "stroke": return { ...el, points: el.points.map(([x, y]): [number, number] => [round2(x + dx), round2(y + dy)]) };
    case "rect":
    case "ellipse":
    case "text": return { ...el, x: round2(el.x + dx), y: round2(el.y + dy) };
    case "line":
    case "arrow": return { ...el, from: end(el.from), to: end(el.to) };
  }
}

export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export const RESIZE_HANDLES: readonly ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const RESIZE_MIN = 4;

/**
 * Caixa depois de arrastar a alça por (dx, dy) **medidos a partir do ponto de agarre**: a borda oposta nunca sai do lugar e
 * delta zero devolve a mesma caixa (sem salto ao pegar ou soltar). Passando do mínimo, trava nele sem inverter.
 */
export function resizeBox(box: Box, handle: ResizeHandle, dx: number, dy: number, min: number = RESIZE_MIN): Box {
  const axis = (start: number, size: number, delta: number, low: boolean, high: boolean): [number, number] => {
    if (high) return [start, Math.max(min, size + delta)];
    if (!low) return [start, size];
    return size - delta >= min ? [start + delta, size - delta] : [start + size - min, min];
  };
  const [x, w] = axis(box.x, box.w, dx, handle.includes("w"), handle.includes("e"));
  const [y, h] = axis(box.y, box.h, dy, handle.includes("n"), handle.includes("s"));
  return { x, y, w, h };
}

/** Leva os elementos de `ids` da caixa `from` para a caixa `to` (escala por eixo; o texto escala pelo menor fator, dentro dos limites do formato). */
export function scaleElements(scene: DrawingScene, ids: readonly string[], from: Box, to: Box): DrawingScene {
  const set = requireAll(scene, ids);
  const sx = to.w / from.w;
  const sy = to.h / from.h;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return fail(DRAWING_ERRORS.invalidElement, "escala inválida");
  const px = (x: number): number => round2(to.x + (x - from.x) * sx);
  const py = (y: number): number => round2(to.y + (y - from.y) * sy);
  const end = (e: ConnectorEnd): ConnectorEnd => (isRef(e) ? e : { x: px(e.x), y: py(e.y) });
  const scale = (el: DrawingElement): DrawingElement => {
    switch (el.type) {
      case "stroke": return { ...el, points: el.points.map(([x, y]): [number, number] => [px(x), py(y)]) };
      case "rect":
      case "ellipse": {
        const deg = rotationDegrees(el);
        if (deg === 0) return { ...el, x: px(el.x), y: py(el.y), w: Math.max(0.01, round2(el.w * sx)), h: Math.max(0.01, round2(el.h * sy)) };
        // girado: o centro escala; os lados escalam pela projeção dos fatores nos eixos do próprio elemento
        const cos = Math.cos(deg * RAD);
        const sin = Math.sin(deg * RAD);
        const w = Math.max(0.01, round2(el.w * Math.hypot(sx * cos, sy * sin)));
        const h = Math.max(0.01, round2(el.h * Math.hypot(sx * sin, sy * cos)));
        return { ...el, x: round2(px(el.x + el.w / 2) - w / 2), y: round2(py(el.y + el.h / 2) - h / 2), w, h };
      }
      case "text": {
        const size = Math.min(DRAWING_LIMITS.sizeMax, Math.max(DRAWING_LIMITS.sizeMin, Math.round((el.size ?? DRAWING_DEFAULTS.textSize) * Math.min(sx, sy))));
        if (rotationDegrees(el) === 0) return { ...el, x: px(el.x), y: py(el.y), size };
        const old = textBox(el);
        const next = textBox({ ...el, size });
        return { ...el, x: round2(px(old.x + old.w / 2) - next.w / 2), y: round2(py(old.y + old.h / 2) - next.h / 2), size };
      }
      case "line":
      case "arrow": return { ...el, from: end(el.from), to: end(el.to) };
    }
  };
  return checked({ ...scene, elements: scene.elements.map((el) => (set.has(el.id) ? scale(el) : el)) });
}

/**
 * Copia os elementos de `ids` deslocados por (dx, dy), no topo e na ordem da cena, com ids novos. Conector copiado liga as
 * cópias quando o alvo também foi copiado; senão continua preso ao alvo original. Devolve a cena e os ids novos.
 */
export function duplicateElements(scene: DrawingScene, ids: readonly string[], dx: number, dy: number): { scene: DrawingScene; ids: string[] } {
  const set = requireAll(scene, ids);
  const picked = scene.elements.filter((el) => set.has(el.id));
  let working = scene;
  const renamed = new Map<string, string>();
  for (const el of picked) {
    const id = freshElementId(working);
    renamed.set(el.id, id);
    working = { ...working, elements: [...working.elements, { ...el, id }] };
  }
  const retarget = (e: ConnectorEnd): ConnectorEnd => (isRef(e) ? { ref: renamed.get(e.ref) ?? e.ref } : e);
  const copies = picked.map((el): DrawingElement => {
    const copy = { ...shifted(el, dx, dy), id: renamed.get(el.id) as string };
    return isConnector(copy) ? { ...copy, from: retarget(copy.from), to: retarget(copy.to) } : copy;
  });
  return { scene: checked({ ...scene, elements: [...scene.elements, ...copies] }), ids: copies.map((el) => el.id) };
}

export type LayerMove = "front" | "back" | "forward" | "backward";

/** Camada = posição na lista (o último fica por cima). `forward` e `backward` andam um degrau por cima dos não selecionados. Sem mudança, devolve a mesma ordem. */
export function reorderElements(scene: DrawingScene, ids: readonly string[], to: LayerMove): DrawingScene {
  const set = requireAll(scene, ids);
  const list = [...scene.elements];
  if (to === "front" || to === "back") {
    const chosen = list.filter((el) => set.has(el.id));
    const rest = list.filter((el) => !set.has(el.id));
    return checked({ ...scene, elements: to === "front" ? [...rest, ...chosen] : [...chosen, ...rest] });
  }
  if (to === "forward") {
    for (let i = list.length - 2; i >= 0; i--) if (set.has((list[i] as DrawingElement).id) && !set.has((list[i + 1] as DrawingElement).id)) [list[i], list[i + 1]] = [list[i + 1] as DrawingElement, list[i] as DrawingElement];
  } else {
    for (let i = 1; i < list.length; i++) if (set.has((list[i] as DrawingElement).id) && !set.has((list[i - 1] as DrawingElement).id)) [list[i], list[i - 1]] = [list[i - 1] as DrawingElement, list[i] as DrawingElement];
  }
  return checked({ ...scene, elements: list });
}

/** Apaga vários de uma vez (um passo do desfazer); conector preso a um deles fica no lugar, como em `removeElement`. */
export function removeElements(scene: DrawingScene, ids: readonly string[]): DrawingScene {
  requireAll(scene, ids);
  return [...new Set(ids)].reduce(removeElement, scene);
}

// ---- girar ----

export const ROTATE_STEP = 15;

/** Passo de giro das teclas da legenda: `q` e `w`. */
export const DRAW_ROTATE_KEYS: readonly { key: string; delta: number }[] = [{ key: "q", delta: -ROTATE_STEP }, { key: "w", delta: ROTATE_STEP }];

/** Gira os elementos de `ids` por `deg` graus (horário) em torno de `pivot` (padrão: o centro da caixa da seleção). Forma e texto guardam o ângulo; traço e pontas livres giram os pontos; ponta presa segue o alvo. */
export function rotateElements(scene: DrawingScene, ids: readonly string[], deg: number, pivot?: DrawingPoint): DrawingScene {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return fail(DRAWING_ERRORS.invalidElement, "ângulo inválido");
  const set = requireAll(scene, ids);
  const center = pivot ?? centerOf(selectionBounds(scene, ids) as Box);
  const at = (p: DrawingPoint): DrawingPoint => {
    const q = rotatePoint(p, center, deg);
    return { x: round2(q.x), y: round2(q.y) };
  };
  const end = (e: ConnectorEnd): ConnectorEnd => (isRef(e) ? e : at(e));
  const turn = (el: DrawingElement): DrawingElement => {
    switch (el.type) {
      case "stroke": return { ...el, points: el.points.map(([x, y]): [number, number] => { const q = at({ x, y }); return [q.x, q.y]; }) };
      case "rect":
      case "ellipse":
      case "text": {
        const box = localBox(scene, el);
        const c = rotatePoint(centerOf(box), center, deg);
        const angle = normalizeAngle(rotationDegrees(el) + deg);
        const { rotation: _old, ...rest } = el;
        return { ...rest, x: round2(c.x - box.w / 2), y: round2(c.y - box.h / 2), ...(angle !== 0 && { rotation: angle }) } as DrawingElement;
      }
      case "line":
      case "arrow": return { ...el, from: end(el.from), to: end(el.to) };
    }
  };
  return checked({ ...scene, elements: scene.elements.map((el) => (set.has(el.id) ? turn(el) : el)) });
}

/** Ângulo (graus) que o ponteiro deu em torno do pivô entre `from` e `to`. Com `step`, o ângulo final (`base` + giro) trava no múltiplo mais próximo (`base` é o ângulo atual do elemento, 0 num conjunto). */
export function rotationDelta(pivot: DrawingPoint, from: DrawingPoint, to: DrawingPoint, base = 0, step?: number): number {
  const turn = (Math.atan2(to.y - pivot.y, to.x - pivot.x) - Math.atan2(from.y - pivot.y, from.x - pivot.x)) / RAD;
  const free = ((turn % FULL_TURN) + FULL_TURN) % FULL_TURN;
  if (step === undefined || step <= 0) return free;
  return Math.round((base + free) / step) * step - base;
}

/** `transform` SVG do giro do elemento (a tela e a exportação usam o mesmo texto); `undefined` quando não gira. */
export function rotateTransform(el: DrawingElement): string | undefined {
  const deg = rotationDegrees(el);
  if (deg === 0) return undefined;
  const c = centerOf(el.type === "text" ? textBox(el) : { x: (el as ShapeElement).x, y: (el as ShapeElement).y, w: (el as ShapeElement).w, h: (el as ShapeElement).h });
  return `rotate(${num(deg)} ${num(c.x)} ${num(c.y)})`;
}

// ---- guias de alinhamento (encaixe nas bordas e centros dos outros elementos) ----

export const SNAP_THRESHOLD = 6;

export interface GuideLine {
  /** `x`: linha vertical em `at`; `y`: linha horizontal. `from`..`to` é o trecho no outro eixo. */
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: GuideLine[];
}

type Anchor = "start" | "center" | "end";
const ALL_ANCHORS: readonly Anchor[] = ["start", "center", "end"];

const anchorsOf = (start: number, size: number, which: readonly Anchor[]): number[] =>
  which.map((anchor) => (anchor === "start" ? start : anchor === "center" ? start + size / 2 : start + size));

/** Encaixe de um eixo: o menor deslocamento que leva uma das marcas da caixa a uma das marcas dos alvos, dentro do limiar; `undefined` sem encaixe. */
function snapAxis(marks: readonly number[], targets: readonly number[], threshold: number): number | undefined {
  let best: number | undefined;
  for (const mark of marks) {
    for (const target of targets) {
      const gap = target - mark;
      if (Math.abs(gap) <= threshold && (best === undefined || Math.abs(gap) < Math.abs(best))) best = gap;
    }
  }
  return best;
}

/** Linhas-guia depois do encaixe: onde a caixa e os alvos coincidem, cobrindo do mais alto ao mais baixo dos que coincidem. */
function guidesFor(box: Box, others: readonly Box[], which: { x: readonly Anchor[]; y: readonly Anchor[] }): GuideLine[] {
  const out: GuideLine[] = [];
  const eps = 0.01;
  for (const axis of ["x", "y"] as const) {
    const [start, size, otherStart, otherSize] = axis === "x" ? [box.x, box.w, box.y, box.h] : [box.y, box.h, box.x, box.w];
    for (const at of new Set(anchorsOf(start, size, which[axis]).map(round2))) {
      const hits = others.filter((o) => anchorsOf(axis === "x" ? o.x : o.y, axis === "x" ? o.w : o.h, ALL_ANCHORS).some((t) => Math.abs(t - at) < eps));
      if (hits.length === 0) continue;
      const spans = hits.map((o) => (axis === "x" ? [o.y, o.y + o.h] : [o.x, o.x + o.w]) as [number, number]);
      out.push({ axis, at, from: Math.min(otherStart, ...spans.map((r) => r[0])), to: Math.max(otherStart + otherSize, ...spans.map((r) => r[1])) });
    }
  }
  return out;
}

/** Caixas dos elementos que servem de alvo: tudo menos o que está sendo arrastado e os conectores (a caixa deles vem dos outros). */
function snapTargets(scene: DrawingScene, exclude: readonly string[]): Box[] {
  const skip = new Set(exclude);
  return scene.elements.filter((el) => !skip.has(el.id) && !isConnector(el)).map((el) => elementBox(scene, el));
}

function snapBox(scene: DrawingScene, exclude: readonly string[], box: Box, which: { x: readonly Anchor[]; y: readonly Anchor[] }, threshold: number): { gap: DrawingPoint; guides: GuideLine[] } {
  const others = snapTargets(scene, exclude);
  const gx = snapAxis(anchorsOf(box.x, box.w, which.x), others.flatMap((o) => anchorsOf(o.x, o.w, ALL_ANCHORS)), threshold) ?? 0;
  const gy = snapAxis(anchorsOf(box.y, box.h, which.y), others.flatMap((o) => anchorsOf(o.y, o.h, ALL_ANCHORS)), threshold) ?? 0;
  const snapped = { ...box, x: box.x + gx, y: box.y + gy };
  return { gap: { x: gx, y: gy }, guides: guidesFor(snapped, others, which) };
}

/** Mover os elementos de `ids` por (dx, dy): devolve o deslocamento já encaixado (bordas e centros da seleção nos dos outros elementos) e as guias a mostrar. Sem alvo no limiar, devolve o mesmo deslocamento. */
export function snapMove(scene: DrawingScene, ids: readonly string[], dx: number, dy: number, threshold: number = SNAP_THRESHOLD): SnapResult {
  const box = selectionBounds(scene, ids);
  if (!box) return { dx, dy, guides: [] };
  const { gap, guides } = snapBox(scene, ids, { ...box, x: box.x + dx, y: box.y + dy }, { x: ALL_ANCHORS, y: ALL_ANCHORS }, threshold);
  return { dx: round2(dx + gap.x), dy: round2(dy + gap.y), guides };
}

/** Redimensionar pela alça: só a(s) borda(s) que a alça move encaixam. Devolve o delta de agarre já encaixado e as guias. */
export function snapResize(scene: DrawingScene, ids: readonly string[], box: Box, handle: ResizeHandle, dx: number, dy: number, threshold: number = SNAP_THRESHOLD): SnapResult {
  const next = resizeBox(box, handle, dx, dy);
  const which = {
    x: (handle.includes("w") ? ["start"] : handle.includes("e") ? ["end"] : []) as Anchor[],
    y: (handle.includes("n") ? ["start"] : handle.includes("s") ? ["end"] : []) as Anchor[],
  };
  const { gap, guides } = snapBox(scene, ids, next, which, threshold);
  return { dx: round2(dx + (which.x.length > 0 ? gap.x : 0)), dy: round2(dy + (which.y.length > 0 ? gap.y : 0)), guides };
}

// ---- conectores presos a elementos ----

/** O elemento (que não é conector nem traço) sob o ponto, o de cima primeiro; considera o giro. É onde a ponta de um conector prende. */
export function anchorTarget(scene: DrawingScene, at: DrawingPoint): string | undefined {
  for (const el of [...scene.elements].reverse()) {
    if (el.type === "stroke" || isConnector(el)) continue;
    const box = localBox(scene, el);
    const deg = rotationDegrees(el);
    const p = deg === 0 ? at : rotatePoint(at, centerOf(box), -deg);
    if (p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) return el.id;
  }
  return undefined;
}

/** Solta a ponta do conector em `at`: sobre um elemento ela prende nele; longe de todos vira ponto livre (desancora). */
export function moveConnectorEnd(scene: DrawingScene, id: string, which: "from" | "to", at: DrawingPoint): DrawingScene {
  const el = requireElement(scene, id);
  if (!isConnector(el)) return fail(DRAWING_ERRORS.invalidConnector, "o elemento não é um conector");
  const ref = anchorTarget(scene, at);
  const end: ConnectorEnd = ref !== undefined ? { ref } : { x: round2(at.x), y: round2(at.y) };
  return replaceElement(scene, id, { ...el, [which]: end });
}

// ---- leitura estruturada (o que o agente lê, sem precisar de imagem) ----

export interface DescribedElement {
  id: string;
  type: ElementKind;
  /** Caixa em coordenadas do desenho (origem no canto do nó). */
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  stroke?: string;
  fill?: string;
  width?: number;
  size?: number;
  /** Traço: quantos pontos. */
  points?: number;
  /** Graus (horário) quando o elemento está girado; `x`, `y`, `w`, `h` são a caixa que o envolve. */
  rotation?: number;
  /** Conector: o que cada ponta é (elemento preso ou ponto livre). */
  from?: ConnectorEnd;
  to?: ConnectorEnd;
}

export interface DescribedDrawing {
  v: typeof DRAWING_VERSION;
  title?: string;
  elements: DescribedElement[];
  /** Todos os textos livres, na ordem do desenho. */
  texts: { id: string; text: string; x: number; y: number }[];
  /** Ligações entre elementos: conector com ao menos uma ponta presa (`null` = ponta livre). */
  links: { id: string; kind: "line" | "arrow"; from: string | null; to: string | null }[];
}

export function describeDrawing(scene: DrawingScene): DescribedDrawing {
  const elements = scene.elements.map((el): DescribedElement => {
    const box = elementBox(scene, el);
    const out: DescribedElement = { id: el.id, type: el.type, x: round2(box.x), y: round2(box.y), w: round2(box.w), h: round2(box.h) };
    if (el.type === "text") { out.text = el.text; if (el.size !== undefined) out.size = el.size; }
    if (el.type === "stroke") out.points = el.points.length;
    if (rotationDegrees(el) !== 0) out.rotation = rotationDegrees(el);
    if (isConnector(el)) { out.from = el.from; out.to = el.to; }
    if (el.stroke !== undefined) out.stroke = el.stroke;
    if ("fill" in el && el.fill !== undefined) out.fill = el.fill;
    if ("width" in el && el.width !== undefined) out.width = el.width;
    return out;
  });
  const texts = scene.elements.flatMap((el) => (el.type === "text" ? [{ id: el.id, text: el.text, x: el.x, y: el.y }] : []));
  const links = scene.elements.flatMap((el) => {
    if (!isConnector(el) || (!isRef(el.from) && !isRef(el.to))) return [];
    return [{ id: el.id, kind: el.type, from: isRef(el.from) ? el.from.ref : null, to: isRef(el.to) ? el.to.ref : null }];
  });
  return { v: scene.v, ...(scene.title !== undefined && { title: scene.title }), elements, texts, links };
}

// ---- exportação em SVG (função pura) ----

const SVG_PADDING = 16;
const PRESSURE_FLOOR = 0.5;
const ARROW_HEAD = 10;
const ARROW_SPREAD = Math.PI / 7;

const num = (n: number): string => String(round2(n));
const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Caminho SVG do traço: Catmull–Rom convertida em Bézier cúbica, que passa por todos os pontos guardados. A tela e a exportação
 * usam este mesmo texto, então o que se vê é o que se salva. Um ponto vira um ponto redondo; dois, uma reta.
 */
export function strokePath(points: readonly (readonly [number, number])[]): string {
  const at = (i: number): readonly [number, number] => points[Math.max(0, Math.min(points.length - 1, i))] as readonly [number, number];
  const pair = (p: readonly [number, number]): string => `${num(p[0])},${num(p[1])}`;
  const first = at(0);
  if (points.length <= 2) return `M${pair(first)}L${pair(at(points.length - 1))}`;
  const parts = [`M${pair(first)}`];
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    parts.push(`C${pair(c1)} ${pair(c2)} ${pair(p2)}`);
  }
  return parts.join("");
}

/** Espessura com que o traço é desenhado: a do `width`, ou ela vezes (0,5 + pressão média) quando o ponteiro trouxe pressão. */
export function strokeWidth(el: StrokeElement): number {
  const width = el.width ?? DRAWING_DEFAULTS.width;
  if (!el.pressure || el.pressure.length === 0) return width;
  const mean = el.pressure.reduce((sum, p) => sum + p, 0) / el.pressure.length;
  return round2(Math.min(DRAWING_LIMITS.widthMax, Math.max(WIDTH_MIN, width * (PRESSURE_FLOOR + mean))));
}

const lineWith = (stroke: string, width: number): string => `stroke="${stroke}" stroke-width="${num(width)}" stroke-linecap="round" stroke-linejoin="round"`;

/** Os dois pés da ponta da seta que chega em `to` vindo de `from` (a tela e o SVG desenham a mesma). */
export function arrowHead(from: DrawingPoint, to: DrawingPoint, width: number): [DrawingPoint, DrawingPoint] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const len = ARROW_HEAD + width * 2;
  return [
    { x: to.x - len * Math.cos(angle - ARROW_SPREAD), y: to.y - len * Math.sin(angle - ARROW_SPREAD) },
    { x: to.x - len * Math.cos(angle + ARROW_SPREAD), y: to.y - len * Math.sin(angle + ARROW_SPREAD) },
  ];
}

function svgElement(scene: DrawingScene, el: DrawingElement): string {
  const stroke = el.stroke ?? DRAWING_DEFAULTS.stroke;
  const width = "width" in el && el.width !== undefined ? el.width : DRAWING_DEFAULTS.width;
  const line = lineWith(stroke, width);
  const turn = rotateTransform(el);
  const spin = turn === undefined ? "" : ` transform="${turn}"`;
  switch (el.type) {
    case "stroke": return `<path d="${strokePath(el.points)}" fill="none" ${lineWith(stroke, strokeWidth(el))}/>`;
    case "rect": return `<rect x="${num(el.x)}" y="${num(el.y)}" width="${num(el.w)}" height="${num(el.h)}" fill="${el.fill ?? "none"}" ${line}${spin}/>`;
    case "ellipse": return `<ellipse cx="${num(el.x + el.w / 2)}" cy="${num(el.y + el.h / 2)}" rx="${num(el.w / 2)}" ry="${num(el.h / 2)}" fill="${el.fill ?? "none"}" ${line}${spin}/>`;
    case "line":
    case "arrow": {
      const [a, b] = connectorEnds(scene, el);
      const shaft = `<line x1="${num(a.x)}" y1="${num(a.y)}" x2="${num(b.x)}" y2="${num(b.y)}" ${line}/>`;
      if (el.type === "line" || (a.x === b.x && a.y === b.y)) return shaft;
      const [l, r] = arrowHead(a, b, width);
      return `${shaft}<polyline points="${num(l.x)},${num(l.y)} ${num(b.x)},${num(b.y)} ${num(r.x)},${num(r.y)}" fill="none" ${line}/>`;
    }
    case "text": {
      const size = el.size ?? DRAWING_DEFAULTS.textSize;
      const spans = el.text.split("\n").map((part, i) => `<tspan x="${num(el.x)}" dy="${i === 0 ? 0 : num(size * TEXT_LINE_HEIGHT)}">${escapeXml(part)}</tspan>`).join("");
      return `<text x="${num(el.x)}" y="${num(el.y + size)}" font-family="sans-serif" font-size="${num(size)}" fill="${stroke}" xml:space="preserve"${spin}>${spans}</text>`;
    }
  }
}

export interface SvgOptions {
  /** Fundo opaco (`#rrggbb`); ausente, transparente. */
  background?: string;
  padding?: number;
}

/**
 * O desenho como SVG autônomo (sem script, sem recurso externo): `viewBox` justa em volta dos elementos com respiro, na
 * ordem do desenho. Desenho vazio sai com uma tela pequena em branco. Determinístico: mesma cena, mesmo texto.
 */
export function drawingToSvg(scene: DrawingScene, options: SvgOptions = {}): string {
  const pad = options.padding ?? SVG_PADDING;
  const bounds = sceneBounds(scene) ?? { x: 0, y: 0, w: DRAWING_LIMITS.frameW / 2, h: DRAWING_LIMITS.frameH / 2 };
  const stroke = Math.max(0, ...scene.elements.map((el) => ("width" in el && el.width !== undefined ? el.width : DRAWING_DEFAULTS.width)));
  const margin = pad + stroke / 2 + (scene.elements.some((el) => el.type === "arrow") ? ARROW_HEAD : 0);
  const x = bounds.x - margin;
  const y = bounds.y - margin;
  const w = bounds.w + 2 * margin;
  const h = bounds.h + 2 * margin;
  if (options.background !== undefined && !COLOR.test(options.background)) return fail(DRAWING_ERRORS.invalidElement, "cor de fundo inválida");
  const bg = options.background === undefined ? "" : `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="${options.background}"/>`;
  const title = scene.title === undefined ? "" : `<title>${escapeXml(scene.title)}</title>`;
  const body = scene.elements.map((el) => svgElement(scene, el)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}" width="${num(w)}" height="${num(h)}">${title}${bg}${body}</svg>`;
}

// ---- o nó `drawing` no documento (operações da pilha de desfazer) ----

export interface DrawingNodeInput {
  /** Escolhido por quem cria (o documento exige id único e no formato dos ids). */
  id: string;
  x: number;
  y: number;
  z?: number;
  w?: number;
  h?: number;
  title?: string;
  elements?: unknown[];
}

/** Dois títulos são o mesmo nome para `drawingOrFail` da CLI: sem distinguir caixa. */
const sameTitle = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Recusa título que já é de outro desenho do documento (`drawing_title_exists`): a CLI acha o desenho por id ou título. */
export function requireFreshDrawingTitle(doc: CanvasDoc, title: string): string {
  const taken = doc.nodes.some((node) => {
    const existing = sceneOfNodeSafe(node)?.title;
    return existing !== undefined && sameTitle(existing, title);
  });
  return taken ? fail(DRAWING_ERRORS.titleExists, `já existe um desenho chamado "${title}"`) : title;
}

/** Cria um nó `drawing` (vazio ou com elementos): `create` do desfazer e o nó. Erros: `drawing_invalid_node`, `drawing_limit_exceeded` e os de dado. */
export function createDrawingNode(doc: CanvasDoc, input: DrawingNodeInput): { op: AtomicOp; node: CanvasNode } {
  if (doc.nodes.length >= CANVAS_LIMITS.nodes) return fail(DRAWING_ERRORS.limitExceeded, "limite de nós do documento atingido");
  if (doc.nodes.some((existing) => existing.id === input.id)) return fail(DRAWING_ERRORS.duplicateId, "já existe nó com esse id");
  const scene = readDrawingData({ v: DRAWING_VERSION, elements: input.elements ?? [], ...(input.title !== undefined && { title: input.title }) });
  let node: CanvasNode;
  try {
    const [valid] = validateCanvasDoc({
      v: doc.v, rev: 0, edges: [], groups: [],
      nodes: [{ id: input.id, type: DRAWING_TYPE, x: input.x, y: input.y, w: input.w ?? DRAWING_LIMITS.frameW, h: input.h ?? DRAWING_LIMITS.frameH, z: input.z ?? 0, data: sceneData(scene), locked: false, blurred: false }],
    }).nodes;
    node = valid as CanvasNode;
  } catch (error) {
    return fail(DRAWING_ERRORS.invalidNode, error instanceof Error ? error.message : "nó inválido");
  }
  return { op: opCreate(doc, [node]), node };
}

/** Troca a cena do nó (um passo de desfazer). `undefined` quando nada muda. Erros: `drawing_invalid_node`, e os de dado. */
export function opSetDrawing(doc: CanvasDoc, id: string, next: DrawingScene): AtomicOp | undefined {
  const node = doc.nodes.find((candidate) => candidate.id === id);
  if (!node || node.type !== DRAWING_TYPE) return fail(DRAWING_ERRORS.invalidNode, "o nó não existe ou não é um desenho");
  const scene = readDrawingData(next);
  const data = sceneData(scene);
  return JSON.stringify(data) === JSON.stringify(node.data) ? undefined : opUpdate(doc, id, data);
}

// ---- acesso pela conexão (mesmas regras das notas: lê o ligado e a cadeia, escreve só no ligado direto) ----

const nodeAt = (doc: CanvasDoc, id: string): CanvasNode | undefined => doc.nodes.find((node) => node.id === id);
const otherEnd = (edge: CanvasDoc["edges"][number], id: string): string | undefined =>
  edge.kind !== LINK_EDGE_KIND ? undefined : edge.from === id ? edge.to : edge.to === id ? edge.from : undefined;

/** Os desenhos ligados direto ao leitor (agente ou terminal), na ordem das arestas. Leitor de outro tipo não tem nenhum. */
export function directDrawingsOf(doc: CanvasDoc, readerId: string): string[] {
  const reader = nodeAt(doc, readerId);
  if (!reader || !NOTE_READER_TYPES.includes(reader.type)) return [];
  const out: string[] = [];
  for (const edge of doc.edges) {
    const other = otherEnd(edge, readerId);
    if (other !== undefined && nodeAt(doc, other)?.type === DRAWING_TYPE && !out.includes(other)) out.push(other);
  }
  return out;
}

/** A cadeia a partir do desenho (ele primeiro), em largura pelas conexões desenho↔desenho; cada um entra uma vez. */
export function drawingChainFrom(doc: CanvasDoc, drawingId: string): { id: string; via: string | null }[] {
  if (nodeAt(doc, drawingId)?.type !== DRAWING_TYPE) return [];
  const out: { id: string; via: string | null }[] = [{ id: drawingId, via: null }];
  const seen = new Set([drawingId]);
  for (let i = 0; i < out.length; i++) {
    const from = (out[i] as { id: string }).id;
    for (const edge of doc.edges) {
      const other = otherEnd(edge, from);
      if (other === undefined || seen.has(other) || nodeAt(doc, other)?.type !== DRAWING_TYPE) continue;
      seen.add(other);
      out.push({ id: other, via: from });
    }
  }
  return out;
}

/** Tudo que o leitor alcança: os desenhos diretos e as cadeias deles, sem repetir (o direto vence o de cadeia). */
export function readableDrawingsOf(doc: CanvasDoc, readerId: string): { id: string; via: string | null }[] {
  const direct = directDrawingsOf(doc, readerId);
  const out = direct.map((id) => ({ id, via: null as string | null }));
  const seen = new Set(direct);
  for (const entry of direct) {
    for (const hop of drawingChainFrom(doc, entry)) {
      if (seen.has(hop.id)) continue;
      seen.add(hop.id);
      out.push(hop);
    }
  }
  return out;
}

export const hasDrawingAccess = (doc: CanvasDoc, drawingId: string, readerId: string): boolean => directDrawingsOf(doc, readerId).includes(drawingId);

/** Escreve no desenho: o dono sempre; o agente só se uma conexão o liga direto. Nó inexistente ou de outro tipo: `false`. */
export function canWriteDrawing(doc: CanvasDoc, drawingId: string, writer: NoteWriter): boolean {
  if (nodeAt(doc, drawingId)?.type !== DRAWING_TYPE) return false;
  return writer.kind === "owner" || hasDrawingAccess(doc, drawingId, writer.id);
}

/** O agente lê o desenho: ligado direto ou pela cadeia. */
export const canReadDrawing = (doc: CanvasDoc, drawingId: string, readerId: string): boolean => readableDrawingsOf(doc, readerId).some((entry) => entry.id === drawingId);

// ---- apresentação do editor: paleta, espessuras e teclas (dados puros; a tela só os desenha) ----

/** Cores do desenho: o token de tema que a tela resolve (`--<token>`), claro e escuro. `foreground` é a tinta padrão (sem `stroke`, segue o tema). */
export const DRAW_PALETTE: readonly { token: string; label: string }[] = [
  { token: "foreground", label: "Tinta" }, { token: "vivo", label: "Vivo" }, { token: "info", label: "Azul" },
  { token: "ok", label: "Verde" }, { token: "warn", label: "Âmbar" }, { token: "bad", label: "Vermelho" },
];

/** Espessuras oferecidas (a padrão do formato, 2, é a segunda). */
export const DRAW_WIDTHS: readonly number[] = [1, 2, 4, 8];

const BYTE = 255;
const hex2 = (n: number): string => Math.min(BYTE, Math.max(0, Math.round(n))).toString(16).padStart(2, "0");

/** Cor resolvida pelo navegador (canais 0–255 e alfa 0–1) → `#rrggbb` ou `#rrggbbaa`, o formato que o desenho guarda. */
export function rgbaToHex(r: number, g: number, b: number, a: number = 1): string {
  const alpha = Math.min(1, Math.max(0, a));
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha < 1 ? hex2(alpha * BYTE) : ""}`;
}

export type DrawTool = "select" | "rect" | "ellipse" | "line" | "arrow" | "stroke" | "text";

/**
 * Uma tecla por ferramenta (só com o foco no desenho em edição). Letras que o canvas e a página ainda não usam: z c v b n e f l j k
 * já são deles, e as de Shift (a o s y t g m f l p n r x b e) criam e organizam nós.
 */
export const DRAW_SHORTCUTS: readonly { tool: DrawTool; key: string; label: string }[] = [
  { tool: "select", key: "s", label: "Selecionar" }, { tool: "rect", key: "r", label: "Retângulo" }, { tool: "ellipse", key: "o", label: "Elipse" },
  { tool: "line", key: "i", label: "Linha" }, { tool: "arrow", key: "a", label: "Seta" }, { tool: "stroke", key: "p", label: "Traço" }, { tool: "text", key: "t", label: "Texto" },
];

/** Teclas de ação do desenho em edição, para a legenda (`keys` já escrito para a tela). */
export const DRAW_ACTION_KEYS: readonly { keys: string; label: string }[] = [
  { keys: "Ctrl+D", label: "Duplicar a seleção" }, { keys: "Delete", label: "Apagar a seleção" },
  { keys: "Q / W", label: "Gira a seleção 15° para a esquerda / direita" }, { keys: "Alça de giro", label: "Gira a seleção (Shift: passos de 15°)" },
  { keys: "Alt (ao arrastar)", label: "Sem encaixe nas guias de alinhamento" },
  { keys: "PgUp / PgDn", label: "Camada: um degrau acima / abaixo" }, { keys: "Shift+PgUp / PgDn", label: "Camada: frente / trás" },
  { keys: "Esc", label: "Cancela o gesto, volta a Selecionar, sai do desenho" },
];
