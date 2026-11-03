// Fonte externa do Thanatos (reference/thanatos.md §Fonte externa): o plugin do projeto declara em
// `plugin.json → commands[]` um comando `thanatos-source`; a Hades o chama com o intervalo e lê JSON (logs, métricas).
// Sem plugin, sem comando, sem token ou com erro, o post-mortem sai sem a seção e a lacuna diz o que faltou.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { isFile, readText, realpathMissingOk } from "./fs.ts";
import { maskSecrets } from "./journal.ts";
import type { SourceEvent, SourceMetric, SourceResult } from "./thanatos.ts";
import { toUtc } from "./thanatos.ts";

export const SOURCE_COMMAND = "thanatos-source";
export const SOURCE_SCHEMA_VERSION = 1;
export const TOKEN_ENV = "HADES_THANATOS_TOKEN";
const EVENTS_MAX = 500;
const METRICS_MAX = 200;
const TEXT_MAX = 500;
const STDOUT_MAX_BYTES = 4 * 1024 * 1024;
const NOTE_MAX = 200;
const RUNNERS: Record<string, string[]> = { ".sh": ["bash"], ".ts": [process.execPath] };

export interface SourceCommand { script: string; tokenKey?: string }

const gap = (status: SourceResult["status"], note: string): SourceResult => ({ status, note, events: [], metrics: [] });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** O `thanatos-source` do `plugin.json` da pasta env/ do pacote, com o script resolvido dentro dela; ou o motivo da ausência. */
export function declaredSource(envDir: string | undefined): { command: SourceCommand } | { absent: string } {
  if (envDir === undefined) return { absent: "o projeto não tem plugin com pasta env/" };
  let doc: unknown;
  try {
    doc = JSON.parse(readText(join(envDir, "plugin.json")) ?? "");
  } catch {
    return { absent: "o plugin não traz plugin.json legível" };
  }
  const list = isObject(doc) && Array.isArray(doc.commands) ? doc.commands : [];
  const entry = list.find((c): c is Record<string, unknown> => isObject(c) && c.name === SOURCE_COMMAND);
  if (entry === undefined) return { absent: `o plugin não declara o comando ${SOURCE_COMMAND} em plugin.json → commands[]` };
  const rel = entry.script;
  if (typeof rel !== "string" || rel === "" || rel.startsWith("/")) return { absent: `${SOURCE_COMMAND}: "script" precisa ser um caminho relativo ao env/` };
  const script = realpathMissingOk(resolve(envDir, rel));
  const root = realpathMissingOk(envDir);
  if (!script.startsWith(root + sep) || !isFile(script)) return { absent: `${SOURCE_COMMAND}: script fora do env/ ou inexistente (${clip(rel, NOTE_MAX)})` };
  if (RUNNERS[script.slice(script.lastIndexOf("."))] === undefined) return { absent: `${SOURCE_COMMAND}: só scripts .sh e .ts` };
  const tokenKey = typeof entry.tokenKey === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(entry.tokenKey) ? entry.tokenKey : undefined;
  return { command: { script, tokenKey } };
}

/** `CHAVE=valor` (ou `CHAVE: valor`, com marcador de lista opcional) de `credenciais.md`; nunca vai ao log nem ao post-mortem. */
export function tokenFromCredentials(text: string | undefined, key: string): string | undefined {
  for (const line of (text ?? "").split("\n")) {
    const m = /^\s*(?:[-*]\s*)?`?([A-Z][A-Z0-9_]*)`?\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === key && m[2] !== "") return (m[2] as string).replace(/^["'`]|["'`]$/g, "");
  }
  return undefined;
}

/** Valida a saída (`{v, events[], metrics[], start?}`): item ruim é descartado; documento inteiro ruim vira undefined. */
export function parseSourceOutput(stdout: string): Omit<SourceResult, "status" | "note"> | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isObject(doc) || typeof doc.v !== "number" || doc.v < SOURCE_SCHEMA_VERSION) return undefined;
  const events: SourceEvent[] = [];
  for (const e of Array.isArray(doc.events) ? doc.events : []) {
    if (!isObject(e) || typeof e.ts !== "string" || typeof e.text !== "string" || events.length >= EVENTS_MAX) continue;
    const ts = toUtc(e.ts);
    if (ts === undefined) continue;
    events.push({ ts, text: maskSecrets(clip(e.text, TEXT_MAX)), ...(typeof e.level === "string" ? { level: clip(e.level, 16) } : {}) });
  }
  const metrics: SourceMetric[] = [];
  for (const m of Array.isArray(doc.metrics) ? doc.metrics : []) {
    if (!isObject(m) || typeof m.name !== "string" || typeof m.value !== "number" || !Number.isFinite(m.value) || metrics.length >= METRICS_MAX) continue;
    const ts = typeof m.ts === "string" ? toUtc(m.ts) : undefined;
    metrics.push({ name: clip(m.name, 80), value: m.value, ...(typeof m.unit === "string" ? { unit: clip(m.unit, 16) } : {}), ...(ts ? { ts } : {}) });
  }
  const start = typeof doc.start === "string" ? toUtc(doc.start) : undefined;
  return { events, metrics, ...(start ? { start } : {}) };
}

export interface SourceDeps {
  envDir: string | undefined;
  /** conteúdo de $D/credenciais.md, quando há */
  credentials: string | undefined;
  timeoutS: number;
}

/** Roda o `thanatos-source` para o intervalo (UTC). Nunca lança: o que faltou vira o `status` e a `note`. */
export function fetchSource(from: string, to: string, deps: SourceDeps): SourceResult {
  const declared = declaredSource(deps.envDir);
  if ("absent" in declared) return gap("absent", declared.absent);
  const { script, tokenKey } = declared.command;
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8", TZ: "UTC" };
  if (tokenKey !== undefined) {
    const token = tokenFromCredentials(deps.credentials, tokenKey);
    if (token === undefined) return gap("no-token", `${SOURCE_COMMAND} pede ${tokenKey} e ele não está em credenciais.md`);
    env[TOKEN_ENV] = token;
  }
  const runner = RUNNERS[script.slice(script.lastIndexOf("."))] as string[];
  const r = spawnSync(runner[0] as string, [...runner.slice(1), script, from, to], {
    cwd: dirname(script), env, encoding: "utf8", timeout: deps.timeoutS * 1000, maxBuffer: STDOUT_MAX_BYTES, stdio: ["ignore", "pipe", "pipe"],
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return gap("error", `${SOURCE_COMMAND} passou de ${deps.timeoutS}s`);
  if (r.error) return gap("error", `${SOURCE_COMMAND} não executou: ${clip(maskSecrets(r.error.message), NOTE_MAX)}`);
  if ((r.status ?? 1) !== 0) {
    const why = maskSecrets((r.stderr ?? "").trim().split("\n").pop() ?? "");
    return gap("error", `${SOURCE_COMMAND} saiu com ${r.status}${why ? `: ${clip(why, NOTE_MAX)}` : ""}`);
  }
  const parsed = parseSourceOutput(r.stdout ?? "");
  if (parsed === undefined) return gap("error", `${SOURCE_COMMAND} não devolveu o JSON do contrato (v>=${SOURCE_SCHEMA_VERSION}, events[], metrics[])`);
  return { status: "ok", note: `${parsed.events.length} evento(s) e ${parsed.metrics.length} métrica(s) da fonte`, ...parsed };
}
