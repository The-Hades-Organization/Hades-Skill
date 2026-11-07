/* Página Cerberus (#/cerberus): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela.
 * Os blocos das cabeças (ui/cerberus/<cabeça>.js, reference/cerberus.md) se registram por HadesCerberus.registerBlock.
 * As três cabeças são objetos (cartão); o resto da página fica no chão: o que barrou, as exceções e o histórico. */
(() => {
const { useState, useEffect, useCallback, useMemo, I, cn, post, getJSON, ErroExplicado, Button, Dot, Card, CardHeader, CardContent,
  Mono, Tip, Empty, Table, Th, Td, Tr, Dialog, DialogHeader, DialogFooter, Choice, useWide, useApp, ago, Loading, CFG_ICON,
  LinhaDeEstado, Tracos, useTourPreview, ExampleSeal, Select } = HadesCore;

CFG_ICON.Cerberus ??= I.Cerberus;   // ícone do grupo Cerberus em Configurações

const CB_ASPECT = { porta: 'O que sai: push, comentário de PR, artefato, túnel e release',
  limiar: 'O que entra: plugin, hooks, páginas e rotas do painel',
  vigilia: 'O que acontece dentro: DONE e coerência entre plano, registro e realidade' };
// modo da cabeça: o ponto, a palavra e o que o modo faz (visível, não só na dica)
const CB_MODE = { barra: ['info', 'barra', 'bloqueia'], avisa: ['warn', 'avisa', 'deixa passar e registra'],
  off: ['idle', 'desligada', 'não avalia'] };
// o efeito de um veredito, igual na página e nos blocos (HadesCerberus.Efeito)
const CB_EFFECT = { ok: ['ok', 'passou'], aviso: ['warn', 'avisou'], barra: ['bad', 'barrou'], liberado: ['info', 'liberado'] };
const CB_TRACO = { ok: 'ok', aviso: 'warn', barra: 'bad' };
const CB_TYPE = { exec: 'executa', emitida: 'emitida', regra: 'só regra escrita' };
const CB_MOMENTO = { push: 'Push', release: 'Release', consolidacao: 'Consolidação', comentario: 'Comentário', artefato: 'Artefato', tunel: 'Túnel' };
const CB_PAGE = 50;           // linhas do histórico por vez
const CB_TRACOS = 48;         // vereditos recentes desenhados no cartão de cada cabeça
const CB_MOTIVO_MIN = 10;     // o mesmo mínimo do open_exception (hades cerberus)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// caminho e evidência longos quebram depois das barras, não no meio de um nome; sem barra só quebram se não couber
const Caminho = ({ children, className }) => <Mono className={cn('[overflow-wrap:anywhere]', className)}>
  {String(children ?? '').split(/(?<=\/)/).map((p, i) => <React.Fragment key={i}>{i ? <wbr /> : null}{p}</React.Fragment>)}
</Mono>;
const Efeito = ({ ef, className }) => {
  const [k, l] = CB_EFFECT[ef] || ['idle', ef || 'sem veredito'];
  return <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', k === 'bad' && 'font-medium text-bad', className)}>
    <Dot kind={k} />
    {l}
  </span>;
};
const rowFocus = 'cursor-pointer outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

// blocos das cabeças: o script registra; quem montou a página é avisado para redesenhar
const blocks = {};
const blockListeners = new Set();
window.HadesCerberus = {
  registerBlock(cab, Comp) {
    if (typeof cab !== 'string' || typeof Comp !== 'function') throw new TypeError('registerBlock(cabeça, Componente)');
    blocks[cab] = Comp;
    blockListeners.forEach((f) => f());
  },
  // peças comuns aos blocos, para as quatro partes da página falarem igual
  Caminho, Efeito, EFEITO: CB_EFFECT,
};
const requested = new Set();
function loadBlocks(names) {
  for (const cab of names || []) {
    if (requested.has(cab) || !/^[a-z]+$/.test(cab)) continue;
    requested.add(cab);
    const el = document.createElement('script');
    el.src = `/ui/cerberus/${cab}.js`;
    el.onerror = () => console.warn(`cerberus: bloco ${cab} não carregou`);
    document.body.appendChild(el);
  }
}
function useBlocks() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    blockListeners.add(f);
    return () => blockListeners.delete(f);
  }, []);
  return blocks;
}

// bloco de cabeça com erro de tela vira uma linha; o resto da página segue
class BlockBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { console.error(`cerberus: bloco ${this.props.cab} falhou`, err); }
  render() {
    return this.state.err ? <Empty icon={I.TriangleAlert} title={`Erro no bloco da ${this.props.nome}`}>
      Detalhe no console do navegador.
    </Empty> : this.props.children;
  }
}

function Evidence({ items }) {
  return <ul className="grid gap-1">
    {(items || []).map((e, i) => <li key={i} className="min-w-0 t-body">
      {e.conferido}
      {e.onde ? <span className="text-muted-foreground">{' em '}<Caminho>{e.onde}</Caminho></span> : null}
    </li>)}
  </ul>;
}

function GuardRow({ g }) {
  return <li className="grid min-w-0 gap-1 border-b py-2.5 last:border-b-0">
    <div className="flex items-baseline justify-between gap-3">
      <span className="t-label">{g.titulo}</span>
      <span className="shrink-0 t-meta text-muted-foreground">{CB_TYPE[g.tipo] || g.tipo}</span>
    </div>
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 t-meta text-muted-foreground">
      <Mono className="whitespace-nowrap text-foreground">{g.id}</Mono>
      <span>{g.momentos.join(' · ')}</span>
      {g.tipo === 'regra' && g.dono !== g.cabeca ? <span>{'regra mantida pela ' + g.dono}</span> : null}
    </div>
    {g.descricao ? <p className="t-meta text-muted-foreground">{g.descricao}</p> : null}
    <span className="t-meta text-muted-foreground">
      {'origem '}
      <Caminho>{g.origem}</Caminho>
    </span>
  </li>;
}

const verGuardas = (n) => (n === 1 ? 'Ver a guarda' : `Ver as ${plural(n, 'guarda', 'guardas')}`);
// a cabeça é o objeto: modo, guardas, a forma dos vereditos recentes (um traço cada) e a lista das guardas sob demanda
function HeadCard({ c, guards, hist }) {
  const [open, setOpen] = useState(false);
  const regras = guards.filter((g) => g.tipo === 'regra').length;
  const [mk, ml, mt] = CB_MODE[c.modo] || ['idle', c.modo, ''];
  const recent = hist.slice(-CB_TRACOS);
  const last = hist[hist.length - 1];
  const n = (ef) => recent.filter((r) => r.efeito === ef).length;
  const listId = `cb-guardas-${c.id}`;
  return <Card variant="object" className="lg:row-span-3 lg:grid lg:grid-rows-subgrid lg:gap-y-4">
    <CardHeader title={c.nome} description={CB_ASPECT[c.id]} action={<Tip text="Muda em Configurações, só no painel local">
      <a href="#/config?q=cerberus" data-tour-step-id="cerberus-modo" className="inline-flex items-center gap-1.5 t-label whitespace-nowrap underline-offset-3 hover:underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11">
        <Dot kind={mk} />
        {(c.modo === 'off' ? ml : 'modo ' + ml) + (mt ? ' · ' + mt : '')}
      </a>
    </Tip>} />
    <div className="grid content-start gap-2">
      <LinhaDeEstado main={plural(guards.length, 'guarda', 'guardas')} rest={[regras ? `${regras} só regra escrita` : null, last ? `último veredito ${ago(last.ts)}` : 'sem veredito ainda']} />
      {recent.length ? <div className="grid gap-1.5" data-tour-step-id="cerberus-tracos">
        <Tracos items={recent.map((r) => r.efeito === 'liberado' ? 'idle' : CB_TRACO[r.efeito] || 'idle')} label={`Últimos ${recent.length} vereditos: ${n('ok')} passaram, ${n('aviso')} avisaram, ${n('barra')} barraram, ${n('liberado')} liberados por exceção`} />
        <span className="t-meta text-muted-foreground tnum">
          {`últimos ${recent.length} vereditos`}
          {n('barra') ? <span className="font-medium text-bad">{` · ${n('barra')} barrou`}</span> : null}
          {n('aviso') ? ` · ${n('aviso')} avisou` : null}
        </span>
      </div> : null}
    </div>
    <div className="grid content-start" data-tour-step-id="cerberus-guardas">
      {guards.length ? <>
        <Button size="sm" variant="ghost" className="-ml-2.5 justify-self-start" aria-expanded={open} aria-controls={listId} icon={open ? I.ChevronUp : I.ChevronDown} onClick={() => setOpen(!open)}>
          {open ? 'Esconder as guardas' : verGuardas(guards.length)}
        </Button>
        {open ? <ul id={listId} className="mt-2 border-t">
          {guards.map((g) => <GuardRow key={g.id} g={g} />)}
        </ul> : null}
      </> : <p className="t-body text-muted-foreground">Nenhuma guarda registrada nesta cabeça.</p>}
    </div>
  </Card>;
}

function Verdict({ sel, x, onClose }) {
  const g = sel && x.guardas.find((it) => it.cabeca === sel.cabeca && it.id === sel.guarda);
  const head = sel && x.cabecas.find((c) => c.id === sel.cabeca);
  return <Dialog open={!!sel} onClose={onClose} label="Veredito" className="sm:max-w-xl">
    {sel ? <>
      <DialogHeader title={g?.titulo || sel.guarda} description={`${head?.nome || sel.cabeca}, momento ${sel.momento}`} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 border-y py-3 t-body">
        <dt className="text-muted-foreground">Efeito</dt>
        <dd className="flex flex-wrap items-center gap-x-2">
          <Efeito ef={sel.efeito} />
          {sel.efeito !== sel.resultado ? <span className="t-meta text-muted-foreground">{`a guarda disse ${sel.resultado}, o modo ${sel.modo} decidiu`}</span> : null}
        </dd>
        {sel.invalido ? <>
          <dt className="text-muted-foreground">Validade</dt>
          <dd className="text-warn">veredito inválido (guarda quebrada ou fora do tempo)</dd>
        </> : null}
        <dt className="text-muted-foreground">Quando</dt>
        <dd className="tnum">{`${new Date(sel.ts).toLocaleString('pt-BR')} · ${ago(sel.ts)}`}</dd>
        <dt className="text-muted-foreground">Guarda</dt>
        <dd><Mono className="whitespace-nowrap">{`${sel.cabeca}/${sel.guarda}`}</Mono></dd>
      </dl>
      {sel.detalhe ? <p className="max-w-[70ch] t-body">{sel.detalhe}</p> : null}
      {(sel.evidencia || []).length ? <section className="grid gap-1.5">
        <h3 className="t-body-strong">Evidência</h3>
        <Evidence items={sel.evidencia} />
      </section> : null}
      {sel.excecao ? <section className="grid gap-1 t-body">
        <h3 className="flex items-center gap-2 font-semibold"><Dot kind="info" />Liberado por exceção</h3>
        <p className="text-pretty">{sel.excecao.motivo}</p>
        <span className="t-meta text-muted-foreground">
          <Mono className="whitespace-nowrap">{sel.excecao.id}</Mono>
          {` · aberta por ${sel.excecao.por} · ${sel.excecao.aberta}`}
        </span>
      </section> : null}
      {Object.keys(sel.ctx || {}).length ? <section className="grid gap-1">
        <h3 className="t-body-strong">Contexto</h3>
        <Caminho className="text-muted-foreground">{Object.entries(sel.ctx).map(([k, v]) => `${k}=${v}`).join(' ')}</Caminho>
      </section> : null}
    </> : null}
  </Dialog>;
}

function History({ x, example }) {
  const wide = useWide(768);
  const [cab, setCab] = useState('');
  const [ef, setEf] = useState('');
  const [n, setN] = useState(CB_PAGE);
  const [sel, setSel] = useState(null);
  const rows = useMemo(() => x.historico.filter((r) => (!cab || r.cabeca === cab) && (!ef || r.efeito === ef)).reverse(), [x.historico, cab, ef]);
  const count = (pred) => x.historico.filter(pred).length;
  const nome = (id) => (x.cabecas.find((c) => c.id === id) || {}).nome || id;
  const pick = (f) => (v) => { f(v); setN(CB_PAGE); };
  return <Card className="min-w-0" data-tour-step-id="cerberus-historico">
    <CardHeader title="Histórico de vereditos" summary={`${x.historico.length} mais recentes de ${x.total}`} action={example ? <ExampleSeal /> : null} />
    <CardContent className="grid gap-3">
      <div className="flex flex-wrap gap-2" data-tour-step-id="cerberus-filtros">
        <Choice wide={wide} className="flex-1" label="Cabeça" value={cab} onChange={pick(setCab)} items={[{ value: '', label: wide ? 'Todas' : 'Todas as cabeças' }, ...x.cabecas.map((c) => ({ value: c.id, label: c.nome, count: count((r) => r.cabeca === c.id) }))]} />
        <Choice wide={wide} className="flex-1" label="Efeito" value={ef} onChange={pick(setEf)} items={[{ value: '', label: wide ? 'Todos' : 'Todos os efeitos' }, ...Object.keys(CB_EFFECT).map((k) => ({ value: k, label: CB_EFFECT[k][1][0].toUpperCase() + CB_EFFECT[k][1].slice(1), count: count((r) => r.efeito === k) }))]} />
      </div>
      {rows.length ? <>
        <Table>
          <thead>
            <tr className="border-b">
              <Th className="w-24">Quando</Th>
              <Th className="hidden md:table-cell">Cabeça</Th>
              <Th>Guarda</Th>
              <Th className="hidden md:table-cell">Momento</Th>
              <Th>Efeito</Th>
              <Th className="hidden lg:table-cell">Detalhe</Th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, n).map((r, i) => <Tr key={r.avaliacao + r.guarda + i} className={rowFocus} tabIndex={0} aria-haspopup="dialog" onClick={() => setSel(r)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(r); } }}>
              <Td className="text-muted-foreground tnum">
                <Tip text={new Date(r.ts).toLocaleString('pt-BR')}>{ago(r.ts)}</Tip>
              </Td>
              <Td className="hidden md:table-cell">{nome(r.cabeca)}</Td>
              <Td>
                <Mono>{r.guarda}</Mono>
                <span className="block t-meta text-muted-foreground md:hidden">{`${nome(r.cabeca)} · ${r.momento}`}</span>
              </Td>
              <Td className="hidden text-muted-foreground md:table-cell">{r.momento}</Td>
              <Td>
                <Efeito ef={r.efeito} />
                {r.efeito !== r.resultado ? <span className="ml-1.5 t-meta text-muted-foreground">{`(a guarda disse ${r.resultado})`}</span> : null}
              </Td>
              <Td className="hidden max-w-[32rem] truncate text-muted-foreground lg:table-cell">
                {r.detalhe || (r.evidencia?.[0]?.conferido ?? '')}
              </Td>
            </Tr>)}
          </tbody>
        </Table>
        {rows.length > n ? <Button size="sm" variant="outline" className="justify-self-center" onClick={() => setN(n + CB_PAGE)}>
          {`Mostrar mais ${Math.min(CB_PAGE, rows.length - n)} de ${rows.length - n}`}
        </Button> : null}
      </> : <Empty icon={I.ShieldCheck} title={x.historico.length ? 'Nenhum veredito com este filtro' : 'Nenhum veredito ainda'}>
        {cab || ef ? <Button size="sm" variant="outline" onClick={() => { setCab(''); setEf(''); }}>Limpar filtros</Button> : 'Cada push, release, plugin e DONE avaliado aparece aqui.'}
      </Empty>}
    </CardContent>
    <Verdict sel={sel} x={x} onClose={() => setSel(null)} />
  </Card>;
}

function Barred({ x, example }) {
  const vezes = x.barrados.reduce((s, b) => s + (b.vezes || 0), 0);
  return <Card className="min-w-0" data-tour-step-id="cerberus-barrados">
    <CardHeader title="O que cada guarda barrou" summary={x.barrados.length ? `${plural(vezes, 'vez', 'vezes')} no histórico` : 'nada barrado'} action={example ? <ExampleSeal /> : null} />
    {x.barrados.length ? <CardContent>
      <ul className="-mt-2">
        {x.barrados.map((b) => <li key={b.cabeca + b.guarda} className="grid min-w-0 gap-1.5 border-b py-3 last:border-b-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <Mono className="whitespace-nowrap t-label">{`${b.cabeca}/${b.guarda}`}</Mono>
            <span className="t-body-strong text-bad tnum">{b.vezes + '×'}</span>
            <span className="t-meta text-muted-foreground tnum sm:ml-auto">{`último ${ago(b.ultimo.ts)} em ${b.ultimo.momento}`}</span>
          </div>
          <Evidence items={b.ultimo.evidencia} />
        </li>)}
      </ul>
    </CardContent> : null}
  </Card>;
}

const CTL = 'h-8 w-full min-w-0 border border-border-strong bg-background px-3 t-body outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-bad max-md:h-11';
function OpenException({ x, open, onClose, onDone }) {
  const { toast } = useApp();
  const guards = x.guardas.filter((g) => g.tipo !== 'regra');
  const [gk, setGk] = useState('');
  const [momento, setMomento] = useState('');
  const [alvo, setAlvo] = useState('');
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const g = guards.find((it) => `${it.cabeca}/${it.id}` === gk);
  useEffect(() => { setMomento(g ? g.momentos[0] : ''); }, [gk]);
  const pairs = alvo.trim() ? alvo.trim().split(/\s+/) : [];
  const alvoOk = pairs.every((p) => /^[a-z][a-z0-9_]{0,31}=.+$/.test(p));
  const falta = CB_MOTIVO_MIN - motivo.trim().length;
  const ok = g && momento && alvoOk && falta <= 0;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post('/api/cerberus', { action: 'excecao', cabeca: g.cabeca, guarda: g.id, momento, motivo,
        alvo: Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)])) });
      toast({ kind: 'ok', title: 'Exceção aberta', desc: `${g.cabeca}/${g.id} em ${momento}, uso único` });
      setGk(''); setAlvo(''); setMotivo('');
      onDone(r);
    } catch (e) { toast({ kind: 'bad', title: 'Exceção recusada', desc: e.message }); }
    setBusy(false);
  };
  return <Dialog open={open} onClose={onClose} label="Abrir exceção">
    <DialogHeader title="Abrir exceção" description={`Deixa passar o próximo veredito barra desta guarda neste momento (só um), se acontecer nas próximas ${x.ttlH || 24} h. O motivo fica registrado.`} />
    <div className="grid gap-4">
      <label className="grid gap-1.5 t-body">
        <span className="font-medium">Guarda</span>
        <Select size="sm" label="Guarda" className="w-full min-w-0" value={gk} onChange={setGk} placeholder="Escolha a guarda…"
          items={x.cabecas.flatMap((c) => guards.filter((it) => it.cabeca === c.id).map((it) => ({ value: `${it.cabeca}/${it.id}`, label: `${it.titulo} (${it.id})`, group: c.nome })))} />
      </label>
      <label className="grid gap-1.5 t-body">
        <span className="font-medium">Momento</span>
        <Select size="sm" label="Momento" className="w-full min-w-0" value={momento} disabled={!g} onChange={setMomento} placeholder="Escolha a guarda primeiro"
          items={(g ? g.momentos : []).map((m) => ({ value: m, label: CB_MOMENTO[m] ? `${CB_MOMENTO[m]} (${m})` : m }))} />
      </label>
      <label className="grid gap-1.5 t-body">
        <span className="font-medium">
          {'Alvo '}
          <span className="font-normal text-muted-foreground">(opcional)</span>
        </span>
        <input className={cn(CTL, 't-data')} value={alvo} placeholder="pr=12" spellcheck="false" aria-invalid={!alvoOk} aria-describedby="cb-alvo-ajuda" onInput={(e) => setAlvo(e.target.value)} />
        <span id="cb-alvo-ajuda" className={cn('t-meta', alvoOk ? 'text-muted-foreground' : 'text-bad')}>
          {alvoOk ? 'Vazio: vale para o próximo, qualquer que seja. Ou chave=valor, separados por espaço (chaves comuns: pr, plugin).' : 'Use chave=valor, com a chave em minúscula (ex.: pr=12).'}
        </span>
      </label>
      <label className="grid gap-1.5 t-body">
        <span className="font-medium">Motivo</span>
        <textarea rows={3} value={motivo} maxlength={500} aria-describedby="cb-motivo-ajuda" onInput={(e) => setMotivo(e.target.value)} className={cn(CTL, 'h-auto py-2 max-md:h-auto')} />
        <span id="cb-motivo-ajuda" className="t-meta text-muted-foreground tnum">
          {falta > 0 ? `Obrigatório: faltam ${plural(falta, 'caractere', 'caracteres')}.` : `${motivo.length} de 500 caracteres.`}
        </span>
      </label>
      {g && momento && alvoOk ? <p className="t-body" role="status">{`Vai liberar: um veredito barra de ${g.cabeca}/${g.id} em ${momento}, ${pairs.length ? 'só para ' + pairs.join(' ') : 'para o próximo alvo, qualquer que seja'}, por até ${x.ttlH || 24} h.`}</p> : null}
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>Cancelar</Button>
      <Button icon={I.KeyRound} disabled={!ok} loading={busy} onClick={submit}>Abrir exceção</Button>
    </DialogFooter>
  </Dialog>;
}

function Exceptions({ x, remote, example, onOpen }) {
  const now = Date.now() / 1000;
  const st = (e) => e.usada ? ['idle', 'usada'] : e.expira < now ? ['idle', 'expirada'] : ['info', 'aberta'];
  const abertas = x.excecoes.filter((e) => st(e)[1] === 'aberta').length;
  return <Card className="min-w-0" data-tour-step-id="cerberus-excecoes">
    <CardHeader title="Exceções" summary={x.excecoes.length ? abertas ? plural(abertas, 'aberta', 'abertas') : 'nenhuma aberta' : 'nenhuma'}
      action={<span className="inline-flex items-center gap-2" data-tour-step-id="cerberus-abrir">
        {example ? <ExampleSeal /> : null}
        <Tip text={remote ? 'Só no painel local ou no terminal' : example ? 'Desligado durante o tour' : 'Libera um barra de uma guarda, uma vez'}>
          <Button size="sm" variant="outline" icon={I.KeyRound} disabled={remote || example} onClick={onOpen}>Abrir exceção</Button>
        </Tip>
      </span>} />
    {x.excecoes.length ? <CardContent>
      <ul className="-mt-2">
        {[...x.excecoes].reverse().map((e) => { const [k, l] = st(e); return <li key={e.id} className="grid min-w-0 gap-1 border-b py-3 last:border-b-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className={cn('inline-flex items-center gap-1.5 t-body', k === 'info' ? 'font-medium' : 'text-muted-foreground')}>
              <Dot kind={k} pulse={k === 'info'} />
              {l}
            </span>
            <Mono className="whitespace-nowrap t-label">{`${e.cabeca}/${e.guarda}`}</Mono>
            <span className="t-meta text-muted-foreground">{'em ' + e.momento}</span>
            <span className="t-meta text-muted-foreground tnum sm:ml-auto">{`${e.origem} · ${ago(e.aberta)}`}</span>
          </div>
          <p className="max-w-[70ch] t-body">{e.motivo}</p>
          {Object.keys(e.alvo || {}).length ? <span className="t-meta text-muted-foreground">
            {'alvo '}
            <Mono>{Object.entries(e.alvo).map(([k2, v]) => `${k2}=${v}`).join(' ')}</Mono>
          </span> : null}
        </li>; })}
      </ul>
    </CardContent> : null}
  </Card>;
}

// servidor antigo em memória serve campo a menos: o que falta vira vazio, a página nunca lança
const LISTAS = ['erros', 'cabecas', 'guardas', 'historico', 'barrados', 'excecoes', 'blocos'];
const normalize = (d) => ({ ...d, ...Object.fromEntries(LISTAS.map((k) => [k, Array.isArray(d?.[k]) ? d[k] : []])), total: d?.total ?? 0, store: d?.store ?? '' });

function Cerberus() {
  // tour da página rodando com exemplo: o estado vem da prévia, não do servidor
  const exemplo = useTourPreview('cerberus');
  const [xReal, setX] = useState(null);
  const x = exemplo ?? xReal;
  const [err, setErr] = useState(null);
  const [opening, setOpening] = useState(false);
  const reg = useBlocks();
  const load = useCallback(() => getJSON('/api/cerberus').then((d) => { const n = normalize(d); setX(n); setErr(null); loadBlocks(n.blocos); })
    .catch((e) => setErr(e || new Error('falha ao ler o Cerberus'))), []);
  useEffect(() => { load(); }, [load]);
  if (err && !x) return <ErroExplicado error={err} title="Não foi possível ler o Cerberus" onRetry={() => { setErr(null); load(); }} />;
  if (!x) return <Loading />;
  const remote = !!x.remote;
  const byHead = (cab, list) => list.filter((it) => it.cabeca === cab);
  const now = Date.now() / 1000;
  const barras = x.historico.filter((r) => r.efeito === 'barra').length;
  const abertas = x.excecoes.filter((e) => !e.usada && !(e.expira < now)).length;
  const ultimo = x.historico[x.historico.length - 1];
  return <div className="grid gap-8">
    <div className="grid gap-2" data-tour-step-id="cerberus-estado">
      {exemplo ? <span className="justify-self-start"><ExampleSeal /></span> : null}
      <LinhaDeEstado main={x.erros.length ? <span className="text-bad">{plural(x.erros.length, 'arquivo do registro com erro', 'arquivos do registro com erro')}</span>
        : barras ? `${plural(barras, 'veredito barrado', 'vereditos barrados')} nos ${x.historico.length} mais recentes` : `nada barrado nos ${x.historico.length} vereditos mais recentes`}
        rest={[`${plural(x.guardas.length, 'guarda', 'guardas')} em ${plural(x.cabecas.length, 'cabeça', 'cabeças')}`, abertas ? plural(abertas, 'exceção aberta', 'exceções abertas') : 'nenhuma exceção aberta',
          ultimo ? `último veredito ${ago(ultimo.ts)}` : null]} />
      {remote ? <p className="flex items-start gap-2 t-label text-muted-foreground">
        <I.Eye className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        Acesso remoto: só leitura. Exceção e modo só no painel local.
      </p> : null}
    </div>
    {x.erros.length ? <Card data-tour-step-id="cerberus-registro">
      <CardHeader title="Registro com erro" summary="as avaliações desta cabeça são recusadas até corrigir; veja o erro com hades cerberus estado" />
      <CardContent>
        <ul className="-mt-2">
          {x.erros.map((e) => <li key={e} className="flex items-baseline gap-2 border-b py-2.5 last:border-b-0">
            <Dot kind="bad" className="translate-y-px" />
            <Caminho className="min-w-0">{e}</Caminho>
          </li>)}
        </ul>
      </CardContent>
    </Card> : null}
    {x.cabecas.length ? <div className="grid gap-4 lg:grid-cols-3 lg:gap-y-0" data-tour-step-id="cerberus-cabecas">
      {x.cabecas.map((c) => <HeadCard key={c.id} c={c} guards={byHead(c.id, x.guardas)} hist={byHead(c.id, x.historico)} />)}
    </div> : <Empty icon={I.ShieldOff} title="Nenhuma cabeça registrada">Registro vazio.</Empty>}
    {(exemplo ? [] : x.cabecas.filter((c) => reg[c.id])).map((c) => { const Bloco = reg[c.id];
      return <BlockBoundary key={'bloco-' + c.id} cab={c.id} nome={c.nome}>
        <Bloco cabeca={{ id: c.id, nome: c.nome, modo: c.modo }} guardas={byHead(c.id, x.guardas)} historico={byHead(c.id, x.historico)} />
      </BlockBoundary>; })}
    <div className="grid items-start gap-8 xl:grid-cols-2">
      <Barred x={x} example={!!exemplo} />
      <Exceptions x={x} remote={remote} example={!!exemplo} onOpen={() => setOpening(true)} />
    </div>
    <History x={x} example={!!exemplo} />
    <OpenException x={x} open={opening && !remote && !exemplo} onClose={() => setOpening(false)} onDone={(d) => { setX(normalize(d)); setOpening(false); }} />
    <p className="border-t pt-4 t-meta text-muted-foreground" data-tour-step-id="cerberus-terminal">
      {'Histórico em '}
      <Caminho>{x.store}</Caminho>
      {'. No terminal: '}
      <Mono className="whitespace-nowrap">hades cerberus estado</Mono>
      {', '}
      <Mono className="whitespace-nowrap">guardas</Mono>
      {', '}
      <Mono className="whitespace-nowrap">historico</Mono>
      {', '}
      <Mono className="whitespace-nowrap">excecao listar</Mono>
      .
    </p>
  </div>;
}

HadesCore.registerPage('cerberus', Cerberus);
})();
