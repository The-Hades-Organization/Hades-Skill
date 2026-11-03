// Contrato do terminal do painel (reference/panel.md §Terminal): rotas, códigos de recusa, limites e mensagens do
// WebSocket. A interface (term-ui) importa daqui e não repete número nem texto.

export const TERM_PATHS = { list: "/api/term", open: "/api/term/open", close: "/api/term/close", socket: "/api/term/ws" } as const;
export const TERM_PROTOCOL_VERSION = 1;

export const TERM_KINDS = ["shell", "claude", "herdr-client"] as const;
export type TermKind = (typeof TERM_KINDS)[number];

/** Códigos estáveis de recusa: o cliente ramifica por eles, nunca pelo texto. Só ganham valores. */
export const TERM_CODES = {
  disabled: "term_disabled",
  badRequest: "term_bad_request",
  forbiddenCwd: "term_forbidden_cwd",
  kindUnavailable: "term_kind_unavailable",
  maxSessions: "term_max_sessions",
  rateLimited: "term_rate_limited",
  unknownSession: "term_unknown_session",
  origin: "term_origin",
  spawnFailed: "term_spawn_failed",
  offsetTruncated: "term_offset_truncated",
  offsetAhead: "term_offset_ahead",
  outputTruncated: "term_output_truncated",
  badMessage: "term_bad_message",
} as const;
export type TermCode = (typeof TERM_CODES)[keyof typeof TERM_CODES];

export const TERM_STATUS: Readonly<Record<TermCode, number>> = {
  [TERM_CODES.disabled]: 403,
  [TERM_CODES.badRequest]: 400,
  [TERM_CODES.forbiddenCwd]: 403,
  [TERM_CODES.kindUnavailable]: 422,
  [TERM_CODES.maxSessions]: 429,
  [TERM_CODES.rateLimited]: 429,
  [TERM_CODES.unknownSession]: 404,
  [TERM_CODES.origin]: 403,
  [TERM_CODES.spawnFailed]: 500,
  [TERM_CODES.offsetTruncated]: 200,
  [TERM_CODES.offsetAhead]: 200,
  [TERM_CODES.outputTruncated]: 200,
  [TERM_CODES.badMessage]: 400,
};

/** Códigos de fechamento do WebSocket (faixa 4000 reservada ao app, RFC 6455 §7.4.2). */
export const TERM_CLOSE = { replaced: 4001, closed: 4002, expired: 4003, shutdown: 4004, protocol: 4005, exited: 1000 } as const;

export const TERM_LIMITS = {
  cols: { min: 20, max: 500, def: 80 },
  rows: { min: 5, max: 200, def: 24 },
  /** entrada do cliente por mensagem (quadro binário) */
  inputBytes: 65_536,
  /** mensagem de controle (texto JSON) */
  controlBytes: 4096,
  /** saída por quadro enviado ao cliente */
  frameBytes: 32_768,
  /** acima disto de fila no socket o servidor para de empurrar e espera o `drain` (a saída fica no anel) */
  sendHighWater: 1_048_576,
  resumeIdMax: 64,
  opensPerMinute: 12,
  /** sessão encerrada fica listada e retomável por este tempo para o cliente ler o fim */
  exitedKeepMs: 60_000,
  killGraceMs: 1500,
} as const;

/** Mensagens de texto do servidor para o cliente. */
export type TermServerMessage =
  | { t: "hello"; v: number; id: string; kind: TermKind; cwd: string; cols: number; rows: number; offset: number; start: number; end: number; state: "running" | "exited" }
  | { t: "warn"; code: TermCode; message: string; offset?: number; requested?: number; lost?: number }
  | { t: "exit"; code: number | null; signal: string | null }
  | { t: "pong" };

/** Mensagens de texto do cliente para o servidor (o quadro binário é a entrada crua do terminal). */
export type TermClientMessage = { t: "resize"; cols: number; rows: number } | { t: "close" } | { t: "ping" };

export class TermError extends Error {
  readonly code: TermCode;
  readonly retryAfterS: number | undefined;

  constructor(code: TermCode, message: string, retryAfterS?: number) {
    super(message);
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
}
