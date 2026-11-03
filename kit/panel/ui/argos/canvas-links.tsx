/* Popover de conexões do nó no canvas do Argos (reference/argos.md §Conexões): uma linha por conexão com o destino, o que
 * ele é (terminal ou nota) e o que a conexão dá; clicar na linha pula até o destino, os botões trocam o estilo (corda ou
 * circuito), soltam a abraçadeira (o equivalente por teclado de selecionar + Delete no canvas) e o × remove a conexão sem
 * fechar o popover. Script clássico: registra window.ArgosLinks. Depende de React e de window.CanvasModel.links. Só exibe e
 * encaminha: toda mudança sai como operação do desfazer (`onOp`), montada pelas regras de src/lib/canvas-links.ts; a página
 * a aplica (commit) e devolve o documento novo. Diálogo: foco na primeira linha ao abrir, Esc e clique fora fecham e devolvem
 * o foco a quem o abriu. Monte-o fora do elemento que o motor escuta (como o painel do nó). */
import type { Viewport } from "../../../../src/lib/canvas-camera.ts";
import type { CanvasDoc } from "../../../../src/lib/canvas-doc.ts";
import type { CanvasOp } from "../../../../src/lib/canvas-history.ts";
import type * as LinksModule from "../../../../src/lib/canvas-links.ts";
import type { LinkStyle } from "../../../../src/lib/canvas-links.ts";

interface LinksPopoverProps {
  /** O documento salvo (não o de vista): as operações valem sobre ele. */
  doc: CanvasDoc;
  nodeId: string;
  /** Ponto da tela (pixels do canvas) onde o popover abre, em geral o badge do nó. */
  at: { x: number; y: number };
  view: Viewport;
  /** Nome do nó na tela (o rótulo do grafo); sem nome, a linha mostra o id. */
  describe(nodeId: string): string | undefined;
  onOp(op: CanvasOp): void;
  /** A página centraliza e seleciona o destino; o popover fecha em seguida. */
  onJump(nodeId: string): void;
  onClose(): void;
  /** Operação recusada (documento mudou por baixo); sem isso a mensagem vai ao console. */
  onError?(message: string): void;
}

/** Uma conexão como a tela mostra. */
interface PopoverRow {
  edgeId: string;
  other: string;
  label: string;
  /** "Terminal" ou "Nota"; vazio se o destino é de um tipo que não conecta (documento editado à mão). */
  end: string;
  meaning: string;
  style: LinkStyle;
  clamps: readonly string[];
}

const POPOVER_WIDTH_PX = 320;
const ROW_PX = 88;
const HEADER_PX = 36;
const EDGE_PX = 8;
const EMPTY_LABEL = "Nenhuma conexão neste nó";

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

/** Canto do popover: abre no ponto; sem espaço à direita ou embaixo, abre para a esquerda ou para cima; sempre dentro da tela. */
function placePopover(at: { x: number; y: number }, view: Viewport, size: Viewport): { x: number; y: number } {
  const x = at.x + size.w > view.w - EDGE_PX ? at.x - size.w : at.x;
  const y = at.y + size.h > view.h - EDGE_PX ? at.y - size.h : at.y;
  return { x: Math.round(clamp(x, EDGE_PX, view.w - size.w - EDGE_PX)), y: Math.round(clamp(y, EDGE_PX, view.h - size.h - EDGE_PX)) };
}

/** Altura estimada: uma faixa de cabeçalho e uma por linha, nunca mais que a tela (o excedente rola). */
const popoverSize = (rows: number, view: Viewport): Viewport => ({
  w: Math.min(POPOVER_WIDTH_PX, view.w - 2 * EDGE_PX),
  h: Math.min(HEADER_PX + Math.max(1, rows) * ROW_PX, view.h - 2 * EDGE_PX),
});

interface FocusTarget {
  focus(): void;
  contains(node: unknown): boolean;
}

function makeArgosLinks() {
  const model = (globalThis as unknown as { CanvasModel?: { links?: typeof LinksModule } }).CanvasModel;
  if (!model?.links) throw new Error("ArgosLinks: carregue /ui/lib/canvas-model.js (com `links`) antes de canvas-links.js");
  const L = model.links;

  /** As linhas do popover, na ordem do documento. */
  function popoverRows(doc: CanvasDoc, nodeId: string, describe: (id: string) => string | undefined): PopoverRow[] {
    return L.linksOf(doc, nodeId).map((row) => {
      const end = L.linkEndOf(row.otherType);
      return {
        edgeId: row.edgeId, other: row.other, label: describe(row.other) || row.other,
        end: end ? L.LINK_END_TEXT[end] : "", meaning: row.meaning ? L.LINK_MEANING_TEXT[row.meaning] : "",
        style: row.style, clamps: row.clamps,
      };
    });
  }

  interface PopoverUi {
    h: ReactApi["createElement"];
    title: string;
    rows: readonly PopoverRow[];
    at: { x: number; y: number };
    size: Viewport;
    setRoot?(el: unknown): void;
    setFirst?(el: unknown): void;
    onJump(row: PopoverRow): void;
    onStyle(row: PopoverRow, style: LinkStyle): void;
    onRelease(clampId: string): void;
    onRemove(row: PopoverRow): void;
    onClose(): void;
    onKeyDown(event: { key: string; preventDefault(): void; stopPropagation(): void }): void;
  }

  const ROOT = "absolute z-30 flex flex-col overflow-y-auto border border-border-strong bg-background t-body outline-none";
  const FOCUS_RING = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
  const BUTTON = `inline-flex min-h-7 cursor-pointer items-center justify-center border border-border px-2 t-meta transition-colors hover:bg-accent/60 max-md:min-h-11 ${FOCUS_RING}`;

  // o popover é uma ilha: ponteiro e roda dentro dele não chegam ao canvas (não arrastam, não dão zoom, não limpam a seleção)
  const stop = (event: { stopPropagation(): void }): void => event.stopPropagation();
  const SHIELD = { onPointerDown: stop, onPointerMove: stop, onPointerUp: stop, onPointerCancel: stop, onWheel: stop, onDoubleClick: stop, onContextMenu: stop };

  function renderRow(ui: PopoverUi, row: PopoverRow, index: number): ReactNode {
    const { h } = ui;
    const kind = [row.end, row.meaning].filter(Boolean).join(" · ");
    const styleButton = (style: LinkStyle): ReactNode => h("button", {
      key: style, type: "button", "aria-pressed": row.style === style, onClick: () => ui.onStyle(row, style),
      className: `${BUTTON} ${row.style === style ? "border-foreground bg-accent/40 text-foreground" : "text-muted-foreground"}`,
    }, L.LINK_STYLE_TEXT[style]);
    return h("li", { key: row.edgeId, "data-edge": row.edgeId, className: "flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0" },
      h("div", { className: "flex min-w-0 items-start gap-1" },
        h("button", {
          type: "button", ref: index === 0 ? ui.setFirst : undefined, onClick: () => ui.onJump(row), title: `Ir até ${row.label}`,
          className: `flex min-w-0 flex-1 cursor-pointer flex-col items-start text-left hover:underline max-md:min-h-11 ${FOCUS_RING}`,
        },
        h("span", { className: "w-full truncate text-foreground" }, row.label),
        kind ? h("span", { className: "w-full truncate t-meta text-muted-foreground" }, kind) : null),
        h("button", {
          type: "button", "aria-label": `Remover conexão com ${row.label}`, title: "Remover conexão", onClick: () => ui.onRemove(row),
          className: `${BUTTON} shrink-0 border-transparent text-muted-foreground hover:text-bad max-md:min-w-11`,
        }, h("span", { "aria-hidden": "true", className: "text-base leading-none" }, "×"))),
      h("div", { className: "flex flex-wrap items-center gap-1" },
        h("div", { role: "group", "aria-label": `Estilo da conexão com ${row.label}`, className: "flex gap-1" }, ...L.LINK_STYLES.map(styleButton)),
        ...row.clamps.map((clampId, n) => h("button", {
          key: clampId, type: "button", onClick: () => ui.onRelease(clampId), className: `${BUTTON} text-muted-foreground`,
        }, row.clamps.length > 1 ? `Soltar abraçadeira ${n + 1}` : "Soltar abraçadeira"))));
  }

  /** Árvore de elementos do popover: pura, sem hooks, para o teste ler sem DOM. */
  function renderPopover(ui: PopoverUi): ReactNode {
    const { h } = ui;
    return h("div", {
      ref: ui.setRoot, role: "dialog", "aria-label": ui.title, tabIndex: -1, onKeyDown: ui.onKeyDown, ...SHIELD,
      className: ROOT, style: { left: ui.at.x, top: ui.at.y, width: ui.size.w, maxHeight: ui.size.h },
    },
    h("div", { className: "sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-background px-3 py-1" },
      h("span", { className: "t-meta-em text-muted-foreground" }, ui.rows.length > 0 ? `${ui.rows.length} ${ui.rows.length === 1 ? "conexão" : "conexões"}` : "Conexões"),
      h("button", { type: "button", "aria-label": "Fechar conexões", onClick: ui.onClose, className: `${BUTTON} border-transparent text-muted-foreground max-md:min-w-11` },
        h("span", { "aria-hidden": "true", className: "text-base leading-none" }, "×"))),
    ui.rows.length === 0
      ? h("p", { className: "px-3 py-2 t-meta text-muted-foreground" }, EMPTY_LABEL)
      : h("ul", { role: "list", className: "flex flex-col" }, ...ui.rows.map((row, index) => renderRow(ui, row, index))));
  }

  function LinksPopover(props: LinksPopoverProps): ReactNode {
    const rows = popoverRows(props.doc, props.nodeId, props.describe);
    const root = React.useRef<FocusTarget | null>(null);
    const first = React.useRef<FocusTarget | null>(null);
    // o ouvinte de clique fora vive enquanto o popover está aberto: lê sempre o onClose atual
    const closeRef = React.useRef(props.onClose);
    closeRef.current = props.onClose;

    // foco na primeira linha ao abrir e de volta a quem abriu ao fechar; clique fora fecha. Ouvinte e foco têm o dono do popover.
    React.useEffect(() => {
      if (typeof document === "undefined") return undefined;
      const opener = document.activeElement as { focus?: () => void; isConnected?: boolean } | null;
      (first.current ?? root.current)?.focus();
      const outside = (event: { target: unknown }): void => {
        if (root.current && !root.current.contains(event.target)) closeRef.current();
      };
      document.addEventListener("pointerdown", outside, true);
      return () => {
        document.removeEventListener("pointerdown", outside, true);
        if (opener?.isConnected && typeof opener.focus === "function") opener.focus();
      };
    }, []);

    const report = (error: unknown): void => {
      const message = error instanceof Error ? error.message : "não foi possível mudar a conexão";
      (props.onError ?? console.warn)(message);
    };
    const run = (make: () => CanvasOp | undefined): void => {
      try {
        const op = make();
        if (op) props.onOp(op);
      } catch (error) {
        report(error);
      }
    };
    const size = popoverSize(rows.length, props.view);
    const title = `Conexões de ${props.describe(props.nodeId) || props.nodeId}`;

    return renderPopover({
      h: React.createElement, title, rows, at: placePopover(props.at, props.view, size), size,
      setRoot: (el) => { root.current = el as FocusTarget | null; },
      setFirst: (el) => { first.current = el as FocusTarget | null; },
      onJump: (row) => {
        props.onJump(row.other);
        props.onClose();
      },
      onStyle: (row, style) => run(() => L.opSetLinkStyle(props.doc, row.edgeId, style)),
      onRelease: (clampId) => run(() => L.opReleaseClamp(props.doc, clampId)),
      // a linha some com o botão focado: o foco fica no próprio diálogo, que continua aberto
      onRemove: (row) => {
        run(() => L.opRemoveLink(props.doc, row.edgeId));
        root.current?.focus();
      },
      onClose: props.onClose,
      onKeyDown: (event) => {
        if (event.key !== "Escape") return;
        // não chega ao canvas, que limparia a seleção
        event.stopPropagation();
        event.preventDefault();
        props.onClose();
      },
    });
  }

  return { LinksPopover, popoverRows, renderPopover, placePopover, popoverSize, EMPTY_LABEL };
}

type ArgosLinksApi = ReturnType<typeof makeArgosLinks>;
(globalThis as unknown as { ArgosLinks: ArgosLinksApi }).ArgosLinks = makeArgosLinks();
export type { ArgosLinksApi, LinksPopoverProps, PopoverRow };
