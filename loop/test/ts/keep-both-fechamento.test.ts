// keep-both: duas adições no mesmo ponto cujo fechamento o git deixou comum, logo depois do conflito (`  });` do bloco e
// `});` do arquivo). Juntar só ours+theirs deixa o primeiro bloco sem fechar. reference/branch.md §Resolver conflito novo.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const CLI = `${SKILL}/src/cli.ts`;

function keepBoth(name: string, text: string): string {
  const dir = `${r.T}/kbf`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${name}`;
  writeFileSync(file, text);
  expect(r.X([BUN, CLI, "keep-both", file], { env: { HADES_SKILL_DIR: SKILL } }).rc).toBe(0);
  return readFileSync(file, "utf8");
}

const FIM = '  });\n});\n';
const conflito = (ours: string, theirs: string, resto = FIM): string =>
  `describe("x", () => {\n  test("base", () => {\n    a();\n  });\n\n<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> theirs\n${resto}`;
const bloco = (nome: string, corpo: string): string => `  test("${nome}", () => {\n    ${corpo}\n`;

describe("keep-both: fechamento comum depois do conflito", () => {
  test("dado dois blocos abertos e o fechamento comum depois, então cada bloco ganha o seu e o arquivo fecha uma vez", () => {
    const out = keepBoth("dois.ts", conflito(bloco("A", "c();"), bloco("B", "b();")));
    expect(out).toBe(
      'describe("x", () => {\n  test("base", () => {\n    a();\n  });\n\n'
      + '  test("A", () => {\n    c();\n  });\n  test("B", () => {\n    b();\n  });\n});\n',
    );
  });

  test("dado dois conflitos separados por trecho comum, então todos os blocos fecham", () => {
    const segundo = `<<<<<<< HEAD\n${bloco("C", "x();")}=======\n${bloco("D", "y();")}>>>>>>> theirs\n${FIM}`;
    const meio = '  });\n\n  test("meio", () => {\n    m();\n  });\n\n';
    const out = keepBoth("dois-conflitos.ts", conflito(bloco("A", "c();"), bloco("B", "b();"), meio + segundo));
    expect((out.match(/\{/g) ?? []).length).toBe((out.match(/\}/g) ?? []).length);
    expect(out).not.toContain("<<<<<<<");
    expect(out.indexOf('test("A"')).toBeLessThan(out.indexOf('test("B"'));
  });

  test("dado fechamento que não fecha o bloco aberto, então só junta os dois lados", () => {
    const out = keepBoth("solto.ts", conflito(bloco("A", "c();"), bloco("B", "b();"), "fim\n"));
    expect(out).toContain('c();\n  test("B"');
    expect(out.endsWith("b();\nfim\n")).toBe(true);
  });

  test("dado lados fechados (sem bloco aberto), então segue ours + theirs sem inserir nada", () => {
    const ours = '  test("A", () => {\n    c();\n  });\n';
    const theirs = '  test("B", () => {\n    b();\n  });\n';
    const out = keepBoth("fechado.ts", conflito(ours, theirs));
    expect(out).toBe(`describe("x", () => {\n  test("base", () => {\n    a();\n  });\n\n${ours}${theirs}${FIM}`);
  });

  test("dado marcador final sem quebra de linha no fim do arquivo, então também resolve", () => {
    const out = keepBoth("semnl.txt", "a\n<<<<<<< HEAD\num\n=======\ndois\n>>>>>>> br");
    expect(out).toBe("a\num\ndois\n");
  });
});
