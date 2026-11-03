// Correções do port macOS/launchd apontadas na revisão independente, um teste por item (o número é o do brief), contra o
// launchctl falso (loop/test/stubs/launchctl) com HADES_SERVICE_MANAGER=launchd. O que só um Mac real prova está no report.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { HadesError } from "../../../src/lib/output.ts";
import { parseEverySeconds, parseLaunchctlPrint, activeStateOf, plistString, plistText, plistEnvironment } from "../../../src/lib/launchd-plist.ts";
import { clockTicks, parsePsProcs } from "../../../src/panel/gatewatch-proc.ts";
import { Rig, BUN, SKILL, STUBS, kv } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const D = `${r.T}/mfr-d`, wt = `${r.T}/wt-mfr`, LC = `${r.T}/mfr-launchctl`, BB = `${r.T}/mfr-bin`, WORK = `${r.T}/mfr-work`;
const AGENTS = `${r.H}/Library/LaunchAgents`, PRIVATE = `${r.H}/.claude/hades/launchd`;
mkdirSync(BB, { recursive: true });
mkdirSync(D, { recursive: true });
r.must(r.git(r.C, "worktree", "add", "-q", "-b", "mfr/wt", wt));
writeFileSync(`${D}/env.sh`, `W="${wt}"\n`);
mkdirSync(`${LC}/loaded`, { recursive: true });
symlinkSync(`${STUBS}/launchctl`, `${BB}/launchctl`);
symlinkSync(Bun.which("node") ?? "/usr/bin/node", `${BB}/node`);
const env = (extra: Record<string, string> = {}) => kv({ PATH: `${BB}:${r.env0.PATH}`, HADES_DATA: D, D, FAKE_LAUNCHCTL_DIR: LC, HADES_SERVICE_MANAGER: "launchd",
  HADES_ID: "", USER: "regressao", HADES_CLI: `${BUN} ${SKILL}/src/cli.ts` }, extra);
const hades = (args: string[], extra: Record<string, string> = {}) => r.hades(args, { env: env(extra), merge: true, cwd: r.T });
const script = (kase: string, extra: Record<string, string> = {}) => {
  const o = r.X([BUN, `${SKILL}/loop/test/ts/lib/mac-fix-review.ts`, kase, D], { env: env({ HADES_CHAT_BIN: `${BB}/node`, ...extra }), merge: true, cwd: r.T });
  const line = (key: string): unknown => {
    const m = new RegExp(`^${key} (.*)$`, "m").exec(o.out);
    return m === null ? undefined : JSON.parse(m[1] as string);
  };
  return { rc: o.rc, out: o.out, line };
};
const reset = () => {
  rmSync(`${LC}/loaded`, { recursive: true, force: true });
  mkdirSync(`${LC}/loaded`, { recursive: true });
  rmSync(`${LC}/busy`, { force: true });
  writeFileSync(`${LC}/calls.log`, "");
  rmSync(PRIVATE, { recursive: true, force: true });
};
const calls = () => readFileSync(`${LC}/calls.log`, "utf8").split("\n").filter(Boolean);
const old = (file: string) => utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));

describe("item 1: listagem que falhou não é conjunto vazio", () => {
  test("dado `launchctl list` que falha, a listagem lança ListFailedError, síncrona e assíncrona", () => {
    reset();
    const o = script("sync-list-fail");
    expect(o.line("threw")).toBe("ListFailedError");
    expect(o.line("async")).toBe("ListFailedError");
  });
  test("dado `launchctl list` que falha, a limpeza não recolhe o plist de job velho nem descarrega o serviço", () => {
    reset();
    mkdirSync(PRIVATE, { recursive: true });
    const plist = `${PRIVATE}/com.hades.hds.pjob-20200102-000000-bbbb.plist`;
    writeFileSync(plist, "<plist/>");
    old(plist);
    writeFileSync(`${LC}/loaded/com.hades.hds.pjob-20200102-000000-bbbb`, "running");
    const o = hades(["clean", "run", "--quiet"], { FAKE_LIST_FAIL: "1" });
    expect(o.rc).toBe(0);
    expect(existsSync(plist)).toBe(true);
    expect(existsSync(`${LC}/loaded/com.hades.hds.pjob-20200102-000000-bbbb`)).toBe(true);
    expect(calls().some((c) => c.startsWith("bootout"))).toBe(false);
  });
  test("dado `launchctl list` que falha, a listagem de jobs do painel não recolhe o job em execução", () => {
    reset();
    const o = script("jobs-list-fail");
    expect(o.rc).toBe(0);
    expect(o.line("plists")).toEqual(["com.hades.hds.pjob-<id>.plist"]);
    expect(o.line("loaded")).toBe(true);
  });
  test("dado `launchctl list` que falha, o chat não recolhe a sessão nem fecha o turno dela", () => {
    reset();
    const o = script("chat-list-fail");
    expect(o.rc).toBe(0);
    expect(o.line("plist")).toBe(true);
    expect(o.line("loaded")).toBe(true);
    expect(o.line("closed")).toBe(false);
  });
});

describe("item 2: idade dos processos do macOS não cresce com o painel", () => {
  const ps = "  42     1  2048  0:02.00  01:00:00 /usr/bin/node\n";
  const ageOf = (start: number, bootTime: number, at: number): number => at - (bootTime + start / clockTicks());
  test("dado o boot real e o relógio do ps, a idade em ticks é a do etime, no instante da leitura e depois", () => {
    const boot = 1_000_000, now = 1_050_000;
    const [p] = parsePsProcs(ps, { clock: { boot, now } });
    expect(ageOf(p?.start as number, boot, now)).toBe(3600);
    expect(ageOf(p?.start as number, boot, now + 120)).toBe(3720);
  });
  test("dado outra referência de boot (a hora da criação do painel), a idade é a mesma", () => {
    const now = 1_050_000;
    const [p] = parsePsProcs(ps, { clock: { boot: now - 7, now } });
    expect(ageOf(p?.start as number, now - 7, now)).toBe(3600);
  });
});

describe("item 3: svc run resolve o executável contra o --workdir", () => {
  test("dado `--workdir X -- ./bin/srv` e outro cwd, o plist leva X/bin/srv e o WorkingDirectory X", () => {
    reset();
    mkdirSync(`${WORK}/bin`, { recursive: true });
    writeFileSync(`${WORK}/bin/srv`, "#!/bin/sh\nexit 0\n");
    chmodSync(`${WORK}/bin/srv`, 0o755);
    const o = hades(["svc", "run", "srv", "--workdir", WORK, "--", "./bin/srv"]);
    expect(o.rc).toBe(0);
    const plist = readFileSync(`${PRIVATE}/com.hades.hds.srv.plist`, "utf8");
    expect(plist).toContain(`<string>${WORK}/bin/srv</string>`);
    expect(plist).toContain(`<key>WorkingDirectory</key><string>${WORK}</string>`);
  });
});

describe("item 4: plist apagado por outro coletor durante a coleta", () => {
  test("dado um plist que sumiu entre o readdir e o stat, a limpeza segue e recolhe os outros", () => {
    reset();
    mkdirSync(PRIVATE, { recursive: true });
    symlinkSync(`${PRIVATE}/nao-existe`, `${PRIVATE}/com.hades.hds.pjob-20200101-000000-aaaa.plist`);
    const other = `${PRIVATE}/com.hades.hds.pjob-20200102-000000-bbbb.plist`;
    writeFileSync(other, "<plist/>");
    old(other);
    const o = hades(["clean", "run", "--quiet"]);
    expect(o.rc).toBe(0);
    expect(existsSync(other)).toBe(false);
  });
});

describe("item 5: start relê o plist de serviço carregado e parado", () => {
  test("dado serviço parado e plist regravado, o start faz bootout e bootstrap, sem kickstart", () => {
    reset();
    const o = script("start-rewrite");
    expect(o.line("rc")).toBe(0);
    expect(o.line("verbs")).toEqual(["bootout", "bootstrap"]);
    expect(o.line("state")).toBe("running");
  });
  test("dado serviço parado e plist igual, o start só faz kickstart", () => {
    reset();
    expect(script("start-same").line("verbs")).toEqual(["kickstart"]);
  });
});

describe("item 6: intervalo da limpeza como o systemd.time", () => {
  test.each([["90", 90], ["1h 90", 3690], ["1500ms", 1], ["2000ms", 2], ["1M", 2629800], ["1month", 2629800], ["1y", 31557600], ["1year", 31557600], ["30m", 1800], ["1h30", 3630]])(
    "dado %j, devolve %d segundos", (text, sec) => { expect(parseEverySeconds(text as string)).toBe(sec); });
  test.each([["0"], ["0ms"], ["500us"], ["-5"], ["1y 100y"], ["70y"], ["1fortnight"]])("dado %j, recusa", (text) => { expect(parseEverySeconds(text as string)).toBeUndefined(); });
  test("dado HADES_CLEAN_TIMER=off e intervalo ilegível, o apply desarma o timer carregado", () => {
    reset();
    const c = (extra: Record<string, string>) => r.X(["bash", `${D}/clean.sh`, "apply"], { env: env(extra), merge: true, cwd: r.T });
    r.must(r.X(["bash", `${SKILL}/kit/install.sh`], { merge: true, env: env({ HADES_WT: wt, SKIP_WORKTREE: "1", SKIP_DOCTOR: "1", SKIP_SYSTEMD: "1" }) }));
    expect(c({ HADES_CLEAN_EVERY: "6h", HADES_CLEAN_TIMER: "on" }).rc).toBe(0);
    expect(existsSync(`${LC}/loaded/com.hades.hds.logrotate`)).toBe(true);
    expect(c({ HADES_CLEAN_EVERY: "6x", HADES_CLEAN_TIMER: "off" }).rc).toBe(0);
    expect(existsSync(`${LC}/loaded/com.hades.hds.logrotate`)).toBe(false);
    expect(existsSync(`${AGENTS}/com.hades.hds.logrotate.plist`)).toBe(false);
  });
  test("dado HADES_CLEAN_TIMER=on e intervalo ilegível, o apply segue recusando (sai 2)", () => {
    expect(r.X(["bash", `${D}/clean.sh`, "apply"], { env: env({ HADES_CLEAN_EVERY: "6x", HADES_CLEAN_TIMER: "on" }), merge: true, cwd: r.T }).rc).toBe(2);
  });
});

describe("item 7: XML 1.0 no plist", () => {
  const spec = (arg: string, value = "v") => ({ label: "x", argv: ["/bin/sh", arg], env: [["K", value]] as const, keepAliveOnFailure: false, runAtLoad: true });
  test("dado caractere de controle inválido, o plist falha com erro explícito em vez de trocá-lo", () => {
    for (const bad of ["\u0000", "\u0001", "\u000B", "\u001F", "￾"]) expect(() => plistText(spec(`a${bad}b`))).toThrow(HadesError);
    expect(() => plistText(spec("a", "v\u0007"))).toThrow(/U\+0007/);
  });
  test("dado tab e nova linha, seguem válidos e viram eles mesmos", () => {
    const text = plistText(spec("a\tb\nc"));
    expect(text).toContain("<string>a\tb\nc</string>");
  });
  test("dado \\r, vira &#13; e volta como \\r na leitura", () => {
    const text = plistText({ ...spec("x"), stdout: "/l/a\rb.log" });
    expect(text).toContain("a&#13;b.log");
    expect(plistString(text, "StandardOutPath")).toBe("/l/a\rb.log");
    expect(plistEnvironment(plistText(spec("x", "v\rw")))).toBe('"K=v\rw"');
  });
});

describe("item 8: ps com espaço no comm", () => {
  test("dado comm com espaço, comm e cmd não se trocam", () => {
    const text = "  42     1  2048  0:02.00  01:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n";
    const [p] = parsePsProcs(text, { commands: new Map([[42, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=gpu"]]) });
    expect(p).toMatchObject({ pid: 42, comm: "Google Chrome", cmd: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=gpu" });
  });
  test("dado pid sem linha de comando, o cmd é o caminho do executável", () => {
    const [p] = parsePsProcs("  7     1  10  0:00.10  00:05 /usr/sbin/cfprefsd\n");
    expect(p).toMatchObject({ comm: "cfprefsd", cmd: "/usr/sbin/cfprefsd" });
  });
});

describe("item 9: last exit code com descrição", () => {
  test("dado `78: EX_CONFIG`, o código sai 78 e o estado é failed", () => {
    const p = parseLaunchctlPrint("x = {\n\tstate = not running\n\truns = 1\n\tlast exit code = 78: EX_CONFIG\n}\n");
    expect(p.lastExitCode).toBe(78);
    expect(activeStateOf(p)).toBe("failed");
  });
  test("dado o stub com descrição, `panel service status` diz failed", () => {
    reset();
    writeFileSync(`${LC}/loaded/com.hades.hds.panel`, "exited:78\n");
    expect(hades(["panel", "service", "status"]).out).toContain("hds-panel: failed");
  });
});

describe("item 10: bootout de serviço não carregado", () => {
  test("dado bootout que sai 113, o stop sai 0", () => {
    reset();
    expect(hades(["panel", "service", "stop"], { FAKE_BOOTOUT_NOT_LOADED: "113" }).rc).toBe(0);
    expect(calls().some((c) => c.startsWith("bootout"))).toBe(true);
  });
  test("dado restart de serviço não carregado (bootout 113), o serviço sobe", () => {
    reset();
    const o = script("restart-unloaded", { FAKE_BOOTOUT_NOT_LOADED: "113" });
    expect(o.line("rc")).toBe(0);
    expect(o.line("loaded")).toBe(true);
  });
  test("dado restart de serviço não carregado (bootout 3), o serviço também sobe", () => {
    reset();
    expect(script("restart-unloaded").line("loaded")).toBe(true);
  });
});

describe("item 11: bootstrap repetido enquanto o job desmonta", () => {
  test("dado bootstrap que sai 5 duas vezes, o restart repete e sobe na terceira", () => {
    reset();
    const o = script("restart", { LATE_BOOTSTRAP_BUSY: "2" });
    expect(o.line("rc")).toBe(0);
    expect(o.line("bootstraps")).toBe(3);
  }, 10_000);
  test("dado bootstrap que nunca sai do 5, desiste em poucas tentativas e devolve 5", () => {
    reset();
    const t0 = Date.now();
    const o = script("restart", { LATE_BOOTSTRAP_BUSY: "99" });
    expect(o.line("rc")).toBe(5);
    expect(o.line("bootstraps")).toBe(4);
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 10_000);
  test("dado outro código de erro no bootstrap, não repete e o devolve", () => {
    reset();
    const o = script("restart", { LATE_BOOTSTRAP_FAIL: "37" });
    expect(o.line("rc")).toBe(37);
    expect(o.line("bootstraps")).toBe(1);
  });
  test("dado `svc run` com bootstrap que sai 5 duas vezes, sobe na terceira", () => {
    reset();
    const o = hades(["svc", "run", "srv", "--", "sleep", "300"], { FAKE_BOOTSTRAP_BUSY: "2" });
    expect(o.rc).toBe(0);
    expect(calls().filter((c) => c.startsWith("bootstrap")).length).toBe(3);
    expect(existsSync(`${LC}/loaded/com.hades.hds.srv`)).toBe(true);
  }, 10_000);
});

describe("item 12: plist gravado com modo 0644", () => {
  test("dado umask 077, write, transientArgv e writeTimer gravam 644", () => {
    reset();
    const o = script("modes");
    expect(o.line("write")).toBe("644");
    expect(o.line("transient")).toBe("644");
    expect(o.line("timer")).toBe("644");
  });
  test("dado umask 077 no `hades svc run`, o plist sai 644", () => {
    reset();
    const o = r.X(["bash", "-c", `umask 077; "$0" ${SKILL}/src/cli.ts svc run srv -- sleep 300`, BUN], { env: env(), merge: true, cwd: r.T });
    expect(o.rc).toBe(0);
    expect((statSync(`${PRIVATE}/com.hades.hds.srv.plist`).mode & 0o777).toString(8)).toBe("644");
  });
});
