/* Legenda do canvas do Argos: o que cada forma, cor, ícone e indicador do nó quer dizer. Só desenha; as tabelas vêm de
 * window.CanvasModel.argos (legendModel, src/lib/canvas-argos.ts), as mesmas que desenham o nó. Carregado depois de
 * ui/argos/parts.js, que a monta dentro do canvas (CanvasPane) quando ela existe. */
(() => {
const { useState, useRef, useEffect, I, cn, Button } = HadesCore;
const { Forma, Icon, TONE_ICON, TONE_TEXT } = window.ArgosParts;
const A = window.CanvasModel.argos;

const PANEL_ID = 'argos-legend';

function Section({ title, children }) {
  return <section className="grid gap-1">
    <h3 className="t-micro uppercase tracking-[0.04em] text-muted-foreground">{title}</h3>
    <ul className="grid gap-1 t-label">{children}</ul>
  </section>;
}

function CanvasLegend() {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const panel = useRef(null);
  const model = A.legendModel();
  useEffect(() => { if (open) panel.current?.focus(); }, [open]);
  // o Button não repassa ref (React 18): o foco volta ao botão pelo contêiner
  const close = () => { setOpen(false); root.current?.querySelector('button')?.focus(); };
  return <div ref={root} className="absolute bottom-2 left-2 z-10 grid max-w-[calc(100%-4.5rem)] gap-1 max-md:bottom-16">
    {open ? <div ref={panel} id={PANEL_ID} role="region" aria-label="Legenda do canvas" tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}
      className="grid max-h-[min(24rem,60dvh)] w-72 max-w-full gap-3 overflow-y-auto elev-float bg-popover p-3 text-popover-foreground outline-none scrollbar-thin animate-fade-in">
      <Section title="Forma: tipo do nó">
        {model.types.map((t) => <li key={t.type} className="flex items-center gap-2">
          <Forma shape={t.shape} size={14} className="text-foreground" />
          <Icon name={t.icon} className="size-3.5 shrink-0 text-muted-foreground" />
          <span>{t.label}</span>
        </li>)}
      </Section>
      <Section title="Cor e ícone: estado">
        {model.states.map((s) => <li key={s.id} className="flex items-center gap-2">
          <Icon name={s.look.icon} className={cn('size-3.5 shrink-0', TONE_ICON[s.look.tone])} />
          <span className={TONE_TEXT[s.look.tone]}>{s.look.word}</span>
        </li>)}
      </Section>
      <Section title="Indicadores (aparecem ao ampliar)">
        {model.indicators.map((i) => <li key={`${i.kind}|${i.label}`} className="flex items-start gap-2">
          <Icon name={i.icon} className={cn('mt-0.5 size-3.5 shrink-0', TONE_ICON[i.tone])} />
          <span>{i.label}</span>
        </li>)}
      </Section>
      <p className="t-meta text-muted-foreground">Longe, só a cor aparece. Amplie para ver forma, ícone e indicadores.</p>
    </div> : null}
    <Button size="sm" variant="outline" icon={I.Shapes} aria-expanded={open} aria-controls={open ? PANEL_ID : undefined}
      className="bg-background max-md:min-h-11" onClick={() => (open ? close() : setOpen(true))}>Legenda</Button>
  </div>;
}

window.ArgosLegend = { CanvasLegend };
})();
