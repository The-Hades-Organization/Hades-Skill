// `hades usage`: consumo de tokens da máquina a partir dos transcripts locais do Claude Code (hades usage).
// Custo equivalente de API; em plano de assinatura vale a proporção, que é o que pesa no limite.
//
// Uso: hades usage [--days N] [--json] [--baseline]
//      hades usage sample [--quiet]
//   --json       grava e imprime o JSON (~/.claude/hades/usage/latest.json, lido pelo painel → Consumo)
//   --baseline   grava a janela atual como linha de base (~/.claude/hades/usage/baseline.json)
//   sample       comando do statusLine: lê o JSON do Claude Code no stdin, grava o % das janelas de 5 h e semanal
//                (~/.claude/hades/limits/samples.jsonl) e imprime uma linha de status (--quiet: nada). Regra: lib/limites.ts
// Cache por arquivo em ~/.claude/hades/usage/cache.json: só transcript que mudou é relido.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ctxCapOf } from "../lib/ctx-cap.ts";
import { EXIT } from "../lib/output.ts";
import { workRoot } from "../lib/cerberus.ts";
import { guardRules } from "../lib/guard-rules.ts";
import { chaves, gravarAmostra, linhaAtual, medidas, renova, type Chaves } from "../lib/limites-io.ts";
import { calibra, JANELAS, pctDeTokens, ROTULO, textoPct, type Amostra, type Atual, type Calibracao, type Estimativa, type Janela } from "../lib/limites.ts";
import { home } from "../lib/paths.ts";
import { pyDumps } from "../lib/pyjson.ts";
import { configValue } from "../lib/work.ts";
import {
  baselineOf, buildReport, byRoles, CACHE_VERSION, fixed, gitKind, parseFileFull, plain, readFileOr, transcriptsIn, withBaseline,
  type Agent, type CapOf, type Dict, type PctOf, type Report, type Req, type Row, type Tok,
} from "../lib/usage.ts";

const PROG = "hades usage";
const DEFAULT_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const USAGE_LINE = `usage: ${PROG} [-h] [--days DAYS] [--json] [--baseline]`;
const SAMPLE_USAGE = `usage: ${PROG} sample [-h] [--quiet]`;
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
  files: Record<string, { sig: string; rows: Row[]; reqs: Req[] }>;
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

/** Linhas e requisições de cada transcript da janela, relendo só o que mudou desde o cache (que é regravado). */
function collectRows(projectsDir: string, since: string, loadSince: string, outDir: string, reqsSinceMs: number): { rows: Row[]; reqs: Req[] } {
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
    if (new Date(Number(stat.mtimeMs)).toISOString().slice(0, 10) < loadSince) continue;
    const sig = `${stat.mtimeNs}:${stat.size}`;
    const hit = cache.files[path];
    files[path] = hit && hit.sig === sig ? hit : { sig, ...parseFileFull(path, rules, reqsSinceMs) };
  }
  cache.files = files;
  writeAtomic(join(outDir, "cache.json"), dumps(cache));
  const entries = Object.values(files);
  return { rows: entries.flatMap((entry) => entry.rows).filter((row) => row.day >= since), reqs: entries.flatMap((entry) => entry.reqs) };
}

const pad = (value: string, width: number, right = false): string => (right ? value.padStart(width) : value.padEnd(width));

/** Os dois % (5 h e semana) de um conjunto de tokens, para uma linha da tabela; vazio quando o relatório não traz as colunas. */
const pctCols = (entry: Dict, width: number): string =>
  entry.pct5h === undefined ? "" : pad(pctText(entry.pct5h, entry.pct5hPartial), width, true) + pad(pctText(entry.pctWeek, entry.pctWeekPartial), width, true);
const pctText = (value: unknown, partial: unknown): string => textoPct({ pct: typeof value === "number" ? value : null, parcial: partial === true });

interface Limits {
  atual: Partial<Record<Janela, Atual>>;
  calibracao: Calibracao;
  amostras: number;
}

function limitsLines(limits: Limits | undefined, withColumns: boolean): string[] {
  if (!limits) return [];
  const lines = JANELAS.map((j) => {
    const a = limits.atual[j];
    const taxas = limits.calibracao[j];
    const calib = Object.keys(taxas.porModelo).length > 0 ? `calibrada em ${taxas.intervalos} intervalos` : `sem calibração (${taxas.intervalos} intervalos)`;
    return a ? `${ROTULO[j]}: ${a.pct.toFixed(1)}% usado, renova ${renova(j, a.resetsAt)} (medido) · ${calib}` : `${ROTULO[j]}: sem medida atual · ${calib}`;
  });
  if (limits.amostras === 0) lines.push("sem amostras: ligue a coleta (reference/limites.md) para medir os % das janelas");
  if (withColumns) lines.push("colunas % 5h e % semana: estimadas pela calibração (~), não medidas");
  return lines;
}

const kilo = (tokens: unknown): string => `${fixed(Number(tokens) / 1000, 0)}k`;

/** Sessões que passaram do teto de contexto do papel: o nome curto da pasta, o papel, o máximo medido e o teto. */
function overCapLines(over: Dict[] | undefined): string[] {
  if (!over?.length) return [];
  const lines = ["", "acima do teto de contexto:"];
  for (const s of over) {
    const name = String(s.cwd).replace(/\/+$/, "").split("/").pop() || String(s.cwd);
    lines.push(`  ${pad(name, 30)}${pad(String(s.role), 22)}ctx máx ${kilo(s.ctxMax)}, teto ${kilo(s.ctxCap)}`);
  }
  return lines;
}

/** Reaproveitadas × novas (auto-dismiss): turnos e custo por unidade; relatório sem agente não leva o bloco. */
function reuseLines(reuse: { reused: Dict; fresh: Dict } | undefined): string[] {
  if (reuse === undefined) return [];
  const row = (label: string, b: Dict): string => `  ${pad(label, 16)}${pad(String(b.units), 9, true)}${pad(String(b.sessions), 9, true)}${pad(String(b.turns), 9, true)}${pad(fixed(plain(b.cost), 0), 9, true)}`;
  return ["", "sessões reaproveitadas × novas:", `  ${pad("", 16)}${pad("unidades", 9, true)}${pad("sessões", 9, true)}${pad("turnos", 9, true)}${pad("custo", 9, true)}`, row("reaproveitadas", reuse.reused), row("novas", reuse.fresh)];
}

function printable(report: Report, limits: Limits | undefined): string[] {
  const total = report.total as Dict;
  const value = plain;
  const lines = [`${report.days} dias desde ${report.since}: US$ ${fixed(value(total.cost), 0)} equivalentes · polling US$ ${fixed(value(total.pollCost), 0)} · reescrita US$ ${fixed(value(total.rewriteCost), 0)}`];
  const baseline = report.baseline as { savedAt: string; perDay: unknown } | undefined;
  if (baseline) lines.push(`por dia: US$ ${fixed(value(report.perDay), 0)} (linha de base de ${String(baseline.savedAt).slice(0, 10)}: US$ ${fixed(value(baseline.perDay), 0)})`);
  lines.push(...limitsLines(limits, true));
  const roles = report.byRole as Dict[];
  const withPct = roles.length > 0 && roles[0]?.pct5h !== undefined;
  lines.push("", `${pad("papel", 34)}${pad("sessões", 8, true)}${pad("custo", 9, true)}${pad("%", 7, true)}${pad("polling", 9, true)}${pad("ctx médio", 11, true)}${pad("ctx máx", 9, true)}${withPct ? pad("% 5h", 12, true) + pad("% semana", 12, true) : ""}`);
  for (const row of roles) {
    lines.push(
      pad(String(row.role), 34) + pad(String(row.sessions), 8, true) + pad(fixed(value(row.cost), 0), 9, true)
      + pad(`${fixed(value(row.share), 1)}%`, 7, true) + pad(`${fixed(value(row.pollShare), 1)}%`, 9, true)
      + pad(`${fixed(Number(row.ctxAvg) / 1000, 0)}k`, 11, true) + pad(`${fixed(Number(row.ctxMax) / 1000, 0)}k`, 9, true) + pctCols(row, 12),
    );
  }
  const agents = report.byAgent as Dict[];
  if (agents.length) {
    lines.push("", "agentes:");
    for (const a of agents.slice(0, 12)) {
      lines.push(`  ${pad(String(a.name), 22)}${pad(String(a.role), 24)}US$ ${pad(fixed(value(a.cost), 0), 6, true)}  ctx médio ${pad(fixed(Number(a.ctxAvg) / 1000, 0), 4, true)}k  polling US$ ${fixed(value(a.poll_cost), 0)}${a.overCap === true ? "  acima do teto" : ""}${a.pct5h === undefined ? "" : `  5h ${pctText(a.pct5h, a.pct5hPartial)}  semana ${pctText(a.pctWeek, a.pctWeekPartial)}`}`);
    }
  }
  lines.push(...reuseLines(report.reuse as { reused: Dict; fresh: Dict } | undefined));
  lines.push(...overCapLines(report.overCap as Dict[] | undefined));
  const days = report.byDay as Dict[];
  if (withPct && days.length) {
    lines.push("", `${pad("dia", 12)}${pad("custo", 9, true)}${pad("% 5h", 12, true)}${pad("% semana", 12, true)}`);
    for (const d of days) lines.push(pad(String(d.day), 12) + pad(fixed(value(d.cost), 0), 9, true) + pctCols(d, 12));
  }
  return lines;
}

/** Calibração e % atual a partir das amostras e das requisições; sem amostra, tudo "sem calibração". */
function buildLimits(amostras: Amostra[], atual: Limits["atual"], reqs: Req[], k: Chaves): { limits: Limits; pctOf: PctOf } {
  const calibracao = calibra(amostras, reqs, k);
  const pctOf: PctOf = (tok: Record<string, Tok> | undefined) => {
    const five: Estimativa = pctDeTokens(calibracao.five, tok, k.cacheReadWeight);
    const seven: Estimativa = pctDeTokens(calibracao.seven, tok, k.cacheReadWeight);
    const round = (e: Estimativa): number | null => (e.pct === null ? null : Math.round(e.pct * 10) / 10);
    return { pct5h: round(five), pctWeek: round(seven), pct5hPartial: five.pct !== null && five.parcial, pctWeekPartial: seven.pct !== null && seven.parcial };
  };
  return { limits: { atual, calibracao, amostras: amostras.length }, pctOf };
}

export interface LimitsNow {
  k: Chaves;
  atual: Limits["atual"];
  calibracao: Calibracao;
  amostras: number;
}

/** Medida atual e calibração para quem não lista consumo (`moirai estimate`); sem amostra não lê transcript. */
export function limitsNow(now: Date): LimitsNow {
  const k = chaves();
  const { amostras, atual } = medidas(now, k);
  const oldest = amostras[0];
  if (!oldest) return { k, atual, calibracao: calibra([], [], k), amostras: 0 };
  const loadSince = oldest.at.slice(0, 10);
  const outDir = join(home(), ".claude", "hades", "usage");
  mkdirSync(outDir, { recursive: true });
  const { reqs } = collectRows(join(home(), ".claude", "projects"), loadSince, loadSince, outDir, Date.parse(`${loadSince}T00:00:00Z`));
  return { k, atual, calibracao: calibra(amostras, reqs, k), amostras: amostras.length };
}

const limitsJson = (limits: Limits): Dict => ({
  current: Object.fromEntries(JANELAS.flatMap((j) => (limits.atual[j] ? [[j, limits.atual[j]]] : []))),
  calibration: limits.calibracao,
  samples: limits.amostras,
  note: "pct5h e pctWeek são estimados pela calibração (tokens × taxa); current é o % medido pelo status line do Claude Code",
});

function sampleCommand(args: string[]): number {
  const rest = args.filter((arg) => arg !== "--quiet");
  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(`${SAMPLE_USAGE}\n`);
    return EXIT.ok;
  }
  if (rest.length > 0) {
    process.stderr.write(`${SAMPLE_USAGE}\n${PROG} sample: error: unrecognized arguments: ${rest.join(" ")}\n`);
    return PYTHON_ARGPARSE_ERROR;
  }
  const now = new Date();
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  const k = chaves();
  try {
    gravarAmostra(stdin, now, k);
  } catch (error) {
    // o status line não pode quebrar por falha de disco: a amostra se perde e a próxima leitura tenta de novo
    process.stderr.write(`${PROG} sample: não gravou a amostra: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (!args.includes("--quiet")) process.stdout.write(`${linhaAtual(medidas(now, k).atual)}\n`);
  return EXIT.ok;
}

export function usageCommand(args: string[]): number {
  if (args[0] === "sample") return sampleCommand(args.slice(1));
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
  const k = chaves();
  const measured = medidas(now, k);
  const oldest = measured.amostras[0];
  const loadSince = oldest && oldest.at.slice(0, 10) < since ? oldest.at.slice(0, 10) : since;
  const { rows, reqs } = collectRows(join(home(), ".claude", "projects"), since, loadSince, outDir, Date.parse(`${loadSince}T00:00:00Z`));
  const { limits, pctOf } = buildLimits(measured.amostras, measured.atual, reqs, k);
  const roles = byRoles(rows, registry(), gitKind);
  const capOf: CapOf = (role) => ctxCapOf(role, (key) => configValue(key, "") || undefined);
  const report = buildReport(rows, roles, days, since, `${now.toISOString().slice(0, 19)}+00:00`, pctOf, capOf);
  report.limits = limitsJson(limits);
  const baselineFile = join(outDir, "baseline.json");
  if (baseline) writeFileSync(baselineFile, dumps(baselineOf(report, days), 1));
  withBaseline(report, readFileOr(baselineFile), days);
  writeFileSync(join(outDir, "latest.json"), dumps(report, 1));
  if (json) process.stdout.write(`${dumps(report)}\n`);
  else process.stdout.write(`${printable(report, limits).join("\n")}\n`);
  return EXIT.ok;
}
