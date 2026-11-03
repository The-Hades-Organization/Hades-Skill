// Elevar e acoplar (reference/argos.md §Organização avançada): um nó sobe a um painel central e pode ficar acoplado na borda
// como coluna fixa enquanto o canvas se move. É estado de tela, não do documento: nada aqui toca a pilha de desfazer.
// Estado imutável; cada função devolve um estado novo. Sem Node e sem DOM.
import type { CanvasDoc } from "./canvas-doc.ts";
import type { Frame, Point } from "./canvas-history.ts";
import { ORG_ERRORS, orgFail } from "./canvas-groups.ts";

export type DockEdge = "left" | "right";
export const DOCK_EDGES: readonly DockEdge[] = ["left", "right"];

export const DOCK_LIMITS = {
  columnsPerEdge: 3,
  minWidth: 160,
  maxWidth: 640,
  defaultWidth: 320,
  /** Faixa, em pixels da tela, junto a cada borda onde soltar acopla. */
  edgeZone: 48,
  /** Parte da área central que o painel elevado ocupa em cada eixo. */
  elevatedRatio: 0.8,
} as const;

export interface DockColumn {
  id: string;
  edge: DockEdge;
  width: number;
}

export interface DockState {
  /** Nó no painel central, ou `null`. */
  elevated: string | null;
  /** Colunas na ordem em que foram acopladas (dentro de cada borda, da borda para o centro). */
  columns: DockColumn[];
}

export const emptyDock = (): DockState => ({ elevated: null, columns: [] });

const known = (doc: CanvasDoc, id: string): void => {
  if (!doc.nodes.some((node) => node.id === id)) orgFail(ORG_ERRORS.unknownNode, "nó não existe no documento");
};

function checkEdge(edge: string): asserts edge is DockEdge {
  if (!(DOCK_EDGES as readonly string[]).includes(edge)) orgFail(ORG_ERRORS.invalidMode, "borda precisa ser left ou right");
}

function checkWidth(width: number): number {
  const ok = Number.isFinite(width) && width >= DOCK_LIMITS.minWidth && width <= DOCK_LIMITS.maxWidth;
  return ok ? width : orgFail(ORG_ERRORS.invalidNumber, `largura da coluna deve ficar entre ${DOCK_LIMITS.minWidth} e ${DOCK_LIMITS.maxWidth}`);
}

const without = (columns: readonly DockColumn[], id: string): DockColumn[] => columns.filter((column) => column.id !== id);

/** Eleva o nó ao painel central; o que estava elevado volta ao canvas, e um nó acoplado sai da coluna. Erro: `org_unknown_node`. */
export function elevate(state: DockState, doc: CanvasDoc, id: string): DockState {
  known(doc, id);
  return { elevated: id, columns: without(state.columns, id) };
}

/** Baixa o painel central; sem nó elevado devolve o mesmo estado. */
export const release = (state: DockState): DockState => (state.elevated === null ? state : { ...state, elevated: null });

/** Duplo clique no cabeçalho: eleva, ou baixa se este mesmo nó já está elevado. */
export const toggleElevated = (state: DockState, doc: CanvasDoc, id: string): DockState =>
  state.elevated === id ? release(state) : elevate(state, doc, id);

/**
 * Acopla o nó na borda como coluna. Nó já acoplado muda de borda (e de largura, se informada); o elevado deixa o painel.
 * Erros: `org_unknown_node`, `org_invalid_mode` (borda), `org_invalid_number` (largura), `org_limit_exceeded` (borda cheia).
 */
export function dockNode(state: DockState, doc: CanvasDoc, id: string, edge: string, width?: number): DockState {
  known(doc, id);
  checkEdge(edge);
  const previous = state.columns.find((column) => column.id === id);
  const finalWidth = checkWidth(width ?? previous?.width ?? DOCK_LIMITS.defaultWidth);
  const others = without(state.columns, id);
  if (others.filter((column) => column.edge === edge).length >= DOCK_LIMITS.columnsPerEdge) {
    return orgFail(ORG_ERRORS.limitExceeded, "a borda já está cheia de colunas");
  }
  return { elevated: state.elevated === id ? null : state.elevated, columns: [...others, { id, edge, width: finalWidth }] };
}

/** Tira a coluna; nó que não estava acoplado devolve o mesmo estado. */
export function undock(state: DockState, id: string): DockState {
  return state.columns.some((column) => column.id === id) ? { ...state, columns: without(state.columns, id) } : state;
}

/** Muda a largura de uma coluna. Erros: `org_unknown_node` (não está acoplado), `org_invalid_number`. */
export function resizeColumn(state: DockState, id: string, width: number): DockState {
  const checked = checkWidth(width);
  if (!state.columns.some((column) => column.id === id)) return orgFail(ORG_ERRORS.unknownNode, "o nó não está acoplado");
  return { ...state, columns: state.columns.map((column) => (column.id === id ? { ...column, width: checked } : column)) };
}

/** Descarta o que o documento não tem mais (nó excluído). Nada a descartar devolve o mesmo estado. */
export function reconcileDock(state: DockState, doc: CanvasDoc): DockState {
  const present = new Set(doc.nodes.map((node) => node.id));
  const columns = state.columns.filter((column) => present.has(column.id));
  const elevated = state.elevated !== null && present.has(state.elevated) ? state.elevated : null;
  return columns.length === state.columns.length && elevated === state.elevated ? state : { elevated, columns };
}

export interface Viewport {
  w: number;
  h: number;
}

function checkViewport(viewport: Viewport): void {
  if (!(Number.isFinite(viewport.w) && viewport.w > 0 && Number.isFinite(viewport.h) && viewport.h > 0)) {
    orgFail(ORG_ERRORS.invalidNumber, "a tela precisa ter largura e altura positivas");
  }
}

/** Em que borda um ponto da tela (coordenadas da tela, não do canvas) acopla ao soltar: a faixa junto a cada borda. */
export function dockEdgeAt(point: Point, viewport: Viewport, zone: number = DOCK_LIMITS.edgeZone): DockEdge | undefined {
  checkViewport(viewport);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(zone) || zone < 0) return orgFail(ORG_ERRORS.invalidNumber, "ponto ou faixa inválidos");
  if (point.x < 0 || point.x > viewport.w || point.y < 0 || point.y > viewport.h) return undefined;
  if (point.x <= zone) return "left";
  return point.x >= viewport.w - zone ? "right" : undefined;
}

export interface DockLayout {
  /** Retângulo de cada coluna, em pixels da tela, altura total. */
  columns: { id: string; edge: DockEdge; frame: Frame }[];
  /** O que sobra para o canvas entre as colunas; é nele que a câmera se move. */
  canvas: Frame;
  /** Painel do nó elevado, centralizado na área do canvas; `null` sem nó elevado. */
  elevated: { id: string; frame: Frame } | null;
}

/**
 * Posições na tela. As colunas empilham da borda para o centro; se a soma passar de 60% da largura, as últimas acopladas
 * são recortadas até caber (a largura guardada não muda). Erro: `org_invalid_number` (tela).
 */
export function layoutDock(state: DockState, viewport: Viewport): DockLayout {
  checkViewport(viewport);
  const budget = viewport.w * 0.6;
  let used = 0;
  const offsets: Record<DockEdge, number> = { left: 0, right: 0 };
  const columns: DockLayout["columns"] = [];
  for (const column of state.columns) {
    const width = Math.min(column.width, budget - used);
    if (width < DOCK_LIMITS.minWidth) continue;
    used += width;
    const x = column.edge === "left" ? offsets.left : viewport.w - offsets.right - width;
    offsets[column.edge] += width;
    columns.push({ id: column.id, edge: column.edge, frame: { x, y: 0, w: width, h: viewport.h } });
  }
  const canvas: Frame = { x: offsets.left, y: 0, w: viewport.w - offsets.left - offsets.right, h: viewport.h };
  const ratio = DOCK_LIMITS.elevatedRatio;
  const elevated =
    state.elevated === null
      ? null
      : { id: state.elevated, frame: { x: canvas.x + (canvas.w * (1 - ratio)) / 2, y: (canvas.h * (1 - ratio)) / 2, w: canvas.w * ratio, h: canvas.h * ratio } };
  return { columns, canvas, elevated };
}

/** Estado guardado (texto lido de fora) → estado válido para o documento; qualquer incoerência lança `org_invalid_mode`. */
export function parseDock(raw: unknown, doc: CanvasDoc): DockState {
  const bad = (): never => orgFail(ORG_ERRORS.invalidMode, "estado do acoplamento inválido");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad();
  const { elevated, columns } = raw as { elevated?: unknown; columns?: unknown };
  if (!(elevated === null || typeof elevated === "string") || !Array.isArray(columns)) return bad();
  let state = emptyDock();
  for (const item of columns) {
    if (typeof item !== "object" || item === null) return bad();
    const { id, edge, width } = item as { id?: unknown; edge?: unknown; width?: unknown };
    if (typeof id !== "string" || typeof edge !== "string" || typeof width !== "number" || state.columns.some((c) => c.id === id)) return bad();
    state = dockNode(state, doc, id, edge, width);
  }
  return elevated === null ? state : elevate(state, doc, elevated);
}
