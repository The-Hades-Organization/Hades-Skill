// Testes unitários de src/lib/agent-provider.ts (PR 1: interface AgentProvider + claudeProvider sem mudança de comportamento).
import { describe, expect, test } from "bun:test";
import {
  AGENT_PROVIDER_IDS,
  DEFAULT_AGENT_PROVIDER,
  activeProvider,
  activeProviderId,
  claudeProvider,
  extractClaudeTokens,
  isAgentProviderId,
  providerOf,
} from "../../../src/lib/agent-provider.ts";

describe("agent-provider (claudeProvider e resolução)", () => {
  test("default é claude quando nenhuma chave está configurada", () => {
    expect(DEFAULT_AGENT_PROVIDER).toBe("claude");
    expect(AGENT_PROVIDER_IDS).toEqual(["claude", "agy"]);
    expect(isAgentProviderId("claude")).toBe(true);
    expect(isAgentProviderId("agy")).toBe(true);
    expect(isAgentProviderId("outro")).toBe(false);
    expect(activeProviderId(undefined, () => undefined, {})).toBe("claude");
    expect(activeProvider(undefined, () => undefined, {}).id).toBe("claude");
    expect(providerOf(undefined).id).toBe("claude");
  });

  test("activeProviderId respeita override por papel e config global", () => {
    const cfg: Record<string, string> = {
      HADES_AGENT_PROVIDER: "claude",
      HADES_AGENT_PROVIDER_REVIEW: "agy",
    };
    expect(activeProviderId("review", (k) => cfg[k], {})).toBe("agy");
    expect(activeProviderId("impl", (k) => cfg[k], {})).toBe("claude");
    expect(activeProviderId("impl", () => "agy", {})).toBe("agy");
    expect(activeProviderId("impl", () => "invalido", {})).toBe("claude");
  });

  test("resolveBinary usa HADES_CHAT_BIN (expandindo ~) ou fallback which('claude')", () => {
    const resolvedFromCfg = claudeProvider.resolveBinary(
      (k) => (k === "HADES_CHAT_BIN" ? "~/bin/custom-claude" : undefined),
      () => "/usr/bin/claude",
      "/home/dev",
    );
    expect(resolvedFromCfg).toBe("/home/dev/bin/custom-claude");

    const resolvedFromWhich = claudeProvider.resolveBinary(
      () => "",
      (cmd) => (cmd === "claude" ? "/usr/local/bin/claude" : undefined),
      "/home/dev",
    );
    expect(resolvedFromWhich).toBe("/usr/local/bin/claude");
  });

  test("resolveModel traduz apelidos opus/sonnet/haiku e respeita HADES_MODEL_<ROLE>", () => {
    expect(claudeProvider.resolveModel("opus")).toBe("claude-opus-5-5");
    expect(claudeProvider.resolveModel("sonnet")).toBe("claude-sonnet-5-5");
    expect(claudeProvider.resolveModel("haiku")).toBe("claude-haiku-5-5");
    expect(claudeProvider.resolveModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(claudeProvider.resolveModel(undefined, "impl")).toBe("claude-sonnet-5-5");
    expect(claudeProvider.resolveModel(undefined, "orchestrator")).toBe("claude-opus-5-5");
    expect(
      claudeProvider.resolveModel(undefined, "review", (k) => (k === "HADES_MODEL_REVIEW" ? "sonnet" : undefined)),
    ).toBe("claude-sonnet-5-5");
  });

  test("buildPrintArgv reproduz exatamente os argvs de review, moirai, chat e supervisor", () => {
    // 1. hades review
    const reviewArgv = claudeProvider.buildPrintArgv({
      bin: "claude",
      prompt: "/review-pr 42",
      model: "opus",
      effort: "medium",
      permissionMode: "auto",
      outputFormat: "stream-json",
      verbose: true,
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Bash(git push:*)"],
    });
    expect(reviewArgv).toEqual([
      "claude", "-p", "/review-pr 42", "--model", "claude-opus-5-5", "--effort", "medium",
      "--permission-mode", "auto", "--output-format", "stream-json", "--verbose",
      "--allowedTools", "Read", "Grep", "--disallowedTools", "Bash(git push:*)",
    ]);

    // 2. hades moirai estimate --deep
    const moiraiArgv = claudeProvider.buildPrintArgv({
      bin: "claude",
      model: "claude-opus-5-5",
      allowedTools: ["Read Grep Glob"],
      prompt: "Estime o tamanho",
    });
    expect(moiraiArgv).toEqual(["claude", "-p", "Estime o tamanho", "--model", "claude-opus-5-5", "--allowedTools", "Read Grep Glob"]);

    // 3. painel chat (stdin, sem prompt posicional)
    const chatArgv = claudeProvider.buildPrintArgv({
      bin: "/usr/bin/claude",
      outputFormat: "stream-json",
      verbose: true,
      includePartialMessages: true,
      permissionMode: "auto",
      model: "claude-opus-5-5",
      effort: "high",
      resumeSessionId: "12345678-1234-1234-1234-123456789abc",
    });
    expect(chatArgv).toEqual([
      "/usr/bin/claude", "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-mode", "auto", "--model", "claude-opus-5-5", "--effort", "high",
      "--resume", "12345678-1234-1234-1234-123456789abc",
    ]);

    // 4. argos-supervisor (stdin, sem ferramentas)
    const supArgv = claudeProvider.buildPrintArgv({
      bin: "/usr/bin/claude",
      outputFormat: "text",
      noTools: true,
      strictMcpConfig: true,
      noSessionPersistence: true,
      model: "claude-opus-5-5",
      effort: "low",
    });
    expect(supArgv).toEqual([
      "/usr/bin/claude", "-p", "--output-format", "text", "--tools", "", "--strict-mcp-config",
      "--no-session-persistence", "--model", "claude-opus-5-5", "--effort", "low",
    ]);
  });

  test("buildInteractiveArgv reproduz os argumentos para herdr agent start e term.ts", () => {
    expect(
      claudeProvider.buildInteractiveArgv({
        permissionMode: "auto",
        model: "claude-sonnet-5-5",
        effort: "medium",
        systemPromptFile: "/tmp/role.md",
      }),
    ).toEqual([
      "--permission-mode", "auto", "--model", "claude-sonnet-5-5", "--effort", "medium",
      "--append-system-prompt-file", "/tmp/role.md",
    ]);

    expect(
      claudeProvider.buildInteractiveArgv({
        bin: "/usr/bin/claude",
        permissionMode: "auto",
        resumeSessionId: "sess-123",
      }),
    ).toEqual(["/usr/bin/claude", "--permission-mode", "auto", "--resume", "sess-123"]);
  });

  test("parseStreamLine converte eventos init, delta, assistant, user e result do stream-json", () => {
    expect(
      claudeProvider.parseStreamLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", model: "claude-opus-5-5" })),
    ).toEqual([{ t: "init", session: "s-1", model: "claude-opus-5-5" }]);

    expect(
      claudeProvider.parseStreamLine(
        JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Olá" } } }),
        { includeDeltas: true },
      ),
    ).toEqual([{ t: "delta", text: "Olá" }]);

    const assistantLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Analisando PR" },
          { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "git diff" } },
        ],
      },
    });
    expect(claudeProvider.parseStreamLine(assistantLine)).toEqual([
      { t: "text", text: "Analisando PR", sub: false },
      { t: "tool", id: "tu-1", name: "Bash", input: "git diff", rawInput: { command: "git diff" }, sub: false },
    ]);

    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Relatório final",
      session_id: "s-1",
      total_cost_usd: 0.42,
      duration_ms: 1200,
      num_turns: 3,
      modelUsage: {
        "claude-opus-5-5": {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 200,
          costUSD: 0.42,
        },
      },
    });
    const parsedResult = claudeProvider.parseStreamLine(resultLine);
    expect(parsedResult).toEqual([
      {
        t: "result",
        ok: true,
        subtype: "success",
        resultText: "Relatório final",
        text: null,
        session: "s-1",
        costUsd: 0.42,
        tokens: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 },
        tokensByModel: {
          "claude-opus-5-5": { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, costUsd: 0.42 },
        },
        durationMs: 1200,
        turns: 3,
        denials: [],
      },
    ]);

    expect(extractClaudeTokens({ usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } })).toEqual({
      tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    });
  });

  test("normalizeHookInput, formatHookOutput e extractContextTokensFromTail mantêm paridade com guard-hook.ts", () => {
    const raw = {
      hook_event_name: "PreToolUse",
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };
    expect(claudeProvider.normalizeHookInput(raw)).toEqual({
      provider: "claude",
      rawEventName: "PreToolUse",
      hook_event_name: "PreToolUse",
      session_id: "sess-1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });

    expect(claudeProvider.formatHookOutput({ exit: 2, blockReason: "polling barrado" }, "PreToolUse")).toEqual({
      exit: 2,
      stdout: "",
      stderr: "polling barrado",
    });

    const ctxOut = claudeProvider.formatHookOutput({ exit: 0, additionalContext: "aviso de leitura" }, "PreToolUse");
    expect(ctxOut.exit).toBe(0);
    expect(JSON.parse(ctxOut.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "aviso de leitura" },
    });

    const tail = [
      JSON.stringify({ type: "assistant", isSidechain: false, message: { usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 } } }),
      JSON.stringify({ type: "assistant", isSidechain: true, message: { usage: { input_tokens: 99999 } } }),
    ].join("\n");
    expect(claudeProvider.extractContextTokensFromTail(tail)).toBe(2400);
  });

  test("paths resolve os diretórios padrão do Claude Code", () => {
    expect(claudeProvider.paths.settingsFile("/home/u", {})).toBe("/home/u/.claude/settings.json");
    expect(claudeProvider.paths.projectTranscriptDir("/home/u/proj/", "/home/u")).toBe("/home/u/.claude/projects/-home-u-proj");
    expect(claudeProvider.paths.memoryDir("/home/u/proj", "/home/u")).toBe("/home/u/.claude/projects/-home-u-proj/memory");
    expect(claudeProvider.paths.instructionFiles).toEqual(["CLAUDE.md"]);
  });
});
