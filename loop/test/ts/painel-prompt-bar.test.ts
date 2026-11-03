// PromptBar (kit/panel/ui/fx/prompt-bar.tsx): as regras sem DOM (gatilho @ e /, filtro, escolha, tecla, esforço e modelo
// iniciais) saem de PromptBar.logic, carregadas aqui com React, motion e window simulados.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Item { key: string; name: string; attach?: boolean }
interface Trigger { kind: "mention" | "command"; term: string; start: number }
interface KeyInput { key: string; shift: boolean; composing: boolean; busy: boolean; menuOpen: boolean; rows: number }
interface Logic {
  detectTrigger: (t: string) => Trigger | null;
  filterItems: (k: "mention" | "command", items: Item[], term: string) => Item[];
  applyPick: (t: string, trig: Trigger, item: Item) => string;
  keyAction: (k: KeyInput) => string;
  isArmed: (t: string, a: string[], busy: boolean) => boolean;
  initialModel: (m: Item[], w: string) => string;
  initialEffort: (e: string[], w: string) => number;
  normalizeAttachments: (r: unknown) => string[];
  effortFromX: (x: number, w: number, n: number) => number;
}

function carrega(): Logic {
  const src = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/fx/prompt-bar.tsx"), "utf8");
  const js = new Bun.Transpiler({ loader: "tsx" }).transformSync(src);
  const win: { HadesFx: Record<string, unknown> } = { HadesFx: { motion: { animate: () => ({ stop() {} }), useReducedMotion: () => false } } };
  const react = { useState: () => [], useEffect: () => {}, useRef: () => ({ current: null }), useId: () => "x", createElement: () => null };
  new Function("React", "window", "LucideReact", js)(react, win, {});
  return (win.HadesFx.PromptBar as { logic: Logic }).logic;
}
const L = carrega();
const key = (over: Partial<KeyInput>): KeyInput => ({ key: "Enter", shift: false, composing: false, busy: false, menuOpen: false, rows: 0, ...over });
const fontes: Item[] = [{ key: "a", name: "Arquivos" }, { key: "b", name: "Web" }, { key: "c", name: "Calendário", attach: true }];

describe("prompt-bar, gatilho", () => {
  test("dado @fo no fim do texto, então abre a menção com o termo", () => {
    expect(L.detectTrigger("veja @fo")).toEqual({ kind: "mention", term: "fo", start: 5 });
  });
  test("dado / no começo, então abre o comando com termo vazio", () => {
    expect(L.detectTrigger("/")).toEqual({ kind: "command", term: "", start: 0 });
  });
  test("dado @ colado numa palavra ou seguido de espaço, então não abre", () => {
    expect(L.detectTrigger("mail@x")).toBeNull();
    expect(L.detectTrigger("@x ")).toBeNull();
  });
});

describe("prompt-bar, filtro e escolha", () => {
  test("dado @, então o filtro é por conteúdo sem diferenciar caixa", () => {
    expect(L.filterItems("mention", fontes, "EB").map((i) => i.key)).toEqual(["b"]);
  });
  test("dado /, então o filtro é por prefixo do nome sem a barra", () => {
    const cmds = [{ key: "1", name: "/summarize" }, { key: "2", name: "/fix" }];
    expect(L.filterItems("command", cmds, "su").map((i) => i.key)).toEqual(["1"]);
    expect(L.filterItems("command", cmds, "um")).toEqual([]);
  });
  test("dado a escolha, então @ vira @Nome com espaço e / vira o nome com espaço", () => {
    expect(L.applyPick("veja @fo", { kind: "mention", term: "fo", start: 5 }, { key: "a", name: "Arquivos" })).toBe("veja @Arquivos ");
    expect(L.applyPick("/su", { kind: "command", term: "su", start: 0 }, { key: "1", name: "/summarize" })).toBe("/summarize ");
  });
  test("dado item de anexo, então o termo digitado sai do texto", () => {
    expect(L.applyPick("veja @ca", { kind: "mention", term: "ca", start: 5 }, { key: "c", name: "Calendário", attach: true })).toBe("veja ");
  });
});

describe("prompt-bar, teclas", () => {
  test("dado Enter sem Shift, então envia; com Shift, deixa quebrar a linha", () => {
    expect(L.keyAction(key({}))).toBe("send");
    expect(L.keyAction(key({ shift: true }))).toBe("none");
  });
  test("dado busy, então Enter não envia e é bloqueado", () => {
    expect(L.keyAction(key({ busy: true }))).toBe("block");
  });
  test("dado composição de IME, então Enter não faz nada", () => {
    expect(L.keyAction(key({ composing: true }))).toBe("none");
  });
  test("dado menu com linhas, então Enter e Tab escolhem e setas circulam; Esc fecha", () => {
    expect(L.keyAction(key({ menuOpen: true, rows: 2 }))).toBe("menu-pick");
    expect(L.keyAction(key({ key: "Tab", menuOpen: true, rows: 2 }))).toBe("menu-pick");
    expect(L.keyAction(key({ key: "ArrowDown", menuOpen: true, rows: 2 }))).toBe("menu-next");
    expect(L.keyAction(key({ key: "Escape", menuOpen: true }))).toBe("menu-close");
  });
  test("dado menu aberto com lista vazia, então Enter ainda envia", () => {
    expect(L.keyAction(key({ menuOpen: true, rows: 0 }))).toBe("send");
  });
});

describe("prompt-bar, estado inicial", () => {
  test("dado texto, anexo e busy, então o botão arma só com algum deles", () => {
    expect(L.isArmed("  ", [], false)).toBe(false);
    expect(L.isArmed("oi", [], false)).toBe(true);
    expect(L.isArmed("", ["a.txt"], false)).toBe(true);
    expect(L.isArmed("", [], true)).toBe(true);
  });
  test("dado esforço sem padrão, então começa no do meio; com padrão válido, nele; sem níveis, -1", () => {
    expect(L.initialEffort(["a", "b", "c", "d", "e"], "")).toBe(2);
    expect(L.initialEffort(["a", "b", "c", "d"], "x")).toBe(1);
    expect(L.initialEffort(["a", "b", "c"], "c")).toBe(2);
    expect(L.initialEffort([], "")).toBe(-1);
  });
  test("dado modelo vazio ou inexistente, então o primeiro", () => {
    expect(L.initialModel(fontes, "")).toBe("a");
    expect(L.initialModel(fontes, "zz")).toBe("a");
    expect(L.initialModel(fontes, "b")).toBe("b");
    expect(L.initialModel([], "")).toBe("");
  });
  test("dado o retorno do anexo, então vira lista de nomes", () => {
    expect(L.normalizeAttachments("a.txt")).toEqual(["a.txt"]);
    expect(L.normalizeAttachments(["a", "", 3])).toEqual(["a"]);
    expect(L.normalizeAttachments(undefined)).toEqual([]);
  });
  test("dado x na régua, então escolhe o nível mais próximo com margem nas pontas", () => {
    expect(L.effortFromX(0, 224, 5)).toBe(0);
    expect(L.effortFromX(112, 224, 5)).toBe(2);
    expect(L.effortFromX(500, 224, 5)).toBe(4);
  });
});
