// Página Caronte (reference/panel.md §Caronte, reference/caronte.md): GET /api/caronte (planos e pacotes),
// GET /api/caronte/plan/<nome> (prontidão, prévia do pack --dry-run, prompt de retomada, comandos) e
// POST /api/caronte/park (`hades agent park`). Nenhuma rota faz pack nem unpack: a senha nunca passa pelo navegador.
// Nome de plano e de agente só chegam ao disco ou ao comando depois de validados contra a lista (400 inválido, 404 desconhecido).
import { messageOfCliFailure } from "../lib/human-errors.ts";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { listDir, readText } from "../lib/fs.ts";
import { AGENT_NAME, planAgents, previewPack, resumePrompt, type PackPreview, type PlanAgent } from "../lib/caronte.ts";
import { selfCli } from "../lib/paths.ts";
import { type WorkEnv } from "../lib/work.ts";
import { type Caller } from "./argos-actions.ts";
import { type Exec, exec, shlexQuote } from "./exec.ts";

type Dict = Record<string, unknown>;

export const CARONTE_ERRORS = {
  invalidPlan: "invalid_plan",
  unknownPlan: "unknown_plan",
  invalidAgent: "invalid_agent",
  unknownAgent: "unknown_agent",
  busy: "busy",
  actionFailed: "action_failed",
  actionTimeout: "action_timeout",
  previewFailed: "preview_failed",
} as const;

/** Recusa com status e código estável; a mensagem nunca leva caminho nem detalhe interno. */
export class CaronteRouteError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CaronteRouteError";
    this.status = status;
    this.code = code;
  }
}

export const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PLAN_EXT = ".md";
const LOG_EXT = ".log.md";
const PACKAGE_EXT = ".caronte";
const MAX_PLANS = 100;
const MAX_PACKAGES = 200;
const PREVIEW_TTL_MS = 30_000;
const TIMEOUT_DEFAULT_S = 1200;
const OUTPUT_MAX = 2000;
const ERROR_MAX = 300;
const CALLER_ID = /^[0-9A-Fa-f:.]{1,45}$/;
/** `agent park` com o registro nesses estados só avisa e sai 0 (reference/caronte.md): nem vale subir o subprocesso. */
const ALREADY_SETTLED = new Set(["parked", "done", "archived"]);

export interface CaronteDeps {
  /** `~/.claude/hades/plans` */
  plansDir: string;
  /** `HADES_CARONTE_OUT_DIR` ou `~/.claude/hades/caronte` */
  outDir(): string;
  /** a raiz de trabalho dos planos da skill (`_skill`) */
  work(): WorkEnv;
  config(): Record<string, string>;
  /** `<pasta de dados>/logs/panel-argos.log`: o mesmo log das ações do Argos */
  logFile: string;
  notify(message: string, state: string): Promise<void>;
  /** roda `hades agent park <nome>` na worktree do agente */
  runPark?(name: string, cwd: string, timeoutMs: number): Promise<Exec>;
  now?(): Date;
}

export interface CaronteRoutes {
  list(): Dict;
  plan(name: string): Dict;
  park(body: Dict, caller: Caller): Promise<Dict>;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const lastLine = (text: string): string => text.trim().split("\n").filter(Boolean).pop() ?? "";
const mtimeMs = (file: string): number => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;

const packCommand = (plan: string): string => `! hades caronte pack ${shlexQuote(plan)}`;
const parkCommand = (agent: string): string => `hades agent park ${agent}`;

function defaultRunPark(name: string, cwd: string, timeoutMs: number): Promise<Exec> {
  const cli = selfCli("agent", "park", name);
  return exec([cli.command, ...cli.args], { timeoutMs, cwd });
}

export function createCaronteRoutes(deps: CaronteDeps): CaronteRoutes {
  const now = (): Date => (deps.now ? deps.now() : new Date());
  const previews = new Map<string, { at: number; value: Dict }>();
  const parking = new Set<string>();
  const plansRoot = resolve(deps.plansDir);

  /** Planos da pasta (sem os `.log.md`), do mais novo ao mais antigo; o nome é o arquivo sem `.md`. */
  function planNames(): string[] {
    return listDir(plansRoot)
      .filter((file) => file.endsWith(PLAN_EXT) && !file.endsWith(LOG_EXT))
      .map((file) => file.slice(0, -PLAN_EXT.length))
      .filter((name) => PLAN_NAME.test(name))
      .map((name) => ({ name, at: mtimeMs(join(plansRoot, `${name}${PLAN_EXT}`)) }))
      .sort((a, b) => b.at - a.at || (a.name < b.name ? -1 : 1))
      .slice(0, MAX_PLANS)
      .map((entry) => entry.name);
  }

  /** O caminho do plano: o nome já foi validado e achado na lista; o prefixo é conferido de novo antes de abrir o arquivo. */
  function planFile(name: string): string {
    if (!PLAN_NAME.test(name)) throw new CaronteRouteError(400, CARONTE_ERRORS.invalidPlan, "nome de plano inválido");
    if (!planNames().includes(name)) throw new CaronteRouteError(404, CARONTE_ERRORS.unknownPlan, "plano desconhecido");
    const file = resolve(plansRoot, `${name}${PLAN_EXT}`);
    if (!file.startsWith(`${plansRoot}${sep}`)) throw new CaronteRouteError(404, CARONTE_ERRORS.unknownPlan, "plano desconhecido");
    return file;
  }

  const agentView = (agent: PlanAgent): Dict => ({
    name: agent.name,
    state: agent.state,
    readiness: agent.readiness,
    command: agent.readiness === "working" ? parkCommand(agent.name) : null,
    canPark: agent.readiness === "working" && !ALREADY_SETTLED.has(agent.state),
  });

  function packages(): Dict[] {
    const dir = deps.outDir();
    return listDir(dir)
      .filter((file) => file.endsWith(PACKAGE_EXT))
      .map((file) => ({ file, info: statSync(join(dir, file), { throwIfNoEntry: false }) }))
      .flatMap(({ file, info }) => (info?.isFile() ? [{ name: file, size: info.size, modifiedAt: info.mtime.toISOString(), at: info.mtimeMs }] : []))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_PACKAGES)
      .map(({ at: _at, name, ...rest }) => ({ name, ...rest, unpack: `! hades caronte unpack ${shlexQuote(join(dir, name))}` }));
  }

  function previewOf(name: string, file: string, agents: PlanAgent[]): Dict {
    const missing = agents.filter((a) => a.readiness === "working");
    if (missing.length > 0) return { preview: null, previewError: { code: "not_ready", agents: missing.map((a) => a.name) } };
    const cached = previews.get(name);
    if (cached && now().getTime() - cached.at < PREVIEW_TTL_MS) return cached.value;
    let preview: PackPreview;
    try {
      preview = previewPack({ work: deps.work(), planFile: file, withJournal: false });
    } catch (error) {
      console.warn(`prévia do caronte falhou (${name}): ${error instanceof Error ? error.message : String(error)}`);
      return { preview: null, previewError: { code: CARONTE_ERRORS.previewFailed } };
    }
    const value = { preview: { ...preview, worktrees: preview.worktrees.map(({ agent, branch, head, baseRef, bundle, patch }) => ({ agent, branch, head, baseRef, bundle, patch })) }, previewError: null };
    previews.set(name, { at: now().getTime(), value });
    return value;
  }

  function list(): Dict {
    const work = deps.work();
    const plans = planNames().map((name) => {
      const agents = planAgents(work, readText(join(plansRoot, `${name}${PLAN_EXT}`)) ?? "");
      const missing = agents.filter((a) => a.readiness === "working");
      return {
        name,
        modifiedAt: new Date(mtimeMs(join(plansRoot, `${name}${PLAN_EXT}`))).toISOString(),
        ready: missing.length === 0,
        agents: agents.map(agentView),
        missing: missing.map((a) => parkCommand(a.name)),
        pack: packCommand(name),
      };
    });
    const dir = deps.outDir();
    return { plans, packages: packages(), packagesDir: dir, unpack: "! hades caronte unpack <arq>" };
  }

  function plan(name: string): Dict {
    const file = planFile(name);
    const agents = planAgents(deps.work(), readText(file) ?? "");
    const parked = agents.filter((a) => a.readiness === "parked").map((a) => a.name);
    return {
      name,
      ready: agents.every((a) => a.readiness !== "working"),
      agents: agents.map(agentView),
      ...previewOf(name, file, agents),
      brief: resumePrompt(file, parked),
      commands: { pack: packCommand(name), dryRun: `hades caronte pack ${shlexQuote(name)} --dry-run`, unpack: "! hades caronte unpack <arq>" },
    };
  }

  function record(caller: Caller, target: string, result: string): void {
    const who = caller.remote ? `remoto${caller.ip && CALLER_ID.test(caller.ip) ? `:${caller.ip}` : ""}` : "local";
    mkdirSync(dirname(deps.logFile), { recursive: true });
    appendFileSync(deps.logFile, `${now().toISOString()} quem=${who} acao=caronte-park alvo=${target} resultado=${result}\n`);
  }

  async function runPark(agent: PlanAgent): Promise<string> {
    const configured = Number.parseInt(deps.config().HADES_ARGOS_ACTION_TIMEOUT_S ?? "", 10);
    const seconds = Number.isInteger(configured) && configured > 0 ? configured : TIMEOUT_DEFAULT_S;
    const cwd = statSync(agent.worktree, { throwIfNoEntry: false })?.isDirectory() ? agent.worktree : deps.work().repoTop;
    const r = await (deps.runPark ?? defaultRunPark)(agent.name, cwd, seconds * 1000);
    if (r.timedOut) throw new CaronteRouteError(504, CARONTE_ERRORS.actionTimeout, "o comando do agente não terminou a tempo");
    if (r.status !== 0) throw new CaronteRouteError(422, CARONTE_ERRORS.actionFailed, clip(messageOfCliFailure(r.stderr) || lastLine(r.stdout) || "o comando do agente falhou", ERROR_MAX));
    return clip(r.stdout.trim(), OUTPUT_MAX);
  }

  async function park(body: Dict, caller: Caller): Promise<Dict> {
    const label = typeof body.plan === "string" && PLAN_NAME.test(body.plan) && typeof body.agent === "string" && AGENT_NAME.test(body.agent) ? `${body.plan}/${body.agent}` : "-";
    let result = "ok";
    let key = "";
    try {
      const planName = typeof body.plan === "string" ? body.plan : "";
      const file = planFile(planName);
      if (typeof body.agent !== "string" || !AGENT_NAME.test(body.agent)) throw new CaronteRouteError(400, CARONTE_ERRORS.invalidAgent, "nome de agente inválido");
      const agentName = body.agent;
      const agent = planAgents(deps.work(), readText(file) ?? "").find((a) => a.name === agentName);
      if (!agent) throw new CaronteRouteError(404, CARONTE_ERRORS.unknownAgent, "agente desconhecido neste plano");
      if (ALREADY_SETTLED.has(agent.state)) return { ok: true, plan: planName, agent: agentName, already: agent.state, output: "" };
      if (parking.has(agentName)) throw new CaronteRouteError(409, CARONTE_ERRORS.busy, "este agente já está sendo estacionado");
      parking.add(agentName);
      key = agentName;
      const output = await runPark(agent);
      previews.delete(planName);
      return { ok: true, plan: planName, agent: agentName, already: null, output };
    } catch (error) {
      result = error instanceof CaronteRouteError ? `recusada:${error.code}` : "erro";
      throw error;
    } finally {
      if (key) parking.delete(key);
      record(caller, label, result);
      if (caller.remote) {
        await deps.notify(`ação remota: park em ${label} (${result})`, `park:${label}`).catch((error: unknown) => {
          console.warn(`aviso remoto do caronte falhou: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  return { list, plan, park };
}
