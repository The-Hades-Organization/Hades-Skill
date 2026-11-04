// Aba Workspaces com terminal (herdr-term.tsx): bytes da barra de teclas -> contrato do /api/herdr/input, fila de entrada,
// URL do fluxo e a ligação da vista no desktop e no celular (herdr.tsx). Sem DOM: o script clássico roda num escopo próprio.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createUiTranspiler } from "../../../src/panel/ui-transpile";

const root = join(import.meta.dir, "../../..");
const uiDir = join(root, "kit/panel/ui");
type Dict = Record<string, any>;

function load(win: Dict = {}): Dict {
  const scope: Dict = { ...win };
  const HadesCore = { useState: (v: unknown) => [v, () => undefined], useEffect: () => undefined, useRef: (v: unknown) => ({ current: v }), useCallback: (f: unknown) => f, I: {}, cn: (...a: unknown[]) => a.filter(Boolean).join(" "), post: async () => ({}), Button: () => null };
  new Function("window", "HadesCore", "React", createUiTranspiler().transpile(join(uiDir, "herdr-term.tsx")))(scope, HadesCore, { createElement: () => null });
  return scope.HerdrTerm;
}
const H = load();
const src = (f: string) => readFileSync(join(uiDir, f), "utf8");

describe("bytes do terminal -> entrada do contrato", () => {
  test.each([
    ["\x1b", ["Escape"]], ["\t", ["Tab"]], ["\r", ["Enter"]], ["\x7f", ["Backspace"]], ["\x1b[Z", ["Shift+Tab"]],
    ["\x1b[A", ["Up"]], ["\x1bOB", ["Down"]], ["\x1b[C", ["Right"]], ["\x1b[D", ["Left"]], ["\x03", ["Ctrl+C"]], ["\x01", ["Ctrl+A"]],
  ])("dado os bytes %j, então vira a tecla %j", (bytes, keys) => {
    expect(H.bytesToInput(bytes)).toEqual({ keys });
  });
  test("dado texto, inclusive acentuado, então vai como texto", () => {
    expect(H.bytesToInput("y")).toEqual({ text: "y" });
    expect(H.bytesToInput("ação é")).toEqual({ text: "ação é" });
  });
  test("dado vazio ou não-texto, então não há o que enviar", () => {
    for (const v of ["", null, undefined, 3]) expect(H.bytesToInput(v)).toBeNull();
  });
});

describe("entrada limpa", () => {
  test("dada tecla que o herdr recusa, então sai da entrada e, se nada sobra, é descartada", () => {
    expect(H.cleanInput({ keys: ["Home", "Up"], text: "a" })).toEqual({ text: "a", keys: ["Up"] });
    expect(H.cleanInput({ keys: ["PageDown", "Delete"] })).toBeNull();
    expect(H.cleanInput({ text: "" })).toBeNull();
    expect(H.cleanInput(null)).toBeNull();
  });
  test("dada a lista do Argos já carregada, então ela manda", () => {
    const h = load({ ArgosNodeTerminal: { TTY_BLOCKED_KEYS: ["Tab"] } });
    expect(h.cleanInput({ keys: ["Tab", "Home"] })).toEqual({ keys: ["Home"] });
  });
});

describe("fluxo", () => {
  test("dados sessão e pane com caracteres especiais, então a URL os escapa", () => {
    expect(H.streamUrl("a b", "w1:p2")).toBe("/api/herdr/stream?session=a%20b&panes=w1%3Ap2");
  });
  test("dado quadro de outro pane, sem grade ou sem revisão, então é recusado", () => {
    const ok = { pane: "w1:p1", ansi: "", cols: 80, rows: 24, revision: 1 };
    expect(H.validFrame(ok, "w1:p1")).toBe(true);
    expect(H.validFrame({ ...ok, pane: "w1:p2" }, "w1:p1")).toBe(false);
    expect(H.validFrame({ ...ok, cols: 80.5 }, "w1:p1")).toBe(false);
    expect(H.validFrame({ ...ok, revision: "1" }, "w1:p1")).toBe(false);
  });
});

describe("fila de entrada", () => {
  const take = (items: Dict[]) => ({ batch: items[0], rest: items.slice(1) });
  test("dados envios seguidos, então vai um por vez e na ordem", async () => {
    const sent: Dict[] = []; let open = 0, peak = 0;
    const q = H.createInputQueue(async (b: Dict) => { open++; peak = Math.max(peak, open); await Promise.resolve(); sent.push(b); open--; }, () => undefined, take);
    q.push({ text: "a" }); q.push({ keys: ["Enter"] }); q.push({ text: "b" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([{ text: "a" }, { keys: ["Enter"] }, { text: "b" }]);
    expect(peak).toBe(1);
  });
  test("dado envio recusado, então a mensagem do servidor chega a quem avisa e o seguinte limpa o aviso", async () => {
    const msgs: string[] = []; let n = 0;
    const q = H.createInputQueue(async () => { if (n++ === 0) throw new Error("tecla inválida"); }, (m: string) => msgs.push(m), take);
    q.push({ text: "a" }); await new Promise((r) => setTimeout(r, 5));
    q.push({ text: "b" }); await new Promise((r) => setTimeout(r, 5));
    expect(msgs).toEqual(["tecla inválida", ""]);
  });
  test("dada a fila fechada, então nada mais é enviado", async () => {
    const sent: Dict[] = [];
    const q = H.createInputQueue(async (b: Dict) => { sent.push(b); }, () => undefined, take);
    q.close(); q.push({ text: "x" });
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toEqual([]);
  });
  test("dada entrada que o herdr recusa por inteiro, então nem entra na fila", async () => {
    const sent: Dict[] = [];
    const q = H.createInputQueue(async (b: Dict) => { sent.push(b); }, () => undefined, take);
    q.push({ keys: ["Home"] });
    await new Promise((r) => setTimeout(r, 5));
    expect(sent).toEqual([]);
  });
});

describe("ligação da vista", () => {
  const page = src("pages/herdr.tsx");
  test("dado o desktop, então o detalhe do pane abre o terminal e o <pre> fica numa alternativa recolhida", () => {
    expect(page).toContain("<Term key={`${session}/${pane.id}`}");
    expect(page).toMatch(/<details open=\{showText\}[\s\S]*<pre ref=\{box\}/);
    expect(page).toContain("(term && live === 'down')");
  });
  test("dado o celular, então a tela cheia leva o terminal, a barra de teclas por apiRef e os detalhes numa folha sem terminal", () => {
    expect(page).toMatch(/<HadesCore\.Mobile\.MobileTermScreen key=\{sel\.id\}[^>]*apiRef=\{api\} attention=\{sel\.status === 'blocked'\}/);
    expect(page).toContain("<window.HerdrTerm.HerdrTerminal");
    expect(page).toContain("term={false}");
  });
  test("dado o botão de detalhes no cabeçalho, então o toque nele não tira o foco do terminal", () => {
    expect(page).toContain("data-herdr-keep");
    expect(src("herdr-term.tsx")).toContain("[data-term-keybar], [data-herdr-keep]");
  });
  test("dada a página, então o script do terminal é carregado antes dela", () => {
    const html = src("index.html");
    expect(html.indexOf("/ui/herdr-term.js")).toBeGreaterThan(0);
    expect(html.indexOf("/ui/herdr-term.js")).toBeLessThan(html.indexOf("/ui/pages/herdr.js"));
  });
  test("dado o terminal, então não anexa cliente herdr nem pede resize", () => {
    const code = src("herdr-term.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/resize|herdr-client/);
  });
});
