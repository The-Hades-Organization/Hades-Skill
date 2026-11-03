// Empurrão do canvas (reference/argos.md §Releitura do documento): um stream SSE aberto pela página do Argos que avisa
// `{ id, rev }` a cada gravação de documento (da tela, da CLI `hades canvas` ou de agente: todas passam pelo PUT do painel) e
// `registry` quando o registro de terminais do canvas muda. O aviso não leva o documento: a página relê pela rota de
// sempre, então o corpo continua sob o teto e a validação do GET. O polling da página fica como reserva.
import { send } from "./http.ts";

/** Teto de páginas ouvindo ao mesmo tempo; o excedente espera `RETRY_AFTER_S` e tenta de novo (o EventSource religa sozinho). */
export const CANVAS_STREAMS_MAX = 16;
const RETRY_AFTER_S = 5;
/** Comentário de keep-alive: mantém a conexão aberta atrás de proxy e de túnel. */
const KEEP_ALIVE_MS = 15_000;
/** Quanto o EventSource espera antes de religar depois de uma queda. */
const RECONNECT_MS = 3000;
const TOO_MANY = { error: "streams do canvas demais abertos", code: "canvas_streams_busy" };

export interface CanvasHubOptions {
  keepAliveMs?: number;
  maxStreams?: number;
}

export interface CanvasHub {
  /** Documento `id` gravado, agora na revisão `rev`. */
  publishCanvas(id: string, rev: number): void;
  /** O registro de terminais do canvas mudou (criar, fechar, trocar papel). */
  publishRegistry(): void;
  /** Resposta SSE para a requisição; fecha quando ela aborta. */
  open(req: Request): Response;
  /** Fecha todos os streams e o timer (desligamento). */
  close(): void;
  size(): number;
}

interface Client {
  write(text: string): void;
  end(): void;
}

export function createCanvasHub(options: CanvasHubOptions = {}): CanvasHub {
  const keepAliveMs = options.keepAliveMs ?? KEEP_ALIVE_MS;
  const maxStreams = options.maxStreams ?? CANVAS_STREAMS_MAX;
  const clients = new Set<Client>();
  const encoder = new TextEncoder();
  /** Um só timer para todos; nasce com o primeiro stream e morre com o último, então não sobra handle solto. */
  let beat: ReturnType<typeof setInterval> | undefined;

  const stopBeat = (): void => {
    if (beat === undefined) return;
    clearInterval(beat);
    beat = undefined;
  };
  const broadcast = (text: string): void => {
    for (const client of [...clients]) client.write(text);
  };
  const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  function open(req: Request): Response {
    if (clients.size >= maxStreams) {
      const busy = send(429, TOO_MANY);
      busy.headers.set("Retry-After", String(RETRY_AFTER_S));
      return busy;
    }
    let client: Client | undefined;
    const release = (): void => {
      if (client) clients.delete(client);
      client = undefined;
      if (clients.size === 0) stopBeat();
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const self: Client = {
          write: (text) => {
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              // o cliente já fechou do outro lado: sai do conjunto
              release();
            }
          },
          end: () => {
            release();
            try {
              controller.close();
            } catch {
              // já fechado pelo cancelamento do cliente
            }
          },
        };
        client = self;
        clients.add(self);
        self.write(`retry: ${RECONNECT_MS}\n\n`);
        beat ??= setInterval(() => broadcast(": keep-alive\n\n"), keepAliveMs);
        req.signal.addEventListener("abort", self.end, { once: true });
      },
      cancel: release,
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Frame-Options": "DENY" },
    });
  }

  return {
    publishCanvas: (id, rev) => broadcast(frame("canvas", { id, rev })),
    publishRegistry: () => broadcast(frame("registry", {})),
    open,
    close() {
      for (const client of [...clients]) client.end();
      stopBeat();
    },
    size: () => clients.size,
  };
}
