// Grupo confirma-ui: as duas preferências de confirmação (segurar, digitar o nome) nas quatro combinações, no diálogo do Argos
// (argos/parts.tsx), nos do herdr (pages/herdr.tsx) e no HoldConfirm da base (app.tsx). Sem navegador: React falso que devolve
// a árvore, HadesCore de mentira e hooks sobre posições (como lib/page-render.cjs).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Script, createContext } from "node:vm";
import "../../../kit/panel/ui/argos/logic.tsx";

const UI = join(import.meta.dir, "../../../kit/panel/ui");
const transpiler = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react" } } });
const source = (rel: string): string => readFileSync(join(UI, rel), "utf8");

interface El { type: unknown; props: Record<string, unknown>; children: unknown[] }
const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: props ?? {}, children });
const marker = (name: string) => Object.assign(({ children }: { children?: unknown }) => children ?? null, { displayName: name });
const nameOf = (type: unknown): string => (typeof type === "function" ? (type as { displayName?: string }).displayName ?? type.name : String(type));
const walk = (node: unknown, visit: (el: El) => void): void => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node === null || typeof node !== "object" || !("type" in node)) return;
  const el = node as El;
  visit(el);
  walk(el.children, visit);
  for (const value of Object.values(el.props)) if (value !== null && typeof value === "object") walk(value, visit);
};
const all = (tree: unknown, name: string): El[] => {
  const found: El[] = [];
  walk(tree, (el) => { if (nameOf(el.type) === name) found.push(el); });
  return found;
};
const textOf = (node: unknown): string => (Array.isArray(node) ? node.map(textOf).join("") : typeof node === "string" ? node : node !== null && typeof node === "object" && "children" in node ? textOf((node as El).children) : "");

type Prefs = { hold: boolean; typed: boolean };
const COMBOS: [string, Prefs][] = [
  ["segurar ligado e digitar ligado", { hold: true, typed: true }],
  ["segurar desligado e digitar ligado", { hold: false, typed: true }],
  ["segurar ligado e digitar desligado", { hold: true, typed: false }],
  ["segurar desligado e digitar desligado", { hold: false, typed: false }],
];

/** Roda o script da página num escopo próprio e devolve um renderizador com hooks por posição, que sobrevive a re-renders. */
function load(rel: string, prefs: Prefs, patch: (js: string) => string = (js) => js) {
  const posts: [string, Record<string, unknown>][] = [];
  const slots: unknown[] = [];
  let at = 0;
  const core: Record<string, unknown> = new Proxy({
    I: new Proxy({}, { get: (_, key) => marker(String(key)) }),
    useState: (init: unknown) => {
      const i = at++;
      if (!(i in slots)) slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      return [slots[i], (v: unknown) => { slots[i] = typeof v === "function" ? (v as (x: unknown) => unknown)(slots[i]) : v; }];
    },
    useEffect: () => undefined, useMemo: (f: () => unknown) => f(), useCallback: (f: unknown) => f, useRef: () => ({ current: null }),
    useApp: () => ({ toast: () => undefined }), useConfirmPrefs: () => prefs, cn: (...a: unknown[]) => a.filter(Boolean).join(" "),
    post: async (path: string, body: Record<string, unknown>) => { posts.push([path, body]); return {}; },
    getJSON: async () => ({}), registerPage: () => undefined,
  } as Record<string, unknown>, { get: (t, key: string) => (key in t ? t[key] : marker(key)) });
  const exported: Record<string, (props: Record<string, unknown>) => unknown> = {};
  const sandbox: Record<string, unknown> = {
    React: { createElement: h }, HadesCore: core, TermLogic: new Proxy({}, { get: () => () => undefined }), __export: exported,
    HadesFx: { use: () => null }, CanvasModel: { argos: new Proxy({}, { get: () => () => ({}) }) },
    ArgosLogic: (globalThis as unknown as { ArgosLogic: unknown }).ArgosLogic, setTimeout: () => 0,
  };
  sandbox.window = sandbox;
  new Script(patch(transpiler.transformSync(source(rel))), { filename: rel }).runInContext(createContext(sandbox));
  const render = (name: string, props: Record<string, unknown>): unknown => { at = 0; return exported[name]?.(props) ?? (sandbox.ArgosParts as Record<string, (p: unknown) => unknown>)[name]?.(props); };
  return { render, posts, sandbox };
}

describe("confirma-ui: diálogo do Argos (done)", () => {
  const L = (globalThis as unknown as { ArgosLogic: { ACTIONS: { id: string }[] } }).ArgosLogic;
  const node = { id: "agent:o__r:fin", label: "fin", type: "agent" };
  const action = L.ACTIONS.find((a) => a.id === "done");
  for (const [name, prefs] of COMBOS) {
    test(`dado ${name}, então o campo e o botão seguem a preferência de digitar`, () => {
      const ran: unknown[][] = [];
      const ui = load("argos/parts.tsx", prefs);
      const props = { node, action, detail: null, onClose: () => undefined, onRun: (...a: unknown[]) => { ran.push(a); } };
      const tree = ui.render("ActionDialog", props);
      expect(all(tree, "Input").length).toBe(prefs.typed ? 1 : 0);
      expect(textOf(all(tree, "DialogHeader")[0]?.props.description).includes("Digite fin")).toBe(prefs.typed);
      const [hold] = all(tree, "HoldConfirm");
      expect(hold?.props.disabled).toBe(prefs.typed);
      if (!prefs.typed) {
        (hold?.props.onHold as () => void)();
        expect(ran.length).toBe(1);
      }
    });
  }

  test("dado digitar ligado, quando o nome é digitado, então o botão habilita e a ação roda com ele", () => {
    const ran: unknown[][] = [];
    const ui = load("argos/parts.tsx", { hold: true, typed: true });
    const props = { node, action, detail: null, onClose: () => undefined, onRun: (...a: unknown[]) => { ran.push(a); } };
    (all(ui.render("ActionDialog", props), "Input")[0]?.props.onInput as (e: unknown) => void)({ target: { value: "fin" } });
    const [hold] = all(ui.render("ActionDialog", props), "HoldConfirm");
    expect(hold?.props.disabled).toBe(false);
    (hold?.props.onHold as () => void)();
    expect(ran[0]?.[2]).toBe("fin");
  });
});

describe("confirma-ui: diálogos do herdr", () => {
  const withExports = (js: string): string => js.replace("HadesCore.registerPage('herdr', Herdr);", "HadesCore.registerPage('herdr', Herdr); __export.HerdrAdmin = HerdrAdmin; __export.HerdrSessions = HerdrSessions;")
    .replace('HadesCore.registerPage("herdr", Herdr);', 'HadesCore.registerPage("herdr", Herdr); __export.HerdrAdmin = HerdrAdmin; __export.HerdrSessions = HerdrSessions;');
  const ask = { action: "workspace-close", icon: marker("Trash2"), title: "Fechar?", description: "d", fields: [], confirmName: "alpha", done: "ok", target: { workspace: "w1" } };

  for (const [name, prefs] of COMBOS) {
    test(`dado ${name}, quando fecha workspace, então o campo e o corpo seguem a preferência`, async () => {
      const ui = load("pages/herdr.tsx", prefs, withExports);
      const props = { session: "default", ask, onClose: () => undefined, onDone: () => undefined };
      const tree = ui.render("HerdrAdmin", props);
      expect(all(tree, "Input").length).toBe(prefs.typed ? 1 : 0);
      expect(textOf(all(tree, "DialogHeader")[0]?.props.description).includes("Digite alpha")).toBe(prefs.typed);
      const [hold] = all(tree, "HoldConfirm");
      expect(hold?.props.disabled).toBe(prefs.typed);
      if (!prefs.typed) {
        await (hold?.props.onHold as () => Promise<void>)();
        expect(ui.posts).toEqual([["/api/herdr/admin", { session: "default", action: "workspace-close", workspace: "w1" }]]);
      }
    });

    test(`dado ${name}, quando para a sessão, então o campo e o corpo seguem a preferência`, async () => {
      const ui = load("pages/herdr.tsx", prefs, withExports);
      const props = { open: true, onClose: () => undefined, onDone: () => undefined, sessions: [{ name: "outra", running: true, agents: 0, working: 0 }] };
      const stop = all(ui.render("HerdrSessions", props), "Button").find((b) => textOf(b) === "Parar");
      (stop?.props.onClick as () => void)();
      const tree = ui.render("HerdrSessions", props);
      expect(all(tree, "Input").length).toBe(prefs.typed ? 1 : 0);
      const [hold] = all(tree, "HoldConfirm");
      expect(hold?.props.disabled).toBe(prefs.typed);
      if (!prefs.typed) {
        await (hold?.props.onHold as () => Promise<void>)();
        expect(ui.posts[0]).toEqual(["/api/herdr/session", { action: "stop", name: "outra" }]);
      }
    });
  }
});

describe("confirma-ui: HoldConfirm e as preferências na base (app.tsx)", () => {
  const app = source("app.tsx");
  const slice = (from: string, to: string): string => app.slice(app.indexOf(from), app.indexOf(to));
  const build = (prefs: Prefs, withFx: boolean) => {
    const js = transpiler.transformSync(`${slice("// confirmar segurando", "const BADGE_V")}\nglobalThis.__out = { HoldConfirm, plainLabel };`.replace("const BADGE_V", ""))
      + "";
    const plain = transpiler.transformSync(slice("// sem o \"Segure", "// ====="));
    const Button = marker("Button");
    const Hold = marker("Hold");
    const sandbox: Record<string, unknown> = { React: { createElement: h }, Button, useConfirmPrefs: () => prefs, window: {} };
    (sandbox.window as Record<string, unknown>).HadesFx = withFx ? { HoldButton: Hold } : undefined;
    new Script(`${plain}\n${js}`, { filename: "app.tsx" }).runInContext(createContext(sandbox));
    return sandbox.__out as { HoldConfirm: (p: Record<string, unknown>) => El; plainLabel: (c: unknown) => unknown };
  };

  for (const [name, prefs] of COMBOS) {
    test(`dado ${name} e o fx carregado, então o botão é ${prefs.hold ? "de segurar" : "de um clique"}`, () => {
      const out = build(prefs, true).HoldConfirm({ onHold: () => undefined, children: "Segure 1,2 s: Fechar" });
      expect(nameOf(out.type)).toBe(prefs.hold ? "Hold" : "Button");
      if (!prefs.hold) expect(textOf(out.children)).toBe("Fechar");
    });
  }
  test("dado o fx fora do ar com segurar ligado, então cai no botão comum com o rótulo inteiro", () => {
    const out = build({ hold: true, typed: true }, false).HoldConfirm({ onHold: () => undefined, children: "Segure 1,2 s: Fechar" });
    expect([nameOf(out.type), textOf(out.children)]).toEqual(["Button", "Segure 1,2 s: Fechar"]);
  });
  test("dado segurar desligado, então o clique dispara onHold", () => {
    let fired = 0;
    const out = build({ hold: false, typed: true }, true).HoldConfirm({ onHold: () => { fired++; }, children: "x" });
    (out.props.onClick as () => void)();
    expect(fired).toBe(1);
  });
  test("o rótulo só perde o prefixo de segurar, em texto e em lista", () => {
    const { plainLabel } = build({ hold: false, typed: true }, true);
    expect(plainLabel("Segure 1,2 s: Parar")).toBe("Parar");
    expect(plainLabel(["Segure 1,2 s: Apagar"])).toEqual(["Apagar"]);
    expect(plainLabel("Estacionando…")).toBe("Estacionando…");
  });
});
