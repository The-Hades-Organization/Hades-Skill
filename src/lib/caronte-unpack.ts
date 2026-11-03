// Caronte, parte 2 (reference/caronte.md): abre o pacote e refaz a orquestração nesta máquina. Duas fases: `prepare` valida
// tudo e não escreve nada (é o que o --dry-run mostra); `apply` escreve e, se uma escrita falhar, desfaz só o que criou.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { planSha } from "../commands/agent.ts";
import { AGENT_NAME, FORMAT_VERSION, git, gitText, REPORT_FILES, type Manifest, type Part, type WorktreeInfo } from "./caronte.ts";
import { firstLine, isDir } from "./fs.ts";
import { hadesHome } from "./paths.ts";
import { readJson, type Json } from "./work.ts";

export class UnpackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnpackError";
  }
}

export interface UnpackOptions {
  workRoot?: string;
  plans?: string;
  worktrees?: string;
  clone?: string;
  reports: string;
  skillVersion: string;
  env?: NodeJS.ProcessEnv;
}

export interface PlannedWorktree {
  info: WorktreeInfo;
  dest: string;
  bundle: Part | undefined;
  patch: Part | undefined;
  needsFetch: boolean;
}

interface FileWrite {
  path: string;
  data: string | Buffer;
}

export interface Prepared {
  clone: string;
  workDir: string;
  planFile: string;
  pathMap: [string, string][];
  worktrees: PlannedWorktree[];
  files: FileWrite[];
  planWrites: FileWrite[];
  agents: { name: string; state: string; role: string; worktree: string }[];
  warnings: string[];
  approval: "valida" | "refazer" | "ausente";
}

const SAFE_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const ENDED = ["done", "archived"];
const COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/* ---------- versões ---------- */

const majorMinor = (version: string): [string, string] => {
  const [major = "", minor = ""] = version.split(".");
  return [major, minor];
};

/** Recusa formato mais novo e skillVersion de outro major; outro minor vira aviso. */
export function checkVersions(manifest: Manifest, localVersion: string): string[] {
  if (typeof manifest.format !== "number" || manifest.format > FORMAT_VERSION) {
    throw new UnpackError(`formato ${String(manifest.format)} do pacote é mais novo que o desta skill (${FORMAT_VERSION}): atualize a Hades`);
  }
  const [theirMajor, theirMinor] = majorMinor(String(manifest.skillVersion ?? ""));
  const [myMajor, myMinor] = majorMinor(localVersion);
  if (theirMajor !== myMajor) {
    throw new UnpackError(`o pacote é da Hades ${manifest.skillVersion} e esta é a ${localVersion}: major diferente, atualize ou use a mesma versão`);
  }
  return theirMinor === myMinor ? [] : [`o pacote é da Hades ${manifest.skillVersion} e esta é a ${localVersion} (minor diferente)`];
}

/* ---------- caminhos ---------- */

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reescreve prefixos de origem para destino numa passada só, o mais longo primeiro (um destino nunca é reescrito de novo). */
export function pathRewriter(map: [string, string][]): (text: string) => string {
  const pairs = map.filter(([from, to]) => from !== "" && from !== to).sort((a, b) => b[0].length - a[0].length);
  if (pairs.length === 0) return (text) => text;
  const lookup = new Map(pairs);
  const re = new RegExp(pairs.map(([from]) => escapeRe(from)).join("|"), "g");
  return (text) => text.replace(re, (hit) => lookup.get(hit) ?? hit);
}

function rewriteJson(value: unknown, rewrite: (text: string) => string): unknown {
  if (typeof value === "string") return rewrite(value);
  if (Array.isArray(value)) return value.map((item) => rewriteJson(item, rewrite));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteJson(item, rewrite)]));
  }
  return value;
}

/** A raiz de trabalho desta máquina (a mesma regra de work.ts: HADES_WORK_ROOT, work-root, ~/.claude/hades/work). */
function localWorkRoot(env: NodeJS.ProcessEnv): string {
  return env.HADES_WORK_ROOT || firstLine(join(hadesHome(), "work-root")) || join(hadesHome(), "work");
}

/** Plano que veio de ~/.claude/hades/plans volta para lá; qualquer outro, para a pasta de origem. */
function plansDirOf(origin: string, requested: string | undefined): string {
  if (requested) return requested;
  return /\/hades\/plans$/.test(dirname(origin)) ? join(hadesHome(), "plans") : dirname(origin);
}

function safeName(value: string, what: string): string {
  if (!SAFE_FILE.test(value) || value === "." || value === "..") throw new UnpackError(`nome inseguro no pacote (${what}): ${value}`);
  return value;
}

/* ---------- validação ---------- */

const text = (part: Part): string => part.data.toString("utf8");

function asRecord(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UnpackError(`${what} do pacote não é um objeto JSON`);
  return Object.fromEntries(Object.entries(value));
}

function parseRecord(part: Part): Json {
  try {
    return asRecord(JSON.parse(text(part)), part.path);
  } catch (error) {
    throw error instanceof UnpackError ? error : new UnpackError(`${part.path} do pacote não é JSON válido`);
  }
}

function findClone(manifest: Manifest, requested: string | undefined, warnings: string[]): string {
  const remote = manifest.repo?.remote ?? "";
  const hint = remote ? `git clone ${remote} <destino>` : "(o pacote não registra o remote: informe um clone com --clone)";
  if (requested) {
    if (!isDir(requested) || git(requested, ["rev-parse", "--git-dir"]).status !== 0) {
      throw new UnpackError(`--clone ${requested} não é um repositório git; clone o projeto antes: ${hint}`);
    }
    const url = gitText(requested, ["config", "--get", "remote.origin.url"]);
    if (url !== remote) warnings.push(`o remote.origin.url de ${requested} (${url || "vazio"}) difere do do pacote (${remote || "vazio"})`);
    return requested;
  }
  const origin = manifest.repo?.clone ?? "";
  if (origin && isDir(origin) && git(origin, ["rev-parse", "--git-dir"]).status === 0 && gitText(origin, ["config", "--get", "remote.origin.url"]) === remote) return origin;
  throw new UnpackError(`não há clone deste projeto aqui (o do pacote: ${origin || "?"}); o unpack nunca clona sozinho. Clone e aponte com --clone: ${hint}`);
}

function hasCommit(clone: string, sha: string): boolean {
  return git(clone, ["cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

/** Valida tudo e monta o que seria escrito. Não escreve nada (só um arquivo temporário do bundle é lido depois, pelo apply). */
export function prepare(parts: Part[], manifest: Manifest, options: UnpackOptions): Prepared {
  const env = options.env ?? process.env;
  const warnings = checkVersions(manifest, options.skillVersion);
  const listed = new Set((manifest.parts ?? []).map((p) => p.path));
  const byPath = new Map(parts.filter((p) => listed.has(p.path)).map((p) => [p.path, p]));
  const clone = findClone(manifest, options.clone, warnings);

  const workDir = join(options.workRoot ?? localWorkRoot(env), safeName(basename(manifest.workRoot), "raiz de trabalho"));
  const orch = join(workDir, "orchestration");
  const planName = safeName(manifest.plan.name, "plano");
  const plansDir = plansDirOf(manifest.plan.path, options.plans);
  const planFile = join(plansDir, `${planName}.md`);
  const planLog = join(plansDir, `${planName}.log.md`);

  const planPart = byPath.get(`plan/${planName}.md`);
  if (!planPart || !PLAN_NAME.test(`${planName}.md`)) throw new UnpackError("o pacote não traz o plano");
  const restoredSha = planSha(text(planPart));
  if (restoredSha !== manifest.plan.sha) throw new UnpackError("o plano do pacote não confere com o sha do manifesto");

  const planWrites: FileWrite[] = [];
  if (existsSync(planFile)) {
    const existing = planSha(readFileSync(planFile, "utf8"));
    if (existing !== manifest.plan.sha) {
      throw new UnpackError(`o plano ${planFile} já existe com outro conteúdo (sha ${existing.slice(0, 12)}, o do pacote ${manifest.plan.sha.slice(0, 12)}): escolha outro --plans ou resolva à mão`);
    }
  } else {
    planWrites.push({ path: planFile, data: planPart.data });
  }
  const logPart = byPath.get(`plan/${planName}.log.md`);
  if (logPart && !existsSync(planLog) && !existsSync(planFile)) planWrites.push({ path: planLog, data: logPart.data });

  const pathMap: [string, string][] = [[manifest.workRoot, workDir], [manifest.plan.path, planFile]];
  const worktrees: PlannedWorktree[] = [];
  const worktreeBase = options.worktrees;
  for (const info of manifest.worktrees ?? []) {
    const agent = info.agent;
    if (!AGENT_NAME.test(agent)) throw new UnpackError(`agente inválido no manifesto: ${agent}`);
    const dest = join(worktreeBase ?? dirname(info.path), safeName(basename(info.path), `worktree de ${agent}`));
    pathMap.push([info.path, dest]);
    worktrees.push({ info, dest, bundle: info.bundle ? byPath.get(info.bundle) : undefined, patch: info.patch ? byPath.get(info.patch) : undefined, needsFetch: false });
  }

  for (const entry of worktrees) validateWorktree(entry, clone, warnings);

  const rewrite = pathRewriter(pathMap);
  const files: FileWrite[] = [];
  const agents: Prepared["agents"] = [];
  const destOf = new Map(worktrees.map((w) => [w.info.agent, w.dest]));
  let approval: Prepared["approval"] = "ausente";

  for (const [path, part] of byPath) {
    const [area, ...rest] = path.split("/");
    if (path === "orchestration/plan.json") {
      const dest = join(orch, "plan.json");
      const current = existsSync(dest) ? (readJson(dest) ?? {}) : undefined;
      if (current && current.path !== planFile) throw new UnpackError(`${dest} já guarda a aprovação de outro plano (${String(current.path)}): não é tocado, resolva à mão`);
      approval = manifest.plan.approvedSha !== null && manifest.plan.approvedSha === restoredSha ? "valida" : "refazer";
      if (!current) files.push({ path: dest, data: `${JSON.stringify(rewriteJson(parseRecord(part), rewrite), null, 2)}\n` });
    } else if (area === "orchestration" && rest.length === 2 && rest[0] === "agents") {
      const name = safeName((rest[1] ?? "").replace(/\.json$/, ""), "agente");
      if (!AGENT_NAME.test(name) || !(manifest.agents ?? []).includes(name)) continue;
      const record = asRecord(rewriteJson(parseRecord(part), rewrite), part.path);
      const ended = typeof record.state === "string" && ENDED.includes(record.state);
      const restored: Json = { ...record, state: ended ? record.state : "parked" };
      delete restored.pane;
      files.push({ path: join(orch, "agents", `${name}.json`), data: `${JSON.stringify(restored, null, 2)}\n` });
      agents.push({ name, state: String(restored.state), role: String(record.role ?? "impl"), worktree: String(restored.worktree ?? "") });
    } else if (area === "orchestration" && rest.length === 2 && (rest[0] === "watch" || rest[0] === "consolidations")) {
      files.push({ path: join(orch, rest[0] ?? "", safeName(rest[1] ?? "", "arquivo do registro")), data: rewrite(text(part)) });
    } else if (area === "reports" && rest.length === 2) {
      const dest = destOf.get(rest[0] ?? "");
      const file = rest[1] ?? "";
      if (dest && REPORT_FILES.includes(file)) files.push({ path: join(dest, options.reports, file), data: part.data });
    } else if (area === "journal" && rest.length === 1) {
      const name = (rest[0] ?? "").replace(/\.jsonl$/, "");
      if (AGENT_NAME.test(name)) files.push({ path: join(workDir, "journal", `${name}.jsonl`), data: part.data });
    }
  }

  const taken = files.filter((f) => existsSync(f.path)).map((f) => f.path);
  if (taken.length > 0) throw new UnpackError(`já existe no destino (nada foi tocado): ${taken.join(", ")}`);
  if (approval === "refazer") warnings.push(`a aprovação do plano não confere com o plano restaurado: rode hades agent plan-approve ${planFile}`);
  return { clone, workDir, planFile, pathMap, worktrees, files, planWrites, agents, warnings, approval };
}

function validateWorktree(entry: PlannedWorktree, clone: string, warnings: string[]): void {
  const { info, dest } = entry;
  // baseRef, baseSha e head vão como argumento do git: um valor começando por "-" viraria opção
  if (!COMMIT_SHA.test(String(info.baseSha))) throw new UnpackError(`${info.agent}: baseSha inválido no manifesto`);
  if (!COMMIT_SHA.test(String(info.head))) throw new UnpackError(`${info.agent}: head inválido no manifesto`);
  const baseRef = String(info.baseRef);
  if (baseRef.startsWith("-") || git(clone, ["check-ref-format", "--branch", baseRef]).status !== 0) {
    throw new UnpackError(`${info.agent}: baseRef inválido no manifesto`);
  }
  if (!info.branch) throw new UnpackError(`${info.agent}: a worktree de origem estava em HEAD destacado, o unpack só refaz worktrees de branch`);
  if (git(clone, ["check-ref-format", "--branch", info.branch]).status !== 0) throw new UnpackError(`${info.agent}: nome de branch inválido: ${info.branch}`);
  if (existsSync(dest)) throw new UnpackError(`${info.agent}: ${dest} já existe (nada foi tocado): escolha outro --worktrees`);
  if (git(clone, ["show-ref", "--verify", "--quiet", `refs/heads/${info.branch}`]).status === 0) {
    throw new UnpackError(`${info.agent}: a branch ${info.branch} já existe no clone ${clone} (nada foi tocado)`);
  }
  if (!hasCommit(clone, info.baseSha)) {
    entry.needsFetch = true;
    warnings.push(`${info.agent}: a base ${info.baseRef} (${info.baseSha.slice(0, 12)}) não está no clone; o unpack faz git fetch origin ${info.baseRef}`);
  }
  if (info.bundle && !entry.bundle) throw new UnpackError(`${info.agent}: o manifesto cita ${info.bundle}, que não está no pacote`);
  if (info.patch && !entry.patch) throw new UnpackError(`${info.agent}: o manifesto cita ${info.patch}, que não está no pacote`);
}

/* ---------- aplicação ---------- */

type Undo = () => void;

function ensureDir(dir: string, undo: Undo[]): void {
  const first = mkdirSync(dir, { recursive: true });
  if (first) undo.push(() => rmSync(first, { recursive: true, force: true }));
}

function writeNew(file: FileWrite, undo: Undo[]): void {
  ensureDir(dirname(file.path), undo);
  writeFileSync(file.path, file.data, { flag: "wx" });
  undo.push(() => rmSync(file.path, { force: true }));
}

function must(result: { status: number; stderr: string }, what: string): void {
  if (result.status !== 0) throw new UnpackError(`${what}: ${result.stderr.trim()}`);
}

/** Cria a branch (do bundle, ou na base), a worktree, confere o HEAD e aplica o patch. */
function restoreWorktree(entry: PlannedWorktree, clone: string, undo: Undo[]): void {
  const { info, dest } = entry;
  if (entry.needsFetch && !hasCommit(clone, info.baseSha)) {
    const fetched = git(clone, ["fetch", "origin", info.baseRef.replace(/^origin\//, "")]);
    if (fetched.status !== 0 || !hasCommit(clone, info.baseSha)) {
      throw new UnpackError(`${info.agent}: a base ${info.baseRef} (${info.baseSha}) não está no clone e o fetch falhou; rode: git -C ${clone} fetch origin ${info.baseRef}`);
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), "caronte-unpack-"));
  try {
    if (entry.bundle) {
      const file = join(scratch, "commits.bundle");
      writeFileSync(file, entry.bundle.data);
      must(git(clone, ["bundle", "verify", file]), `${info.agent}: git bundle verify`);
      must(git(clone, ["fetch", "--no-tags", file, `HEAD:refs/heads/${info.branch}`]), `${info.agent}: aplicar o bundle`);
    } else {
      must(git(clone, ["branch", info.branch, info.baseSha]), `${info.agent}: criar a branch ${info.branch}`);
    }
    undo.push(() => void git(clone, ["branch", "-D", info.branch]));
    ensureDir(dirname(dest), undo);
    must(git(clone, ["worktree", "add", dest, info.branch]), `${info.agent}: git worktree add`);
    undo.push(() => {
      git(clone, ["worktree", "remove", "--force", dest]);
      rmSync(dest, { recursive: true, force: true });
      git(clone, ["worktree", "prune"]);
    });
    const head = gitText(dest, ["rev-parse", "HEAD"]);
    if (head !== info.head) throw new UnpackError(`${info.agent}: o HEAD restaurado (${head}) difere do do manifesto (${info.head})`);
    if (entry.patch) must(git(dest, ["apply", "--binary", "-"], process.env, entry.patch.data), `${info.agent}: aplicar uncommitted.patch`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Escreve tudo; se algo falha no meio, desfaz em ordem inversa o que este unpack criou e relança. */
export function apply(prepared: Prepared): void {
  const undo: Undo[] = [];
  try {
    for (const file of prepared.planWrites) writeNew(file, undo);
    for (const entry of prepared.worktrees) restoreWorktree(entry, prepared.clone, undo);
    for (const file of prepared.files) writeNew(file, undo);
  } catch (error) {
    const failed: string[] = [];
    for (const step of undo.reverse()) {
      try {
        step();
      } catch (undoError) {
        failed.push(undoError instanceof Error ? undoError.message : String(undoError));
      }
    }
    if (failed.length === 0) throw error;
    const cause = error instanceof Error ? error.message : String(error);
    throw new UnpackError(`${cause} (o desfazer também falhou, confira à mão: ${failed.join("; ")})`);
  }
}
