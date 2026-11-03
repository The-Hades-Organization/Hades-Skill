// Conversa do agente no nó do canvas (reference/argos.md §Terminal, conversa e arquivos do agente): formata as entradas do
// diário (`hades journal`, reference/journal.md) como uma conversa curta de ler: o que o dono pediu, o que o agente fez e o
// que esperou. Lógica pura e sem Node: recebe os eventos já lidos (JSONL ou objetos) e devolve entradas prontas para
// desenhar. Quem lê o arquivo do diário é o servidor; aqui só se valida, filtra, limita e formata.

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const CONVERSATION_ERRORS = {
  invalidOption: "conversation_invalid_option",
  invalidInput: "conversation_invalid_input",
} as const;
export type ConversationErrorCode = (typeof CONVERSATION_ERRORS)[keyof typeof CONVERSATION_ERRORS];

export class ConversationError extends Error {
  readonly code: ConversationErrorCode;
  constructor(code: ConversationErrorCode, message: string) {
    super(message);
    this.name = "ConversationError";
    this.code = code;
  }
}

/** Tetos do que se devolve e do que se aceita ler. `entries` e `chars` são os padrões e também os máximos aceitos nas opções. */
export const CONVERSATION_LIMITS = {
  defaultEntries: 200,
  maxEntries: 1000,
  defaultChars: 400,
  maxChars: 4000,
  /** Eventos olhados por chamada (os mais recentes): o resto é descartado antes de qualquer formatação. */
  scanEvents: 20_000,
  /** Linhas de JSONL olhadas por chamada, pelo mesmo motivo. */
  scanLines: 20_000,
  /** Tamanho de uma linha de JSONL aceita; maior que isso é entrada inválida (o diário grava até ~3,5 KB). */
  lineBytes: 16_384,
} as const;

export type ConversationRole = "user" | "agent" | "system";

export interface ConversationEntry {
  /** Instante do evento em UTC, ISO 8601 com Z. */
  ts: string;
  role: ConversationRole;
  /** `kind` do evento do diário, para o desenho escolher ícone e tom. */
  kind: string;
  /** Rótulo curto: quem fala ou a ferramenta. */
  label: string;
  /** Texto em uma linha, já cortado em `maxChars`. */
  text: string;
  truncated: boolean;
}

export interface ConversationOptions {
  /** Quantas entradas, no máximo, das mais recentes. Padrão 200, teto 1000. */
  maxEntries?: number;
  /** Tamanho máximo do texto de cada entrada. Padrão 400, teto 4000. */
  maxChars?: number;
  /** Inclui o início de cada ferramenta (`tool_pre`). Padrão `false`: o fim (`tool_post`) já diz o que foi feito. */
  toolStarts?: boolean;
}

export interface Conversation {
  /** Em ordem cronológica (a mais antiga primeiro). */
  entries: ConversationEntry[];
  /** Entradas válidas que ficaram de fora porque passavam de `maxEntries` (as mais antigas). */
  omitted: number;
  /** Eventos que não são uma linha de diário válida (campo faltando, instante inválido, linha grande ou JSON quebrado). */
  invalid: number;
  /** Eventos mais antigos que o teto de leitura (`CONVERSATION_LIMITS.scanEvents`) e que nem foram olhados. */
  unscanned: number;
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
const asText = (value: unknown): string => (typeof value === "string" ? value : "");

const ELLIPSIS = "…";
const USER_LABEL = "você";
const AGENT_LABEL = "agente";
const SYSTEM_LABEL = "sistema";
const DECISION_LABEL = "decisão";

const fail = (code: ConversationErrorCode, message: string): never => {
  throw new ConversationError(code, message);
};

/** Uma linha só, sem corte no meio de um par substituto (emoji). */
export function clipLine(text: string, max: number): { text: string; truncated: boolean } {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return { text: flat, truncated: false };
  let end = max - ELLIPSIS.length;
  const last = flat.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: `${flat.slice(0, Math.max(0, end))}${ELLIPSIS}`, truncated: true };
}

function intOption(value: number | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) return fail(CONVERSATION_ERRORS.invalidOption, `${name} precisa ser um inteiro de 1 a ${max}`);
  return value;
}

interface Settings {
  maxEntries: number;
  maxChars: number;
  toolStarts: boolean;
}

function settingsOf(options: ConversationOptions): Settings {
  if (options.toolStarts !== undefined && typeof options.toolStarts !== "boolean") return fail(CONVERSATION_ERRORS.invalidOption, "toolStarts precisa ser booleano");
  return {
    maxEntries: intOption(options.maxEntries, CONVERSATION_LIMITS.defaultEntries, CONVERSATION_LIMITS.maxEntries, "maxEntries"),
    maxChars: intOption(options.maxChars, CONVERSATION_LIMITS.defaultChars, CONVERSATION_LIMITS.maxChars, "maxChars"),
    toolStarts: options.toolStarts ?? false,
  };
}

interface Shape {
  role: ConversationRole;
  label: string;
  text: string;
}

function decisionText(row: Dict, summary: string): string {
  const decision = row.decision;
  if (!isDict(decision)) return summary;
  const question = asText(decision.question);
  const chosen = asText(decision.chosen);
  if (!question && !chosen) return summary;
  return chosen ? `${question} → ${chosen}` : question;
}

/** Papel, rótulo e texto de um evento; `undefined` quando o evento não entra na conversa. */
function shapeOf(row: Dict, kind: string, summary: string, settings: Settings): Shape | undefined {
  const tool = asText(row.tool);
  switch (kind) {
    case "prompt":
      return { role: "user", label: USER_LABEL, text: summary };
    case "stop":
      return { role: "agent", label: AGENT_LABEL, text: summary };
    case "tool_post":
      return { role: "agent", label: tool || AGENT_LABEL, text: summary };
    case "tool_pre":
      return settings.toolStarts ? { role: "agent", label: tool || AGENT_LABEL, text: summary } : undefined;
    case "tool_blocked":
    case "permission":
    case "notification":
      return { role: "system", label: tool || SYSTEM_LABEL, text: summary };
    case "decision":
      return { role: "system", label: DECISION_LABEL, text: decisionText(row, summary) };
    default:
      return { role: "system", label: kind, text: summary };
  }
}

interface Candidate {
  at: number;
  entry: ConversationEntry;
}

function candidateOf(raw: unknown, settings: Settings): Candidate | "invalid" | undefined {
  if (!isDict(raw)) return "invalid";
  const ts = asText(raw.ts);
  const kind = asText(raw.kind);
  const at = Date.parse(ts);
  if (!kind || Number.isNaN(at) || typeof raw.summary !== "string") return "invalid";
  const shaped = shapeOf(raw, kind, raw.summary, settings);
  if (!shaped) return undefined;
  const clipped = clipLine(shaped.text, settings.maxChars);
  return { at, entry: { ts: new Date(at).toISOString(), role: shaped.role, kind, label: shaped.label, text: clipped.text, truncated: clipped.truncated } };
}

/**
 * Conversa a partir de eventos do diário (objetos já lidos). Olha só os `CONVERSATION_LIMITS.scanEvents` mais recentes,
 * descarta o que não é evento válido (contado em `invalid`) e devolve as `maxEntries` mais recentes em ordem
 * cronológica (empate de instante mantém a ordem de entrada). Não altera a entrada. `raw` que não é lista:
 * `conversation_invalid_input`; opção fora do intervalo: `conversation_invalid_option`.
 */
export function conversationFromEvents(raw: unknown, options: ConversationOptions = {}): Conversation {
  const settings = settingsOf(options);
  if (!Array.isArray(raw)) return fail(CONVERSATION_ERRORS.invalidInput, "os eventos precisam ser uma lista");
  const unscanned = Math.max(0, raw.length - CONVERSATION_LIMITS.scanEvents);
  const scanned = unscanned > 0 ? raw.slice(unscanned) : raw;
  const found: Candidate[] = [];
  let invalid = 0;
  for (const row of scanned) {
    const candidate = candidateOf(row, settings);
    if (candidate === "invalid") invalid += 1;
    else if (candidate) found.push(candidate);
  }
  // sort estável: o diário é gravado em ordem, mas vários hooks podem empatar no mesmo milissegundo
  found.sort((a, b) => a.at - b.at);
  const omitted = Math.max(0, found.length - settings.maxEntries);
  return { entries: found.slice(omitted).map((c) => c.entry), omitted, invalid, unscanned };
}

/**
 * Conversa a partir do texto do JSONL do diário (uma linha por evento). Linha em branco é ignorada; linha quebrada ou
 * maior que `CONVERSATION_LIMITS.lineBytes` entra em `invalid`. Só as `CONVERSATION_LIMITS.scanLines` últimas linhas são lidas.
 */
export function conversationFromJsonl(text: string, options: ConversationOptions = {}): Conversation {
  if (typeof text !== "string") return fail(CONVERSATION_ERRORS.invalidInput, "o diário precisa ser texto");
  const all = text.split("\n");
  const unscannedLines = Math.max(0, all.length - CONVERSATION_LIMITS.scanLines);
  const events: unknown[] = [];
  let broken = 0;
  for (const line of unscannedLines > 0 ? all.slice(unscannedLines) : all) {
    if (line.trim() === "") continue;
    if (line.length > CONVERSATION_LIMITS.lineBytes) {
      broken += 1;
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      broken += 1;
    }
  }
  const conversation = conversationFromEvents(events, options);
  return { ...conversation, invalid: conversation.invalid + broken, unscanned: conversation.unscanned + unscannedLines };
}
