// Thanatos: post-mortem de incidente e bug em produção do projeto (reference/thanatos.md). Este módulo é puro e de
// armazenamento: entrada, montagem da linha do tempo, render em markdown, gravação em <work>/postmortems/ e a consulta
// "este arquivo já foi citado em post-mortem?". Git, gh, plugin e relógio entram por parâmetro (thanatos-gather.ts,
// thanatos-source.ts e o comando).
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isFile, readText } from "./fs.ts";
import { EXIT, HadesError } from "./output.ts";

export const THANATOS_VERSION = 1;
export const ID_PATTERN = /^[A-Za-z0-9][\w.-]{0,79}$/;
const PR_INPUT = /^#?(\d+)$/;
const INTERVAL_SEPARATOR = "..";
const SHORT_SHA = 12;
const SEARCH_SNIPPET_MAX = 160;
const SECTION_NAMES = {
  impact: ["impacto", "impact", "impacto no usuário", "user impact"],
  cause: ["causa", "causa raiz", "causa-raiz", "cause", "root cause"],
  fix: ["correção", "como foi corrigido", "solução", "fix", "solution", "resolution"],
};

export type Input =
  | { kind: "pr"; number: number }
  | { kind: "range"; from: string; to: string }
  | { kind: "card"; id: string };

export interface CommitFact { sha: string; subject: string; author: string; ts: string }
export interface ReviewFact { author: string; ts: string; state: string }
export interface PrFact {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  branch: string;
  labels: string[];
  createdAt: string;
  mergedAt: string | null;
  state: string;
  commits: CommitFact[];
  files: string[];
  reviews: ReviewFact[];
}
export interface Gathered { prs: PrFact[]; commits: CommitFact[] }

export type SourceStatus = "ok" | "absent" | "no-token" | "error";
export interface SourceEvent { ts: string; text: string; level?: string }
export interface SourceMetric { name: string; value: number; unit?: string; ts?: string }
export interface SourceResult {
  status: SourceStatus;
  /** o que faltou ou o que veio, uma frase */
  note: string;
  events: SourceEvent[];
  metrics: SourceMetric[];
  /** início do incidente, quando a fonte sabe (ISO UTC) */
  start?: string;
}
export interface JournalFact { ts: string; agent: string; kind: string; summary: string }

export type TimelineSource = "git" | "gh" | "diario" | "fonte";
export interface TimelineEntry { ts: string; source: TimelineSource; text: string }

export interface TimeToFix { ms: number; from: string; to: string; basis: "fonte" | "intervalo" | "primeiro-commit" | "abertura-da-pr" }
export interface FixData {
  prs: { number: number; title: string; author: string; url: string; branch: string; mergedAt: string | null }[];
  commits: CommitFact[];
  files: string[];
  authors: string[];
  timeToFix: TimeToFix | null;
}

/** Contrato versionado (`v`): campo novo só se acrescenta; mudar o sentido de um campo é `v` novo. */
export interface Postmortem {
  v: number;
  id: string;
  input: Input;
  createdAt: string;
  title: string;
  summary: string;
  impact: string;
  timeline: TimelineEntry[];
  cause: string;
  fix: string;
  fixData: FixData;
  source: { status: SourceStatus; note: string; metrics: SourceMetric[] };
  gaps: string[];
}

// ------------------------------------------------------------------ entrada

const usage = (message: string): never => {
  throw new HadesError(message, EXIT.usage);
};

/** Instante ISO com fuso → UTC `…Z` sem milissegundos zerados; texto sem fuso não é lido como hora local. */
export function toUtc(text: string): string | undefined {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text.trim())) return undefined;
  const at = Date.parse(text.trim());
  return Number.isNaN(at) ? undefined : new Date(at).toISOString().replace(".000Z", "Z");
}

/** PR (`123` ou `#123`), intervalo `<iso>..<iso>` (com fuso) ou id de card (pelo idPattern do perfil, sem caixa). */
export function parseInput(text: string, cardPattern?: string): Input {
  const raw = text.trim();
  const pr = PR_INPUT.exec(raw);
  if (pr) return { kind: "pr", number: Number(pr[1]) };
  const cut = raw.indexOf(INTERVAL_SEPARATOR);
  if (cut > 0) {
    const from = toUtc(raw.slice(0, cut));
    const to = toUtc(raw.slice(cut + INTERVAL_SEPARATOR.length));
    if (from === undefined || to === undefined) return usage(`intervalo não entendido: ${raw} (use <iso>..<iso>, cada ponta com Z ou fuso)`);
    if (Date.parse(from) >= Date.parse(to)) return usage(`intervalo vazio ou invertido: ${raw}`);
    return { kind: "range", from, to };
  }
  if (cardPattern !== undefined && cardPattern !== "") {
    let matches = false;
    try {
      matches = new RegExp(`^(?:${cardPattern})$`, "i").test(raw);
    } catch {
      matches = false;
    }
    if (matches) return { kind: "card", id: raw };
  }
  return usage(`entrada não entendida: ${raw} (número de PR, id de card do perfil ou intervalo <iso>..<iso>)`);
}

const slugPart = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const compact = (iso: string): string => iso.replace(/[-:]/g, "");

/** Id estável do post-mortem (nome do arquivo): `pr-<n>`, `card-<id>` ou `range-<de>-<ate>`. */
export function idOf(input: Input): string {
  if (input.kind === "pr") return `pr-${input.number}`;
  if (input.kind === "card") return `card-${slugPart(input.id)}`;
  return `range-${compact(input.from)}-${compact(input.to)}`;
}

// ------------------------------------------------------------------ montagem

const ms = (iso: string): number => Date.parse(iso);
const unique = (items: string[]): string[] => [...new Set(items.filter((i) => i !== ""))].sort();
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Corpo da seção cujo cabeçalho (`#` a `######`) é um dos nomes, até o próximo cabeçalho; vazio se não há. */
export function sectionOf(body: string, names: string[]): string {
  const lines = body.split("\n");
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const start = lines.findIndex((l) => {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
    return h !== null && wanted.has((h[1] as string).toLowerCase().replace(/[:*_`]/g, "").trim());
  });
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

function timelineOf(gathered: Gathered, source: SourceResult, journal: JournalFact[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const seen = new Set<string>();
  const commit = (c: CommitFact): void => {
    if (seen.has(c.sha.slice(0, SHORT_SHA))) return;
    seen.add(c.sha.slice(0, SHORT_SHA));
    entries.push({ ts: c.ts, source: "git", text: `commit ${c.sha.slice(0, SHORT_SHA)} (${c.author}): ${flat(c.subject)}` });
  };
  for (const pr of gathered.prs) {
    entries.push({ ts: pr.createdAt, source: "gh", text: `PR #${pr.number} aberta por ${pr.author}: ${flat(pr.title)}` });
    for (const c of pr.commits) commit(c);
    for (const r of pr.reviews) entries.push({ ts: r.ts, source: "gh", text: `review em #${pr.number} de ${r.author}: ${r.state}` });
    if (pr.mergedAt) entries.push({ ts: pr.mergedAt, source: "gh", text: `PR #${pr.number} mergeada` });
  }
  for (const c of gathered.commits) commit(c);
  for (const e of journal) entries.push({ ts: e.ts, source: "diario", text: `${e.agent || "-"} ${e.kind}: ${flat(e.summary)}` });
  for (const e of source.events) entries.push({ ts: e.ts, source: "fonte", text: e.level ? `[${e.level}] ${flat(e.text)}` : flat(e.text) });
  const order: Record<TimelineSource, number> = { fonte: 0, git: 1, gh: 2, diario: 3 };
  return entries
    .filter((e) => !Number.isNaN(ms(e.ts)))
    .map((e) => ({ ...e, ts: new Date(ms(e.ts)).toISOString().replace(".000Z", "Z") }))
    .sort((a, b) => ms(a.ts) - ms(b.ts) || order[a.source] - order[b.source] || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}

function timeToFixOf(input: Input, gathered: Gathered, source: SourceResult): TimeToFix | null {
  const merged = gathered.prs.map((p) => p.mergedAt).filter((m): m is string => m !== null).sort((a, b) => ms(a) - ms(b));
  const to = merged[merged.length - 1];
  if (to === undefined) return null;
  const commits = [...gathered.prs.flatMap((p) => p.commits), ...gathered.commits].map((c) => c.ts).sort((a, b) => ms(a) - ms(b));
  const opened = gathered.prs.map((p) => p.createdAt).sort((a, b) => ms(a) - ms(b));
  const start: { at: string | undefined; basis: TimeToFix["basis"] }[] = [
    { at: source.start, basis: "fonte" },
    { at: input.kind === "range" ? input.from : undefined, basis: "intervalo" },
    { at: commits[0], basis: "primeiro-commit" },
    { at: opened[0], basis: "abertura-da-pr" },
  ];
  const pick = start.find((s) => s.at !== undefined && !Number.isNaN(ms(s.at)));
  if (!pick || pick.at === undefined) return null;
  return { ms: Math.max(0, ms(to) - ms(pick.at)), from: new Date(ms(pick.at)).toISOString().replace(".000Z", "Z"), to, basis: pick.basis };
}

const GAP_CAUSE = "causa não declarada nas PRs (seção \"Causa\" ausente): preencher à mão";
const GAP_IMPACT = "impacto não declarado nas PRs (seção \"Impacto\" ausente): preencher à mão";

function fromPrs(prs: PrFact[], names: string[], fallback: string): string {
  const found = prs.map((p) => sectionOf(p.body, names)).filter((s) => s !== "");
  return found.length > 0 ? found.join("\n\n") : fallback;
}

export function buildPostmortem(input: Input, gathered: Gathered, source: SourceResult, journal: JournalFact[], now: Date): Postmortem {
  const prs = [...gathered.prs].sort((a, b) => a.number - b.number);
  const gaps: string[] = [];
  const impactText = fromPrs(prs, SECTION_NAMES.impact, "");
  const causeText = fromPrs(prs, SECTION_NAMES.cause, "");
  if (prs.length === 0) gaps.push("nenhuma PR encontrada para a entrada: linha do tempo só com commits e diário");
  if (impactText === "" ) gaps.push(GAP_IMPACT);
  if (causeText === "") gaps.push(GAP_CAUSE);
  if (prs.some((p) => p.mergedAt === null)) gaps.push("há PR ainda não mergeada: o tempo até a correção só conta as mergeadas");
  if (source.status !== "ok") gaps.push(`fonte externa: ${source.note}`);
  const timeToFix = timeToFixOf(input, gathered, source);
  if (timeToFix === null) gaps.push("sem PR mergeada: tempo até a correção não calculado");
  const commits = [...prs.flatMap((p) => p.commits), ...gathered.commits];
  const byCommit = new Map(commits.map((c) => [c.sha.slice(0, SHORT_SHA), c]));
  const fixCommits = [...byCommit.values()].sort((a, b) => ms(a.ts) - ms(b.ts)).map((c) => ({ ...c, sha: c.sha.slice(0, SHORT_SHA) }));
  const title = prs.length === 1 ? (prs[0] as PrFact).title : input.kind === "range" ? `Mudanças de ${input.from} a ${input.to}` : input.kind === "card" ? `Card ${input.id}` : `PR #${input.number}`;
  const merged = prs.filter((p) => p.mergedAt !== null);
  const summary = merged.length > 0
    ? `${merged.length} PR(s) de correção mergeada(s): ${merged.map((p) => `#${p.number} ${flat(p.title)}`).join("; ")}.`
    : `Sem PR mergeada para ${idOf(input)}.`;
  return {
    v: THANATOS_VERSION,
    id: idOf(input),
    input,
    createdAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    title: flat(title),
    summary,
    impact: impactText || "(não declarado)",
    timeline: timelineOf(gathered, source, journal),
    cause: causeText || "(não declarada)",
    fix: fromPrs(prs, SECTION_NAMES.fix, prs.map((p) => `#${p.number} ${flat(p.title)}`).join("\n") || "(sem PR)"),
    fixData: {
      prs: prs.map((p) => ({ number: p.number, title: p.title, author: p.author, url: p.url, branch: p.branch, mergedAt: p.mergedAt })),
      commits: fixCommits,
      files: unique(prs.flatMap((p) => p.files)),
      authors: unique([...prs.map((p) => p.author), ...fixCommits.map((c) => c.author)]),
      timeToFix,
    },
    source: { status: source.status, note: source.note, metrics: source.metrics },
    gaps,
  };
}

// ------------------------------------------------------------------ markdown

export function formatDuration(totalMs: number): string {
  const minutes = Math.floor(totalMs / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${rest}min`].filter(Boolean).join(" ");
}

const bullets = (items: string[]): string => (items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "- (nenhum)");

export function renderMarkdown(pm: Postmortem): string {
  const ttf = pm.fixData.timeToFix;
  const lines = [
    `# Post-mortem ${pm.id}: ${pm.title}`,
    "",
    `Gerado em ${pm.createdAt} (UTC) por \`hades thanatos new\`. Todos os horários estão em UTC.`,
    "",
    "## Resumo",
    pm.summary,
    "",
    "## Impacto",
    pm.impact,
    "",
    "## Linha do tempo (UTC)",
    pm.timeline.length > 0 ? pm.timeline.map((e) => `- ${e.ts} · ${e.source} · ${e.text}`).join("\n") : "- (sem eventos)",
    "",
    "## Causa",
    pm.cause,
    "",
    "## Como foi corrigido",
    pm.fix,
    "",
    "## Dados da correção",
    `- PRs: ${pm.fixData.prs.map((p) => `#${p.number} (${p.author}, ${p.mergedAt ?? "não mergeada"})`).join("; ") || "(nenhuma)"}`,
    `- Commits: ${pm.fixData.commits.length}`,
    `- Autores: ${pm.fixData.authors.join(", ") || "(nenhum)"}`,
    `- Tempo até a correção: ${ttf ? `${formatDuration(ttf.ms)} (${ttf.from} → ${ttf.to}, base: ${ttf.basis})` : "(não calculado)"}`,
    "- Arquivos:",
    pm.fixData.files.length > 0 ? pm.fixData.files.map((f) => `  - \`${f}\``).join("\n") : "  - (nenhum)",
  ];
  if (pm.source.metrics.length > 0) {
    lines.push("", "## Métricas da fonte externa", bullets(pm.source.metrics.map((m) => `${m.name}: ${m.value}${m.unit ? ` ${m.unit}` : ""}${m.ts ? ` (${m.ts})` : ""}`)));
  }
  lines.push("", "## Lacunas", bullets(pm.gaps), "");
  return lines.join("\n");
}

// ------------------------------------------------------------------ armazenamento

const fileIn = (dir: string, id: string, ext: string): string => {
  if (!ID_PATTERN.test(id)) throw new HadesError(`id de post-mortem inválido: ${id}`, EXIT.usage);
  return join(dir, `${id}.${ext}`);
};

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function exists(dir: string, id: string): boolean {
  return isFile(fileIn(dir, id, "json"));
}

export function savePostmortem(dir: string, pm: Postmortem): { md: string; json: string } {
  mkdirSync(dir, { recursive: true });
  const md = fileIn(dir, pm.id, "md");
  const json = fileIn(dir, pm.id, "json");
  writeAtomic(md, renderMarkdown(pm));
  writeAtomic(json, `${JSON.stringify(pm, null, 2)}\n`);
  return { md, json };
}

/** Lê um post-mortem gravado; tolera `v` maior (campos novos ficam) e arquivo ilegível (undefined). */
export function readPostmortem(dir: string, id: string): Postmortem | undefined {
  const text = readText(fileIn(dir, id, "json"));
  if (text === undefined) return undefined;
  try {
    const doc: unknown = JSON.parse(text);
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
    const pm = doc as Partial<Postmortem>;
    return typeof pm.id === "string" && typeof pm.v === "number" && Array.isArray(pm.timeline) && pm.fixData !== undefined ? (pm as Postmortem) : undefined;
  } catch {
    return undefined;
  }
}

export function readMarkdown(dir: string, id: string): string | undefined {
  return readText(fileIn(dir, id, "md"));
}

export interface IndexEntry {
  id: string;
  title: string;
  createdAt: string;
  kind: Input["kind"];
  prs: number[];
  files: number;
  gaps: number;
  timeToFixMs: number | null;
}

/** Os post-mortems do projeto, do mais novo ao mais antigo; arquivo ilegível é pulado. */
export function listPostmortems(dir: string): IndexEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const entries: IndexEntry[] = [];
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    if (!ID_PATTERN.test(id)) continue;
    const pm = readPostmortem(dir, id);
    if (!pm) continue;
    entries.push({
      id: pm.id, title: pm.title, createdAt: pm.createdAt, kind: pm.input.kind, prs: pm.fixData.prs.map((p) => p.number),
      files: pm.fixData.files.length, gaps: pm.gaps.length, timeToFixMs: pm.fixData.timeToFix?.ms ?? null,
    });
  }
  return entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1));
}

export interface SearchHit { id: string; title: string; line: string }

/** Busca por trecho de texto (sem caixa, nunca como expressão regular) nos `.md`. */
export function searchPostmortems(dir: string, term: string): SearchHit[] {
  const needle = term.toLowerCase();
  if (needle === "") return [];
  const hits: SearchHit[] = [];
  for (const entry of listPostmortems(dir)) {
    const line = (readMarkdown(dir, entry.id) ?? "").split("\n").find((l) => l.toLowerCase().includes(needle));
    if (line !== undefined) hits.push({ id: entry.id, title: entry.title, line: line.trim().slice(0, SEARCH_SNIPPET_MAX) });
  }
  return hits;
}

// ------------------------------------------------------------------ arquivo citado (deliver e review)

export interface Citation { file: string; id: string; title: string; mergedAt: string | null }

/** Post-mortems anteriores que citam algum dos arquivos tocados (caminho exato do repo). */
export function citedFiles(dir: string, touched: string[]): Citation[] {
  const wanted = new Set(touched.map((f) => f.trim()).filter((f) => f !== ""));
  const found: Citation[] = [];
  for (const entry of listPostmortems(dir)) {
    const pm = readPostmortem(dir, entry.id);
    if (!pm) continue;
    const mergedAt = pm.fixData.prs.map((p) => p.mergedAt).filter((m): m is string => m !== null).sort().pop() ?? null;
    for (const file of pm.fixData.files) if (wanted.has(file)) found.push({ file, id: pm.id, title: pm.title, mergedAt });
  }
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.id < b.id ? -1 : 1));
}

// ------------------------------------------------------------------ sugestão no watch

export interface FixRule { branch?: RegExp; labels: string[] }
const RULE_PATTERN_MAX = 200;

/** `thanatos.fixBranchPattern` (ERE) e `thanatos.fixLabels` do perfil; sem nenhum dos dois, undefined (não sugere). */
export function fixRuleOf(profile: unknown): FixRule | undefined {
  const section = typeof profile === "object" && profile !== null ? (profile as Record<string, unknown>).thanatos : undefined;
  if (typeof section !== "object" || section === null) return undefined;
  const raw = section as Record<string, unknown>;
  const labels = Array.isArray(raw.fixLabels) ? raw.fixLabels.filter((l): l is string => typeof l === "string" && l !== "") : [];
  let branch: RegExp | undefined;
  if (typeof raw.fixBranchPattern === "string" && raw.fixBranchPattern !== "" && raw.fixBranchPattern.length <= RULE_PATTERN_MAX) {
    try {
      branch = new RegExp(raw.fixBranchPattern, "i");
    } catch {
      branch = undefined;
    }
  }
  return branch === undefined && labels.length === 0 ? undefined : { branch, labels };
}

export function isProductionFix(rule: FixRule | undefined, pr: { branch: string; labels: string[] }): boolean {
  if (rule === undefined) return false;
  if (rule.branch?.test(pr.branch)) return true;
  const have = new Set(pr.labels.map((l) => l.toLowerCase()));
  return rule.labels.some((l) => have.has(l.toLowerCase()));
}
