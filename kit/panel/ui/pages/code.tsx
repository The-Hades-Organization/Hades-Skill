/* Página Branch e PRs (#/code): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela. */
(() => {
const { useState, useEffect, useMemo, useCallback, I, cn, Button, Card, CardHeader, CardContent,
  Empty, Mono, CopyButton, Menu, Tip, Dot, Fio, LinhaDeEstado, useApp, useActions, ago, Segmented, PrPicker } = HadesCore;

const plural = (n, one, many) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
// a trança: a base e cada PR são fios que se juntam num nó, a hades/local. Fio medido = já está na branch;
// frouxo = entra quando salvar/atualizar; parado = sai. O nó fica vazado enquanto a trança não foi refeita.
const FIO_ROW = 50, FIO_Y = 31;
const STROKE = { medido: { stroke: 'var(--foreground)', strokeOpacity: 0.85, strokeWidth: 1.5 },
  frouxo: { stroke: 'var(--muted-foreground)', strokeOpacity: 0.75, strokeWidth: 2, strokeDasharray: '3 4' },
  parado: { stroke: 'var(--border-strong)', strokeWidth: 1 } };
function Tranca({ rows, onToggle }) {
  const h = rows.length * FIO_ROW, mid = (FIO_Y + (rows.length - 1) * FIO_ROW + FIO_Y) / 2;
  const atada = rows.every((r) => r.s === 'medido');
  return <div className="flex">
    <ul className="min-w-0 flex-1">
      {rows.map((r) => <li key={r.key} className="group relative" style={{ height: FIO_ROW }}>
        <div className="absolute inset-x-0 top-1 flex h-6 items-center gap-2 t-body">
          <span className={cn('shrink-0 font-mono t-label tnum', r.s === 'parado' && 'text-muted-foreground line-through')}>
            {r.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {r.title}
          </span>
          <span className={cn('shrink-0 t-meta', r.s === 'medido' ? 'text-muted-foreground' : 'text-foreground')}>
            {r.note}
          </span>
          {r.n != null ? <Tip text={r.s === 'parado' ? 'Manter na branch' : 'Tirar da seleção'}>
            <button type="button" onClick={() => onToggle(r.n)} aria-label={r.s === 'parado' ? `Manter #${r.n}` : `Tirar #${r.n} da seleção`} className="relative grid size-5 shrink-0 place-items-center text-muted-foreground transition-colors hover:text-foreground cursor-pointer outline-none after:absolute after:-inset-2 focus-visible:outline-2 focus-visible:outline-ring max-md:after:-inset-3 md:invisible md:group-hover:visible md:focus-visible:visible">
              {r.s === 'parado' ? <I.Undo2 className="size-3.5" aria-hidden="true" /> : <I.X className="size-3.5" aria-hidden="true" />}
            </button>
          </Tip> : null}
        </div>
        <div className="absolute inset-x-0 flex h-0 items-center" style={{ top: FIO_Y }}>
          <Fio s={r.s} label={`${r.label}: ${r.note}`} />
        </div>
      </li>)}
    </ul>
    <svg width="44" height={h} aria-hidden="true" className="shrink-0 overflow-visible">
      {rows.map((r, i) => { const y = i * FIO_ROW + FIO_Y; return <path key={r.key} d={`M0 ${y} C 22 ${y}, 18 ${mid}, 38 ${mid}`} fill="none" style={STROKE[r.s]} />; })}
      <rect x="35.5" y={mid - 3.5} width="7" height="7" transform={`rotate(45 39 ${mid})`} style={atada ? { fill: 'var(--foreground)' } : { fill: 'var(--background)', stroke: 'var(--foreground)', strokeWidth: 1.5 }} />
    </svg>
  </div>;
}

// o que Atualizar faz de fato (rebuild-branch: git reset --hard na base); sem checagem de árvore suja
const REFAZ = 'Refaz a hades/local do zero (git reset --hard na base): commits e alterações feitos direto nela se perdem; as resoluções de conflito voltam pelo rerere.';

function Base({ d }) {
  const run = useActions();
  const { openDialog } = useApp();
  const b = d.branch || {};
  const dev = b.develop || {};   // o campo segue "develop"; a base vem do perfil (branch.base > origin/<flow.base>)
  const bn = b.baseName || 'develop', br = b.base || 'origin/develop';
  const busy = d.jobs.some((j) => j.state === 'rodando' && j.exclusive) || d.skillProcs.length > 0;
  return <Card data-tour-step-id="code-base">
    <CardHeader title={`Base: ${bn}`} summary={'último fetch ' + (dev.fetchedAt ? ago(dev.fetchedAt) : 'nunca')}
      action={<Button size="sm" variant="outline" icon={I.CloudDownload} disabled={busy} onClick={() => run({ action: 'fetch' }, { title: 'Fetch da base?', description: 'git fetch origin --prune. Só atualiza a referência da base: não muda a branch nem o ambiente.', icon: I.CloudDownload })}>Fetch da base</Button>} />
    <CardContent className="grid gap-3">
      {dev.sha ? <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-x-2 t-meta text-muted-foreground">
          <Mono>
            {br}
          </Mono>
          <Mono className="text-foreground">
            {dev.sha.slice(0, 10)}
          </Mono>
          <CopyButton text={dev.sha} label="Copiar SHA da base" />
          {dev.date ? <span className="tnum">
            {new Date(dev.date).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </span> : null}
        </div>
        <p className="t-body break-words">
          {dev.subject}
        </p>
      </div> : <Empty icon={I.GitBranch} title={`${br} não encontrada.`}>
        Rode o Fetch.
      </Empty>}
      {dev.newCommits ? <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3 t-body">
        <span className="inline-flex min-w-0 flex-1 basis-56 items-baseline gap-2">
          <Dot kind="warn" className="translate-y-px" />
          <span className="text-pretty">
            <span className="font-medium tnum">
              {plural(dev.newCommits, 'commit', 'commits')}
            </span>
            {` na ${bn} que a hades/local ainda não tem.`}
          </span>
        </span>
        {b.headsChanged ? null : <Button size="xs" variant="outline" icon={I.RefreshCw} disabled={busy} title={REFAZ} onClick={() => openDialog('update')}>Atualizar</Button>}
      </div> : dev.newCommits === 0 ? <p className="flex items-baseline gap-2 border-t pt-3 t-body text-muted-foreground">
        <Dot kind="ok" className="translate-y-px" />
        {`Em dia com a ${bn}.`}
      </p> : null}
    </CardContent>
  </Card>;
}

function Code({ d }) {
  const { openLog, openDialog } = useApp();
  const run = useActions();
  const b = d.branch || {};
  const listKey = (b.prsList || []).join(' ');
  const current = useMemo(() => new Set((b.prsList || []).filter((x) => /^\d+$/.test(x)).map(Number)), [listKey]);
  const applied = useMemo(() => new Set((b.prs || []).map((p) => Number(p.number))), [(b.prs || []).map((p) => p.number).join(',')]);
  const [mode, setMode] = useState(b.developOnly ? 'develop' : 'prs');
  const [sel, setSel] = useState(() => new Set(current));
  const [dirty, setDirty] = useState(false);
  const [seen, setSeen] = useState(() => new Map());
  useEffect(() => { if (!dirty) { setSel(new Set(current)); setMode(b.developOnly ? 'develop' : 'prs'); } }, [current, b.developOnly, dirty]);
  const toggle = (n) => { setDirty(true); setSel((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; }); };
  const onItems = useCallback((items) => setSeen((m) => { const x = new Map(m); items.forEach((p) => x.set(p.number, p.title)); return x; }), []);
  const bn = b.baseName || 'develop';   // o modo segue "develop"; o texto diz a base do perfil
  const dev = b.develop || {};
  // selos de compilado só quando o plugin diz o que pede rebuild (services.paths, web.paths); snapshot sem paths: mostra
  const tokens = (b.prsList || []).filter((x) => !/^\d+$/.test(x) && x !== '-0');
  const busy = d.jobs.some((j) => j.state === 'rodando' && j.exclusive) || d.skillProcs.length > 0;
  const save = async (apply) => {
    const body = { action: 'select', mode, prs: [...sel], apply };
    const what = mode === 'develop' ? `só a ${bn}` : `${bn} + ${[...sel].map((n) => '#' + n).join(' ')}`;
    if (await run(body, { title: apply ? 'Salvar e atualizar o ambiente?' : 'Salvar a seleção?', icon: apply ? I.RefreshCw : I.Save,
      description: `Conjunto: ${what}.${tokens.length && mode === 'prs' ? `\nSai do prs.list: ${tokens.join(' ')} (@me é dinâmico: salvar o troca por lista fixa, e PRs novas deixam de entrar sozinhas).` : ''}\nPR empilhada traz a stack abaixo.${apply ? '\nDepois roda o update.sh (refaz a branch, recompila, reinicia). ' + REFAZ : '\nO ambiente só muda ao Atualizar.'}` })) setDirty(false);
  };
  const picked = mode === 'prs' ? sel : new Set();
  const nums = [...new Set([...picked, ...applied])].sort((a, z) => a - z);
  const info = (n) => (b.prs || []).find((p) => Number(p.number) === n);
  const rows = [{ key: 'base', label: bn, title: dev.sha ? dev.sha.slice(0, 10) : b.base || 'origin/develop', note: 'base', s: 'medido' },
    ...nums.map((n) => { const on = picked.has(n), was = applied.has(n), p = info(n);
      return { key: n, n, label: '#' + n, title: (p && p.base !== '-' ? `sobre #${p.base} · ` : '') + (p?.title || seen.get(n) || ''),
        s: on && was ? 'medido' : on ? 'frouxo' : 'parado',
        note: on && was ? 'na branch' : on ? (current.has(n) ? 'entra ao atualizar' : 'entra ao salvar e atualizar') : (dirty ? 'sai ao salvar e atualizar' : 'sai ao atualizar') }; })];
  const svc = b.services || {}, web = b.web || {};
  const nApplied = b.developOnly ? 0 : applied.size;
  const blocked = mode === 'prs' && !sel.size;
  const pendente = !dirty && ([...current].some((n) => !applied.has(n)) || [...applied].some((n) => !current.has(n)));
  return <div className="grid gap-8">
    <LinhaDeEstado main={nApplied ? `hades/local = ${bn} + ${plural(nApplied, 'PR', 'PRs')}` : `hades/local = só a ${bn}`}
      rest={[dev.newCommits ? <span key="novos" className="text-warn">{plural(dev.newCommits, 'commit', 'commits') + ` na ${bn} que a hades/local não tem`}</span>
        : dev.newCommits === 0 ? `em dia com a ${bn}` : null,
      b.conflicts ? <span key="conf" className="text-bad">{plural(b.conflicts, 'conflito', 'conflitos')}</span> : null,
      dirty ? 'seleção alterada, falta salvar' : null]} />
    <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card data-tour-step-id="code-selecao">
        <CardHeader title="O que entra na branch"
          action={<Segmented value={mode} onChange={(v) => { setMode(v); setDirty(true); }} items={[{ value: 'develop', label: `Só ${bn}` }, { value: 'prs', label: `${bn} + PRs` }]} />} />
        <CardContent>
          {mode === 'develop' ? <Empty icon={I.GitBranch} title={`${bn} pura.`}>
            Sem PRs por cima.
          </Empty> : <PrPicker sel={sel} toggle={toggle} applied={applied} inSet={current} onItems={onItems} />}
        </CardContent>
      </Card>
      <div className="grid content-start gap-8 xl:sticky xl:top-20">
        <Card data-tour-step-id="code-local">
          <CardHeader title="hades/local" summary={dirty ? 'seleção alterada, ainda não salva' : pendente ? 'salva, falta atualizar' : 'aplicada (igual ao prs.list)'}
            action={<>
              {dirty ? <Button size="xs" variant="ghost" icon={I.Undo2} onClick={() => setDirty(false)}>Desfazer</Button> : null}
              <span data-tour-step-id="code-documentos"><Menu label="Documentos da branch" items={[
                { label: 'rebuild.report: resultado da última reconstrução', icon: I.FileText, onClick: () => openLog('doc:rebuild.report', 'rebuild.report') },
                { label: 'conflicts.log: conflitos resolvidos e como', icon: I.GitMerge, onClick: () => openLog('doc:conflicts.log', 'conflicts.log') },
                { label: 'notes.md: ações sugeridas', icon: I.NotebookPen, onClick: () => openLog('doc:notes.md', 'notes.md') },
                { label: 'STATUS.md: estado das PRs', icon: I.FileText, onClick: () => openLog('doc:STATUS.md', 'STATUS.md') }]} /></span>
            </>} />
          <CardContent className="grid gap-4">
            <div data-tour-step-id="code-tranca">
              <Tranca rows={rows} onToggle={toggle} />
            </div>
            <LinhaDeEstado className="t-label" main={<span key="sha">{'commit atual '}<Mono>{(b.sha || '').slice(0, 10) || 'sem commit'}</Mono></span>}
              rest={[(svc.paths ?? [1]).length ? <span key="svc" className={cn(svc.stale && 'text-warn')}>{svc.stale ? 'serviços desatualizados' : 'serviços compilados'}</span> : null,
                (web.paths ?? [1]).length ? <span key="web" className={cn(web.stale && 'text-warn')}>{web.stale ? 'front desatualizado' : 'front compilado'}</span> : null,
                <span key="conf" className={cn(b.conflicts && 'text-bad')}>{plural(b.conflicts || 0, 'conflito', 'conflitos')}</span>]} />
            {b.headsChanged ? <div className="flex flex-wrap items-center gap-x-3 gap-y-2 t-body">
              <span className="inline-flex min-w-0 flex-1 basis-56 items-baseline gap-2">
                <Dot kind="warn" className="translate-y-px" />
                As PRs mudaram no GitHub desde o último build.
              </span>
              <Button size="xs" variant="outline" icon={I.RefreshCw} disabled={busy} title={REFAZ} onClick={() => openDialog('update')}>Atualizar</Button>
            </div> : null}
            {mode === 'prs' && tokens.length ? <p className="t-meta text-muted-foreground">
              {"O prs.list também tem "}
              <code className="font-mono text-foreground">
                {tokens.join(' ')}
              </code>
              . Salvar troca por PRs marcadas: o que é dinâmico (como @me, que puxa toda PR nova sua) vira lista fixa, e PRs novas deixam de entrar sozinhas.
            </p> : null}
            <div className="grid gap-2 border-t pt-4" data-tour-step-id="code-salvar">
              <div className="flex flex-wrap gap-2">
                <Button icon={I.RefreshCw} disabled={busy || blocked} onClick={() => save(true)} title={REFAZ} className="max-md:flex-1">Salvar e atualizar</Button>
                <Button variant="outline" icon={I.Save} disabled={busy || blocked} onClick={() => save(false)} className="max-md:flex-1">Salvar</Button>
              </div>
              {busy || blocked ? <p className="t-meta text-muted-foreground">
                {busy ? 'Ciclo em curso: salvar volta quando ele terminar.' : `Marque uma PR ou escolha só a ${bn}.`}
              </p> : null}
            </div>
          </CardContent>
        </Card>
        <Base d={d} />
      </div>
    </div>
  </div>;
}

HadesCore.registerPage('code', Code);
})();
