// Terminais criados no canvas (reference/argos.md §Terminais criados no canvas): criar e fechar o pane do herdr com um
// agente, trocar o papel reiniciando só o processo, e as rotas de papéis e predefinições. Iniciar processo é poder alto:
// pelo acesso remoto as três rotas de terminal exigem `confirm` igual ao nome do nó e avisam o dono. O texto do papel
// nunca vai a log nem ao aviso; o log leva só ação, nome, alvo e origem.
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { paneFrom } from "../lib/herdr.ts";
import {
  AGENT_KINDS, ARGOS_ERROR_CODES, agentOf, ArgosError, type ArgosErrorCode, type ArgosRoleEntry, createRoleStore,
  DEFAULT_AGENT, DISCOVER_LIMITS, discoverRoles, effortOf, modelOf, optional, readRoleFile, slugFormatOf, slugify,
} from "../lib/argos-roles.ts";
import { type ArgosPresetEntry, createPresetStore } from "../lib/argos-presets.ts";
import type { Herdr } from "./herdr.ts";
import { PANE_ID, SESSION_NAME } from "./herdr-page.ts";
import { send } from "./http.ts";
import type { Level } from "./log.ts";

type Dict = Record<string, unknown>;

export const ARGOS_ERROR_STATUS: Readonly<Record<ArgosErrorCode, number>> = {
  [ARGOS_ERROR_CODES.invalid]: 400,
  [ARGOS_ERROR_CODES.notFound]: 404,
  [ARGOS_ERROR_CODES.confirmRequired]: 403,
  [ARGOS_ERROR_CODES.herdrFailed]: 502,
  [ARGOS_ERROR_CODES.rateLimited]: 429,
  [ARGOS_ERROR_CODES.unsafeArgument]: 400,
};

/** Criar e fechar terminal: até 10 por minuto, por rota e por origem (local ou remoto), em janela deslizante. */
export const TERMINAL_RATE = { max: 10, windowMs: 60_000 } as const;

/**
 * Janela deslizante por chave: `take` conta a tentativa e devolve undefined, ou, com a janela cheia, os segundos até a
 * mais antiga sair (sem contar a recusada). As chaves são poucas e fixas (rota × origem).
 */
export function createRateLimiter(limit: { max: number; windowMs: number }, now: () => number) {
  const hits = new Map<string, number[]>();
  return {
    take(key: string): number | undefined {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => t - at < limit.windowMs);
      const oldest = recent[0];
      if (recent.length >= limit.max && oldest !== undefined) {
        hits.set(key, recent);
        return Math.max(1, Math.ceil((oldest + limit.windowMs - t) / 1000));
      }
      hits.set(key, [...recent, t]);
      return undefined;
    },
  };
}

/** Motivos estáveis de `skipped` na importação de papéis. */
export const IMPORT_SKIP = { notDiscovered: "not-discovered", invalid: "invalid", exists: "exists" } as const;

/** Tamanho máximo do nome do terminal (a CLI `hades canvas` encurta o nome padrão do recruta para caber). */
export const TERMINAL_NAME_MAX = 40;
/** O mesmo formato do nome de agente que o `herdr agent rename` aceita na página Herdr. */
const TERMINAL_NAME = new RegExp(`^[A-Za-z0-9][\\w .-]{0,${TERMINAL_NAME_MAX - 1}}$`);
const PATH_MAX = 4096;
const DEFAULT_SESSION = "default";
export const TERMINAL_LIMITS = { terminals: 64 } as const;
export const TERMINAL_TIMEOUTS = {
  /** `workspace create` e `pane close` */
  paneMs: 20_000,
  /** o `agent start` espera o agente ficar pronto (o padrão do herdr é 30 s) */
  startMs: 60_000,
  /** troca de papel: quantas vezes e de quanto em quanto conferir que o processo antigo saiu */
  exitPolls: 20,
  exitPollMs: 250,
  /**
   * Pane novo: quantas vezes e de quanto em quanto conferir que o shell chegou ao prompt antes do `agent start`. O herdr
   * 0.8.2 aceita o start nos primeiros milissegundos do pane, com o shell ainda lendo o rc (fish com fastfetch e starship
   * leva ~0,6 s); o comando digitado se perde e o start espera o agente até estourar o prazo.
   */
  promptPolls: 80,
  promptPollMs: 100,
  /** amostras seguidas com o prompt na tela e só o shell no primeiro plano */
  promptSteady: 2,
} as const;
/** Prefixo das rotas de criar, fechar e trocar o papel de um terminal do canvas. */
export const TERMINALS_PATH = "/api/argos/terminals";
/**
 * Prazo de uma requisição dessas rotas no servidor (o Bun corta em 10 s por padrão): criar o pane, esperar o prompt, o
 * `agent start` e, se ele falhar, fechar o pane, com folga.
 */
export const TERMINAL_REQUEST_TIMEOUT_S = Math.ceil(
  (2 * TERMINAL_TIMEOUTS.paneMs + TERMINAL_TIMEOUTS.promptPolls * TERMINAL_TIMEOUTS.promptPollMs + TERMINAL_TIMEOUTS.startMs) / 1000,
) + 15;
/** Quanto tempo um caminho devolvido pela descoberta vale para a importação, e quantos ficam guardados. */
export const DISCOVERED_TTL_MS = 15 * 60_000;
const DISCOVERED_MAX = 1000;

export interface ArgosTerminalsDeps {
  /** $D */
  dir: string;
  herdr: Pick<Herdr, "call" | "json" | "snap" | "forget">;
  /** Onde um terminal pode abrir: o clone do projeto primeiro (o padrão), depois as worktrees dos agentes. */
  roots: () => string[];
  /** Aviso ao dono de uma ação pelo acesso remoto (só ação e alvo). */
  notify: (what: string, target: string) => Promise<void>;
  /** SIGTERM no processo do agente antigo, na troca de papel. */
  signal: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
  /** relógio em ms (a validade dos caminhos descobertos) */
  now: () => number;
  log: (level: Level, event: string, fields?: Record<string, string | number | boolean | null>) => void;
  /** Instruções de gerente do orquestrador (D7); ausente lê `$D/panel/argos/orchestrator-role.md` da instalação. */
  managerText?: () => string;
  /** O registro de terminais ($D/argos/terminals.json) mudou: o painel avisa as páginas abertas (stream do canvas). */
  onRegistryChange?: () => void;
  /** Os pares sessão/pane que algum canvas tem como nó `terminal` (`canvas.terminalPanes`); sem isso os órfãos não se conferem. */
  canvasPanes?: () => { session: string; pane: string }[];
}

/** Um terminal registrado, vivo no herdr e sem nó em canvas nenhum: o que "Trazer para o canvas" precisa para montar o nó. */
export interface OrphanTerminal {
  session: string;
  pane: string;
  name: string;
  agent: string;
  model?: string;
  effort?: string;
  role?: string;
  orchestrator?: boolean;
  createdAt: string;
}

/** Caminho da conferência de terminais órfãos (GET). */
export const ORPHANS_PATH = `${TERMINALS_PATH}/orphans`;
const UNREADABLE_REGISTRY = "terminals_unreadable";

/** Um terminal que o canvas criou: só esses o canvas fecha ou reinicia. */
interface TerminalRecord {
  session: string;
  pane: string;
  name: string;
  agent: string;
  model?: string;
  effort?: string;
  role?: string;
  cwd: string;
  createdAt: string;
  /** D7: o papel do processo leva as instruções de gerente. */
  orchestrator?: boolean;
  /** Instruções próprias do terminal (o orquestrador as dá ao recruta), somadas às do papel; nunca vão a log. */
  instructions?: string;
}

const isTerminalRecord = (value: unknown): value is TerminalRecord => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Dict;
  const optionalText = (v: unknown): boolean => v === undefined || typeof v === "string";
  return [r.session, r.pane, r.name, r.agent, r.cwd, r.createdAt].every((v) => typeof v === "string") && [r.model, r.effort, r.role, r.instructions].every(optionalText)
    && (r.orchestrator === undefined || typeof r.orchestrator === "boolean");
};

/** O que o terminal vai rodar: o corpo escolhe, senão a predefinição, senão o papel, senão o padrão global. */
export interface TerminalChoice {
  agent: string;
  model?: string;
  effort?: string;
  role?: ArgosRoleEntry;
  /** Blocos somados depois das instruções do papel (instruções próprias, gerente do orquestrador), na ordem. */
  extra?: string[];
}

/** Teto das instruções próprias de um terminal, em bytes UTF-8 (o mesmo porte de um papel grande). */
export const TERMINAL_INSTRUCTIONS_BYTES = 16_384;

/** O texto do papel que o agente recebe (por arquivo ou argumento): papel e blocos extras, separados por linha em branco; vazio é `undefined`. */
export function systemPromptOf(choice: TerminalChoice): string | undefined {
  const parts = [choice.role?.instructions, ...(choice.extra ?? [])].filter((part): part is string => typeof part === "string" && part.trim() !== "");
  return parts.length ? parts.join("\n\n") : undefined;
}

const fail = (code: ArgosErrorCode, message: string): ArgosError => new ArgosError(code, message);
const invalid = (message: string): ArgosError => fail(ARGOS_ERROR_CODES.invalid, message);

/** Regra pura da escolha (D4): campo mandado vence; ausente segue predefinição, depois papel, depois o padrão global. */
export function chooseTerminal(input: { agent?: string; model?: string; effort?: string }, preset: ArgosPresetEntry | undefined, role: ArgosRoleEntry | undefined): TerminalChoice {
  const agent = input.agent ?? preset?.agent ?? role?.agent ?? DEFAULT_AGENT;
  const model = input.model ?? preset?.model ?? role?.model;
  const effort = input.effort ?? preset?.effort ?? role?.effort;
  return { agent, ...(model !== undefined && { model }), ...(effort !== undefined && { effort }), ...(role !== undefined && { role }) };
}

/** Quebra de linha ou byte nulo: o herdr recusa o argumento (`invalid_agent_argument`). */
const UNSAFE_ARG = /[\n\r\0]/;

/** O papel vai por arquivo quando o agente tem flag de arquivo; senão (ou sem papel) é `undefined`. */
export function promptFileText(choice: TerminalChoice): string | undefined {
  return AGENT_KINDS[choice.agent]?.systemPromptFile ? systemPromptOf(choice) : undefined;
}

/**
 * Os argumentos do agente depois do `--` do `herdr agent start`; campo que a CLI não aceita é recusado, nunca ignorado.
 * `promptFile` é o caminho onde a rota gravou o papel (agente com flag de arquivo). Nenhum argumento sai com quebra de
 * linha: recusa aqui, com código próprio, em vez de deixar o herdr falhar.
 */
export function agentArgs(choice: TerminalChoice, promptFile?: string): string[] {
  const flags = AGENT_KINDS[choice.agent];
  if (!flags) throw invalid("agente desconhecido");
  const args: string[] = [];
  const add = (flag: string | undefined, value: string | undefined, what: string): void => {
    if (value === undefined) return;
    if (!flag) throw invalid(`o agente ${choice.agent} não aceita ${what}`);
    args.push(flag, value);
  };
  add(flags.model, choice.model, "modelo");
  add(flags.effort, choice.effort, "esforço");
  const prompt = systemPromptOf(choice);
  if (prompt !== undefined) {
    if (flags.systemPromptFile) args.push(flags.systemPromptFile, promptFile ?? "-");
    else add(flags.systemPrompt, prompt, "papel");
  }
  if (args.some((arg) => UNSAFE_ARG.test(arg))) {
    const hint = prompt !== undefined && !flags.systemPromptFile ? `o agente ${choice.agent} não aceita papel de várias linhas` : "um argumento do agente tem quebra de linha";
    throw fail(ARGOS_ERROR_CODES.unsafeArgument, `${hint}; o herdr recusaria`);
  }
  return args;
}

/** `true` se `child` é `parent` ou fica dentro dele (caminhos já resolvidos). */
const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export function createArgosTerminalsRoutes(deps: ArgosTerminalsDeps) {
  const warn = (event: string, fields: Record<string, string>): void => deps.log("warn", event, fields);
  const roles = createRoleStore(join(deps.dir, "argos", "roles"), warn);
  const presets = createPresetStore(join(deps.dir, "argos", "presets.json"));
  const registryFile = join(deps.dir, "argos", "terminals.json");
  const discovered = new Map<string, number>();
  const rate = createRateLimiter(TERMINAL_RATE, deps.now);

  /** Conferido antes de tudo (também antes do confirm, que assim não se adivinha por força bruta). */
  function throttle(route: string, remote: boolean): void {
    const retryAfterS = rate.take(`${route}\0${remote ? "remoto" : "local"}`);
    if (retryAfterS === undefined) return;
    deps.log("warn", "terminal do canvas: limite de taxa", { rota: route, origem: remote ? "remoto" : "local" });
    throw new ArgosError(ARGOS_ERROR_CODES.rateLimited, `muitas tentativas: espere ${retryAfterS} s`, retryAfterS);
  }

  // ---- registro dos terminais criados ----

  function terminals(): TerminalRecord[] {
    let text: string;
    try {
      text = readFileSync(registryFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const doc: unknown = JSON.parse(text);
    const list = typeof doc === "object" && doc !== null ? (doc as Dict).terminals : undefined;
    if (!Array.isArray(list) || !list.every(isTerminalRecord)) throw new Error("terminals.json fora do formato");
    return list;
  }

  function storeTerminals(list: TerminalRecord[]): void {
    mkdirSync(join(deps.dir, "argos"), { recursive: true });
    const tmp = `${registryFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ terminals: list }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, registryFile);
    deps.onRegistryChange?.();
  }

  async function paneAlive(session: string, pane: string): Promise<boolean | undefined> {
    const snap = await deps.herdr.snap(session);
    if (!snap) return undefined;
    const panes = Array.isArray(snap.panes) ? (snap.panes as Dict[]) : [];
    return panes.some((p) => p.pane_id === pane);
  }

  /** O terminal do canvas no par sessão/pane, com o nome que a tela mostra; outro pane é como inexistente. */
  function recordOf(body: Dict): TerminalRecord {
    const session = typeof body.session === "string" && SESSION_NAME.test(body.session) ? body.session : undefined;
    const pane = typeof body.pane === "string" && PANE_ID.test(body.pane) ? body.pane : undefined;
    if (!session || !pane) throw invalid("sessão ou pane inválido");
    const found = terminals().find((t) => t.session === session && t.pane === pane && t.name === body.name);
    if (!found) throw fail(ARGOS_ERROR_CODES.notFound, "terminal do canvas inexistente");
    return found;
  }

  // ---- entrada ----

  function nameOf(value: unknown): string {
    if (typeof value !== "string" || !TERMINAL_NAME.test(value)) throw invalid("nome inválido (até 40 letras, números, espaço, ponto, hífen, sublinhado)");
    return value;
  }

  /** D1: pelo acesso remoto, `confirm` tem de repetir o nome; conferido antes de ler qualquer recurso. */
  function requireConfirm(body: Dict, expected: string, remote: boolean): void {
    if (remote && body.confirm !== expected) throw fail(ARGOS_ERROR_CODES.confirmRequired, "digite o nome do terminal para confirmar");
  }

  /** Diretório contido: resolvido (links seguidos) e dentro de uma das raízes permitidas; ausente é a primeira raiz. */
  /** As raízes resolvidas; a que não existe (worktree removida) só sai da lista. */
  const allowedRoots = (): string[] => deps.roots().flatMap((root) => {
    try {
      return [realpathSync(root)];
    } catch {
      return [];
    }
  });

  function containedDir(raw: unknown): string {
    const allowed = allowedRoots();
    if (raw === undefined || raw === null || raw === "") {
      const first = allowed[0];
      if (!first) throw invalid("sem diretório de trabalho padrão");
      return first;
    }
    if (typeof raw !== "string" || raw.length > PATH_MAX || raw.includes("\0") || !isAbsolute(raw)) throw invalid("cwd tem de ser um caminho absoluto");
    let real: string;
    try {
      real = realpathSync(raw);
    } catch {
      throw invalid("cwd inexistente");
    }
    if (!statSync(real).isDirectory()) throw invalid("cwd não é diretório");
    if (!allowed.some((root) => within(real, root))) throw invalid("cwd fora do worktree do canvas e do clone");
    return real;
  }

  function roleOf(slug: unknown): ArgosRoleEntry {
    const role = roles.get(slugFormatOf(slug));
    if (!role) throw fail(ARGOS_ERROR_CODES.notFound, "papel inexistente");
    return role;
  }

  /** `orchestrator` do corpo: ausente, `true` ou `false`. */
  function orchestratorOf(raw: unknown): boolean | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== "boolean") throw invalid("orchestrator é true ou false");
    return raw;
  }

  /** `instructions` do corpo: ausente (`undefined`), `null` (tirar) ou texto até o teto, sem byte nulo. */
  function instructionsOf(raw: unknown): string | null | undefined {
    if (raw === undefined || raw === null) return raw;
    if (typeof raw !== "string" || raw.includes("\0") || Buffer.byteLength(raw) > TERMINAL_INSTRUCTIONS_BYTES) {
      throw invalid(`instructions é texto de até ${TERMINAL_INSTRUCTIONS_BYTES} bytes`);
    }
    return raw.trim() === "" ? null : raw;
  }

  function managerText(): string {
    let text: string;
    try {
      text = deps.managerText ? deps.managerText() : readFileSync(join(deps.dir, "panel", "argos", "orchestrator-role.md"), "utf8");
    } catch {
      throw invalid("as instruções de gerente não estão na instalação (reinstale o kit)");
    }
    if (text.trim() === "") throw invalid("as instruções de gerente estão vazias");
    return text;
  }

  /** Blocos extras do system prompt: as instruções próprias e, no orquestrador, as de gerente. */
  const extraOf = (instructions: string | undefined, orchestrator: boolean | undefined): string[] =>
    [...(instructions !== undefined ? [instructions] : []), ...(orchestrator ? [managerText()] : [])];

  // ---- herdr ----

  async function herdrCall(session: string, args: string[], timeoutMs: number, what: string): Promise<string> {
    const r = await deps.herdr.call(session === DEFAULT_SESSION ? null : session, args, timeoutMs);
    if (r.rc !== 0) {
      deps.log("warn", "herdr recusou ação do terminal do canvas", { acao: what, reason: r.err.slice(0, 300) });
      throw fail(ARGOS_ERROR_CODES.herdrFailed, "o herdr recusou (detalhe no log do painel)");
    }
    return r.out;
  }

  /** `$D/argos/terminal-prompts/<sessão>-<pane>.md`: o papel do processo, lido pela CLI do agente na subida. */
  const promptFileOf = (session: string, pane: string): string => join(deps.dir, "argos", "terminal-prompts", `${session}-${pane.replace(/:/g, "-")}.md`);

  /** Pasta 700, arquivo 600, troca atômica (o texto do papel é dado do dono e não vai a log). */
  function writePrompt(session: string, pane: string, text: string): string {
    const file = promptFileOf(session, pane);
    const dir = join(deps.dir, "argos", "terminal-prompts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
    return file;
  }

  function removePrompt(session: string, pane: string): void {
    try {
      rmSync(promptFileOf(session, pane), { force: true });
    } catch (error) {
      deps.log("warn", "arquivo do papel do terminal não foi apagado", { pane, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const startArgs = (name: string, pane: string, choice: TerminalChoice, promptFile?: string): string[] => {
    const args = agentArgs(choice, promptFile);
    return ["agent", "start", name, "--kind", choice.agent, "--pane", pane, "--timeout", String(TERMINAL_TIMEOUTS.startMs - 5000), ...(args.length ? ["--", ...args] : [])];
  };

  /** O shell do pane está no prompt: só ele no primeiro plano e a tela já com texto (logo depois do spawn ela está vazia). */
  async function atPrompt(session: string, pane: string): Promise<boolean> {
    const herdrSession = session === DEFAULT_SESSION ? null : session;
    const info = (await deps.herdr.json(herdrSession, ["pane", "process-info", "--pane", pane]))?.process_info as Dict | undefined;
    if (!info || typeof info.shell_pid !== "number") return false;
    const procs = Array.isArray(info.foreground_processes) ? (info.foreground_processes as Dict[]) : [];
    if (procs.some((p) => p.pid !== info.shell_pid)) return false;
    const screen = await deps.herdr.call(herdrSession, ["pane", "read", pane], TERMINAL_TIMEOUTS.paneMs);
    return screen.rc === 0 && screen.out.trim() !== "";
  }

  /** Espera o prompt do pane novo; no teto segue assim mesmo (o `agent start` do herdr decide) e deixa o aviso no log. */
  async function waitPrompt(session: string, pane: string): Promise<void> {
    let steady = 0;
    for (let i = 0; i < TERMINAL_TIMEOUTS.promptPolls; i++) {
      steady = (await atPrompt(session, pane)) ? steady + 1 : 0;
      if (steady >= TERMINAL_TIMEOUTS.promptSteady) return;
      await deps.sleep(TERMINAL_TIMEOUTS.promptPollMs);
    }
    deps.log("warn", "shell do pane novo não chegou ao prompt no prazo; o agent start segue", { pane });
  }

  /** PIDs do primeiro plano do pane que não são o shell: o agente a reiniciar. */
  async function agentPids(session: string, pane: string): Promise<number[]> {
    const info = (await deps.herdr.json(session === DEFAULT_SESSION ? null : session, ["pane", "process-info", "--pane", pane]))?.process_info as Dict | undefined;
    if (!info) throw fail(ARGOS_ERROR_CODES.herdrFailed, "o herdr não respondeu sobre o processo do pane");
    const shell = info.shell_pid;
    const procs = Array.isArray(info.foreground_processes) ? (info.foreground_processes as Dict[]) : [];
    return procs.map((p) => p.pid).filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 1 && pid !== shell);
  }

  function audit(what: string, name: string, target: string, remote: boolean): void {
    deps.log("info", "terminal do canvas", { acao: what, nome: name, alvo: target, origem: remote ? "remoto" : "local" });
    if (remote) {
      deps.notify(what, name).catch((error: unknown) => deps.log("warn", "aviso remoto do terminal do canvas falhou", { reason: error instanceof Error ? error.message : String(error) }));
    }
  }

  // ---- terminais ----

  async function create(body: Dict, remote: boolean): Promise<Dict> {
    throttle("criar", remote);
    const name = nameOf(body.name);
    requireConfirm(body, name, remote);
    const preset = optional(body.preset, (slug) => {
      const found = presets.get(slugFormatOf(slug));
      if (!found) throw fail(ARGOS_ERROR_CODES.notFound, "predefinição inexistente");
      return found;
    });
    const roleSlug = body.role ?? preset?.role;
    const role = optional(roleSlug, roleOf);
    const orchestrator = orchestratorOf(body.orchestrator) === true;
    const instructions = instructionsOf(body.instructions) ?? undefined;
    const chosen = chooseTerminal({ agent: optional(body.agent, agentOf), model: optional(body.model, modelOf), effort: optional(body.effort, effortOf) }, preset, role);
    const extra = extraOf(instructions, orchestrator);
    const choice: TerminalChoice = extra.length ? { ...chosen, extra } : chosen;
    agentArgs(choice); // recusa (modelo, esforço, papel) que o agente não aceita antes de abrir o pane
    const cwd = containedDir(body.cwd);

    const alive: TerminalRecord[] = [];
    for (const t of terminals()) {
      if ((await paneAlive(t.session, t.pane)) !== false) alive.push(t);
      else removePrompt(t.session, t.pane);
    }
    if (alive.some((t) => t.name === name)) throw invalid("já existe um terminal do canvas com esse nome");
    if (alive.length >= TERMINAL_LIMITS.terminals) throw invalid(`limite de ${TERMINAL_LIMITS.terminals} terminais do canvas`);

    const session = DEFAULT_SESSION;
    const pane = paneFrom(await herdrCall(session, ["workspace", "create", "--cwd", cwd, "--label", name, "--no-focus"], TERMINAL_TIMEOUTS.paneMs, "criar-pane"));
    if (!PANE_ID.test(pane)) throw fail(ARGOS_ERROR_CODES.herdrFailed, "o herdr não devolveu o pane criado");
    try {
      const promptText = promptFileText(choice);
      const promptFile = promptText !== undefined ? writePrompt(session, pane, promptText) : undefined;
      await waitPrompt(session, pane);
      await herdrCall(session, startArgs(name, pane, choice, promptFile), TERMINAL_TIMEOUTS.startMs, "iniciar-agente");
    } catch (error) {
      removePrompt(session, pane);
      // o pane sem agente não fica para trás: o canvas não o registrou e ninguém o fecharia
      const closed = await deps.herdr.call(null, ["pane", "close", pane], TERMINAL_TIMEOUTS.paneMs);
      if (closed.rc !== 0) deps.log("warn", "pane órfão do terminal do canvas não fechou", { pane, reason: closed.err.slice(0, 300) });
      throw error;
    }
    const record: TerminalRecord = {
      session, pane, name, agent: choice.agent, cwd, createdAt: new Date(deps.now()).toISOString(),
      ...(choice.model !== undefined && { model: choice.model }), ...(choice.effort !== undefined && { effort: choice.effort }),
      ...(choice.role !== undefined && { role: choice.role.slug }),
      ...(orchestrator && { orchestrator: true }), ...(instructions !== undefined && { instructions }),
    };
    storeTerminals([...alive, record]);
    deps.herdr.forget();
    audit("terminal-criar", name, pane, remote);
    return {
      herdr: { session, pane }, agent: choice.agent,
      ...(choice.model !== undefined && { model: choice.model }), ...(choice.effort !== undefined && { effort: choice.effort }),
      ...(choice.role !== undefined && { role: choice.role.slug }), ...(orchestrator && { orchestrator: true }),
    };
  }

  async function close(body: Dict, remote: boolean): Promise<Dict> {
    throttle("fechar", remote);
    const name = nameOf(body.name);
    requireConfirm(body, name, remote);
    const record = recordOf(body);
    // o pane que já sumiu (fechado no herdr) só sai do registro: repetir o fechamento é inofensivo
    if ((await paneAlive(record.session, record.pane)) !== false) {
      await herdrCall(record.session, ["pane", "close", record.pane], TERMINAL_TIMEOUTS.paneMs, "fechar-pane");
    }
    storeTerminals(terminals().filter((t) => !(t.session === record.session && t.pane === record.pane)));
    removePrompt(record.session, record.pane);
    deps.herdr.forget();
    audit("terminal-fechar", name, record.pane, remote);
    return { ok: true };
  }

  async function changeRole(body: Dict, remote: boolean): Promise<Dict> {
    const name = nameOf(body.name);
    requireConfirm(body, name, remote);
    const record = recordOf(body);
    if (body.role === undefined) throw invalid("role é o slug do papel ou null");
    const role = body.role === null ? undefined : roleOf(body.role);
    // orquestrador e instruções próprias: ausente no corpo mantém o que o terminal tinha; `null` tira as instruções
    const orchestrator = orchestratorOf(body.orchestrator) ?? record.orchestrator === true;
    const given = instructionsOf(body.instructions);
    const instructions = given === undefined ? record.instructions : (given ?? undefined);
    const extra = extraOf(instructions, orchestrator);
    const choice: TerminalChoice = {
      agent: record.agent, ...(record.model !== undefined && { model: record.model }), ...(record.effort !== undefined && { effort: record.effort }),
      ...(role !== undefined && { role }), ...(extra.length > 0 && { extra }),
    };
    agentArgs(choice); // recusa o papel que o agente não aceita antes de matar o processo
    const promptText = promptFileText(choice);
    const promptFile = promptText !== undefined ? writePrompt(record.session, record.pane, promptText) : undefined;
    if (promptText === undefined) removePrompt(record.session, record.pane);
    // reinicia só o processo: o pane (e o nó, a posição, as conexões) fica; o agente novo sobe no shell que sobrou
    for (const pid of await agentPids(record.session, record.pane)) deps.signal(pid);
    let left = await agentPids(record.session, record.pane);
    for (let i = 0; left.length > 0 && i < TERMINAL_TIMEOUTS.exitPolls; i++) {
      await deps.sleep(TERMINAL_TIMEOUTS.exitPollMs);
      left = await agentPids(record.session, record.pane);
    }
    if (left.length > 0) throw fail(ARGOS_ERROR_CODES.herdrFailed, "o processo do agente não saiu");
    await waitPrompt(record.session, record.pane);
    await herdrCall(record.session, startArgs(name, record.pane, choice, promptFile), TERMINAL_TIMEOUTS.startMs, "reiniciar-agente");
    const updated: TerminalRecord = { ...record, role: role?.slug, orchestrator, instructions };
    if (role === undefined) delete updated.role;
    if (!orchestrator) delete updated.orchestrator;
    if (instructions === undefined) delete updated.instructions;
    storeTerminals(terminals().map((t) => (t.session === record.session && t.pane === record.pane ? updated : t)));
    deps.herdr.forget();
    audit("terminal-papel", name, record.pane, remote);
    return { herdr: { session: record.session, pane: record.pane }, ...(orchestrator && { orchestrator: true }) };
  }

  // ---- papéis: descoberta e importação ----

  function remember(paths: string[]): void {
    const now = deps.now();
    for (const [path, until] of discovered) if (until <= now) discovered.delete(path);
    for (const path of paths) {
      discovered.delete(path);
      discovered.set(path, now + DISCOVERED_TTL_MS);
    }
    for (const path of discovered.keys()) {
      if (discovered.size <= DISCOVERED_MAX) break;
      discovered.delete(path);
    }
  }

  function discover(body: Dict): Dict {
    const root = containedDir(body.cwd);
    const found = discoverRoles(root, warn).map(({ path, role }) => {
      const slug = slugify(role.name);
      return { path, slug, role, exists: roles.get(slug) !== undefined };
    });
    remember(found.map((f) => f.path));
    return { found };
  }

  function importRoles(body: Dict): Dict {
    if (!Array.isArray(body.paths) || body.paths.length > DISCOVER_LIMITS.found || body.paths.some((p) => typeof p !== "string")) {
      throw invalid(`paths é uma lista de até ${DISCOVER_LIMITS.found} caminhos`);
    }
    const imported: ArgosRoleEntry[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const now = deps.now();
    for (const path of body.paths as string[]) {
      const until = discovered.get(path);
      if (until === undefined || until <= now) {
        skipped.push({ path, reason: IMPORT_SKIP.notDiscovered });
        continue;
      }
      let real: string | undefined;
      try {
        real = realpathSync(path);
      } catch {
        real = undefined;
      }
      // a pasta pode ter virado link depois da descoberta: o arquivo de hoje tem de seguir dentro das raízes
      const role = real !== undefined && real === path ? readRoleFile(path, warn) : undefined;
      if (!role || !allowedRoots().some((r) => within(path, r))) {
        skipped.push({ path, reason: IMPORT_SKIP.invalid });
        continue;
      }
      if (roles.get(slugify(role.name))) {
        skipped.push({ path, reason: IMPORT_SKIP.exists });
        continue;
      }
      try {
        imported.push(roles.save(role));
      } catch (error) {
        if (!(error instanceof ArgosError)) throw error;
        skipped.push({ path, reason: IMPORT_SKIP.invalid });
      }
    }
    if (imported.length) deps.log("info", "papéis importados", { slugs: imported.map((r) => r.slug).join(","), pulados: skipped.length });
    return { imported, skipped };
  }

  // ---- papéis e predefinições: CRUD ----

  const slugOrUndefined = (value: unknown): string | undefined => optional(value, slugFormatOf);

  function saveRole(body: Dict): Dict {
    const role = roles.save(body.role, slugOrUndefined(body.slug));
    deps.log("info", "papel gravado", { slug: role.slug });
    return { role };
  }

  function deleteRole(body: Dict): Dict {
    const slug = slugFormatOf(body.slug);
    if (body.confirm !== slug) throw fail(ARGOS_ERROR_CODES.confirmRequired, "digite o slug do papel para confirmar");
    roles.remove(slug);
    deps.log("info", "papel apagado", { slug });
    return { ok: true };
  }

  function savePreset(body: Dict): Dict {
    const preset = presets.save(body.preset, slugOrUndefined(body.slug));
    deps.log("info", "predefinição gravada", { slug: preset.slug });
    return { preset };
  }

  function deletePreset(body: Dict): Dict {
    const slug = slugFormatOf(body.slug);
    presets.remove(slug);
    deps.log("info", "predefinição apagada", { slug });
    return { ok: true };
  }

  const POST_ROUTES: Readonly<Record<string, (body: Dict, remote: boolean) => Dict | Promise<Dict>>> = {
    "/api/argos/presets": savePreset,
    "/api/argos/presets/delete": deletePreset,
    "/api/argos/roles": saveRole,
    "/api/argos/roles/delete": deleteRole,
    "/api/argos/roles/discover": discover,
    "/api/argos/roles/import": importRoles,
    [TERMINALS_PATH]: create,
    [`${TERMINALS_PATH}/close`]: close,
    [`${TERMINALS_PATH}/role`]: changeRole,
  };

  const refused = (error: ArgosError): Response => {
    const res = send(ARGOS_ERROR_STATUS[error.code], { error: error.message, code: error.code });
    if (error.retryAfterS !== undefined) res.headers.set("Retry-After", String(error.retryAfterS));
    return res;
  };

  /**
   * Reconcilia `terminals.json` com os canvases: terminal registrado, com pane vivo e sem nó em canvas nenhum. `checked: false`
   * quando não deu para afirmar (herdr fora do ar, ou o painel sem a lista de panes dos canvases): nunca se chama de órfão o que
   * não foi conferido.
   */
  async function orphans(): Promise<Response> {
    let registered: TerminalRecord[];
    try {
      registered = terminals();
    } catch (error) {
      deps.log("error", "registro de terminais ilegível", { reason: error instanceof Error ? error.name : "erro" });
      return send(500, { error: "o registro de terminais não pôde ser lido", code: UNREADABLE_REGISTRY });
    }
    if (!deps.canvasPanes) return send(200, { orphans: [], checked: false });
    const inCanvas = new Set(deps.canvasPanes().map((p) => `${p.session}\0${p.pane}`));
    const found: OrphanTerminal[] = [];
    let checked = true;
    for (const t of registered) {
      if (inCanvas.has(`${t.session}\0${t.pane}`)) continue;
      const alive = await paneAlive(t.session, t.pane);
      if (alive === undefined) { checked = false; continue; }
      if (!alive) continue;
      found.push({
        session: t.session, pane: t.pane, name: t.name, agent: t.agent, createdAt: t.createdAt,
        ...(t.model !== undefined && { model: t.model }), ...(t.effort !== undefined && { effort: t.effort }),
        ...(t.role !== undefined && { role: t.role }), ...(t.orchestrator === true && { orchestrator: true }),
      });
    }
    if (found.length > 0) deps.log("warn", "terminal fora do canvas", { terminais: found.length });
    return send(200, { orphans: found, checked });
  }

  return {
    /** GET assíncrono dos terminais órfãos; outro caminho não é desta rota (undefined). */
    orphans(path: string): Promise<Response> | undefined {
      return path === ORPHANS_PATH ? orphans() : undefined;
    },
    /** GET das listas; outro caminho não é desta família (undefined). */
    get(path: string): Response | undefined {
      if (path === "/api/argos/presets") return send(200, { presets: presets.list() });
      if (path === "/api/argos/roles") return send(200, { roles: roles.list() });
      return undefined;
    },
    /** POST da família; outro caminho é undefined. Erro do contrato vira `{error, code}`; o resto sobe (500 genérico). */
    post(path: string, body: Dict, caller: { remote: boolean }): Promise<Response> | undefined {
      const route = POST_ROUTES[path];
      if (!Object.hasOwn(POST_ROUTES, path) || !route) return undefined;
      return (async () => {
        try {
          return send(200, await route(body, caller.remote));
        } catch (error) {
          if (error instanceof ArgosError) return refused(error);
          throw error;
        }
      })();
    },
  };
}

export type ArgosTerminalsRoutes = ReturnType<typeof createArgosTerminalsRoutes>;

/**
 * As worktrees dos agentes registrados e não encerrados (`<orch>/agents/*.json`): são as worktrees que o canvas abre por
 * escopo, e as raízes onde um terminal do canvas pode abrir além do clone. Registro ilegível é pulado.
 */
export function agentWorktrees(orchDirs: string[]): string[] {
  const out = new Set<string>();
  for (const orch of orchDirs) {
    let files: string[];
    try {
      files = readdirSync(join(orch, "agents")).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const agent: unknown = JSON.parse(readFileSync(join(orch, "agents", file), "utf8"));
        const record = typeof agent === "object" && agent !== null ? (agent as Dict) : {};
        if (typeof record.worktree === "string" && isAbsolute(record.worktree) && record.state !== "done") out.add(record.worktree);
      } catch {
        continue;
      }
    }
  }
  return [...out];
}
