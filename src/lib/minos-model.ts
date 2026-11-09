// Minos: contrato dos modelos de saída (reference/minos.md). Cada modelo declara um formato JSON validado na fronteira; a
// sessão gera os dados, nunca o HTML. `orquestracao` sai do plano; `explicacao` e `proposta` (minos-doc.ts) saem de um
// JSON que a sessão escreve.
import { ContractError, SCOPES, type Scope, count, list, nullableNumber, obj, oneOf, text, utc } from "./minos-check.ts";
import { EXPLICACAO_EXAMPLE, PROPOSTA_EXAMPLE, validateExplanation, validateProposal } from "./minos-doc.ts";

export { ContractError, SCOPES, type Scope } from "./minos-check.ts";

export const ORQUESTRACAO_SCHEMA = 1;
export const AGENT_STATES = ["working", "idle", "blocked", "unknown", "done", "archived"] as const;
export type AgentState = (typeof AGENT_STATES)[number];
export const CONFIDENCES = ["alta", "media", "baixa", "nenhuma"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

const PCT_MAX = 100;

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

/**
 * Modelos publicáveis. `source` diz de onde vêm os dados: `plan` é o plano da orquestração (o coletor monta), `json` é o
 * arquivo de dados que a sessão escreve (o exemplo sai em `hades minos schema <modelo>`). O renderizador vive em minos-html.
 */
export const MODELS = {
  orquestracao: {
    title: "Orquestração", source: "plan", example: null, validate: validateOrchestration,
    describe: "acompanhamento da orquestração: plano, agentes, PRs, escalações e consumo",
  },
  explicacao: {
    title: "Explicação de código", source: "json", example: EXPLICACAO_EXAMPLE, validate: validateExplanation,
    describe: "explicação de código: resumo, fluxo passo a passo com arquivo:linha, trechos, arquivos, glossário e ressalvas",
  },
  proposta: {
    title: "Proposta", source: "json", example: PROPOSTA_EXAMPLE, validate: validateProposal,
    describe: "proposta ou discussão de implementação, correção, fluxo ou refatoração: problema, opções comparadas, recomendação, plano, riscos e perguntas",
  },
} as const;
export type ModelId = keyof typeof MODELS;
export const isModelId = (id: string): id is ModelId => Object.hasOwn(MODELS, id);
