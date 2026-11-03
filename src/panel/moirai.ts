// Rotas da Moirai (reference/moirai.md): GET /api/moirai/plan (estimado × real por plano e unidade) e
// GET /api/moirai/unit/:nome (uma unidade). Só leitura, mesma autenticação das outras rotas GET. O nome só chega aos
// transcripts depois de achado por igualdade entre os registros dos agentes: nunca vira caminho.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { currentCost, type CostCache } from "../commands/moirai.ts";
import { planHash } from "../lib/argos.ts";
import { readText } from "../lib/fs.ts";
import { budgetOf, DEFAULT_ASK_PCT, DEFAULT_WARN_PCT, parseSection, seconds, type EstimateRow } from "../lib/moirai.ts";
import { readJson } from "../lib/work.ts";
import type { Registry } from "./argos-graph.ts";

type Dict = Record<string, unknown>;

/** Código estável do erro (o texto não é contrato). */
export const MOIRAI_ERRORS = { invalidUnit: "invalid_unit", unknownUnit: "unknown_unit" } as const;

export class MoiraiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface MoiraiDeps {
  registries(): Registry[];
  config(): Record<string, string>;
  /** pasta dos transcripts do Claude (padrão: ~/.claude/projects) */
  projectsDir?: string;
  now?(): Date;
}

export interface MoiraiRoutes {
  plan(): Dict;
  unit(name: string, registry: string | undefined): Dict;
}

const UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function pct(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

interface Agent {
  registry: Registry;
  name: string;
  data: Dict;
}

function agentsOf(registry: Registry): Agent[] {
  const dir = join(registry.orch, "agents");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const found: Agent[] = [];
  for (const file of files) {
    const data = readJson(join(dir, file));
    if (data !== undefined && text(data.name) !== "") found.push({ registry, name: text(data.name), data });
  }
  return found;
}

export function createMoiraiRoutes(deps: MoiraiDeps): MoiraiRoutes {
  const now = (): Date => (deps.now ? deps.now() : new Date());
  // cache por unidade: cada pedido lê só o acréscimo dos transcripts
  const caches = new Map<string, CostCache>();

  const limits = (): { warnPct: number; askPct: number } => {
    const config = deps.config();
    return { warnPct: pct(config.HADES_MOIRAI_WARN_PCT, DEFAULT_WARN_PCT), askPct: pct(config.HADES_MOIRAI_ASK_PCT, DEFAULT_ASK_PCT) };
  };

  function real(agent: Agent): Dict {
    const key = `${agent.registry.slug}/${agent.name}`;
    const cache = caches.get(key) ?? {};
    caches.set(key, cache);
    const { costUsd } = currentCost(text(agent.data.worktree), cache, deps.projectsDir);
    const since = text(agent.data.createdAt) || text(agent.data.adoptedAt);
    const until = text(agent.data.doneAt) || text(agent.data.archivedAt) || now().toISOString();
    const wallS = since === "" ? null : seconds(since, until);
    return { costUsd, wallMin: wallS === null ? null : wallS / 60, state: text(agent.data.state) || null, phase: text(agent.data.phase) || text(agent.data.role) || null };
  }

  function row(estimate: EstimateRow | undefined, agent: Agent | undefined): Dict {
    const { warnPct, askPct } = limits();
    const actual = agent ? real(agent) : null;
    const budget = actual && estimate ? budgetOf(actual.costUsd as number, estimate.costP75, warnPct, askPct) : null;
    return {
      unit: estimate?.unit ?? agent?.name ?? "",
      estimate: estimate ?? null,
      real: actual,
      pct: budget?.pct ?? null,
      level: budget?.level ?? null,
    };
  }

  return {
    plan() {
      const { warnPct, askPct } = limits();
      const plans: Dict[] = [];
      for (const registry of deps.registries()) {
        const record = readJson(join(registry.orch, "plan.json"));
        const path = record ? text(record.path) : "";
        const body = path === "" ? undefined : readText(path);
        if (record === undefined || body === undefined) continue;
        const agents = agentsOf(registry);
        const rows = parseSection(body).map((estimate) => row(estimate, agents.find((a) => a.name === estimate.unit)));
        plans.push({ registry: registry.slug, path, approved: planHash(body) === text(record.sha), units: rows });
      }
      return { v: 1, warnPct, askPct, plans };
    },
    unit(name, registry) {
      if (!UNIT_PATTERN.test(name)) throw new MoiraiError(400, MOIRAI_ERRORS.invalidUnit, "nome de unidade inválido");
      const registries = deps.registries().filter((r) => registry === undefined || r.slug === registry);
      for (const r of registries) {
        const agent = agentsOf(r).find((a) => a.name === name);
        if (!agent) continue;
        const record = readJson(join(r.orch, "plan.json"));
        const body = record && text(record.path) !== "" ? readText(text(record.path)) : undefined;
        const estimate = body === undefined ? undefined : parseSection(body).find((e) => e.unit === name);
        const { warnPct, askPct } = limits();
        return { v: 1, warnPct, askPct, registry: r.slug, ...row(estimate, agent) };
      }
      throw new MoiraiError(404, MOIRAI_ERRORS.unknownUnit, "unidade desconhecida");
    },
  };
}
