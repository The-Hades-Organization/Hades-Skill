// `hades caronte pack|unpack|brief`: leva uma orquestração para outra sessão ou máquina (reference/caronte.md).
// Uso: hades caronte pack <plano> [--out <arq>] [--with-journal] [--allow <caminho>]… [--dry-run]
//      hades caronte unpack <arq> [--work-root <d>] [--plans <d>] [--worktrees <d>] [--clone <d>] [--dry-run]
//      hades caronte brief <plano>
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  applyAllow, buildManifest, CaronteError, decryptPackage, DEFAULT_LOG2N, encryptPackage, gather, linkedAgents, manifestPart, resumePrompt,
  settled, verifyParts, type Finding,
} from "../lib/caronte.ts";
import { apply, prepare, UnpackError, type Prepared } from "../lib/caronte-unpack.ts";
import { startCommand } from "../lib/agent-registry.ts";
import { isFile, readText } from "../lib/fs.ts";
import { die, out, warn } from "../lib/output.ts";
import { hadesHome, skillRoot } from "../lib/paths.ts";
import { run } from "../lib/proc.ts";
import { configValue, DEFAULT_REPORTS, loadWorkEnv, type WorkEnv } from "../lib/work.ts";

const PASSWORD_ENV = "HADES_CARONTE_PASSWORD";
const PACKAGE_MODE = 0o600;
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = ["\u007f", "\b"];

const USAGE = `uso: hades caronte pack <plano> [--out <arq>] [--with-journal] [--allow <caminho>]… [--dry-run]
     hades caronte unpack <arq> [--work-root <d>] [--plans <d>] [--worktrees <d>] [--clone <d>] [--dry-run]
     hades caronte brief <plano>
  pack   empacota o plano, os registros, relatórios e worktrees dos agentes num arquivo cifrado (AES-256-GCM, senha pelo
         tty ou ${PASSWORD_ENV}). Recusa se algum agente não está estacionado ou encerrado (hades agent park <nome>).
         ATENÇÃO: a senha não é guardada em lugar nenhum; senha esquecida perde o pacote.
  unpack abre o pacote (senha pelo tty, uma vez, ou ${PASSWORD_ENV}) e refaz plano, registros, relatórios e worktrees; recusa
         sem tocar em nada se algo já existe ou falta (clone, base, bundle); nunca clona sozinho. --dry-run só mostra o mapa.
  brief  imprime o prompt de retomada do orquestrador numa outra sessão da mesma máquina (só leitura)`;

const utcStamp = (now: Date): string => now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

function resolvePlan(arg: string | undefined): string {
  const given = arg ?? die("faltou o plano");
  for (const candidate of [given, join(hadesHome(), "plans", given), join(hadesHome(), "plans", `${given}.md`)]) {
    if (isFile(candidate)) return resolve(candidate);
  }
  return die(`plano não encontrado: ${given}`);
}

/** A raiz de trabalho do plano: _skill para os planos de ~/.claude/hades/plans, a do projeto do diretório para os demais. */
function workOf(planFile: string): WorkEnv {
  return loadWorkEnv({ skillOk: true, skillForce: planFile.startsWith(`${hadesHome()}/plans/`) });
}

function repoOf(work: WorkEnv): { remote: string; clone: string } {
  const remote = run("git", ["-C", work.mainClone, "config", "--get", "remote.origin.url"]).stdout.trim();
  return { remote, clone: work.mainClone };
}

/** Lê uma linha sem eco do tty (raw mode); a senha nunca passa por argv, log nem diário. */
async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  try {
    return await new Promise<string>((done, fail) => {
      let typed = "";
      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n" || ch === CTRL_D) {
            stdin.off("data", onData);
            process.stderr.write("\n");
            done(typed);
            return;
          }
          if (ch === CTRL_C) {
            stdin.off("data", onData);
            process.stderr.write("\n");
            fail(new Error("interrompido"));
            return;
          }
          typed = BACKSPACE.includes(ch) ? typed.slice(0, -1) : typed + ch;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

/** Senha de HADES_CARONTE_PASSWORD ou do tty (duas vezes ao criar, uma ao abrir); sem nenhum dos dois não há pacote. */
export async function askPassword(env: NodeJS.ProcessEnv = process.env, confirm = true): Promise<string> {
  const fromEnv = env[PASSWORD_ENV];
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) die(`sem senha: sem tty e sem ${PASSWORD_ENV}, sem pacote`);
  const first = await readHidden(confirm ? "Senha do pacote (esquecida, o pacote se perde): " : "Senha do pacote: ");
  if (!first) die("senha vazia: sem senha, sem pacote");
  if (confirm && first !== (await readHidden("Repita a senha: "))) die("as senhas não conferem");
  return first;
}

interface PackArgs {
  plan: string;
  out: string | undefined;
  withJournal: boolean;
  allow: string[];
  dryRun: boolean;
}

function parsePack(args: string[]): PackArgs {
  const parsed: PackArgs = { plan: "", out: undefined, withJournal: false, allow: [], dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--with-journal") parsed.withJournal = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--out") parsed.out = args[++i] ?? die("--out pede o arquivo");
    else if (arg === "--allow") parsed.allow.push(args[++i] ?? die("--allow pede o caminho"));
    else if (arg.startsWith("-")) die(`opção desconhecida: ${arg}`);
    else if (parsed.plan === "") parsed.plan = arg;
    else die(`argumento a mais: ${arg}`);
  }
  if (!parsed.plan) die("faltou o plano");
  return parsed;
}

function nameFindings(findings: Finding[]): string[] {
  return findings.map((f) => `  ${f.path} (${f.rule === "nome" ? "nome de credencial" : "padrão de segredo no conteúdo"})`);
}

function log2nOf(): number {
  const raw = configValue("HADES_CARONTE_SCRYPT_LOG2N", String(DEFAULT_LOG2N));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 14 || value > 20) die(`HADES_CARONTE_SCRYPT_LOG2N=${raw}: esperava um inteiro de 14 a 20`);
  return value;
}

function outputPath(requested: string | undefined, planFile: string, now: Date): string {
  if (requested) return resolve(requested);
  const dir = configValue("HADES_CARONTE_OUT_DIR", "") || join(hadesHome(), "caronte");
  return join(dir, `${planFile.replace(/^.*\//, "").replace(/\.md$/, "")}-${utcStamp(now)}.caronte`);
}

/** O pacote não pode ficar dentro de um repo: um `git add .` o publicaria. */
function insideRepo(file: string): boolean {
  let dir = dirname(file);
  while (!existsSync(dir)) dir = dirname(dir);
  return run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
}

async function pack(args: string[]): Promise<number> {
  const options = parsePack(args);
  const planFile = resolvePlan(options.plan);
  const work = workOf(planFile);
  const gathered = gather({ work, planFile, withJournal: options.withJournal });
  const { blocked, allowed } = applyAllow(gathered.plan.findings, options.allow);
  const now = new Date();
  const manifest = buildManifest({
    skillVersion: (readText(join(skillRoot, "VERSION")) ?? "").trim(),
    workRoot: work.work,
    scope: work.skillScope ? "skill" : "project",
    repo: repoOf(work),
    plan: { path: planFile, name: planFile.replace(/^.*\//, "").replace(/\.md$/, ""), approvedSha: gathered.approvedSha, sha: gathered.planSha },
    agents: gathered.agents,
    worktrees: gathered.plan.worktrees,
    withJournal: options.withJournal,
    allowed,
    parts: gathered.plan.parts,
    now,
  });
  if (options.dryRun) {
    out(`caronte pack --dry-run: ${planFile} (raiz ${work.work})`);
    for (const part of manifest.parts) out(`  ${String(part.size).padStart(10)}  ${part.path}`);
    out(`  agentes: ${gathered.agents.join(", ") || "(nenhum)"}`);
    for (const line of nameFindings(blocked)) out(`  BARRADO ${line.trim()}`);
    for (const path of allowed) out(`  liberado por --allow: ${path}`);
    out(blocked.length > 0 ? "o pack recusaria: use --allow <caminho> para liberar de forma explícita" : "o pack seguiria (nada foi gravado, nenhuma senha foi pedida)");
    return blocked.length > 0 ? 1 : 0;
  }
  if (blocked.length > 0) {
    warn("hades: o pack recusou, arquivos com credencial (o valor não é mostrado):");
    for (const line of nameFindings(blocked)) warn(line);
    warn("tire o arquivo da orquestração ou libere de forma explícita com --allow <caminho>");
    return 1;
  }
  const file = outputPath(options.out, planFile, now);
  if (existsSync(file)) die(`${file} já existe: escolha outro --out`);
  if (insideRepo(file)) die(`${file} está dentro de um repositório: o pacote tem de ficar fora de qualquer repo (--out)`);
  const password = await askPassword();
  const sealed = encryptPackage([manifestPart(manifest), ...gathered.plan.parts], password, log2nOf());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, sealed, { mode: PACKAGE_MODE });
  chmodSync(`${file}.tmp`, PACKAGE_MODE);
  renameSync(`${file}.tmp`, file);
  out(`pacote gravado: ${file} (${sealed.length} bytes, ${manifest.parts.length} partes, modo 600)`);
  out("a senha não é guardada em lugar nenhum: senha esquecida perde o pacote");
  return 0;
}

interface UnpackArgs {
  file: string;
  workRoot: string | undefined;
  plans: string | undefined;
  worktrees: string | undefined;
  clone: string | undefined;
  dryRun: boolean;
}

function parseUnpack(args: string[]): UnpackArgs {
  const parsed: UnpackArgs = { file: "", workRoot: undefined, plans: undefined, worktrees: undefined, clone: undefined, dryRun: false };
  const valueOf = (i: number, flag: string): string => resolve(args[i] ?? die(`${flag} pede o diretório`));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--work-root") parsed.workRoot = valueOf(++i, arg);
    else if (arg === "--plans") parsed.plans = valueOf(++i, arg);
    else if (arg === "--worktrees") parsed.worktrees = valueOf(++i, arg);
    else if (arg === "--clone") parsed.clone = valueOf(++i, arg);
    else if (arg.startsWith("-")) die(`opção desconhecida: ${arg}`);
    else if (parsed.file === "") parsed.file = arg;
    else die(`argumento a mais: ${arg}`);
  }
  if (!parsed.file) die("faltou o arquivo do pacote");
  return parsed;
}

function describePlan(prepared: Prepared, dryRun: boolean): void {
  out(`caronte unpack${dryRun ? " --dry-run" : ""}: mapa origem → destino`);
  for (const [from, to] of prepared.pathMap) out(`  ${from}  →  ${to}`);
  out(`  clone: ${prepared.clone}`);
  if (dryRun) {
    out("seria criado:");
    for (const file of [...prepared.planWrites, ...prepared.files]) out(`  ${file.path}`);
    for (const entry of prepared.worktrees) out(`  worktree ${entry.dest} (branch ${entry.info.branch}, head ${entry.info.head.slice(0, 12)})`);
  }
}

function resumeLines(prepared: Prepared): void {
  const resumable = prepared.agents.filter((a) => a.state === "parked");
  out("");
  out("para retomar, por agente (o dono inicia cada um):");
  for (const agent of resumable) {
    out(`  ${agent.name}:`);
    out(`    herdr workspace create --cwd ${agent.worktree} --label hd-${agent.name} --no-focus`);
    out(`    ${startCommand(agent.name, "", agent.role)}`);
    out(`    hades agent adopt ${agent.name} && hades agent resume ${agent.name}`);
  }
  if (resumable.length === 0) out("  (nenhum agente estacionado no pacote)");
  out("");
  out(resumePrompt(prepared.planFile, resumable.map((a) => a.name)));
}

async function unpack(args: string[]): Promise<number> {
  const options = parseUnpack(args);
  const file = resolve(options.file);
  if (!isFile(file)) die(`pacote não encontrado: ${file}`);
  const password = await askPassword(process.env, false);
  try {
    const parts = decryptPackage(readFileSync(file), password);
    const manifest = verifyParts(parts);
    const prepared = prepare(parts, manifest, {
      workRoot: options.workRoot, plans: options.plans, worktrees: options.worktrees, clone: options.clone,
      reports: process.env.HADES_ORCH_REPORTS_DIR || DEFAULT_REPORTS, skillVersion: (readText(join(skillRoot, "VERSION")) ?? "").trim(),
    });
    for (const line of prepared.warnings) warn(`hades: aviso: ${line}`);
    describePlan(prepared, options.dryRun);
    if (options.dryRun) {
      out("o unpack seguiria (nada foi gravado)");
      return 0;
    }
    apply(prepared);
    out(`unpack concluído: ${prepared.worktrees.length} worktree(s), ${prepared.agents.length} agente(s), plano ${prepared.planFile}`);
    resumeLines(prepared);
    return 0;
  } catch (error) {
    if (error instanceof CaronteError || error instanceof UnpackError) return die(error.message, 1);
    throw error;
  }
}

function brief(args: string[]): number {
  const planFile = resolvePlan(args[0]);
  const work = workOf(planFile);
  const parked = linkedAgents(work, readText(planFile) ?? "")
    .filter((a) => settled(a.record, work.reports) === "parked")
    .map((a) => a.name);
  out(resumePrompt(planFile, parked));
  return 0;
}

export async function caronteCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "pack": return await pack(rest);
    case "unpack": return await unpack(rest);
    case "brief": return brief(rest);
    default:
      out(USAGE);
      return sub === undefined || sub === "-h" || sub === "--help" ? 2 : die(`subcomando desconhecido: ${sub}`);
  }
}
