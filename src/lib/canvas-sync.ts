// Sincronia ao vivo do canvas com o grafo (reference/argos.md §Sincronia ao vivo). Função pura sobre (documento atual,
// grafo novo): nó novo entra perto dos vizinhos com quem tem aresta, sem sobrepor; nó que sumiu sai do documento; nada que
// já está no documento se move (a posição que o dono definiu sempre vence). As arestas do grafo não entram no documento:
// a página as desenha direto do grafo, então um grafo que muda a cada poucos segundos não regrava o documento.
// Sem dependência de Node: roda no painel e no navegador.
import { CANVAS_LIMITS, mergeWithGraph, validateCanvasDoc, type CanvasDoc, type CanvasNode } from "./canvas-doc.ts";
import type { CanvasLayout, EnteringNode } from "./canvas-layout.ts";
import { orchestrationEdges, orchestratorTerminals, recruitSlots, recruitsOf } from "./canvas-recruit.ts";

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const SYNC_ERRORS = {
  invalidLayout: "sync_invalid_layout",
} as const;
export type SyncErrorCode = (typeof SYNC_ERRORS)[keyof typeof SYNC_ERRORS];

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = "SyncError";
    this.code = code;
  }
}

export interface GraphSnapshot {
  /** `orchestrator`: o par do pane de quem alocou o agente (registro); com terminal no documento, o nó entra abaixo dele. */
  nodes: readonly { id: string; type: string; orchestrator?: unknown }[];
  edges: readonly { from: string; to: string }[];
}

export interface SyncOptions {
  layout: CanvasLayout;
  /** Tamanho do nó novo, por tipo (o `defaultSize` do registro de tipos). */
  sizeOf(type: string): { w: number; h: number };
}

export interface SyncResult {
  /** O mesmo objeto de entrada quando nada mudou. A revisão (`rev`) nunca muda aqui: é do servidor. */
  doc: CanvasDoc;
  added: string[];
  removed: string[];
  /** Nós novos que não couberam no teto de nós do documento (ficam fora, nunca descartam nó do dono). */
  skipped: string[];
  changed: boolean;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function neighborMap(edges: GraphSnapshot["edges"]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const list = out.get(a);
    if (list) list.push(b);
    else out.set(a, [b]);
  };
  for (const edge of edges.slice(0, CANVAS_LIMITS.edges)) {
    if (edge.from === edge.to) continue;
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }
  return out;
}

/**
 * O agente novo que tem o terminal do orquestrador no documento entra na fileira abaixo dele, depois dos que já estão lá
 * (recrutas e agentes que ele alocou); ninguém que já está no documento se move.
 */
function belowOrchestrators(doc: CanvasDoc, graphNodes: GraphSnapshot["nodes"], entering: readonly EnteringNode[]): Map<string, { x: number; y: number }> {
  const refOf = new Map(graphNodes.map((node) => [node.id, node]));
  const byTerminal = new Map<string, { terminal: CanvasNode; newcomers: EnteringNode[] }>();
  for (const node of entering) {
    const terminal = orchestratorTerminals(doc, refOf.get(node.id) ?? { id: node.id })[0];
    if (terminal === undefined) continue;
    const group = byTerminal.get(terminal.id) ?? { terminal, newcomers: [] };
    group.newcomers.push(node);
    byTerminal.set(terminal.id, group);
  }
  const out = new Map<string, { x: number; y: number }>();
  const taken: { x: number; y: number; w: number; h: number }[] = doc.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  const free = (box: { x: number; y: number; w: number; h: number }): boolean =>
    taken.every((t) => box.x >= t.x + t.w || t.x >= box.x + box.w || box.y >= t.y + t.h || t.y >= box.y + box.h);
  for (const { terminal, newcomers } of byTerminal.values()) {
    const orchestrated = doc.nodes.filter((node) => orchestratorTerminals(doc, refOf.get(node.id) ?? { id: node.id })[0]?.id === terminal.id);
    const team = [...recruitsOf(doc, terminal.id), ...orchestrated];
    const sizes = [...team, ...newcomers].map((n) => ({ w: n.w, h: n.h }));
    const cell = { w: Math.max(...sizes.map((z) => z.w)), h: Math.max(...sizes.map((z) => z.h)) };
    // quem já está abaixo não se move: as vagas da fileira recentrada podem cair em cima dele, então vale a primeira livre
    // entre as fileiras de tamanho crescente; sem vaga livre, fica a posição do layout
    const candidates: { x: number; y: number }[] = [];
    for (let count = sizes.length; count <= sizes.length + SLOT_SEARCH_EXTRA; count++) candidates.push(...recruitSlots(terminal, Array.from({ length: count }, () => cell)));
    for (const node of newcomers) {
      const at = candidates.find((c) => free({ x: c.x, y: c.y, w: node.w, h: node.h }));
      if (at === undefined) continue;
      out.set(node.id, at);
      taken.push({ x: at.x, y: at.y, w: node.w, h: node.h });
    }
  }
  return out;
}

/** Fileiras a mais que a procura de vaga abaixo do orquestrador tenta antes de desistir para o layout. */
const SLOT_SEARCH_EXTRA = 8;

export function syncWithGraph(doc: CanvasDoc, graph: GraphSnapshot, options: SyncOptions): SyncResult {
  const merged = mergeWithGraph(doc, graph.nodes);
  const room = Math.max(0, CANVAS_LIMITS.nodes - merged.doc.nodes.length);
  const unplaced = [...merged.unplaced].sort(byId);
  const admitted = unplaced.slice(0, room);
  const skipped = unplaced.slice(room);

  if (admitted.length === 0 && merged.removed.length === 0) return { doc, added: [], removed: [], skipped, changed: false };

  const typeOf = new Map(graph.nodes.map((node) => [node.id, node.type]));
  const entering: EnteringNode[] = admitted.map((id) => {
    const type = typeOf.get(id) as string;
    return { id, type, ...options.sizeOf(type) };
  });
  const neighbors = neighborMap([...graph.edges, ...orchestrationEdges(merged.doc, graph.nodes)]);
  const placements = options.layout.place({ doc: merged.doc, entering, neighbors });

  const wanted = new Set(admitted);
  const seen = new Set<string>();
  for (const placement of placements) {
    if (!wanted.has(placement.id) || seen.has(placement.id)) throw new SyncError(SYNC_ERRORS.invalidLayout, `o layout "${options.layout.id}" devolveu posição para um nó fora do pedido ou repetido`);
    seen.add(placement.id);
  }
  if (seen.size !== wanted.size) throw new SyncError(SYNC_ERRORS.invalidLayout, `o layout "${options.layout.id}" não posicionou todos os nós novos`);

  const placeOf = new Map<string, { x: number; y: number }>(placements.map((placement) => [placement.id, placement]));
  for (const [id, at] of belowOrchestrators(merged.doc, graph.nodes, entering)) placeOf.set(id, at);
  let layer = merged.doc.nodes.reduce((top, node) => Math.max(top, node.z), 0);
  const created: CanvasNode[] = entering.map((node) => {
    const at = placeOf.get(node.id) as { x: number; y: number };
    layer = Math.min(layer + 1, CANVAS_LIMITS.layer);
    return { id: node.id, type: node.type, x: at.x, y: at.y, w: node.w, h: node.h, z: layer, data: {}, locked: false, blurred: false };
  });

  // valida de novo: posição fora da faixa ou tamanho inválido vindo de um layout de plugin falha aqui, alto
  const next = validateCanvasDoc({ ...merged.doc, nodes: [...merged.doc.nodes, ...created] });
  return { doc: next, added: admitted, removed: merged.removed, skipped, changed: true };
}
