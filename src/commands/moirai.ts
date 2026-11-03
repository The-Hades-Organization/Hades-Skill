// `hades moirai`: histórico das unidades encerradas e estimativa de custo e duração por unidade de um plano.
// Só lê (registros dos agentes, transcripts, histórico do gate, git); a única escrita é `estimate --write` no plano.
// Regra: lib/moirai.ts. Contrato do formato: reference/moirai.md.
//
// Uso: hades moirai history [--json]
//      hades moirai estimate <plan.md> [--write] [--deep] [--json] [--mode skill|projeto]
import { closeSync, openSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workRoot } from "../lib/cerberus.ts";
import { isDir, isFile, readText, realpathMissingOk } from "../lib/fs.ts";
import { guardRules } from "../lib/guard-rules.ts";
import {
  addTranscriptText, dedupe, emptyFileCost, estimateJson, estimatePlan, gateOfLabel, hasSection, historyLines, historyUnit, inWindow, isRealUnit, modeOf, planUnits,
  renderSection, writeSection, TABLE_HEADER, estimateRow,
  type FileCost, type HistoryUnit, type Measured, type Mode, type Params, type PlanUnit, type RawRecord, type UnitEstimate,
} from "../lib/moirai.ts";
import { die, EXIT, out, warn } from "../lib/output.ts";
import { hadesHome, home, skillRoot } from "../lib/paths.ts";
import { run } from "../lib/proc.ts";
import { parseFile, transcriptsIn } from "../lib/usage.ts";
import { configValue } from "../lib/work.ts";

const USAGE = `uso: hades moirai history [--json]
     hades moirai estimate <plan.md> [--write] [--deep] [--json] [--mode skill|projeto]
  history    uma linha por unidade encerrada (custo, tokens, relógio, gate, clears, tamanho real)
  estimate   mediana p25–p75 por unidade do plano; --write grava a seção "## Estimativa" no plano (entra no hash da
             aprovação); --deep abre um subagente (claude -p) que estima o tamanho do escopo, só a pedido`;

const GIT_TIMEOUT_MS = 30_000;
const DEEP_MAX_LINES = 100_000;
const ROOT_MAQUINA = "_maquina";

// ---------------------------------------------------------------- configuração

function intKey(key: string, fallback: number): number {
  const raw = configValue(key, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) die(`${key}=${raw}: esperava um inteiro maior ou igual a zero`);
  return value;
}

export function loadParams(): Params {
  return {
    minSample: Math.max(1, intKey("HADES_MOIRAI_MIN_SAMPLE", 5)),
    highFactor: Math.max(1, intKey("HADES_MOIRAI_HIGH_FACTOR", 3)),
    smallLines: intKey("HADES_MOIRAI_SMALL_LINES", 150),
    largeLines: intKey("HADES_MOIRAI_LARGE_LINES", 600),
  };
}

// ---------------------------------------------------------------- leitura do disco

const encodeCwd = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");

function rootsOf(base: string): string[] {
  try {
    return readdirSync(base).filter((n) => n !== ROOT_MAQUINA && isDir(join(base, n, "orchestration", "agents"))).sort();
  } catch {
    return [];
  }
}

function recordsOf(base: string, root: string): RawRecord[] {
  const dir = join(base, root, "orchestration", "agents");
  const records: RawRecord[] = [];
  for (const file of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const doc: unknown = JSON.parse(readText(join(dir, file)) ?? "");
      if (typeof doc === "object" && doc !== null && !Array.isArray(doc)) records.push(doc as RawRecord);
    } catch {
      warn(`moirai: registro ilegível ignorado: ${root}/${file}`);
    }
  }
  return records;
}

/** Custo (US$) e tokens (leitura de cache + escrita de cache + saída) das sessões do worktree, pelo mesmo parser do `hades usage`. */
function usageOf(worktree: string): { costUsd: number; tokens: number } | null {
  if (worktree === "") return null;
  const dir = join(home(), ".claude", "projects", encodeCwd(worktree));
  const rules = guardRules();
  let costUsd = 0;
  let tokens = 0;
  let any = false;
  for (const path of transcriptsIn(dir)) {
    for (const row of parseFile(path, rules)) {
      if (row.turns === 0) continue;
      any = true;
      costUsd += row.cost;
      tokens += row.read + row.write + row.output;
    }
  }
  return any ? { costUsd, tokens } : null;
}

const NEWLINE = 0x0a;

/** Lê de `offset` até o fim do arquivo e devolve só as linhas completas (o que o agente ainda está escrevendo fica para o próximo ciclo). */
function readIncrement(path: string, offset: number, size: number): { text: string; bytes: number } {
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(path, "r");
  try {
    let got = 0;
    while (got < buffer.length) {
      const n = readSync(fd, buffer, got, buffer.length - got, offset + got);
      if (n === 0) break;
      got += n;
    }
    const end = buffer.subarray(0, got).lastIndexOf(NEWLINE) + 1;
    return { text: buffer.subarray(0, end).toString("utf8"), bytes: end };
  } finally {
    closeSync(fd);
  }
}

/** Por arquivo; lido de disco pelo chamador, então cada entrada é conferida antes de valer. */
export type CostCache = Record<string, unknown>;

function validFileCost(value: unknown): value is FileCost {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Number.isInteger(v.offset) && (v.offset as number) >= 0 && typeof v.costUsd === "number" && Array.isArray(v.ids);
}

/**
 * Custo real corrente de um worktree, somando os transcripts da pasta do projeto no Claude. O cache (por arquivo) guarda
 * o offset já lido: cada chamada lê só o acréscimo; arquivo que encolheu recomeça do zero. O cache é do chamador
 * (o watch o persiste, o painel o guarda em memória). Devolve o custo e quantos bytes novos foram lidos.
 */
export function currentCost(worktree: string, cache: CostCache, projectsDir: string = join(home(), ".claude", "projects")): { costUsd: number; read: number } {
  if (worktree === "") return { costUsd: 0, read: 0 };
  let read = 0;
  let costUsd = 0;
  for (const path of transcriptsIn(join(projectsDir, encodeCwd(worktree)))) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    const known = cache[path];
    let state = validFileCost(known) ? known : emptyFileCost();
    if (size < state.offset) state = emptyFileCost();
    if (size > state.offset) {
      const increment = readIncrement(path, state.offset, size);
      state = addTranscriptText(state, increment.text, increment.bytes);
      read += increment.bytes;
    }
    cache[path] = state;
    costUsd += state.costUsd;
  }
  return { costUsd, read };
}

function git(repo: string, args: string[]): { ok: boolean; stdout: string } {
  const r = run("git", ["-C", repo, ...args], { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, stdout: r.stdout };
}

/**
 * Tamanho real: arquivos distintos e linhas (adicionadas + removidas) dos commits da própria branch (primeiro pai,
 * sem merges) entre o início e o fim da unidade. Funciona também depois do merge, quando `base...branch` esvaziou.
 * null se a branch não existe mais.
 */
function sizeOf(repo: string, branch: string, since: string, until: string): { files: number; lines: number } | null {
  if (branch === "" || !git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) return null;
  const range = [...(since ? [`--since=${since}`] : []), ...(until ? [`--until=${until}`] : [])];
  const log = git(repo, ["log", "--first-parent", "--no-merges", "--numstat", "--format=", ...range, `refs/heads/${branch}`]);
  if (!log.ok) return null;
  const files = new Set<string>();
  let lines = 0;
  for (const line of log.stdout.split("\n")) {
    const [added, removed, ...path] = line.split("\t");
    if (path.length === 0 || added === undefined || removed === undefined) continue;
    files.add(path.join("\t"));
    lines += (/^\d+$/.test(added) ? Number(added) : 0) + (/^\d+$/.test(removed) ? Number(removed) : 0);
  }
  return { files: files.size, lines };
}

function gateJournals(base: string, roots: readonly string[]): string[] {
  return [join(base, ROOT_MAQUINA), ...roots.map((r) => join(base, r))].map((d) => readText(join(d, "locks", "gate-journal.tsv")) ?? "").filter((t) => t !== "");
}

/** Todas as unidades encerradas de raiz real, com o medido; só leitura. */
export function collectHistory(params: Params, now: Date = new Date(), windowDays: number = intKey("HADES_MOIRAI_WINDOW_DAYS", 90)): HistoryUnit[] {
  const base = workRoot();
  const roots = rootsOf(base);
  const journals = gateJournals(base, roots);
  const units: HistoryUnit[] = [];
  for (const root of roots) {
    for (const record of recordsOf(base, root)) {
      const name = typeof record.name === "string" ? record.name : "";
      const worktree = typeof (record as { worktree?: unknown }).worktree === "string" ? (record as { worktree: string }).worktree : "";
      const branch = typeof (record as { branch?: unknown }).branch === "string" ? (record as { branch: string }).branch : "";
      const usage = usageOf(worktree);
      if (!isRealUnit(record, usage !== null, worktree !== "" && isDir(worktree))) continue;
      const gate = gateOfLabel(journals, name);
      const repo = modeOf(record.mode) === "skill" ? skillRoot : worktree;
      const created = String(record.createdAt ?? record.adoptedAt ?? "");
      const done = String(record.doneAt ?? record.archivedAt ?? "");
      const size = repo !== "" && isDir(repo) ? sizeOf(repo, branch, created, done) : null;
      const measured: Measured = {
        costUsd: usage?.costUsd ?? null, tokens: usage?.tokens ?? null, gateS: gate.gateS, gatePeakMb: gate.peakMb,
        files: size?.files ?? null, lines: size?.lines ?? null,
      };
      units.push(historyUnit(record, root, measured, params));
    }
  }
  return inWindow(dedupe(units), now, windowDays);
}

// ---------------------------------------------------------------- --deep

export type DeepRunner = (prompt: string) => string | null;

function claudeRunner(): DeepRunner {
  const model = configValue("HADES_MODEL_ORCHESTRATOR", "claude-opus-5-5");
  const bin = configValue("HADES_CHAT_BIN", "") || "claude";
  const timeoutMs = Math.max(1, intKey("HADES_MOIRAI_DEEP_TIMEOUT_S", 180)) * 1000;
  return (prompt) => {
    const r = run(bin, ["-p", "--model", model, "--allowedTools", "Read Grep Glob", prompt], { cwd: skillRoot, timeoutMs, maxBuffer: 8 << 20 });
    if (r.timedOut) warn(`moirai --deep: o estimador passou de ${timeoutMs / 1000}s (HADES_MOIRAI_DEEP_TIMEOUT_S)`);
    return r.status === 0 ? r.stdout : null;
  };
}

/** A resposta do estimador tem de trazer {"lines": N}; qualquer outra coisa é descartada com aviso, nunca vira número. */
export function parseDeepAnswer(answer: string): number | null {
  const match = /\{[^{}]*"lines"\s*:\s*(\d+)[^{}]*\}/.exec(answer);
  const lines = match ? Number(match[1]) : NaN;
  return Number.isInteger(lines) && lines > 0 && lines <= DEEP_MAX_LINES ? lines : null;
}

export function deepHints(units: readonly PlanUnit[], runner: DeepRunner): Map<string, number> {
  const hints = new Map<string, number>();
  for (const unit of units) {
    const prompt = `Estime o tamanho de implementação (linhas adicionadas + removidas no diff) desta unidade de um plano. Leia o código que o escopo cita, se precisar. Responda só com um JSON {"lines": <inteiro>}.\n\nUnidade: ${unit.name}\nPapel: ${unit.role}\nEscopo:\n${unit.scope}`;
    const lines = parseDeepAnswer(runner(prompt) ?? "");
    if (lines === null) warn(`moirai --deep: sem resposta utilizável para ${unit.name}; fica o tamanho do escopo`);
    else hints.set(unit.name, lines);
  }
  return hints;
}

// ---------------------------------------------------------------- comandos

function history(args: string[]): number {
  const json = args.includes("--json");
  const unknown = args.filter((a) => a !== "--json");
  if (unknown.length > 0) die(`argumento desconhecido: ${unknown.join(" ")}\n${USAGE}`);
  const units = collectHistory(loadParams());
  if (json) out(JSON.stringify({ v: 1, units }, null, 1));
  else out(historyLines(units).join("\n"));
  return EXIT.ok;
}

function textOf(plan: string, estimates: readonly UnitEstimate[]): string[] {
  const lines = [`estimativa de ${plan}`, `| ${TABLE_HEADER.join(" | ")} |`, ...estimates.map((e) => `| ${estimateRow(e).join(" | ")} |`)];
  for (const e of estimates) {
    if (e.confidence === "baixa" || e.confidence === "nenhuma") lines.push(`CONFIANÇA ${e.confidence.toUpperCase()} em ${e.unit}: ${e.note}`);
  }
  return lines;
}

function estimate(args: string[]): number {
  let plan = "";
  let mode: Mode | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--mode") {
      const value = args[(i += 1)];
      if (value !== "skill" && value !== "projeto") die(`--mode: skill ou projeto\n${USAGE}`);
      mode = value;
    } else if (["--write", "--deep", "--json"].includes(arg)) flags.add(arg);
    else if (arg.startsWith("-") || plan !== "") die(`argumento desconhecido: ${arg}\n${USAGE}`);
    else plan = arg;
  }
  if (plan === "") die(`faltou o plan.md\n${USAGE}`);
  if (!isFile(plan)) die(`plano não encontrado: ${plan}`);
  const path = realpathMissingOk(plan);
  const text = readText(path) ?? "";
  const units = planUnits(text);
  if (units.length === 0) die(`${path}: sem tabela em "## Unidades" (colunas Unidade, Papel e Escopo ou Specs); nada a estimar`);
  const planMode: Mode = mode ?? (path.startsWith(`${join(hadesHome(), "plans")}/`) ? "skill" : "projeto");
  const params = loadParams();
  const hist = collectHistory(params);
  const hints = flags.has("--deep") ? deepHints(units, claudeRunner()) : new Map<string, number>();
  const estimates = estimatePlan(units, planMode, hist, params, hints);
  const now = new Date();
  if (flags.has("--write")) {
    const section = renderSection({ date: now.toISOString().slice(0, 10), estimates, historySize: hist.length, windowDays: intKey("HADES_MOIRAI_WINDOW_DAYS", 90), params });
    writeFileSync(path, writeSection(text, section));
    warn(`moirai: seção "## Estimativa" gravada em ${path}${hasSection(text) ? " (substituiu a anterior)" : ""}; está dentro do hash da aprovação: aprove de novo (hades agent plan-approve)`);
  }
  if (flags.has("--json")) out(JSON.stringify(estimateJson(path, now.toISOString(), estimates, params, hist.length), null, 1));
  else out(textOf(path, estimates).join("\n"));
  return EXIT.ok;
}

export function moiraiCommand(args: string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "history": return history(rest);
    case "estimate": return estimate(rest);
    default:
      out(USAGE);
      return sub === "-h" || sub === "--help" ? EXIT.ok : EXIT.usage;
  }
}
