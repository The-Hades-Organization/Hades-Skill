// Teto do SKILL.md (issue #61): ele entra inteiro em cada /hades; passou de 20 KB, o texto vai para reference/.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL } from "./lib/rig";
import { TETO_SKILL_BYTES, checaTeto } from "../../../src/lib/skill-teto";

describe("teto do SKILL.md", () => {
  test("o teto é 20480 bytes", () => { expect(TETO_SKILL_BYTES).toBe(20480); });
  test("o SKILL.md real está abaixo do teto", () => {
    const r = checaTeto(join(SKILL, "SKILL.md"));
    expect(r.acima, `SKILL.md tem ${r.bytes} bytes, teto ${r.limite}: mova o detalhe para reference/`).toBe(false);
  });
  test("fixture acima do teto reprova; no limite exato passa", () => {
    const d = mkdtempSync(join(tmpdir(), "teto-"));
    writeFileSync(join(d, "grande.md"), "x".repeat(TETO_SKILL_BYTES + 1));
    writeFileSync(join(d, "exato.md"), "x".repeat(TETO_SKILL_BYTES));
    expect(checaTeto(join(d, "grande.md")).acima).toBe(true);
    expect(checaTeto(join(d, "exato.md")).acima).toBe(false);
  });
  test("limite menor aplicado ao SKILL.md real reprova", () => { expect(checaTeto(join(SKILL, "SKILL.md"), 1000).acima).toBe(true); });
});
