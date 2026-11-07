// Perfil do projeto e stacks (reference/projects.md, reference/stacks.md): campo do perfil, referências, stacks que valem
// no diretório, termos da guarda de nome e faixa `core`. Mesmo contrato do hades project e do lib.sh.
import { dirname, join } from "node:path";
import { firstLine, isFile, listDir, readText } from "./fs.ts";
import { hadesHome, skillRoot } from "./paths.ts";
import { run } from "./proc.ts";
import { type Resolution, packsRoot, resolveProject } from "./project.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readJson(file: string): Json | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

/** Objeto JSON do arquivo, ou undefined se ilegível ou de outro tipo. */
export function readJsonObject(file: string): JsonObject | undefined {
  const doc = readJson(file);
  return isObject(doc) ? doc : undefined;
}

export function loadProfile(resolution: Resolution): JsonObject {
  return resolution.profile ? (readJsonObject(resolution.profile) ?? {}) : {};
}

/** Valor do caminho `a.b.c` (undefined se o caminho não existe). */
export function pathValue(doc: Json, field: string): Json | undefined {
  let current: Json | undefined = doc;
  for (const key of field.split(".")) {
    if (!isObject(current) || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

export function jsonText(value: Json): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * `get` do hades project (como o jq: null, false e "" valem como ausente).
 * Devolve o texto a imprimir, ou undefined quando sai 1.
 */
export function getField(profile: Json, field: string, fallback: string | undefined): string | undefined {
  const value = pathValue(profile, field);
  const present = value !== undefined && value !== null && value !== false && value !== "";
  return present ? jsonText(value) : fallback;
}

/** Caminho absoluto de refs.<nome> do perfil (relativo ao pacote), ou undefined. */
export function refPath(resolution: Resolution, name: string): string | undefined {
  if (!resolution.profile) return undefined;
  const doc = readJsonObject(resolution.profile);
  const refs = doc?.refs;
  const rel = isObject(refs) ? refs[name] : undefined;
  return typeof rel === "string" && rel ? `${dirname(resolution.profile)}/${rel}` : undefined;
}

// ------------------------------------------------------------------ stacks

/** HADES_STACKS_ROOT > ~/.claude/hades/stacks-root (uma linha) > ~/.claude/hades/stacks */
export function stacksRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HADES_STACKS_ROOT) return env.HADES_STACKS_ROOT;
  return firstLine(join(hadesHome(), "stacks-root")).trim() || join(hadesHome(), "stacks");
}

/** Stacks instaladas {nome: documento}; a do usuário vence a da skill. */
export function installedStacks(): Map<string, JsonObject> {
  const stacks = new Map<string, JsonObject>();
  for (const root of [stacksRoot(), join(skillRoot, "stacks")]) {
    for (const name of listDir(root)) {
      const doc = readJsonObject(join(root, name, "stack.json"));
      if (doc && !stacks.has(name)) stacks.set(name, doc);
    }
  }
  return stacks;
}

function stringList(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Stacks do perfil do diretório; sem perfil (ou sem a lista), todas as instaladas. */
export function activeStacks(dir: string | undefined): Map<string, JsonObject> {
  const all = installedStacks();
  let wanted: string[] = [];
  try {
    const resolution = resolveProject(dir ?? process.cwd());
    if (resolution.code === 0) wanted = stringList(loadProfile(resolution).stacks);
  } catch {
    wanted = [];
  }
  if (wanted.length === 0) return all;
  return new Map([...all].filter(([name]) => wanted.includes(name)));
}

export interface StepLine {
  kind: Json;
  costGb: Json;
  parallel: Json;
  measuredAt: Json;
}

/** Etapa `<stack>:<etapa>`; undefined se não existe. */
export function stepOf(ref: string): StepLine | undefined {
  const colon = ref.indexOf(":");
  const name = colon < 0 ? ref : ref.slice(0, colon);
  const step = pathValue(installedStacks().get(name) ?? {}, `steps.${colon < 0 ? "" : ref.slice(colon + 1)}`);
  if (!isObject(step)) return undefined;
  return { kind: step.kind ?? null, costGb: step.costGb ?? null, parallel: step.parallel ?? 0, measuredAt: step.measuredAt ?? "" };
}

export function repoRoot(dir: string): string {
  const top = run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  return top.status === 0 && top.stdout.trim() ? top.stdout.trim() : dir;
}

function globMatches(root: string, pattern: string): boolean {
  const glob = new Bun.Glob(pattern);
  for (const _ of glob.scanSync({ cwd: root, dot: true, onlyFiles: false })) return true;
  return false;
}

/** Stacks instaladas cujo detect.files casa na raiz do repo (all=true: todos; senão qualquer um). */
export function detectStacks(dir: string | undefined): string[] {
  const root = repoRoot(dir ?? process.cwd());
  const found: string[] = [];
  for (const [name, doc] of installedStacks()) {
    const detect = doc.detect;
    const files = isObject(detect) ? stringList(detect.files) : [];
    const hits = files.map((pattern) => globMatches(root, pattern));
    const all = isObject(detect) && detect.all === true;
    if (hits.length > 0 && (all ? hits.every(Boolean) : hits.some(Boolean))) found.push(name);
  }
  return found;
}

// ------------------------------------------------------------------ guarda de nome

function profilesIn(root: string): { file: string; doc: JsonObject }[] {
  const profiles: { file: string; doc: JsonObject }[] = [];
  for (const name of listDir(root)) {
    const file = join(root, name, "profile.json");
    const doc = isFile(file) ? readJsonObject(file) : undefined;
    if (doc) profiles.push({ file, doc });
  }
  return profiles;
}

const byLowerThenRaw = (a: string, b: string): number => {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** [perfil, termos]: o que a guarda de nome procura no núcleo. */
export function nameTerms(): { name: string; terms: string[] }[] {
  return profilesIn(packsRoot()).map(({ doc }) => {
    const identity = isObject(doc.identity) ? doc.identity : {};
    const repo = typeof identity.repo === "string" ? identity.repo : "";
    const name = typeof doc.name === "string" ? doc.name : "";
    const raw = [name, repo, ...repo.split("/"), ...stringList(identity.aliases)];
    return { name, terms: [...new Set(raw.filter((t) => t.length >= 3))].sort(byLowerThenRaw) };
  });
}

/** ERE do vocabulário do projeto (identity.vocabulary) de todos os perfis, sem repetição. */
export function vocabulary(): string[] {
  const out = new Set<string>();
  for (const { doc } of profilesIn(packsRoot())) {
    if (isObject(doc.identity)) for (const term of stringList(doc.identity.vocabulary)) out.add(term);
  }
  return [...out].sort(byCodepoint);
}

/** Termos de domínio (`domainTerms` de cada pacote) e as exceções `@allow <glob>`. */
export function domainTerms(): { terms: string[]; allow: string[] } {
  const terms = new Set<string>();
  const allow = new Set<string>();
  for (const { file, doc } of profilesIn(packsRoot())) {
    const rel = typeof doc.domainTerms === "string" ? doc.domainTerms : "";
    const text = rel ? readText(join(dirname(file), rel)) : "";
    if (text === undefined) continue;
    for (const line of text.split("\n").map((l) => l.trim())) {
      if (line.startsWith("@allow ")) allow.add(line.slice(7).trim());
      else if (line && !line.startsWith("#")) terms.add(line);
    }
  }
  return { terms: [...terms].sort(byCodepoint), allow: [...allow].sort(byCodepoint) };
}

// ------------------------------------------------------------------ faixa do núcleo (profile.core)

const VERSION = String.raw`\d+(?:\.\d+){0,2}`;
const CORE_TERM = new RegExp(String.raw`^(?:(>=|<=|>|<|=)?(${VERSION})|(${VERSION})\.x)$`);

type Version = [number, number, number];
type CoreOp = ">=" | "<=" | ">" | "<" | "=";

function toVersion(text: string): Version {
  const parts = text.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number) ? -1 : 1;
  return 0;
}

/** Faixa simples (`>=4.3`, `>=4.3 <5`, `4.3.x`) → termos; lança Error com a mensagem do validador se a sintaxe não vale. */
export function coreRange(text: Json | undefined): [CoreOp, Version][] {
  const terms = typeof text === "string" ? text.split(/\s+/).filter(Boolean) : [];
  if (terms.length === 0) throw new Error("faixa vazia");
  const out: [CoreOp, Version][] = [];
  for (const term of terms) {
    const m = CORE_TERM.exec(term);
    if (!m) throw new Error(`termo ${pyRepr(term)} fora da sintaxe (>=4.3, <5, 4.3.x, 4.3.0)`);
    const wild = m[3];
    if (wild !== undefined) {
      const depth = wild.split(".").length;
      if (depth === 3) throw new Error(`termo ${pyRepr(term)}: o .x vai no lugar de menor ou patch (4.x, 4.3.x)`);
      const base = toVersion(wild);
      const top: Version = depth === 1 ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0];
      out.push([">=", base], ["<", top]);
    } else {
      out.push([(m[1] ?? "=") as CoreOp, toVersion(m[2] as string)]);
    }
  }
  return out;
}

export function coreOk(range: Json | undefined, version: string): boolean {
  const v = toVersion(version);
  return coreRange(range).every(([op, ref]) => {
    const c = compare(v, ref);
    return op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : c === 0;
  });
}

/** Primeiro núcleo do contrato atual de plugin (`panel/api.ts`, sem `api.py`). */
const PLUGIN_CONTRACT_MIN = "5.0.0";
const LAST_LEGACY_CORE = "4.999.999";

/** A faixa aceita núcleo anterior ao contrato atual? Então o plugin ainda pode estar no contrato antigo (`api.py`). */
export function admitsLegacyCore(range: Json | undefined): boolean {
  return coreOk(range, LAST_LEGACY_CORE);
}

export function legacyCoreMessage(project: string, core: string): string {
  return `o plugin ${project} declara core ${core}, que aceita núcleo anterior à ${PLUGIN_CONTRACT_MIN}: o contrato atual só carrega plugin com "core": ">=5" e o painel em panel/api.ts (api.py não é mais lido); porte o api.py para api.ts, declare core >=5 no profile.json e atualize o plugin (reference/projects.md §Plugin)`;
}

export function coreVersion(): string {
  return firstLine(join(skillRoot, "VERSION")).trim();
}

export interface CoreCheck {
  state: "ok" | "sem-core" | "fora" | "invalido" | "sem-perfil";
  project: string;
  core: string;
  version: string;
  message: string;
}

export function coreCheck(dir: string | undefined, version: string | undefined): CoreCheck {
  const resolution = resolveProject(dir ?? process.cwd());
  if (resolution.code !== 0) return { state: "sem-perfil", project: "", core: "", version: "", message: resolution.message };
  const profile = loadProfile(resolution);
  const project = resolution.project ?? "";
  const ver = version || coreVersion();
  const pack = resolution.profile ? dirname(resolution.profile) : "";
  const range = profile.core;
  if (range === undefined) {
    return {
      state: "sem-core",
      project,
      core: "",
      version: ver,
      message: `o plugin ${project} não declara \`core\` (faixa de versões do núcleo); acrescente "core" ao profile.json`,
    };
  }
  let ok: boolean;
  try {
    ok = coreOk(range, ver);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { state: "invalido", project, core: pyText(range), version: ver, message: `core ${pyRepr(range)} do plugin ${project}: ${reason}` };
  }
  const core = pyText(range);
  if (ok && admitsLegacyCore(range)) return { state: "fora", project, core, version: ver, message: legacyCoreMessage(project, core) };
  if (ok) return { state: "ok", project, core, version: ver, message: `plugin ${project} pede o núcleo ${core}; núcleo ${ver}` };
  return {
    state: "fora",
    project,
    core,
    version: ver,
    message: `o plugin ${project} pede o núcleo ${core}, mas o núcleo instalado é o ${ver}: atualize o núcleo (skill Hades) ou o plugin (git -C ${pack} pull)`,
  };
}

// ------------------------------------------------------------------ texto como o Python imprime (mensagens que os testes gravaram)

/** `repr()` do Python para valores JSON (aspas simples, True/False/None). */
export function pyRepr(value: Json | undefined): string {
  if (value === undefined || value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const body = value
      .replaceAll("\\", "\\\\")
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t")
      .replaceAll(quote, `\\${quote}`);
    return `${quote}${body}${quote}`;
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(value)
    .map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`)
    .join(", ")}}`;
}

/** `str()` do Python: texto cru para string, repr para o resto. */
export function pyText(value: Json | undefined): string {
  return typeof value === "string" ? value : pyRepr(value);
}

/** `json.dumps(ensure_ascii=False)` do Python (separadores `, ` e `: `). */
export function pyJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (isObject(value)) return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`).join(", ")}}`;
  return JSON.stringify(value);
}
