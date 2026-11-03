// Grupo canvas-portal-policy: GET /api/canvas/portal/policy (src/panel/canvas-portal.ts + despacho em server.ts) — os hosts que
// o portal aceita, para a página filtrar; nunca a chave bruta da configuração e, sem configuração legível, listas vazias.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { createCanvasPortalRoutes } from "../../../src/panel/canvas-portal";
import { Rig } from "./lib/rig";
import { fetchRaw, JSON_CT, PUB, remoteHeaders, startTestPanel, widgetData } from "./lib/widget-rig";

type Hosts = ReturnType<Parameters<typeof createCanvasPortalRoutes>[0]["hosts"]>;
const policyOf = async (hosts: () => Hosts): Promise<{ status: number; body: Record<string, unknown>; text: string }> => {
  const res = createCanvasPortalRoutes({ hosts }).policy();
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
};
const CLOSED = { exact: [], suffixes: [] };

describe("canvas-portal-policy: a política em processo", () => {
  test("dado hosts configurados, então exact e suffixes saem ordenados, com o loopback e o host do túnel", async () => {
    const r = await policyOf(() => ({ hadesHosts: ["painel.example.invalid"], extraHosts: "wiki.example.com, *.corp.example.com ,b.example.com" }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      exact: ["127.0.0.1", "[::1]", "b.example.com", "localhost", "painel.example.invalid", "wiki.example.com"].sort(),
      suffixes: ["corp.example.com"],
    });
  });

  test("dado configuração vazia, então só o que o check já libera (loopback), sem host nenhum a mais", async () => {
    const { body } = await policyOf(() => ({ hadesHosts: [], extraHosts: "" }));
    expect((body.exact as string[]).every((host) => ["localhost", "127.0.0.1", "[::1]"].includes(host))).toBe(true);
    expect(body.suffixes).toEqual([]);
  });

  test("dado entrada inválida na configuração (coringa largo, URL, lixo), então ela some e não vaza no corpo", async () => {
    const raw = "*.com,http://x.example.com/path,não é host,ok.example.com";
    const r = await policyOf(() => ({ hadesHosts: [], extraHosts: raw }));
    expect(r.body.exact).toContain("ok.example.com");
    expect(r.body.suffixes).toEqual([]);
    expect(Object.keys(r.body).sort()).toEqual(["exact", "suffixes"]);
    for (const piece of ["não é host", "path", "*.com"]) expect(r.text).not.toContain(piece);
    expect(r.text).not.toContain(raw);
  });

  test("dado configuração que não se lê (lança) ou sem a forma esperada, então falha fechada: listas vazias", async () => {
    const broken: (() => Hosts)[] = [
      () => { throw new Error("config ilegível"); },
      () => undefined as unknown as Hosts,
      () => ({ hadesHosts: [], extraHosts: 7 }) as unknown as Hosts,
      () => ({ hadesHosts: "painel", extraHosts: "" }) as unknown as Hosts,
    ];
    for (const hosts of broken) expect(await policyOf(hosts)).toMatchObject({ status: 200, body: CLOSED });
  });

  test("dado a configuração mudando entre pedidos, então a política acompanha", async () => {
    let extra = "a.example.com";
    const routes = createCanvasPortalRoutes({ hosts: () => ({ hadesHosts: [], extraHosts: extra }) });
    expect(((await routes.policy().json()) as { exact: string[] }).exact).toContain("a.example.com");
    extra = "b.example.com";
    const next = (await routes.policy().json()) as { exact: string[] };
    expect(next.exact).toContain("b.example.com");
    expect(next.exact).not.toContain("a.example.com");
  });
});

describe("canvas-portal-policy: pelo painel real (acesso)", () => {
  const r = new Rig().setup();
  const KEY = "extra.example.com,*.lab.example.com";
  let D = "";
  let P: Awaited<ReturnType<typeof startTestPanel>>;
  beforeAll(async () => {
    D = widgetData(r, "canvas-portal-policy").D;
    appendFileSync(`${D}/config.env`, `HADES_CANVAS_PORTAL_HOSTS=${KEY}\n`);
    P = await startTestPanel(D);
  });
  afterAll(() => {
    P?.stop();
    r.cleanup();
  });
  const path = "/api/canvas/portal/policy";

  test("local: 200 com exact e suffixes da configuração e do túnel, e nada da chave bruta", async () => {
    const res = await fetchRaw(P.base, path);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      exact: expect.arrayContaining(["extra.example.com", PUB, "localhost"]),
      suffixes: ["lab.example.com"],
    });
    expect(res.text).not.toContain(KEY);
    expect(res.hdr.get("cache-control")).toBe("no-store");
  });

  test("pelo túnel: sem a chave 401; com a chave 200", async () => {
    expect((await fetchRaw(P.base, path, remoteHeaders(D, false))).status).toBe(401);
    expect((await fetchRaw(P.base, path, remoteHeaders(D, true))).status).toBe(200);
  });

  test("POST na rota da política e caminho vizinho: 404", async () => {
    const authed = { ...JSON_CT, "x-panel-token": P.token };
    expect((await fetchRaw(P.base, path, authed, {})).status).toBe(404);
    expect((await fetchRaw(P.base, "/api/canvas/portal/outra")).status).toBe(404);
  });
});
