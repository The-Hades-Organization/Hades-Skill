// Sugestão de /compact do hook (HADES_CTX_COMPACT_AT): uma vez por sessão, abaixo do teto do papel, e some se o teto não a comporta.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, type HookEnv } from "../../../src/lib/guard-hook";
import { compactAtOf, DEFAULT_COMPACT_AT } from "../../../src/lib/ctx-cap";

const T = mkdtempSync(join(tmpdir(), "hades-compact-"));
const HOME = join(T, "home");
const DATA = join(T, "data");
const WORK = join(T, "work");
const AGENTS = join(WORK, "proj", "orchestration", "agents");
const CLONE = join(T, "clone");
const savedEnv = { HOME: process.env.HOME, HADES_WORK_ROOT: process.env.HADES_WORK_ROOT, HADES_DATA: process.env.HADES_DATA };
const WT = join(T, "wt", "unidade");

const writeConfig = (lines: string[]): void => writeFileSync(join(DATA, "config.tsv"), lines.join("\n"));
const BASE = ["HADES_CTX_CAP_IMPL\t200000", "HADES_CTX_CAP_INTERACTIVE\t300000", "HADES_CTX_REWARN\t50000", "HADES_CTX_COMPACT_AT\t150000", ""];

beforeAll(() => {
  process.env.HOME = HOME;
  process.env.HADES_WORK_ROOT = WORK;
  process.env.HADES_DATA = DATA;
  mkdirSync(join(HOME, ".claude/hades"), { recursive: true });
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(HOME, ".claude/hades/instance"), `${DATA}\n`);
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(T, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(AGENTS, { recursive: true, force: true });
  rmSync(join(HOME, ".claude/hades/guard"), { recursive: true, force: true });
  mkdirSync(AGENTS, { recursive: true });
  writeFileSync(join(AGENTS, "unidade.json"), JSON.stringify({ name: "unidade", role: "impl", state: "working", worktree: WT }));
  writeConfig(BASE);
});

const env: HookEnv = { now: () => 0, cwd: () => CLONE, home: () => HOME, gatePatterns: () => [], projectOf: () => "proj", cerberusEmit: () => undefined };

let seq = 0;
/** Chamada de ferramenta da sessão `sid` em `cwd` com `tokens` de contexto; devolve o additionalContext ("" sem aviso). */
function postTool(sid: string, cwd: string, tokens: number): string {
  seq += 1;
  const transcript = join(T, `transcript-${seq}.jsonl`);
  const usage = { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { usage } })}\n`);
  const result = decide({ hook_event_name: "PostToolUse", session_id: sid, cwd, tool_name: "Bash", transcript_path: transcript }, env);
  if (result.stdout === "") return "";
  return (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

describe("hook: sugestão de /compact", () => {
  test("dado agente com 149k, então nenhum aviso", () => {
    expect(postTool("a1", WT, 149_000)).toBe("");
  });

  test("dado agente com 150k (teto 200k), então sugere /compact e cita o limiar e o teto", () => {
    const msg = postTool("a2", WT, 150_000);
    expect(msg).toContain("/compact");
    expect(msg).toContain("compactar a partir de 150k, teto 200k");
    expect(msg).not.toContain("STATUS: PARKED");
  });

  test("dado a mesma sessão que segue crescendo abaixo do teto, então a sugestão não repete", () => {
    expect(postTool("a3", WT, 160_000)).toContain("/compact");
    expect(postTool("a3", WT, 190_000)).toBe("");
  });

  test("dado sessão que sugeriu /compact e depois cruzou o teto, então o aviso do teto (handoff) sai igual", () => {
    expect(postTool("a4", WT, 160_000)).toContain("/compact");
    expect(postTool("a4", WT, 205_000)).toContain("STATUS: PARKED — teto de contexto");
  });

  test("dado sessão interativa com 160k (teto 300k), então a sugestão fala com o dono", () => {
    const msg = postTool("i1", join(T, "fora"), 160_000);
    expect(msg).toContain("/compact");
    expect(msg).toContain("ao dono");
  });

  test("dado HADES_CTX_COMPACT_AT maior ou igual ao teto do papel, então não sugere (só o teto avisa)", () => {
    writeConfig(["HADES_CTX_CAP_IMPL\t200000", "HADES_CTX_CAP_INTERACTIVE\t300000", "HADES_CTX_COMPACT_AT\t200000", ""]);
    expect(postTool("a5", WT, 199_000)).toBe("");
  });

  test("dado HADES_CTX_COMPACT_AT personalizado (100k), então a sugestão vem nele", () => {
    writeConfig(["HADES_CTX_CAP_IMPL\t200000", "HADES_CTX_COMPACT_AT\t100000", ""]);
    expect(postTool("a6", WT, 120_000)).toContain("compactar a partir de 100k");
  });

  test("dado HADES_CTX_GUARD desligado, então nenhum aviso", () => {
    writeConfig([...BASE, "HADES_CTX_GUARD\t0"]);
    expect(postTool("a7", WT, 160_000)).toBe("");
  });
});

describe("compactAtOf", () => {
  const read = (cfg: Record<string, string>) => (key: string): string | undefined => cfg[key];
  test("sem chave, vale o padrão de 150k; chave inválida cai no padrão", () => {
    expect(compactAtOf(read({}), 200_000)).toBe(DEFAULT_COMPACT_AT);
    expect(compactAtOf(read({ HADES_CTX_COMPACT_AT: "abc" }), 200_000)).toBe(DEFAULT_COMPACT_AT);
    expect(compactAtOf(read({ HADES_CTX_COMPACT_AT: "0" }), 200_000)).toBe(DEFAULT_COMPACT_AT);
  });
  test("limiar no teto ou acima dele não vale", () => {
    expect(compactAtOf(read({}), 150_000)).toBeUndefined();
    expect(compactAtOf(read({ HADES_CTX_COMPACT_AT: "250000" }), 200_000)).toBeUndefined();
  });
});
