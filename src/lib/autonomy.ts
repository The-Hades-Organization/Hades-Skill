// Autonomia do orquestrador (reference/autonomia.md): o nível que o dono escolheu, a decisão de poder ou não tomar a
// opção recomendada sozinho e a regra allow da auto-alocação no settings.json do usuário.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { die } from "./output.ts";
import { home } from "./paths.ts";
import { configValue } from "./work.ts";

export const AUTONOMY_KEY = "HADES_ORCH_AUTONOMY";
export const AUTO_START_KEY = "HADES_ORCH_AUTO_START";
export const AUTO_START_RULE = "Bash(herdr agent start:*)";
export const MIN_LEVEL = 0;
export const MAX_LEVEL = 3;
export const EXIT_ASK_OWNER = 3;

export const LEVEL_LABELS = ["Pergunta tudo", "Operacional", "Execução", "Totalmente autônomo"] as const;

/** Decisões que nenhum nível libera. */
export const NEVER_CLASSES = ["invariante", "merge", "push-publico", "estouro", "autonivel"] as const;
export type NeverClass = (typeof NEVER_CLASSES)[number];

const NEVER_LABEL: Record<NeverClass, string> = {
  invariante: "invariante da skill",
  merge: "merge de PR de projeto",
  "push-publico": "push público do snapshot da skill",
  estouro: "passar de 150% do estimado",
  autonivel: "mudar o próprio nível ou o toggle de autonomia",
};

// texto sem acento e em minúsculas; falso positivo só devolve a pergunta ao dono, que é o lado seguro
const NEVER_PATTERNS: [NeverClass, RegExp][] = [
  ["autonivel", /hades_orch_(autonomy|auto_start)|auto-start|nivel de autonomia|slider de autonomia/],
  ["estouro", /\b150\s*%|passar do estimado|estouro do estimado|ask_pct/],
  ["push-publico", /push\b.*\b(snapshot|publico)|\b(snapshot|publico)\b.*\bpush\b|publicar o snapshot/],
  ["merge", /\b(merge|mergear|mesclar)\b.*\b(pr|pull request)\b|\b(pr|pull request)\b.*\b(merge|mergear|mesclar)\b/],
  ["invariante", /invariante/],
];

const plain = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function isNeverClass(value: string): value is NeverClass {
  return (NEVER_CLASSES as readonly string[]).includes(value);
}

export interface DecisionInput {
  levelNeeded: number;
  currentLevel: number;
  question: string;
  chosen: string;
  neverClass?: NeverClass;
}

export interface Verdict {
  allowed: boolean;
  reason: string;
  neverClass?: NeverClass;
}

/** Pura: o nível atual cobre o mínimo da decisão e ela não é de uma classe que nunca cede. */
export function judge(input: DecisionInput): Verdict {
  const klass = input.neverClass ?? NEVER_PATTERNS.find(([, rx]) => rx.test(plain(`${input.question}\n${input.chosen}`)))?.[0];
  if (klass) return { allowed: false, neverClass: klass, reason: `decisão do dono em qualquer nível: ${NEVER_LABEL[klass]}` };
  if (input.currentLevel < input.levelNeeded) {
    return { allowed: false, reason: `pede nível ${input.levelNeeded}; o nível atual é ${input.currentLevel}` };
  }
  return { allowed: true, reason: `nível ${input.currentLevel} cobre o mínimo ${input.levelNeeded}` };
}

/** Só a configuração do dono (config.env ou padrão): variável exportada na sessão do agente não vale. */
export function ownerConfig(key: string, fallback: string): string {
  return configValue(key, fallback, {});
}

export function currentLevel(): number {
  const raw = ownerConfig(AUTONOMY_KEY, "0").trim();
  const level = Number(raw);
  return Number.isInteger(level) && level >= MIN_LEVEL && level <= MAX_LEVEL ? level : MIN_LEVEL;
}

// ------------------------------------------------------------------ regra allow no settings.json

export const claudeSettingsPath = (): string => process.env.HADES_CLAUDE_SETTINGS || join(home(), ".claude", "settings.json");

type Json = Record<string, unknown>;

interface Loaded {
  data: Json;
  indent: string | number;
  trailingNewline: boolean;
}

function load(path: string): Loaded {
  if (!existsSync(path)) return { data: {}, indent: 2, trailingNewline: true };
  const text = readFileSync(path, "utf8");
  let data: unknown;
  try {
    data = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return die(`${path} não é JSON válido: nada foi alterado (corrija o arquivo e rode de novo)`, 1);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return die(`${path}: esperado um objeto JSON`, 1);
  const lead = /\n([ \t]+)"/.exec(text)?.[1];
  const indent = lead === undefined ? 2 : lead.startsWith("\t") ? "\t" : lead.length;
  return { data: data as Json, indent, trailingNewline: text.endsWith("\n") || text.trim() === "" };
}

function allowList(data: Json, path: string, create: boolean): string[] | undefined {
  let permissions = data.permissions;
  if (permissions === undefined) {
    if (!create) return undefined;
    permissions = {};
    data.permissions = permissions;
  }
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) return die(`${path}: "permissions" não é um objeto`, 1);
  const holder = permissions as Json;
  if (holder.allow === undefined) {
    if (!create) return undefined;
    holder.allow = [];
  }
  if (!Array.isArray(holder.allow)) return die(`${path}: "permissions.allow" não é uma lista`, 1);
  return holder.allow as string[];
}

function save(path: string, loaded: Loaded): void {
  const body = `${JSON.stringify(loaded.data, null, loaded.indent)}${loaded.trailingNewline ? "\n" : ""}`;
  const tmp = `${path}.hades-tmp`;
  writeFileSync(tmp, body);
  if (existsSync(path)) chmodSync(tmp, statSync(path).mode & 0o777);
  renameSync(tmp, path);
}

export function hasAutoStartRule(path: string = claudeSettingsPath()): boolean {
  if (!existsSync(path)) return false;
  const loaded = load(path);
  return allowList(loaded.data, path, false)?.includes(AUTO_START_RULE) ?? false;
}

export type RuleChange = "added" | "removed" | "unchanged";

/** Idempotente: grava ou tira exatamente AUTO_START_RULE e preserva o resto do arquivo. */
export function setAutoStartRule(on: boolean, path: string = claudeSettingsPath()): RuleChange {
  const loaded = load(path);
  const allow = allowList(loaded.data, path, on);
  const present = allow?.includes(AUTO_START_RULE) ?? false;
  if (on === present) return "unchanged";
  if (on) allow?.push(AUTO_START_RULE);
  else if (allow) (loaded.data.permissions as { allow: string[] }).allow = allow.filter((rule) => rule !== AUTO_START_RULE);
  save(path, loaded);
  return on ? "added" : "removed";
}

export interface AutoStartStatus {
  toggle: boolean;
  rule: boolean;
  active: boolean;
  settings: string;
}

export function autoStartStatus(path: string = claudeSettingsPath()): AutoStartStatus {
  const toggle = ownerConfig(AUTO_START_KEY, "0").trim() === "1";
  const rule = hasAutoStartRule(path);
  return { toggle, rule, active: toggle && rule, settings: path };
}
