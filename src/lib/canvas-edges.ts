// Estilo das arestas e arestas manuais do dono (reference/argos.md §Desenho e arestas). Lógica pura, sem Node/DOM.
// Criar e remover aresta manual saem como `AtomicOp` (`edge-create` / `edge-delete`) da pilha de desfazer, com o inverso
// exato que ela já calcula: aplicar e desfazer são `applyOp` e `undo` de `canvas-history`.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasEdge } from "./canvas-doc.ts";
import { type AtomicOp, opEdgeCreate, opEdgeDelete } from "./canvas-history.ts";

/** Kind das arestas que o dono desenha; as demais vêm do grafo vivo e não se removem pelo canvas. */
export const MANUAL_EDGE_KIND = "manual";

export const GRAPH_EDGE_KINDS = ["stack", "consolidation", "depends_on", "agent_pr", "agent_gate", "orchestrates"] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

/** Tom semântico (o painel mapeia para a cor do tema; o módulo não fixa cor). */
export type EdgeTone = "accent" | "info" | "warn" | "ok" | "muted";

export interface EdgeStyle {
  tone: EdgeTone;
  /** `stroke-dasharray`, ou `undefined` para linha cheia. */
  dash: string | undefined;
  width: number;
  /** Ponta de seta no destino. */
  arrow: boolean;
  /** Nome curto para legenda. */
  label: string;
  /** `false` quando o kind não é conhecido e o estilo é o neutro. */
  known: boolean;
}

const STYLES: Readonly<Record<GraphEdgeKind | typeof MANUAL_EDGE_KIND, Omit<EdgeStyle, "known">>> = {
  stack: { tone: "accent", dash: undefined, width: 2, arrow: true, label: "stack" },
  consolidation: { tone: "info", dash: "6 3", width: 2, arrow: true, label: "consolidação" },
  depends_on: { tone: "warn", dash: "2 3", width: 1.5, arrow: true, label: "depende de" },
  agent_pr: { tone: "ok", dash: undefined, width: 1.5, arrow: true, label: "agente → PR" },
  agent_gate: { tone: "muted", dash: "4 2", width: 1.5, arrow: true, label: "agente → gate" },
  orchestrates: { tone: "accent", dash: "1 3", width: 2, arrow: true, label: "orquestrador → agente" },
  manual: { tone: "muted", dash: "8 4", width: 2, arrow: true, label: "manual" },
};

const NEUTRAL: Omit<EdgeStyle, "known"> = { tone: "muted", dash: undefined, width: 1.5, arrow: false, label: "outro" };

/** Estilo por kind. Kind desconhecido (o documento aceita qualquer) recebe o neutro, com `known: false`. */
export function edgeStyle(kind: string): EdgeStyle {
  const base = Object.hasOwn(STYLES, kind) ? STYLES[kind as keyof typeof STYLES] : undefined;
  return base ? { ...base, known: true } : { ...NEUTRAL, known: false };
}

export const isManualEdge = (edge: CanvasEdge): boolean => edge.kind === MANUAL_EDGE_KIND;

/** Legenda: um item por kind conhecido, na ordem fixa (grafo e depois manual). */
export function edgeLegend(): { kind: string; style: EdgeStyle }[] {
  return [...GRAPH_EDGE_KINDS, MANUAL_EDGE_KIND].map((kind) => ({ kind, style: edgeStyle(kind) }));
}

/** Códigos estáveis: só ganham valores. */
export const EDGE_ERRORS = {
  invalidId: "edges_invalid_id",
  duplicateId: "edges_duplicate_id",
  duplicateEdge: "edges_duplicate_edge",
  danglingNode: "edges_dangling_node",
  selfLoop: "edges_self_loop",
  limitExceeded: "edges_limit_exceeded",
  missingEdge: "edges_missing_edge",
  notManual: "edges_not_manual",
} as const;
export type EdgeErrorCode = (typeof EDGE_ERRORS)[keyof typeof EDGE_ERRORS];

export class EdgeError extends Error {
  readonly code: EdgeErrorCode;
  constructor(code: EdgeErrorCode, message: string) {
    super(message);
    this.name = "EdgeError";
    this.code = code;
  }
}

const fail = (code: EdgeErrorCode, message: string): never => {
  throw new EdgeError(code, message);
};

const ID = /^[\w.:-]+$/;

/** Cria a operação de uma aresta manual do dono. Recusa nó inexistente, laço, par repetido, id inválido ou em uso e o teto. */
export function opCreateManualEdge(doc: CanvasDoc, id: string, from: string, to: string): AtomicOp {
  if (typeof id !== "string" || id.length === 0 || id.length > CANVAS_LIMITS.idChars || !ID.test(id)) return fail(EDGE_ERRORS.invalidId, "id da aresta inválido");
  if (doc.edges.some((edge) => edge.id === id)) return fail(EDGE_ERRORS.duplicateId, "id da aresta já existe");
  const known = new Set(doc.nodes.map((node) => node.id));
  if (!known.has(from) || !known.has(to)) return fail(EDGE_ERRORS.danglingNode, "aresta para nó que não existe");
  if (from === to) return fail(EDGE_ERRORS.selfLoop, "aresta de um nó para ele mesmo");
  if (doc.edges.some((edge) => isManualEdge(edge) && edge.from === from && edge.to === to)) return fail(EDGE_ERRORS.duplicateEdge, "já existe aresta manual entre os dois nós");
  if (doc.edges.length >= CANVAS_LIMITS.edges) return fail(EDGE_ERRORS.limitExceeded, "documento passaria do limite de arestas");
  return opEdgeCreate(doc, { id, from, to, kind: MANUAL_EDGE_KIND });
}

/** Remove uma aresta manual. Aresta do grafo vivo (outro kind) é recusada: ela volta na próxima mescla. */
export function opRemoveManualEdge(doc: CanvasDoc, id: string): AtomicOp {
  const edge = doc.edges.find((candidate) => candidate.id === id);
  if (!edge) return fail(EDGE_ERRORS.missingEdge, "aresta não existe no documento");
  if (!isManualEdge(edge)) return fail(EDGE_ERRORS.notManual, "só aresta manual se remove pelo canvas");
  return opEdgeDelete(doc, id);
}
