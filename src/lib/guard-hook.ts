// Hook da Hades (PreToolUse e PostToolUse), registrado no ~/.claude/settings.json de toda sessão do Claude Code.
// Antes era hades guard; o ponto de entrada é src/hook.ts (o settings.json chama o Bun direto) e
// `hades guard`. As expressões moram em loop/hooks/guard-rules.json, fonte única também do `hades usage`.
//
// O hook também alimenta o diário de eventos por agente (src/lib/journal.ts) em todo evento que recebe.
//
// PreToolUse (Bash): barra test/lint/build fora da fila do gate-lock e polling (sleep de espera, laço com sleep, tail -f,
// --watch em primeiro plano, a mesma checagem repetida). PreToolUse (Bash, Read): avisa, sem barrar, leitura inteira de
// arquivo acima de HADES_READ_WARN_KB. PostToolUse: teto de contexto por papel — acima dele, o agente orquestrado grava
// o handoff e para; a sessão interativa recebe o aviso para /clear.
//
// Regras da MÁQUINA valem em toda sessão, com ou sem perfil (fila de gates, polling, teto de contexto). Regra de PROJETO
// (o papel orchestrator) só vale num repo com perfil. Saída: exit 2 + stderr barra a ferramenta; JSON
// hookSpecificOutput.additionalContext injeta a instrução.
import { closeSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync, writeFileSync, fstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readText, firstLine, isFile, isDir } from "./fs.ts";
import { compactAtOf, ctxCapOf } from "./ctx-cap.ts";
import { guardRules, maskDataStatements, stripAgentText, stripHeredocBodies, type GuardRules } from "./guard-rules.ts";
import { HOOK_ERRORS, renderHook } from "./human-errors.ts";
import { hadesHome, home } from "./paths.ts";
import { pyDumps, splitLines } from "./pyjson.ts";
import { containsDir, mostSpecific } from "./worktree-scope.ts";

type Dict = Record<string, unknown>;
export type HookInput = Dict;
export type Cfg = Record<string, string>;

export interface HookResult {
  /** 2 = barra a ferramenta (a razão vai em stderr) */
  exit: number;
  stdout: string;
  stderr: string;
}

const REPORTS_DEFAULT = ".design-sync-reports";
const READ_BIG_LINES = 400;
const IMAGE_LIKE = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"];
const BLOCK_EXIT = 2;
const CONTEXT_TAIL_BYTES = 600_000;
const SIX_HOURS_S = 6 * 3600;
const READ_HINT =
  "Prefira `grep -n <termo> <arquivo>` para achar o trecho e `sed -n 'A,Bp' <arquivo>` (ou Read com offset/limit) " +
  "para lê-lo: tudo que entra agora é relido a cada turno até o /clear.";
const HOW =
  "Esperar por evento, sem gastar turno: rode em segundo plano (run_in_background) e seja notificado ao terminar — " +
  "hades wait ci <PR> | gate <pid|arquivo-de-sumario> | merged <PR> | " +
  "answer <worktree> <Qn> | review <PR> | agent <nome> | proc <padrão-do-pgrep -f>; o orquestrador usa hades watch --next. " +
  "Leia o log só quando a espera terminar, e só o trecho que importa.";
const SLEEP_LOOP = "laço com sleep";
const PGREP_LOOP = /\bpgrep\s+(?:-\w+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;|&)]+))/;
const WAIT_BY_COMMAND: { rx: RegExp; wait: string }[] = [
  { rx: /\bgate-lock\.sh\s+status\b/, wait: "hades wait queue <label> (ou gate <pid>)" },
  { rx: /\bgh\s+(?:pr\s+(?:checks|view)|run\s+(?:view|watch))\b/, wait: "hades wait ci <PR> (ou merged <PR>, review <PR>)" },
  { rx: /\bherdr\b/, wait: "hades wait agent <nome> [estado]" },
];

// exceção e modo das cabeças só pelo dono (painel local ou `!`): vindo das ferramentas do Claude, barra
const CERBERUS_OWNER_ONLY: { rx: RegExp; what: string }[] = [
  { rx: /(?:hades[-_]cerberus\.(?:sh|py)|hades\s+cerberus)\b[^\n;&|]*\bexcecao\s+abrir\b/, what: "abrir exceção do Cerberus" },
  { rx: /\/api\/cerberus\b/, what: "chamar a rota do Cerberus no painel" },
  { rx: /_maquina\/cerberus\b/, what: "mexer no diretório do Cerberus (histórico e exceções)" },
  { rx: /(?:hades\s+config\b|config\.(?:py|sh)\b|\/api\/config\b)[^\n;&|]*HADES_CERBERUS_/, what: "trocar o modo de uma cabeça do Cerberus" },
];
// o nível de autonomia e o toggle da auto-alocação: do dono, com a mesma trava (exportar a variável no comando também conta)
const AUTONOMY_OWNER_ONLY: { rx: RegExp; what: string }[] = [
  { rx: /\bHADES_ORCH_(?:AUTONOMY|AUTO_START)\s*=/, what: "mudar o nível de autonomia ou o toggle da auto-alocação" },
  { rx: /(?:hades\s+config|config\.(?:py|sh))\s+(?:set|unset|import)\b[^\n;&|]*HADES_ORCH_(?:AUTONOMY|AUTO_START)/, what: "mudar o nível de autonomia ou o toggle da auto-alocação" },
  { rx: /\/api\/config\b[^\n]*HADES_ORCH_(?:AUTONOMY|AUTO_START)/, what: "mudar o nível de autonomia ou o toggle da auto-alocação" },
  { rx: /hades\s+agent\s+auto-start\s+(?:on|off)\b/, what: "ligar ou desligar a auto-alocação" },
];
// política dos resumidores do rtk: do dono, com a mesma trava (o agente vê mais com `rtk proxy <cmd>`, não muda a política nem confia em filtro)
const RTK_OWNER_ONLY: { rx: RegExp; what: string }[] = [
  { rx: /\bHADES_RTK_(?:FILTERS|OFF_STACKS|OFF_FILTERS)\s*=/, what: "mudar a política dos filtros do rtk" },
  { rx: /(?:hades\s+config|config\.(?:py|sh))\s+(?:set|unset|import)\b[^\n;&|]*HADES_RTK_/, what: "mudar a política dos filtros do rtk" },
  { rx: /\/api\/config\b[^\n]*HADES_RTK_/, what: "mudar a política dos filtros do rtk" },
  { rx: /(?:^|[;&|(]|\s)rtk\s+(?:trust|untrust)\b/, what: "confiar ou revogar a confiança num filtro do rtk" },
  { rx: /hades\s+rtk\s+apply\b[^\n;&|]*--trust/, what: "confiar num filtro do rtk" },
];
const CERBERUS_READ_ONLY = /hades\s+cerberus\s+(historico|excecao\s+listar|modos|estado)\b/;
const GATE_WRAP = /(?:gate-lock(?:\.sh)?)/;
const GATE_VAR_WRAP = /"?\$\{?GL\}?"?\s+run\s/;

/** O hook decidiu barrar: exit 2 e a razão em stderr. */
class Block extends Error {}

/** Dependências de ambiente do hook, injetáveis para teste. */
export interface HookEnv {
  now: () => number;
  cwd: () => string;
  home: () => string;
  /** padrões de comando que a fila de gates tem de embrulhar, das stacks do projeto do diretório */
  gatePatterns: (cwd: string) => RegExp[];
  /** nome do projeto ativo (perfil do repo do cwd) ou undefined */
  projectOf: (cwd: string) => string | undefined;
  /** registra no histórico do Cerberus o barra já decidido; nunca muda a decisão */
  cerberusEmit: (guarda: string, conferido: string, d: HookInput) => void;
  /** ferramentas do PreToolUse em que o guard decide; fora delas o PreToolUse só alimenta o diário (undefined = todas) */
  decidingTools?: readonly string[];
  /** terminal do canvas cujo cwd contém o da sessão, com o papel (slug do Argos) dele (padrão: argos/terminals.json da instância) */
  terminal?: (cwd: string) => TerminalMatch | undefined;
  /** grava o evento no diário (src/lib/journal.ts); nunca lança nem muda o resultado */
  journal?: (d: HookInput, cfg: Cfg, result: HookResult) => void;
}

// ------------------------------------------------------------------ configuração, papel, estado

function parseTsv(text: string, cfg: Cfg): void {
  for (const line of splitLines(text)) {
    if (line === "" || line.startsWith("#")) continue;
    const [key = "", value = ""] = line.split("\t");
    cfg[key] = value;
  }
}

/** config.tsv da instância (ou o do kit, sem instância) + config.env, relidos a cada chamada. */
export function hookConfig(): Cfg {
  const instance = readText(join(hadesHome(), "instance"));
  const data = instance === undefined ? undefined : instance.trim();
  const dataTsv = data ? join(data, "config.tsv") : undefined;
  const tsv = dataTsv && isFile(dataTsv) ? dataTsv : join(home(), ".claude", "skills", "hades", "kit", "config.tsv");
  const cfg: Cfg = {};
  const text = readText(tsv);
  if (text === undefined) return cfg;
  parseTsv(text, cfg);
  const envText = data ? readText(join(data, "config.env")) : undefined;
  if (envText !== undefined) {
    for (const line of splitLines(envText)) {
      const eq = line.indexOf("=");
      const key = eq < 0 ? line : line.slice(0, eq);
      if (eq >= 0 && /^[A-Z][A-Z0-9_]*$/.test(key)) cfg[key] = line.slice(eq + 1);
    }
  }
  return cfg;
}

function intOf(cfg: Cfg, key: string, fallback: string): number {
  const n = Number.parseInt((cfg[key] ?? fallback).trim(), 10);
  return Number.isNaN(n) ? Number.parseInt(fallback, 10) : n;
}

function workRoot(): string {
  if (process.env.HADES_WORK_ROOT) return process.env.HADES_WORK_ROOT;
  const root = firstLine(join(hadesHome(), "work-root")).trim();
  return root || join(hadesHome(), "work");
}

const ROLE_BY_MODE: Record<string, string> = { consolidate: "consolidate", review: "review" };

function readObject(path: string): Dict | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    const doc: unknown = JSON.parse(text);
    return typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Dict) : undefined;
  } catch {
    return undefined;
  }
}

function agentFiles(): string[] {
  const root = workRoot();
  const files: string[] = [];
  let projects: string[];
  try {
    projects = readdirSync(root).sort();
  } catch {
    return files;
  }
  for (const project of projects) {
    const dir = join(root, project, "orchestration", "agents");
    try {
      for (const name of readdirSync(dir).sort()) if (name.endsWith(".json")) files.push(join(dir, name));
    } catch {
      continue;
    }
  }
  return files;
}

/** Terminal do canvas que contém a sessão; `role` é o slug livre do Argos, ausente quando o terminal não tem papel. */
export interface TerminalMatch {
  role: string | undefined;
}

/**
 * O terminal do canvas cujo cwd contém `cwd`, lido do `argos/terminals.json`; o mais específico vale. Arquivo ausente
 * ou ilegível não decide nada: o hook nunca falha por causa dele.
 */
export function terminalOf(file: string, cwd: string): TerminalMatch | undefined {
  const doc = readObject(file);
  const list = Array.isArray(doc?.terminals) ? (doc.terminals as unknown[]) : [];
  const terminals = list.filter((t): t is Dict => typeof t === "object" && t !== null && typeof (t as Dict).cwd === "string");
  const terminal = mostSpecific(cwd, terminals, (t) => t.cwd as string) as Dict | undefined;
  if (!terminal) return undefined;
  return { role: typeof terminal.role === "string" && terminal.role !== "" ? terminal.role : undefined };
}

interface Registered {
  agent: Dict;
  worktree: string;
}

/**
 * O registro cuja worktree contém `cwd`: a mais específica (a pasta-mãe de um recruta não toma o papel dele) e, na mesma
 * worktree, o agente vivo antes do encerrado. Encerrado (`done`) continua valendo: quem retoma o recruta à mão segue sob o
 * teto do papel.
 */
function registeredAgentOf(cwd: string): Dict | undefined {
  const records: Registered[] = [];
  for (const file of agentFiles()) {
    const agent = readObject(file);
    const worktree = typeof agent?.worktree === "string" ? agent.worktree : "";
    if (agent && worktree && containsDir(worktree, cwd)) records.push({ agent, worktree });
  }
  const live = records.filter((r) => r.agent.state !== "done");
  const best = mostSpecific(cwd, records, (r) => r.worktree);
  const sameWorktreeLive = best ? live.find((r) => r.worktree === best.worktree) : undefined;
  return (sameWorktreeLive ?? best)?.agent;
}

/** A pasta de dados ($D) da instância: HADES_DATA ou a instância ativa da máquina (a mesma que o hookConfig lê). */
function defaultTerminal(cwd: string): TerminalMatch | undefined {
  const instance = readText(join(hadesHome(), "instance"))?.trim();
  const data = process.env.HADES_DATA || instance;
  return data ? terminalOf(join(data, "argos", "terminals.json"), cwd) : undefined;
}

const RECRUIT_ROLE = "recruit";

/** Sessão que não é agente registrado: recruta (terminal do canvas, com o papel dele ou `recruit`), senão interativa. */
function interactiveRole(cwd: string, env: HookEnv): SessionRole {
  const terminal = (env.terminal ?? defaultTerminal)(cwd);
  if (!terminal) return { role: "interactive", agent: undefined, recruit: false };
  return { role: terminal.role ?? RECRUIT_ROLE, agent: undefined, recruit: true };
}

/** Papel do agente registrado: o declarado, senão o do modo (revisão, consolidação), senão implementação. */
export function agentRoleOf(agent: Dict): string {
  const declared = typeof agent.role === "string" ? agent.role : "";
  const mode = typeof agent.mode === "string" ? agent.mode : "";
  return declared || ROLE_BY_MODE[mode] || "impl";
}

interface SessionRole {
  role: string;
  agent: Dict | undefined;
  /** terminal do canvas sem registro de agente: o teto cai em `HADES_CTX_CAP_RECRUIT` quando o papel não tem chave própria */
  recruit: boolean;
}

/** (papel, agente) da sessão a partir do cwd. */
function roleOf(cwd: string, env: HookEnv): SessionRole {
  const agent = registeredAgentOf(cwd);
  if (agent) {
    return { role: agentRoleOf(agent), agent, recruit: false };
  }
  // regra de projeto: clone principal só é orquestrador num repo com perfil (fora dele, a sessão é interativa)
  if (env.projectOf(cwd) === undefined) return interactiveRole(cwd, env);
  let dir = resolve(cwd);
  for (;;) {
    const git = join(dir, ".git");
    if (isDir(git)) return { role: "orchestrator", agent: undefined, recruit: false };
    if (isFile(git)) return interactiveRole(cwd, env);
    const parent = dirname(dir);
    if (parent === dir) return interactiveRole(cwd, env);
    dir = parent;
  }
}

const stateDir = (h: string): string => join(h, ".claude", "hades", "guard");

function stateFile(h: string, sid: string): string {
  return join(stateDir(h), `${sid.replace(/[^A-Za-z0-9_-]/g, "") || "x"}.json`);
}

function loadState(file: string): Dict {
  return readObject(file) ?? {};
}

function saveState(file: string, state: Dict): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file.replace(/\.json$/, "")}.tmp`;
  writeFileSync(tmp, pyDumps(state));
  renameSync(tmp, file);
}

// ------------------------------------------------------------------ shlex.split (modo posix) para a leitura de arquivo

/** `shlex.split`: aspas simples e duplas, barra invertida; undefined quando a aspa não fecha (o Python levanta ValueError). */
export function shlexSplit(text: string): string[] | undefined {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return undefined;
      current += text.slice(i + 1, close);
      inWord = true;
      i = close;
    } else if (ch === '"') {
      inWord = true;
      let closed = false;
      for (i += 1; i < text.length; i += 1) {
        const c = text[i] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === "\\" && i + 1 < text.length && '"\\'.includes(text[i + 1] as string)) {
          i += 1;
          current += text[i] as string;
        } else current += c;
      }
      if (!closed) return undefined;
    } else if (ch === "\\") {
      if (i + 1 >= text.length) return undefined;
      i += 1;
      current += text[i] as string;
      inWord = true;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

// ------------------------------------------------------------------ leitura grande

function fileKb(path: string, cwd: string): number {
  try {
    const expanded = path.startsWith("~") ? join(home(), path.slice(1)) : path;
    const full = isAbsolute(expanded) ? expanded : join(cwd, expanded);
    const stat = statSync(full);
    return stat.isFile() ? Math.floor(stat.size / 1024) : 0;
  } catch {
    return 0;
  }
}

/** Argumentos de arquivo de uma leitura sem corte (cat; sed -n/head/tail com faixa grande) ou [] se a leitura é curta. */
export function bigReadArgs(argv: string[]): string[] {
  const [first, ...args] = argv;
  if (first === undefined) return [];
  const cmd = basename(first);
  if (cmd === "cat") return args.filter((a) => !a.startsWith("-"));
  if (cmd === "head" || cmd === "tail") {
    let n = 10;
    const files: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i] as string;
      const short = /^-(\d+)$/.exec(a) ?? /^-n\+?(\d+)$/.exec(a);
      if (short) n = Number.parseInt(short[1] as string, 10);
      else if ((a === "-n" || a === "--lines") && i + 1 < args.length) {
        n = Number.parseInt((args[i + 1] as string).replace(/\D/g, "") || "0", 10);
        i += 1;
      } else if (!a.startsWith("-")) files.push(a);
    }
    return n > READ_BIG_LINES ? files : [];
  }
  if (cmd === "sed" && args.includes("-n")) {
    const rest = args.filter((a) => a !== "-n");
    const range = rest.length ? /^(\d+),(\d+)p$/.exec(rest[0] as string) : null;
    return range && Number(range[2]) - Number(range[1]) + 1 > READ_BIG_LINES ? rest.slice(1) : [];
  }
  return [];
}

function readWarning(d: HookInput, cfg: Cfg, rules: GuardRules, env: HookEnv): string | undefined {
  const limitKb = intOf(cfg, "HADES_READ_WARN_KB", "20");
  if (limitKb <= 0) return undefined;
  const input = (d.tool_input as Dict | undefined) ?? {};
  const cwd = (d.cwd as string | undefined) || env.cwd();
  let paths: string[] = [];
  if (d.tool_name === "Read") {
    const path = typeof input.file_path === "string" ? input.file_path : "";
    paths = input.limit || input.offset || IMAGE_LIKE.some((ext) => path.toLowerCase().endsWith(ext)) ? [] : [path];
  } else {
    // heredoc e texto de agente são dados; só a instrução que lê um arquivo e entrega tudo ao contexto (sem pipe) conta
    const cmd = stripHeredocBodies(rules, stripAgentText(rules, typeof input.command === "string" ? input.command : ""));
    for (const stmt of cmd.split(/&&|\|\||;|\n/)) {
      if (stmt.includes("|") || stmt.includes("<") || stmt.includes(">")) continue;
      const argv = shlexSplit(stmt);
      if (argv) paths.push(...bigReadArgs(argv));
    }
  }
  const big = paths.filter((p) => p).map((p) => ({ p, kb: fileKb(p, cwd) })).filter(({ kb }) => kb > limitKb);
  if (big.length === 0) return undefined;
  const what = big.map(({ p, kb }) => `${p} (${kb} KB)`).join(", ");
  const persisted = big.some(({ p }) => p.includes("/tool-results/"))
    ? " É saída persistida de ferramenta: quase sempre só um trecho interessa."
    : "";
  return `HADES: leitura inteira de arquivo grande: ${what}, acima de ${limitKb} KB.${persisted} ${READ_HINT}`;
}

// ------------------------------------------------------------------ PreToolUse

function ownerOnly(cmd: string, d: HookInput, env: HookEnv): void {
  for (const { rx, what } of CERBERUS_OWNER_ONLY) {
    if (rx.test(cmd) && !(what.startsWith("mexer") && CERBERUS_READ_ONLY.test(cmd))) {
      env.cerberusEmit("excecao-so-dono", `barrado: ${what}`, d);
      throw new Block(renderHook(`cerberus: ${what} vindo das ferramentas do Claude é barrado. Só o dono faz isso.`, HOOK_ERRORS.cerberusOwnerOnly));
    }
  }
}

function autonomyOwnerOnly(cmd: string, d: HookInput, env: HookEnv): void {
  for (const { rx, what } of AUTONOMY_OWNER_ONLY) {
    if (!rx.test(cmd)) continue;
    env.cerberusEmit("excecao-so-dono", `barrado: ${what}`, d);
    throw new Block(renderHook(`autonomia: ${what} vindo das ferramentas do Claude é barrado. Só o dono faz isso.`, HOOK_ERRORS.autonomyOwnerOnly));
  }
}

function rtkOwnerOnly(cmd: string, d: HookInput, env: HookEnv): void {
  for (const { rx, what } of RTK_OWNER_ONLY) {
    if (!rx.test(cmd)) continue;
    env.cerberusEmit("excecao-so-dono", `barrado: ${what}`, d);
    throw new Block(renderHook(`rtk: ${what} vindo das ferramentas do Claude é barrado. Só o dono faz isso.`, HOOK_ERRORS.rtkOwnerOnly));
  }
}

function repeatKeys(rules: GuardRules, cmd: string): string[] {
  const keys: string[] = [];
  for (const { rx, what } of rules.repeat) {
    const match = rx.exec(cmd);
    if (match) keys.push(`${what}:${match[1] ?? ""}`);
  }
  return keys;
}

/** O log recebeu escrita depois da última leitura e está quieto há `settleS`: o processo terminou, reler é ler o resultado. */
function logSettledSince(path: string, cwd: string, lastReadS: number, nowS: number, settleS: number): boolean {
  try {
    const expanded = path.startsWith("~") ? join(home(), path.slice(1)) : path;
    const mtimeS = statSync(isAbsolute(expanded) ? expanded : join(cwd, expanded)).mtimeMs / 1000;
    return mtimeS > lastReadS && nowS - mtimeS >= settleS;
  } catch {
    return false;
  }
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** O hades wait que troca o laço com sleep: `proc <padrão>` quando o laço é um pgrep, senão o alvo do que ele consulta. */
function equivalentWait(cmd: string): string {
  const pgrep = PGREP_LOOP.exec(cmd);
  const pattern = pgrep?.[1] ?? pgrep?.[2] ?? pgrep?.[3];
  if (pattern) return `hades wait proc ${shellQuote(pattern)}`;
  return WAIT_BY_COMMAND.find(({ rx }) => rx.test(cmd))?.wait ?? "o hades wait do evento (proc <padrão> | gate <pid> | queue <label> | ci <PR> | agent <nome>)";
}

/** Laço com sleep em segundo plano não gasta turno, mas já tem alvo no hades wait: avisa sem barrar. */
function backgroundPollWarning(rules: GuardRules, cmd: string): string | undefined {
  if (!rules.fgPoll.some(({ rx, what }) => what === SLEEP_LOOP && rx.test(cmd))) return undefined;
  return `HADES: laço com sleep em segundo plano. Troque por \`${equivalentWait(cmd)}\`: ele espera e notifica sem o laço.`;
}

function bashChecks(d: HookInput, cfg: Cfg, rules: GuardRules, env: HookEnv): string | undefined {
  const input = (d.tool_input as Dict | undefined) ?? {};
  const original = typeof input.command === "string" ? input.command : "";
  if (!original) return undefined;
  const stripped = stripAgentText(rules, original);
  ownerOnly(stripHeredocBodies(rules, stripped), d, env);
  autonomyOwnerOnly(stripHeredocBodies(rules, stripped), d, env);
  rtkOwnerOnly(stripHeredocBodies(rules, stripped), d, env);
  const cwd = (d.cwd as string | undefined) || env.cwd();
  const wrapped = GATE_WRAP.test(stripped) || GATE_VAR_WRAP.test(stripped);
  if (!wrapped && env.gatePatterns(cwd).some((rx) => rx.test(stripped))) {
    env.cerberusEmit("hook-fila-e-polling", "barrado: test/lint/build fora da fila do gate-lock", d);
    throw new Block(renderHook("gate-lock: test/lint/build rodando fora da fila de gate.", HOOK_ERRORS.gateOutsideQueue));
  }
  const file = stateFile(env.home(), (d.session_id as string | undefined) || "x");
  if (wrapped) {
    // um gate rodou: o que ele escreveu (sumário, log) mudou, então reler depois dele não é polling
    saveState(file, { ...loadState(file), gateAt: env.now() });
  }
  if ((cfg.HADES_POLL_GUARD ?? "1") !== "1") return undefined;
  // corpo de heredoc é dado (documento, script gravado em arquivo), não o que roda agora: fora da detecção de polling
  const cmd = maskDataStatements(stripHeredocBodies(rules, stripped));
  if (input.run_in_background) return backgroundPollWarning(rules, cmd);
  for (const { rx, what } of rules.fgPoll) {
    if (rx.test(cmd)) {
      env.cerberusEmit("hook-fila-e-polling", `barrado: polling (${what})`, d);
      throw new Block(renderHook(`hades-guard: polling barrado (${what}).`, HOOK_ERRORS.pollingBlocked, HOW));
    }
  }
  const keys = repeatKeys(rules, cmd);
  if (keys.length === 0) return undefined;
  const state = loadState(file);
  const windowS = intOf(cfg, "HADES_POLL_REPEAT_MIN", "10") * 60;
  const settleS = intOf(cfg, "HADES_POLL_LOG_SETTLE_S", "15");
  const now = env.now();
  const seen = (typeof state.checks === "object" && state.checks !== null ? state.checks : {}) as Record<string, number>;
  const gateAt = typeof state.gateAt === "number" ? state.gateAt : 0;
  for (const key of keys) {
    const last = seen[key] ?? 0;
    if (key.startsWith("log:") && gateAt > last) continue;
    if (key.startsWith("log:") && logSettledSince(key.slice(4), cwd, last, now, settleS)) continue;
    if (now - last < windowS) {
      const name = key.split(":")[0];
      env.cerberusEmit("hook-fila-e-polling", `barrado: a mesma checagem (${name}) repetida dentro de ${Math.floor(windowS / 60)} min`, d);
      throw new Block(renderHook(`hades-guard: a mesma checagem (${key}) já rodou há ${Math.trunc((now - last) / 60)} min — isso é polling.`, HOOK_ERRORS.pollingRepeated, HOW));
    }
  }
  for (const key of keys) seen[key] = now;
  state.checks = Object.fromEntries(Object.entries(seen).filter(([, at]) => now - at < SIX_HOURS_S));
  saveState(file, state);
  return undefined;
}

const additionalContext = (event: string, message: string): string =>
  `${pyDumps({ hookSpecificOutput: { hookEventName: event, additionalContext: message } }).replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;

function preTool(d: HookInput, cfg: Cfg, rules: GuardRules, env: HookEnv): string {
  const input = (d.tool_input as Dict | undefined) ?? {};
  if (d.tool_name === "Write" || d.tool_name === "Edit" || d.tool_name === "NotebookEdit") {
    const path = String(input.file_path || input.notebook_path || "");
    ownerOnly(path, d, env);
  }
  if (d.tool_name !== "Bash" && d.tool_name !== "Read") return "";
  const pollWarning = d.tool_name === "Bash" ? bashChecks(d, cfg, rules, env) : undefined;
  const message = [pollWarning, readWarning(d, cfg, rules, env)].filter(Boolean).join("\n");
  return message ? additionalContext("PreToolUse", message) : "";
}

// ------------------------------------------------------------------ PostToolUse: teto de contexto

/** Últimos CONTEXT_TAIL_BYTES do transcript ("" se não lê). */
function transcriptTail(path: string): string {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - CONTEXT_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Tokens de contexto da última resposta do assistente (fora de sidechain) nos últimos 600 KB do transcript. */
export function contextTokens(path: string): number {
  return contextTokensOf(transcriptTail(path));
}

function contextTokensOf(text: string): number {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string;
    if (!line.includes('"usage"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Dict;
    const usage = e.type === "assistant" && !e.isSidechain ? ((e.message as Dict | undefined)?.usage as Dict | undefined) : undefined;
    if (usage) {
      return [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].reduce<number>(
        (sum, v) => sum + (typeof v === "number" ? v : 0),
        0,
      );
    }
  }
  return 0;
}

/**
 * Sugestão de `/compact` antes do teto: uma vez por sessão, quando o contexto cruza `HADES_CTX_COMPACT_AT` (abaixo do teto do
 * papel). Quem pode fechar a sessão (unidade curta) conclui; quem não pode compacta em vez de esperar o teto estourar.
 */
function compactSuggestion(file: string, ctx: number, cap: number, role: string, registered: boolean, at: number | undefined): string {
  if (at === undefined || ctx < at) return "";
  const state = loadState(file);
  if (state.compactSuggested === true) return "";
  state.compactSuggested = true;
  saveState(file, state);
  const head = `HADES: contexto em ${Math.floor(ctx / 1000)}k (papel ${role}; compactar a partir de ${Math.floor(at / 1000)}k, teto ${Math.floor(cap / 1000)}k). `;
  const tail = registered
    ? "Se a unidade está perto de concluir, siga e conclua (a sessão fecha sozinha no DONE). Se ainda vai longe, deixe o handoff.md " +
      "atualizado e peça ao orquestrador um /compact: cada turno relê todo o contexto, e compactar agora sai mais barato que estacionar no teto."
    : "Se a tarefa ainda vai longe, sugira ao dono rodar /compact (cada turno relê todo o contexto); compactar agora sai mais barato que esperar o teto.";
  return additionalContext("PostToolUse", head + tail);
}

/**
 * Reescrita do rtk no auto mode: o hook do rtk muda o comando Bash depois do veredito do classificador, que devolve "no verdict"
 * para a chamada (e para as outras Bash da mesma resposta). Essa chamada nunca executa: o PreToolUse dela dispara, o PostToolUse
 * não, então o resultado negado só existe como `tool_result` com `is_error` no transcript. Lido aqui, na próxima chamada que
 * conclui; a orientação sai uma vez por sessão.
 */
// duas redações do classificador: "a hook changed this call's input" (a própria chamada) e "was changed by a hook" (outra Bash da resposta)
const REWRITE_DENIED = /gave no verdict for \w+: .*(?:a hook changed|changed by a hook)/s;
const REWRITE_HINT =
  "HADES: o auto mode recusou Bash porque o hook do rtk reescreveu o comando depois do veredito (cada chamada volta e é reenviada: um turno a mais com o contexto inteiro). " +
  "Faça uma chamada Bash por resposta (outras ferramentas podem ir em paralelo) ou chame `rtk <cmd>` já reescrito. Detalhe: reference/loop/tokens.md (reescrita do rtk).";

function hasRewriteDenial(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("gave no verdict")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ((entry as Dict | null)?.message as Dict | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Dict[]) {
      if (block?.type === "tool_result" && block.is_error === true && typeof block.content === "string" && REWRITE_DENIED.test(block.content)) return true;
    }
  }
  return false;
}

function rtkRewriteHint(file: string, tail: string): string {
  if (!tail.includes("gave no verdict")) return "";
  const state = loadState(file);
  if (state.rtkRewriteHinted === true || !hasRewriteDenial(tail)) return "";
  state.rtkRewriteHinted = true;
  saveState(file, state);
  return additionalContext("PostToolUse", REWRITE_HINT);
}

function postTool(d: HookInput, cfg: Cfg, env: HookEnv): string {
  const transcript = typeof d.transcript_path === "string" ? d.transcript_path : "";
  if ((cfg.HADES_CTX_GUARD ?? "1") !== "1" || !transcript) return "";
  const tail = transcriptTail(transcript);
  const ctx = contextTokensOf(tail);
  const cwd = (d.cwd as string | undefined) || env.cwd();
  const { role, agent, recruit } = roleOf(cwd, env);
  const cap = ctxCapOf(role, (key) => cfg[key], recruit);
  const file = stateFile(env.home(), (d.session_id as string | undefined) || "x");
  const rewrite = rtkRewriteHint(file, tail);
  if (rewrite) return rewrite;
  if (ctx < cap) return compactSuggestion(file, ctx, cap, role, agent !== undefined, compactAtOf((key) => cfg[key], cap));
  const state = loadState(file);
  const rewarn = intOf(cfg, "HADES_CTX_REWARN", "50000");
  const warned = typeof state.warnedAt === "number" ? state.warnedAt : 0;
  if (warned && ctx - warned < rewarn) return "";
  state.warnedAt = ctx;
  saveState(file, state);
  const k = `${Math.floor(ctx / 1000)}k`;
  const capK = Math.floor(cap / 1000);
  let message: string;
  if (agent !== undefined) {
    const reports = cfg.HADES_ORCH_REPORTS_DIR || REPORTS_DEFAULT;
    message =
      `HADES: contexto em ${k}, acima do teto do papel ${role} (${capK}k). Termine o passo atual sem começar outro, ` +
      `grave ${reports}/handoff.md começando com a linha "STATUS: PARKED — teto de contexto", depois: o que foi feito, ` +
      "o que falta (em ordem), arquivos e branch, e decisões tomadas; commite e faça push do que estiver pronto, " +
      "e encerre o turno. O orquestrador reabre esta sessão limpa a partir do handoff.";
  } else if (role === "orchestrator") {
    message =
      `HADES: contexto do orquestrador em ${k}, acima do teto (${capK}k). Atualize o plan.md e o estado da ` +
      "orquestração com o que importa para continuar e peça ao dono para rodar /clear; depois, retome a partir do " +
      "plan.md (os agentes e seus registros não dependem desta conversa).";
  } else {
    const who = role === "interactive" ? "das sessões interativas" : `do papel ${role} (terminal do canvas)`;
    message =
      `HADES: contexto em ${k}, acima do teto ${who} (${capK}k). Ao terminar o passo atual, ` +
      "resuma num arquivo de handoff o que importa para continuar e sugira ao dono rodar /clear (cada turno relê " +
      "todo o contexto). Não interrompa o trabalho por conta própria.";
  }
  return additionalContext("PostToolUse", message);
}

// ------------------------------------------------------------------ entrada

/** Decide uma chamada de ferramenta a partir do JSON que o Claude Code entrega ao hook. */
export function decide(d: HookInput, env: HookEnv, rules: GuardRules = guardRules()): HookResult {
  const cfg = hookConfig();
  const result = decideWith(d, cfg, env, rules);
  env.journal?.(d, cfg, result);
  return result;
}

function decideWith(d: HookInput, cfg: Cfg, env: HookEnv, rules: GuardRules): HookResult {
  try {
    if (d.hook_event_name === "PreToolUse") {
      const decides = env.decidingTools === undefined || env.decidingTools.includes(String(d.tool_name));
      return { exit: 0, stdout: decides ? preTool(d, cfg, rules, env) : "", stderr: "" };
    }
    if (d.hook_event_name === "PostToolUse") return { exit: 0, stdout: postTool(d, cfg, env), stderr: "" };
  } catch (error) {
    if (error instanceof Block) return { exit: BLOCK_EXIT, stdout: "", stderr: error.message };
    throw error;
  }
  return { exit: 0, stdout: "", stderr: "" };
}

/** `hades guard context <cwd>`: contexto atual da sessão mais recente daquele diretório (usado pelo hades-watch). */
export function contextOfDir(cwd: string, h: string = home()): number {
  const project = join(h, ".claude", "projects", cwd.replace(/\/+$/, "").replace(/[/.]/g, "-"));
  let newest: { file: string; mtime: number } | undefined;
  try {
    for (const name of readdirSync(project)) {
      if (!name.endsWith(".jsonl")) continue;
      const mtime = statSync(join(project, name)).mtimeMs;
      if (!newest || mtime >= newest.mtime) newest = { file: join(project, name), mtime };
    }
  } catch {
    return 0;
  }
  return newest ? contextTokens(newest.file) : 0;
}
