/* Terminal, conversa e arquivos de um agente dentro do nó do canvas (#/argos). Usa as rotas do herdr
 * que o painel já tem (/api/herdr/read e /api/herdr/act): saída com rolagem, envio de texto e de teclas, e abas. A conversa
 * e a lista de arquivos chegam prontas por props (src/lib/canvas-conversation.ts e canvas-agent-files.ts): o componente só
 * desenha e coleta. Timer e ouvinte nascem e morrem juntos com o componente. No fim, o nó `agent` como terminal ao vivo
 * (AgentTtyNode e createTtyHost: conexão única da página, foco, atenção e salto). Expõe window.ArgosNodeTerminal. */
(() => {
const { useState, useEffect, useRef, useCallback, I, cn, post, getJSON, Button, Dot, Mono, Tip, Empty, useApp } = HadesCore;

const POLL_MS = 3000;
const OUTPUT_LINES = 200;
const STICK_PX = 40;
const NO_OUTPUT = '(sem saída)';
const TABS = [['terminal', 'Terminal'], ['conversation', 'Conversa'], ['files', 'Arquivos']];
const ROLE_WORD = { brief: 'brief', report: 'report', questions: 'questions', handoff: 'handoff' };
const ENTRY_TONE = { user: 'text-foreground', agent: 'text-muted-foreground', system: 'text-warn' };
// as teclas são as que o servidor aceita (herdr-page.ts KEYS); as que interrompem pedem confirmação
const KEYS = [['Enter', 'Enter', I.CornerDownLeft], ['Esc', 'Escape', I.CircleX, true], ['Ctrl+C', 'Ctrl+C', I.OctagonX, true], ['Tab', 'Tab', I.ArrowRightToLine],
  ['Seta para cima', 'Up', I.ArrowUp, false, true], ['Seta para baixo', 'Down', I.ArrowDown, false, true],
  ['Seta para a esquerda', 'Left', I.ArrowLeft, false, true], ['Seta para a direita', 'Right', I.ArrowRight, false, true], ['y', 'y'], ['n', 'n']];

const query = (o) => '?' + Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const hms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toLocaleTimeString('pt-BR') : '—'; };

/* Saída do painel: busca de tempos em tempos enquanto `live` e a página está visível. Resposta atrasada de um painel
 * anterior é descartada (`alive`), e nunca há duas buscas em voo. */
function usePaneOutput({ session, pane, live, pollMs }) {
  const [out, setOut] = useState(null);
  const [error, setError] = useState('');
  const inflight = useRef(false);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const r = await getJSON('/api/herdr/read' + query({ session, pane, lines: OUTPUT_LINES }));
      if (!alive.current) return;
      if (r && r.error) { setError(String(r.error)); return; }
      setError(''); setOut(r);
    } catch (e) { if (alive.current) setError(e && e.message ? e.message : 'sem resposta do painel'); }
    finally { inflight.current = false; }
  }, [session, pane]);
  useEffect(() => { alive.current = true; setOut(null); setError(''); return () => { alive.current = false; }; }, [session, pane]);
  useEffect(() => {
    load();
    if (!live) return undefined;
    const tick = () => { if (!document.hidden) load(); };
    const timer = setInterval(tick, pollMs);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [load, live, pollMs]);
  return { out, error, load };
}

function TerminalTab({ session, pane, hasAgent, live, pollMs }) {
  const { toast, confirm } = useApp();
  const { out, error, load } = usePaneOutput({ session, pane, live, pollMs });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [atEnd, setAtEnd] = useState(true);
  const box = useRef(null), stick = useRef(true), reload = useRef(null);
  // o recarregamento depois de enviar morre com o componente, junto com o timer de leitura
  useEffect(() => () => { if (reload.current) clearTimeout(reload.current); }, []);
  useEffect(() => { setText(''); stick.current = true; setAtEnd(true); }, [session, pane]);
  useEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [out?.text]);
  const onScroll = (e) => { const b = e.currentTarget; const end = b.scrollHeight - b.scrollTop - b.clientHeight < STICK_PX; stick.current = end; setAtEnd(end); };
  const toEnd = () => { const b = box.current; if (b) { b.scrollTop = b.scrollHeight; stick.current = true; setAtEnd(true); } };
  const act = async (body, ok) => {
    setBusy(true);
    try {
      await post('/api/herdr/act', { session, pane, ...body });
      if (ok) toast({ kind: 'ok', title: ok });
      if (reload.current) clearTimeout(reload.current);
      reload.current = setTimeout(load, 600);
      return true;
    } catch (e) { toast({ kind: 'bad', title: 'O herdr não aceitou', desc: e.message }); return false; }
    finally { setBusy(false); }
  };
  const send = async (kind) => {
    if (!text.trim()) return;
    if (await act({ action: kind, text }, kind === 'prompt' ? 'Prompt enviado' : 'Texto enviado')) setText('');
  };
  const key = async ([label, k, , ask]) => {
    if (ask && !(await confirm({ title: `Enviar ${label} para o terminal?`, icon: I.Keyboard, danger: true, confirmLabel: `Enviar ${label}`,
      description: `${label} vai para o terminal e pode interromper o que ele faz.` }))) return;
    act({ action: 'keys', keys: [k] });
  };
  const onKeyDown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(hasAgent ? 'prompt' : 'text'); } };
  const fg = out?.procs?.[0];
  return <div className="flex min-h-0 flex-1 flex-col gap-2">
    {fg ? <Tip text={out.procs.map((p) => `${p.cmd} (pid ${p.pid})`).join(' · ')}>
      <Mono className="block truncate text-muted-foreground">{'primeiro plano: '}{fg.cmd || fg.name}{' · pid '}{fg.pid}</Mono>
    </Tip> : null}
    <div className="relative flex min-h-0 flex-1">
      <pre ref={box} onScroll={onScroll} tabIndex={0} aria-label="Saída do terminal" aria-live="off"
        className="min-h-32 flex-1 overflow-auto border bg-term p-3 t-data leading-relaxed whitespace-pre text-term-foreground scrollbar-thin outline-none focus-visible:outline-2 focus-visible:outline-ring">
        {error && !out ? `não consegui ler o terminal: ${error}` : out ? (out.text || NO_OUTPUT) : 'carregando…'}
      </pre>
      {!atEnd ? <Button size="xs" variant="outline" icon={I.ArrowDownToLine} className="absolute right-3 bottom-3 bg-background" onClick={toEnd}>Ir para o fim</Button> : null}
    </div>
    {error && out ? <span className="t-meta text-bad" role="status">Sem atualizar: {error}</span> : null}
    <textarea value={text} rows={2} aria-label="Texto para o terminal" placeholder={hasAgent ? 'Prompt (Ctrl+Enter envia)' : 'Texto para o terminal (Ctrl+Enter envia)'}
      onInput={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
      className="min-h-14 max-h-40 min-w-0 resize-y border border-border-strong bg-background px-3 py-2 text-base outline-none focus-visible:outline-2 focus-visible:outline-ring md:text-sm" />
    <div className="flex flex-wrap items-center gap-2">
      {hasAgent ? <Button size="sm" icon={I.SendHorizontal} loading={busy} disabled={!text.trim()} onClick={() => send('prompt')}>Enviar prompt</Button> : null}
      <Button size="sm" variant="outline" icon={I.Type} loading={busy} disabled={!text.trim()} onClick={() => send('text')}>Digitar sem Enter</Button>
      <Button size="sm" variant="ghost" icon={I.RefreshCw} onClick={load}>Atualizar</Button>
    </div>
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Teclas de atalho">
      {KEYS.map((k) => <Button key={k[1]} size="xs" variant={k[3] ? 'ghost-destructive' : 'outline'} className={k[3] ? 'border' : ''} icon={k[2]} disabled={busy}
        aria-label={k[4] ? k[0] : undefined} title={k[4] ? k[0] : undefined} onClick={() => key(k)}>
        {k[4] ? null : k[0]}
      </Button>)}
    </div>
  </div>;
}

// `conversation` é o retorno de conversationFromEvents/Jsonl: { entries, omitted, invalid, unscanned }
function ConversationTab({ conversation }) {
  const box = useRef(null);
  useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight; }, [conversation?.entries?.length]);
  if (!conversation) return <Empty icon={I.MessagesSquare} title="Sem conversa">O diário deste agente ainda não foi carregado.</Empty>;
  const { entries, omitted, invalid } = conversation;
  if (entries.length === 0) return <Empty icon={I.MessagesSquare} title="Sem conversa">O diário não tem eventos deste agente.</Empty>;
  return <div className="flex min-h-0 flex-1 flex-col gap-2">
    {omitted > 0 || invalid > 0 ? <span className="t-meta text-muted-foreground">
      {omitted > 0 ? `${omitted} entradas mais antigas fora da lista` : ''}{omitted > 0 && invalid > 0 ? ' · ' : ''}{invalid > 0 ? `${invalid} linhas do diário ignoradas` : ''}
    </span> : null}
    <ol ref={box} className="min-h-32 flex-1 overflow-auto border p-2 scrollbar-thin" aria-label="Conversa do agente">
      {entries.map((e, i) => <li key={`${e.ts}-${i}`} className="grid grid-cols-[auto_1fr] gap-x-2 border-b py-1 last:border-b-0">
        <span className="t-data text-muted-foreground">{hms(e.ts)}</span>
        <span className={cn('t-body break-words', ENTRY_TONE[e.role])}>
          <span className="t-meta-em mr-1.5">{e.label}</span>{e.text}
        </span>
      </li>)}
    </ol>
  </div>;
}

// `files` é a lista { path, role } do nó do agente (AgentFileEntry em src/lib/canvas-agent-files.ts)
function FilesTab({ files, onOpenFile }) {
  if (!files || files.length === 0) return <Empty icon={I.FileText} title="Sem arquivos">O agente ainda não tem brief, report, questions nem handoff.</Empty>;
  return <ul className="grid gap-1" aria-label="Arquivos do agente">
    {files.map((f) => <li key={f.path}>
      <button type="button" disabled={!onOpenFile} onClick={() => onOpenFile && onOpenFile(f)}
        className="flex w-full items-center gap-2 border px-3 py-2 text-left t-body outline-none hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-md:min-h-11 disabled:cursor-default">
        <I.FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="t-meta-em">{ROLE_WORD[f.role] || f.role}</span>
        <Mono className="min-w-0 flex-1 truncate text-muted-foreground">{f.path}</Mono>
      </button>
    </li>)}
  </ul>;
}

/* Props: session e pane identificam o painel no herdr; hasAgent liga o botão de prompt; conversation e files vêm dos
 * módulos de src/lib; onOpenFile recebe { path, role }; live liga a leitura periódica (padrão ligado); initialTab abre numa aba. */
function NodeTerminal({ session, pane, hasAgent = false, conversation = null, files = [], onOpenFile, live = true, pollMs = POLL_MS, initialTab = 'terminal' }) {
  const [tab, setTab] = useState(TABS.some(([id]) => id === initialTab) ? initialTab : 'terminal');
  const refs = useRef({});
  const move = (e, i) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + TABS.length) % TABS.length;
    setTab(TABS[next][0]);
    const el = refs.current[TABS[next][0]]; if (el) el.focus();
  };
  return <div className="flex h-full min-h-0 flex-col gap-2">
    <div role="tablist" aria-label="Terminal, conversa e arquivos" className="flex items-center gap-1 border-b">
      {TABS.map(([id, label], i) => <button key={id} ref={(el) => { refs.current[id] = el; }} type="button" role="tab" id={`nt-tab-${id}`} aria-selected={tab === id} aria-controls={`nt-panel-${id}`}
        tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(e) => move(e, i)}
        className={cn('t-body px-3 py-1.5 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-md:min-h-11 border-b-2',
          tab === id ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
        {label}
        {id === 'files' && files.length ? <span className="ml-1 t-meta text-muted-foreground">{files.length}</span> : null}
      </button>)}
      <span className="ml-auto flex items-center gap-1.5 t-meta text-muted-foreground">
        <Dot kind={live ? 'busy' : 'idle'} pulse={live} />
        {live ? 'ao vivo' : 'parado'}
      </span>
    </div>
    <div role="tabpanel" id={`nt-panel-${tab}`} aria-labelledby={`nt-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
      {tab === 'terminal' ? <TerminalTab session={session} pane={pane} hasAgent={hasAgent} live={live} pollMs={pollMs} /> : null}
      {tab === 'conversation' ? <ConversationTab conversation={conversation} /> : null}
      {tab === 'files' ? <FilesTab files={files} onOpenFile={onOpenFile} /> : null}
    </div>
  </div>;
}

/* ---- Nó de agente como terminal (reference/argos.md §Nó de agente como terminal) ----
 * O nó `agent` com pane do herdr conhecido desenha o NodeTty (node-tty.tsx, carregado depois deste script: lido na hora de
 * desenhar). A página cria um host (`createTtyHost`) e é dona dele: uma conexão SSE para os panes dos nós montados, foco do
 * teclado, atenção, números de salto e a fila de entrada. O nó só lê o host e chama as ações dele. */

// teclas que o herdr 0.8.2 recusa (`invalid_key`, 400) em qualquer grafia: ficam desligadas até ele aceitar
const TTY_BLOCKED_KEYS = Object.freeze(['Home', 'End', 'PageUp', 'PageDown', 'Delete']);
const ATTENTION_STATUSES = Object.freeze(['idle', 'blocked']);
const STREAM_URL = '/api/herdr/stream';
// tetos do servidor (herdr-stream.ts STREAM_PANES_MAX; herdr-page.ts MAX_TEXT): pedir mais seria recusado lá
const STREAM_PANES_MAX = 12;
const INPUT_MAX_TEXT = 20_000;
// formatos do servidor (herdr-page.ts SESSION_NAME e PANE_ID): o que não casa nem vira alvo
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PANE_ID = /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/;
const TTY_SUBSCRIBE_DEBOUNCE_MS = 250;
// erros seguidos da conexão sem nenhuma mensagem no meio (o EventSource religa a cada 3 s): depois disso, polling
const TTY_STREAM_FAILS = 3;
const TTY_STREAM_RETRY_MS = 60_000;
const TTY_QUEUE_MAX = 200;
const TTY_HEADER_PX = 28;
const TTY_JUMP_MAX = 9;
// texto do quadro abaixo de 45% do tamanho natural (~6 px de fonte na tela) não se lê: só o cabeçalho
const TTY_TEXT_MIN_FACTOR = 0.45;
// quadro do polling: as últimas linhas do /api/herdr/read, que devolve texto sem cor e sem o tamanho da tela
const READ_ROWS = 40;
const READ_MAX_COLS = 1000;
const NO_FRAME_TEXT = { connecting: 'conectando ao terminal…', exited: 'o pane do agente saiu' };
// comandos do canvas que valem com o terminal focado (as teclas de TTY_GLOBAL_KEYS, que o NodeTty não consome)
const TTY_COMMAND = /^tty:/;
const ALT_DIGIT_CODE = /^(?:Digit|Numpad)([1-9])$/;

const ttyApi = () => window.ArgosNodeTty;
const canvasHeaderPx = () => window.CanvasModel.selection.SELECTION_LIMITS.header;
const list = (v) => (Array.isArray(v) ? v : []);

/** Entrada do NodeTty sem as teclas que o herdr recusa; `null` quando não sobra nada para enviar. */
function filterTtyInput(input) {
  if (!input || typeof input !== 'object') return null;
  const keys = list(input.keys).filter((k) => typeof k === 'string' && !TTY_BLOCKED_KEYS.includes(k));
  const text = typeof input.text === 'string' && input.text !== '' ? input.text : null;
  if (text === null && keys.length === 0) return null;
  return { ...(text !== null ? { text } : {}), ...(keys.length ? { keys } : {}) };
}

/** Índice dos panes da visão geral do herdr (`GET /api/herdr`): pelo nome do agente e pela pasta, na sessão que ela leu. */
function ttyTargetsOf(overview) {
  const out = { session: null, byName: new Map(), byDir: new Map() };
  if (!overview || overview.available !== true || typeof overview.session !== 'string' || !SESSION_NAME.test(overview.session)) return out;
  out.session = overview.session;
  for (const ws of list(overview.tree)) for (const tab of list(ws && ws.tabs)) for (const p of list(tab && tab.panes)) {
    if (!p || typeof p.id !== 'string' || !PANE_ID.test(p.id)) continue;
    for (const name of [p.name, p.hades && p.hades.name]) if (typeof name === 'string' && name && !out.byName.has(name)) out.byName.set(name, p.id);
    for (const dir of [p.fcwd, p.cwd]) if (typeof dir === 'string' && dir && !out.byDir.has(dir)) out.byDir.set(dir, p.id);
  }
  return out;
}

/** Pane do nó `agent`: pelo nome no herdr, senão pela pasta da worktree (a regra do `hostOf` do servidor); `null` sem pane. */
function ttyTargetOf(targets, node) {
  if (!node || node.type !== 'agent') return null;
  // o grafo já traz o par quando o herdr conhece o agente: vale antes de casar por nome ou pasta
  const own = herdrRefOf(node.herdr);
  if (own) return own;
  if (!targets || !targets.session) return null;
  const pane = (node.label && targets.byName.get(node.label)) || (node.worktree && targets.byDir.get(node.worktree));
  return pane ? { session: targets.session, pane } : null;
}

/** `{ session, pane }` válido (formato das rotas do herdr) ou `null`: dado do grafo ou do documento nunca vai cru à rota. */
function herdrRefOf(v) {
  if (!v || typeof v !== 'object') return null;
  return typeof v.session === 'string' && SESSION_NAME.test(v.session) && typeof v.pane === 'string' && PANE_ID.test(v.pane)
    ? { session: v.session, pane: v.pane } : null;
}

/** Tecla para o registro de comandos: Alt+dígito pelo `code`, porque com Alt o layout troca o caractere (¡, ™…). */
function ttyKeyInput(e) {
  const digit = e.altKey && typeof e.code === 'string' ? ALT_DIGIT_CODE.exec(e.code) : null;
  return { key: digit ? digit[1] : e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey };
}

/** Com o teclado num terminal, só os comandos tty:* da página disparam; o resto (Esc inclusive) é do terminal. */
const ttyLetsCommand = (inTty, commandId) => !inTty || TTY_COMMAND.test(commandId);

const isAttentionStatus = (status) => ATTENTION_STATUSES.includes(status);

/** Ponto de atenção: estado idle/blocked, nó sem o foco e esse estado ainda não visto (focar marca como visto). */
const ttyAttention = ({ status, focused, seen }) => isAttentionStatus(status) && !focused && seen !== status;

/** Marca de visto depois de um estado: focar com atenção marca; sair de idle/blocked limpa, e o próximo volta a acender. */
function seenAfter(seen, status, focused) {
  if (!isAttentionStatus(status)) return null;
  return focused ? status : seen;
}

/** Próximo com atenção depois de `current` na ordem estável `order`, dando a volta; `null` se nenhum pede atenção. */
function nextAttentionId(order, attentive, current) {
  const want = new Set(attentive);
  if (want.size === 0) return null;
  const start = order.indexOf(current);
  for (let step = 1; step <= order.length; step++) {
    const id = order[(start + step) % order.length];
    if (want.has(id)) return id;
  }
  return null;
}

/** Números de salto (1–9) dos nós visíveis, na ordem de leitura da tela: de cima para baixo, da esquerda para a direita. */
function jumpNumbers(rects) {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(sorted.slice(0, TTY_JUMP_MAX).map((r, i) => [r.id, i + 1]));
}

/** Tamanho mínimo do nó inteiro: `minSize(frame)` do NodeTty mais o cabeçalho do canvas e o do nó. */
function ttyMinNodeSize(frame) {
  const m = ttyApi().minSize(frame);
  return { w: m.w, h: m.h + canvasHeaderPx() + TTY_HEADER_PX };
}

/** Escala do quadro num nó `w`×`h` (aproximada: o cabeçalho do NodeTty mede o mesmo que o do nó). */
function ttyScaleOf(w, h, frame) {
  return ttyApi().fitScale({ w, h: Math.max(0, h - canvasHeaderPx() - 2 * TTY_HEADER_PX) }, frame);
}

/** Zoom baixo: o texto do quadro sairia pequeno demais na tela; o nó mostra só o cabeçalho e não converte o quadro. */
const ttyHeaderOnly = (zoom, scale) => zoom * scale < TTY_TEXT_MIN_FACTOR;

/** Quadro do polling a partir do `/api/herdr/read` (texto puro): as últimas linhas, a grade do tamanho delas. */
function frameFromRead(pane, out, session) {
  if (!out || typeof out.text !== 'string') return null;
  const lines = out.text.split('\n').slice(-READ_ROWS);
  const cols = Math.min(READ_MAX_COLS, Math.max(1, ...lines.map((l) => [...l].length)));
  return withSession({ pane, revision: 0, cols, rows: Math.max(1, lines.length), ansi: lines.join('\r\n') }, session);
}

const sessionFrames = new WeakMap();
/**
 * O quadro leva a sessão do herdr do nó: o histórico (GET /api/herdr/scrollback) vem do pane da sessão certa; sem `session` o
 * NodeTty cai na sessão padrão. O quadro do fluxo é do host (mesma identidade enquanto não muda): a cópia com sessão é
 * guardada por quadro, para o NodeTty não ver quadro novo a cada desenho.
 */
function withSession(frame, session) {
  if (!frame || typeof session !== 'string' || session === '' || frame.session === session) return frame;
  const cached = sessionFrames.get(frame);
  if (cached && cached.session === session) return cached;
  const next = { ...frame, session };
  sessionFrames.set(frame, next);
  return next;
}

/** Junta a fila de entrada de um pane num envio: textos seguidos, e as teclas que vierem logo depois (o herdr manda o
 * texto e depois as teclas, então a ordem se mantém); depois de teclas, para. Respeita os tetos do servidor. */
function takeInputBatch(queue) {
  let batch = queue[0];
  let used = 1;
  while (used < queue.length && !batch.keys) {
    const next = queue[used];
    const text = (batch.text || '') + (next.text || '');
    if (text.length > INPUT_MAX_TEXT) break;
    batch = { ...(text ? { text } : {}), ...(next.keys ? { keys: next.keys } : {}) };
    used += 1;
  }
  return { batch, rest: queue.slice(used) };
}

const parseData = (raw) => {
  if (typeof raw !== 'string') return null;
  try { const d = JSON.parse(raw); return d && typeof d === 'object' ? d : null; } catch (e) {
    console.warn('argos: evento do terminal ilegível', e && e.name);
    return null;
  }
};
const validFrame = (d) => typeof d.pane === 'string' && typeof d.ansi === 'string' && Number.isInteger(d.cols) && Number.isInteger(d.rows) && typeof d.revision === 'number';

/**
 * Host dos terminais da página. deps: `openStream(url)` (um EventSource), `sendInput(body)` (POST /api/herdr/input; rejeita
 * com a mensagem do servidor), `setTimer`/`clearTimer`, `nodeRect(id)` ({ x, y } do nó no documento) e `liveState(id)` (o
 * estado do agente no grafo, usado quando o fluxo ainda não disse o do pane). Avisa os ouvintes com o pane que mudou, ou '*'.
 */
function createTtyHost(deps) {
  let targets = new Map();
  const mounted = new Map();
  const frames = new Map();
  const statuses = new Map();
  const exited = new Set();
  const paneErrors = new Map();
  const seen = new Map();
  const inputErrors = new Map();
  const queues = new Map();
  const listeners = new Set();
  let focused = null;
  let alt = false;
  let zoom = 1;
  let mode = 'idle';
  let stream = null;
  let streamKey = '';
  // panes além do teto de uma conexão: esses nós leem por polling
  let overflow = new Set();
  let failedKey = null;
  let fails = 0;
  let syncTimer = null;
  let retryTimer = null;
  let destroyed = false;

  const emit = (topic) => { for (const fn of [...listeners]) fn(topic); };
  const setMode = (next) => { if (mode !== next) { mode = next; emit('*'); } };
  const statusOf = (id) => {
    const t = targets.get(id);
    const live = t ? statuses.get(t.pane) : undefined;
    return live !== undefined ? live : deps.liveState(id) || 'unknown';
  };
  const markSeen = (id) => seen.set(id, seenAfter(seen.get(id) ?? null, statusOf(id), focused === id));
  const markPane = (pane) => { for (const [id, t] of targets) if (t.pane === pane) markSeen(id); };

  function close() {
    if (stream) stream.es.close();
    stream = null;
  }
  function fallBack() {
    close();
    failedKey = streamKey;
    setMode('polling');
    // o fluxo volta a ser tentado depois de um tempo, ou quando o conjunto de panes mudar
    if (retryTimer) deps.clearTimer(retryTimer);
    retryTimer = deps.setTimer(() => { retryTimer = null; failedKey = null; streamKey = ''; sync(); }, TTY_STREAM_RETRY_MS);
  }
  function open(session, panes) {
    const url = `${STREAM_URL}?session=${encodeURIComponent(session)}&panes=${panes.map(encodeURIComponent).join(',')}`;
    const es = deps.openStream(url);
    const own = { es, panes: new Set(panes) };
    stream = own;
    const alive = () => stream === own && !destroyed;
    const on = (type, fn) => es.addEventListener(type, (m) => {
      if (!alive()) return;
      const d = parseData(m && m.data);
      if (!d) return;
      fails = 0;
      setMode('stream');
      fn(d);
    });
    on('frame', (d) => {
      if (!validFrame(d) || !own.panes.has(d.pane)) return;
      const prev = frames.get(d.pane);
      if (prev && prev.revision > d.revision) return;
      frames.set(d.pane, d);
      exited.delete(d.pane);
      emit(d.pane);
    });
    on('status', (d) => {
      if (typeof d.pane !== 'string' || typeof d.agentStatus !== 'string' || !own.panes.has(d.pane)) return;
      statuses.set(d.pane, d.agentStatus);
      markPane(d.pane);
      emit(d.pane);
    });
    on('exited', (d) => {
      if (typeof d.pane !== 'string' || !own.panes.has(d.pane)) return;
      exited.add(d.pane);
      emit(d.pane);
    });
    // `error` é nome de evento do servidor e também o erro de conexão do EventSource (este sem `data`)
    es.addEventListener('error', (m) => {
      if (!alive()) return;
      const d = parseData(m && m.data);
      if (d) {
        console.warn('argos: fluxo do terminal avisou', d.code, d.pane || '');
        if (typeof d.pane === 'string' && own.panes.has(d.pane)) { paneErrors.set(d.pane, typeof d.message === 'string' ? d.message : String(d.code)); emit(d.pane); }
        return;
      }
      fails += 1;
      // CLOSED: a rota respondeu sem fluxo (ausente, recusada); o EventSource não religa sozinho
      if (es.readyState === 2 || fails >= TTY_STREAM_FAILS) fallBack();
    });
  }
  function desired() {
    let session = null;
    const panes = new Set();
    for (const id of mounted.keys()) {
      const t = targets.get(id);
      if (!t) continue;
      if (session === null) session = t.session;
      if (t.session === session) panes.add(t.pane);
    }
    const sorted = [...panes].sort();
    return { session, panes: sorted.slice(0, STREAM_PANES_MAX), overflow: new Set(sorted.slice(STREAM_PANES_MAX)) };
  }
  function sync() {
    syncTimer = null;
    if (destroyed) return;
    const { session, panes, overflow: over } = desired();
    if (over.size !== overflow.size || [...over].some((p) => !overflow.has(p))) { overflow = over; emit('*'); }
    const key = session && panes.length ? `${session}|${panes.join(',')}` : '';
    if (key === streamKey) return;
    close();
    streamKey = key;
    // pane que saiu do fluxo volta a ler o estado do grafo
    for (const pane of [...statuses.keys()]) if (!panes.includes(pane)) statuses.delete(pane);
    if (!key) { setMode('idle'); return; }
    if (key === failedKey) { setMode('polling'); return; }
    fails = 0;
    setMode('connecting');
    open(session, panes);
  }
  const schedule = () => {
    if (destroyed) return;
    if (syncTimer) deps.clearTimer(syncTimer);
    syncTimer = deps.setTimer(sync, TTY_SUBSCRIBE_DEBOUNCE_MS);
  };

  async function drain(pane) {
    const q = queues.get(pane);
    if (!q || q.busy || q.items.length === 0 || destroyed) return;
    const { batch, rest } = takeInputBatch(q.items);
    q.items = rest;
    q.busy = true;
    const ids = [...targets].filter(([, t]) => t.pane === pane).map(([id]) => id);
    try {
      await deps.sendInput({ session: q.session, pane, ...batch });
      for (const id of ids) inputErrors.delete(id);
    } catch (e) {
      const message = e && e.message ? e.message : 'sem resposta do painel';
      console.warn('argos: entrada do terminal recusada', pane);
      for (const id of ids) inputErrors.set(id, message);
    } finally {
      q.busy = false;
    }
    emit(pane);
    await drain(pane);
  }

  const host = {
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    setTargets(next) {
      const same = next.size === targets.size && [...next].every(([id, t]) => { const o = targets.get(id); return o && o.session === t.session && o.pane === t.pane; });
      if (same) return;
      targets = next;
      for (const id of targets.keys()) markSeen(id);
      emit('*');
      schedule();
    },
    target: (id) => targets.get(id) || null,
    /** O nó montado (visível no detalhe completo) assina o pane dele; a função devolvida desassina. */
    mount(id) {
      mounted.set(id, (mounted.get(id) || 0) + 1);
      schedule();
      return () => {
        const n = (mounted.get(id) || 1) - 1;
        if (n > 0) mounted.set(id, n); else mounted.delete(id);
        if (n <= 0 && focused === id) host.focus(null);
        schedule();
      };
    },
    /** `stream` (o pane está no fluxo), `connecting`, `polling` (sem fluxo, ou pane além do teto da conexão) ou `idle`. */
    modeOf(id) {
      const t = targets.get(id);
      if (!t) return 'idle';
      if (mode === 'polling' || overflow.has(t.pane)) return 'polling';
      return mode;
    },
    frameOf(id) { const t = targets.get(id); return t ? frames.get(t.pane) || null : null; },
    exitedOf(id) { const t = targets.get(id); return !!t && exited.has(t.pane); },
    paneErrorOf(id) { const t = targets.get(id); return t ? paneErrors.get(t.pane) || null : null; },
    inputErrorOf: (id) => inputErrors.get(id) || null,
    statusOf,
    attentionOf: (id) => ttyAttention({ status: statusOf(id), focused: focused === id, seen: seen.get(id) ?? null }),
    /** O grafo foi relido: o estado dos panes sem fluxo pode ter mudado. */
    refreshStates() { for (const id of targets.keys()) markSeen(id); emit('*'); },
    focused: () => focused,
    focus(id) {
      const next = id && targets.has(id) ? id : null;
      if (next === focused) return;
      focused = next;
      if (next) markSeen(next);
      emit('*');
    },
    /** Próximo nó com atenção, em ordem estável (o id), depois do focado; `null` se nenhum. */
    nextAttention() {
      const order = [...targets.keys()].sort();
      return nextAttentionId(order, order.filter((id) => host.attentionOf(id)), focused);
    },
    alt: () => alt,
    setAlt(on) { if (alt !== !!on) { alt = !!on; emit('*'); } },
    jumpNumbers() {
      const rects = [];
      for (const id of mounted.keys()) {
        const r = targets.has(id) ? deps.nodeRect(id) : undefined;
        if (r) rects.push({ id, x: r.x, y: r.y });
      }
      return jumpNumbers(rects);
    },
    jumpTarget(n) { for (const [id, k] of host.jumpNumbers()) if (k === n) return id; return null; },
    zoom: () => zoom,
    setZoom(k) {
      // só o cruzamento de faixas de 5% redesenha os nós (a câmera muda a cada quadro de um gesto)
      const step = Math.round(k * 20) / 20;
      if (Number.isFinite(step) && step !== zoom) { zoom = step; emit('*'); }
    },
    input(id, raw) {
      const t = targets.get(id);
      const input = filterTtyInput(raw);
      if (!t || !input) return;
      const q = queues.get(t.pane) || { session: t.session, items: [], busy: false };
      queues.set(t.pane, q);
      if (q.items.length >= TTY_QUEUE_MAX) { inputErrors.set(id, 'fila de entrada cheia: o painel não está respondendo'); emit(t.pane); return; }
      q.session = t.session;
      q.items.push(input);
      drain(t.pane).catch((e) => console.error('argos: fila de entrada do terminal', e && e.name));
    },
    destroy() {
      destroyed = true;
      close();
      if (syncTimer) deps.clearTimer(syncTimer);
      if (retryTimer) deps.clearTimer(retryTimer);
      syncTimer = retryTimer = null;
      listeners.clear();
      queues.clear();
    },
  };
  return host;
}

/** Redesenha o componente quando o host avisa o pane dele (ou '*'). */
function useTtyTopic(host, pane) {
  const [, setTick] = useState(0);
  useEffect(() => host.subscribe((topic) => { if (topic === '*' || topic === pane) setTick((t) => t + 1); }), [host, pane]);
}

// sem fluxo: o NodeTty desenha a leitura do /api/herdr/read que já existia, de tempos em tempos
function PolledTty({ session, pane, ...tty }) {
  const { out, error } = usePaneOutput({ session, pane, live: true, pollMs: POLL_MS });
  const frame = frameFromRead(pane, out, session);
  const Tty = ttyApi().NodeTty;
  if (!frame) return <span role="status" className="p-2 t-meta text-muted-foreground">{error ? `não consegui ler o terminal: ${error}` : 'carregando…'}</span>;
  return <Tty frame={frame} {...tty} />;
}

/*
 * O desenho do terminal dentro de um nó (agent ou terminal): pequeno demais, polling, quadro do fluxo ou o aviso de espera.
 * Chamada como função (sem hooks), para o nó devolver o NodeTty direto na árvore.
 */
function ttyBody({ host, input, target, grow }) {
  const focused = host.focused() === input.id;
  const frame = withSession(host.frameOf(input.id), target.session);
  const min = ttyMinNodeSize(frame);
  const small = input.w < min.w || input.h < min.h;
  const headerOnly = !small && frame ? ttyHeaderOnly(host.zoom(), ttyScaleOf(input.w, input.h, frame)) : false;
  const tty = { focused, headerOnly, onFocus: () => host.focus(input.id), onBlur: () => host.focus(null), onInput: (x) => host.input(input.id, x) };
  const Tty = ttyApi().NodeTty;
  if (small) return <div className="grid content-center justify-items-start gap-2 p-2">
    <span className="t-meta text-muted-foreground">Nó pequeno para o terminal ({min.w}×{min.h} no mínimo).</span>
    <Button size="xs" variant="outline" icon={I.Maximize2} onClick={() => grow(input.id, min)}>Ampliar para o terminal</Button>
  </div>;
  if (host.modeOf(input.id) === 'polling') return <PolledTty session={target.session} pane={target.pane} {...tty} />;
  if (frame) return <Tty frame={frame} {...tty} />;
  return <span role="status" className="p-2 t-meta text-muted-foreground">{host.exitedOf(input.id) ? NO_FRAME_TEXT.exited : host.paneErrorOf(input.id) || NO_FRAME_TEXT.connecting}</span>;
}

const VIEWS = [['terminal', 'Terminal', I.SquareTerminal], ['conversation', 'Conversa', I.MessagesSquare], ['files', 'Arquivos', I.FileText]];

/* Desenho do nó `agent` no canvas. input = { id, w, h, live } do registro; host = createTtyHost; fallback = o desenho de
 * antes (nó sem pane); agentView(kind, input) desenha Conversa e Arquivos; grow(id, size) amplia o nó (um passo do desfazer). */
function AgentTtyNode({ input, host, fallback, agentView, grow }) {
  const target = host.target(input.id);
  const pane = target ? target.pane : null;
  const [view, setView] = useState('terminal');
  useTtyTopic(host, pane);
  useEffect(() => (pane ? host.mount(input.id) : undefined), [host, input.id, pane]);
  if (!target) return fallback;
  const node = input.live || { label: input.id };
  const focused = host.focused() === input.id;
  const status = host.statusOf(input.id);
  const attention = host.attentionOf(input.id);
  const jump = host.alt() ? host.jumpNumbers().get(input.id) : undefined;
  const inputError = host.inputErrorOf(input.id);
  const word = window.CanvasModel.argos.stateLook(status).word;
  const pick = (id) => { if (focused) host.focus(null); setView(id); };
  const body = view !== 'terminal' ? agentView(view, input) : ttyBody({ host, input, target, grow });
  return <div className="flex h-full min-h-0 flex-col bg-card" data-agent-tty={input.id}>
    <div className="flex shrink-0 items-center gap-1.5 border-b px-2 t-meta" style={{ height: TTY_HEADER_PX }}>
      {jump ? <kbd aria-label={`Alt+${jump} foca este terminal`} className="inline-flex h-5 min-w-5 items-center justify-center border border-border-strong bg-muted px-1 font-mono t-micro text-foreground">{jump}</kbd> : null}
      <span className="min-w-0 flex-1 truncate t-body-strong" title={node.label}>{node.label}</span>
      <span className="shrink-0 text-muted-foreground">{word}</span>
      {attention ? <span role="img" aria-label="pede atenção" title="pede atenção" className="size-2 shrink-0 rounded-full bg-bad" /> : null}
      <span role="group" aria-label="Vista do nó" className="flex shrink-0 items-center">
        {VIEWS.map(([id, label, Icon]) => <button key={id} type="button" aria-pressed={view === id} aria-label={label} title={label} onClick={() => pick(id)}
          className={cn('inline-flex size-6 items-center justify-center outline-none hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
            view === id ? 'text-foreground' : 'text-muted-foreground')}>
          <Icon aria-hidden="true" className="size-3.5" />
        </button>)}
      </span>
    </div>
    {inputError ? <span role="status" className="shrink-0 truncate px-2 t-meta text-bad">O herdr não aceitou: {inputError}</span> : null}
    <div className="flex min-h-0 flex-1 flex-col">{body}</div>
  </div>;
}

/* ---------------------------------------------------------------- terminal criado no canvas (tipo `terminal`)
 * Nó do usuário (`live: false`): o processo é um pane do herdr criado pela página (POST /api/argos/terminals) e o par
 * `herdr { session, pane }` fica no `data` do nó, com a aparência. A predefinição só sugere os valores iniciais: campo não
 * escolhido não entra no `data` e segue o padrão global. */
const TERMINAL_TYPE = 'terminal';
const TERMINAL_SIZE = Object.freeze({ w: 640, h: 420 });
// nó `agent` novo nasce cabendo ~80×24 células na escala do canvas (o 200×66 era da época sem terminal no nó)
const AGENT_NODE_SIZE = Object.freeze({ w: 480, h: 320 });
const TERMINAL_MENU = Object.freeze(['term:edit', 'term:role', 'term:appearance', 'term:connections', 'tty:close']);
const TERMINAL_ICONS = Object.freeze(['SquareTerminal', 'Bot', 'Code', 'Bug', 'FlaskConical', 'Eye', 'Hammer', 'Crown', 'Brain', 'Rocket', 'Shield', 'Wrench', 'Sparkles', 'BookOpen']);
const TERMINAL_THEMES = Object.freeze(['system', 'dark', 'light', 'custom']);
const TERMINAL_THEME_LABELS = Object.freeze({ system: 'Sistema', dark: 'Escuro', light: 'Claro', custom: 'Personalizado' });
const TERMINAL_FONTS = Object.freeze({
  geist: "'Geist Mono', ui-monospace, monospace",
  system: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  courier: "'Courier New', Courier, monospace",
});
const TERMINAL_FONT_LABELS = Object.freeze({ geist: 'Geist Mono', system: 'Mono do sistema', courier: 'Courier' });
// tons fixos dos temas Escuro e Claro do terminal (o padrão, sem tema, é o do painel: escuro nos dois temas do painel)
const TERMINAL_PALETTES = Object.freeze({
  dark: { term: 'oklch(0.16 0.012 260)', fg: 'oklch(0.92 0.01 260)', muted: 'oklch(0.68 0.02 260)' },
  light: { term: 'oklch(0.985 0.004 90)', fg: 'oklch(0.25 0.02 260)', muted: 'oklch(0.5 0.02 260)' },
});
const TERMINAL_NAME_MAX = 80;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
// agente, modelo, esforço, predefinição e papel: nomes curtos que vão à rota; o resto é recusado antes da rede
const TERMINAL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const TERMINAL_FIELDS = Object.freeze(['agent', 'model', 'effort', 'preset', 'role']);
/** Formato dos ids do documento (o mesmo de `canvas-doc`). */
const TERMINAL_NODE_ID = /^[\w.:-]{1,200}$/;

const isName = (v) => typeof v === 'string' && v.trim() !== '' && v.trim().length <= TERMINAL_NAME_MAX;

/**
 * O `data` do nó `terminal` lido do documento: só os campos válidos voltam (o resto some, sem virar padrão inventado).
 * `name` falta → `null` (o nó mostra "terminal"). Mesma regra para o que vem da predefinição e do modal.
 */
function readTerminalData(data) {
  const d = data && typeof data === 'object' ? data : {};
  const out = { name: isName(d.name) ? d.name.trim() : null };
  if (TERMINAL_ICONS.includes(d.icon)) out.icon = d.icon;
  if (HEX_COLOR.test(d.color || '')) out.color = d.color;
  if (TERMINAL_THEMES.includes(d.theme)) out.theme = d.theme;
  if (HEX_COLOR.test(d.themeBg || '')) out.themeBg = d.themeBg;
  if (HEX_COLOR.test(d.themeFg || '')) out.themeFg = d.themeFg;
  if (Object.hasOwn(TERMINAL_FONTS, d.font || '')) out.font = d.font;
  for (const k of TERMINAL_FIELDS) if (typeof d[k] === 'string' && TERMINAL_TOKEN.test(d[k])) out[k] = d[k];
  const herdr = herdrRefOf(d.herdr);
  if (herdr) out.herdr = herdr;
  // orquestrador (D7): a caixa do modal; recruta: o id do nó do orquestrador que o criou (a CLI grava)
  if (d.orchestrator === true) out.orchestrator = true;
  if (typeof d.recruiter === 'string' && TERMINAL_NODE_ID.test(d.recruiter)) out.recruiter = d.recruiter;
  return out;
}

const NODE_SAVE_ATTEMPTS = 3;

/**
 * A criação do terminal só termina com o nó no documento do servidor: aplica a inclusão, grava, confere o que o servidor
 * guardou e, se o nó não está lá (recusa 409 ou envio perdido), relê e reaplica, até 3 tentativas como a CLI `hades canvas`.
 * `apply()` devolve o id do nó (ou null sem canvas carregado); `has(doc, id)` diz se o documento do servidor o contém.
 */
async function ensureNodeSaved({ apply, flush, fetchDoc, has, reread, attempts = NODE_SAVE_ATTEMPTS }) {
  for (let n = 1; n <= attempts; n += 1) {
    const id = apply();
    if (id) {
      await flush();
      let doc = null;
      try { doc = await fetchDoc(); } catch (e) { console.warn('argos: conferência do nó gravado falhou', e && e.name); }
      if (doc && has(doc, id)) return { ok: true, id, attempts: n };
    }
    if (n < attempts) await reread();
  }
  return { ok: false, code: 'terminal_node_unsaved', attempts };
}

/** O `data` do nó de um terminal órfão (registrado, vivo, sem nó): só os campos presentes, pelo mesmo filtro do documento. */
function orphanNodeData(orphan) {
  const o = orphan && typeof orphan === 'object' ? orphan : {};
  return readTerminalData({
    name: o.name, agent: o.agent, model: o.model, effort: o.effort, role: o.role,
    orchestrator: o.orchestrator, herdr: { session: o.session, pane: o.pane },
  });
}

/** Variáveis CSS do tema e da fonte do nó (o NodeTty pinta com elas); sem tema nem fonte, `{}` (segue o painel). */
function terminalThemeStyle(data, prefersDark) {
  const d = readTerminalData(data);
  let pal = null;
  if (d.theme === 'dark' || d.theme === 'light') pal = TERMINAL_PALETTES[d.theme];
  else if (d.theme === 'system') pal = TERMINAL_PALETTES[prefersDark ? 'dark' : 'light'];
  else if (d.theme === 'custom' && d.themeBg && d.themeFg) pal = { term: d.themeBg, fg: d.themeFg, muted: `color-mix(in oklch, ${d.themeFg} 65%, ${d.themeBg})` };
  const style = {};
  // as utilidades (`bg-term`) leem `--color-*`, resolvidas na raiz; o span lê `--term*` direto: as duas mudam aqui
  if (pal) Object.assign(style, { '--term': pal.term, '--color-term': pal.term, '--term-foreground': pal.fg, '--color-term-foreground': pal.fg,
    '--term-muted': pal.muted, '--color-term-muted': pal.muted });
  if (d.font) style['--font-mono'] = TERMINAL_FONTS[d.font];
  return style;
}

/**
 * Nó `terminal` no formato dos tipos vivos (`session`/`pane` soltos, sem `herdr`): segue com aquele desenho e sem os
 * comandos de terminal criado (fechar mataria um pane que o canvas não criou).
 */
function isLiveTerminalData(data) {
  const d = data && typeof data === 'object' ? data : {};
  return !herdrRefOf(d.herdr) && typeof d.session === 'string' && typeof d.pane === 'string';
}

/** Os panes dos nós `terminal` do documento (o par que a criação gravou); nó sem par válido fica de fora. */
function ttyTargetsOfDoc(doc) {
  const out = new Map();
  for (const n of list(doc && doc.nodes)) {
    if (!n || n.type !== TERMINAL_TYPE) continue;
    const ref = herdrRefOf(n.data && n.data.herdr);
    if (ref) out.set(n.id, ref);
  }
  return out;
}

/** Quantas arestas do documento tocam o nó (o badge de conexões). */
const linkCountOf = (doc, id) => list(doc && doc.edges).filter((e) => e && (e.from === id || e.to === id)).length;

/** Nó `terminal` novo, pronto para `opCreate`: retângulo arredondado à unidade, acima do mais alto. */
function newTerminalNode({ id, rect, data, top = 0 }) {
  return {
    id, type: TERMINAL_TYPE, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.max(1, Math.round(rect.w)), h: Math.max(1, Math.round(rect.h)),
    z: top + 1, data: { ...data }, locked: false, blurred: false,
  };
}

/** Segue `prefers-color-scheme` só enquanto `on` (tema Sistema); o ouvinte sai junto com o nó ou ao trocar de tema. */
function usePrefersDark(on) {
  const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const [dark, setDark] = useState(() => !!(query && query.matches));
  useEffect(() => {
    if (!on || !query) return undefined;
    const change = (e) => setDark(!!e.matches);
    setDark(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, [on]);
  return dark;
}

/* Desenho do nó `terminal`. deps = { roleOf(slug) → { name, color } | null, linksOf(id) → número, onConnections(id), grow }. */
function TerminalNode({ input, host, deps }) {
  const d = readTerminalData(input.data);
  const target = host.target(input.id);
  const pane = target ? target.pane : null;
  useTtyTopic(host, pane);
  useEffect(() => (pane ? host.mount(input.id) : undefined), [host, input.id, pane]);
  const dark = usePrefersDark(d.theme === 'system');
  const Icon = (d.icon && I[d.icon]) || I.SquareTerminal;
  const name = d.name || 'terminal';
  const role = d.role ? deps.roleOf(d.role) : null;
  const links = deps.linksOf(input.id);
  const attention = target ? host.attentionOf(input.id) : false;
  const jump = target && host.alt() ? host.jumpNumbers().get(input.id) : undefined;
  const inputError = target ? host.inputErrorOf(input.id) : null;
  const word = window.CanvasModel.argos.stateLook(target ? host.statusOf(input.id) : 'unknown').word;
  return <div className="flex h-full min-h-0 flex-col bg-card" data-terminal-node={input.id} style={terminalThemeStyle(input.data, dark)}>
    <div className="flex shrink-0 items-center gap-1.5 border-b px-2 t-meta" style={{ height: TTY_HEADER_PX, boxShadow: d.color ? `inset 0 3px 0 ${d.color}` : undefined }}>
      {jump ? <kbd aria-label={`Alt+${jump} foca este terminal`} className="inline-flex h-5 min-w-5 items-center justify-center border border-border-strong bg-muted px-1 font-mono t-micro text-foreground">{jump}</kbd> : null}
      <Icon aria-hidden="true" className="size-3.5 shrink-0" style={d.color ? { color: d.color } : undefined} />
      <span className="min-w-0 flex-1 truncate t-body-strong" title={name}>{name}</span>
      {d.orchestrator ? <span title="Orquestrador: comanda recrutas pelo hades canvas" className="inline-flex shrink-0 items-center gap-0.5 border border-primary px-1 t-micro text-primary">
        <I.Network aria-hidden="true" className="size-3" />Orquestrador</span> : null}
      {d.role ? <span title={`Papel: ${role ? role.name : d.role}`} className="max-w-28 shrink-0 truncate t-micro text-muted-foreground">{role ? role.name : d.role}</span> : null}
      {links ? <button type="button" aria-label={`${links} ${links === 1 ? 'conexão' : 'conexões'}`} title="Conexões" onClick={() => deps.onConnections(input.id)}
        className="inline-flex h-5 shrink-0 items-center gap-0.5 px-1 text-muted-foreground outline-none hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        <I.Cable aria-hidden="true" className="size-3" />{links}
      </button> : null}
      <span className="shrink-0 text-muted-foreground">{target ? word : 'sem pane'}</span>
      {attention ? <span role="img" aria-label="pede atenção" title="pede atenção" className="size-2 shrink-0 rounded-full bg-bad" /> : null}
    </div>
    {inputError ? <span role="status" className="shrink-0 truncate px-2 t-meta text-bad">O herdr não aceitou: {inputError}</span> : null}
    <div className="flex min-h-0 flex-1 flex-col">
      {target ? ttyBody({ host, input, target, grow: deps.grow })
        : <span role="status" className="p-2 t-meta text-muted-foreground">Sem pane do herdr: o terminal foi fechado fora do canvas ou o nó veio de uma cópia.</span>}
    </div>
  </div>;
}

/** Declaração do tipo `terminal` para o registro de tipos (`menu` = os comandos `term:*` e `tty:close` de commands-canvas). */
function terminalTypeDef(render) {
  return { type: TERMINAL_TYPE, label: 'Terminal', icon: 'SquareTerminal', defaultSize: { ...TERMINAL_SIZE }, draw: { surface: 'html', render },
    menu: [...TERMINAL_MENU], actions: [], live: false };
}

/** Registra o tipo uma vez (chamar de novo, como no modo estrito do React, não repete); devolve a declaração ou `null`. */
function registerTerminalType(types, render) {
  if (types.get(TERMINAL_TYPE)) return null;
  const def = terminalTypeDef(render);
  types.register(def);
  return def;
}

/**
 * Documento gravado por fora da página (a CLI `hades canvas` do orquestrador): relê só com a aba visível, o gravador
 * parado e nada agendado (`busy`), e a revisão do servidor à frente da conhecida. Com edição na fila não relê: o envio
 * dela volta `stale` e o caminho de sempre do gravador avisa e relê; reler antes faria o envio pendente sobrescrever o
 * que a CLI gravou.
 */
function externalRevReload({ hidden, busy, knownRev, serverRev }) {
  return !hidden && !busy && Number.isInteger(serverRev) && Number.isInteger(knownRev) && serverRev > knownRev;
}

/** Há quanto tempo (ms) a tela está atrás do servidor, sem conseguir reler, antes do aviso "o canvas mudou por fora". */
const EXTERNAL_STALE_MS = 10_000;

/**
 * Quando a tela relê o documento que mudou por fora. O aviso do servidor (stream), a conferência de 4 s e a volta da aba
 * chamam `observe({ serverRev, hidden })`; o gravador, ao ficar ocioso, chama `settled`. A regra de relê/não relê é a de
 * `externalRevReload`; quando ela diz não, o motivo (`hidden`, `busy: <estado>`, `rev igual`) vai para `log`, uma vez por
 * mudança de motivo, e passado `EXTERNAL_STALE_MS` atrás do servidor sai o aviso (`onStale(true)`).
 * `busy()` devolve o estado do gravador (`saving`, `error`, `fila`…) ou `null` se ocioso e sem edição na fila; `reload()`
 * devolve `false` quando descartou a leitura (o dono editou durante ela). `diverged()`: o gravador reconciliou com o servidor
 * mas a tela não recebeu o resultado (edição na fila), então a revisão gravada não prova que a tela está em dia.
 */
function createCanvasWatch({ now, busy, reload, onStale, log }) {
  let knownRev = 0;
  let unseenRev = 0;
  let behindSince = null;
  let divergedFlag = false;
  let stale = false;
  let lastReason = '';
  let reloading = null;
  const setStale = (on) => { if (stale !== on) { stale = on; onStale(on); } };
  const skip = (reason) => { if (reason !== lastReason) { lastReason = reason; log(reason); } return { reloaded: false, reason }; };
  const behind = () => { if (behindSince === null) behindSince = now(); };
  const settle = () => { behindSince = null; unseenRev = 0; setStale(false); };

  function pull(hidden) {
    const state = busy();
    const reason = hidden ? 'hidden' : state ? `busy: ${state}` : null;
    if (reason) {
      if (behindSince !== null && now() - behindSince >= EXTERNAL_STALE_MS) setStale(true);
      return Promise.resolve(skip(reason));
    }
    reloading ??= Promise.resolve().then(reload).then((applied) => ({ reloaded: applied !== false, reason: applied === false ? 'descartada' : '' }),
      (e) => { log(`relê falhou: ${e && e.name}`); return { reloaded: false, reason: 'falhou' }; }).finally(() => { reloading = null; });
    return reloading;
  }

  return {
    /** A tela leu (ou recebeu reconciliada) o documento na revisão `rev`. */
    loaded(rev) { knownRev = rev; divergedFlag = false; lastReason = ''; settle(); },
    /** O PUT da tela foi aceito na revisão `rev`. */
    saved(rev) {
      if (divergedFlag) return;
      knownRev = rev;
      if (unseenRev <= rev) settle();
    },
    diverged() { divergedFlag = true; behind(); },
    observe({ serverRev, hidden }) {
      if (!Number.isInteger(serverRev)) return Promise.resolve(skip('rev inválida'));
      if (externalRevReload({ hidden: false, busy: false, knownRev, serverRev })) { unseenRev = Math.max(unseenRev, serverRev); behind(); }
      else if (behindSince === null) return Promise.resolve(skip('rev igual'));
      return pull(hidden);
    },
    settled({ hidden }) { return behindSince === null ? Promise.resolve({ reloaded: false, reason: 'em dia' }) : pull(hidden); },
    skip,
  };
}

window.ArgosNodeTerminal = {
  NodeTerminal, usePaneOutput, KEYS,
  AgentTtyNode, createTtyHost, filterTtyInput, ttyTargetsOf, ttyTargetOf, ttyAttention, seenAfter, nextAttentionId, jumpNumbers,
  ttyMinNodeSize, ttyScaleOf, ttyHeaderOnly, frameFromRead, withSession, takeInputBatch, ttyKeyInput, ttyLetsCommand, TTY_BLOCKED_KEYS, TTY_HEADER_PX,
  // terminal criado no canvas
  TERMINAL_TYPE, TERMINAL_SIZE, AGENT_NODE_SIZE, TERMINAL_MENU, TERMINAL_ICONS, TERMINAL_THEMES, TERMINAL_THEME_LABELS, TERMINAL_FONTS, TERMINAL_FONT_LABELS,
  TERMINAL_NAME_MAX, TerminalNode, readTerminalData, isLiveTerminalData, terminalThemeStyle, ttyTargetsOfDoc, linkCountOf, newTerminalNode, herdrRefOf, terminalTypeDef,
  registerTerminalType, ensureNodeSaved, orphanNodeData, externalRevReload, createCanvasWatch, EXTERNAL_STALE_MS,
};
})();
