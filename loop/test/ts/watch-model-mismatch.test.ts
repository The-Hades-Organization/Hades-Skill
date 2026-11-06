// MODEL-MISMATCH: o `hades watch` compara o modelo da sessão atual do agente com o HADES_MODEL_<PAPEL> e avisa uma vez
// por sessão, no primeiro turno divergente; sessão da escalada e sessão no modelo certo não avisam.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const NAME = "w-modelo", WT = `${r.T}/wt-modelo/${NAME}`, STATE = `${r.T}/st-modelo`;
const PROJECT = `${r.H}/.claude/projects/${WT.replace(/[/.]/g, "-")}`;
const REGISTRY = `${r.T}/work/_skill/orchestration/agents/${NAME}.json`;
const SCAN_SECONDS = 3;
const TEST_TIMEOUT_MS = 40_000;

mkdirSync(`${WT}/.design-sync-reports`, { recursive: true });
mkdirSync(PROJECT, { recursive: true });
mkdirSync(`${r.T}/work/_skill/orchestration/agents`, { recursive: true });

const register = (extra: Record<string, unknown> = {}) =>
  writeFileSync(REGISTRY, JSON.stringify({ name: NAME, mode: "skill", role: "impl", branch: `skill/${NAME}`, worktree: WT, state: "working", promptedAt: "2026-01-02T00:00:00Z", ...extra }));
const turn = (model: string, timestamp: string) => JSON.stringify({ type: "assistant", timestamp, message: { model, usage: { input_tokens: 1 } } });

/** Transcrição `<sessao>.jsonl`; roda o watch por alguns segundos (várias passadas) e devolve as linhas MODEL-MISMATCH. */
function scan(session: string, models: [string, string][]): string[] {
  writeFileSync(`${PROJECT}/${session}.jsonl`, `${models.map(([model, at]) => turn(model, at)).join("\n")}\n`);
  const run = r.X(["timeout", String(SCAN_SECONDS), BUN, `${SKILL}/src/cli.ts`, "watch", "1"], { cwd: r.C, merge: true, env: { ...r.ae, HADES_MODEL_IMPL: "claude-sonnet-5-5", HADES_WATCH_STATE: STATE } });
  return run.out.split("\n").filter((l) => l.startsWith("MODEL-MISMATCH"));
}

describe("hades watch: MODEL-MISMATCH", () => {
  test("turno em opus com o papel em sonnet: uma linha, mesmo em várias passadas", () => {
    register();
    expect(scan("s1", [["claude-sonnet-5-5", "2026-11-01T10:00:00Z"], ["claude-opus-5-5", "2026-11-01T10:01:00Z"]])).toEqual([`MODEL-MISMATCH ${NAME} opus-5-5 sonnet-5-5`]);
  }, TEST_TIMEOUT_MS);

  test("a mesma sessão numa rodada seguinte não repete", () => {
    expect(scan("s1", [["claude-sonnet-5-5", "2026-11-01T10:00:00Z"], ["claude-opus-5-5", "2026-11-01T10:01:00Z"], ["claude-opus-5-5", "2026-11-01T10:02:00Z"]])).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test("sessão nova que também diverge: avisa de novo, uma vez", () => {
    expect(scan("s2", [["claude-opus-5-5", "2026-11-02T10:00:00Z"]])).toEqual([`MODEL-MISMATCH ${NAME} opus-5-5 sonnet-5-5`]);
  }, TEST_TIMEOUT_MS);

  test("sessão no modelo configurado: nada", () => {
    expect(scan("s3", [["claude-sonnet-5-5", "2026-11-03T10:00:00Z"]])).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test("sessão aberta pela escalada da Hades (escalatedAt anterior a ela): nada", () => {
    register({ escalated: "claude-opus-5-5", escalatedAt: "2026-11-04T09:00:00Z" });
    expect(scan("s4", [["claude-opus-5-5", "2026-11-04T10:00:00Z"]])).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
