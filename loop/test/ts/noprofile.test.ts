// Grupo noprofile: repo sem perfil — coletor e agente recusam e apontam /hades project init; o hook só aplica as regras da máquina.
import { afterAll, describe, test } from "bun:test";
import { cpSync, mkdirSync } from "node:fs";
import { FX, Rig, checkText } from "./lib/rig";
import { hookCases } from "./lib/hook";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("noprofile", () => {
  const w = `${r.T}/work/other__plain`;
  mkdirSync(w, { recursive: true }); cpSync(`${FX}/collector/state`, `${w}/state`, { recursive: true });

  test("collector-noprofile.txt", () => {
    const p = r.hades(["pr-loop-state", "--json"], { cwd: r.P, env: { FAKE_GH_LOG: `${r.T}/gh-np.log`, FAKE_GH_DIR: `${FX}/collector` } });
    checkText("collector-noprofile.txt", r.norm(`$ hades pr-loop-state --json\n${p.err}rc=${p.rc}\n`));
  });
  test("agent-noprofile.txt", () => {
    const args = "new np-a --role impl --branch svc/feat/SOFTWARE-5-x --card SOFTWARE-5 --dry-run";
    const a = r.agent(args.split(" "), { cwd: r.P });
    checkText("agent-noprofile.txt", r.norm(`$ hades agent ${args}\n${a.out}rc=${a.rc}\n`));
  });
  test("hook-project.txt", () => {
    const d = r.hookDirs(); mkdirSync(`${r.T}/stacks`, { recursive: true }); cpSync(`${FX}/stacks`, `${r.T}/stacks`, { recursive: true });
    checkText("hook-project.txt", r.norm(hookCases(r, `${FX}/hook/cases-project.tsv`, d)));
  });
});
