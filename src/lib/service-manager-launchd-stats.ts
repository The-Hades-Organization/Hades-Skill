// O retrato das units no launchd, na forma do `systemctl show` que o amostrador do painel (e o plugin) já consomem:
// ActiveState, SubState, Result, NRestarts, MemoryCurrent, CPUUsageNSec, ActiveEnterTimestampMonotonic, ExecMainStatus.
// Memória e CPU vêm da árvore de processos do `ps` (o macOS não tem cgroup).
import { activeStateOf, parseLaunchctlList, parseLaunchctlPrint, parsePsTable, treeTotals, unitOfLabel, type LaunchdPrint, type PsRow } from "./launchd-plist.ts";
import type { LaunchdManager } from "./service-manager-launchd.ts";
import { ctlAsync } from "./service-manager-ctl.ts";

const BYTES_PER_KIB = 1024;
const NS_PER_S = 1e9;
const US_PER_S = 1e6;

const SUB_STATE = { active: "running", activating: "start", failed: "failed", inactive: "dead" } as const;

/** `ps` da máquina toda numa chamada só. */
async function processTable(): Promise<PsRow[]> {
  return parsePsTable((await ctlAsync("ps", ["-axo", "pid=,ppid=,rss=,etime=,cputime="])).stdout);
}

function props(unit: string, print: LaunchdPrint, table: readonly PsRow[], uptimeS: number): Record<string, string> {
  const state = activeStateOf(print);
  const exit = print.lastExitCode ?? 0;
  const out: Record<string, string> = {
    Id: `${unit}.service`, ActiveState: state, SubState: SUB_STATE[state], Result: exit === 0 ? "success" : "exit-code",
    NRestarts: String(Math.max(0, (print.runs ?? 0) - 1)), ExecMainStatus: String(exit),
  };
  if (print.pid !== undefined) {
    const total = treeTotals(table, print.pid);
    out.MemoryCurrent = String(Math.round(total.rssKb * BYTES_PER_KIB));
    out.CPUUsageNSec = String(Math.round(total.cpuS * NS_PER_S));
    out.ActiveEnterTimestampMonotonic = String(Math.max(0, Math.round((uptimeS - total.elapsedS) * US_PER_S)));
  }
  return out;
}

/** As units `names` e as demais com o prefixo do HU que o launchd tem carregadas, exceto as que começam por `skipPrefixes`. Unit não carregada fica de fora (o amostrador a vê como inactive). */
export async function launchdUnitProps(manager: LaunchdManager, hu: string, names: readonly string[], skipPrefixes: readonly string[], uptimeS: number): Promise<Record<string, Record<string, string>>> {
  const loaded = new Set(parseLaunchctlList((await ctlAsync("launchctl", ["list"])).stdout).map((r) => unitOfLabel(r.label)).filter((u): u is string => u !== undefined));
  const wanted = new Set(names);
  for (const unit of loaded) if (unit.startsWith(`${hu}-`) && !skipPrefixes.some((p) => unit.startsWith(p))) wanted.add(unit);
  const present = [...wanted].filter((u) => loaded.has(u)).sort();
  if (present.length === 0) return {};
  const [table, prints] = await Promise.all([processTable(), Promise.all(present.map((u) => ctlAsync("launchctl", ["print", manager.target(u)])))]);
  const result: Record<string, Record<string, string>> = {};
  present.forEach((unit, i) => {
    const printed = prints[i];
    if (printed !== undefined && printed.status === 0) result[unit] = props(unit, parseLaunchctlPrint(printed.stdout), table, uptimeS);
  });
  return result;
}

/** Sem slice no macOS: a soma da memória das units ativas, sem teto. */
export function launchdSliceUsage(unitMap: Record<string, Record<string, string>>): { used: number; max: null; high: null } {
  let used = 0;
  for (const u of Object.values(unitMap)) if (u.ActiveState === "active" && /^\d+$/.test(u.MemoryCurrent ?? "")) used += Number(u.MemoryCurrent);
  return { used, max: null, high: null };
}
