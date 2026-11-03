// Acesso de escrita ao repositório da skill: `gh api repos/<repo>` (permissions.push). Sem gh, sem login ou sem
// permissão é o caminho "sem acesso", nunca um erro.
import type { RunResult } from "./proc.ts";
import { REPO } from "./version-check.ts";

export type GhRun = (command: string, args: string[]) => RunResult;

export type NoAccessReason = "sem-gh" | "sem-login" | "sem-permissao" | "indisponivel" | "repo-invalido";

export type Access =
  | { kind: "push"; repo: string; defaultBranch: string }
  | { kind: "sem-acesso"; repo: string; reason: NoAccessReason };

const NOT_LOGGED_IN = /gh auth login|not logged in|authentication required|HTTP 401/i;
const NOT_FOUND = /HTTP 40[34]|Not Found/i;

export const REASON_TEXT: Record<NoAccessReason, string> = {
  "sem-gh": "o gh não está instalado",
  "sem-login": "o gh não tem login (gh auth login)",
  "sem-permissao": "sua conta não tem permissão de escrita no repositório",
  indisponivel: "não deu para consultar o repositório agora",
  "repo-invalido": "o repositório da skill (HADES_VERSION_CHECK_REPO) não está no formato dono/nome",
};

const none = (repo: string, reason: NoAccessReason): Access => ({ kind: "sem-acesso", repo, reason });

export function detectAccess(repo: string, opts: { hasGh: boolean; run: GhRun }): Access {
  if (!REPO.test(repo)) return none(repo, "repo-invalido");
  if (!opts.hasGh) return none(repo, "sem-gh");
  const r = opts.run("gh", ["api", `repos/${repo}`]);
  if (r.timedOut) return none(repo, "indisponivel");
  if (r.status !== 0) {
    if (NOT_LOGGED_IN.test(r.stderr)) return none(repo, "sem-login");
    return none(repo, NOT_FOUND.test(r.stderr) ? "sem-permissao" : "indisponivel");
  }
  let doc: unknown;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    return none(repo, "indisponivel");
  }
  const body = typeof doc === "object" && doc !== null ? (doc as { default_branch?: unknown; permissions?: unknown }) : {};
  const permissions = typeof body.permissions === "object" && body.permissions !== null ? (body.permissions as { push?: unknown }) : {};
  if (permissions.push !== true) return none(repo, "sem-permissao");
  const branch = typeof body.default_branch === "string" && body.default_branch ? body.default_branch : "main";
  return { kind: "push", repo, defaultBranch: branch };
}
