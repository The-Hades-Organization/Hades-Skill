// Grupo canvas-cardinal-route: rotas do nó `cardinal` (src/lib/canvas-cardinal.ts, src/panel/canvas-cardinal.ts,
// src/panel/cardinal-watch.ts) — arquivo `.cardinal` em `$D/canvas-cardinal/` ou adotado, revisão por hash e 409, gravação atômica
// 0600, raízes permitidas, sem link simbólico, só local para `link` e `as`, envelope, teto, e o vigia com aviso pelo SSE.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CanvasDoc, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import {
  CARDINAL_ERRORS, CARDINAL_FORMAT_MAX, CARDINAL_LIMITS, CardinalError, canReadCardinal, canWriteCardinal, cardinalChainFrom, directCardinalsOf, readableCardinalsOf,
  readCardinalData, readEnvelope,
} from "../../../src/lib/canvas-cardinal";
import { OWNER } from "../../../src/lib/canvas-note";
import { CARDINAL_BODY_BYTES, CARDINAL_ROUTE_ERRORS, createCanvasCardinalRoutes, revisionOf } from "../../../src/panel/canvas-cardinal";
import { createCardinalWatch } from "../../../src/panel/cardinal-watch";
import { createCanvasHub } from "../../../src/panel/canvas-stream";

type Dict = Record<string, unknown>;

const AGENT = "agent:proj:impl-1";
const OTHER = "agent:proj:impl-2";
const node = (id: string, type: string, data: Dict): Dict => ({ id, type, x: 0, y: 0, w: 320, h: 220, z: 0, data, locked: false, blurred: false });
const docWith = (nodes: Dict[]): CanvasDoc => validateCanvasDoc({ v: 1, rev: 0, nodes, edges: [], groups: [] });
const DOC = docWith([
  node("c1", "cardinal", { cardinal: "pagamentos", title: "Pagamentos", agent: AGENT }),
  node("c2", "cardinal", { cardinal: "estoque" }),
  node("n1", "note", { note: "nota-a" }),
  node("t1", "terminal", {}),
]);

const sample = (version = CARDINAL_FORMAT_MAX, models = 2): string =>
  JSON.stringify({ format: "cardinal", version, app: "Cardinal 0.1.0", project: { models: Array.from({ length: models }, () => ({ diagram: {} })) } }, null, 2) + "\n";

const T = mkdtempSync(join(tmpdir(), "hades-cardinal-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const BASE = "/api/canvas-cardinal/";
const req = (path: string, body: unknown, method = "PUT"): Request =>
  new Request(`http://127.0.0.1${path}`, { method, headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const local = { remote: false };
const remote = { remote: true };
const json = async (res: Response): Promise<Dict> => (await res.json()) as Dict;

let n = 0;
function fresh(docs: Record<string, CanvasDoc> = { default: DOC }, extra: { roots?: string[]; onWrite?: (name: string, rev: string) => void } = {}) {
  const D = join(T, `d${n++}`);
  mkdirSync(D, { recursive: true });
  const routes = createCanvasCardinalRoutes(D, { loadDoc: async (id) => docs[id], token: () => "abc123def", ...extra });
  const dir = join(D, "canvas-cardinal");
  return {
    D, routes, dir, file: (name: string) => join(dir, `${name}.cardinal`),
    put: (canvas: string, nodeId: string, body: unknown, caller = local) => routes.write(`${BASE}${canvas}/${nodeId}`, req(`${BASE}${canvas}/${nodeId}`, body), caller) as Promise<Response>,
    get: (canvas: string, nodeId?: string, query: Record<string, string> = {}, caller = local) =>
      routes.get(`${BASE}${canvas}${nodeId ? `/${nodeId}` : ""}`, query, caller) as Promise<Response>,
    link: (body: unknown, caller = local) => routes.action(`${BASE}link`, req(`${BASE}link`, body, "POST"), caller) as Promise<Response>,
  };
}

describe("canvas-cardinal (lib): dados, envelope e acesso", () => {
  test("data do nó: só cardinal, title e agent; nome de lista fechada", () => {
    expect(readCardinalData({ cardinal: "a-b_1", title: "T", agent: AGENT })).toEqual({ cardinal: "a-b_1", title: "T", agent: AGENT });
    for (const bad of [null, [], { cardinal: "../x" }, { cardinal: "a.b" }, { cardinal: "" }, { cardinal: "a", extra: 1 }, { cardinal: "a", title: "" }, { cardinal: "a", agent: "pr:1" }]) {
      expect(() => readCardinalData(bad)).toThrow(CardinalError);
    }
    expect(() => readCardinalData({ cardinal: "x".repeat(CARDINAL_LIMITS.nameChars + 1) })).toThrow(CardinalError);
  });

  test("envelope: lê format, version, app e a contagem de modelos; versão futura volta com supported false", () => {
    expect(readEnvelope(sample())).toEqual({ format: "cardinal", version: CARDINAL_FORMAT_MAX, app: "Cardinal 0.1.0", diagrams: 2, supported: true });
    expect(readEnvelope(sample(CARDINAL_FORMAT_MAX + 1)).supported).toBe(false);
    for (const bad of ["nao json", "[]", '{"format":"x","version":2}', '{"format":"cardinal"}', '{"format":"cardinal","version":0}', '{"format":"cardinal","version":1.5}']) {
      expect(() => readEnvelope(bad)).toThrow(expect.objectContaining({ code: CARDINAL_ERRORS.invalidEnvelope }));
    }
  });

  test("acesso por data.agent: dono sempre; agente só no ligado; nó inexistente ou de outro tipo, ninguém", () => {
    expect(canWriteCardinal(DOC, "c1", OWNER)).toBe(true);
    expect(canWriteCardinal(DOC, "c1", { kind: "agent", id: AGENT })).toBe(true);
    expect(canWriteCardinal(DOC, "c1", { kind: "agent", id: OTHER })).toBe(false);
    const withAgent = docWith([node("c1", "cardinal", { cardinal: "p", agent: "t1" }), node("t1", "terminal", {}), node("t2", "terminal", {})]);
    expect(canWriteCardinal(withAgent, "c1", { kind: "agent", id: "t1" })).toBe(true);
    expect(canWriteCardinal(withAgent, "c1", { kind: "agent", id: "t2" })).toBe(false);
    expect(canReadCardinal(withAgent, "c1", undefined)).toBe(true);
    expect(canReadCardinal(withAgent, "c1", "t2")).toBe(false);
    expect(canWriteCardinal(DOC, "n1", OWNER)).toBe(false);
    expect(canWriteCardinal(DOC, "nada", OWNER)).toBe(false);
  });
});

describe("canvas-cardinal (lib): acesso por conexão", () => {
  const edge = (id: string, from: string, to: string): Dict => ({ id, from, to, kind: "link" });
  const linked = (edges: Dict[]): CanvasDoc =>
    validateCanvasDoc({
      v: 1, rev: 0, groups: [], edges,
      nodes: [node("agent:p:a1", "agent", {}), node("agent:p:a2", "agent", {}), node("c1", "cardinal", { cardinal: "um" }), node("c2", "cardinal", { cardinal: "dois" }),
        node("c3", "cardinal", { cardinal: "tres" }), node("c4", "cardinal", { cardinal: "quatro", agent: "agent:p:a1" }), node("n1", "note", { note: "x" })],
    });
  const DOC2 = linked([edge("e1", "agent:p:a1", "c1"), edge("e2", "c1", "c2")]);

  test("ligado direto: lê e escreve; ordem das arestas e depois data.agent", () => {
    expect(directCardinalsOf(DOC2, "agent:p:a1")).toEqual(["c1", "c4"]);
    expect(canReadCardinal(DOC2, "c1", "agent:p:a1")).toBe(true);
    expect(canWriteCardinal(DOC2, "c1", { kind: "agent", id: "agent:p:a1" })).toBe(true);
  });

  test("pela cadeia: só lê", () => {
    expect(cardinalChainFrom(DOC2, "c1")).toEqual([{ id: "c1", via: null }, { id: "c2", via: "c1" }]);
    expect(readableCardinalsOf(DOC2, "agent:p:a1").map((e) => e.id)).toEqual(["c1", "c4", "c2"]);
    expect(canReadCardinal(DOC2, "c2", "agent:p:a1")).toBe(true);
    expect(canWriteCardinal(DOC2, "c2", { kind: "agent", id: "agent:p:a1" })).toBe(false);
  });

  test("fora do escopo: outro agente, diagrama solto, nota no meio", () => {
    expect(canReadCardinal(DOC2, "c1", "agent:p:a2")).toBe(false);
    expect(canReadCardinal(DOC2, "c3", "agent:p:a1")).toBe(false);
    expect(directCardinalsOf(DOC2, "n1")).toEqual([]);
    expect(directCardinalsOf(DOC2, "c1")).toEqual([]);
    expect(cardinalChainFrom(DOC2, "n1")).toEqual([]);
  });

  test("dono lê e escreve em qualquer um; laço na cadeia não prende", () => {
    expect(canReadCardinal(DOC2, "c3", undefined)).toBe(true);
    expect(canWriteCardinal(DOC2, "c3", OWNER)).toBe(true);
    const loop = linked([edge("e1", "agent:p:a1", "c1"), edge("e2", "c1", "c2"), edge("e3", "c2", "c1")]);
    expect(cardinalChainFrom(loop, "c1").map((e) => e.id)).toEqual(["c1", "c2"]);
  });
});

describe("canvas-cardinal-route: a rota sobre a pasta de dados", () => {
  test("caminho de outra família não é desta rota", () => {
    const { routes } = fresh();
    expect(routes.get("/api/canvas", {}, local)).toBeUndefined();
    expect(routes.get("/api/canvas-notes/x", {}, local)).toBeUndefined();
    expect(routes.write("/api/canvas", req("/api/canvas", {}), local)).toBeUndefined();
    expect(routes.action("/api/canvases/x", req("/x", {}, "POST"), local)).toBeUndefined();
  });

  test("GET de diagrama sem arquivo é 404 cardinal_not_found e não cria a pasta", async () => {
    const { get, dir } = fresh();
    const res = await get("default", "c2");
    expect([res.status, (await json(res)).code]).toEqual([404, CARDINAL_ROUTE_ERRORS.notFound]);
    expect(() => readdirSync(dir)).toThrow();
  });

  test("PUT com rev null cria o arquivo 0600 sem temporário e o GET devolve texto, rev e a meta do envelope", async () => {
    const { put, get, dir, file } = fresh();
    const text = sample();
    const res = await put("default", "c2", { text, rev: null });
    const saved = await json(res);
    expect([res.status, saved.ok, saved.name, saved.bytes, saved.rev]).toEqual([200, true, "estoque", new TextEncoder().encode(text).length, revisionOf(new TextEncoder().encode(text))]);
    expect(readdirSync(dir)).toEqual(["estoque.cardinal"]);
    expect(statSync(file("estoque")).mode & 0o777).toBe(0o600);
    expect(readFileSync(file("estoque"), "utf8")).toBe(text);
    const read = await json(await get("default", "c2"));
    expect(read).toMatchObject({ name: "estoque", text, rev: saved.rev, format: "cardinal", version: CARDINAL_FORMAT_MAX, app: "Cardinal 0.1.0", diagrams: 2, supported: true, valid: true, location: "default", path: file("estoque") });
  });

  test("409 com duas gravações: a segunda com a revisão velha recebe a atual", async () => {
    const { put } = fresh();
    const first = await json(await put("default", "c2", { text: sample(2, 1), rev: null }));
    const second = await put("default", "c2", { text: sample(2, 2), rev: first.rev });
    expect(second.status).toBe(200);
    const stale = await put("default", "c2", { text: sample(2, 3), rev: first.rev });
    expect([stale.status, (await json(stale)).code, (await json(await put("default", "c2", { text: sample(2, 4), rev: null }))).rev]).toEqual([409, CARDINAL_ROUTE_ERRORS.staleRevision, (await json(second)).rev]);
  });

  test("PUT valida o envelope: não-JSON, formato errado e versão futura são recusados sem gravar", async () => {
    const { put, dir } = fresh();
    for (const [text, code] of [["nao json", CARDINAL_ERRORS.invalidEnvelope], ['{"format":"x","version":2}', CARDINAL_ERRORS.invalidEnvelope], [sample(CARDINAL_FORMAT_MAX + 1), CARDINAL_ERRORS.formatTooNew]] as const) {
      const res = await put("default", "c2", { text, rev: null });
      expect([res.status, (await json(res)).code]).toEqual([400, code]);
    }
    expect(() => readdirSync(dir)).toThrow();
  });

  test("corpo malformado e acima do teto: 400 e 413", async () => {
    const { put, routes } = fresh();
    expect((await put("default", "c2", "{")).status).toBe(400);
    expect((await put("default", "c2", { text: 3, rev: null })).status).toBe(400);
    expect((await put("default", "c2", { text: sample(), rev: 3 })).status).toBe(400);
    const big = await put("default", "c2", { text: "x".repeat(CARDINAL_LIMITS.bodyBytes + 1), rev: null });
    expect([big.status, (await json(big)).code]).toEqual([413, CARDINAL_ROUTE_ERRORS.tooLarge]);
    const huge = routes.write(`${BASE}default/c2`, new Request("http://127.0.0.1/x", { method: "PUT", headers: { "content-length": String(CARDINAL_BODY_BYTES + 1) }, body: "{}" }), local) as Promise<Response>;
    expect((await huge).status).toBe(413);
  });

  test("onWrite recebe nome e revisão da gravação", async () => {
    const seen: [string, string][] = [];
    const { put } = fresh(undefined, { onWrite: (name, rev) => seen.push([name, rev]) });
    const res = await json(await put("default", "c2", { text: sample(), rev: null }));
    expect(seen).toEqual([["estoque", res.rev as string]]);
  });

  test("nó que não existe, de outro tipo, canvas inválido ou inexistente: 404", async () => {
    const { put, get } = fresh();
    for (const [canvas, id] of [["default", "nada"], ["default", "n1"], ["..", "c1"], ["outro", "c1"]] as const) {
      expect((await put(canvas, id, { text: sample(), rev: null })).status).toBe(404);
      expect((await get(canvas, id)).status).toBe(404);
    }
  });

  test("agente (as) só local; ligado por data.agent lê e grava; outro agente e fora do escopo recebem 404", async () => {
    const docs = { default: docWith([node("c1", "cardinal", { cardinal: "p", agent: "t1" }), node("c2", "cardinal", { cardinal: "q" }), node("t1", "terminal", {}), node("t2", "terminal", {})]) };
    const { put, get } = fresh(docs);
    expect((await put("default", "c1", { text: sample(), rev: null, as: { agent: "t1" } }, remote)).status).toBe(403);
    expect((await json(await get("default", "c1", { as: "t1" }, remote))).code).toBe(CARDINAL_ROUTE_ERRORS.agentLocalOnly);
    expect((await put("default", "c1", { text: sample(), rev: null, as: { agent: "t1" } })).status).toBe(200);
    expect((await get("default", "c1", { as: "t1" })).status).toBe(200);
    expect((await get("default", "c1", { as: "t2" })).status).toBe(404);
    expect((await put("default", "c1", { text: sample(), rev: "x", as: { agent: "t2" } })).status).toBe(404);
    expect((await put("default", "c2", { text: sample(), rev: null, as: { agent: "t1" } })).status).toBe(404);
    expect((await get("default", "c1", { as: "pr:1" })).status).toBe(400);
    expect((await put("default", "c1", { text: sample(), rev: null, as: "t1" })).status).toBe(400);
  });

  test("listagem do canvas: o dono vê todos os nós cardinal com a meta; o agente só os dele", async () => {
    const docs = { default: docWith([node("c1", "cardinal", { cardinal: "p", agent: "t1" }), node("c2", "cardinal", { cardinal: "q" }), node("t1", "terminal", {})]) };
    const { put, get } = fresh(docs);
    await put("default", "c1", { text: sample(), rev: null });
    const owner = (await json(await get("default"))).nodes as Dict[];
    expect(owner.map((entry) => [entry.id, entry.name, entry.exists, entry.diagrams])).toEqual([["c1", "p", true, 2], ["c2", "q", false, 0]]);
    const agent = (await json(await get("default", undefined, { as: "t1" }))).nodes as Dict[];
    expect(agent.map((entry) => entry.id)).toEqual(["c1"]);
  });

  test("arquivo ilegível (link simbólico, não UTF-8) é 500 e nunca vira vazio", async () => {
    const { get, dir, file, put } = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(T, "alvo.cardinal"), sample());
    symlinkSync(join(T, "alvo.cardinal"), file("estoque"));
    expect([(await get("default", "c2")).status, (await put("default", "c2", { text: sample(), rev: null })).status]).toEqual([500, 500]);
    rmSync(file("estoque"));
    writeFileSync(file("estoque"), Buffer.from([0xff, 0xfe, 0x00]));
    expect((await get("default", "c2")).status).toBe(500);
  });

  test("arquivo acima do teto em disco: 413 na leitura", async () => {
    const { get, dir, file } = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file("estoque"), Buffer.alloc(CARDINAL_LIMITS.bodyBytes + 1, 0x20));
    expect((await get("default", "c2")).status).toBe(413);
  });

  test("listagem de arquivos: paginada, por nome, e recusa limite fora do teto", async () => {
    const { routes, put } = fresh();
    await put("default", "c1", { text: sample(), rev: null });
    await put("default", "c2", { text: sample(), rev: null });
    const page = await json(routes.list({ limit: "1" }));
    expect((page.files as Dict[]).map((file) => file.name)).toEqual(["estoque"]);
    expect(page.next).toBe("estoque");
    expect(((await json(routes.list({ after: "estoque" }))).files as Dict[]).map((file) => file.name)).toEqual(["pagamentos"]);
    expect(routes.list({ limit: "0" }).status).toBe(400);
    expect(routes.list({ limit: "9999" }).status).toBe(400);
    expect(routes.list({ after: "../x" }).status).toBe(400);
  });
});

describe("canvas-cardinal-route: arquivo adotado (link)", () => {
  const outside = (name = "arq.cardinal", text = sample()) => {
    const root = mkdtempSync(join(T, "root-"));
    writeFileSync(join(root, name), text, { mode: 0o640 });
    return { root, path: join(root, name) };
  };

  test("só local: remoto recebe 403 e nada é gravado", async () => {
    const { root, path } = outside();
    const { link, dir } = fresh(undefined, { roots: [root] });
    const res = await link({ path }, remote);
    expect([res.status, (await json(res)).code]).toEqual([403, CARDINAL_ROUTE_ERRORS.localOnly]);
    expect(() => readdirSync(dir)).toThrow();
  });

  test("adota sem mover, devolve o mesmo nome ao repetir, e o nó lê e grava no original mantendo a permissão", async () => {
    const { root, path } = outside();
    const docs = { default: docWith([node("c1", "cardinal", { cardinal: "cardinal-abc123def" })]) };
    const { link, get, put } = fresh(docs, { roots: [root] });
    expect(await json(await link({ path }))).toMatchObject({ ok: true, name: "cardinal-abc123def", created: true });
    expect(await json(await link({ path }))).toMatchObject({ name: "cardinal-abc123def", created: false });
    const read = await json(await get("default", "c1"));
    expect([read.location, read.path, read.diagrams]).toEqual(["custom", path, 2]);
    const next = sample(2, 5);
    expect((await put("default", "c1", { text: next, rev: read.rev })).status).toBe(200);
    expect(readFileSync(path, "utf8")).toBe(next);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  test("recusa: relativo, fora das raízes, extensão errada, dentro da pasta padrão, inexistente, link simbólico, envelope inválido, acima do teto", async () => {
    const { root, path } = outside();
    const { link, dir } = fresh(undefined, { roots: [root] });
    const elsewhere = outside("fora.cardinal");
    const wrong = outside("x.txt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dentro.cardinal"), sample());
    symlinkSync(path, join(root, "sym.cardinal"));
    writeFileSync(join(root, "ruim.cardinal"), "nao json");
    writeFileSync(join(root, "grande.cardinal"), Buffer.alloc(CARDINAL_LIMITS.bodyBytes + 1, 0x20));
    const cases: [unknown, number, string][] = [
      [{ path: "arq.cardinal" }, 400, CARDINAL_ROUTE_ERRORS.invalidPath],
      [{ path: elsewhere.path }, 400, CARDINAL_ROUTE_ERRORS.invalidPath],
      [{ path: wrong.path }, 400, CARDINAL_ROUTE_ERRORS.invalidPath],
      [{ path: join(dir, "dentro.cardinal") }, 400, CARDINAL_ROUTE_ERRORS.invalidPath],
      [{ path: join(root, "nada.cardinal") }, 404, CARDINAL_ROUTE_ERRORS.notFound],
      [{ path: join(root, "sym.cardinal") }, 400, CARDINAL_ROUTE_ERRORS.invalidPath],
      [{ path: join(root, "ruim.cardinal") }, 400, CARDINAL_ERRORS.invalidEnvelope],
      [{ path: join(root, "grande.cardinal") }, 413, CARDINAL_ROUTE_ERRORS.tooLarge],
      [{}, 400, CARDINAL_ROUTE_ERRORS.invalidBody],
    ];
    for (const [body, status, code] of cases) {
      const res = await link(body);
      expect([res.status, (await json(res)).code]).toEqual([status, code]);
    }
  });

  test("caminho guardado que saiu das raízes deixa de abrir (500), não lê às cegas", async () => {
    const { root, path } = outside();
    const docs = { default: docWith([node("c1", "cardinal", { cardinal: "cardinal-abc123def" })]) };
    const f = fresh(docs, { roots: [root] });
    await f.link({ path });
    const narrowed = createCanvasCardinalRoutes(f.D, { loadDoc: async (id) => docs[id as "default"], roots: [join(T, "outra-raiz-inexistente")] });
    expect(((await narrowed.get(`${BASE}default/c1`, {}, local)) as Response).status).toBe(500);
  });
});

describe("canvas-cardinal-route: imagem do editor (artifact)", () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("corpo")]);
  const withNode = async (docs?: Record<string, CanvasDoc>) => {
    const f = fresh(docs);
    const saved = await json(await f.put("default", "c2", { text: sample(), rev: null }));
    const post = (body: unknown, canvas = "default", nodeId = "c2") =>
      f.routes.action(`${BASE}${canvas}/${nodeId}/artifact`, req(`${BASE}${canvas}/${nodeId}/artifact`, body, "POST"), local) as Promise<Response>;
    return { ...f, rev: saved.rev as string, post };
  };

  test("SVG feliz vira o sidecar com a revisão de origem; o GET do cartão o devolve sem defasagem", async () => {
    const { post, routes, dir, rev } = await withNode();
    const res = await post({ format: "svg", rev, data: SVG });
    expect([res.status, (await json(res)).ok]).toEqual([200, true]);
    expect(readFileSync(join(dir, "estoque.svg"), "utf8")).toBe(SVG);
    expect(readFileSync(join(dir, "estoque.svg.rev"), "utf8")).toBe(rev);
    const card = await json((await routes.get(`${BASE}default/c2/svg`, {}, local)) as Response);
    expect([card.svg, card.svgRev, card.stale]).toEqual([SVG, rev, false]);
  });

  test("PNG feliz grava <nome>.png e .rev; GET ?format=png devolve os bytes, a revisão e stale false", async () => {
    const { post, routes, dir, rev } = await withNode();
    const res = await post({ format: "png", rev, data: PNG.toString("base64") });
    expect([res.status, (await json(res)).bytes]).toEqual([200, PNG.length]);
    expect(readFileSync(join(dir, "estoque.png")).equals(PNG)).toBe(true);
    const got = (await routes.get(`${BASE}default/c2/artifact`, { format: "png" }, local)) as Response;
    expect([got.status, got.headers.get("content-type"), got.headers.get("X-Cardinal-Rev"), got.headers.get("X-Cardinal-Stale")]).toEqual([200, "image/png", rev, "false"]);
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
  });

  test("GET png: arquivo mudou depois da imagem marca stale; sem imagem é 404; format ausente é 400", async () => {
    const { post, put, routes, rev } = await withNode();
    const get = (q: Record<string, string>) => routes.get(`${BASE}default/c2/artifact`, q, local) as Promise<Response>;
    expect((await get({ format: "png" })).status).toBe(404);
    expect((await get({})).status).toBe(400);
    await post({ format: "png", rev, data: PNG.toString("base64") });
    expect((await put("default", "c2", { text: sample(2, 5), rev })).status).toBe(200);
    expect((await get({ format: "png" })).headers.get("X-Cardinal-Stale")).toBe("true");
  });

  test("409 com revisão velha devolvendo a atual; nada é gravado", async () => {
    const { post, put, dir, rev } = await withNode();
    const next = await json(await put("default", "c2", { text: sample(2, 5), rev }));
    const res = await post({ format: "svg", rev, data: SVG });
    const status = res.status;
    const refused = await json(res);
    expect([status, refused.code, refused.rev]).toEqual([409, CARDINAL_ROUTE_ERRORS.staleRevision, next.rev]);
    expect(readdirSync(dir)).toEqual(["estoque.cardinal"]);
  });

  test("404 fora do escopo: nó inexistente, de outro tipo e canvas inexistente", async () => {
    const { post, rev } = await withNode();
    for (const [canvas, nodeId] of [["default", "nada"], ["default", "n1"], ["default", "t1"], ["outro", "c2"]] as const) {
      expect((await post({ format: "svg", rev, data: SVG }, canvas, nodeId)).status).toBe(404);
    }
  });

  test("SVG com script ou handler, e PNG inválido, são 400 e não gravam", async () => {
    const { post, dir, rev } = await withNode();
    for (const data of ['<svg><script>x</script></svg>', '<svg onload="x()"/>', '<svg><foreignObject/></svg>', 'texto solto']) {
      expect((await post({ format: "svg", rev, data })).status).toBe(400);
    }
    for (const data of [Buffer.from("nao e png").toString("base64"), ""]) {
      expect((await post({ format: "png", rev, data })).status).toBe(400);
    }
    expect(readdirSync(dir)).toEqual(["estoque.cardinal"]);
  });

  test("corpo inválido: formato desconhecido, rev ou data faltando", async () => {
    const { post, rev } = await withNode();
    for (const body of [{ format: "gif", rev, data: SVG }, { format: "svg", data: SVG }, { format: "svg", rev }, { format: "svg", rev, data: 3 }]) {
      expect((await post(body)).status).toBe(400);
    }
  });

  test("agente (as) é recusado: só o dono grava imagem", async () => {
    const { post, rev } = await withNode();
    const res = await post({ format: "svg", rev, data: SVG, as: { agent: "t1" } });
    expect(res.status).toBe(400);
  });
});

describe("cardinal-watch: vigia e aviso por SSE", () => {
  const watched = (hold: { name: string; rev: string | null }[]) => {
    const f = fresh();
    mkdirSync(f.dir, { recursive: true });
    const watch = createCardinalWatch({ files: () => f.routes.files(), onChange: (name, rev) => hold.push({ name, rev }), noFsWatch: true });
    return { ...f, watch };
  };

  test("arquivo alterado por fora gera um aviso com a revisão nova; sem mudança, nenhum", () => {
    const seen: { name: string; rev: string | null }[] = [];
    const { file, watch } = watched(seen);
    writeFileSync(file("estoque"), sample(2, 1));
    watch.start();
    expect(watch.check()).toBe(0);
    const next = sample(2, 3);
    writeFileSync(file("estoque"), next);
    expect(watch.check()).toBe(1);
    expect(seen).toEqual([{ name: "estoque", rev: revisionOf(new TextEncoder().encode(next)) }]);
    expect(watch.check()).toBe(0);
    watch.stop();
  });

  test("arquivo criado e apagado por fora também avisa (rev null ao sair)", () => {
    const seen: { name: string; rev: string | null }[] = [];
    const { file, watch } = watched(seen);
    watch.start();
    writeFileSync(file("novo"), sample());
    expect(watch.check()).toBe(1);
    rmSync(file("novo"));
    expect(watch.check()).toBe(1);
    expect(seen.map((entry) => [entry.name, entry.rev === null])).toEqual([["novo", false], ["novo", true]]);
    watch.stop();
  });

  test("gravação pela rota entra por learn e não ecoa; a seguinte por fora avisa", async () => {
    const seen: { name: string; rev: string | null }[] = [];
    const f = fresh();
    const watch = createCardinalWatch({ files: () => f.routes.files(), onChange: (name, rev) => seen.push({ name, rev }), noFsWatch: true });
    const routes = createCanvasCardinalRoutes(f.D, { loadDoc: async () => DOC, onWrite: (name, rev) => watch.learn(name, rev) });
    watch.start();
    const res = await json((await routes.write(`${BASE}default/c2`, req(`${BASE}default/c2`, { text: sample(), rev: null }), local)) as Response);
    expect(watch.check()).toBe(0);
    writeFileSync(f.file("estoque"), sample(2, 9));
    expect(watch.check()).toBe(1);
    expect(seen[0]?.rev).not.toBe(res.rev);
    watch.stop();
  });

  test("conteúdo regravado igual (só o carimbo muda) não avisa", () => {
    const seen: { name: string; rev: string | null }[] = [];
    const { file, watch } = watched(seen);
    writeFileSync(file("estoque"), sample());
    watch.start();
    writeFileSync(file("estoque"), sample());
    expect(watch.check()).toBe(0);
    watch.stop();
  });

  test("arquivo adotado alterado por fora avisa depois do refresh", async () => {
    const root = mkdtempSync(join(T, "root-"));
    const path = join(root, "ext.cardinal");
    writeFileSync(path, sample(2, 1));
    const seen: { name: string; rev: string | null }[] = [];
    const f = fresh(undefined, { roots: [root] });
    const watch = createCardinalWatch({ files: () => f.routes.files(), onChange: (name, rev) => seen.push({ name, rev }), noFsWatch: true });
    watch.start();
    await f.link({ path });
    watch.refresh();
    writeFileSync(path, sample(2, 4));
    expect(watch.check()).toBe(1);
    expect(seen[0]?.name).toBe("cardinal-abc123def");
    watch.stop();
  });

  test("com fs.watch real o aviso chega sozinho e o SSE do canvas leva o evento cardinal", async () => {
    const f = fresh();
    mkdirSync(f.dir, { recursive: true });
    const hub = createCanvasHub();
    const watch = createCardinalWatch({ files: () => f.routes.files(), onChange: (name, rev) => hub.publishCardinal(name, rev, "disk"), debounceMs: 20, sweepMs: 100 });
    writeFileSync(f.file("estoque"), sample(2, 1));
    watch.start();
    const abort = new AbortController();
    const res = hub.open(new Request("http://127.0.0.1/api/canvas/stream", { signal: abort.signal }));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const next = sample(2, 6);
    writeFileSync(f.file("estoque"), next);
    let text = "";
    const deadline = Date.now() + 3000;
    while (!text.includes("event: cardinal") && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), Bun.sleep(500).then(() => undefined)]);
      if (chunk && !chunk.done) text += new TextDecoder().decode(chunk.value);
    }
    abort.abort();
    watch.stop();
    hub.close();
    expect(text).toContain(`data: ${JSON.stringify({ name: "estoque", rev: revisionOf(new TextEncoder().encode(next)), source: "disk" })}`);
  });
});
