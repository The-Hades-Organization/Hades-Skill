// Ação em lote sobre a seleção do canvas do Argos (reference/argos.md §Ações (modelos puros)): quais nós são alvo, quais
// ficam de fora e por quê, o texto do efeito para a confirmação do dono e o resultado por agente a partir das respostas da
// rota. Lógica pura e sem Node: nada aqui dispara requisição; quem chama faz os POSTs, um por agente. Ação destrutiva só
// gera os pedidos depois de o dono digitar a confirmação.
import { actionRequest, actionsFor, isDangerousAction, type ActionContext, type ActionNode, type ActionReasonCode, type ActionRequest } from "./canvas-actions.ts";
import type { ActionName } from "../panel/argos-actions.ts";

/** Ações que valem para vários agentes de uma vez com os mesmos argumentos (as outras pedem algo por agente). */
export const BATCH_ACTIONS = ["resume", "prompt", "phase", "park", "approve_permission", "deny_permission", "done"] as const satisfies readonly ActionName[];

/** Teto de alvos num lote: acima disso o lote é recusado, não truncado (a rota pode esperar minutos por agente). */
export const BATCH_MAX_TARGETS = 50;
const NAMES_SHOWN = 10;
const MESSAGE_MAX = 300;

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const BATCH_ERRORS = {
  actionNotSupported: "batch_action_not_supported",
  emptySelection: "batch_empty_selection",
  tooLarge: "batch_too_large",
  missingArgs: "batch_missing_args",
  noValidTargets: "batch_no_valid_targets",
  confirmRequired: "batch_confirm_required",
  noResponse: "batch_no_response",
  unexpectedResponse: "batch_unexpected_response",
} as const;
export type BatchErrorCode = (typeof BATCH_ERRORS)[keyof typeof BATCH_ERRORS];

/** Motivo de um nó ficar de fora: o da ação indisponível (`canvas-actions`) ou o de não ser agente. */
export interface BatchExclusion {
  id: string;
  label: string;
  code: ActionReasonCode;
  reason: string;
}

export interface BatchTarget {
  id: string;
  label: string;
}

export interface BatchPlan {
  action: ActionName;
  args: Record<string, unknown>;
  targets: BatchTarget[];
  excluded: BatchExclusion[];
  dangerous: boolean;
  /** Texto para a confirmação do dono: o que vai acontecer e com quem. */
  effect: string;
  /** Só em ação destrutiva: o que o dono digita (a quantidade de alvos) para liberar os pedidos. */
  confirmPhrase?: string;
  /** Impede o lote (nenhum pedido sai); `targets` e `excluded` seguem preenchidos para a tela explicar. */
  problem?: BatchErrorCode;
}

const EFFECTS: Readonly<Record<(typeof BATCH_ACTIONS)[number], (args: Record<string, unknown>) => string>> = {
  resume: () => "Retomar",
  prompt: (args) => (typeof args.text === "string" ? `Enviar um prompt de ${args.text.length} caracteres a` : "Enviar a tarefa padrão do brief a"),
  phase: (args) => `Mudar a fase para "${String(args.phase)}" de`,
  park: () => "Estacionar (handoff.md com STATUS: PARKED)",
  approve_permission: () => "Aprovar a permissão pendente (Enter, opção \"Yes\" simples) de",
  deny_permission: () => "Negar a permissão pendente (Escape) de",
  done: () => "ENCERRAR (hades agent done, destrutivo)",
};

const isBatchAction = (key: ActionName): key is (typeof BATCH_ACTIONS)[number] => (BATCH_ACTIONS as readonly string[]).includes(key);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function describeEffect(action: ActionName, args: Record<string, unknown>, targets: readonly BatchTarget[], excluded: number): string {
  if (!isBatchAction(action) || targets.length === 0) return "";
  const names = targets.slice(0, NAMES_SHOWN).map((t) => t.label).join(", ");
  const more = targets.length > NAMES_SHOWN ? ` e mais ${targets.length - NAMES_SHOWN}` : "";
  const noun = targets.length === 1 ? "agente" : "agentes";
  const left = excluded === 0 ? "" : ` ${excluded} ${excluded === 1 ? "nó fica" : "nós ficam"} de fora.`;
  return `${EFFECTS[action](args)} ${targets.length} ${noun}: ${names}${more}.${left}`;
}

const NOT_AGENT: Pick<BatchExclusion, "code" | "reason"> = { code: "action_not_agent", reason: "só agentes recebem ação" };

/**
 * Monta o lote para `action` sobre os nós selecionados (a ordem da seleção, id repetido conta uma vez). Cada nó entra se a
 * ação vale para ele agora (`actionsFor`); senão fica de fora com o motivo. `problem` diz se o lote não pode sair: ação que
 * não é de lote, seleção vazia ou acima de `BATCH_MAX_TARGETS`, argumento obrigatório faltando, ou nenhum alvo válido.
 */
export function planBatch(selection: readonly ActionNode[], action: ActionName, args: Record<string, unknown> = {}, ctx: ActionContext = {}): BatchPlan {
  const base = { action, args, targets: [] as BatchTarget[], excluded: [] as BatchExclusion[], dangerous: isDangerousAction(action), effect: "" };
  if (!isBatchAction(action)) return { ...base, problem: BATCH_ERRORS.actionNotSupported };
  if (selection.length === 0) return { ...base, problem: BATCH_ERRORS.emptySelection };
  if (selection.length > BATCH_MAX_TARGETS) return { ...base, problem: BATCH_ERRORS.tooLarge };

  const seen = new Set<string>();
  let required: readonly string[] = [];
  for (const node of selection) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const item = actionsFor(node, ctx).find((i) => i.key === action);
    if (!item) base.excluded.push({ id: node.id, label: node.label, ...NOT_AGENT });
    else if (!item.available && item.reason) base.excluded.push({ id: node.id, label: node.label, code: item.reason.code, reason: item.reason.message });
    else {
      base.targets.push({ id: node.id, label: node.label });
      required = item.fields.filter((f) => f.required).map((f) => f.name);
    }
  }

  // Os campos obrigatórios da ação não dependem do nó nas ações de lote; a rota ainda valida o formato por agente.
  const missing = required.some((name) => typeof args[name] !== "string" || (args[name] as string).trim() === "");
  const effect = describeEffect(action, args, base.targets, base.excluded.length);
  const confirmPhrase = base.dangerous && base.targets.length > 0 ? { confirmPhrase: String(base.targets.length) } : {};
  const problem = base.targets.length === 0 ? BATCH_ERRORS.noValidTargets : missing ? BATCH_ERRORS.missingArgs : undefined;
  return { ...base, effect, ...confirmPhrase, ...(problem ? { problem } : {}) };
}

export type BatchRequests = { ok: true; requests: ActionRequest[] } | { ok: false; code: BatchErrorCode };

/**
 * Os pedidos do lote, um por alvo, na ordem do plano. Lote com `problem` não gera nada. Ação destrutiva só gera depois
 * de `typed` ser igual a `plan.confirmPhrase`; cada pedido leva o `confirm` do próprio agente (o servidor confere por alvo).
 */
export function batchRequests(plan: BatchPlan, typed?: string): BatchRequests {
  if (plan.problem) return { ok: false, code: plan.problem };
  if (plan.dangerous && (plan.confirmPhrase === undefined || typed?.trim() !== plan.confirmPhrase)) return { ok: false, code: BATCH_ERRORS.confirmRequired };
  const requests = plan.targets.map((t) => actionRequest(t, plan.action, plan.args, plan.dangerous ? t.label : undefined));
  return { ok: true, requests };
}

/** O que a rota respondeu a um alvo: HTTP e corpo já lidos; `status: 0` = sem resposta (rede, aborto). */
export interface BatchResponse {
  id: string;
  status: number;
  body?: unknown;
}

export type BatchOutcome = "ok" | "refused" | "error" | "pending";

export interface BatchItemResult {
  id: string;
  label: string;
  outcome: BatchOutcome;
  /** O `code` da rota (ou `batch_no_response`/`batch_unexpected_response`); ausente em `ok` e `pending`. */
  code?: string;
  message?: string;
}

export interface BatchResult {
  items: BatchItemResult[];
  excluded: BatchExclusion[];
  totals: Record<BatchOutcome, number>;
  /** Todos os alvos já têm resposta. */
  finished: boolean;
}

function classify(response: BatchResponse): Omit<BatchItemResult, "id" | "label"> {
  const { status, body } = response;
  if (status === 0) return { outcome: "error", code: BATCH_ERRORS.noResponse };
  if (status >= 200 && status < 300 && isRecord(body) && body.ok === true) return { outcome: "ok" };
  const code = isRecord(body) && typeof body.code === "string" ? body.code : undefined;
  const message = isRecord(body) && typeof body.error === "string" ? clip(body.error, MESSAGE_MAX) : undefined;
  // 4xx com `code`: a rota ou o herdr recusou (argumento, confirmação, permissão, comando); o resto (5xx, corpo estranho) é erro.
  const outcome: BatchOutcome = status >= 400 && status < 500 && code !== undefined ? "refused" : "error";
  return { outcome, code: code ?? BATCH_ERRORS.unexpectedResponse, ...(message === undefined ? {} : { message }) };
}

/**
 * Resultado por agente. Alvo sem resposta ainda fica `pending` (dá para mostrar o andamento); resposta de id que não é
 * alvo é ignorada; duas respostas ao mesmo alvo valem pela última.
 */
export function summarizeBatch(plan: BatchPlan, responses: readonly BatchResponse[]): BatchResult {
  const byId = new Map<string, BatchResponse>();
  for (const response of responses) byId.set(response.id, response);
  const totals: Record<BatchOutcome, number> = { ok: 0, refused: 0, error: 0, pending: 0 };
  const items = plan.targets.map((target): BatchItemResult => {
    const response = byId.get(target.id);
    const result = response === undefined ? { outcome: "pending" as const } : classify(response);
    totals[result.outcome] += 1;
    return { id: target.id, label: target.label, ...result };
  });
  return { items, excluded: plan.excluded, totals, finished: totals.pending === 0 };
}
