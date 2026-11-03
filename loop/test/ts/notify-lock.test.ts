// Issue 3: o vigia travava contra o próprio lock (flock bloqueante por FFI com o envio do ntfy esperando a rede dentro
// da seção) e todo notify da instância, inclusive o do agent decide, ficava na fila para sempre.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forget, history, notify, NotifyContext } from "../../../src/lib/notify";

const FLOCK_LIB = join(import.meta.dir, "../../../src/lib/flock.ts");
const SLOW_MS = 400;
const dir = mkdtempSync(join(tmpdir(), "hades-notify-lock-"));
const ENV = { HADES_NOTIFY: "1", HADES_NOTIFY_NTFY: "1", HADES_NOTIFY_DESKTOP: "0", HADES_NOTIFY_QUIET: "", HADES_NOTIFY_LOCK_WAIT_S: "1" };
const saved: Record<string, string | undefined> = {};
let server: ReturnType<typeof Bun.serve>;
let hits = 0;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: async () => { hits++; await Bun.sleep(SLOW_MS); return new Response("ok"); } });
  for (const [k, v] of Object.entries({ ...ENV, HADES_NOTIFY_NTFY_URL: `http://127.0.0.1:${server.port}` })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  server.stop(true);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const ctxIn = (name: string): NotifyContext => new NotifyContext(join(dir, name));

/** Outro processo que tenta o lock do arquivo com prazo curto e diz se conseguiu. */
function tryLock(path: string, ms: number) {
  const code = `import { withFlockAsync } from ${JSON.stringify(FLOCK_LIB)};
try { await withFlockAsync(${JSON.stringify(path)}, async () => {}, ${ms / 1000}); console.log("livre"); } catch { console.log("preso"); }`;
  return Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "inherit" });
}

/** Outro processo que segura o lock por `ms` e avisa quando o tomou. */
async function holdLock(path: string, ms: number) {
  const code = `import { withFlockAsync } from ${JSON.stringify(FLOCK_LIB)};
await withFlockAsync(${JSON.stringify(path)}, async () => { console.log("L"); await Bun.sleep(${ms}); });`;
  const proc = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  return proc;
}

describe("notify sob lock (issue 3)", () => {
  test("dado dois notify e um forget concorrentes no mesmo processo com o ntfy lento, então os três terminam", async () => {
    const ctx = ctxIn("concorrente");
    const before = hits;
    const all = Promise.all([
      notify(ctx, "agent", "info", "primeiro", { obj: "a", src: "s1" }),
      notify(ctx, "agent", "warn", "segundo", { obj: "b", src: "s2" }),
      forget(ctx, "s1", new Set()),
    ]);
    const [a, b] = await Promise.race([all, Bun.sleep(5000).then(() => { throw new Error("travou"); })]);
    expect(a.sent && b.sent).toBe(true);
    expect(hits - before).toBe(2);
    expect(history(ctx).map((h) => h.text).sort()).toEqual(["primeiro", "segundo"]);
  });

  test("dado um envio esperando a rede, então o lock da instância está livre para outro processo", async () => {
    const ctx = ctxIn("rede-fora");
    const sending = notify(ctx, "agent", "info", "lento", { obj: "x" });
    await Bun.sleep(SLOW_MS / 4);
    const other = tryLock(ctx.lockFile, 200);
    expect((await new Response(other.stdout).text()).trim()).toBe("livre");
    expect((await sending).sent).toBe(true);
  });

  test("dado o lock preso por outro processo além do prazo, então o notify sai sem enviar e sem travar", async () => {
    const ctx = ctxIn("preso");
    await notify(ctx, "agent", "info", "cria a pasta", { obj: "y", test: true });
    const holder = await holdLock(ctx.lockFile, 3000);
    const start = Date.now();
    const result = await notify(ctx, "agent", "info", "depois", { obj: "z" });
    expect(result).toEqual({ sent: false, why: "lock do notify ocupado" });
    expect(Date.now() - start).toBeLessThan(2500);
    await forget(ctx, "qualquer", new Set());
    holder.kill();
    await holder.exited;
  });

  test("dado o mesmo evento repetido na janela, então o segundo é barrado pelo dedupe reservado antes do envio", async () => {
    const ctx = ctxIn("dedupe");
    const [first, second] = await Promise.all([
      notify(ctx, "agent", "info", "igual", { obj: "d" }),
      notify(ctx, "agent", "info", "igual", { obj: "d" }),
    ]);
    expect([first.sent, second.sent].sort()).toEqual([false, true]);
    expect([first, second].find((r) => !r.sent)).toEqual({ sent: false, why: "repetido na janela" });
  });
});
