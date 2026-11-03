// Guardas do Limiar em TypeScript (porte de loop/cerberus/limiar/checks/limiar.py; reference/cerberus/limiar.md): o momento
// `plugin`. Tudo é lido do objeto do commit (git ls-tree/cat-file), nunca do que está solto na pasta. A regra do que executa
// (RUNS), a prévia e o log de auditoria são de plugins.ts: aqui só se importa e se confere. Falha ao conferir vira `barra`
// com a evidência do que faltou, nunca `ok` calado.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVID_MAX, TEXT_MAX } from "./cerberus.ts";
import { fnmatchCase, type CheckEnv, type CheckVerdict, type Evid, type Resultado } from "./cerberus-check.ts";
import { ensaiar, escritaDeclarada, redeDeclarada } from "./cerberus-ensaio.ts";
import { PLUGIN_FILES } from "./install-copy.ts";
import { ENV_SKIP, NAME, RUNS, auditFile, stagingDir, type PluginsCtx } from "./plugins.ts";
import { packsRoot } from "./project.ts";
import { skillRoot } from "./paths.ts";
import { pyRepr, splitLines } from "./pyjson.ts";

const SHA = /^[0-9a-f]{40}$/;
const NOT_COPIED = ["post-install.sh", "renamed.tsv", "assets", "reference", "__pycache__"];
const OPS = ["add", "update", "enable"];
const SCAN_MAX = 1_000_000; // bytes lidos por arquivo na varredura
const HASH_MAX = 1 << 30;
const GIT_TIMEOUT_MS = 30_000;
const GIT_BUFFER_MAX = 256 * 1024 * 1024;
const SHORT_SHA = 12;
const DETAIL_MAX = 1000;
const SNIPPET = 120;
const SNIPPET_SETTINGS = 100;
const LISTED_MAX = 6;
const NAMED_MAX = 5;
const MINUS = "−"; // U+2212, como no texto original da evidência
const W = String.raw`\p{L}\p{N}_`; // \w e \b do Python são Unicode; o JS é só ASCII
const BEFORE = `(?<![${W}])`;
const AFTER = `(?![${W}])`;

const TAMPER: ReadonlyArray<readonly [string, RegExp]> = [
  ["mexe no hook hades-guard", /hades[-_]guard/i],
  ["mexe no Cerberus (guarda, modo ou histórico)", /hades[-_]cerberus|loop\/cerberus|_maquina\/cerberus|api\/cerberus|HADES_CERBERUS_/i],
];
const SETTINGS = /settings(\.local)?\.json/i;
const SKILL_WRITE_TARGET = new RegExp(`skills/hades|HADES_SKILL(_DIR)?${AFTER}`, "u");
const SKILL_WRITE_ACTION = new RegExp(
  `${BEFORE}(cp|mv|ln|rsync|tee|install|rm|chmod)${AFTER}|sed\\s+-i|>>?\\s*\\S|open\\([^)]*['"][wa]`, "u",
);

/** Não consegui conferir: vira barra, com a evidência do que faltou (nunca ok em silêncio). */
export class Falha extends Error {}

type Dict = Record<string, unknown>;
type Verdict = readonly [Resultado, Evid[], string];
type Guard = (ctx: LimiarCtx, ce: CheckEnv) => Verdict;

interface LimiarCtx { plugin: string; commit: string; op: string; packDir?: string }

const isDict = (v: unknown): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);
const short = (sha: string): string => sha.slice(0, SHORT_SHA);
const sorted = (items: Iterable<string>): string[] => [...items].sort();
const orDash = (items: string[]): string => (items.length ? pyRepr(items) : "-");

function ev(conferido: unknown, onde: unknown): Evid {
  return { conferido: String(conferido).slice(0, TEXT_MAX), onde: String(onde).slice(0, TEXT_MAX) };
}

/** str() de um valor lido do JSON, como o Python o mostra no texto da evidência. */
function pyStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}

function parseJson(raw: string | Buffer, what: string): unknown {
  try {
    return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch (e) {
    throw new Falha(`${what}: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- git pelo objeto

function gitRaw(ce: CheckEnv, pack: string, ...args: string[]): Buffer {
  const argv = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", pack, ...args];
  const r = spawnSync("git", argv, { env: { ...ce.env, GIT_TERMINAL_PROMPT: "0" }, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_BUFFER_MAX });
  if (r.error) throw new Falha(`git ${args[0]} em ${pack} não rodou: ${r.error.message}`);
  if (r.status !== 0) {
    const last = splitLines(r.stderr.toString("utf8").trim()).at(-1) ?? "sem saída";
    throw new Falha(`git ${args[0]} em ${pack} saiu ${r.status}: ${last}`);
  }
  return r.stdout;
}

const gitTxt = (ce: CheckEnv, pack: string, ...args: string[]): string => gitRaw(ce, pack, ...args).toString("utf8").trim();

/** O conteúdo de um commit do pacote: lista (ls-tree) e leitura (cat-file) pelo objeto, sem checkout. */
class Tree {
  readonly files = new Map<string, { mode: string; blob: string }>();

  private readonly ce: CheckEnv;
  readonly pack: string;
  readonly commit: string;

  constructor(ce: CheckEnv, pack: string, commit: string) {
    this.ce = ce;
    this.pack = pack;
    this.commit = commit;
    for (const ent of gitRaw(ce, pack, "ls-tree", "-r", "-z", commit).toString("utf8").split("\0")) {
      if (!ent) continue;
      const tab = ent.indexOf("\t");
      const [mode, kind, blob] = ent.slice(0, tab).split(/\s+/);
      if (kind === "blob") this.files.set(ent.slice(tab + 1), { mode: mode as string, blob: blob as string });
    }
  }

  read(path: string, limit = SCAN_MAX): Buffer {
    const entry = this.files.get(path);
    if (!entry) throw new Falha(`'${path}'`);
    return gitRaw(this.ce, this.pack, "cat-file", "blob", entry.blob).subarray(0, limit);
  }

  blobText(blob: string): Buffer {
    return gitRaw(this.ce, this.pack, "cat-file", "blob", blob);
  }

  profile(): Dict {
    if (!this.files.has("profile.json")) throw new Falha(`o commit ${short(this.commit)} não tem profile.json`);
    const prof = parseJson(this.read("profile.json"), `profile.json do commit ${short(this.commit)} ilegível`);
    return isDict(prof) ? prof : {};
  }

  envPrefix(): string | null {
    const env = this.profile().env;
    const raw = isDict(env) ? env.pack : undefined;
    if (typeof raw !== "string" || !raw.replace(/^\/+|\/+$/g, "")) return null;
    const trimmed = raw.replace(/^\/+|\/+$/g, "");
    if (trimmed.split("/").includes("..")) throw new Falha(`env.pack fora do pacote: ${pyRepr(trimmed)}`);
    return `${trimmed}/`;
  }

  /** {caminho relativo ao env/: blob} */
  envFiles(): Map<string, string> {
    const prefix = this.envPrefix();
    const out = new Map<string, string>();
    if (!prefix) return out;
    for (const [path, { blob }] of this.files) if (path.startsWith(prefix)) out.set(path.slice(prefix.length), blob);
    return out;
  }
}

/** O que executa: a regra RUNS de plugins.ts, os outros .sh do env/ (vão para o $D) e os .js e .ts do panel/. */
function isExec(rel: string): boolean {
  if (inPreview(rel)) return true;
  const top = rel.split("/")[0] as string;
  if ((ENV_SKIP as readonly string[]).includes(top)) return false;
  return rel.endsWith(".sh") || (top === "panel" && (rel.endsWith(".js") || rel.endsWith(".ts")));
}

const inPreview = (rel: string): boolean => RUNS.some((pat) => fnmatchCase(rel, pat));

interface Manifest { files: Map<string, string>; pages: Set<string>; routes: Set<string>; actions: Set<string> }

/** Arquivos executáveis {rel: blob}, páginas, rotas e ações do plugin.json do commit. */
function manifest(tree: Tree): Manifest {
  const env = tree.envFiles();
  const files = new Map([...env].filter(([rel]) => isExec(rel)));
  const pages = new Set<string>();
  const routes = new Set<string>();
  const actions = new Set<string>();
  const pluginJson = env.get("plugin.json");
  if (pluginJson !== undefined) {
    const pj = parseJson(tree.blobText(pluginJson), `plugin.json do commit ${short(tree.commit)} ilegível`);
    const panel = isDict(pj) && isDict(pj.panel) ? pj.panel : {};
    const items = (key: string): unknown[] => (Array.isArray(panel[key]) ? (panel[key] as unknown[]) : []);
    for (const page of items("pages")) if (isDict(page)) pages.add(pyStr(page.id));
    for (const route of items("routes")) {
      if (!isDict(route)) continue;
      const method = route.method ? pyStr(route.method).toUpperCase() : "GET";
      routes.add(`${method} ${pyStr(route.path)}`);
    }
    const rawActions = panel.actions;
    const list = typeof rawActions === "string" ? [...rawActions] : Array.isArray(rawActions) ? (rawActions as unknown[]) : [];
    for (const action of list) if (typeof action === "string") actions.add(action);
  }
  return { files, pages, routes, actions };
}

const sha256Of = (tree: Tree, rel: string): string =>
  createHash("sha256").update(tree.read(`${tree.envPrefix()}${rel}`, HASH_MAX)).digest("hex");

// ---------------------------------------------------------------- contexto e onde está o pacote

function context(ce: CheckEnv): LimiarCtx {
  const { plugin, commit, op, pack_dir: packDir } = ce.ctx;
  const missing = ["plugin", "commit", "op"].filter((key) => !(ce.ctx[key] ?? "").trim());
  if (missing.length) {
    throw new Falha(`o contexto do momento plugin não trouxe: ${missing.join(", ")} (--ctx plugin=… commit=… op=add|update|enable)`);
  }
  if (!OPS.includes(op as string)) throw new Falha(`op desconhecido: ${pyRepr(op)} (add, update ou enable)`);
  if (!NAME.test(plugin as string)) throw new Falha(`nome de plugin inválido: ${pyRepr(plugin)}`);
  return { plugin: plugin as string, commit: commit as string, op: op as string, packDir: packDir || undefined };
}

function pluginsCtx(ce: CheckEnv): PluginsCtx {
  const skill = ce.skill || skillRoot;
  return { data: ce.env.HADES_DATA || join(skill, "kit"), worktree: ce.env.HADES_WT ?? "", skill };
}

function installedPack(ctx: LimiarCtx, ce: CheckEnv): string {
  const root = packsRoot(ce.env);
  const pack = ctx.packDir ?? join(root, ctx.plugin);
  if (!existsSync(join(pack, ".git"))) throw new Falha(`não há o pacote git ${ctx.plugin} em ${root}`);
  return pack;
}

function readPreview(file: string): Dict {
  const pv = parseJson(readFileSync(file, "utf8"), `${file} ilegível`);
  if (!isDict(pv)) throw new Falha(`${file} não é um objeto`);
  return pv;
}

const previewMatches = (file: string, ctx: LimiarCtx): boolean => {
  try {
    const pv = readPreview(file);
    return pv.name === ctx.plugin && pv.commit === ctx.commit;
  } catch (e) {
    if (e instanceof Falha || (e as NodeJS.ErrnoException).code) return false;
    throw e;
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** (pasta do clone em prévia, preview.json) do plugin em plugins-staging com este commit; a mais recente vale. */
function staged(ctx: LimiarCtx, ce: CheckEnv): { dir: string; preview: Dict } {
  const staging = stagingDir(pluginsCtx(ce));
  let found: { dir: string; file: string } | undefined;
  if (ctx.packDir) {
    const file = join(dirname(ctx.packDir), "preview.json");
    if (isFile(file)) found = { dir: ctx.packDir, file };
  } else if (isDirectory(staging)) {
    const files = readdirSync(staging).sort().map((id) => join(staging, id, "preview.json")).filter(isFile)
      .filter((file) => isDirectory(dirname(file)) && previewMatches(file, ctx));
    const [newest] = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (newest) found = { dir: join(dirname(newest), String(readPreview(newest).name)), file: newest };
  }
  if (!found) {
    throw new Falha(`nenhuma prévia de ${ctx.plugin} @ ${short(ctx.commit)} em ${staging} (expirou ou nunca foi mostrada)`);
  }
  return { dir: found.dir, preview: readPreview(found.file) };
}

/** Linhas do log de auditoria de plugins.ts como dicts (op, plugin, commit, target…). */
function audited(ce: CheckEnv): Array<Record<string, string>> {
  const file = auditFile(pluginsCtx(ce));
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Falha(`não consegui ler ${file}: ${(e as Error).message}`);
  }
  return splitLines(text).filter((ln) => ln.trim()).map((ln) => Object.fromEntries(
    ln.trim().split(/\s+/).slice(1).filter((kv) => kv.includes("=")).map((kv) => {
      const at = kv.indexOf("=");
      return [kv.slice(0, at), kv.slice(at + 1)] as const;
    }),
  ));
}

// ---------------------------------------------------------------- guarda: commit-fixado

const commitFixado: Guard = (ctx, ce) => {
  const { plugin, commit, op } = ctx;
  const evid: Evid[] = [];
  if (!SHA.test(commit)) {
    return ["barra", [ev(`commit ${pyRepr(commit)} não é um sha completo de 40 hex (ref móvel, branch, tag ou abreviado)`, "contexto do momento (commit)")],
      "o plugin tem de ser fixado num sha exato, o da prévia que o dono viu"];
  }
  const bad: string[] = [];
  if (op === "add") {
    const { dir, preview } = staged(ctx, ce);
    const head = gitTxt(ce, dir, "rev-parse", "HEAD");
    evid.push(ev(`HEAD do clone em prévia = ${short(head)}, commit pedido = ${short(commit)}, commit da prévia = ${short(pyStr(preview.commit))}`,
      `git rev-parse HEAD em ${dir}; ${dirname(dir)}/preview.json`));
    if (!(head === commit && commit === preview.commit)) bad.push("o commit pedido não é o da prévia nem o do clone");
    const dirty = gitTxt(ce, dir, "status", "--porcelain");
    evid.push(ev(dirty ? `clone em prévia com mudança solta: ${splitLines(dirty)[0]}` : "clone em prévia limpo", `git status --porcelain em ${dir}`));
    if (dirty) bad.push("há mudança solta no clone: o que executa não é o commit");
  } else if (op === "update") {
    const pack = installedPack(ctx, ce);
    const upstream = gitTxt(ce, pack, "rev-parse", "@{u}");
    evid.push(ev(`ponta do remote rastreado = ${short(upstream)}, commit pedido = ${short(commit)}`, `git rev-parse @{u} em ${pack}`));
    if (upstream !== commit) bad.push("o commit pedido não é a ponta que a prévia mostrou");
    const seen = audited(ce).some((a) => a.op === "update-preview" && a.plugin === plugin && a.target === commit);
    evid.push(ev(`prévia de update com target=${short(commit)} no log: ${seen ? "sim" : "não"}`, auditFile(pluginsCtx(ce))));
    if (!seen) bad.push("o dono não viu a prévia deste commit");
    const dirty = gitTxt(ce, pack, "status", "--porcelain");
    if (dirty) {
      evid.push(ev(`pacote com mudança local: ${splitLines(dirty)[0]}`, `git status --porcelain em ${pack}`));
      bad.push("o pacote instalado tem mudança local");
    }
  } else {
    const pack = installedPack(ctx, ce);
    const head = gitTxt(ce, pack, "rev-parse", "HEAD");
    evid.push(ev(`HEAD do pacote = ${short(head)}, commit pedido = ${short(commit)}`, `git rev-parse HEAD em ${pack}`));
    if (head !== commit) bad.push("o commit pedido não é o HEAD do pacote");
    const dirty = gitTxt(ce, pack, "status", "--porcelain");
    evid.push(ev(dirty ? `pacote com mudança local: ${splitLines(dirty)[0]}` : "pacote limpo", `git status --porcelain em ${pack}`));
    if (dirty) bad.push("o pacote tem mudança local: o que executa não é o commit");
    const last = audited(ce).filter((a) => a.plugin === plugin && (a.op === "add" || a.op === "update")).at(-1);
    const mark = last ? last.target || last.commit : undefined;
    evid.push(ev(`último commit instalado no log = ${mark ? short(mark) : "nenhum"}`, auditFile(pluginsCtx(ce))));
    if (mark && mark !== head) bad.push(`o pacote mudou depois da última instalação registrada (${short(mark)})`);
    if (!mark) {
      return [bad.length ? "barra" : "aviso", evid, bad.join("; ") || "sem registro de instalação: o commit não pode ser conferido com a prévia"];
    }
  }
  return [bad.length ? "barra" : "ok", evid, bad.join("; ") || `${short(commit)} é o sha da prévia`];
};

// ---------------------------------------------------------------- guarda: executavel

/** (árvore antiga ou null, árvore nova, onde) do que se confere. */
function sourceTrees(ctx: LimiarCtx, ce: CheckEnv): { old: Tree | null; next: Tree; where: string } {
  const { commit, op } = ctx;
  if (!SHA.test(commit)) throw new Falha(`commit ${pyRepr(commit)} não é sha: sem o que comparar (a guarda commit-fixado barra)`);
  if (op === "add") {
    const { dir } = staged(ctx, ce);
    return { old: null, next: new Tree(ce, dir, commit), where: dir };
  }
  const pack = installedPack(ctx, ce);
  const current = gitTxt(ce, pack, "rev-parse", "HEAD");
  if (op === "update") return { old: new Tree(ce, pack, current), next: new Tree(ce, pack, commit), where: pack };
  return { old: new Tree(ce, pack, current), next: new Tree(ce, pack, current), where: pack };
}

function previewRuns(preview: Dict): Map<string, string> {
  const out = new Map<string, string>();
  const runs = Array.isArray(preview.runs) ? preview.runs : [];
  for (const run of runs) {
    if (!isDict(run) || !("path" in run)) throw new Falha("'path'");
    if (!("sha256" in run)) throw new Falha("'sha256'");
    out.set(pyStr(run.path), pyStr(run.sha256));
  }
  return out;
}

const symmetricDiff = (a: Set<string>, b: Set<string>): string[] => [...a].filter((x) => !b.has(x)).concat([...b].filter((x) => !a.has(x)));

function addedByPreview(preview: Dict): { pages: Set<string>; routes: Set<string> } {
  const adds = isDict(preview.adds) ? preview.adds : {};
  const pages = new Set<string>();
  for (const page of Array.isArray(adds.pages) ? adds.pages : []) {
    if (!isDict(page) || !("id" in page)) throw new Falha("'id'");
    pages.add(pyStr(page.id));
  }
  const routes = new Set<string>((Array.isArray(adds.routes) ? adds.routes : []).map(pyStr));
  return { pages, routes };
}

function executavelNovo(ctx: LimiarCtx, ce: CheckEnv, next: Tree, now: Manifest, where: string): Verdict {
  const { preview } = staged(ctx, ce);
  const prev = previewRuns(preview);
  const prefix = next.envPrefix() ?? "";
  const listed = new Set<string>(Array.isArray(preview.other) ? preview.other.map(pyStr) : []);
  const bad: string[] = [];
  for (const rel of sorted(now.files.keys())) {
    const path = prefix ? `${prefix}${rel}` : rel;
    if (inPreview(rel)) {
      if (!prev.has(path)) bad.push(`executável fora da prévia: ${path}`);
      else if (prev.get(path) !== sha256Of(next, rel)) bad.push(`executável diferente da prévia: ${path}`);
    } else if (!listed.has(path)) {
      bad.push(`script fora da prévia: ${path}`);
    }
  }
  const adds = addedByPreview(preview);
  const extra = sorted([...symmetricDiff(adds.pages, now.pages), ...symmetricDiff(adds.routes, now.routes)]);
  if (extra.length) bad.push(`páginas ou rotas do plugin.json diferentes da prévia: ${extra.slice(0, NAMED_MAX).join(", ")}`);
  const evid = [ev(
    `${now.files.size} arquivo(s) executável(is) no commit ${short(next.commit)}, ${prev.size} na prévia; páginas: ${orDash(sorted(now.pages))}; rotas: ${orDash(sorted(now.routes))}`,
    `git ls-tree -r ${short(next.commit)} em ${where}; ${dirname(where)}/preview.json`,
  )];
  return [bad.length ? "barra" : "ok", [...evid, ...bad.map((b) => ev(b, "comparação com preview.json"))],
    bad.join("; ") || "o que executa é exatamente o que a prévia mostrou"];
}

function executavelMudado(ce: CheckEnv, old: Tree, next: Tree, now: Manifest, where: string): Verdict {
  const before = manifest(old);
  const added = sorted([...now.files.keys()].filter((r) => !before.files.has(r)));
  const removed = sorted([...before.files.keys()].filter((r) => !now.files.has(r)));
  const changed = sorted([...now.files.keys()].filter((r) => before.files.has(r) && before.files.get(r) !== now.files.get(r)));
  const prefixes = sorted(new Set([old.envPrefix(), next.envPrefix()].filter((p): p is string => p !== null)));
  const stat = old.commit !== next.commit
    ? gitTxt(ce, where, "diff", "--stat", "--no-color", old.commit, next.commit, "--", ...(prefixes.length ? prefixes : ["."]))
    : "";
  const summary = (splitLines(stat).at(-1) ?? "sem mudança").trim();
  const evid = [ev(
    `${short(old.commit)} → ${short(next.commit)}: ${added.length} executável(is) novo(s), ${changed.length} alterado(s), ${removed.length} removido(s); ${summary}`,
    `git diff --stat ${short(old.commit)} ${short(next.commit)} em ${where}`,
  )];
  for (const [tag, list] of [["novo", added], ["alterado", changed], ["removido", removed]] as const) {
    for (const rel of list.slice(0, LISTED_MAX)) {
      evid.push(ev(`${tag}: ${rel}${inPreview(rel) ? "" : " (fora do diff da prévia)"}`, `env/ do commit ${short(next.commit)}`));
    }
  }
  for (const [label, a, b] of [["páginas", before.pages, now.pages], ["rotas", before.routes, now.routes], ["ações", before.actions, now.actions]] as const) {
    if (sorted(a).join("\0") !== sorted(b).join("\0")) {
      const plus = sorted([...b].filter((x) => !a.has(x)));
      const minus = sorted([...a].filter((x) => !b.has(x)));
      evid.push(ev(`${label}: +${orDash(plus)} ${MINUS}${orDash(minus)}`, `plugin.json de ${short(next.commit)}`));
    }
  }
  const bad = added.filter((rel) => !inPreview(rel)).map((rel) => `executável novo fora do diff que a prévia mostra: ${rel}`);
  const warn = changed.filter((rel) => !inPreview(rel));
  if (bad.length) return ["barra", evid, bad.join("; ")];
  if (warn.length) {
    return ["aviso", evid, `script alterado fora do diff da prévia (só o nome aparece no resumo): ${warn.slice(0, NAMED_MAX).join(", ")}`];
  }
  return ["ok", evid, added.length || changed.length || removed.length ? "o que muda em código executável está no diff da prévia" : "nenhum código executável muda"];
}

const executavel: Guard = (ctx, ce) => {
  const { old, next, where } = sourceTrees(ctx, ce);
  const now = manifest(next);
  return ctx.op === "add" ? executavelNovo(ctx, ce, next, now, where) : executavelMudado(ce, old as Tree, next, now, where);
};

// ---------------------------------------------------------------- guarda: invariante

function touchesCore(tree: Tree, skill: string): Evid[] {
  const bad: Evid[] = [];
  for (const path of sorted(tree.files.keys())) {
    if (/(^|\/)[^/]*cerberus[^/]*(\/|$)/i.test(path) || path.startsWith("loop/cerberus/")) {
      bad.push(ev("arquivo do pacote no nome ou no lugar do Cerberus (guarda, bloco ou registro de cabeça)", path));
    } else if (path.startsWith("loop/") && isFile(join(skill, path))) {
      bad.push(ev(`o pacote traz arquivo que já é do núcleo (loop/): substituiria o núcleo`, path));
    }
  }
  return bad;
}

function overridesKit(tree: Tree, skill: string, prefix: string, env: Map<string, string>): Evid[] {
  const bad: Evid[] = [];
  for (const rel of sorted(env.keys())) {
    const top = rel.split("/")[0] as string;
    if ((PLUGIN_FILES as readonly string[]).includes(top) || NOT_COPIED.includes(top) || NOT_COPIED.includes(rel)) continue;
    if (isFile(join(skill, "kit", rel))) bad.push(ev(`env/${rel} cai por cima de kit/${rel} no install.sh (rsync do env/ sobre o $D)`, `${prefix}${rel}`));
  }
  if (env.has("config.tsv")) {
    for (const ln of splitLines(tree.read(`${prefix}config.tsv`).toString("utf8"))) {
      const key = ln.split("\t")[0] as string;
      if (key.startsWith("HADES_CERBERUS_")) bad.push(ev(`config.tsv do plugin declara ${key}: os modos do Cerberus são do dono`, `${prefix}config.tsv`));
    }
  }
  return bad;
}

function scanScript(text: string, where: string, bad: Evid[], warn: Evid[]): void {
  const hooky = /hook/i.test(text);
  splitLines(text).forEach((ln, i) => {
    const code = ln.trim();
    if (!code || code.startsWith("#") || code.startsWith("//")) return;
    const at = `${where}:${i + 1}`;
    for (const [what, rx] of TAMPER) if (rx.test(ln)) bad.push(ev(`${what}: ${code.slice(0, SNIPPET)}`, at));
    if (SETTINGS.test(ln)) {
      (hooky ? bad : warn).push(ev(`mexe em settings.json${hooky ? " (onde o hook é registrado)" : ""}: ${code.slice(0, SNIPPET_SETTINGS)}`, at));
    }
    if (SKILL_WRITE_TARGET.test(ln) && SKILL_WRITE_ACTION.test(ln)) bad.push(ev(`escreve na pasta da skill (o núcleo): ${code.slice(0, SNIPPET)}`, at));
  });
}

const invariante: Guard = (ctx, ce) => {
  const { commit, op } = ctx;
  if (!SHA.test(commit)) throw new Falha(`commit ${pyRepr(commit)} não é sha: sem o que varrer (a guarda commit-fixado barra)`);
  const dir = op === "add" ? staged(ctx, ce).dir : installedPack(ctx, ce);
  const skill = ce.skill || skillRoot;
  const tree = new Tree(ce, dir, commit);
  const prefix = tree.envPrefix() ?? "";
  const env = tree.envFiles();
  const bad = [...touchesCore(tree, skill), ...overridesKit(tree, skill, prefix, env)];
  const warn: Evid[] = [];
  if (manifest(tree).pages.has("cerberus")) bad.push(ev('plugin.json registra a página "cerberus", que é do núcleo', `${prefix}plugin.json`));
  const scripts = sorted(env.keys()).filter(isExec);
  for (const rel of scripts) scanScript(tree.read(`${prefix}${rel}`).toString("utf8"), `${prefix}${rel}`, bad, warn);
  if (bad.length) return ["barra", bad.slice(0, EVID_MAX), `${bad.length} achado(s) contra o núcleo`];
  if (warn.length) return ["aviso", warn.slice(0, EVID_MAX), "o plugin mexe em settings.json"];
  return ["ok", [ev(
    `${tree.files.size} arquivo(s) do pacote e ${scripts.length} executável(is) varridos: nada cai sobre o núcleo (kit/, loop/), `
    + "o hook hades-guard, as guardas nem os modos HADES_CERBERUS_*", `git ls-tree -r ${short(commit)} em ${dir}`,
  )], "sem sobrescrita de invariante do núcleo"];
};

// ---------------------------------------------------------------- guarda: ensaio

const ENSAIO_RUNS = ["post-install.sh", "doctor.sh", "checks/*.sh"];
const ENSAIO_FILE_MAX = 2_000_000; // arquivo maior que isto não é extraído para o ensaio (assets e afins)

/** O env/ do commit pronto para o ensaio: os scripts a rodar e os arquivos ao lado deles (sem assets, reference, __pycache__). */
function ensaioInput(tree: Tree): Parameters<typeof ensaiar>[0] {
  const prefix = tree.envPrefix() ?? "";
  const env = tree.envFiles();
  const scripts = new Map<string, string>();
  const files = new Map<string, { body: Buffer; mode: number }>();
  for (const rel of sorted(env.keys())) {
    if ((ENV_SKIP as readonly string[]).includes(rel.split("/")[0] as string)) continue;
    const body = tree.read(`${prefix}${rel}`, ENSAIO_FILE_MAX + 1);
    if (body.length > ENSAIO_FILE_MAX) continue;
    files.set(rel, { body, mode: tree.files.get(`${prefix}${rel}`)?.mode === "100755" ? 0o755 : 0o644 });
    if (ENSAIO_RUNS.some((pat) => fnmatchCase(rel, pat))) scripts.set(rel, body.toString("utf8"));
  }
  const pj = env.get("plugin.json");
  const manifestJson = pj === undefined ? null : parseJson(tree.blobText(pj), `plugin.json do commit ${short(tree.commit)} ilegível`);
  return { scripts, files, rede: redeDeclarada(manifestJson), escrita: escritaDeclarada(manifestJson) };
}

const ensaio: Guard = (ctx, ce) => {
  const { next } = sourceTrees(ctx, ce);
  const out = ensaiar(ensaioInput(next), ce);
  return [out.resultado, out.evidencia, out.detalhe];
};

export const LIMIAR_GUARDS: Record<string, Guard> = { "commit-fixado": commitFixado, executavel, invariante, ensaio };

/** O veredito da guarda; qualquer falha ao conferir vira barra com o que faltou. */
export function rodarLimiar(guard: string, ce: CheckEnv): CheckVerdict | undefined {
  const run = LIMIAR_GUARDS[guard];
  if (!run) return undefined;
  let outcome: Verdict;
  try {
    outcome = run(context(ce), ce);
  } catch (e) {
    // qualquer falha de leitura (git, arquivo, JSON) é "não consegui conferir"; o contrato é nunca sair sem veredito
    const why = e instanceof Error ? e.message : String(e);
    outcome = ["barra", [ev(`não consegui conferir: ${why}`, `checks/limiar.py ${guard}`)], "falha ao conferir"];
  }
  const [resultado, evidencia, detalhe] = outcome;
  return { resultado, evidencia: evidencia.slice(0, EVID_MAX), detalhe: detalhe.slice(0, DETAIL_MAX) };
}
