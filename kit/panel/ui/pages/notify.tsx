/* Página Notificações (#/notify): usa a base (ui/app.js) pelo HadesCore e se registra pelo registerPage dela. */
(() => {
const { useState, useEffect, useRef, useCallback, I, cn, getJSON, Button, Dot, Card, CardHeader, CardContent, Mono, Empty,
  LinhaDeEstado, Loading } = HadesCore;

// ================================================================== notificações (notify.sh)
const NOTIFY_SEV = { info: 'info', warn: 'warn', error: 'bad' };
const CANAL = { desktop: 'desktop', ntfy: 'celular' };
const LINK = 'inline-flex items-center gap-1.5 t-label whitespace-nowrap underline-offset-3 hover:underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11';
const quando = (ts) => { const d = new Date(ts * 1000);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
const falhou = (v) => !/^(ok|enviad|silêncio|silencio|-)/i.test(String(v));

// canal ou peça do vigia: nome, estado em palavras com o ponto e o detalhe apagado
function Linha({ nome, kind, estado, children, ...rest }) {
  return <li {...rest} className="grid gap-x-4 gap-y-0.5 border-b py-2.5 t-body sm:grid-cols-[7rem_minmax(0,1fr)]">
    <span className="font-medium">
      {nome}
    </span>
    <div className="grid min-w-0 gap-0.5">
      <span className={cn('inline-flex items-center gap-1.5', kind === 'bad' ? 'text-bad' : kind === 'warn' ? 'text-warn' : kind === 'idle' ? 'text-muted-foreground' : '')}>
        <Dot kind={kind} />
        {estado}
      </span>
      <span className="min-w-0 t-body text-muted-foreground break-words">
        {children}
      </span>
    </div>
  </li>;
}

function Notify() {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(false);
  // o que já estava na lista ao abrir não anima; só o que chega depois entra (sem empurrar quem está lendo)
  const visto = useRef(null);
  const load = useCallback(() => getJSON('/api/notify').then((r) => { setSt(r); setErr(false); }).catch(() => setErr(true)), []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  const chave = (h) => `${h.ts}|${h.event}|${h.obj}`;
  useEffect(() => { if (st) visto.current = new Set([...(visto.current || []), ...st.history.map(chave)]); }, [st]);
  if (!st) return err ? <Empty icon={I.CircleX} title="Não consegui ler o vigia.">
    <span className="inline-flex flex-wrap items-center gap-3">
      Sem resposta de /api/notify.
      <Button size="xs" variant="outline" icon={I.RefreshCw} onClick={load}>Tentar de novo</Button>
    </span>
  </Empty> : <Loading />;
  const on = st.enabled && st.unitState === 'active';
  const fontes = Object.entries(st.sources || {}).filter(([, v]) => v.err);
  const unit = st.unit || 'hds-notify';
  const falhas = st.history.filter((h) => Object.values(h.channels || {}).some(falhou)).length;
  return <div className="grid gap-8">
    <div data-tour-step-id="notify-estado">
    <LinhaDeEstado main={!st.enabled ? 'vigia desligado' : on ? 'vigia ativo' : `vigia ${st.unitState || 'parado'}`}
      rest={[on && st.beatAge != null ? `último ciclo há ${st.beatAge} s` : null,
        st.quiet ? (st.quietNow ? <span key="q" className="text-foreground">{`em silêncio agora, até o fim de ${st.quiet}`}</span> : `silêncio ${st.quiet}`) : null,
        `${st.history.length} recente${st.history.length === 1 ? '' : 's'}`,
        falhas ? <span key="f" className="text-bad">{`${falhas} com canal falhando`}</span> : null,
        fontes.length ? <span key="e" className="text-bad">{`${fontes.length} checagem${fontes.length > 1 ? 'ns' : ''} com erro`}</span> : null]} />
    </div>
    <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <Card className="gap-0" data-tour-step-id="notify-canais">
        <CardHeader title="Canais" summary={`vigia ${unit}`}
          action={<a href="#/config?q=notifica" data-tour-step-id="notify-configurar" className={LINK}>
            Configurar
            <I.ArrowRight className="size-3.5" aria-hidden="true" />
          </a>} />
        <CardContent>
          <ul>
            <Linha nome="Vigia" data-tour-step-id="notify-vigia" kind={on ? 'ok' : st.enabled ? 'bad' : 'idle'} estado={!st.enabled ? 'desligado' : on ? 'ativo' : st.unitState || 'parado'}>
              {on ? 'Avisa mesmo com o painel fechado.' : st.enabled ? <>
                {"O vigia "}
                <Mono>
                  {unit}
                </Mono>
                {" não está rodando. Rode "}
                <Mono>notify.sh apply</Mono>
                {" para religar."}
              </> : 'Ligue em Configurações.'}
            </Linha>
            <Linha nome="Desktop" data-tour-step-id="notify-desktop" kind={st.desktop ? 'ok' : 'idle'} estado={st.desktop ? 'ligado' : 'desligado'}>
              Aviso do sistema nesta máquina.
            </Linha>
            <Linha nome="Celular" data-tour-step-id="notify-celular" kind={st.ntfy ? (st.hasTopic ? 'ok' : 'warn') : 'idle'} estado={st.ntfy ? (st.hasTopic ? 'ligado' : 'sem tópico') : 'desligado'}>
              {st.ntfy && st.hasTopic ? <>
                {"ntfy em "}
                <Mono>
                  {(st.server || '').replace(/^https?:\/\//, '')}
                </Mono>
                {st.topic ? <>
                  {", tópico "}
                  <Mono>
                    {st.topic}
                  </Mono>
                </> : null}
              </> : st.ntfy ? 'Falta o tópico para chegar ao celular.' : 'Pelo app ntfy.'}
            </Linha>
            <Linha nome="Silêncio" data-tour-step-id="notify-silencio" kind={st.quiet ? (st.quietNow ? 'info' : 'ok') : 'idle'} estado={st.quiet ? (st.quietNow ? 'agora' : 'programado') : 'sem horário'}>
              {st.quiet ? <span className="tnum">
                {st.quiet}
              </span> : 'Avisa a qualquer hora.'}
            </Linha>
            {fontes.map(([k, v]) => <Linha key={k} data-tour-step-id="notify-checagem" nome={'Checagem de ' + k} kind="bad" estado="com erro">
              <Mono className="break-words">
                {v.err}
              </Mono>
            </Linha>)}
          </ul>
        </CardContent>
      </Card>
      <Card className="gap-0" data-tour-step-id="notify-historico">
        <CardHeader title="Últimas notificações" summary="as 50 mais recentes, por canal" />
        <CardContent>
          {st.history.length ? <ol aria-live="polite">
            {st.history.map((h) => { const novo = visto.current && !visto.current.has(chave(h)); const canais = Object.entries(h.channels || {});
              return <li key={chave(h)} className={cn('grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 border-b py-2.5', novo && 'motion-safe:animate-fade-in')}>
                <Dot kind={NOTIFY_SEV[h.sev] || 'idle'} className="mt-1.5" />
                <div className="min-w-0">
                  <p className="t-body">
                    <span className="font-medium">
                      {h.event}
                    </span>
                    {h.obj ? <span className="ml-2 font-mono t-label text-muted-foreground">
                      {h.obj}
                    </span> : null}
                  </p>
                  {h.text ? <p className="mt-0.5 t-body text-muted-foreground break-words">
                    {h.text}
                  </p> : null}
                  {canais.length ? <p className="mt-1 flex flex-wrap gap-x-3 t-meta text-muted-foreground">
                    {canais.map(([k, v]) => <span key={k} className={cn(falhou(v) && 'text-bad')}>
                      {`${CANAL[k] || k}: ${v}`}
                    </span>)}
                  </p> : null}
                </div>
                <time dateTime={new Date(h.ts * 1000).toISOString()} title={new Date(h.ts * 1000).toLocaleString('pt-BR')} className="pt-0.5 t-data text-muted-foreground">
                  {quando(h.ts)}
                </time>
              </li>; })}
          </ol> : <Empty icon={I.Bell} title="Nada enviado ainda.">
            {"Em Configurações → Notificações, use "}
            <a href="#/config?q=notifica" className="underline underline-offset-3 hover:no-underline">Testar notificação</a>
            {": o aviso de teste aparece aqui."}
          </Empty>}
        </CardContent>
      </Card>
    </div>
  </div>;
}

HadesCore.registerPage('notify', Notify);
})();
