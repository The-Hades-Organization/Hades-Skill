// Grupo canvas-drawings-route: rotas do desenho (src/panel/canvas-drawings.ts) sobre o canvas real em disco — leitura estruturada e
// SVG, edição em lote com revisão, e quem pode o quê (dono, ligado direto escreve, cadeia só lê, não ligado é 404, agente só local).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CanvasDoc, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { LINK_EDGE_KIND } from "../../../src/lib/canvas-links";
import { createCanvasDrawingsRoutes, DRAWING_EDITS_PER_CALL } from "../../../src/panel/canvas-drawings";
import { createCanvasRoutes } from "../../../src/panel/canvas";

type Dict = Record<string, unknown>;
const AGENT = "t1";
const box = (id: string, type: string, data: Dict): Dict => ({ id, type, x: 0, y: 0, w: 300, h: 200, z: 0, data, locked: false, blurred: false });
const scene = (): Dict => ({ v: 1, elements: [{ id: "e1", type: "rect", x: 0, y: 0, w: 10, h: 10 }, { id: "e2", type: "text", x: 5, y: 5, text: "oi" }] });
const link = (id: string, from: string, to: string): Dict => ({ id, from, to, kind: LINK_EDGE_KIND });
const DOC: CanvasDoc = validateCanvasDoc({
  v: 1, rev: 0,
  nodes: [box("t1", "terminal", { name: "t" }), box("d1", "drawing", scene()), box("d2", "drawing", scene()), box("d3", "drawing", scene())],
  edges: [link("l1", "t1", "d1"), link("l2", "d1", "d2")],
  groups: [],
});

const T = mkdtempSync(join(tmpdir(), "hades-drawings-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const BASE = "/api/canvas-drawings/default";
const local = { remote: false };
const json = async (res: Response): Promise<Dict> => (await res.json()) as Dict;
const post = (path: string, body: unknown): Request => new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

let n = 0;
async function fresh() {
  const D = join(T, `d${n++}`);
  mkdirSync(D, { recursive: true });
  const canvas = createCanvasRoutes(D);
  const put = await canvas.put(new Request("http://127.0.0.1/api/canvas", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(DOC) }), local);
  expect(put.status).toBe(200);
  const loadDoc = async (): Promise<CanvasDoc> => validateCanvasDoc(await canvas.get().json());
  const routes = createCanvasDrawingsRoutes({ loadDoc, patchNodeData: (id, node, rev, check, data) => canvas.patchNodeData(id, node, rev, check, data) });
  const rev = async (): Promise<number> => (await loadDoc()).rev;
  const edit = async (node: string, edits: unknown[], as?: string, caller = local, atRev?: number): Promise<Response> =>
    (routes.post(`${BASE}/${node}/edit`, post(`${BASE}/${node}/edit`, { rev: atRev ?? (await rev()), edits, ...(as ? { as: { agent: as } } : {}) }), caller) as Promise<Response>);
  const get = (path: string, query: Record<string, string> = {}, caller = local) => routes.get(`${BASE}${path}`, query, caller) as Promise<Response>;
  return { routes, edit, get, rev, loadDoc };
}

describe("canvas-drawings-route", () => {
  test("caminho de outra família não é desta rota", () => {
    const rig = { routes: createCanvasDrawingsRoutes({ loadDoc: async () => DOC, patchNodeData: () => ({ ok: false, reason: "not_found" }) }) };
    expect(rig.routes.get("/api/canvas-notes/x", {}, local)).toBeUndefined();
    expect(rig.routes.post("/api/canvas-notes/x/edit", post("/x", {}), local)).toBeUndefined();
  });

  test("dono lê o desenho estruturado e em SVG, e a listagem traz os três", async () => {
    const { get } = await fresh();
    const read = await json(await get("/d1"));
    expect(((read.drawing as Dict).elements as unknown[]).length).toBe(2);
    expect(typeof (await json(await get("/d1/svg"))).svg).toBe("string");
    expect(((await json(await get(""))).drawings as unknown[]).length).toBe(3);
  });

  test("dono edita em lote: add, move, texto e remove gravam com rev+1", async () => {
    const { edit, get, rev } = await fresh();
    const before = await rev();
    const res = await edit("d1", [{ op: "add", element: { type: "ellipse", x: 1, y: 1, w: 4, h: 4 } }, { op: "move", id: "e1", dx: 3, dy: 0 }, { op: "text", id: "e2", text: "novo" }, { op: "remove", id: "e1" }]);
    expect([res.status, (await json(res)).rev]).toEqual([200, before + 1]);
    const elements = ((await json(await get("/d1"))).drawing as Dict).elements as Dict[];
    expect(elements.map((el) => el.type)).toEqual(["text", "ellipse"]);
    expect(elements[0]?.text).toBe("novo");
  });

  test("agente ligado direto escreve; cadeia lê mas não escreve; não ligado é 404 nos dois", async () => {
    const { edit, get } = await fresh();
    expect((await edit("d1", [{ op: "text", id: "e2", text: "agente" }], AGENT)).status).toBe(200);
    const chain = await edit("d2", [{ op: "text", id: "e2", text: "x" }], AGENT);
    expect([chain.status, (await json(chain)).code]).toEqual([404, "drawing_not_found"]);
    expect((await get("/d2", { as: AGENT })).status).toBe(200);
    expect((await get("/d3", { as: AGENT })).status).toBe(404);
    expect((await edit("d3", [{ op: "text", id: "e2", text: "x" }], AGENT)).status).toBe(404);
    expect((await get("/d3")).status).toBe(200);
  });

  test("agente por acesso remoto é 403, e a listagem do agente só traz o alcançável", async () => {
    const { edit, get } = await fresh();
    const res = await edit("d1", [{ op: "text", id: "e2", text: "x" }], AGENT, { remote: true });
    expect([res.status, (await json(res)).code]).toEqual([403, "drawing_agent_local_only"]);
    expect((await get("", { as: AGENT }, { remote: true })).status).toBe(403);
    expect((((await json(await get("", { as: AGENT }))).drawings) as Dict[]).map((d) => d.id)).toEqual(["d1", "d2"]);
  });

  test("revisão antiga é 409 e nada grava; edição inválida é 400 com código e nada grava", async () => {
    const { edit, rev, get } = await fresh();
    const stale = await edit("d1", [{ op: "remove", id: "e1" }], undefined, local, 99);
    expect([stale.status, (await json(stale)).code]).toEqual([409, "drawing_stale_revision"]);
    const bad = await edit("d1", [{ op: "remove", id: "e1" }, { op: "remove", id: "nao-existe" }]);
    expect([bad.status, (await json(bad)).code]).toEqual([400, "drawing_missing_element"]);
    expect(await rev()).toBe(1);
    expect((((await json(await get("/d1"))).drawing as Dict).elements as unknown[]).length).toBe(2);
  });

  test("corpo malformado, lote vazio e lote acima do limite são 400; corpo grande é 413", async () => {
    const { routes, edit } = await fresh();
    expect((await edit("d1", [])).status).toBe(400);
    expect((await edit("d1", Array.from({ length: DRAWING_EDITS_PER_CALL + 1 }, () => ({ op: "remove", id: "e1" })))).status).toBe(400);
    const junk = (await routes.post(`${BASE}/d1/edit`, post(`${BASE}/d1/edit`, "{nao json"), local)) as Response;
    expect(junk.status).toBe(400);
    const big = (await routes.post(`${BASE}/d1/edit`, post(`${BASE}/d1/edit`, JSON.stringify({ rev: 1, edits: [{ op: "text", id: "e2", text: "x".repeat(400_000) }] })), local)) as Response;
    expect(big.status).toBe(413);
  });
});
