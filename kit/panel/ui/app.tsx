/* Painel do Hades — React + htm (sem build), componentes no padrão do shadcn/ui, ícones lucide-react.
 * Lê /api/snapshot (o servidor amostra a cada 3 s) e dispara ações em /api/action, que chamam os scripts do kit.
 * Este arquivo é a base: primitivas, componentes que mais de uma página usa, sidebar, rota, App e a API dos plugins.
 * Cada página do núcleo mora em ui/pages/<id>.js (carregada pelo index.html) e se registra por HadesCore.registerPage. */
(() => {
const { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext, useId, Fragment } = React;
// `html` (htm) só existe para os scripts do plugin do projeto (contrato HadesPanel até a 5.0.0); o painel usa JSX
const html = htm.bind(React.createElement);
// ícone próprio do Cerberus (ui/brand/cerberus.svg, só a figura): em currentColor, segue tema e estado como os do lucide
const Cerberus = (props) => React.createElement('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 188 188', width: 24, height: 24,
  fill: 'currentColor', fillRule: 'evenodd', 'aria-hidden': true, ...props }, React.createElement('path', { d: 'M75.1 111.4l-0.4 1.1-0.7 4-0.5 1.8-0.6 3-2.3 8.4-0.4 1-1.6 5.4-1.9 5.4-1.1 3.5-0.3 1.7-0.9 3-0.8 1.6-0.4 0.3-1.3 0.2-2.4-0.3-1.6-0.6-1.8-1.1-0.9-0.8-1.4-1.7-1.1-2.3-1.4-4.5-1-4.2-1.6-8.1-1.9-6.9-0.9-2.3-1.1-2.1-1.5-2-0.8-0.9-0.9-0.8-1.1-0.7-1.3-0.6-1.2-0.2-1.9 0.2-9.2 1.7-6.7 0.6-2.5 0-1.7-0.2-1.1-0.3-1.9-0.8-0.9-0.4-1.7-1.3-2.4-2.1-1.4-1.6-0.5-0.9-0.6-0.5-1.1-1.4-1.3-2-1.9-3.7-1-2.7-0.2-1.9 0.3-1.9 0.6-1.4 1.1-1.2 1.2-1 2.2-1.3 5.1-2.4 4.4-2.2 1.9-1.3 1-0.9 0.5-0.8 2.3-5.4 2.3-3.3 3.6-3.2 4.3-3 1.2-1.1 0.3-0.7 0.2-1.7 0.2-11.2 0.1-1.3 0.2-0.7 0.5-0.6 0.6-0.6 1.1-0.6 0.4-0.1 1 0.4 2 1.3 2.7 2.9 1.4 2 0.9 0.3 0.2-0.2 0.7-1.8 0.9-4.7 0.4-1.4 0.6-1.2 0.9-1 1-0.6 1.4 0 1.1 0.4 2.2 1.8 2.2 2.5 1.5 1.8 6.3 9.1 2 3.5 0.6 0.6 0.6 0 0.2-0.3 0.2-0.6 1-4.7 1.6-11.5 1-5.1 0.5-1.4 0.6-1 0.6-0.7 0.6-0.3 1.8-0.1 1.1 0.2 0.8 0.5 1.6 1.5 1.6 1.9 1.4 2 5.2 8.8 0.5 0.5 0.9 0.2 2.1-0.1 6.7 0 5.2 0.2 0.5-0.2 0.6-0.6 2.8-5.2 2.1-3.6 2.4-3.2 2.1-2.1 1.1-0.9 0.8-0.1 0.8 0.1 1.4 0.5 0.5 0.3 0.8 1.1 0.6 1.9 0.6 2.9 0.9 7.5 1.4 9.7 0.4 1.2 0.3 0.4 0.3 0.2 0.4-0.2 1.2-1.5 1.4-2.3 5.4-7.7 2.4-3 3.2-3.4 2.3-1.5 1.1-0.4 0.9 0.2 0.6 0.5 1.4 1.6 0.7 2 0.9 6.8 0.3 1 0.2 0.4 0.3 0 0.4-0.2 2.9-4.1 2.5-2.2 1.3-0.7 0.9-0.4 0.9 0 1.1 0.4 0.6 0.4 0.7 1.2 0.2 1-0.5 13 0.1 0.7 0.2 0.3 0.5 0.5 1 0.5 0.5 0.4 2.6 1.6 1.4 1 1.5 1.3 1.8 1.8 2.1 2.9 1.2 2.4 1.3 3.8 1.3 1.5 1.7 1.2 1.8 1 3.5 1.4 2.8 1.2 2.7 1.4 1.8 1.1 1.2 1.1 1.1 1.2 0.5 0.8 0.2 1 0.1 0.9-0.1 1.5-0.7 2.2-0.6 1.5-2.4 4.2-1.9 2.6-2.8 3.2-2.7 2.4-1.4 0.9-1.6 0.9-1.2 0.4-1.8 0.3-2.2 0.1-2.8 0-4.7-0.6-7.1-1.4-3.9-0.2-1.6 0.2-1.1 0.3-0.8 0.3-0.8 0.7-1.5 1.5-1.4 2.2-0.8 1.4-1.2 3-1 3.5-0.4 2.1-0.9 3.1-0.2 1.3-0.6 2.3-0.6 3.8-0.5 1.6-0.5 2.1-1.1 3.1-1.1 2.3-0.7 1-1.1 1.1-1.9 1.4-2.2 1.1-2.4 0.5-1 0.1-0.8-0.1-0.5-0.5-0.3-0.6-0.6-2.5-0.8-3.7-0.6-2.3-3-9.1-3.2-11-1.9-8.5-0.6-2.1-0.3 0-0.2 0.1-1 1.8-1.2 1.5-1.1 1.2-2.1 1.8-2.1 1-3.3 0.2-2.1-0.1-3-0.7-2.2-0.8-5.6 1.4-2.7 0.2-1.2 0-1.1-0.3-1.9-0.7-2-1.2-1.9-1.7-1.1-1.5-1.2-2.1zM75.8 48.3l-0.5 0.7-0.3 1.5-0.9 7.5-2.2 12-0.8 3.8-0.4 2.8-0.1 2.8 0.1 1.4 0.5 2.7 0.7 1.8 2 3.7 2.2 3.6 1.2 2.5 1 2.7 1.6 6 1.1 2.9 1.1 2.2 1.4 1.9 0.9 0.6 1.4 0.7 1.3 0.3 1 0 1.1-0.4 1.3-1 0.4-0.5 0.2-0.7-0.1-1.1-0.9-1.7-2.4-3.2-0.5-1.8 0.1-0.9 0.4-0.7 0.5-0.5 0.5-0.3 0.8-0.4 2.8-0.5 3.4 0 2.5 0.4 1.3 0.5 1.1 0.8 0.4 0.6 0.2 0.7-0.1 0.6-0.6 1.5-3.2 4.6-0.2 1.3 0.2 1.1 0.9 1 0.5 0.3 1.2 0.5 1.2 0.1 1.5-0.3 1-0.5 1.4-1.3 1-1.4 0.8-1.7 1.3-3.6 2.5-9.3 1.2-2.6 2.1-3.1 0.5-0.6 1.5-2.6 0.9-2.3 0.4-1.8 0.1-3.4-0.4-3.5-2.3-12.1-2.1-13.3-0.2-0.4-0.3-0.2-0.5 0.1-0.4 0.3-2.7 5.6-1.6 3-1 1.6-0.6 0.5-1.2 0-7-0.9-5.3-0.1-2.1 0.1-4.8 0.9-1.4 0.2-0.6-0.1-0.5-0.2-1-1.2-1.2-2.1-3.3-7-0.6-0.9zM51 52.3l-0.2 0.4-0.6 7.8-0.4 2.6-0.5 1.7-0.7 1.1-0.8 0.5-5.8 1.7-3.3 1.2-4.4 2.2-2 1.1-1.6 1.1-1.9 1.8-1.4 1.7-1.1 2-1.6 4-1 1.9-0.7 0.9-1.2 1-2.2 1.5-4.1 2.1-3.3 1.5-1.9 1.2-1.6 1.6-0.4 0.9 0 0.8 0.2 1.5 0.4 0.7 0.9 1.7 2.2 3.1 2.4 2.2 1.5 1 0.7 0.3 2.6 0.2 3.3-0.3 6.1-0.8 3.4-0.7 4.5-0.6 1.6 0 2.2 0.1 2.1 0.4 2 0.9 2 1.2 1.8 1.7 1.6 1.9 1 1.6 1.5 2.6 0.9 2.2 1.2 3.9 3.9 16.4 0.4 0.7 1 0.4 0.2-0.2 0.3-0.4 2.9-8.3 2.4-8.4 1.5-6.2 0.5-1.6 0.7-3.7 1.4-6.1 0.8-5.3 0-1.6-0.2-0.7-0.4-0.8-2.9-4.5-1.3-2.4-0.8-1.8-0.4-1.3-0.5-2.9-0.2-2.2 0-4.6 0.3-2.1 0-1.4-0.2-1.3-1.8-3-2.7-4.1-3.3-5.1-0.4-0.8-3.9-5.4-0.4-0.4zM136.6 53.1l-0.5 0.3-1.3 1.5-9.3 13.7-1.4 2.3-0.1 0.5 0 1 0.6 5.3 0 1.9-0.2 3.2-0.2 1.1-0.7 2.8-1 2.3-3.8 6.1-0.4 0.9-0.3 0.9 0.3 3.8 1.1 6.1 1.1 5.6 3.5 14 3.1 9.4 1.1 2.5 0.4 0.4 0.4 0.2 0.4-0.2 0.4-0.8 1.3-5 1.5-6.8 1.1-4.4 0.9-2.8 0.7-2 1.3-2.8 1.3-2.2 2.1-2.5 1.4-1.4 2.2-1.6 1.6-0.6 2.1-0.6 2.5-0.3 3.5 0.3 3.3 0.3 9.7 1.7 3.3 0.2 1.8-0.1 0.8-0.4 1.9-1.4 2.1-2 1.5-2.1 1.3-1.9 0.7-1.4 0.4-1.7 0-0.7-0.4-0.8-1.5-1.5-1.7-1-1-0.3-1.5-0.9-3.4-1.5-2.3-1.2-2.2-1.3-1-0.9-1.1-1.4-0.8-1.5-1-2.4-0.4-1-1.3-3.1-0.7-1-1.3-1.4-2.8-1.9-3.7-2.3-5.5-2.2-2.5-0.7-2.6-0.9-1-0.4-0.9-0.7-0.6-0.9-0.5-2-0.6-4.4-0.4-1.9-0.1-2.1-0.3-0.7zM108.9 76.2l0.7-0.1 0.5 0.2 0.4 0.2 0.2 0.9 0 1-0.3 0.9-1.1 1.6-1.4 1.1-2.3 1.1-3.1 0.4-0.9 0-0.3-0.2-0.3-0.9 0-0.9 0.6-1.4 0.9-1 0.7-0.6 1.2-0.7 2.6-1.1zM77.4 76.2l1.1 0 2.1 0.3 2.9 1 0.7 0.4 1.6 1.3 0.7 1 0.6 2 0 0.7-0.1 0.2-0.2 0.2-0.6 0.2-2.9-0.3-1.2-0.4-1.7-1-1.4-1.2-1.8-2.2-0.3-0.7-0.1-0.8 0.2-0.4zM148.2 77.8l1 0 1.1 0.2 2.2 0.7 1.4 0.5 1.5 1.1 1 1 0.6 1.3 0 0.7-0.1 0.3-1 0.7-1.2 0.3-1.6-0.2-1.4-0.4-1.4-1.1-1.1-1.1-1.7-2.2-0.3-0.7 0-0.6 0.3-0.2zM39.8 77.9l0.8 0 0.4 0.4-0.1 0.8-0.2 0.8-1 1.4-2.2 2-1.5 0.9-1.4 0.4-1.7-0.1-0.7-0.3-0.5-0.5-0.3-0.8 0.3-1.2 0.3-0.6 1-0.8 3-1.6 1.6-0.4z' }));
// ícone do Argos: os seis olhos (SVG Repo, six-eyes), em currentColor
const Argos = (props) => React.createElement('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 512 512', width: 24, height: 24,
  fill: 'currentColor', 'aria-hidden': true, ...props }, React.createElement('path', { d: 'M365.8 21c-40.1 0.6-80.3 18.7-115.3 55.9 69.6 76.6 158.5 79.9 237 0-36.3-37.2-79-56.5-121.8-55.9zm2.4 18.7c2 0 4 0.2 6 0.5-8.6 2.1-14.9 10-14.9 19.5 0 11.1 8.6 20 19.3 20 10.7 0 19.3-8.9 19.3-20 0-1.9-0.3-3.6-0.7-5.3 4.9 6.5 7.8 14.6 7.8 23.5 0 21.1-16.5 38.1-36.8 38.1-20.3 0-36.8-17.1-36.8-38.1 0-21.1 16.5-38.1 36.8-38.1zm-229.8 49.2c-40.1 0.6-80.3 18.7-115.3 55.9 69.6 76.6 158.5 79.9 237 0-36.3-37.2-79-56.5-121.8-55.9zm2.4 18.7c2.1 0 4.1 0.2 6 0.5-8.6 2-15 10-15 19.5 0 11.1 8.6 20 19.3 20 10.7 0 19.3-8.9 19.3-20 0-1.9-0.3-3.7-0.7-5.4 4.9 6.5 7.8 14.6 7.8 23.5 0 21.1-16.5 38.1-36.8 38.1-20.3 0-36.8-17.1-36.8-38.1 0-21.1 16.5-38.1 36.8-38.1zm224.9 56.8c-40.1 0.6-80.3 18.7-115.3 55.9 69.6 76.6 158.5 79.9 237 0-36.3-37.2-79-56.5-121.8-55.9zm2.4 18.7c2.1 0 4.1 0.2 6.1 0.5-8.6 2-15 10-15 19.5 0 11.1 8.6 20 19.3 20 10.7 0 19.3-9 19.3-20 0-1.8-0.3-3.6-0.7-5.3 4.9 6.5 7.8 14.6 7.8 23.5 0 21.1-16.5 38.1-36.8 38.1-20.3 0-36.8-17.1-36.8-38.1 0-21.1 16.5-38.2 36.8-38.2zm-229.8 49.2c-40.1 0.6-80.3 18.7-115.3 55.9 69.6 76.6 158.5 79.9 237 0-36.3-37.2-79-56.5-121.8-55.9zm2.4 18.7c2 0 4 0.2 6 0.5-8.6 2.1-14.9 10-14.9 19.5 0 11.1 8.6 20 19.3 20 10.7 0 19.3-9 19.3-20 0-1.8-0.3-3.6-0.7-5.3 4.9 6.5 7.8 14.6 7.8 23.5 0 21.1-16.5 38.1-36.8 38.1-20.3 0-36.8-17.1-36.8-38.1 0-21.1 16.5-38.1 36.8-38.1zm224.9 56.3c-40.1 0.6-80.3 18.7-115.3 55.9 69.6 76.6 158.5 79.9 237 0-36.3-37.2-79-56.5-121.8-55.9zm2.4 18.7c2 0 4 0.2 6 0.5-8.6 2.1-14.9 10-14.9 19.5 0 11.1 8.6 20 19.3 20 10.7 0 19.3-8.9 19.3-20 0-1.9-0.3-3.6-0.7-5.3 4.9 6.5 7.8 14.6 7.8 23.5 0 21.1-16.5 38.1-36.8 38.1-20.3 0-36.8-17.1-36.8-38.1 0-21.1 16.5-38.1 36.8-38.1zm-229.8 49.2c-40.1 0.6-80.3 18.7-115.3 55.9 69.6 76.6 158.5 79.9 237 0-36.3-37.2-79-56.5-121.8-55.9zm2.4 18.7c2.1 0 4.1 0.2 6 0.5-8.6 2-15 10-15 19.5 0 11.1 8.6 20 19.3 20 10.7 0 19.3-8.9 19.3-20 0-1.9-0.3-3.7-0.7-5.4 4.9 6.5 7.8 14.6 7.8 23.5 0 21.1-16.5 38.1-36.8 38.1-20.3 0-36.8-17.1-36.8-38.1 0-21.1 16.5-38.1 36.8-38.1z' }));
// ícone do Caronte, redesenhado em vetor: anel no topo e meia-lua contornada, só traço em currentColor
const Caronte = (props) => React.createElement('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 256 256', width: 24, height: 24,
  fill: 'none', stroke: 'currentColor', strokeWidth: 21, strokeLinejoin: 'round', 'aria-hidden': true, ...props },
  React.createElement('circle', { cx: 128, cy: 48, r: 27 }), React.createElement('path', { d: 'M22 128A106 106 0 0 0 234 128A160 160 0 0 1 22 128Z' }));
const I = { ...LucideReact, Cerberus, Argos, Caronte };
const cn = (...a) => a.filter(Boolean).join(' ');
// plugin do projeto (GET /api/plugin + $D/plugin/panel/ui/*.js): o manifesto e o que os scripts dele registram antes do
// primeiro render; sem plugin, tudo vazio e o painel é só o do núcleo
const PLUGIN = { manifest: {}, badges: {}, dialogs: {} };
// registro único das páginas (id → componente): as do núcleo (ui/pages/*.js) e as do plugin entram pelo mesmo
// registerPage; o plugin carrega depois e, com o id de uma página do núcleo, a substitui
const PAGES = {};
// páginas registradas com { stage: true }: sem cabeçalho, título nem padding; o trilho fica fixo (sem gravar a preferência)
const STAGE = {};
const pluginList = (k) => Array.isArray(PLUGIN.manifest[k]) ? PLUGIN.manifest[k] : [];
// tour por página (tour-logic.tsx, carregado antes): registro, prévia de exemplo e progresso
const TL = window.TourLogic;
// regra do Select (select-logic.tsx, carregado antes): lista com grupos, teclado, digitar para pular e busca
const SL = window.SelectLogic;

// ------------------------------------------------------------------ formato
const GB = 1024 ** 3, MB = 1024 ** 2;
const gb = (b) => b == null ? '—' : (b / GB).toFixed(b >= 10 * GB ? 0 : 1).replace('.', ',') + ' GB';
const mb = (b) => b == null ? '—' : b >= GB ? gb(b) : Math.round(b / MB) + ' MB';
const dur = (s) => s == null ? '—' : s < 60 ? Math.round(s) + ' s' : s < 3600 ? Math.round(s / 60) + ' min'
  : s < 86400 ? (s / 3600).toFixed(1).replace('.0', '').replace('.', ',') + ' h' : Math.round(s / 86400) + ' d';
const hhmm = (t) => new Date(t * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const hhmmss = (t) => new Date(t * 1000).toLocaleTimeString('pt-BR');
const dt = (t) => new Date(t * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const pct = (a, b) => b ? Math.min(100, Math.max(0, a / b * 100)) : 0;

// ------------------------------------------------------------------ API
async function post(path, body, retry = true) {
  // prévia do tour ligada: a página mostra dados de exemplo, então nada sai pela rede nem é gravado
  if (TL.previewing()) throw TL.previewRefusal();
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panel-Token': window.__TOKEN }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  // painel reiniciado com a aba aberta: o token da página ficou velho (25/10, "Não foi possível iniciar: token")
  if (r.status === 403 && d.error === 'token' && retry) {
    const t = await fetch('/api/token', { cache: 'no-store' }).then((x) => x.json()).catch(() => ({}));
    if (t.token && t.token !== window.__TOKEN) { window.__TOKEN = t.token; return post(path, body, false); }
  }
  if (!r.ok) throw Object.assign(new Error(d.error || 'HTTP ' + r.status), { code: d.code });
  if (path === '/api/config') loadConfirmPrefs();
  return d;
}
const getJSON = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json());

// travas de confirmação (HADES_CONFIRM_HOLD segurar, HADES_CONFIRM_TYPED digitar o nome): lidas de /api/config, que vale no desktop
// e no celular. Antes da primeira leitura, ou se ela falhar, ficam as duas ligadas; quem decide a de digitar é o servidor.
const CONFIRM_SAFE = { hold: true, typed: true };
let confirmPrefs = CONFIRM_SAFE;
const confirmSubs = new Set();
const confirmPrefsOf = (items) => {
  const on = (key) => (Array.isArray(items) ? items.find((i) => i.key === key)?.value : undefined) !== '0';
  return { hold: on('HADES_CONFIRM_HOLD'), typed: on('HADES_CONFIRM_TYPED') };
};
async function loadConfirmPrefs() {
  try {
    const next = confirmPrefsOf((await getJSON('/api/config')).items);
    if (next.hold === confirmPrefs.hold && next.typed === confirmPrefs.typed) return;
    confirmPrefs = next;
    confirmSubs.forEach((set) => set(next));
  } catch (e) { /* sem leitura nova, vale a última (ou as duas ligadas) */ }
}
// `fresh`: relê ao montar (diálogos); sem ele só acompanha as mudanças
function useConfirmPrefs(fresh = false) {
  const [p, set] = useState(confirmPrefs);
  useEffect(() => { confirmSubs.add(set); set(confirmPrefs); if (fresh) loadConfirmPrefs(); return () => { confirmSubs.delete(set); }; }, [fresh]);
  return p;
}
loadConfirmPrefs();
window.addEventListener('focus', loadConfirmPrefs);
// sem o "Segure 1,2 s: " do rótulo quando a trava de segurar está desligada
const plainLabel = (c) => (typeof c === 'string' ? c.replace(/^Segure [\d,]+ s:\s*/, '') : Array.isArray(c) ? c.map(plainLabel) : c);

// ================================================================== primitivas (shadcn)
const BTN_V = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  destructive: 'bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/80',
  outline: 'border border-border-strong bg-transparent hover:bg-accent hover:text-accent-foreground',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
  'ghost-destructive': 'text-destructive hover:bg-destructive/10',
  link: 'text-foreground underline underline-offset-4 hover:no-underline',
};
const BTN_S = {
  default: 't-label h-8 px-3.5 has-[>svg]:px-3 max-md:h-11', sm: 't-label h-8 gap-1.5 px-3 has-[>svg]:px-2.5 max-md:h-11',
  xs: 'h-7 gap-1 px-2 t-meta-em has-[>svg]:px-1.5 max-md:h-11', lg: 't-label h-10 px-6 has-[>svg]:px-4 max-md:h-11',
  icon: 't-label size-9 max-md:size-11', 'icon-sm': 't-label size-8 max-md:size-11', 'icon-xs': 't-label size-7 max-md:size-11',
};
function Button({ variant = 'default', size = 'default', icon: Icon, loading, className, children, ...p }) {
  // carregando não é desabilitado: mantém a cor, com o giro e aria-busy; só o desabilitado esmaece
  return <button type="button" {...p} disabled={p.disabled || loading} aria-busy={loading || undefined} className={cn(loading && 'disabled:opacity-100 disabled:cursor-progress', "inline-flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer select-none transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 shrink-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", BTN_V[variant], BTN_S[size], className)}>
    {loading ? <I.LoaderCircle className="animate-spin" /> : Icon ? <Icon /> : null}
    {children}
  </button>;
}
// confirmar segurando (fx/hold-button.tsx): a ação só dispara ao completar o tempo, com mouse, toque ou Espaço/Enter.
// Sem o fx carregado (cache velho, plugin isolado) ou com a preferência desligada, cai no botão comum de um clique.
function HoldConfirm({ variant = 'destructive', size = 'sm', icon: Icon, holdTime = 1200, onHold, disabled, className, children, ...p }) {
  const { hold } = useConfirmPrefs();
  const Hold = hold ? window.HadesFx?.HoldButton : null;
  const danger = variant === 'destructive';
  if (!Hold) return <Button variant={variant} size={size} icon={Icon} disabled={disabled} className={className} onClick={onHold} {...p}>{hold ? children : plainLabel(children)}</Button>;
  return <Hold size={size === 'xs' || size === 'sm' ? 'sm' : 'md'} radius={0} holdTime={holdTime} disabled={disabled} className={className}
    backgroundColor={danger ? 'color-mix(in oklch, var(--destructive) 12%, var(--background))' : 'var(--secondary)'}
    textColor={danger ? 'var(--destructive)' : 'var(--secondary-foreground)'}
    fillColor={danger ? 'var(--destructive)' : 'var(--primary)'} fillTextColor="#fff"
    icon={Icon ? <Icon /> : null} doneLabel="Feito" onHold={onHold} label={p['aria-label']}>
    {children}
  </Hold>;
}
const BADGE_V = {
  default: 'border-transparent bg-primary text-primary-foreground',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  outline: 'text-foreground',
  destructive: 'border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20',
  ok: 'border-transparent bg-ok/12 text-[color-mix(in_oklch,var(--ok)_80%,var(--foreground))]',
  warn: 'border-transparent bg-warn/15 text-[color-mix(in_oklch,var(--warn)_60%,var(--foreground))]',
  bad: 'border-transparent bg-bad/12 text-[color-mix(in_oklch,var(--bad)_85%,var(--foreground))]',
  info: 'border-transparent bg-info/12 text-[color-mix(in_oklch,var(--info)_80%,var(--foreground))]',
  idle: 'border-transparent bg-muted text-muted-foreground',
};
const Badge = ({ variant = 'secondary', icon: Icon, className, children, ...p }) => <span {...p} className={cn('inline-flex items-center justify-center gap-1 border px-2 py-0.5 t-meta-em whitespace-nowrap shrink-0 [&>svg]:size-3 transition-colors', BADGE_V[variant], className)}>
  {Icon ? <Icon /> : null}
  {children}
</span>;

const DOT = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', idle: 'bg-muted-foreground/40', busy: 'bg-vivo' };
// o que está vivo respira (opacidade), não se expande
const Dot = ({ kind = 'idle', pulse, className }) => <span className={cn('relative inline-flex size-2 shrink-0', className)}>
  <span className={cn('relative inline-flex size-2 rounded-full', DOT[kind], pulse && 'pulso')} />
</span>;

// cards de lista que crescem sem fim (agentes, locks, PRs, escalações): altura máxima e scroll no conteúdo
const CARD_SCROLL = 'max-h-[28rem] overflow-y-auto scrollbar-thin';
// seção no chão (título + filete) por padrão; variant="object" é o cartão de um objeto que existe (gate, agente, guarda)
const Card = ({ variant = 'floor', className, children, ...p }) => <div {...p} className={cn('text-card-foreground flex min-w-0 flex-col gap-4',
  variant === 'object' && 'bg-card border p-4', className)}>
  {children}
</div>;
function CardHeader({ title, description, summary, icon: Icon, action, as: H = 'h2', className }) {
  return <div className={cn('flex flex-wrap items-start gap-x-4 gap-y-2 border-b pb-2.5', className)}>
    <div className="flex min-w-0 flex-1 items-start gap-2">
      {Icon ? <Icon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 md:flex-nowrap">
          <H className="t-section md:shrink-0">
            {title}
          </H>
          {summary ? <span className="min-w-0 t-label text-muted-foreground md:truncate">
            {summary}
          </span> : null}
        </div>
        {description ? <div className="mt-0.5 max-w-[75ch] t-body text-muted-foreground">
          {description}
        </div> : null}
      </div>
    </div>
    {action ? <div className="flex flex-wrap items-center gap-2">
      {action}
    </div> : null}
  </div>;
}
const CardContent = ({ className, children }) => <div className={cn('min-w-0', className)}>
  {children}
</div>;

function Switch({ checked, onChange, disabled, label, id }) {
  return <button type="button" role="switch" id={id} aria-checked={!!checked} aria-label={label} disabled={disabled} onClick={(e) => { e.stopPropagation(); onChange?.(!checked); }} className={cn('peer relative inline-flex h-5 w-9 shrink-0 after:absolute after:-inset-x-1 after:-inset-y-3 after:content-[\'\'] cursor-pointer items-center border transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
      checked ? 'border-primary bg-primary' : 'border-border-strong bg-transparent')}>
    <span className={cn('pointer-events-none block size-3.5 transition-transform duration-200', checked ? 'translate-x-[1.125rem] bg-primary-foreground' : 'translate-x-0.5 bg-muted-foreground')} />
  </button>;
}
const Field = ({ label, hint, children }) => <label className="flex items-start justify-between gap-4 border-b py-3 cursor-pointer hover:bg-accent/40 transition-colors">
  <span className="grid gap-0.5">
    <span className="t-label">
      {label}
    </span>
    {hint ? <span className="text-muted-foreground t-body">
      {hint}
    </span> : null}
  </span>
  {children}
</label>;
const Input = ({ className, icon: Icon, ...p }) => <div className={cn('relative flex-1 min-w-0', className)}>
  {Icon ? <Icon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /> : null}
  <input {...p} className={cn('flex h-8 w-full min-w-0 border border-border-strong bg-transparent max-md:h-11 px-3 py-1 t-body outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring', Icon && 'pl-8')} />
</div>;
const Progress = ({ value, kind, className }) => <div className={cn('relative h-1 w-full overflow-hidden bg-border', className)}>
  <div className={cn('h-full transition-[width] duration-700 ease-out', kind === 'bad' ? 'bg-bad' : kind === 'warn' ? 'bg-warn' : kind === 'ok' ? 'bg-ok' : 'bg-foreground')} style={{ width: value + '%' }} />
</div>;
const Skeleton = ({ className }) => <div className={cn('bg-[linear-gradient(90deg,var(--muted)_25%,color-mix(in_oklch,var(--muted)_50%,var(--background))_50%,var(--muted)_75%)] bg-[length:200%_100%] animate-shimmer', className)} />;
const Kbd = ({ children }) => <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-0.5 border bg-muted px-1.5 font-mono t-micro text-muted-foreground">
  {children}
</kbd>;
// papel próprio no className troca o t-data (dois papéis no mesmo elemento brigam pela ordem do CSS)
const Mono = ({ children, className }) => <span className={cn('font-mono tnum', !/(^| )t-/.test(className || '') && 't-data', className)}>
  {children}
</span>;
function Tip({ text, children, side = 'top', className, style }) {
  const [pos, setPos] = useState(null);
  const tip = useRef(null);
  useEffect(() => {
    // depois de medir a própria largura, o tooltip se encaixa dentro da tela
    if (!pos || !tip.current || pos.fixed) return;
    const w = tip.current.offsetWidth, h = tip.current.offsetHeight;
    if (pos.side === 'right') { setPos({ ...pos, left: pos.right + 8, top: Math.min(innerHeight - h - 8, Math.max(8, pos.cy - h / 2)), fixed: true }); return; }
    const left = Math.min(innerWidth - w - 8, Math.max(8, pos.cx - w / 2));
    const top = pos.side === 'top' && pos.top - h - 8 > 0 ? pos.top - h - 8 : pos.bottom + 8;
    setPos({ ...pos, left, top: top, fixed: true });
  }, [pos]);
  if (!text) return children;
  const show = (e) => { const r = e.currentTarget.getBoundingClientRect(); setPos({ cx: r.left + r.width / 2, cy: r.top + r.height / 2, right: r.right, top: r.top, bottom: r.bottom, side }); };
  return <span className={cn('inline-flex', className)} style={style} onMouseEnter={show} onMouseLeave={() => setPos(null)} onFocus={show} onBlur={() => setPos(null)}>
    {children}
    {pos ? ReactDOM.createPortal(<span role="tooltip" ref={tip} style={{ left: pos.left ?? -9999, top: pos.top ?? -9999 }} className={cn('pointer-events-none fixed z-[70] w-max max-w-72 bg-foreground px-2.5 py-1.5 text-center t-meta text-background text-balance', pos.fixed && 'animate-fade-in')}>
      {text}
    </span>, document.body) : null}
  </span>;
}
function CopyButton({ text, label }) {
  const [done, setDone] = useState(false);
  return <Tip text={done ? 'Copiado' : label || 'Copiar'}>
    <Button variant="ghost" size="icon-xs" aria-label={label || 'Copiar'} onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch (e) {} }} icon={done ? I.Check : I.Copy} />
  </Tip>;
}
// vazio é uma linha: o que não há e, se houver, o que fazer
// Em página com tour, o vazio ganha "Ver como funciona" (tour={false} tira, onde o vazio é só um filtro sem resultado)
const Empty = ({ icon: Icon = I.Inbox, title, children, tour = true }) => {
  const app = useApp();
  return <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-3 t-body">
    <Icon className="size-4 shrink-0 translate-y-0.5 text-muted-foreground" aria-hidden="true" />
    <span className="font-medium">
      {title}
    </span>
    {children ? <div className="min-w-0 text-muted-foreground">
      {children}
    </div> : null}
    {tour && app?.tourId ? <button type="button" onClick={app.startTour} className="cursor-pointer text-foreground underline underline-offset-4 outline-none hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      Ver como funciona
    </button> : null}
  </div>;
};

// tabela
const Table = ({ children, className }) => <div className={cn('relative w-full overflow-x-auto scrollbar-thin', className)}>
  <table className="w-full caption-bottom t-body tnum">
    {children}
  </table>
</div>;
const Th = ({ children, className }) => <th className={cn('h-10 px-3 text-left align-middle font-medium text-muted-foreground whitespace-nowrap', className)}>
  {children}
</th>;
const Td = ({ children, className, ...p }) => <td {...p} className={cn('px-3 py-2.5 align-middle whitespace-nowrap', className)}>
  {children}
</td>;
const Tr = ({ children, className, ...p }) => <tr {...p} className={cn('border-b transition-colors hover:bg-muted/50 last:border-0', className)}>
  {children}
</tr>;

// menu suspenso (posição fixa: não é cortado pelo overflow das tabelas)
function Menu({ items, label = 'Mais ações' }) {
  const [open, setOpen] = useState(null);
  const btn = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (e.type === 'keydown' ? e.key === 'Escape' : !e.target.closest?.('[data-menu]')) setOpen(null); };
    addEventListener('pointerdown', close); addEventListener('keydown', close); addEventListener('scroll', () => setOpen(null), { once: true, capture: true });
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', close); };
  }, [open]);
  const toggle = () => {
    if (open) return setOpen(null);
    const r = btn.current.getBoundingClientRect();
    const up = innerHeight - r.bottom < items.length * 34 + 24;
    setOpen({ right: innerWidth - r.right, ...(up ? { bottom: innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
  };
  return <span data-menu ref={btn} className="inline-flex">
    <Button variant="ghost" size="icon-sm" aria-label={label} aria-haspopup="menu" aria-expanded={!!open} onClick={toggle} icon={I.Ellipsis} />
    {open ? <div role="menu" data-menu style={open} className="fixed z-50 min-w-48 overflow-hidden border border-border-strong bg-popover p-1 text-popover-foreground animate-fade-in">
      {items.filter(Boolean).map((it, i) => it === '-' ? <div key={i} className="-mx-1 my-1 h-px bg-border" />
        : <button key={i} role="menuitem" type="button" disabled={it.disabled} onClick={() => { setOpen(null); it.onClick(); }} className={cn('relative flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 t-body outline-none select-none hover:bg-accent focus-visible:bg-accent disabled:opacity-50 disabled:pointer-events-none [&_svg]:size-4',
            it.danger ? 'text-destructive [&_svg]:text-destructive' : '[&_svg]:text-muted-foreground')}>
          {it.icon ? <it.icon /> : null}
          {it.label}
        </button>)}
    </div> : null}
  </span>;
}

// ================================================================== overlays: diálogo, folha lateral, toasts
const UI = createContext(null);
function Dialog({ open, onClose, children, className, label }) {
  useEffect(() => {
    if (!open) return;
    const k = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return ReactDOM.createPortal(<div className="fixed inset-0 z-50">
    <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-fade-in" onClick={onClose} />
    <div role="dialog" aria-modal="true" aria-label={label} className={cn('fixed top-1/2 left-1/2 grid w-full max-w-[calc(100%-2rem)] max-md:max-h-[calc(100dvh-2rem)] max-md:overflow-y-auto gap-4 border border-border-strong bg-popover p-6 shadow-lg animate-zoom-in sm:max-w-lg', className)}>
      {children}
      <button type="button" onClick={onClose} aria-label="Fechar" className="absolute top-4 right-4 opacity-60 transition-opacity hover:opacity-100 cursor-pointer outline-none focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring">
        <I.X className="size-4" />
      </button>
    </div>
  </div>, document.body);
}
const DialogHeader = ({ title, description, icon: Icon, tone }) => <div className="flex gap-3">
  {Icon ? <Icon className={cn('mt-px size-5 shrink-0', tone === 'danger' ? 'text-destructive' : 'text-muted-foreground')} aria-hidden="true" /> : null}
  <div className="grid gap-1.5 pr-6">
    <h2 className="t-section-lg">
      {title}
    </h2>
    {description ? <p className="text-muted-foreground t-body whitespace-pre-line">
      {description}
    </p> : null}
  </div>
</div>;
const DialogFooter = ({ children }) => <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
  {children}
</div>;

function Sheet({ open, onClose, side = 'right', title, description, icon: Icon, actions, children, wide, rail }) {
  useEffect(() => {
    if (!open) return;
    const k = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return ReactDOM.createPortal(<div className="fixed inset-0 z-50">
    <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={onClose} />
    <aside role="dialog" aria-modal="true" aria-label={title} className={cn('fixed flex w-full flex-col gap-0 border bg-background shadow-xl', side === 'bottom' ? 'inset-x-0 bottom-0 max-h-[75dvh] border-x-0 border-b-0 animate-fade-in' : side === 'right' ? 'inset-y-0 right-0 border-l animate-slide-in-right' : 'inset-y-0 left-0 border-r animate-slide-in-left', rail && 'border-sidebar-border bg-sidebar text-sidebar-foreground', side === 'bottom' ? '' : wide ? 'sm:max-w-4xl' : 'sm:max-w-sm')}>
      {title ? <header className="flex items-start gap-3 border-b p-4 pr-12">
        {Icon ? <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        <div className="min-w-0 flex-1">
          <h2 className="t-section truncate">
            {title}
          </h2>
          {description ? <div className="text-muted-foreground t-body truncate">
            {description}
          </div> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">
          {actions}
        </div> : null}
      </header> : null}
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        {children}
      </div>
      <button type="button" onClick={onClose} aria-label="Fechar" className="absolute top-4 right-4 opacity-60 transition-opacity hover:opacity-100 cursor-pointer outline-none focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring">
        <I.X className="size-4" />
      </button>
    </aside>
  </div>, document.body);
}

const TOAST_ICON = { ok: [I.CircleCheck, 'text-ok'], bad: [I.CircleX, 'text-bad'], warn: [I.TriangleAlert, 'text-warn'], info: [I.Info, 'text-info'], busy: [I.LoaderCircle, 'text-muted-foreground animate-spin'] };
function Toaster({ toasts, dismiss }) {
  return ReactDOM.createPortal(<ol className="fixed right-4 bottom-4 z-[60] flex max-md:top-[4.5rem] max-md:bottom-auto w-[calc(100%-2rem)] max-w-sm flex-col gap-2" aria-live="polite">
    {toasts.map((t) => { const [Ic, cl] = TOAST_ICON[t.kind] || TOAST_ICON.info; return <li key={t.id} className="flex items-start gap-3 border border-border-strong bg-popover p-4 text-popover-foreground shadow-lg animate-toast-in">
      <Ic className={cn('mt-0.5 size-4 shrink-0', cl)} />
      <div className="grid flex-1 gap-1">
        <div className="t-label">
          {t.title}
        </div>
        {t.desc ? <div className="text-muted-foreground t-body">
          {t.desc}
        </div> : null}
        {t.action ? <div className="mt-1">
          <Button size="xs" variant="outline" onClick={() => { t.action.onClick(); dismiss(t.id); }} icon={t.action.icon}>
            {t.action.label}
          </Button>
        </div> : null}
      </div>
      <button type="button" aria-label="Fechar" onClick={() => dismiss(t.id)} className="opacity-50 hover:opacity-100 cursor-pointer outline-none focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring">
        <I.X className="size-3.5" />
      </button>
    </li>; })}
  </ol>, document.body);
}

// ================================================================== gráficos
// passo redondo (1, 2, 2,5, 5 × 10ⁿ) que divide max em até n partes
function niceStep(max, n) {
  const step0 = max / n, mag = 10 ** Math.floor(Math.log10(step0));
  return [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= step0) || mag * 10;
}
function niceTicks(max, n) {
  const step = niceStep(max, n);
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(3));
  return out;
}
// o último passo fica em max ou acima: escala de colunas que não pode cortar a maior
function niceTicksCovering(max, n) {
  const step = niceStep(max, n);
  const out = [0];
  while (out.at(-1) < max) out.push(+(out.at(-1) + step).toFixed(3));
  return out;
}
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
function AreaChart({ points, series, height = 220, yFmt = (v) => v, refLine, refLabel, label }) {
  const [ref, w] = useWidth();
  const [hi, setHi] = useState(null);
  const uid = useId().replace(/:/g, '');
  const m = { l: 42, r: 14, t: 14, b: 26 };
  const ok = points.length > 1 && w > 0;
  const t0 = ok ? points[0].t : 0, t1 = ok ? Math.max(points.at(-1).t, t0 + 60) : 1;
  const ymax = ok ? Math.max(refLine || 0, ...points.flatMap((p) => series.map((s) => s.get(p))), 1e-6) * 1.15 : 1;
  const x = (t) => m.l + (t - t0) / (t1 - t0) * (w - m.l - m.r);
  const y = (v) => height - m.b - v / ymax * (height - m.t - m.b);
  const move = (ev) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const t = t0 + ((ev.clientX - r.left) - m.l) / (w - m.l - m.r) * (t1 - t0);
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(p.t - t) < Math.abs(points[best].t - t)) best = i; });
    setHi(best);
  };
  const hp = hi != null ? points[hi] : null;
  return <div ref={ref} className="relative w-full min-w-0" style={{ height }}>
    {!ok ? <div className="grid h-full place-items-center t-body text-muted-foreground">
      {points.length ? 'Coletando amostras…' : 'Sem amostras ainda.'}
    </div> : <>
      <svg width={w} height={height} role="img" aria-label={label} onPointerMove={move} onPointerLeave={() => setHi(null)} className="absolute inset-0 overflow-visible">
        <defs>
          {series.map((s, i) => <linearGradient key={i} id={`g${uid}${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: s.color, stopOpacity: s.fill === false ? 0 : 0.28 }} />
            <stop offset="100%" style={{ stopColor: s.color, stopOpacity: 0 }} />
          </linearGradient>)}
        </defs>
        {niceTicks(ymax, 4).map((v) => <g key={v}>
          <line x1={m.l} x2={w - m.r} y1={y(v)} y2={y(v)} style={{ stroke: 'var(--border)' }} strokeDasharray={v ? '3 3' : ''} />
          <text x={m.l - 8} y={y(v) + 4} textAnchor="end" className="t-micro" style={{ fill: 'var(--muted-foreground)' }}>
            {yFmt(v)}
          </text>
        </g>)}
        {(() => { const n = Math.min(6, Math.max(2, Math.floor(w / 110))); return Array.from({ length: n + 1 }, (_, i) => { const t = t0 + (t1 - t0) * i / n;
        return <text key={i} x={x(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n ? 'end' : 'middle'} className="t-micro" style={{ fill: 'var(--muted-foreground)' }}>
          {hhmm(t)}
        </text>; }); })()}
        {refLine != null ? <g>
          <line x1={m.l} x2={w - m.r} y1={y(refLine)} y2={y(refLine)} style={{ stroke: 'var(--bad)' }} strokeDasharray="4 4" strokeWidth="1.5" />
          <text x={w - m.r} y={y(refLine) - 6} textAnchor="end" className="t-micro" style={{ fill: 'var(--bad)' }}>
            {refLabel}
          </text>
        </g> : null}
        {series.map((s, i) => {
        const pts = points.map((p) => [x(p.t), y(s.get(p))]);
        const line = pts.map(([px, py], j) => (j ? (s.step ? `H${px.toFixed(1)}V${py.toFixed(1)}` : `L${px.toFixed(1)},${py.toFixed(1)}`) : `M${px.toFixed(1)},${py.toFixed(1)}`)).join('');
        const area = `${line}L${pts.at(-1)[0].toFixed(1)},${y(0)}L${pts[0][0].toFixed(1)},${y(0)}Z`;
        return <g key={i}>
          <path d={area} style={{ fill: `url(#g${uid}${i})` }} />
          <path d={line} fill="none" style={{ stroke: s.color }} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dash ? '5 4' : ''} />
        </g>;
      })}
        {hp ? <g>
          <line x1={x(hp.t)} x2={x(hp.t)} y1={m.t} y2={height - m.b} style={{ stroke: 'var(--ring)' }} />
          {series.map((s, i) => <circle key={i} cx={x(hp.t)} cy={y(s.get(hp))} r="4" style={{ fill: s.color, stroke: 'var(--card)' }} strokeWidth="2" />)}
        </g> : null}
      </svg>
      {hp ? <div className="pointer-events-none absolute top-1 z-10 grid min-w-36 gap-1.5 border bg-popover px-2.5 py-1.5 t-meta shadow-xl animate-fade-in" style={{ left: Math.min(w - 170, Math.max(0, x(hp.t) + 12)) }}>
        <div className="font-medium">
          {hhmmss(hp.t)}
        </div>
        {series.map((s, i) => <div key={i} className="flex items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
          <span className="text-muted-foreground">
            {s.name}
          </span>
          <span className="ml-auto font-mono font-medium tabular-nums">
            {(s.fmt || yFmt)(s.get(hp))}
          </span>
        </div>)}
      </div> : null}
    </>}
  </div>;
}
const Legend = ({ items }) => <div className="flex flex-wrap items-center gap-x-4 gap-y-1 t-meta text-muted-foreground">
  {items.map((s, i) => <span key={i} className="inline-flex items-center gap-1.5">
    <span className={cn('shrink-0', s.dash ? 'h-0 w-3 border-t-2 border-dashed' : 'h-0.5 w-3')} style={s.dash ? { borderColor: s.color } : { background: s.color }} />
    {s.name}
  </span>)}
</div>;

// ================================================================== estado e ações
const OVERALL = {
  up: { kind: 'ok', label: 'No ar', icon: I.CircleCheck, pulse: true, desc: 'Todos os serviços prontos' },
  partial: { kind: 'warn', label: 'Parcial', icon: I.TriangleAlert, desc: 'Serviço ou infra fora do ar' },
  paused: { kind: 'idle', label: 'Pausado', icon: I.CirclePause, desc: 'Regra de ceder ou pausa manual' },
  stopped: { kind: 'idle', label: 'Parado', icon: I.PowerOff, desc: 'Nada do Hades rodando' },
  busy: { kind: 'busy', label: 'Em operação', icon: I.LoaderCircle, pulse: true, spin: true, desc: 'Um ciclo está rodando' },
};
function svcState(s) {
  if (s.state === 'active') return s.ready ? { kind: 'ok', label: 'Pronto', icon: I.CircleCheck } : { kind: 'warn', label: s.readyCode ? `Ready ${s.readyCode}` : 'Sem ready', icon: I.CircleAlert };
  if (s.state === 'activating') return { kind: 'warn', label: 'Subindo', icon: I.LoaderCircle };
  if (s.state === 'failed') return { kind: 'bad', label: 'Falhou', icon: I.CircleX };
  return { kind: 'idle', label: 'Parado', icon: I.CircleStop };
}
function unitState(u) {
  if (u.state === 'active') return { kind: 'ok', label: 'Ativo', icon: I.CircleCheck };
  if (u.state === 'activating') return { kind: 'warn', label: 'Subindo', icon: I.LoaderCircle };
  if (u.state === 'failed') return { kind: 'bad', label: 'Falhou', icon: I.CircleX };
  return { kind: 'idle', label: 'Parado', icon: I.CircleStop };
}
const StateBadge = ({ st, title }) => <Tip text={title}>
  <Badge variant={st.kind === 'busy' ? 'warn' : st.kind} className="gap-1.5">
    <st.icon className={cn(st.icon === I.LoaderCircle && 'animate-spin')} />
    {st.label}
  </Badge>
</Tip>;

function useApp() { return useContext(UI); }

// ================================================================== layout
const CORE_NAV = [
  { id: 'overview', label: 'Visão geral', icon: I.LayoutDashboard, desc: 'Estado, ações principais e tendência da última hora' },
  { id: 'code', label: 'Branch e PRs', icon: I.GitBranch, desc: 'O que entra na branch hades/local: base do projeto ou base + PRs (sem push)' },
  { id: 'queue', label: 'Fila de gates', icon: I.ListOrdered, desc: 'Gate = checagem pesada antes da PR: build, lint, testes. Aqui: quem roda, quem espera, memória e journal da fila (gate-lock)' },
  { id: 'usage', label: 'Consumo', icon: I.Coins, desc: 'Tokens por papel, agente e dia, e a linha de base' },
  { id: 'orchestration', label: 'Orquestração', icon: I.Workflow, desc: 'Agentes do orquestrador (herdr), perguntas ao dono, relatórios e PRs de consolidação' },
  { id: 'reviews', label: 'Revisões', icon: I.ScanSearch, desc: '/review-pr ou /review-agents sobre PRs escolhidas; histórico das últimas 20' },
  { id: 'loop', label: 'Loop', icon: I.Repeat, desc: 'Escalações, entregas, ações em 24 h, PRs, agentes e locks' },
  { id: 'claude', label: 'Claude', icon: I.MessageSquare, desc: 'Conversa com o Claude Code no clone principal, pelo navegador ou celular' },
  { id: 'herdr', label: 'Herdr', sub: 'terminais e agentes', icon: I.TerminalSquare, desc: 'Workspaces e agentes do herdr: acompanhe a saída, mande prompt e teclas, gerencie as sessões' },
  { id: 'argos', label: 'Argos', sub: 'agentes ao vivo', icon: I.Argos, desc: 'Grafo dos agentes ao vivo: quem pede permissão ou está parado, PR e CI, e ações no agente' },
  { id: 'caronte', label: 'Caronte', sub: 'levar a outra máquina', icon: I.Caronte, desc: 'Leve uma orquestração para outra sessão ou máquina: prévia, pacotes cifrados e prompt de retomada (a senha fica no terminal)' },
  { id: 'jobs', label: 'Execuções', icon: I.SquareTerminal, desc: 'Ações disparadas pelo painel, com log ao vivo' },
  { id: 'logs', label: 'Logs', icon: I.ScrollText, desc: 'Serviços, builds, processos, containers e documentos do ambiente' },
  { id: 'remote', label: 'Acesso remoto', icon: I.Earth, desc: 'Abrir o painel fora da máquina pelo túnel, com a conta do GitHub e a chave de acesso' },
  { id: 'notify', label: 'Notificações', icon: I.Bell, desc: 'Canais (desktop e ntfy), vigia e as últimas 50 notificações' },
  { id: 'onboard', label: 'Onboarding', icon: I.ListChecks, desc: 'Escolha os recursos a preparar e veja estado e passos de cada uma' },
  { id: 'plugins', label: 'Plugins', icon: I.Puzzle, desc: 'Adicionar por URL, atualizar, ligar, desligar e remover (só leitura pelo acesso remoto)' },
  { id: 'quality', label: 'Qualidade', icon: I.ShieldCheck, desc: 'Regras de qualidade: ligue e desligue o que entra nos briefs, na entrega, no inbox e na revisão' },
  { id: 'thanatos', label: 'Thanatos', sub: 'post-mortems', icon: I.Skull, desc: 'Post-mortems de incidentes e bugs em produção: linha do tempo, causa, correção e lacunas' },
  { id: 'cerberus', label: 'Cerberus', sub: 'guarda de entrada e saída', icon: I.Cerberus, desc: 'Porta, Limiar e Vigília: modos, guardas, vereditos, o que barrou e exceções' },
  { id: 'config', label: 'Configurações', icon: I.SlidersHorizontal, desc: 'Memória, builds, subida, plantão, túnel, painel e o que o projeto declara (config.env)' },
  { id: 'docs', label: 'Documentação', icon: I.BookOpen, desc: 'SKILL.md, referências e changelog' },
];
const CORE_GROUPS = [
  { id: 'ambiente', label: 'Ambiente', items: ['overview', 'code'] },
  { id: 'loop', label: 'Loop', items: ['loop', 'orchestration', 'reviews', 'queue', 'usage'] },
  { id: 'operacao', label: 'Operação', items: ['claude', 'herdr', 'jobs', 'logs', 'notify', 'remote'] },
  { id: 'hades', label: 'Hades', items: ['argos', 'cerberus', 'thanatos', 'caronte'] },
  { id: 'sistema', label: 'Sistema', items: ['onboard', 'plugins', 'quality', 'config', 'docs'] },
];
// páginas do plugin entram no grupo que declaram (id ou rótulo; grupo desconhecido vira grupo novo antes de Sistema),
// depois do item `after` quando ele existe. Só entra página cujo script registrou o componente.
function pluginNav(pages, registered) {
  const nav = [...CORE_NAV], groups = CORE_GROUPS.map((g) => ({ ...g, items: [...g.items] }));
  for (const p of pages) {
    if (!p || typeof p.id !== 'string' || !registered[p.id]) continue;
    if (nav.some((n) => n.id === p.id)) { console.warn(`plugin: página ${p.id} já existe no núcleo, ignorada`); continue; }
    nav.push({ id: p.id, label: String(p.label || p.id), icon: I[p.icon] || I.Puzzle, desc: String(p.desc || '') });
    const gname = String(p.group || 'Projeto');
    let g = groups.find((x) => x.id === gname || x.label === gname);
    if (!g) { g = { id: 'plugin-' + gname.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: gname, items: [] }; groups.splice(groups.length - 1, 0, g); }
    const at = g.items.indexOf(p.after);
    g.items.splice(at < 0 ? g.items.length : at + 1, 0, p.id);
  }
  return { nav, groups: groups.map((g) => ({ ...g, items: g.items.map((id) => nav.find((n) => n.id === id)) })) };
}
// lista plana (rota e paleta de comandos) e grupos da sidebar: recalculados uma vez, depois que o plugin carregou
let NAV = CORE_NAV;
let NAV_GROUPS = pluginNav([], {}).groups;
const lsGet = (k, def) => { try { const v = localStorage.getItem(k); return v == null ? def : v; } catch (e) { return def; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
// estado da navegação: trilho e grupos fechados (só neste navegador); o grupo da página aberta reabre sozinho
function useSidebarState(page) {
  const [min, setMin] = useState(() => lsGet('panel-sidebar-min', '0') === '1');
  const [closed, setClosed] = useState(() => lsGet('panel-sidebar-closed', '').split(',').filter(Boolean));
  useEffect(() => { lsSet('panel-sidebar-min', min ? '1' : '0'); }, [min]);
  useEffect(() => { lsSet('panel-sidebar-closed', closed.join(',')); }, [closed]);
  useEffect(() => {
    const g = NAV_GROUPS.find((x) => x.items.some((n) => n.id === page));
    if (g) setClosed((c) => c.includes(g.id) ? c.filter((x) => x !== g.id) : c);
  }, [page]);
  const toggleGroup = useCallback((id) => setClosed((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id]), []);
  const toggleMin = useCallback(() => setMin((m) => !m), []);
  return { min, closed, toggleGroup, toggleMin };
}
const route = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'overview');

// a marca: o ícone do Hades em metal (máscara do hades-mark.svg) e a inscrição em Marcellus
const BrandMark = ({ alt = '' }) => <span className="marca size-8 shrink-0" role={alt ? 'img' : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true} />;
function Brand() {
  return <div className="flex min-w-0 items-center gap-3">
    <BrandMark />
    <div className="grid min-w-0 gap-1">
      <span className="font-heading text-[1.125rem] leading-none tracking-[0.04em]">HADES</span>
      <span className="truncate t-meta text-rail-muted">skill hades</span>
    </div>
  </div>;
}
// o ponto vivo nasce no topo do rio e desce até o item (a animação .ponto-vivo lê --desde)
const fromRiverTop = (el) => { if (el?.parentElement) el.style.setProperty('--desde', -el.parentElement.offsetTop + 'px'); };
const SLICE_BAR = { ok: 'bg-metal', warn: 'bg-warn', bad: 'bg-bad' };
// o trilho: o rio atravessa os itens, o óbolo marca a página aberta e desliza na troca, o ponto vivo marca onde há
// atividade. Recolhido (rail), só os ícones
function Sidebar({ page, d, onNavigate, rail, closed = [], onToggleGroup, onToggleMin }) {
  const badge = {
    queue: d && d.gates.length ? String(d.gates.length) : null,
    jobs: d && d.jobs.some((j) => j.state === 'rodando') ? 'spin' : null,
    remote: d && d.panelTunnel?.unit === 'active' ? 'on' : null,
    herdr: d?.herdr?.working ? String(d.herdr.working) : null,
  };
  // contador das páginas do plugin (registerPage(..., { badge })): erro no plugin some com o contador, não com a sidebar
  if (d) for (const [id, f] of Object.entries(PLUGIN.badges)) {
    try { const v = f(d); badge[id] = v == null || v === '' ? null : String(v); } catch (e) { console.warn(`plugin: contador de ${id} falhou`, e); }
  }
  const alive = (id) => id === 'queue' || id === 'jobs' || id === 'herdr' ? !!badge[id] : false;
  const blocked = (id) => id === 'herdr' && !!d?.herdr?.blocked;
  const slicePct = d ? pct(d.slice.used, d.slice.max) : 0;
  const sliceKind = slicePct > 85 ? 'bad' : slicePct > 65 ? 'warn' : 'ok';
  const sliceText = d ? (d.slice.max ? `${gb(d.slice.used)} de ${gb(d.slice.max)}` : `parado · teto ${d.config?.HADES_SLICE_MAX ?? '—'}`) : '';
  const river = useRef(null);
  const [obolo, setObolo] = useState(null);
  // mede contra o próprio rio e de novo quando ele muda de altura: o Tailwind compila depois do primeiro paint, a fonte
  // chega depois e as páginas do plugin entram no meio dos grupos
  React.useLayoutEffect(() => {
    const r = river.current;
    if (!r) return undefined;
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const a = r.querySelector('a[aria-current=page]');
      setObolo(a ? a.getBoundingClientRect().top - r.getBoundingClientRect().top + a.offsetHeight / 2 - 4.5 : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(r);
    document.fonts?.ready.then(measure);
    return () => { alive = false; ro.disconnect(); };
  }, [page, closed.join(','), rail]);
  const minBtn = onToggleMin ? <Tip text={(rail ? 'Expandir' : 'Recolher') + ' (Ctrl+B)'} side={rail ? 'right' : 'bottom'}>
    <button type="button" aria-label={rail ? 'Expandir o trilho' : 'Recolher o trilho'} onClick={onToggleMin} className="grid size-8 cursor-pointer place-items-center text-rail-muted outline-none transition-colors hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-metal max-md:size-11">
      {rail ? <I.PanelLeftOpen className="size-4" /> : <I.PanelLeftClose className="size-4" />}
    </button>
  </Tip> : null;
  const focus = 'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-metal';
  const railItem = (n) => {
    const on = page === n.id, b = badge[n.id];
    return <Tip key={n.id} side="right" text={b && b !== 'spin' && b !== 'on' ? `${n.label} · ${b}${n.id === 'herdr' ? ' trabalhando' : n.id === 'queue' ? ' na fila' : ''}` : b === 'spin' ? `${n.label} · rodando` : n.label}>
      <a href={'#/' + n.id} onClick={onNavigate} aria-label={n.label} aria-current={on ? 'page' : undefined} className={cn('relative grid size-9 max-lg:size-11 place-items-center transition-colors [&>svg]:size-4', focus,
        on ? 'bg-sidebar-accent text-metal' : 'text-rail-muted hover:bg-sidebar-accent hover:text-sidebar-foreground')}>
        <n.icon />
        {alive(n.id) || blocked(n.id) || b === 'on' ? <span className={cn('absolute right-1 top-1 size-[7px] rounded-full', blocked(n.id) ? 'bg-warn' : b === 'on' ? 'bg-ok' : 'pulso bg-vivo')} /> : null}
      </a>
    </Tip>;
  };
  const item = (n) => {
    const on = page === n.id, b = badge[n.id], live = alive(n.id);
    return <a key={n.id} href={'#/' + n.id} onClick={onNavigate} aria-current={on ? 'page' : undefined} className={cn('relative flex items-center gap-2.5 pr-4 pl-11 t-label transition-colors [&>svg]:size-[15px] [&>svg]:shrink-0', n.sub ? 'min-h-10 py-1' : 'h-8', focus,
      on ? 'font-medium text-sidebar-foreground' : 'text-rail-muted hover:bg-sidebar-accent hover:text-sidebar-foreground')}>
      {live && !on ? <span ref={fromRiverTop} className="ponto-vivo absolute top-1/2 left-[24px] -mt-[3.5px] size-[7px] rounded-full bg-vivo" aria-hidden="true" /> : null}
      <n.icon className={cn(on && 'text-metal')} />
      <span className="grid min-w-0 flex-1">
        <span className="truncate">
          {n.label}
        </span>
        {n.sub ? <span className="truncate t-meta font-normal text-rail-muted/80">
          {n.sub}
        </span> : null}
      </span>
      {live ? <span className="sr-only">(em atividade)</span> : null}
      {blocked(n.id) ? <span className="size-[7px] rounded-full bg-warn" title="Há agente esperando você" role="img" aria-label="Há agente esperando você" /> : null}
      {b === 'on' ? <span className="size-[7px] rounded-full bg-ok" title="Túnel no ar" role="img" aria-label="Túnel no ar" />
        : b && b !== 'spin' ? <span className={cn('font-mono t-micro tnum', live ? 'text-metal' : 'text-rail-muted/80')}>
          {b}
        </span> : null}
    </a>;
  };
  return <nav aria-label="Navegação" className={cn('flex h-full flex-col bg-sidebar text-sidebar-foreground', rail && 'items-center')}>
    <div className={cn('shrink-0', rail ? 'grid justify-items-center gap-2 pt-4 pb-3' : 'flex items-center justify-between gap-2 px-4 pt-5 pb-4')}>
      {rail ? <BrandMark alt="Hades" /> : <Brand />}
      {minBtn}
    </div>
    <div className={cn('min-h-0 flex-1 overflow-y-auto overflow-x-hidden', rail ? 'scrollbar-none' : 'scrollbar-thin')}>
      {rail ? <div className="grid content-start justify-items-center gap-0.5 pb-4">
        {NAV_GROUPS.map((g, gi) => <Fragment key={g.id}>
          {gi > 0 ? <div className="my-1.5 h-px w-6 bg-sidebar-border" role="separator" /> : null}
          {g.items.map(railItem)}
        </Fragment>)}
      </div> : <div ref={river} className="relative pb-4">
        <span className="rio" aria-hidden="true" />
        {obolo == null ? null : <span className="obolo" style={{ transform: `translateY(${obolo}px)` }} aria-hidden="true" />}
        {NAV_GROUPS.map((g, gi) => {
          const shut = closed.includes(g.id);
          const hot = shut && g.items.some((n) => alive(n.id) || blocked(n.id));
          return <div key={g.id} className={gi > 0 ? 'mt-3' : 'mt-1'}>
            <button type="button" aria-expanded={!shut} aria-controls={'nav-g-' + g.id} onClick={() => onToggleGroup(g.id)} className={cn('group flex h-7 w-full cursor-pointer items-center gap-1.5 pr-4 pl-11 t-micro font-semibold tracking-[0.06em] text-rail-muted/80 uppercase transition-colors hover:text-sidebar-foreground', focus)}>
              <span className="flex-1 text-left">
                {g.label}
              </span>
              {hot ? <span className="size-[7px] rounded-full bg-vivo" title="Há atividade neste grupo" /> : null}
              <I.ChevronDown className={cn('size-3.5 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100', shut && '-rotate-90 opacity-100')} />
            </button>
            {shut ? null : <div id={'nav-g-' + g.id}>
              {g.items.map(item)}
            </div>}
          </div>;
        })}
      </div>}
    </div>
    {d?.versionCheck?.update ? (rail ? <Tip side="right" text={`Versão ${d.versionCheck.remote} disponível (você está na ${d.versionCheck.local})`}>
      <a href="#/overview" onClick={onNavigate} aria-label={`Versão ${d.versionCheck.remote} disponível`} className={cn('mb-2 grid size-9 max-lg:size-11 shrink-0 place-items-center text-metal transition-colors hover:bg-sidebar-accent', focus)}>
        <I.CircleArrowUp className="size-4" />
      </a>
    </Tip>
      : <a href="#/overview" onClick={onNavigate} title={`Você está na ${d.versionCheck.local}`} className={cn('flex shrink-0 items-center gap-2 border-t border-sidebar-border px-4 py-2.5 t-meta text-rail-muted transition-colors hover:text-sidebar-foreground', focus)}>
        <I.CircleArrowUp className="size-3.5 shrink-0 text-metal" />
        <span className="truncate">
          {"Versão "}
          {d.versionCheck.remote}
          {" disponível"}
        </span>
      </a>) : null}
    {d ? (rail ? <Tip side="right" text={`Memória do Hades · ${sliceText}`}>
      <div className="mb-4 flex w-10 shrink-0 flex-col items-center gap-1" role="img" aria-label={`Memória do Hades ${Math.round(slicePct)}%`}>
        <span className="font-mono t-micro leading-none tnum text-rail-muted">
          {Math.round(slicePct)}
          %
        </span>
        <div className="h-[3px] w-8 bg-sidebar-foreground/10">
          <div className={cn('h-full transition-[width] duration-700', SLICE_BAR[sliceKind])} style={{ width: slicePct + '%' }} />
        </div>
      </div>
    </Tip>
      : <div className="shrink-0 border-t border-sidebar-border px-4 py-3 t-meta text-rail-muted">
        <div className="flex items-center justify-between gap-2">
          <Tip text={`Teto de memória do slice systemd hades (HADES_SLICE_MAX = ${d.config?.HADES_SLICE_MAX ?? '—'})`}><span>Memória do Hades</span></Tip>
          <span className="font-mono tnum text-sidebar-foreground">
            {sliceText}
          </span>
        </div>
        <div className="mt-2 h-[3px] bg-sidebar-foreground/10" role="img" aria-label={`Memória do Hades ${Math.round(slicePct)}% do teto`}>
          <div className={cn('h-full transition-[width] duration-700 ease-out', SLICE_BAR[sliceKind])} style={{ width: slicePct + '%' }} />
        </div>
      </div>) : null}
  </nav>;
}
function LiveIndicator({ lastOk, frozen }) {
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const stale = !lastOk || Date.now() - lastOk > 12000;
  return <div className="hidden items-center gap-2 t-meta text-muted-foreground sm:flex">
    <Dot kind={frozen ? 'idle' : stale ? 'bad' : 'ok'} pulse={!frozen && !stale} />
    {frozen ? 'Congelado' : stale ? 'Sem dados do servidor' : <>
      {"Ao vivo "}
      <span className="font-mono tabular-nums">
        {new Date(lastOk).toLocaleTimeString('pt-BR')}
      </span>
    </>}
  </div>;
}
function flipTheme() {
  const v = !document.documentElement.classList.contains('dark');
  document.documentElement.classList.toggle('dark', v);
  try { localStorage.setItem('hades-panel-theme', v ? 'dark' : 'light'); } catch (e) {}
  return v;
}
// página em modo stage não tem o indicador "Ao vivo" do topo: a falha da atualização aparece dentro do canvas
function StageNotice({ lastOk, frozen }) {
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const stale = !lastOk || Date.now() - lastOk > 12000;
  if (!frozen && !stale) return null;
  return <div role="status" className="pointer-events-none absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 border border-border-strong bg-popover px-3 py-1.5 t-meta text-popover-foreground shadow-lg">
    <Dot kind={frozen ? 'idle' : 'bad'} />
    {frozen ? 'Congelado: a tela não atualiza' : 'Sem dados do servidor'}
  </div>;
}
function ThemeToggle() {
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  const flip = () => setDark(flipTheme());
  return <Tip text={dark ? 'Tema claro' : 'Tema escuro'} side="bottom">
    <Button variant="ghost" size="icon-sm" aria-label="Alternar tema" onClick={flip}>
      <span className="relative size-4">
        <I.Sun className={cn('absolute inset-0 size-4 transition-all duration-300', dark ? 'rotate-90 scale-0' : 'rotate-0 scale-100')} />
        <I.Moon className={cn('absolute inset-0 size-4 transition-all duration-300', dark ? 'rotate-0 scale-100' : '-rotate-90 scale-0')} />
      </span>
    </Button>
  </Tip>;
}

// ================================================================== ações compartilhadas
function useActions() {
  const { toast, confirm, openJob, refresh } = useApp();
  const run = useCallback(async (body, c) => {
    if (c && !(await confirm(c))) return false;
    try {
      const r = await post('/api/action', body);
      toast({ kind: 'busy', title: 'Ação iniciada', desc: c?.title?.replace(/\?$/, '') || body.action, action: { label: 'Ver execução', icon: I.SquareTerminal, onClick: () => openJob(r.job) } });
      setTimeout(refresh, 500);
      return r.job;
    } catch (e) { toast({ kind: 'bad', title: 'Não foi possível iniciar', desc: e.message }); return false; }
  }, [toast, confirm, openJob, refresh]);
  return run;
}

// ------------------------------------------------------------------ diálogos de ciclo
function RunHadesDialog({ open, onClose, d }) {
  const run = useActions();
  const [prs, setPrs] = useState('');
  const cfg = d?.config || {};
  // passos ligáveis: o túnel (núcleo) e os do plugin (runFlags), cada um com o padrão na sua chave HADES_RUN_*
  const steps = [
    { key: 'tunnel', label: 'Túnel público', config: 'HADES_RUN_TUNNEL',
      hint: cfg.HADES_TUNNEL_PORT ? `Ligado: acesso anônimo de 1 dia ao front; quem tiver a URL acessa. Desligado: front só local, em :${cfg.HADES_TUNNEL_PORT}` : 'Sem porta do túnel nas Configurações' },
    ...pluginList('runFlags').filter((s) => s.key !== 'tunnel' && s.key !== 'rebuild').map((s) => ({ key: s.key, label: s.label || s.key, hint: s.hint || '', config: s.config })),
  ];
  const base = { ...Object.fromEntries(steps.map((s) => [s.key, !s.config || (s.key === 'tunnel' ? cfg[s.config] === '1' : cfg[s.config] !== '0')])), rebuild: false };
  const [f, setF] = useState(base);
  useEffect(() => { if (open) setF(base); }, [open]);
  // padrão de cada passo = Configurações (HADES_RUN_*); só o que o dono mudou aqui vira flag desta execução
  const flags = [...steps.map((s) => s.key).filter((k) => f[k] !== base[k]).map((k) => (f[k] ? '--' : '--no-') + k), ...(f.rebuild ? ['--rebuild'] : [])];
  const go = async () => { if (await run({ action: 'run-hades', prs, flags })) onClose(); };
  return <Dialog open={open} onClose={onClose} label="Subir o Hades" className="sm:max-w-xl">
    <DialogHeader icon={I.Rocket} title="Subir o Hades" description="Refaz a hades/local com as PRs, sobe infra e serviços, compila o que mudou e liga o túnel (se estiver ligado abaixo). Pode repetir sem efeito colateral: serve depois de um reboot." />
    <div className="grid gap-2">
      <label className="t-label" htmlFor="rs-prs">Conjunto de PRs</label>
      <Input id="rs-prs" icon={I.GitPullRequest} value={prs} onInput={(e) => setPrs(e.target.value)} placeholder="vazio = conjunto atual · 4937 @me -4964 · develop" />
      <p className="t-meta text-muted-foreground">
        {"Números, "}
        <code>@me</code>
        {", "}
        <code>author:login</code>
        {", "}
        <code>-N</code>
        {" para tirar, ou "}
        <code>develop</code>
        {" para a base pura do projeto."}
      </p>
    </div>
    <div className="grid gap-2 sm:grid-cols-2">
      {[...steps.map((s) => [s.key, s.label, s.hint]), ['rebuild', 'Recompilar tudo', 'Recompila tudo, mesmo sem mudança (--rebuild)']].map(([k, l, h]) =>
        <Field key={k} label={l} hint={k === 'rebuild' ? h : `${h ? h + '. ' : ''}Padrão nas Configurações: ${base[k] ? 'ligado' : 'desligado'}`}>
          <Switch checked={f[k]} label={l} onChange={(v) => setF({ ...f, [k]: v })} />
        </Field>)}
    </div>
    <div className="flex gap-2.5 border border-warn/30 bg-warn/8 p-3 t-meta">
      <I.TriangleAlert className="size-4 shrink-0 text-warn" />
      <span>
        {"Firewall (sudo) e o primeiro login no devtunnel exigem terminal: numa máquina nova, rode o primeiro "}
        <code>run-hades</code>
        {" lá."}
      </span>
    </div>
    <div className="bg-muted px-3 py-2 t-data text-muted-foreground">
      {"$ run-hades "}
      {[prs, ...flags].filter(Boolean).join(' ') || ''}
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>Cancelar</Button>
      <Button icon={I.Rocket} onClick={go}>Subir Hades</Button>
    </DialogFooter>
  </Dialog>;
}
function UpdateDialog({ open, onClose }) {
  const run = useActions();
  const [all, setAll] = useState(false);
  return <Dialog open={open} onClose={onClose} label="Atualizar o Hades">
    <DialogHeader icon={I.RefreshCw} title="Atualizar o Hades" description="Refaz a hades/local do zero (git reset --hard na base): commits e alterações feitos direto nela se perdem; as resoluções de conflito voltam pelo rerere. Depois recompila e reinicia só o que mudou. Conflito novo interrompe o ciclo sem reiniciar nada." />
    <Field label="Recompilar tudo (--all)" hint="Recompila e reinicia todos os serviços.">
      <Switch checked={all} onChange={setAll} label="--all" />
    </Field>
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>Cancelar</Button>
      <Button icon={I.RefreshCw} onClick={async () => { if (await run({ action: 'update', all })) onClose(); }}>Atualizar</Button>
    </DialogFooter>
  </Dialog>;
}

// ================================================================== blocos das páginas (núcleo e plugins)
// entrada da página a cada troca de hash (FadeContent, sob demanda). O div é sempre o mesmo, com o fx ou sem ele: a página
// aparece na hora e nunca remonta quando o componente chega. live=false (primeira carga, que já tem a abertura) não anima.
const FADE_PAGINA = { effect: 'mist', duration: 1, stagger: 0.1, staggerFrom: 'start', follow: true };
function FadeSlot({ live, children, ...rest }) {
  const Fade = window.HadesFx.use('FadeContent');
  const ref = React.useRef(null);
  React.useLayoutEffect(() => {
    const a = live && Fade ? Fade.play(ref.current, FADE_PAGINA) : null;
    return () => a?.cancel();
  }, []);
  return <div ref={ref} {...rest}>{children}</div>;
}

// número que conta ao mudar (NumberTicker, sob demanda); texto, ou número antes do ticker chegar, aparece como veio
function Num({ value, format, decimals = 0 }) {
  const Ticker = window.HadesFx.use('NumberTicker', typeof value === 'number');
  if (typeof value !== 'number') return value ?? null;
  return Ticker ? <Ticker value={value} format={format} decimals={decimals} /> : <span className="tnum">{format ? format(value) : value}</span>;
}

// o fio das Moiras: fiando (rodando), medido (concluído, nós nos marcos em %), cortado (falhou em `corte`%), frouxo
// (esperando), parado. Sempre com rótulo: é imagem para o leitor de tela
const FIO_ESTADO = { fiando: 'rodando', medido: 'concluído', cortado: 'falhou', frouxo: 'esperando', parado: 'parado' };
function Fio({ s = 'parado', nos = [], corte = 70, label, className }) {
  return <div className={cn('fio', className)} data-s={s} role="img" aria-label={label || FIO_ESTADO[s]}>
    {s === 'cortado' ? <>
      <span className="antes" style={{ width: `${corte}%` }} />
      <svg width="10" height="12" style={{ left: `calc(${corte}% - 1px)` }} aria-hidden="true">
        <path d="M0 6 L8 1 M0 6 L9 6 M0 6 L8 11" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      </svg>
      <span className="depois" style={{ width: `${Math.max(0, 100 - corte - 6)}%` }} />
    </> : null}
    {nos.map((n) => <span key={n} className="no" style={{ left: `${n}%` }} />)}
  </div>;
}

// régua de leituras: uma peça com divisórias de 1 px; cada Leitura tem rótulo, número e a forma que é o próprio dado
const Regua = ({ label, className, children }) => <section aria-label={label} className={cn('grid grid-cols-2 border bg-card lg:grid-cols-4 [&>*]:border-border max-lg:[&>*:nth-child(odd)]:border-r max-lg:[&>*:nth-child(-n+2)]:border-b lg:[&>*:not(:last-child)]:border-r', className)}>
  {children}
</section>;
function Leitura({ label, value, unit, detail, format, decimals, onClick, children }) {
  const body = <>
    <span className="t-label text-muted-foreground">
      {label}
    </span>
    <span className="mt-1 flex items-baseline gap-1.5">
      <span className="t-kpi leading-none">
        <Num value={value} format={format} decimals={decimals} />
      </span>
      {unit ? <span className="t-body text-muted-foreground tnum">
        {unit}
      </span> : null}
    </span>
    {children ? <div className="mt-3">
      {children}
    </div> : null}
    {detail ? <span className="mt-2 t-meta text-muted-foreground md:truncate">
      {detail}
    </span> : null}
  </>;
  const cls = 'flex min-w-0 flex-col px-5 py-4 text-left max-md:px-4';
  return onClick ? <button type="button" onClick={onClick} className={cn(cls, 'cursor-pointer transition-colors hover:bg-accent/60 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring')}>
    {body}
  </button> : <div className={cls}>
    {body}
  </div>;
}
// um traço por unidade, na altura e no tom do estado: a contagem vira forma ("24/28" e quais caíram)
const TRACO = { ok: 'h-2.5 bg-ok', warn: 'h-3 bg-warn', bad: 'h-4 bg-bad', idle: 'h-2.5 bg-border-strong' };
const Tracos = ({ items, label, className }) => <div className={cn('flex h-4 flex-wrap items-end gap-[2px] overflow-hidden', className)} role="img" aria-label={label}>
  {items.map((k, i) => <span key={i} className={cn('w-[3px]', TRACO[k] || TRACO.idle)} />)}
</div>;
// linha de estado da página: o número que importa e os vizinhos apagados ("3 gates rodando · 2 esperando")
const LinhaDeEstado = ({ main, rest = [], className }) => <p className={cn('t-body', className)}>
  <span className="font-medium">
    {main}
  </span>
  {rest.filter(Boolean).map((r, i) => <span key={i} className="text-muted-foreground">
    {' · '}
    {r}
  </span>)}
</p>;

// leitura avulsa (contrato dos plugins): rótulo, número e detalhe no chão, com o filete de cima no tom do estado
const KPI_TONE = { ok: 'border-t-ok', warn: 'border-t-warn', bad: 'border-t-bad' };
function Kpi({ icon: Icon, label, value, sub, children, tone, onClick }) {
  const body = <>
    <span className="flex items-center gap-1.5 t-label text-muted-foreground">
      {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
      {label}
    </span>
    <span className="t-kpi leading-tight">
      <Num value={value} />
    </span>
    {sub ? <span className="truncate t-meta text-muted-foreground">
      {sub}
    </span> : null}
    {children ? <div className="mt-1">
      {children}
    </div> : null}
  </>;
  const cls = cn('flex min-w-0 flex-col gap-1 border-t-2 border-t-border-strong pt-3 text-left', KPI_TONE[tone]);
  return onClick ? <button type="button" onClick={onClick} className={cn(cls, 'cursor-pointer transition-colors hover:border-t-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring')}>
    {body}
  </button> : <div className={cls}>
    {body}
  </div>;
}
const QA_TONE = { ok: 'text-ok', warn: 'text-warn', violet: 'text-info' };
function QuickAction({ icon: Icon, title, desc, children, tone = 'default', disabled }) {
  return <div className={cn('flex flex-col gap-3 border-t pt-3', disabled && 'opacity-70')}>
    <div className="flex items-start gap-2.5">
      <Icon className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground', QA_TONE[tone])} aria-hidden="true" />
      <div className="grid gap-0.5 min-w-0">
        <div className="t-label">
          {title}
        </div>
        <div className="t-meta text-muted-foreground">
          {desc}
        </div>
      </div>
    </div>
    <div className="mt-auto flex flex-wrap gap-2">
      {children}
    </div>
  </div>;
}
const JOB_ST = { rodando: { kind: 'warn', icon: I.LoaderCircle, label: 'Rodando' }, ok: { kind: 'ok', icon: I.CircleCheck, label: 'Concluída' },
  falhou: { kind: 'bad', icon: I.CircleX, label: 'Falhou' }, interrompido: { kind: 'idle', icon: I.CircleSlash, label: 'Interrompida' } };
// onde o fio de uma execução que falhou se corta: a duração dela sobre a mediana das que deram certo na mesma ação
function cutAt(j, jobs) {
  const ok = jobs.filter((x) => x.action === j.action && x.state === 'ok' && x.ended).map((x) => x.ended - x.started).sort((a, b) => a - b);
  return ok.length && j.ended ? Math.min(94, Math.max(8, (j.ended - j.started) / ok[ok.length >> 1] * 100)) : 70;
}
function jobFio(j, jobs = [j]) {
  if (j.state === 'rodando') return { s: 'fiando' };
  if (j.state === 'ok') return { s: 'medido', nos: [0, 100] };
  if (j.state === 'falhou') return { s: 'cortado', corte: cutAt(j, jobs) };
  return { s: 'parado' };
}
// uma execução é um fio; `jobs` (opcional) dá a mediana da mesma ação para o ponto do corte
function JobRow({ j, now, onClick, active, jobs }) {
  const st = JOB_ST[j.state] || JOB_ST.interrompido;
  const fio = jobFio(j, jobs);
  const took = dur((j.ended || now) - j.started);
  return <button type="button" onClick={onClick} aria-current={active || undefined} className={cn('group grid w-full gap-2 border-b border-l-2 border-l-transparent px-3 py-3 text-left transition-colors hover:bg-accent/60 cursor-pointer outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring', active && 'border-l-foreground bg-accent/40')}>
    <span className="flex items-baseline gap-2">
      <span className={cn('min-w-0 flex-1 truncate t-label', j.state === 'falhou' && 'text-bad')}>
        {j.title}
      </span>
      <span className="shrink-0 t-data text-muted-foreground">
        {j.state === 'rodando' ? took : ago(j.ended || j.started)}
      </span>
    </span>
    <Fio s={fio.s} nos={fio.nos} corte={fio.corte} label={`${j.title}: ${FIO_ESTADO[fio.s]}`} />
    <span className="flex gap-2 t-meta text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">
        {st.label.toLowerCase() + (j.state === 'falhou' ? ` · saída ${j.rc}` : '')}
      </span>
      <span className="shrink-0 tnum md:invisible md:group-hover:visible md:group-focus-visible:visible md:group-aria-[current]:visible">
        {dt(j.started) + ' · ' + took}
      </span>
    </span>
  </button>;
}

// ------------------------------------------------------------------ cartão de unidade e túnel público (também para as páginas do plugin)
// plugins ainda passam delay: fica ignorado, a entrada escalonada saiu do sistema
const Svc = ({ icon, title, desc, st, mem, children, extra }) => <Card variant="object">
  <CardHeader icon={icon} title={title} description={desc} action={<StateBadge st={st} />} />
  {extra ? <CardContent>
    {extra}
  </CardContent> : null}
  <CardContent className="mt-auto flex flex-wrap items-center gap-2">
    {children}
    {mem != null ? <span className="ml-auto t-data text-muted-foreground">
      {mb(mem)}
    </span> : null}
  </CardContent>
</Card>;
function TunnelCard({ d }) {
  const { openLog } = useApp();
  const run = useActions();
  const t = d.extras?.tunnel || {}, port = d.config?.HADES_TUNNEL_PORT;
  return <Svc icon={I.Earth} title="Túnel público" mem={t.mem} st={unitState(t)} desc={`Expõe só o front (${port ? ':' + port : 'porta HADES_TUNNEL_PORT vazia'}) pelo devtunnel.`} extra={d.tunnelUrl ? <div className="flex items-center gap-2 border bg-muted/40 px-3 py-2">
    <I.Link className="size-4 shrink-0 text-muted-foreground" />
    <a href={d.tunnelUrl} target="_blank" rel="noopener" className="min-w-0 flex-1 truncate t-data hover:underline">
      {d.tunnelUrl}
    </a>
    <CopyButton text={d.tunnelUrl} label="Copiar URL" />
  </div> : null}>
    {t.state === 'active'
      ? <>
        <Button size="sm" variant="outline" icon={I.RefreshCw} onClick={() => run({ action: 'tunnel', op: 'url' })}>Reler URL</Button>
        <Button size="sm" variant="ghost-destructive" icon={I.CircleStop} onClick={() => run({ action: 'tunnel', op: 'stop' }, { title: 'Parar o túnel?', description: 'A URL pública deixa de responder.', icon: I.CircleStop, danger: true })}>Parar</Button>
      </>
      : <Button size="sm" icon={I.Earth} disabled={!port} onClick={() => run({ action: 'tunnel', op: 'start' }, { title: 'Publicar o front na internet?', description: `Cria acesso ANÔNIMO de 1 dia ao front (:${port}) e reinicia os serviços que leem a URL. Quem tiver a URL acessa o Hades.`, icon: I.Earth, danger: true })}>Publicar</Button>}
    <Button size="sm" variant="ghost" icon={I.ScrollText} onClick={() => openLog(`unit:${d.unitPrefix || 'hds'}-devtunnel`, `Túnel (${d.unitPrefix || 'hds'}-devtunnel)`)}>Log</Button>
  </Svc>;
}

// ------------------------------------------------------------------ controles e seletor de PRs (Branch e PRs, Revisões, Configurações)
const ago = (iso) => { const s = (Date.now() - (typeof iso === 'number' ? iso * 1000 : Date.parse(iso))) / 1000; return s < 45 ? 'agora' : 'há ' + dur(s); };
// RubberSegment (fx/, sob demanda) troca o miolo: a mesma caixa (borda, altura, rolagem) e a mesma assinatura; antes de ele chegar,
// ou com movimento reduzido/saveData, vale o miolo comum, com as mesmas medidas
const SegmentLabel = ({ it }) => <>
  {it.icon ? <it.icon /> : null}
  {it.label}
  {it.count != null ? <span className="font-mono t-micro tabular-nums opacity-60">
    {it.count}
  </span> : null}
</>;
const Segmented = ({ value, onChange, items, className, label }) => {
  const Rubber = window.HadesFx.use('RubberSegment');
  return <div role="tablist" aria-label={label} className={cn('inline-flex h-8 max-w-full items-stretch overflow-x-auto overflow-y-hidden border border-border-strong t-label text-muted-foreground scrollbar-thin max-md:h-11', className)}>
  {Rubber ? <Rubber value={value} onChange={onChange} items={items.map((it) => ({ value: it.value, content: <SegmentLabel it={it} /> }))} /> : items.map((it) => <button key={it.value} type="button" role="tab" aria-selected={value === it.value} onClick={() => onChange(it.value)} className={cn('inline-flex items-center gap-1.5 px-3 font-medium whitespace-nowrap transition-colors cursor-pointer outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&>svg]:size-4 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-border', value === it.value ? 'bg-muted text-foreground' : 'hover:text-foreground')}>
    <SegmentLabel it={it} />
  </button>)}
</div>;
};
// quantas linhas o LogViewer pede ao servidor (o "últimas N")
const LOG_TAILS = [300, 800, 2000, 5000].map((v) => ({ value: String(v), label: String(v) }));
// largura da janela acima de um ponto de quebra (px), viva: troca a forma de um controle, não só o estilo
function useWide(px) {
  const [w, setW] = useState(() => matchMedia(`(min-width: ${px}px)`).matches);
  useEffect(() => {
    const m = matchMedia(`(min-width: ${px}px)`);
    const f = () => setW(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [px]);
  return w;
}
// alternância na mesa, Select no celular (abas não cabem em 390 px)
function Choice({ wide, value, onChange, items, label, className }) {
  if (wide) return <Segmented label={label} value={value} onChange={onChange} items={items} />;
  return <Select value={value} onChange={onChange} items={items} label={label} className={cn('min-w-0', className)} />;
}

// Select: no lugar do select nativo. Gatilho e lista desenhados com os tokens do tema; lista em popover na mesa e em folha de
// baixo no celular. `value` e `onChange(value)` são sempre texto, como no nativo. Regra do teclado e da busca: select-logic.tsx.
const SELECT_SIZE = { sm: 'h-8 px-2 max-md:h-11 max-md:px-3', md: 'h-11 px-3' };
const SELECT_MIN_WIDTH = 176;
const SELECT_MAX_HEIGHT = 320;
const SELECT_EDGE = 8;
const SELECT_BREAKPOINT = 768;
const Select = React.forwardRef(function Select({ value = '', onChange, items = [], label, size = 'md', disabled, className, placeholder, autoFocus, id }: any, ref) {
  const wide = useWide(SELECT_BREAKPOINT);
  const uid = 'sel' + useId().replace(/:/g, '');
  const trigger = useRef(null);
  const focusEl = useRef(null);
  const setTrigger = (el) => { trigger.current = el; if (typeof ref === 'function') ref(el); else if (ref) ref.current = el; };
  const [st, setSt] = useState(() => SL.initial());
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState(null);
  const hasSearch = SL.searchable(items);
  const visible = SL.ordered(SL.filter(items, query));
  const picked = items.find((it) => it.value === value);
  const optId = (i) => `${uid}-o${i}`;

  const measure = () => {
    const r = trigger.current.getBoundingClientRect();
    const width = Math.max(r.width, SELECT_MIN_WIDTH);
    const left = Math.max(SELECT_EDGE, Math.min(r.left, innerWidth - width - SELECT_EDGE));
    const below = innerHeight - r.bottom - SELECT_EDGE * 2, above = r.top - SELECT_EDGE * 2;
    const up = below < 200 && above > below;
    return { left, width, maxHeight: Math.min(SELECT_MAX_HEIGHT, up ? above : below), ...(up ? { bottom: innerHeight - r.top + 4 } : { top: r.bottom + 4 }) };
  };
  const begin = (next) => { setPos(measure()); setQuery(''); setSt(next); };
  const close = (refocus) => { setSt((s) => ({ ...s, open: false })); setQuery(''); if (refocus) trigger.current?.focus(); };
  const choose = (v) => { close(true); onChange?.(v); };
  const toggle = () => st.open ? close(true) : begin({ ...st, open: true, active: SL.initialActive(visible, value) });

  const onKey = (e) => {
    const ev = { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey };
    if (!st.open && hasSearch && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setPos(measure()); setQuery(e.key);
      setSt({ ...st, open: true, active: SL.afterFilter(SL.ordered(SL.filter(items, e.key)), value) });
      return;
    }
    const step = SL.keyStep(visible, value, st, ev, Date.now(), hasSearch);
    if (step.handled) { e.preventDefault(); if (st.open) e.stopPropagation(); }
    if (step.state.open && !st.open) begin(step.state); else setSt(step.state);
    if (st.open && !step.state.open) {
      setQuery('');
      if (e.key === 'Tab' || e.key === 'Escape' || step.pick !== undefined) trigger.current?.focus();
    }
    if (step.pick !== undefined) onChange?.(step.pick);
  };
  const onSearch = (e) => {
    setQuery(e.target.value);
    setSt((s) => ({ ...s, active: SL.afterFilter(SL.ordered(SL.filter(items, e.target.value)), value) }));
  };

  useEffect(() => { if (st.open) focusEl.current?.focus({ preventScroll: true }); }, [st.open]);
  useEffect(() => { if (st.open) document.getElementById(optId(st.active))?.scrollIntoView({ block: 'nearest' }); }, [st.open, st.active]);
  useEffect(() => {
    if (!st.open || !wide) return;
    const away = (e) => { if (!e.target.closest?.('[data-select-pop]') && !trigger.current?.contains(e.target)) close(false); };
    const scrolled = (e) => { if (!e.target.closest?.('[data-select-pop]')) close(false); };
    const shut = () => close(false);
    addEventListener('pointerdown', away); addEventListener('scroll', scrolled, true); addEventListener('resize', shut);
    return () => { removeEventListener('pointerdown', away); removeEventListener('scroll', scrolled, true); removeEventListener('resize', shut); };
  }, [st.open, wide]);

  const rowH = wide ? 'py-1.5' : 'min-h-11 py-2';
  const body = <>
    {hasSearch ? <div className="flex items-center gap-2 border-b border-border px-2">
      <I.Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input ref={focusEl} type="text" role="combobox" aria-expanded="true" aria-controls={uid} aria-activedescendant={st.active >= 0 ? optId(st.active) : undefined} aria-label={`Buscar${label ? ' em ' + label : ''}`} autoComplete="off" placeholder="Buscar…" value={query} onChange={onSearch} className={cn('min-w-0 flex-1 bg-transparent t-body text-foreground outline-none placeholder:text-muted-foreground', wide ? 'h-9' : 'h-11')} />
    </div> : null}
    <div id={uid} role="listbox" aria-label={label} ref={hasSearch ? undefined : focusEl} tabIndex={hasSearch ? undefined : -1} aria-activedescendant={!hasSearch && st.active >= 0 ? optId(st.active) : undefined} className="min-h-0 flex-1 overflow-y-auto p-1 outline-none scrollbar-thin">
      {visible.length === 0 ? <div className="px-2 py-3 t-body text-muted-foreground">Nenhum resultado</div> : SL.rows(visible).map((r, k) => {
        if (r.kind === 'group') return <div key={'g' + k} role="presentation" className="px-2 pt-2 pb-1 t-label text-muted-foreground">{r.label}</div>;
        const it = r.item, on = it.value === value, act = r.index === st.active;
        return <div key={it.value} id={optId(r.index)} role="option" aria-selected={on} aria-disabled={it.disabled || undefined}
          onMouseMove={() => { if (!it.disabled && !act) setSt((s) => ({ ...s, active: r.index })); }}
          onClick={() => { if (!it.disabled) choose(it.value); }}
          className={cn('flex w-full cursor-pointer items-center gap-2 px-2 t-body select-none', rowH, act && 'bg-accent', it.disabled && 'cursor-not-allowed opacity-50', on && 'font-medium')}>
          {it.icon ? <it.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
          <span className="min-w-0 flex-1 truncate">
            {it.label}
            {it.hint ? <span className="ml-2 t-meta text-muted-foreground">{it.hint}</span> : null}
          </span>
          {it.count != null ? <span className="shrink-0 t-meta text-muted-foreground tnum">{it.count}</span> : null}
          {on ? <I.Check className="size-4 shrink-0" aria-hidden="true" /> : <span className="size-4 shrink-0" aria-hidden="true" />}
        </div>;
      })}
    </div>
  </>;

  return <>
    <button ref={setTrigger} id={id} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={st.open} aria-controls={st.open ? uid : undefined} aria-label={label} disabled={disabled} autoFocus={autoFocus} onClick={toggle} onKeyDown={onKey}
      className={cn('inline-flex items-center justify-between gap-2 border border-border-strong bg-background t-body text-foreground cursor-pointer select-none outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50', SELECT_SIZE[size] || SELECT_SIZE.md, className)}>
      {picked?.icon ? <picked.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
      <span className={cn('min-w-0 flex-1 truncate text-left', !picked && 'text-muted-foreground')}>
        {picked ? picked.label + (picked.count != null ? ` (${picked.count})` : '') : (placeholder ?? '')}
      </span>
      <I.ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
    {st.open && wide && pos ? ReactDOM.createPortal(<div data-select-pop style={pos} onKeyDown={onKey} className="fixed z-[60] flex flex-col overflow-hidden border border-border-strong bg-popover text-popover-foreground shadow-lg animate-fade-in">
      {body}
    </div>, document.body) : null}
    {!wide ? <Sheet open={st.open} side="bottom" title={label} onClose={() => close(true)}>
      <div data-select-pop onKeyDown={onKey} className="flex max-h-[60dvh] flex-col">
        {body}
      </div>
    </Sheet> : null}
  </>;
});
function Checkbox({ checked, onChange, label }) {
  return <button type="button" role="checkbox" aria-checked={checked} aria-label={label} onClick={(e) => { e.stopPropagation(); onChange(!checked); }} className={cn('relative grid size-4 shrink-0 place-items-center border transition-colors cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring', checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong')}>
    {checked ? <I.Check className="size-3.5" strokeWidth={3} aria-hidden="true" /> : null}
  </button>;
}

const plural = (n, one, many) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
// o erro do gh em palavras; o texto cru fica ao lado, apagado, para quem for investigar
const ghError = (e) => /HTTP 401|auth login|not logged/i.test(e) ? 'O gh não está autenticado: rode gh auth login no terminal.'
  : /HTTP 403|rate limit/i.test(e) ? 'O GitHub limitou as consultas: espere alguns minutos e tente de novo.'
    : /HTTP 422/.test(e) ? 'O GitHub recusou a busca: confira o autor e o texto do filtro.'
      : 'O GitHub não devolveu a lista de PRs.';

const Caixa = ({ on }) => <span aria-hidden="true" className={cn('mt-0.5 grid size-4 shrink-0 place-items-center border transition-colors', on ? 'border-foreground bg-foreground text-background' : 'border-border-strong group-hover:border-foreground')}>
  {on ? <I.Check className="size-3" strokeWidth={3} /> : null}
</span>;

// cada PR é um checkbox de verdade, sem pílulas nem selos; `onItems` (opcional) devolve as PRs vistas na página
// (a trança da Branch e PRs usa para ter os títulos)
function PrPicker({ sel, toggle, applied, inSet, onItems }) {
  const wide = useWide(768);
  const [author, setAuthor] = useState(() => { try { return localStorage.getItem('panel-pr-author') ?? '@me'; } catch (e) { return '@me'; } });
  const [authorDraft, setAuthorDraft] = useState('');
  const [text, setText] = useState('');
  const [textDraft, setTextDraft] = useState('');
  const [drafts, setDrafts] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [authors, setAuthors] = useState({ me: null, recent: [] });
  const per = 15;
  const load = useCallback(async (refresh) => {
    setLoading(true); setErr(null);
    try {
      const r = await getJSON(`/api/github/prs?author=${encodeURIComponent(author)}&page=${page}&per=${per}&q=${encodeURIComponent(text)}&drafts=${drafts ? 1 : 0}${refresh ? '&refresh=1' : ''}`);
      if (r.error && !r.items) throw new Error(r.error);
      setData(r); if (r.error) setErr(r.error);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }, [author, page, text, drafts]);
  useEffect(() => { load(false); }, [load]);
  useEffect(() => { if (data?.items) onItems?.(data.items); }, [data]);
  // a lista de autores recentes é só sugestão: sem ela o filtro continua com Minhas, Todas e o login digitado
  useEffect(() => { try { localStorage.setItem('panel-pr-author', author); } catch (e) {} getJSON('/api/github/authors').then(setAuthors).catch(() => {}); }, [author]);
  const pages = data ? Math.max(1, Math.ceil(data.total / per)) : 1;
  const opts = [{ value: '@me', label: 'Minhas' }, { value: '', label: 'Todas' }, ...authors.recent.filter((a) => a !== authors.me).slice(0, 6).map((a) => ({ value: a, label: a }))];
  if (!opts.some((o) => o.value === author)) opts.push({ value: author, label: author });
  const setA = (a) => { setAuthor(a); setPage(1); };
  const who = author === '@me' ? (authors.me || 'você') : author;
  return <div className="grid gap-4">
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Choice wide={wide} label="Autor das PRs" value={author} onChange={setA} items={opts} />
        <form className="max-md:flex-1" onSubmit={(e) => { e.preventDefault(); if (authorDraft.trim()) { setA(authorDraft.trim().replace(/^@(?!me$)/, '')); setAuthorDraft(''); } }}>
          <Input icon={I.AtSign} className="md:w-44" aria-label="Outro autor (login do GitHub, Enter para filtrar)" placeholder="outro autor" value={authorDraft} onInput={(e) => setAuthorDraft(e.target.value)} />
        </form>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <form className="flex min-w-0 flex-1 basis-60" onSubmit={(e) => { e.preventDefault(); setText(textDraft); setPage(1); }}>
          <Input icon={I.Search} aria-label="Buscar no título (Enter para buscar)" placeholder="Buscar no título (Enter)" value={textDraft} onInput={(e) => setTextDraft(e.target.value)} />
        </form>
        <label className="flex cursor-pointer items-center gap-2 t-body text-muted-foreground max-md:h-11">
          <Switch checked={drafts} onChange={(v) => { setDrafts(v); setPage(1); }} label="Incluir rascunhos" />
          rascunhos
        </label>
        <Tip text="Ignora o cache de 5 min e consulta o GitHub agora">
          <Button size="sm" variant="outline" icon={I.RefreshCw} loading={loading && !!data} onClick={() => load(true)}>Recarregar do GitHub</Button>
        </Tip>
      </div>
    </div>
    <div>
      <p className="pb-2 t-meta text-muted-foreground tnum" aria-live="polite">
        {data ? <>
          {plural(data.total, 'PR aberta', 'PRs abertas') + (author ? ` de ${who}` : ' no repositório')}
          {` · ${data.fromCache ? 'do cache' : 'direto do GitHub'}, ${ago(data.cachedAt)}`}
          {data.stale ? <span className="text-warn">
            {" · cache vencido: o GitHub não respondeu"}
          </span> : null}
        </> : loading ? 'Consultando o GitHub…' : ' '}
      </p>
      <div className="max-h-[36rem] overflow-x-hidden overflow-y-auto border-t scrollbar-thin">
        {err && !data?.items ? <div role="alert" className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-3 t-body">
          <span className="flex items-start gap-2 font-medium">
            <I.CircleX className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden="true" />
            {ghError(err)}
          </span>
          <span className="min-w-0 t-data break-words text-muted-foreground">
            {err}
          </span>
          <Button size="xs" variant="outline" className="ml-auto" icon={I.RefreshCw} loading={loading} onClick={() => load(true)}>Tentar de novo</Button>
        </div>
          : !data && loading ? [0, 1, 2, 3, 4].map((i) => <div key={i} className="grid gap-2 border-b px-3 py-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>)
            : data?.items?.length ? data.items.map((p) => { const on = sel.has(p.number); return <div key={p.number} className={cn('group relative flex items-start gap-3 border-b border-l-2 py-2.5 pr-1 pl-3 transition-colors', on ? 'border-l-foreground bg-accent/40' : 'border-l-transparent hover:bg-accent/60')}>
              <button type="button" role="checkbox" aria-checked={on} aria-label={`#${p.number} ${p.title}`} onClick={() => toggle(p.number)} className="flex min-w-0 flex-1 items-start gap-3 text-left cursor-pointer outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring">
                <Caixa on={on} />
                <span className="min-w-0 flex-1">
                  <span className="block t-body">
                    <span className="mr-2 font-mono t-label tnum">
                      {'#' + p.number}
                    </span>
                    {p.title}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 t-meta text-muted-foreground">
                    {applied.has(p.number) ? <span className="inline-flex items-center gap-1.5 text-foreground">
                      <Dot kind="ok" />
                      na branch
                    </span> : inSet.has(p.number) ? <span className="text-foreground">no conjunto, fora da branch (prs.list)</span> : null}
                    {p.draft ? <span>rascunho</span> : null}
                    <span>
                      {p.author}
                    </span>
                    <span className="tnum">
                      {'atualizada ' + ago(p.updatedAt)}
                    </span>
                    {p.comments ? <span className="tnum">
                      {plural(p.comments, 'comentário', 'comentários')}
                    </span> : null}
                    {p.labels.slice(0, 3).map((l) => <span key={l.name} className="inline-flex items-center gap-1">
                      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ background: '#' + l.color }} />
                      {l.name}
                    </span>)}
                  </span>
                </span>
              </button>
              <Tip text="Abrir no GitHub" className="relative z-10">
                <a href={p.url} target="_blank" rel="noopener" aria-label={`Abrir #${p.number} no GitHub`} className="grid size-8 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-md:size-11">
                  <I.ExternalLink className="size-4" aria-hidden="true" />
                </a>
              </Tip>
            </div>; })
              : data ? <Empty icon={I.GitPullRequest} title={text ? `Nenhuma PR aberta com "${text}".` : 'Nenhuma PR aberta neste filtro.'}>
                {drafts ? null : 'Rascunhos ocultos: ligue "rascunhos".'}
              </Empty> : null}
      </div>
    </div>
    {pages > 1 ? <nav aria-label="Páginas de PRs" className="flex flex-wrap items-center justify-between gap-2">
      <span className="t-meta text-muted-foreground tnum">
        {`Página ${page} de ${pages}`}
      </span>
      <div className="flex gap-1">
        <Button size="icon-sm" variant="outline" aria-label="Primeira página" icon={I.ChevronsLeft} disabled={page <= 1} onClick={() => setPage(1)} />
        <Button size="sm" variant="outline" icon={I.ChevronLeft} disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</Button>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          Próxima
          <I.ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </nav> : null}
  </div>;
}

// ------------------------------------------------------------------ terminal e log ao vivo (folhas do App, Execuções e Logs)
function Terminal({ jobId, running, className, flow }) {
  const [text, setText] = useState('');
  // na página o log rola com a janela: seguir o fim só começa ligado se a execução ainda roda
  const [follow, setFollow] = useState(!flow || !!running);
  const off = useRef(0);
  const pre = useRef(null);
  useEffect(() => { off.current = 0; setText(''); }, [jobId]);
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await getJSON(`/api/log?src=job:${encodeURIComponent(jobId)}&offset=${off.current}`);
        if (!alive || r.text === undefined) return;
        if (r.text) setText((t) => off.current === 0 ? r.text : t + r.text);
        off.current = r.offset;
      } catch (e) {}
    };
    poll();
    const t = setInterval(poll, running ? 1000 : 4000);
    return () => { alive = false; clearInterval(t); };
  }, [jobId, running]);
  useEffect(() => { setFollow(!flow || !!running); }, [jobId]);
  useEffect(() => {
    if (!follow || !text) return;
    if (flow) window.scrollTo({ top: document.documentElement.scrollHeight });
    else if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text, follow, flow]);
  return <div className={cn('relative flex flex-col border bg-term text-term-foreground', !flow && 'min-h-0 overflow-hidden', className)}>
    <div className={cn('flex items-center gap-2 border-b border-white/10 bg-term px-3 py-2', flow && 'sticky top-16 z-20')}>
      {running ? <Dot kind="busy" pulse /> : null}
      <span className="min-w-0 truncate t-data text-term-muted">
        {jobId ? 'logs/panel-jobs/' + jobId + '.log' : 'terminal'}
      </span>
      <label className="ml-auto flex cursor-pointer items-center gap-1.5 t-meta opacity-70 hover:opacity-100">
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[var(--vivo)]" />
        seguir o fim
      </label>
      {text ? <button type="button" aria-label="Copiar log" title="Copiar log" onClick={() => navigator.clipboard.writeText(text)} className="relative p-1 opacity-60 hover:bg-white/10 hover:opacity-100 cursor-pointer outline-none focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring">
        <I.Copy className="size-3.5" />
      </button> : null}
    </div>
    <pre ref={pre} className={cn('p-3 t-code whitespace-pre-wrap break-words', flow ? 'min-h-[50vh]' : 'min-h-0 flex-1 overflow-auto scrollbar-thin')}>
      {text || (jobId ? 'aguardando saída…' : 'Selecione uma execução.')}
      {running ? <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-term-foreground/80 motion-safe:animate-pulse" /> : null}
    </pre>
  </div>;
}
const logColor = (l) => /"level":\s*(50|60)|"level":"(ERROR|FATAL)"|\bERROR\b|\berro\b|FALHOU|✗/i.test(l) ? 'text-term-bad' : /"level":\s*40|"level":"WARN"|\bWARN/i.test(l) ? 'text-term-warn' : '';
// o servidor responde arquivo ausente com o errno do Python; na tela isso vira frase, e a página diz o que fazer
const LOG_MISSING = /Errno 2|No such file/;
function LogViewer({ src, title, className, flow, missing }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  // na página de Logs o log rola com a janela: abrir já no fim de um log enorme desorienta, então seguir começa desligado
  const [follow, setFollow] = useState(!flow);
  const [find, setFind] = useState('');
  const [n, setN] = useState(800);
  const pre = useRef(null);
  const load = useCallback(async () => {
    if (!src) return;
    setLoading(true);
    try {
      const r = await getJSON(`/api/log?src=${encodeURIComponent(src)}&n=${n}`);
      setErr(r.error || '');
      setText(r.error ? '' : (r.text || '(vazio)'));
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }, [src, n]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!follow || src?.startsWith('doc:')) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [follow, load, src]);
  // no modo página (flow) o log rola com a janela, e a barra lateral fica presa; seguir = descer a janela
  useEffect(() => {
    if (!follow || !text) return;
    if (flow) window.scrollTo({ top: document.documentElement.scrollHeight });
    else if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text, follow, flow]);
  const lines = useMemo(() => {
    const all = text.split('\n');
    return find ? all.filter((l) => l.toLowerCase().includes(find.toLowerCase())) : all;
  }, [text, find]);
  const errs = useMemo(() => lines.filter((l) => logColor(l) === 'text-term-bad').length, [lines]);
  const absent = LOG_MISSING.test(err);
  return <div className={cn('flex min-w-0 flex-col', !flow && 'min-h-0', className)}>
    <div className={cn('z-20 flex flex-wrap items-center gap-2 border-b bg-background pb-2.5', flow && 'sticky top-16 pt-1')}>
      <div className="flex min-w-0 flex-1 items-baseline gap-3 max-md:basis-full">
        {title ? <h2 className="truncate t-section">
          {title}
        </h2> : null}
        {text ? <span className="shrink-0 t-meta text-muted-foreground tnum">
          {`${lines.length} ${lines.length === 1 ? 'linha' : 'linhas'}`}
          {errs ? <span className="text-bad">
            {` · ${errs} com erro`}
          </span> : null}
        </span> : null}
      </div>
      <Input icon={I.TextSearch} className="md:max-w-56 max-md:basis-full" aria-label="Filtrar linhas" placeholder="Filtrar linhas…" value={find} onInput={(e) => setFind(e.target.value)} />
      {!src?.startsWith('doc:') ? <label className="flex items-center gap-1.5 t-label text-muted-foreground">
        últimas
        <Select size="sm" label="Últimas linhas" value={String(n)} onChange={(v) => setN(+v)} items={LOG_TAILS} className="tnum" />
      </label> : null}
      {!src?.startsWith('doc:') ? <Button size="sm" variant={follow ? 'secondary' : 'outline'} aria-pressed={follow} icon={follow ? I.Pause : I.Play} onClick={() => setFollow(!follow)}>
        {follow ? 'Seguindo' : 'Seguir'}
      </Button> : null}
      <Tip text="Recarregar">
        <Button size="icon-sm" variant="ghost" aria-label="Recarregar" icon={I.RefreshCw} loading={loading} onClick={load} />
      </Tip>
      {text ? <CopyButton text={text} label="Copiar log" /> : null}
      {flow ? <>
        <Tip text="Topo" className="max-md:hidden">
          <Button size="icon-sm" variant="ghost" aria-label="Topo" icon={I.ArrowUpToLine} onClick={() => { setFollow(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
        </Tip>
        <Tip text="Ir ao fim">
          <Button size="icon-sm" variant="ghost" aria-label="Ir ao fim" icon={I.ArrowDownToLine} onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })} />
        </Tip>
      </> : null}
    </div>
    {err ? <div role="status" className="grid justify-items-start gap-2 py-4 t-body">
      <p className={cn(!absent && 'text-bad')}>
        {absent ? 'Este log ainda não existe: nada foi escrito nele desde a última subida.' : `Não foi possível ler este log: ${err}`}
      </p>
      {absent ? missing : null}
    </div> : <pre ref={pre} className={cn('mt-3 border bg-term p-3 t-code text-term-foreground whitespace-pre-wrap break-all', !flow && 'min-h-0 flex-1 overflow-auto scrollbar-thin')}>
      {!text ? <span className="text-term-muted">carregando…</span> : lines.map((l, i) => <div key={i} className={cn('-mx-1 px-1 hover:bg-white/5', logColor(l))}>
        {l || ' '}
      </div>)}
    </pre>}
  </div>;
}

// ------------------------------------------------------------------ markdown (Documentação, Orquestração e Revisões)
const slugify = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/<[^>]+>/g, '').replace(/[`*_]/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
let markedReady = false;
function renderMd(text) {
  if (!markedReady) {
    marked.use({ gfm: true, renderer: {
      heading(t, level, raw) { return `<h${level} id="${slugify(raw)}">${t}</h${level}>`; },
      html() { return ''; },  // documento da skill: sem HTML cru
      link(href, title, t) { const ext = /^https?:/.test(href || ''); return `<a href="${href}"${ext ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`; },
    } });
    markedReady = true;
  }
  return marked.parse(text);
}

// ================================================================== configurações (o loadPlugin estende ícones e aplicações)
const CFG_ICON = { 'Memória': I.MemoryStick, 'Builds e fila': I.Hammer, 'Subida (run-hades)': I.Rocket,
  'Plantão': I.Eye, 'Túnel': I.Globe, 'Painel': I.LayoutDashboard, 'Orquestração': I.Workflow, 'Modelos por papel': I.Cpu, 'Contexto e espera': I.Gauge, 'Diagnóstico': I.Stethoscope, 'Limpeza': I.Eraser, 'Snapshots': I.Database, 'Notificações': I.Bell };
const CFG_APPLY = {
  slice: { label: 'Vale ao aplicar no slice', icon: I.Zap },
  services: { label: 'Reiniciar serviços', icon: I.RotateCw },
  panel: { label: 'Reiniciar o painel', icon: I.RotateCw },
  autostart: { label: 'Vale ao aplicar (systemd)', icon: I.Zap },
  logrotate: { label: 'Vale ao aplicar o timer', icon: I.Zap },
  watch: { label: 'Vale ao reiniciar o plantão', icon: I.RotateCw },
  next: { label: 'Vale na próxima vez que o comando rodar', icon: I.Clock },
  hooks: { label: 'Vale na hora', icon: I.Zap },
  agents: { label: 'Aplicar nos subagentes', icon: I.Bot },
};
// claude-opus-5-5 → Opus 5.5 (o valor salvo continua o id completo)
const modelLabel = (o) => o.replace(/^claude-([a-z]+)-(\d+)-(\d+)$/, (_, n, a, b) => n[0].toUpperCase() + n.slice(1) + ' ' + a + '.' + b);
// busca sem acento nem maiúscula (Configurações e Qualidade)
const cfgNorm = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ================================================================== paleta de comandos
// comando do manifesto: { group, icon, label } e um destino (action [+ confirm], url local, page ou dialog)
const pluginCommand = ({ run, go, openDialog }) => (c) => {
  if (!c || typeof c.label !== 'string') return null;
  const base = { group: String(c.group || 'Projeto'), icon: I[c.icon] || I.Puzzle, label: c.label };
  if (c.action && typeof c.action === 'object') return { ...base, run: () => run(c.action, c.confirm ? { icon: base.icon, ...c.confirm } : undefined) };
  if (typeof c.url === 'string' && /^https?:\/\//.test(c.url)) return { ...base, run: () => open(c.url, '_blank', 'noopener') };
  if (typeof c.page === 'string' && NAV.some((n) => n.id === c.page)) return { ...base, run: () => go(c.page) };
  if (typeof c.dialog === 'string' && PLUGIN.dialogs[c.dialog]) return { ...base, run: () => openDialog(c.dialog) };
  return null;
};
// ------------------------------------------------------------------ tour por página
/** Digitando num campo: o atalho do tour não rouba a tecla. */
const typingIn = (el) => !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
const startPageTour = (id) => TL.begin(id);
/** Dados de exemplo da página, só enquanto o tour dela roda com prévia; senão null e a página lê os reais. */
function useTourPreview(id) {
  const [, tick] = useState(0);
  useEffect(() => TL.subscribe(() => tick((n) => n + 1)), []);
  return TL.previewOf(id);
}
const ExampleSeal = ({ className }) => <Badge variant="outline" className={className}>Exemplo</Badge>;
// o botão [ ? ] do cabeçalho: um ponto marca o tour que ainda não foi visto nem pulado neste navegador
function PageTourButton({ id, onClick }) {
  const fresh = !TL.readProgress(TL.storage())[id];
  return <Tip text="Tour desta página" side="bottom">
    <Button variant="ghost" size="icon-sm" className="relative" aria-label="Tour desta página" aria-keyshortcuts="Shift+?" icon={I.CircleHelp} onClick={onClick}>
      {fresh ? <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-vivo" aria-hidden="true" /> : null}
    </Button>
  </Tip>;
}
// faixa no topo da página enquanto a prévia está ligada
function PreviewBanner({ page }) {
  const on = useTourPreview(page) !== null;
  if (!on) return null;
  return <div role="status" className="sticky top-12 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-strong bg-accent px-4 py-2 t-body md:px-6 lg:px-8">
    <ExampleSeal />
    <span>
      Dados de exemplo do tour: nada é gravado nem executado.
    </span>
  </div>;
}

function CommandPalette({ open, onClose, d, go, tourId, startTour }) {
  const { openDialog, openLog } = useApp();
  const run = useActions();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef(null);
  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => input.current?.focus(), 20); } }, [open]);
  const items = useMemo(() => {
    const list = [
      ...NAV.map((n) => ({ group: 'Ir para', icon: n.icon, label: n.label, desc: n.desc, run: () => go(n.id) })),
      ...(d ? [
        { group: 'Ambiente', icon: I.Rocket, label: 'Subir Hades (run-hades)', run: () => openDialog('run') },
        { group: 'Ambiente', icon: I.RefreshCw, label: 'Atualizar (update.sh)', run: () => openDialog('update') },
        { group: 'Ambiente', icon: I.Pause, label: 'Pausar o Hades', run: () => run({ action: 'pause', op: 'pause' }, { title: 'Pausar o Hades?', description: 'Para serviços, containers e o resto do ambiente do projeto.', icon: I.Pause, danger: true }) },
        { group: 'Ambiente', icon: I.Play, label: 'Retomar o Hades', run: () => run({ action: 'pause', op: 'resume' }, { title: 'Retomar o Hades?', description: 'Religa infra, serviços e o resto do ambiente do projeto.', icon: I.Play }) },
        ...(PLUGIN.dialogs.data ? [{ group: 'Ambiente', icon: I.DatabaseZap, label: 'Carregar dados', run: () => openDialog('data') }] : []),
        { group: 'Ambiente', icon: I.FileCog, label: 'Gerar STATUS.md', run: () => run({ action: 'status' }) },
        { group: 'Ambiente', icon: I.FileText, label: 'Ver STATUS.md', run: () => openLog('doc:STATUS.md', 'STATUS.md') },
      ] : []),
      ...(d?.services ?? []).flatMap((s) => [
        { group: 'Serviços', icon: I.RotateCw, label: `Reiniciar ${s.name}`, run: () => run({ action: 'svc', op: 'restart', targets: [s.name] }) },
        { group: 'Serviços', icon: I.ScrollText, label: `Log de ${s.name}`, run: () => openLog('svc:' + s.name, s.name) },
      ]),
      ...(tourId ? [{ group: 'Painel', icon: I.CircleHelp, label: 'Tour desta página', desc: 'passo a passo dos cards, com exemplo', run: startTour }] : []),
      ...pluginList('commands').map(pluginCommand({ run, go, openDialog })).filter(Boolean),
    ];
    const terms = cfgNorm(q).split(/\s+/).filter(Boolean);
    return terms.length ? list.filter((i) => { const hay = cfgNorm(`${i.group} ${i.label} ${i.desc ?? ''}`); return terms.every((t) => hay.includes(t)); }) : list;
  }, [d, q, go, openDialog, openLog, run, tourId, startTour]);
  const pick = (i) => { const it = items[i]; if (!it) return; onClose(); setTimeout(it.run, 50); };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(idx); }
  };
  useEffect(() => { document.querySelector(`[data-cmd="${idx}"]`)?.scrollIntoView({ block: 'nearest' }); }, [idx]);
  let lastGroup = null;
  return <Dialog open={open} onClose={onClose} label="Buscar ações" className="gap-0 overflow-hidden p-0 sm:max-w-xl top-[30%] max-md:top-3 max-md:animate-none max-md:[transform:translateX(-50%)]">
    <div className="flex items-center gap-2 border-b px-3">
      <I.Search className="size-4 shrink-0 opacity-50" />
      <input ref={input} value={q} onInput={(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown={key} placeholder="Buscar ação, serviço ou página…" className="flex h-12 w-full bg-transparent py-3 t-body outline-none placeholder:text-muted-foreground" />
    </div>
    <div className="max-h-[360px] overflow-y-auto p-1 scrollbar-thin max-md:max-h-[calc(100dvh-9rem)]" role="listbox">
      {items.length ? items.map((it, i) => { const head = it.group !== lastGroup; lastGroup = it.group; return <Fragment key={i}>
        {head ? <div className="px-2 pt-2 pb-1 t-meta-em text-muted-foreground">
          {it.group}
        </div> : null}
        <button type="button" data-cmd={i} role="option" aria-selected={i === idx} onMouseMove={() => setIdx(i)} onClick={() => pick(i)} className={cn('flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left t-body [&>svg]:size-4 [&>svg]:text-muted-foreground', i === idx && 'bg-accent text-accent-foreground')}>
          <it.icon />
          {it.label}
          {i === idx ? <I.CornerDownLeft className="ml-auto !size-3.5" /> : null}
        </button>
      </Fragment>; })
        : <div className="py-6 text-center t-body text-muted-foreground">Nada encontrado.</div>}
    </div>
    <div className="flex items-center gap-3 border-t px-3 py-2 t-meta text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        {" navegar"}
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd>↵</Kbd>
        {" executar"}
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd>Esc</Kbd>
        {" fechar"}
      </span>
    </div>
  </Dialog>;
}

// ================================================================== app
// um componente com erro não pode apagar o painel inteiro: a página mostra o erro e o resto segue no ar
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error(err, info); }
  render() {
    if (!this.state.err) return this.props.children;
    return <div role="alert" className="grid max-w-2xl justify-items-start gap-3 py-1">
      <p className="flex items-start gap-2 font-medium text-bad">
        <I.CircleX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        Erro nesta página; o resto do painel segue no ar.
      </p>
      <pre className="max-w-full overflow-auto bg-muted px-3 py-2 t-code">
        {String(this.state.err?.stack || this.state.err).split('\n').slice(0, 4).join('\n')}
      </pre>
      <Button size="sm" variant="outline" icon={I.RotateCw} onClick={() => this.setState({ err: null })}>Tentar de novo</Button>
    </div>;
  }
}
// o que está vivo agora, numa lista só: a frase do topo e o fio global leem daqui
const RECENT_CUT_S = 600;
function liveThreads(d) {
  if (!d) return [];
  const gates = d.gates.map((g) => ({ key: 'g' + g.pid + g.label, s: g.state === 'running' ? 'fiando' : 'frouxo', href: '#/queue',
    label: `Gate ${g.label}: ${g.state === 'running' ? 'rodando há ' + dur(g.runningFor) : 'na fila há ' + dur(g.age)}` }));
  const jobs = d.jobs.filter((j) => j.state === 'rodando' || (j.state === 'falhou' && d.t - (j.ended || 0) < RECENT_CUT_S))
    .map((j) => ({ key: 'j' + j.id, s: j.state === 'rodando' ? 'fiando' : 'cortado', href: '#/jobs',
      label: `${j.title}: ${j.state === 'rodando' ? 'rodando há ' + dur(d.t - j.started) : 'falhou'}` }));
  const herdr = d.herdr?.working ? [{ key: 'herdr', s: 'fiando', href: '#/herdr', label: `Herdr: ${d.herdr.working} agente(s) trabalhando` }] : [];
  return [...jobs, ...gates, ...herdr];
}
function StateLine({ d, threads }) {
  const ov = d ? OVERALL[d.overall] || OVERALL.stopped : null;
  if (!ov) return null;
  const n = (s) => threads.filter((t) => t.s === s).length;
  const waiting = d.herdr?.blocked || 0;
  const rest = [n('fiando') ? `${n('fiando')} ${FIO_ESTADO.fiando}` : null, n('cortado') ? `${n('cortado')} ${FIO_ESTADO.cortado}` : null,
    n('frouxo') ? `${n('frouxo')} na fila` : null, waiting ? `${waiting} espera${waiting > 1 ? 'm' : ''} por você` : null].filter(Boolean);
  return <div className="flex min-w-0 items-center gap-2 t-body" role="status">
    <Dot kind={ov.kind} pulse={ov.pulse} />
    <span className="shrink-0 font-medium">
      {ov.label}
    </span>
    <span className="truncate text-muted-foreground max-sm:hidden">
      {'· ' + (rest.length ? rest.join(' · ') : 'nada rodando')}
    </span>
    {/* no celular a frase some; quem espera por você continua, como atalho */}
    {waiting ? <a href="#/herdr?state=blocked" className="inline-flex min-h-11 shrink-0 items-center gap-1.5 px-1 font-medium text-warn outline-none focus-visible:outline-2 focus-visible:outline-ring sm:hidden">
      <I.Hand className="size-4" aria-hidden="true" />
      <span className="tnum">{waiting}</span>
      <span className="sr-only">{` espera${waiting > 1 ? 'm' : ''} por você`}</span>
    </a> : null}
  </div>;
}
// o fio global sob o topo: um segmento por coisa viva; o rótulo diz o quê e o clique leva lá
function FioGlobal({ threads }) {
  if (!threads.length) return <Fio s="parado" label="Nada rodando agora" />;
  return <div className="flex h-[3px] items-center gap-[3px]" role="list" aria-label="O que está rodando agora">
    {threads.map((t) => <a key={t.key} href={t.href} role="listitem" title={t.label} className="flex flex-1 items-center py-1.5 -my-1.5 outline-none focus-visible:outline-2 focus-visible:outline-ring">
      <Fio s={t.s} label={t.label} />
    </a>)}
  </div>;
}
function Loading() {
  return <div className="grid gap-6" aria-busy="true" aria-label="Carregando">
    <Skeleton className="h-5 w-2/3 max-w-xl" />
    <Skeleton className="h-24" />
    <div className="grid gap-6 xl:grid-cols-2">
      <Skeleton className="h-72" />
      <Skeleton className="h-72" />
    </div>
  </div>;
}
function App() {
  const [d, setD] = useState(null);
  const [lastOk, setLastOk] = useState(0);
  const [frozen, setFrozen] = useState(false);
  const [page, setPage] = useState(route());
  const [toasts, setToasts] = useState([]);
  const [conf, setConf] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [logSheet, setLogSheet] = useState(null);
  const [jobSheet, setJobSheet] = useState(null);
  const [selJob, setSelJob] = useState(null);
  const [cmd, setCmd] = useState(false);
  const [nav, setNav] = useState(false);
  const sb = useSidebarState(page);
  const frozenRef = useRef(false);
  frozenRef.current = frozen;

  const refresh = useCallback(async () => {
    if (frozenRef.current) return;
    try { const s = await getJSON('/api/snapshot'); if (s.services) { setD(s); setLastOk(Date.now()); } } catch (e) {}
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => { const f = () => { setPage(route()); window.scrollTo({ top: 0 }); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => {
    const k = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmd((c) => !c); } };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, []);
  useEffect(() => {
    // em página stage o trilho é fixo: Ctrl+B não grava a preferência do dono
    const k = (e) => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && !STAGE[page] && matchMedia('(min-width: 768px)').matches) { e.preventDefault(); sb.toggleMin(); } };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, [sb.toggleMin, page]);
  useEffect(() => { requestAnimationFrame(() => setTimeout(() => document.body.classList.add('ready'), 60)); }, []);
  useEffect(() => { navRef.current = true; }, []);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((all) => [...all.slice(-3), { ...t, id }]);
    setTimeout(() => dismiss(id), t.kind === 'bad' ? 9000 : 6000);
  }, [dismiss]);
  const confirm = useCallback((c) => new Promise((res) => setConf({ ...c, res })), []);
  const go = useCallback((id) => { location.hash = '#/' + id; }, []);
  const openJob = useCallback((id) => { setSelJob(id); setJobSheet(id); }, []);
  const openLog = useCallback((src, title) => setLogSheet({ src, title }), []);
  const openDialog = useCallback((k) => setDialog(k), []);
  const stopJob = useCallback(async (j) => {
    if (!(await confirm({ title: 'Interromper a execução?', description: `${j.title}\n\nO script recebe SIGTERM. Um update.sh ou run-hades interrompido pode deixar serviços parados: rode de novo.`, icon: I.OctagonX, danger: true, confirmLabel: 'Interromper' }))) return;
    try { await post('/api/job/stop', { id: j.id }); toast({ kind: 'warn', title: 'Execução interrompida', desc: j.title }); refresh(); } catch (e) { toast({ kind: 'bad', title: 'Falhou', desc: e.message }); }
  }, [confirm, toast, refresh]);

  // aviso quando uma execução termina
  const prevJobs = useRef({});
  useEffect(() => {
    if (!d) return;
    for (const j of d.jobs) {
      const was = prevJobs.current[j.id];
      if (was === 'rodando' && j.state !== 'rodando')
        toast({ kind: j.state === 'ok' ? 'ok' : j.state === 'falhou' ? 'bad' : 'warn', title: j.state === 'ok' ? 'Concluída' : j.state === 'falhou' ? `Falhou (saída ${j.rc})` : 'Interrompida', desc: j.title,
          action: { label: 'Ver execução', icon: I.SquareTerminal, onClick: () => openJob(j.id) } });
      prevJobs.current[j.id] = j.state;
    }
  }, [d, toast, openJob]);

  const openNav = useCallback(() => setNav(true), []);
  // ações globais para a paleta de uma página stage (grupo "Painel"): congelar, tema e o menu de navegação do celular
  const cur = NAV.find((n) => n.id === page) || NAV[0];
  // tour da página atual: o botão [ ? ], Shift+?, a paleta e o "Ver como funciona" do Empty abrem o mesmo
  const tourId = TL.has(cur.id) ? cur.id : null;
  const startTour = useCallback(() => { if (tourId) startPageTour(tourId); }, [tourId]);
  const ctx = useMemo(() => ({ toast, confirm, openJob, openLog, openDialog, refresh, go, stopJob, frozen, setFrozen, toggleTheme: flipTheme, openNav, tourId, startTour }),
    [toast, confirm, openJob, openLog, openDialog, refresh, go, stopJob, frozen, openNav, tourId, startTour]);
  // Shift+? fora de campo de texto. O ? sozinho do Argos (que a página trata antes, em captura) não chega aqui: ele
  // marca o evento como tratado, e o teclado não distingue ? de Shift+?
  useEffect(() => {
    if (!tourId) return;
    const k = (e) => {
      if (!TL.opensTour(e, { hasTour: true, typing: typingIn(e.target), dialogOpen: !!document.querySelector('[role="dialog"]') })) return;
      e.preventDefault();
      startTour();
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [tourId, startTour]);
  const navRef = useRef(false);
  const navigated = navRef.current;
  const threads = liveThreads(d);
  const running = d ? d.jobs.filter((j) => j.state === 'rodando') : [];
  const sheetJob = d && jobSheet ? d.jobs.find((j) => j.id === jobSheet) : null;
  const Page = PAGES[cur.id];
  const stage = !!STAGE[cur.id];

  const dock = running.length > 0 && !jobSheet;
  return <UI.Provider value={ctx}>
    {/* --dock: altura da pílula da execução no canto; barra presa no rodapé de uma página sobe por cima dela */}
    <div className="flex min-h-screen" style={dock ? { '--dock': '3.5rem' } : undefined}>
      <aside className={cn('sticky top-0 hidden h-screen shrink-0 overflow-hidden bg-sidebar transition-[width] duration-200 ease-out md:block', sb.min || stage ? 'w-16' : 'w-[248px]')}>
        <Sidebar page={cur.id} d={d} rail={sb.min || stage} closed={sb.closed} onToggleGroup={sb.toggleGroup} onToggleMin={stage ? undefined : sb.toggleMin} />
      </aside>
      <Sheet open={nav} onClose={() => setNav(false)} side="left" rail>
        <Sidebar page={cur.id} d={d} closed={sb.closed} onToggleGroup={sb.toggleGroup} onNavigate={() => setNav(false)} />
      </Sheet>
      {stage ? <div className="stage-frame relative flex h-dvh min-w-0 flex-1 flex-col overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 *:pointer-events-auto"><FioGlobal threads={threads} /></div>
        <main className="relative flex min-h-0 flex-1 flex-col">
          <h1 className="sr-only">{cur.label}</h1>
          <Boundary>
            {d ? <Page d={d} go={go} sel={selJob} setSel={setSelJob} /> : <Skeleton className="absolute inset-0" />}
          </Boundary>
          <StageNotice lastOk={lastOk} frozen={frozen} />
        </main>
      </div> : <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 bg-background/90 backdrop-blur-sm">
          <div className="flex h-12 items-center gap-3 px-4 md:px-6 lg:px-8">
            <Button variant="ghost" size="icon-sm" className="-ml-2 md:hidden" aria-label="Abrir a navegação" icon={I.Menu} onClick={() => setNav(true)} />
            <span className="marca size-6 shrink-0 bg-foreground! md:hidden" aria-hidden="true" />
            <StateLine d={d} threads={threads} />
            <div className="ml-auto flex items-center gap-2">
              <LiveIndicator lastOk={lastOk} frozen={frozen} />
              <button type="button" onClick={() => setCmd(true)} className="hidden h-8 w-60 cursor-pointer items-center gap-2 border border-border-strong px-2.5 t-label text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:flex">
                <I.Search className="size-3.5" />
                Buscar ou ir para…
                <span className="ml-auto">
                  <Kbd>Ctrl K</Kbd>
                </span>
              </button>
              <Button variant="ghost" size="icon-sm" className="lg:hidden" aria-label="Buscar ações" icon={I.Search} onClick={() => setCmd(true)} />
              <Tip text={frozen ? 'Voltar a atualizar' : 'Congelar a tela'} side="bottom">
                <Button variant="ghost" size="icon-sm" aria-label={frozen ? 'Voltar a atualizar' : 'Congelar a atualização ao vivo'} icon={frozen ? I.Play : I.Snowflake} onClick={() => setFrozen(!frozen)} />
              </Tip>
              <ThemeToggle />
            </div>
          </div>
          <FioGlobal threads={threads} />
        </header>
        <PreviewBanner page={cur.id} />
        <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 pt-7 pb-24 md:px-6 lg:px-8">
          <FadeSlot className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-2" key={'h' + cur.id} live={navigated} data-tour-step-id={'tour-' + cur.id}>
            <div className="min-w-0 max-w-[70ch]">
              <h1 className="t-page-title">
                {cur.label}
              </h1>
              <p className="mt-2 t-body text-muted-foreground">
                {cur.desc}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {tourId ? <PageTourButton id={tourId} onClick={startTour} /> : null}
              {d ? <div className="flex items-center gap-1.5 t-meta text-muted-foreground">
                <I.GitBranch className="size-3.5" aria-hidden="true" />
                <Mono>
                  {d.branch?.name}
                  {" @ "}
                  {(d.branch?.sha || '').slice(0, 8)}
                </Mono>
              </div> : null}
            </div>
          </FadeSlot>
          <FadeSlot key={cur.id} live={navigated}>
            <Boundary>
              {d ? <Page d={d} go={go} sel={selJob} setSel={setSelJob} /> : <Loading />}
            </Boundary>
          </FadeSlot>
        </main>
      </div>}
    </div>
    {dock ? <button type="button" onClick={() => openJob(running[0].id)} className="fixed inset-x-4 bottom-4 z-40 flex items-center gap-3 md:inset-x-auto md:right-6 border border-border-strong bg-popover py-1.5 pr-1.5 pl-3 t-body shadow-lg animate-toast-in cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <Dot kind="busy" pulse />
      <span className="min-w-0 flex-1 truncate text-left font-medium md:max-w-[32ch]">
        {running[0].title}
      </span>
      <span className="t-data whitespace-nowrap text-muted-foreground">
        {dur(d.t - running[0].started)}
      </span>
      <span className="bg-primary px-2.5 py-1 t-meta-em text-primary-foreground">Ver</span>
    </button> : null}
    <Sheet open={!!jobSheet} onClose={() => setJobSheet(null)} wide icon={I.SquareTerminal} title={sheetJob?.title || 'Execução'} description={sheetJob ? `${(JOB_ST[sheetJob.state] || JOB_ST.interrompido).label} · ${dur((sheetJob.ended || d.t) - sheetJob.started)}` : ''} actions={sheetJob?.state === 'rodando' ? <Button size="sm" variant="ghost-destructive" icon={I.OctagonX} onClick={() => stopJob(sheetJob)}>Interromper</Button> : null}>
      <div className="flex h-full p-4">
        <Terminal jobId={jobSheet} running={sheetJob?.state === 'rodando'} className="flex-1" />
      </div>
    </Sheet>
    <Sheet open={!!logSheet} onClose={() => setLogSheet(null)} wide icon={I.ScrollText} title={logSheet?.title} description={logSheet?.src}>
      <div className="flex h-full p-4">
        {logSheet ? <LogViewer src={logSheet.src} title="" className="flex-1" /> : null}
      </div>
    </Sheet>
    {window.HadesTour ? <window.HadesTour.Gate page={cur.id} go={go} /> : null}
    {window.HadesTour ? <window.HadesTour.PageTour page={cur.id} go={go} /> : null}
    <Dialog open={!!conf} onClose={() => { conf?.res(false); setConf(null); }} label={conf?.title}>
      {conf ? <>
        <DialogHeader icon={conf.icon} tone={conf.danger ? 'danger' : null} title={conf.title} description={conf.description} />
        <DialogFooter>
          <Button variant="outline" onClick={() => { conf.res(false); setConf(null); }}>Cancelar</Button>
          {conf.danger
            ? <HoldConfirm icon={conf.icon} size="default" onHold={() => { conf.res(true); setConf(null); }}>{'Segure 1,2 s: ' + (conf.confirmLabel || 'Executar')}</HoldConfirm>
            : <Button variant="default" icon={conf.icon} onClick={() => { conf.res(true); setConf(null); }}>
              {conf.confirmLabel || 'Executar'}
            </Button>}
        </DialogFooter>
      </> : null}
    </Dialog>
    <RunHadesDialog d={d} open={dialog === 'run'} onClose={() => setDialog(null)} />
    <UpdateDialog open={dialog === 'update'} onClose={() => setDialog(null)} />
    {Object.entries(PLUGIN.dialogs).map(([k, D]) => <Boundary key={k}>
      <D d={d} open={dialog === k} onClose={() => setDialog(null)} />
    </Boundary>)}
    <CommandPalette open={cmd} onClose={() => setCmd(false)} d={d} go={go} tourId={tourId} startTour={startTour} />
    <Toaster toasts={toasts} dismiss={dismiss} />
  </UI.Provider>;
}

// ================================================================== plugin do projeto
// API que os scripts das páginas do plugin usam (window.HadesPanel): as mesmas primitivas e ganchos das páginas do núcleo
window.HadesPanel = {
  React, html, I, cn, gb, mb, dur, pct, dt, hhmm, post, getJSON, CARD_SCROLL,
  Button, Badge, Card, CardHeader, CardContent, Table, Th, Td, Tr, Menu, Tip, Empty, Input, Progress, StateBadge, Switch, Mono,
  CopyButton, Dot, Field, Dialog, DialogHeader, DialogFooter, Kpi, QuickAction, Svc, TunnelCard, svcState, unitState, useApp, useActions,
  Fio, Regua, Leitura, LinhaDeEstado, Num, Tracos, Select,
  registerPage(id, Comp, opts = {}) {
    if (typeof id !== 'string' || typeof Comp !== 'function') throw new TypeError('registerPage(id, Componente)');
    // plugin que troca uma página do núcleo sem trazer o tour dela: o tour do núcleo apontaria para cards que não existem
    if (PAGES[id] && !opts.tour) TL.drop(id);
    PAGES[id] = Comp;
    if (opts.tour) {
      try { TL.register(id, opts.tour); } catch (e) { console.warn(`tour: ${id} sem tour`, e); }
    }
    if (typeof opts.badge === 'function') PLUGIN.badges[id] = opts.badge;
    if (opts.stage === true) STAGE[id] = true; else delete STAGE[id];
  },
  registerDialog(id, Comp) {
    if (typeof id !== 'string' || typeof Comp !== 'function' || id === 'run' || id === 'update') throw new TypeError('registerDialog(id, Componente)');
    PLUGIN.dialogs[id] = Comp;
  },
};
const PLUGIN_SCRIPT = /^[\w-]+\.js$/;
const PLUGIN_SCRIPT_TIMEOUT = 10000;
// um script por vez, na ordem do manifesto; erro ou demora num deles não impede os outros nem o painel do núcleo
const loadScript = (name) => new Promise((resolve) => {
  const el = document.createElement('script');
  const t = setTimeout(() => { console.warn(`plugin: ${name} não carregou em ${PLUGIN_SCRIPT_TIMEOUT / 1000} s`); resolve(false); }, PLUGIN_SCRIPT_TIMEOUT);
  el.src = '/plugin/ui/' + name;
  el.onload = () => { clearTimeout(t); resolve(true); };
  el.onerror = () => { clearTimeout(t); console.warn(`plugin: ${name} não carregou`); resolve(false); };
  document.body.appendChild(el);
});
async function loadPlugin() {
  try {
    const m = await getJSON('/api/plugin');
    PLUGIN.manifest = m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch (e) { console.warn('plugin: /api/plugin falhou; painel só com o núcleo', e); return; }
  // scripts das páginas e os avulsos (scripts: diálogos e afins), cada um uma vez, na ordem do manifesto
  for (const name of new Set([...pluginList('pages').map((p) => p?.script), ...pluginList('scripts')].filter((x) => typeof x === 'string'))) {
    if (PLUGIN_SCRIPT.test(name)) await loadScript(name); else console.warn(`plugin: script recusado: ${name}`);
  }
  const groups = PLUGIN.manifest.configGroups, applies = PLUGIN.manifest.applies;
  if (groups && typeof groups === 'object') for (const [g, icon] of Object.entries(groups)) CFG_ICON[g] ??= I[icon] || I.Puzzle;
  if (applies && typeof applies === 'object') for (const [k, a] of Object.entries(applies)) {
    if (CFG_APPLY[k] || !a || typeof a !== 'object') continue;
    CFG_APPLY[k] = { label: String(a.label || k), icon: I[a.icon] || I.RotateCw, button: a.button, action: a.action && typeof a.action === 'object' ? a.action : null };
  }
  ({ nav: NAV, groups: NAV_GROUPS } = pluginNav(pluginList('pages'), PAGES));
}

// o que as páginas do núcleo (ui/pages/*.js) usam da base; NAV é getter porque o loadPlugin a reatribui
window.HadesCore = { useState, useEffect, useRef, useMemo, useCallback, useId, I, cn, PLUGIN, pluginList, GB, MB,
  gb, mb, dur, dt, pct, post, getJSON, Button, HoldConfirm, useConfirmPrefs, Badge, Dot, CARD_SCROLL, Card, CardHeader, CardContent, Switch, Field,
  Input, Progress, Skeleton, Kbd, Mono, Tip, CopyButton, Empty, Table, Th, Td, Tr, Menu, Dialog, DialogHeader, DialogFooter,
  Sheet, useWidth, AreaChart, niceTicks, niceTicksCovering, Legend, OVERALL, svcState, StateBadge, useApp, route, useActions, Kpi, QuickAction,
  JOB_ST, JobRow, jobFio, ago, Segmented, Choice, Select, useWide, Checkbox, PrPicker, Terminal, LogViewer, slugify, renderMd, CFG_ICON, CFG_APPLY,
  modelLabel, cfgNorm, Loading, Fio, FIO_ESTADO, Regua, Leitura, LinhaDeEstado, Num, Tracos, liveThreads, get NAV() { return NAV; },
  registerPage: window.HadesPanel.registerPage,
  registerTour: (id, def) => TL.register(id, def), hasTour: (id) => TL.has(id), startPageTour, useTourPreview, ExampleSeal, TL };

// os scripts das páginas vêm depois deste no index.html: o DOMContentLoaded só dispara quando todos rodaram
const start = () => loadPlugin().catch((e) => console.error('plugin: páginas do plugin não montaram; painel só com o núcleo', e)).finally(() => ReactDOM.createRoot(document.getElementById('root')).render(<App />));
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
