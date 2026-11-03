// RubberSegment e BellToggle (kit/panel/ui/fx/): a lógica pura (elástico, inércia, escolha do item, ângulos do sino) é
// exposta como membro estático e carregada aqui sem DOM, com React e motion simulados.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Rect = { l: number; r: number };
type Rubber = {
  edgesAt: (want: number, w: number, total: number, elastic: boolean) => { left: number; right: number };
  velocityOf: (s: { t: number; c: number }[], now: number) => number;
  pickIndex: (rects: Rect[], center: number, v: number, glide: number, current: number) => number;
};
type Bell = { ringAngles: (a: number, passes: number, decay: number) => number[]; ringOffsets: (passes: number) => number[] };

function carrega<T>(arquivo: string, nome: string): T {
  const src = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/fx", arquivo), "utf8");
  const js = new Bun.Transpiler({ loader: "tsx" }).transformSync(src);
  const win: { HadesFx: Record<string, unknown> } = { HadesFx: { motion: { animate: () => ({}), motionValue: () => ({}) } } };
  const react = { useRef: () => ({ current: null }), useState: () => [null, () => {}], useEffect: () => {}, useLayoutEffect: () => {} };
  new Function("React", "window", js)(react, win);
  return win.HadesFx[nome] as T;
}

const rubber = carrega<Rubber>("rubber-segment.tsx", "RubberSegment");
const bell = carrega<Bell>("bell-toggle.tsx", "BellToggle");
const itens: Rect[] = [{ l: 0, r: 100 }, { l: 100, r: 200 }, { l: 200, r: 300 }, { l: 300, r: 400 }];

describe("rubber segment, arrasto", () => {
  test("dado o arrasto dentro das pontas, então a janela acompanha com a largura intacta", () => {
    expect(rubber.edgesAt(120, 100, 400, true)).toEqual({ left: 120, right: 220 });
  });

  test("dado o arrasto além da ponta com elástico, então rende menos que o excesso e nunca passa de uma largura", () => {
    const e = rubber.edgesAt(300 + 80, 100, 400, true);
    expect(e.right).toBe(400);
    expect(e.left).toBeGreaterThan(300);
    expect(e.left - 300).toBeLessThan(80);
    expect(rubber.edgesAt(300 + 5000, 100, 400, true).left).toBeLessThanOrEqual(400);
  });

  test("dado o movimento reduzido, então a janela fica limitada às pontas, sem elástico", () => {
    expect(rubber.edgesAt(-50, 100, 400, false)).toEqual({ left: 0, right: 100 });
    expect(rubber.edgesAt(900, 100, 400, false)).toEqual({ left: 300, right: 400 });
  });
});

describe("rubber segment, soltar", () => {
  test("dado menos de 2 amostras ou intervalo menor que 8 ms, então a velocidade é 0", () => {
    expect(rubber.velocityOf([{ t: 0, c: 0 }], 10)).toBe(0);
    expect(rubber.velocityOf([{ t: 0, c: 0 }, { t: 5, c: 50 }], 10)).toBe(0);
  });

  test("dado amostras nos últimos 100 ms, então a velocidade é px por segundo", () => {
    expect(rubber.velocityOf([{ t: 0, c: 0 }, { t: 50, c: 50 }], 60)).toBeCloseTo(1000, 5);
  });

  test("dado arrasto lento, então escolhe o item mais próximo do centro", () => {
    expect(rubber.pickIndex(itens, 190, 0, 75, 0)).toBe(1);
  });

  test("dado 1000 px/s com glide 75, então a projeção avança cerca de um item", () => {
    expect(rubber.pickIndex(itens, 50, 1000, 75, 0)).toBe(1);
  });

  test("dado arremesso fraco que cairia no item atual, então vai um além na direção, limitado às pontas", () => {
    expect(rubber.pickIndex(itens, 150, 120, 75, 1)).toBe(2);
    expect(rubber.pickIndex(itens, 150, -120, 75, 1)).toBe(0);
    expect(rubber.pickIndex(itens, 50, -150, 75, 0)).toBe(0);
  });
});

describe("bell toggle, balanço", () => {
  test("dado o balanço, então a primeira passagem é negativa, os sinais alternam e a amplitude decai", () => {
    const a = bell.ringAngles(17, 5, 1);
    expect(a[0]).toBeCloseTo(-17, 10);
    expect(a[1]).toBeCloseTo(17 * 0.8, 10);
    expect(a.map(Math.sign)).toEqual([-1, 1, -1, 1, -1]);
    expect(Math.abs(a[4] ?? 0)).toBeLessThan(Math.abs(a[0] ?? 0));
  });

  test("dado o tempo das passagens, então crescem dentro de (0,1) e as últimas se aproximam", () => {
    const o = bell.ringOffsets(5);
    expect(o.every((v, i) => v > 0 && v < 1 && (i === 0 || v > (o[i - 1] ?? 0)))).toBe(true);
    expect((o[4] ?? 0) - (o[3] ?? 0)).toBeLessThan((o[1] ?? 0) - (o[0] ?? 0));
  });
});
