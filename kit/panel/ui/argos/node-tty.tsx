/* Terminal do nó de agente no canvas (#/argos), a parte que desenha e coleta: o quadro ANSI que o herdr entrega
 * (`{ pane, revision, cols, rows, ansi }`) é escrito como tela inteira numa instância do xterm (HadesCore.createXterm, de
 * term.tsx: só leitura, sem scrollback, o histórico é a janela do /api/herdr/scrollback), escalado para caber no nó; com o foco, as teclas e a colagem viram `{ text?, keys? }` para `onInput`. Não abre conexão nem monta no
 * nó: quem o usa entrega o quadro e leva a entrada (e o pedido de tamanho) ao herdr.
 * Com `onResize` (herdr do fork, com `pane.set_size`) o nó calcula cols×rows pela área e pela célula real do xterm e pede essa
 * grade com debounce; com a grade aplicada o quadro vai em escala 1. Sem `onResize` (herdr 0.8.2, ou nó em miniatura), o tamanho
 * do nó só muda a escala do quadro (`fitScale`). O cursor é o do quadro (`frame.cursor`); sem ele, a estimativa pelo texto.
 * Um cliente anexado ditaria o tamanho da sessão inteira, e o `set_size` o vence: reference/argos.md §Tamanho do terminal do nó.
 * A área é medida por `clientWidth/clientHeight` (tamanho de layout, em unidades do mundo): `getBoundingClientRect` inclui o
 * zoom do canvas, que a camada HTML já aplica, e a escala saía multiplicada por ele.
 * Teclas de TTY_GLOBAL_KEYS não são consumidas (sobem ao canvas). Ouvinte de documento só existe enquanto `focused`.
 * Links: URL http(s) abre em nova aba (noopener) e caminho absoluto de arquivo pede ao dono (`onOpenPath`); o servidor decide a raiz.
 * Busca: Ctrl+F no nó focado abre a barra (tela + scrollback); Esc fecha. A regra pura é de tty-extras.tsx (window.ArgosTtyExtras).
 * O xterm só existe com o nó legível (`headerOnly` falso); distante, fica o cabeçalho e o xterm é descartado.
 * Script clássico, carregado depois de ui/argos/node-terminal.js e de term.js. Expõe window.ArgosNodeTty. */
(() => {
const { useState, useEffect, useRef, cn } = HadesCore;
const T = window.CanvasModel.termAnsi;
// a regra de rolagem do histórico é a da página Terminal (term-logic.tsx, carregado antes): uma só
const { HISTORY_LINES, HISTORY_URL, historyLinesOf, clampOffset, historyWindow, wheelStep, scrollLive, wheelScroll, historyLoaded, screenOf, guessCursor } = window.TermLogic;

// célula do terminal na escala 1: Geist Mono (e as fontes mono do fallback) avançam 0,6 em por caractere
const FONT_PX = 13;
const CELL_W = FONT_PX * 0.6;
const CELL_H = 17;
const PAD = 6;
const HEADER_H = 28;
const MIN_COLS = 20;
const MIN_ROWS = 6;
// altura de linha por tamanho de fonte que o xterm usa na tela (o DOM do xterm arredonda para cima): calibra o lineHeight
const LINE_RATIO = 1.17;
const FIT_MIN = 0.2;
const FIT_MAX = 2;
const MAX_COLS = 1000;
// limites da grade que o herdr aceita em pane.set_size (herdr-page.ts SIZE_LIMITS): o nó nunca pede fora deles
const SIZE_LIMITS = Object.freeze({ minCols: 4, maxCols: 1000, minRows: 2, maxRows: 500 });
// o pedido de tamanho espera o nó parar de mexer (arrastar a borda, zoom do texto) antes de ir ao herdr
const RESIZE_DEBOUNCE_MS = 150;
// mesmo teto de texto que o servidor aceita num envio (herdr-page.ts MAX_TEXT): colar mais seria recusado lá
const PASTE_MAX_CHARS = 20_000;

// nomes de tecla do contrato de `onInput`; o servidor ainda só aceita parte deles (herdr-page.ts KEYS), quem liga o canal alarga
const NAMED_KEYS = {
  Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Backspace: 'Backspace', Delete: 'Delete',
};
const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'];
const DIGIT_CODE = /^(?:Digit|Numpad)([1-9])$/;

/** Teclas que o canvas trata: o terminal em foco não as consome, elas sobem como se o foco não estivesse nele. */
const TTY_GLOBAL_KEYS = Object.freeze(['Ctrl+Shift+A', 'Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6', 'Alt+7', 'Alt+8', 'Alt+9', 'Alt', 'Ctrl+]']);
/**
 * Teclas do terminal criado no canvas que também sobem: fechar é Ctrl+Alt+W (Ctrl+W é do navegador); sem isto chegaria ao
 * agente como o texto "w". Lista à parte porque o comando só existe quando a página liga a porta dos terminais.
 * Ctrl+Alt+= / Ctrl+Alt+- / Ctrl+Alt+0 aumentam, diminuem e voltam a 100% o texto do terminal focado.
 * Ctrl+Alt+P abre o compositor sobre o terminal focado e Ctrl+L arma uma conexão a partir dele (sem isto, Ctrl+L limparia
 * a tela do agente). Ctrl+Shift+O abre e fecha o painel do supervisor.
 */
const TTY_CANVAS_KEYS = Object.freeze([
  'Ctrl+Alt+W',
  // zoom do texto do terminal focado (o nó cresce ou encolhe na proporção do quadro)
  'Ctrl+Alt+=', 'Ctrl+Alt++', 'Ctrl+Alt+Shift++', 'Ctrl+Alt+-', 'Ctrl+Alt+0',
  'Ctrl+Alt+P',
  'Ctrl+L',
  'Ctrl+Shift+O',
]);

const isSingleChar = (key) => typeof key === 'string' && [...key].length === 1;

/** Nome canônico do acorde de um keydown (`Ctrl+Shift+A`, `Alt+1`, `Alt`, `Ctrl+]`); Alt+dígito vem do `code`, porque a tecla muda com o layout. */
function chordOf(e) {
  if (e.key === 'Alt') return 'Alt';
  const mods = [e.ctrlKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean);
  const digit = e.altKey && typeof e.code === 'string' ? DIGIT_CODE.exec(e.code) : null;
  const base = digit ? digit[1] : isSingleChar(e.key) ? e.key.toUpperCase() : e.key;
  return [...mods, base].join('+');
}

const isGlobalKey = (e) => !e.metaKey && (TTY_GLOBAL_KEYS.includes(chordOf(e)) || TTY_CANVAS_KEYS.includes(chordOf(e)));

/**
 * keydown → `{ text }` (caractere imprimível) ou `{ keys: [nome] }`; `null` quando o terminal não consome: tecla global,
 * modificador sozinho, composição de IME, Meta, Ctrl+V (a colagem chega pelo evento `paste`), e o que o contrato não nomeia
 * (F1…, setas com Ctrl ou Alt). Nomes: Enter, Escape, Tab, Shift+Tab, Up, Down, Left, Right, Home, End, PageUp, PageDown,
 * Backspace, Delete, Ctrl+A..Ctrl+Z.
 */
function translateKey(e) {
  if (isCompositionKey(e) || isGlobalKey(e)) return null;
  if (e.metaKey || MODIFIER_KEYS.includes(e.key)) return null;
  const named = NAMED_KEYS[e.key];
  if (named) return e.ctrlKey || e.altKey ? null : { keys: [e.key === 'Tab' && e.shiftKey ? 'Shift+Tab' : named] };
  if (!isSingleChar(e.key)) return null;
  // AltGr chega como Ctrl+Alt e produz o caractere de verdade (@, €…)
  if (e.ctrlKey && e.altKey) return { text: e.key };
  if (e.ctrlKey) {
    const letter = e.key.toUpperCase();
    return !e.shiftKey && /^[A-Z]$/.test(letter) && letter !== 'V' ? { keys: [`Ctrl+${letter}`] } : null;
  }
  return e.altKey ? null : { text: e.key };
}

/**
 * Entrada por texto composto (tecla morta, IME): o `textarea` escondido do nó recebe a composição e esta máquina entrega o que
 * foi montado UMA vez a `emit`. `box` é o `textarea` (só `value` é lido e zerado). Durante a composição nada sai; no
 * `compositionend` sai `data` (ou o que o campo tiver) e o campo é zerado, de modo que o `input` que alguns navegadores
 * disparam depois do fim da composição já a encontra vazia. Sem composição (teclado que digita `é` direto), o `input` entrega.
 */
function createTextInput(box, emit) {
  let composing = false;
  const flush = (text) => {
    box.value = '';
    if (text) emit(text);
  };
  return {
    compositionStart() { composing = true; },
    /** Há composição aberta: o navegador ainda monta o texto, e os keydown da letra base não são teclas (nem todos marcam isComposing). */
    busy() { return composing; },
    compositionEnd(data) {
      composing = false;
      flush(typeof data === 'string' && data !== '' ? data : box.value);
    },
    input(isComposing) {
      if (composing || isComposing) return;
      flush(box.value);
    },
  };
}

/**
 * O que um keydown pede da área de transferência, dado se há texto selecionado na grade: `copy` (Ctrl+Shift+C sempre; Ctrl+C
 * ou Cmd+C só com seleção, porque sem ela Ctrl+C é o SIGINT do agente) ou `null` (segue o caminho normal: tecla ao pane).
 * Ctrl+V e Ctrl+Shift+V não passam por aqui: a colagem chega pelo evento `paste`.
 */
function clipboardIntent(e, hasSelection) {
  if (e.altKey || typeof e.key !== 'string' || e.key.toLowerCase() !== 'c') return null;
  if (e.ctrlKey && e.shiftKey && !e.metaKey) return 'copy';
  return hasSelection && (e.ctrlKey !== e.metaKey) && !e.shiftKey ? 'copy' : null;
}

/**
 * A roda sobre o terminal: `canvas` com Ctrl ou Alt (zoom e pan seguem do canvas em qualquer lugar), `own` nas demais, que o
 * terminal consome (a página não rola e o canvas não mexe) para rolar o histórico (`/api/herdr/scrollback`, `source: "recent"`).
 */
const wheelIntent = (e) => (e.ctrlKey || e.altKey ? 'canvas' : 'own');

/** Altura de uma linha NA TELA: a medida inclui a escala do quadro e o zoom do canvas, que é o que a roda precisa (a escala de encaixe usa o tamanho de layout). */
const screenLinePx = (grid, rows) => (grid && rows > 0 ? grid.getBoundingClientRect().height / rows : CELL_H);

/**
 * Arrasto de um dedo como roda: o dedo que desce mostra o histórico mais antigo, como a roda para cima (deltaY negativo).
 * `fromY`/`toY` são clientY de dois movimentos seguidos; devolve o evento em pixels que `wheelStep` já entende.
 */
const touchWheel = (fromY, toY) => ({ deltaY: fromY - toY, deltaMode: 0 });

/** O terminal só é dono da roda quando é legível: distante (cabeçalho) ou com problema no quadro, a roda é do canvas (zoom). */
const ownsWheel = ({ headerOnly, problem }) => !headerOnly && !problem;

/** Texto selecionado dentro de `grid` (a seleção do navegador, que acompanha o DOM mesmo com a grade escalada); `''` se não há. */
function selectedText(grid) {
  const sel = typeof getSelection === 'function' ? getSelection() : null;
  if (!grid || !sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
  const inside = (n) => !!n && grid.contains(n.nodeType === 1 ? n : n.parentNode);
  return inside(sel.anchorNode) && inside(sel.focusNode) ? sel.toString() : '';
}

/** Seleção do nó: a do xterm quando há, senão a do navegador dentro da grade. */
const selectionOf = (term, grid) => (term && term.hasSelection() ? term.getSelection() : selectedText(grid));

/** Tecla de uma composição em curso (o `textarea` a trata): nem o terminal nem o compositor do canvas a consomem. */
const isCompositionKey = (e) => e.isComposing === true || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead';

/** Ctrl+Shift+V cola e Ctrl+Shift+C copia a seleção, como num emulador de terminal; pelo `code`, para valer em todo layout. */
function clipboardAction(e) {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null;
  if (e.code === 'KeyV') return 'paste';
  if (e.code === 'KeyC') return 'copy';
  return null;
}

/** Tamanho mínimo do nó na escala 1: cabeçalho e ~20×6 células (menos, se o quadro for menor que isso). */
function minSize(frame) {
  const cols = Math.min(MIN_COLS, frame && frame.cols > 0 ? frame.cols : MIN_COLS);
  const rows = Math.min(MIN_ROWS, frame && frame.rows > 0 ? frame.rows : MIN_ROWS);
  return { w: Math.ceil(cols * CELL_W + 2 * PAD), h: Math.ceil(HEADER_H + rows * CELL_H + 2 * PAD) };
}

/** Célula do terminal na escala 1 com o zoom do texto `zoom` (a medida real do xterm vence quando ele a dá). */
function cellSize(zoom, measured) {
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (measured && ok(measured.w) && ok(measured.h)) return { w: measured.w, h: measured.h };
  const z = validScale(zoom) || 1;
  return { w: CELL_W * z, h: CELL_H * z };
}

/** Célula medida pelo xterm (`dimensions.css.cell`, px de CSS, sem o zoom do canvas); `null` até ele desenhar a primeira vez. */
function measureCell(term) {
  // API interna do xterm: sem outra forma de ler a métrica real da fonte; ausente, cellSize cai na estimativa
  const cell = term && term._core && term._core._renderService && term._core._renderService.dimensions
    && term._core._renderService.dimensions.css && term._core._renderService.dimensions.css.cell;
  return cell && cell.width > 0 && cell.height > 0 ? { w: cell.width, h: cell.height } : null;
}

/** Grade (cols × rows) que cabe numa área de desenho `{ w, h }` com a célula `cell`, nos limites do herdr; `null` se a área não mede. */
function gridFor(area, cell) {
  if (!area || !cell || !(area.w > 0) || !(area.h > 0) || !(cell.w > 0) || !(cell.h > 0)) return null;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  return {
    cols: clamp(Math.floor(area.w / cell.w), SIZE_LIMITS.minCols, SIZE_LIMITS.maxCols),
    rows: clamp(Math.floor(area.h / cell.h), SIZE_LIMITS.minRows, SIZE_LIMITS.maxRows),
  };
}

/** Debounce do pedido de tamanho: só o último `push` dentro de `ms` chega a `send`; `cancel` solta o pedido pendente (desmontagem). */
function resizeDebounce(send, ms = RESIZE_DEBOUNCE_MS, timers = { set: (fn, t) => setTimeout(fn, t), clear: (h) => clearTimeout(h) }) {
  let pending = null;
  return {
    push(grid) {
      if (pending !== null) timers.clear(pending);
      pending = timers.set(() => { pending = null; send(grid); }, ms);
    },
    cancel() {
      if (pending !== null) timers.clear(pending);
      pending = null;
    },
  };
}

/** O quadro já tem a grade pedida: dali em diante ele vai em escala 1 (a escala só cobre a espera e o herdr sem suporte). */
const sizeApplied = (frame, want) => !!want && !!frame && frame.cols === want.cols && frame.rows === want.rows;

/** Escala que faz a grade do quadro caber numa caixa `{ w, h }` (a área do desenho, sem o cabeçalho), entre FIT_MIN e FIT_MAX. */
function fitScale(area, frame, cell = { w: CELL_W, h: CELL_H }) {
  const s = Math.min(area.w / (frame.cols * cell.w), area.h / (frame.rows * cell.h));
  return Number.isFinite(s) ? Math.min(FIT_MAX, Math.max(FIT_MIN, s)) : 1;
}

/** Espaço de desenho `{ w, h }` de uma área de `clientW × clientH` (tamanho de layout, sem o transform do canvas), sem o respiro. */
function areaBox(clientW, clientH) {
  const inner = (n) => (Number.isFinite(n) ? Math.max(0, Math.round(n - 2 * PAD)) : 0);
  return { w: inner(clientW), h: inner(clientH) };
}

/** Escala do quadro para um nó de `size = { w, h }` na escala 1 do canvas (cabeçalho incluso), qualquer que seja o zoom. */
function fitForNode(size, frame) {
  return fitScale(areaBox(size.w, size.h - HEADER_H), frame);
}

/** Grade do quadro com o respiro, na escala `scale`: o tamanho da área de desenho em que `fitScale` daria exatamente `scale`. */
function gridBox(frame, scale) {
  return { w: frame.cols * CELL_W * scale + 2 * PAD, h: frame.rows * CELL_H * scale + 2 * PAD };
}

/** Limites da escala do quadro (os mesmos de `fitScale`). */
const SCALE_LIMITS = Object.freeze({ min: FIT_MIN, max: FIT_MAX });

const validScale = (s) => (typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : null);

/** Quadro que o componente não desenha (vem de fora): motivo, ou `null` se serve. */
function frameProblem(frame) {
  if (!frame || typeof frame !== 'object') return 'quadro ausente';
  if (typeof frame.ansi !== 'string') return 'quadro sem texto';
  const grid = (n, max) => Number.isInteger(n) && n >= 1 && n <= max;
  return grid(frame.cols, MAX_COLS) && grid(frame.rows, T.TERM_LIMITS.lines) ? null : 'grade do quadro inválida';
}

const NOTICE = {
  [T.TERM_ERRORS.tooManyBytes]: 'Quadro grande demais para desenhar',
  [T.TERM_ERRORS.tooManyLines]: 'Quadro com linhas demais para desenhar',
};

const NO_HISTORY = 'Sem histórico para rolar';
// a busca reaproveita o histórico carregado por este tempo (cada tecla da consulta refaria a leitura do scrollback)
const SEARCH_HISTORY_TTL_MS = 3000;
const EMPTY_SEARCH = Object.freeze({ query: '', matches: [], index: -1, truncated: false, merged: [] });
/** Regra de links e busca (tty-extras.tsx, carregado antes); lida na hora de usar. */
const extras = () => window.ArgosTtyExtras;
/** O evento nasceu dentro da barra de busca do nó: o terminal não o trata (teclas, colagem, foco). */
const inSearchBar = (e) => !!(e && e.target && typeof e.target.closest === 'function' && e.target.closest('[data-tty-search]'));

/**
 * Provedor de links do xterm: URL http(s) e caminho absoluto da linha; `open(link)` é a ação do clique. A linha vem do buffer do
 * xterm (texto puro, sem ANSI); `y` é 1-based.
 */
function linkProviderOf(term, open) {
  return {
    provideLinks(y, done) {
      const line = term.buffer.active.getLine(y - 1);
      const found = line && extras() ? extras().linksOf(line.translateToString(true)) : [];
      done(found.length === 0 ? undefined : found.map((l) => ({
        range: { start: { x: l.start + 1, y }, end: { x: l.end, y } },
        text: l.kind === 'url' ? l.url : l.path,
        activate: () => open(l),
      })));
    },
  };
}

/** Clique num link: URL abre em nova aba sem dar a janela ao destino; caminho vai ao dono, que pede ao servidor. */
function activateLink(link, onOpenPath) {
  if (link.kind === 'url') { window.open(link.url, '_blank', 'noopener,noreferrer'); return; }
  if (extras().openablePath(link.path) && typeof onOpenPath === 'function') onOpenPath(link.path);
}

const FOCUS_RING = 'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

/**
 * Cursor do quadro, quando quem o produz o entrega (`frame.cursor = { row, col, visible? }`, base 0): célula dentro da grade e
 * não escondido. O herdr 0.8.2 não expõe o cursor em nenhuma leitura (§Terminal do nó): sem o campo, nada é desenhado.
 */
function cursorOf(frame) {
  const c = frame && frame.cursor;
  if (!c || typeof c !== 'object' || c.visible === false) return null;
  const inside = (n, max) => Number.isInteger(n) && n >= 0 && n < max;
  return inside(c.row, frame.rows) && inside(c.col, frame.cols) ? { row: c.row, col: c.col } : null;
}

/** O cursor a desenhar: o que o produtor entrega, senão a estimativa pelo texto (o herdr 0.8.2 não o entrega; term-logic.tsx guessCursor). */
function frameCursor(frame) {
  if (!frame) return null;
  // o produtor que entrega o campo decide (inclusive escondê-lo): a estimativa só cobre quem não o entrega
  if (frame.cursor && typeof frame.cursor === 'object') return cursorOf(frame);
  return guessCursor(frame.ansi, frame.cols, frame.rows);
}

/**
 * O xterm só mostra o cursor «com foco» quando o textarea DELE tem o foco, mas o teclado do nó vive no textarea escondido do
 * próprio nó (composição, colagem). Em vez de roubar o foco, o nó dá ao xterm os mesmos eventos de foco e desfoco que o
 * navegador daria: ele pisca com o foco e vira contorno sem ele, como o PtyTerminal. Sem textarea (xterm ainda não aberto), nada.
 */
function setTermFocus(term, focused) {
  const field = term && term.textarea;
  if (!field) return;
  field.dispatchEvent(new FocusEvent(focused ? 'focus' : 'blur'));
}

/** Linhas da grade: as do quadro, ou as do texto quando ele traz mais (sem contar as vazias do fim além do quadro). */
function rowsToShow(rows, lines) {
  let n = lines.length;
  while (n > rows && lines[n - 1].length === 0) n--;
  return Math.max(rows, n);
}

/** O que o nó desenha para o nível de detalhe: o xterm (texto legível) ou o resumo leve (só o cabeçalho). */
const ttyDrawing = (headerOnly) => (headerOnly ? 'summary' : 'xterm');

/**
 * A roda não é do xterm: sem scrollback (o nó o desliga), ele a converte em setas e a cancela com `stopPropagation`, então nem o
 * ouvinte do nó nem o canvas (zoom com Ctrl/Alt) a recebiam. Com o gancho devolvendo `false` ele a ignora e o evento sobe.
 */
function muteXtermWheel(term) {
  term.attachCustomWheelEventHandler(() => false);
}

/** Quadro grande demais para escrever no xterm: o aviso, ou `null`. */
function oversize(ansi) {
  if (ansi.length > T.TERM_LIMITS.bytes) return NOTICE[T.TERM_ERRORS.tooManyBytes];
  let n = 1;
  for (let i = ansi.indexOf('\n'); i !== -1; i = ansi.indexOf('\n', i + 1)) if (++n > T.TERM_LIMITS.lines) return NOTICE[T.TERM_ERRORS.tooManyLines];
  return null;
}

/** Linhas do quadro que o xterm mostra: as do quadro, ou as do texto quando ele traz mais (sem as vazias do fim além do quadro). */
function screenRows(rows, ansi) {
  return rowsToShow(rows, String(ansi).split(/\r?\n/));
}

/* frame = { pane, revision, cols, rows, ansi, cursor? }. `onResize({ cols, rows })` pede ao herdr a grade que cabe no nó (debounce); `textZoom` é o zoom da fonte. `scale` fixa a escala (1 = tamanho natural); sem ela o quadro se ajusta ao
 * espaço do nó. `focused` é do dono: o clique dentro chama onFocus, o clique fora (enquanto focado) chama onBlur. */
function NodeTty({ frame, focused = false, onFocus, onBlur, onInput, scale, headerOnly = false, textZoom = 1, onResize, onOpenPath }) {
  const root = useRef(null);
  const area = useRef(null);
  const xt = useRef(null);
  const host = useRef(null);
  const entry = useRef(null);
  const live = useRef(null);
  const zoomRef = useRef(1);
  const pressing = useRef(null);
  const textIn = useRef(null);
  const [fit, setFit] = useState(null);
  const [measured, setMeasured] = useState(null);
  const [notice, setNotice] = useState('');
  const [scrolling, setScrolling] = useState(scrollLive());
  const scroll = useRef(scrollLive());
  const wheelRest = useRef(0);
  const touchY = useRef(null);
  const loadingHistory = useRef(false);
  // busca: null = fechada; o espelho em ref é o que os eventos assíncronos leem (o estado do render fica velho entre eles)
  const [search, setSearch] = useState(null);
  const searchRef = useRef(null);
  const searchInput = useRef(null);
  const searchSeq = useRef(0);
  const searchHistory = useRef({ lines: null, at: 0, fresh: false });
  const lit = useRef(false);
  const fixed = validScale(scale);
  const zoom = validScale(textZoom) || 1;
  zoomRef.current = zoom;
  const problem = frameProblem(frame);
  const history = scrolling.lines === null ? null : scrolling;
  const setScroll = (next) => { scroll.current = next; setScrolling(next); };
  const backToLive = () => { wheelRest.current = 0; setScroll(scrollLive()); };

  live.current = { onResize, onInput, onOpenPath, setNotice, focused, frame, searchOpen: search !== null, onWheel: null, ownsWheel: ownsWheel({ headerOnly, problem }), paint: () => {} };
  // a composição precisa de um campo de texto: com o foco do teclado no nó, ele vai para o `textarea` escondido
  if (textIn.current === null) {
    textIn.current = createTextInput({
      get value() { return entry.current ? entry.current.value : ''; },
      set value(v) { if (entry.current) entry.current.value = v; },
    }, (text) => { live.current.setNotice(''); if (live.current.onInput) live.current.onInput({ text }); });
  }
  // com o ponteiro apertado, ou com texto selecionado na grade, o foco do campo espera: focá-lo desfaria a seleção
  const gridOf = () => (root.current ? root.current.querySelector('[data-tty-grid]') : null);
  const selection = () => selectionOf(xt.current && xt.current.term, gridOf());
  const focusEntry = () => {
    const el = entry.current || root.current;
    if (!live.current.focused || !el || document.activeElement === el) return;
    if (pressing.current || selection() || live.current.searchOpen) return;
    el.focus({ preventScroll: true });
  };
  useEffect(() => { focusEntry(); }, [focused]);
  useEffect(() => () => { if (pressing.current) pressing.current(); }, []);

  // clique fora tira o foco; o ouvinte existe só enquanto focado e sai junto com o componente
  useEffect(() => {
    if (!focused) return undefined;
    const onDown = (e) => { if (root.current && !root.current.contains(e.target) && onBlur) onBlur(); };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [focused, onBlur]);

  // a escala automática acompanha o tamanho de layout do espaço de desenho; o zoom do canvas não entra na medida. O nó
  // monta e desmonta com o nível de detalhe e ganha largura/altura depois do primeiro desenho: remede também no quadro seguinte
  useEffect(() => {
    const el = area.current;
    if (fixed !== null || headerOnly || !el) return undefined;
    const measure = () => {
      const box = areaBox(el.clientWidth, el.clientHeight);
      setFit((prev) => (prev && prev.w === box.w && prev.h === box.h ? prev : box));
    };
    measure();
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : null;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (observer) observer.observe(el);
    return () => {
      if (observer) observer.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [fixed, headerOnly]);

  // com quem leva o pedido ao herdr (onResize), a grade vem da área e da célula real; sem ele, o quadro só se escala
  const cell = cellSize(zoom, measured);
  const resizing = typeof onResize === 'function' && fixed === null && !headerOnly;
  const want = resizing && fit ? gridFor(fit, cell) : null;
  const wantCols = want ? want.cols : 0;
  const wantRows = want ? want.rows : 0;
  useEffect(() => {
    if (!wantCols || !wantRows) return undefined;
    const debounce = resizeDebounce((grid) => { if (live.current.onResize) live.current.onResize(grid); });
    debounce.push({ cols: wantCols, rows: wantRows });
    return debounce.cancel;
  }, [wantCols, wantRows]);

  let shownAnsi = '';
  let drawError = problem;
  if (!problem && !headerOnly) {
    // em modo histórico a tela é a janela do histórico; o quadro ao vivo volta com "ir ao fim"
    shownAnsi = history ? historyWindow(history.lines, frame.rows, history.offset).join('\r\n') : frame.ansi;
    drawError = oversize(shownAnsi);
  }
  const drawing = !problem && ttyDrawing(headerOnly) === 'xterm' && !drawError;
  const shownRows = problem ? 0 : screenRows(frame.rows, shownAnsi);
  const cursor = history ? null : frameCursor(frame);
  const screen = drawing ? screenOf(shownAnsi, cursor) : null;
  const cols = problem ? 0 : frame.cols;

  // o xterm vive enquanto o nó é legível; o dono do recurso é este efeito (descarta o terminal, o observador de tema e o relógio)
  useEffect(() => {
    if (!drawing || !host.current || !HadesCore.createXterm) return undefined;
    let dead = false;
    const make = async () => {
      try { await document.fonts?.load('13px "Geist Mono"'); } catch (e) { /* fonte do sistema serve */ }
      if (dead || !host.current) return;
      const made = HadesCore.createXterm(host.current, { fontSize: FONT_PX * zoomRef.current, scrollback: 0, readOnly: true, lineHeight: CELL_H / (FONT_PX * LINE_RATIO) });
      // o xterm só desenha: nenhuma tecla é dele, todas sobem ao nó (que as traduz) e ao canvas
      made.term.attachCustomKeyEventHandler(() => false);
      muteXtermWheel(made.term);
      if (extras()) made.term.registerLinkProvider(linkProviderOf(made.term, (link) => activateLink(link, live.current.onOpenPath)));
      // a métrica só existe depois do primeiro desenho: sem remedir, a grade fica na estimativa e sobra faixa à direita e embaixo
      made.term.onRender(() => live.current.measure());
      xt.current = made;
      setTermFocus(made.term, live.current.focused);
      live.current.paint();
      live.current.measure();
    };
    void make();
    return () => { dead = true; if (xt.current) xt.current.dispose(); xt.current = null; };
  }, [drawing]);
  // a métrica da fonte vem do xterm depois que ele desenha; o zoom do texto muda a fonte e a mede de novo
  live.current.measure = () => {
    const next = measureCell(xt.current && xt.current.term);
    setMeasured((prev) => (prev && next && prev.w === next.w && prev.h === next.h ? prev : next));
  };
  useEffect(() => {
    const made = xt.current;
    if (!made || zoom === made.term.options.fontSize / FONT_PX) return undefined;
    made.term.options.fontSize = FONT_PX * zoom;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => live.current.measure()) : null;
    return () => { if (raf !== null) cancelAnimationFrame(raf); };
  }, [zoom, drawing]);
  // cada quadro novo é uma tela inteira: sem acumular linhas que o herdr já apagou
  live.current.paint = () => {
    const made = xt.current;
    if (!made || screen === null) return;
    if (made.term.cols !== cols || made.term.rows !== shownRows) made.term.resize(cols, shownRows);
    made.term.write(screen, () => live.current.highlight());
  };
  useEffect(() => { live.current.paint(); }, [screen, cols, shownRows]);
  useEffect(() => { if (xt.current) setTermFocus(xt.current.term, focused); }, [focused]);

  const send = (e, input) => {
    e.preventDefault();
    e.stopPropagation();
    setNotice('');
    backToLive();
    if (onInput) onInput(input);
  };
  // `wheel` nativo e não passivo: o do React é passivo e não deixaria impedir a rolagem da página por baixo
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (wheelIntent(e) !== 'own' || !live.current.ownsWheel) return;
      e.preventDefault();
      if (live.current.onWheel) live.current.onWheel(e);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const fetchHistoryBody = () => {
    const session = frame.session ? `&session=${encodeURIComponent(frame.session)}` : '';
    const url = `${HISTORY_URL}?pane=${encodeURIComponent(frame.pane)}&lines=${HISTORY_LINES}${session}`;
    return fetch(url, { cache: 'no-store' })
      .then((r) => r.json().then((body) => { if (!r.ok) throw new Error(body && body.error ? String(body.error) : `http_${r.status}`); return body; }));
  };
  const loadHistory = () => {
    if (loadingHistory.current || problem) return Promise.resolve();
    loadingHistory.current = true;
    return fetchHistoryBody()
      .then((body) => {
        const next = historyLoaded(scroll.current, historyLinesOf(body.ansi), frame.rows);
        // tela alternativa (less, vim): o herdr só guarda a tela visível, não há o que rolar
        setNotice(next.lines === null ? NO_HISTORY : '');
        setScroll(next);
      })
      .catch((err) => { setNotice(`Histórico indisponível: ${err instanceof Error ? err.message : 'erro'}`); backToLive(); })
      .finally(() => { loadingHistory.current = false; });
  };
  live.current.onWheel = (e) => {
    const turn = wheelStep(wheelRest.current, e, frame.rows, screenLinePx(gridOf(), shownRows));
    wheelRest.current = turn.rest;
    if (turn.lines === 0) return;
    const wasLive = scroll.current.lines === null;
    setScroll(wheelScroll(scroll.current, turn.lines, frame.rows));
    if (wasLive && scroll.current.pending > 0) void loadHistory();
  };
  // ---- busca (Ctrl+F): tela e scrollback, próximo/anterior com volta, destaque pela seleção do xterm ----
  const searchHistoryLines = async () => {
    const cache = searchHistory.current;
    if (cache.fresh && Date.now() - cache.at < SEARCH_HISTORY_TTL_MS) return cache.lines;
    try {
      const lines = historyLinesOf((await fetchHistoryBody()).ansi);
      searchHistory.current = { lines, at: Date.now(), fresh: true };
      return lines;
    } catch (err) {
      live.current.setNotice(`Histórico indisponível, buscando só na tela: ${err instanceof Error ? err.message : 'erro'}`);
      searchHistory.current = { lines: null, at: Date.now(), fresh: true };
      return null;
    }
  };
  // leva a janela até o achado: no fim do histórico é a tela ao vivo, acima dele a janela do histórico que o contém
  const reveal = (state) => {
    const match = state.matches[state.index];
    const rows = live.current.frame.rows;
    const off = extras().offsetFor(match.line, state.merged.length, rows);
    if (off === 0) backToLive(); else setScroll({ lines: state.merged, offset: off, pending: 0 });
  };
  // `dir`: 0 = consulta nova (vai ao achado mais recente), 1 = próximo, -1 = anterior (os dois dão a volta nas pontas)
  const runSearch = async (query, dir) => {
    const X = extras();
    const q = X.normalizeQuery(query);
    const seq = ++searchSeq.current;
    const history = q === '' || problem ? null : await searchHistoryLines();
    if (seq !== searchSeq.current || searchRef.current === null) return;
    const f = live.current.frame;
    const merged = X.searchLines(history, String(f.ansi).split(/\r?\n/), f.rows);
    const { matches, truncated } = X.findMatches(merged, q);
    const index = matches.length === 0 ? -1 : dir === 0 ? matches.length - 1 : X.stepMatch(matches.length, searchRef.current.index, dir);
    const next = { query: q, matches, index, truncated, merged };
    searchRef.current = next;
    setSearch(next);
    if (index >= 0) reveal(next);
  };
  const openSearch = () => {
    if (searchRef.current === null) searchRef.current = EMPTY_SEARCH;
    live.current.searchOpen = true;
    setSearch(searchRef.current);
    setNotice('');
    requestAnimationFrame(() => { if (searchInput.current) { searchInput.current.focus({ preventScroll: true }); searchInput.current.select(); } });
  };
  const closeSearch = () => {
    searchSeq.current += 1;
    searchRef.current = null;
    searchHistory.current = { lines: null, at: 0, fresh: false };
    live.current.searchOpen = false;
    setSearch(null);
    if (xt.current && lit.current) { xt.current.term.clearSelection(); lit.current = false; }
    focusEntry();
  };
  const onSearchQuery = (value) => {
    const q = extras().normalizeQuery(value);
    searchRef.current = { ...(searchRef.current || EMPTY_SEARCH), query: q };
    setSearch(searchRef.current);
    void runSearch(q, 0);
  };
  const onSearchKey = (e) => {
    // as teclas globais do Argos seguem subindo mesmo com o foco na barra
    if (isGlobalKey(e)) return;
    e.stopPropagation();
    if (isCompositionKey(e)) return;
    const intent = extras().searchKeyIntent(e);
    if (intent === 'close') { e.preventDefault(); closeSearch(); return; }
    if (intent === 'next' || intent === 'prev') { e.preventDefault(); if (searchRef.current) void runSearch(searchRef.current.query, intent === 'next' ? 1 : -1); return; }
    if (extras().isSearchChord(e)) { e.preventDefault(); if (searchInput.current) searchInput.current.select(); }
  };
  const step = (dir) => { if (searchRef.current) void runSearch(searchRef.current.query, dir); };
  // posição do achado atual na janela que está na tela; o histórico mostrado tem de ser o da busca (senão a linha não é a mesma)
  const found = search && search.index >= 0 && !problem ? search.matches[search.index] : null;
  const foundAt = !found ? null
    : history ? (history.lines === search.merged ? extras().matchInWindow(found, history.lines.length, frame.rows, history.offset) : null)
    : extras().matchInWindow(found, search.merged.length, frame.rows, 0);
  live.current.foundAt = foundAt;
  live.current.highlight = () => {
    const made = xt.current;
    if (!made) return;
    const at = live.current.foundAt;
    if (at) { made.term.select(at.col, at.row, Math.min(at.len, Math.max(1, made.term.cols - at.col))); lit.current = true; }
    else if (lit.current) { made.term.clearSelection(); lit.current = false; }
  };
  const foundKey = foundAt ? `${foundAt.row}:${foundAt.col}:${foundAt.len}` : '';
  useEffect(() => { live.current.highlight(); }, [foundKey, drawing]);
  // o dono do campo da busca: o nó deixa de ser legível (distante, quadro com problema) e a barra sai junto
  useEffect(() => { if ((headerOnly || problem) && searchRef.current !== null) closeSearch(); }, [headerOnly, !!problem]);

  const copySelection = (text) => {
    const done = () => setNotice('');
    const failed = () => setNotice('Não foi possível copiar');
    if (typeof navigator === 'undefined' || !navigator.clipboard) { failed(); return; }
    navigator.clipboard.writeText(text).then(done, failed);
  };
  const onKeyDown = (e) => {
    if (!focused || inSearchBar(e)) return;
    if (!headerOnly && !problem && extras() && !textIn.current.busy() && extras().isSearchChord(e)) {
      e.preventDefault();
      e.stopPropagation();
      openSearch();
      return;
    }
    if (clipboardAction(e) === 'paste') {
      e.preventDefault();
      e.stopPropagation();
      void pasteFromClipboard();
      return;
    }
    const selected = selection();
    if (clipboardIntent(e, selected !== '') === 'copy') {
      e.preventDefault();
      e.stopPropagation();
      if (selected) copySelection(selected);
      else setNotice('Selecione o texto com o mouse para copiar');
      return;
    }
    const field = entry.current;
    if (field && e.target !== field && !selected) field.focus({ preventScroll: true });
    if (textIn.current.busy()) return;
    const input = translateKey(e);
    if (input) send(e, input);
  };
  // Ctrl+Shift+V: o navegador só solta o evento `paste` em campo editável, então a leitura é pela Clipboard API
  const pasteFromClipboard = async () => {
    setNotice('');
    let text = '';
    try { text = navigator.clipboard ? await navigator.clipboard.readText() : ''; }
    catch (err) { console.warn('terminal: leitura da área de transferência recusada', err); setNotice('O navegador não liberou a área de transferência: use Ctrl+V'); return; }
    if (!text) return;
    if (text.length > PASTE_MAX_CHARS) { setNotice(`Colagem grande demais (limite de ${PASTE_MAX_CHARS} caracteres)`); return; }
    if (onInput) onInput({ text });
  };
  // copiar pelo menu do navegador: o texto vem da grade, não do campo escondido
  const onCopy = (e) => {
    if (inSearchBar(e)) return;
    const selected = selection();
    if (!selected || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', selected);
  };
  const onPaste = (e) => {
    if (!focused || inSearchBar(e)) return;
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!text) return;
    if (text.length <= PASTE_MAX_CHARS) { send(e, { text }); return; }
    e.preventDefault();
    e.stopPropagation();
    setNotice(`Colagem grande demais (limite de ${PASTE_MAX_CHARS} caracteres)`);
  };
  // dedo sobre o nó legível: o arrasto vertical rola o histórico (o canvas não toma o gesto sobre o nó e o host tem touch-action: none)
  const onTouchMove = (e) => {
    if (e.pointerType !== 'touch' || touchY.current === null || !live.current.ownsWheel || !live.current.onWheel) return;
    live.current.onWheel(touchWheel(touchY.current, e.clientY));
    touchY.current = e.clientY;
  };
  const endTouch = (e) => { if (e.pointerType === 'touch') touchY.current = null; };
  // o arrasto dentro do nó é do navegador (seleção de texto): o canvas não o toma (canvas-engine.tsx, onPointerDown)
  const onPointerDown = (e) => {
    if (e && e.pointerType === 'touch') touchY.current = e.clientY;
    if (!focused && onFocus) onFocus();
    // clique na barra de busca é do campo dela: o foco do terminal não o toma de volta
    if (pressing.current || inSearchBar(e)) return;
    const release = () => {
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
      pressing.current = null;
      focusEntry();
    };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    pressing.current = release;
  };

  const label = problem ? 'Terminal' : `Terminal ${frame.pane}`;
  const applied = !problem && sizeApplied(frame, want);
  const factor = fixed !== null ? fixed : applied ? 1 : fit && !problem ? fitScale(fit, { cols: frame.cols, rows: shownRows }, cell) : 1;
  const message = notice || drawError;
  return <div ref={root} role="region" aria-label={label} tabIndex={0} data-tty-wheel={ownsWheel({ headerOnly, problem }) ? '' : undefined} data-tty-focused={focused ? 'true' : 'false'}
    onKeyDown={onKeyDown} onPaste={onPaste} onCopy={onCopy} onPointerDown={onPointerDown} onPointerMove={onTouchMove} onPointerUp={endTouch} onPointerCancel={endTouch}
    className={cn('relative flex h-full min-h-0 flex-col border bg-term text-term-foreground', FOCUS_RING, focused ? 'border-foreground' : 'border-border')}>
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 t-meta text-term-muted" style={{ height: HEADER_H }}>
      <span className="min-w-0 flex-1 truncate t-data">{problem ? 'terminal' : frame.pane}</span>
      {!problem ? <span className="t-data shrink-0">{frame.cols}×{frame.rows}</span> : null}
      {focused ? <span className="t-meta-em shrink-0 text-term-foreground">teclado no terminal</span> : null}
    </div>
    {headerOnly ? null : <textarea ref={entry} data-tty-input aria-label={`Entrada do ${label}`} tabIndex={-1} spellCheck={false} autoCapitalize="off" autoCorrect="off" rows={1}
      className="pointer-events-none absolute top-0 left-0 m-0 resize-none overflow-hidden border-0 p-0 opacity-0" style={{ width: 1, height: 1 }}
      onCompositionStart={() => textIn.current.compositionStart()} onCompositionEnd={(e) => textIn.current.compositionEnd(e.data)}
      onInput={(e) => textIn.current.input(e.nativeEvent && e.nativeEvent.isComposing === true)} />}
    {headerOnly ? null : <div ref={area} className="relative min-h-0 flex-1 overflow-hidden" style={{ padding: PAD }}>
      {/* texto com mais linhas que o quadro anuncia (pane que acabou de crescer) não perde as de baixo: o xterm mostra todas */}
      {drawing ? <div ref={host} data-tty-grid data-tty-engine="xterm" data-tty-cols={cols} data-tty-rows={shownRows} className="relative select-text"
        style={{ width: cols * cell.w, height: shownRows * cell.h, transform: `scale(${factor})`, transformOrigin: '0 0', overflow: 'hidden' }} /> : null}
      {search ? <div data-tty-search role="search" className="absolute top-1 right-3 z-10 flex items-center gap-1 border border-border bg-term px-1 py-0.5">
        <input ref={searchInput} data-tty-search-input type="text" aria-label="Buscar no terminal" placeholder="Buscar" spellCheck={false} autoComplete="off" maxLength={extras().QUERY_MAX}
          value={search.query} onChange={(e) => onSearchQuery(e.target.value)} onKeyDown={onSearchKey}
          className="w-40 min-w-0 border-0 bg-transparent p-0 t-data text-term-foreground outline-none placeholder:text-term-muted" />
        <span role="status" aria-live="polite" data-tty-search-count className="min-w-12 shrink-0 text-right t-meta text-term-muted">{extras().searchCount(search.query, search.matches.length, search.index, search.truncated)}</span>
        <button type="button" data-tty-search-prev aria-label="Resultado anterior" onClick={() => step(-1)} className={cn('cursor-pointer px-1 t-meta text-term-foreground hover:bg-accent', FOCUS_RING)}>↑</button>
        <button type="button" data-tty-search-next aria-label="Próximo resultado" onClick={() => step(1)} className={cn('cursor-pointer px-1 t-meta text-term-foreground hover:bg-accent', FOCUS_RING)}>↓</button>
        <button type="button" data-tty-search-close aria-label="Fechar a busca" onClick={closeSearch} className={cn('cursor-pointer px-1 t-meta text-term-foreground hover:bg-accent', FOCUS_RING)}>✕</button>
      </div> : null}
      {message ? <span role="status" className="absolute right-2 bottom-2 left-2 t-meta text-term-warn">{message}</span> : null}
      {history ? <button type="button" data-tty-to-end className="absolute right-2 bottom-2 cursor-pointer border border-border bg-term px-2 py-0.5 t-meta text-term-foreground outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        aria-label="Ir ao fim do terminal" onClick={backToLive}>↓ ir ao fim</button> : null}
    </div>}
  </div>;
}

window.ArgosNodeTty = { NodeTty, muteXtermWheel, frameCursor, setTermFocus, TTY_GLOBAL_KEYS, TTY_CANVAS_KEYS, minSize, translateKey, clipboardIntent, clipboardAction, selectedText, wheelIntent, touchWheel, historyLinesOf, historyWindow, clampOffset, wheelStep, scrollLive, wheelScroll, historyLoaded, ownsWheel, screenLinePx, createTextInput, isCompositionKey, fitScale, gridFor, cellSize, measureCell, sizeApplied, resizeDebounce, SIZE_LIMITS, RESIZE_DEBOUNCE_MS, areaBox, fitForNode, gridBox, SCALE_LIMITS, rowsToShow, cursorOf, screenOf, screenRows, ttyDrawing, oversize, selectionOf, linkProviderOf, activateLink, inSearchBar };
})();
