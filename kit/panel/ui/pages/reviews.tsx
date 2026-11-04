/* Página Revisões (#/reviews): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela.
 * O formulário no topo (PRs à esquerda, como revisar à direita); as revisões em curso como fios; o histórico como lista. */
(() => {
const { useState, useEffect, useCallback, useId, I, cn, dur, post, getJSON, Button, Card, CardHeader, CardContent, Switch,
  Field, Skeleton, Mono, Tip, Empty, Sheet, useApp, ago, Segmented, PrPicker, renderMd, modelLabel, Loading, Fio,
  LinhaDeEstado, useTourPreview, ExampleSeal } = HadesCore;

const REVIEW_CMD = { 'review-pr': ['/review-pr', 'Uma sessão revisa sozinha. Rápido e barato.'],
  'review-agents': ['/review-agents', 'Subagentes review-* em paralelo, depois a coerência. Mais profundo e bem mais caro.'] };
const VERDICT = { red: ['Bloqueia', 'text-bad', I.OctagonX], yellow: ['Pede ajustes', 'text-warn', I.TriangleAlert], green: ['Aprova', 'text-ok', I.CircleCheck] };
const EFFORT = { low: 'baixo', medium: 'médio', high: 'alto' };
const MAX_PRS = 6;
const FASE_ROTULO = { fila: 'na fila', fetch: 'buscando a PR', checkout: 'preparando o worktree', 'revisão': 'revisando', 'publicação': 'publicando' };
const faseDe = (r) => r.fase ? FASE_ROTULO[r.fase] || r.fase : 'iniciando';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const usd = (v) => 'US$ ' + v.toFixed(2).replace('.', ',');
const tok = (v) => v == null ? '—' : v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace('.', ',') + 'M' : v >= 1000 ? Math.round(v / 1000) + 'k' : String(v);
const tokTotal = (t) => t ? (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) : null;
const tokTip = (r) => [`entrada ${tok(r.tokens.input)} · saída ${tok(r.tokens.output)}`, `cache lido ${tok(r.tokens.cacheRead)} · cache escrito ${tok(r.tokens.cacheWrite)}`,
  ...Object.entries(r.tokensByModel || {}).map(([m, v]) => `${modelLabel(m)}: ${tok(tokTotal(v))}${v.costUsd != null ? ' · ' + usd(v.costUsd) : ''}`)].join(' · ');
const cap1 = (x) => x ? x[0].toUpperCase() + x.slice(1) : x;
const cmdName = (r) => REVIEW_CMD[r.cmd]?.[0] || r.cmd;
const howLine = (r) => `${cmdName(r)} · ${cap1(r.model)} · esforço ${EFFORT[r.effort] || r.effort}`;
const ICON_LINK = 'inline-flex h-7 shrink-0 items-center justify-center gap-1 px-1.5 t-meta-em text-muted-foreground transition-colors hover:bg-accent hover:text-foreground outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-md:h-11';

function ReviewReport({ open, onClose, r }) {
  const [x, setX] = useState(null);
  useEffect(() => { if (!open || !r) return; setX(null); getJSON(`/api/review/report?id=${encodeURIComponent(r.id)}`).then(setX).catch((e) => setX({ error: e.message })); }, [open, r]);
  return <Sheet open={open} onClose={onClose} wide title={r ? `Relatório de #${r.pr} · ${cmdName(r)}` : ''} description={x?.file || ''}>
    <div className="px-6 py-5 max-md:px-4">
      {!x ? <div className="grid max-w-[70ch] gap-3" aria-busy="true" aria-label="Carregando o relatório">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div> : x.error ? <Empty icon={I.CircleX} title="Não foi possível ler o relatório">
        {x.error}
      </Empty> : !x.text ? <Empty icon={I.FileX} title="Sem relatório">
        A sessão falhou ou não terminou: veja a execução.
      </Empty> : <article className="md max-w-[70ch]" dangerouslySetInnerHTML={{ __html: renderMd(x.text) }} />}
    </div>
  </Sheet>;
}

// rótulo + controle numa linha; o Segmented não recebe aria-label, então o grupo leva o nome
function Opcao({ label, children, hint }) {
  const id = useId();
  return <div role="group" aria-labelledby={id} className="grid gap-1.5">
    <span id={id} className="t-label text-muted-foreground">
      {label}
    </span>
    {children}
    {hint ? <span className="t-meta text-muted-foreground">
      {hint}
    </span> : null}
  </div>;
}

function ComoRevisar({ cmd, setCmd, model, setModel, effort, setEffort, postGh, setPostGh, nums, busy, launch, example }) {
  return <Card className="h-fit xl:sticky xl:top-20" data-tour-step-id="reviews-como">
    <CardHeader title="Como revisar" />
    <CardContent className="grid gap-4">
      <Opcao label="Comando" hint={REVIEW_CMD[cmd][1]}>
        <Segmented value={cmd} onChange={setCmd} className="justify-self-start font-mono" items={Object.entries(REVIEW_CMD).map(([v, [l]]) => ({ value: v, label: l }))} />
      </Opcao>
      <div className="flex flex-wrap gap-x-6 gap-y-4">
        <Opcao label="Modelo" hint="Opus é mais profundo e mais caro; Sonnet, mais rápido.">
          <Segmented value={model} onChange={setModel} items={[{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }]} />
        </Opcao>
        <Opcao label="Esforço" hint="Quanto mais alto, mais a sessão investiga e mais custa.">
          <Segmented value={effort} onChange={setEffort} items={Object.entries(EFFORT).map(([v, l]) => ({ value: v, label: cap1(l) }))} />
        </Opcao>
        <span className="basis-full t-meta text-muted-foreground">Padrões em Configurações → Revisão de PR alheia.</span>
      </div>
      <div className="border-t">
        <Field label="Publicar nas PRs" hint="Um review por PR, só comentário, in-line. Desligado: o relatório fica só aqui.">
          <Switch checked={postGh} onChange={setPostGh} label="Publicar nas PRs" />
        </Field>
      </div>
      <p className="t-body" aria-live="polite">
        {nums.length ? <>
          <Mono className="t-label">{nums.map((n) => '#' + n).join(' ')}</Mono>
          <span className="text-muted-foreground tnum">{` · ${nums.length} de ${MAX_PRS}`}</span>
        </> : <span className="text-muted-foreground">{`Marque até ${MAX_PRS} PRs na lista.`}</span>}
      </p>
      <Button icon={postGh ? I.Send : I.ScanSearch} loading={busy} disabled={!nums.length || example} onClick={launch}>
        {(nums.length ? `Revisar ${plural(nums.length, 'PR', 'PRs')}` : 'Revisar') + (postGh ? ' e publicar' : '')}
      </Button>
    </CardContent>
  </Card>;
}

function EmCurso({ list, openJob }) {
  return <Card data-tour-step-id="reviews-curso">
    <CardHeader title="Em curso" summary={plural(list.length, 'sessão', 'sessões')} />
    <CardContent>
      <ul className="-mt-2">
        {list.map((r) => <li key={r.id} className="grid gap-2 border-b py-3 last:border-b-0">
          <div className="flex items-baseline gap-3">
            <Mono className="shrink-0 t-label">{'#' + r.pr}</Mono>
            <span className="min-w-0 flex-1 truncate t-body">{r.title || howLine(r)}</span>
            <span className="shrink-0 t-meta text-muted-foreground tnum">{'começou ' + ago(r.started)}</span>
          </div>
          <Fio s={r.fase === 'fila' ? 'parado' : 'fiando'} label={`Revisão de #${r.pr}: ${faseDe(r)} desde ${ago(r.fase ? r.faseDesde || r.started : r.started)}`} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 t-meta text-muted-foreground">
            <span className="shrink-0 font-medium text-foreground" data-tour-step-id="reviews-fase">{faseDe(r)}</span>
            <span className="min-w-0 flex-1">{(r.title ? howLine(r) + ' · ' : '') + (r.post ? 'publica ao terminar' : 'só local')}</span>
            {r.job ? <Button variant="ghost" size="xs" icon={I.SquareTerminal} onClick={() => openJob(r.job)}>Ver a execução</Button> : null}
          </div>
        </li>)}
      </ul>
    </CardContent>
  </Card>;
}

// o resultado de uma revisão em uma linha: veredito com forma e contagens, a falha com o motivo, ou interrompida
function Resultado({ r }) {
  const v = VERDICT[r.verdict];
  const VIcon = v?.[2];
  if (r.state === 'falhou') return <span className="flex min-w-0 items-baseline gap-1.5 t-body">
    <I.CircleX className="size-3.5 shrink-0 translate-y-0.5 text-bad" aria-hidden="true" />
    <span className="shrink-0 font-medium text-bad">Falhou</span>
    {r.error ? <Tip text={r.error} className="min-w-0">
      <span className="min-w-0 break-words text-muted-foreground md:truncate">{r.error}</span>
    </Tip> : null}
  </span>;
  if (r.state !== 'ok') return <span className="flex items-baseline gap-1.5 t-body text-muted-foreground">
    <I.CircleSlash className="size-3.5 shrink-0 translate-y-0.5" aria-hidden="true" />
    Interrompida
  </span>;
  const counts = [r.blocking != null ? plural(r.blocking, 'bloqueante', 'bloqueantes') : null, r.important != null ? plural(r.important, 'importante', 'importantes') : null,
    r.inline != null ? `${r.inline} in-line` : null].filter(Boolean);
  return <span className="flex flex-wrap items-baseline gap-x-1.5 t-body">
    {v ? <>
      <VIcon className={cn('size-3.5 shrink-0 translate-y-0.5', v[1])} aria-hidden="true" />
      <span className="text-muted-foreground">Veredito:</span>
      <span className={cn('font-medium', v[1])}>{v[0].toLowerCase()}</span>
    </> : <span className="font-medium">Concluída, sem veredito</span>}
    {counts.length ? <span className="text-muted-foreground tnum">{'· ' + counts.join(' · ')}</span> : null}
  </span>;
}

function Publicacao({ r }) {
  if (r.posted) return <span>comentada no GitHub</span>;
  if (r.post && r.state === 'ok') return <span className="text-warn">
    {'publicação não confirmada (a sessão não confirmou): '}
    {r.url ? <a href={r.url} target="_blank" rel="noopener" className="underline underline-offset-2">confira no GitHub</a> : 'confira no GitHub'}
  </span>;
  return <span>{r.post ? 'publicação pedida' : 'só local'}</span>;
}

function LinhaDoHistorico({ r, onReport, openJob, example }) {
  const meta = [<span>{howLine(r)}</span>, <Publicacao r={r} />, r.costUsd != null ? <span>{usd(r.costUsd)}</span> : null,
    r.durationMs ? <span>{dur(r.durationMs / 1000)}</span> : null, r.tokens ? <Tip text={tokTip(r)}>
      <span className="underline decoration-dotted underline-offset-3">{tok(tokTotal(r.tokens)) + ' tokens'}</span>
    </Tip> : null].filter(Boolean);
  return <li data-tour-step-id="reviews-linha" className="grid gap-x-4 gap-y-1.5 border-b py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto]">
    <div className="grid min-w-0 gap-1">
      <div className="flex min-w-0 items-baseline gap-3">
        <Mono className="shrink-0 t-label">{'#' + r.pr}</Mono>
        {example ? <ExampleSeal /> : null}
        {r.title ? <span className="min-w-0 truncate t-body">{r.title}</span> : null}
        {r.author ? <span className="shrink-0 t-meta text-muted-foreground">{r.author}</span> : null}
        <span className="ml-auto shrink-0 t-meta text-muted-foreground tnum md:hidden">{ago(r.started)}</span>
      </div>
      <Resultado r={r} />
      <div className="flex flex-wrap gap-x-1 t-meta text-muted-foreground tnum">
        {meta.map((m, i) => <React.Fragment key={i}>
          {i ? <span aria-hidden="true">·</span> : null}
          {m}
        </React.Fragment>)}
      </div>
    </div>
    <div className="flex items-center gap-1 max-md:-ml-1.5 md:flex-col md:items-end md:gap-1.5">
      <span className="t-meta text-muted-foreground tnum max-md:hidden">{ago(r.started)}</span>
      <div className="flex flex-wrap items-center gap-0.5">
        {r.report ? <Tip text="Relatório">
          <Button variant="ghost" size="xs" icon={I.FileText} aria-label={`Relatório da revisão de #${r.pr}`} onClick={() => onReport(r)}>
            <span className="md:sr-only">Relatório</span>
          </Button>
        </Tip> : null}
        {r.job ? <Tip text="Execução (log)">
          <Button variant="ghost" size="xs" icon={I.SquareTerminal} aria-label={`Execução da revisão de #${r.pr}`} onClick={() => openJob(r.job)}>
            <span className="md:sr-only">Execução</span>
          </Button>
        </Tip> : null}
        {r.url ? <Tip text="Abrir no GitHub">
          <a href={r.url} target="_blank" rel="noopener" aria-label={`Abrir #${r.pr} no GitHub`} className={ICON_LINK}>
            <I.ExternalLink className="size-4" aria-hidden="true" />
            <span className="md:sr-only">GitHub</span>
          </a>
        </Tip> : null}
      </div>
    </div>
  </li>;
}

function Reviews() {
  const { toast, confirm, openJob } = useApp();
  // tour da página rodando: o histórico vem do exemplo; os padrões e a lista de PRs seguem reais
  const exemplo = useTourPreview('reviews');
  const [real, setReal] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [cmd, setCmd] = useState('review-pr');
  const [model, setModel] = useState(null);
  const [effort, setEffort] = useState(null);
  const [postGh, setPostGh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rep, setRep] = useState(null);
  const x = real && exemplo ? { ...real, items: exemplo.items } : real;
  const load = useCallback(() => getJSON('/api/reviews').then((r) => { setReal(r); setErr(null); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (x && model == null) { setModel(x.defaults.model); setEffort(x.defaults.effort); } }, [x, model]);
  if (!x && err) return <Empty icon={I.CircleX} title="Não foi possível ler as revisões">
    <span className="inline-flex flex-wrap items-baseline gap-x-3">
      {err}
      <Button variant="link" size="xs" className="h-auto px-0" onClick={load}>Tentar de novo</Button>
    </span>
  </Empty>;
  if (!x || model == null) return <Loading />;
  const toggle = (n) => setSel((s) => { const t = new Set(s); t.has(n) ? t.delete(n) : t.size < MAX_PRS && t.add(n); return t; });
  const nums = [...sel].sort((a, b) => a - b);
  const running = x.items.filter((r) => r.state === 'rodando');
  const past = x.items.filter((r) => r.state !== 'rodando');
  const launch = async () => {
    const list = nums.map((n) => '#' + n).join(' ');
    if (!(await confirm({ title: `Revisar ${list}?`, icon: postGh ? I.Send : I.ScanSearch, confirmLabel: postGh ? 'Revisar e publicar' : 'Revisar',
      description: `${REVIEW_CMD[cmd][0]} · ${cap1(model)} · esforço ${EFFORT[effort] || effort}. Uma sessão claude -p por PR, num worktree descartável (sem build nem teste); acima do teto de revisões ao mesmo tempo, as demais esperam na fila.\n\n`
        + (postGh ? 'Publica um review por PR, só comentário (nunca aprova nem pede mudanças), in-line e com resumo.' : 'Não publica: o relatório fica só aqui.') }))) return;
    setBusy(true);
    let ok = 0;
    for (const n of nums) {
      try { await post('/api/action', { action: 'review', cmd, model, effort, post: postGh, pr: n }); ok++; }
      catch (e) { toast({ kind: 'bad', title: `#${n}: não foi possível iniciar`, desc: e.message }); }
    }
    setBusy(false);
    if (ok) { toast({ kind: 'busy', title: `${ok} revis${ok > 1 ? 'ões iniciadas' : 'ão iniciada'}`, desc: 'Acompanhe em Em curso.' }); setSel(new Set()); setTimeout(load, 800); }
  };
  const done = x.items.filter((r) => r.state === 'ok');
  const failed = x.items.filter((r) => r.state === 'falhou').length;
  const cost = done.reduce((a, r) => a + (r.costUsd || 0), 0);
  const tokAll = done.reduce((a, r) => a + (tokTotal(r.tokens) || 0), 0);
  const posted = x.items.filter((r) => r.posted).length;
  return <div className="grid gap-8">
    <LinhaDeEstado main={running.length ? `${plural(running.length, 'revisão rodando', 'revisões rodando')}: ${running.map((r) => '#' + r.pr).join(' ')}` : 'nenhuma revisão rodando'}
      rest={[`${x.items.length} no histórico, ${plural(done.length, 'concluída', 'concluídas')}${failed ? `, ${failed} com falha` : ''}`,
        plural(posted, 'comentada no GitHub', 'comentadas no GitHub'), done.length ? `${usd(cost)} · ${tok(tokAll)} tokens nas últimas 20 concluídas (equivalente em API)` : null]} />
    <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Card data-tour-step-id="reviews-prs">
        <CardHeader title="PRs" summary={`até ${MAX_PRS}`} />
        <CardContent>
          <PrPicker sel={sel} toggle={toggle} applied={new Set()} inSet={new Set()} />
        </CardContent>
      </Card>
      <ComoRevisar cmd={cmd} setCmd={setCmd} model={model} setModel={setModel} effort={effort} setEffort={setEffort}
        postGh={postGh} setPostGh={setPostGh} nums={nums} busy={busy} launch={launch} example={!!exemplo} />
    </div>
    {running.length ? <EmCurso list={running} openJob={openJob} /> : null}
    <Card data-tour-step-id="reviews-historico">
      <CardHeader title="Histórico" summary={past.length ? '20 mais recentes' : undefined} />
      <CardContent>
        {past.length ? <ul className="-mt-2">
          {past.map((r) => <LinhaDoHistorico key={r.id} r={r} onReport={setRep} openJob={openJob} example={!!exemplo} />)}
        </ul> : <Empty icon={I.ScanSearch} title="Nenhuma revisão terminada ainda">
          Marque PRs e clique em Revisar.
        </Empty>}
      </CardContent>
    </Card>
    <ReviewReport open={!!rep} onClose={() => setRep(null)} r={rep} />
  </div>;
}

HadesCore.registerPage('reviews', Reviews);
})();
