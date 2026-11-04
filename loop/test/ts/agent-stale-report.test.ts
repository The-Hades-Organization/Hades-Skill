// `hades agent prompt|answer|phase`: aviso do report.md de rodada anterior e o --no-commit da fase (herdr falso).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rig } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const orch = join(r.T, "work/example__monorepo/orchestration");
const bin = join(r.T, "herdr-stale");
const REPORTS = ".design-sync-reports";
mkdirSync(join(orch, "agents"), { recursive: true });
mkdirSync(bin, { recursive: true });

const worktree = (name: string): string => join(r.T, `wt-${name}`);
// o agente existe no herdr com o cwd na worktree; o resto responde vazio
writeFileSync(join(bin, "herdr"), `#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  'agent list') echo '{"result":{"agents":[{"name":"stale","pane_id":"w1:p1","agent_status":"idle","foreground_cwd":"${worktree("stale")}"}]}}' ;;
  *) echo '{}' ;;
esac
`);
chmodSync(join(bin, "herdr"), 0o755);

const register = (name: string, extra: Record<string, unknown> = {}): void => {
  mkdirSync(join(worktree(name), REPORTS), { recursive: true });
  writeFileSync(join(orch, "agents", `${name}.json`), JSON.stringify({ name, mode: "deliver", role: "impl", worktree: worktree(name), pane: "w1:p1", state: "working", ...extra }));
  writeFileSync(join(worktree(name), REPORTS, "questions.md"), "## Q1 — porta\n");
};
const setReport = (name: string, head: string): void => writeFileSync(join(worktree(name), REPORTS, "report.md"), `${head}\n`);
const run = (args: string[]): string => r.agent(args, { env: { PATH: `${bin}:${r.env0.PATH}` }, merge: true }).out;
const record = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(orch, "agents", `${name}.json`), "utf8"));

describe("agent: aviso do report de rodada anterior", () => {
  test("dado report.md com STATUS: DONE, então prompt e answer avisam para renomear, sem bloquear", () => {
    register("stale");
    setReport("stale", "STATUS: DONE");
    const prompted = run(["prompt", "stale", "oi"]);
    expect(prompted).toContain("AVISO");
    expect(prompted).toContain("report-<n>.md");
    expect(prompted).toContain("tarefa enviada a stale");
    expect(run(["answer", "stale", "Q1", "21271"])).toContain("report-<n>.md");
  });

  test("dado report.md sem STATUS: DONE, então o prompt não avisa", () => {
    register("stale");
    setReport("stale", "STATUS: ACTIVE");
    expect(run(["prompt", "stale", "oi"])).not.toContain("report-<n>.md");
  });
});

describe("agent: phase --no-commit", () => {
  test("dado a flag, então o registro grava noCommit; phase sem a flag reseta; resume mantém", () => {
    register("stale");
    run(["phase", "stale", "spec", "--no-commit"]);
    expect(record("stale")).toMatchObject({ phase: "spec", noCommit: true });
    run(["resume", "stale"]);
    expect(record("stale").noCommit).toBe(true);
    run(["phase", "stale", "impl"]);
    expect(record("stale")).toMatchObject({ phase: "impl", noCommit: false });
  }, 30_000);

  test("dado --no-commit no resume, então recusa (a dispensa é da fase)", () => {
    register("stale");
    expect(run(["resume", "stale", "--no-commit"])).toContain("--no-commit é da fase");
  });
});
