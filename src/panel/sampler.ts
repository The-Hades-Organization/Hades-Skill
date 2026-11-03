// Amostrador do painel: a cada 3 s lê systemd, docker, git, fila do gate e processos da skill e guarda o retrato que o
// GET /api/snapshot devolve (mais uma hora de histórico).
import { existsSync, readdirSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, isAbsolute, join, parse } from "node:path";
import { readText } from "../lib/fs.ts";
import { launchdSliceUsage, launchdUnitProps } from "../lib/service-manager-launchd-stats.ts";
import { LaunchdManager } from "../lib/service-manager-launchd.ts";
import { managerKind } from "../lib/service-manager.ts";
import { type Settings, localVersion, refresh, settings as versionSettings, status as versionStatus, updateCommand } from "../lib/version-check.ts";
import type { PanelEnv } from "./env.ts";
import { exec, out } from "./exec.ts";
import type { Herdr } from "./herdr.ts";
import type { Jobs } from "./jobs.ts";
import { log } from "./log.ts";
import type { Plugin } from "./plugin.ts";
import {
  CGROUP_ROOT, type LogCacheEntry, cgHigh, cgMax, cgMem, composeServices, fields, httpStatus, isoEpoch, listFile, logErrors, meminfo,
  loadAverage, procCommands, readLines, serviceCatalog, uptime,
} from "./system.ts";

const SAMPLE_EVERY_MS = 3000;
const HISTORY = 1200;
const BRANCH_TTL_S = 20;
const SKILL_PROC_BASE = ["run-hades", "update", "rebuild-branch", "hades", "build-web", "build-services", "migrate", "svc-enable"];
const SKILL_PROC_CMD_MAX = 200;
const SKILL_SHELLS = ["bash", "/bin/bash", "/usr/bin/bash"];
const REF_NAME = /^[\w./-]+$/;
const DEFAULT_BASE = "origin/develop";
const BEHIND_UNKNOWN_RC = [0, 1];
const PROJECT_TIMEOUT_MS = 8000;

type Dict = Record<string, unknown>;
const num = (text: string | undefined): number | null => (text !== undefined && /^\d+$/.test(text) ? Number.parseInt(text, 10) : null);

export interface PluginSampleContext {
  units: Record<string, Record<string, string>>;
  unitView(name: string): Dict;
}

export interface SamplerDeps {
  env: PanelEnv;
  plugin: Plugin;
  jobs: Jobs;
  herdr: Herdr;
  configValues(): Record<string, string>;
  publicUrl(): string | undefined;
  /** o que o plugin mede (units próprias, memória extra); vazio sem plugin */
  pluginSample(ctx: PluginSampleContext): Promise<Dict>;
  /** unit do chat, que não entra na lista de units de serviço */
  chatUnit: string;
}

export interface Sampler {
  snapshot(): Dict;
  /** fila crua de tickets do gate (sem o amostrador de /proc) */
  gateQueue(): Dict[];
  start(): void;
  stop(): void;
  sample(): Promise<void>;
  skillProcs(): SkillProc[];
  /** base da hades/local (branch.base > origin/<flow.base> > origin/develop), só nome de ref */
  baseRef(): Promise<string>;
}

export interface SkillProc {
  pid: number;
  cmd: string;
}

export function createSampler(deps: SamplerDeps): Sampler {
  const { env, plugin, jobs, herdr } = deps;
  const hu = env.hu;
  const history: Dict[] = [];
  const logCache = new Map<string, LogCacheEntry>();
  let snapshot: Dict = {};
  let prevCpu = new Map<string, number>();
  let prevT: number | undefined;
  let git: { t: number; v: Dict } = { t: 0, v: {} };
  let baseCache: string | undefined;
  let versionRefreshing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const procPattern = new RegExp(`(${[...SKILL_PROC_BASE, ...plugin.cycleScripts.map((c) => c.slice(0, -3))].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\.sh\\b`);
  const unitPrefixes = [`${jobs.unit}-`, `${deps.chatUnit}-`];
  const launchd = managerKind() === "launchd" ? new LaunchdManager() : undefined;

  async function baseRef(): Promise<string> {
    if (baseCache === undefined) {
      const skill = process.env.HADES_SKILL_DIR || env.skillDir;
      const get = async (key: string): Promise<string> => (await out([process.execPath, join(skill, "src", "cli.ts"), "project", "get", key, "", "--dir", env.worktree], PROJECT_TIMEOUT_MS)).trim();
      const flowBase = await get("flow.base");
      const base = (await get("branch.base")) || (flowBase ? `origin/${flowBase}` : DEFAULT_BASE);
      // vai para scripts de ação: só nome de ref
      baseCache = REF_NAME.test(base) ? base : DEFAULT_BASE;
    }
    return baseCache;
  }

  const gitOut = (args: string[]): Promise<string> => out(["git", "-C", env.worktree, ...args]);

  async function enabledServices(): Promise<Set<string>> {
    if (!existsSync(join(env.dir, "services.enabled"))) await out(["bash", join(env.dir, "svc.sh"), "list"]);
    return new Set([...listFile(join(env.dir, "services.enabled")), ...listFile(join(env.dir, "services.required"))]);
  }

  async function units(services: string[]): Promise<Record<string, Record<string, string>>> {
    const names = new Set(services.map((s) => `${hu}-${s}.service`));
    for (const extra of ["devtunnel", "panel", "panel-tunnel", "widget-tunnel"]) names.add(`${hu}-${extra}.service`);
    for (const u of plugin.units) names.add(`${u}.service`);
    if (launchd !== undefined) {
      return launchdUnitProps(launchd, hu, [...names].map((n) => n.slice(0, -".service".length)), unitPrefixes, uptime());
    }
    // hds-* não casa hds_<id>-*: cada painel vê só as units da sua instância
    for (const line of (await out(["systemctl", "--user", "list-units", `${hu}-*`, "--all", "--plain", "--no-legend"])).split("\n")) {
      const unit = line.trim().split(/\s+/)[0] ?? "";
      if (unit.endsWith(".service") && !unitPrefixes.some((p) => unit.startsWith(p))) names.add(unit);
    }
    const props = "Id,ActiveState,SubState,Result,NRestarts,MemoryCurrent,CPUUsageNSec,ActiveEnterTimestampMonotonic,ExecMainStatus";
    const raw = await out(["systemctl", "--user", "show", "-p", props, ...[...names].sort()]);
    const result: Record<string, Record<string, string>> = {};
    for (const block of raw.trim().split("\n\n")) {
      const f: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const eq = line.indexOf("=");
        if (eq >= 0) f[line.slice(0, eq)] = line.slice(eq + 1);
      }
      if (f.Id) result[f.Id.slice(0, -".service".length)] = f;
    }
    return result;
  }

  async function sliceUsage(unitMap: Record<string, Record<string, string>>): Promise<Dict> {
    if (launchd !== undefined) return launchdSliceUsage(unitMap);
    const cg = (await out(["systemctl", "--user", "show", `${env.slice}.slice`, "-p", "ControlGroup", "--value"])).trim();
    if (!cg) return { used: 0, max: null, high: null };
    const path = join(CGROUP_ROOT, cg.replace(/^\/+/, ""));
    return { used: cgMem(path) ?? 0, max: cgMax(path), high: cgHigh(path) };
  }

  async function containers(): Promise<Dict[]> {
    const raw = await out([
      "docker", "ps", "-a", "--no-trunc", "--filter", `label=com.docker.compose.project=${env.project}`,
      "--format", '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Label "com.docker.compose.service"}}',
    ]);
    const seen = new Set<string>();
    const rows: Dict[] = [];
    for (const line of raw.split("\n")) {
      const f = line.split("\t");
      if (f.length < 5) continue;
      const [cid, name, state, status, svc] = f as [string, string, string, string, string];
      const cg = join(CGROUP_ROOT, "system.slice", `docker-${cid}.scope`);
      seen.add(svc);
      rows.push({
        service: svc, name, state, status, mem: state === "running" ? cgMem(cg) : null, max: state === "running" ? cgMax(cg) : null,
        oneshot: svc.endsWith("-init"), healthy: status.includes("(healthy)"), unhealthy: status.includes("(unhealthy)"),
      });
    }
    const compose = composeServices(env.dir);
    for (const svc of compose.keys()) {
      if (!seen.has(svc)) {
        rows.push({ service: svc, name: `${env.project}-${svc}-1`, state: "ausente", status: "nunca criado", mem: null, max: null, oneshot: svc.endsWith("-init"), healthy: false, unhealthy: false });
      }
    }
    const order = [...compose.keys()];
    const rank = (c: Dict): number => {
      const i = order.indexOf(c.service as string);
      return i >= 0 ? i : 99;
    };
    return rows.sort((a, b) => rank(a) - rank(b));
  }

  async function behind(builtFile: string, sha: string | null, paths: string[]): Promise<{ built: string | null; stale: boolean | null }> {
    const built = (readText(join(env.dir, builtFile)) ?? "").trim();
    if (!(built && sha)) return { built: built || null, stale: null };
    if (built === sha) return { built, stale: false };
    const r = await exec(["git", "-C", env.worktree, "diff", "--quiet", built, sha, "--", ...paths]);
    return { built, stale: BEHIND_UNKNOWN_RC.includes(r.status) ? r.status !== 0 : null };
  }

  async function branch(): Promise<Dict> {
    const now = Date.now() / 1000;
    if (now - git.t < BRANCH_TTL_S) return git.v;
    const head = (await gitOut(["log", "-1", "--format=%H%x09%cI%x09%s"])).trim().split("\t");
    const name = (await gitOut(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const sha = head[0] ? head[0] : null;
    const prs: Dict[] = [];
    for (const line of readLines(join(env.dir, "prs.tsv"))) {
      const f = line.split("\t");
      if (f.length >= 5) prs.push({ number: f[0], sha: (f[1] as string).slice(0, 10), base: f[2], branch: f[3], title: f[4] });
    }
    const conflicts = readLines(join(env.dir, "conflicts.log")).filter((l) => l.trim());
    const base = await baseRef();
    const dev = (await gitOut(["log", "-1", "--format=%H%x09%cI%x09%s", base])).trim().split("\t");
    const ahead = (await gitOut(["rev-list", "--count", `HEAD..${base}`])).trim();
    let fetchHead = (await gitOut(["rev-parse", "--git-path", "FETCH_HEAD"])).trim() || "/nonexistent";
    if (!isAbsolute(fetchHead)) fetchHead = join(env.worktree, fetchHead);
    // pastas cujo diff pede rebuild do front: web.paths (uma por linha), entregue pelo ambiente do projeto
    const webPaths = readLines(join(env.dir, "web.paths")).map((l) => l.trim()).filter(Boolean);
    // e as dos serviços: services.paths do plugin; sem ele, apps/ e libs/ quando o worktree as tem, senão nada
    let svcPaths = readLines(join(env.dir, "services.paths")).map((l) => l.trim()).filter(Boolean);
    if (!svcPaths.length) svcPaths = ["apps", "libs"].filter((p) => isDir(join(env.worktree, p)));
    const prsList = readLines(join(env.dir, "prs.list")).map((l) => (l.split("#", 1)[0] as string).trim()).filter(Boolean);
    const remoteUrl = (await gitOut(["config", "--get", "remote.origin.url"])).trim();
    const repo = /([^:/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remoteUrl);
    const statusMd = join(env.dir, "STATUS.md");
    const v: Dict = {
      name, sha, date: head[1] ?? null, subject: head[2] ?? null,
      services: svcPaths.length ? { ...(await behind("services-built.sha", sha, svcPaths)), paths: svcPaths } : { built: null, stale: null, paths: [] },
      web: webPaths.length ? { ...(await behind("web-built.sha", sha, webPaths)), paths: webPaths } : { built: null, stale: null, paths: [] },
      repo: repo ? repo[1] : null,
      prsList, developOnly: prsList.length === 1 && prsList[0] === "-0", base, baseName: base.replace(/^origin\//, ""),
      develop: {
        sha: dev[0] ? dev[0] : null, date: dev[1] ?? null, subject: dev[2] ?? null, newCommits: num(ahead),
        fetchedAt: existsSync(fetchHead) ? statSync(fetchHead).mtimeMs / 1000 : null,
      },
      prs, report: fields(join(env.dir, "rebuild.report")),
      headsChanged: (readText(join(env.dir, "logs", "watch.last-diff")) ?? "").trim() || null,
      conflicts: conflicts.length, conflictsTail: conflicts.slice(-4),
      statusAt: existsSync(statusMd) ? statSync(statusMd).mtimeMs / 1000 : null,
    };
    git = { t: now, v };
    return v;
  }

  function gateQueue(): Dict[] {
    const locks = env.locks;
    if (!locks) return [];
    const dirs = [join(locks, "gate-queue"), join(parse(parse(locks).dir).dir, "_maquina", "locks", "gate-queue")];
    const files: string[] = [];
    for (const d of dirs) {
      try {
        for (const f of readdirSync(d)) if (f.endsWith(".t")) files.push(join(d, f));
      } catch {
        // pasta ausente: a fila daquele escopo está vazia
      }
    }
    const rows = files.sort().map((path) => {
      const f = fields(path);
      return {
        label: f.label ?? "-", kind: f.kind ?? "-", state: f.state ?? "-", cost: f.cost ?? null, since: isoEpoch(f.since ?? ""),
        clone: basename(f.clone ?? ""), local: (f.label ?? "").startsWith("hades-"), machine: !path.startsWith(`${locks}/`),
      };
    });
    return rows.sort((a, b) => Number(a.state !== "running") - Number(b.state !== "running") || (a.since ?? 0) - (b.since ?? 0));
  }

  function skillProcs(): SkillProc[] {
    const found: SkillProc[] = [];
    for (const { pid, cmd } of procCommands()) {
      if (cmd.includes(env.dir) && procPattern.test(cmd) && SKILL_SHELLS.some((s) => cmd.startsWith(s))) {
        found.push({ pid, cmd: cmd.replaceAll(`${env.dir}/`, "").slice(0, SKILL_PROC_CMD_MAX) });
      }
    }
    // só a raiz: subshells do mesmo script repetem a linha
    const uniq = new Map<string, SkillProc>();
    for (const p of found.sort((a, b) => a.pid - b.pid)) if (!uniq.has(p.cmd)) uniq.set(p.cmd, p);
    return [...uniq.values()];
  }

  async function versionState(cfg: Record<string, string>): Promise<Dict> {
    const cache = join(env.dir, "version-check.json");
    let vcfg: Settings;
    let st: ReturnType<typeof versionStatus>;
    try {
      vcfg = versionSettings(cfg);
      st = versionStatus(vcfg, cache, localVersion(env.dir));
    } catch (error) {
      log("warn", "version-check: indisponível", { reason: error instanceof Error ? error.name : "erro" });
      return { enabled: false, access: false, update: false };
    }
    if (st.update) st.command = updateCommand({ ...cfg, W: env.worktree });
    if (st.due && !versionRefreshing) {
      versionRefreshing = true;
      // a amostragem nunca espera a rede: a consulta corre à parte, uma por vez
      void refresh(vcfg, cache)
        .then((state) => {
          if (state.reason) log("warn", "version-check: sem checagem", { reason: String(state.reason) });
        })
        .catch((error: unknown) => log("error", "version-check: falhou", { reason: error instanceof Error ? error.name : "erro" }))
        .finally(() => {
          versionRefreshing = false;
        });
    }
    const keys = ["enabled", "access", "local", "remote", "checkedAt", "update", "command"] as const;
    return Object.fromEntries(keys.filter((k) => k in st).map((k) => [k, st[k]]));
  }

  async function sample(): Promise<void> {
    const now = Date.now() / 1000;
    const up = uptime();
    const catalog = serviceCatalog(env.dir);
    const names = [...catalog.keys()];
    const [unitMap, enabledSet] = await Promise.all([units(names), enabledServices()]);
    const required = listFile(join(env.dir, "services.required"));
    const dt = prevT === undefined ? 0 : now - prevT;
    const cpuNow = new Map<string, number>();

    const unitView = (name: string): Dict => {
      const u = unitMap[name] ?? {};
      const active = u.ActiveState === "active";
      const mem = u.MemoryCurrent ?? "";
      const cpuNs = u.CPUUsageNSec ?? "";
      let cpu: number | null = null;
      if (/^\d+$/.test(cpuNs)) {
        cpuNow.set(name, Number(cpuNs));
        const prev = prevCpu.get(name);
        if (prev !== undefined && dt > 0 && active) cpu = Math.max(0, ((Number(cpuNs) - prev) / 1e9 / dt) * 100);
      }
      const mono = u.ActiveEnterTimestampMonotonic ?? "0";
      return {
        state: u.ActiveState ?? "inactive", sub: u.SubState ?? "dead", result: u.Result ?? null,
        restarts: /^\d+$/.test(u.NRestarts ?? "") ? Number(u.NRestarts) : 0,
        mem: /^\d+$/.test(mem) && active ? Number(mem) : null, cpu,
        age: active && /^\d+$/.test(mono) && Number(mono) ? up - Number(mono) / 1e6 : null,
      };
    };

    const services: Dict[] = names.map((ms) => ({
      ...unitView(`${hu}-${ms}`), name: ms, port: catalog.get(ms)?.port ?? null, enabled: enabledSet.has(ms), required: required.includes(ms),
      built: existsSync(join(env.worktree, "dist", "apps", ms, "main.js")), redis: catalog.get(ms)?.redis, db: catalog.get(ms)?.db,
      logs: logErrors(env.dir, logCache, ms, now),
    }));
    const ready = await Promise.all(services.map((s) => (s.state === "active" && s.port ? httpStatus(`http://127.0.0.1:${s.port}${env.health[s.name as string] ?? "/health/ready"}`) : Promise.resolve(null))));
    services.forEach((s, i) => {
      s.ready = ready[i] === 200;
      s.readyCode = ready[i] ?? null;
    });

    const extras: Dict = {};
    for (const [key, unit] of [["tunnel", "devtunnel"], ["panel", "panel"], ["panelTunnel", "panel-tunnel"], ["widgetTunnel", "widget-tunnel"]] as const) {
      extras[key] = unitView(`${hu}-${unit}`);
    }
    // o plugin mede o que é dele (units próprias, memória para a série "extra") com as mesmas ferramentas
    const pluginOut = await deps.pluginSample({ units: unitMap, unitView });
    const pluginExtras = (pluginOut.extras ?? {}) as Dict;
    for (const [k, v] of Object.entries(pluginExtras)) if (!(k in extras)) extras[k] = v;
    prevCpu = cpuNow;
    prevT = now;

    // só sonda local: a URL de cada endpoint vem do manifesto, e nada sai da máquina
    const probes = plugin.endpoints.filter((e) => String(e.probe ?? "").startsWith("http://127.0.0.1:"));
    const probed = await Promise.all(probes.map((e) => httpStatus(String(e.probe))));
    const endpoints = Object.fromEntries(probes.map((e, i) => [e.name as string, probed[i]]));
    const [boxes, slice, jobList] = await Promise.all([containers(), sliceUsage(unitMap), jobs.list()]);
    const mem = meminfo();
    const cede = readLines(join(env.dir, "logs", "cede.log")).join("\n").trim().split("\n").filter(Boolean);
    const lastCede = cede.length ? (cede[cede.length - 1] as string).split(/\s+/).filter(Boolean) : [];
    const busy = jobList.filter((j) => j.state === "rodando" && j.exclusive);
    const procs = skillProcs();

    const enabled = services.filter((s) => s.enabled);
    const longRunning = boxes.filter((c) => !c.oneshot && !plugin.optionalContainers.has(c.service as string));
    const nActive = enabled.filter((s) => s.state === "active").length;
    const nReady = enabled.filter((s) => s.ready).length;
    const cUp = longRunning.filter((c) => c.state === "running").length;
    const paused = lastCede.length > 0 && lastCede[lastCede.length - 1] === "paused";
    let overall: string;
    if (busy.length || procs.length) overall = "busy";
    else if (nActive === 0 && cUp <= 1) overall = paused ? "paused" : "stopped";
    else if (nReady === enabled.length && cUp >= longRunning.length - 1) overall = "up";
    else overall = "partial";

    const sum = (rows: Dict[], key: string): number => rows.reduce((acc, r) => acc + ((r[key] as number | null) ?? 0), 0);
    const extraMem = typeof pluginOut.mem === "number" && Number.isInteger(pluginOut.mem) ? pluginOut.mem : 0;
    const point: Dict = {
      t: now, avail: mem.MemAvailable ?? 0, slice: slice.used, svc: sum(services, "mem"), infra: sum(boxes, "mem"), extra: extraMem,
      ready: nReady, active: nActive, errors: services.reduce((acc, s) => acc + (s.logs as { errors: number }).errors, 0),
    };
    const cfg = deps.configValues();
    const snap: Dict = {
      t: now, overall, paused, pausedAt: lastCede[0] ?? null, cedeDisabled: existsSync(join(env.dir, "cede.disabled")) || cfg.HADES_CEDE === "0", config: cfg,
      host: {
        memTotal: mem.MemTotal ?? 0, memAvailable: mem.MemAvailable ?? 0, swapUsed: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0), swapTotal: mem.SwapTotal ?? 0,
        load: loadAverage(), ncpu: availableParallelism(),
      },
      slice, services, containers: boxes, plugin: pluginOut, extras, endpoints,
      tunnelUrl: (readText(join(env.dir, "tunnel.url")) ?? "").trim() || null,
      panelTunnel: { unit: unitView(`${hu}-panel-tunnel`).state, url: deps.publicUrl() ?? null },
      unitPrefix: hu, instance: { id: env.instanceId, unitPrefix: hu, slice: env.slice, project: env.project, tunnel: `hades${env.tunnelId}`, panelTunnel: `hades-panel${env.tunnelId}` },
      branch: await branch(), gates: gateQueue(), jobs: jobList, skillProcs: procs, paths: { D: env.dir, W: env.worktree }, herdr: await herdr.badge(),
      versionCheck: await versionState(cfg),
    };
    history.push(point);
    if (history.length > HISTORY) history.shift();
    snap.history = [...history];
    snapshot = snap;
  }

  async function tick(): Promise<void> {
    try {
      await sample();
    } catch (error) {
      // o painel não pode morrer por um estado esquisito
      snapshot = { ...snapshot, error: String(error) };
      log("error", "amostragem falhou", { reason: error instanceof Error ? error.message : String(error) });
    }
    if (!stopped) timer = setTimeout(() => void tick(), SAMPLE_EVERY_MS);
  }

  return {
    snapshot: () => snapshot,
    start() {
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    sample,
    skillProcs,
    baseRef,
    gateQueue,
  };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

