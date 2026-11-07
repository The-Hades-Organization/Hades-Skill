/* Página Consumo (#/usage): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela. */
(() => {
const { useState, useEffect, I, cn, dur, getJSON, ErroExplicado, Button, CARD_SCROLL, Card, CardHeader, CardContent, Mono, Tip, Empty,
  Table, Th, Td, Tr, Legend, Dot, Regua, Leitura, LinhaDeEstado, useActions, Loading, niceTicksCovering } = HadesCore;

// ================================================================== consumo de tokens
const ROLE_LABEL = { impl: 'Implementação', spec: 'Spec', consolidate: 'Consolidação', review: 'Revisão', orchestrator: 'Orquestrador',
  interactive: 'Interativa', 'agente-nao-registrado': 'Agente não registrado' };
const roleLabel = (r) => { const [k, sub] = r.split(' · '); return (ROLE_LABEL[k] || k) + (sub ? ' · subagentes' : ''); };
const usd = (v) => v == null ? '—' : 'US$ ' + Math.round(v).toLocaleString('pt-BR');
const ktok = (v) => v == null ? '—' : Math.round(v / 1000) + 'k';
const ddmm = (day) => day.slice(8, 10) + '/' + day.slice(5, 7);
// tokens em ordem de grandeza legível: 1,8 bi · 38 mi · 870 mil
const tok = (v) => v >= 1e9 ? (v / 1e9).toFixed(1).replace('.', ',') + ' bi' : v >= 1e6 ? Math.round(v / 1e6) + ' mi' : Math.round(v / 1e3) + ' mil';
const CTX_LIMIT = 200000, POLL_LIMIT = 5, REWRITE_LIMIT = 20;

// medidor da régua: a barra é o valor, o traço é a referência (linha de base, limite); passou dela, a barra muda de tom
function Medidor({ value, mark, warn, label }) {
  const max = Math.max(value, mark ?? 0) * 1.15 || 1;
  const at = (v) => `${Math.min(100, 100 * v / max)}%`;
  return <div className="relative h-3" role="img" aria-label={label}>
    <div className="absolute inset-x-0 top-1 h-1 bg-border" />
    <div className={cn('absolute top-1 left-0 h-1', warn ? 'bg-warn' : 'bg-foreground/70')} style={{ width: at(value) }} />
    {mark != null ? <div className="absolute top-0 h-3 w-px bg-foreground" style={{ left: at(mark) }} /> : null}
  </div>;
}

// colunas com escala: custo útil embaixo, polling em cima, separados pelo vão de 2 px; rótulo direto só no maior dia e em hoje
function PorDia({ days }) {
  const max = Math.max(1e-6, ...days.map((y) => y.cost));
  const ticks = niceTicksCovering(max, 3), top = ticks.at(-1);
  const h = (v) => `${100 * v / top}%`;
  const peak = days.reduce((a, y, i) => y.cost > days[a].cost ? i : a, 0);
  const today = new Date().toISOString().slice(0, 10);
  const every = Math.ceil(days.length / 8);
  return <div className="grid gap-3">
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
      <div className="relative h-40 w-14 text-right t-micro text-muted-foreground tnum" aria-hidden="true">
        {ticks.map((v) => <span key={v} className="absolute right-0 translate-y-1/2 whitespace-nowrap" style={{ bottom: h(v) }}>
          {usd(v)}
        </span>)}
      </div>
      <div className="relative h-40">
        {ticks.map((v) => <div key={v} className={cn('absolute inset-x-0 h-px', v ? 'bg-border' : 'bg-border-strong')} style={{ bottom: h(v) }} />)}
        <div className="absolute inset-0 flex">
          {days.map((y, i) => { const useful = y.cost - y.pollCost; const label = `${y.day === today ? 'hoje' : ddmm(y.day)}: ${usd(y.cost)}, polling ${usd(y.pollCost)}`;
            return <Tip key={y.day} text={label} className="relative h-full min-w-0 flex-1 justify-center">
              <span tabIndex={0} aria-label={label} className="relative h-full w-full max-w-6 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                <span className="absolute inset-x-0 bottom-0 bg-metal-ink" style={{ height: h(useful) }} />
                {y.pollCost > 0 ? <span className="absolute inset-x-0 bg-warn" style={{ bottom: `calc(${h(useful)} + 2px)`, height: h(y.pollCost) }} /> : null}
                {i === peak || i === days.length - 1 ? <span aria-hidden="true" className="absolute left-1/2 -translate-x-1/2 t-micro whitespace-nowrap text-muted-foreground tnum" style={{ bottom: `calc(${h(y.cost)} + 4px)` }}>
                  {usd(y.cost)}
                </span> : null}
              </span>
            </Tip>; })}
        </div>
      </div>
      <span />
      <div className="mt-1.5 flex t-micro text-muted-foreground tnum" aria-hidden="true">
        {days.map((y, i) => <span key={y.day} className="min-w-0 flex-1 text-center whitespace-nowrap">
          {i % every === 0 || i === days.length - 1 ? (y.day === today ? 'hoje' : ddmm(y.day)) : ''}
        </span>)}
      </div>
    </div>
    <Legend items={[{ name: 'Custo', color: 'var(--metal-ink)' }, { name: 'Polling', color: 'var(--warn)' }]} />
  </div>;
}

// ================================================================== janelas do plano (% medido, hades usage sample)
const pct1 = (v) => v == null ? '—' : String(Math.round(v * 10) / 10).replace('.', ',') + '%';
// estimado (calibrado por tokens): `~`, e `+` quando a calibração cobre só parte dos modelos; sem calibração, traço
const pctEst = (v, parcial) => v == null ? '—' : '~' + pct1(v) + (parcial ? '+' : '');
const AVISO_PCT = 80;
function JanelasDoPlano() {
  const [x, setX] = useState(null);
  useEffect(() => {
    let alive = true;
    // falha de leitura não é estado para mostrar: a seção só some, o resto da página segue
    const f = () => getJSON('/api/limits').then((r) => alive && setX(r)).catch(() => {});
    f(); const t = setInterval(f, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!x) return null;
  if (!x.coleta) return <Card data-tour-step-id="usage-janelas">
    <CardHeader title="Janelas do plano" summary="sem amostras" />
    <CardContent>
      <p className="t-body text-muted-foreground">
        Sem medida do % das janelas de 5 h e semanal. Para medir, ponha <Mono>hades usage sample</Mono> no <Mono>statusLine</Mono> do Claude Code (passo seu; a Hades não altera o settings.json). Passo a passo em <a className="underline underline-offset-3 hover:no-underline" href="#/docs">reference/limites.md</a>.
      </p>
    </CardContent>
  </Card>;
  return <Card data-tour-step-id="usage-janelas">
    <CardHeader title="Janelas do plano" summary="% usado, medido pelo Claude Code" />
    <CardContent className="grid gap-5 sm:grid-cols-2">
      {x.janelas.map((j) => <div key={j.janela} className="grid gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="t-label">{j.rotulo}</span>
          <span className={cn('t-section tnum', j.pct >= AVISO_PCT && 'text-warn')}>{pct1(j.pct)}</span>
        </div>
        <div className="h-1.5 bg-border" role="img" aria-label={`${j.rotulo}: ${pct1(j.pct)} usado`}>
          <div className={cn('h-full', j.pct >= AVISO_PCT ? 'bg-warn' : 'bg-foreground/70')} style={{ width: `${Math.min(100, j.pct)}%` }} />
        </div>
        <span className="t-meta text-muted-foreground tnum">renova {j.renova} · medido há {dur(j.idadeS)}</span>
      </div>)}
    </CardContent>
  </Card>;
}

// ================================================================== Moirai: estimado × real
const usd2 = (v) => v == null ? '—' : 'US$ ' + v.toFixed(2).replace('.', ',');
const LEVEL_UI = { ok: ['dentro do estimado', 'text-muted-foreground', 'bg-ok'], warn: ['passou do p75', 'text-warn', 'bg-warn'], ask: ['passou muito do p75', 'text-bad', 'bg-bad'] };
/** Faixa p25–p75 (banda), mediana (traço) e o real (marcador na cor do limiar), na mesma escala. */
function RangeBar({ unit }) {
  const e = unit.estimate, r = unit.real;
  if (!e || e.costP75 == null) return <span className="t-meta text-muted-foreground">sem estimativa</span>;
  const top = Math.max(e.costP75 * 1.5, r?.costUsd ?? 0) || 1;
  const at = (v) => `${Math.min(100, 100 * v / top)}%`;
  const [label, , color] = LEVEL_UI[unit.level] || LEVEL_UI.ok;
  return <div className="relative h-4 w-full min-w-28" role="img"
    aria-label={`${unit.unit}: estimado ${usd2(e.costP25)} a ${usd2(e.costP75)}, real ${usd2(r?.costUsd)}, ${label}`}>
    <div className="absolute inset-x-0 top-1/2 h-px bg-border-strong" />
    <div className="absolute top-1 h-2 bg-foreground/20" style={{ left: at(e.costP25 ?? 0), width: `${Math.max(1, (100 * (e.costP75 - (e.costP25 ?? 0))) / top)}%` }} />
    {e.costMedian != null ? <div className="absolute top-0.5 h-3 w-px bg-foreground" style={{ left: at(e.costMedian) }} /> : null}
    {r ? <div className={cn('absolute inset-y-0 w-1 -translate-x-1/2', color)} style={{ left: at(r.costUsd) }} /> : null}
  </div>;
}
function Estimated() {
  const [x, setX] = useState(null);
  useEffect(() => {
    let alive = true;
    // sem plano da Moirai a seção simplesmente não aparece: falha de leitura não é estado para mostrar aqui
    const f = () => getJSON('/api/moirai/plan').then((r) => alive && setX(r)).catch(() => {});
    f(); const t = setInterval(f, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const plans = (x?.plans || []).filter((p) => p.units.length);
  if (!plans.length) return null;
  return <Card data-tour-step-id="usage-estimado">
    <CardHeader title="Estimado × real" summary="faixa provável (p25–p75) por unidade"
      description={`Traço = mediana, marcador = custo real. Avisa acima de ${x.warnPct}% do p75; acima de ${x.askPct}% o orquestrador para e pergunta ao dono.`} />
    <CardContent className={cn('grid gap-6', CARD_SCROLL)}>
      {plans.map((p) => <div key={p.registry} className="grid gap-1">
        <p className="flex flex-wrap items-baseline gap-x-2 t-meta text-muted-foreground">
          <span className="font-medium text-foreground">
            {p.registry}
          </span>
          <Mono>
            {p.path.split('/').pop()}
          </Mono>
          {p.approved ? null : <span className="text-warn">plano alterado após a aprovação</span>}
        </p>
        <Table>
          <thead>
            <tr className="border-b">
              <Th className="pl-0">Unidade</Th>
              <Th className="w-1/3">Faixa e real</Th>
              <Th className="text-right">Estimado p25–p75</Th>
              <Th className="text-right">Real</Th>
              <Th className="pr-0 text-right">% do p75</Th>
            </tr>
          </thead>
          <tbody>
            {p.units.map((u) => { const [label, tone] = LEVEL_UI[u.level] || LEVEL_UI.ok; const vivo = u.real?.state === 'working';
              return <Tr key={u.unit}>
                <Td className="pl-0">
                  <span className="inline-flex items-center gap-2 font-medium">
                    {vivo ? <Dot kind="busy" pulse /> : null}
                    {u.unit}
                  </span>
                  {vivo || u.estimate?.confidence === 'baixa' || u.estimate?.confidence === 'nenhuma' ? <span className="block t-meta text-muted-foreground">
                    {[vivo ? 'trabalhando' + (u.real.phase ? ` · ${u.real.phase}` : '') : null,
                      u.estimate?.confidence === 'baixa' || u.estimate?.confidence === 'nenhuma' ? `confiança ${u.estimate.confidence}` : null].filter(Boolean).join(' · ')}
                  </span> : null}
                </Td>
                <Td>
                  <RangeBar unit={u} />
                </Td>
                <Td className="text-right text-muted-foreground">
                  {u.estimate?.costP75 == null ? '—' : `${usd2(u.estimate.costP25)} – ${usd2(u.estimate.costP75)}`}
                </Td>
                <Td className="text-right font-medium">
                  {u.real ? usd2(u.real.costUsd) : '—'}
                </Td>
                <Td className="pr-0 text-right">
                  {u.pct == null ? '—' : <>
                    <span className={cn(u.level !== 'ok' && 'font-medium', tone)}>
                      {`${Math.floor(u.pct)}%`}
                    </span>
                    {u.level !== 'ok' ? <span className="block t-meta text-muted-foreground">
                      {label}
                    </span> : null}
                  </>}
                </Td>
              </Tr>; })}
          </tbody>
        </Table>
      </div>)}
    </CardContent>
  </Card>;
}

// Orquestrador: turnos de acompanhamento (wait/watch, pane, agent list/status) × decisão/escrita; regra em src/lib/turn-class.ts.
function Acompanhamento({ d }) {
  const split = d.byRole.find((r) => r.role === 'orchestrator')?.followup;
  if (!split) return null;
  const total = split.follow.turns + split.decision.turns;
  const row = (label, g) => <Tr key={label}>
    <Td className="pl-0">{label}</Td>
    <Td className="text-right tabular-nums">{g.turns.toLocaleString('pt-BR')}</Td>
    <Td className="text-right tabular-nums">{total ? Math.round(100 * g.turns / total) + '%' : '—'}</Td>
    <Td className="text-right tabular-nums">{ktok(g.ctxAvg)}</Td>
    <Td className="pr-0 text-right tabular-nums">{usd(g.cost)}</Td>
  </Tr>;
  return <Card>
    <CardHeader title="Orquestrador: acompanhamento × decisão" summary={`${total.toLocaleString('pt-BR')} turnos em ${d.days} dias`}
      description="Acompanhamento é o despertar de wait/watch, a leitura de pane e agent list/status, sem escrita nem decisão. Cada despertar relê o contexto inteiro." />
    <CardContent>
      <Table>
        <thead>
          <tr className="border-b">
            <Th className="pl-0">Grupo</Th>
            <Th className="text-right">Turnos</Th>
            <Th className="text-right">% dos turnos</Th>
            <Th className="text-right">Contexto médio (tokens)</Th>
            <Th className="pr-0 text-right">Custo (US$)</Th>
          </tr>
        </thead>
        <tbody>{row('Acompanhamento', split.follow)}{row('Decisão e escrita', split.decision)}</tbody>
      </Table>
    </CardContent>
  </Card>;
}

function Usage() {
  const run = useActions();
  const [x, setX] = useState(null);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const f = () => getJSON('/api/usage').then((r) => { if (alive) { setX(r); setErr(null); } }).catch((e) => alive && setErr(e));
    f(); const t = setInterval(f, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [tick]);
  if (!x) return err ? <ErroExplicado error={err} title="Consumo indisponível" onRetry={() => { setErr(null); setTick((n) => n + 1); }} /> : <Loading />;
  const d = x.data;
  if (!d) return <Empty icon={I.LoaderCircle} title="Calculando o consumo…">
    Leva alguns segundos.
  </Empty>;
  const b = d.baseline, perDay = d.perDay ?? d.total.cost / d.days;
  const delta = b ? Math.round(100 * (perDay - b.perDay) / b.perDay) : null;
  const agentsRole = d.byRole.filter((r) => !['orchestrator', 'interactive'].includes(r.role.split(' · ')[0]) && !r.role.includes('subagente'));
  const agCost = agentsRole.reduce((a, r) => a + r.cost, 0), agTurns = agentsRole.reduce((a, r) => a + r.turns, 0);
  const agCtx = agTurns ? agentsRole.reduce((a, r) => a + r.ctxAvg * r.turns, 0) / agTurns : 0;
  const pollPct = 100 * d.total.pollCost / d.total.cost;
  const comPct = d.byRole.some((r) => r.pct5h != null || r.pctWeek != null);
  const maxShare = Math.max(1, ...d.byRole.map((r) => r.share));
  return <div className="grid gap-8">
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="grid min-w-0 flex-1 basis-80 gap-1" data-tour-step-id="usage-resumo">
        <LinhaDeEstado main={`${usd(perDay)} por dia (equivalente em API, estimativa)`}
          rest={[b ? <span key="base">{`${delta > 0 ? '+' : ''}${delta}% sobre a linha de base`}</span> : 'sem linha de base',
            `${d.days} dias desde ${ddmm(d.since)}`,
            `${d.total.turns.toLocaleString('pt-BR')} turnos`,
            `atualizado há ${dur(x.age || 0)}${x.refreshing ? ', atualizando…' : ''}`]} />
        <p className="t-meta text-muted-foreground">
          {d.note}
        </p>
      </div>
      <div className="flex flex-wrap gap-2" data-tour-step-id="usage-acoes">
        <Button size="sm" variant="outline" icon={I.RefreshCw} loading={x.refreshing} onClick={() => run({ action: 'usage', op: 'refresh' })}>Recalcular</Button>
        <Button size="sm" variant="ghost" icon={I.Flag} onClick={() => run({ action: 'usage', op: 'baseline' }, { title: 'Gravar a janela atual como linha de base?', description: 'As próximas comparações usam estes números.', icon: I.Flag })}>Gravar linha de base</Button>
      </div>
    </div>
    <JanelasDoPlano />
    <div data-tour-step-id="usage-leituras">
    <Regua label="Leituras do consumo">
      <Leitura label="Custo por dia" value={perDay} format={usd} unit="por dia (equivalente em API)"
        detail={b ? `linha de base ${usd(b.perDay)}/dia, gravada em ${ddmm(b.savedAt.slice(0, 10))}` : 'sem linha de base'}>
        <Medidor value={perDay} mark={b?.perDay} label={b ? `${usd(perDay)} por dia contra ${usd(b.perDay)} da linha de base` : `${usd(perDay)} por dia`} />
      </Leitura>
      <Leitura label="Polling" value={Math.round(pollPct)} format={(v) => v + '%'} unit="do custo" detail={`${usd(d.total.pollCost)} em turnos que só esperavam`}>
        <Medidor value={pollPct} mark={POLL_LIMIT} warn={pollPct > POLL_LIMIT} label={`polling em ${Math.round(pollPct)}% do custo, limite de ${POLL_LIMIT}%`} />
      </Leitura>
      <Leitura label="Contexto médio dos agentes" value={agCtx} format={ktok} unit="por turno" detail={`agentes = ${Math.round(100 * agCost / d.total.cost)}% do custo · referência ${ktok(CTX_LIMIT)}: acima disso cada turno relê demais`}>
        <Medidor value={agCtx} mark={CTX_LIMIT} warn={agCtx > CTX_LIMIT} label={`contexto médio de ${ktok(agCtx)} por turno, referência de ${ktok(CTX_LIMIT)}`} />
      </Leitura>
      <Leitura label="Reescrita depois de pausa" value={d.total.rewriteCost} format={usd} detail={`em ${d.days} dias · contexto regravado após 1 h parado (não é a reescrita de comando do rtk: ver loop/tokens.md); referência US$ 20 na janela`}>
        <Medidor value={d.total.rewriteCost} mark={REWRITE_LIMIT} warn={d.total.rewriteCost > REWRITE_LIMIT} label={`${usd(d.total.rewriteCost)} em reescrita, referência de ${usd(REWRITE_LIMIT)}`} />
      </Leitura>
    </Regua>
    </div>
    <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <Card data-tour-step-id="usage-papel">
        <CardHeader title="Por papel" summary={`${usd(d.total.cost)} em ${d.days} dias`}
          description={`${tok(d.total.read)} tokens lidos do cache, mais ${tok(d.total.write)} gravados no cache e ${tok(d.total.output)} de saída.${comPct ? ' ~% = parte estimada da janela, pela calibração tokens → %; + = só os modelos calibrados.' : ''}`} />
        <CardContent>
          <Table>
            <thead>
              <tr className="border-b">
                <Th className="pl-0">Papel</Th>
                <Th className="text-right">Sessões</Th>
                <Th className="text-right">Custo (US$)</Th>
                <Th>Parte do custo</Th>
                {comPct ? <Th className="text-right">~5 h</Th> : null}
                {comPct ? <Th className="text-right">~semana</Th> : null}
                <Th className="text-right">Polling (% do custo)</Th>
                <Th className="text-right">Contexto médio (tokens)</Th>
                <Th className="pr-0 text-right">Máximo (tokens)</Th>
              </tr>
            </thead>
            <tbody>
              {d.byRole.map((r) => { const base = b?.byRole?.[r.role]; return <Tr key={r.role}>
                <Td className="pl-0 font-medium">
                  {roleLabel(r.role)}
                </Td>
                <Td className="text-right">
                  {r.sessions}
                </Td>
                <Td className="text-right">
                  {usd(r.cost)}
                </Td>
                <Td>
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-12 shrink-0 bg-border" aria-hidden="true">
                      <span className="block h-full bg-foreground/70" style={{ width: `${100 * r.share / maxShare}%` }} />
                    </span>
                    <span className="text-muted-foreground">
                      {String(r.share).replace('.', ',') + '%'}
                    </span>
                  </span>
                </Td>
                {comPct ? <Td className="text-right text-muted-foreground">{pctEst(r.pct5h, r.pct5hPartial)}</Td> : null}
                {comPct ? <Td className="text-right text-muted-foreground">{pctEst(r.pctWeek, r.pctWeekPartial)}</Td> : null}
                <Td className={cn('text-right', r.pollShare > POLL_LIMIT && 'font-medium text-warn')}>
                  {String(r.pollShare).replace('.', ',') + '%'}
                </Td>
                <Td className="text-right">
                  {ktok(r.ctxAvg)}
                  {base ? <span className="block t-meta text-muted-foreground">
                    {'base ' + ktok(base.ctxAvg)}
                  </span> : null}
                </Td>
                <Td className="pr-0 text-right text-muted-foreground">
                  {ktok(r.ctxMax)}
                </Td>
              </Tr>; })}
            </tbody>
          </Table>
        </CardContent>
      </Card>
      <Card data-tour-step-id="usage-dia">
        <CardHeader title="Por dia" summary="US$ equivalente em API" />
        <CardContent>
          {d.byDay.length ? <PorDia days={d.byDay} /> : <Empty icon={I.ChartColumn} title="Sem dias na janela" />}
        </CardContent>
      </Card>
    </div>
    <Acompanhamento d={d} />
    <Estimated />
    {d.overCap?.length ? <Card>
      <CardHeader title="Sessões acima do teto" summary={`contexto máximo contra o teto do papel · ${d.overCap.length}`} />
      <CardContent className={CARD_SCROLL}>
        <Table>
          <thead>
            <tr className="border-b">
              <Th className="pl-0">Sessão</Th>
              <Th>Papel</Th>
              <Th className="text-right">Turnos</Th>
              <Th className="text-right">Máximo (tokens)</Th>
              <Th className="pr-0 text-right">Teto (tokens)</Th>
            </tr>
          </thead>
          <tbody>
            {d.overCap.map((s, i) => <Tr key={s.cwd + i}>
              <Td className="pl-0 font-medium">
                <Mono title={s.cwd}>{s.cwd.replace(/\/+$/, '').split('/').pop() || s.cwd}</Mono>
              </Td>
              <Td className="text-muted-foreground">
                {roleLabel(s.role)}
              </Td>
              <Td className="text-right">
                {s.turns.toLocaleString('pt-BR')}
              </Td>
              <Td className="text-right font-medium text-warn">
                {ktok(s.ctxMax)}
              </Td>
              <Td className="pr-0 text-right">
                {ktok(s.ctxCap)}
              </Td>
            </Tr>)}
          </tbody>
        </Table>
      </CardContent>
    </Card> : null}
    {d.reuse ? <Card>
      <CardHeader title="Sessões reaproveitadas × novas" summary="reaproveitada: mais de uma fase na sessão do agente, ou ela seguiu depois do DONE" />
      <CardContent>
        <Table>
          <thead>
            <tr className="border-b">
              <Th className="pl-0">Sessão</Th>
              <Th className="text-right">Unidades</Th>
              <Th className="text-right">Sessões</Th>
              <Th className="text-right">Turnos</Th>
              <Th className="pr-0 text-right">Custo (US$)</Th>
            </tr>
          </thead>
          <tbody>
            {[['Reaproveitadas', d.reuse.reused], ['Novas', d.reuse.fresh]].map(([label, b]) => <Tr key={label}>
              <Td className="pl-0 font-medium">{label}</Td>
              <Td className="text-right">{b.units.toLocaleString('pt-BR')}</Td>
              <Td className="text-right">{b.sessions.toLocaleString('pt-BR')}</Td>
              <Td className="text-right">{b.turns.toLocaleString('pt-BR')}</Td>
              <Td className="pr-0 text-right">{usd(b.cost)}</Td>
            </Tr>)}
          </tbody>
        </Table>
      </CardContent>
    </Card> : null}
    <Card data-tour-step-id="usage-agentes">
      <CardHeader title="Agentes" summary={d.byAgent.length > 25 ? `25 mais caros de ${d.byAgent.length}` : 'por agente do herdr'} />
      <CardContent className={CARD_SCROLL}>
        {d.byAgent.length ? <Table>
          <thead>
            <tr className="border-b">
              <Th className="pl-0">Agente</Th>
              <Th>Papel</Th>
              <Th>Modelos</Th>
              <Th className="text-right">Custo (US$)</Th>
              {comPct ? <Th className="text-right">~5 h</Th> : null}
              {comPct ? <Th className="text-right">~semana</Th> : null}
              <Th className="text-right">Turnos</Th>
              <Th className="text-right">Contexto médio (tokens)</Th>
              <Th className="text-right">Máximo (tokens)</Th>
              <Th className="pr-0 text-right">Polling (US$)</Th>
            </tr>
          </thead>
          <tbody>
            {d.byAgent.slice(0, 25).map((a) => <Tr key={a.name}>
              <Td className="pl-0 font-medium">
                {a.name}
                {a.pr ? <Mono className="ml-1.5 text-muted-foreground">
                  {'#' + a.pr}
                </Mono> : null}
                {a.reused ? <div className="t-meta text-muted-foreground">sessão reaproveitada</div> : null}
              </Td>
              <Td className="text-muted-foreground">
                {roleLabel(a.role)}
              </Td>
              <Td>
                <Mono className={a.divergence?.models.length ? 'font-medium text-warn' : 'text-muted-foreground'}>
                  {Object.keys(a.models).join(', ')}
                </Mono>
                {a.divergence?.models.length ? <div className="t-meta text-warn">
                  diverge de {a.divergence.configured}: +{usd2(a.divergence.extraCost)}
                </div> : null}
                {a.divergence?.effort ? <div className="t-meta text-warn">
                  esforço {a.divergence.effort.real}, configurado {a.divergence.effort.configured}
                </div> : null}
              </Td>
              <Td className="text-right">
                {usd(a.cost)}
              </Td>
              {comPct ? <Td className="text-right text-muted-foreground">{pctEst(a.pct5h, a.pct5hPartial)}</Td> : null}
              {comPct ? <Td className="text-right text-muted-foreground">{pctEst(a.pctWeek, a.pctWeekPartial)}</Td> : null}
              <Td className="text-right">
                {a.turns.toLocaleString('pt-BR')}
              </Td>
              <Td className={cn('text-right', a.ctxAvg > CTX_LIMIT && 'font-medium text-warn')}>
                {ktok(a.ctxAvg)}
              </Td>
              <Td className={cn('text-right', a.overCap ? 'font-medium text-warn' : 'text-muted-foreground')}>
                {ktok(a.ctx_max)}
                {a.overCap ? <div className="t-meta">acima do teto de {ktok(a.ctxCap)}</div> : null}
              </Td>
              <Td className="pr-0 text-right">
                {usd(a.poll_cost)}
              </Td>
            </Tr>)}
          </tbody>
        </Table>
          : <Empty icon={I.Bot} title="Nenhum agente na janela" />}
      </CardContent>
    </Card>
  </div>;
}

HadesCore.registerPage('usage', Usage);
})();
