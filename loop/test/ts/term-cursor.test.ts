/// <reference path="../../../kit/panel/ui/term-logic.tsx" />
// Cursor do terminal do nó do Argos: com o foco do nó o cursor pisca na posição de inserção, sem ele vira contorno, como no
// PtyTerminal da página Terminal. O herdr 0.8.2 não entrega o cursor (pane.read traz só texto e revisão), então a posição é
// estimada pelo quadro (`guessCursor`). Sem DOM: o xterm é um dublê que guarda as opções e os eventos de foco que recebe.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createUiTranspiler } from "../../../src/panel/ui-transpile";
import "../../../kit/panel/ui/term-logic.tsx";
import { loadNodeTty } from "./lib/node-tty-load";

type Dict = Record<string, any>;
const L = (globalThis as unknown as { TermLogic: Dict }).TermLogic;
const uiDir = join(import.meta.dir, "../../../kit/panel/ui");

describe("guessCursor: onde o texto vai entrar", () => {
  test("dado o prompt sem nada digitado, então o cursor fica um espaço depois do prompt", () => {
    expect(L.guessCursor("user@host:~\r\n$", 80, 24)).toEqual({ row: 1, col: 2 });
  });
  test("dado texto digitado depois do prompt, então o cursor fica logo depois do último caractere", () => {
    expect(L.guessCursor("$ ls -la", 80, 24)).toEqual({ row: 0, col: 8 });
  });
  test("dado ANSI de cor na linha, então a largura conta só o que aparece", () => {
    expect(L.guessCursor("\x1b[32m$\x1b[0m echo \x1b[1moi\x1b[0m", 80, 24)).toEqual({ row: 0, col: 9 });
  });
  test("dadas linhas vazias depois do prompt, então vale a última linha com conteúdo", () => {
    expect(L.guessCursor("$ cd /tmp\r\n\r\n   \r\n", 80, 24)).toEqual({ row: 0, col: 9 });
  });
  test("dada a tela vazia, então o cursor vai ao canto superior esquerdo", () => {
    expect(L.guessCursor("", 80, 24)).toEqual({ row: 0, col: 0 });
    expect(L.guessCursor("   \r\n  ", 80, 24)).toEqual({ row: 0, col: 0 });
  });
  test("dada a linha mais larga que a grade, então o cursor fica na última coluna", () => {
    expect(L.guessCursor("x".repeat(200), 80, 24)).toEqual({ row: 0, col: 79 });
  });
  test("dado texto além das linhas da grade, então o cursor não sai dela", () => {
    expect(L.guessCursor("a\r\nb\r\nc\r\nd", 80, 2)).toEqual({ row: 1, col: 1 });
  });
  test("dado caractere fora do plano básico, então conta como uma célula", () => {
    expect(L.guessCursor("$ 😀", 80, 24)).toEqual({ row: 0, col: 3 });
  });
  test("dado vídeo inverso no quadro, então o programa desenha o próprio cursor e nada é estimado", () => {
    expect(L.guessCursor("> oi\x1b[7m \x1b[27m", 80, 24)).toBeNull();
    expect(L.guessCursor("\x1b[1;7m status \x1b[0m", 80, 24)).toBeNull();
  });
  test("dada cor estendida cujo valor é 7, então não é vídeo inverso", () => {
    expect(L.guessCursor("\x1b[38;5;7mtexto\x1b[0m", 80, 24)).toEqual({ row: 0, col: 5 });
    expect(L.guessCursor("\x1b[48;2;7;7;7mtexto\x1b[0m", 80, 24)).toEqual({ row: 0, col: 5 });
  });
  describe("caixa de entrada do Claude Code", () => {
    const rule = `\x1b[0m\x1b[38;5;7m${"─".repeat(40)}\x1b[0m`;
    const footer = "  \x1b[0m\x1b[38;5;3m⏵⏵ auto mode on\x1b[0m\x1b[38;5;8m (shift+tab to cycle)\x1b[0m";
    const frame = (...input: string[]) => ["✻ Baked for 2m 8s", "", rule, ...input, rule, "  5 h 10%", footer].join("\r\n");
    test("dada a caixa vazia, então o cursor fica depois do ❯ e não no rodapé", () => {
      expect(L.guessCursor(frame("❯\u00a0"), 80, 24)).toEqual({ row: 3, col: 2 });
    });
    test("dada a sugestão esmaecida na caixa vazia, então ela não conta", () => {
      expect(L.guessCursor(frame("❯\u00a0\x1b[0m\x1b[2mpode pedir os reviewers\x1b[0m"), 80, 24)).toEqual({ row: 3, col: 2 });
    });
    test("dado texto digitado, então o cursor fica no fim dele", () => {
      expect(L.guessCursor(frame("❯ corrige o teste"), 80, 24)).toEqual({ row: 3, col: 17 });
    });
    test("dada entrada de várias linhas, então vale a última linha com texto da caixa", () => {
      expect(L.guessCursor(frame("❯ primeira", "  segunda linha", ""), 80, 24)).toEqual({ row: 4, col: 15 });
    });
    test("dado vídeo inverso no rodapé, então a caixa ainda decide", () => {
      const withInverse = frame("❯ oi").replace("5 h 10%", "\x1b[7m5 h\x1b[27m");
      expect(L.guessCursor(withInverse, 80, 24)).toEqual({ row: 3, col: 4 });
    });
    test("dado vídeo inverso dentro da caixa, então o programa desenhou o cursor e nada é estimado", () => {
      expect(L.guessCursor(frame("❯ oi\x1b[7m \x1b[27m"), 80, 24)).toBeNull();
    });
    test("dadas réguas sem ❯ logo abaixo, então vale a regra geral", () => {
      expect(L.guessCursor([rule, "texto", rule, "$ ls"].join("\r\n"), 80, 24)).toEqual({ row: 3, col: 4 });
    });
  });
  test("dada entrada que não serve, então nada é estimado", () => {
    expect(L.guessCursor(undefined, 80, 24)).toBeNull();
    expect(L.guessCursor("$", 0, 24)).toBeNull();
    expect(L.guessCursor("$", 80, 1.5)).toBeNull();
  });
});

describe("frameCursor: o do produtor vale mais que a estimativa", () => {
  test("dado cursor no quadro, então ele vence", async () => {
    const Tty = await loadNodeTty();
    expect(Tty.frameCursor({ ansi: "$ ls", cols: 80, rows: 24, cursor: { row: 5, col: 7 } })).toEqual({ row: 5, col: 7 });
  });
  test("dado quadro sem cursor, então a posição vem do texto", async () => {
    const Tty = await loadNodeTty();
    expect(Tty.frameCursor({ ansi: "$ ls", cols: 80, rows: 24 })).toEqual({ row: 0, col: 4 });
  });
  test("dado cursor escondido pelo produtor, então nada é estimado no lugar", async () => {
    const Tty = await loadNodeTty();
    expect(Tty.frameCursor({ ansi: "$ ls", cols: 80, rows: 24, cursor: { row: 0, col: 4, visible: false } })).toBeNull();
  });
  test("a tela montada mostra o cursor (?25h) na posição estimada", async () => {
    const Tty = await loadNodeTty();
    const frame = { ansi: "$ ls", cols: 80, rows: 24 };
    expect(Tty.screenOf(frame.ansi, Tty.frameCursor(frame))).toEndWith("\x1b[1;5H\x1b[?25h");
  });
});

describe("foco do nó vira foco do xterm", () => {
  const events: string[] = [];
  const realFocusEvent = (globalThis as Dict).FocusEvent;
  (globalThis as Dict).FocusEvent = class extends Event {};
  afterEach(() => { events.length = 0; });
  const termWith = (): Dict => ({ textarea: { dispatchEvent: (e: Event) => { events.push(e.type); return true; } } });

  test("dado o nó com o foco, então o xterm recebe focus", async () => {
    const Tty = await loadNodeTty();
    Tty.setTermFocus(termWith(), true);
    expect(events).toEqual(["focus"]);
  });
  test("dado o nó sem o foco, então o xterm recebe blur", async () => {
    const Tty = await loadNodeTty();
    Tty.setTermFocus(termWith(), false);
    expect(events).toEqual(["blur"]);
  });
  test("dado xterm ainda sem textarea, então nada acontece", async () => {
    const Tty = await loadNodeTty();
    expect(() => Tty.setTermFocus({ textarea: null }, true)).not.toThrow();
    expect(() => Tty.setTermFocus(null, true)).not.toThrow();
    expect(events).toEqual([]);
  });
  test("fim", () => { (globalThis as Dict).FocusEvent = realFocusEvent; });
});

describe("createXterm: o cursor é o do PtyTerminal nos dois usos", () => {
  const seen: Dict[] = [];
  class FakeTerminal {
    options: Dict;
    constructor(opts: Dict) { this.options = opts; seen.push(opts); }
    loadAddon() {}
    open() {}
    dispose() {}
  }
  class FakeFit {}
  function createXterm(): (el: unknown, opts?: Dict) => Dict {
    const saved: Dict = {};
    const stub: Dict = {
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
      MutationObserver: class { observe() {} disconnect() {} },
      document: { documentElement: {}, createElement: () => { throw new Error("sem canvas"); } },
    };
    for (const [k, v] of Object.entries(stub)) { saved[k] = (globalThis as Dict)[k]; (globalThis as Dict)[k] = v; }
    try {
      const HadesCore: Dict = { useState() {}, useEffect() {}, useRef() {}, I: {}, cn() {}, Button() {}, useApp() {} };
      const win: Dict = { Terminal: FakeTerminal, FitAddon: { FitAddon: FakeFit }, TermLogic: L };
      new Function("globalThis", "window", "React", "HadesCore", "HadesPanel", createUiTranspiler().transpile(join(uiDir, "term.tsx")))(globalThis, win, {}, HadesCore, {});
      return HadesCore.createXterm;
    } finally {
      for (const [k, v] of Object.entries(saved)) (globalThis as Dict)[k] = v;
    }
  }
  const make = (opts?: Dict) => {
    const factory = createXterm();
    (globalThis as Dict).getComputedStyle = () => ({ getPropertyValue: () => "" });
    (globalThis as Dict).MutationObserver = class { observe() {} disconnect() {} };
    (globalThis as Dict).document = { documentElement: {}, createElement: () => { throw new Error("sem canvas"); } };
    try { factory({}, opts); } finally { delete (globalThis as Dict).getComputedStyle; delete (globalThis as Dict).MutationObserver; delete (globalThis as Dict).document; }
    const last = seen[seen.length - 1];
    if (!last) throw new Error("createXterm não chamou o Terminal");
    return last;
  };

  test("dado o nó do Argos (readOnly), então o cursor pisca e vira contorno sem foco, e o xterm não gera entrada", () => {
    const o = make({ readOnly: true, fontSize: 13, scrollback: 0 });
    expect(o.cursorBlink).toBe(true);
    expect(o.cursorInactiveStyle).toBe("outline");
    expect(o.disableStdin).toBe(true);
  });
  test("dado o PtyTerminal (leitura e escrita), então o cursor é o mesmo e a entrada fica ligada", () => {
    const o = make({});
    expect(o.cursorBlink).toBe(true);
    expect(o.cursorInactiveStyle).toBe("outline");
    expect(o.disableStdin).toBe(false);
  });
  test("o tema dá ao cursor a cor do texto e ao realce a do fundo (contraste nos dois temas)", () => {
    const o = make({});
    expect(o.theme.cursor).toBe(o.theme.foreground);
    expect(o.theme.cursorAccent).toBe(o.theme.background);
    expect(o.minimumContrastRatio).toBeGreaterThanOrEqual(4.5);
  });
});

test("a fonte do nó e do PtyTerminal não regrediu: tecla morta e roda seguem no node-tty", () => {
  const src = readFileSync(join(uiDir, "argos/node-tty.tsx"), "utf8");
  expect(src).toContain("createTextInput");
  expect(src).toContain("wheelScroll");
});
