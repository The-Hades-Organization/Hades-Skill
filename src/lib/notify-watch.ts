// Vigia de notificações (unit <HU>-notify): gates, serviços, PRs, diagnóstico e agentes. Cada fonte devolve os problemas
// de agora; o dedupe do notify.ts decide o que é novo. Uma fonte quebrada não derruba as outras.
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { HEALTH_DEFAULT, healthPaths } from "./config.ts";
import { listDir, readText } from "./fs.ts";
import { type Heartbeat, type NotifyContext, WHY_REPEATED, forget, jload, jsave, notify, scrub } from "./notify.ts";
import { type PrSnapshot, ackMark, loadMarks, planPrNotices, saveMarks, toSnapshot } from "./notify-marks.ts";
import { splitLines } from "./pyjson.ts";
import { run } from "./proc.ts";
import { serviceManager } from "./service-manager.ts";
import { join } from "node:path";
import { selfCli } from "./paths.ts";
import { runningOverrun } from "./gate.ts";

const TICK_MS = 5000;
const AGENT_RETRY_MS = 60000;
const AGENT_GRACE_S = 30;
const RESTART_WINDOW_S = 600;
const HEALTH_TIMEOUT_MS = 3000;
const HEALTH_FAILS_TO_ALERT = 2; // uma falha só é o serviço subindo
const GATE_TOOLS = new Set(["gate", "build", "test", "test:integration"]);
const AGENT_WORDS = ["STALLED", "QUESTION", "DONE", "BUDGET", "CTX-OVER", "MODEL-MISMATCH", "DISMISSED", "DISMISS-READY", "DISMISS-HELD"] as const;
type AgentWord = (typeof AGENT_WORDS)[number];
const INFO_WORDS: ReadonlySet<AgentWord> = new Set<AgentWord>(["DONE", "DISMISSED"]);

type Problem = [severity: string, text: string, sig: string];
type Problems = Map<string, { event: string; obj: string; problem: Problem }>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isAgentWord = (word: string): word is AgentWord => (AGENT_WORDS as readonly string[]).includes(word);
const lines = (text: string | undefined): string[] => splitLines(text ?? "").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

function isoAgeMin(value: string): number {
  const text = value.replace("Z", "+00:00");
  const parsed = Date.parse(/[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(parsed) ? 0 : (Date.now() - parsed) / 60000;
}

async function httpCode(port: string, path: string): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return response.status;
  } catch {
    return 0;
  }
}

function hadesPaused(dir: string): boolean {
  const last = splitLines((readText(join(dir, "logs", "cede.log")) ?? "").trimEnd()).pop();
  return last?.endsWith(" paused") ?? false;
}

interface Source {
  name: string;
  events: string[];
  key: string;
  every: number;
  fn: () => Promise<void>;
}

export class Watcher {
  private readonly ctx: NotifyContext;
  private readonly restarts = new Map<string, Array<[number, number]>>();
  private readonly healthFails = new Map<string, number>();
  private readonly beat: Heartbeat;
  private readonly locks: string;
  private agentChild: ChildProcess | undefined;

  constructor(ctx: NotifyContext) {
    this.ctx = ctx;
    this.beat = { ...jload<Heartbeat>(ctx.beat, {}), pid: process.pid, sources: {} };
    this.locks = process.env.LOCKS ?? "";
  }

  private enabled(...events: string[]): boolean {
    return events.some((event) => this.ctx.eventChannels(event) !== "off");
  }

  /** Avisa os problemas novos ou mudados; esquece os que sumiram. */
  private async problems(src: string, probs: Problems): Promise<void> {
    const keep = new Set<string>();
    for (const { event, obj, problem } of probs.values()) {
      keep.add(`${event}|${scrub(obj, 60)}`);
      await notify(this.ctx, event, problem[0], problem[1], { obj, sig: problem[2], src });
    }
    await forget(this.ctx, src, keep);
  }

  static add(probs: Problems, event: string, obj: string, problem: Problem): void {
    probs.set(`${event}\u0000${obj}`, { event, obj, problem });
  }

  /** Falha no journal do gate-lock e espera na fila além do limite. */
  private async gates(): Promise<void> {
    const probs: Problems = new Map();
    const limit = this.ctx.cint("HADES_NOTIFY_GATE_WAIT_MIN", 20);
    const queue = join(this.locks, "gate-queue");
    const journalText = readText(join(this.locks, "gate-journal.tsv")) ?? "";
    const overrunMin = this.ctx.cint("HADES_GATE_OVERRUN_MIN", 90);
    const overrunFactor = this.ctx.cint("HADES_GATE_OVERRUN_FACTOR", 5);
    for (const name of listDir(queue).filter((n) => n.endsWith(".t"))) {
      const kv = new Map<string, string>();
      for (const line of splitLines(readText(join(queue, name)) ?? "")) {
        const eq = line.indexOf("=");
        if (eq >= 0) kv.set(line.slice(0, eq), line.slice(eq + 1));
      }
      if (kv.get("state") === "waiting" && isoAgeMin(kv.get("since") ?? "") >= limit) {
        Watcher.add(probs, "gate", kv.get("label") ?? "gate", ["warn", `na fila há mais de ${limit} min`, "wait"]);
      }
      const overrun = runningOverrun(kv, journalText, Math.floor(Date.now() / 1000), overrunMin, overrunFactor);
      if (overrun !== undefined) Watcher.add(probs, "gate", `${kv.get("label") ?? "gate"} (longo)`, ["warn", overrun, "long"]);
    }
    await this.problems("gates", probs);
    const journal = join(this.locks, "gate-journal.tsv");
    let size: number;
    try {
      size = statSync(journal).size;
    } catch {
      return;
    }
    let offset = this.beat.gate_off;
    if (offset === undefined || offset > size) offset = size; // primeira passada: só o que acontecer daqui para a frente
    const chunk = Buffer.from(readText(journal) ?? "", "utf8").subarray(offset, size).toString("utf8");
    this.beat.gate_off = size;
    for (const line of splitLines(chunk)) {
      const p = line.split("\t");
      const m = p.length > 6 && p[1] === "done" ? /^rc=(\d+)$/.exec(p[6] as string) : null;
      if (m && m[1] !== "0" && GATE_TOOLS.has(p[2] as string)) {
        await notify(this.ctx, "gate", "error", `${p[2]} falhou (rc=${m[1]})`, { obj: `${p[3]} (falha)`, sig: p[0] });
      }
    }
  }

  /** Serviços <HU>-*: restart em loop / failed, e a saúde (/health/ready ou o caminho do plugin, panel.health). */
  private async services(): Promise<void> {
    const dir = this.ctx.dir;
    if (hadesPaused(dir)) return;
    const required = lines(readText(join(dir, "services.required")));
    const enabledText = readText(join(dir, "services.enabled"));
    const enabled = enabledText === undefined ? required : [...required, ...lines(enabledText)];
    const catalog = readText(join(dir, "services.tsv"));
    if (catalog === undefined) throw Object.assign(new Error("services.tsv ausente"), { name: "FileNotFoundError" });
    const ports = new Map<string, string>();
    for (const line of splitLines(catalog)) {
      const f = line.split("\t");
      if (f.length > 1 && !line.startsWith("#") && /^\d+$/.test(f[1] as string)) ports.set(f[0] as string, f[1] as string);
    }
    const names = [...new Set(enabled)].filter((s) => ports.has(s));
    const shown = serviceManager().inspect(names.map((s) => `${this.ctx.hu}-${s}`));
    const now = Date.now() / 1000;
    const restart: Problems = new Map();
    const health: Problems = new Map();
    const threshold = this.ctx.cint("HADES_NOTIFY_RESTARTS", 3);
    const paths = healthPaths(dir);
    for (const info of shown) {
      const service = info.unit.replace(`${this.ctx.hu}-`, "");
      const port = ports.get(service);
      if (port === undefined) continue;
      const nRestarts = info.restarts;
      const history = (this.restarts.get(service) ?? []).filter(([t]) => now - t <= RESTART_WINDOW_S);
      history.push([now, nRestarts]);
      this.restarts.set(service, history);
      const delta = nRestarts - Math.min(...history.map(([, n]) => n));
      if (info.activeState === "failed") Watcher.add(restart, "restart", service, ["error", "unit em failed", "failed"]);
      else if (delta >= threshold) Watcher.add(restart, "restart", service, ["error", `reiniciou ${delta}x em ${RESTART_WINDOW_S / 60} min`, `n${nRestarts}`]);
      if (info.activeState === "active") {
        const path = paths[service] ?? HEALTH_DEFAULT; // o plugin declara o de cada serviço
        const code = await httpCode(port, path);
        const fails = code === 200 ? 0 : (this.healthFails.get(service) ?? 0) + 1;
        this.healthFails.set(service, fails);
        if (fails >= HEALTH_FAILS_TO_ALERT) Watcher.add(health, "health", service, ["error", `${path} respondeu ${code || "nada"}`, "down"]);
      }
    }
    if (this.enabled("restart")) await this.problems("restart", restart);
    if (this.enabled("health")) await this.problems("health", health);
  }

  /** Minhas PRs: review novo e CI vermelho, do coletor do loop. */
  private async prs(): Promise<void> {
    const cli = selfCli("pr-loop-state", "--json");
    const r = run(cli.command, cli.args, { cwd: process.env.HADES_WT || undefined, timeoutMs: 150000 });
    if (r.status !== 0) throw new Error("coletor de PRs falhou");
    const parsed: unknown = JSON.parse(r.stdout);
    const listed = typeof parsed === "object" && parsed !== null && "prs" in parsed && Array.isArray(parsed.prs) ? parsed.prs : [];
    await this.notifyPrs(listed.flatMap((raw) => toSnapshot(raw) ?? []));
  }

  /** Avisa o CI vermelho e o review novo que ainda não foram avisados (identidade em notify-marks.ts, não a janela do dedupe).
   * Cada tipo tem o interruptor dele. Evento desligado ou lock ocupado não marca: ligar depois ainda avisa. */
  async notifyPrs(prs: readonly PrSnapshot[]): Promise<void> {
    const plan = planPrNotices(prs, loadMarks(this.ctx), { now: this.ctx.now() / 1000, remindHours: this.ctx.cint("HADES_NOTIFY_CI_REMIND_H", 0) });
    let marks = plan.marks;
    for (const event of plan.events) {
      const result = await notify(this.ctx, event.event, event.severity, event.text, { obj: event.obj, sig: event.sig, src: "prs" });
      if (result.sent || result.why === WHY_REPEATED) marks = ackMark(marks, event);
    }
    saveMarks(this.ctx, marks);
  }

  /** `doctor --json`: um aviso por item com erro. */
  private async doctor(): Promise<void> {
    const r = run("bash", [join(this.ctx.dir, "doctor.sh"), "--quick", "--json"], { timeoutMs: 60000 });
    const items = r.stdout.trim().startsWith("{") ? ((JSON.parse(r.stdout) as { items?: Array<{ group: string; id: string; level?: string }> }).items ?? []) : [];
    const probs: Problems = new Map();
    for (const item of items.filter((x) => x.level === "error")) {
      Watcher.add(probs, "doctor", `${item.group}/${item.id}`, ["error", "erro no diagnóstico (doctor.sh)", "err"]);
    }
    await this.problems("doctor", probs);
  }

  /** Agentes orquestrados: STALLED/QUESTION/DONE/BUDGET/CTX-OVER/MODEL-MISMATCH/DISMISS* do `hades watch` (estado próprio, para não roubar o do orquestrador). */
  private async agents(): Promise<void> {
    const state = join(this.ctx.state, "agents");
    const fresh = !existsSync(state);
    const grace = Date.now() / 1000 + (fresh ? AGENT_GRACE_S : 0); // primeira leitura: o que já existia não é novidade
    for (;;) {
      if (!this.enabled("agent")) {
        this.source("agents", "desligado");
        await sleep(AGENT_RETRY_MS);
        continue;
      }
      await this.agentsOnce(state, grace);
      await sleep(AGENT_RETRY_MS);
    }
  }

  private async agentsOnce(state: string, grace: number): Promise<void> {
    const cli = selfCli("watch", String(this.ctx.cint("HADES_NOTIFY_AGENTS_EVERY", 120)));
    const child = spawn(cli.command, cli.args, {
      cwd: process.env.HADES_WT || undefined,
      env: { ...process.env, HADES_WATCH_STATE: state },
      stdio: ["ignore", "pipe", "ignore"],
    });
    this.agentChild = child;
    const done = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.once("error", () => undefined); // bash ausente: o laço tenta de novo em 60 s, como o Popen do original
    for await (const line of createInterface({ input: child.stdout })) {
      this.source("agents", null);
      const w = line.split(/\s+/).filter(Boolean);
      const word = w[0];
      if (w.length < 2 || word === undefined || !isAgentWord(word) || Date.now() / 1000 <= grace) continue;
      const text: Record<AgentWord, string> = {
        STALLED: `parado há ${w[2] ?? "?"} min`,
        QUESTION: "pergunta aberta para o dono",
        DONE: "terminou (STATUS: DONE)",
        BUDGET: `passou do estimado: ${w[2] ?? "?"}% do p75 da Moirai`,
        "CTX-OVER": `contexto em ${w[2] ?? "?"}, acima do teto do papel (${w[3] ?? "?"}): estacionar`,
        "MODEL-MISMATCH": `rodando em ${w[2] ?? "?"}, não no modelo do papel (${w[3] ?? "?"})`,
        DISMISSED: "sessão fechada ao concluir",
        "DISMISS-READY": "pronto para fechar (fechamento automático desligado): hades agent done",
        "DISMISS-HELD": `não fechou ao concluir: ${w[2] ?? "?"}`,
      };
      await notify(this.ctx, "agent", INFO_WORDS.has(word) ? "info" : "warn", text[word], { obj: w[1], sig: `${word}|${line.trim()}` });
    }
    await done;
  }

  private source(name: string, err: string | null): void {
    (this.beat.sources ??= {})[name] = { ts: Math.trunc(Date.now() / 1000), err };
  }

  /** Encerra o filho do vigia de agentes (o Python deixava o processo órfão ao morrer). */
  stop(): void {
    this.agentChild?.kill();
  }

  async loop(): Promise<never> {
    const { ctx } = this;
    mkdirSync(ctx.state, { recursive: true });
    const sched: Source[] = [
      { name: "gates", events: ["gate"], key: "HADES_NOTIFY_EVERY", every: 30, fn: () => this.gates() },
      { name: "services", events: ["restart", "health"], key: "HADES_NOTIFY_EVERY", every: 30, fn: () => this.services() },
      { name: "prs", events: ["pr", "ci"], key: "HADES_NOTIFY_PRS_EVERY", every: 300, fn: () => this.prs() },
      { name: "doctor", events: ["doctor"], key: "HADES_NOTIFY_DOCTOR_EVERY", every: 1800, fn: () => this.doctor() },
    ];
    const last = new Map<string, number>();
    this.agents().catch((error: unknown) => this.source("agents", `${error instanceof Error ? error.name : "Error"}: ${scrub(error, 80)}`));
    for (;;) {
      const now = Date.now() / 1000;
      if (ctx.cfg("HADES_NOTIFY") === "1") {
        for (const s of sched) {
          if (now - (last.get(s.name) ?? 0) < ctx.cint(s.key, s.every) || !this.enabled(...s.events)) continue;
          last.set(s.name, now);
          try {
            await s.fn();
            this.source(s.name, null);
          } catch (error) {
            // uma fonte quebrada não derruba as outras
            this.source(s.name, `${error instanceof Error ? error.name : "Error"}: ${scrub(error, 80)}`);
          }
        }
      }
      this.beat.ts = Math.trunc(Date.now() / 1000);
      jsave(ctx.beat, this.beat);
      await sleep(TICK_MS);
    }
  }
}
