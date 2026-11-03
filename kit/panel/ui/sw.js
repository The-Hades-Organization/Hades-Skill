// Service worker do painel: só a casca estática (/ui/*), rede primeiro e cache de reserva.
// Nunca guarda /api/*, nem "/" (o index.html leva o token da sessão), nem resposta que não seja 200.
// __UI_HASH__ é trocado por src/panel/server.ts (uiHash) por um hash dos arquivos da UI: arquivo novo = cache novo, sozinho.
const VERSION = '__UI_HASH__';
const CACHE = 'hades-shell-' + VERSION;
const OFFLINE = '/ui/offline.html';
const SHELL = [OFFLINE, '/ui/manifest.webmanifest', '/ui/brand/icon-192.png', '/ui/brand/hades.svg', '/ui/brand/favicon-32.png'];

self.addEventListener('install', (e) => {
  // addAll é tudo-ou-nada; um item fora do ar não pode impedir a instalação
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('hades-shell-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // a página em si (com token) nunca vai ao cache; sem rede, só o aviso
    e.respondWith(fetch(req).catch(() => caches.match(OFFLINE).then((r) => r || new Response('Sem conexão com o Hades', { status: 503 }))));
    return;
  }
  if (!url.pathname.startsWith('/ui/')) return; // /api/*, /auth etc. passam direto, sem cache
  e.respondWith(fetch(req).then((res) => {
    if (res.status === 200 && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || Response.error())));
});
