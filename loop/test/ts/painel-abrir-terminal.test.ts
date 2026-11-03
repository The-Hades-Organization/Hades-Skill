// "Abrir terminal" (Orquestração, Execuções): a escolha da pasta, a mesa guardada e o aviso com a chave desligada.
// Sem DOM: term.tsx roda num escopo próprio com o HadesCore de mentira. Contrato: reference/panel.md §Terminal › Interface.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import "../../../kit/panel/ui/term-logic.tsx";
import { createUiTranspiler } from "../../../src/panel/ui-transpile";

type Dict = Record<string, any>;
const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
const ID = "a".repeat(32);

const store = new Map<string, string>();
const realFetch = globalThis.fetch;
const g = globalThis as unknown as Dict;

function load(): Dict {
  const HadesCore: Dict = { useState: (v: unknown) => [v, () => undefined], useEffect: () => undefined, useRef: (v: unknown) => ({ current: v }), cn: () => "", I: {}, Button: () => null, useApp: () => ({}) };
  const scope: Dict = { TermLogic: g.TermLogic, HadesCore, HadesPanel: {} };
  g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  g.window = Object.assign(g.window ?? {}, { __TOKEN: "t", TermLogic: g.TermLogic });
  new Function("window", "HadesCore", "HadesPanel", createUiTranspiler().transpile(join(uiDir, "term.tsx")))(g.window, HadesCore, scope.HadesPanel);
  return HadesCore.TermOpen;
}
afterEach(() => { globalThis.fetch = realFetch; store.clear(); });

describe("pasta do Abrir terminal", () => {
  const roots = ["/home/u/proj", "/data"];
  test("dado uma pasta dentro de uma raiz, então vale; a própria raiz também", () => {
    const T = load();
    expect(T.cwdWithinRoots("/home/u/proj/wt/a", roots)).toBe("/home/u/proj/wt/a");
    expect(T.cwdWithinRoots("/data/", roots)).toBe("/data");
  });
  test("dado pasta fora das raízes, com .. ou relativa, então não vale", () => {
    const T = load();
    for (const bad of ["/home/u/proj-outro", "/home/u/proj/../x", "wt/a", "", undefined, null, 5]) expect(T.cwdWithinRoots(bad, roots)).toBeNull();
    expect(T.cwdWithinRoots("/data", [])).toBeNull();
  });
  test("dado o estado do servidor, então a Execução só mostra o botão com pasta permitida, ou com a chave desligada para avisar", () => {
    const T = load();
    expect(T.folderFor("/data/x", null)).toBeNull();
    expect(T.folderFor("/data/x", { enabled: true, roots })).toBe("/data/x");
    expect(T.folderFor("/tmp/x", { enabled: true, roots })).toBeNull();
    expect(T.folderFor("/tmp/x", { enabled: false, roots: [] })).toBe("/tmp/x");
    expect(T.folderFor(undefined, { enabled: true, roots })).toBeNull();
  });
});

describe("mesa da página Herdr", () => {
  test("dado a mesa vazia ou inválida, então a sessão aberta entra e fica ativa", () => {
    const T = load();
    expect(JSON.parse(T.deskWith(null, ID))).toMatchObject({ tabs: [ID], active: ID });
    expect(JSON.parse(T.deskWith("{lixo", ID))).toMatchObject({ tabs: [ID], active: ID });
  });
  test("dado uma mesa com abas, então a nova vai ao fim e a antiga continua", () => {
    const T = load();
    const first = T.deskWith(null, ID);
    const out = JSON.parse(T.deskWith(first, "b".repeat(32)));
    expect(out.tabs).toEqual([ID, "b".repeat(32)]);
    expect(out.active).toBe("b".repeat(32));
  });
});

describe("abrir e ir à página Herdr", () => {
  const app = () => { const calls: Dict = { go: [], toast: [] }; return { calls, app: { go: (p: string) => calls.go.push(p), toast: (t: Dict) => calls.toast.push(t) } }; };
  test("dado a abertura aceita, então grava a mesa e vai à página herdr", async () => {
    const T = load();
    let body: Dict = {};
    globalThis.fetch = (async (_u: string, init: Dict) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ id: ID }), { status: 200 }); }) as never;
    const { app: a, calls } = app();
    expect(await T.openAndGo({ kind: "shell", cwd: "/data/x" }, a)).toBe(true);
    expect(body).toEqual({ kind: "shell", cwd: "/data/x" });
    expect(calls.go).toEqual(["herdr"]);
    expect(JSON.parse(store.get(T.DESK_STORE) as string).active).toBe(ID);
  });
  test("dado term_disabled, então avisa como ligar, sem navegar nem gravar a mesa", async () => {
    const T = load();
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: "term_disabled" }), { status: 403 })) as never;
    const { app: a, calls } = app();
    expect(await T.openAndGo({ kind: "shell", cwd: "/data/x" }, a)).toBe(false);
    expect(calls.go).toEqual([]);
    expect(calls.toast[0]).toMatchObject({ kind: "info", title: "O terminal está desligado" });
    expect(calls.toast[0].desc).toContain("HADES_TERMINAL");
    expect(store.size).toBe(0);
  });
  test("dado pasta recusada pelo servidor, então o aviso é de alerta e não navega", async () => {
    const T = load();
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: "term_forbidden_cwd" }), { status: 403 })) as never;
    const { app: a, calls } = app();
    expect(await T.openAndGo({ kind: "shell", cwd: "/etc" }, a)).toBe(false);
    expect(calls.toast[0].kind).toBe("warn");
    expect(calls.go).toEqual([]);
  });
});
