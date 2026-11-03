// skill-clean: --force-data vale só para a unidade nomeada (nunca para as que o --merged pega), e os logs numerados das
// provas repetidas (install2.log, check3.log) são descartáveis sem --force-data. reference/loop/orchestrate.md §Fechar.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DISPOSABLE_DATA, isDisposableData } from "../../../src/commands/agent-skill";
import { Rig } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const S = `${r.T}/skill-fd`, sd = `${r.H}/.claude/hades/skill-dev`;
const agent = (args: string[]) => r.agentIn(S, args);

/** Unidade sem commit próprio e com o registro `done`, que o --merged pega. */
function unitaryDone(name: string, port: string): void {
  agent(["skill-new", name, "--port", port]);
  const agents = `${r.T}/work/_skill/orchestration/agents`;
  const file = `${agents}/${name}.json`;
  const reg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...reg, state: "done" }));
}
const exportOf = (name: string): string => { mkdirSync(`${sd}/_data/${name}`, { recursive: true }); return `${sd}/_data/${name}/export.json`; };

describe("skill-clean --force-data", () => {
  r.skillCopy(S);

  test("dado --merged --force-data, então a unidade com dado alheio que não foi nomeada fica", () => {
    unitaryDone("fd1", "21281");
    unitaryDone("fd2", "21282");
    writeFileSync(exportOf("fd1"), "{}\n");
    writeFileSync(exportOf("fd2"), "{}\n");
    const out = agent(["skill-clean", "--merged", "--force-data"]).out;
    expect(out).toContain("recusado:");
    expect(existsSync(`${sd}/_data/fd1/export.json`), "fd1 não foi nomeada").toBe(true);
    expect(existsSync(`${sd}/_data/fd2/export.json`), "fd2 não foi nomeada").toBe(true);
  });

  test("dado --force-data com a unidade nomeada, então só ela é apagada", () => {
    const out = agent(["skill-clean", "fd1", "--force-data"]).out;
    expect(out).toContain(`remove ${sd}/_data/fd1`);
    expect(existsSync(`${sd}/_data/fd1`)).toBe(false);
    expect(existsSync(`${sd}/_data/fd2/export.json`), "fd2 segue").toBe(true);
  });

  test("dado --merged e a unidade nomeada junto, então --force-data vale só para a nomeada", () => {
    unitaryDone("fd3", "21283");
    writeFileSync(exportOf("fd3"), "{}\n");
    agent(["skill-clean", "--merged", "fd2", "--force-data"]);
    expect(existsSync(`${sd}/_data/fd2`), "fd2 foi nomeada").toBe(false);
    expect(existsSync(`${sd}/_data/fd3/export.json`), "fd3 veio só do --merged").toBe(true);
  });

  test("dado install2.log e check10.log em _data, então não pedem --force-data", () => {
    unitaryDone("fd4", "21284");
    mkdirSync(`${sd}/_data/fd4`, { recursive: true });
    for (const log of ["install.log", "install2.log", "check10.log"]) writeFileSync(`${sd}/_data/fd4/${log}`, "x\n");
    const out = agent(["skill-clean", "fd4"]).out;
    expect(out).not.toContain("recusado");
    expect(existsSync(`${sd}/_data/fd4`)).toBe(false);
  });
});

describe("isDisposableData", () => {
  test.each(["install3.log", "check12.log"])("%s é descartável", (name) => expect(isDisposableData(name)).toBe(true));
  test.each(["install-notes.log", "check.log.bak", "installx.log", "export.json", "install.log2"])("%s não é", (name) => expect(isDisposableData(name)).toBe(false));
  test.each(DISPOSABLE_DATA)("%s da lista fixa é descartável", (name) => expect(isDisposableData(name)).toBe(true));
});
