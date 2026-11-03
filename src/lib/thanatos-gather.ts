// Coleta do Thanatos na fronteira: PRs e reviews pelo `gh`, commits pelo `git` e o diário (só leitura). O executor de
// processos entra por parâmetro, para o teste trocar `gh` e `git` por dublê sem rede.
import { journalFiles, parseEvent, readTailText } from "./journal.ts";
import type { CommitFact, Gathered, Input, JournalFact, PrFact, ReviewFact } from "./thanatos.ts";
import { toUtc } from "./thanatos.ts";

export interface ProcResult { status: number; stdout: string; stderr: string }
export type Exec = (command: string, args: string[]) => ProcResult;

export interface GatherOptions {
  /** `dono/nome` do projeto */
  repo: string;
  maxPrs: number;
  journalMax: number;
}

export class GatherError extends Error {}

const PR_FIELDS = "number,title,body,author,headRefName,labels,createdAt,mergedAt,state,url,commits,files,reviews";
const UNIT = "\x1f";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const utc = (v: unknown): string => toUtc(str(v)) ?? "";

function json(r: ProcResult, what: string): unknown {
  if (r.status !== 0) throw new GatherError(`${what}: ${r.stderr.trim().split("\n").pop() ?? "falhou"}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new GatherError(`${what}: resposta que não é JSON`);
  }
}

function commitOf(raw: unknown): CommitFact | undefined {
  if (!isObject(raw)) return undefined;
  const authors = list(raw.authors).filter(isObject);
  const ts = utc(raw.committedDate);
  const sha = str(raw.oid);
  if (sha === "" || ts === "") return undefined;
  return { sha, subject: str(raw.messageHeadline), author: str((authors[0] ?? {}).login) || str((authors[0] ?? {}).name), ts };
}

/** PR do `gh pr view --json` (campos que faltam viram vazio, nunca valor inventado). */
export function prOf(raw: unknown): PrFact | undefined {
  if (!isObject(raw) || typeof raw.number !== "number") return undefined;
  const reviews: ReviewFact[] = [];
  for (const r of list(raw.reviews)) {
    if (!isObject(r)) continue;
    const ts = utc(r.submittedAt);
    if (ts !== "") reviews.push({ author: str(isObject(r.author) ? r.author.login : ""), ts, state: str(r.state) });
  }
  return {
    number: raw.number,
    title: str(raw.title),
    body: str(raw.body),
    url: str(raw.url),
    author: str(isObject(raw.author) ? raw.author.login : ""),
    branch: str(raw.headRefName),
    labels: list(raw.labels).filter(isObject).map((l) => str(l.name)).filter((n) => n !== ""),
    createdAt: utc(raw.createdAt),
    mergedAt: utc(raw.mergedAt) || null,
    state: str(raw.state),
    commits: list(raw.commits).map(commitOf).filter((c): c is CommitFact => c !== undefined),
    files: list(raw.files).filter(isObject).map((f) => str(f.path)).filter((p) => p !== ""),
    reviews,
  };
}

function viewPr(exec: Exec, repo: string, number: number): PrFact {
  const pr = prOf(json(exec("gh", ["pr", "view", String(number), "-R", repo, "--json", PR_FIELDS]), `gh pr view ${number}`));
  if (!pr) throw new GatherError(`PR #${number} não encontrada em ${repo}`);
  return pr;
}

function numbersOf(r: ProcResult, what: string): { number: number; title: string; branch: string; body: string }[] {
  return list(json(r, what)).filter(isObject).filter((p) => typeof p.number === "number").map((p) => ({
    number: p.number as number, title: str(p.title), branch: str(p.headRefName), body: str(p.body),
  }));
}

/** Commits do `git log` do intervalo (autor e data de autoria em UTC). */
export function gitCommits(exec: Exec, from: string, to: string): CommitFact[] {
  const r = exec("git", ["log", `--since=${from}`, `--until=${to}`, "--no-merges", `--format=%H${UNIT}%an${UNIT}%aI${UNIT}%s`]);
  if (r.status !== 0) throw new GatherError(`git log: ${r.stderr.trim().split("\n").pop() ?? "falhou"}`);
  const commits: CommitFact[] = [];
  for (const line of r.stdout.split("\n")) {
    const [sha = "", author = "", at = "", subject = ""] = line.split(UNIT);
    const ts = toUtc(at);
    if (sha !== "" && ts !== undefined) commits.push({ sha, subject, author, ts });
  }
  return commits;
}

export function gather(input: Input, exec: Exec, options: GatherOptions): Gathered {
  if (input.kind === "pr") return { prs: [viewPr(exec, options.repo, input.number)], commits: [] };
  const limit = String(options.maxPrs);
  if (input.kind === "range") {
    const found = numbersOf(
      exec("gh", ["pr", "list", "-R", options.repo, "--state", "merged", "--search", `merged:${input.from}..${input.to}`, "--limit", limit, "--json", "number,title,headRefName,body"]),
      "gh pr list",
    );
    return { prs: found.map((p) => viewPr(exec, options.repo, p.number)), commits: gitCommits(exec, input.from, input.to) };
  }
  const id = input.id.toLowerCase();
  const found = numbersOf(
    exec("gh", ["pr", "list", "-R", options.repo, "--state", "merged", "--search", input.id, "--limit", limit, "--json", "number,title,headRefName,body"]),
    "gh pr list",
  ).filter((p) => `${p.title}\n${p.branch}\n${p.body}`.toLowerCase().includes(id));
  return { prs: found.map((p) => viewPr(exec, options.repo, p.number)), commits: [] };
}

const NOISE = new Set(["tool_pre", "tool_post"]);

/** Eventos do diário do projeto (`slug`) no período, sem o ruído de ferramenta, os `max` mais recentes; diário ausente = vazio. */
export function journalFacts(slug: string, from: string, to: string, max: number, root?: string): JournalFact[] {
  const facts: JournalFact[] = [];
  for (const entry of journalFiles(root)) {
    if (entry.project !== slug) continue;
    for (const line of readTailText(entry.file).split("\n")) {
      const e = line === "" ? undefined : parseEvent(line);
      if (e === undefined || NOISE.has(e.kind)) continue;
      const at = Date.parse(e.ts);
      if (at >= Date.parse(from) && at <= Date.parse(to)) facts.push({ ts: e.ts, agent: e.agent, kind: e.kind, summary: e.summary });
    }
  }
  return facts.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).slice(-max);
}

/** Janela do diário para a entrada: o intervalo, ou da abertura da primeira PR à última mergeada. */
export function windowOf(input: Input, gathered: Gathered): { from: string; to: string } | undefined {
  if (input.kind === "range") return { from: input.from, to: input.to };
  const starts = gathered.prs.flatMap((p) => [p.createdAt, ...p.commits.map((c) => c.ts)]).filter((t) => t !== "").sort();
  const ends = gathered.prs.map((p) => p.mergedAt).filter((t): t is string => t !== null).sort();
  const from = starts[0];
  const to = ends[ends.length - 1];
  return from !== undefined && to !== undefined ? { from, to } : undefined;
}
