// Encaixe magnético do arrasto (reference/argos.md §Organização): enquanto o dono arrasta, o quadro puxado gruda nas
// paredes e nos centros dos vizinhos e nos vãos iguais, dentro de um limiar em pixels de TELA (o mundo é o do documento,
// então o limiar vira `px / zoom`). Devolve o ajuste e as guias a desenhar. Puro, sem Node e sem DOM; custo linear nos
// vizinhos (uma passada por eixo, mais uma para achar o segundo vizinho do vão).
import type { CanvasDoc } from "./canvas-doc.ts";
import { type CanvasOp, type Frame, opMoveMany } from "./canvas-history.ts";
import { finiteOrFail, orgFail, ORG_ERRORS, pickNodes } from "./canvas-groups.ts";

/** Distância, em pixels de tela, a partir da qual o quadro deixa de ser puxado. */
export const SNAP_THRESHOLD_PX = 6;
/** Diferença que ainda conta como "no mesmo lugar" ao decidir quais guias acendem (erro de ponto flutuante). */
const SAME_PLACE = 1e-6;

export type SnapAxis = "x" | "y";

/** Linha de alinhamento: `axis: "x"` é uma linha vertical em `x = at`, com extensão de `from` a `to` em y (e vice-versa). */
export interface LineGuide {
  kind: "edge" | "center";
  axis: SnapAxis;
  at: number;
  from: number;
  to: number;
}

/** Um vão igual: `from`→`to` medido no eixo `axis`, desenhado na coordenada `cross` do outro eixo. */
export interface GapSegment {
  from: number;
  to: number;
  cross: number;
}

export interface GapGuide {
  kind: "gap";
  axis: SnapAxis;
  segments: GapSegment[];
}

export type SnapGuide = LineGuide | GapGuide;

export interface SnapOptions {
  /** Zoom da câmera (tela por unidade do mundo); converte o limiar de pixels para o mundo. */
  zoom: number;
  /** Padrão `SNAP_THRESHOLD_PX`. */
  thresholdPx?: number;
}

export interface SnapResult {
  /** O que somar ao quadro proposto; `0` no eixo em que nada está perto. */
  dx: number;
  dy: number;
  /** O quadro proposto já com o ajuste. */
  frame: Frame;
  guides: SnapGuide[];
}

const lo = (frame: Frame, axis: SnapAxis): number => (axis === "x" ? frame.x : frame.y);
const length = (frame: Frame, axis: SnapAxis): number => (axis === "x" ? frame.w : frame.h);
const hi = (frame: Frame, axis: SnapAxis): number => lo(frame, axis) + length(frame, axis);
const mid = (frame: Frame, axis: SnapAxis): number => lo(frame, axis) + length(frame, axis) / 2;
const crossOf = (axis: SnapAxis): SnapAxis => (axis === "x" ? "y" : "x");
const overlapsOnCross = (a: Frame, b: Frame, axis: SnapAxis): boolean => {
  const cross = crossOf(axis);
  return lo(a, cross) < hi(b, cross) && lo(b, cross) < hi(a, cross);
};

/** Segmento do vão; `of` é o quadro cujo meio no eixo cruzado dá a altura (ou largura) em que se desenha; sem `of`, o quadro puxado. */
interface PlannedSegment {
  from: number;
  to: number;
  of: Frame | undefined;
}

interface Candidate {
  delta: number;
  gap: PlannedSegment[] | undefined;
}

const better = (delta: number, best: Candidate | undefined, limit: number): boolean =>
  Math.abs(delta) <= limit && (best === undefined || Math.abs(delta) < Math.abs(best.delta));

/** Paredes e centros: lado com lado (inclusive o oposto, que cola um quadro no outro) e centro com centro. */
function edgeCandidate(moving: Frame, others: readonly Frame[], axis: SnapAxis, limit: number): Candidate | undefined {
  let best: Candidate | undefined;
  const mine = [lo(moving, axis), hi(moving, axis)];
  for (const other of others) {
    const theirs = [lo(other, axis), hi(other, axis)];
    const deltas = [mid(other, axis) - mid(moving, axis), ...mine.flatMap((own) => theirs.map((wall) => wall - own))];
    for (const delta of deltas) if (better(delta, best, limit)) best = { delta, gap: undefined };
  }
  return best;
}

/** O vizinho mais perto de cada lado que se sobrepõe ao quadro no eixo cruzado; `before` é o de baixo (esquerda/em cima). */
function nearestSides(moving: Frame, others: readonly Frame[], axis: SnapAxis): { before: Frame | undefined; after: Frame | undefined } {
  let before: Frame | undefined;
  let after: Frame | undefined;
  for (const other of others) {
    if (!overlapsOnCross(moving, other, axis)) continue;
    if (mid(other, axis) < mid(moving, axis) && (!before || hi(other, axis) > hi(before, axis))) before = other;
    if (mid(other, axis) > mid(moving, axis) && (!after || lo(other, axis) < lo(after, axis))) after = other;
  }
  return { before, after };
}

/** O vizinho que vem logo antes (ou depois) de `anchor`, sem encostar nele, na mesma faixa cruzada. */
function neighborBeyond(anchor: Frame, others: readonly Frame[], axis: SnapAxis, side: "before" | "after"): Frame | undefined {
  let found: Frame | undefined;
  for (const other of others) {
    if (!overlapsOnCross(anchor, other, axis)) continue;
    if (side === "before" && hi(other, axis) <= lo(anchor, axis) && (!found || hi(other, axis) > hi(found, axis))) found = other;
    if (side === "after" && lo(other, axis) >= hi(anchor, axis) && (!found || lo(other, axis) < lo(found, axis))) found = other;
  }
  return found;
}

/** Vãos iguais: no meio de dois vizinhos, ou repetindo o vão que dois vizinhos já têm entre si. */
function gapCandidate(moving: Frame, others: readonly Frame[], axis: SnapAxis, limit: number): Candidate | undefined {
  const { before, after } = nearestSides(moving, others, axis);
  const size = length(moving, axis);
  const start = lo(moving, axis);
  let best: Candidate | undefined;
  const offer = (target: number, gap: PlannedSegment[]): void => {
    const delta = target - start;
    if (better(delta, best, limit)) best = { delta, gap };
  };

  if (before && after) {
    const space = lo(after, axis) - hi(before, axis);
    if (space >= size) {
      const target = hi(before, axis) + (space - size) / 2;
      offer(target, [
        { from: hi(before, axis), to: target, of: undefined },
        { from: target + size, to: lo(after, axis), of: undefined },
      ]);
    }
  }
  const behind = before && neighborBeyond(before, others, axis, "before");
  if (before && behind) {
    const gap = lo(before, axis) - hi(behind, axis);
    offer(hi(before, axis) + gap, [
      { from: hi(behind, axis), to: lo(before, axis), of: before },
      { from: hi(before, axis), to: hi(before, axis) + gap, of: undefined },
    ]);
  }
  const ahead = after && neighborBeyond(after, others, axis, "after");
  if (after && ahead) {
    const gap = lo(ahead, axis) - hi(after, axis);
    offer(lo(after, axis) - gap - size, [
      { from: hi(after, axis), to: lo(ahead, axis), of: after },
      { from: lo(after, axis) - gap, to: lo(after, axis), of: undefined },
    ]);
  }
  return best;
}

/** Parede e centro ganham do vão no empate (o vão só vence se chegar mais perto). */
function bestOnAxis(moving: Frame, others: readonly Frame[], axis: SnapAxis, limit: number): Candidate | undefined {
  const edge = edgeCandidate(moving, others, axis, limit);
  const gap = gapCandidate(moving, others, axis, limit);
  if (edge && gap) return Math.abs(gap.delta) < Math.abs(edge.delta) ? gap : edge;
  return edge ?? gap;
}

/** Acende toda parede e centro que ficou no mesmo lugar depois do ajuste, juntando as linhas de mesma coordenada. */
function lineGuides(frame: Frame, others: readonly Frame[], axis: SnapAxis): LineGuide[] {
  const cross = crossOf(axis);
  const lines = new Map<string, LineGuide>();
  const light = (kind: LineGuide["kind"], at: number, other: Frame): void => {
    const key = `${kind}:${Math.round(at / SAME_PLACE)}`;
    const from = Math.min(lo(frame, cross), lo(other, cross));
    const to = Math.max(hi(frame, cross), hi(other, cross));
    const known = lines.get(key);
    if (known) {
      known.from = Math.min(known.from, from);
      known.to = Math.max(known.to, to);
    } else lines.set(key, { kind, axis, at, from, to });
  };
  const same = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_PLACE;
  for (const other of others) {
    if (same(mid(frame, axis), mid(other, axis))) light("center", mid(other, axis), other);
    for (const own of [lo(frame, axis), hi(frame, axis)]) {
      for (const wall of [lo(other, axis), hi(other, axis)]) if (same(own, wall)) light("edge", wall, other);
    }
  }
  return [...lines.values()];
}

function gapGuide(plan: PlannedSegment[], frame: Frame, axis: SnapAxis): GapGuide {
  const cross = crossOf(axis);
  return { kind: "gap", axis, segments: plan.map(({ from, to, of }) => ({ from, to, cross: mid(of ?? frame, cross) })) };
}

function worldLimit(options: SnapOptions): number {
  const zoom = finiteOrFail(options.zoom, "zoom");
  const px = finiteOrFail(options.thresholdPx ?? SNAP_THRESHOLD_PX, "limiar");
  if (zoom <= 0 || px < 0) return orgFail(ORG_ERRORS.invalidNumber, "zoom precisa ser positivo e o limiar não negativo");
  return px / zoom;
}

/**
 * Encaixa o quadro proposto (`moving`, já na posição do arrasto) nos vizinhos `others` (sem o que está sendo arrastado).
 * Cada eixo é decidido sozinho; fora do limiar o ajuste é 0 e não há guia. `others` vazio: sem ajuste e sem guias.
 */
export function snapFrame(moving: Frame, others: readonly Frame[], options: SnapOptions): SnapResult {
  const limit = worldLimit(options);
  const bestX = bestOnAxis(moving, others, "x", limit);
  const bestY = bestOnAxis(moving, others, "y", limit);
  const dx = bestX?.delta ?? 0;
  const dy = bestY?.delta ?? 0;
  const frame: Frame = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h };
  const guides: SnapGuide[] = [];
  for (const [axis, best] of [["x", bestX], ["y", bestY]] as const) {
    if (!best) continue;
    if (best.gap) guides.push(gapGuide(best.gap, frame, axis));
    else guides.push(...lineGuides(frame, others, axis));
  }
  return { dx, dy, frame, guides };
}

export interface SnapMove extends SnapResult {
  /** O arrasto já encaixado como passo do desfazer (os nós livres); `undefined` se nada anda. */
  op: CanvasOp | undefined;
}

/**
 * Arrasto de uma seleção do documento: `delta` é o deslocamento bruto desde o início do arrasto. O quadro puxado é a caixa
 * dos nós livres (os travados ficam parados e entram como vizinhos, como todo nó fora da seleção). `dx`/`dy` do resultado
 * é só o ajuste do encaixe; `op` já leva o deslocamento bruto mais o ajuste.
 */
export function snapSelectionMove(doc: CanvasDoc, ids: readonly string[], delta: { dx: number; dy: number }, options: SnapOptions): SnapMove {
  finiteOrFail(delta.dx, "dx");
  finiteOrFail(delta.dy, "dy");
  const moving = pickNodes(doc, ids).filter((node) => !node.locked);
  if (moving.length === 0) return { dx: 0, dy: 0, frame: { x: 0, y: 0, w: 0, h: 0 }, guides: [], op: undefined };
  const left = Math.min(...moving.map((node) => node.x));
  const top = Math.min(...moving.map((node) => node.y));
  const right = Math.max(...moving.map((node) => node.x + node.w));
  const bottom = Math.max(...moving.map((node) => node.y + node.h));
  const proposed: Frame = { x: left + delta.dx, y: top + delta.dy, w: right - left, h: bottom - top };
  const movingIds = new Set(moving.map((node) => node.id));
  const others = doc.nodes.filter((node) => !movingIds.has(node.id));
  const snap = snapFrame(proposed, others, options);
  const total = { dx: delta.dx + snap.dx, dy: delta.dy + snap.dy };
  const op = total.dx === 0 && total.dy === 0 ? undefined : opMoveMany(doc, [...movingIds], total.dx, total.dy);
  return { ...snap, op };
}
