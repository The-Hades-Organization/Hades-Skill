/* Página Loop (#/loop): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela.
 * Escalações ao dono primeiro; depois as PRs mexidas como fios (um nó por rodada de review), as ações das últimas 24 h,
 * as sessões vivas e os locks. */
(() => {
const { useState, useEffect, I, cn, mb, dur, getJSON, Dot, Card, CardHeader, CardContent, Mono, Tip, Empty, Table, Th,
  Td, Tr, Legend, Fio, LinhaDeEstado, Loading, CopyButton, useTourPreview, ExampleSeal } = HadesCore;

const VERDICT = { fixed: ['Corrigido', 'var(--s2)'], applied: ['Aplicado', 'var(--s2)'], rebutted: ['Refutado', 'var(--s4)'],
  indeterminate: ['Indeterminado', 'var(--s3)'], escalated: ['Escalado', 'var(--warn)'], 'stale-fixed': ['Já corrigido', 'var(--s1)'],
  informative: ['Informativo', 'var(--muted-foreground)'], read: ['Lido', 'var(--muted-foreground)'] };
const verdictOf = (k) => VERDICT[k] || [k, 'var(--muted-foreground)'];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// os nós da PR: uma rodada de review cada, espalhadas no fio; com bloqueante aberto o fio fica frouxo (espera correção)
// veredito cru da revisão local, na mesma palavra de Revisões
const VEREDITO_PR = { red: 'Bloqueia', yellow: 'Pede ajustes', green: 'Aprova' };
const DELIVERY_STATE = { 'in-progress': 'em andamento', open: 'com PR aberta' };
const roundKnots = (n) => Array.from({ length: n || 0 }, (_, i) => n === 1 ? 50 : Math.round(i / (n - 1) * 100));

function Escalacoes({ list, since, example }) {
  return <Card data-tour-step-id="loop-escalacoes">
    <CardHeader title="Escalações abertas" summary={list.length ? 'responda na página Claude, com /hades answer <id>' : '0 · tudo respondido'} />
    {list.length ? <CardContent>
      <ul className="-mt-2">
        {list.map((e) => <li key={e.id} className="grid gap-1 border-b py-3 last:border-b-0">
          <div className="flex flex-wrap items-baseline gap-x-3 t-meta text-muted-foreground">
            {example ? <ExampleSeal /> : null}
            {e.pr ? <Mono className="text-foreground">{'#' + e.pr}</Mono> : null}
            <Mono>{e.id}</Mono>
            <span className="ml-auto tnum">{'há ' + since(e.askedAt)}</span>
            <CopyButton text={`/hades answer ${e.id}`} label={`Copiar /hades answer ${e.id}`} />
          </div>
          <span className="max-w-[70ch] t-body">
            {e.why}
          </span>
        </li>)}
      </ul>
    </CardContent> : null}
  </Card>;
}

function Prs({ prs, ago, example }) {
  return <Card data-tour-step-id="loop-prs">
    <CardHeader title="PRs com atividade recente" summary="48 h · um nó por rodada de review" />
    <CardContent>
      {prs.length ? <ul className="-mt-2">
        {prs.map((p) => { const waiting = (p.blocking || 0) > 0; return <li key={p.pr} className="grid gap-2 border-b py-3 last:border-b-0 md:grid-cols-[6rem_1fr_16rem] md:items-center md:gap-4">
          <span className="flex items-center gap-2">
            <Mono className="t-body">{'#' + p.pr}</Mono>
            {example ? <ExampleSeal /> : null}
          </span>
          <Fio s={waiting ? 'frouxo' : 'medido'} nos={roundKnots(p.rounds)} label={`PR ${p.pr}: ${plural(p.rounds || 0, 'rodada', 'rodadas')} de review${waiting ? `, ${p.blocking} bloqueante` : ''}`} />
          <span className="flex flex-wrap gap-x-2 t-meta text-muted-foreground md:justify-end">
            <span className={cn(waiting && 'font-medium text-warn')}>
              {waiting ? plural(p.blocking, 'bloqueante', 'bloqueantes') : VEREDITO_PR[p.review] || p.review || 'sem revisão local'}
            </span>
            <span className="tnum">{plural(p.rounds ?? 0, 'rodada', 'rodadas') + ' · há ' + ago(p.last)}</span>
          </span>
        </li>; })}
      </ul> : <Empty icon={I.GitPullRequest} title="Nenhuma PR mexida nas últimas 48 h" />}
    </CardContent>
  </Card>;
}

function Acoes({ hours, verdicts, actions, hourTotal, example }) {
  const peak = Math.max(1, ...hours.map(hourTotal));
  const legend = Object.entries(verdicts).map(([k, n]) => { const [l, c] = verdictOf(k); return { name: `${l} ${n}`, color: c }; });
  return <Card data-tour-step-id="loop-acoes">
    <CardHeader title="Comentários de review tratados em 24 h" summary={`${plural(actions, 'ação', 'ações')} em 24 h${example ? ' · exemplo' : ''}`} />
    <CardContent className="grid gap-3">
      <div className="flex h-24 items-end gap-px border-b border-border-strong">
        {[...hours].reverse().map((h) => { const n = hourTotal(h); return <Tip key={h.hoursAgo} text={`há ${h.hoursAgo} h: ${plural(n, 'ação', 'ações')}`} className="h-full min-w-0 flex-1 items-end">
          <div className={cn('w-full transition-[height] duration-700', n ? 'bg-metal-ink' : 'bg-border')} style={{ height: n ? `${Math.max(6, n / peak * 100)}%` : '1px' }} />
        </Tip>; })}
      </div>
      <div className="flex justify-between font-mono t-micro text-muted-foreground tnum">
        <span>-24 h</span>
        <span>agora</span>
      </div>
      {legend.length ? <Legend items={legend} /> : <p className="t-meta text-muted-foreground">Nenhuma ação nas últimas 24 h.</p>}
    </CardContent>
  </Card>;
}

function Loop() {
  const [real, setReal] = useState(null);
  // tour da página rodando: a página lê os dados de exemplo no lugar dos reais
  const exemplo = useTourPreview('loop');
  const x = exemplo ?? real;
  useEffect(() => {
    let alive = true;
    const f = () => getJSON('/api/gates').then((r) => alive && setReal(r)).catch(() => {});
    f(); const t = setInterval(f, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!x) return <Loading />;
  if (!x.available) return <Empty icon={I.Repeat} title="Estado do loop indisponível">
    Não achei o diretório de locks (variável LOCKS do env.sh).
  </Empty>;
  const L = x.loop || {}, now = Date.now() / 1000;
  const hours = L.actionsByHour || [];
  const hourTotal = (h) => Object.entries(h).reduce((a, [k, v]) => k === 'hoursAgo' ? a : a + v, 0);
  const actions = hours.reduce((a, h) => a + hourTotal(h), 0);
  const dels = Object.entries(L.deliveries || {}), agents = x.agents || [], locks = x.locks || [];
  const ago = (t) => t ? dur(now - t) : '—';
  const since = (s) => s ? ago(Date.parse(s) / 1000) : '—';
  const esc = L.escalations || [];
  return <div className="grid gap-8">
    <LinhaDeEstado main={esc.length ? plural(esc.length, 'escalação esperando você', 'escalações esperando você') : 'nenhuma escalação aberta'}
      rest={[`${plural(actions, 'ação', 'ações')} em 24 h`, dels.length ? dels.map(([k, n]) => `${n} ${DELIVERY_STATE[k] || k}`).join(' · ') : 'nenhuma entrega registrada',
        `${plural(agents.length, 'sessão viva', 'sessões vivas')}, ${plural(locks.length, 'lock', 'locks')}`]} />
    <Escalacoes list={esc} since={since} example={!!exemplo} />
    <div className="grid items-start gap-8 xl:grid-cols-[3fr_2fr]">
      <Prs prs={L.recentPrs || []} ago={ago} example={!!exemplo} />
      <Acoes hours={hours} verdicts={L.verdicts24h || {}} actions={actions} hourTotal={hourTotal} example={!!exemplo} />
    </div>
    <div className="grid items-start gap-8 xl:grid-cols-2">
      <Card className="min-w-0" data-tour-step-id="loop-sessoes">
        <CardHeader title="Sessões vivas" summary="Claude Code" />
        <CardContent>
          {agents.length ? <Table>
            <thead>
              <tr className="border-b">
                <Th>Clone</Th>
                <Th className="text-right">Há</Th>
                <Th className="text-right">Memória</Th>
                <Th>Em posse (gates e locks)</Th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => <Tr key={a.pid}>
                <Td className="max-w-64">
                  <Mono className="block truncate">{a.cwd}</Mono>
                  {exemplo ? <ExampleSeal /> : null}
                </Td>
                <Td className="text-right text-muted-foreground tnum">{dur(a.age)}</Td>
                <Td className="text-right t-data">{mb(a.rss)}</Td>
                <Td className="max-w-56 truncate t-data text-muted-foreground">
                  {[...(a.gates || []), ...(a.locks || [])].join(' · ') || '—'}
                </Td>
              </Tr>)}
            </tbody>
          </Table> : <Empty icon={I.Bot} title="Nenhuma sessão viva" />}
        </CardContent>
      </Card>
      <Card className="min-w-0" data-tour-step-id="loop-locks">
        <CardHeader title="Locks de PR e deliver" summary="libere com /hades locks" />
        <CardContent>
          {locks.length ? <ul className="-mt-2">
            {locks.map((l) => <li key={l.name} className="flex items-center gap-2 border-b py-2.5 t-body last:border-b-0">
              <Dot kind={l.agentPresent ? 'ok' : 'warn'} />
              {exemplo ? <ExampleSeal /> : null}
              <Mono className="min-w-0 truncate">{l.name}</Mono>
              <span className="t-meta text-muted-foreground">{l.mode}</span>
              {l.agentPresent ? null : <CopyButton text="/hades locks" label="Copiar /hades locks para liberar" />}
              <span className={cn('ml-auto shrink-0 t-meta', l.agentPresent ? 'text-muted-foreground' : 'text-warn')}>
                {(l.agentPresent ? '' : 'sem agente: provável lock preso · ') + 'há ' + dur(l.age)}
              </span>
            </li>)}
          </ul> : <Empty icon={I.LockOpen} title="Nenhum lock" />}
        </CardContent>
      </Card>
    </div>
  </div>;
}

HadesCore.registerPage('loop', Loop);
})();
