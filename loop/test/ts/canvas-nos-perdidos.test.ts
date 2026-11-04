// Grupo canvas-nos: nó só sai do canvas por ação do dono ou com o grafo confiável, e um pane é um nó só
// (reference/argos.md §Quando um nó sai do canvas e §Órfãos). Regressão das issues de nós que sumiam e de terminal duplicado.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_ERRORS, emptyCanvasDoc, HELD_REASONS, mergeWithGraph, paneKey, readCanvasDoc, removalsBetween, type CanvasDoc, type CanvasNode } from "../../../src/lib/canvas-doc";
import { createDocSaver, initialCanvasState, reconcileGraph, type SaveReply } from "../../../src/lib/canvas-store";
import { opUpdate, perform } from "../../../src/lib/canvas-history";
import { FREE_LAYOUT } from "../../../src/lib/canvas-layout";
import { planReassign } from "../../../src/lib/canvas-recruit";
import { createAbsenceTracker, syncWithGraph, type GraphSnapshot, type SyncOptions } from "../../../src/lib/canvas-sync";
import { createCanvasRoutes, type CanvasRoutes } from "../../../src/panel/canvas";

const SIZE = { w: 200, h: 66 };
const node = (id: string, type: string, data: Record<string, unknown> = {}, x = 0): CanvasNode => ({ id, type, x, y: 0, ...SIZE, z: 0, data, locked: false, blurred: false });
const live = (name: string, x = 0): CanvasNode => node(`agent:p:${name}`, "agent", {}, x);
const note = (name: string): CanvasNode => node(`note-${name}`, "note", { note: name });
const terminal = (id: string, pane: string): CanvasNode => node(id, "terminal", { name: id, herdr: { session: "default", pane } });
const docOf = (nodes: CanvasNode[], edges: CanvasDoc["edges"] = [], rev = 4): CanvasDoc => ({ ...emptyCanvasDoc(), rev, nodes, edges });
const snapshot = (ids: string[], herdr: Record<string, string> = {}): GraphSnapshot => ({
  nodes: ids.map((id) => ({ id, type: id.split(":")[0] as string, ...(herdr[id] ? { herdr: { session: "default", pane: herdr[id] } } : {}) })),
  edges: [],
});
const options: SyncOptions = { layout: FREE_LAYOUT, sizeOf: () => ({ ...SIZE }) };
const ids = (doc: CanvasDoc): string[] => doc.nodes.map((n) => n.id);

describe("canvas-nos: grafo vazio ou parcial não leva nó vivo embora", () => {
  const five = (): CanvasDoc => docOf([live("a"), live("b"), live("c"), live("d"), live("e"), note("n1"), terminal("terminal:t1", "w1:p1")]);
  const all = ["agent:p:a", "agent:p:b", "agent:p:c", "agent:p:d", "agent:p:e"];

  test("dado grafo vazio numa leitura e completo na seguinte, então nenhum nó é removido", () => {
    const tracker = createAbsenceTracker();
    const first = syncWithGraph(five(), snapshot([]), { ...options, absence: tracker });
    expect(first.changed).toBe(false);
    expect(first.removed).toEqual([]);
    expect(first.heldReason).toBe(HELD_REASONS.empty);
    expect(first.held).toEqual(all);
    const second = syncWithGraph(first.doc, snapshot(all), { ...options, absence: tracker });
    expect(second.changed).toBe(false);
    expect(ids(second.doc)).toEqual(ids(five()));
  });

  test("dado grafo parcial (um de cinco) e depois completo, então nenhum nó é removido e as notas ficam", () => {
    const tracker = createAbsenceTracker();
    const partial = syncWithGraph(five(), snapshot(["agent:p:a"]), { ...options, absence: tracker });
    expect(partial.heldReason).toBe(HELD_REASONS.partial);
    expect(partial.removed).toEqual([]);
    const full = syncWithGraph(partial.doc, snapshot(all), { ...options, absence: tracker });
    expect(ids(full.doc)).toEqual(ids(five()));
  });

  test("dado leitura marcada sem confiança, então nada sai mesmo com o grafo quase completo", () => {
    const result = syncWithGraph(five(), snapshot(all.slice(0, 4)), { ...options, trusted: false });
    expect(result.removed).toEqual([]);
    expect(result.heldReason).toBe(HELD_REASONS.untrusted);
  });

  test("dado nó que falta numa leitura só, então fica; faltando em duas seguidas, então sai", () => {
    const tracker = createAbsenceTracker();
    const without = snapshot(all.slice(0, 4));
    const once = syncWithGraph(five(), without, { ...options, absence: tracker });
    expect(once.removed).toEqual([]);
    expect(once.held).toEqual(["agent:p:e"]);
    const back = syncWithGraph(once.doc, snapshot(all), { ...options, absence: tracker });
    const again = syncWithGraph(back.doc, snapshot(all.slice(0, 4)), { ...options, absence: tracker });
    expect(again.removed).toEqual([]);
    const twice = syncWithGraph(again.doc, snapshot(all.slice(0, 4)), { ...options, absence: tracker });
    expect(twice.removed).toEqual(["agent:p:e"]);
    expect(ids(twice.doc)).not.toContain("agent:p:e");
    expect(ids(twice.doc)).toContain("note-n1");
  });

  test("dado a mesma leitura sincronizada duas vezes, então conta uma leitura só", () => {
    const tracker = createAbsenceTracker();
    const read = snapshot(all.slice(0, 4));
    const first = syncWithGraph(five(), read, { ...options, absence: tracker });
    const repeated = syncWithGraph(first.doc, read, { ...options, absence: tracker });
    expect(repeated.removed).toEqual([]);
  });

  test("dado um nó vivo que saiu do grafo de verdade, então sai sem levar nota nem terminal", () => {
    const result = mergeWithGraph(five(), snapshot(all.slice(0, 4)).nodes);
    expect(result.removed).toEqual(["agent:p:e"]);
    expect(ids(result.doc)).toEqual(["agent:p:a", "agent:p:b", "agent:p:c", "agent:p:d", "note-n1", "terminal:t1"]);
  });
});

describe("canvas-nos: gravação concorrente não perde nota", () => {
  const T = mkdtempSync(join(tmpdir(), "hades-canvas-nos-"));
  afterAll(() => rmSync(T, { recursive: true, force: true }));
  let n = 0;
  const fresh = (): { dir: string; routes: CanvasRoutes } => {
    const dir = join(T, `d${n++}`);
    mkdirSync(dir, { recursive: true });
    return { dir, routes: createCanvasRoutes(dir) };
  };
  const put = (routes: CanvasRoutes, doc: CanvasDoc, headers: Record<string, string> = {}): Promise<Response> =>
    routes.put(new Request("http://127.0.0.1/api/canvas", { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(doc) }), { remote: false });
  const serverDoc = async (routes: CanvasRoutes): Promise<CanvasDoc> => readCanvasDoc(await routes.get().json());
  function logged<T>(run: () => Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[] }> {
    const lines: Record<string, unknown>[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      for (const line of String(chunk).split("\n")) if (line.startsWith("{")) lines.push(JSON.parse(line) as Record<string, unknown>);
      return true;
    }) as typeof process.stderr.write;
    return run().then((result) => ({ result, lines })).finally(() => { process.stderr.write = original; });
  }

  test("dado duas gravações com a mesma revisão de base, então a segunda é recusada e a nota da primeira fica", async () => {
    const { routes } = fresh();
    const base = await serverDoc(routes);
    expect((await put(routes, { ...base, nodes: [note("primeira")] })).status).toBe(200);
    const second = await put(routes, { ...base, nodes: [note("segunda")] });
    expect(second.status).toBe(409);
    expect(ids(await serverDoc(routes))).toEqual(["note-primeira"]);
  });

  test("dado aba velha sem a nota nova, então o gravador reaplica a edição sobre o servidor e a nota fica", async () => {
    const { routes } = fresh();
    const seed = await serverDoc(routes);
    await put(routes, { ...seed, nodes: [live("a")] });
    const stale = await serverDoc(routes);
    await put(routes, { ...stale, nodes: [...stale.nodes, note("nova")] });
    const timers: (() => void)[] = [];
    const saver = createDocSaver({
      put: async (doc): Promise<SaveReply> => {
        const res = await put(routes, doc);
        const body = (await res.json()) as { rev: number };
        return res.ok ? { kind: "saved", rev: body.rev } : res.status === 409 ? { kind: "stale", rev: body.rev } : { kind: "failed", code: "x" };
      },
      setTimer: (run) => { timers.push(run); return timers.length; },
      clearTimer: () => {},
      onStatus: () => {},
      onStale: () => {},
      fetchServer: () => serverDoc(routes),
    });
    saver.setRev(stale.rev, stale);
    saver.schedule({ ...stale, nodes: [{ ...(stale.nodes[0] as CanvasNode), x: 300 }] });
    await saver.flush();
    const final = await serverDoc(routes);
    expect(ids(final).sort()).toEqual(["agent:p:a", "note-nova"]);
    expect(final.nodes.find((x) => x.id === "agent:p:a")?.x).toBe(300);
  });

  /** O canvas da evidência: 20 agentes, 6 notas, 4 terminais e 10 arestas, depois uma gravação que fica com 20 agentes e 2 terminais. */
  async function seeded(routes: CanvasRoutes): Promise<{ full: CanvasDoc; reduced: CanvasDoc }> {
    const agents = Array.from({ length: 20 }, (_, i) => live(`a${i}`, i * 10));
    const notes = Array.from({ length: 6 }, (_, i) => note(`n${i}`));
    const terminals = Array.from({ length: 4 }, (_, i) => terminal(`terminal:t${i}`, `w${i}:p1`));
    const edges = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, from: (notes[i % 6] as CanvasNode).id, to: (terminals[i % 4] as CanvasNode).id, kind: "link" }));
    const base = await serverDoc(routes);
    expect((await put(routes, { ...base, nodes: [...agents, ...notes, ...terminals], edges })).status).toBe(200);
    const full = await serverDoc(routes);
    const reduced: CanvasDoc = { ...full, nodes: [...agents, terminals[0] as CanvasNode, terminals[1] as CanvasNode], edges: [], groups: [] };
    return { full, reduced };
  }

  test("dado gravação que tira de uma vez a maior parte das notas e terminais, então é recusada e o documento não muda", async () => {
    const { dir, routes } = fresh();
    const { full, reduced } = await seeded(routes);
    const { result, lines } = await logged(() => put(routes, reduced, { "x-canvas-cause": "user", "x-canvas-graph-size": "20" }));
    expect(result.status).toBe(422);
    expect(((await result.json()) as { code: string }).code).toBe(CANVAS_ERRORS.massRemoval);
    expect(await serverDoc(routes)).toEqual(full);
    expect(existsSync(join(dir, "canvas-trash"))).toBe(false);
    const refused = lines.find((line) => line.event === "canvas remoção recusada");
    expect(refused).toMatchObject({ canvas: "default", cause: "user", overwritten_rev: full.rev, nodes_before: 30, nodes_after: 22, removed_user_nodes: 8, graph_nodes: 20, code: CANVAS_ERRORS.massRemoval });
  });

  test("dado a mesma remoção com a confirmação do dono, então grava, guarda a versão sobrescrita e registra a causa", async () => {
    const { dir, routes } = fresh();
    const { full, reduced } = await seeded(routes);
    const { result, lines } = await logged(() => put(routes, reduced, { "x-canvas-cause": "user", "x-canvas-confirm-removal": "1" }));
    expect(result.status).toBe(200);
    const kept = readdirSync(join(dir, "canvas-trash"));
    expect(kept).toEqual([`default-rev${String(full.rev).padStart(10, "0")}.json`]);
    expect(readCanvasDoc(JSON.parse(readFileSync(join(dir, "canvas-trash", kept[0] as string), "utf8")))).toEqual(full);
    expect(lines.find((line) => line.event === "canvas remoção")).toMatchObject({ cause: "user", overwritten_rev: full.rev, removed_user_nodes: 8, removed_edges: 10, rev: full.rev + 1 });
  });

  test("dado remoção pequena de nota pelo dono, então grava sem confirmação e fica no diário", async () => {
    const { routes } = fresh();
    const { full } = await seeded(routes);
    const without = { ...full, nodes: full.nodes.filter((x) => x.id !== "note-n0"), edges: full.edges.filter((e) => e.from !== "note-n0") };
    const { result, lines } = await logged(() => put(routes, without));
    expect(result.status).toBe(200);
    expect(lines.find((line) => line.event === "canvas remoção")).toMatchObject({ cause: "unknown", removed_user_nodes: 1, ids: "note:note-n0" });
  });

  test("dado 22 remoções de nota seguidas, então o canvas-trash guarda só as 20 versões mais novas", async () => {
    const { dir, routes } = fresh();
    const notes = Array.from({ length: 22 }, (_, i) => note(`n${i}`));
    const base = await serverDoc(routes);
    expect((await put(routes, { ...base, nodes: notes })).status).toBe(200);
    const revs: number[] = [];
    for (const gone of notes) {
      const current = await serverDoc(routes);
      revs.push(current.rev);
      expect((await put(routes, { ...current, nodes: current.nodes.filter((x) => x.id !== gone.id) })).status).toBe(200);
    }
    const kept = readdirSync(join(dir, "canvas-trash")).sort();
    expect(kept).toHaveLength(20);
    expect(kept).toEqual(revs.slice(-20).map((rev) => `default-rev${String(rev).padStart(10, "0")}.json`));
  });

  test("dado remoção só de nó vivo, então a causa registrada é o grafo e nenhuma versão é guardada", async () => {
    const { dir, routes } = fresh();
    const { full } = await seeded(routes);
    const without = { ...full, nodes: full.nodes.filter((x) => x.id !== "agent:p:a0") };
    const { lines } = await logged(() => put(routes, without, { "x-canvas-graph-size": "19" }));
    expect(lines.find((line) => line.event === "canvas remoção")).toMatchObject({ cause: "graph", graph_nodes: 19, removed_user_nodes: 0 });
    expect(existsSync(join(dir, "canvas-trash"))).toBe(false);
  });

  test("removalsBetween lista nós e arestas que sumiram, e só eles", () => {
    const before = docOf([note("a"), note("b")], [{ id: "e1", from: "note-a", to: "note-b", kind: "link" }]);
    const after = docOf([note("a")]);
    expect(removalsBetween(before, after)).toEqual({ nodes: [{ id: "note-b", type: "note" }], edges: ["e1"] });
  });
});

describe("canvas-nos: um pane do herdr é um nó só", () => {
  const PANE = "w9:p1";
  const agentId = "agent:p:novo";

  test("dado terminal criado no canvas e depois agent adopt do mesmo pane, então o agente não ganha nó próprio", () => {
    const doc = docOf([terminal("terminal:t1", PANE)]);
    const result = syncWithGraph(doc, snapshot([agentId], { [agentId]: PANE }), options);
    expect(result.changed).toBe(false);
    expect(result.added).toEqual([]);
    expect(result.claimed).toEqual({ [agentId]: "terminal:t1" });
    expect(ids(result.doc)).toEqual(["terminal:t1"]);
  });

  test("dado grafo lido no meio da criação (agente do pane antes do terminal gravado), então o terminal gravado depois fica sozinho", () => {
    const midway = syncWithGraph(docOf([]), snapshot([agentId], { [agentId]: PANE }), options);
    expect(ids(midway.doc)).toEqual([agentId]);
    const withTerminal: CanvasDoc = { ...midway.doc, nodes: [...midway.doc.nodes, terminal("terminal:t1", PANE)] };
    const settled = syncWithGraph(withTerminal, snapshot([agentId], { [agentId]: PANE }), options);
    expect(ids(settled.doc)).toEqual(["terminal:t1"]);
    expect(settled.duplicates).toEqual([agentId]);
    const again = syncWithGraph(settled.doc, snapshot([agentId], { [agentId]: PANE }), options);
    expect(again.changed).toBe(false);
    expect(ids(again.doc)).toEqual(["terminal:t1"]);
  });

  test("dado pane de outro agente, então o agente do pane diferente segue com o nó próprio", () => {
    const doc = docOf([terminal("terminal:t1", PANE)]);
    const result = syncWithGraph(doc, snapshot([agentId], { [agentId]: "w2:p9" }), options);
    expect(result.added).toEqual([agentId]);
    expect(Object.keys(result.claimed)).toEqual([]);
  });

  test("dado o estado do canvas, então reconcileGraph repassa o que foi reivindicado e mantém um nó por pane", () => {
    const state = initialCanvasState(docOf([terminal("terminal:t1", PANE), note("n")]));
    const result = reconcileGraph(state, snapshot([agentId], { [agentId]: PANE }), options);
    expect(result.claimed).toEqual({ [agentId]: "terminal:t1" });
    expect(result.state.doc.nodes).toHaveLength(2);
  });

  test("dado reassign do recruta, então é o mesmo nó (id, pane e posição) e a sincronia não cria outro", () => {
    const recruit = terminal("terminal:r1", PANE);
    const doc = docOf([{ ...recruit, data: { ...recruit.data, recruiter: "terminal:orq" } }, terminal("terminal:orq", "w1:p1")]);
    const op = planReassign(doc, "terminal:r1", "revisor");
    expect(op).toBeDefined();
    const after = perform({ past: [], future: [], limit: 100 }, doc, op as NonNullable<typeof op>).doc;
    const same = after.nodes.find((x) => x.id === "terminal:r1") as CanvasNode;
    expect(after.nodes).toHaveLength(doc.nodes.length);
    expect(same.data).toMatchObject({ role: "revisor", herdr: { session: "default", pane: PANE } });
    const synced = syncWithGraph(after, snapshot([agentId], { [agentId]: PANE }), options);
    expect(synced.added).toEqual([]);
    expect(ids(synced.doc)).toEqual(ids(after));
  });

  test("a chave de identidade por pane junta sessão e pane sem confundir pares diferentes", () => {
    expect(paneKey({ session: "default", pane: "w1:p1" })).toBe(paneKey({ session: "default", pane: "w1:p1" }));
    expect(paneKey({ session: "a", pane: "b:p1" })).not.toBe(paneKey({ session: "a:b", pane: "p1" }));
  });

  test("opUpdate mantém o nó no lugar (base do reassign)", () => {
    const doc = docOf([terminal("terminal:t1", PANE)]);
    const after = perform({ past: [], future: [], limit: 100 }, doc, opUpdate(doc, "terminal:t1", { name: "x", herdr: { session: "default", pane: PANE } })).doc;
    expect(ids(after)).toEqual(["terminal:t1"]);
  });
});

describe("canvas-nos: a página liga as defesas", () => {
  const page = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/pages/argos.tsx"), "utf8");

  test("o grafo lido leva o pane do herdr, o rastreador de ausência e a confiança à sincronia", () => {
    expect(page).toContain("...(n.herdr ? { herdr: n.herdr } : {})");
    expect(page).toContain("absence, trusted: !loadError");
    expect(page).toContain("M.sync.createAbsenceTracker()");
  });

  test("o PUT leva causa, tamanho do grafo e a confirmação só de apagar de propósito", () => {
    expect(page).toContain("'X-Canvas-Cause'");
    expect(page).toContain("'X-Canvas-Graph-Size'");
    expect(page).toContain("'X-Canvas-Confirm-Removal': '1'");
    expect(page).toContain("confirmRemoval: deletesNodes(op)");
    expect(page).toContain("commit(next, { cause: 'undo' })");
  });
});
