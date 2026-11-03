// `hades agent skill-new|skill-clean`: unidades de evolução da própria skill (worktree skill/<u> no git local da skill).
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { startOrOwnerCommand } from "./agent-autonomy.ts";
import { appendQuality, excludeReports, step } from "../lib/agent-project.ts";
import { isoNow, orchestratorField, regReplace, regUpdate, roleCard, startCommand } from "../lib/agent-registry.ts";
import { need } from "../lib/deps.ts";
import { isDir, isFile, readText } from "../lib/fs.ts";
import { agentActiveIn, herdr, listPanes, paneFrom, paneInCwd } from "../lib/herdr.ts";
import { die, out, warn } from "../lib/output.ts";
import { hadesHome, skillRoot } from "../lib/paths.ts";
import { run, which } from "../lib/proc.ts";
import { agentFiles, configValue, readJson, regGet, type WorkEnv } from "../lib/work.ts";

const UNIT_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
const UNIT_ROLES = ["impl", "consolidate"];
/** O que a instalação descartável e o `hades skill-release check` deixam (o `wt` é o worktree que a prova de install cria quando a skill não tem remote) em _data/<u>: o skill-clean apaga sem pedir --force-data. */
export const DISPOSABLE_DATA = ["data", "data-rt", "install.log", "check.log", "panel.log", "wt", "clone"];
/** Provas repetidas na mesma unidade numeram os logs: install2.log, check3.log. */
const NUMBERED_PROOF_LOG = /^(?:install|check)\d+\.log$/;
export const isDisposableData = (name: string): boolean => DISPOSABLE_DATA.includes(name) || NUMBERED_PROOF_LOG.test(name);
const ARCHIVED_FILES = [/^brief\.md$/, /^report.*\.md$/, /^questions\.md$/, /^handoff\.md$/];
const ARCHIVED_EXTENSIONS = /\.(md|png|jpe?g|webp|gif|patch|diff|tsv|json|txt)$/i;
/** `find -size -2M`: o tamanho arredondado para cima em MiB tem de ser menor que 2, ou seja, até 1 MiB. */
const ARCHIVED_MAX_BYTES = 1024 * 1024;
const PORT_DIGITS = /\b[0-9]{4,5}\b/g;
const GIT_TIMEOUT_MS = 120_000;

const skillDev = (): string => join(hadesHome(), "skill-dev");

/** Git local da skill (a worktree em que o script roda pode ser uma das unidades). */
function skillRepo(): string {
  const common = run("git", ["-C", skillRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.status !== 0) die(`${skillRoot} não é um git`);
  return join(common.stdout.trim(), "..");
}

function git(repo: string, ...args: string[]): ReturnType<typeof run> {
  return run("git", ["-C", repo, ...args], { timeoutMs: GIT_TIMEOUT_MS });
}

/** "<branch>\t<worktree>" das unidades skill/*. */
function skillWorktrees(repo: string): { branch: string; worktree: string }[] {
  const units: { branch: string; worktree: string }[] = [];
  let current = "";
  for (const line of git(repo, "worktree", "list", "--porcelain").stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/skill/")) units.push({ branch: line.slice("branch refs/heads/".length), worktree: current });
  }
  return units;
}

/** Próxima porta livre da faixa: fora dos briefs, dos registros skill ativos (arquivada libera) e do ss. */
function skillPort(work: WorkEnv): number {
  const used = new Set<string>();
  const dev = skillDev();
  const units = isDir(dev) ? readdirSync(dev) : [];
  for (const unit of units) {
    for (const found of readText(join(dev, unit, work.reports, "brief.md"))?.match(PORT_DIGITS) ?? []) used.add(found);
  }
  for (const file of agentFiles(work)) {
    const record = readJson(file);
    if (record?.mode === "skill" && record.state !== "archived" && record.port !== undefined && record.port !== null) used.add(String(record.port));
  }
  if (which("ss")) for (const match of run("ss", ["-ltn"]).stdout.matchAll(/:([0-9]{4,5})\b/g)) used.add(match[1] ?? "");
  else warn("hades: ss ausente: as portas em uso na máquina não foram conferidas (instale o iproute2)");
  const low = Number(configValue("HADES_SKILL_PORT_MIN", "21270"));
  const high = Number(configValue("HADES_SKILL_PORT_MAX", "21289"));
  if (!Number.isInteger(low) || !Number.isInteger(high)) die("HADES_SKILL_PORT_MIN e HADES_SKILL_PORT_MAX: números");
  for (let port = low; port <= high; port++) if (!used.has(String(port))) return port;
  return die(`faixa de portas de teste ${low}–${high} esgotada (arquive unidades com skill-clean, amplie HADES_SKILL_PORT_MIN/MAX ou passe --port N)`);
}

function optionValue(args: string[], index: number): string {
  return args[index + 1] ?? die(`faltou o valor de ${args[index]}`);
}

export function skillNew(args: string[], work: WorkEnv): number {
  const unit = args[0] ?? die("faltou unidade");
  let base = "main";
  let role = "impl";
  let port = "";
  let dry = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--base") base = optionValue(args, i++);
    else if (arg === "--role") role = optionValue(args, i++);
    else if (arg === "--port") port = optionValue(args, i++);
    else if (arg === "--dry-run") dry = true;
    else die(`opção desconhecida: ${arg}`);
  }
  if (!UNIT_PATTERN.test(unit)) die("unidade curta: minúsculas, números e hífen");
  if (!UNIT_ROLES.includes(role)) die("--role impl|consolidate");
  if (port && !/^[0-9]+$/.test(port)) die(`--port: número, não '${port}'`);
  need("git");
  // o núcleo pode ter remote (o repo dele): nada aqui faz push, e a branch da unidade nem consegue (pushRemote inexistente)
  const repo = skillRepo();
  const remotes = git(repo, "remote").stdout.split("\n").filter(Boolean).join(",");
  if (git(repo, "rev-parse", "--verify", "-q", `${base}^{commit}`).status !== 0) die(`ref ${base} não existe em ${repo}`);
  const branch = `skill/${unit}`;
  const worktree = join(skillDev(), unit);
  if (git(repo, "show-ref", "--verify", "-q", `refs/heads/${branch}`).status === 0) die(`branch ${branch} já existe`);
  if (existsSync(worktree)) die(`${worktree} já existe`);
  if (isFile(join(work.orch, "agents", `${unit}.json`)) && regGet(work, unit, "state") !== "archived") die(`agente ${unit} já registrado (hades agent list --all)`);
  const baseSha = git(repo, "rev-parse", "--short", base).stdout.trim();
  const unitPort = port ? Number(port) : skillPort(work);
  step(dry, "git", ["-C", repo, "worktree", "add", "-q", "-b", branch, worktree, base]);
  if (remotes) {
    step(dry, "git", ["-C", repo, "config", `branch.${branch}.pushRemote`, "no_push"]);
    out(`  remote(s) ${remotes} no git da skill: push nunca é automático (branch.${branch}.pushRemote=no_push); publicar é da consolidação`);
  }
  if (dry) out(`  [dry-run] mkdir -p ${join(worktree, work.reports)}`);
  else {
    mkdirSync(join(worktree, work.reports), { recursive: true });
    excludeReports(work, worktree);
  }
  const brief = join(worktree, work.reports, "brief.md");
  if (dry) out(`  [dry-run] brief ${brief} (modelo brief-skill-template.md)`);
  else if (isFile(brief)) out(`  brief existente mantido: ${brief}`);
  else writeSkillBrief(work, { unit, worktree, branch, base, baseSha, port: unitPort, role, brief });
  if (!dry) need("herdr");
  let created = "{}";
  if (!dry) {
    const result = herdr(["workspace", "create", "--cwd", worktree, "--label", `hd-${unit}`, "--no-focus"]);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) die(`herdr workspace create falhou: ${result.stdout.replace(/\n+$/, "")}`);
    created = result.stdout;
  }
  let pane = paneFrom(created);
  if (!pane && !dry) pane = paneInCwd(herdr(["pane", "list"]).stdout, worktree);
  if (!dry) {
    regReplace(work, unit, { name: unit, mode: "skill", role, phase: role, card: "", key: "", branch, base, worktree, pane, lock: "", port: unitPort, state: "allocated", createdAt: isoNow(), ...orchestratorField(pane) });
  }
  out("");
  out(`unidade ${unit}: worktree ${worktree} · branch ${branch} (base ${base} em ${baseSha}) · porta de teste ${unitPort} · painel ${pane || "?"}`);
  out(`1. complete o brief (${brief}): Item, Docs e Prova`);
  const start = dry ? { byOrchestrator: false, command: startCommand(unit, pane, role) } : startOrOwnerCommand(unit, pane, role);
  if (start.byOrchestrator) {
    out(`2. o orquestrador inicia (auto-alocação: HADES_ORCH_AUTO_START + regra allow), como Bash, sem \`! \` — papel ${role}:`);
    out(`   ${start.command}`);
  }
  else {
    out(`2. o dono inicia — papel ${role}:`);
    out(`   ${start.command}`);
  }
  out(`3. depois: hades agent adopt ${unit} && hades agent prompt ${unit}`);
  return 0;
}

function writeSkillBrief(work: WorkEnv, b: { unit: string; worktree: string; branch: string; base: string; baseSha: string; port: number; role: string; brief: string }): void {
  const template = readText(join(skillRoot, "reference", "loop", "brief-skill-template.md")) ?? die("modelo do brief ausente: reference/loop/brief-skill-template.md");
  const substitutions: [string, string][] = [
    ["{{UNIDADE}}", b.unit], ["{{WORKTREE}}", b.worktree], ["{{BRANCH}}", b.branch], ["{{BASE}}", b.base], ["{{BASE_SHA}}", b.baseSha],
    ["{{PORTA}}", String(b.port)], ["{{PAPEL}}", b.role], ["{{CARTAO}}", roleCard(skillRoot, b.role)],
    ["{{CONTRATO}}", join(skillRoot, "reference", "loop", "skill-dev-contract.md")], ["{{REPORTS}}", work.reports],
  ];
  let text = template;
  for (const [token, value] of substitutions) text = text.replaceAll(token, value);
  mkdirSync(join(b.worktree, work.reports), { recursive: true });
  writeFileSync(b.brief, text);
  appendQuality(b.brief, "brief", skillRoot);
  out(`  brief: ${b.brief} (preencha Item, Docs e Prova antes do prompt)`);
}

/** Registro de um agente da unidade "recém-criada": a ponta da branch ainda é a do primeiro registro do reflog. */
function freshBranch(repo: string, branch: string): boolean {
  const tip = git(repo, "rev-parse", branch).stdout.trim();
  const reflog = git(repo, "reflog", "show", "--format=%H", branch).stdout.trim();
  if (!reflog) return true;
  return tip === (reflog.split("\n").at(-1) ?? "");
}

function mergedUnits(repo: string, work: WorkEnv): string[] {
  const units: string[] = [];
  for (const { branch } of skillWorktrees(repo)) {
    if (freshBranch(repo, branch)) {
      const states = agentFiles(work).sort().map((f) => readJson(f)).filter((r) => r?.branch === branch).map((r) => String(r?.state ?? "allocated"));
      const state = states[0] ?? "done";
      if (state !== "done" && state !== "archived") {
        out(`== ${branch.slice("skill/".length)}: pulada pelo --merged (sem commit próprio, registro ${state}; peça pelo nome para arquivar)`);
        continue;
      }
    }
    units.push(branch.slice("skill/".length));
  }
  return units;
}

/** Arquivos que o skill-clean preserva de <worktree>/<reports> em _arquivo/. */
function archiveReports(reportsDir: string, archive: string): void {
  mkdirSync(archive, { recursive: true });
  const top = readdirSync(reportsDir).sort();
  for (const name of top) {
    const file = join(reportsDir, name);
    if (ARCHIVED_FILES.some((p) => p.test(name)) && isFile(file)) preserve(file, archive);
  }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (isDir(path)) walk(path);
      else if (isFile(path) && ARCHIVED_EXTENSIONS.test(entry) && statSync(path).size <= ARCHIVED_MAX_BYTES) preserve(path, archive);
    }
  };
  walk(reportsDir);
}

function preserve(file: string, archive: string): void {
  const target = join(archive, basename(file));
  const stat = statSync(file);
  copyFileSync(file, target);
  utimesSync(target, stat.atime, stat.mtime);
}

function closeWorkspaces(worktree: string, dry: boolean): void {
  const byWorkspace = new Map<string, Record<string, unknown>[]>();
  for (const pane of listPanes()) {
    const id = String(pane.workspace_id ?? "");
    byWorkspace.set(id, [...(byWorkspace.get(id) ?? []), pane]);
  }
  for (const id of [...byWorkspace.keys()].sort()) {
    const group = byWorkspace.get(id) ?? [];
    if (!id || !group.every((p) => String(p.cwd ?? "") === worktree || String(p.foreground_cwd ?? "") === worktree)) continue;
    out(`  fecha workspace herdr ${id}`);
    if (!dry) herdr(["workspace", "close", id], { showStderr: true });
  }
}

export function skillClean(args: string[], work: WorkEnv): number {
  const units: string[] = [];
  let merged = false;
  let forceData = false;
  let dry = false;
  for (const arg of args) {
    if (arg === "--merged") merged = true;
    else if (arg === "--force-data") forceData = true;
    else if (arg === "--dry-run") dry = true;
    else if (arg.startsWith("-")) die(`opção: ${arg}`);
    else units.push(arg);
  }
  if (!merged && units.length === 0) die("skill-clean <unidade>… | --merged");
  need("git");
  const repo = skillRepo();
  const worktrees = skillWorktrees(repo);
  // --force-data vale só para o que o dono nomeou: as unidades que o --merged pega são conferidas como sempre
  const named = new Set(units);
  if (merged) units.push(...mergedUnits(repo, work));
  for (const arg of units) cleanUnit(arg, { repo, worktrees, work, forceData: forceData && named.has(arg), dry });
  return 0;
}

interface CleanContext {
  repo: string;
  worktrees: { branch: string; worktree: string }[];
  work: WorkEnv;
  forceData: boolean;
  dry: boolean;
}

function cleanUnit(arg: string, ctx: CleanContext): void {
  const { repo, work, dry } = ctx;
  let branch = "";
  let worktree = "";
  // a unidade é o sufixo da branch; o nome da pasta pode diferir (_onda1 ↔ skill/onda1), aceita os dois
  const found = ctx.worktrees.find((w) => w.branch.slice("skill/".length) === arg || basename(w.worktree) === arg);
  if (found) ({ branch, worktree } = found);
  else if (git(repo, "show-ref", "--verify", "-q", `refs/heads/skill/${arg}`).status === 0) branch = `skill/${arg}`;
  const unit = branch.slice("skill/".length) || arg;
  out(`== ${arg} (branch ${branch || "—"} · worktree ${worktree || "—"})`);
  let why = "";
  if (branch) {
    if (git(repo, "merge-base", "--is-ancestor", branch, "main").status !== 0) why = `branch ${branch} fora da main`;
    if (!why && worktree && isDir(worktree)) {
      if (git(worktree, "status", "--porcelain", "--untracked-files=no").stdout.trim()) why = "worktree com mudança rastreada";
      const untracked = git(worktree, "status", "--porcelain").stdout.split("\n").filter((l) => l.startsWith("??")).map((l) => l.slice(3));
      if (!why && untracked.length > 0) why = `worktree com arquivo novo fora do git: ${untracked.join(" ")} (commite ou apague)`;
      if (!why && agentActiveIn(worktree)) why = "agente ativo no herdr (working/idle)";
    }
  }
  // os artefatos de DISPOSABLE_DATA são das provas; qualquer outra coisa em _data/<u> (export, patch, captura) é trabalho que o rm -rf perderia
  const dataDir = join(skillDev(), "_data", unit);
  const extra = isDir(dataDir) ? readdirSync(dataDir).filter((n) => !isDisposableData(n)).sort() : [];
  if (!why && extra.length > 0 && !ctx.forceData) why = `${dataDir} tem além dos artefatos conhecidos das provas: ${extra.join(" ")} (confira; --force-data apaga mesmo assim)`;
  if (why) {
    out(`  recusado: ${why}`);
    return;
  }
  // workspace herdr cujo único cwd é a worktree; antes de remover a worktree, que muda o cwd do painel
  if (worktree) closeWorkspaces(worktree, dry);
  const archive = join(skillDev(), "_arquivo", basename(worktree || unit));
  if (worktree && isDir(join(worktree, work.reports))) {
    out(`  arquiva ${join(worktree, work.reports)} → ${archive}`);
    if (!dry) archiveReports(join(worktree, work.reports), archive);
  }
  if (worktree && isDir(worktree)) {
    out(`  remove worktree ${worktree}`);
    if (!dry && git(repo, "worktree", "remove", worktree).status !== 0) {
      const forced = git(repo, "worktree", "remove", "--force", worktree);
      if (forced.status !== 0) {
        if (forced.stderr) process.stderr.write(forced.stderr);
        out(`  ✗ não consegui remover ${worktree}`);
        return;
      }
    }
  }
  if (branch) {
    out(`  remove branch ${branch}`);
    step(dry, "git", ["-C", repo, "branch", "-q", "-d", branch]);
  }
  if (isDir(dataDir)) {
    out(`  remove ${dataDir}`);
    if (dry) out(`  [dry-run] rm -rf ${dataDir}`);
    else rmSync(dataDir, { recursive: true, force: true });
  }
  for (const file of agentFiles(work).sort()) {
    const record = readJson(file);
    if (!record) continue;
    if (String(record.branch ?? "null") === (branch || "%") || String(record.worktree ?? "null") === (worktree || "%")) {
      const name = String(record.name ?? "null");
      out(`  registro ${name} → archived`);
      if (!dry) regUpdate(work, name, (r) => ({ ...r, state: "archived", archivedAt: isoNow() }));
    }
  }
}
