// Grupo canvas-remover-terminal: tirar do canvas o nó de um terminal encerrado quando outro escritor mexeu no mesmo nó
// (reference/argos.md §Criar e fechar terminal pelo canvas). Gravador de verdade sobre a rota de verdade.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCanvasDoc, type CanvasDoc, type CanvasNode } from "../../../src/lib/canvas-doc";
import { createDocSaver, rebaseDoc, type DocSaver, type SaveReply } from "../../../src/lib/canvas-store";
import { createCanvasRoutes, type CanvasRoutes } from "../../../src/panel/canvas";

const term = (id: string, x = 0): CanvasNode => ({ id, type: "terminal", x, y: 0, w: 100, h: 50, z: 0, data: { name: id }, locked: false, blurred: false });
const docOf = (rev: number, nodes: CanvasNode[]): CanvasDoc => ({ v: 1, rev, nodes, edges: [], groups: [] });
const ids = (doc: CanvasDoc): string[] => doc.nodes.map((n) => n.id).sort();

const T = mkdtempSync(join(tmpdir(), "hades-canvas-remover-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));
let n = 0;

function tab(routes: CanvasRoutes): DocSaver {
  const put = async (doc: CanvasDoc): Promise<SaveReply> => {
    const res = await routes.put(new Request("http://127.0.0.1/api/canvas", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) }), { remote: false });
    const body = (await res.json()) as { rev: number };
    return res.ok ? { kind: "saved", rev: body.rev } : res.status === 409 ? { kind: "stale", rev: body.rev } : { kind: "failed", code: "x" };
  };
  return createDocSaver({
    put, setTimer: () => 0, clearTimer: () => {}, onStatus: () => {}, onStale: () => {},
    fetchServer: async () => readCanvasDoc(await routes.get().json()),
  });
}

/** Duas abas com t1 e t2 gravados; a outra aba move t1 (o servidor "mexeu no nó") antes da remoção da primeira. */
async function scene(): Promise<{ routes: CanvasRoutes; mine: DocSaver; base: CanvasDoc }> {
  const dir = join(T, `d${n++}`);
  mkdirSync(dir, { recursive: true });
  const routes = createCanvasRoutes(dir);
  const mine = tab(routes);
  mine.setRev(0);
  mine.schedule(docOf(0, [term("t1"), term("t2")]));
  await mine.flush();
  const base = readCanvasDoc(await routes.get().json());
  mine.setRev(base.rev, base);
  const other = tab(routes);
  other.setRev(base.rev, base);
  other.schedule({ ...base, nodes: base.nodes.map((node) => (node.id === "t1" ? { ...node, x: 50 } : node)) });
  await other.flush();
  return { routes, mine, base };
}
const server = async (routes: CanvasRoutes): Promise<CanvasDoc> => readCanvasDoc(await routes.get().json());

describe("canvas-remover-terminal: remoção do dono contra escritor que mexeu no nó", () => {
  test("dado o nó mexido por outro escritor e forget, então um envio só deixa o servidor sem o nó", async () => {
    const { routes, mine, base } = await scene();
    mine.forget(["t1"]);
    mine.schedule({ ...base, nodes: base.nodes.filter((node) => node.id !== "t1") });
    await mine.flush();
    expect(ids(await server(routes))).toEqual(["t2"]);
  });

  test("dado o nó mexido por outro escritor e sem forget, então o servidor ainda o tem (a causa medida)", async () => {
    const { routes, mine, base } = await scene();
    mine.schedule({ ...base, nodes: base.nodes.filter((node) => node.id !== "t1") });
    await mine.flush();
    expect(ids(await server(routes))).toEqual(["t1", "t2"]);
  });

  test("dado forget de id que já não existe, então a gravação segue normal (idempotente)", async () => {
    const { routes, mine, base } = await scene();
    mine.forget(["t1", "nunca-existiu"]);
    mine.schedule({ ...base, nodes: base.nodes.filter((node) => node.id !== "t1") });
    await mine.flush();
    mine.schedule({ ...(await server(routes)), nodes: [term("t2")] });
    await mine.flush();
    expect(ids(await server(routes))).toEqual(["t2"]);
  });

  test("dado rebaseDoc com dropped, então o nó mexido pelo servidor sai e a aresta dele cai", () => {
    const base = docOf(1, [term("t1"), term("t2")]);
    const theirs = { ...docOf(2, [term("t1", 9), term("t2")]), edges: [{ id: "e", from: "t1", to: "t2", kind: "link" } as CanvasDoc["edges"][number]] };
    const merged = rebaseDoc(base, docOf(1, [term("t2")]), theirs, new Set(["t1"]));
    expect(ids(merged)).toEqual(["t2"]);
    expect(merged.edges).toEqual([]);
  });
});

describe("tela do Argos: remoção de nó de terminal", () => {
  const page = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/pages/argos.tsx"), "utf8");
  const body = page.slice(page.indexOf("const removeTermNodes = async"), page.indexOf("const termRemoveEnded = async"));
  test("dado removeTermNodes, então registra a remoção e o toast de falha diz o código do servidor", () => {
    expect(body).toContain("saver.forget(present)");
    expect(body).toContain("removeFailText(saveCode)");
    expect(body).not.toContain("Use \"Remover do canvas\" no nó para tentar de novo.'");
  });
});
