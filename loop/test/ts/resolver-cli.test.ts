// Grupo resolver: `hades project` responde, em cada tipo de diretório, o que os três resolvedores de referência (bash, node,
// python) gravaram em golden/legado.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { BUN, Rig, SKILL, sortedJson } from "./lib/rig";
import { legado } from "./lib/legado";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const g = legado(import.meta.path);
const NOMES = ["bash", "node", "python"];

describe("resolver (CLI)", () => {
  const d = r.hookDirs(); mkdirSync(`${r.C}/sub`, { recursive: true });
  for (const dir of [r.C, `${r.C}/sub`, d.wt!, r.P, `${r.T}/nogit`]) {
    for (const q of ["resolve", "get flow.base", "get card.example", "get rules.severity.vocabulary"]) {
      test(`${q} em ${dir.replace(r.T, "<T>")}: a CLI responde igual aos resolvedores gravados`, () => {
        const sub = q.split(" ");
        const p = q === "resolve" ? r.X([BUN, `${SKILL}/src/cli.ts`, "project", "resolve", dir]) : r.X([BUN, `${SKILL}/src/cli.ts`, "project", ...sub, "--dir", dir]);
        let cli = `rc=${p.rc} ${q === "resolve" ? (p.out.trim() ? sortedJson(p.out) : "") : p.out.replace(/\n+$/, "")}`;
        if (p.err) cli += ` | ${p.err.split("\n")[0]}`;
        cli = r.norm(cli);
        for (const n of NOMES) expect(g.get(`${n}|${q}|${dir.replace(r.T, "<T>")}`)).toBe(cli);
      }, 30_000);
    }
  }
});
