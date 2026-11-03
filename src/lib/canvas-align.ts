// Alinhar, distribuir e encaixar na grade (reference/argos.md §Organização). Funções puras sobre o documento que devolvem
// uma `CanvasOp` (lote de `move`, um passo só no desfazer) ou `undefined` quando nada muda. Nó travado nunca se move, mas
// conta como referência (alinhar) ou âncora (distribuir). Sem Node e sem DOM.
import type { CanvasDoc, CanvasNode } from "./canvas-doc.ts";
import { type AtomicOp, type CanvasOp, opBatch, opMove } from "./canvas-history.ts";
import { finiteOrFail, orgFail, ORG_ERRORS, pickNodes } from "./canvas-groups.ts";

/** Grade do canvas, em unidades do documento. */
export const GRID_SIZE = 20;

export const ALIGN_MODES = ["left", "center", "right", "top", "middle", "bottom"] as const;
export type AlignMode = (typeof ALIGN_MODES)[number];

export const DISTRIBUTE_AXES = ["horizontal", "vertical"] as const;
export type DistributeAxis = (typeof DISTRIBUTE_AXES)[number];

/** Menos nós que isso não tem o que alinhar nem o que distribuir entre as pontas. */
const ALIGN_MIN_NODES = 2;
const DISTRIBUTE_MIN_NODES = 3;

interface Target {
  node: CanvasNode;
  x: number;
  y: number;
}

/** Os passos só para quem andou: posição igual à atual não vira passo no desfazer. */
function movesFor(doc: CanvasDoc, targets: readonly Target[]): CanvasOp | undefined {
  const moves: AtomicOp[] = targets
    .filter(({ node, x, y }) => !node.locked && (node.x !== x || node.y !== y))
    .map(({ node, x, y }) => opMove(doc, node.id, { x, y }));
  if (moves.length === 0) return undefined;
  return moves.length === 1 ? moves[0] : opBatch(moves);
}

/**
 * Alinha a seleção à caixa que a envolve (esquerda, centro, direita, topo, meio, base). O nó travado entra no cálculo da
 * caixa e fica onde está. Menos de dois nós: `undefined`. Erros: `org_unknown_node`, `org_invalid_mode`.
 */
export function alignNodes(doc: CanvasDoc, ids: readonly string[], mode: AlignMode): CanvasOp | undefined {
  if (!ALIGN_MODES.includes(mode)) return orgFail(ORG_ERRORS.invalidMode, "modo de alinhamento desconhecido");
  const nodes = pickNodes(doc, ids);
  if (nodes.length < ALIGN_MIN_NODES) return undefined;
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.w));
  const bottom = Math.max(...nodes.map((node) => node.y + node.h));
  const place = (node: CanvasNode): Target => {
    switch (mode) {
      case "left": return { node, x: left, y: node.y };
      case "center": return { node, x: (left + right) / 2 - node.w / 2, y: node.y };
      case "right": return { node, x: right - node.w, y: node.y };
      case "top": return { node, x: node.x, y: top };
      case "middle": return { node, x: node.x, y: (top + bottom) / 2 - node.h / 2 };
      case "bottom": return { node, x: node.x, y: bottom - node.h };
      default: return orgFail(ORG_ERRORS.invalidMode, "modo de alinhamento desconhecido");
    }
  };
  return movesFor(doc, nodes.map(place));
}

/**
 * Distribui a seleção com vãos iguais ao longo do eixo. As duas pontas (os nós de menor e de maior centro) e os nós
 * travados ficam parados e servem de âncora: entre duas âncoras seguidas os nós livres dividem o espaço em vãos iguais.
 * Empate de centro desempata pela ordem de `ids`. Menos de três nós: `undefined`.
 */
export function distributeNodes(doc: CanvasDoc, ids: readonly string[], axis: DistributeAxis): CanvasOp | undefined {
  if (!DISTRIBUTE_AXES.includes(axis)) return orgFail(ORG_ERRORS.invalidMode, "eixo de distribuição desconhecido");
  const nodes = pickNodes(doc, ids);
  if (nodes.length < DISTRIBUTE_MIN_NODES) return undefined;
  const horizontal = axis === "horizontal";
  const start = (node: CanvasNode): number => (horizontal ? node.x : node.y);
  const size = (node: CanvasNode): number => (horizontal ? node.w : node.h);
  // `sort` é estável: o desempate é a ordem de entrada
  const ordered = [...nodes].sort((a, b) => start(a) + size(a) / 2 - (start(b) + size(b) / 2));
  const lastIndex = ordered.length - 1;
  const isAnchor = (node: CanvasNode, index: number): boolean => index === 0 || index === lastIndex || node.locked;

  const targets: Target[] = ordered.map((node) => ({ node, x: node.x, y: node.y }));
  let anchor = 0;
  for (let next = 1; next < ordered.length; next += 1) {
    const nextNode = ordered[next] as CanvasNode;
    if (!isAnchor(nextNode, next)) continue;
    const before = ordered[anchor] as CanvasNode;
    const between = ordered.slice(anchor + 1, next);
    if (between.length > 0) {
      const room = start(nextNode) - (start(before) + size(before)) - between.reduce((sum, node) => sum + size(node), 0);
      const gap = room / (between.length + 1);
      let cursor = start(before) + size(before) + gap;
      between.forEach((node, offset) => {
        const target = targets[anchor + 1 + offset] as Target;
        if (horizontal) target.x = cursor;
        else target.y = cursor;
        cursor += size(node) + gap;
      });
    }
    anchor = next;
  }
  return movesFor(doc, targets);
}

/** Arredonda para a grade sem devolver `-0`. */
const onGrid = (value: number, grid: number): number => Math.round(value / grid) * grid + 0;

/**
 * Encaixa o canto de cada nó livre na grade (`grid`, padrão `GRID_SIZE`). Nó travado não se move; nó que já está na grade
 * não vira passo. Erro: `org_invalid_number` para grade que não é finita e positiva.
 */
export function snapNodesToGrid(doc: CanvasDoc, ids: readonly string[], grid: number = GRID_SIZE): CanvasOp | undefined {
  if (finiteOrFail(grid, "grade") <= 0) return orgFail(ORG_ERRORS.invalidNumber, "a grade precisa ser maior que zero");
  return movesFor(doc, pickNodes(doc, ids).map((node) => ({ node, x: onGrid(node.x, grid), y: onGrid(node.y, grid) })));
}
