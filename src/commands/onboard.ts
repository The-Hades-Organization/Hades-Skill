// Onboarding das features do Hades (kit/onboard.sh): quais o dono quer preparar agora e, para cada uma, o estado e os passos.
// Só leitura, exceto select/skip/done/run. O que é do DONO (túnel público, login, sudo, token) só é mostrado, nunca
// executado; `run` só aceita passo da Hades. Checagem de passo do plugin: $D/checks/<nome>.sh (bash, do pacote do projeto).
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { claudeSettingsPath } from "../lib/autonomy.ts";
import { readText } from "../lib/fs.ts";
import { coletaLigada } from "../lib/limites-aviso.ts";
import { lerAmostras } from "../lib/limites-io.ts";
import { devtunnelLoggedIn, ghToken, lingering, unitIs } from "../lib/checks.ts";
import { herdrAvailable } from "../lib/herdr.ts";
import { readCatalog, unitPrefix } from "../lib/config.ts";
import { type BuiltFeature, NOT_VERIFIED, Onboard, type StepResult, onboardLine, onboardProgress, renderText } from "../lib/onboard.ts";
import { EXIT, out, warn } from "../lib/output.ts";
import { stateDir } from "../lib/kit.ts";
import { pyDumps } from "../lib/pyjson.ts";
import { home } from "../lib/paths.ts";
import { run, which } from "../lib/proc.ts";
import { serviceManager } from "../lib/service-manager.ts";

export const HELP = `Onboarding das features do Hades: quais o dono quer preparar agora e, para cada uma, o estado e os passos.
O catálogo é onboard.tsv somado ao $D/plugin/onboard.tsv do plugin; a escolha do dono fica em $D/onboard.json. Só leitura, exceto select/skip/done/run.
O que é do DONO (túnel público, login, sudo, token) só é mostrado, nunca executado; \`run\` só aceita passo da Hades.
Uso: onboard.sh status [--json|--brief|--doctor|--line] [--quick]   estado de cada passo (feito · pendente · não se aplica)
     --line: uma linha com o que falta e o comando; vazia com o onboarding completo (é o aviso do /hades e do install.sh)
     onboard.sh show <feature>      instruções e comandos de uma feature (remoto notificacoes automatico contas)
     onboard.sh select <feature…>   preparar agora       onboard.sh skip <feature…>   não preparar
     onboard.sh done|undone <passo> marca um passo manual (ex.: instalar o PWA)
     onboard.sh run <passo>         roda o comando de um passo da Hades (peça o ok do dono antes)
     onboard.sh pick                escolhe as features por menu (precisa de terminal)
     onboard.sh tour seen|skip      grava que o tour do painel foi visto ou pulado
     onboard.sh reset               esquece a escolha (e o tour volta a ser oferecido)
  --quick   não consulta rede nem docker (devtunnel e firewall ficam "não verificado"); é o que o install.sh usa
Saída: 0 ok · 2 uso inválido.
set -uo pipefail`;

const USAGE = "uso: onboard.sh status|show|select|skip|done|undone|run|pick|tour|reset (--help)";
const FW_PROBE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PORT = /^[0-9]{1,5}$/;
const FIREWALL_TIMEOUT_MS = 5000;
const NO_PROBE_NOTE = "na sem sonda (HADES_FW_PROBE vazio)";

const env = (key: string, fallback: string): string => process.env[key] || fallback;
const done = "feito";
const pending = "pendente";

const SUBNET = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const OCTET_MAX = 255;
const GATEWAY_MAX_PREFIX = 30;
const NO_SUBNET_COMMAND = "libere a rede docker do Hades -> host no seu firewall (nft/iptables, ufw ou firewalld)";

/** Sub-rede da instância: HADES_DOCTOR_SUBNET (o plugin dá o padrão); vazia, a da rede <projeto>_default, se existir. */
function instanceSubnet(): string {
  const configured = process.env.HADES_DOCTOR_SUBNET ?? "";
  const found = configured || run("docker", ["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", `${process.env.HPROJ || "hades"}_default`], { timeoutMs: FIREWALL_TIMEOUT_MS }).stdout.trim().split(/\s+/)[0] || "";
  return SUBNET.test(found) ? found : "";
}

/** Gateway da sub-rede, o primeiro endereço dela (o que o docker dá à bridge): 172.21.0.0/16 → 172.21.0.1. */
export function subnetGateway(subnet: string): string | undefined {
  const m = SUBNET.exec(subnet);
  if (!m) return undefined;
  const octets = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (bits > GATEWAY_MAX_PREFIX || octets.some((o) => o > OCTET_MAX)) return undefined;
  const ip = octets.reduce((acc, o) => acc * 256 + o, 0);
  const block = 2 ** (32 - bits);
  const first = Math.floor(ip / block) * block + 1;
  return [24, 16, 8, 0].map((shift) => Math.floor(first / 2 ** shift) % 256).join(".");
}

/** A sonda <container>:<porta>: o container alcança o host na porta de um serviço (firewall docker → host). */
function firewallOpen(probe: string): boolean {
  const ctr = probe.split(":")[0] as string;
  const port = probe.slice(probe.lastIndexOf(":") + 1);
  if (!probe.includes(":") || !FW_PROBE.test(ctr) || !PORT.test(port)) return false;
  const gateway = subnetGateway(instanceSubnet());
  if (!gateway) return false;
  return run("docker", ["exec", ctr, "bash", "-c", `timeout 4 bash -c 'echo > /dev/tcp/${gateway}/${port}'`]).status === 0;
}

/** Comando certo para liberar a rede docker → host (a sub-rede desta instância) conforme o firewall ativo da máquina. */
export function firewallCommand(): string {
  const net = instanceSubnet();
  if (!net) return NO_SUBNET_COMMAND;
  // ufw e firewalld são do Linux; o macOS não tem firewall de pacote para o docker → host
  if (serviceManager().kind === "systemd" && which("ufw") && run("systemctl", ["is-active", "--quiet", "ufw"]).status === 0) return `sudo ufw allow from ${net}`;
  if (which("firewall-cmd")) return `sudo firewall-cmd --permanent --zone=trusted --add-source=${net} && sudo firewall-cmd --reload`;
  return `libere ${net} -> host no seu firewall (nft/iptables)`;
}

/** $D/plugins.disabled com algum nome: o plugin do projeto está desligado e o front dele não sobe. */
function projectPluginDisabled(): boolean {
  return (readText(join(stateDir(), "plugins.disabled")) ?? "").split("\n").some((line) => line.trim() !== "");
}

type Check = (quick: boolean, hu: string) => string;

const CHECKS: Record<string, Check> = {
  devtunnel_login: (quick) => {
    if (!which("devtunnel")) return "pendente devtunnel não instalado";
    if (quick) return `pendente ${NOT_VERIFIED}`;
    return devtunnelLoggedIn() ? done : pending;
  },
  panel_tunnel: (_quick, hu) => (unitIs(`${hu}-panel-tunnel`, "active") ? done : pending),
  chat: () => (env("HADES_CHAT", "1") === "1" ? done : "na opcional, desligada (Configurações → Sessão Claude)"),
  remote_key: () => (fileHasContent(join(stateDir(), "panel", "remote.key")) ? done : pending),
  front_tunnel: (_quick, hu) => {
    if (projectPluginDisabled()) return "na plugin do projeto desligado: não há front para publicar";
    if (env("HADES_RUN_TUNNEL", "0") !== "1") return "pendente HADES_RUN_TUNNEL desligado (padrão): ligue em Configurações → Subida";
    return unitIs(`${hu}-devtunnel`, "active") ? done : pending;
  },
  notify_desktop: (_quick, hu) =>
    env("HADES_NOTIFY", "0") === "1" && env("HADES_NOTIFY_DESKTOP", "1") === "1" && unitIs(env("HADES_NOTIFY_UNIT", `${hu}-notify`), "active") ? done : pending,
  ntfy_on: (_quick, hu) =>
    env("HADES_NOTIFY", "0") === "1" && env("HADES_NOTIFY_NTFY", "0") === "1" && unitIs(env("HADES_NOTIFY_UNIT", `${hu}-notify`), "active") ? done : pending,
  panel_autostart: (_quick, hu) => (env("HADES_PANEL_AUTOSTART", "off") !== "off" && unitIs(`${hu}-panel`, "enabled") ? done : pending),
  linger: () => {
    if (serviceManager().kind === "launchd") return "na o launchd não tem linger: o painel sobe no login";
    return env("HADES_PANEL_AUTOSTART", "off") !== "boot" ? "na só vale no modo boot" : lingering() ? done : pending;
  },
  firewall: (quick) => {
    if (!which("docker")) return "na sem docker";
    if (quick) return `pendente ${NOT_VERIFIED}`;
    const probe = process.env.HADES_FW_PROBE ?? "";
    if (!probe) return NO_PROBE_NOTE;
    const name = probe.split(":")[0] as string;
    const running = run("docker", ["ps", "-q", "--filter", `name=^${name}$`], { timeoutMs: FIREWALL_TIMEOUT_MS }).stdout.trim();
    if (!running) return "na infra parada: sem como medir (o run-hades mede)";
    return firewallOpen(probe) ? done : pending;
  },
  gh: () => {
    if (!which("gh")) return "pendente gh não instalado";
    return ghToken() !== "" ? done : pending;
  },
  clickup: () => (fileHasContent(join(home(), ".claude", "clickup", "config.json")) ? done : pending),
  herdr: () => (herdrAvailable() ? done : pending),
  limites: () => {
    const medidas = lerAmostras().length;
    return coletaLigada(readText(claudeSettingsPath()), medidas) ? done : pending;
  },
};

function fileHasContent(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/** Checagem de passo do plugin: $D/checks/<nome>.sh. Sem o script, ou se ele sai com erro, vale também a nota padrão (como o `a && b || c`). */
function packCheck(dir: string, name: string): string {
  const script = join(dir, "checks", `${name}.sh`);
  const fallback = "na não se aplica a este projeto";
  try {
    accessSync(script, constants.X_OK);
  } catch {
    return fallback;
  }
  const r = spawnSync("bash", [script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? (r.stdout ?? "") : `${r.stdout ?? ""}${fallback}\n`;
}

const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

/** Lê `passo<TAB>estado<TAB>nota` como o original: por linha, três colunas. Checagem de plugin que sai ≠ 0 e imprime racha a resposta em duas linhas. */
function readResults(text: string): Map<string, StepResult> {
  const results = new Map<string, StepResult>();
  const lines = text.split(PY_LINE_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const [id = "", state = "", note = ""] = line.split("\t");
    results.set(id, { state, note });
  }
  return results;
}

/** Mede cada passo do catálogo; a nota é o resto depois do primeiro espaço da resposta da checagem. */
function evaluate(onboard: Onboard, quick: boolean): Map<string, StepResult> {
  const hu = process.env.HU || unitPrefix(onboard.dir);
  let text = "";
  for (const step of onboard.catalog().steps) {
    if (step.check === "manual") {
      text += `${step.id}\tmanual\t\n`;
      continue;
    }
    const check = CHECKS[step.check.replaceAll("-", "_")];
    const raw = (check ? check(quick, hu) : packCheck(onboard.dir, step.check)).replace(/\n+$/, "");
    const space = raw.indexOf(" ");
    const state = space < 0 ? raw : raw.slice(0, space);
    const note = state === "" ? "checagem falhou" : space < 0 ? "" : raw.slice(space + 1);
    text += `${step.id}\t${state === "" ? pending : state}\t${note}\n`;
  }
  return readResults(text);
}

function fail(message: string): number {
  warn(message);
  return EXIT.usage;
}

function chooseFeatures(onboard: Onboard, names: string[], verb: "select" | "skip"): number {
  const { features } = onboard.catalog();
  const bad = names.filter((x) => !features.has(x));
  if (bad.length > 0 || names.length === 0) return fail(`feature desconhecida: ${bad.join(" ") || "(nenhuma)"}; válidas: ${[...features.keys()].join(" ")}`);
  const state = onboard.load();
  const [gone, to] = verb === "select" ? (["skipped", "selected"] as const) : (["selected", "skipped"] as const);
  state[to] = [...features.keys()].filter((x) => state[to].includes(x) || names.includes(x));
  state[gone] = state[gone].filter((x) => !names.includes(x));
  onboard.save(state);
  return EXIT.ok;
}

function markStep(onboard: Onboard, verb: "done" | "undone", id: string): number {
  if (!onboard.catalog().steps.some((s) => s.id === id)) return fail("passo desconhecido");
  const state = onboard.load();
  state.done = [...state.done.filter((x) => x !== id), ...(verb === "done" ? [id] : [])];
  onboard.save(state);
  return EXIT.ok;
}

function status(onboard: Onboard, features: BuiltFeature[], mode: string): number {
  const selected = features.filter((x) => x.choice === "selecionada");
  const pendingCount = selected.reduce((sum, x) => sum + x.pending, 0);
  const state = onboard.load();
  const progress = onboardProgress(features, state.tour);
  if (mode === "--json") {
    out(pyDumps({ version: 1, time: Math.trunc(Date.now() / 1000), asked: onboard.asked(), features, pending: pendingCount, complete: progress.complete, tour: state.tour ?? null, progress }));
  } else if (mode === "--doctor") {
    out(`${pendingCount}\t${selected.filter((x) => x.pending > 0).map((x) => x.label).join(", ")}\t${selected.length}`);
    out(onboardLine(progress));
  } else if (mode === "--line") {
    const line = onboardLine(progress);
    if (line !== "") out(line);
  } else if (mode === "--brief") {
    out(features.map((x) => (x.pending > 0 ? `  ${x.label}: ${x.pending} pendente(s)` : `  ${x.label}: em dia`)).join("\n"));
  } else {
    out(renderText(features, process.stdout.isTTY === true));
  }
  return EXIT.ok;
}

function tourChoice(onboard: Onboard, verb: string): number {
  if (verb !== "seen" && verb !== "skip") return fail("uso: onboard.sh tour seen|skip");
  const state = onboard.load();
  state.tour = verb === "seen" ? "seen" : "skipped";
  onboard.save(state);
  return EXIT.ok;
}

/**
 * O ambiente do comando do passo, sem as chaves das Configurações: o passo grava no config.env e aplica na mesma linha, e
 * o valor que o env.sh deste processo já exportou encobriria o recém-gravado (no config.sh, a variável do shell vence).
 */
function stepEnv(dir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const { key } of readCatalog(dir)) delete env[key];
  return env;
}

function runStep(onboard: Onboard, id: string): number {
  const step = onboard.catalog().steps.find((x) => x.id === id);
  if (!step) return fail("passo desconhecido");
  if (step.who !== "hades") {
    out(`o passo ${id} é do dono: o onboarding só mostra o comando (onboard.sh show)`);
    return EXIT.usage;
  }
  const command = onboard.expand(step.command);
  if (command === "") {
    out(`o passo ${id} não tem comando`);
    return EXIT.usage;
  }
  out(`→ ${command}`);
  const code = spawnSync("bash", ["-c", command], { stdio: "inherit", env: stepEnv(onboard.dir) }).status ?? EXIT.fail;
  if (code !== 0) {
    out(`passo ${id} falhou (saída ${code})`);
    return code;
  }
  if (step.check === "manual") markStep(onboard, "done", id);
  out(`passo ${id}: ok`);
  return EXIT.ok;
}

function pick(onboard: Onboard): number {
  if (!process.stdin.isTTY) {
    out("pick precisa de terminal; use select <feature…> ou skip <feature…>");
    return EXIT.usage;
  }
  const ids = [...onboard.catalog().features.keys()];
  out("Quais features preparar agora? (números separados por espaço, Enter = nenhuma)");
  ids.forEach((id, i) => out(`  ${i + 1}) ${id}`));
  process.stderr.write("> ");
  const answer: string = prompt("") ?? "";
  const chosen = answer.split(/\s+/).filter((n) => /^[0-9]+$/.test(n) && Number(n) >= 1 && Number(n) <= ids.length).map((n) => ids[Number(n) - 1] as string);
  const skipped = ids.filter((id) => !chosen.includes(id));
  if (chosen.length > 0) chooseFeatures(onboard, chosen, "select");
  if (skipped.length > 0) chooseFeatures(onboard, skipped, "skip");
  out("Passos de cada feature escolhida: onboard.sh show <feature>");
  return EXIT.ok;
}

export function onboardCommand(args: string[]): number {
  const dir = stateDir();
  const command = args[0] ?? "status";
  const rest = args.slice(1).filter((a) => a !== "--quick");
  const quick = args.slice(1).includes("--quick");
  const catalogFile = process.env.ONBOARD_CATALOG || join(dir, "onboard.tsv");
  switch (command) {
    case "status":
    case "show": {
      const onboard = new Onboard(dir, catalogFile, firewallCommand());
      const features = onboard.build(onboard.catalog(), evaluate(onboard, quick));
      if (command === "status") return status(onboard, features, rest[0] ?? "");
      const id = rest[0] ?? "";
      if (!onboard.catalog().features.has(id)) return fail(`feature desconhecida; válidas: ${[...onboard.catalog().features.keys()].join(" ")}`);
      out(renderText(features, process.stdout.isTTY === true, id));
      return EXIT.ok;
    }
    case "select":
    case "skip":
      return chooseFeatures(new Onboard(dir, catalogFile), rest, command);
    case "done":
    case "undone":
      return markStep(new Onboard(dir, catalogFile), command, rest[0] ?? "");
    case "tour":
      return tourChoice(new Onboard(dir, catalogFile), rest[0] ?? "");
    case "reset":
      new Onboard(dir, catalogFile).save({ selected: [], skipped: [], done: [] });
      return EXIT.ok;
    case "features":
      out([...new Onboard(dir, catalogFile).catalog().features.keys()].join("\n"));
      return EXIT.ok;
    case "checks": // passo<TAB>check, para quem mede por fora (núcleo + plugin, já sem repetidos)
      out(new Onboard(dir, catalogFile).catalog().steps.map((s) => `${s.id}\t${s.check}`).join("\n"));
      return EXIT.ok;
    case "run":
      return runStep(new Onboard(dir, catalogFile), rest[0] ?? "");
    case "pick":
      return pick(new Onboard(dir, catalogFile));
    case "-h":
    case "--help":
      out(HELP);
      return EXIT.ok;
    default:
      warn(USAGE);
      return EXIT.usage;
  }
}
