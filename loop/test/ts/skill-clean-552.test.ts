// 5.5.2: skill-clean arquiva o .md avulso de .design-sync-reports e, ao recusar por arquivo novo fora do git, lista os arquivos.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Rig } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const S = `${r.T}/skill-sc`, sd = `${r.H}/.claude/hades/skill-dev`;
const agent = (args: string[]) => r.agentIn(S, args);

describe("skill-clean 5.5.2", () => {
  r.skillCopy(S);

  test("arquivo novo fora do git: a recusa lista os arquivos", () => {
    agent(["skill-new", "sc1", "--port", "21291"]);
    writeFileSync(`${sd}/sc1/avulso.txt`, "x\n");
    writeFileSync(`${sd}/sc1/outro.ts`, "x\n");
    const out = agent(["skill-clean", "sc1"]).out;
    expect(out).toContain("recusado: worktree com arquivo novo fora do git: avulso.txt outro.ts");
    expect(existsSync(`${sd}/sc1`), "a unidade fica").toBe(true);
  });

  test(".md avulso de .design-sync-reports vai para _arquivo", () => {
    rmSync(`${sd}/sc1/avulso.txt`); rmSync(`${sd}/sc1/outro.ts`);
    writeFileSync(`${sd}/sc1/.design-sync-reports/analise-extra.md`, "achados\n");
    writeFileSync(`${sd}/sc1/.design-sync-reports/report.md`, "STATUS: DONE\n");
    const out = agent(["skill-clean", "sc1"]).out;
    expect(out).toContain("arquiva");
    expect(readFileSync(`${sd}/_arquivo/sc1/analise-extra.md`, "utf8")).toBe("achados\n");
    expect(existsSync(`${sd}/_arquivo/sc1/report.md`)).toBe(true);
  });
});
