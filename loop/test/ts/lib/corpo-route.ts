// Rotas do Cerberus no painel, sem rede: sobe o painel da skill indicada (a cópia do teste) em processo, numa porta livre de
// 127.0.0.1, e imprime `<caso> <status> <erro|->` por pedido. Usado por corpo.test.ts, que roda este arquivo com o Bun:
//
//   bun corpo-route.ts <skill> <$D>      (<$D>/panel/remote.key já criada)
import { readFileSync, writeFileSync } from "node:fs";

const [skill, D] = [process.argv[2] as string, process.argv[3] as string];
const { startPanel } = (await import(`${skill}/src/panel/server.ts`)) as { startPanel(dir: string, port: number): Promise<{ port: number; token: string; stop(): void }> };
const { panelEnv } = (await import(`${skill}/src/panel/env.ts`)) as { panelEnv(dir: string): { cookie: string } };
const { createAuth } = (await import(`${skill}/src/panel/auth.ts`)) as { createAuth(env: unknown): { sessionValue(k: string): string } };

const free = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
const port = free.port as number;
free.stop(true);
const panel = await startPanel(D, port);
const base = `http://127.0.0.1:${panel.port}`;
const pub = "painel.example.invalid";
writeFileSync(`${D}/panel-tunnel.url`, `https://${pub}\n`);
const key = readFileSync(`${D}/panel/remote.key`, "utf8").trim();
const env = panelEnv(D);
const remote = { Host: pub, "X-Forwarded-Host": pub, "X-Forwarded-Proto": "https", Cookie: `${env.cookie}=${createAuth(env).sessionValue(key)}` };
const token = { "X-Panel-Token": panel.token, "Content-Type": "application/json" };
const exc = { action: "excecao", cabeca: "porta", guarda: "upstream-push", momento: "push", alvo: { pr: "7" }, motivo: "liberado pelo dono no teste do painel" };

type Dict = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function ask(caso: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Dict | null> {
  const res = await fetch(base + path, { method: body !== undefined ? "POST" : "GET", headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let out: Dict | null = null;
  try { out = JSON.parse(await res.text()) as Dict; } catch { out = null; }
  console.log(caso, res.status, out && typeof out === "object" && out.error ? out.error : "-");
  return out;
}

let st = (await ask("local-get", "/api/cerberus")) as Dict;
console.log("estado", (st.cabecas as Dict[]).map((c) => `${c.id}:${c.modo}`).join(","), st.remote ? "remote" : "local");
st = (await ask("remoto-get", "/api/cerberus", remote)) as Dict;
console.log("estado-remoto", st.remote ? "remote" : "local");
await ask("remoto-excecao", "/api/cerberus", { ...remote, ...token }, exc);
await ask("remoto-modo", "/api/config", { ...remote, ...token }, { values: { HADES_CERBERUS_PORTA: "off" } });
await ask("local-sem-token", "/api/cerberus", { "Content-Type": "application/json" }, exc);
await ask("local-motivo-curto", "/api/cerberus", token, { ...exc, motivo: "curto" });
const out = await ask("local-excecao", "/api/cerberus", token, exc);
const e = (out?.excecao ?? {}) as Dict;
const sorted = (v: unknown): string => (v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}: ${JSON.stringify((v as Dict)[k])}`).join(", ")}}` : JSON.stringify(v ?? null));
console.log("excecao", e.origem, e.cabeca, e.guarda, sorted(e.alvo));
panel.stop();
process.exit(0);
