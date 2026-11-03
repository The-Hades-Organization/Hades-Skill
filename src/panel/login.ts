// Página de entrada do acesso remoto (a chave do túnel).
/** O ícone do painel (o mesmo do favicon); o servidor o serve sem a chave, só este arquivo, porque a página vem antes da autenticação. */
export const LOGIN_ICON = "/ui/brand/hades.svg";
const LOGIN_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hades · acesso remoto</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#0a0a0a;--mut:#737373;--bd:#e5e5e5;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#fafafa;--mut:#a3a3a3;--bd:#262626;--card:#171717}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:16px}
.c{width:100%;max-width:380px;background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.08);animation:u .35s cubic-bezier(.16,1,.3,1)}
@keyframes u{from{opacity:0;transform:translateY(8px)}}
.l{display:block;width:48px;height:48px;border-radius:12px;margin-bottom:16px}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 18px;color:var(--mut);font-size:14px}
input{width:100%;height:40px;border:1px solid var(--bd);border-radius:8px;background:transparent;color:var(--fg);padding:0 12px;font:inherit;font-family:ui-monospace,monospace}
input:focus{outline:3px solid rgba(14,165,233,.35);border-color:#0ea5e9}
button{margin-top:12px;width:100%;height:40px;border:0;border-radius:8px;background:var(--fg);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}
.e{margin-top:12px;color:#dc2626;font-size:13px}</style></head><body><form class="c" method="post" action="/auth">
<img class="l" src="${LOGIN_ICON}" alt="Hades" width="48" height="48">
<h1>Hades</h1><p>Acesso remoto ao painel. Cole a chave de acesso, que aparece no painel local em <b>Acesso remoto</b>.</p>
<input name="key" type="password" autocomplete="current-password" placeholder="chave de acesso" autofocus required>
<button type="submit">Entrar</button>__MSG__</form></body></html>`;

export const loginPage = (message = ""): string => LOGIN_PAGE.replace("__MSG__", message ? `<div class="e">${message}</div>` : "");
