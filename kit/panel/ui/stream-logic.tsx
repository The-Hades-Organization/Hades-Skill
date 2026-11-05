/* Fluxo SSE do painel que solta a conexão com a aba escondida (reference/panel.md §Conexões do navegador).
 * O painel é HTTP/1.1 em 127.0.0.1 e o navegador abre no máximo 6 conexões por servidor (Firefox e Chrome). Cada EventSource
 * prende uma delas enquanto vive: duas abas do Argos (3 cada) esgotam o teto e todo fetch da página (gravar o canvas, ler o
 * canvas, criar terminal) fica na fila até o tempo esgotar, sem chegar ao servidor. Aqui o fluxo fecha a conexão depois de
 * `graceMs` com a aba escondida e abre de novo quando ela volta, com os mesmos ouvintes; o `open` da religação é o sinal para
 * quem precisa conferir o que passou. Sem DOM e sem React: o navegador carrega como script (window.PanelStream, antes do
 * app.js) e o bun test importa o mesmo arquivo. */

interface StreamLike {
  readyState: number;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  close(): void;
}
interface StreamDeps {
  create(url: string): StreamLike;
  hidden(): boolean;
  /** Assina a troca de visibilidade da aba; devolve o cancelamento. */
  onVisibility(fn: () => void): () => void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
type Handler = (ev: unknown) => void;

function makePanelStream(deps: StreamDeps) {
  /** Tempo com a aba escondida antes de soltar a conexão: trocar de aba e voltar logo não religa à toa. */
  const HIDDEN_GRACE_MS = 5000;
  const CONNECTING = 0;
  const CLOSED = 2;

  function open(url: string, options: { graceMs?: number } = {}) {
    const graceMs = options.graceMs ?? HIDDEN_GRACE_MS;
    const listeners: Array<[string, Handler]> = [];
    const props: Record<string, Handler | null> = { open: null, message: null, error: null };
    let es: StreamLike | null = null;
    let timer: unknown;
    let closed = false;

    const dispatch = (type: string) => (ev: unknown) => {
      if (closed) return;
      const prop = props[type];
      if (prop) prop(ev);
    };
    const connect = (): void => {
      const next = deps.create(url);
      for (const [type, fn] of listeners) next.addEventListener(type, fn);
      for (const type of Object.keys(props)) next.addEventListener(type, dispatch(type));
      es = next;
    };
    const release = (): void => {
      if (!es) return;
      es.close();
      es = null;
    };
    const clear = (): void => {
      if (timer === undefined) return;
      deps.clearTimer(timer);
      timer = undefined;
    };
    const visibility = (): void => {
      if (closed) return;
      if (deps.hidden()) {
        if (es && timer === undefined) timer = deps.setTimer(() => { timer = undefined; if (deps.hidden()) release(); }, graceMs);
        return;
      }
      clear();
      if (!es) connect();
    };
    const unsubscribe = deps.onVisibility(visibility);
    if (!deps.hidden()) connect();

    return {
      get readyState(): number {
        if (closed) return CLOSED;
        return es ? es.readyState : CONNECTING;
      },
      /** Solta à mão (fechada pela aba escondida), conta como conectando: quem lê o estado não cai para o polling. */
      get paused(): boolean {
        return !closed && es === null;
      },
      addEventListener(type: string, fn: Handler): void {
        listeners.push([type, fn]);
        if (es) es.addEventListener(type, fn);
      },
      set onopen(fn: Handler | null) { props.open = fn; },
      get onopen(): Handler | null { return props["open"] ?? null; },
      set onmessage(fn: Handler | null) { props.message = fn; },
      get onmessage(): Handler | null { return props["message"] ?? null; },
      set onerror(fn: Handler | null) { props.error = fn; },
      get onerror(): Handler | null { return props["error"] ?? null; },
      close(): void {
        if (closed) return;
        closed = true;
        clear();
        unsubscribe();
        release();
      },
    };
  }

  return { HIDDEN_GRACE_MS, open };
}

type PanelStreamApi = ReturnType<typeof makePanelStream>;
const streamGlobal = globalThis as unknown as {
  PanelStreamFactory: typeof makePanelStream;
  PanelStream?: PanelStreamApi;
  EventSource?: new (url: string) => StreamLike;
  document?: { hidden: boolean; addEventListener(t: string, fn: () => void): void; removeEventListener(t: string, fn: () => void): void };
};
streamGlobal.PanelStreamFactory = makePanelStream;
const streamDoc = streamGlobal.document;
const StreamSource = streamGlobal.EventSource;
if (streamDoc && StreamSource) {
  streamGlobal.PanelStream = makePanelStream({
    create: (url) => new StreamSource(url),
    hidden: () => streamDoc.hidden,
    onVisibility: (fn) => { streamDoc.addEventListener("visibilitychange", fn); return () => streamDoc.removeEventListener("visibilitychange", fn); },
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}
