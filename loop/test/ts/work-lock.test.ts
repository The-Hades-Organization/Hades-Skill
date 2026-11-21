// Convivência de escritores: tmp único em writeJsonAtomic e read-modify-write sob flock em regSet/deliverySet.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic, regSet, readJson, type WorkEnv } from "../../../src/lib/work.ts";
import { deliverySet } from "../../../src/lib/agent-registry.ts";

const ROOT = join(import.meta.dir, "../../..");
const N = 25;

function fixture(): { dir: string; work: WorkEnv } {
  const dir = mkdtempSync(join(tmpdir(), "skill-lock-"));
  mkdirSync(join(dir, "orch", "agents"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  return { dir, work: { orch: join(dir, "orch"), state: join(dir, "state") } as unknown as WorkEnv };
}

const leftovers = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".tmp"));

describe("writeJsonAtomic", () => {
  test("tmp único: o nome do tmp não é fixo e nenhum sobra", () => {
    const { dir } = fixture();
    const file = join(dir, "a.json");
    writeJsonAtomic(file, { a: 1 });
    writeJsonAtomic(file, { a: 2 });
    expect(readJson(file)).toEqual({ a: 2 });
    expect(leftovers(dir)).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  test("falha na escrita apaga o tmp", () => {
    const { dir } = fixture();
    const file = join(dir, "sub", "a.json");
    expect(() => writeJsonAtomic(file, { a: 1 })).toThrow();
    expect(leftovers(dir)).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  test("rename que falha (destino é diretório) apaga o tmp", () => {
    const { dir } = fixture();
    const file = join(dir, "d.json");
    mkdirSync(file);
    expect(() => writeJsonAtomic(file, { a: 1 })).toThrow();
    expect(leftovers(dir)).toEqual([]);
    rmSync(dir, { recursive: true });
  });
});

describe("escritores concorrentes", () => {
  const child = `
    import { regSet } from "${ROOT}/src/lib/work.ts";
    import { deliverySet } from "${ROOT}/src/lib/agent-registry.ts";
    const [orch, state, field, n] = process.argv.slice(2);
    const work = { orch, state } as never;
    for (let i = 0; i < Number(n); i++) {
      regSet(work, "ag", { [field + i]: i });
      deliverySet(work, "k", (d) => ({ ...d, [field + i]: i }));
    }
  `;

  test("dois processos com campos diferentes: nenhum campo some e nenhum .tmp sobra", async () => {
    const { dir, work } = fixture();
    const script = join(dir, "child.ts");
    writeFileSync(script, child);
    const spawn = (field: string) =>
      Bun.spawn(["bun", script, work.orch, work.state, field, String(N)], { stdout: "ignore", stderr: "inherit" });
    const procs = [spawn("a"), spawn("b")];
    for (const p of procs) expect(await p.exited).toBe(0);
    const reg = readJson(join(work.orch, "agents", "ag.json"))!;
    const delivery = (readJson(join(work.state, "global.json"))!.deliveries as Record<string, Record<string, number>>).k;
    for (const field of ["a", "b"]) {
      for (let i = 0; i < N; i++) {
        expect(reg[field + i]).toBe(i);
        expect(delivery[field + i]).toBe(i);
      }
    }
    expect(leftovers(dir)).toEqual([]);
    rmSync(dir, { recursive: true });
  }, 60000);

  test("regSet preserva a posição das chaves existentes e põe as novas no fim", () => {
    const { dir, work } = fixture();
    regSet(work, "ag", { x: 1, y: 2 });
    regSet(work, "ag", { z: 3, x: 9 });
    expect(Object.keys(readJson(join(work.orch, "agents", "ag.json"))!)).toEqual(["x", "y", "z"]);
    deliverySet(work, "k", () => ({ s: 1 }));
    expect(readFileSync(join(work.state, "global.json"), "utf8")).toContain('"version": 2');
    rmSync(dir, { recursive: true });
  });
});
