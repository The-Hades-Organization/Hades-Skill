// HADES_MOIRAI_IMPL: `rust` delega o `hades moirai` ao binário (argv, stdin, saída e código repassados); `ts` e o padrão não mudam.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../../src/cli.ts");
const root = mkdtempSync(join(tmpdir(), "moirai-flag-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const stub = join(root, "moirai");
writeFileSync(stub, `#!/bin/sh\\necho "argv:$*"\\nread l; echo "stdin:$l"\\necho "erro" >&2\\nexit 7\\n`.replace(/\\n/g, "\n"));
chmodSync(stub, 0o755);

function hades(args: string[], env: Record<string, string>, input = "") {
  const home = join(root, "home");
  const r = Bun.spawnSync([process.execPath, CLI, ...args], {
    stdin: new TextEncoder().encode(input),
    env: { PATH: process.env.PATH ?? "", HOME: home, HADES_HOME: home, ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("HADES_MOIRAI_IMPL", () => {
  test("dado rust e binário em HADES_MOIRAI_BIN, então argv, stdin, saída, erro e código passam", () => {
    const r = hades(["moirai", "history", "--json"], { HADES_MOIRAI_IMPL: "rust", HADES_MOIRAI_BIN: stub }, "oi\n");
    expect(r.out).toBe("argv:history --json\nstdin:oi\n");
    expect(r.err).toBe("erro\n");
    expect(r.code).toBe(7);
  });

  test("dado rust e moirai só no PATH, então o do PATH roda", () => {
    const bin = join(root, "pathbin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    Bun.spawnSync(["cp", stub, join(bin, "moirai")]);
    const r = hades(["moirai", "x"], { HADES_MOIRAI_IMPL: "rust", PATH: `${bin}:${process.env.PATH}` }, "a\n");
    expect(r.out).toBe("argv:x\nstdin:a\n");
    expect(r.code).toBe(7);
  });

  test("dado rust sem binário, então 69 com mensagem clara e sem cair no TS", () => {
    const r = hades(["moirai", "history"], { HADES_MOIRAI_IMPL: "rust", PATH: "/nonexistent" });
    expect(r.code).toBe(69);
    expect(r.err).toContain("HADES_MOIRAI_IMPL=rust");
    expect(r.out).toBe("");
  });

  test("dado valor inválido, então 2", () => {
    const r = hades(["moirai"], { HADES_MOIRAI_IMPL: "go" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("ts ou rust");
  });

  test("dado o padrão ou ts, então o TS responde e o stub não roda", () => {
    for (const env of [{} as Record<string, string>, { HADES_MOIRAI_IMPL: "ts" }]) {
      const r = hades(["moirai"], { ...env, HADES_MOIRAI_BIN: stub });
      expect(r.out).not.toContain("argv:");
      expect(r.code).toBe(2);
    }
  });
});
