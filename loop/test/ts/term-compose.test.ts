/// <reference path="../../../kit/panel/ui/term-logic.tsx" />
// Tecla morta nos terminais do painel (´ + a = á). A sequência de eventos abaixo foi medida num Firefox 157 (Wayland, layout
// US internacional) com os eventos do `textarea` do xterm da página Herdr: não é inventada. Sem DOM: a regra é a máquina
// `TermLogic.composeGate`, que o term.tsx liga ao textarea; o nó do Argos usa `createTextInput` + `translateKey`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../../../kit/panel/ui/term-logic.tsx";
import { loadNodeTty } from "./lib/node-tty-load";

type Logic = ReturnType<typeof makeTermLogic>;
const T = (globalThis as unknown as { TermLogic: Logic }).TermLogic;

type Ev = { type: string; key?: string; keyCode?: number; isComposing?: boolean; data?: string | null; inputType?: string };
const kd = (key: string, keyCode: number, isComposing: boolean): Ev => ({ type: "keydown", key, keyCode, isComposing });
const comp = (type: "compositionstart" | "compositionupdate" | "compositionend", data: string): Ev => ({ type, data });
const inp = (type: "beforeinput" | "input", inputType: string, data: string, isComposing: boolean): Ev => ({ type, inputType, data, isComposing });

/** Firefox 157: `dead` + `base` → `composed`. O keydown da letra base chega duas vezes com keyCode real e isComposing true. */
function firefoxDead(dead: string, base: string, composed: string, keyCode: number): Ev[] {
  return [
    kd("Dead", 0, false), comp("compositionstart", ""), kd("Dead", 0, true), comp("compositionupdate", dead),
    inp("beforeinput", "insertCompositionText", dead, true), inp("input", "insertCompositionText", dead, true),
    kd(base, keyCode, true), comp("compositionupdate", ""), inp("beforeinput", "insertCompositionText", "", true),
    inp("input", "insertCompositionText", "", true), kd(base, keyCode, true), comp("compositionend", ""),
    inp("input", "insertCompositionText", "", false), kd("Process", 229, false),
    inp("beforeinput", "insertText", composed, false), inp("input", "insertText", composed, false),
  ];
}
/** Chrome: a composição fecha com o texto composto em `compositionend.data`, e a letra base vem como keyCode 229. */
function chromeDead(dead: string, composed: string): Ev[] {
  return [
    kd("Dead", 229, false), comp("compositionstart", ""), comp("compositionupdate", dead),
    inp("beforeinput", "insertCompositionText", dead, true), inp("input", "insertCompositionText", dead, true),
    kd(composed, 229, true), comp("compositionupdate", composed), inp("input", "insertCompositionText", composed, true), comp("compositionend", composed),
  ];
}

/** Roda os eventos pela máquina como o term.tsx faz: o que ela segura não chega ao xterm; o resto chega e `sentToXterm` guarda. */
function run(events: Ev[]) {
  const emitted: string[] = [];
  const sentToXterm: Ev[] = [];
  let value = "";
  const gate = T.composeGate((t) => emitted.push(t), { value: () => value, clear: () => { value = ""; } });
  for (const e of events) {
    if (e.type === "input" && typeof e.data === "string") value = e.inputType === "insertText" ? value + e.data : e.data;
    if (!gate.handle(e)) sentToXterm.push(e);
  }
  gate.settle();
  return { emitted, sentToXterm };
}

describe("tecla morta no xterm (páginas Terminal e Herdr)", () => {
  test("dado ´ + a no Firefox, quando os eventos passam pela máquina, então sai um único á e o xterm não vê a letra base", () => {
    const r = run(firefoxDead("´", "a", "á", 65));
    expect(r.emitted).toEqual(["á"]);
    expect(r.sentToXterm).toEqual([]);
  });
  test("dado ´a ~a ´e ^E em sequência, então saem á ã é Ê, nessa ordem, cada um uma vez", () => {
    const r = run([...firefoxDead("´", "a", "á", 65), ...firefoxDead("~", "a", "ã", 65), ...firefoxDead("´", "e", "é", 69), ...firefoxDead("^", "E", "Ê", 69)]);
    expect(r.emitted).toEqual(["á", "ã", "é", "Ê"]);
    expect(r.sentToXterm).toEqual([]);
  });
  test("dado ´ + a no Chrome, então sai um único á no compositionend", () => {
    const r = run(chromeDead("´", "á"));
    expect(r.emitted).toEqual(["á"]);
    expect(r.sentToXterm).toEqual([]);
  });
  test("dado texto normal antes e depois da tecla morta, então as teclas comuns seguem para o xterm", () => {
    const plain = [kd("x", 88, false), kd("y", 89, false)];
    const r = run([...plain, ...firefoxDead("´", "a", "á", 65), kd("z", 90, false)]);
    expect(r.emitted).toEqual(["á"]);
    expect(r.sentToXterm.map((e) => e.key)).toEqual(["x", "y", "z"]);
  });
  test("dado composição de IME (sem tecla morta antes), então a máquina não toca: é do xterm, que desenha o texto em composição", () => {
    const ime: Ev[] = [kd("Process", 229, false), comp("compositionstart", ""), comp("compositionupdate", "に"), comp("compositionend", "に")];
    const r = run(ime);
    expect(r.emitted).toEqual([]);
    expect(r.sentToXterm).toEqual(ime);
  });
  test("dado tecla morta sem composição (o navegador entrega o caractere direto), então nada fica preso: a próxima tecla segue", () => {
    const r = run([kd("Dead", 0, false), kd("a", 65, false), kd("b", 66, false)]);
    expect(r.emitted).toEqual([]);
    expect(r.sentToXterm.map((e) => e.key)).toEqual(["a", "b"]);
  });
  test("dado ´ seguido de uma letra sem composição possível, então o navegador entrega ´ e a letra e o resultado são dois envios", () => {
    // ´ + x: o Firefox compõe "´x"; o texto sai inteiro e uma vez
    const ev = [
      kd("Dead", 0, false), comp("compositionstart", ""), comp("compositionupdate", "´"), inp("input", "insertCompositionText", "´", true),
      kd("x", 88, true), comp("compositionupdate", "´x"), inp("input", "insertCompositionText", "´x", true), comp("compositionend", "´x"),
    ];
    expect(run(ev).emitted).toEqual(["´x"]);
  });
  test("dado o texto do Firefox que nunca chega, então settle libera a espera e o próximo keydown comum segue ao xterm", () => {
    const gate = T.composeGate(() => undefined, { value: () => "", clear: () => undefined });
    const seq = [kd("Dead", 0, false), comp("compositionstart", ""), comp("compositionend", "")];
    for (const e of seq) gate.handle(e);
    expect(gate.handle(kd("q", 81, false))).toBe(false);
  });
});

describe("tecla morta no nó do Argos (textarea escondido + translateKey)", () => {
  // o nó faz: keydown → translateKey (texto direto); composition/input do textarea → createTextInput
  async function nodeRun(events: Ev[]): Promise<string[]> {
    const Tty = await loadNodeTty();
    const sent: string[] = [];
    let value = "";
    const box = { get value() { return value; }, set value(v: string) { value = v; } };
    const textIn = Tty.createTextInput(box, (t: string) => sent.push(t));
    for (const e of events) {
      if (e.type === "keydown") {
        if (textIn.busy()) continue;
        const input = Tty.translateKey({ key: e.key, keyCode: e.keyCode, isComposing: e.isComposing, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: "" });
        if (input && input.text) sent.push(input.text);
      } else if (e.type === "compositionstart") textIn.compositionStart();
      else if (e.type === "compositionend") textIn.compositionEnd(e.data);
      else if (e.type === "input") { value = e.inputType === "insertText" ? value + (e.data ?? "") : (e.data ?? ""); textIn.input(e.isComposing === true); }
    }
    return sent;
  }
  test("dado ´a ~a ´e ^E no Firefox, então chegam á ã é Ê, uma vez cada", async () => {
    const all = [...firefoxDead("´", "a", "á", 65), ...firefoxDead("~", "a", "ã", 65), ...firefoxDead("´", "e", "é", 69), ...firefoxDead("^", "E", "Ê", 69)];
    expect(await nodeRun(all)).toEqual(["á", "ã", "é", "Ê"]);
  });
  test("dado ´ + a no Chrome, então chega um único á", async () => {
    expect(await nodeRun(chromeDead("´", "á"))).toEqual(["á"]);
  });
  test("dado um navegador que não marca isComposing nos keydown da letra base durante a composição, então a letra base não sai", async () => {
    const stripped = firefoxDead("´", "a", "á", 65).map((e) => (e.type === "keydown" && e.key === "a" ? { ...e, isComposing: false } : e));
    expect(await nodeRun(stripped)).toEqual(["á"]);
  });
});

describe("ligação no term.tsx", () => {
  const src = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/term.tsx"), "utf8");
  test("dado o PtyTerminal, então a máquina de tecla morta é ligada na captura do elemento do xterm e solta ao desmontar", () => {
    expect(src.includes("L.composeGate(")).toBe(true);
    expect(/term\.element\.addEventListener\(\w+, \w+, true\)/.test(src)).toBe(true);
    expect(/term\.element\.removeEventListener\(\w+, \w+, true\)/.test(src)).toBe(true);
  });
});
