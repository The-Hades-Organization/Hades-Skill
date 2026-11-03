// 5.5.2: duplicações deixadas pela install-ts voltam a ter uma só fonte: PLUGIN_FILES (install-copy) e REPO (version-check).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL } from "./lib/rig";
import { detectAccess } from "../../../src/lib/contrib-access";
import { REPO } from "../../../src/lib/version-check";

const fonte = (rel: string) => readFileSync(join(SKILL, rel), "utf8");

describe("fonte única", () => {
  test("cerberus-limiar usa o PLUGIN_FILES do install, sem lista própria", () => {
    const src = fonte("src/lib/cerberus-limiar.ts");
    expect(src).toContain('PLUGIN_FILES } from "./install-copy.ts"');
    expect(src).not.toMatch(/PLUGIN_FILES\s*=/);
  });
  test("skill-release usa o PLUGIN_FILES do install, sem regex própria dos arquivos do plugin", () => {
    const src = fonte("src/commands/skill-release.ts");
    expect(src).toContain("PLUGIN_FILES");
    expect(src).not.toContain("onboard\\.tsv");
  });
  test("contrib-access reaproveita o REPO do version-check, sem regex de dono/nome própria", () => {
    expect(fonte("src/lib/contrib-access.ts")).not.toContain("A-Za-z0-9._-]+\\/");
    const aceita = detectAccess("dono/nome", { hasGh: false, run: () => { throw new Error("não chama"); } });
    const recusa = detectAccess("sem-barra", { hasGh: true, run: () => { throw new Error("não chama"); } });
    expect([aceita, recusa].map((a) => a.kind === "sem-acesso" ? a.reason : a.kind)).toEqual(["sem-gh", "repo-invalido"]);
    expect([REPO.test("dono/nome"), REPO.test("sem-barra")]).toEqual([true, false]);
  });
});
