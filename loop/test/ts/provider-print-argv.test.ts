// `hades provider print-argv` monta o mesmo argv de print que o `--deep` do Moirai usa hoje (commands/moirai.ts, claudeRunner).
import { afterEach, describe, expect, test } from "bun:test";
import { activeProvider } from "../../../src/lib/agent-provider";
import { printArgvSpec, providerCommand } from "../../../src/commands/provider";
import { skillRoot } from "../../../src/lib/paths";
import { configValue } from "../../../src/lib/work";

const KEYS = ["HADES_PROVIDER", "HADES_PROVIDER_ORCHESTRATOR", "HADES_MODEL_ORCHESTRATOR", "HADES_CHAT_BIN", "HADES_MOIRAI_DEEP_TIMEOUT_S"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const readCfg = (key: string): string | undefined => configValue(key, "") || undefined;

/** O que o claudeRunner do --deep monta, linha a linha. */
function deepArgv(prompt: string): { bin: string; args: string[] } {
  const provider = activeProvider("ORCHESTRATOR", readCfg);
  const rawModel = configValue("HADES_MODEL_ORCHESTRATOR", "claude-opus-5-5");
  const model = provider.id === "claude" ? rawModel : provider.resolveModel(rawModel, "ORCHESTRATOR", readCfg);
  const bin = provider.id === "claude" ? (configValue("HADES_CHAT_BIN", "") || "claude") : (provider.resolveBinary(readCfg, (cmd) => cmd, process.env.HOME ?? "") ?? "agy");
  const args = provider.buildPrintArgv({ bin, prompt, model, readOnly: true, allowedTools: ["Read Grep Glob"], readConfig: readCfg }).slice(1);
  return { bin, args };
}

const defaults = { role: "ORCHESTRATOR", readOnly: true, allowedTools: ["Read Grep Glob"] };

describe.each(["claude", "agy"])("provedor %s", (id) => {
  test("dado o provedor ativo e os padrões, então bin e args são os do --deep", () => {
    process.env.HADES_PROVIDER = id;
    process.env.HADES_PROVIDER_ORCHESTRATOR = id;
    process.env.HADES_MOIRAI_DEEP_TIMEOUT_S = "42";
    const spec = printArgvSpec({ ...defaults, prompt: "estime isto" });
    const deep = deepArgv("estime isto");
    expect(spec.bin).toBe(deep.bin);
    expect(spec.args).toEqual(deep.args);
    expect(spec.cwd).toBe(skillRoot);
    expect(spec.timeout_s).toBe(42);
  });
});

describe("opções", () => {
  test("dado timeout 0, então o piso é 1 s", () => {
    process.env.HADES_MOIRAI_DEEP_TIMEOUT_S = "0";
    expect(printArgvSpec(defaults).timeout_s).toBe(1);
  });
  test("dado --allow-tools, então as ferramentas entram no argv do claude", () => {
    process.env.HADES_PROVIDER = "claude";
    process.env.HADES_PROVIDER_ORCHESTRATOR = "claude";
    expect(printArgvSpec({ ...defaults, allowedTools: ["Read"] }).args).toContain("Read");
  });
  test("dado HADES_CHAT_BIN no claude, então vira o bin", () => {
    process.env.HADES_PROVIDER = "claude";
    process.env.HADES_PROVIDER_ORCHESTRATOR = "claude";
    process.env.HADES_CHAT_BIN = "/opt/claude-x";
    expect(printArgvSpec(defaults).bin).toBe("/opt/claude-x");
  });
});

describe("comando", () => {
  test("dado print-argv --prompt, então imprime JSON compacto com as quatro chaves", () => {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => (chunks.push(String(c)), true)) as typeof process.stdout.write;
    let code: number;
    try {
      code = providerCommand(["print-argv", "--prompt", "oi"]);
    } finally {
      process.stdout.write = write;
    }
    expect(code).toBe(0);
    const json = JSON.parse(chunks.join(""));
    expect(Object.keys(json).sort()).toEqual(["args", "bin", "cwd", "timeout_s"]);
    expect(json.args).toContain("oi");
  });
  test("dado subcomando desconhecido, então sai com código de uso", () => {
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      expect(providerCommand(["nada"])).toBe(2);
    } finally {
      process.stdout.write = write;
    }
  });
});
