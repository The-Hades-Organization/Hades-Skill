// Leituras do sistema e dos arquivos de estado de $D que o amostrador e as rotas usam (/proc, cgroup, catálogo de serviços).
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../lib/fs.ts";
import { memAvailableMb, memTotalMb, run } from "../lib/proc.ts";

export const CGROUP_ROOT = "/sys/fs/cgroup";
const HTTP_TIMEOUT_MS = 1500;
const SYSCTL = "/usr/sbin/sysctl";
const PS = "/bin/ps";
const PROBE_TIMEOUT_MS = 2000;
const BYTES_PER_MIB = 1024 * 1024;
const LOAD_SAMPLES = 3;
const LOG_TAIL_BYTES = 256 * 1024;
const LOG_WINDOW_S = 900;
const LOG_CACHE_TTL_S = 30;
const ERROR_MSG_MAX = 300;
const PINO_ERROR = 50;
const PINO_WARN = 40;
const PINO_INFO = 30;
const LEVELS: Record<string, number> = { ERROR: 50, FATAL: 60, WARN: 40 };

export const readLines = (path: string): string[] => (readText(path) ?? "").split("\n").filter((line, i, all) => !(i === all.length - 1 && line === ""));

/** Linhas não vazias e que não começam com `#`, aparadas (services.required, services.enabled, web.paths…). */
export const listFile = (path: string): string[] => readLines(path).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

/** `chave=valor` por linha (rebuild.report, fila do gate). */
export function fields(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readLines(path)) {
    const eq = line.indexOf("=");
    if (eq >= 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function isoEpoch(text: string): number | null {
  const ms = Date.parse(text);
  return Number.isNaN(ms) || !/^\d{4}-\d\d-\d\d/.test(text) ? null : ms / 1000;
}

/** O macOS não tem /proc: as leituras abaixo caem em sysctl e ps (nativos), com a mesma forma de retorno. */
const hasProc = (): boolean => existsSync("/proc/self");

const sysctl = (name: string): string => run(SYSCTL, ["-n", name], { timeoutMs: PROBE_TIMEOUT_MS }).stdout.trim();

/** `kern.boottime`: `{ sec = 1700000000, usec = 123 } Mon ...`; epoch do boot, 0 se não casa. */
export function parseBootTime(text: string): number {
  return Number(/sec\s*=\s*(\d+)/.exec(text)?.[1] ?? 0);
}

/** Epoch do boot da máquina: `btime` do /proc/stat ou `kern.boottime`; 0 se nenhum dos dois responde. */
export function bootEpoch(): number {
  if (hasProc()) return Number.parseInt((readText("/proc/stat") ?? "").split("\n").find((l) => l.startsWith("btime"))?.split(/\s+/)[1] ?? "", 10) || 0;
  return parseBootTime(sysctl("kern.boottime"));
}

/** `vm.loadavg`: `{ 1.20 1.10 1.00 }`; três zeros se não casa. */
export function parseLoadAverage(text: string): number[] {
  const nums = (/\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text) ?? []).slice(1, 1 + LOAD_SAMPLES).map(Number);
  return nums.length === LOAD_SAMPLES ? nums : [0, 0, 0];
}

const UNIT_BYTES: Record<string, number> = { K: 1024, M: BYTES_PER_MIB, G: BYTES_PER_MIB * 1024 };

/** `vm.swapusage`: `total = 2048.00M  used = 1024.00M  free = 1024.00M ...`, em bytes. */
export function parseSwapUsage(text: string): { total: number; free: number } {
  const bytes = (label: string): number => {
    const m = new RegExp(`${label} = ([\\d.]+)([KMG])`).exec(text);
    return m ? Math.round(Number(m[1]) * (UNIT_BYTES[m[2] as string] as number)) : 0;
  };
  return { total: bytes("total"), free: bytes("free") };
}

/** `ps -axo pid=,command=`: uma linha por processo, pid e linha de comando. */
export function parsePsCommands(text: string): ProcCommand[] {
  const rows: ProcCommand[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m) rows.push({ pid: Number.parseInt(m[1] as string, 10), cmd: m[2] as string });
  }
  return rows;
}

export interface ProcCommand {
  pid: number;
  cmd: string;
}

/** Segundos desde o boot. */
export function uptime(): number {
  if (hasProc()) return Number.parseFloat((readText("/proc/uptime") ?? "0").split(/\s+/)[0] ?? "0") || 0;
  const boot = parseBootTime(sysctl("kern.boottime"));
  return boot > 0 ? Math.max(0, Date.now() / 1000 - boot) : 0;
}

/** Carga média de 1, 5 e 15 minutos. */
export function loadAverage(): number[] {
  if (hasProc()) return (readText("/proc/loadavg") ?? "0 0 0").split(/\s+/).slice(0, LOAD_SAMPLES).map(Number);
  return parseLoadAverage(sysctl("vm.loadavg"));
}

/** Memória em bytes, com as chaves do /proc/meminfo que o painel usa (MemTotal, MemAvailable, SwapTotal, SwapFree). */
export function meminfo(): Record<string, number> {
  const out: Record<string, number> = {};
  if (!hasProc()) {
    const swap = parseSwapUsage(sysctl("vm.swapusage"));
    return { MemTotal: memTotalMb() * BYTES_PER_MIB, MemAvailable: memAvailableMb() * BYTES_PER_MIB, SwapTotal: swap.total, SwapFree: swap.free };
  }
  for (const line of readLines("/proc/meminfo")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const value = line.slice(colon + 1).trim();
    out[line.slice(0, colon)] = value ? Number.parseInt(value.split(/\s+/)[0] ?? "0", 10) * 1024 : 0;
  }
  return out;
}

/** Pid e linha de comando de cada processo visível, sem os argumentos separados por NUL. */
export function procCommands(): ProcCommand[] {
  if (!hasProc()) return parsePsCommands(run(PS, ["-axo", "pid=,command="], { timeoutMs: PROBE_TIMEOUT_MS }).stdout);
  const rows: ProcCommand[] = [];
  for (const id of procIds()) {
    const raw = readText(join("/proc", id, "cmdline"));
    if (raw !== undefined) rows.push({ pid: Number.parseInt(id, 10), cmd: raw.replaceAll("\0", " ").trim() });
  }
  return rows;
}

const digits = (text: string | undefined): number | null => (text !== undefined && /^\d+$/.test(text.trim()) ? Number.parseInt(text.trim(), 10) : null);
export const cgMem = (cg: string): number | null => digits(readText(join(cg, "memory.current")));
export const cgMax = (cg: string): number | null => digits(readText(join(cg, "memory.max")));
export const cgHigh = (cg: string): number | null => digits(readText(join(cg, "memory.high")));

/** Código HTTP da URL local, ou null se não respondeu (a falha de rede não é erro aqui: o serviço só está fora). */
export async function httpStatus(url: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
}

export interface ServiceRow {
  port: number;
  dev: string;
  redis: boolean;
  db: boolean;
  gateway: boolean;
}

/** Linhas do services.tsv (todos os apps do repo), na ordem do arquivo. */
export function serviceCatalog(dir: string): Map<string, ServiceRow> {
  const out = new Map<string, ServiceRow>();
  for (const line of readLines(join(dir, "services.tsv"))) {
    if (!line.trim() || line.startsWith("#")) continue;
    const f = line.split("\t");
    if (f.length >= 7) out.set(f[0] as string, { port: Number.parseInt(f[1] as string, 10), dev: f[2] as string, redis: f[3] !== "-", db: f[5] !== "-", gateway: f[6] !== "-" });
  }
  return out;
}

/** {serviço: mem_limit} do compose do kit, para listar até o que nunca subiu. */
export function composeServices(dir: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let current: string | undefined;
  for (const line of readLines(join(dir, "infra", "compose.yml"))) {
    const svc = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (svc) {
      current = svc[1] as string;
      out.set(current, null);
      continue;
    }
    const lim = /^ {4}mem_limit:\s*(\S+)/.exec(line);
    if (lim && current) out.set(current, lim[1] as string);
  }
  return out;
}


export interface LogErrors {
  errors: number;
  warns: number;
  last: { t: number; msg: string } | null;
}

interface LogCacheEntry {
  size: number;
  t: number;
  res: LogErrors;
}

/** Erros e avisos dos últimos 15 min do log do serviço (pino/kafkajs). Lê só o fim e reaproveita enquanto o tamanho não muda. */
export function logErrors(dir: string, cache: Map<string, LogCacheEntry>, service: string, now: number): LogErrors {
  const path = join(dir, "logs", `${service}.log`);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { errors: 0, warns: 0, last: null };
  }
  const hit = cache.get(service);
  if (hit && hit.size === size && now - hit.t < LOG_CACHE_TTL_S) return hit.res;
  const fd = openSync(path, "r");
  let tail: string;
  try {
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    tail = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  let errors = 0;
  let warns = 0;
  let last: LogErrors["last"] = null;
  for (const line of tail.split("\n")) {
    if (!line.startsWith("{")) continue;
    let o: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      o = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const time = o.time;
    const stamp = o.timestamp;
    const ts = typeof time === "number" ? time / 1000 : typeof stamp === "string" && stamp ? isoEpoch(stamp) : null;
    if (ts === null || now - ts > LOG_WINDOW_S) continue;
    const level = typeof o.level === "number" ? o.level : (LEVELS[String(o.level).toUpperCase()] ?? PINO_INFO);
    if (level >= PINO_ERROR) {
      errors++;
      last = { t: ts, msg: String(o.msg || o.message || "").slice(0, ERROR_MSG_MAX) };
    } else if (level === PINO_WARN) warns++;
  }
  const res = { errors, warns, last };
  cache.set(service, { size, t: now, res });
  return res;
}

export type { LogCacheEntry };

/** Pids de /proc; vazio onde não há /proc (macOS: o amostrador de cgroup não tem o que ler). */
export const procIds = (): string[] => (hasProc() ? readdirSync("/proc").filter((d) => /^\d+$/.test(d)) : []);
