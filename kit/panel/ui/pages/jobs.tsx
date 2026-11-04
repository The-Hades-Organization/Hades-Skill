/* Página Execuções (#/jobs): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela.
 * Cada execução é um fio; a escolhida mostra o comando, o fio na largura toda e o log no terminal. */
(() => {
const { useState, useEffect, I, cn, dur, dt, Button, Card, CardHeader, CardContent, Empty, useApp, JOB_ST, JobRow, jobFio, Fio, FIO_ESTADO,
  LinhaDeEstado, Terminal, useWide, OpenTerminalButton, useTermRoots } = HadesCore;

const HOUR_S = 3600;
function Selected({ j, d }) {
  const { stopJob } = useApp();
  const term = useTermRoots();
  const st = JOB_ST[j.state] || JOB_ST.interrompido;
  const fio = jobFio(j, d.jobs);
  const took = dur((j.ended || d.t) - j.started);
  return <div className="grid gap-3" data-tour-step-id="jobs-execucao">
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <h2 className={cn('truncate t-section', j.state === 'falhou' && 'text-bad')}>
          {j.title}
        </h2>
        <div className="truncate t-data text-muted-foreground">
          {j.cmd.split('\n')[0]}
        </div>
      </div>
      <span data-tour-step-id="jobs-terminal"><OpenTerminalButton cwd={j.cwd} term={term} size="sm" variant="outline" /></span>
      {j.state === 'rodando' ? <span data-tour-step-id="jobs-interromper"><Button size="sm" variant="ghost-destructive" icon={I.OctagonX} onClick={() => stopJob(j)}>Interromper</Button></span> : null}
    </div>
    <div data-tour-step-id="jobs-fio">
      <Fio s={fio.s} nos={fio.nos} corte={fio.corte} label={`${j.title}: ${FIO_ESTADO[fio.s]}`} />
    </div>
    <LinhaDeEstado className="t-label" main={j.state === 'rodando' ? `${j.fase ? `fase ${j.fase} · ` : ''}rodando há ${took}` : st.label.toLowerCase() + (j.state === 'falhou' ? ` · saída ${j.rc}` : '')}
      rest={[`início ${dt(j.started)}`, j.state === 'rodando' ? null : `levou ${took}`, j.exclusive ? 'exclusiva (bloqueia outras ações do ciclo)' : null]} />
  </div>;
}

function Jobs({ d, sel, setSel }) {
  const { go, openJob } = useApp();
  // abaixo de lg não há coluna do log: a execução abre na gaveta de log do app
  const wide = useWide(1024);
  const j = d.jobs.find((x) => x.id === sel) || d.jobs[0];
  if (!d.jobs.length) return <div className="grid max-w-xl gap-3">
    <Empty icon={I.SquareTerminal} title="Nenhuma execução ainda">As ações do ciclo (subir, atualizar, build, diagnóstico) disparadas no painel aparecem aqui como fios, com o log ao vivo.</Empty>
    <Fio s="parado" className="max-w-xs" label="Nada rodando" />
    <div>
      <Button size="sm" variant="outline" onClick={() => go('overview')}>
        Ir à Visão geral
        <I.ArrowRight />
      </Button>
    </div>
  </div>;
  const n = (s) => d.jobs.filter((x) => x.state === s).length;
  const recentBad = d.jobs.filter((x) => x.state === 'falhou' && d.t - (x.ended || x.started) < HOUR_S).length;
  return <div className="grid gap-6">
    <div data-tour-step-id="jobs-estado">
      <LinhaDeEstado main={n('rodando') ? `${n('rodando')} rodando` : 'nada rodando'}
        rest={[recentBad ? `${recentBad} ${recentBad === 1 ? 'falhou' : 'falharam'} na última hora` : null, `${d.jobs.length} no histórico`,
          `units ${d.unitPrefix || 'hds'}-pjob-* continuam se o painel reiniciar`]} />
    </div>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(260px,340px)_1fr]">
      <aside className="lg:sticky lg:top-20">
        <Card className="gap-0 lg:max-h-[calc(100vh-7rem)]" data-tour-step-id="jobs-historico">
          <CardHeader title="Histórico" summary={`${d.jobs.length}`} />
          <CardContent className="overflow-auto scrollbar-thin">
            {d.jobs.map((x) => <JobRow key={x.id} j={x} jobs={d.jobs} now={d.t} active={wide && x.id === j.id} onClick={() => wide ? setSel(x.id) : openJob(x.id)} />)}
          </CardContent>
        </Card>
      </aside>
      {wide ? <div className="grid min-w-0 content-start gap-4">
        <Selected j={j} d={d} />
        <div data-tour-step-id="jobs-log">
          <Terminal key={j.id} jobId={j.id} running={j.state === 'rodando'} flow />
        </div>
      </div> : null}
    </div>
  </div>;
}

HadesCore.registerPage('jobs', Jobs);
})();
