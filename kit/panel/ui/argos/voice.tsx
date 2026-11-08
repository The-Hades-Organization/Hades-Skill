/* Vista de voz do Mark (reference/argos.md §Mark §Voz): folha em tela cheia com o botão de segurar para falar, o interruptor de
 * conversa aberta, o medidor de nível, a orbe com o estado e as últimas falas. O áudio sai do microfone por um AudioWorklet
 * (16 kHz PCM16) direto para /api/mark/voice e volta em PCM16 24 kHz para outro worklet; nada é transcrito, gravado nem guardado
 * aqui. O token do Mark nunca chega ao navegador (o painel o lê). Carregada sob demanda por node-mark.tsx (openVoice); ao
 * carregar, monta o próprio host no <body>; `window.ArgosVoice.open()` abre a folha. Script clássico: publica window.ArgosVoice. */
(() => {
const { useState, useEffect, useRef, I, cn } = HadesCore;
const L = window.ArgosVoiceLogic;

const EVENTS_URL = '/api/mark/events';
const CAPTURE_MODULE = '/ui/argos/voice-capture-worklet.js';
const PLAY_MODULE = '/ui/argos/voice-play-worklet.js';
const LINES_SHOWN = 6;
const LEVEL_TICK_MS = 80;
const VIBRATE_DOWN_MS = 25;
const VIBRATE_UP_MS = 12;
/** Estados do Mark por nome e cor da orbe; o nó mark.tsx é o dono da tabela, aqui só a leitura. */
const tones = () => (window.ArgosNodeMark && window.ArgosNodeMark.STATE_TONE) || {};

const buzz = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* sem vibração: o botão continua valendo */ } };

async function loadTexts() {
  const ctl = new AbortController();
  const guard = setTimeout(() => ctl.abort(), L.INFO_TIMEOUT_MS);
  try {
    const r = await fetch(L.VOICE_PATH, { cache: 'no-store', signal: ctl.signal });
    const body = await r.json();
    return body && body.explain ? body : { explain: {}, mode: 'ptt' };
  } catch {
    return { explain: {}, mode: 'ptt' };
  } finally {
    clearTimeout(guard);
  }
}

/* Sessão de voz: microfone, worklets, WebSocket e Wake Lock vivem e morrem juntos com `start`/`stop`. */
function useVoiceSession() {
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);
  const [markState, setMarkState] = useState(null);
  const [mode, setModeState] = useState('ptt');
  const [pressed, setPressed] = useState(false);
  const [level, setLevel] = useState(0);
  const [away, setAway] = useState(false);
  const [maxS, setMaxS] = useState(null);
  const [lines, setLines] = useState([]);
  const r = useRef({});

  const fail = (code, served) => {
    const s = r.current;
    setError(L.explainFor(code, served, s.texts && s.texts.explain));
    setPhase('error');
    teardown(false);
  };

  function teardown(sendBye) {
    const s = r.current;
    s.alive = false;
    if (s.retry) clearTimeout(s.retry);
    if (s.meter) clearInterval(s.meter);
    s.retry = s.meter = null;
    if (s.proto && sendBye && s.ws && s.ws.readyState === 1) { try { s.proto.bye(); } catch { /* socket já caiu */ } }
    if (s.ws) { s.ws.onclose = s.ws.onmessage = s.ws.onerror = null; try { s.ws.close(); } catch { /* já fechado */ } }
    if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
    if (s.capture) { s.capture.port.onmessage = null; s.capture.disconnect(); }
    if (s.play) s.play.disconnect();
    if (s.ctx && s.ctx.state !== 'closed') s.ctx.close().catch(() => undefined);
    if (s.events) s.events.close();
    if (s.wake) s.wake.release().catch(() => undefined);
    r.current = { texts: s.texts };
    setPressed(false);
    setLevel(0);
  }

  function connect() {
    const s = r.current;
    if (!s.alive) return;
    const ws = new WebSocket(L.voiceUrl(window.location));
    ws.binaryType = 'arraybuffer';
    s.ws = ws;
    const proto = L.createVoiceProtocol((obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }, s.mode);
    if (s.proto) { if (s.proto.down) proto.ptt(true); }
    s.proto = proto;
    ws.onopen = () => proto.hello();
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') { if (s.play) s.play.port.postMessage(event.data, [event.data]); return; }
      let msg = null;
      try { msg = JSON.parse(event.data); } catch { return; }
      const got = proto.receive(msg);
      if (got.kind === 'ready') { s.attempt = 0; setMaxS(got.maxS); setPhase('live'); setError(null); }
      else if (got.kind === 'state') setMarkState(got.state);
      else if (got.kind === 'interrupted') { if (s.play) s.play.port.postMessage({ clear: true }); }
      else if (got.kind === 'busy' || got.kind === 'error') { s.fatal = true; fail(got.code, got.explain); }
    };
    ws.onclose = () => {
      if (!s.alive || s.fatal) return;
      if (s.attempt >= L.RECONNECT_TRIES) return fail('mark_voice_unavailable', null);
      setPhase('reconnecting');
      s.retry = setTimeout(connect, L.reconnectMs(s.attempt));
      s.attempt += 1;
    };
  }

  const start = async () => {
    teardown(false);
    const s = r.current;
    s.alive = true;
    s.attempt = 0;
    setPhase('connecting');
    setError(null);
    setMarkState(null);
    setLines([]);
    setAway(false);
    s.texts = await loadTexts();
    s.mode = L.MODES.includes(s.texts.mode) ? s.texts.mode : 'ptt';
    setModeState(s.mode);
    if (!s.alive) return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return fail('mark_voice_insecure_context', null);
    try {
      // o contexto nasce no toque que abriu a folha: o navegador só deixa tocar áudio depois de um gesto
      s.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      s.ctx.resume().catch(() => undefined);
      s.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (err) {
      return fail(L.micErrorCode(err, window.isSecureContext), null);
    }
    if (!s.alive) return;
    try {
      await Promise.all([s.ctx.audioWorklet.addModule(CAPTURE_MODULE), s.ctx.audioWorklet.addModule(PLAY_MODULE)]);
    } catch {
      return fail('mark_voice_failed', null);
    }
    if (!s.alive) return;
    s.capture = new AudioWorkletNode(s.ctx, 'voice-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    s.ctx.createMediaStreamSource(s.stream).connect(s.capture);
    s.play = new AudioWorkletNode(s.ctx, 'voice-play', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    s.play.connect(s.ctx.destination);
    s.peak = 0;
    s.capture.port.onmessage = (event) => {
      const buf = event.data;
      s.peak = Math.max(s.peak, L.levelOfPcm16(new Int16Array(buf)));
      if (s.proto && s.ws && s.ws.readyState === 1 && s.proto.canSend(buf.byteLength)) s.ws.send(buf);
    };
    s.meter = setInterval(() => { setLevel(s.peak); s.peak = 0; }, LEVEL_TICK_MS);
    holdWake();
    s.events = window.PanelStream ? window.PanelStream.open(EVENTS_URL) : new EventSource(EVENTS_URL);
    s.events.addEventListener('log', (event) => {
      try {
        const v = JSON.parse(event.data);
        if (v && typeof v.text === 'string') setLines((cur) => [...cur, v].slice(-LINES_SHOWN));
      } catch { /* quadro inválido: ignora */ }
    });
    connect();
  };

  function holdWake() {
    const s = r.current;
    if (!s.alive || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then((lock) => { if (s.alive) s.wake = lock; else lock.release().catch(() => undefined); }).catch(() => undefined);
  }

  // aba em segundo plano ou tela apagada: o Android corta o microfone; ao voltar, religa o que caiu e avisa
  useEffect(() => {
    const onVisible = () => {
      const s = r.current;
      if (!s.alive) return;
      if (document.hidden) { setAway(true); return; }
      s.ctx && s.ctx.state === 'suspended' && s.ctx.resume().catch(() => undefined);
      holdWake();
      if (s.ws && s.ws.readyState > 1 && !s.fatal && !s.retry) { s.attempt = 0; connect(); }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  useEffect(() => () => teardown(true), []);

  const press = (down) => {
    const s = r.current;
    if (!s.proto || !!s.pressed === down) return;
    s.pressed = down;
    setPressed(down);
    s.proto.ptt(down);
    buzz(down ? VIBRATE_DOWN_MS : VIBRATE_UP_MS);
  };
  const setMode = (next) => {
    const s = r.current;
    s.mode = next;
    setModeState(next);
    if (s.proto) s.proto.setMode(next);
  };
  const dismissAway = () => setAway(false);
  return { phase, error, markState, mode, pressed, level, away, maxS, lines, start, stop: () => teardown(true), press, setMode, dismissAway };
}

function Meter({ level, active }) {
  return (
    <div className="h-2 w-full overflow-hidden bg-muted" role="meter" aria-label="Nível do microfone" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
      <div className={cn('h-full transition-[width] duration-75', active ? 'bg-ok' : 'bg-muted-foreground')} style={{ width: `${Math.round(level * 100)}%` }} />
    </div>
  );
}

function Sheet({ onClose }) {
  const v = useVoiceSession();
  useEffect(() => { v.start(); }, []);
  // espaço segurado fala no desktop, fora de campos de texto
  useEffect(() => {
    const down = (e) => { if (e.code === 'Space' && !e.repeat && !L.isTypingTarget(e.target)) { e.preventDefault(); v.press(true); } };
    const up = (e) => { if (e.code === 'Space' && !L.isTypingTarget(e.target)) { e.preventDefault(); v.press(false); } };
    const blur = () => v.press(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, []);
  const live = v.phase === 'live';
  const [label, tone] = (v.markState && tones()[v.markState.state]) || ['Aguardando', 'bg-muted-foreground'];
  const status = { connecting: 'Conectando…', reconnecting: 'Religando…', live: label, error: 'Sem voz', idle: '' }[v.phase];
  const close = () => { v.stop(); onClose(); };
  return (
    <div role="dialog" aria-modal="true" aria-label="Voz do Mark" className="fixed inset-0 z-[100] flex flex-col gap-4 overflow-auto bg-background p-4 text-foreground max-md:pb-8">
      <div className="mx-auto flex w-full max-w-md items-center gap-3">
        <span aria-hidden="true" className={cn('size-12 shrink-0 rounded-full', live ? tone : 'bg-muted-foreground', live && v.markState && v.markState.state === 'SPEAKING' && 'motion-safe:animate-pulse')} />
        <div className="min-w-0 flex-1">
          <div className="t-meta-em truncate">{(v.markState && v.markState.name) || 'Mark'}</div>
          <div className="t-meta text-muted-foreground" role="status">{status}{live && v.maxS ? ` · sessão de até ${Math.round(v.maxS / 60)} min` : ''}</div>
        </div>
        <button type="button" onClick={close} className="inline-flex min-h-11 items-center gap-1 border px-3 t-body outline-none focus-visible:outline-2 focus-visible:outline-ring"><I.X className="size-4" />Encerrar</button>
      </div>
      {v.error ? (
        <div role="alert" className="mx-auto flex w-full max-w-md flex-col gap-1 border border-bad p-3">
          <div className="t-meta-em text-bad">{v.error.title}</div>
          <div className="t-body">{v.error.cause}</div>
          <div className="t-body text-muted-foreground">{v.error.action}</div>
          <button type="button" onClick={() => v.start()} className="mt-2 min-h-11 self-start border px-3 t-body outline-none focus-visible:outline-2 focus-visible:outline-ring">Tentar de novo</button>
        </div>
      ) : null}
      {v.away ? (
        <div role="status" className="mx-auto flex w-full max-w-md items-center gap-2 border border-warn p-3 t-body">
          <span className="min-w-0 flex-1">A tela apagou ou a aba foi para segundo plano: o celular pode ter cortado o microfone. Se o Mark não ouvir, encerre e abra a voz de novo.</span>
          <button type="button" onClick={v.dismissAway} className="min-h-11 border px-3 outline-none focus-visible:outline-2 focus-visible:outline-ring">Ok</button>
        </div>
      ) : null}
      <ol aria-label="Últimas falas" className="mx-auto min-h-0 w-full max-w-md flex-1 overflow-auto t-body scrollbar-thin">
        {v.lines.length === 0 ? <li className="t-meta text-muted-foreground">Nada dito ainda.</li> : v.lines.map((line, i) => (
          <li key={i} className={cn('break-words', line.speaker === 'jarvis' ? 'text-info' : line.speaker === 'sys' ? 'text-muted-foreground' : 'text-foreground')}>
            <span className="t-meta-em mr-1.5">{line.speaker === 'jarvis' ? 'Mark' : line.speaker === 'user' ? 'Você' : 'Ação'}</span>{line.text}
          </li>
        ))}
      </ol>
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3">
        <Meter level={v.level} active={live && (v.pressed || v.mode === 'open')} />
        <label className="flex min-h-11 w-full items-center gap-3 t-body">
          <input type="checkbox" role="switch" checked={v.mode === 'open'} disabled={!live} onChange={(e) => v.setMode(e.target.checked ? 'open' : 'ptt')} className="size-5" />
          Conversa aberta <span className="t-meta text-muted-foreground">(sem segurar; use fone para evitar eco)</span>
        </label>
        <button
          type="button" disabled={!live || v.mode === 'open'} aria-pressed={v.pressed} aria-label="Segurar para falar"
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); v.press(true); }}
          onPointerUp={() => v.press(false)} onPointerCancel={() => v.press(false)} onLostPointerCapture={() => v.press(false)}
          onContextMenu={(e) => e.preventDefault()}
          style={{ touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
          className={cn('flex size-40 max-md:size-44 items-center justify-center rounded-full border-2 outline-none focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50', v.pressed ? 'border-ok bg-ok text-background' : 'bg-card')}
        >
          {v.mode === 'open' ? <I.Mic className="size-12" /> : v.pressed ? <I.Mic className="size-12" /> : <I.MicOff className="size-12" />}
        </button>
        <div className="t-meta text-muted-foreground" aria-hidden="true">{v.mode === 'open' ? 'Conversa aberta: fale à vontade' : 'Segure o botão (ou a barra de espaço) para falar'}</div>
      </div>
    </div>
  );
}

/* O pedido de abrir vale mesmo antes de o React montar o host: `wanted` guarda o pedido e o host o lê ao nascer e ao assinar. */
let wanted = false;
const listeners = new Set();
const requestOpen = () => { wanted = true; listeners.forEach((fn) => fn()); };

function Host() {
  const [open, setOpen] = useState(wanted);
  useEffect(() => {
    const on = () => setOpen(true);
    listeners.add(on);
    if (wanted) on();
    return () => { listeners.delete(on); };
  }, []);
  return open ? <Sheet onClose={() => { wanted = false; setOpen(false); }} /> : null;
}

function mount() {
  const el = document.createElement('div');
  el.id = 'argos-voice-root';
  document.body.appendChild(el);
  ReactDOM.createRoot(el).render(<Host />);
}

// o node-mark.tsx carrega este script uma vez por página (promessa única); a guarda cobre uma carga repetida por outro caminho
if (!window.ArgosVoice) {
  window.ArgosVoice = { open: requestOpen };
  mount();
}
})();
