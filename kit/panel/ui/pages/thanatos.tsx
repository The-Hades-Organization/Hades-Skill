/* Página Thanatos (#/thanatos): post-mortems do projeto (hades thanatos). Lista à esquerda, leitura à direita. */
(() => {
const { useState, useEffect, useMemo, I, cn, getJSON, Card, CardHeader, CardContent, Input, Mono, Empty, Skeleton, Loading,
  LinhaDeEstado, renderMd, dur, ago, useTourPreview, ExampleSeal } = HadesCore;

// O .md traz texto de PR (terceiros): o renderMd já descarta HTML cru, e aqui sobram links e imagens, que só valem http(s).
function safeHtml(md) {
  const box = document.createElement('template');
  box.innerHTML = renderMd(md);
  for (const a of box.content.querySelectorAll('a[href]')) if (!/^(https?:|#)/i.test(a.getAttribute('href').trim())) a.removeAttribute('href');
  for (const img of box.content.querySelectorAll('img')) img.remove();
  alvosDoTour(box.content);
  return box.innerHTML;
}
// seções do .md que o tour aponta: a seção (título e o que vem até o próximo título) ganha o id do passo
const SECAO_ALVO = [
  [/^Causa/, 'thanatos-causa'], // data-tour-step-id
  [/^Como foi corrigido/, 'thanatos-correcao'], // data-tour-step-id
  [/^Lacunas/, 'thanatos-lacunas'], // data-tour-step-id
];
function alvosDoTour(root) {
  for (const h of [...root.querySelectorAll('h2')]) {
    const alvo = SECAO_ALVO.find(([titulo]) => titulo.test(h.textContent.trim()));
    if (!alvo) continue;
    const secao = document.createElement('section');
    secao.setAttribute('data-tour-step-id', alvo[1]);
    h.before(secao);
    let el = h;
    while (el && (el === h || el.tagName !== 'H2')) { const next = el.nextElementSibling; secao.append(el); el = next; }
  }
}
// com o documento estruturado em mãos, o título, o resumo e a linha do tempo saem do .md: a página os desenha
function semSecoes(md) {
  const out = [];
  let skip = false;
  for (const l of md.split('\n')) {
    if (/^# /.test(l)) continue;
    if (/^## /.test(l)) skip = /^## (Resumo|Linha do tempo)/.test(l);
    if (!skip) out.push(l);
  }
  return out.join('\n').replace(/^\s*Gerado em [^\n]*\n/, '');
}

// as seções do .md no ritmo das seções da página (h2 de 1rem com filete), não no da Documentação
const MD = 'md max-w-[70ch] [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:pb-2.5 [&_h2]:t-section [&_h2]:tracking-normal [&>h2:first-child]:mt-0';
const ROW = 'grid w-full gap-1 border-b border-l-2 border-l-transparent px-3 py-2.5 text-left t-body transition-colors cursor-pointer hover:bg-accent/60 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';
const SRC = { git: 'git', gh: 'GitHub', diario: 'diário', fonte: 'fonte externa' };
const BASIS = { fonte: 'início do incidente, segundo a fonte externa', intervalo: 'início do intervalo pedido',
  'primeiro-commit': 'primeiro commit da correção', 'abertura-da-pr': 'abertura da PR de correção' };
const quando = (t) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
// o fio do incidente: inteiro antes do corte, tracejado em vermelhão do corte até a correção, medido depois dela
const TRECHO = { antes: { background: 'var(--border-strong)' }, depois: { background: 'var(--foreground)', opacity: 0.7 },
  vao: { background: 'var(--bad)', mask: 'repeating-linear-gradient(180deg, #000 0 3px, #0000 3px 7px)' } };

function LinhaDoTempo({ pm }) {
  const ttf = pm.fixData?.timeToFix;
  const from = ttf ? Date.parse(ttf.from) : null, to = ttf ? Date.parse(ttf.to) : null;
  const fase = (t) => from == null ? 'antes' : t < from ? 'antes' : t < to ? 'vao' : 'depois';
  const rows = pm.timeline.map((e) => ({ ...e, t: Date.parse(e.ts), kind: 'evento' }));
  if (from != null) {
    const at = rows.findIndex((r) => r.t >= from);
    rows.splice(at < 0 ? rows.length : at, 0, { t: from, kind: 'corte', text: BASIS[ttf.basis] || 'início contado daqui' });
    const fix = rows.findIndex((r) => r.kind === 'evento' && r.t >= to);
    if (fix >= 0) rows[fix] = { ...rows[fix], kind: 'correcao' };
  }
  if (!rows.length) return <Empty tour={false} icon={I.History} title="Sem eventos na linha do tempo." />;
  return <ol>
    {rows.map((r, i) => { const up = r.kind === 'correcao' ? 'vao' : fase(r.t), down = r.kind === 'corte' ? 'vao' : fase(r.t);
      const novoDia = i === 0 || new Date(rows[i - 1].t).toDateString() !== new Date(r.t).toDateString();
      return <li key={i} className="grid grid-cols-[5.5rem_1.25rem_minmax(0,1fr)] gap-x-3">
        <time dateTime={new Date(r.t).toISOString()} className="pt-2.5 text-right t-data text-muted-foreground">
          {novoDia ? quando(r.t) : new Date(r.t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
        </time>
        <span className="relative" aria-hidden="true">
          {i ? <span className="absolute top-0 left-1/2 h-4 w-px -translate-x-1/2" style={TRECHO[up]} /> : null}
          {i < rows.length - 1 ? <span className="absolute top-4 bottom-0 left-1/2 w-px -translate-x-1/2" style={TRECHO[down]} /> : null}
          {r.kind === 'corte' ? <svg width="12" height="14" viewBox="0 0 12 14" className="absolute top-2 left-1/2 -translate-x-1/2 text-bad">
            <path d="M6 0 V6 M6 6 L2 11 M6 6 L6 13 M6 6 L10 11" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
          </svg> : <span className={cn('absolute top-4 left-1/2 -translate-x-1/2 -translate-y-1/2 rotate-45', r.kind === 'correcao' ? 'size-2 bg-foreground' : 'size-1.5 bg-muted-foreground')} />}
        </span>
        <p className={cn('min-w-0 py-2 t-body break-words', r.kind === 'corte' && 'font-medium text-bad')}>
          {r.kind === 'corte' ? 'Início da contagem: ' + r.text : <>
            <span className="mr-2 t-data text-muted-foreground">
              {SRC[r.source] || r.source}
            </span>
            {r.text}
            {r.kind === 'correcao' ? <span className="font-medium">
              {' · corrigido em ' + dur(ttf.ms / 1000)}
            </span> : null}
          </>}
        </p>
      </li>; })}
  </ol>;
}

function Documento({ doc, example }) {
  const pm = doc.postmortem;
  const html = useMemo(() => safeHtml(pm ? semSecoes(doc.markdown) : doc.markdown), [doc]);
  if (!pm) return <article className="md max-w-[70ch]" dangerouslySetInnerHTML={{ __html: html }} />;
  const ttf = pm.fixData?.timeToFix;
  const prs = pm.fixData?.prs || [];
  return <div className="grid gap-8">
    <header className="grid gap-2">
      <h2 className="flex flex-wrap items-center gap-x-3 gap-y-1 t-section-lg leading-snug">
        {example ? <ExampleSeal /> : null}
        {pm.title}
      </h2>
      <LinhaDeEstado main={ttf ? `corrigido em ${dur(ttf.ms / 1000)}` : 'sem correção mergeada'}
        rest={[prs.length ? `${prs.length} PR${prs.length > 1 ? 's' : ''}` : null,
          pm.fixData?.commits?.length ? `${pm.fixData.commits.length} commit${pm.fixData.commits.length > 1 ? 's' : ''}` : null,
          pm.gaps?.length ? <span key="lac" className="text-warn">{`${pm.gaps.length} ${pm.gaps.length > 1 ? 'seções' : 'seção'} sem dado das PRs: edite o .md`}</span> : null,
          'gerado ' + ago(pm.createdAt)]} />
      <p className="max-w-[70ch] t-prose leading-7 text-muted-foreground">
        {pm.summary}
      </p>
    </header>
    <section className="grid gap-3" data-tour-step-id="thanatos-linha">
      <CardHeader as="h3" title="Linha do tempo" summary="horário local" />
      <LinhaDoTempo pm={pm} />
    </section>
    <article className={MD} dangerouslySetInnerHTML={{ __html: html }} />
  </div>;
}

function Thanatos() {
  // tour da página rodando com exemplo: a lista e o documento vêm da prévia, não do servidor
  const example = useTourPreview('thanatos');
  const [items, setItems] = useState(null);
  const [cur, setCur] = useState(null);
  const [doc, setDoc] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { getJSON('/api/thanatos').then((r) => setItems(r.items || [])).catch(() => setItems([])); }, []);
  const list = example ? example.items : items;
  const selected = cur && list?.some((i) => i.id === cur) ? cur : list?.[0]?.id;
  useEffect(() => {
    if (!selected) return;
    if (example) { setDoc(example.docs[selected] || { error: 'exemplo indisponível' }); return; }
    setDoc(null);
    getJSON('/api/thanatos/' + encodeURIComponent(selected)).then((r) => setDoc(r.markdown ? r : { error: r.error || 'arquivo ilegível' })).catch(() => setDoc({ error: 'o painel não respondeu' }));
  }, [selected, example]);
  const shown = useMemo(() => (list || []).filter((i) => `${i.id} ${i.title}`.toLowerCase().includes(q.toLowerCase())), [list, q]);
  if (!list) return <Loading />;
  if (list.length === 0) return <Empty icon={I.Skull} title="Nenhum post-mortem ainda.">
    {"Gere um com "}
    <Mono>
      {'hades thanatos new 123'}
    </Mono>
    {" (PR), "}
    <Mono>
      {'FIX-77'}
    </Mono>
    {" (card) ou "}
    <Mono>
      {'2026-10-01T00:00Z..2026-10-02T00:00Z'}
    </Mono>
    {" (intervalo, com fuso)."}
  </Empty>;
  return <div className="grid items-start gap-8 lg:grid-cols-[300px_minmax(0,1fr)]">
    <Card className="gap-0 lg:sticky lg:top-20" data-tour-step-id="thanatos-lista">
      <CardHeader title="Post-mortems" summary={q ? `${shown.length} de ${list.length}` : `${list.length}`} action={example ? <ExampleSeal /> : null} />
      <div className="border-b py-2" data-tour-step-id="thanatos-filtro">
        <Input icon={I.Search} value={q} onInput={(e) => setQ(e.target.value)} placeholder="Filtrar por id ou título" aria-label="Filtrar post-mortems" />
      </div>
      <CardContent className="overflow-y-auto scrollbar-thin max-lg:max-h-72 lg:max-h-[calc(100vh-14rem)]">
        <nav aria-label="Post-mortems">
          {shown.map((i) => { const on = selected === i.id; return <button key={i.id} type="button" onClick={() => setCur(i.id)} aria-current={on ? 'true' : undefined} className={cn(ROW, on && 'border-l-foreground bg-accent/40')}>
            <span className={cn('line-clamp-2 text-pretty', on && 'font-medium')}>
              {i.title}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-2 t-meta text-muted-foreground tnum">
              <Mono>
                {i.id}
              </Mono>
              {i.timeToFixMs != null ? <span>
                {'corrigido em ' + dur(i.timeToFixMs / 1000)}
              </span> : <span>sem correção</span>}
              {i.gaps ? <span className="text-warn">
                {`${i.gaps} ${i.gaps > 1 ? 'seções' : 'seção'} a preencher`}
              </span> : null}
              <span>
                {'gerado ' + ago(i.createdAt)}
              </span>
            </span>
          </button>; })}
          {shown.length === 0 ? <div className="px-3">
            <Empty tour={false} icon={I.SearchX} title={`Nada com "${q}".`} />
          </div> : null}
        </nav>
      </CardContent>
    </Card>
    <div className="grid min-w-0 gap-6">
      {!doc ? <div className="grid gap-3" aria-busy="true" aria-label="Carregando o post-mortem">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-40" />
      </div> : doc.error ? <Empty tour={false} icon={I.CircleAlert} title="Post-mortem indisponível.">
        {doc.error}
      </Empty> : <Documento doc={doc} example={!!example} />}
      <p className="border-t pt-3 t-meta text-muted-foreground" data-tour-step-id="thanatos-gerar">
        {"Somente leitura, fora do repositório: "}
        <Mono>
          {'work/<dono>__<repo>/postmortems'}
        </Mono>
        .
      </p>
    </div>
  </div>;
}
HadesCore.registerPage('thanatos', Thanatos);
})();
