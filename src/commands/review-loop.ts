// `hades review --loop` e `hades review loop stop|status`: o loop que revisa as PRs do escopo de tempos em tempos.
// Um processo próprio (rode em segundo plano; o `hades review --loop` do /hades faz isso): dorme entre rodadas, segura o
// lock do loop e chama `hades review` por PR, então a fila de vagas (review-queue.ts) e as fases são as de sempre.
// Regras em src/lib/review-loop.ts; disco em src/lib/review-loop-store.ts; fluxo em reference/loop/review.md §7.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT, out, warn } from "../lib/output.ts";
import { need } from "../lib/deps.ts";
import { findStateDir } from "../lib/kit.ts";
import { type Janela } from "../lib/limites.ts";
import { chaves, medidas } from "../lib/limites-io.ts";
import { hadesHome, selfCli } from "../lib/paths.ts";
import { run } from "../lib/proc.ts";
import {
  asFindings, blockingOf, type Candidate, type Decision, type Finding, limitsReached, LoopArgError, type LoopOptions, newFindings,
  parseLoopArgs, type Pause, pauseText, planRound, priorContext, type PrState, type RoundRecord, roundSummary, scopeEmpty, SKIP_TEXT,
  STOP_TEXT, type StopReason, stopBefore,
} from "../lib/review-loop.ts";
import {
  appendRound, clearStop, loopDir, loopRunning, peekPrLock, readPrState, readStatus, requestStop, stopRequested, takeLoopLock,
  takePrLock, type LoopStatus, writeContext, writePrState, writeStatus,
} from "../lib/review-loop-store.ts";
import { stateDirFor } from "./review-record.ts";
import { agentFile, configValue, loadWorkEnv, readJson, type Json } from "../lib/work.ts";
import { callerPane, isoNow, orchestratorField, regReplace, regUpdate, journalAgentEnd } from "../lib/agent-registry.ts";

const PROG = "hades review --loop";
const USAGE = `usage: ${PROG} [--every 30m] [--author <login> | --pr N…] [--max N] [--deep] [--until HH:MM|<ISO>] [--rounds N]
                    [--no-post] [--note <nota do canvas>] [--wt <clone>] [--dry-run]
       hades review loop stop|status`;

const GH_TIMEOUT_MS = 60_000;
const STOP_POLL_MS = 2_000;
const LIST_LIMIT = 100;
const PR_FIELDS = "number,title,author,headRefOid,isDraft,state";
const DEFAULT_EVERY_MIN = 30;
const DEFAULT_PAUSE = { five: 85, seven: 90 } as const;

/** Resultado de uma revisão pelo `hades review`: o registro dela em `~/.claude/hades/reviews/<id>.json`. */
export interface ReviewResult {
  ok: boolean;
  recordId: string;
  headOid: string | undefined;
  reviewId: string | undefined;
  verdict: string | undefined;
  posted: boolean;
  findings: Finding[];
  costUsd: number;
  tokens: number;
}

export interface ReviewRequest {
  pr: number;
  headOid: string;
  cmd: "review-pr" | "review-agents";
  recordId: string;
  roundId: string;
  contextFile: string | undefined;
}

export interface LoopDeps {
  now(): Date;
  sleep(ms: number): Promise<void>;
  me: string;
  slug: string;
  work: string;
  clone: string;
  listCandidates(opts: LoopOptions): Candidate[];
  reviewPr(req: ReviewRequest): Promise<ReviewResult>;
  /** Medida atual das janelas de uso (`hades usage sample`); sem coleta, vazio. */
  usage(): Partial<Record<Janela, { pct: number; resetsAt: number }>>;
  pauseAt: Record<Janela, number>;
  notify(event: string, severity: "info" | "warn" | "error", text: string): Promise<void>;
  canvas: { register(name: string, pr: number): void; dismiss(name: string): void; note(text: string): Promise<void> };
  newId(): string;
  out(text: string): void;
  warn(text: string): void;
}

const agentName = (roundId: string, pr: number): string => `rev-loop-${roundId.slice(-4)}-pr${pr}`;
const reviewUrl = (slug: string, pr: number, reviewId: string): string => `https://github.com/${slug}/pull/${pr}#pullrequestreview-${reviewId}`;

function describe(d: Decision): string {
  if (d.action === "revisar") return `#${d.pr} revisar (${d.why === "head-novo" ? "head novo" : "nunca revisada"} ${d.headOid.slice(0, 8)})`;
  return `#${d.pr} pular: ${SKIP_TEXT[d.reason]}${d.detail === undefined ? "" : ` [${d.detail}]`}`;
}

interface RoundOutcome {
  record: RoundRecord;
  stop: StopReason | undefined;
}

async function oneRound(deps: LoopDeps, opts: LoopOptions, dir: string, round: number, notified: Set<string>): Promise<RoundOutcome> {
  const startedAt = isoNow();
  const id = deps.newId();
  const record: RoundRecord = { round, id, startedAt, endedAt: startedAt, outcome: "sem-mudanca", reviewed: [], skipped: [], costUsd: 0, tokens: 0, usage: {} };
  const finish = (outcome: RoundRecord["outcome"], stop?: StopReason): RoundOutcome => ({ record: { ...record, outcome, endedAt: isoNow() }, stop });
  const before = deps.usage();
  for (const [janela, a] of Object.entries(before) as [Janela, { pct: number }][]) record.usage[janela] = { before: Math.round(a.pct), after: undefined };

  const pauses = limitsReached(before, deps.pauseAt);
  if (pauses.length > 0) {
    await warnPause(deps, pauses, notified);
    return finish("pausada");
  }
  let candidates: Candidate[];
  try {
    candidates = deps.listCandidates(opts);
  } catch (error) {
    deps.warn(`rodada ${round}: a busca das PRs falhou (${error instanceof Error ? error.message : String(error)}); tento na próxima`);
    return finish("erro");
  }
  if (scopeEmpty(candidates)) return finish("escopo-vazio", "escopo-vazio");

  const locks = join(dirname(dir), "locks");
  const states = new Map<number, PrState>();
  for (const c of candidates) {
    const s = readPrState(dir, c.number);
    if (s !== undefined) states.set(c.number, s);
  }
  const locked = new Map<number, string>();
  for (const c of candidates) {
    const owner = peekPrLock(locks, c.number);
    if (owner !== undefined) locked.set(c.number, owner);
  }
  const plan = planRound({ candidates, states, locked, me: deps.me, explicit: new Set(opts.prs), max: opts.max });
  deps.out(`rodada ${round}: ${plan.map(describe).join(" · ") || "nenhuma PR no escopo"}`);
  record.skipped = plan.flatMap((d) => (d.action === "pular" ? [{ pr: d.pr, reason: d.reason }] : []));
  const todo = plan.filter((d): d is Extract<Decision, { action: "revisar" }> => d.action === "revisar");
  if (opts.dryRun || todo.length === 0) return finish("sem-mudanca");

  const held: { pr: number; release(): void }[] = [];
  const running: { d: Extract<Decision, { action: "revisar" }>; recordId: string; agent: string }[] = [];
  for (const d of todo) {
    const lock = takePrLock(locks, d.pr, deps.clone);
    if (!lock.held) record.skipped.push({ pr: d.pr, reason: "lock" });
    else {
      held.push({ pr: d.pr, release: lock.release });
      running.push({ d, recordId: deps.newId(), agent: agentName(id, d.pr) });
    }
  }
  const results = new Map<number, ReviewResult>();
  try {
    for (const r of running) deps.canvas.register(r.agent, r.d.pr);
    await Promise.all(running.map(async (r) => {
      const previous = states.get(r.d.pr);
      const context = priorContext(previous);
      const contextFile = context === "" ? undefined : writeContext(dir, r.d.pr, context);
      results.set(r.d.pr, await deps.reviewPr({ pr: r.d.pr, headOid: r.d.headOid, cmd: opts.deep ? "review-agents" : "review-pr", recordId: r.recordId, roundId: id, contextFile }));
    }));
  } finally {
    for (const h of held) h.release();
    for (const r of running) deps.canvas.dismiss(r.agent);
  }

  const blockers: string[] = [];
  for (const r of running) {
    const result = results.get(r.d.pr);
    if (result === undefined) continue;
    const previous = states.get(r.d.pr);
    const fresh = newFindings(previous?.open ?? [], result.findings);
    const blocking = blockingOf(fresh).length;
    if (result.ok) {
      const head = result.headOid ?? r.d.headOid;
      writePrState(dir, {
        pr: r.d.pr, headOid: head, reviewedAt: isoNow(), verdict: result.verdict, open: result.findings,
        reviewUrl: result.posted && result.reviewId !== undefined ? reviewUrl(deps.slug, r.d.pr, result.reviewId) : previous?.reviewUrl,
      });
      if (blocking > 0) blockers.push(`#${r.d.pr} (${blocking})`);
    }
    record.reviewed.push({ pr: r.d.pr, headOid: r.d.headOid, state: result.ok ? "ok" : "falhou", recordId: result.recordId, blocking, costUsd: result.costUsd });
    record.costUsd += result.costUsd;
    record.tokens += result.tokens;
  }
  for (const [janela, a] of Object.entries(deps.usage()) as [Janela, { pct: number }][]) {
    const u = record.usage[janela];
    if (u !== undefined) u.after = Math.round(a.pct);
  }
  if (blockers.length > 0) await deps.notify("pr", "warn", `Loop de revisão: achado bloqueante novo em ${blockers.join(", ")}`);
  return finish(record.reviewed.length > 0 ? "revisada" : "sem-mudanca");
}

/** Pausa por limite: avisa uma vez por janela e por renovação; a rodada seguinte mede de novo e retoma sozinha. */
async function warnPause(deps: LoopDeps, pauses: Pause[], notified: Set<string>): Promise<void> {
  const fresh = pauses.filter((p) => !notified.has(`${p.janela}:${p.resetsAt}`));
  deps.warn(`loop pausado: ${pauses.map(pauseText).join(", ")}`);
  if (fresh.length === 0) return;
  for (const p of fresh) notified.add(`${p.janela}:${p.resetsAt}`);
  await deps.notify("agent", "warn", `Loop de revisão pausado: ${fresh.map(pauseText).join(", ")}. Retoma sozinho quando a janela baixar.`);
}

/** Dorme até `untilMs`, acordando para ver o pedido de parada; devolve true se pararam. */
async function sleepUntil(deps: LoopDeps, dir: string, untilMs: number): Promise<boolean> {
  while (deps.now().getTime() < untilMs) {
    if (stopRequested(dir)) return true;
    await deps.sleep(Math.min(STOP_POLL_MS, untilMs - deps.now().getTime()));
  }
  return stopRequested(dir);
}

export async function runLoop(deps: LoopDeps, opts: LoopOptions): Promise<{ code: number; stop: StopReason | undefined; rounds: number }> {
  const dir = loopDir(deps.work);
  if (!opts.dryRun && !takeLoopLock(dir)) {
    deps.warn(`já existe um loop de revisão rodando neste repositório (${PROG} recusado): pare-o com \`hades review loop stop\``);
    return { code: EXIT.fail, stop: undefined, rounds: 0 };
  }
  if (!opts.dryRun) clearStop(dir);
  const since = isoNow();
  const status = (state: LoopStatus["state"], round: number, extra: Partial<LoopStatus> = {}): void => {
    if (!opts.dryRun) writeStatus(dir, { state, pid: process.pid, since, round, nextAt: undefined, reason: undefined, ...extra });
  };
  const notified = new Set<string>();
  let rounds = 0;
  let attempts = 0;
  let stop: StopReason | undefined;
  for (;;) {
    stop = stopBefore(opts, rounds, deps.now(), stopRequested(dir));
    if (stop !== undefined) break;
    attempts++;
    status("rodando", rounds + 1);
    const { record, stop: ended } = await oneRound(deps, opts, dir, rounds + 1, notified);
    if (!opts.dryRun && record.outcome !== "escopo-vazio") appendRound(dir, record);
    if (record.reviewed.length > 0) await deps.canvas.note(roundSummary(record));
    if (ended !== undefined || opts.dryRun) {
      stop = ended;
      break;
    }
    if (record.outcome !== "pausada" && record.outcome !== "erro") rounds++;
    stop = stopBefore(opts, rounds, deps.now(), stopRequested(dir));
    if (stop !== undefined) break;
    const next = Math.min(deps.now().getTime() + opts.everyMs, opts.untilMs ?? Number.POSITIVE_INFINITY);
    status(record.outcome === "pausada" ? "pausada" : "rodando", rounds, { nextAt: new Date(next).toISOString(), reason: record.outcome });
    await sleepUntil(deps, dir, next);
  }
  if (stop !== undefined) deps.out(`loop encerrado: ${STOP_TEXT[stop]} (${rounds} rodada(s) com PR revisada ou sem mudança, ${attempts} tentativa(s))`);
  status("parada", rounds, { reason: stop });
  return { code: EXIT.ok, stop, rounds };
}

// ------------------------------------------------------------------ bordas reais

function sh(argv: string[]): string {
  const [command = "", ...rest] = argv;
  const r = run(command, rest, { timeoutMs: GH_TIMEOUT_MS });
  if (r.timedOut) throw new Error(`${argv.slice(0, 3).join(" ")}: excedeu ${GH_TIMEOUT_MS / 1000} s`);
  if (r.status !== 0) throw new Error(`${argv.slice(0, 3).join(" ")}: ${(r.stderr || r.stdout).trim().split("\n").at(-1) ?? `rc=${r.status}`}`);
  return r.stdout;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Valida na fronteira cada PR que o `gh` devolve; o miolo só vê Candidate. */
function toCandidate(raw: unknown): Candidate {
  if (!isRecord(raw) || !isRecord(raw.author)) throw new Error("gh: PR sem os campos esperados");
  const { number, headRefOid, isDraft, state, title } = raw;
  const login = raw.author.login;
  if (typeof number !== "number" || typeof headRefOid !== "string" || typeof login !== "string" || typeof title !== "string") throw new Error("gh: PR com campo inválido");
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") throw new Error(`gh: estado de PR desconhecido '${String(state)}'`);
  return { number, headOid: headRefOid, isDraft: isDraft === true, state, author: login, title };
}

function listCandidates(slug: string, opts: LoopOptions): Candidate[] {
  if (opts.prs.length > 0) return opts.prs.map((n) => toCandidate(JSON.parse(sh(["gh", "pr", "view", String(n), "--repo", slug, "--json", PR_FIELDS]))));
  const scope = opts.author === undefined ? ["--search", "review-requested:@me"] : ["--author", opts.author];
  const list: unknown = JSON.parse(sh(["gh", "pr", "list", "--repo", slug, ...scope, "--state", "open", "--limit", String(LIST_LIMIT), "--json", PR_FIELDS]));
  if (!Array.isArray(list)) throw new Error("gh pr list: resposta não é uma lista");
  return list.map(toCandidate);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function readRecord(id: string): Record<string, unknown> | undefined {
  const file = join(hadesHome(), "reviews", `${id}.json`);
  if (!existsSync(file)) return undefined;
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  return isRecord(data) ? data : undefined;
}

function resultOf(req: ReviewRequest, code: number): ReviewResult {
  const rec = readRecord(req.recordId);
  const t = rec !== undefined && isRecord(rec.tokens) ? rec.tokens : {};
  const findings = rec !== undefined && Array.isArray(rec.achados) ? asFindings(rec.achados) : [];
  return {
    ok: code === 0 && rec?.state === "ok", recordId: req.recordId, headOid: typeof rec?.headOid === "string" ? rec.headOid : undefined,
    reviewId: typeof rec?.reviewId === "string" ? rec.reviewId : undefined, verdict: typeof rec?.verdict === "string" ? rec.verdict : undefined,
    posted: rec?.posted === true, findings, costUsd: num(rec?.costUsd), tokens: num(t.input) + num(t.output) + num(t.cacheRead) + num(t.cacheWrite),
  };
}

function limitsFromConfig(): Record<Janela, number> {
  const read = (key: string, fallback: number): number => {
    const raw = configValue(key, String(fallback));
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 100) return n;
    warn(`${key}=${raw} fora de 1..100: usando ${fallback}`);
    return fallback;
  };
  return { five: read("HADES_REVIEW_LOOP_PAUSE_FIVE_PCT", DEFAULT_PAUSE.five), seven: read("HADES_REVIEW_LOOP_PAUSE_SEVEN_PCT", DEFAULT_PAUSE.seven) };
}

function realDeps(opts: LoopOptions, slug: string, wt: string, newId: () => string): LoopDeps {
  const stateDir = findStateDir();
  const work = dirname(stateDirFor(...(slug.split("/") as [string, string])));
  const workEnv = loadWorkEnv({ cwd: wt });
  const model = configValue("HADES_MODEL_REVIEW", "opus").includes("sonnet") ? "sonnet" : "opus";
  const effort = ["low", "medium", "high"].includes(configValue("HADES_EFFORT_REVIEW", "medium")) ? configValue("HADES_EFFORT_REVIEW", "medium") : "medium";
  const k = chaves();
  return {
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    me: sh(["gh", "api", "user", "--jq", ".login"]).trim(),
    slug, work, clone: wt, newId,
    listCandidates: (o) => listCandidates(slug, o),
    usage: () => medidas(new Date(), k).atual,
    pauseAt: limitsFromConfig(),
    async reviewPr(req) {
      const argv = ["review", "--wt", wt, "--pr", String(req.pr), "--cmd", req.cmd, "--model", model, "--effort", effort, "--id", req.recordId, "--loop-round", req.roundId];
      if (opts.post) argv.push("--post");
      if (req.contextFile !== undefined) argv.push("--loop-context", req.contextFile);
      const cli = selfCli(...argv);
      const log = openSync(join(loopDir(work), `review-pr${req.pr}.log`), "w");
      try {
        const code = await new Promise<number>((resolve, reject) => {
          const child = spawn(cli.command, cli.args, { stdio: ["ignore", log, log] });
          child.on("error", reject);
          child.on("close", (c) => resolve(c ?? EXIT.fail));
        });
        return resultOf(req, code);
      } finally {
        closeSync(log);
      }
    },
    async notify(event, severity, text) {
      if (stateDir === undefined) return;
      const r = run("bash", [join(stateDir, "notify.sh"), "send", event, severity, text], { timeoutMs: GH_TIMEOUT_MS });
      if (r.status !== 0) warn(`notificação não saiu: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    },
    canvas: {
      register(name, pr) {
        if (callerPane() === undefined) return;
        regReplace(workEnv, name, { name, mode: "review-loop", role: "review", pr, state: "working", createdAt: isoNow(), ...orchestratorField("") } as Json);
      },
      dismiss(name) {
        if (callerPane() === undefined || readJson(agentFile(workEnv, name)) === undefined) return;
        regUpdate(workEnv, name, (current) => ({ ...current, state: "done", endedAt: isoNow() }));
        journalAgentEnd(name, "done", wt);
      },
      async note(text) {
        if (opts.note === undefined) return;
        const cli = selfCli("canvas", "note", "write", opts.note, "--append");
        const r = spawnSync(cli.command, cli.args, { input: `${text}\n\n`, encoding: "utf8", timeout: GH_TIMEOUT_MS });
        if (r.status !== 0) warn(`nota do canvas '${opts.note}' não gravada: ${(r.stderr || "sem saída").trim().slice(0, 200)}`);
      },
    },
    out, warn,
  };
}

function repoOf(wt: string): string {
  const remote = sh(["git", "-C", wt, "config", "--get", "remote.origin.url"]).trim();
  const slug = /github\.com[:/]([^/]+\/[^/.]+)/.exec(remote)?.[1];
  if (slug === undefined) throw new Error(`remote.origin.url não é um repositório do GitHub: ${remote}`);
  return slug;
}

function stopOrStatus(verb: string, wt: string): number {
  const dir = loopDir(dirname(stateDirFor(...(repoOf(wt).split("/") as [string, string]))));
  if (verb === "stop") {
    if (!loopRunning(dir)) {
      out("nenhum loop de revisão rodando neste repositório");
      return EXIT.ok;
    }
    requestStop(dir);
    out("pedido de parada gravado: o loop encerra ao acordar (no máximo em alguns segundos; a revisão em curso termina antes)");
    return EXIT.ok;
  }
  const s = readStatus(dir);
  out(s === undefined ? "sem loop de revisão neste repositório" : `loop ${loopRunning(dir) ? s.state : "parado"}: rodada ${s.round}${s.nextAt ? `, próxima ${s.nextAt}` : ""}${s.reason ? ` (${s.reason})` : ""} · pid ${s.pid}`);
  return EXIT.ok;
}

export async function reviewLoopCommand(args: string[], newId: () => string): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    out(`${USAGE}\n\nRevisa de tempos em tempos as PRs do escopo que mudaram de head desde o último review.`);
    return EXIT.ok;
  }
  need("git");
  need("gh");
  const verb = args[0] === "loop" ? args[1] : undefined;
  const wtFlag = args.findIndex((a) => a === "--wt");
  const wt = (wtFlag >= 0 ? args[wtFlag + 1] : undefined) ?? process.env.HADES_WT ?? process.cwd();
  try {
    if (verb === "stop" || verb === "status") return stopOrStatus(verb, wt);
    if (args[0] === "loop") throw new LoopArgError("use `hades review loop stop` ou `hades review loop status`");
    const everyMin = Number(configValue("HADES_REVIEW_LOOP_EVERY_MIN", String(DEFAULT_EVERY_MIN)));
    const opts = parseLoopArgs(args, new Date(), -new Date().getTimezoneOffset(), Number.isInteger(everyMin) && everyMin >= 1 ? everyMin : DEFAULT_EVERY_MIN);
    const slug = repoOf(opts.wt ?? wt);
    const deps = realDeps(opts, slug, opts.wt ?? wt, newId);
    const { code } = await runLoop(deps, opts);
    return code;
  } catch (error) {
    if (!(error instanceof LoopArgError)) throw error;
    warn(`${USAGE}\n${PROG}: error: ${error.message}`);
    return EXIT.usage;
  }
}
