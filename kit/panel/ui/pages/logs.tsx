/* Página Logs (#/logs): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela. */
(() => {
const { useState, useEffect, I, cn, pluginList, getJSON, Dot, Button, Card, CardHeader, CardContent, Input, Empty, LogViewer, useActions, Tip } = HadesCore;

const LOG_CATS = [
  { id: 'svc', label: 'Serviços', desc: 'logs/<serviço>.log' },
  { id: 'build', label: 'Builds e ciclos', desc: 'build, migrate, update, seed' },
  { id: 'unit', label: 'Processos', desc: 'journalctl das units' },
  { id: 'docker', label: 'Containers', desc: 'docker logs' },
  { id: 'doc', label: 'Documentos', desc: 'STATUS, notas' },
];
// o estado do serviço em palavra, para o leitor de tela e para quem não vê a cor do ponto
const DOT_WORD = { ok: 'ativo', warn: 'subindo', idle: 'parado' };
const EMPTY = { svc: 'Nenhum serviço registrado.', build: 'Nenhum build rodou ainda.', unit: 'Nenhuma unit encontrada.',
  docker: 'Nenhum container do projeto rodando: suba a infra na Visão geral.', doc: 'Nenhum documento ainda.' };
const ROW = 'flex w-full items-center gap-2.5 border-b border-l-2 border-l-transparent px-3 text-left t-body transition-colors cursor-pointer hover:bg-accent/60 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';
const ROW_ON = 'border-l-foreground bg-accent/40';

// log de serviço que não existe quase sempre é serviço que não subiu: a saída é subir esse serviço
function Missing({ svc }) {
  const run = useActions();
  if (!svc || svc.state === 'active') return null;
  return <div className="flex flex-wrap items-center gap-3" data-tour-step-id="logs-subir">
    <span className="text-muted-foreground">
      {`${svc.name} está parado${svc.enabled ? '' : ' e desligado'}.`}
    </span>
    {svc.enabled ? <Button size="sm" variant="outline" icon={I.Play} onClick={() => run({ action: 'svc', op: 'start', targets: [svc.name] })}>
      {`Subir ${svc.name}`}
    </Button> : null}
  </div>;
}

function Logs({ d }) {
  const [files, setFiles] = useState([]);
  const [cat, setCat] = useState(() => { try { return localStorage.getItem('panel-log-cat') || 'svc'; } catch (e) { return 'svc'; } });
  const [src, setSrc] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { getJSON('/api/log-files').then(setFiles).catch(() => setFiles([])); }, []);
  useEffect(() => { try { localStorage.setItem('panel-log-cat', cat); } catch (e) {} }, [cat]);
  const hu = d.unitPrefix || 'hds';   // prefixo das units da instância (hds na original)
  const svcNames = new Set(d.services.map((s) => s.name + '.log'));
  const items = {
    svc: [...d.services].sort((a, b) => (b.enabled - a.enabled) || a.name.localeCompare(b.name))
      .map((s) => ({ src: 'svc:' + s.name, label: s.name, err: s.logs.errors, dot: s.state === 'active' ? (s.ready ? 'ok' : 'warn') : 'idle', off: !s.enabled })),
    build: files.filter((f) => !svcNames.has(f)).map((f) => ({ src: 'file:' + f, label: f })),
    unit: [...new Set([`${hu}-panel`, `${hu}-devtunnel`, ...pluginList('units'), ...(Array.isArray(d.plugin?.logUnits) ? d.plugin.logUnits : [])])].map((u) => ({ src: 'unit:' + u, label: u })),
    docker: d.containers.filter((c) => c.state !== 'ausente').map((c) => ({ src: 'docker:' + c.name, label: c.service, dot: c.state === 'running' ? 'ok' : 'idle' })),
    doc: ['STATUS.md', 'notes.md', 'conflicts.log', 'rebuild.report', 'prs.list'].map((f) => ({ src: 'doc:' + f, label: f })),
  };
  const catInfo = LOG_CATS.find((c) => c.id === cat);
  const list = (items[cat] || []).filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));
  const cur = src && src.split(':')[0] === (cat === 'build' ? 'file' : cat) ? src : list[0]?.src;
  const curItem = Object.values(items).flat().find((i) => i.src === cur);
  const curSvc = cur?.startsWith('svc:') ? d.services.find((s) => 'svc:' + s.name === cur) : null;
  return <div className="grid items-start gap-6 lg:grid-cols-[300px_1fr]">
    <aside className="grid gap-6 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:grid-rows-[auto_minmax(0,1fr)]">
      <nav aria-label="Categorias de log" data-tour-step-id="logs-categorias">
        {LOG_CATS.map((c) => <button key={c.id} type="button" aria-current={cat === c.id ? 'true' : undefined} onClick={() => { setCat(c.id); setSrc(null); setQ(''); }} className={cn(ROW, 'py-2', cat === c.id && ROW_ON)}>
          <span className="min-w-0 flex-1">
            <span className={cn('block', cat === c.id && 'font-medium')}>
              {c.label}
            </span>
            <span className="block truncate font-mono t-micro text-muted-foreground">
              {c.desc}
            </span>
          </span>
          <span className="t-meta text-muted-foreground tnum">
            {items[c.id].length}
          </span>
        </button>)}
      </nav>
      <Card className="min-h-0 gap-0" data-tour-step-id="logs-lista">
        <CardHeader title={catInfo.label} summary={q ? `${list.length} de ${items[cat].length}` : `${items[cat].length}`} />
        <div className="border-b py-2" data-tour-step-id="logs-filtro">
          <Input icon={I.Search} aria-label={'Filtrar ' + catInfo.label.toLowerCase()} placeholder={'Filtrar ' + catInfo.label.toLowerCase() + '…'} value={q} onInput={(e) => setQ(e.target.value)} />
        </div>
        <CardContent className="min-h-0 overflow-y-auto scrollbar-thin max-lg:max-h-72">
          {list.length ? list.map((i) => <button key={i.src} type="button" aria-current={cur === i.src ? 'true' : undefined} onClick={() => setSrc(i.src)} title={i.off ? 'Desligado' : undefined}
            className={cn(ROW, 'py-1.5', cur === i.src ? ROW_ON + ' font-medium' : 'text-muted-foreground hover:text-foreground', i.off && cur !== i.src && 'opacity-60')}>
            {i.dot ? <Dot kind={i.dot} /> : null}
            {i.dot ? <span className="sr-only">{DOT_WORD[i.dot] || ''}</span> : null}
            <span className="min-w-0 flex-1 truncate font-mono t-label">
              {i.label}
            </span>
            {i.off ? <span className="t-meta">desligado</span> : null}
            {i.err ? <Tip text="erros nos últimos 15 min"><span className="t-label text-bad tnum">
              {i.err}
              <span> err</span>
            </span></Tip> : null}
          </button>)
            : <div className="px-3">
              <Empty icon={I.ScrollText} title={q ? `Nada com "${q}".` : (EMPTY[cat] || 'Vazio.')} />
            </div>}
        </CardContent>
      </Card>
    </aside>
    {cur ? <div className="min-w-0" data-tour-step-id="logs-leitor">
      <LogViewer key={cur} src={cur} title={curItem?.label || cur} flow missing={<Missing svc={curSvc} />} />
    </div>
      : <Empty icon={I.ScrollText} title="Escolha um log." />}
  </div>;
}

HadesCore.registerPage('logs', Logs);
})();
