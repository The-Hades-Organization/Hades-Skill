// Grupo collector: coletor de PRs sobre JSON gravado (gh falso). Saída contra golden/collector*.
import { afterAll, describe, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { FX, Rig, checkJson, checkText } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("collector", () => {
  r.stateFixture();
  const run = (extra: string[]) => r.hades(["pr-loop-state", ...extra], { cwd: r.C, env: { FAKE_GH_DIR: `${FX}/collector` } });
  const j = run(["--json"]);
  const errFile = `${j.err}rc=${j.rc}\n`;

  test("collector.json", () => checkJson("collector.json", r.norm(j.out)));
  test("collector.txt", () => checkText("collector.txt", r.norm(r.hades(["pr-loop-state"], { cwd: r.C, merge: true, env: { FAKE_GH_DIR: `${FX}/collector` } }).all)));
  test("collector-pr.txt", () => {
    const p = run(["--json", "--pr", "103", "--pr", "999"]);
    const o = JSON.parse(p.out) as { prs: { number: number }[]; requestedMissing: unknown };
    const body = `${p.err}rc=${p.rc}\n${JSON.stringify({ prs: o.prs.map((x) => x.number), requestedMissing: o.requestedMissing })}\n${errFile}`;
    checkText("collector-pr.txt", body);
  });
  test("collector-gh.log", () => {
    const log = `${r.T}/gh.log`;
    checkText("collector-gh.log", r.norm(existsSync(log) ? readFileSync(log, "utf8") : ""));
  });
});
