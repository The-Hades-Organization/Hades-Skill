/* Bloco da Porta na página Cerberus (reference/cerberus/porta.md): o que saiu hoje, por momento, e o último veredito de cada guarda. */
(() => {
const { cn, Card, CardHeader, CardContent } = HadesCore;
const { Efeito } = HadesCerberus;

const MOMENTOS = [['push', 'Push'], ['release', 'Release'], ['consolidacao', 'Consolidação'], ['comentario', 'Comentário'], ['artefato', 'Artefato'], ['tunel', 'Túnel']];
// o pior primeiro: o que barrou é o que o dono precisa ver
const ORDEM = { barra: 0, liberado: 1, aviso: 2, ok: 3 };
const PARTES = [['barra', 'barrou', 'font-medium text-bad'], ['aviso', 'avisou', 'text-warn'], ['liberado', 'liberado', 'text-info'], ['ok', 'passou', 'text-muted-foreground']];
const hoje = () => new Date().toISOString().slice(0, 10);   // histórico é em UTC (ISO com Z)

function contar(historico, momento) {
  const n = { ok: 0, aviso: 0, barra: 0, liberado: 0 };
  for (const v of historico) if (v.momento === momento && String(v.ts || '').startsWith(hoje())) n[v.efeito] = (n[v.efeito] || 0) + 1;
  return n;
}

const lista = (xs) => xs.length > 1 ? `${xs.slice(0, -1).join(', ')} ou ${xs.at(-1)}` : xs[0];

function Bloco({ cabeca, guardas, historico }) {
  const hist = [...(historico || [])].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const ultimo = (g) => hist.find((v) => v.guarda === g.id);
  const linhas = (guardas || []).map((g) => ({ g, v: ultimo(g) })).sort((a, b) => (ORDEM[a.v?.efeito] ?? 9) - (ORDEM[b.v?.efeito] ?? 9));
  const porMomento = MOMENTOS.map(([id, nome]) => { const n = contar(hist, id); return { id, nome, n, total: n.ok + n.aviso + n.barra + n.liberado }; });
  const saidas = porMomento.filter((m) => m.total), calados = porMomento.filter((m) => !m.total);
  return <Card className="min-w-0">
    <CardHeader title="Porta: o que saiu hoje (UTC)" summary={`modo ${cabeca?.modo || '—'}`} />
    <CardContent className="grid gap-4">
      {/* célula só para o momento que teve saída; os calados viram uma linha, não uma fileira de zeros */}
      {saidas.length ? <section aria-label="Saídas de hoje (UTC) por momento" className="flex flex-wrap border-t border-l sm:w-fit">
        {saidas.map(({ id, nome, n, total }) => <div key={id} className="flex min-w-36 flex-1 flex-col gap-1 border-r border-b bg-card px-4 py-3 sm:w-44 sm:flex-none">
          <span className="t-label text-muted-foreground">{nome}</span>
          <span className="t-kpi leading-none tnum">{total}</span>
          <span className="mt-1 flex flex-wrap gap-x-2 t-meta tnum">
            {PARTES.filter(([k]) => n[k]).map(([k, l, c]) => <span key={k} className={c}>{`${n[k]} ${l}`}</span>)}
          </span>
        </div>)}
      </section> : null}
      {calados.length ? <p className="t-body text-muted-foreground">
        {saidas.length ? `Nada hoje (UTC) em ${lista(calados.map((m) => m.nome.toLowerCase()))}.` : 'Nada saiu hoje (UTC).'}
      </p> : null}
      <ul>
        {linhas.map(({ g, v }) => <li key={g.id} className="grid min-w-0 gap-x-4 gap-y-0.5 border-b py-2.5 last:border-b-0 sm:grid-cols-[7rem_1fr]">
          <Efeito ef={v?.efeito} className={cn('self-start t-label sm:mt-0.5', !v && 'text-muted-foreground')} />
          <div className="grid min-w-0 gap-0.5">
            <span className="t-label">{g.titulo || g.id}</span>
            <span className="t-meta break-words text-muted-foreground">
              {v?.evidencia?.[0]?.conferido || (g.momentos || []).join(' · ')}
            </span>
          </div>
        </li>)}
      </ul>
    </CardContent>
  </Card>;
}
HadesCerberus.registerBlock('porta', Bloco);
})();
