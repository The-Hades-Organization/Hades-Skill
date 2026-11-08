// Rotas HTTP e WebSocket do terminal (protocolo em reference/panel.md §Terminal). A autenticação é a do painel: o servidor
// confere host, chave remota (cookie) e Origin no upgrade antes de abrir o socket; o corpo das mensagens nunca é logado.
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Auth } from "./auth.ts";
import { send } from "./http.ts";
import type { Term, TermAttachment, TermLink, TermOrigin } from "./term.ts";
import { TERM_CODES, TERM_LIMITS, TERM_PATHS, TERM_STATUS, TermError, type TermServerMessage } from "./term-protocol.ts";

const BACKPRESSURE_LIMIT = 4 * TERM_LIMITS.sendHighWater;
const SOCKET_IDLE_S = 120;
const ID_FORMAT = /^[0-9a-f]{32}$/;
const OFFSET_FORMAT = /^\d{1,15}$/;

export interface TermSocketData {
  id: string;
  offset: number | undefined;
  origin: TermOrigin;
  link?: TermLink;
}

export interface TermHttpDeps {
  term: Term;
  auth: Auth;
  port: number;
}

const originOf = (remote: boolean): TermOrigin => (remote ? "remote" : "local");

export const termErrorResponse = (error: TermError): Response => {
  const body = send(TERM_STATUS[error.code], { error: error.message, code: error.code });
  if (error.retryAfterS !== undefined) body.headers.set("Retry-After", String(error.retryAfterS));
  return body;
};

/** Origin aceito no upgrade: o próprio painel (local) ou o host do túnel (remoto). Sem Origin só passa no painel local. */
export const originAllowedFor = (auth: Auth, port: number) => (req: Request, remote: boolean): boolean => {
  const origin = req.headers.get("origin");
  if (origin === null) return !remote;
  const pub = auth.publicHost();
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(pub && remote ? [`https://${pub}`] : [])].includes(origin);
};

export function createTermHttp(deps: TermHttpDeps) {
  const { term, auth, port } = deps;
  const originAllowed = originAllowedFor(auth, port);

  const list = (): Response => send(200, term.list());

  /** POST /api/term/open e /api/term/close (chegam depois do token e do JSON). undefined = não é rota do terminal. */
  async function post(path: string, body: Record<string, unknown>, remote: boolean): Promise<Response | undefined> {
    if (path !== TERM_PATHS.open && path !== TERM_PATHS.close) return undefined;
    try {
      if (path === TERM_PATHS.open) return send(200, await term.open(body, originOf(remote)) as unknown as Record<string, unknown>);
      term.close(body.id, originOf(remote));
      return send(200, { ok: true });
    } catch (error) {
      if (error instanceof TermError) return termErrorResponse(error);
      throw error;
    }
  }

  /** GET /api/term/ws: confere tudo antes de trocar de protocolo. Devolve a resposta de recusa, ou undefined se o upgrade saiu. */
  function upgrade(req: Request, server: Server<TermSocketData>): Response | undefined {
    const url = new URL(req.url);
    const remote = auth.isRemote(req.headers, port);
    const origin = originOf(remote);
    if (!auth.hostOk(req.headers, port)) return send(403, { error: "host" });
    if (!auth.authed(req.headers, port)) return send(401, { error: "acesso remoto exige a chave" });
    try {
      if (!originAllowed(req, remote)) throw new TermError(TERM_CODES.origin, "origem do WebSocket não permitida");
      if (!term.enabled()) throw new TermError(TERM_CODES.disabled, "o terminal está desligado: ligue HADES_TERMINAL=1 em Configurações → Terminal, pelo painel local");
      const id = url.searchParams.get("id") ?? "";
      const rawOffset = url.searchParams.get("offset");
      if (rawOffset !== null && !OFFSET_FORMAT.test(rawOffset)) throw new TermError(TERM_CODES.badRequest, "offset inválido");
      if (!ID_FORMAT.test(id) || !term.has(id)) throw new TermError(TERM_CODES.unknownSession, "sessão de terminal inexistente");
      const data: TermSocketData = { id, offset: rawOffset === null ? undefined : Number.parseInt(rawOffset, 10), origin };
      if (server.upgrade(req, { data })) return undefined;
      throw new TermError(TERM_CODES.badRequest, "o pedido não é um upgrade de WebSocket");
    } catch (error) {
      if (error instanceof TermError) {
        term.noteRefusal(error, origin);
        return termErrorResponse(error);
      }
      throw error;
    }
  }

  const attachmentOf = (ws: ServerWebSocket<TermSocketData>): TermAttachment => ({
    send: (chunk) => { ws.sendBinary(chunk); },
    sendJson: (message: TermServerMessage) => { ws.sendText(JSON.stringify(message)); },
    buffered: () => ws.getBufferedAmount(),
    close: (code, reason) => ws.close(code, reason),
  });

  const websocket: WebSocketHandler<TermSocketData> = {
    maxPayloadLength: TERM_LIMITS.inputBytes,
    backpressureLimit: BACKPRESSURE_LIMIT,
    idleTimeout: SOCKET_IDLE_S,
    open(ws) {
      try {
        ws.data.link = term.attach(ws.data.id, ws.data.offset, attachmentOf(ws), ws.data.origin);
      } catch (error) {
        // a sessão sumiu entre o upgrade e o open (fechada ou expirada)
        ws.close(error instanceof TermError ? 1008 : 1011, error instanceof TermError ? error.code : "internal_error");
      }
    },
    message(ws, message) {
      if (typeof message === "string") ws.data.link?.control(message);
      else ws.data.link?.input(message);
    },
    drain(ws) { ws.data.link?.drain(); },
    close(ws) { ws.data.link?.detach(); },
  };

  return { list, post, upgrade, websocket, isSocketPath: (path: string): boolean => path === TERM_PATHS.socket };
}

export type TermHttp = ReturnType<typeof createTermHttp>;
