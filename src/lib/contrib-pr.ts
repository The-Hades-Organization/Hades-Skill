// Abre a PR da contribuição: clona o repositório da skill (pelo gh, que traz a credencial), aplica só o núcleo numa branch,
// empurra e abre a PR. Só é chamado depois da confirmação explícita do usuário.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./proc.ts";

const NETWORK_TIMEOUT_MS = 120_000;
const BRANCH_PREFIX = "contrib/";

export interface PrPlan {
  repo: string;
  defaultBranch: string;
  branch: string;
  title: string;
  body: string;
  patch: string;
}

export const branchOf = (slug: string): string => `${BRANCH_PREFIX}${slug}`;

function step(command: string, args: string[], cwd: string | undefined, what: string): string {
  const r = run(command, args, { cwd, timeoutMs: NETWORK_TIMEOUT_MS });
  if (r.status !== 0) throw new Error(`${what} falhou${r.timedOut ? " (timeout)" : ""}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`);
  return r.stdout.trim();
}

/** Devolve o endereço da PR. A pasta temporária some no fim, deu certo ou não. */
export function openPr(plan: PrPlan): string {
  const tmp = mkdtempSync(join(tmpdir(), "hades-contrib-"));
  try {
    const clone = join(tmp, "repo");
    const patch = join(tmp, "contrib.patch");
    const bodyFile = join(tmp, "body.md");
    mkdirSync(tmp, { recursive: true });
    writeFileSync(patch, plan.patch);
    writeFileSync(bodyFile, plan.body);
    step("gh", ["repo", "clone", plan.repo, clone], undefined, "clonar o repositório da skill");
    step("git", ["checkout", "-q", "-b", plan.branch], clone, "criar a branch");
    step("git", ["apply", "--3way", patch], clone, "aplicar o diff do núcleo sobre a branch padrão");
    step("git", ["add", "-A"], clone, "preparar o commit");
    step("git", ["commit", "-q", "-m", plan.title], clone, "commitar");
    step("git", ["push", "-q", "origin", `HEAD:refs/heads/${plan.branch}`], clone, "empurrar a branch");
    return step("gh", ["pr", "create", "--repo", plan.repo, "--base", plan.defaultBranch, "--head", plan.branch, "--title", plan.title, "--body-file", bodyFile], clone, "abrir a PR");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
