/* Vigília na página Cerberus (reference/cerberus/vigilia.md): a calibração das guardas que conferem o DONE e a
 * coerência entre plano, registro e realidade. Em `avisa`, o que importa é quanto cada guarda barraria e por quê:
 * é com isso que o dono decide quando passar a cabeça para `barra`. */
(() => {
const { useState, cn, Card, CardHeader, CardContent, Mono, Table, Th, Td, Tr, Empty, Tip, ago, I } = HadesCore;
const { Caminho } = HadesCerberus;

const TOM = { ok: 'ok', aviso: 'warn', barra: 'bad' };

// por guarda: quantos vereditos de cada resultado e o último que não foi ok (o histórico já vem filtrado pela cabeça)
function calibracao(guardas, historico) {
  const porId = {};
  for (const g of guardas) porId[g.id] = { g, ok: 0, aviso: 0, barra: 0, invalido: 0, ultimo: null, problema: null };
  for (const v of historico) {
    const c = porId[v.guarda];
    if (!c) continue;
    if (v.resultado in TOM) c[v.resultado] += 1;
    if (v.invalido) c.invalido += 1;
    c.ultimo = v;
    if (v.resultado !== 'ok') c.problema = v;
  }
  return Object.values(porId).sort((a, b) => (b.barra - a.barra) || (b.aviso - a.aviso) || a.g.id.localeCompare(b.g.id));
}

function Evidencia({ v }) {
  if (!v) return <span className="text-muted-foreground">—</span>;
  const e = (v.evidencia || []).find((x) => x.conferido.startsWith('[')) || (v.evidencia || [])[0];
  return <div className="flex min-w-0 flex-col gap-0.5 whitespace-normal">
    <span className="t-body">{v.detalhe || e?.conferido}</span>
    {e ? <Caminho className="text-muted-foreground">{e.onde}</Caminho> : null}
    <span className="t-meta text-muted-foreground tnum">{ago(v.ts) + (v.ctx?.agente ? ` · ${v.ctx.agente}` : '')}</span>
  </div>;
}

// a evidência inteira quando a linha está aberta, senão o resumo; em tela estreita vai sob o nome da guarda (a coluna
// do último problema não cabe a 390 px)
function Problema({ c, aberta }) {
  if (!aberta || !c.problema) return <Evidencia v={c.problema} />;
  return <ul className="flex flex-col gap-1 whitespace-normal">
    {c.problema.evidencia.map((e, i) => <li key={i} className="t-meta">
      {e.conferido}
      {e.onde ? <span className="text-muted-foreground">{' em '}<Caminho>{e.onde}</Caminho></span> : null}
    </li>)}
  </ul>;
}

function Bloco({ cabeca, guardas, historico }) {
  const [aberta, setAberta] = useState(null);
  const execs = guardas.filter((g) => g.tipo === 'exec');
  const linhas = calibracao(execs, historico);
  const total = linhas.reduce((s, c) => s + c.ok + c.aviso + c.barra, 0);
  // fora do modo barra o resultado é o que a guarda diria, não o que foi feito: os rótulos vão no condicional
  const cond = cabeca.modo === 'barra' ? ['Passou', 'Avisou', 'Barrou'] : ['Passaria', 'Avisaria', 'Barraria'];
  const barrariam = linhas.reduce((s, c) => s + c.barra, 0);
  const desc = cabeca.modo === 'avisa'
    ? `Em calibração: ${barrariam} de ${total} vereditos barrariam no modo barra.`
    : `Modo ${cabeca.modo}: ${barrariam} barras em ${total} vereditos.`;
  return <Card>
    <CardHeader title="Vigília: auditoria do DONE e coerência" description={desc} />
    <CardContent>
      {!linhas.length ? <Empty icon={I.Eye} title="Nenhuma guarda executável na Vigília">As regras só escritas não entram na calibração.</Empty> : <Table>
        <thead>
          <tr className="border-b">
            <Th>Guarda</Th>
            <Th className="hidden md:table-cell">Momentos</Th>
            <Th className="hidden text-right md:table-cell">{cond[0]}</Th>
            <Th className="hidden text-right md:table-cell">{cond[1]}</Th>
            <Th className="text-right">{cond[2]}</Th>
            <Th className="hidden md:table-cell">Último problema</Th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((c) => <Tr key={c.g.id} className={cn('cursor-pointer outline-none [&>td]:align-top focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring', aberta === c.g.id && 'bg-accent/40')} tabIndex={0} aria-expanded={aberta === c.g.id} onClick={() => setAberta(aberta === c.g.id ? null : c.g.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAberta(aberta === c.g.id ? null : c.g.id); } }}>
            <Td className="whitespace-normal">
              <Tip text={c.g.descricao || c.g.titulo}>
                <span className="flex flex-col gap-0.5">
                  <Mono className="whitespace-nowrap">{c.g.id}</Mono>
                  <span className="t-meta whitespace-normal text-muted-foreground">{c.g.titulo}</span>
                </span>
              </Tip>
              <div className="mt-1.5 grid gap-1 whitespace-normal md:hidden">
                <span className="t-meta text-muted-foreground tnum">{`${c.ok} ${cond[0].toLowerCase()} · ${c.aviso} ${cond[1].toLowerCase()}`}</span>
                {c.problema && aberta === c.g.id ? <Problema c={c} aberta /> : null}
                {c.problema && aberta !== c.g.id ? <span className="line-clamp-2 t-meta">{c.problema.detalhe || c.problema.evidencia?.[0]?.conferido}</span> : null}
              </div>
            </Td>
            <Td className="hidden md:table-cell">
              <span className="t-label text-muted-foreground">{c.g.momentos.join(' · ')}</span>
            </Td>
            <Td className="hidden text-right text-muted-foreground tnum md:table-cell">{c.ok}</Td>
            <Td className={cn('hidden text-right tnum md:table-cell', c.aviso ? 'text-warn' : 'text-muted-foreground')}>{c.aviso}</Td>
            <Td className="text-right tnum">
              <span className={c.barra ? 'font-semibold text-bad' : 'text-muted-foreground'}>{c.barra}</span>
              {c.invalido ? <Tip text="vereditos descartados (guarda quebrada ou fora do tempo)" className="ml-2 max-md:ml-0 max-md:flex">
                <span className="t-meta text-warn">{c.invalido + ' inválido' + (c.invalido > 1 ? 's' : '')}</span>
              </Tip> : null}
            </Td>
            <Td className="hidden min-w-64 md:table-cell">
              <Problema c={c} aberta={aberta === c.g.id} />
            </Td>
          </Tr>)}
        </tbody>
      </Table>}
    </CardContent>
  </Card>;
}

HadesCerberus.registerBlock('vigilia', Bloco);
})();
