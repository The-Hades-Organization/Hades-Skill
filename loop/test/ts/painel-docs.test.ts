// Página Documentação: o corte do documento em seções (a regra de desempenho do documento longo) e a fiação da leitura.
// O docs.tsx é um script de navegador (IIFE sobre HadesCore); a função pura é extraída do texto e avaliada aqui.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/pages/docs.tsx"), "utf8");
const trecho = SRC.slice(SRC.indexOf("function secoes"), SRC.indexOf("function renderDoc"));
const secoes = new Function(`${trecho}; return secoes;`)() as (t: string) => string[];

describe("secoes: o documento é cortado em cada título de nível 2", () => {
  test("dado texto sem título de nível 2, então volta uma seção só", () => {
    expect(secoes("# Título\n\ncorpo")).toEqual(["# Título\n\ncorpo"]);
  });
  test("dado vazio, então volta uma seção vazia", () => {
    expect(secoes("")).toEqual([""]);
  });
  test("dado três títulos de nível 2, então a abertura e cada título viram uma seção, sem perder linha", () => {
    const t = "# A\n\nabre\n\n## B\n\nb\n\n### B1\n\nb1\n\n## C\n\nc";
    const s = secoes(t);
    expect(s).toHaveLength(3);
    expect(s[0]).toBe("# A\n\nabre\n");
    expect(s[1]!.startsWith("## B")).toBe(true);
    expect(s[1]).toContain("### B1");
    expect(s[2]!.startsWith("## C")).toBe(true);
    expect(s.join("\n")).toBe(t);
  });
  test("dado '## ' dentro de bloco de código, então não corta ali", () => {
    const t = "# A\n\n```md\n## falso\n```\n\n## Real\n\nx";
    const s = secoes(t);
    expect(s).toHaveLength(2);
    expect(s[0]).toContain("## falso");
    expect(s[1]!.startsWith("## Real")).toBe(true);
  });
  test("dado o documento vivo mais longo da skill, então cada linha volta em alguma seção", () => {
    const t = readFileSync(join(import.meta.dir, "../../../reference/argos.md"), "utf8");
    const s = secoes(t);
    expect(s.length).toBeGreaterThan(5);
    expect(s.join("\n")).toBe(t);
  });
});

describe("leitura: a fiação que o desempenho e a acessibilidade pedem", () => {
  test("seção adiada usa content-visibility com tamanho estimado", () => {
    expect(SRC).toContain("content-visibility:auto");
    expect(SRC).toContain("contain-intrinsic-size");
  });
  test("o salto ao tópico respeita prefers-reduced-motion", () => {
    expect(SRC).toContain("prefers-reduced-motion: reduce");
  });
  test("o botão de copiar tem nome acessível e não usa innerHTML", () => {
    expect(SRC).toContain("Copiar este bloco de código");
    expect(SRC).not.toContain("innerHTML =");
  });
  test("cada listener do efeito do documento é desfeito na saída", () => {
    expect(SRC).toContain("io.disconnect()");
    expect(SRC).toContain("clearTimeout(t)");
  });
});
