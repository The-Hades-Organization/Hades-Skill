/* Página Visão geral (#/overview): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela.
 * De cima para baixo: quem espera por você, o estado e as ações do ciclo, a régua de leituras, o que fia agora e o que
 * pede atenção, a última hora e o ambiente (endereços, diagnóstico e disco). */
(() => {
const { useState, useEffect, useCallback, I, cn, PLUGIN, pluginList, GB, MB, gb, dur, dt, pct, getJSON, ago,
  Button, Dot, Card, CardHeader, CardContent, Mono, Tip, Empty, AreaChart, Legend, OVERALL, useApp, useActions,
  CopyButton, Segmented, Fio, FIO_ESTADO, Regua, Leitura, Tracos, liveThreads, jobFio } = HadesCore;

// memória do slice: acima de MEM_WARN fica âmbar, acima de MEM_BAD vermelha; a marca na barra fica em MEM_BAD
const MEM_WARN = 65, MEM_BAD = 85;
// barras de erro: a última hora em ERR_BARS fatias, cada uma com o pico da contagem (cada ponto do histórico conta os
// erros dos 15 min anteriores)
const ERR_BARS = 40;
// linhas do "Agora": as vivas sempre, completadas pelas execuções recentes até este total
const NOW_ROWS = 6;

const svcTraco = (s) => s.state === 'failed' ? 'bad' : s.state === 'activating' || (s.state === 'active' && !s.ready) ? 'warn' : s.ready ? 'ok' : 'idle';
const ctrTraco = (c) => c.state === 'running' ? (c.unhealthy ? 'warn' : 'ok') : c.state === 'restarting' ? 'warn' : 'idle';
const peaks = (values, n) => {
  const size = Math.max(1, Math.ceil(values.length / n));
  return Array.from({ length: Math.ceil(values.length / size) }, (_, i) => Math.max(0, ...values.slice(i * size, (i + 1) * size)));
};
// ação do painel em palavra legível; ação sem entrada aqui aparece como veio
const ACTION_LABEL = { 'run-hades': 'Subida', update: 'Atualização', pause: 'Pausa', doctor: 'Diagnóstico', clean: 'Limpeza', status: 'STATUS', review: 'Revisão', usage: 'Consumo' };
const decimal = (v) => v.toFixed(1).replace('.', ',');
const memTone = (p) => p > MEM_BAD ? 'bad' : p > MEM_WARN ? 'warn' : null;

// containers que contam na infra: os de longa duração, sem os opcionais do plugin
function infraContainers(d) {
  const optional = pluginList('optionalContainers');
  return d.containers.filter((c) => !c.oneshot && !optional.includes(c.service));
}
// endereços do manifesto: com sonda, o código vem em d.endpoints[nome]; sem sonda, o ponto fica neutro
function endpointList(d) {
  return [
    ...pluginList('endpoints').map((e) => ({ icon: I[e.icon] || I.Link, name: e.label || e.name, url: e.url || null, addr: e.addr,
      code: e.name in d.endpoints ? d.endpoints[e.name] : null, off: !(e.name in d.endpoints) })),
    { icon: I.Earth, name: 'Túnel público', url: d.tunnelUrl, code: d.extras?.tunnel?.state === 'active' ? 200 : null, off: d.extras?.tunnel?.state !== 'active' },
  ];
}
const endpointDown = (e) => !e.off && (e.code == null || e.code >= 500);
// parado ou pausado, endereço calado é o esperado: não vira alerta nem contagem
const resting = (d) => d.overall === 'stopped' || d.paused;

// ------------------------------------------------------------------ espera por você
function WaitingForYou({ n, go }) {
  if (!n) return null;
  return <section aria-label="Espera por você" data-tour-step-id="overview-espera" className="flex flex-wrap items-center gap-x-4 gap-y-3 border border-vivo/50 bg-card px-4 py-3">
    <I.Hand className="size-4 shrink-0 text-vivo" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <h2 className="t-section">
        {"Espera por você "}
        <span className="t-data text-vivo">
          {n}
        </span>
      </h2>
      <p className="t-body text-muted-foreground">
        {n === 1 ? 'Um agente pede resposta.' : `${n} agentes pedem resposta.`}
      </p>
    </div>
    <div className="flex gap-2 max-md:w-full max-md:[&>*]:flex-1">
      <Button icon={I.TerminalSquare} onClick={() => { location.hash = '#/herdr?state=blocked'; }}>Responder no Herdr</Button>
      <Button variant="outline" icon={I.Argos} onClick={() => go('argos')}>Ver no Argos</Button>
    </div>
  </section>;
}

// ------------------------------------------------------------------ estado e ações do ciclo
function Estado({ d, threads, busy }) {
  const { openDialog, openLog } = useApp();
  const run = useActions();
  const ov = OVERALL[d.overall] || OVERALL.stopped;
  const en = d.services.filter((s) => s.enabled);
  const ready = en.filter((s) => s.ready).length;
  const n = (s) => threads.filter((t) => t.s === s).length;
  const facts = [
    d.paused && d.overall !== 'busy' ? `pausado ${dt(Date.parse(d.pausedAt) / 1000)}` : null,
    d.overall === 'busy' ? 'ciclo em andamento' : null,
    en.length ? `${ready} de ${en.length} serviços prontos` : 'nenhum serviço ligado',
    n('fiando') ? `${n('fiando')} rodando` : 'nada rodando',
    n('cortado') ? `${n('cortado')} falhou` : null,
    n('frouxo') ? `${n('frouxo')} na fila` : null,
  ].filter(Boolean);
  const cycle = {
    run: { label: 'Subir Hades', icon: I.Rocket, onClick: () => openDialog('run') },
    update: { label: 'Atualizar Hades', icon: I.RefreshCw, onClick: () => openDialog('update'),
      tip: 'Refaz a branch hades/local com git reset --hard (o que não estiver nela se perde), recompila e reinicia.' },
    pause: d.paused
      ? { label: 'Retomar', icon: I.Play, onClick: () => run({ action: 'pause', op: 'resume' }, { title: 'Retomar o Hades?', description: 'Religa infra, serviços e ambiente do projeto, nessa ordem.', icon: I.Play }) }
      : { label: 'Pausar', icon: I.Pause, onClick: () => run({ action: 'pause', op: 'pause' }, { title: 'Pausar o Hades?', description: 'Para serviços, containers e ambiente do projeto. Os dados ficam.', icon: I.Pause, danger: true }) },
  };
  // a primária é o próximo passo natural: subir se parado, retomar se pausado; com o Hades no ar nenhuma ação pede você
  const first = d.paused ? 'pause' : d.overall === 'stopped' ? 'run' : null;
  const order = first ? [first, ...Object.keys(cycle).filter((k) => k !== first)] : Object.keys(cycle);
  return <section aria-label="Estado do Hades" data-tour-step-id="overview-estado" className="flex flex-wrap items-end gap-x-8 gap-y-4">
    <div className="min-w-0 flex-1">
      <p className="flex items-center gap-2.5 t-kpi leading-tight">
        <Dot kind={ov.kind} pulse={ov.pulse} className="size-2.5" />
        {ov.label + '.'}
      </p>
      <p className="mt-1 t-body text-muted-foreground">
        {facts.join(' · ')}
      </p>
    </div>
    <div className="flex flex-wrap items-center gap-2 max-md:grid max-md:w-full max-md:grid-cols-2">
      {order.map((k) => {
        const btn = <Button key={k} variant={k === first ? 'default' : 'outline'} icon={cycle[k].icon} disabled={k !== first && busy} loading={k === first && busy} onClick={cycle[k].onClick} className={k === first ? 'max-md:col-span-2' : ''}>
          {cycle[k].label}
        </Button>;
        return cycle[k].tip ? <Tip key={k} text={cycle[k].tip}>{btn}</Tip> : btn;
      })}
      <span className="mx-1 h-5 w-px bg-border max-md:hidden" aria-hidden="true" />
      {PLUGIN.dialogs.data ? <Button variant="outline" icon={I.DatabaseZap} disabled={busy} onClick={() => openDialog('data')}>Dados</Button> : null}
      <span className="flex gap-1 max-md:[&>*:first-child]:flex-1">
        <Button variant="ghost" icon={I.FileText} onClick={() => openLog('doc:STATUS.md', 'STATUS.md')}>STATUS</Button>
        <Tip text="Regerar o STATUS.md">
          <Button size="icon-sm" variant="ghost" aria-label="Regerar o STATUS.md" icon={I.FileCog} onClick={() => run({ action: 'status' })} />
        </Tip>
      </span>
    </div>
  </section>;
}

// ------------------------------------------------------------------ régua de leituras
function MemBar({ used, max }) {
  const p = pct(used, max), tone = memTone(p);
  return <div className="relative h-4" role="img" aria-label={max ? `${gb(used)} de ${gb(max)}` : 'nenhum serviço rodando'}>
    <span className="absolute inset-x-0 top-1.5 h-1 bg-border" />
    <span className={cn('absolute top-1.5 left-0 h-1 transition-[width] duration-500', tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-warn' : 'bg-foreground')} style={{ width: p + '%' }} />
    <span className="absolute top-0 h-4 w-px bg-warn" style={{ left: MEM_BAD + '%' }} title={`${MEM_BAD}% do teto`} />
  </div>;
}
function ErrBars({ values }) {
  const top = Math.max(1, ...values);
  return <div className="flex h-4 items-end gap-[2px]" role="img" aria-label={`Erros na última hora: ${values.filter(Boolean).length} de ${values.length} fatias com erro, pico de ${top}`}>
    {values.map((v, i) => <span key={i} className={cn('flex-1', v ? 'bg-bad' : 'h-px bg-border-strong')} style={v ? { height: Math.max(25, v / top * 100) + '%' } : undefined} />)}
  </div>;
}
function Leituras({ d, go }) {
  const goTo = (id) => HadesCore.NAV.some((n) => n.id === id) ? () => go(id) : undefined;
  const en = d.services.filter((s) => s.enabled);
  const tr = en.map(svcTraco);
  const count = (k) => tr.filter((t) => t === k).length;
  const svcDetail = [count('warn') ? `${count('warn')} subindo` : null, count('bad') ? `${count('bad')} caiu` : null,
    `${d.services.length - en.length} desligado${d.services.length - en.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  const lr = infraContainers(d);
  const up = lr.filter((c) => c.state === 'running').length;
  const slp = pct(d.slice.used, d.slice.max);
  const errs = d.services.reduce((a, s) => a + s.logs.errors, 0);
  const warns = d.services.reduce((a, s) => a + s.logs.warns, 0);
  return <Regua label="Leituras">
    <Leitura label="Serviços prontos" value={count('ok')} unit={`/ ${en.length}`} detail={svcDetail} onClick={goTo('services')}>
      <Tracos items={tr} label={`${count('ok')} de ${en.length} serviços prontos`} />
    </Leitura>
    <Leitura label="Memória do Hades" value={d.slice.used != null ? d.slice.used / GB : '—'} decimals={1} format={decimal} unit="GB"
      detail={d.slice.max ? `${Math.round(slp)}% do teto de ${gb(d.slice.max)}` : `nenhum serviço rodando · teto ${d.config?.HADES_SLICE_MAX ?? '—'}`}>
      <MemBar used={d.slice.used} max={d.slice.max} />
    </Leitura>
    <Leitura label="Infra docker" value={up} unit={`/ ${lr.length}`} detail={`${hb(d.containers.reduce((a, c) => a + (c.mem || 0), 0))} em uso`} onClick={goTo('infra')}>
      <Tracos items={lr.map(ctrTraco)} label={`${up} de ${lr.length} containers no ar`} />
    </Leitura>
    <Leitura label="Erros nos logs" value={errs} detail={`últimos 15 min · ${warns} aviso${warns === 1 ? '' : 's'} · barras: picos da última hora`} onClick={() => go('logs')}>
      <ErrBars values={peaks(d.history.map((p) => p.errors), ERR_BARS)} />
    </Leitura>
  </Regua>;
}

// ------------------------------------------------------------------ agora: o que fia, na fila e o que acabou
// a linha inteira abre o alvo (link esticado); passar o mouse ou focar revela início e duração
function NowRow({ kind, name, when, fio, who, more, onClick, href }) {
  const target = 'min-w-0 flex-1 truncate text-left t-label outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring cursor-pointer';
  return <li className="group relative border-b py-3 last:border-b-0 hover:bg-muted/40">
    <div className="flex items-baseline gap-2">
      <span className="w-[4.5rem] shrink-0 truncate t-meta text-muted-foreground">
        {kind}
      </span>
      {href ? <a href={href} className={cn(target, fio.s === 'cortado' && 'text-bad')}>{name}</a>
        : <button type="button" onClick={onClick} className={cn(target, fio.s === 'cortado' && 'text-bad')}>{name}</button>}
      <span className="shrink-0 t-data text-muted-foreground">
        {when}
      </span>
    </div>
    <div className="mt-2 pl-[5rem] max-md:pl-0">
      <Fio s={fio.s} nos={fio.nos} corte={fio.corte} label={`${name}: ${FIO_ESTADO[fio.s]}`} />
      <div className="mt-1.5 flex gap-2 t-meta text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {who}
        </span>
        {more ? <span className="max-w-[60%] truncate font-mono tnum md:invisible md:group-focus-within:visible md:group-hover:visible">
          {more}
        </span> : null}
      </div>
    </div>
  </li>;
}
function Agora({ d, threads }) {
  const { openJob, go } = useApp();
  const live = d.jobs.filter((j) => j.state === 'rodando');
  const done = d.jobs.filter((j) => j.state !== 'rodando');
  const gates = d.gates.map((g) => <NowRow key={'g' + g.pid + g.label} kind="gate" name={g.label} href="#/queue"
    when={dur(g.state === 'running' ? g.runningFor : g.age)} fio={{ s: g.state === 'running' ? 'fiando' : 'frouxo' }}
    who={g.state === 'running' ? 'rodando' : 'na fila'} />);
  const herdr = d.herdr?.working ? [<NowRow key="herdr" kind="agentes" name={`${d.herdr.working} trabalhando`} href="#/herdr" when="" fio={{ s: 'fiando' }} who="herdr" />] : [];
  const jobRow = (j) => {
    const took = dur((j.ended || d.t) - j.started);
    return <NowRow key={j.id} kind={ACTION_LABEL[j.action] || j.action} name={j.title} onClick={() => openJob(j.id)} fio={jobFio(j, d.jobs)}
      when={j.state === 'rodando' ? took : ago(j.ended || j.started)}
      who={j.state === 'falhou' ? `falhou · saída ${j.rc}` : FIO_ESTADO[jobFio(j, d.jobs).s]}
      more={`início ${dt(j.started)} · ${took}`} />;
  };
  const rows = [...live.map(jobRow), ...gates, ...herdr];
  rows.push(...done.slice(0, Math.max(0, NOW_ROWS - rows.length)).map(jobRow));
  const n = (s) => threads.filter((t) => t.s === s).length;
  const summary = [n('fiando') ? `${n('fiando')} rodando` : 'nada rodando', n('cortado') ? `${n('cortado')} falhou` : null,
    n('frouxo') ? `${n('frouxo')} na fila` : null].filter(Boolean).join(' · ');
  return <Card data-tour-step-id="overview-agora">
    <CardHeader title="Agora" summary={summary} action={<Button size="xs" variant="ghost" onClick={() => go('jobs')}>
      Execuções
      <I.ArrowRight />
    </Button>} />
    <CardContent>
      {rows.length ? <ul className="-mt-3">
        {rows}
      </ul> : <div>
        <Empty icon={I.SquareTerminal} title="Nada rodando agora">As execuções disparadas pelo painel aparecem aqui.</Empty>
        <Fio s="parado" className="max-w-xs" label="Nada rodando" />
      </div>}
    </CardContent>
  </Card>;
}

// ------------------------------------------------------------------ atenção: só o que pede uma ação sua
const TONE_TXT = { bad: 'text-bad', warn: 'text-warn', info: 'text-info' };
function attentionItems(d, endpoints) {
  const items = [];
  for (const s of d.services.filter((x) => x.enabled && x.state === 'failed'))
    items.push({ key: 'svc' + s.name, tone: 'bad', icon: I.CircleX, text: `${s.name} caiu`, go: 'services', action: 'Ver serviços' });
  const slp = pct(d.slice.used, d.slice.max);
  if (memTone(slp)) items.push({ key: 'mem', tone: memTone(slp), icon: I.MemoryStick, text: `Memória em ${Math.round(slp)}% do teto de ${gb(d.slice.max)}`, go: 'services', action: 'Ver serviços' });
  const noisy = d.services.filter((s) => s.logs.errors).sort((a, b) => b.logs.errors - a.logs.errors);
  if (noisy.length) {
    const total = noisy.reduce((a, s) => a + s.logs.errors, 0);
    items.push({ key: 'errs', tone: 'bad', icon: I.Bug, text: `${total} erro${total > 1 ? 's' : ''} nos logs em 15 min`,
      when: noisy.slice(0, 3).map((s) => s.name.replace(/^ms-/, '')).join(', '), go: 'logs', action: 'Abrir os logs' });
  }
  if (!resting(d)) for (const e of endpoints.filter(endpointDown))
    items.push({ key: 'ep' + e.name, tone: 'warn', icon: I.Unplug, text: `${e.name} não responde${e.code ? ` (${e.code})` : ''}`, when: e.url || e.addr });
  const ck = d.versionCheck;
  if (ck?.update) items.push({ key: 'ver', tone: 'info', icon: I.CircleArrowUp, text: `Versão ${ck.remote} disponível; você está na ${ck.local}`, copy: ck.command });
  return items;
}
function Atencao({ d, go, endpoints }) {
  const goTo = (id) => HadesCore.NAV.some((n) => n.id === id) ? () => go(id) : undefined;
  const items = attentionItems(d, endpoints);
  return <Card data-tour-step-id="overview-atencao">
    <CardHeader title="Atenção" summary={items.length ? `${items.length} ite${items.length > 1 ? 'ns' : 'm'}` : null} />
    <CardContent>
      {items.length ? <ul className="-mt-3">
        {items.map((x) => <li key={x.key} className="flex items-start gap-3 border-b py-3 last:border-b-0">
          <x.icon className={cn('mt-0.5 size-4 shrink-0', TONE_TXT[x.tone])} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="t-body">
              {x.text}
            </div>
            {x.copy ? <div className="mt-1.5 flex items-center gap-1 bg-term py-1 pr-1 pl-3 text-term-foreground [&_button:hover]:bg-white/10 [&_button:hover]:text-term-foreground">
              <Mono className="min-w-0 flex-1 truncate text-term-foreground">
                {x.copy}
              </Mono>
              <CopyButton text={x.copy} label="Copiar o comando" />
            </div> : null}
            {x.when || (x.go && goTo(x.go)) ? <div className="mt-0.5 flex min-w-0 gap-3 t-meta text-muted-foreground">
              {x.when ? <span className="min-w-0 truncate font-mono">
                {x.when}
              </span> : null}
              {x.go && goTo(x.go) ? <button type="button" onClick={goTo(x.go)} className="shrink-0 cursor-pointer font-medium text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-foreground">
                {x.action}
              </button> : null}
            </div> : null}
          </div>
        </li>)}
      </ul> : <p className="flex items-center gap-2 t-body text-muted-foreground">
        <I.CircleCheck className="size-4 text-ok" aria-hidden="true" />
        Nada pede atenção agora.
      </p>}
    </CardContent>
  </Card>;
}

// ------------------------------------------------------------------ última hora
function UltimaHora({ d }) {
  const [tab, setTab] = useState('mem');
  const mem = [
    { name: 'Serviços (slice)', color: 'var(--chart-1)', get: (p) => p.slice / GB },
    { name: 'Infra docker', color: 'var(--chart-2)', get: (p) => p.infra / GB },
    ...(PLUGIN.manifest.memLabel ? [{ name: String(PLUGIN.manifest.memLabel), color: 'var(--chart-5)', get: (p) => (p.extra || 0) / GB, dash: true, fill: false }] : []),
  ];
  const health = [
    { name: 'Prontos (responderam ao ready)', color: 'var(--ok)', get: (p) => p.ready, step: true },
    { name: 'Ativos (processo de pé)', color: 'var(--chart-5)', get: (p) => p.active, step: true, dash: true, fill: false },
    { name: 'Erros (janela de 15 min)', color: 'var(--bad)', get: (p) => p.errors, step: true },
  ];
  const series = tab === 'mem' ? mem : health;
  return <Card data-tour-step-id="overview-hora">
    <CardHeader title="Última hora" summary={tab === 'mem' ? (d.slice.max ? `GB · teto ${gb(d.slice.max)}` : 'GB') : 'serviços e erros'}
      action={<Segmented value={tab} onChange={setTab} items={[{ value: 'mem', label: 'Memória' }, { value: 'health', label: 'Saúde' }]} />} />
    <CardContent className="grid gap-3">
      {!d.history.some((p) => series.some((s) => s.get(p))) ? <p className="t-body text-muted-foreground">Nada rodou na última hora.</p> : <>
        <Legend items={series} />
        {tab === 'mem'
        ? <AreaChart points={d.history} series={mem} yFmt={decimal} refLine={d.slice.max ? d.slice.max / GB : null} refLabel="teto de memória" label="Memória do Hades na última hora" />
          : <AreaChart points={d.history} series={health} yFmt={(v) => Math.round(v)} label="Saúde dos serviços na última hora" />}
      </>}
    </CardContent>
  </Card>;
}

// ------------------------------------------------------------------ ambiente: uma linha por assunto, o detalhe abre embaixo
function Gaveta({ name, summary, action, children, ...rest }) {
  return <li {...rest} className="relative border-b last:border-b-0">
    <details className="group/g">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 py-1.5 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-md:pb-2.5 md:flex-nowrap md:pr-40 [&::-webkit-details-marker]:hidden">
        <I.ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/g:rotate-90" aria-hidden="true" />
        <span className="w-24 shrink-0 t-label max-md:flex max-md:min-h-8 max-md:items-center">
          {name}
        </span>
        <span className="min-w-0 flex-1 truncate t-label text-muted-foreground max-md:basis-full max-md:pl-[1.625rem]">
          {summary}
        </span>
      </summary>
      <div className="grid gap-2 pb-4 pl-6">
        {children}
      </div>
    </details>
    {action ? <div className="absolute top-0 right-0 flex gap-1 md:top-1.5">
      {action}
    </div> : null}
  </li>;
}

function Enderecos({ d, endpoints }) {
  const on = endpoints.filter((e) => !e.off);
  const ok = on.filter((e) => !endpointDown(e)).length;
  return <Gaveta data-tour-step-id="overview-enderecos" name="Endereços" summary={on.length && !resting(d) ? `${ok} de ${on.length} respondendo` : 'Hades parado'}>
    {endpoints.map((e) => <div key={e.name} className="flex min-w-0 items-center gap-3 t-body">
      <Dot kind={e.off || resting(d) ? 'idle' : endpointDown(e) ? 'bad' : 'ok'} />
      <span className="shrink-0">
        {e.name}
      </span>
      {e.url ? <a href={e.url} target="_blank" rel="noopener" className="ml-auto inline-flex min-w-0 items-center gap-1 t-data text-muted-foreground hover:text-foreground hover:underline">
        <span className="truncate">
          {e.url.replace(/^https?:\/\//, '')}
        </span>
        <I.ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
      </a> : <Mono className="ml-auto truncate text-muted-foreground">
        {e.addr || 'nunca criado'}
      </Mono>}
    </div>)}
  </Gaveta>;
}

// diagnóstico (doctor.sh --json): só diagnostica; cada item traz o comando que corrige
const DOCTOR_KIND = { ok: 'ok', warn: 'warn', error: 'bad' };
function Diagnostico() {
  const run = useActions();
  const [res, setRes] = useState(null);
  const [wait, setWait] = useState(false);
  const load = useCallback(() => getJSON('/api/doctor').then((r) => { setRes(r); return r; }).catch(() => null), []);
  useEffect(() => { load(); }, [load]);
  const go = async () => {
    const before = res?.mtime || 0;
    setWait(true);
    const job = await run({ action: 'doctor' });
    for (let i = 0; job && i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await load();
      if (r && (r.mtime || 0) > before) break;
    }
    setWait(false);
  };
  const items = res?.items || [];
  const bad = items.filter((x) => x.level !== 'ok');
  const sum = res?.summary;
  const summary = !res?.items ? 'ainda não rodou' : <>
    <span className="text-ok">{sum.ok + ' ok'}</span>
    {sum.warn ? <span className="text-warn">{` · ${sum.warn} aviso${sum.warn > 1 ? 's' : ''}`}</span> : null}
    {sum.error ? <span className="text-bad">{` · ${sum.error} erro${sum.error > 1 ? 's' : ''}`}</span> : null}
    {` · ${new Date(res.time * 1000).toLocaleTimeString('pt-BR')}${res.quick ? ' · rápido (sem checagens lentas)' : ''}`}
  </>;
  return <Gaveta data-tour-step-id="overview-diagnostico" name="Diagnóstico" summary={summary} action={<Button size="sm" variant="ghost" icon={I.Stethoscope} loading={wait} onClick={go}>Rodar</Button>}>
    {!res?.items ? <p className="t-body text-muted-foreground">Rode para conferir o ambiente.</p> : <>
      {bad.map((x) => <div key={x.id} className="py-0.5 pl-4">
        <div className="flex items-baseline gap-2 t-body">
          <Dot kind={DOCTOR_KIND[x.level]} className="-ml-4 shrink-0 self-center" />
          <span className="text-muted-foreground">
            {x.group}
          </span>
          <span>
            {x.msg}
          </span>
        </div>
        {x.fix ? <div className="mt-0.5 t-data text-muted-foreground">
          {'→ ' + x.fix}
        </div> : null}
      </div>)}
      {items.filter((x) => x.level === 'ok').map((x) => <div key={x.id} className="flex items-center gap-2 t-meta">
        <Dot kind="ok" />
        <span className="text-muted-foreground">
          {x.group}
        </span>
        <span>
          {x.msg}
        </span>
      </div>)}
    </>}
  </Gaveta>;
}

// disco (clean.sh): a confirmação mostra o que sairia (clean.sh em simulação) antes de rodar
const hb = (b) => b == null ? '—' : b >= GB ? gb(b) : b >= MB ? Math.round(b / MB) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B';
const DISK_REFRESH_MS = 60000;
function Disco() {
  const { toast } = useApp();
  const run = useActions();
  const [x, setX] = useState(null);
  const [busy, setBusy] = useState(false);
  // medição que falha (painel reiniciando) mantém a última; a próxima volta do intervalo tenta de novo
  const load = useCallback((refresh) => getJSON('/api/disk' + (refresh ? '?refresh=1' : '')).then(setX).catch(() => null), []);
  useEffect(() => { load(); const t = setInterval(load, DISK_REFRESH_MS); return () => clearInterval(t); }, [load]);
  const ask = async (op, cat, c) => {
    setBusy(true);
    try {
      const r = await getJSON(`/api/disk/preview?op=${op}&cat=${cat || ''}`);
      const lines = (r.text || '').split('\n').filter(Boolean).map((l) => l.replace(/\t+/g, '  '));
      const shown = lines.slice(0, 14).join('\n') + (lines.length > 14 ? `\n… e mais ${lines.length - 14} linha(s)` : '');
      if (await run({ action: 'clean', op, cat }, { ...c, description: `${c.description}\n\n${shown || '(nada a tirar)'}` })) setTimeout(() => load(true), 4000);
    } catch (e) { toast({ kind: 'bad', title: 'Prévia indisponível', desc: e.message }); }
    setBusy(false);
  };
  if (!x) return <Gaveta data-tour-step-id="overview-disco" name="Disco" summary="medindo…" />;
  const safe = x.cats.filter((c) => c.mode === 'seguro'), total = x.cats.reduce((a, c) => a + c.bytes, 0), top = Math.max(1, ...x.cats.map((c) => c.bytes));
  const free = safe.reduce((a, c) => a + c.reclaim, 0);
  return <Gaveta data-tour-step-id="overview-disco" name="Disco" summary={free ? <>
    <span className="font-mono tnum">{hb(free)}</span>
    {' a liberar'}
  </> : 'nada a liberar'} action={<Tip text="Apaga logs, o histórico de Execuções e o cache; imagens e worktrees ficam."><Button size="sm" variant="ghost" icon={I.Eraser} disabled={busy} onClick={() => ask('run', '', { title: 'Limpar (seguro)?', description: `Logs, histórico de Execuções e cache. Libera ~${hb(free)}; imagens e worktrees ficam.`, icon: I.Eraser, confirmLabel: 'Limpar' })}>Limpar (seguro)</Button></Tip>}>
    {x.cats.map((c) => <div key={c.id} className="grid items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="truncate t-body">
          {c.label}
        </div>
        <div className="truncate t-meta text-muted-foreground" title={c.detail}>
          {c.detail}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="relative h-1 flex-1 bg-border">
          <span className="absolute inset-y-0 left-0 bg-metal-ink" style={{ width: pct(c.bytes, top) + '%' }} />
        </span>
        <span className="w-16 shrink-0 text-right t-data">
          {hb(c.bytes)}
        </span>
      </div>
      <div className="flex items-center justify-end gap-2 t-meta sm:w-40">
        {c.reclaim > 0 ? <span className={c.mode === 'seguro' ? 'text-ok' : 'text-warn'}>
          {'libera ' + hb(c.reclaim) + (c.mode === 'seguro' ? '' : ' · irreversível')}
        </span> : <span className="text-muted-foreground">
          {c.mode === 'info' ? 'só informa' : 'nada a liberar'}
        </span>}
        {c.mode === 'confirma' && c.reclaim > 0 ? <Button size="xs" variant="outline" disabled={busy} onClick={() => ask('yes', c.id, { title: `Apagar: ${c.label.toLowerCase()}?`, description: 'Só o listado abaixo. Não dá para desfazer.', icon: I.Trash2, danger: true, confirmLabel: 'Apagar' })}>Apagar…</Button> : null}
      </div>
    </div>)}
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 t-meta text-muted-foreground">
      <span className="min-w-0 flex-1">
        {`${hb(total)} no total. Limpeza automática: ` + (x.timer.state === 'ativo' ? 'ligada' + (x.timer.last !== '-' ? ' · última ' + x.timer.last : '') : 'desligada (Configurações → Limpeza)')}
      </span>
      <Button size="xs" variant="ghost" icon={I.RotateCw} disabled={busy} onClick={() => ask('rotate', '', { title: 'Rotacionar os logs agora?', description: 'Logs acima do teto viram <nome>.1.gz e são truncados.', icon: I.RotateCw, confirmLabel: 'Rotacionar' })}>Rotacionar logs</Button>
      <Button size="xs" variant="ghost" icon={I.RefreshCw} onClick={() => load(true)}>Medir de novo</Button>
    </div>
  </Gaveta>;
}

function Ambiente({ d, endpoints }) {
  return <Card data-tour-step-id="overview-ambiente">
    <CardHeader title="Ambiente" />
    <ul className="-mt-3">
      <Enderecos d={d} endpoints={endpoints} />
      <Diagnostico />
      <Disco />
    </ul>
  </Card>;
}

function Overview({ d, go }) {
  const threads = liveThreads(d);
  const busy = d.jobs.some((j) => j.state === 'rodando' && j.exclusive) || d.skillProcs.length > 0;
  const endpoints = endpointList(d);
  return <div className="grid gap-8">
    <WaitingForYou n={d.herdr?.blocked || 0} go={go} />
    <Estado d={d} threads={threads} busy={busy} />
    <div data-tour-step-id="overview-leituras">
      <Leituras d={d} go={go} />
    </div>
    <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Agora d={d} threads={threads} />
      <Atencao d={d} go={go} endpoints={endpoints} />
    </div>
    <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <UltimaHora d={d} />
      <Ambiente d={d} endpoints={endpoints} />
    </div>
  </div>;
}

HadesCore.registerPage('overview', Overview);
})();
