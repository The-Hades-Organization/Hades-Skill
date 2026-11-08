// Grupo mark-type: o tipo de nó `mark` do Argos — registro, ajudantes puros de node-mark.tsx (recuo, teto do log, fora do ar),
// comando `mark:add` (só com a ponte e um nó por canvas) e a ordem dos scripts em index.html. Os .tsx rodam como o navegador
// os recebe (transpilados, com globalThis próprio) sobre um React e um HadesCore mínimos.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../../../kit/panel/ui/argos/logic.tsx";
import { CANVAS_UI_BUNDLE, createCanvasModuleBundler, createUiTranspiler } from "../../../src/panel/ui-transpile";

const root = join(import.meta.dir, "../../..");
const ui = join(root, "kit/panel/ui");
const transpiler = createUiTranspiler();

interface MarkApi {
  backoffMs(attempt: number): number;
  pushLine(lines: unknown[], line: unknown): unknown[];
  isOffline(body: unknown): boolean;
  LOG_LINES: number;
  COMMAND_CHARS: number;
  MARK_TYPE: string;
  MARK_SIZE: { w: number; h: number };
  STATE_TONE: Record<string, [string, string]>;
  ROUTES: Record<string, string>;
}

const runScript = (rel: string, scope: Record<string, unknown>): void => {
  new Function("globalThis", "React", "HadesCore", "window", transpiler.transpile(join(ui, rel)))(scope, scope.React, scope.HadesCore, scope);
};

const fakeCore = { useState: () => [null, () => undefined], useEffect: () => undefined, useRef: () => ({ current: null }), I: {}, cn: () => "", post: async () => ({}), Button: () => null };

const loadMark = (): MarkApi => {
  const scope: Record<string, unknown> = { React: { createElement: () => null }, HadesCore: fakeCore };
  runScript("argos/node-mark.tsx", scope);
  return scope.ArgosNodeMark as MarkApi;
};

describe("ajudantes do nó mark", () => {
  const mark = loadMark();

  test("dado a tentativa 0, quando pede o recuo, então começa em 2 s", () => {
    expect(mark.backoffMs(0)).toBe(2000);
  });

  test("dada uma tentativa além da tabela, quando pede o recuo, então repete o teto de 30 s", () => {
    expect(mark.backoffMs(4)).toBe(30000);
    expect(mark.backoffMs(500)).toBe(30000);
  });

  test("dado o log cheio, quando entra uma linha, então a mais antiga sai e a lista original não muda", () => {
    const full = Array.from({ length: mark.LOG_LINES }, (_, n) => n);
    const next = mark.pushLine(full, "nova");
    expect(next).toHaveLength(mark.LOG_LINES);
    expect(next[0]).toBe(1);
    expect(next[next.length - 1]).toBe("nova");
    expect(full[0]).toBe(0);
  });

  test("dado o log vazio, quando entra uma linha, então a lista tem só ela", () => {
    expect(mark.pushLine([], "a")).toEqual(["a"]);
  });

  test("dada a resposta de fora do ar, quando checa, então só vale com online=false e causa explicada", () => {
    expect(mark.isOffline({ online: false, explain: { code: "mark_bridge_missing" } })).toBe(true);
    expect(mark.isOffline({ online: false })).toBe(false);
    expect(mark.isOffline({ online: true, explain: {} })).toBe(false);
    expect(mark.isOffline(null)).toBe(false);
    expect(mark.isOffline(undefined)).toBe(false);
  });

  test("os sete estados do contrato têm legenda e cor, e o teto do texto é o do servidor", () => {
    expect(Object.keys(mark.STATE_TONE).sort()).toEqual(["INITIALISING", "LISTENING", "MUTED", "PROCESSING", "SLEEPING", "SPEAKING", "THINKING"]);
    expect(mark.COMMAND_CHARS).toBe(2000);
    expect(mark.MARK_TYPE).toBe("mark");
    expect(mark.MARK_SIZE).toEqual({ w: 360, h: 420 });
    expect(mark.ROUTES.events).toBe("/api/mark/events");
  });
});

describe("tipo mark no registro e comando mark:add", () => {
  interface Model { [key: string]: Record<string, unknown> }
  interface Cmd { id: string; surfaces: readonly string[]; when?: () => boolean; run(ctx: object): unknown }
  interface Reg {
    types: { get(type: string): { type: string; live: boolean } | undefined };
    commands: { get(id: string): Cmd | undefined; register(def: object): unknown };
  }
  interface MountLib {
    ACTIONS: unknown;
    STATE_FILTERS: unknown;
    readingCommandDefs(): object[];
    mountCanvasRegistries(reg: unknown, parts: unknown, opts: unknown): { refused: unknown[] };
  }

  const loadModel = async (): Promise<Model> => {
    const js = await createCanvasModuleBundler(join(root, "src/lib")).bundle(CANVAS_UI_BUNDLE);
    const scope: Record<string, unknown> = {};
    new Function("globalThis", js as string)(scope);
    return scope.CanvasModel as Model;
  };

  type Port = { available(): boolean; at(): { x: number; y: number } };
  const mountWith = async (port: Port | undefined) => {
    const model = await loadModel();
    const scope: Record<string, unknown> = { CanvasModel: model, React: { createElement: () => null }, HadesCore: fakeCore };
    for (const rel of ["argos/node-mark.tsx", "argos/commands-canvas.tsx", "argos/types-user.tsx", "argos/types-live.tsx"]) runScript(rel, scope);
    const L = (globalThis as unknown as { ArgosLogic: MountLib }).ArgosLogic;
    const reg = (model.argos as { createArgosRegistries(deps: object): Reg }).createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null });
    for (const def of L.readingCommandDefs()) reg.commands.register(def);
    let doc = (model.doc as { emptyCanvasDoc(): { nodes: { type: string }[] } }).emptyCanvasDoc();
    const commits: unknown[] = [];
    const api = {
      doc: { doc: () => doc, selection: () => [], select: () => undefined, reveal: () => undefined, notify: () => undefined,
        commit: (op: unknown) => { commits.push(op); } },
      dialogs: { askText: async () => null, choose: async () => null, confirm: async () => false },
      ...(port ? { mark: port } : {}),
    };
    const deps = { fetch: () => Promise.reject(new Error("sem rede no teste")), now: () => 0 };
    const parts = { canvasCommands: scope.ArgosCanvasCommands, typesUser: scope.ArgosTypesUser, typesLive: scope.ArgosTypesLive };
    const report = L.mountCanvasRegistries(reg, parts, { api, userDeps: deps, liveDeps: deps });
    return { reg, report, commits, setDoc: (next: typeof doc) => { doc = next; }, doc: () => doc };
  };

  test("dado o registro montado, quando consulta `mark`, então é tipo vivo e nada foi recusado", async () => {
    const { reg, report } = await mountWith({ available: () => true, at: () => ({ x: 0, y: 0 }) });
    expect(report.refused).toEqual([]);
    expect(reg.types.get("mark")?.type).toBe("mark");
  });

  test("dada a página sem porta do Mark, quando procura o comando, então mark:add não existe", async () => {
    const { reg } = await mountWith(undefined);
    expect(reg.commands.get("mark:add")).toBeUndefined();
  });

  test("dado o bridge ausente, quando avalia mark:add, então não aparece", async () => {
    const { reg } = await mountWith({ available: () => false, at: () => ({ x: 0, y: 0 }) });
    expect(reg.commands.get("mark:add")?.when?.()).toBe(false);
  });

  test("dado o bridge e o canvas sem mark, quando avalia e roda mark:add, então aparece e cria um nó mark", async () => {
    const { reg, commits } = await mountWith({ available: () => true, at: () => ({ x: 500, y: 500 }) });
    const cmd = reg.commands.get("mark:add");
    expect(cmd?.when?.()).toBe(true);
    await cmd?.run({});
    expect(commits).toHaveLength(1);
  });

  test("dado um nó mark já no canvas, quando avalia mark:add, então não é oferecido de novo", async () => {
    const { reg, setDoc, doc } = await mountWith({ available: () => true, at: () => ({ x: 0, y: 0 }) });
    setDoc({ ...doc(), nodes: [{ type: "mark" }] } as never);
    expect(reg.commands.get("mark:add")?.when?.()).toBe(false);
  });
});

describe("index.html", () => {
  const html = readFileSync(join(ui, "index.html"), "utf8");
  const at = (src: string): number => html.indexOf(`<script src="${src}"></script>`);

  test("node-mark.js carrega depois de canvas-model.js e antes de types-live.js", () => {
    const model = at("/ui/lib/canvas-model.js");
    const mark = at("/ui/argos/node-mark.js");
    const live = at("/ui/argos/types-live.js");
    expect(mark).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(-1);
    if (model > -1) expect(mark).toBeGreaterThan(model);
    expect(mark).toBeLessThan(live);
  });
});
