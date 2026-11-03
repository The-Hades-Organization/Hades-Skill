// Terminal ao vivo do nó (node-tty.tsx): medida do espaço de desenho (#16), entrada por texto composto (#15), seleção e
// cópia (#14) e roda do mouse (#13). Sem DOM: o script clássico roda num escopo próprio com o HadesCore de mentira.
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
    const bundle = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const holder: Dict = {};
    new Function("globalThis", bundle as string)(holder);
    const HadesCore = {
      useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => undefined],
      useEffect: () => undefined, useRef: (v: unknown) => ({ current: v }), cn: (...a: unknown[]) => a.filter(Boolean).join(" "),
    };
    const scope: Dict = { CanvasModel: holder.CanvasModel };
    new Function("globalThis", "window", "React", "HadesCore", createUiTranspiler().transpile(join(uiDir, "argos/node-tty.tsx")))(scope, scope, mod.exports, HadesCore);
    return scope.ArgosNodeTty;
  })();
  return loaded;
}

const frame = { pane: "w1:p1", revision: 1, cols: 80, rows: 24, ansi: "" };

describe("#16 medida do espaço de desenho", () => {
  test("dado o tamanho de layout da área, quando medido, então desconta o respiro dos dois lados", async () => {
    const Tty = await load();
    expect(Tty.areaBox(412, 300)).toEqual({ w: 400, h: 288 });
  });

  test("dada uma área menor que o respiro ou inválida, então a medida é zero e nunca negativa", async () => {
    const Tty = await load();
    expect(Tty.areaBox(5, 0)).toEqual({ w: 0, h: 0 });
    expect(Tty.areaBox(Number.NaN, Infinity)).toEqual({ w: 0, h: 0 });
  });

  test("dado um nó na escala 1, quando a escala vem do tamanho dele, então não depende do zoom do canvas", async () => {
    const Tty = await load();
    // nó de 600×(28+300): área 588×288 para uma grade de 624×408: a altura manda
    const size = { w: 600, h: 28 + 300 };
    const at1 = Tty.fitForNode(size, frame);
    expect(at1).toBeCloseTo(Math.min(588 / (80 * 7.8), 288 / (24 * 17)), 5);
    // o getBoundingClientRect de um canvas com zoom 2 mediria o dobro; o tamanho de layout é o mesmo
    expect(Tty.fitForNode(size, frame)).toBe(at1);
    expect(Tty.fitScale(Tty.areaBox(2 * 612, 2 * 312), frame)).not.toBe(at1);
  });

  test("dado um nó enorme ou minúsculo, então a escala fica entre o mínimo e o máximo", async () => {
    const Tty = await load();
    expect(Tty.fitForNode({ w: 9000, h: 9000 }, frame)).toBe(2);
    expect(Tty.fitForNode({ w: 10, h: 10 }, frame)).toBe(0.2);
  });
});

/** Campo falso: o que o navegador deixaria em `textarea.value` a cada passo da composição. */
function fakeField() {
  const sent: string[] = [];
  return { box: { value: "" }, sent };
}

describe("#15 acentuação e IME", () => {
  test("dada tecla morta + vogal em navegador que compõe (Chrome), então sai um único { text: 'é' }", async () => {
    const Tty = await load();
    const { box, sent } = fakeField();
    const textIn = Tty.createTextInput(box, (t: string) => sent.push(t));
    textIn.compositionStart();
    box.value = "´"; textIn.input(true);
    box.value = "é"; textIn.input(true);
    textIn.compositionEnd("é");
    expect(sent).toEqual(["é"]);
    expect(box.value).toBe("");
  });

  test("dado navegador que dispara input depois do compositionend (Safari), então o eco não duplica", async () => {
    const Tty = await load();
    const { box, sent } = fakeField();
    const textIn = Tty.createTextInput(box, (t: string) => sent.push(t));
    textIn.compositionStart();
    box.value = "é";
    textIn.compositionEnd("é");
    textIn.input(false);
    expect(sent).toEqual(["é"]);
  });

  test("dado IME que confirma várias letras de uma vez, então vai tudo num único texto", async () => {
    const Tty = await load();
    const { box, sent } = fakeField();
    const textIn = Tty.createTextInput(box, (t: string) => sent.push(t));
    textIn.compositionStart();
    box.value = "にほ"; textIn.input(true);
    box.value = "日本"; textIn.input(true);
    textIn.compositionEnd("日本");
    expect(sent).toEqual(["日本"]);
  });

  test("dado teclado que digita é direto, sem composição, então o input entrega uma vez", async () => {
    const Tty = await load();
    const { box, sent } = fakeField();
    const textIn = Tty.createTextInput(box, (t: string) => sent.push(t));
    box.value = "é"; textIn.input(false);
    textIn.input(false);
    expect(sent).toEqual(["é"]);
  });

  test("dado compositionend sem data, então vale o texto que o campo guarda", async () => {
    const Tty = await load();
    const { box, sent } = fakeField();
    const textIn = Tty.createTextInput(box, (t: string) => sent.push(t));
    textIn.compositionStart();
    box.value = "ç";
    textIn.compositionEnd(undefined);
    expect(sent).toEqual(["ç"]);
  });

  test("dada composição cancelada (nada montado), então nada é enviado", async () => {
    const Tty = await load();
    const { box, sent } = fakeField();
    const textIn = Tty.createTextInput(box, (t: string) => sent.push(t));
    textIn.compositionStart();
    textIn.compositionEnd("");
    expect(sent).toEqual([]);
  });

  test("dado keydown de tecla morta ou de composição, então o terminal não consome e o campo trata", async () => {
    const Tty = await load();
    const base = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(Tty.translateKey({ ...base, key: "Dead" })).toBeNull();
    expect(Tty.translateKey({ ...base, key: "Process", keyCode: 229 })).toBeNull();
    expect(Tty.translateKey({ ...base, key: "é", isComposing: true })).toBeNull();
    expect(Tty.isCompositionKey({ ...base, key: "a", keyCode: 229 })).toBe(true);
    expect(Tty.translateKey({ ...base, key: "é" })).toEqual({ text: "é" });
  });
});

describe("#15 compositor do canvas não engole a composição", () => {
  test("dada tecla de composição no campo do compositor, então ele a deixa passar (Enter/Esc/Tab dela não agem)", async () => {
    const g = globalThis as unknown as Record<string, any>;
    const scope: Dict = {};
    new Function("globalThis", (await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE)) as string)(scope);
    g.CanvasModel = scope.CanvasModel;
    try {
      // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
      await import("../../../kit/panel/ui/argos/canvas-composer.tsx?tty-input");
    } finally {
      delete g.CanvasModel;
    }
    const api = g.ArgosCanvasComposer;
    delete g.ArgosCanvasComposer;
    expect(api.isComposing({ key: "Enter", isComposing: true })).toBe(true);
    expect(api.isComposing({ key: "Escape", keyCode: 229 })).toBe(true);
    expect(api.isComposing({ key: "Dead" })).toBe(true);
    expect(api.isComposing({ key: "Enter", keyCode: 13 })).toBe(false);
  });
});

describe("#14 seleção e cópia", () => {
  const key = (k: string, mods: Dict = {}) => ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

  test("dado texto selecionado, quando Ctrl+C, então copia e a tecla não vai ao pane", async () => {
    const Tty = await load();
    expect(Tty.clipboardIntent(key("c", { ctrlKey: true }), true)).toBe("copy");
    expect(Tty.clipboardIntent(key("c", { metaKey: true }), true)).toBe("copy");
  });

  test("dado nada selecionado, quando Ctrl+C, então é o Ctrl+C do agente", async () => {
    const Tty = await load();
    expect(Tty.clipboardIntent(key("c", { ctrlKey: true }), false)).toBeNull();
    expect(Tty.translateKey(key("c", { ctrlKey: true }))).toEqual({ keys: ["Ctrl+C"] });
  });

  test("dado ou não selecionado, quando Ctrl+Shift+C, então sempre copia (maiúscula do navegador inclusive)", async () => {
    const Tty = await load();
    expect(Tty.clipboardIntent(key("C", { ctrlKey: true, shiftKey: true }), false)).toBe("copy");
    expect(Tty.clipboardIntent(key("c", { ctrlKey: true, shiftKey: true }), true)).toBe("copy");
  });

  test("dadas outras teclas ou Alt, então não é pedido de cópia", async () => {
    const Tty = await load();
    expect(Tty.clipboardIntent(key("x", { ctrlKey: true }), true)).toBeNull();
    expect(Tty.clipboardIntent(key("c"), true)).toBeNull();
    expect(Tty.clipboardIntent(key("c", { ctrlKey: true, altKey: true }), true)).toBeNull();
  });

  test("dado Ctrl+Shift+V, então o terminal não o consome: a colagem chega pelo evento paste", async () => {
    const Tty = await load();
    expect(Tty.translateKey(key("V", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(Tty.translateKey(key("v", { ctrlKey: true }))).toBeNull();
  });

  test("dada seleção dentro da grade, então o texto sai; fora dela ou recolhida, vazio", async () => {
    const Tty = await load();
    const g = globalThis as unknown as Dict;
    const inside = { nodeType: 3, parentNode: {} };
    const grid = { contains: (n: unknown) => n === inside.parentNode };
    const outside = { nodeType: 3, parentNode: {} };
    const sel = (over: Dict) => ({ rangeCount: 1, isCollapsed: false, anchorNode: inside, focusNode: inside, toString: () => "ls -la", ...over });
    const prev = g.getSelection;
    try {
      g.getSelection = () => sel({});
      expect(Tty.selectedText(grid)).toBe("ls -la");
      g.getSelection = () => sel({ anchorNode: outside });
      expect(Tty.selectedText(grid)).toBe("");
      g.getSelection = () => sel({ isCollapsed: true });
      expect(Tty.selectedText(grid)).toBe("");
      g.getSelection = () => sel({ rangeCount: 0 });
      expect(Tty.selectedText(grid)).toBe("");
      expect(Tty.selectedText(null)).toBe("");
    } finally {
      g.getSelection = prev;
    }
  });
});

describe("#13 roda do mouse sobre o terminal", () => {
  test("dada roda comum, então é do terminal; com Ctrl ou Alt segue do canvas", async () => {
    const Tty = await load();
    expect(Tty.wheelIntent({ ctrlKey: false, altKey: false })).toBe("own");
    expect(Tty.wheelIntent({ ctrlKey: true, altKey: false })).toBe("canvas");
    expect(Tty.wheelIntent({ ctrlKey: false, altKey: true })).toBe("canvas");
  });

  test("dado o marcador data-tty-wheel, então o terminal o declara e o motor do canvas o respeita antes de mover a câmera", () => {
    const tty = readFileSync(join(uiDir, "argos/node-tty.tsx"), "utf8");
    const engine = readFileSync(join(uiDir, "argos/canvas-engine.tsx"), "utf8");
    expect(tty).toContain("data-tty-wheel");
    const wheel = engine.slice(engine.indexOf("function onWheel"));
    const guard = wheel.indexOf('closest("[data-tty-wheel]")');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(wheel.indexOf("setCam(C.wheelCamera"));
  });
});

describe("#13 histórico do terminal (scrollback)", () => {
  test("dado o ANSI de recent com fim de linha CRLF e rodapé vazio, então devolve só as linhas com conteúdo", async () => {
    const Tty = await load();
    expect(Tty.historyLinesOf("a\r\nb\r\n\r\n")).toEqual(["a", "b"]);
  });

  test("dado um ANSI vazio, então não há linhas", async () => {
    const Tty = await load();
    expect(Tty.historyLinesOf("")).toEqual([]);
  });

  test("dado um offset negativo ou além do histórico, então fica preso entre 0 e total - rows", async () => {
    const Tty = await load();
    expect(Tty.clampOffset(-5, 100, 24)).toBe(0);
    expect(Tty.clampOffset(10, 100, 24)).toBe(10);
    expect(Tty.clampOffset(999, 100, 24)).toBe(76);
  });

  test("dado um histórico menor que a tela, então o offset é sempre 0", async () => {
    const Tty = await load();
    expect(Tty.clampOffset(7, 10, 24)).toBe(0);
  });

  test("dado offset 0, então a janela são as últimas rows linhas", async () => {
    const Tty = await load();
    const lines = Array.from({ length: 50 }, (_, i) => `l${i + 1}`);
    expect(Tty.historyWindow(lines, 3, 0)).toEqual(["l48", "l49", "l50"]);
  });

  test("dado offset no meio, então a janela termina offset linhas antes do fim", async () => {
    const Tty = await load();
    const lines = Array.from({ length: 50 }, (_, i) => `l${i + 1}`);
    expect(Tty.historyWindow(lines, 3, 10)).toEqual(["l38", "l39", "l40"]);
  });

  test("dado offset maior que o histórico, então a janela fica presa ao topo", async () => {
    const Tty = await load();
    const lines = Array.from({ length: 50 }, (_, i) => `l${i + 1}`);
    expect(Tty.historyWindow(lines, 3, 9999)).toEqual(["l1", "l2", "l3"]);
  });

  test("dado histórico menor que a tela, então a janela traz tudo", async () => {
    const Tty = await load();
    expect(Tty.historyWindow(["a", "b"], 24, 5)).toEqual(["a", "b"]);
  });

  test("dado giro da roda, então para cima é positivo (histórico) e para baixo é negativo, por modo de delta", async () => {
    const Tty = await load();
    expect(Tty.wheelLines({ deltaY: -3, deltaMode: 1 }, 24)).toBe(3);
    expect(Tty.wheelLines({ deltaY: 2, deltaMode: 1 }, 24)).toBe(-2);
    expect(Tty.wheelLines({ deltaY: -1, deltaMode: 2 }, 24)).toBe(24);
    expect(Tty.wheelLines({ deltaY: -1, deltaMode: 0 }, 24)).toBeGreaterThanOrEqual(1);
  });

  test("dado deltaY zero ou inválido, então não rola", async () => {
    const Tty = await load();
    expect(Tty.wheelLines({ deltaY: 0, deltaMode: 0 }, 24)).toBe(0);
    expect(Tty.wheelLines({ deltaY: Number.NaN, deltaMode: 0 }, 24)).toBe(0);
  });
});
