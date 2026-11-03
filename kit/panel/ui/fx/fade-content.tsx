/* Entrada de conteúdo: `play(el, opções)` anima um elemento, ou os filhos dele em sequência, e devolve { cancel }. Dois efeitos:
 * "fade" (opacidade, desfoque e deslocamento, pela Web Animations, sem deixar nada no elemento) e "mist" (o conteúdo emerge de
 * manchas de ruído enquanto perde desfoque; o painel o usa a cada troca de página). A mancha é um filtro SVG por alvo, inserido
 * fora da vista e removido ao fim, e `follow` máscara também o que chega depois (esqueleto trocado pelo dado do fetch).
 * Na carga só se tocam React, window, matchMedia e navigator: o document aparece apenas dentro de funções chamadas depois,
 * para o arquivo carregar sem DOM nos testes. Exposto em window.HadesFx.FadeContent, com as funções puras como membros. */
(() => {
type StaggerFrom = 'start' | 'end' | 'center';
type Effect = 'fade' | 'mist';

interface PlayOptions {
  duration?: number; blur?: boolean | number; y?: number; delay?: number; initialOpacity?: number; ease?: string;
  onComplete?: () => void; effect?: Effect; stagger?: number; staggerFrom?: StaggerFrom; follow?: boolean;
}
interface Playing { cancel(): void }
interface TreeNode { parentElement: TreeNode | null; children: ArrayLike<TreeNode> }
interface Owned { has(node: TreeNode): boolean }

const DEFAULT_DURATION_S = 0.2;
const DEFAULT_EASE = 'cubic-bezier(.16,1,.3,1)';
const BLUR_TRUE_PX = 10;
const MIST_BASE_BLUR_PX = 10;
const MIST_EDGE = 0.35;
const NOISE_OCTAVES = 3;
const NOISE_FREQ_K = 4;
const NOISE_FREQ_MIN = 0.004;
const NOISE_FREQ_MAX = 0.02;
const NOISE_LOW = 0.1;
const NOISE_SPAN = 0.8;
const S_CURVE = '0 0.03 0.12 0.35 0.65 0.88 0.97 1';
const BUSY_MAX_S = 10;
const TAIL_AFTER_ENTRY_S = 0.3;
const SVG_NS = 'http://www.w3.org/2000/svg';
const AUX_ATTR = 'data-hades-fx';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const quiet = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  || !!(navigator as { connection?: { saveData?: boolean } }).connection?.saveData;

/** Saída exponencial: 0 em t <= 0, exatamente 1 em t >= 1. */
function expoOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - 2 ** (-10 * t);
}

/** Atraso de cada um de `n` alvos, em segundos, conforme a origem do escalonamento. */
function staggerStarts(n: number, each: number, from: StaggerFrom = 'start'): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => {
    if (from === 'end') return (n - 1 - i) * each;
    if (from === 'center') return Math.abs(i - (n - 1) / 2) * each;
    return i * each;
  });
}

/** Alvos escalonados do bloco: os filhos; se há um só e ele tem vários, os filhos dele; sem filhos, o próprio bloco. */
function staggerTargets<T extends TreeNode>(block: T): T[] {
  const kids = Array.from(block.children) as T[];
  if (kids.length === 0) return [block];
  const only = kids[0];
  if (kids.length === 1 && only && only.children.length > 1) return Array.from(only.children) as T[];
  return kids;
}

/** Quem ganha máscara quando `node` chega depois do início: nada se ele já está sob um alvo, ele mesmo se está fundo no bloco. */
function arrivalTargets<T extends TreeNode>(node: T, block: T, owned: Owned): T[] {
  for (let n: TreeNode | null = node; n && n !== block; n = n.parentElement) if (owned.has(n)) return [];
  if (node.parentElement !== block) return [node];
  return staggerTargets(block).filter((t) => !owned.has(t));
}

function blurPx(blur: boolean | number | undefined): number {
  if (blur === true) return BLUR_TRUE_PX;
  return typeof blur === 'number' && blur > 0 ? blur : 0;
}

function done(onComplete: (() => void) | undefined): null {
  onComplete?.();
  return null;
}

function playFade(el: HTMLElement, o: PlayOptions): Playing | null {
  if (typeof el.animate !== 'function') return done(o.onComplete);
  const from: Keyframe = { opacity: clamp(o.initialOpacity ?? 0, 0, 1) };
  const to: Keyframe = { opacity: 1 };
  const px = blurPx(o.blur);
  if (px > 0) { from.filter = `blur(${px}px)`; to.filter = 'blur(0px)'; }
  if (o.y) { from.transform = `translateY(${o.y}px)`; to.transform = 'translateY(0px)'; }
  const anim = el.animate([from, to], {
    duration: (o.duration ?? DEFAULT_DURATION_S) * 1000,
    delay: (o.delay ?? 0) * 1000,
    easing: o.ease ?? DEFAULT_EASE,
    fill: 'backwards',
  });
  anim.onfinish = () => o.onComplete?.();
  return { cancel: () => { anim.onfinish = null; anim.cancel(); } };
}

interface Mask { target: HTMLElement; svg: SVGSVGElement; matrix: Element; id: string; previousFilter: string; startAt: number }

let filterSeq = 0;
const svgEl = (tag: string, attrs: Record<string, string>) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

function createMask(target: HTMLElement, startAt: number, initialOpacity: number): Mask {
  const rect = target.getBoundingClientRect();
  const freq = clamp(NOISE_FREQ_K / Math.sqrt(Math.max(1, rect.width * rect.height)), NOISE_FREQ_MIN, NOISE_FREQ_MAX);
  const id = `hades-mist-${++filterSeq}`;
  const svg = svgEl('svg', { width: '0', height: '0', 'aria-hidden': 'true', [AUX_ATTR]: '' }) as SVGSVGElement;
  svg.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none';
  const filter = svgEl('filter', { id, x: '-10%', y: '-10%', width: '120%', height: '120%', 'color-interpolation-filters': 'sRGB' });
  const matrix = svgEl('feColorMatrix', { in: 'noise', type: 'matrix', result: 'ramp' });
  const curve = svgEl('feComponentTransfer', { in: 'ramp', result: 'soft' });
  curve.appendChild(svgEl('feFuncA', { type: 'table', tableValues: S_CURVE }));
  const floor = svgEl('feComponentTransfer', { in: 'soft', result: 'alpha' });
  floor.appendChild(svgEl('feFuncA', { type: 'linear', slope: String(1 - initialOpacity), intercept: String(initialOpacity) }));
  filter.append(
    svgEl('feTurbulence', { type: 'fractalNoise', baseFrequency: String(freq), numOctaves: String(NOISE_OCTAVES), seed: String(Math.floor(Math.random() * 10000)), result: 'noise' }),
    matrix, curve, floor,
    svgEl('feComposite', { in: 'SourceGraphic', in2: 'alpha', operator: 'in' }),
  );
  svg.appendChild(filter);
  document.body.appendChild(svg);
  return { target, svg, matrix, id, previousFilter: target.style.filter, startAt };
}

/** Pinta o alvo no progresso `p` (0..1): a frente de revelação avança pelo ruído e o desfoque cai linearmente. */
function paintMask(m: Mask, p: number, extraBlur: number) {
  const front = p * (1 + MIST_EDGE);
  const gain = 1 / (NOISE_SPAN * MIST_EDGE);
  const offset = (front - 1) / MIST_EDGE - gain * NOISE_LOW;
  m.matrix.setAttribute('values', `0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${gain} 0 0 0 ${offset}`);
  m.target.style.filter = `blur(${(MIST_BASE_BLUR_PX + extraBlur) * (1 - p)}px) url(#${m.id})`;
}

function disposeMask(m: Mask) {
  m.target.style.filter = m.previousFilter;
  if (!m.target.getAttribute('style')) m.target.removeAttribute('style');
  m.svg.remove();
}

function playMist(el: HTMLElement, o: PlayOptions): Playing | null {
  const duration = Math.max(0.001, o.duration ?? DEFAULT_DURATION_S);
  const extraBlur = blurPx(o.blur);
  const floor = clamp(o.initialOpacity ?? 0, 0, 1);
  const nowS = () => performance.now() / 1000;
  const owned = new Set<HTMLElement>();
  const live = new Set<Mask>();
  const t0 = nowS();

  const addMask = (target: HTMLElement, startAt: number) => {
    if (owned.has(target)) return;
    owned.add(target);
    const mask = createMask(target, startAt, floor);
    paintMask(mask, 0, extraBlur);
    live.add(mask);
  };

  const targets = staggerTargets(el);
  const starts = staggerStarts(targets.length, o.stagger ?? 0, o.staggerFrom ?? 'start');
  targets.forEach((t, i) => addMask(t, t0 + (o.delay ?? 0) + (starts[i] ?? 0)));
  const entryEnd = Math.max(...Array.from(live, (m) => m.startAt)) + duration;

  let observer: MutationObserver | null = null;
  let frame = 0;
  let busySince: number | null = null;
  let finished = false;

  const closeObserver = () => { observer?.disconnect(); observer = null; };
  const teardown = () => {
    finished = true;
    cancelAnimationFrame(frame);
    closeObserver();
    live.forEach(disposeMask);
    live.clear();
  };

  const windowOpen = (now: number): boolean => {
    if (!o.follow) return false;
    if (el.querySelector('[aria-busy="true"]')) {
      busySince ??= now;
      if (now - busySince < BUSY_MAX_S) return true;
    }
    return now < entryEnd + TAIL_AFTER_ENTRY_S;
  };

  const tick = () => {
    const now = nowS();
    for (const m of [...live]) {
      const t = (now - m.startAt) / duration;
      if (!m.target.isConnected || t >= 1) { disposeMask(m); live.delete(m); continue; }
      paintMask(m, expoOut(t), extraBlur);
    }
    const open = windowOpen(now);
    if (!open) closeObserver();
    if (live.size === 0 && !open) {
      teardown();
      o.onComplete?.();
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  if (o.follow && typeof MutationObserver === 'function') {
    observer = new MutationObserver((records) => {
      const now = nowS();
      for (const rec of records) {
        for (const added of Array.from(rec.addedNodes)) {
          if (added.nodeType !== 1 || (added as Element).hasAttribute(AUX_ATTR) || !(added as Element).isConnected) continue;
          for (const t of arrivalTargets(added as HTMLElement, el, owned)) addMask(t, now);
        }
      }
    });
    observer.observe(el, { childList: true, subtree: true });
  }
  frame = requestAnimationFrame(tick);
  return { cancel: () => { if (!finished) teardown(); } };
}

/** Anima `el` e devolve { cancel }, ou null quando não há o que animar (sem elemento, movimento reduzido ou economia de dados). */
function play(el: HTMLElement | null | undefined, options: PlayOptions = {}): Playing | null {
  if (!el || quiet()) return done(options.onComplete);
  return options.effect === 'mist' ? playMist(el, options) : playFade(el, options);
}

interface FadeContentProps extends PlayOptions {
  className?: string; style?: Record<string, unknown>; children?: ReactNode; [rest: string]: unknown;
}

function FadeContent(props: FadeContentProps) {
  const { children, className, style, duration, blur, y, delay, initialOpacity, ease, effect, stagger, staggerFrom, follow, onComplete, ...rest } = props;
  const ref = React.useRef<HTMLDivElement | null>(null);
  const latestComplete = React.useRef(onComplete);
  latestComplete.current = onComplete;
  React.useLayoutEffect(() => {
    const playing = play(ref.current, {
      duration, blur, y, delay, initialOpacity, ease, effect, stagger, staggerFrom, follow,
      onComplete: () => latestComplete.current?.(),
    });
    return () => playing?.cancel();
  }, []);
  return <div ref={ref} className={className} style={style} {...rest}>{children}</div>;
}

FadeContent.play = play;
FadeContent.expoOut = expoOut;
FadeContent.staggerStarts = staggerStarts;
FadeContent.arrivalTargets = arrivalTargets;

window.HadesFx = { ...window.HadesFx, FadeContent };
})();
