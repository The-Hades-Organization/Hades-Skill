// Links clicáveis e busca do terminal do nó (argos/tty-extras.tsx, node-tty.tsx) e a decisão de raiz do servidor para o caminho
// que o link abre (POST /api/canvas-notes/link). Sem DOM: os scripts clássicos rodam num escopo próprio.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CANVAS_UI_BUNDLE, createCanvasModuleBundler, createUiTranspiler } from "../../../src/panel/ui-transpile";
import { createCanvasNotesRoutes, NOTE_ROUTE_ERRORS } from "../../../src/panel/canvas-notes";

const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
type Dict = Record<string, any>;

let loaded: Promise<{ X: Dict; tty: Dict; scope: Dict }> | null = null;
function load(): Promise<{ X: Dict; tty: Dict; scope: Dict }> {
  loaded ??= (async () => {
    const mod: { exports: any } = { exports: {} };
    new Function("exports", "module", readFileSync(join(uiDir, "vendor/react.js"), "utf8"))(mod.exports, mod);
    const bundle = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const holder: Dict = {};
    new Function("globalThis", bundle as string)(holder);
    const HadesCore = { useState: (v: unknown) => [v, () => undefined], useEffect: () => undefined, useRef: (v: unknown) => ({ current: v }), cn: (...a: unknown[]) => a.filter(Boolean).join(" ") };
    const scope: Dict = { CanvasModel: holder.CanvasModel };
    const run = (file: string, ...extra: [string, unknown][]) =>
      new Function("globalThis", "window", ...extra.map(([k]) => k), createUiTranspiler().transpile(join(uiDir, file)))(scope, scope, ...extra.map(([, v]) => v));
    run("term-logic.tsx");
    run("argos/tty-extras.tsx");
    run("argos/node-tty.tsx", ["React", mod.exports], ["HadesCore", HadesCore]);
    return { X: scope.ArgosTtyExtras, tty: scope.ArgosNodeTty, scope };
  })();
  return loaded;
}

describe("tty-extras: links da linha", () => {
  test("URL http(s) sem a pontuação do fim e caminho absoluto com a posição :linha:coluna", async () => {
    const { X } = await load();
    const line = "veja https://exemplo.com/a?b=1. e /home/ana/proj/src/app.ts:12:3, ok";
    const links = X.linksOf(line);
    expect(links.map((l: Dict) => [l.kind, line.slice(l.start, l.end)])).toEqual([["url", "https://exemplo.com/a?b=1"], ["path", "/home/ana/proj/src/app.ts:12:3"]]);
    expect(links[1].path).toBe("/home/ana/proj/src/app.ts");
  });

  test("o caminho dentro de uma URL não vira segundo link, e javascript: e file: nunca são URL", async () => {
    const { X } = await load();
    expect(X.linksOf("https://x.com/a/b/c.md").map((l: Dict) => l.kind)).toEqual(["url"]);
    expect(X.linksOf("javascript:alert(1) file:///etc/passwd")).toEqual([]);
  });

  test("caminho relativo, barra solta e linha vazia ou enorme não geram link", async () => {
    const { X } = await load();
    expect(X.linksOf("src/app.ts e a/b e / e //x")).toEqual([]);
    expect(X.linksOf("")).toEqual([]);
    expect(X.linksOf(`/a/${"b".repeat(5000)}`)).toEqual([]);
  });

  test("openablePath só aceita caminho absoluto sem NUL e de tamanho limitado", async () => {
    const { X } = await load();
    expect([X.openablePath("/a/b.md"), X.openablePath("a/b.md"), X.openablePath("/a\u0000b"), X.openablePath(`/${"a".repeat(1100)}`), X.openablePath(null)]).toEqual([true, false, false, false, false]);
  });

  test("o provedor do xterm entrega o intervalo 1-based do link e o clique em URL abre em nova aba com noopener", async () => {
    const { tty, scope } = await load();
    const term = { buffer: { active: { getLine: (i: number) => (i === 0 ? { translateToString: () => "ir a https://a.dev/x agora" } : undefined) } } };
    const opened: unknown[][] = [];
    scope.open = (...a: unknown[]) => opened.push(a);
    let got: Dict[] | undefined;
    const activated: unknown[] = [];
    tty.linkProviderOf(term, (l: Dict) => tty.activateLink(l, (p: string) => activated.push(p))).provideLinks(1, (l: Dict[] | undefined) => { got = l; });
    expect(got?.[0]?.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 20, y: 1 } });
    got?.[0]?.activate();
    expect(opened).toEqual([["https://a.dev/x", "_blank", "noopener,noreferrer"]]);
    let none: Dict[] | undefined = [];
    tty.linkProviderOf(term, () => undefined).provideLinks(2, (l: Dict[] | undefined) => { none = l; });
    expect(none).toBeUndefined();
  });

  test("o clique em caminho vai ao dono; o que não é caminho absoluto não vai", async () => {
    const { tty } = await load();
    const sent: string[] = [];
    tty.activateLink({ kind: "path", path: "/home/ana/a.md" }, (p: string) => sent.push(p));
    tty.activateLink({ kind: "path", path: "../a.md" }, (p: string) => sent.push(p));
    expect(sent).toEqual(["/home/ana/a.md"]);
  });
});

describe("tty-extras: busca na tela e no scrollback", () => {
  const screen = ["\x1b[31mErro\x1b[0m na linha", "tudo certo", "ERRO de novo"];

  test("sem histórico a busca é só na tela, sem diferenciar maiúscula, com o texto sem ANSI", async () => {
    const { X } = await load();
    const lines = X.searchLines(null, screen, 3);
    expect(X.findMatches(lines, "erro").matches).toEqual([{ line: 0, col: 0, len: 4 }, { line: 2, col: 0, len: 4 }]);
  });

  test("com histórico, as linhas de cima vêm dele e as últimas da tela de agora", async () => {
    const { X } = await load();
    const history = ["antigo erro", "outro", "(tela velha)", "(tela velha)", "(tela velha)"];
    const lines = X.searchLines(history, screen, 3);
    expect(lines.length).toBe(5);
    expect(X.findMatches(lines, "erro").matches.map((m: Dict) => m.line)).toEqual([0, 2, 4]);
    expect(X.findMatches(lines, "velha").matches).toEqual([]);
  });

  test("histórico menor que a tela ou ausente, e tela curta, ficam com a tela completada até as linhas do quadro", async () => {
    const { X } = await load();
    expect(X.searchLines(["a"], ["x"], 3)).toEqual(["x", "", ""]);
    expect(X.searchLines([], ["x", "y"], 2)).toEqual(["x", "y"]);
  });

  test("consulta vazia e sem resultado: nenhum achado, e o rótulo diz qual", async () => {
    const { X } = await load();
    expect(X.findMatches(screen, "").matches).toEqual([]);
    const none = X.findMatches(screen, "zzz");
    expect(none.matches).toEqual([]);
    expect([X.searchCount("", 0, -1, false), X.searchCount("zzz", 0, -1, false), X.searchCount("erro", 12, 2, false), X.searchCount("e", 2000, 0, true)]).toEqual(["", "Sem resultado", "3/12", "1/2000+"]);
  });

  test("o teto de achados corta e avisa, e a consulta passa do teto de caracteres aparada", async () => {
    const { X } = await load();
    const many = Array.from({ length: 50 }, () => "aaaa");
    expect(X.findMatches(many, "a", 10)).toMatchObject({ truncated: true });
    expect(X.findMatches(many, "a", 10).matches.length).toBe(10);
    expect(X.normalizeQuery("x".repeat(500)).length).toBe(X.QUERY_MAX);
  });

  test("consulta com caracteres de expressão regular é texto, não padrão", async () => {
    const { X } = await load();
    expect(X.findMatches(["a.c abc (x"], ".c").matches).toEqual([{ line: 0, col: 1, len: 2 }]);
    expect(X.findMatches(["a.c abc (x"], "(").matches).toEqual([{ line: 0, col: 8, len: 1 }]);
  });

  test("próximo e anterior dão a volta nas pontas e sem achado ficam em -1", async () => {
    const { X } = await load();
    expect([X.stepMatch(3, 0, 1), X.stepMatch(3, 2, 1), X.stepMatch(3, 0, -1), X.stepMatch(3, -1, 1), X.stepMatch(3, -1, -1), X.stepMatch(0, -1, 1)]).toEqual([1, 0, 2, 0, 2, -1]);
  });

  test("a janela vai ao achado: no fim é a tela ao vivo, acima é uma janela do histórico que o contém", async () => {
    const { X } = await load();
    expect(X.offsetFor(98, 100, 10)).toBe(0);
    const off = X.offsetFor(10, 100, 10);
    expect(X.matchInWindow({ line: 10, col: 2, len: 3 }, 100, 10, off)).toEqual({ row: expect.any(Number), col: 2, len: 3 });
    expect(X.matchInWindow({ line: 10, col: 0, len: 1 }, 100, 10, 0)).toBeNull();
    expect(X.matchInWindow({ line: 95, col: 0, len: 1 }, 100, 10, 0)).toEqual({ row: 5, col: 0, len: 1 });
  });

  test("teclas: Ctrl+F abre só sem Shift e Alt; Esc fecha, Enter avança e Shift+Enter volta", async () => {
    const { X } = await load();
    const key = (o: Dict) => ({ key: "f", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
    expect([X.isSearchChord(key({ ctrlKey: true })), X.isSearchChord(key({})), X.isSearchChord(key({ ctrlKey: true, shiftKey: true })), X.isSearchChord(key({ ctrlKey: true, altKey: true })), X.isSearchChord(key({ metaKey: true }))]).toEqual([true, false, false, false, true]);
    expect([X.searchKeyIntent({ key: "Escape" }), X.searchKeyIntent({ key: "Enter" }), X.searchKeyIntent({ key: "Enter", shiftKey: true }), X.searchKeyIntent({ key: "a" })]).toEqual(["close", "next", "prev", null]);
  });

  test("a barra não rouba as teclas globais: o Ctrl+F do terminal não é global e as globais do Argos seguem fora do terminal", async () => {
    const { tty } = await load();
    expect(tty.TTY_GLOBAL_KEYS).toContain("Ctrl+Shift+A");
    expect(tty.TTY_GLOBAL_KEYS).not.toContain("Ctrl+F");
    expect(tty.inSearchBar({ target: { closest: (sel: string) => (sel === "[data-tty-search]" ? {} : null) } })).toBe(true);
    expect(tty.inSearchBar({ target: { closest: () => null } })).toBe(false);
  });
});

describe("link de caminho: a raiz é decidida pelo servidor", () => {
  const T = mkdtempSync(join(tmpdir(), "hades-tty-links-"));
  afterAll(() => rmSync(T, { recursive: true, force: true }));
  const root = join(T, "raiz");
  const fora = join(T, "fora");
  mkdirSync(root, { recursive: true });
  mkdirSync(fora, { recursive: true });
  writeFileSync(join(root, "a.md"), "# a");
  writeFileSync(join(fora, "b.md"), "# b");
  symlinkSync(fora, join(root, "atalho"));
  const routes = createCanvasNotesRoutes(join(T, "D"), { loadDoc: async () => undefined, roots: [root] });
  const link = async (path: unknown) => {
    const res = await routes.action("/api/canvas-notes/link", new Request("http://127.0.0.1/api/canvas-notes/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) }), { remote: false })!;
    return [res.status, ((await res.json()) as Dict).code ?? "ok"];
  };

  test("dentro da raiz abre; com .., fora da raiz, por link simbólico para fora, relativo ou com outra extensão é recusado", async () => {
    expect(await link(join(root, "a.md"))).toEqual([200, "ok"]);
    for (const path of [join(root, "..", "fora", "b.md"), join(fora, "b.md"), join(root, "atalho", "b.md"), "a.md", join(root, "a.html")]) {
      expect(await link(path)).toEqual([400, NOTE_ROUTE_ERRORS.invalidPath]);
    }
  });

  test("o painel remoto não abre arquivo local", async () => {
    const res = await routes.action("/api/canvas-notes/link", new Request("http://127.0.0.1/api/canvas-notes/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: join(root, "a.md") }) }), { remote: true })!;
    expect(res.status).toBe(403);
  });
});
