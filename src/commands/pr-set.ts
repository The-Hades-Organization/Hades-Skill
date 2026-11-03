// Conjunto de PRs do Hades (hades pr-set): resolve $D/prs.list e imprime, em ordem topológica (base antes da PR
// empilhada; entre irmãs, por número), uma linha TSV por PR: number, headRefOid, base-no-conjunto (ou "-"), headRefName,
// title. Avisos vão para stderr. O gh descobre o repo pelo diretório: sempre consultado a partir do worktree.
import { join } from "node:path";
import { EXIT, HadesError, out, warn as stderr } from "../lib/output.ts";
import { need } from "../lib/deps.ts";
import { readText } from "../lib/fs.ts";
import { stateDir } from "../lib/kit.ts";
import { selfCli } from "../lib/paths.ts";
import { run } from "../lib/proc.ts";

const FIELDS = "number,title,headRefName,baseRefName,isDraft,headRefOid,state";
const LIST_LIMIT = "100";
const TITLE_CHARS = 90;
const GH_TIMEOUT_MS = 60_000;

export interface Pr {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  headRefOid: string;
  state: string;
}

/** HADES_WT, ou o $D sem o sufixo "-data" (o D[:-5] do original, que corta cinco caracteres mesmo sem o sufixo). */
const worktreeOf = (kit: string): string => process.env.HADES_WT || kit.slice(0, -"-data".length);

const warn = (message: string): void => stderr(`pr-set: ${message}`);

/** Branch-base da hades/local, a mesma do hades_base (config.sh): HADES_BASE_BRANCH, senão branch.base do perfil > flow.base > develop. */
function baseBranch(worktree: string): string {
  if (process.env.HADES_BASE_BRANCH) return process.env.HADES_BASE_BRANCH;
  const projectGet = (key: string): string => {
    const cli = selfCli("project", "get", key, "", "--dir", worktree);
    return run(cli.command, cli.args).stdout.trim();
  };
  const flowBase = projectGet("flow.base");
  const base = projectGet("branch.base") || (flowBase ? `origin/${flowBase}` : "origin/develop");
  return base.startsWith("origin/") ? base.slice("origin/".length) : base;
}

function gh<T>(worktree: string, ...args: string[]): T {
  const r = run("gh", args, { cwd: worktree, timeoutMs: GH_TIMEOUT_MS });
  if (r.status !== 0) throw new HadesError(`gh ${args.join(" ")} falhou (${r.status}): ${r.stderr.trim()}`, EXIT.fail);
  return JSON.parse(r.stdout || "[]") as T;
}

function entries(kit: string): string[] {
  const lines = (readText(join(kit, "prs.list")) ?? "")
    .split("\n")
    .map((line) => (line.split("#", 1)[0] ?? "").trim())
    .filter(Boolean);
  return lines.length ? lines : ["@me"];
}

const isDigits = (text: string): boolean => /^\d+$/.test(text);

function resolve(kit: string, worktree: string, base: string): Map<number, Pr> {
  const include: number[] = [];
  const exclude = new Set<number>();
  const authors: string[] = [];
  for (const e of entries(kit)) {
    if (e.startsWith("-") && isDigits(e.slice(1))) exclude.add(Number(e.slice(1)));
    else if (isDigits(e)) include.push(Number(e));
    else if (e === "@me" || e.startsWith("author:")) authors.push(e === "@me" ? "@me" : e.slice(e.indexOf(":") + 1));
    else warn(`entrada ignorada: '${e}'`);
  }
  const prs = new Map<number, Pr>();
  for (const author of authors) {
    for (const p of gh<Pr[]>(worktree, "pr", "list", "--author", author, "--state", "open", "--json", FIELDS, "--limit", LIST_LIMIT)) {
      if (!p.isDraft) prs.set(p.number, p);
    }
  }
  for (let i = 0; i < include.length; i++) {
    let n = include[i] as number;
    if (prs.has(n)) continue;
    let p = gh<Pr>(worktree, "pr", "view", String(n), "--json", FIELDS);
    // stack mergeada em cascata: a PR foi mergeada na branch de outra PR ainda aberta — segue para ela
    while (p.state === "MERGED" && p.baseRefName !== base) {
      const up = gh<Pr[]>(worktree, "pr", "list", "--head", p.baseRefName, "--state", "all", "--json", FIELDS, "--limit", "1");
      const next = up[0];
      if (!next) break;
      warn(`#${p.number} foi mergeada na branch da #${next.number} — seguindo para ela`);
      p = next;
    }
    if (p.state !== "OPEN") {
      warn(`#${n} está ${p.state} (#${p.number}) — fora do Hades`);
      continue;
    }
    include[i] = p.number;
    n = p.number;
    prs.set(n, p);
  }
  // stack abaixo de cada PR explícita: base que é branch de outra PR aberta entra também, em cadeia
  for (const n of include) {
    const start = prs.get(n);
    if (!start) continue;
    let current = start.baseRefName;
    while (current !== base) {
      const found = gh<Pr[]>(worktree, "pr", "list", "--head", current, "--state", "open", "--json", FIELDS, "--limit", "1")[0];
      if (!found) {
        warn(`#${n}: base ${current} não tem PR aberta — o merge traz os commits dela junto`);
        break;
      }
      if (!prs.has(found.number)) {
        prs.set(found.number, found);
        warn(`#${found.number} entrou por ser base da stack de #${n}`);
      }
      current = found.baseRefName;
    }
  }
  for (const n of exclude) prs.delete(n);
  return prs;
}

const byNumber = (prs: Map<number, Pr>): number[] => [...prs.keys()].sort((a, b) => a - b);

function ordered(prs: Map<number, Pr>, base: string): { list: Pr[]; byHead: Map<string, Pr> } {
  const byHead = new Map([...prs.values()].map((p) => [p.headRefName, p]));
  const list: Pr[] = [];
  const seen = new Set<number>();
  const visit = (p: Pr): void => {
    if (seen.has(p.number)) return;
    const below = byHead.get(p.baseRefName);
    if (below) visit(below);
    seen.add(p.number);
    list.push(p);
  };
  for (const n of byNumber(prs)) visit(prs.get(n) as Pr);
  for (const p of list) {
    if (p.baseRefName !== base && !byHead.has(p.baseRefName)) {
      warn(`#${p.number} está empilhada sobre ${p.baseRefName}, que não está no conjunto: o merge traz os commits da base junto`);
    }
  }
  return { list, byHead };
}

export interface PrRow {
  number: number;
  oid: string;
  base: string;
  head: string;
  title: string;
}

/** As PRs do conjunto em ordem topológica (a mesma ordem e avisos do hades pr-set). */
export function resolvePrSet(): PrRow[] {
  need("gh");
  const kit = stateDir();
  const worktree = worktreeOf(kit);
  const base = baseBranch(worktree);
  const prs = resolve(kit, worktree, base);
  const { list, byHead } = ordered(prs, base);
  return list.map((p) => ({
    number: p.number,
    oid: p.headRefOid,
    base: byHead.get(p.baseRefName) ? String(byHead.get(p.baseRefName)?.number) : "-",
    head: p.headRefName,
    title: Array.from(p.title).slice(0, TITLE_CHARS).join(""),
  }));
}

/** `número<TAB>head` de cada PR do conjunto, por número (o `pr-set --heads`); o plantão compara com o último build. */
export function headLines(): string[] {
  need("gh");
  const kit = stateDir();
  const worktree = worktreeOf(kit);
  const prs = resolve(kit, worktree, baseBranch(worktree));
  return byNumber(prs).map((n) => `${n}\t${prs.get(n)?.headRefOid}`);
}

export function prSetCommand(args: string[]): number {
  if (args.includes("--heads")) {
    for (const line of headLines()) out(line);
    return EXIT.ok;
  }
  for (const row of resolvePrSet()) out(`${row.number}\t${row.oid}\t${row.base}\t${row.head}\t${row.title}`);
  return EXIT.ok;
}

