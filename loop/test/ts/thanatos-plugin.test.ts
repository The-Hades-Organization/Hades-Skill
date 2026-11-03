// Thanatos: o script do comando `thanatos-source` (env/commands/) é código que a Hades executa, então tem de aparecer na prévia
// do `plugins add` e no diff do `plugins update`, e o Limiar o trata como executável (src/lib/plugins.ts RUNS, RUN_PATHS).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { runs } from "../../../src/lib/plugins";
import { BUN, SKILL, Rig } from "./lib/rig";

const r = new Rig();
afterAll(() => r.cleanup());

const PROFILE = JSON.stringify({ schema: "hades.profile/1", name: "pt", identity: { repo: "acme/pt" }, flow: { kind: "pr", base: "main" }, env: { pack: "env" } });
const SCRIPT = (v: string) => `#!/usr/bin/env bash\necho '{"v":1,"events":[],"metrics":[]}' # ${v}\n`;

function put(dir: string, rel: string, text: string): void {
  mkdirSync(`${dir}/${rel.split("/").slice(0, -1).join("/") || "."}`, { recursive: true });
  writeFileSync(`${dir}/${rel}`, text);
}

describe("thanatos: comando do plugin na prévia", () => {
  test("add: commands/*.sh e commands/*.ts entram na lista do que executa, com sha256 e texto", () => {
    const pack = `${r.T}/pack-runs`;
    put(pack, "profile.json", PROFILE);
    put(pack, "env/commands/thanatos-source.sh", SCRIPT("a"));
    put(pack, "env/commands/outra.ts", "export {};\n");
    put(pack, "env/plugin.json", JSON.stringify({ commands: [{ name: "thanatos-source", script: "commands/thanatos-source.sh" }] }));
    const found = runs(pack, `${pack}/env`, { left: 1_000_000 });
    expect(found.files.map((f) => f.path)).toEqual(["env/commands/outra.ts", "env/commands/thanatos-source.sh"]);
    expect(found.files[1]).toMatchObject({ text: SCRIPT("a"), cut: false, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(found.other).toEqual([]);
  });

  test("update: script novo e script alterado em env/commands aparecem no diff da prévia", () => {
    const remote = `${r.T}/rm/pt.git`, work = `${r.T}/src-pt`, packs = `${r.T}/packs-up`, data = `${r.T}/data-up`;
    r.must(r.X(["git", "init", "-q", "--bare", "-b", "main", remote]));
    r.must(r.X(["git", "init", "-q", "-b", "main", work]));
    put(work, "profile.json", PROFILE);
    put(work, "env/commands/thanatos-source.sh", SCRIPT("v1"));
    for (const c of [["add", "-A"], ["commit", "-qm", "v1"], ["push", "-q", remote, "main"]]) r.must(r.git(work, ...c));
    mkdirSync(packs, { recursive: true });
    r.must(r.X(["git", "clone", "-q", remote, `${packs}/pt`]));
    r.must(r.git(`${packs}/pt`, "branch", "--set-upstream-to=origin/main", "main"));
    put(work, "env/commands/thanatos-source.sh", SCRIPT("v2"));
    put(work, "env/commands/novo.sh", SCRIPT("novo"));
    for (const c of [["add", "-A"], ["commit", "-qm", "v2"], ["push", "-q", remote, "main"]]) r.must(r.git(work, ...c));
    const o = r.X([BUN, `${SKILL}/src/cli.ts`, "plugins", "update", "pt", "--json"], { cwd: r.T, env: { HADES_PACKS_ROOT: packs, HADES_DATA: data, HADES_WT: r.C, HADES_WORK_ROOT: `${r.T}/w`, HADES_PLUGIN_GIT_TIMEOUT: "30" } });
    const doc = JSON.parse(o.out) as { runsChanged: boolean; diff: string };
    expect(doc.runsChanged).toBe(true);
    expect(doc.diff).toContain("env/commands/thanatos-source.sh");
    expect(doc.diff).toContain("# v2");
    expect(doc.diff).toContain("env/commands/novo.sh");
  });
});
