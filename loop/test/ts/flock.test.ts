import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlockTimeoutError, withFlockAsync } from "../../../src/lib/flock";

const FLOCK_LIB = join(import.meta.dir, "../../../src/lib/flock.ts");
const dir = mkdtempSync(join(tmpdir(), "hades-flock-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Outro processo que segura o lock do arquivo por `ms` e avisa no stdout quando o tomou. */
function holder(path: string, ms: number) {
  const code = `import { withFlockAsync } from ${JSON.stringify(FLOCK_LIB)};
await withFlockAsync(${JSON.stringify(path)}, async () => { console.log("L"); await Bun.sleep(${ms}); });`;
  return Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "inherit" });
}

async function held(proc: ReturnType<typeof holder>): Promise<void> {
  const reader = proc.stdout.getReader();
  await reader.read();
  reader.releaseLock();
}

describe("withFlockAsync com prazo", () => {
  test("dado o lock em outro processo, quando ele solta dentro do prazo, então entra depois", async () => {
    const path = join(dir, "espera.mutex");
    const proc = holder(path, 400);
    await held(proc);
    const start = Date.now();
    const got = await withFlockAsync(path, async () => "entrei", 5);
    expect(got).toBe("entrei");
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
    await proc.exited;
  });

  test("dado o lock em outro processo, quando o prazo estoura, então lança FlockTimeoutError com a mensagem de sempre", async () => {
    const path = join(dir, "prazo.mutex");
    const proc = holder(path, 2500);
    await held(proc);
    let error: unknown;
    try {
      await withFlockAsync(path, async () => "nunca", 1);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FlockTimeoutError);
    expect((error as Error).message).toBe(`flock de ${path} nao veio em 1 s`);
    proc.kill();
    await proc.exited;
  });

  test("dado uma exceção dentro da seção, quando ela sobe, então o lock já está solto", async () => {
    const path = join(dir, "excecao.mutex");
    await expect(withFlockAsync(path, async () => { throw new Error("boom"); }, 1)).rejects.toThrow("boom");
    expect(await withFlockAsync(path, async () => "livre", 0.2)).toBe("livre");
  });

  test("dado dois chamadores no mesmo processo, quando o primeiro segura, então o segundo espera sem entrar junto", async () => {
    const path = join(dir, "mesmo.mutex");
    const order: string[] = [];
    const first = withFlockAsync(path, async () => { order.push("a1"); await Bun.sleep(150); order.push("a2"); }, 5);
    await Bun.sleep(20);
    const second = withFlockAsync(path, async () => { order.push("b"); }, 5);
    await Promise.all([first, second]);
    expect(order.join(" ")).toBe("a1 a2 b");
  });
});
