// Recursos que o worker declara em `hades worker status`: SO, CPU, RAM e uso do disco. Só declara; quem despacha o gate
// não decide por estes campos. Os parsers são puros (texto entra, número sai) e a coleta nunca falha o status: sem a
// fonte (macOS sem /proc, arquivo ilegível), o campo some.
import { readFileSync } from "node:fs";
import { arch, cpus, loadavg, release, type } from "node:os";

const KIB_PER_GB = 1024 ** 2;
const SAMPLE_MS = 200;
const PCT_MAX = 100;

export interface WorkerOs {
  /** `PRETTY_NAME` de /etc/os-release (já traz a versão); fallback `os.type() os.release()` */
  name: string;
  kernel: string;
  arch: string;
}

/** Campos aditivos de recursos; todos opcionais: worker antigo não os manda e o cliente mostra "—". */
export interface WorkerRecursos {
  os?: WorkerOs;
  diskUsedGb?: number;
  diskUsedPct?: number;
  cpuModel?: string;
  load1?: number;
  load5?: number;
  load15?: number;
  cpuUsedPct?: number;
  memUsedGb?: number;
  memUsedPct?: number;
  swapTotalGb?: number;
  swapFreeGb?: number;
}

const oneDecimal = (n: number): number => Math.round(n * 10) / 10;
const twoDecimals = (n: number): number => Math.round(n * 100) / 100;
const pctOf = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * PCT_MAX) : 0);

/** `PRETTY_NAME` de um /etc/os-release (aspas simples ou duplas, ou nenhuma); undefined sem a chave. */
export function parseOsRelease(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith("PRETTY_NAME="));
  if (line === undefined) return undefined;
  const value = line.slice("PRETTY_NAME=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  return value === "" ? undefined : value;
}

export interface CpuTimes {
  idle: number;
  total: number;
}

/** Linha agregada `cpu ` do /proc/stat: tempo ocioso (idle + iowait) e total (user..steal; guest já está em user). */
export function parseProcStat(text: string): CpuTimes | undefined {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (line === undefined) return undefined;
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  const NEEDED = 4;
  if (f.length < NEEDED || f.some((n) => !Number.isFinite(n))) return undefined;
  const IOWAIT = 4;
  const STEAL_END = 8;
  const idle = (f[3] ?? 0) + (f[IOWAIT] ?? 0);
  return { idle, total: f.slice(0, STEAL_END).reduce((a, b) => a + b, 0) };
}

/** Percentual de CPU ocupada entre duas leituras do /proc/stat; undefined sem intervalo medido. */
export function cpuUsedPctBetween(a: CpuTimes, b: CpuTimes): number | undefined {
  const total = b.total - a.total;
  if (total <= 0) return undefined;
  return Math.min(PCT_MAX, Math.max(0, Math.round((1 - (b.idle - a.idle) / total) * PCT_MAX)));
}

export interface Meminfo {
  totalKb?: number;
  availableKb?: number;
  swapTotalKb?: number;
  swapFreeKb?: number;
}

export function parseMeminfo(text: string): Meminfo {
  const kb = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) : undefined;
  };
  return { totalKb: kb("MemTotal"), availableKb: kb("MemAvailable"), swapTotalKb: kb("SwapTotal"), swapFreeKb: kb("SwapFree") };
}

/** RAM usada (total − disponível) e swap, em GB; só os campos que o meminfo trouxe. */
export function ramOf(m: Meminfo): Pick<WorkerRecursos, "memUsedGb" | "memUsedPct" | "swapTotalGb" | "swapFreeGb"> {
  const out: Pick<WorkerRecursos, "memUsedGb" | "memUsedPct" | "swapTotalGb" | "swapFreeGb"> = {};
  if (m.totalKb !== undefined && m.availableKb !== undefined) {
    const used = Math.max(0, m.totalKb - m.availableKb);
    out.memUsedGb = oneDecimal(used / KIB_PER_GB);
    out.memUsedPct = pctOf(used, m.totalKb);
  }
  if (m.swapTotalKb !== undefined && m.swapFreeKb !== undefined) {
    out.swapTotalGb = oneDecimal(m.swapTotalKb / KIB_PER_GB);
    out.swapFreeGb = oneDecimal(m.swapFreeKb / KIB_PER_GB);
  }
  return out;
}

/** Disco usado (total − livre) a partir dos GB que o `diskOf` já mediu do mesmo statfs. */
export function diskUsage(freeGb: number | undefined, totalGb: number | undefined): Pick<WorkerRecursos, "diskUsedGb" | "diskUsedPct"> {
  if (freeGb === undefined || totalGb === undefined || totalGb <= 0) return {};
  const used = Math.max(0, totalGb - freeGb);
  return { diskUsedGb: oneDecimal(used), diskUsedPct: pctOf(used, totalGb) };
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function osOf(): WorkerOs {
  const pretty = parseOsRelease(readOptional("/etc/os-release") ?? "");
  return { name: pretty ?? `${type()} ${release()}`, kernel: release(), arch: arch() };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** CPU ocupada nos ~200 ms entre duas leituras do /proc/stat; sem /proc/stat, undefined. */
export function sampleCpuUsedPct(read: () => string | undefined = () => readOptional("/proc/stat"), wait: (ms: number) => void = sleepSync): number | undefined {
  const first = parseProcStat(read() ?? "");
  if (first === undefined) return undefined;
  wait(SAMPLE_MS);
  const second = parseProcStat(read() ?? "");
  return second === undefined ? undefined : cpuUsedPctBetween(first, second);
}

/** Recursos desta máquina. Recebe o disco já medido para somar o uso sem outra chamada ao statfs. */
export function collectRecursos(disk: { diskFreeGb?: number; diskTotalGb?: number }): WorkerRecursos {
  const [l1 = 0, l5 = 0, l15 = 0] = loadavg();
  const cpuUsedPct = sampleCpuUsedPct();
  const model = cpus()[0]?.model?.trim();
  return {
    os: osOf(),
    ...diskUsage(disk.diskFreeGb, disk.diskTotalGb),
    ...(model ? { cpuModel: model } : {}),
    load1: twoDecimals(l1), load5: twoDecimals(l5), load15: twoDecimals(l15),
    ...(cpuUsedPct === undefined ? {} : { cpuUsedPct }),
    ...ramOf(parseMeminfo(readOptional("/proc/meminfo") ?? "")),
  };
}

const NUMERIC_KEYS = ["diskUsedGb", "diskUsedPct", "load1", "load5", "load15", "cpuUsedPct", "memUsedGb", "memUsedPct", "swapTotalGb", "swapFreeGb"] as const;
/** Todas as chaves aditivas: o cliente apaga as que vieram do fio antes de pôr as validadas. */
export const RECURSOS_KEYS = [...NUMERIC_KEYS, "cpuModel", "os"] as const;
const MODEL_MAX = 120;
const OS_FIELD_MAX = 120;

const finiteNonNegative = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const shortText = (v: unknown, max: number): string | undefined => (typeof v === "string" && v !== "" ? v.slice(0, max) : undefined);

/** Valida na fronteira os campos aditivos de uma resposta de worker (qualquer versão): o que não tem o formato some. */
export function parseRecursos(o: Record<string, unknown>): WorkerRecursos {
  const out: WorkerRecursos = {};
  for (const key of NUMERIC_KEYS) {
    const value = finiteNonNegative(o[key]);
    if (value !== undefined) out[key] = value;
  }
  const model = shortText(o.cpuModel, MODEL_MAX);
  if (model !== undefined) out.cpuModel = model;
  const raw = o.os;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const name = shortText(r.name, OS_FIELD_MAX);
    if (name !== undefined) out.os = { name, kernel: shortText(r.kernel, OS_FIELD_MAX) ?? "", arch: shortText(r.arch, OS_FIELD_MAX) ?? "" };
  }
  return out;
}

const dash = "—";
const num = (n: number | undefined, unit = ""): string => (n === undefined ? dash : `${n}${unit}`);

/** As quatro linhas do `hades worker status` em texto: SO, disco, CPU e RAM. Campo ausente vira "—". */
export function formatRecursos(s: WorkerRecursos & { diskFreeGb?: number; diskTotalGb?: number; cpus?: number; memTotalGb?: number }): string[] {
  const so = s.os ? `${s.os.name} · kernel ${s.os.kernel || dash} · ${s.os.arch || dash}` : dash;
  const disco = s.diskUsedGb === undefined ? dash : `${s.diskUsedGb}/${num(s.diskTotalGb)} GB (${num(s.diskUsedPct, "%")})`;
  const carga = s.load1 === undefined ? dash : `${s.load1} ${num(s.load5)} ${num(s.load15)}`;
  const cpu = `${s.cpuModel ?? dash} · ${num(s.cpus)} núcleos · carga ${carga} · ${num(s.cpuUsedPct, "%")} em uso`;
  const swap = s.swapTotalGb === undefined ? dash : `${oneDecimal(s.swapTotalGb - (s.swapFreeGb ?? 0))}/${s.swapTotalGb} GB`;
  const ram = s.memUsedGb === undefined ? dash : `${s.memUsedGb}/${num(s.memTotalGb)} GB (${num(s.memUsedPct, "%")}) · swap ${swap}`;
  return [`SO\t${so}`, `disco\t${disco}`, `CPU\t${cpu}`, `RAM\t${ram}`];
}
