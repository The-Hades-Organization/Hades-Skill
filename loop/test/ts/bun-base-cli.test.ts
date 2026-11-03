// Grupo bun-base: dependência ausente falha cedo (69) com a instrução do registro, pelo bash (lib.sh dep_need, hades_ts) e pela CLI.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { BUN, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
// lib.sh (dep_need, hades_ts) é do que sobrevive na skill: o bash que o kit e os hooks carregam
const LIB = join(SKILL, "loop", "bin", "lib.sh");
const CLI = `${SKILL}/src/cli.ts`, NB = `${r.T}/bb-nobun`, OB = `${r.T}/bb-onlybun`;
mkdirSync(NB, { recursive: true }); mkdirSync(OB, { recursive: true }); symlinkSync(BUN, `${OB}/bun`);
for (const t of ["bash", "awk", "cut", "dirname"]) if (!existsSync(`${NB}/${t}`)) symlinkSync(Bun.which(t) ?? `/usr/bin/${t}`, `${NB}/${t}`);
const depNeed = () => r.X(["bash", "-c", 'HADES_LIB_BUN_ONLY=1 source "$2"; dep_need herdr', "_", SKILL, LIB], { merge: true, env: { PATH: NB } });

describe("bun-base-cli", () => {
  test("dep_need (bash) dá a mesma mensagem e o mesmo código da CLI", () => {
    const cli = r.X([BUN, CLI, "deps", "need", "herdr"], { merge: true, env: { PATH: OB } }), sh = depNeed();
    expect(`${sh.out.replace(/\n$/, "")} ${sh.rc}`).toBe(`${cli.out.replace(/\n$/, "")} 69`);
  });
  test("hades_ts sem Bun (instance list): sai 69 com a instrução do registro", () => {
    const o = r.X(["bash", "-c", 'HADES_LIB_BUN_ONLY=1 source "$2"; hades_ts instance list', "_", SKILL, LIB], { merge: true, env: { PATH: NB, HADES_BUN: "" } });
    expect(`${o.rc} ${o.out.includes("dependência ausente: bun") && o.out.includes("https://bun.sh/install") ? "sim" : `não (${o.out})`}`).toBe("69 sim");
  });
});
