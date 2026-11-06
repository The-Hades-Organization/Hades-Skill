// Padrão herdado do ~/.claude/settings.json do dono: todo agente sem --model/--effort, toda sessão interativa e todo
// subagente (que herda o modelo da sessão pai) rodam nele. Só lê e julga; a Hades nunca grava no settings.json.
import { statSync } from "node:fs";
import { join } from "node:path";
import { claudeSettingsPath } from "./autonomy.ts";
import { listDir, readText } from "./fs.ts";
import { home } from "./paths.ts";
import { MODEL_COST_ORDER as PRICED_FAMILIES } from "./price.ts";

/** Papéis com HADES_MODEL_<PAPEL> / HADES_EFFORT_<PAPEL> (Configurações → Modelos por papel). */
export const ROLE_KEYS = ["ORCHESTRATOR", "SPEC", "IMPL", "CONSOLIDATE", "REVIEW", "ESCALATE", "CHAT"] as const;

/** Ordem de custo, do mais barato ao mais caro: a de modelo vem da tabela de preço (price.ts), a de esforço é daqui. */
export const MODEL_COST_ORDER: readonly string[] = PRICED_FAMILIES;
export const EFFORT_COST_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;
const HEAVY_EFFORTS: readonly string[] = ["xhigh", "max"];
const EFFORT_STEP = MODEL_COST_ORDER.length + 1;

const RECENT_FILES = 20;
const TAIL_BYTES = 65_536;
const MILLION_WINDOW = /\[1m\]/i;

export type Reader = (key: string) => string | undefined;

export interface Inherited {
  model: string;
  effort: string;
  /** quem herda: sessões interativas, agentes sem flags, subagentes */
  heirs: readonly string[];
}

export const HEIRS = ["sessões interativas", "agentes sem --model/--effort", "subagentes (modelo da sessão pai)"] as const;

export type Settings = { ok: true; json: Record<string, unknown>; path: string } | { ok: false; reason: string; path: string };

export function readSettings(path: string = claudeSettingsPath()): Settings {
  const text = readText(path);
  if (text === undefined) return { ok: false, reason: "arquivo ausente ou ilegível", path };
  try {
    const json: unknown = JSON.parse(text);
    if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, reason: "o conteúdo não é um objeto JSON", path };
    return { ok: true, json: json as Record<string, unknown>, path };
  } catch (error) {
    return { ok: false, reason: `JSON inválido (${error instanceof Error ? error.message : "erro de leitura"})`, path };
  }
}

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function familyOf(model: string): number {
  const at = MODEL_COST_ORDER.findIndex((family) => model.toLowerCase().includes(family));
  return at;
}

/** Custo relativo (modelo × esforço); -1 quando o modelo não é de uma família conhecida. */
export function costOf(model: string, effort: string): number {
  const family = familyOf(model);
  if (family < 0) return -1;
  const step = EFFORT_COST_ORDER.indexOf(effort as (typeof EFFORT_COST_ORDER)[number]);
  return family * EFFORT_STEP + Math.max(step, 0);
}

export function inheritedDefault(json: Record<string, unknown>): Inherited {
  return { model: str(json.model), effort: str(json.effortLevel), heirs: HEIRS };
}

/** Modelo e esforço de cada papel nas Configurações; papel sem chave fica de fora. */
export function roleSettings(read: Reader): { role: string; model: string; effort: string }[] {
  return ROLE_KEYS.map((role) => ({ role, model: str(read(`HADES_MODEL_${role}`)), effort: str(read(`HADES_EFFORT_${role}`)) })).filter((r) => r.model || r.effort);
}

/** Ids de modelo das sessões recentes (~/.claude/projects/<projeto>/<sessão>.jsonl, só o fim de cada arquivo). */
export function recentModelIds(projectsDir: string = join(home(), ".claude", "projects")): Set<string> {
  const files = listDir(projectsDir).flatMap((project) =>
    listDir(join(projectsDir, project)).filter((n) => n.endsWith(".jsonl")).map((n) => join(projectsDir, project, n)),
  );
  const recent = files.map((file) => ({ file, at: mtimeMs(file) })).sort((a, b) => b.at - a.at).slice(0, RECENT_FILES);
  const ids = new Set<string>();
  for (const { file } of recent) {
    const text = readText(file) ?? "";
    for (const match of text.slice(-TAIL_BYTES).matchAll(/"model":"(claude-[A-Za-z0-9.-]+)"/g)) ids.add(match[1] as string);
  }
  return ids;
}

function mtimeMs(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export interface Finding {
  id: "esforco" | "janela-1m" | "chave-modelsettings" | "mais-caro";
  msg: string;
  fix: string;
}

export interface JudgeInput {
  json: Record<string, unknown>;
  roles: { role: string; model: string; effort: string }[];
  recentModels: ReadonlySet<string>;
}

export function judgeSettings({ json, roles, recentModels }: JudgeInput): Finding[] {
  const findings: Finding[] = [];
  const { model, effort } = inheritedDefault(json);
  if (HEAVY_EFFORTS.includes(effort)) {
    findings.push({ id: "esforco", msg: `"effortLevel": "${effort}" no settings.json vale para toda sessão, agente sem flags e subagente`, fix: 'baixe para "high" (ou menos) no ~/.claude/settings.json e deixe o esforço alto para o papel que precisa, em Configurações → Modelos por papel' });
  }
  if (MILLION_WINDOW.test(model)) {
    findings.push({ id: "janela-1m", msg: `"model": "${model}" tem janela de 1M: sem o limite natural do contexto, os tetos HADES_CTX_CAP_* viram só aviso`, fix: `troque por "${model.replace(MILLION_WINDOW, "")}" no settings.json se quiser o teto valendo, ou mantenha sabendo que o contexto só cresce até o aviso` });
  }
  const settings = json.modelSettings;
  if (typeof settings === "object" && settings !== null && !Array.isArray(settings) && recentModels.size > 0) {
    const known = [...recentModels].sort().join(", ");
    for (const key of Object.keys(settings)) {
      if (!recentModels.has(key.replace(MILLION_WINDOW, ""))) {
        findings.push({ id: "chave-modelsettings", msg: `modelSettings."${key}" não casa com nenhum modelo das sessões recentes (${known}): a configuração não vale`, fix: `renomeie a chave para o id exato do modelo em uso (um de: ${known})` });
      }
    }
  }
  const own = costOf(model, effort);
  if (own >= 0 && roles.length > 0 && roles.every((r) => costOf(r.model || model, r.effort || effort) < own)) {
    findings.push({ id: "mais-caro", msg: `o padrão (${model}${effort ? ` ${effort}` : ""}) é mais caro que todos os HADES_MODEL_*/HADES_EFFORT_*: qualquer agente sem flags roda acima do configurado`, fix: "aproxime o model/effortLevel do settings.json do papel mais usado, ou passe --model/--effort ao subir o agente" });
  }
  return findings;
}

export type InheritedView = { ok: true; model: string; effort: string; heirs: readonly string[] } | { ok: false; reason: string };

/** O que a página Modelos por papel mostra numa linha: o padrão herdado e quem o herda (só leitura). */
export function inheritedView(path?: string): InheritedView {
  const settings = readSettings(path);
  if (!settings.ok) return { ok: false, reason: settings.reason };
  return { ok: true, ...inheritedDefault(settings.json) };
}
