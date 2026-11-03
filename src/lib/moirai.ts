// Moirai: estimativa de custo e duração por unidade de um plano, a partir do histórico das unidades encerradas.
// Regra pura (sem disco, sem relógio, sem modelo): a borda em commands/moirai.ts lê registros, transcripts e git e
// entrega aqui. Formato da seção `## Estimativa` e do JSON: reference/moirai.md (contrato, só cresce).

import { cost as requestCost, modelKey } from "./usage.ts";

export const JSON_VERSION = 1;
export const SECTION_TITLE = "Estimativa";

/** Linhas por arquivo quando o escopo declara só arquivos ("~5 arquivos"). */
export const LINES_PER_FILE = 60;

export type Mode = "skill" | "projeto";
export type Band = "pequena" | "media" | "grande";
export type Confidence = "alta" | "media" | "baixa" | "nenhuma";
export type Basis = "parecidas" | "tamanho" | "geral" | "sem-historico";

export interface Params {
  /** Amostra mínima de parecidas; abaixo disso a confiança é baixa e a regra cai para o tamanho. */
  minSample: number;
  /** Uma amostra de `highFactor` × mínima ou mais tem confiança alta. */
  highFactor: number;
  /** Até estas linhas de diff: pequena; a partir de `largeLines`: grande. */
  smallLines: number;
  largeLines: number;
}

export interface HistoryUnit {
  name: string;
  root: string;
  mode: Mode;
  role: string;
  state: string;
  createdAt: string;
  doneAt: string;
  costUsd: number | null;
  tokens: number | null;
  wallS: number | null;
  gateS: number;
  gatePeakMb: number | null;
  clears: number;
  /** Retomadas (`hades agent resume`): null em registro anterior ao campo. */
  resumes: number | null;
  files: number | null;
  lines: number | null;
  band: Band | null;
}

export interface Spread {
  n: number;
  p25: number;
  median: number;
  p75: number;
}

export interface UnitEstimate {
  unit: string;
  role: string;
  mode: Mode;
  declaredLines: number | null;
  band: Band | null;
  basis: Basis;
  sample: number;
  confidence: Confidence;
  costUsd: Spread | null;
  wallMin: Spread | null;
  gateMin: Spread | null;
  tokens: Spread | null;
  note: string;
}

export interface PlanUnit {
  name: string;
  role: string;
  scope: string;
}

// ---------------------------------------------------------------- estatística

/** Quantil por interpolação linear entre vizinhos (método 7); a lista tem de vir ordenada e não vazia. */
export function quantile(sorted: readonly number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return (sorted[low] as number) + ((sorted[high] as number) - (sorted[low] as number)) * (at - low);
}

export function spread(values: readonly (number | null)[]): Spread | null {
  const sorted = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return { n: sorted.length, p25: quantile(sorted, 0.25), median: quantile(sorted, 0.5), p75: quantile(sorted, 0.75) };
}

const scaled = (s: Spread | null, factor: number): Spread | null =>
  s === null ? null : { n: s.n, p25: s.p25 * factor, median: s.median * factor, p75: s.p75 * factor };

// ---------------------------------------------------------------- tamanho

export function bandOf(lines: number, params: Pick<Params, "smallLines" | "largeLines">): Band {
  if (lines < params.smallLines) return "pequena";
  return lines >= params.largeLines ? "grande" : "media";
}

/** Tamanho declarado no escopo: "~300 linhas" ou "5 arquivos" (arquivos valem LINES_PER_FILE linhas); null se não declara. */
export function declaredLines(scope: string): number | null {
  const lines = /(\d[\d.]*)\s*linhas/i.exec(scope);
  if (lines) return Number((lines[1] as string).replaceAll(".", ""));
  const files = /(\d+)\s*arquivos/i.exec(scope);
  return files ? Number(files[1]) * LINES_PER_FILE : null;
}

// ---------------------------------------------------------------- registro → unidade do histórico

export interface RawRecord {
  name?: unknown;
  mode?: unknown;
  role?: unknown;
  state?: unknown;
  createdAt?: unknown;
  adoptedAt?: unknown;
  doneAt?: unknown;
  archivedAt?: unknown;
  clears?: unknown;
  resumes?: unknown;
}

export interface Measured {
  costUsd: number | null;
  tokens: number | null;
  gateS: number;
  gatePeakMb: number | null;
  files: number | null;
  lines: number | null;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

export const isEnded = (record: RawRecord): boolean => record.state === "done" || record.state === "archived";

/**
 * Critério de raiz real: a unidade entra no histórico se está encerrada (done/archived) e deixou rastro de trabalho
 * de verdade, isto é, transcript com custo ou worktree ainda existente. Registro de fixture de teste não tem nenhum
 * dos dois e fica de fora (a raiz inteira some junto, sem lista de nomes).
 */
export function isRealUnit(record: RawRecord, hasTranscript: boolean, worktreeExists: boolean): boolean {
  return isEnded(record) && str(record.name) !== "" && (hasTranscript || worktreeExists);
}

export function seconds(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isNaN(a) || Number.isNaN(b) || b < a ? null : (b - a) / 1000;
}

export function modeOf(mode: unknown): Mode {
  return mode === "skill" ? "skill" : "projeto";
}

export function historyUnit(record: RawRecord, root: string, measured: Measured, params: Pick<Params, "smallLines" | "largeLines">): HistoryUnit {
  const createdAt = str(record.createdAt) || str(record.adoptedAt);
  const doneAt = str(record.doneAt) || str(record.archivedAt);
  return {
    name: str(record.name),
    root,
    mode: modeOf(record.mode),
    role: str(record.role) || "impl",
    state: str(record.state),
    createdAt,
    doneAt,
    costUsd: measured.costUsd,
    tokens: measured.tokens,
    wallS: seconds(createdAt, doneAt),
    gateS: measured.gateS,
    gatePeakMb: measured.gatePeakMb,
    clears: count(record.clears) ?? 0,
    resumes: count(record.resumes),
    files: measured.files,
    lines: measured.lines,
    band: measured.lines === null || measured.lines === 0 ? null : bandOf(measured.lines, params),
  };
}

/** Mesma unidade vista em duas raízes (skill-new grava em _skill e o clone pode guardar cópia): fica a de doneAt mais novo. */
export function dedupe(units: readonly HistoryUnit[]): HistoryUnit[] {
  const best = new Map<string, HistoryUnit>();
  for (const unit of units) {
    const key = `${unit.name}\t${unit.createdAt}`;
    const seen = best.get(key);
    if (!seen || unit.doneAt > seen.doneAt) best.set(key, unit);
  }
  return [...best.values()].sort((a, b) => (a.doneAt < b.doneAt ? -1 : a.doneAt > b.doneAt ? 1 : a.name < b.name ? -1 : 1));
}

/** Janela do histórico: só unidades encerradas nos últimos `days` dias antes de `now` (days 0 = tudo). */
export function inWindow(units: readonly HistoryUnit[], now: Date, days: number): HistoryUnit[] {
  if (days <= 0) return [...units];
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  return units.filter((u) => u.doneAt >= since);
}

/** Pico e tempo de gate de um label no histórico do gate-lock (linhas `done`: ts, done, kind, label, cost, wt, rc, dur=, peak=). */
export function gateOfLabel(journals: readonly string[], label: string): { gateS: number; peakMb: number | null } {
  const seen = new Set<string>();
  let gateS = 0;
  let peak: number | null = null;
  for (const journal of journals) {
    for (const line of journal.split("\n")) {
      const fields = line.split("\t");
      if (fields[1] !== "done" || fields[3] !== label || seen.has(line)) continue;
      seen.add(line);
      for (const field of fields.slice(2)) {
        const dur = /^dur=(\d+)s$/.exec(field);
        if (dur) gateS += Number(dur[1]);
        const mb = /^peak=(\d+)MB$/.exec(field);
        if (mb) peak = Math.max(peak ?? 0, Number(mb[1]));
      }
    }
  }
  return { gateS, peakMb: peak };
}

// ---------------------------------------------------------------- plano

const cells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isRule = (line: string): boolean => /^\|?\s*:?-{2,}/.test(line.trim());
const stripTicks = (text: string): string => text.replaceAll("`", "").trim();

/** Linhas da tabela de `## Unidades` (colunas Unidade, Papel e Escopo ou Specs); vazio se o plano não tem a tabela. */
export function planUnits(planText: string): PlanUnit[] {
  const lines = planText.replaceAll("\r", "").split("\n");
  let inFence = false;
  let inUnits = false;
  let header: string[] | null = null;
  const units: PlanUnit[] = [];
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (line.startsWith("## ")) {
      inUnits = /^## Unidades\s*$/.test(line);
      header = null;
      continue;
    }
    if (!inUnits || !line.trim().startsWith("|")) continue;
    if (header === null) {
      header = cells(line).map((c) => c.toLowerCase());
      continue;
    }
    if (isRule(line)) continue;
    const row = cells(line);
    const col = (names: string[]): number => header?.findIndex((h) => names.includes(h)) ?? -1;
    const unit = col(["unidade"]);
    const role = col(["papel"]);
    const scopeAt = col(["escopo", "specs"]);
    if (unit < 0 || unit >= row.length) continue;
    // a coluna de escopo é a última e pode ter "|" dentro de código: o resto da linha é dela
    const scope = scopeAt < 0 ? "" : scopeAt === (header.length - 1) ? row.slice(scopeAt).join("|") : (row[scopeAt] ?? "");
    units.push({ name: stripTicks(row[unit] as string), role: role < 0 ? "impl" : (stripTicks(row[role] ?? "").toLowerCase() || "impl"), scope });
  }
  return units;
}

// ---------------------------------------------------------------- estimativa

const MIN_PER_S = 1 / 60;

// unidade que nunca passou pelo gate (ou cujo label não é o nome) não informa tempo de gate: zero não entra na mediana
const gateOrNull = (u: HistoryUnit): number | null => (u.gateS > 0 ? u.gateS : null);

function summarize(units: readonly HistoryUnit[]): Pick<UnitEstimate, "costUsd" | "wallMin" | "gateMin" | "tokens"> {
  return {
    costUsd: spread(units.map((u) => u.costUsd)),
    wallMin: scaled(spread(units.map((u) => u.wallS)), MIN_PER_S),
    gateMin: scaled(spread(units.map(gateOrNull)), MIN_PER_S),
    tokens: spread(units.map((u) => u.tokens)),
  };
}

function confidenceOf(n: number, params: Params): Confidence {
  if (n < params.minSample) return "baixa";
  return n >= params.minSample * params.highFactor ? "alta" : "media";
}

/** Por linha de diff: mediana e quartis da taxa de cada métrica entre as unidades com tamanho real. */
function perLine(units: readonly HistoryUnit[], pick: (u: HistoryUnit) => number | null): Spread | null {
  return spread(units.map((u) => {
    const value = pick(u);
    return value === null || u.lines === null || u.lines <= 0 ? null : value / u.lines;
  }));
}


/** Regra só de tamanho: taxa por linha do histórico inteiro × linhas declaradas. */
function bySize(history: readonly HistoryUnit[], lines: number): Pick<UnitEstimate, "costUsd" | "wallMin" | "gateMin" | "tokens"> & { n: number } {
  const sized = history.filter((u) => u.lines !== null && u.lines > 0);
  return {
    n: sized.length,
    costUsd: scaled(perLine(sized, (u) => u.costUsd), lines),
    wallMin: scaled(perLine(sized, (u) => u.wallS), lines * MIN_PER_S),
    gateMin: scaled(perLine(sized, gateOrNull), lines * MIN_PER_S),
    tokens: scaled(perLine(sized, (u) => u.tokens), lines),
  };
}

export function estimateUnit(unit: PlanUnit, mode: Mode, history: readonly HistoryUnit[], params: Params, sizeHint: number | null = null): UnitEstimate {
  const lines = declaredLines(unit.scope) ?? sizeHint;
  const band = lines === null ? null : bandOf(lines, params);
  const base = { unit: unit.name, role: unit.role, mode, declaredLines: lines, band };
  const similar = history.filter((u) => u.role === unit.role && u.mode === mode && (band === null || u.band === band));
  if (similar.length >= params.minSample) {
    // sem tamanho declarado, "parecidas" é só papel e modo: um prior largo, nunca confiança alta
    const confidence = band === null && confidenceOf(similar.length, params) === "alta" ? "media" : confidenceOf(similar.length, params);
    const sizeNote = band === null ? "; escopo sem tamanho declarado (use \"~N linhas\" ou \"N arquivos\")" : "";
    return { ...base, basis: "parecidas", sample: similar.length, confidence, ...summarize(similar), note: `${similar.length} parecidas (${unit.role}, ${mode}${band ? `, ${band}` : ""})${sizeNote}` };
  }
  const why = `só ${similar.length} parecida${similar.length === 1 ? "" : "s"} (${unit.role}, ${mode}${band ? `, ${band}` : ""}), mínimo ${params.minSample}`;
  if (lines !== null) {
    const size = bySize(history, lines);
    if (size.costUsd !== null || size.wallMin !== null) {
      return { ...base, basis: "tamanho", sample: size.n, confidence: "baixa", costUsd: size.costUsd, wallMin: size.wallMin, gateMin: size.gateMin, tokens: size.tokens, note: `${why}; regra só de tamanho: ${lines} linhas × taxa de ${size.n} unidades` };
    }
  }
  if (history.length > 0) {
    return { ...base, basis: "geral", sample: history.length, confidence: "baixa", ...summarize(history), note: `${why}; sem tamanho declarado no escopo: mediana de todo o histórico (${history.length} unidades)` };
  }
  return { ...base, basis: "sem-historico", sample: 0, confidence: "nenhuma", costUsd: null, wallMin: null, gateMin: null, tokens: null, note: "sem histórico de unidades encerradas" };
}

export function estimatePlan(units: readonly PlanUnit[], mode: Mode, history: readonly HistoryUnit[], params: Params, sizeHints: ReadonlyMap<string, number> = new Map()): UnitEstimate[] {
  return units.map((u) => estimateUnit(u, mode, history, params, sizeHints.get(u.name) ?? null));
}

// ---------------------------------------------------------------- seção `## Estimativa` (contrato)

export const TABLE_HEADER = [
  "Unidade", "Custo p25 (US$)", "Custo mediana (US$)", "Custo p75 (US$)", "Duração p25 (min)", "Duração mediana (min)",
  "Duração p75 (min)", "Gate mediana (min)", "Amostra", "Confiança", "Base",
] as const;

const money = (n: number): string => n.toFixed(2);
const minutes = (n: number): string => n.toFixed(0);
const dash = "—";

export function estimateRow(e: UnitEstimate): string[] {
  const c = e.costUsd;
  const w = e.wallMin;
  return [
    e.unit, c ? money(c.p25) : dash, c ? money(c.median) : dash, c ? money(c.p75) : dash,
    w ? minutes(w.p25) : dash, w ? minutes(w.median) : dash, w ? minutes(w.p75) : dash,
    e.gateMin ? minutes(e.gateMin.median) : dash, String(e.sample), e.confidence, e.basis,
  ];
}

export interface SectionInput {
  date: string;
  estimates: readonly UnitEstimate[];
  historySize: number;
  windowDays: number;
  params: Params;
}

export function renderSection(input: SectionInput): string {
  const { estimates, params } = input;
  const out = [
    `## ${SECTION_TITLE}`,
    "<!-- gerada por `hades moirai estimate --write`; fica dentro do hash da aprovação: reestimar pede nova aprovação -->",
    `Gerada em ${input.date} · histórico: ${input.historySize} unidades encerradas${input.windowDays > 0 ? ` (últimos ${input.windowDays} dias)` : ""} · amostra mínima ${params.minSample} · p25–p75 = faixa, o teto de custo da execução é o p75`,
    "",
    `| ${TABLE_HEADER.join(" | ")} |`,
    `|${TABLE_HEADER.map(() => "---").join("|")}|`,
    ...estimates.map((e) => `| ${estimateRow(e).join(" | ")} |`),
  ];
  const lows = estimates.filter((e) => e.confidence === "baixa" || e.confidence === "nenhuma" || e.declaredLines === null);
  if (lows.length > 0) {
    out.push("", ...lows.map((e) => `- **Confiança ${e.confidence}** em \`${e.unit}\`: ${e.note}.`));
  }
  return `${out.join("\n")}\n`;
}

/** Troca a seção `## Estimativa` (ou a acrescenta no fim); o resto do plano fica byte a byte igual. */
export function writeSection(planText: string, section: string): string {
  const lines = planText.split("\n");
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence || !line.startsWith("## ")) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (new RegExp(`^## ${SECTION_TITLE}\\s*$`).test(line)) start = i;
  }
  if (start < 0) return `${planText.replace(/\n*$/, "\n")}\n${section}`;
  const tail = lines.slice(end).join("\n");
  return `${lines.slice(0, start).join("\n")}\n${section}${tail === "" ? "" : `\n${tail}`}`;
}

export function hasSection(planText: string): boolean {
  let inFence = false;
  for (const line of planText.replaceAll("\r", "").split("\n")) {
    if (/^```/.test(line)) inFence = !inFence;
    if (!inFence && new RegExp(`^## ${SECTION_TITLE}\\s*$`).test(line)) return true;
  }
  return false;
}

/** Lê de volta a tabela da seção (a moirai-real usa isto): uma linha por unidade, números ou null onde há "—". */
export function parseSection(planText: string): Array<{ unit: string; costP25: number | null; costMedian: number | null; costP75: number | null; wallP25: number | null; wallMedian: number | null; wallP75: number | null; gateMedian: number | null; sample: number; confidence: string; basis: string }> {
  const lines = planText.replaceAll("\r", "").split("\n");
  const at = lines.findIndex((l) => new RegExp(`^## ${SECTION_TITLE}\\s*$`).test(l));
  if (at < 0) return [];
  const rows: ReturnType<typeof parseSection> = [];
  const num = (cell: string | undefined): number | null => (cell === undefined || cell === dash || Number.isNaN(Number(cell)) ? null : Number(cell));
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.trim().startsWith("|") || isRule(line)) continue;
    const row = cells(line);
    if (row[0] === TABLE_HEADER[0]) continue;
    rows.push({
      unit: row[0] ?? "", costP25: num(row[1]), costMedian: num(row[2]), costP75: num(row[3]), wallP25: num(row[4]), wallMedian: num(row[5]),
      wallP75: num(row[6]), gateMedian: num(row[7]), sample: Number(row[8] ?? 0), confidence: row[9] ?? "", basis: row[10] ?? "",
    });
  }
  return rows;
}

// ---------------------------------------------------------------- JSON (contrato)

export function estimateJson(plan: string, generatedAt: string, estimates: readonly UnitEstimate[], params: Params, historySize: number): Record<string, unknown> {
  return { v: JSON_VERSION, plan, generatedAt, params: { minSample: params.minSample }, history: { units: historySize }, units: estimates };
}

// ---------------------------------------------------------------- texto de `hades moirai history`

const pad = (value: string, width: number, right = false): string => (right ? value.padStart(width) : value.padEnd(width));

export function historyLines(units: readonly HistoryUnit[]): string[] {
  const head = `${pad("unidade", 26)}${pad("papel", 12)}${pad("modo", 8)}${pad("custo", 8, true)}${pad("tokens", 9, true)}${pad("relógio", 9, true)}${pad("gate", 7, true)}${pad("pico", 8, true)}${pad("clr", 4, true)}${pad("arq", 5, true)}${pad("linhas", 8, true)}  tam`;
  const num = (v: number | null, f: (n: number) => string): string => (v === null ? dash : f(v));
  return [
    head,
    ...units.map((u) =>
      pad(u.name.slice(0, 25), 26) + pad(u.role, 12) + pad(u.mode, 8)
      + pad(num(u.costUsd, (n) => `$${n.toFixed(2)}`), 8, true)
      + pad(num(u.tokens, (n) => `${(n / 1e6).toFixed(1)}M`), 9, true)
      + pad(num(u.wallS, (n) => `${(n / 60).toFixed(0)}m`), 9, true)
      + pad(`${(u.gateS / 60).toFixed(0)}m`, 7, true)
      + pad(num(u.gatePeakMb, (n) => `${(n / 1024).toFixed(1)}G`), 8, true)
      + pad(String(u.clears), 4, true)
      + pad(num(u.files, String), 5, true)
      + pad(num(u.lines, String), 8, true)
      + `  ${u.band ?? dash}`),
  ];
}

// ---------------------------------------------------------------- execução: real × estimado (moirai-real)

export const DEFAULT_WARN_PCT = 100;
export const DEFAULT_ASK_PCT = 150;

export type BudgetLevel = "ok" | "warn" | "ask";

export interface Budget {
  /** custo real como % do p75; null sem estimativa utilizável */
  pct: number | null;
  warn: boolean;
  ask: boolean;
  level: BudgetLevel;
}

/** Teto da execução: o custo real contra o p75 da estimativa. Sem p75 (ausente ou zero) nada passa de limiar. */
export function budgetOf(costUsd: number, p75: number | null, warnPct: number, askPct: number): Budget {
  if (p75 === null || !(p75 > 0)) return { pct: null, warn: false, ask: false, level: "ok" };
  const pct = (costUsd / p75) * 100;
  const warn = pct >= warnPct;
  const ask = pct >= askPct;
  return { pct, warn, ask, level: ask ? "ask" : warn ? "warn" : "ok" };
}

export interface EstimateRow {
  unit: string;
  costP25: number | null;
  costMedian: number | null;
  costP75: number | null;
  wallP25: number | null;
  wallMedian: number | null;
  wallP75: number | null;
  gateMedian: number | null;
  sample: number;
  confidence: string;
  basis: string;
}

/** A linha da unidade na seção `## Estimativa` do plano; undefined se o plano não a tem. */
export function estimateOfUnit(planText: string, unit: string): EstimateRow | undefined {
  return parseSection(planText).find((row) => row.unit === unit);
}

/** Próximo número de pergunta de um `questions.md` (cabeçalhos `## Q<n>`). */
export function nextQuestionNumber(questionsText: string): number {
  const numbers = [...questionsText.matchAll(/^## Q(\d+)/gm)].map((m) => Number(m[1]));
  return Math.max(0, ...numbers) + 1;
}

export interface BudgetQuestionInput {
  number: number;
  unit: string;
  phase: string;
  costUsd: number;
  p75: number;
  pct: number;
  askPct: number;
}

/** Pergunta do limiar já gravada para a fase (aberta ou respondida): a resposta do dono vale para o limiar, não se repete. */
export function hasBudgetQuestion(questionsText: string, askPct: number, phase: string): boolean {
  const title = `custo passou de ${askPct}% do estimado`;
  return questionsText.split(/^(?=## Q\d+)/m).some((block) => block.startsWith("## Q") && block.split("\n")[0]?.includes(title) && block.includes(`(fase ${phase || "—"})`));
}

/** Pergunta ao dono quando o custo passa do limiar de pergunta; respondida pelo `hades agent answer` de sempre. */
export function budgetQuestion(q: BudgetQuestionInput): string {
  return [
    `## Q${q.number} — custo passou de ${q.askPct}% do estimado`,
    "",
    `Contexto: ${q.unit} (fase ${q.phase || "—"}) já gastou US$ ${q.costUsd.toFixed(2)}, ${Math.floor(q.pct)}% do p75 da estimativa do plano (US$ ${q.p75.toFixed(2)}). O agente segue trabalhando até a resposta.`,
    "",
    "Alternativas:",
    "1. Seguir: o escopo é esse mesmo e o custo vale.",
    "2. Reestimar: o plano subestimou; rode `hades moirai estimate <plano> --write` e aprove de novo.",
    "3. Estacionar: parar a unidade e rever o escopo.",
    "",
    "Recomendação: se o diff está dentro do escopo do brief, seguir; se o escopo cresceu, reestimar; se o custo vem de retrabalho, estacionar.",
    "",
  ].join("\n");
}

/** Custo já lido de um transcript: até onde (bytes), quanto custou e os pedidos já somados (um pedido tem várias linhas). */
export interface FileCost {
  offset: number;
  costUsd: number;
  ids: string[];
}

export const emptyFileCost = (): FileCost => ({ offset: 0, costUsd: 0, ids: [] });

/**
 * Soma ao `prev` o custo das linhas completas de `text` (o acréscimo do transcript). Mesma regra do `hades usage`:
 * um pedido conta uma vez pelo `requestId` (ou `message.id`), com o `usage` da primeira linha, e sem modelo conhecido ou
 * sem horário não custa. `offset` é do chamador, que sabe quantos bytes o texto consumiu.
 */
export function addTranscriptText(prev: FileCost, text: string, bytes: number): FileCost {
  const seen = new Set(prev.ids);
  let costUsd = prev.costUsd;
  const ids = [...prev.ids];
  for (const raw of text.split("\n")) {
    if (!raw.includes('"assistant"')) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof line !== "object" || line === null) continue;
    const row = line as Record<string, unknown>;
    if (row.type !== "assistant") continue;
    const message = typeof row.message === "object" && row.message !== null ? (row.message as Record<string, unknown>) : {};
    const usage = typeof message.usage === "object" && message.usage !== null && !Array.isArray(message.usage) ? (message.usage as Record<string, unknown>) : undefined;
    const key = modelKey(message.model);
    if (usage === undefined || Object.keys(usage).length === 0 || key === undefined || typeof row.timestamp !== "string" || row.timestamp === "") continue;
    const id = str(row.requestId) || str(message.id);
    if (id !== "") {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    costUsd += requestCost(key, usage)[0];
  }
  return { offset: prev.offset + bytes, costUsd, ids };
}
