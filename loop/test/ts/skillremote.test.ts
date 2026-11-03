// Grupo skillremote: o git da skill pode ter remote; skill-new passa, mas a branch da unidade nunca faz push sozinha.
import { afterAll, describe, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { Rig, checkText } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("skillremote", () => {
  test("agent-skillremote.txt", () => {
    const S3 = `${r.T}/skill-r`, bare = `${r.T}/remotes/hades/core.git`, wt = `${r.H}/.claude/hades/skill-dev/rem`;
    mkdirSync(S3, { recursive: true }); r.must(r.X(["git", "init", "-q", "--bare", bare]));
    r.skillCopy(S3); r.must(r.git(S3, "remote", "add", "origin", bare));
    const p = r.hadesIn(S3, ["agent", "skill-new", "rem", "--port", "21288"], { cwd: r.C, merge: true, env: r.ae });
    let out = `$ hades agent skill-new rem --port 21288\n${p.out}rc=${p.rc}\n`;
    out += `pushRemote=${r.git(S3, "config", "branch.skill/rem.pushRemote").out.trim()}\n`;
    out += `push rc=${r.git(wt, "push", "-q").rc}\n`;
    out += `refs no remote: ${r.git(bare, "for-each-ref").out.split("\n").filter(Boolean).length}\n`;
    checkText("agent-skillremote.txt", r.norm(out.replace(/\b[0-9a-f]{7,40}\b/g, "<SHA>")));
  });
});
