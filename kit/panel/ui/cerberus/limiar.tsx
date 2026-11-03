/* Bloco do Limiar na página Cerberus (reference/cerberus/limiar.md): o que tentou entrar, plugin por plugin. */
(() => {
const { I, Card, CardHeader, CardContent, Empty, Mono, ago } = HadesCore;
const { Efeito, Caminho } = window.HadesCerberus || {};
const ORDEM = { barra: 0, liberado: 1, aviso: 2, ok: 3 };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// a avaliação mais recente de cada plugin: os vereditos dela, do pior para o melhor
function porPlugin(historico) {
  const m = new Map();
  for (const v of historico || []) {
    if (v.momento !== 'plugin') continue;
    const nome = v.ctx?.plugin || '(sem nome)';
    const cur = m.get(nome);
    if (!cur || (v.ts || '') > cur.ts) m.set(nome, { nome, ts: v.ts || '', avaliacao: v.avaliacao, op: v.ctx?.op, commit: v.ctx?.commit, vs: [] });
    const e = m.get(nome);
    if (e.avaliacao === v.avaliacao) e.vs.push(v);
  }
  return [...m.values()].sort((a, b) => b.ts.localeCompare(a.ts));
}

function Bloco({ guardas, historico }) {
  const lista = porPlugin(historico);
  const barrados = lista.filter((e) => e.vs.some((v) => v.efeito === 'barra')).length;
  return <Card className="min-w-0">
    <CardHeader title="Limiar: o que tentou entrar" summary={lista.length ? `${plural(lista.length, 'plugin avaliado', 'plugins avaliados')} · ${barrados ? plural(barrados, 'barrado', 'barrados') : 'nenhum barrado'}`
      : `${plural(guardas?.length || 0, 'guarda', 'guardas')} no momento plugin`} />
    <CardContent>
      {lista.length ? <ul className="-mt-2">
        {lista.map((e) => <li key={e.nome} className="grid min-w-0 gap-2 border-b py-3 last:border-b-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="t-body [overflow-wrap:anywhere]">{e.nome}</span>
            <span className="t-meta text-muted-foreground">{e.op || 'plugin'}</span>
            {e.commit ? <Mono className="text-muted-foreground">{String(e.commit).slice(0, 12)}</Mono> : null}
            <span className="ml-auto t-meta text-muted-foreground tnum">{e.ts ? ago(e.ts) : ''}</span>
          </div>
          <ul className="grid gap-2 border-l pl-4">
            {[...e.vs].sort((a, b) => (ORDEM[a.efeito] ?? 9) - (ORDEM[b.efeito] ?? 9)).map((v) => <li key={v.guarda} className="grid min-w-0 gap-0.5">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <Efeito ef={v.efeito} className="t-label" />
                <Mono className="whitespace-nowrap">{v.guarda}</Mono>
              </div>
              {v.detalhe ? <span className="t-meta text-muted-foreground">{v.detalhe}</span> : null}
              {(v.evidencia || []).slice(0, 3).map((x, i) => <span key={i} className="t-meta">
                {x.conferido}
                {x.onde ? <span className="text-muted-foreground">{' em '}<Caminho>{x.onde}</Caminho></span> : null}
              </span>)}
            </li>)}
          </ul>
        </li>)}
      </ul> : <Empty icon={I.PackageCheck} title="Nenhum plugin avaliado ainda">Instalar, atualizar ou religar um plugin passa por aqui.</Empty>}
    </CardContent>
  </Card>;
}
if (window.HadesCerberus?.registerBlock) HadesCerberus.registerBlock('limiar', Bloco);
})();
