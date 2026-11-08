// Mark no Argos (reference/argos.md §Mark): o servidor do painel fala com o Mark-LVI pela ponte em loopback e o navegador só
// fala com o painel. Quatro rotas de leitura e escrita (`/api/mark/state`, `command`, `wake`, `report`) e o SSE
// `/api/mark/events`, que repassa o `/ws` do Mark. O `bridge.json` é relido a cada chamada e a cada conexão; o token nunca sai
// daqui, nem o caminho do arquivo nem o do relatório. Toda chamada ao Mark tem timeout, e o ws fecha junto com o SSE.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { type Bridge, MARK_ERRORS, type MarkStateBody, type OfflineCause, isRecord, markUrl, markWsUrl, parseState, readBridge } from "../lib/mark-bridge.ts";
import { explain } from "../lib/human-errors.ts";
import { send } from "./http.ts";

type Dict = Record<string, unknown>;

export const MARK_LIMITS = {
  /** Teto do texto de um pedido, em caracteres. */
  commandChars: 2000,
  /** Teto do texto de cada linha de log repassada ao navegador. */
  logChars: 4000,
  /** Teto do relatório lido (bytes); o excedente é cortado e marcado. */
  reportBytes: 262_144,
  /** Streams SSE abertos ao mesmo tempo; o excedente recebe 429. */
  streams: 8,
  /** Pedidos por janela (command e wake juntos): o Mark tem microfone e voz, abuso daqui vira barulho na sala. */
  rateCount: 10,
  rateWindowMs: 10_000,
  /** Corpo da resposta do Mark lido na chamada (o estado tem poucas centenas de bytes). */
  upstreamBytes: 65_536,
} as const;

const RETRY_AFTER_S = 5;
const KEEP_ALIVE_MS = 15_000;
const RECONNECT_MS = 3000;
const DEFAULT_TIMEOUT_MS = 5000;
const WS_UNAUTHORIZED = 4001;
const REPORT_DIR = "reports";
const REPORT_EXT = ".md";
const ROUTES = { state: "/api/mark/state", command: "/api/mark/command", wake: "/api/mark/wake", events: "/api/mark/events", report: "/api/mark/report" } as const;

export interface MarkDeps {
  /** Caminho do `bridge.json` (HADES_MARK_BRIDGE), lido a cada chamada. */
  bridgePath(): string;
  /** Timeout de cada chamada ao Mark, em ms. */
  timeoutMs?: () => number;
  fetch?: typeof fetch;
  openSocket?: (url: string, init: { headers: Record<string, string>; tls?: { rejectUnauthorized: boolean } }) => WebSocket;
  /** Arquivo de auditoria (uma linha JSON por pedido que muda o Mark). Sem ele, nada é gravado. */
  auditFile?: string;
  now?: () => number;
  keepAliveMs?: number;
  maxStreams?: number;
  /** Leitura do relatório (injetável nos testes). */
  report?: { real(path: string): string; size(path: string): number; read(path: string, bytes: number): string };
}

export interface Mark {
  /** GET /api/mark/*: undefined se o caminho não é do Mark. */
  get(path: string, req: Request): Promise<Response | undefined>;
  /** POST /api/mark/*: undefined se o caminho não é do Mark. */
  post(path: string, body: Dict, caller: { remote: boolean }): Promise<Response | undefined>;
  /** `undefined` se o Mark responde ao estado; senão a causa de estar fora (usada para explicar uma voz que não abriu). */
  reachable(): Promise<OfflineCause | undefined>;
  /** Fecha todos os streams (desligamento do painel). */
  close(): void;
  size(): number;
}

/** O que o navegador recebe do estado: sem o caminho do relatório (que fica na máquina do Mark). */
export function publicState(state: MarkStateBody): Dict {
  return {
    name: state.name, state: state.state, speaking: state.speaking, muted: state.muted, claude: state.claude,
    last_report: state.last_report === null ? null : { title: state.last_report.title, ts: state.last_report.ts },
  };
}

/** Linha do log que o Mark manda pelo `/ws`: `{type:"log", speaker, text, ts}` ou `{type:"sys", text}`. */
export function parseLogLine(raw: unknown): { kind: "log" | "sys"; speaker: string; text: string; ts: string } | undefined {
  if (!isRecord(raw) || typeof raw.text !== "string") return undefined;
  const text = raw.text.slice(0, MARK_LIMITS.logChars);
  if (raw.type === "sys") return { kind: "sys", speaker: "sys", text, ts: typeof raw.ts === "string" ? raw.ts : "" };
  if (raw.type !== "log" || typeof raw.speaker !== "string") return undefined;
  return { kind: "log", speaker: raw.speaker.slice(0, 32), text, ts: typeof raw.ts === "string" ? raw.ts : "" };
}

/** O que o navegador recebe quando o Mark não responde: causa estável e o texto do catálogo. */
function offline(cause: OfflineCause): Dict {
  const { title, cause: why, action, ref } = explain(cause);
  return { online: false, available: cause !== MARK_ERRORS.bridgeMissing, cause, explain: { code: cause, title, cause: why, action, ref } };
}

/** O Mark usa certificado autoassinado com `https`: a verificação cai só aqui, onde o host é sempre 127.0.0.1. */
export const tlsFor = (bridge: Bridge): { rejectUnauthorized: boolean } | undefined => (bridge.scheme === "https" ? { rejectUnauthorized: false } : undefined);

/** Uma linha JSON por fato que muda o Mark (pedido, voz). Sem arquivo, nada é gravado; a falha de gravação nunca derruba o pedido. */
export function createAudit(file: string | undefined, now: () => number): (action: string, caller: { remote: boolean }, detail: Dict) => void {
  return (action, caller, detail) => {
    if (file === undefined) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ at: new Date(now()).toISOString(), action, remote: caller.remote, ...detail })}\n`);
    } catch (error) {
      // a auditoria não derruba o pedido; o código do erro basta para achar a causa (sem caminho nem texto do pedido)
      console.error(`mark: auditoria não gravada (${(error as NodeJS.ErrnoException).code ?? "erro"})`);
    }
  };
}

type UpstreamFailure = { ok: false; cause: OfflineCause };
type Upstream<T> = { ok: true; value: T } | UpstreamFailure;

class MarkRateLimit {
  private readonly stamps: number[] = [];
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  /** Segundos até a próxima vaga, ou 0 se cabe agora (e registra o pedido). */
  take(): number {
    const t = this.now();
    while (this.stamps.length > 0 && t - (this.stamps[0] as number) >= MARK_LIMITS.rateWindowMs) this.stamps.shift();
    if (this.stamps.length >= MARK_LIMITS.rateCount) return Math.max(1, Math.ceil((MARK_LIMITS.rateWindowMs - (t - (this.stamps[0] as number))) / 1000));
    this.stamps.push(t);
    return 0;
  }
}

export function createMark(deps: MarkDeps): Mark {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = (): number => deps.timeoutMs?.() ?? DEFAULT_TIMEOUT_MS;
  const keepAliveMs = deps.keepAliveMs ?? KEEP_ALIVE_MS;
  const maxStreams = deps.maxStreams ?? MARK_LIMITS.streams;
  const limiter = new MarkRateLimit(now);
  const openSocket = deps.openSocket ?? ((url, init) => new WebSocket(url, init as unknown as string[]));
  const files = deps.report ?? {
    real: (path: string) => realpathSync(path),
    size: (path: string) => statSync(path).size,
    read: (path: string, bytes: number) => readFileSync(path).subarray(0, bytes).toString("utf8"),
  };
  const streams = new Set<{ end(cause?: OfflineCause): void }>();
  const encoder = new TextEncoder();

  const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  async function call(bridge: Bridge, path: string, init: { method: "GET" | "POST"; body?: string }): Promise<Upstream<unknown>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${bridge.token}` };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    try {
      const res = await doFetch(markUrl(bridge, path), {
        method: init.method, headers, body: init.body, signal: AbortSignal.timeout(timeoutMs()), redirect: "error", tls: tlsFor(bridge),
      } as RequestInit);
      if (res.status === 401 || res.status === 403) return { ok: false, cause: MARK_ERRORS.rejected };
      if (!res.ok) return { ok: false, cause: MARK_ERRORS.badResponse };
      const text = await res.text();
      if (text.length > MARK_LIMITS.upstreamBytes) return { ok: false, cause: MARK_ERRORS.badResponse };
      if (text.trim() === "") return { ok: true, value: null };
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, cause: MARK_ERRORS.badResponse };
      }
    } catch {
      // recusada, caiu no meio ou estourou o tempo: para quem consome é tudo "o Mark não responde"
      return { ok: false, cause: MARK_ERRORS.unreachable };
    }
  }

  async function fetchState(): Promise<Upstream<{ bridge: Bridge; state: MarkStateBody }>> {
    const read = readBridge(deps.bridgePath());
    if (!read.ok) return read;
    const got = await call(read.bridge, "/api/state", { method: "GET" });
    if (!got.ok) return got;
    const state = parseState(got.value);
    return state === undefined ? { ok: false, cause: MARK_ERRORS.badResponse } : { ok: true, value: { bridge: read.bridge, state } };
  }

  /** Falha de quem pede algo ao Mark: 503 quando ele está fora, 502 quando respondeu errado. O corpo leva o código estável. */
  function unavailable(cause: OfflineCause): Response {
    const status = cause === MARK_ERRORS.badResponse || cause === MARK_ERRORS.rejected ? 502 : 503;
    return send(status, { error: "o Mark não respondeu", code: cause });
  }

  const audit = createAudit(deps.auditFile, now);

  function rateRefused(): Response | undefined {
    const wait = limiter.take();
    if (wait === 0) return undefined;
    const res = send(429, { error: "pedidos demais ao Mark", code: MARK_ERRORS.rateLimited });
    res.headers.set("Retry-After", String(wait));
    return res;
  }

  async function command(body: Dict, caller: { remote: boolean }): Promise<Response> {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text === "") return send(400, { error: "o pedido está vazio", code: MARK_ERRORS.textEmpty });
    if (text.length > MARK_LIMITS.commandChars) return send(400, { error: `o pedido passa de ${MARK_LIMITS.commandChars} caracteres`, code: MARK_ERRORS.textTooLong });
    const limited = rateRefused();
    if (limited) return limited;
    const read = readBridge(deps.bridgePath());
    if (!read.ok) return unavailable(read.cause);
    const sent = await call(read.bridge, "/api/command", { method: "POST", body: JSON.stringify({ text }) });
    // só o tamanho entra na auditoria: o texto é fala do dono e não vai para log
    audit("command", caller, { chars: text.length, ok: sent.ok });
    return sent.ok ? send(200, { ok: true }) : unavailable(sent.cause);
  }

  async function wake(caller: { remote: boolean }): Promise<Response> {
    const limited = rateRefused();
    if (limited) return limited;
    const read = readBridge(deps.bridgePath());
    if (!read.ok) return unavailable(read.cause);
    const sent = await call(read.bridge, "/api/wake", { method: "POST", body: "{}" });
    audit("wake", caller, { ok: sent.ok });
    return sent.ok ? send(200, { ok: true }) : unavailable(sent.cause);
  }

  /**
   * O relatório que o Mark anunciou no estado, lido do disco local. O caminho vem do Mark (nunca da requisição) e só vale se
   * for um `.md` regular dentro de uma pasta `reports`, depois de resolver links; o resto responde como "sem relatório".
   */
  async function report(): Promise<Response> {
    const got = await fetchState();
    if (!got.ok) return unavailable(got.cause);
    const last = got.value.state.last_report;
    if (last === null) return send(404, { error: "o Mark ainda não tem relatório", code: MARK_ERRORS.noReport });
    try {
      const real = files.real(last.path);
      if (!real.endsWith(REPORT_EXT) || basename(dirname(real)) !== REPORT_DIR) return send(404, { error: "relatório fora da pasta do Mark", code: MARK_ERRORS.noReport });
      const size = files.size(real);
      const text = files.read(real, MARK_LIMITS.reportBytes);
      return send(200, { title: last.title, ts: last.ts, text, clipped: size > MARK_LIMITS.reportBytes });
    } catch (error) {
      console.error(`mark: relatório não lido (${(error as NodeJS.ErrnoException).code ?? "erro"})`);
      return send(404, { error: "não consegui ler o relatório", code: MARK_ERRORS.reportUnreadable });
    }
  }

  function events(req: Request): Response {
    if (streams.size >= maxStreams) {
      const busy = send(429, { error: "streams do Mark demais abertos", code: MARK_ERRORS.streamsBusy });
      busy.headers.set("Retry-After", String(RETRY_AFTER_S));
      return busy;
    }
    let owner: { end(cause?: OfflineCause): void } | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let socket: WebSocket | undefined;
        let beat: ReturnType<typeof setInterval> | undefined;
        let connectTimer: ReturnType<typeof setTimeout> | undefined;
        let done = false;
        const write = (text: string): void => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // o navegador já fechou o stream: o fim abaixo solta o ws e os timers
            end();
          }
        };
        // um fim só para os dois lados: SSE e ws fecham juntos, e o timer e o ouvinte de abort saem com eles
        const end = (cause?: OfflineCause): void => {
          if (done) return;
          done = true;
          if (connectTimer !== undefined) clearTimeout(connectTimer);
          if (beat !== undefined) clearInterval(beat);
          req.signal.removeEventListener("abort", onAbort);
          if (owner) streams.delete(owner);
          if (socket !== undefined) {
            socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
            try {
              socket.close();
            } catch {
              // já fechado do outro lado
            }
          }
          if (cause !== undefined) {
            try {
              controller.enqueue(encoder.encode(frame("offline", offline(cause))));
            } catch {
              // o navegador já foi embora
            }
          }
          try {
            controller.close();
          } catch {
            // já fechado pelo cancelamento do cliente
          }
        };
        const onAbort = (): void => end();
        owner = { end };
        write(`retry: ${RECONNECT_MS}\n\n`);
        const read = readBridge(deps.bridgePath());
        if (!read.ok) return end(read.cause);
        streams.add(owner);
        req.signal.addEventListener("abort", onAbort, { once: true });
        beat = setInterval(() => write(": keep-alive\n\n"), keepAliveMs);
        connectTimer = setTimeout(() => end(MARK_ERRORS.unreachable), timeoutMs());
        try {
          socket = openSocket(markWsUrl(read.bridge), { headers: { Authorization: `Bearer ${read.bridge.token}` }, tls: tlsFor(read.bridge) });
        } catch {
          return end(MARK_ERRORS.unreachable);
        }
        socket.onopen = () => {
          if (connectTimer !== undefined) clearTimeout(connectTimer);
          connectTimer = undefined;
        };
        socket.onmessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;
          let raw: unknown;
          try {
            raw = JSON.parse(event.data);
          } catch {
            return;
          }
          if (isRecord(raw) && raw.type === "state") {
            const state = parseState(raw);
            if (state !== undefined) write(frame("state", publicState(state)));
            return;
          }
          const line = parseLogLine(raw);
          if (line !== undefined) write(frame("log", line));
        };
        socket.onerror = () => end(MARK_ERRORS.unreachable);
        socket.onclose = (event: CloseEvent) => end(event.code === WS_UNAUTHORIZED ? MARK_ERRORS.rejected : MARK_ERRORS.unreachable);
      },
      cancel() {
        owner?.end();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Frame-Options": "DENY" },
    });
  }

  return {
    async get(path, req) {
      if (path === ROUTES.state) {
        const got = await fetchState();
        return send(200, got.ok ? { online: true, available: true, ...publicState(got.value.state) } : offline(got.cause));
      }
      if (path === ROUTES.events) return events(req);
      if (path === ROUTES.report) return report();
      return undefined;
    },
    async post(path, body, caller) {
      if (path === ROUTES.command) return command(body, caller);
      if (path === ROUTES.wake) return wake(caller);
      return undefined;
    },
    async reachable() {
      const got = await fetchState();
      return got.ok ? undefined : got.cause;
    },
    close() {
      for (const stream of [...streams]) stream.end();
    },
    size: () => streams.size,
  };
}
