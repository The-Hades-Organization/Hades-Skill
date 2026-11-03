// CodeSlots (kit/panel/ui/fx/code-slots.tsx): a lógica das casas sai como funções puras, carregadas aqui sem DOM.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Slots = string[];
type Edit = { slots: Slots; active: number } | null;
type Logic = {
  clean: (raw: string, charset: "digits" | "text") => string;
  fit: (text: string, length: number) => Slots;
  isFull: (s: Slots) => boolean;
  insertAt: (s: Slots, i: number, chars: string[]) => { slots: Slots; active: number };
  backspace: (s: Slots, a: number) => { slots: Slots; active: number };
  clickTarget: (s: Slots, wanted: number) => number;
  applyTyped: (s: Slots, a: number, typed: string, charset: "digits" | "text") => Edit;
};

function carrega(): Logic {
  const src = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/fx/code-slots.tsx"), "utf8");
  const js = new Bun.Transpiler({ loader: "tsx" }).transformSync(src);
  const win: { HadesFx?: { CodeSlots: { logic: Logic } } } = {};
  const react = { useState: () => [], useRef: () => ({ current: null }), useEffect: () => {}, useLayoutEffect: () => {} };
  new Function("React", "window", "matchMedia", js)(react, win, () => ({ matches: false }));
  return win.HadesFx!.CodeSlots.logic;
}
const L = carrega();
const digitar = (s: Slots, a: number, t: string, c: "digits" | "text" = "digits"): { slots: Slots; active: number } => {
  const r = L.applyTyped(s, a, t, c);
  if (!r) throw new Error("entrada ignorada");
  return r;
};

describe("code slots, lógica", () => {
  test("dado o charset digits, quando limpa 12ab34, então sobra 1234", () => {
    expect(L.clean("12ab34", "digits")).toBe("1234");
  });

  test("dado o charset text, quando limpa, então só espaço em branco sai", () => {
    expect(L.clean("a b\tc-1", "text")).toBe("abc-1");
  });

  test("dado seis dígitos digitados um a um, então a ativa avança e fica na última ao encher", () => {
    let r = { slots: L.fit("", 6), active: 0 };
    for (const d of "123456") r = digitar(r.slots, r.active, d);
    expect(r.slots.join("")).toBe("123456");
    expect(r.active).toBe(5);
    expect(L.isFull(r.slots)).toBe(true);
  });

  test("dado colar no meio com sobra, então corta no length", () => {
    const r = L.insertAt(L.fit("12", 4), 2, ["a", "b", "c", "d"]);
    expect(r.slots).toEqual(["1", "2", "a", "b"]);
    expect(r.active).toBe(3);
  });

  test("dado vários caracteres de uma vez (preenchimento automático), então recomeça da casa 0", () => {
    const r = digitar(L.fit("99", 4), 2, "abcd", "text");
    expect(r.slots).toEqual(["a", "b", "c", "d"]);
  });

  test("dado só caracteres inválidos, então a entrada é ignorada", () => {
    expect(L.applyTyped(L.fit("", 4), 0, "xyz", "digits")).toBeNull();
  });

  test("dado backspace em casa vazia, então apaga a anterior e recua", () => {
    const r = L.backspace(L.fit("12", 4), 2);
    expect(r.slots).toEqual(["1", "", "", ""]);
    expect(r.active).toBe(1);
  });

  test("dado backspace em casa preenchida, então apaga ela e não recua; na casa 0 vazia não faz nada", () => {
    expect(L.backspace(L.fit("12", 4), 1)).toEqual({ slots: ["1", "", "", ""], active: 1 });
    expect(L.backspace(L.fit("", 4), 0)).toEqual({ slots: ["", "", "", ""], active: 0 });
  });

  test("dado clique além da primeira vazia, então ativa a primeira vazia; antes dela, a casa clicada", () => {
    const s = L.fit("12", 6);
    expect(L.clickTarget(s, 5)).toBe(2);
    expect(L.clickTarget(s, 1)).toBe(1);
    expect(L.clickTarget(s, -3)).toBe(0);
  });

  test("dado código cheio, então o clique alcança a última casa", () => {
    expect(L.clickTarget(L.fit("123456", 6), 9)).toBe(5);
  });

  test("dado fit com length menor, então mantém só o que cabe", () => {
    expect(L.fit("123456", 4)).toEqual(["1", "2", "3", "4"]);
  });
});
