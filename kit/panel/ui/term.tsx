/* Terminal de verdade do painel (xterm.js sobre o WebSocket /api/term/ws). Componente PtyTerminal, exportado em
 * HadesCore e HadesPanel. Toda decisão (offset, recuo, código de fechamento e de recusa) vem de term-logic.tsx;
 * este arquivo liga o xterm, o socket e a tela. Contrato: reference/panel.md §Terminal › Interface.
 * Dono dos recursos: o efeito abaixo cria terminal, socket, timers e observadores e os encerra todos ao desmontar. */
(() => {
const { useState, useEffect, useRef, I, cn, Button, useApp } = HadesCore;
const L = window.TermLogic;
const FONT = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const FONT_SIZE = 13;
const SCROLLBACK_LINES = 5000;
const MIN_CONTRAST = 4.5;
const enc = new TextEncoder();

// ------------------------------------------------------------------ tema (tokens do painel -> cores do xterm)
let probe = null;
// o xterm não entende oklch: a tela resolve o token numa cor e devolve [r, g, b]
function rgbOf(css, fallback) {
  try {
    probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = css.trim();
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  } catch (e) { return fallback; }
}
const hex = (c) => '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((n, i) => Math.round(n + (b[i] - n) * t));
function termTheme(el) {
  const cs = getComputedStyle(el);
  const tok = (n, fb) => rgbOf(cs.getPropertyValue(n) || '', fb);
  const bg = tok('--term', [24, 20, 24]), fg = tok('--term-foreground', [232, 224, 214]);
  const red = tok('--term-bad', [240, 120, 90]), yellow = tok('--term-warn', [230, 190, 90]);
  const dim = tok('--term-muted', mix(bg, fg, 0.5));
  const c = (r, g, b) => [r, g, b];
  return {
    background: hex(bg), foreground: hex(fg), cursor: hex(fg), cursorAccent: hex(bg),
    selectionBackground: `rgba(${fg.join(',')},0.26)`,
    black: hex(mix(bg, fg, 0.12)), red: hex(red), green: hex(c(140, 200, 120)), yellow: hex(yellow), blue: hex(c(110, 160, 230)),
    magenta: hex(c(200, 140, 220)), cyan: hex(c(100, 200, 200)), white: hex(mix(bg, fg, 0.85)),
    brightBlack: hex(dim), brightRed: hex(mix(red, fg, 0.25)), brightGreen: hex(c(165, 225, 145)), brightYellow: hex(mix(yellow, fg, 0.25)),
    brightBlue: hex(c(140, 185, 250)), brightMagenta: hex(c(225, 165, 240)), brightCyan: hex(c(130, 225, 225)), brightWhite: hex(fg),
  };
}

/** Cria um xterm no elemento, com o tema do painel (que acompanha claro/escuro), o fit e os links; é o que o PtyTerminal e o nó
 *  do Argos têm em comum. `readOnly`: o xterm não gera entrada (quem digita é o dono, como no nó do Argos). O cursor é o mesmo nos dois:
 *  pisca com o foco e vira contorno sem ele. Devolve { term, fit, dispose }. */
function createXterm(el, { fontSize, scrollback = SCROLLBACK_LINES, readOnly = false, lineHeight = 1 } = {}) {
  const term = new window.Terminal({
    fontFamily: FONT, fontSize: fontSize || FONT_SIZE, cursorBlink: true, scrollback, minimumContrastRatio: MIN_CONTRAST, lineHeight,
    disableStdin: readOnly, cursorInactiveStyle: 'outline',
    theme: termTheme(el), linkHandler: { activate: (_e, uri) => openLink(uri), allowNonHttpProtocols: false },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  const mo = new MutationObserver(() => { term.options.theme = termTheme(el); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  return { term, fit, dispose() { mo.disconnect(); term.dispose(); } };
}

// ------------------------------------------------------------------ abertura de sessão (lê o Retry-After, que o post() da base não repassa)
async function openSession(body, retry = true) {
  const r = await fetch('/api/term/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panel-Token': window.__TOKEN }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (r.status === 403 && d.error === 'token' && retry) {
    const t = await fetch('/api/token', { cache: 'no-store' }).then((x) => x.json()).catch(() => ({}));
    if (t.token && t.token !== window.__TOKEN) { window.__TOKEN = t.token; return openSession(body, false); }
  }
  if (r.ok) return { ok: true, session: d };
  const ra = Number(r.headers.get('Retry-After'));
  return { ok: false, refusal: L.refusal(d.code, r.status, Number.isFinite(ra) && ra > 0 ? ra : undefined) };
}
const openLink = (raw) => { const u = L.safeUrl(raw); if (u) window.open(u, '_blank', 'noopener,noreferrer'); };
const copyText = (s) => { if (s) navigator.clipboard?.writeText(s).catch(() => {}); };

// ------------------------------------------------------------------ "Abrir terminal" (Orquestração, Argos, Execuções)
// mesma chave da mesa da página Herdr (pages/herdr.tsx TERM_STORE): a sessão aberta aqui entra na mesa e a página a mostra
const DESK_STORE = 'hades-herdr-term';
const DESK_HASH = '#/herdr';
/** `cwd` só serve se for um caminho absoluto, sem `..`, igual a uma raiz permitida ou dentro dela (o servidor confere de novo). */
function cwdWithinRoots(cwd, roots) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.split('/').includes('..')) return null;
  const clean = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  const hit = (Array.isArray(roots) ? roots : []).some((r) => typeof r === 'string' && r !== '' && (clean === r || clean.startsWith(r.endsWith('/') ? r : `${r}/`)));
  return hit ? clean : null;
}
/** A pasta do botão: sem informação do servidor ainda, nenhuma; com a chave desligada, a própria (o clique mostra como ligar);
 *  ligada, só se estiver nas raízes permitidas. `term` = { enabled, roots } de useTermRoots; `null` pula a conferência (o servidor decide). */
function folderFor(cwd, term) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  if (term === undefined) return cwd.startsWith('/') ? cwd : null;
  if (term === null) return null;
  return term.enabled === false ? (cwd.startsWith('/') ? cwd : null) : cwdWithinRoots(cwd, term.roots);
}
/** A mesa (texto guardado) com a sessão `id` acrescentada e ativa. */
function deskWith(raw, id) { return JSON.stringify(L.layoutAdd(L.layoutParse(raw), id)); }
/** Abre a sessão `spec` ({kind, cwd?, session?}) e a põe na mesa da página Herdr. { ok: true, id } ou { ok: false, refusal } (título e dica prontos). */
async function openTerminalAt(spec) {
  const r = await openSession(spec);
  if (!r.ok) return r;
  try { sessionStorage.setItem(DESK_STORE, deskWith(sessionStorage.getItem(DESK_STORE), r.session.id)); }
  catch (e) { /* aba privada: a página abre a sessão pela lista de Sessões */ }
  return { ok: true, id: r.session.id };
}
/** Abre `spec` e leva à página Herdr; recusa vira aviso (chave desligada: como ligar). `app` = { toast, go } do useApp. */
async function openAndGo(spec, app) {
  const r = await openTerminalAt(spec);
  if (r.ok) { if (app.go) app.go('herdr'); else location.hash = DESK_HASH; return true; }
  app.toast({ kind: r.refusal.kind === 'disabled' ? 'info' : 'warn', title: r.refusal.title, desc: r.refusal.hint });
  return false;
}
/** Botão "Abrir terminal" da pasta `cwd`. Com `term` (useTermRoots) e a pasta fora das raízes, não aparece; sem `cwd`, também não. Com a chave
 *  desligada o servidor recusa (term_disabled) e o botão mostra como ligar. */
function OpenTerminalButton({ cwd, term, label = 'Abrir terminal', size = 'xs', variant = 'ghost', className }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const dir = folderFor(cwd, term);
  if (!dir) return null;
  const click = async () => {
    setBusy(true);
    try { await openAndGo({ kind: 'shell', cwd: dir }, app); } finally { setBusy(false); }
  };
  return <Button size={size} variant={variant} className={className} icon={I.SquareTerminal} disabled={busy} onClick={click} title={`Shell em ${dir}`}>{label}</Button>;
}
/** Estado do terminal no servidor (GET /api/term): { enabled, roots }; null enquanto carrega, desligado se não responder. */
function useTermRoots() {
  const [roots, setRoots] = useState(null);
  useEffect(() => {
    let dead = false;
    fetch('/api/term', { cache: 'no-store' }).then((r) => r.json()).then((d) => { if (!dead) setRoots({ enabled: !!d && d.enabled === true, roots: Array.isArray(d && d.roots) ? d.roots : [] }); }).catch(() => { if (!dead) setRoots({ enabled: false, roots: [] }); });
    return () => { dead = true; };
  }, []);
  return roots;
}

/** Terminal de uma sessão PTY. `id` anexa a uma sessão aberta; `open` ({kind, cwd?, resume?, session?}) abre uma e anexa.
 *  onState({phase, ...}) a cada mudança; onExit({code, signal}) quando o processo sai; onOpened(sessão) depois do `open`.
 *  `apiRef`: objeto do dono (barra de teclas do celular) que o terminal preenche com send/paste/focus/toBottom/appCursor/copyable
 *  enquanto está no ar; o dono pode pôr `filter(texto) -> texto` nele para mexer na entrada digitada (Ctrl fixo). */
// a dica da roda sem pane aparece uma vez por carga da página (term-logic.tsx)
const wheelHint = L.createWheelHint();
const WHEEL_HINT_MS = 8000;

function PtyTerminal({ id, open, onExit, onState, onOpened, className, fontSize, apiRef }) {
  const host = useRef(null);
  const [following, setFollowing] = useState(true);
  const [hint, setHint] = useState('');
  const toEnd = useRef(() => {});
  const [phase, setPhase] = useState({ kind: 'opening' });
  const [nonce, setNonce] = useState(0);
  const cb = useRef({});
  cb.current = { onExit, onState, onOpened };
  const sidRef = useRef(null), keyRef = useRef('');
  const openKey = id ? '' : JSON.stringify(open || {});

  useEffect(() => {
    const key = `${id || ''}|${openKey}`;
    if (keyRef.current !== key) { keyRef.current = key; sidRef.current = null; }
    let dead = false, ws = null, term = null, fit = null, attempt = 0, off = L.offsetInitial(), last = null, gotHello = false;
    let timer = 0, ping = 0, fitTimer = 0, settleTimer = 0, hintTimer = 0, ro = null, xt = null, unbindCompose = null;
    // roda em tela alternativa (#18): histórico do pane do herdr, com a regra de volta ao vivo do nó do Argos (term-logic.tsx)
    let info = null, sc = L.scrollLive(), wheelRest = 0, loadingHistory = false, inHistory = false, ovXt = null, ovEl = null;
    const show = (p) => { if (dead) return; setPhase(p); cb.current.onState?.(p); };
    const note = (text) => term?.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
    const send = (data) => { if (ws && ws.readyState === 1) ws.send(data); };
    const sendSize = () => {
      const size = L.clampSize(term.cols, term.rows);
      if (!size || L.sameSize(size, last)) return;
      last = size; send(JSON.stringify({ t: 'resize', cols: size.cols, rows: size.rows }));
    };
    // a janela do histórico tem a grade de antes: só um resize de verdade a descarta (o ResizeObserver também dispara sem mudança)
    const refit = () => {
      const [cols, rows] = [term.cols, term.rows];
      try { fit.fit(); } catch (e) { return; }
      sendSize();
      if (inHistory && (term.cols !== cols || term.rows !== rows)) backToLive();
    };

    // a sessão que mostra um pane do herdr é o `herdr-client`: o painel guarda a sessão do herdr dele (a lista de sessões)
    const sessionInfo = async () => {
      if (info) return info;
      try {
        const d = await fetch('/api/term', { cache: 'no-store' }).then((r) => r.json());
        const mine = Array.isArray(d.sessions) ? d.sessions.find((x) => x.id === sidRef.current) : null;
        if (mine) info = mine;
      } catch (e) { /* sem a lista, a roda segue ao programa */ }
      return info;
    };
    const hasPane = () => !!info && info.kind === 'herdr-client' && typeof info.herdrSession === 'string';
    const showHint = () => {
      setHint(L.WHEEL_HINT_TEXT);
      window.clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => setHint(''), WHEEL_HINT_MS);
    };
    const drawHistory = () => {
      if (!ovXt) {
        ovEl = document.createElement('div');
        ovEl.setAttribute('data-term-history', '');
        ovEl.className = 'pointer-events-none absolute inset-2 overflow-hidden bg-term';
        host.current.parentElement.appendChild(ovEl);
        ovXt = createXterm(ovEl, { fontSize, scrollback: 0, readOnly: true });
        ovXt.term.attachCustomKeyEventHandler(() => false);
      }
      if (ovXt.term.cols !== term.cols || ovXt.term.rows !== term.rows) ovXt.term.resize(term.cols, term.rows);
      ovXt.term.write(L.screenOf(L.historyWindow(sc.lines, term.rows, sc.offset).join('\r\n')));
    };
    function backToLive() {
      sc = L.scrollLive(); wheelRest = 0; inHistory = false;
      if (ovXt) { ovXt.dispose(); ovXt = null; }
      if (ovEl) { ovEl.remove(); ovEl = null; }
      if (term) setFollowing(L.isFollowing(term.buffer.active.viewportY, term.buffer.active.baseY));
    }
    const loadHistory = async () => {
      if (loadingHistory) return;
      loadingHistory = true;
      try {
        const q = `session=${encodeURIComponent(info.herdrSession)}`;
        const overview = await fetch(`/api/herdr?${q}`, { cache: 'no-store' }).then((r) => r.json());
        const pane = L.focusedPaneOf(overview);
        if (!pane) throw new Error('nenhum pane em foco no herdr');
        const r = await fetch(`${L.HISTORY_URL}?pane=${encodeURIComponent(pane)}&lines=${L.HISTORY_LINES}&${q}`, { cache: 'no-store' });
        const body = await r.json();
        if (!r.ok) throw new Error(body && body.error ? String(body.error) : `http_${r.status}`);
        if (dead) return;
        sc = L.historyLoaded(sc, L.historyLinesOf(body.ansi), term.rows);
        if (sc.lines === null) { backToLive(); return; }
        inHistory = true; setFollowing(false); drawHistory();
      } catch (err) {
        if (dead) return;
        backToLive();
        note(`histórico indisponível: ${err instanceof Error ? err.message : 'erro'}`);
      } finally { loadingHistory = false; }
    };
    const onWheel = (e) => {
      const alt = term.buffer.active.type === 'alternate';
      // Ctrl, Alt e Meta são do navegador (zoom); o buffer normal segue com o xterm
      if (!alt || e.ctrlKey || e.altKey || e.metaKey) return true;
      if (L.wheelRoute(alt, hasPane()) === 'program') { if (wheelHint.take()) showHint(); return true; }
      e.preventDefault();
      const grid = term.element?.querySelector('.xterm-screen');
      const turn = L.wheelStep(wheelRest, e, term.rows, grid ? grid.getBoundingClientRect().height / term.rows : NaN);
      wheelRest = turn.rest;
      if (turn.lines === 0) return false;
      const wasLive = sc.lines === null;
      sc = L.wheelScroll(sc, turn.lines, term.rows);
      if (wasLive) { if (sc.pending > 0) void loadHistory(); return false; }
      if (sc.lines === null) backToLive(); else drawHistory();
      return false;
    };

    // queda sem hello: a sessão some da lista ou a chave desliga? Decide pelo dado, não pelo erro do navegador
    const probeServer = async () => {
      try {
        const r = await fetch('/api/term', { cache: 'no-store' });
        const d = await r.json();
        if (dead) return false;
        if (d.enabled === false) { show({ kind: 'refused', refusal: L.refusal(L.CODES.disabled, 403) }); return true; }
        if (Array.isArray(d.sessions) && !d.sessions.some((s) => s.id === sidRef.current)) { show({ kind: 'refused', refusal: L.refusal(L.CODES.unknownSession, 404) }); return true; }
      } catch (e) { /* painel fora do ar: segue o recuo */ }
      return false;
    };
    const retryLater = () => {
      attempt += 1;
      if (L.gaveUp(attempt)) { show({ kind: 'gaveup' }); return; }
      const ms = L.backoffMs(attempt - 1, Math.random());
      show({ kind: 'reconnecting', attempt, inMs: ms });
      timer = window.setTimeout(connect, ms);
    };
    const onMessage = (ev) => {
      if (typeof ev.data !== 'string') {
        const bytes = new Uint8Array(ev.data);
        term.write(bytes);
        off = L.onBytes(off, bytes.byteLength);
        return;
      }
      let m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hello') {
        gotHello = true; attempt = 0; off = L.onHello(off, m); last = null;
        void sessionInfo();
        show({ kind: 'live', exited: m.state === 'exited' });
        sendSize();
        term.focus();
      } else if (m.t === 'warn') {
        off = L.onWarn(off, m);
        const n = L.warnNotice(m);
        if (n) note(n);
      } else if (m.t === 'exit') {
        note(m.signal ? `processo encerrado pelo sinal ${m.signal}` : `processo terminou com código ${m.code ?? '?'}`);
        cb.current.onExit?.({ code: m.code ?? null, signal: m.signal ?? null });
      }
    };
    function connect() {
      if (dead) return;
      gotHello = false;
      ws = new WebSocket(L.socketUrl(location, sidRef.current, L.resumeOffset(off)));
      ws.binaryType = 'arraybuffer';
      const mine = ws;
      ws.onmessage = onMessage;
      ws.onclose = async (ev) => {
        if (dead || mine !== ws) return;
        window.clearInterval(ping);
        const d = L.decideClose(ev.code);
        if (d.action === 'stop') { show({ kind: 'ended', reason: d.reason }); return; }
        if (!gotHello && (await probeServer())) return;
        retryLater();
      };
      ws.onopen = () => { ping = window.setInterval(() => send(JSON.stringify({ t: 'ping' })), L.PING_MS); };
    }
    const wake = () => { if (!dead && document.visibilityState !== 'hidden' && ws && ws.readyState > 1 && timer) { window.clearTimeout(timer); connect(); } };

    (async () => {
      try { await document.fonts?.load(`${fontSize || FONT_SIZE}px "Geist Mono"`); } catch (e) { /* fonte do sistema serve */ }
      if (dead || !host.current) return;
      xt = createXterm(host.current, { fontSize });
      ({ term, fit } = xt);
      refit();
      const sendText = (s) => { for (const c of L.chunkInput(enc.encode(s))) send(c); };
      term.onData((s) => { if (inHistory) backToLive(); const f = apiRef?.current?.filter; sendText(f ? f(s) : s); });
      term.attachCustomWheelEventHandler(onWheel);
      term.buffer.onBufferChange(() => { if (inHistory) backToLive(); });
      term.onBinary((s) => { for (const c of L.chunkInput(Uint8Array.from(s, (ch) => ch.charCodeAt(0)))) send(c); });
      // tecla morta (´ ~ ^ + letra): o Firefox manda a letra base como keydown durante a composição e o xterm a toma por tecla
      const gate = L.composeGate((text) => term.input(text, true), { value: () => term.textarea.value, clear: () => { term.textarea.value = ''; } });
      const onCompose = (e) => { if (e.target === term.textarea && gate.handle(e)) e.stopPropagation(); };
      const composeEvents = ['keydown', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input'];
      const onComposeEnd = () => { window.clearTimeout(settleTimer); settleTimer = window.setTimeout(gate.settle, L.COMPOSE_SETTLE_MS); };
      for (const name of composeEvents) term.element.addEventListener(name, onCompose, true);
      term.element.addEventListener('compositionend', onComposeEnd, true);
      unbindCompose = () => {
        for (const name of composeEvents) term.element.removeEventListener(name, onCompose, true);
        term.element.removeEventListener('compositionend', onComposeEnd, true);
      };
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
        // Ctrl+C com seleção copia (sem seleção segue como interrupção); Ctrl/Cmd+Shift+C sempre copia
        if (mod && k === 'c' && (e.shiftKey || term.hasSelection())) { copyText(term.getSelection()); return false; }
        return true;
      });
      const follow = () => setFollowing(!inHistory && L.isFollowing(term.buffer.active.viewportY, term.buffer.active.baseY));
      term.onScroll(follow);
      term.onWriteParsed(follow);
      toEnd.current = () => { backToLive(); term.scrollToBottom(); setFollowing(true); };
      const api = apiRef?.current;
      if (api) Object.assign(api, {
        send: sendText, paste: (t) => term.paste(t), focus: () => term.focus(), toBottom: toEnd.current,
        appCursor: () => term.modes.applicationCursorKeysMode,
        // xterm não seleciona por toque: sem seleção, "Copiar" leva o que está na tela
        copyable: () => term.getSelection() || Array.from({ length: term.rows }, (_, i) => term.buffer.active.getLine(term.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n').trimEnd(),
      });
      term.registerLinkProvider({
        provideLinks(y, done) {
          const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
          const links = L.findLinks(text).map((l) => ({ range: { start: { x: l.start + 1, y }, end: { x: l.end, y } }, text: l.url, activate: () => openLink(l.url) }));
          done(links.length ? links : undefined);
        },
      });
      ro = new ResizeObserver(() => { window.clearTimeout(fitTimer); fitTimer = window.setTimeout(refit, L.RESIZE_DEBOUNCE_MS); });
      ro.observe(host.current);
      window.addEventListener('online', wake);
      document.addEventListener('visibilitychange', wake);

      if (!sidRef.current) {
        if (id) sidRef.current = id;
        else {
          show({ kind: 'opening' });
          const size = L.clampSize(term.cols, term.rows);
          const r = await openSession({ ...(open || {}), ...(size || {}) });
          if (dead) return;
          if (!r.ok) { show({ kind: 'refused', refusal: r.refusal }); return; }
          sidRef.current = r.session.id;
          cb.current.onOpened?.(r.session);
        }
      }
      show({ kind: 'connecting' });
      connect();
    })();

    return () => {
      dead = true;
      window.clearTimeout(timer); window.clearTimeout(fitTimer); window.clearTimeout(settleTimer); window.clearTimeout(hintTimer); window.clearInterval(ping);
      unbindCompose?.();
      backToLive();
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      ro?.disconnect();
      const api = apiRef?.current;
      if (api) for (const k of ['send', 'paste', 'focus', 'toBottom', 'appCursor', 'copyable']) delete api[k];
      if (ws) { ws.onclose = null; ws.onmessage = null; ws.close(); }
      xt?.dispose();
    };
  }, [id, openKey, nonce, fontSize]);

  const again = () => setNonce((n) => n + 1);
  const p = phase;
  const refused = p.kind === 'refused';
  const text = p.kind === 'opening' ? 'Abrindo o terminal…' : p.kind === 'connecting' ? 'Conectando…'
    : p.kind === 'reconnecting' ? `Conexão perdida. Tentativa ${p.attempt} em ${Math.max(1, Math.round(p.inMs / 1000))} s…`
    : p.kind === 'gaveup' ? 'Sem conexão com o painel.' : p.kind === 'ended' ? (p.reason === 'drop' ? '' : L.reasonText(p.reason)) : '';
  return <div className={cn('relative flex min-h-0 flex-col overflow-hidden bg-term text-term-foreground', className)} data-term-phase={p.kind} data-term-reason={p.reason || undefined}>
    <div className={cn('relative min-h-0 flex-1 p-2', refused && 'invisible')}>
      <div ref={host} className="size-full" role="group" aria-label="Terminal" />
    </div>
    {hint ? <div role="status" data-term-hint className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] border border-border bg-popover px-2 py-1 t-meta text-term-muted">{hint}</div> : null}
    {following || refused ? null : <Button size="sm" variant="outline" icon={I.ArrowDownToLine} className="absolute right-3 bottom-3 min-h-11 bg-popover max-md:min-w-11" onClick={() => { toEnd.current(); apiRef?.current?.focus?.(); }}>Ir ao fim</Button>}
    {refused ? <div className="absolute inset-0 grid place-content-center justify-items-center gap-3 p-6 text-center" role="alert">
      <I.SquareTerminal className="size-6 text-term-muted" aria-hidden="true" />
      <div className="t-section">{p.refusal.title}</div>
      <p className="max-w-md t-body text-term-muted">{p.refusal.hint}</p>
      {p.refusal.kind === 'disabled' ? <a className="t-body text-info hover:underline" href="#/config">Abrir Configurações</a> : null}
      {p.refusal.kind === 'rate' || p.refusal.kind === 'request' || p.refusal.kind === 'failed' ? <Button size="sm" variant="outline" icon={I.RotateCw} onClick={again}>Tentar de novo</Button> : null}
    </div> : null}
    {text ? <div className="flex flex-wrap items-center gap-2 border-t border-border-strong bg-term px-3 py-2 t-meta text-term-muted" role="status">
      <span className="min-w-0 flex-1">{text}</span>
      {p.kind === 'ended' && p.reason === 'replaced' ? <Button size="xs" variant="outline" icon={I.MonitorDown} onClick={again}>Trazer para cá</Button> : null}
      {p.kind === 'gaveup' ? <Button size="xs" variant="outline" icon={I.RotateCw} onClick={again}>Reconectar</Button> : null}
    </div> : null}
  </div>;
}

HadesCore.createXterm = createXterm;
HadesCore.OpenTerminalButton = OpenTerminalButton;
HadesCore.useTermRoots = useTermRoots;
HadesCore.TermOpen = { cwdWithinRoots, folderFor, deskWith, openTerminalAt, openAndGo, DESK_STORE };
HadesCore.PtyTerminal = PtyTerminal;
HadesCore.copyText = copyText;
HadesPanel.PtyTerminal = PtyTerminal;
})();
