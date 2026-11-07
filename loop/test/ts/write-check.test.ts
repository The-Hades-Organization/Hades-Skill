// `hades write-check` (reference/escrita.md): cada regra pega o que promete e deixa passar código, aspas retas e comentário.
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { checar, mascarar } from "../../../src/commands/write-check";
import { Rig } from "./lib/rig";

const codigos = (t: string, o = {}) => checar(t, o).map((a) => a.codigo);

describe("write-check: regras", () => {
  test("travessão em prosa é bloqueante; em cabeçalho e em célula vazia de tabela passa", () => {
    expect(checar("O loop roda — e para antes do merge.")[0]).toMatchObject({ codigo: "travessao", gravidade: "bloqueante", linha: 1 });
    expect(codigos("## 6.24.0 — 2026-11-07")).toEqual([]);
    expect(codigos("| `models` | aplica o mapa | — |")).toEqual([]);
    expect(codigos("Faixa de 2026-2030 e a-b ficam.")).toEqual([]);
    expect(codigos("Dois hífens -- no meio.")).toEqual(["travessao"]);
  });

  test("antítese, gancho, resíduo de chat e anúncio de importância", () => {
    expect(codigos("Isso não é apenas uma atualização, é uma revolução.")).toContain("antitese");
    expect(codigos("Não se trata de velocidade, mas de confiança.")).toContain("antitese");
    expect(codigos("O gate não é barrado em segundo plano, mas só quando a fila enche.")).not.toContain("antitese");
    expect(codigos("E é aqui que tudo muda.")).toEqual(["gancho"]);
    expect(codigos("Ótima pergunta! Espero ter ajudado.")).toEqual(["residuo-de-chat"]);
    expect(codigos("É importante notar que o lock expira.")).toEqual(["anuncio-de-importancia"]);
    expect(codigos("A chave é o spec-id.")).toEqual([]);
  });

  test("vocabulário, muleta formal, gerúndio final e atribuição vaga", () => {
    expect(codigos("Uma solução robusta e poderosa.")).toEqual(["vocabulario-inflado"]);
    expect(codigos("O sistema possui a capacidade de processar.")).toEqual(["muleta-formal"]);
    expect(codigos("O loop abre a PR, garantindo o registro.")).toEqual(["gerundio-final"]);
    expect(codigos("Especialistas acreditam que isso funciona.")).toEqual(["atribuicao-vaga"]);
    expect(codigos("A tabela robusta do banco aguenta.")).toEqual(["vocabulario-inflado"]);
  });

  test("cabeçalho em pergunta, Title Case, emoji e aspas curvas", () => {
    expect(codigos("## Por que JSON")).toEqual(["cabecalho-pergunta"]);
    expect(codigos("### Como funciona o gate?")).toEqual(["cabecalho-pergunta"]);
    expect(codigos("Por que isso importa não é cabeçalho.")).toEqual(["gancho"]);
    expect(codigos("## Negociações Estratégicas Globais")).toEqual(["title-case"]);
    expect(codigos("## Fila do Gate")).toEqual([]);
    expect(codigos("Passou ✅ e 🚀.")).toEqual(["emoji"]);
    expect(codigos("Ele disse “está no prazo”.")).toEqual(["aspas-curvas"]);
  });

  test("negrito de rótulo: três itens ou mais, e só fora do CHANGELOG", () => {
    const tres = "- **Um:** a\n- **Dois:** b\n- **Tres:** c\n";
    expect(checar(tres)).toMatchObject([{ codigo: "negrito-de-rotulo", linha: 1 }]);
    expect(codigos("- **Um:** a\n- **Dois:** b\n")).toEqual([]);
    expect(codigos(tres, { changelog: true })).toEqual([]);
  });

  test("histórico de edição e resíduo de produção valem em documento, não no CHANGELOG", () => {
    expect(codigos("A altura agora usa o layout (antes era lida uma vez).")).toContain("diario-de-edicao");
    expect(codigos("Feito conforme o pedido.")).toEqual(["residuo-de-producao"]);
    expect(codigos("A altura agora usa o layout (antes era lida uma vez).", { changelog: true })).toEqual([]);
  });
});

describe("write-check: máscara", () => {
  test("código, crases, aspas retas, comentário e metadados não são julgados", () => {
    const t = [
      "---",
      "description: robusta — e poderosa",
      "---",
      "```",
      "isso — é código, garantindo nada",
      "```",
      "Use `a — b` e a frase \"e é aqui que tudo muda\" como exemplo.",
      "<!-- Em resumo — comentário -->",
      "Link [x](http://a/b — c).",
      "Texto limpo.",
    ].join("\n");
    expect(checar(t)).toEqual([]);
    expect(mascarar(t)).toHaveLength(10);
  });

  test("comentário de várias linhas e cerca de til", () => {
    expect(checar("<!-- abre\n robusto — fecha -->\nok\n~~~\nrobusto — aqui\n~~~\n")).toEqual([]);
    expect(codigos("<!-- c -->\nTexto robusto.")).toEqual(["vocabulario-inflado"]);
  });

  test("número da linha é o do arquivo original", () => {
    expect(checar("a\n\n```\nx\n```\nTexto — solto.\n")[0]!.linha).toBe(6);
  });
});

describe("write-check: CLI", () => {
  const r = new Rig().setup();
  afterAll(() => r.cleanup());
  const f = (nome: string, texto: string) => {
    const p = `${r.T}/${nome}`;
    writeFileSync(p, texto);
    return p;
  };

  test("limpo sai 0; achado sai 1 com arquivo:linha; uso errado sai 2", () => {
    const limpo = r.hades(["write-check", f("a.md", "O loop para antes do merge.\n")]);
    expect(limpo.rc).toBe(0);
    expect(limpo.out).toContain("write-check: limpo");
    const sujo = r.hades(["write-check", f("b.md", "ok\nIsso roda — rápido.\n")]);
    expect(sujo.rc).toBe(1);
    expect(sujo.out).toMatch(/b\.md:2: bloqueante \[travessao\]/);
    expect(sujo.out).toContain("1 achado(s), 1 bloqueante(s)");
    expect(r.hades(["write-check"], { merge: true }).rc).toBe(2);
    expect(r.hades(["write-check", "--nada", "x"], { merge: true }).rc).toBe(2);
    expect(r.hades(["write-check", `${r.T}/nao-existe.md`], { merge: true }).rc).toBe(2);
  });

  test("--json e --changelog", () => {
    const p = f("c.md", "- **A:** x\n- **B:** y\n- **C:** z\n");
    const j = JSON.parse(r.hades(["write-check", "--json", p]).out) as { achados: { codigo: string }[] }[];
    expect(j[0]!.achados.map((a) => a.codigo)).toEqual(["negrito-de-rotulo"]);
    expect(r.hades(["write-check", "--changelog", p]).rc).toBe(0);
  });
});
