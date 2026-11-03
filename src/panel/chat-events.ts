// Uma linha do stream-json do `claude -p` (ou os marcadores hds_user/hds_end que o painel grava) vira eventos compactos
// para a tela.
import { pyStr } from "./actions.ts";

type Dict = Record<string, unknown>;
export type ChatEvent = Dict;

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;
const DENIED = /denied|negad|not allowed|permission|auto mode|classifier|blocked|bloquead/i;
const TOOL_RESULT_CUT = 2000;
const TOOL_INPUT_CUT = 300;
const NOTE_CUT = 600;
const FAILURE_CUT = 800;
const DENIED_SCAN = 600;
const PATH_CUT = 80;
const INPUT_KEYS = ["command", "file_path", "pattern", "path", "url", "query", "description", "prompt"];
const TOKEN_FIELDS: [string, string][] = [
  ["input", "inputTokens"], ["output", "outputTokens"], ["cacheRead", "cacheReadInputTokens"], ["cacheWrite", "cacheCreationInputTokens"],
];
const USAGE_FIELDS: [string, string][] = [
  ["input", "input_tokens"], ["output", "output_tokens"], ["cacheRead", "cache_read_input_tokens"], ["cacheWrite", "cache_creation_input_tokens"],
];

/** `json.dumps(valor, ensure_ascii=False)` do Python: separadores ", " e ": ", texto em UTF-8 puro. */
export function pyDumpsUtf8(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pyDumpsUtf8).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${pyDumpsUtf8(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
const dictOf = (value: unknown): Dict => (isDict(value) ? value : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const truthy = (value: unknown): boolean =>
  !(value === undefined || value === null || value === false || value === 0 || value === "" || (Array.isArray(value) && value.length === 0) || (isDict(value) && Object.keys(value).length === 0));
const num = (value: unknown): number => (typeof value === "number" && value ? value : 0);

/** Corta em `n` caracteres (pontos de código, como o str do Python) e conta o que ficou de fora. */
export function cut(value: unknown, n: number): string {
  const text = typeof value === "string" ? value : pyDumpsUtf8(value);
  if (text.length <= n) return text;
  const points = Array.from(text);
  return points.length <= n ? text : `${points.slice(0, n).join("")}… (+${points.length - n} caracteres)`;
}

/** Entrada de ferramenta resumida: o campo que diz o que ela faz, não o JSON inteiro. */
export function toolInput(input: unknown): string {
  if (!isDict(input)) return cut(truthy(input) ? input : "", TOOL_INPUT_CUT);
  for (const key of INPUT_KEYS) {
    if (!truthy(input[key])) continue;
    const extra = key === "pattern" && truthy(input.path) ? ` · ${cut(input.path, PATH_CUT)}` : "";
    return cut(pyStr(input[key]), TOOL_INPUT_CUT) + extra;
  }
  return cut(input, TOOL_INPUT_CUT);
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function tokensOf(result: Dict): Tokens {
  const byModel = Object.values(dictOf(result.modelUsage));
  const read = (fields: [string, string][], from: (field: string) => number): Tokens => {
    const out: Dict = {};
    for (const [key, field] of fields) out[key] = from(field);
    return out as unknown as Tokens;
  };
  if (byModel.length) return read(TOKEN_FIELDS, (field) => byModel.reduce<number>((sum, v) => sum + num(dictOf(v)[field]), 0));
  const usage = dictOf(result.usage);
  return read(USAGE_FIELDS, (field) => num(usage[field]));
}

function assistantEvents(o: Dict, sub: boolean): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const raw of listOf(dictOf(o.message).content)) {
    const c = dictOf(raw);
    if (c.type === "text" && pyStr(c.text ?? "").trim()) out.push({ t: "text", text: c.text, sub });
    else if (c.type === "tool_use") out.push({ t: "tool", id: c.id ?? null, name: c.name ?? null, input: toolInput(c.input), sub });
  }
  return out;
}

function toolResultEvents(o: Dict, sub: boolean): ChatEvent[] {
  const out: ChatEvent[] = [];
  const content = dictOf(o.message).content;
  for (const raw of listOf(content)) {
    const b = dictOf(raw);
    if (b.type !== "tool_result") continue;
    let body: unknown = b.content;
    if (Array.isArray(body)) body = body.filter(isDict).map((x) => pyStr(x.text ?? "")).join("\n");
    const text = (typeof body === "string" ? body : "").replace(ANSI, "");
    const error = Boolean(b.is_error);
    out.push({ t: "tool_result", id: b.tool_use_id ?? null, text: cut(text, TOOL_RESULT_CUT), error, denied: error && DENIED.test(Array.from(text).slice(0, DENIED_SCAN).join("")), sub });
  }
  return out;
}

function resultEvent(o: Dict): ChatEvent {
  const denials = listOf(o.permission_denials).map((d) => ({ tool: dictOf(d).tool_name ?? null, input: toolInput(dictOf(d).tool_input) }));
  const error = Boolean(o.is_error);
  return {
    t: "result", ok: !error, subtype: o.subtype ?? null, cost: o.total_cost_usd ?? null, tokens: tokensOf(o), ms: o.duration_ms ?? null,
    turns: o.num_turns ?? null, denials, text: error ? cut(truthy(o.result) ? o.result : "", FAILURE_CUT) : null,
  };
}

export function chatEvents(line: string, deltas: boolean): ChatEvent[] {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    const text = line.trim();
    return text ? [{ t: "stderr", text: cut(text.replace(ANSI, ""), NOTE_CUT) }] : [];
  }
  if (!isDict(o)) return [];
  const sub = truthy(o.parent_tool_use_id);
  switch (o.type) {
    case "hds_user": return [{ t: "user", text: o.text ?? "", remote: Boolean(o.remote), ts: o.ts ?? null }];
    case "hds_end": return [{ t: "end", rc: o.rc ?? null, stopped: Boolean(o.stopped) }];
    case "system": {
      if (o.subtype === "init") return [{ t: "init", model: o.model ?? null, session: o.session_id ?? null }];
      const text = [o.message, o.output, o.stdout].find(truthy) ?? "";
      // ex.: aviso do teto de contexto da sessão interativa
      return pyStr(o.subtype).includes("hook") && typeof text === "string" && text.trim() ? [{ t: "warn", text: cut(text.trim(), NOTE_CUT) }] : [];
    }
    case "stream_event": {
      const event = dictOf(o.event);
      const delta = dictOf(event.delta);
      return deltas && !sub && event.type === "content_block_delta" && delta.type === "text_delta" && truthy(delta.text) ? [{ t: "delta", text: delta.text }] : [];
    }
    case "assistant": return assistantEvents(o, sub);
    case "user": return toolResultEvents(o, sub);
    case "result": return [resultEvent(o)];
    default: return [];
  }
}
