// `hades watch`: monitor do orquestrador, uma linha por evento novo dos agentes registrados (hades watch).
// O que já foi visto fica em <orch>/watch (ou HADES_WATCH_STATE); sobrevive a relançar. Cada observador (pane do herdr ou
// filtro de --agent) tem a sua subpasta, e o escopo padrão é o dos agentes que o pane atual alocou (src/lib/watch-scope.ts).
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parsePullRequest, text } from "../lib/activity.ts";
import { need } from "../lib/deps.ts";
import { contextOfDir } from "../lib/guard-hook.ts";
import { emitJournal } from "../lib/journal.ts";
import { commitsCitados, reportTemProva } from "../lib/cerberus-vigilia.ts";
import { budgetOf, budgetQuestion, DEFAULT_ASK_PCT, DEFAULT_WARN_PCT, estimateOfUnit, hasBudgetQuestion, nextQuestionNumber } from "../lib/moirai.ts";
import { JANELAS, type Janela } from "../lib/limites.ts";
import { janelasParaAvisar, linhaDeLimite } from "../lib/limites-aviso.ts";
import { chaves, limiaresDeAviso, medidas } from "../lib/limites-io.ts";
import { firstLine, readText } from "../lib/fs.ts";
import { out, warn } from "../lib/output.ts";
import { run } from "../lib/proc.ts";
import { inScope, observerKey, parseWatchArgs, WatchUsageError, type WatchScope } from "../lib/watch-scope.ts";
import { loadProfile } from "../lib/profile.ts";
import { resolveProject } from "../lib/project.ts";
import { currentCost, type CostCache } from "./moirai.ts";
import { exists, fixRuleOf, isProductionFix } from "../lib/thanatos.ts";
import {
  agentFiles, configValue, countQuestions, loadWorkEnv, openQuestions, readJson, writeJsonAtomic, type Json, type WorkEnv,
} from "../lib/work.ts";

const DEFAULT_EVERY_SECONDS = 60;
const DEFAULT_STALL_MINUTES = 25;
const DEFAULT_CONTEXT_CAP = 200_000;
const CONTEXT_STEP = 50_000;
const FINAL_STATES = ["done", "archived"];
const GH_TIMEOUT_MS = 60_000;
const PR_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){state
  reviews(last:50){nodes{id}} comments(last:50){nodes{id}} reviewThreads(last:100){nodes{comments(last:20){nodes{id}}}}}}}`;

/** Limiar da Moirai em %: inteiro positivo; valor inválido avisa e cai no padrão (o watch não para por config). */
function pctKey(key: string, fallback: number): number {
  const raw = configValue(key, String(fallback));
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  warn(`watch: ${key}=${raw}: esperava um inteiro positivo; uso ${fallback}`);
  return fallback;
}

type DoneHeld = "sem-prova" | "sem-commit" | "commit-fora-da-branch";

const isoNow = (): string => `${new Date().toISOString().slice(0, 19)}Z`;

/**
 * Pasta do "já visto" do observador. A primeira passada de um observador novo herda os arquivos da pasta compartilhada
 * (o upgrade não reemite o que já foi visto); dali em diante o estado dele é só dele.
 */
function observerDir(shared: string, key: string | undefined): string {
  if (key === undefined) return shared;
  const dir = join(shared, "by", key);
  if (existsSync(dir)) return dir;
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(shared, { withFileTypes: true })) if (entry.isFile()) copyFileSync(join(shared, entry.name), join(dir, entry.name));
  return dir;
}

class Watcher {
  private emitted = false;
  private readonly seenDir: string;
  private readonly owner: string;
  private readonly repo: string;

  private readonly work: WorkEnv;
  private readonly stallMinutes: number;
  private readonly warnPct = pctKey("HADES_MOIRAI_WARN_PCT", DEFAULT_WARN_PCT);
  private readonly askPct = pctKey("HADES_MOIRAI_ASK_PCT", DEFAULT_ASK_PCT);

  private readonly scope: WatchScope;
  private readonly limiares = limiaresDeAviso();
  private readonly limitesK = chaves();

  constructor(work: WorkEnv, stallMinutes: number, env: NodeJS.ProcessEnv, scope: WatchScope) {
    this.work = work;
    this.stallMinutes = stallMinutes;
    this.scope = scope;
    const shared = env.HADES_WATCH_STATE || join(work.orch, "watch");
    mkdirSync(shared, { recursive: true });
    this.seenDir = observerDir(shared, observerKey(scope));
    this.owner = work.slug.split("__")[0] ?? "";
    this.repo = work.slug.slice(work.slug.indexOf("__") + 2);
  }

  get emittedAny(): boolean {
    return this.emitted;
  }

  private emit(line: string): void {
    out(line);
    this.emitted = true;
    this.journal(line);
  }

  /** `EVENTO agente resto…` → diário do agente (reference/journal.md); o diário nunca atrapalha o plantão. */
  private journal(line: string): void {
    const [event = "", agent = ""] = line.split(" ");
    emitJournal("watch", `watch.${event.toLowerCase()}`, line, { agent, get: (key) => configValue(key, "") });
  }

  /** true se o valor é novo para a chave (e o grava). */
  private seen(key: string, value: string): boolean {
    const file = join(this.seenDir, key);
    if ((readText(file) ?? "").replace(/\n+$/, "") === value && existsSync(file)) return false;
    writeFileSync(file, value);
    return true;
  }

  private mtimeSeconds(file: string): number {
    return Math.floor(statSync(file).mtimeMs / 1000);
  }

  scan(): void {
    const herdr = run("herdr", ["agent", "list"]);
    const hostStatus = this.hostStatuses(herdr.stdout);
    const records = agentFiles(this.work).map((file) => ({ file, reg: readJson(file) })).filter((r): r is { file: string; reg: Json } => r.reg !== undefined);
    // o mesmo nome em duas raízes (resto de um clone antigo): encerrado em uma vale para as duas
    const finished = new Set(records.filter(({ reg }) => FINAL_STATES.includes(text(reg.state))).map(({ reg }) => text(reg.name)));
    // e uma unidade por nome: o mesmo nome nas duas raízes gera um evento só (a primeira raiz vence)
    const scanned = new Set<string>();
    for (const { file, reg } of records) {
      const name = text(reg.name);
      if (finished.has(name) || scanned.has(name)) continue;
      scanned.add(name);
      if (!inScope(this.scope, reg)) continue;
      this.scanAgent(file, reg, hostStatus);
    }
    this.scanLimites();
  }

  /**
   * Janela do plano (5 h, semana) acima do limiar: LIMITE uma vez por janela e por renovação. O aviso é da máquina, não de
   * um agente, então não passa pelo filtro de dono: cada observador o recebe uma vez (o visto é dele). Sem amostra, nada.
   */
  private scanLimites(): void {
    const { atual } = medidas(new Date(), this.limitesK);
    const visto: Partial<Record<Janela, number>> = {};
    for (const janela of JANELAS) {
      const n = Number((readText(join(this.seenDir, `limite.${janela}`)) ?? "").trim());
      if (Number.isFinite(n) && n > 0) visto[janela] = n;
    }
    for (const aviso of janelasParaAvisar(atual, this.limiares, visto)) {
      writeFileSync(join(this.seenDir, `limite.${aviso.janela}`), `${aviso.resetsAt}\n`);
      this.emit(linhaDeLimite(aviso));
    }
  }

  private hostStatuses(raw: string): Map<string, string> {
    const statuses = new Map<string, string>();
    try {
      const agents = (JSON.parse(raw) as { result?: { agents?: Json[] } }).result?.agents ?? [];
      for (const a of agents) if (!statuses.has(text(a.name))) statuses.set(text(a.name), text(a.agent_status));
    } catch {
      return statuses;
    }
    return statuses;
  }

  private scanAgent(file: string, reg: Json, hostStatus: Map<string, string>): void {
    const name = text(reg.name);
    const promptedAt = text(reg.promptedAt);
    const promptedEpoch = promptedAt ? Math.floor(Date.parse(promptedAt) / 1000) || 0 : 0;
    const worktree = text(reg.worktree);
    const reports = join(worktree, this.work.reports);
    // antes das perguntas: a QUESTION de custo é gravada aqui e sai pelo mesmo caminho das do agente
    this.scanBudget(name, file, worktree, text(reg.phase) || text(reg.role) || "impl");
    this.scanQuestions(name, worktree);
    this.scanDone(name, join(reports, "report.md"), worktree, promptedAt, promptedEpoch, reg.noCommit === true);
    const pr = this.scanPrOpen(name, file, reg, text(reg.pr));
    if (pr) this.scanReview(name, pr);
    this.scanParked(name, join(reports, "handoff.md"), promptedEpoch);
    this.scanContext(name, worktree, text(reg.role) || "impl");
    this.scanStall(name, hostStatus.get(name) ?? "", promptedAt !== "");
  }

  /**
   * Teto da Moirai (reference/moirai.md): o custo corrente do agente contra o p75 da estimativa do plano da sua raiz.
   * BUDGET ao passar HADES_MOIRAI_WARN_PCT; ao passar HADES_MOIRAI_ASK_PCT grava a pergunta no questions.md do agente (a
   * QUESTION sai do scanQuestions). Um aviso por limiar por fase. Nada para o agente; sem estimativa no plano, nada sai.
   */
  private scanBudget(name: string, file: string, worktree: string, phase: string): void {
    const planPath = text(readJson(join(dirname(dirname(file)), "plan.json"))?.path);
    const planText = planPath ? readText(planPath) : undefined;
    const p75 = planText === undefined ? null : (estimateOfUnit(planText, name)?.costP75 ?? null);
    if (p75 === null) return;
    const cacheFile = join(this.seenDir, `${name}.cost.json`);
    const cache: CostCache = readJson(cacheFile) ?? {};
    const { costUsd, read } = currentCost(worktree, cache);
    if (read > 0) writeFileSync(cacheFile, JSON.stringify(cache));
    const budget = budgetOf(costUsd, p75, this.warnPct, this.askPct);
    if (budget.pct === null) return;
    // o visto leva a fase na chave: trocar de fase abre o limiar daquela fase, voltar a uma fase não o reabre
    const phaseKey = phase.replace(/[^A-Za-z0-9._-]/g, "_");
    if (budget.warn && this.seen(`${name}.budget-warn.${phaseKey}`, "1")) this.emit(`BUDGET ${name} ${Math.floor(budget.pct)}`);
    if (budget.ask && this.seen(`${name}.budget-ask.${phaseKey}`, "1")) {
      const questions = join(worktree, this.work.reports, "questions.md");
      const existing = readText(questions) ?? "";
      // a marca fica na orquestração do agente, não no visto (que o dono apaga ao relançar o watch) nem no questions.md
      // (que o agente reescreve): a pergunta de uma fase sai uma vez só
      const mark = join(dirname(dirname(file)), "budget-ask", `${name}.${phaseKey}`);
      const asked = existsSync(mark) || hasBudgetQuestion(existing, this.askPct, phase);
      mkdirSync(dirname(mark), { recursive: true });
      writeFileSync(mark, `${isoNow()}\n`);
      if (asked) return;
      const number = nextQuestionNumber(existing);
      appendFileSync(questions, `${existsSync(questions) ? "\n" : ""}${budgetQuestion({ number, unit: name, phase, costUsd, p75, pct: budget.pct, askPct: this.askPct })}`);
    }
  }

  private scanQuestions(name: string, worktree: string): void {
    if (readText(join(worktree, this.work.reports, "questions.md")) === undefined) return;
    const total = String(countQuestions(worktree, this.work.reports));
    const open = openQuestions(worktree, this.work.reports);
    if (this.seen(`${name}.q`, total) && open > 0) this.emit(`QUESTION ${name} ${open}`);
  }

  /**
   * DONE uma vez por prompt do agente, só com report escrito depois dele (o de rodada anterior continua no disco depois do
   * prompt novo) e só com o que a Vigília cobra: uma prova de execução e um commit citado que está na branch (fase
   * `--no-commit` dispensa o commit). Reescrever o report no mesmo prompt não reemite. Report que se declara DONE mas
   * falta prova ou commit sai como DONE-HELD, uma vez por prompt e motivo, para o orquestrador não esperar calado.
   */
  private scanDone(name: string, report: string, worktree: string, promptedAt: string, promptedEpoch: number, noCommit: boolean): void {
    if (!firstLine(report).startsWith("STATUS: DONE") || this.mtimeSeconds(report) <= promptedEpoch) return;
    const held = this.heldReason(readText(report) ?? "", worktree, noCommit);
    const cycle = promptedAt || "sem-prompt";
    if (held === undefined) {
      if (this.seen(`${name}.done`, cycle)) this.emit(`DONE ${name}`);
      return;
    }
    if (this.seen(`${name}.done-held`, `${cycle}|${held}`)) this.emit(`DONE-HELD ${name} ${held}`);
  }

  /** Por que o DONE do report ainda não vale; undefined quando vale. */
  private heldReason(body: string, worktree: string, noCommit: boolean): DoneHeld | undefined {
    if (!reportTemProva(body)) return "sem-prova";
    if (noCommit) return undefined;
    const shas = commitsCitados(body);
    if (shas.length === 0) return "sem-commit";
    return this.commitNaBranch(worktree, shas) ? undefined : "commit-fora-da-branch";
  }

  private commitNaBranch(worktree: string, shas: string[]): boolean {
    return shas.some((sha) => run("git", ["-C", worktree, "merge-base", "--is-ancestor", sha, "HEAD"]).status === 0);
  }

  private scanPrOpen(name: string, file: string, reg: Json, known: string): string {
    const branch = text(reg.branch);
    const mode = text(reg.mode);
    if (known || !branch || mode === "review" || mode === "skill") return known;
    const found = run("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number", "--jq", ".[0].number"], { timeoutMs: GH_TIMEOUT_MS }).stdout.trim();
    if (!found) return "";
    writeJsonAtomic(file, { ...reg, pr: Number(found) });
    this.emit(`PR-OPEN ${name} #${found}`);
    return found;
  }

  private scanReview(name: string, pr: string): void {
    const r = run("gh", ["api", "graphql", "-f", `query=${PR_QUERY}`, "-F", `o=${this.owner}`, "-F", `r=${this.repo}`, "-F", `n=${pr}`], { timeoutMs: GH_TIMEOUT_MS });
    const view = r.status === 0 && r.stdout ? parsePullRequest(r.stdout) : undefined;
    if (!view) return;
    const idsFile = join(this.seenDir, `${name}.ids`);
    const previous = readText(idsFile) ?? "";
    const known = new Set(previous.split("\n").filter(Boolean));
    const fresh = [...new Set(view.ids)].filter((id) => !known.has(id)).length;
    if (previous !== "" && fresh > 0) this.emit(`REVIEW ${name} #${pr} ${fresh} novos`);
    writeFileSync(idsFile, `${[...new Set(view.ids)].sort().join("\n")}\n`);
    if (view.state !== "OPEN" && this.seen(`${name}.state`, view.state)) {
      this.emit(`${view.state} ${name} #${pr}`);
      if (view.state === "MERGED") this.suggestPostmortem(name, pr);
    }
  }

  /** PR de fix de produção mergeada (regra do perfil: thanatos.fixBranchPattern/fixLabels) → sugere o post-mortem; sem regra, nada. */
  private suggestPostmortem(name: string, pr: string): void {
    if (configValue("HADES_THANATOS_SUGGEST", "1") === "0") return;
    const resolution = resolveProject(this.work.repoTop);
    const rule = resolution.code === 0 ? fixRuleOf(loadProfile(resolution)) : undefined;
    if (rule === undefined || exists(join(this.work.work, "postmortems"), `pr-${pr}`)) return;
    const r = run("gh", ["pr", "view", pr, "-R", `${this.owner}/${this.repo}`, "--json", "headRefName,labels"], { timeoutMs: GH_TIMEOUT_MS });
    if (r.status !== 0) return;
    try {
      const doc = JSON.parse(r.stdout) as { headRefName?: string; labels?: { name?: string }[] };
      const labels = (doc.labels ?? []).map((l) => l.name ?? "").filter((l) => l !== "");
      if (isProductionFix(rule, { branch: doc.headRefName ?? "", labels })) this.emit(`THANATOS ${name} #${pr} fix de produção mergeado: hades thanatos new ${pr}`);
    } catch {
      return;
    }
  }

  /** handoff mais velho que o último prompt já foi retomado (o resume não apaga o arquivo): não é estacionamento novo. */
  private scanParked(name: string, handoff: string, promptedEpoch: number): void {
    const head = firstLine(handoff);
    if (!head.startsWith("STATUS: PARKED") || this.mtimeSeconds(handoff) <= promptedEpoch) return;
    if (this.seen(`${name}.parked`, String(this.mtimeSeconds(handoff)))) this.emit(`PARKED ${name} ${head.replace(/^STATUS: PARKED *—* */, "")}`);
  }

  private scanContext(name: string, worktree: string, role: string): void {
    const cap = Number(configValue(`HADES_CTX_CAP_${role.toUpperCase()}`, String(DEFAULT_CONTEXT_CAP))) || DEFAULT_CONTEXT_CAP;
    const used = contextOfDir(worktree);
    if (used > cap && this.seen(`${name}.ctx`, String(Math.floor(used / CONTEXT_STEP)))) this.emit(`CONTEXT ${name} ${Math.floor(used / 1000)}k`);
  }

  /** sem prompt ainda, o idle é a sessão à espera do dono, não parada. */
  private scanStall(name: string, hostStatus: string, prompted: boolean): void {
    const idleFile = join(this.seenDir, `${name}.idle`);
    if (hostStatus !== "idle" || !prompted) {
      rmSync(idleFile, { force: true });
      rmSync(join(this.seenDir, `${name}.stall`), { force: true });
      return;
    }
    if (!existsSync(idleFile)) writeFileSync(idleFile, `${Math.floor(Date.now() / 1000)}\n`);
    const since = Number((readText(idleFile) ?? "").trim()) || 0;
    const minutes = Math.floor((Math.floor(Date.now() / 1000) - since) / 60);
    if (minutes >= this.stallMinutes && this.seen(`${name}.stall`, String(Math.floor(minutes / this.stallMinutes)))) this.emit(`STALLED ${name} ${minutes}`);
  }
}

export async function watchCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseWatchArgs(args);
  } catch (error) {
    if (!(error instanceof WatchUsageError)) throw error;
    warn(`watch: ${error.message}`);
    return 2;
  }
  const everySeconds = parsed.everySeconds ?? DEFAULT_EVERY_SECONDS;
  need("herdr");
  need("gh");
  const work = loadWorkEnv({ skillOk: true });
  const stall = Number(configValue("HADES_ORCH_STALL_MIN", String(DEFAULT_STALL_MINUTES))) || DEFAULT_STALL_MINUTES;
  const watcher = new Watcher(work, stall, process.env, parsed.scope);
  for (;;) {
    watcher.scan();
    if (parsed.next && watcher.emittedAny) return 0;
    await new Promise((resolve) => setTimeout(resolve, everySeconds * 1000));
  }
}
