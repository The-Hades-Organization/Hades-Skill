/* Compositor flutuante do canvas do Argos (reference/argos.md §Compositor): escreve o prompt do terminal em foco sem
 * digitar dentro dele. Flutua sobre o terminal e acompanha o foco de um para outro; Return envia (texto e Enter pelo
 * `sendInput`, a fila do host dos terminais), Shift+Return quebra a linha, Esc fecha guardando o rascunho. Menção `@`
 * (terminal conectado, nota, Arquivo…, orquestrador, Nova nota), `@#` abre o seletor de arquivos do diretório do terminal
 * (GET /api/argos/terminal-files), anexo por colar, arrastar ou clipe (POST /api/argos/compose/attachment; o caminho entra
 * na posição do cursor), colagem grande vira pílula numerada. Com o campo vazio, setas, Return e Tab vão ao terminal e `/`
 * passa o teclado a ele. O modelo (rascunho, pílulas, menções, texto final) é o src/lib/canvas-compose.ts; aqui só se
 * desenha e coleta. Script clássico: registra window.ArgosCanvasComposer; depende de React e de window.CanvasModel.compose. */
import type * as ComposeModule from "../../../../src/lib/canvas-compose.ts";
import type * as CameraModule from "../../../../src/lib/canvas-camera.ts";
import type { Camera, Rect, Viewport } from "../../../../src/lib/canvas-camera.ts";
import type { FetchLike } from "./node-permission.tsx";

interface ComposerTerminal {
  /** id do nó no canvas (a chave do rascunho e das arestas) */
  id: string;
  label: string;
  /** o terminal tem o papel de orquestrador ligado: `@orquestrador` aparece no menu */
  orchestrator?: boolean;
  /** alvo no herdr: o seletor de arquivos lê o diretório deste pane */
  session: string;
  pane: string;
}

interface TtyInput {
  text?: string;
  keys?: string[];
}

interface CanvasComposerProps {
  terminal: ComposerTerminal;
  /** Retângulo do terminal na tela (pixels do canvas) e o tamanho da tela. */
  anchor: Rect;
  view: Viewport;
  drafts: ComposeModule.ComposerDrafts;
  onDrafts(next: ComposeModule.ComposerDrafts): void;
  doc: Parameters<typeof ComposeModule.composerMessage>[1] & Parameters<typeof ComposeModule.connectedIds>[0];
  /** Terminais do canvas (o menu mostra só os ligados a este por aresta). */
  terminals: readonly { id: string; label: string }[];
  /** Entrada do terminal: a do host dos terminais (`host.input`). */
  sendInput(id: string, input: TtyInput): void | Promise<void>;
  /** fetch com o token do painel */
  fetch: FetchLike;
  /** `/` com o campo vazio: o teclado vai ao terminal, para o menu de comandos da CLI. */
  onFocusTerminal?(id: string): void;
  onClose(): void;
  onSent?(terminal: ComposerTerminal): void;
}

/** O que o invólucro lê do motor do canvas (o `canvasApi` da página). */
interface ComposerFrameApi {
  getCamera(): Camera;
  viewport(): Viewport;
  onFrame(listener: () => void): () => void;
}

/** Props do invólucro: em vez da posição na tela, o retângulo do terminal no mundo (documento); ele acompanha pan e zoom. */
interface CanvasComposerLayerProps extends Omit<CanvasComposerProps, "anchor" | "view"> {
  api: ComposerFrameApi;
  rect: Rect;
}

type FileEntry = { path: string; name: string; type: "dir" | "file" };
type Picker = { dir: string; entries: FileEntry[]; truncated: boolean; loading: boolean; error: string };
type Status = { kind: "idle" } | { kind: "busy"; text: string } | { kind: "error"; text: string };

const FILES_URL = "/api/argos/terminal-files";
const ATTACHMENT_URL = "/api/argos/compose/attachment";
const COMPOSER_SIZE: Viewport = { w: 520, h: 184 };
const MIN_W = 320;
const EDGE_PX = 8;
const FILES_DEBOUNCE_MS = 150;
const FILES_TIMEOUT_MS = 10_000;
const ATTACH_TIMEOUT_MS = 60_000;
// o servidor recusa acima disso (canvas-files.ts FILES_LIMITS.attachmentBytes): conferido antes de ler o arquivo
const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
// colagem com envelope (bracketed paste): o texto de várias linhas chega à CLI como colagem, não como Enter a cada linha
const PASTE_OPEN = "\u001b[200~";
const PASTE_CLOSE = "\u001b[201~";
/** Atalho que abre e fecha o compositor (o registro de comandos da página usa este texto). */
const COMPOSER_SHORTCUT = "mod+alt+p";
/** Teclas que vão ao terminal com o campo vazio, no nome do contrato do `POST /api/herdr/input`. */
const FORWARD_KEYS: Readonly<Record<string, string>> = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Enter: "Enter", Tab: "Tab" };

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

/** Sobre a parte de baixo do terminal, da largura dele (entre MIN_W e o tamanho padrão), sempre inteiro dentro da tela. */
function placeComposer(anchor: Rect, view: Viewport, size: Viewport = COMPOSER_SIZE): { x: number; y: number; w: number } {
  const w = Math.round(clamp(anchor.w - 2 * EDGE_PX, MIN_W, size.w));
  const x = clamp(anchor.x + (anchor.w - w) / 2, EDGE_PX, view.w - w - EDGE_PX);
  const y = clamp(anchor.y + anchor.h - size.h - EDGE_PX, EDGE_PX, view.h - size.h - EDGE_PX);
  return { x: Math.round(x), y: Math.round(y), w };
}

/** O compositor aberto segue o terminal que ganhou o foco; sem foco em terminal, fica no que estava. */
const followTarget = (current: string | null, focused: string | null): string | null => focused ?? current;

/** Tecla que vai ao terminal com o campo vazio; `null` se o compositor a trata. */
function forwardOf(event: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }, empty: boolean): TtyInput | null {
  if (!empty || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === "/") return { text: "/" };
  if (event.key === "Tab" && event.shiftKey) return { keys: ["Shift+Tab"] };
  if (event.shiftKey) return null;
  const named = Object.hasOwn(FORWARD_KEYS, event.key) ? FORWARD_KEYS[event.key] : undefined;
  return named === undefined ? null : { keys: [named] };
}

/** Texto que sai pelo `sendInput`: o de várias linhas vai como colagem, e o Enter no fim envia. */
const outgoingInput = (message: string): TtyInput => ({ text: message.includes("\n") ? `${PASTE_OPEN}${message}${PASTE_CLOSE}` : message, keys: ["Enter"] });

/** Tecla de uma composição (tecla morta, IME): o campo a trata; Enter, Esc e Tab dela não enviam, fecham nem escolhem. */
const isComposing = (e: { isComposing?: boolean; keyCode?: number; key: string }): boolean =>
  e.isComposing === true || e.keyCode === 229 || e.key === "Process" || e.key === "Dead";

const isShortcut = (e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): boolean =>
  !!e.shiftKey && !!(e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p";

const filesUrl = (t: ComposerTerminal, dir: string, query: string): string =>
  `${FILES_URL}?session=${encodeURIComponent(t.session)}&pane=${encodeURIComponent(t.pane)}&path=${encodeURIComponent(dir)}&q=${encodeURIComponent(query)}`;

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Resposta do seletor validada; `null` se não tem a forma combinada com a rota. */
function readFiles(body: unknown): { entries: FileEntry[]; truncated: boolean } | null {
  if (!isDict(body) || !Array.isArray(body.entries)) return null;
  const entries: FileEntry[] = [];
  for (const e of body.entries) {
    if (isDict(e) && typeof e.path === "string" && typeof e.name === "string" && (e.type === "dir" || e.type === "file")) entries.push({ path: e.path, name: e.name, type: e.type });
  }
  return { entries, truncated: body.truncated === true };
}

const errorOf = (body: unknown, fallback: string): string => (isDict(body) && typeof body.error === "string" ? body.error : fallback);

/** Base64 de um arquivo do navegador (sem o prefixo `data:`). */
function base64Of(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      if (comma < 0) reject(new Error("leitura do arquivo sem dados"));
      else resolve(url.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("leitura do arquivo falhou"));
    reader.readAsDataURL(file);
  });
}

function makeArgosCanvasComposer() {
  const g = globalThis as unknown as { CanvasModel?: { compose: typeof ComposeModule; camera: typeof CameraModule } };
  if (!g.CanvasModel?.compose?.composerMessage || !g.CanvasModel.camera) throw new Error("ArgosCanvasComposer: carregue /ui/lib/canvas-model.js (com `compose` e `camera`) antes de canvas-composer.js");
  const C = g.CanvasModel.compose;
  const CAM = g.CanvasModel.camera;

  /** Retângulo do terminal na tela a partir do retângulo no mundo e da câmera. */
  const screenRect = (cam: Camera, rect: Rect): Rect => {
    const origin = CAM.worldToScreen(cam, rect);
    return { x: origin.x, y: origin.y, w: rect.w * cam.k, h: rect.h * cam.k };
  };

  /** O que o menu de menção oferece para este terminal: terminais ligados por aresta, as notas, e o papel. */
  function mentionSources(doc: CanvasComposerProps["doc"], terminal: ComposerTerminal, terminals: CanvasComposerProps["terminals"]): ComposeModule.MentionSources {
    const linked = new Set(C.connectedIds(doc, terminal.id));
    return {
      terminals: terminals.filter((t) => t.id !== terminal.id && linked.has(t.id)),
      notes: doc.nodes.filter((n) => n.type === "note").map((n) => ({ id: n.id, title: C.noteTitle(n) })),
      drawings: doc.nodes.filter((n) => n.type === "drawing").map((n) => ({ id: n.id, title: C.drawingTitle(n) })),
      orchestrator: terminal.orchestrator === true,
    };
  }

  /** Erro do modelo como texto para o dono: pelo código, nunca pela mensagem. */
  function modelErrorText(error: unknown): string {
    const code = error instanceof C.ComposeError || error instanceof C.ComposerError ? error.code : "";
    const TEXT: Readonly<Record<string, string>> = {
      [C.COMPOSE_ERRORS.tooLong]: "Mensagem longa demais para o terminal.",
      [C.COMPOSE_ERRORS.emptyMessage]: "Escreva a mensagem antes de enviar.",
      [C.COMPOSE_ERRORS.tooManyDrafts]: "Rascunhos demais guardados: envie ou apague algum.",
      [C.COMPOSE_ERRORS.tooManyReferences]: "Referências @ demais na mensagem.",
      [C.COMPOSE_ERRORS.referenceTooLong]: "A nota citada é longa demais para ir na mensagem.",
      [C.COMPOSER_ERRORS.tooManyPastes]: "Colagens demais neste rascunho.",
      [C.COMPOSER_ERRORS.pasteTooLong]: "Colagem grande demais.",
      [C.COMPOSER_ERRORS.invalidTerminal]: "Terminal inválido.",
    };
    return TEXT[code] ?? (error instanceof Error ? error.message : "Não deu para preparar a mensagem.");
  }

  const BOX = "elev-float absolute z-30 flex flex-col gap-1.5 bg-background p-2 t-body";
  const FIELD_TEXT = "w-full whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-sm leading-5";
  const BTN = "inline-flex min-h-8 cursor-pointer items-center justify-center border border-border-strong px-2 t-label outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40 max-md:min-h-11";
  const LIST = "absolute bottom-full left-0 mb-1 max-h-56 w-full overflow-y-auto border border-border-strong bg-background p-1 t-body";
  const OPTION = "flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left";

  interface MenuItem {
    key: string;
    label: string;
    hint: string;
  }

  interface ComposerUi {
    h: ReactApi["createElement"];
    terminal: ComposerTerminal;
    place: { x: number; y: number; w: number };
    draft: ComposeModule.ComposerDraft;
    pills: ComposeModule.Pill[];
    /** menu aberto: menção ou arquivos */
    menu: { kind: "mention" | "files"; items: MenuItem[]; active: number; note: string } | null;
    status: Status;
    dragging: boolean;
    fieldRef: RefObject<HTMLTextAreaElement | null>;
    mirrorRef: RefObject<HTMLDivElement | null>;
    fileRef: RefObject<HTMLInputElement | null>;
    on: {
      input(e: { target: { value: string; selectionStart: number } }): void;
      keyDown(e: KeyboardEvent): void;
      select(): void;
      click(): void;
      paste(e: ClipboardEvent): void;
      drop(e: DragEvent): void;
      drag(on: boolean, e: DragEvent): void;
      scroll(): void;
      choose(index: number): void;
      clip(): void;
      files(e: { target: { files: FileList | null; value: string } }): void;
      send(): void;
      close(): void;
    };
  }

  /** O fundo do campo: o mesmo texto, transparente, com as pílulas pintadas por baixo das letras do campo. */
  function mirrorKids(h: ComposerUi["h"], text: string, pills: ComposeModule.Pill[]): ReactNode[] {
    const kids: ReactNode[] = [];
    let cursor = 0;
    for (const pill of pills) {
      kids.push(text.slice(cursor, pill.start));
      kids.push(h("mark", { key: `p${pill.n}-${pill.start}`, "data-pill": pill.n, className: "bg-accent text-transparent outline outline-1 outline-border-strong" }, text.slice(pill.start, pill.end)));
      cursor = pill.end;
    }
    kids.push(`${text.slice(cursor)}\n`);
    return kids;
  }

  /** Árvore do compositor: pura, sem hooks, para o teste ler sem DOM. */
  function renderComposer(ui: ComposerUi): ReactNode {
    const { h, menu, status } = ui;
    const busy = status.kind === "busy";
    const listId = `composer-list-${ui.terminal.id}`;
    return h("div", {
      role: "dialog", "aria-label": `Compositor de ${ui.terminal.label}`, "aria-modal": "false", "data-composer": ui.terminal.id,
      className: `${BOX}${ui.dragging ? " outline-2 outline-dashed outline-ring" : ""}`, style: { left: ui.place.x, top: ui.place.y, width: ui.place.w },
      onDragOver: (e: DragEvent) => ui.on.drag(true, e), onDragLeave: (e: DragEvent) => ui.on.drag(false, e), onDrop: ui.on.drop,
    },
      h("div", { className: "flex items-center gap-2 t-meta text-muted-foreground" },
        h("span", { className: "min-w-0 flex-1 truncate" }, "Para ", h("span", { className: "t-data text-foreground" }, ui.terminal.label)),
        h("span", { className: "shrink-0" }, "Return envia · Shift+Return quebra · @ menciona")),
      h("div", { className: "relative" },
        menu ? h("div", { id: listId, role: "listbox", "aria-label": menu.kind === "files" ? "Arquivos do terminal" : "Menções", className: LIST },
          menu.note ? h("div", { role: "status", className: "px-2 py-1 t-meta text-muted-foreground" }, menu.note) : null,
          ...menu.items.map((item, i) => h("div", {
            key: item.key, id: `${listId}-${i}`, role: "option", "aria-selected": i === menu.active,
            className: `${OPTION}${i === menu.active ? " bg-accent" : ""}`, onMouseDown: (e: MouseEvent) => { e.preventDefault(); ui.on.choose(i); },
          }, h("span", { className: "min-w-0 truncate", title: item.label }, item.label), h("span", { className: "min-w-0 flex-1 truncate text-right t-meta text-muted-foreground", title: item.hint }, item.hint)))) : null,
        h("div", { className: "relative max-h-48 min-h-20 overflow-hidden border border-border-strong bg-background" },
          h("div", { ref: ui.mirrorRef, "aria-hidden": "true", className: `${FIELD_TEXT} pointer-events-none absolute inset-0 overflow-hidden text-transparent` }, ...mirrorKids(h, ui.draft.text, ui.pills)),
          h("textarea", {
            ref: ui.fieldRef, value: ui.draft.text, rows: 4, maxLength: C.COMPOSE_LIMITS.draftChars, spellCheck: false,
            "aria-label": `Mensagem para ${ui.terminal.label}`, placeholder: "Prompt para o terminal (vazio: setas, Return e Tab vão ao terminal; / abre os comandos)",
            role: "combobox", "aria-expanded": menu !== null, "aria-controls": menu ? listId : undefined, "aria-activedescendant": menu && menu.items.length > 0 ? `${listId}-${menu.active}` : undefined,
            className: `${FIELD_TEXT} relative block max-h-48 min-h-20 resize-none bg-transparent outline-none focus-visible:outline-2 focus-visible:outline-ring`,
            onChange: ui.on.input, onKeyDown: ui.on.keyDown, onSelect: ui.on.select, onClick: ui.on.click, onPaste: ui.on.paste, onScroll: ui.on.scroll,
          }))),
      h("div", { className: "flex items-center gap-2" },
        h("button", { type: "button", className: BTN, "aria-label": "Anexar arquivo", title: "Anexar (também colar ou arrastar)", disabled: busy, onClick: ui.on.clip }, "📎"),
        h("input", { ref: ui.fileRef, type: "file", multiple: true, hidden: true, tabIndex: -1, "aria-hidden": "true", onChange: ui.on.files }),
        h("span", { role: status.kind === "error" ? "alert" : "status", className: `min-w-0 flex-1 truncate t-meta ${status.kind === "error" ? "text-bad" : "text-muted-foreground"}` },
          status.kind === "idle" ? (ui.pills.length > 0 ? `${ui.pills.length} colagem(ns): clique para editar` : "") : status.text),
        h("button", { type: "button", className: BTN, disabled: busy || ui.draft.text.trim() === "", onClick: ui.on.send }, "Enviar"),
        h("button", { type: "button", className: BTN, onClick: ui.on.close }, "Fechar")));
  }

  function CanvasComposer(props: CanvasComposerProps): ReactNode {
    const { terminal } = props;
    const fieldRef = React.useRef<HTMLTextAreaElement | null>(null);
    const mirrorRef = React.useRef<HTMLDivElement | null>(null);
    const fileRef = React.useRef<HTMLInputElement | null>(null);
    const [caret, setCaret] = React.useState(0);
    const [active, setActive] = React.useState(0);
    const [dismissed, setDismissed] = React.useState(-1);
    const [picker, setPicker] = React.useState<Picker>({ dir: "", entries: [], truncated: false, loading: false, error: "" });
    const [status, setStatus] = React.useState<Status>({ kind: "idle" });
    const [dragging, setDragging] = React.useState(false);
    const live = React.useRef({ props, caret });
    live.current = { props, caret };
    const draft = C.getComposerDraft(props.drafts, terminal.id);
    const pills = C.findPills(draft);
    const mention = C.mentionAt(draft.text, caret);
    const mentionOpen = mention !== null && mention.start !== dismissed;

    // quem abriu recebe o foco de volta quando o compositor fecha
    React.useEffect(() => {
      const opener = typeof document === "undefined" ? null : (document.activeElement as { focus?: () => void; isConnected?: boolean } | null);
      return () => { if (opener?.isConnected && typeof opener.focus === "function") opener.focus(); };
    }, []);
    // outro terminal (o foco mudou): o campo recebe o foco com o cursor no fim do rascunho dele
    React.useEffect(() => {
      const el = fieldRef.current;
      setStatus({ kind: "idle" });
      setDismissed(-1);
      if (!el) return;
      el.focus({ preventScroll: true });
      const end = el.value.length;
      el.setSelectionRange(end, end);
      setCaret(end);
    }, [terminal.id]);
    // seletor de arquivos: lista ou busca no diretório do terminal, com espera curta entre teclas e o pedido anterior cancelado
    const filesQuery = mentionOpen && mention.files ? mention.query : null;
    React.useEffect(() => {
      // fora do seletor, a próxima abertura começa na raiz do terminal
      if (filesQuery === null) { setPicker((p) => (p.dir === "" ? p : { ...p, dir: "" })); return undefined; }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FILES_DEBOUNCE_MS + FILES_TIMEOUT_MS);
      setPicker((p) => ({ ...p, loading: true, error: "" }));
      const timer = setTimeout(() => {
        props.fetch(filesUrl(terminal, picker.dir, filesQuery), { method: "GET", headers: {}, signal: controller.signal })
          .then(async (res) => {
            const body: unknown = await res.json();
            const files = res.ok ? readFiles(body) : null;
            if (controller.signal.aborted) return;
            setPicker((p) => (files ? { ...p, ...files, loading: false, error: "" } : { ...p, entries: [], loading: false, error: errorOf(body, "Não deu para listar os arquivos.") }));
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            setPicker((p) => ({ ...p, entries: [], loading: false, error: error instanceof Error ? error.message : "Não deu para listar os arquivos." }));
          });
      }, FILES_DEBOUNCE_MS);
      return () => { clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
    }, [filesQuery, picker.dir, terminal.id]);

    const save = (next: ComposeModule.ComposerDraft, at: number, selectFrom: number = at): void => {
      try {
        live.current.props.onDrafts(C.setComposerDraft(live.current.props.drafts, terminal.id, next));
        setCaret(at);
        if (status.kind === "error") setStatus({ kind: "idle" });
        // o campo é controlado: o cursor volta ao lugar depois que o React escreve o valor novo
        requestAnimationFrame(() => fieldRef.current?.setSelectionRange(selectFrom, at));
      } catch (error) {
        setStatus({ kind: "error", text: modelErrorText(error) });
      }
    };

    const sources = mentionSources(props.doc, terminal, props.terminals);
    const options = mentionOpen && !mention.files ? C.mentionOptions(mention.query, sources) : [];
    const fileItems: FileEntry[] = mentionOpen && mention.files ? [...(picker.dir !== "" && mention.query === "" ? [{ path: picker.dir.split("/").slice(0, -1).join("/"), name: "..", type: "dir" as const }] : []), ...picker.entries] : [];
    const menu: ComposerUi["menu"] = !mentionOpen ? null : mention.files
      ? {
        kind: "files", active: Math.min(active, Math.max(0, fileItems.length - 1)),
        note: picker.error || (picker.loading ? "Procurando…" : fileItems.length === 0 ? "Nada aqui." : picker.truncated ? "Lista cortada: refine a busca." : ""),
        items: fileItems.map((f) => ({ key: `${f.type}:${f.path}:${f.name}`, label: f.type === "dir" ? `${f.name}/` : f.name, hint: f.name === ".." ? "voltar" : f.path })),
      }
      : options.length === 0 ? null : { kind: "mention", active: Math.min(active, options.length - 1), note: "", items: options.map((o, i) => ({ key: `${o.kind}:${i}`, label: o.label, hint: o.kind === "terminal" ? "terminal" : o.kind === "note" ? "nota" : o.kind === "drawing" ? "desenho" : o.kind === "file" ? "busca no diretório" : "ação" })) };

    const choose = (index: number): void => {
      if (!mention) return;
      if (mention.files) {
        const entry = fileItems[index];
        if (!entry) return;
        if (entry.type === "dir") {
          // pasta: entra nela e limpa a busca (o texto depois de `@#`)
          setPicker((p) => ({ ...p, dir: entry.path }));
          setActive(0);
          const edit = C.replaceRange(draft, mention.start, caret, "@#");
          save(edit.draft, edit.caret);
          return;
        }
        setPicker((p) => ({ ...p, dir: "" }));
        const edit = C.replaceRange(draft, mention.start, caret, `${entry.path} `);
        save(edit.draft, edit.caret);
        return;
      }
      const option = options[index];
      if (!option) return;
      setActive(0);
      // "Arquivo…": a menção vira `@#` e o seletor abre na raiz do terminal
      const edit = C.replaceRange(draft, mention.start, caret, option.insert ?? "@#");
      if (option.insert === null) setPicker((p) => ({ ...p, dir: "" }));
      save(edit.draft, edit.caret);
    };

    const send = (): void => {
      if (status.kind === "busy") return;
      let message: string;
      try {
        message = C.composerMessage(draft, props.doc);
      } catch (error) {
        setStatus({ kind: "error", text: modelErrorText(error) });
        return;
      }
      const sent = draft;
      const done = (): void => {
        // só sai o rascunho que foi enviado: se ele mudou durante o envio, o novo texto continua
        const latest = live.current.props;
        if (C.getComposerDraft(latest.drafts, terminal.id) === sent) latest.onDrafts(C.clearComposerDraft(latest.drafts, terminal.id));
        setCaret(0);
        setStatus({ kind: "idle" });
        props.onSent?.(terminal);
      };
      setStatus({ kind: "busy", text: "Enviando…" });
      Promise.resolve(props.sendInput(terminal.id, outgoingInput(message))).then(done, (error: unknown) => {
        setStatus({ kind: "error", text: error instanceof Error ? error.message : "O terminal não recebeu a mensagem." });
      });
    };

    const attach = async (files: readonly File[]): Promise<void> => {
      for (const file of files) {
        if (file.size > ATTACH_MAX_BYTES) {
          setStatus({ kind: "error", text: `${file.name}: grande demais para anexar.` });
          continue;
        }
        setStatus({ kind: "busy", text: `Anexando ${file.name}…` });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ATTACH_TIMEOUT_MS);
        try {
          const body = JSON.stringify({ name: file.name, type: file.type, data: await base64Of(file) });
          const res = await props.fetch(ATTACHMENT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal });
          const out: unknown = await res.json();
          if (!res.ok || !isDict(out) || typeof out.path !== "string") {
            setStatus({ kind: "error", text: `${file.name}: ${errorOf(out, "não deu para anexar")}.` });
            continue;
          }
          // o caminho entra onde o cursor está agora, no rascunho mais novo
          const latest = C.getComposerDraft(live.current.props.drafts, terminal.id);
          const at = Math.min(live.current.caret, latest.text.length);
          const before = at > 0 && !/\s/.test(latest.text[at - 1] ?? "") ? " " : "";
          const edit = C.replaceRange(latest, at, at, `${before}${out.path} `);
          save(edit.draft, edit.caret);
          setStatus({ kind: "idle" });
        } catch (error) {
          setStatus({ kind: "error", text: `${file.name}: ${error instanceof Error && error.name !== "AbortError" ? error.message : "sem resposta do painel"}.` });
        } finally {
          clearTimeout(timer);
        }
      }
    };
    const attachAll = (list: FileList | null | undefined): void => {
      const files = list ? [...list] : [];
      if (files.length > 0) attach(files).catch((error: unknown) => setStatus({ kind: "error", text: error instanceof Error ? error.message : "Anexo falhou." }));
    };

    const selection = (): { start: number; end: number } => {
      const el = fieldRef.current;
      return el ? { start: el.selectionStart, end: el.selectionEnd } : { start: caret, end: caret };
    };

    const keyDown = (e: KeyboardEvent): void => {
      if (isComposing(e)) return;
      if (isShortcut(e)) { e.preventDefault(); props.onClose(); return; }
      if (menu) {
        const count = menu.items.length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (count > 0) setActive((menu.active + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
          return;
        }
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
          e.preventDefault();
          choose(menu.active);
          return;
        }
        if (e.key === "Escape") { e.preventDefault(); if (mention) setDismissed(mention.start); return; }
      }
      const { start, end } = selection();
      if ((e.key === "Backspace" || e.key === "Delete") && start === end) {
        const edit = C.deletePill(draft, start, e.key === "Backspace" ? "back" : "forward");
        if (edit) { e.preventDefault(); save(edit.draft, edit.caret); return; }
      }
      if (e.key === "Escape") { e.preventDefault(); props.onClose(); return; }
      const forward = forwardOf(e, draft.text === "");
      if (forward) {
        e.preventDefault();
        Promise.resolve(props.sendInput(terminal.id, forward)).catch((error: unknown) => setStatus({ kind: "error", text: error instanceof Error ? error.message : "O terminal não recebeu a tecla." }));
        if (forward.text === "/") props.onFocusTerminal?.(terminal.id);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const pill = C.pillAt(draft, start, end);
        if (pill) {
          const edit = C.expandPill(draft, pill);
          save(edit.draft, edit.caret, edit.selectFrom);
          return;
        }
        send();
      }
    };

    const ui: ComposerUi = {
      h: React.createElement, terminal, place: placeComposer(props.anchor, props.view), draft, pills, menu, status, dragging, fieldRef, mirrorRef, fileRef,
      on: {
        input: (e) => { setActive(0); save({ text: e.target.value, pastes: draft.pastes }, e.target.selectionStart); },
        keyDown,
        select: () => setCaret(selection().end),
        click: () => {
          const { start, end } = selection();
          setCaret(end);
          const pill = start === end ? C.pillAt(draft, start) : null;
          if (pill) {
            const edit = C.expandPill(draft, pill);
            save(edit.draft, edit.caret, edit.selectFrom);
          }
        },
        paste: (e) => {
          const files = e.clipboardData?.files;
          if (files && files.length > 0) { e.preventDefault(); attachAll(files); return; }
          const text = e.clipboardData?.getData("text/plain") ?? "";
          if (!C.isLargePaste(text)) return;
          e.preventDefault();
          const { start, end } = selection();
          try {
            const edit = C.insertPaste(draft, start, end, text);
            save(edit.draft, edit.caret);
          } catch (error) {
            setStatus({ kind: "error", text: modelErrorText(error) });
          }
        },
        drop: (e) => { e.preventDefault(); setDragging(false); attachAll(e.dataTransfer?.files); },
        drag: (on, e) => { e.preventDefault(); setDragging(on); },
        scroll: () => { if (mirrorRef.current && fieldRef.current) mirrorRef.current.scrollTop = fieldRef.current.scrollTop; },
        choose,
        clip: () => fileRef.current?.click(),
        files: (e) => { attachAll(e.target.files); e.target.value = ""; },
        send,
        close: props.onClose,
      },
    };
    return renderComposer(ui);
  }

  /** O compositor montado sobre o motor: lê câmera e tela a cada quadro desenhado (o ouvinte sai com o componente). */
  function CanvasComposerLayer(props: CanvasComposerLayerProps): ReactNode {
    const { api, rect, ...rest } = props;
    const [frame, setFrame] = React.useState<{ camera: Camera; view: Viewport } | null>(null);
    React.useEffect(() => {
      const read = (): void => {
        const camera = api.getCamera();
        const view = api.viewport();
        setFrame((cur) => (cur && cur.camera.x === camera.x && cur.camera.y === camera.y && cur.camera.k === camera.k && cur.view.w === view.w && cur.view.h === view.h ? cur : { camera, view }));
      };
      read();
      return api.onFrame(read);
    }, [api]);
    if (!frame || frame.view.w <= 0 || frame.view.h <= 0) return null;
    return React.createElement(CanvasComposer, { ...rest, anchor: screenRect(frame.camera, rect), view: frame.view });
  }

  return { CanvasComposer, CanvasComposerLayer, screenRect, renderComposer, mentionSources, modelErrorText, placeComposer, followTarget, forwardOf, isComposing, outgoingInput, filesUrl, readFiles, isShortcut, COMPOSER_SHORTCUT, COMPOSER_SIZE };
}

type ArgosCanvasComposerApi = ReturnType<typeof makeArgosCanvasComposer>;
(globalThis as unknown as { ArgosCanvasComposer: ArgosCanvasComposerApi }).ArgosCanvasComposer = makeArgosCanvasComposer();
export type { ArgosCanvasComposerApi, CanvasComposerLayerProps, CanvasComposerProps, ComposerTerminal, TtyInput };
