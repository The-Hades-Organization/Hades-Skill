// 5.5.2: drift só de arquivo novo do kit diz que basta reinstalar (com o comando pronto), antes do release abortar.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const data = `${r.T}/data-drift`;
mkdirSync(data, { recursive: true });
writeFileSync(`${data}/env.sh`, `W="${r.C}"\n`);
mkdirSync(`${r.T}/packs-vazio`, { recursive: true });
const env = { HADES_DATA: data, HADES_WT: r.C, HADES_PACKS_ROOT: `${r.T}/packs-vazio` };
const release = (args: string[]) => r.X([BUN, `${SKILL}/src/cli.ts`, "skill-release", ...args], { merge: true, env });
const COMANDO = `HADES_WT=${r.C} HADES_DATA=${data} ${SKILL}/kit/install.sh`;

describe("skill-release: drift de arquivo novo do kit", () => {
  test("nada instalado: o drift manda reinstalar, com o comando pronto", () => {
    const x = release(["drift"]);
    expect(x.rc).toBe(1);
    expect(x.out).toContain(`reinstale, sem portar nada: ${COMANDO}`);
  });
  test("o release aborta pelo drift e a dica já veio antes do aviso", () => {
    const x = release(["release", "patch", "resumo"]);
    expect(x.rc).toBe(1);
    expect(x.out.indexOf("reinstale, sem portar nada")).toBeGreaterThan(-1);
    expect(x.out.indexOf("reinstale, sem portar nada")).toBeLessThan(x.out.indexOf("release abortado: há drift"));
  });
  test("arquivo do kit editado no $D: reinstalar sobrescreveria a edição, então não há dica", () => {
    writeFileSync(`${data}/watch.sh`, "editado à mão\n");
    const x = release(["drift"]);
    expect(x.out).toContain("editado em $D:");
    expect(x.out).not.toContain("reinstale, sem portar nada");
  });
});
