/* Botão de confirmar segurando: o preenchimento sobe enquanto o gesto dura e só ao chegar ao fim a ação dispara, então um
 * toque acidental nunca confirma nada. A máquina de estados (repouso, segurando, feito) fica numa fábrica sem DOM, com relógio
 * e agendador injetados, para que os tempos se provem sem navegador; o componente só liga eventos e pinta. Sem motion:
 * o avanço é um laço de quadros que escreve direto no elemento, sem passar pelo estado do React. Exposto em
 * window.HadesFx.HoldButton; HoldConfirm (app.tsx) o usa e cai num Button comum se ele não existir. */
(() => {
const { useEffect, useId, useRef, useState } = React;

type Phase = 'idle' | 'holding' | 'done';
type GestureKind = 'pointer' | 'key';
type FillDirection = 'right' | 'up';

interface Timing { holdTime: number; releaseTime: number; resetAfter: number; disabled: boolean }
interface Env {
  now(): number;
  raf(cb: () => void): number;
  caf(id: number): void;
  after(cb: () => void, ms: number): number;
  clear(id: number): void;
}
interface Out { progress(p: number): void; phase(phase: Phase): void; hold(): void; tap(): void }
interface Size { height: number; padding: string; fontToken: string }

const TAP_MAX_MS = 250;
const DRIFT_PX = 10;
const EARLY_FRAME_GUARD_MS = 50;
const LATE_FRAME_FALLBACK_MS = 100;
const WAVE_PERIOD_MS = 1100;
const WAVE_SAMPLES = 16;
const PULSE_MS = 600;
const PULSE_SPREAD_PX = 14;
const PULSE_ALPHA_PCT = 55;
const STYLE_ID = 'hades-fx-hold-button';
const SIZES: Record<string, Size> = {
  sm: { height: 36, padding: '0 16px', fontToken: '--fs-label' },
  md: { height: 44, padding: '0 22px', fontToken: '--fs-prose' },
  lg: { height: 52, padding: '0 28px', fontToken: '--fs-section-lg' },
};

const CSS = `
.hb{--hb-glow:0;position:relative;display:inline-grid;place-items:center;box-sizing:border-box;height:var(--hb-h);padding:var(--hb-pad);
  border:0;border-radius:var(--hb-r);background:var(--hb-bg);color:var(--hb-fg);font:inherit;font-size:var(--hb-fs);font-weight:500;
  letter-spacing:.01em;white-space:nowrap;cursor:pointer;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;
  -webkit-tap-highlight-color:transparent;touch-action:manipulation;
  transition:transform 160ms cubic-bezier(.23,1,.32,1),background-color 160ms;
  box-shadow:0 10px 32px -6px color-mix(in srgb,var(--hb-fill) calc(var(--hb-glow) * 70%),transparent),inset 0 1px 0 rgb(255 255 255 / calc(var(--hb-glow) * .3))}
.hb[data-pressed]{transform:scale(var(--hb-press))}
@media (hover:hover) and (pointer:fine){.hb:not(:disabled):hover{background:color-mix(in srgb,var(--hb-bg),white 8%)}}
.hb:focus-visible{outline:2px solid var(--hb-fill);outline-offset:3px}
.hb:disabled{opacity:.5;pointer-events:none;cursor:default}
@media (prefers-contrast:more){.hb{outline:1px solid var(--hb-fg)}.hb:focus-visible{outline:2px solid var(--hb-fill)}}
.hb-c{display:grid;place-items:center}
.hb-l{grid-area:1/1;display:inline-flex;align-items:center;gap:8px;transition:opacity 200ms,filter 200ms}
.hb-l[data-off]{opacity:0;filter:blur(2px)}
.hb-fill{position:absolute;inset:0;box-sizing:border-box;padding:var(--hb-pad);display:grid;place-items:center;border-radius:inherit;
  background:var(--hb-fill);color:var(--hb-fgfill);pointer-events:none;clip-path:polygon(0 0,0 0,0 0)}
.hb-ring{position:absolute;inset:0;border-radius:inherit;pointer-events:none}
.hb-sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.hb{transition:none}.hb[data-pressed]{transform:none}.hb-l{filter:none!important}}
`;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Máquina de estados do gesto: não conhece DOM. `timing` é lido a cada uso para que as props valham ao vivo. */
function createController(timing: () => Timing, env: Env, out: Out) {
  let phase: Phase = 'idle';
  let gesture: { kind: GestureKind; startedAt: number } | null = null;
  let progress = 0;
  let anim: { kind: 'fill' | 'recede'; startedAt: number; from: number } | null = null;
  let frame: number | null = null;
  let fallback: number | null = null;
  let reset: number | null = null;

  const setProgress = (p: number) => { progress = p; out.progress(p); };
  const setPhase = (next: Phase) => { phase = next; out.phase(next); };
  const stopFrame = () => { if (frame !== null) env.caf(frame); frame = null; };
  const stopFallback = () => { if (fallback !== null) env.clear(fallback); fallback = null; };
  const stopReset = () => { if (reset !== null) env.clear(reset); reset = null; };
  const schedule = () => { if (frame === null) frame = env.raf(step); };

  function complete() {
    if (phase !== 'holding') return;
    stopFrame();
    stopFallback();
    anim = null;
    gesture = null;
    setPhase('done');
    setProgress(1);
    out.hold();
    const { resetAfter } = timing();
    if (resetAfter > 0) reset = env.after(() => { reset = null; setPhase('idle'); recede(); }, resetAfter);
  }

  function step() {
    frame = null;
    if (!anim) return;
    const { holdTime, releaseTime } = timing();
    const elapsed = env.now() - anim.startedAt;
    if (anim.kind === 'fill') {
      const p = clamp01(elapsed / Math.max(1, holdTime));
      setProgress(p);
      if (p >= 1 && elapsed >= holdTime - EARLY_FRAME_GUARD_MS) { complete(); return; }
    } else {
      const t = clamp01(elapsed / Math.max(1, releaseTime));
      setProgress(anim.from * (1 - t) ** 3);
      if (t >= 1) { anim = null; return; }
    }
    schedule();
  }

  function recede() {
    if (progress <= 0) { anim = null; return; }
    anim = { kind: 'recede', startedAt: env.now(), from: progress };
    schedule();
  }

  function start(kind: GestureKind): boolean {
    const { holdTime, disabled } = timing();
    if (disabled || phase !== 'idle' || gesture) return false;
    stopReset();
    const startedAt = env.now();
    gesture = { kind, startedAt };
    anim = { kind: 'fill', startedAt, from: 0 };
    setPhase('holding');
    schedule();
    fallback = env.after(complete, Math.max(1, holdTime) + LATE_FRAME_FALLBACK_MS);
    return true;
  }

  function finish(allowTap: boolean) {
    if (!gesture) return;
    const short = env.now() - gesture.startedAt < TAP_MAX_MS;
    gesture = null;
    stopFallback();
    setPhase('idle');
    recede();
    if (allowTap && short) out.tap();
  }

  return {
    start,
    release: () => finish(true),
    cancel: () => finish(false),
    active: (): GestureKind | null => gesture?.kind ?? null,
    dispose() { stopFrame(); stopFallback(); stopReset(); anim = null; gesture = null; },
  };
}

/** Polígono do recorte do preenchimento: a frente avança de fora a fora do botão, com crista de `amp` px quando há onda. */
function frontPolygon(p: number, width: number, height: number, direction: FillDirection, amp: number, wavePhase: number): string {
  const along = direction === 'up' ? height : width;
  const across = direction === 'up' ? width : height;
  const front = -amp + p * (along + 2 * amp);
  const pts: string[] = [];
  for (let i = 0; i <= WAVE_SAMPLES; i++) {
    const c = (across * i) / WAVE_SAMPLES;
    const d = front + amp * Math.sin((2 * Math.PI * c) / Math.max(1, across) + wavePhase);
    pts.push(direction === 'up' ? `${c}px ${height - d}px` : `${d}px ${c}px`);
  }
  return direction === 'up'
    ? `polygon(0 ${height}px,${pts.join(',')},${width}px ${height}px)`
    : `polygon(0 0,${pts.join(',')},0 ${height}px)`;
}

const holdSeconds = (ms: number) => String(Number((ms / 1000).toFixed(1))).replace('.', ',');

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const browserEnv: Env = {
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  after: (cb, ms) => window.setTimeout(cb, ms),
  clear: (id) => window.clearTimeout(id),
};

interface HoldButtonProps {
  children?: ReactNode; doneLabel?: ReactNode; icon?: ReactNode; doneIcon?: ReactNode;
  backgroundColor?: string; fillColor?: string; textColor?: string; fillTextColor?: string;
  size?: string; radius?: number; fillDirection?: string; holdTime?: number; releaseTime?: number; pressScale?: number;
  wave?: boolean; waveAmplitude?: number; glow?: boolean; resetAfter?: number; disabled?: boolean;
  className?: string; label?: string; onHold?: () => void; onTap?: () => void;
}

function HoldButton(props: HoldButtonProps) {
  ensureStyle();
  const {
    children = 'Segure para confirmar', doneLabel = 'Feito', icon = null, doneIcon = null,
    backgroundColor = '#27272a', fillColor = '#5227FF', textColor = '#f5f5f5', fillTextColor = '#ffffff',
    size = 'md', radius = 14, holdTime = 2000, pressScale = 0.97, disabled = false, className = '', label,
  } = props;
  const direction: FillDirection = props.fillDirection === 'up' ? 'up' : 'right';
  const dims = SIZES[size] ?? SIZES.md;
  const [phase, setPhase] = useState<Phase>('idle');
  const descId = useId();
  const rootRef = useRef<HTMLButtonElement | null>(null);
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const ringRef = useRef<HTMLSpanElement | null>(null);
  const ctlRef = useRef<ReturnType<typeof createController> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const gesture = useRef({ pointerId: -1, box: { left: 0, top: 0, right: 0, bottom: 0 }, width: 0, height: 0 });

  useEffect(() => {
    const paint = (p: number) => {
      const root = rootRef.current;
      const fill = fillRef.current;
      if (!root || !fill) return;
      const cur = latest.current;
      const amp = cur.wave === false ? 0 : (cur.waveAmplitude ?? 6);
      root.style.setProperty('--hb-glow', cur.glow === false ? '0' : String(p));
      if (reducedMotion()) {
        fill.style.clipPath = 'none';
        fill.style.opacity = String(p);
        return;
      }
      fill.style.opacity = '';
      const wavePhase = (2 * Math.PI * p * (cur.holdTime ?? 2000)) / WAVE_PERIOD_MS;
      fill.style.clipPath = frontPolygon(p, gesture.current.width, gesture.current.height, cur.fillDirection === 'up' ? 'up' : 'right', amp, wavePhase);
    };
    const ring = () => {
      const el = ringRef.current;
      if (latest.current.glow === false || reducedMotion() || !el || typeof el.animate !== 'function') return;
      el.animate(
        [
          { boxShadow: `0 0 0 0 color-mix(in srgb, var(--hb-fill) ${PULSE_ALPHA_PCT}%, transparent)` },
          { boxShadow: `0 0 0 ${PULSE_SPREAD_PX}px color-mix(in srgb, var(--hb-fill) 0%, transparent)` },
        ],
        { duration: PULSE_MS, easing: 'cubic-bezier(.23,1,.32,1)' },
      );
    };
    const ctl = createController(
      () => ({
        holdTime: latest.current.holdTime ?? 2000,
        releaseTime: latest.current.releaseTime ?? 200,
        resetAfter: latest.current.resetAfter ?? 1200,
        disabled: !!latest.current.disabled,
      }),
      browserEnv,
      {
        progress: paint,
        phase: (next) => {
          setPhase(next);
          if (next !== 'holding') rootRef.current?.removeAttribute('data-pressed');
        },
        hold: () => { ring(); latest.current.onHold?.(); },
        tap: () => latest.current.onTap?.(),
      },
    );
    ctlRef.current = ctl;
    const abort = () => ctl.cancel();
    const onVisibility = () => { if (document.hidden) ctl.cancel(); };
    window.addEventListener('blur', abort);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', abort);
      document.removeEventListener('visibilitychange', onVisibility);
      ctl.dispose();
      ctlRef.current = null;
    };
  }, []);

  useEffect(() => { if (disabled) ctlRef.current?.cancel(); }, [disabled]);

  const begin = (kind: GestureKind): boolean => {
    const root = rootRef.current;
    const ctl = ctlRef.current;
    if (!root || !ctl || ctl.active()) return false;
    const rect = root.getBoundingClientRect();
    gesture.current.box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    gesture.current.width = root.offsetWidth;
    gesture.current.height = root.offsetHeight;
    return ctl.start(kind);
  };
  const ownsPointer = (e: { pointerId: number }) => ctlRef.current?.active() === 'pointer' && e.pointerId === gesture.current.pointerId;

  const onPointerDown = (e: PointerEvent & { currentTarget: HTMLButtonElement }) => {
    if (e.button !== 0 || !e.isPrimary || !begin('pointer')) return;
    gesture.current.pointerId = e.pointerId;
    rootRef.current?.setAttribute('data-pressed', '');
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // sem captura o gesto segue pelos eventos do próprio botão, e a regra dos 10 px continua valendo
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!ownsPointer(e)) return;
    const { box } = gesture.current;
    const outside = e.clientX < box.left - DRIFT_PX || e.clientX > box.right + DRIFT_PX || e.clientY < box.top - DRIFT_PX || e.clientY > box.bottom + DRIFT_PX;
    if (outside) ctlRef.current?.cancel();
  };
  const onPointerUp = (e: PointerEvent) => { if (ownsPointer(e)) ctlRef.current?.release(); };
  const onPointerLeave = (e: PointerEvent) => { if (e.pointerType !== 'touch' && ownsPointer(e)) ctlRef.current?.cancel(); };
  const onPointerAbort = (e: PointerEvent) => { if (ownsPointer(e)) ctlRef.current?.cancel(); };

  const isActivationKey = (key: string) => key === ' ' || key === 'Enter';
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { if (ctlRef.current?.active() === 'key') ctlRef.current.cancel(); return; }
    if (!isActivationKey(e.key)) return;
    e.preventDefault();
    if (!e.repeat) begin('key');
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (!isActivationKey(e.key)) return;
    e.preventDefault();
    if (ctlRef.current?.active() === 'key') ctlRef.current.release();
  };
  const onBlur = () => { if (ctlRef.current?.active() === 'key') ctlRef.current.cancel(); };

  const resting = phase !== 'done';
  const labels = (decorative: boolean) => <span className="hb-c">
    <span className="hb-l" data-off={resting ? undefined : ''} aria-hidden={decorative || !resting ? 'true' : undefined}>{icon}{children}</span>
    <span className="hb-l" data-off={resting ? '' : undefined} aria-hidden={decorative || resting ? 'true' : undefined}>{doneIcon}{doneLabel}</span>
  </span>;

  return <button
    ref={rootRef}
    type="button"
    className={`hb ${className}`.trim()}
    disabled={disabled}
    aria-label={label}
    aria-describedby={descId}
    style={{
      '--hb-bg': backgroundColor, '--hb-fill': fillColor, '--hb-fg': textColor, '--hb-fgfill': fillTextColor,
      '--hb-h': `${dims.height}px`, '--hb-pad': dims.padding, '--hb-fs': `var(${dims.fontToken})`,
      '--hb-r': `${radius}px`, '--hb-press': pressScale,
    }}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerLeave={onPointerLeave}
    onPointerCancel={onPointerAbort}
    onLostPointerCapture={onPointerAbort}
    onContextMenu={(e: Event) => e.preventDefault()}
    onKeyDown={onKeyDown}
    onKeyUp={onKeyUp}
    onBlur={onBlur}
  >
    {labels(false)}
    <span ref={fillRef} className="hb-fill" aria-hidden="true">{labels(true)}</span>
    <span ref={ringRef} className="hb-ring" aria-hidden="true" />
    <span id={descId} className="hb-sr">{`Mantenha pressionado por ${holdSeconds(holdTime)} s para confirmar`}</span>
  </button>;
}

HoldButton.createController = createController;
HoldButton.frontPolygon = frontPolygon;
HoldButton.holdSeconds = holdSeconds;

window.HadesFx = { ...window.HadesFx, HoldButton };
})();
