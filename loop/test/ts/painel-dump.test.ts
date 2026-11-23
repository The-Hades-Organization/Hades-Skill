// `hades panel dump <rota>` e `HADES_PROC_ROOT`: $D fictício e um /proc de fixture, sem HTTP.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootEpoch, meminfo, procIds, uptime } from "../../../src/panel/system.ts";

const CLI = join(import.meta.dir, "../../../src/cli.ts");
const MEM_TOTAL_KB = 8_000_000;
const MEM_AVAIL_KB = 3_000_000;

let root: string;
let D: string;
let proc: string;

function writeProcFixture(dir: string): void {
  mkdirSync(join(dir, "self"), { recursive: true });
  mkdirSync(join(dir, "4242"), { recursive: true });
  mkdirSync(join(dir, "pressure"), { recursive: true });
  writeFileSync(join(dir, "meminfo"), `MemTotal: ${MEM_TOTAL_KB} kB\nMemAvailable: ${MEM_AVAIL_KB} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n`);
  writeFileSync(join(dir, "stat"), "cpu 1 2 3 4\nbtime 1700000000\n");
  writeFileSync(join(dir, "uptime"), "1234.50 9000.00\n");
  writeFileSync(join(dir, "loadavg"), "0.10 0.20 0.30 1/100 4242\n");
  writeFileSync(join(dir, "pressure", "memory"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
  writeFileSync(join(dir, "4242", "stat"), "4242 (exemplo) S 1 4242 4242 0 -1 0 0 0 0 0 5 5 0 0 20 0 1 0 100 0 10 0\n");
  writeFileSync(join(dir, "4242", "cmdline"), "exemplo\0--flag\0");
  writeFileSync(join(dir, "4242", "statm"), "100 10 0 0 0 0 0\n");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "painel-dump-"));
  D = join(root, "hades-data");
  proc = join(root, "proc");
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(join(root, "work", "exemplo__repo", "locks"), { recursive: true });
  mkdirSync(D, { recursive: true });
  writeFileSync(join(D, "env.sh"), `LOCKS="${join(root, "work", "exemplo__repo", "locks")}"\nW="${join(root, "wt")}"\n`);
  writeProcFixture(proc);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const saved = process.env.HADES_PROC_ROOT;
afterEach(() => {
  if (saved === undefined) delete process.env.HADES_PROC_ROOT;
  else process.env.HADES_PROC_ROOT = saved;
});

function dump(...args: string[]): { rc: number; out: string } {
  const r = Bun.spawnSync(["bun", CLI, "panel", "dump", ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: join(root, "home"), HADES_DATA: D, HADES_PROC_ROOT: proc, WORK_ROOT: join(root, "work") },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { rc: r.exitCode ?? -1, out: r.stdout.toString() };
}

describe("HADES_PROC_ROOT", () => {
  test("system lê meminfo, uptime e pids da raiz trocada", () => {
    process.env.HADES_PROC_ROOT = proc;
    expect(meminfo().MemTotal).toBe(MEM_TOTAL_KB * 1024);
    expect(meminfo().MemAvailable).toBe(MEM_AVAIL_KB * 1024);
    expect(uptime()).toBe(1234.5);
    expect(bootEpoch()).toBe(1700000000);
    expect(procIds()).toEqual(["4242"]);
  });
});

describe("hades panel dump", () => {
  test("rota desconhecida sai com rc 2 e a lista das rotas", () => {
    const { rc, out } = dump("nao-existe");
    expect(rc).toBe(2);
    const body = JSON.parse(out);
    expect(body.code).toBe("unknown_route");
    expect(body.routes).toContain("gates");
    expect(body.routes).toContain("config/inherited");
    expect(body.routes).toContain("moirai/unit/<nome>");
  });

  test("sem rota mostra o uso com rc 2", () => {
    expect(dump().rc).toBe(2);
  });

  test("config/inherited aceita o prefixo /api/ e devolve JSON", () => {
    const plain = dump("config/inherited");
    const prefixed = dump("/api/config/inherited");
    expect(plain.rc).toBe(0);
    expect(JSON.parse(plain.out)).toEqual(JSON.parse(prefixed.out));
  });

  test("config/export imprime o texto exportado, não os bytes, com a data de HADES_NOW", () => {
    copyFileSync(join(import.meta.dir, "../../../kit/config.tsv"), join(D, "config.tsv"));
    const r = Bun.spawnSync(["bun", CLI, "panel", "dump", "config/export"], {
      env: { PATH: process.env.PATH ?? "", HOME: join(root, "home"), HADES_DATA: D, WORK_ROOT: join(root, "work"), HADES_NOW: "2026-01-02T03:04:00", TZ: "UTC" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    const text = r.stdout.toString();
    expect(text).toStartWith("# Configurações do Hades — skill ");
    expect(text).toContain("exportado em 2026-01-02 03:04\n");
    expect(text).not.toContain('"0":');
  });

  test("gates lê a memória do /proc de fixture", () => {
    const { rc, out } = dump("gates");
    expect(rc).toBe(0);
    const body = JSON.parse(out);
    expect(body.available).toBe(true);
    expect(body.host.memTotal).toBe(MEM_TOTAL_KB * 1024);
    expect(body.host.memAvailable).toBe(MEM_AVAIL_KB * 1024);
  });
});
