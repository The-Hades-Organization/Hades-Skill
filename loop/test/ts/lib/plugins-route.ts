// Página Plugins no painel, sem rede: painel real em processo numa porta livre de 127.0.0.1; imprime `<caso> <status> <code>` por
// pedido. O lançamento do job (systemd-run) é trocado por um registro: um `systemd-run` de mentira no PATH que não executa nada,
// e o comando que iria para a unit sai do `.json` do job (`cmd`). Usado por plugins-painel.test.ts.
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { Rig } from "./rig";
import { JSON_CT, Lines, PUB, fetchRaw, remoteHeaders, startTestPanel } from "./widget-rig";

export async function pluginsRoute(r: Rig, D: string, url: string, name: string, env: Record<string, string> = {}): Promise<string> {
  const o = new Lines();
  const bin = `${r.T}/plugins-route-bin`;
  mkdirSync(bin, { recursive: true });
  writeFileSync(`${bin}/systemd-run`, "#!/bin/sh\nexit 0\n");
  chmodSync(`${bin}/systemd-run`, 0o755);
  const saved = Object.fromEntries(["PATH", ...Object.keys(env)].map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  writeFileSync(`${D}/panel-tunnel.url`, `https://${PUB}\n`);
  const P = await startTestPanel(D);
  try {
    const { base } = P;
    const token = { ...JSON_CT, "X-Panel-Token": P.token };
    const remote = remoteHeaders(D);
    const ask = async (label: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
      const rep = await fetchRaw(base, path, headers, body);
      o.print(label, rep.status, rep.json?.code || rep.json?.error || (rep.json?.ok ? "ok" : "-"));
      return rep;
    };
    const post = (label: string, headers: Record<string, string>, body: unknown) => ask(label, "/api/plugins", headers, body);
    await ask("lista-local", "/api/plugins").then((x) => o.print("lista-local-remote", String(Boolean(x.json?.remote))));
    await ask("lista-remota", "/api/plugins", remote).then((x) => o.print("lista-remota-remote", String(Boolean(x.json?.remote))));
    await post("remoto-desligar", { ...remote, ...token }, { op: "disable", name });
    await post("remoto-previa", { ...remote, ...token }, { op: "preview-add", url });
    await post("sem-token", JSON_CT, { op: "disable", name });
    await post("op-desconhecida", token, { op: "apagar-tudo" });
    await post("nome-invalido", token, { op: "disable", name: "../x" });
    await post("sha-invalido", token, { op: "add", id: "0".repeat(16), commit: "HEAD" });
    await post("url-credencial", token, { op: "preview-add", url: "https://u:t@plugins.example.invalid/x/y.git" });
    await post("url-longa", token, { op: "preview-add", url: `https://h/${"a".repeat(400)}` });
    await post("previa-expirada", token, { op: "add", id: "0".repeat(16), commit: "0".repeat(40) });
    await post("remover-nome-errado", token, { op: "remove", name, confirm: "outro" });
    await post("previa-local", token, { op: "preview-add", url });
    await post("desligar-local", token, { op: "disable", name });
  } finally {
    P.stop();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const dir = `${D}/logs/panel-jobs`;
  const jobs = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { cmd: string; started: number }).sort((a, b) => a.started - b.started);
  o.print("job-desligar", jobs.length ? (jobs[jobs.length - 1] as { cmd: string }).cmd.split(/\s+/).slice(-2).join(" ") : "-");
  o.print("lancados", jobs.length);
  return o.out;
}
