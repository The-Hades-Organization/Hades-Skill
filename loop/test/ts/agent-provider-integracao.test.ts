import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCommand } from "../../../src/lib/agent-registry.ts";
import { AGENT_KINDS, validateRole } from "../../../src/lib/argos-roles.ts";
import { contextOfDir, decide, type HookEnv } from "../../../src/lib/guard-hook.ts";
import { eventOfHook } from "../../../src/lib/journal.ts";
import { agentArgs, chooseTerminal } from "../../../src/panel/argos-terminals.ts";
import { createSupervisorRoutes } from "../../../src/panel/argos-supervisor.ts";
import { chatEvents } from "../../../src/panel/chat-events.ts";
import { createTerm } from "../../../src/panel/term.ts";
import { TERM_KINDS } from "../../../src/panel/term-protocol.ts";

const T = realpathSync(mkdtempSync(join(tmpdir(), "hades-provider-int-")));
afterAll(() => rmSync(T, { recursive: true, force: true }));

describe("agent-provider integração (PR 3)", () => {
  test("startCommand mantém saída idêntica com claude e emite --kind agy / --mode auto com HADES_AGENT_PROVIDER=agy", () => {
    const prevProvider = process.env.HADES_AGENT_PROVIDER;
    const prevSkip = process.env.HADES_AGY_SKIP_PERMISSIONS;
    const prevModel = process.env.HADES_MODEL_IMPL;
    const prevEffort = process.env.HADES_EFFORT_IMPL;
    try {
      process.env.HADES_AGENT_PROVIDER = "claude";
      process.env.HADES_AGY_SKIP_PERMISSIONS = "0";
      process.env.HADES_MODEL_IMPL = "claude-sonnet-5-5";
      process.env.HADES_EFFORT_IMPL = "high";
      expect(startCommand("a1", "w1:p2", "impl")).toBe(
        "! herdr agent start a1 --kind claude --pane w1:p2 -- --permission-mode auto --model claude-sonnet-5-5 --effort high",
      );

      process.env.HADES_AGENT_PROVIDER = "agy";
      expect(startCommand("a1", "w1:p2", "impl")).toBe(
        "! herdr agent start a1 --kind agy --pane w1:p2 -- --mode auto --model gemini-4-argon --effort high",
      );
    } finally {
      if (prevProvider === undefined) delete process.env.HADES_AGENT_PROVIDER;
      else process.env.HADES_AGENT_PROVIDER = prevProvider;
      if (prevSkip === undefined) delete process.env.HADES_AGY_SKIP_PERMISSIONS;
      else process.env.HADES_AGY_SKIP_PERMISSIONS = prevSkip;
      if (prevModel === undefined) delete process.env.HADES_MODEL_IMPL;
      else process.env.HADES_MODEL_IMPL = prevModel;
      if (prevEffort === undefined) delete process.env.HADES_EFFORT_IMPL;
      else process.env.HADES_EFFORT_IMPL = prevEffort;
    }
  });

  test("argos-roles e argos-terminals aceitam agent 'agy' com --model e --effort", () => {
    expect(AGENT_KINDS.agy).toEqual({ model: "--model", effort: "--effort" });
    const role = validateRole({
      name: "Implementador Agy",
      color: "#123456",
      instructions: "Implemente a feature",
      agent: "agy",
      model: "gemini-3.1-pro",
      effort: "high",
    });
    expect(role.agent).toBe("agy");
    const choice = chooseTerminal({ agent: "agy", model: "gemini-3.1-pro", effort: "high" }, undefined, undefined);
    expect(agentArgs(choice)).toEqual(["--model", "gemini-3.1-pro", "--effort", "high"]);
  });

  test("term-protocol e term.ts abrem sessão 'agy' com --mode auto e --conversation no resume", async () => {
    expect(TERM_KINDS).toContain("agy");
    const fakeBin = join(T, "agy-fake");
    writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBin, 0o755);

    const spawned: string[][] = [];
    const term = createTerm({
      dataDir: join(T, "term-data"),
      config: () => ({ HADES_TERMINAL: "1", HADES_AGY_BIN: fakeBin }),
      roots: () => [T],
      defaultCwd: T,
      notify: async () => undefined,
      log: () => undefined,
      spawn: (spec) => {
        spawned.push(spec.argv);
        return {
          pid: 12345,
          write: () => undefined,
          resize: () => undefined,
          close: () => undefined,
          exited: new Promise(() => undefined),
        };
      },
    });

    const info1 = await term.open({ kind: "agy", cwd: T }, "local");
    expect(info1.kind).toBe("agy");
    expect(spawned[0]).toEqual([fakeBin, "--mode", "auto"]);

    const info2 = await term.open({ kind: "agy", cwd: T, resume: "11111111-2222-3333-4444-555555555555" }, "local");
    expect(info2.kind).toBe("agy");
    expect(spawned[1]).toEqual([fakeBin, "--mode", "auto", "--conversation", "11111111-2222-3333-4444-555555555555"]);
    term.stop();
  });

  test("chatEvents preserva hds_user/hds_end e traduz eventos init, step_update e result do agy", () => {
    expect(chatEvents(JSON.stringify({ type: "hds_user", text: "oi", remote: false, ts: 10 }), false)).toEqual([
      { t: "user", text: "oi", remote: false, ts: 10 },
    ]);
    expect(chatEvents(JSON.stringify({ type: "hds_end", rc: 0, stopped: false }), false)).toEqual([
      { t: "end", rc: 0, stopped: false },
    ]);
    expect(
      chatEvents(JSON.stringify({ type: "init", conversation_id: "conv-123", model: "gemini-3.1-pro" }), false),
    ).toEqual([{ t: "init", session: "conv-123", model: "gemini-3.1-pro" }]);

    const stepEvents = chatEvents(
      JSON.stringify({
        type: "step_update",
        state: "DONE",
        tool_name: "run_command",
        tool_info: { name: "run_command", args: { CommandLine: "git status" } },
        response: "Árvore limpa.",
      }),
      false,
    );
    expect(stepEvents).toEqual([
      {
        t: "tool",
        id: null,
        name: "Bash",
        input: "git status",
        rawInput: { CommandLine: "git status", command: "git status" },
        sub: false,
      },
      { t: "text", text: "Árvore limpa.", sub: false },
    ]);

    const resEvents = chatEvents(
      JSON.stringify({
        type: "result",
        conversation_id: "conv-123",
        response: "Concluído",
        num_turns: 2,
        duration_ms: 850,
        usage: {
          input_tokens: 500,
          output_tokens: 100,
          cache_read_tokens: 200,
          cache_write_tokens: 0,
          total_usd: 0.015,
        },
        denied_actions: [],
      }),
      false,
    );
    expect(resEvents[0]).toMatchObject({
      t: "result",
      ok: true,
      cost: 0.015,
      ms: 850,
      turns: 2,
      tokens: { input: 500, output: 100, cacheRead: 200, cacheWrite: 0 },
    });
  });

  test("argos-supervisor usa --mode plan quando HADES_AGENT_PROVIDER=agy", async () => {
    const fakeBin = join(T, "agy-sup");
    writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBin, 0o755);

    const captured: string[][] = [];
    const routes = createSupervisorRoutes({
      dir: join(T, "sup-dir"),
      config: () => ({ HADES_AGENT_PROVIDER: "agy", HADES_AGY_BIN: fakeBin }),
      readPane: async () => "⏺ Pronto.\n",
      loadDoc: async () => undefined,
      readNote: async () => undefined,
      notify: async () => undefined,
      log: () => undefined,
      runClaude: async (argv) => {
        captured.push(argv);
        return { status: 0, out: "Resumo ok" };
      },
    });

    const res = await routes.post(
      "/api/argos/supervisor/ask",
      { session: "default", pane: "w1:p1", name: "dev", question: "status?" },
      { remote: false },
    );
    expect(res?.status).toBe(200);
    expect(captured[0]).toEqual([
      fakeBin,
      "-p",
      "--output-format",
      "text",
      "--mode",
      "plan",
      "--model",
      "gemini-4-argon",
      "--effort",
      "low",
    ]);
  });

  test("guard-hook + journal: no agy, bloqueia polling no PreToolUse com decision:deny e entrega avisos de PostToolUse no PostInvocation via injectSteps (item 🟡 2)", () => {
    const homeDir = join(T, "home-agy");
    const workDir = join(T, "work-agy");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    // Cria arquivo grande (> 20 KB) para acionar HADES_READ_WARN_KB no PostToolUse de read_file
    const bigFile = join(workDir, "grande.txt");
    writeFileSync(bigFile, "x".repeat(25 * 1024));

    // Cria transcript do agy com PLANNER_RESPONSE acima do teto interativo (350k > 300k)
    const transcriptFile = join(workDir, "transcript.jsonl");
    writeFileSync(
      transcriptFile,
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "oi" }),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          input_tokens: 250_000,
          cache_read_tokens: 110_000,
          output_tokens: 500,
        }),
      ].join("\n") + "\n",
    );

    const journaled: { kind: string; summary: string }[] = [];
    const env: HookEnv = {
      now: () => 1_700_000_000,
      cwd: () => workDir,
      home: () => homeDir,
      gatePatterns: () => [/^\s*bun\s+test\b/],
      projectOf: () => undefined,
      cerberusEmit: () => undefined,
      journal: (d, _cfg, res) => {
        const ev = eventOfHook(d, "a-agy", new Date(1_700_000_000_000));
        if (ev) journaled.push({ kind: res.exit === 2 ? "tool_blocked" : ev.kind, summary: ev.summary });
      },
    };

    // 1. PreToolUse bloqueado (run_command com bun test fora do gate-lock) -> decision: deny em stdout (exit 0)
    const blocked = decide(
      {
        hookEventName: "PreToolUse",
        conversationId: "conv-agy-1",
        transcriptPath: transcriptFile,
        workspacePaths: [workDir],
        toolCall: { id: "tc-1", name: "run_command", args: { CommandLine: "bun test loop/test/ts" } },
      },
      env,
    );
    expect(blocked.exit).toBe(0);
    const blockedJson = JSON.parse(blocked.stdout) as { decision: string; reason: string };
    expect(blockedJson.decision).toBe("deny");
    expect(blockedJson.reason).toContain("gate-lock");
    expect(journaled.at(-1)?.kind).toBe("tool_blocked");

    // 2. PostToolUse com read_file de arquivo grande + transcript acima do teto:
    // retorna {} no PostToolUse e enfileira os avisos por session_id para o PostInvocation subsequente
    const postRes = decide(
      {
        hookEventName: "PostToolUse",
        conversationId: "conv-agy-1",
        transcriptPath: transcriptFile,
        workspacePaths: [workDir],
        toolCall: { id: "tc-2", name: "read_file", args: { Path: bigFile } },
      },
      env,
    );
    expect(postRes).toEqual({ exit: 0, stdout: "{}\n", stderr: "" });

    // 3. PostInvocation subsequente entrega os avisos acumulados via injectSteps e limpa a fila
    const invRes1 = decide(
      {
        hookEventName: "PostInvocation",
        conversationId: "conv-agy-1",
        transcriptPath: transcriptFile,
        workspacePaths: [workDir],
      },
      env,
    );
    expect(invRes1.exit).toBe(0);
    const invJson1 = JSON.parse(invRes1.stdout) as { injectSteps: { systemMessage: { systemMessage: string } }[] };
    const injected = invJson1.injectSteps[0]?.systemMessage.systemMessage ?? "";
    expect(injected).toContain("HADES: leitura inteira de arquivo grande");
    expect(injected).toContain("grande.txt (25 KB)");
    expect(injected).toContain("HADES: contexto em 360k");

    // 4. Segundo PostInvocation sem novos avisos devolve {}
    const invRes2 = decide(
      {
        hookEventName: "PostInvocation",
        conversationId: "conv-agy-1",
        transcriptPath: transcriptFile,
        workspacePaths: [workDir],
      },
      env,
    );
    expect(invRes2).toEqual({ exit: 0, stdout: "{}\n", stderr: "" });

    // 5. contextOfDir resolve o transcript do agy pelo índice by-cwd gravado no hook
    expect(contextOfDir(workDir, homeDir)).toBe(360_000);
  });
});
