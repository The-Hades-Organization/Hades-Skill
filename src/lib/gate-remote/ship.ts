// Envio do código ao worker sem tocar no stash nem no índice do worktree: o estado atual (commitado, não commitado e
// arquivo novo não ignorado) vira um commit pelo índice temporário, e só esse commit viaja (`git push` leva o delta).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSshCommand, type SshCommand } from "./transport.ts";

export const JOB_REF_PREFIX = "refs/hades/jobs";
const SNAPSHOT_IDENTITY = { GIT_AUTHOR_NAME: "hades-gate", GIT_AUTHOR_EMAIL: "hades-gate@localhost", GIT_COMMITTER_NAME: "hades-gate", GIT_COMMITTER_EMAIL: "hades-gate@localhost" };
const PUSH_TIMEOUT_MS = 10 * 60 * 1000;

export class ShipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipError";
  }
}

function git(root: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new ShipError(`git ${args[0]}: ${(r.stderr || r.error?.message || "falhou").trim().split("\n")[0]}`);
  return r.stdout.trim();
}

/**
 * Commit do estado atual do worktree. O índice real, o stash e o HEAD não são tocados: `GIT_INDEX_FILE` aponta para um
 * arquivo temporário, vazio no começo, então `add -A` grava exatamente o que o worktree tem (ignorados ficam de fora).
 * O pai é o HEAD, para o push levar só o que o espelho ainda não viu.
 */
export function snapshotCommit(root: string, jobId: string, base: NodeJS.ProcessEnv = process.env): string {
  const dir = mkdtempSync(join(tmpdir(), "hades-snap-"));
  try {
    const env: NodeJS.ProcessEnv = { ...base, ...SNAPSHOT_IDENTITY, GIT_INDEX_FILE: join(dir, "index") };
    git(root, ["add", "-A"], env);
    const tree = git(root, ["write-tree"], env);
    const head = spawnSync("git", ["-C", root, "rev-parse", "-q", "--verify", "HEAD"], { encoding: "utf8", env: base });
    const parents = head.status === 0 && head.stdout.trim() !== "" ? ["-p", head.stdout.trim()] : [];
    return git(root, ["-c", "commit.gpgsign=false", "commit-tree", tree, ...parents, "-m", `hades gate ${jobId}`], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Linhas do stderr do push que dizem o que o worker recusou; a causa vem antes da última linha (`failed to push some refs`). */
const CAUSE_LINE = /^(remote:|error:|erro:|\s*!\s*\[remote rejected\])/i;
/** Marcas de disco cheio no lado do worker (git em inglês e em português). */
const DISK_FULL = /unpacker error|no space left|out of disk\s?space|não foi possível criar o diretório de objetos|could not create temporary object directory|unable to start object transaction/i;
export const REASON_DISK_FULL = "worker sem disco";
const MAX_CAUSE_LINES = 6;

/** Mensagem do `ShipError` do push: motivo `worker sem disco` quando o stderr mostra disco cheio; senão as linhas de causa, não só a última. */
export function pushFailure(host: string, stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const causes = lines.filter((l) => CAUSE_LINE.test(l));
  const kept = (causes.length > 0 ? causes : lines.slice(-1)).slice(-MAX_CAUSE_LINES);
  const detail = kept.join(" | ");
  const prefix = DISK_FULL.test(stderr) ? `${REASON_DISK_FULL}: push ao espelho de ${host}` : `push ao espelho de ${host}`;
  return `${prefix}: ${detail === "" ? "falhou" : detail}`;
}

/** Leva o commit ao espelho do worker, na ref do job. Sem credencial do `gh`: é SSH direto com a chave do worker. */
export function pushSnapshot(root: string, host: string, mirror: string, sha: string, jobId: string, ssh: SshCommand, base: NodeJS.ProcessEnv = process.env): void {
  const env: NodeJS.ProcessEnv = { ...base, GIT_SSH_COMMAND: gitSshCommand(ssh), GIT_TERMINAL_PROMPT: "0" };
  if (ssh.custom) env.GIT_SSH_VARIANT = "simple";
  const r = spawnSync("git", ["-C", root, "push", "--quiet", "--no-verify", `ssh://${host}${mirror}`, `${sha}:${JOB_REF_PREFIX}/${jobId}`], {
    encoding: "utf8", env, timeout: PUSH_TIMEOUT_MS,
  });
  if (r.status !== 0) throw new ShipError(pushFailure(host, r.stderr || r.error?.message || "falhou"));
}

/** HEAD do worktree no momento do envio: é o que o marcador de "construído" do chamador compara (o commit do envio é sintético). */
export function headSha(root: string): string {
  const r = spawnSync("git", ["-C", root, "rev-parse", "-q", "--verify", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}
