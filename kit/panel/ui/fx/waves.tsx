/* Waves: campo de linhas paralelas que ondulam, desenhado em WebGL2. Cada linha é uma faixa de triângulos em instância, cujos
 * vértices são deslocados na GPU por um ruído lento; o empurrão do ponteiro vem de uma grade de molas simulada aqui, em
 * baixa resolução, e a ondulação do clique é calculada direto no vertex shader. Decorativo: sem WebGL2 não monta nada.
 * Exposto em window.HadesFx.Waves; só a abertura (intro.tsx) o usa. */
(() => {
const { createElement, useEffect, useRef } = React;

// ---- tempos, distâncias e limites do efeito (px CSS, segundos) ----
const INTRO_SECONDS = 2.2;
const INTRO_FRONT_SHARE = 0.7;      // a frente de brotamento termina nesta fração da entrada
const INTRO_FRONT_SOFT = 0.3;       // largura da borda da frente, em fração da meia-largura
const INTRO_AMP_START = 0.1;        // o inchaço da amplitude começa nesta fração
const BASE_OPACITY = 0.62;
const HEAT_FULL_OF_CAP = 0.55;      // deslocamento (× teto) em que a cor chega toda ao destaque
const CAP_MIN = 12;
const CAP_OF_RADIUS = 0.5;
const POINTER_SMOOTH_SECONDS = 0.045;
const POINTER_FULL_SPEED = 1400;    // px/s em que o empurrão satura
const POINTER_PUSH = 0.08;          // fração do teto somada por quadro (a 60 fps) na velocidade de saturação
const RIPPLE_SPEED = 640;
const RIPPLE_WIDTH = 64;
const RIPPLE_PUSH = 0.8;            // × teto
const RIPPLE_MAX = 6;
const RIPPLE_MIN_REACH = 360;
const RIPPLE_REACH_OF_DIAGONAL = 0.55;
const DASH_PERIOD_OF_SPACING = 2.6;
const DASH_SPEED = 16;
const NOISE_SCALE_X = 500;
const NOISE_SCALE_Y = 670;
const NOISE_FLOW = 0.06;            // unidades de ruído por segundo (× speed)
const LIGHT_LINE_LUMINANCE = 0.045;
const CELL = 20;                    // lado da célula da grade de molas
const SAMPLE_STEP = 8;              // px entre vértices ao longo da linha
const VERTEX_BUDGET = 700000;
const MIN_SAMPLES = 24;
const MAX_DPR = 2;
const MAX_FRAME_DT = 0.1;
const SETTLE_EPSILON = 0.01;
const SPRING_STEP_LIMIT = 0.5;      // ω·h máximo por subpasso (estabilidade)
const MAX_SUBSTEPS = 8;

interface WavesProps {
  lineColor?: string; accentColor?: string; backgroundColor?: string;
  lineStyle?: string; spacing?: number; lineWidth?: number; rotation?: number;
  amplitude?: number; scale?: number; twist?: number; variation?: number; speed?: number;
  mouseInteraction?: boolean; mouseRadius?: number; mouseStrength?: number; bounce?: number; returnDuration?: number; clickRipple?: boolean;
  intro?: boolean; fade?: number; opacity?: number; lightMode?: boolean; paused?: boolean; dpr?: number;
  className?: string; style?: Record<string, unknown>;
}

interface Settings {
  lineColor: string; accentColor: string; dashed: boolean; spacing: number; lineWidth: number; rotation: number;
  amplitude: number; scale: number; twist: number; variation: number; speed: number;
  interactive: boolean; radius: number; strength: number; bounce: number; returnSeconds: number; ripples: boolean;
  intro: boolean; fade: number; opacity: number; light: boolean; paused: boolean; dpr: number | undefined;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number, lo: number, hi = Infinity) =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

function settingsOf(p: WavesProps): Settings {
  return {
    lineColor: p.lineColor ?? '#ffffff', accentColor: p.accentColor ?? p.lineColor ?? '#ffffff',
    dashed: p.lineStyle === 'dashed',
    spacing: num(p.spacing, 10, 2), lineWidth: num(p.lineWidth, 1, 0.25), rotation: num(p.rotation, 0, -Infinity),
    amplitude: num(p.amplitude, 32, 0), scale: num(p.scale, 1, 0.05), twist: num(p.twist, 1, 0),
    variation: Math.floor(num(p.variation, 0, 0)), speed: num(p.speed, 1, 0),
    interactive: p.mouseInteraction !== false, radius: num(p.mouseRadius, 175, 20), strength: num(p.mouseStrength, 1, 0),
    bounce: num(p.bounce, 0.5, 0, 1), returnSeconds: num(p.returnDuration, 1.4, 0.2), ripples: p.clickRipple !== false,
    intro: p.intro !== false, fade: num(p.fade, 0, 0, 1), opacity: num(p.opacity, 1, 0, 1),
    light: p.lightMode === true, paused: p.paused === true, dpr: typeof p.dpr === 'number' && p.dpr > 0 ? p.dpr : undefined,
  };
}

// ---- shaders ----
const VERTEX = `#version 300 es
precision highp float;
uniform vec2 uSize;
uniform float uRadius, uLines, uSamples, uSpacing, uHalfW;
uniform vec2 uRot;
uniform float uAmp, uScale, uTwist, uSeed, uFlow, uCap, uIntroAmp, uIntroFront;
uniform sampler2D uField;
uniform vec2 uGrid;
uniform float uCell;
uniform vec4 uRip[${RIPPLE_MAX}];
out float vOff;
out float vHeat;
out float vAlong;
out float vLine;
out vec2 vScreen;
out float vIntro;
float gHeat;

float lattice(vec2 c) {
  uvec2 q = uvec2(ivec2(c) + ivec2(8192));
  uint h = q.x * 0x9E3779B1u ^ q.y * 0x85EBCA6Bu;
  h ^= h >> 15; h *= 0x2C1B3C6Du; h ^= h >> 12; h *= 0x297A2D39u; h ^= h >> 15;
  return float(h) / 4294967295.0;
}
float soft(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = mix(lattice(i), lattice(i + vec2(1.0, 0.0)), w.x);
  float b = mix(lattice(i + vec2(0.0, 1.0)), lattice(i + vec2(1.0, 1.0)), w.x);
  return mix(a, b, w.y) * 2.0 - 1.0;
}
vec2 warp(vec2 p0) {
  vec2 q = p0 / (vec2(${NOISE_SCALE_X}.0, ${NOISE_SCALE_Y}.0) * uScale) + vec2(uSeed * 3.17, uSeed * 1.71);
  q += vec2(uFlow * ${NOISE_FLOW} * 0.35, uFlow * ${NOISE_FLOW});
  float dx = 0.75 * soft(q) + 0.25 * soft(q * 2.3 + vec2(5.2, 1.3));
  float dy = 0.75 * soft(q * 1.37 + vec2(7.3, 2.1)) + 0.25 * soft(q * 2.9 + vec2(1.7, 9.4));
  vec2 d = uAmp * uIntroAmp * vec2(dx, uTwist * 0.7 * dy);
  vec2 pp = p0 + d;
  vec2 w = uSize * 0.5 + vec2(uRot.x * pp.x - uRot.y * pp.y, uRot.y * pp.x + uRot.x * pp.y);
  vec2 off = textureLod(uField, (w / uCell + 0.5) / uGrid, 0.0).rg;
  for (int i = 0; i < ${RIPPLE_MAX}; i++) {
    float amp = uRip[i].w;
    if (amp > 0.0) {
      vec2 dv = w - uRip[i].xy;
      float dl = length(dv);
      float g = (dl - uRip[i].z) / ${RIPPLE_WIDTH / 2}.0;
      off += dv / max(dl, 0.001) * exp(-g * g) * amp * uCap * ${RIPPLE_PUSH};
    }
  }
  float len = length(off);
  if (len > 0.0001) off *= tanh(len / uCap) * uCap / len;
  gHeat = clamp(length(off) / (${HEAT_FULL_OF_CAP} * uCap), 0.0, 1.0);
  return w + off;
}
void main() {
  int k = gl_VertexID >> 1;
  float side = float(gl_VertexID & 1) * 2.0 - 1.0;
  float lx = (float(gl_InstanceID) - (uLines - 1.0) * 0.5) * uSpacing;
  float y = (float(k) / uSamples * 2.0 - 1.0) * uRadius;
  float e = uRadius / uSamples;
  vec2 a = warp(vec2(lx, y - e));
  vec2 b = warp(vec2(lx, y + e));
  vec2 c = warp(vec2(lx, y));
  vec2 t = b - a;
  float tl = length(t);
  t = tl > 0.0001 ? t / tl : vec2(-uRot.y, uRot.x);
  vec2 pos = c + vec2(-t.y, t.x) * side * uHalfW;
  gl_Position = vec4(pos.x / uSize.x * 2.0 - 1.0, 1.0 - pos.y / uSize.y * 2.0, 0.0, 1.0);
  vOff = side * uHalfW;
  vHeat = gHeat;
  vAlong = y;
  vLine = fract(float(gl_InstanceID) * 0.6180339 + uSeed * 0.37);
  vScreen = c / uSize;
  float u = abs(c.x - uSize.x * 0.5) / (uSize.x * 0.5);
  vIntro = 1.0 - smoothstep(uIntroFront - ${INTRO_FRONT_SOFT}, uIntroFront, u);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 uLine, uAccent;
uniform float uOpacity, uWidth, uFade, uDashPeriod, uDashShift, uDashed;
in float vOff, vHeat, vAlong, vLine, vIntro;
in vec2 vScreen;
out vec4 outColor;
void main() {
  float half_ = max(uWidth, 1.0) * 0.5;
  float cover = clamp(half_ - abs(vOff) + 0.5, 0.0, 1.0) * min(uWidth, 1.0);
  if (uDashed > 0.5) {
    float ph = fract((vAlong - uDashShift) / uDashPeriod + vLine);
    float edge = 1.5 / uDashPeriod;
    cover *= smoothstep(0.0, edge, ph) * (1.0 - smoothstep(0.5 - edge, 0.5, ph));
  }
  if (uFade > 0.0) {
    vec2 m = min(vScreen, 1.0 - vScreen);
    cover *= smoothstep(0.0, uFade * 0.5, min(m.x, m.y));
  }
  float a = mix(uLine.a * ${BASE_OPACITY}, 1.0, vHeat) * cover * vIntro * uOpacity;
  vec3 rgb = mix(uLine.rgb, uAccent.rgb, vHeat);
  outColor = vec4(rgb * a, a);
}`;

// ---- cor ----
type Rgba = readonly [number, number, number, number];
let scratch: CanvasRenderingContext2D | null = null;
const resolved = new Map<string, Rgba>();

// o navegador resolve a sintaxe (oklch, color-mix, var já substituída): lê o pixel de uma tela 1×1
function resolveColor(css: string): Rgba {
  const hit = resolved.get(css);
  if (hit) return hit;
  scratch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  let out: Rgba = [1, 1, 1, 1];
  if (scratch) {
    scratch.clearRect(0, 0, 1, 1);
    scratch.fillStyle = '#000';
    scratch.fillStyle = css;
    scratch.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = scratch.getImageData(0, 0, 1, 1).data;
    out = a === 0 ? [0, 0, 0, 0] : [r / 255, g / 255, b / 255, a / 255];
  }
  resolved.set(css, out);
  return out;
}
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

// escurece mantendo o matiz: escala os canais lineares até a luminância-alvo
function darken([r, g, b, a]: Rgba): Rgba {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const k = lum > LIGHT_LINE_LUMINANCE ? LIGHT_LINE_LUMINANCE / lum : 1;
  return [toSrgb(lr * k), toSrgb(lg * k), toSrgb(lb * k), a];
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.warn('waves: shader', gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
  return null;
}

function link(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) { if (vs) gl.deleteShader(vs); if (fs) gl.deleteShader(fs); return null; }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  console.warn('waves: link', gl.getProgramInfoLog(program));
  gl.deleteProgram(program);
  return null;
}

interface Ripple { x: number; y: number; r: number }
interface Engine { refresh(): void; destroy(): void }

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const smooth01 = (t: number) => t * t * (3 - 2 * t);

function mount(host: HTMLElement, read: () => WavesProps): Engine | null {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const program = link(gl);
  const vao = gl.createVertexArray();
  const field = gl.createTexture();
  if (!program || !vao || !field) {
    if (program) gl.deleteProgram(program);
    if (vao) gl.deleteVertexArray(vao);
    if (field) gl.deleteTexture(field);
    return null;
  }
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
  host.appendChild(canvas);

  const locations = new Map<string, WebGLUniformLocation | null>();
  const loc = (name: string) => {
    if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
    return locations.get(name) ?? null;
  };

  const releasers: Array<() => void> = [];
  const listen = (target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, type: string, fn: (e: never) => void) => {
    target.addEventListener(type, fn as EventListener);
    releasers.push(() => target.removeEventListener(type, fn as EventListener));
  };

  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reduceQuery.matches;

  let cfg = settingsOf(read());
  let width = 0, height = 0, pxRatio = 1;
  let radiusSpan = 0, lineCount = 0, sampleCount = 0;
  let cols = 1, rows = 1;
  let offsets = new Float32Array(2), speeds = new Float32Array(2), upload = new Float32Array(2);
  let fieldDirty = true;
  let raf = 0, last = 0;
  let clock = 0, flow = 0, introStart = -1;
  let visible = true, tabShown = !document.hidden, lost = false;
  const ripples: Ripple[] = [];
  const pointer = { x: 0, y: 0, sx: 0, sy: 0, inside: false, down: false, touch: false, fresh: false };

  const cap = () => Math.max(CAP_MIN, cfg.radius * CAP_OF_RADIUS);
  const interacting = () => cfg.interactive && !cfg.paused && !reduced;

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    const ratio = Math.min(cfg.dpr || window.devicePixelRatio || 1, MAX_DPR);
    width = w; height = h; pxRatio = ratio;
    canvas.width = Math.max(1, Math.round(w * ratio));
    canvas.height = Math.max(1, Math.round(h * ratio));
    cols = Math.ceil(w / CELL) + 2;
    rows = Math.ceil(h / CELL) + 2;
    offsets = new Float32Array(cols * rows * 2);
    speeds = new Float32Array(cols * rows * 2);
    upload = new Float32Array(cols * rows * 2);
    fieldDirty = true;
    gl.bindTexture(gl.TEXTURE_2D, field);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, cols, rows, 0, gl.RG, gl.FLOAT, upload);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    buildGeometry();
  }

  // cobre a área e uma margem maior que a amplitude e o raio de interação, também com rotação
  function buildGeometry() {
    const margin = cfg.amplitude * (1 + cfg.twist) + cap() + 2 * cfg.spacing + 40;
    radiusSpan = Math.hypot(width, height) / 2 + margin;
    lineCount = Math.ceil((2 * radiusSpan) / cfg.spacing) + 1;
    sampleCount = Math.ceil((2 * radiusSpan) / SAMPLE_STEP);
    while (lineCount * 2 * (sampleCount + 1) > VERTEX_BUDGET && sampleCount > MIN_SAMPLES) {
      sampleCount = Math.max(MIN_SAMPLES, Math.floor(sampleCount * 0.8));
    }
  }

  function springStep(dt: number): boolean {
    const zeta = 1 - 0.85 * cfg.bounce;
    const omega = 4 / (zeta * cfg.returnSeconds);
    const steps = clamp(Math.ceil((omega * dt) / SPRING_STEP_LIMIT), 1, MAX_SUBSTEPS);
    const h = dt / steps;
    let energy = 0;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < offsets.length; i++) {
        const v = (speeds[i] ?? 0) + (-omega * omega * (offsets[i] ?? 0) - 2 * zeta * omega * (speeds[i] ?? 0)) * h;
        speeds[i] = v;
        offsets[i] = (offsets[i] ?? 0) + v * h;
      }
    }
    for (let i = 0; i < offsets.length; i++) energy = Math.max(energy, Math.abs(offsets[i] ?? 0) + Math.abs(speeds[i] ?? 0) / omega);
    if (energy < SETTLE_EPSILON) { offsets.fill(0); speeds.fill(0); return false; }
    return true;
  }

  function push(dx: number, dy: number, dt: number) {
    const r = cfg.radius;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6 || dt <= 0) return;
    const gain = Math.min(dist / dt, POINTER_FULL_SPEED) / POINTER_FULL_SPEED;
    const amount = gain * cfg.strength * cap() * POINTER_PUSH * Math.min(dt * 60, 3);
    const c0 = Math.max(0, Math.floor((pointer.sx - r) / CELL)), c1 = Math.min(cols - 1, Math.ceil((pointer.sx + r) / CELL));
    const r0 = Math.max(0, Math.floor((pointer.sy - r) / CELL)), r1 = Math.min(rows - 1, Math.ceil((pointer.sy + r) / CELL));
    for (let j = r0; j <= r1; j++) {
      for (let i = c0; i <= c1; i++) {
        const t = 1 - Math.hypot(i * CELL - pointer.sx, j * CELL - pointer.sy) / r;
        if (t <= 0) continue;
        const k = (j * cols + i) * 2;
        const f = smooth01(t) * amount / dist;
        offsets[k] = (offsets[k] ?? 0) + dx * f;
        offsets[k + 1] = (offsets[k + 1] ?? 0) + dy * f;
      }
    }
  }

  let settling = false;
  function stepInteraction(dt: number) {
    if (!interacting()) {
      if (settling || ripples.length) { offsets.fill(0); speeds.fill(0); settling = false; ripples.length = 0; fieldDirty = true; }
      return;
    }
    const active = pointer.inside && (!pointer.touch || pointer.down);
    if (active) {
      const prevX = pointer.sx, prevY = pointer.sy;
      if (pointer.fresh) { pointer.sx = pointer.x; pointer.sy = pointer.y; pointer.fresh = false; }
      else {
        const k = 1 - Math.exp(-dt / POINTER_SMOOTH_SECONDS);
        pointer.sx += (pointer.x - pointer.sx) * k;
        pointer.sy += (pointer.y - pointer.sy) * k;
        push(pointer.sx - prevX, pointer.sy - prevY, dt);
        settling = true;
      }
    }
    if (settling) { settling = springStep(dt); fieldDirty = true; }
    const reach = Math.max(RIPPLE_MIN_REACH, RIPPLE_REACH_OF_DIAGONAL * Math.hypot(width, height));
    for (const rp of ripples) rp.r += RIPPLE_SPEED * dt;
    while (ripples.length && (ripples[0]?.r ?? 0) > reach) ripples.shift();
  }

  function uploadField() {
    for (let i = 0; i < offsets.length; i++) upload[i] = offsets[i] ?? 0;
    gl.bindTexture(gl.TEXTURE_2D, field);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RG, gl.FLOAT, upload);
    fieldDirty = false;
  }

  function introState(now: number): { front: number; amp: number; running: boolean } {
    if (!cfg.intro || reduced || cfg.paused) return { front: 2, amp: 1, running: false };
    if (introStart < 0) introStart = now;
    const t = clamp((now - introStart) / 1000 / INTRO_SECONDS, 0, 1);
    if (t >= 1) return { front: 2, amp: 1, running: false };
    const front = easeOutCubic(Math.min(1, t / INTRO_FRONT_SHARE)) * (1 + INTRO_FRONT_SOFT);
    return { front, amp: smooth01(clamp((t - INTRO_AMP_START) / (1 - INTRO_AMP_START), 0, 1)), running: true };
  }

  function draw(now: number): boolean {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!width || !height) return false;
    const intro = introState(now);
    if (fieldDirty) uploadField();
    const base = cfg.light ? darken(resolveColor(cfg.lineColor)) : resolveColor(cfg.lineColor);
    const accent = resolveColor(cfg.accentColor);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, field);
    const rad = (cfg.rotation * Math.PI) / 180;
    const dashPeriod = DASH_PERIOD_OF_SPACING * cfg.spacing;
    gl.uniform1i(loc('uField'), 0);
    gl.uniform2f(loc('uSize'), width, height);
    gl.uniform2f(loc('uGrid'), cols, rows);
    gl.uniform1f(loc('uCell'), CELL);
    gl.uniform1f(loc('uRadius'), radiusSpan);
    gl.uniform1f(loc('uLines'), lineCount);
    gl.uniform1f(loc('uSamples'), sampleCount);
    gl.uniform1f(loc('uSpacing'), cfg.spacing);
    gl.uniform1f(loc('uHalfW'), Math.max(cfg.lineWidth, 1) * 0.5 + 0.75);
    gl.uniform2f(loc('uRot'), Math.cos(rad), Math.sin(rad));
    gl.uniform1f(loc('uAmp'), cfg.amplitude);
    gl.uniform1f(loc('uScale'), cfg.scale);
    gl.uniform1f(loc('uTwist'), cfg.twist);
    gl.uniform1f(loc('uSeed'), cfg.variation);
    gl.uniform1f(loc('uFlow'), flow);
    gl.uniform1f(loc('uCap'), cap());
    gl.uniform1f(loc('uIntroAmp'), intro.amp);
    gl.uniform1f(loc('uIntroFront'), intro.front);
    const rip = new Float32Array(RIPPLE_MAX * 4);
    const reach = Math.max(RIPPLE_MIN_REACH, RIPPLE_REACH_OF_DIAGONAL * Math.hypot(width, height));
    ripples.slice(-RIPPLE_MAX).forEach((rp, i) => rip.set([rp.x, rp.y, rp.r, cfg.strength * (1 - rp.r / reach)], i * 4));
    gl.uniform4fv(loc('uRip'), rip);
    gl.uniform4f(loc('uLine'), base[0], base[1], base[2], base[3]);
    gl.uniform4f(loc('uAccent'), accent[0], accent[1], accent[2], accent[3]);
    gl.uniform1f(loc('uOpacity'), cfg.opacity);
    gl.uniform1f(loc('uWidth'), cfg.lineWidth);
    gl.uniform1f(loc('uFade'), cfg.fade);
    gl.uniform1f(loc('uDashed'), cfg.dashed ? 1 : 0);
    gl.uniform1f(loc('uDashPeriod'), dashPeriod);
    gl.uniform1f(loc('uDashShift'), flow * DASH_SPEED);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 2 * (sampleCount + 1), lineCount);
    return intro.running;
  }

  const flowing = () => !reduced && !cfg.paused;

  function frame(now: number) {
    raf = 0;
    if (lost) return;
    if (!visible || !tabShown) { last = 0; return; }
    const dt = last ? Math.min((now - last) / 1000, MAX_FRAME_DT) : 0;
    last = now;
    if (flowing()) { clock += dt; flow += dt * cfg.speed; }
    stepInteraction(dt);
    const introRunning = draw(now);
    const moving = flowing() && (cfg.speed > 0 || introRunning || settling || ripples.length > 0
      || (interacting() && pointer.inside && (!pointer.touch || pointer.down)));
    if (moving) raf = window.requestAnimationFrame(frame);
    else last = 0;
  }
  const schedule = () => { if (!raf && !lost) raf = window.requestAnimationFrame(frame); };
  const cancel = () => { if (raf) window.cancelAnimationFrame(raf); raf = 0; last = 0; };

  // ---- ponteiro: lido na janela, só vale dentro do contêiner ----
  function place(e: PointerEvent) {
    const box = host.getBoundingClientRect();
    pointer.x = e.clientX - box.left;
    pointer.y = e.clientY - box.top;
    pointer.inside = pointer.x >= 0 && pointer.y >= 0 && pointer.x <= box.width && pointer.y <= box.height;
    pointer.touch = e.pointerType === 'touch';
  }
  listen(window, 'pointermove', (e: PointerEvent) => {
    if (!interacting()) return;
    const was = pointer.inside;
    place(e);
    if (pointer.inside && !was) pointer.fresh = true;
    if (pointer.inside) schedule();
  });
  listen(window, 'pointerdown', (e: PointerEvent) => {
    if (!interacting()) return;
    place(e);
    if (!pointer.inside) return;
    pointer.down = true;
    pointer.fresh = true;
    if (cfg.ripples) { ripples.push({ x: pointer.x, y: pointer.y, r: 0 }); if (ripples.length > RIPPLE_MAX) ripples.shift(); }
    schedule();
  });
  const release = () => { pointer.down = false; if (pointer.touch) pointer.inside = false; };
  listen(window, 'pointerup', release);
  listen(window, 'pointercancel', release);
  listen(window, 'blur', () => { pointer.inside = false; pointer.down = false; });
  listen(document.documentElement, 'pointerleave', () => { pointer.inside = false; });

  // ---- observadores ----
  listen(document, 'visibilitychange', () => { tabShown = !document.hidden; if (tabShown) schedule(); else cancel(); });
  listen(canvas, 'webglcontextlost', (e: Event) => { e.preventDefault(); lost = true; cancel(); });
  listen(reduceQuery, 'change', () => { reduced = reduceQuery.matches; schedule(); });
  const resizer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(() => { resize(); schedule(); }) : null;
  resizer?.observe(host);
  const watcher = typeof window.IntersectionObserver === 'function'
    ? new window.IntersectionObserver((entries) => {
      visible = entries[entries.length - 1]?.isIntersecting ?? true;
      if (visible) schedule(); else cancel();
    })
    : null;
  watcher?.observe(host);

  resize();
  schedule();

  return {
    refresh() {
      const prev = cfg;
      cfg = settingsOf(read());
      if (cfg.dpr !== prev.dpr || host.clientWidth !== width || host.clientHeight !== height) resize();
      else buildGeometry();
      schedule();
    },
    destroy() {
      cancel();
      lost = true;
      for (const r of releasers) r();
      resizer?.disconnect();
      watcher?.disconnect();
      gl.deleteTexture(field);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    },
  };
}

function Waves(props: WavesProps) {
  const host = useRef<HTMLElement | null>(null);
  const latest = useRef<WavesProps>(props);
  const engine = useRef<Engine | null>(null);
  latest.current = props;

  useEffect(() => {
    if (!host.current) return undefined;
    engine.current = mount(host.current, () => latest.current);
    return () => { engine.current?.destroy(); engine.current = null; };
  }, []);
  useEffect(() => { engine.current?.refresh(); });

  return createElement('div', {
    ref: host,
    className: props.className,
    'aria-hidden': 'true',
    style: { position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', backgroundColor: props.backgroundColor ?? 'transparent', ...props.style },
  });
}

window.HadesFx = { ...window.HadesFx, Waves };
})();
