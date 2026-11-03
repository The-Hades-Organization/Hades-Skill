// Seleção e manipulação direta do canvas do Argos: acerto do ponteiro, clique/Shift/retângulo, mover e redimensionar com
// encaixe na grade, recusa do nó `locked`, setas pela grade e ordem do Tab. Lógica pura e sem Node: cada gesto terminado
// vira uma operação do canvas-history (arrasto de vários = um lote), que o componente entrega a quem persiste.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNode } from "./canvas-doc.ts";
import { type CanvasOp, opMoveMany, opResize } from "./canvas-history.ts";
import { type Detail, type Rect, type Vec, intersects } from "./canvas-camera.ts";

export const SELECTION_LIMITS = {
  /** Grade de encaixe, em unidades de mundo. */
  grid: 20,
  /** Altura do cabeçalho do nó (por onde ele se move no detalhe completo), em unidades de mundo. */
  header: 24,
  /** Lado da alça de redimensionar, em pixels de tela (o alvo não encolhe com o zoom). */
  handlePx: 12,
  /** Menor lado de um nó ao redimensionar, em unidades de mundo. */
  minSide: 40,
  /** Movimento, em pixels de tela, abaixo do qual o gesto ainda é um clique. */
  clickSlopPx: 3,
  /** Shift + seta anda isto de grades. */
  fastNudge: 5,
} as const;

export type Selection = readonly string[];

// `|| 0` troca o -0 de Math.round(-0.4) por 0: -0 vazaria para o documento e quebraria a igualdade das posições
export const snap = (value: number, grid: number = SELECTION_LIMITS.grid): number => Math.round(value / grid) * grid || 0;

// ---- acerto do ponteiro ----

export type HitRegion = "header" | "body" | "resize";

export interface Hit {
  id: string;
  region: HitRegion;
}

export interface HitOptions {
  /** Escala atual: a alça tem tamanho fixo de tela. */
  k: number;
  detail: Detail;
  /** Nós que mostram a alça (selecionados e livres). */
  resizable: (node: CanvasNode) => boolean;
}

/**
 * Nó sob o ponto de mundo `p`: vence o de maior `z` e, no empate, o que vem depois na lista (o desenhado por cima). Longe
 * (detalhe que não é o completo), o nó inteiro vale como cabeçalho: não há cabeçalho visível para mirar.
 */
export function hitTest(nodes: readonly CanvasNode[], p: Vec, opts: HitOptions): Hit | undefined {
  let best: CanvasNode | undefined;
  for (const node of nodes) {
    if (p.x < node.x || p.x > node.x + node.w || p.y < node.y || p.y > node.y + node.h) continue;
    if (!best || node.z >= best.z) best = node;
  }
  if (!best) return undefined;
  const handle = SELECTION_LIMITS.handlePx / opts.k;
  if (opts.resizable(best) && p.x >= best.x + best.w - handle && p.y >= best.y + best.h - handle) return { id: best.id, region: "resize" };
  if (opts.detail !== "full" || p.y - best.y <= SELECTION_LIMITS.header) return { id: best.id, region: "header" };
  return { id: best.id, region: "body" };
}

// ---- seleção ----

/** O que um toque num nó faz agora e o que fica para soltar sem arrastar (para arrastar um grupo já selecionado). */
export interface Press {
  selection: Selection;
  /** Seleção a aplicar se o gesto terminar sem arrasto; `undefined` mantém a atual. */
  onClick: Selection | undefined;
}

export function pressNode(selection: Selection, id: string, additive: boolean): Press {
  const has = selection.includes(id);
  if (additive) return has ? { selection, onClick: selection.filter((s) => s !== id) } : { selection: [...selection, id], onClick: undefined };
  return has ? { selection, onClick: selection.length === 1 ? undefined : [id] } : { selection: [id], onClick: undefined };
}

/** Clique no vazio limpa; com Shift mantém (Shift só soma ou tira). */
export const pressEmpty = (selection: Selection, additive: boolean): Selection => (additive ? selection : []);

/** Espaço no nó focado: seleciona só ele; com Shift, alterna. */
export function keySelect(selection: Selection, id: string, additive: boolean): Selection {
  if (!additive) return [id];
  return selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id];
}

/** Retângulo de dois cantos quaisquer. */
export const rectFrom = (a: Vec, b: Vec): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

/** Retângulo de seleção: os nós que ele toca, na ordem do documento; com Shift, somados à seleção de partida. */
export function marqueeSelect(nodes: readonly CanvasNode[], rect: Rect, base: Selection, additive: boolean): Selection {
  const hit = nodes.filter((node) => intersects(node, rect)).map((node) => node.id);
  if (!additive) return hit;
  const seen = new Set(base);
  return [...base, ...hit.filter((id) => !seen.has(id))];
}

/** Tira da seleção o que não está mais no documento (depois de desfazer, apagar ou mesclar com o grafo). */
export function pruneSelection(selection: Selection, doc: CanvasDoc): Selection {
  const ids = new Set(doc.nodes.map((node) => node.id));
  const kept = selection.filter((id) => ids.has(id));
  return kept.length === selection.length ? selection : kept;
}

export const sameSelection = (a: Selection, b: Selection): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

// ---- mover ----

const indexOf = (doc: CanvasDoc): Map<string, CanvasNode> => new Map(doc.nodes.map((node) => [node.id, node]));

/**
 * Quem se move ao arrastar `grabbed`: a seleção inteira se ele estiver nela, senão só ele; nó `locked` fica. Pegar um nó
 * `locked` não move nada (lista vazia), mesmo com outros selecionados.
 */
export function movableIds(doc: CanvasDoc, selection: Selection, grabbed: string): string[] {
  const byId = indexOf(doc);
  const node = byId.get(grabbed);
  if (!node || node.locked) return [];
  const ids = selection.includes(grabbed) ? selection : [grabbed];
  return ids.filter((id) => {
    const n = byId.get(id);
    return n !== undefined && !n.locked;
  });
}

/** Desloca o delta para nenhum nó sair da faixa de coordenadas do documento (o servidor recusaria o PUT). */
function clampDelta(nodes: readonly CanvasNode[], dx: number, dy: number): Vec {
  const lim = CANVAS_LIMITS.coordinate;
  let x = dx;
  let y = dy;
  for (const n of nodes) {
    x = Math.min(lim - n.x, Math.max(-lim - n.x, x));
    y = Math.min(lim - n.y, Math.max(-lim - n.y, y));
  }
  return { x, y };
}

/**
 * Operação de soltar um arrasto: o nó `anchor` (o que o ponteiro pegou) encaixa na grade e os outros andam o mesmo delta
 * (mantêm as distâncias entre si). Um nó vira `move`; vários, um lote. `undefined` sem deslocamento ou sem nó móvel.
 */
export function moveOp(doc: CanvasDoc, ids: readonly string[], anchor: string, rawDx: number, rawDy: number, grid: number = SELECTION_LIMITS.grid): CanvasOp | undefined {
  if (!Number.isFinite(rawDx) || !Number.isFinite(rawDy)) throw new RangeError("deslocamento inválido");
  const byId = indexOf(doc);
  const moving = ids.map((id) => byId.get(id)).filter((n): n is CanvasNode => n !== undefined && !n.locked);
  const lead = byId.get(anchor);
  if (moving.length === 0 || !lead || lead.locked) return undefined;
  const delta = clampDelta(moving, snap(lead.x + rawDx, grid) - lead.x, snap(lead.y + rawDy, grid) - lead.y);
  if (delta.x === 0 && delta.y === 0) return undefined;
  return opMoveMany(doc, moving.map((n) => n.id), delta.x, delta.y);
}

// ---- redimensionar ----

const clampSide = (side: number): number => Math.min(CANVAS_LIMITS.size, Math.max(SELECTION_LIMITS.minSide, side));

/** Quadro ao vivo durante o arrasto da alça (canto inferior direito), sem encaixe; respeita o lado mínimo. */
export function resizePreview(node: CanvasNode, rawDw: number, rawDh: number): Rect {
  return { x: node.x, y: node.y, w: clampSide(node.w + rawDw), h: clampSide(node.h + rawDh) };
}

/** Operação de soltar a alça: a borda direita e a de baixo encaixam na grade. Nó `locked` recusa (`undefined`). */
export function resizeOp(doc: CanvasDoc, id: string, rawDw: number, rawDh: number, grid: number = SELECTION_LIMITS.grid): CanvasOp | undefined {
  if (!Number.isFinite(rawDw) || !Number.isFinite(rawDh)) throw new RangeError("deslocamento inválido");
  const node = indexOf(doc).get(id);
  if (!node || node.locked) return undefined;
  const w = clampSide(snap(node.x + node.w + rawDw, grid) - node.x);
  const h = clampSide(snap(node.y + node.h + rawDh, grid) - node.y);
  if (w === node.w && h === node.h) return undefined;
  return opResize(doc, id, { x: node.x, y: node.y, w, h });
}

// ---- teclado ----

const ARROWS: Readonly<Record<string, Vec>> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };

export const isArrowKey = (key: string): boolean => key in ARROWS;

/**
 * Seta com um nó focado: o equivalente de teclado ao arrasto. Anda uma grade (cinco com Shift) e encaixa; se o nó focado
 * está selecionado, a seleção inteira anda junto (um lote). Nó focado `locked` recusa (`undefined`).
 */
export function nudgeOp(doc: CanvasDoc, selection: Selection, focused: string, key: string, fast: boolean): CanvasOp | undefined {
  const dir = ARROWS[key];
  if (!dir) return undefined;
  const step = SELECTION_LIMITS.grid * (fast ? SELECTION_LIMITS.fastNudge : 1);
  return moveOp(doc, movableIds(doc, selection, focused), focused, dir.x * step, dir.y * step);
}

const byId = (a: CanvasNode, b: CanvasNode): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Ordem do Tab: ordem de leitura. Linhas de cima para baixo (um nó entra na linha se o centro dele cai dentro da altura do
 * primeiro nó da linha, para nós desalinhados por poucos pixels não pularem de linha) e, na linha, da esquerda para a
 * direita; desempate pelo id. Estável para o mesmo documento.
 */
export function tabOrder(nodes: readonly CanvasNode[]): string[] {
  const sorted = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x || byId(a, b));
  const rows: CanvasNode[][] = [];
  let leader: CanvasNode | undefined;
  for (const node of sorted) {
    const row = rows[rows.length - 1];
    if (row && leader && node.y + node.h / 2 <= leader.y + leader.h) row.push(node);
    else {
      rows.push([node]);
      leader = node;
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x || a.y - b.y || byId(a, b)).map((node) => node.id));
}

/** Próximo nó do Tab (ou anterior, com Shift); `undefined` nas pontas, para o foco sair do canvas. Sem foco: o primeiro (ou o último). */
export function nextInOrder(order: readonly string[], current: string | undefined, backward: boolean): string | undefined {
  if (order.length === 0) return undefined;
  const at = current === undefined ? -1 : order.indexOf(current);
  if (at < 0) return backward ? order[order.length - 1] : order[0];
  return order[backward ? at - 1 : at + 1];
}

/** Nome acessível do nó: o rótulo (do registro de tipos, ou tipo e id) e os estados que mudam o que dá para fazer com ele. */
export function nodeName(node: CanvasNode, label: string, selected: boolean): string {
  const parts = [label || `${node.type} ${node.id}`];
  if (selected) parts.push("selecionado");
  if (node.locked) parts.push("bloqueado");
  return parts.join(", ");
}
