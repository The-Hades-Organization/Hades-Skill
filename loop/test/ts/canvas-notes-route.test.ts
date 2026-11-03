// Grupo canvas-notes-route: rotas das notas do canvas (src/panel/canvas-notes.ts + registro em server.ts) — ler e gravar
// `$D/canvas-notes/<nome>.md`, nome contido, teto de tamanho, gravação atômica, revisão contra escrita concorrente, quem
// escreve (dono, agente ligado) e o regime de acesso do painel real (chave, token da sessão).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CanvasDoc, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { NOTE_LIMITS } from "../../../src/lib/canvas-note";
import { createCanvasNotesRoutes, NOTE_BODY_BYTES, NOTE_ROUTE_ERRORS } from "../../../src/panel/canvas-notes";
import { Rig } from "./lib/rig";
import { fetchRaw, JSON_CT, remoteHeaders, startTestPanel, widgetData } from "./lib/widget-rig";

type Dict = Record<string, unknown>;

const AGENT = "agent:proj:impl-1";
const noteNode = (id: string, data: Dict): Dict => ({ id, type: "note", x: 0, y: 0, w: 280, h: 200, z: 0, data, locked: false, blurred: false });
const docWith = (nodes: Dict[]): CanvasDoc => validateCanvasDoc({ v: 1, rev: 0, nodes, edges: [], groups: [] });
const LINKED = docWith([noteNode("n1", { note: "nota-a", agent: AGENT }), noteNode("n2", { note: "nota-b" })]);

const T = mkdtempSync(join(tmpdir(), "hades-notes-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const BASE = "/api/canvas-notes/";
const putReq = (name: string, body: unknown, method = "PUT"): Request =>
  new Request(`http://127.0.0.1${BASE}${name}`, { method, headers: { "Content-Type": "application/json" }, body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) });
const local = { remote: false };
const json = async (res: Response): Promise<Dict> => (await res.json()) as Dict;

describe("canvas-notes-route: a rota sobre a pasta de dados", () => {
  let n = 0;
  const fresh = (docs: Record<string, CanvasDoc> = { default: LINKED }) => {
    const D = join(T, `d${n++}`);
    mkdirSync(D, { recursive: true });
    const routes = createCanvasNotesRoutes(D, { loadDoc: async (id) => docs[id] });
    return { D, routes, dir: join(D, "canvas-notes"), file: (name: string) => join(D, "canvas-notes", `${name}.md`) };
  };
  const write = async (routes: ReturnType<typeof fresh>["routes"], name: string, body: unknown, caller = local) =>
    (routes.write(`${BASE}${name}`, putReq(name, body), caller) as Promise<Response>);

  test("caminho de outra família não é desta rota", () => {
    const { routes } = fresh();
    expect(routes.get("/api/canvas")).toBeUndefined();
    expect(routes.get("/api/canvases/x")).toBeUndefined();
    expect(routes.write("/api/canvas", putReq("x", {}), local)).toBeUndefined();
  });

  test("GET de nota que não existe é 404 note_not_found e não cria a pasta", async () => {
    const { routes, dir } = fresh();
    const res = routes.get(`${BASE}nota-a`) as Response;
    expect([res.status, (await json(res)).code]).toEqual([404, NOTE_ROUTE_ERRORS.notFound]);
    expect(existsSync(dir)).toBe(false);
  });

  test("PUT com rev null cria o arquivo .md, sem sobra de temporário, e o GET devolve o texto e a revisão", async () => {
    const { routes, dir, file } = fresh();
    const res = await write(routes, "nota-a", { text: "# Plano\n\ncorpo ção", rev: null });
    const saved = await json(res);
    expect([res.status, saved.ok, saved.name, saved.bytes]).toEqual([200, true, "nota-a", new TextEncoder().encode("# Plano\n\ncorpo ção").length]);
    expect(readdirSync(dir)).toEqual(["nota-a.md"]);
    expect(readFileSync(file("nota-a"), "utf8")).toBe("# Plano\n\ncorpo ção");
    const got = await json(routes.get(`${BASE}nota-a`) as Response);
    expect([got.name, got.text, got.rev]).toEqual(["nota-a", "# Plano\n\ncorpo ção", saved.rev]);
    expect(typeof got.updatedAt).toBe("string");
  });

  test("nota vazia é gravável e o GET devolve texto vazio", async () => {
    const { routes } = fresh();
    expect((await write(routes, "vazia", { text: "", rev: null })).status).toBe(200);
    expect((await json(routes.get(`${BASE}vazia`) as Response)).text).toBe("");
  });

  test("a revisão que o cliente leu abre a próxima gravação; a velha é 409 com a revisão atual e não grava", async () => {
    const { routes, file } = fresh();
    const first = await json(await write(routes, "nota-a", { text: "um", rev: null }));
    const second = await json(await write(routes, "nota-a", { text: "dois", rev: first.rev }));
    expect(second.rev).not.toBe(first.rev);
    const stale = await write(routes, "nota-a", { text: "três", rev: first.rev });
    expect([stale.status, (await json(stale))]).toEqual([409, { error: "nota recusada (note_stale_revision)", code: NOTE_ROUTE_ERRORS.staleRevision, rev: second.rev }]);
    expect(readFileSync(file("nota-a"), "utf8")).toBe("dois");
  });

  test("rev null sobre nota que já existe é 409 (não sobrescreve sem ter lido) e rev de nota que não existe também", async () => {
    const { routes, file } = fresh();
    await write(routes, "nota-a", { text: "um", rev: null });
    expect((await write(routes, "nota-a", { text: "outro", rev: null })).status).toBe(409);
    const ghost = await write(routes, "nota-b", { text: "x", rev: "abc" });
    expect([ghost.status, (await json(ghost)).rev]).toEqual([409, null]);
    expect(readFileSync(file("nota-a"), "utf8")).toBe("um");
    expect(existsSync(file("nota-b"))).toBe(false);
  });

  test("edição do arquivo por fora muda a revisão: o PUT com a revisão antiga é 409", async () => {
    const { routes, file } = fresh();
    const first = await json(await write(routes, "nota-a", { text: "um", rev: null }));
    writeFileSync(file("nota-a"), "editado por fora");
    expect((await write(routes, "nota-a", { text: "meu", rev: first.rev })).status).toBe(409);
  });

  test("nome fora da lista fechada é 400 note_invalid_name, na leitura e na escrita, sem tocar o disco", async () => {
    const { routes, D } = fresh();
    for (const name of ["..", "a.md", ".hidden", "a%2Fb", "a%2e%2e", "-x", "a".repeat(65), "a b"]) {
      const get = routes.get(`${BASE}${name}`) as Response;
      expect([name, get.status, (await json(get)).code]).toEqual([name, 400, NOTE_ROUTE_ERRORS.invalidName]);
      const put = await write(routes, name, { text: "x", rev: null });
      expect([name, put.status, (await json(put)).code]).toEqual([name, 400, NOTE_ROUTE_ERRORS.invalidName]);
    }
    for (const path of [`${BASE}a/b`, `${BASE}../canvas`, `${BASE}`]) expect(((routes.get(path) as Response).status)).toBe(400);
    expect(readdirSync(D)).toEqual([]);
  });

  test("corpo que não é JSON de objeto, sem text, com rev de tipo errado ou método diferente de PUT é recusado", async () => {
    const { routes } = fresh();
    for (const body of ["não é json", "[]", "null", { rev: null }, { text: 5, rev: null }, { text: "x" }, { text: "x", rev: 1 }]) {
      const res = await write(routes, "nota-a", body);
      expect([JSON.stringify(body), res.status, (await json(res)).code]).toEqual([JSON.stringify(body), 400, NOTE_ROUTE_ERRORS.invalidBody]);
    }
    const post = await (routes.write(`${BASE}nota-a`, putReq("nota-a", { text: "x", rev: null }, "POST"), local) as Promise<Response>);
    expect(post.status).toBe(404);
  });

  test("o teto do corpo é inclusivo: 256 KiB grava, 256 KiB + 1 byte é 413 note_too_large e não grava", async () => {
    const { routes, file } = fresh();
    const ok = await write(routes, "cheia", { text: "a".repeat(NOTE_LIMITS.bodyBytes), rev: null });
    expect(ok.status).toBe(200);
    const over = await write(routes, "estourou", { text: "a".repeat(NOTE_LIMITS.bodyBytes + 1), rev: null });
    expect([over.status, (await json(over)).code]).toEqual([413, NOTE_ROUTE_ERRORS.tooLarge]);
    expect(existsSync(file("estourou"))).toBe(false);
  });

  test("o teto conta bytes, não caracteres: texto multibyte acima do teto é 413", async () => {
    const { routes } = fresh();
    const res = await write(routes, "bytes", { text: "ç".repeat(NOTE_LIMITS.bodyBytes / 2 + 1), rev: null });
    expect(res.status).toBe(413);
  });

  test("corpo acima do teto da rota é 413 sem ser lido por inteiro", async () => {
    const { routes } = fresh();
    const res = await write(routes, "nota-a", new Uint8Array(NOTE_BODY_BYTES + 1));
    expect([res.status, (await json(res)).code]).toEqual([413, NOTE_ROUTE_ERRORS.tooLarge]);
  });

  test("arquivo acima do teto, que não é UTF-8 ou que é link simbólico não é lido como vazio: 413 e 500", async () => {
    const { routes, dir, file } = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file("grande"), "a".repeat(NOTE_LIMITS.bodyBytes + 1));
    writeFileSync(file("binaria"), new Uint8Array([0xff, 0xfe, 0x00]));
    writeFileSync(join(T, "fora.txt"), "segredo");
    symlinkSync(join(T, "fora.txt"), file("atalho"));
    const big = routes.get(`${BASE}grande`) as Response;
    expect([big.status, (await json(big)).code]).toEqual([413, NOTE_ROUTE_ERRORS.tooLarge]);
    for (const name of ["binaria", "atalho"]) {
      const res = routes.get(`${BASE}${name}`) as Response;
      expect([name, res.status, (await json(res)).code]).toEqual([name, 500, NOTE_ROUTE_ERRORS.unreadable]);
    }
    const put = await write(routes, "atalho", { text: "x", rev: null });
    expect(put.status).toBe(500);
    expect(readFileSync(join(T, "fora.txt"), "utf8")).toBe("segredo");
  });

  test("a resposta de erro não vaza caminho nem mensagem interna", async () => {
    const { routes, D, dir, file } = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file("binaria"), new Uint8Array([0xff]));
    const text = await (routes.get(`${BASE}binaria`) as Response).text();
    expect(text).not.toContain(D);
    expect(text).not.toContain("UTF");
  });

  test("agente ligado grava na nota do nó que o liga; o escopo é o do documento", async () => {
    const { routes, file } = fresh();
    const as = { agent: AGENT, canvas: "default", node: "n1" };
    const res = await write(routes, "nota-a", { text: "progresso", rev: null, as });
    expect(res.status).toBe(200);
    expect(readFileSync(file("nota-a"), "utf8")).toBe("progresso");
  });

  test("agente que não é o ligado, nota sem ligação, nó de outra nota, canvas ou nó inexistente: tudo 404 note_not_found, sem gravar", async () => {
    const { routes, dir } = fresh({ default: LINKED, outro: docWith([]) });
    const attempts: [string, Dict][] = [
      ["nota-a", { agent: "agent:proj:intruso", canvas: "default", node: "n1" }],
      ["nota-b", { agent: AGENT, canvas: "default", node: "n2" }],
      ["nota-b", { agent: AGENT, canvas: "default", node: "n1" }],
      ["nota-a", { agent: AGENT, canvas: "default", node: "nao-existe" }],
      ["nota-a", { agent: AGENT, canvas: "outro", node: "n1" }],
      ["nota-a", { agent: AGENT, canvas: "nao-existe", node: "n1" }],
      ["nota-a", { agent: AGENT, canvas: "../x", node: "n1" }],
    ];
    for (const [name, as] of attempts) {
      const res = await write(routes, name, { text: "x", rev: null, as });
      expect([name, JSON.stringify(as), res.status, (await json(res)).code]).toEqual([name, JSON.stringify(as), 404, NOTE_ROUTE_ERRORS.notFound]);
    }
    expect(existsSync(dir)).toBe(false);
  });

  test("identidade de agente malformada é 400; pelo túnel é 403 note_agent_local_only, mesmo para o agente certo", async () => {
    const { routes, dir } = fresh();
    for (const as of ["n1", { agent: "pr:1", canvas: "default", node: "n1" }, { agent: AGENT, node: "n1" }, { agent: AGENT, canvas: "default" }]) {
      const res = await write(routes, "nota-a", { text: "x", rev: null, as });
      expect([JSON.stringify(as), res.status]).toEqual([JSON.stringify(as), 400]);
    }
    const remote = await write(routes, "nota-a", { text: "x", rev: null, as: { agent: AGENT, canvas: "default", node: "n1" } }, { remote: true });
    expect([remote.status, (await json(remote)).code]).toEqual([403, NOTE_ROUTE_ERRORS.agentLocalOnly]);
    expect(existsSync(dir)).toBe(false);
  });

  test("o dono, local ou pelo túnel, escreve em qualquer nota sem declarar agente", async () => {
    const { routes } = fresh({});
    expect((await write(routes, "livre", { text: "a", rev: null })).status).toBe(200);
    const remote = await write(routes, "livre2", { text: "b", rev: null }, { remote: true });
    expect(remote.status).toBe(200);
  });
});

// ---- pelo painel real: acesso, token e a leitura do documento do canvas ----
describe("canvas-notes-route: pelo painel real (acesso e token)", () => {
  const r = new Rig().setup();
  let D = "";
  let P: Awaited<ReturnType<typeof startTestPanel>>;
  beforeAll(async () => {
    D = widgetData(r, "canvas-notes").D;
    P = await startTestPanel(D);
  });
  afterAll(() => {
    P?.stop();
    r.cleanup();
  });

  const path = (name: string) => `${BASE}${name}`;
  const put = (name: string, body: unknown, headers: Record<string, string> = {}) => fetchRaw(P.base, path(name), { ...JSON_CT, "x-panel-token": P.token, ...headers }, body, "PUT");

  test("local: PUT com o token grava em $D/canvas-notes e o GET devolve", async () => {
    expect((await fetchRaw(P.base, path("nota-a"))).status).toBe(404);
    const saved = await put("nota-a", { text: "oi", rev: null });
    expect([saved.status, saved.json?.ok]).toEqual([200, true]);
    expect(readFileSync(join(D, "canvas-notes", "nota-a.md"), "utf8")).toBe("oi");
    const got = await fetchRaw(P.base, path("nota-a"));
    expect([got.status, got.json?.text, got.json?.rev]).toEqual([200, "oi", saved.json?.rev]);
  });

  test("PUT sem o token da sessão, sem JSON ou com origem de fora é 403 e nada muda", async () => {
    const before = readFileSync(join(D, "canvas-notes", "nota-a.md"), "utf8");
    const rev = (await fetchRaw(P.base, path("nota-a"))).json?.rev;
    const noToken = await fetchRaw(P.base, path("nota-a"), JSON_CT, { text: "x", rev }, "PUT");
    expect(noToken.status).toBe(403);
    const wrongType = await fetch(`${P.base}${path("nota-a")}`, { method: "PUT", headers: { "x-panel-token": P.token, "Content-Type": "text/plain" }, body: JSON.stringify({ text: "x", rev }) });
    expect(wrongType.status).toBe(403);
    expect((await put("nota-a", { text: "x", rev }, { Origin: "https://evil.example.invalid" })).status).toBe(403);
    expect(readFileSync(join(D, "canvas-notes", "nota-a.md"), "utf8")).toBe(before);
  });

  test("pelo túnel: sem a chave GET e PUT são 401; com a chave o PUT ainda exige o token", async () => {
    const anon = remoteHeaders(D, false);
    expect((await fetchRaw(P.base, path("nota-a"), anon)).status).toBe(401);
    expect((await fetchRaw(P.base, path("nota-a"), { ...anon, ...JSON_CT, "x-panel-token": P.token }, { text: "x", rev: null }, "PUT")).status).toBe(401);
    const keyed = remoteHeaders(D, true);
    expect((await fetchRaw(P.base, path("nota-a"), keyed)).status).toBe(200);
    expect((await fetchRaw(P.base, path("nota-a"), { ...keyed, ...JSON_CT }, { text: "x", rev: null }, "PUT")).status).toBe(403);
  });

  test("agente ligado pelo documento gravado: o painel lê o canvas pela própria rota e libera só a nota do nó", async () => {
    const doc = { v: 1, rev: 0, nodes: [noteNode("n1", { note: "do-agente", agent: AGENT })], edges: [], groups: [] };
    const saved = await fetchRaw(P.base, "/api/canvas", { ...JSON_CT, "x-panel-token": P.token }, doc, "PUT");
    expect(saved.status).toBe(200);
    const as = { agent: AGENT, canvas: "default", node: "n1" };
    const ok = await put("do-agente", { text: "feito", rev: null, as });
    expect([ok.status, ok.json?.ok]).toEqual([200, true]);
    const other = await put("nota-a", { text: "x", rev: (await fetchRaw(P.base, path("nota-a"))).json?.rev, as });
    expect([other.status, other.code]).toEqual([404, NOTE_ROUTE_ERRORS.notFound]);
    const remote = await put("do-agente", { text: "x", rev: null, as }, remoteHeaders(D, true));
    expect([remote.status, remote.code]).toEqual([403, NOTE_ROUTE_ERRORS.agentLocalOnly]);
  });

  test("POST na rota de notas não existe (404)", async () => {
    expect((await fetchRaw(P.base, path("nota-a"), { ...JSON_CT, "x-panel-token": P.token }, { text: "x", rev: null }, "POST")).status).toBe(404);
  });
});

// ---- nota de verdade: listar, bloquear, renomear, mover, apontar, imagem e fechar (bloco da unidade notas) ----
import { NOTE_FILE_LIMITS } from "../../../src/lib/canvas-note";
import { NOTE_LIST_LIMITS } from "../../../src/panel/canvas-notes";

describe("canvas-notes-route: ações da nota de verdade", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const OUTSIDE = mkdtempSync(join(tmpdir(), "hades-notes-out-"));
  afterAll(() => rmSync(OUTSIDE, { recursive: true, force: true }));
  let n = 0;
  const fresh = () => {
    const D = join(T, `a${n++}`);
    const ext = join(D, "fora");
    mkdirSync(ext, { recursive: true });
    const tokens = ["link000001", "link000002", "link000003"];
    const routes = createCanvasNotesRoutes(D, { loadDoc: async () => LINKED, roots: [D], token: () => tokens.shift() ?? "link999999" });
    return { D, ext, routes, dir: join(D, "canvas-notes") };
  };
  type Routes = ReturnType<typeof fresh>["routes"];
  const post = (routes: Routes, path: string, body: unknown, caller = local): Promise<Response> =>
    routes.action(`${BASE}${path}`, new Request(`http://127.0.0.1${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), caller) as Promise<Response>;
  const put = (routes: Routes, name: string, text: string, rev: string | null = null): Promise<Response> =>
    routes.write(`${BASE}${name}`, putReq(name, { text, rev }), local) as Promise<Response>;
  const status = async (res: Response): Promise<[number, unknown]> => [res.status, (await json(res)).code];
  const remote = { remote: true };

  test("lista vazia sem pasta; notas gravadas saem por nome, com o nome da 1ª linha", async () => {
    const { routes } = fresh();
    expect(await json(routes.list({}))).toEqual({ notes: [], next: null });
    await put(routes, "nota-b", "# Segunda");
    await put(routes, "nota-a", "Primeira linha\nresto");
    const listed = await json(routes.list({}));
    const notes = listed.notes as Dict[];
    expect(notes.map((x) => [x.name, x.title, x.location, x.exists])).toEqual([["nota-a", "Primeira linha", "default", true], ["nota-b", "Segunda", "default", true]]);
  });

  test("paginação: limit corta e next aponta o último; after continua de onde parou", async () => {
    const { routes } = fresh();
    for (const name of ["nota-a", "nota-b", "nota-c"]) await put(routes, name, name);
    const first = await json(routes.list({ limit: "2" }));
    expect([(first.notes as Dict[]).map((x) => x.name), first.next]).toEqual([["nota-a", "nota-b"], "nota-b"]);
    const rest = await json(routes.list({ limit: "2", after: "nota-b" }));
    expect([(rest.notes as Dict[]).map((x) => x.name), rest.next]).toEqual([["nota-c"], null]);
  });

  test("limit acima do teto, zero, não número e after inválido são 400 note_invalid_query", async () => {
    const { routes } = fresh();
    expect(routes.list({ limit: String(NOTE_LIST_LIMITS.max) }).status).toBe(200);
    const queries: Record<string, string>[] = [{ limit: String(NOTE_LIST_LIMITS.max + 1) }, { limit: "0" }, { limit: "x" }, { after: "../x" }];
    for (const query of queries) {
      expect(await status(routes.list(query))).toEqual([400, NOTE_ROUTE_ERRORS.invalidQuery]);
    }
  });

  test("bloqueada: PUT e imagem são 423 note_locked, o GET mostra o cadeado; desbloquear libera", async () => {
    const { routes } = fresh();
    const saved = await json(await put(routes, "nota-a", "texto"));
    expect((await json(await post(routes, "nota-a/lock", { locked: true }))).locked).toBe(true);
    expect((await json(routes.get(`${BASE}nota-a`) as Response)).locked).toBe(true);
    expect(await status(await put(routes, "nota-a", "outro", saved.rev as string))).toEqual([423, NOTE_ROUTE_ERRORS.locked]);
    expect(await status(await post(routes, "nota-a/images", { data: PNG.toString("base64") }))).toEqual([423, NOTE_ROUTE_ERRORS.locked]);
    await post(routes, "nota-a/lock", { locked: false });
    expect((await put(routes, "nota-a", "outro", saved.rev as string)).status).toBe(200);
  });

  test("lock sem booleano é 400 note_invalid_body; ação desconhecida e POST sem ação são 404", async () => {
    const { routes } = fresh();
    expect(await status(await post(routes, "nota-a/lock", { locked: "sim" }))).toEqual([400, NOTE_ROUTE_ERRORS.invalidBody]);
    expect((await post(routes, "nota-a/voar", {})).status).toBe(404);
    expect((await post(routes, "nota-a", {})).status).toBe(404);
  });

  test("renomear fixa o nome no GET e na lista; vazio volta ao automático; inválido é note_invalid_title", async () => {
    const { routes } = fresh();
    await put(routes, "nota-a", "# Automático");
    expect((await json(await post(routes, "nota-a/rename", { title: " Meu nome " }))).title).toBe("Meu nome");
    expect((await json(routes.get(`${BASE}nota-a`) as Response)).title).toBe("Meu nome");
    expect(((await json(routes.list({}))).notes as Dict[])[0]?.titleFixed).toBe(true);
    await post(routes, "nota-a/rename", { title: "" });
    expect(((await json(routes.list({}))).notes as Dict[])[0]?.title).toBe("Automático");
    expect(await status(await post(routes, "nota-a/rename", { title: "x".repeat(NOTE_FILE_LIMITS.titleChars + 1) }))).toEqual([400, NOTE_ROUTE_ERRORS.invalidTitle]);
  });

  test("mover leva arquivo e imagens, reescreve a referência e volta para a pasta padrão do mesmo jeito", async () => {
    const { routes, ext, dir } = fresh();
    await put(routes, "nota-a", "x");
    const image = await json(await post(routes, "nota-a/images", { data: PNG.toString("base64") }));
    const saved = await json(routes.get(`${BASE}nota-a`) as Response);
    await put(routes, "nota-a", `antes ${image.markdown as string}`, saved.rev as string);
    const target = join(ext, "Plano.md");
    const moved = await json(await post(routes, "nota-a/move", { to: target }));
    expect([moved.location, moved.path]).toEqual(["custom", target]);
    expect(readFileSync(target, "utf8")).toBe(`antes ![imagem](Plano.assets/${image.file as string})`);
    expect(readdirSync(join(ext, "Plano.assets"))).toEqual([image.file as string]);
    expect(existsSync(join(dir, "nota-a.md"))).toBe(false);
    expect(existsSync(join(dir, "nota-a.assets"))).toBe(false);
    const asset = routes.get(`${BASE}nota-a/assets/${image.file as string}`) as Response;
    expect([asset.status, asset.headers.get("content-type"), asset.headers.get("x-content-type-options")]).toEqual([200, "image/png", "nosniff"]);
    const back = await json(await post(routes, "nota-a/move", { to: null }));
    expect([back.location, back.path]).toEqual(["default", null]);
    expect(readFileSync(join(dir, "nota-a.md"), "utf8")).toBe(`antes ![imagem](nota-a.assets/${image.file as string})`);
    expect(existsSync(target)).toBe(false);
  });

  test("mover para destino que já existe é 409 note_exists e nada muda", async () => {
    const { routes, ext, dir } = fresh();
    await put(routes, "nota-a", "x");
    writeFileSync(join(ext, "ocupado.md"), "outro");
    expect(await status(await post(routes, "nota-a/move", { to: join(ext, "ocupado.md") }))).toEqual([409, NOTE_ROUTE_ERRORS.exists]);
    expect(readFileSync(join(dir, "nota-a.md"), "utf8")).toBe("x");
  });

  test("mover e apontar de fora são só locais: remoto é 403 note_local_only", async () => {
    const { routes, ext } = fresh();
    expect(await status(await post(routes, "nota-a/move", { to: join(ext, "a.md") }, remote))).toEqual([403, NOTE_ROUTE_ERRORS.localOnly]);
    expect(await status(await post(routes, "link", { path: join(ext, "a.md") }, remote))).toEqual([403, NOTE_ROUTE_ERRORS.localOnly]);
  });

  test("caminho relativo, fora da raiz, por link simbólico para fora, com outra extensão ou na pasta padrão é note_invalid_path", async () => {
    const { routes, D, ext, dir } = fresh();
    await put(routes, "nota-a", "x");
    symlinkSync(OUTSIDE, join(D, "atalho"));
    for (const to of ["fora/a.md", join(OUTSIDE, "a.md"), join(D, "atalho", "a.md"), join(ext, "a.html"), join(ext, "..", "..", "a.md"), join(dir, "copia.md")]) {
      expect(await status(await post(routes, "nota-a/move", { to }))).toEqual([400, NOTE_ROUTE_ERRORS.invalidPath]);
    }
    expect(readdirSync(OUTSIDE)).toEqual([]);
  });

  test("apontar para arquivo de fora não move o original e é idempotente; arquivo que não existe é 404", async () => {
    const { routes, ext } = fresh();
    const path = join(ext, "Ideias.md");
    writeFileSync(path, "# Ideias\nvalem");
    const first = await json(await post(routes, "link", { path }));
    expect([first.name, first.created]).toEqual(["nota-link000001", true]);
    const again = await json(await post(routes, "link", { path }));
    expect([again.name, again.created]).toEqual(["nota-link000001", false]);
    expect((await json(routes.get(`${BASE}nota-link000001`) as Response)).text).toBe("# Ideias\nvalem");
    expect(readFileSync(path, "utf8")).toBe("# Ideias\nvalem");
    expect(await status(await post(routes, "link", { path: join(ext, "nada.md") }))).toEqual([404, NOTE_ROUTE_ERRORS.notFound]);
  });

  test("imagem: PNG grava pelo hash e repetir não duplica; SVG e base64 inválido são note_invalid_image", async () => {
    const { routes, dir } = fresh();
    const first = await json(await post(routes, "nota-a/images", { data: PNG.toString("base64") }));
    expect(first.file).toMatch(/^[a-f0-9]{16}\.png$/);
    expect(first.markdown).toBe(`![imagem](nota-a.assets/${first.file as string})`);
    await post(routes, "nota-a/images", { data: PNG.toString("base64") });
    expect(readdirSync(join(dir, "nota-a.assets"))).toEqual([first.file as string]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>').toString("base64");
    expect(await status(await post(routes, "nota-a/images", { data: svg }))).toEqual([400, NOTE_ROUTE_ERRORS.invalidImage]);
    expect(await status(await post(routes, "nota-a/images", { data: "não é base64!" }))).toEqual([400, NOTE_ROUTE_ERRORS.invalidImage]);
  });

  test("imagem acima do teto é 413; nota no teto de imagens é 409 note_too_many_images", async () => {
    const { routes, dir } = fresh();
    const big = Buffer.concat([PNG, Buffer.alloc(NOTE_FILE_LIMITS.imageBytes)]).toString("base64");
    expect((await post(routes, "nota-a/images", { data: big })).status).toBe(413);
    const assets = join(dir, "nota-a.assets");
    mkdirSync(assets, { recursive: true });
    for (let i = 0; i < NOTE_FILE_LIMITS.imagesPerNote; i++) writeFileSync(join(assets, `${i.toString(16).padStart(16, "0")}.png`), PNG);
    expect(await status(await post(routes, "nota-a/images", { data: PNG.toString("base64") }))).toEqual([409, NOTE_ROUTE_ERRORS.tooManyImages]);
  });

  test("asset: nome fora do formato é 400; arquivo cujo conteúdo não é imagem é 404 (o tipo vem dos bytes)", async () => {
    const { routes, dir } = fresh();
    expect((routes.get(`${BASE}nota-a/assets/..%2Fnota-a.md`) as Response).status).toBe(400);
    mkdirSync(join(dir, "nota-a.assets"), { recursive: true });
    writeFileSync(join(dir, "nota-a.assets", "0123456789abcdef.png"), "<html>não é imagem</html>");
    expect((routes.get(`${BASE}nota-a/assets/0123456789abcdef.png`) as Response).status).toBe(404);
  });

  test("fechar apaga arquivo e imagens da pasta padrão; de local personalizado o arquivo fica e a entrada sai", async () => {
    const { routes, ext, dir } = fresh();
    await put(routes, "nota-a", "x");
    await post(routes, "nota-a/images", { data: PNG.toString("base64") });
    expect((await json(await post(routes, "nota-a/delete", {}))).deleted).toBe(true);
    expect(readdirSync(dir).filter((f) => f.startsWith("nota-a"))).toEqual([]);
    const path = join(ext, "Fica.md");
    writeFileSync(path, "meu");
    const linked = await json(await post(routes, "link", { path }));
    expect((await json(await post(routes, `${linked.name as string}/delete`, {}))).deleted).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("meu");
    expect(((await json(routes.list({}))).notes as Dict[]).map((x) => x.name)).toEqual([]);
  });
});
