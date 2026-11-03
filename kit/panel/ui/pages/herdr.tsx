/* Página Herdr (#/herdr): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela. */
(() => {
const { useState, useEffect, useRef, useCallback, I, cn, dur, post, getJSON, Button, Dot, Card,
  CardHeader, CardContent, HoldConfirm, Switch, Input, Mono, Tip, Empty, Dialog, DialogHeader, DialogFooter, Sheet, useApp,
  Fio, LinhaDeEstado, Loading, useWide, Choice } = HadesCore;

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
function HerdrPane({ session, pane, onDone }) {
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
      {pane.agent ? <form className="flex items-center gap-2" data-tour-step-id="herdr-renomear" onSubmit={(e) => { e.preventDefault(); act({ action: 'rename', name }, name ? 'Agente renomeado' : 'Nome removido'); }}>
        <Input icon={I.Pencil} value={name} placeholder="Nome do agente (vazio remove)" maxLength={40} onInput={(e) => setName(e.target.value)} aria-label="Nome do agente" />
        <Button type="submit" size="sm" variant="outline" loading={busy} disabled={name === (pane.name || '')}>Renomear</Button>
      </form> : null}
    </div>
  </div>;
}

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

function Herdr() {
  const [x, setX] = useState(null);
  const hq = () => new URLSearchParams(location.hash.split('?')[1] || '');
  const [session, setSession] = useState(() => hq().get('session'));
  const [selId, setSelId] = useState(() => hq().get('pane'));
  const [q, setQ] = useState('');
  // #/herdr?state=blocked abre já filtrado (a Visão geral manda para cá quem espera por você)
  const [state, setState] = useState(() => (['blocked', 'working', 'idle', 'unknown'].includes(hq().get('state')) ? hq().get('state') : 'all'));
  const [sheet, setSheet] = useState(() => !!hq().get('pane'));
  const [sess, setSess] = useState(() => hq().get('sessions') === '1');
  const wide = useWide(1024);
  const load = useCallback(() => getJSON('/api/herdr' + herdrQ({ session })).then(setX).catch(() => {}), [session]);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (x && !session) setSession(x.session); }, [x, session]);
  if (!x) return <Loading />;
  const sv = x.sessions.find((s) => s.name === x.session);
  const head = <div className="flex flex-wrap items-center gap-2" data-tour-step-id="herdr-sessoes">
    {x.sessions.length > 1 ? <Choice wide={wide} label="Sessão" value={x.session} onChange={(v) => { setSession(v); setSelId(null); }} items={x.sessions.map((s) => ({ value: s.name, label: s.name }))} /> : null}
    <Button variant="outline" size="sm" icon={I.Server} onClick={() => setSess(true)}>
      Sessões (
      {x.sessions.length}
      )
    </Button>
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
  const sel = all.find(({ p }) => p.id === selId)?.p || first?.p;
  const pick = (id) => { setSelId(id); if (!wide) setSheet(true); };
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
  const detail = sel ? <HerdrPane session={x.session} pane={sel} /> : <Empty icon={I.SquareTerminal} title="Escolha um terminal">
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
    {wide ? null : <Sheet open={sheet && !!sel} onClose={() => setSheet(false)} wide icon={I.SquareTerminal} title={sel ? (sel.name || sel.agent || 'terminal') : ''} description={sel ? sel.id : ''}>
      <div className="flex h-full min-h-0 flex-col p-4">
        {detail}
      </div>
    </Sheet>}
    <HerdrSessions open={sess} onClose={() => setSess(false)} sessions={x.sessions} onDone={load} />
  </div>;
}

HadesCore.registerPage('herdr', Herdr);
})();
