// `hades agent prompt|answer|phase|resume|escalate|status|list|done`: o dia a dia do orquestrador com um agente alocado.
import { spawnSync } from "node:child_process";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settled } from "../lib/caronte.ts";
import { afterFreshSession, deliverySet, isoNow, jqText, regUpdate, roleCard } from "../lib/agent-registry.ts";
import { phaseQuality } from "../lib/agent-project.ts";
import { need } from "../lib/deps.ts";
import { firstLine, isDir, isFile, readText } from "../lib/fs.ts";
import { findAgent, herdr, herdrWait, listAgents, paneFrom } from "../lib/herdr.ts";
import { die, out } from "../lib/output.ts";
import { selfCli, skillRoot } from "../lib/paths.ts";
import { run } from "../lib/proc.ts";
import { agentFile, agentFiles, configValue, openQuestions, readJson, regGet, type Json, type WorkEnv } from "../lib/work.ts";

const TURN_WAIT_MS = 900_000;
const CLEAR_SETTLE_WAIT_MS = 30_000;
const ESCALATE_WAIT_MS = 600_000;
const PARK_WAIT_MS = 600_000;
const CLEAR_POLLS = 20;
const CLEAR_POLL_MS = 500;
const ENTER_EVERY_POLLS = 4;
const PANE_LINES = "8";
const GH_TIMEOUT_MS = 60_000;
const NO_COMMIT_FLAG = "--no-commit";
const CLEAR_ON_PROMPT = /❯ *\/clear/;

function needArg(value: string | undefined, label: string): string {
  return value ?? die(`faltou ${label}`);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function registered(work: WorkEnv, name: string): string {
  return regGet(work, name, "worktree") || die(`agente ${name} não registrado`);
}

function readPane(pane: string): string {
  return herdr(["pane", "read", pane, "--source", "visible", "--lines", PANE_LINES]).stdout;
}

/** /clear e prompt numa sessão limpa (mesmo processo, sem o dono reiniciar). Devolve o status do último prompt. */
function freshPrompt(name: string, text: string): number {
  need("herdr");
  const pane = paneFrom(JSON.stringify(findAgent(name) ?? {}));
  if (!pane) die(`agente ${name} não está no herdr`);
  // /clear mandado no meio de um turno entra na fila de digitação e o prompt seguinte gruda nele ("/clearSessão nova…"),
  // que vira mensagem comum: a sessão não é limpa. Espera o turno acabar e confere a caixa vazia antes do prompt.
  if (herdrWait(name, ["idle", "done", "blocked"], TURN_WAIT_MS).status !== 0) die(`${name} não terminou o turno em 15 min: limpe à mão`);
  if (herdr(["agent", "prompt", name, "/clear"]).status !== 0) die(`não consegui limpar a sessão de ${name} (está no herdr?)`);
  for (let i = 1; i <= CLEAR_POLLS; i++) {
    sleepMs(CLEAR_POLL_MS);
    if (!CLEAR_ON_PROMPT.test(readPane(pane))) break;
    if (i % ENTER_EVERY_POLLS === 0) herdr(["pane", "send-keys", pane, "Enter"]);
  }
  if (CLEAR_ON_PROMPT.test(readPane(pane))) die(`o /clear de ${name} ficou na caixa de entrada: confira o terminal antes de mandar o prompt`);
  herdrWait(name, ["idle"], CLEAR_SETTLE_WAIT_MS);
  return herdr(["agent", "prompt", name, text], { showStderr: true }).status;
}

/** Quem retoma de um handoff pode ter deixado um check na fila do gate-lock: confere antes de enfileirar outro. */
export const RESUME_QUEUE_NOTE = "Antes de enfileirar qualquer gate, rode `hades gate-lock status` e, se o seu check (label do agente) já estiver na fila ou rodando, espere por ele com `hades wait queue <label>` em vez de reenfileirar.";

/** O prompt da sessão limpa de `phase` e `resume`. */
export function sessionPrompt(input: { sub: "phase" | "resume"; label: string; card: string; worktree: string; reports: string; extra: string }): string {
  const { sub, label, card, worktree, reports, extra } = input;
  const queue = sub === "resume" ? ` ${RESUME_QUEUE_NOTE}` : "";
  return `Sessão nova, fase "${label}". Leia ${card}, ${worktree}/${reports}/brief.md e, se existir, ${worktree}/${reports}/handoff.md (continue de onde ele parou; troque a primeira linha para STATUS: ACTIVE). Trabalhe só em ${worktree}.${queue} ${extra}`;
}

/** Report de rodada anterior ainda no lugar: o watch só confia em report escrito depois do prompt, mas o agente pode tomá-lo por feito. */
function warnStaleReport(work: WorkEnv, name: string, worktree: string): void {
  const report = join(worktree, work.reports, "report.md");
  if (firstLine(report).startsWith("STATUS: DONE")) out(`AVISO: ${report} já começa com STATUS: DONE (rodada anterior). Renomeie para report-<n>.md para o agente não tomá-lo por entregue.`);
}

export function phaseOrResume(sub: "phase" | "resume", argv: string[], work: WorkEnv): number {
  const noCommit = argv.includes(NO_COMMIT_FLAG);
  if (noCommit && sub === "resume") die(`${NO_COMMIT_FLAG} é da fase: use hades agent phase <nome> <fase> ${NO_COMMIT_FLAG}`);
  const args = argv.filter((a) => a !== NO_COMMIT_FLAG);
  const name = needArg(args[0], "nome");
  const worktree = registered(work, name);
  const role = regGet(work, name, "role");
  const phase = sub === "phase" ? needArg(args[1], "fase") : regGet(work, name, "phase");
  const extra = (sub === "phase" ? args[2] : args[1]) ?? "";
  const label = phase || role;
  let text = sessionPrompt({ sub, label, card: roleCard(skillRoot, role || "impl"), worktree, reports: work.reports, extra });
  const quality = phaseQuality(work, worktree, label);
  if (quality) text += ` Regras de qualidade ligadas desta fase: ${quality}.`;
  warnStaleReport(work, name, worktree);
  freshPrompt(name, text);
  // a dispensa de commit vale pela fase: phase nova a reseta, resume a mantém
  regUpdate(work, name, (r) => {
    const next = afterFreshSession(r, sub, label, isoNow());
    return sub === "phase" ? { ...next, noCommit } : next;
  });
  out(`${name}: sessão limpa, fase ${label}`);
  return 0;
}

export function escalate(args: string[], work: WorkEnv): number {
  const name = needArg(args[0], "nome");
  const why = needArg(args[1], "motivo");
  const worktree = registered(work, name);
  need("herdr");
  const model = configValue("HADES_MODEL_ESCALATE", "claude-opus-5-5") || "claude-opus-5-5";
  const effort = configValue("HADES_EFFORT_ESCALATE", "high") || "high";
  const old = regGet(work, name, "pane");
  // nunca /model na sessão: ele grava o modelo como padrão global do ~/.claude/settings.json. A escalada é uma sessão
  // nova no mesmo worktree, com --model só para ela: o agente atual estaciona e o dono inicia a nova
  herdr(["agent", "prompt", name, `Escalada decidida pelo orquestrador (${why}). Termine o passo atual, grave ${work.reports}/handoff.md começando com STATUS: PARKED — escalada, com o estado exato, e encerre o turno sem começar nada novo.`], { showStderr: true });
  herdrWait(name, ["idle"], ESCALATE_WAIT_MS);
  const pane = paneFrom(herdr(["pane", "split", old, "--direction", "right", "--cwd", worktree, "--no-focus"]).stdout);
  if (!pane) die(`não consegui abrir o painel novo ao lado de ${old}`);
  herdr(["pane", "close", old]);
  regUpdate(work, name, (r) => ({ ...r, pane, escalated: model, escalatedWhy: why, escalatedAt: isoNow(), state: "allocated" }));
  out(`${name} estacionou; painel novo ${pane}. O dono inicia a sessão de escalada:`);
  out(`   ! herdr agent start ${name} --kind claude --pane ${pane} -- --permission-mode auto --model ${model} --effort ${effort}`);
  out(`depois: hades agent resume ${name} "Escalada para ${model}: ${why}. Resolva o ponto escalado e siga o fluxo."`);
  return 0;
}

/** Pede o handoff e que o agente pare (mesmo caminho do prompt); não mata a sessão nem fecha o painel. */
export function park(args: string[], work: WorkEnv): number {
  const name = needArg(args[0], "nome");
  registered(work, name);
  const record = readJson(agentFile(work, name)) ?? {};
  const settledAs = settled(record, work.reports);
  if (settledAs) {
    out(`${name}: ${settledAs === "ended" ? "já encerrado" : "já estacionado"}; nada a fazer`);
    return 0;
  }
  need("herdr");
  if (!findAgent(name)) {
    out(`${name}: sem sessão no herdr (encerrada); nada a parar. Sem handoff.md estacionado o caronte pack seguirá recusando`);
    return 0;
  }
  const why = args[1] ? ` (${args[1]})` : "";
  const sentAt = Date.now();
  const sent = herdr(["agent", "prompt", name, `O orquestrador pede para estacionar${why}. Termine o passo atual, commite o que estiver pronto, grave ${work.reports}/handoff.md começando com STATUS: PARKED — pausa, depois: o que foi feito, o que falta em ordem, arquivos, branch e head, decisões. Encerre o turno sem começar nada novo.`], { showStderr: true });
  if (sent.status !== 0) return sent.status;
  herdrWait(name, ["idle", "done", "blocked"], PARK_WAIT_MS);
  const handoff = join(regGet(work, name, "worktree"), work.reports, "handoff.md");
  const head = (readText(handoff) ?? "").split("\n")[0] ?? "";
  if (!head.startsWith("STATUS: PARKED") || (statSync(handoff, { throwIfNoEntry: false })?.mtimeMs ?? 0) < sentAt) {
    out(`${name}: o handoff.md ainda não começa com STATUS: PARKED (fresco); espere o turno acabar e rode hades agent park ${name} de novo`);
    return 1;
  }
  regUpdate(work, name, (r) => ({ ...r, state: "parked", parkedAt: isoNow() }));
  out(`${name} estacionado (handoff.md em dia); sessão e painel ficam abertos`);
  return 0;
}

export function prompt(args: string[], work: WorkEnv): number {
  const name = needArg(args[0], "nome");
  const worktree = registered(work, name);
  const text = args[1] ?? `Leia ${roleCard(skillRoot, regGet(work, name, "role"))} e ${worktree}/${work.reports}/brief.md e execute. Trabalhe só em ${worktree} (nunca no clone principal ${work.mainClone}). Dúvida do dono vai em ${work.reports}/questions.md e você segue com o resto; ao terminar, ${work.reports}/report.md começando com STATUS: DONE.`;
  need("herdr");
  const agent = findAgent(name);
  if (!agent) die(`agente ${name} não está no herdr: o dono precisa rodar o herdr agent start`);
  const cwd = String(agent.foreground_cwd ?? "");
  if (!cwd.startsWith(worktree)) out(`AVISO: a sessão abriu em ${cwd}, não em ${worktree}. O prompt leva os caminhos absolutos; monitore o clone principal.`);
  warnStaleReport(work, name, worktree);
  const sent = herdr(["agent", "prompt", name, text], { showStderr: true });
  if (sent.status !== 0) return sent.status;
  regUpdate(work, name, (r) => ({ ...r, state: "working", promptedAt: isoNow() }));
  out(`tarefa enviada a ${name}`);
  return 0;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function answer(args: string[], work: WorkEnv): number {
  const name = needArg(args[0], "nome");
  const question = needArg(args[1], "Qn");
  const reply = needArg(args[2], "resposta");
  const file = join(regGet(work, name, "worktree"), work.reports, "questions.md");
  const text = readText(file);
  if (text === undefined) die(`${file} não existe`);
  const header = new RegExp(`^## ${escapeRegExp(question)}\\b`);
  if (!text.split("\n").some((line) => header.test(line))) die(`${question} não está em ${file}`);
  const marked = text.split("\n").map((line) => (header.test(line) ? `${line} (respondida)` : line).replace(/ \(respondida\) \(respondida\)$/, " (respondida)")).join("\n");
  writeFileSync(file, `${marked}\n## Resposta do dono (${question})\n\n${reply}\n\nNão cite estas perguntas nas specs nem no body.\n`);
  warnStaleReport(work, name, regGet(work, name, "worktree"));
  need("herdr");
  const sent = herdr(["agent", "prompt", name, `O dono respondeu ${question} em ${work.reports}/questions.md. Leia e siga.`], { showStderr: true });
  if (sent.status !== 0) return sent.status;
  out("resposta gravada e " + name + " avisado");
  return 0;
}

/** printf '%-Ns': o bash conta bytes, não caracteres. */
function padBytes(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - Buffer.byteLength(text)));
}

function ghText(args: string[]): string {
  need("gh");
  const result = run("gh", args, { timeoutMs: GH_TIMEOUT_MS });
  return result.status === 0 ? result.stdout.replace(/\n+$/, "") : "";
}

function prOfBranch(branch: string): string {
  return ghText(["pr", "list", "--head", branch, "--state", "all", "--json", "number", "--jq", ".[0].number"]);
}

export function status(args: string[], work: WorkEnv): number {
  let files: string[];
  if (args[0]) {
    files = [agentFile(work, args[0])];
    if (!isFile(files[0] ?? "")) die(`agente ${args[0]} não registrado`);
  } else files = agentFiles(work).sort();
  if (files.length === 0) {
    out(`nenhum agente registrado em ${join(work.orch, "agents")}`);
    return 0;
  }
  const agents = listAgents();
  const row = (cells: string[]): string => `${padBytes(cells[0] ?? "", 14)} ${padBytes(cells[1] ?? "", 11)} ${padBytes(cells[2] ?? "", 9)} ${padBytes(cells[3] ?? "", 8)} ${padBytes(cells[4] ?? "", 6)} ${padBytes(cells[5] ?? "", 9)} ${cells[6] ?? ""}`;
  out(row(["AGENTE", "MODO", "HERDR", "PR", "PERG", "RELATÓRIO", "WORKTREE"]));
  for (const file of files) {
    const record = readJson(file) ?? {};
    const name = jqText(record.name);
    const worktree = jqText(record.worktree);
    const branch = typeof record.branch === "string" ? record.branch : "";
    const mode = jqText(record.mode);
    const hostState = String(agents.find((a) => a.name === name)?.agent_status ?? "fora");
    let pr = record.pr === undefined || record.pr === null ? "" : jqText(record.pr);
    if (!pr && branch && mode !== "review" && mode !== "skill") {
      pr = prOfBranch(branch);
      let parsed: unknown;
      try {
        parsed = pr ? JSON.parse(pr) : undefined;
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) regUpdate(work, name, (r) => ({ ...r, pr: parsed }));
    }
    const firstReportLine = (readText(join(worktree, work.reports, "report.md")) ?? "").split("\n")[0] ?? "";
    const report = firstReportLine.startsWith("STATUS: DONE") ? "pronto" : "—";
    out(row([name, mode, hostState, pr ? `#${pr}` : "", String(openQuestions(worktree, work.reports)), report, worktree]));
  }
  return 0;
}

/** `column -t -s <tab>`: colunas separadas por dois espaços, a última sem preenchimento. */
function columns(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => Array.from(r[i] ?? "").length))) ?? [];
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell + " ".repeat((widths[i] ?? 0) - Array.from(cell).length + 2))).join(""));
}

function orNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function list(args: string[], work: WorkEnv): number {
  let all = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--all") all = true;
    else if (arg === "--json") json = true;
    else die(`opção: ${arg}`);
  }
  const agents = listAgents();
  const rows: Json[] = [];
  for (const file of agentFiles(work)) {
    const r = readJson(file);
    if (!r) continue;
    const registro = r.state === "archived" ? "arquivado" : r.state === "done" ? "encerrado" : "ativo";
    if (!all && registro !== "ativo") continue;
    const pane = String(r.pane ?? "");
    const tree = String(r.worktree ?? "");
    const host = agents.find((a) => a.name === r.name || (pane !== "" && a.pane_id === pane) || (tree !== "" && a.cwd === tree));
    rows.push({
      name: orNull(r.name), role: r.role ?? "—", mode: r.mode ?? "—", registro, herdr: host?.agent_status ?? "fora", branch: r.branch ?? "", worktree: r.worktree ?? "",
    });
  }
  rows.sort((a, b) => {
    const [left, right] = [String(a.name ?? ""), String(b.name ?? "")];
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (json) out(JSON.stringify(rows, null, 2));
  else if (rows.length === 0) out(`nenhum agente ativo em ${join(work.orch, "agents")} (--all mostra os encerrados e arquivados)`);
  else {
    const table = [["AGENTE", "PAPEL", "MODO", "REGISTRO", "HERDR", "BRANCH", "WORKTREE"], ...rows.map((r) => [jqText(r.name), jqText(r.role), jqText(r.mode), jqText(r.registro), jqText(r.herdr), r.branch === "" ? "—" : jqText(r.branch), jqText(r.worktree)])];
    for (const line of columns(table)) out(line);
  }
  return 0;
}

function cerberus(args: string[], silent: boolean): number {
  const cli = selfCli("cerberus", ...args);
  return spawnSync(cli.command, cli.args, { stdio: silent ? ["ignore", "ignore", "ignore"] : "inherit" }).status ?? 1;
}

/**
 * A referência publicada contra a qual o `done` confere "nada sem push": o upstream da branch, ou o `origin/<branch>`
 * quando não há upstream. O `agent new` tira o upstream de propósito (prepWorktree), então o push sem `-u` não o recria
 * e o trabalho publicado ficava barrado. "" = nenhuma das duas existe.
 */
export function pushedRef(worktree: string): string {
  if (run("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "@{upstream}"]).status === 0) return "@{upstream}";
  const branch = run("git", ["-C", worktree, "branch", "--show-current"]).stdout.trim();
  if (!branch) return "";
  const remote = `refs/remotes/origin/${branch}`;
  return run("git", ["-C", worktree, "rev-parse", "--verify", "--quiet", remote]).status === 0 ? remote : "";
}

export function done(args: string[], work: WorkEnv): number {
  const name = needArg(args[0], "nome");
  const keepPane = args[1] === "--keep-pane";
  const file = agentFile(work, name);
  const record = readJson(file) ?? die(`agente ${name} não registrado`);
  const worktree = jqText(record.worktree);
  const lock = typeof record.lock === "string" ? record.lock : "";
  const key = typeof record.key === "string" ? record.key : "";
  const mode = jqText(record.mode);
  let bad = false;
  let pr = "";
  const reportHead = (readText(join(worktree, work.reports, "report.md")) ?? "").split("\n")[0] ?? "";
  if (!reportHead.startsWith("STATUS: DONE")) {
    out(`✗ ${work.reports}/report.md não começa com STATUS: DONE`);
    bad = true;
  }
  const dirty = (): boolean => {
    const status = run("git", ["-C", worktree, "status", "--porcelain", "--untracked-files=no"]);
    if (status.stderr) process.stderr.write(status.stderr);
    return status.stdout.trim() !== "";
  };
  if (mode === "skill") {
    if (dirty()) {
      out("✗ worktree com mudança sem commit");
      bad = true;
    }
  } else if (mode !== "review") {
    if (dirty()) {
      out("✗ worktree com mudança sem commit");
      bad = true;
    }
    const pushed = pushedRef(worktree);
    if (!pushed) {
      out("✗ branch sem upstream nem origin/<branch> (nada foi pushado?)");
      bad = true;
    }
    const ahead = pushed ? run("git", ["-C", worktree, "rev-list", "--count", `${pushed}..HEAD`]).stdout.trim() : "";
    if (!pushed || ahead !== "0") {
      out("✗ há commit sem push");
      bad = true;
    }
    pr = record.pr === undefined || record.pr === null ? "" : jqText(record.pr);
    if (!pr) pr = prOfBranch(jqText(record.branch));
    if (pr) {
      const info = ghText(["pr", "view", pr, "--json", "state,isDraft,mergeable,headRefOid", "--jq", '"\\(.state) draft=\\(.isDraft) \\(.mergeable) \\(.headRefOid[0:11])"']);
      out(`  PR #${pr}: ${info}`);
    } else {
      out("✗ nenhuma PR aberta para a branch");
      bad = true;
    }
  }
  // Cerberus (reference/cerberus.md): a auditoria registra o veredito dela e o DONE passa pela avaliação conjunta
  const scope = mode === "skill" || mode === "review" ? "" : ", nada sem push e PR";
  cerberus([
    "registrar", "--cabeca", "vigilia", "--guarda", "auditoria-done", "--momento", "done", "--resultado", bad ? "barra" : "ok",
    "--ctx", `agente=${name}`, "--ctx", `modo=${mode}`, "--dir", worktree,
    "--evidencia", `report.md com STATUS: DONE, worktree sem mudança${scope}: ${bad ? "falhou (itens ✗ acima)" : "conferido"}|hades agent done em ${worktree}`,
  ], true);
  if (bad) die("auditoria falhou: confira com o agente antes de encerrar");
  const evaluate = ["avaliar", "done", "--dir", worktree, "--ctx", `agente=${name}`, "--ctx", `modo=${mode}`, ...(pr ? ["--ctx", `pr=${pr}`] : [])];
  if (cerberus(evaluate, false) !== 0) die(`o Cerberus barrou o DONE de ${name} (acima)`);
  if (lock && isDir(join(work.locks, lock))) {
    rmSync(join(work.locks, lock), { recursive: true });
    out(`  lock ${lock} liberado`);
  }
  if (key && mode !== "review" && mode !== "skill") {
    const state = ghText(["pr", "view", pr, "--json", "state", "--jq", ".state"]);
    const head = run("git", ["-C", worktree, "rev-parse", "--short", "HEAD"]).stdout.trim();
    deliverySet(work, key, (d) => ({ ...d, pr: Number(pr), status: state === "MERGED" ? "merged" : "open", head }));
  }
  regUpdate(work, name, (r) => ({ ...r, state: "done", doneAt: isoNow() }));
  const pane = typeof record.pane === "string" ? record.pane : "";
  if (!keepPane && pane && herdr(["pane", "close", pane]).status === 0) out(`  painel ${pane} fechado`);
  out(`agente ${name} encerrado; a worktree ${worktree} fica ${mode === "skill" ? "até o skill-clean" : "enquanto a PR estiver aberta"}`);
  return 0;
}
