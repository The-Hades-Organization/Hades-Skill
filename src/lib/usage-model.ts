// Modelo real × configurado (HADES_MODEL_<PAPEL>): a conta do Consumo (por linha de sessão) e a varredura do watch (por
// transcrição). Funções puras sobre o registro do agente e as linhas já lidas; quem lê configuração e disco injeta.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveModelKey, tokCost } from "./price.ts";
import type { Row } from "./usage.ts";

export interface Expected {
  model?: string;
  effort?: string;
}
export type ExpectedOf = (role: string) => Expected;

/** O que do registro do agente a comparação lê. */
export interface AgentRecord {
  role?: unknown;
  escalatedAt?: unknown;
}

export interface ModelDivergence {
  /** Chave do modelo real (price.ts). */
  real: string;
  turns: number;
  /** US$ reais menos US$ no modelo configurado, para os mesmos tokens. */
  extraCost: number;
}

export interface AgentDivergence {
  /** Modelo configurado do papel, como resolvido na tabela de preço. */
  configured: string;
  models: ModelDivergence[];
  extraCost: number;
  /** Só quando o esforço é observável nas duas pontas e difere. */
  effort?: { real: string; configured: string };
}

const OBSERVED_EFFORT_NONE = "?";

const epochMs = (iso: unknown): number => (typeof iso === "string" ? Date.parse(iso) || 0 : 0);

/**
 * Sessão aberta pela escalada da própria Hades (`agent escalate` grava `escalatedAt`): nasce depois dela, então a linha
 * cuja primeira requisição é posterior não é comparada com o papel.
 */
export function startedAfterEscalation(record: AgentRecord | undefined, firstTs: string): boolean {
  const at = epochMs(record?.escalatedAt);
  return at > 0 && epochMs(firstTs) >= at;
}

/** O esforço mais frequente que a transcrição registrou; undefined quando ela não diz (não observável). */
function observedEffort(efforts: Record<string, number>): string | undefined {
  const known = Object.entries(efforts).filter(([name]) => name !== OBSERVED_EFFORT_NONE).sort((a, b) => b[1] - a[1]);
  return known[0]?.[0];
}

/** Divergência das linhas principais de um agente (subagente tem modelo próprio e fica fora); undefined sem divergência. */
export function agentDivergence(rows: Row[], record: AgentRecord | undefined, expected: Expected): AgentDivergence | undefined {
  const configured = resolveModelKey(expected.model);
  const effortWanted = expected.effort?.trim().toLowerCase() || undefined;
  const byModel = new Map<string, ModelDivergence>();
  const efforts: Record<string, number> = {};
  for (const row of rows) {
    if (row.sidechain || startedAfterEscalation(record, row.first)) continue;
    for (const [effort, count] of Object.entries(row.efforts)) efforts[effort] = (efforts[effort] ?? 0) + count;
    if (configured === undefined) continue;
    for (const [real, tok] of Object.entries(row.tok)) {
      if (real === configured) continue;
      const slot = byModel.get(real) ?? { real, turns: 0, extraCost: 0 };
      slot.turns += row.models[real] ?? 0;
      slot.extraCost += tokCost(real, tok) - tokCost(configured, tok);
      byModel.set(real, slot);
    }
  }
  const realEffort = observedEffort(efforts);
  const effort = effortWanted !== undefined && realEffort !== undefined && realEffort.toLowerCase() !== effortWanted ? { real: realEffort, configured: effortWanted } : undefined;
  if (byModel.size === 0 && effort === undefined) return undefined;
  const models = [...byModel.values()];
  return { configured: configured ?? "", models, extraCost: models.reduce((sum, m) => sum + m.extraCost, 0), ...(effort ? { effort } : {}) };
}

/** Modelo da linha que mais turnos tem (a coluna "modelo" da lista de agentes). */
export function dominantModel(models: Record<string, number>): string {
  return Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

// ---------------------------------------------------------------- watch

export interface FirstDivergence {
  session: string;
  real: string;
}

interface TurnLine {
  timestamp?: unknown;
  message?: { model?: unknown };
}

const parseLine = (line: string): TurnLine | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as TurnLine) : undefined;
  } catch {
    return undefined;
  }
};

/** Transcrição mais recente da pasta do cwd em `~/.claude/projects` (a mesma regra do `contextOfDir`). */
export function newestTranscript(cwd: string, home: string): string | undefined {
  const project = join(home, ".claude", "projects", cwd.replace(/\/+$/, "").replace(/[/.]/g, "-"));
  let newest: { file: string; mtime: number } | undefined;
  try {
    for (const name of readdirSync(project)) {
      if (!name.endsWith(".jsonl")) continue;
      const mtime = statSync(join(project, name)).mtimeMs;
      if (!newest || mtime >= newest.mtime) newest = { file: join(project, name), mtime };
    }
  } catch {
    return undefined;
  }
  return newest?.file;
}

/** Divergência de modelo da sessão mais recente do worktree do agente, com o modelo configurado já resolvido; undefined quando não há. */
export function agentModelMismatch(worktree: string, record: AgentRecord | undefined, configuredModel: string | undefined, home: string): (FirstDivergence & { configured: string }) | undefined {
  const configured = resolveModelKey(configuredModel);
  const file = worktree === "" || configured === undefined ? undefined : newestTranscript(worktree, home);
  const found = file ? firstDivergence(file, record, configuredModel) : undefined;
  return found && configured !== undefined ? { ...found, configured } : undefined;
}

/**
 * O primeiro turno da transcrição cujo modelo difere do configurado. Sessão aberta pela escalada, modelo configurado que
 * a tabela de preço não conhece ou turno de modelo desconhecido (`<synthetic>`) não contam.
 */
export function firstDivergence(file: string, record: AgentRecord | undefined, configuredModel: string | undefined): FirstDivergence | undefined {
  const configured = resolveModelKey(configuredModel);
  if (configured === undefined) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const session = file.replace(/^.*\//, "").replace(/\.jsonl$/, "");
  let first = "";
  for (const raw of text.split("\n")) {
    if (!raw.includes('"model"')) continue;
    const line = parseLine(raw);
    if (line === undefined) continue;
    if (first === "" && typeof line.timestamp === "string") first = line.timestamp;
    if (startedAfterEscalation(record, first)) return undefined;
    const real = resolveModelKey(line.message?.model);
    if (real !== undefined && real !== configured) return { session, real };
  }
  return undefined;
}
