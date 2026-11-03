// Grupo canvas-touch: reconhecedor de pinça, arrastar com um dedo e toque longo (src/lib/canvas-touch.ts), com relógio
// injetado. Lógica pura.
import { describe, expect, test } from "bun:test";
import { TOUCH_LIMITS, createTouchRecognizer } from "../../../src/lib/canvas-touch";

function setup() {
  let t = 0;
  const rec = createTouchRecognizer(() => t);
  return { rec, advance: (ms: number) => void (t += ms) };
}

describe("toque curto e longo", () => {
  test("dedo que desce e sobe rápido, parado, dá um tap", () => {
    const { rec, advance } = setup();
    rec.down(1, { x: 10, y: 20 });
    advance(100);
    expect(rec.up(1)).toEqual([{ type: "tap", at: { x: 10, y: 20 } }]);
  });

  test("parado até o limite, o tick dispara um toque longo uma única vez", () => {
    const { rec, advance } = setup();
    rec.down(1, { x: 5, y: 5 });
    advance(TOUCH_LIMITS.longPressMs - 1);
    expect(rec.tick()).toEqual([]);
    advance(1);
    expect(rec.tick()).toEqual([{ type: "longpress", at: { x: 5, y: 5 } }]);
    expect(rec.tick()).toEqual([]);
  });

  test("depois do toque longo, soltar não vira tap nem arrasto", () => {
    const { rec, advance } = setup();
    rec.down(1, { x: 5, y: 5 });
    advance(TOUCH_LIMITS.longPressMs);
    rec.tick();
    expect(rec.move(1, { x: 200, y: 200 })).toEqual([]);
    expect(rec.up(1).some((e) => e.type === "tap" || e.type === "pan")).toBe(false);
  });

  test("parado mais que o tap máximo, mas menos que o toque longo, não é tap", () => {
    const { rec, advance } = setup();
    rec.down(1, { x: 0, y: 0 });
    advance(TOUCH_LIMITS.tapMaxMs + 1);
    expect(rec.up(1)).toEqual([]);
  });

  test("mexer dentro da folga mantém o toque longo possível", () => {
    const { rec, advance } = setup();
    rec.down(1, { x: 0, y: 0 });
    expect(rec.move(1, { x: TOUCH_LIMITS.slopPx, y: 0 })).toEqual([]);
    advance(TOUCH_LIMITS.longPressMs);
    expect(rec.tick()).toHaveLength(1);
  });
});

describe("arrastar com um dedo", () => {
  test("passou da folga, vira pan incremental e cancela o toque longo", () => {
    const { rec, advance } = setup();
    rec.down(1, { x: 0, y: 0 });
    expect(rec.move(1, { x: 20, y: 0 })).toEqual([{ type: "pan", dx: 20, dy: 0 }]);
    expect(rec.move(1, { x: 25, y: 10 })).toEqual([{ type: "pan", dx: 5, dy: 10 }]);
    advance(TOUCH_LIMITS.longPressMs * 2);
    expect(rec.tick()).toEqual([]);
  });

  test("ao soltar depois de arrastar, emite end e não tap", () => {
    const { rec } = setup();
    rec.down(1, { x: 0, y: 0 });
    rec.move(1, { x: 50, y: 0 });
    expect(rec.up(1)).toEqual([{ type: "end" }]);
  });

  test("movimento sem deslocamento depois do arrasto não emite pan", () => {
    const { rec } = setup();
    rec.down(1, { x: 0, y: 0 });
    rec.move(1, { x: 50, y: 0 });
    expect(rec.move(1, { x: 50, y: 0 })).toEqual([]);
  });
});

describe("pinça", () => {
  test("dois dedos emitem os pontos iniciais e os atuais", () => {
    const { rec } = setup();
    rec.down(1, { x: 0, y: 0 });
    rec.down(2, { x: 100, y: 0 });
    const out = rec.move(2, { x: 200, y: 0 });
    expect(out).toEqual([{ type: "pinch", startA: { x: 0, y: 0 }, startB: { x: 100, y: 0 }, a: { x: 0, y: 0 }, b: { x: 200, y: 0 } }]);
  });

  test("o segundo dedo cancela o toque longo pendente", () => {
    const { rec, advance } = setup();
    rec.down(1, { x: 0, y: 0 });
    rec.down(2, { x: 50, y: 0 });
    advance(TOUCH_LIMITS.longPressMs * 2);
    expect(rec.tick()).toEqual([]);
  });

  test("tirar um dedo encerra a pinça sem saltar para arrasto; end só quando todos saem", () => {
    const { rec } = setup();
    rec.down(1, { x: 0, y: 0 });
    rec.down(2, { x: 100, y: 0 });
    expect(rec.up(2)).toEqual([]);
    expect(rec.move(1, { x: 300, y: 300 })).toEqual([]);
    expect(rec.up(1)).toEqual([{ type: "end" }]);
  });

  test("o terceiro dedo é ignorado", () => {
    const { rec } = setup();
    rec.down(1, { x: 0, y: 0 });
    rec.down(2, { x: 100, y: 0 });
    expect(rec.down(3, { x: 50, y: 50 })).toEqual([]);
    expect(rec.move(3, { x: 60, y: 60 })).toEqual([]);
    expect(rec.up(3)).toEqual([]);
    expect(rec.move(2, { x: 150, y: 0 })).toHaveLength(1);
  });

  test("depois de tudo sair, um gesto novo começa limpo", () => {
    const { rec, advance } = setup();
    rec.down(1, { x: 0, y: 0 });
    rec.down(2, { x: 100, y: 0 });
    rec.up(1);
    rec.up(2);
    rec.down(7, { x: 3, y: 3 });
    advance(50);
    expect(rec.up(7)).toEqual([{ type: "tap", at: { x: 3, y: 3 } }]);
  });
});

describe("limites e entrada inválida", () => {
  test("ponto não finito é recusado com RangeError", () => {
    const { rec } = setup();
    expect(() => rec.down(1, { x: NaN, y: 0 })).toThrow(RangeError);
    rec.down(1, { x: 0, y: 0 });
    expect(() => rec.move(1, { x: 0, y: Infinity })).toThrow(RangeError);
  });

  test("move, up e down repetido de dedo desconhecido não fazem nada", () => {
    const { rec } = setup();
    expect(rec.move(9, { x: 1, y: 1 })).toEqual([]);
    expect(rec.up(9)).toEqual([]);
    rec.down(1, { x: 0, y: 0 });
    expect(rec.down(1, { x: 5, y: 5 })).toEqual([]);
  });

  test("cancel zera o estado sem emitir nada", () => {
    const { rec, advance } = setup();
    rec.down(1, { x: 0, y: 0 });
    rec.cancel();
    advance(TOUCH_LIMITS.longPressMs * 2);
    expect(rec.tick()).toEqual([]);
    expect(rec.up(1)).toEqual([]);
  });
});
