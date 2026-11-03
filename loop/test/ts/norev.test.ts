// Grupo norev: flow.reviewRequired=false — awaiting-review só com review pedido (reviewRequests); true/ausente = padrão.
import { afterAll, describe, test } from "bun:test";
import { cpSync, renameSync } from "node:fs";
import { FX, Rig, checkText, readJson, writeJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("norev", () => {
  test("collector-norev.txt", () => {
    const NR = `${r.T}/packs-norev`, F = `${r.T}/collector-norev`;
    r.stateFixture(); cpSync(`${r.T}/packs`, NR, { recursive: true }); cpSync(`${FX}/collector`, F, { recursive: true });
    const prof = `${NR}/example-monorepo/profile.json`;
    const pj = readJson(prof); pj.flow = { ...pj.flow, reviewRequired: false }; writeJson(prof, pj);
    const states = (env: Record<string, string>, pick: (n: number) => boolean) => {
      const p = r.hades(["pr-loop-state", "--json"], { cwd: r.C, env: { ...env, FAKE_GH_DIR: F } });
      return (JSON.parse(p.out) as { prs: { number: number; state: string }[] }).prs.filter((x) => pick(x.number)).map((x) => `${x.number} ${x.state}\n`).join("");
    };
    const pack = { HADES_PACKS_ROOT: NR };
    let out = `validate rc=${r.hades(["project", "validate", prof]).rc}\n`;
    out += "sem review pedido\n" + states(pack, (n) => n === 110 || n === 112);
    const g = readJson(`${F}/graphql.json`);
    for (const n of g.data.search.nodes) if (n.number === 110) n.reviewRequests = { totalCount: 1 };
    writeJson(`${F}/g.json`, g); renameSync(`${F}/g.json`, `${F}/graphql.json`);
    out += "110 com review pedido\n" + states(pack, (n) => n === 110);
    out += "padrão (reviewRequired ausente), 110 com review pedido\n" + states({}, (n) => n === 110);
    checkText("collector-norev.txt", out);
  });
});
