// Worktree do Hades e o que o install liga nele e no Claude Code: branch hades/local, rerere, hook e slash-command.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sameContent } from "./install-copy.ts";
import { exitWith, mustStep, runStep, say, sayErr } from "./install-io.ts";
import { git } from "./kit.ts";
import { EXIT } from "./output.ts";
import { home, selfCli } from "./paths.ts";
import { getField, loadProfile } from "./profile.ts";
import { resolveProject } from "./project.ts";
import { isFile } from "./fs.ts";

const HADES_BRANCH = "hades/local";
const DEFAULT_BASE = "origin/develop";

const profileField = (dir: string, field: string): string => getField(loadProfile(resolveProject(dir)), field, "") ?? "";

/** O worktree do Hades: HADES_WT, ou o do diretório atual (a saída do git em erro segue ao terminal, como no script). */
export function worktreeOf(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HADES_WT) return env.HADES_WT;
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    sayErr(top.stderr.trimEnd());
    exitWith(top.status);
  }
  return top.stdout.trim();
}

/**
 * O run-hades reseta o worktree para a base: nunca no clone principal. Rodado do clone principal sem HADES_WT, cria
 * <clone>-hades na branch hades/local a partir da base do perfil (branch.base > origin/<flow.base>; origin/develop sem perfil).
 */
export function ensureHadesWorktree(worktree: string, env: NodeJS.ProcessEnv = process.env): string {
  const listing = git(["-C", worktree, "worktree", "list", "--porcelain"]);
  const main = listing.status === 0 ? (/^worktree (.+)$/m.exec(listing.stdout)?.[1] ?? "") : "";
  if (env.SKIP_WORKTREE || worktree !== main) return worktree;
  if (env.HADES_WT) {
    say(`HADES_WT=${worktree} é o clone principal: o Hades precisa de um worktree próprio (rode sem HADES_WT para criar ${worktree}-hades)`);
    exitWith(EXIT.fail);
  }
  const target = `${worktree}-hades`;
  if (!existsSync(target)) {
    const flowBase = profileField(main, "flow.base");
    const base = profileField(main, "branch.base") || (flowBase ? `origin/${flowBase}` : "") || DEFAULT_BASE;
    const branch = base.replace(/^origin\//, "");
    if (runStep("git", ["-C", main, "fetch", "-q", "origin", branch]) !== 0) say(`aviso: fetch de ${branch} falhou; usando a ${base} local`);
    mustStep("git", ["-C", main, "worktree", "add", "-q", "-B", HADES_BRANCH, target, base]);
  }
  say(`worktree do Hades: ${target} (branch ${HADES_BRANCH})`);
  return target;
}

export function enableRerere(worktree: string): void {
  mustStep("git", ["-C", worktree, "config", "rerere.enabled", "true"]);
  mustStep("git", ["-C", worktree, "config", "rerere.autoupdate", "true"]);
}

/** Registra o hook da Hades no settings.json do Claude Code (src/hook.ts pelo Bun; a entrada antiga é trocada sem duplicar). */
export function registerGuardHook(): void {
  const cli = selfCli("guard", "register");
  if (runStep(cli.command, cli.args) !== 0) say("aviso: o hook não foi registrado; registre à mão (reference/cli.md §Hook)");
}

/**
 * Slash-command /hades: versionado na skill (commands/hades.md) e copiado para ~/.claude/commands. Idempotente; arquivo do
 * usuário que diverge não é sobrescrito (avisa).
 */
export function installSlashCommand(skillRoot: string, env: NodeJS.ProcessEnv = process.env): void {
  const source = join(skillRoot, "commands", "hades.md");
  const dir = env.HADES_CLAUDE_COMMANDS || join(home(), ".claude", "commands");
  if (!isFile(source)) return;
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "hades.md");
  if (!existsSync(target)) {
    cpSync(source, target);
    say(`slash-command /hades instalado em ${target}`);
  } else if (!sameContent(source, target)) {
    say(`aviso: ${target} difere do da skill (${source}) e foi mantido; compare e copie à mão se quiser a versão da skill`);
  }
}
