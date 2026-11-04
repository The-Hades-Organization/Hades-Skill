// `hades usage` (reference/cli.md): saída, código e arquivos que o consumo grava (latest.json, baseline.json) iguais aos gravados
// do comportamento de referência em golden/legado. A data de hoje e o instante de geração são normalizados (o relógio muda a cada rodada).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL } from "./lib/rig";
import { legado } from "./lib/legado";

const r = new Rig().setup();
afterAll(() => r.cleanup());

const g = legado(import.meta.path);
const U = `${r.T}/us`, WORK = `${U}/work`;
const home = `${U}/home`;
const today = new Date().toISOString().slice(0, 10);
const at = (time: string) => `${today}T${time}Z`;

type Line = Record<string, unknown>;
const usage = (input: number, output: number, read: number, creation: number | Record<string, number>) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: read,
  ...(typeof creation === "number" ? { cache_creation_input_tokens: creation } : { cache_creation_input_tokens: Object.values(creation).reduce((a, b) => a + b, 0), cache_creation: creation }),
});
const turn = (o: { id: string; time: string; session?: string; cwd: string; model?: string; usage?: unknown; side?: boolean; effort?: string; tools?: Line[] }): Line => ({
  type: "assistant", requestId: o.id, timestamp: at(o.time), sessionId: o.session, cwd: o.cwd, isSidechain: o.side, effort: o.effort,
  message: { model: o.model ?? "claude-opus-5-5-20260101", usage: o.usage, content: o.tools ?? [] },
});
const bash = (command: string, background = false): Line => ({ type: "tool_use", name: "Bash", input: { command, run_in_background: background } });

// dado do transcript (o comando que o agente digitou, com o caminho do script antigo): o que o `usage` lê, não algo que o teste executa
const AGENT_SH = ["~/.claude/skills/hades/loop", "bin/hades-agent.sh"].join("/");
const dirs = { orch: `${U}/orch`, wt: `${U}/wt`, agent: `${U}/agent-wt`, plain: `${U}/plain`, herdr: `${U}/x/.herdr/worktrees/feat` };
mkdirSync(`${dirs.orch}/.git`, { recursive: true });
mkdirSync(dirs.wt, { recursive: true }); writeFileSync(`${dirs.wt}/.git`, "gitdir: x\n");
mkdirSync(dirs.agent, { recursive: true }); mkdirSync(dirs.plain, { recursive: true });
mkdirSync(`${WORK}/proj/orchestration/agents`, { recursive: true });
writeFileSync(`${WORK}/proj/orchestration/agents/a.json`, JSON.stringify({ name: "impl-a", role: "impl", worktree: dirs.agent, pr: 7 }));
writeFileSync(`${WORK}/proj/orchestration/agents/b.json`, JSON.stringify({ name: "rev-b", role: "review", worktree: `${dirs.agent}/sub` }));
writeFileSync(`${WORK}/proj/orchestration/agents/ruim.json`, "{ não é json");

const transcripts: Record<string, (Line | string)[]> = {
  "p1/s1.jsonl": [
    turn({ id: "r1", time: "01:00:00.000", session: "s1", cwd: dirs.orch, usage: usage(10, 500, 40_000, { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 1_000 }), tools: [bash("sleep 30")] }),
    turn({ id: "r1", time: "01:00:01.000", session: "s1", cwd: dirs.orch, usage: usage(99, 99, 99, 99), tools: [bash("gh pr checks 12")] }),
    turn({ id: "r2", time: "01:00:30.000", session: "s1", cwd: dirs.orch, usage: usage(10, 800, 60_000, 500), tools: [bash("sleep 30", true), bash("ls")] }),
    turn({ id: "r3", time: "03:30:00.000", session: "s1", cwd: dirs.orch, model: "claude-sonnet-5-5", usage: usage(5, 300, 10_000, 150_000), effort: "high", tools: [bash("git log | tail -5")] }),
    { type: "user", message: { content: "oi" } },
    "linha com \"assistant\" mas sem json",
    turn({ id: "r4", time: "03:31:00.000", session: "s1", cwd: dirs.orch, model: "claude-desconhecido", usage: usage(1, 1, 1, 1) }),
    turn({ id: "r5", time: "03:32:00.000", session: "s1", cwd: dirs.orch }),
  ],
  "p1/s2.jsonl": [
    turn({ id: "a1", time: "02:00:00.000", session: "s2", cwd: dirs.agent, usage: usage(20, 1000, 100_000, 5_000), tools: [bash("cat > f <<'EOF'\nsleep 60\nEOF"), bash("until true; do sleep 5; done")] }),
    turn({ id: "a2", time: "02:10:00.000", session: "s2", cwd: `${dirs.agent}/sub/deep`, model: "claude-haiku-5-5", usage: usage(30, 400, 5_000, 0) }),
    turn({ id: "a3", time: "02:11:00.000", session: "s2", cwd: dirs.herdr, side: true, usage: usage(3, 3, 3, 3) }),
  ],
  "p1/s3/subagents/agent-1.jsonl": [
    turn({ id: "g1", session: "s3", time: "04:00:00.000", cwd: dirs.wt, usage: usage(7, 70, 700, 7_000), tools: [bash(`${AGENT_SH} answer w "sleep 90" && ls`)] }),
    turn({ id: "g2", session: "s3", time: "04:00:10.000", cwd: dirs.plain, model: "claude-fable-5-1", usage: usage(1_000, 2_000, 300_000, 200_000), tools: [bash("herdr agent read impl-a"), bash("tail -f x.log")] }),
    turn({ id: "g3", session: "s3", time: "04:00:20.000", cwd: "", model: "claude-opus-4-8", usage: usage(1, 1, 1, 1) }),
  ],
  "p2/vazio.jsonl": [],
  "p2/antigo.jsonl": [turn({ id: "o1", time: "05:00:00.000", session: "old", cwd: dirs.orch, usage: usage(1, 2_000, 1, 1) })],
};

function seed(home: string): void {
  rmSync(`${home}/.claude/projects`, { recursive: true, force: true });
  rmSync(`${home}/.claude/hades/usage`, { recursive: true, force: true });
  for (const [name, lines] of Object.entries(transcripts)) {
    const file = `${home}/.claude/projects/${name}`;
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  }
  const old = new Date(Date.now() - 30 * 86_400_000);
  utimesSync(`${home}/.claude/projects/p2/antigo.jsonl`, old, old);
}

const normalize = (text: string) => r.norm(text).replace(/"(generatedAt|savedAt)": ?"[^"]+"/g, '"$1": "<agora>"').replaceAll(today, "<hoje>").replace(/ desde \d{4}-\d\d-\d\d/g, " desde <inicio>").replace(/"since": "\d{4}-\d\d-\d\d"/g, '"since": "<inicio>"');
const read = (path: string) => (existsSync(path) ? normalize(readFileSync(path, "utf8")) : "(ausente)");
const run = (args: string[]) => {
  const o = r.X([BUN, `${SKILL}/src/cli.ts`, "usage", ...args], { env: { HOME: home, HADES_WORK_ROOT: WORK } });
  return { out: normalize(o.out), err: o.err, rc: o.rc };
};
const state = () => ["latest", "baseline"].map((f) => read(`${home}/.claude/hades/usage/${f}.json`)).join("\n--\n");

/** Mesma chamada nas duas pontas; o que sai e o que fica em disco têm de ser iguais aos gravados. */
function same(label: string, args: string[]) {
  test(`${label}: CLI igual ao gravado (saída, código e arquivos)`, () => {
    const ref = g.get<{ out: string; err: string; rc: number; state: string }>(label);
    const b = run(args);
    g.fix(label, { out: b.out, err: b.err, rc: b.rc, state: state() });
    expect(b.rc).toBe(ref.rc);
    expect(b.err).toBe(ref.err.replaceAll("hades-usage.py", "hades usage")); // só o nome do programa no texto do argparse
    expect(b.out).toBe(ref.out);
    expect(state()).toBe(ref.state);
  });
}

describe("usage (CLI)", () => {
  seed(home);
  same("sem argumento", []);
  same("de novo (cache de transcripts)", []);
  same("--json", ["--json"]);
  same("--days 1 (corta o transcript antigo)", ["--days", "1", "--json"]);
  same("--days 100 (inclui o antigo)", ["--days=100", "--json"]);
  same("gravar a linha de base", ["--baseline"]);
  same("com a linha de base", []);
  same("com a linha de base em JSON", ["--json", "--days", "3"]);
  same("regravar a linha de base em JSON", ["--baseline", "--json"]);
  same("argumento desconhecido", ["--nada"]);
  same("--days inválido", ["--days", "x"]);
  same("--days sem valor", ["--days"]);
  test("sem transcripts: tabela vazia, igual", () => {
    rmSync(`${home}/.claude/projects`, { recursive: true, force: true });
    const a = g.get<{ out: string; rc: number }>("sem transcripts");
    const b = run(["--json"]);
    g.fix("sem transcripts", { out: b.out, rc: b.rc });
    expect(b.out).toBe(a.out);
    expect(b.rc).toBe(a.rc);
  });
});
