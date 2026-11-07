// Interface de layout do canvas e o layout livre (reference/argos.md §Layout). Um layout decide onde entra o nó que ainda
// não tem posição no documento; o layout livre é o manual: o dono arrasta, a posição fica no documento, e só o nó novo
// recebe posição, perto de quem tem aresta com ele. O layout de forças entra depois por esta mesma interface.
// Lógica pura e sem Node: roda no painel e no navegador.
import type { CanvasDoc } from "./canvas-doc.ts";
import { REGISTRY_ERRORS, RegistryError, type RegistryErrorCode } from "./canvas-types.ts";

export const FREE_LAYOUT_ID = "free";
/** Espaço livre mínimo entre o nó novo e qualquer nó já no documento. */
export const LAYOUT_GAP = 24;
/** Anéis de busca ao redor do ponto de origem, antes de cair para "abaixo de todo o conteúdo". */
export const SEARCH_RINGS = 60;
/** Nó sem vizinho assentado preenche uma faixa abaixo do conteúdo, em linhas de até este número de nós (uma coluna só passaria de 6000 px com 80 nós). */
export const LOOSE_ROW_NODES = 6;
const CELL = 128;
/** Retângulo que cobre mais células que isto fica numa lista à parte, para o índice não crescer sem limite. */
const MAX_CELLS_PER_RECT = 400;

export interface EnteringNode { id: string; type: string; w: number; h: number }
export interface Placement { id: string; x: number; y: number }

export interface PlaceRequest {
  /** Nós já assentados: nunca se movem. */
  doc: CanvasDoc;
  /** Nós sem posição, com o tamanho que terão. */
  entering: readonly EnteringNode[];
  /** Id do nó → ids dos nós ligados a ele no grafo (de qualquer lado). Pode citar nó que ainda não está no documento. */
  neighbors: ReadonlyMap<string, readonly string[]>;
}

export interface ArrangeRequest {
  doc: CanvasDoc;
  neighbors: ReadonlyMap<string, readonly string[]>;
}

export interface CanvasLayout {
  /** `[a-z][a-z0-9_-]{0,39}`. */
  id: string;
  label: string;
  /**
   * Posição de cada nó de `entering`, exatamente um `Placement` por nó, sem tocar em quem já está no documento.
   * Determinística: a mesma entrada dá a mesma saída, na ordem que for.
   */
  place(request: PlaceRequest): Placement[];
  /** Opcional: reorganiza o documento inteiro (o layout de forças vai usar). O livre não tem: a posição é do dono. */
  arrange?(request: ArrangeRequest): Placement[];
}

interface Box { x: number; y: number; w: number; h: number }

/** Índice espacial por grade para achar sobreposição sem varrer todos os nós a cada candidato. */
export class Occupancy {
  private readonly cells = new Map<string, Box[]>();
  private readonly large: Box[] = [];
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  add(box: Box): void {
    this.minX = Math.min(this.minX, box.x);
    this.minY = Math.min(this.minY, box.y);
    this.maxX = Math.max(this.maxX, box.x + box.w);
    this.maxY = Math.max(this.maxY, box.y + box.h);
    const [c0, r0, c1, r1] = this.span(box);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_RECT) {
      this.large.push(box);
      return;
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = `${c},${r}`;
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(box);
        else this.cells.set(key, [box]);
      }
    }
  }

  /** Sobrepõe (com a folga `gap` ao redor do retângulo testado) algum nó já indexado? */
  hits(box: Box, gap: number): boolean {
    const probe = { x: box.x - gap, y: box.y - gap, w: box.w + 2 * gap, h: box.h + 2 * gap };
    const overlaps = (other: Box): boolean => probe.x < other.x + other.w && other.x < probe.x + probe.w && probe.y < other.y + other.h && other.y < probe.y + probe.h;
    if (this.large.some(overlaps)) return true;
    const [c0, r0, c1, r1] = this.span(probe);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_RECT) return [...this.cells.values()].some((bucket) => bucket.some(overlaps));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) if (this.cells.get(`${c},${r}`)?.some(overlaps)) return true;
    }
    return false;
  }

  get empty(): boolean {
    return this.minX === Infinity;
  }

  private span(box: Box): [number, number, number, number] {
    return [Math.floor(box.x / CELL), Math.floor(box.y / CELL), Math.floor((box.x + box.w) / CELL), Math.floor((box.y + box.h) / CELL)];
  }
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Candidate { i: number; j: number }

/** Candidatos do anel `ring`, do mais perto ao mais longe do centro (em células da grade); a igual distância, à direita primeiro. */
function ringCandidates(ring: number): Candidate[] {
  if (ring === 0) return [{ i: 0, j: 0 }];
  const out: Candidate[] = [];
  for (let j = -ring; j <= ring; j++) {
    for (let i = -ring; i <= ring; i++) if (Math.max(Math.abs(i), Math.abs(j)) === ring) out.push({ i, j });
  }
  const dist = (c: Candidate): number => c.i ** 2 + c.j ** 2;
  return out.sort((a, b) => dist(a) - dist(b) || b.i - a.i || Math.abs(a.j) - Math.abs(b.j) || a.j - b.j);
}

function freePlace({ doc, entering, neighbors }: PlaceRequest): Placement[] {
  const occupied = new Occupancy();
  const center = new Map<string, { x: number; y: number }>();
  for (const node of doc.nodes) {
    occupied.add(node);
    center.set(node.id, { x: node.x + node.w / 2, y: node.y + node.h / 2 });
  }
  const pending = new Map(entering.map((node) => [node.id, node]));
  const placements: Placement[] = [];
  const placedNeighbors = (id: string): string[] => [...new Set(neighbors.get(id) ?? [])].filter((other) => center.has(other)).sort(byId);

  // a faixa dos nós soltos começa abaixo do que já existe quando a chamada começa; os desta chamada a preenchem
  const looseOrigin = occupied.empty ? { x: 0, y: 0 } : { x: occupied.minX, y: occupied.maxY + LAYOUT_GAP };

  while (pending.size > 0) {
    // primeiro o nó com mais vizinhos já assentados, depois o de mais ligações: quem vem depois nasce perto de quem veio antes
    let next: EnteringNode | undefined;
    let best: [number, number] = [-1, -1];
    for (const node of [...pending.values()].sort((a, b) => byId(a.id, b.id))) {
      const score: [number, number] = [placedNeighbors(node.id).length, new Set(neighbors.get(node.id) ?? []).size];
      if (score[0] > best[0] || (score[0] === best[0] && score[1] > best[1])) {
        best = score;
        next = node;
      }
    }
    if (!next) break;
    pending.delete(next.id);

    const near = placedNeighbors(next.id).map((id) => center.get(id) as { x: number; y: number });
    const stepX = next.w + LAYOUT_GAP;
    const stepY = next.h + LAYOUT_GAP;
    const anchor = near.length > 0
      ? { x: near.reduce((sum, p) => sum + p.x, 0) / near.length, y: near.reduce((sum, p) => sum + p.y, 0) / near.length }
      : { x: looseOrigin.x + next.w / 2, y: looseOrigin.y + next.h / 2 };

    let spot: { x: number; y: number } | undefined;
    if (near.length === 0) {
      // primeiro encaixe livre da faixa, linha a linha, da esquerda para a direita
      for (let row = 0; row < SEARCH_RINGS && !spot; row++) {
        for (let col = 0; col < LOOSE_ROW_NODES && !spot; col++) {
          const x = Math.round(looseOrigin.x + col * stepX);
          const y = Math.round(looseOrigin.y + row * stepY);
          if (!occupied.hits({ x, y, w: next.w, h: next.h }, LAYOUT_GAP)) spot = { x, y };
        }
      }
    }
    for (let ring = 0; ring <= SEARCH_RINGS && !spot; ring++) {
      for (const { i, j } of ringCandidates(ring)) {
        const x = Math.round(anchor.x - next.w / 2 + i * stepX);
        const y = Math.round(anchor.y - next.h / 2 + j * stepY);
        if (!occupied.hits({ x, y, w: next.w, h: next.h }, LAYOUT_GAP)) {
          spot = { x, y };
          break;
        }
      }
    }
    spot ??= { x: Math.round(occupied.empty ? 0 : occupied.minX), y: Math.round(occupied.empty ? 0 : occupied.maxY + LAYOUT_GAP) };

    occupied.add({ x: spot.x, y: spot.y, w: next.w, h: next.h });
    center.set(next.id, { x: spot.x + next.w / 2, y: spot.y + next.h / 2 });
    placements.push({ id: next.id, x: spot.x, y: spot.y });
  }
  return placements;
}

export const FREE_LAYOUT: CanvasLayout = Object.freeze({ id: FREE_LAYOUT_ID, label: "Livre", place: freePlace });

const LAYOUT_ID = /^[a-z][a-z0-9_-]{0,39}$/;

export interface LayoutRegistry {
  /** Valida e guarda; lança `RegistryError` (campo faltando, id duplicado). */
  register(layout: CanvasLayout): void;
  get(id: string): CanvasLayout | undefined;
  list(): readonly CanvasLayout[];
}

const fail = (code: RegistryErrorCode, message: string, subject?: string): never => {
  throw new RegistryError(code, message, subject);
};

export function createLayoutRegistry(): LayoutRegistry {
  const byLayoutId = new Map<string, CanvasLayout>();
  return {
    register(layout) {
      const raw = layout as unknown as Record<string, unknown> | null;
      if (typeof raw !== "object" || raw === null) return fail(REGISTRY_ERRORS.invalidField, "a declaração do layout deve ser um objeto");
      for (const field of ["id", "label", "place"]) {
        if (raw[field] === undefined) return fail(REGISTRY_ERRORS.missingField, `layout sem o campo "${field}"`, field);
      }
      if (typeof layout.id !== "string" || !LAYOUT_ID.test(layout.id)) return fail(REGISTRY_ERRORS.invalidField, `"id" deve seguir ${LAYOUT_ID.source}`, "id");
      if (typeof layout.label !== "string" || layout.label.trim() === "") return fail(REGISTRY_ERRORS.invalidField, '"label" deve ser um texto', "label");
      if (typeof layout.place !== "function") return fail(REGISTRY_ERRORS.invalidField, '"place" deve ser uma função', "place");
      if (layout.arrange !== undefined && typeof layout.arrange !== "function") return fail(REGISTRY_ERRORS.invalidField, '"arrange" deve ser uma função', "arrange");
      if (byLayoutId.has(layout.id)) return fail(REGISTRY_ERRORS.duplicate, `o layout "${layout.id}" já está registrado`, layout.id);
      byLayoutId.set(layout.id, layout);
    },
    get: (id) => byLayoutId.get(id),
    list: () => [...byLayoutId.values()],
  };
}

/** O registro de partida: só o layout livre. */
export function defaultLayoutRegistry(): LayoutRegistry {
  const registry = createLayoutRegistry();
  registry.register(FREE_LAYOUT);
  return registry;
}
