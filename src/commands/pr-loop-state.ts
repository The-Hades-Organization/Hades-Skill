// `hades pr-loop-state`: coletor de estado das PRs para o loop da Hades (hades pr-loop-state). Read-only por contrato: lê
// do GitHub e do estado local, nunca escreve; quem escreve é o orquestrador da skill. A lógica de classificação está em
// src/lib/collector.ts.
import { join } from "node:path";
import { EXIT, out, warn } from "../lib/output.ts";
import { need } from "../lib/deps.ts";
import { firstLine } from "../lib/fs.ts";
import { hadesHome } from "../lib/paths.ts";
import { type JsonObject, isObject, loadProfile, readJsonObject } from "../lib/profile.ts";
import { type Resolution, findProfile, packsRoot, resolveProject } from "../lib/project.ts";
import { run } from "../lib/proc.ts";
import {
  CHECK_PAGE_SIZE,
  COMMENT_PAGE_SIZE,
  type GqlPullRequest,
  MERGE_STATE_PAGE_SIZE,
  type MergeInfo,
  type PrView,
  REVIEW_PAGE_SIZE,
  type Report,
  SEARCH_PAGE_SIZE,
  THREAD_PAGE_SIZE,
  type Warning,
  applyStacks,
  buildPr,
  loadState,
  projectRules,
  renderTable,
  sortPrs,
  totalsOf,
} from "../lib/collector.ts";

const GH_TIMEOUT_MS = 90_000;
const GH_MAX_BUFFER = 64 * 1024 * 1024;

// Por que `search` + `reviewThreads` não usam --paginate: ver o cabeçalho de src/lib/collector.ts.
const THREADS_QUERY = `query($q:String!,$searchN:Int!,$threadN:Int!,$reviewN:Int!,$checkN:Int!,$commentN:Int!){
  search(query:$q, type:ISSUE, first:$searchN){
    issueCount
    nodes{ ... on PullRequest{
      number title url isDraft baseRefName headRefName headRefOid
      reviewDecision mergeable updatedAt body
      reviewRequests(first:1){ totalCount }
      author{ login }
      commits(last:1){ nodes{ commit{
        oid committedDate
        statusCheckRollup{ state contexts(first:$checkN){ totalCount nodes{
          __typename
          ... on CheckRun{ name conclusion status detailsUrl }
          ... on StatusContext{ context state targetUrl }
        } } }
      } } }
      reviewThreads(first:$threadN){ totalCount pageInfo{ hasNextPage } nodes{
        id isResolved isOutdated path line originalLine
        comments(first:1){ totalCount nodes{
          databaseId createdAt body author{ login __typename }
        } }
        replies: comments(last:1){ nodes{
          databaseId createdAt author{ login __typename }
        } }
      } }
      reviews(last:$reviewN){ totalCount nodes{ state submittedAt body author{ login __typename } } }
      comments(last:$commentN){ totalCount nodes{
        databaseId createdAt body isMinimized author{ login __typename }
      } }
    } }
  }
}`;

interface Options {
  json: boolean;
  author: string | null;
  mine: boolean;
  prs: number[];
  repo: string | null;
  state: string | null;
  limit: number | null;
  help: boolean;
}

interface Repo {
  owner: string;
  name: string;
  slug: string;
}

class CollectorError extends Error {}

function usage(): string {
  return [
    "pr-loop-state — estado das PRs para o loop da Hades (read-only)",
    "",
    "uso: hades pr-loop-state [--json] [--author <login>|--others]",
    "                                                    [--pr <n>]... [--repo o/r]",
    "                                                    [--state <file|dir>] [--limit <n>]",
    "",
    "  (default)         PRs abertas do usuario autenticado",
    "  --author <login>  PRs abertas desse autor",
    "  --others          PRs abertas de qualquer autor exceto o usuario",
    "  --pr <n>          restringe a PRs especificas (repetivel); ausentes saem em requestedMissing",
    "  --state <caminho> estado do loop: diretorio shardado (novo) ou state.json (legado).",
    "                    Default: <work>/state/ com fallback para <work>/state.json",
    `  --limit <n>       teto de PRs buscadas (default ${SEARCH_PAGE_SIZE}); corte vira warning`,
    "  --json            saida JSON completa (default: tabela compacta)",
    "",
    "exit 0 = coleta valida (inclusive vazia). exit 1 = falha; a saida JSON nao e emitida.",
    'Todo teto de pagina que cortar dados aparece em warnings[] — vazio nunca significa "nada a fazer".',
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { json: false, author: null, mine: true, prs: [], repo: null, state: null, limit: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--author") {
      opts.author = argv[++i] ?? null;
      opts.mine = false;
    } else if (arg === "--others") {
      opts.author = null;
      opts.mine = false;
    } else if (arg === "--pr") opts.prs.push(Number(argv[++i]));
    else if (arg === "--repo") opts.repo = argv[++i] ?? null;
    else if (arg === "--state") opts.state = argv[++i] ?? null;
    else if (arg === "--limit") opts.limit = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new CollectorError(`flag desconhecida: ${arg}`);
  }
  return opts;
}

function gh(args: string[]): string {
  const result = run("gh", args, { timeoutMs: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER });
  if (result.timedOut) throw new CollectorError(`gh ${args.slice(0, 2).join(" ")}: sem resposta em ${GH_TIMEOUT_MS / 1000}s`);
  if (result.status !== 0) throw new CollectorError(`Command failed: gh ${args.slice(0, 2).join(" ")}\n${result.stderr}`);
  return result.stdout;
}

/** Perfil do projeto pelo repo informado (--repo) ou pelo clone do diretório atual. */
function projectFor(explicitRepo: string | null): Resolution {
  if (!explicitRepo) return resolveProject();
  const packs = packsRoot();
  const result: Resolution = { project: null, profile: null, repo: explicitRepo, root: null, packs, code: 0, message: "" };
  const profile = findProfile(explicitRepo, packs);
  if (!profile) {
    result.code = EXIT.noProfile;
    result.message = `hades: ${explicitRepo} sem perfil em ${packs}/ — rode /hades project init para criar o perfil do projeto (reference/projects.md)`;
    return result;
  }
  result.profile = profile;
  const name = readJsonObject(profile)?.name;
  result.project = typeof name === "string" ? name : null;
  return result;
}

// Conta do gh do perfil sem trocar a conta ativa: o token vai só para os processos do coletor. GH_TOKEN/GITHUB_TOKEN do
// ambiente vencem. Medido: com a conta ativa pessoal, `gh repo view` no clone do projeto dá "Could not resolve".
function useProjectToken(profile: JsonObject, warnings: Warning[]): void {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return;
  const identity = isObject(profile.identity) ? profile.identity : {};
  const ghIdentity = isObject(identity.gh) ? identity.gh : {};
  const tokenEnv = typeof ghIdentity.tokenEnv === "string" ? ghIdentity.tokenEnv : undefined;
  const fromEnv = tokenEnv ? process.env[tokenEnv] : undefined;
  if (tokenEnv && fromEnv) {
    process.env.GH_TOKEN = fromEnv;
    return;
  }
  const user = typeof ghIdentity.user === "string" ? ghIdentity.user : undefined;
  if (!user) return;
  try {
    process.env.GH_TOKEN = gh(["auth", "token", "--user", user]).trim();
  } catch (error) {
    if (!(error instanceof CollectorError)) throw error;
    warnings.push({ kind: "gh-identity", detail: `sem token da conta ${user} no gh`, impact: "coleta com a conta ativa" });
  }
}

function splitSlug(slug: string): Repo {
  const [owner = "", name = ""] = slug.split("/");
  return { owner, name, slug };
}

function resolveRepo(explicit: string | null): Repo {
  if (explicit) {
    const repo = splitSlug(explicit);
    if (!repo.owner || !repo.name) throw new CollectorError(`--repo esperava owner/name, recebeu "${explicit}"`);
    return repo;
  }
  let slug: unknown;
  try {
    slug = (JSON.parse(gh(["repo", "view", "--json", "nameWithOwner"])) as { nameWithOwner?: unknown }).nameWithOwner;
  } catch (error) {
    if (!(error instanceof CollectorError)) throw error;
    throw new CollectorError("fora de um clone git: informe o repositorio com --repo <owner>/<name>");
  }
  if (typeof slug !== "string") throw new CollectorError("gh repo view: resposta sem nameWithOwner");
  return splitSlug(slug);
}

/** Raiz do estado: HADES_WORK_ROOT > ~/.claude/hades/work-root (uma linha) > ~/.claude/hades/work, como no gate-lock.sh. */
function workDirFor(repo: Repo): string {
  const root = process.env.HADES_WORK_ROOT || firstLine(join(hadesHome(), "work-root")).trim() || join(hadesHome(), "work");
  return join(root, `${repo.owner}__${repo.name}`);
}

function buildSearchQuery(slug: string, login: string, opts: Options): string {
  const parts = [`repo:${slug}`, "is:pr", "is:open"];
  if (opts.mine) parts.push(`author:${login}`);
  else if (opts.author) parts.push(`author:${opts.author}`);
  else parts.push(`-author:${login}`);
  return parts.join(" ");
}

function isPullRequest(node: unknown): node is GqlPullRequest {
  return isObject(node) && typeof node.number === "number";
}

function fetchPullRequests(searchQuery: string, searchN: number): { nodes: GqlPullRequest[]; issueCount: number } {
  const raw = gh([
    "api",
    "graphql",
    "-f",
    `query=${THREADS_QUERY}`,
    "-f",
    `q=${searchQuery}`,
    "-F",
    `searchN=${searchN}`,
    "-F",
    `threadN=${THREAD_PAGE_SIZE}`,
    "-F",
    `reviewN=${REVIEW_PAGE_SIZE}`,
    "-F",
    `checkN=${CHECK_PAGE_SIZE}`,
    "-F",
    `commentN=${COMMENT_PAGE_SIZE}`,
  ]);
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new CollectorError("GraphQL: resposta não é um objeto");
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw new CollectorError(`GraphQL: ${parsed.errors.map((e) => (isObject(e) ? String(e.message) : String(e))).join("; ")}`);
  }
  const data = isObject(parsed.data) ? parsed.data : {};
  const search = isObject(data.search) ? data.search : {};
  const nodes: unknown[] = Array.isArray(search.nodes) ? search.nodes : [];
  return { nodes: nodes.filter(isPullRequest), issueCount: typeof search.issueCount === "number" ? search.issueCount : 0 };
}

function fetchMergeState(slug: string, numbers: number[], warnings: Warning[]): Map<number, MergeInfo> {
  const byNumber = new Map<number, MergeInfo>();
  if (!numbers.length) return byNumber;
  const rows: unknown = JSON.parse(
    gh(["pr", "list", "--repo", slug, "--state", "open", "--limit", String(MERGE_STATE_PAGE_SIZE), "--json", "number,mergeStateStatus,mergeable,labels"]),
  );
  if (!Array.isArray(rows)) throw new CollectorError("gh pr list: resposta não é uma lista");
  for (const row of rows) {
    if (!isObject(row) || typeof row.number !== "number") continue;
    const labels = Array.isArray(row.labels) ? row.labels.flatMap((label) => (isObject(label) && typeof label.name === "string" ? [label.name] : [])) : [];
    byNumber.set(row.number, { mergeStateStatus: typeof row.mergeStateStatus === "string" ? row.mergeStateStatus : "UNKNOWN", labels });
  }
  const missing = numbers.filter((number) => !byNumber.has(number));
  if (missing.length) {
    warnings.push({
      kind: "merge-state-missing",
      detail: `sem mergeStateStatus para ${missing.join(", ")} (teto de ${MERGE_STATE_PAGE_SIZE} PRs abertas)`,
      impact: "conflict e stale-base nao sao detectaveis nessas PRs",
    });
  }
  return byNumber;
}

function scopeLabel(opts: Options): string {
  if (opts.mine) return "PRs do usuario";
  return opts.author ? `PRs de ${opts.author}` : "PRs de outros autores";
}

function scopeKey(opts: Options): string {
  if (opts.mine) return "mine";
  return opts.author ? `author:${opts.author}` : "others";
}

function collect(opts: Options): number {
  need("gh");
  const warnings: Warning[] = [];
  const project = projectFor(opts.repo);
  if (project.code !== 0) {
    warn(project.message);
    return project.code;
  }
  const profile = loadProfile(project);
  const rules = projectRules(profile);
  useProjectToken(profile, warnings);
  const repo = resolveRepo(opts.repo);
  const login = gh(["api", "user", "--jq", ".login"]).trim();
  const workDir = workDirFor(repo);
  const state = loadState(opts.state, workDir);
  warnings.push(...state.warnings);

  const searchN = opts.limit ?? SEARCH_PAGE_SIZE;
  const { nodes, issueCount } = fetchPullRequests(buildSearchQuery(repo.slug, login, opts), searchN);
  if (issueCount > nodes.length) {
    warnings.push({
      kind: "search-truncated",
      detail: `${issueCount} PRs no escopo, ${nodes.length} coletadas (teto ${searchN})`,
      impact: "ha PR acionavel fora do lote; suba --limit ou reduza o escopo",
    });
  }
  const mergeInfo = fetchMergeState(repo.slug, nodes.map((node) => node.number), warnings);

  let prs: PrView[] = nodes.map((node) => buildPr(node, mergeInfo.get(node.number), state, login, rules, warnings));
  // PR pedida que não está no conjunto aberto (mergeada, fechada, ou de outro autor) sairia como resultado vazio, e
  // vazio seria lido pelo loop como "nada a fazer" nessa PR.
  const requestedMissing = opts.prs.filter((number) => !prs.some((pr) => pr.number === number));
  if (opts.prs.length) {
    if (requestedMissing.length) warn(`pr-loop-state: fora do escopo aberto de ${scopeLabel(opts)}: ${requestedMissing.join(", ")}`);
    prs = prs.filter((pr) => opts.prs.includes(pr.number));
  }
  applyStacks(prs);
  sortPrs(prs);

  const report: Report = {
    repo: repo.slug,
    login,
    scope: scopeKey(opts),
    project: project.project,
    profile: project.profile,
    stateSources: state.sources,
    stateVersion: state.version,
    workDir,
    totals: totalsOf(prs),
    requestedMissing,
    warnings,
    prs,
  };
  out(opts.json ? JSON.stringify(report, null, 2) : renderTable(report, rules));
  return EXIT.ok;
}

export function prLoopStateCommand(args: string[]): number {
  try {
    const opts = parseArgs(args);
    if (opts.help) {
      out(usage());
      return EXIT.ok;
    }
    return collect(opts);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof CollectorError) {
      warn(`pr-loop-state: ${error.message}`);
      return EXIT.fail;
    }
    throw error;
  }
}
