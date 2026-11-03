// Seções `system` e `prs` do GET /api/widget, sem rede nem gh: o widget em processo com orquestração, fila e amostrador fixos, o
// relógio controlado e o coletor de PRs (`bun src/cli.ts pr-loop-state --json`) trocado por um dublê que conta as chamadas.
// Imprime `<caso> <valor>` por verificação. O grupo widget-sistema-prs lê com `caso()`.
import { basename } from "node:path";
import { createPrsCache, prsSection } from "../../../../src/panel/widget.ts";
import type { Rig } from "./rig";
import { type Dict, GIB, JSON_CT, Lines, NOW, bearer, directWidget, fetchRaw, py, pyDump, startTestPanel, stubCollector, until, widgetData } from "./widget-rig";

const ORCH: Dict = { available: true, agents: [{ name: "a", role: "impl", state: "working", live: "working", openQuestions: [], createdAt: "2026-10-26T05:00:00Z" }] };
const GATES: Dict = {
  available: true, host: { memTotal: 32 * GIB, memAvailable: 20 * GIB },
  gates: [{ state: "waiting", label: "b", age: 5, rss: 0 }, { state: "running", label: "build-api", age: 240.7, rss: Math.trunc(1.2 * GIB) }, { state: "waiting", label: "c", age: 3, rss: 0 }],
};
const SAMPLER: Dict = {
  services: [
    { name: "api", enabled: true, required: true, state: "active", ready: true }, { name: "billing", enabled: true, required: false, state: "active", ready: false },
    { name: "worker", enabled: true, required: false, state: "inactive", ready: false }, { name: "off", enabled: false, required: false, state: "inactive", ready: false },
  ],
  containers: [{ service: "db", state: "running", oneshot: false }, { service: "cache", state: "exited", oneshot: false }, { service: "db-init", state: "exited", oneshot: true }],
};

// `live` e `topLevelLive` ficam de fora quando vazios: o widget os lê como "tem algo" (ver .design-sync-reports/pendencias-B-widget.md)
const pr = (number: number, title: string, verdict: string, extra: Dict = {}): Dict => ({ number, title, isDraft: false, checks: { verdict }, unresolved: 0, unseenReviewSincePush: false, ...extra });
const REPORT: Dict = {
  prs: [pr(1, "verde", "green"), pr(2, "falha", "red", { unresolved: 2 }), pr(3, "rascunho", "green", { isDraft: true }), pr(4, "rodando", "pending", { unseenReviewSincePush: true }),
    pr(5, "sem ci", "none"), pr(6, "x".repeat(300), "futuro")],
};

export async function widgetSistemaPrsRoute(r: Rig, tag: string): Promise<string> {
  const { D } = widgetData(r, tag);
  const collector = stubCollector(r);
  collector.state.report = REPORT;
  const calls = collector.calls;
  const o = new Lines();
  const P = await startTestPanel(D);
  let clock = NOW;
  const mk = (config: Record<string, string> = { HADES_WIDGET_PRS_TTL: "300" }) =>
    directWidget(D, { now: () => clock, orchestration: async () => ORCH, gates: () => GATES, sampler: () => SAMPLER, config: () => config });
  try {
    const w = mk();
    const read = async (headers: Record<string, string>): Promise<Response> => w.handle(new Request("http://127.0.0.1/api/widget", { headers }), "127.0.0.1");
    const tok = String(w.tokenAct("create").token);
    const good = bearer(tok);
    const get = async (): Promise<Dict> => (await (await read(good)).json()) as Dict;
    const prsOf = (d: Dict): Dict => d.prs as Dict;

    // a primeira leitura só dispara a coleta (nunca espera o coletor); a seguinte, no mesmo instante, traz o dado
    await get();
    const out = await until(get, (d) => prsOf(d).available === true);
    o.print("campos-antigos", Object.keys(out).filter((k) => k !== "system" && k !== "prs").sort().join(","));
    o.print("campos-novos", Object.keys(out).filter((k) => k === "system" || k === "prs").sort().join(","));
    o.print("agentes-intactos", out.version, pyDump(out.counts), (out.agents as Dict[])[0]?.name);
    const s = out.system as Dict;
    const mem = s.memory as Dict;
    o.print("memoria", Math.trunc((mem.totalBytes as number) / GIB), Math.trunc((mem.usedBytes as number) / GIB), Math.trunc((mem.availableBytes as number) / GIB));
    const infra = s.infra as Dict;
    o.print("servicos", pyDump(infra.services));
    o.print("containers", pyDump(infra.containers));
    o.print("fila", pyDump(s.queue));
    const p = prsOf(out);
    const items = p.items as Dict[];
    o.print("prs-meta", p.available, p.ageSeconds, p.error, p.fetchedAt);
    o.print("prs-sem-draft", items.map((i) => i.number).join(" "));
    o.print("prs-ci", items.map((i) => `${i.number}:${i.ci}`).join(" "));
    o.print("prs-review", items.map((i) => `${i.number}:${Number(i.reviewPending)}`).join(" "));
    o.print("prs-titulo-limitado", String(items[items.length - 1]?.title).length);
    o.print("prs-campos", Object.keys(items[0] as Dict).sort().join(","));

    clock = NOW + 60;
    await get();
    o.print("coletas-na-segunda-leitura", calls.length);
    o.print("idade-do-cache", prsOf(await get()).ageSeconds);

    clock = NOW + 301;
    collector.state.fail = true;
    await get();
    o.print("coletas-apos-vencer", calls.length);
    const failed = await until(get, (d) => prsOf(d).error !== null);
    const pf = prsOf(failed);
    o.print("falha-mantem-dado", pf.available, (pf.items as Dict[]).length, pf.error, pf.ageSeconds);
    o.print("falha-sem-detalhe", Number(JSON.stringify(failed).includes("secreto")));
    clock = NOW + 302;
    await get();
    o.print("falha-nao-martela", calls.length);
    clock = NOW + 700;
    collector.state.fail = false;
    collector.state.report = { prs: [pr(9, "nova", "green")] };
    await get();
    const rec = prsOf(await until(get, (d) => prsOf(d).error === null));
    o.print("recuperou", rec.error, (rec.items as Dict[]).map((i) => i.number).join(" "), rec.ageSeconds);

    // sem coleta ainda: a primeira falha deixa a seção indisponível; coleta em andamento nunca bloqueia a leitura
    const cold = createPrsCache(async () => { throw new Error("sem gh"); }, () => 300);
    cold.get(NOW);
    await Bun.sleep(20);
    const first = prsSection(cold.get(NOW), NOW);
    o.print("primeira-falha", first.available, first.fetchedAt, first.error, (first.items as Dict[]).length);
    const lazy = createPrsCache(() => new Promise<Dict>(() => {}), () => 300);
    const pending = prsSection(lazy.get(NOW), NOW);
    o.print("coleta-nao-bloqueia", pending.available, pending.error);

    // TTL nunca abaixo do do gh (300 s): HADES_WIDGET_PRS_TTL=10 não faz coletar antes disso
    const low = mk({ HADES_WIDGET_PRS_TTL: "10" });
    const lowRead = async () => (await (await low.handle(new Request("http://127.0.0.1/api/widget", { headers: good }), "127.0.0.1")).json()) as Dict;
    clock = NOW + 2000;
    const before = calls.length;
    await lowRead();
    await until(lowRead, (d) => prsOf(d).available === true);
    clock = NOW + 2000 + 299;
    await lowRead();
    await Bun.sleep(30);
    const mid = calls.length;
    clock = NOW + 2000 + 300;
    await lowRead();
    o.print("ttl-minimo", py(mid - before === 1 && calls.length - before === 2));

    // a linha de comando do coletor: bun src/cli.ts pr-loop-state --json, nunca gh direto
    const argv = calls[calls.length - 1] as string[];
    o.print("comando-do-coletor", basename(argv[0] as string), `${basename(argv[1] as string)} ${argv[2]}`, argv[3]);

    // segurança: o que é novo continua atrás do token do widget
    clock = NOW;
    const noTok = await read({});
    o.print("sem-token", noTok.status, ((await noTok.json()) as Dict).code);
    const panelTok = { ...JSON_CT, "X-Panel-Token": P.token };
    const other = await fetchRaw(P.base, "/api/snapshot", good);
    o.print("token-em-outra-rota", other.status, other.code);
    const post = await fetchRaw(P.base, "/api/action", { ...panelTok, ...good }, { action: "x" });
    o.print("token-em-post", post.status, post.code);
    for (let i = 0; i < 8; i++) await read({ Authorization: "Bearer errado" });
    const blocked = await read(good);
    o.print("bloqueado", blocked.status, ((await blocked.json()) as Dict).code);
    o.print("retry-after", blocked.headers.get("Retry-After"));
  } finally {
    P.stop();
    collector.restore();
  }
  return o.out;
}
