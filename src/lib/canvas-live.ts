// Ligação ao vivo da página do Argos com o servidor (reference/argos.md §Sincronia automática). Gerencia só o transporte: o
// stream SSE de avisos (`/api/canvas/stream`), a religação sozinha com recuo exponencial e a conferência de reserva da
// revisão. O que fazer com um aviso (reler, mesclar) é da página. Sem dependência de DOM nem de Node: tudo entra por `deps`.
//
// Por que não basta o EventSource: ele religa sozinho depois de uma queda de rede (e do `retry:` do servidor), mas desiste
// para sempre quando a resposta não é 200 (429 do teto de páginas, 401 de sessão vencida, painel reiniciando). Aí só restava
// a conferência de 4 s. Aqui o `readyState` fechado vira nova tentativa com recuo.

export const LIVE_BACKOFF = {
  /** Primeira espera depois de uma queda. */
  baseMs: 1000,
  /** Teto da espera; um painel fora do ar não recebe uma tentativa a cada segundo. */
  capMs: 30_000,
  /** Fração sorteada da espera, para abas abertas juntas não religarem no mesmo instante. */
  jitter: 0.25,
} as const;

/** Conferência da revisão com o stream fora do ar (reserva rápida) e com ele no ar (rede de segurança contra aviso perdido). */
export const LIVE_POLL = { downMs: 4000, openMs: 30_000 } as const;

/** `readyState` de EventSource que importa aqui: fechado de vez (o navegador não tenta mais). */
const STREAM_CLOSED = 2;

export type LiveState = "connecting" | "open" | "down";

export interface LiveStream {
  readyState: number;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  close(): void;
}

export interface LiveDeps {
  /** Abre o stream (na página, `PanelStream.open`, que solta a conexão com a aba escondida). */
  open(): LiveStream;
  hidden(): boolean;
  /** Assina a troca de visibilidade da aba; devolve o cancelamento. */
  onVisibility(fn: () => void): () => void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Sorteio em [0, 1); entra por injeção para o teste fixar o recuo. */
  random(): number;
  /** Aviso `canvas` do servidor: o documento `id` está na revisão `rev`. */
  onCanvas(notice: { id: string; rev: number }): void;
  /** Aviso `registry`: o registro de terminais mudou. */
  onRegistry(): void;
  /** Confere a revisão do servidor (a página compara com a que conhece). Falha vira aviso no console, nunca derruba a ligação. */
  check(): Promise<void>;
  /** Falhas que o transporte engole de propósito (recuo, conferência) vão para cá. */
  log(message: string): void;
}

export interface LiveLink {
  start(): void;
  /** Fecha o stream e cancela todo timer; depois disso nada mais é chamado. */
  stop(): void;
  state(): LiveState;
}

/** Espera antes da tentativa `attempt` (0 = a primeira depois da queda): dobra até o teto, com sorteio de `jitter`. */
export function backoffMs(attempt: number, random: number): number {
  const exp = Math.min(LIVE_BACKOFF.capMs, LIVE_BACKOFF.baseMs * 2 ** Math.max(0, attempt));
  const spread = exp * LIVE_BACKOFF.jitter;
  return Math.round(Math.min(LIVE_BACKOFF.capMs, exp - spread + 2 * spread * random));
}

function parseNotice(raw: unknown): { id: string; rev: number } | undefined {
  const text = typeof raw === "object" && raw !== null ? (raw as { data?: unknown }).data : undefined;
  if (typeof text !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { id, rev } = value as { id?: unknown; rev?: unknown };
  return typeof id === "string" && typeof rev === "number" && Number.isInteger(rev) ? { id, rev } : undefined;
}

export function createLiveLink(deps: LiveDeps): LiveLink {
  let stream: LiveStream | undefined;
  let state: LiveState = "connecting";
  let attempt = 0;
  let retryTimer: unknown;
  let pollTimer: unknown;
  let stopped = false;
  let unsubscribe: (() => void) | undefined;

  const clearRetry = (): void => {
    if (retryTimer === undefined) return;
    deps.clearTimer(retryTimer);
    retryTimer = undefined;
  };
  const clearPoll = (): void => {
    if (pollTimer === undefined) return;
    deps.clearTimer(pollTimer);
    pollTimer = undefined;
  };
  const release = (): void => {
    stream?.close();
    stream = undefined;
  };

  /** Uma conferência de cada vez, sempre com a próxima já agendada: aba escondida não arma nada (zero CPU). */
  const armPoll = (): void => {
    clearPoll();
    if (stopped || deps.hidden()) return;
    pollTimer = deps.setTimer(() => {
      pollTimer = undefined;
      if (stopped || deps.hidden()) return;
      deps.check().then(
        () => armPoll(),
        (e: unknown) => {
          deps.log(`conferência da revisão falhou: ${e instanceof Error ? e.name : "erro"}`);
          armPoll();
        },
      );
    }, state === "open" ? LIVE_POLL.openMs : LIVE_POLL.downMs);
  };

  const scheduleReconnect = (): void => {
    if (stopped || retryTimer !== undefined) return;
    state = "down";
    release();
    const wait = backoffMs(attempt, deps.random());
    attempt += 1;
    retryTimer = deps.setTimer(() => {
      retryTimer = undefined;
      connect();
    }, wait);
    armPoll();
  };

  function connect(): void {
    if (stopped) return;
    state = "connecting";
    const next = deps.open();
    stream = next;
    next.addEventListener("open", () => {
      if (stopped || stream !== next) return;
      state = "open";
      attempt = 0;
      armPoll();
      // religou: confere o que passou enquanto estava fora
      deps.check().catch((e: unknown) => deps.log(`conferência ao ligar falhou: ${e instanceof Error ? e.name : "erro"}`));
    });
    next.addEventListener("canvas", (ev) => {
      const notice = parseNotice(ev);
      if (notice === undefined) deps.log("aviso do servidor ilegível");
      else if (!stopped) deps.onCanvas(notice);
    });
    next.addEventListener("registry", () => {
      if (!stopped) deps.onRegistry();
    });
    next.addEventListener("error", () => {
      if (stopped || stream !== next) return;
      // o navegador ainda tenta sozinho (queda de rede): só conta como fora do ar; fechado de vez, a religação é nossa
      if (next.readyState === STREAM_CLOSED) scheduleReconnect();
      else {
        state = "down";
        armPoll();
      }
    });
  }

  return {
    start() {
      if (stopped || stream !== undefined) return;
      unsubscribe = deps.onVisibility(() => {
        if (stopped) return;
        if (deps.hidden()) {
          // escondida: nenhum timer de conferência; o PanelStream solta a conexão sozinho
          clearPoll();
          return;
        }
        deps.check().catch((e: unknown) => deps.log(`conferência ao voltar à aba falhou: ${e instanceof Error ? e.name : "erro"}`));
        armPoll();
      });
      connect();
      armPoll();
    },
    stop() {
      stopped = true;
      clearRetry();
      clearPoll();
      unsubscribe?.();
      unsubscribe = undefined;
      release();
    },
    state: () => state,
  };
}
