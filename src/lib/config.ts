// Configuração da instância: env.sh (atribuições simples), config.tsv (catálogo) e config.env (valores do dono).
// Mesma precedência do kit/config.sh: variável já exportada > config.env > padrão do plugin > padrão do kit.
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readText } from "./fs.ts";

const KEY = /^[A-Z][A-Z0-9_]*$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|([^\s"#]*))/;

/** Atribuições `K="v"` / `K=v` (uma por linha, no começo da linha) do env.sh; a primeira de cada chave vale. */
export function parseEnvSh(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = ASSIGNMENT.exec(line);
    if (!m || values.has(m[1] as string)) continue;
    values.set(m[1] as string, m[2] ?? m[3] ?? "");
  }
  return values;
}

export function readEnvSh(dir: string): Map<string, string> {
  return parseEnvSh(readText(join(dir, "env.sh")) ?? "");
}

/** HADES_ID do env.sh: a primeira linha `HADES_ID=` (como o sed do hades instance), vazio se não há. */
export function instanceId(dir: string): string {
  const text = readText(join(dir, "env.sh"));
  if (text === undefined) return "";
  for (const line of text.split("\n")) {
    const m = /^HADES_ID="?([^" #]*)/.exec(line);
    if (m) return m[1] ?? "";
  }
  return "";
}

export interface CatalogEntry {
  key: string;
  default: string;
}

/** Catálogo do kit seguido do plugin: chave nova soma; para a mesma chave, o padrão do plugin vence. */
export function readCatalog(dir: string): CatalogEntry[] {
  const entries = new Map<string, string>();
  for (const file of [join(dir, "config.tsv"), join(dir, "plugin", "config.tsv")]) {
    const text = readText(file);
    if (text === undefined) continue;
    for (const line of text.split("\n")) {
      const [key, value] = line.split("\t");
      if (key === undefined || !KEY.test(key)) continue;
      entries.set(key, value ?? "");
    }
  }
  return [...entries].map(([key, value]) => ({ key, default: value }));
}

export function readConfigEnv(dir: string): Map<string, string> {
  const values = new Map<string, string>();
  const text = readText(join(dir, "config.env"));
  if (text === undefined) return values;
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    if (KEY.test(key)) values.set(key, line.slice(eq + 1));
  }
  return values;
}

export function effectiveConfig(dir: string, env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const own = readConfigEnv(dir);
  const effective = new Map<string, string>();
  for (const { key, default: fallback } of readCatalog(dir)) {
    effective.set(key, env[key] ?? own.get(key) ?? fallback);
  }
  return effective;
}

export const HEALTH_DEFAULT = "/health/ready";
const HEALTH_PATH = /^\/[\w./~%?=&-]{0,200}$/;
const HEALTH_SERVICE = /^[\w.-]{1,60}$/;

/** Caminho de saúde por serviço que o plugin declara (plugin.json → panel.health); serviço fora do mapa usa HEALTH_DEFAULT. */
export function healthPaths(dir: string): Record<string, string> {
  const text = readText(join(dir, "plugin", "plugin.json"));
  if (text === undefined) return {};
  let health: unknown;
  try {
    const panel: unknown = (JSON.parse(text) as { panel?: unknown } | null)?.panel;
    health = (panel as { health?: unknown } | null | undefined)?.health;
  } catch {
    return {};
  }
  if (typeof health !== "object" || health === null || Array.isArray(health)) return {};
  const paths: Record<string, string> = {};
  for (const [service, path] of Object.entries(health)) {
    if (HEALTH_SERVICE.test(service) && typeof path === "string" && HEALTH_PATH.test(path)) paths[service] = path;
  }
  return paths;
}

const INSTANCE_ID = /^[a-z0-9_]{0,24}$/;

/** Prefixo das units desta instância (HU do config.sh): `hds` na original, `hds_<id>` com HADES_ID (ambiente > env.sh). */
export function unitPrefix(dir: string): string {
  let id = process.env.HADES_ID ?? instanceId(dir);
  if (!INSTANCE_ID.test(id)) id = id.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24);
  return id ? `hds_${id}` : "hds";
}

export const HERDR_BIN_DEFAULT = "herdr";
const HERDR_BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Binário do herdr que o painel chama (HADES_HERDR_BIN): vazio vale `herdr` do PATH; caminho absoluto (ou `~/`) tem de ser
 * um arquivo executável; nome simples é resolvido pelo PATH na hora de rodar. Qualquer outra forma (relativo, com espaço ou
 * `..`) é recusada na subida, com a mensagem do que corrigir.
 */
export function resolveHerdrBin(raw: string | undefined, home: string = process.env.HOME || homedir()): string {
  const value = (raw ?? "").trim();
  if (value === "") return HERDR_BIN_DEFAULT;
  const path = value === "~" || value.startsWith("~/") ? join(home, value.slice(1)) : value;
  if (!path.startsWith("/")) {
    if (HERDR_BIN_NAME.test(path)) return path;
    throw new Error(`HADES_HERDR_BIN inválido (${value}): use um caminho absoluto ou um nome simples como herdr`);
  }
  try {
    if (!statSync(path).isFile()) throw new Error("não é um arquivo");
    accessSync(path, constants.X_OK);
  } catch (error) {
    throw new Error(`HADES_HERDR_BIN (${value}) não é um executável: ${error instanceof Error ? error.message : String(error)}`);
  }
  return path;
}
