/* Celular (< 768 px) das páginas Claude e Herdr: níveis lista -> detalhe com o voltar do sistema, terminal em tela cheia que
 * acompanha o visualViewport e a barra de teclas acima do teclado virtual. Toda decisão vem de term-logic.tsx (window.TermLogic).
 * Contrato: reference/panel.md §Terminal › Interface e §Layout no celular. Dono dos recursos: cada hook encerra o ouvinte que abre. */
(() => {
const { useState, useEffect, useRef, useCallback, I, cn, Button, useApp, getJSON } = HadesCore;
const L = window.TermLogic;

/** true abaixo de 768 px; acompanha a rotação e o redimensionar. */
function useIsMobile() {
  const q = `(max-width: ${L.MOBILE_MAX_PX - 1}px)`;
  const [on, setOn] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q), f = () => setOn(m.matches);
    f(); m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [q]);
  return on;
}

/** Nível da página no celular. `enter()` abre o detalhe e empilha uma entrada no histórico; o voltar do sistema (popstate) ou
 *  `leave()` volta à lista sem sair da página. Fora do celular o chamador ignora o nível. */
function useMobileLevel() {
  const [level, setLevel] = useState('list');
  const cur = useRef('list');
  const apply = useCallback((ev) => {
    const st = L.navStep(cur.current, ev);
    cur.current = st.level; setLevel(st.level);
    if (st.history === 'push') history.pushState({ hadesLevel: 1 }, '');
    else if (st.history === 'back' && history.state && history.state.hadesLevel) history.back();
  }, []);
  useEffect(() => {
    const f = () => apply('pop');
    addEventListener('popstate', f);
    return () => removeEventListener('popstate', f);
  }, [apply]);
  return { level, enter: useCallback(() => apply('enter'), [apply]), leave: useCallback(() => apply('leave'), [apply]) };
}

/** Caixa do visualViewport enquanto `active`; trava a rolagem da página para ela não pular quando o teclado abre. */
function useViewBox(active) {
  const [box, setBox] = useState(() => L.viewBox(window.visualViewport, window));
  useEffect(() => {
    if (!active) return undefined;
    const vv = window.visualViewport, read = () => setBox(L.viewBox(vv, window));
    read();
    vv?.addEventListener('resize', read); vv?.addEventListener('scroll', read); addEventListener('resize', read);
    const root = document.documentElement, was = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => { vv?.removeEventListener('resize', read); vv?.removeEventListener('scroll', read); removeEventListener('resize', read); root.style.overflow = was; };
  }, [active]);
  return box;
}

// HADES_TERMINAL_KEYS: uma leitura por carga da página; lista inválida já vem como padrão + aviso
let keysOnce = null;
function loadKeys() {
  keysOnce ??= getJSON('/api/config').then((r) => L.parseKeys(((r.items || []).find((i) => i.key === 'HADES_TERMINAL_KEYS') || {}).value))
    .catch(() => L.parseKeys(null));
  return keysOnce;
}
function useTermKeys() {
  const { toast } = useApp();
  const [list, setList] = useState(() => L.parseKeys(null));
  useEffect(() => {
    let dead = false;
    loadKeys().then((l) => { if (dead) return; setList(l); if (l.warning) toast({ kind: 'warn', title: 'Teclas do terminal', desc: l.warning }); });
    return () => { dead = true; };
  }, []);
  return list.keys;
}

const KEY_CLS = 'inline-flex min-h-11 min-w-11 cursor-pointer select-none items-center justify-center border border-border-strong bg-background px-2 font-mono t-meta text-foreground outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-foreground aria-pressed:text-background';

/** Barra de teclas acima do teclado virtual. Toque não tira o foco do terminal (o teclado não fecha). `attention`: um agente espera
 *  você, então as respostas rápidas (1/2/3, y/n…) vêm primeiro e em destaque. */
function TermKeyBar({ api, attention }) {
  const { toast } = useApp();
  const keys = useTermKeys();
  const [ctrl, setCtrl] = useState(false);
  const armed = useRef(false);
  const arm = (on) => { armed.current = on; setCtrl(on); if (api.current) api.current.filter = on ? ((s) => { armed.current = false; setCtrl(false); return L.applyCtrl(s); }) : null; };
  useEffect(() => () => { if (api.current) api.current.filter = null; }, []);
  const sendKey = (id) => {
    const a = api.current;
    if (!a || !a.send) return;
    const bytes = L.keyBytes(id, !!a.appCursor?.());
    if (bytes === null) return;
    a.send(armed.current ? L.applyCtrl(bytes) : bytes);
    if (armed.current) arm(false);
    a.focus?.();
  };
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); if (t) api.current?.paste?.(t); api.current?.focus?.(); }
    catch (e) { toast({ kind: 'info', title: 'Não foi possível colar', desc: 'O navegador não liberou a área de transferência. Toque e segure no terminal para colar pelo menu do sistema.' }); }
  };
  const copy = () => { const t = api.current?.copyable?.(); if (t) { HadesCore.copyText(t); toast({ kind: 'ok', title: 'Copiado', desc: 'A seleção, ou o que está na tela.' }); } };
  const press = (id) => { const t = L.KEY_DEFS[id].tool; if (t === 'ctrl') arm(!armed.current); else if (t === 'paste') paste(); else if (t === 'copy') copy(); else sendKey(id); };
  const row = (group, extra) => keys.filter((id) => L.KEY_DEFS[id].group === group || (group === 'nav' && L.KEY_DEFS[id].group === 'tool')).map((id) => {
    const d = L.KEY_DEFS[id];
    return <button key={id} type="button" aria-label={d.aria} aria-pressed={d.tool === 'ctrl' ? ctrl : undefined}
      onMouseDown={(e) => e.preventDefault()} onClick={() => press(id)} className={cn(KEY_CLS, extra)}>{d.label}</button>;
  });
  const quick = row('quick', attention ? 'border-foreground bg-accent font-semibold' : '');
  const nav = row('nav');
  return <div className="grid shrink-0 gap-1 border-t border-border-strong bg-card p-1" role="toolbar" aria-label="Teclas do terminal" data-term-keybar={attention ? 'attention' : 'on'}>
    {attention ? <>{quick.length ? <div className="flex flex-wrap gap-1">{quick}</div> : null}<div className="flex flex-wrap gap-1">{nav}</div></>
      : <><div className="flex flex-wrap gap-1">{nav}</div>{quick.length ? <div className="flex flex-wrap gap-1">{quick}</div> : null}</>}
  </div>;
}

/** Tela cheia do celular: cabeçalho com o voltar, o conteúdo (children) e, com `apiRef` (terminal), a barra de teclas colada no teclado. */
function MobileTermScreen({ title, subtitle, onBack, attention, apiRef, actions, children }) {
  const box = useViewBox(true);
  return <div className="fixed z-40 flex flex-col bg-term text-term-foreground" style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
    role="region" aria-label={title} data-mobile-term={box.keyboard ? 'keyboard' : 'full'}>
    <header className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border-strong bg-card px-1 text-foreground">
      <Button variant="ghost" size="icon" className="min-h-11 min-w-11" icon={I.ArrowLeft} aria-label="Voltar" onClick={onBack} />
      <div className="min-w-0 flex-1">
        <div className="truncate t-section leading-5">{title}</div>
        {subtitle ? <div className="truncate t-meta text-muted-foreground">{subtitle}</div> : null}
      </div>
      {actions}
    </header>
    <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    {apiRef ? <TermKeyBar api={apiRef} attention={attention} /> : null}
  </div>;
}

HadesCore.Mobile = { useIsMobile, useMobileLevel, useViewBox, TermKeyBar, MobileTermScreen };
})();
