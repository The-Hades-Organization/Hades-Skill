/// <reference path="../../../kit/panel/ui/term-logic.tsx" />
// Celular (term-logic.tsx): barra de teclas -> bytes, HADES_TERMINAL_KEYS, Ctrl fixo, seguir o fim, visualViewport e níveis
// lista/detalhe. Regra pura, sem navegador. Contrato: reference/panel.md §Terminal › Interface e §Layout no celular.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../../../kit/panel/ui/term-logic.tsx";

type Logic = ReturnType<typeof makeTermLogic>;
const T = (globalThis as unknown as { TermLogic: Logic }).TermLogic;
const ROOT = join(import.meta.dir, "../../..");

describe("barra de teclas: bytes enviados", () => {
  test.each([
    ["esc", "\x1b"], ["tab", "\t"], ["enter", "\r"], ["shift-tab", "\x1b[Z"], ["ctrl-c", "\x03"],
    ["1", "1"], ["2", "2"], ["3", "3"], ["y", "y"], ["n", "n"], ["pipe", "|"], ["tilde", "~"], ["slash", "/"], ["dash", "-"],
    ["up", "\x1b[A"], ["down", "\x1b[B"], ["right", "\x1b[C"], ["left", "\x1b[D"],
  ])("dado a tecla %s, então envia os bytes certos", (id, bytes) => {
    expect(T.keyBytes(id)).toBe(bytes);
  });
  test("dado o modo de cursor de aplicação, então as setas usam SS3", () => {
    expect(T.keyBytes("up", true)).toBe("\x1bOA");
    expect(T.keyBytes("left", true)).toBe("\x1bOD");
    expect(T.keyBytes("esc", true)).toBe("\x1b");
  });
  test("dado tecla de ação da tela ou id desconhecido, então não há bytes", () => {
    for (const id of ["ctrl", "paste", "copy", "nao-existe", "__proto__", ""]) expect(T.keyBytes(id)).toBeNull();
  });
});

describe("HADES_TERMINAL_KEYS", () => {
  test("dado vazio ou ausente, então o padrão, sem aviso", () => {
    for (const raw of [undefined, null, "", "   "]) {
      const r = T.parseKeys(raw);
      expect(r.keys).toEqual(T.DEFAULT_KEYS.split(","));
      expect(r.warning).toBeNull();
    }
  });
  test("dado todo id do padrão, então ele existe no catálogo", () => {
    for (const id of T.DEFAULT_KEYS.split(",")) expect(Object.hasOwn(T.KEY_DEFS, id)).toBe(true);
  });
  test("dado lista válida com vírgula, espaço e caixa mista, então mantém a ordem e tira repetidas", () => {
    const r = T.parseKeys("Esc, 1 2,esc , CTRL-C");
    expect(r.keys).toEqual(["esc", "1", "2", "ctrl-c"]);
    expect(r.warning).toBeNull();
  });
  test("dado um id desconhecido, então a lista inteira cai no padrão com aviso que cita o id", () => {
    const r = T.parseKeys("esc,f13,tab");
    expect(r.keys).toEqual(T.DEFAULT_KEYS.split(","));
    expect(r.warning).toContain("f13");
  });
  test("dado id que imita propriedade de objeto, então é inválido", () => {
    expect(T.parseKeys("constructor").warning).not.toBeNull();
    expect(T.parseKeys("__proto__").warning).not.toBeNull();
  });
  test("dado mais de 32 entradas, mesmo repetidas, então cai no padrão com aviso", () => {
    const r = T.parseKeys(Array.from({ length: 33 }, () => "esc").join(","));
    expect(r.keys).toEqual(T.DEFAULT_KEYS.split(","));
    expect(r.warning).toContain("32");
    expect(T.parseKeys(Array.from({ length: 32 }, () => "esc").join(",")).keys).toEqual(["esc"]);
  });
  test("dado config.tsv, então o padrão da chave é o do TermLogic", () => {
    const line = readFileSync(join(ROOT, "kit/config.tsv"), "utf8").split("\n").find((l) => l.startsWith("HADES_TERMINAL_KEYS\t"));
    expect(line?.split("\t")[1]).toBe(T.DEFAULT_KEYS);
  });
});

describe("Ctrl fixo de um toque", () => {
  test.each([["c", "\x03"], ["C", "\x03"], ["d", "\x04"], ["z", "\x1a"], ["[", "\x1b"], ["\\", "\x1c"], ["@", "\x00"], [" ", "\x00"], ["?", "\x7f"]])(
    "dado Ctrl e %j, então vira %j", (ch, out) => { expect(T.applyCtrl(ch)).toBe(out); },
  );
  test("dado caractere sem par de controle, ou mais de um caractere, então passa igual", () => {
    for (const s of ["1", "ç", "", "ab", "\x1b[A", "colado inteiro"]) expect(T.applyCtrl(s)).toBe(s);
  });
});

describe("seguir o fim", () => {
  test("dado a janela na última linha, então segue", () => {
    expect(T.isFollowing(120, 120)).toBe(true);
    expect(T.isFollowing(0, 0)).toBe(true);
  });
  test("dado rolagem para cima, então para de seguir; voltar ao fim segue de novo", () => {
    expect(T.isFollowing(80, 120)).toBe(false);
    expect(T.isFollowing(119, 120)).toBe(false);
    expect(T.isFollowing(120, 120)).toBe(true);
  });
});

describe("visualViewport", () => {
  const win = { innerWidth: 390, innerHeight: 844 };
  test("dado sem visualViewport, então usa a janela inteira", () => {
    expect(T.viewBox(null, win)).toEqual({ top: 0, left: 0, width: 390, height: 844, keyboard: false });
  });
  test("dado a janela cheia, então não há teclado", () => {
    const b = T.viewBox({ width: 390, height: 844, offsetTop: 0, offsetLeft: 0 }, win);
    expect(b).toEqual({ top: 0, left: 0, width: 390, height: 844, keyboard: false });
  });
  test("dado altura útil bem menor, então há teclado e a caixa acompanha altura e deslocamento", () => {
    const b = T.viewBox({ width: 390, height: 520.4, offsetTop: 12.6, offsetLeft: 0 }, win);
    expect(b).toEqual({ top: 13, left: 0, width: 390, height: 520, keyboard: true });
  });
  test("dado barra de endereço que encolhe pouco, então não conta como teclado", () => {
    expect(T.viewBox({ width: 390, height: 790, offsetTop: 0, offsetLeft: 0 }, win).keyboard).toBe(false);
  });
  test("dado medida absurda, então a altura nunca fica abaixo do piso e o deslocamento nunca é negativo", () => {
    const b = T.viewBox({ width: 390, height: 20, offsetTop: -30, offsetLeft: -5 }, win);
    expect(b.height).toBe(160);
    expect(b.top).toBe(0);
    expect(b.left).toBe(0);
    expect(T.viewBox({ width: 390, height: Number.NaN, offsetTop: 0, offsetLeft: 0 }, win).height).toBe(844);
  });
});

describe("níveis lista -> detalhe", () => {
  test("dado a lista, quando abre o detalhe, então empilha uma entrada no histórico", () => {
    expect(T.navStep("list", "enter")).toEqual({ level: "detail", history: "push" });
  });
  test("dado o detalhe, quando abre de novo, então não empilha outra", () => {
    expect(T.navStep("detail", "enter")).toEqual({ level: "detail", history: null });
  });
  test("dado o detalhe, quando toca em voltar na tela, então volta uma entrada do histórico", () => {
    expect(T.navStep("detail", "leave")).toEqual({ level: "list", history: "back" });
  });
  test("dado o voltar do sistema, então desce um nível sem mexer de novo no histórico", () => {
    expect(T.navStep("detail", "pop")).toEqual({ level: "list", history: null });
    expect(T.navStep("list", "pop")).toEqual({ level: "list", history: null });
  });
  test("dado a lista, quando toca em voltar, então fica (sair da página é do navegador)", () => {
    expect(T.navStep("list", "leave")).toEqual({ level: "list", history: null });
  });
  test("dado a largura, então 768 já é desktop e 767 é celular", () => {
    expect(T.isMobileWidth(767)).toBe(true);
    expect(T.isMobileWidth(768)).toBe(false);
    expect(T.isMobileWidth(0)).toBe(false);
    expect(T.isMobileWidth(Number.NaN)).toBe(false);
  });
});
