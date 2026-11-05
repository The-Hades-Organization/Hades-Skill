/// <reference path="../../../kit/panel/ui/argos/logic.tsx" />
// Grupo argos-terminal-fechar: fechar e tirar do canvas o terminal criado pelo canvas (reference/argos.md §Criar e fechar
// terminal pelo canvas). Excluir um terminal com processo vivo fecha o processo; fechar só termina com o nó fora do documento
// do servidor; nó cujo pane morreu aparece como encerrado e sai sem diálogo; e o zoom do texto redimensiona o nó na proporção
// do quadro. Sem DOM: os scripts clássicos rodam num escopo próprio com o HadesCore de mentira.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CANVAS_UI_BUNDLE, createCanvasModuleBundler, createUiTranspiler } from "../../../src/panel/ui-transpile";
import "../../../kit/panel/ui/argos/logic.tsx";

const L = (globalThis as unknown as { ArgosLogic: ArgosLogicApi }).ArgosLogic;
const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
type Dict = Record<string, any>;

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
      useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => undefined],
      useEffect: () => undefined, useRef: (v: unknown) => ({ current: v }), useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(),
      cn: (...a: unknown[]) => a.filter(Boolean).join(" "), I: new Proxy({}, { get: () => stub("svg") }),
      post: () => Promise.reject(new Error("sem rede no teste")), getJSON: () => Promise.reject(new Error("sem rede no teste")),
      Button: stub("button"), Input: stub("input"), Dialog: stub("div"), DialogHeader: stub("div"), DialogFooter: stub("div"), Segmented: stub("div"),
      Checkbox: stub("button"), Dot: stub("span"), Mono: stub("span"), Tip: stub("span"), Empty: stub("div"), useApp: () => ({}),
    };
    const scope: Dict = { CanvasModel: holder.CanvasModel };
    const transpiler = createUiTranspiler();
    for (const rel of ["term-logic.tsx", "argos/node-terminal.tsx", "argos/node-tty.tsx", "argos/commands-canvas.tsx", "argos/types-user.tsx", "argos/types-live.tsx"]) {
      new Function("globalThis", "window", "React", "HadesCore", transpiler.transpile(join(uiDir, rel)))(scope, scope, React, HadesCore);
    }
    return { ...scope, M: holder.CanvasModel };
  })();
  return loaded;
}

const PANE = { session: "default", pane: "w1:p1" };
const OTHER = { session: "default", pane: "w2:p1" };
const node = (id: string, type: string, data: Dict = {}): Dict => ({ id, type, x: 0, y: 0, w: 640, h: 420, z: 0, data, locked: false, blurred: false });
const docOf = (nodes: Dict[], hidden?: string[]): Dict => ({ v: 1, rev: 1, nodes, edges: [], groups: [], ...(hidden ? { hidden } : {}) });

describe("excluir (Delete): terminal com processo vivo fecha o processo", () => {
  async function mount(doc: Dict, selection: string[], closable?: (id: string) => boolean) {
    const { M, ArgosCanvasCommands, ArgosTypesUser, ArgosTypesLive } = await load();
    const reg = M.argos.createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null });
    const closed: string[] = [];
    const committed: Dict[] = [];
    const terminals: Dict = {
      armTool: () => undefined, target: () => null, edit: async () => undefined, role: async () => undefined, connections: async () => undefined,
      close: async (id: string) => void closed.push(id), roles: () => undefined,
      ...(closable ? { closable } : {}),
    };
    const api = {
      doc: { doc: () => doc, selection: () => selection, select: () => undefined, commit: (op: Dict) => void committed.push(op), reveal: () => undefined, notify: () => undefined },
      dialogs: { askText: async () => null, choose: async () => null, confirm: async () => false },
      terminals,
    };
    const deps = { fetch: () => Promise.reject(new Error("sem rede no teste")), now: () => 0 };
    L.mountCanvasRegistries(reg as never, { canvasCommands: ArgosCanvasCommands, typesUser: ArgosTypesUser, typesLive: ArgosTypesLive } as never, { api, userDeps: deps, liveDeps: deps });
    const run = async (): Promise<void> => { reg.commands.get("clip:delete").run({}); await new Promise((r) => setTimeout(r, 0)); };
    const deletedIds = (): string[] => committed.flatMap((op) => (op.kind === "batch" ? op.ops : [op])).filter((op: Dict) => op.kind === "delete").flatMap((op: Dict) => op.snapshot.nodes.map((p: Dict) => p.item.id));
    return { run, closed, deletedIds };
  }

  test("dado um terminal com pane vivo selecionado, então Delete chama o fechar (diálogo com o nome) e não só tira o nó", async () => {
    const t = await mount(docOf([node("term-node-1", "terminal", { name: "orq", herdr: PANE })]), ["term-node-1"], (id) => id === "term-node-1");
    await t.run();
    expect(t.closed).toEqual(["term-node-1"]);
    expect(t.deletedIds()).toEqual([]);
  });

  test("dada seleção com terminal vivo e nota, então a nota sai do documento e o terminal passa pelo fechar", async () => {
    const t = await mount(docOf([node("term-node-1", "terminal", { name: "orq", herdr: PANE }), node("nota-1", "text", { text: "oi" })]),
      ["term-node-1", "nota-1"], (id) => id === "term-node-1");
    await t.run();
    expect(t.closed).toEqual(["term-node-1"]);
    expect(t.deletedIds()).toEqual(["nota-1"]);
  });

  test("dado terminal sem processo (encerrado ou sem pane), então Delete só tira o nó, sem diálogo", async () => {
    const t = await mount(docOf([node("term-node-1", "terminal", { name: "orq", herdr: PANE })]), ["term-node-1"], () => false);
    await t.run();
    expect(t.closed).toEqual([]);
    expect(t.deletedIds()).toEqual(["term-node-1"]);
  });

  test("dada a página sem a porta closable, então Delete segue só editando o documento", async () => {
    const t = await mount(docOf([node("term-node-1", "terminal", { name: "orq", herdr: PANE })]), ["term-node-1"]);
    await t.run();
    expect(t.closed).toEqual([]);
    expect(t.deletedIds()).toEqual(["term-node-1"]);
  });
});

describe("fechar: o nó só sai de vez quando o servidor grava sem ele (ensureNodeRemoved)", () => {
  function harness(NT: Dict, goneOn: number) {
    const calls: string[] = [];
    let attempt = 0;
    const run = () => NT.ensureNodeRemoved({
      remove: () => { attempt += 1; calls.push("remove"); return true; },
      flush: async () => void calls.push("flush"),
      fetchDoc: async () => { calls.push("fetch"); return { attempt }; },
      gone: (doc: { attempt: number }) => doc.attempt >= goneOn,
      reread: async () => { calls.push("reread"); return true; },
    });
    return { calls, run };
  }

  test("dado o servidor sem o nó depois do primeiro envio, então termina sem reler", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const h = harness(NT, 1);
    expect(await h.run()).toEqual({ ok: true, attempts: 1 });
    expect(h.calls).toEqual(["remove", "flush", "fetch"]);
  });

  test("dada a gravação recusada (409, o servidor ainda tem o nó), então relê e reaplica a exclusão", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const h = harness(NT, 2);
    expect(await h.run()).toEqual({ ok: true, attempts: 2 });
    expect(h.calls).toEqual(["remove", "flush", "fetch", "reread", "remove", "flush", "fetch"]);
  });

  test("dado o nó que nunca sai, então para em 3 tentativas com código estável", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const h = harness(NT, 99);
    expect(await h.run()).toEqual({ ok: false, code: "terminal_node_not_removed", attempts: 3 });
  });

  test("dado canvas ainda não carregado (remove falso), então a tentativa falha e relê", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    let removes = 0;
    const out = await NT.ensureNodeRemoved({
      remove: () => ++removes > 1, flush: async () => undefined, reread: async () => true, gone: () => true, fetchDoc: async () => ({}),
    });
    expect(out).toEqual({ ok: true, attempts: 2 });
  });
});

describe("terminais encerrados no canvas (deadTerminalIds e markExited)", () => {
  test("dados panes mortos, então vêm os nós terminal deles, ocultos inclusive, e só eles", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const doc = docOf([
      node("t1", "terminal", { name: "a", herdr: PANE }),
      node("t2", "terminal", { name: "b", herdr: OTHER }),
      node("vivo", "terminal", { session: "default", pane: "w1:p1" }),
      node("nota", "text", { text: "x" }),
    ], ["t1"]);
    expect(NT.deadTerminalIds(doc, [PANE])).toEqual(["t1"]);
    expect(NT.deadTerminalIds(doc, [PANE, OTHER])).toEqual(["t1", "t2"]);
    expect(NT.deadTerminalIds(doc, [])).toEqual([]);
    expect(NT.deadTerminalIds(doc, [{ session: "outra", pane: "w1:p1" }])).toEqual([]);
    expect(NT.deadTerminalIds(doc, "lixo")).toEqual([]);
  });

  test("dado pane confirmado morto pelo servidor, então o nó dele passa a ter o processo encerrado e é avisado", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const host = NT.createTtyHost({
      openStream: () => ({ addEventListener: () => undefined, close: () => undefined, readyState: 0 }), sendInput: async () => undefined,
      setTimer: () => 1, clearTimer: () => undefined, nodeRect: () => undefined, liveState: () => undefined,
    });
    host.setTargets(new Map([["t1", PANE]]));
    const topics: string[] = [];
    host.subscribe((topic: string) => void topics.push(topic));
    expect(host.exitedOf("t1")).toBe(false);
    host.markExited([PANE.pane, 7, null]);
    expect(host.exitedOf("t1")).toBe(true);
    expect(topics).toEqual([PANE.pane]);
    host.markExited([PANE.pane]);
    expect(topics).toEqual([PANE.pane]);
  });
});

describe("zoom do texto do terminal (ttyZoomSize)", () => {
  const frame = { pane: "w1:p1", revision: 1, cols: 100, rows: 30, ansi: "" };

  test("dado 100%, então o nó vai ao tamanho natural do quadro e a escala resultante é 1", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const size = NT.ttyZoomSize({ w: 300, h: 200 }, frame, "reset");
    expect(size.scale).toBe(1);
    expect(NT.ttyZoomSize(size, frame, "reset")).toEqual(size);
  });

  test("dado aumentar e diminuir, então a escala muda 1,2× e o nó guarda a proporção do quadro", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const base = NT.ttyZoomSize({ w: 0, h: 0 }, frame, "reset");
    const bigger = NT.ttyZoomSize(base, frame, "in");
    expect(bigger.scale).toBeCloseTo(1.2, 2);
    expect(bigger.w).toBeGreaterThan(base.w);
    expect(bigger.h).toBeGreaterThan(base.h);
    const back = NT.ttyZoomSize(bigger, frame, "out");
    expect(back.scale).toBeCloseTo(1, 1);
    expect(Math.abs(back.w - base.w)).toBeLessThanOrEqual(2);
    expect(Math.abs(back.h - base.h)).toBeLessThanOrEqual(2);
  });

  test("dado nó com sobra de um lado, então aumentar parte da escala que cabe e tira a sobra", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const base = NT.ttyZoomSize({ w: 0, h: 0 }, frame, "reset");
    const wide = { w: base.w * 3, h: base.h };
    const next = NT.ttyZoomSize(wide, frame, "in");
    expect(next.scale).toBeCloseTo(1.2, 2);
    expect(next.w).toBeLessThan(wide.w);
  });

  test("dado o limite da escala, então não passa dele nem fica abaixo do mínimo do terminal", async () => {
    const { ArgosNodeTerminal: NT, ArgosNodeTty: Tty } = await load();
    let size = NT.ttyZoomSize({ w: 0, h: 0 }, frame, "reset");
    for (let i = 0; i < 20; i++) size = NT.ttyZoomSize(size, frame, "in");
    expect(size.scale).toBe(Tty.SCALE_LIMITS.max);
    for (let i = 0; i < 40; i++) size = NT.ttyZoomSize(size, frame, "out");
    const min = NT.ttyMinNodeSize(frame);
    expect(size.w).toBeGreaterThanOrEqual(min.w);
    expect(size.h).toBeGreaterThanOrEqual(min.h);
  });

  test("dado o teclado no terminal, então Ctrl+Alt+= / - / 0 sobem ao canvas e não vão ao agente", async () => {
    const { ArgosNodeTty: Tty, ArgosNodeTerminal: NT } = await load();
    for (const chord of ["Ctrl+Alt+=", "Ctrl+Alt+-", "Ctrl+Alt+0"]) expect(Tty.TTY_CANVAS_KEYS).toContain(chord);
    for (const id of ["tty:text-bigger", "tty:text-smaller", "tty:text-reset"]) expect(NT.ttyLetsCommand(true, id)).toBe(true);
  });
});

describe("tela do Argos: fechar, encerrados e zoom ligados na página", () => {
  const page = readFileSync(join(uiDir, "pages/argos.tsx"), "utf8");
  test("dado termClose, então a remoção do nó passa pela conferência do servidor", () => {
    const body = page.slice(page.indexOf("const termClose = async"), page.indexOf("const termRemoveEnded = async"));
    expect(body).toContain("removeTermNodes([id]");
    expect(body).toContain("NT.ensureNodeRemoved(");
    expect(body).toContain("reread: () => loadCanvas()");
  });
  test("dada a conferência dos órfãos, então os panes mortos marcam os nós e o banner oferece remover", () => {
    expect(page).toContain("ttyHost.markExited(");
    expect(page).toContain("NT.deadTerminalIds(");
    expect(page).toContain("terminais encerrados no canvas");
    expect(page).toContain("closable: (id) =>");
    expect(page).toContain("zoomText: call('ttyZoomText')");
  });
});
