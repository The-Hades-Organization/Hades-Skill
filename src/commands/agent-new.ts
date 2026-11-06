// `hades agent new|adopt|review`: aloca um agente (worktree pelo herdr, lock, entrega no estado, brief) ou registra um que já roda.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { startOrOwnerCommand } from "./agent-autonomy.ts";
import { assertNoNestedWorktrees, callerPane, deliverySet, expandHome, isoNow, orchestratorField, regReplace, roleCard, startCommand } from "../lib/agent-registry.ts";
import { appendQuality, phaseQuality, prepWorktree, projectEnv, projectNeed, step, type ProjectEnv } from "../lib/agent-project.ts";
import { need } from "../lib/deps.ts";
import { isDir, isFile, readText } from "../lib/fs.ts";
import { findAgent, herdr, paneFrom, paneInCwd } from "../lib/herdr.ts";
import { die, out } from "../lib/output.ts";
import { labelsText, prReadyValues, renderPrReady } from "../lib/brief-pr.ts";
import { dataDirOf, installForWorktree } from "../lib/rtk-filters.ts";
import { run } from "../lib/proc.ts";
import { home, skillRoot } from "../lib/paths.ts";
import { agentFiles, configValue, readJson, regGet, writeJsonAtomic, type WorkEnv } from "../lib/work.ts";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
const MODES = ["deliver", "inbox", "consolidate"];
const ROLES = ["spec", "impl", "consolidate"];
const GIT_FETCH_TIMEOUT_MS = 120_000;
const CARD_CREATE_TIMEOUT_MS = 120_000;

function optionValue(args: string[], index: number): string {
  return args[index + 1] ?? die(`faltou o valor de ${args[index]}`);
}

/** Pasta das worktrees dos agentes: HADES_ORCH_WORKTREE_ROOT ou ~/.herdr/worktrees/<repo>. */
function worktreeRoot(work: WorkEnv): string {
  return expandHome(configValue("HADES_ORCH_WORKTREE_ROOT", "") || join(home(), ".herdr", "worktrees", work.repoName), home());
}

function sedFirstPerLine(text: string, token: string, value: string): string {
  return text.split("\n").map((line) => line.replace(token, () => value)).join("\n");
}

/** Filtros do rtk no worktree novo (reference/rtk.md): gera, confia (caminho do dono) e diz o que fez; nunca derruba o agent new. */
function rtkFilters(worktree: string): void {
  const line = installForWorktree(worktree, dataDirOf(), home());
  if (line !== "") out(`  ${line}`);
}

/** Brief da worktree a partir do modelo (write_brief). */
function writeBrief(work: WorkEnv, project: ProjectEnv, w: { name: string; worktree: string; card: string; branch: string; base: string; baseSha: string; lock: string; mode: string; specs: string; pr: string; role: string }): void {
  const file = join(w.worktree, work.reports, "brief.md");
  if (isFile(file)) {
    out(`  brief existente mantido: ${file}`);
    return;
  }
  const prReady = renderPrReady(prReadyValues(labelsText(project.value("pr.labels"))));
  const refs = ["invariants", "deliver", "gates", "review", "spec"].map((n) => project.ref(n)).filter((r): r is string => r !== undefined && isFile(r)).map((r) => `\`${r}\``);
  const title = project.get("card.provider", "none") === "none" ? "[Módulo] Título" : "{{CARD}} - [Módulo] Título";
  const dash = (value: string): string => value || "—";
  const substitutions: [string, string][] = [
    ["{{TITULO}}", title], ["{{AGENTE}}", w.name], ["{{WORKTREE}}", w.worktree], ["{{CARD}}", dash(w.card)], ["{{BRANCH}}", w.branch],
    ["{{BASE}}", w.base], ["{{BASE_SHA}}", w.baseSha], ["{{LOCK}}", w.lock], ["{{MODO}}", w.mode], ["{{SPECS}}", dash(w.specs)],
    ["{{PR}}", dash(w.pr)], ["{{PAPEL}}", w.role || "impl"], ["{{CARTAO}}", roleCard(skillRoot, w.role || "impl")],
    ["{{ESCALATE_WAVES}}", configValue("HADES_ESCALATE_GATE_WAVES", "2") || "2"], ["{{PARK_GATE_MIN}}", configValue("HADES_PARK_GATE_WAIT_MIN", "20") || "20"],
    ["{{REPORTS}}", work.reports], ["{{PR_PRONTA}}", prReady],
    ["{{SPEC_OWNERS}}", dash(configValue("HADES_ORCH_SPEC_OWNERS", ""))],
    ["{{SPEC_REVIEWERS}}", dash(configValue("HADES_ORCH_SPEC_REVIEWERS", ""))],
  ];
  const template = readText(join(skillRoot, "reference", "loop", "brief-template.md")) ?? die("modelo do brief ausente: reference/loop/brief-template.md");
  let text = template;
  for (const [token, value] of substitutions) text = text.replaceAll(token, value);
  text = refs.length > 0 ? sedFirstPerLine(text, "{{REFS}}", refs.join(", ")) : text.split("\n").filter((line) => !line.includes("{{REFS}}")).join("\n");
  writeFileSync(file, text);
  appendQuality(file, "brief", work.repoTop);
  out(`  brief: ${file} (complete Item e Contexto antes do prompt)`);
}

/** O script do pacote que cria o card (card.create do perfil); devolve o ID. */
function cardCreate(project: ProjectEnv, title: string, tags: string, desc: string): string {
  const script = join(project.pack() ?? "", project.get("card.create", "") ?? "");
  if (!isFile(script)) die(`card.create do perfil aponta para ${script}, que não existe`);
  const base = script.slice(script.lastIndexOf("/") + 1);
  const result = spawnSync("bash", [script, title, tags, desc], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: CARD_CREATE_TIMEOUT_MS,
    env: { ...process.env, HADES_ORCH_CLICKUP_ASSIGNEE: process.env.HADES_ORCH_CLICKUP_ASSIGNEE ?? "" },
  });
  if (result.status !== 0) die(`a criação do card falhou (${base})`);
  const id = result.stdout.replace(/\n+$/, "");
  return id || die(`${base} não devolveu o ID do card`);
}

/** Exige o plano aprovado e sem mudança desde a aprovação (Configurações → Exigir plan.md aprovado). */
async function planCheck(work: WorkEnv): Promise<void> {
  if (configValue("HADES_PLAN_REQUIRED", "1") !== "1") return;
  const record = readJson(join(work.orch, "plan.json"));
  if (!record) die("sem plano aprovado: escreva o plan.md (reference/loop/plan-template.md), aprove com o dono e rode hades agent plan-approve <plan.md>");
  const path = String(record.path ?? "");
  const { planSha } = await import("./agent.ts");
  if (!isFile(path) || planSha(readText(path) ?? "") !== String(record.sha ?? "")) die(`o plano ${path} mudou depois da aprovação: aprove de novo com o dono (plan-approve)`);
}

interface NewOptions {
  branch: string; base: string; card: string; newCard: string; tags: string; desc: string; mode: string; pr: string; specs: string;
  resume: string; role: string; dry: boolean;
}

function parseNew(args: string[], base: string): NewOptions {
  const o: NewOptions = { branch: "", base, card: "", newCard: "", tags: "", desc: "", mode: "deliver", pr: "", specs: "", resume: "", role: "", dry: false };
  const withValue: Record<string, keyof NewOptions> = {
    "--branch": "branch", "--base": "base", "--card": "card", "--new-card": "newCard", "--tags": "tags", "--desc": "desc", "--for": "mode",
    "--pr": "pr", "--specs": "specs", "--resume": "resume", "--role": "role",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const field = withValue[arg];
    if (field) {
      (o[field] as string) = optionValue(args, i);
      i++;
    } else if (arg === "--dry-run") o.dry = true;
    else die(`opção desconhecida: ${arg}`);
  }
  return o;
}

export async function newAgent(args: string[], work: WorkEnv): Promise<number> {
  const name = args[0] ?? die("faltou nome do agente");
  const project = projectEnv(work);
  projectNeed(project);
  const cardExample = project.get("card.example", "CARD-N") ?? "CARD-N";
  const cardNew = `${cardExample.replace(/-[^-]*$/, "")}-NOVO`;
  const o = parseNew(args.slice(1), project.get("branch.base", `origin/${project.get("flow.base", "") ?? ""}`) ?? "");
  if (!NAME_PATTERN.test(name)) die("nome curto: minúsculas, números e hífen");
  const registered = join(work.orch, "agents", `${name}.json`);
  if (isFile(registered) && !o.dry) die(`agente ${name} já registrado (status: ${regGet(work, name, "state")})`);
  if (!MODES.includes(o.mode)) die("--for deliver|inbox|consolidate");
  if (o.mode === "inbox" && !o.pr) die("--for inbox pede --pr N");
  if (o.pr && !/^[0-9]+$/.test(o.pr)) die(`--pr: número da PR, não '${o.pr}'`);
  const role = o.role || (o.mode === "consolidate" ? "consolidate" : "impl");
  if (!ROLES.includes(role)) die("--role spec|impl|consolidate");
  if (!o.dry) await planCheck(work);
  let { card, branch } = o;
  if (!o.resume) {
    if (!branch) die(`--branch ${project.get("branch.format", "<branch>")}`);
    if (project.get("card.provider", "none") !== "none") {
      if (!card) {
        if (!o.newCard) die(`card é pré-condição da branch: --card ${cardExample} ou --new-card "<título>" --tags a,b`);
        if (!project.get("card.create") && !o.dry) die(`--new-card: o perfil não declara card.create (script do pacote que cria o card; card.provider: ${project.get("card.provider", "none")})`);
        if (o.dry) {
          card = cardNew;
          out(`  [dry-run] criaria o card "${o.newCard}" (tags ${o.tags})`);
        } else card = cardCreate(project, o.newCard, o.tags, o.desc);
      }
      if (!branch.includes(card) && card !== cardNew) die(`a branch tem de conter o card (${card})`);
    } else if (card || o.newCard) die("--card/--new-card: o perfil não usa card (card.provider none ou ausente)");
  }
  if (!o.dry) need("herdr");
  // 1. worktree pelo herdr (nunca no scratchpad nem no /tmp)
  let worktree: string;
  let created: string;
  if (o.resume) {
    if (!isDir(o.resume)) die(`worktree ${o.resume} não existe`);
    worktree = resolve(o.resume);
    assertNoNestedWorktrees(work, name, worktree);
    branch = run("git", ["-C", worktree, "branch", "--show-current"]).stdout.trim();
    created = o.dry ? "{}" : herdr(["workspace", "create", "--cwd", worktree, "--label", name, "--no-focus"], { showStderr: true }).stdout;
  } else {
    worktree = join(worktreeRoot(work), name);
    if (existsSync(worktree)) die(`${worktree} já existe: use --resume ${worktree}`);
    assertNoNestedWorktrees(work, name, worktree);
    if (run("git", ["-C", work.repoTop, "fetch", "-q", "origin"], { timeoutMs: GIT_FETCH_TIMEOUT_MS }).status !== 0) die("git fetch falhou");
    const workspace = configValue("HADES_ORCH_HERDR_WORKSPACE", "");
    const create = [...(workspace ? ["--workspace", workspace] : []), "--branch", branch, "--base", o.base, "--path", worktree, "--label", name, "--no-focus"];
    if (o.dry) {
      created = "{}";
      out(`  [dry-run] herdr worktree create ${create.join(" ")}`);
    } else {
      const result = herdr(["worktree", "create", ...create], { cwd: work.repoTop });
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.status !== 0) die(`herdr worktree create falhou: ${result.stdout.replace(/\n+$/, "")}`);
      created = result.stdout;
    }
  }
  let pane = paneFrom(created);
  if (!pane && !o.dry) pane = paneInCwd(herdr(["pane", "list"]).stdout, worktree);
  prepWorktree(work, worktree, o.dry, home());
  if (!o.dry) rtkFilters(worktree);
  const shortSha = run("git", ["-C", work.repoTop, "rev-parse", "--short", o.base]).stdout.trim();
  const baseSha = shortSha || "?";
  // 2. lock (protocolo de reference/loop/gates.md §3.1) e entrega no estado
  const key = card || (o.pr ? `pr-${o.pr}` : "") || branch.replaceAll("/", "_");
  const lock = `${o.mode === "inbox" ? `inbox-pr-${o.pr}` : `deliver-${key}`}.lock`;
  const lockDir = join(work.locks, lock);
  if (o.dry) out(`  [dry-run] lock ${lockDir}`);
  else {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "owner"), `agent=${name}\npane=${pane}\nclone=${worktree}\nhost=${hostname()}\npid=${process.pid}\nsince=${isoNow()}\nmode=${o.mode}\n`);
    } catch {
      out(`  lock ${lock} já é de outra sessão:`);
      for (const line of (readText(join(lockDir, "owner")) ?? "").replace(/\n$/, "").split("\n")) if (line !== "") out(`    ${line}`);
      die("lock não se rouba (gates.md §3.1)");
    }
  }
  if (!o.dry) {
    deliverySet(work, key, (d) => {
      const next: Record<string, unknown> = { ...d };
      next.status = next.status === undefined || next.status === null || next.status === "planned" ? "in-progress" : next.status;
      Object.assign(next, { branch, card, agent: name, worktree, since: isoNow(), base: o.base });
      if (o.specs) next.specs = o.specs.split(",");
      if (o.pr) next.pr = Number(o.pr);
      return next;
    });
    regReplace(work, name, {
      name, mode: o.mode, role, phase: role, card, key, branch, base: o.base, worktree, pane, lock, pr: o.pr ? Number(o.pr) : null,
      state: "allocated", createdAt: isoNow(), ...orchestratorField(pane),
    });
  }
  // 3. brief a partir do modelo
  if (!o.dry) writeBrief(work, project, { name, worktree, card, branch, base: o.base, baseSha, lock, mode: o.mode, specs: o.specs, pr: o.pr, role });
  out("");
  out(`agente ${name}: worktree ${worktree} · branch ${branch} · card ${card || "—"} · lock ${lock} · painel ${pane || "?"}`);
  out(`1. complete o brief (${worktree}/${work.reports}/brief.md): Item e Contexto`);
  const start = o.dry ? { byOrchestrator: false, command: startCommand(name, pane, role) } : startOrOwnerCommand(name, pane, role);
  if (start.byOrchestrator) {
    out(`2. o orquestrador inicia (auto-alocação: HADES_ORCH_AUTO_START + regra allow), como Bash, sem \`! \` — papel ${role}:`);
    out(`   ${start.command}`);
  }
  else {
    out(`2. o dono inicia (o classificador recusa quando é o orquestrador) — papel ${role}:`);
    out(`   ${start.command}`);
  }
  out(`3. depois: hades agent prompt ${name}`);
  return 0;
}

/** `grep -oE`: o primeiro trecho de texto que casa com a expressão (POSIX ERE), vazio se nenhum. */
function firstEreMatch(pattern: string, text: string): string {
  const translated = pattern
    .replaceAll("[:alpha:]", "a-zA-Z").replaceAll("[:digit:]", "0-9").replaceAll("[:alnum:]", "a-zA-Z0-9")
    .replaceAll("[:upper:]", "A-Z").replaceAll("[:lower:]", "a-z").replaceAll("[:space:]", "\\s");
  try {
    return new RegExp(translated).exec(text)?.[0] ?? "";
  } catch {
    return die(`card.newIdPattern do perfil não é uma expressão válida: ${pattern}`);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** O lock cujo owner declara `agent=<nome>` (o primeiro, em ordem alfabética), sem o diretório de locks. */
function lockOf(work: WorkEnv, name: string): string {
  const pattern = new RegExp(`^agent=${escapeRegExp(name)}\\b`, "m");
  let names: string[] = [];
  try {
    names = readdirSync(work.locks).filter((n) => n.endsWith(".lock")).sort();
  } catch {
    return "";
  }
  return names.find((n) => pattern.test(readText(join(work.locks, n, "owner")) ?? "")) ?? "";
}

function jqField(value: unknown): string {
  return value === undefined || value === null ? "null" : String(value);
}

/** O `orchestrator` que o registro já tinha: o adopt fora de pane não apaga a ligação. */
const keptOrchestrator = (record: Record<string, unknown>): Record<string, unknown> => (record.orchestrator === undefined ? {} : { orchestrator: record.orchestrator });

export function adopt(args: string[], work: WorkEnv): number {
  const name = args[0] ?? die("faltou nome");
  const mode = args[1] === "--for" ? (args[2] ?? "deliver") : "deliver";
  need("herdr");
  const agent = findAgent(name) ?? die(`agente ${name} não está no herdr`);
  const worktree = jqField(agent.cwd);
  const pane = jqField(agent.pane_id);
  if (regGet(work, name, "mode") === "skill") {
    const current = readJson(join(work.orch, "agents", `${name}.json`)) ?? {};
    regReplace(work, name, { ...current, pane, state: "working", adoptedAt: isoNow(), ...orchestratorField(pane) });
    out(`agente ${name} (skill) registrado: ${worktree} · painel ${pane}`);
    return 0;
  }
  const project = projectEnv(work);
  projectNeed(project);
  assertNoNestedWorktrees(work, name, worktree);
  const branch = run("git", ["-C", worktree, "branch", "--show-current"]).stdout.trim();
  const card = firstEreMatch(project.get("card.newIdPattern", "^$") ?? "^$", branch);
  const lock = lockOf(work, name);
  const adoptedMode = branch ? mode : "review";
  const role = adoptedMode === "review" ? "review" : adoptedMode === "consolidate" ? "consolidate" : "impl";
  regReplace(work, name, {
    name, mode: adoptedMode, role, phase: role, card, key: card, branch, worktree, pane, lock, state: "working", adoptedAt: isoNow(),
    ...keptOrchestrator(readJson(join(work.orch, "agents", `${name}.json`)) ?? {}), ...orchestratorField(pane),
  });
  out(`agente ${name} registrado: ${worktree} · ${branch || "HEAD destacado"} · card ${card || "—"} · lock ${lock || "—"} · painel ${pane}`);
  return 0;
}

const FINAL_STATES = ["done", "archived"];

/**
 * `hades agent reassign-orchestrator <nome>… | --all`: aponta o `orchestrator` dos registros para o pane de quem chama
 * (o herdr reiniciou, os panes mudaram). `--all` pega os agentes ainda não encerrados; nome desconhecido não grava nada.
 */
export function reassignOrchestrator(args: string[], work: WorkEnv, env: NodeJS.ProcessEnv = process.env): number {
  const caller = callerPane(env) ?? die("reassign-orchestrator roda de um pane do herdr (HERDR_PANE_ID ausente)");
  const all = args.includes("--all");
  const names = args.filter((a) => a !== "--all");
  if (!all && names.length === 0) die("faltou nome (ou --all)");
  if (all && names.length > 0) die("--all não combina com nomes");
  const records = agentFiles(work).map((file) => ({ file, reg: readJson(file) })).filter((r): r is { file: string; reg: Record<string, unknown> } => r.reg !== undefined);
  const targets = all
    ? records.filter(({ reg }) => !FINAL_STATES.includes(String(reg.state ?? "")))
    : names.map((name) => records.find(({ reg }) => reg.name === name) ?? die(`agente ${name} não está nos registros`));
  for (const { file, reg } of targets) {
    writeJsonAtomic(file, { ...reg, orchestrator: caller });
    out(`${String(reg.name)}: orquestrador ${caller.session}:${caller.pane}`);
  }
  return 0;
}

export function reviewAgent(args: string[], work: WorkEnv): number {
  const name = args[0] ?? die("faltou nome");
  let pr = "";
  let dry = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--pr") pr = optionValue(args, i++);
    else if (args[i] === "--dry-run") dry = true;
    else die(`opção: ${args[i]}`);
  }
  const project = projectEnv(work);
  projectNeed(project);
  if (!pr) die("--pr N");
  need("gh");
  if (!dry) need("herdr");
  const view = run("gh", ["pr", "view", pr, "--json", "headRefName", "--jq", ".headRefName"], { timeoutMs: GIT_FETCH_TIMEOUT_MS });
  if (view.status !== 0) die(`PR ${pr} não encontrada`);
  const head = view.stdout.replace(/\n+$/, "");
  const worktree = join(worktreeRoot(work), name);
  assertNoNestedWorktrees(work, name, worktree);
  step(dry, "git", ["-C", work.repoTop, "fetch", "-q", "origin", head]);
  step(dry, "git", ["-C", work.repoTop, "worktree", "add", "--detach", worktree, `origin/${head}`]);
  const created = dry ? "{}" : herdr(["workspace", "create", "--cwd", worktree, "--label", name, "--no-focus"], { showStderr: true }).stdout;
  const pane = paneFrom(created);
  prepWorktree(work, worktree, dry, home());
  if (!dry) rtkFilters(worktree);
  if (!dry) {
    mkdirSync(join(worktree, work.reports), { recursive: true });
    phaseQuality(work, worktree, "review");
    regReplace(work, name, { name, mode: "review", role: "review", pr: Number(pr), branch: head, worktree, pane, state: "allocated", createdAt: isoNow(), ...orchestratorField(pane) });
  }
  out(`revisão só de leitura da #${pr} em ${worktree} (HEAD destacado). Achados em ${work.reports}/review-*.md; nada vai ao GitHub.`);
  out(`   ${startCommand(name, pane, "review")}`);
  return 0;
}
