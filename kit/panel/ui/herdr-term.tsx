/* Terminal do pane na aba Workspaces da página Herdr (#/herdr): o quadro que o herdr entrega (GET /api/herdr/stream, SSE) é
 * desenhado pelo NodeTty do Argos (argos/node-tty.tsx, importado como está) e a entrada volta por POST /api/herdr/input.
 * Não anexa cliente herdr nem manda resize: o tamanho do pane é da sessão inteira, então o quadro só ganha escala (fitScale).
 * No celular a barra de teclas de mobile-term.tsx fala por `apiRef` (bytes do terminal): `bytesToInput` os traduz para o
 * contrato `{ text?, keys? }` do /api/herdr/input. Script clássico; expõe window.HerdrTerm. Contrato: reference/panel.md §Herdr. */
(() => {
const { useState, useEffect, useRef, useCallback, I, cn, post, Button } = HadesCore;

const STREAM_URL = '/api/herdr/stream';
const INPUT_URL = '/api/herdr/input';
// erros de conexão seguidos, sem nenhuma mensagem no meio (o EventSource religa a cada 3 s) antes de dar o fluxo por caído
const STREAM_FAILS_MAX = 3;
const EVENT_CLOSED = 2;
const QUEUE_MAX = 200;
// teclas que o herdr 0.8.2 recusa (`invalid_key`): as mesmas do nó do Argos, lidas de lá quando ele já carregou
const FALLBACK_BLOCKED = ['Home', 'End', 'PageUp', 'PageDown', 'Delete'];

// bytes que a barra de teclas e o Ctrl fixo produzem -> nome de tecla do contrato do /api/herdr/input
const BYTE_KEYS = {
  '\x1b': 'Escape', '\t': 'Tab', '\r': 'Enter', '\x7f': 'Backspace', '\x1b[Z': 'Shift+Tab',
  '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
  '\x1bOA': 'Up', '\x1bOB': 'Down', '\x1bOC': 'Right', '\x1bOD': 'Left',
};
const CTRL_BYTE = /^[\x01-\x1a]$/;

/** Bytes de terminal -> entrada do contrato: tecla nomeada, Ctrl+letra ou texto. `null` se não há o que enviar. */
function bytesToInput(bytes) {
  if (typeof bytes !== 'string' || bytes === '') return null;
  if (Object.hasOwn(BYTE_KEYS, bytes)) return { keys: [BYTE_KEYS[bytes]] };
  if (CTRL_BYTE.test(bytes)) return { keys: [`Ctrl+${String.fromCharCode(bytes.charCodeAt(0) + 64)}`] };
  return { text: bytes };
}

const blockedKeys = () => (window.ArgosNodeTerminal && window.ArgosNodeTerminal.TTY_BLOCKED_KEYS) || FALLBACK_BLOCKED;

/** Entrada sem as teclas que o herdr recusa; `null` quando não sobra nada. */
function cleanInput(input) {
  if (!input || typeof input !== 'object') return null;
  const blocked = blockedKeys();
  const keys = (Array.isArray(input.keys) ? input.keys : []).filter((k) => typeof k === 'string' && !blocked.includes(k));
  const text = typeof input.text === 'string' && input.text !== '' ? input.text : null;
  if (text === null && keys.length === 0) return null;
  return { ...(text !== null ? { text } : {}), ...(keys.length ? { keys } : {}) };
}

const streamUrl = (session, pane) => `${STREAM_URL}?session=${encodeURIComponent(session)}&panes=${encodeURIComponent(pane)}`;

const parseData = (raw) => {
  if (typeof raw !== 'string') return null;
  try { const d = JSON.parse(raw); return d && typeof d === 'object' ? d : null; } catch (e) { return null; }
};
const validFrame = (d, pane) => d.pane === pane && typeof d.ansi === 'string' && Number.isInteger(d.cols) && Number.isInteger(d.rows) && typeof d.revision === 'number';

/** O quadro ao vivo do pane. `state`: connecting | live | exited | down (fluxo caído: a página mostra a saída em texto). */
function useHerdrFrame(session, pane, attempt) {
  const [s, setS] = useState({ state: 'connecting', frame: null, error: '' });
  useEffect(() => {
    setS({ state: 'connecting', frame: null, error: '' });
    const es = new EventSource(streamUrl(session, pane));
    let fails = 0, revision = -1;
    const on = (type, fn) => es.addEventListener(type, (m) => {
      const d = parseData(m && m.data);
      if (d) { fails = 0; fn(d); }
    });
    on('frame', (d) => {
      if (!validFrame(d, pane) || d.revision < revision) return;
      revision = d.revision;
      setS({ state: 'live', frame: { ...d, session }, error: '' });
    });
    on('exited', (d) => { if (d.pane === pane) setS((p) => ({ ...p, state: 'exited' })); });
    // `error` é nome de evento do servidor (com `data`) e também o erro de conexão do EventSource (sem `data`)
    es.addEventListener('error', (m) => {
      const d = parseData(m && m.data);
      if (d) { setS((p) => ({ ...p, error: typeof d.message === 'string' ? d.message : String(d.code) })); return; }
      fails += 1;
      if (es.readyState === EVENT_CLOSED || fails >= STREAM_FAILS_MAX) setS((p) => ({ ...p, state: 'down' }));
    });
    return () => es.close();
  }, [session, pane, attempt]);
  return s;
}

/** Fila de entrada de um pane: um POST por vez, textos seguidos viram um envio só (a ordem se mantém). */
function createInputQueue(send, onError, take) {
  let items = [], busy = false, dead = false;
  const drain = async () => {
    if (busy || dead || items.length === 0) return;
    const { batch, rest } = take(items);
    items = rest; busy = true;
    try { await send(batch); onError(''); } catch (e) { onError(e && e.message ? e.message : 'sem resposta do painel'); } finally { busy = false; }
    await drain();
  };
  return {
    push(input) { const c = cleanInput(input); if (!c || items.length >= QUEUE_MAX) return; items.push(c); void drain(); },
    close() { dead = true; items = []; },
  };
}
const takeAll = (items) => (window.ArgosNodeTerminal ? window.ArgosNodeTerminal.takeInputBatch(items) : { batch: items[0], rest: items.slice(1) });

const KEEP = '[data-term-keybar], [data-herdr-keep]';

/**
 * O terminal do pane. `apiRef` (celular) recebe send/focus/paste/copyable/appCursor da barra de teclas. O foco do teclado fica
 * no textarea do NodeTty; tocar na barra ou no cabeçalho não o tira dele (o NodeTty tiraria: para ele, fora do nó é "fora").
 */
function HerdrTerminal({ session, pane, apiRef, autoFocus = false, onState, className }) {
  const [attempt, setAttempt] = useState(0);
  const [focused, setFocused] = useState(autoFocus);
  const [inputError, setInputError] = useState('');
  const { state, frame, error } = useHerdrFrame(session, pane, attempt);
  useEffect(() => { if (onState) onState(state); }, [state]);
  const box = useRef(null), queue = useRef(null), keep = useRef(false);
  useEffect(() => {
    const q = createInputQueue((body) => post(INPUT_URL, { session, pane, ...body }), setInputError, takeAll);
    queue.current = q;
    return () => { q.close(); queue.current = null; };
  }, [session, pane]);
  // roda antes do ouvinte do NodeTty (registrado depois, ao focar): marca o toque que deve manter o foco
  useEffect(() => {
    const f = (e) => { keep.current = !!(e.target && e.target.closest && e.target.closest(KEEP)); };
    document.addEventListener('pointerdown', f, true);
    return () => document.removeEventListener('pointerdown', f, true);
  }, []);
  const entry = () => (box.current ? box.current.querySelector('[data-tty-input]') : null);
  const focusNow = useCallback(() => { setFocused(true); const el = entry(); if (el) el.focus({ preventScroll: true }); }, []);
  // o clique é o gesto que o iOS exige para abrir o teclado; sem isso o campo só ganha foco no efeito do NodeTty
  const onTap = () => { const sel = typeof getSelection === 'function' ? getSelection() : null; if (!sel || sel.isCollapsed) focusNow(); };
  const send = useCallback((input) => { if (queue.current) queue.current.push(input); }, []);
  useEffect(() => {
    const api = apiRef && apiRef.current;
    if (!api) return undefined;
    Object.assign(api, {
      send: (bytes) => send(bytesToInput(bytes)), paste: (t) => send({ text: t }), focus: focusNow, appCursor: () => false,
      copyable: () => { const g = box.current && box.current.querySelector('[data-tty-grid]'); return (g && g.innerText ? g.innerText : '').trimEnd(); },
    });
    return () => { for (const k of ['send', 'paste', 'focus', 'appCursor', 'copyable']) delete api[k]; };
  }, [apiRef, send, focusNow]);
  // o NodeTty é lido na hora de desenhar: argos/node-tty.js carrega depois das páginas
  const Tty = window.ArgosNodeTty && window.ArgosNodeTty.NodeTty;
  const lost = state === 'down' || state === 'exited';
  const note = state === 'exited' ? 'O pane saiu.' : state === 'down' ? 'Sem fluxo ao vivo: a saída em texto abaixo segue atualizando.' : error || inputError;
  return <div ref={box} data-herdr-term={state} className={cn('relative flex min-h-0 flex-1 flex-col', className)} onClick={onTap}>
    {frame && !lost && Tty ? <Tty frame={frame} focused={focused} onFocus={focusNow}
      onBlur={() => { if (!keep.current) setFocused(false); }} onInput={send} />
      : <div className="flex min-h-0 flex-1 items-center justify-center border bg-term p-4 t-meta text-term-muted">
        {state === 'connecting' ? 'conectando ao terminal…' : note}
      </div>}
    {note && frame && !lost && Tty ? <span role="status" className="shrink-0 px-2 py-1 t-meta text-term-warn">{note}</span> : null}
    {lost ? <Button size="xs" variant="outline" className="absolute top-2 right-2" icon={I.RefreshCw} onClick={() => setAttempt((n) => n + 1)}>Reconectar</Button> : null}
  </div>;
}

window.HerdrTerm = { HerdrTerminal, bytesToInput, cleanInput, streamUrl, createInputQueue, validFrame, STREAM_FAILS_MAX };
})();
