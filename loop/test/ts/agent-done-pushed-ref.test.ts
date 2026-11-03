// `hades agent done`: a referência do "nada sem push". O `agent new` tira o upstream da branch (prepWorktree); o push
// sem `-u` deixa a branch publicada sem upstream, e a auditoria tem de conferir contra o origin/<branch>.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushedRef } from "../../../src/commands/agent-run.ts";

const T = mkdtempSync(join(tmpdir(), "hades-done-ref-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

let n = 0;
function clone(): string {
  const base = join(T, `r${n++}`);
  const remote = `${base}-remote.git`;
  const dir = `${base}-clone`;
  Bun.spawnSync(["git", "init", "--bare", "-q", "-b", "develop", remote]);
  Bun.spawnSync(["git", "clone", "-q", remote, dir], { stderr: "pipe" });
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "a");
  git(dir, "push", "-q", "-u", "origin", "develop");
  git(dir, "switch", "-q", "-c", "feat/x", "--track", "origin/develop");
  git(dir, "branch", "--unset-upstream");
  return dir;
}

describe("pushedRef: contra o que o done confere o push", () => {
  test("dado branch publicada sem -u (o upstream que o agent new tirou), então vale o origin/<branch> e nada fica à frente", () => {
    const dir = clone();
    git(dir, "push", "-q", "origin", "feat/x");
    expect(pushedRef(dir)).toBe("refs/remotes/origin/feat/x");
    expect(git(dir, "rev-list", "--count", `${pushedRef(dir)}..HEAD`)).toBe("0");
  });
  test("dado commit novo depois do push sem -u, então o done vê o commit sem push", () => {
    const dir = clone();
    git(dir, "push", "-q", "origin", "feat/x");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "b");
    expect(git(dir, "rev-list", "--count", `${pushedRef(dir)}..HEAD`)).toBe("1");
  });
  test("dado branch nunca publicada, então não há referência (o done barra)", () => {
    expect(pushedRef(clone())).toBe("");
  });
  test("dado push com -u, então vale o upstream", () => {
    const dir = clone();
    git(dir, "push", "-q", "-u", "origin", "feat/x");
    expect(pushedRef(dir)).toBe("@{upstream}");
  });
});
