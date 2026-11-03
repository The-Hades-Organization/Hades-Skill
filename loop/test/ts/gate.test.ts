// Grupo gate: fila de admissão (gate-lock) — saídas dos gates, status e diário contra golden/gate.txt.
import { afterAll, describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Rig, checkText, cutF2 } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const GE = { HADES_GATE_MEMCAP: "0", HADES_GATE_RESERVE_GB: "0", HADES_GATE_PSI_MAX: "100" };

describe("gate", () => {
  test("gate.txt", () => {
    const g = (args: string[]) => r.hades(["gate-lock", ...args], { cwd: r.C, merge: true, env: GE }).all;
    const run = (label: string, args: string[]) => {
      const p = r.hades(["gate-lock", ...args], { cwd: r.C, merge: true, env: GE });
      return `${p.out}${label} rc=${p.rc}\n`;
    };
    let out = "";
    out += run("lint", ["run", "lint", "--label", "demo", "--timeout", "30", "--", "true"]);
    out += run("test", ["run", "test", "--label", "demo", "--timeout", "30", "--", "sh", "-c", "exit 3"]);
    out += run("build", ["run", "build", "--label", "demo", "--cost-gb", "2", "--timeout", "30", "--", "env", "NX_PARALLEL=9", "/usr/bin/true"]);
    out += run("bogus", ["run", "bogus", "--", "true"]);
    out += run("sem-comando", ["run", "lint", "--label", "demo"]);
    out += g(["status"]).split("\n").slice(1).join("\n");
    const journal = readFileSync(`${r.T}/work/example__monorepo/locks/gate-journal.tsv`, "utf8");
    out += cutF2(journal.endsWith("\n") ? journal.slice(0, -1) : journal).split("\n")
      .map((l) => l.replace(/avail=[0-9]+MB/, "avail=<MB>").replace(/dur=[0-9]+s/, "dur=<S>").replace(/waited=[0-9]+/, "waited=<S>")).join("\n") + "\n";
    checkText("gate.txt", r.norm(out));
  });
});
