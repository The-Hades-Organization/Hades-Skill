/* Metallic Paint: pinta uma silhueta (imagem ou texto) como cromo líquido em WebGL2. A silhueta vira uma textura de duas
 * camadas (cobertura e profundidade até a borda); o shader desenha faixas claras e escuras que escoam e acompanham o
 * contorno. Sem WebGL2 não desenha nada e não lança. Exposto em window.HadesFx.MetallicPaint; só a abertura o usa. */
(() => {
const { useEffect, useRef } = React;

// ---- constantes do efeito
const MAX_MASK_SIDE = 1024;
const MIN_PIXEL_DENSITY = 2;
const MAX_PIXEL_DENSITY = 2;
const MAX_PIXELS = 8.2e6;
const SMALL_BOX_PX = 500;
const FLOW_PER_SECOND = 0.3;
const INTRO_MS = 1600;
const INTRO_BOOST = 2.4;
const FADE_IN_SHARE = 0.25;
const TILT_LIMIT = 1.2;
const SPRING_STIFFNESS = 180;
const SPRING_DAMPING = 13.4;
const SPRING_STEP = 1 / 120;
const SPRING_REST = 0.001;
const OPAQUE_LUMA = 220;
const CLEAR_LUMA = 250;
const TEXT_MARGIN = 0.12;
const TEXT_PROBE_PX = 100;
const MIN_DENSITY = 0.5;
const MAX_DENSITY = 12;
const MIN_SCALE = 0.05;
const MAX_FRAME_GAP = 0.1;

type Mask = { width: number; height: number; data: Uint8Array };
type Rgba = [number, number, number, number];

interface Params {
  imageSrc: string; text: string; fontFamily: string; fontWeight: number;
  color: string; backgroundColor: string;
  density: number; softness: number; dispersion: number; distortion: number; edgeBend: number;
  angle: number; scale: number; rotation: number; lightMode: boolean;
  speed: number; mouseTilt: number; intro: boolean; paused: boolean;
  dpr: number | undefined; className: string; style: Record<string, unknown>;
}

interface Engine {
  setParams(next: Params): void;
  setMask(mask: Mask | null): void;
  destroy(): void;
}

// ---- entrada: valida na fronteira, o resto trabalha com tipos certos
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

function readParams(raw: Record<string, unknown>): Params {
  const dpr = raw.dpr;
  return {
    imageSrc: str(raw.imageSrc, ''), text: str(raw.text, ''),
    fontFamily: str(raw.fontFamily, 'system-ui, sans-serif'), fontWeight: num(raw.fontWeight, 800, 1, 1000),
    color: str(raw.color, '#ffffff'), backgroundColor: str(raw.backgroundColor, 'transparent'),
    density: num(raw.density, 2, MIN_DENSITY, MAX_DENSITY), softness: num(raw.softness, 0.1, 0, 1),
    dispersion: num(raw.dispersion, 0.3, -1, 1), distortion: num(raw.distortion, 0.07, 0, 1),
    edgeBend: num(raw.edgeBend, 0.6, 0, 1), angle: num(raw.angle, 70, -3600, 3600),
    scale: num(raw.scale, 0.6, MIN_SCALE, 10), rotation: num(raw.rotation, 0, -3600, 3600),
    lightMode: flag(raw.lightMode, false), speed: num(raw.speed, 1, 0, 100), mouseTilt: num(raw.mouseTilt, 0.5, 0, 1.5),
    intro: flag(raw.intro, true), paused: flag(raw.paused, false),
    dpr: typeof dpr === 'number' && dpr > 0 ? dpr : undefined,
    className: str(raw.className, ''),
    style: typeof raw.style === 'object' && raw.style !== null ? (raw.style as Record<string, unknown>) : {},
  };
}

// ---- silhueta: raster -> cobertura + profundidade
function newCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('imagem não carregou'));
    img.src = src;
  });
}

async function rasterizeImage(src: string) {
  const img = await loadImage(src);
  const vector = /\.svg([?#]|$)/i.test(src) || /^data:image\/svg/i.test(src);
  const nw = img.naturalWidth || MAX_MASK_SIDE / 2, nh = img.naturalHeight || MAX_MASK_SIDE / 2;
  const k = vector ? MAX_MASK_SIDE / Math.max(nw, nh) : Math.min(1, MAX_MASK_SIDE / Math.max(nw, nh));
  const canvas = newCanvas(Math.max(1, Math.round(nw * k)), Math.max(1, Math.round(nh * k)));
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function rasterizeText(text: string, family: string, weight: number) {
  const font = (px: number) => `${weight} ${px}px ${family}`;
  await document.fonts.load(font(TEXT_PROBE_PX), text);
  const probe = newCanvas(1, 1).getContext('2d');
  if (!probe) return null;
  probe.font = font(TEXT_PROBE_PX);
  const measured = Math.max(1, probe.measureText(text).width);
  const w = MAX_MASK_SIDE;
  const px = (TEXT_PROBE_PX * w * (1 - 2 * TEXT_MARGIN)) / measured;
  const h = Math.max(1, Math.round(px * 1.3 + w * TEXT_MARGIN * 0.5));
  const canvas = newCanvas(w, Math.min(h, MAX_MASK_SIDE));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = font(Math.min(px, canvas.height / 1.3));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.fillText(text, w / 2, canvas.height / 2);
  return canvas;
}

// Imagem sem transparência usa a luminosidade; com transparência, o alfa. Profundidade = distância à borda (chanfro 3-4).
function buildMask(canvas: HTMLCanvasElement): Mask | null {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const px = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  let hasAlpha = false;
  for (let i = 0; i < n; i++) if (px[i * 4 + 3] < 250) { hasAlpha = true; break; }
  const cover = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (hasAlpha) { cover[i] = px[i * 4 + 3] / 255; continue; }
    const luma = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    cover[i] = clamp((CLEAR_LUMA - luma) / (CLEAR_LUMA - OPAQUE_LUMA), 0, 1);
  }
  const far = 1e9;
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = cover[i] >= 0.5 ? far : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 3);
      if (y > 0) {
        d = Math.min(d, dist[i - w] + 3);
        if (x > 0) d = Math.min(d, dist[i - w - 1] + 4);
        if (x < w - 1) d = Math.min(d, dist[i - w + 1] + 4);
      }
      dist[i] = d;
    }
  }
  let deepest = 1;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      let d = dist[i];
      if (x < w - 1) d = Math.min(d, dist[i + 1] + 3);
      if (y < h - 1) {
        d = Math.min(d, dist[i + w] + 3);
        if (x < w - 1) d = Math.min(d, dist[i + w + 1] + 4);
        if (x > 0) d = Math.min(d, dist[i + w - 1] + 4);
      }
      dist[i] = d;
      if (d < far && d > deepest) deepest = d;
    }
  }
  const data = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    data[i * 2] = Math.round(cover[i] * 255);
    data[i * 2 + 1] = dist[i] >= far ? 255 : Math.round((dist[i] / deepest) * 255);
  }
  return { width: w, height: h, data };
}

async function loadMask(p: Pick<Params, 'imageSrc' | 'text' | 'fontFamily' | 'fontWeight'>): Promise<Mask | null> {
  try {
    const canvas = p.text ? await rasterizeText(p.text, p.fontFamily, p.fontWeight) : p.imageSrc ? await rasterizeImage(p.imageSrc) : null;
    return canvas ? buildMask(canvas) : null;
  } catch (e) {
    return null; // fonte ilegível ou sem permissão: nada é desenhado, como a spec manda
  }
}

// ---- cor: o navegador resolve (var(), color-mix, oklch); um canvas 1x1 devolve o pixel
function resolveColor(css: string, host: HTMLElement): Rgba {
  const ctx = newCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  if (!ctx) return [1, 1, 1, 1];
  let value = css;
  if (css.includes('var(')) {
    host.style.color = css;
    value = getComputedStyle(host).color;
    host.style.color = '';
  }
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255, a / 255];
}

// ---- shaders
const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uMask;
uniform vec2 uRes;
uniform vec2 uFig;
uniform vec2 uRot;
uniform float uTime;
uniform float uAngle;
uniform float uDensity;
uniform float uSoft;
uniform float uDisp;
uniform float uDist;
uniform float uBend;
uniform float uLight;
uniform float uIntro;
uniform vec2 uTilt;
uniform vec4 uTint;
uniform vec4 uBg;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float band(float q, float aa) {
  float tri = abs(fract(q * 2.0) - 0.5) * 2.0;
  float w = uSoft * 0.5 + aa;
  float sharp = smoothstep(0.5 - w, 0.5 + w, tri);
  float broad = 0.5 + 0.5 * sin(q * 5.0);
  return mix(broad, sharp, 0.65);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) - 0.5 * uRes;
  p = vec2(uRot.x * p.x + uRot.y * p.y, -uRot.y * p.x + uRot.x * p.y);
  vec2 uv = p / uFig + 0.5;
  vec2 m = texture(uMask, clamp(uv, 0.0, 1.0)).rg;
  bool inside = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
  float cover = inside ? m.r : 0.0;
  float depth = m.g;

  vec2 dir = vec2(cos(uAngle), sin(uAngle));
  float lin = dot(uv - 0.5, dir) * 1.3 + 0.5;
  float ring = pow(depth, 0.65) * 1.6;
  float q = mix(lin, ring, uBend) * uDensity;
  q += (vnoise(uv * 2.5 + vec2(uTime * ${FLOW_PER_SECOND}, -uTime * 0.2)) - 0.5) * uDist * 3.0 * uDensity;
  q += uTime * 0.12 + uTilt.x * 0.15 * uDensity + uTilt.y * 0.12 * uDensity;

  float aa = fwidth(q * 2.0);
  float shift = uDisp * 0.05 * (1.0 + (1.0 - depth) * 2.0) * uDensity;
  vec3 bands = vec3(band(q + shift, aa), band(q, aa), band(q - shift, aa));

  vec3 lightCol = mix(vec3(0.94, 0.96, 1.0), vec3(0.78, 0.8, 0.84), uLight);
  vec3 darkCol = vec3(0.1, 0.1, 0.1 + 0.1 * clamp((uv.x + uv.y) * 0.5, 0.0, 1.0));
  vec3 col = mix(darkCol, lightCol, bands);
  col *= mix(vec3(1.0), uTint.rgb, 0.45 * uTint.a);
  col *= 1.0 + (uTint.a - 1.0) * 0.3;
  float rim = 1.0 - smoothstep(0.0, 0.18, depth);
  col.rg *= mix(1.0, mix(1.0, 0.62, rim), uLight);
  col.b *= mix(1.0, mix(1.0, 0.58, rim), uLight);
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;

  float x = clamp(uIntro, 0.0, 1.0);
  float e = 1.0 - pow(1.0 - x, 3.0);
  float shown = 1.0 - smoothstep(e * 1.2 - 0.08, e * 1.2, depth);
  float fa = cover * shown * smoothstep(0.0, ${FADE_IN_SHARE}, x);
  outColor = vec4(clamp(col, 0.0, 1.0) * fa, fa) + uBg * (1.0 - fa);
}`;

// ---- motor: um contexto por montagem; tudo que abre aqui fecha em destroy()
function createEngine(host: HTMLElement): Engine {
  const noop: Engine = { setParams() {}, setMask() {}, destroy() {} };
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  let gl: WebGL2RenderingContext | null = null;
  try { gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false }); } catch (e) { gl = null; }
  if (!gl) return noop;
  const ctx = gl;

  const compile = (type: number, src: string) => {
    const s = ctx.createShader(type);
    if (!s) return null;
    ctx.shaderSource(s, src);
    ctx.compileShader(s);
    return ctx.getShaderParameter(s, ctx.COMPILE_STATUS) ? s : null;
  };
  const vs = compile(ctx.VERTEX_SHADER, VERT), fs = compile(ctx.FRAGMENT_SHADER, FRAG);
  const program = vs && fs ? ctx.createProgram() : null;
  if (!program || !vs || !fs) { ctx.getExtension('WEBGL_lose_context')?.loseContext(); return noop; }
  ctx.attachShader(program, vs);
  ctx.attachShader(program, fs);
  ctx.linkProgram(program);
  if (!ctx.getProgramParameter(program, ctx.LINK_STATUS)) { ctx.getExtension('WEBGL_lose_context')?.loseContext(); return noop; }
  ctx.useProgram(program);
  host.appendChild(canvas);

  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const loc = (name: string) => {
    if (!uniforms.has(name)) uniforms.set(name, ctx.getUniformLocation(program, name));
    return uniforms.get(name) ?? null;
  };
  const texture = ctx.createTexture();

  let params: Params | null = null;
  let mask: Mask | null = null;
  let tint: Rgba = [1, 1, 1, 1];
  let bg: Rgba = [0, 0, 0, 0];
  let colorKey = '';
  let raf = 0;
  let dirty = true;
  let dead = false;
  let visible = true;
  let tabShown = true;
  let reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let time = 0;
  let last = 0;
  let introStart = -1;
  let introDone = true;
  const tilt = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };

  const animated = () => !!params && !params.paused && params.speed > 0 && !reduced;
  const springMoving = () => Math.abs(tilt.x - tilt.tx) > SPRING_REST || Math.abs(tilt.y - tilt.ty) > SPRING_REST
    || Math.abs(tilt.vx) > SPRING_REST * 10 || Math.abs(tilt.vy) > SPRING_REST * 10;
  const wantsFrame = () => !dead && visible && tabShown && !!mask && (dirty || animated() || !introDone || springMoving());
  const schedule = () => { if (!raf && wantsFrame()) raf = requestAnimationFrame(frame); };

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (w <= 0 || h <= 0) return;
    let d = Math.max(MIN_PIXEL_DENSITY, params?.dpr ?? Math.min(window.devicePixelRatio || 1, MAX_PIXEL_DENSITY));
    if (w * h * d * d > MAX_PIXELS) d *= Math.sqrt(MAX_PIXELS / (w * h * d * d));
    const cw = Math.max(1, Math.round(w * d)), ch = Math.max(1, Math.round(h * d));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    ctx.viewport(0, 0, cw, ch);
    dirty = true;
    schedule();
  }

  function stepSpring(dt: number) {
    for (let left = dt; left > 0; left -= SPRING_STEP) {
      const h = Math.min(SPRING_STEP, left);
      tilt.vx += (SPRING_STIFFNESS * (tilt.tx - tilt.x) - SPRING_DAMPING * tilt.vx) * h;
      tilt.vy += (SPRING_STIFFNESS * (tilt.ty - tilt.y) - SPRING_DAMPING * tilt.vy) * h;
      tilt.x += tilt.vx * h;
      tilt.y += tilt.vy * h;
    }
    if (!springMoving()) { tilt.x = tilt.tx; tilt.y = tilt.ty; tilt.vx = 0; tilt.vy = 0; }
  }

  function draw(introProgress: number) {
    if (!params || !mask) return;
    const cw = canvas.width, ch = canvas.height;
    const fit = Math.min(cw / mask.width, ch / mask.height) * params.scale;
    const rot = (params.rotation * Math.PI) / 180;
    ctx.useProgram(program);
    ctx.activeTexture(ctx.TEXTURE0);
    ctx.bindTexture(ctx.TEXTURE_2D, texture);
    ctx.uniform1i(loc('uMask'), 0);
    ctx.uniform2f(loc('uRes'), cw, ch);
    ctx.uniform2f(loc('uFig'), mask.width * fit, mask.height * fit);
    ctx.uniform2f(loc('uRot'), Math.cos(rot), Math.sin(rot));
    ctx.uniform1f(loc('uTime'), time + Math.hypot(tilt.x, tilt.y) * 0.1);
    ctx.uniform1f(loc('uAngle'), (params.angle * Math.PI) / 180);
    ctx.uniform1f(loc('uDensity'), params.density);
    ctx.uniform1f(loc('uSoft'), params.softness + (Math.min(host.clientWidth, host.clientHeight) < SMALL_BOX_PX ? 0.04 : 0));
    ctx.uniform1f(loc('uDisp'), params.dispersion);
    ctx.uniform1f(loc('uDist'), params.distortion);
    ctx.uniform1f(loc('uBend'), params.edgeBend);
    ctx.uniform1f(loc('uLight'), params.lightMode ? 1 : 0);
    ctx.uniform1f(loc('uIntro'), introProgress);
    ctx.uniform2f(loc('uTilt'), tilt.x, tilt.y);
    ctx.uniform4f(loc('uTint'), tint[0], tint[1], tint[2], tint[3]);
    ctx.uniform4f(loc('uBg'), bg[0] * bg[3], bg[1] * bg[3], bg[2] * bg[3], bg[3]);
    ctx.clearColor(0, 0, 0, 0);
    ctx.clear(ctx.COLOR_BUFFER_BIT);
    ctx.drawArrays(ctx.TRIANGLES, 0, 3);
  }

  function frame(now: number) {
    raf = 0;
    if (!wantsFrame() || !params) return;
    const dt = last ? Math.min((now - last) / 1000, MAX_FRAME_GAP) : 0;
    last = now;
    stepSpring(dt);
    let progress = 1, boost = 1;
    if (!introDone) {
      if (introStart < 0) introStart = now;
      progress = clamp((now - introStart) / INTRO_MS, 0, 1);
      boost = 1 + INTRO_BOOST * (1 - progress) ** 2;
      if (progress >= 1) introDone = true;
    }
    if (animated()) time += dt * params.speed * boost;
    dirty = false;
    draw(progress);
    if (wantsFrame()) raf = requestAnimationFrame(frame); else last = 0;
  }

  function uploadMask(next: Mask) {
    ctx.bindTexture(ctx.TEXTURE_2D, texture);
    ctx.pixelStorei(ctx.UNPACK_ALIGNMENT, 1);
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RG8, next.width, next.height, 0, ctx.RG, ctx.UNSIGNED_BYTE, next.data);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
  }

  // ponteiro dentro do contêiner inclina o reflexo; a mola do tilt faz o resto
  function onPointerMove(e: PointerEvent) {
    if (!params || params.mouseTilt <= 0 || reduced) return;
    const r = host.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    tilt.tx = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -TILT_LIMIT, TILT_LIMIT) * params.mouseTilt;
    tilt.ty = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -TILT_LIMIT, TILT_LIMIT) * params.mouseTilt;
    schedule();
  }
  function onPointerLeave() { tilt.tx = 0; tilt.ty = 0; schedule(); }
  function onVisibility() { tabShown = document.visibilityState !== 'hidden'; last = 0; schedule(); }
  function onContextLost(e: Event) { e.preventDefault(); dead = true; if (raf) cancelAnimationFrame(raf); raf = 0; }
  function onMotionChange(e: MediaQueryListEvent) { reduced = e.matches; dirty = true; schedule(); }

  const resizeObs = new ResizeObserver(resize);
  const viewObs = new IntersectionObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (entry) { visible = entry.isIntersecting; last = 0; schedule(); }
  });
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  resizeObs.observe(host);
  viewObs.observe(host);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onContextLost);
  motionQuery.addEventListener?.('change', onMotionChange);
  resize();

  return {
    setParams(next) {
      const firstTime = params === null;
      const key = `${next.color}|${next.backgroundColor}`;
      if (key !== colorKey) { colorKey = key; tint = resolveColor(next.color, host); bg = resolveColor(next.backgroundColor, host); }
      const densityChanged = params?.dpr !== next.dpr;
      params = next;
      if (firstTime) introDone = !next.intro || next.paused || reduced;
      if (next.mouseTilt <= 0) { tilt.tx = 0; tilt.ty = 0; }
      if (densityChanged && !firstTime) resize();
      dirty = true;
      schedule();
    },
    setMask(next) {
      mask = next;
      if (next) {
        uploadMask(next);
        introStart = -1;
        introDone = !params?.intro || !!params?.paused || reduced;
      }
      dirty = true;
      if (!next) { ctx.clearColor(0, 0, 0, 0); ctx.clear(ctx.COLOR_BUFFER_BIT); }
      schedule();
    },
    destroy() {
      dead = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      resizeObs.disconnect();
      viewObs.disconnect();
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      motionQuery.removeEventListener?.('change', onMotionChange);
      ctx.deleteTexture(texture);
      ctx.deleteProgram(program);
      ctx.deleteShader(vs);
      ctx.deleteShader(fs);
      ctx.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    },
  };
}

function MetallicPaint(raw: Record<string, unknown>) {
  const p = readParams(raw);
  const host = useRef<HTMLDivElement | null>(null);
  const engine = useRef<Engine | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const created = createEngine(el);
    engine.current = created;
    return () => { created.destroy(); engine.current = null; };
  }, []);

  // aparência e movimento valem ao vivo: o motor só reage ao que mudou
  useEffect(() => { engine.current?.setParams(p); });

  useEffect(() => {
    const target = engine.current;
    if (!target) return undefined;
    let current = true;
    target.setMask(null);
    loadMask(p).then((mask) => { if (current) target.setMask(mask); });
    return () => { current = false; };
  }, [p.imageSrc, p.text, p.fontFamily, p.fontWeight]);

  return <div ref={host} className={p.className} aria-hidden="true"
    style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', ...p.style }} />;
}

window.HadesFx = { ...window.HadesFx, MetallicPaint };
})();
