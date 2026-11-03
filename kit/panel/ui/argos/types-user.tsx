/* Tipos de nó do usuário do canvas do Argos: `note`, `text`, `draw-*` (rect, ellipse, arrow,
 * stroke), `unit-sketch` e `band`. `registerUserTypes(types, deps)` declara no registro de tipos o desenho, o tamanho
 * padrão, o ícone, o menu, as ações e a marca de nó do usuário (`live: false`); os componentes são HTML por cima do canvas.
 * Script clássico: registra window.ArgosTypesUser. Depende de React. Os modelos puros (note, draw, create, bands) chegam
 * por `deps.model` ou por window.CanvasModel (quando a montagem os puser no pacote); nada é importado em tempo de execução.
 * A regra mora em src/lib (canvas-note, canvas-draw, canvas-create, canvas-bands); aqui só se desenha e se coleta. A nota
 * lê e grava pela rota /api/canvas-notes/ (revisão contra escrita concorrente; o conflito é mostrado ao dono). Toda
 * mudança do documento sai por callback do host (`deps.onTextChange`, `deps.onRemove`), que a faz como operação da pilha
 * de desfazer: este arquivo nunca monta operação. */
import type { BandLive, BandStatus } from "../../../../src/lib/canvas-bands.ts";
import type * as BandsModule from "../../../../src/lib/canvas-bands.ts";
import type { CanvasDoc } from "../../../../src/lib/canvas-doc.ts";
import type * as CreateModule from "../../../../src/lib/canvas-create.ts";
import type * as DrawModule from "../../../../src/lib/canvas-draw.ts";
import type * as NoteModule from "../../../../src/lib/canvas-note.ts";
import type { NodeRenderInput, NodeTypeDef, NodeTypeRegistry } from "../../../../src/lib/canvas-types.ts";

/** Os módulos de src/lib que este arquivo usa; o teste entrega os reais, a página os pega do pacote. */
interface UserModel {
  note: typeof NoteModule;
  draw: typeof DrawModule;
  create: typeof CreateModule;
  bands: typeof BandsModule;
}

interface FetchInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
type FetchLike = (url: string, init: FetchInit) => Promise<{ status: number; json(): Promise<unknown> }>;

interface BandSource {
  /** O documento atual (a banda é um grupo dele); `undefined` enquanto não carregou. */
  doc(): CanvasDoc | undefined;
  /** O que a página sabe do grafo: estado e espera do dono de cada agente. */
  live(): BandLive;
  /** Leva a câmera e a seleção ao agente. */
  focus(agentId: string): void;
}

interface UserTypesDeps {
  /** `fetch` da página (ela junta o token da sessão); injetado para o teste não tocar a rede. */
  fetch: FetchLike;
  /** Relógio em ms desde a época. */
  now: () => number;
  model?: UserModel;
  /** Agenda `fn` daqui a `ms` e devolve quem cancela; o padrão é setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Copia texto (área de transferência); sem ele o esboço só mostra os comandos. */
  copy?: (text: string) => void;
  /** O host troca o `data` do nó `text` por uma operação do desfazer. Ausente, o texto é só de leitura. */
  onTextChange?: (nodeId: string, data: { text: string; style: string }) => void;
  /** O host apaga o nó (texto esvaziado). */
  onRemove?: (nodeId: string) => void;
  band?: BandSource;
  /** Tempo máximo de uma chamada à rota das notas. */
  timeoutMs?: number;
  /** O `marked` do vendor/ (window.marked na página); sem ele a nota só tem o modo Raw. */
  marked?: unknown;
}

type Child = ReactNode;
type Tree = ReactElement;

function makeArgosTypesUser() {
  const h = (type: unknown, props?: Record<string, unknown> | null, ...children: Child[]): Tree => React.createElement(type, props, ...children);

  const NOTES_URL = "/api/canvas-notes/";
  const NOTE_TIMEOUT_MS = 10_000;
  /* Os códigos da rota moram em src/panel/canvas-notes.ts, que puxa Node e não roda no navegador: espelhados aqui. */
  const SERVER_CODES = { notFound: "note_not_found", stale: "note_stale_revision", tooLarge: "note_too_large", invalidName: "note_invalid_name" } as const;
  /** Códigos só do cliente: falha de rede, tempo esgotado e resposta que não é a do contrato. */
  const CLIENT_CODES = { network: "note_network", timeout: "note_timeout", badResponse: "note_bad_response" } as const;
  const NOTE_MESSAGES: Readonly<Record<string, string>> = {
    [SERVER_CODES.stale]: "A nota mudou em outro lugar depois que você a abriu.",
    [SERVER_CODES.tooLarge]: "A nota passa do tamanho máximo (256 KiB).",
    [SERVER_CODES.invalidName]: "O nome do arquivo da nota é inválido.",
    [CLIENT_CODES.network]: "Sem resposta do painel.",
    [CLIENT_CODES.timeout]: "O painel demorou demais para responder.",
    [CLIENT_CODES.badResponse]: "Resposta inesperada do painel.",
    note_locked: "O conteúdo está bloqueado: desbloqueie para editar.",
    note_local_only: "Só pelo painel nesta máquina.",
    note_invalid_path: "Caminho inválido: absoluto, dentro da pasta pessoal e terminado em .md, .markdown ou .txt.",
    note_exists: "Já existe um arquivo nesse caminho.",
    note_invalid_image: "Só imagens PNG, JPEG, GIF ou WebP.",
    note_too_many_images: "A nota já tem imagens demais.",
    note_invalid_title: "Nome inválido.",
    note_not_found: "A nota não foi encontrada.",
  };
  const messageOf = (code: string): string => `${NOTE_MESSAGES[code] ?? "Não foi possível concluir."} (${code})`;

  // ---- cliente da rota das notas ----

  type NoteLoad = { ok: true; text: string; rev: string } | { ok: false; code: string };
  type NoteSave = { ok: true; rev: string } | { ok: false; code: string; rev?: string | null };

  type Outcome<T> = ({ ok: true } & T) | { ok: false; code: string };
  interface NoteMetaView { locked: boolean; title: string | null; location: "default" | "custom"; path: string | null; base: string }

  interface NoteClient {
    load(name: string): Promise<NoteLoad>;
    save(name: string, text: string, rev: string | null): Promise<NoteSave>;
    /** Bloqueio, nome fixado e local do arquivo (nota sem arquivo ainda: os padrões). */
    meta(name: string): Promise<Outcome<{ meta: NoteMetaView }>>;
    lock(name: string, locked: boolean): Promise<Outcome<{ locked: boolean }>>;
    rename(name: string, title: string | null): Promise<Outcome<{ title: string | null }>>;
    move(name: string, to: string | null): Promise<Outcome<{ location: string; path: string | null }>>;
    image(name: string, base64: string): Promise<Outcome<{ markdown: string }>>;
    /** Fechar: apaga o arquivo só se ele está na pasta padrão. */
    remove(name: string): Promise<Outcome<{ deleted: boolean }>>;
    /** Nota nova que aponta para um arquivo de fora (caminho absoluto), sem mover o original. */
    link(path: string): Promise<Outcome<{ name: string }>>;
  }

  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  };

  function resolveModel(deps: UserTypesDeps): UserModel {
    const model = deps.model ?? (globalThis as unknown as { CanvasModel?: Partial<UserModel> }).CanvasModel;
    if (!model?.note || !model.draw || !model.create || !model.bands) {
      throw new Error("ArgosTypesUser: faltam os módulos note, draw, create e bands (deps.model ou window.CanvasModel)");
    }
    return model as UserModel;
  }

  /** Nunca rejeita: falha de rede, tempo e resposta fora do contrato viram um código. */
  function createNoteClient(deps: UserTypesDeps, model: UserModel): NoteClient {
    const schedule = deps.schedule ?? defaultSchedule;
    const timeoutMs = deps.timeoutMs ?? NOTE_TIMEOUT_MS;

    async function call(name: string, init: Omit<FetchInit, "signal">): Promise<{ status: number; body: Record<string, unknown> } | { code: string }> {
      const controller = new AbortController();
      let timedOut = false;
      const cancel = schedule(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const res = await deps.fetch(`${NOTES_URL}${name}`, { ...init, signal: controller.signal });
        const body = await res.json();
        return isRecord(body) ? { status: res.status, body } : { code: CLIENT_CODES.badResponse };
      } catch {
        return { code: timedOut ? CLIENT_CODES.timeout : CLIENT_CODES.network };
      } finally {
        cancel();
      }
    }

    const codeOf = (body: Record<string, unknown>): string => (typeof body.code === "string" ? body.code : CLIENT_CODES.badResponse);

    /** `POST /api/canvas-notes/<nome>/<ação>`: a resposta 200 passa por `pick` (fora do contrato = `note_bad_response`). */
    async function post<T>(name: string, verb: string, payload: object, pick: (body: Record<string, unknown>) => T | undefined): Promise<Outcome<T>> {
      if (!model.note.isNoteName(name)) return { ok: false, code: SERVER_CODES.invalidName };
      const res = await call(`${name}/${verb}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if ("code" in res) return { ok: false, code: res.code };
      if (res.status !== 200) return { ok: false, code: codeOf(res.body) };
      const picked = pick(res.body);
      return picked === undefined ? { ok: false, code: CLIENT_CODES.badResponse } : { ok: true, ...picked };
    }

    return {
      async load(name) {
        if (!model.note.isNoteName(name)) return { ok: false, code: SERVER_CODES.invalidName };
        const res = await call(name, { method: "GET" });
        if ("code" in res) return { ok: false, code: res.code };
        const { body } = res;
        if (res.status === 200 && typeof body.text === "string" && typeof body.rev === "string") return { ok: true, text: body.text, rev: body.rev };
        return { ok: false, code: codeOf(body) };
      },
      async meta(name) {
        if (!model.note.isNoteName(name)) return { ok: false, code: SERVER_CODES.invalidName };
        const res = await call(name, { method: "GET" });
        if ("code" in res) return { ok: false, code: res.code };
        const { body } = res;
        if (res.status !== 200 && codeOf(body) !== SERVER_CODES.notFound) return { ok: false, code: codeOf(body) };
        return {
          ok: true,
          meta: {
            locked: body.locked === true, title: typeof body.title === "string" ? body.title : null, location: body.location === "custom" ? "custom" : "default",
            path: typeof body.path === "string" ? body.path : null, base: typeof body.base === "string" ? body.base : name,
          },
        };
      },
      lock: (name, locked) => post(name, "lock", { locked }, (body) => (typeof body.locked === "boolean" ? { locked: body.locked } : undefined)),
      rename: (name, title) => post(name, "rename", { title }, (body) => (body.title === null || typeof body.title === "string" ? { title: body.title as string | null } : undefined)),
      move: (name, to) => post(name, "move", { to }, (body) => (typeof body.location === "string" ? { location: body.location, path: typeof body.path === "string" ? body.path : null } : undefined)),
      image: (name, data) => post(name, "images", { data }, (body) => (typeof body.markdown === "string" ? { markdown: body.markdown } : undefined)),
      remove: (name) => post(name, "delete", {}, (body) => (typeof body.deleted === "boolean" ? { deleted: body.deleted } : undefined)),
      async link(path) {
        const res = await call("link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
        if ("code" in res) return { ok: false, code: res.code };
        const { body } = res;
        return res.status === 200 && typeof body.name === "string" && model.note.isNoteName(body.name) ? { ok: true, name: body.name } : { ok: false, code: codeOf(body) };
      },
      async save(name, text, rev) {
        if (!model.note.isNoteName(name)) return { ok: false, code: SERVER_CODES.invalidName };
        if (new TextEncoder().encode(text).length > model.note.NOTE_LIMITS.bodyBytes) return { ok: false, code: SERVER_CODES.tooLarge };
        const res = await call(name, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, rev }) });
        if ("code" in res) return { ok: false, code: res.code };
        const { body } = res;
        if (res.status === 200 && typeof body.rev === "string") return { ok: true, rev: body.rev };
        if (codeOf(body) === SERVER_CODES.stale) return { ok: false, code: SERVER_CODES.stale, rev: typeof body.rev === "string" ? body.rev : null };
        return { ok: false, code: codeOf(body) };
      },
    };
  }

  // ---- estado do editor da nota (puro) ----

  type NotePhase = "loading" | "ready" | "saving" | "conflict" | "failed";
  interface NoteState {
    phase: NotePhase;
    /** O que está gravado no servidor. */
    base: string;
    draft: string;
    /** Revisão lida; `null` = a nota ainda não existe. */
    rev: string | null;
    /** O texto em voo durante `saving`. */
    sent: string;
    /** A revisão atual do servidor, quando o `PUT` voltou em conflito. */
    remoteRev: string | null;
    savedAt: number | null;
    /** Último erro (não bloqueia a edição, salvo `failed`). */
    code: string | null;
  }
  type NoteAction =
    | { type: "load" }
    | { type: "loaded"; result: NoteLoad }
    | { type: "edit"; draft: string }
    | { type: "save" }
    | { type: "saved"; result: NoteSave; now: number };

  const NOTE_INITIAL: NoteState = { phase: "loading", base: "", draft: "", rev: null, sent: "", remoteRev: null, savedAt: null, code: null };

  function noteReducer(state: NoteState, action: NoteAction): NoteState {
    switch (action.type) {
      case "load":
        return { ...NOTE_INITIAL };
      case "loaded": {
        const { result } = action;
        if (result.ok) return { ...NOTE_INITIAL, phase: "ready", base: result.text, draft: result.text, rev: result.rev };
        // nota que ainda não tem arquivo nasce vazia; gravar com revisão nula a cria
        if (result.code === SERVER_CODES.notFound) return { ...NOTE_INITIAL, phase: "ready" };
        return { ...NOTE_INITIAL, phase: "failed", code: result.code };
      }
      case "edit":
        return state.phase === "ready" || state.phase === "conflict" ? { ...state, draft: action.draft } : state;
      case "save":
        return state.phase === "ready" || state.phase === "conflict" ? { ...state, phase: "saving", sent: state.draft, code: null } : state;
      case "saved": {
        if (state.phase !== "saving") return state;
        const { result } = action;
        if (result.ok) return { ...state, phase: "ready", base: state.sent, rev: result.rev, remoteRev: null, savedAt: action.now, code: null };
        if (result.code === SERVER_CODES.stale) return { ...state, phase: "conflict", remoteRev: result.rev ?? null, code: result.code };
        return { ...state, phase: "ready", code: result.code };
      }
    }
  }

  const isDirty = (state: NoteState): boolean => state.draft !== state.base;

  interface NoteViewHandlers {
    onEdit(draft: string): void;
    onSave(): void;
    /** Conflito: grava por cima, com a revisão que o servidor devolveu. */
    onOverwrite(): void;
    /** Conflito ou falha de leitura: lê de novo e descarta o rascunho. */
    onReload(): void;
  }

  const BUTTON = "inline-flex h-7 cursor-pointer items-center px-2 t-label text-foreground border border-border-strong outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40";

  /** Árvore da nota, pura (sem hooks): o teste a lê sem DOM. */
  function renderNoteView(model: UserModel, state: NoteState, info: { name: string; agent?: string }, on: NoteViewHandlers): Tree {
    const bytes = new TextEncoder().encode(state.draft).length;
    const tooBig = bytes > model.note.NOTE_LIMITS.bodyBytes;
    const busy = state.phase === "loading" || state.phase === "saving";
    const status = state.phase === "loading" ? "Carregando…" : state.phase === "saving" ? "Gravando…" : state.code ? messageOf(state.code) : isDirty(state) ? "Alterações não gravadas" : state.savedAt !== null ? "Gravada" : "";
    const header = h("div", { className: "flex items-center gap-2 t-label text-muted-foreground" },
      h("span", { className: "truncate" }, `${info.name}.md`),
      info.agent ? h("span", { className: "truncate" }, `agente: ${info.agent}`) : null);
    if (state.phase === "failed") {
      return h("div", { className: "flex h-full flex-col gap-2 p-2", "data-note-phase": state.phase }, header,
        h("p", { role: "alert", className: "text-bad t-label" }, messageOf(state.code ?? CLIENT_CODES.badResponse)),
        h("button", { type: "button", className: BUTTON, onClick: on.onReload }, "Tentar de novo"));
    }
    return h("div", { className: "flex h-full flex-col gap-2 p-2", "data-note-phase": state.phase }, header,
      h("textarea", {
        className: "min-h-0 flex-1 resize-none border border-border bg-background p-1 font-mono t-label text-foreground",
        "aria-label": `Texto da nota ${info.name}`, value: state.draft, disabled: busy, spellCheck: false,
        onChange: (event: { target: { value: string } }) => on.onEdit(event.target.value),
      }),
      state.phase === "conflict"
        ? h("div", { role: "alert", className: "flex flex-col gap-1 border border-warn p-1 t-label" },
          h("span", null, messageOf(state.code ?? SERVER_CODES.stale)),
          h("span", { className: "flex gap-1" },
            h("button", { type: "button", className: BUTTON, onClick: on.onOverwrite }, "Gravar o meu por cima"),
            h("button", { type: "button", className: BUTTON, onClick: on.onReload }, "Recarregar e descartar o meu")))
        : h("div", { className: "flex items-center gap-2" },
          h("button", { type: "button", className: BUTTON, disabled: busy || tooBig || !isDirty(state), onClick: on.onSave }, "Gravar"),
          h("span", { role: "status", className: state.code ? "text-bad t-label" : "t-label text-muted-foreground" }, tooBig ? messageOf(SERVER_CODES.tooLarge) : status)));
  }

  function NoteBody(props: { name: string; agent?: string; client: NoteClient; model: UserModel; now: () => number }): Tree {
    const { name, client } = props;
    const [state, setState] = React.useState<NoteState>(NOTE_INITIAL);
    const alive = React.useRef(true);
    const dispatch = React.useCallback((action: NoteAction): void => {
      if (alive.current) setState((current) => noteReducer(current, action));
    }, []);
    const reload = React.useCallback((): void => {
      dispatch({ type: "load" });
      // o cliente nunca rejeita (traduz tudo em código), então a promessa solta não esconde erro
      void client.load(name).then((result) => dispatch({ type: "loaded", result }));
    }, [client, name, dispatch]);
    React.useEffect(() => {
      alive.current = true;
      reload();
      return () => {
        alive.current = false;
      };
    }, [reload]);
    const send = (rev: string | null): void => {
      dispatch({ type: "save" });
      void client.save(name, state.draft, rev).then((result) => dispatch({ type: "saved", result, now: props.now() }));
    };
    return renderNoteView(props.model, state, { name, agent: props.agent }, {
      onEdit: (draft) => dispatch({ type: "edit", draft }),
      onSave: () => send(state.rev),
      onOverwrite: () => send(state.remoteRev),
      onReload: reload,
    });
  }

  // ---- nota de verdade (node-note.tsx desenha; aqui fica o estado do texto, a gravação e o conflito) ----

  interface NodeNoteApi {
    NoteCard(props: object): Tree;
  }
  const nodeNote = (): NodeNoteApi | undefined => (globalThis as unknown as { ArgosNodeNote?: NodeNoteApi }).ArgosNodeNote;

  /** Status do rodapé, o mesmo texto do editor simples. */
  function noteStatus(state: NoteState): string {
    if (state.phase === "loading") return "Carregando…";
    if (state.phase === "saving") return "Gravando…";
    if (state.code) return messageOf(state.code);
    if (isDirty(state)) return "Alterações não gravadas";
    return "";
  }

  function NoteCardHost(props: { name: string; agent?: string; client: NoteClient; model: UserModel; deps: UserTypesDeps }): Tree {
    const { name, client, deps } = props;
    const [state, setState] = React.useState<NoteState>(NOTE_INITIAL);
    const latest = React.useRef<NoteState>(NOTE_INITIAL);
    latest.current = state;
    const alive = React.useRef(true);
    const dispatch = React.useCallback((action: NoteAction): void => {
      if (alive.current) setState((current) => noteReducer(current, action));
    }, []);
    const reload = React.useCallback((): void => {
      dispatch({ type: "load" });
      void client.load(name).then((result) => dispatch({ type: "loaded", result }));
    }, [client, name, dispatch]);
    React.useEffect(() => {
      alive.current = true;
      reload();
      return () => {
        alive.current = false;
      };
    }, [reload]);
    // texto novo escrito por fora (agente ligado): entra só se não há rascunho nem gravação em voo
    const refresh = React.useCallback((): void => {
      const before = latest.current;
      if (before.phase !== "ready" || isDirty(before)) return;
      void client.load(name).then((result) => {
        const now = latest.current;
        if (!result.ok || now.phase !== "ready" || isDirty(now) || result.rev === now.rev) return;
        dispatch({ type: "loaded", result });
      });
    }, [client, name, dispatch]);
    const send = (rev: string | null): void => {
      dispatch({ type: "save" });
      void client.save(name, latest.current.draft, rev).then((result) => dispatch({ type: "saved", result, now: deps.now() }));
    };
    const conflict = state.phase === "conflict"
      ? h("div", { role: "alert", className: "flex flex-col gap-1 border border-warn p-1 t-label" },
        h("span", null, messageOf(state.code ?? SERVER_CODES.stale)),
        h("span", { className: "flex gap-1" },
          h("button", { type: "button", className: BUTTON, onClick: () => send(state.remoteRev) }, "Gravar o meu por cima"),
          h("button", { type: "button", className: BUTTON, onClick: reload }, "Recarregar e descartar o meu")))
      : state.phase === "failed"
        ? h("div", { role: "alert", className: "flex items-center gap-1 p-1 t-label text-bad" },
          messageOf(state.code ?? CLIENT_CODES.badResponse), h("button", { type: "button", className: BUTTON, onClick: reload }, "Tentar de novo"))
        : null;
    const card = nodeNote();
    if (!card) return h(NoteBody, { name, agent: props.agent, client, model: props.model, now: deps.now });
    return h(card.NoteCard, {
      name, agent: props.agent, model: props.model.note, marked: deps.marked, actions: client, schedule: deps.schedule ?? defaultSchedule, messageOf,
      editor: {
        phase: state.phase, draft: state.draft, rev: state.rev, dirty: isDirty(state), status: noteStatus(state), error: state.code !== null && state.phase !== "conflict",
        onEdit: (draft: string) => dispatch({ type: "edit", draft }), onSave: () => send(latest.current.rev), refresh, conflict,
      },
    });
  }

  // ---- texto livre ----

  type TextDecision =
    | { kind: "unchanged" }
    | { kind: "remove" }
    | { kind: "update"; data: { text: string; style: string } }
    | { kind: "invalid"; code: string };

  /** O que fazer quando a edição no lugar termina: vazio apaga o nó, igual não muda, acima do teto recusa. */
  function decideText(model: UserModel, previous: { text: string; style: string }, draft: string): TextDecision {
    if (draft.trim() === "") return { kind: "remove" };
    if (draft === previous.text) return { kind: "unchanged" };
    try {
      return { kind: "update", data: model.note.readTextData({ text: draft, style: previous.style }) };
    } catch (error) {
      if (error instanceof model.note.NoteError) return { kind: "invalid", code: error.code };
      throw error;
    }
  }

  const TEXT_CLASS: Readonly<Record<string, string>> = { title: "t-title font-semibold", label: "t-label" };

  function TextBody(props: { id: string; data: Record<string, unknown>; model: UserModel; deps: UserTypesDeps }): Tree {
    const { id, model, deps } = props;
    const [editing, setEditing] = React.useState(false);
    const [draft, setDraft] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    let data: NoteModule.TextData | undefined;
    try {
      data = model.note.readTextData(props.data);
    } catch (caught) {
      if (!(caught instanceof model.note.NoteError)) throw caught;
    }
    if (!data) return h("p", { role: "alert", className: "p-1 text-bad t-label" }, "Texto inválido no documento.");
    const current = data;
    const editable = deps.onTextChange !== undefined;
    const finish = (): void => {
      const decision = decideText(model, current, draft);
      if (decision.kind === "invalid") {
        setError(messageOf(decision.code));
        return;
      }
      setError(null);
      setEditing(false);
      if (decision.kind === "update") deps.onTextChange?.(id, decision.data);
      else if (decision.kind === "remove") deps.onRemove?.(id);
    };
    const begin = (): void => {
      if (!editable) return;
      setDraft(current.text);
      setError(null);
      setEditing(true);
    };
    if (editing) {
      return h("div", { className: "flex h-full flex-col" },
        h("textarea", {
          className: `h-full w-full resize-none bg-background p-1 text-foreground ${TEXT_CLASS[current.style] ?? ""}`, autoFocus: true, value: draft,
          "aria-label": "Editar o texto", onChange: (event: { target: { value: string } }) => setDraft(event.target.value), onBlur: finish,
          onKeyDown: (event: { key: string; ctrlKey?: boolean; metaKey?: boolean }) => {
            if (event.key === "Escape") setEditing(false);
            else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) finish();
          },
        }),
        error ? h("span", { role: "alert", className: "text-bad t-label" }, error) : null);
    }
    return h("div", {
      className: `h-full whitespace-pre-wrap p-1 text-foreground ${TEXT_CLASS[current.style] ?? ""}`, role: editable ? "button" : undefined, tabIndex: editable ? 0 : undefined,
      "aria-label": editable ? `Editar o texto: ${model.note.textTitle(current)}` : undefined,
      onDoubleClick: begin, onKeyDown: (event: { key: string }) => { if (event.key === "Enter") begin(); },
    }, current.text);
  }

  // ---- desenho (só exibição) ----

  interface Primitive { tag: "rect" | "ellipse" | "line" | "polyline" | "polygon"; attrs: Record<string, string | number> }

  const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  const WIDTH_RANGE = { min: 0.5, max: 64, fallback: 2 } as const;
  const ARROW_HEAD = { base: 10, perWidth: 2, spread: Math.PI / 7 } as const;
  const DRAW_LABELS: Readonly<Record<string, string>> = { "draw-rect": "Retângulo", "draw-ellipse": "Elipse", "draw-arrow": "Seta", "draw-stroke": "Traço à mão" };

  const colorOr = (value: unknown, fallback: string): string => (typeof value === "string" && COLOR.test(value) ? value : fallback);

  /** Formas do desenho em coordenadas locais (0..w, 0..h); dado corrompido no `data` dá lista vazia. */
  function drawPrimitives(model: UserModel, node: { id: string; type: string; w: number; h: number; data: Readonly<Record<string, unknown>> }): Primitive[] {
    const style = isRecord(node.data.style) ? node.data.style : {};
    const width = typeof style.width === "number" && Number.isFinite(style.width) ? Math.min(WIDTH_RANGE.max, Math.max(WIDTH_RANGE.min, style.width)) : WIDTH_RANGE.fallback;
    const stroke = colorOr(style.stroke, "currentColor");
    const fill = colorOr(style.fill, "none");
    const { w, h: height } = node;
    const local = { ...node, x: 0, y: 0, z: 0, locked: false, blurred: false, data: { ...node.data } };
    const line = { stroke, "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round" };
    switch (node.type) {
      case "draw-rect":
        return [{ tag: "rect", attrs: { x: width / 2, y: width / 2, width: Math.max(0, w - width), height: Math.max(0, height - width), fill, ...line } }];
      case "draw-ellipse":
        return [{ tag: "ellipse", attrs: { cx: w / 2, cy: height / 2, rx: Math.max(0, (w - width) / 2), ry: Math.max(0, (height - width) / 2), fill, ...line } }];
      case "draw-arrow": {
        const [from, to] = model.draw.drawPoints(local);
        if (!from || !to) return [];
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const size = ARROW_HEAD.base + ARROW_HEAD.perWidth * width;
        const wing = (turn: number): string => `${to.x - size * Math.cos(angle + turn)},${to.y - size * Math.sin(angle + turn)}`;
        return [
          { tag: "line", attrs: { x1: from.x, y1: from.y, x2: to.x, y2: to.y, ...line } },
          { tag: "polygon", attrs: { points: `${to.x},${to.y} ${wing(ARROW_HEAD.spread)} ${wing(-ARROW_HEAD.spread)}`, fill: stroke, stroke, "stroke-width": 1, "stroke-linejoin": "round" } },
        ];
      }
      case "draw-stroke": {
        const points = model.draw.drawPoints(local);
        return points.length === 0 ? [] : [{ tag: "polyline", attrs: { points: points.map((p) => `${p.x},${p.y}`).join(" "), fill: "none", ...line } }];
      }
      default:
        return [];
    }
  }

  function renderDraw(model: UserModel, input: NodeRenderInput): Tree {
    const shapes = drawPrimitives(model, input);
    return h("svg", {
      viewBox: `0 0 ${input.w} ${input.h}`, width: "100%", height: "100%", preserveAspectRatio: "none", role: "img",
      "aria-label": DRAW_LABELS[input.type] ?? "Desenho", className: "block text-foreground", style: { overflow: "visible" },
    }, ...shapes.map((shape, index) => h(shape.tag, { key: index, ...shape.attrs })));
  }

  // ---- esboço de unidade ----

  type SketchView = { ok: true; title: string; text: string } | { ok: false; code: string; message: string };

  /** Lê e valida o esboço do nó; o texto são os comandos que o dono cola e roda (nada é executado aqui). */
  function unitSketchView(model: UserModel, node: { id: string; type: string; data: Readonly<Record<string, unknown>> }): SketchView {
    try {
      const sketch = model.create.readUnitSketch(node);
      return { ok: true, title: `${sketch.kind === "skill" ? "Unidade de skill" : "Unidade de projeto"}: ${sketch.name}`, text: model.create.designUnit(sketch).text };
    } catch (error) {
      if (error instanceof model.create.CreateError) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  }

  function renderUnitSketch(model: UserModel, deps: UserTypesDeps, input: NodeRenderInput): Tree {
    const view = unitSketchView(model, input);
    if (!view.ok) return h("p", { role: "alert", className: "p-2 text-bad t-label" }, `Esboço inválido: ${view.message} (${view.code})`);
    return h("div", { className: "flex h-full flex-col gap-2 p-2" },
      h("span", { className: "t-label font-semibold" }, view.title),
      h("pre", { className: "min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-muted p-1 font-mono t-label", tabIndex: 0, "aria-label": "Comandos do esboço" }, view.text),
      deps.copy ? h("button", { type: "button", className: BUTTON, onClick: () => deps.copy?.(view.text) }, "Copiar comandos") : null,
      h("span", { className: "t-label text-muted-foreground" }, "Nada é executado: cole no terminal e rode você."));
  }

  // ---- banda ----

  const RANK_WORDS: Readonly<Record<string, string>> = { waiting: "espera por você", working: "trabalhando", other: "parado" };

  type BandView = { ok: true; status: BandStatus } | { ok: false; code: string; message: string };

  /** `data.group` é o id do grupo; grupo que sumiu ou que deixou de ser banda dá erro com código do documento. */
  function bandView(model: UserModel, source: BandSource | undefined, data: Readonly<Record<string, unknown>>): BandView {
    const doc = source?.doc();
    if (!source || !doc) return { ok: false, code: "band_no_source", message: "banda sem documento carregado" };
    if (typeof data.group !== "string" || data.group === "") return { ok: false, code: "band_invalid_data", message: "o nó não aponta para um grupo" };
    try {
      return { ok: true, status: model.bands.bandStatus(doc, data.group, source.live()) };
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string") return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  }

  function BandBody(props: { data: Readonly<Record<string, unknown>>; model: UserModel; source: BandSource | undefined }): Tree {
    const [current, setCurrent] = React.useState<string | undefined>(undefined);
    const view = bandView(props.model, props.source, props.data);
    if (!view.ok) return h("p", { role: "alert", className: "p-2 text-bad t-label" }, `${view.message} (${view.code})`);
    const { status } = view;
    const go = (id: string | undefined): void => {
      if (id === undefined) return;
      setCurrent(id);
      props.source?.focus(id);
    };
    const { counts } = status;
    return h("div", { className: "flex h-full flex-col gap-1 p-2" },
      h("div", { className: "flex items-center justify-between t-label" },
        h("span", { className: "font-semibold" }, status.label || "Banda"),
        h("span", { className: "text-muted-foreground" }, `${counts.waiting} esperam você · ${counts.working} trabalham`)),
      h("ul", { className: "min-h-0 flex-1 overflow-auto", "aria-label": "Agentes da banda" },
        ...status.members.map((member) => h("li", { key: member.id },
          h("button", {
            type: "button", className: `${BUTTON} w-full justify-between ${member.id === current ? "bg-accent" : ""}`, "aria-current": member.id === current ? "true" : undefined,
            onClick: () => go(member.id),
          }, h("span", { className: "truncate" }, member.id), h("span", null, RANK_WORDS[member.rank] ?? member.state))))),
      h("span", { className: "flex gap-1" },
        h("button", { type: "button", className: BUTTON, onClick: () => go(props.model.bands.stepBand(status, current, "previous")) }, "Anterior"),
        h("button", { type: "button", className: BUTTON, onClick: () => go(props.model.bands.stepBand(status, current, "next")) }, "Próximo")));
  }

  // ---- registro ----

  /** Comandos de menu de nó que os tipos citam; o registro de comandos da página os define (surface `node-menu`). */
  const MENU = { edit: "user:edit", duplicate: "user:duplicate", blur: "user:blur", remove: "user:remove", copyCommands: "user:copy-commands", linkNote: "user:link-note" } as const;

  /** Um tipo por linha: ícone, tamanho padrão (note 280×200 como `createNoteNode`) e menu. Ação de servidor: nenhuma. */
  const ROWS: readonly { type: string; label: string; icon: string; size: { w: number; h: number }; menu: readonly string[] }[] = [
    { type: "note", label: "Nota", icon: "StickyNote", size: { w: 280, h: 200 }, menu: [MENU.duplicate, MENU.blur, MENU.remove] },
    { type: "text", label: "Texto", icon: "Type", size: { w: 160, h: 36 }, menu: [MENU.edit, MENU.duplicate, MENU.blur, MENU.remove] },
    { type: "draw-rect", label: "Retângulo", icon: "Square", size: { w: 160, h: 100 }, menu: [MENU.duplicate, MENU.remove] },
    { type: "draw-ellipse", label: "Elipse", icon: "Circle", size: { w: 160, h: 100 }, menu: [MENU.duplicate, MENU.remove] },
    { type: "draw-arrow", label: "Seta", icon: "MoveUpRight", size: { w: 120, h: 80 }, menu: [MENU.duplicate, MENU.remove] },
    { type: "draw-stroke", label: "Traço à mão", icon: "Pencil", size: { w: 120, h: 80 }, menu: [MENU.duplicate, MENU.remove] },
    { type: "unit-sketch", label: "Esboço de unidade", icon: "DraftingCompass", size: { w: 320, h: 220 }, menu: [MENU.copyCommands, MENU.duplicate, MENU.blur, MENU.remove] },
    { type: "band", label: "Banda", icon: "Users", size: { w: 260, h: 180 }, menu: [MENU.linkNote, MENU.remove] },
  ];

  /** As declarações, prontas para `registry.register`. Todas HTML sobre o canvas e `live: false` (nós do usuário). */
  function userTypeDefs(deps: UserTypesDeps): NodeTypeDef[] {
    const model = resolveModel(deps);
    const client = createNoteClient(deps, model);
    const renderers: Readonly<Record<string, (input: NodeRenderInput) => Tree>> = {
      note: (input) => {
        let data: { note: string; agent?: string } | undefined;
        try {
          data = model.note.readNoteData(input.data);
        } catch (error) {
          if (!(error instanceof model.note.NoteError)) throw error;
        }
        if (!data) return h("p", { role: "alert", className: "p-2 text-bad t-label" }, "Nota inválida no documento.");
        return h(NoteCardHost, { key: input.id, name: data.note, agent: data.agent, client, model, deps: { ...deps, marked: deps.marked ?? (globalThis as unknown as { marked?: unknown }).marked } });
      },
      text: (input) => h(TextBody, { key: input.id, id: input.id, data: { ...input.data }, model, deps }),
      "unit-sketch": (input) => renderUnitSketch(model, deps, input),
      band: (input) => h(BandBody, { key: input.id, data: input.data, model, source: deps.band }),
    };
    return ROWS.map((row) => ({
      type: row.type,
      label: row.label,
      icon: row.icon,
      defaultSize: { ...row.size },
      draw: { surface: "html", render: renderers[row.type] ?? ((input: NodeRenderInput) => renderDraw(model, input)) },
      menu: [...row.menu],
      actions: [],
      live: false,
    }));
  }

  /** Registra os tipos do usuário; tipo já registrado é pulado (chamar de novo, p.ex. no modo estrito do React, não lança). */
  function registerUserTypes(types: NodeTypeRegistry, deps: UserTypesDeps): NodeTypeDef[] {
    return userTypeDefs(deps).filter((def) => !types.has(def.type)).map((def) => types.register(def));
  }

  return {
    registerUserTypes, userTypeDefs, createNoteClient, resolveModel,
    noteReducer, NOTE_INITIAL, renderNoteView, NoteBody, isDirty, NoteCardHost, noteStatus,
    decideText, TextBody, drawPrimitives, renderDraw, unitSketchView, renderUnitSketch, bandView, BandBody,
    MENU, NOTE_MESSAGES,
  };
}

type ArgosTypesUserApi = ReturnType<typeof makeArgosTypesUser>;
(globalThis as unknown as { ArgosTypesUser: ArgosTypesUserApi }).ArgosTypesUser = makeArgosTypesUser();
export type { ArgosTypesUserApi, UserModel, UserTypesDeps, BandSource, FetchLike };
