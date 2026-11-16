// Lado do `gate-lock` local: envia o código, pede o job ao worker, repassa a saída em streaming e traduz o fim em rc.
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { WarmState, WorkerStatus } from "./dispatch.ts";
import {
  PROTOCOL_VERSION, TrailerFilter, encodePayload, mirrorPath, translateRc, type Outcome, type Job, type Trailer,
} from "./protocol.ts";
import { MANIFEST_NAME, diffTree, freshProblem, hashTree, parseManifest, type Manifest, type ManifestDir } from "./manifest.ts";
import { headSha, pushSnapshot, snapshotCommit } from "./ship.ts";
import { captureRemote, spawnRemote, type SshCommand } from "./transport.ts";

const WARM_TIMEOUT_MS = 60_000;
const OUT_TIMEOUT_MS = 10 * 60 * 1000;

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
  /** caminhos absolutos dentro de $HOME (arquivo ou diretório: quem decide é o que existe no worker) */
  out: readonly string[];
  warmInline: boolean;
  /** `--fresh`: arquivo relativo a cada diretório de `--out` que o build tem de ter regravado */
  fresh: string;
  /** entradas de build (valores já lidos do ambiente do chamador, só nomes que a stack permite) */
  env: Readonly<Record<string, string>>;
  /** `--post-local`: roda aqui, depois da promoção, só com sucesso */
  postLocal: string;
}

export interface RemoteResult extends Outcome {
  durS: number;
  /** HEAD do worktree no envio (o que o marcador de "construído" do chamador compara); vazio se o envio falhou */
  sha: string;
  /** commit sintético que viajou (estado exato do worktree) */
  snapshot: string;
}

const newId = (): string => `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;

export function jobOf(input: RemoteJobInput, sha: string, id: string, nonce: string): Job {
  return {
    v: PROTOCOL_VERSION, nonce, id, repo: input.repo, sha, cwd: input.clone, subdir: input.subdir, kind: input.kind, label: input.label,
    cost: input.cost, timeout: input.timeout, priority: input.priority, step: input.step, stack: input.stack, argv: [...input.argv],
    out: [...input.out], warmInline: input.warmInline, fresh: input.fresh, env: { ...input.env },
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
  const head = headSha(input.clone);
  try {
    sha = snapshotCommit(input.clone, id);
    pushSnapshot(input.clone, input.host, mirrorPath(input.home, input.repo), sha, id, ssh);
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return { rc: 75, reason: `envio falhou: ${error instanceof Error ? error.message : String(error)}`, peakMb: undefined, host: undefined, durS: elapsed(), sha: head, snapshot: "" };
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
  const outProblem = trailer !== undefined && input.out.length > 0 ? await fetchOut(input, id, trailer.rc === 0, ssh, warn) : undefined;
  const outcome = translateRc(trailer, outProblem !== undefined && trailer?.rc === 0);
  const reason = outProblem !== undefined && outcome.reason !== undefined ? `${outcome.reason}: ${outProblem}` : outcome.reason;
  if (reason !== undefined) warn(`rc 75: ${reason} (${input.host})`);
  const base = { host: outcome.host ?? input.host, durS: elapsed(), sha: head, snapshot: sha };
  if (outcome.rc !== 0 || input.postLocal === "") return { ...outcome, reason, ...base };
  const post = runPostLocal(input.postLocal);
  return post === 0 ? { ...outcome, reason, ...base } : { ...outcome, rc: post, reason: `--post-local saiu ${post}`, ...base };
}

/** O passo posterior roda aqui, no diretório de quem chamou, com a saída no terminal; o rc dele vale como o do item. */
function runPostLocal(command: string): number {
  const r = spawnSync("sh", ["-c", command], { stdio: "inherit" });
  return r.status ?? 1;
}

/** Traz o pacote `out` do worker (tar em streaming) e o extrai em `target`. undefined = ok; senão o motivo. */
async function receiveTar(input: RemoteJobInput, id: string, withDirs: boolean, ssh: SshCommand, target: string): Promise<string | undefined> {
  const request = encodePayload({ v: PROTOCOL_VERSION, id, cwd: input.clone, files: input.out, dirs: withDirs });
  const remote = spawnRemote(ssh, input.host, `out ${request}`, ["ignore", "pipe", "pipe"]);
  const untar = spawn("tar", ["-xf", "-", "-C", target, "--no-same-owner"], { stdio: ["pipe", "ignore", "pipe"] });
  remote.stdout?.pipe(untar.stdin as NodeJS.WritableStream);
  let err = "";
  remote.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
  untar.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
  const timer = setTimeout(() => remote.kill("SIGKILL"), OUT_TIMEOUT_MS);
  const exit = (child: ChildProcess): Promise<number> => new Promise((resolve) => {
    child.once("error", () => resolve(255));
    child.once("close", (code) => resolve(code ?? 255));
  });
  const [remoteRc, untarRc] = await Promise.all([exit(remote), exit(untar)]);
  clearTimeout(timer);
  if (remoteRc !== 0) return `retorno de --out de ${input.host} falhou (rc ${remoteRc})${err === "" ? "" : `: ${err.trim().split("\n").at(-1)}`}`;
  return untarRc === 0 ? undefined : `tar do retorno saiu ${untarRc}`;
}

function readManifest(scratch: string): Manifest | undefined {
  try {
    return parseManifest(readFileSync(join(scratch, MANIFEST_NAME), "utf8"));
  } catch {
    return undefined;
  }
}

/** Confere cada diretório devolvido contra o manifesto do worker (e o `--fresh`). undefined = íntegro. */
function checkDirs(input: RemoteJobInput, scratch: string, manifest: Manifest): string | undefined {
  const dirs = manifest.dirs.filter((d) => input.out.includes(d.dir));
  if (input.fresh !== "" && dirs.length === 0) return "--fresh pede um diretório em --out e o worker não devolveu nenhum";
  for (const dir of dirs) {
    if (dir.files.length === 0) return `${dir.dir}: o worker devolveu o diretório vazio`;
    let actual;
    try {
      actual = hashTree(join(scratch, dir.dir));
    } catch (error) {
      return `${dir.dir}: ${error instanceof Error ? error.message : String(error)}`;
    }
    const problems = diffTree(dir.files, actual);
    if (problems.length > 0) return `${dir.dir}: manifesto não bate (${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; +${problems.length - 3}` : ""})`;
    const stale = input.fresh === "" ? undefined : freshProblem(dir, input.fresh, manifest.startedMs);
    if (stale !== undefined) return `${dir.dir}: ${stale}`;
  }
  return undefined;
}

/**
 * Promove os diretórios já validados: staging ao lado (`<dir>.hades-in-<id>`), depois o antigo sai de cena por rename
 * (`.hades-old-<id>`) e só então é removido. Falha em qualquer ponto devolve os anteriores ao lugar.
 */
function promoteDirs(scratch: string, dirs: readonly ManifestDir[], id: string): string | undefined {
  const staged: { dir: string; staging: string }[] = [];
  const undoStaging = (): void => { for (const { staging } of staged) rmSync(staging, { recursive: true, force: true }); };
  try {
    for (const { dir } of dirs) {
      const staging = `${dir}.hades-in-${id}`;
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(dirname(dir), { recursive: true });
      renameSync(join(scratch, dir), staging);
      staged.push({ dir, staging });
    }
  } catch (error) {
    undoStaging();
    return `staging ao lado de ${dirs[staged.length]?.dir ?? "?"} falhou: ${error instanceof Error ? error.message : String(error)}`;
  }
  const swapped: { dir: string; old: string | undefined }[] = [];
  try {
    for (const { dir, staging } of staged) {
      const old = existsSync(dir) ? `${dir}.hades-old-${id}` : undefined;
      if (old !== undefined) renameSync(dir, old);
      swapped.push({ dir, old });
      renameSync(staging, dir);
    }
  } catch (error) {
    for (const { dir, old } of swapped.reverse()) {
      if (old === undefined) continue;
      rmSync(dir, { recursive: true, force: true });
      renameSync(old, dir);
    }
    undoStaging();
    return `promoção falhou: ${error instanceof Error ? error.message : String(error)}`;
  }
  for (const { old } of swapped) if (old !== undefined) rmSync(old, { recursive: true, force: true });
  return undefined;
}

/**
 * Traz o que `--out` declarou. Arquivo: como antes. Diretório (só com o job em rc 0): tar para uma pasta de passagem,
 * manifesto do worker conferido e `--fresh` checado antes de qualquer rename. undefined = tudo chegou; senão o motivo
 * (o que estava no lugar fica intocado).
 */
async function fetchOut(input: RemoteJobInput, id: string, jobOk: boolean, ssh: SshCommand, warn: (message: string) => void): Promise<string | undefined> {
  mkdirSync(input.clone, { recursive: true });
  const scratch = mkdtempSync(join(input.clone, ".hades-out-"));
  try {
    const failed = await receiveTar(input, id, jobOk, ssh, scratch);
    if (failed !== undefined) return failed;
    const manifest = jobOk ? readManifest(scratch) : undefined;
    const dirs = manifest?.dirs.filter((d) => input.out.includes(d.dir)) ?? [];
    if (jobOk) {
      if (manifest === undefined && input.fresh !== "") return "--fresh sem manifesto do worker";
      const bad = manifest === undefined ? undefined : checkDirs(input, scratch, manifest);
      if (bad !== undefined) return bad;
    }
    const files: string[] = [];
    const missing: string[] = [];
    for (const file of input.out) {
      if (dirs.some((d) => d.dir === file)) continue;
      try {
        // lstat: link simbólico no pacote não vale como arquivo declarado; diretório só passa pelo manifesto
        if (!lstatSync(join(scratch, file)).isFile()) throw new Error("não é arquivo");
        files.push(file);
      } catch {
        missing.push(file);
      }
    }
    // job que falhou: o rc já conta a história, e diretório de build nem viaja (o que não voltou não é erro novo)
    if (jobOk && missing.length > 0) {
      for (const file of missing) warn(`--out: ${file} não voltou do worker`);
      return `${missing.length} item(ns) de --out não voltaram`;
    }
    const promoted = promoteDirs(scratch, dirs, id);
    if (promoted !== undefined) return promoted;
    for (const file of files) {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.hades-out.${process.pid}`;
      copyFileSync(join(scratch, file), tmp);
      renameSync(tmp, file);
    }
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export type { WarmState };
