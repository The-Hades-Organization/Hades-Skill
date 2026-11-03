/* Painel do nó dentro do canvas do Argos (a gaveta do #/argos, aberta pela seleção): região ancorada à direita do palco (no
 * celular, folha que sobe de baixo), com o SidePanel do nó primário (`children`, que a página monta) e, com vários selecionados, uma faixa para escolher qual é o primário. Só
 * desenha e encaminha: a seleção, o primário e o "aberto" são da página. Script clássico: registra window.ArgosFocus =
 * { FocusPanel, FOCUS_PANEL_WIDTH }. Depende de HadesCore, de window.ArgosParts (Forma, Icon, TONE_ICON, TONE_TEXT) e de
 * window.CanvasModel.argos (forma e estado). Carregado depois de ui/argos/parts.js. Monte-o ao lado do motor, não dentro
 * do elemento que ele escuta: os eventos param aqui pelo React, que não alcança os ouvintes nativos de um ancestral. */
(() => {
const { useRef, useEffect, I, cn } = HadesCore;
const { Forma, Icon, TONE_ICON, TONE_TEXT } = window.ArgosParts;
const A = window.CanvasModel.argos;

/** Largura do painel aberto; a página usa a mesma string para deslocar o minimapa e os controles. */
const FOCUS_PANEL_WIDTH = 'clamp(20rem, 32%, 28rem)';
/** A mesma largura em pixels, dado o palco: a página a usa para a câmera levar o nó à área livre ao lado da gaveta. */
const REM_PX = 16;
const focusPanelPx = (stageWidth) => Math.min(28 * REM_PX, Math.max(20 * REM_PX, stageWidth * 0.32));
/** Fração da altura que a folha do celular cobre no máximo. */
const SHEET_MAX = 0.6;
const TOUCH_MIN = 'max-md:min-h-11';
const FOCUS_RING = 'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';
const ICON_BUTTON = cn('inline-flex size-7 shrink-0 items-center justify-center text-muted-foreground transition-colors cursor-pointer hover:bg-accent/60 hover:text-foreground max-md:min-w-11', TOUCH_MIN, FOCUS_RING);

// o painel é uma ilha: ponteiro e roda dentro dele não chegam ao canvas (não arrastam, não dão zoom, não limpam a seleção)
const stop = (e) => e.stopPropagation();
const SHIELD = { onPointerDown: stop, onPointerMove: stop, onPointerUp: stop, onPointerCancel: stop, onWheel: stop, onDoubleClick: stop, onContextMenu: stop };

// o Escape de um diálogo em portal sobe pela árvore do React: só vale o que veio de dentro do painel
const fromInside = (e) => !e.currentTarget?.contains || e.currentTarget.contains(e.target);

function Chip({ node, primary, onPrimary }) {
  const shape = node.shape || A.typeLook(node.type).shape;
  const look = node.state ? A.stateLook(node.state) : null;
  return <button type="button" aria-current={primary ? 'true' : undefined} title={node.label} onClick={() => onPrimary(node.id)}
    className={cn('inline-flex min-w-0 max-w-full items-center gap-1.5 border px-2 py-1 text-left t-meta cursor-pointer transition-colors hover:bg-accent/60', TOUCH_MIN, FOCUS_RING, primary ? 'border-foreground bg-accent/40 text-foreground' : 'border-border text-muted-foreground')}>
    <Forma shape={shape} className={primary ? 'text-foreground' : 'text-muted-foreground'} />
    <span className="min-w-0 truncate">{node.label}</span>
    {look ? <span className={cn('inline-flex shrink-0 items-center gap-1', TONE_TEXT[look.tone])}>
      <Icon name={look.icon} className={cn('size-3', TONE_ICON[look.tone])} />
      {look.word}
    </span> : null}
  </button>;
}

function FocusPanel({ open, nodes, primaryId, onPrimary, onToggle, children, sheet = false }) {
  const root = useRef(null);
  const handle = useRef(null);
  // o foco só acompanha o que o próprio painel fez (recolher, expandir): troca vinda da página não rouba o foco de ninguém
  const refocus = useRef(null);
  const opened = useRef(open);
  useEffect(() => {
    if (opened.current !== open) {
      const next = refocus.current === 'handle' ? handle.current : refocus.current === 'panel' ? root.current : null;
      next?.focus();
    }
    opened.current = open;
    refocus.current = null;
  }, [open]);
  const toggle = (next) => { refocus.current = next ? 'panel' : 'handle'; onToggle(next); };

  if (!nodes || nodes.length === 0) return null;
  if (!open) {
    return <button ref={handle} type="button" aria-label="Expandir painel do nó" aria-expanded="false" onClick={() => toggle(true)} {...SHIELD}
      className={cn('pointer-events-auto absolute right-0 z-20 flex flex-col items-center gap-1 border border-r-0 border-border-strong bg-card px-1 py-3 text-muted-foreground transition-colors cursor-pointer hover:bg-accent/60 hover:text-foreground max-md:min-w-11',
        sheet ? 'bottom-20' : 'top-1/2 -translate-y-1/2', TOUCH_MIN, FOCUS_RING)}>
      <I.PanelRightOpen className="size-4" aria-hidden="true" />
      {nodes.length > 1 ? <span className="t-meta-em">{nodes.length}</span> : null}
    </button>;
  }
  return <div ref={root} role="complementary" aria-label="Painel do nó" tabIndex={-1} {...SHIELD}
    onKeyDown={(e) => {
      if (e.key !== 'Escape' || !fromInside(e)) return;
      // não chega ao canvas (que limpa a seleção); um filho que já tratou o Escape (preventDefault) mantém o painel aberto
      e.stopPropagation();
      if (e.defaultPrevented) return;
      e.preventDefault();
      toggle(false);
    }}
    style={sheet ? { maxHeight: `${SHEET_MAX * 100}%` } : { width: FOCUS_PANEL_WIDTH }}
    data-region="panel"
    className={cn('elev-shadow pointer-events-auto absolute z-20 overflow-y-auto border-border bg-card text-card-foreground scrollbar-thin animate-fade-in focus:outline-none',
      sheet ? 'inset-x-0 bottom-0 border-t' : 'inset-y-0 right-0 border-l')}>
    {sheet ? <span aria-hidden="true" className="mx-auto mt-2 block h-1 w-10 bg-border-strong" /> : null}
    <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-card px-3 py-1">
      <span className="t-meta-em text-muted-foreground">{nodes.length > 1 ? `${nodes.length} selecionados` : 'Painel do nó'}</span>
      <button type="button" aria-label="Recolher painel do nó" aria-expanded="true" onClick={() => toggle(false)} className={ICON_BUTTON}>
        <I.PanelRightClose className="size-4" aria-hidden="true" />
      </button>
    </div>
    {nodes.length > 1 ? <ul role="list" aria-label="Selecionados" className="flex flex-wrap gap-1 border-b px-3 py-2">
      {nodes.map((n) => <li key={n.id} className="flex min-w-0 max-w-full"><Chip node={n} primary={n.id === primaryId} onPrimary={onPrimary} /></li>)}
    </ul> : null}
    {children}
  </div>;
}

window.ArgosFocus = { FocusPanel, FOCUS_PANEL_WIDTH, focusPanelPx, SHEET_MAX };
})();
