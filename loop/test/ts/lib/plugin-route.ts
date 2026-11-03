// Rotas do plugin no painel, sem rede: painel real em processo numa porta livre de 127.0.0.1 e `<caso> <status> <code>` por pedido.
// Usado por plugin-contrato.test.ts (`pluginRoute(D)` devolve as linhas; `caso()` de route.ts as lê).
import { writeFileSync } from "node:fs";
import { JSON_CT, Lines, PUB, remoteHeaders, startTestPanel } from "./widget-rig";

export async function pluginRoute(D: string): Promise<string> {
  const o = new Lines();
  writeFileSync(`${D}/panel-tunnel.url`, `https://${PUB}\n`);
  const P = await startTestPanel(D);
  try {
    const { base } = P;
    const remote = remoteHeaders(D);
    const { Cookie, ...semChave } = remote;
    const token = { ...JSON_CT, "X-Panel-Token": P.token };
    const ask = (label: string, path: string, headers: Record<string, string> = {}, body?: unknown) => o.ask(base, label, path, headers, body);
    await ask("local-get", "/api/plugin/eco");
    await ask("manifesto", "/api/plugin");
    await ask("remoto-sem-chave", "/api/plugin/eco", semChave);
    await ask("remoto-cookie-errado", "/api/plugin/eco", { ...semChave, Cookie: `${(Cookie ?? "").split("=")[0]}=x` });
    await ask("remoto-com-chave", "/api/plugin/eco", remote);
    await ask("remoto-rota-local", "/api/plugin/so-local", remote);
    await ask("script-remoto-sem-chave", "/plugin/ui/pagina.js", semChave);
    await ask("post-sem-token", "/api/plugin/eco", JSON_CT, {});
    await ask("post-com-token", "/api/plugin/eco", token, {});
    await ask("rota-desconhecida", "/api/plugin/nada");
    await ask("erro-no-plugin", "/api/plugin/quebra");
    await ask("script-fora-da-pasta", "/plugin/ui/..%2F..%2Fapi.ts");
  } finally {
    P.stop();
  }
  return o.out;
}

/** `GET /api/plugin` (manifesto público): ids das páginas e `METODO:caminho` das rotas, como o teste compara. */
export async function pluginManifest(D: string): Promise<string> {
  const P = await startTestPanel(D);
  try {
    const m = (await (await fetch(`${P.base}/api/plugin`)).json()) as { pages: { id: string }[]; routes: { method: string; path: string }[] };
    return `${m.pages.map((p) => p.id).join(",")} ${m.routes.map((r) => `${r.method}:${r.path}`).join(",")}`;
  } finally {
    P.stop();
  }
}
