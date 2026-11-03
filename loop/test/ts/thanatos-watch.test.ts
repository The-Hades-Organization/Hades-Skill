// Thanatos no `hades watch`: ao ver MERGED de PR de fix de produção, sugere o post-mortem, e só pela regra do perfil
// (thanatos.fixBranchPattern/fixLabels). gh e herdr falsos; fim a fim pela CLI.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL, STUBS, lines } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

const CLONE = `${r.T}/clone/fixer`;
r.mkrepo("acme/fixer", CLONE);
const BIN = `${r.T}/tw-bin`, WT = `${r.T}/tw-wt/ag`, ROOT = `${r.T}/work`;
mkdirSync(BIN, { recursive: true });
mkdirSync(`${WT}/.design-sync-reports`, { recursive: true });
mkdirSync(`${ROOT}/acme__fixer/orchestration/agents`, { recursive: true });
writeFileSync(`${ROOT}/acme__fixer/orchestration/agents/ag.json`, JSON.stringify({ name: "ag", mode: "deliver", role: "impl", worktree: WT, state: "working", pr: 5, branch: "fix/x" }));
writeFileSync(`${BIN}/gh`, `#!/usr/bin/env bash
case "$1 $2" in
  'api graphql') echo '{"data":{"repository":{"pullRequest":{"state":"MERGED","reviews":{"nodes":[]},"comments":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}' ;;
  'pr view') echo "$TW_PRVIEW" ;;
  *) exit 1 ;;
esac
`);
chmodSync(`${BIN}/gh`, 0o755);

function profile(thanatos?: Record<string, unknown>): void {
  mkdirSync(`${r.T}/packs/fixer`, { recursive: true });
  writeFileSync(`${r.T}/packs/fixer/profile.json`, JSON.stringify({ schema: "hades.profile/1", name: "fixer", identity: { repo: "acme/fixer" }, flow: { kind: "pr", base: "develop" }, ...(thanatos ? { thanatos } : {}) }));
}
let round = 0;
function watch(prView: Record<string, unknown>): string[] {
  round += 1;
  const state = `${r.T}/tw-state-${round}`;
  mkdirSync(state, { recursive: true });
  const o = r.X(["timeout", "60", BUN, `${SKILL}/src/cli.ts`, "watch", "--next", "1"], { cwd: CLONE, merge: true, env: {
    PATH: `${BIN}:${STUBS}:${r.env0.PATH}`, HADES_WORK_ROOT: ROOT, HADES_WATCH_STATE: state, TW_PRVIEW: JSON.stringify(prView),
    FAKE_HERDR_AGENTS: '{"result":{"agents":[]}}',
  } });
  return lines(o.out).filter((l) => /^(MERGED|THANATOS) /.test(l));
}

describe("thanatos: sugestão no watch", () => {
  test("branch de fix casa a regra do perfil: MERGED e depois THANATOS com o comando", () => {
    profile({ fixBranchPattern: "^fix/" });
    expect(watch({ headRefName: "fix/x", labels: [] })).toEqual(["MERGED ag #5", "THANATOS ag #5 fix de produção mergeado: hades thanatos new 5"]);
  });
  test("label de fix também casa", () => {
    profile({ fixLabels: ["incident"] });
    expect(watch({ headRefName: "feat/y", labels: [{ name: "Incident" }] })).toHaveLength(2);
  });
  test("PR que não casa a regra só tem o MERGED", () => {
    profile({ fixBranchPattern: "^hotfix/" });
    expect(watch({ headRefName: "feat/y", labels: [] })).toEqual(["MERGED ag #5"]);
  });
  test("perfil sem a chave thanatos: nunca sugere", () => {
    profile();
    expect(watch({ headRefName: "fix/x", labels: [{ name: "incident" }] })).toEqual(["MERGED ag #5"]);
  });
  test("post-mortem da PR já existe: não sugere de novo", () => {
    profile({ fixBranchPattern: "^fix/" });
    mkdirSync(`${ROOT}/acme__fixer/postmortems`, { recursive: true });
    writeFileSync(`${ROOT}/acme__fixer/postmortems/pr-5.json`, "{}");
    expect(watch({ headRefName: "fix/x", labels: [] })).toEqual(["MERGED ag #5"]);
    rmSync(`${ROOT}/acme__fixer/postmortems`, { recursive: true, force: true });
  });
});
