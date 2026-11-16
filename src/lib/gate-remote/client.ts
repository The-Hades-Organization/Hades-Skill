// Lado do `gate-lock` local: envia o código, pede o job ao worker, repassa a saída em streaming e traduz o fim em rc.
import { randomBytes } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { WarmState, WorkerStatus } from "./dispatch.ts";
import {
  PROTOCOL_VERSION, TrailerFilter, encodePayload, mirrorPath, translateRc, type Outcome, type Job, type Trailer,
} from "./protocol.ts";
import { pushSnapshot, snapshotCommit } from "./ship.ts";
import { captureRemote, spawnRemote, type SshCommand } from "./transport.ts";

const WARM_TIMEOUT_MS = 60_000;

export interface RemoteJobInput {
  host: string;
  home: string;
  repo: string;
  /** raiz do worktree local */
  clone: string;
  subdir: string;
  kind: string;
  label: string;
  cost: number;
  timeout: number;
  priority: number;
  step: string;
  stack: string;
  argv: readonly string[];
  /** caminhos absolutos dentro de $HOME */
  out: readonly string[];
  warmInline: boolean;
}

export interface RemoteResult extends Outcome {
  durS: number;
}

const newId = (): string => `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;

export function jobOf(input: RemoteJobInput, sha: string, id: string, nonce: string): Job {
  return {
    v: PROTOCOL_VERSION, nonce, id, repo: input.repo, sha, cwd: input.clone, subdir: input.subdir, kind: input.kind, label: input.label,
    cost: input.cost, timeout: input.timeout, priority: input.priority, step: input.step, stack: input.stack, argv: [...input.argv],
    out: [...input.out], warmInline: input.warmInline,
  };
}

/** Estado do worker (`worker status --json`); undefined quando não responde ou a resposta não tem o formato do contrato. */
export async function probeWorker(ssh: SshCommand, host: string): Promise<WorkerStatus | undefined> {
  const r = await captureRemote(ssh, host, "status --json");
  if (r.rc !== 0) return undefined;
  try {
    const s = JSON.parse(r.stdout.toString("utf8")) as WorkerStatus;
    const ok = typeof s.host === "string" && Array.isArray(s.labels) && typeof s.memFreeGb === "number" && typeof s.queue === "number" && typeof s.warm === "object" && s.warm !== null;
    return ok ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Dispara o aquecimento no worker: leva o código e pede o preparo, que segue em segundo plano lá. Falha só avisa. */
export async function warmWorker(ssh: SshCommand, host: string, input: Pick<RemoteJobInput, "home" | "repo" | "clone" | "stack">, warn: (message: string) => void): Promise<void> {
  const id = newId();
  try {
    const sha = snapshotCommit(input.clone, id);
    pushSnapshot(input.clone, host, mirrorPath(input.home, input.repo), sha, id, ssh);
    const request = encodePayload({ v: PROTOCOL_VERSION, id, repo: input.repo, sha, cwd: input.clone, stack: input.stack });
    const r = await captureRemote(ssh, host, `warm ${request}`, WARM_TIMEOUT_MS);
    if (r.rc !== 0) warn(`aquecimento de ${host} não começou (rc ${r.rc})`);
  } catch (error) {
    warn(`aquecimento de ${host} falhou: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function waitClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

/**
 * Roda o job no worker. Qualquer falha antes do fim (envio, conexão, worker morto) vira rc 75 com motivo: nunca 0.
 * `onSpawn` recebe o processo do transporte (o ticket o grava como `child=` e o sinal de parada o derruba).
 */
export async function runRemote(input: RemoteJobInput, ssh: SshCommand, onSpawn: (child: ChildProcess) => void, warn: (message: string) => void): Promise<RemoteResult> {
  const started = Date.now();
  const elapsed = (): number => Math.floor((Date.now() - started) / 1000);
  const id = newId();
  const nonce = randomBytes(16).toString("hex");
  let sha: string;
  try {
    sha = snapshotCommit(input.clone, id);
    pushSnapshot(input.clone, input.host, mirrorPath(input.home, input.repo), sha, id, ssh);
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return { rc: 75, reason: `envio falhou: ${error instanceof Error ? error.message : String(error)}`, peakMb: undefined, host: undefined, durS: elapsed() };
  }
  const job = jobOf(input, sha, id, nonce);
  // stdin fica aberto e nunca é escrito: o worker o vigia, e conexão caída ou ssh morto fecham o fluxo e derrubam o job
  const child = spawnRemote(ssh, input.host, `exec ${encodePayload(job)}`, ["pipe", "pipe", "pipe"]);
  onSpawn(child);
  const filter = new TrailerFilter(nonce);
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => process.stderr.write(filter.push(chunk)));
  await waitClose(child);
  const rest = filter.flush();
  if (rest !== "") process.stderr.write(rest);
  const trailer: Trailer | undefined = filter.trailer;
  const outFailed = trailer !== undefined && input.out.length > 0 ? !(await fetchOut(input, ssh, warn)) : false;
  const outcome = translateRc(trailer, outFailed && trailer?.rc === 0);
  if (outcome.reason !== undefined) warn(`rc 75: ${outcome.reason} (${input.host})`);
  return { ...outcome, host: outcome.host ?? input.host, durS: elapsed() };
}

/** Traz os arquivos declarados; true se todos chegaram. O pacote é um tar: só entram arquivos regulares declarados. */
async function fetchOut(input: RemoteJobInput, ssh: SshCommand, warn: (message: string) => void): Promise<boolean> {
  const staging = mkdtempSync(join(tmpdir(), "hades-out-"));
  try {
    const r = await captureRemote(ssh, input.host, `out ${encodePayload({ v: PROTOCOL_VERSION, cwd: input.clone, files: input.out })}`, 5 * 60 * 1000);
    if (r.rc !== 0) {
      warn(`retorno de --out de ${input.host} falhou (rc ${r.rc})`);
      return false;
    }
    const untar = spawn("tar", ["-xf", "-", "-C", staging, "--no-same-owner"], { stdio: ["pipe", "ignore", "ignore"] });
    untar.stdin?.end(r.stdout);
    await waitClose(untar);
    let all = true;
    for (const file of input.out) {
      const from = join(staging, file);
      try {
        // lstat: link simbólico no pacote não vale como arquivo declarado
        if (!lstatSync(from).isFile()) throw new Error("não é arquivo");
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.hades-out.${process.pid}`;
        copyFileSync(from, tmp);
        renameSync(tmp, file);
      } catch {
        warn(`--out: ${file} não voltou do worker`);
        all = false;
      }
    }
    return all;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export type { WarmState };
