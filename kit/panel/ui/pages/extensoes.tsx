/* Página Extensões (#/extensoes): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela.
 * Extensão é ferramenta externa da máquina (herdr, Mark), não plugin. A página lê GET /api/extensions (o mesmo JSON do
 * `hades ext list --json`) e liga/desliga por POST. O comando de instalação é só texto copiável: a Hades não o executa. */
(() => {
const { useState, useEffect, useCallback, I, cn, post, getJSON, Dot, Switch, Mono, Empty, CardHeader, CopyButton, LinhaDeEstado, Loading, useApp } = HadesCore;

// código estável do problema → palavra curta; o código em si aparece ao lado, para quem ramifica por ele
const EXT_CAP = { 'canvas.terminal': 'terminal no canvas', voice: 'voz', window: 'janela do desktop' };
const extKind = (e) => (!e.installed ? 'idle' : e.problems.length ? 'warn' : e.enabled ? 'ok' : 'idle');
const extWord = (e) => (!e.installed ? 'não instalada' : e.problems.length ? 'com problema' : 'instalada');

function ExtKeys({ keys, values }) {
  if (!keys.length) return <p className="t-meta text-muted-foreground">Sem chaves próprias.</p>;
  return <div className="grid gap-1">
    <p className="t-meta text-muted-foreground">Chaves próprias (edite em Configurações):</p>
    <ul className="grid gap-1">
      {keys.map((k) => <li key={k} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 t-body">
        <a href={'#/config?q=' + encodeURIComponent(k)} className="break-all underline underline-offset-3 outline-none hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <Mono>{k}</Mono>
        </a>
        <span className="text-muted-foreground" aria-hidden="true">=</span>
        <Mono className="min-w-0 break-all">{values[k] === undefined ? '(sem valor)' : values[k] === '' ? '(vazio)' : values[k]}</Mono>
      </li>)}
    </ul>
  </div>;
}

function ExtRow({ e, first, remote, values, busy, onToggle }) {
  const kind = extKind(e);
  return <li data-tour-step-id={first ? 'extensoes-extensao' : undefined} className="grid gap-2.5 border-b py-4">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">{e.name}</span>
        <span className="t-body text-muted-foreground">{e.description}</span>
      </span>
      <span data-tour-step-id={first ? 'extensoes-ligar' : undefined} className="ml-auto flex items-center gap-3">
        <span className={cn('inline-flex items-center gap-1.5 t-body', e.enabled ? 'font-medium' : 'text-muted-foreground')}>
          <Dot kind={e.enabled ? 'ok' : 'idle'} />
          {e.enabled ? 'ligada' : 'desligada'}
        </span>
        {remote ? null : <Switch checked={e.enabled} disabled={busy} label={(e.enabled ? 'Desligar ' : 'Ligar ') + e.name} onChange={(v) => onToggle(e, v)} />}
      </span>
    </div>
    <p data-tour-step-id={first ? 'extensoes-estado' : undefined} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 t-meta text-muted-foreground">
      <span className="inline-flex items-center gap-1.5"><Dot kind={kind} />{extWord(e)}</span>
      <span aria-hidden="true">·</span>
      <span>versão {e.version ?? 'desconhecida'}{e.minVersion ? ` (mínima ${e.minVersion})` : ' (sem versão mínima)'}</span>
      {e.path ? <><span aria-hidden="true">·</span><Mono className="min-w-0 break-all text-foreground/80">{e.path}</Mono></> : null}
    </p>
    <p className="t-body" aria-label="Capacidades">
      <span className="text-muted-foreground">Capacidades: </span>
      {e.capabilities.map((c) => EXT_CAP[c] || c).join(' · ') || 'nenhuma'}
    </p>
    {e.problems.length ? <ul data-tour-step-id={first ? 'extensoes-problemas' : undefined} className="grid gap-1" aria-label="Problemas">
      {e.problems.map((p) => <li key={p.code + p.field} role="status" className="flex min-w-0 items-start gap-2 t-body">
        <I.TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
        <span className="min-w-0">
          {p.message}
          {' '}
          <Mono className="text-muted-foreground">{p.code}</Mono>
        </span>
      </li>)}
    </ul> : null}
    <div data-tour-step-id={first ? 'extensoes-instalar' : undefined} className="grid gap-1 border bg-muted/30 p-2.5">
      <div className="flex items-center gap-2">
        <span className="t-meta-em">Instalar (passo seu)</span>
        <CopyButton text={e.install} label={`Copiar a instrução de instalação de ${e.name}`} />
      </div>
      <p className="t-body text-pretty select-all">{e.install}</p>
      <p className="t-meta text-muted-foreground">A Hades não executa a instalação: copie e rode você mesmo.</p>
    </div>
    <div data-tour-step-id={first ? 'extensoes-chaves' : undefined}>
      <ExtKeys keys={e.configKeys} values={values} />
    </div>
  </li>;
}

function Extensoes({ d }) {
  const { toast, confirm } = useApp();
  const [x, setX] = useState(null);
  const [values, setValues] = useState({});
  const [remote, setRemote] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [list, cfg, rem] = await Promise.all([getJSON('/api/extensions'), getJSON('/api/config'), getJSON('/api/remote')]);
      setX(list); setRemote(!!rem.remote); setErr('');
      setValues(Object.fromEntries((cfg.items || []).map((i) => [i.key, i.value])));
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const toggle = async (e, on) => {
    if (!on && !(await confirm({ title: `Desligar ${e.name}?`, description: 'A Hades passa a tratá-la como ausente onde consulta as extensões. O binário não é tocado.', icon: I.PowerOff, danger: true, confirmLabel: 'Desligar' }))) return;
    setBusy(true);
    try { await post('/api/extensions', { op: on ? 'enable' : 'disable', name: e.name }); await load(); }
    catch (er) { toast({ kind: 'bad', title: 'Não deu para ' + (on ? 'ligar' : 'desligar'), desc: er.message }); }
    setBusy(false);
  };
  if (err && !x) return <Empty icon={I.CircleX} title="Não deu para listar as extensões.">{err}</Empty>;
  if (!x) return <Loading />;
  const on = x.extensions.filter((e) => e.enabled).length;
  const bad = x.extensions.filter((e) => e.enabled && e.installed && e.problems.length).length;
  return <div className="grid gap-6">
    <div className="grid gap-1.5">
      <LinhaDeEstado main={`${on} de ${x.extensions.length} ligadas`} rest={[bad ? `${bad} com problema` : null, 'ferramentas externas, não plugins']} />
      {remote ? <p role="note" className="flex items-start gap-2 t-body">
        <I.Eye className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
        <span><span className="font-medium">Só leitura pelo acesso remoto.</span><span className="text-muted-foreground"> Ligar e desligar só pelo painel local.</span></span>
      </p> : null}
      {err ? <p className="t-body text-bad" role="status">Sem atualizar: {err}. Mostrando a última lista.</p> : null}
    </div>
    <section className="grid gap-0" aria-label="Extensões">
      <CardHeader title="Extensões" summary={`${x.extensions.length}`} />
      {x.extensions.length ? <ul>
        {x.extensions.map((e, i) => <ExtRow key={e.name} e={e} first={i === 0} remote={remote} values={values} busy={busy} onToggle={toggle} />)}
      </ul> : <Empty icon={I.Plug} title="Nenhuma extensão declarada.">A pasta extensions/ da skill não tem manifesto válido.</Empty>}
    </section>
    <p data-tour-step-id="extensoes-comando" className="max-w-[75ch] t-meta text-muted-foreground">
      {'Linha de comando: '}
      <Mono className="break-words">{'hades ext list | info <nome> | enable <nome> | disable <nome> | doctor'}</Mono>
      .
    </p>
  </div>;
}

HadesCore.registerPage('extensoes', Extensoes);
})();
