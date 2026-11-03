// launchd (macOS) provado no Linux: rótulo, plist e parsers como funções puras, e a camada de serviço, o `panel service`,
// o linger, o vigia e o doctor contra o launchctl falso (loop/test/stubs/launchctl) com HADES_SERVICE_MANAGER=launchd.
// O que só um Mac real prova (bootstrap, domínio gui/user, KeepAlive) está listado no report da unidade.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { activeStateOf, launchdLabel, parseEverySeconds, parsePsClock, parsePsTable, parseLaunchctlList, parseLaunchctlPrint, plistEnvironment, plistString, plistText, treeTotals, unitOfLabel } from "../../../src/lib/launchd-plist.ts";
import { parseBootTime, parseLoadAverage, parsePsCommands, parseSwapUsage } from "../../../src/panel/system.ts";
import { Rig, SKILL, STUBS, kv } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const D = `${r.T}/ld-d`, LC = `${r.T}/ld-launchctl`, BB = `${r.T}/ld-bin`, wt = `${r.T}/wt-ld`;
const AGENTS = `${r.H}/Library/LaunchAgents`, PRIVATE = `${r.H}/.claude/hades/launchd`;
const PANEL_LABEL = "com.hades.hds.panel";
const rd = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

mkdirSync(BB, { recursive: true });
symlinkSync(Bun.which("node") ?? "/usr/bin/node", `${BB}/node`);
symlinkSync(`${STUBS}/launchctl`, `${BB}/launchctl`);
r.must(r.git(r.C, "worktree", "add", "-q", "-b", "ld/wt", wt));
mkdirSync(D, { recursive: true });
const base = (extra: Record<string, string> = {}) => kv({ PATH: `${BB}:${r.env0.PATH}`, HADES_WT: wt, HADES_DATA: D, FAKE_LAUNCHCTL_DIR: LC,
  HADES_SERVICE_MANAGER: "launchd", USER: "regressao" }, extra);
const hades = (args: string[], extra: Record<string, string> = {}) => r.hades(args, { env: base(extra), merge: true });
const loaded = (label = PANEL_LABEL) => existsSync(`${LC}/loaded/${label}`);

describe("launchd: rótulo e plist", () => {
  test("dada a unit do systemd, o rótulo separa o HU do sufixo pelo primeiro hífen", () => {
    expect(launchdLabel("hds-panel")).toBe("com.hades.hds.panel");
    expect(launchdLabel("hds_projb-pjob-2026-a")).toBe("com.hades.hds_projb.pjob-2026-a");
  });
  test("dado o rótulo, a unit volta; rótulo alheio não é do Hades", () => {
    expect(unitOfLabel("com.hades.hds_projb.pjob-2026-a")).toBe("hds_projb-pjob-2026-a");
    expect(unitOfLabel("com.apple.Finder")).toBeUndefined();
  });
  test("serviço com reinício em falha leva KeepAlive, ThrottleInterval e o texto escapado", () => {
    const text = plistText({ label: PANEL_LABEL, argv: ["/bin/bash", "a&b"], env: [["K", "<v>"]], stdout: "/l/p.log", keepAliveOnFailure: true, throttleSec: 5, runAtLoad: true });
    expect(text).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
    expect(text).toContain("<key>ThrottleInterval</key><integer>5</integer>");
    expect(text).toContain("<string>a&amp;b</string>");
    expect(text).toContain("<key>K</key><string>&lt;v&gt;</string>");
    expect(plistString(text, "StandardOutPath")).toBe("/l/p.log");
  });
  test("timer de baixa prioridade leva Nice e LowPriorityIO", () => {
    const text = plistText({ label: "x", argv: ["/bin/sh"], keepAliveOnFailure: false, runAtLoad: false, startIntervalSec: 60, lowPriority: true });
    expect(text).toContain("<key>Nice</key>");
    expect(text).toContain("<key>LowPriorityIO</key><true/>");
  });
  test("job transitório não leva KeepAlive e aceita stdin; timer por intervalo vira StartInterval", () => {
    const job = plistText({ label: "com.hades.hds.pjob-1", argv: ["/bin/sh"], stdin: "/in", keepAliveOnFailure: false, runAtLoad: true });
    expect(job).not.toContain("KeepAlive");
    expect(job).toContain("<key>StandardInPath</key><string>/in</string>");
    expect(plistText({ label: "x", argv: ["/bin/sh"], keepAliveOnFailure: false, runAtLoad: false, startIntervalSec: 21600 })).toContain("<key>StartInterval</key><integer>21600</integer>");
  });
  test("o mesmo plist sai byte a byte igual", () => {
    const spec = { label: "x", argv: ["/bin/sh", "-c"], env: [["A", "1"], ["B", "2"]] as const, keepAliveOnFailure: true, runAtLoad: true };
    expect(plistText(spec)).toBe(plistText(spec));
  });
});

describe("launchd: intervalo do timer (HADES_CLEAN_EVERY → StartInterval)", () => {
  test.each([["6h", 21600], ["1d", 86400], ["30min", 1800], ["1h 30min", 5400], ["1h30min", 5400], ["90s", 90], ["2w", 1209600], ["596523h", 2147482800]])(
    "dado %s, devolve %d segundos", (text, sec) => { expect(parseEverySeconds(text)).toBe(sec); });
  test.each([[""], ["0h"], ["0"], ["6x"], ["-1h"], ["596524h"]])("dado %j, recusa (undefined)", (text) => { expect(parseEverySeconds(text)).toBeUndefined(); });
});

describe("launchd: leitura das saídas do launchctl", () => {
  const running = "gui/501/com.hades.hds.panel = {\n\tactive count = 1\n\tstate = running\n\truns = 3\n\tpid = 99\n\tlast exit code = (never exited)\n\tproperties = {\n\t\tstate = nested\n\t}\n}\n";
  test("serviço rodando: estado, pid e execuções saem das linhas do serviço, não dos blocos aninhados", () => {
    const p = parseLaunchctlPrint(running);
    expect(p).toMatchObject({ state: "running", pid: 99, runs: 3 });
    expect(p.lastExitCode).toBeUndefined();
    expect(activeStateOf(p)).toBe("active");
  });
  test("serviço parado com saída diferente de zero é failed; com zero ou sem registro, inactive", () => {
    expect(activeStateOf(parseLaunchctlPrint("x = {\n\tstate = not running\n\tlast exit code = 1\n}\n"))).toBe("failed");
    expect(activeStateOf(parseLaunchctlPrint("x = {\n\tstate = not running\n\tlast exit code = 0\n}\n"))).toBe("inactive");
    expect(activeStateOf(undefined)).toBe("inactive");
  });
  test("serviço esperando o ThrottleInterval está activating", () => {
    expect(activeStateOf(parseLaunchctlPrint("x = {\n\tstate = spawn scheduled\n}\n"))).toBe("activating");
  });
  test("launchctl list: cabeçalho some, `-` na coluna PID é parado e lixo é ignorado", () => {
    const rows = parseLaunchctlList("PID\tStatus\tLabel\n99\t0\tcom.hades.hds.panel\n-\t78\tcom.hades.hds.notify\nsó uma coluna\n");
    expect(rows).toEqual([{ label: "com.hades.hds.panel", pid: 99, status: 0 }, { label: "com.hades.hds.notify", pid: undefined, status: 78 }]);
    expect(parseLaunchctlList("")).toEqual([]);
  });
});

describe("macOS sem /proc: leitura de sysctl e ps", () => {
  test("kern.boottime", () => {
    expect(parseBootTime("{ sec = 1700000000, usec = 5 } Tue Nov 14 22:13:20 2023")).toBe(1700000000);
    expect(parseBootTime("")).toBe(0);
  });
  test("vm.loadavg", () => {
    expect(parseLoadAverage("{ 1.20 1.10 0.95 }")).toEqual([1.2, 1.1, 0.95]);
    expect(parseLoadAverage("lixo")).toEqual([0, 0, 0]);
  });
  test("vm.swapusage em bytes", () => {
    expect(parseSwapUsage("total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)")).toEqual({ total: 2048 * 1048576, free: 1024 * 1048576 });
    expect(parseSwapUsage("")).toEqual({ total: 0, free: 0 });
  });
  test("ps -axo pid=,command=", () => {
    expect(parsePsCommands("  1 /sbin/launchd\n 42 bash /x/a.sh --flag \n\nlixo\n")).toEqual([{ pid: 1, cmd: "/sbin/launchd" }, { pid: 42, cmd: "bash /x/a.sh --flag" }]);
  });
});

describe("launchd: panel service, linger, vigia e doctor contra o launchctl falso", () => {
  test("preparação: o kit é instalado sem tocar no gerenciador", () => {
    const o = r.X(["bash", `${SKILL}/kit/install.sh`], { merge: true, env: base({ SKIP_WORKTREE: "1", SKIP_DOCTOR: "1", SKIP_SYSTEMD: "1" }) });
    expect(o.rc).toBe(0);
  });
  test("start grava o plist privado, carrega o serviço e status diz active", () => {
    const o = hades(["panel", "service", "start"]);
    expect(o.rc).toBe(0);
    expect(o.out).toContain("painel em http://127.0.0.1:");
    expect(loaded()).toBe(true);
    const plist = rd(`${PRIVATE}/${PANEL_LABEL}.plist`);
    expect(plist).toContain(`<key>Label</key><string>${PANEL_LABEL}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(hades(["panel", "service", "status"]).out).toContain("hds-panel: active");
  });
  test("start com o painel no ar não carrega de novo", () => {
    const before = rd(`${LC}/calls.log`).split("\n").filter((l) => l.startsWith("bootstrap")).length;
    expect(hades(["panel", "service", "start"]).out).toContain("já está no ar");
    expect(rd(`${LC}/calls.log`).split("\n").filter((l) => l.startsWith("bootstrap")).length).toBe(before);
  });
  test("autostart login move o plist para ~/Library/LaunchAgents e off devolve ao diretório privado", () => {
    expect(hades(["panel", "service", "autostart"], { HADES_PANEL_AUTOSTART: "login" }).out).toContain("início automático (login): no login do usuário");
    expect(existsSync(`${AGENTS}/${PANEL_LABEL}.plist`)).toBe(true);
    expect(existsSync(`${PRIVATE}/${PANEL_LABEL}.plist`)).toBe(false);
    hades(["panel", "service", "autostart"], { HADES_PANEL_AUTOSTART: "off" });
    expect(existsSync(`${AGENTS}/${PANEL_LABEL}.plist`)).toBe(false);
    expect(existsSync(`${PRIVATE}/${PANEL_LABEL}.plist`)).toBe(true);
  });
  test("linger state é n/a", () => {
    const o = hades(["linger", "state"]);
    expect(o.out.trim()).toBe("n/a");
  });
  test("stop descarrega o serviço; stop de novo (já descarregado) também sai 0", () => {
    expect(hades(["panel", "service", "stop"]).rc).toBe(0);
    expect(loaded()).toBe(false);
    expect(hades(["panel", "service", "stop"]).rc).toBe(0);
    expect(hades(["panel", "service", "status"]).out).toContain("hds-panel: inactive");
  });
  test("serviço que caiu com erro aparece failed e o start limpa o estado antes de subir", () => {
    mkdirSync(`${LC}/loaded`, { recursive: true });
    writeFileSync(`${LC}/loaded/${PANEL_LABEL}`, "exited:1\n");
    expect(hades(["panel", "service", "status"]).out).toContain("hds-panel: failed");
    expect(hades(["panel", "service", "start"]).rc).toBe(0);
    expect(hades(["panel", "service", "status"]).out).toContain("hds-panel: active");
    hades(["panel", "service", "stop"]);
  });
  test("sem sessão gráfica o domínio cai para user/<uid>", () => {
    writeFileSync(`${LC}/calls.log`, "");
    hades(["panel", "service", "start"], { FAKE_NO_GUI: "1" });
    expect(rd(`${LC}/calls.log`)).toMatch(/bootstrap user\/\d+ /);
    hades(["panel", "service", "stop"], { FAKE_NO_GUI: "1" });
  });
  test("panel.sh é o wrapper do mesmo comando", () => {
    expect(r.X(["bash", `${D}/panel.sh`, "url"], { env: base(), merge: true }).out.trim()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(r.X(["bash", `${D}/panel.sh`, "xis"], { env: base(), merge: true }).rc).toBe(2);
  });
  test("vigia ligado: notify apply carrega o serviço; desligado, descarrega", () => {
    expect(hades(["notify", "apply"], { HADES_NOTIFY: "1" }).out).toContain("vigia hds-notify: active");
    expect(loaded("com.hades.hds.notify")).toBe(true);
    expect(existsSync(`${AGENTS}/com.hades.hds.notify.plist`)).toBe(true);
    expect(hades(["notify", "apply"], { HADES_NOTIFY: "0" }).out).toContain("vigia hds-notify: inactive");
    expect(loaded("com.hades.hds.notify")).toBe(false);
  });
  test("doctor --quick no launchd: sem systemd, sem slice, painel e limpeza informativos", () => {
    const o = hades(["doctor", "--quick", "--json"], { HADES_PANEL_AUTOSTART: "boot", HADES_SLICE_MAX: "2G" });
    const items = (JSON.parse(o.out.slice(o.out.indexOf("{"))).items ?? []) as { id: string; level: string; msg: string }[];
    const by = (id: string) => items.find((i) => i.id === id);
    expect(by("systemd")).toBeUndefined();
    expect(by("launchd")?.level).toBe("ok");
    expect(by("slice")?.level).toBe("ok");
    expect(by("logrotate")?.level).toBe("warn");
    expect(by("boot")).toBeUndefined();
    expect(by("painel")?.msg).toBeDefined();
  });
  test("doctor --quick sem nenhum domínio: avisa com o comando que corrige", () => {
    const o = hades(["doctor", "--quick", "--json"], { FAKE_NO_GUI: "1", FAKE_NO_USER: "1" });
    const item = (JSON.parse(o.out.slice(o.out.indexOf("{"))).items as { id: string; level: string; fix: string }[]).find((i) => i.id === "launchd");
    expect(item?.level).toBe("warn");
    expect(item?.fix).toContain("sessão de usuário");
  });
});

describe("launchd: leitura do ps e do ambiente da unit", () => {
  test("dado o tempo do ps, com dias, horas ou só minutos, saem os segundos", () => {
    expect(parsePsClock("1-02:03:04")).toBe(93784);
    expect(parsePsClock("02:03:04")).toBe(7384);
    expect(parsePsClock("0:01.50")).toBe(1.5);
    expect(parsePsClock("lixo")).toBe(0);
  });
  test("dado o ps da máquina, a árvore do pid soma RSS e CPU dos descendentes e ignora o resto", () => {
    const rows = parsePsTable("  10     1  1000  05:00  0:02.00\n  11    10   500  04:59  0:01.00\n  12    11   250  04:58  0:00.50\n  20     1  9999  01:00  0:09.00\nlinha torta\n");
    expect(rows).toHaveLength(4);
    expect(treeTotals(rows, 10)).toEqual({ rssKb: 1750, cpuS: 3.5, elapsedS: 300 });
    expect(treeTotals(rows, 999)).toEqual({ rssKb: 0, cpuS: 0, elapsedS: 0 });
  });
  test("dado o plist do serviço, o Environment sai no formato do systemctl show, com o texto desescapado", () => {
    const text = plistText({ label: "x", argv: ["/bin/sh"], env: [["HADES_DATA", "/d/a&b"], ["K", "v"]], keepAliveOnFailure: false, runAtLoad: true });
    expect(plistEnvironment(text)).toBe('"HADES_DATA=/d/a&b" "K=v"');
    expect(plistEnvironment("<dict></dict>")).toBe("");
  });
});

describe("launchd: jobs, chat, amostrador e log de unit do painel", () => {
  let cached: { rc: number; out: string } | undefined;
  /** Uma execução só, na primeira que precisar; o env.sh mínimo diz ao painel qual é o worktree (a instalação completa é de outro teste). */
  const run = (): { rc: number; out: string } => {
    if (cached === undefined) {
      mkdirSync(`${r.H}/.claude/hades/launchd`, { recursive: true });
      if (!existsSync(`${D}/env.sh`)) writeFileSync(`${D}/env.sh`, `W="${wt}"\n`);
      cached = r.X([`${r.env0.HADES_BUN}`, `${SKILL}/loop/test/ts/lib/launchd-efemeros.ts`, D], { env: base({ HADES_CHAT_BIN: `${BB}/node`, HADES_ID: "" }), merge: true });
    }
    return cached;
  };
  const line = (key: string): unknown => {
    const m = new RegExp(`^${key.replace(".", "\\.")} (.*)$`, "m").exec(run().out);
    return m === null ? undefined : JSON.parse(m[1] as string);
  };
  test("o script roda inteiro", () => expect(run().rc === 0 ? "" : run().out).toBe(""));
  test("job iniciado grava o plist do job, carrega e aparece rodando", () => {
    expect(line("job.plist")).toEqual(["com.hades.hds.pjob-<id>.plist"]);
    expect(line("job.loaded")).toEqual(["com.hades.hds.pjob-<id>"]);
    expect(line("job.state")).toEqual(["rodando"]);
  });
  test("job parado descarrega, apaga o plist e sai da lista como interrompido", () => {
    expect(line("stop.plist")).toEqual([]);
    expect(line("stop.loaded")).toEqual([]);
    expect(line("stop.state")).toEqual(["interrompido"]);
  });
  test("job que terminou sozinho tem o plist e o serviço carregado recolhidos na listagem", () => {
    expect(line("done.state")).toEqual(["interrompido", "interrompido"]);
    expect(line("done.plist")).toEqual([]);
    expect(line("done.loaded")).toEqual([]);
  });
  test("mensagem de chat vira serviço com StandardInPath no arquivo .in e para pela camada", () => {
    expect(line("chat.stdin")).toBe(true);
    expect(line("chat.loaded")).toEqual(["com.hades.hds.chat-<sid>"]);
    expect(line("chat.stopped")).toEqual([]);
  });
  test("amostrador no launchd mostra a unit do painel ativa e a slice sem teto, sem erro", () => {
    expect(line("sampler.panel")).toEqual({ state: "active", sub: "running", restarts: 0 });
    expect(line("sampler.slice")).toMatchObject({ max: null, high: null });
    expect(line("sampler.error")).toBeNull();
  });
  test("log da unit no launchd é o fim do arquivo que o plist declara", () => {
    expect((line("log.unit") as { text: string }).text).toBe("linha 2\nlinha 3");
  });
});

describe("launchd: limpeza dos jobs do painel", () => {
  test("job ativo no launchd não é apagado pela limpeza, mesmo velho e além do limite", () => {
    const jobs = `${D}/logs/panel-jobs`;
    mkdirSync(jobs, { recursive: true });
    const id = "20200101-000000-aaaa";
    writeFileSync(`${jobs}/${id}.json`, "{}");
    utimesSync(`${jobs}/${id}.json`, new Date(2020, 0, 1), new Date(2020, 0, 1));
    mkdirSync(`${LC}/loaded`, { recursive: true });
    writeFileSync(`${LC}/loaded/com.hades.hds.pjob-${id}`, "running");
    const o = hades(["clean", "run", "--quiet"], { HADES_CLEAN_JOBS_KEEP: "0", HADES_CLEAN_JOBS_DAYS: "0" });
    expect(existsSync(`${jobs}/${id}.json`)).toBe(true);
    rmSync(`${LC}/loaded/com.hades.hds.pjob-${id}`);
    expect(o.rc).toBe(0);
  });
  test("plist de job que já terminou é recolhido pela limpeza, e o de job em execução fica", () => {
    mkdirSync(PRIVATE, { recursive: true });
    const finished = `${PRIVATE}/com.hades.hds.pjob-20200102-000000-bbbb.plist`, running = `${PRIVATE}/com.hades.hds.pjob-20200103-000000-cccc.plist`;
    for (const f of [finished, running]) { writeFileSync(f, "<plist/>"); utimesSync(f, new Date(2020, 0, 1), new Date(2020, 0, 1)); }
    writeFileSync(`${LC}/loaded/com.hades.hds.pjob-20200103-000000-cccc`, "running");
    expect(hades(["clean", "run", "--quiet"]).rc).toBe(0);
    expect(existsSync(finished)).toBe(false);
    expect(existsSync(running)).toBe(true);
    rmSync(running);
    rmSync(`${LC}/loaded/com.hades.hds.pjob-20200103-000000-cccc`);
  });
});

// ---- limpeza: timer por StartInterval e a marca da última execução ----
describe("launchd: timer da limpeza", () => {
  const CLEAN_LABEL = "com.hades.hds.logrotate";
  const clean = (args: string[], extra: Record<string, string> = {}) => r.X(["bash", `${D}/clean.sh`, ...args], { env: base(extra), merge: true });
  const interval = () => /<key>StartInterval<\/key><integer>(\d+)<\/integer>/.exec(rd(`${AGENTS}/${CLEAN_LABEL}.plist`))?.[1];
  test("apply com 6h grava o plist em LaunchAgents com StartInterval 21600 e carrega", () => {
    const o = clean(["apply"], { HADES_CLEAN_EVERY: "6h", HADES_CLEAN_TIMER: "on" });
    expect(o.rc).toBe(0);
    expect(interval()).toBe("21600");
    expect(loaded(CLEAN_LABEL)).toBe(true);
  });
  test("status --tsv antes de qualquer execução: ativo e sem última", () => {
    rmSync(`${D}/logs/logrotate.last`, { force: true });
    expect(clean(["status", "--tsv"], { HADES_CLEAN_TIMER: "on" }).out).toMatch(/@timer\tativo\t-/);
  });
  test("run --quiet grava a marca em UTC e o status passa a mostrá-la", () => {
    clean(["run", "--quiet"]);
    expect(rd(`${D}/logs/logrotate.last`)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
    expect(clean(["status", "--tsv"], { HADES_CLEAN_TIMER: "on" }).out).toMatch(/@timer\tativo\t\d{4}-\d\d-\d\dT/);
  }, 30_000); // o run varre o logrotate inteiro: sob a suíte em paralelo passa dos 5 s padrão
  test("apply com 2h muda o StartInterval para 7200 e rearma (bootout + bootstrap)", () => {
    writeFileSync(`${LC}/calls.log`, "");
    clean(["apply"], { HADES_CLEAN_EVERY: "2h", HADES_CLEAN_TIMER: "on" });
    expect(interval()).toBe("7200");
    const calls = rd(`${LC}/calls.log`);
    expect(calls).toContain("bootout");
    expect(calls).toContain("bootstrap");
  });
  test("apply com o timer off devolve o plist ao diretório privado e descarrega", () => {
    clean(["apply"], { HADES_CLEAN_EVERY: "2h", HADES_CLEAN_TIMER: "off" });
    expect(loaded(CLEAN_LABEL)).toBe(false);
    expect(existsSync(`${AGENTS}/${CLEAN_LABEL}.plist`)).toBe(false);
    expect(existsSync(`${PRIVATE}/${CLEAN_LABEL}.plist`)).toBe(true);
  });
  test("apply com intervalo inválido sai 2 sem carregar nada", () => {
    expect(clean(["apply"], { HADES_CLEAN_EVERY: "6x", HADES_CLEAN_TIMER: "on" }).rc).toBe(2);
    expect(loaded(CLEAN_LABEL)).toBe(false);
  });
  test("doctor --quick: logrotate ok depois do apply", () => {
    clean(["apply"], { HADES_CLEAN_EVERY: "6h", HADES_CLEAN_TIMER: "on" });
    const o = hades(["doctor", "--quick", "--json"], { HADES_CLEAN_TIMER: "on" });
    const items = JSON.parse(o.out.slice(o.out.indexOf("{"))).items as { id: string; level: string }[];
    expect(items.find((i) => i.id === "logrotate")?.level).toBe("ok");
  });
});

// ---- túnel: serviço com KeepAlive, URL lida do log, sem systemd-run ----
describe("launchd: túnel pela camada de serviço", () => {
  const URL_FRONT = "https://abc-3000.brs.devtunnels.ms", URL_PANEL = "https://abc-21272.brs.devtunnels.ms";
  const TUNNEL_LABEL = "com.hades.hds.panel-tunnel", FRONT_LABEL = "com.hades.hds.devtunnel";
  const tenv = { HADES_TUNNEL_PORT: "3000", HADES_PANEL_PORT: "21272", HADES_CERBERUS_PORTA: "off", HADES_TUNNEL_POLL_MS: "10", HADES_TUNNEL_ANON_TTL: "1d" };
  const tunnel = (args: string[], extra: Record<string, string> = {}) => r.X(["bash", `${D}/tunnel.sh`, ...args], { env: base({ ...tenv, ...extra }), merge: true });
  test("preparação: devtunnel falso e URLs já no log", () => {
    const dt = `${BB}/devtunnel`;
    writeFileSync(dt, `#!/usr/bin/env bash
case $1 in
  --version) echo "devtunnel 1.0.0" ;;
  list) cat "${r.T}/ld-dt.names" 2>/dev/null ;;
  create) echo "$2.reg 0 0" >> "${r.T}/ld-dt.names" ;;
  show) echo "  ${URL_FRONT}"; echo "  ${URL_PANEL}"; echo "  https://abc-21221.brs.devtunnels.ms" ;;
  user) echo "Logged in as regressao using GitHub." ;;
esac
exit 0
`, { mode: 0o755 });
    mkdirSync(`${D}/logs`, { recursive: true });
    writeFileSync(`${D}/logs/panel-tunnel.log`, `linha\n${URL_PANEL}\n`);
    writeFileSync(`${D}/logs/devtunnel.log`, `${URL_FRONT}\n`);
    writeFileSync(`${D}/tunnel.id`, "hades-front.reg\n");
  });
  test("panel-start sobe o serviço com KeepAlive, ThrottleInterval 10, argv absoluto e log em logs/", () => {
    const o = tunnel(["panel-start"]);
    expect(o.rc).toBe(0);
    expect(loaded(TUNNEL_LABEL)).toBe(true);
    const plist = rd(`${PRIVATE}/${TUNNEL_LABEL}.plist`);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>ThrottleInterval</key><integer>10</integer>");
    expect(plistString(plist, "StandardOutPath")).toBe(`${D}/logs/panel-tunnel.log`);
    expect(plist).toMatch(/<string>\/[^<]*devtunnel<\/string>/);
    expect(o.out).toContain(URL_PANEL);
  });
  test("panel-url e panel-status leem a URL do arquivo de log", () => {
    expect(tunnel(["panel-url"]).out).toContain(URL_PANEL);
    expect(tunnel(["panel-status"]).out).toContain("active");
  });
  test("panel-stop descarrega o serviço e remove o plist", () => {
    expect(tunnel(["panel-stop"]).rc).toBe(0);
    expect(loaded(TUNNEL_LABEL)).toBe(false);
    expect(existsSync(`${PRIVATE}/${TUNNEL_LABEL}.plist`)).toBe(false);
  });
  test("publish-cmds e stop-cmd imprimem front-start e front-stop, sem systemd-run", () => {
    const pub = tunnel(["publish-cmds"]).out;
    expect(pub).toContain(`! ${D}/tunnel.sh front-start`);
    expect(pub).not.toContain("systemd-run");
    expect(tunnel(["stop-cmd"]).out).toContain(`! ${D}/tunnel.sh front-stop`);
  });
  test("front-start sobe o serviço do front, url lê o log e front-stop o descarrega", () => {
    expect(tunnel(["front-start"]).rc).toBe(0);
    expect(loaded(FRONT_LABEL)).toBe(true);
    expect(tunnel(["url"]).out).toContain(URL_FRONT);
    expect(tunnel(["front-stop"]).rc).toBe(0);
    expect(loaded(FRONT_LABEL)).toBe(false);
  });
  test("widget-publish-cmds manda o dono para widget-start e widget-stamp grava a validade em UTC", () => {
    writeFileSync(`${D}/widget-tunnel.id`, "hades-widget.reg\n");
    expect(tunnel(["widget-publish-cmds"]).out).toContain(`! ${D}/tunnel.sh widget-start`);
    tunnel(["widget-stamp"]);
    expect(rd(`${D}/widget-tunnel.expires`)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
  });
});

describe("launchd: registro de dependências por sistema", () => {
  const ids = (manager: string) => (JSON.parse(hades(["deps", "--json"], { HADES_SERVICE_MANAGER: manager }).out) as { items: { id: string }[] }).items.map((i) => i.id);
  test("no launchd: launchctl entra e systemctl, journalctl, systemd-run e loginctl saem", () => {
    const launchd = ids("launchd");
    expect(launchd).toContain("launchctl");
    for (const id of ["systemctl", "journalctl", "systemd-run", "loginctl"]) expect(launchd).not.toContain(id);
  });
  test("no systemd: launchctl sai e as ferramentas do systemd ficam", () => {
    const systemd = ids("systemd");
    expect(systemd).not.toContain("launchctl");
    expect(systemd).toContain("systemctl");
  });
});

describe("launchd: ações do painel para o túnel", () => {
  const build = async (kind: string, op: string) => {
    const { buildAction } = await import("../../../src/panel/actions.ts");
    const { panelEnv } = await import("../../../src/panel/env.ts");
    const prev = process.env.HADES_SERVICE_MANAGER;
    process.env.HADES_SERVICE_MANAGER = kind;
    try {
      const env = panelEnv(D);
      return await buildAction({ env, plugin: { actions: new Set<string>() }, containerNames: () => [], pluginAction: () => { throw new Error("sem plugin"); } } as unknown as Parameters<typeof buildAction>[0], { action: "tunnel", op });
    } finally {
      if (prev === undefined) delete process.env.HADES_SERVICE_MANAGER; else process.env.HADES_SERVICE_MANAGER = prev;
    }
  };
  test("launchd: parar chama front-stop e publicar hospeda por front-start", async () => {
    expect((await build("launchd", "stop")).script).toContain("front-stop");
    const start = (await build("launchd", "start")).script;
    expect(start).toContain("front-start");
    expect(start).not.toContain("systemd-run");
  });
  test("systemd: parar usa systemctl e publicar usa systemd-run", async () => {
    expect((await build("systemd", "stop")).script).toContain("systemctl");
    expect((await build("systemd", "start")).script).toContain("systemd-run");
  });
});
