// Túnel público do front, do painel e do widget Android (kit/tunnel.sh), por Microsoft devtunnel. Os passos que PUBLICAM a
// máquina para fora (liberar acesso e hospedar) são do DONO: aqui só se imprime o comando `! ...`. Todo túnel passa antes pela
// avaliação do Cerberus (hades cerberus avaliar tunel): barrou, sai 1 sem publicar.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { need } from "../lib/deps.ts";
import { readText } from "../lib/fs.ts";
import { stateDir, runInherit } from "../lib/kit.ts";
import { EXIT, out } from "../lib/output.ts";
import { home, selfCli } from "../lib/paths.ts";
import { run, which } from "../lib/proc.ts";
import { unitPrefix } from "../lib/config.ts";
import { serviceManager, type ServiceManager } from "../lib/service-manager.ts";

export const USAGE = `  tunnel.sh install        baixa o CLI para ~/.local/bin (≈56 MB; o download é lento, esperar o curl terminar)
  tunnel.sh login-cmd      imprime o comando de login (device code GitHub) para o dono rodar
  tunnel.sh create         cria o túnel persistente \`hades\` (30 dias; \`hades-<id>\` com HADES_ID) + porta HADES_TUNNEL_PORT
  tunnel.sh publish-cmds   imprime os 2 comandos do dono: acesso anônimo 24 h + host como unit systemd
  tunnel.sh url            lê a URL pública do journal da unit, grava em tunnel.url e aplica no .env (CORS e links)
  tunnel.sh status | stop-cmd

Túnel do PAINEL (controle remoto do Hades), separado do túnel do front: \`hades-panel\` (\`hades-panel-<id>\` com HADES_ID),
porta do painel (HADES_PANEL_PORT, padrão 21220), 30 dias. Units: $HU-devtunnel (front, no slice) e $HU-panel-tunnel.
Acesso SÓ da conta dona do devtunnel (login GitHub no navegador): nenhuma regra anônima ou de org é criada. Além
disso o painel exige a chave de acesso remoto ($D/panel/remote.key, mostrada só no painel local).
  tunnel.sh panel-start | panel-url | panel-stop | panel-status

Túnel do WIDGET Android, terceiro e separado: \`hades-widget\` (\`hades-widget-<id>\`), porta HADES_WIDGET_PORT (21221), unit
$HU-widget-tunnel. É o único com acesso ANÔNIMO além do front, e só nessa porta, onde o listener do painel responde só
GET /api/widget; o token do widget é a única autenticação. O Cerberus vê acesso=anonimo e só deixa passar com exceção
do dono (nada de isenção). Criar, status e url são do agente; publicar e renovar (30 d) são do DONO.
  tunnel.sh widget-create | widget-publish-cmds | widget-stamp | widget-start | widget-url | widget-stop | widget-status | widget-renew-cmds`;

const FRONT_PORT = /^[0-9]{4,5}$/;
const DEFAULT_PANEL_PORT = "21220";
const DEFAULT_WIDGET_PORT = "21221";
const DEFAULT_WIDGET_TTL = "30d";
const TUNNEL_TTL = "30d";
const URL_POLLS = 20;
const URL_POLL_MS = Number(process.env.HADES_TUNNEL_POLL_MS || 2000); // só o teste encurta a espera entre as leituras da URL
const FRONT_JOURNAL_LINES = 50;
const PRIVATE_JOURNAL_LINES = 80;
const RESTART_SEC = 10;
const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const REMOTE_KEY_BYTES = 18;
const LOGIN_CMD = "! devtunnel user login -g -d";
const NOT_LOGGED_IN = "devtunnel não logado: rode no terminal  devtunnel user login -g -d";
const TOKEN_INVALID = `token GitHub do devtunnel inválido ou expirado (401 invalid_token): o login precisa ser refeito pelo dono, no terminal:  ${LOGIN_CMD.slice(2)}   (tunnel.sh login-cmd)`;
// o `user show` só lê o perfil guardado e não percebe o token revogado; a API responde 401 invalid_token
const TOKEN_REJECTED = /\b401\b|invalid_token|unauthorized/i;

class TunnelLoginError extends Error {}
const DOWNLOAD_BASE = "https://aka.ms/TunnelsCliDownload";
/** O build do devtunnel da máquina: osx-arm64 | osx-x64 no macOS; no Linux sempre linux-x64, como sempre foi. */
const downloadUrl = (): string => `${DOWNLOAD_BASE}/${process.platform === "darwin" ? `osx-${process.arch === "arm64" ? "arm64" : "x64"}` : "linux-x64"}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const chomp = (text: string): string => text.replace(/\n+$/, "");
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const content = (text: string | undefined): string => chomp(text ?? "");

type Kind = "front" | "painel" | "widget";

interface Names {
  tunnel: string;
  panel: string;
  widget: string;
  unitFront: string;
  unitPanel: string;
  unitWidget: string;
}

interface Ctx {
  d: string;
  script: string;
  names: Names;
  slice: string;
  port: string;
  panelPort: string;
  widgetPort: string;
  widgetTtl: string;
  anonTtl: string;
}

function makeCtx(): Ctx {
  const d = stateDir();
  const id = process.env.HADES_ID ?? "";
  // devtunnel aceita hífen e não underscore: o HADES_ID entra com _ trocado por -
  const tid = id ? `-${id.replaceAll("_", "-")}` : "";
  const hu = process.env.HU || unitPrefix(d);
  return {
    d,
    script: join(d, "tunnel.sh"),
    names: {
      tunnel: `hades${tid}`,
      panel: `hades-panel${tid}`,
      widget: `hades-widget${tid}`,
      unitFront: `${hu}-devtunnel`,
      unitPanel: `${hu}-panel-tunnel`,
      unitWidget: `${hu}-widget-tunnel`,
    },
    slice: process.env.HSLICE || `hades${id ? `_${id}` : ""}`,
    port: process.env.HADES_TUNNEL_PORT ?? "",
    panelPort: process.env.HADES_PANEL_PORT ?? "",
    widgetPort: process.env.HADES_WIDGET_PORT || DEFAULT_WIDGET_PORT,
    widgetTtl: process.env.HADES_WIDGET_TUNNEL_TTL || DEFAULT_WIDGET_TTL,
    anonTtl: process.env.HADES_TUNNEL_ANON_TTL ?? "",
  };
}

const read = (ctx: Ctx, name: string): string | undefined => readText(join(ctx.d, name));

/** `cat arquivo` sem silenciar: se não existe, a mensagem do próprio cat vai ao terminal e o valor é vazio. */
function catLoud(path: string): string {
  const text = readText(path);
  if (text !== undefined) return chomp(text);
  spawnSync("cat", [path], { stdio: ["ignore", "ignore", "inherit"] });
  return "";
}

let cachedManager: ServiceManager | undefined;
const manager = (): ServiceManager => (cachedManager ??= serviceManager());
const isActive = (unit: string): boolean => manager().isActive(unit);
const activeState = (unit: string): string => manager().activeState(unit);

function devtunnelLoggedIn(): boolean {
  const r = run("devtunnel", ["user", "show"]);
  // o original mede `devtunnel … | grep` sob pipefail: saída ≠ 0 do devtunnel também vale como deslogado
  if (!(r.status === 0 && /logged in as/i.test(`${r.stdout}${r.stderr}`))) return false;
  // `list` chama a API com o token: com o token inválido responde 401 mesmo com o `user show` dizendo "logged in"
  const probe = run("devtunnel", ["list"]);
  if (TOKEN_REJECTED.test(`${probe.stdout}${probe.stderr}`)) throw new TunnelLoginError(TOKEN_INVALID);
  return true;
}

/** Confere o login antes de criar; sem login (ou com token inválido) o erro chega ao dono, nunca vira túnel vazio. */
function requireLogin(): void {
  if (!devtunnelLoggedIn()) throw new TunnelLoginError(NOT_LOGGED_IN);
}

/** Id completo (`nome.cluster`) do túnel de nome `name` na lista do devtunnel, ou "" (o awk do original). */
function findTunnel(name: string): string {
  const prefix = new RegExp(`^${escapeRegExp(name)}\\.`);
  for (const line of run("devtunnel", ["list"]).stdout.split("\n")) {
    const first = line.trim().split(/\s+/)[0] ?? "";
    if (prefix.test(first)) return first;
  }
  return "";
}

function createTunnel(name: string, description: string): string {
  const found = findTunnel(name);
  if (found) return found;
  const r = run("devtunnel", ["create", name, "--description", description, "--expiration", TUNNEL_TTL]);
  if (TOKEN_REJECTED.test(`${r.stdout}${r.stderr}`)) throw new TunnelLoginError(TOKEN_INVALID);
  return findTunnel(name);
}

function hasPort(id: string, port: string, whole: boolean): boolean {
  const text = run("devtunnel", ["port", "list", id]).stdout;
  const pattern = whole ? new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(port)}($|[^A-Za-z0-9_])`, "m") : new RegExp(escapeRegExp(port));
  return pattern.test(text);
}

function ensurePort(id: string, port: string, whole: boolean): void {
  if (!hasPort(id, port, whole)) run("devtunnel", ["port", "create", id, "-p", port, "--protocol", "http"]);
}

/** Última URL pública da porta no log da unit (o journal no systemd, o arquivo do plist no launchd), ou "". */
function logUrl(unit: string, lines: number, port: string): string {
  if (manager().kind === "systemd") need("journalctl");
  const text = manager().readLog(unit, lines);
  const found = [...text.matchAll(new RegExp(`https://[a-z0-9]+-${escapeRegExp(port)}\\.[a-z0-9]+\\.devtunnels\\.ms`, "g"))];
  return found.length > 0 ? (found[found.length - 1]?.[0] ?? "") : "";
}

/** Host público da porta, lido de `devtunnel show <id>` (o devtunnel dá ao túnel nomeado um host aleatório: não dá para montá-lo), ou "". */
function portHost(id: string, port: string): string {
  const text = run("devtunnel", ["show", id]).stdout;
  const found = [...text.matchAll(new RegExp(`https://([a-z0-9]+-${escapeRegExp(port)}\\.[a-z0-9]+\\.devtunnels\\.ms)`, "g"))];
  return found.length > 0 ? (found[found.length - 1]?.[1] ?? "") : "";
}

/** Cerberus: abrir túnel para fora é momento de fronteira. O host que ele confere é o que o `devtunnel show` mostra; sem ele, barra. */
function cerberusAllows(kind: Kind, port: string, id: string): boolean {
  const host = portHost(id, port);
  if (host === "") {
    out(`o Cerberus barrou o túnel ${kind}: não li a URL da porta ${port} em "devtunnel show ${id}" (crie a porta com o create); nada publicado`);
    return false;
  }
  const access = kind === "painel" ? "autenticado" : "anonimo";
  const cli = selfCli("cerberus", "avaliar", "tunel");
  const code = runInherit(cli.command, [...cli.args, "--ctx", `tunel=${kind}`, "--ctx", `porta=${port}`, "--ctx", `host=${host}`, "--ctx", `acesso=${access}`]);
  if (code === 0) return true;
  out(`o Cerberus barrou o túnel ${kind} (acima): nada publicado`);
  return false;
}

/** O log do serviço no launchd: logs/<sufixo da unit>.log (o HU não tem hífen, o primeiro separa o sufixo). */
const unitLog = (ctx: Ctx, unit: string): string => join(ctx.d, "logs", `${unit.slice(unit.indexOf("-") + 1)}.log`);

function startUnit(ctx: Ctx, unit: string, id: string, slice?: string): void {
  manager().resetFailed(unit);
  if (!isActive(unit)) {
    manager().runKeepAlive({ unit, env: [["PATH", process.env.PATH ?? ""]], argv: ["devtunnel", "host", id], logFile: unitLog(ctx, unit), restartSec: RESTART_SEC, slice });
  }
}

async function waitUrl(read: () => number): Promise<void> {
  for (let i = 0; i < URL_POLLS; i++) {
    if (read() === EXIT.ok) return;
    await sleep(URL_POLL_MS);
  }
}

function needPort(ctx: Ctx): boolean {
  if (FRONT_PORT.test(ctx.port)) return true;
  out("sem porta do front (HADES_TUNNEL_PORT vazio): defina em Configurações → Túnel");
  return false;
}

function install(): number {
  if (which("devtunnel")) return versionHead();
  need("curl");
  const bin = join(home(), ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const target = join(bin, "devtunnel");
  if (runInherit("curl", ["-sSL", "-o", target, downloadUrl()]) !== 0) return EXIT.fail;
  chmodSync(target, 0o755);
  return versionHead();
}

function versionHead(): number {
  const r = run("devtunnel", ["--version"]);
  out(r.stdout.split("\n")[0] ?? "");
  return r.status;
}

function create(ctx: Ctx): number {
  if (!needPort(ctx)) return EXIT.usage;
  need("devtunnel");
  requireLogin();
  const id = createTunnel(ctx.names.tunnel, `Hades (front ${ctx.port})`);
  ensurePort(id, ctx.port, true);
  writeFileSync(join(ctx.d, "tunnel.id"), `${id}\n`);
  out(`túnel ${id} com a porta ${ctx.port} (acesso: só o dono até publish)`);
  return EXIT.ok;
}

function publishCmds(ctx: Ctx): number {
  if (!needPort(ctx)) return EXIT.usage;
  const id = catLoud(join(ctx.d, "tunnel.id"));
  if (!cerberusAllows("front", ctx.port, id)) return EXIT.fail;
  out(`! devtunnel access create ${id} -p ${ctx.port} --anonymous -e ${ctx.anonTtl}`);
  out(manager().kind === "launchd" ? `! ${ctx.script} front-start` : `! systemd-run --user --unit=${ctx.names.unitFront} --slice=${ctx.slice} devtunnel host ${id}`);
  return EXIT.ok;
}

function url(ctx: Ctx): number {
  if (!needPort(ctx)) return EXIT.usage;
  const found = logUrl(ctx.names.unitFront, FRONT_JOURNAL_LINES, ctx.port);
  if (!found) {
    out(`unit ${ctx.names.unitFront} sem URL ainda`);
    return EXIT.fail;
  }
  // o .env do projeto (CORS, links) é do plugin: o gen-env.sh dele, se houver, relê o tunnel.url
  writeFileSync(join(ctx.d, "tunnel.url"), `${found}\n`);
  if (existsSync(join(ctx.d, "gen-env.sh"))) runInherit("bash", [join(ctx.d, "gen-env.sh")]);
  const after = chomp(read(ctx, "tunnel-after.txt") ?? "");
  out(`${found} — reinicie os serviços cujo .env mudou${after ? after.split("\n").map((l) => ` · ${l}`).join("\n") : ""}`);
  return EXIT.ok;
}

/** Hospeda o túnel do front como serviço do launchd; o acesso anônimo é do `publish-cmds` (já avaliado pelo Cerberus). */
function frontStart(ctx: Ctx): number {
  if (!needPort(ctx)) return EXIT.usage;
  need("devtunnel");
  need(manager().requires);
  const id = catLoud(join(ctx.d, "tunnel.id"));
  if (id === "") return EXIT.fail;
  startUnit(ctx, ctx.names.unitFront, id);
  out(`${ctx.names.unitFront}: ${activeState(ctx.names.unitFront)} (a URL: ${ctx.script} url)`);
  return EXIT.ok;
}

function status(ctx: Ctx): number {
  need(manager().requires);
  out(`${ctx.names.unitFront}: ${activeState(ctx.names.unitFront)} ${content(read(ctx, "tunnel.url"))}`);
  if (ctx.port === "") return EXIT.fail;
  const r = run("devtunnel", ["access", "list", content(read(ctx, "tunnel.id")), "-p", ctx.port]);
  const tail = r.stdout.split("\n");
  if (tail[tail.length - 1] === "") tail.pop();
  for (const line of tail.slice(-2)) out(line);
  return EXIT.ok;
}

function showName(ctx: Ctx): string {
  const m = /as ([^ \n]+)/g;
  const text = run("devtunnel", ["user", "show"]);
  return [...`${text.stdout}${text.stderr}`.matchAll(m)].map((x) => x[1] ?? "").join("\n");
}

async function panelStart(ctx: Ctx): Promise<number> {
  need("devtunnel");
  need(manager().requires);
  requireLogin();
  const id = createTunnel(ctx.names.panel, `Painel do Hades (${ctx.panelPort})`);
  if (!id) {
    out(`não consegui criar o túnel ${ctx.names.panel}`);
    return EXIT.fail;
  }
  ensurePort(id, ctx.panelPort, false);
  writeFileSync(join(ctx.d, "panel-tunnel.id"), `${id}\n`);
  // só o dono: se alguma regra anônima ou de org existir no túnel (criada à mão), ela é removida
  run("devtunnel", ["access", "reset", id]);
  run("devtunnel", ["access", "reset", id, "-p", ctx.panelPort]);
  const key = join(ctx.d, "panel", "remote.key");
  if ((readText(key) ?? "") === "") {
    mkdirSync(dirname(key), { recursive: true });
    writeFileSync(key, `${randomBytes(REMOTE_KEY_BYTES).toString("base64").replace(/[/+=]/g, "")}\n`, { mode: 0o600 });
    chmodSync(key, 0o600);
  }
  if (!isActive(ctx.names.unitPanel) && !cerberusAllows("painel", ctx.panelPort, id)) return EXIT.fail;
  startUnit(ctx, ctx.names.unitPanel, id);
  await waitUrl(() => panelUrl(ctx, true));
  out(`acesso: só a conta dona do devtunnel (${showName(ctx)})`);
  return panelUrl(ctx, false);
}

function panelUrl(ctx: Ctx, quiet: boolean): number {
  const found = logUrl(ctx.names.unitPanel, PRIVATE_JOURNAL_LINES, ctx.panelPort);
  if (!found) {
    if (!quiet) out(`unit ${ctx.names.unitPanel} sem URL ainda`);
    return EXIT.fail;
  }
  writeFileSync(join(ctx.d, "panel-tunnel.url"), `${found}\n`);
  if (!quiet) out(`painel remoto: ${found}`);
  return EXIT.ok;
}

function stopUnit(unit: string, message: string): number {
  manager().stopTransient(unit);
  manager().resetFailed(unit);
  out(message);
  return EXIT.ok;
}

function widgetCreate(ctx: Ctx): number {
  need("devtunnel");
  requireLogin();
  const id = createTunnel(ctx.names.widget, `Widget do Hades (${ctx.widgetPort})`);
  if (!id) {
    out(`não consegui criar o túnel ${ctx.names.widget}`);
    return EXIT.fail;
  }
  ensurePort(id, ctx.widgetPort, true);
  writeFileSync(join(ctx.d, "widget-tunnel.id"), `${id}\n`);
  out(`túnel ${id} com a porta ${ctx.widgetPort} (acesso: só o dono até o dono publicar)`);
  return EXIT.ok;
}

/** Id do túnel do widget, ou undefined depois de avisar que falta criá-lo. */
function widgetId(ctx: Ctx): string | undefined {
  const id = read(ctx, "widget-tunnel.id");
  if (id === undefined) out(`sem túnel do widget: rode  ${ctx.script} widget-create`);
  return id === undefined ? undefined : chomp(id);
}

function widgetPublish(ctx: Ctx, renew: boolean): number {
  const id = widgetId(ctx);
  if (id === undefined || !cerberusAllows("widget", ctx.widgetPort, id)) return EXIT.fail;
  // sem o reset o prazo do anônimo não muda (reference/tunnel.md §Túnel que parou de conectar)
  if (renew) out(`! devtunnel access reset ${id} -p ${ctx.widgetPort}`);
  out(`! devtunnel access create ${id} -p ${ctx.widgetPort} --anonymous -e ${ctx.widgetTtl}`);
  if (!renew) out(manager().kind === "launchd" ? `! ${ctx.script} widget-start` : `! systemd-run --user --unit=${ctx.names.unitWidget} --slice=${ctx.slice} -p Restart=on-failure -p RestartSec=10 devtunnel host ${id}`);
  out(`! ${ctx.d}/tunnel.sh widget-stamp   # grava a validade (o painel mostra); depois do host, rode ${ctx.d}/tunnel.sh widget-url`);
  return EXIT.ok;
}

function widgetStamp(ctx: Ctx): number {
  const count = ctx.widgetTtl.replace(/[dh]$/, "");
  if (!/^[0-9]+$/.test(count)) {
    out(`HADES_WIDGET_TUNNEL_TTL inválido: ${ctx.widgetTtl} (ex.: 30d, 48h)`);
    return EXIT.usage;
  }
  const hours = Number(count) * (ctx.widgetTtl.endsWith("h") ? 1 : HOURS_PER_DAY);
  const stamp = new Date(Date.now() + hours * MS_PER_HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(join(ctx.d, "widget-tunnel.expires"), `${stamp}\n`);
  out(`acesso anônimo do widget vale até ${stamp}`);
  return EXIT.ok;
}

async function widgetStart(ctx: Ctx): Promise<number> {
  need(manager().requires);
  const id = widgetId(ctx);
  if (id === undefined || (!isActive(ctx.names.unitWidget) && !cerberusAllows("widget", ctx.widgetPort, id))) return EXIT.fail;
  startUnit(ctx, ctx.names.unitWidget, id, ctx.slice);
  await waitUrl(() => widgetUrl(ctx, true));
  return widgetUrl(ctx, false);
}

function widgetUrl(ctx: Ctx, quiet: boolean): number {
  const found = logUrl(ctx.names.unitWidget, PRIVATE_JOURNAL_LINES, ctx.widgetPort);
  if (!found) {
    if (!quiet) out(`unit ${ctx.names.unitWidget} sem URL ainda`);
    return EXIT.fail;
  }
  writeFileSync(join(ctx.d, "widget-tunnel.url"), `${found}\n`);
  if (!quiet) out(`widget: ${found}/api/widget`);
  return EXIT.ok;
}

function widgetStatus(ctx: Ctx): number {
  const expires = chomp(read(ctx, "widget-tunnel.expires") ?? "") || "desconhecida";
  out(`${ctx.names.unitWidget}: ${activeState(ctx.names.unitWidget)} ${content(read(ctx, "widget-tunnel.url"))} · validade: ${expires}`);
  return EXIT.ok;
}

export async function tunnelCommand(args: string[]): Promise<number> {
  try {
    return await dispatch(args);
  } catch (error) {
    if (!(error instanceof TunnelLoginError)) throw error;
    out(error.message);
    return EXIT.fail;
  }
}

async function dispatch(args: string[]): Promise<number> {
  const ctx = makeCtx();
  switch (args[0] ?? "") {
    case "install":
      return install();
    case "login-cmd":
      out(LOGIN_CMD);
      return EXIT.ok;
    case "create":
      return create(ctx);
    case "publish-cmds":
      return publishCmds(ctx);
    case "url":
      return url(ctx);
    case "status":
      return status(ctx);
    case "stop-cmd":
      out(manager().kind === "launchd" ? `! ${ctx.script} front-stop` : `! systemctl --user stop ${ctx.names.unitFront}`);
      return EXIT.ok;
    // front-start e front-stop são o equivalente no launchd das linhas `! systemd-run` e `! systemctl stop` do dono
    case "front-start":
      return frontStart(ctx);
    case "front-stop":
      return stopUnit(ctx.names.unitFront, "túnel do front parado");
    case "panel-start":
      return panelStart(ctx);
    case "panel-url":
      return panelUrl(ctx, false);
    case "panel-stop":
      return stopUnit(ctx.names.unitPanel, "túnel do painel parado");
    case "panel-status":
      out(`${ctx.names.unitPanel}: ${activeState(ctx.names.unitPanel)} ${content(read(ctx, "panel-tunnel.url"))}`);
      return EXIT.ok;
    case "widget-create":
      return widgetCreate(ctx);
    case "widget-publish-cmds":
      return widgetPublish(ctx, false);
    case "widget-renew-cmds":
      return widgetPublish(ctx, true);
    case "widget-stamp":
      return widgetStamp(ctx);
    case "widget-start":
      return widgetStart(ctx);
    case "widget-url":
      return widgetUrl(ctx, false);
    case "widget-stop":
      return stopUnit(ctx.names.unitWidget, "túnel do widget parado");
    case "widget-status":
      return widgetStatus(ctx);
    default:
      out(USAGE);
      return EXIT.usage;
  }
}
