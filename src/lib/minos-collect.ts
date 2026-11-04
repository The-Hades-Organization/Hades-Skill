// Minos: monta os dados do modelo `orquestracao` do que a Hades já tem (plan.md, registro dos agentes, perguntas abertas,
// % das janelas de uso). Fonte ausente vira lista vazia ou null, nunca número inventado. `buildOrchestration` é pura; a
// leitura do ambiente fica em `collectOrchestration`.
import { join } from "node:path";
import { readText } from "./fs.ts";
import { janelaAtual } from "./minos-limits.ts";
import {
  AGENT_STATES, CONFIDENCES, ORQUESTRACAO_SCHEMA, validateOrchestration,
  type AgentState, type Confidence, type EstimateData, type OrchestrationData, type PlanUnitData, type Scope,
} from "./minos-model.ts";
import { openQuestionHeads } from "./argos.ts";
import { agentFiles, loadWorkEnv, readJson, DEFAULT_REPORTS, configValue, type Json } from "./work.ts";

const TEXT_CAP = 480;
const UNKNOWN_TITLE = "Orquestração";
const cap = (value: string): string => (value.length > TEXT_CAP ? `${value.slice(0, TEXT_CAP - 1)}…` : value);
const bare = (value: string): string => value.replaceAll("`", "").trim();
const cells = (row: string): string[] => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const EMPTY_CELL = /^(—|-|–|n\/a|nenhuma?)?$/i;

/** Linhas de `## <título>` até o próximo `## ` fora de bloco de código. */
export function sectionLines(plan: string, title: string): string[] {
  const lines = plan.replaceAll("\r", "").split("\n");
  const head = new RegExp(`^## ${title}([^A-Za-z0-9_]|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return [];
  const body: string[] = [];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && line.startsWith("## ")) break;
    body.push(line);
  }
  return body;
}

function tableRows(lines: string[]): { header: string[]; rows: string[][] } {
  const table = lines.filter((l) => l.trim().startsWith("|")).map(cells).filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
  const [header, ...rows] = table;
  return { header: (header ?? []).map((c) => c.toLowerCase()), rows };
}

const column = (header: string[], row: string[], pattern: RegExp): string => row[header.findIndex((h) => pattern.test(h))] ?? "";

export interface ParsedPlan { title: string; objective: string; state: string[]; units: PlanUnitData[]; estimate: EstimateData[] }

function numberOf(cell: string): number | null {
  const n = Number(cell.replace(",", ".").trim());
  return cell.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
}

export function parsePlan(plan: string): ParsedPlan {
  const title = /^#\s+(.+)$/m.exec(plan)?.[1]?.replace(/^Plano\s*[—–-]\s*/i, "").trim() || UNKNOWN_TITLE;
  const objective = sectionLines(plan, "Objetivo").filter((l) => l.trim() !== "" && !l.startsWith("<!--")).join(" ").trim();
  const state = sectionLines(plan, "Estado atual").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => cap(l.slice(2).replaceAll("**", "")));
  const units = (() => {
    const { header, rows } = tableRows(sectionLines(plan, "Unidades"));
    return rows.flatMap((row): PlanUnitData[] => {
      const name = bare(column(header, row, /^unidade/));
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) return [];
      const deps = column(header, row, /^depende/).split(/[,;]/).map(bare).filter((d) => !EMPTY_CELL.test(d));
      return [{ name, role: cap(bare(column(header, row, /^papel/))), dependsOn: deps }];
    });
  })();
  const estimate = (() => {
    const { header, rows } = tableRows(sectionLines(plan, "Estimativa"));
    return rows.flatMap((row): EstimateData[] => {
      const unit = bare(column(header, row, /^unidade/));
      if (unit === "") return [];
      const confidence = bare(column(header, row, /^confian/)).toLowerCase();
      return [{
        unit, costP50: numberOf(column(header, row, /^custo mediana/)), minutesP50: numberOf(column(header, row, /^dura..o mediana/)),
        confidence: (CONFIDENCES as readonly string[]).includes(confidence) ? (confidence as Confidence) : "nenhuma",
      }];
    });
  })();
  return { title: cap(title), objective: cap(objective), state, units, estimate };
}

export interface AgentSource {
  name: string; mode: string; state: string; phase: string; branch: string; pr: number | null; openQuestions: string[]; reportDone: boolean;
}

export interface OrchestrationInputs {
  planText: string;
  agents: AgentSource[];
  limits: OrchestrationData["consumption"]["limits"];
  scope: Scope;
  now: Date;
}

const agentState = (state: string): AgentState => ((AGENT_STATES as readonly string[]).includes(state) ? (state as AgentState) : "unknown");

export function buildOrchestration(input: OrchestrationInputs): OrchestrationData {
  const plan = parsePlan(input.planText);
  const agents = input.agents.map((a) => ({
    name: a.name, mode: a.mode, state: agentState(a.state), phase: cap(a.phase), branch: cap(a.branch), pr: a.pr,
    openQuestions: a.openQuestions.length, reportDone: a.reportDone,
  }));
  const seen = new Set<number>();
  const prs = input.agents.flatMap((a) => {
    if (a.pr === null || seen.has(a.pr)) return [];
    seen.add(a.pr);
    return [{ number: a.pr, branch: cap(a.branch), agent: a.name }];
  });
  const escalations = input.agents.flatMap((a) => a.openQuestions.map((question) => ({ agent: a.name, question: cap(question) })));
  const data: OrchestrationData = {
    model: "orquestracao", schema: ORQUESTRACAO_SCHEMA, scope: input.scope, generatedAt: `${input.now.toISOString().slice(0, 19)}Z`,
    plan: { title: plan.title, objective: plan.objective, state: plan.state, units: plan.units },
    agents, prs, escalations, consumption: { estimate: plan.estimate, limits: input.limits },
  };
  // o contrato é conferido na saída também: o que o coletor monta tem de valer para quem lê
  return validateOrchestration(data);
}

const prNumber = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function agentSource(record: Json, reportsDir: string): AgentSource {
  const w = join(str(record.worktree) || "/nonexistent", reportsDir);
  const questions = readText(join(w, "questions.md")) ?? "";
  const report = (readText(join(w, "report.md")) ?? "").trimStart();
  return {
    name: str(record.name), mode: str(record.mode), state: str(record.state), phase: str(record.phase), branch: str(record.branch),
    pr: prNumber(record.pr), openQuestions: openQuestionHeads(questions), reportDone: report.startsWith("STATUS: DONE"),
  };
}

export function collectOrchestration(planPath: string, scope: Scope, now: Date = new Date()): OrchestrationData {
  const planText = readText(planPath);
  if (planText === undefined) throw new Error(`plano não encontrado: ${planPath}`);
  const work = loadWorkEnv();
  const reportsDir = configValue("HADES_ORCH_REPORTS_DIR", DEFAULT_REPORTS);
  const agents = agentFiles(work).flatMap((file) => {
    const record = readJson(file);
    return record && str(record.name) !== "" ? [agentSource(record, reportsDir)] : [];
  });
  return buildOrchestration({ planText, agents, limits: { five: janelaAtual("five", now), seven: janelaAtual("seven", now) }, scope, now });
}
