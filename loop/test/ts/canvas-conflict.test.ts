// Grupo canvas-conflict: aba velha que grava depois de outra aba (reference/argos.md §Gravação e conflitos). Duas abas sobre a
// rota real do canvas padrão: a edição da aba velha não pode se perder em silêncio, e a recusa 409 sempre vai para o log.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCanvasDoc, type CanvasDoc, type CanvasNode } from "../../../src/lib/canvas-doc";
import { createDocSaver, rebaseDoc, type DocSaver, type SaveReply, type SaveStatus } from "../../../src/lib/canvas-store";
import { createCanvasRoutes, type CanvasRoutes } from "../../../src/panel/canvas";

const node = (id: string, x = 0): CanvasNode => ({ id, type: "note", x, y: 0, w: 100, h: 50, z: 0, data: {}, locked: false, blurred: false });
const docOf = (rev: number, nodes: CanvasNode[], edges: CanvasDoc["edges"] = []): CanvasDoc => ({ v: 1, rev, nodes, edges, groups: [] });
const link = (id: string, from: string, to: string): CanvasDoc["edges"][number] => ({ id, from, to, kind: "link" } as CanvasDoc["edges"][number]);

const T = mkdtempSync(join(tmpdir(), "hades-canvas-conflict-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

function logged<T>(run: () => Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    for (const line of String(chunk).split("\n")) if (line.startsWith("{")) lines.push(JSON.parse(line) as Record<string, unknown>);
    return true;
  }) as typeof process.stderr.write;
  return run().then((result) => ({ result, lines })).finally(() => { process.stderr.write = original; });
}

/** Uma aba: o gravador de verdade, falando com a rota de verdade (a mesma ligação que a página faz por fetch). */
function tab(routes: CanvasRoutes, rebase: boolean) {
  const statuses: SaveStatus[] = [];
  const stale: number[] = [];
  const rebased: CanvasDoc[] = [];
  const timers: (() => void)[] = [];
  const put = async (doc: CanvasDoc): Promise<SaveReply> => {
    const res = await routes.put(new Request("http://127.0.0.1/api/canvas", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) }), { remote: false });
    const body = (await res.json()) as { rev: number };
    return res.ok ? { kind: "saved", rev: body.rev } : res.status === 409 ? { kind: "stale", rev: body.rev } : { kind: "failed", code: "x" };
  };
  const saver: DocSaver = createDocSaver({
    put,
    setTimer: (run) => { timers.push(run); return timers.length; },
    clearTimer: () => {},
    onStatus: (s) => statuses.push(s),
    onStale: (rev) => stale.push(rev),
    ...(rebase ? { fetchServer: async () => readCanvasDoc(await routes.get().json()), onRebased: (doc: CanvasDoc) => rebased.push(doc) } : {}),
  });
  return { saver, statuses, stale, rebased };
}

let n = 0;
function fresh(): CanvasRoutes {
  const dir = join(T, `d${n++}`);
  mkdirSync(dir, { recursive: true });
  return createCanvasRoutes(dir);
}
const serverDoc = async (routes: CanvasRoutes): Promise<CanvasDoc> => readCanvasDoc(await routes.get().json());

describe("canvas-conflict: aba velha depois de gravação de outra aba", () => {
  test("dado 409, então a recusa vai para o log com a revisão enviada, a do servidor e se veio de fora", async () => {
    const routes = fresh();
    const a = tab(routes, true);
    a.saver.setRev(0);
    a.saver.schedule(docOf(0, [node("n1")]));
    await a.saver.flush();
    const { lines } = await logged(async () => {
      const old = tab(routes, false);
      old.saver.setRev(0);
      old.saver.schedule(docOf(0, [node("n2")]));
      await old.saver.flush();
    });
    expect(lines.find((l) => l.event === "canvas recusado")).toMatchObject({ level: "warn", canvas: "default", code: "canvas_stale_revision", sent: 0, rev: 1, remote: false });
  });

  test("dado outra aba gravou, então a edição da aba velha entra no servidor junto com a da outra aba", async () => {
    const routes = fresh();
    const remoteTab = tab(routes, true);
    remoteTab.saver.setRev(0);
    remoteTab.saver.schedule(docOf(0, [node("nota")]));
    await remoteTab.saver.flush();
    const seen = docOf(1, [node("nota")]);
    remoteTab.saver.schedule({ ...seen, nodes: [...seen.nodes, node("de-fora")] });
    await remoteTab.saver.flush();

    // a aba local leu o rev 1 e agora cria um terminal e liga à nota (a edição que sumia)
    const local = tab(routes, true);
    local.saver.setRev(1, seen);
    local.saver.schedule({ ...seen, nodes: [...seen.nodes, node("terminal")], edges: [link("e1", "terminal", "nota")] });
    await local.saver.flush();

    const server = await serverDoc(routes);
    expect(server.nodes.map((x) => x.id).sort()).toEqual(["de-fora", "nota", "terminal"]);
    expect(server.edges.map((x) => x.id)).toEqual(["e1"]);
    expect(local.stale).toEqual([]);
    expect(local.rebased).toHaveLength(1);
    expect(local.statuses.at(-1)).toEqual({ kind: "idle" });
  });

  test("dado o servidor apagou o nó que a aba ligou, então a aresta pendurada sai e o resto grava", () => {
    const base = docOf(1, [node("a"), node("b")]);
    const mine = { ...base, edges: [link("e1", "a", "b")] };
    const out = rebaseDoc(base, mine, docOf(2, [node("a")]));
    expect(out.edges).toEqual([]);
  });
});

describe("rebaseDoc: três vias por id", () => {
  const base = docOf(5, [node("a", 1), node("b", 2), node("c", 3)]);

  test("dado a aba mexeu em um nó e o servidor em outro, então os dois ficam", () => {
    const mine = docOf(5, [node("a", 10), node("b", 2), node("c", 3)]);
    const theirs = docOf(7, [node("a", 1), node("b", 20), node("c", 3)]);
    const out = rebaseDoc(base, mine, theirs);
    expect(out.rev).toBe(7);
    expect(out.nodes.map((x) => [x.id, x.x])).toEqual([["a", 10], ["b", 20], ["c", 3]]);
  });

  test("dado o servidor criou nó que a aba não conhece, então ele não é apagado", () => {
    const out = rebaseDoc(base, base, docOf(7, [...base.nodes, node("novo")]));
    expect(out.nodes.map((x) => x.id)).toEqual(["a", "b", "c", "novo"]);
  });

  test("dado a aba apagou um nó que o servidor não tocou, então ele sai; se o servidor o mexeu, ele fica (nada se perde)", () => {
    const mine = docOf(5, [node("a", 1), node("c", 3)]);
    expect(rebaseDoc(base, mine, docOf(7, base.nodes)).nodes.map((x) => x.id)).toEqual(["a", "c"]);
    expect(rebaseDoc(base, mine, docOf(7, [node("a", 1), node("b", 99), node("c", 3)])).nodes.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  test("dado o servidor apagou um nó que a aba não tocou, então ele sai; se a aba o mexeu, a aba vence", () => {
    const theirs = docOf(7, [node("a", 1), node("c", 3)]);
    expect(rebaseDoc(base, base, theirs).nodes.map((x) => x.id)).toEqual(["a", "c"]);
    expect(rebaseDoc(base, docOf(5, [node("a", 1), node("b", 50), node("c", 3)]), theirs).nodes.map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  test("dado base desconhecida, então nada do servidor se apaga e a aba vence nos ids em comum", () => {
    const out = rebaseDoc(undefined, docOf(5, [node("a", 10)]), docOf(7, [node("a", 1), node("z", 4)]));
    expect(out.nodes.map((x) => [x.id, x.x])).toEqual([["a", 10], ["z", 4]]);
  });

  test("dado arestas e ocultos, então seguem a mesma regra", () => {
    const b = { ...docOf(5, [node("a")], [link("e1", "a", "a")]), hidden: ["a"] };
    const mine = { ...b, edges: [...b.edges, link("e2", "a", "a")] };
    const theirs = { ...docOf(6, [node("a")], b.edges), hidden: [] as string[] };
    const out = rebaseDoc(b, mine, theirs);
    expect(out.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(out.hidden ?? []).toEqual([]);
  });
});

describe("canvas-conflict: edição durante o rebase e a fiação da página", () => {
  test("dado nova edição agendada enquanto o gravador relê o servidor, então ela também é reconciliada e nada do servidor se apaga", async () => {
    const routes = fresh();
    const seen = docOf(1, [node("nota")]);
    const other = tab(routes, true);
    other.saver.setRev(0);
    other.saver.schedule(docOf(0, [node("nota")]));
    await other.saver.flush();
    other.saver.schedule({ ...seen, nodes: [...seen.nodes, node("de-fora")] });
    await other.saver.flush();

    const sent: CanvasDoc[] = [];
    let saver: DocSaver;
    const timers: (() => void)[] = [];
    saver = createDocSaver({
      put: async (doc) => {
        sent.push(doc);
        const res = await routes.put(new Request("http://127.0.0.1/api/canvas", { method: "PUT", body: JSON.stringify(doc) }), { remote: false });
        const body = (await res.json()) as { rev: number };
        return res.ok ? { kind: "saved", rev: body.rev } : { kind: "stale", rev: body.rev };
      },
      setTimer: (run) => { timers.push(run); return 1; },
      clearTimer: () => {},
      onStatus: () => {},
      onStale: () => {},
      fetchServer: async () => {
        saver.schedule({ ...seen, nodes: [...seen.nodes, node("primeira"), node("segunda")] });
        return readCanvasDoc(await routes.get().json());
      },
    });
    saver.setRev(1, seen);
    saver.schedule({ ...seen, nodes: [...seen.nodes, node("primeira")] });
    await saver.flush();
    expect((await serverDoc(routes)).nodes.map((x) => x.id).sort()).toEqual(["de-fora", "nota", "primeira", "segunda"]);
  });

  test("dado a página, então o gravador recebe fetchServer, onRebased e a base lida (sem isso a aba descarta no 409)", () => {
    const page = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/pages/argos.tsx"), "utf8");
    expect(page).toContain("fetchServer: () => getCanvas(");
    expect(page).toContain("onRebased: (doc)");
    expect(page).toContain("saver.setRev(doc.rev, doc)");
  });
});
