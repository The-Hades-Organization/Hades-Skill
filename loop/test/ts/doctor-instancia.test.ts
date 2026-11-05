// doctor numa instância a mais e numa máquina limpa: resolve a instância fora do env.sh, reconhece o painel em primeiro
// plano da própria instância, confere o slice carregado e não acusa as portas de outra instância registrada.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { BUN, FX, Rig, SKILL } from "./lib/rig";
import { miInstalled } from "./lib/mi";
import { belongsTo, identityOf } from "../../../src/lib/doctor-instancias";
import { judgeSlice, parseSliceShow } from "../../../src/lib/doctor-slice";
import { fetchBaseArgs } from "../../../src/lib/install-worktree";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const M = miInstalled(r, FX);
const { MI, MH, SC, BB, D1, D2, wt1 } = M;
// ss falso com pid: o dono da porta é um processo de verdade, para o doctor ler o /proc dele
writeFileSync(`${BB}/ss`, '#!/usr/bin/env bash\nprintf "%s\\n" "${FAKE_SS_LINES:-}"\n');
chmodSync(`${BB}/ss`, 0o755);

type Item = { id: string; level: string; msg: string };
const HADES = [BUN, `${SKILL}/src/cli.ts`];
const items = (out: string): Item[] => (JSON.parse(out) as { items: Item[] }).items;
const item = (out: string, id: string): Item => items(out).find((i) => i.id === id) ?? { id, level: "ausente", msg: "" };

const freePort = (): Promise<number> => new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
/** Processo que escuta na porta com o ambiente dado e sem nada na linha de comando que o ligue a uma instância. */
async function listener(port: number, env: Record<string, string>): Promise<{ pid: number; stop: () => void }> {
  const child = Bun.spawn([BUN, "-e", `Bun.serve({port:${port},fetch:()=>new Response("ok")});setInterval(()=>{},1000)`], { env: { PATH: process.env.PATH ?? "", ...env }, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await Bun.sleep(50); }
  }
  return { pid: child.pid, stop: () => child.kill() };
}
const doctorPortas = (D: string, port: number, pid: number) =>
  item(MI([...HADES, "doctor", "--quick", "--json"], { HADES_DATA: D, HADES_PANEL_PORT: String(port), HADES_WIDGET_PORT: String(port), FAKE_SS_LINES: `LISTEN 0 512 *:${port} *:* users:(("bun",pid=${pid},fd=7))` }, { cwd: wt1 }).out, "portas");

describe("doctor fora do env.sh", () => {
  test("sem HADES_WT nem HADES_DATA, dentro do worktree: acha a instância e o worktree existe", () => {
    const o = MI([...HADES, "doctor", "--quick", "--json"], {}, { cwd: wt1 });
    expect(`${item(o.out, "worktree").level} ${item(o.out, "instance").level}`, o.all).toBe("ok ok");
  });
  test("só com HADES_DATA (sem doctor.sh na pasta), o worktree vem do W do env.sh", () => {
    const dir = `${r.T}/doctor-so-data`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/env.sh`, `W="${wt1}"\n`);
    const o = MI([...HADES, "doctor", "--quick", "--json"], { HADES_DATA: dir });
    expect(item(o.out, "worktree").level, o.all).toBe("ok");
  });
});

describe("doctor: portas e instâncias", () => {
  test("painel da própria instância em primeiro plano (sem $D no argv, HADES_DATA no ambiente) não é acusado", async () => {
    const port = await freePort();
    const proc = await listener(port, { HADES_DATA: D1 });
    try { expect(doctorPortas(D1, port, proc.pid).level).toBe("ok"); } finally { proc.stop(); }
  });
  test("processo estranho na porta do painel segue sendo erro", async () => {
    const port = await freePort();
    const proc = await listener(port, {});
    try { expect(doctorPortas(D1, port, proc.pid).level).toBe("error"); } finally { proc.stop(); }
  });
  test("painel de outra instância registrada não é acusado como de fora", async () => {
    const port = await freePort();
    const proc = await listener(port, { HADES_DATA: D2 });
    try { expect(doctorPortas(D1, port, proc.pid).level).toBe("ok"); } finally { proc.stop(); }
  });
  test("belongsTo: ambiente com HADES_DATA de outra pasta não vale", async () => {
    const port = await freePort();
    const proc = await listener(port, { HADES_DATA: D2 });
    try { expect(`${belongsTo(String(proc.pid), identityOf(D1))} ${belongsTo(String(proc.pid), identityOf(D2))}`).toBe("false true"); } finally { proc.stop(); }
  });
});

describe("doctor: slice carregado", () => {
  const slice = `${MH}/.config/systemd/user/hades.slice`;
  const show = `${SC}/show/hades.slice`;
  const run = () => item(MI([...HADES, "doctor", "--quick", "--json"], { HADES_DATA: D1, HADES_SLICE_MAX: "4G" }, { cwd: wt1 }).out, "slice");
  mkdirSync(`${MH}/.config/systemd/user`, { recursive: true });
  mkdirSync(`${SC}/show`, { recursive: true });
  writeFileSync(slice, "[Slice]\nMemoryMax=4G\n");
  test("arquivo instalado mas o systemd não o carregou: erro", () => {
    writeFileSync(show, "LoadState=not-found\nMemoryMax=infinity\n");
    expect(run().level).toBe("error");
  });
  test("carregado com o teto da configuração: ok", () => {
    writeFileSync(show, `LoadState=loaded\nMemoryMax=${4 * 1024 ** 3}\n`);
    expect(run().level).toBe("ok");
  });
  test("carregado com outro teto: aviso", () => {
    writeFileSync(show, `LoadState=loaded\nMemoryMax=${2 * 1024 ** 3}\n`);
    expect(run().level).toBe("warn");
  });
  test("judgeSlice e parseSliceShow: infinity e estado vazio", () => {
    expect(parseSliceShow("LoadState=loaded\nMemoryMax=infinity\n")).toEqual({ loadState: "loaded", memoryMaxBytes: undefined });
    expect(judgeSlice({ loadState: "loaded", memoryMaxBytes: undefined }, 4096)).toBe("teto-diferente");
    expect(judgeSlice({ loadState: "loaded", memoryMaxBytes: undefined }, 0)).toBe("carregado");
    expect(judgeSlice({ loadState: "", memoryMaxBytes: undefined }, 0)).toBe("nao-carregado");
  });
});

describe("install: fetch da base", () => {
  test("com o gh, o helper dele entra depois dos do dono; sem o gh, o fetch é o de sempre", () => {
    expect(fetchBaseArgs("/m", "develop", true)).toEqual(["-C", "/m", "-c", "credential.helper=!gh auth git-credential", "fetch", "-q", "origin", "develop"]);
    expect(fetchBaseArgs("/m", "develop", false)).toEqual(["-C", "/m", "fetch", "-q", "origin", "develop"]);
  });
  test("fetch que falha vira aviso com o motivo, sem o `fatal:` cru do git", () => {
    const clone = `${r.T}/install-fetch-clone`;
    r.must(r.X(["git", "clone", "-q", r.C, clone]));
    r.must(r.git(clone, "remote", "set-url", "origin", `${r.T}/nao-existe.git`));
    const o = MI([BUN, `${SKILL}/src/cli.ts`, "install"], { HADES_DATA: `${r.T}/install-fetch-data`, SKIP_DOCTOR: "1" }, { cwd: clone, merge: true });
    expect(o.all).toContain("aviso: fetch de");
    expect(o.all).not.toContain("fatal:");
  });
});
