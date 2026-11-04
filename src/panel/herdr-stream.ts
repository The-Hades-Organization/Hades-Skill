// GET /api/herdr/stream: o terminal ao vivo dos panes do herdr por SSE (reference/argos.md §Fluxo do terminal (servidor)).
// Uma assinatura `events.subscribe` por sessão do herdr, compartilhada por todos os clientes; por pane, um leitor que
// coalesce os avisos e manda o quadro visível pronto (`pane.read source=visible format=ansi`) no máximo a cada
// FRAME_INTERVAL_MS. O herdr 0.8.2 não deixa assinar mudança de saída (`pane_output_changed` não é assinável), então o
// leitor também relê sozinho, com recuo até IDLE_POLL_MAX_MS enquanto nada muda; aviso do herdr ou entrada direta
// voltam o ritmo ao máximo. A autenticação é a das outras rotas GET (server.ts), antes daqui.
import { type HerdrSocket, HerdrSocketError, type HerdrSubscription } from "./herdr.ts";
import { PANE_ID, SESSION_NAME } from "./herdr-page.ts";
import { send } from "./http.ts";
import { log } from "./log.ts";

type Dict = Record<string, unknown>;

export const STREAM_PANES_MAX = 12;
export const STREAMS_MAX = 20;
/** ~10 quadros/s por pane, no máximo. */
export const FRAME_INTERVAL_MS = 100;
export const IDLE_POLL_MAX_MS = 1000;
/**
 * Janela do eco: o `pane.send_input` volta antes de o herdr processar o que digitou, então a leitura imediata do `nudge` vê o
 * quadro velho (medido: p90 ≈ 110 ms; o quadro igual dobrava o intervalo e o eco chegava 100–200 ms depois). Depois do
 * `nudge`, até duas releituras curtas (esperas em ms, a partir do fim da leitura anterior), só no pane que recebeu a entrada
 * e só até o quadro mudar; nessa janela o intervalo não dobra e o teto de FRAME_INTERVAL_MS cede ao primeiro passo.
 */
export const ECHO_RETRY_MS: readonly number[] = [15, 30];
const KEEP_ALIVE_MS = 15_000;
const RECONNECT_MS = 3000;
const RETRY_AFTER_S = 5;
const READ_TIMEOUT_MS = 5000;
const LIST_TIMEOUT_MS = 5000;
/** Fila de um cliente lento: acima disso o quadro intermediário é descartado (o próximo já é a tela inteira). */
const CLIENT_BACKLOG_BYTES = 2 * 1024 * 1024;
const DEFAULT_SESSION = "default";
const PANE_NOT_FOUND = "pane_not_found";

export const STREAM_ERRORS = {
  sessionInvalid: "session_invalid",
  sessionUnknown: "session_unknown",
  sessionDown: "session_down",
  panesInvalid: "panes_invalid",
  panesTooMany: "panes_too_many",
  paneUnknown: "pane_unknown",
  streamsBusy: "streams_busy",
  readFailed: "read_failed",
  subscriptionFailed: "subscription_failed",
} as const;
export type StreamErrorCode = (typeof STREAM_ERRORS)[keyof typeof STREAM_ERRORS];

export interface Frame {
  pane: string;
  revision: number;
  cols: number;
  rows: number;
  ansi: string;
}
export type StreamEvent =
  | { event: "frame"; data: Frame }
  | { event: "status"; data: { pane: string; agentStatus: string } }
  | { event: "exited"; data: { pane: string } }
  | { event: "error"; data: { pane?: string; message: string; code: StreamErrorCode } };

/** Relógio e temporizador injetáveis; `setTimer` devolve quem cancela. */
export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
}
const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export interface StreamDeps {
  socket: HerdrSocket;
  /** Socket da API da sessão pela listagem atual do herdr; undefined se a sessão não existe ou está parada. */
  socketOf(session: string): Promise<string | undefined>;
  clock?: Clock;
}
export interface StreamStats {
  streams: number;
  hubs: number;
  subscribes: number;
  reads: number;
  frames: number;
}
export interface HerdrStream {
  open(req: Request, query: Record<string, string>): Promise<Response>;
  /** A entrada direta mudou o pane: relê já (respeitando o teto), sem esperar o recuo. */
  nudge(session: string, pane: string): void;
  stats(): StreamStats;
  stop(): void;
}

export class StreamRequestError extends Error {
  readonly code: StreamErrorCode;
  constructor(code: StreamErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** `session` e `panes` da query, validados no formato (a existência é conferida contra a listagem depois). */
export function parseStreamQuery(query: Record<string, string>): { session: string; panes: string[] } {
  const session = query.session ?? DEFAULT_SESSION;
  if (!SESSION_NAME.test(session)) throw new StreamRequestError(STREAM_ERRORS.sessionInvalid, "sessão do herdr inválida");
  const raw = query.panes ?? "";
  // o teto vem antes do split: uma query enorme não vira uma lista enorme
  if (raw.length > STREAM_PANES_MAX * 64) throw new StreamRequestError(STREAM_ERRORS.panesTooMany, `panes demais (até ${STREAM_PANES_MAX})`);
  const panes = [...new Set(raw.split(",").map((p) => p.trim()).filter((p) => p !== ""))];
  if (panes.length === 0) throw new StreamRequestError(STREAM_ERRORS.panesInvalid, "panes é obrigatório");
  if (panes.length > STREAM_PANES_MAX) throw new StreamRequestError(STREAM_ERRORS.panesTooMany, `panes demais (até ${STREAM_PANES_MAX})`);
  if (panes.some((p) => !PANE_ID.test(p))) throw new StreamRequestError(STREAM_ERRORS.panesInvalid, "pane inválido");
  return { session, panes };
}

/** Próximo intervalo de releitura: volta ao teto quando o quadro mudou, dobra até IDLE_POLL_MAX_MS quando não. */
export function nextPollMs(previousMs: number, changed: boolean): number {
  return changed ? FRAME_INTERVAL_MS : Math.min(Math.max(previousMs, FRAME_INTERVAL_MS) * 2, IDLE_POLL_MAX_MS);
}

/**
 * O que a assinatura única pede. `pane.agent_status_changed` exige `pane_id` no 0.8.2 (o `pane.updated` global não traz
 * a mudança de estado do agente), por isso a lista cresce com os panes vigiados.
 */
export function subscriptionsFor(panes: Iterable<string>): Dict[] {
  return [
    { type: "pane.exited" }, { type: "pane.closed" }, { type: "pane.updated" }, { type: "layout.updated" },
    ...[...panes].sort().map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
  ];
}

const rowsOf = (value: unknown): Dict[] => (Array.isArray(value) ? (value as Dict[]) : []);
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Watcher {
  deliver(event: StreamEvent): void;
  end(): void;
}
interface PaneSeed {
  id: string;
  status?: string;
  rows?: number;
}
interface PaneWatch {
  readonly id: string;
  readonly watchers: Set<Watcher>;
  frame?: Frame;
  status?: string;
  cols?: number;
  rows?: number;
  pollMs: number;
  /** Próxima espera curta de ECHO_RETRY_MS; `ECHO_RETRY_MS.length` = janela fechada. */
  echoStep: number;
  lastReadAt: number;
  cancelTimer?: () => void;
  reading: boolean;
  /** Um aviso chegou durante a leitura: relê assim que o teto deixar. */
  again: boolean;
  failing: boolean;
  gone: boolean;
}
interface HubContext {
  socket: HerdrSocket;
  clock: Clock;
  stats: StreamStats;
  nextRevision(): number;
}
interface SessionHub {
  attach(watcher: Watcher, seeds: PaneSeed[]): void;
  detach(watcher: Watcher): void;
  nudge(pane: string): void;
  close(): void;
}

function createSessionHub(ctx: HubContext, session: string, socketPath: string, onClosed: () => void): SessionHub {
  const { socket, clock, stats } = ctx;
  const panes = new Map<string, PaneWatch>();
  let subscription: HerdrSubscription | undefined;
  let subscribed = new Set<string>();
  let syncing = false;
  let closed = false;

  const broadcast = (w: PaneWatch, event: StreamEvent): void => {
    for (const watcher of w.watchers) watcher.deliver(event);
  };
  // na janela do eco o teto de quadros cede: a tecla acabou de sair e o dono espera ver o caractere
  const readGapMs = (w: PaneWatch): number => (w.echoStep < ECHO_RETRY_MS.length ? ECHO_RETRY_MS[0] : FRAME_INTERVAL_MS);
  const earliestRead = (w: PaneWatch): number => Math.max(0, w.lastReadAt + readGapMs(w) - clock.now());
  const alive = (w: PaneWatch): boolean => !closed && !w.gone && panes.get(w.id) === w;

  function schedule(w: PaneWatch, delayMs: number): void {
    w.cancelTimer?.();
    w.cancelTimer = clock.setTimer(() => {
      w.cancelTimer = undefined;
      readPane(w).catch((error: unknown) => log("error", "herdr-stream: leitor do pane falhou", { session, pane: w.id, reason: reasonOf(error) }));
    }, delayMs);
  }

  function wake(w: PaneWatch): void {
    if (!alive(w)) return;
    w.pollMs = FRAME_INTERVAL_MS;
    if (w.reading) {
      w.again = true;
      return;
    }
    schedule(w, earliestRead(w));
  }

  function markGone(w: PaneWatch): void {
    if (w.gone) return;
    w.gone = true;
    w.cancelTimer?.();
    w.cancelTimer = undefined;
    broadcast(w, { event: "exited", data: { pane: w.id } });
  }

  function applyLayout(layout: unknown): boolean {
    let touched = false;
    for (const p of rowsOf((layout as Dict | undefined)?.panes)) {
      const w = panes.get(String(p.pane_id));
      const rect = p.rect as Dict | undefined;
      if (!w || typeof rect?.width !== "number") continue;
      // a altura acompanha o layout como a largura: guardada só na primeira leitura, o pane que crescia ficava com o
      // número de linhas antigo e o nó cortava as de baixo (onde fica o campo de digitação do agente)
      const height = typeof rect.height === "number" ? rect.height : w.rows;
      if (rect.width !== w.cols || height !== w.rows) {
        w.cols = rect.width;
        w.rows = height;
        touched = true;
        wake(w);
      }
    }
    return touched;
  }

  function publish(w: PaneWatch, ansi: string, cols: number, rows: number): void {
    const same = w.frame !== undefined && w.frame.ansi === ansi && w.frame.cols === cols && w.frame.rows === rows;
    const echoing = same && w.echoStep < ECHO_RETRY_MS.length;
    w.pollMs = echoing ? FRAME_INTERVAL_MS : nextPollMs(w.pollMs, !same);
    if (same) return;
    w.echoStep = ECHO_RETRY_MS.length;
    w.frame = { pane: w.id, revision: ctx.nextRevision(), cols, rows, ansi };
    stats.frames += 1;
    broadcast(w, { event: "frame", data: w.frame });
  }

  async function readPane(w: PaneWatch): Promise<void> {
    if (!alive(w)) return;
    w.reading = true;
    w.again = false;
    w.lastReadAt = clock.now();
    try {
      // as colunas vêm do layout do herdr (o 0.8.2 não informa as do PTY); depois, o `layout.updated` as mantém
      if (w.cols === undefined) applyLayout((await socket.request(socketPath, "pane.layout", { pane_id: w.id }, READ_TIMEOUT_MS)).layout);
      stats.reads += 1;
      const result = await socket.request(socketPath, "pane.read", { pane_id: w.id, source: "visible", format: "ansi", strip_ansi: false }, READ_TIMEOUT_MS);
      const text = (result.read as Dict | undefined)?.text;
      if (typeof text !== "string") throw new Error("pane.read sem texto");
      if (w.cols === undefined || w.rows === undefined) throw new Error("pane fora do layout do herdr");
      publish(w, text, w.cols, w.rows);
      w.failing = false;
    } catch (error) {
      if (error instanceof HerdrSocketError && error.code === PANE_NOT_FOUND) {
        markGone(w);
      } else {
        // um aviso por sequência de falhas; o detalhe fica só no log
        if (!w.failing) {
          log("warn", "herdr-stream: leitura do pane falhou", { session, pane: w.id, reason: reasonOf(error) });
          broadcast(w, { event: "error", data: { pane: w.id, message: "leitura do pane falhou; tentando de novo", code: STREAM_ERRORS.readFailed } });
        }
        w.failing = true;
        w.pollMs = IDLE_POLL_MAX_MS;
        w.echoStep = ECHO_RETRY_MS.length;
      }
    } finally {
      w.reading = false;
      if (alive(w)) schedule(w, w.again ? earliestRead(w) : w.echoStep < ECHO_RETRY_MS.length ? ECHO_RETRY_MS[w.echoStep++] : w.pollMs);
    }
  }

  function onEvent(name: string, data: Dict): void {
    // a assinatura entrega também o histórico recente (medido): tudo aqui é idempotente
    switch (name) {
      case "pane.agent_status_changed": {
        const w = panes.get(String(data.pane_id));
        if (!w || typeof data.agent_status !== "string" || data.agent_status === w.status) return;
        w.status = data.agent_status;
        broadcast(w, { event: "status", data: { pane: w.id, agentStatus: w.status } });
        wake(w);
        return;
      }
      case "pane_exited":
      case "pane_closed": {
        const w = panes.get(String(data.pane_id));
        if (w) markGone(w);
        return;
      }
      case "pane_updated": {
        const info = data.pane as Dict | undefined;
        const w = panes.get(String(info?.pane_id));
        const rows = (info?.scroll as Dict | undefined)?.viewport_rows;
        if (w && typeof rows === "number" && rows !== w.rows) {
          w.rows = rows;
          wake(w);
        }
        return;
      }
      case "layout_updated":
        applyLayout(data.layout);
        return;
      default:
        // evento que a assinatura não pediu: o herdr pode acrescentar tipos, e eles não mudam o quadro
        return;
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    subscription?.close();
    subscription = undefined;
    const watchers = new Set<Watcher>();
    for (const w of panes.values()) {
      w.cancelTimer?.();
      for (const watcher of w.watchers) watchers.add(watcher);
    }
    panes.clear();
    onClosed();
    for (const watcher of watchers) watcher.end();
  }

  /** A assinatura caiu ou não abriu: avisa todos os clientes e fecha (o EventSource religa e tenta de novo). */
  function lost(code: StreamErrorCode, reason: string): void {
    if (closed) return;
    log("warn", "herdr-stream: assinatura do herdr perdida", { session, code, reason });
    const message = code === STREAM_ERRORS.sessionDown ? "o herdr encerrou a assinatura desta sessão" : "não deu para assinar os eventos do herdr";
    const told = new Set<Watcher>();
    for (const w of panes.values()) {
      for (const watcher of w.watchers) {
        if (told.has(watcher)) continue;
        told.add(watcher);
        watcher.deliver({ event: "error", data: { message, code } });
      }
    }
    close();
  }

  const covered = (): boolean => subscription !== undefined && [...panes.keys()].every((p) => subscribed.has(p));

  /** Garante uma assinatura que cobre os panes vigiados: abre a nova antes de fechar a velha (sem buraco de eventos). */
  async function syncSubscription(): Promise<void> {
    if (syncing) return;
    syncing = true;
    try {
      while (!closed && panes.size > 0 && !covered()) {
        const want = new Set(panes.keys());
        stats.subscribes += 1;
        // `closed` só chega quando a queda não foi nossa: a assinatura trocada ou solta aqui sai por `close()`
        const next = await socket.subscribe(socketPath, subscriptionsFor(want), {
          event: (name, data) => {
            if (!closed) onEvent(name, data);
          },
          closed: (reason) => lost(STREAM_ERRORS.sessionDown, reason),
        });
        if (closed || panes.size === 0) {
          next.close();
          break;
        }
        subscription?.close();
        subscription = next;
        subscribed = want;
      }
    } catch (error) {
      lost(STREAM_ERRORS.subscriptionFailed, reasonOf(error));
    } finally {
      syncing = false;
    }
    if (!closed && panes.size === 0) close();
  }

  function attach(watcher: Watcher, seeds: PaneSeed[]): void {
    if (closed) {
      watcher.end();
      return;
    }
    for (const seed of seeds) {
      let w = panes.get(seed.id);
      if (!w) {
        w = { id: seed.id, watchers: new Set(), status: seed.status, rows: seed.rows, pollMs: FRAME_INTERVAL_MS, echoStep: ECHO_RETRY_MS.length, lastReadAt: 0, reading: false, again: false, failing: false, gone: false };
        panes.set(seed.id, w);
        schedule(w, 0);
      }
      w.watchers.add(watcher);
      // reconexão: o cliente recebe já o quadro e o estado atuais, sem esperar mudança
      if (w.frame) watcher.deliver({ event: "frame", data: w.frame });
      if (w.status) watcher.deliver({ event: "status", data: { pane: w.id, agentStatus: w.status } });
      if (w.gone) watcher.deliver({ event: "exited", data: { pane: w.id } });
    }
    syncSubscription().catch((error: unknown) => lost(STREAM_ERRORS.subscriptionFailed, reasonOf(error)));
  }

  function detach(watcher: Watcher): void {
    if (closed) return;
    for (const [id, w] of panes) {
      w.watchers.delete(watcher);
      if (w.watchers.size > 0) continue;
      w.cancelTimer?.();
      panes.delete(id);
    }
    // o último cliente saiu: fecha a assinatura (uma sincronização em voo fecha a sua ao terminar)
    if (panes.size === 0 && !syncing) close();
  }

  function nudge(pane: string): void {
    const w = panes.get(pane);
    if (!w) return;
    w.echoStep = 0;
    wake(w);
  }

  return { attach, detach, nudge, close };
}

export function createHerdrStream(deps: StreamDeps): HerdrStream {
  const clock = deps.clock ?? realClock;
  const hubs = new Map<string, SessionHub>();
  const stats: StreamStats = { streams: 0, hubs: 0, subscribes: 0, reads: 0, frames: 0 };
  let lastRevision = 0;
  // revisão estritamente crescente e ancorada no relógio: não volta atrás quando o pane é solto e vigiado de novo,
  // nem num restart do painel
  const nextRevision = (): number => {
    lastRevision = Math.max(lastRevision + 1, Math.floor(clock.now()));
    return lastRevision;
  };
  const ctx: HubContext = { socket: deps.socket, clock, stats, nextRevision };

  function hubOf(session: string, socketPath: string): SessionHub {
    const found = hubs.get(session);
    if (found) return found;
    let hub: SessionHub | undefined;
    hub = createSessionHub(ctx, session, socketPath, () => {
      if (hubs.get(session) === hub) hubs.delete(session);
      stats.hubs = hubs.size;
    });
    hubs.set(session, hub);
    stats.hubs = hubs.size;
    return hub;
  }

  const refuse = (status: number, code: StreamErrorCode, message: string): Response => send(status, { error: message, code });

  function sse(req: Request, session: string, socketPath: string, seeds: PaneSeed[], unknown: string[]): Response {
    stats.streams += 1;
    const encoder = new TextEncoder();
    // quadros guardados enquanto o cliente está atrasado: sai o mais novo de cada pane quando a fila esvaziar
    const stale = new Map<string, Frame>();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let hub: SessionHub | undefined;
    let open = true;
    let cancelBeat: (() => void) | undefined;

    const write = (text: string): void => {
      if (open) controller?.enqueue(encoder.encode(text));
    };
    const writeEvent = (event: StreamEvent): void => write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
    const beat = (): void => {
      cancelBeat = clock.setTimer(() => {
        write(": keep-alive\n\n");
        beat();
      }, KEEP_ALIVE_MS);
    };
    const finish = (): void => {
      if (!open) return;
      open = false;
      cancelBeat?.();
      req.signal.removeEventListener("abort", finish);
      stats.streams -= 1;
      hub?.detach(watcher);
      try {
        controller?.close();
      } catch {
        // já fechado pelo cancelamento do cliente
      }
    };
    const watcher: Watcher = {
      deliver(event) {
        if (!open) return;
        if (event.event === "frame") {
          if ((controller?.desiredSize ?? 1) <= 0) {
            stale.set(event.data.pane, event.data);
            return;
          }
          stale.delete(event.data.pane);
        }
        writeEvent(event);
      },
      end: finish,
    };

    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
          write(`retry: ${RECONNECT_MS}\n\n`);
          for (const pane of unknown) writeEvent({ event: "error", data: { pane, message: "pane fora da listagem atual do herdr", code: STREAM_ERRORS.paneUnknown } });
          hub = hubOf(session, socketPath);
          hub.attach(watcher, seeds);
          beat();
        },
        pull() {
          for (const frame of stale.values()) writeEvent({ event: "frame", data: frame });
          stale.clear();
        },
        cancel: finish,
      },
      { highWaterMark: CLIENT_BACKLOG_BYTES, size: (chunk) => chunk?.byteLength ?? 0 },
    );
    req.signal.addEventListener("abort", finish);
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Frame-Options": "DENY" },
    });
  }

  async function open(req: Request, query: Record<string, string>): Promise<Response> {
    let wanted: { session: string; panes: string[] };
    try {
      wanted = parseStreamQuery(query);
    } catch (error) {
      if (error instanceof StreamRequestError) return refuse(400, error.code, error.message);
      throw error;
    }
    if (stats.streams >= STREAMS_MAX) {
      const busy = refuse(429, STREAM_ERRORS.streamsBusy, "fluxos do terminal demais abertos");
      busy.headers.set("Retry-After", String(RETRY_AFTER_S));
      return busy;
    }
    const socketPath = await deps.socketOf(wanted.session);
    if (!socketPath) return refuse(400, STREAM_ERRORS.sessionUnknown, "sessão do herdr desconhecida ou parada");
    let listing: Dict[];
    try {
      listing = rowsOf((await deps.socket.request(socketPath, "pane.list", {}, LIST_TIMEOUT_MS)).panes);
    } catch (error) {
      if (!(error instanceof HerdrSocketError)) throw error;
      log("warn", "herdr-stream: listagem de panes falhou", { session: wanted.session, reason: error.message });
      return refuse(503, STREAM_ERRORS.sessionDown, "servidor herdr desta sessão fora do ar");
    }
    // nunca confia no ID vindo da tela: só segue o que a listagem atual do herdr tem
    const byId = new Map(listing.map((p) => [String(p.pane_id), p]));
    const seeds: PaneSeed[] = [];
    const unknown: string[] = [];
    for (const id of wanted.panes) {
      const info = byId.get(id);
      if (!info) {
        unknown.push(id);
        continue;
      }
      const rows = (info.scroll as Dict | undefined)?.viewport_rows;
      seeds.push({ id, status: typeof info.agent_status === "string" ? info.agent_status : undefined, rows: typeof rows === "number" ? rows : undefined });
    }
    if (seeds.length === 0) return refuse(400, STREAM_ERRORS.paneUnknown, "nenhum pane pedido está na listagem atual do herdr");
    return sse(req, wanted.session, socketPath, seeds, unknown);
  }

  return {
    open,
    nudge: (session, pane) => hubs.get(session)?.nudge(pane),
    stats: () => ({ ...stats }),
    stop() {
      for (const hub of [...hubs.values()]) hub.close();
    },
  };
}
