// Estado das PRs para o loop da Hades (coletor read-only): regras do projeto, leitura do estado do loop, montagem e
// classificação de cada PR e a tabela compacta. Sem I/O de rede: quem busca no GitHub é src/commands/pr-loop-state.ts.
//
// Invariantes medidos que o código depende e que quebram em silêncio se alterados:
//  - `search` + `reviewThreads` NUNCA com --paginate: medido estourando o timeout de 120s. O preço é o teto por página,
//    por isso todo teto compara com o `totalCount` e emite `warnings[]` quando corta. Teto que corta calado vira
//    "nada a fazer" no loop.
//  - thread outdated devolve `line: null` (o hunk andou); a localização viva é `originalLine`.
//  - `pushedDate` foi depreciado e volta null; o proxy do último push é `committedDate`.
//  - `reviewDecision` não reflete pendência: PR APPROVED com thread aberta é comum.
//  - o CI de PR (flow.ci do perfil) pode disparar só em `pull_request` com certas bases (flow.ci.bases) e não em draft
//    (flow.ci.draft). PR empilhada e PR draft ficam com rollup vazio: ausência de check NÃO é check verde (estado
//    `no-ci`, nunca `done-pending`).
//  - o resumo do bot de review do CI (flow.bot) é postado com `gh pr comment`: é issue comment, não review. Quem lê só
//    `reviewThreads` fica cego para o veredito e para todo achado fora de hunk.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDir, listDir, readText } from "./fs.ts";
import { type Json, type JsonObject, isObject, pathValue } from "./profile.ts";

const FAILING_CONCLUSIONS = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING_CONCLUSIONS = new Set<string | null | undefined>([null, "PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "EXPECTED"]);

export const SEARCH_PAGE_SIZE = 60;
export const THREAD_PAGE_SIZE = 100;
export const REVIEW_PAGE_SIZE = 40;
export const CHECK_PAGE_SIZE = 40;
export const COMMENT_PAGE_SIZE = 30;
export const MERGE_STATE_PAGE_SIZE = 200;
const STATE_VERSION = 2;
const EXCERPT_CHARS = 160;
const RULE_CODE_HEAD_CHARS = 80;
const TABLE_BASE_WIDTH = 28;
const TABLE_TITLE_WIDTH = 46;

// Veredito registrado em `handledThreads` decide se a thread sai da fila ou volta:
//  - applied / stale-fixed -> tratada e respondida, sai (a menos que o reviewer responda depois).
//  - rebutted / indeterminate -> a bola está com o humano: continua contando como pendente (bloqueia `done-pending`),
//    mas não volta para `live`, senão o loop repergunta a cada tick.
const TERMINAL_VERDICTS = new Set(["applied", "stale-fixed"]);
const AWAITING_REVIEWER_VERDICTS = new Set(["rebutted", "indeterminate"]);

export interface Warning {
  kind: string;
  pr?: number;
  detail: string;
  impact?: string;
}

// --- o que o GraphQL devolve (a forma de THREADS_QUERY em pr-loop-state.ts) ---
interface GqlAuthor {
  login?: string | null;
  __typename?: string;
}
interface GqlComment {
  databaseId?: number | null;
  createdAt?: string | null;
  body?: string | null;
  isMinimized?: boolean;
  author?: GqlAuthor | null;
}
interface GqlCheck {
  __typename?: string;
  name?: string;
  conclusion?: string | null;
  status?: string;
  detailsUrl?: string | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
}
export interface GqlCommit {
  oid?: string;
  committedDate?: string | null;
  statusCheckRollup?: { state?: string; contexts?: { totalCount?: number; nodes?: GqlCheck[] } } | null;
}
interface GqlThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line?: number | null;
  originalLine?: number | null;
  comments?: { totalCount?: number; nodes?: GqlComment[] };
  replies?: { nodes?: GqlComment[] };
}
interface GqlReview {
  state: string;
  submittedAt?: string | null;
  body?: string | null;
  author?: GqlAuthor | null;
}
export interface GqlPullRequest {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  reviewDecision?: string | null;
  mergeable?: string;
  body?: string | null;
  reviewRequests?: { totalCount?: number };
  author?: GqlAuthor | null;
  commits?: { nodes?: { commit?: GqlCommit | null }[] };
  reviewThreads?: { totalCount?: number; pageInfo?: { hasNextPage?: boolean }; nodes?: GqlThread[] };
  reviews?: { totalCount?: number; nodes?: GqlReview[] };
  comments?: { totalCount?: number; nodes?: GqlComment[] };
}

export interface MergeInfo {
  mergeStateStatus: string;
  labels: string[];
}

// --- regras do projeto ---
export interface SelfMarker {
  pattern: string;
  multiline: boolean;
}
export interface Rules {
  base: string | undefined;
  ciBases: (string | undefined)[];
  ciDraft: boolean;
  ciName: string;
  botBases: string[];
  botName: string | null;
  selfMarkers: RegExp[];
  ruleCode: RegExp | null;
  specId: RegExp | null;
  cardId: RegExp | null;
  /** false: review humano não é pré-condição de `done-pending`; `awaiting-review` só com review pedido. */
  reviewRequired: boolean;
}

function field(profile: JsonObject, path: string): Json | undefined {
  const value = pathValue(profile, path);
  return value === null ? undefined : value;
}

function stringField(profile: JsonObject, path: string): string | undefined {
  const value = field(profile, path);
  return typeof value === "string" ? value : undefined;
}

function stringList(profile: JsonObject, path: string): string[] | undefined {
  const value = field(profile, path);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function boolField(profile: JsonObject, path: string, fallback: boolean): boolean {
  const value = field(profile, path);
  return typeof value === "boolean" ? value : fallback;
}

function optionalRegExp(pattern: string | undefined, flags = ""): RegExp | null {
  return pattern ? new RegExp(pattern, flags) : null;
}

function selfMarkers(profile: JsonObject): RegExp[] {
  const raw = field(profile, "flow.bot.selfMarkers");
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isObject(item) || typeof item.pattern !== "string") return [];
    return [new RegExp(item.pattern, item.multiline ? "m" : "")];
  });
}

/** O que varia por projeto sai do perfil do repo (reference/projects.md); campo ausente no perfil = neutro. */
export function projectRules(profile: JsonObject): Rules {
  const base = stringField(profile, "flow.base");
  return {
    base,
    ciBases: stringList(profile, "flow.ci.bases") ?? [base],
    ciDraft: boolField(profile, "flow.ci.draft", false),
    ciName: stringField(profile, "flow.ci.workflow") ?? "CI",
    botBases: stringList(profile, "flow.bot.bases") ?? [],
    botName: stringField(profile, "flow.bot.mention") ?? null,
    selfMarkers: selfMarkers(profile),
    ruleCode: optionalRegExp(stringField(profile, "rules.severity.codePattern")),
    specId: optionalRegExp(stringField(profile, "work.specIdPattern"), "g"),
    cardId: optionalRegExp(stringField(profile, "card.idPattern"), "gi"),
    reviewRequired: boolField(profile, "flow.reviewRequired", true),
  };
}

// --- estado do loop ---
// Diretório shardado (`state/global.json` + `state/pr-<n>.json`) ou o `state.json` monolítico legado. O shard existe
// porque o estado é compartilhado entre clones: dois clones escrevendo o mesmo arquivo grande se sobrescrevem, e o
// lock é por PR, não por arquivo.
export interface LoopState {
  version: number | null;
  sources: string[];
  threads: Map<string, Json>;
  comments: Map<string, Json>;
  claudeTrigger: Map<string, Json>;
  lastSeenReview: Map<string, Json>;
  warnings: Warning[];
}

function emptyState(): LoopState {
  return { version: null, sources: [], threads: new Map(), comments: new Map(), claudeTrigger: new Map(), lastSeenReview: new Map(), warnings: [] };
}

function readStateFile(path: string, state: LoopState): JsonObject | null {
  const text = readText(path);
  try {
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) throw new Error("o estado não é um objeto JSON");
    return parsed;
  } catch (error) {
    state.warnings.push({ kind: "state-unreadable", detail: `${path}: ${error instanceof Error ? error.message : String(error)}` });
    return null;
  }
}

function entriesOf(value: Json | undefined): [string, Json][] {
  return isObject(value) ? Object.entries(value) : [];
}

function versionOf(parsed: JsonObject): number | null {
  return typeof parsed.version === "number" ? parsed.version : null;
}

function absorbLegacyState(parsed: JsonObject, state: LoopState): void {
  for (const [threadId, entry] of entriesOf(parsed.handledThreads)) state.threads.set(threadId, entry);
  for (const [pr, entry] of entriesOf(parsed.lastClaudeTrigger)) state.claudeTrigger.set(pr, entry);
}

function absorbShardState(parsed: JsonObject, state: LoopState): void {
  const pr = String(parsed.pr ?? "");
  for (const [threadId, entry] of entriesOf(parsed.threads)) state.threads.set(threadId, entry);
  for (const [commentId, entry] of entriesOf(parsed.comments)) state.comments.set(commentId, entry);
  if (parsed.lastClaudeTrigger && pr) state.claudeTrigger.set(pr, parsed.lastClaudeTrigger);
  if (parsed.lastSeenReviewAt && pr) state.lastSeenReview.set(pr, parsed.lastSeenReviewAt);
}

export function loadState(explicitPath: string | null, workDir: string): LoopState {
  const state = emptyState();
  const explicitDir = explicitPath !== null && isDir(explicitPath);
  const shardDir = explicitPath !== null && explicitDir ? explicitPath : join(workDir, "state");
  const legacyFile = explicitPath !== null && !explicitDir ? explicitPath : join(workDir, "state.json");

  if (existsSync(legacyFile)) {
    const parsed = readStateFile(legacyFile, state);
    if (parsed) {
      state.sources.push(legacyFile);
      state.version = versionOf(parsed);
      absorbLegacyState(parsed, state);
    }
  }
  if (isDir(shardDir)) {
    const global = join(shardDir, "global.json");
    if (existsSync(global)) {
      const parsed = readStateFile(global, state);
      if (parsed) {
        state.sources.push(global);
        state.version = versionOf(parsed) ?? state.version;
      }
    }
    for (const file of listDir(shardDir).filter((name) => /^pr-\d+\.json$/.test(name))) {
      const parsed = readStateFile(join(shardDir, file), state);
      if (parsed) {
        state.sources.push(join(shardDir, file));
        absorbShardState(parsed, state);
      }
    }
  }
  if (state.sources.length && state.version !== null && state.version > STATE_VERSION) {
    state.warnings.push({ kind: "state-version", detail: `state versao ${state.version} > ${STATE_VERSION} suportada — atualize o coletor antes de escrever` });
  }
  return state;
}

function entryText(entry: Json | undefined, key: string): string | null {
  if (!isObject(entry)) return null;
  const value = entry[key];
  return typeof value === "string" ? value : null;
}

// --- leitura das PRs ---
function isBot(author: GqlAuthor | null | undefined): boolean {
  if (!author) return false;
  return author.__typename === "Bot" || /\[bot\]$/.test(author.login ?? "");
}

function firstLine(body: string | null | undefined): string {
  const line = (body ?? "").split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.trim().slice(0, EXCERPT_CHARS);
}

// O corpo do achado abre com o código da regra, mas o prefixo varia: emoji de severidade, negrito e backtick aparecem
// em qualquer combinação (`RB-31`, 🔴 **B1**, V10). Descartar tudo que não seja letra antes de casar é o único jeito
// estável de extrair o código.
function ruleCodeOf(rules: Rules, body: string | null | undefined): string | null {
  if (!rules.ruleCode) return null;
  const head = (body ?? "").trimStart().slice(0, RULE_CODE_HEAD_CHARS).replace(/^[^A-Za-z]+/u, "");
  const match = rules.ruleCode.exec(head);
  return match?.[1] ?? null;
}

interface CheckLabel {
  name: string | undefined;
  url: string | null | undefined;
}

interface ChecksSummary {
  state: string;
  failing: CheckLabel[];
  pending: CheckLabel[];
  passing: number;
  total: number;
  verdict: "red" | "pending" | "green" | "none";
}

function summarizeChecks(commit: GqlCommit | null, warnings: Warning[], number: number): ChecksSummary {
  const rollup = commit?.statusCheckRollup;
  const contexts = rollup?.contexts?.nodes ?? [];
  const failing: CheckLabel[] = [];
  const pending: CheckLabel[] = [];
  let passing = 0;
  for (const context of contexts) {
    if (context.__typename === "CheckRun") {
      const label = { name: context.name, url: context.detailsUrl };
      if (context.conclusion && FAILING_CONCLUSIONS.has(context.conclusion)) failing.push(label);
      else if (context.status !== "COMPLETED" || PENDING_CONCLUSIONS.has(context.conclusion)) pending.push(label);
      else passing += 1;
    } else {
      const label = { name: context.context, url: context.targetUrl };
      if (context.state === "FAILURE" || context.state === "ERROR") failing.push(label);
      else if (context.state === "PENDING" || context.state === "EXPECTED") pending.push(label);
      else passing += 1;
    }
  }
  const declared = rollup?.contexts?.totalCount ?? contexts.length;
  if (declared > contexts.length) {
    warnings.push({
      kind: "checks-truncated",
      pr: number,
      detail: `${declared} checks, ${contexts.length} lidos (teto ${CHECK_PAGE_SIZE})`,
      impact: "check falhando fora da pagina fica invisivel",
    });
  }
  // Ausência de check não é check verde: PR empilhada e PR draft não disparam o CI de PR (flow.ci).
  const verdict = failing.length ? "red" : pending.length ? "pending" : passing > 0 ? "green" : "none";
  return { state: rollup?.state ?? "NONE", failing, pending, passing, total: contexts.length, verdict };
}

function idsFrom(pattern: RegExp | null, text: string | null | undefined, normalize: (id: string) => string): string[] {
  if (!pattern) return [];
  const found = new Set<string>();
  for (const match of (text ?? "").matchAll(pattern)) {
    const id = match[1];
    if (id !== undefined) found.add(normalize(id));
  }
  return [...found];
}

export interface ThreadView {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  verdict: string | null;
  verdictAt: string | null;
  reopened: boolean;
  handled: boolean;
  awaitingReviewer: boolean;
  author: string | null;
  fromBot: boolean;
  commentId: number | null;
  createdAt: string | null;
  commentCount: number;
  lastReplyAt: string | null;
  lastReplyAuthor: string | null;
  lastReplyFromMe: boolean;
  ruleCode: string | null;
  excerpt: string;
}

export interface TopLevelView {
  commentId: number | null | undefined;
  author: string | null;
  fromBot: boolean;
  createdAt: string | null | undefined;
  verdict: string | null;
  handled: boolean;
  ruleCode: string | null;
  excerpt: string;
}

interface ReviewView {
  state: string;
  author: string | null;
  fromBot: boolean;
  submittedAt: string;
  hasBody: boolean;
}

export type PrState =
  | "ci-red"
  | "conflict"
  | "needs-response"
  | "needs-triage"
  | "stale-base"
  | "draft"
  | "ci-running"
  | "awaiting-review"
  | "no-ci"
  | "done-pending"
  | "needs-attention";

export interface PrView {
  number: number;
  title: string;
  url: string;
  author: string | null;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  reviewDecision: string | null;
  mergeable: string;
  mergeStateStatus: string;
  labels: string[];
  stacked: boolean;
  claudeEligible: boolean;
  ciEligible: boolean;
  lastPushAt: string | null;
  lastReviewAt: string | null;
  lastSeenReviewAt: string | null;
  reviewedSincePush: boolean;
  unseenReviewSincePush: boolean;
  threadTotal: number;
  unresolved: number;
  checks: ChecksSummary;
  specIds: string[];
  cardIds: string[];
  lastClaudeTrigger: Json | null;
  live: ThreadView[];
  triage: ThreadView[];
  awaitingReviewer: ThreadView[];
  topLevel: TopLevelView[];
  topLevelLive: TopLevelView[];
  ciReviewSummary: TopLevelView | null;
  threads: ThreadView[];
  reviews: ReviewView[];
  state: PrState;
  stackParent?: number | null;
  stackDepth?: number;
}

type Candidate = Omit<PrView, "state" | "stackParent" | "stackDepth">;

// Ordem de prioridade: o primeiro predicado que casa vence. `awaiting-review` vem antes de `done-pending` porque PR
// sem nenhum review posterior ao push não está pronta: está esperando. A tabela de estados do SKILL.md tem a mesma
// ordem; divergência é defeito.
type Classifier = readonly [Exclude<PrState, "needs-attention">, (pr: Candidate, rules: Rules, reviewRequested: boolean) => boolean];

const CLASSIFIERS: readonly Classifier[] = [
  ["ci-red", (pr) => pr.checks.failing.length > 0],
  ["conflict", (pr) => pr.mergeStateStatus === "DIRTY" || pr.mergeable === "CONFLICTING"],
  ["needs-response", (pr) => pr.live.length > 0 || pr.topLevelLive.length > 0 || pr.unseenReviewSincePush],
  ["needs-triage", (pr) => pr.triage.length > 0],
  ["stale-base", (pr) => pr.mergeStateStatus === "BEHIND"],
  ["draft", (pr) => pr.isDraft],
  ["ci-running", (pr) => pr.checks.verdict === "pending"],
  ["awaiting-review", (pr, rules, reviewRequested) => !pr.reviewedSincePush && (rules.reviewRequired || reviewRequested)],
  ["no-ci", (pr) => pr.checks.verdict === "none"],
  ["done-pending", (pr) => pr.unresolved === 0 && pr.checks.verdict === "green"],
];

export const STATE_ORDER: readonly PrState[] = [...CLASSIFIERS.map(([name]) => name), "needs-attention"];

function classify(pr: Candidate, rules: Rules, reviewRequested: boolean): PrState {
  for (const [name, predicate] of CLASSIFIERS) {
    if (predicate(pr, rules, reviewRequested)) return name;
  }
  // Sobra quando há thread pendente do humano (rebutted/indeterminate) com tudo mais verde: não é pronta e não há o
  // que aplicar, é do usuário a próxima jogada.
  return "needs-attention";
}

function buildThreads(node: GqlPullRequest, state: LoopState, login: string, rules: Rules, warnings: Warning[]): ThreadView[] {
  const declared = node.reviewThreads?.totalCount ?? 0;
  const nodes = node.reviewThreads?.nodes ?? [];
  if (node.reviewThreads?.pageInfo?.hasNextPage || declared > nodes.length) {
    warnings.push({
      kind: "threads-truncated",
      pr: node.number,
      detail: `${declared} threads, ${nodes.length} lidas (teto ${THREAD_PAGE_SIZE})`,
      impact: "achado fora da pagina nao entra na contagem de vivos",
    });
  }
  return nodes.map((thread) => {
    const comment = thread.comments?.nodes?.[0] ?? null;
    const reply = thread.replies?.nodes?.[0] ?? null;
    const entry = state.threads.get(thread.id);
    const verdict = entryText(entry, "verdict");
    const verdictAt = entryText(entry, "at");
    const replyAt = reply?.createdAt ?? comment?.createdAt ?? null;
    // Resposta do reviewer posterior ao veredito reabre a thread: "aplicado" que o reviewer contestou volta a ser
    // achado vivo, e pergunta respondida volta a ser acionável.
    const reopened = Boolean(verdictAt && replyAt && replyAt > verdictAt);
    return {
      id: thread.id,
      path: thread.path,
      line: thread.line ?? thread.originalLine ?? null,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      verdict,
      verdictAt,
      reopened,
      handled: Boolean(entry && verdict !== null && TERMINAL_VERDICTS.has(verdict) && !reopened),
      awaitingReviewer: Boolean(entry && verdict !== null && AWAITING_REVIEWER_VERDICTS.has(verdict) && !reopened),
      author: comment?.author?.login ?? null,
      fromBot: isBot(comment?.author),
      commentId: comment?.databaseId ?? null,
      createdAt: comment?.createdAt ?? null,
      commentCount: thread.comments?.totalCount ?? 0,
      lastReplyAt: replyAt,
      lastReplyAuthor: reply?.author?.login ?? null,
      lastReplyFromMe: reply?.author?.login === login,
      ruleCode: ruleCodeOf(rules, comment?.body),
      excerpt: firstLine(comment?.body),
    };
  });
}

// Comentário top-level é o único lugar onde o resumo do bot e os achados fora de hunk existem (`review.md` §4 manda
// mandar achado fora de hunk para o corpo). Bot informa, humano aciona.
function buildTopLevel(node: GqlPullRequest, state: LoopState, login: string, rules: Rules, warnings: Warning[]): TopLevelView[] {
  const declared = node.comments?.totalCount ?? 0;
  const nodes = node.comments?.nodes ?? [];
  if (declared > nodes.length) {
    warnings.push({
      kind: "comments-truncated",
      pr: node.number,
      detail: `${declared} comentarios top-level, ${nodes.length} lidos (teto ${COMMENT_PAGE_SIZE})`,
      impact: "pedido top-level antigo pode ficar fora da coleta",
    });
  }
  return nodes
    .filter((comment) => !comment.isMinimized)
    .filter((comment) => !rules.selfMarkers.some((marker) => marker.test(comment.body ?? "")))
    .filter((comment) => comment.author?.login !== login)
    .map((comment) => {
      const entry = state.comments.get(String(comment.databaseId));
      return {
        commentId: comment.databaseId,
        author: comment.author?.login ?? null,
        fromBot: isBot(comment.author),
        createdAt: comment.createdAt,
        verdict: entryText(entry, "verdict"),
        handled: Boolean(entry),
        ruleCode: ruleCodeOf(rules, comment.body),
        excerpt: firstLine(comment.body),
      };
    });
}

function buildReviews(node: GqlPullRequest, warnings: Warning[]): ReviewView[] {
  const declared = node.reviews?.totalCount ?? 0;
  const nodes = node.reviews?.nodes ?? [];
  if (declared > nodes.length) {
    warnings.push({
      kind: "reviews-truncated",
      pr: node.number,
      detail: `${declared} reviews, ${nodes.length} lidos (teto ${REVIEW_PAGE_SIZE})`,
      impact: "a data do ultimo review pode estar subestimada",
    });
  }
  return nodes.flatMap((review) =>
    review.submittedAt
      ? [{ state: review.state, author: review.author?.login ?? null, fromBot: isBot(review.author), submittedAt: review.submittedAt, hasBody: Boolean((review.body ?? "").trim()) }]
      : [],
  );
}

export function buildPr(node: GqlPullRequest, mergeInfo: MergeInfo | undefined, state: LoopState, login: string, rules: Rules, warnings: Warning[]): PrView {
  const commit = node.commits?.nodes?.[0]?.commit ?? null;
  const lastPushAt = commit?.committedDate ?? null;
  const threads = buildThreads(node, state, login, rules, warnings);
  const topLevel = buildTopLevel(node, state, login, rules, warnings);

  const open = threads.filter((thread) => !thread.isResolved && !thread.handled);
  const live = open.filter((thread) => !thread.isOutdated && !thread.awaitingReviewer);
  const triage = open.filter((thread) => thread.isOutdated && !thread.awaitingReviewer);
  const awaitingReviewer = open.filter((thread) => thread.awaitingReviewer);

  const reviews = buildReviews(node, warnings);
  const lastReviewAt = reviews.reduce((max, review) => (review.submittedAt > max ? review.submittedAt : max), "");
  const seenValue = state.lastSeenReview.get(String(node.number));
  const seenReviewAt = typeof seenValue === "string" ? seenValue : "";
  const reviewedSincePush = Boolean(lastPushAt && lastReviewAt && lastReviewAt > lastPushAt);
  // Review já visto não reacende `needs-response`: approve sem comentário deixaria a PR eternamente acionável, e o loop
  // giraria sem nada para fazer.
  const unseenReviewSincePush = reviewedSincePush && lastReviewAt > seenReviewAt;
  const reviewRequested = (node.reviewRequests?.totalCount ?? 0) > 0;

  const candidate: Candidate = {
    number: node.number,
    title: node.title,
    url: node.url,
    author: node.author?.login ?? null,
    isDraft: node.isDraft,
    baseRefName: node.baseRefName,
    headRefName: node.headRefName,
    headRefOid: node.headRefOid,
    reviewDecision: node.reviewDecision || null,
    mergeable: node.mergeable ?? "UNKNOWN",
    mergeStateStatus: mergeInfo?.mergeStateStatus ?? "UNKNOWN",
    labels: mergeInfo?.labels ?? [],
    stacked: node.baseRefName !== rules.base,
    // o bot dispara por issue_comment e só checa a base; o CI exige a base dele E (salvo perfil) não-draft.
    claudeEligible: rules.botBases.includes(node.baseRefName),
    ciEligible: rules.ciBases.includes(node.baseRefName) && (rules.ciDraft || !node.isDraft),
    lastPushAt,
    lastReviewAt: lastReviewAt || null,
    lastSeenReviewAt: seenReviewAt || null,
    reviewedSincePush,
    unseenReviewSincePush,
    threadTotal: node.reviewThreads?.totalCount ?? threads.length,
    unresolved: open.length,
    checks: summarizeChecks(commit, warnings, node.number),
    specIds: idsFrom(rules.specId, node.body, (id) => id),
    cardIds: idsFrom(rules.cardId, `${node.title}\n${node.headRefName}`, (id) => id.toUpperCase()),
    lastClaudeTrigger: state.claudeTrigger.get(String(node.number)) ?? null,
    live,
    triage,
    awaitingReviewer,
    topLevel,
    topLevelLive: topLevel.filter((comment) => !comment.fromBot && !comment.handled),
    ciReviewSummary: topLevel.filter((comment) => comment.fromBot).at(-1) ?? null,
    threads,
    reviews,
  };
  return { ...candidate, state: classify(candidate, rules, reviewRequested) };
}

/** Pai (PR cuja head é a base desta) e profundidade na pilha de cada PR; ciclo para de contar. */
export function applyStacks(prs: PrView[]): void {
  const byHead = new Map(prs.map((pr) => [pr.headRefName, pr]));
  for (const pr of prs) {
    let depth = 0;
    let cursor = byHead.get(pr.baseRefName);
    const seen = new Set([pr.number]);
    while (cursor && !seen.has(cursor.number)) {
      seen.add(cursor.number);
      depth += 1;
      cursor = byHead.get(cursor.baseRefName);
    }
    pr.stackParent = byHead.get(pr.baseRefName)?.number ?? null;
    pr.stackDepth = depth;
  }
}

export function sortPrs(prs: PrView[]): void {
  prs.sort((a, b) => {
    const byState = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
    if (byState !== 0) return byState;
    if ((a.stackDepth ?? 0) !== (b.stackDepth ?? 0)) return (a.stackDepth ?? 0) - (b.stackDepth ?? 0);
    return a.number - b.number;
  });
}

export interface Report {
  repo: string;
  login: string;
  scope: string;
  project: string | null;
  profile: string | null;
  stateSources: string[];
  stateVersion: number | null;
  workDir: string;
  totals: { live: number; triage: number; awaitingReviewer: number; topLevelLive: number; unresolved: number };
  requestedMissing: number[];
  warnings: Warning[];
  prs: PrView[];
}

export function totalsOf(prs: PrView[]): Report["totals"] {
  const sum = (count: (pr: PrView) => number): number => prs.reduce((total, pr) => total + count(pr), 0);
  return {
    live: sum((pr) => pr.live.length),
    triage: sum((pr) => pr.triage.length),
    awaitingReviewer: sum((pr) => pr.awaitingReviewer.length),
    topLevelLive: sum((pr) => pr.topLevelLive.length),
    unresolved: sum((pr) => pr.unresolved),
  };
}

function checksCell(checks: ChecksSummary): string {
  if (checks.failing.length) return `F${checks.failing.length}`;
  if (checks.pending.length) return `P${checks.pending.length}`;
  return checks.verdict === "none" ? "--" : "ok";
}

function truncated(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}~` : text;
}

export function renderTable(report: Report, rules: Rules): string {
  const lines: string[] = [];
  lines.push(`repo ${report.repo}   login ${report.login}   escopo ${report.scope}   PRs ${report.prs.length}`);
  lines.push("");
  lines.push("  #     estado          d base                          viva tri esp top tot  chk  dec              titulo");
  for (const pr of report.prs) {
    const flags = [pr.isDraft ? "D" : "-", pr.stacked ? "S" : "-"].join("");
    lines.push(
      [
        String(pr.number).padStart(5),
        pr.state.padEnd(15),
        flags,
        truncated(pr.baseRefName, TABLE_BASE_WIDTH).padEnd(TABLE_BASE_WIDTH),
        String(pr.live.length).padStart(4),
        String(pr.triage.length).padStart(3),
        String(pr.awaitingReviewer.length).padStart(3),
        String(pr.topLevelLive.length).padStart(3),
        String(pr.threadTotal).padStart(3),
        checksCell(pr.checks).padStart(4),
        (pr.reviewDecision ?? "-").padEnd(17),
        truncated(pr.title, TABLE_TITLE_WIDTH),
      ].join(" "),
    );
  }
  lines.push("");
  lines.push(`flags: D=draft S=empilhada (base != ${String(rules.base)}: sem ${rules.ciName}${rules.botName ? ` e sem ${rules.botName}` : ""})`);
  lines.push("colunas: viva=acionavel  tri=a triar  esp=esperando reviewer  top=comentario top-level");
  lines.push(
    `totais: viva ${report.totals.live}  triagem ${report.totals.triage}  esperando ${report.totals.awaitingReviewer}` +
      `  top-level ${report.totals.topLevelLive}  threads abertas ${report.totals.unresolved}`,
  );
  for (const state of STATE_ORDER) {
    const numbers = report.prs.filter((pr) => pr.state === state).map((pr) => pr.number);
    if (numbers.length > 0) lines.push(`  ${state.padEnd(15)} ${numbers.join(", ")}`);
  }
  const actionable = report.prs.filter((pr) => pr.live.length > 0 || pr.topLevelLive.length > 0);
  if (actionable.length > 0) {
    lines.push("");
    lines.push("achados vivos (thread: isResolved=false AND isOutdated=false; top: comentario top-level humano):");
    for (const pr of actionable) {
      for (const thread of pr.live) {
        lines.push(`  #${pr.number} ${thread.path}:${thread.line ?? "?"} [${thread.ruleCode ?? "-"}] ${thread.author}: ${thread.excerpt}`);
      }
      for (const comment of pr.topLevelLive) {
        lines.push(`  #${pr.number} (top-level) [${comment.ruleCode ?? "-"}] ${comment.author}: ${comment.excerpt}`);
      }
    }
  }
  if (report.requestedMissing.length) {
    lines.push("");
    lines.push(`PRs pedidas e fora do escopo aberto: ${report.requestedMissing.join(", ")}`);
  }
  if (report.warnings.length) {
    lines.push("");
    lines.push('avisos (dado cortado ou indisponivel — vazio aqui NAO significa "nada a fazer"):');
    for (const warning of report.warnings) {
      lines.push(`  ${warning.kind}${warning.pr ? ` #${warning.pr}` : ""}: ${warning.detail}`);
    }
  }
  return lines.join("\n");
}
