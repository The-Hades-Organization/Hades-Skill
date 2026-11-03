// Catálogo de configurações do dono (kit/config.tsv + $D/plugin/config.tsv) e valores em $D/config.env: validação por
// tipo, gravação, exportação e prévia de importação. Mesma regra do config.sh (que o painel em Python ainda importa).
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readText } from "./fs.ts";
import { home } from "./paths.ts";

const KEY = /^[A-Z][A-Z0-9_]*$/;
// \w do Python (str) casa letras e dígitos Unicode; o do JS é só ASCII
const W = "\\p{L}\\p{N}_";
const HEADER =
  "# Configurações do Hades escolhidas pelo dono (painel → Configurações, ou config.sh set). Só o que difere\n" +
  "# do padrão do catálogo (config.tsv). Gerado: edite pelo painel ou pelo config.sh, que validam os valores.\n";
const SECRET_KEYS: readonly string[] = [];
const SECRET_TYPES = ["secret"];
const IDENTITY_TYPES = ["path", "login", "logins", "emails", "digits", "url"]; // url: servidor ntfy próprio é desta máquina

export class ConfigError extends Error {}

export interface Item {
  key: string;
  default: string;
  type: string;
  group: string;
  label: string;
  apply: string;
  desc: string;
  plugin?: true;
}

export interface Effective extends Item {
  value: string;
  changed: boolean;
}

export interface ImportPlan {
  changes: { key: string; label: string; group: string; apply: string; old: string; new: string }[];
  same: string[];
  invalid: { key: string; error: string }[];
  unknown: string[];
  secret: string[];
  blocked: string[];
  apply: string[];
}

/** str.splitlines() do Python: além do \n, também \r, \v, \f, separadores de arquivo/grupo/registro, NEL e U+2028/9. */
export const splitLines = (text: string): string[] => {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

const fullMatch = (pattern: string, value: string): RegExpExecArray | null =>
  new RegExp(`^(?:${pattern})$`, "u").exec(value);

export interface ConfigStore {
  /** $D: onde ficam config.env e plugin/config.tsv */
  dir: string;
  /** pasta do kit: config.tsv do núcleo e VERSION ao lado */
  kit: string;
}

const readCatalogFile = (path: string): Item[] => {
  const rows: Item[] = [];
  splitLines(readFileSync(path, "utf8")).forEach((line, index) => {
    if (!line || line.startsWith("#")) return;
    const cols = line.split("\t");
    if (cols.length !== 7 || !KEY.test(cols[0] as string)) {
      throw new ConfigError(`${path}: linha ${index + 1} fora do formato (7 colunas TAB, chave em MAIÚSCULAS)`);
    }
    const [key, fallback, type, group, label, apply, desc] = cols as [string, string, string, string, string, string, string];
    rows.push({ key, default: fallback, type, group, label, apply, desc });
  });
  return rows;
};

export function catalog(store: ConfigStore): Item[] {
  const items = readCatalogFile(join(store.kit, "config.tsv"));
  const pluginFile = join(store.dir, "plugin", "config.tsv");
  if (readText(pluginFile) === undefined) return items;
  const core = new Map(items.map((item) => [item.key, item]));
  for (const item of readCatalogFile(pluginFile)) {
    const known = core.get(item.key);
    if (known) known.default = item.default;
    else items.push({ ...item, plugin: true });
  }
  return items;
}

export function sensitivity(item: Item): "secret" | "identity" | "" {
  if (SECRET_TYPES.includes(item.type) || SECRET_KEYS.includes(item.key)) return "secret";
  return IDENTITY_TYPES.includes(item.type) ? "identity" : "";
}

export function skillVersion(store: ConfigStore): string {
  for (const path of [join(store.kit, "..", "VERSION"), join(home(), ".claude", "skills", "hades", "VERSION")]) {
    const text = readText(path);
    if (text !== undefined) return text.trim();
  }
  return "desconhecida";
}

export function loadValues(store: ConfigStore): Map<string, string> {
  const values = new Map<string, string>();
  const text = readText(join(store.dir, "config.env"));
  if (text === undefined) return values;
  for (const line of splitLines(text)) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    if (KEY.test(key)) values.set(key, line.slice(eq + 1));
  }
  return values;
}

export function sizeBytes(value: string): number {
  const n = Number.parseInt(value.slice(0, -1), 10);
  return n * (value.endsWith("G") ? 1024 ** 3 : 1024 ** 2);
}

const OPTS_LABELS: Record<string, string> = { logins: "contas do GitHub", emails: "e-mails", tags: "palavras" };
const LIST_ITEM: Record<string, string> = {
  logins: "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})",
  emails: `[${W}.+-]+@[${W}-]+(?:\\.[${W}-]+)+`,
  tags: `[${W}-]+(?: [${W}-]+)*`,
};
const BOOLS: Record<string, string> = { true: "1", on: "1", sim: "1", false: "0", off: "0", não: "0" };

const commaList = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/** Valor normalizado ou ConfigError com a mensagem para o dono. */
export function validate(item: Item, value: unknown): string {
  let v = String(value).trim();
  const { type: t, label } = item;
  const fail = (message: string): never => {
    throw new ConfigError(`${label}: ${message}`);
  };
  if (t === "size") {
    v = v.toUpperCase().replaceAll("MB", "M").replaceAll("GB", "G");
    if (!fullMatch("[1-9][0-9]{0,6}[MG]", v) || sizeBytes(v) < 64 * 1024 ** 2) fail("use um tamanho como 512M ou 4G (mínimo 64M)");
  } else if (t.startsWith("int:")) {
    const [lo, hi] = t.split(":").slice(1).map(BigInt) as [bigint, bigint];
    if (!fullMatch("-?[0-9]+", v) || BigInt(v) < lo || BigInt(v) > hi) fail(`número inteiro entre ${lo} e ${hi}`);
    v = BigInt(v).toString();
  } else if (t === "bool") {
    v = BOOLS[v.toLowerCase()] ?? v;
    if (v !== "0" && v !== "1") fail("0 ou 1");
  } else if (t === "percent") {
    if (!fullMatch("[1-9][0-9]{0,2}%", v) || Number.parseInt(v, 10) > 400) fail("porcentagem como 5% (até 400%)");
  } else if (t.startsWith("enum:")) {
    const opts = t.slice(5).split(",");
    if (!opts.includes(v)) fail(`um de ${opts.join(", ")}`);
  } else if (t.startsWith("multi:")) {
    const opts = t.slice(6).split(",");
    const sel = commaList(v);
    if (sel.length === 0 || sel.some((x) => !opts.includes(x))) fail(`um ou mais de ${opts.join(", ")}`);
    v = opts.filter((o) => sel.includes(o)).join(",");
  } else if (t === "globs") {
    const sel = commaList(v);
    if (sel.length === 0 || sel.some((x) => !fullMatch(`[${W}*?.-]+`, x))) {
      fail("padrões de nome separados por vírgula (letras, números, * e ?)");
    }
    v = sel.join(",");
  } else if (t === "ttl") {
    if (!fullMatch("[1-9][0-9]{0,3}[hd]", v)) fail("duração como 8h ou 1d");
  } else if (t === "login") {
    if (!fullMatch("[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})|", v)) fail("login do GitHub (letras, números e hífen) ou vazio");
  } else if (t === "logins" || t === "emails" || t === "tags") {
    const sel = commaList(v);
    if (sel.some((x) => !fullMatch(LIST_ITEM[t] as string, x))) fail(`lista separada por vírgula (${OPTS_LABELS[t]})`);
    v = sel.join(",");
  } else if (t === "modelmap") {
    const pairs = commaList(v);
    if (pairs.length === 0 || pairs.some((x) => !fullMatch("(default|[a-z0-9-]+)=(inherit|haiku|sonnet|opus)", x))) {
      fail("lista nome=modelo (modelo: inherit, haiku, sonnet, opus), com default=…");
    }
    v = pairs.join(",");
  } else if (t === "id") {
    if (!fullMatch("[A-Za-z0-9_:-]{0,64}", v)) fail("letras, números, _ : -");
  } else if (t === "digits") {
    if (!fullMatch("[0-9]{0,20}", v)) fail("só dígitos");
  } else if (t === "path") {
    if (v && !fullMatch("(~|/)[^\\s\"'$`\\\\]*", v)) fail("caminho absoluto ou começando por ~/, sem espaço nem aspas");
  } else if (t === "secret") {
    if (!fullMatch(`[${W}.:-]{0,128}`, v)) fail("letras, números e . _ : -");
  } else if (t === "relpath") {
    if (!fullMatch(`[${W}.-]+(?:/[${W}.-]+)*`, v) || v.split("/").includes("..")) fail("caminho relativo, sem .. nem espaço");
  } else if (t === "cidr") {
    if (v && !fullMatch("(?:\\d{1,3}\\.){3}\\d{1,3}/\\d{1,2}", v)) fail("sub-rede IPv4 como 172.18.0.0/16, ou vazio");
  } else if (t === "port") {
    if (v && !(fullMatch("[0-9]{4,5}", v) && Number.parseInt(v, 10) >= 1024 && Number.parseInt(v, 10) <= 65535)) {
      fail("porta entre 1024 e 65535, ou vazio");
    }
  } else if (t === "repo") {
    if (!fullMatch("[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", v)) fail("dono/nome do repositório no GitHub");
  } else if (t === "url") {
    if (!fullMatch(`https?://[${W}.-]+(?::[0-9]{1,5})?(?:/[${W}./~-]*)?`, v)) {
      fail("endereço http:// ou https:// sem espaço nem parâmetros");
    }
  } else if (t === "hours") {
    const m = fullMatch("([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-3]):([0-5][0-9])|", v);
    if (!m || (v && v.slice(0, 5) === v.slice(6))) fail("HH:MM-HH:MM com horas diferentes (ex.: 22:00-07:00) ou vazio");
  } else {
    throw new ConfigError(`${item.key}: tipo desconhecido no catálogo (${t})`);
  }
  return v;
}

/** Itens do catálogo com o valor efetivo para o dono (config.env ou padrão) e se mudou. */
export function effective(store: ConfigStore): Effective[] {
  const own = loadValues(store);
  return catalog(store).map((item) => {
    const value = own.get(item.key) ?? item.default;
    return { ...item, value, changed: own.has(item.key) && value !== item.default };
  });
}

const SLICE_ERROR = "Pressão de memória (MemoryHigh) não pode passar do teto (MemoryMax)";

/** Valida e grava. Devolve os modos de aplicar das chaves que mudaram de valor. */
export function save(store: ConfigStore, updates: Record<string, string>, unset: string[] = []): string[] {
  const items = new Map(catalog(store).map((item) => [item.key, item]));
  const own = loadValues(store);
  const valueOf = (map: Map<string, string>): Map<string, string> =>
    new Map([...items].map(([key, item]) => [key, map.get(key) ?? item.default]));
  const before = valueOf(own);
  for (const key of unset) {
    if (!items.has(key)) throw new ConfigError(`chave desconhecida: ${key}`);
    own.delete(key);
  }
  for (const [key, value] of Object.entries(updates)) {
    const item = items.get(key);
    if (!item) throw new ConfigError(`chave desconhecida: ${key}`);
    own.set(key, validate(item, value));
  }
  const after = valueOf(own);
  if (sizeBytes(after.get("HADES_SLICE_HIGH") as string) > sizeBytes(after.get("HADES_SLICE_MAX") as string)) {
    throw new ConfigError(SLICE_ERROR);
  }
  const keep = [...items].filter(([key, item]) => own.has(key) && own.get(key) !== item.default).map(([key]) => key);
  // chave fora do catálogo (de um plugin que não está instalado agora) fica como estava: volta a valer com ele
  const orphans = [...own].filter(([key]) => !items.has(key));
  const target = join(store.dir, "config.env");
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, HEADER + keep.map((key) => `${key}=${own.get(key)}\n`).join("") + orphans.map(([k, v]) => `${k}=${v}\n`).join(""));
  renameSync(tmp, target);
  return [...new Set([...items].filter(([key]) => before.get(key) !== after.get(key)).map(([, item]) => item.apply))].sort();
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Arquivo KEY=VALUE com cabeçalho. Padrão: só o que difere do padrão; segredo nunca; identidade só com a flag. */
export function exportText(store: ConfigStore, everything = false, identity = false, now: Date = new Date()): string {
  const rows: string[] = [];
  let skipped = 0;
  for (const item of effective(store)) {
    if (!everything && !item.changed) continue;
    const s = sensitivity(item);
    if (s === "secret" || (s === "identity" && !identity)) {
      skipped++;
      continue;
    }
    rows.push(`${item.key}=${item.value}\n`);
  }
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const head =
    `# Configurações do Hades — skill ${skillVersion(store)} — exportado em ${stamp}\n` +
    `# Valores do dono (${everything ? "tudo" : "só o que difere do padrão"}${identity ? "; com contas e caminhos desta máquina" : ""}). ` +
    "Importar: config.sh import <arquivo> [--dry-run]\n" +
    `# ${skipped} chave(s) de segredo ou desta máquina ficaram de fora (--include-identity inclui contas e caminhos).\n`;
  return head + rows.join("");
}

/** Valida um arquivo exportado sem gravar. `localOnly`: chaves que esta origem não pode mudar (painel remoto). */
export function plan(store: ConfigStore, text: string, localOnly: readonly string[] = []): ImportPlan {
  const items = new Map(effective(store).map((item) => [item.key, item]));
  const out: ImportPlan = { changes: [], same: [], invalid: [], unknown: [], secret: [], blocked: [], apply: [] };
  const wanted = new Map<string, string>();
  splitLines(text).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const key = (eq < 0 ? line : line.slice(0, eq)).trim();
    if (eq < 0 || !KEY.test(key)) {
      out.invalid.push({ key: `linha ${index + 1}`, error: "esperado KEY=VALUE" });
      return;
    }
    wanted.set(key, line.slice(eq + 1));
  });
  for (const [key, raw] of wanted) {
    const item = items.get(key);
    if (!item) out.unknown.push(key);
    else if (sensitivity(item) === "secret") out.secret.push(key);
    else if (localOnly.includes(key)) out.blocked.push(key);
    else {
      let value: string;
      try {
        value = validate(item, raw);
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        out.invalid.push({ key, error: error.message });
        continue;
      }
      if (value === item.value) out.same.push(key);
      else out.changes.push({ key, label: item.label, group: item.group, apply: item.apply, old: item.value, new: value });
    }
  }
  const after = new Map([...items].map(([key, item]) => [key, item.value]));
  for (const change of out.changes) after.set(change.key, change.new);
  if (out.changes.length > 0 && sizeBytes(after.get("HADES_SLICE_HIGH") as string) > sizeBytes(after.get("HADES_SLICE_MAX") as string)) {
    out.invalid.push({ key: "HADES_SLICE_HIGH", error: SLICE_ERROR });
    out.changes = out.changes.filter((c) => c.key !== "HADES_SLICE_HIGH" && c.key !== "HADES_SLICE_MAX");
  }
  out.apply = [...new Set(out.changes.map((c) => c.apply))].sort();
  return out;
}
