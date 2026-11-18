// Abstração dos providers de agente suportados pela Hades ("claude" e "agy").
// Fonte única para construção de argv (interativo e print/-p), resolução de modelos/esforço/permissões,
// parsing de stream-json, adaptação de payload de hooks e localização de transcripts/config.
import { join } from "node:path";
import { pyDumps } from "./pyjson.ts";

export const AGENT_PROVIDER_IDS = ["claude", "agy"] as const;
export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];

export const DEFAULT_AGENT_PROVIDER: AgentProviderId = "claude";
export const AGENT_PROVIDER_KEY = "HADES_AGENT_PROVIDER";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export type ModelTier = "opus" | "sonnet" | "haiku";
export type PermissionMode = "auto" | "accept-edits" | "plan" | "skip-all";
export type OutputFormat = "text" | "json" | "stream-json";

export type ConfigReader = (key: string) => string | undefined;

type Dict = Record<string, unknown>;

const isRecord = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
const dictOf = (value: unknown): Dict => (isRecord(value) ? value : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const truthy = (value: unknown): boolean =>
  !(value === undefined || value === null || value === false || value === 0 || value === "" || (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0));

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;
const DENIED = /denied|negad|not allowed|permission|auto mode|classifier|blocked|bloquead/i;
const TOOL_RESULT_CUT = 2000;
const TOOL_INPUT_CUT = 300;
const NOTE_CUT = 600;
const FAILURE_CUT = 800;
const DENIED_SCAN = 600;
const PATH_CUT = 80;
const INPUT_KEYS = ["command", "file_path", "pattern", "path", "url", "query", "description", "prompt", "subagent_type"];

export function pyDumpsUtf8(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pyDumpsUtf8).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${pyDumpsUtf8(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return pyDumpsUtf8(value);
}

export function cutText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : pyDumpsUtf8(value);
  if (text.length <= max) return text;
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max).join("")}… (+${points.length - max} caracteres)`;
}

export function summarizeToolInput(input: unknown): string {
  if (!isRecord(input)) return cutText(truthy(input) ? input : "", TOOL_INPUT_CUT);
  for (const key of INPUT_KEYS) {
    if (!truthy(input[key])) continue;
    const extra = key === "pattern" && truthy(input.path) ? ` · ${cutText(input.path, PATH_CUT)}` : "";
    return cutText(pyStr(input[key]), TOOL_INPUT_CUT) + extra;
  }
  return cutText(input, TOOL_INPUT_CUT);
}

// ------------------------------------------------------------------ Argv Builders

export interface PrintArgvOptions {
  bin?: string;
  prompt?: string;
  model?: string;
  effort?: EffortLevel | string;
  permissionMode?: PermissionMode;
  outputFormat?: OutputFormat;
  verbose?: boolean;
  includePartialMessages?: boolean;
  resumeSessionId?: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  noTools?: boolean;
  readOnly?: boolean;
  noSessionPersistence?: boolean;
  strictMcpConfig?: boolean;
  readConfig?: ConfigReader;
}

export interface InteractiveArgvOptions {
  bin?: string;
  model?: string;
  effort?: EffortLevel | string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  systemPromptFile?: string;
  systemPrompt?: string;
  readConfig?: ConfigReader;
}

// ------------------------------------------------------------------ Stream & Result

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelTokenBreakdown extends TokenBreakdown {
  costUsd: number | null;
}

export type NormalizedStreamEvent =
  | { t: "init"; session: string | null; model: string | null }
  | { t: "delta"; text: string }
  | { t: "text"; text: string; sub: boolean }
  | { t: "tool"; id: string | null; name: string | null; input: string; rawInput: Dict; sub: boolean }
  | { t: "tool_result"; id: string | null; text: string; error: boolean; denied: boolean; sub: boolean }
  | { t: "warn"; text: string }
  | {
      t: "result";
      ok: boolean;
      subtype: string | null;
      resultText: string;
      text: string | null;
      session: string | null;
      costUsd: number | null;
      tokens: TokenBreakdown;
      tokensByModel?: Record<string, ModelTokenBreakdown>;
      durationMs: number | null;
      turns: number | null;
      denials: { tool: string | null; input: string }[];
    }
  | { t: "stderr"; text: string };

// ------------------------------------------------------------------ Hooks

export type CanonicalHookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "Notification"
  | "Stop"
  | "UserPromptSubmit"
  | "SessionStart"
  | "PreInvocation"
  | "PostInvocation";

export type CanonicalToolName = "Bash" | "Read" | "Write" | "Edit" | "NotebookEdit" | string;

export interface CanonicalHookInput {
  provider: AgentProviderId;
  rawEventName: string;
  hook_event_name: CanonicalHookEvent | string;
  session_id: string;
  transcript_path: string;
  cwd: string;
  tool_name?: CanonicalToolName;
  tool_input?: Dict;
  tool_response?: Dict;
  message?: string;
  notification_type?: string;
  prompt?: string;
}

export interface CanonicalHookDecision {
  exit: number;
  additionalContext?: string;
  blockReason?: string;
}

export interface FormattedHookProcessOutput {
  exit: number;
  stdout: string;
  stderr: string;
}

// ------------------------------------------------------------------ AgentProvider Interface

export interface AgentProvider {
  readonly id: AgentProviderId;
  readonly herdrKind: AgentProviderId;
  readonly defaultBinary: string;
  readonly processNames: readonly string[];

  readonly cliCapabilities: {
    readonly modelFlag?: string;
    readonly effortFlag?: string;
    readonly systemPromptFlag?: string;
    readonly systemPromptFileFlag?: string;
    readonly supportsResume: boolean;
  };

  resolveBinary(readConfig: ConfigReader, whichFn: (cmd: string) => string | undefined, homeDir: string): string | undefined;
  resolveModel(modelOrAlias: string | undefined, role?: string, readConfig?: ConfigReader): string;
  buildPrintArgv(opts: PrintArgvOptions): string[];
  buildInteractiveArgv(opts: InteractiveArgvOptions): string[];
  parseStreamLine(line: string, opts?: { includeDeltas?: boolean }): NormalizedStreamEvent[];
  normalizeHookInput(raw: Dict): CanonicalHookInput;
  formatHookOutput(decision: CanonicalHookDecision, hookEventName: string): FormattedHookProcessOutput;
  extractContextTokensFromTail(tailText: string): number;

  paths: {
    settingsFile(homeDir: string, env?: NodeJS.ProcessEnv): string;
    hooksFile(homeDir: string, env?: NodeJS.ProcessEnv): string;
    projectsDir(homeDir: string, env?: NodeJS.ProcessEnv): string;
    projectTranscriptDir(cwd: string, homeDir: string): string;
    conversationsDir(homeDir: string): string;
    memoryDir(cwd: string, homeDir: string): string;
    globalSkillsDir(homeDir: string): string;
    globalAgentsDir(homeDir: string): string;
    globalCommandsDir(homeDir: string, env?: NodeJS.ProcessEnv): string;
    readonly instructionFiles: readonly string[];
  };
}

// ------------------------------------------------------------------ Implementação: claudeProvider

const CLAUDE_MODELS: Readonly<Record<string, string>> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

const CLAUDE_DEFAULT_MODEL_BY_ROLE: Readonly<Record<string, string>> = {
  IMPL: "claude-sonnet-5-5",
  CONSOLIDATE: "claude-sonnet-5-5",
};
const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";

const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

export function extractClaudeTokens(result: Dict): { tokens: TokenBreakdown; tokensByModel?: Record<string, ModelTokenBreakdown> } {
  const usageByModel = result.modelUsage;
  if (isRecord(usageByModel) && Object.keys(usageByModel).length > 0) {
    const byModel: Record<string, ModelTokenBreakdown> = {};
    const total: TokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const [model, raw] of Object.entries(usageByModel)) {
      const v = dictOf(raw);
      const entry: TokenBreakdown = {
        input: num(v.inputTokens),
        output: num(v.outputTokens),
        cacheRead: num(v.cacheReadInputTokens),
        cacheWrite: num(v.cacheCreationInputTokens),
      };
      for (const k of TOKEN_KEYS) total[k] += entry[k];
      byModel[model] = { ...entry, costUsd: typeof v.costUSD === "number" ? v.costUSD : null };
    }
    return { tokens: total, tokensByModel: byModel };
  }
  const usage = dictOf(result.usage);
  return {
    tokens: {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
    },
  };
}

function claudeAssistantEvents(o: Dict, sub: boolean): NormalizedStreamEvent[] {
  const out: NormalizedStreamEvent[] = [];
  for (const raw of listOf(dictOf(o.message).content)) {
    const c = dictOf(raw);
    if (c.type === "text" && pyStr(c.text ?? "").trim()) {
      out.push({ t: "text", text: String(c.text), sub });
    } else if (c.type === "tool_use") {
      const rawInput = dictOf(c.input);
      out.push({
        t: "tool",
        id: typeof c.id === "string" ? c.id : null,
        name: typeof c.name === "string" ? c.name : null,
        input: summarizeToolInput(c.input),
        rawInput,
        sub,
      });
    }
  }
  return out;
}

function claudeToolResultEvents(o: Dict, sub: boolean): NormalizedStreamEvent[] {
  const out: NormalizedStreamEvent[] = [];
  for (const raw of listOf(dictOf(o.message).content)) {
    const b = dictOf(raw);
    if (b.type !== "tool_result") continue;
    let body: unknown = b.content;
    if (Array.isArray(body)) body = body.filter(isRecord).map((x) => pyStr(x.text ?? "")).join("\n");
    const text = (typeof body === "string" ? body : "").replace(ANSI, "");
    const error = Boolean(b.is_error);
    const denied = error && DENIED.test(Array.from(text).slice(0, DENIED_SCAN).join(""));
    out.push({
      t: "tool_result",
      id: typeof b.tool_use_id === "string" ? b.tool_use_id : null,
      text: cutText(text, TOOL_RESULT_CUT),
      error,
      denied,
      sub,
    });
  }
  return out;
}

function claudeResultEvent(o: Dict): NormalizedStreamEvent {
  const denials = listOf(o.permission_denials).map((d) => {
    const item = dictOf(d);
    return {
      tool: typeof item.tool_name === "string" ? item.tool_name : null,
      input: summarizeToolInput(item.tool_input),
    };
  });
  const error = Boolean(o.is_error);
  const { tokens, tokensByModel } = extractClaudeTokens(o);
  const resultText = typeof o.result === "string" ? o.result : "";
  return {
    t: "result",
    ok: !error,
    subtype: typeof o.subtype === "string" ? o.subtype : null,
    resultText,
    text: error ? cutText(truthy(o.result) ? o.result : "", FAILURE_CUT) : null,
    session: typeof o.session_id === "string" ? o.session_id : null,
    costUsd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : null,
    tokens,
    ...(tokensByModel !== undefined ? { tokensByModel } : {}),
    durationMs: typeof o.duration_ms === "number" ? o.duration_ms : null,
    turns: typeof o.num_turns === "number" ? o.num_turns : null,
    denials,
  };
}

export const claudeProvider: AgentProvider = {
  id: "claude",
  herdrKind: "claude",
  defaultBinary: "claude",
  processNames: ["claude"],

  cliCapabilities: {
    modelFlag: "--model",
    effortFlag: "--effort",
    systemPromptFileFlag: "--append-system-prompt-file",
    supportsResume: true,
  },

  resolveBinary(readConfig, whichFn, homeDir) {
    const configured = (readConfig("HADES_CHAT_BIN") ?? "").trim().replace(/^~(?=$|\/)/, homeDir);
    if (configured !== "") return configured;
    return whichFn("claude");
  },

  resolveModel(modelOrAlias, role, readConfig) {
    const trimmed = modelOrAlias?.trim() ?? "";
    if (trimmed !== "") return CLAUDE_MODELS[trimmed] ?? trimmed;
    const key = role?.trim().toUpperCase() ?? "";
    if (key !== "" && readConfig) {
      const fromCfg = readConfig(`HADES_MODEL_${key}`)?.trim() ?? "";
      if (fromCfg !== "") return CLAUDE_MODELS[fromCfg] ?? fromCfg;
    }
    return CLAUDE_DEFAULT_MODEL_BY_ROLE[key] ?? CLAUDE_DEFAULT_MODEL;
  },

  buildPrintArgv(opts) {
    const argv: string[] = [opts.bin ?? "claude", "-p"];
    if (opts.prompt !== undefined) argv.push(opts.prompt);
    // Bifurcação intencional (prompt === undefined vs definido) para preservar a ordem posicional exata
    // dos testes existentes de chat.ts/argos-supervisor.ts (stdin) e review.ts/moirai.ts (prompt posicional).
    if (opts.outputFormat !== undefined && opts.prompt === undefined) {
      argv.push("--output-format", opts.outputFormat);
    }
    if (opts.verbose && opts.prompt === undefined) argv.push("--verbose");
    if (opts.includePartialMessages) argv.push("--include-partial-messages");
    if (opts.noTools) argv.push("--tools", "");
    if (opts.strictMcpConfig) argv.push("--strict-mcp-config");
    if (opts.noSessionPersistence) argv.push("--no-session-persistence");
    if (opts.permissionMode !== undefined && opts.prompt === undefined) {
      if (opts.permissionMode === "skip-all") argv.push("--dangerously-skip-permissions");
      else argv.push("--permission-mode", opts.permissionMode);
    }
    if (opts.model !== undefined && opts.model !== "") {
      argv.push("--model", CLAUDE_MODELS[opts.model] ?? opts.model);
    }
    if (opts.effort !== undefined && opts.effort !== "") {
      argv.push("--effort", opts.effort);
    }
    if (opts.permissionMode !== undefined && opts.prompt !== undefined) {
      if (opts.permissionMode === "skip-all") argv.push("--dangerously-skip-permissions");
      else argv.push("--permission-mode", opts.permissionMode);
    }
    if (opts.outputFormat !== undefined && opts.prompt !== undefined) {
      argv.push("--output-format", opts.outputFormat);
    }
    if (opts.verbose && opts.prompt !== undefined) argv.push("--verbose");
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      argv.push("--allowedTools", ...opts.allowedTools);
    }
    if (opts.disallowedTools && opts.disallowedTools.length > 0) {
      argv.push("--disallowedTools", ...opts.disallowedTools);
    }
    if (opts.resumeSessionId !== undefined && opts.resumeSessionId !== "") {
      argv.push("--resume", opts.resumeSessionId);
    }
    return argv;
  },

  buildInteractiveArgv(opts) {
    const argv: string[] = [];
    if (opts.bin !== undefined && opts.bin !== "") argv.push(opts.bin);
    if (opts.permissionMode !== undefined) {
      if (opts.permissionMode === "skip-all") argv.push("--dangerously-skip-permissions");
      else argv.push("--permission-mode", opts.permissionMode);
    }
    if (opts.model !== undefined && opts.model !== "") argv.push("--model", opts.model);
    if (opts.effort !== undefined && opts.effort !== "") argv.push("--effort", opts.effort);
    if (opts.systemPromptFile !== undefined && opts.systemPromptFile !== "") {
      argv.push("--append-system-prompt-file", opts.systemPromptFile);
    } else if (opts.systemPrompt !== undefined && opts.systemPrompt !== "") {
      argv.push("--append-system-prompt", opts.systemPrompt);
    }
    if (opts.resumeSessionId !== undefined && opts.resumeSessionId !== "") {
      argv.push("--resume", opts.resumeSessionId);
    }
    return argv;
  },

  parseStreamLine(line, opts) {
    const deltas = Boolean(opts?.includeDeltas);
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      const text = line.trim();
      return text ? [{ t: "stderr", text: cutText(text.replace(ANSI, ""), NOTE_CUT) }] : [];
    }
    if (!isRecord(o)) return [];
    const sub = truthy(o.parent_tool_use_id);
    switch (o.type) {
      case "system": {
        if (o.subtype === "init") {
          return [{
            t: "init",
            model: typeof o.model === "string" ? o.model : null,
            session: typeof o.session_id === "string" ? o.session_id : null,
          }];
        }
        const text = [o.message, o.output, o.stdout].find(truthy) ?? "";
        return pyStr(o.subtype).includes("hook") && typeof text === "string" && text.trim()
          ? [{ t: "warn", text: cutText(text.trim(), NOTE_CUT) }]
          : [];
      }
      case "stream_event": {
        const event = dictOf(o.event);
        const delta = dictOf(event.delta);
        return deltas && !sub && event.type === "content_block_delta" && delta.type === "text_delta" && truthy(delta.text)
          ? [{ t: "delta", text: String(delta.text) }]
          : [];
      }
      case "assistant":
        return claudeAssistantEvents(o, sub);
      case "user":
        return claudeToolResultEvents(o, sub);
      case "result":
        return [claudeResultEvent(o)];
      default:
        return [];
    }
  },

  normalizeHookInput(raw) {
    const event = str(raw.hook_event_name);
    const tool = str(raw.tool_name);
    const message = str(raw.message);
    const notificationType = str(raw.notification_type);
    const prompt = str(raw.prompt);
    return {
      provider: "claude",
      rawEventName: event,
      hook_event_name: event,
      session_id: str(raw.session_id),
      transcript_path: str(raw.transcript_path),
      cwd: str(raw.cwd),
      ...(tool !== "" ? { tool_name: tool } : {}),
      ...(isRecord(raw.tool_input) ? { tool_input: raw.tool_input } : {}),
      ...(isRecord(raw.tool_response) ? { tool_response: raw.tool_response } : {}),
      ...(message !== "" ? { message } : {}),
      ...(notificationType !== "" ? { notification_type: notificationType } : {}),
      ...(prompt !== "" ? { prompt } : {}),
    };
  },

  formatHookOutput(decision, hookEventName) {
    if (decision.exit === 2) {
      return { exit: 2, stdout: "", stderr: decision.blockReason ?? "" };
    }
    if (decision.additionalContext !== undefined && decision.additionalContext !== "") {
      const stdout = `${pyDumps({ hookSpecificOutput: { hookEventName, additionalContext: decision.additionalContext } }).replace(
        /[\u0080-\uffff]/g,
        (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
      )}\n`;
      return { exit: 0, stdout, stderr: "" };
    }
    return { exit: 0, stdout: "", stderr: "" };
  },

  extractContextTokensFromTail(tailText) {
    const lines = tailText.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i] as string;
      if (!line.includes('"usage"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry)) continue;
      const usage = entry.type === "assistant" && !entry.isSidechain ? (dictOf(entry.message).usage as Dict | undefined) : undefined;
      if (isRecord(usage)) {
        return [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].reduce<number>(
          (sum, v) => sum + (typeof v === "number" ? v : 0),
          0,
        );
      }
    }
    return 0;
  },

  paths: {
    settingsFile: (homeDir, env = process.env) => env.HADES_CLAUDE_SETTINGS || join(homeDir, ".claude", "settings.json"),
    hooksFile: (homeDir, env = process.env) => env.HADES_CLAUDE_SETTINGS || join(homeDir, ".claude", "settings.json"),
    projectsDir: (homeDir, env = process.env) => env.HADES_CLAUDE_PROJECTS || join(homeDir, ".claude", "projects"),
    projectTranscriptDir: (cwd, homeDir) => join(homeDir, ".claude", "projects", cwd.replace(/\/+$/, "").replace(/[/.]/g, "-")),
    conversationsDir: (homeDir) => join(homeDir, ".claude", "projects"),
    memoryDir: (cwd, homeDir) => join(homeDir, ".claude", "projects", cwd.replace(/\/+$/, "").replace(/[/.]/g, "-"), "memory"),
    globalSkillsDir: (homeDir) => join(homeDir, ".claude", "skills"),
    globalAgentsDir: (homeDir) => join(homeDir, ".claude", "agents"),
    globalCommandsDir: (homeDir, env = process.env) => env.HADES_CLAUDE_COMMANDS || join(homeDir, ".claude", "commands"),
    instructionFiles: ["CLAUDE.md"],
  },
};

// ------------------------------------------------------------------ Implementação: agyProvider

const AGY_DEFAULT_OPUS_MODEL = "gemini-4-argon";
const AGY_DEFAULT_SONNET_MODEL = "gemini-4-argon";
const AGY_DEFAULT_HAIKU_MODEL = "gemini-3-flash";

const AGY_TOOL_MAP: Readonly<Record<string, CanonicalToolName>> = {
  run_command: "Bash",
  read_file: "Read",
  view_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  multi_edit: "Edit",
  invoke_subagent: "Agent",
};

export function mapAgyToolName(name: string): CanonicalToolName {
  return AGY_TOOL_MAP[name] ?? name;
}

export function normalizeAgyToolArgs(rawName: string, rawArgs: Dict): Dict {
  const canonical = mapAgyToolName(rawName);
  const out: Dict = { ...rawArgs };
  if (canonical === "Bash") {
    const cmd = str(rawArgs.CommandLine || rawArgs.command);
    if (cmd !== "") out.command = cmd;
    if (rawArgs.IsDaemon === true || (typeof rawArgs.WaitMsBeforeAsync === "number" && rawArgs.WaitMsBeforeAsync <= 500)) {
      out.run_in_background = true;
    }
    const summary = str(rawArgs.toolSummary || rawArgs.description);
    if (summary !== "") out.description = summary;
  } else if (canonical === "Read") {
    const filePath = str(rawArgs.Path || rawArgs.file_path);
    if (filePath !== "") out.file_path = filePath;
    const start = typeof rawArgs.StartLine === "number" ? rawArgs.StartLine : undefined;
    const end = typeof rawArgs.EndLine === "number" ? rawArgs.EndLine : undefined;
    if (start !== undefined) out.offset = start;
    else if (typeof rawArgs.ByteOffset === "number") out.offset = rawArgs.ByteOffset;
    if (end !== undefined) out.limit = start !== undefined ? Math.max(1, end - start + 1) : end;
  } else if (canonical === "Write" || canonical === "Edit") {
    const filePath = str(rawArgs.Path || rawArgs.file_path);
    if (filePath !== "") out.file_path = filePath;
  } else if (canonical === "Agent") {
    const subType = str(rawArgs.TypeName || rawArgs.subagent_type);
    if (subType !== "") out.subagent_type = subType;
    const desc = str(rawArgs.Role || rawArgs.Prompt || rawArgs.description);
    if (desc !== "") out.description = desc;
  }
  return out;
}

function resolveAgyModelString(raw: string, readConfig?: ConfigReader): string {
  const lower = raw.trim().toLowerCase();
  if (lower === "" || lower === "opus" || lower.startsWith("claude-opus") || lower.startsWith("claude-fable")) {
    return readConfig?.("HADES_AGY_MODEL_OPUS")?.trim() || AGY_DEFAULT_OPUS_MODEL;
  }
  if (lower === "sonnet" || lower.startsWith("claude-sonnet")) {
    return readConfig?.("HADES_AGY_MODEL_SONNET")?.trim() || AGY_DEFAULT_SONNET_MODEL;
  }
  if (lower === "haiku" || lower.startsWith("claude-haiku")) {
    return readConfig?.("HADES_AGY_MODEL_HAIKU")?.trim() || AGY_DEFAULT_HAIKU_MODEL;
  }
  return raw.trim();
}

function agyStepUpdateEvents(o: Dict): NormalizedStreamEvent[] {
  const out: NormalizedStreamEvent[] = [];
  const sub = isRecord(o.subagent_info) || truthy(o.parent_tool_use_id);
  const toolInfo = isRecord(o.tool_info) ? o.tool_info : undefined;
  const rawToolName = str(toolInfo?.name || o.tool_name);
  if (rawToolName !== "") {
    const canonicalName = mapAgyToolName(rawToolName);
    const rawArgs = isRecord(toolInfo?.args) ? toolInfo.args : isRecord(toolInfo?.parameters) ? toolInfo.parameters : {};
    const normalizedInput = normalizeAgyToolArgs(rawToolName, rawArgs);
    const toolId = typeof toolInfo?.id === "string" ? toolInfo.id : typeof o.step_index === "number" ? `step-${o.step_index}` : null;
    if (typeof toolInfo?.output === "string" && (o.state === "DONE" || o.state === "ERROR")) {
      const clean = toolInfo.output.replace(ANSI, "");
      const error = o.state === "ERROR" || Boolean(toolInfo.is_error) || Boolean(o.error);
      out.push({
        t: "tool_result",
        id: toolId,
        text: cutText(clean, TOOL_RESULT_CUT),
        error,
        denied: error && DENIED.test(Array.from(clean).slice(0, DENIED_SCAN).join("")),
        sub,
      });
    } else {
      out.push({
        t: "tool",
        id: toolId,
        name: canonicalName,
        input: summarizeToolInput(normalizedInput),
        rawInput: normalizedInput,
        sub,
      });
    }
  }
  const responseText = typeof o.response === "string" ? o.response : typeof o.content === "string" ? o.content : "";
  if (responseText.trim() !== "") {
    out.push({ t: "text", text: responseText, sub });
  }
  return out;
}

function agyResultEvent(o: Dict): NormalizedStreamEvent {
  const usage = dictOf(o.usage);
  const tokens: TokenBreakdown = {
    input: num(usage.input_tokens ?? usage.total_input_tokens),
    output: num(usage.output_tokens ?? usage.total_output_tokens),
    cacheRead: num(usage.cache_read_tokens ?? usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_write_tokens ?? usage.cache_creation_input_tokens),
  };
  const costUsd = typeof usage.total_usd === "number" ? usage.total_usd : typeof o.total_cost_usd === "number" ? o.total_cost_usd : null;
  const denials = listOf(o.denied_actions ?? o.permission_denials).map((d) => {
    const item = dictOf(d);
    const rawName = str(item.tool_name || item.tool || item.name);
    const rawIn = isRecord(item.tool_input) ? item.tool_input : isRecord(item.args) ? item.args : item;
    return {
      tool: rawName !== "" ? mapAgyToolName(rawName) : null,
      input: summarizeToolInput(rawName !== "" ? normalizeAgyToolArgs(rawName, rawIn) : rawIn),
    };
  });
  const errStr = typeof o.error === "string" ? o.error.trim() : "";
  const isErr = Boolean(o.is_error) || errStr !== "";
  const resultText = typeof o.response === "string" ? o.response : typeof o.result === "string" ? o.result : "";
  const session = typeof o.conversation_id === "string" ? o.conversation_id : typeof o.session_id === "string" ? o.session_id : null;
  return {
    t: "result",
    ok: !isErr,
    subtype: typeof o.subtype === "string" ? o.subtype : isErr ? "error" : "success",
    resultText,
    text: isErr ? cutText(errStr || resultText, FAILURE_CUT) : null,
    session,
    costUsd,
    tokens,
    durationMs: typeof o.duration_ms === "number" ? o.duration_ms : null,
    turns: typeof o.num_turns === "number" ? o.num_turns : null,
    denials,
  };
}

export const agyProvider: AgentProvider = {
  id: "agy",
  herdrKind: "agy",
  defaultBinary: "agy",
  processNames: ["agy"],

  cliCapabilities: {
    modelFlag: "--model",
    effortFlag: "--effort",
    supportsResume: true,
  },

  resolveBinary(readConfig, whichFn, homeDir) {
    const agyExplicit = (readConfig("HADES_AGY_BIN") ?? "").trim().replace(/^~(?=$|\/)/, homeDir);
    if (agyExplicit !== "") return agyExplicit;
    const chatBin = (readConfig("HADES_CHAT_BIN") ?? "").trim().replace(/^~(?=$|\/)/, homeDir);
    if (chatBin !== "" && chatBin !== "claude" && !chatBin.endsWith("/claude")) return chatBin;
    return whichFn("agy");
  },

  resolveModel(modelOrAlias, role, readConfig) {
    const trimmed = modelOrAlias?.trim() ?? "";
    if (trimmed !== "") return resolveAgyModelString(trimmed, readConfig);
    const key = role?.trim().toUpperCase() ?? "";
    if (key !== "" && readConfig) {
      const fromCfg = readConfig(`HADES_MODEL_${key}`)?.trim() ?? "";
      if (fromCfg !== "") return resolveAgyModelString(fromCfg, readConfig);
    }
    return resolveAgyModelString("opus", readConfig);
  },

  buildPrintArgv(opts) {
    const argv: string[] = [opts.bin ?? "agy", "-p"];
    if (opts.prompt !== undefined) argv.push(opts.prompt);
    if (opts.outputFormat !== undefined) {
      argv.push("--output-format", opts.outputFormat);
    }
    if (opts.readOnly || opts.noTools || opts.permissionMode === "plan") {
      argv.push("--mode", "plan");
    } else if (opts.permissionMode === "accept-edits") {
      argv.push("--mode", "accept-edits");
    } else if (opts.permissionMode === "auto" || opts.permissionMode === "skip-all") {
      argv.push("--mode", "auto");
      const skip = opts.permissionMode === "skip-all" || opts.readConfig?.("HADES_AGY_SKIP_PERMISSIONS")?.trim() === "1";
      if (skip) argv.push("--dangerously-skip-permissions");
    }
    if (opts.model !== undefined && opts.model !== "") {
      argv.push("--model", resolveAgyModelString(opts.model, opts.readConfig));
    }
    if (opts.effort !== undefined && opts.effort !== "") {
      argv.push("--effort", opts.effort);
    }
    if (opts.resumeSessionId !== undefined && opts.resumeSessionId !== "") {
      argv.push("--conversation", opts.resumeSessionId);
    }
    return argv;
  },

  buildInteractiveArgv(opts) {
    const argv: string[] = [];
    if (opts.bin !== undefined && opts.bin !== "") argv.push(opts.bin);
    if (opts.permissionMode === "plan") argv.push("--mode", "plan");
    else if (opts.permissionMode === "accept-edits") argv.push("--mode", "accept-edits");
    else if (opts.permissionMode === "auto" || opts.permissionMode === "skip-all") {
      argv.push("--mode", "auto");
      const skip = opts.permissionMode === "skip-all" || opts.readConfig?.("HADES_AGY_SKIP_PERMISSIONS")?.trim() === "1";
      if (skip) argv.push("--dangerously-skip-permissions");
    }
    if (opts.model !== undefined && opts.model !== "") {
      argv.push("--model", resolveAgyModelString(opts.model, opts.readConfig));
    }
    if (opts.effort !== undefined && opts.effort !== "") {
      argv.push("--effort", opts.effort);
    }
    if (opts.resumeSessionId !== undefined && opts.resumeSessionId !== "") {
      argv.push("--conversation", opts.resumeSessionId);
    }
    return argv;
  },

  parseStreamLine(line, opts) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      const text = line.trim();
      return text ? [{ t: "stderr", text: cutText(text.replace(ANSI, ""), NOTE_CUT) }] : [];
    }
    if (!isRecord(o)) return [];
    switch (o.type) {
      case "init": {
        const session = typeof o.conversation_id === "string" ? o.conversation_id : typeof o.session_id === "string" ? o.session_id : null;
        return [{ t: "init", session, model: typeof o.model === "string" ? o.model : null }];
      }
      case "step_update":
        return agyStepUpdateEvents(o);
      case "result":
        return [agyResultEvent(o)];
      default:
        // Aceita também linhas no formato Claude caso misturadas no stream
        return claudeProvider.parseStreamLine(line, opts);
    }
  },

  normalizeHookInput(raw) {
    if ("hook_event_name" in raw && !("hookEventName" in raw)) {
      return claudeProvider.normalizeHookInput(raw);
    }
    const rawEvent = str(raw.hookEventName || raw.hook_event_name);
    const canonicalEvent: CanonicalHookEvent | string = rawEvent === "PreInvocation" ? "UserPromptSubmit" : rawEvent;
    const sessionId = str(raw.conversationId || raw.session_id);
    const transcriptPath = str(raw.transcriptPath || raw.transcript_path);
    const workspaces = Array.isArray(raw.workspacePaths) ? raw.workspacePaths : [];
    const cwd = str(raw.cwd || (typeof workspaces[0] === "string" ? workspaces[0] : ""));
    const toolCall = isRecord(raw.toolCall) ? raw.toolCall : undefined;
    const rawToolName = str(toolCall?.name || raw.tool_name);
    const canonicalTool = rawToolName !== "" ? mapAgyToolName(rawToolName) : undefined;
    const rawArgs = isRecord(toolCall?.args) ? toolCall.args : isRecord(raw.tool_input) ? raw.tool_input : undefined;
    const normalizedInput = rawArgs && rawToolName !== "" ? normalizeAgyToolArgs(rawToolName, rawArgs) : rawArgs;
    const errText = str(raw.error);
    const toolResponse: Dict | undefined =
      canonicalEvent === "PostToolUse"
        ? { is_error: errText !== "", ...(errText !== "" ? { error: errText } : {}) }
        : isRecord(raw.tool_response)
          ? raw.tool_response
          : undefined;
    const prompt = str(raw.lastUserInput || raw.prompt);
    const message = str(raw.message);
    return {
      provider: "agy",
      rawEventName: rawEvent,
      hook_event_name: canonicalEvent,
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
      ...(canonicalTool !== undefined ? { tool_name: canonicalTool } : {}),
      ...(normalizedInput !== undefined ? { tool_input: normalizedInput } : {}),
      ...(toolResponse !== undefined ? { tool_response: toolResponse } : {}),
      ...(message !== "" ? { message } : {}),
      ...(prompt !== "" ? { prompt } : {}),
    };
  },

  formatHookOutput(decision, hookEventName) {
    if (hookEventName === "PreToolUse") {
      if (decision.exit === 2) {
        return {
          exit: 0,
          stdout: `${JSON.stringify({ decision: "deny", reason: decision.blockReason ?? "Bloqueado pela guarda da Hades" })}\n`,
          stderr: "",
        };
      }
      if (decision.additionalContext !== undefined && decision.additionalContext !== "") {
        return {
          exit: 0,
          stdout: `${JSON.stringify({ decision: "allow", reason: decision.additionalContext })}\n`,
          stderr: "",
        };
      }
      return { exit: 0, stdout: `${JSON.stringify({ decision: "allow" })}\n`, stderr: "" };
    }
    if (hookEventName === "PreInvocation" || hookEventName === "PostInvocation" || hookEventName === "SessionStart") {
      if (decision.exit === 2) {
        return {
          exit: 0,
          stdout: `${JSON.stringify({
            injectSteps: [{ errorMessage: { userMessage: decision.blockReason ?? "Bloqueado pela guarda da Hades" } }],
            terminationBehavior: "terminate",
          })}\n`,
          stderr: "",
        };
      }
      if (decision.additionalContext !== undefined && decision.additionalContext !== "") {
        return {
          exit: 0,
          stdout: `${JSON.stringify({
            injectSteps: [{ systemMessage: { systemMessage: decision.additionalContext } }],
          })}\n`,
          stderr: "",
        };
      }
      return { exit: 0, stdout: "{}\n", stderr: "" };
    }
    if (hookEventName === "Stop") {
      if (decision.exit === 2) {
        return {
          exit: 0,
          stdout: `${JSON.stringify({ decision: "continue", reason: decision.blockReason ?? "" })}\n`,
          stderr: "",
        };
      }
      return { exit: 0, stdout: `${JSON.stringify({ decision: "stop" })}\n`, stderr: "" };
    }
    // PostToolUse e demais eventos no agy esperam objeto JSON vazio {}
    return { exit: 0, stdout: "{}\n", stderr: "" };
  },

  extractContextTokensFromTail(tailText) {
    const lines = tailText.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i] as string;
      if (!line.includes('"PLANNER_RESPONSE"') && !line.includes('"usage"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry)) continue;
      if (entry.type === "PLANNER_RESPONSE") {
        const total = num(entry.input_tokens) + num(entry.cache_read_tokens) + num(entry.cache_write_tokens);
        if (total > 0) return total;
      }
      const usage = entry.type === "assistant" && !entry.isSidechain ? (dictOf(entry.message).usage as Dict | undefined) : undefined;
      if (isRecord(usage)) {
        return [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].reduce<number>(
          (sum, v) => sum + (typeof v === "number" ? v : 0),
          0,
        );
      }
    }
    return 0;
  },

  paths: {
    settingsFile: (homeDir, env = process.env) => env.HADES_AGY_SETTINGS || join(homeDir, ".gemini", "antigravity-cli", "settings.json"),
    hooksFile: (homeDir, env = process.env) => env.HADES_AGY_HOOKS || join(homeDir, ".gemini", "config", "hooks.json"),
    projectsDir: (homeDir, env = process.env) => env.HADES_AGY_PROJECTS || join(homeDir, ".gemini", "config", "projects"),
    projectTranscriptDir: (cwd, homeDir) => join(homeDir, ".claude", "projects", cwd.replace(/\/+$/, "").replace(/[/.]/g, "-")),
    conversationsDir: (homeDir) => join(homeDir, ".gemini", "antigravity-cli", "brain"),
    memoryDir: (cwd, homeDir) => join(homeDir, ".claude", "projects", cwd.replace(/\/+$/, "").replace(/[/.]/g, "-"), "memory"),
    globalSkillsDir: (homeDir) => join(homeDir, ".gemini", "config", "skills"),
    globalAgentsDir: (homeDir) => join(homeDir, ".gemini", "config", "agents"),
    globalCommandsDir: (homeDir, env = process.env) => env.HADES_AGY_COMMANDS || join(homeDir, ".gemini", "config", "workflows"),
    instructionFiles: ["CLAUDE.md", "AGENTS.md", "GEMINI.md"],
  },
};

// ------------------------------------------------------------------ Registro e Resolução

const PROVIDERS = new Map<AgentProviderId, AgentProvider>([
  ["claude", claudeProvider],
  ["agy", agyProvider],
]);

export function registerAgentProvider(provider: AgentProvider): void {
  PROVIDERS.set(provider.id, provider);
}

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return typeof value === "string" && (AGENT_PROVIDER_IDS as readonly string[]).includes(value);
}

export function providerOf(id: string | undefined): AgentProvider {
  if (id !== undefined && isAgentProviderId(id)) {
    return PROVIDERS.get(id) ?? claudeProvider;
  }
  return claudeProvider;
}

export function detectHookProvider(raw: Dict): AgentProvider {
  if ("hookEventName" in raw || "conversationId" in raw || "toolCall" in raw) {
    return agyProvider;
  }
  return claudeProvider;
}

export function activeProviderId(role?: string, readConfig?: ConfigReader, env: NodeJS.ProcessEnv = process.env): AgentProviderId {
  const read: ConfigReader = (key) => env[key] ?? readConfig?.(key);
  if (role !== undefined && role.trim() !== "") {
    const byRole = read(`${AGENT_PROVIDER_KEY}_${role.trim().toUpperCase()}`)?.trim();
    if (isAgentProviderId(byRole)) return byRole;
  }
  const globalChoice = read(AGENT_PROVIDER_KEY)?.trim();
  if (isAgentProviderId(globalChoice)) return globalChoice;
  return DEFAULT_AGENT_PROVIDER;
}

export function activeProvider(role?: string, readConfig?: ConfigReader, env: NodeJS.ProcessEnv = process.env): AgentProvider {
  return providerOf(activeProviderId(role, readConfig, env));
}
