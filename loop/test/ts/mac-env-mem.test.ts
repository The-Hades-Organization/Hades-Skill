// Ambiente local e teto de memória no macOS, provados no Linux: o vigia de RSS com árvore falsa, o gate-lock com o vigia
// ligado (HADES_MEM_WATCH=1), `hades svc` e o svc.sh de um pacote contra o launchctl falso, as checagens de unit do kit
// e o aviso do apply-slice. O que só um Mac real prova está no report da unidade.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { MemWatch, OOM_EXIT, parsePsTree, treeOf, treeRssMb, type ProcRow } from "../../../src/lib/mem-watch.ts";
import { parseLsofCwds, parsePsProcs, psClockSeconds } from "../../../src/panel/gatewatch-proc.ts";
import { Rig, SKILL, STUBS, kv } from "./lib/rig";

const KB_PER_MB = 1024;
const row = (pid: number, ppid: number, mb: number): ProcRow => ({ pid, ppid, rssKb: mb * KB_PER_MB });

/** Árvore falsa: 100 (gate) → 101 (filho) → 102 (neto); o teste muda `procs` entre as amostras. */
function fakeWatch(capMb: number, over: { freeMb?: () => number; floorMb?: number } = {}) {
  const state = { procs: [row(100, 1, 10), row(101, 100, 20), row(102, 101, 30), row(7, 1, 9000)] };
  const signals: string[] = [];
  const timers: (() => void)[] = [];
  const watch = new MemWatch({
    rootPid: 100, capMb, snapshot: () => state.procs, signal: (pid, sig) => signals.push(`${sig}:${pid}`),
    later: (fn) => { timers.push(fn); return () => timers.splice(timers.indexOf(fn), 1); }, freeMb: over.freeMb ?? (() => 8000), floorMb: over.floorMb,
  });
  return { state, signals, timers, watch };
}

describe("vigia de RSS: árvore", () => {
  test("dado o ps, linha fora do formato é descartada", () => {
    expect(parsePsTree("  1     0  1200\n 42     1   300\nlixo\n\n")).toEqual([row(1, 0, 1200 / KB_PER_MB), row(42, 1, 300 / KB_PER_MB)].map((r) => ({ ...r, rssKb: r.pid === 1 ? 1200 : 300 })));
  });
  test("a árvore é a raiz e os descendentes; processo alheio fica de fora", () => {
    const tree = treeOf([row(100, 1, 10), row(101, 100, 20), row(102, 101, 30), row(7, 1, 9000)], 100);
    expect(tree.map((r) => r.pid).sort()).toEqual([100, 101, 102]);
    expect(treeRssMb(tree)).toBe(60);
  });
  test("raiz que já saiu: os filhos ainda ligados a ela contam", () => {
    expect(treeOf([row(101, 100, 20)], 100).map((r) => r.pid)).toEqual([101]);
  });
  test("ciclo de ppid não trava", () => {
    expect(treeOf([row(100, 101, 1), row(101, 100, 1)], 100).length).toBe(2);
  });
});

describe("vigia de RSS: teto", () => {
  test("dentro do teto: nada é morto e o pico é o maior visto", () => {
    const { state, signals, watch } = fakeWatch(100);
    watch.tick();
    state.procs = [row(100, 1, 10), row(101, 100, 70)];
    watch.tick();
    state.procs = [row(100, 1, 10)];
    watch.tick();
    expect(signals).toEqual([]);
    expect(watch.peakMb).toBe(80);
    expect(watch.killedFor).toBeUndefined();
  });
  test("o filho estoura: TERM no grupo e em cada pid, e KILL só depois do prazo", () => {
    const { state, signals, timers, watch } = fakeWatch(100);
    state.procs = [row(100, 1, 10), row(101, 100, 200)];
    watch.tick();
    expect(signals).toEqual(["SIGTERM:-100", "SIGTERM:100", "SIGTERM:101"]);
    expect(watch.killedFor).toEqual({ kind: "cap", treeMb: 210, capMb: 100 });
    expect(timers.length).toBe(1);
    timers[0]?.();
    expect(signals.slice(3)).toEqual(["SIGKILL:-100", "SIGKILL:100", "SIGKILL:101"]);
  });
  test("o neto estoura: a soma da árvore passa do teto e o neto também leva o sinal", () => {
    const { state, signals, watch } = fakeWatch(100);
    state.procs = [row(100, 1, 10), row(101, 100, 20), row(102, 101, 90)];
    watch.tick();
    expect(signals).toContain("SIGTERM:102");
    expect(watch.killedFor?.kind).toBe("cap");
  });
  test("estouro exato do teto não mata: só o que passa", () => {
    const { state, signals, watch } = fakeWatch(100);
    state.procs = [row(100, 1, 40), row(101, 100, 60)];
    watch.tick();
    expect(signals).toEqual([]);
  });
  test("depois de matar, outra amostra não repete o TERM", () => {
    const { state, signals, watch } = fakeWatch(100);
    state.procs = [row(100, 1, 500)];
    watch.tick();
    const n = signals.length;
    watch.tick();
    expect(signals.length).toBe(n);
  });
  test("o KILL pega o neto que ficou vivo depois do TERM, mesmo fora do grupo", () => {
    const { state, signals, timers, watch } = fakeWatch(100);
    state.procs = [row(100, 1, 10), row(101, 100, 20), row(102, 101, 200)];
    watch.tick();
    state.procs = [row(100, 1, 10), row(102, 101, 200)];
    timers[0]?.();
    expect(signals.filter((s) => s.startsWith("SIGKILL"))).toContain("SIGKILL:102");
  });
  test("processo que some entre duas amostras: sem erro e o pico fica", () => {
    const { state, watch } = fakeWatch(100);
    state.procs = [row(100, 1, 10), row(101, 100, 50)];
    watch.tick();
    state.procs = [];
    expect(() => watch.tick()).not.toThrow();
    expect(watch.peakMb).toBe(60);
  });
  test("stop depois do estouro manda KILL ao grupo (órfão do TERM) e cancela o prazo", () => {
    const { state, signals, timers, watch } = fakeWatch(100);
    state.procs = [row(100, 1, 500)];
    watch.tick();
    expect(watch.stop()).toBe(500);
    expect(timers.length).toBe(0);
    expect(signals.at(-1)).toBe("SIGKILL:-100");
  });
  test("stop sem estouro não manda sinal nenhum", () => {
    const { signals, watch } = fakeWatch(100);
    watch.tick();
    watch.stop();
    expect(signals).toEqual([]);
  });
});

describe("vigia de RSS: memória livre", () => {
  test("abaixo do piso a árvore cai mesmo dentro do teto", () => {
    const { signals, watch } = fakeWatch(1000, { freeMb: () => 300, floorMb: 512 });
    watch.tick();
    expect(watch.killedFor).toEqual({ kind: "free", freeMb: 300, floorMb: 512 });
    expect(signals[0]).toBe("SIGTERM:-100");
  });
  test("leitura que falhou (0) não é falta de memória", () => {
    const { signals, watch } = fakeWatch(1000, { freeMb: () => 0 });
    watch.tick();
    expect(signals).toEqual([]);
  });
  test("o piso é o padrão de 512 MB quando não se informa", () => {
    const { signals, watch } = fakeWatch(1000, { freeMb: () => 511 });
    watch.tick();
    expect(signals.length).toBeGreaterThan(0);
  });
});

describe("painel de gates no macOS: ps e lsof", () => {
  test("relógio do ps: mm:ss.cc, hh:mm:ss e dd-hh:mm:ss", () => {
    expect(psClockSeconds("0:01.50")).toBe(1.5);
    expect(psClockSeconds("01:02:03")).toBe(3723);
    expect(psClockSeconds("2-01:00:00")).toBe(2 * 86400 + 3600);
  });
  test("linha do ps vira Proc com RSS em bytes, idade negativa em ticks (sem relógio) e o cwd do lsof", () => {
    const text = "  42     1  2048  0:02.00  01:00 /usr/bin/node\nlixo\n";
    const [p] = parsePsProcs(text, { commands: new Map([[42, "node /x/nx.js run test"]]), cwds: parseLsofCwds("p42\nfcwd\nn/repo/app\np7\nn/outro\n") });
    expect(p).toMatchObject({ pid: 42, ppid: 1, comm: "node", cmd: "node /x/nx.js run test", rss: 2048 * 1024, cpu: 200, start: -6000, cwd: "/repo/app" });
  });
});

const r = new Rig().setup();
afterAll(() => r.cleanup());
const D = `${r.T}/mem-d`, LC = `${r.T}/mem-launchctl`, BB = `${r.T}/mem-bin`;
mkdirSync(BB, { recursive: true });
mkdirSync(D, { recursive: true });
symlinkSync(`${STUBS}/launchctl`, `${BB}/launchctl`);
const BUN = process.execPath;
const launchd = (extra: Record<string, string> = {}) => kv({ PATH: `${BB}:${r.env0.PATH}`, HADES_DATA: D, D, FAKE_LAUNCHCTL_DIR: LC, HADES_SERVICE_MANAGER: "launchd",
  HADES_ID: "", USER: "regressao", HADES_CLI: `${BUN} ${SKILL}/src/cli.ts` }, extra);
const svc = (args: string[], extra: Record<string, string> = {}) => r.hades(["svc", ...args], { env: launchd(extra), merge: true, cwd: r.T });
const pack = (args: string[], extra: Record<string, string> = {}) => r.X(["bash", `${SKILL}/loop/test/fixtures/svc-pack/env/svc.sh`, ...args], { env: launchd(extra), merge: true, cwd: r.T });
const LABEL = "com.hades.hds.api";

describe("hades svc no launchd (launchctl falso)", () => {
  test("run grava o plist privado, carrega o serviço e status diz active", () => {
    const o = svc(["run", "api", "--env", "K=v", "--", "sleep", "300"]);
    expect(o.rc).toBe(0);
    expect(existsSync(`${LC}/loaded/${LABEL}`)).toBe(true);
    const plist = readFileSync(`${r.H}/.claude/hades/launchd/${LABEL}.plist`, "utf8");
    expect(plist).toContain("<key>K</key><string>v</string>");
    expect(plist).toMatch(/<string>\/[^<]*sleep<\/string>/);
    expect(plist).not.toContain("KeepAlive");
    expect(svc(["status", "api"]).out).toBe("active\n");
  });
  test("list mostra só o serviço do pacote, não o painel nem os jobs do Hades", () => {
    r.must(r.X(["bash", "-c", `mkdir -p '${LC}/loaded'; echo running > '${LC}/loaded/com.hades.hds.panel'; echo running > '${LC}/loaded/com.hades.hds.pjob-1'`], { env: launchd() }));
    expect(svc(["list"]).out).toBe("api\n");
  });
  test("run de novo troca o que estava no ar, sem erro de já carregado", () => {
    expect(svc(["run", "api", "--", "sleep", "301"]).rc).toBe(0);
    expect(existsSync(`${LC}/loaded/${LABEL}`)).toBe(true);
  });
  test("o log padrão fica em <D>/logs/<unit>.log", () => {
    expect(readFileSync(`${r.H}/.claude/hades/launchd/${LABEL}.plist`, "utf8")).toContain(`${D}/logs/hds-api.log`);
  });
  test("--slice só avisa; comando inexistente sai 127", () => {
    expect(svc(["run", "web", "--slice", "hades.slice", "--", "sleep", "1"]).all).toContain("--slice hades.slice ignorado");
    expect(svc(["run", "x", "--", "comando-que-nao-existe-aqui"]).rc).toBe(127);
  });
  test("nome inválido e uso sem '--' saem 2", () => {
    expect(svc(["run", "A/b", "--", "sleep", "1"]).rc).toBe(2);
    expect(svc(["run", "api"]).rc).toBe(2);
    expect(svc(["voar"]).rc).toBe(2);
  });
  test("stop descarrega; status vira inactive (sai 3); stop de novo sai 0", () => {
    expect(svc(["stop", "api"]).rc).toBe(0);
    expect(existsSync(`${LC}/loaded/${LABEL}`)).toBe(false);
    const s = svc(["status", "api"]);
    expect([s.out, s.rc]).toEqual(["inactive\n", 3]);
    expect(svc(["stop", "api"]).rc).toBe(0);
  });
  test("is-active e is-enabled pelo nome completo da unit", () => {
    svc(["run", "api", "--", "sleep", "300"]);
    expect(svc(["is-active", "hds-api"]).rc).toBe(0);
    expect(svc(["is-active", "hds-nada"]).rc).toBe(1);
    expect(svc(["is-enabled", "hds-api"]).rc).toBe(1);
  });
  test("instância com HADES_ID prefixa a unit com hds_<id>", () => {
    expect(svc(["run", "api", "--", "sleep", "1"], { HADES_ID: "app2" }).rc).toBe(0);
    expect(existsSync(`${LC}/loaded/com.hades.hds_app2.api`)).toBe(true);
    expect(svc(["list"], { HADES_ID: "app2" }).out).toBe("api\n");
  });
});

describe("svc.sh de pacote (fixture) no launchd", () => {
  test("up, status, list e down passam pelo hades svc", () => {
    expect(pack(["up", "db"]).rc).toBe(0);
    expect(pack(["status", "db"]).out).toBe("active\n");
    expect(pack(["list"]).out).toContain("db\n");
    expect(pack(["down", "db"]).rc).toBe(0);
    expect(pack(["status", "db"]).rc).toBe(3);
  });
});

describe("kit: checagens de unit, linger e slice no launchd", () => {
  const chk = (fn: string, extra: Record<string, string> = {}) =>
    r.X(["bash", "-c", `source '${SKILL}/kit/lib-checks.sh'; ${fn}`], { env: launchd({ HADES_KIT_DIR: `${SKILL}/kit`, ...extra }), merge: true, cwd: r.T });
  test("chk_unit_active acompanha o launchd e chk_unit_enabled é falso sem plist em LaunchAgents", () => {
    svc(["run", "api", "--", "sleep", "300"]);
    expect(chk("chk_unit_active hds-api").rc).toBe(0);
    expect(chk("chk_unit_active hds-nada").rc).toBe(1);
    expect(chk("chk_unit_enabled hds-api").rc).toBe(1);
  });
  test("chk_linger é falso no launchd (n/a)", () => {
    expect(chk("chk_linger").rc).toBe(1);
  });
  test("fw_cmd no launchd não propõe ufw", () => {
    expect(chk("fw_cmd").out).not.toContain("ufw");
  });
  test("fw_cmd no launchd sem rede docker da instância não propõe ufw", () => {
    expect(chk("fw_cmd", { HPROJ: "hades_sem_rede_no_teste", HADES_DOCTOR_SUBNET: "" }).out).not.toContain("ufw");
  });
  test("apply-slice no launchd só avisa, sai 0 e não grava slice", () => {
    const o = r.X(["bash", `${SKILL}/kit/config.sh`, "apply-slice"], { env: launchd(), merge: true, cwd: r.T });
    expect(o.rc).toBe(0);
    expect(o.out).toContain("macOS: sem slice");
    expect(existsSync(`${r.H}/.config/systemd/user`)).toBe(false);
  });
});

describe("gate-lock com o vigia de memória (HADES_MEM_WATCH=1)", () => {
  const GE = { HADES_GATE_RESERVE_GB: "0", HADES_GATE_PSI_MAX: "100", HADES_MEM_WATCH: "1", HADES_MEM_WATCH_FLOOR_MB: "0" };
  const gate = (label: string, cmd: string[], extra: Record<string, string> = {}) =>
    r.hades(["gate-lock", "run", "lint", "--label", label, "--timeout", "30", "--", ...cmd], { cwd: r.C, merge: true, env: { ...GE, ...extra } });
  test("dentro do teto: sai com o código do filho e grava o pico lido pelo `peak`", () => {
    const o = gate("mw-ok", ["sh", "-c", "sleep 1; exit 3"]);
    expect(o.rc).toBe(3);
    const peak = r.hades(["gate-lock", "peak", "mw-ok"], { cwd: r.C, merge: true, env: GE });
    expect(peak.rc).toBe(0);
    expect(Number(peak.out.trim())).toBeGreaterThan(0);
  });
  test("memória livre abaixo do piso: derruba a árvore inteira (neto incluso) e sai 137", () => {
    const o = gate("mw-free", ["sh", "-c", "sleep 60 & sleep 60"], { HADES_MEM_WATCH_FLOOR_MB: "999999999" });
    expect(o.rc).toBe(OOM_EXIT);
    expect(o.all).toContain("vigia de memoria");
    expect(o.all).not.toContain("journalctl");
  });
  test("HADES_GATE_MEMCAP=0 desliga o vigia: o comando roda sem teto, mesmo com o piso absurdo", () => {
    const o = gate("mw-off", ["sh", "-c", "sleep 1; exit 0"], { HADES_GATE_MEMCAP: "0", HADES_MEM_WATCH_FLOOR_MB: "999999999" });
    expect(o.rc).toBe(0);
  });
});
