// Voz do Mark pelo painel (reference/argos.md §Mark §Voz): `GET /api/mark/voice` vira WebSocket e o painel repassa, sem olhar
// o áudio, para o `/ws/voice` do Mark (PCM16 16 kHz para cima, 24 kHz para baixo, mais controle JSON). O navegador fala só
// com o painel: o token da ponte é lido do `bridge.json` a cada conexão e nunca sai daqui. Um cliente por vez, tetos de
// quadro e de taxa na entrada, timeout para o Mark abrir, teto de duração da sessão e fechamento conjunto dos dois lados.
// Nenhum áudio vai a log, arquivo ou auditoria: só o tamanho do quadro é lido.
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { type Bridge, MARK_ERRORS, type OfflineCause, isRecord, markWsUrl, parseState, readBridge } from "../lib/mark-bridge.ts";
import { explain } from "../lib/human-errors.ts";
import type { Auth } from "./auth.ts";
import { send } from "./http.ts";
import { log } from "./log.ts";
import { createAudit, publicState, tlsFor } from "./mark.ts";
import {
  CLIENT_VOICE_ERRORS, FrameGate, VOICE_ERRORS, VOICE_LIMITS, VOICE_MODES, VOICE_PATH, type ClientControl, type VoiceMode, checkControl, isVoiceMode, voiceCodeOf,
} from "./mark-voice-logic.ts";

const WS_UNAUTHORIZED = 4001;
const CLOSE_NORMAL = 1000;
const SOCKET_IDLE_S = 120;
/** Passa do teto de quadro (3200) para o painel responder `frame_too_large` em vez de o Bun derrubar o socket sem código. */
const MAX_CLIENT_MESSAGE_BYTES = 16_384;
const DEFAULT_CONNECT_MS = 5000;
const DEFAULT_MAX_SESSION_MS = 600_000;

export interface VoiceSocketData {
  kind: "voice";
  remote: boolean;
}

export type OpenVoiceSocket = (url: string, init: { headers: Record<string, string>; tls?: { rejectUnauthorized: boolean } }) => WebSocket;

export interface MarkVoiceDeps {
  auth: Auth;
  port: number;
  /** Mesma regra de Origin do terminal (`originAllowedFor`). */
  originAllowed(req: Request, remote: boolean): boolean;
  /** `bridge.json` (HADES_MARK_BRIDGE), lido a cada conexão. */
  bridgePath(): string;
  /** Espera para o Mark abrir o `/ws/voice`, em ms. */
  connectTimeoutMs?: () => number;
  /** Duração máxima de uma sessão de voz, em ms. */
  maxSessionMs?: () => number;
  /** Modo quando o navegador não diz (`ptt` por padrão). */
  defaultMode?: () => VoiceMode;
  /** Causa de o Mark estar fora (ou `undefined` se atende): distingue "sem voz" de "fora do ar" quando o `/ws/voice` não abre. */
  reachable(): Promise<OfflineCause | undefined>;
  openSocket?: OpenVoiceSocket;
  auditFile?: string;
  now?: () => number;
}

export interface MarkVoice {
  /** Responde ao `GET /api/mark/voice`: upgrade, ou o JSON de configuração se o pedido não é de WebSocket. */
  handle(req: Request, server: Server<VoiceSocketData>): Response | undefined;
  websocket: WebSocketHandler<VoiceSocketData>;
  isVoicePath(path: string): boolean;
  /** Encerra a sessão aberta (desligamento do painel). */
  close(): void;
  active(): boolean;
}

/** Corpo de `error`/`busy` ao navegador: código estável e o texto do catálogo. */
function errorBody(code: string, type: "error" | "busy" = "error"): Record<string, unknown> {
  const { title, cause, action, ref } = explain(code);
  return { type, code, explain: { code, title, cause, action, ref } };
}

export function createMarkVoice(deps: MarkVoiceDeps): MarkVoice {
  const now = deps.now ?? Date.now;
  const connectMs = (): number => deps.connectTimeoutMs?.() ?? DEFAULT_CONNECT_MS;
  const maxSessionMs = (): number => deps.maxSessionMs?.() ?? DEFAULT_MAX_SESSION_MS;
  const defaultMode = (): VoiceMode => deps.defaultMode?.() ?? "ptt";
  const openSocket: OpenVoiceSocket = deps.openSocket ?? ((url, init) => new WebSocket(url, init as unknown as string[]));
  const audit = createAudit(deps.auditFile, now);
  let holder: Session | undefined;

  class Session {
    private upstream: WebSocket | undefined;
    private upstreamOpen = false;
    private pending: string[] = [];
    private helloDone = false;
    private readonly gate = new FrameGate(now);
    private connectTimer: ReturnType<typeof setTimeout> | undefined;
    private limitTimer: ReturnType<typeof setTimeout> | undefined;
    private ended = false;
    private readonly startedAt = now();

    private readonly ws: ServerWebSocket<VoiceSocketData>;

    constructor(ws: ServerWebSocket<VoiceSocketData>) {
      this.ws = ws;
    }

    start(): void {
      const read = readBridge(deps.bridgePath());
      if (!read.ok) return this.fail(read.cause);
      audit("voice_open", { remote: this.ws.data.remote }, {});
      this.limitTimer = setTimeout(() => this.fail(VOICE_ERRORS.tooLong), maxSessionMs());
      this.connectTimer = setTimeout(() => void this.failUnopened(), connectMs());
      this.connect(read.bridge);
    }

    private connect(bridge: Bridge): void {
      let socket: WebSocket;
      try {
        socket = openSocket(`${markWsUrl(bridge)}/voice`, { headers: { Authorization: `Bearer ${bridge.token}` }, tls: tlsFor(bridge) });
      } catch {
        void this.failUnopened();
        return;
      }
      socket.binaryType = "arraybuffer";
      this.upstream = socket;
      socket.onopen = () => {
        if (this.ended) return;
        this.upstreamOpen = true;
        this.clearConnectTimer();
        for (const text of this.pending) socket.send(text);
        this.pending = [];
      };
      socket.onmessage = (event: MessageEvent) => this.fromMark(event.data);
      socket.onerror = () => { if (!this.upstreamOpen) void this.failUnopened(); };
      socket.onclose = (event: CloseEvent) => {
        if (this.ended) return;
        if (!this.upstreamOpen) return void this.failUnopened(event.code === WS_UNAUTHORIZED ? MARK_ERRORS.rejected : undefined);
        // o Mark fechou depois de abrir: o `error` (se houve) já foi repassado
        this.end(event.code === WS_UNAUTHORIZED ? MARK_ERRORS.rejected : "mark_closed");
      };
    }

    private clearConnectTimer(): void {
      if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }

    /** O `/ws/voice` não abriu: se o Mark responde ao estado ele está de pé sem voz; senão a causa é a da ponte. */
    private async failUnopened(rejected?: OfflineCause): Promise<void> {
      if (this.ended) return;
      this.clearConnectTimer();
      if (rejected !== undefined) return this.fail(rejected);
      const cause = await deps.reachable().catch(() => MARK_ERRORS.unreachable);
      this.fail(cause ?? VOICE_ERRORS.unavailable);
    }

    fromClient(message: string | Buffer): void {
      if (this.ended) return;
      if (typeof message === "string") return this.controlFromClient(message);
      const refused = this.helloDone ? this.gate.check(message.byteLength) : VOICE_ERRORS.helloRequired;
      if (refused !== undefined) return this.fail(refused);
      // antes do Mark abrir não há para onde mandar: o quadro é descartado (o cliente espera o `ready` para falar)
      if (this.upstreamOpen && this.upstream !== undefined) this.upstream.send(message);
    }

    private controlFromClient(text: string): void {
      const checked = checkControl(text, this.helloDone, defaultMode());
      if (!checked.ok) return this.fail(checked.code);
      const control = checked.message;
      if (control === undefined) return;
      if (control.type === "hello") this.helloDone = true;
      this.toMark(control);
      if (control.type === "bye") this.end("bye");
    }

    private toMark(control: ClientControl): void {
      const text = JSON.stringify(control);
      if (this.upstreamOpen && this.upstream !== undefined) this.upstream.send(text);
      else if (this.pending.length < VOICE_LIMITS.pendingControls) this.pending.push(text);
    }

    private fromMark(data: unknown): void {
      if (this.ended) return;
      if (typeof data !== "string") {
        if (!(data instanceof ArrayBuffer) || data.byteLength > VOICE_LIMITS.upstreamFrameBytes) return;
        // voz atrasada é pior que cortada: com o navegador atrás, o quadro velho sai
        if (this.ws.getBufferedAmount() < VOICE_LIMITS.clientBufferedBytes) this.ws.sendBinary(new Uint8Array(data));
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        return;
      }
      if (!isRecord(raw)) return;
      switch (raw.type) {
        case "ready":
          return this.json({ type: "ready", max_s: Math.round(maxSessionMs() / 1000) });
        case "interrupted":
          return this.json({ type: "interrupted" });
        case "busy":
          this.json(errorBody(VOICE_ERRORS.busy, "busy"));
          return this.end(VOICE_ERRORS.busy);
        case "error":
          return this.fail(voiceCodeOf(raw.code));
        case "state": {
          const state = parseState(raw);
          if (state === undefined) return;
          const voice = isRecord(raw.voice) ? { remote: raw.voice.remote === true, mode: isVoiceMode(raw.voice.mode) ? raw.voice.mode : null } : { remote: false, mode: null };
          return this.json({ type: "state", ...publicState(state), voice });
        }
        default:
          return;
      }
    }

    private json(body: Record<string, unknown>): void {
      try {
        this.ws.sendText(JSON.stringify(body));
      } catch {
        this.end("send_failed");
      }
    }

    fail(code: string): void {
      if (this.ended) return;
      this.json(errorBody(code));
      this.end(code);
    }

    /** Um fim só para os dois lados: timers, ouvintes, o socket do Mark e o do navegador saem juntos, e a vaga volta. */
    end(reason: string): void {
      if (this.ended) return;
      this.ended = true;
      this.clearConnectTimer();
      if (this.limitTimer !== undefined) clearTimeout(this.limitTimer);
      if (holder === this) holder = undefined;
      const socket = this.upstream;
      if (socket !== undefined) {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        try {
          if (this.upstreamOpen) socket.send(JSON.stringify({ type: "bye" }));
          socket.close();
        } catch {
          // já fechado do outro lado
        }
      }
      try {
        this.ws.close(CLOSE_NORMAL, reason.slice(0, 120));
      } catch {
        // o navegador já foi embora
      }
      audit("voice_close", { remote: this.ws.data.remote }, { reason, seconds: Math.round((now() - this.startedAt) / 1000) });
    }
  }

  const sessions = new WeakMap<ServerWebSocket<VoiceSocketData>, Session>();

  /** JSON de `GET /api/mark/voice` sem upgrade: padrões e o texto dos erros que só o navegador conhece. */
  function info(): Response {
    const texts: Record<string, unknown> = {};
    for (const code of CLIENT_VOICE_ERRORS) {
      const { title, cause, action, ref } = explain(code);
      texts[code] = { code, title, cause, action, ref };
    }
    return send(200, { mode: defaultMode(), modes: [...VOICE_MODES], max_s: Math.round(maxSessionMs() / 1000), frame_bytes: VOICE_LIMITS.frameBytes, explain: texts });
  }

  return {
    handle(req, server) {
      const remote = deps.auth.isRemote(req.headers, deps.port);
      if (!deps.auth.hostOk(req.headers, deps.port)) return send(403, { error: "host" });
      if (!deps.auth.authed(req.headers, deps.port)) return send(401, { error: "acesso remoto exige a chave" });
      if (!deps.originAllowed(req, remote)) return send(403, { error: "origem do WebSocket não permitida", code: "panel_origin" });
      if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return info();
      if (server.upgrade(req, { data: { kind: "voice", remote } satisfies VoiceSocketData })) return undefined;
      return send(400, { error: "o pedido não é um upgrade de WebSocket", code: "panel_bad_request" });
    },
    websocket: {
      maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
      idleTimeout: SOCKET_IDLE_S,
      open(ws) {
        if (holder !== undefined) {
          // um cliente por vez: o segundo ouve `busy` e a conexão fecha antes de tocar no Mark
          ws.sendText(JSON.stringify(errorBody(VOICE_ERRORS.busy, "busy")));
          ws.close(CLOSE_NORMAL, VOICE_ERRORS.busy);
          return;
        }
        const session = new Session(ws);
        holder = session;
        sessions.set(ws, session);
        try {
          session.start();
        } catch (error) {
          log("error", "voz do Mark falhou ao abrir", { reason: error instanceof Error ? error.name : "erro" });
          session.end("internal_error");
        }
      },
      message(ws, message) {
        sessions.get(ws)?.fromClient(message);
      },
      close(ws) {
        sessions.get(ws)?.end("client_closed");
      },
    },
    isVoicePath: (path) => path === VOICE_PATH,
    close() {
      holder?.end("panel_stopping");
    },
    active: () => holder !== undefined,
  };
}
