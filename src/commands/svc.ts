// `hades svc run|stop|status|list|is-active|is-enabled`: serviços de apoio do pacote do projeto (env/svc.sh) pelo gerenciador
// de serviço da máquina. É o caminho do macOS, onde o `systemd-run --slice` do svc.sh não existe; no Linux o svc.sh do pacote
// segue com o systemd-run. O nome do serviço é curto (`api`); a unit é `<HU>-<nome>`, como o painel espera (panel.units[]).
// Contrato: reference/projects.md §Serviços de apoio (hades svc).
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { unitPrefix } from "../lib/config.ts";
import { findStateDir } from "../lib/kit.ts";
import { EXIT, HadesError, out, warn } from "../lib/output.ts";
import { hadesHome, home } from "../lib/paths.ts";
import { which } from "../lib/proc.ts";
import { serviceManager, type EnvPairs, type ServiceManager } from "../lib/service-manager.ts";
import { retryBootstrap } from "../lib/service-manager-ctl.ts";

export const USAGE = `uso: hades svc run <nome> [--workdir <dir>] [--env K=V]... [--log <arquivo>] [--slice <slice>] -- <cmd...>
     hades svc stop <nome> | status <nome> | list
     hades svc is-active|is-enabled <unit-completa>
  run     sobe <HU>-<nome> como processo do usuário (sai 0 = subiu); rodar de novo troca o que estava no ar
  stop    derruba e recolhe (sai 0 também se não estava no ar)
  status  imprime active|activating|failed|inactive; sai 0 só se active, 3 senão (como o systemctl is-active)
  list    nomes dos serviços do pacote em execução, um por linha
  is-active|is-enabled  o estado de uma unit pelo nome completo (hds-panel); sai 0 = sim, 1 = não`;

/** Units que o próprio Hades sobe com o prefixo da instância; não são serviços do pacote e não saem no `list`. */
const OWN_SUFFIXES = new Set(["panel", "notify", "logrotate", "devtunnel", "panel-tunnel"]);
const OWN_PREFIXES = ["pjob-", "chat-"];
const NAME = /^[a-z0-9][a-z0-9_.-]{0,40}$/;
const SERVICE_RESTART_SEC = 5;
const STATUS_NOT_ACTIVE = 3;

function unitPrefixHere(): string {
  return unitPrefix(findStateDir() ?? hadesHome());
}

function unitOf(name: string): string {
  if (!NAME.test(name)) throw new HadesError(`nome de serviço inválido '${name}' (use [a-z0-9_.-], até 41)`, EXIT.usage);
  return `${unitPrefixHere()}-${name}`;
}

interface RunArgs {
  name: string;
  workdir: string;
  env: [string, string][];
  log: string | undefined;
  command: string[];
}

function parseRun(args: string[]): RunArgs {
  const [name = "", ...rest] = args;
  const sep = rest.indexOf("--");
  if (sep < 0 || sep === rest.length - 1) throw new HadesError(`svc run exige '-- <cmd...>'\n${USAGE}`, EXIT.usage);
  const opts = rest.slice(0, sep);
  const parsed: RunArgs = { name, workdir: process.cwd(), env: [], log: undefined, command: rest.slice(sep + 1) };
  for (let i = 0; i < opts.length; i += 2) {
    const flag = opts[i];
    const value = opts[i + 1];
    if (value === undefined) throw new HadesError(`${flag} exige valor`, EXIT.usage);
    if (flag === "--workdir") parsed.workdir = value;
    else if (flag === "--log") parsed.log = value;
    else if (flag === "--slice") warn(`hades svc: --slice ${value} ignorado (sem slice nesta máquina; o teto de serviço é só recomendação, ADR 0003)`);
    else if (flag === "--env") {
      const eq = value.indexOf("=");
      if (eq <= 0) throw new HadesError(`--env exige K=V: '${value}'`, EXIT.usage);
      parsed.env.push([value.slice(0, eq), value.slice(eq + 1)]);
    } else throw new HadesError(`opção desconhecida: ${flag}\n${USAGE}`, EXIT.usage);
  }
  return parsed;
}

/** O launchd não resolve o executável pelo PATH: o primeiro argumento vira caminho absoluto (o relativo, contra o `--workdir`). */
function absoluteArgv(command: string[], env: EnvPairs, workdir: string): string[] {
  const [first = "", ...rest] = command;
  if (isAbsolute(first)) return command;
  const pathVar = env.find(([k]) => k === "PATH")?.[1] ?? process.env.PATH ?? "";
  const found = first.includes("/") ? resolve(workdir, first) : which(first, pathVar);
  if (found === undefined) throw new HadesError(`comando não encontrado: ${first}`, 127);
  return [found, ...rest];
}

function run(manager: ServiceManager, args: string[]): number {
  const a = parseRun(args);
  const unit = unitOf(a.name);
  const given = (key: string): boolean => a.env.some(([k]) => k === key);
  // a unit transitória herda o HOME do gerenciador de serviço, não o de quem rodou o `hades svc`
  const env: EnvPairs = [
    ...(given("PATH") ? [] : [["PATH", process.env.PATH ?? ""] as const]),
    ...(given("HOME") ? [] : [["HOME", home()] as const]),
    ...a.env,
  ];
  const workdir = resolve(a.workdir);
  const argv = absoluteArgv(a.command, env, workdir);
  const log = a.log ?? join(findStateDir() ?? hadesHome(), "logs", `${unit}.log`);
  mkdirSync(dirname(log), { recursive: true });
  manager.stopTransient(unit);
  const launch = manager.transientArgv({ unit, workdir, env, argv, stdout: log });
  const [file = "", ...rest] = launch;
  return manager.kind === "launchd" ? retryBootstrap(() => spawnLaunch(file, rest)) : spawnLaunch(file, rest);
}

function spawnLaunch(file: string, args: string[]): number {
  const r = Bun.spawnSync([file, ...args], { stdout: "inherit", stderr: "inherit" });
  return r.exitCode ?? EXIT.fail;
}

function list(manager: ServiceManager): number {
  const prefix = `${unitPrefixHere()}-`;
  const names = manager.listActive(prefix).map((u) => u.slice(prefix.length));
  for (const name of names.filter((n) => !OWN_SUFFIXES.has(n) && !OWN_PREFIXES.some((p) => n.startsWith(p))).sort()) out(name);
  return EXIT.ok;
}

export function svcCommand(args: string[]): number {
  const [verb = "", name = ""] = args;
  if (verb === "-h" || verb === "--help") {
    out(USAGE);
    return EXIT.ok;
  }
  const manager = serviceManager();
  switch (verb) {
    case "run":
      return run(manager, args.slice(1));
    case "stop":
      return manager.stopTransient(unitOf(name));
    case "status": {
      const state = manager.activeState(unitOf(name));
      out(state);
      return state === "active" ? EXIT.ok : STATUS_NOT_ACTIVE;
    }
    case "list":
      return list(manager);
    case "is-active":
      return manager.isActive(name) ? EXIT.ok : EXIT.fail;
    case "is-enabled":
      return manager.isEnabled(name) ? EXIT.ok : EXIT.fail;
    default:
      warn(USAGE);
      return EXIT.usage;
  }
}
