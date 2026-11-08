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

export type StrokeElement = { id: string; type: "stroke"; points: [number, number][] } & Pick<Look, "stroke" | "width">;
export type ShapeElement = { id: string; type: "rect" | "ellipse"; x: number; y: number; w: number; h: number } & Look;
export type ConnectorElement = { id: string; type: "line" | "arrow"; from: ConnectorEnd; to: ConnectorEnd } & Pick<Look, "stroke" | "width">;
export type TextElement = { id: string; type: "text"; x: number; y: number; text: string; size?: number; stroke?: string };
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
      onlyKeys(raw, ["id", "type", "points", "stroke", "width"], type);
      if (!Array.isArray(raw.points) || raw.points.length === 0) return fail(DRAWING_ERRORS.invalidElement, "traço sem pontos");
      if (raw.points.length > DRAWING_LIMITS.strokePoints) return fail(DRAWING_ERRORS.limitExceeded, "traço com pontos demais");
      const points = raw.points.map((p): [number, number] => {
        if (!Array.isArray(p) || p.length !== 2) return fail(DRAWING_ERRORS.invalidElement, "ponto do traço precisa ser [x, y]");
        return [coord(p[0], "ponto"), coord(p[1], "ponto")];
      });
      return { id, type, points, ...lookOf(raw, ["stroke", "width"]) };
    }
    case "rect":
    case "ellipse": {
      onlyKeys(raw, ["id", "type", "x", "y", "w", "h", ...LOOK_KEYS], type);
      return { id, type, x: coord(raw.x, "x"), y: coord(raw.y, "y"), w: extent(raw.w, "w"), h: extent(raw.h, "h"), ...lookOf(raw, LOOK_KEYS) };
    }
    case "line":
    case "arrow": {
      onlyKeys(raw, ["id", "type", "from", "to", "stroke", "width"], type);
      return { id, type, from: endOf(raw.from, "from"), to: endOf(raw.to, "to"), ...lookOf(raw, ["stroke", "width"]) };
    }
    case "text": {
      onlyKeys(raw, ["id", "type", "x", "y", "text", "size", "stroke"], type);
      const out: TextElement = { id, type, x: coord(raw.x, "x"), y: coord(raw.y, "y"), text: textOf(raw.text) };
      if (raw.size !== undefined) out.size = sizeOf(raw.size);
      if (raw.stroke !== undefined) out.stroke = colorOf(raw.stroke, "stroke");
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

/** Ponto da borda do alvo (retângulo ou elipse) na reta do centro até `toward`. */
function edgePoint(el: DrawingElement, box: Box, toward: DrawingPoint): DrawingPoint {
  const c = centerOf(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  if (el.type === "ellipse") {
    const scale = 1 / Math.sqrt((dx / (box.w / 2)) ** 2 + (dy / (box.h / 2)) ** 2);
    return { x: c.x + dx * scale, y: c.y + dy * scale };
  }
  const scale = Math.min(dx === 0 ? Infinity : box.w / 2 / Math.abs(dx), dy === 0 ? Infinity : box.h / 2 / Math.abs(dy));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

const elementById = (scene: DrawingScene, id: string): DrawingElement | undefined => scene.elements.find((el) => el.id === id);

/**
 * Caixa do elemento em coordenadas do desenho. Conector: a dos dois extremos já resolvidos. Cena que passou por
 * `readDrawingData` nunca tem referência solta; defensivamente, ponta sem alvo cai na origem.
 */
export function elementBox(scene: DrawingScene, el: DrawingElement): Box {
  switch (el.type) {
    case "stroke": return pointsBox(el.points.map(([x, y]) => ({ x, y })));
    case "rect":
    case "ellipse": return { x: el.x, y: el.y, w: el.w, h: el.h };
    case "text": return textBox(el);
    case "line":
    case "arrow": {
      const [a, b] = connectorEnds(scene, el);
      return pointsBox([a, b]);
    }
  }
}

/** As duas pontas do conector em coordenadas do desenho: ponto livre como está; ponta presa na borda do elemento, virada para a outra ponta. */
export function connectorEnds(scene: DrawingScene, el: ConnectorElement): [DrawingPoint, DrawingPoint] {
  const target = (end: ConnectorEnd): { el: DrawingElement; box: Box } | undefined => {
    if (!isRef(end)) return undefined;
    const found = elementById(scene, end.ref);
    return found && !isConnector(found) ? { el: found, box: elementBox(scene, found) } : undefined;
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
const ARROW_HEAD = 10;
const ARROW_SPREAD = Math.PI / 7;

const num = (n: number): string => String(round2(n));
const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function arrowHead(from: DrawingPoint, to: DrawingPoint, width: number): [DrawingPoint, DrawingPoint] {
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
  const line = `stroke="${stroke}" stroke-width="${num(width)}" stroke-linecap="round" stroke-linejoin="round"`;
  switch (el.type) {
    case "stroke": return `<polyline points="${el.points.map(([x, y]) => `${num(x)},${num(y)}`).join(" ")}" fill="none" ${line}/>`;
    case "rect": return `<rect x="${num(el.x)}" y="${num(el.y)}" width="${num(el.w)}" height="${num(el.h)}" fill="${el.fill ?? "none"}" ${line}/>`;
    case "ellipse": return `<ellipse cx="${num(el.x + el.w / 2)}" cy="${num(el.y + el.h / 2)}" rx="${num(el.w / 2)}" ry="${num(el.h / 2)}" fill="${el.fill ?? "none"}" ${line}/>`;
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
      return `<text x="${num(el.x)}" y="${num(el.y + size)}" font-family="sans-serif" font-size="${num(size)}" fill="${stroke}" xml:space="preserve">${spans}</text>`;
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
