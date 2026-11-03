// Minimapa do canvas do Argos: projeta os nós e o viewport num quadro pequeno e converte um clique (ou arrasto) no
// minimapa em câmera nova. Lógica pura e sem Node (roda no navegador pelo pacote do modelo); o componente só desenha.
import { type Camera, type Rect, type Vec, type Viewport, boundsOf, inflate, isCamera, visibleRect } from "./canvas-camera.ts";

export const MINIMAP_LIMITS = {
  /** Mais nós que isto não cabem num quadro legível; o teto acompanha o do documento (2000). */
  maxNodes: 2000,
  /** Margem interna do quadro, em pixels do minimapa. */
  padding: 6,
  /** Menor lado de um nó desenhado: nó pequeno demais sumiria no quadro. */
  minNodePx: 2,
  /** Folga do mundo ao redor do conteúdo, em fração do maior lado, para o viewport poder passar da borda. */
  worldMargin: 0.1,
} as const;

/** Projeção do mundo no quadro: `scale` pixels de minimapa por unidade de mundo; `world` é o retângulo que o quadro mostra. */
export interface MinimapProjection {
  size: Viewport;
  scale: number;
  /** Retângulo do mundo que o quadro cobre (conteúdo ∪ viewport, com folga). */
  world: Rect;
  /** Deslocamento em pixels que centraliza o mundo no quadro. */
  offset: Vec;
}

export interface MinimapView {
  projection: MinimapProjection;
  /** Um retângulo por nó de entrada, na mesma ordem, em pixels do minimapa. */
  nodes: Rect[];
  /** Viewport da tela no minimapa (pode passar da borda do quadro; o componente recorta). */
  viewport: Rect;
}

const positive = (n: number): boolean => Number.isFinite(n) && n > 0;
const validRect = (r: Rect): boolean => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w >= 0 && r.h >= 0;

/**
 * Projeção do canvas inteiro (todos os nós mais o que a tela mostra) no quadro `size`. Sem nós, o quadro mostra só o
 * viewport. Recusa (`RangeError`) tamanho ou câmera inválidos, nó malformado e mais de `MINIMAP_LIMITS.maxNodes` nós.
 */
export function projectMinimap(rects: readonly Rect[], cam: Camera, view: Viewport, size: Viewport): MinimapProjection {
  if (!positive(size.w) || !positive(size.h)) throw new RangeError("tamanho do minimapa inválido");
  if (!positive(view.w) || !positive(view.h)) throw new RangeError("viewport inválido");
  if (!isCamera(cam)) throw new RangeError("câmera inválida");
  if (rects.length > MINIMAP_LIMITS.maxNodes) throw new RangeError("nós demais para o minimapa");
  if (!rects.every(validRect)) throw new RangeError("nó inválido");
  const visible = visibleRect(cam, view);
  const content = boundsOf([...rects, visible]) as Rect;
  const margin = Math.max(content.w, content.h) * MINIMAP_LIMITS.worldMargin;
  const world = inflate(content, margin);
  const pad = MINIMAP_LIMITS.padding;
  const availW = Math.max(1, size.w - 2 * pad);
  const availH = Math.max(1, size.h - 2 * pad);
  const scale = Math.min(availW / Math.max(world.w, 1), availH / Math.max(world.h, 1));
  return {
    size,
    scale,
    world,
    offset: { x: (size.w - world.w * scale) / 2, y: (size.h - world.h * scale) / 2 },
  };
}

export const worldToMinimap = (p: MinimapProjection, point: Vec): Vec => ({
  x: (point.x - p.world.x) * p.scale + p.offset.x,
  y: (point.y - p.world.y) * p.scale + p.offset.y,
});

export const minimapToWorld = (p: MinimapProjection, point: Vec): Vec => ({
  x: (point.x - p.offset.x) / p.scale + p.world.x,
  y: (point.y - p.offset.y) / p.scale + p.world.y,
});

function rectToMinimap(p: MinimapProjection, r: Rect, minPx: number): Rect {
  const o = worldToMinimap(p, r);
  return { x: o.x, y: o.y, w: Math.max(minPx, r.w * p.scale), h: Math.max(minPx, r.h * p.scale) };
}

/** Quadro do minimapa pronto para desenhar: nós e viewport já em pixels do minimapa. */
export function minimapView(rects: readonly Rect[], cam: Camera, view: Viewport, size: Viewport): MinimapView {
  const projection = projectMinimap(rects, cam, view, size);
  const vis = visibleRect(cam, view);
  return {
    projection,
    nodes: rects.map((r) => rectToMinimap(projection, r, MINIMAP_LIMITS.minNodePx)),
    viewport: rectToMinimap(projection, vis, 0),
  };
}

/**
 * Câmera para um clique (ou arrasto) em `point`, em pixels do minimapa: centraliza o viewport no ponto do mundo clicado e
 * mantém o zoom. Ponto fora do quadro é levado à borda; ponto não finito é recusado (`RangeError`).
 */
export function minimapCamera(p: MinimapProjection, point: Vec, cam: Camera, view: Viewport): Camera {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError("ponto inválido");
  const inside = { x: Math.min(p.size.w, Math.max(0, point.x)), y: Math.min(p.size.h, Math.max(0, point.y)) };
  const world = minimapToWorld(p, inside);
  return { x: world.x - view.w / 2 / cam.k, y: world.y - view.h / 2 / cam.k, k: cam.k };
}
