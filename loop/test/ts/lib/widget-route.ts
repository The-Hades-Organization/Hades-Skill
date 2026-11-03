// Widget Android no painel, sem rede: painel real em processo numa porta livre de 127.0.0.1 (rotas, escopo, acesso remoto, listener
// do widget) e o widget em processo com relógio e orquestração fixos (contrato do payload, bloqueio por IP). Imprime
// `<caso> <status> <código ou valor>` por pedido; o grupo widget-api lê com `caso()`.
import { readFileSync, statSync } from "node:fs";
import { widgetPayload } from "../../../../src/panel/widget.ts";
import type { Rig } from "./rig";
import { type Dict, JSON_CT, Lines, NOW, STAMP, bearer, directWidget, freePort, remoteHeaders, startTestPanel, stubCollector, widgetData } from "./widget-rig";

const agent = (name: string, live: string | null, state = "working", questions: string[] = [], extra: Dict = {}): Dict =>
  ({ name, role: "impl", state, live, openQuestions: questions, ...extra });

export const SNAPSHOT: Dict = {
  available: true,
  agents: [
    agent("trab", "working", "working", [], { promptedAt: STAMP, createdAt: "2026-10-26T05:00:00Z" }),
    agent("ocioso", "idle", "working", [], { createdAt: "2026-10-26T05:30:00Z" }),
    agent("fora", "fora", "allocated"),
    agent("pergunta", "idle", "working", ["Q1 — algo"], { promptedAt: STAMP }),
    agent("bloq", "blocked"),
    agent("feito", null, "done", [], { doneAt: "2026-10-26T06:10:00Z", createdAt: "2026-10-26T04:00:00Z" }),
  ],
};

export async function widgetApiRoute(r: Rig, tag: string): Promise<string> {
  const { D, listenerPort } = widgetData(r, tag);
  const collector = stubCollector(r);
  const o = new Lines();
  const P = await startTestPanel(D);
  let clock = NOW;
  const directPort = freePort();
  const dw = directWidget(D, { now: () => clock, orchestration: async () => SNAPSHOT, config: () => ({ HADES_WIDGET_EVENTS: "8", HADES_WIDGET_PORT: String(directPort) }) });
  const direct = async (headers: Record<string, string>, ip = "127.0.0.1") => dw.handle(new Request("http://127.0.0.1/api/widget", { headers }), ip);
  const listenerStop = dw.serve();
  try {
    const { base } = P;
    const token = { ...JSON_CT, "X-Panel-Token": P.token };
    const remote = remoteHeaders(D);
    const ask = (label: string, path: string, headers: Record<string, string> = {}, body?: unknown, method?: string, b = base) => o.ask(b, label, path, headers, body, method);

    await ask("sem-token-configurado", "/api/widget", bearer("qualquer"));
    await ask("criar-pelo-remoto", "/api/widget/token", { ...remote, ...token }, { op: "create" });
    o.print("criar-pelo-remoto-gravou", Number(dw.status().configured));
    await ask("criar-sem-token-do-painel", "/api/widget/token", JSON_CT, { op: "create" });
    await ask("op-invalida", "/api/widget/token", token, { op: "apagar-tudo" });
    const created = await ask("criar", "/api/widget/token", token, { op: "create" });
    const tok = String(created.json?.token);
    const tokenFile = `${D}/panel/widget-token.json`;
    o.print("arquivo-modo", (statSync(tokenFile).mode & 0o777).toString(8), "sem-token-em-claro", Number(!readFileSync(tokenFile, "utf8").includes(tok)));
    await ask("status", "/api/widget/token");
    const st = dw.status();
    o.print("status-configurado", Number(st.configured), "sem-o-token", Number(!("token" in st)));

    await ask("certo", "/api/widget", bearer(tok));
    const out = (await (await direct(bearer(tok))).json()) as Dict;
    const agents = out.agents as Dict[];
    const events = out.events as Dict[];
    o.print("formato", out.version, out.updatedAt, pyDumpCounts(out.counts as Dict));
    o.print("agentes", agents.map((a) => `${a.name}:${a.state}`).join(" "));
    o.print("idade-trab", agents.find((a) => a.name === "trab")?.ageSeconds);
    o.print("campos-agente", Object.keys(agents[0] as Dict).sort().join(","));
    o.print("eventos", events.slice(0, 3).map((e) => `${e.type}:${e.agent}`).join(" "), events.length);
    o.print("teto", (widgetPayload(SNAPSHOT, NOW, 2).events as unknown[]).length);
    const { Cookie: _c, ...semCookie } = remote;
    await ask("certo-pelo-remoto-sem-cookie", "/api/widget", { ...bearer(tok), ...semCookie });
    await ask("errado", "/api/widget", bearer(`${tok}x`));
    await ask("ausente", "/api/widget");
    await ask("na-query", `/api/widget?token=${tok}`);
    await ask("cookie-nao-vale", "/api/widget", { Cookie: remote.Cookie as string });
    for (const [label, path] of [["outra-rota-snapshot", "/api/snapshot"], ["outra-rota-remote", "/api/remote"], ["outra-rota-token-do-painel", "/api/token"], ["outra-rota-orchestration", "/api/orchestration"]] as const) {
      await ask(label, path, bearer(tok));
    }
    await ask("outra-rota-remoto", "/api/snapshot", { ...remote, ...bearer(tok) });
    await ask("post-em-outra-rota", "/api/action", { ...token, ...bearer(tok) }, { action: "x" });
    await ask("post-no-widget", "/api/widget", { ...token, ...bearer(tok) }, {});
    await ask("revogar-pelo-remoto", "/api/widget/token", { ...remote, ...token }, { op: "revoke" });
    await ask("ainda-vale", "/api/widget", bearer(tok));
    await ask("revogar", "/api/widget/token", token, { op: "revoke" });
    await ask("revogado", "/api/widget", bearer(tok));
    const again = await ask("gerar-de-novo", "/api/widget/token", token, { op: "create" });
    const tok2 = String(again.json?.token);
    await ask("token-antigo-nao-volta", "/api/widget", bearer(tok));
    await ask("token-novo", "/api/widget", bearer(tok2));
    for (let i = 0; i < 8; i++) await ask("rajada", "/api/widget", bearer("errado"));
    await ask("bloqueado", "/api/widget", bearer(tok2));
    // o valor do Retry-After sai do widget com o relógio fixo (no painel o relógio é o real e o valor oscila em 1 s)
    for (let i = 0; i < 8; i++) await direct(bearer("errado"), "192.0.2.1");
    const blocked = await direct(bearer(tok2), "192.0.2.1");
    o.print("retry-after", blocked.headers.get("Retry-After"));

    // listener do widget (túnel anônimo, no painel): só GET /api/widget
    const wbase = `http://127.0.0.1:${listenerPort}`;
    const ip = (a: string) => ({ "X-Forwarded-For": a });
    const good = bearer(tok2);
    await ask("listener-token-certo", "/api/widget", { ...good, ...ip("203.0.113.9") }, undefined, undefined, wbase);
    await ask("listener-outro-caminho", "/api/snapshot", { ...good, ...ip("203.0.113.9") }, undefined, undefined, wbase);
    await ask("listener-raiz", "/", ip("203.0.113.9"), undefined, undefined, wbase);
    await ask("listener-post", "/api/widget", { ...good, ...ip("203.0.113.9") }, {}, undefined, wbase);
    await ask("listener-sem-token", "/api/widget", ip("203.0.113.9"), undefined, undefined, wbase);

    // bloqueio por IP (X-Forwarded-For) no listener do widget com relógio fixo
    const dbase = `http://127.0.0.1:${directPort}`;
    for (let i = 0; i < 8; i++) await ask("rajada-ip", "/api/widget", { ...bearer("errado"), ...ip("198.51.100.7") }, undefined, undefined, dbase);
    const blockedIp = await ask("ip-bloqueado", "/api/widget", { ...good, ...ip("198.51.100.7") }, undefined, undefined, dbase);
    o.print("ip-retry-after", blockedIp.hdr.get("Retry-After"));
    // forjar o primeiro valor não escapa quando o último (o da borda) já está bloqueado, e vice-versa
    await ask("forja-primeiro", "/api/widget", { ...good, "X-Forwarded-For": "192.0.2.77, 198.51.100.7" }, undefined, undefined, dbase);
    await ask("forja-ultimo", "/api/widget", { ...good, "X-Forwarded-For": "198.51.100.7, 192.0.2.78" }, undefined, undefined, dbase);
    await ask("primeiro-e-ultimo-livres", "/api/widget", { ...good, "X-Forwarded-For": "192.0.2.79, 192.0.2.80" }, undefined, undefined, dbase);
    await ask("outro-ip-segue", "/api/widget", { ...good, ...ip("192.0.2.50") }, undefined, undefined, dbase);
    await ask("painel-mesmo-ip-bloqueado", "/api/widget", good);

    // tabela de IPs: por efeito observável. Mais de 1024 IPs falhando tira o mais antigo (o 198.51.100.7, bloqueado acima) da tabela...
    for (let n = 0; n < 2000; n++) await direct(bearer("errado"), `10.${n >> 8}.${n & 255}.1`);
    const freed = await direct(good, "198.51.100.7");
    o.print("tabela-de-ips-limitada", Number(freed.status === 200));
    // ...e as falhas saem da janela de 10 min: um IP bloqueado volta a passar depois dela
    for (let i = 0; i < 8; i++) await direct(bearer("errado"), "203.0.113.200");
    const wasBlocked = (await direct(good, "203.0.113.200")).status === 429;
    clock = NOW + 601;
    const expired = (await direct(good, "203.0.113.200")).status === 200;
    o.print("tabela-expira-velhas", Number(wasBlocked && expired));
    clock = NOW;

    const log = readFileSync(`${D}/logs/panel-widget.log`, "utf8");
    o.print("auditoria", [...new Set(log.split(/\s+/).filter((w) => w.startsWith("acao=")).map((w) => w.split("=")[1]))].sort().join(" "), Number(log.includes(tok2)));
  } finally {
    listenerStop?.stop();
    P.stop();
    collector.restore();
  }
  return o.out;
}

const pyDumpCounts = (c: Dict): string => `{${Object.keys(c).sort().map((k) => `"${k}": ${c[k]}`).join(", ")}}`;
