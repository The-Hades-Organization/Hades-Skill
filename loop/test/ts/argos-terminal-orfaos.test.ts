// Grupo argos-terminal-orfaos: terminal criado pelo canvas que ficou fora do canvas.json (reference/argos.md §Terminal fora do
// canvas). A criação só termina com o nó no documento (reler, reaplicar e gravar de novo, até 3 vezes) e o terminal registrado,
// vivo e sem nó em canvas nenhum aparece como órfão, com a ação "Trazer para o canvas".
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_UI_BUNDLE, createCanvasModuleBundler, createUiTranspiler } from "../../../src/panel/ui-transpile";
import { createCanvasRoutes } from "../../../src/panel/canvas";
import { createArgosTerminalsRoutes } from "../../../src/panel/argos-terminals";

type Dict = Record<string, any>;
const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
const T = mkdtempSync(join(tmpdir(), "hades-terminal-orfaos-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

let loaded: Promise<Dict> | null = null;
function load(): Promise<Dict> {
  loaded ??= (async () => {
    const mod: { exports: any } = { exports: {} };
    new Function("exports", "module", readFileSync(join(uiDir, "vendor/react.js"), "utf8"))(mod.exports, mod);
    const React = mod.exports;
    const bundle = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const holder: Dict = {};
    new Function("globalThis", bundle as string)(holder);
    const stub = (tag: string) => (p: object) => React.createElement(tag, p);
    const HadesCore = {
      useState: (v: unknown) => [v, () => undefined], useEffect: () => undefined, useRef: (v: unknown) => ({ current: v }), useCallback: (fn: unknown) => fn,
      useMemo: (fn: () => unknown) => fn(), cn: (...a: unknown[]) => a.filter(Boolean).join(" "), I: new Proxy({}, { get: () => stub("svg") }),
      post: () => Promise.reject(new Error("sem rede")), getJSON: () => Promise.reject(new Error("sem rede")),
      Button: stub("button"), Dot: stub("span"), Mono: stub("span"), Tip: stub("span"), Empty: stub("div"), useApp: () => ({}),
    };
    const scope: Dict = { CanvasModel: holder.CanvasModel };
    new Function("globalThis", "window", "React", "HadesCore", createUiTranspiler().transpile(join(uiDir, "argos/node-terminal.tsx")))(scope, scope, React, HadesCore);
    return scope;
  })();
  return loaded;
}


const PANE = { session: "default", pane: "w1:p1" };
const OTHER = { session: "default", pane: "w2:p1" };
const record = (pane: { session: string; pane: string }, extra: Dict = {}): Dict => ({
  ...pane, name: "orq", agent: "claude", cwd: "/clone", createdAt: "2026-11-03T12:42:48.589Z", ...extra,
});
const terminalNode = (id: string, pane: { session: string; pane: string }): Dict => ({
  id, type: "terminal", x: 0, y: 0, w: 100, h: 50, z: 0, data: { name: id, herdr: pane }, locked: false, blurred: false,
});

let n = 0;
function rig(opts: { registered?: Dict[]; alive?: string[] | null; canvasPanes?: { session: string; pane: string }[] | null } = {}) {
  const D = join(T, `d${n++}`);
  mkdirSync(join(D, "argos"), { recursive: true });
  if (opts.registered) writeFileSync(join(D, "argos/terminals.json"), JSON.stringify({ terminals: opts.registered }));
  const logs: string[] = [];
  const alive = opts.alive === undefined ? [PANE.pane] : opts.alive;
  const routes = createArgosTerminalsRoutes({
    dir: D, roots: () => [], notify: async () => undefined, signal: () => undefined, sleep: async () => undefined, now: () => 0,
    log: (level, event) => void logs.push(`${level} ${event}`),
    herdr: { call: async () => ({ rc: 1, out: "", err: "" }), json: async () => null, snap: async () => (alive === null ? null : { panes: alive.map((pane_id) => ({ pane_id })) }), forget: () => undefined },
    ...(opts.canvasPanes === null ? {} : { canvasPanes: () => opts.canvasPanes ?? [] }),
  });
  const orphans = async (): Promise<{ status: number; body: Dict }> => {
    const res = await (routes.orphans("/api/argos/terminals/orphans") as Promise<Response>);
    return { status: res.status, body: (await res.json()) as Dict };
  };
  return { D, routes, orphans, logs };
}

describe("órfãos: terminal registrado e vivo, sem nó em canvas nenhum", () => {
  test("dado terminal vivo sem nó em nenhum canvas, então aparece como órfão com o que o nó precisa", async () => {
    const r = rig({ registered: [record(PANE, { model: "opus", role: "impl", orchestrator: true })] });
    const out = await r.orphans();
    expect(out.status).toBe(200);
    expect(out.body.orphans).toEqual([{ ...PANE, name: "orq", agent: "claude", model: "opus", role: "impl", orchestrator: true, createdAt: "2026-11-03T12:42:48.589Z" }]);
    expect(out.body.checked).toBe(true);
  });

  test("dado terminal que algum canvas tem como nó, então não é órfão", async () => {
    const r = rig({ registered: [record(PANE), record(OTHER, { name: "outro" })], alive: [PANE.pane, OTHER.pane], canvasPanes: [OTHER] });
    expect((await r.orphans()).body.orphans.map((o: Dict) => o.pane)).toEqual([PANE.pane]);
  });

  test("dado pane que morreu no herdr, então não é órfão (não há o que trazer)", async () => {
    const r = rig({ registered: [record(PANE)], alive: [] });
    expect((await r.orphans()).body.orphans).toEqual([]);
  });

  test("dado herdr fora do ar, então não afirma órfão e diz que não conferiu", async () => {
    const r = rig({ registered: [record(PANE)], alive: null });
    expect((await r.orphans()).body).toEqual({ orphans: [], checked: false });
  });

  test("dado sem registro de terminais, então lista vazia conferida", async () => {
    expect((await rig().orphans()).body).toEqual({ orphans: [], checked: true });
  });

  test("dado painel sem a lista de panes dos canvases, então não afirma órfão", async () => {
    const r = rig({ registered: [record(PANE)], canvasPanes: null });
    expect((await r.orphans()).body).toEqual({ orphans: [], checked: false });
  });

  test("dado registro ilegível, então 500 genérico com código e sem o caminho", async () => {
    const r = rig();
    writeFileSync(join(r.D, "argos/terminals.json"), "{ não é json");
    const out = await r.orphans();
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain(T);
    expect(out.body.code).toBe("terminals_unreadable");
  });

  test("dado outro caminho, então a rota não é dela", () => {
    expect(rig().routes.orphans("/api/argos/terminals")).toBeUndefined();
  });
});

describe("canvas.terminalPanes: os terminais que algum canvas tem como nó", () => {
  test("dado o padrão e um canvas de escopo com terminais, então junta os dois e ignora nó de outro tipo e canvas ilegível", async () => {
    const dir = join(T, "panes");
    mkdirSync(join(dir, "canvases"), { recursive: true });
    const routes = createCanvasRoutes(dir);
    const put = (url: string, doc: Dict) => routes.writeMany("PUT", url, {}, new Request(`http://127.0.0.1${url}`, { method: "PUT", body: JSON.stringify(doc) }), { remote: false });
    const doc = (rev: number, nodes: Dict[]): Dict => ({ v: 1, rev, nodes, edges: [], groups: [] });
    const created = await (routes.writeMany("POST", "/api/canvases", {}, new Request("http://127.0.0.1/api/canvases", { method: "POST", body: JSON.stringify({ name: "Rodada" }) }), { remote: false }) as Promise<Response>);
    const { id } = (await created.json()) as { id: string };
    await put(`/api/canvases/${id}`, doc(0, [terminalNode("t2", OTHER), { ...terminalNode("nota", PANE), type: "note" }]));
    await routes.put(new Request("http://127.0.0.1/api/canvas", { method: "PUT", body: JSON.stringify(doc(0, [terminalNode("t1", PANE)])) }), { remote: false });
    writeFileSync(join(dir, "canvases", "quebrado.json"), "{ não é json");
    expect(routes.terminalPanes()).toEqual([PANE, OTHER]);
  });
});

describe("criar terminal: o nó só vale quando está no documento (ensureNodeSaved)", () => {
  function harness(NT: Dict, confirmedOn: number) {
    const calls: string[] = [];
    let attempt = 0;
    const run = () => NT.ensureNodeSaved({
      apply: () => { attempt += 1; calls.push("apply"); return `n${attempt}`; },
      flush: async () => void calls.push("flush"),
      fetchDoc: async () => { calls.push("fetch"); return { attempt }; },
      has: (doc: { attempt: number }, id: string) => doc.attempt >= confirmedOn && id === `n${doc.attempt}`,
      reread: async () => { calls.push("reread"); return true; },
    });
    return { calls, run };
  }

  test("dado o servidor com o nó depois do primeiro envio, então termina sem reler", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const h = harness(NT, 1);
    expect(await h.run()).toEqual({ ok: true, id: "n1", attempts: 1 });
    expect(h.calls).toEqual(["apply", "flush", "fetch"]);
  });

  test("dado o primeiro envio perdido, então relê, reaplica a inclusão do nó e grava de novo", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const h = harness(NT, 2);
    expect(await h.run()).toEqual({ ok: true, id: "n2", attempts: 2 });
    expect(h.calls).toEqual(["apply", "flush", "fetch", "reread", "apply", "flush", "fetch"]);
  });

  test("dado o nó que nunca entra, então para em 3 tentativas com código estável", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const h = harness(NT, 99);
    expect(await h.run()).toEqual({ ok: false, code: "terminal_node_unsaved", attempts: 3 });
    expect(h.calls.filter((c) => c === "apply")).toHaveLength(3);
    expect(h.calls.filter((c) => c === "reread")).toHaveLength(2);
  });

  test("dado o servidor sem resposta ao conferir, então conta como não confirmado e tenta de novo", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    let fetches = 0;
    const out = await NT.ensureNodeSaved({
      apply: () => "n", flush: async () => undefined, reread: async () => true, has: () => true,
      fetchDoc: async () => { if (++fetches === 1) throw new Error("sem rede"); return {}; },
    });
    expect(out).toEqual({ ok: true, id: "n", attempts: 2 });
  });

  test("dado canvas ainda não carregado (apply sem nó), então a tentativa falha e relê", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    let applies = 0;
    const out = await NT.ensureNodeSaved({
      apply: () => (++applies === 1 ? null : "n"), flush: async () => undefined, reread: async () => true, has: () => true, fetchDoc: async () => ({}),
    });
    expect(out).toEqual({ ok: true, id: "n", attempts: 2 });
  });
});

describe("Trazer para o canvas: o nó do órfão", () => {
  test("dado um órfão, então o nó leva nome, agente, papel, orquestrador e o par do herdr", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const data = NT.orphanNodeData({ ...PANE, name: "orq", agent: "claude", model: "opus", effort: "high", role: "impl", orchestrator: true, createdAt: "x" });
    expect(data).toEqual({ name: "orq", agent: "claude", model: "opus", effort: "high", role: "impl", orchestrator: true, herdr: PANE });
  });

  test("dado órfão sem papel nem orquestrador, então esses campos não entram", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    expect(NT.orphanNodeData({ ...PANE, name: "x", agent: "claude", createdAt: "x" })).toEqual({ name: "x", agent: "claude", herdr: PANE });
  });
});

describe("tela do Argos: a criação do terminal usa ensureNodeSaved", () => {
  const page = readFileSync(join(uiDir, "pages/argos.tsx"), "utf8");
  const body = page.slice(page.indexOf("const placeTerminal = async"), page.indexOf("const toolRect = {"));

  test("dado placeTerminal, então só termina pela conferência do nó gravado e relê em recusa", () => {
    expect(body).toContain("NT.ensureNodeSaved(");
    expect(body).toContain("reread: () => loadCanvas()");
    expect(body).toContain("fetchDoc: () => getCanvas(");
  });

  test("dado o banner de órfãos, então a ação usa o nó do órfão e a lista vem da rota", () => {
    expect(page).toContain("/api/argos/terminals/orphans");
    expect(page).toContain("NT.orphanNodeData(o)");
    expect(page).toContain("Trazer para o canvas");
  });
});
