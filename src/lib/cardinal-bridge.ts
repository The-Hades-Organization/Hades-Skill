// Lado do painel da ponte `postMessage` com o editor do Cardinal embutido (reference/extensoes.md §Editor embutido).
// Só a lógica: o iframe e as rotas entram por `deps`, sem DOM nem Node, então um iframe simulado por script cobre o fluxo
// inteiro (carregar, salvar, 409, mudança externa, exportar). O painel nunca mescla: quem mescla é o editor; aqui só se
// leva ao editor o conteúdo atual do arquivo.

/** Versão do protocolo da ponte; toda mensagem leva `cardinal: 1`. */
export const BRIDGE_PROTOCOL = 1;

/** Editores vivos por página: o resto mostra o SVG guardado (cada editor é uma instância do WASM). */
export const EDITOR_MAX_LIVE = 2;

/** Espera por um `export-result` antes de desistir. */
export const EXPORT_TIMEOUT_MS = 30_000;

/** Espera pelo salvamento ao recolher o nó. */
export const FLUSH_TIMEOUT_MS = 5_000;

/** Espera pelo `ready` depois de montar o iframe; passou disso, o build web não subiu. */
export const READY_TIMEOUT_MS = 20_000;

/** O que o painel mostra do estado do editor. */
export type EditorState = "waiting" | "loading" | "ready" | "readonly" | "gone" | "failed";

/** Aviso de conflito que o editor resolveu no merge (o usuário venceu). */
export interface MergeConflict {
  kind: "both-changed" | "deleted-vs-changed" | "dangling-reference";
  id?: number;
}

export interface FileRead {
  bytes: Uint8Array;
  rev: string;
  /** `format` do envelope do arquivo (a rota de leitura devolve). */
  format: number;
  /** `false` quando o painel já sabe que o arquivo é de versão que o Cardinal conhecido não abre. */
  supported: boolean;
}

export type ReadResult = ({ ok: true } & FileRead) | { ok: false; code: string };

export type WriteResult = { ok: true; rev: string } | { ok: false; code: string; rev?: string | null };

/** O cliente das rotas do nó (fetch com chave, prazo e códigos): nunca rejeita, a falha vem como código. */
export interface BridgeApi {
  read(): Promise<ReadResult>;
  /** `baseRev` é a revisão que o editor diz conhecer; `cardinal_stale_revision` com a `rev` atual quando ficou velha. */
  write(bytes: Uint8Array, baseRev: string): Promise<WriteResult>;
  /** Grava a imagem do editor ao lado do arquivo, carimbada com `rev` (`/artifact`). */
  storeImage(format: ImageFormat, bytes: Uint8Array, rev: string): Promise<{ ok: true } | { ok: false; code: string }>;
}

export type ImageFormat = "svg" | "png";

export interface BridgeFrame {
  /** Manda ao editor com `targetOrigin: "*"` (a origem do iframe sandbox é opaca); `transfer` move os buffers. */
  post(message: Record<string, unknown>, transfer: ArrayBuffer[]): void;
}

export interface BridgeDeps {
  frame: BridgeFrame;
  api: BridgeApi;
  /** `format` mais alto que o editor conhecido lê; padrão: o do `ready`. Em teste, fixa o limite. */
  readOnly?: boolean;
  onState?(state: EditorState, reason?: string): void;
  onDirty?(dirty: boolean): void;
  onSaved?(rev: string): void;
  onMergeNotice?(conflicts: MergeConflict[]): void;
  /** Erro vindo do editor (`error`) ou do próprio painel (`panel_*`). */
  onError?(code: string, message: string): void;
  /** Relógio injetável: o teste não espera 30 s. */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface ExportOutcome {
  ok: boolean;
  bytes?: Uint8Array;
  /** `true` quando a imagem também foi gravada ao lado do arquivo. */
  stored?: boolean;
  /** Por que não gravou ao lado: `dirty` (o editor tem edição não salva), `diagram` (outro diagrama) ou o código da rota. */
  storedReason?: string;
  error?: string;
}

export interface Bridge {
  /** Entrada do `message` do iframe, já conferida a origem (`isFromFrame`). */
  handle(data: unknown): void;
  /** Aviso do SSE: o arquivo está em `rev` (`null` = saiu do disco). */
  fileChanged(rev: string | null): void;
  /** Pede ao editor a imagem; `store` grava ao lado do arquivo quando o editor está sem edição pendente. */
  requestExport(format: ImageFormat, options?: { diagram?: string; scale?: number; store?: boolean }): Promise<ExportOutcome>;
  /**
   * Recolher o nó: pede ao editor que salve já (`blur` tira o foco do iframe, que é o gatilho de salvamento dele) e espera o
   * `saved`. `true` se não sobrou edição sem gravar; `false` se estourou o prazo ou a gravação falhou.
   */
  flush(blur: () => void, timeoutMs?: number): Promise<boolean>;
  /** Revisão que o painel acha que o editor tem agora (base do próximo `save`). */
  rev(): string | undefined;
  dirty(): boolean;
  state(): EditorState;
  /** Para de ouvir; exportações em voo terminam com erro. */
  close(): void;
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

/** A mensagem veio do iframe do nó? (`source` é a janela do iframe: nada de confiar em `origin`, que é opaca.) */
export const isFromFrame = (event: { source?: unknown }, frameWindow: unknown): boolean => frameWindow != null && event.source === frameWindow;

const CONFLICT_KINDS = new Set(["both-changed", "deleted-vs-changed", "dangling-reference"]);
const STALE = "cardinal_stale_revision";

const conflictsOf = (value: unknown): MergeConflict[] => {
  if (!Array.isArray(value)) return [];
  const out: MergeConflict[] = [];
  for (const item of value) {
    if (!isDict(item) || typeof item.kind !== "string" || !CONFLICT_KINDS.has(item.kind)) continue;
    out.push(typeof item.id === "number" ? { kind: item.kind as MergeConflict["kind"], id: item.id } : { kind: item.kind as MergeConflict["kind"] });
  }
  return out;
};

const bytesOf = (value: unknown): Uint8Array | undefined => (value instanceof ArrayBuffer ? new Uint8Array(value) : undefined);

/** Cópia que se pode transferir sem esvaziar os bytes que o chamador ainda usa. */
const transferable = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

export function createBridge(deps: BridgeDeps): Bridge {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let state: EditorState = "waiting";
  let rev: string | undefined;
  let dirty = false;
  let editorFormat: number | undefined;
  let readOnly = false;
  let closed = false;
  /** O editor já recebeu um `load`; sem ele, um aviso de mudança refaz o `load` em vez de mandar `external-change`. */
  let loaded = false;
  let seq = 0;
  /** Um passo por vez: `save`, mudança externa e `ready` não se atropelam (a ordem save-rejected → external-change é do protocolo). */
  let queue: Promise<void> = Promise.resolve();
  const exporting = new Map<string, { done: (o: ExportOutcome) => void; format: ImageFormat; store: boolean; diagram: boolean; timer: unknown }>();

  const move = (next: EditorState, reason?: string): void => {
    state = next;
    deps.onState?.(next, reason);
  };
  const clean: (() => void)[] = [];
  const setDirty = (value: boolean): void => {
    if (dirty === value) return;
    dirty = value;
    deps.onDirty?.(value);
    if (!value) for (const resolve of clean.splice(0)) resolve();
  };
  const send = (type: string, body: Dict = {}, bytes?: Uint8Array): void => {
    if (closed) return;
    const message: Dict = { cardinal: BRIDGE_PROTOCOL, type, ...body };
    const transfer: ArrayBuffer[] = [];
    if (bytes) {
      const buffer = transferable(bytes);
      message.bytes = buffer;
      transfer.push(buffer);
    }
    deps.frame.post(message, transfer);
  };
  const enqueue = (step: () => Promise<void>): void => {
    queue = queue.then(step).catch((error: unknown) => {
      deps.onError?.("panel_bridge_failed", error instanceof Error ? error.message : String(error));
    });
  };

  const tooNew = (read: FileRead): boolean => !read.supported || (editorFormat !== undefined && read.format > editorFormat);

  async function load(): Promise<void> {
    move("loading");
    const read = await deps.api.read();
    if (closed) return;
    if (!read.ok) return move("failed", read.code);
    rev = read.rev;
    setDirty(false);
    // arquivo de formato maior que o do editor: abrir só para ler; gravar por cima perderia o que ele não entende
    readOnly = (deps.readOnly ?? false) || tooNew(read);
    send("load", { rev: read.rev, readOnly }, read.bytes);
    loaded = true;
    move(readOnly ? "readonly" : "ready", readOnly && tooNew(read) ? "format_too_new" : undefined);
  }

  /** Leva ao editor o conteúdo atual do arquivo; `rejected` manda antes o `save-rejected` que o provocou. */
  async function sync(rejected: boolean): Promise<void> {
    const read = await deps.api.read();
    if (closed) return;
    if (!read.ok) {
      if (read.code === "cardinal_not_found") return move("gone", read.code);
      return move("failed", read.code);
    }
    if (rejected) send("save-rejected", { currentRev: read.rev });
    if (tooNew(read)) {
      // o editor não lê esse arquivo: travar a edição e manter a cópia que ele tem
      readOnly = true;
      send("set-readonly", { value: true });
      return move("readonly", "format_too_new");
    }
    if (state === "gone" || state === "failed") move(readOnly ? "readonly" : "ready");
    if (!rejected && read.rev === rev) return;
    rev = read.rev;
    send("external-change", { rev: read.rev }, read.bytes);
  }

  async function save(baseRev: string, bytes: Uint8Array): Promise<void> {
    if (readOnly) return deps.onError?.("panel_readonly", "o editor está só para leitura; o salvamento foi descartado");
    const written = await deps.api.write(bytes, baseRev);
    if (closed) return;
    if (written.ok) {
      rev = written.rev;
      setDirty(false);
      send("saved", { rev: written.rev });
      return deps.onSaved?.(written.rev);
    }
    if (written.code === STALE) return sync(true);
    // outro erro (arquivo grande demais, versão futura, sem rede): o editor segue sujo e tenta no próximo salvamento
    deps.onError?.(written.code, "o diagrama não foi gravado");
  }

  function exported(data: Dict, bytes: Uint8Array | undefined): void {
    const id = typeof data.id === "string" ? data.id : undefined;
    const pending = id === undefined ? undefined : exporting.get(id);
    if (!pending || id === undefined) return;
    exporting.delete(id);
    clearTimer(pending.timer);
    if (typeof data.error === "string" || bytes === undefined) return pending.done({ ok: false, error: typeof data.error === "string" ? data.error : "missing-bytes" });
    const mine = rev;
    if (!pending.store || pending.diagram) return pending.done({ ok: true, bytes, stored: false, storedReason: pending.diagram ? "diagram" : undefined });
    // a imagem é do que o editor mostra: só vale ao lado do arquivo se não há edição pendente (então ele é a `rev` conhecida)
    if (dirty || mine === undefined) return pending.done({ ok: true, bytes, stored: false, storedReason: "dirty" });
    void deps.api.storeImage(pending.format, bytes, mine).then((stored) => pending.done(stored.ok ? { ok: true, bytes, stored: true } : { ok: true, bytes, stored: false, storedReason: stored.code }));
  }

  return {
    handle(data) {
      if (closed || !isDict(data) || data.cardinal !== BRIDGE_PROTOCOL || typeof data.type !== "string") return;
      const bytes = bytesOf(data.bytes);
      switch (data.type) {
        case "ready": {
          if (data.protocol !== BRIDGE_PROTOCOL) return move("failed", "protocol_mismatch");
          editorFormat = typeof data.format === "number" ? data.format : undefined;
          loaded = false;
          enqueue(load);
          return;
        }
        case "dirty":
          return setDirty(true);
        case "save": {
          if (typeof data.baseRev !== "string" || bytes === undefined) return deps.onError?.("panel_invalid_save", "mensagem save sem baseRev ou bytes");
          const base = data.baseRev;
          enqueue(() => save(base, bytes));
          return;
        }
        case "export-result":
          return exported(data, bytes);
        case "merge-notice": {
          const conflicts = conflictsOf(data.conflicts);
          if (conflicts.length > 0) deps.onMergeNotice?.(conflicts);
          return;
        }
        case "error":
          return deps.onError?.(typeof data.code === "string" ? data.code : "unknown", typeof data.message === "string" ? data.message : "");
        default:
      }
    },

    fileChanged(next) {
      if (closed || state === "waiting" || state === "loading") return;
      if (next === null) return enqueue(async () => move("gone", "cardinal_not_found"));
      if (!loaded) return enqueue(load);
      if (next === rev) return;
      enqueue(() => sync(false));
    },

    requestExport(format, options = {}) {
      return new Promise<ExportOutcome>((resolve) => {
        if (closed || state === "waiting" || state === "loading" || state === "failed") return resolve({ ok: false, error: "editor_unavailable" });
        seq += 1;
        const id = `e${seq}`;
        const timer = setTimer(() => {
          exporting.delete(id);
          resolve({ ok: false, error: "export_timeout" });
        }, EXPORT_TIMEOUT_MS);
        exporting.set(id, { done: resolve, format, store: options.store ?? true, diagram: options.diagram !== undefined, timer });
        const body: Dict = { id, format };
        if (options.diagram !== undefined) body.diagram = options.diagram;
        if (options.scale !== undefined) body.scale = options.scale;
        send("request-export", body);
      });
    },

    flush(blur, timeoutMs = FLUSH_TIMEOUT_MS) {
      if (closed || !dirty || readOnly) return Promise.resolve(!dirty);
      return new Promise<boolean>((resolve) => {
        let timer: unknown;
        const finish = (): void => {
          clearTimer(timer);
          resolve(!dirty);
        };
        timer = setTimer(finish, timeoutMs);
        clean.push(finish);
        blur();
      });
    },

    rev: () => rev,
    dirty: () => dirty,
    state: () => state,

    close() {
      closed = true;
      for (const resolve of clean.splice(0)) resolve();
      for (const [id, pending] of exporting) {
        clearTimer(pending.timer);
        pending.done({ ok: false, error: "closed" });
        exporting.delete(id);
      }
    },
  };
}

/** Os editores vivos da página: o terceiro a abrir não monta iframe e o nó mostra o SVG guardado. */
export interface EditorSlots {
  /** `true` se coube (e o nó ficou registrado); `false` se já há `EDITOR_MAX_LIVE`. Pedir de novo o mesmo nó é idempotente. */
  acquire(nodeId: string): boolean;
  release(nodeId: string): void;
  live(): string[];
}

export function createEditorSlots(max: number = EDITOR_MAX_LIVE): EditorSlots {
  const held = new Set<string>();
  return {
    acquire(nodeId) {
      if (held.has(nodeId)) return true;
      if (held.size >= max) return false;
      held.add(nodeId);
      return true;
    },
    release: (nodeId) => void held.delete(nodeId),
    live: () => [...held],
  };
}

/** Aviso do SSE `cardinal` (`/api/canvas/stream`): o diagrama `name` está em `rev` (`null` = saiu do disco). */
export interface CardinalNotice {
  name: string;
  rev: string | null;
  source: string;
}

/** Distribui os avisos do SSE aos editores abertos, por nome de diagrama; um por página (`cardinalFeed`). */
export interface CardinalFeed {
  publish(notice: CardinalNotice): void;
  /** Devolve quem cancela a assinatura. */
  subscribe(name: string, listener: (notice: CardinalNotice) => void): () => void;
}

export function createCardinalFeed(): CardinalFeed {
  const listeners = new Map<string, Set<(notice: CardinalNotice) => void>>();
  return {
    publish(notice) {
      for (const listener of [...(listeners.get(notice.name) ?? [])]) listener(notice);
    },
    subscribe(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(name) === set) listeners.delete(name);
      };
    },
  };
}

export const cardinalFeed: CardinalFeed = createCardinalFeed();

/** Os mesmos `EDITOR_MAX_LIVE` editores valem para a página inteira (os nós compartilham este registro). */
export const editorSlots: EditorSlots = createEditorSlots();

/** O `fetch` com chave que a página tem; só o que o cliente usa. */
export type ClientFetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface CardinalClientDeps {
  fetch: ClientFetch;
  canvasId: string;
  nodeId: string;
  timeoutMs?: number;
}

const CLIENT_TIMEOUT_MS = 15_000;
const CLIENT_CODES = { network: "cardinal_network", timeout: "cardinal_client_timeout", badResponse: "cardinal_bad_response", notUtf8: "cardinal_not_utf8" } as const;

const toBase64 = (bytes: Uint8Array): string => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

/** Cliente das rotas `/api/canvas-cardinal/<canvas>/<nó>` para a ponte. Nunca rejeita: falha de rede, prazo e resposta fora do contrato viram código. */
export function createCardinalClient(deps: CardinalClientDeps): BridgeApi {
  const base = `/api/canvas-cardinal/${encodeURIComponent(deps.canvasId)}/${encodeURIComponent(deps.nodeId)}`;
  const timeoutMs = deps.timeoutMs ?? CLIENT_TIMEOUT_MS;

  async function call(path: string, init: { method: string; body?: unknown }): Promise<{ status: number; body: Dict } | { code: string }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const headers = init.body === undefined ? undefined : { "content-type": "application/json" };
      const res = await deps.fetch(`${base}${path}`, { method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: controller.signal });
      const body = await res.json();
      return isDict(body) ? { status: res.status, body } : { code: CLIENT_CODES.badResponse };
    } catch {
      return { code: timedOut ? CLIENT_CODES.timeout : CLIENT_CODES.network };
    } finally {
      clearTimeout(timer);
    }
  }
  const codeOf = (body: Dict): string => (typeof body.code === "string" ? body.code : CLIENT_CODES.badResponse);

  return {
    async read() {
      const res = await call("", { method: "GET" });
      if ("code" in res) return { ok: false, code: res.code };
      const { body } = res;
      if (res.status !== 200) return { ok: false, code: codeOf(body) };
      if (typeof body.text !== "string" || typeof body.rev !== "string") return { ok: false, code: CLIENT_CODES.badResponse };
      const format = typeof body.format === "number" ? body.format : 0;
      return { ok: true, bytes: new TextEncoder().encode(body.text), rev: body.rev, format, supported: body.supported !== false && body.valid !== false };
    },
    async write(bytes, baseRev) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { ok: false, code: CLIENT_CODES.notUtf8 };
      }
      const res = await call("", { method: "PUT", body: { text, rev: baseRev } });
      if ("code" in res) return { ok: false, code: res.code };
      const { body } = res;
      if (res.status === 200 && typeof body.rev === "string") return { ok: true, rev: body.rev };
      return { ok: false, code: codeOf(body), rev: typeof body.rev === "string" ? body.rev : null };
    },
    async storeImage(format, bytes, rev) {
      const data = format === "svg" ? new TextDecoder().decode(bytes) : toBase64(bytes);
      const res = await call("/artifact", { method: "POST", body: { format, rev, data } });
      if ("code" in res) return { ok: false, code: res.code };
      return res.status === 200 ? { ok: true } : { ok: false, code: codeOf(res.body) };
    },
  };
}
