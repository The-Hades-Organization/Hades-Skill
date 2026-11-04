// Minos: contrato dos modelos de saída (reference/minos.md). Cada modelo declara um formato JSON validado na fronteira; a
// sessão gera os dados, nunca o HTML. v1: `orquestracao`. Os próximos (lote-de-reviews, post-mortem) entram em MODELS.

export const ORQUESTRACAO_SCHEMA = 1;
export const SCOPES = ["personal", "team"] as const;
export type Scope = (typeof SCOPES)[number];
export const AGENT_STATES = ["working", "idle", "blocked", "unknown", "done", "archived"] as const;
export type AgentState = (typeof AGENT_STATES)[number];
export const CONFIDENCES = ["alta", "media", "baixa", "nenhuma"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

const TEXT_MAX = 500;
const LIST_MAX = 200;
const PCT_MAX = 100;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export interface PlanUnitData { name: string; role: string; dependsOn: string[] }
export interface AgentData {
  name: string; mode: string; state: AgentState; phase: string; branch: string; pr: number | null; openQuestions: number; reportDone: boolean;
}
export interface PrData { number: number; branch: string; agent: string }
export interface EscalationData { agent: string; question: string }
export interface EstimateData { unit: string; costP50: number | null; minutesP50: number | null; confidence: Confidence }
export interface LimitData { pct: number; resetsAt: string }
export interface OrchestrationData {
  model: "orquestracao";
  schema: number;
  scope: Scope;
  generatedAt: string;
  plan: { title: string; objective: string; state: string[]; units: PlanUnitData[] };
  agents: AgentData[];
  prs: PrData[];
  escalations: EscalationData[];
  consumption: { estimate: EstimateData[]; limits: { five: LimitData | null; seven: LimitData | null } };
}

/** Recusa do contrato: o caminho do campo e o motivo, nunca o valor (ele pode ser segredo). */
export class ContractError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.path = path;
    this.name = "ContractError";
  }
}

type Obj = Record<string, unknown>;

function obj(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ContractError(path, "esperava um objeto");
  return value as Obj;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ContractError(path, "esperava texto");
  if (value.length > TEXT_MAX) throw new ContractError(path, `texto acima de ${TEXT_MAX} caracteres`);
  return value;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ContractError(path, "esperava uma lista");
  if (value.length > LIST_MAX) throw new ContractError(path, `lista acima de ${LIST_MAX} itens`);
  return value;
}

function count(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new ContractError(path, "esperava inteiro não negativo");
  return value;
}

function nullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ContractError(path, "esperava número finito não negativo ou null");
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new ContractError(path, `esperava um de ${allowed.join(", ")}`);
  return value as T;
}

function utc(value: unknown, path: string): string {
  const t = text(value, path);
  if (!ISO_UTC.test(t) || Number.isNaN(Date.parse(t))) throw new ContractError(path, "esperava instante ISO 8601 em UTC (com Z)");
  return t;
}

function limit(value: unknown, path: string): LimitData | null {
  if (value === null) return null;
  const o = obj(value, path);
  const pct = nullableNumber(o.pct, `${path}.pct`);
  if (pct === null || pct > PCT_MAX) throw new ContractError(`${path}.pct`, `esperava número de 0 a ${PCT_MAX}`);
  return { pct, resetsAt: utc(o.resetsAt, `${path}.resetsAt`) };
}

export function validateOrchestration(input: unknown): OrchestrationData {
  const o = obj(input, "$");
  if (o.model !== "orquestracao") throw new ContractError("model", 'esperava "orquestracao"');
  if (o.schema !== ORQUESTRACAO_SCHEMA) throw new ContractError("schema", `versão ${String(o.schema)} não suportada (esta é a ${ORQUESTRACAO_SCHEMA})`);
  const plan = obj(o.plan, "plan");
  const consumption = obj(o.consumption, "consumption");
  const limits = obj(consumption.limits, "consumption.limits");
  return {
    model: "orquestracao",
    schema: ORQUESTRACAO_SCHEMA,
    scope: oneOf(o.scope, SCOPES, "scope"),
    generatedAt: utc(o.generatedAt, "generatedAt"),
    plan: {
      title: text(plan.title, "plan.title"),
      objective: text(plan.objective, "plan.objective"),
      state: list(plan.state, "plan.state").map((s, i) => text(s, `plan.state[${i}]`)),
      units: list(plan.units, "plan.units").map((u, i) => {
        const x = obj(u, `plan.units[${i}]`);
        return {
          name: text(x.name, `plan.units[${i}].name`), role: text(x.role, `plan.units[${i}].role`),
          dependsOn: list(x.dependsOn, `plan.units[${i}].dependsOn`).map((d, j) => text(d, `plan.units[${i}].dependsOn[${j}]`)),
        };
      }),
    },
    agents: list(o.agents, "agents").map((a, i) => {
      const x = obj(a, `agents[${i}]`);
      const pr = x.pr === null ? null : count(x.pr, `agents[${i}].pr`);
      if (typeof x.reportDone !== "boolean") throw new ContractError(`agents[${i}].reportDone`, "esperava booleano");
      return {
        name: text(x.name, `agents[${i}].name`), mode: text(x.mode, `agents[${i}].mode`), state: oneOf(x.state, AGENT_STATES, `agents[${i}].state`),
        phase: text(x.phase, `agents[${i}].phase`), branch: text(x.branch, `agents[${i}].branch`), pr,
        openQuestions: count(x.openQuestions, `agents[${i}].openQuestions`), reportDone: x.reportDone,
      };
    }),
    prs: list(o.prs, "prs").map((p, i) => {
      const x = obj(p, `prs[${i}]`);
      return { number: count(x.number, `prs[${i}].number`), branch: text(x.branch, `prs[${i}].branch`), agent: text(x.agent, `prs[${i}].agent`) };
    }),
    escalations: list(o.escalations, "escalations").map((e, i) => {
      const x = obj(e, `escalations[${i}]`);
      return { agent: text(x.agent, `escalations[${i}].agent`), question: text(x.question, `escalations[${i}].question`) };
    }),
    consumption: {
      estimate: list(consumption.estimate, "consumption.estimate").map((e, i) => {
        const x = obj(e, `consumption.estimate[${i}]`);
        return {
          unit: text(x.unit, `consumption.estimate[${i}].unit`), costP50: nullableNumber(x.costP50, `consumption.estimate[${i}].costP50`),
          minutesP50: nullableNumber(x.minutesP50, `consumption.estimate[${i}].minutesP50`),
          confidence: oneOf(x.confidence, CONFIDENCES, `consumption.estimate[${i}].confidence`),
        };
      }),
      limits: { five: limit(limits.five, "consumption.limits.five"), seven: limit(limits.seven, "consumption.limits.seven") },
    },
  };
}

/** Modelos publicáveis. Um modelo novo entra aqui com o validador; o renderizador e o coletor vivem em minos-html e minos-collect. */
export const MODELS = {
  orquestracao: { title: "Orquestração", describe: "acompanhamento da orquestração: plano, agentes, PRs, escalações e consumo", validate: validateOrchestration },
} as const;
export type ModelId = keyof typeof MODELS;
export const isModelId = (id: string): id is ModelId => Object.hasOwn(MODELS, id);
