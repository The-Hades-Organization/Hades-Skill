// Amostrador da fila de gates e do estado do loop (somente leitura).
// Lê locks, fila do gate-lock, estado shardado por PR, escalações, entregas e sumários de gate em WORK_ROOT e o /proc.
import { hostname, userInfo } from "node:os";
import { type Dirent, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readText } from "../lib/fs.ts";
import { log } from "./log.ts";
import {
  DAEMON_RE, HEAVY_RE, type InfraItem, type Proc, type ProcTable, allGateScopes, ancestors, cgroupUsage, descendants, dockerNames, gateScope,
  infraHostPattern, infraUsage, meminfo, pluginInfraDaemons, pressure, scanProcs,
} from "./gatewatch-proc.ts";
import { bootEpoch, fields, loadAverage } from "./system.ts";

type Dict = Record<string, unknown>;

export const MACHINE = "_maquina";
const SAMPLE_EVERY_MS = 5000;
const HISTORY = 720;
const CLK_TCK = 100;
const GATE_RE = /gate-lock(?:\.sh)?\s+run\s+(\S+)(.*?)\s--\s(.*)$/;
const CMD_RE = /\tcmd=(.+)$/;
const DUR_RE = /\tdur=(\d+)s/;
const SUMMARY_WINDOW_S = 6 * 3600;
const RECENT_CACHE_S = 30;
const RECENT_GATES = 15;
const SHARD_MAX_AGE_S = 86400 * 2;
const DAY_S = 86400;
const JOURNAL_TAIL = 40;
const BYPASS_MIN_RSS = 150 * 1024 * 1024;
const BYPASS_MIN_CPU = 20;
const STEP_PCT_CAP = 99;
const ESCALATION_WHY_MAX = 220;
const ESCALATIONS_SHOWN = 12;
const RECENT_PRS_SHOWN = 12;
const GATE_CMD_MAX = 4000;
const STEP_CMD_MAX = 160;
const SUMMARY_LAST_MAX = 160;
const ISO_SECONDS_LEN = 19;
const DETAIL_JOURNAL = 60;
const DETAIL_HISTORY_STRIDE = 2;

interface Owner extends Record<string, string | undefined> {
  slot: string;
  version: "v1" | "v2";
}

/** `2026-10-27T15:19:43...` lido como UTC, como o `time.mktime(...) - time.timezone` do original. */
export function isoUtcEpoch(text: unknown): number | null {
  if (typeof text !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(text)) return null;
  const ms = Date.parse(`${text.slice(0, ISO_SECONDS_LEN)}Z`);
  return Number.isNaN(ms) ? null : ms / 1000;
}

const mtimeOf = (path: string): number | undefined => {
  try {
    return statSync(path).mtimeMs / 1000;
  } catch {
    return undefined;
  }
};

const asDict = (value: unknown): Dict => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {});
const countBy = (items: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
};

export function workRoot(env: NodeJS.ProcessEnv, home: string): string {
  if (env.HADES_WORK_ROOT) return env.HADES_WORK_ROOT;
  const line = (readText(join(home, ".claude", "hades", "work-root")) ?? "").split("\n")[0]?.trim();
  return line || join(home, ".claude", "hades", "work");
}

/** Lê e mantém por mtime os JSON de estado (o conjunto de shards é grande e muda pouco). */
function jsonCache(): (path: string) => unknown {
  const cache = new Map<string, { mtime: number; data: unknown }>();
  return (path) => {
    const mtime = mtimeOf(path);
    if (mtime === undefined) return null;
    const hit = cache.get(path);
    if (hit && hit.mtime === mtime) return hit.data;
    let data: unknown = null;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // arquivo sendo regravado ou corrompido: sem dado até a próxima leitura
    }
    cache.set(path, { mtime, data });
    return data;
  };
}

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function walkFiles(root: string, visit: (path: string, name: string) => void): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = join(root, e.name);
    if (e.isDirectory()) walkFiles(path, visit);
    else if (e.isFile()) visit(path, e.name);
  }
}

export interface GateWatchOptions {
  dir: string;
  /** pasta de locks do ambiente (LOCKS do env.sh) */
  locks: string | undefined;
  /** arquivo gate-lock.sh (GATE_LOCK do env.sh), de onde saem orçamento e reserva */
  gateLock: string | undefined;
  root: string;
  /** fila crua do amostrador do painel, usada quando este não está disponível */
  fallbackGates: () => Dict[];
  now?: () => number;
}

export interface GateWatch {
  start(): void;
  stop(): void;
  sample(): Promise<void>;
  detail(): Dict;
}

export function createGateWatch(opts: GateWatchOptions): GateWatch {
  const now = opts.now ?? ((): number => Date.now() / 1000);
  const loadJson = jsonCache();
  const runsCache = new Map<string, { at: number; runs: Dict[] }>();
  const names = dockerNames(now);
  const hostPattern = infraHostPattern(pluginInfraDaemons(opts.dir));
  const bootTime = bootEpoch() || Math.floor(now());
  const ncpu = navigator.hardwareConcurrency || 1;
  const host = hostname();
  const history: Dict[] = [];
  let snapshot: Dict = {};
  let prevCpu = new Map<number, number>();
  let prevCgCpu = new Map<string, number>();
  let prevT: number | undefined;
  let cpuPct = new Map<number, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;

  const repos = (): string[] => listDirs(opts.root).filter((n) => n.includes("__") || n === MACHINE);

  function skillState(repoDir: string, at: number): Dict {
    const stateDir = join(repoDir, "state");
    const g = asDict(loadJson(join(stateDir, "global.json")));
    const escalations = ((g.escalations as Dict[] | undefined) ?? []).filter((e) => !e.answeredAt);
    escalations.sort((a, b) => String(b.askedAt ?? "").localeCompare(String(a.askedAt ?? "")));
    const deliveries = countBy(Object.values(asDict(g.deliveries)).map((v) => String(asDict(v).status ?? "?")));
    const hours = new Map<number, Record<string, number>>();
    const verdicts: Record<string, number> = {};
    const recent: { pr: unknown; last: number; rounds: unknown; review: unknown; blocking: unknown }[] = [];
    for (const name of readdirSafe(stateDir).filter((n) => /^pr-.*\.json$/.test(n))) {
      const path = join(stateDir, name);
      const mtime = mtimeOf(path);
      if (mtime === undefined || at - mtime > SHARD_MAX_AGE_S) continue;
      const d = asDict(loadJson(path));
      let last = 0;
      for (const bucket of ["threads", "comments"]) {
        for (const v of Object.values(asDict(d[bucket]))) {
          const item = asDict(v);
          const t = isoUtcEpoch(item.at);
          if (!t) continue;
          last = Math.max(last, t);
          if (at - t <= DAY_S) {
            const h = Math.floor((at - t) / 3600);
            const verdict = String(item.verdict ?? "?");
            const row = hours.get(h) ?? {};
            row[verdict] = (row[verdict] ?? 0) + 1;
            hours.set(h, row);
            verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
          }
        }
      }
      const rv = asDict(d.review);
      recent.push({ pr: d.pr ?? null, last, rounds: d.reviewRounds ?? null, review: rv.verdict ?? null, blocking: rv.blocking ?? null });
    }
    recent.sort((a, b) => b.last - a.last);
    return {
      escalationsOpen: escalations.length,
      escalations: escalations.slice(0, ESCALATIONS_SHOWN).map((e) => ({ id: e.id ?? null, pr: e.pr ?? null, why: String(e.why ?? "").slice(0, ESCALATION_WHY_MAX), askedAt: e.askedAt ?? null })),
      deliveries,
      actionsByHour: Array.from({ length: 24 }, (_, h) => ({ hoursAgo: h, ...(hours.get(h) ?? {}) })),
      verdicts24h: verdicts,
      recentPrs: recent.slice(0, RECENT_PRS_SHOWN),
    };
  }

  function recentGates(repoDir: string, at: number): Dict[] {
    const hit = runsCache.get(repoDir);
    if (hit && at - hit.at < RECENT_CACHE_S) return hit.runs;
    const runs: (Dict & { mtime: number })[] = [];
    walkFiles(repoDir, (path, name) => {
      if (!(name.startsWith("summary") || name.endsWith(".summary"))) return;
      const mtime = mtimeOf(path);
      if (mtime === undefined || at - mtime > SUMMARY_WINDOW_S) return;
      const lines = (readText(path) ?? "").split("\n").filter((l) => l.trim());
      const codes: { line: string; code: number }[] = [];
      for (const l of lines) {
        const m = /(?:^|\s)(?:exit|rc)=(\d+)|^[\w:.-]+=(\d+)$/.exec(l.trim());
        if (m) codes.push({ line: l.trim(), code: Number.parseInt((m[1] ?? m[2]) as string, 10) });
      }
      runs.push({
        path: relative(repoDir, path), mtime, done: lines.some((l) => l.trim() === "DONE"), steps: codes.length,
        failed: codes.filter((c) => c.code !== 0).map((c) => c.line).slice(0, 6), last: (lines[lines.length - 1] ?? "").slice(0, SUMMARY_LAST_MAX),
      });
    });
    runs.sort((a, b) => b.mtime - a.mtime);
    const top = runs.slice(0, RECENT_GATES);
    runsCache.set(repoDir, { at, runs: top });
    return top;
  }

  const journalLines = (repoDir: string): string[] => (readText(join(repoDir, "locks", "gate-journal.tsv")) ?? "").split("\n").filter((l, i, all) => !(i === all.length - 1 && l === ""));
  const journalTail = (repoDir: string): string[][] => journalLines(repoDir).slice(-JOURNAL_TAIL).map((l) => l.split("\t"));

  /** Mediana de duração por comando normalizado das linhas `done` do journal: sem histórico não há estimativa. */
  function stepDurations(repoDir: string): Map<string, number> {
    const acc = new Map<string, number[]>();
    for (const line of journalLines(repoDir)) {
      if (!line.includes("\tdone\t")) continue;
      const c = CMD_RE.exec(line);
      const d = DUR_RE.exec(line);
      if (c && d) acc.set((c[1] as string).trim(), [...(acc.get((c[1] as string).trim()) ?? []), Number.parseInt(d[1] as string, 10)]);
    }
    const out = new Map<string, number>();
    for (const [k, v] of acc) out.set(k, [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] as number);
    return out;
  }

  /** Mesma normalização do `normalize_cmd` do gate-lock.sh, para a chave bater com o journal. */
  function normalizeCmd(cmd: string): string {
    const out: string[] = [];
    let skip = false;
    for (const tok of cmd.split(/\s+/).filter(Boolean)) {
      if (!skip && tok === "env") {
        skip = true;
        continue;
      }
      if (skip && tok.includes("=")) continue;
      skip = false;
      out.push(tok.slice(tok.lastIndexOf("/") + 1));
    }
    return out.join(" ").slice(0, 120);
  }

  /** Passo pesado mais raso sob o gate: quem informa a etapa é o topo (`nx test <app>`), não a folha. */
  function currentStep(pid: number, table: ProcTable): { cmd: string; proc: Proc } | undefined {
    const queue = [...(table.children.get(pid) ?? [])];
    for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
      const p = table.procs.get(cur);
      if (p && HEAVY_RE.test(p.cmd) && !DAEMON_RE.test(p.cmd)) return { cmd: p.cmd.slice(0, STEP_CMD_MAX), proc: p };
      queue.push(...(table.children.get(cur) ?? []));
    }
    return undefined;
  }

  function belongs(cwd: string, repoName: string, owner: Owner | undefined, namedRepos: string[]): boolean {
    // fila da máquina não tem slug: só o ticket dela diz que o gate é dali; com um repositório só, o slug é dispensável
    if (repoName === MACHINE) return owner !== undefined;
    if (namedRepos.length <= 1) return true;
    return owner !== undefined || cwd.includes(repoName.split("__").pop() as string);
  }

  async function sampleOnce(): Promise<void> {
    const at = now();
    const table = scanProcs(bootTime);
    const { procs, children } = table;
    const dt = prevT === undefined ? 0 : at - prevT;
    if (dt > 0) {
      const pct = new Map<number, number>();
      for (const [pid, p] of procs) {
        const before = prevCpu.get(pid);
        // processo que nasceu depois da amostra anterior conta o que gastou desde que nasceu, limitado à janela
        const used = before !== undefined ? (p.cpu - before) / CLK_TCK : Math.min(p.cpu / CLK_TCK, dt);
        pct.set(pid, Math.max(0, (used / dt) * 100));
      }
      cpuPct = pct;
    }
    prevCpu = new Map([...procs].map(([pid, p]) => [pid, p.cpu]));
    prevT = at;
    const cgCpuNow = new Map<string, number>();
    const scopesSeen = new Set<string>();

    const tree = (pid: number): { rss: number; cpu: number } => {
      const ds = descendants(pid, children);
      return { rss: ds.reduce((a, d) => a + (procs.get(d)?.rss ?? 0), 0), cpu: ds.reduce((a, d) => a + (cpuPct.get(d) ?? 0), 0) };
    };
    // prefere o cgroup do scope (vê o worker de vida curta do jest); sem ele cai na árvore de /proc
    const gateUsage = (pid: number): { rss: number; cpu: number } => {
      const cg = gateScope(pid, children);
      if (cg !== undefined) {
        const { mem, cpuSeconds } = cgroupUsage(cg);
        if (mem !== null) {
          scopesSeen.add(cg);
          let pct = 0;
          if (cpuSeconds !== null) {
            cgCpuNow.set(cg, cpuSeconds);
            const before = prevCgCpu.get(cg);
            if (before !== undefined && dt > 0) pct = Math.max(0, ((cpuSeconds - before) / dt) * 100);
          }
          return { rss: mem, cpu: pct };
        }
      }
      return tree(pid);
    };
    const ageOf = (p: Proc): number => at - (bootTime + p.start / CLK_TCK);

    const mem = meminfo();
    const psi = pressure();
    const load = loadAverage();

    const agents: Dict[] = [];
    for (const p of procs.values()) {
      if (!(p.comm === "claude" || (p.cmd.split(" ")[0] ?? "").endsWith("/claude") || p.cmd === "claude")) continue;
      if (procs.get(p.ppid)?.comm === "claude") continue;
      agents.push({ pid: p.pid, cwd: p.cwd, age: ageOf(p), ...tree(p.pid) });
    }

    const perRepo: Dict[] = [];
    const wrappers = new Set<number>();
    let gateRssTotal = 0;
    let runningTotal = 0;
    let waitingTotal = 0;
    const allRepos = repos();
    const namedRepos = allRepos.filter((r) => r !== MACHINE);
    for (const repoName of allRepos) {
      const repoDir = join(opts.root, repoName);
      const locksDir = join(repoDir, "locks");
      const medians = stepDurations(repoDir);
      const slotOwner = new Map<number, Owner>();
      for (const s of readdirSafe(locksDir).filter((n) => /^gate-.*\.slot-/.test(n))) {
        const o = fields(join(locksDir, s, "owner"));
        if (/^\d+$/.test(o.pid ?? "")) slotOwner.set(Number.parseInt(o.pid as string, 10), { ...o, slot: s, version: "v1" });
      }
      // o ticket vale qualquer que seja o `state`: quem espera também precisa ser reconhecido como dono
      for (const t of readdirSafe(join(locksDir, "gate-queue")).filter((n) => n.endsWith(".t"))) {
        const o = fields(join(locksDir, "gate-queue", t));
        if (/^\d+$/.test(o.pid ?? "")) slotOwner.set(Number.parseInt(o.pid as string, 10), { ...o, slot: t, version: "v2" });
      }
      const admitted = (o: Owner | undefined): boolean => o !== undefined && (o.version === "v1" || o.state === "running");

      const gates: (Dict & { state: string; age: number })[] = [];
      for (const p of procs.values()) {
        const m = GATE_RE.exec(p.cmd);
        if (!m || !/\b(bash|bun)\b/.test(p.cmd.split(" ")[0] ?? "")) continue;
        // subshell do próprio wrapper (acquire da v1, filho em segundo plano da v2): conta só o de cima
        if (procs.get(p.ppid)?.cmd === p.cmd) continue;
        const own = slotOwner.get(p.pid);
        if (!belongs(p.cwd, repoName, own, namedRepos)) continue;
        wrappers.add(p.pid);
        let state: string;
        if (admitted(own)) state = "running";
        else if (ancestors(p.ppid, procs).some((a) => admitted(slotOwner.get(a)))) state = "lease";
        else state = "waiting";
        const usage = state === "running" ? gateUsage(p.pid) : { rss: 0, cpu: 0 };
        const since = isoUtcEpoch(own?.since);
        let step: string | null = null;
        let stepAge: number | null = null;
        let stepMedian: number | null = null;
        let stepPct: number | null = null;
        if (state === "running") {
          const cur = currentStep(p.pid, table);
          if (cur) {
            step = cur.cmd;
            stepAge = ageOf(cur.proc);
            stepMedian = medians.get(normalizeCmd(cur.cmd)) ?? null;
            // teto em 99: passo que passou da mediana não "terminou"; dizer 100% seria mentir
            if (stepMedian) stepPct = Math.min(STEP_PCT_CAP, Math.round((stepAge / stepMedian) * 100));
          }
        }
        const label = /--label\s+(\S+)/.exec(m[2] as string);
        gates.push({
          pid: p.pid, kind: m[1], label: label ? (label[1] as string) : "-", state, clone: p.cwd, cmd: (m[3] as string).slice(0, GATE_CMD_MAX),
          age: ageOf(p), rss: usage.rss, cpu: usage.cpu, runningFor: since ? at - since : null, slot: own?.slot ?? null,
          step, stepAge, stepMedian, stepPct,
        });
        if (state === "running") {
          gateRssTotal += usage.rss;
          runningTotal += 1;
        } else if (state === "waiting") waitingTotal += 1;
      }
      gates.sort((a, b) => Number(a.state !== "running") - Number(b.state !== "running") || b.age - a.age);

      const locks: Dict[] = [];
      for (const l of readdirSafe(locksDir).filter((n) => n.endsWith(".lock")).sort()) {
        const o = fields(join(locksDir, l, "owner"));
        const since = isoUtcEpoch(o.since);
        const clone = o.clone ?? "";
        const present = clone ? agents.some((a) => a.cwd === clone || String(a.cwd).startsWith(`${clone}/`)) : false;
        locks.push({ name: l.slice(0, -".lock".length), mode: o.mode ?? "-", clone, age: since ? at - since : null, agentPresent: present });
      }
      perRepo.push({ repo: repoName, gates, locks, state: skillState(repoDir, at), recentGates: recentGates(repoDir, at), journal: journalTail(repoDir) });
    }

    // nx/jest/webpack/eslint vivos sem nenhum wrapper de gate entre os ancestrais: fora da fila
    const bypass: (Dict & { rss: number })[] = [];
    for (const p of procs.values()) {
      if (!["node", "MainThread", "npm", "npx"].includes(p.comm) && !p.cmd.startsWith("node")) continue;
      if (!HEAVY_RE.test(p.cmd) || DAEMON_RE.test(p.cmd)) continue;
      const chain = ancestors(p.pid, procs).slice(1);
      if (chain.some((a) => wrappers.has(a) || GATE_RE.test(procs.get(a)?.cmd ?? ""))) continue;
      if (chain.some((a) => HEAVY_RE.test(procs.get(a)?.cmd ?? "") && !DAEMON_RE.test(procs.get(a)?.cmd ?? ""))) continue;
      const usage = gateUsage(p.pid);
      if (usage.rss < BYPASS_MIN_RSS && usage.cpu < BYPASS_MIN_CPU) continue;
      bypass.push({ pid: p.pid, cwd: p.cwd, cmd: p.cmd.slice(0, GATE_CMD_MAX), age: ageOf(p), rss: usage.rss, cpu: usage.cpu });
    }
    bypass.sort((a, b) => b.rss - a.rss);

    for (const a of agents) {
      const cwd = String(a.cwd);
      a.gates = perRepo.flatMap((r) => (r.gates as { clone: string; state: string; kind: string; label: string }[])
        .filter((g) => g.clone === cwd || g.clone.startsWith(`${cwd}/`)).map((g) => `${g.state}:${g.kind}/${g.label}`));
      a.locks = perRepo.flatMap((r) => (r.locks as { clone: string; name: string }[]).filter((l) => l.clone && cwd === l.clone).map((l) => l.name));
    }
    agents.sort((a, b) => String(a.cwd).localeCompare(String(b.cwd)));

    // scope que ficou de pé sem ticket vivo (o daemon do NX): senão esses bytes somem no "resto da máquina", calculado por subtração
    const leftovers = [...allGateScopes(userInfo().uid)].filter(([k]) => !scopesSeen.has(k)).map(([k, rss]) => ({ scope: k.slice(k.lastIndexOf("/") + 1), rss }));
    leftovers.sort((a, b) => b.rss - a.rss);
    const leftoverRss = leftovers.reduce((acc, x) => acc + x.rss, 0);
    const infra: { total: number; items: InfraItem[] } = await infraUsage(table, hostPattern, names);

    const hostInfo = {
      memTotal: mem.MemTotal ?? 0, memAvailable: mem.MemAvailable ?? 0, leftoverRss, leftovers, infraRss: infra.total, infra: infra.items,
      swapTotal: mem.SwapTotal ?? 0, swapUsed: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0), psiSome: psi.some ?? 0, psiFull: psi.full ?? 0,
      load, ncpu, hostname: host,
    };
    history.push({
      t: at, avail: hostInfo.memAvailable, swap: hostInfo.swapUsed, gateRss: gateRssTotal, leftoverRss, infraRss: infra.total,
      running: runningTotal, waiting: waitingTotal, bypass: bypass.length, psi: hostInfo.psiSome, load: hostInfo.load[0],
    });
    if (history.length > HISTORY) history.shift();
    // só o que foi lido nesta amostra: cgroup de gate que terminou não vira base velha para um scope futuro que reuse o caminho
    prevCgCpu = cgCpuNow;
    snapshot = { t: at, host: hostInfo, agents, repos: perRepo, bypass, history: [...history] };
  }

  async function tick(): Promise<void> {
    try {
      await sampleOnce();
    } catch (error) {
      // o painel não pode morrer por um /proc esquisito
      snapshot = { ...snapshot, error: String(error) };
      log("error", "amostragem da fila de gates falhou", { reason: error instanceof Error ? error.message : String(error) });
    }
    if (!stopped) timer = setTimeout(() => void tick(), SAMPLE_EVERY_MS);
  }

  /** Orçamento e reserva da fila, lidos do gate-lock.sh (o que decide quem entra). */
  function budget(): Dict {
    const src = readText(opts.gateLock ?? "/nonexistent") ?? "";
    const num = (name: string): number | null => {
      const m = new RegExp(`^${name}=\\$\\{${name}:-(\\d+)\\}`, "m").exec(src) ?? new RegExp(`${name}=\\$\\{[A-Z_]+:-(\\d+)\\}`).exec(src);
      return m ? Number.parseInt(m[1] as string, 10) : null;
    };
    return { budgetGb: num("BUDGET_GB"), reserveGb: num("RESERVE_GB") };
  }

  function detail(): Dict {
    if (!opts.locks) return { available: false, gates: opts.fallbackGates() };
    const s = snapshot;
    const all = (s.repos as Dict[] | undefined) ?? [];
    const named = all.filter((r) => r.repo !== MACHINE);
    const repo = named.find((r) => String(opts.locks).includes(String(r.repo))) ?? named[0] ?? {};
    // fila da máquina (HADES_GATE_SCOPE=maquina, repo sem origin): soma a do projeto, o gate vem marcado
    const mach = all.find((r) => r.repo === MACHINE) ?? {};
    const gates = new Map<number, Dict & { state: string; age: number }>();
    for (const g of (repo.gates as (Dict & { pid: number; state: string; age: number })[] | undefined) ?? []) gates.set(g.pid, g);
    for (const g of (mach.gates as (Dict & { pid: number; state: string; age: number })[] | undefined) ?? []) {
      // o ticket da máquina vale mais que o palpite por caminho
      if (!gates.has(g.pid) || g.slot) gates.set(g.pid, { ...g, machine: true });
    }
    const journal = [...((repo.journal as string[][] | undefined) ?? []), ...((mach.journal as string[][] | undefined) ?? [])].sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
    const h = asDict(s.host);
    const recent = [...((repo.recentGates as Dict[] | undefined) ?? []), ...((mach.recentGates as Dict[] | undefined) ?? [])].sort((a, b) => Number(b.mtime ?? 0) - Number(a.mtime ?? 0));
    const points = (s.history as Dict[] | undefined) ?? [];
    return {
      available: true, t: s.t ?? null, repo: repo.repo ?? (Object.keys(mach).length ? MACHINE : null), machine: Object.keys(mach).length > 0,
      gates: [...gates.values()].sort((a, b) => Number(a.state !== "running") - Number(b.state !== "running") || b.age - a.age),
      locks: [...((repo.locks as Dict[] | undefined) ?? []), ...((mach.locks as Dict[] | undefined) ?? [])],
      recent, journal: journal.slice(-DETAIL_JOURNAL), bypass: s.bypass ?? [],
      loop: repo.state ?? {}, agents: s.agents ?? [],
      host: { memTotal: h.memTotal, memAvailable: h.memAvailable, leftoverRss: h.leftoverRss, infraRss: h.infraRss, swapUsed: h.swapUsed, psiSome: h.psiSome, load: h.load },
      history: points.filter((_, i) => i % DETAIL_HISTORY_STRIDE === 0).map((p) => ({ t: p.t, running: p.running, waiting: p.waiting, gateRss: p.gateRss, avail: p.avail })),
      budget: budget(),
    };
  }

  return {
    start() {
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    sample: sampleOnce,
    detail,
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
