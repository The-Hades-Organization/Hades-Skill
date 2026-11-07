/* Peças da página Argos (#/argos): grafo em SVG, lista, painel lateral, ações e paleta. A regra mora em argos/logic.tsx
 * (window.ArgosLogic); aqui só se desenha e se coleta. Carregado antes de pages/argos.js. */
(() => {
const { useState, useEffect, useRef, useMemo, useCallback, I, cn, getJSON, Button, Dot, Mono, Empty, Dialog, DialogHeader, DialogFooter, Sheet, Input,
  Skeleton, HoldConfirm, useConfirmPrefs, CardHeader, Fio, Tracos, Progress, Menu, Select } = HadesCore;
const L = window.ArgosLogic;
// cor, forma, ícone e indicadores dos nós: a regra e as tabelas moram em src/lib/canvas-argos.ts (pacote do modelo)
const A = window.CanvasModel.argos;

// estado em palavras (minúsculas, como no Herdr) e o olho que o desenha
const stateUi = (s) => A.stateLook(s).word;
const TYPE_WORD = { agent: 'agente', unit: 'unidade', pr: 'PR', gate: 'gate' };
const TOUCH_MIN = 'max-md:min-h-11';
const hms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toLocaleTimeString('pt-BR') : '—'; };
const agoMs = (iso, now) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? HadesCore.dur(Math.max(0, (now - t) / 1000)) : null; };
const KEY_LABEL = { Up: 'Seta para cima', Down: 'Seta para baixo', Left: 'Seta para a esquerda', Right: 'Seta para a direita' };
const ROW = 'group grid w-full gap-1 border-b border-l-2 border-l-transparent px-3 py-2.5 text-left t-body transition-colors cursor-pointer hover:bg-accent/60 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

// o olho de Argos é o ponto de estado do nó: aberto e vivo (trabalha), aberto no tom do aviso (pede você, parado),
// aberto e quieto (ocioso, aberta, na fila), fechado (concluído, arquivado, fora); o tom vem da tabela de estados
const EYE_OF_TONE = { vivo: 'vivo', warn: 'warn', bad: 'bad', info: 'ok', muted: 'fechado' };
const eyeOf = (n, now) => EYE_OF_TONE[A.stateLook(n.state, L.severity(n, now)).tone];

// tom → classe. O ícone e a forma usam o tom inteiro (contraste de gráfico, 3:1); o texto do `vivo` fica na cor do texto
// porque o rosa vivo do tema escuro não chega a 4,5:1 (AA) como texto sobre o cartão
const TONE_ICON = { vivo: 'text-vivo', warn: 'text-warn', bad: 'text-bad', info: 'text-info', muted: 'text-muted-foreground' };
const TONE_TEXT = { vivo: 'text-foreground', warn: 'text-warn', bad: 'text-bad', info: 'text-info', muted: 'text-muted-foreground' };
// ícone do lucide pelo nome da tabela; nome que o pacote não tem some em vez de quebrar a página
function Icon({ name, ...rest }) {
  const C = I[name];
  return C ? <C aria-hidden="true" {...rest} /> : null;
}
// a forma do tipo do nó (círculo, quadrado, losango, hexágono): o canal que não depende de cor
function Forma({ shape, size = 12, className }) {
  const points = A.shapePoints(shape, 1, 1, size - 2, size - 2).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn('shrink-0', className)} aria-hidden="true"><polygon points={points} fill="currentColor" /></svg>;
}
const EYE = { vivo: ['stroke-foreground', 'fill-vivo'], warn: ['stroke-warn', 'fill-warn'], bad: ['stroke-bad', 'fill-bad'], ok: ['stroke-muted-foreground', 'fill-ok'] };
function Olho({ node, now, x, y }) {
  const k = eyeOf(node, now);
  const ui = EYE[k];
  return <svg x={x} y={y} width="16" height="10" viewBox="0 0 16 10" className="shrink-0 overflow-visible" aria-hidden="true">
    {ui ? <>
      <path d="M1 5 Q8 -1.5 15 5 Q8 11.5 1 5 Z" fill="none" strokeWidth="1.25" className={ui[0]} />
      <circle cx="8" cy="5" r="2.25" className={cn(ui[1], k === 'warn' && 'pulso')} />
    </> : <path d="M1 3.5 Q8 9.5 15 3.5 M4.2 6.6 L3.4 8.6 M8 7.6 L8 9.8 M11.8 6.6 L12.6 8.6" fill="none" strokeWidth="1.25" strokeLinecap="round" className="stroke-muted-foreground" />}
  </svg>;
}

// estado do nó em texto: a palavra, e o que pede você ou o que parou com o tom e a forma do aviso
function Estado({ node, now, eye }) {
  const sev = L.severity(node, now);
  const perm = node.pendingPermission;
  return <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 t-meta">
    {eye ? <Olho node={node} now={now} /> : null}
    <span className={sev === 'attention' ? 'font-medium text-foreground' : 'text-muted-foreground'}>{stateUi(node.state)}</span>
    {perm ? <span className="inline-flex items-center gap-1 font-medium text-warn"><I.Hand className="size-3" aria-hidden="true" />pede permissão{perm.tool ? ` para ${perm.tool}` : ''}</span> : null}
    {sev === 'stalled' ? <span className="inline-flex items-center gap-1 font-medium text-bad"><I.Clock className="size-3" aria-hidden="true" />sem evento há {agoMs(node.lastEventTs, now)}</span> : null}
  </span>;
}

// ------------------------------------------------------------------ canvas
// cor do cabeçalho do nó (o canvas desenha com ela; variável CSS não vale no canvas, então se lê o valor do tema)
const fillOf = (node, now) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(A.TONE_VAR[A.stateLook(node.state, L.severity(node, now)).tone]).trim();
  return v || '#888';
};

// altura do cabeçalho do nó (desenhado no canvas, fora do corpo) e de uma linha do corpo, em px de mundo
const NODE_HEADER_PX = 24;
const BODY_LINE_PX = 17;
const BODY_PAD_PX = 16;

// corpo do nó (HTML sobre o canvas, abaixo do cabeçalho com o nome): tipo (forma), papel e estado (ícone) e, perto, os
// indicadores que couberem (permissão, pergunta, gate, CI, PR, custo × estimado, herdr); o rótulo falado leva todos
function NodeBody({ node, now, w, h }) {
  if (!node) return null;
  const sev = L.severity(node, now);
  const look = A.stateLook(node.state, sev);
  const type = A.typeLook(node.type);
  const eye = eyeOf(node, now);
  const all = A.nodeIndicators(node);
  const { shown, hidden } = A.fitIndicators(all, (w || 200) - BODY_PAD_PX);
  const rows = Math.floor(((h || 66) - NODE_HEADER_PX) / BODY_LINE_PX);
  const role = node.role || TYPE_WORD[node.type] || node.type;
  const word = sev === 'stalled' ? `parado há ${agoMs(node.lastEventTs, now)}` : look.word;
  return <div role="group" aria-label={[`${type.label} ${node.label}`, word, ...all.map((i) => i.label)].join('. ')}
    className={cn('grid h-full content-center gap-0.5 px-2 t-micro', eye === 'fechado' ? 'text-muted-foreground' : 'text-foreground')}>
    <span className="flex min-w-0 items-center gap-1.5" aria-hidden="true" title={type.label}>
      <Forma shape={type.shape} className="text-muted-foreground" />
      <Icon name={look.icon} className={cn('size-3 shrink-0', TONE_ICON[look.tone], sev === 'attention' && 'pulso')} />
      <span className="t-meta-em shrink-0 whitespace-nowrap" title={word}>{word}</span>
      <span className="truncate text-muted-foreground" title={role}>{role}</span>
    </span>
    {shown.length ? <span className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap" aria-hidden="true">
      {shown.map((i) => <span key={i.kind} title={i.label} className={cn('inline-flex items-center gap-1', TONE_TEXT[i.tone])}>
        <Icon name={i.icon} className={cn('size-3 shrink-0', TONE_ICON[i.tone])} />{i.short}
      </span>)}
      {hidden ? <span title={all.slice(shown.length).map((i) => i.label).join('; ')} className="text-muted-foreground">+{hidden}</span> : null}
    </span> : null}
    {rows >= 3 && node.phase ? <span className="truncate text-muted-foreground" title={`fase ${node.phase}`} aria-hidden="true">{`fase ${node.phase}`}</span> : null}
  </div>;
}
// o desenho de cada tipo do registro (src/lib/canvas-argos.ts); `getNow` lê o relógio da página sem recriar o registro
const makeNodeRender = (getNow) => () => (input) => <NodeBody node={input.live} now={getNow()} w={input.w} h={input.h} />;

const useThemeTick = () => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setTick((t) => t + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => mo.disconnect();
  }, []);
  return tick;
};

// nós elevados e acoplados (canvas-dock): painel central e colunas fixas sobre o canvas, com o desenho do tipo no tamanho
// do quadro; o estado é da página e as posições saem de layoutDock a cada mudança de tela
// largura que o painel do nó (canvas-focus) tira da direita do palco: ele é uma sobreposição, e a moldura centrada na tela
// inteira passaria por baixo dele, escondendo o "Voltar ao canvas". Na folha do celular (colada embaixo) não há recuo lateral.
const PANEL_SELECTOR = '[role="complementary"][aria-label="Painel do nó"]';
const sidePanelInset = (stage) => {
  const panel = stage.querySelector(PANEL_SELECTOR);
  if (!panel || panel.offsetWidth >= stage.clientWidth) return 0;
  return Math.max(0, stage.clientWidth - panel.offsetLeft);
};
const useSidePanelInset = (sentinel) => {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    // o palco é o contêiner que a página divide entre o canvas (com a moldura) e o painel: o avô da sentinela
    const stage = sentinel.current?.parentElement?.parentElement;
    if (!stage) return undefined;
    const read = () => setInset(sidePanelInset(stage));
    const ro = new ResizeObserver(read);
    const watch = () => { ro.disconnect(); ro.observe(stage); const panel = stage.querySelector(PANEL_SELECTOR); if (panel) ro.observe(panel); read(); };
    const mo = new MutationObserver(watch);
    mo.observe(stage, { childList: true });
    watch();
    return () => { mo.disconnect(); ro.disconnect(); };
  }, [sentinel]);
  return inset;
};
function DockLayer({ api, state, onState, doc, renderAt, describe }) {
  const M = window.CanvasModel;
  const [view, setView] = useState(null);
  const sentinel = useRef(null);
  const inset = useSidePanelInset(sentinel);
  useEffect(() => {
    if (!api) return undefined;
    const read = () => { const v = api.viewport(); setView((cur) => (cur && cur.w === v.w && cur.h === v.h ? cur : { w: v.w, h: v.h })); };
    read();
    return api.onFrame(read);
  }, [api]);
  const visibleW = view ? view.w - inset : 0;
  if (!view || visibleW <= 0 || view.h <= 0 || (state.elevated === null && state.columns.length === 0)) return <span ref={sentinel} hidden />;
  const layout = M.dock.layoutDock(state, { w: visibleW, h: view.h });
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const panel = (id, frame, action) => {
    const node = byId.get(id);
    if (!node) return null;
    const name = describe(node);
    const bodyH = Math.max(0, frame.h - DOCK_HEADER_PX);
    return <section key={id} aria-label={name} data-docked={action.mode} className="elev-float absolute z-20 flex flex-col border border-border-strong bg-card"
      style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
      <header className="flex shrink-0 items-center gap-2 border-b px-2 t-meta max-lg:h-11!" style={{ height: DOCK_HEADER_PX }}>
        <span className="min-w-0 flex-1 truncate font-medium" title={name}>{name}</span>
        <Button size="sm" variant="outline" className="max-lg:min-h-11!" icon={I.Minimize2} title={action.hint} onClick={() => onState(action.next())}>Voltar ao canvas</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{renderAt(node, frame.w, bodyH)}</div>
    </section>;
  };
  return <>
    <span ref={sentinel} hidden />
    {layout.columns.map((c) => panel(c.id, c.frame, { mode: 'column', hint: 'Solta o nó da coluna e o devolve ao canvas', next: () => M.dock.undock(state, c.id) }))}
    {layout.elevated ? panel(layout.elevated.id, layout.elevated.frame, { mode: 'elevated', hint: 'Baixa o nó destacado e o devolve ao canvas', next: () => M.dock.release(state) }) : null}
  </>;
}
const DOCK_HEADER_PX = 32;
// o reconhecedor de toque só precisa do relógio entre os eventos: o tique confere o toque longo enquanto há dedo na tela
const LONGPRESS_TICK_MS = 100;

// o motor (ui/argos/canvas-engine.js) com o desenho dos tipos do registro e o menu de botão direito (câmera e histórico são de canvas-controls.js)
// `onLinkState(from | undefined)`: a conexão armada no motor (origem) ou desarmada; o motor guarda a função da montagem,
// então ela tem de ter identidade fixa
// nome de um nó do usuário (terminal, nota, desenho) que o grafo não conhece: o que o `data` guarda como nome, título ou arquivo
const ownName = (n) => {
  const d = n.data || {};
  for (const key of ['name', 'note', 'title', 'file']) if (typeof d[key] === 'string' && d[key].trim()) return d[key].trim();
  return '';
};

// ------------------------------------------------------------------ ações no cabeçalho do nó
// Um grupo só, o mesmo em terminal, nota, tty e desenho: Destacar (sobe o nó para uma moldura em primeiro plano), Recolher
// (leva à bandeja) e "⋯" (o menu do nó). O botão não decide nada: avisa o canvas por um evento que sobe até o CanvasPane, que
// repassa à página; a página roda o comando de sempre (`dock:elevate`, `canvas:hide`) sobre esse nó. Dentro de uma moldura
// acoplada (DockLayer, `data-docked`) o grupo some: a moldura tem o "Voltar ao canvas" dela.
const NODE_COMMAND_EVENT = 'argos-node-command';
const NODE_MENU_COMMAND = 'menu';
const NODE_ACTION_BTN = 'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-lg:size-11';
const NODE_ACTIONS = [
  { command: 'dock:elevate', icon: 'Maximize2', label: 'Destacar', hint: 'Destacar: abre o nó em primeiro plano (E)' },
  { command: 'canvas:hide', icon: 'ArrowDownToLine', label: 'Recolher', hint: 'Recolher para a bandeja (Shift+H)' },
  { command: NODE_MENU_COMMAND, icon: 'Ellipsis', label: 'Mais ações', hint: 'Mais ações do nó' },
];
function NodeActions({ id, locked = false, more = true }) {
  const ref = useRef(null);
  const [docked, setDocked] = useState(false);
  useEffect(() => { setDocked(Boolean(ref.current?.closest('[data-docked]'))); }, []);
  const fire = (e, command) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    ref.current?.dispatchEvent(new CustomEvent(NODE_COMMAND_EVENT, { bubbles: true, detail: { id, command, x: r.left, y: r.bottom } }));
  };
  // o ponteiro no cabeçalho é do canvas (arrastar o nó): nos botões ele fica só neles
  const keepPointer = (e) => e.stopPropagation();
  return <span ref={ref} className="contents">
    {docked ? null : <span role="group" aria-label="Ações do nó" className="flex shrink-0 items-center" onPointerDown={keepPointer} onDoubleClick={keepPointer}>
      {locked ? <span role="img" aria-label="conteúdo travado" title="Conteúdo travado" className="inline-flex size-6 items-center justify-center text-muted-foreground"><I.Lock aria-hidden="true" className="size-3" /></span> : null}
      {NODE_ACTIONS.filter((a) => more || a.command !== NODE_MENU_COMMAND).map((a) => { const Icon = I[a.icon]; return <button key={a.command} type="button" aria-label={a.label} title={a.hint} onClick={(e) => fire(e, a.command)} className={NODE_ACTION_BTN}>
        <Icon aria-hidden="true" className="size-3.5" />
      </button>; })}
    </span>}
  </span>;
}

function CanvasPane({ doc, selection, onSelectionChange, onOp, graphById, types, now, onContext, onReady, nodeShape, snap, dock, dockState, onDockState, onLinkState, fullDetail, trayItems, onUnhide, onNodeCommand }) {
  const Engine = window.ArgosCanvas.CanvasView;
  const M = window.CanvasModel;
  const wrap = useRef(null);
  const apiRef = useRef(null);
  const latest = useRef({ doc, onReady });
  latest.current = { doc, onReady };
  const theme = useThemeTick();
  const selected = useMemo(() => new Set(selection), [selection]);
  // a área se chama pelo título (desenho e nome acessível); os demais, pelo rótulo do grafo ou o id
  const describeNode = useCallback((n) => (M.areas.isAreaNode(n) ? M.areas.areaLook(n).title || 'Área' : graphById.get(n.id)?.label || ownName(n) || n.id), [graphById]);
  const nodeColor = useCallback((n) => { const g = graphById.get(n.id); return g ? fillOf(g, now) : '#888'; }, [graphById, now, theme]);
  const isRich = useCallback((n) => types.get(n.type)?.draw.surface === 'html', [types]);
  const renderAt = useCallback((n, w, h) => types.get(n.type)?.draw.render({ id: n.id, type: n.type, w, h, selected: selected.has(n.id), data: n.data, live: graphById.get(n.id) }) ?? null,
    [types, graphById, selected]);
  const renderNode = useCallback((n) => renderAt(n, n.w, n.h), [renderAt]);
  const [engineApi, setEngineApi] = useState(null);
  // o motor nasce antes de o navegador medir o contêiner: sem área a câmera de abertura fica para o primeiro quadro que tenha
  const stopWaitingArea = useRef(null);
  const ready = useCallback((api) => {
    apiRef.current = api;
    const place = () => {
      const view = api.viewport();
      if (view.w <= 0 || view.h <= 0) return false;
      const cam = M.store.firstCamera(latest.current.doc.nodes, view);
      if (cam) api.setCamera(cam, false);
      return true;
    };
    if (!place()) {
      const off = api.onFrame(() => { if (place()) { off(); stopWaitingArea.current = null; } });
      stopWaitingArea.current = off;
    }
    setEngineApi(api);
    latest.current.onReady?.(api);
  }, []);
  useEffect(() => () => { stopWaitingArea.current?.(); }, []);
  const menuAt = useCallback((id, x, y) => onContext({ id, x, y }), [onContext]);
  const nodeMenu = useCallback(({ id, screen }) => { const r = wrap.current.getBoundingClientRect(); menuAt(id, r.left + screen.x, r.top + screen.y); }, [menuAt]);
  const menuAtClient = (clientX, clientY) => {
    const api = apiRef.current; if (!api) return;
    const r = wrap.current.getBoundingClientRect();
    const cam = api.getCamera();
    const world = M.camera.screenToWorld(cam, { x: clientX - r.left, y: clientY - r.top });
    const hit = M.selection.hitTest(latest.current.doc.nodes, world, { k: cam.k, detail: 'dot', resizable: () => false });
    menuAt(hit ? hit.id : null, clientX, clientY);
  };
  // toque longo abre o menu de contexto (N8). Só o evento `longpress` do reconhecedor é usado: pan e pinça já são do motor
  const touch = useRef(null);
  const stopTicker = () => { const t = touch.current; if (t && t.timer) { clearInterval(t.timer); t.timer = 0; } };
  useEffect(() => () => stopTicker(), []);
  const onTouchEvents = (events) => {
    for (const ev of events) {
      if (ev.type !== 'longpress') continue;
      stopTicker();
      menuAtClient(ev.at.x, ev.at.y);
    }
  };
  const touchDown = (e) => {
    if (e.pointerType !== 'touch') return;
    if (!touch.current) touch.current = { rec: M.touch.createTouchRecognizer(() => performance.now()), fingers: new Set(), timer: 0 };
    const t = touch.current;
    t.fingers.add(e.pointerId);
    onTouchEvents(t.rec.down(e.pointerId, { x: e.clientX, y: e.clientY }));
    if (!t.timer) t.timer = setInterval(() => onTouchEvents(t.rec.tick()), LONGPRESS_TICK_MS);
  };
  const touchMove = (e) => {
    const t = touch.current;
    if (e.pointerType !== 'touch' || !t || !t.fingers.has(e.pointerId)) return;
    onTouchEvents(t.rec.move(e.pointerId, { x: e.clientX, y: e.clientY }));
  };
  const touchUp = (e) => {
    const t = touch.current;
    if (e.pointerType !== 'touch' || !t || !t.fingers.delete(e.pointerId)) return;
    if (e.type === 'pointercancel') { t.rec.cancel(); t.fingers.clear(); stopTicker(); return; }
    t.rec.up(e.pointerId);
    if (t.fingers.size === 0) stopTicker();
  };
  const contextMenu = (e) => {
    e.preventDefault();
    // com dedo na tela o menu é do toque longo acima (o navegador também manda `contextmenu` no toque demorado)
    if (touch.current && touch.current.fingers.size > 0) return;
    menuAtClient(e.clientX, e.clientY);
  };
  // os botões do cabeçalho dos nós avisam por evento; aqui vira o menu do nó ou o comando da página
  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const onCommand = (e) => {
      const { id, command, x, y } = e.detail;
      if (command === NODE_MENU_COMMAND) menuAt(id, x, y); else onNodeCommand?.(id, command);
    };
    el.addEventListener(NODE_COMMAND_EVENT, onCommand);
    return () => el.removeEventListener(NODE_COMMAND_EVENT, onCommand);
  }, [menuAt, onNodeCommand]);
  const Legend = window.ArgosLegend?.CanvasLegend;
  const Tray = window.ArgosCanvasHidden?.HiddenTray;
  return <div ref={wrap} onContextMenu={contextMenu} onPointerDown={touchDown} onPointerMove={touchMove} onPointerUp={touchUp} onPointerCancel={touchUp}
    className="relative h-full min-h-64 bg-background">
    <Engine doc={doc} selection={selection} onSelectionChange={onSelectionChange} onOp={onOp} onNodeMenu={nodeMenu} describeNode={describeNode} nodeColor={nodeColor}
      isRich={isRich} nodeShape={nodeShape} renderNode={renderNode} backgroundDrag="pan" onReady={ready} snap={snap} dock={dock} onLinkState={onLinkState} fullDetail={fullDetail}
      label="Canvas dos agentes: arraste o fundo para mover, role para ampliar" />
    {dockState && onDockState ? <DockLayer api={engineApi} state={dockState} onState={onDockState} doc={doc} renderAt={renderAt} describe={describeNode} /> : null}
    {Legend ? <Legend /> : null}
    {Tray && trayItems && onUnhide ? <Tray items={trayItems} onUnhide={onUnhide} /> : null}
  </div>;
}

// Camadas sobre o canvas (ui/argos/canvas-overlays.js): acompanha a câmera e o tamanho da tela pelo quadro do motor e só
// redesenha quando um dos dois muda, para o pan não redesenhar a página inteira. Sem o motor pronto, nada aparece.
const sameFrame = (a, camera, view) => a.camera.x === camera.x && a.camera.y === camera.y && a.camera.k === camera.k && a.view.w === view.w && a.view.h === view.h;
function CanvasLayers({ api, ...layers }) {
  const Overlays = window.ArgosCanvasOverlays.CanvasOverlays;
  const [frame, setFrame] = useState(null);
  useEffect(() => {
    if (!api) return undefined;
    const read = () => {
      const camera = api.getCamera();
      const view = api.viewport();
      setFrame((cur) => (cur && sameFrame(cur, camera, view) ? cur : { camera, view }));
    };
    read();
    return api.onFrame(read);
  }, [api]);
  if (!api || !frame || frame.view.w <= 0 || frame.view.h <= 0) return null;
  return <Overlays camera={frame.camera} view={frame.view} {...layers} />;
}

// vista em lista: a mesma seleção, boa no celular; quem pede você vem primeiro, depois quem parou, depois quem trabalha
function NodeList({ nodes, selected, onSelect, now, order }) {
  const rank = (n) => { const e = eyeOf(n, now); return e === 'warn' ? 0 : e === 'bad' ? 1 : e === 'vivo' ? 2 : e === 'ok' ? 3 : 4; };
  const list = [...order].sort((a, b) => rank(a) - rank(b));
  if (!nodes.length) return <Empty icon={I.SearchX} title="Nada com esse filtro" />;
  return <div className="grid content-start" role="list">
    {list.map((n) => {
      const on = selected === n.id;
      const where = [n.registry === '_skill' ? 'a própria skill' : n.registry, n.phase ? `fase ${n.phase}` : null].filter(Boolean).join(' · ');
      return <button type="button" role="listitem" key={n.id} onClick={() => onSelect(n.id)} aria-pressed={on} className={cn(ROW, TOUCH_MIN, on && 'border-l-foreground bg-accent/40')}>
        <span className="flex min-w-0 items-center gap-2.5">
          <Olho node={n} now={now} />
          <Forma shape={A.typeLook(n.type).shape} className="text-muted-foreground" />
          <span className={cn('min-w-0 truncate font-medium', eyeOf(n, now) === 'fechado' && 'text-muted-foreground')}>{n.label}</span>
          <span className="shrink-0 t-meta text-muted-foreground">{n.role || TYPE_WORD[n.type] || n.type}</span>
          <span className="ml-auto shrink-0"><Estado node={n} now={now} /></span>
        </span>
        {where || n.branch ? <span className="truncate pl-[26px] t-meta text-muted-foreground">{where}{where && n.branch ? ' · ' : ''}{n.branch ? <Mono>{n.branch}</Mono> : null}</span> : null}
      </button>;
    })}
  </div>;
}

// A lista é um painel por cima do canvas, que nunca some: lateral à esquerda na mesa, folha que sobe de baixo no celular.
// Esc fecha (o foco volta a quem abriu); ponteiro e roda dentro dela não chegam ao canvas.
const LIST_SHIELD = { onPointerDown: (e) => e.stopPropagation(), onPointerMove: (e) => e.stopPropagation(), onPointerUp: (e) => e.stopPropagation(), onWheel: (e) => e.stopPropagation() };
function ListPanel({ open, phone, summary, onClose, children }) {
  const root = useRef(null);
  useEffect(() => { if (open) root.current?.focus(); }, [open]);
  if (!open) return null;
  return <div ref={root} role="complementary" aria-label="Lista de nós" tabIndex={-1} data-region="list" data-tour-step-id="argos-lista" {...LIST_SHIELD}
    onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); } }}
    className={cn('pointer-events-auto absolute z-20 flex flex-col border-border-strong bg-card text-card-foreground outline-none animate-fade-in',
      phone ? 'inset-x-0 bottom-0 max-h-[70%] border-t' : 'top-16 bottom-3 left-14 w-[min(22rem,40%)] border')}>
    {phone ? <span aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 bg-border-strong" /> : null}
    <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1">
      <span className="t-meta-em text-muted-foreground">Lista · {summary}</span>
      <Button variant="ghost" size="icon-sm" icon={I.X} aria-label="Fechar a lista" className="max-md:size-11" onClick={onClose} />
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</div>
  </div>;
}

// ------------------------------------------------------------------ painel lateral
function FileSheet({ src, onClose }) {
  const [x, setX] = useState(null);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    setX(null);
    getJSON(`/api/orchestration/file?name=${encodeURIComponent(src.name)}&file=${encodeURIComponent(src.file)}`).then((r) => alive && setX(r)).catch((e) => alive && setX({ text: null, error: String(e.message || e) }));
    return () => { alive = false; };
  }, [src]);
  return <Sheet open={!!src} onClose={onClose} wide icon={I.FileText} title={src ? `${src.name} · ${src.file}.md` : ''} description={x?.file || ''}>
    <div className="p-4">
      {!x ? <Skeleton className="h-40" /> : x.error ? <Empty icon={I.CircleAlert} title="Não deu para ler o arquivo">{x.error}</Empty>
        : !x.text ? <Empty icon={I.FileX} title="Arquivo vazio" />
        : <pre className="overflow-auto border bg-card p-4 t-code whitespace-pre-wrap scrollbar-thin">{x.text}</pre>}
    </div>
  </Sheet>;
}

// a faixa do tempo como fio: fia enquanto o agente trabalha e o diário está ao vivo, corta onde parou, fica medido
// quando acabou; os nós são os eventos que contam (aviso, bloqueio, fim), na posição do tempo
const FIO_NOS = 24;
function FioDoTempo({ node, events, live, now }) {
  const ts = events.map((e) => Date.parse(e.ts || '')).filter(Number.isFinite);
  const working = node.state === 'working';
  const stalled = L.severity(node, now) === 'stalled';
  const s = stalled ? 'cortado' : working ? (live ? 'fiando' : 'frouxo') : ts.length ? 'medido' : 'parado';
  const t0 = ts[0], last = ts[ts.length - 1];
  const t1 = working ? now : last;
  const at = (t) => (t1 > t0 ? Math.round(((t - t0) / (t1 - t0)) * 1000) / 10 : 100);
  const nos = s === 'medido' || s === 'fiando' || s === 'cortado'
    ? [...new Set(events.filter((e) => L.eventTone(e) !== 'idle').map((e) => at(Date.parse(e.ts || ''))).filter(Number.isFinite))].slice(-FIO_NOS) : [];
  const label = `Faixa do tempo de ${node.label}: ${events.length} evento${events.length === 1 ? '' : 's'}${last ? `, o último às ${hms(new Date(last).toISOString())}` : ''}`;
  return <div className="grid gap-1.5">
    <Fio s={s} nos={nos} corte={ts.length ? at(last) : 0} label={label} />
    {ts.length ? <div className="flex justify-between t-meta text-muted-foreground tnum">
      <span>{hms(new Date(t0).toISOString())}</span>
      <span>{working ? 'agora' : hms(new Date(last).toISOString())}</span>
    </div> : null}
  </div>;
}

const TONE_DOT = { bad: 'bad', warn: 'warn', ok: 'ok', idle: 'idle' };
function Timeline({ node, events, live, now }) {
  const box = useRef(null);
  const stick = useRef(true);
  useEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [events.length]);
  return <section className="grid gap-3" aria-label="Faixa do tempo">
    <CardHeader as="h3" title="Faixa do tempo" summary={<span className="inline-flex items-center gap-1.5">
      <Dot kind={live ? 'busy' : 'idle'} pulse={live} />
      {live ? 'ao vivo' : 'reconectando…'}
      <span className="tnum">· {events.length} evento{events.length === 1 ? '' : 's'}</span>
    </span>} />
    <FioDoTempo node={node} events={events} live={live} now={now} />
    {events.length ? <ol ref={box} onScroll={(e) => { const b = e.currentTarget; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40; }} aria-label="Eventos do diário do agente"
      className="max-h-72 overflow-auto border bg-card t-data scrollbar-thin">
      {events.map((e, i) => <li key={`${e.ts}|${i}`} className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-2 border-b px-2.5 py-1 last:border-b-0">
        <span className="text-muted-foreground tnum">{hms(e.ts)}</span>
        <Dot kind={TONE_DOT[L.eventTone(e)]} className="mt-[5px]" />
        <span className="line-clamp-2 break-all" title={e.summary || undefined}><span className="font-medium">{e.kind}</span>{e.tool ? ` ${e.tool}` : ''}{e.summary ? <span className="text-muted-foreground"> · {e.summary}</span> : null}</span>
      </li>)}
    </ol> : <p className="t-body text-muted-foreground">Sem eventos ainda.</p>}
  </section>;
}

function Facts({ rows }) {
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 t-body">
    {rows.filter((r) => r[1] != null && r[1] !== '').map(([k, v]) => <div key={k} className="contents">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 break-words">{v}</dd>
    </div>)}
  </dl>;
}

const usd2 = (v) => (v == null ? '—' : 'US$ ' + v.toFixed(2).replace('.', ','));
const BUDGET_UI = { warn: ['text-warn', 'warn', 'passou do estimado'], ask: ['text-bad', 'bad', 'passou muito do estimado'] };
const PR_STATE = { OPEN: 'aberta', MERGED: 'mergeada', CLOSED: 'fechada' };
const PR_MERGE = { MERGEABLE: 'sem conflito', CONFLICTING: 'com conflito', UNKNOWN: 'conflito ainda não calculado' };
const FILES = [['brief', 'brief.md'], ['report', 'report.md'], ['questions', 'questions.md'], ['handoff', 'handoff.md']];

// % das janelas do plano (hades usage sample), discreto: some sem amostra; falha de leitura também
function JanelasLinha() {
  const [x, setX] = useState(null);
  useEffect(() => {
    let alive = true;
    const f = () => getJSON('/api/limits').then((r) => alive && setX(r)).catch(() => {});
    f(); const t = setInterval(f, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!x?.janelas?.length) return null;
  return <p className="t-meta text-muted-foreground tnum" aria-label="Uso das janelas do plano">
    {x.janelas.map((j) => `${j.rotulo} ${Math.round(j.pct)}% (renova ${j.renova})`).join(' · ')}
  </p>;
}

function SidePanel({ node, detail, moirai, detailError, events, live, now, onFile, runs, actions }) {
  if (!node) return <Empty icon={I.MousePointerClick} title="Escolha um nó.">Faixa do tempo, PR e ações aparecem aqui.</Empty>;
  const pr = detail?.pr, ci = pr?.ci, h = detail?.herdr, files = detail?.files || {};
  const agent = node.type === 'agent';
  const budget = agent && moirai ? BUDGET_UI[moirai.level] : null;
  const open = files.questions?.openQuestions || [];
  return <div className="grid gap-6">
    <header className="grid gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="min-w-0 t-section break-words">{node.label}</h2>
        <span className="t-body text-muted-foreground">{TYPE_WORD[node.type] || node.type}{node.role ? ` · ${node.role}` : ''}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Estado node={node} now={now} eye />
        {budget ? <span className={cn('inline-flex items-center gap-1 t-meta-em', budget[0])}><I.CircleAlert className="size-3" aria-hidden="true" />{budget[2]} · {Math.floor(moirai.pct)}% da estimativa alta (p75)</span> : null}
      </div>
      {agent ? <JanelasLinha /> : null}
      {actions}
    </header>
    {!agent ? <Facts rows={[['Registro', node.registry], ['Número', node.number], ['Estado', stateUi(node.state)], ['Fila', node.label]]} /> : <>
      <div className="grid gap-2">
        <Facts rows={[['Registro', node.registry === '_skill' ? '_skill (a própria skill)' : node.registry], ['Modo', node.mode], ['Fase', node.phase], ['Branch', node.branch && <Mono>{node.branch}</Mono>], ['Base', node.base && <Mono>{node.base}</Mono>],
          ['Último evento', node.lastEventTs ? <span className="tnum">{hms(node.lastEventTs)} · há {agoMs(node.lastEventTs, now)}</span> : null],
          ['No herdr', h ? `${stateUi(h.status)}${h.pane ? ` · terminal ${h.pane}` : ''}` : detail ? 'fora do herdr' : null]]} />
        {h?.pane ? <a className="inline-flex max-md:min-h-11 items-center gap-1.5 justify-self-start t-body underline underline-offset-3 hover:no-underline" href={`#/herdr?pane=${encodeURIComponent(h.pane)}`}>
          <I.SquareTerminal className="size-4" aria-hidden="true" />Abrir no Herdr</a> : null}
        {detailError ? <p className="t-body text-bad" role="alert">Detalhe indisponível: {detailError}. Tentando de novo a cada 10 s.</p> : null}
      </div>
      {moirai?.estimate?.costP75 != null ? <section className="grid gap-3" aria-label="Estimado e real">
        <CardHeader as="h3" title="Estimado × real" summary="Moirai · faixa típica de unidades parecidas" />
        {moirai.real ? <div className="grid gap-1.5">
          <div className="flex items-baseline justify-between gap-2 t-body"><span className="font-medium tnum">{usd2(moirai.real.costUsd)}</span><span className="t-meta text-muted-foreground tnum">{Math.floor(moirai.pct)}% da estimativa alta ({usd2(moirai.estimate.costP75)})</span></div>
          <Progress value={Math.min(100, moirai.pct)} kind={budget ? budget[1] : undefined} />
        </div> : null}
        <Facts rows={[
          ['Estimado (faixa p25–p75)', <span className="tnum">{usd2(moirai.estimate.costP25)} – {usd2(moirai.estimate.costP75)}</span>],
          ['Mediana', <span className="tnum">{usd2(moirai.estimate.costMedian)}</span>],
          ['Duração real', moirai.real?.wallMin == null ? null : `${Math.round(moirai.real.wallMin)} min`],
          ['Duração estimada', moirai.estimate.wallP75 == null ? null : `${Math.round(moirai.estimate.wallP25)}–${Math.round(moirai.estimate.wallP75)} min`],
          ['Confiança', moirai.estimate.confidence]]} />
      </section> : null}
      <section className="grid gap-3" aria-label="Pull request e CI">
        <CardHeader as="h3" title="PR e CI" />
        {!detail ? <Skeleton className="h-10" /> : !pr ? <p className="t-body text-muted-foreground">Sem PR.</p>
          : pr.unavailable ? <p className="t-body text-muted-foreground">PR indisponível (gh sem rede ou acesso).</p>
          : <div className="grid gap-2 t-body">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <a href={pr.url} target="_blank" rel="noopener" className="font-medium tnum underline underline-offset-3 hover:no-underline">PR #{pr.number}</a>
              <span className="text-muted-foreground">{PR_STATE[pr.state] || String(pr.state).toLowerCase()}{pr.isDraft ? ' · rascunho' : ''}{pr.mergeable ? ` · ${PR_MERGE[pr.mergeable] || String(pr.mergeable).toLowerCase()}` : ''}</span>
            </p>
            {ci ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Tracos items={[...Array(ci.passing).fill('ok'), ...Array(ci.failing).fill('bad'), ...Array(ci.pending).fill('idle')]} label={`CI: ${ci.passing} passando, ${ci.failing} falhando, ${ci.pending} pendentes`} />
              <span className="t-meta text-muted-foreground tnum">{ci.passing} passando · <span className={ci.failing ? 'font-medium text-bad' : ''}>{ci.failing} falhando</span> · {ci.pending} pendente{ci.pending === 1 ? '' : 's'}</span>
            </div> : null}
          </div>}
      </section>
      <section className="grid gap-3" aria-label="Arquivos do agente">
        <CardHeader as="h3" title="Arquivos" summary={open.length ? `${open.length} pergunta${open.length === 1 ? '' : 's'} aberta${open.length === 1 ? '' : 's'}` : null} />
        <div className="flex flex-wrap gap-2">
          {FILES.map(([f, name]) => <Button key={f} size="xs" variant="outline" icon={I.FileText} disabled={!files[f]} className="font-mono" onClick={() => onFile({ name: node.label, file: f })}
            aria-label={files[f] ? `Abrir ${name}` : `${name} ainda não existe`}>{name}</Button>)}
        </div>
        {open.length ? <ul className="grid gap-1 t-body">{open.map((q) => <li key={q} className="flex gap-2"><I.MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" /><span className="min-w-0">{q}</span></li>)}</ul> : null}
      </section>
      <Timeline node={node} events={events} live={live} now={now} />
      {runs.length ? <section className="grid gap-3" aria-label="Ações feitas aqui">
        <CardHeader as="h3" title="Ações feitas aqui" />
        <ul className="grid border-t t-body">
          {runs.map((r) => <li key={r.id} className="grid gap-1 border-b py-2">
            <span className="flex items-center gap-2">
              {r.status === 'running' ? <Dot kind="busy" pulse /> : r.status === 'ok' ? <I.CircleCheck className="size-4 text-ok" aria-hidden="true" /> : <I.CircleX className="size-4 text-bad" aria-hidden="true" />}
              <span className="min-w-0 truncate font-medium">{r.label}</span>
              <span className="ml-auto shrink-0 t-meta text-muted-foreground tnum">{r.status === 'running' ? 'aguardando o agente' : hms(new Date(r.at).toISOString())}</span>
            </span>
            {r.output ? <pre className="max-h-28 overflow-auto t-code whitespace-pre-wrap text-muted-foreground scrollbar-thin">{r.output}</pre> : null}
          </li>)}
        </ul>
      </section> : null}
    </>}
  </div>;
}

// ------------------------------------------------------------------ ações
// a resposta à permissão vem primeiro e grande; as ações do agente (hades agent) ficam à mão; as de terminal (herdr) e
// encerrar moram no menu, com encerrar por último no tom de perigo
const TERMINAL_ACTIONS = ['free_prompt', 'text', 'keys'];
function ActionBar({ node, actions, onPick }) {
  if (!node || node.type !== 'agent' || !actions.length) return null;
  const primary = actions.filter((a) => a.needs === 'permission');
  const agentActs = actions.filter((a) => a.needs !== 'permission' && !a.destructive && !TERMINAL_ACTIONS.includes(a.id));
  const term = actions.filter((a) => TERMINAL_ACTIONS.includes(a.id));
  const danger = actions.filter((a) => a.destructive);
  const more = [...term.map((a) => ({ label: a.label, icon: I[a.icon], onClick: () => onPick(a) })), term.length && danger.length ? '-' : null,
    ...danger.map((a) => ({ label: a.label, icon: I[a.icon], danger: true, onClick: () => onPick(a) }))].filter(Boolean);
  return <div className="grid gap-2 pt-1" role="toolbar" aria-label={`Ações em ${node.label}`}>
    {primary.length ? <div className="flex flex-wrap gap-2">
      {primary.map((a) => <Button key={a.id} variant={a.id === 'approve_permission' ? 'default' : 'outline'} icon={I[a.icon]} className="max-md:flex-1" onClick={() => onPick(a)}>{a.label}</Button>)}
    </div> : null}
    <div className="flex flex-wrap items-center gap-1.5">
      {agentActs.map((a) => <Button key={a.id} size="xs" variant="outline" icon={I[a.icon]} onClick={() => onPick(a)}>{a.label}</Button>)}
      {more.length ? <Menu label="Mais ações: terminal e encerrar" items={more} /> : null}
    </div>
  </div>;
}

function ActionDialog({ node, action, detail, onClose, onRun }) {
  const [vals, setVals] = useState({});
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState(null);
  const first = useRef(null);
  const prefs = useConfirmPrefs(true);
  const PromptBar = window.HadesFx.use('PromptBar', action?.id === 'prompt');
  const questions = useMemo(() => L.questionIds(detail), [detail]);
  useEffect(() => {
    setErr(null); setTyped('');
    const seed = {};
    if (action?.id === 'answer') seed.question = questions[0] || '';
    if (action?.id === 'keys') seed.keys = 'Enter';
    setVals(seed);
    setTimeout(() => first.current?.focus(), 30);
  }, [action?.id]);
  if (!action || !node) return <Dialog open={false} onClose={onClose} label="Ação" />;
  const submit = (e) => {
    e?.preventDefault();
    const v = L.validateArgs(action, vals);
    if (!v.ok) { setErr(v.reason); return; }
    if (L.needsConfirm(action.id) && !L.confirmMatches(typed, node, prefs.typed)) { setErr('Digite o nome do agente para confirmar.'); return; }
    onRun(action, v.args, typed);
    onClose();
  };
  const set = (name, value) => setVals((s) => ({ ...s, [name]: value }));
  const destructive = L.needsConfirm(action.id);
  const askName = destructive && prefs.typed;
  const options = (f) => (f.name === 'question' ? questions : f.options);
  return <Dialog open onClose={onClose} label={action.label}>
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader icon={I[action.icon]} tone={destructive ? 'danger' : undefined} title={`${action.label} · ${node.label}`}
        description={destructive ? `${action.hint}.${askName ? `\n\nDigite ${node.label} para confirmar.` : ''}` : action.id === 'approve_permission' && node.pendingPermission?.tool
          ? `Aprova só este pedido de ${node.pendingPermission.tool}, uma vez: Enter no terminal do agente. Para ver o comando antes, abra o terminal no Herdr.` : action.hint} />
      {action.fields.map((f, i) => f.kind === 'check' ? <label key={f.name} className="flex cursor-pointer items-center gap-2.5 t-body">
        <input ref={i === 0 ? first : undefined} type="checkbox" checked={!!vals[f.name]} onChange={(e) => set(f.name, e.target.checked)} className="size-4 accent-foreground" />
        <span>{f.label}</span>
      </label> : <label key={f.name} className="grid gap-1.5 t-body">
        <span className="font-medium">{f.label}{f.required ? '' : <span className="font-normal text-muted-foreground"> (opcional)</span>}</span>
        {f.kind === 'textarea' && PromptBar ? <PromptBar width={4000} radius={0} placeholder="Prompt para o agente" sources={[]} commands={[]} models={[]} efforts={[]}
          background="var(--card)" color="var(--foreground)" menuBackground="var(--popover)" sparkColor="var(--primary)"
          onSend={(t) => { const v = L.validateArgs(action, { ...vals, [f.name]: t }); if (!v.ok) { setErr(v.reason); return; } onRun(action, v.args, typed); onClose(); }} />
          : f.kind === 'textarea' ? <textarea ref={i === 0 ? first : undefined} rows={4} value={vals[f.name] || ''} onInput={(e) => set(f.name, e.target.value)}
          className="min-h-24 max-h-60 resize-y border border-border-strong bg-background px-3 py-2 text-base outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring md:text-sm" />
          : f.kind === 'select' ? <Select ref={i === 0 ? first : undefined} size="sm" label={f.label} value={vals[f.name] || ''} onChange={(v) => set(f.name, v)}
            items={options(f).map((o) => ({ value: o, label: KEY_LABEL[o] || o }))} />
          : <Input autoFocus={i === 0} value={vals[f.name] || ''} maxLength={f.max} onInput={(e) => set(f.name, e.target.value)} />}
      </label>)}
      {askName ? <Input value={typed} onInput={(e) => setTyped(e.target.value)} placeholder={node.label} aria-label="Nome do agente" autoFocus /> : null}
      {err ? <p className="t-body text-bad" role="alert">{err}</p> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} className={TOUCH_MIN}>Cancelar</Button>
        {destructive
          ? <HoldConfirm size="default" disabled={!L.confirmMatches(typed, node, prefs.typed)} icon={I[action.icon]} className={TOUCH_MIN} onHold={submit}>{'Segure 1,2 s: ' + action.label}</HoldConfirm>
          : <Button type="submit" variant="default" icon={I[action.icon]} className={TOUCH_MIN}>{action.label}</Button>}
      </DialogFooter>
    </form>
  </Dialog>;
}

// ------------------------------------------------------------------ perguntas dos comandos do canvas
// Um diálogo para as três perguntas da porta `dialogs` (texto, escolha, confirmação) e a do lote (confirmação com o que se
// digita). `ask` = { kind: 'text'|'choose'|'confirm', title, text?, initial?, options?, phrase?, answer(valor) }; fechar sem
// escolher responde null (texto e escolha) ou false (confirmação). Sem `ask`, nada aberto.
// Escolha em que cada opção é uma cor: grade de botões de rádio com a amostra ao lado do nome (setas movem a escolha).
function SwatchChoice({ title, options, value, onChange }) {
  const move = (e, i) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(i + step + options.length) % options.length];
    onChange(next.value);
    document.getElementById('argos-swatch-' + next.value)?.focus();
  };
  return <div role="radiogroup" aria-label={title} className="grid grid-cols-2 gap-1.5">
    {options.map((o, i) => {
      const on = o.value === value;
      return <button type="button" role="radio" aria-checked={on} key={o.value} id={'argos-swatch-' + o.value} tabIndex={on ? 0 : -1} autoFocus={on}
        onClick={() => onChange(o.value)} onKeyDown={(e) => move(e, i)}
        className={cn('flex items-center gap-2 rounded-md border px-2.5 py-2 text-left t-body', TOUCH_MIN, on ? 'border-foreground bg-accent/40' : 'border-border hover:bg-accent/20')}>
        <span aria-hidden="true" className="size-4 shrink-0 rounded-sm border border-foreground/20" style={{ background: o.swatch }} />
        <span className="truncate">{o.label}</span>
      </button>;
    })}
  </div>;
}

function AskDialog({ ask, onDone }) {
  const [value, setValue] = useState('');
  useEffect(() => { setValue(ask?.kind === 'choose' ? ask.options?.[0]?.value ?? '' : ask?.initial ?? ''); }, [ask]);
  if (!ask) return <Dialog open={false} onClose={() => {}} label="Pergunta" />;
  const cancel = () => { ask.answer(ask.kind === 'confirm' ? false : null); onDone(); };
  const typedOk = !ask.phrase || value.trim() === ask.phrase;
  const submit = (e) => {
    e?.preventDefault();
    if (ask.kind === 'confirm' && !typedOk) return;
    ask.answer(ask.kind === 'confirm' ? true : value);
    onDone();
  };
  return <Dialog open onClose={cancel} label={ask.title}>
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader icon={ask.kind === 'confirm' ? I.CircleAlert : I.Pencil} tone={ask.phrase ? 'danger' : undefined} title={ask.title} description={ask.text || undefined} />
      {ask.kind === 'text' ? <Input autoFocus value={value} onInput={(e) => setValue(e.target.value)} aria-label={ask.title} />
        : ask.kind === 'choose' && (ask.options || []).some((o) => o.swatch) ? <SwatchChoice title={ask.title} options={ask.options} value={value} onChange={setValue} />
        : ask.kind === 'choose' ? <Select autoFocus size="sm" label={ask.title} value={value} onChange={setValue}
          items={(ask.options || []).map((o) => ({ value: o.value, label: o.label }))} />
        : ask.phrase ? <label className="grid gap-1.5 t-body"><span>Digite {ask.phrase} para confirmar</span>
          <Input autoFocus value={value} onInput={(e) => setValue(e.target.value)} placeholder={ask.phrase} /></label> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={cancel} className={TOUCH_MIN}>Cancelar</Button>
        <Button type="submit" variant="default" disabled={!typedOk} className={TOUCH_MIN}>{ask.kind === 'confirm' ? 'Confirmar' : 'OK'}</Button>
      </DialogFooter>
    </form>
  </Dialog>;
}

// ------------------------------------------------------------------ paleta e ajuda
function Palette({ open, onClose, items, onRun }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const shown = useMemo(() => L.filterPalette(items, q).slice(0, 40), [items, q]);
  useEffect(() => { if (open) { setQ(''); setIdx(0); } }, [open]);
  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => { document.getElementById('argos-pal-' + idx)?.scrollIntoView({ block: 'nearest' }); }, [idx]);
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && shown[idx]) { e.preventDefault(); onRun(shown[idx]); }
  };
  return <Dialog open={open} onClose={onClose} label="Paleta de comandos do Argos" className="gap-3 p-4 sm:max-w-xl">
    <Input autoFocus icon={I.Command} value={q} onInput={(e) => setQ(e.target.value)} onKeyDown={key} placeholder="Buscar agente ou comando…" aria-label="Comando" role="combobox" aria-expanded="true" aria-controls="argos-pal" />
    <ul id="argos-pal" role="listbox" className="max-h-80 overflow-auto scrollbar-thin">
      {shown.length ? shown.map((it, i) => <li key={it.id} id={'argos-pal-' + i} role="option" aria-selected={i === idx}>
        <button type="button" onClick={() => onRun(it)} onMouseMove={() => setIdx(i)} className={cn('flex w-full items-center gap-2 px-2 py-2 text-left t-body cursor-pointer', TOUCH_MIN, i === idx && 'bg-accent')}>
          <span className="min-w-0 flex-1 truncate">{it.label}</span>
          <span className="shrink-0 t-meta text-muted-foreground">{it.group}</span>
        </button>
      </li>) : <li className="px-2 py-3 t-body text-muted-foreground">Nada encontrado{q.trim() ? ` para “${q.trim()}”` : ''}.</li>}
    </ul>
  </Dialog>;
}

// teclas do motor dentro do canvas (docs: reference/argos.md §Teclado e leitor de tela); os comandos da página vêm do registro
const CANVAS_KEYS = [['Tab', 'próximo nó (Shift: anterior)'], ['Espaço', 'seleciona o nó em foco (Shift: alterna)'], ['Setas', 'movem o nó em foco (Shift: 5 grades)'],
  ['+ − 0', 'aproxima, afasta, enquadra'], ['Enter', 'menu do nó em foco'], ['Esc', 'limpa a seleção']];
// F6 é da página, não do registro: anda pelas regiões do HUD e do canvas
const REGION_KEYS = [['F6', 'próxima região: ilhas, ferramentas, canvas, câmera, painel (Shift: anterior)']];
function HelpDialog({ open, onClose, rows }) {
  const chord = window.CanvasModel.commands.chordLabel;
  return <Dialog open={open} onClose={onClose} label="Atalhos do Argos" className="max-h-[calc(100dvh-4rem)] grid-rows-[auto_minmax(0,1fr)]">
    <DialogHeader icon={I.Keyboard} title="Atalhos do Argos" description="Valem fora de campos de texto." />
    <div className="grid content-start gap-4 min-h-0 overflow-y-auto overscroll-contain pr-1" tabIndex={0} aria-label="Lista de atalhos">
      <ul className="grid gap-1 t-body">
        {rows.map((r) => <li key={r.id} className="flex items-center gap-3">
          <kbd className="min-w-14 border bg-muted px-1.5 py-0.5 text-center t-data text-muted-foreground">{r.shortcuts.map(chord).join(' · ')}</kbd>
          <span>{r.label}</span>
        </li>)}
      </ul>
      <ul className="grid gap-1 t-body">
        {REGION_KEYS.map(([k, what]) => <li key={k} className="flex items-center gap-3">
          <kbd className="min-w-14 border bg-muted px-1.5 py-0.5 text-center t-data text-muted-foreground">{k}</kbd><span>{what}</span>
        </li>)}
      </ul>
      <p className="t-meta-em text-muted-foreground">Com o foco no canvas</p>
      <ul className="grid gap-1 t-body">
        {CANVAS_KEYS.map(([k, what]) => <li key={k} className="flex items-center gap-3">
          <kbd className="min-w-14 border bg-muted px-1.5 py-0.5 text-center t-data text-muted-foreground">{k}</kbd><span>{what}</span>
        </li>)}
      </ul>
    </div>
  </Dialog>;
}

window.ArgosParts = { AskDialog, NodeActions, CanvasPane, CanvasLayers, ListPanel, makeNodeRender, NodeList, SidePanel, ActionBar, ActionDialog, Palette, HelpDialog, FileSheet, Estado, agoMs, Forma, Icon, TONE_ICON, TONE_TEXT };
})();
