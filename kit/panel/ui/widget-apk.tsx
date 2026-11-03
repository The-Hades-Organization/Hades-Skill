/* App do widget (baixar o APK no celular, gerar no painel): Acesso remoto usa, e plugins também podem.
 * Carrega depois da base (ui/app.js) e antes das páginas, que o pegam em HadesCore.WidgetApk. */
(() => {
const { useState, useEffect, I, cn, getJSON, Button, CardHeader, CopyButton, Mono, Dot, Fio, Skeleton, useActions, dt } = HadesCore;

const Estado = ({ kind, children }) => <span className="inline-flex items-center gap-1.5">
  <Dot kind={kind} pulse={kind === 'busy'} />
  {children}
</span>;
// link de download com o desenho do Button primário (o Button da base é <button>, e baixar arquivo pede <a download>)
const LINK_PRIMARY = 'inline-flex h-8 items-center justify-center gap-2 bg-primary px-3.5 t-label text-primary-foreground transition-colors hover:bg-primary/90 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:h-11 [&_svg]:size-4';

// plugins antigos passam delay: fica ignorado, a entrada escalonada saiu do sistema
function WidgetApk({ d, className }) {
  const run = useActions();
  const [apk, setApk] = useState(null);
  const building = (d?.jobs || []).some((j) => j.action === 'widget-apk' && j.state === 'rodando');
  useEffect(() => { getJSON('/api/widget/apk').then(setApk).catch(() => setApk({ exists: false, error: true })); }, [building]);   // relê ao começar e ao terminar o build
  const built = apk?.builtAt ? Date.parse(apk.builtAt) : NaN;
  const state = building ? ['busy', 'gerando…'] : !apk ? null : !apk.exists ? ['idle', 'não gerado'] : apk.outdated ? ['warn', 'desatualizado'] : ['ok', 'atualizado'];
  const rows = apk?.exists ? [
    ['Versão', apk.versionName ? <span className="tnum">{apk.versionName} <span className="text-muted-foreground">(código {apk.versionCode})</span></span> : 'desconhecida'],
    ['Gerado em', Number.isNaN(built) ? '—' : <span className="tnum">{dt(built / 1000)}</span>],
    ['Tamanho', <span className="tnum">{(apk.size / 1048576).toFixed(1).replace('.', ',')} MB</span>],
    ['SHA-256', <span className="flex items-center gap-1"><Mono>{apk.sha256.slice(0, 12)}…</Mono><CopyButton text={apk.sha256} label="Copiar SHA-256 do APK" /></span>],
    apk.certSha256 ? ['Certificado', <span className="flex items-center gap-1"><Mono>{apk.certSha256.slice(0, 12)}…</Mono><CopyButton text={apk.certSha256} label="Copiar SHA-256 do certificado" /></span>] : null,
  ].filter(Boolean) : [];
  return <section className={cn('grid content-start gap-3', className)} aria-label="App do widget">
    <CardHeader as="h3" title="App do widget" summary={state ? <Estado kind={state[0]}>
      {state[1]}
    </Estado> : null} />
    {building ? <Fio s="fiando" label="Gerando o APK do widget" /> : null}
    <p className="t-body text-muted-foreground">
      Widget Android: baixe e instale direto no celular.
    </p>
    {!apk ? <Skeleton className="h-16" /> : apk.exists ? <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 t-body">
      {rows.map(([k, v]) => <div key={k} className="contents">
        <dt className="text-muted-foreground">{k}</dt>
        <dd className="min-w-0">{v}</dd>
      </div>)}
    </dl> : <p className="t-body">
      {apk.error ? 'Não deu para ler o estado do APK.' : 'Ainda não há APK neste ambiente.'}
      <span className="text-muted-foreground"> Gerar precisa de Docker e leva alguns minutos.</span>
    </p>}
    {apk?.exists && apk.outdated ? <p role="status" className="flex items-start gap-2 t-body">
      <I.TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
      <span>
        {"Os fontes mudaram depois deste build"}
        {apk.kitVersion ? ` (kit ${apk.kitVersion})` : ''}
        : gere de novo antes de instalar.
      </span>
    </p> : null}
    <div className="flex flex-wrap gap-2">
      {apk?.exists ? <a href="/api/widget/apk/download" download className={LINK_PRIMARY}>
        <I.Download aria-hidden="true" />
        Baixar APK
      </a> : null}
      <Button variant="outline" icon={I.Hammer} loading={building} onClick={() => run({ action: 'widget-apk' })}>
        {building ? 'Gerando…' : apk?.exists ? 'Gerar de novo' : 'Gerar APK'}
      </Button>
    </div>
    <p className="t-meta text-muted-foreground">
      {"Instalar: permita "}
      <span className="font-medium text-foreground">instalar apps desconhecidos</span>
      {" para o navegador (ou o painel instalado) e abra o arquivo. Instala por cima do anterior, mantendo a configuração do widget."}
    </p>
  </section>;
}

HadesCore.WidgetApk = WidgetApk;
})();
