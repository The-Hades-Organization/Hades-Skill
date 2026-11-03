// Próximo nó que precisa do dono no canvas do Argos (reference/argos.md §Ações (modelos puros)): permissão pendente,
// pergunta aberta ou gate falho, em ordem estável (prioridade, depois o que espera há mais tempo) e com ciclo. Lógica pura
// e sem Node; o tempo só entra como texto ISO com fuso, nunca como relógio.

/** Por que o nó precisa do dono, da mais urgente (o agente está parado agora) para a menos. */
export const OWNER_REASONS = ["permission", "question", "gate"] as const;
export type OwnerReason = (typeof OWNER_REASONS)[number];

export const OWNER_REASON_LABELS: Readonly<Record<OwnerReason, string>> = {
  permission: "Permissão pendente",
  question: "Pergunta aberta",
  gate: "Gate falho",
};

/** Estado de um nó `gate` que conta como falho (a fila de hoje só traz `running` e `waiting`; ver a doc). */
export const FAILED_GATE_STATE = "failed";

const CLOSED_STATES: ReadonlySet<string> = new Set(["done", "archived"]);
// Só instante com fuso explícito vale (texto sem fuso não é lido como hora local).
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** O que a ordem lê de um nó do grafo (campo a mais é ignorado). */
export interface NextNode {
  id: string;
  type: string;
  state?: string | null;
  registryState?: string | null;
  lastEventTs?: string | null;
  pendingPermission?: { ts: string; tool: string | null } | null;
  /** Títulos `Q<n> — assunto` sem resposta, do detalhe do nó (o grafo não os traz). */
  openQuestions?: readonly string[] | null;
  /** Agente cujo gate falhou; quem integra preenche (o grafo não traz o resultado do gate). */
  gateFailed?: boolean;
}

export interface OwnerItem {
  id: string;
  /** A razão de maior prioridade do nó. */
  reason: OwnerReason;
  /** Desde quando espera: o `ts` da permissão, senão o último evento; `null` sem instante válido (vai para o fim da razão). */
  since: string | null;
}

export type CycleDirection = "next" | "previous";

const instantMs = (value: string | null | undefined): number | undefined => {
  if (typeof value !== "string" || !ZONED_ISO.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

const isClosed = (node: NextNode): boolean => CLOSED_STATES.has(node.state ?? "") || CLOSED_STATES.has(node.registryState ?? "");

function reasonOf(node: NextNode): { reason: OwnerReason; since: string | null } | undefined {
  const lastEvent = instantMs(node.lastEventTs) === undefined ? null : (node.lastEventTs as string);
  if (node.type === "gate") return node.state === FAILED_GATE_STATE ? { reason: "gate", since: lastEvent } : undefined;
  if (node.type !== "agent" || isClosed(node)) return undefined;
  if (node.pendingPermission) {
    const ts = node.pendingPermission.ts;
    return { reason: "permission", since: instantMs(ts) === undefined ? lastEvent : ts };
  }
  if ((node.openQuestions?.length ?? 0) > 0) return { reason: "question", since: lastEvent };
  return node.gateFailed === true ? { reason: "gate", since: lastEvent } : undefined;
}

const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Os nós que precisam do dono, em ordem estável: prioridade da razão, depois o mais antigo primeiro, sem instante por
 * último e, no empate, o id (comparação por código, sem locale). Id repetido conta uma vez (vale o primeiro).
 */
export function ownerQueue(nodes: readonly NextNode[]): OwnerItem[] {
  const seen = new Set<string>();
  const items: OwnerItem[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const found = reasonOf(node);
    if (found) items.push({ id: node.id, ...found });
  }
  return items.sort((a, b) => {
    const priority = OWNER_REASONS.indexOf(a.reason) - OWNER_REASONS.indexOf(b.reason);
    if (priority !== 0) return priority;
    const left = instantMs(a.since) ?? Number.POSITIVE_INFINITY;
    const right = instantMs(b.since) ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left < right ? -1 : 1;
    return byCodepoint(a.id, b.id);
  });
}

/**
 * Anda na fila com ciclo: do último volta ao primeiro (e vice-versa). Sem `currentId` na fila (nada selecionado, ou o
 * nó selecionado já não precisa do dono), "próximo" vai ao primeiro e "anterior" ao último. Fila vazia: `undefined`;
 * com um só item, devolve esse item mesmo que seja o atual.
 */
export function cycleOwner(queue: readonly OwnerItem[], currentId: string | null | undefined, direction: CycleDirection): OwnerItem | undefined {
  if (queue.length === 0) return undefined;
  const at = currentId == null ? -1 : queue.findIndex((item) => item.id === currentId);
  if (at < 0) return direction === "next" ? queue[0] : queue[queue.length - 1];
  const step = direction === "next" ? 1 : queue.length - 1;
  return queue[(at + step) % queue.length];
}
