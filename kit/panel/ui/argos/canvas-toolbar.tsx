/* Barra de ferramentas do canvas (canto superior esquerdo) e a camada que desenha o retângulo da ferramenta armada.
 * Ponto de extensão: `registerTool({ id, label, icon, hint?, order? })` acrescenta uma ferramenta de retângulo à lista
 * (Terminal vem registrada aqui; nota e conexão entram num bloco próprio no fim deste arquivo); a página decide o que o
 * retângulo solto faz pelo `id` da ferramenta. Script clássico carregado sob demanda pela página (lista fechada em
 * pages/argos.tsx). Expõe window.ArgosCanvasToolbar. */
(() => {
const { useState, useRef, useEffect, I, cn } = HadesCore;

// arrasto menor que isto (em pixels da tela) é um clique: o nó nasce no tamanho padrão do tipo, centrado no ponto
const CLICK_PX = 8;
const TOOL_ID = /^[a-z][a-z0-9-]{0,31}$/;
const RING = 'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';
const TOOL_ERRORS = Object.freeze({ invalid: 'tool_invalid', duplicate: 'tool_duplicate' });

const tools = [];

/** Acrescenta uma ferramenta de retângulo; id repetido ou declaração inválida lança com `code` de TOOL_ERRORS. */
function registerTool(def) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  if (!def || typeof def !== 'object') fail(TOOL_ERRORS.invalid, 'a ferramenta deve ser um objeto');
  if (typeof def.id !== 'string' || !TOOL_ID.test(def.id)) fail(TOOL_ERRORS.invalid, `id da ferramenta deve seguir ${TOOL_ID.source}`);
  if (typeof def.label !== 'string' || !def.label.trim()) fail(TOOL_ERRORS.invalid, 'ferramenta sem rótulo');
  if (typeof def.icon !== 'string') fail(TOOL_ERRORS.invalid, 'ferramenta sem ícone');
  if (tools.some((t) => t.id === def.id)) fail(TOOL_ERRORS.duplicate, `a ferramenta "${def.id}" já está registrada`);
  const tool = Object.freeze({ id: def.id, label: def.label, icon: def.icon, hint: typeof def.hint === 'string' ? def.hint : '', order: Number.isFinite(def.order) ? def.order : tools.length * 10 });
  tools.push(tool);
  tools.sort((a, b) => a.order - b.order);
  return tool;
}

/** As ferramentas registradas, na ordem da barra. */
const listTools = () => [...tools];

/** Retângulo normalizado (x, y no canto de cima à esquerda) entre dois pontos da tela; `click` quando o arrasto é curto. */
function dragRect(a, b) {
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w, h, click: w < CLICK_PX && h < CLICK_PX };
}

/**
 * Retângulo da tela → retângulo do mundo do canvas. Clique (`rect.click`) vira o tamanho padrão `size`, centrado no ponto;
 * arrasto mantém o que foi desenhado, nunca abaixo de `min` (o mínimo do tipo, no mundo).
 */
function rectToWorld(cam, rect, { size, min }) {
  const C = window.CanvasModel.camera;
  if (rect.click) {
    const p = C.screenToWorld(cam, { x: rect.x, y: rect.y });
    return { x: p.x - size.w / 2, y: p.y - size.h / 2, w: size.w, h: size.h };
  }
  const p = C.screenToWorld(cam, { x: rect.x, y: rect.y });
  return { x: p.x, y: p.y, w: Math.max(min.w, rect.w / cam.k), h: Math.max(min.h, rect.h / cam.k) };
}

/** Botão da barra: ícone com rótulo visível em tela larga e só ícone (com nome acessível) no estreito; vertical mostra o rótulo a partir de xl (1280 px) e é só ícone abaixo. */
function ToolButton({ icon, label, title, pressed, onClick, style, vertical }) {
  const Icon = I[icon] || I.Square;
  return <button type="button" aria-pressed={pressed === undefined ? undefined : pressed} aria-label={label} title={title || label} onClick={onClick}
    className={cn('inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 px-2 t-meta max-md:min-h-11 max-md:min-w-11 max-md:justify-center', vertical && 'w-8 justify-center px-0 max-md:w-11 xl:w-full xl:justify-start xl:px-2', RING, pressed ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
    <Icon aria-hidden="true" className="size-4" style={style} /><span className={vertical ? 'max-md:sr-only max-xl:sr-only' : 'max-lg:sr-only'}>{label}</span>
  </button>;
}

/**
 * Barra de ferramentas. `armed` = id da ferramenta armada (ou `null`, Selecionar); `onArm(id | null)`. `quick` = botões de
 * início rápido (`{ key, label, icon?, color?, onClick }`), um por predefinição; `onRoles` abre a tela de papéis. `link` =
 * botão Conexão (`{ active, onClick }`): é ação, não retângulo (a linha nasce do nó selecionado), por isso fica fora de
 * `registerTool`; `active` acende o botão enquanto a conexão está armada no motor. `vertical` empilha os botões só com ícone
 * (borda esquerda do canvas); no celular a página usa a barra horizontal, embaixo.
 */
function CanvasToolbar({ armed, onArm, quick = [], onRoles, link, className, vertical = false }) {
  const sep = vertical ? 'my-1 h-px w-5' : 'mx-1 h-5 w-px';
  return <div role="toolbar" data-tour-step-id="argos-ferramentas" aria-label="Ferramentas do canvas" aria-orientation={vertical ? 'vertical' : 'horizontal'} className={cn('flex max-w-full items-center gap-0.5 elev-float bg-background p-0.5 scrollbar-thin', vertical ? 'flex-col overflow-y-auto' : 'overflow-x-auto', className)}>
    <ToolButton vertical={vertical} icon="MousePointer2" label="Selecionar" title="Selecionar (Esc)" pressed={armed === null} onClick={() => onArm(null)} />
    {tools.map((t) => <ToolButton vertical={vertical} key={t.id} icon={t.icon} label={t.label} title={t.hint ? `${t.label}: ${t.hint}` : t.label} pressed={armed === t.id} onClick={() => onArm(armed === t.id ? null : t.id)} />)}
    {link ? <ToolButton vertical={vertical} icon="Cable" label="Conexão" title="Conexão: do terminal ou nota selecionado até outro (Ctrl+L); Esc cancela" pressed={link.active} onClick={link.onClick} /> : null}
    {quick.length ? <span aria-hidden="true" className={cn(sep, 'shrink-0 bg-border')} /> : null}
    {quick.map((q) => <ToolButton vertical={vertical} key={q.key} icon={q.icon || 'SquareTerminal'} label={q.label} title={`Novo terminal: ${q.label}`} onClick={q.onClick} style={q.color ? { color: q.color } : undefined} />)}
    {onRoles ? <><span aria-hidden="true" className={cn(sep, 'shrink-0 bg-border')} /><ToolButton vertical={vertical} icon="IdCard" label="Papéis" title="Papéis dos terminais" onClick={onRoles} /></> : null}
  </div>;
}

/**
 * Camada sobre o palco enquanto uma ferramenta está armada: arrastar desenha o retângulo, soltar chama `onRect(rect)` com o
 * retângulo da tela (relativo à camada), Esc ou botão direito cancela (`onCancel`). A câmera fica parada durante o gesto.
 */
function ToolDragLayer({ tool, onRect, onCancel }) {
  const [drag, setDrag] = useState(null);
  const box = useRef(null);
  useEffect(() => {
    // Enter é o equivalente do arrasto pelo teclado: o nó nasce no tamanho padrão, no centro da vista
    const k = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); return; }
      if (e.key !== 'Enter' || !box.current || (e.target.closest && e.target.closest('input,textarea,select,[role=dialog]'))) return;
      e.preventDefault();
      e.stopPropagation();
      const r = box.current.getBoundingClientRect();
      onRect({ x: r.width / 2, y: r.height / 2, w: 0, h: 0, click: true });
    };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, [onCancel, onRect]);
  const at = (e) => { const r = box.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e) => {
    if (e.button !== 0) { e.preventDefault(); onCancel(); return; }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    setDrag({ a: p, b: p });
  };
  const move = (e) => { if (drag) setDrag({ a: drag.a, b: at(e) }); };
  const up = (e) => {
    if (!drag) return;
    const rect = dragRect(drag.a, at(e));
    setDrag(null);
    onRect(rect);
  };
  const r = drag ? dragRect(drag.a, drag.b) : null;
  return <div ref={box} role="presentation" data-tool-layer={tool.id} onPointerDown={down} onPointerMove={move} onPointerUp={up} onContextMenu={(e) => e.preventDefault()}
    className="pointer-events-auto absolute inset-0 z-[5] cursor-crosshair touch-none select-none">
    <span className="sr-only" role="status">{`${tool.label}: arraste um retângulo no canvas, clique ou tecle Enter para o tamanho padrão; Esc cancela.`}</span>
    {r && !r.click ? <div aria-hidden="true" className="absolute border-2 border-dashed border-ring bg-ring/10" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} /> : null}
  </div>;
}

registerTool({ id: 'terminal', label: 'Terminal', icon: 'SquareTerminal', hint: 'arraste um retângulo no canvas', order: 10 });

// ferramenta Nota: o retângulo solto vira um nó `note` (pages/argos.tsx, toolRect.note)
registerTool({ id: 'note', label: 'Nota', icon: 'StickyNote', hint: 'arraste um retângulo no canvas', order: 20 });

// ferramenta Área: o retângulo solto vira um nó `area` com os nós de centro dentro dele (pages/argos.tsx, toolRect.area)
registerTool({ id: 'area', label: 'Área', icon: 'SquareDashed', hint: 'arraste um retângulo em volta dos nós', order: 30 });
// ferramenta Desenho: o retângulo solto vira um nó `drawing` (pages/argos.tsx, toolRect.drawing)
registerTool({ id: 'drawing', label: 'Desenho', icon: 'PenTool', hint: 'arraste um retângulo no canvas', order: 40 });

window.ArgosCanvasToolbar = { CLICK_PX, TOOL_ERRORS, registerTool, listTools, dragRect, rectToWorld, CanvasToolbar, ToolDragLayer };
})();
