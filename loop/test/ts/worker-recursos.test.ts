// Recursos do worker (SO, disco, CPU, RAM): parsers com fixtures, coleta que não falha, e worker antigo sem os campos.
import { describe, expect, test } from "bun:test";
import { cpuUsedPctBetween, diskUsage, formatRecursos, parseMeminfo, parseOsRelease, parseProcStat, parseRecursos, ramOf, sampleCpuUsedPct, collectRecursos } from "../../../src/lib/worker-recursos.ts";
import { parseWorkerStatus } from "../../../src/panel/gatewatch-proc.ts";

const OS_RELEASE = `NAME="Ubuntu"\nVERSION="24.04.1 LTS (Noble Numbat)"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n`;
const STAT_A = "cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 50 0 50 350 50 0 0 0 0 0\n";
const STAT_B = "cpu  200 0 200 800 100 0 0 0 0 0\n";
const MEMINFO = "MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    4000000 kB\nSwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n";

describe("parseOsRelease", () => {
  test("PRETTY_NAME entre aspas duplas", () => expect(parseOsRelease(OS_RELEASE)).toBe("Ubuntu 24.04.1 LTS"));
  test("aspas simples e sem aspas", () => {
    expect(parseOsRelease("PRETTY_NAME='Arch Linux'\n")).toBe("Arch Linux");
    expect(parseOsRelease("PRETTY_NAME=CachyOS\n")).toBe("CachyOS");
  });
  test("sem a chave ou vazio: undefined", () => {
    expect(parseOsRelease("NAME=x\n")).toBeUndefined();
    expect(parseOsRelease("")).toBeUndefined();
    expect(parseOsRelease('PRETTY_NAME=""\n')).toBeUndefined();
  });
});

describe("/proc/stat", () => {
  test("idle soma iowait; total soma user..steal", () => expect(parseProcStat(STAT_A)).toEqual({ idle: 800, total: 1000 }));
  test("percentual entre duas leituras", () => {
    const a = parseProcStat(STAT_A)!;
    const b = parseProcStat(STAT_B)!;
    expect(cpuUsedPctBetween(a, b)).toBe(67);
  });
  test("sem intervalo medido, undefined; texto sem linha cpu, undefined", () => {
    const a = parseProcStat(STAT_A)!;
    expect(cpuUsedPctBetween(a, a)).toBeUndefined();
    expect(parseProcStat("intr 1 2 3\n")).toBeUndefined();
    expect(parseProcStat("cpu  1 2\n")).toBeUndefined();
  });
  test("amostra usa o relógio injetado e não falha sem /proc/stat", () => {
    const reads = [STAT_A, STAT_B];
    const waits: number[] = [];
    expect(sampleCpuUsedPct(() => reads.shift(), (ms) => waits.push(ms))).toBe(67);
    expect(waits).toEqual([200]);
    expect(sampleCpuUsedPct(() => undefined, () => undefined)).toBeUndefined();
  });
});

describe("/proc/meminfo e disco", () => {
  test("RAM usada = total − disponível; swap em GB", () => {
    expect(ramOf(parseMeminfo(MEMINFO))).toEqual({ memUsedGb: 11.4, memUsedPct: 75, swapTotalGb: 2, swapFreeGb: 1 });
  });
  test("meminfo sem swap ou vazio: só o que veio", () => {
    expect(ramOf(parseMeminfo("MemTotal: 1048576 kB\nMemAvailable: 524288 kB\n"))).toEqual({ memUsedGb: 0.5, memUsedPct: 50 });
    expect(ramOf(parseMeminfo(""))).toEqual({});
  });
  test("disco usado = total − livre; total zero ou ausente, sem campos", () => {
    expect(diskUsage(30.8, 88.4)).toEqual({ diskUsedGb: 57.6, diskUsedPct: 65 });
    expect(diskUsage(1, 0)).toEqual({});
    expect(diskUsage(undefined, 10)).toEqual({});
  });
});

describe("coleta e contrato", () => {
  test("collectRecursos nunca lança e traz SO e kernel", () => {
    const r = collectRecursos({ diskFreeGb: 10, diskTotalGb: 100 });
    expect(r.os?.name.length).toBeGreaterThan(0);
    expect(r.os?.kernel.length).toBeGreaterThan(0);
    expect(r.diskUsedGb).toBe(90);
  });
  test("parseRecursos descarta o que não tem o formato", () => {
    expect(parseRecursos({ diskUsedGb: "x", cpuUsedPct: -1, load1: 0.5, os: { name: "A", kernel: 3 }, cpuModel: "" })).toEqual({ load1: 0.5, os: { name: "A", kernel: "", arch: "" } });
    expect(parseRecursos({ os: [] })).toEqual({});
  });
  test("worker antigo, sem os campos novos: o painel lê e mostra traço", () => {
    const old = JSON.stringify({ host: "w", labels: [], memFreeGb: 1, memTotalGb: 2, cpus: 4, queue: 0, warm: {} });
    const s = parseWorkerStatus(old);
    expect(s).toEqual({ host: "w", labels: [], memFreeGb: 1, memTotalGb: 2, cpus: 4, queue: 0, warm: {} });
    expect(formatRecursos(s!)).toEqual(["SO\t—", "disco\t—", "CPU\t— · 4 núcleos · carga — · — em uso", "RAM\t—"]);
  });
  test("worker novo: o painel guarda os campos validados", () => {
    const s = parseWorkerStatus(JSON.stringify({ host: "w", labels: [], memFreeGb: 1, memTotalGb: 2, cpus: 4, queue: 0, warm: {}, os: { name: "Ubuntu", kernel: "6.8", arch: "x64" }, memUsedGb: 1, memUsedPct: 50, cpuUsedPct: 12 }));
    expect(s?.os?.name).toBe("Ubuntu");
    expect(s?.cpuUsedPct).toBe(12);
  });
  test("linhas de texto com todos os campos", () => {
    const lines = formatRecursos({ cpus: 8, memTotalGb: 16, diskTotalGb: 100, os: { name: "Ubuntu", kernel: "6.8", arch: "x64" }, diskUsedGb: 40, diskUsedPct: 40, cpuModel: "X", load1: 1, load5: 2, load15: 3, cpuUsedPct: 5, memUsedGb: 4, memUsedPct: 25, swapTotalGb: 2, swapFreeGb: 1 });
    expect(lines).toEqual(["SO\tUbuntu · kernel 6.8 · x64", "disco\t40/100 GB (40%)", "CPU\tX · 8 núcleos · carga 1 2 3 · 5% em uso", "RAM\t4/16 GB (25%) · swap 1/2 GB"]);
  });
});
