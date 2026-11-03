// Desenho livre do canvas (reference/argos.md §Desenho e arestas): retângulo, elipse, seta e traço à mão como nós do
// usuário. Lógica pura e sem Node/DOM. Os pontos de seta e traço ficam normalizados (0..1) dentro da caixa do nó: mover e
// redimensionar o nó, pelas operações que a pilha de desfazer já tem, leva o desenho junto.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNode } from "./canvas-doc.ts";
import { type AtomicOp, type Frame, opCreate, type Point } from "./canvas-history.ts";

export const DRAW_TYPES = ["draw-rect", "draw-ellipse", "draw-arrow", "draw-stroke"] as const;
export type DrawType = (typeof DRAW_TYPES)[number];

/** Pontos que um traço aceita de entrada (antes de simplificar) e que guarda (depois). */
export const STROKE_INPUT_MAX = 20_000;
export const STROKE_POINTS_MAX = 500;
export const STROKE_TOLERANCE_DEFAULT = 1.5;
export const HIT_TOLERANCE_DEFAULT = 4;
export const STROKE_WIDTH_MAX = 64;
export const STROKE_WIDTH_DEFAULT = 2;

/** Códigos estáveis: só ganham valores. */
export const DRAW_ERRORS = {
  invalidPoint: "draw_invalid_point",
  invalidStyle: "draw_invalid_style",
  invalidId: "draw_invalid_id",
  duplicateId: "draw_duplicate_id",
  limitExceeded: "draw_limit_exceeded",
  emptyStroke: "draw_empty_stroke",
  notDrawing: "draw_not_drawing",
} as const;
export type DrawErrorCode = (typeof DRAW_ERRORS)[keyof typeof DRAW_ERRORS];

export class DrawError extends Error {
  readonly code: DrawErrorCode;
  constructor(code: DrawErrorCode, message: string) {
    super(message);
    this.name = "DrawError";
    this.code = code;
  }
}

const fail = (code: DrawErrorCode, message: string): never => {
  throw new DrawError(code, message);
};

export interface DrawStyle {
  /** Cor `#rgb`, `#rrggbb` ou `#rrggbbaa`; ausente, quem desenha usa o tom do tema. */
  stroke?: string;
  /** Preenchimento (só retângulo e elipse), mesmo formato; ausente, sem preenchimento. */
  fill?: string;
  /** Espessura em unidades do canvas, de 0.5 a 64. */
  width: number;
}

const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const ID = /^[\w.:-]+$/;
const WIDTH_MIN = 0.5;

function checkedStyle(style: Partial<DrawStyle> | undefined): DrawStyle {
  const out: DrawStyle = { width: STROKE_WIDTH_DEFAULT };
  if (!style) return out;
  const { stroke, fill, width } = style;
  if (stroke !== undefined) {
    if (typeof stroke !== "string" || !COLOR.test(stroke)) return fail(DRAW_ERRORS.invalidStyle, "cor do traço inválida");
    out.stroke = stroke;
  }
  if (fill !== undefined) {
    if (typeof fill !== "string" || !COLOR.test(fill)) return fail(DRAW_ERRORS.invalidStyle, "cor de preenchimento inválida");
    out.fill = fill;
  }
  if (width !== undefined) {
    if (typeof width !== "number" || !Number.isFinite(width) || width < WIDTH_MIN || width > STROKE_WIDTH_MAX) {
      return fail(DRAW_ERRORS.invalidStyle, "espessura fora do intervalo");
    }
    out.width = width;
  }
  return out;
}

function checkedPoint(point: Point): Point {
  const limit = CANVAS_LIMITS.coordinate;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= limit;
  if (typeof point !== "object" || point === null || !ok(point.x) || !ok(point.y)) return fail(DRAW_ERRORS.invalidPoint, "ponto inválido");
  return { x: point.x, y: point.y };
}

function freshId(doc: CanvasDoc, id: string): string {
  if (typeof id !== "string" || id.length === 0 || id.length > CANVAS_LIMITS.idChars || !ID.test(id)) return fail(DRAW_ERRORS.invalidId, "id inválido");
  if (doc.nodes.some((node) => node.id === id)) return fail(DRAW_ERRORS.duplicateId, "id já existe no documento");
  return id;
}

const nextLayer = (doc: CanvasDoc): number => Math.min(CANVAS_LIMITS.layer, doc.nodes.reduce((top, node) => Math.max(top, node.z), 0) + 1);

function boxOf(points: readonly Point[]): Frame {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y } of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

function assertRoom(doc: CanvasDoc): void {
  if (doc.nodes.length >= CANVAS_LIMITS.nodes) fail(DRAW_ERRORS.limitExceeded, "documento passaria do limite de nós");
}

export interface Created {
  node: CanvasNode;
  op: AtomicOp;
}

function build(doc: CanvasDoc, id: string, type: DrawType, frame: Frame, data: Record<string, unknown>): Created {
  assertRoom(doc);
  const node: CanvasNode = { id, type, ...frame, z: nextLayer(doc), data, locked: false, blurred: false };
  return { node, op: opCreate(doc, [node]) };
}

/** Retângulo ou elipse pelos dois cantos do arrasto (qualquer direção). Cria uma operação da pilha de desfazer. */
export function createShape(doc: CanvasDoc, id: string, shape: "rect" | "ellipse", a: Point, b: Point, style?: Partial<DrawStyle>): Created {
  freshId(doc, id);
  const frame = boxOf([checkedPoint(a), checkedPoint(b)]);
  return build(doc, id, shape === "rect" ? "draw-rect" : "draw-ellipse", frame, { style: checkedStyle(style) });
}

/** Seta de `from` até `to`; o nó é a caixa dos dois pontos e a direção fica nos pontos normalizados. */
export function createArrow(doc: CanvasDoc, id: string, from: Point, to: Point, style?: Partial<DrawStyle>): Created {
  freshId(doc, id);
  const a = checkedPoint(from);
  const b = checkedPoint(to);
  const frame = boxOf([a, b]);
  const norm = (p: Point): [number, number] => [(p.x - frame.x) / frame.w, (p.y - frame.y) / frame.h];
  return build(doc, id, "draw-arrow", frame, { style: checkedStyle(style), from: norm(a), to: norm(b) });
}

/**
 * Traço à mão. Antes de qualquer cálculo recusa entrada acima de `STROKE_INPUT_MAX`; depois tira repetidos e simplifica
 * (Ramer–Douglas–Peucker, iterativo) com `tolerance`, e se ainda passar de `STROKE_POINTS_MAX` reamostra por igual.
 */
export function createStroke(doc: CanvasDoc, id: string, raw: readonly Point[], style?: Partial<DrawStyle>, tolerance: number = STROKE_TOLERANCE_DEFAULT): Created {
  freshId(doc, id);
  const points = simplifyStroke(raw, tolerance);
  const frame = boxOf(points);
  const normalized = points.map((p) => [(p.x - frame.x) / frame.w, (p.y - frame.y) / frame.h]);
  return build(doc, id, "draw-stroke", frame, { style: checkedStyle(style), points: normalized });
}

/** Pontos do traço depois de validar, tirar repetidos consecutivos, simplificar e limitar. Mantém sempre as pontas. */
export function simplifyStroke(raw: readonly Point[], tolerance: number = STROKE_TOLERANCE_DEFAULT): Point[] {
  if (!Array.isArray(raw) || raw.length === 0) return fail(DRAW_ERRORS.emptyStroke, "traço sem pontos");
  if (raw.length > STROKE_INPUT_MAX) return fail(DRAW_ERRORS.limitExceeded, "traço com pontos demais");
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0) return fail(DRAW_ERRORS.invalidStyle, "tolerância inválida");
  const points: Point[] = [];
  for (const candidate of raw) {
    const p = checkedPoint(candidate);
    const last = points[points.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) points.push(p);
  }
  const kept = rdp(points, tolerance);
  return kept.length > STROKE_POINTS_MAX ? resample(kept, STROKE_POINTS_MAX) : kept;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function rdp(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    let worst = -1;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = distanceToSegment(points[i] as Point, points[lo] as Point, points[hi] as Point);
      if (d > worst) { worst = d; at = i; }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = true;
      stack.push([lo, at], [at, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function resample(points: readonly Point[], count: number): Point[] {
  const last = points.length - 1;
  return Array.from({ length: count }, (_, i) => points[Math.round((i * last) / (count - 1))] as Point);
}

// ---- leitura dos desenhos do documento ----

export const isDrawType = (type: string): type is DrawType => (DRAW_TYPES as readonly string[]).includes(type);
export const isDrawing = (node: CanvasNode): boolean => isDrawType(node.type);

/** Caixa envolvente do desenho (a do nó: pontos normalizados ficam sempre dentro dela). */
export function drawBounds(node: CanvasNode): Frame {
  if (!isDrawing(node)) return fail(DRAW_ERRORS.notDrawing, "o nó não é um desenho");
  return { x: node.x, y: node.y, w: node.w, h: node.h };
}

/** Caixa que envolve vários desenhos (e só eles); `undefined` se não há nenhum. */
export function drawingsBounds(nodes: readonly CanvasNode[]): Frame | undefined {
  const drawings = nodes.filter(isDrawing);
  if (drawings.length === 0) return undefined;
  return boxOf(drawings.flatMap((n) => [{ x: n.x, y: n.y }, { x: n.x + n.w, y: n.y + n.h }]));
}

function pairOf(value: unknown): Point | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [x, y] = value as unknown[];
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/** Pontos do desenho em coordenadas do canvas: seta (início e fim) ou traço. Dado corrompido no `data` vira lista vazia. */
export function drawPoints(node: CanvasNode): Point[] {
  const place = (p: Point): Point => ({ x: node.x + p.x * node.w, y: node.y + p.y * node.h });
  const data = node.data;
  if (node.type === "draw-arrow") {
    const a = pairOf(data.from);
    const b = pairOf(data.to);
    return a && b ? [place(a), place(b)] : [];
  }
  if (node.type === "draw-stroke") {
    const list = Array.isArray(data.points) ? data.points : [];
    const mapped = list.map(pairOf);
    return mapped.every((p): p is Point => p !== undefined) ? mapped.map(place) : [];
  }
  return [];
}

function hasFill(node: CanvasNode): boolean {
  const style = node.data.style as { fill?: unknown } | undefined;
  return typeof style?.fill === "string";
}

function lineHit(points: readonly Point[], at: Point, tolerance: number): boolean {
  if (points.length === 1) return Math.hypot(at.x - (points[0] as Point).x, at.y - (points[0] as Point).y) <= tolerance;
  for (let i = 1; i < points.length; i++) {
    if (distanceToSegment(at, points[i - 1] as Point, points[i] as Point) <= tolerance) return true;
  }
  return false;
}

/**
 * O ponto acerta o desenho? Com preenchimento, o interior conta; sem, só a borda (até `tolerance` de distância).
 * Seta e traço acertam perto da linha. Nó que não é desenho nunca é acertado.
 */
export function hitDrawing(node: CanvasNode, at: Point, tolerance: number = HIT_TOLERANCE_DEFAULT): boolean {
  if (!isDrawing(node) || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return false;
  const reach = Math.max(0, tolerance);
  if (node.type === "draw-arrow" || node.type === "draw-stroke") return lineHit(drawPoints(node), at, reach);
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  if (node.type === "draw-rect") {
    const inside = at.x >= node.x && at.x <= node.x + node.w && at.y >= node.y && at.y <= node.y + node.h;
    if (inside && hasFill(node)) return true;
    const inner = at.x >= node.x + reach && at.x <= node.x + node.w - reach && at.y >= node.y + reach && at.y <= node.y + node.h - reach;
    const outer = at.x >= node.x - reach && at.x <= node.x + node.w + reach && at.y >= node.y - reach && at.y <= node.y + node.h + reach;
    return outer && !inner;
  }
  // elipse: valor de (x/a)²+(y/b)² com semieixos ampliados e reduzidos pela tolerância
  const norm = (a: number, b: number): number => (a <= 0 || b <= 0 ? Infinity : ((at.x - cx) / a) ** 2 + ((at.y - cy) / b) ** 2);
  const ra = node.w / 2;
  const rb = node.h / 2;
  const outer = norm(ra + reach, rb + reach) <= 1;
  if (hasFill(node)) return outer;
  return outer && norm(ra - reach, rb - reach) >= 1;
}

/** O desenho do topo sob o ponto (maior `z`, depois o último da lista), ou `undefined`. */
export function drawingAt(doc: CanvasDoc, at: Point, tolerance: number = HIT_TOLERANCE_DEFAULT): CanvasNode | undefined {
  let top: CanvasNode | undefined;
  for (const node of doc.nodes) {
    if (!hitDrawing(node, at, tolerance)) continue;
    if (!top || node.z >= top.z) top = node;
  }
  return top;
}
