/* Página Documentação (#/docs): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela.
 * Leitura: o texto numa medida de 70ch (código e tabelas podem passar dela), o índice do grupo e os tópicos ao lado. */
(() => {
const { useState, useEffect, useRef, useMemo, useCallback, I, cn, getJSON, Button, Card, CardHeader, CardContent, Input,
  Skeleton, Mono, Empty, ago, Segmented, slugify, renderMd, Loading } = HadesCore;

function topics(text) {
  const out = []; let fence = false;
  for (const l of text.split('\n')) {
    if (/^```/.test(l)) fence = !fence;
    const m = !fence && /^(#{2,3})\s+(.+?)\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, title: m[2].replace(/[`*_]/g, ''), id: slugify(m[2]) });
  }
  return out;
}
const plain = (t) => t.replace(/`/g, '');
// prosa na medida de leitura; bloco de código e tabela usam a largura da coluna. Em rem, não em ch: o ch de cada
// elemento segue a própria fonte, e o título (20 px) ficaria mais largo que o parágrafo. 41rem ≈ 70ch do corpo (15 px)
const PROSA = '[&>*:not(pre,table)]:max-w-[68ch] max-md:[&>h1]:t-kpi';
const ROW = 'relative block w-full border-l-2 py-1.5 pr-2 text-left t-body transition-colors cursor-pointer outline-none hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';
const SELECT = 'h-8 w-full min-w-0 border border-border-strong bg-background px-2 t-body text-foreground cursor-pointer max-md:h-11';

function Topicos({ shown, total, active, go, q, setQ }) {
  return <div className="grid gap-2">
    {total > 6 ? <Input icon={I.Search} aria-label="Filtrar tópicos deste documento" placeholder="Filtrar tópicos deste documento…" value={q} onInput={(e) => setQ(e.target.value)} /> : null}
    {shown.length ? <ul>
      {shown.map((t) => <li key={t.id}>
        <button type="button" onClick={() => go(t.id)} aria-current={active === t.id ? 'location' : undefined} className={cn(ROW, t.level === 3 ? 'pl-6 t-label' : 'pl-3',
          active === t.id ? 'border-l-foreground bg-accent/40 font-medium text-foreground' : 'border-l-transparent text-muted-foreground hover:text-foreground')}>
          {t.title}
        </button>
      </li>)}
    </ul> : <p className="py-2 t-body text-muted-foreground">{total ? 'Nenhum tópico com esse nome.' : 'Documento sem tópicos.'}</p>}
  </div>;
}

function Docs() {
  const [idx, setIdx] = useState(null);
  const [idxErr, setIdxErr] = useState(null);
  const [group, setGroup] = useState(() => { try { return localStorage.getItem('panel-doc-group') || 'Visão geral'; } catch (e) { return 'Visão geral'; } });
  const [docId, setDocId] = useState(null);
  const [doc, setDoc] = useState(null);
  const [docErr, setDocErr] = useState(null);
  const [active, setActive] = useState(null);
  const [q, setQ] = useState('');
  const body = useRef(null);
  const loadIdx = useCallback(() => { setIdxErr(null); getJSON('/api/docs').then(setIdx).catch((e) => setIdxErr(e.message)); }, []);
  useEffect(() => { loadIdx(); }, [loadIdx]);
  const g = idx?.groups.find((x) => x.title === group) || idx?.groups[0];
  const cur = docId && g?.items.some((i) => i.id === docId) ? docId : g?.items[0]?.id;
  useEffect(() => { try { localStorage.setItem('panel-doc-group', group); } catch (e) {} }, [group]);
  useEffect(() => {
    if (!cur) return;
    setDoc(null); setDocErr(null);
    getJSON('/api/doc?id=' + encodeURIComponent(cur)).then(setDoc).catch((e) => setDocErr(e.message));
    window.scrollTo({ top: 0 });
  }, [cur]);
  const toc = useMemo(() => doc ? topics(doc.text) : [], [doc]);
  const htmlDoc = useMemo(() => doc ? renderMd(doc.text) : '', [doc]);
  useEffect(() => {
    if (!body.current) return;
    const hs = [...body.current.querySelectorAll('h2[id], h3[id]')];
    const io = new IntersectionObserver((es) => { const v = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (v) setActive(v.target.id); }, { rootMargin: '-80px 0px -65% 0px' });
    hs.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, [htmlDoc]);
  const go = (id) => { const el = document.getElementById(id); if (el) { window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 76, behavior: 'smooth' }); setActive(id); } };
  if (idxErr) return <Empty icon={I.CircleX} title="Não foi possível ler a documentação">
    <span className="inline-flex flex-wrap items-baseline gap-x-3">
      {idxErr}
      <Button variant="link" size="xs" className="h-auto px-0" onClick={loadIdx}>Tentar de novo</Button>
    </span>
  </Empty>;
  if (!idx) return <Loading />;
  const shown = toc.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()));
  const pickGroup = (v) => { setGroup(v); setDocId(null); setQ(''); };
  const pickDoc = (id) => { setDocId(id); setQ(''); };
  const many = g?.items.length > 1;
  const docTitle = g?.items.find((i) => i.id === cur)?.title;
  return <div className="grid gap-6">
    <div data-tour-step-id="docs-grupos" className="flex flex-wrap items-end gap-x-4 gap-y-2">
      <Segmented value={g?.title} onChange={pickGroup} className="max-xl:hidden" items={idx.groups.map((x) => ({ value: x.title, label: x.title, count: x.items.length > 1 ? x.items.length : null }))} />
      <label className="grid min-w-0 flex-1 gap-1.5 t-label text-muted-foreground md:max-w-xs xl:hidden">
        Grupo
        <select value={g?.title} onChange={(e) => pickGroup(e.target.value)} className={SELECT}>
          {idx.groups.map((x) => <option key={x.title} value={x.title}>
            {x.title + (x.items.length > 1 ? ` (${x.items.length})` : '')}
          </option>)}
        </select>
      </label>
      <span data-tour-step-id="docs-origem" className="ml-auto t-meta text-muted-foreground max-md:basis-full">
        {idx.version ? <span className="tnum">{'versão ' + idx.version + ' · '}</span> : null}
        <Mono>{(idx.path || '~/.claude/skills/hades').replace(/^\/home\/[^/]+/, '~')}</Mono>
      </span>
    </div>
    <div className="grid items-start gap-x-10 gap-y-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="grid gap-6 max-lg:hidden lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:scrollbar-thin" aria-label="Índice">
        {many ? <Card data-tour-step-id="docs-documentos" className="gap-2">
          <CardHeader title="Documentos" summary={String(g.items.length)} />
          <CardContent>
            <ul>
              {g.items.map((it) => <li key={it.id}>
                <button type="button" onClick={() => pickDoc(it.id)} aria-current={cur === it.id ? 'page' : undefined} className={cn(ROW, 'pl-3 text-pretty',
                  cur === it.id ? 'border-l-foreground bg-accent/40 font-medium' : 'border-l-transparent text-muted-foreground hover:text-foreground')}>
                  {plain(it.title)}
                </button>
              </li>)}
            </ul>
          </CardContent>
        </Card> : null}
        <Card data-tour-step-id="docs-topicos" className="gap-2">
          <CardHeader title="Neste documento" summary={toc.length ? String(toc.length) : undefined} />
          <CardContent>
            {doc ? <Topicos shown={shown} total={toc.length} active={active} go={go} q={q} setQ={setQ} /> : <div className="grid gap-2 py-1">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>}
          </CardContent>
        </Card>
      </aside>
      <div className="grid min-w-0 gap-4 lg:hidden">
        {many ? <label className="grid gap-1.5 t-label text-muted-foreground md:max-w-md">
          Documento
          <select value={cur} onChange={(e) => pickDoc(e.target.value)} className={SELECT}>
            {g.items.map((it) => <option key={it.id} value={it.id}>
              {plain(it.title)}
            </option>)}
          </select>
        </label> : null}
        {toc.length ? <details className="group border-y">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 t-label outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <I.ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
            Tópicos
            <span className="font-normal text-muted-foreground tnum">{toc.length}</span>
          </summary>
          <div className="pb-3">
            <Topicos shown={shown} total={toc.length} active={active} go={go} q={q} setQ={setQ} />
          </div>
        </details> : null}
      </div>
      <div data-tour-step-id="docs-leitura" className="min-w-0" key={cur}>
        {!cur ? <Empty icon={I.FileX} title="Nenhum documento neste grupo" />
          : docErr ? <Empty icon={I.CircleX} title={`Não foi possível abrir ${docTitle ? plain(docTitle) : cur}`}>
            {docErr}
          </Empty>
          : doc ? <>
            <p className="mb-6 flex flex-wrap items-baseline gap-x-2 t-meta text-muted-foreground">
              <Mono>{doc.id}</Mono>
              {doc.mtime ? <span>{'atualizado ' + ago(doc.mtime)}</span> : null}
            </p>
            <article ref={body} className={cn('md', PROSA)} dangerouslySetInnerHTML={{ __html: htmlDoc }} />
          </>
          : <div className="grid max-w-[41rem] gap-3" aria-busy="true" aria-label="Carregando o documento">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="mt-3 h-8 w-2/3" />
            <Skeleton className="h-4" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-40" />
          </div>}
      </div>
    </div>
  </div>;
}

HadesCore.registerPage('docs', Docs);
})();
