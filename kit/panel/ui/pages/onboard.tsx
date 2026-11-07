/* Página Onboarding (#/onboard): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela.
 * Cada feature é um fio medido: um nó por passo feito, na posição do passo; os passos em lista logo abaixo. */
(() => {
const { useState, useEffect, useCallback, I, cn, post, getJSON, ErroExplicado, errDesc, Button, Card, CardHeader, CardContent, CopyButton, Empty,
  Fio, LinhaDeEstado, useApp, Loading } = HadesCore;

// ------------------------------------------------------------------ onboarding (onboard.sh, mesma fonte do comando e do doctor)
const OB_ST = { feito: { label: 'feito', icon: I.Check, tone: 'text-ok' }, pendente: { label: 'pendente', icon: I.CircleDashed, tone: 'text-warn' },
  na: { label: 'não se aplica', icon: I.Minus, tone: 'text-muted-foreground' } };
const OB_CHOICE = { selecionada: 'escolhida', pulada: 'pulada', nova: 'não escolhida' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// o nó do passo i fica no meio do trecho dele, para o primeiro e o último não caírem na ponta do fio
const knotAt = (i, n) => Math.round((i + 0.5) / n * 100);

// passo pendente de feature não escolhida fica quieto (não é urgente): o âmbar e a ação primária só nas escolhidas
function ObStep({ s, sel, busy, act, go, tour, first }) {
  const st = OB_ST[s.state] || OB_ST.pendente;
  const open = s.state === 'pendente';
  return <li data-tour-step-id={tour ? (first ? 'tour-onboard-pending onboard-passo' : 'tour-onboard-pending') : (first ? 'onboard-passo' : undefined)} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b py-3 last:border-b-0">
    <st.icon className={cn('mt-0.5 size-4', open && !sel ? 'text-muted-foreground' : st.tone)} aria-hidden="true" />
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className={cn('min-w-0 flex-1 t-label', !open && 'text-muted-foreground')}>
        {s.name}
        <span className="sr-only">{': ' + st.label}</span>
      </span>
      <span className="shrink-0 t-meta text-muted-foreground">{s.who === 'dono' ? 'você faz' : 'o Hades faz'}</span>
    </div>
    {s.note || s.detail ? <p className="col-start-2 max-w-[70ch] t-body text-muted-foreground">
      {(s.note ? s.note + '. ' : '') + (s.detail || '')}
    </p> : null}
    {s.command && s.state !== 'feito' ? <div data-tour-step-id={first ? 'onboard-comando' : undefined} className="col-start-2 flex items-start gap-1 bg-muted py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 py-1 t-data break-all">
        {(s.interactive ? '! ' : '') + s.command}
      </code>
      <CopyButton text={s.command} label={`Copiar o comando de ${s.name}`} />
    </div> : null}
    {(s.runnable && open) || s.manual || s.page || s.doc ? <div data-tour-step-id={first ? 'onboard-acoes' : undefined} className="col-start-2 flex flex-wrap items-center gap-x-2 gap-y-1">
      {s.runnable && open ? <Button size="xs" variant={sel ? 'default' : 'outline'} icon={I.Play} loading={busy === s.id} onClick={() => act({ op: 'run', step: s.id }, s)}>Executar pelo Hades</Button> : null}
      {s.manual && open ? <Button size="xs" variant="outline" icon={I.Check} onClick={() => act({ op: 'done', step: s.id })}>Marcar como feito</Button> : null}
      {s.manual && s.state === 'feito' ? <Button size="xs" variant="ghost" onClick={() => act({ op: 'undone', step: s.id })}>Desmarcar</Button> : null}
      {s.page ? <Button size="xs" variant="ghost" icon={I.ArrowUpRight} onClick={() => go(s.page)}>Abrir a página</Button> : null}
      {s.doc ? <span className="ml-auto t-data text-muted-foreground max-md:basis-full">{s.doc}</span> : null}
    </div> : null}
  </li>;
}

function Feature({ f, busy, act, go, firstPending, first }) {
  const sel = f.choice === 'selecionada';
  const n = f.steps.length;
  const applicable = f.steps.filter((s) => s.state !== 'na').length;
  const done = f.steps.filter((s) => s.state === 'feito').length;
  const knots = f.steps.map((s, i) => s.state === 'feito' ? knotAt(i, n) : null).filter((k) => k != null);
  // medido quando não falta nada; frouxo (esperando você) quando foi escolhida e falta passo; parado se não escolhida
  const fio = done === applicable ? 'medido' : sel ? 'frouxo' : 'parado';
  return <Card data-tour-step-id={first ? 'onboard-recurso' : undefined}>
    <CardHeader className="max-md:[&>div:first-child]:basis-full" title={f.label} summary={`${OB_CHOICE[f.choice] || OB_CHOICE.nova} · ${done} de ${applicable} feitos`} description={f.desc}
      action={<>
        {sel ? <span className="inline-flex items-center gap-1.5 t-label text-muted-foreground">
          <I.Check className="size-3.5" aria-hidden="true" />
          Escolhida
        </span> : <Button size="sm" variant="outline" icon={I.Plus} onClick={() => act({ op: 'select', features: [f.id] })}>Escolher</Button>}
        {f.choice !== 'pulada' ? <Button size="sm" variant="ghost" onClick={() => act({ op: 'skip', features: [f.id] })}>Pular</Button> : null}
      </>} />
    <CardContent className="grid gap-1">
      <div data-tour-step-id={first ? 'onboard-fio' : undefined}>
        <Fio s={fio} nos={knots} className="my-2" label={`${f.label}: ${done} de ${applicable} passos feitos${f.pending ? `, ${plural(f.pending, 'pendente', 'pendentes')}` : ''}`} />
      </div>
      <ul>
        {f.steps.map((s) => <ObStep key={s.id} s={s} sel={sel} busy={busy} act={act} go={go} tour={firstPending.includes(s.id)} first={first && s.id === f.steps[0].id} />)}
      </ul>
    </CardContent>
  </Card>;
}

function Onboard({ go }) {
  const { toast, confirm } = useApp();
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = useCallback(() => { setBusy('load'); return getJSON('/api/onboard').then((r) => { if (r.error) throw Object.assign(new Error(r.error), { code: r.code, explain: r.explain }); setSt(r); setErr(null); }).catch((e) => setErr(e)).finally(() => setBusy(null)); }, []);
  useEffect(() => { load(); }, [load]);
  // o tour grava a escolha dele (HadesTour): recarrega o resumo "o que falta"
  useEffect(() => { const f = () => { load(); }; addEventListener('hades-onboard-changed', f); return () => removeEventListener('hades-onboard-changed', f); }, [load]);
  const act = useCallback(async (body, s) => {
    if (body.op === 'run' && !(await confirm({ title: 'Executar este passo?', description: `${s.name}\n\n${s.command}`, icon: I.Play }))) return;
    setBusy(s?.id || 'x');
    try {
      const r = await post('/api/onboard', body);
      if (r.job) toast({ kind: 'busy', title: 'Passo iniciado', desc: s.name });
      await load();
    } catch (e) { toast({ kind: 'bad', title: 'Não deu para executar o passo', desc: errDesc(e) }); } finally { setBusy(null); }
  }, [load, toast, confirm]);
  if (err && !st) return <div className="grid justify-items-start gap-3">
    <ErroExplicado error={err} title="Não consegui ler o onboarding" />
    <Button variant="outline" size="sm" icon={I.RefreshCw} loading={busy === 'load'} onClick={load}>Tentar de novo</Button>
  </div>;
  if (!st) return <Loading />;
  const pr = st.progress;
  // alvo do tour: até 3 passos pendentes das features escolhidas; sem nenhum, o texto de abertura
  const firstPending = st.features.filter((f) => f.choice === 'selecionada').flatMap((f) => f.steps.filter((s) => s.state === 'pendente').slice(0, 1)).slice(0, 3).map((s) => s.id);
  const missing = pr ? [pr.unchosen.length ? `escolher o que preparar (${pr.unchosen.join(', ')})` : null, pr.pending ? `${plural(pr.pending, 'passo pendente', 'passos pendentes')} em ${pr.pendingFeatures.join(', ')}` : null, pr.tourDone ? null : 'fazer o tour do painel'].filter(Boolean) : [];
  const all = st.features.flatMap((f) => f.steps).filter((s) => s.state !== 'na');
  const doneAll = all.filter((s) => s.state === 'feito').length;
  return <div className="grid gap-8">
    <div className="grid gap-4">
      <div data-tour-step-id={firstPending.length ? 'onboard-intro' : 'tour-onboard-pending onboard-intro'} className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <p className="min-w-0 max-w-[70ch] flex-1 basis-80 t-body text-muted-foreground">
          Escolher só marca o recurso: nada roda, e os passos abaixo mostram o que fazer. O resto fica para depois. O Hades só executa um passo com o seu ok; túnel público, login, sudo e tokens são seus: mostramos só o comando. Comando com ! na frente: rode no Claude Code com o !, porque pede terminal ou senha.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button data-tour-step-id="onboard-fazer-tour" variant="outline" size="sm" icon={I.Compass} onClick={() => window.HadesTour?.start()}>Fazer o tour</Button>
          <Button variant="ghost" size="sm" icon={I.RefreshCw} loading={busy === 'load'} onClick={load}>Verificar de novo</Button>
        </div>
      </div>
      {pr ? <div role="status" data-tour-step-id="onboard-resumo">
        <LinhaDeEstado main={st.complete ? 'Onboarding completo' : `${doneAll} de ${all.length} passos feitos`}
          rest={st.complete ? [`${doneAll} passos feitos`] : missing.map((m, i) => i === 0 ? 'falta ' + m : m)} />
      </div> : null}
    </div>
    <div className="grid items-start gap-x-10 gap-y-10 xl:grid-cols-2">
      {st.features.map((f, i) => <Feature key={f.id} first={i === 0} f={f} busy={busy} act={act} go={go} firstPending={firstPending} />)}
    </div>
  </div>;
}

HadesCore.registerPage('onboard', Onboard);
})();
