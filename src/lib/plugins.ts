// Plugins do Hades: os pacotes em <packs>/ (reference/projects.md §Plugin), pela página Plugins do painel ou pelo terminal
// (kit/plugins.sh → `hades plugins`). Um plugin por instalação: o pacote cujo identity.repo casa com o remote do worktree.
// Nada do pacote roda antes da prévia e da confirmação com o commit mostrado nela; o git roda sem hooks e sem pedir
// credencial. O limiar do Cerberus lê daqui a regra do que executa (RUNS), o ENV_SKIP, a pasta de prévias e o log.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { type Dict, Recusa, evaluate } from "./cerberus.ts";
import { isDir, isFile, readText, realpathMissingOk } from "./fs.ts";
import { pyJsonDumps } from "./kit.ts";
import { home } from "./paths.ts";
import { type JsonObject, admitsLegacyCore, coreOk, coreVersion, isObject, legacyCoreMessage, pyText } from "./profile.ts";
import { comparePaths, pyGlob } from "./pyglob.ts";
import { pyRepr, splitLines } from "./pyjson.ts";
import { packsRoot, resolveProject } from "./project.ts";
import { unitPrefix } from "./config.ts";
import { serviceManager } from "./service-manager.ts";
import { validateFile } from "./validate.ts";

const STAGING_TTL_S = 3600; // prévia sem confirmação some depois de 1 h
export const PREVIEW_MAX = 200_000; // bytes de código e diff na prévia; o resto é cortado com aviso
const LOCAL_TIMEOUT_MS = 30_000;
const URL_MAX = 300;
const SHORT_SHA = 12;
const UPDATE_LOG_MAX = "50";
const SHA_LEN_HEX = 8;
const ENV_FILE_EXTS = [".sh"];
// só https:// e git@, sem credencial, sem opção nem transporte do git (ext::, file://) disfarçado de URL
const URL_HTTPS = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~/-]+$/;
const URL_SSH = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/;
/** o mesmo padrão do `name` do profile.schema.json */
export const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;
const PREVIEW_ID = /^[0-9a-f]{16}$/;
const CFG_KEY = /^[A-Z][A-Z0-9_]*$/;
/** o que executa: o install.sh roda o post-install.sh, o painel carrega o api.ts e os scripts da UI, o doctor lê o doctor.sh e o onboarding mede os checks. O resto do env/ vai para o $D como script do ambiente */
export const RUNS = ["post-install.sh", "panel/api.ts", "panel/ui/*.js", "doctor.sh", "checks/*.sh", "commands/*"] as const;
export const ENV_SKIP = ["assets", "reference", "__pycache__"] as const;

/** Recusa com código estável (o painel e o terminal ramificam pelo código; a mensagem é para o dono). */
export class Refused extends Error {
  readonly code: string;
  readonly preview?: Dict;
  constructor(code: string, message: string, preview?: Dict) {
    super(message);
    this.name = "Refused";
    this.code = code;
    this.preview = preview;
  }
}

export interface PluginsCtx {
  /** o $D desta instalação (HADES_DATA) */
  data: string;
  /** o worktree (HADES_WT); vazio fora de uma instalação */
  worktree: string;
  /** a skill que o install.sh e o Cerberus usam (HADES_SKILL_DIR) */
  skill: string;
}

export function ctxFromEnv(kit: string): PluginsCtx {
  return {
    data: process.env.HADES_DATA || kit,
    worktree: process.env.HADES_WT || "",
    skill: process.env.HADES_SKILL_DIR || join(home(), ".claude", "skills", "hades"),
  };
}

export const disabledFile = (c: PluginsCtx): string => join(c.data, "plugins.disabled");
export const stagingDir = (c: PluginsCtx): string => join(c.data, "plugins-staging"); // fora da pasta de pacotes para o resolvedor nunca achar um clone em prévia
export const lockFile = (c: PluginsCtx): string => join(c.data, "plugins.lock");
export const auditFile = (c: PluginsCtx): string => join(c.data, "logs", "plugins.log");

const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- git e estado

function gitTimeoutMs(): number {
  const raw = process.env.HADES_PLUGIN_GIT_TIMEOUT ?? "";
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) {
    throw new Refused("config", "HADES_PLUGIN_GIT_TIMEOUT ausente ou inválida: rode pelo plugins.sh (carrega as Configurações)");
  }
  return Number(raw) * 1000;
}

/** git sem hooks, sem fsmonitor e sem pedir credencial; timeout de rede das Configurações. */
export function git(args: string[], opts: { cwd?: string; net?: boolean; okCodes?: number[] } = {}): string {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  env.GIT_SSH_COMMAND ??= "ssh -o BatchMode=yes";
  const argv = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...(opts.cwd ? ["-C", opts.cwd] : []), ...args];
  const r = spawnSync("git", argv, { encoding: "utf8", env, timeout: opts.net ? gitTimeoutMs() : LOCAL_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Refused("git_timeout", `git ${args[0]} passou do tempo (HADES_PLUGIN_GIT_TIMEOUT)`);
  }
  if (!(opts.okCodes ?? [0]).includes(r.status ?? 1)) {
    const lastLine = splitLines((r.stderr ?? "").trim()).at(-1) ?? "sem saída";
    throw new Refused("git_failed", `git ${args[0]} falhou: ${lastLine}`);
  }
  return (r.stdout ?? "").trim();
}

export function disabled(c: PluginsCtx): Set<string> {
  const text = readText(disabledFile(c));
  if (text === undefined) return new Set();
  return new Set(splitLines(text).map((line) => line.trim()).filter((line) => NAME.test(line)));
}

function writeDisabled(c: PluginsCtx, names: Set<string>): void {
  const file = disabledFile(c);
  const tmp = `${file.replace(/\.[^./]*$/, "")}.tmp`;
  writeFileSync(tmp, [...names].sort(byCodepoint).map((n) => `${n}\n`).join(""));
  renameSync(tmp, file);
}

function audit(c: PluginsCtx, op: string, name: string, kv: Record<string, string> = {}): void {
  mkdirSync(dirname(auditFile(c)), { recursive: true });
  const when = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const who = process.env.HADES_PANEL_JOB ? "painel" : "terminal";
  const extra = Object.entries(kv).map(([k, v]) => ` ${k}=${v}`).join("");
  appendFileSync(auditFile(c), `${when} op=${op} plugin=${name} origem=${who}${extra}\n`);
}

/** URL sem credencial (um clone antigo, feito à mão, pode ter usuário e token no remote). */
export function safeUrl(url: string): string {
  return url.replace(/^([a-z+]+:\/\/)[^/@]*@/, "$1");
}

/** owner/name do remote do worktree desta instalação (null fora de repo). */
function thisRepo(c: PluginsCtx): string | null {
  return c.worktree ? resolveProject(c.worktree).repo : null;
}

function readProfile(file: string): JsonObject {
  const text = readText(file);
  if (text === undefined) {
    throw new Refused("invalid_pack", `profile.json ilegível: [Errno 2] No such file or directory: '${file}'`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Refused("invalid_pack", `profile.json ilegível: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(doc)) throw new Refused("invalid_pack", "profile.json não é um objeto");
  return doc;
}

const identityOf = (prof: JsonObject): JsonObject => (isObject(prof.identity) ? prof.identity : {});
const repoOf = (prof: JsonObject): string => String(identityOf(prof).repo ?? "");

/** A pasta do env/ do pacote (profile.env.pack), se existe e está dentro dele. */
export function envDir(pack: string, prof: JsonObject): string | null {
  const ep = isObject(prof.env) ? prof.env.pack : undefined;
  if (typeof ep !== "string" || !ep) return null;
  const dir = realpathMissingOk(resolve(pack, ep));
  const root = realpathMissingOk(pack);
  return (dir === root || dir.startsWith(root + sep)) && isDir(dir) ? dir : null;
}

interface CoreState {
  state: "ok" | "fora" | "invalido" | "sem-core";
  core: string;
  version: string;
  /** a faixa aceita núcleo anterior ao contrato atual de plugin */
  legacy?: boolean;
}

function coreState(prof: JsonObject): CoreState {
  const range = prof.core;
  const version = coreVersion();
  if (range === undefined || range === null) return { state: "sem-core", core: "", version };
  try {
    const inRange = coreOk(range, version);
    if (inRange && admitsLegacyCore(range)) return { state: "fora", core: pyText(range), version, legacy: true };
    return { state: inRange ? "ok" : "fora", core: pyText(range), version };
  } catch {
    return { state: "invalido", core: pyText(range), version };
  }
}

function isMine(prof: JsonObject, repo: string | null): boolean {
  return Boolean(repo) && repoOf(prof).toLowerCase() === (repo as string).toLowerCase();
}

// ---------------------------------------------------------------- o que o pacote acrescenta e o que executa

function tsv(file: string): string[][] {
  const text = readText(file);
  if (text === undefined) return [];
  return splitLines(text).filter((line) => line.trim() && !line.startsWith("#")).map((line) => line.split("\t"));
}

interface Contribution {
  keys: { key: string; group: string; label: string }[];
  steps: { id: string; label: string }[];
  checks: string[];
  doctor: boolean;
  pages: { id: string; label: string }[];
  routes: string[];
  actions: string[];
}

const stem = (file: string): string => {
  const base = basename(file);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

function panelOf(envd: string): JsonObject {
  const text = readText(join(envd, "plugin.json"));
  if (text === undefined) return {};
  try {
    const doc: unknown = JSON.parse(text);
    if (!isObject(doc)) return {};
    return isObject(doc.panel) ? doc.panel : {};
  } catch {
    return {};
  }
}

/** Chaves, passos, checagens, páginas, rotas e ações que o env/ soma ao núcleo (lidos dos arquivos, sem executar). */
export function contributes(envd: string | null): Contribution {
  const out: Contribution = { keys: [], steps: [], checks: [], doctor: false, pages: [], routes: [], actions: [] };
  if (!envd) return out;
  out.keys = tsv(join(envd, "config.tsv"))
    .filter((c) => c.length === 7 && CFG_KEY.test(c[0] as string))
    .map((c) => ({ key: c[0] as string, group: c[3] as string, label: c[4] as string }));
  out.steps = tsv(join(envd, "onboard.tsv"))
    .filter((c) => !(c[0] as string).startsWith("@") && c.length > 2)
    .map((c) => ({ id: c[1] as string, label: c[2] as string }));
  out.checks = pyGlob(join(envd, "checks"), "*.sh").map(stem).sort(byCodepoint);
  out.doctor = isFile(join(envd, "doctor.sh"));
  const panel = panelOf(envd);
  const list = (key: string): unknown[] => {
    const value = panel[key];
    return Array.isArray(value) ? value.filter((x) => isObject(x) || typeof x === "string") : [];
  };
  out.pages = list("pages").filter(isObject).map((p) => ({ id: pyText(p.id), label: pyText(p.label || p.id) }));
  out.routes = list("routes").filter(isObject).map((r) => `${pyText(r.method || "GET").toUpperCase()} ${pyText(r.path)}`);
  out.actions = list("actions").filter((a): a is string => typeof a === "string");
  return out;
}

interface RunFile {
  path: string;
  bytes: number;
  lines: number;
  sha256: string;
  text: string | null;
  cut: boolean;
}

/** Os arquivos que executam, com tamanho, sha256 e o texto (até o orçamento), e os outros scripts do env/. */
export function runs(pack: string, envd: string | null, budget: { left: number }): { files: RunFile[]; other: string[] } {
  const files: RunFile[] = [];
  const other: string[] = [];
  if (!envd) return { files, other };
  const seen = new Set<string>();
  for (const pattern of RUNS) {
    for (const file of pyGlob(envd, pattern).sort(comparePaths)) {
      if (!isFile(file)) continue;
      seen.add(file);
      const raw = readFileSync(file);
      const text = raw.length <= budget.left ? raw.toString("utf8") : null;
      if (text !== null) budget.left -= raw.length;
      files.push({
        path: relative(pack, file), bytes: raw.length, lines: raw.filter((b) => b === 0x0a).length,
        sha256: createHash("sha256").update(raw).digest("hex"), text, cut: text === null,
      });
    }
  }
  for (const file of pyGlob(envd, "**/*").sort(comparePaths)) {
    const rel = relative(envd, file);
    const parts = rel.split(sep);
    const skipped = parts.some((p) => (ENV_SKIP as readonly string[]).includes(p));
    if (isFile(file) && !seen.has(file) && ENV_FILE_EXTS.some((ext) => file.endsWith(ext) && basename(file) !== ext) && !skipped) {
      other.push(relative(pack, file));
    }
  }
  return { files, other };
}

// ---------------------------------------------------------------- listar

function unpublished(pack: string): number {
  const n = git(["rev-list", "--count", "--branches", "--not", "--remotes"], { cwd: pack });
  return /^\d+$/.test(n) ? Number(n) : 0;
}

function describe(c: PluginsCtx, pack: string, repo: string | null, off: Set<string>): Dict {
  const prof = readProfile(join(pack, "profile.json"));
  const name = basename(pack);
  const mine = isMine(prof, repo);
  const info: Dict = {
    name, repo: isObject(prof.identity) ? (prof.identity.repo ?? null) : null,
    mine, state: !mine ? "outro-projeto" : off.has(name) ? "desligado" : "ativo",
    core: coreState(prof), errors: validateFile(join(pack, "profile.json")), adds: contributes(envDir(pack, prof)),
  };
  if (!existsSync(join(pack, ".git"))) {
    return { ...info, url: null, branch: null, commit: null, dirty: false, unpublished: 0, behind: 0, git: false };
  }
  // config, não remote get-url: o get-url aplica o insteadOf e mostraria o destino reescrito, não a URL do pacote
  const url = git(["config", "--get", "remote.origin.url"], { cwd: pack, okCodes: [0, 1] });
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: pack });
  const behind = git(["rev-list", "--count", "HEAD..@{u}"], { cwd: pack, okCodes: [0, 128] });
  return {
    ...info, url: safeUrl(url) || null, branch, commit: git(["rev-parse", "HEAD"], { cwd: pack }),
    dirty: Boolean(git(["status", "--porcelain"], { cwd: pack })), unpublished: unpublished(pack),
    behind: /^\d+$/.test(behind) ? Number(behind) : 0, git: true,
  };
}

export function listPacks(c: PluginsCtx): Dict {
  const repo = thisRepo(c);
  const off = disabled(c);
  const root = packsRoot();
  const packs: Dict[] = [];
  for (const file of pyGlob(root, "*/profile.json").sort(comparePaths)) {
    try {
      packs.push(describe(c, dirname(file), repo, off));
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      packs.push({ name: basename(dirname(file)), error: error.message, code: error.code });
    }
  }
  return { ok: true, packs, repo, version: coreVersion(), packsRoot: root };
}

function findPack(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new Refused("unknown_pack", `nome de pacote inválido: ${pyRepr(name)}`);
  const pack = join(packsRoot(), name);
  if (!isFile(join(pack, "profile.json"))) throw new Refused("unknown_pack", `não há o pacote ${name} em ${packsRoot()}`);
  return pack;
}

// ---------------------------------------------------------------- adicionar

function checkUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || !url || url.length > URL_MAX) {
    throw new Refused("invalid_url", `URL vazia ou com mais de ${URL_MAX} caracteres`);
  }
  if (/^[a-z+]+:\/\/[^/]*@/.test(url)) {
    throw new Refused("url_credentials", "URL com credencial embutida: use a URL sem usuário nem token (o git usa a sua credencial)");
  }
  if (!(URL_HTTPS.test(url) || URL_SSH.test(url))) {
    throw new Refused("invalid_url", "só https://<host>/<caminho> ou git@<host>:<caminho>");
  }
}

function cleanStaging(c: PluginsCtx): void {
  const now = Date.now() / 1000;
  const root = stagingDir(c);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(root, name);
    if (isDir(dir) && now - statSync(dir).mtimeMs / 1000 > STAGING_TTL_S) rmSync(dir, { recursive: true, force: true });
  }
}

/** [código, mensagem] do que impede ativar o pacote, ou null. Pacote inválido ou fora da faixa nunca ativa. */
function gate(pack: string, prof: JsonObject, adding: boolean): [string, string] | null {
  const errs = validateFile(join(pack, "profile.json"));
  if (errs.length > 0) return ["invalid_pack", `pacote inválido: ${errs.slice(0, 5).join("; ")}`];
  const core = coreState(prof);
  if (core.state === "fora" || core.state === "invalido") {
    if (core.legacy) return ["core_out_of_range", legacyCoreMessage(String(prof.name), core.core)];
    return ["core_out_of_range", `o plugin pede o núcleo ${core.core} e o instalado é o ${core.version}`];
  }
  const env = envDir(pack, prof);
  if (env !== null && isFile(join(env, "panel", "api.py"))) {
    return ["legacy_api_py", "o pacote traz panel/api.py, contrato anterior à 5.0 que o painel não lê mais: porte para panel/api.ts e declare core >=5 no profile.json (reference/projects.md §Plugin)"];
  }
  if (adding) {
    const root = packsRoot();
    const name = String(prof.name);
    if (existsSync(join(root, name))) return ["already_installed", `já existe o pacote ${name}: use Atualizar`];
    const ident = repoOf(prof).toLowerCase();
    for (const file of pyGlob(root, "*/profile.json").sort(comparePaths)) {
      let other: JsonObject;
      try {
        other = readProfile(file);
      } catch (error) {
        if (error instanceof Refused) continue; // pacote ilegível na pasta: o list o mostra com o erro; não decide duplicidade
        throw error;
      }
      if (isObject(other.identity) && String(other.identity.repo ?? "").toLowerCase() === ident) {
        return ["duplicate_repo", `o pacote ${basename(dirname(file))} já é o plugin de ${ident}`];
      }
    }
  }
  return null;
}

const refuse = (why: [string, string], preview?: Dict): Refused => new Refused(why[0], why[1], preview);

/** Momento `plugin` do Cerberus (reference/cerberus.md): a avaliação conjunta antes de ativar. Barra = recusa.
 *  packDir: o clone em prévia no add, o pacote instalado no update e no enable. */
function cerberusGate(c: PluginsCtx, name: string, op: string, commit: string, packDir: string): void {
  // as guardas exec herdam o ambiente deste processo: os três lugares vão sempre, mesmo quando vieram do padrão
  for (const [k, v] of [["HADES_DATA", c.data], ["HADES_PACKS_ROOT", packsRoot()], ["HADES_SKILL_DIR", c.skill]] as const) {
    if (!(k in process.env)) process.env[k] = v;
  }
  let result: ReturnType<typeof evaluate>;
  try {
    result = evaluate("plugin", { plugin: name, op, commit, pack_dir: packDir }, c.worktree || c.data);
  } catch (error) {
    if (error instanceof Recusa) throw new Refused("cerberus_invalid", `o Cerberus não avaliou: ${error.message}`);
    throw error;
  }
  const barred: string[] = [];
  for (const v of result.vereditos) {
    const evidencia = Array.isArray(v.evidencia) ? (v.evidencia as Dict[]) : [];
    const detalhe = v.detalhe || evidencia[0]?.conferido;
    process.stderr.write(`cerberus ${String(v.efeito)} ${String(v.cabeca)}/${String(v.guarda)}: ${String(detalhe)}\n`);
    if (v.efeito === "barra") barred.push(`${String(v.cabeca)}/${String(v.guarda)}`);
  }
  if (result.resultado === "barra") throw new Refused("cerberus_barred", `o Cerberus barrou: ${barred.join("; ")}`);
}

export function addPreview(c: PluginsCtx, url: unknown): Dict {
  checkUrl(url);
  const staging = stagingDir(c);
  mkdirSync(staging, { recursive: true });
  cleanStaging(c);
  const sid = randomBytes(SHA_LEN_HEX).toString("hex");
  const base = join(staging, sid);
  mkdirSync(base);
  try {
    git(["clone", "--no-recurse-submodules", "-q", "--", url, join(base, "clone")], { net: true });
    if (!isFile(join(base, "clone", "profile.json"))) {
      throw new Refused("no_profile", "o repositório não tem profile.json na raiz: não é um plugin do Hades");
    }
    const prof = readProfile(join(base, "clone", "profile.json"));
    const name = prof.name;
    if (typeof name !== "string" || !NAME.test(name)) throw new Refused("invalid_pack", `name do profile.json fora do padrão: ${pyRepr(name)}`);
    const pack = join(base, name);
    renameSync(join(base, "clone"), pack); // o validate confere o name contra a pasta
    const repo = thisRepo(c);
    const { files, other } = runs(pack, envDir(pack, prof), { left: PREVIEW_MAX });
    const preview: Dict = {
      id: sid, name, url: safeUrl(url), branch: git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: pack }),
      commit: git(["rev-parse", "HEAD"], { cwd: pack }), subject: git(["log", "-1", "--format=%s"], { cwd: pack }),
      repo: isObject(prof.identity) ? (prof.identity.repo ?? null) : null, mine: isMine(prof, repo), core: coreState(prof),
      errors: validateFile(join(pack, "profile.json")), adds: contributes(envDir(pack, prof)), runs: files, other,
      activates: isMine(prof, repo) && !disabled(c).has(name),
    };
    const why = gate(pack, prof, true);
    if (why) throw refuse(why, preview);
    writeFileSync(join(base, "preview.json"), pyJsonDumps(preview));
    audit(c, "add-preview", name, { commit: String(preview.commit), url: String(preview.url) });
    return { ...preview, ok: true };
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    throw error;
  }
}

/** shutil.move: renomeia e, entre sistemas de arquivos, copia e apaga. */
function movePath(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

export function addApply(c: PluginsCtx, sid: unknown, sha: unknown, check: boolean): Dict {
  const staging = stagingDir(c);
  if (typeof sid !== "string" || !PREVIEW_ID.test(sid) || !isFile(join(staging, sid, "preview.json"))) {
    throw new Refused("preview_expired", "a prévia não existe mais (expira em 1 h): confira de novo");
  }
  const base = join(staging, sid);
  const preview = JSON.parse(readFileSync(join(base, "preview.json"), "utf8")) as Dict;
  const name = String(preview.name);
  const pack = join(base, name);
  if (typeof sha !== "string" || !SHA.test(sha) || sha !== preview.commit || git(["rev-parse", "HEAD"], { cwd: pack }) !== sha) {
    throw new Refused("commit_mismatch", "o commit confirmado não é o da prévia");
  }
  const prof = readProfile(join(pack, "profile.json"));
  const why = gate(pack, prof, true);
  if (why) throw refuse(why);
  const activates = isMine(prof, thisRepo(c)) && !disabled(c).has(name);
  if (check) return { ok: true, name, commit: sha, activates };
  cerberusGate(c, name, "add", sha, pack); // antes do move: a guarda vê o clone em prévia
  const dest = join(packsRoot(), name);
  mkdirSync(dirname(dest), { recursive: true });
  movePath(pack, dest);
  rmSync(base, { recursive: true, force: true });
  audit(c, "add", name, { commit: sha, url: String(preview.url) });
  process.stderr.write(`pacote ${name} @ ${sha.slice(0, SHORT_SHA)} em ${dest}\n`);
  if (activates) reinstallAndRestart(c);
  return { ok: true, name, commit: sha, activates };
}

// ---------------------------------------------------------------- atualizar

function requireClean(pack: string): void {
  if (git(["status", "--porcelain"], { cwd: pack })) {
    throw new Refused("local_changes", `${basename(pack)} tem mudança local não commitada: commite ou descarte antes`);
  }
}

function upstream(pack: string): string {
  const up = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: pack, okCodes: [0, 128] });
  if (!up || !up.includes("/")) throw new Refused("no_upstream", `a branch de ${basename(pack)} não acompanha uma branch remota`);
  return up;
}

/** old está na história de new (atualizar é só avançar: nada local se perde). */
function isAncestor(pack: string, old: string, current: string): boolean {
  try {
    git(["merge-base", "--is-ancestor", old, current], { cwd: pack });
  } catch (error) {
    if (error instanceof Refused) return false;
    throw error;
  }
  return true;
}

/** profile.json do commit novo, numa pasta com o nome do pacote (o validate confere o nome contra a pasta). */
function newProfile(pack: string, sha: string, tmp: string): { dir: string; prof: JsonObject } {
  const dir = join(tmp, basename(pack));
  mkdirSync(dir);
  writeFileSync(join(dir, "profile.json"), git(["show", `${sha}:profile.json`], { cwd: pack }));
  return { dir, prof: readProfile(join(dir, "profile.json")) };
}

const trimSlashes = (text: string): string => text.replace(/^\/+|\/+$/g, "");
const RUN_PATHS = ["post-install.sh", "panel/api.ts", "panel/ui", "doctor.sh", "checks", "commands"] as const;

function withTmp<T>(fn: (tmp: string) => T): T {
  const tmp = join(process.env.TMPDIR || "/tmp", `hades-plugins-${randomBytes(SHA_LEN_HEX).toString("hex")}`);
  mkdirSync(tmp, { recursive: true });
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function updatePreview(c: PluginsCtx, name: unknown): Dict {
  const pack = findPack(name);
  const nm = String(name);
  requireClean(pack);
  const up = upstream(pack);
  git(["fetch", "-q", "--no-recurse-submodules", "--", up.split("/")[0] as string], { cwd: pack, net: true });
  const cur = git(["rev-parse", "HEAD"], { cwd: pack });
  const target = git(["rev-parse", "@{u}"], { cwd: pack });
  const base: Dict = { ok: true, name: nm, upstream: up, commit: cur, target };
  if (cur === target) return { ...base, upToDate: true };
  if (!isAncestor(pack, cur, target)) {
    throw new Refused("not_fast_forward", `${nm} tem commits que o remote não tem: publique ou descarte antes de atualizar`);
  }
  const oldProf = readProfile(join(pack, "profile.json"));
  const { errs, nprof } = withTmp((tmp) => {
    const np = newProfile(pack, target, tmp);
    return { errs: validateFile(join(np.dir, "profile.json")), nprof: np.prof };
  });
  const roots = new Set<string>();
  for (const prof of [oldProf, nprof]) {
    const ep = isObject(prof.env) && typeof prof.env.pack === "string" ? trimSlashes(prof.env.pack) : "";
    if (ep) for (const p of RUN_PATHS) roots.add(`${ep}/${p}`);
  }
  const paths = [...roots].sort(byCodepoint);
  const diff = paths.length > 0 ? git(["diff", "--no-color", "--no-ext-diff", cur, target, "--", ...paths], { cwd: pack }) : "";
  const cut = Buffer.byteLength(diff) > PREVIEW_MAX;
  const core = coreState(nprof);
  const preview: Dict = {
    ...base, commits: splitLines(git(["log", "--format=%h %s", "-n", UPDATE_LOG_MAX, `${cur}..${target}`], { cwd: pack })),
    stat: git(["diff", "--stat", "--no-color", cur, target], { cwd: pack }),
    diff: Buffer.from(diff).subarray(0, PREVIEW_MAX).toString("utf8"),
    cut, runsChanged: Boolean(diff), errors: errs, core, mine: isMine(nprof, thisRepo(c)),
  };
  if (errs.length > 0) throw new Refused("invalid_pack", `o commit novo deixa o pacote inválido: ${errs.slice(0, 5).join("; ")}`, preview);
  if (core.state === "fora" || core.state === "invalido") {
    throw new Refused("core_out_of_range", `o commit novo pede o núcleo ${core.core} e o instalado é o ${core.version}`, preview);
  }
  audit(c, "update-preview", nm, { commit: cur, target });
  return preview;
}

export function updateApply(c: PluginsCtx, name: unknown, sha: unknown, check: boolean): Dict {
  const pack = findPack(name);
  const nm = String(name);
  requireClean(pack);
  upstream(pack);
  const cur = git(["rev-parse", "HEAD"], { cwd: pack });
  const target = git(["rev-parse", "@{u}"], { cwd: pack });
  if (typeof sha !== "string" || !SHA.test(sha) || sha !== target) {
    throw new Refused("commit_mismatch", "o commit confirmado não é o da prévia: confira de novo");
  }
  if (cur === target) throw new Refused("up_to_date", `${nm} já está em ${target.slice(0, SHORT_SHA)}`);
  if (!isAncestor(pack, cur, target)) throw new Refused("not_fast_forward", `${nm} tem commits que o remote não tem`);
  const { why, nprof } = withTmp((tmp) => {
    const np = newProfile(pack, target, tmp);
    return { why: gate(np.dir, np.prof, false), nprof: np.prof };
  });
  if (why) throw refuse(why);
  const active = isMine(nprof, thisRepo(c)) && !disabled(c).has(nm);
  if (check) return { ok: true, name: nm, commit: cur, target, activates: active };
  cerberusGate(c, nm, "update", target, pack);
  git(["merge", "--ff-only", "-q", target], { cwd: pack });
  audit(c, "update", nm, { commit: cur, target });
  if (active) reinstallAndRestart(c);
  return { ok: true, name: nm, commit: cur, target, activates: active };
}

// ---------------------------------------------------------------- ligar, desligar, remover

function mineOrRefuse(c: PluginsCtx, pack: string): JsonObject {
  const prof = readProfile(join(pack, "profile.json"));
  if (!isMine(prof, thisRepo(c))) {
    throw new Refused("other_project", `${basename(pack)} é o plugin de outro projeto: nesta instalação vale o pacote do repo ${thisRepo(c) || "(worktree sem remote)"}`);
  }
  return prof;
}

export function enable(c: PluginsCtx, name: unknown, check: boolean): Dict {
  const pack = findPack(name);
  const nm = String(name);
  const prof = mineOrRefuse(c, pack);
  if (!disabled(c).has(nm)) return { ok: true, name: nm, changed: false };
  const why = gate(pack, prof, false);
  if (why) throw refuse(why);
  if (check) return { ok: true, name: nm, changed: true };
  cerberusGate(c, nm, "enable", git(["rev-parse", "HEAD"], { cwd: pack }), pack);
  const off = disabled(c);
  off.delete(nm);
  writeDisabled(c, off);
  audit(c, "enable", nm);
  reinstallAndRestart(c);
  return { ok: true, name: nm, changed: true };
}

export function disable(c: PluginsCtx, name: unknown, check: boolean, reason = "disable"): Dict {
  const pack = findPack(name);
  const nm = String(name);
  mineOrRefuse(c, pack);
  if (disabled(c).has(nm)) return { ok: true, name: nm, changed: false };
  if (check) return { ok: true, name: nm, changed: true };
  writeDisabled(c, new Set([...disabled(c), nm]));
  audit(c, reason, nm);
  reinstallAndRestart(c);
  return { ok: true, name: nm, changed: true };
}

export function remove(c: PluginsCtx, name: unknown, confirm: unknown, check: boolean): Dict {
  const pack = findPack(name);
  const nm = String(name);
  if (confirm !== nm) throw new Refused("name_mismatch", `para remover, digite o nome do pacote (${nm})`);
  if (existsSync(join(pack, ".git"))) {
    requireClean(pack);
    if (git(["stash", "list"], { cwd: pack })) throw new Refused("local_changes", `${nm} tem stash: aplique ou descarte antes`);
    const n = unpublished(pack);
    if (n) throw new Refused("unpublished_commits", `${nm} tem ${n} commit(s) que nenhum remote tem: publique (git push) antes de remover`);
  }
  const mine = isMine(readProfile(join(pack, "profile.json")), thisRepo(c));
  if (check) return { ok: true, name: nm, active: mine && !disabled(c).has(nm) };
  if (mine && !disabled(c).has(nm)) disable(c, nm, false, "remove-disable"); // tira do $D o que o env/ dele pôs, com o pacote ainda presente
  rmSync(pack, { recursive: true });
  const off = disabled(c);
  off.delete(nm);
  writeDisabled(c, off);
  audit(c, "remove", nm);
  return { ok: true, name: nm };
}

// ---------------------------------------------------------------- reinstalar e reiniciar o painel

function reinstallAndRestart(c: PluginsCtx): void {
  process.stderr.write("reinstalando o kit (install.sh)…\n");
  const r = spawnSync("bash", [join(c.skill, "kit", "install.sh")], {
    env: { ...process.env, HADES_WT: c.worktree, HADES_DATA: c.data },
    stdio: ["inherit", process.stderr.fd, process.stderr.fd],
  });
  if (r.status !== 0) throw new Refused("install_failed", `install.sh saiu com ${r.status} (o log acima diz por quê)`);
  restartPanel(c);
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reinicia o painel (<HU>-panel) só se ele é o desta instalação: num $D de teste, o panel.sh regravaria a unit real. */
function restartPanel(c: PluginsCtx): void {
  const unit = `${unitPrefix(c.data)}-panel`;
  const manager = serviceManager();
  const envs = manager.unitEnvironment(unit);
  if (manager.isActive(unit) && new RegExp(`(^|\\s)"?HADES_DATA=${escapeRegex(c.data)}"?(\\s|$)`).test(envs)) {
    process.stderr.write("reiniciando o painel (páginas e rotas do plugin são lidas na subida)\n");
    spawnSync("bash", [join(c.data, "panel.sh"), "restart"], { stdio: ["inherit", process.stderr.fd, process.stderr.fd] });
  } else {
    process.stderr.write(`o painel desta instalação não está no ar pela unit ${unit}: reinicie-o para ler o plugin\n`);
  }
}
