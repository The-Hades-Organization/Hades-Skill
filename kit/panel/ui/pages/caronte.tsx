/* Página Caronte (#/caronte): planos prontos para levar a outra sessão ou máquina, prévia do pack, pacotes e o prompt de
 * retomada. Só leitura, exceto o botão Estacionar (hades agent park). Pack e unpack são no terminal: a senha nunca passa
 * pelo navegador (reference/caronte.md). */
(() => {
const { useState, useEffect, useCallback, useRef, I, getJSON, post, useApp, Button, HoldConfirm, Card, CardHeader, CardContent, CopyButton,
  Mono, Empty, Skeleton, Loading, Dot, Fio, Regua, Leitura, LinhaDeEstado, ago, cn, useWide, useTourPreview, ExampleSeal } = HadesCore;

// prontidão do agente para o pack: estacionado e encerrado atravessam; trabalhando ainda segura o barco
const READINESS = { parked: ['estacionado', 'ok'], ended: ['encerrado', 'idle'], working: ['trabalhando', 'busy'] };
const ERRORS = {
  busy: 'já está sendo estacionado',
  action_timeout: 'não terminou a tempo: tente de novo',
  unknown_agent: 'não é mais deste plano',
  unknown_plan: 'o plano não existe mais',
};
const bytes = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} MB` : n >= 1024 ? `${(n / 1024).toFixed(1).replace('.', ',')} KB` : `${n} B`;
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
// pacote do plano: <plano>-<UTC>.caronte (reference/caronte.md §Saída)
const ofPlan = (pkg, plan) => pkg.name.startsWith(plan + '-') && /^\d/.test(pkg.name.slice(plan.length + 1));
const ROW = 'grid w-full gap-1 border-b border-l-2 border-l-transparent px-3 py-2.5 text-left t-body transition-colors cursor-pointer hover:bg-accent/60 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

function Command({ text, label }) {
  return <div className="flex min-h-9 items-center gap-2 border border-border-strong bg-card pr-1 pl-3">
    <code className="min-w-0 flex-1 overflow-x-auto py-2 t-data whitespace-nowrap scrollbar-thin">{text}</code>
    <CopyButton text={text} label={label} />
  </div>;
}

// as três margens: o óbolo marca onde o plano está; o que já atravessou é nó medido, o que falta é marco vazio
function Marco({ k }) {
  if (k === 'feito') return <span className="size-2 shrink-0 rotate-45 bg-foreground" aria-hidden="true" />;
  if (k === 'aqui') return <span className="size-2.5 shrink-0 rounded-full border border-metal-ink bg-metal" aria-hidden="true" />;
  return <span className="size-2 shrink-0 border border-border-strong" aria-hidden="true" />;
}
function Travessia({ margens, onGo }) {
  return <nav aria-label="Travessia do plano" className="grid grid-cols-[minmax(0,1fr)_1.25rem_minmax(0,1fr)_1.25rem_minmax(0,1fr)] items-start gap-x-2 md:grid-cols-[auto_minmax(2rem,1fr)_auto_minmax(2rem,1fr)_auto] md:gap-x-4">
    {margens.flatMap((m, i) => [
      i ? <Fio key={'f' + i} s={margens[i - 1].k === 'feito' ? (m.k === 'falta' ? 'frouxo' : 'medido') : 'parado'} className="mt-[9px]" label={`${margens[i - 1].nome} → ${m.nome}`} /> : null,
      <button key={m.id} type="button" onClick={() => onGo(m.id)} aria-current={m.k === 'aqui' ? 'step' : undefined}
        className="grid min-w-0 cursor-pointer justify-items-start gap-0.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11">
        <span className={cn('flex items-center gap-2 t-body', m.k === 'falta' ? 'text-muted-foreground' : 'font-medium')}><Marco k={m.k} />{m.nome}</span>
        <span className="t-meta text-muted-foreground">{m.estado}</span>
      </button>,
    ].filter(Boolean))}
  </nav>;
}

function AgentRow({ plan, agent, busy, example, onPark }) {
  const [label, kind] = READINESS[agent.readiness] || [agent.readiness, 'idle'];
  return <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b py-2.5 last:border-b-0">
    <span className="min-w-0 truncate t-label">{agent.name}</span>
    <span className="inline-flex items-center gap-1.5 t-meta text-muted-foreground"><Dot kind={kind} pulse={kind === 'busy'} />{label}</span>
    {agent.canPark ? <span className="ml-auto" data-tour-step-id="caronte-park">
      <HoldConfirm size="sm" icon={busy ? I.LoaderCircle : I.CirclePause} disabled={busy || example} onHold={() => onPark(plan, agent.name)}>
        {busy ? 'Estacionando…' : 'Segure 1,2 s: Estacionar'}
      </HoldConfirm>
    </span> : null}
    {agent.command ? <span className="flex basis-full items-center gap-1.5 t-meta text-muted-foreground">falta <Mono>{agent.command}</Mono><CopyButton text={agent.command} label={`Copiar o comando que estaciona ${agent.name}`} /></span> : null}
  </li>;
}

function Preview({ detail, plan }) {
  if (!detail) return <Skeleton className="h-28" />;
  const { preview, previewError } = detail;
  if (previewError) {
    if (previewError.code === 'not_ready') return <Empty icon={I.CirclePause} title="O pack ainda recusaria.">
      Estacione antes {(previewError.agents || []).map((a, i) => <span key={a}>{i ? ', ' : ''}<Mono>{a}</Mono></span>)}.
    </Empty>;
    return <div className="grid gap-2">
      <Empty icon={I.CircleAlert} title="Sem prévia.">Rode no terminal para ver o motivo.</Empty>
      <Command text={detail.commands?.dryRun || `hades caronte pack ${plan} --dry-run`} label="Copiar o comando da prévia" />
    </div>;
  }
  const blocked = preview.blocked.length;
  return <div className="grid gap-4">
    <Regua label="Prévia do pacote">
      <Leitura label="Partes" value={preview.parts.length} detail="arquivos do plano e das worktrees" />
      <Leitura label="Worktrees" value={preview.worktrees.length} />
      <Leitura label="Tamanho estimado" value={bytes(preview.rawBytes)} detail="antes do gzip e da cifra" />
      <Leitura label="Barrados" value={blocked} detail={blocked ? 'guarda de segredo' : 'nenhum'} />
    </Regua>
    {blocked ? <ul className="grid gap-1.5 t-body" aria-label="Arquivos barrados">
      {preview.blocked.map((f) => <li key={f.path + f.rule} className="flex flex-wrap items-baseline gap-x-2">
        <I.ShieldAlert className="size-4 shrink-0 translate-y-0.5 text-bad" aria-hidden="true" />
        <Mono className="break-all">{f.path}</Mono>
        <span className="t-meta text-muted-foreground">{f.rule === 'nome' ? 'nome de credencial' : 'padrão de segredo no conteúdo'}</span>
      </li>)}
    </ul> : null}
    {preview.worktrees.length ? <ul className="grid t-body" aria-label="Worktrees no pacote">
      {preview.worktrees.map((w) => <li key={w.agent} className="flex flex-wrap items-baseline gap-x-2 border-b py-1.5 last:border-b-0">
        <span className="font-medium">{w.agent}</span>
        <Mono className="text-muted-foreground">{w.branch || '(sem branch)'}</Mono>
        <span className="t-meta text-muted-foreground">base <Mono>{w.baseRef}</Mono> · {w.bundle ? 'leva os commits' : 'sem commit próprio'}{w.patch ? ' · leva o não commitado' : ''}</span>
      </li>)}
    </ul> : null}
    <details className="group/p border-y">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 t-body outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <I.ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open/p:rotate-90" aria-hidden="true" />
        <span className="font-medium">Partes do pacote</span>
        <span className="t-meta text-muted-foreground tnum">{preview.parts.length}</span>
      </summary>
      <ul className="grid gap-0.5 pb-3 pl-5.5 t-data">
        {preview.parts.map((p) => <li key={p.path} className="flex justify-between gap-3"><span className="truncate">{p.path}</span><span className="shrink-0 text-muted-foreground tnum">{bytes(p.size)}</span></li>)}
      </ul>
    </details>
  </div>;
}

function Caronte() {
  // tour da página rodando com exemplo: planos, pacotes e detalhe vêm da prévia, não do servidor
  const exemplo = useTourPreview('caronte');
  const { toast } = useApp();
  const wide = useWide(1024);
  const desk = useWide(768);
  const [dataReal, setData] = useState(null);
  const data = exemplo ? exemplo.data : dataReal;
  const [error, setError] = useState(null);
  const [cur, setCur] = useState(null);
  const [detailReal, setDetail] = useState(null);
  const [parking, setParking] = useState(null);
  const refs = { estacionar: useRef(null), empacotar: useRef(null), retomar: useRef(null) };

  const load = useCallback(() => getJSON('/api/caronte').then((r) => { setData(r); setError(null); }).catch((e) => setError(String(e.message || e))), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const selected = cur || data?.plans?.[0]?.name;
  const detail = exemplo ? (exemplo.details[selected] ?? null) : detailReal;
  const loadDetail = useCallback(() => {
    if (!selected || exemplo) return Promise.resolve();
    return getJSON('/api/caronte/plan/' + encodeURIComponent(selected)).then(setDetail).catch((e) => setDetail({ preview: null, previewError: { code: 'preview_failed' }, brief: '', agents: [], commands: null, error: String(e.message || e) }));
  }, [selected, exemplo]);
  useEffect(() => { setDetail(null); loadDetail(); }, [loadDetail]);

  const park = async (plan, agent) => {
    setParking(agent);
    try {
      const r = await post('/api/caronte/park', { plan, agent });
      toast({ kind: 'ok', title: r.already ? 'Já estava estacionado' : 'Estacionado', desc: agent });
      await Promise.all([load(), loadDetail()]);
    } catch (e) {
      toast({ kind: 'bad', title: 'Estacionar: não deu', desc: ERRORS[e.code] || e.message });
    } finally {
      setParking(null);
    }
  };

  if (error && !data) return <Empty icon={I.CircleAlert} title="Não deu para ler os planos.">{error}. Tentando de novo a cada 10 s.</Empty>;
  if (!data) return <Loading />;
  if (!data.plans.length) return <Empty icon={I.ScrollText} title="Nenhum plano.">Ficam em <Mono>~/.claude/hades/plans</Mono>; o orquestrador grava um ao começar.</Empty>;
  const plan = data.plans.find((p) => p.name === selected);
  const ready = data.plans.filter((p) => p.ready).length;
  const mine = plan ? data.packages.filter((p) => ofPlan(p, plan.name)) : [];
  const lastPkg = mine.reduce((a, p) => (!a || p.modifiedAt > a.modifiedAt ? p : a), null);
  const pv = detail?.preview;
  const margens = plan ? [
    { id: 'estacionar', nome: 'Estacionar', k: plan.ready ? 'feito' : 'aqui', estado: plan.ready ? (plan.agents.length ? 'todos estacionados ou encerrados' : 'sem agente no plano') : `${plural(plan.missing.length, 'agente', 'agentes')} a estacionar` },
    { id: 'empacotar', nome: 'Empacotar', k: !plan.ready ? 'falta' : mine.length ? 'feito' : 'aqui',
      estado: mine.length ? `pacote ${ago(lastPkg.modifiedAt)}` : !plan.ready ? 'espera o estacionamento' : pv?.blocked?.length ? `${plural(pv.blocked.length, 'arquivo barrado', 'arquivos barrados')}` : 'no terminal, com senha' },
    { id: 'retomar', nome: 'Retomar', k: mine.length ? 'aqui' : 'falta', estado: mine.length ? 'unpack e prompt' : 'depois do pacote' },
  ] : [];
  const go = (id) => refs[id].current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  // na mesa a explicação vai na linha do título; no celular ela desce para não ser cortada
  const head = (title, text) => <CardHeader title={title} summary={desk ? text : null} description={desk ? null : text} />;
  const planItem = (p) => `${p.name} · ${p.ready ? 'pronto' : `${p.missing.length} a estacionar`}`;

  return <div className="grid gap-6">
    <div className="grid gap-1">
      <div data-tour-step-id="caronte-resumo">
      <LinhaDeEstado main={`${plural(ready, 'plano pronto', 'planos prontos')} para o pack`}
        rest={[ready < data.plans.length ? `${data.plans.length - ready} com agente a estacionar` : null, data.packages.length ? plural(data.packages.length, 'pacote', 'pacotes') : 'nenhum pacote ainda']} />
      </div>
      {error ? <p className="t-body text-bad" role="status">Sem atualizar: {error}. Mostrando a última leitura.</p> : null}
    </div>
    <div className="grid items-start gap-8 lg:grid-cols-[18rem_minmax(0,1fr)]">
      {wide ? <Card className="gap-0 lg:sticky lg:top-[4.5rem]" data-tour-step-id="caronte-planos">
        <CardHeader title="Planos" summary={`${data.plans.length}`} action={exemplo ? <ExampleSeal /> : null} />
        <CardContent className="max-h-[calc(100dvh-12rem)] overflow-y-auto scrollbar-thin">
          {data.plans.map((p) => <button key={p.name} type="button" onClick={() => setCur(p.name)} aria-current={selected === p.name ? 'true' : undefined}
            className={cn(ROW, selected === p.name && 'border-l-foreground bg-accent/40')}>
            <span className="truncate font-medium">{p.name}</span>
            <span className="flex flex-wrap items-center gap-x-1.5 t-meta text-muted-foreground">
              <Dot kind={p.ready ? 'ok' : 'warn'} />
              <span className={p.ready ? '' : 'text-foreground'}>{p.ready ? 'pronto para o pack' : `${p.missing.length} a estacionar`}</span>
              <span>· {plural(p.agents.length, 'agente', 'agentes')} · {ago(p.modifiedAt)}</span>
            </span>
          </button>)}
        </CardContent>
      </Card> : <label className="grid gap-1.5 t-body" data-tour-step-id="caronte-planos">
        <span className="font-medium">
          Plano
          {exemplo ? <> <ExampleSeal /></> : null}
        </span>
        <select value={selected} onChange={(e) => setCur(e.target.value)} className="h-11 min-w-0 cursor-pointer border border-border-strong bg-background px-3 t-body">
          {data.plans.map((p) => <option key={p.name} value={p.name}>{planItem(p)}</option>)}
        </select>
      </label>}
      {plan ? <div className="grid min-w-0 gap-10">
        <div className="grid gap-4">
          {wide ? <h2 className="t-section break-words">{plan.name}</h2> : null}
          <div data-tour-step-id="caronte-travessia">
          <Travessia margens={margens} onGo={go} />
          </div>
        </div>
        <section ref={refs.estacionar} className="grid scroll-mt-20 gap-3" aria-label="Estacionar" data-tour-step-id="caronte-estacionar">
          {head('Estacionar', 'o pack exige agentes estacionados ou encerrados. Estacionar: o agente commita o pronto, grava o handoff e para, sem fechar o terminal, em até 10 min')}
          {plan.agents.length === 0 ? <Empty icon={I.Users} title="Nenhum agente no plano." />
            : <ul>{plan.agents.map((a) => <AgentRow key={a.name} plan={plan.name} agent={a} busy={parking === a.name} example={!!exemplo} onPark={park} />)}</ul>}
        </section>
        <section ref={refs.empacotar} className="grid scroll-mt-20 gap-3" aria-label="Empacotar" data-tour-step-id="caronte-empacotar">
          {head('Empacotar', 'prévia do pack --dry-run: não grava nada')}
          <div data-tour-step-id="caronte-previa">
            <Preview detail={detail} plan={plan.name} />
          </div>
          <div className="grid gap-2 pt-2" data-tour-step-id="caronte-pack">
            {detail?.commands ? <Command text={detail.commands.pack} label="Copiar o comando do pack" /> : <Skeleton className="h-9" />}
            <p className="flex items-start gap-2 t-body text-muted-foreground"><I.KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              A senha é digitada só no terminal. Esquecida, o pacote se perde.</p>
          </div>
        </section>
        <section ref={refs.retomar} className="grid scroll-mt-20 gap-3" aria-label="Retomar" data-tour-step-id="caronte-retomar">
          {head('Retomar', 'na outra máquina: abra o pacote e entregue o prompt ao orquestrador de lá')}
          {data.packages.length === 0 ? <Empty icon={I.Package} title="Nenhum pacote ainda.">O pack grava em <Mono>{data.packagesDir}</Mono>.</Empty>
            : <ul aria-label="Pacotes" className="grid" data-tour-step-id="caronte-pacotes">{[...mine, ...data.packages.filter((p) => !mine.includes(p))].map((p) => <li key={p.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 t-body last:border-b-0">
              <Mono className={cn('min-w-0 break-all', !mine.includes(p) && 'text-muted-foreground')}>{p.name}</Mono>
              <span className="t-meta text-muted-foreground tnum">{bytes(p.size)} · {ago(p.modifiedAt)}</span>
              <span className="ml-auto"><CopyButton text={p.unpack} label={`Copiar o comando que abre ${p.name}`} /></span>
            </li>)}</ul>}
          {detail?.commands ? <Command text={detail.commands.unpack} label="Copiar o comando do unpack" /> : null}
          <div className="grid gap-2 pt-4" data-tour-step-id="caronte-brief">
            <CardHeader as="h3" title="Prompt de retomada" summary="hades caronte brief"
              action={detail?.brief ? <CopyButton text={detail.brief} label="Copiar o prompt de retomada" /> : null} />
            {!detail ? <Skeleton className="h-24" /> : detail.brief ? <pre className="max-h-80 overflow-auto border bg-card p-4 t-code whitespace-pre-wrap scrollbar-thin">{detail.brief}</pre>
              : <Empty icon={I.FileX} title="Sem prompt de retomada." />}
          </div>
        </section>
      </div> : null}
    </div>
  </div>;
}

HadesCore.registerPage('caronte', Caronte);
})();
