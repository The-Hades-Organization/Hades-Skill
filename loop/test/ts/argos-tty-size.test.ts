// Grupo argos-tty-size: o terminal do nó dimensiona o pane do herdr (reference/argos.md §Terminal do nó): cálculo de cols×rows
// pela área e pela métrica real da célula, debounce do pedido, escala 1 com a grade aplicada, queda sem suporte e cursor real
// contra o estimado. Sem DOM: os scripts clássicos rodam num escopo próprio com o HadesCore de mentira.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CANVAS_UI_BUNDLE, createCanvasModuleBundler, createUiTranspiler } from "../../../src/panel/ui-transpile";

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
      Button: stub("button"), Input: stub("input"), Dialog: stub("div"), Dot: stub("span"), Mono: stub("span"), Tip: stub("span"),
    };
    const scope: Dict = { CanvasModel: holder.CanvasModel };
    const transpiler = createUiTranspiler();
    for (const rel of ["term-logic.tsx", "argos/node-terminal.tsx", "argos/node-tty.tsx"]) {
      new Function("globalThis", "window", "React", "HadesCore", transpiler.transpile(join(uiDir, rel)))(scope, scope, React, HadesCore);
    }
    return scope;
  })();
  return loaded;
}

describe("gridFor: cols×rows pela área e pela célula", () => {
  test("dada a área de 600×300 e a célula de 7,8×17, então cabem 76×17 (arredonda para baixo)", async () => {
    const { ArgosNodeTty: Tty } = await load();
    expect(Tty.gridFor({ w: 600, h: 300 }, { w: 7.8, h: 17 })).toEqual({ cols: 76, rows: 17 });
  });

  test("dada a célula medida pelo xterm, então ela vence a estimativa e o zoom do texto muda a grade", async () => {
    const { ArgosNodeTty: Tty } = await load();
    const area = { w: 780, h: 340 };
    const natural = Tty.gridFor(area, Tty.cellSize(1, { w: 7.8, h: 17 }));
    const zoomed = Tty.gridFor(area, Tty.cellSize(2, { w: 15.6, h: 34 }));
    expect(natural).toEqual({ cols: 100, rows: 20 });
    expect(zoomed).toEqual({ cols: 50, rows: 10 });
  });

  test("dada a medida ausente ou inválida, então a célula cai na estimativa pelo zoom", async () => {
    const { ArgosNodeTty: Tty } = await load();
    expect(Tty.cellSize(1, null)).toEqual({ w: 13 * 0.6, h: 17 });
    expect(Tty.cellSize(2, { w: 0, h: 5 })).toEqual({ w: 13 * 0.6 * 2, h: 34 });
    expect(Tty.cellSize(Number.NaN, undefined)).toEqual({ w: 13 * 0.6, h: 17 });
  });

  test("dada a área minúscula ou gigante, então a grade fica nos limites do herdr (4..1000 × 2..500)", async () => {
    const { ArgosNodeTty: Tty } = await load();
    const cell = { w: 7.8, h: 17 };
    expect(Tty.gridFor({ w: 10, h: 10 }, cell)).toEqual({ cols: 4, rows: 2 });
    expect(Tty.gridFor({ w: 100000, h: 100000 }, cell)).toEqual({ cols: 1000, rows: 500 });
  });

  test("dada a área sem medida (zero, NaN) ou a célula inválida, então não há grade a pedir", async () => {
    const { ArgosNodeTty: Tty } = await load();
    expect(Tty.gridFor({ w: 0, h: 100 }, { w: 7, h: 17 })).toBeNull();
    expect(Tty.gridFor({ w: Number.NaN, h: 100 }, { w: 7, h: 17 })).toBeNull();
    expect(Tty.gridFor({ w: 100, h: 100 }, { w: 0, h: 17 })).toBeNull();
    expect(Tty.gridFor(null, { w: 7, h: 17 })).toBeNull();
  });
});

describe("measureCell e sizeApplied", () => {
  test("dado o xterm com a métrica interna, então a célula sai em px de CSS; sem ela, null", async () => {
    const { ArgosNodeTty: Tty } = await load();
    const term = { _core: { _renderService: { dimensions: { css: { cell: { width: 7.8, height: 17 } } } } } };
    expect(Tty.measureCell(term)).toEqual({ w: 7.8, h: 17 });
    expect(Tty.measureCell({ _core: {} })).toBeNull();
    expect(Tty.measureCell({ _core: { _renderService: { dimensions: { css: { cell: { width: 0, height: 0 } } } } } })).toBeNull();
    expect(Tty.measureCell(null)).toBeNull();
  });

  test("dado o quadro com a grade pedida, então vale escala 1; com outra grade ou sem pedido, não", async () => {
    const { ArgosNodeTty: Tty } = await load();
    expect(Tty.sizeApplied({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toBe(true);
    expect(Tty.sizeApplied({ cols: 80, rows: 30 }, { cols: 100, rows: 30 })).toBe(false);
    expect(Tty.sizeApplied({ cols: 100, rows: 30 }, null)).toBe(false);
  });

  test("dada a célula com zoom, então fitScale usa a célula dada (e o padrão segue a de antes)", async () => {
    const { ArgosNodeTty: Tty } = await load();
    const frame = { cols: 80, rows: 24 };
    const area = { w: 624, h: 408 };
    expect(Tty.fitScale(area, frame)).toBeCloseTo(1, 5);
    expect(Tty.fitScale(area, frame, { w: 13 * 0.6 * 2, h: 34 })).toBeCloseTo(0.5, 5);
  });
});

describe("resizeDebounce: o pedido espera o nó parar de mexer", () => {
  function timers() {
    const pending = new Map<number, () => void>();
    let seq = 0;
    return {
      set: (fn: () => void) => { seq += 1; pending.set(seq, fn); return seq; },
      clear: (h: number) => void pending.delete(h),
      flush: () => { const due = [...pending.values()]; pending.clear(); for (const fn of due) fn(); },
      size: () => pending.size,
    };
  }

  test("dada uma rajada de pedidos antes do prazo, então só o último sai", async () => {
    const { ArgosNodeTty: Tty } = await load();
    const t = timers();
    const sent: Dict[] = [];
    const d = Tty.resizeDebounce((g: Dict) => sent.push(g), 150, t);
    d.push({ cols: 80, rows: 24 });
    d.push({ cols: 90, rows: 24 });
    d.push({ cols: 100, rows: 30 });
    expect(t.size()).toBe(1);
    expect(sent).toEqual([]);
    t.flush();
    expect(sent).toEqual([{ cols: 100, rows: 30 }]);
  });

  test("dada a desmontagem antes do prazo, então nada sai", async () => {
    const { ArgosNodeTty: Tty } = await load();
    const t = timers();
    const sent: Dict[] = [];
    const d = Tty.resizeDebounce((g: Dict) => sent.push(g), 150, t);
    d.push({ cols: 80, rows: 24 });
    d.cancel();
    t.flush();
    expect(sent).toEqual([]);
    expect(Tty.RESIZE_DEBOUNCE_MS).toBe(150);
  });
});

describe("cursor: o real primeiro, a estimativa só sem ele", () => {
  const base = { pane: "w1:p1", revision: 1, cols: 20, rows: 3, ansi: "$ ls" };

  test("dado o quadro com cursor real, então vale o dele, mesmo que a estimativa desse outra célula", async () => {
    const { ArgosNodeTty: Tty } = await load();
    expect(Tty.frameCursor({ ...base, cursor: { row: 2, col: 5, visible: true } })).toEqual({ row: 2, col: 5 });
  });

  test("dado o cursor real escondido ou fora da grade, então nenhum cursor (a estimativa não o substitui)", async () => {
    const { ArgosNodeTty: Tty } = await load();
    expect(Tty.frameCursor({ ...base, cursor: { row: 0, col: 4, visible: false } })).toBeNull();
    expect(Tty.frameCursor({ ...base, cursor: { row: 9, col: 4, visible: true } })).toBeNull();
    expect(Tty.frameCursor({ ...base, cursor: { row: 0, col: 20, visible: true } })).toBeNull();
  });

  test("dado o quadro sem o campo cursor, então cai na estimativa pelo texto", async () => {
    const { ArgosNodeTty: Tty } = await load();
    expect(Tty.frameCursor(base)).toEqual({ row: 0, col: 4 });
  });
});

class FakeStream {
  readyState = 1;
  private listeners = new Map<string, Array<(m: Dict) => void>>();
  addEventListener(type: string, fn: (m: Dict) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  close(): void { this.readyState = 2; }
  emit(type: string, data?: Dict): void { for (const fn of this.listeners.get(type) ?? []) fn({ data: data === undefined ? undefined : JSON.stringify(data) }); }
}

describe("host: pedido de tamanho, queda sem suporte, liberação e reconexão", () => {
  async function rig(opts: { sendSize?: (b: Dict) => Promise<void> | void } = {}) {
    const { ArgosNodeTty, ...scope } = await load();
    void ArgosNodeTty;
    const NT = scope.ArgosNodeTerminal ?? (scope as Dict).window?.ArgosNodeTerminal;
    const streams: FakeStream[] = [];
    const timers = new Map<number, () => void>();
    let seq = 0;
    const sizes: Dict[] = [];
    const host = NT.createTtyHost({
      openStream: () => { const s = new FakeStream(); streams.push(s); return s; },
      sendInput: async () => undefined,
      ...(opts.sendSize === undefined ? {} : { sendSize: async (b: Dict) => { sizes.push(b); await opts.sendSize?.(b); } }),
      setTimer: (run: () => void) => { seq += 1; timers.set(seq, run); return seq; },
      clearTimer: (h: number) => void timers.delete(h),
      nodeRect: () => undefined,
      liveState: () => undefined,
    });
    const tick = (): void => { const due = [...timers.values()]; timers.clear(); for (const run of due) run(); };
    const nodes = (ids: string[]): Map<string, Dict> => new Map(ids.map((id, i) => [id, { session: "default", pane: `w1:p${i + 1}` }]));
    const live = (ids: string[]): FakeStream => {
      host.setTargets(nodes(ids));
      for (const id of ids) host.mount(id);
      tick();
      const stream = streams.at(-1) as FakeStream;
      stream.emit("frame", { pane: "w1:p1", revision: 1, cols: 80, rows: 24, ansi: "" });
      return stream;
    };
    return { NT, host, sizes, streams, tick, nodes, live };
  }
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  test("dado o pane no fluxo e o herdr que aceita, então setSize envia o pedido e confirma o suporte", async () => {
    const r = await rig({ sendSize: () => undefined });
    r.live(["n1"]);
    expect(r.host.canResize("n1")).toBe(true);
    expect(r.host.sizeSupported()).toBeNull();
    r.host.setSize("n1", { cols: 100, rows: 30 });
    await settle();
    expect(r.sizes).toEqual([{ session: "default", pane: "w1:p1", cols: 100, rows: 30 }]);
    expect(r.host.sizeSupported()).toBe(true);
  });

  test("dado herdr-unsupported, então o recurso cai para sempre e o nó volta a escalar o quadro", async () => {
    const r = await rig({ sendSize: () => Promise.reject(Object.assign(new Error("x"), { code: "herdr-unsupported" })) });
    r.live(["n1"]);
    r.host.setSize("n1", { cols: 100, rows: 30 });
    await settle();
    expect(r.host.sizeSupported()).toBe(false);
    expect(r.host.canResize("n1")).toBe(false);
    r.host.setSize("n1", { cols: 90, rows: 30 });
    await settle();
    expect(r.sizes.length).toBe(1);
    expect(r.host.textZoomOf("n1")).toBe(1);
    expect(r.host.stepTextZoom("n1", "in", { min: 0.5, max: 3 })).toBeNull();
  });

  test("dado herdr que recusa por outro motivo (taxa), então o recurso segue ligado", async () => {
    const r = await rig({ sendSize: () => Promise.reject(Object.assign(new Error("x"), { code: "size-rate-limited" })) });
    r.live(["n1"]);
    r.host.setSize("n1", { cols: 100, rows: 30 });
    await settle();
    expect(r.host.canResize("n1")).toBe(true);
  });

  test("dado host sem sendSize, então nunca há pedido e o zoom segue o do nó", async () => {
    const r = await rig();
    r.live(["n1"]);
    expect(r.host.canResize("n1")).toBe(false);
    expect(r.host.sizeSupported()).toBe(false);
  });

  test("dado nó fora do fluxo (polling), então não pede tamanho", async () => {
    const r = await rig({ sendSize: () => undefined });
    r.host.setTargets(r.nodes(["n1"]));
    expect(r.host.canResize("n1")).toBe(false);
    r.host.setSize("n1", { cols: 100, rows: 30 });
    await settle();
    expect(r.sizes).toEqual([]);
  });

  test("dado nó removido do canvas, então a grade é liberada; nó que fica não é tocado", async () => {
    const r = await rig({ sendSize: () => undefined });
    r.live(["n1", "n2"]);
    r.host.setSize("n1", { cols: 100, rows: 30 });
    await settle();
    r.host.setTargets(r.nodes(["n2"]));
    await settle();
    expect(r.sizes.at(-1)).toEqual({ session: "default", pane: "w1:p1", release: true });
    const before = r.sizes.length;
    r.host.setTargets(r.nodes(["n2"]));
    await settle();
    expect(r.sizes.length).toBe(before);
  });

  test("dada a reconexão do fluxo, então os tamanhos pedidos são refeitos (a fixação some num restart do herdr)", async () => {
    const r = await rig({ sendSize: () => undefined });
    const stream = r.live(["n1"]);
    r.host.setSize("n1", { cols: 100, rows: 30 });
    await settle();
    stream.emit("open");
    await settle();
    expect(r.sizes.filter((b) => b.cols === 100).length).toBe(2);
  });

  test("dado herdr com suporte, então o zoom do texto anda por passos, respeita os limites e volta a 100%", async () => {
    const r = await rig({ sendSize: () => undefined });
    r.live(["n1"]);
    r.host.setSize("n1", { cols: 100, rows: 30 });
    await settle();
    const limits = { min: 0.5, max: 3 };
    expect(r.host.stepTextZoom("n1", "in", limits)).toBe(1.2);
    expect(r.host.textZoomOf("n1")).toBe(1.2);
    for (let i = 0; i < 20; i++) r.host.stepTextZoom("n1", "in", limits);
    expect(r.host.textZoomOf("n1")).toBe(3);
    for (let i = 0; i < 30; i++) r.host.stepTextZoom("n1", "out", limits);
    expect(r.host.textZoomOf("n1")).toBe(0.5);
    expect(r.host.stepTextZoom("n1", "reset", limits)).toBe(1);
    expect(r.host.textZoomOf("n1")).toBe(1);
  });
});
