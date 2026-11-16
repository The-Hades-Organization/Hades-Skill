// `hades gate-lock`: fila de admissão de gates da Hades (kit/gate/gate-lock.sh). Uma fila FIFO por projeto em
// ~/.claude/hades/work/<owner__repo>/locks, admissão por memória, um gate pesado por vez, comando sob teto de memória.
// Saída 75 (EX_TEMPFAIL) = não admitido até o fim do timeout; o chamador cede o tick.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { constants, hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { effectiveConfig } from "../lib/config.ts";
import { need } from "../lib/deps.ts";
import { FlockTimeoutError, withFlockAsync } from "../lib/flock.ts";
import { firstLine, isDir, isFile, listDir, readText } from "../lib/fs.ts";
import {
  EX_TEMPFAIL, EX_USAGE, HEAVY_COST_GB, admissionBlock, field, inWindow, measuredCostGb, normalizeCommand, num, parseTicket, parseWindow, runningOverrun,
  peakOfLabel, specFor, type GateLimits, type MachineState, type QueueEntry,
} from "../lib/gate.ts";
import { HadesError, warn } from "../lib/output.ts";
import { emitJournal } from "../lib/journal.ts";
import { hadesHome, home, selfCli, skillRoot } from "../lib/paths.ts";
import { MIN_FREE_KILL_MB, OOM_EXIT, MemWatch, type KillReason } from "../lib/mem-watch.ts";
import { memAvailableMb, pidAlive, procStartTime, run as runSync, sameProcess, which } from "../lib/proc.ts";
import { installedStacks, pyRepr, stepOf } from "../lib/profile.ts";
import { OOM_SIGNAL_RCS, journalOomLines, oomKillsOf, rcAfterOom } from "../lib/oom-scope.ts";
import { slugOfRemote } from "../lib/work.ts";
import { probeWorker, runRemote, warmWorker } from "../lib/gate-remote/client.ts";
import { decide, shouldProbe, type Where } from "../lib/gate-remote/dispatch.ts";
import { WHERE_LOCAL, checkOut, parseWhere, planOf, probeAll, type RemotePlan } from "../lib/gate-remote/plan.ts";
import { ProtocolError, REASON_MEM, REASON_TOOL, parseWorkers, safeRelative, type WorkerSpec } from "../lib/gate-remote/protocol.ts";
import { missingTools } from "../lib/gate-remote/toolchain.ts";
import { badPassEnv } from "../lib/gate-remote/warm.ts";
import { sshCommand } from "../lib/gate-remote/transport.ts";

const DEFAULT_TIMEOUT_SECONDS = 3600;
const POLL_SECONDS = 5;
const NOTE_EVERY_SECONDS = 60;
const MUTEX_WAIT_SECONDS = 30;
const SAMPLE_MS = 200;
const CERBERUS_TEXT_MAX = 300;
const OOM_SIGNALS = OOM_SIGNAL_RCS;
const MACHINE_SLUG = "_maquina";
const MEM_WATCH_ENV = "HADES_MEM_WATCH";
const MEM_WATCH_FLOOR_ENV = "HADES_MEM_WATCH_FLOOR_MB";
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;
const DEFAULT_AUTO_AFTER_S = 120;
/** Intervalo entre consultas aos workers depois do transbordo: cada uma é uma ida ao ssh por worker. */
const PROBE_EVERY_S = 15;
const RESULT_FILE_ENV = "HADES_GATE_RESULT_FILE";
const REMOTE_STATE_PREFIX = "remote:";

/** Linhas 4–15 do script original, sem o `# ` (o uso do original imprime este trecho; mantido como está). */
const USAGE = `Fonte unica: ~/.claude/skills/hades/kit/gate/gate-lock.sh (o loop chama esta; o install copia para $D/gate/).

Politica v2 (proposta de 2026-09-22, ver ~/.claude/hades/docs/lock-policy/REPORT.md):
  - UMA fila FIFO global para todo kind; so a cabeca da fila e admitida (sem furar fila).
  - Admissao por memoria: soma dos custos (GB) dos gates rodando + custo do novo <= orcamento
    (HADES_GATE_BUDGET_GB, default 8) e MemAvailable >= custo + reserva (default 2 GB).
  - No maximo UM gate pesado (test, test:integration, gate) por vez na maquina.
  - O comando roda num scope systemd com MemoryMax: estourou, morre o gate, nao a maquina.

  gate-lock.sh run <kind> [--label L] [--timeout S] [--cost-gb N] [--step S:E] [--priority N] [--where local|<host>] [--out F|DIR]... [--fresh ARQ] [--post-local CMD] -- <cmd...>
  gate-lock.sh run --step <stack>:<etapa> [...] -- <cmd...>     kind e custo vem da etapa da stack (stacks/<n>/stack.json)
  gate-lock.sh status`;

class UsageError extends HadesError {
  constructor() {
    super("", EX_USAGE);
  }
}

function usage(): never {
  throw new UsageError();
}

/** O `${1:?msg}` do bash sai 1 (não 2) quando falta o valor de um argumento. */
function missingValue(message: string): never {
  throw new HadesError(message, 1);
}

function gateDie(message: string): never {
  throw new HadesError(message, EX_USAGE);
}

function note(message: string): void {
  warn(`gate-lock: ${message}`);
}

// --- configuração (Configurações → Fila): variável exportada > config.env > padrão do catálogo, como o config.sh ---

interface GateConfig {
  limits: GateLimits;
  headroomGb: number;
  swapcapGb: number;
  memcap: boolean;
  window: string;
  priority: number;
  costMeasured: boolean;
  overrunMin: number;
  overrunFactor: number;
  scope: string;
  /** HADES_GATE_WHERE: onde os itens rodam quando a linha de comando não diz (local | <host> | auto). */
  where: string;
  workers: WorkerSpec[];
  /** Segundos esperando a admissão local antes de o `auto` olhar os workers. */
  autoAfterS: number;
  /** Todas as chaves do catálogo: o config.sh as exporta, então o comando do gate as herda. */
  exported: Map<string, string>;
}

function configDir(env: NodeJS.ProcessEnv): string {
  const instance = env.D || firstLine(join(hadesHome(), "instance"));
  return instance && isFile(join(instance, "config.sh")) ? instance : join(skillRoot, "kit");
}

function integer(config: ReadonlyMap<string, string>, key: string, fallback: number): number {
  const raw = config.get(key);
  if (raw === undefined || raw === "") return fallback;
  if (!/^-?[0-9]+$/.test(raw)) gateDie(`${key} exige inteiro: '${raw}'`);
  return Number(raw);
}

function workersOf(raw: string): WorkerSpec[] {
  try {
    return parseWorkers(raw);
  } catch (error) {
    if (error instanceof ProtocolError) gateDie(error.message);
    throw error;
  }
}

function loadConfig(env: NodeJS.ProcessEnv): GateConfig {
  const exported = effectiveConfig(configDir(env), env);
  const value = new Map<string, string>(exported);
  for (const key of exported.keys()) if (env[key] !== undefined) value.set(key, env[key] as string);
  const window = value.get("HADES_GATE_WINDOW") ?? env.HADES_GATE_WINDOW ?? "";
  if (window !== "" && parseWindow(window) === undefined) gateDie(`HADES_GATE_WINDOW invalida: '${window}' (use HH:MM-HH:MM)`);
  return {
    limits: {
      budgetGb: integer(value, "HADES_GATE_BUDGET_GB", 8),
      heavyMax: integer(value, "HADES_GATE_HEAVY_MAX", 1),
      parLint: integer(value, "HADES_GATE_PAR_LINT", 0),
      parBuild: integer(value, "HADES_GATE_PAR_BUILD", 0),
      projectBudgetGb: integer(value, "HADES_GATE_PROJECT_BUDGET_GB", 0),
      reserveGb: integer(value, "HADES_GATE_RESERVE_GB", 2),
      psiMax: integer(value, "HADES_GATE_PSI_MAX", 10),
    },
    headroomGb: integer(value, "HADES_GATE_HEADROOM_GB", 3),
    swapcapGb: integer(value, "HADES_GATE_SWAPCAP_GB", 1),
    memcap: (value.get("HADES_GATE_MEMCAP") ?? "1") === "1",
    window,
    priority: integer(value, "HADES_GATE_PRIORITY", 0),
    costMeasured: (value.get("HADES_GATE_COST_MEASURED") ?? "0") === "1",
    scope: value.get("HADES_GATE_SCOPE") || "projeto",
    where: value.get("HADES_GATE_WHERE") || WHERE_LOCAL,
    workers: workersOf(value.get("HADES_GATE_WORKERS") ?? ""),
    autoAfterS: integer(value, "HADES_GATE_AUTO_AFTER_S", DEFAULT_AUTO_AFTER_S),
    overrunMin: integer(value, "HADES_GATE_OVERRUN_MIN", 90),
    overrunFactor: integer(value, "HADES_GATE_OVERRUN_FACTOR", 5),
    exported,
  };
}

// --- estado: onde a fila mora ---

function workRoot(env: NodeJS.ProcessEnv): string {
  return env.HADES_WORK_ROOT || firstLine(join(hadesHome(), "work-root")) || join(hadesHome(), "work");
}

/** owner__repo do origin; sem origin (ou fora de git) a fila é da máquina: `_maquina`. */
function projectSlug(): string {
  need("git");
  const url = runSync("git", ["config", "--get", "remote.origin.url"]);
  const remote = url.status === 0 ? url.stdout.trim() : "";
  if (remote === "") return MACHINE_SLUG;
  const slug = slugOfRemote(remote);
  if (!slug.includes("__")) gateDie(`nao consegui derivar owner__repo de '${remote}'`);
  return slug;
}

function resolveLocksDir(env: NodeJS.ProcessEnv, scope: string): string {
  if (env.HADES_WORK) return join(env.HADES_WORK, "locks");
  // HADES_GATE_SCOPE=maquina: uma fila só para todos os projetos (o orçamento por projeto passa a valer)
  const slug = scope === "maquina" ? MACHINE_SLUG : projectSlug();
  return join(workRoot(env), slug, "locks");
}

// --- leitura da máquina ---

/** O wrapper vivo, e não um pid reciclado: pid existe e o starttime confere (quando gravado e legível). */
const alive = sameProcess;

function psiSomeAvg10(): number {
  const m = /^some avg10=([0-9.]+)/m.exec(readText("/proc/pressure/memory") ?? "");
  return m ? Math.floor(Number(m[1])) : 0;
}

function nowMinutes(): number {
  const now = new Date();
  // Janela de horário do dono (Configurações): vale no relógio local dele, não em UTC.
  return now.getHours() * 60 + now.getMinutes();
}

function utcStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Nanossegundos desde a época, monotônicos: o prefixo do ticket ordena a chegada como o `date +%s%N` do original.
const EPOCH_NS = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();
function arrivalNs(): string {
  return String(EPOCH_NS + process.hrtime.bigint());
}

// --- a fila em disco ---

class Queue {
  readonly dir: string;
  private readonly locks: string;
  private readonly mutex: string;
  private readonly journalFile: string;
  private readonly host = hostname();

  constructor(locks: string) {
    this.locks = locks;
    this.dir = join(locks, "gate-queue");
    this.mutex = join(locks, "gate-queue.mutex");
    this.journalFile = join(locks, "gate-journal.tsv");
  }

  journal(...parts: string[]): void {
    try {
      appendFileSync(this.journalFile, `${utcStamp()}\t${parts.join("\t")}\n`);
    } catch {
      // O histórico é informativo: falhar em gravá-lo nunca derruba nem trava o gate (como o `|| true` do original).
    }
  }

  readJournal(): string {
    return readText(this.journalFile) ?? "";
  }

  entries(): QueueEntry[] {
    return listDir(this.dir)
      .filter((name) => name.endsWith(".t"))
      .flatMap((name) => {
        const path = join(this.dir, name);
        const text = readText(path);
        return text === undefined ? [] : [{ path, ticket: parseTicket(text) }];
      });
  }

  /** Seção crítica: tudo que lê ou escreve a fila passa pelo flock(2) do arquivo do mutex (o mesmo lock do `flock(1)` original). */
  async locked<T>(body: () => T): Promise<T> {
    try {
      return await withFlockAsync(this.mutex, async () => body(), MUTEX_WAIT_SECONDS);
    } catch (error) {
      if (error instanceof FlockTimeoutError) throw new HadesError(error.message, EX_USAGE);
      throw error;
    }
  }

  writeTicket(path: string, lines: readonly string[]): void {
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, `${lines.join("\n")}\n`);
    renameSync(tmp, path);
  }

  setState(path: string, state: string): void {
    const lines = (readText(path) ?? "").split("\n").map((l) => (l.startsWith("state=") ? `state=${state}` : l));
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, `${lines.join("\n")}started=${Math.floor(Date.now() / 1000)}\n`);
    renameSync(tmp, path);
  }

  /** O item saiu da fila local: roda no worker `host`, fora do orçamento daqui (`state=remote:<host>`). */
  markRemote(path: string, host: string): void {
    this.setState(path, `${REMOTE_STATE_PREFIX}${host}`);
    appendFileSync(path, `where=remote\nremote=${host}\n`);
  }

  /** Ticket é órfão quando o wrapper E o comando que ele lançou morreram (mesmo host, pid ausente ou reciclado). */
  prune(): void {
    for (const { path, ticket } of this.entries()) {
      if (field(ticket, "host") !== this.host) continue;
      if (alive(field(ticket, "pid"), field(ticket, "pstart"))) continue;
      // Item remoto: o `child` é o ssh local, que não prova o job (ele morre com o wrapper e o worker derruba o job);
      // só o wrapper vale. O host do ticket é o da máquina que o enfileirou, e é ele que é conferido antes do pid.
      if (!isRemoteTicket(ticket) && alive(field(ticket, "child"), field(ticket, "childstart"))) continue;
      note(`ticket ${path.slice(path.lastIndexOf("/") + 1)} orfao (kind=${field(ticket, "kind")} label=${field(ticket, "label")}, pid ${field(ticket, "pid")} morto) — removendo`);
      this.journal("orphan", field(ticket, "kind"), field(ticket, "label"), field(ticket, "clone"));
      rmSync(path, { force: true });
    }
  }

  /** Transição: slots do protocolo v1 de wrappers antigos ainda rodando contam como ocupação. */
  legacyUsage(): { usedGb: number; heavy: number } {
    let usedGb = 0;
    let heavy = 0;
    for (const name of this.legacySlots()) {
      const slot = join(this.locks, name);
      const owner = parseTicket(readText(join(slot, "owner")) ?? "");
      const pid = field(owner, "pid");
      if (field(owner, "runner") === "wrapper" && field(owner, "host") === this.host && pid !== "" && !pidAlive(Number(pid))) {
        note(`slot v1 ${name} orfao (pid ${pid} morto) — reciclando`);
        rmSync(slot, { recursive: true, force: true });
        continue;
      }
      const spec = specFor(field(owner, "kind") || "test") ?? { cost: 4, heavy: true };
      usedGb += spec.cost;
      heavy += spec.heavy ? 1 : 0;
    }
    return { usedGb, heavy };
  }

  legacySlots(): string[] {
    return listDir(this.locks).filter((name) => /^gate-.*\.slot-/.test(name) && isDir(join(this.locks, name)));
  }
}

// --- execução do comando ---

function isRemoteTicket(ticket: ReturnType<typeof parseTicket>): boolean {
  return field(ticket, "state").startsWith(REMOTE_STATE_PREFIX);
}

function signalExit(signal: NodeJS.Signals | null, code: number | null): number {
  if (signal !== null) return 128 + (constants.signals[signal] ?? 0);
  return code ?? 1;
}

function exitOf(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      note(`${error.code === "ENOENT" ? "comando nao encontrado" : error.message}`);
      resolve(error.code === "ENOENT" ? 127 : 126);
    });
    child.once("close", (code, signal) => resolve(signalExit(signal, code)));
  });
}

function runInherit(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command = "", ...args] = argv;
  return exitOf(spawn(command, args, { stdio: "inherit", env }));
}

/** O teto de memória só vale com `systemd-run --user --scope` funcionando; sem ele o comando roda sem teto, com aviso. */
function canCapMemory(memcap: boolean): boolean {
  if (!memcap || which("systemd-run") === undefined) return false;
  return runSync("systemd-run", ["--user", "--scope", "--quiet", "--", "true"]).status === 0;
}

/** Amostra o pico do cgroup do scope (memory.peak) enquanto o comando vive; devolve o parar() com o pico em MB. */
function samplePeak(unit: string): () => { peakMb: number | undefined; oomKills: number } {
  let cgroup = "";
  let peakBytes: number | undefined;
  let oomKills = 0;
  const timer = setInterval(() => {
    if (cgroup === "") cgroup = runSync("systemctl", ["--user", "show", "-p", "ControlGroup", "--value", `${unit}.scope`]).stdout.trim();
    if (cgroup === "") return;
    const value = readText(`/sys/fs/cgroup${cgroup}/memory.peak`)?.trim() ?? "";
    if (/^[0-9]+$/.test(value)) peakBytes = Number(value);
    oomKills = Math.max(oomKills, oomKillsOf(readText(`/sys/fs/cgroup${cgroup}/memory.events`)));
  }, SAMPLE_MS);
  return () => {
    clearInterval(timer);
    return { peakMb: peakBytes === undefined ? undefined : Math.floor((peakBytes + 1_048_575) / 1_048_576), oomKills };
  };
}

type Admission = { target: "local"; waited: number } | { target: "remote"; host: string; waited: number };

interface RunOptions {
  kind: string;
  label: string;
  timeout: string;
  cost: string;
  step: string;
  priority: string;
  /** `--where`: vazio = o que a configuração diz. */
  where: string;
  /** `--out`, repetível: arquivos ou diretórios que o worker devolve (caminho dentro de $HOME). */
  out: string[];
  /** `--fresh`: arquivo (relativo a cada diretório de `--out`) que o build remoto tem de ter regravado. */
  fresh: string;
  /** `--post-local`: comando que roda aqui, depois da promoção do que voltou, só com sucesso. */
  postLocal: string;
}

class Gate {
  private readonly config: GateConfig;
  private readonly queue: Queue;
  private readonly env: NodeJS.ProcessEnv;
  private ticket = "";
  /** scope do último comando com teto: a evidência de oom-kill vem dele */
  private scope: { unit: string; oomKills: number } | undefined;
  private child: ChildProcess | undefined;
  /** O vigia de memória derrubou a árvore do comando (macOS): a mensagem dele já explica a saída 137. */
  private watchKilled = false;
  /** O filho do vigia mora em grupo próprio e o sinal do terminal não chega a ele: a parada o derruba pelo grupo. */
  private childGrouped = false;
  private where: Where = { mode: "local" };
  /** Plano remoto da etapa, calculado na primeira vez que o despacho precisa dele. */
  private plan: RemotePlan | undefined;
  /** Aquecimentos disparados em segundo plano (um por worker): o fim do gate espera por eles em vez de largá-los. */
  private readonly warming = new Map<string, Promise<void>>();

  constructor(config: GateConfig, queue: Queue, env: NodeJS.ProcessEnv) {
    this.config = config;
    this.queue = queue;
    this.env = env;
  }

  /** Diário do agente (reference/journal.md): o label do gate é o nome do agente. O diário nunca muda a saída do gate. */
  private journalGate(op: string, kind: string, label: string, clone: string, detail: string): void {
    emitJournal("gate", `gate.${op}`, `${kind} ${label}${detail ? ` ${detail}` : ""}`, { agent: label, cwd: clone, get: (key) => this.config.exported.get(key) });
  }

  private machineState(): MachineState {
    const legacy = this.queue.legacyUsage();
    return {
      legacyUsedGb: legacy.usedGb, legacyHeavy: legacy.heavy, window: this.config.window,
      inWindow: inWindow(this.config.window, nowMinutes()), availMb: memAvailableMb(), psi: psiSomeAvg10(),
    };
  }

  /** Decide se o ticket entra agora; se entra, já o marca `running`. Devolve o motivo de não entrar. */
  private tryAdmit(cost: number, heavy: boolean): string | null {
    this.queue.prune();
    const queue = this.queue.entries();
    const mine = queue.find((e) => e.path === this.ticket);
    if (!mine) throw new HadesError(`ticket ${this.ticket} sumiu da fila`, EX_USAGE);
    const reason = admissionBlock(queue, mine, cost, heavy, this.config.limits, this.machineState());
    if (reason === null) this.queue.setState(this.ticket, "running");
    return reason;
  }

  private describeRunning(): void {
    for (const { path, ticket } of this.queue.entries()) {
      warn(`  ${path.slice(path.lastIndexOf("/") + 1)}: state=${field(ticket, "state")} kind=${field(ticket, "kind")} cost=${field(ticket, "cost")}GB label=${field(ticket, "label")} clone=${field(ticket, "clone")} since=${field(ticket, "since")}`);
    }
  }

  /** Cerberus (reference/cerberus.md): o aviso vai ao histórico; o registro nunca muda a saída 75. */
  private registerCerberus(kind: string, label: string, waited: number, reason: string): void {
    const cli = selfCli("cerberus", "registrar");
    runSync(cli.command, [
      ...cli.args, "--cabeca", "vigilia", "--guarda", "gate-lock-admissao", "--momento", "continuo", "--resultado", "aviso",
      "--ctx", `label=${label.slice(0, CERBERUS_TEXT_MAX)}`,
      "--evidencia", `gate ${kind} não admitido em ${waited}s (${reason}): enfileirado não é verde|fila do gate-lock`,
    ]);
  }

  private async resolveStep(options: RunOptions): Promise<{ kind: string; cost: string; stepParallel: number }> {
    const step = stepOf(options.step);
    if (!step) {
      // O original chamava `hades project step`, que avisa antes de a fila recusar a etapa.
      warn(`hades: etapa ${pyRepr(options.step)} não existe nas stacks instaladas`);
      gateDie(`etapa desconhecida: '${options.step}' (<stack>:<etapa>, stacks instaladas)`);
    }
    let cost = options.cost;
    if (cost === "") {
      cost = String(step.costGb);
      if (this.config.costMeasured) {
        const measured = measuredCostGb(this.queue.readJournal(), options.step);
        if (measured !== undefined) cost = String(measured);
      }
    }
    return { kind: options.kind || String(step.kind), cost, stepParallel: Number(step.parallel) };
  }

  async run(options: RunOptions, command: readonly string[]): Promise<number> {
    let { kind, cost } = options;
    let stepParallel = 0;
    if (options.step !== "") {
      const resolved = await this.resolveStep(options);
      ({ kind, cost, stepParallel } = resolved);
    }
    if (kind === "") usage();
    const spec = specFor(kind);
    if (!spec) gateDie(`kind invalido: '${kind}' (use lint | build | test | test:integration | gate)`);
    if (cost === "") cost = String(spec.cost);
    if (!/^-?[0-9]+$/.test(options.priority)) gateDie(`--priority exige inteiro: ${options.priority}`);
    if (!/^[0-9]+$/.test(cost)) gateDie(`--cost-gb exige inteiro em GB: ${cost}`);
    if (!/^[0-9]+$/.test(options.timeout)) gateDie(`--timeout exige inteiro em segundos: ${options.timeout}`);
    const costGb = Number(cost);
    const heavy = spec.heavy || costGb >= HEAVY_COST_GB;

    const parent = this.liveParentTicket();
    if (parent !== undefined) {
      if (costGb > num(parent, "cost")) note(`passo ${kind}/${options.label} custa ${costGb} GB, mais que a concessao (${num(parent, "cost")} GB)`);
      return runInherit(command, this.env);
    }
    this.where = this.resolveWhere(options);
    if (this.where.mode === "host" && options.step === "") {
      note(`--where ${this.where.host} sem --step: o job vai sem stack (sem aquecimento nem npm ci no worker); passe --step <stack>:<etapa>`);
    }
    return this.admitAndRun(options, kind, costGb, heavy, stepParallel, command);
  }

  private resolveWhere(options: RunOptions): Where {
    try {
      const where = parseWhere(options.where !== "" ? options.where : this.config.where, options.where !== "");
      if (where.mode !== "local") checkOut(options.out, home(), process.cwd());
      else if (options.out.length > 0 || options.fresh !== "" || options.postLocal !== "") note("--out, --fresh e --post-local só valem fora da máquina (--where <host>): ignorados");
      if (options.fresh !== "" && !safeRelative(options.fresh)) gateDie("--fresh exige caminho relativo, sem ..");
      if (options.fresh !== "" && options.out.length === 0) gateDie("--fresh precisa de --out <dir>");
      if (where.mode === "auto" && this.config.workers.length === 0) note("HADES_GATE_WORKERS vazio: o auto roda tudo local");
      return where;
    } catch (error) {
      if (error instanceof ProtocolError) gateDie(error.message);
      throw error;
    }
  }

  /** Dentro de uma concessão `gate` viva o passo roda direto: a sequência já foi admitida inteira. */
  private liveParentTicket(): ReturnType<typeof parseTicket> | undefined {
    const path = this.env.GATE_LOCK_TICKET;
    if (!path || !isFile(path)) return undefined;
    const ticket = parseTicket(readText(path) ?? "");
    return field(ticket, "state") === "running" && alive(field(ticket, "pid"), field(ticket, "pstart")) ? ticket : undefined;
  }

  private async admitAndRun(options: RunOptions, kind: string, cost: number, heavy: boolean, stepParallel: number, command: readonly string[]): Promise<number> {
    mkdirSync(this.queue.dir, { recursive: true });
    const clone = runSync("git", ["rev-parse", "--show-toplevel"]).stdout.trim() || process.cwd();
    this.ticket = join(this.queue.dir, `${arrivalNs()}-${process.pid}.t`);
    process.on("exit", () => {
      rmSync(this.ticket, { force: true });
      rmSync(`${this.ticket}.peak`, { force: true });
    });
    const onSignal = (signal: keyof typeof SIGNAL_EXIT): void => {
      this.stopChild();
      process.exit(SIGNAL_EXIT[signal]);
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));

    const project = projectSlug();
    await this.queue.locked(() => {
      this.queue.writeTicket(this.ticket, [
        `kind=${kind}`, `label=${options.label}`, `cost=${cost}`, `heavy=${heavy ? 1 : 0}`, `clone=${clone}`,
        `pid=${process.pid}`, `pstart=${procStartTime(process.pid) ?? ""}`, `host=${hostname()}`, `since=${utcStamp()}`, `project=${project}`,
        `prio=${options.priority}`, `step=${options.step}`, `steppar=${stepParallel}`, "state=waiting",
      ]);
    });
    this.queue.journal("enqueue", kind, options.label, String(cost), clone);
    this.journalGate("enqueue", kind, options.label, clone, `cost=${cost}GB`);

    try {
      const admission = this.where.mode === "host" ? ({ target: "remote", host: this.where.host, waited: 0 } as const) : await this.waitForAdmission(options, kind, cost, heavy, clone);
      if (admission === undefined) return EX_TEMPFAIL;
      if (admission.target === "remote") return await this.runOnWorker(options, kind, cost, clone, admission.host, admission.waited, command);
      this.queue.journal("admit", kind, options.label, String(cost), clone, `waited=${admission.waited}`, `avail=${memAvailableMb()}MB`);
      this.journalGate("admit", kind, options.label, clone, `waited=${admission.waited}s`);
      return await this.runAdmitted(options, kind, cost, clone, command);
    } finally {
      await Promise.allSettled(this.warming.values());
    }
  }

  /** O item vai para o worker: sai do orçamento local (`state=remote:<host>`), roda lá e volta com o rc e o pico de lá. */
  private async runOnWorker(options: RunOptions, kind: string, cost: number, clone: string, host: string, waited: number, command: readonly string[]): Promise<number> {
    await this.queue.locked(() => this.queue.markRemote(this.ticket, host));
    this.queue.journal("admit", kind, options.label, String(cost), clone, `waited=${waited}`, `host=${host}`);
    this.journalGate("admit", kind, options.label, clone, `waited=${waited}s host=${host}`);
    const started = Date.now();
    const explicit = this.where.mode === "host";
    const ssh = sshCommand(this.env);
    const plan = this.remotePlan(clone, options.step);
    const refusal = await this.refuseWorker(host, plan, ssh);
    if (refusal !== undefined) {
      note(`rc 75: ${refusal} (${host})`);
      return this.finish(options, kind, cost, clone, command, 0, started, EX_TEMPFAIL, undefined, { host, reason: refusal });
    }
    const result = await runRemote(
      {
        host, home: home(), repo: projectSlug(), clone, subdir: relative(clone, process.cwd()), kind, label: options.label, cost,
        timeout: Number(options.timeout), priority: Number(options.priority), step: options.step, stack: plan.stack,
        argv: command, out: checkOut(options.out, home(), process.cwd()), warmInline: explicit, fresh: options.fresh, env: this.passEnv(plan), headroom: this.config.headroomGb,
        postLocal: options.postLocal,
      },
      ssh,
      (child) => {
        this.child = child;
        appendFileSync(this.ticket, `child=${child.pid ?? ""}\nchildstart=${child.pid === undefined ? "" : (procStartTime(child.pid) ?? "")}\n`);
      },
      note,
    );
    return this.finish(options, kind, cost, clone, command, 0, started, result.rc, result.peakMb, { host: result.host ?? host, reason: result.reason }, result.sha === "" ? undefined : { sha: result.sha, snapshot: result.snapshot });
  }

  /**
   * `--where <host>` não passa pelo `eligible` do auto: aqui a memória livre mínima da etapa (`remote.minMemGb`) e as ferramentas
   * da stack (`remote.requires`, do `tools` do status) são conferidas antes de enviar o código. Worker que não responde segue: o envio falha com rc 75 e o motivo certo.
   */
  private async refuseWorker(host: string, plan: RemotePlan, ssh: ReturnType<typeof sshCommand>): Promise<string | undefined> {
    if (plan.affinity.minMemGb <= 0 && plan.affinity.requires.length === 0) return undefined;
    const status = await probeWorker(ssh, host);
    if (status === undefined) return undefined;
    const missing = missingTools(status.tools, plan.affinity.requires);
    if (missing.length > 0) return `${REASON_TOOL}: falta ${missing.join(", ")}; veja reference/gate-remoto-worker.md §Toolchain`;
    if (status.memFreeGb >= plan.affinity.minMemGb) return undefined;
    return `${REASON_MEM}: ${status.memFreeGb} GB livres, a etapa pede ${plan.affinity.minMemGb} GB`;
  }

  /** Entradas de build declaradas na stack (`remote.passEnv`): o valor vem do ambiente de quem chamou; sem segredo. */
  private passEnv(plan: RemotePlan): Record<string, string> {
    const bad = badPassEnv(plan.passEnv);
    if (bad !== undefined) gateDie(`remote.passEnv da stack traz ${bad}: nome inválido ou de segredo não atravessa`);
    const env: Record<string, string> = {};
    for (const name of plan.passEnv) {
      const value = this.env[name];
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  private remotePlan(clone: string, step: string): RemotePlan {
    this.plan ??= planOf(step, clone, installedStacks());
    return this.plan;
  }

  /**
   * `auto`: depois do transbordo, olha os workers a cada PROBE_EVERY_S. Devolve o host quando um aquecido serve; um frio
   * nunca recebe o item (ele segue na fila local) e ganha o aquecimento em segundo plano.
   */
  private async autoDispatch(waitedS: number, kind: string, options: RunOptions, clone: string): Promise<string | undefined> {
    if (this.where.mode !== "auto" || this.config.workers.length === 0) return undefined;
    // waitedS anda de POLL_SECONDS em POLL_SECONDS: o início da sondagem é alinhado a esse passo para a cadência bater
    const start = Math.ceil(this.config.autoAfterS / POLL_SECONDS) * POLL_SECONDS;
    if (!shouldProbe(waitedS, start, PROBE_EVERY_S)) return undefined;
    const ssh = sshCommand(this.env);
    const plan = this.remotePlan(clone, options.step);
    const decision = decide({
      where: this.where, waitedS, autoAfterS: this.config.autoAfterS, kind, affinity: plan.affinity, warmKey: plan.warmKey,
      workers: await probeAll(ssh, this.config.workers),
    });
    for (const host of decision.warm) {
      if (this.warming.has(host)) continue;
      note(`aquecendo ${host} para este item (segue local enquanto isso)`);
      this.warming.set(host, warmWorker(ssh, host, { home: home(), repo: projectSlug(), clone, stack: plan.stack }, note));
    }
    return decision.target === "remote" ? decision.host : undefined;
  }

  /** Espera a vez; devolve onde o item vai rodar (com os segundos esperados), ou undefined ao esgotar o timeout (saída 75). */
  private async waitForAdmission(options: RunOptions, kind: string, cost: number, heavy: boolean, clone: string): Promise<Admission | undefined> {
    let waited = 0;
    let last = "";
    for (;;) {
      const reason = await this.queue.locked(() => this.tryAdmit(cost, heavy));
      if (reason === null) return { target: "local", waited };
      const host = await this.autoDispatch(waited, kind, options, clone);
      if (host !== undefined) return { target: "remote", host, waited };
      if (waited >= Number(options.timeout)) {
        note(`nao admitido apos ${waited}s (${reason}) — gate enfileirado, ceda o tick`);
        this.describeRunning();
        this.queue.journal("timeout", kind, options.label, String(cost), clone, `waited=${waited}`, reason);
        this.journalGate("timeout", kind, options.label, clone, `waited=${waited}s (${reason})`);
        this.registerCerberus(kind, options.label, waited, reason);
        return undefined;
      }
      if (reason !== last || waited % NOTE_EVERY_SECONDS === 0) {
        note(`aguardando: ${reason} (${waited}s/${Number(options.timeout)}s)`);
        last = reason;
      }
      await Bun.sleep(POLL_SECONDS * 1000);
      waited += POLL_SECONDS;
    }
  }

  private async runAdmitted(options: RunOptions, kind: string, cost: number, clone: string, command: readonly string[]): Promise<number> {
    const cap = cost + this.config.headroomGb;
    const env: NodeJS.ProcessEnv = { ...this.env, GATE_LOCK_TICKET: this.ticket, JEST_WORKERS: this.env.JEST_WORKERS || "4", NX_PARALLEL: this.env.NX_PARALLEL || "2" };
    const started = Date.now();
    if (this.watchesMemory()) return this.runWatched(options, kind, cost, clone, command, cap, env, started);
    const unit = `hades-gate-${process.pid}-${arrivalNs()}`;
    const capped = canCapMemory(this.config.memcap);
    if (!capped) note("sem systemd-run --user --scope: rodando sem teto de memoria");
    const argv = capped
      ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "-p", `MemoryMax=${cap}G`, "-p", `MemorySwapMax=${this.config.swapcapGb}G`, "--", ...command]
      : [...command];
    const [file = "", ...args] = argv;
    const stopSampling = capped ? samplePeak(unit) : () => ({ peakMb: undefined, oomKills: 0 });
    const child = spawn(file, args, { stdio: "inherit", env });
    this.child = child;
    const running = exitOf(child);
    appendFileSync(this.ticket, `child=${child.pid ?? ""}\nchildstart=${child.pid === undefined ? "" : (procStartTime(child.pid) ?? "")}\n`);
    const rc = await running;
    const sampled = stopSampling();
    this.scope = { unit, oomKills: sampled.oomKills };
    return this.finish(options, kind, cost, clone, command, cap, started, rc, sampled.peakMb);
  }

  /** Sem cgroup (macOS): o teto é o vigia de RSS da árvore (ADR 0003). HADES_MEM_WATCH=1 liga o mesmo caminho no Linux (testes). */
  private watchesMemory(): boolean {
    // HADES_GATE_MEMCAP não está no catálogo (config.memcap fica em 1): a variável do ambiente é quem desliga o teto
    if (!this.config.memcap || this.env.HADES_GATE_MEMCAP === "0") return false;
    return process.platform === "darwin" || this.env[MEM_WATCH_ENV] === "1";
  }

  private stopChild(): void {
    const pid = this.child?.pid;
    if (pid === undefined) return;
    try {
      process.kill(this.childGrouped ? -pid : pid, "SIGTERM");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  }

  private async runWatched(
    options: RunOptions, kind: string, cost: number, clone: string, command: readonly string[], cap: number, env: NodeJS.ProcessEnv, started: number,
  ): Promise<number> {
    const [file = "", ...args] = command;
    // grupo próprio: o vigia mata o grupo inteiro; o Ctrl-C do terminal não chega ao filho, então o onSignal da fila o repassa
    const child = spawn(file, args, { stdio: "inherit", env, detached: true });
    this.child = child;
    this.childGrouped = true;
    const running = exitOf(child);
    appendFileSync(this.ticket, `child=${child.pid ?? ""}\nchildstart=${child.pid === undefined ? "" : (procStartTime(child.pid) ?? "")}\n`);
    const watch = child.pid === undefined ? undefined : new MemWatch({ rootPid: child.pid, capMb: cap * 1024, floorMb: floorMb(this.env) });
    watch?.start();
    const exited = await running;
    const peak = watch?.stop();
    const reason = watch?.killedFor;
    this.watchKilled = reason !== undefined;
    if (reason !== undefined) note(oomText(reason, cap));
    return this.finish(options, kind, cost, clone, command, cap, started, reason === undefined ? exited : OOM_EXIT, peak === undefined || peak === 0 ? undefined : peak);
  }

  private finish(
    options: RunOptions, kind: string, cost: number, clone: string, command: readonly string[], cap: number, started: number, rc: number, peak: number | undefined,
    remote?: { host: string; reason: string | undefined },
    dispatched?: { sha: string; snapshot: string },
  ): number {
    if (peak !== undefined) writeFileSync(`${this.ticket}.peak`, `${peak}\n`);
    const resultFile = this.env[RESULT_FILE_ENV];
    // O worker lê o pico daqui: é como o `gate-lock` dele devolve ao `hades worker exec` o que mediu (ver worker.ts).
    // `sha=` é o HEAD do worktree no envio (marcador de "construído" do chamador); `snapshot=` o commit que viajou.
    if (resultFile) {
      const lines = [...(peak !== undefined ? [`peak=${peak}`] : []), ...(dispatched === undefined ? [] : [`sha=${dispatched.sha}`, `snapshot=${dispatched.snapshot}`])];
      if (lines.length > 0) writeFileSync(resultFile, `${lines.join("\n")}\n`);
    }
    const seconds = Math.floor((Date.now() - started) / 1000);
    // No remoto quem viu o estouro foi o worker (a mensagem dele já veio no stderr); o teto local não é o que valeu.
    let code = rc;
    if (remote === undefined && rc !== 0 && !this.watchKilled) {
      const oomed = this.scopeOomed(seconds);
      if (OOM_SIGNALS.includes(rc) || oomed) this.explainOom(rc, cap, seconds);
      code = rcAfterOom(rc, oomed);
    }
    const extra = [
      ...(options.step !== "" ? [`step=${options.step}`] : []),
      ...(peak !== undefined ? [`peak=${peak}MB`] : []),
      ...(remote === undefined ? [] : [`host=${remote.host}`, ...(remote.reason === undefined ? [] : [`reason=${remote.reason}`])]),
      ...(dispatched === undefined ? [] : [`sha=${dispatched.sha.slice(0, 12)}`]),
    ];
    this.queue.journal("done", kind, options.label, String(cost), clone, `rc=${code}`, `dur=${seconds}s`, `cmd=${normalizeCommand(command)}`, ...extra);
    this.journalGate("done", kind, options.label, clone, `rc=${code} dur=${seconds}s cmd=${normalizeCommand(command)}${remote === undefined ? "" : ` host=${remote.host}`}`);
    return code;
  }

  /** oom-kill comprovado no scope deste comando: contador do cgroup ou, se o scope sumiu antes da última leitura, o journal. */
  private scopeOomed(seconds: number): boolean {
    if (this.scope === undefined) return false;
    if (this.scope.oomKills > 0) return true;
    if (process.platform === "darwin" || which("journalctl") === undefined) return false;
    const log = runSync("journalctl", ["--user", "-b", "--no-pager", "--since", `-${seconds + 5}s`]).stdout;
    return journalOomLines(log, this.scope.unit).length > 0;
  }

  /** 137 (SIGKILL no comando) e 143 (systemd derrubando o scope após oom-kill de um irmão) significam o mesmo: não coube no teto. */
  private explainOom(rc: number, cap: number, seconds: number): void {
    note(`comando morto por sinal (${rc}): 137=SIGKILL no comando, 143=SIGTERM do systemd derrubando o scope apos oom-kill de um irmao. Teto era ${cap} GB — provavel estouro de memoria, NAO e gate reprovado.`);
    if (process.platform !== "darwin" && which("journalctl") !== undefined) {
      const log = runSync("journalctl", ["--user", "-b", "--no-pager", "--since", `-${seconds + 5}s`]).stdout;
      const evidence = log.split("\n").filter((l) => /oom-kill|memory peak/.test(l)).slice(-2);
      if (evidence.length > 0) note(`journal: ${evidence.join("|")}|`);
    }
    if (process.platform !== "darwin") note('confirme com: journalctl --user -b | grep -E "oom-kill|Failed with result" | tail');
  }
}

/** Piso de memória livre do vigia; HADES_MEM_WATCH_FLOOR_MB o troca (os testes), valor que não é inteiro ≥ 0 vale o padrão. */
function floorMb(env: NodeJS.ProcessEnv): number {
  const raw = env[MEM_WATCH_FLOOR_ENV] ?? "";
  return /^[0-9]+$/.test(raw) ? Number(raw) : MIN_FREE_KILL_MB;
}

function oomText(reason: KillReason, capGb: number): string {
  return reason.kind === "cap"
    ? `vigia de memoria: arvore do gate em ${reason.treeMb} MB, acima do teto de ${capGb} GB — derrubada (TERM, depois KILL), saida 137`
    : `vigia de memoria: so ${reason.freeMb} MB livres na maquina (piso ${reason.floorMb} MB) — arvore do gate derrubada (TERM, depois KILL), saida 137`;
}

/** Linhas de um ticket na listagem do status; true se imprimiu alguma. */
function printQueue(queue: Queue, config: GateConfig, out: (line: string) => void): boolean {
  let found = false;
  const journal = queue.readJournal();
  const nowS = Math.floor(Date.now() / 1000);
  for (const { path, ticket } of queue.entries()) {
    found = true;
    out(`${path.slice(path.lastIndexOf("/") + 1)}\tstate=${field(ticket, "state")}\tkind=${field(ticket, "kind")}\tcost=${field(ticket, "cost")}GB\tlabel=${field(ticket, "label")}\tpid=${field(ticket, "pid")}\tsince=${field(ticket, "since")}\tclone=${field(ticket, "clone")}`);
    if (field(ticket, "step") !== "") out(`\t\tstep=${field(ticket, "step")}`);
    const overrun = runningOverrun(ticket, journal, nowS, config.overrunMin, config.overrunFactor);
    if (overrun !== undefined) out(`\t\t${overrun}`);
  }
  for (const name of queue.legacySlots()) {
    found = true;
    const owner = parseTicket(readText(join(dirname(queue.dir), name, "owner")) ?? "");
    out(`${name}\t(v1)\tkind=${field(owner, "kind")}\tlabel=${field(owner, "label")}\tpid=${field(owner, "pid")}\tsince=${field(owner, "since")}\tclone=${field(owner, "clone")}`);
  }
  return found;
}

/** A fila da máquina (`_maquina`) é de todos os projetos (a regressão da skill roda nela): o status de qualquer projeto a mostra também. */
function status(queue: Queue, config: GateConfig, machine: Queue | undefined): number {
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  out(`orcamento ${config.limits.budgetGb} GB | reserva ${config.limits.reserveGb} GB | MemAvailable ${memAvailableMb()} MB | PSI some avg10 ${psiSomeAvg10()}%`);
  let found = printQueue(queue, config, out);
  if (machine) {
    const lines: string[] = [];
    if (printQueue(machine, config, (line) => lines.push(line))) {
      found = true;
      out(`fila da máquina (${MACHINE_SLUG}):`);
      for (const line of lines) out(line);
    }
  }
  if (!found) out("nenhum gate na fila nem rodando");
  return 0;
}

function peak(queue: Queue, label: string): number {
  const value = peakOfLabel(queue.readJournal(), label);
  if (value === undefined) {
    note(`sem pico medido para o label '${label}' (${process.platform === "darwin" ? "so ha medicao com o vigia de memoria (HADES_GATE_MEMCAP=1)" : "so ha medicao sob systemd-run --user --scope"})`);
    return 1;
  }
  process.stdout.write(`${value}\n`);
  return 0;
}

function parseRun(args: readonly string[], defaultPriority: number): { options: RunOptions; command: string[] } {
  const options: RunOptions = { kind: "", label: "-", timeout: String(DEFAULT_TIMEOUT_SECONDS), cost: "", step: "", priority: String(defaultPriority), where: "", out: [], fresh: "", postLocal: "" };
  let rest = [...args];
  const first = rest[0] ?? "";
  if (!first.startsWith("--")) {
    if (first === "") usage();
    options.kind = first;
    rest = rest.slice(1);
  }
  const valueOf = (flag: string, value: string | undefined, message = `${flag} exige valor`): string => value ?? missingValue(message);
  while (rest.length > 0) {
    const flag = rest[0] as string;
    if (flag === "--") {
      rest = rest.slice(1);
      break;
    }
    const value = rest[1];
    if (flag === "--label") options.label = valueOf(flag, value);
    else if (flag === "--timeout") options.timeout = valueOf(flag, value);
    else if (flag === "--cost-gb") options.cost = valueOf(flag, value);
    else if (flag === "--step") options.step = valueOf(flag, value, "--step exige <stack>:<etapa>");
    else if (flag === "--priority") options.priority = valueOf(flag, value);
    else if (flag === "--where") options.where = valueOf(flag, value, "--where exige local ou <host>");
    else if (flag === "--out") options.out.push(valueOf(flag, value, "--out exige um caminho"));
    else if (flag === "--fresh") options.fresh = valueOf(flag, value, "--fresh exige um arquivo relativo ao diretório de --out");
    else if (flag === "--post-local") options.postLocal = valueOf(flag, value, "--post-local exige um comando");
    else gateDie(`argumento inesperado: ${flag}`);
    rest = rest.slice(2);
  }
  if (rest.length === 0) gateDie("run exige `-- <cmd...>`");
  return { options, command: rest };
}

export async function gateLockCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "") return printUsage();
  const env = process.env;
  const config = loadConfig(env);
  try {
    if (!["status", "peak", "run", "acquire", "release"].includes(sub)) return printUsage();
    const locks = resolveLocksDir(env, config.scope);
    const queue = new Queue(locks);
    if (sub === "status") {
      const machineLocks = join(workRoot(env), MACHINE_SLUG, "locks");
      return status(queue, config, env.HADES_WORK || machineLocks === locks ? undefined : new Queue(machineLocks));
    }
    if (sub === "peak") return peak(queue, rest[0] ?? missingValue("peak exige o label"));
    if (sub !== "run") gateDie(`'${sub}' saiu na v2: o pid de shell efemero nao prova liveness. Use \`run <kind> -- bash -c '...'\` ou \`run gate\``);
    return await runCommand(rest, config, queue, env);
  } catch (error) {
    if (error instanceof UsageError) return printUsage();
    if (error instanceof HadesError) {
      warn(`gate-lock: ${error.message}`);
      return error.code;
    }
    throw error;
  }
}

async function runCommand(rest: string[], config: GateConfig, queue: Queue, env: NodeJS.ProcessEnv): Promise<number> {
  const { options, command } = parseRun(rest, config.priority);
  mkdirSync(dirname(queue.dir), { recursive: true });
  if (options.kind === "" && options.step === "") usage();
  const childEnv: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of config.exported) childEnv[key] ??= value;
  return new Gate(config, queue, childEnv).run(options, command);
}

function printUsage(): number {
  warn(USAGE);
  return EX_USAGE;
}
