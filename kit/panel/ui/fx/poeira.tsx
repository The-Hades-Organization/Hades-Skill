/* Poeira: grãos finos na cor de destaque subindo devagar no ar, entre a névoa (body::before) e o conteúdo (#root), e a
 * rajada de grãos em que um elemento se desfaz ao sair. Canvas 2D próprio, sem dependência. O quadro só roda com a aba
 * visível e com grão vivo, no máximo a cada QUADRO_MS; com movimento reduzido ou economia de dados a camada ambiente é
 * desenhada uma vez e nada se move nem se emite. Exposto em window.HadesPoeira: emitir(el, modo) e graos(). */
(() => {
// desfazer: grãos sobem e se espalham (o aviso que sai); apagar: grãos assentam devagar, metade apagada (o que parou)
type Modo = 'desfazer' | 'apagar';
interface GraoAmbiente { x: number; y: number; r: number; a: number; f: number; v: number }
interface GraoRajada extends GraoAmbiente { modo: Modo; vx: number; vy: number; cor: string; vida: number; d: number; t0: number }
type PoeiraApi = HadesPoeiraApi;

const DENSIDADE = 3;
const GRAO = 0.5;
// um grão a cada 24000 px² de tela (por unidade de densidade), com teto para a tela grande não pesar
const AREA_POR_GRAO = 24000;
const TETO_AMBIENTE = 48;
const TETO_RAJADA = 600;
// o grão anda ~8 px/s: 25 quadros/s bastam, e o timer evita puxar um quadro do documento a cada vsync
const QUADRO_MS = 40;
const DT_MAX = 64;
// a rajada passa por cima dos avisos (z 60) e fica abaixo do tooltip (z 70)
const Z_RAJADA = 65;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const movimentoReduzido = matchMedia('(prefers-reduced-motion: reduce)');
const economia = () => !!(navigator as { connection?: { saveData?: boolean } }).connection?.saveData;
const parado = () => movimentoReduzido.matches || economia();

function novaCamada(z: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  const c = document.createElement('canvas');
  c.setAttribute('aria-hidden', 'true');
  c.style.cssText = `position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:${z}`;
  const ctx = c.getContext('2d');
  return ctx ? [c, ctx] : null;
}

function iniciar(): PoeiraApi | null {
  const ambiente = novaCamada(0);
  if (!ambiente) return null;
  const [canvasA, ca] = ambiente;
  document.body.insertBefore(canvasA, document.getElementById('root'));
  let rajada: [HTMLCanvasElement, CanvasRenderingContext2D] | null = null;
  let w = 0, h = 0, dpr = 1, raf = 0, espera = 0, ultimo = 0;
  let amb: GraoAmbiente[] = [], vivas: GraoRajada[] = [];
  let corDestaque = '';

  const lerCor = (el: Element, nome: string) => getComputedStyle(el).getPropertyValue(nome).trim();
  // a cor só muda com o tema (classe .dark no <html>): lida uma vez por troca, não a cada quadro
  const atualizarCor = () => { corDestaque = lerCor(document.documentElement, '--primary') || '#ffc6df'; };

  const semear = () => {
    const n = Math.round(Math.min(TETO_AMBIENTE * DENSIDADE, (w * h) * DENSIDADE / AREA_POR_GRAO));
    amb = Array.from({ length: n }, () => ({ x: rnd(0, w), y: rnd(0, h), r: rnd(0.7, 2.4) * GRAO, a: rnd(0.1, 0.34), f: rnd(0, 6.28), v: rnd(0.6, 1.4) }));
  };

  const pintarAmbiente = (t: number, dt: number, mover: boolean) => {
    ca.clearRect(0, 0, w, h);
    ca.fillStyle = corDestaque;
    for (const p of amb) {
      if (mover) {
        p.y -= 0.008 * p.v * dt;
        p.x += Math.sin(t / 2300 + p.f) * 0.008 * dt;
        if (p.y < -4) p.y = h + 4;
        if (p.x > w + 4) p.x = -4; else if (p.x < -4) p.x = w + 4;
      }
      ca.globalAlpha = p.a * (0.55 + 0.45 * Math.sin(t / 900 + p.f));
      ca.beginPath(); ca.arc(p.x, p.y, p.r, 0, 6.2832); ca.fill();
    }
    ca.globalAlpha = 1;
  };

  const pintarRajada = (t: number, dt: number) => {
    if (!rajada) return;
    const cf = rajada[1];
    cf.clearRect(0, 0, w, h);
    vivas = vivas.filter((p) => t - p.t0 - p.d < p.vida);
    for (const p of vivas) {
      const idade = t - p.t0 - p.d;
      if (idade < 0) continue;
      if (p.modo === 'apagar') { p.vy += 0.00004 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
      else { p.x += (p.vx + Math.sin(idade / 320 + p.f) * 0.02) * dt; p.y += p.vy * dt; }
      cf.globalAlpha = Math.pow(1 - idade / p.vida, 1.4) * p.a;
      cf.fillStyle = p.cor;
      if (p.modo === 'apagar') cf.fillRect(p.x, p.y, p.r * 1.6, p.r * 1.6);
      else { cf.beginPath(); cf.arc(p.x, p.y, p.r, 0, 6.2832); cf.fill(); }
    }
    cf.globalAlpha = 1;
  };

  const quadro = (agora: number) => {
    raf = 0;
    if (document.hidden) return;
    const dt = Math.min(DT_MAX, agora - (ultimo || agora - QUADRO_MS));
    ultimo = agora;
    const mover = !parado();
    pintarAmbiente(agora, dt, mover);
    pintarRajada(agora, dt);
    if (mover && (amb.length || vivas.length)) espera = window.setTimeout(proximo, QUADRO_MS);
  };
  const proximo = () => { espera = 0; raf = requestAnimationFrame(quadro); };
  // um quadro pendente por vez: o pedido que chega com um já agendado não duplica o laço
  const rodar = () => { if (!raf && !espera && !document.hidden) raf = requestAnimationFrame(quadro); };
  // volta da aba oculta sem o salto do tempo parado
  const aoMudarVisibilidade = () => { ultimo = 0; rodar(); };

  const dimensionar = (c: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const medir = () => {
    w = innerWidth; h = innerHeight; dpr = Math.min(devicePixelRatio || 1, 2);
    dimensionar(canvasA, ca);
    if (rajada) dimensionar(rajada[0], rajada[1]);
    semear(); rodar();
  };
  const aoMudarTema = () => { atualizarCor(); rodar(); };
  const tema = new MutationObserver(aoMudarTema);

  atualizarCor();
  medir();
  addEventListener('resize', medir);
  document.addEventListener('visibilitychange', aoMudarVisibilidade);
  movimentoReduzido.addEventListener('change', rodar);
  tema.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  return {
    graos: () => amb.length,
    emitir: (el, modo = 'desfazer') => {
      if (parado() || !w) return false;
      if (!rajada) {
        rajada = novaCamada(Z_RAJADA);
        if (!rajada) return false;
        document.body.appendChild(rajada[0]);
        dimensionar(rajada[0], rajada[1]);
      }
      const r = el.getBoundingClientRect();
      const k = lerCor(el, '--k') || corDestaque, corApagada = lerCor(document.documentElement, '--muted-foreground');
      const n = Math.min(150 * DENSIDADE, Math.round((r.width * r.height) * DENSIDADE / 120)), t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const fx = Math.random();
        const base = { x: r.left + fx * r.width, y: r.top + rnd(0, r.height), r: rnd(0.8, 2.2) * GRAO, d: fx * 320 + rnd(0, 120), t0, v: 1 };
        vivas.push(modo === 'apagar'
          ? { ...base, modo, vx: rnd(-0.01, 0.05), vy: rnd(-0.03, 0.01), a: rnd(0.5, 0.95), cor: Math.random() < 0.4 ? k : corApagada, vida: rnd(1100, 2200), f: 0 }
          : { ...base, modo, vx: rnd(-0.01, 0.025), vy: -rnd(0.01, 0.045), a: rnd(0.4, 0.9), cor: k, vida: rnd(1000, 2000), f: rnd(0, 6.28) });
      }
      if (vivas.length > TETO_RAJADA * DENSIDADE) vivas.splice(0, vivas.length - TETO_RAJADA * DENSIDADE);
      rodar();
      return true;
    },
    encerrar: () => {
      if (raf) cancelAnimationFrame(raf);
      if (espera) clearTimeout(espera);
      raf = 0; espera = 0;
      removeEventListener('resize', medir);
      document.removeEventListener('visibilitychange', aoMudarVisibilidade);
      movimentoReduzido.removeEventListener('change', rodar);
      tema.disconnect();
      canvasA.remove();
      rajada?.[0].remove();
      rajada = null;
      vivas = []; amb = [];
    },
  };
}

function montar() {
  const api = iniciar();
  if (api) window.HadesPoeira = api;
}

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', montar, { once: true }); else montar();
})();
