// Rotas do diário de eventos por agente (src/lib/journal.ts, reference/journal.md): GET /api/journal (consulta, com teto de
// `limit` imposto aqui) e GET /api/journal/stream (SSE da faixa ao vivo). Só leitura; a autenticação é a das outras rotas GET.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { AGENT_NAME, SESSIONS_DIR, journalFiles, journalWorkRoot, parseEvent, parseSince, readEvents } from "../lib/journal.ts";
import { BadRequest, send } from "./http.ts";

type Dict = Record<string, unknown>;

export const LIMIT_DEFAULT = 100;
export const LIMIT_MAX = 500;
export const STREAMS_MAX = 20;
const POLL_MS = 1000;
const KEEP_ALIVE_MS = 15_000;
const CHUNK_BYTES = 256 * 1024;
const RETRY_AFTER_S = 5;
const KIND = /^[\w.]{1,30}$/;

export interface JournalRoutes {
  list(query: Record<string, string>, now?: Date): Dict;
  stream(req: Request, query: Record<string, string>): Response;
}

function agentOf(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const name = raw.startsWith(`${SESSIONS_DIR}/`) ? raw.slice(SESSIONS_DIR.length + 1) : raw;
  if (!AGENT_NAME.test(name)) throw new BadRequest(`agent inválido: ${raw}`);
  return raw;
}

function limitOf(raw: string | undefined): number {
  if (raw === undefined || raw === "") return LIMIT_DEFAULT;
  if (!/^\d+$/.test(raw)) throw new BadRequest(`limit inválido: ${raw}`);
  const n = Number(raw);
  if (n < 1 || n > LIMIT_MAX) throw new BadRequest(`limit é de 1 a ${LIMIT_MAX}: ${raw}`);
  return n;
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Linhas completas gravadas a partir de `offset`; devolve o novo offset (só avança por linha inteira). */
function readFrom(file: string, offset: number): { lines: string[]; offset: number } {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { lines: [], offset };
  }
  try {
    const size = fstatSync(fd).size;
    // o arquivo girou (rotação do teto ou limpeza): recomeça do início do novo
    const start = offset > size ? 0 : offset;
    const buf = Buffer.alloc(Math.min(size - start, CHUNK_BYTES));
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return { lines: [], offset: start };
    return { lines: text.slice(0, end).split("\n").filter((l) => l !== ""), offset: start + Buffer.byteLength(text.slice(0, end + 1)) };
  } finally {
    closeSync(fd);
  }
}

export function createJournalRoutes(root: () => string = journalWorkRoot): JournalRoutes {
  let streams = 0;

  const fileOf = (agent: string): string | undefined =>
    journalFiles(root(), agent.startsWith(`${SESSIONS_DIR}/`)).find((f) => f.agent === agent && !f.file.endsWith(".1.jsonl"))?.file;

  function list(query: Record<string, string>, now: Date = new Date()): Dict {
    const agent = agentOf(query.agent);
    const limit = limitOf(query.limit);
    let sinceMs: number | undefined;
    if (query.since) {
      sinceMs = parseSince(query.since, now);
      if (sinceMs === undefined) throw new BadRequest(`since inválido: ${query.since} (30m, 2h, 1d ou instante ISO com Z)`);
    }
    if (query.kind !== undefined && query.kind !== "" && !KIND.test(query.kind)) throw new BadRequest(`kind inválido: ${query.kind}`);
    const events = readEvents({ agent, sinceMs, kind: query.kind || undefined, limit }, root());
    return { events, limit, count: events.length };
  }

  function stream(req: Request, query: Record<string, string>): Response {
    let agent: string | undefined;
    try {
      agent = agentOf(query.agent);
    } catch (error) {
      return send(400, { error: error instanceof Error ? error.message : String(error) });
    }
    if (agent === undefined) return send(400, { error: "agent é obrigatório" });
    if (streams >= STREAMS_MAX) {
      const busy = send(429, { error: "streams do diário demais abertos" });
      busy.headers.set("Retry-After", String(RETRY_AFTER_S));
      return busy;
    }
    streams += 1;
    const encoder = new TextEncoder();
    const raw = req.headers.get("last-event-id");
    const resume = raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
    let open = true;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (text: string): void => controller.enqueue(encoder.encode(text));
        // sem Last-Event-ID a faixa mostra o que vier daqui em diante (o histórico é do /api/journal)
        let offset = resume;
        let beat = Date.now();
        write(`retry: ${POLL_MS * 3}\n\n`);
        try {
          while (open && !req.signal.aborted) {
            const file = fileOf(agent as string);
            if (file) {
              if (offset === undefined) offset = sizeOf(file);
              const read = readFrom(file, offset);
              offset = read.offset;
              for (const line of read.lines) {
                if (parseEvent(line)) write(`id: ${offset}\ndata: ${line}\n\n`);
              }
              if (read.lines.length > 0) beat = Date.now();
            }
            if (Date.now() - beat > KEEP_ALIVE_MS) {
              write(": keep-alive\n\n");
              beat = Date.now();
            }
            await Bun.sleep(POLL_MS);
          }
        } catch (error) {
          // a conexão caiu: o EventSource religa sozinho com o último id
          if (open) console.warn(`stream do diário encerrado: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          open = false;
          streams -= 1;
          try {
            controller.close();
          } catch {
            // já fechado pelo cancelamento do cliente
          }
        }
      },
      cancel() {
        open = false;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Frame-Options": "DENY" },
    });
  }

  return { list, stream };
}
