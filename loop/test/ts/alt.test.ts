// Grupo alt: outro perfil no mesmo repo (base main, ci em draft e em develop, sem bot, card do github, token por variável).
import { afterAll, describe, test } from "bun:test";
import { cpSync, readFileSync } from "node:fs";
import { FX, Rig, checkJson, checkText } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("alt", () => {
  r.stateFixture();
  cpSync(`${FX}/packs-alt`, `${r.T}/packs-alt`, { recursive: true });
  const ALT = { HADES_PACKS_ROOT: `${r.T}/packs-alt`, ZN_TOKEN: "tok-zn", FAKE_GH_LOG: `${r.T}/gh-alt.log`, FAKE_GH_DIR: `${FX}/collector` };
  const coll = (extra: string[], merge = false) => r.hades(["pr-loop-state", ...extra], { cwd: r.C, env: ALT, merge });

  test("collector-alt.json", () => {
    type Pr = { number: number; state: string; stacked: unknown; ciEligible: unknown; claudeEligible: unknown; specIds: unknown; cardIds: unknown; threads?: { ruleCode?: string }[]; topLevel?: { ruleCode?: string }[] };
    const o = JSON.parse(coll(["--json"]).out) as { project: unknown; warnings: { kind: string }[]; prs: Pr[] };
    const n = (v: unknown) => v ?? null;
    const view = {
      project: n(o.project), warnings: o.warnings.map((w) => w.kind),
      prs: o.prs.map((p) => ({
        number: p.number, state: p.state, stacked: n(p.stacked), ciEligible: n(p.ciEligible), claudeEligible: n(p.claudeEligible),
        specIds: n(p.specIds), cardIds: n(p.cardIds),
        codes: [...(p.threads ?? []), ...(p.topLevel ?? [])].map((t) => t.ruleCode).filter(Boolean),
      })),
    };
    checkJson("collector-alt.json", r.norm(JSON.stringify(view)));
  });
  test("collector-alt.txt", () => {
    const flags = coll([], true).all.split("\n").filter((l) => l.startsWith("flags:")).map((l) => l + "\n").join("");
    const log = [...new Set(readFileSync(`${r.T}/gh-alt.log`, "utf8").split("\n").filter(Boolean))].sort().map((l) => l + "\n").join("");
    checkText("collector-alt.txt", r.norm(flags + log));
  });
  test("agent-alt.txt", () => {
    let out = "";
    for (const args of ["new alt-a --role impl --branch feat/ZN-12-x --card ZN-12 --dry-run", "new alt-b --role impl --card ZN-1",
      "new alt-c --branch feat/x", "new alt-d --branch feat/ZN-NOVO --new-card x --tags a"]) {
      const p = r.agent(args.split(" "), { env: { HADES_PACKS_ROOT: `${r.T}/packs-alt` } });
      out += `$ hades agent ${args}\n${p.out}rc=${p.rc}\n`;
    }
    checkText("agent-alt.txt", r.norm(out));
  });
});
