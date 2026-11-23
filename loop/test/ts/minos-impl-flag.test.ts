// HADES_MINOS_IMPL: `rust` delega o `hades minos` ao binário (argv, stdin, saída e código repassados); `ts` e o padrão não
// mudam. O `saveOutput` grava o outputs.json sob o flock de $D/minos/.lock, o mesmo do binário.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../../src/cli.ts");
const STORE = join(import.meta.dir, "../../../src/lib/minos-store.ts");
const FLOCK = join(import.meta.dir, "../../../src/lib/flock.ts");
const root = mkdtempSync(join(tmpdir(), "minos-flag-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const stub = join(root, "minos");
writeFileSync(stub, '#!/bin/sh\necho "argv:$*"\nread l; echo "stdin:$l"\necho "erro" >&2\nexit 7\n');
chmodSync(stub, 0o755);

function hades(args: string[], env: Record<string, string>, input = "") {
  const home = join(root, "home");
  const r = Bun.spawnSync([process.execPath, CLI, ...args], {
    stdin: new TextEncoder().encode(input),
    env: { PATH: process.env.PATH ?? "", HOME: home, HADES_HOME: home, ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("HADES_MINOS_IMPL", () => {
  test("dado rust e binário em HADES_MINOS_BIN, então argv, stdin, saída, erro e código passam", () => {
    const r = hades(["minos", "list", "--json"], { HADES_MINOS_IMPL: "rust", HADES_MINOS_BIN: stub }, "oi\n");
    expect(r.out).toBe("argv:list --json\nstdin:oi\n");
    expect(r.err).toBe("erro\n");
    expect(r.code).toBe(7);
  });

  test("dado rust e minos só no PATH, então o do PATH roda", () => {
    const bin = join(root, "pathbin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "minos"), readFileSync(stub));
    chmodSync(join(bin, "minos"), 0o755);
    const r = hades(["minos", "schema"], { HADES_MINOS_IMPL: "rust", PATH: `${bin}:${process.env.PATH}` }, "a\n");
    expect(r.out).toBe("argv:schema\nstdin:a\n");
    expect(r.code).toBe(7);
  });

  test("dado rust sem binário, então 69 com mensagem clara e sem cair no TS", () => {
    const r = hades(["minos", "list"], { HADES_MINOS_IMPL: "rust", PATH: "/nonexistent" });
    expect(r.code).toBe(69);
    expect(r.err).toContain("HADES_MINOS_IMPL=rust");
    expect(r.out).toBe("");
  });

  test("dado valor inválido, então 2", () => {
    const r = hades(["minos", "list"], { HADES_MINOS_IMPL: "go" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("ts ou rust");
  });

  test("dado o padrão ou ts, então o TS responde e o stub não roda", () => {
    for (const env of [{} as Record<string, string>, { HADES_MINOS_IMPL: "ts" }]) {
      const r = hades(["minos"], { ...env, HADES_MINOS_BIN: stub });
      expect(r.out).not.toContain("argv:");
      expect(r.code).toBe(2);
    }
  });
});

describe("saveOutput sob flock", () => {
  const rec = (n: number) => ({
    model: "explicacao",
    scope: "personal",
    plan: `p${n}.json`,
    url: null,
    file: `/x/${n}/index.html`,
    updatedAt: "2026-11-23T00:00:00Z",
  });

  test("dado o lock tomado por outro processo, então a gravação espera ele soltar", async () => {
    const state = join(root, "espera");
    mkdirSync(join(state, "minos"), { recursive: true });
    const lock = join(state, "minos", ".lock");
    const holder = Bun.spawn(
      [process.execPath, "-e", `const { withFlock } = await import(${JSON.stringify(FLOCK)}); withFlock(${JSON.stringify(lock)}, () => { console.log("tomado"); Bun.sleepSync(600); });`],
      { stdout: "pipe" },
    );
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("tomado");
    const t0 = Date.now();
    const { saveOutput, readOutputs } = await import(STORE);
    saveOutput(state, "explicacao-a", rec(1));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    await holder.exited;
    expect(Object.keys(readOutputs(state))).toEqual(["explicacao-a"]);
  });

  test("dado 8 gravações concorrentes de processos diferentes, então nenhuma se perde", async () => {
    const state = join(root, "concorrencia");
    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn([
        process.execPath,
        "-e",
        `const { saveOutput } = await import(${JSON.stringify(STORE)}); for (let k = 0; k < 5; k++) saveOutput(${JSON.stringify(state)}, "explicacao-p${i}-" + k, ${JSON.stringify(rec(i))});`,
      ]),
    );
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual(Array(8).fill(0));
    const { readOutputs } = await import(STORE);
    expect(Object.keys(readOutputs(state)).length).toBe(40);
  });
});
