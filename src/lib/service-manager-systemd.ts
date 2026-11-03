// systemd do usuário (`systemctl --user`, `systemd-run --user`). O texto da unit e o argv saem byte a byte como saíam do
// kit/panel.sh, do notify.ts e do painel (loop/test/golden/systemd-contrato.txt).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readText } from "./fs.ts";
import { home } from "./paths.ts";
import { ctl, ctlAsync } from "./service-manager-ctl.ts";
import type { KeepAliveSpec, ServiceManager, ServiceSpec, TimerSpec, TransientSpec, UnitInfo } from "./service-manager.ts";

const SYSTEMCTL = "systemctl";
const JOURNALCTL = "journalctl";
const UNIT_SUFFIX = ".service";

/** % é especificador no arquivo de unit. */
const esc = (text: string): string => text.replaceAll("%", "%%");

/** No ExecStart o primeiro argumento e os caminhos absolutos entram entre aspas; o resto, cru (`panel serve --port 21220`). */
const execWord = (word: string, index: number): string => (index === 0 || word.startsWith("/") ? `"${esc(word)}"` : esc(word));

/** O texto da unit, sem a quebra de linha final. */
export function unitText(spec: ServiceSpec): string {
  const env = spec.env.map(([k, v]) => `"${k}=${esc(v)}"`).join(" ");
  return `[Unit]
Description=${spec.description}

[Service]
WorkingDirectory=${esc(spec.workdir)}
Environment=${env}
ExecStart=${spec.argv.map(execWord).join(" ")}
StandardOutput=append:${esc(spec.logFile)}
StandardError=append:${esc(spec.logFile)}
Restart=${spec.restart}
RestartSec=${spec.restartSec}

[Install]
WantedBy=default.target`;
}

/** A unit do serviço do timer (oneshot); no ExecStart só o primeiro item sai sem aspas, os caminhos absolutos seguintes entre elas. */
export function timerServiceText(spec: TimerSpec): string {
  const env = spec.env.map(([k, v]) => `"${k}=${esc(v)}"`).join(" ");
  const exec = spec.argv.map((word, i) => (i === 0 ? esc(word) : execWord(word, i))).join(" ");
  return `[Unit]
Description=${spec.description}

[Service]
Type=oneshot${spec.background ? "\nNice=10\nIOSchedulingClass=idle" : ""}
Environment=${env}
ExecStart=${exec}
StandardOutput=append:${esc(spec.logFile)}
StandardError=append:${esc(spec.logFile)}`;
}

const BOOT_DELAY = "10min";

export function timerText(spec: TimerSpec): string {
  return `[Unit]
Description=${spec.timerDescription}

[Timer]
OnBootSec=${BOOT_DELAY}
OnUnitActiveSec=${spec.every}
Persistent=true

[Install]
WantedBy=timers.target`;
}

/** Saída de `systemctl show -p Id,ActiveState,NRestarts`: um bloco `chave=valor` por unit, separados por linha em branco. */
export function parseShow(text: string): UnitInfo[] {
  const infos: UnitInfo[] = [];
  for (const block of text.split("\n\n")) {
    const kv = new Map<string, string>();
    for (const line of block.split("\n")) {
      const eq = line.indexOf("=");
      if (eq >= 0) kv.set(line.slice(0, eq), line.slice(eq + 1));
    }
    const id = kv.get("Id");
    if (id === undefined) continue;
    infos.push({ unit: id.endsWith(UNIT_SUFFIX) ? id.slice(0, -UNIT_SUFFIX.length) : id, activeState: kv.get("ActiveState") ?? "", restarts: Number.parseInt(kv.get("NRestarts") ?? "0", 10) || 0 });
  }
  return infos;
}

const stateFilter = (transitional: boolean): string => (transitional ? "--state=active,activating,deactivating" : "--state=active");

/** Nomes das units (sem .service) de um `list-units --plain --no-legend`. */
const listedUnits = (listing: string): string[] =>
  listing.split("\n").map((l) => l.trim().split(/\s+/)[0] ?? "").filter((u) => u.endsWith(UNIT_SUFFIX)).map((u) => u.slice(0, -UNIT_SUFFIX.length));

export class SystemdManager implements ServiceManager {
  readonly kind = "systemd" as const;
  readonly requires = SYSTEMCTL;

  definitionPath(unit: string): string {
    return join(home(), ".config", "systemd", "user", `${unit}${UNIT_SUFFIX}`);
  }

  write(spec: ServiceSpec): boolean {
    const file = this.definitionPath(spec.unit);
    const want = unitText(spec);
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(dirname(spec.logFile), { recursive: true });
    const current = readText(file);
    if (current !== undefined && current.replace(/\n+$/, "") === want) return false;
    writeFileSync(file, `${want}\n`);
    ctl(SYSTEMCTL, ["--user", "daemon-reload"], "inherit");
    return true;
  }

  start(unit: string): number {
    return ctl(SYSTEMCTL, ["--user", "start", unit], "inherit").status;
  }

  stop(unit: string): number {
    return ctl(SYSTEMCTL, ["--user", "stop", unit], "inherit").status;
  }

  restart(unit: string): number {
    return ctl(SYSTEMCTL, ["--user", "restart", unit], "inherit").status;
  }

  enable(unit: string): number {
    return ctl(SYSTEMCTL, ["--user", "enable", "--quiet", unit], "inherit").status;
  }

  disable(unit: string, now = false): number {
    return ctl(SYSTEMCTL, ["--user", "disable", "--quiet", ...(now ? ["--now"] : []), unit], "inherit").status;
  }

  resetFailed(unit: string): void {
    ctl(SYSTEMCTL, ["--user", "reset-failed", unit], "quiet");
  }

  isActive(unit: string): boolean {
    return ctl(SYSTEMCTL, ["--user", "is-active", "--quiet", unit]).status === 0;
  }

  activeState(unit: string): string {
    return ctl(SYSTEMCTL, ["--user", "is-active", unit]).stdout.trim();
  }

  isEnabled(unit: string): boolean {
    return ctl(SYSTEMCTL, ["--user", "is-enabled", "--quiet", unit]).status === 0;
  }

  enabledState(unit: string): string {
    return ctl(SYSTEMCTL, ["--user", "is-enabled", unit]).stdout.trim();
  }

  inspect(units: string[]): UnitInfo[] {
    if (units.length === 0) return [];
    const shown = ctl(SYSTEMCTL, ["--user", "show", "-p", "Id,ActiveState,NRestarts", ...units]).stdout;
    return parseShow(shown);
  }

  listActive(prefix: string): string[] {
    return listedUnits(ctl(SYSTEMCTL, ["--user", "list-units", `${prefix}*`, "--plain", "--no-legend", stateFilter(false)]).stdout);
  }

  readLog(unit: string, lines: number): string {
    return ctl(JOURNALCTL, ["--user", "-u", unit, "-n", String(lines), "--no-pager", "-o", "short-iso"]).stdout;
  }

  transientArgv(spec: TransientSpec): string[] {
    return [
      "systemd-run", "--user", "--quiet", "--collect", `--unit=${spec.unit}`, `--working-directory=${spec.workdir}`,
      ...(spec.stdin === undefined ? [] : ["-p", `StandardInput=file:${spec.stdin}`]),
      "-p", `StandardOutput=append:${spec.stdout}`, "-p", `StandardError=append:${spec.stdout}`,
      ...spec.env.flatMap(([k, v]) => ["-E", `${k}=${v}`]),
      ...spec.argv,
    ];
  }

  stopTransient(unit: string): number {
    return this.stop(unit);
  }

  async listActiveAsync(prefix: string, transitional = false): Promise<string[]> {
    return listedUnits((await ctlAsync(SYSTEMCTL, ["--user", "list-units", `${prefix}*`, "--plain", "--no-legend", stateFilter(transitional)])).stdout);
  }

  async stopTransientAsync(unit: string): Promise<number> {
    return (await ctlAsync(SYSTEMCTL, ["--user", "stop", unit])).status;
  }

  /** O `--collect` do systemd-run já recolhe sozinho. */
  collectFinished(): string[] {
    return [];
  }

  unitEnvironment(unit: string): string {
    return ctl(SYSTEMCTL, ["--user", "show", unit, "-p", "Environment", "--value"]).stdout;
  }

  writeTimer(spec: TimerSpec): boolean {
    const dir = dirname(this.definitionPath(spec.unit));
    mkdirSync(dir, { recursive: true });
    mkdirSync(dirname(spec.logFile), { recursive: true });
    let changed = false;
    for (const [file, want] of [[join(dir, `${spec.unit}${UNIT_SUFFIX}`), timerServiceText(spec)], [join(dir, `${spec.unit}.timer`), timerText(spec)]] as const) {
      if ((readText(file) ?? "").replace(/\n+$/, "") === want && existsSync(file)) continue;
      writeFileSync(file, `${want}\n`);
      changed = true;
    }
    if (changed) ctl(SYSTEMCTL, ["--user", "daemon-reload"], "inherit");
    return changed;
  }

  armTimer(unit: string, rearm: boolean): number {
    ctl(SYSTEMCTL, ["--user", "enable", "--quiet", `${unit}.timer`], "inherit");
    // o OnUnitActiveSec antigo ficaria armado até a próxima execução: com a unit nova, restart
    if (rearm && ctl(SYSTEMCTL, ["--user", "restart", `${unit}.timer`], "inherit").status === 0) return 0;
    return ctl(SYSTEMCTL, ["--user", "start", `${unit}.timer`], "inherit").status;
  }

  disarmTimer(unit: string): number {
    return ctl(SYSTEMCTL, ["--user", "disable", "--quiet", "--now", `${unit}.timer`], "inherit").status;
  }

  timerEnabled(unit: string): boolean {
    return ctl(SYSTEMCTL, ["--user", "is-enabled", "--quiet", `${unit}.timer`]).status === 0;
  }

  timerEnabledState(unit: string): string {
    return ctl(SYSTEMCTL, ["--user", "is-enabled", `${unit}.timer`]).stdout.trim();
  }

  timerLastTrigger(unit: string): string {
    return ctl(SYSTEMCTL, ["--user", "show", "-p", "LastTriggerUSec", "--value", `${unit}.timer`]).stdout.replace(/\n+$/, "");
  }

  runKeepAlive(spec: KeepAliveSpec): number {
    const slice = spec.slice === undefined ? [] : [`--slice=${spec.slice}`];
    return ctl("systemd-run", ["--user", `--unit=${spec.unit}`, ...slice, "-p", "Restart=on-failure", "-p", `RestartSec=${spec.restartSec}`, ...spec.argv]).status;
  }
}
