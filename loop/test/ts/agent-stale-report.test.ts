// `hades agent prompt|answer|phase`: aviso do report.md de rodada anterior e o --no-commit da fase (herdr falso).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rig } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const orch = join(r.T, "work/example__monorepo/orchestration");
const bin = join(r.T, "herdr-stale");
const PROMPTS = join(r.T, "prompts.log");
const REPORTS = ".design-sync-reports";
mkdirSync(join(orch, "agents"), { recursive: true });
mkdirSync(bin, { recursive: true });

const worktree = (name: string): string => join(r.T, `wt-${name}`);
// o agente existe no herdr com o cwd na worktree; o resto responde vazio
writeFileSync(join(bin, "herdr"), `#!/usr/bin/env bash
[ "\${1:-} \${2:-}" = 'agent prompt' ] && printf '%s\\n' "\${4:-}" >> "${PROMPTS}"
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

describe("agent: resume sem fase no registro não rotula pelo papel", () => {
  const sentPrompt = (): string => (readFileSync(PROMPTS, "utf8").trim().split("\n").filter((l) => l.startsWith("Sessão nova")).at(-1) ?? "");
  const handoff = (name: string, head: string): void => writeFileSync(join(worktree(name), REPORTS, "handoff.md"), `${head}\nresto\n`);

  test("dado registro sem phase e role impl, então o resume não cita fase e o registro segue sem phase", () => {
    register("stale");
    run(["resume", "stale"]);
    expect(sentPrompt()).toStartWith("Sessão nova, retomando do handoff.");
    expect(sentPrompt()).not.toContain('fase "impl"');
    expect("phase" in record("stale")).toBe(false);
    expect(record("stale")).toMatchObject({ resumes: 1, state: "working" });
  }, 30_000);

  test("dado handoff com fase `spec` no cabeçalho, então o prompt cita spec e o registro grava spec", () => {
    register("stale");
    handoff("stale", "# Handoff — stale, fase `spec`");
    run(["resume", "stale"]);
    expect(sentPrompt()).toContain('Sessão nova, fase "spec".');
    expect(record("stale").phase).toBe("spec");
  }, 30_000);

  test("dado handoff sem o cabeçalho de fase, então vale o mesmo que sem handoff", () => {
    register("stale");
    handoff("stale", "STATUS: PARKED — pausa");
    run(["resume", "stale"]);
    expect(sentPrompt()).not.toContain("fase \"");
    expect("phase" in record("stale")).toBe(false);
  }, 30_000);

  test("dado phase no registro, então ela vence o cabeçalho do handoff", () => {
    register("stale", { phase: "review" });
    handoff("stale", "# Handoff — stale, fase `spec`");
    run(["resume", "stale"]);
    expect(sentPrompt()).toContain('fase "review"');
  }, 30_000);
});

describe("agent: prompt --phase", () => {
  test("dado --phase no primeiro prompt, então o registro grava a fase e o texto segue sendo o do dono", () => {
    register("stale");
    expect(run(["prompt", "stale", "--phase", "spec", "faça só a spec"])).toContain("tarefa enviada a stale");
    expect(record("stale").phase).toBe("spec");
    expect(readFileSync(PROMPTS, "utf8")).toContain("faça só a spec");
  });

  test("dado prompt sem --phase, então o registro não ganha phase", () => {
    register("stale");
    run(["prompt", "stale", "oi"]);
    expect("phase" in record("stale")).toBe(false);
  });

  test("dado --phase sem valor, então recusa", () => {
    register("stale");
    expect(run(["prompt", "stale", "--phase"])).toContain("faltou a fase");
  });
});

describe("agent: done grava o encerramento no diário (some a permissão pendente do Argos)", () => {
  // unidade da skill: o registro e o diário ficam em _skill, e o done não exige push nem PR
  const skillAgents = join(r.T, "work/_skill/orchestration/agents");
  const events = (name: string): { source: string; kind: string }[] => {
    try { return readFileSync(join(r.T, "work/_skill/journal", `${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  const ended = (name: string): boolean => events(name).some((e) => e.source === "orch" && e.kind === "agent.end");

  test("dado unidade da skill com report DONE, então o done grava orch agent.end depois de marcar o registro done", () => {
    mkdirSync(skillAgents, { recursive: true });
    mkdirSync(join(worktree("stale"), REPORTS), { recursive: true });
    writeFileSync(join(skillAgents, "stale.json"), JSON.stringify({ name: "stale", mode: "skill", role: "impl", worktree: worktree("stale"), state: "working" }));
    setReport("stale", "STATUS: DONE");
    expect(ended("stale")).toBe(false);
    const o = run(["done", "stale", "--keep-pane"]);
    expect(o).toContain("encerrado");
    expect(JSON.parse(readFileSync(join(skillAgents, "stale.json"), "utf8")).state).toBe("done");
    expect(ended("stale")).toBe(true);
  }, 30_000);
});

describe("agent: resume de sessão encerrada ao concluir", () => {
  const AVISO = "foi encerrado ao concluir";
  // o bloco do done acima registra o mesmo nome em _skill: aqui só vale o registro do projeto
  beforeEach(() => rmSync(join(r.T, "work/_skill/orchestration/agents/stale.json"), { force: true }));

  test("dado agente fechado ao concluir, então o resume avisa do agente novo e segue (aviso, não recusa)", () => {
    register("stale", { state: "done", closedOnDone: true, doneAt: "2026-01-02T00:00:00Z" });
    const saida = run(["resume", "stale"]);
    expect(saida).toContain(`AVISO: stale ${AVISO}`);
    expect(saida).toContain("agente novo na mesma worktree");
    expect(saida).toContain("handoff.md/report.md");
    expect(saida).toContain("stale: sessão limpa");
    expect(record("stale")).toMatchObject({ state: "working" });
  }, 30_000);

  test("dado agente encerrado à mão pelo agent done (state done, sem closedOnDone), então o resume avisa igual", () => {
    register("stale", { state: "done" });
    expect(run(["resume", "stale"])).toContain(AVISO);
  }, 30_000);

  test("dado agente ainda em andamento, então o resume não avisa", () => {
    register("stale");
    expect(run(["resume", "stale"])).not.toContain(AVISO);
  }, 30_000);

  test("dado agente concluído, então a fase nova não avisa (o aviso é do resume)", () => {
    register("stale", { state: "done", closedOnDone: true });
    expect(run(["phase", "stale", "impl"])).not.toContain(AVISO);
  }, 30_000);
});
