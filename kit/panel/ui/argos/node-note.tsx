/* Nota do canvas do Argos (reference/argos.md §Notas): cabeçalho com o nome (fixado pelo dono ou o da primeira linha),
 * cadeado, barra Raw/Formatada e menu; corpo em Markdown (`marked` do vendor/) com tabelas reais e diagramas mermaid
 * (vendor/mermaid.js, carregado só quando a nota formatada tem um bloco ```mermaid); imagem colada vira arquivo ao lado
 * da nota. Script clássico: registra window.ArgosNodeNote; types-user.tsx o usa para desenhar o nó `note`. A regra (nome,
 * tabela, imagem) mora em src/lib/canvas-note.ts; aqui só se desenha, coleta e chama a rota pelo cliente que vem de fora.
 * Nada aqui mexe no documento do canvas: bloquear, renomear e mover são da nota (rota), não do nó. */
import type * as NoteModule from "../../../../src/lib/canvas-note.ts";

type NoteModel = typeof NoteModule;
type Child = ReactNode;
type Tree = ReactElement;

/** O que o `marked` do vendor/ expõe e que a nota usa (a classe permite uma instância com renderer próprio). */
interface MarkedLib {
  Marked: new (...options: object[]) => { parse(src: string): string | Promise<string> };
}

interface MermaidLib {
  initialize(config: object): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

/** Resultado de uma chamada do cliente: nunca rejeita, a falha vem como código. */
type Result<T> = ({ ok: true } & T) | { ok: false; code: string };

export interface NoteMeta {
  locked: boolean;
  title: string | null;
  location: "default" | "custom";
  path: string | null;
  /** Nome do arquivo sem extensão: dá nome à pasta das imagens. */
  base: string;
}

/** O cliente da rota que types-user.tsx monta (fetch com token, prazo e códigos). */
export interface NoteActions {
  meta(name: string): Promise<Result<{ meta: NoteMeta }>>;
  lock(name: string, locked: boolean): Promise<Result<{ locked: boolean }>>;
  rename(name: string, title: string | null): Promise<Result<{ title: string | null }>>;
  move(name: string, to: string | null): Promise<Result<{ location: string; path: string | null }>>;
  image(name: string, base64: string): Promise<Result<{ markdown: string }>>;
}

/** Canto do menu no clique, empurrado para dentro da tela (margem de 8 px) quando passaria da borda. */
function menuPlacement(at: { x: number; y: number }, size: { width: number; height: number }, view: { w: number; h: number }): { x: number; y: number } {
  const MARGIN = 8;
  const x = at.x + size.width + MARGIN > view.w ? Math.max(MARGIN, view.w - size.width - MARGIN) : at.x;
  const y = at.y + size.height + MARGIN > view.h ? Math.max(MARGIN, at.y - size.height) : at.y;
  return { x, y };
}

function makeArgosNodeNote() {
  const h = (type: unknown, props?: Record<string, unknown> | null, ...children: Child[]): Tree => React.createElement(type, props, ...children);

  const MERMAID_URL = "/ui/vendor/mermaid.js";
  const ASSET_URL = "/api/canvas-notes/";
  /** Releitura da nota aberta enquanto ela está na tela, para o texto escrito por um agente aparecer sem recarregar. */
  const REFRESH_MS = 4000;
  /** Gravação automática depois da última tecla. */
  const AUTOSAVE_MS = 1200;
  /** Escala da imagem PNG do diagrama copiado (nitidez em tela densa). */
  const IMAGE_SCALE = 2;

  const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
  const SAFE_LINK = /^(?:https?:|mailto:|#)/i;
  const SAFE_IMAGE = /^https:/i;
  /** Cerca de código fechada no fim do trecho cru: o diagrama só desenha quando quem escreve terminou o bloco. */
  const CLOSED_FENCE = /(?:^|\n) {0,3}(?:`{3,}|~{3,})[ \t]*\n*$/;
  /** A primeira palavra da linha de abertura da cerca diz a linguagem (```mermaid, ```Mermaid title…). */
  const isMermaid = (lang: string | undefined): boolean => (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() === "mermaid";

  interface RenderedNote {
    html: string;
    /** Markdown cru de cada tabela, na ordem do `data-note-table`. */
    tables: string[];
    /** Fonte de cada diagrama, na ordem do `data-note-diagram`; `closed` falso = o bloco ainda está sendo escrito. */
    diagrams: { source: string; closed: boolean }[];
  }

  /**
   * Markdown → HTML que pode ir ao DOM: HTML cru do texto sai escapado (nunca vira elemento), link só http(s)/mailto/âncora,
   * imagem só https ou a pasta de imagens da própria nota (servida pela rota), tabela e diagrama marcados pela ordem.
   */
  function renderNoteHtml(marked: MarkedLib, model: NoteModel, input: { text: string; name: string; base: string }): RenderedNote {
    const tables: string[] = [];
    const diagrams: { source: string; closed: boolean }[] = [];
    let tableAt = 0;
    let diagramAt = 0;
    const instance = new marked.Marked({ gfm: true, breaks: false, async: false }, {
      walkTokens(token: { type: string; raw: string; lang?: string; text?: string }) {
        if (token.type === "table") tables.push(token.raw);
        if (token.type === "code" && isMermaid(token.lang)) diagrams.push({ source: token.text ?? "", closed: CLOSED_FENCE.test(token.raw) });
      },
      renderer: {
        html: (html: string) => escapeHtml(html),
        link(href: string, title: string | null, text: string) {
          if (!SAFE_LINK.test(href)) return text;
          const t = title ? ` title="${escapeHtml(title)}"` : "";
          return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
        },
        image(href: string, title: string | null, text: string) {
          const asset = model.assetOfRef(input.base, href);
          const src = asset !== undefined ? `${ASSET_URL}${encodeURIComponent(input.name)}/assets/${asset}` : SAFE_IMAGE.test(href) ? href : undefined;
          if (src === undefined) return `<span class="note-image-missing">[${escapeHtml(text || "imagem")}]</span>`;
          const t = title ? ` title="${escapeHtml(title)}"` : "";
          return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${t} loading="lazy" referrerpolicy="no-referrer">`;
        },
        code(code: string, lang: string | undefined) {
          if (!isMermaid(lang)) return false;
          const i = diagramAt++;
          return `<div class="note-diagram" data-note-diagram="${i}"><button type="button" class="note-diagram-copy" data-note-copy="${i}" aria-label="Copiar o código do diagrama">Copiar</button><div class="note-diagram-view"><pre><code>${escapeHtml(code)}</code></pre></div></div>`;
        },
        table(header: string, body: string) {
          const i = tableAt++;
          return `<div class="note-table" data-note-table="${i}"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
        },
      },
    });
    const html = instance.parse(input.text);
    if (typeof html !== "string") throw new Error("marked devolveu promessa com async desligado");
    return { html, tables, diagrams };
  }

  /** Tabela do Markdown cru → cabeçalho e linhas (o que as cópias usam): a mesma leitura de colunas do GFM, `\|` incluso. */
  function parseTableRaw(raw: string): NoteModule.NoteTable {
    const split = (line: string): string[] => {
      const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
      return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
    };
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    const [head, , ...rest] = lines;
    return { header: head ? split(head) : [], rows: rest.map(split) };
  }

  // ---- mermaid, preguiçoso ----

  let mermaidLoad: Promise<MermaidLib> | undefined;

  /** Um `<script>` só, na primeira nota que precisa; falha libera uma nova tentativa na próxima. */
  function loadMermaid(doc: Document): Promise<MermaidLib> {
    const ready = (globalThis as unknown as { mermaid?: MermaidLib }).mermaid;
    if (ready) return Promise.resolve(ready);
    mermaidLoad ??= new Promise<MermaidLib>((resolve, reject) => {
      const script = doc.createElement("script");
      script.src = MERMAID_URL;
      script.async = true;
      script.onload = () => {
        const lib = (globalThis as unknown as { mermaid?: MermaidLib }).mermaid;
        if (lib) resolve(lib);
        else reject(new Error("mermaid_missing"));
      };
      script.onerror = () => {
        mermaidLoad = undefined;
        script.remove();
        reject(new Error("mermaid_load"));
      };
      doc.head.appendChild(script);
    });
    return mermaidLoad;
  }

  /** Tema do diagrama pelo tema do painel e a fonte da nota; sem rótulo em HTML (foreignObject impede copiar como imagem). */
  function mermaidConfig(root: HTMLElement): object {
    const dark = root.ownerDocument.documentElement.classList.contains("dark");
    const style = getComputedStyle(root);
    return {
      startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: style.fontFamily,
      htmlLabels: false, flowchart: { htmlLabels: false }, themeVariables: { fontFamily: style.fontFamily, fontSize: style.fontSize },
    };
  }

  let diagramSeq = 0;

  /** Desenha os diagramas fechados dentro de `root`; `alive()` falso no meio = a nota saiu da tela e nada mais é escrito. */
  async function drawDiagrams(root: HTMLElement, rendered: RenderedNote, alive: () => boolean): Promise<void> {
    const targets = [...root.querySelectorAll<HTMLElement>("[data-note-diagram]")];
    if (targets.length === 0 || !rendered.diagrams.some((d) => d.closed)) return;
    let lib: MermaidLib;
    try {
      lib = await loadMermaid(root.ownerDocument);
    } catch {
      for (const el of targets) el.dataset.noteDiagramError = "load";
      return;
    }
    if (!alive()) return;
    lib.initialize(mermaidConfig(root));
    for (const el of targets) {
      const diagram = rendered.diagrams[Number(el.dataset.noteDiagram)];
      if (!diagram?.closed) continue;
      try {
        const { svg } = await lib.render(`note-diagram-${++diagramSeq}`, diagram.source);
        if (!alive()) return;
        // o SVG sai do mermaid com securityLevel "strict" (ele mesmo sanitiza o rótulo); é o único HTML que não é nosso
        const view = el.querySelector<HTMLElement>(".note-diagram-view") ?? el;
        view.innerHTML = svg;
        el.dataset.noteDiagramReady = "1";
      } catch (error) {
        el.dataset.noteDiagramError = error instanceof Error ? error.message.slice(0, 120) : "render";
      }
    }
  }

  /** SVG do diagrama → PNG (fundo da nota, escala 2) na área de transferência. */
  async function copyDiagramImage(el: HTMLElement): Promise<void> {
    const svg = el.querySelector("svg");
    if (!svg) throw new Error("diagram_not_ready");
    const box = svg.getBoundingClientRect();
    const xml = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("diagram_image"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(box.width * IMAGE_SCALE));
      canvas.height = Math.max(1, Math.round(box.height * IMAGE_SCALE));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("diagram_canvas");
      ctx.fillStyle = getComputedStyle(el).backgroundColor || "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("diagram_png"))), "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Cópia com vários formatos de uma vez (HTML, RTF e texto): pelo evento `copy`, que aceita tipos além dos da API assíncrona. */
  function copyFormats(formats: Readonly<Record<string, string>>): boolean {
    const onCopy = (event: ClipboardEvent): void => {
      if (!event.clipboardData) return;
      for (const [type, value] of Object.entries(formats)) event.clipboardData.setData(type, value);
      event.preventDefault();
    };
    document.addEventListener("copy", onCopy);
    try {
      return document.execCommand("copy");
    } finally {
      document.removeEventListener("copy", onCopy);
    }
  }

  function copyText(text: string): Promise<void> {
    return navigator.clipboard.writeText(text);
  }

  // ---- menu da nota (puro: o teste lê a lista) ----

  type MenuTarget = { table?: number; cell?: string; diagram?: number };
  interface MenuItem { id: string; label: string; disabled?: boolean }

  /** Itens do clique direito: os do alvo (tabela, célula, diagrama) primeiro, depois os da nota. */
  function noteMenuItems(target: MenuTarget, state: { locked: boolean; mode: "raw" | "formatted"; diagramReady: boolean }): MenuItem[] {
    const items: MenuItem[] = [];
    if (target.diagram !== undefined) {
      items.push({ id: "copy-diagram-code", label: "Copiar código" }, { id: "copy-diagram-image", label: "Copiar como imagem", disabled: !state.diagramReady });
    }
    if (target.table !== undefined) {
      items.push({ id: "copy-table", label: "Copiar como tabela" }, { id: "copy-table-md", label: "Copiar Markdown" });
      if (target.cell !== undefined) items.push({ id: "copy-cell", label: "Copiar célula" });
    }
    items.push(
      { id: "toggle-mode", label: state.mode === "raw" ? "Ver formatada" : "Editar o Markdown" },
      { id: "rename", label: "Renomear" },
      { id: state.locked ? "unlock" : "lock", label: state.locked ? "Desbloquear conteúdo" : "Bloquear conteúdo" },
      { id: "move", label: "Mover para…" },
    );
    return items;
  }

  /** Modo inicial: formatada se há texto, Raw se a nota está vazia (nasce para escrever). Lembrado por nota na sessão. */
  const modes = new Map<string, "raw" | "formatted">();
  const initialMode = (name: string, text: string): "raw" | "formatted" => modes.get(name) ?? (text.trim() === "" ? "raw" : "formatted");

  /** Arquivo colado (imagem) → base64, sem o prefixo `data:`. */
  function fileToBase64(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : "";
        const comma = url.indexOf(",");
        if (comma < 0) reject(new Error("image_read"));
        else resolve(url.slice(comma + 1));
      };
      reader.onerror = () => reject(new Error("image_read"));
      reader.readAsDataURL(file);
    });
  }

  /** `text` com `piece` no lugar da seleção (ou no fim), em linha própria; devolve também onde o cursor fica. */
  function insertAt(text: string, piece: string, at: number | null): { text: string; caret: number } {
    const pos = at === null || at < 0 || at > text.length ? text.length : at;
    const before = text.slice(0, pos);
    const lead = before === "" || before.endsWith("\n") ? "" : "\n";
    const next = `${before}${lead}${piece}\n${text.slice(pos)}`;
    return { text: next, caret: before.length + lead.length + piece.length + 1 };
  }

  // ---- o componente ----

  const BTN = "inline-flex h-6 cursor-pointer items-center justify-center shrink-0 px-1.5 max-lg:min-h-11 max-lg:min-w-11! t-label text-foreground border border-border outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40";

  interface Editor {
    phase: string;
    draft: string;
    rev: string | null;
    dirty: boolean;
    status: string;
    error: boolean;
    onEdit(draft: string): void;
    onSave(): void;
    /** Texto novo vindo de fora (agente), quando não há rascunho. */
    refresh(): void;
    conflict: Tree | null;
  }

  interface NoteCardProps {
    /** Id do nó da nota no documento do canvas: as ações do cabeçalho (destacar, recolher) agem sobre ele. */
    nodeId: string;
    name: string;
    agent?: string;
    model: NoteModel;
    marked: MarkedLib | undefined;
    actions: NoteActions;
    /** O editor de texto (estado, gravação e conflito) que types-user.tsx já tem; a nota só o desenha. */
    editor: Editor;
    schedule: (fn: () => void, ms: number) => () => void;
    messageOf(code: string): string;
  }

  function NoteCard(props: NoteCardProps): Tree {
    const { name, model, actions, editor } = props;
    const [meta, setMeta] = React.useState<NoteMeta>({ locked: false, title: null, location: "default", path: null, base: name });
    const [mode, setModeState] = React.useState<"raw" | "formatted" | null>(null);
    const [menu, setMenu] = React.useState<{ x: number; y: number; target: MenuTarget } | null>(null);
    const [renaming, setRenaming] = React.useState<string | null>(null);
    const [moving, setMoving] = React.useState<string | null>(null);
    const [notice, setNotice] = React.useState<string | null>(null);
    const body = React.useRef<HTMLDivElement | null>(null);
    const textarea = React.useRef<HTMLTextAreaElement | null>(null);
    const menuRef = React.useRef<HTMLDivElement | null>(null);
    const opener = React.useRef<HTMLElement | null>(null);
    const alive = React.useRef(true);

    React.useEffect(() => {
      alive.current = true;
      void actions.meta(name).then((res) => { if (alive.current && res.ok) setMeta(res.meta); });
      return () => { alive.current = false; };
    }, [actions, name]);

    const ready = editor.phase !== "loading";
    const current = mode ?? (ready ? initialMode(name, editor.draft) : "formatted");
    const setMode = (next: "raw" | "formatted"): void => {
      modes.set(name, next);
      setModeState(next);
    };

    // gravação automática: o rascunho parado por AUTOSAVE_MS vai para a rota (bloqueada não grava)
    React.useEffect(() => {
      if (!editor.dirty || meta.locked || editor.phase !== "ready") return undefined;
      return props.schedule(() => editor.onSave(), AUTOSAVE_MS);
    }, [editor.draft, editor.dirty, editor.phase, meta.locked]);

    // releitura enquanto a nota está montada (o motor só monta o que está no viewport) e a aba está visível
    React.useEffect(() => {
      let cancel = (): void => undefined;
      const tick = (): void => {
        if (typeof document === "undefined" || document.visibilityState === "visible") editor.refresh();
        cancel = props.schedule(tick, REFRESH_MS);
      };
      cancel = props.schedule(tick, REFRESH_MS);
      return () => cancel();
    }, [editor.refresh]);

    const rendered = React.useMemo((): RenderedNote | null => {
      if (current !== "formatted" || !props.marked) return null;
      return renderNoteHtml(props.marked, model, { text: editor.draft, name, base: meta.base });
    }, [current, props.marked, editor.draft, name, meta.base]);

    // diagramas: só quando a nota formatada tem um bloco mermaid fechado; a nota que sai da tela para de escrever no DOM
    React.useEffect(() => {
      const root = body.current;
      if (!root || !rendered || rendered.diagrams.length === 0) return undefined;
      let on = true;
      void drawDiagrams(root, rendered, () => on && alive.current);
      return () => { on = false; };
    }, [rendered]);

    // menu: fica no body (a nota corta o que passa da borda e a escala do canvas o encolheria), dentro da tela.
    // Esc fecha e devolve o foco a quem abriu; clique fora ou roda do mouse (a nota anda com a câmera) fecha
    React.useEffect(() => {
      if (!menu) return undefined;
      const el = menuRef.current;
      if (el) {
        const at = menuPlacement(menu, el.getBoundingClientRect(), { w: window.innerWidth, h: window.innerHeight });
        el.style.left = `${at.x}px`;
        el.style.top = `${at.y}px`;
      }
      el?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
      const close = (event: Event): void => {
        if (event instanceof KeyboardEvent && event.key !== "Escape") return;
        if (event instanceof MouseEvent && menuRef.current?.contains(event.target as Node)) return;
        setMenu(null);
        if (event instanceof KeyboardEvent) opener.current?.focus();
      };
      document.addEventListener("keydown", close);
      document.addEventListener("mousedown", close);
      document.addEventListener("wheel", close, { passive: true });
      return () => {
        document.removeEventListener("keydown", close);
        document.removeEventListener("mousedown", close);
        document.removeEventListener("wheel", close);
      };
    }, [menu]);

    const say = (code: string | null): void => setNotice(code === null ? null : props.messageOf(code));

    const openMenu = (event: { clientX: number; clientY: number; target: EventTarget | null; preventDefault(): void; stopPropagation(): void }): void => {
      event.preventDefault();
      event.stopPropagation();
      const el = event.target instanceof Element ? event.target : null;
      const tableEl = el?.closest<HTMLElement>("[data-note-table]");
      const cellEl = el?.closest<HTMLElement>("td, th");
      const diagramEl = el?.closest<HTMLElement>("[data-note-diagram]");
      const target: MenuTarget = {};
      if (tableEl) target.table = Number(tableEl.dataset.noteTable);
      if (tableEl && cellEl) target.cell = cellEl.textContent ?? "";
      if (diagramEl) target.diagram = Number(diagramEl.dataset.noteDiagram);
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMenu({ x: event.clientX, y: event.clientY, target });
    };

    const run = async (id: string, target: MenuTarget): Promise<void> => {
      setMenu(null);
      try {
        switch (id) {
          case "copy-diagram-code":
            await copyText(rendered?.diagrams[target.diagram ?? -1]?.source ?? "");
            return;
          case "copy-diagram-image": {
            const el = body.current?.querySelector<HTMLElement>(`[data-note-diagram="${target.diagram ?? -1}"]`);
            if (el) await copyDiagramImage(el);
            return;
          }
          case "copy-table": {
            const table = parseTableRaw(rendered?.tables[target.table ?? -1] ?? "");
            copyFormats({ "text/html": model.tableToHtml(table), "text/plain": model.tableToTsv(table), "text/rtf": model.tableToRtf(table) });
            return;
          }
          case "copy-table-md":
            await copyText(model.tableToMarkdown(parseTableRaw(rendered?.tables[target.table ?? -1] ?? "")));
            return;
          case "copy-cell":
            await copyText(target.cell ?? "");
            return;
          case "toggle-mode":
            setMode(current === "raw" ? "formatted" : "raw");
            return;
          case "rename":
            setRenaming(meta.title ?? "");
            return;
          case "lock":
          case "unlock": {
            const res = await actions.lock(name, id === "lock");
            if (res.ok) setMeta((m) => ({ ...m, locked: res.locked }));
            say(res.ok ? null : res.code);
            return;
          }
          case "move":
            setMoving(meta.path ?? "");
            return;
        }
      } catch (error) {
        setNotice(`Não foi possível copiar (${error instanceof Error ? error.message : "copy"})`);
      }
    };

    const commitRename = async (value: string): Promise<void> => {
      setRenaming(null);
      const res = await actions.rename(name, value.trim() === "" ? null : value);
      if (res.ok) setMeta((m) => ({ ...m, title: res.title }));
      say(res.ok ? null : res.code);
    };

    const commitMove = async (to: string | null): Promise<void> => {
      if (editor.dirty) {
        setNotice("Grave a nota antes de movê-la.");
        return;
      }
      const res = await actions.move(name, to);
      if (!res.ok) {
        say(res.code);
        return;
      }
      setMoving(null);
      say(null);
      const fresh = await actions.meta(name);
      if (fresh.ok) setMeta(fresh.meta);
      editor.refresh();
    };

    const onPaste = (event: { clipboardData: DataTransfer | null; preventDefault(): void }): void => {
      const file = [...(event.clipboardData?.items ?? [])].find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile();
      if (!file) return;
      event.preventDefault();
      if (meta.locked) {
        say("note_locked");
        return;
      }
      const at = current === "raw" ? textarea.current?.selectionStart ?? null : null;
      void fileToBase64(file).then((data) => actions.image(name, data)).then((res) => {
        if (!res.ok) {
          say(res.code);
          return;
        }
        const next = insertAt(editor.draft, res.markdown, at);
        editor.onEdit(next.text);
      }, () => say("note_invalid_image"));
    };

    const onCellDoubleClick = (event: { target: EventTarget | null; stopPropagation(): void }): void => {
      const cell = event.target instanceof Element ? event.target.closest("td, th") : null;
      if (!cell) return;
      event.stopPropagation();
      const range = document.createRange();
      range.selectNodeContents(cell);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };

    const onBodyClick = (event: { target: EventTarget | null; stopPropagation(): void }): void => {
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-note-copy]") : null;
      if (!button) return;
      event.stopPropagation();
      void run("copy-diagram-code", { diagram: Number(button.dataset.noteCopy) });
    };

    const title = model.noteTitle(editor.draft, meta.title) || `${name}.md`;
    const NodeActions = (globalThis as unknown as { ArgosParts?: { NodeActions?: (p: { id: string; locked: boolean; more: boolean }) => Tree } }).ArgosParts?.NodeActions;
    const header = h("div", { className: "flex items-center gap-1 border-b border-border px-1 py-0.5 t-label", "data-note-header": "" },
      renaming !== null
        ? h("input", {
          className: "min-w-0 flex-1 border border-border-strong bg-background px-1 t-label text-foreground", autoFocus: true, value: renaming, maxLength: model.NOTE_FILE_LIMITS.titleChars,
          "aria-label": "Nome da nota (vazio volta ao da primeira linha)",
          onChange: (event: { target: { value: string } }) => setRenaming(event.target.value),
          onKeyDown: (event: { key: string; stopPropagation(): void }) => {
            event.stopPropagation();
            if (event.key === "Enter") void commitRename(renaming);
            else if (event.key === "Escape") setRenaming(null);
          },
          onBlur: () => void commitRename(renaming),
        })
        : h("span", {
          className: `min-w-0 flex-1 truncate t-body-strong ${meta.title ? "" : "text-foreground"}`, title: meta.location === "custom" ? meta.path ?? "" : `${name}.md`,
          onDoubleClick: (event: { stopPropagation(): void }) => { event.stopPropagation(); setRenaming(meta.title ?? ""); },
        }, title),
      h("span", { role: "group", "aria-label": "Modo da nota", className: "flex" },
        h("button", { type: "button", className: `${BTN} ${current === "raw" ? "bg-accent" : ""}`, "aria-pressed": current === "raw", onClick: () => setMode("raw") }, "Raw"),
        h("button", { type: "button", className: `${BTN} ${current === "formatted" ? "bg-accent" : ""}`, "aria-pressed": current === "formatted", onClick: () => setMode("formatted") }, "Formatada")),
      h("button", {
        type: "button", className: BTN, "aria-label": "Opções da nota", "aria-haspopup": "menu",
        onClick: (event: { clientX: number; clientY: number; target: EventTarget | null; preventDefault(): void; stopPropagation(): void }) => openMenu(event),
      }, "⋯"),
      // o "⋯" da nota já é o menu dela (inclui travar); aqui só Destacar e Recolher, e o cadeado fica no grupo
      NodeActions ? h(NodeActions, { id: props.nodeId, locked: meta.locked, more: false }) : null);

    const content = current === "raw" || !rendered
      ? h("textarea", {
        ref: textarea, className: "min-h-0 flex-1 resize-none border-0 bg-background p-1 font-mono t-label text-foreground outline-none",
        "aria-label": `Texto da nota ${title}`, value: editor.draft, readOnly: meta.locked, disabled: !ready || editor.phase === "failed", spellCheck: false,
        onChange: (event: { target: { value: string } }) => editor.onEdit(event.target.value),
      })
      // o HTML vem de renderNoteHtml: HTML cru do texto escapado, link e imagem por lista fechada (seg.html-sem-sanitizar)
      : h("div", {
        ref: body, className: "md md-note note-formatted min-h-0 flex-1 select-text overflow-auto p-2 text-foreground", tabIndex: 0, "aria-label": `Nota ${title} formatada`,
        dangerouslySetInnerHTML: { __html: rendered.html }, onDoubleClick: onCellDoubleClick, onClick: onBodyClick,
      });

    const menuItems = menu ? noteMenuItems(menu.target, {
      locked: meta.locked, mode: current,
      diagramReady: menu.target.diagram !== undefined && body.current?.querySelector(`[data-note-diagram="${menu.target.diagram}"][data-note-diagram-ready]`) != null,
    }) : [];

    return h("div", { className: "note-card relative flex h-full flex-col bg-card", "data-note-mode": current, "data-note-locked": meta.locked ? "1" : undefined, onContextMenu: openMenu, onPaste },
      header,
      content,
      editor.conflict,
      notice || editor.status
        ? h("span", { role: "status", className: `truncate px-1 t-label ${notice || editor.error ? "text-bad" : "text-muted-foreground"}` }, notice ?? editor.status)
        : null,
      moving !== null
        ? h("form", {
          className: "absolute inset-x-1 top-8 flex flex-col gap-1 elev-float bg-card p-2", "aria-label": "Mover para…",
          onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void commitMove(moving); },
          onKeyDown: (event: { key: string; stopPropagation(): void }) => { event.stopPropagation(); if (event.key === "Escape") setMoving(null); },
        },
          h("label", { className: "t-label" }, "Caminho completo do arquivo (.md, .markdown ou .txt)"),
          h("input", { className: "border border-border-strong bg-background px-1 font-mono t-label", autoFocus: true, value: moving, onChange: (event: { target: { value: string } }) => setMoving(event.target.value) }),
          h("span", { className: "flex gap-1" },
            h("button", { type: "submit", className: BTN, disabled: moving.trim() === "" }, "Mover"),
            meta.location === "custom" ? h("button", { type: "button", className: BTN, onClick: () => void commitMove(null) }, "Voltar à pasta padrão") : null,
            h("button", { type: "button", className: BTN, onClick: () => setMoving(null) }, "Cancelar")))
        : null,
      menu
        ? ReactDOM.createPortal(h("div", { ref: menuRef, role: "menu", "aria-label": "Menu da nota", className: "fixed z-[60] flex min-w-40 flex-col elev-float bg-card py-1", style: { left: menu.x, top: menu.y } },
          ...menuItems.map((item) => h("button", {
            key: item.id, type: "button", role: "menuitem", disabled: item.disabled, className: "px-2 py-0.5 text-left t-label hover:bg-accent focus-visible:bg-accent outline-none disabled:opacity-40",
            onClick: () => void run(item.id, menu.target),
          }, item.label))), document.body)
        : null);
  }

  /** O host abre a nota num modo (p.ex. a nota recém-criada pela ferramenta, em Raw); vale para a sessão da página. */
  const rememberMode = (name: string, mode: "raw" | "formatted"): void => {
    modes.set(name, mode);
  };

  return { renderNoteHtml, parseTableRaw, noteMenuItems, menuPlacement, insertAt, initialMode, rememberMode, loadMermaid, NoteCard, MERMAID_URL, CLOSED_FENCE };
}

type ArgosNodeNoteApi = ReturnType<typeof makeArgosNodeNote>;
(globalThis as unknown as { ArgosNodeNote: ArgosNodeNoteApi }).ArgosNodeNote = makeArgosNodeNote();
export type { ArgosNodeNoteApi };
