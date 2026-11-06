// `hades wait`: esperas que notificam. Cada subcomando bloqueia até o evento e sai com UMA linha (hades wait).
// Rode sempre em segundo plano: o laço fica aqui, nunca na conversa (o hook da Hades barra polling).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePullRequest, text } from "../lib/activity.ts";
import { need } from "../lib/deps.ts";
import { isFile, readText } from "../lib/fs.ts";
import { EXIT, die, out } from "../lib/output.ts";
import { home } from "../lib/paths.ts";
import { run } from "../lib/proc.ts";
import { selfCli } from "../lib/paths.ts";
import { WatchUsageError, observerKey, parseWatchArgs } from "../lib/watch-scope.ts";
import { DEFAULT_WAKE_MIN_S, SETTLE_MS, ensureDir, formatWake, gatherWake, lastWakeFile, readLastWake, watchSource } from "../lib/wait-agents.ts";
import { DEFAULT_REPORTS, configValue, loadWorkEnv } from "../lib/work.ts";

const DEFAULT_EVERY_SECONDS = 60;
const DEFAULT_MAX_SECONDS = 21_600;
const TIMEOUT_EXIT = 3;
const MAX_ANCESTORS = 16;
const GATE_POLL_MS = 1000;
const GATE_SUMMARY_LINES = 15;
const GH_TIMEOUT_MS = 60_000;
const REVIEW_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviews(last:50){nodes{id}} comments(last:50){nodes{id}} reviewThreads(last:100){nodes{comments(last:20){nodes{id}}}}}}}`;
const FAILED_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);

const USAGE = `# Esperas que notificam: cada subcomando bloqueia até o evento e sai com UMA linha. Rode SEMPRE em segundo plano
# (Bash com run_in_background): a sessão é acordada quando ele termina, sem gastar turno esperando. O laço fica aqui,
# no shell, nunca na conversa (o hook da Hades barra polling e barra este comando em primeiro plano).
#   hades wait ci <PR>                    CI da PR terminou       → "CI #N verde" | "CI #N vermelho: <checks>"
#   hades wait gate <pid> [sumário]       gate terminou           → "GATE <pid> terminou" + as últimas linhas do sumário
#   hades wait queue <label>              ticket saiu da espera   → "QUEUE <label> running|gone"
#   hades wait merged <PR>                PR saiu de aberta       → "PR #N MERGED|CLOSED"
#   hades wait review <PR>                review/comentário novo  → "REVIEW #N <k> novos"
#   hades wait answer <worktree> <Qn>     dono respondeu          → "ANSWER Qn"
#   hades wait agent <nome> [estado]      agente chegou ao estado → "AGENT <nome> <estado>" (padrão idle)
#   hades wait agents --any [flags do watch]  qualquer agente do orquestrador → "AGENTS <n>" e uma linha por evento (DONE, QUESTION, …),
#                                         eventos que chegam juntos num despertar só; intervalo mínimo HADES_ORCH_WAKE_MIN_S
#   hades wait proc <padrão>              nenhum processo casa    → "PROC <padrão> terminou" (padrão do pgrep -f)
# Intervalos: HADES_WAIT_EVERY (padrão 60 s). Tempo máximo: HADES_WAIT_MAX (padrão 6 h) → sai com "TIMEOUT ...".`.replace(/^# ?/gm, "");

class Clock {
  private readonly startedAt = Date.now();
  private readonly everyMs: number;
  private readonly maxSeconds: number;
  private readonly label: string;

  constructor(env: NodeJS.ProcessEnv, label: string) {
    this.everyMs = (Number(env.HADES_WAIT_EVERY ?? DEFAULT_EVERY_SECONDS) || DEFAULT_EVERY_SECONDS) * 1000;
    this.maxSeconds = Number(env.HADES_WAIT_MAX ?? DEFAULT_MAX_SECONDS) || DEFAULT_MAX_SECONDS;
    this.label = label;
  }

  get maxMs(): number {
    return this.maxSeconds * 1000;
  }

  /** Espera o intervalo; false (com a linha TIMEOUT já impressa) quando o tempo máximo acabou. */
  async tick(): Promise<boolean> {
    if (Math.floor((Date.now() - this.startedAt) / 1000) >= this.maxSeconds) {
      out(`TIMEOUT ${this.label} depois de ${Math.floor(this.maxSeconds / 60)} min`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, this.everyMs));
    return true;
  }
}

function requireArg(value: string | undefined, name: string): string {
  return value ?? die(`faltou <${name}>`, EXIT.fail);
}

function gh(args: string[]): string {
  const r = run("gh", args, { timeoutMs: GH_TIMEOUT_MS });
  return r.status === 0 ? r.stdout.trim() : "";
}

type Check = Record<string, unknown>;

function parseChecks(raw: string): Check[] | undefined {
  try {
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? (data as Check[]) : undefined;
  } catch {
    return undefined;
  }
}

/** CheckRun (status/conclusion) e StatusContext (state): pendente enquanto algum não terminou. */
function isPending(check: Check): boolean {
  const status = check.status ?? "COMPLETED";
  const state = text(check.state);
  return status !== "COMPLETED" || state === "PENDING" || state === "EXPECTED";
}

function isFailed(check: Check): boolean {
  const state = text(check.state);
  return FAILED_CONCLUSIONS.has(text(check.conclusion)) || state === "FAILURE" || state === "ERROR";
}

async function waitCi(pr: string, clock: Clock): Promise<number> {
  need("gh");
  for (;;) {
    const checks = parseChecks(gh(["pr", "view", pr, "--json", "statusCheckRollup", "--jq", ".statusCheckRollup"]));
    if (checks && !checks.some(isPending)) return reportCi(pr, checks);
    if (!(await clock.tick())) return TIMEOUT_EXIT;
  }
}

function reportCi(pr: string, checks: Check[]): number {
  const bad = checks.filter(isFailed).map((c) => text(c.name ?? c.context)).join(", ");
  if (checks.length === 0) out(`CI #${pr} sem checks (base fora de flow.ci.bases ou draft: não é verde)`);
  else if (bad) {
    out(`CI #${pr} vermelho: ${bad}`);
    return EXIT.fail;
  } else out(`CI #${pr} verde (${checks.length} checks)`);
  return EXIT.ok;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitGate(pid: string, summary: string): Promise<number> {
  const number = Number(pid);
  while (Number.isInteger(number) && number > 0 && processAlive(number)) await new Promise((resolve) => setTimeout(resolve, GATE_POLL_MS));
  out(`GATE ${pid} terminou`);
  const lines = summary && isFile(summary) ? (readText(summary) ?? "").replace(/\n$/, "").split("\n") : [];
  if (lines.length) out(lines.slice(-GATE_SUMMARY_LINES).join("\n"));
  return EXIT.ok;
}

async function waitQueue(label: string, clock: Clock): Promise<number> {
  const gateLock = join(home(), ".claude", "skills", "hades", "kit", "gate", "gate-lock.sh");
  for (;;) {
    const line = run("bash", [gateLock, "status"]).stdout.split("\n").find((l) => l.includes(`label=${label}`));
    if (line === undefined) {
      out(`QUEUE ${label} gone`);
      return EXIT.ok;
    }
    if (line.includes("state=running")) {
      out(`QUEUE ${label} running`);
      return EXIT.ok;
    }
    if (!(await clock.tick())) return TIMEOUT_EXIT;
  }
}

async function waitMerged(pr: string, clock: Clock): Promise<number> {
  need("gh");
  for (;;) {
    const state = gh(["pr", "view", pr, "--json", "state", "--jq", ".state"]);
    if (state !== "" && state !== "OPEN") {
      out(`PR #${pr} ${state}`);
      return EXIT.ok;
    }
    if (!(await clock.tick())) return TIMEOUT_EXIT;
  }
}

function reviewIds(owner: string, repo: string, pr: string): Set<string> {
  const raw = gh(["api", "graphql", "-f", `query=${REVIEW_QUERY}`, "-F", `o=${owner}`, "-F", `r=${repo}`, "-F", `n=${pr}`]);
  return new Set(raw ? (parsePullRequest(raw)?.ids ?? []) : []);
}

async function waitReview(pr: string, clock: Clock): Promise<number> {
  need("gh");
  const [owner = "", repo = ""] = gh(["repo", "view", "--json", "owner,name", "--jq", '.owner.login + " " + .name']).split(" ");
  if (!owner || !repo) return EXIT.usage;
  const base = reviewIds(owner, repo, pr);
  for (;;) {
    if (!(await clock.tick())) return TIMEOUT_EXIT;
    const now = reviewIds(owner, repo, pr);
    const fresh = [...now].filter((id) => !base.has(id)).length;
    if (now.size > 0 && fresh > 0) {
      out(`REVIEW #${pr} ${fresh} novos`);
      return EXIT.ok;
    }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitAnswer(worktree: string, question: string, clock: Clock): Promise<number> {
  const reports = process.env.HADES_ORCH_REPORTS_DIR || DEFAULT_REPORTS;
  const q = escapeRegex(question);
  const answered = new RegExp(`^## ${q}\\b.*\\(respondida\\)|^## Resposta do dono \\(${q}\\)`, "m");
  while (!answered.test(readText(join(worktree, reports, "questions.md")) ?? "")) {
    if (!(await clock.tick())) return TIMEOUT_EXIT;
  }
  out(`ANSWER ${question}`);
  return EXIT.ok;
}

/** Pids que casam com o padrão (pgrep -f), sem o próprio wait nem os processos que o executam (wrapper, shell). */
function matchingPids(pattern: string): number[] {
  const r = run("pgrep", ["-f", "--", pattern]);
  if (r.status > 1) die(`pgrep -f falhou (rc=${r.status}) para o padrão ${pattern}: ${r.stderr.trim() || "padrão inválido ou pgrep ausente"}`, EXIT.usage);
  const mine = new Set([process.pid, ...ancestors(process.pid)]);
  return r.stdout.split("\n").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0 && !mine.has(pid));
}

function ancestors(pid: number): number[] {
  const chain: number[] = [];
  for (let at = pid; chain.length < MAX_ANCESTORS; ) {
    const parent = Number(run("ps", ["-o", "ppid=", "-p", String(at)]).stdout.trim());
    if (!Number.isInteger(parent) || parent <= 1) break;
    chain.push(parent);
    at = parent;
  }
  return chain;
}

/** O padrão casaria com o próprio wait (sem o argumento do padrão)? Então ele esperaria por si mesmo. */
function matchesSelf(pattern: string): boolean {
  const own = process.argv.filter((arg) => arg !== pattern).join(" ");
  try {
    return new RegExp(pattern).test(own);
  } catch {
    return false;
  }
}

async function waitProc(pattern: string, clock: Clock): Promise<number> {
  if (pattern.trim() === "") die("padrão vazio: casaria com todo processo", EXIT.usage);
  if (matchesSelf(pattern)) die(`o padrão casa com o próprio hades wait (${pattern}): escolha um trecho do processo esperado`, EXIT.usage);
  while (matchingPids(pattern).length > 0) {
    if (!(await clock.tick())) return TIMEOUT_EXIT;
  }
  out(`PROC ${pattern} terminou`);
  return EXIT.ok;
}

function waitAgent(name: string, state: string, clock: Clock): number {
  need("herdr");
  const r = run("herdr", ["agent", "wait", name, "--until", state, "--timeout", String(clock.maxMs)]);
  if (r.status === 0) {
    out(`AGENT ${name} ${state}`);
    return EXIT.ok;
  }
  out(`TIMEOUT agent ${name} ${state}`);
  return TIMEOUT_EXIT;
}

/** `wait agents --any`: um despertar por rajada de eventos do `hades watch` (já filtrado pelo orquestrador). */
async function waitAgents(args: string[], clock: Clock): Promise<number> {
  const flags = args.filter((a) => a !== "--any");
  if (flags.length === args.length) die("wait agents pede --any (esperar qualquer agente do orquestrador)", EXIT.usage);
  let scope;
  try {
    if (flags.includes("--next")) throw new WatchUsageError("--next não vale aqui: o wait já sai no primeiro despertar");
    scope = parseWatchArgs(flags).scope;
  } catch (error) {
    if (!(error instanceof WatchUsageError)) throw error;
    die(`wait agents: ${error.message}`, EXIT.usage);
  }
  const minIntervalS = Number(configValue("HADES_ORCH_WAKE_MIN_S", String(DEFAULT_WAKE_MIN_S))) || DEFAULT_WAKE_MIN_S;
  const work = loadWorkEnv({ skillOk: true });
  const lastFile = lastWakeFile(join(work.orch, "watch"), observerKey(scope));
  const watch = selfCli("watch", ...flags);
  const { source, stop } = watchSource(watch.command, watch.args);
  try {
    const got = await gatherWake({ source, clock: { now: Date.now }, lastWakeAt: readLastWake(lastFile), minIntervalS, settleMs: SETTLE_MS, maxMs: clock.maxMs });
    if (got.kind === "timeout") {
      out(`TIMEOUT agents depois de ${Math.floor(clock.maxMs / 60_000)} min`);
      return TIMEOUT_EXIT;
    }
    if (got.kind === "end") {
      out("END agents: o hades watch encerrou sem evento");
      return EXIT.fail;
    }
    ensureDir(lastFile);
    writeFileSync(lastFile, `${Math.floor(got.wokeAt / 1000)}\n`);
    for (const line of formatWake(got.lines)) out(line);
    return EXIT.ok;
  } finally {
    stop();
  }
}

export async function waitCommand(args: string[]): Promise<number> {
  const [sub = "", first, second] = args;
  const clock = new Clock(process.env, `${sub} ${sub === "answer" ? (second ?? "") : (first ?? "")}`.trim());
  switch (sub) {
    case "ci": return waitCi(requireArg(first, "PR"), clock);
    case "gate": return waitGate(requireArg(first, "pid"), second ?? "");
    case "queue": return waitQueue(requireArg(first, "label"), clock);
    case "merged": return waitMerged(requireArg(first, "PR"), clock);
    case "review": return waitReview(requireArg(first, "PR"), clock);
    case "answer": return waitAnswer(requireArg(first, "worktree"), requireArg(second, "Qn"), clock);
    case "proc": return waitProc(requireArg(first, "padrão"), clock);
    case "agents": return waitAgents(args.slice(1), clock);
    case "agent": return waitAgent(requireArg(first, "nome"), second ?? "idle", clock);
    default:
      out(USAGE);
      return EXIT.usage;
  }
}
