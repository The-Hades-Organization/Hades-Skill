/* Página Claude (#/claude): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela.
 * Leitura primeiro: a conversa numa coluna de 70ch, as sessões como lista com rótulo, a Prompt Bar embaixo. */
(() => {
const { useState, useEffect, useRef, useMemo, useCallback, I, cn, dur, dt, post, getJSON, Button, Dot, Card, CardHeader,
  CardContent, Skeleton, Empty, Tip, CopyButton, Kbd, Fio, modelLabel, ago, useApp, Segmented, Select, PtyTerminal, useTermRoots } = HadesCore;

// ================================================================== Claude (chat com o claude -p)
// Markdown da resposta: instância própria do marked (HTML cru vira texto, imagem vira o alt, link só http/https/mailto)
// e uma segunda passada no DOM inerte (DOMParser não executa nem carrega nada) que só deixa passar tags da lista.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CHAT_TAGS = new Set(['A', 'P', 'BR', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'SPAN']);
const safeHref = (h) => /^(https?:|mailto:|#)/i.test((h || '').trim());
let chatMd = null;
function sanitizeChat(htmlText) {
  const doc = new DOMParser().parseFromString('<body>' + htmlText, 'text/html');
  const walk = (n) => {
    for (const c of [...n.childNodes]) {
      if (c.nodeType === 3) continue;
      if (c.nodeType !== 1 || !CHAT_TAGS.has(c.tagName)) { c.replaceWith(doc.createTextNode(c.textContent || '')); continue; }
      for (const a of [...c.attributes]) if (!(c.tagName === 'A' && a.name === 'href' && safeHref(a.value))) c.removeAttribute(a.name);
      if (c.tagName === 'A') {
        if (c.hasAttribute('href')) { c.setAttribute('target', '_blank'); c.setAttribute('rel', 'noopener noreferrer nofollow'); }
      }
      walk(c);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}
function renderChatMd(text) {
  if (!chatMd) chatMd = new marked.Marked({ gfm: true, breaks: true, renderer: {
    html(h) { return esc(typeof h === 'string' ? h : h.text || h.raw || ''); },
    image(href, title, alt) { return esc(typeof href === 'object' ? href.text || '' : alt || ''); },
    link(href, title, t) { const h = typeof href === 'object' ? href : { href, text: t }; return safeHref(h.href) ? `<a href="${esc(h.href)}">${h.text}</a>` : h.text; },
  } });
  return sanitizeChat(chatMd.parse(text));
}
const ChatMd = React.memo(function ChatMd({ text }) {
  const h = useMemo(() => renderChatMd(text), [text]);
  return <div className="md md-chat" dangerouslySetInnerHTML={{ __html: h }} />;
});

// centavo de dólar com duas casas; abaixo de um centavo, quatro (senão uma conversa curta vira US$ 0,00)
const usd4 = (v) => v == null ? '—' : 'US$ ' + v.toFixed(v < 0.01 ? 4 : 2).replace('.', ',');
const ntok = (v) => v == null ? '—' : v >= 10000 ? Math.round(v / 1000) + 'k' : v >= 1000 ? (v / 1000).toFixed(1).replace('.', ',') + 'k' : String(v);
const tokLine = (t) => t ? `${ntok(t.input)} entrada · ${ntok(t.output)} saída${(t.cacheRead || t.cacheWrite) ? ` · ${ntok((t.cacheRead || 0) + (t.cacheWrite || 0))} cache` : ''}` : '';

// eventos do /api/claude/stream viram uma lista de itens da conversa
const CHAT0 = { items: [], live: '', running: false, last: null };
function chatReduce(s, e) {
  const items = s.items;
  switch (e.t) {
    case 'reset': return CHAT0;
    case 'user': return { ...s, items: [...items, { k: 'user', text: e.text, remote: e.remote, ts: e.ts }], live: '', running: true, last: null };
    case 'delta': return { ...s, live: s.live + e.text };
    case 'text': return { ...s, live: '', items: [...items, { k: 'assistant', text: e.text, sub: e.sub }] };
    case 'tool': return { ...s, live: '', items: [...items, { k: 'tool', id: e.id, name: e.name, input: e.input, sub: e.sub, result: null }] };
    case 'tool_result': return { ...s, items: items.map((x) => x.k === 'tool' && x.id === e.id ? { ...x, result: e } : x) };
    case 'warn': return { ...s, items: [...items, { k: 'warn', text: e.text }] };
    case 'stderr': return { ...s, items: [...items, { k: 'stderr', text: e.text }] };
    case 'result': return { ...s, live: '', last: 'result', items: [...items, { k: 'result', ...e }] };
    case 'end': {   // o texto que já tinha chegado fica, mesmo se a resposta foi interrompida
      const kept = s.live ? [...items, { k: 'assistant', text: s.live }] : items;
      return { ...s, live: '', running: false, items: s.last === 'result' && !e.stopped && !e.rc ? kept : [...kept, { k: 'end', rc: e.rc, stopped: e.stopped }] };
    }
    default: return s;
  }
}

const turnText = (items, i) => {
  const out = [];
  for (let j = i - 1; j >= 0 && items[j].k !== 'user'; j--) if (items[j].k === 'assistant' && !items[j].sub) out.unshift(items[j].text);
  return out.join('\n\n');
};
// a conversa ocupa uma coluna de leitura; o compositor segue a mesma largura para o olho não pular
const COLUNA = 'mx-auto w-full max-w-[70ch]';
const EFFORT = { low: 'baixo', medium: 'médio', high: 'alto', max: 'máximo' };

function ChatTool({ x }) {
  const Icon = { Bash: I.Terminal, Read: I.FileText, Edit: I.Pencil, Write: I.Pencil, Grep: I.Search, Glob: I.Search, Agent: I.Bot, Task: I.Bot }[x.name] || I.Wrench;
  const r = x.result;
  const state = !r ? 'rodando' : r.denied ? 'recusada' : r.error ? 'com erro' : 'feita';
  return <details className={cn('group border t-body', x.sub && 'ml-4', r?.denied ? 'border-bad/60' : r?.error && 'border-bad/40')}>
    <summary aria-label={`${x.name}: ${state}`} className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 py-1.5 transition-colors hover:bg-accent/60 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-md:min-h-11 [&::-webkit-details-marker]:hidden">
      <I.ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="shrink-0 font-medium">
        {x.name}
      </span>
      <span className="min-w-0 flex-1 truncate t-data text-muted-foreground">
        {x.input}
      </span>
      {!r ? <Dot kind="busy" pulse />
        : r.denied ? <I.ShieldAlert className="size-3.5 shrink-0 text-bad" aria-hidden="true" />
        : r.error ? <I.CircleX className="size-3.5 shrink-0 text-bad" aria-hidden="true" /> : <I.Check className="size-3.5 shrink-0 text-ok" aria-hidden="true" />}
    </summary>
    <div className="grid gap-2 border-t px-3 py-2.5">
      <div className="break-all t-data">
        {x.input}
      </div>
      {r ? <pre className={cn('max-h-72 overflow-auto whitespace-pre-wrap break-words border bg-term p-2.5 t-code text-term-foreground scrollbar-thin', r.error && 'border-bad/50')}>
        {r.text || '(sem saída)'}
      </pre> : null}
    </div>
  </details>;
}

// aviso, recusa e erro: a forma (ícone) carrega o tom; a faixa é só um filete
// subtipos de erro do claude -p que o dono entende sem o nome cru
const SUBTYPE = { error_max_turns: 'teto de turnos', error_max_budget_usd: 'teto de custo' };
function Aviso({ icon: Icon, tone, children }) {
  return <div className={cn('flex items-start gap-2.5 border px-3 py-2.5 t-body', tone === 'bad' ? 'border-bad/50' : 'border-warn/50')}>
    <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'bad' ? 'text-bad' : 'text-warn')} aria-hidden="true" />
    <div className="min-w-0 flex-1">
      {children}
    </div>
  </div>;
}

// `copy` é o texto da resposta inteira do turno (as falas do Claude desde a pergunta), para copiar de uma vez
function ChatItem({ x, copy, onApprove }) {
  if (x.k === 'user') return <div className="mt-3 flex flex-col items-end gap-1 first:mt-0">
    <div className="max-w-[88%] whitespace-pre-wrap break-words bg-muted px-3.5 py-2.5 t-prose leading-6">
      {x.text}
    </div>
    {x.remote ? <span className="flex items-center gap-1 t-meta text-muted-foreground">
      <I.Globe className="size-3" aria-hidden="true" />
      pelo acesso remoto
    </span> : null}
  </div>;
  if (x.k === 'assistant') return <div className={cn('min-w-0', x.sub && 'ml-4 border-l pl-3 text-muted-foreground')}>
    <ChatMd text={x.text} />
  </div>;
  if (x.k === 'tool') return <ChatTool x={x} />;
  if (x.k === 'warn') return <Aviso icon={I.TriangleAlert} tone="warn">
    <span className="whitespace-pre-wrap break-words">
      {x.text}
    </span>
  </Aviso>;
  if (x.k === 'stderr') return <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border bg-term p-2.5 t-code text-term-muted scrollbar-thin">
    {x.text}
  </pre>;
  if (x.k === 'end') return <div className="flex items-center gap-2 t-meta text-muted-foreground">
    <I.OctagonX className="size-3.5" aria-hidden="true" />
    {x.stopped ? 'Resposta interrompida.' : `A resposta parou com erro (saída ${x.rc}). Mande de novo ou veja o log em Execuções.`}
  </div>;
  if (x.k === 'result') return <div className="grid gap-2">
    {x.denials?.length ? <Aviso icon={I.ShieldAlert} tone="bad">
      <div className="font-medium">
        {'O Claude não pôde rodar ' + (x.denials.length === 1 ? 'uma ferramenta' : x.denials.length + ' ferramentas') + '. Peça outro caminho ou rode você no terminal.'}
      </div>
      {x.denials.map((d, i) => <div key={i} className="truncate t-data text-muted-foreground">
        {d.tool + ' · ' + d.input}
      </div>)}
      {onApprove ? <Button size="xs" variant="outline" icon={I.SquareTerminal} className="mt-2" onClick={onApprove}>Abrir no terminal para aprovar</Button> : null}
    </Aviso> : null}
    {!x.ok ? <Aviso icon={I.CircleX} tone="bad">
      <span className="whitespace-pre-wrap break-words">
        {x.text || 'Erro na resposta (' + (SUBTYPE[x.subtype] || x.subtype) + ').'}
      </span>
    </Aviso> : null}
    <div className="flex items-center gap-2 border-t pt-1">
      <span className="min-w-0 flex-1 font-mono t-micro text-muted-foreground tnum">
        {[usd4(x.cost), tokLine(x.tokens), x.ms != null ? dur(x.ms / 1000) : ''].filter(Boolean).join(' · ')}
      </span>
      {copy ? <CopyButton text={copy} label="Copiar a resposta" /> : null}
    </div>
  </div>;
  return null;
}

// o rótulo da sessão: o que ela está fazendo ou de onde veio, depois quando e quanto custou
function SessionRow({ s, on, onPick, onDelete }) {
  const label = s.running ? 'respondendo' : s.remote ? 'pelo acesso remoto' : null;
  return <li className={cn('group relative flex items-start gap-1 border-b border-l-2 transition-colors hover:bg-accent/60', on ? 'border-l-foreground bg-accent/40' : 'border-l-transparent')}>
    <button type="button" onClick={() => onPick(s.id)} aria-current={on || undefined} className="min-w-0 flex-1 cursor-pointer py-2.5 pl-3 text-left outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring">
      <span className="block truncate t-label">
        {s.title}
      </span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 t-meta text-muted-foreground tnum">
        {label ? <span className={cn('inline-flex items-center gap-1.5', s.running && 'text-foreground')}>
          {s.running ? <Dot kind="busy" pulse /> : <I.Globe className="size-3" aria-hidden="true" />}
          {label}
          <span aria-hidden="true">·</span>
        </span> : null}
        <Tip text={dt(s.updated)}>
          <span>{ago(s.updated)}</span>
        </Tip>
        <span aria-hidden="true">·</span>
        <span>{usd4(s.cost)}</span>
      </span>
    </button>
    <Tip text={s.running ? 'Pare a resposta antes' : 'Apagar do registro'} className="relative z-10 mt-1.5 mr-1 md:invisible md:group-hover:visible md:group-focus-within:visible">
      <Button variant="ghost" size="icon-xs" aria-label={`Apagar a conversa ${s.title} do registro`} icon={I.Trash2} disabled={s.running} onClick={() => onDelete(s)} />
    </Tip>
  </li>;
}

function SessionList({ ov, sid, onPick, onNew, onDelete }) {
  const running = ov.sessions.filter((s) => s.running).length;
  return <Card className="min-h-0 flex-1 gap-0" data-tour-step-id="claude-conversas">
    <CardHeader title="Conversas" summary={ov.sessions.length ? (running ? `${running} respondendo` : String(ov.sessions.length)) : undefined}
      action={<Button size="xs" variant="outline" icon={I.Plus} onClick={onNew}>Nova</Button>} />
    <CardContent className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      {ov.sessions.length ? <ul>
        {ov.sessions.map((s) => <SessionRow key={s.id} s={s} on={s.id === sid} onPick={onPick} onDelete={onDelete} />)}
      </ul> : <Empty icon={I.MessageSquare} title="Nenhuma conversa ainda">A primeira mensagem abre uma.</Empty>}
    </CardContent>
  </Card>;
}

function Intro({ ov }) {
  return <div className="grid gap-3 t-prose leading-6" data-tour-step-id="claude-intro">
    <p>
      {'Claude Code em '}
      <span className="font-mono text-[0.85em]">{ov.clone || 'repositório'}</span>
      {', via '}
      <span className="font-mono text-[0.85em]">claude -p</span>
      {' em auto mode: roda no clone principal e executa comandos e edições sem pedir confirmação. O hook '}
      <span className="font-mono text-[0.85em]">hades guard</span>
      {' continua barrando o que barra numa sessão interativa.'}
    </p>
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 t-body text-muted-foreground">
      <Kbd>Enter</Kbd>
      envia,
      <Kbd>Shift Enter</Kbd>
      quebra a linha.
    </p>
    {ov.remote ? <p className="t-body text-muted-foreground">
      Acesso remoto: o Hades avisa o dono quando a conversa começa.
    </p> : !ov.notify ? <p className="t-body text-muted-foreground">
      Ligue as Notificações para saber das conversas remotas.
    </p> : null}
  </div>;
}

// ================================================================== Modo terminal (Claude Code de verdade num PtyTerminal)
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TERM_STORE = 'hades-claude-term';
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1) || p;
// o servidor devolve o `code`; a dica de "como ligar" vem do TermLogic (um texto só para o painel inteiro)
const refusalOf = (d, status) => window.TermLogic.refusal(d && d.code, status);

function TermMode({ ov, resume, onResume, term, mobile }) {
  const api = useRef({ filter: null });
  const [cwd, setCwd] = useState('');
  const [err, setErr] = useState(null);
  const [tid, setTid] = useState(() => { try { return sessionStorage.getItem(TERM_STORE) || null; } catch (e) { return null; } });
  const [spec, setSpec] = useState(null);
  const [exited, setExited] = useState(false);
  const known = ov.sessions.filter((s) => s.claudeSession);
  const roots = term?.roots || [];
  const dir = cwd || roots[0] || '';
  const keep = (id) => { setTid(id); try { id ? sessionStorage.setItem(TERM_STORE, id) : sessionStorage.removeItem(TERM_STORE); } catch (e) { /* aba privada: a mesa não lembra */ } };

  const start = useCallback((r) => { setErr(null); setExited(false); keep(null); setSpec({ kind: 'claude', ...(dir ? { cwd: dir } : {}), ...(r ? { resume: r } : {}) }); }, [dir]);
  // "continuar no terminal" / "aprovar": a página manda o id e a sessão abre sozinha
  useEffect(() => { if (resume && term?.enabled) { start(resume); onResume(null); } }, [resume, term]);
  const close = useCallback(async () => {
    const id = tid;
    keep(null); setSpec(null); setExited(false);
    if (id) try { await post('/api/term/close', { id }); } catch (e) { /* já fechada */ }
  }, [tid]);

  if (!term) return <div className="grid flex-1 place-content-center t-meta text-muted-foreground" aria-busy="true">Consultando o terminal…</div>;
  if (!term.enabled) {
    const r = refusalOf({ code: 'term_disabled' }, 403);
    return <div className="grid flex-1 place-content-center justify-items-center gap-3 p-6 text-center" role="status" data-claude-term="disabled">
      <I.SquareTerminal className="size-6 text-muted-foreground" aria-hidden="true" />
      <div className="t-section">{r.title}</div>
      <p className="max-w-md t-body text-muted-foreground">{r.hint}</p>
      <a className="t-body text-info hover:underline" href="#/config">Abrir Configurações</a>
    </div>;
  }
  const live = tid || spec;
  return <div className="flex min-h-0 flex-1 flex-col" data-claude-term="on">
    <div className="flex flex-wrap items-end gap-3 border-b px-4 py-2.5 max-md:px-2">
      <div className="grid min-w-0 gap-1 t-meta text-muted-foreground">
        Pasta
        <Select label="Pasta" value={dir} disabled={!!live} onChange={setCwd} className="max-w-64" items={roots.map((r) => ({ value: r, label: baseName(r) }))} />
      </div>
      <div className="grid min-w-0 gap-1 t-meta text-muted-foreground">
        Sessão
        <Select label="Retomar uma sessão" value={spec?.resume || resume || ''} disabled={!!live} onChange={(v) => onResume(v || null)} className="max-w-64"
          items={[{ value: '', label: 'Nova sessão' }, ...known.map((s) => ({ value: s.claudeSession, label: s.title }))]} />
      </div>
      {live ? <Button size="sm" variant="outline" icon={I.X} onClick={close}>{exited ? 'Fechar' : 'Encerrar'}</Button>
        : <Button size="sm" icon={I.SquareTerminal} onClick={() => start(resume && SESSION_RE.test(resume) ? resume : null)}>Abrir o Claude Code</Button>}
      <span className="min-w-0 flex-1 truncate t-meta text-muted-foreground max-md:hidden">auto mode · aprovações no próprio terminal</span>
    </div>
    {err ? <div className="px-4 py-3"><Aviso icon={I.TriangleAlert} tone="warn"><div className="font-medium">{err.title}</div><div className="t-body text-muted-foreground">{err.hint}</div></Aviso></div> : null}
    {live ? <PtyTerminal key={spec ? JSON.stringify(spec) : tid} className="min-h-0 flex-1" id={spec ? undefined : tid} open={spec || undefined}
      apiRef={api} onOpened={(sess) => keep(sess.id)} onExit={() => setExited(true)}
      onState={(ph) => { if (ph.kind === 'refused') { setErr(ph.refusal); if (ph.refusal.kind !== 'disabled') { keep(null); setSpec(null); } } }} />
      : <div className="grid flex-1 place-content-center p-6 t-body text-muted-foreground">Escolha a pasta e a sessão e abra o Claude Code aqui.</div>}
    {live && mobile ? <HadesCore.Mobile.TermKeyBar api={api} attention /> : null}
  </div>;
}

// ================================================================== Anexos (imagem ou texto, para $D/claude/attach/<sessão>)
const ATTACH_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,.txt,.md,.json,.log,.csv,.tsv,.yaml,.yml,.toml,.ini,.diff,.patch,.ts,.tsx,.js,.jsx,.mjs,.py,.sh,.rs,.go,.java,.kt,.c,.h,.cpp,.css,.html,.sql,.xml,.env';
function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
const kb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
// o `post` da base lança Error com a mensagem; o upload usa o dele só para repassar o token e ler o `code`
async function uploadAttachment(body) {
  const go = (token) => fetch('/api/claude/attach', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panel-Token': token }, body: JSON.stringify(body) });
  let r = await go(window.__TOKEN);
  let d = await r.json().catch(() => ({}));
  if (r.status === 403 && d.error === 'token') {
    const t = await fetch('/api/token', { cache: 'no-store' }).then((x) => x.json()).catch(() => ({}));
    if (t.token && t.token !== window.__TOKEN) { window.__TOKEN = t.token; r = await go(t.token); d = await r.json().catch(() => ({})); }
  }
  if (!r.ok) throw new Error(d.error || 'falha no envio do arquivo');
  return d;
}

function Claude() {
  const { toast, confirm } = useApp();
  const [ov, setOv] = useState(null);
  const [sid, setSid] = useState(null);
  const [st, dispatch] = React.useReducer(chatReduce, CHAT0);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const mobile = HadesCore.Mobile.useIsMobile();
  const nav = HadesCore.Mobile.useMobileLevel();
  const detailOn = mobile && nav.level === 'detail';
  const vbox = HadesCore.Mobile.useViewBox(detailOn);
  const [mode, setMode] = useState('chat');
  const [resume, setResume] = useState(null);
  const [files, setFiles] = useState([]);
  const [draft, setDraft] = useState(null);
  const pick_ = useRef(null);
  const term = useTermRoots();
  const es = useRef(null), off = useRef(0), box = useRef(null), stick = useRef(true), area = useRef(null);

  const loadOv = useCallback(() => getJSON('/api/claude').then(setOv).catch(() => {}), []);
  useEffect(() => { loadOv(); const t = setInterval(loadOv, 4000); return () => clearInterval(t); }, [loadOv]);

  const close = useCallback(() => { if (es.current) { es.current.close(); es.current = null; } }, []);
  const open = useCallback((id, from) => {
    close();
    off.current = from;
    const src = new EventSource(`/api/claude/stream?id=${id}&offset=${from}`);
    es.current = src;
    src.onmessage = (m) => { if (m.lastEventId) off.current = Number(m.lastEventId); try { dispatch(JSON.parse(m.data)); } catch (e) {} };
    src.addEventListener('done', (m) => { if (m.lastEventId) off.current = Number(m.lastEventId); src.close(); if (es.current === src) es.current = null; loadOv(); });
    // 404 (sessão apagada) não religa; queda de rede o EventSource religa sozinho, com o último id
    src.onerror = () => { if (src.readyState === EventSource.CLOSED && es.current === src) es.current = null; };
  }, [close, loadOv]);
  useEffect(() => close, [close]);

  const pick = useCallback((id) => { setFiles([]); setDraft(null); setMode('chat'); setSid(id); dispatch({ t: 'reset' }); stick.current = true; open(id, 0); if (mobile) nav.enter(); }, [open, mobile, nav.enter]);
  // link direto: #/claude?s=<id> abre a sessão (a notificação e o atalho do celular usam)
  useEffect(() => { const m = /[?&]s=([0-9a-f]{8})/.exec(location.hash); if (m) pick(m[1]); }, []);
  const fresh = useCallback(() => { close(); setSid(null); setFiles([]); setDraft(null); dispatch({ t: 'reset' }); setText(''); area.current?.focus(); }, [close]);
  // celular: "Nova" e "Terminal" abrem o detalhe em tela cheia
  const startNew = useCallback((terminal) => { fresh(); setMode(terminal ? 'terminal' : 'chat'); if (mobile) nav.enter(); }, [fresh, mobile, nav.enter]);
  const del = useCallback(async (s) => {
    if (!(await confirm({ title: 'Apagar a conversa do registro?', description: `${s.title}\n\nSai só do registro do Hades; o transcript fica em ~/.claude/projects.`, danger: true, icon: I.Trash2, confirmLabel: 'Apagar' }))) return;
    try { await post('/api/claude/delete', { id: s.id }); if (s.id === sid) fresh(); loadOv(); } catch (e) { toast({ kind: 'bad', title: 'Falha ao apagar', desc: e.message }); }
  }, [confirm, toast, sid, fresh, loadOv]);

  const send = useCallback(async (typed) => {
    const t = (typeof typed === 'string' ? typed : text).trim();
    if (!t || sending || st.running) return;
    setSending(true);
    try {
      const r = await post('/api/claude/send', { id: sid || undefined, text: t, ...(files.length ? { files: files.map((f) => f.file) } : {}), ...(!sid && draft ? { draft } : {}) });
      setText(''); setFiles([]); setDraft(null);
      stick.current = true;
      if (!sid) { setSid(r.id); dispatch({ t: 'reset' }); open(r.id, 0); } else open(r.id, off.current);
      loadOv();
    } catch (e) { toast({ kind: 'bad', title: 'Falha ao enviar', desc: e.message }); }
    setSending(false);
  }, [text, sending, st.running, sid, files, draft, open, loadOv, toast]);
  const attach = useCallback(async (list) => {
    for (const f of list) {
      try {
        const d = await uploadAttachment({ name: f.name, data: await fileBase64(f), ...((sid || draft) ? { id: sid || draft } : {}) });
        if (d.draft) setDraft(d.id);
        setFiles((prev) => [...prev, d]);
      } catch (e) { toast({ kind: 'bad', title: 'Anexo recusado', desc: `${f.name}: ${e.message}` }); }
    }
  }, [sid, draft, toast]);
  const toTerminal = useCallback((claudeSession) => { setMode('terminal'); setResume(claudeSession); }, []);
  const PromptBar = window.HadesFx.use('PromptBar');
  const stop = useCallback(async () => {
    try { await post('/api/claude/stop', { id: sid }); } catch (e) { toast({ kind: 'bad', title: 'Falha ao parar', desc: e.message }); }
  }, [sid, toast]);
  const turnOn = useCallback(async () => {
    try { await post('/api/config', { values: { HADES_CHAT: '1' } }); loadOv(); } catch (e) { toast({ kind: 'bad', title: 'Falha ao ligar', desc: e.message }); }
  }, [toast, loadOv]);

  // cola no fim enquanto a resposta chega, a menos que o dono tenha rolado para cima
  useEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [st.items, st.live]);
  useEffect(() => { const a = area.current; if (a) { a.style.height = 'auto'; a.style.height = Math.min(a.scrollHeight, 168) + 'px'; } }, [text]);

  if (!ov) return <div className="flex h-[calc(100dvh-14rem)] min-h-[420px] gap-6" aria-busy="true" aria-label="Carregando">
    <Skeleton className="hidden w-64 md:block" />
    <Skeleton className="flex-1" />
  </div>;
  if (!ov.enabled) return <div className="grid max-w-xl justify-items-start gap-3">
    <Empty icon={I.MessageSquare} title="Conversa desligada.">
      {'Ligue em Configurações → Sessão Claude' + (ov.remote ? ', pelo painel local.' : '.')}
    </Empty>
    {ov.remote ? null : <span data-tour-step-id="claude-ligar"><Button icon={I.Power} onClick={turnOn}>Ligar a conversa</Button></span>}
  </div>;

  const cur = ov.sessions.find((s) => s.id === sid);
  const busy = st.running || !!cur?.running;
  const how = [ov.model ? modelLabel(ov.model) : null, ov.effort ? 'esforço ' + (EFFORT[ov.effort] || ov.effort) : null, 'auto mode'].filter(Boolean).join(' · ');
  return <div className={cn('flex gap-6 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11', !mobile && 'h-[calc(100dvh-14rem)] min-h-[420px]')} data-claude-mobile={mobile ? nav.level : undefined}>
    <aside className="hidden w-72 shrink-0 flex-col md:flex">
      <SessionList ov={ov} sid={sid} onPick={pick} onNew={() => startNew(false)} onDelete={del} />
    </aside>
    {mobile && !detailOn ? <div className="flex min-w-0 flex-1 flex-col gap-3">
      <Button icon={I.SquareTerminal} variant="outline" onClick={() => startNew(true)}>Claude Code no terminal</Button>
      <SessionList ov={ov} sid={sid} onPick={pick} onNew={() => startNew(false)} onDelete={del} />
    </div> : null}
    {mobile && !detailOn ? null : <section aria-label="Conversa" style={detailOn ? { top: vbox.top, left: vbox.left, width: vbox.width, height: vbox.height } : undefined}
      className={cn('flex min-w-0 flex-1 flex-col overflow-hidden border', detailOn && 'fixed z-40 flex-none border-0 bg-background')}>
      <header className="flex min-h-14 items-center gap-3 border-b px-4 py-2.5 max-md:px-2" data-tour-step-id="claude-cabecalho">
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Voltar às conversas" icon={I.ArrowLeft} onClick={nav.leave} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate t-section leading-6">
            {cur?.title || 'Nova conversa'}
          </h2>
          <div className="truncate t-meta text-muted-foreground">
            <span className="font-mono">{ov.clone || 'repositório'}</span>
            {' · ' + how}
          </div>
        </div>
        <span data-tour-step-id="claude-modo"><Segmented label="Modo" value={mode} onChange={setMode} items={[{ value: 'chat', label: 'Chat', icon: I.MessageSquare }, { value: 'terminal', label: 'Terminal', icon: I.SquareTerminal }]} /></span>
        {mode === 'chat' && cur?.claudeSession ? <Tip text={busy ? 'Espere a resposta terminar' : 'Abre esta conversa no Claude Code de verdade'}>
          <span><Button size="xs" variant="outline" icon={I.SquareTerminal} disabled={busy} onClick={() => toTerminal(cur.claudeSession)} className="max-md:hidden">Continuar no terminal</Button></span>
        </Tip> : null}
        {busy ? <span className="flex shrink-0 items-center gap-1.5 t-label" role="status">
          <Dot kind="busy" pulse />
          respondendo
        </span> : ov.active ? <span className="shrink-0 t-meta text-muted-foreground tnum max-sm:hidden">
          {`${ov.active} de ${ov.max} conversas respondendo agora`}
        </span> : null}
      </header>
      {mode === 'terminal' ? <TermMode ov={ov} resume={resume} onResume={setResume} term={term} mobile={mobile} /> : <>
      <div ref={box} onScroll={(e) => { const b = e.currentTarget; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 scrollbar-thin max-md:px-3">
        <div className={cn(COLUNA, 'grid content-start gap-4')} data-tour-step-id="claude-conversa" aria-live="polite" aria-busy={busy || undefined}>
          {!st.items.length && !st.live ? <Intro ov={ov} /> : null}
          {st.items.map((x, i) => <ChatItem key={i} x={x} copy={x.k === 'result' ? turnText(st.items, i) : undefined} onApprove={x.k === 'result' && cur?.claudeSession && !busy ? () => toTerminal(cur.claudeSession) : undefined} />)}
          {st.live ? <div className="min-w-0">
            <ChatMd text={st.live} />
          </div> : null}
          {busy && !st.live ? <div className="flex items-center gap-3 t-meta text-muted-foreground">
            <Fio s="fiando" className="w-16" label="Claude pensando" />
            pensando…
          </div> : null}
        </div>
      </div>
      <div className="border-t px-4 py-3 max-md:px-2 max-md:py-2" data-tour-step-id="claude-envio">
        <div className={COLUNA}>
          {files.length ? <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Anexos desta mensagem">
            {files.map((f) => <li key={f.file} className="flex items-center gap-1.5 border px-2 py-1 t-meta">
              <I.Paperclip className="size-3" aria-hidden="true" />
              <span className="max-w-48 truncate font-mono">{f.name}</span>
              <span className="text-muted-foreground tnum">{kb(f.bytes)}</span>
              <button type="button" aria-label={`Tirar o anexo ${f.name}`} onClick={() => setFiles((p) => p.filter((x) => x.file !== f.file))} className="cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-ring"><I.X className="size-3" aria-hidden="true" /></button>
            </li>)}
          </ul> : null}
          <div className="flex items-end gap-2">
          <input ref={pick_} type="file" multiple accept={ATTACH_ACCEPT} className="hidden" onChange={(e) => { attach([...e.target.files]); e.target.value = ''; }} />
          <Button type="button" variant="outline" size="icon" icon={I.Paperclip} aria-label="Anexar arquivo (imagem ou texto)" title="Anexar arquivo (imagem ou texto)" disabled={busy} onClick={() => pick_.current?.click()} />
          <div className="min-w-0 flex-1">
          {PromptBar ? <PromptBar width={4000} radius={0} busy={busy} placeholder={busy ? 'Respondendo…' : 'Mensagem para o Claude'}
            sources={[]} commands={[]} models={[]} efforts={[]}
            background="var(--card)" color="var(--foreground)" menuBackground="var(--popover)" sparkColor="var(--primary)"
            onSend={(t) => send(t)} onStop={stop} /> : <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <textarea ref={area} value={text} rows={1} aria-label="Mensagem para o Claude" placeholder={busy ? 'Respondendo…' : 'Mensagem para o Claude'} title="Enter envia, Shift+Enter quebra a linha" onInput={(e) => setText(e.target.value)} disabled={sending} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} className="max-h-[168px] min-h-10 min-w-0 flex-1 resize-none border border-border-strong bg-background px-3 py-2 text-base outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring md:text-sm" />
            {busy ? <Button type="button" variant="destructive" icon={I.Square} onClick={stop}>Parar</Button>
              : <Button type="submit" icon={I.SendHorizontal} loading={sending} disabled={!text.trim()}>Enviar</Button>}
          </form>}
          </div>
          </div>
        </div>
      </div>
      </>}
    </section>}
  </div>;
}

HadesCore.registerPage('claude', Claude);
})();
