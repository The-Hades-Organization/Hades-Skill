// Grupo canvas-route: GET/PUT /api/canvas (src/panel/canvas.ts + registro em server.ts) — documento vazio, gravação
// atômica dentro de $D, validação com 400 + código, 409 por revisão velha, arquivo ilegível, corpo grande e o controle
// de acesso do servidor (chave, token da sessão). Painel real em processo, pasta de dados descartável.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_ERRORS, CANVAS_LIMITS, emptyCanvasDoc } from "../../../src/lib/canvas-doc";
import { CANVAS_STORE_LIMITS, scopedCanvasId } from "../../../src/lib/canvas-store";
import { emptySavedFilters, SAVED_FILTER_LIMITS } from "../../../src/lib/canvas-saved-filters";
import { createCanvasRoutes } from "../../../src/panel/canvas";
import { Rig } from "./lib/rig";
import { fetchRaw, JSON_CT, remoteHeaders, startTestPanel, widgetData } from "./lib/widget-rig";

type Dict = Record<string, unknown>;

const note = (id: string, over: Dict = {}): Dict => ({ id, type: "note", x: 1, y: 2, w: 100, h: 50, z: 0, data: { text: "oi" }, locked: false, blurred: false, ...over });
const docWith = (rev: number, nodes: Dict[] = [note("n1")]): Dict => ({ v: 1, rev, nodes, edges: [], groups: [] });

const T = mkdtempSync(join(tmpdir(), "hades-canvas-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const putReq = (body: string | Uint8Array, headers: Record<string, string> = {}): Request =>
  new Request("http://127.0.0.1/api/canvas", { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body });
const caller = { remote: false };
const json = async (res: Response): Promise<Dict> => (await res.json()) as Dict;

describe("canvas-route: a rota sobre a pasta de dados", () => {
  let n = 0;
  const fresh = () => {
    const D = join(T, `d${n++}`);
    mkdirSync(D, { recursive: true });
    return { D, routes: createCanvasRoutes(D), file: join(D, "canvas.json") };
  };

  test("GET sem arquivo devolve o documento vazio v1 e não grava nada", async () => {
    const { D, routes } = fresh();
    const res = routes.get();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ...emptyCanvasDoc() });
    expect(readdirSync(D)).toEqual([]);
  });

  test("PUT válido grava $D/canvas.json com rev+1, sem sobra de arquivo temporário, e o GET devolve o gravado", async () => {
    const { D, routes, file } = fresh();
    const res = await routes.put(putReq(JSON.stringify(docWith(0))), caller);
    expect([res.status, await json(res)]).toEqual([200, { v: 1, ok: true, rev: 1 }]);
    expect(readdirSync(D)).toEqual(["canvas.json"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(docWith(1));
    expect(await json(routes.get())).toEqual(docWith(1));
  });

  test("a revisão que o cliente leu abre a próxima gravação: rev 0 → 1 → 2", async () => {
    const { routes } = fresh();
    expect((await json(await routes.put(putReq(JSON.stringify(docWith(0))), caller))).rev).toBe(1);
    const second = await routes.put(putReq(JSON.stringify(docWith(1, [note("n1"), note("n2")]))), caller);
    expect([second.status, (await json(second)).rev]).toEqual([200, 2]);
    expect((await json(routes.get())).nodes).toHaveLength(2);
  });

  test("PUT com revisão velha responde 409 canvas_stale_revision com a revisão atual e não grava", async () => {
    const { routes, file } = fresh();
    await routes.put(putReq(JSON.stringify(docWith(0))), caller);
    const before = readFileSync(file, "utf8");
    const stale = await routes.put(putReq(JSON.stringify(docWith(0, [note("outro")]))), caller);
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ code: CANVAS_ERRORS.staleRevision, rev: 1 });
    expect(readFileSync(file, "utf8")).toBe(before);
    const ahead = await routes.put(putReq(JSON.stringify(docWith(7))), caller);
    expect([ahead.status, (await json(ahead)).code]).toEqual([409, CANVAS_ERRORS.staleRevision]);
  });

  test("dois PUT simultâneos com a mesma revisão: um grava (200) e o outro leva 409", async () => {
    const { routes } = fresh();
    const [a, b] = await Promise.all([routes.put(putReq(JSON.stringify(docWith(0, [note("a")]))), caller), routes.put(putReq(JSON.stringify(docWith(0, [note("b")]))), caller)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await json(routes.get())).rev).toBe(1);
  });

  const invalid: [string, string, string][] = [
    ["JSON quebrado", "{nope", CANVAS_ERRORS.invalidJson],
    ["corpo vazio", "", CANVAS_ERRORS.invalidJson],
    ["raiz que é lista", "[]", CANVAS_ERRORS.invalidShape],
    ["versão desconhecida", JSON.stringify({ ...docWith(0), v: 9 }), CANVAS_ERRORS.unsupportedVersion],
    ["nó com forma errada", JSON.stringify(docWith(0, [note("n1", { w: 0 })])), CANVAS_ERRORS.invalidNode],
    ["ids repetidos", JSON.stringify(docWith(0, [note("n1"), note("n1")])), CANVAS_ERRORS.duplicateId],
    ["nó acima do limite", JSON.stringify(docWith(0, Array.from({ length: CANVAS_LIMITS.nodes + 1 }, (_, i) => note(`n${i}`)))), CANVAS_ERRORS.limitExceeded],
    ["rev que não é número", JSON.stringify({ ...docWith(0), rev: "0" }), CANVAS_ERRORS.invalidShape],
  ];
  test.each(invalid)("PUT inválido (%s) responde 400 com o código estável, sem detalhe interno, e não grava", async (_, body, code) => {
    const { D, routes } = fresh();
    const res = await routes.put(putReq(body), caller);
    const out = await json(res);
    expect([res.status, out.code]).toEqual([400, code]);
    expect(JSON.stringify(out)).not.toContain(D);
    expect(Object.keys(out).sort()).toEqual(["code", "error"]);
    expect(existsSync(join(D, "canvas.json"))).toBe(false);
  });

  test("PUT inválido não sobrescreve o documento que já estava gravado", async () => {
    const { routes, file } = fresh();
    await routes.put(putReq(JSON.stringify(docWith(0))), caller);
    const before = readFileSync(file, "utf8");
    expect((await routes.put(putReq("{nope"), caller)).status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("corpo acima do teto de bytes responde 400 canvas_too_large, pelo Content-Length e pelo fluxo", async () => {
    const { routes } = fresh();
    const big = new Uint8Array(CANVAS_LIMITS.bodyBytes + 1).fill(32);
    const res = await routes.put(putReq(big), caller);
    expect([res.status, (await json(res)).code]).toEqual([400, CANVAS_ERRORS.tooLarge]);
    const lying = await routes.put(putReq("{}", { "Content-Length": String(CANVAS_LIMITS.bodyBytes + 1) }), caller);
    expect([lying.status, (await json(lying)).code]).toEqual([400, CANVAS_ERRORS.tooLarge]);
    const stream = new Request("http://127.0.0.1/api/canvas", { method: "PUT", body: new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }), duplex: "half" } as RequestInit);
    expect((await json(await routes.put(stream, caller))).code).toBe(CANVAS_ERRORS.tooLarge);
  });

  test("arquivo ilegível: GET e PUT respondem 500 canvas_unreadable sem caminho e sem apagar o arquivo", async () => {
    const { D, routes, file } = fresh();
    writeFileSync(file, "isto não é JSON");
    for (const res of [routes.get(), await routes.put(putReq(JSON.stringify(docWith(0))), caller)]) {
      const out = await json(res);
      expect([res.status, out.code]).toEqual([500, CANVAS_ERRORS.unreadable]);
      expect(JSON.stringify(out)).not.toContain(D);
    }
    expect(readFileSync(file, "utf8")).toBe("isto não é JSON");
    writeFileSync(file, JSON.stringify({ v: 1, rev: 0, nodes: "x", edges: [], groups: [] }));
    expect(routes.get().status).toBe(500);
  });
});

describe("canvas-route: pelo painel real (acesso e token)", () => {
  const r = new Rig().setup();
  let D = "";
  let P: Awaited<ReturnType<typeof startTestPanel>>;
  beforeAll(async () => {
    D = widgetData(r, "canvas-route").D;
    P = await startTestPanel(D);
  });
  afterAll(() => {
    P?.stop();
    r.cleanup();
  });

  const put = (body: unknown, headers: Record<string, string> = {}) => fetchRaw(P.base, "/api/canvas", { ...JSON_CT, "x-panel-token": P.token, ...headers }, body, "PUT");

  test("local: GET vazio, PUT com o token grava em $D e o GET devolve", async () => {
    const empty = await fetchRaw(P.base, "/api/canvas");
    expect([empty.status, empty.json]).toEqual([200, { ...emptyCanvasDoc() }]);
    const saved = await put(docWith(0));
    expect([saved.status, saved.json]).toEqual([200, { v: 1, ok: true, rev: 1 }]);
    expect(JSON.parse(readFileSync(join(D, "canvas.json"), "utf8"))).toEqual(docWith(1));
    expect((await fetchRaw(P.base, "/api/canvas")).json).toEqual(docWith(1));
  });

  test("PUT inválido e PUT velho passam pelo servidor com 400 e 409 e o código no corpo", async () => {
    const bad = await put({ v: 1, rev: 1, nodes: 3, edges: [], groups: [] });
    expect([bad.status, bad.code]).toEqual([400, CANVAS_ERRORS.invalidShape]);
    const stale = await put(docWith(0));
    expect([stale.status, stale.code]).toEqual([409, CANVAS_ERRORS.staleRevision]);
  });

  test("PUT sem o token da sessão ou sem JSON é 403, e nada muda", async () => {
    const before = readFileSync(join(D, "canvas.json"), "utf8");
    const noToken = await fetchRaw(P.base, "/api/canvas", JSON_CT, docWith(1), "PUT");
    expect(noToken.status).toBe(403);
    const wrongType = await fetch(`${P.base}/api/canvas`, { method: "PUT", headers: { "x-panel-token": P.token, "Content-Type": "text/plain" }, body: JSON.stringify(docWith(1)) });
    expect(wrongType.status).toBe(403);
    const badOrigin = await put(docWith(1), { Origin: "https://evil.example.invalid" });
    expect(badOrigin.status).toBe(403);
    expect(readFileSync(join(D, "canvas.json"), "utf8")).toBe(before);
  });

  test("pelo túnel: sem a chave, GET e PUT são 401; com a chave o PUT ainda exige o token", async () => {
    const before = readFileSync(join(D, "canvas.json"), "utf8");
    const anon = remoteHeaders(D, false);
    expect((await fetchRaw(P.base, "/api/canvas", anon)).status).toBe(401);
    expect((await fetchRaw(P.base, "/api/canvas", { ...anon, ...JSON_CT, "x-panel-token": P.token }, docWith(1), "PUT")).status).toBe(401);
    const keyed = remoteHeaders(D, true);
    expect((await fetchRaw(P.base, "/api/canvas", keyed)).status).toBe(200);
    expect((await fetchRaw(P.base, "/api/canvas", { ...keyed, ...JSON_CT }, docWith(1), "PUT")).status).toBe(403);
    expect(readFileSync(join(D, "canvas.json"), "utf8")).toBe(before);
  });

  test("pelo túnel com a chave e o token, o PUT grava como no local", async () => {
    const keyed = remoteHeaders(D, true);
    const res = await fetchRaw(P.base, "/api/canvas", { ...keyed, ...JSON_CT, "x-panel-token": P.token }, docWith(1, [note("remoto")]), "PUT");
    expect([res.status, res.json?.rev]).toEqual([200, 2]);
  });

  test("POST em /api/canvas e PUT em outra rota não existem (404)", async () => {
    expect((await fetchRaw(P.base, "/api/canvas", { ...JSON_CT, "x-panel-token": P.token }, docWith(2), "POST")).status).toBe(404);
    expect((await fetchRaw(P.base, "/api/config", { ...JSON_CT, "x-panel-token": P.token }, {}, "PUT")).status).toBe(404);
  });
});

// ---- vários canvases: /api/canvases/* ----
const BASE = "/api/canvases";
const asReq = (method: string, path: string, body?: string | Uint8Array, headers: Record<string, string> = {}): Request =>
  new Request(`http://127.0.0.1${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body }) });
const NOW = new Date("2026-11-02T12:00:00.000Z");

describe("canvas-route: vários canvases (em processo)", () => {
  let n = 0;
  const fresh = () => {
    const D = join(T, `m${n++}`);
    mkdirSync(D, { recursive: true });
    const routes = createCanvasRoutes(D, () => NOW);
    const many = async (method: "POST" | "PUT", path: string, body?: unknown, query: Record<string, string> = {}): Promise<Response> => {
      const res = routes.writeMany(method, path, query, asReq(method, path, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)), caller);
      return res ?? new Response(null, { status: 599 });
    };
    const read = async (path: string): Promise<Response> => routes.getMany(path) ?? new Response(null, { status: 599 });
    const create = async (name: string, id?: string): Promise<Dict> => json(await many("POST", BASE, id ? { name, id } : { name }));
    return { D, routes, many, read, create, file: (id: string) => join(D, "canvases", `${id}.json`) };
  };
  const refusalOf = async (res: Response): Promise<[number, unknown]> => [res.status, (await json(res)).code];

  test("dado o arquivo único antigo, então ele é o canvas padrão, no mesmo arquivo e sem migração", async () => {
    const { D, routes, read, many } = fresh();
    writeFileSync(join(D, "canvas.json"), JSON.stringify(docWith(5, [note("antigo")])));
    expect(await json(await read(`${BASE}/default`))).toEqual(docWith(5, [note("antigo")]));
    expect(await json(routes.get())).toEqual(docWith(5, [note("antigo")]));
    const list = await json(await read(BASE));
    expect(list).toMatchObject({ default: "default", canvases: [{ id: "default", name: "Padrão", rev: 5, nodes: 1 }] });
    const saved = await many("PUT", `${BASE}/default`, docWith(5, [note("antigo"), note("novo")]));
    expect([saved.status, (await json(saved)).rev]).toEqual([200, 6]);
    expect(JSON.parse(readFileSync(join(D, "canvas.json"), "utf8"))).toEqual(docWith(6, [note("antigo"), note("novo")]));
    expect(existsSync(join(D, "canvases"))).toBe(false);
  });

  test("dado instância sem nada, então a lista traz só o padrão vazio, sem data, e não grava nada", async () => {
    const { D, read } = fresh();
    expect(await json(await read(BASE))).toEqual({ default: "default", canvases: [{ id: "default", name: "Padrão", rev: 0, nodes: 0, edges: 0, updatedAt: null }] });
    expect(readdirSync(D)).toEqual([]);
  });

  test("criar devolve 201 com id derivado do nome, grava em canvases/<id>.json e o GET devolve o vazio", async () => {
    const { D, create, read, file } = fresh();
    expect(await create("Meu Mapa")).toEqual({ id: "meu-mapa", name: "Meu Mapa", rev: 0 });
    expect(JSON.parse(readFileSync(file("meu-mapa"), "utf8"))).toEqual({ name: "Meu Mapa", doc: emptyCanvasDoc() });
    expect(readdirSync(join(D, "canvases"))).toEqual(["meu-mapa.json"]);
    expect(await json(await read(`${BASE}/meu-mapa`))).toEqual({ ...emptyCanvasDoc() });
    expect((await create("Meu Mapa")).id).toBe("meu-mapa-2");
  });

  test("criar com id escolhido usa o id; id repetido ou o reservado é 409 canvas_exists", async () => {
    const { many, create } = fresh();
    expect((await create("A", "alfa")).id).toBe("alfa");
    expect(await refusalOf(await many("POST", BASE, { name: "B", id: "alfa" }))).toEqual([409, "canvas_exists"]);
    expect(await refusalOf(await many("POST", BASE, { name: "B", id: "default" }))).toEqual([409, "canvas_exists"]);
  });

  test("a lista traz padrão primeiro e os demais em ordem, com contagens e data em UTC", async () => {
    const { many, create, read } = fresh();
    await create("Zeta");
    await create("Alfa");
    await many("PUT", `${BASE}/alfa`, docWith(0, [note("a"), note("b")]));
    const { canvases } = (await json(await read(BASE))) as { canvases: Dict[] };
    expect(canvases.map((c) => c.id)).toEqual(["default", "alfa", "zeta"]);
    expect(canvases[1]).toMatchObject({ name: "Alfa", rev: 1, nodes: 2, edges: 0 });
    expect(canvases[1]?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  });

  test("criar com nome ou corpo inválido é 400 e não grava", async () => {
    const { D, many } = fresh();
    expect(await refusalOf(await many("POST", BASE, { name: "" }))).toEqual([400, "canvas_invalid_name"]);
    expect(await refusalOf(await many("POST", BASE, { name: "a\nb" }))).toEqual([400, "canvas_invalid_name"]);
    expect(await refusalOf(await many("POST", BASE, { id: "x" }))).toEqual([400, "canvas_invalid_name"]);
    expect(await refusalOf(await many("POST", BASE, "[]"))).toEqual([400, CANVAS_ERRORS.invalidShape]);
    expect(await refusalOf(await many("POST", BASE, "{nope"))).toEqual([400, CANVAS_ERRORS.invalidShape]);
    expect(await refusalOf(await many("POST", BASE, { name: "x".repeat(5000) }))).toEqual([400, CANVAS_ERRORS.invalidShape]);
    expect(existsSync(join(D, "canvases"))).toBe(false);
  });

  test("passar de 100 canvases é 409 canvas_limit_reached", async () => {
    const { many, D } = fresh();
    mkdirSync(join(D, "canvases"));
    for (let i = 0; i < 100; i++) writeFileSync(join(D, "canvases", `c${i}.json`), JSON.stringify({ name: `c${i}`, doc: emptyCanvasDoc() }));
    expect(await refusalOf(await many("POST", BASE, { name: "mais um" }))).toEqual([409, "canvas_limit_reached"]);
  });

  test("PUT segue a regra de revisão do padrão: rev+1, 409 se velha, e o nome não muda", async () => {
    const { many, create, file } = fresh();
    await create("Mapa");
    expect(await json(await many("PUT", `${BASE}/mapa`, docWith(0)))).toEqual({ v: 1, ok: true, rev: 1 });
    const stale = await many("PUT", `${BASE}/mapa`, docWith(0, [note("x")]));
    expect([stale.status, await json(stale)]).toMatchObject([409, { code: CANVAS_ERRORS.staleRevision, rev: 1 }]);
    expect(JSON.parse(readFileSync(file("mapa"), "utf8"))).toEqual({ name: "Mapa", doc: docWith(1) });
  });

  test("PUT inválido num canvas é 400 com o código do documento e não grava", async () => {
    const { many, create, file } = fresh();
    await create("Mapa");
    const before = readFileSync(file("mapa"), "utf8");
    expect(await refusalOf(await many("PUT", `${BASE}/mapa`, "{nope"))).toEqual([400, CANVAS_ERRORS.invalidJson]);
    expect(await refusalOf(await many("PUT", `${BASE}/mapa`, docWith(0, [note("n", { w: 0 })])))).toEqual([400, CANVAS_ERRORS.invalidNode]);
    expect(readFileSync(file("mapa"), "utf8")).toBe(before);
  });

  test("PUT acima do teto de bytes é 400 canvas_too_large", async () => {
    const { many, create } = fresh();
    await create("Mapa");
    const big = new Uint8Array(CANVAS_LIMITS.bodyBytes + 1).fill(32);
    expect(await refusalOf(await many("PUT", `${BASE}/mapa`, big as unknown as string))).toEqual([400, CANVAS_ERRORS.tooLarge]);
  });

  test("PUT e GET de canvas que não existe são 404 canvas_not_found, e o PUT não cria", async () => {
    const { many, read, D } = fresh();
    expect(await refusalOf(await many("PUT", `${BASE}/fantasma`, docWith(0)))).toEqual([404, "canvas_not_found"]);
    expect(await refusalOf(await read(`${BASE}/fantasma`))).toEqual([404, "canvas_not_found"]);
    expect(existsSync(join(D, "canvases"))).toBe(false);
  });

  const badIds = ["..", "a..b", "A", "a.b", "a b", "%2e%2e", "a%2fb", "-x", ".", "", "x".repeat(65)];
  test.each(badIds)("o id %j é recusado (400 canvas_invalid_id) em ler, gravar, renomear, apagar e exportar", async (id) => {
    const { many, read, D } = fresh();
    const p = `${BASE}/${id}`;
    const results = [
      await read(p),
      await many("PUT", p, docWith(0)),
      await many("POST", `${p}/rename`, { name: "x" }),
      await many("POST", `${p}/delete`),
      await read(`${p}/export`),
    ];
    for (const res of results) {
      // "" e "%…" não chegam a ser uma rota de id: ou 400 de id, ou 404 de rota; nunca sucesso nem fora da pasta
      expect([400, 404]).toContain(res.status);
      if (res.status === 400) expect((await json(res)).code).toBe("canvas_invalid_id");
    }
    expect(existsSync(join(D, "canvases"))).toBe(false);
  });

  test("id com .. no corpo de criar é recusado e nada é gravado fora da pasta", async () => {
    const { many, D } = fresh();
    expect(await refusalOf(await many("POST", BASE, { name: "x", id: "../fora" }))).toEqual([400, "canvas_invalid_id"]);
    expect(await refusalOf(await many("POST", BASE, { name: "x", id: "a/b" }))).toEqual([400, "canvas_invalid_id"]);
    expect(readdirSync(D)).toEqual([]);
  });

  test("a mensagem de erro de id não traz o caminho da instância", async () => {
    const { many, D } = fresh();
    expect(JSON.stringify(await json(await many("PUT", `${BASE}/..`, docWith(0))))).not.toContain(D);
  });

  test("renomear muda só o nome (documento e rev intactos); o padrão não se renomeia", async () => {
    const { many, create, file } = fresh();
    await create("Velho");
    await many("PUT", `${BASE}/velho`, docWith(0));
    const res = await many("POST", `${BASE}/velho/rename`, { name: " Novo " });
    expect([res.status, await json(res)]).toEqual([200, { ok: true, id: "velho", name: "Novo" }]);
    expect(JSON.parse(readFileSync(file("velho"), "utf8"))).toEqual({ name: "Novo", doc: docWith(1) });
    expect(await refusalOf(await many("POST", `${BASE}/default/rename`, { name: "x" }))).toEqual([400, "canvas_default_protected"]);
    expect(await refusalOf(await many("POST", `${BASE}/velho/rename`, { name: "" }))).toEqual([400, "canvas_invalid_name"]);
    expect(await refusalOf(await many("POST", `${BASE}/nada/rename`, { name: "x" }))).toEqual([404, "canvas_not_found"]);
  });

  test("apagar remove o arquivo; apagar de novo é 404; o padrão não se apaga", async () => {
    const { many, create, file, D } = fresh();
    await create("Some");
    writeFileSync(join(D, "canvas.json"), JSON.stringify(docWith(0)));
    expect([(await many("POST", `${BASE}/some/delete`)).status, existsSync(file("some"))]).toEqual([200, false]);
    expect(await refusalOf(await many("POST", `${BASE}/some/delete`))).toEqual([404, "canvas_not_found"]);
    expect(await refusalOf(await many("POST", `${BASE}/default/delete`))).toEqual([400, "canvas_default_protected"]);
    expect(existsSync(join(D, "canvas.json"))).toBe(true);
  });

  test("arquivo de canvas ilegível: ler e gravar são 500 canvas_unreadable sem caminho e o arquivo fica; a lista não cai", async () => {
    const { many, read, create, file, D } = fresh();
    await create("Quebrado");
    writeFileSync(file("quebrado"), "lixo");
    for (const res of [await read(`${BASE}/quebrado`), await many("PUT", `${BASE}/quebrado`, docWith(0))]) {
      const out = await json(res);
      expect([res.status, out.code]).toEqual([500, CANVAS_ERRORS.unreadable]);
      expect(JSON.stringify(out)).not.toContain(D);
    }
    expect(readFileSync(file("quebrado"), "utf8")).toBe("lixo");
    writeFileSync(file("quebrado"), JSON.stringify({ name: "", doc: emptyCanvasDoc() }));
    expect((await read(`${BASE}/quebrado`)).status).toBe(500);
    await create("Bom");
    const list = (await json(await read(BASE))) as { canvases: Dict[] };
    expect(list.canvases.map((c) => [c.id, c.unreadable ?? false])).toEqual([["default", false], ["bom", false], ["quebrado", true]]);
  });

  test("arquivos soltos na pasta (nome fora da lista, temporário) não aparecem como canvas", async () => {
    const { create, read, D } = fresh();
    await create("Ok");
    writeFileSync(join(D, "canvases", "Fora.json"), "{}");
    writeFileSync(join(D, "canvases", "ok.json.tmp"), "{}");
    writeFileSync(join(D, "canvases", "x y.json"), "{}");
    expect(((await json(await read(BASE))) as { canvases: Dict[] }).canvases.map((c) => c.id)).toEqual(["default", "ok"]);
  });

  test("exportar devolve o arquivo de exportação com a data injetada; importar de volta com id novo cria outro canvas", async () => {
    const { many, create, read, D } = fresh();
    await create("Origem");
    await many("PUT", `${BASE}/origem`, docWith(0, [note("n1")]));
    const exported = await json(await read(`${BASE}/origem/export`));
    expect(exported).toEqual({ format: "hades-canvas", exportVersion: 1, name: "Origem", exportedAt: "2026-11-02T12:00:00.000Z", doc: docWith(1) });
    const back = await many("POST", `${BASE}/import`, JSON.stringify(exported));
    expect([back.status, await json(back)]).toEqual([201, { id: "origem-2", name: "Origem", rev: 0, replaced: false }]);
    expect(JSON.parse(readFileSync(join(D, "canvases", "origem-2.json"), "utf8"))).toEqual({ name: "Origem", doc: docWith(0) });
    expect(await json(await read(`${BASE}/origem`))).toEqual(docWith(1));
  });

  test("exportar o padrão sem arquivo dá o documento vazio com o nome padrão", async () => {
    const { read } = fresh();
    expect(await json(await read(`${BASE}/default/export`))).toMatchObject({ name: "Padrão", doc: emptyCanvasDoc() });
  });

  const exportText = (over: Dict = {}): string => JSON.stringify({ format: "hades-canvas", exportVersion: 1, name: "Importado", exportedAt: NOW.toISOString(), doc: docWith(0, [note("i1")]), ...over });

  test("importar com id que já existe é 409 canvas_exists e não muda nada; com overwrite=true substitui e a rev segue", async () => {
    const { many, create, file } = fresh();
    await create("Alvo");
    await many("PUT", `${BASE}/alvo`, docWith(0, [note("velho")]));
    const before = readFileSync(file("alvo"), "utf8");
    expect(await refusalOf(await many("POST", `${BASE}/import`, exportText(), { id: "alvo" }))).toEqual([409, "canvas_exists"]);
    expect(await refusalOf(await many("POST", `${BASE}/import`, exportText(), { id: "alvo", overwrite: "sim" }))).toEqual([409, "canvas_exists"]);
    expect(readFileSync(file("alvo"), "utf8")).toBe(before);
    const over = await many("POST", `${BASE}/import`, exportText(), { id: "alvo", overwrite: "true" });
    expect([over.status, await json(over)]).toEqual([200, { id: "alvo", name: "Importado", rev: 2, replaced: true }]);
    expect(JSON.parse(readFileSync(file("alvo"), "utf8"))).toEqual({ name: "Importado", doc: docWith(2, [note("i1")]) });
  });

  test("importar com id livre cria nele; sobrescrever o padrão exige a confirmação e mantém o nome padrão", async () => {
    const { many, read, D } = fresh();
    const created = await many("POST", `${BASE}/import`, exportText(), { id: "livre" });
    expect([created.status, (await json(created)).id]).toEqual([201, "livre"]);
    writeFileSync(join(D, "canvas.json"), JSON.stringify(docWith(3, [note("meu")])));
    expect(await refusalOf(await many("POST", `${BASE}/import`, exportText(), { id: "default" }))).toEqual([409, "canvas_exists"]);
    expect(JSON.parse(readFileSync(join(D, "canvas.json"), "utf8"))).toEqual(docWith(3, [note("meu")]));
    const over = await many("POST", `${BASE}/import`, exportText(), { id: "default", overwrite: "true" });
    expect(await json(over)).toEqual({ id: "default", name: "Padrão", rev: 4, replaced: true });
    expect(await json(await read(`${BASE}/default`))).toEqual(docWith(4, [note("i1")]));
  });

  const bad: [string, string, string][] = [
    ["JSON quebrado", "{nope", CANVAS_ERRORS.invalidJson],
    ["não é exportação", JSON.stringify(docWith(0)), "canvas_export_invalid_format"],
    ["versão da exportação nova", exportText({ exportVersion: 7 }), "canvas_export_unsupported_version"],
    ["documento com nó inválido", exportText({ doc: docWith(0, [note("n", { w: 0 })]) }), CANVAS_ERRORS.invalidNode],
    ["documento de versão desconhecida", exportText({ doc: { ...docWith(0), v: 9 } }), CANVAS_ERRORS.unsupportedVersion],
    ["nome inválido", exportText({ name: "" }), "canvas_invalid_name"],
  ];
  test.each(bad)("importar inválido (%s) é 400 com o código e o motivo, e nada é gravado", async (_, text, code) => {
    const { many, D } = fresh();
    const res = await many("POST", `${BASE}/import`, text);
    const out = await json(res);
    expect([res.status, out.code]).toEqual([400, code]);
    expect(typeof out.reason).toBe("string");
    expect(JSON.stringify(out)).not.toContain(D);
    expect(existsSync(join(D, "canvases"))).toBe(false);
  });

  test("importar com id de caminho (..) é recusado antes de gravar", async () => {
    const { many, D } = fresh();
    expect(await refusalOf(await many("POST", `${BASE}/import`, exportText(), { id: "../x" }))).toEqual([400, "canvas_invalid_id"]);
    expect(readdirSync(D)).toEqual([]);
  });

  test("importar acima do teto de bytes é 400 canvas_too_large", async () => {
    const { many } = fresh();
    const big = new Uint8Array(CANVAS_LIMITS.bodyBytes + 6000).fill(32);
    expect(await refusalOf(await many("POST", `${BASE}/import`, big as unknown as string))).toEqual([400, CANVAS_ERRORS.tooLarge]);
  });

  test("importar nó vivo com conteúdo grava só a posição", async () => {
    const { many, read } = fresh();
    const live = note("agent:p:a1", { type: "agent", data: { segredo: "x" } });
    const res = await many("POST", `${BASE}/import`, exportText({ doc: docWith(0, [live]) }), { id: "vivo" });
    expect(res.status).toBe(201);
    expect(((await json(await read(`${BASE}/vivo`))) as { nodes: Dict[] }).nodes[0]?.data).toEqual({});
  });

  test("caminhos e métodos que não são desta família: undefined ou 404", async () => {
    const { routes, many } = fresh();
    expect(routes.getMany("/api/canvas")).toBeUndefined();
    expect(routes.getMany("/api/canvasesx")).toBeUndefined();
    expect(routes.writeMany("POST", "/api/outra", {}, asReq("POST", "/api/outra"), caller)).toBeUndefined();
    expect((await many("POST", `${BASE}/a/b/c`, {})).status).toBe(404);
    expect((await many("POST", `${BASE}/mapa/explodir`, {})).status).toBe(404);
    expect(routes.getMany(`${BASE}/mapa/outra`)?.status).toBe(404);
  });
});

describe("canvas-route: vários canvases pelo painel real (acesso e token)", () => {
  const r = new Rig().setup();
  let D = "";
  let P: Awaited<ReturnType<typeof startTestPanel>>;
  beforeAll(async () => {
    D = widgetData(r, "canvas-many").D;
    P = await startTestPanel(D);
  });
  afterAll(() => {
    P?.stop();
    r.cleanup();
  });
  const authed = (): Record<string, string> => ({ ...JSON_CT, "x-panel-token": P.token });

  test("local: criar, gravar, listar, exportar, importar, renomear e apagar pelas rotas", async () => {
    const created = await fetchRaw(P.base, BASE, authed(), { name: "Painel" }, "POST");
    expect([created.status, created.json]).toEqual([201, { id: "painel", name: "Painel", rev: 0 }]);
    expect((await fetchRaw(P.base, `${BASE}/painel`, authed(), docWith(0), "PUT")).json).toEqual({ v: 1, ok: true, rev: 1 });
    expect((await fetchRaw(P.base, BASE)).json).toMatchObject({ canvases: [{ id: "default" }, { id: "painel", rev: 1, nodes: 1 }] });
    const exported = await fetchRaw(P.base, `${BASE}/painel/export`);
    expect(exported.json).toMatchObject({ format: "hades-canvas", name: "Painel", doc: docWith(1) });
    const imported = await fetchRaw(P.base, `${BASE}/import`, authed(), exported.json, "POST");
    expect([imported.status, imported.json?.id]).toEqual([201, "painel-2"]);
    expect((await fetchRaw(P.base, `${BASE}/painel-2/rename`, authed(), { name: "Cópia" }, "POST")).status).toBe(200);
    expect((await fetchRaw(P.base, `${BASE}/painel-2/delete`, authed(), {}, "POST")).status).toBe(200);
    expect((await fetchRaw(P.base, `${BASE}/painel-2`)).status).toBe(404);
  });

  test("o canvas padrão continua em /api/canvas e em canvas.json", async () => {
    const put = await fetchRaw(P.base, "/api/canvas", authed(), docWith(0), "PUT");
    expect(put.json?.rev).toBe(1);
    expect(JSON.parse(readFileSync(join(D, "canvas.json"), "utf8"))).toEqual(docWith(1));
    expect((await fetchRaw(P.base, `${BASE}/default`)).json).toEqual(docWith(1));
  });

  test("escrita sem o token da sessão, sem JSON ou com Origin fora da lista é 403, e nada muda", async () => {
    const before = readdirSync(join(D, "canvases")).sort();
    expect((await fetchRaw(P.base, BASE, JSON_CT, { name: "x" }, "POST")).status).toBe(403);
    expect((await fetchRaw(P.base, `${BASE}/painel`, JSON_CT, docWith(1), "PUT")).status).toBe(403);
    expect((await fetchRaw(P.base, `${BASE}/painel/delete`, JSON_CT, {}, "POST")).status).toBe(403);
    expect((await fetchRaw(P.base, BASE, { ...authed(), Origin: "https://evil.example.invalid" }, { name: "x" }, "POST")).status).toBe(403);
    expect(readdirSync(join(D, "canvases")).sort()).toEqual(before);
  });

  test("pelo túnel: sem a chave é 401 (leitura e escrita); com a chave a escrita ainda exige o token", async () => {
    const anon = remoteHeaders(D, false);
    expect((await fetchRaw(P.base, BASE, anon)).status).toBe(401);
    expect((await fetchRaw(P.base, BASE, { ...anon, ...authed() }, { name: "x" }, "POST")).status).toBe(401);
    const keyed = remoteHeaders(D, true);
    expect((await fetchRaw(P.base, BASE, keyed)).status).toBe(200);
    expect((await fetchRaw(P.base, BASE, { ...keyed, ...JSON_CT }, { name: "x" }, "POST")).status).toBe(403);
    expect((await fetchRaw(P.base, BASE, { ...keyed, ...authed() }, { name: "Remoto" }, "POST")).status).toBe(201);
  });
});

const emptyDoc = (): Dict => ({ ...emptyCanvasDoc() });

describe("canvas-route: canvas por worktree ou rodada (em processo)", () => {
  let n = 0;
  const fresh = () => {
    const D = join(T, `s${n++}`);
    mkdirSync(D, { recursive: true });
    const routes = createCanvasRoutes(D, () => NOW);
    const many = async (method: "POST" | "PUT", path: string, body?: unknown, query: Record<string, string> = {}): Promise<Response> =>
      routes.writeMany(method, path, query, asReq(method, path, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)), caller) ?? new Response(null, { status: 599 });
    const read = async (path: string): Promise<Response> => routes.getMany(path) ?? new Response(null, { status: 599 });
    const open = (kind: string, key: string, extra: Dict = {}): Promise<Response> => many("POST", `${BASE}/_scope`, { kind, key, ...extra });
    return { D, routes, many, read, open, file: (id: string) => join(D, "canvases", `${id}.json`) };
  };
  const codeOf = async (res: Response): Promise<[number, unknown]> => [res.status, (await json(res)).code];
  const wtId = scopedCanvasId({ kind: "worktree", key: "p-org" });

  test("dado worktree sem canvas, então abrir cria vazio (201) com o id derivado e o nome padrão", async () => {
    const { open, file, read } = fresh();
    const res = await open("worktree", "p-org");
    expect([res.status, await json(res)]).toEqual([201, { id: wtId, name: "Worktree: p-org", rev: 0, scope: { kind: "worktree", key: "p-org" }, created: true }]);
    expect(JSON.parse(readFileSync(file(wtId), "utf8"))).toEqual({ name: "Worktree: p-org", doc: emptyDoc(), scope: { kind: "worktree", key: "p-org" } });
    expect(await json(await read(`${BASE}/${wtId}`))).toEqual(emptyDoc());
  });

  test("dado a mesma chave de novo, então devolve o mesmo canvas (200, created false) sem tocar no arquivo", async () => {
    const { open, many, file } = fresh();
    await open("worktree", "p-org");
    await many("PUT", `${BASE}/${wtId}`, docWith(0));
    const before = readFileSync(file(wtId), "utf8");
    const again = await open("worktree", "  p-org ");
    expect([again.status, await json(again)]).toMatchObject([200, { id: wtId, rev: 1, created: false }]);
    expect(readFileSync(file(wtId), "utf8")).toBe(before);
  });

  test("dado nome no corpo, então o canvas nasce com ele; nome inválido é recusado antes de gravar", async () => {
    const { open, D } = fresh();
    expect(((await json(await open("round", "p4", { name: "Rodada quatro" }))) as Dict).name).toBe("Rodada quatro");
    expect(await codeOf(await open("round", "p5", { name: "" }))).toEqual([400, "canvas_invalid_name"]);
    expect(readdirSync(join(D, "canvases"))).toHaveLength(1);
  });

  test("dado worktree e rodada com a mesma chave, então são canvases diferentes", async () => {
    const { open, read } = fresh();
    const a = (await json(await open("worktree", "p4"))) as Dict;
    const b = (await json(await open("round", "p4"))) as Dict;
    expect(a.id).not.toBe(b.id);
    const ids = ((await json(await read(BASE))) as { canvases: Dict[] }).canvases.map((c) => c.id);
    expect(ids[0]).toBe("default");
    expect(ids.slice(1)).toEqual([b.id, a.id]);
  });

  test("dado a lista, então o canvas de escopo traz scope e o criado à mão não", async () => {
    const { open, many, read } = fresh();
    await open("round", "p4");
    await many("POST", BASE, { name: "Manual" });
    const list = ((await json(await read(BASE))) as { canvases: Dict[] }).canvases;
    expect(list.find((c) => c.id === "manual")).not.toHaveProperty("scope");
    expect(list.find((c) => String(c.id).startsWith("rd-"))).toMatchObject({ scope: { kind: "round", key: "p4" } });
  });

  test("dado gravar, renomear, exportar, apagar e abrir de novo, então o escopo sobrevive ao ciclo e o canvas volta vazio", async () => {
    const { open, many, read, file } = fresh();
    await open("worktree", "p-org");
    await many("PUT", `${BASE}/${wtId}`, docWith(0));
    await many("POST", `${BASE}/${wtId}/rename`, { name: "Minha worktree" });
    const stored = JSON.parse(readFileSync(file(wtId), "utf8")) as Dict;
    expect([stored.name, stored.scope, (stored.doc as Dict).rev]).toEqual(["Minha worktree", { kind: "worktree", key: "p-org" }, 1]);
    const exported = (await json(await read(`${BASE}/${wtId}/export`))) as Dict;
    expect(exported).not.toHaveProperty("scope");
    await many("POST", `${BASE}/import`, exported, { id: wtId, overwrite: "true" });
    expect(((JSON.parse(readFileSync(file(wtId), "utf8")) as Dict).scope)).toEqual({ kind: "worktree", key: "p-org" });
    expect((await many("POST", `${BASE}/${wtId}/delete`, {})).status).toBe(200);
    const reopened = await open("worktree", "p-org");
    expect([reopened.status, ((await json(reopened)) as Dict).rev]).toEqual([201, 0]);
  });

  test.each([
    ["tipo desconhecido", { kind: "repo", key: "x" }],
    ["sem tipo", { key: "x" }],
    ["chave vazia", { kind: "worktree", key: "" }],
    ["chave de caminho com controle", { kind: "worktree", key: "a\u0000b" }],
    ["chave acima do limite", { kind: "worktree", key: "x".repeat(CANVAS_STORE_LIMITS.scopeKeyChars + 1) }],
  ])("dado escopo inválido (%s), então 400 canvas_invalid_scope e nada é gravado", async (_, body) => {
    const { many, D } = fresh();
    expect(await codeOf(await many("POST", `${BASE}/_scope`, body))).toEqual([400, "canvas_invalid_scope"]);
    expect(existsSync(join(D, "canvases"))).toBe(false);
  });

  test("dado corpo que não é JSON objeto ou grande demais, então 400 canvas_invalid_shape", async () => {
    const { many } = fresh();
    for (const body of ["{nope", "[]", "x".repeat(5000)]) expect(await codeOf(await many("POST", `${BASE}/_scope`, body))).toEqual([400, CANVAS_ERRORS.invalidShape]);
  });

  test("dado chave de caminho (../../x), então o arquivo fica dentro de canvases/ e a resposta não traz o caminho", async () => {
    const { open, D } = fresh();
    const res = await open("worktree", "../../etc/passwd");
    const out = await json(res);
    expect(res.status).toBe(201);
    expect(JSON.stringify(out)).not.toContain(D);
    expect(readdirSync(join(D, "canvases"))).toEqual([`${out.id}.json`]);
    expect(readdirSync(D)).toEqual(["canvases"]);
  });

  test("dado arquivo no id do escopo que não é do escopo (sem escopo, ou de outra chave), então 409 canvas_exists e o arquivo não muda", async () => {
    const { open, many, file, D } = fresh();
    await many("POST", `${BASE}/import`, JSON.stringify({ format: "hades-canvas", exportVersion: 1, name: "À mão", exportedAt: NOW.toISOString(), doc: docWith(0) }), { id: wtId });
    const before = readFileSync(file(wtId), "utf8");
    expect(await codeOf(await open("worktree", "p-org"))).toEqual([409, "canvas_exists"]);
    expect(readFileSync(file(wtId), "utf8")).toBe(before);
    // copiado à mão para outro id: o escopo gravado não bate com o id do arquivo → ilegível, nunca o canvas de outra worktree
    const other = scopedCanvasId({ kind: "worktree", key: "outra" });
    writeFileSync(join(D, "canvases", `${other}.json`), JSON.stringify({ name: "x", doc: docWith(0), scope: { kind: "worktree", key: "p-org" } }));
    expect(await codeOf(await open("worktree", "outra"))).toEqual([500, CANVAS_ERRORS.unreadable]);
  });

  test("dado o teto de canvases, então abrir um novo é 409 canvas_limit_reached, mas o que já existe ainda abre", async () => {
    const { open, many, D } = fresh();
    await open("round", "existente");
    mkdirSync(join(D, "canvases"), { recursive: true });
    const ids = readdirSync(join(D, "canvases")).length;
    for (let i = ids; i < CANVAS_STORE_LIMITS.canvases; i += 1) writeFileSync(join(D, "canvases", `c${i}.json`), JSON.stringify({ name: `c${i}`, doc: emptyDoc() }));
    expect(await codeOf(await open("round", "novo"))).toEqual([409, "canvas_limit_reached"]);
    expect((await open("round", "existente")).status).toBe(200);
    expect(await codeOf(await many("POST", BASE, { name: "mais um" }))).toEqual([409, "canvas_limit_reached"]);
  });

  test("dado o canvas padrão e os criados de antes, então seguem como eram (aditivo)", async () => {
    const { open, read, routes } = fresh();
    await open("round", "p4");
    expect(await json(routes.get())).toEqual(emptyDoc());
    expect(((await json(await read(BASE))) as Dict).default).toBe("default");
  });

  test("dado GET em /_scope ou id inválido na família, então não vira canvas", async () => {
    const { read } = fresh();
    expect((await read(`${BASE}/_scope`)).status).toBe(400);
  });
});

describe("canvas-route: filtros salvos (em processo)", () => {
  let n = 0;
  const fresh = () => {
    const D = join(T, `f${n++}`);
    mkdirSync(D, { recursive: true });
    const routes = createCanvasRoutes(D, () => NOW);
    const put = async (body: unknown): Promise<Response> =>
      routes.writeMany("PUT", `${BASE}/_filters`, {}, asReq("PUT", `${BASE}/_filters`, typeof body === "string" ? body : JSON.stringify(body)), caller) ?? new Response(null, { status: 599 });
    const get = async (): Promise<Response> => routes.getMany(`${BASE}/_filters`) ?? new Response(null, { status: 599 });
    return { D, routes, put, get, file: join(D, "canvas-filters.json") };
  };
  const set = (rev: number, over: Dict = {}): Dict => ({ v: 1, rev, defaultId: null, filters: [{ id: "a", name: "A", selection: { state: ["working"] } }], ...over });
  const codeOf = async (res: Response): Promise<[number, unknown]> => [res.status, (await json(res)).code];

  test("dado instância sem arquivo, então GET devolve o conjunto vazio e não grava nada", async () => {
    const { D, get } = fresh();
    const res = await get();
    expect([res.status, await json(res)]).toEqual([200, { ...emptySavedFilters() }]);
    expect(readdirSync(D)).toEqual([]);
  });

  test("dado PUT válido, então grava canvas-filters.json com rev+1, sem temporário, e o GET devolve o gravado", async () => {
    const { D, put, get, file } = fresh();
    const res = await put(set(0, { defaultId: "a" }));
    expect([res.status, await json(res)]).toEqual([200, { v: 1, ok: true, rev: 1 }]);
    expect(readdirSync(D)).toEqual(["canvas-filters.json"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(set(1, { defaultId: "a" }));
    expect(await json(await get())).toEqual(set(1, { defaultId: "a" }));
  });

  test("dado rev velha ou adiantada, então 409 saved_filters_stale_revision com a rev atual e nada muda", async () => {
    const { put, file } = fresh();
    await put(set(0));
    const before = readFileSync(file, "utf8");
    const stale = await put(set(0, { filters: [] }));
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ code: "saved_filters_stale_revision", rev: 1 });
    expect((await put(set(9))).status).toBe(409);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("dado dois PUT simultâneos com a mesma rev, então um grava e o outro leva 409", async () => {
    const { put } = fresh();
    const [a, b] = await Promise.all([put(set(0)), put(set(0, { filters: [] }))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  test.each([
    ["JSON quebrado", "{nope", "canvas_invalid_json"],
    ["corpo vazio", "", "canvas_invalid_json"],
    ["raiz que é lista", "[]", "saved_filters_invalid_shape"],
    ["versão nova", JSON.stringify(set(0, { v: 2 })), "saved_filters_unsupported_version"],
    ["seleção com dimensão desconhecida", JSON.stringify(set(0, { filters: [{ id: "a", name: "A", selection: { x: ["1"] } }] })), "saved_filters_invalid_selection"],
    ["padrão que não existe", JSON.stringify(set(0, { defaultId: "z" })), "saved_filters_not_found"],
    ["nome repetido", JSON.stringify(set(0, { filters: [{ id: "a", name: "A", selection: {} }, { id: "b", name: "a", selection: {} }] })), "saved_filters_duplicate_name"],
    ["filtros acima do teto", JSON.stringify(set(0, { defaultId: null, filters: Array.from({ length: SAVED_FILTER_LIMITS.filters + 1 }, (_, i) => ({ id: `f${i}`, name: `f${i}`, selection: {} })) })), "saved_filters_limit_reached"],
  ])("dado PUT inválido (%s), então 400 com o código estável, sem detalhe de caminho, e nada é gravado", async (_, body, code) => {
    const { D, put } = fresh();
    const res = await put(body);
    const out = await json(res);
    expect([res.status, out.code]).toEqual([400, code]);
    expect(JSON.stringify(out)).not.toContain(D);
    expect(existsSync(join(D, "canvas-filters.json"))).toBe(false);
  });

  test("dado corpo acima do teto, então 400 canvas_too_large", async () => {
    const { put } = fresh();
    expect(await codeOf(await put("x".repeat(64 * 1024 + 1)))).toEqual([400, CANVAS_ERRORS.tooLarge]);
  });

  test("dado arquivo ilegível, então GET e PUT respondem 500 saved_filters_unreadable e o arquivo não é apagado", async () => {
    const { put, get, file } = fresh();
    writeFileSync(file, "{corrompido");
    expect(await codeOf(await get())).toEqual([500, "saved_filters_unreadable"]);
    expect(await codeOf(await put(set(0)))).toEqual([500, "saved_filters_unreadable"]);
    expect(readFileSync(file, "utf8")).toBe("{corrompido");
  });

  test("dado o conjunto de filtros, então não aparece como canvas na lista nem atrapalha os canvases", async () => {
    const { put, routes } = fresh();
    await put(set(0));
    const list = (await json(routes.getMany(BASE) as Response)) as { canvases: Dict[] };
    expect(list.canvases.map((c) => c.id)).toEqual(["default"]);
  });

  test("dado outro método ou caminho sob _filters, então é recusado como id inválido e nada muda", async () => {
    const { routes, D } = fresh();
    expect(routes.getMany(`${BASE}/_filters/x`)?.status).toBe(400);
    expect((await routes.writeMany("POST", `${BASE}/_filters`, {}, asReq("POST", `${BASE}/_filters`, "{}"), caller))?.status).toBe(400);
    expect(readdirSync(D)).toEqual([]);
  });
});

describe("canvas-route: escopo e filtros salvos pelo painel real (acesso e token)", () => {
  const r = new Rig().setup();
  let D = "";
  let P: Awaited<ReturnType<typeof startTestPanel>>;
  beforeAll(async () => {
    D = widgetData(r, "canvas-scope").D;
    P = await startTestPanel(D);
  });
  afterAll(() => {
    P?.stop();
    r.cleanup();
  });
  const authed = (): Record<string, string> => ({ ...JSON_CT, "x-panel-token": P.token });
  const filters = (rev: number): Dict => ({ v: 1, rev, defaultId: null, filters: [{ id: "a", name: "A", selection: { state: ["working"] } }] });

  test("local: abrir por escopo e gravar os filtros salvos pelas rotas", async () => {
    const opened = await fetchRaw(P.base, `${BASE}/_scope`, authed(), { kind: "worktree", key: "p-org" }, "POST");
    expect([opened.status, opened.json?.id]).toEqual([201, scopedCanvasId({ kind: "worktree", key: "p-org" })]);
    expect((await fetchRaw(P.base, `${BASE}/_scope`, authed(), { kind: "worktree", key: "p-org" }, "POST")).status).toBe(200);
    expect((await fetchRaw(P.base, `${BASE}/_filters`)).json).toEqual({ ...emptySavedFilters() });
    expect((await fetchRaw(P.base, `${BASE}/_filters`, authed(), filters(0), "PUT")).json).toEqual({ v: 1, ok: true, rev: 1 });
    expect(JSON.parse(readFileSync(join(D, "canvas-filters.json"), "utf8"))).toEqual(filters(1));
  });

  test("escrita sem o token da sessão ou com Origin fora da lista é 403, e nada muda", async () => {
    const before = readFileSync(join(D, "canvas-filters.json"), "utf8");
    expect((await fetchRaw(P.base, `${BASE}/_filters`, JSON_CT, filters(1), "PUT")).status).toBe(403);
    expect((await fetchRaw(P.base, `${BASE}/_filters`, { ...authed(), Origin: "https://evil.example.invalid" }, filters(1), "PUT")).status).toBe(403);
    expect((await fetchRaw(P.base, `${BASE}/_scope`, JSON_CT, { kind: "round", key: "x" }, "POST")).status).toBe(403);
    expect(readFileSync(join(D, "canvas-filters.json"), "utf8")).toBe(before);
    expect(readdirSync(join(D, "canvases"))).toHaveLength(1);
  });

  test("pelo túnel: sem a chave é 401 (leitura e escrita); com a chave a escrita ainda exige o token", async () => {
    const anon = remoteHeaders(D, false);
    expect((await fetchRaw(P.base, `${BASE}/_filters`, anon)).status).toBe(401);
    expect((await fetchRaw(P.base, `${BASE}/_scope`, { ...anon, ...authed() }, { kind: "round", key: "x" }, "POST")).status).toBe(401);
    const keyed = remoteHeaders(D, true);
    expect((await fetchRaw(P.base, `${BASE}/_filters`, keyed)).status).toBe(200);
    expect((await fetchRaw(P.base, `${BASE}/_filters`, { ...keyed, ...JSON_CT }, filters(1), "PUT")).status).toBe(403);
    expect((await fetchRaw(P.base, `${BASE}/_filters`, { ...keyed, ...authed() }, filters(1), "PUT")).status).toBe(200);
  });
});
