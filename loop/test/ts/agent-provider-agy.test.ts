// Testes unitários de src/lib/agent-provider.ts (PR 2: implementação do agyProvider, stream-json, hooks camelCase e transcripts PLANNER_RESPONSE).
import { describe, expect, test } from "bun:test";
import {
  activeProvider,
  agyProvider,
  detectHookProvider,
  mapAgyToolName,
  normalizeAgyToolArgs,
  providerOf,
} from "../../../src/lib/agent-provider.ts";

describe("agent-provider (agyProvider)", () => {
  test("providerOf('agy') e activeProvider com HADES_AGENT_PROVIDER=agy retornam agyProvider", () => {
    expect(providerOf("agy")).toBe(agyProvider);
    expect(agyProvider.id).toBe("agy");
    expect(agyProvider.herdrKind).toBe("agy");
    expect(agyProvider.defaultBinary).toBe("agy");
    expect(activeProvider("review", (k) => (k === "HADES_AGENT_PROVIDER" ? "agy" : undefined), {})).toBe(agyProvider);
  });

  test("resolveBinary prioriza HADES_AGY_BIN, aceita HADES_CHAT_BIN não-claude e faz fallback para which('agy')", () => {
    expect(
      agyProvider.resolveBinary(
        (k) => (k === "HADES_AGY_BIN" ? "~/.local/bin/agy" : undefined),
        () => "/usr/bin/agy",
        "/home/dev",
      ),
    ).toBe("/home/dev/.local/bin/agy");

    // Se HADES_CHAT_BIN aponta para claude, ignora e usa which("agy")
    expect(
      agyProvider.resolveBinary(
        (k) => (k === "HADES_CHAT_BIN" ? "/usr/bin/claude" : undefined),
        (cmd) => (cmd === "agy" ? "/home/dev/.local/bin/agy" : undefined),
        "/home/dev",
      ),
    ).toBe("/home/dev/.local/bin/agy");

    // Se HADES_CHAT_BIN aponta para um agy customizado, aproveita
    expect(
      agyProvider.resolveBinary(
        (k) => (k === "HADES_CHAT_BIN" ? "~/custom/agy" : undefined),
        () => undefined,
        "/home/dev",
      ),
    ).toBe("/home/dev/custom/agy");
  });

  test("resolveModel mapeia apelidos e modelos claude-* para equivalentes do agy e preserva modelos nativos", () => {
    expect(agyProvider.resolveModel("opus")).toBe("gemini-4-argon");
    expect(agyProvider.resolveModel("claude-opus-5-5")).toBe("gemini-4-argon");
    expect(agyProvider.resolveModel("sonnet")).toBe("gemini-4-argon");
    expect(agyProvider.resolveModel("claude-sonnet-5-5")).toBe("gemini-4-argon");
    expect(agyProvider.resolveModel("haiku")).toBe("gemini-3-flash");
    expect(agyProvider.resolveModel("claude-haiku-5-5")).toBe("gemini-3-flash");
    expect(agyProvider.resolveModel("gemini-3.1-pro")).toBe("gemini-3.1-pro");
    expect(
      agyProvider.resolveModel(undefined, "review", (k) => (k === "HADES_MODEL_REVIEW" ? "claude-opus-5-5" : undefined)),
    ).toBe("gemini-4-argon");
  });

  test("buildPrintArgv e buildInteractiveArgv geram flags compatíveis com o agy CLI", () => {
    // 1. Execução print de review (auto + stream-json, sem --dangerously-skip-permissions por padrão)
    expect(
      agyProvider.buildPrintArgv({
        bin: "/home/dev/.local/bin/agy",
        prompt: "/review-pr 99",
        model: "opus",
        effort: "high",
        permissionMode: "auto",
        outputFormat: "stream-json",
        allowedTools: ["Read", "Grep"],
      }),
    ).toEqual([
      "/home/dev/.local/bin/agy", "-p", "/review-pr 99",
      "--output-format", "stream-json",
      "--mode", "auto",
      "--model", "gemini-4-argon",
      "--effort", "high",
    ]);

    // 1b. --dangerously-skip-permissions só entra sob HADES_AGY_SKIP_PERMISSIONS=1 (ou skip-all)
    expect(
      agyProvider.buildPrintArgv({
        bin: "/home/dev/.local/bin/agy",
        prompt: "/review-pr 99",
        model: "opus",
        effort: "high",
        permissionMode: "auto",
        outputFormat: "stream-json",
        readConfig: (k) => (k === "HADES_AGY_SKIP_PERMISSIONS" ? "1" : undefined),
      }),
    ).toEqual([
      "/home/dev/.local/bin/agy", "-p", "/review-pr 99",
      "--output-format", "stream-json",
      "--mode", "auto", "--dangerously-skip-permissions",
      "--model", "gemini-4-argon",
      "--effort", "high",
    ]);

    // 2. Execução read-only (moirai --deep / supervisor) -> --mode plan sem --dangerously-skip-permissions
    expect(
      agyProvider.buildPrintArgv({
        bin: "agy",
        outputFormat: "text",
        noTools: true,
        readOnly: true,
        model: "claude-opus-5-5",
        effort: "low",
      }),
    ).toEqual(["agy", "-p", "--output-format", "text", "--mode", "plan", "--model", "gemini-4-argon", "--effort", "low"]);

    // 3. Retomada de conversa no chat (--conversation)
    expect(
      agyProvider.buildPrintArgv({
        bin: "agy",
        outputFormat: "stream-json",
        permissionMode: "auto",
        model: "gemini-4-argon",
        effort: "medium",
        resumeSessionId: "conv-uuid-123",
      }),
    ).toEqual([
      "agy", "-p", "--output-format", "stream-json",
      "--mode", "auto",
      "--model", "gemini-4-argon", "--effort", "medium",
      "--conversation", "conv-uuid-123",
    ]);

    // 4. Interativo (herdr agent start / term.ts)
    expect(
      agyProvider.buildInteractiveArgv({
        permissionMode: "auto",
        model: "claude-sonnet-5-5",
        effort: "high",
        resumeSessionId: "conv-uuid-456",
      }),
    ).toEqual(["--mode", "auto", "--model", "gemini-4-argon", "--effort", "high", "--conversation", "conv-uuid-456"]);
  });

  test("parseStreamLine traduz init, step_update (tool + text) e result do agy stream-json", () => {
    expect(
      agyProvider.parseStreamLine(JSON.stringify({ type: "init", conversation_id: "conv-1", model: "gemini-4-argon" })),
    ).toEqual([{ t: "init", session: "conv-1", model: "gemini-4-argon" }]);

    const stepToolLine = JSON.stringify({
      type: "step_update",
      step_index: 3,
      step_type: "RUN_COMMAND",
      state: "RUNNING",
      tool_name: "run_command",
      tool_info: {
        id: "tc-3",
        name: "run_command",
        args: { CommandLine: "gh api repos/org/repo/pulls/1/reviews -X POST", WaitMsBeforeAsync: 5000, toolSummary: "Post PR review" },
      },
    });
    expect(agyProvider.parseStreamLine(stepToolLine)).toEqual([
      {
        t: "tool",
        id: "tc-3",
        name: "Bash",
        input: "gh api repos/org/repo/pulls/1/reviews -X POST",
        rawInput: {
          CommandLine: "gh api repos/org/repo/pulls/1/reviews -X POST",
          WaitMsBeforeAsync: 5000,
          toolSummary: "Post PR review",
          command: "gh api repos/org/repo/pulls/1/reviews -X POST",
          description: "Post PR review",
        },
        sub: false,
      },
    ]);

    const stepDoneLine = JSON.stringify({
      type: "step_update",
      step_index: 3,
      state: "DONE",
      tool_info: {
        id: "tc-3",
        name: "run_command",
        args: { CommandLine: "git status" },
        output: "nothing to commit",
      },
      response: "Verificação concluída.",
    });
    expect(agyProvider.parseStreamLine(stepDoneLine)).toEqual([
      { t: "tool_result", id: "tc-3", text: "nothing to commit", error: false, denied: false, sub: false },
      { t: "text", text: "Verificação concluída.", sub: false },
    ]);

    const resultLine = JSON.stringify({
      type: "result",
      conversation_id: "conv-1",
      response: "Relatório completo\nHADES-REVIEW: verdict=green blocking=0 important=0 inline=0 posted=no reviewId=-",
      num_turns: 4,
      duration_ms: 8500,
      usage: {
        input_tokens: 12000,
        output_tokens: 800,
        cache_read_tokens: 45000,
        cache_write_tokens: 0,
        total_usd: 0.18,
      },
      denied_actions: [{ tool_name: "run_command", args: { CommandLine: "git push" } }],
    });
    expect(agyProvider.parseStreamLine(resultLine)).toEqual([
      {
        t: "result",
        ok: true,
        subtype: "success",
        resultText: "Relatório completo\nHADES-REVIEW: verdict=green blocking=0 important=0 inline=0 posted=no reviewId=-",
        text: null,
        session: "conv-1",
        costUsd: 0.18,
        tokens: { input: 12000, output: 800, cacheRead: 45000, cacheWrite: 0 },
        durationMs: 8500,
        turns: 4,
        denials: [{ tool: "Bash", input: "git push" }],
      },
    ]);
  });

  test("detectHookProvider, normalizeHookInput e formatHookOutput adaptam os hooks camelCase do agy", () => {
    const agyPreTool = {
      conversationId: "conv-abc",
      workspacePaths: ["/repo/wt"],
      transcriptPath: "/home/dev/.gemini/antigravity-cli/brain/conv-abc/.system_generated/logs/transcript.jsonl",
      modelName: "gemini-4-argon",
      hookEventName: "PreToolUse",
      cwd: "/repo/wt",
      stepIdx: 5,
      toolCall: {
        id: "toolu_01",
        name: "run_command",
        args: {
          CommandLine: "sleep 10",
          WaitMsBeforeAsync: 5000,
          IsDaemon: false,
        },
      },
    };
    expect(detectHookProvider(agyPreTool)).toBe(agyProvider);
    expect(agyProvider.normalizeHookInput(agyPreTool)).toEqual({
      provider: "agy",
      rawEventName: "PreToolUse",
      hook_event_name: "PreToolUse",
      session_id: "conv-abc",
      transcript_path: "/home/dev/.gemini/antigravity-cli/brain/conv-abc/.system_generated/logs/transcript.jsonl",
      cwd: "/repo/wt",
      tool_name: "Bash",
      tool_input: {
        CommandLine: "sleep 10",
        WaitMsBeforeAsync: 5000,
        IsDaemon: false,
        command: "sleep 10",
      },
    });

    // Read tool normalization (StartLine/EndLine -> offset/limit e ByteOffset -> offset)
    expect(mapAgyToolName("read_file")).toBe("Read");
    expect(normalizeAgyToolArgs("read_file", { Path: "/repo/a.ts", StartLine: 10, EndLine: 59 })).toEqual({
      Path: "/repo/a.ts",
      StartLine: 10,
      EndLine: 59,
      file_path: "/repo/a.ts",
      offset: 10,
      limit: 50,
    });
    expect(normalizeAgyToolArgs("read_file", { Path: "/repo/big.ts", ByteOffset: 46080 })).toEqual({
      Path: "/repo/big.ts",
      ByteOffset: 46080,
      file_path: "/repo/big.ts",
      offset: 46080,
    });

    // Bash tool normalization: WaitMsBeforeAsync <= 500 também marca run_in_background: true (ex.: hades wait)
    expect(
      normalizeAgyToolArgs("run_command", { CommandLine: "hades wait ci 42", WaitMsBeforeAsync: 500 }),
    ).toEqual({
      CommandLine: "hades wait ci 42",
      WaitMsBeforeAsync: 500,
      command: "hades wait ci 42",
      run_in_background: true,
    });

    // Bloqueio no PreToolUse do agy sai com exit 0 e {"decision":"deny","reason":...} no stdout
    const denyOut = agyProvider.formatHookOutput({ exit: 2, blockReason: "hades-guard: polling barrado (sleep)" }, "PreToolUse");
    expect(denyOut).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ decision: "deny", reason: "hades-guard: polling barrado (sleep)" })}\n`,
      stderr: "",
    });

    // Injeção de mensagem de sistema no PostInvocation / PreInvocation do agy
    const injectOut = agyProvider.formatHookOutput(
      { exit: 0, additionalContext: "HADES: contexto acima do teto" },
      "PostInvocation",
    );
    expect(JSON.parse(injectOut.stdout)).toEqual({
      injectSteps: [{ systemMessage: { systemMessage: "HADES: contexto acima do teto" } }],
    });

    // PostToolUse no agy retorna {}
    expect(agyProvider.formatHookOutput({ exit: 0 }, "PostToolUse")).toEqual({
      exit: 0,
      stdout: "{}\n",
      stderr: "",
    });
  });

  test("extractContextTokensFromTail extrai tokens de linhas PLANNER_RESPONSE do transcript do agy", () => {
    const tail = [
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE" }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-argon-high",
        input_tokens: 13262,
        cache_read_tokens: 11208,
        output_tokens: 143,
      }),
      JSON.stringify({ step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE" }),
    ].join("\n");
    expect(agyProvider.extractContextTokensFromTail(tail)).toBe(13262 + 11208);
  });

  test("paths resolve os diretórios do agy mantendo memória compartilhada em ~/.claude/projects/<slug>/memory", () => {
    expect(agyProvider.paths.settingsFile("/home/u", {})).toBe("/home/u/.gemini/antigravity-cli/settings.json");
    expect(agyProvider.paths.hooksFile("/home/u", {})).toBe("/home/u/.gemini/config/hooks.json");
    expect(agyProvider.paths.conversationsDir("/home/u")).toBe("/home/u/.gemini/antigravity-cli/brain");
    expect(agyProvider.paths.memoryDir("/home/u/proj", "/home/u")).toBe("/home/u/.claude/projects/-home-u-proj/memory");
    expect(agyProvider.paths.instructionFiles).toEqual(["CLAUDE.md", "AGENTS.md", "GEMINI.md"]);
  });
});
