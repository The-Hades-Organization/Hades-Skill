// Projeto ativo e worktrees dos agentes: o que o hades agent pede ao perfil (project_*), ao catálogo de qualidade
// (quality_block/phase_quality) e à preparação de uma worktree (prep_worktree).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDir, readText } from "./fs.ts";
import { expandHome } from "./agent-registry.ts";
import { out, warn } from "./output.ts";
import { getField, loadProfile, pathValue, refPath, type JsonObject } from "./profile.ts";
import { packOf, resolveProject, type Resolution } from "./project.ts";
import { run } from "./proc.ts";
import { inject } from "./quality.ts";
import { configValue, type WorkEnv } from "./work.ts";

/** Sai com este código sem mensagem do `hades:` (a mensagem já vem pronta, como no project_need do lib.sh). */
export class ExitWith extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "ExitWith";
    this.code = code;
  }
}

export interface ProjectEnv {
  resolution: Resolution;
  profile: JsonObject;
  /** project_get <campo> [<padrão>]: texto do campo, o padrão se ausente, undefined se não há nenhum dos dois. */
  get(field: string, fallback?: string): string | undefined;
  /** project_ref <nome>: referência refs.<nome> do perfil, se existir o arquivo. */
  ref(name: string): string | undefined;
  /** project_pack: pasta do pacote do projeto ativo. */
  pack(): string | undefined;
  value(field: string): unknown;
}

export function projectEnv(work: WorkEnv, cwd: string = process.cwd()): ProjectEnv {
  const resolution: Resolution = work.skillScope
    ? { project: null, profile: null, repo: null, root: null, packs: "", code: 0, message: "" }
    : resolveProject(work.repoTop || cwd);
  const profile = loadProfile(resolution);
  return {
    resolution,
    profile,
    get: (field, fallback) => getField(profile, field, fallback),
    ref: (name) => refPath(resolution, name),
    pack: () => packOf(resolution),
    value: (field) => pathValue(profile, field),
  };
}

/** Os comandos do loop que dependem do projeto recusam sem perfil (sai 3, a mensagem aponta /hades project init). */
export function projectNeed(project: ProjectEnv): void {
  if (project.resolution.profile) return;
  throw new ExitWith(3, project.resolution.message || "hades: repositório sem perfil — rode /hades project init");
}

/** Bloco do catálogo de qualidade da fase, sem as quebras de linha finais; vazio se nenhuma regra está ligada. */
export function qualityBlock(phase: string, dir: string): string {
  try {
    return inject(phase, dir).replace(/\n+$/, "");
  } catch (error) {
    warn(`hades: catálogo de qualidade ilegível, seguindo sem ele: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

/** Acrescenta o bloco do catálogo de qualidade ao arquivo, se houver regra ligada. */
export function appendQuality(file: string, phase: string, dir: string): void {
  const block = qualityBlock(phase, dir);
  if (block) appendFileSync(file, `\n${block}\n`);
}

const PHASE_BY_NAME: [RegExp, string][] = [[/review/, "review"], [/inbox/, "inbox"], [/deliver/, "deliver"], [/^impl$/, "deliver"]];

/** O quality.md da fase na worktree (vazio se nenhuma regra está ligada; o arquivo antigo some). */
export function phaseQuality(work: WorkEnv, worktree: string, phaseName: string): string {
  const phase = PHASE_BY_NAME.find(([pattern]) => pattern.test(phaseName))?.[1] ?? "brief";
  const block = qualityBlock(phase, worktree);
  const file = join(worktree, work.reports, "quality.md");
  if (block) {
    writeFileSync(file, `${block}\n`);
    return file;
  }
  rmSync(file, { force: true });
  return "";
}

/** `run`: no dry-run só mostra o comando; senão executa com a saída do processo visível. */
export function step(dry: boolean, command: string, args: string[], options: { cwd?: string; quiet?: boolean } = {}): number {
  if (dry) {
    out(`  [dry-run] ${[command, ...args].join(" ")}`);
    return 0;
  }
  const result = spawnSync(command, args, { cwd: options.cwd, stdio: options.quiet ? ["ignore", "ignore", "ignore"] : "inherit" });
  return result.status ?? 1;
}

/** Deps por symlink, hooks, sem upstream e a pasta de relatórios fora do git. */
export function prepWorktree(work: WorkEnv, worktree: string, dry: boolean, home: string): void {
  const nodeModules = expandHome(configValue("HADES_ORCH_NODE_MODULES", "") || join(work.mainClone, "node_modules"), home);
  const link = join(worktree, "node_modules");
  if (!existsSync(link)) {
    if (dry) out(`  [dry-run] ln -s ${nodeModules} ${link}`);
    else {
      try {
        symlinkSync(nodeModules, link);
      } catch (error) {
        warn(`hades: ln -s ${nodeModules} ${link} falhou: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (!dry && isDir(join(worktree, ".husky"))) run("npx", ["husky"], { cwd: worktree });
  if (dry) out(`  [dry-run] git -C ${worktree} branch --unset-upstream`);
  else run("git", ["-C", worktree, "branch", "--unset-upstream"]);
  if (dry) out(`  [dry-run] mkdir -p ${join(worktree, work.reports)}`);
  else mkdirSync(join(worktree, work.reports), { recursive: true });
  if (dry) return;
  excludeReports(work, worktree);
}

/** A pasta de relatórios nunca entra no git da worktree (info/exclude). */
export function excludeReports(work: WorkEnv, worktree: string): void {
  const exclude = run("git", ["-C", worktree, "rev-parse", "--git-path", "info/exclude"]).stdout.trim();
  if (!exclude) return;
  const line = `${work.reports}/`;
  if (!(readText(exclude) ?? "").split("\n").includes(line)) appendFileSync(exclude, `${line}\n`);
}
