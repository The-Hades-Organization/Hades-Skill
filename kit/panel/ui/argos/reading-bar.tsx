/* HUD de leitura do grafo na página Argos (#/argos): as ilhas sobre o canvas (estado do Argos; busca, Filtros, Vista, Lista),
 * o popover de filtros com contagem, os chips dos filtros ligados, a troca de layout (livre ou automático), a busca e as vistas salvas. Só desenha e coleta: a regra é de argos/logic.tsx e dos modelos de src/lib (canvas-filters,
 * canvas-search, canvas-urlstate); o executor das forças é argos/reading-runner.tsx. Carregado antes de pages/argos.js. */
(() => {
const { useState, useEffect, useRef, I, cn, Button, Input, Segmented, Select } = HadesCore;
const L = window.ArgosLogic;
const M = window.CanvasModel;

const SEARCH_INPUT_ID = 'argos-reading-search';
const CHIP = 'inline-flex h-8 items-center gap-1.5 border px-2 t-control whitespace-nowrap cursor-pointer transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:h-11';
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const secs = (ms) => `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;

// Esc dentro de um popover (`data-own-keys`) é dele: fecha e devolve o foco ao botão; a página não trata a tecla.
// Clique fora fecha. O ouvinte vive enquanto o popover está aberto.
function Popover({ label, icon, badge, open, onOpenChange, children, wide = false, shortcut, align = 'right' }) {
  const button = useRef(null);
  const panel = useRef(null);
  const wasOpen = useRef(open);
  const id = `argos-pop-${label.toLowerCase().replace(/\W+/g, '-')}`;
  useEffect(() => {
    if (open) panel.current?.focus();
    else if (wasOpen.current) button.current?.focus();
    wasOpen.current = open;
    if (!open) return undefined;
    const outside = (e) => { if (!panel.current?.contains(e.target) && !button.current?.contains(e.target)) onOpenChange(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const Icon = icon;
  return <div className="relative">
    <button ref={button} type="button" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} aria-keyshortcuts={shortcut}
      title={shortcut ? `${label} (${shortcut})` : label} onClick={() => onOpenChange(!open)}
      className={cn(ISLAND_BUTTON, open && 'bg-accent text-foreground')}>
      <Icon className="size-4" aria-hidden="true" /><span className="max-lg:sr-only">{label}</span>
      {badge ? <span className="font-mono t-micro tabular-nums" aria-label={`${badge} ligados`}>{badge}</span> : null}
    </button>
    {open ? <div ref={panel} id={id} role="dialog" aria-label={label} tabIndex={-1} data-own-keys=""
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onOpenChange(false); } }}
      onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}
      className={cn('absolute top-full z-30 mt-1 grid max-h-[calc(100dvh-8rem)] content-start gap-3 overflow-y-auto border border-border-strong bg-popover p-3 text-popover-foreground outline-none scrollbar-thin animate-fade-in max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:mt-0 max-md:max-h-[75dvh] max-md:border-x-0 max-md:border-b-0',
        align === 'right' ? 'right-0' : 'left-0', wide ? 'w-[26rem]' : 'w-80', 'max-md:w-auto')}>
      {children}
    </div> : null}
  </div>;
}
const ISLAND_BUTTON = 'inline-flex h-8 cursor-pointer items-center gap-1.5 px-2 t-control text-muted-foreground transition-colors outline-none hover:bg-accent/60 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11 max-md:justify-center';

// Uma ilha: grupo de controles com contorno fino sobre o canvas. `region` marca o alvo do F6.
function Island({ label, region, className, children }) {
  return <div role="group" aria-label={label} data-region={region} data-tour-step-id={region === 'status' ? 'argos-estado' : region === 'reading' ? 'argos-leitura' : undefined}
    className={cn('pointer-events-auto flex items-center gap-0.5 border border-border-strong bg-background/95 p-0.5 backdrop-blur-sm', className)}>{children}</div>;
}

// Chip com contagem zero só fica se estiver marcado (o dono precisa poder desmarcar); dimensão sem chip some.
function FilterGroup({ label, children }) {
  return <div role="group" aria-label={label} className="grid gap-1.5">
    <span className="t-micro text-muted-foreground">{label}</span>
    <div className="flex flex-wrap items-center gap-1.5">{children}</div>
  </div>;
}
function FilterChip({ active, count, onClick, children }) {
  return <button type="button" aria-pressed={active} onClick={onClick}
    className={cn(CHIP, active ? 'border-foreground bg-foreground text-background' : 'border-border-strong hover:bg-accent')}>
    {children}{count === undefined ? null : <span className="font-mono t-micro tabular-nums opacity-70">{count}</span>}
  </button>;
}

// Conteúdo do popover Filtros: estado, atividade, arquivados, as outras dimensões e, no fim, os ocultos do canvas (`hidden`).
function FiltersPanel({ summary, states, onState, activity, activityItems, onActivity, archived, onArchived, dims, onToggle, onClear, filtering, hidden }) {
  const rows = dims.map((d) => ({ ...d, chips: d.chips.filter((c) => c.count > 0 || c.active) })).filter((d) => d.chips.length > 0);
  return <>
    <div className="flex items-center justify-between gap-2">
      <span role="status" className="t-meta-em tabular-nums text-muted-foreground">{summary}</span>
      {filtering ? <Button variant="ghost" size="sm" icon={I.FilterX} onClick={onClear}>Limpar os filtros</Button> : null}
    </div>
    <FilterGroup label="Estado">
      {states.map((it) => <FilterChip key={it.value} active={it.active} count={it.count} onClick={() => onState(it.value)}>{it.label}</FilterChip>)}
    </FilterGroup>
    <FilterGroup label="Atividade">
      {activityItems.map((it) => <FilterChip key={it.value} active={it.value === activity} onClick={() => onActivity(it.value)}>{it.label}</FilterChip>)}
    </FilterGroup>
    <FilterGroup label="Arquivados">
      <FilterChip active={archived} onClick={() => onArchived(!archived)}>Mostrar arquivados</FilterChip>
    </FilterGroup>
    {rows.map((d) => <FilterGroup key={d.dim} label={d.label}>
      {d.chips.map((c) => <FilterChip key={c.value} active={c.active} count={c.count} onClick={() => onToggle(d.dim, c.value)}>{c.label}</FilterChip>)}
    </FilterGroup>)}
    {hidden ? <div role="group" aria-label="Ocultos do canvas" className="grid gap-1.5 border-t pt-2">
      <span className="t-micro text-muted-foreground">Ocultos do canvas</span>
      {hidden}
    </div> : null}
  </>;
}

// Os filtros ligados ficam à vista, cada um com o seu x; só existe a faixa quando há algum.
function ActiveChips({ items, onClear }) {
  if (!items.length) return null;
  return <ul role="list" aria-label="Filtros ligados" data-region="chips" className="pointer-events-auto flex flex-wrap items-center gap-1">
    {items.map((it) => <li key={it.key}>
      <button type="button" onClick={it.onRemove} aria-label={`Tirar o filtro ${it.label}`}
        className={cn(CHIP, 'border-foreground bg-background text-foreground hover:bg-accent')}>{it.label}<I.X className="size-3" aria-hidden="true" /></button>
    </li>)}
    <li><Button variant="ghost" size="sm" onClick={onClear} className="bg-background/90 max-md:min-h-11">Limpar</Button></li>
  </ul>;
}

// Esc limpa e Enter reenquadra os achados; a página não trata essas duas teclas quando o foco está aqui (data-own-keys).
// A única porta de comandos é o Ctrl K (a paleta): o campo busca no canvas e a dica fica no title. No estreito vira um ícone.
function SearchBox({ value, onChange, onSubmit, hits, problem, onPalette }) {
  const status = problem ? L.errorText(problem, problem) : !value.trim() ? '' : hits ? plural(hits, 'achado', 'achados') : 'Nenhum resultado';
  return <div className="flex min-w-0 items-center gap-1" data-own-keys="">
    <Button variant="ghost" size="icon-sm" icon={I.Search} aria-label="Buscar ou rodar um comando" aria-keyshortcuts="Control+K" title="Buscar ou rodar um comando (Ctrl K)"
      className="md:hidden max-md:size-11" onClick={onPalette} />
    <div className="max-md:hidden">
      <Input id={SEARCH_INPUT_ID} type="search" icon={I.Search} value={value} aria-label="Buscar no canvas" placeholder="Buscar no canvas" title="Buscar no canvas. Ctrl K abre os comandos."
        maxLength={M.search.SEARCH_LIMITS.termChars} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} className="t-control w-44 flex-none xl:w-56"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) { e.preventDefault(); onChange(''); }
          else if (e.key === 'Enter') { e.preventDefault(); onSubmit(); }
        }} />
    </div>
    <span role="status" aria-live="polite" className={cn('shrink-0 t-micro max-md:sr-only', problem ? 'text-warn' : 'text-muted-foreground')}>{status}</span>
  </div>;
}
const focusSearch = () => { const el = document.getElementById(SEARCH_INPUT_ID); if (el) { el.focus(); el.select(); } };

// Salvar e renomear abrem um campo no lugar; o erro (código view_*) vem da regra e aparece em palavras ao lado. `ask` muda
// quando o comando "Salvar a vista atual" pede o campo de nome.
function ViewsBar({ views, ask, onApply, onSave, onRename, onRemove }) {
  const [current, setCurrent] = useState('');
  const [mode, setMode] = useState(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => { if (current && !views.some((v) => v.name === current)) setCurrent(''); }, [views, current]);
  const open = (m) => { setMode(m); setDraft(m === 'rename' ? current : ''); setError(null); };
  useEffect(() => { if (ask) open('save'); }, [ask]);
  const close = () => { setMode(null); setError(null); };
  const confirm = () => {
    const code = mode === 'rename' ? onRename(current, draft) : onSave(draft);
    if (code) { setError(code); return; }
    if (mode === 'rename' || mode === 'save') setCurrent(draft.trim());
    close();
  };
  if (mode) {
    return <form data-own-keys="" className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); confirm(); }}>
      <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={mode === 'rename' ? 'Novo nome da vista' : 'Nome da vista'}
        placeholder="Nome da vista" className="w-48 flex-none" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }} />
      <Button type="submit" size="sm">{mode === 'rename' ? 'Renomear' : 'Salvar'}</Button>
      <Button variant="ghost" size="sm" onClick={close}>Cancelar</Button>
      {error ? <span role="alert" className="t-micro text-bad">{L.errorText(error, error)}</span> : null}
    </form>;
  }
  return <div className="flex flex-wrap items-center gap-1">
    {views.length ? <Select size="sm" label="Vistas salvas" value={current} placeholder="Vistas salvas…" className="min-w-0 max-w-48"
      onChange={(v) => { setCurrent(v); if (v) onApply(v); }}
      items={views.map((v) => ({ value: v.name, label: v.name }))} /> : null}
    <Button variant="outline" size="sm" icon={I.Bookmark} title="Guarda a posição da câmera com um nome (os filtros têm o próprio salvar, na paleta)" onClick={() => open('save')}>Salvar vista</Button>
    {current ? <>
      <Button variant="ghost" size="icon-sm" icon={I.Pencil} aria-label={`Renomear a vista ${current}`} title="Renomear" onClick={() => open('rename')} />
      <Button variant="ghost" size="icon-sm" icon={I.Trash2} aria-label={`Excluir a vista ${current}`} title="Excluir"
        onClick={() => { const code = onRemove(current); if (code) setError(code); else setCurrent(''); }} />
    </> : null}
    {error ? <span role="alert" className="t-micro text-bad">{L.errorText(error, error)}</span> : null}
  </div>;
}

// Rodando: o botão Parar fica no lugar do resumo; parado, o resumo da última rodada (tempo e passos).
function LayoutSwitch({ layout, onLayout, running, onStop, last }) {
  return <div className="flex flex-wrap items-center gap-2">
    <Segmented label="Layout" value={layout} onChange={onLayout}
      items={[{ value: 'free', label: 'Livre', icon: I.Move }, { value: 'force', label: 'Automático', icon: I.Orbit }]} />
    {running ? <>
      <span role="status" className="t-micro text-muted-foreground">Organizando…</span>
      <Button variant="ghost" size="sm" icon={I.Square} onClick={onStop}>Parar o layout</Button>
    </> : layout === 'force' && last ? <span role="status" className="t-micro text-muted-foreground">
      {last.settled ? `assentou em ${secs(last.ms)}` : `parou em ${secs(last.ms)}`}, {plural(last.steps, 'passo', 'passos')}
    </span> : null}
  </div>;
}

/** De que zoom para cima o nó aparece completo (terminal, nota e o resto); a primeira escolha é a padrão. */
function DetailSwitch({ value, choices, onChange }) {
  const pct = (k) => `${Math.round(k * 100)}%`;
  return <div className="grid gap-1">
    <Segmented label="Mostrar o conteúdo a partir do zoom" value={String(value)} onChange={(v) => onChange(Number(v))}
      items={choices.map((k) => ({ value: String(k), label: pct(k) }))} />
    <span className="t-micro text-muted-foreground">
      A partir de {pct(value)} de zoom{value === choices[0] ? ' (padrão)' : ''}. Menos zoom mostra o conteúdo mais de longe e monta mais nós de uma vez.
    </span>
  </div>;
}

window.ArgosReading = { Popover, Island, FiltersPanel, ActiveChips, SearchBox, ViewsBar, LayoutSwitch, DetailSwitch, focusSearch, SEARCH_INPUT_ID, ISLAND_BUTTON };
})();
