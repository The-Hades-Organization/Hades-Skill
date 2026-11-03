// Diário de eventos por agente (reference/journal.md): JSONL em <raiz de trabalho>/journal/<agente>.jsonl, uma linha por
// evento. Escrito pelo hook (guard), pelo watch, pelo gate-lock e pelo Cerberus; lido pelo `hades journal`, pelo painel
// e pelas unidades que consomem (Argos, Thanatos), que só leem.
//
// Roda no hook de toda ferramenta de toda sessão: só imports baratos (nada de work.ts, config.ts, proc.ts) e o lock vem
// do libc carregado sob demanda. Gravar nunca falha nem atrasa o hook: erro de disco ou de lock é engolido e contado.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LOCK_EX, LOCK_NB, LOCK_UN, sysFlock } from "./flock.ts";
import { firstLine, readText } from "./fs.ts";
import { hadesHome } from "./paths.ts";

export const JOURNAL_VERSION = 1;
export const JOURNAL_SOURCES = ["guard", "watch", "gate", "cerberus", "orch"] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

/** Uma linha do diário. Contrato versionado: campo novo só se acrescenta; mudar o sentido de um campo é `v` novo. */
export interface JournalEvent {
  v: number;
  /** instante em UTC, ISO 8601 com Z */
  ts: string;
  /** nome do agente registrado; "" quando a sessão não casa com nenhum */
  agent: string;
  session: string;
  source: JournalSource;
  kind: string;
  tool?: string;
  summary: string;
  cwd: string;
  /** só em `kind: decision` (hades agent decide): o que o resumo, que corta em 200 colunas, não carrega inteiro */
  decision?: DecisionFields;
}

export interface DecisionFields {
  level: number;
  needed: number;
  question: string;
  chosen: string;
  alternatives: string[];
}

export interface JournalSettings {
  enabled: boolean;
  days: number;
  maxBytes: number;
}

export const DEFAULT_DAYS = 14;
export const DEFAULT_MAX_MB = 20;
const MIB = 1048576;
const SUMMARY_MAX = 200;
const PROMPT_HEAD_MAX = 60;
const LINE_MAX_BYTES = 3500;
const READ_TAIL_BYTES = 8 * MIB;
const LOCK_TRIES = 3;
const LOCK_RETRY_MS = 1;
const DROPPED_FILE_MAX = 65536;
export const AGENT_NAME = /^[\w.-]{1,80}$/;
export const SESSIONS_DIR = "_sessions";
const MACHINE_DIR = "_maquina";

// ------------------------------------------------------------------ configuração

/** HADES_JOURNAL_* do config.tsv; valor fora do intervalo cai no padrão (o catálogo já valida na escrita). */
export function journalSettings(get: (key: string) => string | undefined): JournalSettings {
  const int = (key: string, fallback: number, min: number, max: number): number => {
    const n = Number.parseInt((get(key) ?? "").trim(), 10);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    enabled: (get("HADES_JOURNAL") ?? "1").trim() !== "0",
    days: int("HADES_JOURNAL_DAYS", DEFAULT_DAYS, 1, 3650),
    maxBytes: int("HADES_JOURNAL_MAX_MB", DEFAULT_MAX_MB, 1, 1024) * MIB,
  };
}

export function journalWorkRoot(): string {
  if (process.env.HADES_WORK_ROOT) return process.env.HADES_WORK_ROOT;
  const root = firstLine(join(hadesHome(), "work-root")).trim();
  return root || join(hadesHome(), "work");
}

// ------------------------------------------------------------------ mascaramento

const MASK = "***";
const SECRET_RULES: [RegExp, string][] = [
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, MASK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, `$1${MASK}@`],
  [/(--?[\w-]*(?:token|secret|passw(?:or)?d|passwd|senha|api-?key|credential)[\w-]*)(=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1$2${MASK}`],
  [/\b([\w.-]*(?:token|secret|passw(?:or)?d|passwd|senha|api_?key|apikey|credential|private_?key)[\w.-]*)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"';&|]+)/gi, `$1$2${MASK}`],
];

/** Troca por *** o que parece segredo: prefixos conhecidos de token, Bearer, usuário:senha@ em URL, flags e variáveis com nome de segredo. */
export function maskSecrets(text: string): string {
  let masked = text;
  for (const [rx, to] of SECRET_RULES) masked = masked.replace(rx, to);
  return masked;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Comando do Bash para o resumo: sem o corpo de heredoc, em uma linha, mascarado e depois truncado (nunca o contrário). */
export function summarizeCommand(command: string): string {
  const heredoc = command.indexOf("<<");
  const head = heredoc < 0 ? command : `${command.slice(0, heredoc)}<<…`;
  return clip(maskSecrets(head), SUMMARY_MAX);
}

// ------------------------------------------------------------------ evento do hook

type Dict = Record<string, unknown>;
const PATH_TOOLS: Record<string, string[]> = {
  Read: ["file_path"],
  Edit: ["file_path"],
  Write: ["file_path"],
  NotebookEdit: ["notebook_path", "file_path"],
};

const isObject = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function toolSummary(tool: string, input: Dict): string {
  if (tool === "Bash") return summarizeCommand(str(input.command));
  const keys = PATH_TOOLS[tool];
  if (keys) {
    const path = keys.map((k) => str(input[k])).find((p) => p !== "");
    if (path) return clip(maskSecrets(path), SUMMARY_MAX);
  }
  return tool;
}

/** PostToolUse: ok, a menos que a ferramenta diga que falhou; a saída nunca entra. */
function toolFailed(response: unknown): boolean {
  if (!isObject(response)) return false;
  return response.is_error === true || response.success === false || (typeof response.error === "string" && response.error !== "");
}

const PERMISSION_TOOL = /\buse\s+([A-Za-z][\w:.-]*)/i;

/** Evento do diário a partir do JSON que o Claude Code entrega ao hook; undefined para evento que não gravamos. */
export function eventOfHook(input: Dict, agent: string, now: Date): JournalEvent | undefined {
  const base = { v: JOURNAL_VERSION, ts: now.toISOString(), agent, session: str(input.session_id), source: "guard" as const, cwd: str(input.cwd) };
  const tool = str(input.tool_name);
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  switch (str(input.hook_event_name)) {
    case "PreToolUse":
      return { ...base, kind: "tool_pre", tool, summary: toolSummary(tool, toolInput) };
    case "PostToolUse":
      return { ...base, kind: "tool_post", tool, summary: `${toolFailed(input.tool_response) ? "erro" : "ok"}: ${toolSummary(tool, toolInput)}` };
    case "Notification": {
      const message = str(input.message);
      const type = str(input.notification_type);
      if (type === "permission_prompt" || /permiss|permission/i.test(message)) {
        const asked = PERMISSION_TOOL.exec(message)?.[1];
        return { ...base, kind: "permission", ...(asked ? { tool: asked } : {}), summary: `permissão pendente${asked ? `: ${asked}` : ""}` };
      }
      return { ...base, kind: "notification", summary: clip(maskSecrets(message), SUMMARY_MAX) };
    }
    case "Stop":
      return { ...base, kind: "stop", summary: "fim do turno" };
    case "UserPromptSubmit": {
      const prompt = str(input.prompt);
      return { ...base, kind: "prompt", summary: `${prompt.length} caracteres: ${clip(maskSecrets(prompt.slice(0, PROMPT_HEAD_MAX * 4)), PROMPT_HEAD_MAX)}` };
    }
    default:
      return undefined;
  }
}

/** O guard barrou a chamada: o mesmo evento vira `tool_blocked`, com a razão (primeira linha, mascarada) antes do comando. */
export function markBlocked(event: JournalEvent, reason: string): JournalEvent {
  const why = clip(maskSecrets(reason.split("\n")[0] ?? ""), SUMMARY_MAX / 2);
  return { ...event, kind: "tool_blocked", summary: clip(`${why} | ${event.summary}`, SUMMARY_MAX) };
}

/** Evento das outras fontes (watch, gate, cerberus); o resumo passa pelo mascaramento como o do hook. */
export function eventOfSource(source: JournalSource, kind: string, summary: string, fields: { agent?: string; session?: string; cwd?: string; now: Date; decision?: DecisionFields }): JournalEvent {
  return {
    v: JOURNAL_VERSION, ts: fields.now.toISOString(), agent: fields.agent ?? "", session: fields.session ?? "", source, kind,
    summary: clip(maskSecrets(summary), SUMMARY_MAX), cwd: fields.cwd ?? "",
    ...(fields.decision ? { decision: maskDecision(fields.decision) } : {}),
  };
}

const DECISION_FIELD_MAX = 200;
const DECISION_ALTERNATIVES_MAX = 5;

function maskDecision(d: DecisionFields): DecisionFields {
  const field = (text: string): string => clip(maskSecrets(text), DECISION_FIELD_MAX);
  return {
    level: d.level, needed: d.needed, question: field(d.question), chosen: field(d.chosen),
    alternatives: d.alternatives.slice(0, DECISION_ALTERNATIVES_MAX).map(field),
  };
}

// ------------------------------------------------------------------ agente da sessão

export interface AgentHome {
  agent: string;
  /** <raiz>/<projeto>/journal */
  dir: string;
}

function readObject(path: string): Dict | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    const doc: unknown = JSON.parse(text);
    return isObject(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Agente registrado cuja worktree contém o cwd (o mesmo critério do papel no hook); undefined se nenhum casa. */
export function agentOfCwd(cwd: string, root: string = journalWorkRoot()): AgentHome | undefined {
  if (!cwd) return undefined;
  for (const project of listNames(root)) {
    const agents = join(root, project, "orchestration", "agents");
    for (const name of listNames(agents)) {
      if (!name.endsWith(".json")) continue;
      const reg = readObject(join(agents, name));
      const worktree = reg === undefined ? "" : str(reg.worktree);
      if (!reg || reg.state === "done" || !worktree || !(cwd === worktree || cwd.startsWith(`${worktree}/`))) continue;
      const agent = name.slice(0, -".json".length);
      if (AGENT_NAME.test(agent)) return { agent, dir: join(root, project, "journal") };
    }
  }
  return undefined;
}

/** Destino da linha: o arquivo do agente, ou o da sessão quando ela não casa com agente registrado. */
export function journalTarget(event: JournalEvent, home: AgentHome | undefined, root: string): string {
  if (home) return join(home.dir, `${home.agent}.jsonl`);
  const session = event.session.replace(/[^A-Za-z0-9_-]/g, "") || "x";
  return join(root, MACHINE_DIR, "journal", SESSIONS_DIR, `${session}.jsonl`);
}

// ------------------------------------------------------------------ lock (libc sob demanda)

// sysFlock só faz o dlopen quando alguém grava: o caminho do hook que não grava (diário desligado) não paga por ele
const flock = sysFlock;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Lock exclusivo sem esperar além de LOCK_TRIES × LOCK_RETRY_MS; false se outro processo o segurou o tempo todo. */
function withLockBounded(path: string, fn: () => void): boolean {
  const fd = openSync(path, "a");
  try {
    const lock = flock();
    for (let i = 0; i < LOCK_TRIES; i += 1) {
      if (lock(fd, LOCK_EX | LOCK_NB) === 0) {
        try {
          fn();
        } finally {
          lock(fd, LOCK_UN);
        }
        return true;
      }
      if (i + 1 < LOCK_TRIES) sleepMs(LOCK_RETRY_MS);
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

function withLockBlocking<T>(path: string, fn: () => T): T {
  const fd = openSync(path, "a");
  try {
    const lock = flock();
    if (lock(fd, LOCK_EX) !== 0) throw new Error(`flock falhou em ${path}`);
    try {
      return fn();
    } finally {
      lock(fd, LOCK_UN);
    }
  } finally {
    closeSync(fd);
  }
}

// ------------------------------------------------------------------ escrita

let droppedInProcess = 0;
/** Quantas linhas este processo deixou de gravar (disco, permissão, lock ocupado). */
export const droppedCount = (): number => droppedInProcess;

/** Anota a perda ao lado do diário, se ainda der; nunca lança. */
function noteDrop(dir: string, reason: string, now: Date): void {
  droppedInProcess += 1;
  try {
    const file = join(dir, ".dropped");
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      size = 0;
    }
    if (size < DROPPED_FILE_MAX) appendFileSync(file, `${now.toISOString()}\t${reason.replace(/\s+/g, " ").slice(0, 120)}\n`);
  } catch {
    // sem disco para anotar a perda: ela já foi contada em memória
  }
}

export function rotatedName(file: string): string {
  return file.replace(/\.jsonl$/, ".1.jsonl");
}

/** Uma linha no arquivo do alvo, com rotação no teto. Devolve false (e conta) se não gravou; nunca lança. */
export function appendEvent(event: JournalEvent, target: string, settings: JournalSettings, now: Date = new Date()): boolean {
  if (!settings.enabled) return false;
  const dir = target.slice(0, target.lastIndexOf("/"));
  try {
    let line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line) > LINE_MAX_BYTES) line = `${JSON.stringify({ ...event, summary: clip(event.summary, 80) })}\n`;
    mkdirSync(dir, { recursive: true });
    const wrote = withLockBounded(join(dir, ".lock"), () => {
      let size = 0;
      try {
        size = statSync(target).size;
      } catch {
        size = 0;
      }
      if (size >= settings.maxBytes) renameSync(target, rotatedName(target));
      appendFileSync(target, line);
    });
    if (!wrote) noteDrop(dir, "lock ocupado", now);
    return wrote;
  } catch (error) {
    noteDrop(dir, error instanceof Error ? error.message : String(error), now);
    return false;
  }
}

/** Grava um evento de fonte que não é o hook (watch, gate, cerberus): o agente vem dado ou do cwd. Nunca lança. */
export function emitJournal(
  source: Exclude<JournalSource, "guard">, kind: string, summary: string,
  options: { agent?: string; cwd?: string; get: (key: string) => string | undefined; now?: Date; root?: string; decision?: DecisionFields },
): boolean {
  try {
    const settings = journalSettings(options.get);
    if (!settings.enabled) return false;
    const now = options.now ?? new Date();
    const root = options.root ?? journalWorkRoot();
    const cwd = options.cwd ?? process.cwd();
    const named = options.agent !== undefined && AGENT_NAME.test(options.agent) ? options.agent : undefined;
    const home = named ? agentHomeByName(named, root) : agentOfCwd(cwd, root);
    const event = eventOfSource(source, kind, summary, { agent: home?.agent ?? "", session: home ? "" : `_${source}`, cwd, now, decision: options.decision });
    return appendEvent(event, journalTarget(event, home, root), settings, now);
  } catch {
    droppedInProcess += 1;
    return false;
  }
}

/** Pasta do diário do agente pelo nome (o watch conhece o agente, não o cwd dele). */
export function agentHomeByName(agent: string, root: string = journalWorkRoot()): AgentHome | undefined {
  for (const project of listNames(root)) {
    try {
      if (statSync(join(root, project, "orchestration", "agents", `${agent}.json`)).isFile()) return { agent, dir: join(root, project, "journal") };
    } catch {
      continue;
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ leitura

const isSource = (v: unknown): v is JournalSource => (JOURNAL_SOURCES as readonly unknown[]).includes(v);

function parseDecision(value: unknown): DecisionFields | undefined {
  if (!isObject(value) || typeof value.level !== "number" || typeof value.needed !== "number") return undefined;
  const alternatives = Array.isArray(value.alternatives) ? value.alternatives.filter((a): a is string => typeof a === "string") : [];
  return { level: value.level, needed: value.needed, question: str(value.question), chosen: str(value.chosen), alternatives };
}

/** Linha do diário já validada na fronteira; undefined se cortada (disco cheio) ou fora do formato. */
export function parseEvent(line: string): JournalEvent | undefined {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(row) || typeof row.v !== "number" || typeof row.ts !== "string" || !isSource(row.source)) return undefined;
  if (typeof row.kind !== "string" || typeof row.summary !== "string" || Number.isNaN(Date.parse(row.ts))) return undefined;
  return {
    v: row.v, ts: row.ts, agent: str(row.agent), session: str(row.session), source: row.source, kind: row.kind,
    ...(typeof row.tool === "string" ? { tool: row.tool } : {}), summary: row.summary, cwd: str(row.cwd),
    ...(parseDecision(row.decision) ? { decision: parseDecision(row.decision) } : {}),
  };
}

/** Os últimos `maxBytes` do arquivo, sem a primeira linha se o corte caiu no meio dela. */
export function readTailText(file: string, maxBytes: number = READ_TAIL_BYTES): string {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

export interface JournalFile {
  agent: string;
  project: string;
  file: string;
}

/** Diários existentes: <raiz>/<projeto>/journal/<agente>.jsonl (as gerações .1 vêm junto) e as sessões sem agente. */
export function journalFiles(root: string = journalWorkRoot(), includeSessions = false): JournalFile[] {
  const found: JournalFile[] = [];
  for (const project of listNames(root)) {
    const dir = join(root, project, "journal");
    const dirs = includeSessions ? [dir, join(dir, SESSIONS_DIR)] : [dir];
    for (const d of dirs) {
      for (const name of listNames(d)) {
        if (!name.endsWith(".jsonl")) continue;
        const agent = name.replace(/(\.1)?\.jsonl$/, "");
        if (AGENT_NAME.test(agent)) found.push({ agent: d.endsWith(SESSIONS_DIR) ? `${SESSIONS_DIR}/${agent}` : agent, project, file: join(d, name) });
      }
    }
  }
  return found;
}

export interface JournalQuery {
  agent?: string;
  sinceMs?: number;
  kind?: string;
  limit: number;
}

/** `--kind tool`: casa `tool_pre`/`tool_post` e o prefixo antes do ponto (`gate` casa `gate.done`); o valor exato também. */
export function kindMatches(kind: string, wanted: string): boolean {
  return kind === wanted || kind.startsWith(`${wanted}.`) || kind.startsWith(`${wanted}_`);
}

/** Os `limit` eventos mais recentes que casam, em ordem de tempo. Lê só o fim de cada arquivo. */
export function readEvents(query: JournalQuery, root: string = journalWorkRoot()): JournalEvent[] {
  const events: JournalEvent[] = [];
  const sessions = query.agent?.startsWith(`${SESSIONS_DIR}/`) ?? false;
  for (const entry of journalFiles(root, sessions)) {
    if (query.agent !== undefined && entry.agent !== query.agent) continue;
    for (const line of readTailText(entry.file).split("\n")) {
      if (line === "") continue;
      const event = parseEvent(line);
      if (!event) continue;
      if (query.sinceMs !== undefined && Date.parse(event.ts) < query.sinceMs) continue;
      if (query.kind !== undefined && !kindMatches(event.kind, query.kind)) continue;
      events.push(event);
    }
  }
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return events.slice(-query.limit);
}

const DAY_MS = 86_400_000;
const DURATION = /^(\d+)\s*([smhd])$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `--since`: duração (30m, 2h, 1d) ou instante ISO com fuso; undefined se não entende (quem chama recusa). */
export function parseSince(text: string, now: Date): number | undefined {
  const dur = DURATION.exec(text.trim());
  if (dur) return now.getTime() - Number(dur[1]) * (UNIT_MS[dur[2] as string] as number);
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text.trim())) return undefined;
  const at = Date.parse(text.trim());
  return Number.isNaN(at) ? undefined : at;
}

export interface JournalSummary {
  agent: string;
  project: string;
  events: number;
  bytes: number;
  last: string;
}

/** `hades journal list`: um item por agente (arquivo vivo e geração .1 somados). */
export function listJournals(root: string = journalWorkRoot()): JournalSummary[] {
  const byAgent = new Map<string, JournalSummary>();
  for (const entry of journalFiles(root, true)) {
    const key = `${entry.project}/${entry.agent}`;
    const item = byAgent.get(key) ?? { agent: entry.agent, project: entry.project, events: 0, bytes: 0, last: "" };
    const text = readTailText(entry.file, MIB);
    const lines = text.split("\n").filter((l) => l !== "");
    item.events += lines.length;
    try {
      item.bytes += statSync(entry.file).size;
    } catch {
      item.bytes += 0;
    }
    if (!basename(entry.file).endsWith(".1.jsonl")) {
      const last = [...lines].reverse().map(parseEvent).find((e) => e !== undefined);
      if (last) item.last = last.ts;
    }
    byAgent.set(key, item);
  }
  return [...byAgent.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}

// ------------------------------------------------------------------ retenção

export interface PruneResult {
  removed: number;
  rewritten: number;
  bytes: number;
  /** o que a limpeza faz (ou faria, no dryRun) em cada arquivo */
  items: { file: string; action: "apaga" | "reescreve"; bytes: number }[];
}

/** Apaga o arquivo parado há mais que `days` e tira de dentro dos vivos as linhas mais velhas que o corte. Idempotente. */
export function pruneJournals(days: number, now: Date = new Date(), root: string = journalWorkRoot(), dryRun = false): PruneResult {
  const cutoff = now.getTime() - days * DAY_MS;
  const result: PruneResult = { removed: 0, rewritten: 0, bytes: 0, items: [] };
  for (const entry of journalFiles(root, true)) {
    let stat;
    try {
      stat = statSync(entry.file);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoff) {
      result.removed += 1;
      result.bytes += stat.size;
      result.items.push({ file: entry.file, action: "apaga", bytes: stat.size });
      if (!dryRun) unlinkQuiet(entry.file);
      continue;
    }
    const { dropped, bytes } = recentSplit(readText(entry.file) ?? "", cutoff);
    if (dropped === 0) continue;
    result.rewritten += 1;
    result.bytes += bytes;
    result.items.push({ file: entry.file, action: "reescreve", bytes });
    if (!dryRun) rewriteLocked(entry.file, cutoff);
  }
  return result;
}

/** Linhas do arquivo em dois grupos: as que ficam (recentes ou ilegíveis) e as que saem, com os bytes destas. */
function recentSplit(text: string, cutoff: number): { kept: string[]; dropped: number; bytes: number } {
  const kept: string[] = [];
  let dropped = 0;
  let bytes = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const at = Date.parse(parseEvent(line)?.ts ?? "");
    if (Number.isNaN(at) || at >= cutoff) kept.push(line);
    else {
      dropped += 1;
      bytes += Buffer.byteLength(line) + 1;
    }
  }
  return { kept, dropped, bytes };
}

function unlinkQuiet(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // já sumiu: outro processo limpou antes
  }
}

/** Relê e filtra dentro do lock do diretório: linha gravada entre a primeira leitura e o lock não se perde. */
function rewriteLocked(file: string, cutoff: number): void {
  const dir = file.slice(0, file.lastIndexOf("/"));
  withLockBlocking(join(dir, ".lock"), () => {
    const { kept } = recentSplit(readText(file) ?? "", cutoff);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "");
    renameSync(tmp, file);
  });
}
