// Argos: o grafo dos agentes (GET /api/argos/graph) e o detalhe de um nó (GET /api/argos/node/:id). Só leitura: registros
// do orquestrador (o do projeto e o _skill), plano aprovado, estado shardado das entregas, fila de gates, herdr, diário e
// `gh pr view` (só no detalhe). Nenhum caminho nem id vem do cliente sem passar pelo registro.
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ARGOS_ERRORS, ARGOS_SCHEMA_VERSION, ArgosError, type EdgeKind, type FileSummary, type NodeType, type PendingPermission, nodeId, openQuestionHeads,
  parseNodeId, parsePlanUnits, pendingPermission, planHash, summarizeFile, tailEvents,
} from "../lib/argos.ts";
import { currentCost, type CostCache } from "../commands/moirai.ts";
import { agentShortId, herdrRefOf, orchestratorOf, roundOf, type HerdrRef } from "../lib/argos-graph-ui.ts";
import { readText } from "../lib/fs.ts";
import { type JournalEvent, parseEvent, parseSince, readTailText } from "../lib/journal.ts";
import { parseSection } from "../lib/moirai.ts";
import { agentRoleOf, contextOfDir } from "../lib/guard-hook.ts";
import { home } from "../lib/paths.ts";
import { agentModelMismatch } from "../lib/usage-model.ts";
import { exec } from "./exec.ts";
import type { Herdr } from "./herdr.ts";
import { LIMIT_DEFAULT, LIMIT_MAX } from "./journal.ts";

type Dict = Record<string, unknown>;

export const SKILL_REGISTRY = "_skill";
const DEFAULT_REPORTS_DIR = ".design-sync-reports";
const AGENT_LIST_TTL_S = 3;
const GH_TIMEOUT_MS = 15_000;
const PR_TTL_MS = 30_000;
const ESTIMATE_TTL_MS = 5_000;
/** Bytes novos de transcript lidos por chamada do grafo: o resto fica para a próxima, sem custo parcial no nó. */
const COST_READ_BUDGET_BYTES = 16 * 1024 * 1024;
/** `gh pr view` do grafo em segundo plano, no máximo este tanto ao mesmo tempo. */
const PR_REFRESH_MAX = 4;
const GATE_RUNNING = new Set(["running", "lease"]);
const GATE_FAILED_KIND = "gate.timeout";
const GATE_DONE_KIND = "gate.done";
const GATE_RC = /\brc=(\d+)/;
const REGISTRY_DONE = new Set(["done", "archived"]);
const HOUR_MS = 3_600_000;

/** Fontes do diário que são o próprio agente agindo; `watch`, `cerberus` e `orch` observam e seguem escrevendo sobre agente parado. */
const ACTIVITY_SOURCES = new Set(["guard", "gate"]);

/** Último sinal de vida do agente: o maior instante `*At` do registro e o último evento de atividade dele no diário; sem nenhum, `undefined`. */
export function lastActivityMs(data: Dict, tail: JournalEvent[]): number | undefined {
  let last: number | undefined;
  const take = (value: unknown): void => {
    const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (!Number.isNaN(ms) && (last === undefined || ms > last)) last = ms;
  };
  for (const [key, value] of Object.entries(data)) if (key.endsWith("At")) take(value);
  for (let i = tail.length - 1; i >= 0; i--) {
    const event = tail[i] as JournalEvent;
    if (ACTIVITY_SOURCES.has(event.source)) {
      take(event.ts);
      break;
    }
  }
  return last;
}
/** Campo `files` do nó do agente: caminhos relativos à worktree dos arquivos que existem (brief, report, questions, handoff). */
export type AgentNodeFiles = string[];

const FILES = { brief: "brief.md", report: "report.md", questions: "questions.md", handoff: "handoff.md" } as const;

export interface Registry {
  /** nome da pasta em <raiz de trabalho>: `_skill` ou `<owner>__<repo>` */
  slug: string;
  /** <raiz>/<slug>/orchestration */
  orch: string;
}

export interface GraphDeps {
  /** os registros lidos, o do projeto primeiro */
  registries(): Registry[];
  journalRoot(): string;
  herdr: Herdr;
  /** a fila do gate-lock (o `gates` de gatewatch.detail()) */
  gates(): Dict[];
  reportsDir(): string;
  env?: Record<string, string | undefined>;
  now?(): Date;
  /** pasta dos transcripts do Claude (padrão: ~/.claude/projects), de onde sai o custo do nó */
  projectsDir?: string;
  /** bytes novos de transcript lidos por chamada do grafo (padrão: `COST_READ_BUDGET_BYTES`) */
  costBudgetBytes?: number;
  /** horas sem atividade a partir das quais o agente sai do grafo (`HADES_ARGOS_AGENT_MAX_AGE_H`, padrão 24 no catálogo); ausente ou 0 = sem corte */
  agentMaxAgeHours?(): number;
  /** teto de contexto (tokens) do papel; ausente = o nó não é marcado (`ctxCapOf`, das Configurações) */
  ctxCap?(role: string): number;
  /** contexto atual (tokens) da sessão mais recente da worktree (padrão: `contextOfDir`) */
  contextOf?(worktree: string): number;
  /** modelo configurado (HADES_MODEL_<PAPEL>) do papel; ausente = o nó não é marcado por modelo diferente do configurado */
  modelOf?(role: string): string | undefined;
}

interface AgentRecord {
  registry: Registry;
  name: string;
  data: Dict;
}

export interface Graph {
  graph(): Promise<Dict>;
  node(id: string, query: Record<string, string>): Promise<Dict>;
  /** O registro do agente do nó; `unknown_node` se não existe ou não é de agente. É a única porta dos ids do cliente. */
  agentOf(id: string): AgentRecord;
  /** Estado vivo do agente (herdr e permissão pendente), para decidir ações que dependem dele. */
  live(id: string): Promise<{ herdrState: string; pending: PendingPermission | null }>;
}

const asDict = (value: unknown): Dict => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const stripOrigin = (ref: string): string => ref.replace(/^origin\//, "");
const jsonOf = (path: string): Dict => {
  try {
    return asDict(JSON.parse(readText(path) ?? ""));
  } catch {
    return {};
  }
};
/** Campo opcional que não tem dado não existe no nó: nada de zero nem texto vazio inventado. */
const definedOnly = (fields: Dict): Dict => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
const jsonFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
};

export function createGraph(deps: GraphDeps): Graph {
  const now = (): Date => (deps.now ? deps.now() : new Date());
  const prCache = new Map<string, { t: number; value: Dict }>();
  const prInflight = new Map<string, Promise<Dict>>();
  // custo por agente: cache incremental por arquivo de transcript (só o acréscimo é lido) e o último total completo
  const costCaches = new Map<string, CostCache>();
  const costLast = new Map<string, number>();
  const estimateCache = new Map<string, { t: number; byUnit: Map<string, number> }>();

  interface NodeContext {
    gates: Dict[];
    /** bytes de transcript que ainda podem ser lidos nesta chamada */
    budget: { left: number };
  }

  function agents(): AgentRecord[] {
    const out: AgentRecord[] = [];
    for (const registry of deps.registries()) {
      for (const file of jsonFiles(join(registry.orch, "agents"))) {
        const data = jsonOf(join(registry.orch, "agents", file));
        const name = text(data.name);
        if (name) out.push({ registry, name, data });
      }
    }
    return out;
  }

  /** O `herdr agent list`, em cache curto. Vazio (e `available: false`) se o herdr falta ou está fora do ar. */
  const herdrAgents = (): Promise<{ available: boolean; rows: Dict[] }> =>
    deps.herdr.cached("\0argos-agents", async () => {
      const result = await deps.herdr.json(null, ["agent", "list"]);
      const rows = result?.agents;
      return { available: Array.isArray(rows), rows: Array.isArray(rows) ? (rows as Dict[]) : [] };
    }, AGENT_LIST_TTL_S);

  const hostOf = (rows: Dict[], a: AgentRecord): Dict | undefined => {
    const pane = text(a.data.pane);
    const tree = text(a.data.worktree);
    return rows.find((h) => h.name === a.name || (pane !== "" && h.pane_id === pane) || (tree !== "" && h.cwd === tree));
  };

  const journalFile = (a: AgentRecord): string => join(deps.journalRoot(), a.registry.slug, "journal", `${a.name}.jsonl`);
  const journalTail = (a: AgentRecord): JournalEvent[] => tailEvents([journalFile(a).replace(/\.jsonl$/, ".1.jsonl"), journalFile(a)], 64 * 1024);

  function planOf(registry: Registry): { approved: boolean | null; units: ReturnType<typeof parsePlanUnits> } {
    const record = jsonOf(join(registry.orch, "plan.json"));
    const path = text(record.path);
    const body = path ? readText(path) : undefined;
    if (body === undefined) return { approved: null, units: [] };
    // plano mudado depois da aprovação não vale como contrato: sem arestas dele
    const approved = planHash(body) === text(record.sha);
    return { approved, units: approved ? parsePlanUnits(body) : [] };
  }

  const deliveryOf = (a: AgentRecord): Dict => asDict(asDict(jsonOf(join(dirname(a.registry.orch), "state", "global.json")).deliveries)[text(a.data.key)]);
  const prNumberOf = (a: AgentRecord, delivery: Dict = deliveryOf(a)): number | null => {
    const number = Number(a.data.pr ?? delivery.pr);
    return Number.isInteger(number) && number > 0 ? number : null;
  };

  /** O gate da fila que é do agente: `--label` igual ao nome, ou o clone dentro da worktree. */
  const gateBelongs = (gate: Dict, a: AgentRecord): boolean => {
    const tree = text(a.data.worktree);
    const clone = text(gate.clone);
    return text(gate.label) === a.name || (tree !== "" && (clone === tree || clone.startsWith(`${tree}/`)));
  };

  /**
   * Gate do agente: com gate vivo na fila, rodando ou na fila (a fila é a verdade); sem ele, `failed` se o último gate
   * encerrado do diário reprovou (rc diferente de zero ou timeout) e nada rodou depois. Sem gate, sem campo.
   */
  function gateStateOf(a: AgentRecord, tail: JournalEvent[], gates: Dict[]): "running" | "waiting" | "failed" | undefined {
    const mine = gates.filter((g) => gateBelongs(g, a));
    if (mine.some((g) => GATE_RUNNING.has(text(g.state)))) return "running";
    if (mine.length > 0) return "waiting";
    const last = tail.findLast((e) => e.source === "gate" && (e.kind === GATE_DONE_KIND || e.kind === GATE_FAILED_KIND));
    if (!last) return undefined;
    if (last.kind === GATE_FAILED_KIND) return "failed";
    const rc = GATE_RC.exec(last.summary);
    return rc && Number(rc[1]) !== 0 ? "failed" : undefined;
  }

  /** Custo corrente (US$) do agente pelos transcripts da worktree; sem transcript, sem valor (zero seria inventado). */
  function costOf(a: AgentRecord, budget: { left: number }): number | undefined {
    const tree = text(a.data.worktree);
    if (tree === "") return undefined;
    const key = `${a.registry.slug}/${a.name}`;
    if (budget.left <= 0) return costLast.get(key);
    const cache = costCaches.get(key) ?? {};
    costCaches.set(key, cache);
    const { costUsd, read } = currentCost(tree, cache, deps.projectsDir);
    budget.left -= read;
    if (Object.keys(cache).length === 0) return undefined;
    costLast.set(key, costUsd);
    return costUsd;
  }

  /** O p75 de custo da unidade na seção `## Estimativa` do plano da raiz (sem exigir o hash, como o teto do watch). */
  function estimateOf(a: AgentRecord): number | undefined {
    const slug = a.registry.slug;
    const t = now().getTime();
    let entry = estimateCache.get(slug);
    if (!entry || t - entry.t >= ESTIMATE_TTL_MS) {
      const path = text(jsonOf(join(a.registry.orch, "plan.json")).path);
      const body = path ? readText(path) : undefined;
      const byUnit = new Map<string, number>();
      for (const row of body === undefined ? [] : parseSection(body)) if (row.costP75 !== null) byUnit.set(row.unit, row.costP75);
      entry = { t, byUnit };
      estimateCache.set(slug, entry);
    }
    return entry.byUnit.get(a.name);
  }

  /** `{usedK, capK}` quando a sessão do agente vivo passou do teto do papel; abaixo dele (ou sem teto configurado) o campo não existe. */
  function ctxOverOf(a: AgentRecord): Dict | undefined {
    const tree = text(a.data.worktree);
    if (!deps.ctxCap || tree === "" || REGISTRY_DONE.has(text(a.data.state))) return undefined;
    const cap = deps.ctxCap(agentRoleOf(a.data));
    const used = (deps.contextOf ?? contextOfDir)(tree);
    return used > cap ? { usedK: Math.floor(used / 1000), capK: Math.floor(cap / 1000) } : undefined;
  }

  /** `{real, configured}` quando a sessão do agente vivo roda num modelo diferente do configurado para o papel (escalada da Hades não conta). */
  function modelMismatchOf(a: AgentRecord): Dict | undefined {
    const tree = text(a.data.worktree);
    if (!deps.modelOf || tree === "" || REGISTRY_DONE.has(text(a.data.state))) return undefined;
    const found = agentModelMismatch(tree, a.data, deps.modelOf(agentRoleOf(a.data)), home());
    return found ? { real: found.real, configured: found.configured } : undefined;
  }

  /** Arquivos do agente que existem (brief, report, questions, handoff; caminhos relativos à worktree) e quantas perguntas do `questions.md` seguem abertas. */
  function reportInfo(a: AgentRecord): { paths: AgentNodeFiles; openQuestions: number } {
    const tree = text(a.data.worktree);
    const dir = deps.reportsDir() || DEFAULT_REPORTS_DIR;
    const paths: AgentNodeFiles = [];
    let openQuestions = 0;
    if (tree === "") return { paths, openQuestions };
    for (const [key, name] of Object.entries(FILES)) {
      const path = join(tree, dir, name);
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      paths.push(`${dir}/${name}`);
      if (key === "questions") openQuestions = openQuestionHeads(readText(path) ?? "").length;
    }
    return { paths, openQuestions };
  }

  /** O CI da PR do agente, do que o `gh` já trouxe (o detalhe do nó ou a atualização em segundo plano deste mesmo grafo). */
  function ciOfAgentPr(a: AgentRecord, number: number): Dict | undefined {
    const cwd = text(a.data.worktree);
    const key = `${a.registry.slug}:${number}`;
    const hit = prCache.get(key);
    const stale = !hit || Date.now() - hit.t >= PR_TTL_MS;
    if (stale && !REGISTRY_DONE.has(text(a.data.state)) && cwd !== "" && existsSync(cwd) && prInflight.size < PR_REFRESH_MAX) {
      // fetchPr nunca rejeita (cada falha vira `unavailable`): soltar a promessa aqui não perde erro
      void fetchPr(number, cwd, key);
    }
    return hit && hit.value.ci !== null && typeof hit.value.ci === "object" ? asDict(hit.value.ci) : undefined;
  }

  /** Pendência só vale para sessão viva: registro encerrado/arquivado ou pane fora do `herdr agent list` não pede nada. */
  function livePending(a: AgentRecord, host: Dict | undefined, tail: JournalEvent[]): PendingPermission | null {
    if (REGISTRY_DONE.has(text(a.data.state)) || !host) return null;
    return pendingPermission(tail);
  }

  function agentNode(a: AgentRecord, rows: Dict[], tail: JournalEvent[], ctx: NodeContext): Dict {
    const host = hostOf(rows, a);
    const registryState = text(a.data.state) || "unknown";
    const herdrState = host ? text(host.agent_status) || "unknown" : "fora";
    const pending = livePending(a, host, tail);
    const pr = prNumberOf(a);
    const { paths, openQuestions } = reportInfo(a);
    const extra = definedOnly({
      costUsd: costOf(a, ctx.budget), estimateUsd: estimateOf(a), card: text(a.data.card) || undefined, files: paths.length > 0 ? paths : undefined,
      openQuestions: openQuestions > 0 ? openQuestions : undefined, ctxOver: ctxOverOf(a), modelMismatch: modelMismatchOf(a),
      closedOnDone: a.data.closedOnDone === true ? true : undefined,
      gate: gateStateOf(a, tail, ctx.gates), pr: pr ?? undefined, ci: pr === null ? undefined : ciOfAgentPr(a, pr),
    });
    return {
      id: nodeId("agent", a.registry.slug, a.name), type: "agent" satisfies NodeType, label: a.name, role: text(a.data.role) || null,
      // aposentado no registro vale mais que o herdr: o painel pode seguir aberto
      state: REGISTRY_DONE.has(registryState) ? registryState : herdrState,
      registryState, herdrState, registry: a.registry.slug, mode: text(a.data.mode) || null, phase: text(a.data.phase) || null,
      branch: text(a.data.branch) || null, base: text(a.data.base) || null, worktree: text(a.data.worktree) || null,
      lastEventTs: tail.at(-1)?.ts ?? null, pendingPermission: pending,
      ...extra,
      // aditivos: o pane do herdr (a página não precisa casar por nome ou pasta) e o id curto para a tela
      ...definedOnly({ herdr: (host && herdrRefOf(host.pane_id)) ?? undefined, shortId: agentShortId(a.registry.slug, a.name) ?? undefined }),
      // o pane do herdr de quem alocou o agente (registro, gravado pela CLI): o canvas liga o terminal desse pane ao agente
      ...definedOnly({ orchestrator: orchestratorOf(a.data) }),
    };
  }

  const prNode = (registry: string, number: number, state: string | null): Dict => ({
    id: nodeId("pr", registry, number), type: "pr" satisfies NodeType, label: `#${number}`, role: null, state: state ?? "unknown", number,
    registry, lastEventTs: null, pendingPermission: null,
  });

  async function graph(): Promise<Dict> {
    const all = agents();
    const { available, rows } = await herdrAgents();
    const ctx: NodeContext = { gates: deps.gates(), budget: { left: deps.costBudgetBytes ?? COST_READ_BUDGET_BYTES } };
    const nodes = new Map<string, Dict>();
    const edges: Dict[] = [];
    const edgeKeys = new Set<string>();
    const link = (from: string, to: string, kind: EdgeKind): void => {
      const key = `${kind}|${from}|${to}`;
      if (from === to || edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push({ from, to, kind });
    };
    const maxAgeH = deps.agentMaxAgeHours ? deps.agentMaxAgeHours() : 0;
    const tails = new Map<AgentRecord, JournalEvent[]>(all.map((a) => [a, journalTail(a)]));
    // agente parado há mais que o corte não entra no grafo (nem as PRs e ligações dele); sem instante algum, fica
    const stale = (a: AgentRecord): boolean => {
      if (!(maxAgeH > 0)) return false;
      const last = lastActivityMs(a.data, tails.get(a) ?? []);
      return last !== undefined && now().getTime() - last > maxAgeH * HOUR_MS;
    };
    const hidden = new Set(all.filter(stale));
    const records = all.filter((a) => !hidden.has(a));
    const byBranch = new Map<string, AgentRecord>();
    // o teto de leitura de transcript é gasto primeiro nos agentes em andamento: os aposentados não podem esgotá-lo antes deles
    const built = new Map<AgentRecord, Dict>();
    const retired = (a: AgentRecord): number => Number(REGISTRY_DONE.has(text(a.data.state)));
    for (const a of [...records].sort((x, y) => retired(x) - retired(y))) built.set(a, agentNode(a, rows, tails.get(a) ?? [], ctx));
    for (const a of records) {
      const node = built.get(a);
      if (node) nodes.set(nodeId("agent", a.registry.slug, a.name), node);
      if (text(a.data.branch)) byBranch.set(text(a.data.branch), a);
    }
    const idOf = (a: AgentRecord): string => nodeId("agent", a.registry.slug, a.name);

    // orquestrador → agente: o pane que o registro gravou é o de outro agente do grafo (o terminal do canvas é do canvas)
    const byPane = new Map<string, string>();
    for (const [id, node] of nodes) {
      const ref = node.herdr as HerdrRef | undefined;
      if (ref) byPane.set(`${ref.session}\0${ref.pane}`, id);
    }
    for (const a of records) {
      const by = orchestratorOf(a.data);
      const from = by && byPane.get(`${by.session}\0${by.pane}`);
      if (from) link(from, idOf(a), "orchestrates");
    }

    for (const a of records) {
      // stack: a base é a branch de outro agente
      const below = byBranch.get(stripOrigin(text(a.data.base)));
      if (below) link(idOf(a), idOf(below), "stack");
      // agente → PR: o registro ou a entrega do estado do loop
      const delivery = deliveryOf(a);
      const pr = prNumberOf(a, delivery);
      if (pr !== null) {
        const id = nodeId("pr", a.registry.slug, pr);
        if (!nodes.has(id)) nodes.set(id, prNode(a.registry.slug, pr, text(delivery.status) || null));
        const ci = ciOfAgentPr(a, pr);
        const prNodeRef = nodes.get(id) as Dict;
        if (ci && prNodeRef.ci === undefined) prNodeRef.ci = ci;
        link(idOf(a), id, "agent_pr");
      }
    }

    for (const registry of deps.registries()) {
      // consolidação: quem consolida → as PRs-membro
      for (const file of jsonFiles(join(registry.orch, "consolidations"))) {
        const record = jsonOf(join(registry.orch, "consolidations", file));
        const owner = records.find((a) => a.registry.slug === registry.slug && (text(a.data.branch) === text(record.branch) || (text(record.worktree) !== "" && text(a.data.worktree) === text(record.worktree))));
        if (!owner) continue;
        for (const member of Array.isArray(record.members) ? record.members : []) {
          const pr = Number(member);
          if (!Number.isInteger(pr) || pr <= 0) continue;
          const id = nodeId("pr", registry.slug, pr);
          if (!nodes.has(id)) nodes.set(id, prNode(registry.slug, pr, null));
          link(idOf(owner), id, "consolidation");
        }
      }
      // dependência entre unidades do plano aprovado; unidade sem agente vira nó `unit`
      const plan = planOf(registry);
      // unidade cujo agente foi cortado por idade não volta como `unit`: some com ele
      const resolve = (name: string): string | undefined => {
        const agent = all.find((a) => a.registry.slug === registry.slug && a.name === name);
        if (agent) return hidden.has(agent) ? undefined : idOf(agent);
        const id = nodeId("unit", registry.slug, name);
        if (!nodes.has(id)) nodes.set(id, { id, type: "unit", label: name, role: null, state: "planned", registry: registry.slug, lastEventTs: null, pendingPermission: null });
        return id;
      };
      for (const unit of plan.units) {
        const from = resolve(unit.name);
        if (from === undefined) continue;
        for (const dep of unit.dependsOn) {
          const to = resolve(dep);
          if (to !== undefined) link(from, to, "depends_on");
        }
      }
    }

    // gates da fila: agente → gate pelo --label ou pelo clone dentro da worktree
    for (const gate of ctx.gates) {
      const pid = Number(gate.pid);
      if (!Number.isInteger(pid)) continue;
      const id = nodeId("gate", pid);
      nodes.set(id, {
        id, type: "gate", label: `${text(gate.kind)}/${text(gate.label)}`, role: null, state: text(gate.state) || "unknown", registry: null,
        lastEventTs: null, pendingPermission: null,
      });
      for (const a of records) if (gateBelongs(gate, a)) link(idOf(a), id, "agent_gate");
    }

    const registries = deps.registries().map((r) => {
      const approved = planOf(r).approved;
      const plan = approved ? jsonOf(join(r.orch, "plan.json")) : {};
      return { slug: r.slug, planApproved: approved, ...definedOnly({ round: roundOf(plan.path, plan.sha) ?? undefined }) };
    });
    return { v: ARGOS_SCHEMA_VERSION, generatedAt: now().toISOString(), herdr: { available }, registries, nodes: [...nodes.values()], edges };
  }

  function agentOf(id: string): AgentRecord {
    const parsed = parseNodeId(id);
    const found = parsed.type === "agent" ? agents().find((a) => a.registry.slug === parsed.parts[0] && a.name === parsed.parts[1]) : undefined;
    if (!found) throw new ArgosError(404, ARGOS_ERRORS.unknownNode, "nó desconhecido");
    return found;
  }

  function limitOf(raw: string | undefined): number {
    if (raw === undefined || raw === "") return LIMIT_DEFAULT;
    const n = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (n < 1 || n > LIMIT_MAX) throw new ArgosError(400, ARGOS_ERRORS.invalidQuery, `limit é de 1 a ${LIMIT_MAX}`);
    return n;
  }

  function timeline(a: AgentRecord, query: Record<string, string>): Dict {
    const limit = limitOf(query.limit);
    let sinceMs: number | undefined;
    if (query.since) {
      sinceMs = parseSince(query.since, now());
      if (sinceMs === undefined) throw new ArgosError(400, ARGOS_ERRORS.invalidQuery, "since inválido (30m, 2h, 1d ou instante ISO com Z)");
    }
    const file = journalFile(a);
    const events: JournalEvent[] = [];
    for (const path of [file.replace(/\.jsonl$/, ".1.jsonl"), file]) {
      for (const line of readTailText(path).split("\n")) {
        const event = line === "" ? undefined : parseEvent(line);
        if (event && (sinceMs === undefined || Date.parse(event.ts) >= sinceMs)) events.push(event);
      }
    }
    const kept = events.slice(-limit);
    // a faixa ao vivo é o SSE do diário: nenhum stream novo
    return { events: kept, limit, count: kept.length, stream: `/api/journal/stream?agent=${encodeURIComponent(a.name)}` };
  }

  function files(a: AgentRecord): Dict {
    const dir = join(text(a.data.worktree) || "/nonexistent", deps.reportsDir() || DEFAULT_REPORTS_DIR);
    const out: Record<string, FileSummary | null> = {};
    for (const [key, name] of Object.entries(FILES)) {
      const path = join(dir, name);
      const body = existsSync(path) && statSync(path).isFile() ? readText(path) : undefined;
      out[key] = body === undefined ? null : { ...summarizeFile(path, body), ...(key === "questions" ? { openQuestions: openQuestionHeads(body) } : {}) };
    }
    return out;
  }

  /** CI como `passing/failing/pending`, do statusCheckRollup do gh (CheckRun e StatusContext). */
  function ciOf(rollup: unknown): Dict {
    const counts = { passing: 0, failing: 0, pending: 0 };
    for (const check of Array.isArray(rollup) ? rollup : []) {
      const c = asDict(check);
      const verdict = text(c.conclusion) || text(c.state) || text(c.status);
      if (/^(SUCCESS|NEUTRAL|SKIPPED)$/i.test(verdict)) counts.passing += 1;
      else if (/^(FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE)$/i.test(verdict)) counts.failing += 1;
      else counts.pending += 1;
    }
    return counts;
  }

  /** `gh pr view` de uma PR, um por vez por PR: pedidos que chegam durante o voo esperam o mesmo resultado. */
  function fetchPr(number: number, cwd: string, key: string): Promise<Dict> {
    const running = prInflight.get(key);
    if (running) return running;
    const task = (async (): Promise<Dict> => {
      let value: Dict;
      try {
        const r = await exec(["gh", "pr", "view", String(number), "--json", "state,isDraft,mergeable,headRefOid,url,statusCheckRollup"], { timeoutMs: GH_TIMEOUT_MS, cwd, env: deps.env });
        if (r.status !== 0) throw new Error("gh");
        const data = asDict(JSON.parse(r.stdout));
        value = { number, state: text(data.state) || null, isDraft: data.isDraft === true, mergeable: text(data.mergeable) || null, head: text(data.headRefOid).slice(0, 11) || null, url: text(data.url) || null, ci: ciOf(data.statusCheckRollup) };
      } catch {
        // gh ausente, sem rede ou sem login: o nó mostra o número e que o estado não veio
        value = { number, state: null, isDraft: null, mergeable: null, head: null, url: null, ci: null, unavailable: true };
      }
      prCache.set(key, { t: Date.now(), value });
      return value;
    })().finally(() => prInflight.delete(key));
    prInflight.set(key, task);
    return task;
  }

  async function pullRequest(a: AgentRecord): Promise<Dict | null> {
    const number = prNumberOf(a);
    const cwd = text(a.data.worktree);
    if (number === null || cwd === "" || !existsSync(cwd)) return null;
    const key = `${a.registry.slug}:${number}`;
    const hit = prCache.get(key);
    if (hit && Date.now() - hit.t < PR_TTL_MS) return hit.value;
    return fetchPr(number, cwd, key);
  }

  async function node(id: string, query: Record<string, string>): Promise<Dict> {
    const a = agentOf(id);
    const { rows } = await herdrAgents();
    const tail = journalTail(a);
    const host = hostOf(rows, a);
    return {
      v: ARGOS_SCHEMA_VERSION,
      node: agentNode(a, rows, tail, { gates: deps.gates(), budget: { left: COST_READ_BUDGET_BYTES } }),
      timeline: timeline(a, query),
      herdr: host ? { status: text(host.agent_status) || null, pane: text(host.pane_id) || null, title: text(host.terminal_title_stripped) || null, cwd: text(host.foreground_cwd) || null } : null,
      pr: await pullRequest(a),
      files: files(a),
    };
  }

  async function live(id: string): Promise<{ herdrState: string; pending: PendingPermission | null }> {
    const a = agentOf(id);
    const host = hostOf((await herdrAgents()).rows, a);
    return { herdrState: host ? text(host.agent_status) || "unknown" : "fora", pending: livePending(a, host, journalTail(a)) };
  }

  return { graph, node, agentOf, live };
}

/** O registro do projeto (a pasta de locks do env.sh tem `<raiz>/<slug>/locks`) e o `_skill`, nessa ordem e sem repetir. */
export function registriesOf(locks: string | undefined, workRoot: string): Registry[] {
  const out: Registry[] = [];
  if (locks) {
    const slug = basename(dirname(locks));
    if (slug !== SKILL_REGISTRY) out.push({ slug, orch: join(dirname(locks), "orchestration") });
  }
  out.push({ slug: SKILL_REGISTRY, orch: join(workRoot, SKILL_REGISTRY, "orchestration") });
  return out;
}
