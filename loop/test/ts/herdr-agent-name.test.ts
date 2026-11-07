// Grupo herdr-agent-name: o nome de agente do herdr derivado do nome do terminal (src/lib/herdr-agent-name.ts).
import { describe, expect, test } from "bun:test";
import { HERDR_AGENT_NAME, HERDR_AGENT_NAME_MAX, deriveHerdrAgentName, slugAgentName } from "../../../src/lib/herdr-agent-name";

describe("herdr-agent-name: derivação", () => {
  test("nome já válido não muda", () => {
    expect(slugAgentName("argos-bordas")).toBe("argos-bordas");
    expect(slugAgentName("a_b-1")).toBe("a_b-1");
  });

  test("maiúscula vira minúscula; espaço e ponto viram hífen, sem repetir nem ficar nas pontas", () => {
    expect(slugAgentName("Orq Hades.Issues")).toBe("orq-hades-issues");
    expect(slugAgentName("  a  ..  b  ")).toBe("a-b");
  });

  test("acento some", () => {
    expect(slugAgentName("Revisão Ação")).toBe("revisao-acao");
  });

  test("vazio ou só símbolos viram o prefixo", () => {
    expect(slugAgentName("")).toBe("agent");
    expect(slugAgentName(" . . ")).toBe("agent");
  });

  test("começa por dígito ou sublinhado: ganha o prefixo", () => {
    expect(slugAgentName("1 teste")).toBe("agent-1-teste");
    expect(slugAgentName("_x")).toBe("agent-_x");
  });

  test("32 caracteres é o teto e o corte não deixa hífen na ponta", () => {
    const long = slugAgentName("a".repeat(40));
    expect(long).toBe("a".repeat(HERDR_AGENT_NAME_MAX));
    expect(slugAgentName(`${"a".repeat(31)} b`)).toBe("a".repeat(31));
    expect(slugAgentName("9".repeat(40)).length).toBeLessThanOrEqual(HERDR_AGENT_NAME_MAX);
  });

  test("todo resultado casa o formato do herdr", () => {
    for (const input of ["", "!!!", "É", "7", "x".repeat(100), "Olá, mundo — ok?", "a.b.c", "-"]) {
      expect(HERDR_AGENT_NAME.test(deriveHerdrAgentName(input))).toBe(true);
    }
  });
});

describe("herdr-agent-name: colisão", () => {
  test("nome livre fica como está", () => {
    expect(deriveHerdrAgentName("Foo", ["bar"])).toBe("foo");
  });

  test("colisão ganha -2, -3…", () => {
    expect(deriveHerdrAgentName("Foo", ["foo"])).toBe("foo-2");
    expect(deriveHerdrAgentName("Foo", ["foo", "foo-2"])).toBe("foo-3");
    expect(deriveHerdrAgentName("foo bar", new Set(["foo-bar"]))).toBe("foo-bar-2");
  });

  test("nomes diferentes que dão no mesmo derivado colidem", () => {
    expect(deriveHerdrAgentName("A B", [deriveHerdrAgentName("a.b")])).toBe("a-b-2");
  });

  test("o sufixo cabe nos 32 caracteres: o nome comprido encurta", () => {
    const full = "a".repeat(32);
    const next = deriveHerdrAgentName(full, [full]);
    expect(next).toBe(`${"a".repeat(30)}-2`);
    expect(next.length).toBe(HERDR_AGENT_NAME_MAX);
    expect(HERDR_AGENT_NAME.test(next)).toBe(true);
  });

  test("corte que cairia num hífen não deixa hífen duplo antes do sufixo", () => {
    const base = `${"a".repeat(29)}-bb`;
    expect(deriveHerdrAgentName(base, [base])).toBe(`${"a".repeat(29)}-bb`.slice(0, 30).replace(/-+$/, "") + "-2");
  });
});
