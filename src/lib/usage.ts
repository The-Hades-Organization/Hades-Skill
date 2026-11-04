// Consumo de tokens da máquina a partir dos transcripts locais do Claude Code (hades usage): custo equivalente de API
// por papel de sessão, polling e reescrita de contexto. As expressões de polling vêm de guard-rules.ts (a mesma do hook).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { readText } from "./fs.ts";
import { type GuardRules, isPolling } from "./guard-rules.ts";
import { PyFloat, pyRound } from "./pyjson.ts";

export type Dict = Record<string, unknown>;

export const CACHE_VERSION = 4;
const REWRITE_GAP_SECONDS = 3600;
const REWRITE_MIN_TOKENS = 100_000;
const CACHE_READ_PRICE_SHARE = 0.2e-6;

// US$/MTok: entrada, saída, leitura de cache
const PRICE: Record<string, readonly [number, number, number]> = {
  "opus-5-5": [4, 20, 0.2],
  "sonnet-5-5": [2, 10, 0.2],
  "haiku-5-5": [0.1, 0.5, 0.01],
  "fable-5-1": [10, 50, 0.25],
  "opus-5": [5, 25, 0.5],
  "opus-4-8": [5, 25, 0.5],
  "sonnet-5": [2, 10, 0.2],
};
const MODEL_KEYS = Object.keys(PRICE).sort((a, b) => b.length - a.length);

const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number => (typeof value === "number" ? value : 0);
/** `a or b` do Python: o primeiro valor que não é vazio. */
const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || value === false || value === "" || value === 0
  || (Array.isArray(value) && value.length === 0) || (isDict(value) && Object.keys(value).length === 0);
const orElse = (value: unknown, fallback: unknown): unknown => (isEmpty(value) ? fallback : value);
const text = (value: unknown, fallback: string): string => {
  const picked = orElse(value, fallback);
  return typeof picked === "string" ? picked : fallback;
};

// ---------------------------------------------------------------- uma linha por (sessão, subagente?, dia)

export interface Row {
  session: string;
  sidechain: boolean;
  day: string;
  cwd: string;
  cost: number;
  turns: number;
  poll_turns: number;
  poll_cost: number;
  rewrite_cost: number;
  ctx_sum: number;
  ctx_max: number;
  models: Record<string, number>;
  efforts: Record<string, number>;
  read: number;
  write: number;
  output: number;
  first: string;
  last: string;
  /** Tokens por modelo: [entrada, saída, escrita de cache, leitura de cache]. */
  tok: Record<string, Tok>;
}

export type Tok = readonly [number, number, number, number];

/** Uma requisição: [epoch s, modelo, entrada, saída, escrita de cache, leitura de cache, US$]. Base da calibração dos limites. */
export type Req = readonly [number, string, number, number, number, number, number];

interface Request {
  usage: Dict | undefined;
  model: string | undefined;
  ts: string;
  sid: string;
  side: boolean;
  cwd: string;
  effort: string;
  poll: boolean;
}

export function modelKey(model: unknown): string | undefined {
  const name = (typeof model === "string" ? model : "").replaceAll("claude-", "");
  return MODEL_KEYS.find((key) => name.startsWith(key));
}

/** (custo da requisição, parte de escrita de cache) em US$. */
export function cost(modelKeyName: string, usage: Dict): [number, number] {
  const [inPrice, outPrice, readPrice] = PRICE[modelKeyName] as readonly [number, number, number];
  const creation = isDict(usage.cache_creation) ? usage.cache_creation : {};
  const noBreakdown = Object.keys(creation).length === 0;
  const write5m = noBreakdown ? num(usage.cache_creation_input_tokens) : num(creation.ephemeral_5m_input_tokens);
  const write1h = num(creation.ephemeral_1h_input_tokens);
  const write = (write5m * inPrice * 1.25 + write1h * inPrice * 2) / 1e6;
  const total = (num(usage.input_tokens) * inPrice + num(usage.output_tokens) * outPrice + num(usage.cache_read_input_tokens) * readPrice) / 1e6 + write;
  return [total, write];
}

function newRequest(line: Dict, message: Dict, path: string): Request {
  return {
    usage: isDict(message.usage) ? message.usage : undefined,
    model: modelKey(message.model),
    ts: text(line.timestamp, ""),
    sid: text(line.sessionId, path),
    side: Boolean(line.isSidechain) || path.includes("/subagents/"),
    cwd: text(line.cwd, ""),
    effort: text(line.effort, "?"),
    poll: false,
  };
}

function foregroundPolling(message: Dict, rules: GuardRules): boolean {
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks.some((block) => {
    if (!isDict(block) || block.type !== "tool_use" || block.name !== "Bash" || !isDict(block.input)) return false;
    const command = block.input.command;
    return typeof command === "string" && command !== "" && isPolling(rules, command) && !block.input.run_in_background;
  });
}

function requestsOf(path: string, rules: GuardRules): Request[] {
  const content = readText(path);
  if (content === undefined) return [];
  const requests = new Map<unknown, Request>();
  for (const raw of content.split("\n")) {
    if (!raw.includes('"assistant"')) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isDict(line) || line.type !== "assistant") continue;
    const message = isDict(line.message) ? line.message : {};
    const id = orElse(line.requestId, orElse(message.id, null));
    const request = requests.get(id) ?? newRequest(line, message, path);
    requests.set(id, request);
    if (foregroundPolling(message, rules)) request.poll = true;
  }
  return [...requests.values()];
}

function newRow(request: Request, day: string): Row {
  return {
    session: request.sid, sidechain: request.side, day, cwd: request.cwd, cost: 0, turns: 0, poll_turns: 0, poll_cost: 0,
    rewrite_cost: 0, ctx_sum: 0, ctx_max: 0, models: {}, efforts: {}, read: 0, write: 0, output: 0, first: request.ts, last: request.ts, tok: {},
  };
}

const bump = (counter: Record<string, number>, key: string): void => {
  counter[key] = (counter[key] ?? 0) + 1;
};

export const addTok = (a: Tok | undefined, b: Tok): Tok => (a ? [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]] : b);

/** Agrega um transcript por (sessão, subagente?, dia), na ordem do horário das requisições. */
export function parseFile(path: string, rules: GuardRules): Row[] {
  return parseFileFull(path, rules).rows;
}

/** As linhas de `parseFile` e as requisições com horário (só as de `sinceMs` em diante). */
export function parseFileFull(path: string, rules: GuardRules, sinceMs = 0): { rows: Row[]; reqs: Req[] } {
  const reqs: Req[] = [];
  const rows = new Map<string, Row>();
  const previous = new Map<string, number>();
  const ordered = requestsOf(path, rules).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const request of ordered) {
    if (isEmpty(request.usage) || !request.model || !request.ts) continue;
    const usage = request.usage as Dict;
    const [price, write] = cost(request.model, usage);
    const ctx = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
    const day = request.ts.slice(0, 10);
    const key = JSON.stringify([request.sid, request.side, day]);
    const row = rows.get(key) ?? newRow(request, day);
    rows.set(key, row);
    row.cost += price;
    row.turns += 1;
    row.ctx_sum += ctx;
    row.ctx_max = Math.max(row.ctx_max, ctx);
    row.last = request.ts;
    row.read += num(usage.cache_read_input_tokens);
    row.write += num(usage.cache_creation_input_tokens);
    row.output += num(usage.output_tokens);
    const tok: Tok = [num(usage.input_tokens), num(usage.output_tokens), num(usage.cache_creation_input_tokens), num(usage.cache_read_input_tokens)];
    row.tok[request.model] = addTok(row.tok[request.model], tok);
    const when = Date.parse(request.ts);
    if (when >= sinceMs) reqs.push([Math.floor(when / 1000), request.model, ...tok, price]);
    bump(row.models, request.model);
    bump(row.efforts, request.effort);
    if (request.poll) {
      row.poll_turns += 1;
      row.poll_cost += price;
    }
    const at = Date.parse(request.ts);
    const before = previous.get(request.sid);
    if (before !== undefined && (at - before) / 1000 > REWRITE_GAP_SECONDS && num(usage.cache_creation_input_tokens) > REWRITE_MIN_TOKENS) {
      row.rewrite_cost += write;
    }
    previous.set(request.sid, at);
  }
  return { rows: [...rows.values()], reqs };
}

// ---------------------------------------------------------------- papel da sessão

export interface Agent extends Dict {
  worktree?: unknown;
  role?: unknown;
  name?: unknown;
  pr?: unknown;
}

export type Classified = { role: string; name: unknown; pr: unknown };

/** Pastas de `cwd` para cima, como `Path(cwd)` e `.parents` do Python (o cwd vazio é `.`). */
function chain(cwd: string): string[] {
  const out: string[] = [];
  let current = cwd === "" ? "." : cwd.replace(/\/+$/, "") || "/";
  out.push(current);
  while (current !== "." && current !== "/") {
    current = dirname(current);
    out.push(current);
  }
  return out;
}

export function classify(cwd: string, agents: Agent[], isGitDir: (dir: string) => boolean | undefined): Classified {
  for (const agent of agents) {
    const worktree = typeof agent.worktree === "string" ? agent.worktree : "";
    if (worktree && (cwd === worktree || cwd.startsWith(`${worktree}/`))) {
      return { role: text(agent.role, "impl"), name: agent.name ?? null, pr: agent.pr ?? null };
    }
  }
  if (cwd.includes("/.herdr/worktrees/")) return { role: "agente-nao-registrado", name: cwd.replace(/\/+$/, "").split("/").pop() ?? "", pr: null };
  for (const dir of chain(cwd)) {
    const git = isGitDir(dir);
    if (git !== undefined) return { role: git ? "orchestrator" : "interactive", name: null, pr: null };
  }
  return { role: "interactive", name: null, pr: null };
}

/** `<dir>/.git`: true = pasta (clone principal), false = arquivo (worktree), undefined = não existe. */
export function gitKind(dir: string): boolean | undefined {
  try {
    return statSync(join(dir, ".git")).isDirectory();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- JSON que lembra quem era float

/** JSON.parse que devolve PyFloat para o número escrito como float (`3.0`, `1e3`): o Python o reescreveria assim. */
export function parseKeepingFloats(source: string): unknown {
  let pos = 0;
  const fail = (): never => {
    throw new SyntaxError(`JSON inválido na posição ${pos}`);
  };
  const space = (): void => {
    while (pos < source.length && " \n\r\t".includes(source[pos] as string)) pos += 1;
  };
  const literal = (word: string, value: unknown): unknown => {
    if (!source.startsWith(word, pos)) return fail();
    pos += word.length;
    return value;
  };
  const string = (): string => {
    const start = pos;
    pos += 1;
    while (pos < source.length && source[pos] !== '"') pos += source[pos] === "\\" ? 2 : 1;
    pos += 1;
    return JSON.parse(source.slice(start, pos)) as string;
  };
  const number = (): unknown => {
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(pos));
    if (!match) return fail();
    pos += match[0].length;
    return match[1] || match[2] ? new PyFloat(Number(match[0])) : Number(match[0]);
  };
  const value = (): unknown => {
    space();
    const ch = source[pos];
    if (ch === "{") return object();
    if (ch === "[") return array();
    if (ch === '"') return string();
    if (ch === "t") return literal("true", true);
    if (ch === "f") return literal("false", false);
    if (ch === "n") return literal("null", null);
    return number();
  };
  const array = (): unknown[] => {
    const items: unknown[] = [];
    pos += 1;
    space();
    if (source[pos] === "]") return (pos += 1), items;
    for (;;) {
      items.push(value());
      space();
      if (source[pos] === ",") pos += 1;
      else if (source[pos] === "]") return (pos += 1), items;
      else return fail();
    }
  };
  const object = (): Dict => {
    const members: Dict = {};
    pos += 1;
    space();
    if (source[pos] === "}") return (pos += 1), members;
    for (;;) {
      space();
      if (source[pos] !== '"') return fail();
      const key = string();
      space();
      if (source[pos] !== ":") return fail();
      pos += 1;
      members[key] = value();
      space();
      if (source[pos] === ",") pos += 1;
      else if (source[pos] === "}") return (pos += 1), members;
      else return fail();
    }
  };
  const result = value();
  space();
  if (pos !== source.length) fail();
  return result;
}

// ---------------------------------------------------------------- relatório

const rf = (value: number, digits: number): PyFloat => pyRound(value, digits);
/** O número de um valor que pode ser PyFloat ou int. */
export const plain = (value: unknown): number => (value instanceof PyFloat ? value.value : Number(value));
/** `round(sum(...), n)`: a soma de nada é o int 0 no Python, e round(0, n) segue int. */
const roundedSum = (values: number[], digits: number): PyFloat | 0 => (values.length ? rf(values.reduce((a, b) => a + b, 0), digits) : 0);
/** `format(x, '.<n>f')` do Python (metade vai para o par). */
export const fixed = (value: number, digits: number): string => pyRound(value, digits).value.toFixed(digits);

export interface Totals {
  cost: number;
  turns: number;
  poll_turns: number;
  poll_cost: number;
  rewrite_cost: number;
  ctx_sum: number;
  ctx_max: number;
  read: number;
  write: number;
  output: number;
  /** Tokens por modelo (criado na primeira soma). */
  tok?: Record<string, Tok>;
}
const ZERO: Totals = { cost: 0, turns: 0, poll_turns: 0, poll_cost: 0, rewrite_cost: 0, ctx_sum: 0, ctx_max: 0, read: 0, write: 0, output: 0 };
const SUMMED = ["cost", "turns", "poll_turns", "poll_cost", "rewrite_cost", "ctx_sum", "read", "write", "output"] as const;

function add(into: Totals, row: Row): void {
  for (const key of SUMMED) into[key] += row[key];
  into.ctx_max = Math.max(into.ctx_max, row.ctx_max);
  const tok = (into.tok ??= {});
  for (const [model, value] of Object.entries(row.tok ?? {})) tok[model] = addTok(tok[model], value);
}

/** Valor da chave; criado (e guardado) na primeira vez. */
function slot<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const found = map.get(key);
  if (found !== undefined) return found;
  const made = create();
  map.set(key, made);
  return made;
}

function grouped<K>(rows: Row[], keyOf: (row: Row) => K): Map<K, Totals> {
  const groups = new Map<K, Totals>();
  for (const row of rows) add(slot(groups, keyOf(row), () => ({ ...ZERO })), row);
  return groups;
}

export interface Roles {
  byRole: Map<string, Totals>;
  sessionsByRole: Map<string, number>;
  agents: Map<string, AgentTotals>;
  sessions: Map<string, SessionTotals>;
}
interface AgentTotals extends Totals {
  name: string;
  role: string;
  pr: unknown;
  models: Record<string, number>;
  cwd: string;
}
interface SessionTotals {
  cwd: string;
  role: string;
  side: boolean;
  cost: number;
  turns: number;
  ctx_sum: number;
  ctx_max: number;
}

export function byRoles(rows: Row[], agents: Agent[], isGitDir: (dir: string) => boolean | undefined): Roles {
  const byRole = new Map<string, Totals>();
  const sessions = new Map<string, SessionTotals>();
  const named = new Map<string, AgentTotals>();
  for (const row of rows) {
    const { role, name, pr } = classify(row.cwd, agents, isGitDir);
    const roleKey = role + (row.sidechain ? " · subagente" : "");
    add(slot(byRole, roleKey, () => ({ ...ZERO })), row);
    const sessionKey = JSON.stringify([row.session, row.sidechain]);
    const session = slot(sessions, sessionKey, () => ({ cwd: row.cwd, role, side: row.sidechain, cost: 0, turns: 0, ctx_sum: 0, ctx_max: 0 }));
    session.cost += row.cost;
    session.turns += row.turns;
    session.ctx_sum += row.ctx_sum;
    session.ctx_max = Math.max(session.ctx_max, row.ctx_max);
    if (typeof name === "string" && name !== "") {
      const agent = slot(named, name, (): AgentTotals => ({ ...ZERO, name, role, pr, models: {}, cwd: row.cwd }));
      add(agent, row);
      for (const [model, count] of Object.entries(row.models)) agent.models[model] = (agent.models[model] ?? 0) + count;
    }
  }
  const sessionsByRole = new Map<string, number>();
  for (const session of sessions.values()) {
    const roleKey = session.role + (session.side ? " · subagente" : "");
    sessionsByRole.set(roleKey, (sessionsByRole.get(roleKey) ?? 0) + 1);
  }
  return { byRole, sessionsByRole, agents: named, sessions };
}

const avg = (sum: number, turns: number): number => (turns ? Math.trunc(sum / turns) : 0);
const share = (part: number, whole: number, digits: number): PyFloat | 0 => (whole ? rf((100 * part) / whole, digits) : 0);

interface RoleRow extends Dict {
  cost: PyFloat;
}

/** Campos de % de 5 h e semanal de um conjunto de tokens por modelo (a conta é da calibração, em limites.ts). */
export type PctOf = (tok: Record<string, Tok> | undefined) => Dict;

export function roleRow(role: string, totals: Totals, sessions: number, grand: number): RoleRow {
  return {
    role, sessions, cost: rf(totals.cost, 2), share: rf((100 * totals.cost) / grand, 1), turns: totals.turns,
    pollCost: rf(totals.poll_cost, 2), pollShare: share(totals.poll_cost, totals.cost, 1), rewriteCost: rf(totals.rewrite_cost, 2),
    ctxAvg: avg(totals.ctx_sum, totals.turns), ctxMax: totals.ctx_max,
    readShare: totals.cost ? rf((100 * totals.read * CACHE_READ_PRICE_SHARE) / totals.cost, 1) : 0,
  };
}

const byCostDesc = (a: { cost: PyFloat }, b: { cost: PyFloat }): number => b.cost.value - a.cost.value;

export interface Report extends Dict {
  generatedAt: string;
  days: number;
  since: string;
}

export function buildReport(rows: Row[], roles: Roles, days: number, since: string, generatedAt: string, pctOf?: PctOf): Report {
  const pcts: PctOf = pctOf ?? (() => ({}));
  const sum = (key: "cost" | "turns" | "poll_cost" | "rewrite_cost" | "read" | "write" | "output"): number => rows.reduce((acc, row) => acc + row[key], 0);
  const grand = sum("cost") || 1;
  const byDay = [...grouped(rows, (row) => row.day)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const byRole = [...roles.byRole].map(([role, totals]) => ({ ...roleRow(role, totals, roles.sessionsByRole.get(role) ?? 0, grand), ...pcts(totals.tok) }));
  const byAgent = [...roles.agents.values()].map((agent) => ({
    name: agent.name, role: agent.role, pr: agent.pr, cost: rf(agent.cost, 2), turns: agent.turns, poll_cost: rf(agent.poll_cost, 2),
    rewrite_cost: rf(agent.rewrite_cost, 2), ctx_max: agent.ctx_max, models: agent.models, cwd: agent.cwd, ctxAvg: avg(agent.ctx_sum, agent.turns), ...pcts(agent.tok),
  }));
  const topSessions = [...roles.sessions.values()].map((s) => ({
    cwd: s.cwd, role: s.role, subagent: s.side, cost: rf(s.cost, 2), turns: s.turns, ctxAvg: avg(s.ctx_sum, s.turns), ctxMax: s.ctx_max,
  }));
  return {
    generatedAt, days, since,
    note: "custo equivalente de API (US$/MTok: Opus 5.5 4/20, Sonnet 5.5 2/10, leitura de cache 0,20 nos dois)",
    total: {
      cost: roundedSum(rows.map((r) => r.cost), 2), turns: sum("turns"), pollCost: roundedSum(rows.map((r) => r.poll_cost), 2),
      rewriteCost: roundedSum(rows.map((r) => r.rewrite_cost), 2),
      read: sum("read"), write: sum("write"), output: sum("output"),
    },
    byRole: byRole.sort(byCostDesc),
    byDay: byDay.map(([day, t]) => ({ day, cost: rf(t.cost, 2), pollCost: rf(t.poll_cost, 2), turns: t.turns, ...pcts(t.tok) })),
    byAgent: byAgent.sort(byCostDesc),
    topSessions: topSessions.sort(byCostDesc).slice(0, 15),
  };
}

/** Linha de base gravada por `--baseline`: o relatório da janela mais o que a compara depois. */
export function baselineOf(report: Report, days: number): Dict {
  return { ...report, savedAt: report.generatedAt, perDay: rf(plain((report.total as Dict).cost) / Math.max(1, days), 2) };
}

/** Acrescenta ao relatório a comparação com a linha de base; arquivo ausente ou fora do formato: sem comparação. */
export function withBaseline(report: Report, baselineText: string | undefined, days: number): void {
  if (baselineText === undefined) return;
  let parsed: unknown;
  try {
    parsed = parseKeepingFloats(baselineText);
  } catch {
    return;
  }
  if (!isDict(parsed) || !Array.isArray(parsed.byRole)) return;
  const byRole: Dict = {};
  for (const entry of parsed.byRole) {
    if (!isDict(entry) || !("role" in entry) || !("cost" in entry) || !("ctxAvg" in entry) || !("pollShare" in entry)) return;
    byRole[String(entry.role)] = { cost: entry.cost, ctxAvg: entry.ctxAvg, pollShare: entry.pollShare };
  }
  if (!("savedAt" in parsed) || !("perDay" in parsed) || !("days" in parsed)) return;
  report.baseline = { savedAt: parsed.savedAt, perDay: parsed.perDay, days: parsed.days, byRole };
  report.perDay = rf(plain((report.total as Dict).cost) / Math.max(1, days), 2);
}

/** Transcripts (arquivos .jsonl em qualquer nível) de uma pasta, sem seguir links simbólicos, em ordem estável. */
export function transcriptsIn(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

export function readFileOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
