// launchd do usuário (`launchctl`). Domínio gui/<uid>, ou user/<uid> quando não há sessão gráfica. O plist mora em
// ~/Library/LaunchAgents quando o serviço inicia sozinho no login (enable) e em ~/.claude/hades/launchd quando não.
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { readText } from "./fs.ts";
import { activeStateOf, launchdLabel, parseLaunchctlList, parseLaunchctlPrint, plistEnvironment, plistString, plistText, unitOfLabel, type LaunchdPrint, type PlistSpec } from "./launchd-plist.ts";
import { hadesHome, home } from "./paths.ts";
import { ctl, ctlAsync, ListFailedError, retryBootstrap, type CtlResult } from "./service-manager-ctl.ts";
import { EXIT, die } from "./output.ts";
import { which } from "./proc.ts";
import type { KeepAliveSpec, ServiceManager, ServiceSpec, TimerSpec, TransientSpec, UnitInfo } from "./service-manager.ts";

const LAUNCHCTL = "launchctl";
const PLIST_SUFFIX = ".plist";
/** `launchctl bootout` de serviço que não está carregado: 3 (ESRCH) ou 113 ("Could not find specified service"), que para o systemd é só um `stop` sem efeito. */
const BOOTOUT_NOT_LOADED: readonly number[] = [3, 113];
/** O launchd recusa plist que o grupo ou os outros possam escrever; o umask do chamador não decide. */
const PLIST_MODE = 0o644;
/** Plist de job mais novo que isto ainda pode estar entre a gravação e o `bootstrap`: não é recolhido. */
const COLLECT_GRACE_MS = 10_000;

/** 0 quando o serviço já não estava carregado: a parada é idempotente como no systemd. */
const bootoutResult = (status: number): number => (BOOTOUT_NOT_LOADED.includes(status) ? 0 : status);

function writePlist(file: string, text: string): void {
  writeFileSync(file, text);
  chmodSync(file, PLIST_MODE);
}

const launchAgentsDir = (): string => join(home(), "Library", "LaunchAgents");
const privateDir = (): string => join(hadesHome(), "launchd");

function toPlist(spec: ServiceSpec): PlistSpec {
  return {
    label: launchdLabel(spec.unit), argv: spec.argv, workdir: spec.workdir, env: spec.env, stdout: spec.logFile, stderr: spec.logFile,
    keepAliveOnFailure: spec.restart === "on-failure", throttleSec: spec.restart === "on-failure" ? spec.restartSec : undefined, runAtLoad: true,
  };
}

export class LaunchdManager implements ServiceManager {
  readonly kind = "launchd" as const;
  readonly requires = LAUNCHCTL;
  private cachedDomain: string | undefined;
  /** Units cujo plist mudou em `write` e ainda não foram relidas pelo launchd (`start` as recarrega). */
  private readonly rewritten = new Set<string>();

  /** gui/<uid> com sessão gráfica; sem ela (ssh, boot sem login) o domínio user/<uid>. */
  private domain(): string {
    if (this.cachedDomain === undefined) {
      const uid = process.getuid?.() ?? 0;
      this.cachedDomain = ctl(LAUNCHCTL, ["print", `gui/${uid}`]).status === 0 ? `gui/${uid}` : `user/${uid}`;
    }
    return this.cachedDomain;
  }

  /** `<domínio>/<rótulo>`: o alvo dos verbos do launchctl (quem lê o estado por conta própria, como o amostrador do painel). */
  target(unit: string): string {
    return `${this.domain()}/${launchdLabel(unit)}`;
  }

  private agentFile(unit: string): string {
    return join(launchAgentsDir(), `${launchdLabel(unit)}${PLIST_SUFFIX}`);
  }

  private privateFile(unit: string): string {
    return join(privateDir(), `${launchdLabel(unit)}${PLIST_SUFFIX}`);
  }

  definitionPath(unit: string): string {
    return existsSync(this.agentFile(unit)) ? this.agentFile(unit) : this.privateFile(unit);
  }

  private print(unit: string): LaunchdPrint | undefined {
    const r = ctl(LAUNCHCTL, ["print", this.target(unit)]);
    return r.status === 0 ? parseLaunchctlPrint(r.stdout) : undefined;
  }

  write(spec: ServiceSpec): boolean {
    const file = this.definitionPath(spec.unit);
    const want = plistText(toPlist(spec));
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(dirname(spec.logFile), { recursive: true });
    if (readText(file) === want) return false;
    writePlist(file, want);
    this.rewritten.add(spec.unit);
    return true;
  }

  private bootstrap(unit: string): number {
    return retryBootstrap(() => ctl(LAUNCHCTL, ["bootstrap", this.domain(), this.definitionPath(unit)], "inherit").status);
  }

  /** Serviço carregado e parado com plist novo: bootout antes de subir, o equivalente do `daemon-reload` do systemd. */
  start(unit: string): number {
    const reload = this.rewritten.delete(unit);
    const state = this.print(unit);
    if (state === undefined) return this.bootstrap(unit);
    if (activeStateOf(state) === "active") return 0;
    if (reload) {
      const stopped = this.stop(unit);
      return stopped === 0 ? this.bootstrap(unit) : stopped;
    }
    return ctl(LAUNCHCTL, ["kickstart", this.target(unit)], "inherit").status;
  }

  stop(unit: string): number {
    return bootoutResult(ctl(LAUNCHCTL, ["bootout", this.target(unit)], "inherit").status);
  }

  /** bootout + bootstrap: relê o plist (o launchd não tem daemon-reload). */
  restart(unit: string): number {
    const stopped = this.stop(unit);
    return stopped === 0 ? this.start(unit) : stopped;
  }

  enable(unit: string): number {
    const from = this.privateFile(unit);
    const to = this.agentFile(unit);
    if (existsSync(to)) return 0;
    if (!existsSync(from)) return 1;
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return 0;
  }

  disable(unit: string, now = false): number {
    const from = this.agentFile(unit);
    const to = this.privateFile(unit);
    if (existsSync(from)) {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
    return now ? this.stop(unit) : 0;
  }

  /** O launchd não trava o serviço em `failed`; o equivalente é descarregar o que caiu e ficou parado. */
  resetFailed(unit: string): void {
    if (activeStateOf(this.print(unit)) === "failed") this.stop(unit);
  }

  isActive(unit: string): boolean {
    return this.activeState(unit) === "active";
  }

  activeState(unit: string): string {
    return activeStateOf(this.print(unit));
  }

  isEnabled(unit: string): boolean {
    return existsSync(this.agentFile(unit));
  }

  enabledState(unit: string): string {
    return this.isEnabled(unit) ? "enabled" : "disabled";
  }

  /** Reinícios = execuções além da primeira (`runs` do launchctl print). */
  inspect(units: string[]): UnitInfo[] {
    return units.map((unit) => {
      const state = this.print(unit);
      return { unit, activeState: activeStateOf(state), restarts: Math.max(0, (state?.runs ?? 0) - 1) };
    });
  }

  listActive(prefix: string): string[] {
    return this.rowsActive(ctl(LAUNCHCTL, ["list"]), prefix);
  }

  /** O log é o arquivo que o plist declara em StandardOutPath; sem plist ou sem arquivo, vazio. */
  readLog(unit: string, lines: number): string {
    const log = plistString(readText(this.definitionPath(unit)) ?? "", "StandardOutPath") ?? "";
    const text = log === "" ? undefined : readText(log);
    if (text === undefined) return "";
    const all = text.split("\n");
    if (all[all.length - 1] === "") all.pop();
    return all.slice(-lines).join("\n");
  }

  /** Grava o plist do job em ~/.claude/hades/launchd e devolve o bootstrap. */
  transientArgv(spec: TransientSpec): string[] {
    const file = this.privateFile(spec.unit);
    mkdirSync(dirname(file), { recursive: true });
    writePlist(file, plistText({
      label: launchdLabel(spec.unit), argv: spec.argv, workdir: spec.workdir, env: spec.env, stdin: spec.stdin, stdout: spec.stdout, stderr: spec.stdout,
      keepAliveOnFailure: false, runAtLoad: true,
    }));
    return [LAUNCHCTL, "bootstrap", this.domain(), file];
  }

  /** `launchctl list` que falhou (erro, timeout) lança ListFailedError: stdout vazio não é "nada em execução". */
  private rowsActive(listing: CtlResult, prefix: string): string[] {
    if (listing.status !== 0) throw new ListFailedError(LAUNCHCTL, listing.status);
    const labelPrefix = launchdLabel(prefix);
    return parseLaunchctlList(listing.stdout).filter((r) => r.pid !== undefined && r.label.startsWith(labelPrefix)).map((r) => unitOfLabel(r.label)).filter((u): u is string => u !== undefined);
  }

  async listActiveAsync(prefix: string): Promise<string[]> {
    return this.rowsActive(await ctlAsync(LAUNCHCTL, ["list"]), prefix);
  }

  async stopTransientAsync(unit: string): Promise<number> {
    const status = (await ctlAsync(LAUNCHCTL, ["bootout", this.target(unit)])).status;
    rmSync(this.privateFile(unit), { force: true });
    return bootoutResult(status);
  }

  /** Os plists de job em ~/.claude/hades/launchd com o prefixo cujo processo não está em `active`: bootout e remoção. */
  collectFinished(prefix: string, active: ReadonlySet<string>): string[] {
    const labelPrefix = launchdLabel(prefix);
    let names: string[];
    try {
      names = readdirSync(privateDir());
    } catch {
      return [];
    }
    const collected: string[] = [];
    for (const name of names) {
      if (!name.startsWith(labelPrefix) || !name.endsWith(PLIST_SUFFIX)) continue;
      const unit = unitOfLabel(name.slice(0, -PLIST_SUFFIX.length));
      if (unit === undefined || active.has(unit)) continue;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(join(privateDir(), name)).mtimeMs;
      } catch {
        // outro coletor apagou o plist entre o readdir e o stat: já recolhido
        continue;
      }
      if (Date.now() - mtimeMs < COLLECT_GRACE_MS) continue;
      this.stopTransient(unit);
      collected.push(unit);
    }
    return collected;
  }

  unitEnvironment(unit: string): string {
    return plistEnvironment(readText(this.definitionPath(unit)) ?? "");
  }

  /** bootout para o job e o plist dele sai: o launchd não recolhe sozinho como o `--collect` do systemd. */
  stopTransient(unit: string): number {
    const status = this.stop(unit);
    rmSync(this.privateFile(unit), { force: true });
    return status;
  }

  /** Um plist só, com StartInterval: o launchd dispara a cada `everySec` depois de carregado (sem RunAtLoad, a primeira vez também espera). */
  writeTimer(spec: TimerSpec): boolean {
    if (spec.everySec === undefined) return die(`intervalo da limpeza ilegível: ${spec.every} (use 6h, 1d, 30min)`, EXIT.usage);
    const file = this.definitionPath(spec.unit);
    const want = plistText({
      label: launchdLabel(spec.unit), argv: spec.argv, env: spec.env, stdout: spec.logFile, stderr: spec.logFile,
      keepAliveOnFailure: false, runAtLoad: false, startIntervalSec: spec.everySec, lowPriority: spec.background,
    });
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(dirname(spec.logFile), { recursive: true });
    if (readText(file) === want) return false;
    writePlist(file, want);
    return true;
  }

  /** Início automático é o plist em ~/Library/LaunchAgents; armar é carregá-lo. `start` não serve: num timer carregado ele daria kickstart e rodaria a limpeza na hora. */
  armTimer(unit: string, rearm: boolean): number {
    const enabled = this.enable(unit);
    if (enabled !== 0) return enabled;
    if (rearm) return this.restart(unit);
    return this.print(unit) === undefined ? this.bootstrap(unit) : 0;
  }

  disarmTimer(unit: string): number {
    return this.disable(unit, true);
  }

  timerEnabled(unit: string): boolean {
    return this.isEnabled(unit);
  }

  timerEnabledState(unit: string): string {
    return this.enabledState(unit);
  }

  /** O launchd não guarda a última execução: a marca é do job (logs/logrotate.last, gravada por `clean.sh run`). */
  timerLastTrigger(): string {
    return "";
  }

  /** Plist com KeepAlive em ~/.claude/hades/launchd (sem início automático: como o systemd-run, some no logout) e bootstrap. */
  runKeepAlive(spec: KeepAliveSpec): number {
    const [program = "", ...rest] = spec.argv;
    this.write({
      unit: spec.unit, description: spec.unit, workdir: home(), env: spec.env, argv: [isAbsolute(program) ? program : (which(program) ?? program), ...rest],
      logFile: spec.logFile, restart: "on-failure", restartSec: spec.restartSec,
    });
    return this.start(spec.unit);
  }
}
