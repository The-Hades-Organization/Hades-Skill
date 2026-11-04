// `hades watch`: filtro por dono, flags de escopo e "já visto" por observador (reference/loop/orchestrate.md §4).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inScope, observerKey, parseWatchArgs, WatchUsageError } from "../../../src/lib/watch-scope";
import { BUN, Rig, SKILL } from "./lib/rig";
import { shaCitavel } from "./sha-citavel";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const orch = `${r.T}/work/_skill/orchestration/agents`;
const PANE_A = { session: "default", pane: "w1:p1" };
const PANE_B = { session: "default", pane: "w1:p2" };

function agent(name: string, orchestrator?: { session: string; pane: string }): void {
  const worktree = `${r.T}/wtowner/${name}`;
  mkdirSync(`${worktree}/.design-sync-reports`, { recursive: true });
  r.X(["git", "init", "-q", "-b", "main", worktree]);
  writeFileSync(`${worktree}/a.txt`, "a\n");
  r.git(worktree, "add", "-A");
  r.git(worktree, "commit", "-qm", "base");
  const sha = shaCitavel(worktree, (d, ...a) => r.git(d, ...a).out.trim());
  writeFileSync(`${worktree}/.design-sync-reports/report.md`, `STATUS: DONE\nCommit \`${sha}\`.\n- \`bun test x.test.ts\` passou.\n`);
  mkdirSync(orch, { recursive: true });
  writeFileSync(`${orch}/${name}.json`, JSON.stringify({
    name, mode: "skill", role: "impl", worktree, state: "working", branch: "main", promptedAt: "2026-01-02T00:00:00Z", ...(orchestrator ? { orchestrator } : {}),
  }));
}

/** Um `hades watch` de teste: as linhas DONE dos agentes pedidos, com o pane e o estado do observador. */
function watch(state: string, pane: string | undefined, units: string[], flags: string[] = []): string[] {
  const env: Record<string, string> = { HADES_WATCH_STATE: state, HADES_HERDR_SESSION: "default", ...(pane ? { HERDR_PANE_ID: pane } : {}) };
  return r.X(["timeout", "5", BUN, `${SKILL}/src/cli.ts`, "watch", ...flags, "1"], { cwd: r.C, merge: true, env })
    .out.split("\n").filter((l) => units.some((u) => l === `DONE ${u}`));
}

describe("hades watch: escopo e observador", () => {
  test("dado dois observadores com donos diferentes, então só o dono do agente emite o DONE", () => {
    agent("o-a", PANE_A);
    expect(watch(`${r.T}/st-b1`, "w1:p2", ["o-a"])).toEqual([]);
    expect(watch(`${r.T}/st-a1`, "w1:p1", ["o-a"])).toEqual(["DONE o-a"]);
  }, 30_000);

  test("dado agente sem orchestrator, então os dois observadores emitem", () => {
    agent("o-livre");
    expect(watch(`${r.T}/st-a2`, "w1:p1", ["o-livre"])).toEqual(["DONE o-livre"]);
    expect(watch(`${r.T}/st-b2`, "w1:p2", ["o-livre"])).toEqual(["DONE o-livre"]);
  }, 30_000);

  test("dado --all, então emite o agente de outro dono", () => {
    agent("o-b", PANE_B);
    expect(watch(`${r.T}/st-all`, "w1:p1", ["o-b"], ["--all"])).toEqual(["DONE o-b"]);
  }, 30_000);

  test("dado o visto de um observador, então o evento continua novo para o outro", () => {
    agent("o-par", PANE_A);
    const shared = `${r.T}/st-par`;
    expect(watch(shared, "w1:p1", ["o-par"], ["--agent", "o-par"])).toEqual(["DONE o-par"]);
    expect(watch(shared, "w1:p1", ["o-par"], ["--agent", "o-par"])).toEqual([]);
    expect(watch(shared, "w1:p1", ["o-par"])).toEqual(["DONE o-par"]);
    expect(existsSync(`${shared}/by`)).toBe(true);
  }, 40_000);

  test("dado o visto compartilhado antigo, então o observador novo herda e não reemite", () => {
    agent("o-herda", PANE_A);
    const shared = `${r.T}/st-herda`;
    expect(watch(shared, undefined, ["o-herda"])).toEqual(["DONE o-herda"]);
    expect(watch(shared, "w1:p1", ["o-herda"])).toEqual([]);
  }, 30_000);

  test("dado flag desconhecida, então sai 2", () => {
    const o = r.X([BUN, `${SKILL}/src/cli.ts`, "watch", "--nada"], { cwd: r.C, merge: true, env: { HADES_WATCH_STATE: `${r.T}/st-flag` } });
    expect(o.rc).toBe(2);
  });
});

describe("watch-scope: regras puras", () => {
  const env = { HERDR_PANE_ID: "w1:p1", HADES_HERDR_SESSION: "default" };
  test("dado pane do herdr sem flag, então o escopo é o dono do pane", () => {
    expect(parseWatchArgs(["--next", "30"], env)).toEqual({ next: true, everySeconds: 30, scope: { all: false, agents: [], orchestrator: PANE_A } });
  });
  test("dado fora de pane sem flag, então vê todos", () => {
    expect(parseWatchArgs(["--next"], {}).scope).toEqual({ all: true, agents: [] });
  });
  test("dado --agent repetido e --agents, então a união ordenada e sem dono implícito", () => {
    expect(parseWatchArgs(["--agent", "b", "--agents", "c,a,b"], env).scope).toEqual({ all: false, agents: ["a", "b", "c"] });
  });
  test("dado --orchestrator, então vence o pane atual", () => {
    expect(parseWatchArgs(["--orchestrator", "s2:w1:p9"], env).scope.orchestrator).toEqual({ session: "s2", pane: "w1:p9" });
  });
  test("dado --all com filtro, nome inválido ou orquestrador malformado, então erro de uso", () => {
    expect(() => parseWatchArgs(["--all", "--agent", "a"], env)).toThrow(WatchUsageError);
    expect(() => parseWatchArgs(["--agent", "../x"], env)).toThrow(WatchUsageError);
    expect(() => parseWatchArgs(["--orchestrator", "w1:p1x"], env)).toThrow(WatchUsageError);
    expect(() => parseWatchArgs(["--agent"], env)).toThrow(WatchUsageError);
  });
  test("dado o escopo do dono, então registro sem dono (ou malformado) entra e o de outro pane não", () => {
    const scope = parseWatchArgs([], env).scope;
    expect(inScope(scope, { name: "x", orchestrator: PANE_A })).toBe(true);
    expect(inScope(scope, { name: "x", orchestrator: PANE_B })).toBe(false);
    expect(inScope(scope, { name: "x", orchestrator: { session: "outra", pane: "w1:p1" } })).toBe(false);
    expect(inScope(scope, { name: "x" })).toBe(true);
    expect(inScope(scope, { name: "x", orchestrator: "lixo" })).toBe(true);
  });
  test("dado --agent, então o nome decide", () => {
    const scope = parseWatchArgs(["--agent", "a"], env).scope;
    expect(inScope(scope, { name: "a", orchestrator: PANE_B })).toBe(true);
    expect(inScope(scope, { name: "b" })).toBe(false);
  });
  test("dado a chave do observador, então --all usa a pasta compartilhada e o resto uma própria e estável", () => {
    expect(observerKey({ all: true, agents: [] })).toBeUndefined();
    expect(observerKey(parseWatchArgs([], env).scope)).toBe("o-default-w1_p1");
    expect(observerKey({ all: false, agents: ["a", "b"] })).toBe("a-a+b");
  });
});

describe("hades agent reassign-orchestrator", () => {
  const cli = (args: string[], pane?: string) =>
    r.X([BUN, `${SKILL}/src/cli.ts`, "agent", "reassign-orchestrator", ...args], {
      cwd: r.C, merge: true, env: { HADES_HERDR_SESSION: "default", ...(pane ? { HERDR_PANE_ID: pane } : {}) },
    });
  const orchestratorOf = (name: string) => (JSON.parse(readFileSync(`${orch}/${name}.json`, "utf8")) as { orchestrator?: unknown }).orchestrator;

  test("dado nomes, então só eles apontam para o pane atual", () => {
    agent("re-a", PANE_A);
    agent("re-b", PANE_A);
    expect(cli(["re-a"], "w1:p7").rc).toBe(0);
    expect(orchestratorOf("re-a")).toEqual({ session: "default", pane: "w1:p7" });
    expect(orchestratorOf("re-b")).toEqual(PANE_A);
  });
  test("dado --all, então todo agente ativo aponta para o pane atual", () => {
    agent("re-c", PANE_A);
    expect(cli(["--all"], "w1:p8").rc).toBe(0);
    expect(orchestratorOf("re-c")).toEqual({ session: "default", pane: "w1:p8" });
  });
  test("dado fora de pane ou nome desconhecido, então erro e nada gravado", () => {
    agent("re-d", PANE_A);
    expect(cli(["re-d"]).rc).not.toBe(0);
    expect(cli(["nao-existe"], "w1:p9").rc).not.toBe(0);
    expect(orchestratorOf("re-d")).toEqual(PANE_A);
  });
});
