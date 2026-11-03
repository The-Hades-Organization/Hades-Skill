// Grupo resolver: o resolvedor de projeto (`hades project resolve|get`) dá a resposta gravada em cada tipo de diretório.
import { afterAll, describe, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { Rig, checkText, sortedJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("resolver", () => {
  test("resolver.txt", () => {
    const d = r.hookDirs(); mkdirSync(`${r.C}/sub`, { recursive: true });
    let out = "";
    for (const dir of [r.C, `${r.C}/sub`, d.wt!, r.P, `${r.T}/nogit`]) {
      out += `# ${dir}\n`;
      for (const q of ["resolve", "get flow.base", "get card.example", "get rules.severity.vocabulary"]) {
        let line: string;
        if (q === "resolve") {
          const p = r.hades(["project", "resolve", dir]);
          line = `rc=${p.rc} ${p.out.trim() ? sortedJson(p.out) : ""}`;
          if (p.err) line += ` | ${p.err.split("\n")[0]}`;
        } else {
          const p = r.hades(["project", ...q.split(" "), "--dir", dir]);
          line = `rc=${p.rc} ${p.out.replace(/\n+$/, "")}`;
          if (p.err) line += ` | ${p.err.split("\n")[0]}`;
        }
        out += `  ${q}: ${line}\n`;
      }
    }
    checkText("resolver.txt", r.norm(out));
  });
});
