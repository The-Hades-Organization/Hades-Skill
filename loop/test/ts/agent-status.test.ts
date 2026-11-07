// `hades agent status --compact`: a linha (pura) e os coletores de diário, contexto e custo sobre arquivos de teste.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactLine, contextOfWorktree, costOfWorktree, formatTokens, lastEventLabel, lastJournalEvent } from "../../../src/commands/agent-status";

const tmp = mkdtempSync(join(tmpdir(), "agent-status-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("compactLine", () => {
  test("sete campos separados por espaço", () => {
    const line = compactLine({ name: "orq-eventos", herdr: "working", phase: "impl", lastEvent: "Bash@5m", pr: "63", ctxTokens: 123_456, costUsd: 4.5 });
    expect(line).toBe("orq-eventos working impl Bash@5m #63 123k $4.50");
    expect(line.split(" ")).toHaveLength(7);
  });

  test("campo vazio vira travessão e espaço interno vira sublinhado", () => {
    const line = compactLine({ name: "a", herdr: "fora", phase: "", lastEvent: "", pr: "", ctxTokens: 0, costUsd: 0 });
    expect(line).toBe("a fora — — — 0 $0.00");
    expect(compactLine({ name: "a", herdr: "x", phase: "em curso", lastEvent: "", pr: "", ctxTokens: 0, costUsd: 0 }).split(" ")).toHaveLength(7);
  });
});

describe("formatTokens", () => {
  test.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1k"],
    [123_456, "123k"],
    [1_250_000, "1.3M"],
  ])("%d → %s", (tokens, text) => expect(formatTokens(tokens)).toBe(text));
});

describe("lastEventLabel", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  test("nome da ferramenta (ou do tipo) e idade", () => {
    expect(lastEventLabel({ ts: "2026-11-06T11:59:30Z", kind: "tool", tool: "Bash" }, now)).toBe("Bash@30s");
    expect(lastEventLabel({ ts: "2026-11-06T11:55:00Z", kind: "agent.end" }, now)).toBe("agent.end@5m");
    expect(lastEventLabel({ ts: "2026-11-06T09:00:00Z", kind: "tool", tool: "Edit" }, now)).toBe("Edit@3h");
    expect(lastEventLabel({ ts: "2026-11-04T12:00:00Z", kind: "tool", tool: "Edit" }, now)).toBe("Edit@2d");
  });
  test("sem evento, vazio; ts inválido, só o nome", () => {
    expect(lastEventLabel(undefined, now)).toBe("");
    expect(lastEventLabel({ ts: "x", kind: "tool", tool: "Bash" }, now)).toBe("Bash");
  });
});

describe("coletores", () => {
  test("lastJournalEvent pega a última linha válida e ignora lixo", () => {
    const dir = join(tmp, "journal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ag.jsonl"), `${JSON.stringify({ ts: "2026-11-06T10:00:00Z", kind: "tool", tool: "Read" })}\n${JSON.stringify({ ts: "2026-11-06T10:01:00Z", kind: "tool", tool: "Bash" })}\n{cortada`);
    expect(lastJournalEvent(dir, "ag")).toEqual({ ts: "2026-11-06T10:01:00Z", kind: "tool", tool: "Bash" });
    expect(lastJournalEvent(dir, "nao-existe")).toBeUndefined();
  });

  test("contexto e custo vêm das transcrições do worktree, subagentes inclusive", () => {
    const worktree = "/w/proj.x";
    const project = join(tmp, ".claude", "projects", "-w-proj-x");
    mkdirSync(join(project, "sess", "subagents"), { recursive: true });
    const turn = (ts: string, input: number, output: number): string =>
      JSON.stringify({ type: "assistant", timestamp: ts, sessionId: "s", requestId: ts, message: { id: ts, model: "claude-opus-5-5", usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } });
    writeFileSync(join(project, "s.jsonl"), `${turn("2026-11-06T10:00:00Z", 1_000_000, 0)}\n${turn("2026-11-06T10:01:00Z", 50_000, 0)}\n`);
    writeFileSync(join(project, "sess", "subagents", "a.jsonl"), `${turn("2026-11-06T10:02:00Z", 1_000_000, 0)}\n`);
    expect(contextOfWorktree(worktree, tmp)).toBe(50_000);
    expect(costOfWorktree(worktree, tmp)).toBeCloseTo(8.2, 5); // 2,05 M de entrada a US$ 4/M
    expect(costOfWorktree("/w/outro", tmp)).toBe(0);
    expect(contextOfWorktree("", tmp)).toBe(0);
  });
});
