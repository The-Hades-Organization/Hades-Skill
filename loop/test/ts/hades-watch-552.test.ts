// 5.5.2: `hades watch --next` não reemite DONE de registro já tratado (`agent done` feito ou unidade arquivada).
// Cada caso põe um agente com QUESTION aberta ao lado, para o `--next` sair na primeira varredura (sem espera fixa).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL } from "./lib/rig";
import { shaCitavel } from "./sha-citavel";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const orch = `${r.T}/work/example__monorepo/orchestration/agents`, skillOrch = `${r.T}/work/_skill/orchestration/agents`;

function unit(dir: string, name: string, state: string, files: Record<string, string>): void {
  const worktree = `${r.T}/wt552/${name}`;
  mkdirSync(`${worktree}/.design-sync-reports`, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(`${worktree}/.design-sync-reports/${file}`, body);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}.json`, JSON.stringify({ name, mode: "skill", role: "impl", worktree, state, branch: `skill/${name}` }));
}
const watch = (stateDir: string): string => {
  rmSync(stateDir, { recursive: true, force: true });
  return r.X(["timeout", "30", BUN, `${SKILL}/src/cli.ts`, "watch", "--next", "1"], { cwd: r.C, merge: true, env: { HADES_WATCH_STATE: stateDir } }).out;
};
const ping = (dir: string) => unit(dir, "w552-ping", "working", { "questions.md": "## Q1 — x\ny\n" });
const donos = (out: string) => out.split("\n").filter((l) => l.startsWith("DONE"));

describe("hades-watch: DONE de registro já tratado não volta", () => {
  test("registro done com report DONE: sem DONE", () => {
    ping(skillOrch); unit(skillOrch, "w552-feito", "done", { "report.md": "STATUS: DONE\n" });
    expect(donos(watch(`${r.T}/st-a`))).toEqual([]);
  });
  test("registro archived com report DONE: sem DONE", () => {
    unit(skillOrch, "w552-arq", "archived", { "report.md": "STATUS: DONE\n" });
    expect(donos(watch(`${r.T}/st-b`))).toEqual([]);
  });
  test("o mesmo nome done em _skill e ainda working no registro do projeto: sem DONE", () => {
    unit(orch, "w552-feito", "working", { "report.md": "STATUS: DONE\n" });
    expect(donos(watch(`${r.T}/st-c`))).toEqual([]);
    rmSync(`${orch}/w552-feito.json`);
  });
  test("registro working com report DONE com commit e prova: um DONE (o evento legítimo continua)", () => {
    unit(skillOrch, "w552-vivo", "working", {});
    const worktree = `${r.T}/wt552/w552-vivo`;
    r.X(["git", "init", "-q", "-b", "main", worktree]);
    r.git(worktree, "commit", "-q", "--allow-empty", "-m", "entrega");
    const sha = shaCitavel(worktree, (d, ...a) => r.git(d, ...a).out.trim());
    writeFileSync(`${worktree}/.design-sync-reports/report.md`, `STATUS: DONE\nCommit \`${sha}\`.\n- \`bun test x.test.ts\` passou.\n`);
    expect(donos(watch(`${r.T}/st-d`))).toEqual(["DONE w552-vivo"]);
  });
});
