/* Abertura do painel: Waves ao fundo e o ícone do Hades em Metallic Paint por cima. A cada carregamento da página (F5 incluso), nunca com
 * prefers-reduced-motion nem sem WebGL2/economia de dados. Os dois efeitos (~50 KB) só são baixados quando a abertura
 * vai rodar; falha ou demora acima de LOAD_MS e o painel segue sem ela. Toque, clique ou tecla pulam. */
(() => {
const SHOW_MS = 2200;
const FADE_MS = 450;
const LOAD_MS = 3500;
const FX_SCRIPTS = ['/ui/fx/waves.js', '/ui/fx/metallic-paint.js'];

function shouldRun() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return false;
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; }
}

function loadScript(src) {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(src));
    document.head.appendChild(s);
  });
}

function Intro({ onDone }) {
  const { useEffect, useState } = React;
  const { Waves, MetallicPaint } = window.HadesFx;
  const dark = document.documentElement.classList.contains('dark');
  const phone = matchMedia('(max-width: 767px), (pointer: coarse)').matches;
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLeaving(true), SHOW_MS);
    const skip = () => setLeaving(true);
    addEventListener('keydown', skip, { once: true });
    return () => { clearTimeout(t); removeEventListener('keydown', skip); };
  }, []);
  useEffect(() => {
    if (!leaving) return undefined;
    const t = setTimeout(onDone, FADE_MS);
    return () => clearTimeout(t);
  }, [leaving, onDone]);
  const accent = dark ? 'oklch(0.586 0.253 17.585)' : 'oklch(0.514 0.222 16.935)';
  return <div role="presentation" onPointerDown={() => setLeaving(true)}
    style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'var(--background)', cursor: 'pointer',
      opacity: leaving ? 0 : 1, transition: `opacity ${FADE_MS}ms ease`, display: 'grid', placeItems: 'center' }}>
    <Waves lineColor={dark ? 'oklch(0.45 0.04 326)' : 'oklch(0.82 0.01 326)'} accentColor={accent} lightMode={!dark}
      spacing={phone ? 18 : 12} amplitude={phone ? 22 : 32} dpr={phone ? 1 : undefined} mouseInteraction={!phone}
      fade={0.35} opacity={dark ? 1 : 0.4} />
    <div style={{ position: 'relative', width: 'min(93vw, 480px)', aspectRatio: '1' }} aria-hidden="true">
      <MetallicPaint imageSrc="/ui/brand/hades-mark.svg" color="#ffc6df" dispersion={0.11} angle={46} density={1.4}
        lightMode={!dark}
        dpr={phone ? 1 : undefined} mouseTilt={phone ? 0 : 0.5} />
    </div>
    <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Abrindo o Hades</span>
  </div>;
}

function run() {
  if (!shouldRun()) return;
  // cobre o painel já, para não piscar o conteúdo antes dos efeitos chegarem
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:100;background:var(--background)';
  document.body.appendChild(host);
  const root = ReactDOM.createRoot(host);
  const finish = () => { try { root.unmount(); } catch (e) { /* já desmontado */ } host.remove(); };
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('intro: efeitos demoraram')), LOAD_MS));
  Promise.race([Promise.all(FX_SCRIPTS.map(loadScript)), timeout])
    .then(() => root.render(<Intro onDone={finish} />))
    .catch(() => finish());
}

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', run, { once: true }); else run();
})();
