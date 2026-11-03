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


describe("quadro do NodeTty leva a sessão do herdr (histórico do pane certo)", () => {
  const frame = { pane: "p1", revision: 3, cols: 80, rows: 24, ansi: "x" };

  test("dado o quadro do polling, então leva a sessão do alvo", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    expect(NT.frameFromRead("p1", { text: "a\nb" }, "sessao-x")).toMatchObject({ pane: "p1", session: "sessao-x" });
  });

  test("dado o quadro do fluxo, então a cópia leva a sessão e o original não muda", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const out = NT.withSession(frame, "sessao-x");
    expect(out).toEqual({ ...frame, session: "sessao-x" });
    expect(frame).not.toHaveProperty("session");
  });

  test("dado o mesmo quadro duas vezes, então a identidade se mantém (o NodeTty não vê quadro novo)", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    expect(NT.withSession(frame, "s")).toBe(NT.withSession(frame, "s"));
  });

  test("dado alvo sem sessão ou sem quadro, então nada é inventado", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    expect(NT.withSession(frame, undefined)).toBe(frame);
    expect(NT.withSession(frame, "")).toBe(frame);
    expect(NT.withSession(null, "s")).toBeNull();
    expect(NT.frameFromRead("p1", { text: "a" })).not.toHaveProperty("session");
  });

  test("dado o corpo do nó, então os dois caminhos passam a sessão do alvo", () => {
    const src = readFileSync(join(uiDir, "argos/node-terminal.tsx"), "utf8");
    expect(src).toContain("withSession(host.frameOf(input.id), target.session)");
    expect(src).toContain("frameFromRead(pane, out, session)");
  });
});
