/* Tour guiado do painel (window.HadesTour) e a oferta do tour na primeira etapa do onboarding.
 *
 * O componente é um porte, em TSX do painel (sem dependência nova), do `tour` de tonghohin/tour
 * (https://github.com/tonghohin/tour), licença MIT:
 *   Copyright (c) 2025 Hin
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 *   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 *   permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright
 *   notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 * Mantém a API do original: passos com alvo por seletor (`data-tour-step-id`, vários elementos com o mesmo id são
 * destacados juntos), destaque por máscara SVG, popover posicionado (side), rota por passo (nextRoute/previousRoute
 * do original viram `route`, que o Gate navega). O que o original não tem e este traz: Esc fecha, setas navegam,
 * foco preso no popover, progresso, "Pular" e popover centralizado quando o alvo não existe (celular sem sidebar). */
(() => {
const { useLayoutEffect } = React;
const { useState, useEffect, useRef, useCallback, useMemo, I, cn, Button, Mono, CopyButton, post, getJSON, TL } = HadesCore;

const GAP = 12;
const MARGIN = 12;
const POPOVER_MAX = 384;
const OFFER_KEY = 'hades-tour-offer';
const REDIRECT_KEY = 'hades-onboard-redirect';
const START_EVENT = 'hades-tour-start';
const CHANGED_EVENT = 'hades-onboard-changed';
const SWIPE_MIN = 50;
const SWIPE_SLACK = 40;
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k) { try { sessionStorage.setItem(k, '1'); } catch (e) { /* navegação privada: oferece de novo, sem dano */ } },
};

const sameRects = (a, b) => a.length === b.length && a.every((r, i) => r.left === b[i].left && r.top === b[i].top && r.width === b[i].width && r.height === b[i].height);

/** Retângulos dos elementos do passo (id é uma palavra do atributo, então um elemento serve a mais de um passo). */
function measure(id) {
  const out = [];
  for (const el of document.querySelectorAll(`[data-tour-step-id~="${CSS.escape(id)}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    out.push({ el, left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0 });
  }
  return out;
}

/** Caixa que contém todos os alvos: o popover ancora nela. */
function union(rects) {
  const left = Math.min(...rects.map((r) => r.left)), top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right)), bottom = Math.max(...rects.map((r) => r.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/** Posição do popover: o lado pedido, senão o primeiro que cabe; sem alvo (ou sem lado que caiba) fica no centro/rodapé. */
function place(anchor, size, vw, vh, prefer) {
  const center = { top: Math.max(MARGIN, (vh - size.h) / 2), left: Math.max(MARGIN, (vw - size.w) / 2) };
  if (!anchor) return center;
  const mx = anchor.left + anchor.width / 2, my = anchor.top + anchor.height / 2;
  const fits = {
    bottom: { top: anchor.bottom + GAP, left: clamp(mx - size.w / 2, MARGIN, vw - size.w - MARGIN), ok: anchor.bottom + GAP + size.h <= vh - MARGIN },
    top: { top: anchor.top - GAP - size.h, left: clamp(mx - size.w / 2, MARGIN, vw - size.w - MARGIN), ok: anchor.top - GAP - size.h >= MARGIN },
    right: { top: clamp(my - size.h / 2, MARGIN, vh - size.h - MARGIN), left: anchor.right + GAP, ok: anchor.right + GAP + size.w <= vw - MARGIN },
    left: { top: clamp(my - size.h / 2, MARGIN, vh - size.h - MARGIN), left: anchor.left - GAP - size.w, ok: anchor.left - GAP - size.w >= MARGIN },
  };
  const order = [prefer, 'bottom', 'top', 'right', 'left'].filter((s, i, all) => fits[s] && all.indexOf(s) === i);
  const pick = order.find((s) => fits[s].ok);
  // alvo maior que a tela (card alto): o popover fica no rodapé, sobre o alvo, sem sair da janela
  if (!pick) return { top: Math.max(MARGIN, vh - size.h - MARGIN), left: center.left };
  return { top: fits[pick].top, left: fits[pick].left };
}

/** Passos: [{ id, title, content | body, route?, side?, command?, ref?, fallback? }]. `content` é o texto do tour geral;
 * `body`, `command` (equivalente de terminal), `ref` (seção da referência, via onRef) e `fallback` (quando o alvo não existe)
 * são do tour por página. onFinish no último "Concluir"; onClose (Esc, ✕, Pular) em qualquer outro fim. */
function Tour({ steps, page, navigate, onFinish, onClose, onRef }) {
  const [index, setIndex] = useState(0);
  const [targets, setTargets] = useState([]);
  const [size, setSize] = useState({ w: POPOVER_MAX, h: 220 });
  const [view, setView] = useState({ w: innerWidth, h: innerHeight });
  const [measuredFor, setMeasuredFor] = useState(null);
  const box = useRef(null);
  const swipe = useRef(null);
  const step = steps[index];
  const last = index === steps.length - 1;
  const titleId = 'tour-title-' + step.id, bodyId = 'tour-body-' + step.id;

  const next = useCallback(() => { if (last) onFinish(); else setIndex((i) => i + 1); }, [last, onFinish]);
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // o passo manda a rota da sua página; quem navega é o dono do tour (hash do painel)
  useEffect(() => { if (step.route && step.route !== page) navigate(step.route); }, [step, page, navigate]);

  // acompanha o alvo: a página troca, a lista atualiza e a janela muda de tamanho
  useEffect(() => {
    let scrolled = false, frame = 0;
    const update = () => {
      frame = 0;
      const found = measure(step.id);
      setTargets((old) => (sameRects(old, found) ? old : found));
      setMeasuredFor(step.id);
      setView((old) => (old.w === innerWidth && old.h === innerHeight ? old : { w: innerWidth, h: innerHeight }));
      if (found.length > 0 && !scrolled) {
        scrolled = true;
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        found[0].el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    addEventListener('resize', schedule);
    addEventListener('scroll', schedule, true);
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { attributes: true, childList: true, subtree: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);
    return () => {
      removeEventListener('resize', schedule);
      removeEventListener('scroll', schedule, true);
      mo.disconnect();
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [step.id]);

  // página parada atrás do tour; o foco volta a quem o abriu no fim
  useEffect(() => {
    const before = document.activeElement;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; before?.focus?.(); };
  }, []);

  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (r && (Math.round(r.width) !== Math.round(size.w) || Math.round(r.height) !== Math.round(size.h))) setSize({ w: r.width, h: r.height });
  });

  // foco no botão principal a cada passo
  useEffect(() => { box.current?.querySelector('[data-tour-primary]')?.focus(); }, [index]);

  // teclado: Esc fecha, setas navegam, Tab fica dentro do popover. Captura, para ganhar dos atalhos do painel.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'ArrowRight') next(); else prev();
        return;
      }
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0], end = items[items.length - 1];
      if (!box.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); end.focus(); }
      else if (!e.shiftKey && document.activeElement === end) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [next, prev, onClose]);

  // só depois de medir o passo: antes disso "sem alvo" seria só a primeira renderização
  const missing = measuredFor === step.id && targets.length === 0;
  // celular: arrastar o popover para a esquerda avança, para a direita volta
  const onTouchStart = (e) => { const t = e.touches[0]; swipe.current = t ? { x: t.clientX, y: t.clientY } : null; };
  const onTouchEnd = (e) => {
    const from = swipe.current, t = e.changedTouches[0];
    swipe.current = null;
    if (!from || !t) return;
    const dx = t.clientX - from.x, dy = t.clientY - from.y;
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dy) > SWIPE_SLACK) return;
    if (dx < 0) next(); else prev();
  };
  const width = Math.min(POPOVER_MAX, view.w - 2 * MARGIN);
  const pos = place(targets.length ? union(targets) : null, { w: width, h: size.h }, view.w, view.h, step.side);

  return ReactDOM.createPortal(<div className="fixed inset-0 z-[70]">
    <svg className="absolute inset-0 size-full" aria-hidden="true">
      <defs>
        <mask id="tour-mask">
          <rect x="0" y="0" width="100%" height="100%" fill="white" />
          {targets.map((t, i) => <rect key={i} x={t.left} y={t.top} width={t.width} height={t.height} rx={t.radius} fill="black" />)}
        </mask>
      </defs>
      <rect width="100%" height="100%" mask="url(#tour-mask)" fill="black" opacity="0.5" />
      {targets.map((t, i) => <rect key={i} x={t.left - 2} y={t.top - 2} width={t.width + 4} height={t.height + 4} rx={t.radius} fill="none" strokeWidth="2" style={{ stroke: 'var(--ring)' }} />)}
    </svg>
    <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId}
      style={{ top: pos.top, left: pos.left, width }} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
      className="absolute grid max-h-[calc(100dvh-24px)] gap-3 overflow-y-auto border border-border-strong bg-popover p-4 text-popover-foreground animate-fade-in">
      <div className="flex items-start gap-3">
        <h2 id={titleId} className="min-w-0 flex-1 t-section leading-snug">{step.title}</h2>
        <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-2" aria-label="Fechar o tour" icon={I.X} onClick={onClose} />
      </div>
      <p id={bodyId} className="t-body text-muted-foreground">{step.content ?? step.body}</p>
      {missing && step.fallback ? <p className="border-l-2 border-warn pl-3 t-body" role="note">{step.fallback}</p> : null}
      {step.command ? <div className="flex items-center gap-1 border border-border-strong bg-muted/40 py-0.5 pr-0.5 pl-2.5">
        <Mono className="min-w-0 flex-1 break-all">{step.command}</Mono>
        <CopyButton text={step.command} label="Copiar o comando" />
      </div> : null}
      {step.ref && onRef ? <button type="button" onClick={() => onRef(step)} className="flex cursor-pointer items-center gap-1.5 justify-self-start text-left t-label text-foreground underline underline-offset-4 outline-none hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <I.BookOpen className="size-3.5 shrink-0" aria-hidden="true" />
        {'Documentação: ' + step.ref}
      </button> : null}
      <div className="flex items-center gap-3">
        <div role="progressbar" aria-label="Progresso do tour" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={index + 1} aria-valuetext={`Passo ${index + 1} de ${steps.length}`} className="flex flex-1 gap-0.5">
          {steps.map((s, i) => <span key={s.id} className={cn('h-0.5 flex-1 transition-colors duration-300', i <= index ? 'bg-foreground' : 'bg-border-strong')} />)}
        </div>
        <span className="t-meta text-muted-foreground tnum" aria-hidden="true">{`${index + 1} de ${steps.length}`}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {last ? null : <Button variant="ghost" size="sm" onClick={onClose}>Pular</Button>}
        {index > 0 ? <Button variant="outline" size="sm" className="ml-auto" onClick={prev}>Voltar</Button> : null}
        <Button size="sm" data-tour-primary className={index > 0 ? '' : 'ml-auto'} onClick={next}>{last ? 'Concluir' : 'Próximo'}</Button>
      </div>
    </div>
  </div>, document.body);
}

// ------------------------------------------------------------------ o tour do Hades
// Primeiro valor: ambiente de pé (Visão geral) e a entrega até a PR (Loop); depois, o que falta no onboarding.
// O alvo de cada página é o cabeçalho dela (data-tour-step-id="tour-<página>", no App); o último, os passos pendentes.
const HADES_TOUR = [
  { id: 'tour-overview', route: 'overview', title: 'Serviços no ar', content: 'Serviços, memória e infra do ambiente. Subir e pausar ficam aqui; nada sobe sem você pedir.' },
  { id: 'tour-loop', route: 'loop', title: 'Da spec à PR', content: 'O que o /hades está fazendo: escalações que esperam você, entregas, PRs e agentes.' },
  { id: 'tour-onboard-pending', route: 'onboard', side: 'bottom', title: 'O que falta preparar', content: 'Escolha os recursos que quer agora; os passos pendentes aparecem aqui. Nada muda na sua máquina sem a sua aprovação.' },
];

const record = (value) => post('/api/onboard', { op: 'tour', value }).then(() => window.dispatchEvent(new Event(CHANGED_EVENT))).catch((e) => console.warn('tour: não gravei a escolha', e));

/** Falha no tour não derruba o painel: o tour se fecha e o resto segue. */
class TourGuard extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e) { console.error('tour: falhou, fechando', e); this.props.onFail(); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Primeira etapa no painel: leva à página Onboarding (uma vez por sessão do navegador) e oferece o tour. Montado pelo App. */
function Gate({ page, go }) {
  const [phase, setPhase] = useState('idle');
  // um tour por vez: enquanto o tour da página roda, o card que oferece o geral fica escondido (a fase continua 'offer')
  const [, repaint] = useState(0);
  useEffect(() => TL.subscribe(() => repaint((n) => n + 1)), []);
  const navigate = useCallback((id) => go(id), [go]);

  useEffect(() => {
    let off = false;
    getJSON('/api/onboard?quick=1').then((r) => {
      if (off || r.error || r.complete) return;
      if (!session.get(REDIRECT_KEY) && ['', 'overview'].includes(location.hash.replace(/^#\/?/, '').split('?')[0])) {
        session.set(REDIRECT_KEY);
        go('onboard');
      }
      if (!r.tour && !session.get(OFFER_KEY)) { session.set(OFFER_KEY); setPhase('offer'); }
    }).catch((e) => console.warn('tour: estado do onboarding indisponível', e));
    return () => { off = true; };
  }, [go]);

  useEffect(() => {
    const start = () => setPhase('tour');
    window.addEventListener(START_EVENT, start);
    return () => window.removeEventListener(START_EVENT, start);
  }, []);

  const finish = useCallback(() => { setPhase('idle'); record('seen'); }, []);
  const skip = useCallback(() => { setPhase('idle'); record('skip'); }, []);

  if (phase === 'tour') return <TourGuard onFail={() => setPhase('idle')}><Tour steps={HADES_TOUR} page={page} navigate={navigate} onFinish={finish} onClose={skip} /></TourGuard>;
  if (!TL.offerVisible(phase === 'offer')) return null;
  return <div role="region" aria-labelledby="tour-offer-title" className="fixed right-4 bottom-4 left-4 z-40 grid gap-3 border border-border-strong bg-popover p-4 text-popover-foreground sm:left-auto sm:w-96">
    <div className="flex items-start gap-3">
      <I.Compass className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="grid min-w-0 flex-1 gap-1">
        <h2 id="tour-offer-title" className="t-section leading-snug">Tour de 1 minuto</h2>
        <p className="t-body text-muted-foreground">
          Serviços no ar, o loop até a PR e o que falta preparar. Refaça pelo Onboarding.
        </p>
      </div>
    </div>
    <div className="flex items-center gap-2 pl-7">
      <Button variant="ghost" size="sm" onClick={skip}>Pular</Button>
      <Button size="sm" className="ml-auto" icon={I.Play} onClick={() => setPhase('tour')}>Começar o tour</Button>
    </div>
  </div>;
}

// ------------------------------------------------------------------ o tour de uma página
// Os passos vêm do registro (HadesCore.registerTour / registerPage(id, C, { tour })); o App monta este componente uma vez.
// Enquanto roda, a prévia (se houver) está ligada em TL; sair do tour por qualquer caminho a desliga.
function PageTour({ page, go }) {
  const [running, setRunning] = useState(() => TL.running());
  useEffect(() => { setRunning(TL.running()); return TL.subscribe(() => setRunning(TL.running())); }, []);
  // trocar de página encerra o tour da anterior; desmontar também, para a prévia nunca ficar ligada
  useEffect(() => { if (running && running !== page) TL.end(); }, [running, page]);
  useEffect(() => () => TL.end(), []);
  const def = running === page ? TL.get(page) : null;
  const steps = useMemo(() => (def ? def.steps : null), [def]);
  const finish = useCallback(() => { TL.markProgress(TL.storage(), page, 'seen'); TL.end(); }, [page]);
  const close = useCallback(() => {
    if (TL.readProgress(TL.storage())[page] !== 'seen') TL.markProgress(TL.storage(), page, 'skip');
    TL.end();
  }, [page]);
  const openRef = useCallback(() => { finish(); go('docs'); }, [finish, go]);
  if (!steps) return null;
  return <TourGuard onFail={TL.end}><Tour key={page} steps={steps} page={page} navigate={go} onFinish={finish} onClose={close} onRef={openRef} /></TourGuard>;
}

window.HadesTour = { Tour, Gate, PageTour, steps: HADES_TOUR, START_EVENT, CHANGED_EVENT, start: () => window.dispatchEvent(new Event(START_EVENT)) };
})();
