/* Página Configurações (#/config): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela.
 * Formulário longo: índice das seções fixo à esquerda, busca e filtros no topo, cada configuração uma linha (rótulo,
 * para que serve, chave e padrão), e a barra de salvar só quando há alteração. */
(() => {
const { useState, useEffect, useRef, useCallback, I, cn, gb, mb, post, getJSON, Button, Dot, Card, CardHeader,
  CardContent, Switch, Input, Mono, Tip, Empty, Dialog, DialogHeader, DialogFooter, useApp, route, useActions,
  Segmented, Checkbox, CFG_APPLY, modelLabel, cfgNorm, slugify, Loading, Select } = HadesCore;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// o modo de aplicar vem do registro (CFG_APPLY, que plugins estendem); modo sem registro aparece pelo nome
function ApplyLabel({ apply }) {
  const a = CFG_APPLY[apply];
  if (!a) return <span>{apply}</span>;
  const Icon = a.icon;
  return <span className="inline-flex items-center gap-1">
    <Icon className="size-3" aria-hidden="true" />
    {a.label}
  </span>;
}

function NotifyTools() {
  const run = useActions();
  const [st, setSt] = useState(null);
  const load = useCallback(() => getJSON('/api/notify').then(setSt).catch(() => setSt({})), []);
  useEffect(() => { load(); }, [load]);
  return <div className="grid gap-3 border-b py-4">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" icon={I.Bell} onClick={() => run({ action: 'notify', op: 'test' }).then(() => setTimeout(load, 3000))}>Testar notificação</Button>
      <Button size="sm" variant="outline" icon={I.RefreshCw} onClick={() => run({ action: 'notify', op: 'rotate' }, { title: 'Trocar o tópico do ntfy?', description: 'O tópico atual deixa de receber; assine o novo no celular.', icon: I.RefreshCw, danger: true }).then(() => setTimeout(load, 3000))}>Trocar tópico</Button>
    </div>
    {st?.subscribe ? <div className="flex flex-wrap items-start gap-4 t-meta text-muted-foreground">
      {st.qr ? <img src="/api/notify/qr" alt="QR para assinar o tópico no app ntfy" className="size-28 bg-white p-1" /> : null}
      <div className="grid min-w-0 flex-1 basis-56 gap-1">
        <span className="text-pretty">Assine no app ntfy ou escaneie o QR. Este endereço é segredo.</span>
        <Mono className="[overflow-wrap:anywhere] text-foreground">{st.subscribe}</Mono>
      </div>
    </div> : <span className="t-meta text-muted-foreground">
      {st?.topic === null && st?.hasTopic ? 'O tópico só aparece no painel local.' : 'O tópico nasce ao ligar o canal do celular e salvar.'}
    </span>}
  </div>;
}
// texto livre longo (caminho, repo, lista) ganha campo largo; número e tamanho cabem no estreito
const CFG_WIDE = new Set(['path', 'relpath', 'repo', 'url', 'emails', 'globs', 'logins', 'login', 'tags', 'modelmap', 'cidr', 'id']);
const ENUM_NOTIFY_EV = { off: 'Desligado', desktop: 'Só desktop', phone: 'Só celular', both: 'Desktop e celular' };
const ENUM_NOTIFY_CI = { pr: 'Igual ao review', ...ENUM_NOTIFY_EV };
const ENUM_CERBERUS = { off: 'Desligado', avisa: 'Avisa', barra: 'Barra' };
const ENUM_EFFORT = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };
const CFG_ENUM_LABEL = { HADES_PANEL_AUTOSTART: { off: 'Desligado', login: 'No login', boot: 'Com a máquina' },
  HADES_CLEAN_TIMER: { on: 'Ligado', off: 'Desligado' },
  HADES_GATE_SCOPE: { projeto: 'Uma fila por projeto', maquina: 'Uma fila na máquina' },
  HADES_SNAPSHOT_MODE: { migration: 'Só com migration nova', always: 'Antes de todo migrate', never: 'Nunca' },
  ...Object.fromEntries(['GATE', 'RESTART', 'HEALTH', 'PR', 'AGENT', 'SNAPSHOT', 'DOCTOR', 'CHAT', 'HERDR'].map((e) => ['HADES_NOTIFY_EV_' + e, ENUM_NOTIFY_EV])),
  HADES_NOTIFY_EV_CI: ENUM_NOTIFY_CI,
  ...Object.fromEntries(['PORTA', 'LIMIAR', 'VIGILIA'].map((c) => ['HADES_CERBERUS_' + c, ENUM_CERBERUS])),
  ...Object.fromEntries(['ORCHESTRATOR', 'SPEC', 'IMPL', 'CONSOLIDATE', 'REVIEW', 'ESCALATE', 'CHAT'].map((r) => ['HADES_EFFORT_' + r, ENUM_EFFORT])) };
// o que o dono faz depois de salvar: só o que não é 'next' nem 'hooks' aparece no cartão "Falta aplicar"
const applyNote = (apply) => !apply.length ? 'Nenhum valor mudou.'
  : apply.some((k) => k !== 'next' && k !== 'hooks') ? 'Falta aplicar: veja o cartão no topo.' : 'Nada a aplicar: já vale ou vale na próxima execução.';
const CFG_AUTONOMY = ['Pergunta tudo', 'Operacional', 'Execução', 'Totalmente autônomo'];
function CfgSlider({ it, value, onChange }) {
  const [lo, hi] = it.type.split(':').slice(1).map(Number);
  const n = Math.min(hi, Math.max(lo, Number(value) || 0));
  return <div className="flex w-full min-w-0 flex-col gap-1 md:w-64">
    <input type="range" min={lo} max={hi} step="1" value={n} aria-label={it.label} aria-valuetext={`${n}: ${CFG_AUTONOMY[n]}`} className="w-full accent-primary max-md:h-11" onInput={(e) => onChange(String(e.target.value))} />
    <div className="flex justify-between gap-1 t-micro text-muted-foreground tnum" aria-hidden="true">
      {CFG_AUTONOMY.map((l, i) => <span key={l} className={i === n ? 'font-medium text-foreground' : ''}>{i}</span>)}
    </div>
    <span className="t-meta-em">{`${n} · ${CFG_AUTONOMY[n]}`}</span>
  </div>;
}
// liga/desliga do vigia e dos canais de notificação: Bell Toggle (fx), com o Switch comum até ele carregar
function NotifyBell({ it, value, onChange }) {
  const Bell = window.HadesFx.use('BellToggle');
  const on = value === '1';
  if (!Bell) return <Switch checked={on} label={it.label} onChange={(v) => onChange(v ? '1' : '0')} />;
  return <Bell size="sm" radius={0} pressed={on} label={it.label} offLabel="Desligado" onLabel="Ligado" badge={false} waves={false}
    background="var(--secondary)" color="var(--secondary-foreground)" onBackground="var(--primary)" onColor="var(--primary-foreground)"
    onChange={(v) => onChange(v ? '1' : '0')} />;
}
function CfgControl({ it, value, onChange }) {
  const t = it.type;
  if (it.key === 'HADES_ORCH_AUTONOMY') return <CfgSlider it={it} value={value} onChange={onChange} />;
  if (t === 'bool' && it.key.startsWith('HADES_NOTIFY')) return <NotifyBell it={it} value={value} onChange={onChange} />;
  if (t === 'bool') return <Switch checked={value === '1'} label={it.label} onChange={(v) => onChange(v ? '1' : '0')} />;
  if (t.startsWith('enum:')) return <Segmented className="w-fit" label={it.label} value={value} onChange={onChange} items={t.slice(5).split(',').map((o) => ({ value: o, label: CFG_ENUM_LABEL[it.key]?.[o] ?? modelLabel(o) }))} />;
  if (t.startsWith('multi:')) {
    const sel = value.split(',').filter(Boolean);
    return <div className="flex flex-wrap gap-x-4 gap-y-2">
      {t.slice(6).split(',').map((o) => <label key={o} className="flex items-center gap-2 t-body max-md:min-h-11">
        <Checkbox checked={sel.includes(o)} label={o} onChange={(v) => onChange(t.slice(6).split(',').filter((x) => x === o ? v : sel.includes(x)).join(','))} />
        {o}
      </label>)}
    </div>;
  }
  return <Input className={cn('w-full md:flex-none', CFG_WIDE.has(t) ? 'md:w-72' : 'md:w-40')} value={value} placeholder={it.default || 'vazio'} spellcheck="false" aria-label={it.label} onInput={(e) => onChange(e.target.value)} />;
}
// o estado da busca vive na URL (#/config?q=teto&f=alt,falta)
const cfgUrl = () => { const p = new URLSearchParams(location.hash.split('?')[1] || ''); return { q: p.get('q') || '', f: (p.get('f') || '').split(',').filter((x) => x === 'alt' || x === 'falta') }; };
function CfgExportDialog({ open, onClose }) {
  const { toast } = useApp();
  const [all, setAll] = useState(false);
  const [ident, setIdent] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/config/export?all=${+all}&identity=${+ident}`, { cache: 'no-store' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob());
      a.download = `hades-config-${new Date().toISOString().slice(0, 10)}.env`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      onClose();
    } catch (e) { toast({ kind: 'bad', title: 'Não deu para exportar', desc: e.message }); }
    setBusy(false);
  };
  return <Dialog open={open} onClose={onClose} label="Exportar configurações">
    <DialogHeader title="Exportar configurações" description="Arquivo KEY=VALUE. Segredos nunca entram." />
    <div className="grid gap-3">
      <label className="flex items-start gap-2.5 t-body">
        <Checkbox checked={all} label="Exportar tudo" onChange={setAll} />
        <span>Exportar tudo, não só o que difere do padrão</span>
      </label>
      <label className="flex items-start gap-2.5 t-body">
        <Checkbox checked={ident} label="Incluir contas e caminhos" onChange={setIdent} />
        <span>Incluir contas, e-mails e caminhos desta máquina</span>
      </label>
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>Cancelar</Button>
      <Button icon={I.Download} loading={busy} onClick={go}>Baixar</Button>
    </DialogFooter>
  </Dialog>;
}
function CfgImportDialog({ plan, onClose, onApply, busy }) {
  const ch = plan?.changes || [];
  const notes = plan ? [...plan.invalid.map((e) => ({ k: e.key, t: e.error, bad: true })), ...plan.unknown.map((k) => ({ k, t: 'configuração desconhecida, ignorada' })),
    ...plan.secret.map((k) => ({ k, t: 'segredo, ignorado' })), ...plan.blocked.map((k) => ({ k, t: 'só se muda pelo painel local, ignorada' }))] : [];
  return <Dialog open={!!plan} onClose={onClose} label="Importar configurações" className="sm:max-w-2xl">
    <DialogHeader title="Importar configurações" description={plan ? `${plural(ch.length, 'mudança', 'mudanças')}${plan.same.length ? `, ${plan.same.length} já com o mesmo valor` : ''}. Nada gravado ainda.` : ''} />
    <div className="max-h-[50vh] overflow-y-auto border-y scrollbar-thin">
      {ch.length ? <ul>
        {ch.map((c) => <li key={c.key} className="grid gap-1 border-b py-2.5 t-body last:border-b-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="font-medium">{c.label}</span>
            <Mono className="text-muted-foreground">{c.key}</Mono>
            <span className="ml-auto t-meta text-muted-foreground"><ApplyLabel apply={c.apply} /></span>
          </div>
          <div className="flex flex-wrap items-center gap-2 t-data">
            <span className="text-muted-foreground line-through">{c.old || 'vazio'}</span>
            <I.ArrowRight className="size-3 text-muted-foreground" aria-hidden="true" />
            <span>{c.new || 'vazio'}</span>
          </div>
        </li>)}
      </ul> : <p className="py-3 t-body text-muted-foreground">Nenhuma mudança.</p>}
      {notes.length ? <ul className="border-t py-2">
        {notes.map((n, i) => <li key={i} className={cn('flex flex-wrap items-baseline gap-x-2 py-1 t-meta', n.bad ? 'text-bad' : 'text-muted-foreground')}>
          <Dot kind={n.bad ? 'bad' : 'idle'} className="translate-y-px" />
          <Mono>{n.k}</Mono>
          <span className="text-pretty">{n.t}</span>
        </li>)}
      </ul> : null}
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>Cancelar</Button>
      <Button icon={I.Save} loading={busy} disabled={!ch.length} onClick={onApply}>
        {ch.length ? `Gravar ${plural(ch.length, 'mudança', 'mudanças')}` : 'Gravar'}
      </Button>
    </DialogFooter>
  </Dialog>;
}

const groupId = (g) => 'cfg-' + slugify(g);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const goTo = (id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
};
// índice das seções: fixo à esquerda na mesa (a seção na tela fica marcada), select no celular
function CfgIndex({ groups }) {
  const [cur, setCur] = useState(groups[0]?.id);
  const ids = groups.map((x) => x.id).join(' ');
  useEffect(() => {
    const io = new IntersectionObserver((es) => {
      const top = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setCur(top.target.id);
    }, { rootMargin: '-112px 0px -55% 0px' });
    groups.forEach((x) => { const el = document.getElementById(x.id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, [ids]);
  return <>
    <nav aria-label="Seções das configurações" data-tour-step-id="config-indice" className="hidden lg:sticky lg:top-28 lg:block lg:max-h-[calc(100dvh-8rem)] lg:self-start lg:overflow-y-auto scrollbar-thin">
      <ul className="border-l">
        {groups.map((x) => <li key={x.id}>
          <button type="button" aria-current={cur === x.id ? 'location' : undefined} onClick={() => { setCur(x.id); goTo(x.id); }}
            className={cn('-ml-px flex w-full items-center gap-2 border-l-2 py-1.5 pr-2 pl-3 text-left t-label transition-colors cursor-pointer outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
              cur === x.id ? 'border-l-foreground bg-accent/40 font-medium text-foreground' : 'border-l-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
            <span className="min-w-0 flex-1 truncate">{x.g}</span>
            {x.dirty ? <Tip text={plural(x.dirty, 'alteração não salva', 'alterações não salvas')}><Dot kind="warn" /></Tip> : null}
            <span className="font-mono t-micro text-muted-foreground tnum">{x.n}</span>
          </button>
        </li>)}
      </ul>
    </nav>
    <Select label="Ir para a seção" value="" onChange={goTo} className="w-full lg:hidden" placeholder={`Ir para a seção (${groups.length})`}
      items={groups.map((x) => ({ value: x.id, label: x.g, count: x.n }))} />
  </>;
}

function CfgRow({ it, value, saved, onChange, first, pinned }) {
  const unsaved = value !== saved;
  const altered = value !== it.default;
  return <li data-tour-step-id={first ? 'config-linha' : undefined} className={cn('grid gap-x-8 gap-y-3 border-b py-4 transition-colors last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto]', unsaved && 'bg-accent/40 -mx-3 px-3')}>
    <div className="grid min-w-0 content-start gap-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h3 className="t-label">{it.label}</h3>
        {unsaved ? <span className="inline-flex items-center gap-1.5 t-meta text-warn"><Dot kind="warn" />não salvo</span>
          : altered ? <span className="inline-flex items-center gap-1.5 t-meta text-muted-foreground"><Dot kind="info" />fora do padrão</span> : null}
      </div>
      {it.desc ? <p className="max-w-[70ch] t-body text-muted-foreground">{it.desc}</p> : null}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 t-meta text-muted-foreground">
        <Mono className="whitespace-nowrap text-foreground/80 select-all">{it.key}</Mono>
        <span className="min-w-0">{'padrão '}<Mono className="[overflow-wrap:anywhere]">{it.default || 'vazio'}</Mono></span>
        <ApplyLabel apply={it.apply} />
      </div>
    </div>
    <div className="flex min-w-0 items-start gap-1 md:justify-end">
      {pinned ? <span className="t-meta text-muted-foreground max-w-64">{'Fixo por variável exportada no ambiente do painel: mudar aqui não tem efeito. Tire '}<Mono>{it.key}</Mono>{' do ambiente.'}</span>
        : <CfgControl it={it} value={value} onChange={onChange} />}
      {altered && !pinned ? <Tip text={`Voltar ao padrão (${it.default || 'vazio'}). Só vale depois de salvar.`}>
        <Button variant="ghost" size="icon-sm" aria-label={`Voltar ${it.label} ao padrão`} icon={I.RotateCcw} onClick={() => onChange(it.default)} />
      </Tip> : <span className="size-8 shrink-0 max-md:hidden" aria-hidden="true" />}
    </div>
  </li>;
}

const APPLY_WHAT = { slice: 'O teto novo vale ao atualizar o slice', services: 'O heap novo vale ao reiniciar os serviços',
  panel: 'O painel usa o valor novo ao reiniciar', agents: 'Os subagentes usam o modelo novo ao aplicar',
  autostart: 'O início automático muda ao aplicar no systemd', logrotate: 'O timer de limpeza muda ao aplicar' };
const APPLY_BUTTON = { slice: 'Aplicar o teto no slice', services: 'Reiniciar os serviços', panel: 'Reiniciar o painel', agents: 'Aplicar nos subagentes',
  autostart: 'Aplicar o início automático', logrotate: 'Aplicar o timer de limpeza' };

function Config({ d }) {
  const { toast } = useApp();
  const run = useActions();
  const [items, setItems] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState([]);
  const [path, setPath] = useState('');
  const [q, setQ] = useState(() => cfgUrl().q);
  const [filt, setFilt] = useState(() => cfgUrl().f);
  const [fix, setFix] = useState([]);
  const [exp, setExp] = useState(false);
  const [plan, setPlan] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileIn = useRef(null);
  const [pinned, setPinned] = useState([]);
  useEffect(() => { getJSON('/api/notify').then((r) => setPinned((r.events || []).filter((e) => e.pinnedByEnv).map((e) => 'HADES_NOTIFY_EV_' + e.event.toUpperCase()))).catch(() => setPinned([])); }, []);
  const load = useCallback(() => getJSON('/api/config').then((r) => { setItems(r.items); setPath(r.path); setLoadErr(''); })
    .catch((e) => setLoadErr(e.message || 'o painel não respondeu')), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q);
    if (filt.length) sp.set('f', filt.join(','));
    history.replaceState(null, '', '#/config' + (sp.size ? '?' + sp : ''));
  }, [q, filt]);
  useEffect(() => {
    const f = () => { if (route() === 'config') { const u = cfgUrl(); setQ(u.q); setFilt(u.f); } };
    const k = (e) => { if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) { e.preventDefault(); document.getElementById('cfg-search')?.focus(); } };
    addEventListener('hashchange', f); addEventListener('keydown', k);
    return () => { removeEventListener('hashchange', f); removeEventListener('keydown', k); };
  }, []);
  if (!items) return loadErr ? <Empty icon={I.TriangleAlert} title="Não consegui ler as configurações">
    <span className="mr-2">{loadErr}</span>
    <Button size="sm" variant="outline" icon={I.RotateCw} onClick={() => { setLoadErr(''); load(); }}>Tentar de novo</Button>
  </Empty> : <Loading />;
  const val = (it) => draft[it.key] ?? it.value;
  const dirty = Object.keys(draft).filter((k) => draft[k] !== items.find((it) => it.key === k)?.value);
  const needsApply = (it) => fix.includes(it.key) && pending.includes(it.apply) && it.apply !== 'next' && it.apply !== 'hooks';
  const terms = cfgNorm(q).split(/\s+/).filter(Boolean);
  const shown = items.filter((it) => {
    const hay = cfgNorm([it.label, it.key, it.desc, it.group].join(' '));
    return terms.every((t) => hay.includes(t)) && (!filt.includes('alt') || val(it) !== it.default) && (!filt.includes('falta') || needsApply(it));
  });
  const groups = [...new Set(shown.map((it) => it.group))].map((g) => {
    const list = shown.filter((it) => it.group === g);
    return { g, id: groupId(g), list, n: list.length, dirty: list.filter((it) => dirty.includes(it.key)).length, altered: list.filter((it) => val(it) !== it.default).length };
  });
  const altered = items.filter((it) => it.value !== it.default).length;
  const toggleFilt = (f) => setFilt((c) => c.includes(f) ? c.filter((x) => x !== f) : [...c, f]);
  const pickFile = async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      if (file.size > 60000) throw new Error('arquivo grande demais');
      setPlan(await post('/api/config/preview', { text: await file.text() }));
    } catch (err) { toast({ kind: 'bad', title: 'Não deu para ler o arquivo', desc: err.message }); }
  };
  const applyImport = async () => {
    setImporting(true);
    try {
      const r = await post('/api/config', { values: Object.fromEntries(plan.changes.map((c) => [c.key, c.new])) });
      setItems(r.items); setPlan(null);
      setFix((f) => [...new Set([...f, ...plan.changes.map((c) => c.key)])]);
      setPending((p) => [...new Set([...p, ...r.apply])]);
      toast({ kind: 'ok', title: 'Configurações importadas', desc: applyNote(r.apply) });
    } catch (err) { toast({ kind: 'bad', title: 'Não deu para importar', desc: err.message }); }
    setImporting(false);
  };
  const save = async () => {
    setSaving(true);
    try {
      const r = await post('/api/config', { values: Object.fromEntries(dirty.map((k) => [k, draft[k]])) });
      setItems(r.items); setDraft({});
      setFix((f) => [...new Set([...f, ...dirty])]);
      setPending((p) => [...new Set([...p, ...r.apply])]);
      toast({ kind: 'ok', title: 'Configurações salvas', desc: applyNote(r.apply) });
    } catch (e) { toast({ kind: 'bad', title: 'Não deu para salvar', desc: e.message }); }
    setSaving(false);
  };
  const done = (k) => setPending((p) => p.filter((x) => x !== k));
  const port = items.find((it) => it.key === 'HADES_PANEL_PORT')?.value;
  const applyBtn = {
    slice: () => run({ action: 'config-apply', op: 'slice' }).then((j) => j && done('slice')),
    services: () => run({ action: 'svc', op: 'restart', targets: [] }, { title: 'Reiniciar os serviços habilitados?', description: 'Todos ficam indisponíveis por alguns segundos.', icon: I.RotateCw, danger: true }).then((j) => j && done('services')),
    agents: () => run({ action: 'config-apply', op: 'agents' }).then((j) => j && done('agents')),
    autostart: () => run({ action: 'config-apply', op: 'autostart' }).then((j) => j && done('autostart')),
    logrotate: () => run({ action: 'config-apply', op: 'logrotate' }).then((j) => j && done('logrotate')),
    panel: () => run({ action: 'panel', op: 'restart' }, { title: 'Reiniciar o painel?', description: `O painel volta em http://127.0.0.1:${port}. Se a porta mudou, use o endereço novo.`, icon: I.RotateCw }).then((j) => j && done('panel')),
    // modos do plugin (manifesto → applies): cada um dispara a ação que ele declarou
    ...Object.fromEntries(Object.entries(CFG_APPLY).filter(([, a]) => a.action).map(([k, a]) => [k, () => run(a.action).then((j) => j && done(k))])),
  };
  const toApply = pending.filter((k) => k !== 'next' && k !== 'hooks');
  const setOne = (key) => (x) => setDraft((cur) => ({ ...cur, [key]: x }));
  const filterBtn = (f, label) => <Button size="sm" variant="outline" aria-pressed={filt.includes(f)} className={cn(filt.includes(f) && 'bg-muted text-foreground')} icon={filt.includes(f) ? I.Check : undefined} onClick={() => toggleFilt(f)}>
    {label}
  </Button>;
  return <div className="grid gap-6">
    <div className="z-20 -mx-4 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 pb-3 backdrop-blur-sm md:sticky md:top-12 md:-mx-6 md:px-6 md:py-2 lg:-mx-8 lg:px-8">
      <Input id="cfg-search" data-tour-step-id="config-busca" icon={I.Search} className="basis-full sm:max-w-sm sm:basis-64" placeholder="Buscar por nome, chave ou descrição" aria-label="Buscar configuração" aria-keyshortcuts="/" value={q} spellcheck="false" onInput={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { if (q) setQ(''); else e.target.blur(); } }} />
      <span data-tour-step-id="config-filtros" className="inline-flex flex-wrap gap-2">
        {filterBtn('alt', 'Só fora do padrão')}
        {filterBtn('falta', 'Falta aplicar')}
      </span>
      <span className="t-meta text-muted-foreground tnum max-sm:order-last max-sm:basis-full" aria-live="polite">
        {shown.length === items.length ? `${items.length} configurações · ${altered} fora do padrão` : `${shown.length} de ${items.length}`}
      </span>
      <div data-tour-step-id="config-exportar" className="ml-auto flex gap-2">
        <Button size="sm" variant="outline" icon={I.Download} className="max-sm:w-11 max-sm:px-0" onClick={() => setExp(true)}><span className="max-sm:sr-only">Exportar</span></Button>
        <Button size="sm" variant="outline" icon={I.Upload} className="max-sm:w-11 max-sm:px-0" onClick={() => fileIn.current?.click()}><span className="max-sm:sr-only">Importar</span></Button>
        <input ref={fileIn} type="file" accept=".env,.txt,text/plain" className="hidden" onChange={pickFile} />
      </div>
    </div>
    <CfgExportDialog open={exp} onClose={() => setExp(false)} />
    <CfgImportDialog plan={plan} onClose={() => setPlan(null)} onApply={applyImport} busy={importing} />
    {toApply.length ? <Card data-tour-step-id="config-aplicar">
      <CardHeader title="Falta aplicar" summary="já salvos; valem depois de aplicar" />
      <CardContent>
        <ul className="-mt-2">
          {toApply.map((k) => <li key={k} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b py-2.5 last:border-b-0">
            <Dot kind="warn" />
            {k === 'watch' ? <>
              <span className="min-w-0 flex-1 t-body">Plantão: reinicie o watch.sh. Na sessão do Claude Code que o mantém, pare o Monitor e rode de novo bash watch.sh (na pasta de dados do Hades).</span>
              <Button size="sm" variant="ghost" onClick={() => done(k)}>Já reiniciei</Button>
            </> : <>
              <span className="grid min-w-0 flex-1 basis-64 gap-0.5">
                <span className="t-body">{APPLY_WHAT[k] || `Falta aplicar: ${CFG_APPLY[k]?.label || k}`}</span>
                <span className="t-meta text-muted-foreground">{items.filter((it) => it.apply === k && fix.includes(it.key)).map((it) => it.label).join(', ')}</span>
              </span>
              <Button size="sm" variant={k === 'slice' ? 'default' : 'outline'} icon={CFG_APPLY[k]?.icon || I.Zap} disabled={!applyBtn[k]} onClick={applyBtn[k]}>
                {APPLY_BUTTON[k] || CFG_APPLY[k]?.button || CFG_APPLY[k]?.label || k}
              </Button>
            </>}
          </li>)}
        </ul>
      </CardContent>
    </Card> : null}
    {shown.length ? <div className="grid gap-6 lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:gap-10">
      <CfgIndex groups={groups} />
      <div className="grid max-w-5xl gap-10">
        {groups.map((x, gi) => <section key={x.g} id={x.id} tabIndex={-1} aria-label={x.g} data-tour-step-id={gi === 0 ? 'config-grupo' : undefined} className="scroll-mt-28 outline-none">
          <Card>
            <CardHeader title={x.g} summary={[plural(x.n, 'configuração', 'configurações'), x.altered ? `${x.altered} fora do padrão` : null].filter(Boolean).join(' · ')}
                description={x.g === 'Memória' && d ? `Memória do Hades agora (slice): ${d.slice.max ? `${mb(d.slice.used)} de ${mb(d.slice.max)}` : `slice parado (teto ${d.config?.HADES_SLICE_MAX ?? '—'})`}. Máquina: ${gb(d.host.memTotal)} no total, ${gb(d.host.memAvailable)} livres.` : null} />
            <CardContent className="-mt-4">
              {x.g === 'Notificações' ? <NotifyTools /> : null}
              <ul>
                {x.list.map((it, ri) => <CfgRow key={it.key} first={gi === 0 && ri === 0} it={it} value={val(it)} saved={it.value} onChange={setOne(it.key)} pinned={pinned.includes(it.key)} />)}
              </ul>
            </CardContent>
          </Card>
        </section>)}
      </div>
    </div> : <Empty icon={I.SearchX} title="Nenhuma configuração encontrada">
      <Button size="sm" variant="outline" onClick={() => { setQ(''); setFilt([]); }}>Limpar busca e filtros</Button>
    </Empty>}
    <p data-tour-step-id="config-rodape" className="border-t pt-4 t-meta text-muted-foreground">
      {'Salvo em '}
      <Mono className="[overflow-wrap:anywhere]">{path}</Mono>
      {' (só o que difere do padrão). Se a variável estiver exportada no shell que subiu o painel, ela vence o valor salvo aqui. No terminal: '}
      <Mono className="whitespace-nowrap">config.sh show</Mono>
      {', '}
      <Mono className="whitespace-nowrap">set K=V</Mono>
      {', '}
      <Mono className="whitespace-nowrap">unset K</Mono>
      .
    </p>
    {dirty.length ? <div role="region" aria-label="Alterações não salvas" data-tour-step-id="config-salvar" className="sticky bottom-[calc(1rem+var(--dock,0rem))] z-20 ml-auto flex w-fit max-w-full items-center gap-3 border border-border-strong bg-popover px-4 py-2.5 max-md:w-full max-md:px-3">
      <span className="inline-flex min-w-0 flex-1 items-center gap-2 t-body">
        <Dot kind="warn" />
        <span className="sm:hidden">{`${dirty.length} não salva${dirty.length > 1 ? 's' : ''}`}</span>
        <span className="max-sm:hidden">{dirty.length > 1 ? `${dirty.length} alterações não salvas` : '1 alteração não salva'}</span>
      </span>
      <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft({})}>Descartar</Button>
      <Button size="sm" icon={I.Save} loading={saving} onClick={save}>{saving ? 'Salvando…' : 'Salvar'}</Button>
    </div> : null}
  </div>;
}

HadesCore.registerPage('config', Config);
})();
