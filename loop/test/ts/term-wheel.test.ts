/// <reference path="../../../kit/panel/ui/term-logic.tsx" />
// Roda em tela alternativa na página Terminal (#18): com pane do herdr a roda pede o histórico (`/api/herdr/scrollback`, a regra
// do nó do Argos); sem pane ela segue ao programa e a dica aparece uma vez. Sem DOM: a decisão é `TermLogic` (term-logic.tsx),
// que o term.tsx liga ao xterm; o servidor só diz qual sessão do herdr o `herdr-client` mostra.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../../kit/panel/ui/term-logic.tsx";
import { createTerm, type Term } from "../../../src/panel/term.ts";
import { loadNodeTty } from "./lib/node-tty-load";

type Logic = ReturnType<typeof makeTermLogic>;
const L = (globalThis as unknown as { TermLogic: Logic }).TermLogic;

const tree = (focus: { ws?: boolean; tab?: boolean; pane?: boolean }) => ({
  tree: [
    { id: "w1", focused: false, tabs: [{ id: "w1:t1", focused: true, panes: [{ id: "w1:p1", focused: true }] }] },
    { id: "w2", focused: focus.ws ?? true, tabs: [
      { id: "w2:t1", focused: false, panes: [{ id: "w2:p1", focused: true }] },
      { id: "w2:t2", focused: focus.tab ?? true, panes: [{ id: "w2:p2", focused: false }, { id: "w2:p3", focused: focus.pane ?? true }] },
    ] },
  ],
});

describe("#18 quem recebe a roda", () => {
  test("dado o buffer normal, então a roda é do xterm, com ou sem pane (comportamento da #12 intacto)", () => {
    expect(L.wheelRoute(false, true)).toBe("xterm");
    expect(L.wheelRoute(false, false)).toBe("xterm");
  });
  test("dada tela alternativa com pane do herdr, então a roda pede o histórico", () => {
    expect(L.wheelRoute(true, true)).toBe("history");
  });
  test("dada tela alternativa sem pane, então a roda vai ao programa", () => {
    expect(L.wheelRoute(true, false)).toBe("program");
  });
});

describe("#18 dica sem pane", () => {
  test("dada a roda usada várias vezes em tela alternativa sem pane, então a dica sai só na primeira", () => {
    const hint = L.createWheelHint();
    expect([hint.take(), hint.take(), hint.take()]).toEqual([true, false, false]);
  });
  test("dada a dica, então cita PageUp/PageDown e o atalho do programa", () => {
    expect(L.WHEEL_HINT_TEXT).toContain("PageUp/PageDown");
    expect(L.WHEEL_HINT_TEXT).toContain("atalho de rolagem");
  });
});

describe("#18 pane que o herdr-client mostra", () => {
  test("dado workspace, aba e pane em foco, então é esse pane (não o outro pane em foco de outra aba)", () => {
    expect(L.focusedPaneOf(tree({}))).toBe("w2:p3");
  });
  test("dado que o pane não está em foco, então não há pane", () => {
    expect(L.focusedPaneOf(tree({ pane: false }))).toBeNull();
  });
  test("dada a aba ou o workspace fora de foco, então não há pane", () => {
    expect(L.focusedPaneOf(tree({ tab: false }))).toBeNull();
    expect(L.focusedPaneOf(tree({ ws: false }))).toBeNull();
  });
  test("dado visão vazia, nula ou sem árvore, então não há pane", () => {
    expect(L.focusedPaneOf(null)).toBeNull();
    expect(L.focusedPaneOf({})).toBeNull();
    expect(L.focusedPaneOf({ tree: [{ focused: true, tabs: [{ focused: true, panes: [{ id: 7, focused: true }] }] }] })).toBeNull();
  });
});

describe("#18 a regra de rolagem é uma só (a do nó do Argos)", () => {
  test("dado o nó do Argos, então expõe as funções de rolagem do term-logic (nenhuma cópia própria)", async () => {
    const tty = await loadNodeTty();
    const names = ["wheelStep", "scrollLive", "wheelScroll", "historyLoaded", "historyWindow", "clampOffset", "historyLinesOf", "screenOf"];
    for (const name of names) expect(typeof tty[name]).toBe("function");
    const src = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/argos/node-tty.tsx"), "utf8");
    for (const name of names) expect(src).not.toMatch(new RegExp(`^(function|const) ${name}\\b`, "m"));
    const ev = { deltaY: -3, deltaMode: 1 };
    expect(tty.wheelStep(0, ev, 24, 17)).toEqual(L.wheelStep(0, ev, 24, 17));
  });
  test("dado histórico carregado depois da roda, então a janela anda e a volta ao fim é ao vivo", () => {
    const rows = 5;
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
    let s = L.wheelScroll(L.scrollLive(), 3, rows);
    expect(s).toMatchObject({ lines: null, pending: 3 });
    s = L.historyLoaded(s, lines, rows);
    expect(L.historyWindow(s.lines!, rows, s.offset)).toEqual(["l12", "l13", "l14", "l15", "l16"]);
    expect(L.wheelScroll(s, -3, rows)).toEqual(L.scrollLive());
  });
});

describe("#18 sessão do herdr no servidor", () => {
  const T = mkdtempSync(join(tmpdir(), "hades-term-wheel-"));
  const made: Term[] = [];
  afterEach(() => { for (const t of made.splice(0)) t.stop(); });
  const fake = join(T, "cat");
  mkdirSync(T, { recursive: true });
  writeFileSync(fake, "#!/bin/bash\nstty raw -echo\nexec cat\n");
  chmodSync(fake, 0o755);
  const rig = () => {
    const D = join(T, `d${made.length}`);
    mkdirSync(D, { recursive: true });
    const term = createTerm({
      dataDir: D, defaultCwd: T, roots: () => [T, D], config: () => ({ HADES_TERMINAL: "1" }),
      notify: async () => undefined, log: () => undefined, command: () => [fake],
    });
    made.push(term);
    return term;
  };

  test("dado herdr-client sem sessão pedida, então a lista traz a sessão padrão do herdr", async () => {
    expect(await rig().open({ kind: "herdr-client" }, "local")).toMatchObject({ kind: "herdr-client", herdrSession: "default" });
  });
  test("dado herdr-client com sessão pedida, então a lista traz a pedida", async () => {
    expect(await rig().open({ kind: "herdr-client", session: "outra" }, "local")).toMatchObject({ herdrSession: "outra" });
  });
  test("dado shell ou claude, então não há sessão do herdr (a roda vai ao programa)", async () => {
    const term = rig();
    expect((await term.open({ kind: "shell" }, "local")).herdrSession).toBeUndefined();
    expect("herdrSession" in (await term.open({ kind: "claude" }, "local"))).toBe(false);
  });
  test("fim", () => { rmSync(T, { recursive: true, force: true }); });
});
