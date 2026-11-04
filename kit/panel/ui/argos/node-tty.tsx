/* Terminal do nó de agente no canvas (#/argos), a parte que desenha e coleta: o quadro ANSI que o herdr entrega
 * (`{ pane, revision, cols, rows, ansi }`) é escrito como tela inteira numa instância do xterm (HadesCore.createXterm, de
 * term.tsx: só leitura, sem scrollback, o histórico é a janela do /api/herdr/scrollback), escalado para caber no nó; com o foco, as teclas e a colagem viram `{ text?, keys? }` para `onInput`. Não abre conexão nem monta no
 * nó: quem o usa entrega o quadro e leva a entrada ao herdr. A grade é a do quadro: o componente nunca pede resize.
 * Limite do herdr 0.8.2: não há API que fixe cols×rows de um pane (`pane.resize` só move a divisória entre panes), então o
 * tamanho do nó só muda a escala do quadro (`fitScale`); sobra ou corte vêm da proporção do nó, não de uma medida errada.
 * A área é medida por `clientWidth/clientHeight` (tamanho de layout, em unidades do mundo): `getBoundingClientRect` inclui o
 * zoom do canvas, que a camada HTML já aplica, e a escala saía multiplicada por ele.
 * Teclas de TTY_GLOBAL_KEYS não são consumidas (sobem ao canvas). Ouvinte de documento só existe enquanto `focused`.
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
 * Ctrl+Alt+P abre o compositor sobre o terminal focado e Ctrl+L arma uma conexão a partir dele (sem isto, Ctrl+L limparia
 * a tela do agente). Ctrl+Shift+O abre e fecha o painel do supervisor.
 */
const TTY_CANVAS_KEYS = Object.freeze([
  'Ctrl+Alt+W',
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

/** Escala que faz a grade do quadro caber numa caixa `{ w, h }` (a área do desenho, sem o cabeçalho), entre FIT_MIN e FIT_MAX. */
function fitScale(area, frame) {
  const s = Math.min(area.w / (frame.cols * CELL_W), area.h / (frame.rows * CELL_H));
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

/* frame = { pane, revision, cols, rows, ansi }. `scale` fixa a escala (1 = tamanho natural); sem ela o quadro se ajusta ao
 * espaço do nó. `focused` é do dono: o clique dentro chama onFocus, o clique fora (enquanto focado) chama onBlur. */
function NodeTty({ frame, focused = false, onFocus, onBlur, onInput, scale, headerOnly = false }) {
  const root = useRef(null);
  const area = useRef(null);
  const xt = useRef(null);
  const host = useRef(null);
  const entry = useRef(null);
  const live = useRef(null);
  const pressing = useRef(null);
  const textIn = useRef(null);
  const [fit, setFit] = useState(null);
  const [notice, setNotice] = useState('');
  const [scrolling, setScrolling] = useState(scrollLive());
  const scroll = useRef(scrollLive());
  const wheelRest = useRef(0);
  const loadingHistory = useRef(false);
  const fixed = validScale(scale);
  const problem = frameProblem(frame);
  const history = scrolling.lines === null ? null : scrolling;
  const setScroll = (next) => { scroll.current = next; setScrolling(next); };
  const backToLive = () => { wheelRest.current = 0; setScroll(scrollLive()); };

  live.current = { onInput, setNotice, focused, onWheel: null, ownsWheel: ownsWheel({ headerOnly, problem }), paint: () => {} };
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
    if (pressing.current || selection()) return;
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
      const made = HadesCore.createXterm(host.current, { fontSize: FONT_PX, scrollback: 0, readOnly: true, lineHeight: CELL_H / (FONT_PX * LINE_RATIO) });
      // o xterm só desenha: nenhuma tecla é dele, todas sobem ao nó (que as traduz) e ao canvas
      made.term.attachCustomKeyEventHandler(() => false);
      xt.current = made;
      setTermFocus(made.term, live.current.focused);
      live.current.paint();
    };
    void make();
    return () => { dead = true; if (xt.current) xt.current.dispose(); xt.current = null; };
  }, [drawing]);
  // cada quadro novo é uma tela inteira: sem acumular linhas que o herdr já apagou
  live.current.paint = () => {
    const made = xt.current;
    if (!made || screen === null) return;
    if (made.term.cols !== cols || made.term.rows !== shownRows) made.term.resize(cols, shownRows);
    made.term.write(screen);
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
  const loadHistory = () => {
    if (loadingHistory.current || problem) return Promise.resolve();
    loadingHistory.current = true;
    const session = frame.session ? `&session=${encodeURIComponent(frame.session)}` : '';
    const url = `${HISTORY_URL}?pane=${encodeURIComponent(frame.pane)}&lines=${HISTORY_LINES}${session}`;
    return fetch(url, { cache: 'no-store' })
      .then((r) => r.json().then((body) => { if (!r.ok) throw new Error(body && body.error ? String(body.error) : `http_${r.status}`); return body; }))
      .then((body) => { setNotice(''); setScroll(historyLoaded(scroll.current, historyLinesOf(body.ansi), frame.rows)); })
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
  const copySelection = (text) => {
    const done = () => setNotice('');
    const failed = () => setNotice('Não foi possível copiar');
    if (typeof navigator === 'undefined' || !navigator.clipboard) { failed(); return; }
    navigator.clipboard.writeText(text).then(done, failed);
  };
  const onKeyDown = (e) => {
    if (!focused) return;
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
    const selected = selection();
    if (!selected || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', selected);
  };
  const onPaste = (e) => {
    if (!focused) return;
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!text) return;
    if (text.length <= PASTE_MAX_CHARS) { send(e, { text }); return; }
    e.preventDefault();
    e.stopPropagation();
    setNotice(`Colagem grande demais (limite de ${PASTE_MAX_CHARS} caracteres)`);
  };
  // o arrasto dentro do nó é do navegador (seleção de texto): o canvas não o toma (canvas-engine.tsx, onPointerDown)
  const onPointerDown = () => {
    if (!focused && onFocus) onFocus();
    if (pressing.current) return;
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
  const factor = fixed !== null ? fixed : fit && !problem ? fitScale(fit, { cols: frame.cols, rows: shownRows }) : 1;
  const message = notice || drawError;
  return <div ref={root} role="region" aria-label={label} tabIndex={0} data-tty-wheel={ownsWheel({ headerOnly, problem }) ? '' : undefined} data-tty-focused={focused ? 'true' : 'false'}
    onKeyDown={onKeyDown} onPaste={onPaste} onCopy={onCopy} onPointerDown={onPointerDown}
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
        style={{ width: cols * CELL_W, height: shownRows * CELL_H, transform: `scale(${factor})`, transformOrigin: '0 0', overflow: 'hidden' }} /> : null}
      {message ? <span role="status" className="absolute right-2 bottom-2 left-2 t-meta text-term-warn">{message}</span> : null}
      {history ? <button type="button" data-tty-to-end className="absolute right-2 bottom-2 cursor-pointer border border-border bg-term px-2 py-0.5 t-meta text-term-foreground outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        aria-label="Ir ao fim do terminal" onClick={backToLive}>↓ ir ao fim</button> : null}
    </div>}
  </div>;
}

window.ArgosNodeTty = { NodeTty, frameCursor, setTermFocus, TTY_GLOBAL_KEYS, TTY_CANVAS_KEYS, minSize, translateKey, clipboardIntent, clipboardAction, selectedText, wheelIntent, historyLinesOf, historyWindow, clampOffset, wheelStep, scrollLive, wheelScroll, historyLoaded, ownsWheel, screenLinePx, createTextInput, isCompositionKey, fitScale, areaBox, fitForNode, rowsToShow, cursorOf, screenOf, screenRows, ttyDrawing, oversize, selectionOf };
})();
