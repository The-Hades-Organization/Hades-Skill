/* Miolo das abas segmentadas do painel: uma "pílula" é uma janela recortada sobre uma cópia da fileira (fundo e cor
 * trocados), com a borda esquerda e a direita animadas em separado. Clique estica a janela até o destino; a pílula
 * também se arrasta, com resistência nas pontas e inércia ao soltar. Quem chama (Segmented, em app.tsx) fornece o
 * tablist, a borda e a altura; aqui só o miolo. Exposto em window.HadesFx.RubberSegment. */
(() => {
const { useRef, useLayoutEffect, useEffect } = React;
const { animate, motionValue } = window.HadesFx.motion;

const STYLE_ID = 'hades-fx-rubber-segment';
const TAP_SLOP_PX = 10;
const DRAG_DEADZONE_PX = 4;
const PRESS_SCALE = 0.96;
const GROW_S = 0.19;
const GROW_EASE = [0.23, 1, 0.32, 1];
const FRONT_DELAY_S = 0.15;
const EDGE_SPRING_S = 0.3;
const RELAX_S = 0.16;
const FLING_SPRING_S = 0.4;
const FLING_BOUNCE = 0.2;
const FLING_MIN_PX_S = 110;
const VELOCITY_WINDOW_MS = 100;
const VELOCITY_MIN_SAMPLES = 2;
const VELOCITY_MIN_SPAN_MS = 8;
const VELOCITY_CAP_PX_S = 2000;
const ELASTIC_GAIN = 0.55;
const GLIDE_REF = 75;
const GLIDE_REF_SPEED_PX_S = 1000;

const CSS = `
.rs-root{position:relative;display:flex;flex:none;height:100%;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
.rs-cell{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:.375rem;padding:0 .75rem;font-size:var(--fs-label);font-weight:500;white-space:nowrap;border:0 solid var(--border);border-left-width:1px}
.rs-cell:first-child{border-left-width:0}
.rs-cell>svg{width:1rem;height:1rem;flex:none}
.rs-item{position:relative;appearance:none;background:none;margin:0;font-family:inherit;line-height:inherit;color:var(--muted-foreground);cursor:pointer;outline:none;touch-action:pan-x pan-y;transition:color 160ms,transform 160ms}
.rs-item[aria-selected=true]{cursor:default;color:var(--muted-foreground)}
.rs-root[data-draggable] .rs-item[aria-selected=true]{cursor:grab;touch-action:pan-y}
.rs-item[data-pressed]{transform:scale(${PRESS_SCALE})}
.rs-item:focus-visible::after{content:"";position:absolute;inset:0;z-index:2;outline:2px solid var(--ring);outline-offset:-2px;pointer-events:none}
.rs-lens{position:absolute;inset:0;z-index:1;display:flex;background:var(--muted);color:var(--foreground);pointer-events:none;clip-path:inset(0 0 0 100%)}
.rs-lens .rs-cell{border-left-color:transparent}
.rs-root[data-drag],.rs-root[data-drag] *{cursor:grabbing!important}
@media (hover:hover) and (pointer:fine){.rs-item[aria-selected=false]:hover{color:var(--foreground)}}
@media (prefers-reduced-motion:reduce){.rs-item{transition:none}}
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** Bordas da janela para uma pílula de largura w cujo lado esquerdo "quer" estar em `want`, numa fileira de `total` px.
 * Com `elastic`, além das pontas rende ~55 % do excesso e satura em uma largura de pílula, espremendo o lado da ponta. */
function edgesAt(want, w, total, elastic) {
  const maxLeft = Math.max(0, total - w);
  if (!elastic) { const left = clamp(want, 0, maxLeft); return { left, right: left + w }; }
  const squeeze = (over) => w * (1 - Math.exp((-ELASTIC_GAIN * over) / w));
  if (want < 0) return { left: 0, right: w - squeeze(-want) };
  if (want > maxLeft) return { left: maxLeft + squeeze(want - maxLeft), right: total };
  return { left: want, right: want + w };
}

/** Velocidade (px/s) do centro nas últimas amostras; sem amostras suficientes ou com intervalo curto demais, 0. */
function velocityOf(samples, now) {
  const recent = samples.filter((s) => now - s.t <= VELOCITY_WINDOW_MS);
  if (recent.length < VELOCITY_MIN_SAMPLES) return 0;
  const first = recent[0], last = recent[recent.length - 1];
  const span = last.t - first.t;
  if (span < VELOCITY_MIN_SPAN_MS) return 0;
  return ((last.c - first.c) / span) * 1000;
}

/** Item onde a pílula assenta: o mais próximo do centro projetado pela inércia; arremesso que cairia no atual vai um além. */
function pickIndex(rects, center, velocity, glide, current) {
  const avg = rects.reduce((sum, r) => sum + (r.r - r.l), 0) / rects.length;
  const target = center + (velocity / GLIDE_REF_SPEED_PX_S) * avg * (glide / GLIDE_REF);
  let best = 0;
  rects.forEach((r, i) => {
    const b = rects[best];
    if (Math.abs((r.l + r.r) / 2 - target) < Math.abs((b.l + b.r) / 2 - target)) best = i;
  });
  if (Math.abs(velocity) > FLING_MIN_PX_S && best === current) return clamp(current + Math.sign(velocity), 0, rects.length - 1);
  return best;
}

function RubberSegment({ items, value, onChange, stretch = 100, squash = 3, speed = 1, glide = 75, draggable = true, className = '' }) {
  ensureStyle();
  const rootRef = useRef(null);
  const lensRef = useRef(null);
  const cellRefs = useRef([]);
  const edges = useRef(null);
  if (!edges.current) edges.current = { left: motionValue(0), right: motionValue(0) };
  const run = useRef({ anims: [], timers: [], total: 0, gesture: null, expected: null });

  const found = items.findIndex((it) => it.value === value);
  const current = found < 0 ? 0 : found;
  const live = useRef(null);
  live.current = { items, value, onChange, stretch, squash, speed, glide, draggable, current };
  const signature = items.map((it) => it.value).join('\u0000');

  const rects = () => cellRefs.current.filter(Boolean).map((el) => ({ l: el.offsetLeft, r: el.offsetLeft + el.offsetWidth }));
  const paint = () => {
    const lens = lensRef.current;
    if (!lens) return;
    lens.style.clipPath = `inset(0 ${Math.max(0, run.current.total - edges.current.right.get())}px 0 ${edges.current.left.get()}px)`;
  };
  const stopMotion = () => {
    const s = run.current;
    s.anims.forEach((a) => a.stop());
    s.anims = [];
    s.timers.forEach(clearTimeout);
    s.timers = [];
  };
  const later = (fn, ms) => {
    const s = run.current;
    const id = setTimeout(() => { s.timers = s.timers.filter((t) => t !== id); fn(); }, ms);
    s.timers.push(id);
  };
  const spring = (mv, to, duration, bounce, velocity = 0) => {
    const c = animate(mv, to, { type: 'spring', duration: duration / live.current.speed, bounce, velocity });
    run.current.anims.push(c);
    return c;
  };
  const snapTo = (i) => {
    stopMotion();
    const r = rects()[i];
    if (!r) return;
    run.current.total = Math.max(0, ...rects().map((x) => x.r));
    edges.current.left.set(r.l);
    edges.current.right.set(r.r);
    paint();
  };
  // assenta a janela no item `to`: a borda da frente chega com mola, a de trás passa `amount` px do destino e relaxa
  const settle = (to, dir, amount, velocity, duration, bounce) => {
    const r = rects()[to];
    if (!r) return;
    const { left, right } = edges.current;
    const [front, back, frontTo, backTo] = dir >= 0 ? [right, left, r.r, r.l] : [left, right, r.l, r.r];
    spring(front, frontTo, duration, bounce, velocity);
    if (amount <= 0) { spring(back, backTo, duration, bounce, velocity); return; }
    spring(back, backTo + dir * amount, duration, 0, velocity).then(() => {
      run.current.anims.push(animate(back, backTo, { duration: RELAX_S / live.current.speed, ease: 'easeOut' }));
    });
  };
  // clique: a janela cresce até cobrir origem e destino e só então a borda de trás é puxada
  const glideTo = (from, to) => {
    const rs = rects(), a = rs[from], b = rs[to];
    if (!a || !b) { snapTo(to); return; }
    stopMotion();
    const { stretch: st, squash: sq, speed: sp } = live.current;
    const k = clamp(st / 100, 0, 1);
    const grow = { duration: GROW_S / sp, ease: GROW_EASE };
    run.current.anims.push(animate(edges.current.left, lerp(b.l, Math.min(a.l, b.l), k), grow));
    run.current.anims.push(animate(edges.current.right, lerp(b.r, Math.max(a.r, b.r), k), grow));
    later(() => settle(to, to > from ? 1 : -1, sq, 0, EDGE_SPRING_S, 0), (FRONT_DELAY_S / sp) * 1000);
  };
  // pede a troca ao pai; se ele recusar (value não muda), a janela volta ao item vigente
  const commit = (i) => {
    const l = live.current;
    const next = l.items[i];
    if (!next) return;
    run.current.expected = next.value;
    l.onChange(next.value, i);
    later(() => {
      run.current.expected = null;
      if (live.current.value !== next.value) settle(live.current.current, 0, 0, 0, EDGE_SPRING_S, 0);
    }, 50);
  };

  useLayoutEffect(() => {
    const { left, right } = edges.current;
    const unsubscribe = [left.on('change', paint), right.on('change', paint)];
    return () => unsubscribe.forEach((u) => u());
  }, []);
  useLayoutEffect(() => {
    const s = run.current;
    if (s.expected === value) { s.expected = null; return; }
    if (!s.gesture?.dragging) snapTo(current);
  }, [value, signature]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let alive = true;
    const remeasure = () => { if (alive && !run.current.gesture?.dragging) snapTo(live.current.current); };
    const ro = new ResizeObserver(remeasure);
    ro.observe(root);
    document.fonts?.ready.then(remeasure);
    return () => { alive = false; ro.disconnect(); stopMotion(); };
  }, []);

  const rootLeft = () => rootRef.current.getBoundingClientRect().left;
  const finish = (el) => {
    const g = run.current.gesture;
    run.current.gesture = null;
    rootRef.current?.removeAttribute('data-drag');
    g?.item?.removeAttribute('data-pressed');
    if (el && g?.dragging && el.hasPointerCapture?.(g.id)) el.releasePointerCapture(g.id);
  };
  const onPointerDown = (e) => {
    if (e.button !== 0 || run.current.gesture) return;
    const cell = e.target.closest('[data-i]');
    if (!cell) return;
    const x = e.clientX - rootLeft();
    const { left, right } = edges.current;
    const inLens = x >= left.get() && x <= right.get();
    run.current.gesture = { id: e.pointerId, index: +cell.dataset.i, item: cell, x0: e.clientX, y0: e.clientY, inLens, dragging: false, moved: false, grab: 0, width: 0, samples: [] };
    if (!inLens && !reduced()) cell.setAttribute('data-pressed', '');
  };
  const onPointerMove = (e) => {
    const g = run.current.gesture;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x0;
    if (!g.dragging) {
      if (Math.hypot(dx, e.clientY - g.y0) > TAP_SLOP_PX) g.moved = true;
      if (!(live.current.draggable && g.inLens && Math.abs(dx) > DRAG_DEADZONE_PX)) return;
      stopMotion();
      g.dragging = true;
      g.grab = g.x0 - rootLeft() - edges.current.left.get();
      g.width = edges.current.right.get() - edges.current.left.get();
      g.item.setPointerCapture(g.id);
      rootRef.current.setAttribute('data-drag', '');
    }
    const next = edgesAt(e.clientX - rootLeft() - g.grab, g.width, run.current.total, !reduced());
    edges.current.left.set(next.left);
    edges.current.right.set(next.right);
    g.samples.push({ t: performance.now(), c: (next.left + next.right) / 2 });
  };
  const onPointerUp = (e) => {
    const g = run.current.gesture;
    if (!g || g.id !== e.pointerId) return;
    const l = live.current;
    finish(e.target);
    if (g.dragging) {
      const velocity = clamp(velocityOf(g.samples, performance.now()), -VELOCITY_CAP_PX_S, VELOCITY_CAP_PX_S);
      const rs = rects();
      const center = (edges.current.left.get() + edges.current.right.get()) / 2;
      const to = pickIndex(rs, center, velocity, l.glide, l.current);
      const fling = Math.abs(velocity) > FLING_MIN_PX_S;
      if (reduced()) snapTo(to);
      else settle(to, fling ? Math.sign(velocity) : 0, fling ? l.squash : 0, velocity, fling ? FLING_SPRING_S : EDGE_SPRING_S, fling ? FLING_BOUNCE : 0);
      if (to !== l.current) commit(to);
      return;
    }
    if (g.moved || g.index === l.current) return;
    if (reduced()) snapTo(g.index); else glideTo(l.current, g.index);
    commit(g.index);
  };
  const onPointerCancel = (e) => {
    const g = run.current.gesture;
    if (!g || g.id !== e.pointerId) return;
    finish(e.target);
    if (g.dragging) { if (reduced()) snapTo(live.current.current); else settle(live.current.current, 0, 0, 0, EDGE_SPRING_S, 0); }
  };
  const onKeyDown = (e) => {
    const last = items.length - 1;
    const to = { ArrowRight: current + 1, ArrowDown: current + 1, ArrowLeft: current - 1, ArrowUp: current - 1, Home: 0, End: last }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const i = clamp(to, 0, last);
    if (i === current) return;
    cellRefs.current[i]?.focus();
    snapTo(i);
    commit(i);
  };
  // Enter/Espaço em aba focada (clique sintético, sem ponteiro) seleciona direto
  const onClick = (e) => {
    if (e.detail !== 0) return;
    const i = +e.currentTarget.dataset.i;
    if (i === current) return;
    snapTo(i);
    commit(i);
  };

  return <div ref={rootRef} className={`rs-root ${className}`.trim()} data-draggable={draggable ? '' : undefined} onKeyDown={onKeyDown}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
    {items.map((it, i) => <button key={it.value} ref={(el) => { cellRefs.current[i] = el; }} type="button" role="tab" data-i={i}
      aria-selected={i === current} tabIndex={i === current ? 0 : -1} className="rs-cell rs-item" onClick={onClick}>{it.content}</button>)}
    <div ref={lensRef} className="rs-lens" aria-hidden="true">
      {items.map((it) => <div key={it.value} className="rs-cell">{it.content}</div>)}
    </div>
  </div>;
}

RubberSegment.edgesAt = edgesAt;
RubberSegment.velocityOf = velocityOf;
RubberSegment.pickIndex = pickIndex;

window.HadesFx = { ...window.HadesFx, RubberSegment };
})();
