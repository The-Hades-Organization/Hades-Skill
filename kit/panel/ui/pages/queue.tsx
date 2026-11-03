/* Página Fila de gates (#/queue): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela.
 * O rio de Caronte: quem espera, quem roda e o que acabou, cada gate um fio; depois a memória da fila, a última hora,
 * o journal e o que roda fora da fila. */
(() => {
const { useState, useEffect, I, cn, GB, gb, mb, dur, getJSON, Button, Card, CardHeader, CardContent, Progress, Tip,
  Empty, Table, Th, Td, Tr, AreaChart, Legend, Segmented, Fio, FIO_ESTADO, LinhaDeEstado, Dot, ago, Loading } = HadesCore;

const kv = (row) => Object.fromEntries(row.slice(6).map((x) => { const i = x.indexOf('='); return i > 0 ? [x.slice(0, i), x.slice(i + 1)] : [x, true]; }));
const secs = (s) => parseFloat(s) || 0;
const DONE_SHOWN = 4;
// 137 (SIGKILL) e 143 (SIGTERM) num gate: o teto de memória (MemoryMax) cortou o processo, não o teste quebrou (gates.md)
const exitText = (rc) => rc === '137' || rc === '143' ? `estourou a memória (${rc})` : `falhou (saída ${rc})`;

// o que acabou: o journal guarda `done` com rc e dur; o corte é a duração sobre a mediana das ok do mesmo gate
function doneGates(journal) {
  const done = journal.filter((r) => r[1] === 'done').map((r) => ({ ts: r[0], kind: r[2], label: r[3], clone: r[5], ...kv(r) }));
  const okDur = (label) => done.filter((x) => x.label === label && x.rc === '0').map((x) => secs(x.dur)).sort((a, b) => a - b);
  return done.slice(-DONE_SHOWN).reverse().map((x) => {
    if (x.rc === '0') return { ...x, fio: { s: 'medido', nos: [0, 100] } };
    const ok = okDur(x.label);
    return { ...x, fio: { s: 'cortado', corte: ok.length ? Math.min(94, Math.max(8, secs(x.dur) / ok[ok.length >> 1] * 100)) : 70 } };
  });
}
const tail = (p) => (p || '').split('/').pop();
const gateMeta = (g) => [g.kind, tail(g.clone), (g.label || '').startsWith('hades-') ? 'Hades' : null, g.machine ? 'fila da máquina' : null].filter(Boolean).join(' · ');

function GateCard({ g }) {
  const running = g.state !== 'waiting';
  const s = running ? 'fiando' : 'frouxo';
  return <li>
    <Card variant="object" className="gap-3">
      <div className="flex items-baseline gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={g.label}>
            {g.label}
          </div>
          <div className="truncate t-meta text-muted-foreground">
            {gateMeta(g)}
          </div>
        </div>
        <span className="shrink-0 t-data text-muted-foreground">
          {dur(running ? g.runningFor : g.age)}
        </span>
      </div>
      <Fio s={s} label={`${g.label}: ${running ? 'rodando há ' + dur(g.runningFor) : 'na fila há ' + dur(g.age)}`} />
      <div className="line-clamp-2 font-mono t-micro break-all text-muted-foreground" title={g.cmd}>
        {g.cmd}
      </div>
      {running ? <div className="flex gap-4 t-meta text-muted-foreground tnum">
        <span>
          {'memória '}
          <b className="font-mono font-medium text-foreground">{mb(g.rss)}</b>
        </span>
        <span>
          {'CPU '}
          <b className="font-mono font-medium text-foreground">{Math.round(g.cpu) + '%'}</b>
        </span>
      </div> : null}
      {g.step ? <div className="grid gap-1.5 border-t pt-3">
        <div className="flex items-baseline justify-between gap-2 t-meta text-muted-foreground">
          <span>passo atual</span>
          <span className="tnum">
            {dur(g.stepAge)}
            {g.stepMedian ? ` de ~${dur(g.stepMedian)}` : ''}
          </span>
        </div>
        <div className="truncate t-data" title={g.step}>
          {g.step}
        </div>
        {g.stepPct != null ? <Progress value={g.stepPct} kind={g.stepPct >= 99 ? 'warn' : 'ok'} /> : null}
      </div> : null}
    </Card>
  </li>;
}
function DoneRow({ x }) {
  const bad = x.rc !== '0';
  return <li className="grid gap-2 border-b py-3 last:border-b-0">
    <div className="flex items-baseline gap-2">
      <span className={cn('min-w-0 flex-1 truncate t-label', bad && 'text-bad')} title={x.cmd || ''}>
        {x.label}
      </span>
      <span className="shrink-0 t-data text-muted-foreground">
        {ago(x.ts)}
      </span>
    </div>
    <Fio s={x.fio.s} nos={x.fio.nos} corte={x.fio.corte} label={`${x.label}: ${FIO_ESTADO[x.fio.s]}`} />
    <span className="truncate t-meta text-muted-foreground">
      {[x.kind, bad ? exitText(x.rc) : 'ok', x.dur ? dur(secs(x.dur)) : null, x.peak ? `pico ${x.peak.replace('MB', ' MB')}` : null].filter(Boolean).join(' · ')}
    </span>
  </li>;
}
function Lane({ title, count, empty, className, children }) {
  return <section className={cn('grid content-start gap-3', className)} aria-label={title}>
    <h3 className="flex items-baseline gap-2 t-label">
      {title}
      <span className="t-data text-muted-foreground">
        {count}
      </span>
    </h3>
    {count ? <ul className="grid gap-3">
      {children}
    </ul> : <p className="t-body text-muted-foreground">
      {empty}
    </p>}
  </section>;
}
function Rio({ running, waiting, done }) {
  return <div className="grid gap-6 lg:grid-cols-3">
    <Lane title="Esperando" count={waiting.length} empty="Ninguém na fila.">
      {waiting.map((g) => <GateCard key={g.pid} g={g} />)}
    </Lane>
    <Lane title="Rodando" count={running.length} empty="Nenhum gate rodando." className="max-lg:order-first">
      {running.map((g) => <GateCard key={g.pid} g={g} />)}
    </Lane>
    <section className="grid content-start gap-3" aria-label="Concluídos">
      <h3 className="t-label">
        Concluídos
      </h3>
      {done.length ? <ul className="-mt-3">
        {done.map((x, i) => <DoneRow key={x.ts + i} x={x} />)}
      </ul> : <p className="t-body text-muted-foreground">Nada concluído ainda.</p>}
    </section>
  </div>;
}
function Lista({ gates }) {
  return <Table>
    <thead>
      <tr className="border-b">
        <Th>Gate</Th>
        <Th>Estado</Th>
        <Th className="text-right">Tempo</Th>
        <Th className="text-right">Memória</Th>
        <Th className="text-right">CPU</Th>
        <Th>Passo</Th>
      </tr>
    </thead>
    <tbody>
      {gates.map((g) => { const running = g.state !== 'waiting'; return <Tr key={g.pid}>
        <Td>
          <div className="max-w-72">
            <div className="truncate font-medium" title={g.label}>{g.label}</div>
            <div className="truncate t-meta text-muted-foreground">{gateMeta(g)}</div>
          </div>
        </Td>
        <Td className={running ? '' : 'text-muted-foreground'}>{running ? 'rodando' : 'na fila'}</Td>
        <Td className="text-right t-data">{dur(running ? g.runningFor : g.age)}</Td>
        <Td className="text-right t-data">{running ? mb(g.rss) : '—'}</Td>
        <Td className="text-right t-data">{running ? Math.round(g.cpu) + '%' : '—'}</Td>
        <Td className="max-w-64 truncate t-data text-muted-foreground" title={g.step || ''}>{g.step || '—'}</Td>
      </Tr>; })}
    </tbody>
  </Table>;
}
function MemoryMeter({ x }) {
  const h = x.host || {}, total = h.memTotal || 1;
  const gates = x.gates.filter((g) => g.state === 'running').reduce((a, g) => a + (g.rss || 0), 0);
  const infra = h.infraRss || 0, left = h.leftoverRss || 0;
  const used = Math.max(0, total - (h.memAvailable || 0));
  const other = Math.max(0, used - gates - infra - left);
  const segs = [['Gates', gates, 'var(--s1)'], ['Infra (containers, daemons)', infra, 'var(--s2)'], ['Sobra de gate (processos que ficaram após o fim)', left, 'var(--s4)'], ['Resto da máquina', other, 'var(--border-strong)']];
  const reserve = (x.budget?.reserveGb || 2) * GB;
  // a largura vai no invólucro do Tip (o item do flex): num filho dele o % seria do span e o segmento colapsava em 2 px
  return <div className="grid gap-2">
    <div className="relative flex h-3 gap-px overflow-hidden bg-muted">
      {segs.map(([n, v, c]) => v > 0 ? <Tip key={n} text={`${n}: ${mb(v)}`} className="h-3 shrink-0 transition-[width] duration-700" style={{ width: (v / total * 100) + '%', minWidth: 2 }}>
        <div className="h-3 w-full" style={{ background: c }} />
      </Tip> : null)}
      <div className="absolute inset-y-0 w-0.5 bg-foreground" style={{ right: (reserve / total * 100) + '%' }} title="reserva de memória que a fila exige para admitir gates" />
    </div>
    <div className="flex flex-wrap gap-x-4 gap-y-1 t-meta text-muted-foreground">
      {segs.map(([n, v, c]) => <span key={n} className="inline-flex items-center gap-1.5">
        <span className="h-0.5 w-3 shrink-0" style={{ background: c }} />
        {n}
        <b className="font-mono font-medium text-foreground tnum">
          {mb(v)}
        </b>
      </span>)}
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-0.5 bg-foreground" />
        {'reserva ' + gb(reserve) + ' (traço claro na barra)'}
      </span>
    </div>
  </div>;
}
function Raw({ x }) {
  return <Card data-tour-step-id="queue-sem-amostrador">
    <CardHeader title="Fila do gate-lock" summary="Amostrador da fila indisponível; mostrando os tickets do gate-lock" />
    <CardContent>
      {x.gates.length ? <ul>
        {x.gates.map((g, i) => <li key={i} className="grid gap-2 border-b py-3 t-body last:border-0">
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{g.label}</span>
            <span className="text-muted-foreground">{[g.state === 'running' ? 'rodando' : 'na fila', g.kind, `${g.cost} GB`, g.machine ? 'fila da máquina' : null].filter(Boolean).join(' · ')}</span>
          </div>
          <Fio s={g.state === 'running' ? 'fiando' : 'frouxo'} label={`${g.label}: ${g.state === 'running' ? 'rodando' : 'na fila'}`} />
        </li>)}
      </ul> : <Empty icon={I.CircleCheckBig} title="Fila vazia" />}
    </CardContent>
  </Card>;
}

const EV = { enqueue: [I.ListPlus, 'entrou', ''], admit: [I.Play, 'admitido', ''], start: [I.Play, 'começou', ''], done: [I.CircleCheck, 'concluído', ''],
  timeout: [I.TimerOff, 'estourou o tempo', 'text-warn'], abort: [I.OctagonX, 'abortado', 'text-bad'] };
function Journal({ journal }) {
  const [showAll, setShowAll] = useState(false);
  return <Card data-tour-step-id="queue-historico">
    <CardHeader title="Histórico da fila" summary="mais recente primeiro" action={<Button size="xs" variant="ghost" onClick={() => setShowAll(!showAll)}>
      {showAll ? 'Mostrar 15' : 'Mostrar 60'}
    </Button>} />
    <CardContent>
      <Table className="max-h-[480px] overflow-y-auto">
        <thead className="sticky top-0 bg-background">
          <tr className="border-b">
            <Th>Hora</Th>
            <Th>Evento</Th>
            <Th>Gate</Th>
            <Th className="text-right">Reserva (GB)</Th>
            <Th>Resultado</Th>
          </tr>
        </thead>
        <tbody>
          {journal.slice(0, showAll ? 60 : 15).map((r, i) => { const [ts, ev, kind, label, cost, clone] = r; const e = kv(r);
            const bad = ev === 'done' && e.rc && e.rc !== '0';
            const [Ic, l, tone] = bad ? [I.CircleX, 'falhou', 'text-bad'] : EV[ev] || [I.Dot, ev, ''];
            return <Tr key={i}>
              <Td className="t-data text-muted-foreground">
                {new Date(ts).toLocaleTimeString('pt-BR')}
              </Td>
              <Td>
                <span className={cn('inline-flex items-center gap-1.5 t-meta', tone || 'text-muted-foreground')}>
                  <Ic className="size-3.5" aria-hidden="true" />
                  {l}
                </span>
              </Td>
              <Td>
                <div className="max-w-72">
                  <div className="truncate font-medium" title={label}>
                    {label}
                  </div>
                  <div className="truncate t-meta text-muted-foreground" title={e.cmd || ''}>
                    {kind + ' · ' + tail(clone)}
                  </div>
                </div>
              </Td>
              <Td className="text-right t-data">
                {cost}
              </Td>
              <Td>
                {ev === 'done' ? <span className={cn('t-data', bad ? 'text-bad' : 'text-muted-foreground')}>
                  {`${bad ? exitText(e.rc) : 'ok'} · ${e.dur || ''}`}
                </span> : <span className="t-meta text-muted-foreground">
                  {e.waited ? 'esperou ' + e.waited : ''}
                </span>}
              </Td>
            </Tr>; })}
        </tbody>
      </Table>
    </CardContent>
  </Card>;
}
function Recent({ recent }) {
  return <Card data-tour-step-id="queue-sequencias">
    <CardHeader title="Sequências recentes" summary="lint → build → teste" />
    <CardContent>
      {recent.length ? <ul className="-mt-2">
        {recent.slice(0, 6).map((r, i) => <li key={i} className="border-b last:border-0">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 py-2.5 t-body outline-none hover:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
              <Dot kind={r.failed?.length ? 'bad' : r.done ? 'ok' : 'busy'} />
              <span className={cn('min-w-0 flex-1 truncate font-medium', r.failed?.length && 'text-bad')}>
                {r.path.split('/')[0]}
              </span>
              <span className="t-meta text-muted-foreground tnum">
                {`${r.steps} passos · ${ago(r.mtime)}`}
              </span>
              <I.ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="grid gap-1 pb-3 pl-4 font-mono t-micro break-all">
              {(r.failed || []).map((f, j) => <div key={j} className="text-bad">
                {'✗ ' + f}
              </div>)}
              <div className="text-muted-foreground">
                {'último: ' + r.last}
              </div>
            </div>
          </details>
        </li>)}
      </ul> : <Empty icon={I.ClipboardList} title="Sem resumos recentes" />}
    </CardContent>
  </Card>;
}
function Bypass({ bypass }) {
  return <Card data-tour-step-id="queue-fora">
    <CardHeader title="Fora da fila" summary={`${bypass.length} processo${bypass.length > 1 ? 's' : ''} sem gate-lock`}
      description="Furam a conta de memória dos gates. Para entrar na conta, rode pelo gate-lock: gate-lock.sh run <tipo> --label <agente> -- <comando>." />
    <CardContent>
      <ul className="grid gap-2">
        {bypass.map((p) => <li key={p.pid}>
          <Card variant="object" className="gap-1 border-bad/40 p-3 t-meta">
            <div className="flex justify-between gap-2">
              <b className="font-medium">{'pid ' + p.pid}</b>
              <span className="font-mono tnum">{`${mb(p.rss)} · ${Math.round(p.cpu)}%`}</span>
            </div>
            <div className="truncate font-mono text-muted-foreground" title={p.cmd}>
              {p.cmd}
            </div>
          </Card>
        </li>)}
      </ul>
    </CardContent>
  </Card>;
}
function Locks({ locks }) {
  return <Card data-tour-step-id="queue-locks">
    <CardHeader title="Locks do loop" summary="entregas e revisões" action={<a href="#/loop" className="inline-flex items-center gap-1 t-meta text-muted-foreground hover:text-foreground hover:underline">
      Loop
      <I.ArrowUpRight className="size-3" aria-hidden="true" />
    </a>} />
    <CardContent>
      <ul className="-mt-2">
        {locks.slice(0, 8).map((l) => <li key={l.name} className="flex items-center gap-2 border-b py-2 t-body last:border-0">
          <Dot kind={l.agentPresent ? 'ok' : 'idle'} />
          <span className="min-w-0 flex-1 truncate">
            {l.name}
          </span>
          <span className="t-meta text-muted-foreground">
            {(l.agentPresent ? 'com agente' : 'sem agente') + (l.age ? ' · ' + dur(l.age) : '')}
          </span>
        </li>)}
      </ul>
    </CardContent>
  </Card>;
}

function Queue() {
  const [x, setX] = useState(null);
  const [view, setView] = useState('rio');
  useEffect(() => {
    let alive = true;
    const f = () => getJSON('/api/gates').then((r) => alive && setX(r)).catch(() => {});
    f(); const t = setInterval(f, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!x) return <Loading />;
  if (!x.available) return <Raw x={x} />;
  const running = x.gates.filter((g) => g.state !== 'waiting'), waiting = x.gates.filter((g) => g.state === 'waiting');
  const gateMem = running.reduce((a, g) => a + (g.rss || 0), 0);
  const reserveGb = x.budget?.reserveGb || 2;
  const low = (x.host.memAvailable || 0) < (reserveGb + 2) * GB;
  const oldest = waiting.length ? Math.max(...waiting.map((g) => g.age || 0)) : 0;
  const journal = [...x.journal].reverse();
  const done = doneGates(x.journal);
  const qSeries = [{ name: 'Rodando', color: 'var(--s1)', get: (p) => p.running, step: true }, { name: 'Esperando', color: 'var(--warn)', get: (p) => p.waiting, step: true, dash: true, fill: false }];
  const mSeries = [{ name: 'Memória dos gates', color: 'var(--s1)', get: (p) => p.gateRss / GB }, { name: 'Livre na máquina', color: 'var(--s2)', get: (p) => p.avail / GB, fill: false }];
  return <div className="grid gap-8">
    <div data-tour-step-id="queue-estado">
    <LinhaDeEstado main={running.length ? `${running.length} rodando` : 'nada rodando'}
      rest={[waiting.length ? `${waiting.length} esperando, o mais antigo há ${dur(oldest)}` : 'ninguém na fila',
        `gates usam ${gb(gateMem)}` + (x.budget?.budgetGb ? ` de ${x.budget.budgetGb} GB de orçamento` : ''),
        <span key="livre" className={cn(low && 'text-bad')}>{`livre ${gb(x.host.memAvailable)} · reserva ${reserveGb} GB` + (low ? ' · abaixo do mínimo para admitir gates' : '')}</span>,
        `carga ${(x.host.load || [0])[0].toFixed(1).replace('.', ',')} (média de 1 min)`]} />
    </div>
    <Card data-tour-step-id="queue-fila">
      <CardHeader title="Fila agora" description="gate = checagem pesada antes da PR: build, lint, testes"
        action={<span data-tour-step-id="queue-visao"><Segmented value={view} onChange={setView} items={[{ value: 'rio', label: 'Rio' }, { value: 'lista', label: 'Lista', count: x.gates.length }]} /></span>} />
      <CardContent>
        {view === 'lista' ? x.gates.length ? <Lista gates={[...running, ...waiting]} /> : <Empty icon={I.CircleCheckBig} title="Fila vazia" />
          : <Rio running={running} waiting={waiting} done={done} />}
      </CardContent>
    </Card>
    <Card data-tour-step-id="queue-memoria">
      <CardHeader title="Memória da máquina" summary={`livre ${gb(x.host.memAvailable)} de ${gb(x.host.memTotal)}${x.host.swapUsed ? ` · swap ${gb(x.host.swapUsed)}` : ''}`} />
      <CardContent>
        <MemoryMeter x={x} />
      </CardContent>
    </Card>
    <div className="grid gap-8 xl:grid-cols-2">
      <Card data-tour-step-id="queue-grafico">
        <CardHeader title="Gates simultâneos" summary="última hora" />
        <CardContent className="grid gap-3">
          <Legend items={qSeries} />
          <AreaChart points={x.history} series={qSeries} yFmt={(v) => Math.round(v)} height={200} label="Gates simultâneos" />
        </CardContent>
      </Card>
      <Card data-tour-step-id="queue-grafico-memoria">
        <CardHeader title="Memória da fila" summary="GB" />
        <CardContent className="grid gap-3">
          <Legend items={mSeries} />
          <AreaChart points={x.history} series={mSeries} yFmt={(v) => v.toFixed(0)} height={200} label="Memória da fila" />
        </CardContent>
      </Card>
    </div>
    <div className="grid gap-8 xl:grid-cols-[1.6fr_1fr]">
      <Journal journal={journal} />
      <div className="grid content-start gap-8">
        {x.bypass.length ? <Bypass bypass={x.bypass} /> : null}
        <Recent recent={x.recent} />
        {x.locks.length ? <Locks locks={x.locks} /> : null}
      </div>
    </div>
  </div>;
}

HadesCore.registerPage('queue', Queue);
})();
