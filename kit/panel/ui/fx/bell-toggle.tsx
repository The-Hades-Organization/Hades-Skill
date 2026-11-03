/* Liga/desliga em pílula com sino: os dois rótulos trocam por fusão, a largura acompanha o rótulo do estado (mola de 0,3 s
 * quando é o usuário quem muda) e o sino balança ao ligar, com arcos de som e selo de contagem opcionais. Estado
 * controlado (pressed) ou não (defaultPressed). Exposto em window.HadesFx.BellToggle, carregado sob demanda pelo lazy. */
(() => {
const { useRef, useState, useEffect, useLayoutEffect } = React;
const { animate, motionValue } = window.HadesFx.motion;

const STYLE_ID = 'hades-fx-bell-toggle';
const PRESS_SCALE = 0.97;
const BLUR_PX = 2;
const REVEAL_S = 0.3;
const USER_CLICK_WINDOW_MS = 500;
const RING_EASE = 'cubic-bezier(.77,0,.175,1)';
const RING_SQUEEZE = 1.15;
const CLAPPER_DELAY_MS = 70;
const CLAPPER_GAIN = 1.6;
const WAVE_MS = 380;
const WAVE_PEAK = 0.9;
const WAVE_PEAK_AT = 0.3;
const BUMP = { amplitudeShare: 0.4, passes: 3, duration: 420 };
const BADGE_IN_MS = 280;
const BADGE_OUT_MS = 180;
const BADGE_FADE_MS = 120;
const BADGE_REDUCED_MS = 140;
const COUNT_IN_MS = 200;
const BADGE_MAX = 9;
const BADGE_RISE_PX = 5;
const OUT_STRONG = 'cubic-bezier(.23,1,.32,1)';

// altura, fonte, ícone, padding lateral e lacuna ícone-texto de cada tamanho (px)
const SIZES = {
  sm: { h: 36, font: 12.5, icon: 14, pad: 15, gap: 8 },
  md: { h: 44, font: 13.5, icon: 16, pad: 19, gap: 9 },
  lg: { h: 52, font: 15, icon: 18, pad: 23, gap: 10 },
};

const CSS = `
.bt-root{position:relative;display:inline-block;flex:none;overflow:hidden;appearance:none;border:0;margin:0;padding:0;font:inherit;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;background:var(--bt-bg);color:var(--bt-fg);outline:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:background-color 200ms,color 200ms,transform 160ms ${OUT_STRONG}}
.bt-root:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.bt-root:disabled{opacity:.55;cursor:default}
.bt-root[data-pressed]{transform:scale(${PRESS_SCALE})}
.bt-inner{display:flex;align-items:center;width:max-content;height:100%}
.bt-icon{position:relative;flex:none;display:grid;place-items:center}
.bt-bell{display:grid;place-items:center}
.bt-bell svg{display:block}
.bt-labels{display:grid}
.bt-label{grid-area:1/1;justify-self:start;width:max-content;transition:opacity var(--bt-fade),filter var(--bt-fade)}
.bt-label[data-on=false]{opacity:0;filter:blur(${BLUR_PX}px)}
.bt-wave{position:absolute;top:50%;width:8px;height:20px;margin-top:-10px;opacity:0;pointer-events:none}
.bt-wave[data-side=l]{right:100%;margin-right:2px}
.bt-wave[data-side=r]{left:100%;margin-left:2px;transform:scaleX(-1)}
.bt-badge{position:absolute;top:-5px;right:-7px;min-width:14px;height:14px;padding:0 4px;box-sizing:border-box;border-radius:7px;display:grid;place-items:center;font-size:var(--fs-micro);font-weight:600;line-height:14px;background:var(--bt-badge);color:var(--bt-badge-fg);font-variant-numeric:tabular-nums}
@media (hover:hover) and (pointer:fine){.bt-root:not(:disabled):hover{background:color-mix(in oklch,var(--bt-fg) 6%,var(--bt-bg))}}
@media (prefers-reduced-motion:reduce){.bt-root{transition:background-color 200ms,color 200ms}.bt-label[data-on=false]{filter:none}}
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Ângulos de cada passagem do sino: sinais alternados (a primeira para o lado negativo) e amplitude decrescente. */
function ringAngles(amplitude, passes, decay) {
  return Array.from({ length: passes }, (_, k) => (k % 2 === 0 ? -1 : 1) * amplitude * Math.pow(1 - k / passes, decay));
}

/** Instante (0–1) de cada passagem; as últimas se aproximam, e o retorno a 0° fecha em 1. */
function ringOffsets(passes) {
  return Array.from({ length: passes }, (_, k) => 1 - Math.pow(1 - (k + 1) / (passes + 1), RING_SQUEEZE));
}

const rotation = (el) => {
  const m = new DOMMatrix(getComputedStyle(el).transform);
  return (Math.atan2(m.b, m.a) * 180) / Math.PI;
};

function BellToggle({
  offLabel = 'Avisar-me', onLabel = 'Você será avisado', icon, label, color = '#f5f5f5', background = '#27272a',
  onColor = '#18181b', onBackground = '#f5f5f5', size = 'md', radius = 22, crossfadeMs = 200,
  ringAmplitude = 17, ringPasses = 5, ringDecay = 1, ringDuration = 820, ringPivot = 16, revealBounce = 0,
  count = 0, badge = true, badgeColor = '#ef4444', badgeTextColor = '#ffffff', waves = true, clapper = false,
  pressed, defaultPressed = false, onChange, disabled = false, className = '',
}) {
  ensureStyle();
  const dim = SIZES[size] || SIZES.md;
  const controlled = pressed !== undefined;
  const [inner, setInner] = useState(defaultPressed);
  const on = controlled ? !!pressed : inner;

  const rootRef = useRef(null);
  const bellRef = useRef(null);
  const clapperRef = useRef(null);
  const waveRefs = useRef({ l: null, r: null });
  const labelRefs = useRef({ off: null, on: null });
  const badgeRef = useRef(null);
  const countRef = useRef(null);
  const width = useRef(null);
  if (!width.current) width.current = motionValue(0);
  const widths = useRef({ off: 0, on: 0 });
  const anims = useRef({ bell: [], waves: [], width: null });
  const userAt = useRef(-Infinity);
  const prevOn = useRef(null);
  const prevCount = useRef(count);
  const mounted = useRef(false);
  const live = useRef(null);
  live.current = { ringAmplitude, ringPasses, ringDecay, ringDuration, ringPivot, revealBounce, waves, clapper, dim, on };

  const [present, setPresent] = useState(false);
  const shown = on && badge && count > 0;
  const lastCount = useRef(count);
  if (count > 0) lastCount.current = count;

  const widthOf = (state) => dim.pad * 2 + dim.icon + dim.gap + widths.current[state ? 'on' : 'off'];
  const snapWidth = () => {
    anims.current.width?.stop();
    if (widths.current.off) width.current.set(widthOf(live.current.on));
  };
  const measure = () => {
    const { off, on: onEl } = labelRefs.current;
    if (!off || !onEl) return;
    widths.current = { off: off.offsetWidth, on: onEl.offsetWidth };
    snapWidth();
  };

  const stopRing = () => {
    anims.current.bell.forEach((a) => a.cancel());
    anims.current.waves.forEach((a) => a.cancel());
    anims.current.bell = [];
    anims.current.waves = [];
  };
  // balanço do sino a partir do ângulo em que ele estiver; `share` escala amplitude e força dos arcos
  const ring = (share, passes, duration) => {
    const p = live.current;
    const bell = bellRef.current;
    if (!bell || reduced()) return;
    const from = rotation(bell);
    stopRing();
    const angles = ringAngles(p.ringAmplitude * share, passes, p.ringDecay);
    const offsets = ringOffsets(passes);
    const frames = (gain, start) => [
      { transform: `rotate(${start}deg)`, offset: 0, easing: RING_EASE },
      ...angles.map((a, k) => ({ transform: `rotate(${a * gain}deg)`, offset: offsets[k], easing: RING_EASE })),
      { transform: 'rotate(0deg)', offset: 1 },
    ];
    anims.current.bell.push(bell.animate(frames(1, from), { duration }));
    if (p.clapper && clapperRef.current) {
      anims.current.bell.push(clapperRef.current.animate(frames(CLAPPER_GAIN, from * CLAPPER_GAIN), { duration, delay: CLAPPER_DELAY_MS }));
    }
    if (!p.waves) return;
    angles.forEach((_, k) => {
      const el = waveRefs.current[k % 2 === 0 ? 'l' : 'r'];
      if (!el) return;
      const peak = WAVE_PEAK * Math.pow(1 - k / passes, p.ringDecay);
      const base = el.dataset.side === 'r' ? 'scaleX(-1) ' : '';
      anims.current.waves.push(el.animate([
        { opacity: 0, transform: `${base}scale(.55)` },
        { opacity: peak, transform: `${base}scale(.85)`, offset: WAVE_PEAK_AT },
        { opacity: 0, transform: `${base}scale(1.25)` },
      ], { duration: WAVE_MS, delay: offsets[k] * duration, easing: 'ease-out', fill: 'backwards' }));
    });
  };

  useLayoutEffect(() => {
    const unsubscribe = width.current.on('change', (v) => { if (rootRef.current) rootRef.current.style.width = `${v}px`; });
    return unsubscribe;
  }, []);
  useLayoutEffect(() => {
    measure();
    const root = rootRef.current;
    if (!root) return undefined;
    let alive = true;
    const again = () => { if (alive) measure(); };
    const ro = new ResizeObserver(again);
    ro.observe(labelRefs.current.off);
    ro.observe(labelRefs.current.on);
    document.fonts?.ready.then(again);
    return () => { alive = false; ro.disconnect(); };
  }, [offLabel, onLabel, size]);
  // mudança do usuário: mola na largura e balanço ao ligar; mudança vinda de fora: direto
  useLayoutEffect(() => {
    const first = prevOn.current === null;
    const changed = !first && prevOn.current !== on;
    prevOn.current = on;
    if (!changed) { snapWidth(); return; }
    const byUser = performance.now() - userAt.current < USER_CLICK_WINDOW_MS;
    if (!byUser || reduced() || !widths.current.off) { snapWidth(); return; }
    anims.current.width?.stop();
    anims.current.width = animate(width.current, widthOf(on), { type: 'spring', duration: REVEAL_S, bounce: live.current.revealBounce });
    if (on) ring(1, live.current.ringPasses, live.current.ringDuration);
  }, [on]);

  // selo de contagem: entra subindo, sai em 180 ms; o número novo sobe com fusão
  useEffect(() => {
    if (shown) setPresent(true);
    const el = badgeRef.current;
    if (!el || !mounted.current) return undefined;
    if (shown) {
      if (reduced()) { const a = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: BADGE_REDUCED_MS }); return () => a.cancel(); }
      const a = [
        el.animate([{ transform: `translateY(${BADGE_RISE_PX}px) scale(.6)` }, { transform: 'none' }], { duration: BADGE_IN_MS, easing: OUT_STRONG }),
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: BADGE_FADE_MS }),
      ];
      return () => a.forEach((x) => x.cancel());
    }
    return undefined;
  }, [shown]);
  useEffect(() => {
    if (shown || !present) return undefined;
    const el = badgeRef.current;
    if (!el) { setPresent(false); return undefined; }
    const out = reduced() ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${BADGE_RISE_PX}px) scale(.6)` }];
    const a = el.animate(out, { duration: reduced() ? BADGE_REDUCED_MS : BADGE_OUT_MS, fill: 'forwards' });
    a.onfinish = () => setPresent(false);
    return () => a.cancel();
  }, [shown, present]);
  useEffect(() => {
    const before = prevCount.current;
    prevCount.current = count;
    if (before === count || !mounted.current) return;
    const el = countRef.current;
    if (el && shown) el.animate(reduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateY(${BADGE_RISE_PX}px)` }, { opacity: 1, transform: 'none' }], { duration: COUNT_IN_MS });
    if (count > before && on) ring(BUMP.amplitudeShare, BUMP.passes, BUMP.duration);
  }, [count]);
  useEffect(() => {
    mounted.current = true;
    return () => { stopRing(); anims.current.width?.stop(); };
  }, []);

  const press = (e) => { if (e.button === 0 && !disabled && !reduced()) e.currentTarget.setAttribute('data-pressed', ''); };
  const release = (e) => e.currentTarget.removeAttribute('data-pressed');
  const click = () => {
    const next = !on;
    userAt.current = performance.now();
    if (!controlled) setInner(next);
    if (onChange) onChange(next);
  };

  const Bell = LucideReact.Bell;
  const glyph = icon || (clapper ? null : Bell ? <Bell size={dim.icon} strokeWidth={2} /> : null);
  const drawn = clapper && !icon
    ? <svg width={dim.icon} height={dim.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <circle ref={clapperRef} cx="12" cy="20.5" r="1.6" fill="currentColor" stroke="none" style={{ transformOrigin: '12px 4px' }} />
    </svg>
    : glyph;
  const arcs = <svg width="8" height="20" viewBox="0 0 8 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M6 5.5Q3 10 6 14.5" /><path d="M3 2.5Q-1.5 10 3 17.5" />
  </svg>;
  const shownCount = lastCount.current > BADGE_MAX ? `${BADGE_MAX}+` : String(lastCount.current);

  return <button ref={rootRef} type="button" className={`bt-root ${className}`.trim()} aria-pressed={on} aria-label={label || offLabel} disabled={disabled}
    onClick={click} onPointerDown={press} onPointerUp={release} onPointerLeave={release} onPointerCancel={release}
    style={{
      height: dim.h, fontSize: dim.font, borderRadius: radius, '--bt-bg': on ? onBackground : background, '--bt-fg': on ? onColor : color,
      '--bt-fade': `${crossfadeMs}ms`, '--bt-badge': badgeColor, '--bt-badge-fg': badgeTextColor,
    }}>
    <span className="bt-inner" style={{ padding: `0 ${dim.pad}px`, gap: dim.gap, boxSizing: 'content-box' }}>
      <span className="bt-icon" aria-hidden="true" style={{ width: dim.icon, height: dim.icon }}>
        <span ref={bellRef} className="bt-bell" style={{ transformOrigin: `50% ${ringPivot}%` }}>{drawn}</span>
        {waves ? <>
          <span ref={(el) => { waveRefs.current.l = el; }} className="bt-wave" data-side="l">{arcs}</span>
          <span ref={(el) => { waveRefs.current.r = el; }} className="bt-wave" data-side="r">{arcs}</span>
        </> : null}
        {shown || present ? <span ref={badgeRef} className="bt-badge"><span ref={countRef}>{shownCount}</span></span> : null}
      </span>
      <span className="bt-labels" aria-hidden="true">
        <span ref={(el) => { labelRefs.current.off = el; }} className="bt-label" data-on={!on}>{offLabel}</span>
        <span ref={(el) => { labelRefs.current.on = el; }} className="bt-label" data-on={on}>{onLabel}</span>
      </span>
    </span>
  </button>;
}

BellToggle.ringAngles = ringAngles;
BellToggle.ringOffsets = ringOffsets;

window.HadesFx = { ...window.HadesFx, BellToggle };
})();
