// Organizar o canvas por equipes (reference/argos.md §Layout): reposiciona os nós do documento inteiro sem sobreposição.
// Cada orquestrador forma uma equipe (notas em fileiras acima, ele no centro, recrutas em grade abaixo); o resto agrupa pelas
// ligações do grafo, e o que não liga a nada vai junto numa grade. A área leva a sua equipe e é redimensionada para caber.
// Nó travado ou fixado nunca se move, e a área que tem um deles fica como está. Lógica pura e determinística (ordem por id).
import { AREA_HEADER, AREA_LIMITS, areaIndex, areaNodes, isAreaNode } from "./canvas-areas.ts";
import type { CanvasDoc, CanvasNode } from "./canvas-doc.ts";
import { type AtomicOp, type CanvasOp, opBatch, opMove, opResize } from "./canvas-history.ts";
import { LAYOUT_GAP, LOOSE_ROW_NODES, Occupancy, type Placement } from "./canvas-layout.ts";
import { directNotesOf } from "./canvas-note.ts";
import { isOrchestrator, RECRUIT_LAYOUT, recruiterOf, recruitsOf } from "./canvas-recruit.ts";

export interface TidyRequest {
  doc: CanvasDoc;
  /** Id do nó → ids dos nós ligados a ele (de qualquer lado), como o layout de forças recebe. */
  neighbors: ReadonlyMap<string, readonly string[]>;
}

/** Caixa final de uma área reorganizada (posição e tamanho). */
export interface TidyFrame { id: string; x: number; y: number; w: number; h: number }

export interface TidyResult {
  /** Posição de cada nó que não é área e que o arranjo move (os travados e fixados não entram). */
  placements: Placement[];
  /** Caixa de cada área reorganizada; a área congelada (com nó travado ou fixado) não entra. */
  frames: TidyFrame[];
}

export const TIDY_LAYOUT = {
  /** Notas por fileira acima do orquestrador. */
  notesPerRow: 4,
  /** Espaço entre a última fileira de notas e o orquestrador. */
  noteGapY: 48,
  /** Espaço vertical entre fileiras de uma grade. */
  rowGapY: 48,
  /** Espaço entre equipes e entre blocos soltos no topo do canvas. */
  unitGap: 64,
  /** Espaço entre equipes dentro de uma área. */
  areaUnitGap: 32,
  /** A faixa de prateleiras mira largura ≈ este fator × raiz da área total, para o resultado sair mais largo que alto. */
  aspect: 1.6,
  /** Passo e tentativas ao deslizar um bloco para fora de um obstáculo fixo. */
  shiftStep: 48,
  shiftTries: 200,
} as const;

interface Box { x: number; y: number; w: number; h: number }
/** Um conjunto de nós já arrumado: `items` em coordenadas relativas ao canto superior esquerdo do bloco. */
interface Block { w: number; h: number; items: Placement[] }

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const boxOf = (node: Box): Box => ({ x: node.x, y: node.y, w: node.w, h: node.h });

/** Fileiras de até `perRow` nós, cada uma centrada na largura do bloco. */
function gridBlock(nodes: readonly CanvasNode[], perRow: number, gapX: number, gapY: number): Block {
  const rows: CanvasNode[][] = [];
  for (let i = 0; i < nodes.length; i += perRow) rows.push(nodes.slice(i, i + perRow));
  const widths = rows.map((row) => row.reduce((sum, node) => sum + node.w, 0) + gapX * (row.length - 1));
  const width = Math.max(0, ...widths);
  const items: Placement[] = [];
  let y = 0;
  rows.forEach((row, index) => {
    let x = Math.round(((width - (widths[index] as number)) / 2));
    for (const node of row) {
      items.push({ id: node.id, x, y });
      x += node.w + gapX;
    }
    y += Math.max(...row.map((node) => node.h)) + gapY;
  });
  return { w: width, h: Math.max(0, y - gapY), items };
}

const shifted = (block: Block, dx: number, dy: number): Placement[] => block.items.map((item) => ({ id: item.id, x: item.x + dx, y: item.y + dy }));

/** A equipe: notas acima, o orquestrador centrado e os recrutas em grade abaixo. */
function teamBlock(orchestrator: CanvasNode, notes: readonly CanvasNode[], recruits: readonly CanvasNode[]): Block {
  const above = gridBlock(notes, TIDY_LAYOUT.notesPerRow, LAYOUT_GAP, LAYOUT_GAP);
  const below = gridBlock(recruits, RECRUIT_LAYOUT.perRow, RECRUIT_LAYOUT.gapX, TIDY_LAYOUT.rowGapY);
  const width = Math.max(orchestrator.w, above.w, below.w);
  const items: Placement[] = [];
  let y = 0;
  if (notes.length > 0) {
    items.push(...shifted(above, Math.round((width - above.w) / 2), 0));
    y = above.h + TIDY_LAYOUT.noteGapY;
  }
  items.push({ id: orchestrator.id, x: Math.round((width - orchestrator.w) / 2), y });
  y += orchestrator.h;
  if (recruits.length > 0) {
    items.push(...shifted(below, Math.round((width - below.w) / 2), y + RECRUIT_LAYOUT.gapY));
    y += RECRUIT_LAYOUT.gapY + below.h;
  }
  return { w: width, h: y, items };
}

/** Grade quase quadrada, limitada a `LOOSE_ROW_NODES` por fileira. */
const looseBlock = (nodes: readonly CanvasNode[]): Block =>
  gridBlock(nodes, Math.max(1, Math.min(LOOSE_ROW_NODES, Math.ceil(Math.sqrt(nodes.length)))), LAYOUT_GAP, LAYOUT_GAP);

interface Packed { w: number; h: number; positions: Box[] }

/** Prateleiras: os blocos, na ordem dada, enchem uma fileira até a largura alvo e abrem outra abaixo. */
function shelfPack(blocks: readonly Block[], gap: number): Packed {
  const area = blocks.reduce((sum, block) => sum + block.w * block.h, 0);
  const target = Math.max(0, ...blocks.map((block) => block.w), Math.round(TIDY_LAYOUT.aspect * Math.sqrt(area)));
  const positions: Box[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let right = 0;
  for (const block of blocks) {
    if (x > 0 && x + block.w > target) {
      y += rowH + gap;
      x = 0;
      rowH = 0;
    }
    positions.push({ x, y, w: block.w, h: block.h });
    x += block.w + gap;
    rowH = Math.max(rowH, block.h);
    right = Math.max(right, x - gap);
  }
  return { w: right, h: blocks.length > 0 ? y + rowH : 0, positions };
}

interface Cluster {
  orchestrator?: CanvasNode;
  recruits: Set<string>;
  notes: Set<string>;
  nodes: CanvasNode[];
}

/** Equipes dos orquestradores (a nota vai ao primeiro orquestrador, por id, que a reivindica) e as componentes do resto. */
function clustersOf(doc: CanvasDoc, movable: ReadonlyMap<string, CanvasNode>, neighbors: ReadonlyMap<string, readonly string[]>): { clusters: Cluster[]; loose: CanvasNode[] } {
  const claimed = new Set<string>();
  const clusters: Cluster[] = [];
  const orchestrators = [...movable.values()].filter((node) => isOrchestrator(node)).sort((a, b) => Number(recruiterOf(a) !== undefined) - Number(recruiterOf(b) !== undefined) || byId(a, b));
  for (const orchestrator of orchestrators) {
    if (claimed.has(orchestrator.id)) continue;
    claimed.add(orchestrator.id);
    const cluster: Cluster = { orchestrator, recruits: new Set(), notes: new Set(), nodes: [orchestrator] };
    const take = (node: CanvasNode | undefined, into: Set<string>): void => {
      if (!node || claimed.has(node.id)) return;
      claimed.add(node.id);
      into.add(node.id);
      cluster.nodes.push(node);
    };
    for (const recruit of recruitsOf(doc, orchestrator.id).sort(byId)) take(movable.get(recruit.id), cluster.recruits);
    for (const owner of [orchestrator.id, ...cluster.recruits].sort()) {
      for (const noteId of [...directNotesOf(doc, owner)].sort()) take(movable.get(noteId), cluster.notes);
    }
    clusters.push(cluster);
  }
  const loose: CanvasNode[] = [];
  const rest = [...movable.values()].filter((node) => !claimed.has(node.id)).sort(byId);
  const restIds = new Set(rest.map((node) => node.id));
  for (const start of rest) {
    if (claimed.has(start.id)) continue;
    const members: CanvasNode[] = [];
    const queue = [start.id];
    claimed.add(start.id);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      members.push(movable.get(id) as CanvasNode);
      for (const next of [...(neighbors.get(id) ?? [])].sort()) {
        if (restIds.has(next) && !claimed.has(next)) {
          claimed.add(next);
          queue.push(next);
        }
      }
    }
    if (members.length === 1) loose.push(start);
    else clusters.push({ recruits: new Set(), notes: new Set(), nodes: members.sort(byId) });
  }
  return { clusters, loose };
}

/** Blocos de um aglomerado, um por área em que os nós dele estão (a equipe que atravessa áreas se parte). */
function unitsOf(cluster: Cluster, areaOf: ReadonlyMap<string, string>): Map<string, Block[]> {
  const groups = new Map<string, CanvasNode[]>();
  for (const node of cluster.nodes) {
    const key = areaOf.get(node.id) ?? "";
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  const out = new Map<string, Block[]>();
  for (const [key, nodes] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const withOrchestrator = cluster.orchestrator !== undefined && nodes.includes(cluster.orchestrator);
    const block = withOrchestrator
      ? teamBlock(cluster.orchestrator as CanvasNode, nodes.filter((node) => cluster.notes.has(node.id)), nodes.filter((node) => cluster.recruits.has(node.id)))
      : looseBlock(nodes);
    out.set(key, [...(out.get(key) ?? []), block]);
  }
  return out;
}

/**
 * O arranjo por equipes. `pinned` são ids que não se movem (como os travados do documento). Cada bloco do topo (área ou equipe
 * sem área) fica na prateleira, com origem no canto superior esquerdo do conteúdo atual, e desliza em x para fora de qualquer
 * obstáculo fixo; nada se sobrepõe.
 */
export function tidyArrange(request: TidyRequest, options: { pinned?: ReadonlySet<string> } = {}): TidyResult {
  const { doc } = request;
  const pinned = options.pinned ?? new Set<string>();
  const fixedNode = (node: CanvasNode): boolean => node.locked || pinned.has(node.id);
  const validAreas = new Map(areaNodes(doc).map(({ node, data }) => [node.id, data]));
  const memberOf = areaIndex(doc);

  const frozenAreas = new Set<string>();
  for (const node of doc.nodes) {
    if (!isAreaNode(node)) continue;
    const data = validAreas.get(node.id);
    const members = data ? doc.nodes.filter((member) => data.members.includes(member.id)) : [];
    if (!data || fixedNode(node) || members.some(fixedNode)) frozenAreas.add(node.id);
  }
  const frozen = (node: CanvasNode): boolean => fixedNode(node) || frozenAreas.has(memberOf.get(node.id) ?? "");

  const obstacles = new Occupancy();
  const movable = new Map<string, CanvasNode>();
  const emptyAreas: CanvasNode[] = [];
  for (const node of doc.nodes) {
    if (isAreaNode(node)) {
      if (frozenAreas.has(node.id)) obstacles.add(boxOf(node));
      else if (!doc.nodes.some((other) => memberOf.get(other.id) === node.id && !frozen(other))) emptyAreas.push(node);
      continue;
    }
    if (frozen(node)) obstacles.add(boxOf(node));
    else movable.set(node.id, node);
  }

  const areaOf = new Map([...movable.keys()].flatMap((id) => (memberOf.has(id) ? [[id, memberOf.get(id) as string] as const] : [])));
  const { clusters, loose } = clustersOf(doc, movable, request.neighbors);
  const perArea = new Map<string, Block[]>();
  const topUnits: Block[] = [];
  const addUnits = (units: Map<string, Block[]>): void => {
    for (const [key, blocks] of units) {
      if (key === "") topUnits.push(...blocks);
      else perArea.set(key, [...(perArea.get(key) ?? []), ...blocks]);
    }
  };
  for (const cluster of clusters) addUnits(unitsOf(cluster, areaOf));
  const looseByArea = new Map<string, CanvasNode[]>();
  for (const node of loose) looseByArea.set(areaOf.get(node.id) ?? "", [...(looseByArea.get(areaOf.get(node.id) ?? "") ?? []), node]);
  for (const [key, nodes] of [...looseByArea].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) addUnits(new Map([[key, [looseBlock(nodes)]]]));

  // cada área vira um bloco do tamanho do que guarda; o resto da equipe entra solto, depois das áreas
  const pad = AREA_LIMITS.padding;
  const areaBlocks: { id: string; block: Block; inner: Packed }[] = [];
  const areaIds = [...new Set([...perArea.keys(), ...emptyAreas.map((area) => area.id)])].sort();
  for (const id of areaIds) {
    const units = perArea.get(id) ?? [];
    const inner = shelfPack(units, TIDY_LAYOUT.areaUnitGap);
    const own = doc.nodes.find((node) => node.id === id) as CanvasNode;
    const w = units.length > 0 ? Math.max(AREA_LIMITS.minWidth, inner.w + 2 * pad) : own.w;
    const h = units.length > 0 ? Math.max(AREA_LIMITS.minHeight, inner.h + AREA_HEADER + 2 * pad) : own.h;
    const items = units.flatMap((unit, index) => {
      const at = inner.positions[index] as Box;
      return shifted(unit, at.x + pad, at.y + AREA_HEADER + pad);
    });
    areaBlocks.push({ id, block: { w, h, items }, inner });
  }

  const top = shelfPack([...areaBlocks.map((entry) => entry.block), ...topUnits], TIDY_LAYOUT.unitGap);
  const moving: Box[] = [...movable.values(), ...areaBlocks.map((entry) => doc.nodes.find((node) => node.id === entry.id) as CanvasNode)];
  const origin = moving.length > 0
    ? { x: Math.min(...moving.map((box) => box.x)), y: Math.min(...moving.map((box) => box.y)) }
    : { x: 0, y: 0 };

  const placements: Placement[] = [];
  const frames: TidyFrame[] = [];
  const blocks = [...areaBlocks.map((entry) => entry.block), ...topUnits];
  blocks.forEach((block, index) => {
    const at = top.positions[index] as Box;
    const spot = freeSpot(obstacles, { x: origin.x + at.x, y: origin.y + at.y, w: block.w, h: block.h }, origin.x);
    obstacles.add({ x: spot.x, y: spot.y, w: block.w, h: block.h });
    const entry = index < areaBlocks.length ? areaBlocks[index] : undefined;
    if (entry) frames.push({ id: entry.id, x: spot.x, y: spot.y, w: block.w, h: block.h });
    for (const item of block.items) placements.push({ id: item.id, x: spot.x + item.x, y: spot.y + item.y });
  });
  return { placements: placements.sort(byId), frames: frames.sort(byId) };
}

/**
 * O arranjo como uma operação só da pilha de desfazer: `move` para cada nó que mudou de lugar e `resize` para cada área
 * (posição e tamanho). `undefined` quando o canvas já está arrumado.
 */
export function tidyOp(doc: CanvasDoc, result: TidyResult): CanvasOp | undefined {
  const byNode = new Map(doc.nodes.map((node) => [node.id, node]));
  const ops: AtomicOp[] = [];
  for (const frame of result.frames) {
    const node = byNode.get(frame.id);
    if (node && (node.x !== frame.x || node.y !== frame.y || node.w !== frame.w || node.h !== frame.h)) ops.push(opResize(doc, frame.id, frame));
  }
  for (const place of result.placements) {
    const node = byNode.get(place.id);
    if (node && (node.x !== place.x || node.y !== place.y)) ops.push(opMove(doc, place.id, place));
  }
  if (ops.length === 0) return undefined;
  return ops.length === 1 ? (ops[0] as AtomicOp) : opBatch(ops);
}

/** Duração da animação do arranjo; com movimento reduzido a página usa 0 e o resultado entra de uma vez. */
export const TIDY_ANIMATION_MS = 250;

/** As posições no instante `t` (0 a 1) do caminho de `from` até `to`, com saída suave; quem não está em `from` já nasce no destino. */
export function tweenPlacements(from: readonly Placement[], to: readonly Placement[], t: number): Placement[] {
  const start = new Map(from.map((place) => [place.id, place]));
  const k = 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
  return to.map((place) => {
    const origin = start.get(place.id);
    return origin ? { id: place.id, x: origin.x + (place.x - origin.x) * k, y: origin.y + (place.y - origin.y) * k } : place;
  });
}

/** A posição do bloco, deslizando em x para fora dos obstáculos; sem folga na fileira, abaixo de tudo. */
function freeSpot(obstacles: Occupancy, box: Box, fallbackX: number): { x: number; y: number } {
  for (let i = 0; i < TIDY_LAYOUT.shiftTries; i++) {
    const x = box.x + i * TIDY_LAYOUT.shiftStep;
    if (!obstacles.hits({ ...box, x }, LAYOUT_GAP)) return { x, y: box.y };
  }
  return { x: fallbackX, y: obstacles.empty ? box.y : obstacles.maxY + LAYOUT_GAP };
}
