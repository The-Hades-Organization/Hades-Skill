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
const register = (name: string, worktree: string, promptedAt: string, noCommit = false): void => {
  mkdirSync(orch, { recursive: true });
  writeFileSync(`${orch}/${name}.json`, JSON.stringify({ name, mode: "skill", role: "impl", worktree, state: "working", branch: "main", promptedAt, noCommit }));
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

const REPORT = (worktree: string): string => `${worktree}/.design-sync-reports/report.md`;
const touch = (file: string, offsetMs: number): void => {
  const when = new Date(Date.now() + offsetMs);
  utimesSync(file, when, when);
};
/** As linhas DONE e DONE-HELD do agente `unit`. */
const events = (state: string, unit: string): string[] =>
  r.X(["timeout", "5", BUN, `${SKILL}/src/cli.ts`, "watch", "1"], { cwd: r.C, merge: true, env: { HADES_WATCH_STATE: state } })
    .out.split("\n").filter((l) => l.startsWith(`DONE ${unit}`) || l.startsWith(`DONE-HELD ${unit}`));

describe("hades watch: report de rodada anterior", () => {
  test("dado report DONE mais velho que o prompt, então nada; reescrito depois do prompt, então DONE", () => {
    const { worktree, sha } = repo("v-velho");
    report(worktree, `Commit \`${sha}\` na branch.\n${COM_PROVA}`);
    touch(REPORT(worktree), -3_600_000);
    register("v-velho", worktree, new Date().toISOString().slice(0, 19) + "Z");
    const state = `${r.T}/st-velho`;
    expect(events(state, "v-velho")).toEqual([]);
    touch(REPORT(worktree), 60_000);
    expect(events(state, "v-velho")).toEqual(["DONE v-velho"]);
  }, 20_000);

  test("dado report reescrito no mesmo prompt, então o DONE não reemite", () => {
    const { worktree, sha } = repo("v-mesmo");
    register("v-mesmo", worktree, "2026-01-02T00:00:00Z");
    report(worktree, `Commit \`${sha}\` na branch.\n${COM_PROVA}`);
    const state = `${r.T}/st-mesmo`;
    expect(events(state, "v-mesmo")).toEqual(["DONE v-mesmo"]);
    touch(REPORT(worktree), 60_000);
    expect(events(state, "v-mesmo")).toEqual([]);
  }, 20_000);
});

describe("hades watch: DONE-HELD", () => {
  test("dado DONE sem prova, então DONE-HELD sem-prova uma vez; reescrito sem prova não reemite; com prova sai o DONE", () => {
    const { worktree, sha } = repo("h-prova");
    register("h-prova", worktree, "2026-01-02T00:00:00Z");
    report(worktree, `Commit \`${sha}\` na branch.\n`);
    const state = `${r.T}/st-h-prova`;
    expect(events(state, "h-prova")).toEqual(["DONE-HELD h-prova sem-prova"]);
    expect(events(state, "h-prova")).toEqual([]);
    appendFileSync(REPORT(worktree), "- Ajuste de redação.\n");
    touch(REPORT(worktree), 60_000);
    expect(events(state, "h-prova")).toEqual([]);
    appendFileSync(REPORT(worktree), COM_PROVA);
    touch(REPORT(worktree), 120_000);
    expect(events(state, "h-prova")).toEqual(["DONE h-prova"]);
  }, 30_000);

  test("dado prova sem commit citado, então DONE-HELD sem-commit", () => {
    const { worktree } = repo("h-commit");
    register("h-commit", worktree, "2026-01-02T00:00:00Z");
    report(worktree, COM_PROVA);
    expect(events(`${r.T}/st-h-commit`, "h-commit")).toEqual(["DONE-HELD h-commit sem-commit"]);
  }, 15_000);

  test("dado commit citado fora da branch, então DONE-HELD commit-fora-da-branch", () => {
    const { worktree } = repo("h-fora");
    register("h-fora", worktree, "2026-01-02T00:00:00Z");
    report(worktree, `Commit \`deadbee1\` na branch.\n${COM_PROVA}`);
    expect(events(`${r.T}/st-h-fora`, "h-fora")).toEqual(["DONE-HELD h-fora commit-fora-da-branch"]);
  }, 15_000);

  test("dado fase --no-commit com prova e sem commit, então DONE; sem prova, DONE-HELD sem-prova", () => {
    const ok = repo("h-nc-ok");
    register("h-nc-ok", ok.worktree, "2026-01-02T00:00:00Z", true);
    report(ok.worktree, COM_PROVA);
    expect(events(`${r.T}/st-nc-ok`, "h-nc-ok")).toEqual(["DONE h-nc-ok"]);
    const sem = repo("h-nc-sem");
    register("h-nc-sem", sem.worktree, "2026-01-02T00:00:00Z", true);
    report(sem.worktree, "Sem nada a provar.\n");
    expect(events(`${r.T}/st-nc-sem`, "h-nc-sem")).toEqual(["DONE-HELD h-nc-sem sem-prova"]);
  }, 20_000);
});
