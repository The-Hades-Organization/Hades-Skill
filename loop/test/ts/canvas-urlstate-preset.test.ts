// Grupo canvas-urlstate-preset: a chave `preset` do hash (src/lib/canvas-urlstate.ts): ida e volta, aditiva e recusa de valor
// desconhecido como as outras chaves.
import { describe, expect, test } from "bun:test";
import { URLSTATE_BASE, URLSTATE_PRESETS, URLSTATE_WARNINGS, UrlStateError, defaultUrlState, parseUrlState, serializeUrlState, type UrlState } from "../../../src/lib/canvas-urlstate";

describe("canvas-urlstate: preset", () => {
  test("dado cada preset, então a ida e volta é exata", () => {
    for (const preset of URLSTATE_PRESETS) {
      const state: UrlState = { ...defaultUrlState(), preset };
      expect(serializeUrlState(state)).toBe(`${URLSTATE_BASE}?preset=${preset}&v=1`);
      expect(parseUrlState(serializeUrlState(state))).toEqual({ state });
    }
  });

  test("dado preset junto de câmera, filtro, busca e nó, então tudo volta igual", () => {
    const state: UrlState = { camera: { x: 1, y: 2, k: 1 }, filters: { cost: ["low"] }, search: "x", node: "agent:a", preset: "attention" };
    expect(parseUrlState(serializeUrlState(state))).toEqual({ state });
  });

  test("dado estado sem preset, então o hash não o leva e a leitura não inventa a chave", () => {
    expect(serializeUrlState(defaultUrlState())).toBe(URLSTATE_BASE);
    expect(parseUrlState(`${URLSTATE_BASE}?q=a&v=1`).state).not.toHaveProperty("preset");
    expect(defaultUrlState()).not.toHaveProperty("preset");
  });

  test("dado hash com preset desconhecido, vazio ou repetido, então é o padrão com urlstate_invalid", () => {
    for (const bad of ["preset=outro", "preset=", "preset=ALL", "preset=all&preset=done"]) {
      expect(parseUrlState(`${URLSTATE_BASE}?${bad}&v=1`)).toEqual({ state: defaultUrlState(), warning: URLSTATE_WARNINGS.invalid });
    }
  });

  test("dado estado com preset desconhecido, então serializar lança urlstate_invalid", () => {
    const state = { ...defaultUrlState(), preset: "outro" } as unknown as UrlState;
    expect(() => serializeUrlState(state)).toThrow(UrlStateError);
    try {
      serializeUrlState(state);
    } catch (error) {
      expect((error as UrlStateError).code).toBe(URLSTATE_WARNINGS.invalid);
    }
  });

  test("dado hash antigo sem preset, então segue valendo", () => {
    expect(parseUrlState(`${URLSTATE_BASE}?node=agent:a`).state.node).toBe("agent:a");
    expect(parseUrlState(`${URLSTATE_BASE}?q=x&v=1`).state.search).toBe("x");
  });
});

describe("canvas-urlstate: presets working e idle (estados que a página tem)", () => {
  test("dado working ou idle, então vão ao hash e voltam iguais", () => {
    for (const preset of ["working", "idle"] as const) {
      const state: UrlState = { ...defaultUrlState(), node: "agent:a", preset };
      expect(serializeUrlState(state)).toContain(`preset=${preset}`);
      expect(parseUrlState(serializeUrlState(state))).toEqual({ state });
    }
  });

  test("dado o mesmo estado sem preset, então o hash é exatamente o de antes da chave existir", () => {
    const state: UrlState = { ...defaultUrlState(), search: "x", node: "agent:a" };
    expect(serializeUrlState(state)).toBe(`${URLSTATE_BASE}?node=agent%3Aa&q=x&v=1`);
  });
});
