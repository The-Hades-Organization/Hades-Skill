/* Carga sob demanda dos efeitos que dependem do motion (vendor/motion.js, ~136 KB): nada disso entra no carregamento
 * inicial nem no pré-cache do sw.js. HadesFx.use('BellToggle'[, enabled]) devolve o componente quando chegou e null enquanto
 * carrega (ou se falhou): a página mostra o controle comum nesse intervalo e nunca fica sem ele. Só o que precisa do motion
 * o baixa. */
(() => {
const FILES = { BellToggle: 'bell-toggle', CodeSlots: 'code-slots', PromptBar: 'prompt-bar', NumberTicker: 'number-ticker', FadeContent: 'fade-content', RubberSegment: 'rubber-segment' };
const WITHOUT_MOTION = new Set(['NumberTicker', 'FadeContent']);
// enfeite puro (o dado aparece igual sem ele): nem baixa com movimento reduzido ou economia de dados
const DECORATIVE = new Set(['NumberTicker', 'FadeContent', 'RubberSegment']);
const pending = {};
const quiet = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  || !!(navigator as { connection?: { saveData?: boolean } }).connection?.saveData;

function loadScript(src) {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(src));
    document.head.appendChild(s);
  });
}

function ensure(name) {
  if (window.HadesFx?.[name]) return Promise.resolve();
  pending[name] ??= (async () => {
    if (!WITHOUT_MOTION.has(name) && !window.HadesFx?.motion) {
      const motion = await import('/ui/vendor/motion.js');
      window.HadesFx = { ...window.HadesFx, motion };
    }
    await loadScript(`/ui/fx/${FILES[name]}.js`);
  })();
  return pending[name];
}

function use(name, wanted = true) {
  const { useState, useEffect } = React;
  const enabled = wanted && !(DECORATIVE.has(name) && quiet());
  const [, bump] = useState(0);
  useEffect(() => {
    if (!enabled || window.HadesFx?.[name]) return undefined;
    let alive = true;
    ensure(name).then(() => { if (alive) bump((n) => n + 1); }).catch((e) => { delete pending[name]; console.error('fx:', name, e); });
    return () => { alive = false; };
  }, [name, enabled]);
  return enabled ? window.HadesFx?.[name] || null : null;
}

window.HadesFx = { ...window.HadesFx, use };
})();
