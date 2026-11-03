/* Página Herdr (#/herdr): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela. */
(() => {
const { useState, useEffect, useRef, useCallback, I, cn, dur, post, getJSON, Button, Dot, Card,
  CardHeader, CardContent, HoldConfirm, Switch, Input, Mono, Tip, Empty, Dialog, DialogHeader, DialogFooter, Sheet, useApp,
  Fio, LinhaDeEstado, Loading, useWide, Choice, Select, Segmented, PtyTerminal } = HadesCore;
const L = window.TermLogic;

// ================================================================== Herdr (workspaces e agentes do herdr da máquina)
// estado do agente em palavras, o ponto e o fio: trabalhando fia, esperando você é o fio frouxo, concluído é medido
const HERDR_ST = { working: ['trabalhando', 'busy', 'fiando'], blocked: ['espera por você', 'warn', 'frouxo'], idle: ['ocioso', 'ok', 'parado'],
  done: ['concluído', 'info', 'medido'], unknown: ['sem agente', 'idle', null] };
const FIRST = ['blocked', 'working'];
const HERDR_KEYS = [['Enter', 'Enter', I.CornerDownLeft], ['Esc', 'Escape', I.CircleX, true], ['Ctrl+C', 'Ctrl+C', I.OctagonX, true], ['Tab', 'Tab', I.ArrowRightToLine],
  ['Seta para cima', 'Up', I.ArrowUp, false, true], ['Seta para baixo', 'Down', I.ArrowDown, false, true], ['Seta para a esquerda', 'Left', I.ArrowLeft, false, true], ['Seta para a direita', 'Right', I.ArrowRight, false, true], ['y', 'y'], ['n', 'n']];
const herdrQ = (o) => '?' + Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const HerdrStatus = ({ st, since }) => {
  const [l, k] = HERDR_ST[st] || HERDR_ST.unknown;
  return <Tip text={since ? `${l} há ${dur(Date.now() / 1000 - since)}` : l}>
    <span className={cn('inline-flex items-center gap-1.5 t-meta whitespace-nowrap', st === 'blocked' ? 'font-medium text-foreground' : 'text-muted-foreground')}>
      <Dot kind={k} pulse={k === 'busy'} />
      {l}
    </span>
  </Tip>;
};

// painel selecionado: saída do terminal (polling enquanto aberto), processo em primeiro plano e as ações
function HerdrPane({ session, pane, w, t, onAdmin, onOpenTerm }) {
  const { toast, confirm } = useApp();
  const [x, setX] = useState(null);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const PromptBar = window.HadesFx.use('PromptBar', !!pane.agent);
  const [name, setName] = useState('');
  const box = useRef(null), stick = useRef(true);
  const load = useCallback(() => getJSON('/api/herdr/read' + herdrQ({ session, pane: pane.id, lines: 200 })).then(setX).catch(() => {}), [session, pane.id]);
  useEffect(() => { setX(null); setText(''); setName(pane.name || ''); stick.current = true; }, [session, pane.id]);
  useEffect(() => { load(); if (!auto) return; const t = setInterval(load, 3000); return () => clearInterval(t); }, [load, auto]);
  useEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [x?.text]);
  const act = async (body, ok) => {
    setBusy(true);
    try { await post('/api/herdr/act', { session, pane: pane.id, ...body }); if (ok) toast({ kind: 'ok', title: ok }); setTimeout(load, 600); return true; }
    catch (e) { toast({ kind: 'bad', title: 'O herdr não aceitou', desc: e.message }); return false; }
    finally { setBusy(false); }
  };
  const send = async (kind) => {
    const t = text; if (!t.trim()) return;
    if (await act({ action: kind, text: t }, kind === 'prompt' ? 'Prompt enviado' : 'Texto enviado')) setText('');
  };
  const key = async ([label, k, , ask]) => {
    if (ask && !(await confirm({ title: `Enviar ${label} para ${pane.name || pane.id}?`, icon: I.Keyboard, danger: true, confirmLabel: `Enviar ${label}`,
      description: `${label} vai para o terminal de ${pane.name || pane.id} e pode interromper o que ele faz.` }))) return;
    act({ action: 'keys', keys: [k] });
  };
  const fg = x?.procs?.[0];
  const folder = onOpenTerm ? onOpenTerm.folder(pane.fcwd || pane.cwd) : null;
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <div className="grid gap-1.5" data-tour-step-id="herdr-terminal">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="t-section">
          {pane.name || pane.agent || 'terminal'}
        </h2>
        {pane.agent && pane.name ? <span className="t-body text-muted-foreground">
          {pane.agent}
        </span> : null}
        {pane.hades ? <a href="#/orchestration" className="t-meta text-info hover:underline">agente do orquestrador</a> : null}
        <Mono className="text-muted-foreground">
          {pane.id}
        </Mono>
        <span className="ml-auto">
          <HerdrStatus st={pane.status} since={pane.since} />
        </span>
      </div>
      <div className="grid gap-0.5 t-meta text-muted-foreground">
        {pane.title ? <span className="truncate">
          {pane.title}
        </span> : null}
        <Tip text={pane.fcwd && pane.fcwd !== pane.cwd ? `cwd ${pane.cwd} · em primeiro plano ${pane.fcwd}` : pane.cwd}>
          <Mono className="block truncate">
            {pane.fcwd || pane.cwd}
            {pane.branch ? ` · ${pane.branch}` : ''}
          </Mono>
        </Tip>
        {fg ? <Tip text={x.procs.map((p) => `${p.cmd} (pid ${p.pid})`).join(' · ')}>
          <Mono className="block truncate">
            {"primeiro plano: "}
            {fg.cmd || fg.name}
            {" · pid "}
            {fg.pid}
            {x.procs.length > 1 ? ` (+${x.procs.length - 1})` : ''}
          </Mono>
        </Tip> : null}
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 t-meta text-muted-foreground" data-tour-step-id="herdr-saida">
      <span className="min-w-0 flex-1">Saída (200 linhas)</span>
      <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
        Automático
        <Switch checked={auto} onChange={setAuto} label="Atualizar sozinho" />
      </span>
      <Button variant="outline" size="xs" icon={I.RefreshCw} onClick={load}>Atualizar saída</Button>
    </div>
    <pre ref={box} onScroll={(e) => { const b = e.currentTarget; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40; }} className="min-h-48 flex-1 overflow-auto border bg-term p-3 t-data leading-relaxed whitespace-pre text-term-foreground scrollbar-thin">
      {x ? (x.text || '(sem saída)') : 'carregando…'}
    </pre>
    {pane.status === 'blocked' ? <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Responder ao agente" data-herdr-quick="blocked">
      <span className="t-meta font-medium">Espera por você:</span>
      {['1', '2', '3'].map((n) => <Button key={n} size="sm" variant="outline" className="min-h-11 min-w-11 font-mono" disabled={busy} onClick={() => act({ action: 'text', text: n }, `${n} enviado`)}>{n}</Button>)}
      <Button size="sm" variant="outline" className="min-h-11 min-w-11" disabled={busy} onClick={() => key(['y', 'y'])}>y</Button>
      <Button size="sm" variant="outline" className="min-h-11 min-w-11" disabled={busy} onClick={() => key(['n', 'n'])}>n</Button>
    </div> : null}
    {onOpenTerm ? <div className="flex flex-wrap gap-1.5" role="group" aria-label="Abrir no terminal">
      <Button size="sm" variant="outline" icon={I.Server} onClick={() => onOpenTerm.open({ kind: 'herdr-client', session })}>Abrir o cliente do herdr</Button>
      {folder ? <Button size="sm" variant="outline" icon={I.SquareTerminal} onClick={() => onOpenTerm.open({ kind: 'shell', cwd: folder })}>Abrir terminal na pasta</Button> : null}
    </div> : null}
    <div className="grid gap-2" data-tour-step-id="herdr-enviar">
      {PromptBar ? <PromptBar width={4000} radius={0} busy={busy} placeholder="Prompt para o agente"
        sources={[]} commands={[]} models={[]} efforts={[]}
        background="var(--card)" color="var(--foreground)" menuBackground="var(--popover)" sparkColor="var(--primary)"
        onSend={(t) => act({ action: 'prompt', text: t }, 'Prompt enviado')} /> : null}
      <textarea value={text} rows={2} placeholder={pane.agent && !PromptBar ? 'Prompt ou texto para o terminal' : 'Texto para o terminal'} onInput={(e) => setText(e.target.value)} className="min-h-14 max-h-40 min-w-0 resize-y border border-border-strong bg-background px-3 py-2 text-base outline-none focus-visible:outline-2 focus-visible:outline-ring md:text-sm" />
      <div className="flex flex-wrap items-center gap-2">
        {pane.agent && !PromptBar ? <Tip text="Manda como prompt e aperta Enter (herdr agent prompt)">
          <Button size="sm" icon={I.SendHorizontal} loading={busy} disabled={!text.trim()} onClick={() => send('prompt')}>Enviar prompt</Button>
        </Tip> : null}
        <Tip text="Digita o texto sem apertar Enter (herdr pane send-text)">
          <Button size="sm" variant="outline" icon={I.Type} loading={busy} disabled={!text.trim()} onClick={() => send('text')}>Digitar sem Enter</Button>
        </Tip>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Teclas de atalho" data-tour-step-id="herdr-teclas">
        {HERDR_KEYS.map((k) => <Button key={k[1]} size="xs" variant={k[3] ? 'ghost-destructive' : 'outline'} className={k[3] ? 'border' : ''} icon={k[2]} disabled={busy} aria-label={k[4] ? k[0] : undefined} title={k[4] ? k[0] : undefined} onClick={() => key(k)}>
          {k[4] ? null : k[0]}
        </Button>)}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Gerenciar">
        {pane.agent ? null : <Button size="xs" variant="outline" icon={I.Play} onClick={() => onAdmin(askAgentStart(pane))}>Iniciar agente</Button>}
        <Button size="xs" variant="outline" icon={I.Columns2} onClick={() => onAdmin(askPaneSplit(pane))}>Dividir</Button>
        <Button size="xs" variant="outline" icon={I.Pencil} onClick={() => onAdmin(askPaneRename(pane))}>Renomear painel</Button>
        <Button size="xs" variant="outline" icon={I.Pencil} onClick={() => onAdmin(askTabRename(t))}>Renomear aba</Button>
        <Button size="xs" variant="ghost-destructive" className="border" icon={I.X} onClick={() => onAdmin(askPaneClose(pane))}>Fechar painel</Button>
        <Button size="xs" variant="ghost-destructive" className="border" icon={I.X} onClick={() => onAdmin(askTabClose(t))}>Fechar aba</Button>
      </div>
      {pane.agent ? <form className="flex items-center gap-2" data-tour-step-id="herdr-renomear" onSubmit={(e) => { e.preventDefault(); act({ action: 'rename', name }, name ? 'Agente renomeado' : 'Nome removido'); }}>
        <Input icon={I.Pencil} value={name} placeholder="Nome do agente (vazio remove)" maxLength={40} onInput={(e) => setName(e.target.value)} aria-label="Nome do agente" />
        <Button type="submit" size="sm" variant="outline" loading={busy} disabled={name === (pane.name || '')}>Renomear</Button>
      </form> : null}
    </div>
  </div>;
}

// gerência da estrutura (POST /api/herdr/admin): cada botão abre este diálogo; fechar pede digitar o nome do alvo
const HERDR_AGENT_KINDS = ['claude', 'codex', 'gemini'];
const HERDR_SPLITS = [{ value: 'right', label: 'Para a direita' }, { value: 'down', label: 'Para baixo' }];
function HerdrAdmin({ session, ask, onClose, onDone }) {
  const { toast } = useApp();
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setF(ask ? { label: ask.label || '', cwd: '', name: '', kind: 'claude', args: '', direction: 'right', confirm: '' } : {}); }, [ask]);
  if (!ask) return <Dialog open={false} onClose={onClose} label="Gerenciar" />;
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));
  const run = async () => {
    setBusy(true);
    try {
      const body = { session, action: ask.action, ...ask.target };
      for (const k of ask.fields) body[k] = k === 'args' ? f.args.split(/\s+/).filter(Boolean) : f[k];
      if (ask.confirmName !== undefined) body.confirm = f.confirm;
      await post('/api/herdr/admin', body);
      toast({ kind: 'ok', title: ask.done });
      onClose(); onDone();
    } catch (e) { toast({ kind: 'bad', title: 'O herdr não aceitou', desc: e.message }); }
    finally { setBusy(false); }
  };
  const danger = ask.confirmName !== undefined;
  const blocked = (ask.fields.includes('label') && ask.labelRequired && !f.label?.trim()) || (ask.fields.includes('name') && !f.name) || (danger && f.confirm !== ask.confirmName);
  return <Dialog open onClose={onClose} label={ask.title}>
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (!danger && !blocked && !busy) run(); }}>
      <DialogHeader icon={ask.icon} tone={danger ? 'danger' : undefined} title={ask.title}
        description={ask.description + (danger ? `\n\nDigite ${ask.confirmName} para confirmar.` : '')} />
      {ask.fields.includes('label') ? <Input value={f.label || ''} onInput={set('label')} maxLength={64} placeholder={ask.labelRequired ? 'Nome' : 'Nome (opcional)'} aria-label="Nome" autoFocus /> : null}
      {ask.fields.includes('cwd') ? <Input value={f.cwd || ''} onInput={set('cwd')} placeholder="Pasta (opcional, dentro do home)" aria-label="Pasta" /> : null}
      {ask.fields.includes('direction') ? <Select value={f.direction || 'right'} onChange={(v) => setF((x) => ({ ...x, direction: v }))} label="Direção" items={HERDR_SPLITS} className="w-full" /> : null}
      {ask.fields.includes('name') ? <Input value={f.name || ''} onInput={set('name')} maxLength={32} placeholder="Nome do agente (minúsculas, números, _ e -)" aria-label="Nome do agente" autoFocus /> : null}
      {ask.fields.includes('kind') ? <Select value={f.kind || 'claude'} onChange={(v) => setF((x) => ({ ...x, kind: v }))} label="Agente" items={HERDR_AGENT_KINDS.map((k) => ({ value: k, label: k }))} className="w-full" /> : null}
      {ask.fields.includes('args') ? <Input value={f.args || ''} onInput={set('args')} placeholder="Argumentos do agente (separados por espaço)" aria-label="Argumentos do agente" /> : null}
      {danger ? <Input value={f.confirm || ''} onInput={set('confirm')} placeholder={ask.confirmName} aria-label="Nome do alvo" autoFocus /> : null}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        {danger ? <HoldConfirm size="default" loading={busy} disabled={busy || blocked} icon={ask.icon} onHold={run}>Segure 1,2 s: Fechar</HoldConfirm>
          : <Button type="submit" loading={busy} disabled={busy || blocked} icon={ask.icon}>{ask.confirmLabel}</Button>}
      </DialogFooter>
    </form>
  </Dialog>;
}
// pedidos de cada botão; o servidor confere o alvo no retrato atual e o nome das destrutivas
const askWorkspaceCreate = () => ({ action: 'workspace-create', icon: I.FolderPlus, title: 'Novo workspace', description: 'Abre um workspace com um terminal (herdr workspace create).', fields: ['label', 'cwd'], confirmLabel: 'Criar', done: 'Workspace criado', target: {} });
const askWorkspaceTab = (w) => ({ action: 'tab-create', icon: I.Plus, title: `Nova aba em ${w.label || w.id}`, description: 'Abre uma aba com um terminal (herdr tab create).', fields: ['label'], confirmLabel: 'Criar', done: 'Aba criada', target: { workspace: w.id } });
const askWorkspaceRename = (w) => ({ action: 'workspace-rename', icon: I.Pencil, title: 'Renomear workspace', description: w.label || w.id, fields: ['label'], label: w.label, labelRequired: true, confirmLabel: 'Renomear', done: 'Workspace renomeado', target: { workspace: w.id } });
const askWorkspaceClose = (w) => ({ action: 'workspace-close', icon: I.Trash2, title: `Fechar o workspace ${w.label || w.id}?`, description: 'Fecha o workspace com todas as abas, terminais e agentes dele.', fields: [], confirmName: w.label || w.id, done: 'Workspace fechado', target: { workspace: w.id } });
const askTabRename = (t) => ({ action: 'tab-rename', icon: I.Pencil, title: 'Renomear aba', description: t.label || t.id, fields: ['label'], label: t.label, labelRequired: true, confirmLabel: 'Renomear', done: 'Aba renomeada', target: { tab: t.id } });
const askTabClose = (t) => ({ action: 'tab-close', icon: I.Trash2, title: `Fechar a aba ${t.label || t.id}?`, description: 'Fecha a aba com todos os terminais e agentes dela.', fields: [], confirmName: t.label || t.id, done: 'Aba fechada', target: { tab: t.id } });
const askPaneSplit = (p) => ({ action: 'pane-split', icon: I.Columns2, title: 'Dividir painel', description: `Abre um terminal novo ao lado de ${p.id}.`, fields: ['direction'], confirmLabel: 'Dividir', done: 'Painel dividido', target: { pane: p.id } });
const askPaneRename = (p) => ({ action: 'pane-rename', icon: I.Pencil, title: 'Renomear painel', description: p.id, fields: ['label'], labelRequired: true, confirmLabel: 'Renomear', done: 'Painel renomeado', target: { pane: p.id } });
const askPaneClose = (p) => ({ action: 'pane-close', icon: I.Trash2, title: `Fechar o painel ${p.name || p.id}?`, description: p.agent ? 'O agente deste painel termina junto.' : 'Fecha o terminal deste painel.', fields: [], confirmName: p.name || p.id, done: 'Painel fechado', target: { pane: p.id } });
const askAgentStart = (p) => ({ action: 'agent-start', icon: I.Play, title: 'Iniciar agente', description: `Sobe o agente em ${p.id}; o terminal precisa estar no prompt do shell (herdr agent start).`, fields: ['name', 'kind', 'args'], confirmLabel: 'Iniciar', done: 'Agente iniciado', target: { pane: p.id } });

// parar/apagar sessão do herdr: digitar o nome confirma (e mostra quantos agentes estão trabalhando)
function HerdrSessions({ open, onClose, sessions, onDone }) {
  const { toast } = useApp();
  const [ask, setAsk] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTyped(''); }, [ask]);
  const run = async () => {
    setBusy(true);
    try { await post('/api/herdr/session', { action: ask.what, name: ask.s.name, confirm: typed }); toast({ kind: 'ok', title: ask.what === 'stop' ? 'Sessão parada' : 'Sessão apagada', desc: ask.s.name }); setAsk(null); onDone(); }
    catch (e) { toast({ kind: 'bad', title: 'Não foi possível', desc: e.message }); }
    finally { setBusy(false); }
  };
  const s = ask?.s;
  return <Sheet open={open} onClose={onClose} icon={I.Server} title="Sessões do herdr" description="Cada sessão é um servidor herdr com seus workspaces; parar encerra todos os terminais dela (herdr session list).">
    <div className="grid gap-2 p-4">
      {sessions.map((x) => <Card key={x.name} variant="object" className="gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Dot kind={x.running ? 'ok' : 'idle'} />
          <span className="font-medium">
            {x.name}
          </span>
          {x.default ? <span className="t-meta text-muted-foreground">padrão</span> : null}
          {x.own ? <span className="t-meta text-warn">onde o painel roda</span> : null}
          <span className="ml-auto t-meta text-muted-foreground">
            {x.running ? `${x.agents} agente${x.agents === 1 ? '' : 's'} · ${x.working} trabalhando` : 'parada'}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {x.running ? <Button size="xs" variant="ghost-destructive" className="border" icon={I.Power} onClick={() => setAsk({ what: 'stop', s: x })}>Parar</Button>
          : <Button size="xs" variant="ghost-destructive" className="border" icon={I.Trash2} onClick={() => setAsk({ what: 'delete', s: x })}>Apagar</Button>}
        </div>
      </Card>)}
    </div>
    <Dialog open={!!ask} onClose={() => setAsk(null)} label="Confirmar">
      {ask ? <>
        <DialogHeader icon={ask.what === 'stop' ? I.Power : I.Trash2} tone="danger" title={ask.what === 'stop' ? `Parar a sessão ${s.name}?` : `Apagar a sessão ${s.name}?`} description={(ask.what === 'stop' ? `Encerra o servidor e os terminais da sessão (${s.agents} agente${s.agents === 1 ? '' : 's'}, ${s.working} trabalhando).`
          : 'Remove a sessão parada e o que o herdr guardou.')
          + (s.default && ask.what === 'stop' ? '\n\nSessão padrão: a Orquestração e os agentes do loop rodam nela.' : '')
          + (s.own && ask.what === 'stop' ? '\n\nO painel ou o orquestrador roda nesta sessão: parar derruba os dois.' : '')
          + `\n\nDigite ${s.name} para confirmar.`} />
        <Input value={typed} onInput={(e) => setTyped(e.target.value)} placeholder={s.name} aria-label="Nome da sessão" autoFocus />
        <DialogFooter>
          <Button variant="outline" onClick={() => setAsk(null)}>Cancelar</Button>
          <HoldConfirm size="default" loading={busy} disabled={busy || typed !== s.name} icon={ask.what === 'stop' ? I.Power : I.Trash2} onHold={run}>
            {ask.what === 'stop' ? 'Segure 1,2 s: Parar' : 'Segure 1,2 s: Apagar'}
          </HoldConfirm>
        </DialogFooter>
      </> : null}
    </Dialog>
  </Sheet>;
}

// gerência do herdr da máquina: árvore de workspaces, painel escolhido (saída por polling, prompt, teclas) e as ações do herdr
function HerdrManage({ onOpenClient, onOpenTerm, mobile }) {
  const [x, setX] = useState(null);
  const nav = HadesCore.Mobile.useMobileLevel();
  const hq = () => new URLSearchParams(location.hash.split('?')[1] || '');
  const [session, setSession] = useState(() => hq().get('session'));
  const [selId, setSelId] = useState(() => hq().get('pane'));
  const [q, setQ] = useState('');
  // #/herdr?state=blocked abre já filtrado (a Visão geral manda para cá quem espera por você)
  const [state, setState] = useState(() => (['blocked', 'working', 'idle', 'unknown'].includes(hq().get('state')) ? hq().get('state') : 'all'));
  const [sheet, setSheet] = useState(() => !!hq().get('pane'));
  const [sess, setSess] = useState(() => hq().get('sessions') === '1');
  const [admin, setAdmin] = useState(null);
  const wide = useWide(1024);
  const load = useCallback(() => getJSON('/api/herdr' + herdrQ({ session })).then(setX).catch(() => {}), [session]);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (x && !session) setSession(x.session); }, [x, session]);
  // link direto (#/herdr?pane=…, vindo de um agente esperando) abre o painel dele em tela cheia no celular
  useEffect(() => { if (mobile && hq().get('pane')) nav.enter(); }, []);
  if (!x) return <Loading />;
  const sv = x.sessions.find((s) => s.name === x.session);
  const head = <div className="flex flex-wrap items-center gap-2" data-tour-step-id="herdr-sessoes">
    {x.sessions.length > 1 ? <Choice wide={wide} label="Sessão" value={x.session} onChange={(v) => { setSession(v); setSelId(null); }} items={x.sessions.map((s) => ({ value: s.name, label: s.name }))} /> : null}
    <Button variant="outline" size="sm" icon={I.Server} onClick={() => setSess(true)}>
      Sessões (
      {x.sessions.length}
      )
    </Button>
    <Button variant="outline" size="sm" icon={I.FolderPlus} onClick={() => setAdmin(askWorkspaceCreate())}>Novo workspace</Button>
    {onOpenClient && x.session ? <Button variant="outline" size="sm" icon={I.SquareTerminal} onClick={() => onOpenClient(x.session)}>Abrir cliente no terminal</Button> : null}
  </div>;
  if (!x.available || x.reason) return <div className="grid gap-4">
    {x.available ? head : null}
    <div data-tour-step-id="herdr-fora">
    <Empty icon={I.Server} title={x.available ? 'Servidor herdr fora do ar' : 'herdr não encontrado'}>
      {x.available ? <>
        {"O herdr da sessão "}
        {x.session || '—'}
        {" não responde. Abra o herdr ("}
        <code>herdr</code>
        ) no terminal; a página volta sozinha.
      </>
        : <>
          {"O binário "}
          <code>herdr</code>
          {" não está no PATH do painel. Instale e recarregue."}
        </>}
    </Empty>
    </div>
    <HerdrSessions open={sess} onClose={() => setSess(false)} sessions={x.sessions} onDone={load} />
  </div>;
  const all = x.tree.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => ({ w, t, p }))));
  const needle = q.trim().toLowerCase();
  const match = ({ w, t, p }) => (state === 'all' || p.status === state)
    && (!needle || [w.label, t.label, p.id, p.name, p.agent, p.title, p.cwd, p.fcwd, p.branch].some((v) => v && String(v).toLowerCase().includes(needle)));
  const shown = all.filter(match);
  const cnt = (s) => all.filter(({ p }) => p.status === s).length;
  const agents = all.filter(({ p }) => p.agent);
  // na mesa, sem escolha na URL, abre já quem espera por você, senão quem trabalha
  const first = wide ? FIRST.map((s) => agents.find(({ p }) => p.status === s)).find(Boolean) : null;
  const selEntry = all.find(({ p }) => p.id === selId) || first;
  const sel = selEntry?.p;
  const pick = (id) => { setSelId(id); if (mobile) nav.enter(); else if (!wide) setSheet(true); };
  const rowCls = (on) => cn('group grid w-full gap-1.5 border-b border-l-2 border-l-transparent px-3 py-2.5 text-left t-body transition-colors cursor-pointer hover:bg-accent/60 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring', on && 'border-l-foreground bg-accent/40');
  const tree = x.tree.map((w) => {
    const mine = shown.filter((e) => e.w === w);
    if (!mine.length) return null;
    const withAgent = mine.filter(({ p }) => p.agent), bare = mine.filter(({ p }) => !p.agent);
    return <section key={w.id} className="grid" aria-label={`Workspace ${w.label}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b pb-2 t-body">
        <span className="t-data text-muted-foreground">
          {w.number}
        </span>
        <span className="font-medium">
          {w.label}
        </span>
        {w.worktree ? <Tip text={w.worktree.path}>
          <span className="inline-flex items-center gap-1 t-meta text-muted-foreground">
            <I.GitBranch className="size-3" aria-hidden="true" />
            {w.worktree.repo + (w.worktree.linked ? ' (worktree)' : '')}
          </span>
        </Tip> : null}
        {w.focused ? <span className="t-meta text-muted-foreground">· foco</span> : null}
        <span className="ml-auto flex gap-1" role="group" aria-label={`Gerenciar ${w.label}`}>
          <Button size="xs" variant="ghost" icon={I.Plus} aria-label="Nova aba" title="Nova aba" onClick={() => setAdmin(askWorkspaceTab(w))} />
          <Button size="xs" variant="ghost" icon={I.Pencil} aria-label="Renomear workspace" title="Renomear workspace" onClick={() => setAdmin(askWorkspaceRename(w))} />
          <Button size="xs" variant="ghost-destructive" icon={I.Trash2} aria-label="Fechar workspace" title="Fechar workspace" onClick={() => setAdmin(askWorkspaceClose(w))} />
        </span>
      </div>
      {withAgent.map(({ t, p }) => { const fio = (HERDR_ST[p.status] || HERDR_ST.unknown)[2]; return <button type="button" key={p.id} onClick={() => pick(p.id)} aria-pressed={sel?.id === p.id} className={rowCls(sel?.id === p.id)}>
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate font-medium">
            {p.name || p.agent}
          </span>
          {p.name ? <span className="shrink-0 t-meta text-muted-foreground">
            {p.agent}
          </span> : null}
          {p.hades ? <span className="shrink-0 t-meta text-info">Hades</span> : null}
          <span className="ml-auto shrink-0">
            <HerdrStatus st={p.status} since={p.since} />
          </span>
        </span>
        {fio ? <Fio s={fio} nos={fio === 'medido' ? [0, 100] : []} label={`${p.name || p.agent}: ${HERDR_ST[p.status][0]}`} /> : null}
        {p.title ? <span className="truncate t-meta text-muted-foreground">
          {p.title}
        </span> : null}
        <Mono className="truncate text-muted-foreground">
          {[p.fcwd || p.cwd, p.branch, `aba ${t.number}`, p.id].filter(Boolean).join(' · ')}
        </Mono>
      </button>; })}
      {bare.length ? <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b px-3 py-2 t-meta text-muted-foreground">
        <span className="mr-1">
          {bare.length === 1 ? 'terminal sem agente' : `${bare.length} terminais sem agente`}
        </span>
        {bare.map(({ p }) => <button type="button" key={p.id} onClick={() => pick(p.id)} aria-pressed={sel?.id === p.id} title={[p.title, p.fcwd || p.cwd].filter(Boolean).join(' · ')}
          className={cn('px-1.5 py-0.5 font-mono transition-colors cursor-pointer hover:bg-accent hover:text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring', sel?.id === p.id && 'bg-accent text-foreground')}>
          {p.title ? `${p.id} ${p.title}` : p.id}
        </button>)}
      </div> : null}
    </section>;
  }).filter(Boolean);
  const detail = sel ? <HerdrPane session={x.session} pane={sel} w={selEntry.w} t={selEntry.t} onAdmin={setAdmin} onOpenTerm={onOpenTerm} /> : <Empty icon={I.SquareTerminal} title="Escolha um terminal">
    Saída, processo e ações aparecem aqui.
  </Empty>;
  const blocked = cnt('blocked'), working = cnt('working');
  return <div className="grid gap-6">
    <div data-tour-step-id="herdr-estado">
    <LinhaDeEstado main={blocked ? `${blocked} espera${blocked > 1 ? 'm' : ''} por você` : working ? `${working} trabalhando` : 'nenhum agente trabalhando'}
      rest={[blocked && working ? `${working} trabalhando` : null, `${agents.length} agente${agents.length === 1 ? '' : 's'} em ${x.tree.length} workspace${x.tree.length === 1 ? '' : 's'}`,
        `${all.length - agents.length} terminais sem agente`, `sessão do herdr ${x.session}`]} />
    </div>
    <div className="flex flex-wrap items-center gap-2" data-tour-step-id="herdr-filtros">
      {head}
      <Input icon={I.Search} className="min-w-48 max-w-xs" value={q} onInput={(e) => setQ(e.target.value)} placeholder="Filtrar por nome, caminho, branch…" aria-label="Filtrar" />
      <Choice wide={wide} label="Estado" value={state} onChange={setState} items={[{ value: 'all', label: 'Todos' }, { value: 'blocked', label: 'Esperando você', count: blocked },
        { value: 'working', label: 'Trabalhando', count: working }, { value: 'idle', label: 'Ocioso' }, { value: 'unknown', label: 'Sem agente' }]} />
    </div>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <Card className="gap-0" data-tour-step-id="herdr-workspaces">
        <CardHeader title="Workspaces" summary="atualiza a cada 4 s" />
        <CardContent className="grid min-h-40 content-start gap-5 pt-4 scrollbar-thin lg:max-h-[calc(100dvh-20rem)] lg:overflow-y-auto">
          {tree.length ? tree : <Empty icon={I.SearchX} title="Nada com esse filtro" />}
        </CardContent>
      </Card>
      {wide ? <Card variant="object" data-tour-step-id="herdr-detalhe" className="sticky top-[4.5rem] h-[calc(100dvh-6rem)] min-h-[480px] overflow-y-auto scrollbar-thin">
        {detail}
      </Card> : null}
    </div>
    {mobile && nav.level === 'detail' && sel ? <HadesCore.Mobile.MobileTermScreen title={sel.name || sel.agent || 'terminal'} subtitle={sel.id} onBack={nav.leave}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background p-3 text-foreground scrollbar-thin" data-herdr-mobile="detail">
        {detail}
      </div>
    </HadesCore.Mobile.MobileTermScreen> : null}
    {wide || mobile ? null : <Sheet open={sheet && !!sel} onClose={() => setSheet(false)} wide icon={I.SquareTerminal} title={sel ? (sel.name || sel.agent || 'terminal') : ''} description={sel ? sel.id : ''}>
      <div className="flex h-full min-h-0 flex-col p-4">
        {detail}
      </div>
    </Sheet>}
    <HerdrSessions open={sess} onClose={() => setSess(false)} sessions={x.sessions} onDone={load} />
    <HerdrAdmin session={x.session} ask={admin} onClose={() => setAdmin(null)} onDone={load} />
  </div>;
}

// ================================================================== Terminais (xterm.js sobre /api/term; contrato em reference/panel.md §Terminal)
const TERM_STORE = 'hades-herdr-term';
const TERM_POLL_MS = 4000;
const TERM_KINDS = [
  { value: 'shell', label: 'Shell', icon: I.SquareTerminal },
  { value: 'claude', label: 'Claude Code', icon: I.Bot },
  { value: 'herdr-client', label: 'Cliente do herdr', icon: I.Server },
];
const kindOf = (k) => TERM_KINDS.find((x) => x.value === k) || TERM_KINDS[0];
const baseName = (p) => String(p || '').split('/').filter(Boolean).pop() || p || '';
const isDraft = (id) => id.startsWith('draft:');

// pedido de nova sessão: tipo, pasta entre as roots do servidor e os extras de cada tipo
function TermNew({ open, onClose, info, onCreate, session }) {
  const [kind, setKind] = useState('shell');
  const [cwd, setCwd] = useState('');
  const [resume, setResume] = useState('');
  const [hs, setHs] = useState('default');
  useEffect(() => { if (open) { setCwd((c) => (info.roots.includes(c) ? c : info.roots[0] || '')); if (session) { setKind('herdr-client'); setHs(session); } } }, [open, info.roots, session]);
  const badResume = kind === 'claude' && resume.trim() !== '' && !L.RESUME_RE.test(resume.trim());
  const submit = (e) => {
    e.preventDefault();
    if (badResume) return;
    onCreate({ kind, ...(cwd ? { cwd } : {}), ...(kind === 'claude' && resume.trim() ? { resume: resume.trim() } : {}), ...(kind === 'herdr-client' ? { session: hs.trim() || 'default' } : {}) });
    onClose();
  };
  return <Dialog open={open} onClose={onClose} label="Novo terminal">
    <form className="grid gap-4" onSubmit={submit}>
      <DialogHeader icon={I.SquareTerminal} title="Novo terminal" description="Abre uma sessão no PTY do painel. Ela continua rodando se você sair da página." />
      <Select value={kind} onChange={setKind} label="Tipo" items={TERM_KINDS.map((k) => ({ value: k.value, label: k.label }))} className="w-full" />
      <Select value={cwd} onChange={setCwd} label="Pasta" items={info.roots.map((r) => ({ value: r, label: r }))} className="w-full" placeholder="Pasta" />
      {kind === 'claude' ? <Input value={resume} onInput={(e) => setResume(e.target.value)} maxLength={64} placeholder="Retomar sessão (id, opcional)" aria-label="Id da sessão do Claude para retomar" aria-invalid={badResume || undefined} /> : null}
      {kind === 'herdr-client' ? <Input value={hs} onInput={(e) => setHs(e.target.value)} maxLength={64} placeholder="Sessão do herdr" aria-label="Sessão do herdr" /> : null}
      {badResume ? <p className="t-meta text-destructive" role="alert">O id só leva letras, números, _ e -, até 64.</p> : null}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button type="submit" icon={I.Plus} disabled={badResume}>Abrir</Button>
      </DialogFooter>
    </form>
  </Dialog>;
}

// sessões vivas do servidor, inclusive as abertas em outra tela
function TermSessions({ open, onClose, info, mesa, onAttach, onKill }) {
  return <Sheet open={open} onClose={onClose} icon={I.Server} title="Sessões de terminal" description={`${info.active} viva${info.active === 1 ? '' : 's'} de no máximo ${info.max}. Sair da página não encerra a sessão.`}>
    <div className="grid gap-2 p-4">
      {info.sessions.length ? info.sessions.map((s) => {
        const k = kindOf(s.kind), here = mesa.includes(s.id);
        return <Card key={s.id} variant="object" className="gap-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Dot kind={s.state === 'running' ? 'ok' : 'idle'} />
            <span className="font-medium">{k.label}</span>
            <span className="t-meta text-muted-foreground">{s.state === 'running' ? 'rodando' : 'encerrada'}</span>
            <span className="ml-auto t-meta text-muted-foreground">{here ? 'nesta tela' : s.attached ? 'em outra tela' : 'sem tela'} · {s.origin === 'remote' ? 'acesso remoto' : 'local'}</span>
          </div>
          <Mono className="truncate text-muted-foreground">{s.cwd}</Mono>
          <div className="flex flex-wrap gap-2">
            <Tip text={s.attached && !here ? 'A outra tela perde a sessão (ela pode trazê-la de volta)' : 'Mostra a sessão na mesa'}>
              <Button size="xs" variant="outline" icon={I.MonitorDown} onClick={() => { onAttach(s.id); onClose(); }}>{here ? 'Mostrar' : 'Anexar aqui'}</Button>
            </Tip>
            <Button size="xs" variant="ghost-destructive" className="border" icon={I.X} onClick={() => onKill(s)}>Fechar sessão</Button>
          </div>
        </Card>;
      }) : <Empty icon={I.SquareTerminal} title="Nenhuma sessão viva" />}
    </div>
  </Sheet>;
}

function TermDesk({ info, reload, intent, onIntent, wide, mobile, autoEnter }) {
  const { confirm, toast } = useApp();
  const nav = HadesCore.Mobile.useMobileLevel();
  const api = useRef({ filter: null });
  const [lay, setLay] = useState(() => { try { return L.layoutParse(sessionStorage.getItem(TERM_STORE)); } catch (e) { return L.layoutEmpty(); } });
  const [newOpen, setNewOpen] = useState(false);
  const [list, setList] = useState(false);
  const [hsession, setHsession] = useState(null);
  // tab -> {key, spec}: sessão que esta tela abriu continua montada pelo mesmo componente (mesma key) depois de ganhar o id real
  const owned = useRef(new Map()), unconfirmed = useRef(new Set()), seq = useRef(0);
  useEffect(() => { try { sessionStorage.setItem(TERM_STORE, JSON.stringify(lay)); } catch (e) { /* aba privada: a mesa só não sobrevive ao recarregar */ } }, [lay]);
  // some da mesa o que o servidor não lista mais; rascunho e sessão recém-aberta (ainda fora da lista) ficam
  useEffect(() => {
    const ids = info.sessions.map((s) => s.id);
    for (const id of ids) unconfirmed.current.delete(id);
    setLay((l) => { const n = L.layoutPrune(l, ids, (id) => isDraft(id) || unconfirmed.current.has(id)); return n.tabs.length === l.tabs.length ? l : n; });
  }, [info.sessions]);
  const create = useCallback((spec) => {
    const id = `draft:${++seq.current}`;
    owned.current.set(id, { key: id, spec });
    setLay((l) => L.layoutAdd(l, id));
    if (mobile) nav.enter();
  }, [mobile, nav.enter]);
  // veio de um agente esperando (Abrir terminal / cliente do herdr no painel dele): já abre a sessão em tela cheia
  useEffect(() => { if (mobile && autoEnter && lay.active) nav.enter(); }, []);
  // a sessão do detalhe saiu da mesa (fechada, solta): volta à lista
  useEffect(() => { if (mobile && nav.level === 'detail' && !lay.active) nav.leave(); }, [mobile, nav.level, lay.active]);
  useEffect(() => { if (intent) { setHsession(intent.session); setNewOpen(true); onIntent(null); } }, [intent, onIntent]);
  const opened = (draftId) => (s) => {
    owned.current.set(s.id, owned.current.get(draftId)); owned.current.delete(draftId); unconfirmed.current.add(s.id);
    setLay((l) => L.layoutReplace(l, draftId, s.id));
    reload();
  };
  const drop = (id) => { owned.current.delete(id); setLay((l) => L.layoutRemove(l, id)); };
  const kill = async (s) => {
    const k = kindOf(s.kind);
    if (!(await confirm({ title: `Fechar o terminal ${k.label}?`, icon: I.X, danger: true, confirmLabel: 'Fechar sessão',
      description: `Encerra o processo de ${s.cwd} e tudo que roda nele.` }))) return;
    try { await post('/api/term/close', { id: s.id }); drop(s.id); reload(); }
    catch (e) { toast({ kind: 'bad', title: 'Não foi possível fechar', desc: e.message }); }
  };
  const byId = (id) => info.sessions.find((s) => s.id === id);
  const label = (id) => { const s = byId(id); if (isDraft(id)) return `Novo · ${kindOf(owned.current.get(id)?.spec.kind).label}`; return s ? `${kindOf(s.kind).label} · ${baseName(s.cwd)}` : id.slice(0, 8); };
  const cell = (id, isSplit) => {
    const s = byId(id), own = owned.current.get(id);
    return <div key={own?.key ?? id} className="flex min-h-0 min-w-0 flex-col border" data-term-cell={id}>
      <div className="flex min-h-11 items-center gap-2 border-b px-3 py-1.5 t-meta text-muted-foreground">
        <Dot kind={s && s.state === 'running' ? 'ok' : 'idle'} />
        {isSplit ? <Select size="sm" value={id} onChange={(v) => setLay((l) => L.layoutSplit(l, v))} label="Sessão deste lado" className="min-w-0 max-w-64"
          items={lay.tabs.filter((t) => t === id || t !== lay.active).map((t) => ({ value: t, label: label(t) }))} />
          : <span className="min-w-0 flex-1 truncate font-medium text-foreground">{label(id)}</span>}
        <Mono className="hidden min-w-0 flex-1 truncate sm:block">{s?.cwd || own?.spec.cwd || ''}</Mono>
        {isSplit ? <Button size="xs" variant="ghost" icon={I.PanelRightClose} aria-label="Fechar o lado a lado" title="Fechar o lado a lado" onClick={() => setLay((l) => L.layoutSplit(l, null))} /> : null}
        <Button size="xs" variant="ghost" icon={I.Unplug} aria-label="Soltar da mesa (a sessão continua)" title="Soltar da mesa (a sessão continua rodando)" onClick={() => (isDraft(id) ? drop(id) : setLay((l) => L.layoutRemove(l, id)))} />
        <Button size="xs" variant="ghost-destructive" icon={I.X} aria-label="Fechar a sessão" title="Fechar a sessão" onClick={() => (s ? kill(s) : drop(id))} />
      </div>
      <PtyTerminal key={own?.key ?? id} id={own ? undefined : id} open={own?.spec} className="min-h-0 flex-1" onOpened={opened(id)} onExit={reload} />
    </div>;
  };
  const other = lay.tabs.find((t) => t !== lay.active);
  const dialogs = <>
    <TermNew open={newOpen} onClose={() => setNewOpen(false)} info={info} session={hsession} onCreate={create} />
    <TermSessions open={list} onClose={() => setList(false)} info={info} mesa={lay.tabs} onKill={kill} onAttach={(id) => { setLay((l) => L.layoutAdd(l, id)); if (mobile) nav.enter(); }} />
  </>;
  // celular: a lista de terminais abertos; tocar em um abre o terminal em tela cheia (voltar do sistema volta à lista)
  if (mobile) {
    const id = lay.active, s = id ? byId(id) : null, own = id ? owned.current.get(id) : null;
    return <div className="grid gap-3" data-herdr-mobile={nav.level}>
      <div className="flex flex-wrap items-center gap-2" data-tour-step-id="herdr-abas">
        <Button size="sm" icon={I.Plus} onClick={() => { setHsession(null); setNewOpen(true); }}>Novo terminal</Button>
        <span data-tour-step-id="herdr-vivas"><Button size="sm" variant="outline" icon={I.Server} onClick={() => setList(true)}>{`Sessões (${info.sessions.length})`}</Button></span>
      </div>
      {lay.tabs.length ? <ul className="grid gap-2" aria-label="Terminais abertos" data-tour-step-id="herdr-mesa">
        {lay.tabs.map((t) => { const ts = byId(t); return <li key={t}>
          <button type="button" onClick={() => { setLay((l) => L.layoutSelect(l, t)); nav.enter(); }} className="grid min-h-11 w-full gap-0.5 border px-3 py-2 text-left outline-none hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring">
            <span className="flex items-center gap-2 font-medium"><Dot kind={ts && ts.state === 'running' ? 'ok' : 'idle'} />{label(t)}</span>
            <Mono className="truncate text-muted-foreground">{ts?.cwd || owned.current.get(t)?.spec.cwd || ''}</Mono>
          </button>
        </li>; })}
      </ul> : <Empty icon={I.SquareTerminal} title="Nenhum terminal aberto">
        Abra um shell, o Claude Code ou o cliente do herdr, ou anexe uma sessão que já roda em &quot;Sessões&quot;.
      </Empty>}
      {nav.level === 'detail' && id ? <HadesCore.Mobile.MobileTermScreen key={own?.key ?? id} title={label(id)} subtitle={s?.cwd || own?.spec.cwd || ''} onBack={nav.leave} apiRef={api}
        attention={(s?.kind || own?.spec.kind) === 'claude'}
        actions={<>
          <Button size="icon" variant="ghost" icon={I.Unplug} aria-label="Soltar da lista (a sessão continua)" onClick={() => (isDraft(id) ? drop(id) : setLay((l) => L.layoutRemove(l, id)))} />
          <Button size="icon" variant="ghost-destructive" icon={I.X} aria-label="Fechar a sessão" onClick={() => (s ? kill(s) : drop(id))} />
        </>}>
        <PtyTerminal key={own?.key ?? id} id={own ? undefined : id} open={own?.spec} apiRef={api} className="min-h-0 flex-1" onOpened={opened(id)} onExit={reload} />
      </HadesCore.Mobile.MobileTermScreen> : null}
      {dialogs}
    </div>;
  }
  return <div className="grid gap-3">
    <div className="flex flex-wrap items-center gap-2" data-tour-step-id="herdr-abas">
      <div role="tablist" aria-label="Terminais abertos" className="flex min-w-0 basis-full gap-1 overflow-x-auto scrollbar-thin sm:flex-1 sm:basis-0">
        {lay.tabs.map((id) => <button type="button" role="tab" key={id} aria-selected={lay.active === id || lay.split === id} onClick={() => setLay((l) => L.layoutSelect(l, id))}
          className={cn('shrink-0 whitespace-nowrap border px-3 py-1.5 t-body transition-colors cursor-pointer outline-none hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring',
            lay.active === id ? 'bg-accent font-medium text-foreground' : lay.split === id ? 'bg-accent/40 text-foreground' : 'text-muted-foreground')}>
          {label(id)}
        </button>)}
      </div>
      <Button size="sm" icon={I.Plus} onClick={() => { setHsession(null); setNewOpen(true); }}>Novo terminal</Button>
      {wide && lay.tabs.length > 1 ? <Button size="sm" variant="outline" icon={I.Columns2} aria-pressed={!!lay.split}
        onClick={() => setLay((l) => L.layoutSplit(l, l.split ? null : (other ?? null)))}>{lay.split ? 'Desfazer lado a lado' : 'Lado a lado'}</Button> : null}
      <span data-tour-step-id="herdr-vivas"><Button size="sm" variant="outline" icon={I.Server} onClick={() => setList(true)}>{`Sessões (${info.sessions.length})`}</Button></span>
    </div>
    <div data-tour-step-id="herdr-mesa" className={cn('grid h-[calc(100dvh-16rem)] min-h-[22rem] gap-3', wide && lay.split ? 'lg:grid-cols-2' : '')}>
      {lay.active ? <>
        {cell(lay.active, false)}
        {wide && lay.split ? cell(lay.split, true) : null}
      </> : <Empty icon={I.SquareTerminal} title="Nenhum terminal na mesa">
        Abra um shell, o Claude Code ou o cliente do herdr, ou anexe uma sessão que já roda em &quot;Sessões&quot;.
        <span className="mt-3 flex flex-wrap justify-center gap-2">
          <Button size="sm" icon={I.Plus} onClick={() => create({ kind: 'shell', ...(info.roots[0] ? { cwd: info.roots[0] } : {}) })}>Abrir um shell</Button>
        </span>
      </Empty>}
    </div>
    {dialogs}
  </div>;
}

function Herdr() {
  const { toast } = useApp();
  const [info, setInfo] = useState(null);
  const [view, setView] = useState(() => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); return ['pane', 'state', 'session', 'sessions'].some((k) => q.get(k)) ? 'herdr' : null; });
  const [intent, setIntent] = useState(null);
  const wide = useWide(1024);
  const mobile = HadesCore.Mobile.useIsMobile();
  const [direct, setDirect] = useState(false);
  const load = useCallback(() => getJSON('/api/term').then((d) => setInfo(d && d.enabled === true && Array.isArray(d.sessions) ? d : { enabled: false, roots: [], sessions: [], active: 0, max: 0 }))
    .catch(() => setInfo((i) => i || { enabled: false, roots: [], sessions: [], active: 0, max: 0 })), []);
  useEffect(() => { load(); const t = setInterval(load, TERM_POLL_MS); return () => clearInterval(t); }, [load]);
  if (!info) return <Loading />;
  const on = info.enabled === true;
  const shown = on ? (view || 'term') : 'herdr';
  const openClient = on ? (session) => { setIntent({ session }); setView('term'); } : null;
  // do painel de um agente: abre a sessão já (sem diálogo) e leva ao terminal em tela cheia
  const openTerm = on ? { folder: (cwd) => HadesCore.TermOpen.folderFor(cwd, info),
    open: async (spec) => { const r = await HadesCore.TermOpen.openTerminalAt(spec); if (r.ok) { setDirect(true); setView('term'); load(); } else toast({ kind: r.refusal.kind === 'disabled' ? 'info' : 'warn', title: r.refusal.title, desc: r.refusal.hint }); } } : null;
  return <div className="grid gap-4 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11 max-md:[&_a]:inline-flex max-md:[&_a]:min-h-11 max-md:[&_a]:items-center">
    {on ? <div className="flex flex-wrap items-center gap-3">
      <Segmented value={shown} onChange={setView} label="Visão" items={[{ value: 'term', label: 'Terminais' }, { value: 'herdr', label: 'Workspaces do herdr' }]} />
      {shown === 'term' ? <span className="t-meta text-muted-foreground">{`${info.active} de ${info.max} sessões · cada sessão tem uma tela por vez`}</span> : null}
    </div> : <div data-tour-step-id="herdr-aviso" className="flex flex-wrap items-center gap-x-3 gap-y-1 border bg-card px-4 py-3 t-body" role="note">
      <I.SquareTerminal className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 basis-56">
        <strong className="font-medium">Terminal no navegador desligado.</strong>
        {' Ligue HADES_TERMINAL em Configurações → Terminal, no painel aberto nesta máquina (a chave não muda pelo acesso remoto). Ligado, quem tem a chave de acesso abre um shell aqui.'}
      </span>
      <a href="#/config" className="t-meta text-info hover:underline">Abrir Configurações</a>
    </div>}
    {shown === 'term' ? <TermDesk info={info} reload={load} intent={intent} onIntent={setIntent} wide={wide} mobile={mobile} autoEnter={direct} /> : <HerdrManage onOpenClient={openClient} onOpenTerm={openTerm} mobile={mobile} />}
  </div>;
}

HadesCore.registerPage('herdr', Herdr);
})();
