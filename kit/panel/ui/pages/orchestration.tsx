/* Página Orquestração (#/orchestration): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela.
 * Perguntas ao dono primeiro; depois cada agente ativo como objeto com o fio do estado, os encerrados recolhidos, as
 * consolidações e as decisões tomadas sozinho. */
(() => {
const { useState, useEffect, I, cn, dur, getJSON, Button, Dot, Card, CardHeader, CardContent, Skeleton, Mono, Tip,
  Empty, Sheet, Fio, LinhaDeEstado, renderMd, Loading, CopyButton, useTourPreview, ExampleSeal } = HadesCore;

// estado do agente em palavras, o ponto e o fio (trabalhando fia; esperando você é o fio frouxo)
const AGENT_LIVE = { working: ['trabalhando', 'busy', 'fiando'], idle: ['ocioso', 'ok', 'parado'], blocked: ['espera por você', 'warn', 'frouxo'],
  unknown: ['sem sessão', 'idle', 'parado'], fora: ['fora do herdr', 'idle', 'parado'] };
const FILE_LABEL = { brief: 'Brief', questions: 'Perguntas', report: 'Relatório', handoff: 'Handoff' };
const ENDED = new Set(['done', 'archived']);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function OrchFile({ open, onClose, src }) {
  const [x, setX] = useState(null);
  useEffect(() => {
    if (!open || !src) return;
    setX(null);
    const url = src.file === 'terminal' ? `/api/orchestration/terminal?name=${encodeURIComponent(src.name)}`
      : `/api/orchestration/file?name=${encodeURIComponent(src.name)}&file=${src.file}`;
    getJSON(url).then(setX).catch((e) => setX({ text: String(e) }));
  }, [open, src]);
  const term = src?.file === 'terminal';
  return <Sheet open={open} onClose={onClose} wide icon={term ? I.SquareTerminal : I.FileText} title={src ? `${src.name} · ${term ? 'terminal' : FILE_LABEL[src.file]}` : ''} description={x?.file || (term ? 'últimas 160 linhas' : '')}>
    {!x ? <Skeleton className="h-40" /> : !x.text ? <Empty icon={I.FileX} title="Arquivo vazio ou inexistente" />
      : term ? <pre className="overflow-auto border bg-term p-3 t-code whitespace-pre-wrap text-term-foreground">
        {x.text}
      </pre>
      // o renderMd descarta o HTML cru do markdown (renderer html() vazio no app.tsx)
      : <article className="md" dangerouslySetInnerHTML={{ __html: renderMd(x.text) }} />}
  </Sheet>;
}

function Perguntas({ agents, show, example }) {
  const n = agents.reduce((a, x) => a + x.openQuestions.length, 0);
  return <Card data-tour-step-id="orchestration-perguntas">
    <CardHeader title="Perguntas ao dono" summary={`${plural(n, 'aberta', 'abertas')} · responda com hades agent answer`} />
    <CardContent>
      <ul className="-mt-2">
        {agents.flatMap((a) => a.openQuestions.map((q, i) => <li key={a.name + i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b py-2.5 last:border-b-0">
          <span className="flex w-32 shrink-0 items-center gap-1.5 truncate t-meta text-muted-foreground" title={a.name}>
            {example ? <ExampleSeal /> : null}
            {a.name}
          </span>
          <span className="min-w-0 flex-1 t-body">
            {q}
          </span>
          <Button size="xs" variant="ghost" onClick={() => show(a.name, 'questions')}>
            Ler e responder
            <I.ArrowRight />
          </Button>
          <CopyButton text={`hades agent answer ${a.name} ${q.split(/\s+/)[0]} ""`} label={`Copiar o comando de resposta de ${a.name}`} />
        </li>))}
      </ul>
    </CardContent>
  </Card>;
}

function AgentCard({ a, show, example }) {
  const [l, k, fio] = AGENT_LIVE[a.live] || [a.live || '—', 'idle', 'parado'];
  const answered = a.questions - a.openQuestions.length;
  return <li>
    <Card variant="object" className="h-full gap-3" data-tour-step-id="orchestration-agente">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate font-medium">
          {a.name}
        </span>
        {example ? <ExampleSeal /> : null}
        <span className="shrink-0 t-meta text-muted-foreground">
          {a.mode}
        </span>
        {a.card ? <Mono className="shrink-0 text-muted-foreground">
          {a.card}
        </Mono> : null}
        <span className={cn('ml-auto inline-flex shrink-0 items-center gap-1.5 t-meta', a.live === 'blocked' ? 'font-medium' : 'text-muted-foreground')}>
          <Dot kind={k} pulse={k === 'busy'} />
          {l}
        </span>
      </div>
      <Fio s={fio} label={`${a.name}: ${l}`} />
      {a.title ? <div className="truncate t-meta text-muted-foreground" title={a.title}>
        {a.title}
      </div> : null}
      <Tip text={a.worktree}>
        <Mono className="block truncate text-muted-foreground">
          {[a.branch || 'HEAD destacado', a.pr ? `#${a.pr}` : null].filter(Boolean).join(' · ')}
        </Mono>
      </Tip>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 t-meta">
        {a.openQuestions.length ? <span className="font-medium text-warn">{plural(a.openQuestions.length, 'pergunta aberta', 'perguntas abertas')}</span>
          : answered > 0 ? <span className="text-muted-foreground">{plural(answered, 'respondida', 'respondidas')}</span> : null}
        {a.reportDone ? <span className="inline-flex items-center gap-1 text-ok">
          <I.CircleCheck className="size-3.5" aria-hidden="true" />
          relatório pronto: abra em Relatório
        </span> : null}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1 border-t pt-3">
        {a.files.map((f) => <Button key={f} size="xs" variant="ghost" onClick={() => show(a.name, f)}>
          {FILE_LABEL[f]}
        </Button>)}
        <span className="ml-auto flex items-center gap-1">
          {a.pane ? <a href={'#/herdr?pane=' + encodeURIComponent(a.pane)} className="inline-flex h-7 items-center gap-1 px-2 t-meta-em hover:bg-accent outline-none focus-visible:outline-2 focus-visible:outline-ring">
            Abrir no Herdr
            <I.ArrowUpRight className="size-3" aria-hidden="true" />
          </a> : null}
          {a.live !== 'fora' ? <Tip text="Terminal do agente">
            <Button variant="ghost" size="icon-sm" aria-label="Terminal do agente" icon={I.SquareTerminal} onClick={() => show(a.name, 'terminal')} />
          </Tip> : null}
        </span>
      </div>
    </Card>
  </li>;
}

function Encerrados({ agents, show, example }) {
  return <details className="group" data-tour-step-id="orchestration-encerrados">
    <summary className="flex cursor-pointer list-none items-baseline gap-2 border-b pb-2.5 outline-none focus-visible:outline-2 focus-visible:outline-ring">
      <h2 className="t-section">
        Encerrados
      </h2>
      <span className="t-label text-muted-foreground">
        {plural(agents.length, 'agente', 'agentes')}
      </span>
      <I.ChevronDown className="ml-auto size-4 self-center text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
    </summary>
    <ul>
      {agents.map((a) => <li key={a.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b py-2 t-body last:border-b-0">
        <span className="w-40 shrink-0 truncate font-medium" title={a.name}>
          {a.name}
        </span>
        {example ? <ExampleSeal /> : null}
        <Mono className="min-w-0 flex-1 truncate text-muted-foreground">
          {[a.branch, a.pr ? `#${a.pr}` : null].filter(Boolean).join(' · ')}
        </Mono>
        <span className="t-meta text-muted-foreground">
          {a.state === 'archived' ? 'arquivado' : 'concluído'}
        </span>
        {a.files.map((f) => <Button key={f} size="xs" variant="ghost" onClick={() => show(a.name, f)}>
          {FILE_LABEL[f]}
        </Button>)}
      </li>)}
    </ul>
  </details>;
}

function Orchestration() {
  const [real, setReal] = useState(null);
  // tour da página rodando: a página lê os dados de exemplo no lugar dos reais
  const exemplo = useTourPreview('orchestration');
  const x = exemplo ?? real;
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let alive = true;
    const f = () => getJSON('/api/orchestration').then((r) => alive && setReal(r)).catch(() => {});
    f(); const t = setInterval(f, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!x) return <Loading />;
  const active = x.agents.filter((a) => !ENDED.has(a.state));
  const ended = x.agents.filter((a) => ENDED.has(a.state));
  const asking = active.filter((a) => a.openQuestions.length);
  const openQ = asking.reduce((n, a) => n + a.openQuestions.length, 0);
  const reports = active.filter((a) => a.reportDone).length;
  const working = active.filter((a) => a.live === 'working').length;
  // o exemplo não tem arquivo nem terminal para abrir
  const show = (name, file) => { if (!exemplo) setSrc({ name, file }); };
  // quem espera por você primeiro, depois quem trabalha
  const order = { blocked: 0, working: 1 };
  const sorted = [...active].sort((a, b) => (order[a.live] ?? 2) - (order[b.live] ?? 2));
  return <div className="grid gap-8">
    <LinhaDeEstado main={openQ ? plural(openQ, 'pergunta aberta', 'perguntas abertas') : 'nenhuma pergunta aberta'}
      rest={[`${plural(active.length, 'agente ativo', 'agentes ativos')}, ${working} trabalhando`, reports ? `${plural(reports, 'relatório pronto', 'relatórios prontos')}: abra em Relatório no cartão` : null,
        x.consolidations.length ? plural(x.consolidations.length, 'consolidação', 'consolidações') : null]} />
    {openQ ? <Perguntas agents={asking} show={show} example={!!exemplo} /> : null}
    <Card data-tour-step-id="orchestration-agentes">
      <CardHeader title="Agentes" summary={`<worktree>/${x.reportsDir}`} />
      <CardContent>
        {active.length ? <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {sorted.map((a) => <AgentCard key={a.name} a={a} show={show} example={!!exemplo} />)}
        </ul>
        : <Empty icon={I.Bot} title="Nenhum agente ativo">
          {"Aloque com "}
          <code>hades agent new</code>
          {" ou "}
          <code>hades agent adopt</code>
          {"."}
        </Empty>}
      </CardContent>
    </Card>
    <Card data-tour-step-id="orchestration-consolidacoes">
      <CardHeader title="Consolidações" summary="gate único, merge único" />
      <CardContent>
        {x.consolidations.length ? <ul className="-mt-2">
          {x.consolidations.map((c) => <li key={c.branch} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b py-2.5 t-body last:border-b-0">
            {exemplo ? <ExampleSeal /> : null}
            <Dot kind={c.verifyOk ? 'ok' : c.verifiedAt ? 'bad' : 'idle'} className="self-center" />
            <Mono className="min-w-0 flex-1 truncate">
              {c.branch}
            </Mono>
            <Mono className="text-muted-foreground">
              {(c.members || []).map((m) => '#' + m).join(' ')}
            </Mono>
            <span className={cn('t-meta', c.verifiedAt && !c.verifyOk ? 'text-bad' : 'text-muted-foreground')}>
              {c.verifiedAt ? `${c.verifyOk ? 'todas as PRs contidas na branch' : 'falta merge'} · há ${dur(Date.now() / 1000 - Date.parse(c.verifiedAt) / 1000)}` : 'ainda não conferida'}
            </span>
          </li>)}
        </ul>
        : <Empty icon={I.GitMerge} title="Nenhuma consolidação registrada" />}
      </CardContent>
    </Card>
    <Card data-tour-step-id="orchestration-decisoes">
      <CardHeader title="Decisões autônomas" summary={`nível ${x.autonomy?.level ?? 0}, ${x.autonomy?.label || 'Pergunta tudo'}`}
        description="Decisões tomadas sozinho pela opção recomendada. O nível está nas Configurações." />
      <CardContent>
        {x.decisions?.length ? <ul className="-mt-2">
          {x.decisions.map((d) => <li key={d.ts + d.question} className="grid gap-1 border-b py-3 t-body last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="min-w-0 flex-1 font-medium text-pretty">
                {exemplo ? <ExampleSeal className="mr-2" /> : null}
                {d.question}
              </span>
              <span className="t-data text-muted-foreground">
                {`nível atual ${d.level} (exige ${d.needed}) · ${new Date(d.ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`}
              </span>
            </div>
            <div className="text-pretty">
              {'→ ' + d.chosen}
            </div>
            {d.alternatives.length ? <div className="t-meta text-muted-foreground">
              {'Alternativas: ' + d.alternatives.join(' · ')}
            </div> : null}
          </li>)}
        </ul>
        : <Empty icon={I.Scale} title="Nenhuma decisão autônoma" />}
      </CardContent>
    </Card>
    {ended.length ? <Encerrados agents={ended} show={show} example={!!exemplo} /> : null}
    <OrchFile open={!!src} onClose={() => setSrc(null)} src={src} />
  </div>;
}

HadesCore.registerPage('orchestration', Orchestration);
})();
