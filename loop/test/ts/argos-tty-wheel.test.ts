// Roda do terminal do nó (Argos): quantas linhas vale cada giro, os limites do histórico e a volta ao vivo.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadNodeTty } from "./lib/node-tty-load";

const ROWS = 24;
const LINE_PX = 17;
const ev = (deltaY: number, deltaMode = 0) => ({ deltaY, deltaMode });
const history = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);

async function feed(events: Array<{ deltaY: number; deltaMode: number }>, linePx = LINE_PX): Promise<number[]> {
  const Tty = await loadNodeTty();
  let rest = 0;
  return events.map((e) => {
    const r = Tty.wheelStep(rest, e, ROWS, linePx);
    rest = r.rest;
    return r.lines;
  });
}
const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("wheelStep: linhas por giro", () => {
  test("dado roda de mouse em linhas (deltaMode 1), então cada unidade é uma linha e para cima é positivo", async () => {
    expect(await feed([ev(-3, 1), ev(2, 1)])).toEqual([3, -2]);
  });
  test("dado página (deltaMode 2), então vale a tela inteira", async () => {
    expect(await feed([ev(-1, 2)])).toEqual([ROWS]);
  });
  test("dado trackpad em pixels, então dez eventos de 2 px somam 20 px, ou seja, uma linha, e não dez", async () => {
    expect(total(await feed(Array.from({ length: 10 }, () => ev(-2))))).toBe(1);
  });
  test("dado trackpad em pixels, então o resto de pixels não se perde entre eventos", async () => {
    const lines = await feed(Array.from({ length: 34 }, () => ev(-1)));
    expect(total(lines)).toBe(2);
  });
  test("dado um clique de roda de mouse em pixels (100 px), então anda proporcional à altura da linha, não uma tela", async () => {
    expect(await feed([ev(-100)])).toEqual([5]);
  });
  test("dado o nó reduzido na tela (linha de 8,5 px), então o mesmo giro anda o dobro de linhas", async () => {
    expect(await feed([ev(-17)], LINE_PX / 2)).toEqual([2]);
  });
  test("dado giro para cima e depois para baixo, então o resto de um lado não vaza para o outro", async () => {
    const lines = await feed([ev(-10), ev(10)]);
    expect(total(lines)).toBe(0);
  });
  test("dado deltaY zero, NaN ou infinito, então não rola", async () => {
    expect(await feed([ev(0), ev(Number.NaN), ev(Number.POSITIVE_INFINITY)])).toEqual([0, 0, 0]);
  });
  test("dado altura de linha inválida, então cai na altura da célula e não divide por zero", async () => {
    expect(await feed([ev(-17)], 0)).toEqual([1]);
  });
});

describe("wheelScroll / historyLoaded: histórico, limites e volta ao vivo", () => {
  test("dado o nó ao vivo e giro para baixo, então continua ao vivo", async () => {
    const Tty = await loadNodeTty();
    const s = Tty.wheelScroll(Tty.scrollLive(), -5, ROWS);
    expect(s.lines).toBeNull();
    expect(s.pending).toBe(0);
  });
  test("dado rajada de giros antes do histórico chegar, então os passos somam e valem quando ele chega", async () => {
    const Tty = await loadNodeTty();
    let s = Tty.scrollLive();
    for (const step of [3, 3, 3, 3]) s = Tty.wheelScroll(s, step, ROWS);
    expect(Tty.historyLoaded(s, history(200), ROWS).offset).toBe(12);
  });
  test("dado giro de ida e volta antes do histórico chegar, então volta ao vivo quando ele chega", async () => {
    const Tty = await loadNodeTty();
    let s = Tty.wheelScroll(Tty.scrollLive(), 4, ROWS);
    s = Tty.wheelScroll(s, -9, ROWS);
    expect(Tty.historyLoaded(s, history(200), ROWS).lines).toBeNull();
  });
  test("dado histórico carregado, então rolar para cima anda o deslocamento e para no topo", async () => {
    const Tty = await loadNodeTty();
    let s = Tty.historyLoaded(Tty.wheelScroll(Tty.scrollLive(), 1, ROWS), history(100), ROWS);
    expect(s.offset).toBe(1);
    for (let i = 0; i < 50; i++) s = Tty.wheelScroll(s, 5, ROWS);
    expect(s.offset).toBe(100 - ROWS);
  });
  test("dado histórico do tamanho da tela ou menor, então não há onde rolar e fica ao vivo", async () => {
    const Tty = await loadNodeTty();
    const s = Tty.historyLoaded(Tty.wheelScroll(Tty.scrollLive(), 3, ROWS), history(ROWS), ROWS);
    expect(s.lines).toBeNull();
  });
  test("dado histórico rolado, então descer até o fim volta ao vivo e solta o histórico", async () => {
    const Tty = await loadNodeTty();
    let s = Tty.historyLoaded(Tty.wheelScroll(Tty.scrollLive(), 10, ROWS), history(100), ROWS);
    s = Tty.wheelScroll(s, -4, ROWS);
    expect(s.offset).toBe(6);
    s = Tty.wheelScroll(s, -50, ROWS);
    expect(s.lines).toBeNull();
    expect(s.offset).toBe(0);
  });
  test("dado histórico vazio, então fica ao vivo", async () => {
    const Tty = await loadNodeTty();
    expect(Tty.historyLoaded(Tty.wheelScroll(Tty.scrollLive(), 3, ROWS), [], ROWS).lines).toBeNull();
  });
});

describe("a quem pertence a roda", () => {
  test("dado Ctrl ou Alt, então é do canvas; sem eles, do terminal", async () => {
    const Tty = await loadNodeTty();
    expect(Tty.wheelIntent({ ctrlKey: true, altKey: false })).toBe("canvas");
    expect(Tty.wheelIntent({ ctrlKey: false, altKey: true })).toBe("canvas");
    expect(Tty.wheelIntent({ ctrlKey: false, altKey: false })).toBe("own");
  });
  test("dado o nó distante (só cabeçalho) ou com problema no quadro, então a roda não é consumida: o canvas dá zoom", async () => {
    const Tty = await loadNodeTty();
    expect(Tty.ownsWheel({ headerOnly: true, problem: null })).toBe(false);
    expect(Tty.ownsWheel({ headerOnly: false, problem: "sem quadro" })).toBe(false);
    expect(Tty.ownsWheel({ headerOnly: false, problem: null })).toBe(true);
  });
  test("dado o nó, então o marcador data-tty-wheel só existe quando o terminal é dono da roda", () => {
    const src = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/argos/node-tty.tsx"), "utf8");
    expect(/data-tty-wheel=\{/.test(src)).toBe(true);
    expect(/\sdata-tty-wheel(\s|>)/.test(src)).toBe(false);
  });
});
