// Câmera do canvas do Argos: pan e zoom em coordenadas de mundo, recorte pelo viewport e nível de detalhe por zoom.
// Lógica pura e sem Node (roda no navegador pelo pacote de /ui/lib/canvas-model.js); o componente só liga os eventos.
import type { CommandDef } from "./canvas-commands.ts";

/** `x`/`y` é o ponto do mundo no canto superior esquerdo da tela; `k` é a escala (pixels de tela por unidade de mundo). */
export interface Camera {
  x: number;
  y: number;
  k: number;
}

export interface Vec {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  w: number;
  h: number;
}

export const CAMERA_LIMITS = {
  /** Mais longe que isto 1000 nós viram um borrão sem leitura; mais perto que isto o texto já passa da tela. */
  zoomMin: 0.05,
  zoomMax: 4,
  /** Folga, em pixels de tela, ao enquadrar um retângulo ou todos os nós. */
  fitPadding: 48,
  /** Passo das teclas `+`/`-` e de um clique de roda (uma linha). */
  keyZoomStep: 1.25,
  /** Pan das setas sem nó focado, em pixels de tela. */
  keyPanStep: 64,
  /** Duração da animação de câmera (enquadrar, revelar nó focado); `prefers-reduced-motion` zera. */
  animationMs: 220,
  /** Ao focar um nó ou a seleção, o zoom não passa disto: um nó sozinho em 4× vira uma tela sem contexto dos vizinhos. */
  focusZoomMax: 1.5,
} as const;

/** Sensibilidade da roda: fator = exp(-deltaY em pixels × isto). 100 px (um entalhe comum) ≈ 1.16×. */
const WHEEL_SENSITIVITY = 0.0015;
/** `WheelEvent.deltaMode`: 0 pixel, 1 linha, 2 página (DOM Level 3 Events, WheelEvent). */
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 800;

export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, k: 1 };

const finite = (n: number): boolean => Number.isFinite(n);

export const isCamera = (cam: Camera): boolean => finite(cam.x) && finite(cam.y) && finite(cam.k) && cam.k > 0;

export function clampZoom(k: number): number {
  if (!finite(k) || k <= 0) throw new RangeError("zoom inválido");
  return Math.min(CAMERA_LIMITS.zoomMax, Math.max(CAMERA_LIMITS.zoomMin, k));
}

export const screenToWorld = (cam: Camera, p: Vec): Vec => ({ x: p.x / cam.k + cam.x, y: p.y / cam.k + cam.y });

export const worldToScreen = (cam: Camera, p: Vec): Vec => ({ x: (p.x - cam.x) * cam.k, y: (p.y - cam.y) * cam.k });

/** Arrasto de tela de (dx, dy) pixels: o mundo acompanha o dedo. */
export const panBy = (cam: Camera, dx: number, dy: number): Camera => ({ x: cam.x - dx / cam.k, y: cam.y - dy / cam.k, k: cam.k });

/** Zoom para a escala `k` (limitada) com o ponto de tela `anchor` parado sob o cursor ou a pinça. */
export function zoomTo(cam: Camera, anchor: Vec, k: number): Camera {
  const next = clampZoom(k);
  const world = screenToWorld(cam, anchor);
  return { x: world.x - anchor.x / next, y: world.y - anchor.y / next, k: next };
}

export const zoomAt = (cam: Camera, anchor: Vec, factor: number): Camera => zoomTo(cam, anchor, cam.k * factor);

/** Fator de zoom de um evento de roda (`deltaY` positivo afasta). */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaMode === 2 ? deltaY * WHEEL_PAGE_PX : deltaY;
  return Math.exp(-px * WHEEL_SENSITIVITY);
}

export interface PinchStart {
  cam: Camera;
  a: Vec;
  b: Vec;
}

/**
 * Pinça com dois dedos: a escala segue a razão das distâncias e o ponto do mundo que estava sob o meio dos dedos no início
 * fica sob o meio atual (o gesto também arrasta).
 */
export function pinchCamera(start: PinchStart, a: Vec, b: Vec): Camera {
  const d0 = Math.hypot(start.b.x - start.a.x, start.b.y - start.a.y);
  const d1 = Math.hypot(b.x - a.x, b.y - a.y);
  const k = d0 > 0 && d1 > 0 ? clampZoom(start.cam.k * (d1 / d0)) : start.cam.k;
  const world = screenToWorld(start.cam, { x: (start.a.x + start.b.x) / 2, y: (start.a.y + start.b.y) / 2 });
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return { x: world.x - mid.x / k, y: world.y - mid.y / k, k };
}

/** Retângulo do mundo que a tela mostra. */
export const visibleRect = (cam: Camera, view: Viewport): Rect => ({ x: cam.x, y: cam.y, w: view.w / cam.k, h: view.h / cam.k });

export const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const containsPoint = (r: Rect, p: Vec): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

export const inflate = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });

/** Menor retângulo que contém todos; `undefined` sem itens. */
export function boundsOf(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Câmera que mostra `rect` inteiro e centralizado, com folga; o zoom respeita os limites (retângulo enorme pode sobrar). */
export function fitRect(rect: Rect, view: Viewport, padding: number = CAMERA_LIMITS.fitPadding): Camera {
  const availW = Math.max(1, view.w - 2 * padding);
  const availH = Math.max(1, view.h - 2 * padding);
  const k = clampZoom(Math.min(availW / Math.max(rect.w, 1), availH / Math.max(rect.h, 1)));
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return { x: cx - view.w / 2 / k, y: cy - view.h / 2 / k, k };
}

/** Enquadra todos os nós; sem nós, volta à câmera padrão. */
export function fitAll(rects: readonly Rect[], view: Viewport, padding: number = CAMERA_LIMITS.fitPadding): Camera {
  const bounds = boundsOf(rects);
  return bounds ? fitRect(bounds, view, padding) : { ...DEFAULT_CAMERA };
}

/** Menor pan que traz `rect` para dentro da tela (com folga); se já está visível, devolve a mesma câmera. */
export function revealRect(cam: Camera, rect: Rect, view: Viewport, padding: number = CAMERA_LIMITS.fitPadding): Camera {
  const pad = padding / cam.k;
  const vis = visibleRect(cam, view);
  let x = cam.x;
  let y = cam.y;
  if (rect.w + 2 * pad > vis.w) x = rect.x + rect.w / 2 - vis.w / 2;
  else if (rect.x - pad < vis.x) x = rect.x - pad;
  else if (rect.x + rect.w + pad > vis.x + vis.w) x = rect.x + rect.w + pad - vis.w;
  if (rect.h + 2 * pad > vis.h) y = rect.y + rect.h / 2 - vis.h / 2;
  else if (rect.y - pad < vis.y) y = rect.y - pad;
  else if (rect.y + rect.h + pad > vis.y + vis.h) y = rect.y + rect.h + pad - vis.h;
  return x === cam.x && y === cam.y ? cam : { x, y, k: cam.k };
}

/** Quadro intermediário de uma animação de câmera (`t` de 0 a 1, com saída suave); o zoom anda em escala logarítmica. */
export function interpolateCamera(from: Camera, to: Camera, t: number, view: Viewport): Camera {
  if (t >= 1) return to;
  if (t <= 0) return from;
  const e = 1 - (1 - t) ** 3;
  const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
  // interpola o centro da tela, não o canto: com o canto, o zoom "escorrega" para o lado no meio da animação
  const c0 = { x: from.x + view.w / 2 / from.k, y: from.y + view.h / 2 / from.k };
  const c1 = { x: to.x + view.w / 2 / to.k, y: to.y + view.h / 2 / to.k };
  const cx = c0.x + (c1.x - c0.x) * e;
  const cy = c0.y + (c1.y - c0.y) * e;
  return { x: cx - view.w / 2 / k, y: cy - view.h / 2 / k, k };
}

/** Ação de câmera de uma tecla (com o canvas focado); `undefined` se a tecla não é de câmera. */
export type CameraKey = { kind: "zoom"; factor: number } | { kind: "fit" } | { kind: "pan"; dx: number; dy: number };

export function cameraKey(key: string): CameraKey | undefined {
  const step = CAMERA_LIMITS.keyPanStep;
  switch (key) {
    case "+":
    case "=":
      return { kind: "zoom", factor: CAMERA_LIMITS.keyZoomStep };
    case "-":
    case "_":
      return { kind: "zoom", factor: 1 / CAMERA_LIMITS.keyZoomStep };
    case "0":
      return { kind: "fit" };
    case "ArrowLeft":
      return { kind: "pan", dx: step, dy: 0 };
    case "ArrowRight":
      return { kind: "pan", dx: -step, dy: 0 };
    case "ArrowUp":
      return { kind: "pan", dx: 0, dy: step };
    case "ArrowDown":
      return { kind: "pan", dx: 0, dy: -step };
    default:
      return undefined;
  }
}

/** Sensibilidade da pinça do trackpad (o navegador a entrega como roda com Ctrl e deltas pequenos). */
const PINCH_SENSITIVITY = 0.01;
/** Roda com Ctrl: abaixo disto em pixels, ou fracionária, é pinça; um entalhe de mouse vem em passos inteiros de 100 ou mais. */
const PINCH_DELTA_MAX = 50;
/** Roda de mouse sem modificador: passo inteiro com este mínimo em pixels (ou em linha/página), sem componente horizontal. */
const NOTCH_DELTA_MIN = 50;

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  altKey: boolean;
}

/** O que um evento de roda faz: arrastar o mundo (`dx`/`dy` em pixels de tela, como `panBy`) ou mudar a escala. */
export type WheelIntent = { kind: "pan"; dx: number; dy: number } | { kind: "zoom"; factor: number };

const wheelPixels = (delta: number, mode: number): number => (mode === 1 ? delta * WHEEL_LINE_PX : mode === 2 ? delta * WHEEL_PAGE_PX : delta);

/**
 * Classifica a roda: Ctrl (pinça do trackpad ou Ctrl+roda) e Alt+roda dão zoom; roda de mouse sem modificador dá zoom;
 * o resto (dois dedos no trackpad: pixels, em geral fracionários e com componente horizontal) arrasta. Não há como separar
 * trackpad de mouse com certeza pelo evento: o critério é o passo do entalhe, e Alt+roda força o zoom em qualquer aparelho.
 */
export function wheelIntent(e: WheelInput): WheelIntent {
  const dy = wheelPixels(e.deltaY, e.deltaMode);
  const dx = wheelPixels(e.deltaX, e.deltaMode);
  if (e.ctrlKey) {
    const pinch = e.deltaMode === 0 && (!Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < PINCH_DELTA_MAX);
    return { kind: "zoom", factor: Math.exp(-dy * (pinch ? PINCH_SENSITIVITY : WHEEL_SENSITIVITY)) };
  }
  // com Alt alguns sistemas trocam o eixo da roda: vale o que tiver valor
  if (e.altKey) return { kind: "zoom", factor: Math.exp(-(dy || dx) * WHEEL_SENSITIVITY) };
  const notch = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= NOTCH_DELTA_MIN);
  if (notch) return { kind: "zoom", factor: Math.exp(-dy * WHEEL_SENSITIVITY) };
  return { kind: "pan", dx: -dx, dy: -dy };
}

/** Câmera depois de um evento de roda; o zoom fica ancorado em `anchor` (o cursor). */
export function wheelCamera(cam: Camera, e: WheelInput, anchor: Vec): Camera {
  const intent = wheelIntent(e);
  return intent.kind === "zoom" ? zoomAt(cam, anchor, intent.factor) : panBy(cam, intent.dx, intent.dy);
}

/**
 * Elemento que rola (campo de texto, lista dentro de um nó) tem para onde ir na direção de `delta`? Se tem, a roda é dele;
 * no fim do curso a roda volta para o canvas. `pos` é o scrollTop/scrollLeft, `client` o tamanho visível e `extent` o total.
 */
export function hasScrollRoom(pos: number, client: number, extent: number, delta: number): boolean {
  if (extent <= client) return false;
  return delta < 0 ? pos > 0 : delta > 0 ? pos + client < extent - 1 : false;
}

/** Atalho com Ctrl/Cmd que mexe na câmera com o canvas focado (o navegador usaria o zoom da página): `=`/`+`, `-`, `0` (100%). */
export type CameraChord = { kind: "zoom"; factor: number } | { kind: "reset" };

export function cameraChord(key: string): CameraChord | undefined {
  switch (key) {
    case "+":
    case "=":
      return { kind: "zoom", factor: CAMERA_LIMITS.keyZoomStep };
    case "-":
    case "_":
      return { kind: "zoom", factor: 1 / CAMERA_LIMITS.keyZoomStep };
    case "0":
      return { kind: "reset" };
    default:
      return undefined;
  }
}

const centerOf = (view: Viewport): Vec => ({ x: view.w / 2, y: view.h / 2 });

/** Aproxima ou afasta um passo (`direction` 1 ou -1) em torno do centro da tela. */
export const zoomStep = (cam: Camera, view: Viewport, direction: 1 | -1): Camera =>
  zoomAt(cam, centerOf(view), direction === 1 ? CAMERA_LIMITS.keyZoomStep : 1 / CAMERA_LIMITS.keyZoomStep);

/** Escala 1 (100%) em torno do centro da tela. */
export const zoomReset = (cam: Camera, view: Viewport): Camera => zoomTo(cam, centerOf(view), 1);

/** Câmera com o centro do retângulo no centro da tela, escala `k` (limitada). */
function centeredOn(rect: Rect, view: Viewport, k: number): Camera {
  const scale = clampZoom(k);
  return { x: rect.x + rect.w / 2 - view.w / 2 / scale, y: rect.y + rect.h / 2 - view.h / 2 / scale, k: scale };
}

/**
 * Focar um nó: centraliza e garante o nível de detalhe completo. Não afasta quem já está perto (a escala só sobe até o
 * nó caber na tela com folga); nó maior que a tela vira enquadrar.
 */
export function focusNodeCamera(cam: Camera, node: Rect, view: Viewport, padding: number = CAMERA_LIMITS.fitPadding): Camera {
  const fits = fitRect(node, view, padding).k;
  return centeredOn(node, view, Math.min(Math.max(cam.k, DETAIL_THRESHOLDS.full), fits));
}

/**
 * Zoom na seleção: enquadra a caixa de todos os selecionados, com o zoom limitado a `focusZoomMax` (um nó sozinho não
 * enche a tela). Sem seleção devolve `undefined`: quem chama decide se cai em enquadrar tudo.
 */
export function fitSelectionCamera(rects: readonly Rect[], view: Viewport, padding: number = CAMERA_LIMITS.fitPadding): Camera | undefined {
  const bounds = boundsOf(rects);
  if (!bounds) return undefined;
  const fit = fitRect(bounds, view, padding);
  return fit.k > CAMERA_LIMITS.focusZoomMax ? centeredOn(bounds, view, CAMERA_LIMITS.focusZoomMax) : fit;
}

/** Nível de zoom para a tela: `0.5` → `50%`. */
export const zoomLabel = (k: number): string => `${Math.round(k * 100)}%`;

/** Há para onde aproximar ou afastar? (os botões desligam no limite) */
export const canZoom = (k: number, direction: 1 | -1): boolean =>
  direction === 1 ? k < CAMERA_LIMITS.zoomMax - 1e-9 : k > CAMERA_LIMITS.zoomMin + 1e-9;

/** O que os comandos de câmera pedem à página; quem os liga ao motor está em `canvas-controls.tsx`. */
export interface CameraHandlers {
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  fitSelection(): void;
  focusNode(): void;
}

/** O que as condições e os rótulos dos comandos de câmera leem do contexto da página (a página tem mais campos). */
export interface CameraCommandCtx {
  selectedLabel: string | null;
  handlers: CameraHandlers;
}

const GROUP_CAMERA = "Vista";
const LABEL_NAME_MAX = 60;
export const CAMERA_COMMAND_IDS = ["zoom-in", "zoom-out", "zoom-reset", "zoom-selection", "focus-node"] as const;

/**
 * Comandos de câmera para o registro de comandos (paleta, menu do fundo, ajuda `?`): o mesmo que os botões do canvas.
 * Os de zoom têm acorde com `mod` e `inEditable: false` (com o foco num campo de texto, o zoom é do navegador).
 */
export function cameraCommandDefs<Ctx extends CameraCommandCtx>(): CommandDef<Ctx>[] {
  const name = (ctx: Ctx): string => (ctx.selectedLabel && ctx.selectedLabel.length > LABEL_NAME_MAX ? `${ctx.selectedLabel.slice(0, LABEL_NAME_MAX - 1)}…` : (ctx.selectedLabel ?? ""));
  const hasSelection = (ctx: Ctx): boolean => ctx.selectedLabel !== null;
  return [
    { id: "zoom-in", label: "Aproximar", group: GROUP_CAMERA, shortcut: ["mod+=", "mod++"], surfaces: ["palette", "canvas-menu"], inEditable: false, run: (ctx) => ctx.handlers.zoomIn() },
    { id: "zoom-out", label: "Afastar", group: GROUP_CAMERA, shortcut: "mod+-", surfaces: ["palette", "canvas-menu"], inEditable: false, run: (ctx) => ctx.handlers.zoomOut() },
    { id: "zoom-reset", label: "Zoom 100%", hint: "tamanho real", group: GROUP_CAMERA, shortcut: "mod+0", surfaces: ["palette", "canvas-menu"], inEditable: false, run: (ctx) => ctx.handlers.zoomReset() },
    { id: "zoom-selection", label: "Zoom na seleção", hint: "enquadra os selecionados", group: GROUP_CAMERA, shortcut: "z", surfaces: ["palette", "canvas-menu"], when: hasSelection, run: (ctx) => ctx.handlers.fitSelection() },
    { id: "focus-node", label: (ctx) => (hasSelection(ctx) ? `Focar em ${name(ctx)}` : "Focar no nó selecionado"), hint: "centraliza com o detalhe completo", group: GROUP_CAMERA, shortcut: "c", surfaces: ["palette", "canvas-menu"], when: hasSelection, run: (ctx) => ctx.handlers.focusNode() },
  ];
}

/** Nível de detalhe: longe, o nó é só um bloco de cor; no meio, bloco com rótulo curto; perto, o nó completo. */
export type Detail = "dot" | "block" | "full";

/** Escalas em que o nível muda: abaixo de 0.25 um nó de 200 px tem 50 px de tela e o rótulo não cabe legível. */
export const DETAIL_THRESHOLDS = { block: 0.25, full: 0.6 } as const;

/** Escala mínima da abertura: a em que o nó aparece completo (`reference/argos.md` §A página). */
export const OPENING_MIN_SCALE = DETAIL_THRESHOLDS.full;

/**
 * Câmera de abertura: tudo à vista se couber legível; senão, o piso de escala começando pelo canto superior esquerdo do
 * conteúdo (centrado se couber na largura). `undefined` sem nó ou sem área. Regra única da abertura: a página (`firstCamera`) e o
 * enquadramento inicial do motor usam esta.
 */
export function openingCamera(nodes: readonly Rect[], view: Viewport): Camera | undefined {
  const bounds = boundsOf(nodes);
  if (!bounds || view.w <= 0 || view.h <= 0) return undefined;
  const all = fitAll(nodes, view);
  if (all.k >= OPENING_MIN_SCALE) return all;
  const k = OPENING_MIN_SCALE;
  const pad = CAMERA_LIMITS.fitPadding;
  const fitsWidth = bounds.w * k + 2 * pad <= view.w;
  return { k, x: fitsWidth ? bounds.x + bounds.w / 2 - view.w / (2 * k) : bounds.x - pad / k, y: bounds.y - pad / k };
}

/**
 * Escalas que o dono pode escolher para o nó aparecer completo (conteúdo de terminal, nota e o resto), a padrão primeiro.
 * Uma só para todos os tipos; abaixo de 0.2 a camada HTML montaria nós demais para o que ainda se lê.
 */
export const FULL_DETAIL_CHOICES = [DETAIL_THRESHOLDS.full, 0.45, 0.3, 0.2] as const;

/** Escala lida do armazenamento: só as de `FULL_DETAIL_CHOICES`; o resto volta à padrão. */
export function fullDetailScale(raw: unknown): number {
  return (FULL_DETAIL_CHOICES as readonly number[]).includes(raw as number) ? (raw as number) : DETAIL_THRESHOLDS.full;
}

/** `full`: escala em que o nó aparece completo (padrão 0.6); o bloco nunca começa depois dela. */
export function detailFor(k: number, full: number = DETAIL_THRESHOLDS.full): Detail {
  if (k < Math.min(DETAIL_THRESHOLDS.block, full)) return "dot";
  if (k < full) return "block";
  return "full";
}

/**
 * Itens cujo retângulo cruza `view` (recorte por viewport), na ordem de entrada. Linear de propósito: 2000 nós (o teto do
 * documento) custam bem menos de 1 ms por quadro; índice espacial só se a medição pedir.
 */
export function cullRects<T extends Rect>(items: readonly T[], view: Rect): T[] {
  const out: T[] = [];
  for (const item of items) if (intersects(item, view)) out.push(item);
  return out;
}

/** Recorte de arestas pelo retângulo que envolve as duas pontas (a reta entre os centros nunca sai dele). */
export function cullSegments<T>(segments: readonly T[], ends: (s: T) => readonly [Vec, Vec] | undefined, view: Rect): T[] {
  const out: T[] = [];
  for (const segment of segments) {
    const pair = ends(segment);
    if (!pair) continue;
    const [a, b] = pair;
    const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    // reta horizontal ou vertical tem caixa de largura zero: o `<` estrito do intersects a perderia
    if (intersects(inflate(box, 0.5), view)) out.push(segment);
  }
  return out;
}

/** Rótulo cortado para caber em `px` pixels de tela, com fonte de `fontPx` (estimativa sem medir texto: rápida por quadro). */
export function shortLabel(label: string, px: number, fontPx: number): string {
  const max = Math.floor(px / (fontPx * 0.6));
  if (max <= 0) return "";
  const chars = Array.from(label);
  if (chars.length <= max) return label;
  return max === 1 ? "…" : `${chars.slice(0, max - 1).join("")}…`;
}
