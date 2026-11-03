/* Barra de envio do painel: campo de texto que cresce com o conteúdo, botão enviar/parar que se transforma de uma forma na
 * outra, menus "@" (fontes) e "/" (comandos), seletor de modelo, régua de esforço, anexos e ditado. No esforço máximo, partículas
 * luminosas sobem atrás do conteúdo e reagem à digitação. Cores chegam por prop (qualquer cor CSS, inclusive var()).
 * Exposto em window.HadesFx.PromptBar; as regras sem DOM (gatilho, filtro, escolha, tecla) vão em PromptBar.logic. */
(() => {
const { useState, useEffect, useRef, useId, createElement: h } = React;
const { animate, useReducedMotion } = window.HadesFx.motion;

// ---------- constantes de medida e tempo ----------
const ROW_H = 36;
const LINE_H = 22;
const SEND_SIZE = 28;
const MORPH_EASE = [0.77, 0, 0.175, 1];
const STYLE_ID = 'hades-fx-prompt-bar';
const EFFORT_W = 248;
const SLIDER_MARGIN = 11;
const CURSOR_W = 14;
const MODEL_MENU_W = 200;
const SPARK_MAX = 30;
const SPARK_BURST = 26;
const SPARK_EVERY_S = 0.14;
const ENERGY_PER_KEY = 0.22;
const ENERGY_CAP = 1.6;
const ENERGY_DECAY_S = 0.8;
const PULSE_DECAY_S = 0.16;
const SPARK_EDGE_FADE = 14;

// ---------- tipos ----------
interface Item { key: string; name: string; description?: string; icon?: unknown; attach?: boolean; tag?: string }
type Trigger = { kind: 'mention' | 'command'; term: string; start: number };
type MenuKind = 'mention' | 'command' | 'model' | 'effort';
type KeyAction = 'menu-next' | 'menu-prev' | 'menu-pick' | 'menu-close' | 'send' | 'block' | 'none';
interface KeyInput { key: string; shift: boolean; composing: boolean; busy: boolean; menuOpen: boolean; rows: number }

const DEMO_SOURCES: Item[] = [
  { key: 'files', name: 'Files', description: 'Attach a file', icon: 'Paperclip', attach: true },
  { key: 'calendar', name: 'Calendar', description: 'Events and schedules', icon: 'Calendar' },
  { key: 'metrics', name: 'Metrics', description: 'Charts and numbers', icon: 'ChartLine' },
  { key: 'docs', name: 'Docs', description: 'Documents and notes', icon: 'FileText' },
  { key: 'web', name: 'Web', description: 'Search the internet', icon: 'Globe' },
  { key: 'mail', name: 'Mail', description: 'Messages and threads', icon: 'Mail' },
];
const DEMO_COMMANDS: Item[] = [
  { key: 'summarize', name: '/summarize', description: 'Short summary' },
  { key: 'explain', name: '/explain', description: 'Explain step by step' },
  { key: 'translate', name: '/translate', description: 'Translate the text' },
  { key: 'fix', name: '/fix', description: 'Find and fix problems' },
  { key: 'help', name: '/help', description: 'What can I do here' },
];
const DEMO_MODELS: Item[] = [
  { key: 'nova-3', name: 'Nova 3', tag: 'Best' },
  { key: 'nova-mini', name: 'Nova Mini', tag: 'Fast' },
  { key: 'nova-2', name: 'Nova 2', tag: 'Legacy' },
];
const DEMO_EFFORTS = ['Low', 'Medium', 'High', 'Extra', 'Max'];

// ---------- regras puras ----------
const TRIGGER_RE = /(^|\s)([@/])([\p{L}\p{N}_-]*)$/u;

/** Gatilho "@" ou "/" no fim do texto: no começo ou depois de espaço, seguido de letras, dígitos, "_" ou "-". */
function detectTrigger(text: string): Trigger | null {
  const m = TRIGGER_RE.exec(text);
  if (!m) return null;
  const lead = m[1] ?? '';
  const mark = m[2] ?? '';
  return { kind: mark === '@' ? 'mention' : 'command', term: m[3] ?? '', start: m.index + lead.length };
}

/** "@": o nome contém o termo; "/": o nome sem a barra começa com o termo. Sem diferenciar maiúsculas. */
function filterItems(kind: 'mention' | 'command', items: readonly Item[], term: string): Item[] {
  const t = term.toLowerCase();
  if (kind === 'mention') return items.filter((i) => i.name.toLowerCase().includes(t));
  return items.filter((i) => i.name.replace(/^\//, '').toLowerCase().startsWith(t));
}

/** Texto depois de escolher uma linha: "@" ⇒ `@Nome `, "/" ⇒ `/nome `, anexo ⇒ só tira o termo digitado. */
function applyPick(text: string, trigger: Trigger, item: Item): string {
  const head = text.slice(0, trigger.start);
  if (item.attach) return head;
  return trigger.kind === 'mention' ? `${head}@${item.name} ` : `${head}${item.name} `;
}

function keyAction(k: KeyInput): KeyAction {
  if (k.composing) return 'none';
  if (k.menuOpen && k.key === 'Escape') return 'menu-close';
  if (k.rows > 0) {
    if (k.key === 'ArrowDown') return 'menu-next';
    if (k.key === 'ArrowUp') return 'menu-prev';
    if (k.key === 'Tab' && !k.shift) return 'menu-pick';
    if (k.key === 'Enter' && !k.shift) return 'menu-pick';
  }
  if (k.key === 'Enter' && !k.shift) return k.busy ? 'block' : 'send';
  return 'none';
}

const hasContent = (text: string, attachments: readonly string[]): boolean => text.trim() !== '' || attachments.length > 0;
const isArmed = (text: string, attachments: readonly string[], busy: boolean): boolean => busy || hasContent(text, attachments);

function initialModel(models: readonly Item[], wanted: string): string {
  return (models.find((m) => m.key === wanted) ?? models[0])?.key ?? '';
}

function initialEffort(efforts: readonly string[], wanted: string): number {
  if (efforts.length === 0) return -1;
  const i = efforts.indexOf(wanted);
  return i >= 0 ? i : Math.floor((efforts.length - 1) / 2);
}

function normalizeAttachments(result: unknown): string[] {
  if (typeof result === 'string') return result ? [result] : [];
  if (Array.isArray(result)) return result.filter((n): n is string => typeof n === 'string' && n !== '');
  return [];
}

function effortFromX(x: number, width: number, count: number): number {
  if (count < 2) return 0;
  const span = Math.max(1, width - 2 * SLIDER_MARGIN);
  const idx = Math.round(((x - SLIDER_MARGIN) / span) * (count - 1));
  return Math.min(count - 1, Math.max(0, idx));
}

function effortX(idx: number, width: number, count: number): number {
  if (count < 2) return width / 2;
  return SLIDER_MARGIN + (idx / (count - 1)) * (width - 2 * SLIDER_MARGIN);
}

// ---------- forma do botão: seta ⇄ quadrado, mesmos 7 pontos ----------
const ARROW_PTS: ReadonlyArray<readonly [number, number]> = [[8, 2], [13.5, 7.5], [9.5, 7.5], [9.5, 13.5], [6.5, 13.5], [6.5, 7.5], [2.5, 7.5]];
const STOP_PTS: ReadonlyArray<readonly [number, number]> = [[8, 4.5], [11.5, 4.5], [11.5, 8], [11.5, 11.5], [4.5, 11.5], [4.5, 8], [4.5, 4.5]];

function morphPoints(v: number): string {
  return ARROW_PTS.map(([ax, ay], i) => {
    const [sx, sy] = STOP_PTS[i] ?? [ax, ay];
    return `${(ax + (sx - ax) * v).toFixed(2)},${(ay + (sy - ay) * v).toFixed(2)}`;
  }).join(' ');
}

// ---------- estilo (injetado uma vez) ----------
const CSS = `
.pb{position:relative;box-sizing:border-box;color:var(--pb-fg);font:inherit;font-size:var(--fs-body)}
.pb *{box-sizing:border-box}
@media (pointer:coarse){.pb{font-size:var(--fs-section)}}
.pb-box{position:relative;overflow:hidden;background:var(--pb-bg);border-radius:var(--pb-r);padding:12px;cursor:text}
.pb-in{position:relative;display:flex;flex-direction:column;gap:8px}
.pb-glow{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .5s;background:radial-gradient(circle at 0 100%,color-mix(in srgb,var(--pb-spark) 26%,transparent),transparent 70%)}
.pb-glow[data-on]{opacity:1}
.pb-sparks{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.pb-ta{display:block;width:100%;resize:none;border:0;outline:0;background:transparent;color:inherit;font:inherit;line-height:${LINE_H}px;padding:0;margin:0;overflow-wrap:anywhere;overflow-y:hidden}
.pb-ta::placeholder{color:color-mix(in srgb,var(--pb-fg) 45%,transparent);opacity:1}
.pb-bar{display:flex;align-items:center;gap:4px}
.pb-sp{flex:1}
.pb-tool{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;height:28px;min-width:28px;padding:0 6px;border-radius:8px;justify-content:center;cursor:pointer;font-size:var(--fs-label);transition:background-color .16s,transform .16s cubic-bezier(.23,1,.32,1)}
.pb-tool:hover,.pb-tool[aria-expanded=true],.pb-tool[aria-pressed=true]{background:color-mix(in srgb,var(--pb-fg) 8%,transparent)}
.pb-tool:active{transform:scale(.94)}
.pb-tool:focus-visible,.pb-send:focus-visible,.pb-x:focus-visible,.pb-slider:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.pb-send{all:unset;box-sizing:border-box;width:${SEND_SIZE}px;height:${SEND_SIZE}px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .2s,color .2s,transform .16s cubic-bezier(.23,1,.32,1);background:color-mix(in srgb,var(--pb-fg) 12%,var(--pb-bg));color:color-mix(in srgb,var(--pb-fg) 55%,transparent)}
.pb-send[data-armed]{background:var(--pb-fg);color:var(--pb-bg)}
.pb-send:disabled{cursor:default}
.pb-chips{display:flex;flex-wrap:wrap;gap:6px}
.pb-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 4px 0 8px;border-radius:8px;background:color-mix(in srgb,var(--pb-fg) 8%,transparent);font-size:var(--fs-meta);animation:pb-in .2s cubic-bezier(.23,1,.32,1)}
.pb-chip span{max-width:144px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-x{all:unset;box-sizing:border-box;display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;border-radius:6px;cursor:pointer}
.pb-x:hover{background:color-mix(in srgb,var(--pb-fg) 12%,transparent)}
.pb-menu{position:absolute;bottom:calc(100% + 8px);left:0;z-index:30;padding:4px;border-radius:12px;background:var(--pb-menu);color:var(--pb-fg);box-shadow:0 8px 28px rgb(0 0 0/.28),0 0 0 1px color-mix(in srgb,var(--pb-fg) 10%,transparent);transform-origin:bottom;animation:pb-menu .18s cubic-bezier(.23,1,.32,1)}
.pb-list{position:relative}
.pb-hl{position:absolute;left:0;right:0;top:0;height:${ROW_H}px;border-radius:8px;background:color-mix(in srgb,var(--pb-fg) 8%,transparent);pointer-events:none;transition:transform .22s cubic-bezier(.23,1,.32,1),opacity .15s}
.pb-row{position:relative;display:flex;align-items:center;gap:8px;height:${ROW_H}px;padding:0 8px;border-radius:8px;cursor:pointer}
.pb-ic{width:20px;display:inline-flex;justify-content:center;opacity:.7}
.pb-name{font-size:var(--fs-label);font-weight:500;white-space:nowrap}
.pb-desc{font-size:var(--fs-meta);opacity:.55;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-tag{margin-left:auto;font-size:var(--fs-micro);opacity:.6}
.pb-none{padding:8px;font-size:var(--fs-meta);opacity:.6}
.pb-eff{padding:12px;width:${EFFORT_W}px}
.pb-eff-h{display:flex;align-items:center;gap:6px;font-size:var(--fs-label);margin-bottom:8px}
.pb-eff-h b{font-weight:500}
.pb-eff-ends{display:flex;justify-content:space-between;font-size:var(--fs-micro);opacity:.6;margin-bottom:6px}
.pb-slider{position:relative;height:28px;touch-action:none;cursor:pointer;border-radius:11px}
.pb-track{position:absolute;left:0;right:0;top:3px;height:22px;border-radius:11px;background:color-mix(in srgb,var(--pb-fg) 10%,transparent);overflow:hidden}
.pb-fill{position:absolute;left:0;top:0;bottom:0;background:color-mix(in srgb,var(--pb-fg) 18%,transparent);transition:width .22s cubic-bezier(.23,1,.32,1),background-color .3s}
.pb-dot{position:absolute;top:9px;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:color-mix(in srgb,var(--pb-fg) 40%,transparent)}
.pb-cur{position:absolute;top:0;width:${CURSOR_W}px;height:28px;border-radius:7px;background:var(--pb-fg);box-shadow:0 2px 6px rgb(0 0 0/.3);transition:left .22s cubic-bezier(.23,1,.32,1),background-color .3s}
.pb-eq{display:inline-flex;align-items:center;gap:2px;height:14px}
.pb-eq i{width:2.5px;height:14px;border-radius:1px;background:currentColor;transform-origin:center;animation:pb-eq .9s ease-in-out infinite}
.pb-eq i:nth-child(2){animation-delay:.15s}.pb-eq i:nth-child(3){animation-delay:.3s}
.pb-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@keyframes pb-menu{from{opacity:0;transform:translateY(4px) scale(.98)}}
@keyframes pb-in{from{opacity:0;transform:scale(.96)}}
@keyframes pb-eq{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
.pb[data-rm] .pb-menu,.pb[data-rm] .pb-chip,.pb[data-rm] .pb-eq i{animation:none}
.pb[data-rm] .pb-hl{transition:opacity .15s}
.pb[data-rm] .pb-fill,.pb[data-rm] .pb-cur{transition:background-color .3s}
.pb[data-rm] .pb-tool,.pb[data-rm] .pb-send{transition:background-color .2s,color .2s}
.pb[data-rm] .pb-tool:active{transform:none}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// ---------- ícones ----------
function icon(spec: unknown, size: number): ReactNode {
  if (typeof spec === 'string') {
    const Icon = LucideReact[spec];
    return Icon ? h(Icon, { size, 'aria-hidden': true }) : null;
  }
  return (spec ?? null) as ReactNode;
}

function SendIcon({ stop, reduced, morphMs, squash, tilt }: { stop: boolean; reduced: boolean; morphMs: number; squash: number; tilt: number }) {
  const [v, setV] = useState(stop ? 1 : 0);
  const from = useRef(v);
  const dir = useRef(stop ? 1 : -1);
  useEffect(() => {
    const target = stop ? 1 : 0;
    dir.current = stop ? 1 : -1;
    if (reduced || from.current === target) { from.current = target; setV(target); return undefined; }
    const run = animate(from.current, target, {
      duration: morphMs / 1000, ease: MORPH_EASE,
      onUpdate: (x: number) => { from.current = x; setV(x); },
    });
    return () => run.stop();
  }, [stop, reduced, morphMs]);
  const bell = Math.sin(Math.PI * v);
  const k = reduced ? 0 : bell;
  const transform = `rotate(${dir.current * tilt * k}deg) scale(${1 - squash * k}, ${1 + squash * k})`;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ transform }}>
      <polygon points={morphPoints(v)} fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

// ---------- faíscas (esforço máximo) ----------
interface Energy { value: number; pulse: number }
interface Spark { x: number; y: number; vy: number; sway: number; phase: number; r: number; life: number; age: number }

function newSpark(w: number, h2: number, spread: boolean): Spark {
  const life = 2.4 + Math.random() * 2.4;
  return {
    x: Math.random() * w, y: spread ? Math.random() * h2 : h2, vy: 7 + Math.random() * 9, sway: Math.random() * 5,
    phase: Math.random() * Math.PI * 2, r: 0.9 + Math.random() * 1.1, life, age: spread ? Math.random() * life * 0.6 : 0,
  };
}

function sparkAlpha(s: Spark, h2: number): number {
  const env = Math.min(1, s.age / 0.5, (s.life - s.age) / 0.7);
  const edge = Math.min(1, s.y / SPARK_EDGE_FADE, (h2 - s.y) / SPARK_EDGE_FADE);
  const twinkle = 0.85 + 0.15 * Math.sin(s.age * 9 + s.phase);
  return Math.max(0, env) * Math.max(0, edge) * twinkle;
}

function Sparks({ color, boost, energy }: { color: string; boost: number; energy: { current: Energy } }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    let w = 0, h2 = 0, frame = 0, last = performance.now(), spawn = 0, tint = '', tintAt = -Infinity;
    const sparks: Spark[] = [];
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h2 = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h2 * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    for (let i = 0; i < SPARK_BURST; i++) sparks.push(newSpark(w, h2, true));
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (now - tintAt > 1000) { tint = getComputedStyle(canvas).color; tintAt = now; }
      const e = energy.current;
      e.value *= Math.exp(-dt / ENERGY_DECAY_S);
      e.pulse *= Math.exp(-dt / PULSE_DECAY_S);
      const hot = e.value * boost;
      spawn += dt;
      while (spawn >= SPARK_EVERY_S) { spawn -= SPARK_EVERY_S; if (sparks.length < SPARK_MAX) sparks.push(newSpark(w, h2, false)); }
      ctx.clearRect(0, 0, w, h2);
      ctx.fillStyle = tint; ctx.shadowColor = tint;
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        if (!s) continue;
        s.age += dt; s.y -= s.vy * (1 + 6 * hot) * dt;
        if (s.age >= s.life || s.y < -4) { sparks.splice(i, 1); continue; }
        const x = s.x + Math.sin(s.age * 1.6 + s.phase) * s.sway;
        ctx.globalAlpha = Math.min(1, sparkAlpha(s, h2) * (0.7 + 0.3 * Math.min(1, hot + e.pulse * boost)));
        ctx.shadowBlur = 6 * (1 + hot + e.pulse * boost * 0.5);
        ctx.beginPath(); ctx.arc(x, s.y, s.r * (1 + 0.6 * hot), 0, Math.PI * 2); ctx.fill();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [boost, energy]);
  return <canvas ref={ref} className="pb-sparks" aria-hidden="true" style={{ color }} />;
}

// ---------- menus ----------
interface ListProps { rows: Item[]; active: number; setActive: (i: number) => void; pick: (i: Item) => void; term: string; label: string; showIcon: boolean; checkKey?: string; ids: string }

function MenuList({ rows, active, setActive, pick, term, label, showIcon, checkKey, ids }: ListProps) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const f = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(f);
  }, []);
  if (rows.length === 0) return <div className="pb-none" role="status">{`Nada encontrado para “${term}”`}</div>;
  return (
    <div className="pb-list" role="listbox" aria-label={label}>
      <div className="pb-hl" style={{ transform: `translateY(${active * ROW_H}px)`, transition: ready ? undefined : 'none' }} />
      {rows.map((item, i) => (
        <div key={item.key} id={`${ids}-${i}`} role="option" aria-selected={i === active} className="pb-row"
          onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(item)}>
          {showIcon ? <span className="pb-ic">{icon(item.icon, 15)}</span> : null}
          <span className="pb-name">{item.name}</span>
          {item.description ? <span className="pb-desc">{item.description}</span> : null}
          {item.tag ? <span className="pb-tag">{item.tag}</span> : null}
          {checkKey !== undefined && item.key === checkKey ? <span className={item.tag ? '' : 'pb-tag'}>{icon('Check', 14)}</span> : null}
        </div>
      ))}
    </div>
  );
}

interface EffortProps { efforts: string[]; index: number; onPick: (i: number) => void; onClose: () => void; max: boolean }

function EffortPanel({ efforts, index, onPick, onClose, max }: EffortProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(EFFORT_W - 24);
  const drag = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth || EFFORT_W - 24));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = efforts.length;
  const at = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (r) onPick(effortFromX(clientX - r.left, r.width, n));
  };
  const onKey = (e: { key: string; preventDefault: () => void }) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : step[e.key] !== undefined ? index + (step[e.key] as number) : null;
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (to === null) return;
    e.preventDefault();
    onPick(Math.min(n - 1, Math.max(0, to)));
  };
  const accent = max ? 'var(--pb-spark)' : undefined;
  const cx = effortX(index, w, n);
  return (
    <div className="pb-eff" role="dialog" aria-label="Esforço">
      <div className="pb-eff-h"><span>Esforço</span><b>{efforts[index]}</b>
        <span title="Mais esforço pensa por mais tempo antes de responder" style={{ opacity: 0.6, display: 'inline-flex' }}>{icon('CircleHelp', 13)}</span></div>
      <div className="pb-eff-ends"><span>Mais rápido</span><span>Mais atento</span></div>
      <div ref={ref} className="pb-slider" role="slider" tabIndex={0} aria-label="Esforço" aria-valuemin={0} aria-valuemax={n - 1}
        aria-valuenow={index} aria-valuetext={efforts[index]} onKeyDown={onKey}
        onPointerDown={(e) => { drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); at(e.clientX); }}
        onPointerMove={(e) => { if (drag.current) at(e.clientX); }}
        onPointerUp={() => { drag.current = false; }} onPointerCancel={() => { drag.current = false; }}>
        <div className="pb-track">
          <div className="pb-fill" style={{ width: cx, background: accent && `color-mix(in srgb, ${accent} 35%, transparent)` }} />
          {efforts.map((label, i) => <span key={label} className="pb-dot" style={{ left: effortX(i, w, n) }} />)}
        </div>
        <div className="pb-cur" style={{ left: cx - CURSOR_W / 2, background: accent }} />
      </div>
    </div>
  );
}

// ---------- componente ----------
interface SendMeta { attachments: string[]; model: string; effort: string }
interface PromptBarProps {
  placeholder?: string; sources?: Item[]; commands?: Item[]; models?: Item[]; efforts?: string[];
  defaultModel?: string; defaultEffort?: string; busy?: boolean;
  onSend?: (text: string, meta: SendMeta) => void; onStop?: () => void;
  onAttach?: () => Promise<unknown>; onDictate?: () => Promise<string>; onEffortChange?: (label: string) => void;
  background?: string; color?: string; menuBackground?: string; sparkColor?: string; sparkBoost?: number;
  width?: number; radius?: number; maxRows?: number; morphDuration?: number; squash?: number; tilt?: number; pressScale?: number;
  className?: string;
}

function PromptBar(props: PromptBarProps) {
  const {
    placeholder = 'Pergunte qualquer coisa', sources = DEMO_SOURCES, commands = DEMO_COMMANDS, models = DEMO_MODELS, efforts = DEMO_EFFORTS,
    defaultModel = '', defaultEffort = '', busy = false, onSend, onStop, onAttach, onDictate, onEffortChange,
    background = '#27272a', color = '#f5f5f5', menuBackground = '#323236', sparkColor = '#b39dff', sparkBoost = 1,
    width = 400, radius = 16, maxRows = 5, morphDuration = 240, squash = 0.12, tilt = 8, pressScale = 0.96, className = '',
  } = props;
  ensureStyle();
  const reduced = !!useReducedMotion();
  const ids = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const energy = useRef<Energy>({ value: 0, pulse: 0 });
  const dictation = useRef(0);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [model, setModel] = useState(() => initialModel(models, defaultModel));
  const [effort, setEffort] = useState(() => initialEffort(efforts, defaultEffort));
  const [openMenu, setOpenMenu] = useState<{ kind: MenuKind; all: boolean } | null>(null);
  const [suppressed, setSuppressed] = useState(false);
  const [active, setActive] = useState(0);
  const [pressed, setPressed] = useState(false);
  const [listening, setListening] = useState(false);

  const trigger = suppressed ? null : detectTrigger(text);
  const menuKind: MenuKind | null = openMenu?.kind ?? trigger?.kind ?? null;
  const term = openMenu?.all ? '' : trigger?.term ?? '';
  let rows: Item[] = [];
  if (menuKind === 'mention') rows = openMenu?.all ? sources : filterItems('mention', sources, term);
  else if (menuKind === 'command') rows = filterItems('command', commands, term);
  else if (menuKind === 'model') rows = models;
  const rowIdx = Math.min(active, Math.max(0, rows.length - 1));
  const armed = isArmed(text, attachments, busy);
  const maxEffort = efforts.length > 1 && effort === efforts.length - 1;
  const sparksOn = maxEffort && !reduced;

  useEffect(() => { setActive(0); }, [menuKind, term]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxRows * LINE_H)}px`;
    el.style.overflowY = el.scrollHeight > maxRows * LINE_H ? 'auto' : 'hidden';
  }, [text, maxRows]);
  useEffect(() => () => { dictation.current++; }, []);
  useEffect(() => {
    if (!menuKind) return undefined;
    const away = (e: PointerEvent) => { if (e.target instanceof Node && !root.current?.contains(e.target)) { setOpenMenu(null); setSuppressed(true); } };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [menuKind]);

  const focusField = () => area.current?.focus();
  const closeMenus = () => { setOpenMenu(null); setSuppressed(true); };
  const toggle = (kind: MenuKind, all = false) => setOpenMenu((cur) => (cur?.kind === kind ? null : { kind, all }));

  const send = () => {
    if (busy || !hasContent(text, attachments)) return;
    onSend?.(text.trim(), { attachments, model, effort: efforts[effort] ?? '' });
    setText(''); setAttachments([]); closeMenus(); focusField();
  };

  const pickRow = (item: Item) => {
    if (menuKind === 'model') { setModel(item.key); setOpenMenu(null); focusField(); return; }
    if (menuKind === 'mention' || menuKind === 'command') {
      const t = trigger ?? { kind: menuKind, term: '', start: text.length };
      setText(openMenu?.all && !trigger ? text : applyPick(text, t, item));
      setOpenMenu(null);
      if (item.attach && onAttach) onAttach().then((r) => setAttachments((a) => [...a, ...normalizeAttachments(r)])).catch(() => undefined);
    }
    focusField();
  };

  const pickEffort = (i: number) => {
    if (i === effort) return;
    setEffort(i);
    onEffortChange?.(efforts[i] ?? '');
  };

  const bump = () => { energy.current.value = Math.min(ENERGY_CAP, energy.current.value + ENERGY_PER_KEY); energy.current.pulse = 1; };

  const onKeyDown = (e: { key: string; shiftKey: boolean; nativeEvent: { isComposing: boolean }; preventDefault: () => void }) => {
    bump();
    const act = keyAction({ key: e.key, shift: e.shiftKey, composing: e.nativeEvent.isComposing, busy, menuOpen: menuKind !== null, rows: menuKind === 'effort' ? 0 : rows.length });
    if (act === 'none') return;
    e.preventDefault();
    if (act === 'menu-close') closeMenus();
    else if (act === 'menu-next') setActive((rowIdx + 1) % rows.length);
    else if (act === 'menu-prev') setActive((rowIdx - 1 + rows.length) % rows.length);
    else if (act === 'menu-pick') { const r = rows[rowIdx]; if (r) pickRow(r); }
    else if (act === 'send') send();
  };

  const dictate = () => {
    if (!onDictate) return;
    if (listening) { dictation.current++; setListening(false); return; }
    const token = ++dictation.current;
    setListening(true);
    onDictate().then((spoken) => {
      if (token !== dictation.current) return;
      setListening(false);
      if (spoken) setText((t) => (t && !/\s$/.test(t) ? `${t} ${spoken}` : `${t}${spoken}`));
    }).catch(() => { if (token === dictation.current) setListening(false); });
  };

  const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();
  const sendLabel = busy ? 'Parar a resposta' : 'Enviar';
  const modelName = models.find((m) => m.key === model)?.name ?? '';
  const menuWidth = menuKind === 'model' ? MODEL_MENU_W : menuKind === 'effort' ? EFFORT_W : undefined;
  const label = menuKind === 'mention' ? 'Fontes' : menuKind === 'command' ? 'Comandos' : 'Modelos';

  return (
    <div ref={root} className={`pb ${className}`.trim()} data-rm={reduced ? '' : undefined}
      style={{ width: '100%', maxWidth: width, '--pb-bg': background, '--pb-fg': color, '--pb-menu': menuBackground, '--pb-spark': sparkColor, '--pb-r': `${radius}px` }}>
      {menuKind ? (
        <div className="pb-menu" style={menuWidth ? { width: menuWidth } : { right: 0 }}>
          {menuKind === 'effort'
            ? <EffortPanel efforts={efforts} index={effort} onPick={pickEffort} onClose={() => { setOpenMenu(null); focusField(); }} max={maxEffort} />
            : <MenuList key={menuKind} rows={rows} active={rowIdx} setActive={setActive} pick={pickRow} term={term} label={label}
              showIcon={menuKind === 'mention'} checkKey={menuKind === 'model' ? model : undefined} ids={`${ids}-m`} />}
        </div>
      ) : null}
      <div className="pb-box" onClick={(e) => { if (!(e.target instanceof Element) || !e.target.closest('button,[role=slider]')) focusField(); }}>
        <div className="pb-glow" data-on={sparksOn ? '' : undefined} />
        {sparksOn ? <Sparks color={sparkColor} boost={sparkBoost} energy={energy} /> : null}
        <div className="pb-in">
          {attachments.length > 0 ? (
            <div className="pb-chips">
              {attachments.map((name, i) => (
                <span key={`${name}-${i}`} className="pb-chip">{icon('FileText', 12)}<span>{name}</span>
                  <button type="button" className="pb-x" aria-label={`Remover ${name}`} onMouseDown={keepFocus}
                    onClick={() => { setAttachments((a) => a.filter((_, j) => j !== i)); focusField(); }}>{icon('X', 12)}</button></span>
              ))}
            </div>
          ) : null}
          <textarea ref={area} className="pb-ta" rows={1} value={text} aria-label="Mensagem" placeholder={listening ? 'Ouvindo…' : placeholder}
            aria-activedescendant={rows.length && menuKind && menuKind !== 'effort' ? `${ids}-m-${rowIdx}` : undefined}
            onChange={(e) => { setText(e.target.value); setOpenMenu(null); setSuppressed(false); }}
            onFocus={() => setOpenMenu(null)} onKeyDown={onKeyDown} />
          <div className="pb-bar">
            {sources.length > 0 ? (
              <button type="button" className="pb-tool" aria-label="Adicionar fontes" aria-expanded={menuKind === 'mention'}
                onMouseDown={keepFocus} onClick={() => toggle('mention', true)}>{icon('Plus', 16)}</button>
            ) : null}
            {models.length > 0 ? (
              <button type="button" className="pb-tool" aria-label="Escolher modelo" aria-expanded={menuKind === 'model'}
                onMouseDown={keepFocus} onClick={() => toggle('model')}>{modelName}{icon('ChevronDown', 14)}</button>
            ) : null}
            {efforts.length > 0 ? (
              <button type="button" className="pb-tool" aria-label="Escolher esforço" aria-expanded={menuKind === 'effort'}
                style={maxEffort ? { color: sparkColor } : undefined} onMouseDown={keepFocus} onClick={() => toggle('effort')}>
                {icon('Sparkles', 14)}{efforts[effort]}</button>
            ) : null}
            <span className="pb-sp" />
            {onDictate ? (
              <button type="button" className="pb-tool" aria-label={listening ? 'Parar ditado' : 'Ditar'} aria-pressed={listening}
                onMouseDown={keepFocus} onClick={dictate}>
                {listening ? <span className="pb-eq" aria-hidden="true"><i /><i /><i /></span> : icon('Mic', 16)}</button>
            ) : null}
            <button type="button" className="pb-send" data-armed={armed ? '' : undefined} disabled={!armed} aria-label={sendLabel}
              title={busy ? sendLabel : 'Enviar (Enter; Shift+Enter quebra a linha)'}
              style={pressed && !reduced ? { transform: `scale(${pressScale})` } : undefined}
              onMouseDown={keepFocus}
              onPointerDown={(e) => { if (e.button === 0 && armed) setPressed(true); }}
              onPointerUp={() => setPressed(false)} onPointerLeave={() => setPressed(false)} onPointerCancel={() => setPressed(false)}
              onClick={() => { if (busy) onStop?.(); else send(); }}>
              <SendIcon stop={busy} reduced={reduced} morphMs={morphDuration} squash={squash} tilt={tilt} />
            </button>
          </div>
        </div>
      </div>
      <span className="pb-sr" aria-live="polite">{listening ? 'Ouvindo' : ''}</span>
    </div>
  );
}

PromptBar.logic = { detectTrigger, filterItems, applyPick, keyAction, isArmed, hasContent, initialModel, initialEffort, normalizeAttachments, effortFromX, effortX };

window.HadesFx = { ...window.HadesFx, PromptBar };
})();
