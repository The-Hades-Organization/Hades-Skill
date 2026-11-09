// Grupo minos-documento: os modelos `explicacao` e `proposta` — contrato na fronteira, página escapada e o comando de
// ponta a ponta (schema, publish com o JSON da sessão, escopo vindo da invocação, guarda antes de gravar).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EXPLICACAO_EXAMPLE, PROPOSTA_EXAMPLE, validateExplanation, validateProposal } from "../../../src/lib/minos-doc";
import { inline } from "../../../src/lib/minos-doc-html";
import { loadTemplate, renderPage, titleOf } from "../../../src/lib/minos-html";
import { ContractError } from "../../../src/lib/minos-model";
import { outputId } from "../../../src/lib/minos-store";
import { BUN, Rig, SKILL, kv } from "./lib/rig";

const HEAD = { scope: "personal", generatedAt: "2026-11-09T12:00:00Z" } as const;
const prop = (over: Record<string, unknown> = {}): unknown => ({ ...PROPOSTA_EXAMPLE, ...HEAD, ...over });
const expl = (over: Record<string, unknown> = {}): unknown => ({ ...EXPLICACAO_EXAMPLE, ...HEAD, ...over });
// montado em partes: este arquivo não casa com a varredura de segredos do release
const TOKEN_FICTICIO = `${"gh"}p_${"a1B2".repeat(9)}`;

const refused = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    return (error as ContractError).message;
  }
  throw new Error("o contrato aceitou o que devia recusar");
};

describe("minos-documento: contrato", () => {
  test("dados os exemplos do schema, então os dois validam e voltam iguais após ida e volta em JSON", () => {
    const p = validateProposal(prop());
    expect(validateProposal(JSON.parse(JSON.stringify(p)))).toEqual(p);
    const e = validateExplanation(expl());
    expect(validateExplanation(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  test("dado só título e resumo, então listas vazias, opcionais null e status rascunho, sem valor inventado", () => {
    const p = validateProposal({ model: "proposta", schema: 1, kind: "correcao", title: "t", summary: "s", ...HEAD });
    expect([p.status, p.recommendation, p.source]).toEqual(["rascunho", null, { repo: null, ref: null, paths: [] }]);
    expect([p.options, p.questions, p.plan, p.risks]).toEqual([[], [], [], []]);
    const e = validateExplanation({ model: "explicacao", schema: 1, title: "t", summary: "s", ...HEAD });
    expect([e.question, e.flow, e.sections, e.caveats]).toEqual([null, [], [], []]);
  });

  test("dado tipo de proposta, recomendação sem opção, id repetido ou texto acima do teto, então recusa com o caminho", () => {
    expect(refused(() => validateProposal(prop({ kind: "outra" })))).toStartWith("kind:");
    expect(refused(() => validateProposal(prop({ recommendation: { option: "Z", why: [] } })))).toStartWith("recommendation.option:");
    const dup = [...PROPOSTA_EXAMPLE.options, PROPOSTA_EXAMPLE.options[0]];
    expect(refused(() => validateProposal(prop({ options: dup })))).toStartWith("options[2].id:");
    expect(refused(() => validateExplanation(expl({ title: "x".repeat(501) })))).toStartWith("title:");
    expect(refused(() => validateExplanation(expl({ model: "proposta" })))).toStartWith("model:");
  });
});

describe("minos-documento: página", () => {
  test("dado HTML nos dados (trecho, crase, título), então tudo sai escapado e só a crase vira <code>", () => {
    expect(inline("usa `a<b>` e <i>")).toBe("usa <code>a&lt;b&gt;</code> e &lt;i&gt;");
    const hostile = validateExplanation(expl({
      title: "<script>alert(1)</script>",
      sections: [{ title: "s", paragraphs: ["`<img src=x>`"], code: [{ file: "a.ts", snippet: "</pre><script>x()</script>" }] }],
    }));
    const html = renderPage(loadTemplate(), hostile);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("</pre><script>");
    expect(html).toContain("<code>&lt;img src=x&gt;</code>");
  });

  test("dado o tipo da proposta, então o título da página segue o tipo, com duas a quatro palavras", () => {
    expect(titleOf(validateProposal(prop({ kind: "discussao" })))).toBe("Discussão técnica");
    expect(titleOf(validateProposal(prop({ kind: "correcao" })))).toBe("Proposta de correção");
    expect(titleOf(validateExplanation(expl()))).toBe("Explicação de código");
  });

  test("dado o JSON da sessão, então a saída se chama pelo modelo e pelo arquivo, sem a extensão", () => {
    expect(outputId("proposta", "/x/Retry Pedidos.json", "personal")).toBe("proposta-retry-pedidos");
    expect(outputId("explicacao", "/x/fluxo.json", "team")).toBe("explicacao-fluxo-team");
  });
});

const r = new Rig().setup();
afterAll(() => r.cleanup());
const D = `${r.T}/dados`;
const MINOS = `${D}/minos`;
const FONTE = `${r.T}/retry.json`;
const minos = (args: string[], e: Record<string, string> = {}) =>
  r.X([BUN, `${SKILL}/src/cli.ts`, "minos", ...args], { merge: true, cwd: r.C, env: kv({ HADES_DATA: D, HADES_WT: r.C, NO_COLOR: "1", HADES_MINOS_TEAM: "0" }, e) });

beforeEach(() => {
  rmSync(MINOS, { recursive: true, force: true });
  mkdirSync(D, { recursive: true });
});

describe("hades minos com modelo de documento", () => {
  test("dado schema proposta, então imprime o exemplo que o publish aceita; orquestracao aponta o plano", () => {
    const a = minos(["schema", "proposta"]);
    expect(a.rc, a.out).toBe(0);
    writeFileSync(FONTE, a.out);
    const b = minos(["publish", "proposta", FONTE]);
    expect(b.rc, b.out).toBe(0);
    expect(b.out).toContain(`publique: ${MINOS}/proposta-retry/index.html`);
    expect(b.out).toContain("descrição: Proposta de correção: Reprocessar pedidos presos");
    const c = minos(["schema", "orquestracao"]);
    expect(c.rc).toBe(2);
    expect(c.out).toContain("a fonte é o plano.md");
  });

  test("dado scope team no arquivo, quando publica sem --team, então a página sai pessoal: o arquivo não escolhe o time", () => {
    writeFileSync(FONTE, JSON.stringify({ ...PROPOSTA_EXAMPLE, scope: "team" }));
    const a = minos(["publish", "proposta", FONTE]);
    expect(a.rc, a.out).toBe(0);
    const data = JSON.parse(readFileSync(`${MINOS}/proposta-retry/data.json`, "utf8"));
    expect(data.scope).toBe("personal");
    expect(minos(["publish", "proposta", FONTE, "--team"]).rc).toBe(1);
  });

  test("dado credencial num trecho de código, quando publica, então o Cerberus barra e nada é gravado", () => {
    const sections = [{ title: "s", paragraphs: [], code: [{ file: "a.ts", snippet: `const t = "${TOKEN_FICTICIO}";` }] }];
    writeFileSync(FONTE, JSON.stringify({ ...EXPLICACAO_EXAMPLE, sections }));
    const a = minos(["publish", "explicacao", FONTE]);
    expect(a.rc, a.out).toBe(1);
    expect(a.out).toContain("o Cerberus barrou");
    expect(a.out).not.toContain(TOKEN_FICTICIO);
    expect(existsSync(MINOS)).toBe(false);
  });

  test("dado JSON inválido, então recusa como erro de entrada com a dica do schema", () => {
    writeFileSync(FONTE, "{ não é json");
    const a = minos(["publish", "explicacao", FONTE]);
    expect(a.rc).toBe(2);
    expect(a.out).toContain("hades minos schema explicacao");
  });
});
