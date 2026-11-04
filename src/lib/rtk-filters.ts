// Resumidores por stack entregues pelo rtk (reference/rtk.md): monta o .rtk/filters.toml do worktree a partir do
// rtk-filters.toml de cada stack e do arquivo que o perfil do plugin aponta (rtk.filters). Nunca toca ~/.config/rtk/*.
import { appendFileSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { firstLine, isDir, isFile, readText } from "./fs.ts";
import { effectiveConfig } from "./config.ts";
import { kitDir } from "./kit.ts";
import { hadesHome, skillRoot } from "./paths.ts";
import { activeStacks, detectStacks, getField, loadProfile, stacksRoot } from "./profile.ts";
import { resolveProject } from "./project.ts";
import { run, which } from "./proc.ts";

export const FILTERS_REL = ".rtk/filters.toml";
export const GENERATED_MARK = "# Gerado pela Hades (hades rtk apply).";
const HEADER = `${GENERATED_MARK} Não edite: HADES_RTK_FILTERS=off remove; ajuste por stack e filtro em Configurações → Resumidores (rtk).\n`;
const ANNOUNCED_STRIP = new Set(["^\\s*$", "^$", "^\\s+$"]);
// chaves de [filters.*] que o rtk 1.x aceita (deny_unknown_fields em src/core/toml_filter.rs, TomlFilterDef)
const FILTER_KEYS = new Set([
  "description", "match_command", "strip_ansi", "replace", "match_output", "strip_lines_matching", "keep_lines_matching",
  "truncate_lines_at", "head_lines", "tail_lines", "max_lines", "on_empty", "filter_stderr",
]);

export interface RtkSettings {
  mode: "auto" | "off";
  offStacks: string[];
  offFilters: string[];
}

const list = (value: string | undefined): string[] => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function rtkSettings(get: (key: string) => string | undefined): RtkSettings {
  return {
    mode: get("HADES_RTK_FILTERS") === "off" ? "off" : "auto",
    offStacks: list(get("HADES_RTK_OFF_STACKS")),
    offFilters: list(get("HADES_RTK_OFF_FILTERS")),
  };
}

export interface RtkBinary {
  path: string;
  version: string;
}

/** O rtk do PATH e a versão (primeiro número x.y.z da primeira linha de `rtk --version`). */
export function rtkBinary(): RtkBinary | undefined {
  const path = which("rtk");
  if (path === undefined) return undefined;
  const first = run(path, ["--version"], { timeoutMs: 5000 }).stdout.split("\n", 1)[0] ?? "";
  return { path, version: /\d+\.\d+\.\d+/.exec(first)?.[0] ?? "" };
}

export interface FilterBlock {
  stack: string;
  name: string;
  text: string;
}

/** Os blocos [filters.<nome>] do arquivo (os [[tests.*]] e o cabeçalho ficam de fora: o rtk não os usa em .rtk/). */
export function filterBlocks(stack: string, toml: string): FilterBlock[] {
  const blocks: FilterBlock[] = [];
  let current: FilterBlock | undefined;
  for (const line of toml.split("\n")) {
    const header = /^\s*\[\[?\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*\]\]?\s*$/.exec(line);
    if (header) {
      current = header[1] === "filters" ? { stack, name: header[2] as string, text: "" } : undefined;
      if (current) blocks.push(current);
    }
    if (current) current.text += `${line}\n`;
  }
  return blocks.map((b) => ({ ...b, text: `${b.text.replace(/\n+$/, "")}\n` }));
}

/** Arquivo rtk-filters.toml de cada stack instalada: a do dono vence a da skill (como o stack.json). */
export function stackFilterFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const root of [stacksRoot(), join(skillRoot, "stacks")]) {
    if (!isDir(root)) continue;
    for (const name of new Bun.Glob("*/rtk-filters.toml").scanSync({ cwd: root })) {
      const stack = dirname(name);
      if (!files.has(stack)) files.set(stack, join(root, name));
    }
  }
  return files;
}

export interface FilterDef {
  [key: string]: unknown;
}

/** Problemas de um arquivo de filtros do rtk (vazio = válido): TOML (nome repetido já é erro dele), chaves do rtk e a regra do corte anunciado. */
export function filterFileProblems(text: string): string[] {
  let doc: Record<string, unknown>;
  try {
    doc = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    return [`TOML inválido: ${error instanceof Error ? error.message : String(error)}`];
  }
  const problems: string[] = [];
  if (doc.schema_version !== 1) problems.push("schema_version = 1 é obrigatório");
  for (const key of Object.keys(doc)) if (!["schema_version", "filters", "tests"].includes(key)) problems.push(`chave '${key}' fora do formato do rtk`);
  const filters = (doc.filters ?? {}) as Record<string, FilterDef>;
  for (const [name, def] of Object.entries(filters)) {
    if (typeof def.match_command !== "string") problems.push(`[filters.${name}]: falta match_command`);
    for (const key of Object.keys(def)) if (!FILTER_KEYS.has(key)) problems.push(`[filters.${name}]: chave '${key}' desconhecida do rtk`);
    problems.push(...announcementProblems(name, def));
  }
  return problems;
}

/**
 * Regra dura (reference/rtk.md §O corte se anuncia): o TOML do rtk só anuncia o que cortam head/tail/max_lines e
 * truncate_lines_at; strip/keep de linha com conteúdo e match_output descartam sem contar. Só linha em branco sai por strip.
 */
export function announcementProblems(name: string, def: FilterDef): string[] {
  const problems: string[] = [];
  const strip = Array.isArray(def.strip_lines_matching) ? (def.strip_lines_matching as string[]) : [];
  for (const pattern of strip) {
    if (!ANNOUNCED_STRIP.has(pattern)) problems.push(`[filters.${name}]: strip_lines_matching '${pattern}' descarta linha com conteúdo sem anúncio`);
  }
  if (Array.isArray(def.keep_lines_matching) && def.keep_lines_matching.length > 0) problems.push(`[filters.${name}]: keep_lines_matching descarta sem anúncio`);
  if (Array.isArray(def.match_output) && def.match_output.length > 0) problems.push(`[filters.${name}]: match_output troca a saída por uma mensagem sem anúncio`);
  return problems;
}

export function buildFiltersToml(blocks: FilterBlock[]): string {
  return `${HEADER}schema_version = 1\n\n${blocks.map((b) => b.text).join("\n")}`;
}

export interface WorktreePlan {
  /** write: grava o arquivo; remove: tira o que a Hades gerou; keep: não mexe (arquivo do projeto ou nada a fazer) */
  action: "write" | "remove" | "keep";
  why: string;
  text: string;
  stacks: string[];
  filters: string[];
}

function pluginFile(worktree: string): string | undefined {
  const resolution = resolveProject(worktree);
  if (resolution.code !== 0 || !resolution.profile) return undefined;
  const rel = getField(loadProfile(resolution), "rtk.filters", "");
  return rel ? join(dirname(resolution.profile), rel) : undefined;
}

const generatedBy = (file: string): boolean => (readText(file) ?? "").startsWith(GENERATED_MARK);

function trackedByGit(worktree: string, rel: string): boolean {
  return run("git", ["-C", worktree, "ls-files", "--error-unmatch", rel]).status === 0;
}

export function planWorktree(worktree: string, settings: RtkSettings, rtk: RtkBinary | undefined): WorktreePlan {
  const file = join(worktree, FILTERS_REL);
  const none = { text: "", stacks: [], filters: [] };
  if (trackedByGit(worktree, FILTERS_REL)) return { action: "keep", why: `${FILTERS_REL} é do projeto (versionado): a Hades não mexe`, ...none };
  if (isFile(file) && !generatedBy(file)) return { action: "keep", why: `${FILTERS_REL} existe e não é da Hades: mantido`, ...none };
  if (rtk === undefined) return { action: "remove", why: "rtk ausente", ...none };
  if (settings.mode === "off") return { action: "remove", why: "HADES_RTK_FILTERS=off", ...none };
  const wanted = detectStacks(worktree).filter((s) => activeStacks(worktree).has(s) && !settings.offStacks.includes(s));
  const files = stackFilterFiles();
  const blocks: FilterBlock[] = [];
  for (const stack of wanted) {
    const text = readText(files.get(stack) ?? "");
    if (text !== undefined) blocks.push(...filterBlocks(stack, text));
  }
  const plugin = pluginFile(worktree);
  const pluginText = plugin ? readText(plugin) : undefined;
  if (plugin && pluginText !== undefined && filterFileProblems(pluginText).length === 0) blocks.push(...filterBlocks("plugin", pluginText));
  const used = blocks.filter((b) => !settings.offFilters.includes(b.name));
  if (used.length === 0) return { action: "remove", why: "nenhum filtro ativo para as stacks deste worktree", ...none };
  return {
    action: "write",
    why: "filtros das stacks e do plugin",
    text: buildFiltersToml(used),
    stacks: [...new Set(used.map((b) => b.stack))],
    filters: used.map((b) => b.name),
  };
}

function excludeFilters(worktree: string): void {
  const exclude = run("git", ["-C", worktree, "rev-parse", "--git-path", "info/exclude"]).stdout.trim();
  if (!exclude) return;
  const path = exclude.startsWith("/") ? exclude : join(worktree, exclude);
  if (!(readText(path) ?? "").split("\n").includes(FILTERS_REL)) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${FILTERS_REL}\n`);
  }
}

export interface ApplyResult extends WorktreePlan {
  trusted: "sim" | "pulado" | "falhou" | "";
}

/**
 * `rtk trust --yes` no cwd do worktree confia também no filtro global do usuário (gated_filter_paths_labeled do rtk):
 * existindo ~/.config/rtk/filters.toml, a Hades não confia sozinha, para não decidir por um arquivo que não é dela.
 */
export function globalFiltersFile(home: string): string {
  return join(home, ".config", "rtk", "filters.toml");
}

export function trustWorktree(worktree: string, rtk: RtkBinary, home: string): ApplyResult["trusted"] {
  if (isFile(globalFiltersFile(home))) return "pulado";
  return run(rtk.path, ["trust", "--yes"], { cwd: worktree, timeoutMs: 15000 }).status === 0 ? "sim" : "falhou";
}

/** Gera (ou remove) o .rtk/filters.toml do worktree; `trust`: caminho do dono (install, agent new), confia no que gerou. */
export function applyWorktree(worktree: string, settings: RtkSettings, opts: { trust: boolean; home: string }): ApplyResult {
  const rtk = rtkBinary();
  const plan = planWorktree(worktree, settings, rtk);
  const file = join(worktree, FILTERS_REL);
  let trusted: ApplyResult["trusted"] = "";
  if (plan.action === "write" && rtk) {
    mkdirSync(dirname(file), { recursive: true });
    if (readText(file) !== plan.text) writeFileSync(file, plan.text);
    excludeFilters(worktree);
    trusted = opts.trust ? trustWorktree(worktree, rtk, opts.home) : "";
  } else if (plan.action === "remove" && generatedBy(file)) {
    rmSync(file, { force: true });
    if (readdirSync(dirname(file)).length === 0) rmdirSync(dirname(file));
  }
  return { ...plan, trusted };
}

export type TrustState = "confiado" | "nao-confiado" | "alterado" | "";

/** Confiança do arquivo gerado, lida de `rtk trust --list` (sha256 gravado contra o do arquivo). Vazio = não há o que conferir. */
export function trustState(worktree: string, rtk: RtkBinary): TrustState {
  const file = join(worktree, FILTERS_REL);
  const text = readText(file);
  if (text === undefined) return "";
  const listing = run(rtk.path, ["trust", "--list"], { cwd: worktree, timeoutMs: 10000 }).stdout.split("\n");
  const at = listing.findIndex((l) => l.trim().startsWith(`${file} `) || l.trim().startsWith(`${realPath(file)} `));
  if (at < 0) return "nao-confiado";
  const recorded = /sha256:([0-9a-f]{64})/.exec(listing[at + 1] ?? "")?.[1];
  const actual = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  return recorded === actual ? "confiado" : "alterado";
}

const realPath = (path: string): string => realpathSyncOr(path);
function realpathSyncOr(path: string): string {
  return isFile(path) ? realpathSync(path) : path;
}

/** Política do rtk que a Hades recomenda ao doctor (sem gravar): lê o config.toml do rtk e devolve o que falta. */
export function policyAdvice(config: Record<string, unknown> | undefined, version: string): string[] {
  const advice: string[] = [];
  const cfg = config ?? {};
  const section = (key: string): Record<string, unknown> => (typeof cfg[key] === "object" && cfg[key] !== null ? (cfg[key] as Record<string, unknown>) : {});
  const excluded = Array.isArray(section("hooks").exclude_commands) ? (section("hooks").exclude_commands as string[]) : [];
  for (const want of ["diff", "ps -p"]) {
    if (!excluded.includes(want)) advice.push(`[hooks] exclude_commands: acrescente "${want}" (o rtk reescreve a saída e muda o que o comando prova)`);
  }
  const limits = section("limits");
  if (typeof limits.grep_max_results !== "number" || limits.grep_max_results <= 200) advice.push("[limits] grep_max_results: suba de 200 (o grep para no teto sem avisar)");
  if (typeof limits.grep_max_per_file !== "number" || limits.grep_max_per_file <= 25) advice.push("[limits] grep_max_per_file: suba de 25");
  const width = section("display").max_width;
  if (typeof width !== "number" || width <= 120) advice.push("[display] max_width: suba de 120 (o corte de linha esconde o fim da mensagem)");
  if (/^0\./.test(version)) {
    if (section("tee").mode !== "always") advice.push('[tee] mode = "always" (no rtk 0.x o padrão grava só em falha; filtro que corta precisa da saída inteira)');
  } else if (version !== "") {
    const retriever = section("retriever");
    if (retriever.mode === "disabled") advice.push('[retriever] mode: "disabled" não guarda a saída inteira; use "sqlite" (padrão) ou "tee"');
    if (retriever.mode === "tee" && retriever.tee_on_success !== true) advice.push("[retriever] tee_on_success = true (no modo tee a saída que passou por filtro não é gravada)");
  }
  return advice;
}

/** config.toml do rtk (só leitura). Linux: ~/.config/rtk; macOS: ~/Library/Application Support/rtk. */
export function rtkConfig(home: string): Record<string, unknown> | undefined {
  for (const file of [join(home, ".config", "rtk", "config.toml"), join(home, "Library", "Application Support", "rtk", "config.toml")]) {
    const text = readText(file);
    if (text === undefined) continue;
    try {
      return Bun.TOML.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Onde a saída inteira vai (RTK_RECALL_DB / RTK_TEE_DIR, exportadas pelo env.sh) dentro dos dados da instância. */
export const recallDb = (data: string): string => join(data, "rtk", "recall.db");
export const teeDir = (data: string): string => join(data, "rtk", "tee");

/** Configurações HADES_RTK_* de uma pasta de dados ($D): variável exportada > config.env > padrão do catálogo. */
export function settingsFor(data: string, env: NodeJS.ProcessEnv = process.env): RtkSettings {
  const values = effectiveConfig(data, env);
  return rtkSettings((key) => values.get(key));
}

/**
 * Passo do install e da criação de agente (caminho do dono): gera o arquivo, confia nele e devolve a linha a mostrar
 * ("" = nada a dizer: sem rtk e sem arquivo gerado). Falha nunca derruba quem chama.
 */
export function installForWorktree(worktree: string, data: string, home: string): string {
  try {
    const result = applyWorktree(worktree, settingsFor(data), { trust: true, home });
    if (result.action === "keep") return result.why;
    if (result.action === "remove") return "";
    const trust = result.trusted === "sim" ? "confiado" : result.trusted === "pulado" ? `NÃO confiado: existe ${globalFiltersFile(home)}; rode \`rtk trust\` em ${worktree}` : "confiança falhou: rode `rtk trust`";
    return `rtk: ${result.filters.length} filtro(s) (${result.stacks.join(",")}) em ${join(worktree, FILTERS_REL)} · ${trust}`;
  } catch (error) {
    return `aviso: filtros do rtk não aplicados em ${worktree}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Pasta de dados ($D) de quem chama: HADES_DATA, a instância ativa da máquina, ou o catálogo do kit (só os padrões). */
export function dataDirOf(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HADES_DATA) return env.HADES_DATA;
  const instance = firstLine(join(hadesHome(), "instance"));
  return instance && isFile(join(instance, "config.sh")) ? instance : kitDir();
}
