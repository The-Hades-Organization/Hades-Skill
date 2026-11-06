// CTX-OVER: o hook só pede ao agente que estacione; o `hades watch` confere depois. Uma linha por limiar cruzado (o teto do
// papel e cada HADES_CTX_REWARN acima dele), não a cada passada; voltar ao teto rearma; agente já estacionado não repete.
// `watch <seg>` sem --next, com prazo curto: várias passadas na mesma execução provam que não repete a cada turno.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const NAME = "w-ctxover", WT = `${r.T}/wt-over/${NAME}`, STATE = `${r.T}/st-over`;
const PROJECT = `${r.H}/.claude/projects/${WT.replace(/[/.]/g, "-")}`;
const SCAN_SECONDS = 3;
const TEST_TIMEOUT_MS = 40_000;

mkdirSync(`${WT}/.design-sync-reports`, { recursive: true });
mkdirSync(PROJECT, { recursive: true });
mkdirSync(`${r.T}/work/_skill/orchestration/agents`, { recursive: true });
writeFileSync(`${r.T}/work/_skill/orchestration/agents/${NAME}.json`, JSON.stringify({ name: NAME, mode: "skill", role: "impl", branch: `skill/${NAME}`, worktree: WT, state: "working", promptedAt: "2026-01-02T00:00:00Z" }));

/** Transcrito com `tokens` de contexto; roda o watch por alguns segundos (várias passadas) e devolve as linhas CTX-OVER. */
function scan(tokens: number): string[] {
  writeFileSync(`${PROJECT}/s.jsonl`, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`);
  const run = r.X(["timeout", String(SCAN_SECONDS), BUN, `${SKILL}/src/cli.ts`, "watch", "1"], { cwd: r.C, merge: true, env: { ...r.ae, HADES_WATCH_STATE: STATE } });
  return run.out.split("\n").filter((l) => l.startsWith("CTX-OVER"));
}

describe("hades watch: CTX-OVER", () => {
  test("acima do teto do papel (impl, 200k): uma linha com o usado e o teto, mesmo em várias passadas", () => {
    expect(scan(210_000)).toEqual([`CTX-OVER ${NAME} 210k 200k`]);
  }, TEST_TIMEOUT_MS);

  test("segue no mesmo limiar: nada novo; cruzou o seguinte (+50k): avisa de novo, uma vez", () => {
    expect(scan(220_000)).toEqual([]);
    expect(scan(260_000)).toEqual([`CTX-OVER ${NAME} 260k 200k`]);
    expect(scan(270_000)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test("voltou ao teto (sessão limpa) e estourou de novo: avisa de novo", () => {
    expect(scan(40_000)).toEqual([]);
    expect(scan(205_000)).toEqual([`CTX-OVER ${NAME} 205k 200k`]);
  }, TEST_TIMEOUT_MS);

  test("agente que já estacionou nesta rodada (handoff PARKED depois do prompt) não volta a avisar", () => {
    const handoff = `${WT}/.design-sync-reports/handoff.md`;
    writeFileSync(handoff, "STATUS: PARKED — teto de contexto\n");
    utimesSync(handoff, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
    expect(scan(40_000)).toEqual([]);
    expect(scan(300_000)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
