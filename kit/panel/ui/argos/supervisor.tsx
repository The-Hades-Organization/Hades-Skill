/* Supervisor do canvas do Argos (reference/argos.md §Supervisor): painel flutuante, separado do canvas, que acompanha os
 * terminais sem precisar de interação. Quando um agente passa de `working` a parado (ocioso, bloqueado, fim) ou o pane
 * sai, o monitor pede o cartão ao servidor (GET /api/argos/supervisor/peek: lê o pane e resume por heurística, tudo local)
 * e o painel mostra estado, últimas linhas, pergunta ou permissão detectada, prévia do quadro e sugestões. Sob demanda,
 * "veja o que o revisor está fazendo" e "resume as notas" vão ao `claude -p` (POST …/ask e …/notes), com selo de que o
 * texto sai da máquina; "anota que …" acrescenta uma entrada datada na nota "Notas do supervisor", criada na primeira vez
 * (arquivo pela rota das notas, nó como operação do desfazer). Só lê, resume e anota: nada aqui manda texto, tecla ou
 * comando a um agente (o host dos terminais é lido por `subscribe`, `statusOf`, `exitedOf` e `target`, nunca `input`).
 * Script clássico: registra window.ArgosSupervisor; depende de React e de window.CanvasModel (note, history). */
import type { CanvasDoc, CanvasNode } from "../../../../src/lib/canvas-doc.ts";
import type { CanvasOp } from "../../../../src/lib/canvas-history.ts";
import type * as NoteModule from "../../../../src/lib/canvas-note.ts";
import type { SupervisorCard, Suggestion } from "../../../../src/lib/canvas-supervisor.ts";

interface SupervisorFetchInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
type SupervisorFetch = (url: string, init: SupervisorFetchInit) => Promise<{ status: number; json(): Promise<unknown> }>;

/** O que o supervisor lê do host dos terminais da página (`createTtyHost`). Não há `input`: ele não escreve em pane. */
interface SupervisorHost {
  subscribe(fn: (topic: string) => void): () => void;
  statusOf(id: string): string;
  exitedOf(id: string): boolean;
  target(id: string): { session: string; pane: string } | null;
}

interface SupervisorTerminal {
  id: string;
  label: string;
}

type Outcome<T> = ({ ok: true } & T) | { ok: false; code: string; message: string; phrase?: string };

interface Sent {
  lines?: number;
  notes?: number;
  chars: number;
}

type Entry =
  | { key: string; type: "watch"; at: number; id: string; label: string; card: SupervisorCard }
  | { key: string; type: "answer"; at: number; id: string; label: string; question: string; text: string; sent: Sent }
  | { key: string; type: "summary"; at: number; text: string; sent: Sent }
  | { key: string; type: "noted"; at: number; text: string; created: boolean };

interface SupervisorLayerProps {
  open: boolean;
  onOpen(): void;
  onClose(): void;
  host: SupervisorHost;
  /** Terminais do canvas que o host conhece (nó com alvo no herdr), com o nome da tela. */
  terminals: readonly SupervisorTerminal[];
  /** Documento salvo (não o de vista): a nota do supervisor é procurada e criada nele. */
  doc: CanvasDoc;
  canvasId: string;
  /** Aplica a operação montada sobre o documento atual (um passo do desfazer); `false` se recusada. */
  commit(make: (doc: CanvasDoc) => CanvasOp): boolean;
  /** Onde a nota nova nasce (mundo): em geral o centro da vista. */
  center(): { x: number; y: number };
  /** Leva a câmera até o nó e o seleciona. */
  onJump(id: string): void;
  fetch: SupervisorFetch;
  now?(): number;
}

const SUPERVISOR_NOTE = "nota-supervisor";
const NOTE_TITLE = "Notas do supervisor";
const NOTE_SIZE = { w: 360, h: 280 } as const;
const NODE_ID = "supervisor-notas";
const ENTRIES_MAX = 40;
const TIMEOUT_MS = 20_000;
const CLAUDE_TIMEOUT_MS = 150_000;
const CLAUDE_OFF_MESSAGE = "Consulta e resumo desligados em Configurações (Canvas: supervisor usa o claude -p). Cartões e anotações seguem locais.";
const PAUSE = ["idle", "blocked", "done"];
const BASE = "/api/argos/supervisor";
const NOTES_URL = "/api/canvas-notes/";
const JSON_HEADERS = { "content-type": "application/json" };
const KIND_TONE: Readonly<Record<string, string>> = {
  permission: "border-l-warn", question: "border-l-warn", error: "border-l-bad", done: "border-l-ok", idle: "border-l-border-strong",
};

function makeArgosSupervisor() {
  const model = (globalThis as unknown as { CanvasModel?: { note?: typeof NoteModule } }).CanvasModel;
  if (!model?.note) throw new Error("ArgosSupervisor: carregue /ui/lib/canvas-model.js (com `note`) antes de supervisor.js");
  const N = model.note;

  // ---- regra pura ----

  /** De `working` para parado é pausa (fim, se `done`); pane que sai é fim. Qualquer outra troca não gera cartão. */
  function transitionOf(prev: { status: string; exited: boolean } | undefined, next: { status: string; exited: boolean }): "end" | "pause" | null {
    if (!prev) return null;
    if (next.exited && !prev.exited) return "end";
    if (prev.status !== "working" || !PAUSE.includes(next.status)) return null;
    return next.status === "done" ? "end" : "pause";
  }

  const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

  /** "anota que …" anota; "resume as notas" resume as notas conectadas; o resto é pergunta. */
  function parseCommand(raw: string): { kind: "note" | "notes" | "ask"; text: string } {
    const text = raw.trim();
    // o verbo precisa terminar a palavra: "anotação do dia?" é pergunta
    const note = /^(?:anota|anote|anotar)(?:\s+que\s+|\s*:\s*|\s+)([\s\S]+)$/iu.exec(text);
    if (note) return { kind: "note", text: (note[1] as string).trim() };
    if (/^(?:resum[aeo]|resumir)\b[\s\S]*\bnotas?\b/iu.test(fold(text))) return { kind: "notes", text };
    return { kind: "ask", text };
  }

  /** Terminal citado pelo nome na pergunta (sem acento nem caixa, o nome mais longo vence); `null` se nenhum. */
  function pickTerminal(text: string, terminals: readonly SupervisorTerminal[]): string | null {
    const hay = ` ${fold(text).replace(/[^\p{L}\p{N}_-]+/gu, " ")} `;
    let best: SupervisorTerminal | null = null;
    for (const t of terminals) {
      const name = fold(t.label).replace(/[^\p{L}\p{N}_-]+/gu, " ").trim();
      if (name && hay.includes(` ${name} `) && (!best || name.length > fold(best.label).length)) best = t;
    }
    return best ? best.id : null;
  }

  const pad = (n: number): string => String(n).padStart(2, "0");
  /** Linha datada (hora local) da nota do supervisor. */
  function entryLine(text: string, at: Date): string {
    const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    return `- ${day} — ${text.replace(/\s*\n\s*/g, " ").trim()}`;
  }
  const NOTE_HEADER = `# ${NOTE_TITLE}\n\n`;
  /** Texto novo da nota: o cabeçalho se ela não existia, e a entrada sempre no fim. */
  function appendEntry(current: string | null, line: string): string {
    const base = current === null || !current.trim() ? NOTE_HEADER : current.endsWith("\n") ? current : `${current}\n`;
    return `${base}${line}\n`;
  }
  /** O nó da nota do supervisor no documento, se já existe. */
  const supervisorNode = (doc: CanvasDoc): CanvasNode | undefined =>
    doc.nodes.find((n) => n.type === N.NOTE_TYPE && (n.data as { note?: unknown }).note === SUPERVISOR_NOTE);
  /** Id livre para o nó da nota (`supervisor-notas`, `supervisor-notas-2`, …). */
  function freeNodeId(doc: CanvasDoc): string {
    const used = new Set(doc.nodes.map((n) => n.id));
    for (let i = 1; ; i++) {
      const id = i === 1 ? NODE_ID : `${NODE_ID}-${i}`;
      if (!used.has(id)) return id;
    }
  }

  // ---- cliente das rotas ----

  function createSupervisorClient(fetch: SupervisorFetch) {
    async function call(url: string, init: SupervisorFetchInit, timeoutMs = TIMEOUT_MS): Promise<{ status: number; body: Record<string, unknown> } | { code: string }> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        const body = await res.json();
        return typeof body === "object" && body !== null && !Array.isArray(body) ? { status: res.status, body: body as Record<string, unknown> } : { code: "supervisor_bad_response" };
      } catch {
        return { code: controller.signal.aborted ? "supervisor_timeout" : "supervisor_network" };
      } finally {
        clearTimeout(timer);
      }
    }
    const fail = (res: { status: number; body: Record<string, unknown> } | { code: string }): { ok: false; code: string; message: string; phrase?: string } => {
      if ("code" in res) return { ok: false, code: res.code, message: res.code === "supervisor_timeout" ? "o painel demorou demais para responder" : "sem resposta do painel" };
      const out: { ok: false; code: string; message: string; phrase?: string } = {
        ok: false, code: typeof res.body.code === "string" ? res.body.code : "supervisor_bad_response",
        message: typeof res.body.error === "string" ? res.body.error : "resposta inesperada do painel",
      };
      if (typeof res.body.phrase === "string") out.phrase = res.body.phrase;
      return out;
    };
    const sentOf = (v: unknown): Sent => {
      const s = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
      const out: Sent = { chars: typeof s.chars === "number" ? s.chars : 0 };
      if (typeof s.lines === "number") out.lines = s.lines;
      if (typeof s.notes === "number") out.notes = s.notes;
      return out;
    };
    const post = (url: string, payload: object): Promise<{ status: number; body: Record<string, unknown> } | { code: string }> =>
      call(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload) }, CLAUDE_TIMEOUT_MS);

    return {
      async status(): Promise<Outcome<{ claude: boolean }>> {
        const res = await call(BASE, { method: "GET" });
        return !("code" in res) && res.status === 200 && typeof res.body.claude === "boolean" ? { ok: true, claude: res.body.claude } : fail(res);
      },
      async peek(t: { session: string; pane: string }, status: string, exited: boolean): Promise<Outcome<{ card: SupervisorCard }>> {
        const q = `session=${encodeURIComponent(t.session)}&pane=${encodeURIComponent(t.pane)}&status=${encodeURIComponent(status)}${exited ? "&exited=1" : ""}`;
        const res = await call(`${BASE}/peek?${q}`, { method: "GET" });
        if ("code" in res || res.status !== 200) return fail(res);
        const card = res.body.card as SupervisorCard | undefined;
        return card && typeof card.title === "string" && Array.isArray(card.preview) ? { ok: true, card } : fail({ code: "supervisor_bad_response" });
      },
      async ask(input: { session: string; pane: string; name: string; question: string; confirm?: string }): Promise<Outcome<{ answer: string; sent: Sent }>> {
        const res = await post(`${BASE}/ask`, input);
        if ("code" in res || res.status !== 200 || typeof res.body.answer !== "string") return fail(res);
        return { ok: true, answer: res.body.answer, sent: sentOf(res.body.sent) };
      },
      async notes(input: { canvas: string; confirm?: string }): Promise<Outcome<{ summary: string; sent: Sent }>> {
        const res = await post(`${BASE}/notes`, input);
        if ("code" in res || res.status !== 200 || typeof res.body.summary !== "string") return fail(res);
        return { ok: true, summary: res.body.summary, sent: sentOf(res.body.sent) };
      },
      /** A nota pela rota das notas: texto e revisão; `text: null` se o arquivo ainda não existe. */
      async noteLoad(): Promise<Outcome<{ text: string | null; rev: string | null }>> {
        const res = await call(`${NOTES_URL}${SUPERVISOR_NOTE}`, { method: "GET" });
        if ("code" in res) return fail(res);
        if (res.status === 200 && typeof res.body.text === "string" && typeof res.body.rev === "string") return { ok: true, text: res.body.text, rev: res.body.rev };
        if (res.status === 404) return { ok: true, text: null, rev: null };
        return fail(res);
      },
      async noteSave(text: string, rev: string | null): Promise<Outcome<{ rev: string }>> {
        const res = await call(`${NOTES_URL}${SUPERVISOR_NOTE}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ text, rev }) });
        if ("code" in res || res.status !== 200 || typeof res.body.rev !== "string") return fail(res);
        return { ok: true, rev: res.body.rev };
      },
    };
  }
  type SupervisorClient = ReturnType<typeof createSupervisorClient>;

  /**
   * Acrescenta a entrada na nota do supervisor: lê, grava com a revisão (uma nova tentativa se outro escreveu no meio) e,
   * se o documento ainda não tem o nó, cria o nó (operação do desfazer) depois do arquivo, que é a mesma nota de sempre.
   * O documento é lido por `docNow` depois das esperas: um nó criado enquanto o arquivo era gravado não se duplica.
   */
  async function annotate(input: { client: SupervisorClient; docNow: () => CanvasDoc; commit: SupervisorLayerProps["commit"]; center: () => { x: number; y: number }; text: string; at: Date }): Promise<Outcome<{ created: boolean; nodeId: string }>> {
    const line = entryLine(input.text, input.at);
    let saved: Outcome<{ rev: string }> = { ok: false, code: "note_stale_revision", message: "" };
    for (let attempt = 0; attempt < 2 && !saved.ok && saved.code === "note_stale_revision"; attempt++) {
      const loaded = await input.client.noteLoad();
      if (!loaded.ok) return loaded;
      saved = await input.client.noteSave(appendEntry(loaded.text, line), loaded.rev);
    }
    if (!saved.ok) return saved;
    const existing = supervisorNode(input.docNow());
    if (existing) return { ok: true, created: false, nodeId: existing.id };
    const c = input.center();
    let nodeId: string = NODE_ID;
    const placed = input.commit((doc) => {
      nodeId = freeNodeId(doc);
      return N.createNoteNode(doc, {
        id: nodeId, note: SUPERVISOR_NOTE, x: Math.round(c.x - NOTE_SIZE.w / 2), y: Math.round(c.y - NOTE_SIZE.h / 2), w: NOTE_SIZE.w, h: NOTE_SIZE.h,
      }).op;
    });
    return placed ? { ok: true, created: true, nodeId } : { ok: false, code: "supervisor_note_node", message: "a entrada foi anotada, mas o canvas recusou o nó da nota" };
  }

  // ---- monitor passivo ----

  /**
   * Observa o host dos terminais e chama `onCard` quando um terminal para (de `working` a ocioso, bloqueado ou fim) ou o pane
   * sai. Um pedido de cartão por terminal de cada vez; o estado inicial só é registrado, sem cartão.
   */
  function createMonitor(deps: { host: SupervisorHost; client: Pick<SupervisorClient, "peek">; onCard(entry: { id: string; label: string; card: SupervisorCard }): void; onError?(message: string): void }) {
    let terminals: readonly SupervisorTerminal[] = [];
    const last = new Map<string, { status: string; exited: boolean }>();
    const pending = new Set<string>();
    const stateOf = (id: string): { status: string; exited: boolean } => ({ status: deps.host.statusOf(id), exited: deps.host.exitedOf(id) });

    async function card(t: SupervisorTerminal, now: { status: string; exited: boolean }): Promise<void> {
      const target = deps.host.target(t.id);
      if (!target || pending.has(t.id)) return;
      pending.add(t.id);
      try {
        const r = await deps.client.peek(target, now.status, now.exited);
        if (r.ok) deps.onCard({ id: t.id, label: t.label, card: r.card });
        else deps.onError?.(`${t.label}: ${r.message}`);
      } finally {
        pending.delete(t.id);
      }
    }
    function check(): void {
      for (const t of terminals) {
        const now = stateOf(t.id);
        const change = transitionOf(last.get(t.id), now);
        last.set(t.id, now);
        if (change) void card(t, now);
      }
    }
    const off = deps.host.subscribe(check);
    return {
      setTerminals(next: readonly SupervisorTerminal[]): void {
        terminals = next;
        const ids = new Set(next.map((t) => t.id));
        for (const id of [...last.keys()]) if (!ids.has(id)) last.delete(id);
        for (const t of next) if (!last.has(t.id)) last.set(t.id, stateOf(t.id));
      },
      check,
      destroy: off,
    };
  }

  // ---- desenho ----

  const FOCUS_RING = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
  const BUTTON = `inline-flex min-h-7 cursor-pointer items-center justify-center gap-1 border border-border px-2 t-meta transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11 ${FOCUS_RING}`;
  const stop = (event: { stopPropagation(): void }): void => event.stopPropagation();
  // ilha: ponteiro e roda dentro do painel não chegam ao canvas
  const SHIELD = { onPointerDown: stop, onPointerMove: stop, onPointerUp: stop, onPointerCancel: stop, onWheel: stop, onDoubleClick: stop, onContextMenu: stop };
  const clock = (at: number): string => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  interface PanelUi {
    h: ReactApi["createElement"];
    entries: readonly Entry[];
    terminals: readonly SupervisorTerminal[];
    target: string;
    text: string;
    busy: boolean;
    claude: boolean | null;
    error: string;
    confirm: { phrase: string; value: string } | null;
    onText(value: string): void;
    onTarget(id: string): void;
    onAsk(): void;
    onNote(): void;
    onNotes(): void;
    onConfirm(value: string): void;
    onConfirmSubmit(): void;
    onConfirmCancel(): void;
    onSuggestion(entry: Entry & { type: "watch" }, s: Suggestion): void;
    onNoteCard(entry: Entry & { type: "watch" }): void;
    onClose(): void;
    onKeyDown(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; preventDefault(): void; stopPropagation(): void }): void;
  }

  const sentText = (sent: Sent, label?: string): string =>
    sent.notes !== undefined ? `${sent.notes} ${sent.notes === 1 ? "nota" : "notas"}, ${sent.chars} caracteres` : `${sent.lines ?? 0} linhas de ${label ?? "terminal"}, ${sent.chars} caracteres`;

  function seal(h: PanelUi["h"], source: "local" | "claude", detail?: string): ReactNode {
    return source === "local"
      ? h("span", { "data-seal": "local", className: "shrink-0 border border-border px-1 t-meta text-muted-foreground", title: "Processado nesta máquina; nada saiu dela" }, "local")
      : h("span", { "data-seal": "claude", className: "shrink-0 border border-warn px-1 t-meta text-warn", title: detail ? `Saiu da máquina pelo claude -p: ${detail}` : "Saiu da máquina pelo claude -p" }, "saiu da máquina · claude -p");
  }

  function renderEntry(ui: PanelUi, entry: Entry): ReactNode {
    const { h } = ui;
    const head = (label: string, title: string, source: "local" | "claude", detail?: string): ReactNode =>
      h("div", { className: "flex min-w-0 items-center gap-2" },
        h("span", { className: "min-w-0 flex-1 truncate t-label text-foreground", title: label ? `${label} · ${title}` : title }, label ? `${label} · ${title}` : title),
        h("span", { className: "shrink-0 t-meta text-muted-foreground" }, clock(entry.at)),
        seal(h, source, detail));
    const box = (tone: string, ...children: ReactNode[]): ReactNode =>
      h("li", { key: entry.key, "data-entry": entry.type, className: `flex flex-col gap-1 border-b border-l-2 border-border px-3 py-2 ${tone}` }, ...children);
    if (entry.type === "noted") {
      return box("border-l-border", head("", entry.created ? `Nota "${NOTE_TITLE}" criada e anotada` : `Anotado em "${NOTE_TITLE}"`, "local"),
        h("p", { className: "t-meta text-muted-foreground" }, entry.text));
    }
    if (entry.type === "answer" || entry.type === "summary") {
      const detail = sentText(entry.sent, entry.type === "answer" ? entry.label : undefined);
      return box("border-l-warn",
        head(entry.type === "answer" ? entry.label : "", entry.type === "answer" ? "Consulta" : "Resumo das notas conectadas", "claude", detail),
        entry.type === "answer" ? h("p", { className: "t-meta text-muted-foreground" }, `"${entry.question}"`) : null,
        h("p", { className: "whitespace-pre-wrap t-body text-foreground" }, entry.text),
        h("p", { className: "t-meta text-muted-foreground" }, `Enviado ao claude -p: ${detail}.`));
    }
    const c = entry.card;
    const visible = c.suggestions.filter((s) => ui.claude !== false || (s.action !== "ask" && s.action !== "notes"));
    return box(KIND_TONE[c.kind] ?? "border-l-border",
      head(entry.label, c.title, "local"),
      // a pergunta ou a permissão detectada já é o resumo, em destaque: a frase não se repete acima dela
      c.question || c.permission ? null : h("p", { className: "t-body text-foreground" }, c.summary),
      c.question || c.permission ? h("p", { "data-detected": c.permission ? "permission" : "question", className: "border border-warn/60 bg-warn/10 px-2 py-1 t-meta text-foreground" }, c.permission ?? c.question) : null,
      c.steps.length ? h("ul", { className: "flex flex-col t-meta text-muted-foreground" }, ...c.steps.map((s, i) => h("li", { key: String(i), className: "truncate", title: s }, `⏺ ${s}`))) : null,
      c.preview.length ? h("pre", { "aria-label": `Prévia do terminal ${entry.label}`, className: "max-h-40 overflow-auto border border-border bg-muted/40 p-2 font-mono text-[11px] leading-tight text-foreground scrollbar-thin" }, c.preview.join("\n")) : null,
      h("div", { className: "flex flex-wrap gap-1" },
        ...visible.map((s) => h("button", { key: s.action + s.label, type: "button", onClick: () => ui.onSuggestion(entry, s), disabled: ui.busy, className: `${BUTTON} text-muted-foreground` }, s.label)),
        h("button", { key: "anotar-cartao", type: "button", onClick: () => ui.onNoteCard(entry), disabled: ui.busy, className: `${BUTTON} text-muted-foreground`, title: `Acrescenta o resumo em "${NOTE_TITLE}"` }, "Anotar este cartão")));
  }

  /** Árvore do painel: pura, sem hooks, para o teste ler sem DOM. */
  function renderPanel(ui: PanelUi): ReactNode {
    const { h } = ui;
    const claudeOff = ui.claude === false;
    return h("section", {
      role: "dialog", "aria-label": "Supervisor", "data-supervisor": "panel", onKeyDown: ui.onKeyDown, ...SHIELD,
      className: "absolute top-14 right-2 z-30 flex max-h-[calc(100%-5rem)] w-[min(27rem,calc(100%-1rem))] flex-col elev-float bg-background",
    },
    h("header", { className: "flex items-center gap-2 border-b border-border px-3 py-2" },
      h("span", { className: "t-label-em text-foreground" }, "Supervisor"),
      h("span", { className: "min-w-0 flex-1 truncate t-meta text-muted-foreground" }, "só lê, resume e anota"),
      h("button", { type: "button", "aria-label": "Fechar o supervisor", onClick: ui.onClose, className: `${BUTTON} border-transparent text-muted-foreground max-md:min-w-11` },
        h("span", { "aria-hidden": "true", className: "text-base leading-none" }, "×"))),
    ui.entries.length === 0
      ? h("p", { className: "px-3 py-4 t-meta text-muted-foreground" }, "Nada por enquanto. Quando um terminal terminar ou parar esperando você, o resumo aparece aqui.")
      : h("ul", { role: "list", "aria-live": "polite", className: "flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-thin" }, ...ui.entries.map((e) => renderEntry(ui, e))),
    h("form", { className: "flex flex-col gap-2 border-t border-border px-3 py-2", onSubmit: (e: { preventDefault(): void }) => { e.preventDefault(); ui.onAsk(); } },
      ui.confirm ? h("div", { "data-confirm": "remote", className: "flex flex-col gap-1 border border-warn px-2 py-1" },
        h("span", { className: "t-meta text-foreground" }, `Acesso remoto: digite "${ui.confirm.phrase}" para confirmar o envio ao claude -p (o dono recebe um aviso).`),
        h("div", { className: "flex gap-1" },
          h("input", { "aria-label": "Confirmação", value: ui.confirm.value, onInput: (e: { target: { value: string } }) => ui.onConfirm(e.target.value), onChange: (e: { target: { value: string } }) => ui.onConfirm(e.target.value), className: `min-w-0 flex-1 border border-border bg-background px-2 t-body ${FOCUS_RING}` }),
          h("button", { type: "button", onClick: ui.onConfirmSubmit, disabled: ui.confirm.value !== ui.confirm.phrase, className: `${BUTTON} text-foreground` }, "Confirmar"),
          h("button", { type: "button", onClick: ui.onConfirmCancel, className: `${BUTTON} text-muted-foreground` }, "Cancelar"))) : null,
      h("div", { className: "flex items-center gap-2" },
        h("label", { className: "t-meta text-muted-foreground", htmlFor: "supervisor-target" }, "Terminal"),
        h("select", { id: "supervisor-target", value: ui.target, onChange: (e: { target: { value: string } }) => ui.onTarget(e.target.value), className: `min-w-0 flex-1 border border-border bg-background px-1 t-meta ${FOCUS_RING}` },
          h("option", { value: "" }, ui.terminals.length ? "pelo nome na pergunta" : "nenhum terminal no canvas"),
          ...ui.terminals.map((t) => h("option", { key: t.id, value: t.id }, t.label)))),
      h("textarea", {
        "aria-label": "Pergunta ou anotação", rows: 2, value: ui.text, placeholder: 'Ex.: "veja o que o revisor está fazendo", "anota que o rate limit foi resolvido", "resume as notas"',
        onInput: (e: { target: { value: string } }) => ui.onText(e.target.value), onChange: (e: { target: { value: string } }) => ui.onText(e.target.value),
        className: `w-full resize-none border border-border bg-background px-2 py-1 t-body ${FOCUS_RING}`,
      }),
      h("div", { className: "flex flex-wrap items-center gap-1" },
        h("button", { type: "submit", disabled: ui.busy || claudeOff || !ui.text.trim(), className: `${BUTTON} text-foreground` }, ui.busy ? "Consultando…" : "Perguntar"),
        h("button", { type: "button", onClick: ui.onNote, disabled: ui.busy || !ui.text.trim(), className: `${BUTTON} text-foreground` }, "Anotar"),
        h("button", { type: "button", onClick: ui.onNotes, disabled: ui.busy || claudeOff, className: `${BUTTON} text-foreground` }, "Resumir notas")),
      h("p", { "data-seal-note": claudeOff ? "off" : "on", className: "t-meta text-muted-foreground" }, claudeOff
        ? CLAUDE_OFF_MESSAGE
        : "Perguntar e Resumir notas mandam ao claude -p só a pergunta e as últimas linhas do terminal, ou o texto das notas conectadas: esse texto sai da máquina. Os cartões automáticos e as anotações são locais."),
      ui.error ? h("p", { role: "alert", className: "t-meta text-bad" }, ui.error) : null));
  }

  /** Aviso discreto com o painel fechado: quantos cartões chegaram desde a última vez aberto. */
  function renderPill(h: ReactApi["createElement"], unread: number, onOpen: () => void): ReactNode {
    return h("button", {
      type: "button", "data-supervisor": "pill", onClick: onOpen, ...SHIELD,
      className: `${BUTTON} elev-float absolute bottom-12 left-2 z-20 max-md:bottom-[4.5rem] bg-background text-foreground`, title: "Abrir o supervisor (Ctrl+Shift+O)",
    }, `Supervisor · ${unread} ${unread === 1 ? "novo" : "novos"}`);
  }

  // ---- componente ----

  function SupervisorLayer(props: SupervisorLayerProps): ReactNode {
    const now = props.now ?? Date.now;
    const client = React.useMemo(() => createSupervisorClient(props.fetch), [props.fetch]);
    const [entries, setEntries] = React.useState<Entry[]>([]);
    const [unread, setUnread] = React.useState(0);
    const [text, setText] = React.useState("");
    const [target, setTarget] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [claude, setClaude] = React.useState<boolean | null>(null);
    const [error, setError] = React.useState("");
    const [confirm, setConfirm] = React.useState<{ phrase: string; value: string; retry: (phrase: string) => void } | null>(null);
    const seq = React.useRef(0);
    const live = React.useRef(props);
    live.current = props;
    const openRef = React.useRef(props.open);
    openRef.current = props.open;

    const push = (entry: Omit<Entry, "key" | "at">): void => {
      seq.current += 1;
      const full = { ...entry, key: `e${seq.current}`, at: now() } as Entry;
      setEntries((list) => [full, ...list].slice(0, ENTRIES_MAX));
      if (!openRef.current && entry.type === "watch") setUnread((n) => n + 1);
    };

    React.useEffect(() => {
      let alive = true;
      client.status().then((r) => { if (alive) setClaude(r.ok ? r.claude : null); }).catch(() => undefined);
      return () => { alive = false; };
    }, [client, props.open]);

    const monitorRef = React.useRef<ReturnType<typeof createMonitor> | null>(null);
    React.useEffect(() => {
      const monitor = createMonitor({ host: props.host, client, onCard: (c) => push({ type: "watch", ...c }), onError: (m) => console.warn("supervisor:", m) });
      monitorRef.current = monitor;
      monitor.setTerminals(live.current.terminals);
      return () => { monitor.destroy(); monitorRef.current = null; };
    }, [props.host, client]);
    const terminalsKey = props.terminals.map((t) => `${t.id}\0${t.label}`).join("\n");
    React.useEffect(() => { monitorRef.current?.setTerminals(live.current.terminals); }, [terminalsKey]);
    React.useEffect(() => { if (props.open) setUnread(0); }, [props.open]);

    const labelOf = (id: string): string => props.terminals.find((t) => t.id === id)?.label ?? id;
    const needConfirm = (r: { code: string; phrase?: string }, retry: (phrase: string) => void): boolean => {
      if (r.code !== "confirm-required" || !r.phrase) return false;
      setConfirm({ phrase: r.phrase, value: "", retry });
      return true;
    };

    async function ask(question: string, id: string, confirmPhrase?: string): Promise<void> {
      const t = props.host.target(id);
      if (!t) { setError("Esse terminal não tem pane do herdr."); return; }
      setBusy(true);
      setError("");
      try {
        const r = await client.ask({ ...t, name: labelOf(id), question, ...(confirmPhrase ? { confirm: confirmPhrase } : {}) });
        if (r.ok) { push({ type: "answer", id, label: labelOf(id), question, text: r.answer, sent: r.sent }); setText(""); }
        else if (!needConfirm(r, (p) => void ask(question, id, p))) setError(r.message);
      } finally {
        setBusy(false);
      }
    }
    // fromText: o pedido veio do campo ("resume as notas"); só então o campo se limpa no sucesso
    async function summarize(fromText: boolean, confirmPhrase?: string): Promise<void> {
      setBusy(true);
      setError("");
      try {
        const r = await client.notes({ canvas: props.canvasId, ...(confirmPhrase ? { confirm: confirmPhrase } : {}) });
        if (r.ok) { push({ type: "summary", text: r.summary, sent: r.sent }); if (fromText) setText(""); }
        else if (!needConfirm(r, (p) => void summarize(fromText, p))) setError(r.message);
      } finally {
        setBusy(false);
      }
    }
    async function note(entryText: string): Promise<void> {
      if (!entryText.trim()) return;
      setBusy(true);
      setError("");
      try {
        const p = live.current;
        const r = await annotate({ client, docNow: () => live.current.doc, commit: p.commit, center: p.center, text: entryText, at: new Date(now()) });
        if (r.ok) { push({ type: "noted", text: entryText.trim(), created: r.created }); setText(""); }
        else setError(r.message || "não consegui anotar");
      } finally {
        setBusy(false);
      }
    }

    const run = (kind: "ask" | "note" | "notes"): void => {
      const parsed = parseCommand(text);
      const k = kind === "ask" ? parsed.kind : kind;
      if (k === "note") { void note(parsed.kind === "note" ? parsed.text : text); return; }
      if (claude === false) { setError(CLAUDE_OFF_MESSAGE); return; }
      if (k === "notes") { void summarize(kind === "ask"); return; }
      const id = pickTerminal(parsed.text, props.terminals) ?? (target || (props.terminals.length === 1 ? (props.terminals[0] as SupervisorTerminal).id : ""));
      if (!id) { setError("Diga qual terminal (pelo nome na pergunta ou na lista)."); return; }
      void ask(parsed.text, id);
    };

    if (!props.open) return unread > 0 ? renderPill(React.createElement, unread, props.onOpen) : null;
    return renderPanel({
      h: React.createElement, entries, terminals: props.terminals, target, text, busy, claude, error,
      confirm: confirm ? { phrase: confirm.phrase, value: confirm.value } : null,
      onText: setText, onTarget: setTarget,
      onAsk: () => run("ask"), onNote: () => run("note"), onNotes: () => run("notes"),
      onConfirm: (value) => setConfirm((c) => (c ? { ...c, value } : c)),
      onConfirmSubmit: () => { if (confirm && confirm.value === confirm.phrase) { const { retry, phrase } = confirm; setConfirm(null); retry(phrase); } },
      onConfirmCancel: () => setConfirm(null),
      onSuggestion: (entry, s) => {
        if (s.action === "jump") props.onJump(entry.id);
        else if (s.action === "ask") { setTarget(entry.id); setText(`o que ${entry.label} está fazendo e o que falta?`); }
        else if (s.action === "note") setText(`anota que ${entry.label}: `);
        else void summarize(false);
      },
      onNoteCard: (entry) => void note(`${entry.label}: ${entry.card.summary}`),
      onClose: props.onClose,
      onKeyDown: (event) => {
        // o painel é uma ilha: as teclas não chegam aos atalhos do canvas; Esc e o próprio atalho fecham
        event.stopPropagation();
        const toggle = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "o";
        if (event.key === "Escape" || toggle) { event.preventDefault(); props.onClose(); }
      },
    });
  }

  return {
    SupervisorLayer, createMonitor, createSupervisorClient, annotate, transitionOf, parseCommand, pickTerminal, entryLine, appendEntry,
    supervisorNode, freeNodeId, renderPanel, renderPill, SUPERVISOR_NOTE, NOTE_TITLE,
  };
}

type ArgosSupervisorApi = ReturnType<typeof makeArgosSupervisor>;
(globalThis as unknown as { ArgosSupervisor: ArgosSupervisorApi }).ArgosSupervisor = makeArgosSupervisor();
export type { ArgosSupervisorApi, SupervisorHost, SupervisorLayerProps, SupervisorTerminal };
