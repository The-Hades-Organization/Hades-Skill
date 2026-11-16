// `hades worker`: o lado do worker da fila de gates remota. A chave SSH do worker tem `command="hades worker exec"`
// forçado: o que o cliente pediu chega em SSH_ORIGINAL_COMMAND e passa pela lista fechada de src/lib/gate-remote/protocol.ts
// antes de qualquer coisa rodar. Nada aqui usa shell sobre texto do job: o comando do job é `argv` entregue ao
// `gate-lock` do próprio worker (admissão, teto systemd, pico e journal são os de lá).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, hostname, homedir, totalmem } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { withFlockAsync } from "../lib/flock.ts";
import { JOB_REF_PREFIX } from "../lib/gate-remote/ship.ts";
import type { WorkerStatus } from "../lib/gate-remote/dispatch.ts";
import {
  PROTOCOL_VERSION, ProtocolError, RC_NOT_RUN, decodePayload, formatTrailer, mirrorPath, parseWorkerCommand, type Job, type OutRequest, type WarmRequest,
} from "../lib/gate-remote/protocol.ts";
import { claimSlot, expandEnv, readKeyFiles, readWarm, remoteSpecOf, warmKey, warmStates, writeWarm, type RemoteSpec } from "../lib/gate-remote/warm.ts";
import { HadesError, warn } from "../lib/output.ts";
import { journalWorkRoot } from "../lib/journal.ts";
import { memAvailableMb, which } from "../lib/proc.ts";
import { installedStacks } from "../lib/profile.ts";
import { selfCli } from "../lib/paths.ts";

const FS_ROOT_ENV = "HADES_WORKER_FS_ROOT";
const LABELS_ENV = "HADES_WORKER_LABELS";
const RESULT_FILE_ENV = "HADES_GATE_RESULT_FILE";
const USAGE_EXIT = 2;
const MB_PER_GB = 1024;
const KILL_GRACE_MS = 3000;
const OUT_EXIT_FAIL = 1;

const home = (): string => process.env.HOME || homedir();
/** Teste/jaula: prefixo físico dos caminhos do job. Vazio em produção (o caminho do job é o caminho real). */
const fsRoot = (): string => process.env[FS_ROOT_ENV] ?? "";
const physical = (logical: string): string => (fsRoot() === "" ? logical : join(fsRoot(), logical));
const baseDir = (): string => join(home(), ".cache", "hades-worker");

function die(message: string, code = USAGE_EXIT): never {
  throw new HadesError(message, code);
}

// --- status ---

function detectLabels(): string[] {
  const labels = new Set((process.env[LABELS_ENV] ?? "").split(",").map((l) => l.trim()).filter((l) => /^[a-z0-9][a-z0-9-]*$/.test(l)));
  if (which("docker") !== undefined && (existsSync("/var/run/docker.sock") || process.env.DOCKER_HOST)) labels.add("docker");
  return [...labels].sort();
}

/** Tickets de todas as filas do worker (por projeto ou da máquina): é o que "queue" do status conta. */
function queueLength(): number {
  const roots = process.env.HADES_WORK ? [process.env.HADES_WORK] : listSafe(journalWorkRoot()).map((name) => join(journalWorkRoot(), name));
  let total = 0;
  for (const root of roots) {
    total += listSafe(join(root, "locks", "gate-queue")).filter((name) => name.endsWith(".t")).length;
  }
  return total;
}

function listSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function workerStatus(): WorkerStatus {
  const oneDecimal = (n: number): number => Math.round(n * 10) / 10;
  return {
    host: hostname(), labels: detectLabels(), memFreeGb: oneDecimal(memAvailableMb() / MB_PER_GB), memTotalGb: oneDecimal(totalmem() / MB_PER_GB ** 3),
    cpus: cpus().length, queue: queueLength(), warm: warmStates(physical(baseDir())),
  };
}

// --- espelho e worktree ---

function git(args: readonly string[], cwd?: string): { rc: number; out: string; err: string } {
  const r = spawnSync("git", args as string[], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { rc: r.status ?? 1, out: r.stdout.trim(), err: r.stderr.trim() };
}

function ensureMirror(mirror: string): void {
  if (existsSync(join(mirror, "HEAD"))) return;
  mkdirSync(mirror, { recursive: true });
  const r = git(["init", "--bare", "-q", mirror]);
  if (r.rc !== 0) die(`espelho: ${r.err}`, 1);
}

const worktreeId = (cwd: string): string => createHash("sha256").update(cwd).digest("hex").slice(0, 24);

/** O worktree do job, no mesmo caminho do cliente. Só mexe em worktree que o próprio worker criou (marcador no espelho). */
function syncWorktree(mirror: string, cwd: string, sha: string): void {
  const markers = join(mirror, "hades-worktrees");
  mkdirSync(markers, { recursive: true });
  const marker = join(markers, worktreeId(cwd));
  const target = physical(cwd);
  if (existsSync(target)) {
    const empty = listSafe(target).length === 0;
    if (!existsSync(marker) && !empty) die(`worktree ${cwd}: o caminho existe e não é do worker`, RC_NOT_RUN);
    if (existsSync(marker)) {
      const checkout = git(["checkout", "-q", "--detach", "-f", sha], target);
      if (checkout.rc !== 0) die(`checkout ${sha.slice(0, 8)}: ${checkout.err}`, 1);
      // sem -x: ignorados (node_modules, target) ficam, é o que o aquecimento guarda
      git(["clean", "-fdq"], target);
      return;
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  const add = git(["--git-dir", mirror, "worktree", "add", "-f", "--detach", target, sha]);
  if (add.rc !== 0) die(`worktree add: ${add.err}`, 1);
  writeFileSync(marker, `${cwd}\n`);
}

function specOfStack(name: string): RemoteSpec | undefined {
  return name === "" ? undefined : remoteSpecOf(installedStacks().get(name));
}

function keyOf(stack: string, spec: RemoteSpec, cwd: string): string {
  return warmKey({ stack, scope: cwd, files: readKeyFiles(physical(cwd), spec.key) });
}

// --- preparo (aquecimento) ---

/** Roda os `remote.prepare` da stack do worker, em ordem, no worktree. Para no primeiro que falha. */
function runPrepare(spec: RemoteSpec, cwd: string, repo: string, toStderr: boolean): number {
  const env = { ...process.env, ...expandEnv(spec.env, { cache: physical(baseDir()), repo, slot: "prepare" }) };
  for (const command of spec.prepare) {
    const r = spawnSync("sh", ["-c", command], { cwd: physical(cwd), env, stdio: ["ignore", toStderr ? 2 : "ignore", 2] });
    if (r.status !== 0) return r.status ?? 1;
  }
  return 0;
}

async function warmRequestRun(request: WarmRequest, foreground: boolean): Promise<number> {
  const spec = specOfStack(request.stack);
  if (spec === undefined) die(`stack '${request.stack}' não declara aquecimento neste worker`, 0);
  const mirror = physical(mirrorPath(home(), request.repo));
  ensureMirror(mirror);
  if (git(["--git-dir", mirror, "cat-file", "-e", `${request.sha}^{commit}`]).rc !== 0) die("warm: o código do aquecimento não chegou ao espelho", RC_NOT_RUN);
  const lock = join(mirror, "hades-worktrees", `${worktreeId(request.cwd)}.lock`);
  mkdirSync(dirname(lock), { recursive: true });
  return withFlockAsync(lock, async () => {
    syncWorktree(mirror, request.cwd, request.sha);
    const key = keyOf(request.stack, spec, request.cwd);
    const base = physical(baseDir());
    if (readWarm(base, key)?.state === "ready") return 0;
    if (!foreground) {
      // o preparo segue sozinho: a ida ao ssh que pediu volta já
      const payload = Buffer.from(JSON.stringify({ request, key }), "utf8").toString("base64url");
      const cli = selfCli("worker", "__warm-run", payload);
      const child = spawn(cli.command, cli.args, { detached: true, stdio: "ignore", env: process.env });
      writeWarm(base, { key, cwd: request.cwd, state: "warming", since: new Date().toISOString(), pid: child.pid });
      child.unref();
      return 0;
    }
    return prepareAndRecord(request, spec, key);
  });
}

function prepareAndRecord(request: Pick<WarmRequest, "cwd" | "repo">, spec: RemoteSpec, key: string): number {
  const base = physical(baseDir());
  writeWarm(base, { key, cwd: request.cwd, state: "warming", since: new Date().toISOString(), pid: process.pid });
  const rc = runPrepare(spec, request.cwd, request.repo, true);
  writeWarm(base, { key, cwd: request.cwd, state: rc === 0 ? "ready" : "failed", since: new Date().toISOString() });
  return rc;
}

/** Corpo do processo solto que o `warm` deixa para trás (comando interno: fora da lista do SSH). */
async function warmRun(encoded: string): Promise<number> {
  const raw = decodePayload(encoded) as { request: WarmRequest; key: string };
  const spec = specOfStack(raw.request.stack);
  if (spec === undefined) return 1;
  const mirror = physical(mirrorPath(home(), raw.request.repo));
  const lock = join(mirror, "hades-worktrees", `${worktreeId(raw.request.cwd)}.lock`);
  return withFlockAsync(lock, async () => prepareAndRecord(raw.request, spec, raw.key));
}

// --- job ---

function readResult(path: string): { peakMb: number | undefined } {
  try {
    const m = /^peak=(\d+)$/m.exec(readFileSync(path, "utf8"));
    return { peakMb: m ? Number(m[1]) : undefined };
  } catch {
    return { peakMb: undefined };
  }
}

function emitTrailer(job: Job, rc: number, peakMb: number | undefined, startedMs: number): void {
  process.stderr.write(formatTrailer(job.nonce, { rc, peakMb, host: hostname(), durS: Math.floor((Date.now() - startedMs) / 1000) }));
}

/** Para antes de rodar: o motivo vai ao stderr do cliente e o rc sai pelo trailer (75 = não rodou, nunca verde). */
function refuse(job: Job, message: string, startedMs: number): number {
  warn(`worker: ${message}`);
  emitTrailer(job, RC_NOT_RUN, undefined, startedMs);
  return RC_NOT_RUN;
}

async function execJob(job: Job): Promise<number> {
  const started = Date.now();
  const mirror = physical(mirrorPath(home(), job.repo));
  if (!existsSync(join(mirror, "HEAD"))) return refuse(job, "espelho inexistente (o código não foi enviado)", started);
  const ref = git(["--git-dir", mirror, "rev-parse", "-q", "--verify", `${JOB_REF_PREFIX}/${job.id}`]);
  if (ref.rc !== 0 || ref.out !== job.sha) return refuse(job, "o commit do job não está na ref do espelho", started);
  const lock = join(mirror, "hades-worktrees", `${worktreeId(job.cwd)}.lock`);
  mkdirSync(dirname(lock), { recursive: true });
  return withFlockAsync(lock, async () => {
    try {
      syncWorktree(mirror, job.cwd, job.sha);
    } catch (error) {
      return refuse(job, error instanceof Error ? error.message : String(error), started);
    }
    const spec = specOfStack(job.stack);
    if (spec !== undefined && spec.prepare.length > 0) {
      const key = keyOf(job.stack, spec, job.cwd);
      if (readWarm(physical(baseDir()), key)?.state !== "ready") {
        if (!job.warmInline) return refuse(job, "ambiente frio para esta chave (o aquecimento não terminou)", started);
        if (prepareAndRecord(job, spec, key) !== 0) return refuse(job, "preparo do ambiente falhou", started);
      }
    }
    const slot = spec === undefined ? undefined : claimSlot(physical(baseDir()), job.repo);
    const resultFile = join(physical(baseDir()), "results", `${job.id}.txt`);
    mkdirSync(dirname(resultFile), { recursive: true });
    try {
      const rc = await runGateLock(job, spec, slot?.slot ?? 0, resultFile);
      if (rc === undefined) return 143;
      emitTrailer(job, rc, readResult(resultFile).peakMb, started);
      return rc;
    } finally {
      slot?.release();
      rmSync(resultFile, { force: true });
    }
  });
}

/** Roda o `gate-lock` do worker sobre o job; undefined = a conexão caiu e o job foi derrubado (ninguém para ouvir o trailer). */
function runGateLock(job: Job, spec: RemoteSpec | undefined, slot: number, resultFile: string): Promise<number | undefined> {
  const cli = selfCli(
    "gate-lock", "run", job.kind, "--label", job.label, "--timeout", String(job.timeout), "--cost-gb", String(job.cost), "--priority", String(job.priority),
    ...(job.step === "" ? [] : ["--step", job.step]), "--", ...job.argv,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...(spec === undefined ? {} : expandEnv(spec.env, { cache: physical(baseDir()), repo: job.repo, slot: String(slot) })),
    HADES_GATE_WHERE: "local", [RESULT_FILE_ENV]: resultFile,
  };
  delete env.GATE_LOCK_TICKET;
  const cwd = job.subdir === "" ? physical(job.cwd) : join(physical(job.cwd), job.subdir);
  return new Promise((resolve) => {
    const child = spawn(cli.command, cli.args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    let lost = false;
    // stdin do ssh: fecha quando a conexão cai (ou o cliente morre). O job não pode seguir sem ninguém esperando por ele
    const onLost = (): void => {
      if (lost) return;
      lost = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    process.stdin.once("end", onLost);
    process.stdin.once("close", onLost);
    process.stdin.once("error", onLost);
    process.stdin.resume();
    // O vigia do stdin mantém o processo vivo: com o job terminado ele precisa soltar o pipe, senão o ssh não volta.
    const stopWatching = (): void => {
      process.stdin.off("end", onLost);
      process.stdin.off("close", onLost);
      process.stdin.off("error", onLost);
      process.stdin.pause();
    };
    child.once("error", () => {
      stopWatching();
      resolve(127);
    });
    child.once("close", (code, signal) => {
      stopWatching();
      resolve(lost ? undefined : (code ?? (signal === null ? 1 : 128 + (signal === "SIGKILL" ? 9 : 15))));
    });
  });
}

// --- retorno de arquivos ---

function outFiles(request: OutRequest): number {
  const physHome = realpathSync(physical(home()));
  const names: string[] = [];
  for (const file of request.files) {
    const path = physical(file);
    try {
      if (!lstatSync(path).isFile() || !realpathSync(path).startsWith(`${physHome}/`)) continue;
    } catch {
      continue;
    }
    names.push(file.slice(1));
  }
  if (names.length === 0) return 0;
  const r = spawnSync("tar", ["-cf", "-", "-C", fsRoot() === "" ? "/" : fsRoot(), "--", ...names], { stdio: ["ignore", "inherit", "inherit"] });
  return r.status === 0 ? 0 : OUT_EXIT_FAIL;
}

// --- entradas ---

async function serve(original: string): Promise<number> {
  const request = parseWorkerCommand(original, home());
  switch (request.kind) {
    case "status":
      process.stdout.write(`${JSON.stringify(workerStatus())}\n`);
      return 0;
    case "exec":
      return execJob(request.job);
    case "warm":
      return warmRequestRun(request.request, false);
    case "out":
      return outFiles(request.request);
    case "receive-pack": {
      const mirror = physical(request.path);
      ensureMirror(mirror);
      return spawnSync("git-receive-pack", [mirror], { stdio: "inherit" }).status ?? 1;
    }
  }
}

function printStatus(json: boolean): number {
  const s = workerStatus();
  if (json) process.stdout.write(`${JSON.stringify(s)}\n`);
  else {
    process.stdout.write(`worker ${s.host}: rótulos [${s.labels.join(", ")}] · memória livre ${s.memFreeGb}/${s.memTotalGb} GB · ${s.cpus} CPUs · fila ${s.queue}\n`);
    for (const [key, state] of Object.entries(s.warm)) process.stdout.write(`  ${key}\t${state}\n`);
  }
  return 0;
}

const WORKER_USAGE = `uso: hades worker exec | status [--json] | warm <stack>

  exec    comando forçado da chave SSH do worker (command="hades worker exec"): lê SSH_ORIGINAL_COMMAND
  status  capacidade e ambientes aquecidos desta máquina como worker
  warm    prepara o ambiente do worktree atual (npm ci, cargo fetch) para a stack e grava o estado`;

export async function workerCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  try {
    if (sub === "exec") {
      const original = process.env.SSH_ORIGINAL_COMMAND;
      if (original === undefined) die("exec só roda como comando forçado do SSH (SSH_ORIGINAL_COMMAND ausente)");
      return await serve(original);
    }
    if (sub === "status") return printStatus(rest.includes("--json"));
    if (sub === "warm") return await warmHere(rest[0] ?? "");
    if (sub === "__warm-run") return await warmRun(rest[0] ?? "");
    warn(WORKER_USAGE);
    return USAGE_EXIT;
  } catch (error) {
    if (error instanceof ProtocolError) {
      warn(`worker: pedido recusado: ${error.message}`);
      return USAGE_EXIT;
    }
    if (error instanceof HadesError) {
      warn(`worker: ${error.message}`);
      return error.code;
    }
    throw error;
  }
}

/** `hades worker warm <stack>` à mão: prepara o worktree atual (já presente) em primeiro plano. */
async function warmHere(stack: string): Promise<number> {
  const spec = specOfStack(stack);
  if (stack === "" || spec === undefined) die(`warm exige uma stack que declare remote.* (instaladas: ${[...installedStacks()].filter(([, d]) => remoteSpecOf(d)).map(([n]) => n).join(", ") || "nenhuma"})`);
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.rc !== 0) die("warm: fora de um worktree git");
  const request = { cwd: top.out, repo: "local" };
  const key = warmKey({ stack, scope: top.out, files: readKeyFiles(top.out, spec.key) });
  const rc = prepareAndRecord(request, spec, key);
  process.stdout.write(`${key}\t${rc === 0 ? "ready" : "failed"}\n`);
  return rc;
}
