/* Página Qualidade (#/quality): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela. */
(() => {
const { useState, useEffect, useCallback, I, cn, post, getJSON, Button, Card, CardHeader, CardContent, Switch, Input,
  Progress, Mono, Tip, Empty, Dot, Menu, Choice, useWide, LinhaDeEstado, useApp, cfgNorm, Loading } = HadesCore;

// ------------------------------------------------------------------ Qualidade (catálogo global de regras, reference/quality.md)
const Q_SEV = { bloqueante: ['bad', 'bloqueante', 'font-medium text-bad'], alta: ['warn', 'alta', 'text-foreground'], media: ['info', 'média', 'text-muted-foreground'], baixa: ['idle', 'baixa', 'text-muted-foreground'] };
const Q_GROUP = { linguagem: 'Linguagem', framework: 'Framework', praticas: 'Práticas', estilo: 'Estilo', testes: 'Testes', banco: 'Banco' };
const Q_PACK = { on: 'ligado', off: 'desligado', partial: 'parcial' };
const ROW = 'border-b border-l-2 border-l-transparent transition-colors hover:bg-accent/60';
const ROW_ON = 'border-l-foreground bg-accent/40';
// pacotes (reference/quality.md §Pacotes): o interruptor grava a escolha de cada regra; o estado sai das regras
function QualityPacks({ packs, pk, setPk, busy, act }) {
  if (!packs?.length) return null;
  const on = packs.filter((k) => k.state === 'on').length;
  return <Card data-tour-step-id="quality-pacotes" className="gap-0">
    <CardHeader title="Pacotes" summary={`${on} de ${packs.length} ligados`}
      description="Mudar uma regra à parte deixa o pacote parcial." />
    <CardContent>
      <ul className="grid xl:grid-cols-2 xl:gap-x-8">
        {packs.map((k) => <li key={k.id} className={cn(ROW, 'flex items-start gap-3 py-3 pr-1 pl-3', pk === k.id && ROW_ON)}>
          <div className="pt-0.5">
            <Switch checked={k.state === 'on'} disabled={busy === 'p-' + k.id || !k.total} label={'Pacote ' + k.title + (k.state === 'partial' ? ' (parcial: ligar completa)' : '')} onChange={(v) => act('p-' + k.id, { action: v ? 'on' : 'off', pack: k.id }, `${k.title} ${v ? 'ligado' : 'desligado'}`)} />
          </div>
          <div className="grid min-w-0 flex-1 gap-1.5">
            <p className="flex flex-wrap items-baseline gap-x-2 t-body">
              <span className="font-medium">
                {k.title}
              </span>
              <span className="t-meta text-muted-foreground">
                {Q_PACK[k.state] + (k.source === 'usuario' ? ' · criado por você' : '')}
              </span>
            </p>
            {k.text ? <p className="t-meta text-muted-foreground">
              {k.text}
            </p> : null}
            <div className="flex items-center gap-3 t-meta text-muted-foreground tnum">
              <Progress className="max-w-40" value={k.total ? (k.on / k.total) * 100 : 0} />
              <span className="shrink-0">
                {`${k.on} de ${k.total} ligadas`}
                {k.missing?.length ? <span className="text-warn">
                  {` · ${k.missing.length} fora do catálogo`}
                </span> : null}
              </span>
            </div>
          </div>
          <Button size="xs" variant="ghost" aria-pressed={pk === k.id} icon={pk === k.id ? I.FilterX : I.Filter} onClick={() => setPk(pk === k.id ? '' : k.id)}>
            {pk === k.id ? 'Tirar filtro' : 'Filtrar'}
          </Button>
        </li>)}
      </ul>
    </CardContent>
  </Card>;
}

function Rule({ r, busy, act, first }) {
  const [kind, label, tone] = Q_SEV[r.effSeverity] || Q_SEV.media;
  const off = r.state === 'off';
  const meta = [...(r.tags || [])];
  // hoje a severidade só ordena o bloco de regras injetado no brief; quem barra de verdade é o Cerberus
  const sevTip = `${label}: só ordena o bloco de regras injetado no brief (mais grave primeiro). Não barra nada sozinha.`;
  return <li data-tour-step-id={first ? 'quality-regra' : undefined} className={cn(ROW, 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-2.5 pr-1 pl-3 md:grid-cols-[auto_minmax(0,17rem)_minmax(0,1fr)_6.5rem] md:gap-x-4')}>
    <div className="row-span-3 pt-0.5 md:row-span-1">
      <Switch checked={!off} disabled={busy === r.id} label={'Regra ' + r.id} onChange={(v) => act(r.id, { action: v ? 'on' : 'off', ids: [r.id] })} />
    </div>
    <div className="flex min-w-0 items-baseline justify-between gap-3 md:block">
      <span className={cn('font-mono t-label break-all', off ? 'text-muted-foreground' : 'font-medium')}>
        {r.id}
      </span>
      <Tip text={sevTip}>
        <span className={cn('inline-flex shrink-0 items-center gap-1.5 t-meta md:hidden', tone)}>
          <Dot kind={kind} />
          {label}
        </span>
      </Tip>
    </div>
    <div className="min-w-0">
      <p className={cn('t-body', off && 'text-muted-foreground')}>
        {r.text}
      </p>
      {meta.length || r.check || r.raisedBy || r.chosen ? <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 t-meta text-muted-foreground">
        {r.raisedBy ? <span className="text-foreground">
          {'severidade subida por ' + r.raisedBy}
        </span> : null}
        {r.chosen ? <span className="text-foreground">mudada por você</span> : null}
        {r.check ? <Tip text={'Sugerida ao agente junto da regra; a Hades não a roda sozinha: ' + (r.check.kind === 'grep' ? `grep -E '${r.check.pattern}' em ${r.check.files || '*'}` : r.check.cmd)}>
          <span tabIndex={0} className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-3 outline-none focus-visible:outline-2 focus-visible:outline-ring">
            <I.ScanSearch className="size-3" aria-hidden="true" />
            checagem sugerida
          </span>
        </Tip> : null}
        {meta.map((t) => <span key={t} className="font-mono">
          {t}
        </span>)}
      </p> : null}
    </div>
    <Tip text={sevTip}>
      <span className={cn('hidden items-center gap-1.5 self-start pt-0.5 t-meta md:inline-flex', tone)}>
        <Dot kind={kind} />
        {label}
      </span>
    </Tip>
  </li>;
}

function Quality() {
  const { toast } = useApp();
  const wide = useWide(1024);
  const [x, setX] = useState(null);
  const [err, setErr] = useState(false);
  const [q, setQ] = useState('');
  const [grp, setGrp] = useState('');
  const [pk, setPk] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => { setErr(false); getJSON('/api/quality').then(setX).catch(() => setErr(true)); }, []);
  useEffect(() => { load(); }, [load]);
  if (!x) return err ? <Empty icon={I.CircleX} title="Não foi possível ler o catálogo.">
    <Button size="xs" variant="outline" icon={I.RefreshCw} onClick={load}>Tentar de novo</Button>
  </Empty> : <Loading />;
  const act = async (key, body, ok) => {
    setBusy(key);
    try { setX(await post('/api/quality', body)); if (ok) toast({ kind: 'ok', title: ok }); }
    catch (e) { toast({ kind: 'bad', title: 'Não foi possível salvar', desc: e.message }); }
    setBusy('');
  };
  const terms = cfgNorm(q).split(/\s+/).filter(Boolean);
  const pack = (x.packs || []).find((k) => k.id === pk);
  const inPack = pack ? new Set(pack.rules) : null;
  const matches = (r) => (!inPack || inPack.has(r.id)) && terms.every((t) => cfgNorm([r.id, r.text, r.group, r.effSeverity, (r.tags || []).join(' ')].join(' ')).includes(t));
  const found = x.rules.filter(matches);
  const shown = found.filter((r) => !grp || r.group === grp);
  const on = x.rules.filter((r) => r.state === 'on').length;
  const chosen = x.rules.filter((r) => r.chosen).length;
  const groups = x.groups.filter((g) => shown.some((r) => r.group === g));
  const packsOn = (x.packs || []).filter((k) => k.state === 'on').length, packsPartial = (x.packs || []).filter((k) => k.state === 'partial').length;
  const blocking = x.rules.filter((r) => r.state === 'on' && r.effSeverity === 'bloqueante').length;
  const filtered = !!(terms.length || grp || pack);   // com filtro o cartão mostra parte do grupo, a ação age no grupo todo
  const clear = () => { setQ(''); setGrp(''); setPk(''); };
  return <div className="grid gap-8">
    <div data-tour-step-id="quality-estado">
      <LinhaDeEstado main={`${on} de ${x.rules.length} regras ligadas`}
      rest={[blocking ? `${blocking} bloqueante${blocking > 1 ? 's' : ''}` : null,
        x.packs?.length ? `${packsOn} pacote${packsOn === 1 ? '' : 's'} ligado${packsOn === 1 ? '' : 's'}, ${packsPartial} parcia${packsPartial === 1 ? 'l' : 'is'}` : null,
        chosen ? `${chosen} mudada${chosen > 1 ? 's' : ''} por você` : 'tudo no padrão',
        x.conflicts.length ? <span key="conf" className="text-warn">{`${x.conflicts.length} conflito${x.conflicts.length > 1 ? 's' : ''} com ${x.project || 'o projeto'}`}</span> : null]} />
    </div>
    {x.conflicts.length ? <Card data-tour-step-id="quality-conflitos" className="gap-0">
      <CardHeader title="Conflitos com o projeto" summary={`o perfil de ${x.project || 'projeto'} contraria regras ligadas`}
        description="A regra continua ligada até você decidir. Nos casos em que o projeto pede menos, vale o catálogo." />
      <CardContent>
        <ul>
          {x.conflicts.map((c) => <li key={c.id + c.kind} className="grid gap-1 border-b py-2.5 t-body">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono t-label">
                {c.id}
              </span>
              <span className="inline-flex items-center gap-1.5 t-meta text-warn">
                <Dot kind="warn" />
                {c.kind}
              </span>
            </p>
            <p className="text-muted-foreground text-pretty">
              {c.detail + '.' + (c.note ? ' ' + c.note : '')}
            </p>
          </li>)}
        </ul>
      </CardContent>
    </Card> : null}
    <QualityPacks packs={x.packs} pk={pk} setPk={setPk} busy={busy} act={act} />
    <section aria-label="Catálogo de regras" className="grid gap-6">
      <div className="sticky top-14 z-20 -mx-2 flex flex-wrap items-center gap-2 border-b bg-background px-2 py-2">
        <Input data-tour-step-id="quality-busca" icon={I.Search} className="basis-56 md:max-w-xs" placeholder="Buscar regra, tag ou severidade" aria-label="Buscar regra" value={q} spellcheck="false" onInput={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }} />
        <Choice wide={wide} label="Grupo" value={grp} onChange={setGrp} items={[{ value: '', label: 'Todos', count: found.length },
          ...x.groups.map((g) => ({ value: g, label: Q_GROUP[g] || g, count: found.filter((r) => r.group === g).length }))]} />
        {pack ? <Button size="sm" variant="outline" icon={I.X} aria-label={'Tirar o filtro do pacote ' + pack.title} onClick={() => setPk('')}>
          {'Pacote: ' + pack.title}
        </Button> : null}
        <span className="ml-auto flex items-center gap-2">
          {filtered ? <span className="t-meta text-muted-foreground tnum" aria-live="polite">
            {`${shown.length} de ${x.rules.length}`}
          </span> : null}
          <span data-tour-step-id="quality-todas" className="inline-flex"><Menu label="Ações em todas as regras" items={[
            { label: 'Ligar todas', icon: I.ToggleRight, onClick: () => act('all-on', { action: 'on', all: true }, 'Todas ligadas') },
            { label: 'Desligar todas, inclusive as bloqueantes', icon: I.ToggleLeft, onClick: () => act('all-off', { action: 'off', all: true }, 'Todas desligadas') },
            { label: 'Voltar ao padrão: desfaz as suas escolhas', icon: I.RotateCcw, onClick: () => act('reset', { action: 'reset', ids: [] }, 'Padrão restaurado') }]} /></span>
        </span>
      </div>
      {groups.map((g, gi) => { const all = x.rules.filter((r) => r.group === g); return <Card key={g} data-tour-step-id={gi === 0 ? 'quality-grupo' : undefined} className="gap-0">
        <CardHeader title={Q_GROUP[g] || g} summary={`${all.filter((r) => r.state === 'on').length} de ${all.length} ligadas`} action={<>
          <Button size="xs" variant="ghost" loading={busy === 'g-on-' + g} onClick={() => act('g-on-' + g, { action: 'on', group: g })}>{filtered ? `Ligar as ${all.length} do grupo` : 'Ligar grupo'}</Button>
          <Button size="xs" variant="ghost" loading={busy === 'g-off-' + g} onClick={() => act('g-off-' + g, { action: 'off', group: g })}>{filtered ? `Desligar as ${all.length} do grupo` : 'Desligar grupo'}</Button>
        </>} />
        <CardContent>
          <ul>
            {shown.filter((r) => r.group === g).map((r, ri) => <Rule key={r.id} r={r} first={gi === 0 && ri === 0} busy={busy} act={act} />)}
          </ul>
        </CardContent>
      </Card>; })}
      {shown.length ? null : <Empty icon={I.SearchX} title={q ? `Nenhuma regra com "${q}".` : 'Nenhuma regra neste filtro.'}>
        <Button size="xs" variant="outline" onClick={clear}>Limpar busca e filtros</Button>
      </Empty>}
    </section>
    <p data-tour-step-id="quality-comando" className="t-meta text-muted-foreground">
      {"Escolhas em "}
      <Mono>
        {x.choices}
      </Mono>
      {" (só o que difere do padrão). Linha de comando: "}
      <Mono>
        {'hades quality list | packs | on | off [--pack <id>] | reset'}
      </Mono>
      .
    </p>
  </div>;
}

HadesCore.registerPage('quality', Quality);
})();
