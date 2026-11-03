/* Página Plugins (#/plugins): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela. */
(() => {
const { useState, useEffect, useRef, useCallback, I, cn, post, getJSON, Button, CardHeader, Dot, Fio,
  Switch, Input, Mono, Tip, Empty, Dialog, DialogHeader, DialogFooter, LinhaDeEstado, useApp, Loading, useTourPreview, ExampleSeal } = HadesCore;

// ------------------------------------------------------------------ plugins (os pacotes da Hades; $D/plugins.sh)
// A página só mostra e coleta: a regra (URL aceita, prévia, recusas) é do hades plugins, e o servidor confere o painel local
// e o token. O que muda roda como execução exclusiva; páginas e rotas do plugin são lidas na subida do painel.
// estado do pacote: ponto e palavra (o ponto só tem cor quando o plugin vale nesta instalação)
const PK_STATE = { ativo: ['ok', 'ativo'], desligado: ['idle', 'desligado'], 'outro-projeto': ['idle', 'de outro projeto'] };
// versão do núcleo que o pacote pede (identity.core): só ganha tom quando há algo a resolver
const PK_CORE = { ok: ['', 'compatível com este núcleo'], 'sem-core': ['text-warn', 'não declara a versão do núcleo'], fora: ['text-bad', 'pede outra versão do núcleo'], invalido: ['text-bad', 'versão do núcleo pedida é inválida'] };
const coreText = (c) => { const [tone, label] = PK_CORE[c?.state] || PK_CORE.invalido; return <span className={tone}>{label}{c?.core ? ` (${c.core})` : ''}</span>; };
const pkShort = (sha) => (sha || '').slice(0, 12);
function PkAdds({ adds }) {
  if (!adds) return null;
  const chips = [
    adds.keys.length && `${adds.keys.length} configuraç${adds.keys.length > 1 ? 'ões' : 'ão'}`,
    adds.steps.length && `${adds.steps.length} passo${adds.steps.length > 1 ? 's' : ''}`,
    adds.checks.length && `${adds.checks.length} checagem${adds.checks.length > 1 ? 's' : ''}`,
    adds.doctor && 'doctor',
    adds.pages.length && `página${adds.pages.length > 1 ? 's' : ''}: ${adds.pages.map((p) => p.label).join(', ')}`,
    adds.routes.length && `${adds.routes.length} rota${adds.routes.length > 1 ? 's' : ''}`,
    adds.actions.length && `${adds.actions.length} aç${adds.actions.length > 1 ? 'ões' : 'ão'}`,
  ].filter(Boolean);
  return chips.length ? <p className="t-body" aria-label="O que o plugin acrescenta">
    {chips.join(' · ')}
  </p>
    : <span className="t-body text-muted-foreground">Não acrescenta configurações, passos nem páginas.</span>;
}
function PkCode({ path, text, meta }) {
  return <details className="group border t-body">
    <summary className="flex min-h-10 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 py-2 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <I.ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
      <Mono className="min-w-0 flex-1 basis-48 break-all">
        {path}
      </Mono>
      <span className="t-meta text-muted-foreground">
        {meta}
      </span>
    </summary>
    {text == null ? <div className="px-3 pb-3 t-meta text-muted-foreground">Grande demais para a prévia: confira no repositório.</div>
      : <pre className="max-h-80 overflow-auto border-t bg-term p-3 t-code whitespace-pre text-term-foreground scrollbar-thin">
        {text}
      </pre>}
  </details>;
}
function PkRefusal({ r }) {
  return <div role="alert" className="grid gap-1 border border-bad/50 bg-bad/5 p-3 t-body">
    <div className="flex flex-wrap items-baseline gap-2 font-medium">
      <I.CircleX className="size-4 shrink-0 translate-y-0.5 text-bad" aria-hidden="true" />
      Recusado
      <Mono className="font-normal text-muted-foreground">
        {r.code}
      </Mono>
    </div>
    <div className="text-pretty text-muted-foreground">
      {r.error}
    </div>
  </div>;
}
function PkAddDialog({ open, onClose, onLaunched }) {
  const { toast } = useApp();
  const [url, setUrl] = useState('');
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState('');
  useEffect(() => { if (open) { setUrl(''); setPv(null); setBusy(''); } }, [open]);
  const preview = async (e) => {
    e?.preventDefault();
    setBusy('preview'); setPv(null);
    try { setPv(await post('/api/plugins', { op: 'preview-add', url: url.trim() })); }
    catch (err) { setPv({ ok: false, code: 'plugins_error', error: err.message }); }
    setBusy('');
  };
  const apply = async () => {
    setBusy('apply');
    try { const r = await post('/api/plugins', { op: 'add', id: pv.id, commit: pv.commit }); onLaunched(r.job, `Adicionando ${pv.name}`); onClose(); }
    catch (err) { toast({ kind: 'bad', title: 'Não deu para adicionar', desc: err.message }); }
    setBusy('');
  };
  const runs = pv?.runs || [];
  return <Dialog open={open} onClose={onClose} label="Adicionar plugin" className="sm:max-w-3xl">
    <DialogHeader icon={I.PackagePlus} title="Adicionar plugin" description="Clonado fora da pasta de pacotes, sem hooks. Nada roda antes de você conferir a prévia e confirmar o commit." />
    <form className="flex flex-wrap gap-2" onSubmit={preview}>
      <Input icon={I.Link} className="basis-72" autoFocus placeholder="https://github.com/<dono>/<plugin> ou git@github.com:<dono>/<plugin>" aria-label="URL do repositório do plugin" value={url} spellcheck="false" onInput={(e) => setUrl(e.target.value)} />
      <Button type="submit" variant="outline" icon={I.ScanSearch} loading={busy === 'preview'} disabled={!url.trim()}>Ver prévia</Button>
    </form>
    {pv && !pv.ok ? <PkRefusal r={pv} /> : null}
    {pv && pv.name ? <div className="grid max-h-[55vh] gap-3 overflow-y-auto pr-1 scrollbar-thin">
      <div className="grid gap-1.5 border p-3 t-body">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-semibold">
            {pv.name}
          </span>
          <span className="t-meta text-muted-foreground">
            {coreText(pv.core)}
            {pv.ok ? <span className={pv.activates ? 'font-medium text-foreground' : ''}>
              {' · '}
              {pv.activates ? 'ativa nesta instalação' : pv.mine ? 'fica desligado' : 'só guarda o pacote'}
            </span> : null}
          </span>
        </div>
        <div className="grid gap-0.5 text-muted-foreground">
          <span>
            {"Commit fixado "}
            <Mono className="break-all text-foreground">
              {pv.commit}
            </Mono>
            {" ("}
            {pv.branch}
            )
          </span>
          <span className="text-pretty">
            {pv.subject}
          </span>
          <span>
            {"Repo do projeto: "}
            <Mono>
              {pv.repo || '—'}
            </Mono>
          </span>
        </div>
      </div>
      <div className="grid gap-2">
        <h3 className="t-body-strong">O que vai executar</h3>
        {runs.length ? runs.map((f) => <PkCode key={f.path} path={f.path} text={f.text} meta={`${f.lines} linhas · sha256 ${f.sha256.slice(0, 12)}…`} />)
          : <span className="t-body text-muted-foreground">Nada (sem post-install.sh, panel/ nem doctor.sh).</span>}
        {pv.other?.length ? <div className="t-meta text-muted-foreground">
          {"Também vão para a pasta de dados: "}
          <Mono>
            {pv.other.join(', ')}
          </Mono>
        </div> : null}
      </div>
      <div className="grid gap-2">
        <h3 className="t-body-strong">O que acrescenta</h3>
        <PkAdds adds={pv.adds} />
      </div>
    </div> : null}
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>Cancelar</Button>
      <Button icon={I.ShieldCheck} loading={busy === 'apply'} disabled={!pv?.ok} onClick={apply}>
        {pv?.activates ? 'Instalar e ativar' : pv?.mine ? 'Instalar desligado' : pv?.ok ? 'Guardar o pacote' : 'Instalar'}
        {pv?.ok ? ' ' + pkShort(pv.commit) : ''}
      </Button>
    </DialogFooter>
  </Dialog>;
}
function PkUpdateDialog({ pack, onClose, onLaunched }) {
  const { toast } = useApp();
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!pack) return;
    let alive = true;
    setPv(null);
    post('/api/plugins', { op: 'preview-update', name: pack.name })
      .then((r) => alive && setPv(r), (err) => alive && setPv({ ok: false, code: 'plugins_error', error: err.message }));
    return () => { alive = false; };
  }, [pack]);
  const apply = async () => {
    setBusy(true);
    try { const r = await post('/api/plugins', { op: 'update', name: pack.name, commit: pv.target }); onLaunched(r.job, `Atualizando ${pack.name}`); onClose(); }
    catch (err) { toast({ kind: 'bad', title: 'Não deu para atualizar', desc: err.message }); }
    setBusy(false);
  };
  const can = pv?.ok && !pv.upToDate;
  return <Dialog open={!!pack} onClose={onClose} label="Atualizar plugin" className="sm:max-w-3xl">
    <DialogHeader icon={I.RefreshCw} title={`Atualizar ${pack?.name || ''}`} description="Mostra o que muda no que executa. Só aplica com a sua confirmação; depois reinstala e reinicia o painel." />
    {!pv ? <div className="flex items-center gap-2 t-body text-muted-foreground">
      <I.LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      Buscando novidades no repositório…
    </div> : null}
    {pv && !pv.ok ? <PkRefusal r={pv} /> : null}
    {pv?.upToDate ? <div className="flex items-center gap-2 t-body">
      <I.CircleCheck className="size-4 text-ok" aria-hidden="true" />
      {"Já está no mais novo de "}
      <Mono>
        {pv.upstream}
      </Mono>
      {" ("}
      {pkShort(pv.commit)}
      ).
    </div> : null}
    {pv?.commits ? <div className="grid max-h-[55vh] gap-3 overflow-y-auto pr-1 scrollbar-thin">
      <div className="t-body">
        <Mono>
          {pkShort(pv.commit)}
        </Mono>
        {" → "}
        <Mono>
          {pkShort(pv.target)}
        </Mono>
        {" · "}
        {pv.commits.length}
        {" commit"}
        {pv.commits.length > 1 ? 's' : ''}
        {' · '}
        <span className={pv.runsChanged ? 'font-medium text-warn' : 'text-muted-foreground'}>
          {pv.runsChanged ? 'muda o que executa' : 'não muda o que executa'}
        </span>
      </div>
      <pre className="overflow-auto border bg-term p-3 t-code whitespace-pre text-term-foreground scrollbar-thin">
        {pv.commits.join('\n')}
      </pre>
      {pv.stat ? <pre className="overflow-auto border bg-term p-3 t-code whitespace-pre text-term-foreground scrollbar-thin">
        {pv.stat}
      </pre> : null}
      {pv.diff ? <PkCode path="diff do que executa" text={pv.diff + (pv.cut ? '\n… (cortado: confira o resto no repositório)' : '')} meta={pv.cut ? 'cortado' : ''} /> : null}
    </div> : null}
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>
        {can ? 'Cancelar' : 'Fechar'}
      </Button>
      {can ? <Button icon={I.Download} loading={busy} onClick={apply}>
        {"Aplicar "}
        {pkShort(pv.target)}
      </Button> : null}
    </DialogFooter>
  </Dialog>;
}
function PkRemoveDialog({ pack, onClose, onLaunched }) {
  const { toast } = useApp();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTyped(''); }, [pack]);
  const go = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try { const r = await post('/api/plugins', { op: 'remove', name: pack.name, confirm: typed }); onLaunched(r.job, `Removendo ${pack.name}`); onClose(); }
    catch (err) { toast({ kind: 'bad', title: 'Remoção recusada', desc: err.message }); }
    setBusy(false);
  };
  return <Dialog open={!!pack} onClose={onClose} label="Remover plugin">
    <DialogHeader icon={I.Trash2} tone="danger" title={`Remover ${pack?.name || ''}?`} description={'Desliga o plugin (se for o ativo) e apaga o pacote. As configurações salvas ficam.\n\nPacote com mudança local ou commit não publicado é recusado.'} />
    <form className="grid gap-2" onSubmit={go}>
      <label className="t-body" htmlFor="pk-confirm">
        {"Digite "}
        <Mono className="font-semibold">
          {pack?.name}
        </Mono>
        {" para confirmar"}
      </label>
      <Input id="pk-confirm" autoFocus value={typed} spellcheck="false" autoComplete="off" onInput={(e) => setTyped(e.target.value)} />
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button type="submit" variant="destructive" icon={I.Trash2} loading={busy} disabled={typed !== pack?.name}>Remover</Button>
      </DialogFooter>
    </form>
  </Dialog>;
}
// um pacote é uma linha: nome e estado (com o liga/desliga quando ele é desta instalação), a origem fixada, o que pede
// atenção, o que acrescenta e onde configurar
function PkRow({ p, remote, onUpdate, onRemove, onToggle, busy, first, example }) {
  if (p.error) return <li className="grid gap-1 border-b py-3.5 t-body">
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-semibold">{p.name}</span>
      <span className="inline-flex items-center gap-1.5 t-meta-em text-bad"><I.CircleX className="size-3.5 translate-y-px" aria-hidden="true" />não deu para ler o pacote</span>
    </span>
    <span className="text-muted-foreground text-pretty">{p.error}</span>
  </li>;
  const [kind, word] = PK_STATE[p.state] || PK_STATE['outro-projeto'];
  // as chaves só estão no catálogo das Configurações com o plugin ligado nesta instalação
  const groups = p.state === 'ativo' ? [...new Set(p.adds.keys.map((k) => k.group))] : [];
  const flags = [
    p.dirty ? ['text-warn', I.FilePen, 'mudança local'] : null,
    p.unpublished ? ['text-warn', I.GitBranchPlus, `${p.unpublished} commit${p.unpublished > 1 ? 's' : ''} não publicado${p.unpublished > 1 ? 's' : ''}`] : null,
    p.behind ? ['text-info', I.ArrowDownToLine, `${p.behind} commit${p.behind > 1 ? 's' : ''} a atualizar`] : null,
  ].filter(Boolean);
  return <li data-tour-step-id={first ? 'plugins-pacote' : undefined} className="grid gap-2 border-b py-4">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">{p.name}</span>
        {example ? <ExampleSeal /> : null}
        <span className="t-body text-muted-foreground">{p.repo ? `de ${p.repo}` : 'sem repositório de projeto declarado'}</span>
      </span>
      <span data-tour-step-id={first ? 'plugins-estado-pacote' : undefined} className="ml-auto flex items-center gap-3">
        <span className={cn('inline-flex items-center gap-1.5 t-body', p.state === 'ativo' ? 'font-medium' : 'text-muted-foreground')}><Dot kind={kind} />{word}</span>
        {p.mine && !remote ? <Switch checked={p.state === 'ativo'} disabled={busy} label={(p.state === 'ativo' ? 'Desligar ' : 'Ligar ') + p.name} onChange={(v) => onToggle(p, v)} /> : null}
      </span>
    </div>
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 t-meta text-muted-foreground">
      <Mono className="min-w-0 break-all text-foreground/80">{p.url || '(sem remote)'}</Mono>
      <span aria-hidden="true">·</span>
      <Mono>{p.git ? `${p.branch} @ ${pkShort(p.commit)}` : 'não é um clone git'}</Mono>
      <span aria-hidden="true">·</span>
      {coreText(p.core)}
    </p>
    {flags.length || p.errors?.length ? <p data-tour-step-id={first ? 'plugins-avisos' : undefined} className="flex flex-wrap items-center gap-x-4 gap-y-1 t-meta-em">
      {flags.map(([tone, Icon, text]) => <span key={text} className={cn('inline-flex items-center gap-1.5', tone)}><Icon className="size-3.5" aria-hidden="true" />{text}</span>)}
      {p.errors?.length ? <Tip text={p.errors.slice(0, 3).join(' · ')}>
        <span tabIndex={0} className="inline-flex items-center gap-1.5 text-bad outline-none focus-visible:outline-2 focus-visible:outline-ring"><I.CircleX className="size-3.5" aria-hidden="true" />perfil inválido</span>
      </Tip> : null}
    </p> : null}
    <PkAdds adds={p.adds} />
    {groups.length || !remote ? <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 t-body">
      {groups.length ? <span className="mr-1 text-muted-foreground">Configurar:</span> : null}
      {groups.map((g, i) => <span key={g} className="inline-flex items-center">
        {i ? <span className="mr-1 text-muted-foreground" aria-hidden="true">·</span> : null}
        <a href={'#/config?q=' + encodeURIComponent(g)} className="underline underline-offset-3 hover:no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">{g}</a>
      </span>)}
      {remote ? null : <span data-tour-step-id={first ? 'plugins-acoes' : undefined} className="ml-auto flex flex-wrap gap-2">
        {p.git ? <Button size="xs" variant="outline" icon={I.RefreshCw} disabled={busy} onClick={() => onUpdate(p)}>{p.behind ? 'Atualizar' : 'Buscar atualização'}</Button> : null}
        <Button size="xs" variant="ghost-destructive" icon={I.Trash2} disabled={busy} onClick={() => onRemove(p)}>Remover</Button>
      </span>}
    </div> : null}
  </li>;
}
function Plugins({ d }) {
  const { toast, confirm, openJob, refresh } = useApp();
  const [real, setX] = useState(null);
  const exemplo = useTourPreview('plugins');
  const x = exemplo ? exemplo.list : real;
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [upd, setUpd] = useState(null);
  const [rem, setRem] = useState(null);
  const [mine, setMine] = useState({});
  const load = useCallback(() => getJSON('/api/plugins').then((r) => { if (r.ok) { setX(r); setErr(''); } else setErr(r.error || 'falha ao listar'); }, (e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  // fim de uma execução desta página: relê a lista; o painel reiniciou se o plugin ativo mudou (páginas e rotas novas)
  const prev = useRef({});
  useEffect(() => {
    for (const j of d.jobs) {
      if (mine[j.id] && prev.current[j.id] === 'rodando' && j.state !== 'rodando') {
        load();
        if (j.state === 'ok') toast({ kind: 'info', title: 'Plugins atualizados', desc: 'Páginas e rotas novas valem depois de recarregar.',
          action: { label: 'Recarregar a página', icon: I.RotateCw, onClick: () => location.reload() } });
      }
      prev.current[j.id] = j.state;
    }
  }, [d, mine, load, toast]);
  const launched = useCallback((job, title) => {
    setMine((m) => ({ ...m, [job]: true }));
    toast({ kind: 'busy', title: 'Execução iniciada', desc: title, action: { label: 'Ver execução', icon: I.SquareTerminal, onClick: () => openJob(job) } });
    setTimeout(refresh, 500);
  }, [toast, openJob, refresh]);
  const toggle = async (p, on) => {
    const c = on ? { title: `Ligar ${p.name}?`, description: 'Reinstala o kit com o plugin (post-install.sh incluído) e reinicia o painel.', icon: I.Power, confirmLabel: 'Ligar' }
      : { title: `Desligar ${p.name}?`, description: 'Tira o plugin da pasta de dados e reinicia o painel. Pacote e chaves ficam; reinstalar não religa.', icon: I.PowerOff, danger: true, confirmLabel: 'Desligar' };
    if (!(await confirm(c))) return;
    try { const r = await post('/api/plugins', { op: on ? 'enable' : 'disable', name: p.name }); launched(r.job, `${on ? 'Ligando' : 'Desligando'} ${p.name}`); }
    catch (e) { toast({ kind: 'bad', title: 'Não deu para ' + (on ? 'ligar' : 'desligar'), desc: e.message }); }
  };
  if (err && !x) return <Empty icon={I.CircleX} title="Não deu para listar os plugins.">
    {err}
  </Empty>;
  if (!x) return <Loading />;
  const busy = d.jobs.some((j) => j.state === 'rodando' && j.exclusive) || d.skillProcs.length > 0;
  // a prévia do tour só mostra: nenhuma ação dispara (o post também recusa)
  const locked = busy || !!exemplo;
  const mineRunning = d.jobs.some((j) => mine[j.id] && j.state === 'rodando');
  const active = x.packs.find((p) => p.state === 'ativo');
  const behind = x.packs.filter((p) => p.behind).length;
  const add = x.remote ? null : <Button size="sm" icon={I.PackagePlus} disabled={locked} onClick={() => setAdding(true)}>Adicionar por URL</Button>;
  return <div className="grid gap-6">
    <div data-tour-step-id="plugins-estado" className="grid gap-1.5">
      <LinhaDeEstado main={active ? `${active.name} ativo nesta instalação` : 'nenhum plugin ativo nesta instalação'}
        rest={[`núcleo ${x.version}`, x.repo ? `worktree de ${x.repo}` : null, behind ? `${behind} com atualização` : null]} />
      {x.remote ? <p role="note" className="flex items-start gap-2 t-body">
        <I.Eye className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
        <span>
          <span className="font-medium">Só leitura pelo acesso remoto.</span>
          <span className="text-muted-foreground"> Mudar plugins só pelo painel local.</span>
        </span>
      </p> : null}
      {err ? <p className="t-body text-bad" role="status">Sem atualizar: {err}. Mostrando a última lista.</p> : null}
    </div>
    <section data-tour-step-id="plugins-pacotes" className="grid gap-0" aria-label="Pacotes">
      <CardHeader title="Pacotes" summary={`${x.packs.length} em ${x.packsRoot}`} action={<>{exemplo ? <ExampleSeal /> : null}<span data-tour-step-id="plugins-adicionar" className="inline-flex">{add}</span></>} />
      {mineRunning ? <Fio s="fiando" className="mt-px" label="Aplicando a mudança nos plugins" /> : null}
      {busy && !x.remote ? <p className="flex items-center gap-2 border-b py-2.5 t-body text-muted-foreground">
        <Dot kind="busy" pulse />
        Execução exclusiva em andamento; as ações voltam quando acabar.
      </p> : null}
      {x.packs.length ? <ul>
        {x.packs.map((p, i) => <PkRow key={p.name} p={p} first={i === 0} example={!!exemplo} remote={x.remote} busy={locked} onUpdate={setUpd} onRemove={setRem} onToggle={toggle} />)}
      </ul> : <Empty icon={I.Puzzle} title="Nenhum plugin na pasta de pacotes.">
        O núcleo roda sem plugin.
        {x.remote ? null : ' Adicione o do seu projeto pela URL.'}
      </Empty>}
    </section>
    <p data-tour-step-id="plugins-comando" className="max-w-[75ch] t-meta text-muted-foreground">
      {"Um plugin por instalação: o pacote cujo "}
      <Mono>identity.repo</Mono>
      {" é o remote do worktree; os outros só ficam guardados. Linha de comando: "}
      <Mono className="break-words">
        {'plugins.sh list | add <url> | update <nome> | enable | disable | remove <nome> --confirm <nome>'}
      </Mono>
      .
    </p>
    <PkAddDialog open={adding} onClose={() => setAdding(false)} onLaunched={launched} />
    <PkUpdateDialog pack={upd} onClose={() => setUpd(null)} onLaunched={launched} />
    <PkRemoveDialog pack={rem} onClose={() => setRem(null)} onLaunched={launched} />
  </div>;
}

HadesCore.registerPage('plugins', Plugins);
})();
