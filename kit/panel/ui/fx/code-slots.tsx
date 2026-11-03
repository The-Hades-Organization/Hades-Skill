/* Casas de código: uma fileira de casas para códigos de uma vez só, segredos somente leitura e senhas curtas. Um único campo
 * invisível recebe foco, teclado, colagem e preenchimento automático; as casas só mostram o estado. Molas e valores animados
 * vêm do motion (window.HadesFx.motion, baixado antes pelo lazy). Exposto em window.HadesFx.CodeSlots; a lógica das casas
 * (limpeza, inserção, apagar, clique) sai como funções puras em CodeSlots.logic. */
(() => {
const { useState, useRef, useEffect, useLayoutEffect } = React;

let nextId = 0;
const STYLE_ID = 'hades-fx-code-slots';
const HEIGHT_RATIO = 1.18;
const CARET_WIDTH = 1.5;
const CARET_HEIGHT_RATIO = 0.5;
const BG_MS = 200;
const BG_MS_REDUCED = 150;
const ERROR_TINT = 20;       // % da cor de perigo no fundo das casas
const ACTIVE_TINT = 8;       // % da cor de tinta na casa ativa
const HOVER_TINT = 4;
const REDUCED_DRAIN_MS = 300;
const WASH_S = 0.3;
const SINK_START_S = 0.06;
const SINK_STEP_S = 0.03;
const SINK_RATIO = 0.5;      // quanto do alto da casa o caractere afunda em sucesso
const CHECK_DELAY_S = 0.28;
const CHECK_SPRING_S = 0.35;
const CHECK_RISE = 8;
const CHECK_RATIO = 0.6;
const FADE_S = 0.15;
const MASK_CHAR = '•';
const SUCCESS_TEXT = 'Código aceito';

type Charset = 'digits' | 'text';
type Status = 'idle' | 'success' | 'error';
type Slots = string[];

// ------------------------------------------------------------------ lógica pura
const clean = (raw: string, charset: Charset): string => String(raw ?? '').replace(charset === 'digits' ? /\D/g : /\s/g, '');
const joinSlots = (slots: Slots): string => slots.join('');
const firstEmpty = (slots: Slots): number => { const i = slots.indexOf(''); return i < 0 ? slots.length - 1 : i; };
const isFull = (slots: Slots): boolean => slots.length > 0 && slots.every((c) => c !== '');
const fit = (text: string, length: number): Slots => Array.from({ length }, (_, i) => Array.from(text)[i] ?? '');

/** Insere os caracteres a partir de `index`, cortando no fim; a casa ativa avança e nunca passa da última. */
function insertAt(slots: Slots, index: number, chars: string[]): { slots: Slots; active: number } {
  const next = slots.slice();
  let placed = 0;
  for (const ch of chars) {
    if (index + placed >= next.length) break;
    next[index + placed] = ch;
    placed += 1;
  }
  return { slots: next, active: Math.min(index + placed, next.length - 1) };
}

/** Backspace: apaga a ativa se tiver conteúdo; vazia, volta uma casa e apaga a anterior. */
function backspace(slots: Slots, active: number): { slots: Slots; active: number } {
  const next = slots.slice();
  if (next[active] !== '') { next[active] = ''; return { slots: next, active }; }
  if (active === 0) return { slots: next, active };
  next[active - 1] = '';
  return { slots: next, active: active - 1 };
}

function removeAt(slots: Slots, active: number): Slots {
  const next = slots.slice();
  next[active] = '';
  return next;
}

/** O clique ativa a casa sob o ponteiro, mas nunca além da primeira vazia. */
const clickTarget = (slots: Slots, wanted: number): number => {
  const empty = slots.indexOf('');
  const limit = empty < 0 ? slots.length - 1 : empty;
  return Math.max(0, Math.min(wanted, limit));
};

/** Texto de entrada de um evento de digitação: um caractere insere na ativa; vários (preenchimento automático) recomeçam da 0. */
function applyTyped(slots: Slots, active: number, typed: string, charset: Charset): { slots: Slots; active: number } | null {
  const chars = Array.from(clean(typed, charset));
  if (chars.length === 0) return null;
  if (chars.length === 1) return insertAt(slots, active, chars);
  return insertAt(slots.map(() => ''), 0, chars);
}

const logic = { clean, joinSlots, firstEmpty, fit, isFull, insertAt, backspace, removeAt, clickTarget, applyTyped };

// ------------------------------------------------------------------ ambiente
const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
const motion = () => window.HadesFx.motion;
const spring = (duration: number, bounce: number, delay = 0) => ({ type: 'spring', duration, bounce, delay });
const tween = (duration: number, delay = 0) => ({ duration, delay, ease: 'easeOut' });

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
.hfx-cs{position:relative;display:inline-flex;vertical-align:top;font-variant-numeric:tabular-nums;-webkit-tap-highlight-color:transparent}
.hfx-cs:has(input:focus-visible){outline:2px solid var(--ring);outline-offset:2px}
.hfx-cs-slot{position:relative;display:grid;place-items:center;flex:none;font-weight:600;line-height:1;background:var(--bg);transition:background-color var(--bg-ms) ease}
.hfx-cs[data-hover] .hfx-cs-slot:not([data-active]):hover{background:var(--bg-hover)}
.hfx-cs-slot[data-active]{background:var(--bg-active)}
.hfx-cs-fill{position:absolute;inset:0;border-radius:inherit;transform:scale(0);pointer-events:none}
.hfx-cs-char{position:relative;opacity:0;pointer-events:none;color:var(--ch)}
.hfx-cs-wash{position:absolute;inset:0;pointer-events:none;transform:scaleX(0);opacity:0}
.hfx-cs-check{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;opacity:0}
.hfx-cs-caret{position:absolute;top:50%;pointer-events:none;border-radius:1px;animation:hfx-cs-blink 1s steps(1) infinite}
.hfx-cs-caret[data-still]{animation:none}
.hfx-cs-input{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;outline:0;background:transparent;opacity:0;color:transparent;caret-color:transparent;font-size:16px}
.hfx-cs-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@keyframes hfx-cs-blink{0%,49.9%{opacity:1}50%,100%{opacity:0}}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ uma casa
function Slot({ char, active, success, status, index, delays, o }) {
  const fill = useRef<HTMLElement | null>(null);
  const glyph = useRef<HTMLElement | null>(null);
  const last = useRef('');
  const mounted = useRef(false);
  const running = useRef<{ stop(): void }[]>([]);
  const filled = char !== '';
  if (filled) last.current = char;
  const height = Math.round(o.slotSize * HEIGHT_RATIO);

  useLayoutEffect(() => {
    const f = fill.current, g = glyph.current;
    if (!f || !g) return undefined;
    running.current.forEach((c) => c.stop());
    running.current = [];
    const hiddenY = success ? Math.round(height * SINK_RATIO) : o.rise;
    const shown = filled && !success;
    const target = { scale: filled ? 1 : 0, opacity: shown ? 1 : 0, y: shown ? 0 : hiddenY };
    const paint = () => {
      f.style.transform = `scale(${target.scale})`;
      g.style.opacity = String(target.opacity);
      g.style.transform = `translateY(${target.y}px)`;
    };
    if (!mounted.current || o.instant || reduced()) { mounted.current = true; paint(); return undefined; }
    const { animate } = motion();
    const delay = success ? SINK_START_S + index * SINK_STEP_S : (delays.current[index] || 0) / 1000;
    const settle = success ? spring(o.settle, 0, delay) : spring(o.settle, o.bounce, delay);
    const cs = [
      animate(f, { scale: target.scale }, settle),
      animate(g, { y: target.y }, spring(o.settle, 0, delay)),
      animate(g, { opacity: target.opacity }, tween(success ? o.settle * 0.6 : o.settle * 0.5, delay)),
    ];
    running.current = cs;
    return () => cs.forEach((c) => c.stop());
  }, [filled, success]);

  const bg = status === 'error' ? `color-mix(in oklab, ${o.slotColor}, ${o.dangerColor} ${ERROR_TINT}%)` : o.slotColor;
  const tint = (pct: number) => `color-mix(in oklab, ${bg}, ${o.inkColor} ${pct}%)`;
  return <span className="hfx-cs-slot" data-active={active ? '' : undefined}
    style={{ width: o.slotSize, height, borderRadius: o.radius, fontSize: Math.round(o.slotSize / 2), '--bg': bg, '--bg-active': tint(ACTIVE_TINT), '--bg-hover': tint(HOVER_TINT), '--bg-ms': (reduced() ? BG_MS_REDUCED : BG_MS) + 'ms', '--ch': o.digitColor }}>
    <span ref={fill} className="hfx-cs-fill" aria-hidden="true" style={{ background: status === 'error' ? o.dangerColor : o.accentColor }} />
    <span ref={glyph} className="hfx-cs-char" aria-hidden="true">{o.mask ? MASK_CHAR : last.current}</span>
  </span>;
}

// ------------------------------------------------------------------ componente
function CodeSlots(props) {
  const {
    length = 6, charset = 'digits', value, defaultValue = '', onChange, onComplete, status = 'idle', mask = false, caret = true,
    disabled = false, autoFocus = false, accentColor = '#f5f5f5', inkColor = '#f5f5f5', slotColor = '#27272a', digitColor = '#18181b',
    dangerColor = '#ff3b30', slotSize = 44, gap = 8, radius = 12, bounce = 0.2, settle = 0.3, rise = 8, cascade = 20,
    ariaLabel = 'One-time code', className = '',
  } = props;
  const [slots, setSlots] = useState<Slots>(() => fit(clean(value ?? defaultValue, charset), length));
  const [active, setActive] = useState(() => firstEmpty(slots));
  const [focused, setFocused] = useState(false);
  const [slide, setSlide] = useState(false);
  const [draining, setDraining] = useState(false);
  const delays = useRef<number[]>([]);
  const latest = useRef({ onChange, onComplete });
  latest.current = { onChange, onComplete };
  const wasFull = useRef(isFull(slots));
  const lastEmitted = useRef(joinSlots(slots));
  const input = useRef<HTMLInputElement | null>(null);
  const row = useRef<HTMLElement | null>(null);
  const wash = useRef<HTMLElement | null>(null);
  const check = useRef<HTMLElement | null>(null);
  const washed = useRef(false);
  const liveId = useRef(`hfx-cs-live-${nextId += 1}`);
  const success = status === 'success';
  const busy = disabled || success || draining;
  const view = Array.from({ length }, (_, i) => slots[i] ?? '');
  const o = { slotSize, radius: Math.min(radius, slotSize / 2), accentColor, slotColor, digitColor, dangerColor, inkColor, bounce, settle, rise, mask, instant: success };

  injectStyle();

  const cascadeIn = (from: Slots, to: Slots) => {
    const d: number[] = [];
    let up = 0;
    const gone = to.map((c, i) => (c === '' && from[i] !== '' ? i : -1)).filter((i) => i >= 0);
    to.forEach((c, i) => { if (c !== '' && c !== from[i]) { d[i] = up * cascade; up += 1; } });
    gone.reverse().forEach((i, k) => { d[i] = k * cascade; });
    delays.current = d;
  };

  const settleChange = (next: Slots, nextActive: number, emit: boolean) => {
    const code = joinSlots(next);
    setSlots(next);
    setActive(nextActive);
    lastEmitted.current = code;
    if (emit) latest.current.onChange?.(code);
    const full = isFull(next);
    if (full && !wasFull.current) latest.current.onComplete?.(code);
    wasFull.current = full;
  };

  const edit = (result: { slots: Slots; active: number } | null, glide: boolean) => {
    if (!result) return;
    cascadeIn(view, result.slots);
    setSlide(glide);
    settleChange(result.slots, result.active, true);
  };

  // valor externo (modo controlado) e mudança de length
  useEffect(() => {
    if (value === undefined) return;
    const next = fit(clean(value, charset), length);
    if (joinSlots(next) === lastEmitted.current && slots.length === length) return;
    cascadeIn(view, next);
    setSlide(true);
    settleChange(next, firstEmpty(next), false);
  }, [value, length, charset]);
  useEffect(() => {
    if (slots.length === length) return;
    const next = fit(joinSlots(slots), length);
    const changed = joinSlots(next) !== joinSlots(slots);
    settleChange(next, firstEmpty(next), changed);
  }, [length]);

  // erro: os caracteres saem de trás para frente e o código é limpo
  useEffect(() => {
    if (status !== 'error') return undefined;
    const count = view.filter((c) => c !== '').length;
    if (count === 0) return undefined;
    const d: number[] = [];
    let k = 0;
    for (let i = view.length - 1; i >= 0; i -= 1) if (view[i] !== '') { d[i] = k * cascade; k += 1; }
    delays.current = d;
    setDraining(true);
    setSlide(false);
    const ms = reduced() ? REDUCED_DRAIN_MS : (count - 1) * cascade + settle * 1000;
    const empty = fit('', length);
    setSlots(empty);
    const id = setTimeout(() => { setDraining(false); settleChange(empty, 0, true); }, ms);
    return () => { clearTimeout(id); setDraining(false); };
  }, [status]);

  // sucesso: lavagem do centro para as pontas e o ✓
  useLayoutEffect(() => {
    const w = wash.current, c = check.current;
    if (!w || !c) return undefined;
    if (!washed.current && !success) return undefined;
    washed.current = true;
    const instant = reduced();
    if (instant) {
      w.style.transform = 'scaleX(1)'; w.style.opacity = success ? '1' : '0';
      c.style.opacity = success ? '1' : '0'; c.style.transform = 'none';
      if (!success) w.style.transform = 'scaleX(0)';
      return undefined;
    }
    const { animate } = motion();
    const cs = success
      ? [animate(w, { scaleX: 1, opacity: 1 }, { duration: WASH_S, ease: [0.23, 1, 0.32, 1] }),
        animate(c, { opacity: [0, 1], y: [CHECK_RISE, 0], scale: [0.85, 1] }, { ...spring(CHECK_SPRING_S, bounce, CHECK_DELAY_S), opacity: tween(FADE_S, CHECK_DELAY_S) })]
      : [animate(c, { opacity: 0 }, tween(FADE_S)),
        animate(w, { scaleX: 0 }, { duration: 0.2, delay: 0.06, ease: 'easeIn' }),
        animate(w, { opacity: 0 }, { duration: 0.01, delay: 0.26 })];
    return () => cs.forEach((x) => x.stop());
  }, [success]);

  useEffect(() => { if (autoFocus) input.current?.focus(); }, []);

  // ---- entrada
  const onInput = (e) => {
    const typed = e.target.value;
    e.target.value = '';
    if (busy) return;
    edit(applyTyped(view, active, typed, charset), true);
  };
  const onKeyDown = (e) => {
    if (busy || e.ctrlKey || e.metaKey || e.altKey) return;
    const jump = (to: number) => { e.preventDefault(); setSlide(false); setActive(Math.max(0, Math.min(to, length - 1))); };
    if (e.key === 'Backspace') { e.preventDefault(); edit(backspace(view, active), true); }
    else if (e.key === 'Delete') { e.preventDefault(); edit({ slots: removeAt(view, active), active }, true); }
    else if (e.key === 'ArrowLeft') jump(active - 1);
    else if (e.key === 'ArrowRight') jump(active + 1);
    else if (e.key === 'Home') jump(0);
    else if (e.key === 'End') jump(length - 1);
  };
  const onPaste = (e) => {
    e.preventDefault();
    if (busy) return;
    const chars = Array.from(clean(e.clipboardData?.getData('text') ?? '', charset));
    if (chars.length) edit(insertAt(view, active, chars), true);
  };
  const onPointerDown = (e) => {
    if (disabled || !row.current) return;
    const box = row.current.getBoundingClientRect();
    const scale = box.width / row.current.offsetWidth || 1;
    const wanted = Math.floor((e.clientX - box.left) / scale / (slotSize + gap));
    setSlide(false);
    setActive(clickTarget(view, wanted));
    input.current?.focus();
  };

  const width = length * slotSize + (length - 1) * gap;
  const height = Math.round(slotSize * HEIGHT_RATIO);
  const filledCount = view.filter((c) => c !== '').length;
  const caretShown = focused && caret && !disabled && !success && (status === 'error' || view[active] === '');
  const CheckIcon = LucideReact.Check;
  const checkSize = Math.round(slotSize * CHECK_RATIO);
  const washer = { left: 0, top: 0, width, height, borderRadius: Math.min(radius, slotSize / 2), background: accentColor };
  return <span ref={row} className={`hfx-cs ${className}`.trim()} data-hover={status === 'idle' && !disabled ? '' : undefined}
    style={{ width, height, gap, cursor: disabled ? 'default' : 'text' }} onPointerDown={onPointerDown}>
    <span style={{ display: 'flex', gap }} aria-hidden="true">
      {view.map((char, i) => <Slot key={i} index={i} char={char} active={focused && i === active} success={success} status={status} delays={delays} o={o} />)}
    </span>
    <span ref={wash} className="hfx-cs-wash" aria-hidden="true" style={washer} />
    <span ref={check} className="hfx-cs-check" aria-hidden="true" style={{ color: digitColor }}>
      {CheckIcon ? <CheckIcon size={checkSize} strokeWidth={2.2} /> : null}
    </span>
    <span className="hfx-cs-caret" aria-hidden="true" data-still={reduced() ? '' : undefined}
      style={{ display: caretShown ? 'block' : 'none', width: CARET_WIDTH, height: height * CARET_HEIGHT_RATIO, marginTop: -(height * CARET_HEIGHT_RATIO) / 2,
        left: Math.min(active, length - 1) * (slotSize + gap) + (slotSize - CARET_WIDTH) / 2, background: inkColor,
        transition: slide && !reduced() ? `left ${settle}s ease-out` : 'none' }} />
    <input ref={input} className="hfx-cs-input" type="text" inputMode={charset === 'digits' ? 'numeric' : 'text'} autoComplete="one-time-code"
      maxLength={length} readOnly={busy} value="" aria-label={ariaLabel} aria-invalid={status === 'error' ? true : undefined} aria-describedby={liveId.current}
      onChange={onInput} onKeyDown={onKeyDown} onPaste={onPaste} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
    <span id={liveId.current} className="hfx-cs-live" aria-live="polite">{success ? SUCCESS_TEXT : `${filledCount} de ${length} dígitos preenchidos`}</span>
  </span>;
}

CodeSlots.logic = logic;
window.HadesFx = { ...window.HadesFx, CodeSlots };
})();
