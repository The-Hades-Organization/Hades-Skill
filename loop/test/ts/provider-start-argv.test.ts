// `hades provider start-argv` devolve o argv interativo de start do provedor ativo, o mesmo que o `startCommand` do `agent start-cmd` monta.
import { afterEach, describe, expect, test } from "bun:test";
import { providerCommand } from "../../../src/commands/provider";
import { startArgv, startCommand } from "../../../src/lib/agent-registry";

const KEYS = ["HADES_AGENT_PROVIDER", "HADES_PROVIDER", "HADES_PROVIDER_IMPL", "HADES_AGY_SKIP_PERMISSIONS", "HADES_MODEL_IMPL", "HADES_EFFORT_IMPL", "HADES_MODEL_ORCHESTRATOR", "HADES_EFFORT_ORCHESTRATOR"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function run(args: string[]): { code: number; out: string } {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string) => (chunks.push(String(c)), true)) as typeof process.stdout.write;
  try {
    return { code: providerCommand(args), out: chunks.join("") };
  } finally {
    process.stdout.write = write;
  }
}

describe.each([
  ["claude", ["--permission-mode", "auto", "--model", "claude-sonnet-5-5", "--effort", "high"]],
  ["agy", ["--mode", "auto", "--model", "gemini-4-argon", "--effort", "high"]],
])("provedor %s", (id, expected) => {
  test("dado o papel, então kind e args são o tail do startCommand, em JSON compacto", () => {
    process.env.HADES_AGENT_PROVIDER = id;
    process.env.HADES_AGY_SKIP_PERMISSIONS = "0";
    process.env.HADES_MODEL_IMPL = "claude-sonnet-5-5";
    process.env.HADES_EFFORT_IMPL = "high";
    const res = run(["start-argv", "--role", "impl"]);
    expect(res.code).toBe(0);
    const json = JSON.parse(res.out);
    expect(Object.keys(json)).toEqual(["kind", "args"]);
    expect(json).toEqual({ kind: id, args: expected });
    expect(startCommand("a1", "w1:p2", "impl")).toBe(`! herdr agent start a1 --kind ${id} --pane w1:p2 -- ${json.args.join(" ")}`);
    expect(res.out.trim()).toBe(JSON.stringify(startArgv("impl")));
  });
});

describe("opções", () => {
  test("dado sem --role, então vale ORCHESTRATOR", () => {
    process.env.HADES_AGENT_PROVIDER = "claude";
    process.env.HADES_MODEL_ORCHESTRATOR = "claude-opus-5-5";
    process.env.HADES_EFFORT_ORCHESTRATOR = "max";
    expect(JSON.parse(run(["start-argv"]).out).args).toEqual(["--permission-mode", "auto", "--model", "claude-opus-5-5", "--effort", "max"]);
  });
  test("dado -h, então imprime o uso e sai com 0", () => {
    const res = run(["start-argv", "-h"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("start-argv");
  });
});
