// Espaço livre no canvas: onde um nó novo cabe sem cair em cima de outro nó nem de uma área (reference/argos.md §Layout).
// Quem cria nó por conta própria (recrutar, trazer terminal, nota nova, sincronia de agentes) tenta primeiro a vaga da grade
// dele e, se ela está ocupada, pede aqui a vaga livre mais perto do orquestrador. Lógica pura e determinística, sem Node.
import { AREA_HEADER, AREA_LIMITS, isAreaNode } from "./canvas-areas.ts";
import type { CanvasDoc, CanvasNode } from "./canvas-doc.ts";
import { LAYOUT_GAP, Occupancy } from "./canvas-layout.ts";

export interface Box { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }

/** Colunas e fileiras de cada lado do orquestrador que a busca varre antes de cair para "abaixo de todo o conteúdo". */
export const SPACE_SEARCH_RINGS = 12;

export interface FreeBoxOptions {
  /** O nó em volta do qual se procura (o orquestrador). */
  anchor: Box;
  /** Lado preferido: recrutas abaixo, notas acima. */
  prefer: "below" | "above";
  /** Espaço entre colunas e entre o âncora e a primeira fileira (o `RECRUIT_LAYOUT` do chamador). */
  gap: { x: number; y: number };
  /** Vagas que o chamador prefere, tentadas na ordem antes da busca. */
  candidates?: readonly Point[];
  /** Caixas já tomadas que ainda não estão no documento (nós criados na mesma passada). */
  extra?: readonly Box[];
  /** Nós do documento que não contam como ocupados (os que o chamador vai mover). */
  ignore?: ReadonlySet<string>;
}

const contains = (outer: Box, point: Point): boolean => point.x >= outer.x && point.x <= outer.x + outer.w && point.y >= outer.y && point.y <= outer.y + outer.h;

/** A menor área que contém o centro do âncora: onde o orquestrador mora, e onde a equipe dele deve ficar. */
function containerOf(doc: CanvasDoc, anchor: Box, ignore: ReadonlySet<string>): CanvasNode | undefined {
  const center = { x: anchor.x + anchor.w / 2, y: anchor.y + anchor.h / 2 };
  let best: CanvasNode | undefined;
  for (const node of doc.nodes) {
    if (!isAreaNode(node) || ignore.has(node.id) || !contains(node, center)) continue;
    if (!best || node.w * node.h <= best.w * best.h) best = node;
  }
  return best;
}

/** A parte da área onde um nó pode ficar: por baixo do título e com folga nas bordas. */
function interiorOf(area: Box): Box {
  const pad = AREA_LIMITS.padding;
  return { x: area.x + pad, y: area.y + AREA_HEADER + pad, w: area.w - 2 * pad, h: area.h - AREA_HEADER - 2 * pad };
}

const insideOf = (outer: Box, box: Box): boolean => box.x >= outer.x && box.y >= outer.y && box.x + box.w <= outer.x + outer.w && box.y + box.h <= outer.y + outer.h;

/** Posições em torno do âncora, da mais perto à mais longe (o lado preferido ganha no empate): colunas `i`, fileiras `j`. */
function aroundAnchor(size: { w: number; h: number }, { anchor, prefer, gap }: FreeBoxOptions): Point[] {
  const stepX = size.w + gap.x;
  const stepY = size.h + gap.y;
  const sign = prefer === "below" ? 1 : -1;
  const cells: { point: Point; cost: number; i: number; j: number }[] = [];
  for (let j = -SPACE_SEARCH_RINGS; j <= SPACE_SEARCH_RINGS; j++) {
    for (let i = -SPACE_SEARCH_RINGS; i <= SPACE_SEARCH_RINGS; i++) {
      if (j === 0 && i === 0) continue;
      const x = Math.round(anchor.x + anchor.w / 2 - size.w / 2 + i * stepX);
      const y = j === 0 ? anchor.y : j > 0 ? anchor.y + anchor.h + gap.y + (j - 1) * stepY : anchor.y - gap.y - size.h - (-j - 1) * stepY;
      const dx = i * stepX;
      const dy = j === 0 ? 0 : (j > 0 ? 1 : -1) * (Math.abs(j) - 0.5) * stepY;
      const wrongSide = j !== 0 && Math.sign(j) !== sign ? stepY * stepY : 0;
      cells.push({ point: { x, y: Math.round(y) }, cost: dx * dx + dy * dy + wrongSide, i, j });
    }
  }
  return cells.sort((a, b) => a.cost - b.cost || a.j * sign - b.j * sign || a.i - b.i).map((cell) => cell.point);
}

/**
 * A primeira posição de um nó do tamanho `size` que não encosta (com a folga do layout) em nenhum nó do documento, nem em
 * `extra`, e não se mete numa área alheia. Ordem: as vagas de `candidates`, depois a busca em volta do âncora. Se o âncora
 * está dentro de uma área, a equipe fica dentro dela (por baixo do título) e só sai se a área estiver cheia; fora de área,
 * nenhuma vaga invade área. Sem vaga na vizinhança, a faixa abaixo de todo o conteúdo, alinhada ao âncora.
 */
export function findFreeBox(doc: CanvasDoc, size: { w: number; h: number }, options: FreeBoxOptions): Point {
  const ignore = options.ignore ?? new Set<string>();
  const solid = doc.nodes.filter((node) => !ignore.has(node.id));
  const extra = options.extra ?? [];
  const container = containerOf(doc, options.anchor, ignore);

  const occupancy = (skipArea: string | undefined): Occupancy => {
    const index = new Occupancy();
    for (const node of solid) if (node.id !== skipArea) index.add(node);
    for (const box of extra) index.add(box);
    return index;
  };
  const search = [...(options.candidates ?? []), ...aroundAnchor(size, options)];
  const firstFree = (index: Occupancy, within: Box | undefined): Point | undefined =>
    search.find((point) => {
      const box = { x: point.x, y: point.y, w: size.w, h: size.h };
      return (within === undefined || insideOf(within, box)) && !index.hits(box, LAYOUT_GAP);
    });

  if (container !== undefined) {
    const inside = firstFree(occupancy(container.id), interiorOf(container));
    if (inside) return inside;
  }
  const all = occupancy(undefined);
  const outside = firstFree(all, undefined);
  if (outside) return outside;
  return { x: Math.round(options.anchor.x + options.anchor.w / 2 - size.w / 2), y: Math.round(all.empty ? 0 : all.maxY + LAYOUT_GAP) };
}
