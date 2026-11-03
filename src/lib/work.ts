// Ambiente de trabalho do loop (lib.sh: skill_scope, set_work_dirs, reg_get/reg_set, delivery_set, open_questions).
// Mesmas derivações do bash: repositório → SLUG → ~/.claude/hades/work/<slug> (ou HADES_WORK_ROOT / work-root).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveConfig } from "./config.ts";
import { firstLine, isFile, listDir, readText } from "./fs.ts";
import { hadesHome, skillRoot } from "./paths.ts";
import { die, warn } from "./output.ts";
import { run } from "./proc.ts";

export const DEFAULT_REPORTS = ".design-sync-reports";

export interface WorkEnv {
  skillScope: boolean;
  repoTop: string;
  mainClone: string;
  slug: string;
  repoName: string;
  work: string;
  locks: string;
  state: string;
  orch: string;
  skillOrch: string;
  reports: string;
}

export interface WorkOptions {
  /** HADES_LIB_SKILL_OK: o script aceita a raiz própria _skill quando estiver na skill. */
  skillOk?: boolean;
  /** HADES_LIB_SKILL_FORCE: usa _skill de qualquer diretório. */
  skillForce?: boolean;
  /** HADES_LIB_AGENT: usa _skill se o agente está lá, e traz para lá a unidade skill de um skill-new antigo. */
  agent?: string;
  cwd?: string;
}

function git(dir: string, ...args: string[]): string {
  return run("git", ["-C", dir, ...args]).stdout.trim();
}

function workRoot(env: NodeJS.ProcessEnv): string {
  return env.HADES_WORK_ROOT || firstLine(join(hadesHome(), "work-root")) || join(hadesHome(), "work");
}

/** "estou na skill": diretório sem origin (skill, unidade ou fora de git) ou o mesmo git da skill. */
export function inSkillScope(cwd: string): boolean {
  const top = git(cwd, "rev-parse", "--show-toplevel");
  if (!top) return true;
  if (!git(top, "config", "--get", "remote.origin.url")) return true;
  const common = git(top, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const here = git(skillRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common !== "" && common === here;
}

function workDirs(slug: string, env: NodeJS.ProcessEnv): Pick<WorkEnv, "work" | "locks" | "state" | "orch" | "reports"> {
  const work = join(workRoot(env), slug);
  const orch = join(work, "orchestration");
  for (const dir of [join(work, "locks"), join(work, "state"), join(orch, "agents"), join(orch, "consolidations")]) {
    mkdirSync(dir, { recursive: true });
  }
  return { work, locks: join(work, "locks"), state: join(work, "state"), orch, reports: env.HADES_ORCH_REPORTS_DIR || DEFAULT_REPORTS };
}

/** `owner__repo` de uma url de remote, como o awk do lib.sh. */
export function slugOfRemote(url: string): string {
  const fields = url.replace(/\.git$/, "").split(/[/:]/);
  return `${fields[fields.length - 2] ?? ""}__${fields[fields.length - 1] ?? ""}`;
}

function skillEnv(env: NodeJS.ProcessEnv): WorkEnv {
  return {
    skillScope: true, repoTop: skillRoot, mainClone: skillRoot, slug: "_skill", repoName: "_skill",
    skillOrch: join(workRoot(env), "_skill", "orchestration"), ...workDirs("_skill", env),
  };
}

export function loadWorkEnv(options: WorkOptions = {}, env: NodeJS.ProcessEnv = process.env): WorkEnv {
  const cwd = options.cwd ?? process.cwd();
  const skillOrch = join(workRoot(env), "_skill", "orchestration");
  const agentInSkill = options.agent !== undefined && isFile(join(skillOrch, "agents", `${options.agent}.json`));
  if (options.skillOk && (options.skillForce || agentInSkill || inSkillScope(cwd))) return skillEnv(env);

  const repoTop = git(cwd, "rev-parse", "--show-toplevel");
  if (!repoTop) return die("rode dentro de um clone ou worktree do repositório");
  const mainClone = (git(repoTop, "worktree", "list", "--porcelain").split("\n")[0] ?? "").replace(/^worktree /, "");
  const url = git(repoTop, "config", "--get", "remote.origin.url");
  if (!url) return die("clone sem remote.origin.url");
  const slug = slugOfRemote(url);
  const found: WorkEnv = { skillScope: false, repoTop, mainClone, slug, repoName: slug.slice(slug.indexOf("__") + 2), skillOrch, ...workDirs(slug, env) };
  return moveSkillUnit(found, options, env);
}

/** Unidade skill que um skill-new antigo gravou no registro do projeto passa para o registro único _skill. */
function moveSkillUnit(found: WorkEnv, options: WorkOptions, env: NodeJS.ProcessEnv): WorkEnv {
  if (!options.skillOk || !options.agent) return found;
  const file = join(found.orch, "agents", `${options.agent}.json`);
  if (readJson(file)?.mode !== "skill") return found;
  mkdirSync(join(found.skillOrch, "agents"), { recursive: true });
  renameSync(file, join(found.skillOrch, "agents", `${options.agent}.json`));
  warn(`hades: unidade ${options.agent} movida do registro do projeto para o registro único _skill`);
  return skillEnv(env);
}

export type Json = Record<string, unknown>;

export function readJson(file: string): Json | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    const data: unknown = JSON.parse(text);
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Json) : undefined;
  } catch {
    return undefined;
  }
}

/** Grava como o `jq … > f.tmp && mv` do bash: o leitor nunca vê arquivo pela metade. */
export function writeJsonAtomic(file: string, data: unknown): void {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

export function agentFile(work: WorkEnv, name: string): string {
  return join(work.orch, "agents", `${name}.json`);
}

/** `reg_get`: campo do registro de um agente, vazio se o registro ou o campo não existe. */
export function regGet(work: WorkEnv, name: string, field: string): string {
  const value = readJson(agentFile(work, name))?.[field];
  if (value === undefined || value === null || value === false) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function regSet(work: WorkEnv, name: string, patch: Json): void {
  const file = agentFile(work, name);
  writeJsonAtomic(file, { ...(readJson(file) ?? {}), ...patch });
}

/** Perguntas abertas em <worktree>/<reports>/questions.md: `## Qn` sem "(respondida)" nem `## Resposta do dono` depois. */
export function openQuestions(worktree: string, reports: string): number {
  const text = readText(join(worktree, reports, "questions.md"));
  if (text === undefined) return 0;
  const open: boolean[] = [];
  for (const line of text.split("\n")) {
    if (/^## Q[0-9]+/.test(line)) open.push(!line.includes("(respondida)"));
    else if (line.startsWith("## Resposta do dono") && open.length) open[open.length - 1] = false;
  }
  return open.filter(Boolean).length;
}

export function countQuestions(worktree: string, reports: string): number {
  return (readText(join(worktree, reports, "questions.md")) ?? "").split("\n").filter((l) => /^## Q[0-9]/.test(l)).length;
}

/** Valores efetivos das Configurações (HADES_ORCH_*, HADES_CTX_CAP_*): variável > config.env > padrão. */
export function configValue(key: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const instance = firstLine(join(hadesHome(), "instance"));
  const dir = instance && isFile(join(instance, "config.sh")) ? instance : join(skillRoot, "kit");
  return env[key] ?? effectiveConfig(dir, env).get(key) ?? fallback;
}

/** Registros dos agentes: os do ambiente e, fora da skill, também as unidades do registro único _skill. */
export function agentFiles(work: WorkEnv): string[] {
  const dirs = [join(work.orch, "agents"), ...(work.skillScope ? [] : [join(work.skillOrch, "agents")])];
  return dirs.flatMap((dir) => listDir(dir).filter((n) => n.endsWith(".json")).map((n) => join(dir, n)));
}
