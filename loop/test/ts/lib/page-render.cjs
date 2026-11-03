// Renderiza uma página do painel (kit/panel/ui/pages/<id>.tsx) com a resposta do servidor dada, sem navegador: React falso
// (a árvore do htm é expandida à mão), HadesCore de mentira e hooks sobre uma lista de posições.
//   bun page_render.js <pagina.tsx> <id-registrado> '<json da resposta>' [props-json]
// Imprime "ok" ou "erro: <mensagem>". Resposta de campo ausente tem de renderizar, não lançar.
const fs = require('fs');
const [, , file, id, payload, propsJson] = process.argv;
const htm = require('../../../../kit/panel/ui/vendor/htm.js');
const h = (type, props, ...children) => ({ type, props: props || {}, children });
const html = htm.bind(h);
let slots = [], at = 0, effects = [], pages = {};
const fresh = () => ({ slots: [], at: 0 });
let ctx = fresh();
const comp = (name) => ({ [name]: ({ children }) => children ?? null })[name];
const core = new Proxy({
  html, CFG_ICON: {}, I: new Proxy({}, { get: (_, k) => comp(String(k)) }),
  useState: (init) => { const c = ctx, i = c.at++; if (!(i in c.slots)) c.slots[i] = typeof init === 'function' ? init() : init;
    return [c.slots[i], (v) => { c.slots[i] = typeof v === 'function' ? v(c.slots[i]) : v; }]; },
  useEffect: (f) => { if (!ctx.ran) effects.push(f); },
  useMemo: (f) => f(), useCallback: (f) => f, useRef: () => ({ current: null }), useId: () => 'id',
  useApp: () => ({ toast() {}, openLog() {} }), useActions: () => () => {},
  getJSON: () => Promise.resolve(JSON.parse(payload)), post: () => Promise.resolve({}),
  cn: (...a) => a.filter(Boolean).join(' '), ago: () => '', dt: () => '',
  registerPage: (pid, Comp) => { pages[pid] = Comp; },
}, { get: (t, k) => (k in t ? t[k] : comp(String(k))) });
globalThis.React = { Component: class {}, createElement: h };
globalThis.window = globalThis; globalThis.HadesCore = core;
globalThis.document = { addEventListener() {}, createElement: () => ({}) };
const expand = (n, depth = 0) => {
  if (depth > 40) throw new Error('árvore funda demais');
  if (Array.isArray(n)) return n.forEach((x) => expand(x, depth + 1));
  if (!n || typeof n !== 'object' || !('type' in n)) return;
  const kids = n.children;
  if (typeof n.type === 'function') {
    const saved = ctx; if (n.type !== pages[id]) ctx = fresh();
    try { expand(n.type({ ...n.props, children: kids.length === 1 ? kids[0] : kids }), depth + 1); } finally { ctx = saved; }
  } else kids.forEach((x) => expand(x, depth + 1));
  Object.values(n.props).forEach((v) => v && typeof v === 'object' && expand(v, depth + 1));
};
(async () => {
  try {
    new Function(`with (globalThis) { const {${Object.keys(core).join(',')}} = HadesCore; }`);
    (0, eval)(new Bun.Transpiler({ loader: 'tsx', tsconfig: { compilerOptions: { jsx: 'react' } } }).transformSync(fs.readFileSync(file, 'utf8')));
    const Page = pages[id]; if (!Page) throw new Error(`página ${id} não se registrou`);
    const props = propsJson ? JSON.parse(propsJson) : {};
    ctx = fresh(); const run = () => { ctx.at = 0; expand(h(Page, props)); };
    run(); const fx = effects.splice(0); ctx.ran = true;
    fx.forEach((f) => f()); await new Promise((r) => setTimeout(r, 20));
    run(); console.log('ok'); process.exit(0);
  } catch (e) { console.log(`erro: ${e.message}`); process.exit(0); }
})();
