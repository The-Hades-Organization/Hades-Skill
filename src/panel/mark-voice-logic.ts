// Regras puras da voz do Mark pelo painel (reference/argos.md §Mark §Voz): o que o painel confere na entrada antes de repassar
// ao `/ws/voice` do Mark (mensagem de controle, tamanho e taxa de quadro) e como o código do Mark vira código do catálogo.
// Sem rede, sem relógio global e sem áudio em lugar nenhum: só o tamanho do quadro é lido.

export const VOICE_PATH = "/api/mark/voice";

/** Modos do Mark: segurar para falar (`ptt`) ou conversa aberta (`open`). */
export const VOICE_MODES = ["ptt", "open"] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

export const VOICE_LIMITS = {
  /** PCM16 mono a 16 kHz: 100 ms. O cliente manda 20–40 ms; acima disso o Mark também recusa. */
  frameBytes: 3200,
  /** 20 ms por quadro dá 50/s; a folga absorve a rajada depois de uma pausa da rede. */
  framesPerSecond: 100,
  /** Mensagem de controle é pequena (`{"type":"hello","mode":"open"}`). */
  controlBytes: 256,
  /** Controles que esperam a conexão com o Mark abrir. */
  pendingControls: 16,
  /** Áudio do Mark acumulado no socket do navegador: acima disso o quadro velho é descartado (voz atrasada é pior que cortada). */
  clientBufferedBytes: 262_144,
  /** Quadro do Mark ao navegador (PCM16 a 24 kHz). */
  upstreamFrameBytes: 262_144,
} as const;

const WINDOW_MS = 1000;

/** Códigos do protocolo do Mark → código estável do painel (catálogo de erros humanos). Só ganha valores. */
export const VOICE_ERRORS = {
  helloRequired: "mark_voice_hello_required",
  badMode: "mark_voice_bad_mode",
  badMessage: "mark_voice_bad_message",
  frameTooLarge: "mark_voice_frame_too_large",
  badFrame: "mark_voice_bad_frame",
  rateLimit: "mark_voice_rate_limit",
  idleTimeout: "mark_voice_idle_timeout",
  busy: "mark_voice_busy",
  tooLong: "mark_voice_too_long",
  unavailable: "mark_voice_unavailable",
  failed: "mark_voice_failed",
  /** Só do navegador (a vista os usa; o painel os serve em `GET /api/mark/voice`). */
  micDenied: "mark_voice_mic_denied",
  micMissing: "mark_voice_mic_missing",
  insecureContext: "mark_voice_insecure_context",
  micSilent: "mark_voice_mic_silent",
} as const;
export type VoiceErrorCode = (typeof VOICE_ERRORS)[keyof typeof VOICE_ERRORS];

export const CLIENT_VOICE_ERRORS: readonly VoiceErrorCode[] = [VOICE_ERRORS.micDenied, VOICE_ERRORS.micMissing, VOICE_ERRORS.insecureContext, VOICE_ERRORS.micSilent];

const PROTOCOL_CODES: Readonly<Record<string, VoiceErrorCode>> = {
  hello_required: VOICE_ERRORS.helloRequired,
  bad_mode: VOICE_ERRORS.badMode,
  bad_message: VOICE_ERRORS.badMessage,
  frame_too_large: VOICE_ERRORS.frameTooLarge,
  bad_frame: VOICE_ERRORS.badFrame,
  rate_limit: VOICE_ERRORS.rateLimit,
  idle_timeout: VOICE_ERRORS.idleTimeout,
};

/** Código que o Mark mandou em `error{code}`; um valor que o painel não conhece vira `mark_voice_failed` (nunca passa cru). */
export const voiceCodeOf = (protocolCode: unknown): VoiceErrorCode =>
  typeof protocolCode === "string" && Object.hasOwn(PROTOCOL_CODES, protocolCode) ? (PROTOCOL_CODES[protocolCode] as VoiceErrorCode) : VOICE_ERRORS.failed;

export const isVoiceMode = (value: unknown): value is VoiceMode => typeof value === "string" && (VOICE_MODES as readonly string[]).includes(value);

/** Mensagem que o painel entrega ao Mark: sempre reconstruída com os campos conhecidos, nunca o texto do navegador. */
export type ClientControl = { type: "hello"; mode: VoiceMode } | { type: "ptt"; down: boolean } | { type: "mode"; mode: VoiceMode } | { type: "bye" };

export type ControlCheck = { ok: true; message: ClientControl | undefined } | { ok: false; code: VoiceErrorCode };

/**
 * Confere uma mensagem de controle do navegador. `hello` vem primeiro e sem `mode` usa `defaultMode`; tipo desconhecido é
 * ignorado (um cliente novo pode falar mais que o Mark antigo), como no Mark.
 */
export function checkControl(text: string, helloDone: boolean, defaultMode: VoiceMode): ControlCheck {
  if (text.length > VOICE_LIMITS.controlBytes) return { ok: false, code: VOICE_ERRORS.badMessage };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: VOICE_ERRORS.badMessage };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, code: VOICE_ERRORS.badMessage };
  const body = raw as Record<string, unknown>;
  if (!helloDone) {
    if (body.type !== "hello") return { ok: false, code: VOICE_ERRORS.helloRequired };
    const mode = body.mode === undefined ? defaultMode : body.mode;
    return isVoiceMode(mode) ? { ok: true, message: { type: "hello", mode } } : { ok: false, code: VOICE_ERRORS.badMode };
  }
  switch (body.type) {
    case "bye":
      return { ok: true, message: { type: "bye" } };
    case "ptt":
      return typeof body.down === "boolean" ? { ok: true, message: { type: "ptt", down: body.down } } : { ok: false, code: VOICE_ERRORS.badMessage };
    case "mode":
      return isVoiceMode(body.mode) ? { ok: true, message: { type: "mode", mode: body.mode } } : { ok: false, code: VOICE_ERRORS.badMode };
    default:
      return { ok: true, message: undefined };
  }
}

/** Teto de tamanho e de taxa do quadro de áudio que sobe, na mesma ordem em que o Mark confere (tamanho, taxa, paridade). */
export class FrameGate {
  private windowStart: number;
  private count = 0;
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
    this.windowStart = now();
  }
  /** Código da recusa, ou `undefined` se o quadro passa. Só olha o tamanho. */
  check(bytes: number): VoiceErrorCode | undefined {
    const t = this.now();
    if (bytes > VOICE_LIMITS.frameBytes) return VOICE_ERRORS.frameTooLarge;
    if (t - this.windowStart >= WINDOW_MS) {
      this.windowStart = t;
      this.count = 0;
    }
    this.count += 1;
    if (this.count > VOICE_LIMITS.framesPerSecond) return VOICE_ERRORS.rateLimit;
    if (bytes % 2 !== 0) return VOICE_ERRORS.badFrame;
    return undefined;
  }
}
