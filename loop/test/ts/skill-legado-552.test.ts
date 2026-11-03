// 5.5.2: golden que depende da UI do painel (hash do sw.js, lista do drift) que cai diz como regravar e o que conferir no diff.
import { describe, expect, test } from "bun:test";
import { legado } from "./lib/legado";

const g = legado(import.meta.path);

describe("legado.confere", () => {
  test("valor igual ao gravado passa", () => {
    expect(() => g.confere("chave", "gravado")).not.toThrow();
  });
  test("valor diferente falha apontando LEGADO_REGRAVA=1 e o que conferir no diff", () => {
    let mensagem = "";
    try { g.confere("chave", "outro"); } catch (e) { mensagem = (e as Error).message; }
    expect(mensagem).toContain("golden 'chave' (skill-legado-552.json)");
    expect(mensagem).toContain("LEGADO_REGRAVA=1 bun test loop/test/ts/skill-legado-552.test.ts");
    expect(mensagem).toContain("sw.js");
    expect(mensagem).toContain("confira no diff do golden");
  });
  test("chave sem valor gravado falha dizendo qual", () => {
    expect(() => g.confere("nao-existe", "x")).toThrow("sem valor gravado para 'nao-existe'");
  });
});
