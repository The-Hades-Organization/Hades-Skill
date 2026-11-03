// Grupo canvas-portal-route: POST /api/canvas/portal/check (src/panel/canvas-portal.ts + despacho em server.ts) — só cabeçalhos,
// timeout, redirecionamento contido na lista, limite de taxa, cache e o regime de acesso do painel (chave, token, origem).
// A rota em processo usa servidores locais descartáveis e um `fetch` dublê; o painel real, uma pasta de dados descartável.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PORTAL_BLOCKS, PORTAL_ERRORS, PORTAL_LIMITS } from "../../../src/lib/canvas-portal";
import { createCanvasPortalRoutes, PORTAL_ROUTE_ERRORS, type PortalCaller, type PortalFetch } from "../../../src/panel/canvas-portal";
import { Rig } from "./lib/rig";
import { fetchRaw, JSON_CT, remoteHeaders, startTestPanel, widgetData } from "./lib/widget-rig";

type Dict = Record<string, unknown>;
const json = async (res: Response): Promise<Dict> => (await res.json()) as Dict;
const local: PortalCaller = { remote: false, ancestorOrigin: "http://127.0.0.1:21220" };

/** Servidor local que responde como o teste manda e conta os pedidos (método e caminho). */
function upstream(handler: (req: Request) => Response | Promise<Response>) {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      return handler(req);
    },
  });
  return { seen, base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const routes = (over: Partial<Parameters<typeof createCanvasPortalRoutes>[0]> = {}) =>
  createCanvasPortalRoutes({ hosts: () => ({ hadesHosts: [], extraHosts: "" }), timeoutMs: 2000, ...over });

describe("canvas-portal-route: só os cabeçalhos, em processo", () => {
  test("página sem cabeçalho de moldura é embutível e a resposta traz o necessário", async () => {
    const page = upstream(() => new Response("<html></html>", { headers: { "content-type": "text/html" } }));
    try {
      const res = await routes().check({ url: `${page.base}/inicio` }, local);
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({ ok: true, url: `${page.base}/inicio`, finalUrl: `${page.base}/inicio`, embeddable: true, reason: null, status: 200 });
      expect(page.seen).toEqual(["HEAD /inicio"]);
    } finally {
      page.stop();
    }
  });

  test("checkedAt sai em UTC com Z e vem do relógio injetado", async () => {
    const page = upstream(() => new Response(""));
    try {
      const body = await json(await routes({ now: () => Date.UTC(2026, 10, 2, 12, 0, 0) }).check({ url: page.base }, local));
      expect(body.checkedAt).toBe("2026-11-02T12:00:00.000Z");
    } finally {
      page.stop();
    }
  });

  test("X-Frame-Options DENY e frame-ancestors 'none' viram link com o motivo", async () => {
    const deny = upstream(() => new Response("", { headers: { "x-frame-options": "DENY" } }));
    const csp = upstream(() => new Response("", { headers: { "content-security-policy": "default-src 'self'; frame-ancestors 'none'" } }));
    try {
      expect(await json(await routes().check({ url: deny.base }, local))).toMatchObject({ embeddable: false, reason: PORTAL_BLOCKS.frameOptionsDeny });
      expect(await json(await routes().check({ url: csp.base }, local))).toMatchObject({ embeddable: false, reason: PORTAL_BLOCKS.cspFrameAncestors });
    } finally {
      deny.stop();
      csp.stop();
    }
  });

  test("frame-ancestors que nomeia o painel libera; SAMEORIGIN, vindo de outra origem, bloqueia", async () => {
    const ok = upstream(() => new Response("", { headers: { "content-security-policy": "frame-ancestors http://127.0.0.1:21220" } }));
    const same = upstream(() => new Response("", { headers: { "x-frame-options": "SAMEORIGIN" } }));
    try {
      expect(await json(await routes().check({ url: ok.base }, local))).toMatchObject({ embeddable: true });
      expect(await json(await routes().check({ url: same.base }, local))).toMatchObject({ embeddable: false, reason: PORTAL_BLOCKS.frameOptionsSameOrigin });
      expect(await json(await routes().check({ url: ok.base }, { remote: false, ancestorOrigin: "http://127.0.0.1:9" }))).toMatchObject({ embeddable: false });
    } finally {
      ok.stop();
      same.stop();
    }
  });

  test("HEAD recusado (405) repete como GET e o corpo, mesmo sem fim, nunca é lido", async () => {
    let cancelled = false;
    const page = upstream((req) => {
      if (req.method === "HEAD") return new Response(null, { status: 405 });
      const endless = new ReadableStream({
        pull: (controller) => void controller.enqueue(new TextEncoder().encode("x".repeat(1024))),
        cancel: () => void (cancelled = true),
      });
      return new Response(endless, { headers: { "x-frame-options": "DENY" } });
    });
    try {
      const started = Date.now();
      const body = await json(await routes().check({ url: `${page.base}/p` }, local));
      expect(Date.now() - started).toBeLessThan(1500);
      expect(body).toMatchObject({ embeddable: false, reason: PORTAL_BLOCKS.frameOptionsDeny, status: 200 });
      expect(page.seen).toEqual(["HEAD /p", "GET /p"]);
      await Bun.sleep(50);
      expect(cancelled).toBe(true);
    } finally {
      page.stop();
    }
  });

  test("redirecionamento dentro da lista é seguido e o veredito é o da página final", async () => {
    const page = upstream((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/a") return new Response(null, { status: 302, headers: { location: "/b" } });
      return new Response("", { headers: { "x-frame-options": "DENY" } });
    });
    try {
      const body = await json(await routes().check({ url: `${page.base}/a` }, local));
      expect(body).toMatchObject({ url: `${page.base}/a`, finalUrl: `${page.base}/b`, embeddable: false, reason: PORTAL_BLOCKS.frameOptionsDeny });
      expect(page.seen).toEqual(["HEAD /a", "HEAD /b"]);
    } finally {
      page.stop();
    }
  });

  test("redirecionamento para fora da lista não é seguido: nenhum pedido sai e vira link", async () => {
    const calls: string[] = [];
    const fake: PortalFetch = async (url) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: "https://externo.example.invalid/x" } });
    };
    const body = await json(await routes({ fetchImpl: fake }).check({ url: "http://localhost:3000/" }, local));
    expect(body).toMatchObject({ embeddable: false, reason: PORTAL_BLOCKS.redirectOutside, status: 302 });
    expect(calls).toEqual(["http://localhost:3000/"]);
  });

  test("redirecionamento com Location ruim ou ausente vira redirect_outside", async () => {
    for (const headers of [{}, { location: "javascript:alert(1)" }, { location: "http://u:p@localhost/" }]) {
      const fake: PortalFetch = async () => new Response(null, { status: 301, headers });
      expect(await json(await routes({ fetchImpl: fake }).check({ url: "http://localhost:3000/" }, local))).toMatchObject({ reason: PORTAL_BLOCKS.redirectOutside });
    }
  });

  test("laço de redirecionamento para no teto e vira redirect_limit", async () => {
    const calls: string[] = [];
    const fake: PortalFetch = async (url) => {
      calls.push(url);
      return new Response(null, { status: 307, headers: { location: `/${calls.length}` } });
    };
    const body = await json(await routes({ fetchImpl: fake }).check({ url: "http://localhost:3000/" }, local));
    expect(body).toMatchObject({ embeddable: false, reason: PORTAL_BLOCKS.redirectLimit });
    expect(calls).toHaveLength(PORTAL_LIMITS.redirects + 1);
  });

  test("redirecionamento para host extra permitido é seguido; a lista vem da configuração a cada pedido", async () => {
    let extra = "";
    const fake: PortalFetch = async (url) =>
      url.startsWith("http://localhost")
        ? new Response(null, { status: 302, headers: { location: "https://docs.example.invalid/x" } })
        : new Response("", { headers: { "x-frame-options": "DENY" } });
    const r = routes({ fetchImpl: fake, hosts: () => ({ hadesHosts: [], extraHosts: extra }) });
    expect(await json(await r.check({ url: "http://localhost:3000/" }, local))).toMatchObject({ reason: PORTAL_BLOCKS.redirectOutside });
    extra = "docs.example.invalid";
    expect(await json(await r.check({ url: "http://localhost:3000/", }, { ...local, ancestorOrigin: "http://localhost:21220" }))).toMatchObject({ finalUrl: "https://docs.example.invalid/x", reason: PORTAL_BLOCKS.frameOptionsDeny });
  });

  test("sem resposta dentro do timeout vira timeout; porta fechada vira unreachable", async () => {
    const hang = upstream(() => new Promise<Response>(() => undefined));
    const closed = upstream(() => new Response(""));
    const closedBase = closed.base;
    closed.stop();
    try {
      const started = Date.now();
      expect(await json(await routes({ timeoutMs: 150 }).check({ url: hang.base }, local))).toMatchObject({ embeddable: false, reason: PORTAL_BLOCKS.timeout, status: null });
      expect(Date.now() - started).toBeLessThan(1500);
      expect(await json(await routes().check({ url: closedBase }, local))).toMatchObject({ embeddable: false, reason: PORTAL_BLOCKS.unreachable, status: null });
    } finally {
      hang.stop();
    }
  });

  test("pelo acesso remoto, loopback vira link sem sair nenhum pedido; http em painel https é conteúdo misto", async () => {
    const calls: string[] = [];
    const fake: PortalFetch = async (url) => {
      calls.push(url);
      return new Response("");
    };
    const r = routes({ fetchImpl: fake, hosts: () => ({ hadesHosts: ["painel.example.invalid"], extraHosts: "docs.example.invalid" }) });
    const remote: PortalCaller = { remote: true, ancestorOrigin: "https://painel.example.invalid" };
    expect(await json(await r.check({ url: "http://localhost:3000/" }, remote))).toMatchObject({ embeddable: false, reason: PORTAL_BLOCKS.remoteLoopback });
    expect(await json(await r.check({ url: "http://docs.example.invalid/" }, remote))).toMatchObject({ embeddable: false, reason: PORTAL_BLOCKS.mixedContent });
    expect(calls).toEqual([]);
    expect(await json(await r.check({ url: "https://docs.example.invalid/" }, remote))).toMatchObject({ embeddable: true });
    expect(calls).toEqual(["https://docs.example.invalid/"]);
  });
});

describe("canvas-portal-route: entrada inválida e host fora da lista", () => {
  const refusalOf = async (url: unknown, status: number, code: string) => {
    const calls: string[] = [];
    const res = await routes({ fetchImpl: async (u) => (calls.push(u), new Response("")) }).check({ url }, local);
    expect(res.status).toBe(status);
    const body = await json(res);
    expect(body.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain("localhost");
    expect(calls).toEqual([]);
  };

  test("sem url, não texto, vazio ou mal formado: 400 portal_invalid_url, sem pedido", async () => {
    for (const bad of [undefined, null, 5, {}, "", "  ", "http://"]) await refusalOf(bad, 400, PORTAL_ERRORS.invalidUrl);
  });

  test("esquema, credencial e tamanho: 400 com o código certo", async () => {
    await refusalOf("file:///etc/passwd", 400, PORTAL_ERRORS.scheme);
    await refusalOf("http://usuario:senha@localhost/", 400, PORTAL_ERRORS.credentials);
    await refusalOf(`http://localhost/${"a".repeat(PORTAL_LIMITS.urlChars)}`, 400, PORTAL_ERRORS.urlTooLong);
  });

  test("host fora da lista: 403 portal_host_not_allowed e nenhum pedido sai (nem ao endereço da nuvem)", async () => {
    await refusalOf("http://example.com/", 403, PORTAL_ERRORS.hostNotAllowed);
    await refusalOf("http://169.254.169.254/latest/meta-data", 403, PORTAL_ERRORS.hostNotAllowed);
    await refusalOf("http://localhost.evil.example/", 403, PORTAL_ERRORS.hostNotAllowed);
  });
});

describe("canvas-portal-route: limite de taxa e cache", () => {
  test("acima de 30 conferências por minuto: 429 com Retry-After; passada a janela, volta", async () => {
    let clock = 1_000_000;
    const calls: string[] = [];
    const r = routes({ now: () => clock, fetchImpl: async (u) => (calls.push(u), new Response("")) });
    for (let i = 0; i < 30; i += 1) expect((await r.check({ url: `http://localhost:3000/${i}` }, local)).status).toBe(200);
    const limited = await r.check({ url: "http://localhost:3000/extra" }, local);
    expect(limited.status).toBe(429);
    expect((await json(limited)).code).toBe(PORTAL_ROUTE_ERRORS.rateLimited);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(30);
    clock += 61_000;
    expect((await r.check({ url: "http://localhost:3000/extra" }, local)).status).toBe(200);
  });

  test("a resposta repetida da mesma URL vem do cache por 30 s e não conta na taxa", async () => {
    let clock = 5_000_000;
    const calls: string[] = [];
    const r = routes({ now: () => clock, fetchImpl: async (u) => (calls.push(u), new Response("")) });
    for (let i = 0; i < 60; i += 1) expect((await r.check({ url: "http://localhost:3000/" }, local)).status).toBe(200);
    expect(calls).toHaveLength(1);
    clock += 31_000;
    await r.check({ url: "http://localhost:3000/" }, local);
    expect(calls).toHaveLength(2);
  });

  test("serviço fora do ar não fica no cache: ao subir, o próximo pedido já vê", async () => {
    let up = false;
    const calls: string[] = [];
    const r = routes({
      fetchImpl: async (u) => {
        calls.push(u);
        if (!up) throw new TypeError("connection refused");
        return new Response("");
      },
    });
    expect(await json(await r.check({ url: "http://localhost:3000/" }, local))).toMatchObject({ reason: PORTAL_BLOCKS.unreachable });
    up = true;
    expect(await json(await r.check({ url: "http://localhost:3000/" }, local))).toMatchObject({ embeddable: true });
    expect(calls).toHaveLength(2);
  });
});

describe("canvas-portal-route: pelo painel real (acesso e token)", () => {
  const r = new Rig().setup();
  let D = "";
  let P: Awaited<ReturnType<typeof startTestPanel>>;
  const page = upstream(() => new Response("", { headers: { "content-security-policy": "frame-ancestors http://127.0.0.1:*" } }));
  beforeAll(async () => {
    D = widgetData(r, "canvas-portal").D;
    P = await startTestPanel(D);
  });
  afterAll(() => {
    P?.stop();
    page.stop();
    r.cleanup();
  });

  const path = "/api/canvas/portal/check";
  const authed = (): Record<string, string> => ({ ...JSON_CT, "x-panel-token": P.token });

  test("local com token confere a página e usa o Host do painel como origem de quem embute", async () => {
    const res = await fetchRaw(P.base, path, authed(), { url: page.base });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, embeddable: true, reason: null, status: 200 });
    expect((await fetchRaw(P.base, path, authed(), { url: "http://example.com/" })).json?.code).toBe(PORTAL_ERRORS.hostNotAllowed);
  });

  test("sem token ou sem JSON: 403; método GET e caminho vizinho: 404", async () => {
    expect((await fetchRaw(P.base, path, JSON_CT, { url: page.base })).status).toBe(403);
    expect((await fetchRaw(P.base, path, { "x-panel-token": P.token, "Content-Type": "text/plain" }, { url: page.base })).status).toBe(403);
    expect((await fetchRaw(P.base, path, authed(), undefined, "GET")).status).toBe(404);
    expect((await fetchRaw(P.base, "/api/canvas/portal/outro", authed(), { url: page.base })).status).toBe(404);
  });

  test("origem de outro site é recusada, como nas demais rotas", async () => {
    expect((await fetchRaw(P.base, path, { ...authed(), Origin: "http://evil.example" }, { url: page.base })).status).toBe(403);
  });

  test("corpo que não é objeto JSON: 400", async () => {
    const res = await fetch(`${P.base}${path}`, { method: "POST", headers: authed(), body: "[1]" });
    expect(res.status).toBe(400);
  });

  test("pelo túnel: sem a chave 401; com a chave, loopback vira link sem pedido saindo", async () => {
    const anon = remoteHeaders(D, false);
    expect((await fetchRaw(P.base, path, { ...anon, ...authed() }, { url: page.base })).status).toBe(401);
    const keyed = remoteHeaders(D, true);
    const res = await fetchRaw(P.base, path, { ...keyed, ...authed() }, { url: page.base });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ embeddable: false, reason: PORTAL_BLOCKS.remoteLoopback });
    expect(page.seen).toHaveLength(1);
  });
});
