// Equivalente de loop/test/hook_cases.py: alimenta o hook (bun src/hook.ts) com o JSON de PreToolUse/PostToolUse de cada caso do
// TSV e devolve uma linha por caso (nome, código de saída e o começo da mensagem). Sem gate real.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Rig } from "./rig";
import { BUN, SKILL } from "./rig";

export const HOOK = join(SKILL, "src/hook.ts");

export function hookCases(
  rig: Rig, casesTsv: string, dirs: Record<string, string>, extraEnv: Record<string, string> = {}, argv: string[] = [BUN, HOOK],
): string {
  const out: string[] = [];
  readFileSync(casesTsv, "utf8").split("\n").forEach((line, n) => {
    if (!line || line.startsWith("#")) return;
    const [name, ev, where, bg, sid, payload] = line.split("\t") as [string, string, string, string, string, string];
    const cwd = dirs[where] as string;
    const d: Record<string, unknown> = { hook_event_name: `${ev}ToolUse`, session_id: sid, cwd, tool_name: "Bash" };
    if (ev === "Pre") d.tool_input = { command: payload.replaceAll("\\n", "\n"), run_in_background: bg === "1" };
    else {
      const tr = join(rig.T, `transcript-${n}.jsonl`);
      writeFileSync(tr, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: Number(payload), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + "\n");
      d.tool_input = { command: "true" };
      d.transcript_path = tr;
    }
    const p = rig.X(argv, { stdin: JSON.stringify(d), cwd, env: extraEnv });
    let msg = p.err.trim();
    if (p.out.trim()) {
      try { msg = (JSON.parse(p.out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext; }
      catch { msg = p.out.trim(); }
    }
    out.push(`${name}\trc=${p.rc}\t${Array.from(msg).slice(0, 90).join("")}`);
  });
  return out.join("\n") + "\n";
}
