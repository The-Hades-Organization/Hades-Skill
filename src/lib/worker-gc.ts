// Limpeza do worker (`hades worker gc`): remove worktrees de gate ociosas, resultados e slots vencidos, refs de job antigas e
// compacta o espelho. Roda com o disco cheio, então NADA é criado antes de apagar: só `rm`, `git worktree remove` e leitura
// (o lock de cada worktree é o arquivo `.lock` que já existe; se não existe, a worktree não tem dono vivo).
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { LOCK_EX, LOCK_NB, LOCK_UN, sysFlock } from "./flock.ts";
import { containedInHome, type GcRequest } from "./gate-remote/protocol.ts";
import { pidAlive, sameProcess } from "./proc.ts";

const GB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const SIZE_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_GC_TIMEOUT_MS = 30 * 60 * 1000;
const SLOT_PID_GRACE_MS = 5000;
/** Resultado e marcador de início de job mais velhos que isto não servem a ninguém (o job dura horas, no máximo). */
export const RESULTS_KEEP_MS = DAY_MS;
/** Ref `refs/hades/jobs/*` só é lida no começo do job; a de um dia atrás já cumpriu o papel. */
export const JOB_REFS_KEEP_MS = DAY_MS;
const JOB_REFS = "refs/hades/jobs";
const MARKER_EXTRAS = [".lock", ".job", ".used"] as const;

export interface GcOptions extends GcRequest {
  /** worktrees ociosas há mais que isto saem sempre (limpeza automática); undefined = sem regra de idade */
  idleOlderThanMs?: number;
  /** caminhos lógicos (cwd do job) que nunca saem, mesmo ociosos */
  exclude?: readonly string[];
  /** false = só mexe em resultados, slots, refs e espelho quando alguma worktree saiu (a limpeza automática não compacta a cada job) */
  maintenanceAlways: boolean;
}

export interface GcEnv {
  /** `~/.cache/hades-worker` físico */
  base: string;
  /** home lógico do worker (o cwd do marcador precisa estar dentro dele) */
  home: string;
  physical: (logical: string) => string;
  /** pids com ticket vivo nas filas de gate (o cwd deles diz qual worktree a fila está usando) */
  ticketPids: () => number[];
  now?: () => number;
  /** bytes ocupados por um diretório; padrão `du -sk` */
  sizeOf?: (path: string) => number;
}

export interface GcRemoved {
  cwd: string;
  gb: number;
  idleDays: number;
}

export interface GcKept {
  cwd: string;
  reason: string;
}

export interface GcReport {
  dryRun: boolean;
  freedGb: number;
  removed: GcRemoved[];
  kept: GcKept[];
  warmCleared: string[];
  resultsRemoved: number;
  slotsRemoved: number;
  refsDeleted: number;
  /** erros de limpeza que não pararam as outras (a remoção que falhou aparece em `kept`) */
  errors: string[];
}

interface Candidate {
  id: string;
  cwd: string;
  target: string;
  mirror: string;
  markers: string;
  lastUseMs: number;
  /** lock tomado (aberto) que impede um job novo de entrar durante a remoção */
  lockFd: number | undefined;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function listSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function mtimeOf(path: string): number {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readTrim(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function duBytes(path: string): number {
  const r = spawnSync("du", ["-sk", "--", path], { encoding: "utf8", timeout: SIZE_TIMEOUT_MS });
  const kb = Number.parseInt((r.stdout ?? "").split("\t")[0] ?? "", 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

function git(mirror: string, args: readonly string[], timeout?: number): { rc: number; out: string; err: string } {
  const r = spawnSync("git", ["--git-dir", mirror, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout });
  return { rc: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** Toma o lock sem criar o arquivo e sem esperar; undefined = ocupado (job vivo) ou ausente. Quem recebe o fd o solta com `unlock`. */
function tryLock(path: string): { fd: number } | "busy" | "absent" {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "absent";
  }
  if (sysFlock()(fd, LOCK_EX | LOCK_NB) === 0) return { fd };
  closeSync(fd);
  return "busy";
}

function unlock(fd: number): void {
  sysFlock()(fd, LOCK_UN);
  closeSync(fd);
}

/** Dentro de `dir` (ou nele mesmo)? Compara por segmento, não por prefixo de texto. */
const within = (dir: string, path: string): boolean => path === dir || path.startsWith(`${dir}${sep}`);

function cwdOfPid(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

/** Por que a worktree não pode sair agora; undefined = ociosa. Quem a segura: lock do job/aquecimento, marcador `.job` vivo, ticket de fila com cwd nela. */
function busyReason(c: Candidate, ticketCwds: readonly string[]): { reason: string | undefined; lockFd?: number } {
  const lock = tryLock(join(c.markers, `${c.id}.lock`));
  if (lock === "busy") return { reason: "job ativo (lock)" };
  const releaseOnBusy = (reason: string): { reason: string } => {
    if (lock !== "absent") unlock(lock.fd);
    return { reason };
  };
  const job = readTrim(join(c.markers, `${c.id}.job`)).split(" ");
  if (job[0] !== undefined && job[0] !== "" && sameProcess(job[0], job[1] ?? "")) return releaseOnBusy("job ativo (marcador)");
  if (ticketCwds.some((cwd) => within(c.target, cwd))) return releaseOnBusy("ticket vivo na fila");
  return lock === "absent" ? { reason: undefined } : { reason: undefined, lockFd: lock.fd };
}

function candidatesOf(env: GcEnv): Candidate[] {
  const out: Candidate[] = [];
  const mirrorsDir = join(env.base, "mirror");
  for (const name of listSafe(mirrorsDir)) {
    if (!name.endsWith(".git")) continue;
    const mirror = join(mirrorsDir, name);
    const markers = join(mirror, "hades-worktrees");
    for (const id of listSafe(markers)) {
      if (MARKER_EXTRAS.some((extra) => id.endsWith(extra)) || id.includes(".tmp")) continue;
      const cwd = readTrim(join(markers, id));
      if (!containedInHome(cwd, env.home)) continue;
      const target = env.physical(cwd);
      const lastUseMs = Math.max(mtimeOf(join(markers, `${id}.used`)), mtimeOf(target));
      out.push({ id, cwd, target, mirror, markers, lastUseMs, lockFd: undefined });
    }
  }
  return out.sort((a, b) => a.lastUseMs - b.lastUseMs);
}

interface RawWarm {
  file: string;
  cwd: string;
  state: string;
}

function warmRecords(env: GcEnv): RawWarm[] {
  const dir = join(env.base, "warm");
  const records: RawWarm[] = [];
  for (const name of listSafe(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as { cwd?: unknown; state?: unknown };
      if (typeof raw.cwd === "string") records.push({ file: join(dir, name), cwd: raw.cwd, state: typeof raw.state === "string" ? raw.state : "" });
    } catch {
      // marcador ilegível não aponta worktree nenhuma; o status já o ignora
    }
  }
  return records;
}

function registeredWorktrees(mirror: string): Set<string> {
  const listed = git(mirror, ["worktree", "list", "--porcelain"]);
  return new Set(listed.out.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length)));
}

function removeWorktree(c: Candidate, registered: ReadonlySet<string>): string | undefined {
  if (registered.has(c.target)) {
    const r = git(c.mirror, ["worktree", "remove", "--force", c.target]);
    if (r.rc !== 0 && existsSync(c.target)) rmSync(c.target, { recursive: true, force: true });
  } else rmSync(c.target, { recursive: true, force: true });
  if (existsSync(c.target)) return "a pasta continuou lá depois da remoção";
  for (const suffix of ["", ".used", ".job"]) rmSync(join(c.markers, `${c.id}${suffix}`), { force: true });
  return undefined;
}

function expiredResults(env: GcEnv, now: number, dryRun: boolean): number {
  const dir = join(env.base, "results");
  let removed = 0;
  for (const name of listSafe(dir)) {
    if (now - mtimeOf(join(dir, name)) <= RESULTS_KEEP_MS) continue;
    if (!dryRun) rmSync(join(dir, name), { force: true, recursive: true });
    removed += 1;
  }
  return removed;
}

function expiredSlots(env: GcEnv, now: number, dryRun: boolean): number {
  const root = join(env.base, "slots");
  let removed = 0;
  for (const repo of listSafe(root)) {
    for (const slot of listSafe(join(root, repo))) {
      const dir = join(root, repo, slot);
      const owner = Number.parseInt(readTrim(join(dir, "pid")), 10);
      const dead = Number.isInteger(owner) ? !pidAlive(owner) : now - mtimeOf(dir) >= SLOT_PID_GRACE_MS;
      if (!dead) continue;
      if (!dryRun) rmSync(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

function oldJobRefs(mirror: string, now: number): string[] {
  const listed = git(mirror, ["for-each-ref", "--format=%(refname) %(committerdate:unix)", JOB_REFS]);
  const old: string[] = [];
  for (const line of listed.out.split("\n")) {
    const [ref = "", seconds = ""] = line.split(" ");
    if (ref !== "" && now - Number(seconds) * 1000 > JOB_REFS_KEEP_MS) old.push(ref);
  }
  return old;
}

/**
 * Executa a limpeza. Ordem: worktrees (a mais antiga primeiro) → marcadores de warm das removidas → resultados e slots →
 * refs de job → `git gc` do espelho (só depois de liberar espaço, porque compactar escreve).
 */
export function runGc(env: GcEnv, options: GcOptions): GcReport {
  const now = (env.now ?? Date.now)();
  const sizeOf = env.sizeOf ?? duBytes;
  const report: GcReport = { dryRun: options.dryRun, freedGb: 0, removed: [], kept: [], warmCleared: [], resultsRemoved: 0, slotsRemoved: 0, refsDeleted: 0, errors: [] };
  const warm = warmRecords(env);
  const ticketCwds = env.ticketPids().flatMap((pid) => cwdOfPid(pid) ?? []);
  const registered = new Map<string, Set<string>>();
  const wantBytes = options.freeGb === undefined ? undefined : options.freeGb * GB;
  let freedBytes = 0;
  const removedCwds = new Set<string>();
  const touchedMirrors = new Set<string>();

  for (const c of candidatesOf(env)) {
    const idleMs = now - c.lastUseMs;
    if ((options.exclude ?? []).includes(c.cwd)) {
      report.kept.push({ cwd: c.cwd, reason: "job que acabou de rodar" });
      continue;
    }
    const stale = options.idleOlderThanMs !== undefined && idleMs > options.idleOlderThanMs;
    const wanted = options.allIdle || stale || (wantBytes !== undefined && freedBytes < wantBytes);
    if (!wanted) {
      report.kept.push({ cwd: c.cwd, reason: "pedido já atendido" });
      continue;
    }
    const busy = busyReason(c, ticketCwds);
    if (busy.reason !== undefined) {
      report.kept.push({ cwd: c.cwd, reason: busy.reason });
      continue;
    }
    if (options.keepWarm && warm.some((w) => w.cwd === c.cwd && (w.state === "ready" || w.state === "warming"))) {
      if (busy.lockFd !== undefined) unlock(busy.lockFd);
      report.kept.push({ cwd: c.cwd, reason: "aquecida (--keep-warm)" });
      continue;
    }
    const bytes = existsSync(c.target) ? sizeOf(c.target) : 0;
    try {
      if (!options.dryRun) {
        if (!registered.has(c.mirror)) registered.set(c.mirror, registeredWorktrees(c.mirror));
        const failure = removeWorktree(c, registered.get(c.mirror) ?? new Set());
        if (failure !== undefined) {
          report.kept.push({ cwd: c.cwd, reason: failure });
          continue;
        }
        touchedMirrors.add(c.mirror);
      }
    } catch (error) {
      report.kept.push({ cwd: c.cwd, reason: `remoção falhou: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    } finally {
      if (busy.lockFd !== undefined) unlock(busy.lockFd);
    }
    freedBytes += bytes;
    removedCwds.add(c.cwd);
    report.removed.push({ cwd: c.cwd, gb: round2(bytes / GB), idleDays: round2(idleMs / DAY_MS) });
  }
  report.freedGb = round2(freedBytes / GB);

  for (const record of warm) {
    if (!removedCwds.has(record.cwd)) continue;
    if (!options.dryRun) rmSync(record.file, { force: true });
    report.warmCleared.push(record.file.slice(record.file.lastIndexOf(sep) + 1, -".json".length));
  }

  if (!options.maintenanceAlways && report.removed.length === 0) return report;
  report.resultsRemoved = expiredResults(env, now, options.dryRun);
  report.slotsRemoved = expiredSlots(env, now, options.dryRun);
  const mirrors = options.dryRun ? [] : listSafe(join(env.base, "mirror")).filter((name) => name.endsWith(".git")).map((name) => join(env.base, "mirror", name));
  for (const mirror of mirrors) {
    for (const ref of oldJobRefs(mirror, now)) {
      const r = git(mirror, ["update-ref", "-d", ref]);
      if (r.rc === 0) report.refsDeleted += 1;
      else report.errors.push(`ref ${ref}: ${r.err}`);
    }
    if (touchedMirrors.has(mirror)) git(mirror, ["worktree", "prune"]);
    const packed = git(mirror, ["gc", "--prune=now", "-q"], GIT_GC_TIMEOUT_MS);
    if (packed.rc !== 0) report.errors.push(`git gc ${mirror.slice(mirror.lastIndexOf(sep) + 1)}: ${packed.err}`);
  }
  return report;
}

/** Resumo de uma linha por item para o terminal do cliente. */
export function formatGcReport(report: GcReport, extra: { diskFreeGb?: number } = {}): string {
  const lines = [`${report.dryRun ? "sairiam" : "removidas"} ${report.removed.length} worktrees (${report.freedGb} GB)${extra.diskFreeGb === undefined ? "" : ` · disco livre ${extra.diskFreeGb} GB`}`];
  for (const r of report.removed) lines.push(`  - ${r.cwd}\t${r.gb} GB\tocioso há ${r.idleDays} d`);
  for (const k of report.kept) lines.push(`  = ${k.cwd}\t${k.reason}`);
  if (report.warmCleared.length > 0) lines.push(`marcadores de aquecimento ${report.dryRun ? "a limpar" : "limpos"}: ${report.warmCleared.length}`);
  lines.push(`resultados vencidos: ${report.resultsRemoved} · slots vencidos: ${report.slotsRemoved} · refs de job: ${report.refsDeleted}`);
  for (const e of report.errors) lines.push(`erro: ${e}`);
  return lines.join("\n");
}
