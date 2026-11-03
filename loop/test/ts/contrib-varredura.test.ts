// Grupo contrib-varredura: a mesma guarda de nome, domínio e segredo do `skill-release check`, aplicada ao texto e ao diff
// de uma contribuição. Achado = nada é gerado; o comando lista arquivo:linha.
import { describe, expect, test } from "bun:test";
import { parseDiff } from "../../../src/lib/contrib-diff";
import { formatFinding, scanContribution } from "../../../src/lib/contrib-scan";
import { CAMINHO_DE_MAQUINA, EMAIL, SENHA, TERMOS_VAZIOS, TOKEN_GH, edita, novo } from "./lib/contrib-amostra";

const TERMOS = { names: ["acmeproj"], vocab: ["acme-[a-z]+"], domain: ["turbina"], allow: ["reference/legado/*"], slug: "Dono/Skill" };
const varre = (diff: string, texts: { label: string; text: string }[] = [], terms = TERMOS) => scanContribution(parseDiff(diff), texts, terms).map(formatFinding);

describe("contrib-varredura", () => {
  test("diff limpo passa", () => {
    expect(varre(novo("src/a.ts", ["export const a = 1;", "// explica o porquê"]))).toEqual([]);
  });

  test("nome de projeto (termo e vocabulário, sem diferenciar caixa) barra com arquivo:linha", () => {
    const f = varre(novo("src/a.ts", ["ok", "// feito para o AcmeProj", "ok", "const x = 'acme-api';"]));
    expect(f).toEqual(["src/a.ts:2  nome de projeto", "src/a.ts:4  nome de projeto"]);
  });

  test("domínio barra, e o @allow do pacote isenta o arquivo declarado", () => {
    expect(varre(novo("src/a.ts", ["a", "calibra a turbina"]))).toEqual(["src/a.ts:2  domínio de projeto"]);
    expect(varre(novo("reference/legado/a.md", ["calibra a turbina"]))).toEqual([]);
  });

  test("caminho da máquina, e-mail e token barram, sem repetir o segredo na saída", () => {
    const f = varre(novo("kit/a.sh", [`cd ${CAMINHO_DE_MAQUINA}`, `echo ${EMAIL}`, `export T=${TOKEN_GH}`, SENHA]));
    expect(f).toEqual(["kit/a.sh:1  caminho da máquina", "kit/a.sh:2  e-mail", "kit/a.sh:3  credencial", "kit/a.sh:4  credencial"]);
    for (const l of f) expect(l).not.toContain("hunter2");
  });

  test("e-mail de exemplo e noreply não barram", () => {
    expect(varre(novo("reference/a.md", ["fulano@example.invalid", "Co-Authored-By: X <noreply@anthropic.com>"]))).toEqual([]);
  });

  test("só linha posta conta: linha tirada e contexto não barram", () => {
    expect(varre(edita("src/a.ts", 3, "// acmeproj", "// neutro"))).toEqual([]);
  });

  test("o número da linha é o do arquivo novo", () => {
    expect(varre(edita("src/a.ts", 40, "a", "acmeproj"))).toEqual(["src/a.ts:41  nome de projeto"]);
  });

  test("o slug do repositório da skill é isento", () => {
    expect(varre(novo("src/a.ts", ["const repo = 'Dono/Skill'; // acmeproj nada"]), [], { ...TERMOS, names: ["Dono"] })).toEqual([]);
  });

  test("nome de projeto no caminho do arquivo barra", () => {
    expect(varre(novo("kit/acmeproj.sh", ["a"]))).toEqual(["kit/acmeproj.sh  nome de projeto (caminho)"]);
  });

  test("título e corpo passam pela mesma guarda, com o rótulo no lugar do arquivo", () => {
    const f = varre(novo("src/a.ts", ["a"]), [{ label: "título", text: "feat: acmeproj" }, { label: "corpo", text: "linha 1\nenvie para " + EMAIL }]);
    expect(f).toEqual(["título:1  nome de projeto", "corpo:2  e-mail"]);
  });

  test("sem termos de perfil ainda barra o que não depende de perfil (segredo, caminho, e-mail)", () => {
    expect(varre(novo("a", [`x ${CAMINHO_DE_MAQUINA}`]), [], TERMOS_VAZIOS)).toEqual(["a:1  caminho da máquina"]);
  });

  test("termo de vocabulário que não compila falha fechado, sem gerar nada", () => {
    expect(() => varre(novo("a", ["x"]), [], { ...TERMOS, vocab: ["(["] })).toThrow(/vocabulário/);
  });
});
