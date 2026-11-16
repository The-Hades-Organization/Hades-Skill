// Leitura de /proc e dos cgroups para o amostrador da fila de gates.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fs.ts";
import { WORKER_STATUS_COMMAND } from "../lib/gate-remote/transport.ts";
import { exec } from "./exec.ts";
import { CGROUP_ROOT, meminfo, parsePsCommands, procIds, readLines } from "./system.ts";

export { meminfo };

const PAGE_BYTES = 4096;
const DOCKER_PS_TIMEOUT_MS = 5000;
const DOCKER_NAMES_TTL_S = 30;
const INFRA_DAEMON_NAME = /^[\w.-]{1,40}$/;
const SCOPE_RE = /run-p\d+-i\d+\.scope$/;
const DOCKER_SCOPE_RE = /docker-([0-9a-f]{12,64})\.scope$/;
// Daemon de infra que roda no HOST; processo de dentro de container também aparece no ps do host e é descartado pelo cgroup.
const INFRA_HOST_BASE = [
  "dockerd", "containerd", "containerd-shim[\\w-]*", "postgres", "postmaster", "redis-server", "mongod", "mysqld", "rabbitmq", "etcd",
  "influxd", "clickhouse-server",
];

export const HEAVY_RE = /(\/nx\/bin\/nx\.js|\bnx\s+(run|test|lint|build|affected|run-many)\b|jest|webpack|eslint|\/tsc\b|ngc)/;
export const DAEMON_RE = /nx\/src\/daemon|daemon\/server|plugin-worker|language-server|languageserver|tsserver|--stdio|lsp/;

export interface Proc {
  pid: number;
  ppid: number;
  comm: string;
  cmd: string;
  /** utime + stime em ticks */
  cpu: number;
  /** início em ticks desde o boot */
  start: number;
  rss: number;
  cwd: string;
}

export interface ProcTable {
  procs: Map<number, Proc>;
  children: Map<number, number[]>;
}

export interface InfraItem {
  kind: "container" | "host";
  name: string;
  detail: string;
  rss: number;
  ephemeral: boolean;
}

export const clockTicks = (): number => 100;

function readProc(pid: number): Proc | undefined {
  const stat = readText(`/proc/${pid}/stat`);
  if (!stat) return undefined;
  const rp = stat.lastIndexOf(")");
  const open = stat.indexOf("(");
  if (rp < 0 || open < 0) return undefined;
  const f = stat.slice(rp + 2).split(" ");
  const ppid = Number.parseInt(f[1] ?? "", 10);
  const cpu = Number.parseInt(f[11] ?? "", 10) + Number.parseInt(f[12] ?? "", 10);
  const start = Number.parseInt(f[19] ?? "", 10);
  if ([ppid, cpu, start].some(Number.isNaN)) return undefined;
  let cmd = "";
  try {
    cmd = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ").trim();
  } catch {
    // processo que morreu entre o stat e o cmdline: segue com a linha vazia
  }
  const statm = readText(`/proc/${pid}/statm`);
  const resident = statm ? Number.parseInt(statm.split(" ")[1] ?? "0", 10) : 0;
  let cwd = "";
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // sem permissão ou processo que saiu: cwd vazio, como no original
  }
  return { pid, ppid, comm: stat.slice(open + 1, rp), cmd, cpu, start, rss: (Number.isNaN(resident) ? 0 : resident) * PAGE_BYTES, cwd };
}

const PS_PROBE_TIMEOUT_MS = 3000;
/** `comm` vai por último: é a única coluna que pode ter espaço (`/Applications/Google Chrome.app/...`), então o resto da linha é dele. */
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.-]+)\s+([\d:-]+)\s+(\S.*?)\s*$/;

/** `[[dd-]hh:]mm:ss[.cc]` do `ps` (time= e etime=) em segundos. */
export function psClockSeconds(text: string): number {
  const [days, rest] = text.includes("-") ? text.split("-", 2) : ["0", text];
  const parts = (rest ?? "").split(":").map(Number);
  const [s = 0, m = 0, h = 0] = parts.reverse();
  return Number(days) * 86400 + h * 3600 + m * 60 + s;
}

export interface PsContext {
  /** `command` de cada pid (segundo `ps`: a linha de comando e o `comm` não podem dividir a mesma linha sem ambiguidade) */
  commands?: ReadonlyMap<number, string>;
  /** diretório de trabalho de cada pid (lsof); sem ele, vazio */
  cwds?: ReadonlyMap<number, string>;
  /** `boot`: a referência de `Proc.start` (epoch do boot); `now`: o instante em que o `ps` foi lido */
  clock?: { boot: number; now: number };
}

/**
 * macOS (sem /proc): `ps -axo pid=,ppid=,rss=,time=,etime=,comm=`, mais a linha de comando de `ps -axo pid=,command=`. O
 * início vira ticks desde o boot, `(now - etime - boot) * 100`, de modo que `ageOf` (`at - (boot + start / 100)`) dá a
 * idade verdadeira do processo para qualquer `boot` e não cresce com o tempo de vida do painel. Sem `clock`, o início é
 * `-etime`. O cwd não sai do `ps`: vem de `cwds` (lsof), ou fica vazio.
 */
export function parsePsProcs(text: string, ctx: PsContext = {}): Proc[] {
  const { commands = new Map<number, string>(), cwds = new Map<number, string>(), clock = { boot: 0, now: 0 } } = ctx;
  const out: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = PS_ROW.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const path = m[6] as string;
    out.push({
      pid, ppid: Number(m[2]), comm: path.slice(path.lastIndexOf("/") + 1), cmd: commands.get(pid) || path,
      cpu: Math.round(psClockSeconds(m[4] as string) * 100), start: Math.round((clock.now - psClockSeconds(m[5] as string) - clock.boot) * 100),
      rss: Number(m[3]) * 1024, cwd: cwds.get(pid) ?? "",
    });
  }
  return out;
}

/** `lsof -a -d cwd -Fpn`: uma linha `p<pid>` e uma `n<caminho>` por processo. */
export function parseLsofCwds(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) out.set(pid, line.slice(1));
  }
  return out;
}

function scanPsProcs(bootTime: number): Proc[] {
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,time=,etime=,comm="], { encoding: "utf8", timeout: PS_PROBE_TIMEOUT_MS });
  if (ps.status !== 0) return [];
  const full = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: PS_PROBE_TIMEOUT_MS });
  const commands = new Map(full.status === 0 ? parsePsCommands(full.stdout ?? "").map((row) => [row.pid, row.cmd] as const) : []);
  const lsof = spawnSync("lsof", ["-a", "-d", "cwd", "-Fpn"], { encoding: "utf8", timeout: PS_PROBE_TIMEOUT_MS });
  const cwds = lsof.status === 0 || lsof.stdout ? parseLsofCwds(lsof.stdout ?? "") : new Map<number, string>();
  return parsePsProcs(ps.stdout ?? "", { commands, cwds, clock: { boot: bootTime, now: Date.now() / 1000 } });
}

/** `bootTime`: a referência com que `ageOf` do chamador converte `Proc.start` em idade; só o macOS a usa (o /proc já dá ticks desde o boot). */
export function scanProcs(bootTime = 0): ProcTable {
  const procs = new Map<number, Proc>();
  if (process.platform === "darwin") for (const proc of scanPsProcs(bootTime)) procs.set(proc.pid, proc);
  else for (const id of procIds()) {
    const proc = readProc(Number.parseInt(id, 10));
    if (proc) procs.set(proc.pid, proc);
  }
  const children = new Map<number, number[]>();
  for (const p of procs.values()) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  return { procs, children };
}

export function descendants(pid: number, children: Map<number, number[]>): number[] {
  const out: number[] = [];
  const stack = [pid];
  for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
    out.push(cur);
    stack.push(...(children.get(cur) ?? []));
  }
  return out;
}

export function ancestors(start: number, procs: Map<number, Proc>): number[] {
  const seen: number[] = [];
  let pid = start;
  for (let p = procs.get(pid); p && !seen.includes(pid) && pid > 1; p = procs.get(pid)) {
    seen.push(pid);
    pid = p.ppid;
  }
  return seen;
}

/** Diretório do cgroup do scope systemd (`run-*.scope`, criado pelo `systemd-run --scope` do gate) em que o gate roda. */
export function gateScope(pid: number, children: Map<number, number[]>): string | undefined {
  // macOS: sem cgroup nem scope; quem chama cai na soma de RSS da árvore
  if (process.platform === "darwin") return undefined;
  for (const d of descendants(pid, children)) {
    for (const line of readLines(`/proc/${d}/cgroup`)) {
      const path = line.slice(line.lastIndexOf(":") + 1);
      if (SCOPE_RE.test(path)) {
        const cg = join(CGROUP_ROOT, path.replace(/^\/+/, ""));
        return isDirectory(cg) ? cg : undefined;
      }
    }
  }
  return undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const digitsOf = (text: string | undefined): number | null => (text !== undefined && /^\d+$/.test(text.trim()) ? Number.parseInt(text.trim(), 10) : null);

/** Todo cgroup `run-p*.scope` vivo sob a sessão do usuário e o que ele ocupa: o daemon do NX sobrevive ao gate e mantém o scope de pé. */
export function allGateScopes(uid: number): Map<string, number> {
  const out = new Map<string, number>();
  const base = join(CGROUP_ROOT, "user.slice", `user-${uid}.slice`, `user@${uid}.service`);
  if (!isDirectory(base)) return out;
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = join(dir, e.name);
      if (/^run-p.*\.scope$/.test(e.name)) {
        const mem = digitsOf(readText(join(path, "memory.current")));
        if (mem !== null) out.set(path, mem);
      }
      walk(path);
    }
  };
  walk(base);
  return out;
}

/** (bytes em uso, segundos de CPU acumulados) do cgroup: vem do kernel e inclui processo de vida curta entre duas amostras. */
export function cgroupUsage(cg: string): { mem: number | null; cpuSeconds: number | null } {
  const mem = digitsOf(readText(join(cg, "memory.current")));
  let cpuSeconds: number | null = null;
  for (const line of readLines(join(cg, "cpu.stat"))) {
    if (line.startsWith("usage_usec")) {
      cpuSeconds = Number.parseInt(line.split(/\s+/)[1] ?? "0", 10) / 1e6;
      break;
    }
  }
  return { mem, cpuSeconds };
}

export function pressure(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of readLines("/proc/pressure/memory")) {
    const [kind, ...kv] = line.split(/\s+/);
    const avg = kv.map((x) => x.split("=")).find((pair) => pair[0] === "avg10");
    if (kind) out[kind] = avg ? Number.parseFloat(avg[1] ?? "0") : 0;
  }
  return out;
}

/** Daemons de infra do plugin do projeto (plugin.json → panel.infraDaemons); só nomes simples. */
export function pluginInfraDaemons(dir: string): string[] {
  try {
    const manifest: unknown = JSON.parse(readText(join(dir, "plugin", "plugin.json")) ?? "{}");
    const names = ((manifest as { panel?: { infraDaemons?: unknown } }).panel?.infraDaemons ?? []) as unknown;
    if (!Array.isArray(names)) return [];
    return names.filter((n): n is string => typeof n === "string" && INFRA_DAEMON_NAME.test(n)).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  } catch {
    // manifesto ausente ou inválido: só os daemons padrão
    return [];
  }
}

export function infraHostPattern(extra: string[]): RegExp {
  return new RegExp(`(^|/)(${[...INFRA_HOST_BASE, ...extra].join("|")})\\b`);
}

export interface DockerNames {
  lookup(): Promise<Map<string, { name: string; image: string; ephemeral: boolean }>>;
}

/** {id_curto: nome, imagem, testcontainer}, com TTL: `docker ps` custa caro por amostra. */
export function dockerNames(now: () => number): DockerNames {
  let at = 0;
  let cached = new Map<string, { name: string; image: string; ephemeral: boolean }>();
  return {
    async lookup() {
      if (now() - at < DOCKER_NAMES_TTL_S) return cached;
      const next = new Map<string, { name: string; image: string; ephemeral: boolean }>();
      try {
        const res = await exec(["docker", "ps", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Labels}}"], { timeoutMs: DOCKER_PS_TIMEOUT_MS });
        for (const line of res.stdout.split("\n")) {
          const f = line.split("\t");
          if (f.length >= 3) next.set((f[0] as string).slice(0, 12), { name: f[1] as string, image: f[2] as string, ephemeral: (f[3] ?? "").includes("org.testcontainers") });
        }
      } catch {
        // sem docker no PATH ou daemon fora: a lista de nomes fica vazia
      }
      at = now();
      cached = next;
      return cached;
    },
  };
}

/** Bytes totais e itens da infraestrutura: containers (pelo cgroup) e daemons no host (por RSS, fora de container). */
export async function infraUsage(table: ProcTable, hostPattern: RegExp, names: DockerNames): Promise<{ total: number; items: InfraItem[] }> {
  const known = await names.lookup();
  const items: InfraItem[] = [];
  let scopes: string[] = [];
  try {
    scopes = readdirSync(join(CGROUP_ROOT, "system.slice")).filter((n) => n.startsWith("docker-") && n.endsWith(".scope"));
  } catch {
    // sem system.slice legível: sem containers pelo cgroup
  }
  for (const name of scopes) {
    const m = DOCKER_SCOPE_RE.exec(name);
    const mem = digitsOf(readText(join(CGROUP_ROOT, "system.slice", name, "memory.current")));
    if (!m || mem === null) continue;
    const cid = (m[1] as string).slice(0, 12);
    const hit = known.get(cid);
    items.push({ kind: "container", name: hit?.name ?? cid, detail: hit?.image ?? "", rss: mem, ephemeral: hit?.ephemeral ?? false });
  }
  const byDaemon = new Map<string, number>();
  for (const p of table.procs.values()) {
    if ((readText(`/proc/${p.pid}/cgroup`) ?? "").includes("docker-")) continue;
    if (hostPattern.test(p.cmd.split(" ")[0] ?? "") || hostPattern.test(p.comm)) byDaemon.set(p.comm, (byDaemon.get(p.comm) ?? 0) + p.rss);
  }
  for (const [comm, rss] of byDaemon) items.push({ kind: "host", name: comm, detail: "daemon no host", rss, ephemeral: false });
  items.sort((a, b) => b.rss - a.rss);
  return { total: items.reduce((acc, i) => acc + i.rss, 0), items };
}

// ---------------------------------------------------------------- workers remotos (leitura do `hades worker status --json`)

export type WarmState = "ready" | "warming" | "failed";
export interface WorkerStatus {
  host: string;
  labels: string[];
  memFreeGb: number;
  memTotalGb: number;
  cpus: number;
  queue: number;
  warm: Record<string, WarmState>;
  /** aditivo: versão achada no PATH do ssh não interativo, ou null = ausente; worker antigo não manda o campo */
  tools?: Record<string, string | null>;
}
export interface WorkerView {
  /** o alvo como veio de HADES_GATE_WORKERS (user@host ou host) */
  target: string;
  /** rótulos declarados na configuração; os do status, quando há, valem mais */
  labels: string[];
  reachable: boolean;
  /** última leitura boa foi há mais que o ciclo: mostrada como em cache */
  stale: boolean;
  checkedAt: number | null;
  okAt: number | null;
  error: string | null;
  status: WorkerStatus | null;
}
export interface WorkerSpec {
  target: string;
  labels: string[];
}

const WORKER_TARGET_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$/;
const WORKER_LABEL_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const WORKER_TIMEOUT_MS = 4000;
const WORKER_EVERY_S = 15;
const WORKER_ERROR_MAX = 160;
const WARM_STATES: readonly string[] = ["ready", "warming", "failed"];
/** argumento que o `command="hades worker exec"` forçado recebe em SSH_ORIGINAL_COMMAND */
export const WORKER_STATUS_ARGS = WORKER_STATUS_COMMAND.split(" ");

/** `host[:rótulo,…]` separados por vírgula de fora, espaço ou `;`; alvo fora do padrão é descartado (vai a argv do ssh). */
export function parseWorkers(spec: string | undefined): WorkerSpec[] {
  const out: WorkerSpec[] = [];
  for (const raw of (spec ?? "").split(/[\s;]+/)) {
    if (!raw) continue;
    const i = raw.indexOf(":");
    const target = i < 0 ? raw : raw.slice(0, i);
    if (!WORKER_TARGET_RE.test(target) || out.some((w) => w.target === target)) continue;
    const labels = i < 0 ? [] : raw.slice(i + 1).split(",").filter((l) => WORKER_LABEL_RE.test(l));
    out.push({ target, labels });
  }
  return out;
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Valida o contrato do `worker status --json`; devolve undefined quando falta campo (o painel não inventa número). */
export function parseWorkerStatus(text: string): WorkerStatus | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const memFreeGb = finite(o.memFreeGb);
  const memTotalGb = finite(o.memTotalGb);
  const cpus = finite(o.cpus);
  const queue = finite(o.queue);
  if (typeof o.host !== "string" || memFreeGb === undefined || memTotalGb === undefined || cpus === undefined || queue === undefined) return undefined;
  const labels = Array.isArray(o.labels) ? o.labels.filter((l): l is string => typeof l === "string") : [];
  const warm: Record<string, WarmState> = {};
  if (o.warm !== null && typeof o.warm === "object" && !Array.isArray(o.warm)) {
    for (const [k, v] of Object.entries(o.warm)) if (typeof v === "string" && WARM_STATES.includes(v)) warm[k] = v as WarmState;
  }
  const status: WorkerStatus = { host: o.host, labels, memFreeGb, memTotalGb, cpus, queue, warm };
  if (o.tools !== null && typeof o.tools === "object" && !Array.isArray(o.tools)) {
    const tools: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(o.tools)) if (v === null || typeof v === "string") tools[k] = v;
    status.tools = tools;
  }
  return status;
}

export type WorkerRunner = (argv: string[], timeoutMs: number) => Promise<{ status: number; stdout: string; stderr: string; timedOut: boolean }>;

/** Uma leitura de um worker. `--` fecha as opções do ssh: o alvo nunca é lido como opção. BatchMode: sem pergunta de senha. */
export async function readWorker(target: string, run: WorkerRunner = (argv, ms) => exec(argv, { timeoutMs: ms })): Promise<{ status: WorkerStatus } | { error: string }> {
  const argv = [
    "ssh", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${Math.ceil(WORKER_TIMEOUT_MS / 1000) - 1}`, "-o", "ServerAliveInterval=2", "-o", "ServerAliveCountMax=1",
    "--", target, ...WORKER_STATUS_ARGS,
  ];
  const r = await run(argv, WORKER_TIMEOUT_MS);
  if (r.timedOut) return { error: "sem resposta no tempo (inacessível)" };
  if (r.status !== 0) return { error: (r.stderr.trim().split("\n").pop() || `ssh saiu com ${r.status}`).slice(0, WORKER_ERROR_MAX) };
  const status = parseWorkerStatus(r.stdout);
  return status ? { status } : { error: "resposta fora do contrato do worker status --json" };
}

/**
 * Leitura em segundo plano com cache: `view()` nunca espera a rede. Worker que cai mantém a última leitura boa marcada
 * como em cache (`stale`) e o erro; um que nunca respondeu aparece só com o erro.
 */
export function createWorkerWatch(opts: { specs: () => WorkerSpec[]; now: () => number; run?: WorkerRunner }): { refresh(): Promise<void>; view(): WorkerView[] } {
  const views = new Map<string, WorkerView>();
  let inflight: Promise<void> | undefined;
  let lastAt = Number.NEGATIVE_INFINITY;

  async function readAll(): Promise<void> {
    const specs = opts.specs();
    for (const key of [...views.keys()]) if (!specs.some((s) => s.target === key)) views.delete(key);
    await Promise.all(specs.map(async (s) => {
      const r = await readWorker(s.target, opts.run);
      const at = opts.now();
      const before = views.get(s.target);
      views.set(s.target, "status" in r
        ? { target: s.target, labels: s.labels, reachable: true, stale: false, checkedAt: at, okAt: at, error: null, status: r.status }
        : { target: s.target, labels: s.labels, reachable: false, stale: before?.status != null, checkedAt: at, okAt: before?.okAt ?? null, error: r.error, status: before?.status ?? null });
    }));
  }

  return {
    refresh(): Promise<void> {
      const at = opts.now();
      if (inflight || at - lastAt < WORKER_EVERY_S) return inflight ?? Promise.resolve();
      lastAt = at;
      inflight = readAll().finally(() => { inflight = undefined; });
      return inflight;
    },
    view(): WorkerView[] {
      return opts.specs().map((s) => views.get(s.target) ?? { target: s.target, labels: s.labels, reachable: false, stale: false, checkedAt: null, okAt: null, error: "ainda não consultado", status: null });
    },
  };
}
