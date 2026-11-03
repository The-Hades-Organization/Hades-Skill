// Grupo multi-instancia: `hades instance` dá a saída e o código gravados do comportamento de referência (golden/legado).
import { afterAll, describe, expect, test } from "bun:test";
import { BUN, FX, Rig, SKILL } from "./lib/rig";
import { legado } from "./lib/legado";
import { miInstalled } from "./lib/mi";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const { MI, wt1, wt2 } = miInstalled(r, FX);
const g = legado(import.meta.path);

describe("multi-instancia-cli", () => {
  const casos: [string, string[]][] = [[`--dir ${wt2}`, ["--dir", wt2]], [`--dir ${wt1}`, ["--dir", wt1]], [`--dir ${r.T}/nogit`, ["--dir", `${r.T}/nogit`]],
    ["list", ["list"]], ["sem argumento", []], ["bogus", ["bogus"]]];
  for (const [nome, a] of casos) {
    test(`hades instance ${nome}: saída e código iguais aos gravados`, () => {
      const ref = g.get<string>(r.norm(nome));
      const o = MI([BUN, `${SKILL}/src/cli.ts`, "instance", ...a], {}, { merge: true });
      expect(r.norm(`${o.out}rc=${o.rc}`)).toBe(ref);
    });
  }
});
