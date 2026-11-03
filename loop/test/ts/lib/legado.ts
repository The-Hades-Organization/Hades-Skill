// Saídas gravadas do original que a prova de paridade comparava lado a lado. O original saiu da skill na 5.0.0; o que ele
// produzia ficou em loop/test/golden/legado/<arquivo>.json (chave → valor JSON), gravado enquanto ele ainda existia.
//
//   const g = legado(import.meta.path);        // um por arquivo de teste
//   g.get("pr-set --heads")                    // o valor gravado (falha se a chave não existe)
//
// Gravação (só antes de apagar o original, com ele no lugar): LEGADO_GRAVAR=1 bun test <arquivo>; nesse modo
// `g.rec(chave, () => valor)` roda o produtor, guarda o valor e o devolve. Fora dele `rec` lê do arquivo e nunca chama o produtor.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, expect } from "bun:test";
import { GOLD } from "./rig";

const DIR = join(GOLD, "legado");
const gravar = process.env.LEGADO_GRAVAR === "1";
const regrava = process.env.LEGADO_REGRAVA === "1";

export interface Legado {
  get<T = unknown>(chave: string): T;
  rec<T>(chave: string, produtor: () => T): T;
  /** Só com LEGADO_REGRAVA=1: troca o valor gravado de `chave` pelo atual (conferido a olho no diff do golden). Fora dele não faz nada. */
  fix(chave: string, atual: unknown): void;
  /**
   * `atual` igual ao valor gravado de `chave`; se diferir, a mensagem diz como regravar (LEGADO_REGRAVA=1) e o que conferir no
   * diff. Para golden que depende da UI do painel (hash do sw.js, lista do drift), que muda a cada mudança de tela.
   */
  confere(chave: string, atual: unknown): void;
}

export function legado(testFile: string): Legado {
  const file = join(DIR, `${basename(testFile).replace(/\.test\.ts$/, "")}.json`);
  const dados: Record<string, unknown> = !gravar && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (regrava) {
    afterAll(() => {
      const sorted = Object.fromEntries(Object.keys(dados).sort().map((k) => [k, dados[k]]));
      writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
    });
  }
  if (gravar) {
    afterAll(() => {
      mkdirSync(DIR, { recursive: true });
      const sorted = Object.fromEntries(Object.keys(dados).sort().map((k) => [k, dados[k]]));
      writeFileSync(file, `${JSON.stringify(sorted, null, 1)}\n`);
    });
  }
  const get = <T>(chave: string): T => {
    if (!(chave in dados)) throw new Error(`${basename(file)}: sem valor gravado para '${chave}'`);
    return dados[chave] as T;
  };
  return {
    get,
    fix(chave, atual) { if (regrava) dados[chave] = atual; },
    confere(chave, atual) {
      if (regrava) dados[chave] = atual;
      const como = `golden '${chave}' (${basename(file)}) difere do atual. Se a mudança é da UI do painel (hash do sw.js no cache do service worker, `
        + `arquivos novos ou editados em kit/panel/ no drift do skill-release) e é esperada: LEGADO_REGRAVA=1 bun test loop/test/ts/${basename(testFile)}, `
        + "e confira no diff do golden que mudou só essa linha, só no que a sua mudança de UI explica. Diferença fora disso é defeito, não regrave.";
      expect(atual, como).toEqual(get(chave));
    },
    rec<T>(chave: string, produtor: () => T): T {
      if (!gravar) return get<T>(chave);
      if (chave in dados) throw new Error(`${basename(file)}: chave repetida '${chave}'`);
      const v = produtor();
      dados[chave] = v;
      return v;
    },
  };
}
