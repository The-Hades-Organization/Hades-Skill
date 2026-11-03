/* Página Acesso remoto (#/remote): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela. */
(() => {
const { useState, useEffect, I, cn, getJSON, post, Button, CardHeader, Tip, CopyButton, Empty, Mono, Dot, Fio, Skeleton,
  LinhaDeEstado, useActions, useApp, dt, WidgetApk } = HadesCore;

// estado no título da seção: ponto e palavra, como no resto do painel
const Estado = ({ kind, children }) => <span className="inline-flex items-center gap-1.5">
  <Dot kind={kind} pulse={kind === 'busy'} />
  {children}
</span>;
const jobRunning = (d, action) => (d?.jobs || []).some((j) => j.action === action && j.state === 'rodando');
// uma só ação primária por bloco (Publicar painel, Baixar APK); gerar token e gerar APK ficam secundárias

// valor copiável numa linha (URL, comando): mono, borda forte, copiar à direita
function Valor({ children, copy, label }) {
  return <div className="flex min-h-9 min-w-0 items-center gap-2 border border-border-strong bg-card pr-1 pl-3">
    <code className="min-w-0 flex-1 truncate py-2 t-data">
      {children}
    </code>
    {copy ? <CopyButton text={copy} label={label} /> : null}
  </div>;
}

// ------------------------------------------------------------------ túnel anônimo do widget (publicar e renovar são do dono, no terminal)
function WidgetTunnel({ d, st }) {
  const up = d.extras?.widgetTunnel?.state === 'active';
  const t = st?.tunnel || {};
  const exp = t.expiresAt ? Date.parse(t.expiresAt) : NaN;
  const expired = !Number.isNaN(exp) && exp < Date.now();
  const state = up && !expired ? ['ok', 'no ar'] : expired ? ['warn', 'acesso vencido'] : ['idle', 'fora do ar'];
  return <section className="grid content-start gap-3" aria-label="Túnel do widget" data-tour-step-id="remote-widget-tunel">
    <CardHeader as="h3" title="Túnel do widget" summary={<Estado kind={state[0]}>
      {state[1]}
    </Estado>} />
    {!st ? <Skeleton className="h-9" /> : t.url ? <Valor copy={t.url} label="Copiar URL do widget">
      {t.url}
      /api/widget
    </Valor> : <p className="t-body text-muted-foreground">
      {"Sem URL. No terminal: "}
      <Mono className="text-foreground">tunnel.sh widget-create</Mono>
      {", depois "}
      <Mono className="text-foreground">tunnel.sh widget-publish-cmds</Mono>
      .
    </p>}
    <p className="t-meta text-muted-foreground">
      {"Anônimo, só na porta "}
      <span className="tnum">{st?.port || 'do widget'}</span>
      {": o token é a única autenticação. "}
      {!Number.isNaN(exp) ? <>
        {expired ? 'O acesso venceu em ' : 'O acesso vence em '}
        <span className={cn('tnum', expired && 'font-medium text-warn')}>
          {dt(exp / 1000)}
        </span>
        {"; renove com "}
        <Mono>tunnel.sh widget-renew-cmds</Mono>
        .
      </> : <>
        {"Validade desconhecida; rode "}
        <Mono>tunnel.sh widget-stamp</Mono>
        .
      </>}
    </p>
  </section>;
}

// token ou chave em Code Slots (somente leitura, uma casa por caractere); sem o fx, o texto em <code> de sempre
function SecretSlots({ value, label, mask = false }) {
  const Slots = window.HadesFx.use('CodeSlots');
  if (!Slots) return <code className="min-w-0 flex-1 truncate font-mono t-body">{mask ? '•'.repeat(24) : value}</code>;
  const len = Math.min(String(value).length, 48);
  return <div className="min-w-0 flex-1 overflow-x-auto scrollbar-thin py-1">
    <Slots length={len} charset="text" value={String(value).slice(0, len)} mask={mask} disabled ariaLabel={mask ? label + ' (oculto)' : label}
      slotSize={len > 24 ? 22 : 30} gap={len > 24 ? 3 : 5} radius={0} slotColor="var(--muted)" digitColor="var(--secondary-foreground)"
      accentColor="var(--secondary)" inkColor="var(--foreground)" dangerColor="var(--destructive)" />
  </div>;
}

// ------------------------------------------------------------------ token do widget Android (só no painel local)
function WidgetToken({ st, fresh, onCreate, onRevoke }) {
  return <section className="grid content-start gap-3" aria-label="Token do widget" data-tour-step-id="remote-token">
    <CardHeader as="h3" title="Token do widget" summary={!st ? null : <Estado kind={st.configured ? 'ok' : 'idle'}>
      {st.configured ? 'ativo' : 'sem token'}
    </Estado>} />
    <p className="t-body text-muted-foreground">
      Só lê
      {' '}
      <Mono>GET /api/widget</Mono>
      : agentes, perguntas e eventos recentes. Aparece uma vez, ao gerar.
    </p>
    {fresh ? <div role="status" className="grid gap-2 border border-warn/50 bg-warn/5 p-3">
      <div className="flex items-center gap-2 border border-border-strong bg-background px-3 py-1">
        <SecretSlots value={fresh} label="Token do widget" />
        <CopyButton text={fresh} label="Copiar token" />
      </div>
      <p className="t-meta">
        Copie agora: não aparece de novo.
      </p>
    </div> : null}
    {st?.configured && !fresh ? <p className="t-body">
      {"Criado em "}
      <span className="tnum">
        {dt(Date.parse(st.createdAt) / 1000)}
      </span>
      <span className="text-muted-foreground">.</span>
    </p> : null}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" icon={I.KeySquare} disabled={!st} onClick={onCreate}>
        {st?.configured ? 'Gerar outro token' : 'Gerar token'}
      </Button>
      {st?.configured ? <Button variant="ghost-destructive" icon={I.Ban} onClick={onRevoke}>Revogar</Button> : null}
    </div>
  </section>;
}

// ------------------------------------------------------------------ APK do widget (baixar no celular, gerar no painel)

// quem entra pelo túnel do painel: as três travas, em linhas
const TRAVAS = [
  [I.ShieldCheck, 'Conta do GitHub', 'só a conta dona do túnel passa.'],
  [I.KeyRound, 'Chave de acesso', 'pedida mesmo logado; vale 30 dias neste navegador, depois pede de novo. Oito erros em 10 min bloqueiam novas tentativas por um tempo.'],
  [I.Lock, 'Só daqui', 'túnel e chave só se mudam no painel local.'],
];

// ------------------------------------------------------------------ acesso remoto (túnel do painel)
function Remote({ d }) {
  const run = useActions();
  const { toast, confirm } = useApp();
  const [info, setInfo] = useState(null);
  const [show, setShow] = useState(false);
  const [st, setSt] = useState(null);
  const [fresh, setFresh] = useState(null);   // o token recém-criado: só existe aqui, o servidor guarda o hash
  useEffect(() => {
    let alive = true;
    const f = () => getJSON('/api/remote').then((r) => alive && setInfo(r)).catch(() => {});
    f(); const t = setInterval(f, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const loadToken = () => getJSON('/api/widget/token').then(setSt).catch(() => {});
  useEffect(() => { loadToken(); }, []);
  const tokenOp = async (op) => {
    try {
      const r = await post('/api/widget/token', { op });
      setFresh(op === 'create' ? r.token : null);
      await loadToken();
    } catch (e) { toast({ kind: 'bad', title: op === 'create' ? 'Gerar token: não deu' : 'Revogar: não deu', desc: e.message }); }
  };
  const createToken = async () => {
    if (st?.configured && !(await confirm({ title: 'Gerar outro token?', icon: I.KeySquare, danger: true, confirmLabel: 'Gerar',
      description: 'O token atual deixa de valer na hora; o widget precisa do novo.' }))) return;
    tokenOp('create');
  };
  const revokeToken = async () => {
    if (await confirm({ title: 'Revogar o token do widget?', icon: I.Ban, danger: true, confirmLabel: 'Revogar',
      description: 'O widget para de atualizar e GET /api/widget passa a responder 404.' })) tokenOp('revoke');
  };
  const pt = d.panelTunnel || {};
  const on = pt.unit === 'active';
  const url = pt.url;
  const moving = jobRunning(d, 'panel-tunnel');
  if (info?.remote) return <Empty icon={I.Earth} title="Você está no acesso remoto.">
    Túnel e chave só se controlam pelo painel local.
  </Empty>;
  const tunnelState = moving ? ['busy', 'mexendo no túnel…'] : on ? ['ok', 'no ar'] : url ? ['idle', 'parado'] : ['idle', 'nunca publicado'];
  return <div className="grid gap-10">
    <div data-tour-step-id="remote-estado">
    <LinhaDeEstado main={on ? 'O painel abre fora da máquina' : url ? 'Túnel do painel parado' : 'O painel só abre nesta máquina'}
      rest={[info ? (info.hasKey ? 'chave de acesso criada' : 'sem chave de acesso') : null, st ? (st.configured ? 'widget com token' : 'widget sem token') : null]} />
    </div>
    <div className="grid items-start gap-10 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] xl:gap-x-12">
      <section className="grid content-start gap-4" aria-label="Túnel do painel" data-tour-step-id="remote-tunel">
        <CardHeader title="Túnel do painel" summary={<Estado kind={tunnelState[0]}>
          {tunnelState[1]}
        </Estado>} />
        {moving ? <Fio s="fiando" label="Mexendo no túnel do painel" /> : null}
        <p className="t-body text-muted-foreground">
          Abre o painel fora da máquina por um devtunnel próprio, que vence 30 dias depois de criado.
        </p>
        {url ? <div className="grid gap-1.5" data-tour-step-id="remote-url">
          <div className="flex min-h-9 min-w-0 items-center gap-2 border border-border-strong bg-card pr-1 pl-3">
            <a href={url} target="_blank" rel="noopener" className="min-w-0 flex-1 truncate py-2 t-data underline-offset-3 hover:underline">
              {url}
            </a>
            <CopyButton text={url} label="Copiar URL" />
          </div>
          <p className="t-meta text-muted-foreground">
            {on ? 'Entre com sua conta do GitHub e cole a chave.' : 'A URL volta ao publicar de novo.'}
          </p>
        </div> : null}
        <div className="flex flex-wrap gap-2" data-tour-step-id="remote-acoes">
          {on ? <>
            <Button variant="outline" icon={I.RefreshCw} disabled={moving} onClick={() => run({ action: 'panel-tunnel', op: 'url' })}>Reler URL</Button>
            <Button variant="ghost-destructive" icon={I.CircleStop} disabled={moving} onClick={() => run({ action: 'panel-tunnel', op: 'stop' }, { title: 'Parar o túnel do painel?', description: 'O painel deixa de abrir fora da máquina. URL e chave voltam ao publicar de novo.', icon: I.CircleStop, danger: true })}>Parar</Button>
          </>
            : <Button icon={I.Earth} loading={moving} onClick={() => run({ action: 'panel-tunnel', op: 'start' }, { title: 'Publicar o painel?', icon: I.Earth,
                description: `Cria (se faltar) o túnel ${d.instance?.panelTunnel || 'hades-panel'} na porta ${d.config?.HADES_PANEL_PORT || 21220}, como unit ${d.unitPrefix || 'hds'}-panel-tunnel.\nAcesso: só a conta dona do devtunnel, e o painel ainda pede a chave.` })}>
              {url ? 'Publicar de novo' : 'Publicar painel'}
            </Button>}
        </div>
        <ul className="grid border-t t-body" aria-label="Quem entra pelo túnel" data-tour-step-id="remote-travas">
          {TRAVAS.map(([Icon, k, v]) => <li key={k} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5 border-b py-2.5 md:grid-cols-[1rem_8.5rem_minmax(0,1fr)]">
            <Icon className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium">{k}</span>
            <span className="text-muted-foreground text-pretty max-md:col-start-2">{v}</span>
          </li>)}
        </ul>
      </section>
      <section className="grid content-start gap-4" aria-label="Chave de acesso" data-tour-step-id="remote-chave">
        <CardHeader title="Chave de acesso" summary={info ? <Estado kind={info.hasKey ? 'ok' : 'idle'}>
          {info.hasKey ? 'criada' : 'sem chave'}
        </Estado> : null} />
        <p className="t-body text-muted-foreground">
          Cole no navegador remoto. Trocar a chave derruba as sessões remotas.
        </p>
        {!info ? <Skeleton className="h-11" /> : info.hasKey ? <>
          <div className="flex items-center gap-1 border border-border-strong bg-card py-1 pr-1 pl-3">
            <SecretSlots value={info.key} label="Chave de acesso" mask={!show} />
            <Tip text={show ? 'Esconder' : 'Mostrar'}>
              <Button variant="ghost" size="icon-xs" aria-label={show ? 'Esconder a chave' : 'Mostrar a chave'} aria-pressed={show} icon={show ? I.EyeOff : I.Eye} onClick={() => setShow(!show)} />
            </Tip>
            <CopyButton text={info.key} label="Copiar chave" />
          </div>
          <Button variant="outline" icon={I.KeySquare} className="justify-self-start" onClick={() => run({ action: 'panel-tunnel', op: 'rotate' }, { title: 'Trocar a chave de acesso?', description: 'Quem está no painel remoto precisa entrar de novo com a chave nova.', icon: I.KeySquare, danger: true })}>Trocar chave</Button>
        </> : <Empty icon={I.KeyRound} title="Sem chave ainda.">
          Nasce ao publicar o painel.
        </Empty>}
      </section>
    </div>
    <div className="grid gap-4" data-tour-step-id="remote-widget">
      <CardHeader title="Widget Android" summary="o celular lê sem abrir o painel" />
      <div className="grid items-start gap-10 pt-2 md:grid-cols-2 xl:grid-cols-3 xl:gap-x-12">
        <WidgetToken st={st} fresh={fresh} onCreate={createToken} onRevoke={revokeToken} />
        <WidgetTunnel d={d} st={st} />
        <div data-tour-step-id="remote-apk">
          <WidgetApk d={d} />
        </div>
      </div>
    </div>
  </div>;
}

HadesCore.registerPage('remote', Remote);
})();
