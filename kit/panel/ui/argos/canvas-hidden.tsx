/* Ocultos do canvas do Argos (reference/argos.md §Ocultar e podar o canvas): os comandos "Ocultar do canvas" (Shift+H, paleta e
 * menu do nó), "Reexibir todos os ocultos" e "Lista de ocultos…", e o botão "Ocultos (N)" da barra com a lista para reexibir
 * um, vários ou todos. Script clássico: registra window.ArgosCanvasHidden. Depende só de React. Só exibe e encaminha: quem
 * monta a operação do desfazer (opHide/opUnhide de src/lib/canvas-history.ts) e a aplica é a página, pela porta recebida.
 * Diálogo: foco na primeira linha ao abrir, Esc e clique fora fecham e devolvem o foco ao botão. */

/** O que os comandos leem do contexto da página: o nó do menu (ou o selecionado). */
interface HiddenCommandCtx {
  reading: { nodeId: string | null };
}

/** O que os comandos pedem à página; ela decide o alvo e aplica a operação. */
interface HiddenPort {
  /** Ids a ocultar a partir do nó do menu (ou do selecionado): a seleção visível inteira se o contém, senão só ele. */
  targets(nodeId: string | null): readonly string[];
  hide(ids: readonly string[]): void;
  unhideAll(): void;
  /** Quantos nós estão ocultos agora. */
  count(): number;
  openList(): void;
}

interface HiddenCommandDef {
  id: string;
  label: string | ((ctx: HiddenCommandCtx) => string);
  hint?: string;
  group: string;
  shortcut?: string;
  surfaces: readonly ("palette" | "node-menu" | "canvas-menu")[];
  when: (ctx: HiddenCommandCtx) => boolean;
  run: (ctx: HiddenCommandCtx) => void;
}

/** Uma linha da lista de ocultos, como a tela mostra. */
interface HiddenItem {
  id: string;
  label: string;
  /** O que o nó é (agente, nota…); vazio quando não se sabe. */
  kind: string;
}

interface HiddenMenuProps {
  items: readonly HiddenItem[];
  /** Reexibe os ids dados, num passo só do desfazer. */
  onUnhide(ids: readonly string[]): void;
  /** Muda a cada pedido de abrir vindo de fora (comando "Lista de ocultos…"); o valor inicial não abre. */
  openSignal?: number;
  /** Dentro do popover Filtros (lista no fluxo; sem ocultos, o item não aparece). */
  inline?: boolean;
  /** Nasce com a lista aberta (o popover Filtros abriu por "Lista de ocultos…"). */
  defaultOpen?: boolean;
}

interface FocusTarget {
  focus(): void;
  contains(node: unknown): boolean;
}

interface KeyEvent {
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
}

const HIDE_COMMAND = "canvas:hide";
const HIDE_SHORTCUT = "shift+h";
const HIDDEN_GROUP = "Canvas";
const LIST_WIDTH_PX = 320;
const EMPTY_LABEL = "Nenhum nó oculto";

const nodesText = (n: number): string => `${n} ${n === 1 ? "nó" : "nós"}`;

/** Alvo de "Ocultar": a seleção quando ela contém o nó do menu (ou não há nó do menu); senão só o nó. Sem repetir. */
function hideTargets(selection: readonly string[], nodeId: string | null): string[] {
  if (nodeId === null || selection.includes(nodeId)) return [...new Set(selection)];
  return [nodeId];
}

/** Comandos dos ocultos para o registro de comandos da página (Ctrl+K, botão direito, `?`). */
function hiddenCommandDefs(port: HiddenPort): HiddenCommandDef[] {
  const targetsOf = (ctx: HiddenCommandCtx): readonly string[] => port.targets(ctx.reading.nodeId);
  return [
    {
      id: HIDE_COMMAND,
      label: (ctx) => {
        const n = targetsOf(ctx).length;
        return n > 1 ? `Ocultar ${nodesText(n)} do canvas` : "Ocultar do canvas";
      },
      hint: "sai do desenho; registro e worktree ficam",
      group: HIDDEN_GROUP,
      shortcut: HIDE_SHORTCUT,
      surfaces: ["palette", "node-menu"],
      when: (ctx) => targetsOf(ctx).length > 0,
      run: (ctx) => {
        const ids = targetsOf(ctx);
        if (ids.length > 0) port.hide(ids);
      },
    },
    {
      id: "canvas:unhide-all",
      label: "Reexibir todos os ocultos",
      hint: "voltam ao desenho onde estavam",
      group: HIDDEN_GROUP,
      surfaces: ["palette", "canvas-menu"],
      when: () => port.count() > 0,
      run: () => port.unhideAll(),
    },
    {
      id: "canvas:hidden-list",
      label: "Lista de ocultos…",
      hint: "reexibir um, vários ou todos",
      group: HIDDEN_GROUP,
      surfaces: ["palette", "canvas-menu"],
      when: () => port.count() > 0,
      run: () => port.openList(),
    },
  ];
}

/** Marcados que ainda estão na lista (um oculto reexibido por outro caminho sai da marcação). */
const keepChecked = (checked: ReadonlySet<string>, items: readonly HiddenItem[]): string[] =>
  items.filter((item) => checked.has(item.id)).map((item) => item.id);

interface HiddenUi {
  h: ReactApi["createElement"];
  items: readonly HiddenItem[];
  open: boolean;
  checked: ReadonlySet<string>;
  setButton?(el: unknown): void;
  setRoot?(el: unknown): void;
  setFirst?(el: unknown): void;
  onToggleOpen(): void;
  onCheck(id: string): void;
  onUnhide(ids: readonly string[]): void;
  onKeyDown(event: KeyEvent): void;
  /** Dentro do popover Filtros: a lista abre no fluxo, sem dropdown, e o item some com zero ocultos. */
  inline?: boolean;
}

const FOCUS_RING = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
const BUTTON = `inline-flex min-h-8 cursor-pointer items-center justify-center gap-1 border border-border px-2 t-control transition-colors hover:bg-accent/60 disabled:cursor-default disabled:opacity-50 max-md:min-h-11 ${FOCUS_RING}`;
const TRIGGER = `inline-flex h-9 cursor-pointer items-center gap-2 border border-border px-3 t-control tabular-nums transition-colors hover:bg-accent/60 ${FOCUS_RING}`;

// a lista é uma ilha: ponteiro e roda dentro dela não chegam ao canvas
const stop = (event: { stopPropagation(): void }): void => event.stopPropagation();
const SHIELD = { onPointerDown: stop, onPointerMove: stop, onPointerUp: stop, onPointerCancel: stop, onWheel: stop, onDoubleClick: stop, onContextMenu: stop };

function renderRow(ui: HiddenUi, item: HiddenItem, index: number): ReactNode {
  const { h } = ui;
  return h("li", { key: item.id, "data-hidden": item.id, className: "flex items-center gap-2 border-b border-border px-3 py-1 last:border-b-0" },
    h("label", { className: "flex min-w-0 flex-1 cursor-pointer items-center gap-2 max-md:min-h-11" },
      h("input", {
        type: "checkbox", ref: index === 0 ? ui.setFirst : undefined, checked: ui.checked.has(item.id), onChange: () => ui.onCheck(item.id),
        className: `size-4 shrink-0 cursor-pointer accent-foreground ${FOCUS_RING}`,
      }),
      h("span", { className: "flex min-w-0 flex-col" },
        h("span", { className: "truncate text-foreground" }, item.label),
        item.kind ? h("span", { className: "truncate t-meta text-muted-foreground" }, item.kind) : null)),
    h("button", { type: "button", onClick: () => ui.onUnhide([item.id]), "aria-label": `Reexibir ${item.label}`, className: `${BUTTON} shrink-0 text-muted-foreground` }, "Reexibir"));
}

/** Árvore do botão e da lista: pura, sem hooks, para o teste ler sem DOM. */
function renderHiddenMenu(ui: HiddenUi): ReactNode {
  const { h } = ui;
  const total = ui.items.length;
  const picked = keepChecked(ui.checked, ui.items);
  if (ui.inline && total === 0) return null;
  const trigger = h("button", {
    type: "button", ref: ui.setButton, onClick: ui.onToggleOpen, "aria-expanded": ui.open, "aria-haspopup": "dialog",
    disabled: total === 0 && !ui.open, title: total === 0 ? EMPTY_LABEL : "Nós que você tirou do canvas (Shift+H oculta)", className: `${TRIGGER} disabled:cursor-default disabled:opacity-50`,
  }, `Ocultos do canvas (${total})`);
  if (!ui.open) return h("div", { className: "relative" }, trigger);
  return h("div", { className: "relative" }, trigger,
    h("div", {
      ref: ui.setRoot, role: "dialog", "aria-label": "Nós ocultos", tabIndex: -1, onKeyDown: ui.onKeyDown, ...SHIELD,
      className: ui.inline
        ? "mt-1 flex max-h-64 flex-col overflow-y-auto border border-border-strong bg-background t-body outline-none"
        : "absolute left-0 top-full z-30 mt-1 flex max-h-96 flex-col overflow-y-auto border border-border-strong bg-background t-body outline-none",
      style: ui.inline ? undefined : { width: LIST_WIDTH_PX, maxWidth: "calc(100vw - 2rem)" },
    },
    h("div", { className: "sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background px-3 py-1" },
      h("span", { className: "t-meta-em tabular-nums text-muted-foreground" }, total > 0 ? `${nodesText(total)} ${total === 1 ? "oculto" : "ocultos"}` : "Ocultos do canvas"),
      h("div", { className: "flex gap-1" },
        h("button", { type: "button", disabled: picked.length === 0, onClick: () => ui.onUnhide(picked), className: `${BUTTON} text-foreground` },
          picked.length > 0 ? `Reexibir ${picked.length}` : "Reexibir marcados"),
        h("button", { type: "button", disabled: total === 0, onClick: () => ui.onUnhide(ui.items.map((item) => item.id)), className: `${BUTTON} text-foreground` }, "Reexibir todos"))),
    total === 0
      ? h("p", { className: "px-3 py-2 t-meta text-muted-foreground" }, EMPTY_LABEL)
      : h("ul", { role: "list", className: "flex flex-col" }, ...ui.items.map((item, index) => renderRow(ui, item, index)))));
}

function HiddenMenu(props: HiddenMenuProps): ReactNode {
  const [open, setOpen] = React.useState(props.defaultOpen === true);
  const [checked, setChecked] = React.useState<ReadonlySet<string>>(() => new Set());
  const button = React.useRef<FocusTarget | null>(null);
  const root = React.useRef<FocusTarget | null>(null);
  const first = React.useRef<FocusTarget | null>(null);
  const signal = React.useRef(props.openSignal);

  React.useEffect(() => {
    if (props.openSignal === signal.current) return;
    signal.current = props.openSignal;
    setOpen(true);
  }, [props.openSignal]);

  const close = (): void => {
    setOpen(false);
    setChecked(new Set());
    button.current?.focus();
  };
  const closeRef = React.useRef(close);
  closeRef.current = close;

  // foco na primeira linha ao abrir; clique fora fecha. O ouvinte vive enquanto a lista está aberta.
  React.useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    (first.current ?? root.current)?.focus();
    const outside = (event: { target: unknown }): void => {
      const inside = root.current?.contains(event.target) || button.current?.contains(event.target);
      if (!inside) closeRef.current();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  return renderHiddenMenu({
    h: React.createElement, items: props.items, open, checked, inline: props.inline,
    setButton: (el) => { button.current = el as FocusTarget | null; },
    setRoot: (el) => { root.current = el as FocusTarget | null; },
    setFirst: (el) => { first.current = el as FocusTarget | null; },
    onToggleOpen: () => (open ? close() : setOpen(true)),
    onCheck: (id) => setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }),
    onUnhide: (ids) => {
      if (ids.length === 0) return;
      props.onUnhide(ids);
      setChecked((cur) => new Set([...cur].filter((id) => !ids.includes(id))));
      // a linha some com o foco nela: o foco fica no próprio diálogo, que continua aberto
      root.current?.focus();
    },
    onKeyDown: (event) => {
      if (event.key !== "Escape") return;
      // não chega ao canvas, que limparia a seleção
      event.stopPropagation();
      event.preventDefault();
      closeRef.current();
    },
  });
}

function makeArgosCanvasHidden() {
  return { HIDE_COMMAND, HIDE_SHORTCUT, EMPTY_LABEL, hideTargets, hiddenCommandDefs, keepChecked, renderHiddenMenu, HiddenMenu };
}

type ArgosCanvasHiddenApi = ReturnType<typeof makeArgosCanvasHidden>;
(globalThis as unknown as { ArgosCanvasHidden: ArgosCanvasHiddenApi }).ArgosCanvasHidden = makeArgosCanvasHidden();
export type { ArgosCanvasHiddenApi, HiddenCommandCtx, HiddenCommandDef, HiddenItem, HiddenMenuProps, HiddenPort };
