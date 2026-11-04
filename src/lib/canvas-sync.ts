// Sincronia ao vivo do canvas com o grafo (reference/argos.md §Sincronia ao vivo). Função pura sobre (documento atual,
// grafo novo): nó novo entra perto dos vizinhos com quem tem aresta, sem sobrepor; nó que sumiu sai do documento; nada que
// já está no documento se move (a posição que o dono definiu sempre vence). As arestas do grafo não entram no documento:
// a página as desenha direto do grafo, então um grafo que muda a cada poucos segundos não regrava o documento.
// Sem dependência de Node: roda no painel e no navegador.
import { CANVAS_LIMITS, isLiveNodeType, mergeWithGraph, paneKey, validateCanvasDoc, withoutNodes, type CanvasDoc, type CanvasNode, type HeldReason } from "./canvas-doc.ts";
import type { CanvasLayout, EnteringNode } from "./canvas-layout.ts";
import { herdrTargetOf, orchestrationEdges, orchestratorTerminals, recruitSlots, recruitsOf, terminalTargetOf } from "./canvas-recruit.ts";

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
  /**
   * `orchestrator`: o par do pane de quem alocou o agente (registro); com terminal no documento, o nó entra abaixo dele.
   * `herdr`: o par `{session, pane}` do processo do agente; um pane é um nó só, então agente cujo pane já é um terminal do
   * documento não ganha nó próprio.
   */
  nodes: readonly { id: string; type: string; orchestrator?: unknown; herdr?: unknown }[];
  edges: readonly { from: string; to: string }[];
}

/** Leituras seguidas do grafo sem o nó para ele sair do documento (uma falha de instante não tira ninguém). */
export const ABSENCE_MIN_READS = 2;

/**
 * Conta, por nó vivo, em quantas leituras seguidas do grafo ele faltou. Uma leitura é identificada pelo objeto do grafo
 * (`read`): a mesma leitura vista duas vezes (a página sincroniza de novo depois de uma gravação) conta uma vez só.
 */
export interface AbsenceTracker {
  /** Registra a leitura e devolve os ids ausentes há pelo menos `minReads` leituras seguidas. */
  observe(absent: readonly string[], read: object): ReadonlySet<string>;
  /** Leitura sem confiança: o que se contou até aqui não vale mais. */
  reset(): void;
}

export function createAbsenceTracker(minReads: number = ABSENCE_MIN_READS): AbsenceTracker {
  let counts = new Map<string, number>();
  let last: object | undefined;
  let confirmed: ReadonlySet<string> = new Set();
  return {
    observe(absent, read) {
      if (read === last) return confirmed;
      last = read;
      const next = new Map<string, number>();
      for (const id of absent) next.set(id, (counts.get(id) ?? 0) + 1);
      counts = next;
      confirmed = new Set([...next].filter(([, count]) => count >= minReads).map(([id]) => id));
      return confirmed;
    },
    reset() {
      counts = new Map();
      last = undefined;
      confirmed = new Set();
    },
  };
}

export interface SyncOptions {
  layout: CanvasLayout;
  /** Com ele, nó vivo só sai depois de faltar em leituras seguidas; sem ele (testes, uso pontual) sai na primeira leitura confiável. */
  absence?: AbsenceTracker;
  /** `false`: a leitura do grafo falhou ou veio incompleta; nenhum nó vivo sai. */
  trusted?: boolean;
  /** Tamanho do nó novo, por tipo (o `defaultSize` do registro de tipos). */
  sizeOf(type: string): { w: number; h: number };
}

export interface SyncResult {
  /** O mesmo objeto de entrada quando nada mudou. A revisão (`rev`) nunca muda aqui: é do servidor. */
  doc: CanvasDoc;
  added: string[];
  removed: string[];
  /** Subconjunto de `removed` que saiu por ser o mesmo pane de um terminal do documento (um pane, um nó). */
  duplicates: string[];
  /** Nós vivos do grafo que não ganharam nó porque o pane deles já é um terminal do documento: id do grafo → id do terminal. */
  claimed: Record<string, string>;
  /** Nós vivos ausentes do grafo que ficaram no documento, e por quê (`HeldReason`). */
  held: string[];
  heldReason?: HeldReason;
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

/** Pane de cada nó vivo do grafo que o herdr conhece. */
function graphPanes(nodes: GraphSnapshot["nodes"]): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of nodes) {
    const target = isLiveNodeType(node.type) ? herdrTargetOf(node.herdr) : undefined;
    if (target !== undefined && !out.has(node.id)) out.set(node.id, paneKey(target));
  }
  return out;
}

export function syncWithGraph(doc: CanvasDoc, graph: GraphSnapshot, options: SyncOptions): SyncResult {
  const trusted = options.trusted !== false;
  const inGraph = new Set(graph.nodes.map((node) => node.id));
  const absent = doc.nodes.filter((node) => isLiveNodeType(node.type) && !inGraph.has(node.id)).map((node) => node.id);
  const probe = mergeWithGraph(doc, graph.nodes, { trusted });
  if (probe.heldReason !== undefined) options.absence?.reset();
  const confirmedAbsent = probe.heldReason === undefined && options.absence ? options.absence.observe(absent, graph) : undefined;
  const base = confirmedAbsent === undefined ? probe : mergeWithGraph(doc, graph.nodes, { trusted, confirmedAbsent });

  // um pane, um nó: o agente do grafo cujo pane já é terminal do documento não ganha nó, e o que já ganhou antes sai
  const terminalAt = new Map<string, string>();
  for (const node of doc.nodes) {
    const target = terminalTargetOf(node);
    if (target !== undefined && !terminalAt.has(paneKey(target))) terminalAt.set(paneKey(target), node.id);
  }
  const panes = graphPanes(graph.nodes);
  const claimed: Record<string, string> = {};
  for (const [id, key] of panes) {
    const owner = terminalAt.get(key);
    if (owner !== undefined && owner !== id) claimed[id] = owner;
  }
  const duplicates = doc.nodes.filter((node) => claimed[node.id] !== undefined && isLiveNodeType(node.type) && !base.removed.includes(node.id)).map((node) => node.id);
  const merged = duplicates.length === 0 ? base : { ...base, doc: withoutNodes(base.doc, new Set(duplicates)), removed: [...base.removed, ...duplicates] };
  const held = base.held ?? [];
  const reason = base.heldReason !== undefined ? { heldReason: base.heldReason } : {};

  const room = Math.max(0, CANVAS_LIMITS.nodes - merged.doc.nodes.length);
  const unplaced = merged.unplaced.filter((id) => claimed[id] === undefined).sort(byId);
  const admitted = unplaced.slice(0, room);
  const skipped = unplaced.slice(room);

  if (admitted.length === 0 && merged.removed.length === 0) return { doc, added: [], removed: [], duplicates: [], claimed, held, ...reason, skipped, changed: false };

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
  return { doc: next, added: admitted, removed: merged.removed, duplicates, claimed, held, ...reason, skipped, changed: true };
}
