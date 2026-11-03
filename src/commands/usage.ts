// `hades usage`: consumo de tokens da máquina a partir dos transcripts locais do Claude Code (hades usage).
// Custo equivalente de API; em plano de assinatura vale a proporção, que é o que pesa no limite.
//
// Uso: hades usage [--days N] [--json] [--baseline]
//   --json       grava e imprime o JSON (~/.claude/hades/usage/latest.json, lido pelo painel → Consumo)
//   --baseline   grava a janela atual como linha de base (~/.claude/hades/usage/baseline.json)
// Cache por arquivo em ~/.claude/hades/usage/cache.json: só transcript que mudou é relido.
import { mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../lib/output.ts";
import { workRoot } from "../lib/cerberus.ts";
import { guardRules } from "../lib/guard-rules.ts";
import { home } from "../lib/paths.ts";
import { pyDumps } from "../lib/pyjson.ts";
import {
  baselineOf, buildReport, byRoles, CACHE_VERSION, fixed, gitKind, parseFile, plain, readFileOr, transcriptsIn, withBaseline,
  type Agent, type Dict, type Report, type Row,
} from "../lib/usage.ts";

const PROG = "hades usage";
const DEFAULT_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const USAGE_LINE = `usage: ${PROG} [-h] [--days DAYS] [--json] [--baseline]`;
const PYTHON_ARGPARSE_ERROR = 2;

interface Options {
  days: number;
  json: boolean;
  baseline: boolean;
}

type Parsed = { options: Options } | { exit: number; stdout?: string; stderr?: string };

function parseArgs(args: string[]): Parsed {
  const options: Options = { days: DEFAULT_DAYS, json: false, baseline: false };
  const fail = (message: string): Parsed => ({ exit: PYTHON_ARGPARSE_ERROR, stderr: `${USAGE_LINE}\n${PROG}: error: ${message}\n` });
  const unknown: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "-h" || arg === "--help") {
      return { exit: EXIT.ok, stdout: `${USAGE_LINE}\n\noptions:\n  -h, --help   show this help message and exit\n  --days DAYS\n  --json\n  --baseline\n` };
    }
    if (arg === "--json") options.json = true;
    else if (arg === "--baseline") options.baseline = true;
    else if (arg === "--days" || arg.startsWith("--days=")) {
      const value = arg === "--days" ? args[(i += 1)] : arg.slice("--days=".length);
      if (value === undefined) return fail("argument --days: expected one argument");
      if (!/^\s*[+-]?\d+\s*$/.test(value)) return fail(`argument --days: invalid int value: '${value}'`);
      options.days = Number(value);
    } else unknown.push(arg);
  }
  return unknown.length ? fail(`unrecognized arguments: ${unknown.join(" ")}`) : { options };
}

/** json.dumps(ensure_ascii=True): o que não é ASCII sai como \uXXXX (pares substitutos para o que passa do plano básico). */
const escapeNonAscii = (text: string): string => text.replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
const dumps = (value: unknown, indent?: number): string => escapeNonAscii(pyDumps(value, indent));

function registry(): Agent[] {
  const agents: Agent[] = [];
  let projects: string[];
  try {
    projects = readdirSync(workRoot()).sort();
  } catch {
    return agents;
  }
  for (const project of projects) {
    const dir = join(workRoot(), project, "orchestration", "agents");
    let files: string[];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of files) {
      const raw = readFileOr(join(dir, name));
      try {
        const doc: unknown = raw === undefined ? undefined : JSON.parse(raw);
        if (typeof doc === "object" && doc !== null && !Array.isArray(doc)) agents.push(doc as Agent);
      } catch {
        continue;
      }
    }
  }
  return agents;
}

interface Cache {
  v: number;
  files: Record<string, { sig: string; rows: Row[] }>;
}

function loadCache(file: string): Cache {
  const empty: Cache = { v: CACHE_VERSION, files: {} };
  const raw = readFileOr(file);
  if (raw === undefined) return empty;
  try {
    const cache = JSON.parse(raw) as Cache;
    return cache.v === CACHE_VERSION && typeof cache.files === "object" && cache.files !== null ? cache : empty;
  } catch {
    return empty;
  }
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/** Linhas de cada transcript da janela, relendo só o que mudou desde o cache (que é regravado). */
function collectRows(projectsDir: string, since: string, outDir: string): Row[] {
  const rules = guardRules();
  const cache = loadCache(join(outDir, "cache.json"));
  const files: Cache["files"] = {};
  for (const path of transcriptsIn(projectsDir)) {
    let stat;
    try {
      stat = statSync(path, { bigint: true });
    } catch {
      continue;
    }
    if (new Date(Number(stat.mtimeMs)).toISOString().slice(0, 10) < since) continue;
    const sig = `${stat.mtimeNs}:${stat.size}`;
    const hit = cache.files[path];
    files[path] = { sig, rows: hit && hit.sig === sig ? hit.rows : parseFile(path, rules) };
  }
  cache.files = files;
  writeAtomic(join(outDir, "cache.json"), dumps(cache));
  return Object.values(files).flatMap((entry) => entry.rows).filter((row) => row.day >= since);
}

const pad = (value: string, width: number, right = false): string => (right ? value.padStart(width) : value.padEnd(width));

function printable(report: Report): string[] {
  const total = report.total as Dict;
  const value = plain;
  const lines = [`${report.days} dias desde ${report.since}: US$ ${fixed(value(total.cost), 0)} equivalentes · polling US$ ${fixed(value(total.pollCost), 0)} · reescrita US$ ${fixed(value(total.rewriteCost), 0)}`];
  const baseline = report.baseline as { savedAt: string; perDay: unknown } | undefined;
  if (baseline) lines.push(`por dia: US$ ${fixed(value(report.perDay), 0)} (linha de base de ${String(baseline.savedAt).slice(0, 10)}: US$ ${fixed(value(baseline.perDay), 0)})`);
  lines.push("", `${pad("papel", 34)}${pad("sessões", 8, true)}${pad("custo", 9, true)}${pad("%", 7, true)}${pad("polling", 9, true)}${pad("ctx médio", 11, true)}${pad("ctx máx", 9, true)}`);
  for (const row of report.byRole as Dict[]) {
    lines.push(
      pad(String(row.role), 34) + pad(String(row.sessions), 8, true) + pad(fixed(value(row.cost), 0), 9, true)
      + pad(`${fixed(value(row.share), 1)}%`, 7, true) + pad(`${fixed(value(row.pollShare), 1)}%`, 9, true)
      + pad(`${fixed(Number(row.ctxAvg) / 1000, 0)}k`, 11, true) + pad(`${fixed(Number(row.ctxMax) / 1000, 0)}k`, 9, true),
    );
  }
  const agents = report.byAgent as Dict[];
  if (agents.length) {
    lines.push("", "agentes:");
    for (const a of agents.slice(0, 12)) {
      lines.push(`  ${pad(String(a.name), 22)}${pad(String(a.role), 24)}US$ ${pad(fixed(value(a.cost), 0), 6, true)}  ctx médio ${pad(fixed(Number(a.ctxAvg) / 1000, 0), 4, true)}k  polling US$ ${fixed(value(a.poll_cost), 0)}`);
    }
  }
  return lines;
}

export function usageCommand(args: string[]): number {
  const parsed = parseArgs(args);
  if ("exit" in parsed) {
    if (parsed.stdout) process.stdout.write(parsed.stdout);
    if (parsed.stderr) process.stderr.write(parsed.stderr);
    return parsed.exit;
  }
  const { days, json, baseline } = parsed.options;
  const now = new Date();
  const outDir = join(home(), ".claude", "hades", "usage");
  mkdirSync(outDir, { recursive: true });
  const since = new Date(now.getTime() - days * MS_PER_DAY).toISOString().slice(0, 10);
  const rows = collectRows(join(home(), ".claude", "projects"), since, outDir);
  const roles = byRoles(rows, registry(), gitKind);
  const report = buildReport(rows, roles, days, since, `${now.toISOString().slice(0, 19)}+00:00`);
  const baselineFile = join(outDir, "baseline.json");
  if (baseline) writeFileSync(baselineFile, dumps(baselineOf(report, days), 1));
  withBaseline(report, readFileOr(baselineFile), days);
  writeFileSync(join(outDir, "latest.json"), dumps(report, 1));
  if (json) process.stdout.write(`${dumps(report)}\n`);
  else process.stdout.write(`${printable(report).join("\n")}\n`);
  return EXIT.ok;
}
