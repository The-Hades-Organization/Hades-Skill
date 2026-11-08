/* Nó `mark` do canvas do Argos (#/argos): o estado do Mark-LVI, o que ele diz e faz, um campo para mandar pedido por texto,
 * acordar e abrir o último relatório. Só fala com o painel (/api/mark/*): o token do Mark nunca chega ao navegador. Fora do
 * ar, mostra a causa e a ação do catálogo e religa sozinho com recuo. O EventSource, o timer de religar e o de pedido nascem
 * e morrem juntos com o componente. O texto do log e do relatório entra no DOM como texto (React escapa), nunca como HTML.
 * Script clássico: publica window.ArgosNodeMark; types-live.tsx o usa para desenhar o tipo `mark`. */
(() => {
const { useState, useEffect, useRef, I, cn, post, Button } = HadesCore;

const ROUTES = { state: '/api/mark/state', events: '/api/mark/events', command: '/api/mark/command', wake: '/api/mark/wake', report: '/api/mark/report' };
const MARK_TYPE = 'mark';
const MARK_SIZE = { w: 360, h: 420 };
/** Linhas do log guardadas e desenhadas; a mais antiga sai primeiro. */
const LOG_LINES = 80;
const COMMAND_CHARS = 2000;
const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
const STATE_TIMEOUT_MS = 8000;
/** Cor da orbe por estado do Mark (contrato do /api/state); estado novo cai em "neutro" e a legenda mostra o nome. */
const STATE_TONE = {
  INITIALISING: ['Iniciando', 'bg-muted-foreground'],
  LISTENING: ['Ouvindo', 'bg-ok'],
  SPEAKING: ['Falando', 'bg-info'],
  THINKING: ['Pensando', 'bg-warn'],
  PROCESSING: ['Processando', 'bg-warn'],
  SLEEPING: ['Dormindo', 'bg-muted-foreground'],
  MUTED: ['Sem som', 'bg-bad'],
};
const SPEAKER_TONE = { user: 'text-foreground', jarvis: 'text-info', sys: 'text-muted-foreground' };
const PULSING = new Set(['LISTENING', 'SPEAKING', 'THINKING', 'PROCESSING']);

/** Quanto esperar antes da tentativa `n` (0 = primeira). O teto repete. */
const backoffMs = (attempt) => BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];

/** Acrescenta uma linha e mantém só as últimas `LOG_LINES` (a lista nunca é alterada no lugar). */
const pushLine = (lines, line) => {
  const next = [...lines, line];
  return next.length > LOG_LINES ? next.slice(next.length - LOG_LINES) : next;
};

const isOffline = (body) => !!body && body.online === false && !!body.explain;

function openStream(url) {
  return window.PanelStream ? window.PanelStream.open(url) : new EventSource(url);
}

const parseFrame = (event) => {
  try {
    const value = JSON.parse(event.data);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
};

/* Estado, log e conexão do nó. `failure` guarda a explicação do catálogo (causa e ação) enquanto o Mark está fora. */
function useMark() {
  const [state, setState] = useState(null);
  const [lines, setLines] = useState([]);
  const [failure, setFailure] = useState(null);
  useEffect(() => {
    let alive = true;
    let source = null;
    let timer = null;
    let attempt = 0;
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (source !== null) source.close();
      source = null;
    };
    const retryLater = () => {
      if (!alive) return;
      timer = setTimeout(connect, backoffMs(attempt));
      attempt += 1;
    };
    const down = (explain) => {
      clear();
      setState(null);
      setFailure(explain);
      retryLater();
    };
    function connect() {
      clear();
      if (!alive) return;
      const ctl = new AbortController();
      const guard = setTimeout(() => ctl.abort(), STATE_TIMEOUT_MS);
      fetch(ROUTES.state, { cache: 'no-store', signal: ctl.signal }).then((r) => r.json()).then((body) => {
        if (!alive) return;
        if (isOffline(body)) return down(body.explain);
        attempt = 0;
        setFailure(null);
        setState(body);
        source = openStream(ROUTES.events);
        source.addEventListener('state', (event) => { const v = parseFrame(event); if (alive && v) setState(v); });
        source.addEventListener('log', (event) => { const v = parseFrame(event); if (alive && v) setLines((cur) => pushLine(cur, v)); });
        source.addEventListener('offline', (event) => { const v = parseFrame(event); if (alive) down(v && v.explain ? v.explain : null); });
        // queda de conexão sem aviso do painel: religa pelo mesmo recuo, em vez de deixar o EventSource tentar sozinho
        source.addEventListener('error', () => { if (alive && source !== null && source.readyState === 2) down(null); });
      }).catch(() => { if (alive) down(null); }).finally(() => clearTimeout(guard));
    }
    connect();
    return () => { alive = false; clear(); };
  }, []);
  return { state, lines, failure };
}

function Orb({ state }) {
  const [label, tone] = (state && STATE_TONE[state.state]) || ['Sem estado', 'bg-muted-foreground'];
  const pulse = state && PULSING.has(state.state);
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className={cn('size-10 shrink-0 rounded-full opacity-90', tone, pulse && 'motion-safe:animate-pulse')} />
      <div className="min-w-0 flex-1">
        <div className="t-meta-em truncate">{state ? state.name : 'Mark'}</div>
        <div className="t-meta text-muted-foreground" role="status">{label}{state && state.muted ? ' · microfone mudo' : ''}</div>
      </div>
    </div>
  );
}

function Offline({ failure }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center gap-1" role="status">
      <div className="t-meta-em">{failure ? failure.title : 'Mark fora do ar'}</div>
      {failure ? <div className="t-body text-muted-foreground">{failure.cause}</div> : <div className="t-body text-muted-foreground">Sem resposta do painel; tentando de novo.</div>}
      {failure ? <div className="t-body">{failure.action}</div> : null}
    </div>
  );
}

function Log({ lines }) {
  const box = useRef(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  if (lines.length === 0) return <div className="t-meta min-h-0 flex-1 text-muted-foreground">Nada dito ainda.</div>;
  return (
    <ol ref={box} onScroll={onScroll} tabIndex={0} aria-label="Falas e ações do Mark" className="min-h-0 flex-1 overflow-auto scrollbar-thin">
      {lines.map((line, i) => (
        <li key={i} className={cn('break-words', SPEAKER_TONE[line.speaker] || 'text-foreground')}>
          <span className="t-meta-em mr-1.5">{line.speaker === 'jarvis' ? 'Mark' : line.speaker === 'user' ? 'Você' : 'Ação'}</span>{line.text}
        </li>
      ))}
    </ol>
  );
}

function Composer({ disabled, onSend }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submit = async (event) => {
    event.preventDefault();
    const textValue = draft.trim();
    if (textValue === '' || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSend(textValue);
      if (mounted.current) setDraft('');
    } catch (err) {
      if (mounted.current) setError(err && err.explain ? `${err.explain.cause} ${err.explain.action}` : (err && err.message) || 'Não consegui enviar.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <div className="flex gap-1">
        <input
          type="text" value={draft} maxLength={COMMAND_CHARS} disabled={disabled} aria-label="Pedido ao Mark" placeholder="Peça algo ao Mark"
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-0 flex-1 border bg-background px-2 py-1 t-body outline-none focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11"
        />
        <Button size="sm" type="submit" icon={I.Send} disabled={disabled || busy || draft.trim() === ''} className="max-md:min-h-11">Enviar</Button>
      </div>
      {error ? <div className="t-meta text-bad" role="alert">{error}</div> : null}
    </form>
  );
}

function ReportView({ onClose }) {
  const [report, setReport] = useState({ status: 'loading' });
  useEffect(() => {
    const ctl = new AbortController();
    const guard = setTimeout(() => ctl.abort(), STATE_TIMEOUT_MS);
    fetch(ROUTES.report, { cache: 'no-store', signal: ctl.signal }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      setReport(r.ok ? { status: 'ok', ...body } : { status: 'error', message: body.error || 'Relatório indisponível.' });
    }).catch(() => { if (!ctl.signal.aborted) setReport({ status: 'error', message: 'Sem resposta do painel.' }); }).finally(() => clearTimeout(guard));
    return () => { clearTimeout(guard); ctl.abort(); };
  }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="t-meta-em min-w-0 flex-1 truncate">{report.status === 'ok' ? report.title : 'Último relatório'}</span>
        <Button size="sm" variant="outline" onClick={onClose} className="max-md:min-h-11">Voltar</Button>
      </div>
      {report.status === 'loading' ? <div className="t-meta text-muted-foreground" role="status">Carregando…</div> : null}
      {report.status === 'error' ? <div className="t-meta text-bad" role="alert">{report.message}</div> : null}
      {report.status === 'ok' ? <pre tabIndex={0} aria-label="Relatório do Mark, somente leitura" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words scrollbar-thin t-data">{report.text}{report.clipped ? '\n…' : ''}</pre> : null}
    </div>
  );
}

function MarkNode() {
  const { state, lines, failure } = useMark();
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState('');
  const online = state !== null;
  const wake = async () => {
    setNotice('');
    try { await post(ROUTES.wake, {}); } catch (err) { setNotice((err && err.message) || 'Não consegui acordar o Mark.'); }
  };
  const send = (textValue) => post(ROUTES.command, { text: textValue });
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2 t-body">
      <Orb state={state} />
      {reading ? <ReportView onClose={() => setReading(false)} /> : online ? <Log lines={lines} /> : <Offline failure={failure} />}
      {notice ? <div className="t-meta text-bad" role="alert">{notice}</div> : null}
      {reading ? null : (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" icon={I.Sun} disabled={!online} onClick={wake} className="max-md:min-h-11">Acordar</Button>
          <Button size="sm" variant="outline" icon={I.FileText} disabled={!online || !(state && state.last_report)} onClick={() => setReading(true)} className="max-md:min-h-11">Relatório</Button>
        </div>
      )}
      {reading ? null : <Composer disabled={!online} onSend={send} />}
    </div>
  );
}

window.ArgosNodeMark = { MarkNode, MARK_TYPE, MARK_SIZE, STATE_TONE, backoffMs, pushLine, isOffline, LOG_LINES, COMMAND_CHARS, ROUTES };
})();
