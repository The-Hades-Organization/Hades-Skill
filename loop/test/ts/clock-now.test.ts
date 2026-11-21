// HADES_NOW: sem a variável o relógio é o real; com ela, o instante fixo alimenta o histórico e o limitsNow.
import { describe, expect, test } from "bun:test";
import { clockNow } from "../../../src/lib/clock";

describe("clockNow", () => {
  test("sem HADES_NOW, devolve o instante atual", () => {
    const before = Date.now();
    const got = clockNow({}).getTime();
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(Date.now());
  });
  test("HADES_NOW vazio é o mesmo que ausente", () => {
    expect(Math.abs(clockNow({ HADES_NOW: "" }).getTime() - Date.now())).toBeLessThan(1000);
  });
  test("com HADES_NOW, devolve o instante fixo", () => {
    expect(clockNow({ HADES_NOW: "2026-11-20T12:00:00Z" }).toISOString()).toBe("2026-11-20T12:00:00.000Z");
  });
  test("HADES_NOW inválido falha com mensagem clara", () => {
    expect(() => clockNow({ HADES_NOW: "ontem" })).toThrow("HADES_NOW=ontem");
  });
});
