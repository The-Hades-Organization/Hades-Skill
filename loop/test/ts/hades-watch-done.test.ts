// `hades watch`: DONE sai uma vez por prompt do agente e só com commit e prova no report (as guardas da Vigília).
// reference/loop/orchestrate.md. Cada caso roda o vigia (sem --next) por alguns segundos e conta as linhas DONE.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL } from "./lib/rig";
import { shaCitavel } from "./sha-citavel";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const orch = `${r.T}/work/_skill/orchestration/agents`;
const gitOut = (d: string, ...a: string[]): string => r.git(d, ...a).out.trim();

/** Worktree git com um commit; devolve o sha citável. */
function repo(name: string): { worktree: string; sha: string } {
  const worktree = `${r.T}/wtdone/${name}`;
  mkdirSync(`${worktree}/.design-sync-reports`, { recursive: true });
  r.X(["git", "init", "-q", "-b", "main", worktree]);
  writeFileSync(`${worktree}/a.txt`, "a\n");
  r.git(worktree, "add", "-A");
  r.git(worktree, "commit", "-qm", "base");
  return { worktree, sha: shaCitavel(worktree, gitOut) };
}
const register = (name: string, worktree: string, promptedAt: string): void => {
  mkdirSync(orch, { recursive: true });
  writeFileSync(`${orch}/${name}.json`, JSON.stringify({ name, mode: "skill", role: "impl", worktree, state: "working", branch: "main", promptedAt }));
};
const report = (worktree: string, body: string): void => writeFileSync(`${worktree}/.design-sync-reports/report.md`, `STATUS: DONE\n${body}`);
const COM_PROVA = "- Teste: `bun test x.test.ts` passou, 0 fail.\n";
/** Os DONE do agente `unit` (o registro da skill é compartilhado entre os casos: os outros agentes não contam). */
const watch = (state: string, unit: string): string[] =>
  r.X(["timeout", "5", BUN, `${SKILL}/src/cli.ts`, "watch", "1"], { cwd: r.C, merge: true, env: { HADES_WATCH_STATE: state } })
    .out.split("\n").filter((l) => l.startsWith(`DONE ${unit}`));

describe("hades watch: DONE", () => {
  test("dado report DONE com commit na branch e prova, então um DONE", () => {
    const { worktree, sha } = repo("d-ok");
    register("d-ok", worktree, "2026-01-02T00:00:00Z");
    report(worktree, `Commit \`${sha}\` na branch.\n${COM_PROVA}`);
    expect(watch(`${r.T}/st-ok`, "d-ok")).toEqual(["DONE d-ok"]);
  }, 15_000);

  test("dado o mesmo prompt e o report reescrito (mtime novo), então o DONE não volta", () => {
    const { worktree, sha } = repo("d-uma");
    register("d-uma", worktree, "2026-01-02T00:00:00Z");
    report(worktree, `Commit \`${sha}\` na branch.\n${COM_PROVA}`);
    const state = `${r.T}/st-uma`;
    expect(watch(state, "d-uma")).toEqual(["DONE d-uma"]);
    appendFileSync(`${worktree}/.design-sync-reports/report.md`, "- Ajuste de redação.\n");
    const later = new Date(Date.now() + 60_000);
    utimesSync(`${worktree}/.design-sync-reports/report.md`, later, later);
    expect(watch(state, "d-uma")).toEqual([]);
  }, 20_000);

  test("dado um prompt novo do agente, então o DONE do ciclo novo sai", () => {
    const { worktree, sha } = repo("d-prompt");
    register("d-prompt", worktree, "2026-01-02T00:00:00Z");
    report(worktree, `Commit \`${sha}\` na branch.\n${COM_PROVA}`);
    const state = `${r.T}/st-prompt`;
    expect(watch(state, "d-prompt")).toEqual(["DONE d-prompt"]);
    register("d-prompt", worktree, "2026-01-03T00:00:00Z");
    expect(watch(state, "d-prompt")).toEqual(["DONE d-prompt"]);
  }, 20_000);

  test("dado report DONE sem citar commit, então nenhum DONE", () => {
    const { worktree } = repo("d-sem-commit");
    register("d-sem-commit", worktree, "2026-01-02T00:00:00Z");
    report(worktree, COM_PROVA);
    expect(watch(`${r.T}/st-sem-commit`, "d-sem-commit")).toEqual([]);
  }, 15_000);

  test("dado commit citado que não está na branch, então nenhum DONE", () => {
    const { worktree } = repo("d-falso");
    register("d-falso", worktree, "2026-01-02T00:00:00Z");
    report(worktree, `Commit \`deadbee1\` na branch.\n${COM_PROVA}`);
    expect(watch(`${r.T}/st-falso`, "d-falso")).toEqual([]);
  }, 15_000);

  test("dado commit sem prova no report, então nenhum DONE; e com a prova acrescentada, o DONE sai", () => {
    const { worktree, sha } = repo("d-sem-prova");
    register("d-sem-prova", worktree, "2026-01-02T00:00:00Z");
    report(worktree, `Commit \`${sha}\` na branch.\n`);
    const state = `${r.T}/st-sem-prova`;
    expect(watch(state, "d-sem-prova")).toEqual([]);
    appendFileSync(`${worktree}/.design-sync-reports/report.md`, COM_PROVA);
    expect(watch(state, "d-sem-prova")).toEqual(["DONE d-sem-prova"]);
  }, 20_000);

  test("dado teste que falhou na prova, então não conta como prova", () => {
    const { worktree, sha } = repo("d-falhou");
    register("d-falhou", worktree, "2026-01-02T00:00:00Z");
    report(worktree, `Commit \`${sha}\` na branch.\n- Teste: \`bun test x.test.ts\` falhou, 2 fail.\n`);
    expect(watch(`${r.T}/st-falhou`, "d-falhou")).toEqual([]);
  }, 15_000);
});
