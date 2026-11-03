// /hades (commands/hades.md): versionado na skill; o install.sh o instala sem sobrescrever o arquivo do usuário que diverge.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const SRC = `${SKILL}/commands/hades.md`;
const wt = `${r.T}/wt-cmd`;
r.must(r.git(r.C, "worktree", "add", "-q", "-b", "cmd/wt", wt));
const install = (data: string, dir: string) =>
  r.X(["bash", `${SKILL}/kit/install.sh`], { merge: true, env: { HADES_WT: wt, HADES_DATA: data, SKIP_SYSTEMD: "1", SKIP_DOCTOR: "1", SKIP_WORKTREE: "1", HADES_CLAUDE_COMMANDS: dir } }).all;

describe("slash-command /hades", () => {
  test("a fonte versionada não cita script removido", () => {
    expect(readFileSync(SRC, "utf8")).not.toMatch(/\.py\b|hades-[a-z]+\.sh|python3/);
  });

  test("instala quando não existe", () => {
    const dir = `${r.T}/cmds-novo`;
    expect(install(`${r.T}/d-cmd1`, dir)).toContain("slash-command /hades instalado");
    expect(readFileSync(`${dir}/hades.md`, "utf8")).toBe(readFileSync(SRC, "utf8"));
  });

  test("é idempotente: igual não reinstala nem avisa", () => {
    const dir = `${r.T}/cmds-igual`;
    install(`${r.T}/d-cmd2`, dir);
    const again = install(`${r.T}/d-cmd2`, dir);
    expect(again).not.toContain("slash-command /hades instalado");
    expect(again).not.toContain("difere");
  });

  test("arquivo do usuário que diverge é mantido, com aviso", () => {
    const dir = `${r.T}/cmds-user`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/hades.md`, "meu comando\n");
    expect(install(`${r.T}/d-cmd3`, dir)).toContain("difere do da skill");
    expect(readFileSync(`${dir}/hades.md`, "utf8")).toBe("meu comando\n");
  });

  test("instalação descartável sem HADES_CLAUDE_COMMANDS não toca ~/.claude/commands", () => {
    r.X(["bash", `${SKILL}/kit/install.sh`], { merge: true, env: { HADES_WT: wt, HADES_DATA: `${r.T}/d-cmd4`, SKIP_SYSTEMD: "1", SKIP_DOCTOR: "1", SKIP_WORKTREE: "1" } });
    expect(existsSync(`${r.H}/.claude/commands/hades.md`)).toBe(false);
  });
});
