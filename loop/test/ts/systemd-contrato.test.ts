// Contrato com o systemd: o texto das units e o argv de systemctl/systemd-run que o código gera hoje (painel, vigia de
// notificação, jobs e chat do painel). O golden foi gravado ANTES de a camada service-manager existir; ele é a rede da
// extração, no Linux nada disso muda. O macOS tem a própria prova (launchd.test.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Rig, SKILL, STUBS, GOLD, checkText, kv } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const wt = `${r.T}/wt-sc`, D = `${r.T}/sc-d`, SC = `${r.T}/sc-sc`, BB = `${r.T}/sc-bin`, LG = `${r.T}/sc-linger`;
const UD = `${r.H}/.config/systemd/user`;
const NODE_DIR = dirname(Bun.which("node") ?? "/usr/bin/node");
const rd = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "(ausente)\n");

/** Os comandos falsos ficam à frente do PATH; o systemd-run e o journalctl só registram o argv recebido. */
function stubs(): string {
  mkdirSync(BB, { recursive: true });
  symlinkSync(Bun.which("node") ?? "/usr/bin/node", `${BB}/node`);
  symlinkSync(`${STUBS}/systemctl`, `${BB}/systemctl`);
  symlinkSync(`${STUBS}/journalctl`, `${BB}/journalctl`);
  // systemd-run: um argumento por linha, o script embutido (com quebra de linha) não bagunça o golden
  writeFileSync(`${BB}/systemd-run`, `#!/usr/bin/env bash\n{ echo "systemd-run"; for a in "$@"; do printf '  %s\\n' "$a"; done; } >> "\${FAKE_SYSTEMCTL_DIR:?}/argv.log"\n`, { mode: 0o755 });
  return `${BB}:${r.env0.PATH}`;
}
const PB = stubs();
mkdirSync(`${SC}`, { recursive: true });
r.must(r.git(r.C, "worktree", "add", "-q", "-b", "sc/wt", wt));

// PATH e caminho do bash dependem da máquina; o resto (ids aleatórios inclusive) vira marcador
const norm = (s: string) => r.norm(s).split(NODE_DIR).join("<NODE_DIR>").replace(/PATH=[^"\n]*/g, "PATH=<PATH>").replace(/^ExecStart="[^"]*\/bash"/gm, 'ExecStart="<BASH>"')
  .replace(/\d{8}-\d{6}-[0-9a-f]{4}/g, "<job>").replace(/(claude\/|hds-chat-)[0-9a-f]{8}/g, "$1<sid>");
const base = (extra: Record<string, string> = {}) => kv({ PATH: PB, HADES_WT: wt, HADES_DATA: D, FAKE_SYSTEMCTL_DIR: SC, HADES_LOGINCTL: `${STUBS}/loginctl`,
  FAKE_LINGER: LG, USER: "regressao", HADES_SERVICE_MANAGER: "systemd", HADES_CHAT_BIN: `${BB}/node` }, extra);
const secoes: string[] = [];
const calls = () => { const t = rd(`${SC}/calls.log`); writeFileSync(`${SC}/calls.log`, ""); return t; };

/** Roda um passo e registra saída, código, units gravadas e as chamadas ao systemctl desde o passo anterior. */
function step(label: string, argv: string[], extra: Record<string, string> = {}, units: string[] = []): void {
  calls();
  const o = r.X(argv, { env: base(extra), merge: true });
  let t = `## ${label}\nrc=${o.rc}\n${o.out}`;
  for (const u of units) t += `-- ${u}\n${rd(`${UD}/${u}`)}`;
  t += `-- systemctl\n${calls()}`;
  secoes.push(norm(t));
}

/** Túnel: o `devtunnel` falso lista e cria nomes em arquivo, o journalctl falso devolve as URLs das três portas. */
function tunnelStubs(): void {
  writeFileSync(`${BB}/devtunnel`, `#!/usr/bin/env bash
case $1 in
  --version) echo "devtunnel 1.0.0" ;;
  list) cat "\${FAKE_SYSTEMCTL_DIR:?}/dt.names" 2>/dev/null ;;
  create) echo "$2.reg 0 0" >> "\${FAKE_SYSTEMCTL_DIR:?}/dt.names" ;;
  show) for p in 3000 21220 21221; do echo "  https://rnd$p-$p.brs.devtunnels.ms"; done ;;
  user) echo "Logged in as regressao using GitHub." ;;
  access) [[ $2 == list ]] && printf 'cabecalho\\nregra 1\\nregra 2\\n' ;;
esac
exit 0
`, { mode: 0o755 });
  rmSync(`${BB}/journalctl`, { force: true });
  writeFileSync(`${BB}/journalctl`, `#!/usr/bin/env bash
echo "https://a-3000.x.devtunnels.ms https://b-21220.y.devtunnels.ms https://w-21221.z.devtunnels.ms"
`, { mode: 0o755 });
}
const takeArgv = (): string => { const f = `${SC}/argv.log`; const t = existsSync(f) ? readFileSync(f, "utf8") : ""; writeFileSync(f, ""); return t; };
const stamps = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}T[0-9:]{8}Z/g, "<ts>");

/** Como `step`, com o argv do systemd-run (zerado a cada passo) e o ambiente do túnel e da limpeza. */
function stepX(label: string, argv: string[], extra: Record<string, string> = {}, units: string[] = []): void {
  calls(); takeArgv();
  const o = r.X(argv, { env: base({ HADES_CERBERUS_PORTA: "off", HADES_TUNNEL_POLL_MS: "10", HADES_PANEL_PORT: "21220", ...extra }), merge: true });
  let t = `## ${label}\nrc=${o.rc}\n${stamps(o.out)}`;
  for (const u of units) t += `-- ${u}\n${rd(`${UD}/${u}`)}`;
  t += `-- systemd-run\n${takeArgv()}-- systemctl\n${calls()}`;
  secoes.push(norm(t));
}

describe("contrato systemd", () => {
  mkdirSync(D, { recursive: true });
  r.must(r.X(["bash", `${SKILL}/kit/install.sh`], { merge: true, env: base({ SKIP_WORKTREE: "1", SKIP_DOCTOR: "1", SKIP_SYSTEMD: "1" }) }));
  const panel = (verb: string) => ["bash", `${D}/panel.sh`, verb];

  test("verbos do panel.sh e do notify.sh: units e chamadas gravadas", () => {
    const login = { HADES_PANEL_AUTOSTART: "login" };
    step("panel start (login)", panel("start"), login, ["hds-panel.service"]);
    step("panel start de novo (já no ar)", panel("start"), login);
    step("panel status", panel("status"), login);
    step("panel url", panel("url"));
    step("panel autostart boot", panel("autostart"), { HADES_PANEL_AUTOSTART: "boot" });
    step("panel autostart off", panel("autostart"), { HADES_PANEL_AUTOSTART: "off" });
    step("panel restart", panel("restart"), login);
    step("panel stop", panel("stop"), login);
    step("panel verbo inválido", panel("xis"));
    step("notify apply ligado", ["bash", `${D}/notify.sh`, "apply"], { HADES_NOTIFY: "1" }, ["hds-notify.service"]);
    step("notify apply de novo", ["bash", `${D}/notify.sh`, "apply"], { HADES_NOTIFY: "1" });
    step("notify restart", ["bash", `${D}/notify.sh`, "restart"]);
    step("notify status", ["bash", `${D}/notify.sh`, "status"]);
    step("notify apply desligado", ["bash", `${D}/notify.sh`, "apply"], { HADES_NOTIFY: "0" });
    step("linger state", ["bash", `${D}/linger.sh`, "state"]);
    expect(secoes.length).toBeGreaterThan(10);
  }, 30_000); // vários verbos em série: sob a suíte em paralelo passa dos 5 s padrão

  test("jobs e chat do painel: argv do systemd-run", () => {
    const o = r.X([`${r.env0.HADES_BUN}`, `${SKILL}/loop/test/ts/lib/contrato-efemeros.ts`, D], { env: base(), merge: true });
    secoes.push(norm(`## jobs e chat do painel\nrc=${o.rc}\n${o.out}-- systemd-run e systemctl\n${rd(`${SC}/argv.log`)}-- systemctl\n${calls()}`));
    expect(o.rc).toBe(0);
  });

  test("amostrador e log de unit do painel: consultas e o que a tela mostra", () => {
    mkdirSync(`${SC}/show`, { recursive: true });
    writeFileSync(`${SC}/listing`, "hds-panel.service loaded active running Painel\nhds-api.service loaded active running Api\n");
    writeFileSync(`${SC}/show/hds-panel.service`, "Id=hds-panel.service\nActiveState=active\nSubState=running\nResult=success\nNRestarts=2\nMemoryCurrent=1048576\nCPUUsageNSec=5000000000\nActiveEnterTimestampMonotonic=1000000\nExecMainStatus=0");
    writeFileSync(`${SC}/journal`, "2026-01-01T00:00:00+0000 host hds-panel[1]: no ar\n");
    rmSync(`${SC}/argv.log`, { force: true });
    calls();
    const o = r.X([`${r.env0.HADES_BUN}`, `${SKILL}/loop/test/ts/lib/contrato-painel.ts`, D], { env: base(), merge: true });
    // o amostrador dispara as chamadas em paralelo: o contrato é o conjunto, não a ordem
    const chamadas = calls().split("\n").filter((l) => /list-units|show|journalctl/.test(l)).sort().join("\n");
    secoes.push(norm(`## amostrador e log de unit\nrc=${o.rc}\n${o.out}-- systemctl (list-units e show)\n${chamadas}\n-- journalctl\n${rd(`${SC}/argv.log`).split("systemd-run")[0]}`));
    expect(o.rc).toBe(0);
  });

  test("clean apply: as units gravadas e as chamadas ao systemctl", () => {
    const clean = (verb: string[]) => ["bash", `${D}/clean.sh`, ...verb];
    const units = ["hds-logrotate.service", "hds-logrotate.timer"];
    stepX("clean apply ligado", clean(["apply"]), { HADES_CLEAN_TIMER: "on", HADES_CLEAN_EVERY: "6h" }, units);
    stepX("clean apply de novo", clean(["apply"]), { HADES_CLEAN_TIMER: "on", HADES_CLEAN_EVERY: "6h" });
    stepX("clean apply com intervalo novo", clean(["apply"]), { HADES_CLEAN_TIMER: "on", HADES_CLEAN_EVERY: "2h" }, units);
    // só a linha do timer: o tamanho das categorias depende do que os passos anteriores gravaram
    stepX("clean status (linha do timer)", ["bash", "-c", `bash "${D}/clean.sh" status --tsv | sed -n 1p`], { HADES_CLEAN_TIMER: "on" });
    stepX("clean apply desligado", clean(["apply"]), { HADES_CLEAN_TIMER: "off", HADES_CLEAN_EVERY: "2h" });
    expect(secoes.length).toBeGreaterThan(15);
  }, 60_000);

  test("túnel: o systemd-run e o systemctl de front, painel e widget", () => {
    tunnelStubs();
    const tunnel = (...verb: string[]) => ["bash", `${D}/tunnel.sh`, ...verb];
    const front = { HADES_TUNNEL_PORT: "3000", HADES_TUNNEL_ANON_TTL: "2d" };
    stepX("tunnel create", tunnel("create"), front);
    stepX("tunnel publish-cmds", tunnel("publish-cmds"), front);
    stepX("tunnel url", tunnel("url"), front);
    stepX("tunnel status", tunnel("status"), front);
    stepX("tunnel stop-cmd", tunnel("stop-cmd"));
    stepX("tunnel panel-start", tunnel("panel-start"));
    stepX("tunnel panel-status", tunnel("panel-status"));
    stepX("tunnel panel-stop", tunnel("panel-stop"));
    stepX("tunnel widget-create", tunnel("widget-create"));
    stepX("tunnel widget-publish-cmds", tunnel("widget-publish-cmds"), { HADES_WIDGET_TUNNEL_TTL: "2d" });
    stepX("tunnel widget-stamp", tunnel("widget-stamp"), { HADES_WIDGET_TUNNEL_TTL: "48h" });
    stepX("tunnel widget-start", tunnel("widget-start"));
    stepX("tunnel widget-status", tunnel("widget-status"));
    stepX("tunnel widget-stop", tunnel("widget-stop"));
    expect(secoes.length).toBeGreaterThan(25);
  }, 120_000);

  test("golden", () => {
    // UPDATE_GOLDEN=1 só se usa ao gravar o contrato pela primeira vez; depois dele o golden é a verdade
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(`${GOLD}/systemd-contrato.txt`, `${secoes.join("\n")}\n`);
    checkText("systemd-contrato.txt", `${secoes.join("\n")}\n`);
  });
});
