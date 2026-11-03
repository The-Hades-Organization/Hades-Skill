// Assentar da corda do Argos (reference/argos.md §Assentar das cordas): passo fixo com acumulador, sono por energia
// média e restrição só de tração. Relógio entra por injeção (dt de cada quadro é dado do teste).
import { describe, expect, test } from "bun:test";
import { advanceRope, createRope, ROPE, ropeEnergy } from "../../../src/lib/canvas-links.ts";

const a = { x: 0, y: 0 };
const b = { x: 300, y: 0 };
const MAX_FRAMES = 600;

/** Quadros até a energia cair abaixo do sono, ou -1 se a corda nunca dorme. */
function framesToSleep(dtOf: (frame: number) => number, ends: (frame: number) => [typeof a, typeof b] = () => [a, b]): number {
  const rope = createRope(a, b);
  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    const [pa, pb] = ends(frame);
    if (advanceRope(rope, pa, pb, [], dtOf(frame)).energy <= ROPE.sleep) return frame;
  }
  return -1;
}

// gerador determinístico: o teste não depende de acaso
const lcg = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

describe("assentar das cordas", () => {
  test("pontas paradas e quadro a 60 Hz: dorme em até 2 s", () => {
    const frames = framesToSleep(() => 1 / 60);
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThanOrEqual(120);
  });

  test("dt variável do quadro não impede o sono (passo fixo com acumulador)", () => {
    const next = lcg(1);
    const frames = framesToSleep(() => 0.008 + next() * 0.025);
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThanOrEqual(120);
  });

  test("quadros alternando 60 Hz e 30 Hz dormem", () => {
    expect(framesToSleep((f) => (f % 2 ? 1 / 30 : 1 / 60))).toBeGreaterThan(0);
  });

  test("tela de 144 Hz dorme no mesmo tempo de mundo", () => {
    const frames = framesToSleep(() => 1 / 144);
    expect(frames).toBeGreaterThan(0);
    expect(frames / 144).toBeLessThanOrEqual(2);
  });

  test("com as pontas paradas o motor para de pedir quadro (energia abaixo do sono = ropesAwake falso)", () => {
    const rope = createRope(a, b);
    let energy = Number.POSITIVE_INFINITY;
    for (let i = 0; i < MAX_FRAMES && energy > ROPE.sleep; i++) energy = advanceRope(rope, a, b, [], 1 / 60).energy;
    expect(energy > ROPE.sleep).toBe(false);
    const again = advanceRope(rope, a, b, [], 1 / 60);
    expect(again.energy).toBeLessThanOrEqual(ROPE.sleep);
  });

  test("ponta que anda acorda a corda parada", () => {
    const rope = createRope(a, b);
    for (let i = 0; i < MAX_FRAMES; i++) advanceRope(rope, a, b, [], 1 / 60);
    expect(ropeEnergy(rope)).toBeLessThanOrEqual(ROPE.sleep);
    let energy = 0;
    for (let i = 1; i <= 10; i++) energy = advanceRope(rope, a, { x: b.x + i * 6, y: b.y + i * 3 }, [], 1 / 60).energy;
    expect(energy).toBeGreaterThan(ROPE.sleep);
  });

  test("corda recém-criada não dorme antes da janela encher", () => {
    const rope = createRope(a, b);
    expect(advanceRope(rope, a, b, [], 1 / 60).energy).toBe(Number.POSITIVE_INFINITY);
  });

  test("quadro mais curto que um passo acumula e não anda", () => {
    const rope = createRope(a, b);
    const before = structuredClone(rope.points);
    const result = advanceRope(rope, a, b, [], ROPE.step / 4);
    expect(result.steps).toBe(0);
    expect(rope.points).toEqual(before);
    expect(advanceRope(rope, a, b, [], (ROPE.step * 3) / 4).steps).toBe(1);
  });

  test("dt enorme é limitado ao teto: no máximo maxDt/step passos", () => {
    const rope = createRope(a, b);
    expect(advanceRope(rope, a, b, [], 10).steps).toBe(Math.floor(ROPE.maxDt / ROPE.step + 1e-9));
  });
});
