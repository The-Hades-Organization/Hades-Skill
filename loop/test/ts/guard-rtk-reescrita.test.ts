// Orientação da reescrita do rtk: o auto mode devolve "no verdict" quando o hook do rtk muda o comando Bash. A chamada negada
// não dispara PostToolUse; o hook lê o tool_result negado no transcript e orienta uma vez por sessão.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, type HookEnv } from "../../../src/lib/guard-hook";

const T = mkdtempSync(join(tmpdir(), "hades-rtk-reescrita-"));
const HOME = join(T, "home");
const DATA = join(T, "data");
const CLONE = join(T, "clone");
const savedEnv = { HOME: process.env.HOME, HADES_WORK_ROOT: process.env.HADES_WORK_ROOT, HADES_DATA: process.env.HADES_DATA };

beforeAll(() => {
  process.env.HOME = HOME;
  process.env.HADES_WORK_ROOT = join(T, "work");
  process.env.HADES_DATA = DATA;
  mkdirSync(join(HOME, ".claude/hades"), { recursive: true });
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(HOME, ".claude/hades/instance"), `${DATA}\n`);
  writeFileSync(join(DATA, "config.tsv"), "HADES_CTX_CAP_INTERACTIVE\t300000\n");
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(T, { recursive: true, force: true });
});
beforeEach(() => rmSync(join(HOME, ".claude/hades/guard"), { recursive: true, force: true }));

const env: HookEnv = { now: () => 0, cwd: () => CLONE, home: () => HOME, gatePatterns: () => [], projectOf: () => "proj", cerberusEmit: () => undefined };

const DENIED =
  "Error: The server-side auto mode classifier gave no verdict for Bash: a hook changed this call's input after auto mode reviewed it, so the review does not cover what would run.";
const toolResult = (content: string, isError: boolean): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content, is_error: isError, tool_use_id: "t1" }] } });

let seq = 0;
/** PostToolUse da sessão `sid` sobre um transcript com as linhas dadas; devolve o additionalContext ("" sem aviso). */
function postTool(sid: string, lines: string[]): string {
  seq += 1;
  const transcript = join(T, `transcript-${seq}.jsonl`);
  writeFileSync(transcript, `${lines.join("\n")}\n`);
  const result = decide({ hook_event_name: "PostToolUse", session_id: sid, cwd: CLONE, tool_name: "Bash", transcript_path: transcript }, env);
  if (result.stdout === "") return "";
  return (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

describe("hook: orientação da reescrita do rtk", () => {
  test("dado a redação de outra chamada Bash da mesma resposta, então também orienta", () => {
    const other = "Error: The server-side auto mode classifier gave no verdict for Bash: another call in this response was changed by a hook after auto mode reviewed it.";
    expect(postTool("s0", [toolResult(other, true)])).toContain("uma chamada Bash por resposta");
  });

  test("dado resultado negado no transcript, quando a próxima chamada conclui, então orienta uma Bash por resposta e cita tokens.md", () => {
    const msg = postTool("s1", [toolResult(DENIED, true)]);
    expect(msg).toContain("uma chamada Bash por resposta");
    expect(msg).toContain("rtk <cmd>");
    expect(msg).toContain("reference/loop/tokens.md");
  });

  test("dado a mesma sessão com nova ocorrência, então não orienta de novo", () => {
    expect(postTool("s2", [toolResult(DENIED, true)])).not.toBe("");
    expect(postTool("s2", [toolResult(DENIED, true)])).toBe("");
  });

  test("dado outra sessão, então orienta de novo (uma vez por sessão)", () => {
    expect(postTool("s3", [toolResult(DENIED, true)])).not.toBe("");
    expect(postTool("s4", [toolResult(DENIED, true)])).not.toBe("");
  });

  test("dado transcript sem o texto, então não orienta", () => {
    expect(postTool("s5", [toolResult("ok", false)])).toBe("");
  });

  test("dado o texto em resultado que não é erro (arquivo lido, conversa), então não orienta", () => {
    expect(postTool("s6", [toolResult(DENIED, false)])).toBe("");
  });

  test("dado 'no verdict' sem reescrita por hook, então não orienta", () => {
    expect(postTool("s7", [toolResult("The server-side auto mode classifier gave no verdict for Bash: timeout", true)])).toBe("");
  });

  test("dado o aviso já dado, então a ocorrência ignorada não consome o estado de outra sessão", () => {
    expect(postTool("s8", [toolResult("ok", false)])).toBe("");
    expect(postTool("s8", [toolResult(DENIED, true)])).not.toBe("");
  });
});
