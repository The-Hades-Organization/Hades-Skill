// A página Herdr: visão geral de todas as sessões, leitura de painel, ações validadas contra a listagem atual e ações de
// sessão. O texto de prompt nunca vai ao log nem ao notify; só hora, ação e alvo.
import { appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { AGENT_KINDS } from "../lib/argos-roles.ts";
import { readText } from "../lib/fs.ts";
import { which } from "../lib/proc.ts";
import { exec } from "./exec.ts";
import type { PanelEnv } from "./env.ts";
import { createHerdrSocket, type Herdr, HerdrSocketError, type HerdrSocket } from "./herdr.ts";
import { BadRequest } from "./http.ts";
import { configValues } from "./routes-core.ts";

type Dict = Record<string, unknown>;

// nome da tela -> nome do herdr, conferidos um a um no `pane.send_input` do 0.8.2. O herdr não tem Home, End, PageUp,
// PageDown nem Delete (`invalid_key`), e a sequência mandada como `text` chega dentro de colagem entre colchetes
const CTRL_LETTERS = Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((l) => [`Ctrl+${l}`, `ctrl+${l.toLowerCase()}`]));
export const KEYS: Record<string, string> = {
  ...CTRL_LETTERS,
  Enter: "Enter", Escape: "Escape", "Ctrl+C": "C-c", Tab: "Tab", Up: "Up", Down: "Down", Left: "Left", Right: "Right", y: "y", n: "n",
  Backspace: "Backspace", "Shift+Tab": "shift+tab",
};
export const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PANE_ID = /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/;
const AGENT_LABEL = /^[A-Za-z0-9][\w .-]{0,39}$/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g;
const SESSIONS_TTL_S = 5;
const BRANCH_TTL_S = 30;
const REMOTE_NOTICE_GAP_S = 60;
const READ_LINES_DEFAULT = 200;
const READ_LINES_MIN = 10;
const READ_LINES_MAX = 400;
// histórico do terminal do nó (reference/argos.md §Terminal do nó): teto imposto aqui, o pedido acima dele é recusado
export const SCROLLBACK_LINES_DEFAULT = 500;
export const SCROLLBACK_LINES_MAX = 2000;
const SCROLLBACK_TIMEOUT_MS = 10_000;
export const MAX_KEYS = 12;
export const MAX_TEXT = 20_000;
const ACT_TIMEOUT_MS = 20_000;
const SESSION_ACT_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 3000;
const NOTIFY_TIMEOUT_MS = 30_000;
// gerência (reference/panel.md §Herdr): o `agent start` espera o agente ficar pronto (o padrão do herdr é 30 s)
const AGENT_START_TIMEOUT_MS = 60_000;
const LABEL_MAX = 64;
const PATH_MAX = 4096;
const AGENT_ARGS_MAX = 16;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// nome de agente do herdr (`herdr --skill`): `[a-z][a-z0-9_-]{0,31}`
const AGENT_START_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
// argumento do agente depois do `--`: um token só, sem espaço, aspas nem quebra de linha
const AGENT_ARG = /^[\w@%+=:,./[\]-]{1,200}$/;
export const ADMIN_ACTIONS = [
  "workspace-create", "workspace-rename", "workspace-close", "tab-create", "tab-rename", "tab-close",
  "pane-split", "pane-rename", "pane-close", "agent-start",
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];
export const SPLIT_DIRECTIONS = ["right", "down"] as const;

const rows = (value: unknown): Dict[] => (Array.isArray(value) ? (value as Dict[]) : []);
const countStatus = (agents: Dict[], status: string): number => agents.filter((a) => a.agent_status === status).length;
/** `str(x or '')` do original. */
const textOf = (value: unknown): string => (value === undefined || value === null || value === false || value === 0 || value === "" ? "" : String(value));
const nowS = (): number => Date.now() / 1000;

function localStamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** O `int()` do original sobre o `lines` da query (a tela mostra a mensagem do ValueError). */
function linesOf(raw: string | undefined): number {
  const value = raw === undefined || raw === "" ? READ_LINES_DEFAULT : raw;
  if (!/^\s*[+-]?\d+\s*$/.test(String(value))) throw new BadRequest(`invalid literal for int() with base 10: '${value}'`);
  return Math.max(READ_LINES_MIN, Math.min(Number.parseInt(String(value), 10) || READ_LINES_DEFAULT, READ_LINES_MAX));
}

/** `lines` do histórico: inteiro de 1 a SCROLLBACK_LINES_MAX; vazio vale o padrão, o resto é recusado (nunca truncado em silêncio). */
export function scrollbackLinesOf(raw: string | undefined): number {
  if (raw === undefined || raw === "") return SCROLLBACK_LINES_DEFAULT;
  if (!/^\d{1,6}$/.test(raw)) throw new BadRequest("lines inválido");
  const n = Number.parseInt(raw, 10);
  if (n < 1 || n > SCROLLBACK_LINES_MAX) throw new BadRequest(`lines fora de 1 a ${SCROLLBACK_LINES_MAX}`);
  return n;
}

/** Exigir o nome do alvo em `confirm` (HADES_CONFIRM_TYPED): só o "0" gravado desliga; chave ausente ou lixo fecha. */
export const typedConfirmRequired = (values: Record<string, string>): boolean => values.HADES_CONFIRM_TYPED !== "0";

export interface HerdrPage {
  overview(session?: string): Promise<Dict>;
  read(session: string | undefined, pane: string | undefined, lines: string | undefined): Promise<Dict>;
  /** Histórico (`GET /api/herdr/scrollback`): as últimas `lines` linhas do pane (`source: recent`), em ANSI, de um pane validado. */
  scrollback(session: string | undefined, pane: string | undefined, lines: string | undefined): Promise<Dict>;
  act(body: Dict, remote: boolean): Promise<Dict>;
  sessionAct(body: Dict, remote: boolean): Promise<Dict>;
  /** Gerência da estrutura (`POST /api/herdr/admin`): criar, fechar, renomear, split e `agent start`; alvo conferido no retrato atual. */
  admin(body: Dict, remote: boolean): Promise<Dict>;
  /** Entrada direta (`POST /api/herdr/input`): texto e/ou teclas pelo `pane.send_input`; devolve o alvo validado. */
  input(body: Dict, remote: boolean): Promise<{ session: string; pane: string }>;
  /** Socket da API da sessão, pela listagem atual; undefined se a sessão não existe ou não está rodando. */
  socketOf(session: string): Promise<string | undefined>;
}

/** Corpo do `pane.send_input` validado: texto até MAX_TEXT, teclas da lista fechada, ao menos um dos dois. */
export function inputParams(pane: string, body: Dict): Dict {
  const { text, keys } = body;
  if (text !== undefined && typeof text !== "string") throw new BadRequest("texto inválido");
  if (typeof text === "string" && text.length > MAX_TEXT) throw new BadRequest(`texto grande demais (${MAX_TEXT} caracteres)`);
  if (keys !== undefined && (!Array.isArray(keys) || keys.length > MAX_KEYS || keys.some((k) => typeof k !== "string" || !Object.hasOwn(KEYS, k)))) {
    throw new BadRequest("tecla inválida");
  }
  const named = ((keys ?? []) as string[]).map((k) => KEYS[k] as string);
  if (!text && named.length === 0) throw new BadRequest("nada a enviar: texto ou teclas");
  return { pane_id: pane, ...(text ? { text } : {}), ...(named.length ? { keys: named } : {}) };
}

// `os.homedir()` do Bun não relê o HOME depois da subida; o painel e os testes mudam o HOME do processo
const homeDir = (): string => process.env.HOME || homedir();

/** Rótulo de workspace, aba ou painel: uma linha, aparado, sem controle e sem começar por `-` (a CLI o leria como opção). */
export function adminLabel(raw: unknown, required: boolean): string | undefined {
  const label = textOf(raw).trim();
  if (!label) {
    if (required) throw new BadRequest("nome obrigatório");
    return undefined;
  }
  if (label.length > LABEL_MAX || CONTROL.test(label) || label.startsWith("-")) throw new BadRequest(`nome inválido (até ${LABEL_MAX} caracteres, uma linha, sem "-" no começo)`);
  return label;
}

/** Diretório de trabalho do workspace novo: absoluto, existente e dentro do home de quem roda o painel. */
export function adminCwd(raw: unknown, home: string = homeDir()): string | undefined {
  const value = textOf(raw).trim();
  if (!value) return undefined;
  if (value.length > PATH_MAX || CONTROL.test(value) || !isAbsolute(value)) throw new BadRequest("pasta inválida: use um caminho absoluto");
  const path = normalize(value).replace(new RegExp(`${sep}+$`), "") || sep;
  const base = normalize(home);
  if (path !== base && !path.startsWith(base + sep)) throw new BadRequest("pasta fora do home");
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new BadRequest("a pasta não existe");
  return path;
}

interface AdminPlan {
  argv: string[];
  /** alvo para o log e o aviso: um ID do herdr, nunca texto digitado */
  target: string;
  /** destrutiva: o corpo traz `confirm` com este nome */
  confirmName?: string;
  timeoutMs: number;
}

/** Procura o ID na lista do retrato; o ID que a tela mandou só vale se existir agora. */
function inSnapshot(list: Dict[], key: string, value: unknown, what: string): Dict {
  const id = textOf(value);
  const found = typeof value === "string" ? list.find((row) => row[key] === id) : undefined;
  if (!found) throw new BadRequest(`${what} inexistente: atualize a lista`);
  return found;
}

/** Decisão pura: valida o corpo contra o retrato da sessão e monta o argv do herdr (sem rodar nada). */
export function adminPlan(what: AdminAction, body: Dict, snap: Dict, home: string = homeDir()): AdminPlan {
  const timeoutMs = ACT_TIMEOUT_MS;
  const workspace = (): Dict => inSnapshot(rows(snap.workspaces), "workspace_id", body.workspace, "workspace");
  const tab = (): Dict => inSnapshot(rows(snap.tabs), "tab_id", body.tab, "aba");
  const pane = (): Dict => inSnapshot(rows(snap.panes), "pane_id", body.pane, "painel");
  const named = (row: Dict, key: string): string => textOf(row.label) || textOf(row[key]);
  switch (what) {
    case "workspace-create": {
      const label = adminLabel(body.label, false);
      const cwd = adminCwd(body.cwd, home);
      return { argv: ["workspace", "create", "--no-focus", ...(label ? ["--label", label] : []), ...(cwd ? ["--cwd", cwd] : [])], target: "novo", timeoutMs };
    }
    case "workspace-rename": {
      const w = workspace();
      return { argv: ["workspace", "rename", textOf(w.workspace_id), adminLabel(body.label, true) as string], target: textOf(w.workspace_id), timeoutMs };
    }
    case "workspace-close": {
      const w = workspace();
      return { argv: ["workspace", "close", textOf(w.workspace_id)], target: textOf(w.workspace_id), confirmName: named(w, "workspace_id"), timeoutMs };
    }
    case "tab-create": {
      const w = workspace();
      const label = adminLabel(body.label, false);
      return { argv: ["tab", "create", "--workspace", textOf(w.workspace_id), "--no-focus", ...(label ? ["--label", label] : [])], target: textOf(w.workspace_id), timeoutMs };
    }
    case "tab-rename": {
      const t = tab();
      return { argv: ["tab", "rename", textOf(t.tab_id), adminLabel(body.label, true) as string], target: textOf(t.tab_id), timeoutMs };
    }
    case "tab-close": {
      const t = tab();
      return { argv: ["tab", "close", textOf(t.tab_id)], target: textOf(t.tab_id), confirmName: named(t, "tab_id"), timeoutMs };
    }
    case "pane-split": {
      const p = pane();
      const direction = textOf(body.direction);
      if (!(SPLIT_DIRECTIONS as readonly string[]).includes(direction)) throw new BadRequest("direção inválida (right ou down)");
      return { argv: ["pane", "split", textOf(p.pane_id), "--direction", direction, "--no-focus"], target: textOf(p.pane_id), timeoutMs };
    }
    case "pane-rename": {
      const p = pane();
      return { argv: ["pane", "rename", textOf(p.pane_id), adminLabel(body.label, true) as string], target: textOf(p.pane_id), timeoutMs };
    }
    case "pane-close": {
      const p = pane();
      const agent = rows(snap.agents).find((a) => a.pane_id === p.pane_id);
      return { argv: ["pane", "close", textOf(p.pane_id)], target: textOf(p.pane_id), confirmName: textOf(agent?.name) || textOf(p.pane_id), timeoutMs };
    }
    case "agent-start": {
      const p = pane();
      const name = textOf(body.name);
      const kind = textOf(body.kind);
      if (!AGENT_START_NAME.test(name)) throw new BadRequest("nome do agente inválido (minúsculas, números, _ e -; até 32)");
      if (!Object.hasOwn(AGENT_KINDS, kind)) throw new BadRequest("tipo de agente desconhecido");
      if (p.agent || rows(snap.agents).some((a) => a.pane_id === p.pane_id)) throw new BadRequest("este painel já tem agente");
      if (rows(snap.agents).some((a) => a.name === name)) throw new BadRequest("já existe um agente com esse nome");
      const args = body.args === undefined ? [] : body.args;
      if (!Array.isArray(args) || args.length > AGENT_ARGS_MAX || args.some((a) => typeof a !== "string" || !AGENT_ARG.test(a))) {
        throw new BadRequest(`argumentos inválidos (até ${AGENT_ARGS_MAX}, sem espaço nem aspas)`);
      }
      return { argv: ["agent", "start", name, "--kind", kind, "--pane", textOf(p.pane_id), ...(args.length ? ["--", ...(args as string[])] : [])], target: textOf(p.pane_id), timeoutMs: AGENT_START_TIMEOUT_MS };
    }
    default: {
      const unreachable: never = what;
      throw new BadRequest(`ação inválida: ${String(unreachable)}`);
    }
  }
}

/** ID do que o herdr acabou de criar (`workspace`, `tab` ou `pane` na resposta), para a tela selecionar. */
function createdIdOf(out: string): string | undefined {
  try {
    const result = ((JSON.parse(out) as Dict).result ?? {}) as Dict;
    for (const [key, idKey] of [["workspace", "workspace_id"], ["tab", "tab_id"], ["pane", "pane_id"]] as const) {
      const id = (result[key] as Dict | undefined)?.[idKey];
      if (typeof id === "string") return id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function createHerdrPage(env: PanelEnv, herdr: Herdr, socket: HerdrSocket = createHerdrSocket()): HerdrPage {
  const logFile = join(env.dir, "logs", "panel-herdr.log");
  const seen = new Map<string, { status: string; t: number }>();
  const branches = new Map<string, { t: number; value: string | null }>();
  const notified = new Map<string, number>();
  const orchestrationRoot = env.locks ? join(dirname(env.locks), "orchestration") : undefined;

  const sessions = (): Promise<Dict[]> =>
    herdr.cached("\0sessions", async () => {
      const r = await herdr.call(null, ["session", "list", "--json"]);
      if (r.rc !== 0) return [];
      try {
        return rows((JSON.parse(r.out) as Dict).sessions);
      } catch {
        return [];
      }
    }, SESSIONS_TTL_S);

  async function branchOf(cwd: string): Promise<string | null> {
    const hit = branches.get(cwd);
    if (hit && nowS() - hit.t < BRANCH_TTL_S) return hit.value;
    const git = async (args: string[]): Promise<string> => (await exec(["git", "-C", cwd, ...args], { timeoutMs: GIT_TIMEOUT_MS })).stdout.trim();
    const value = (await git(["symbolic-ref", "--short", "-q", "HEAD"])) || (await git(["rev-parse", "--short", "HEAD"])) || null;
    branches.set(cwd, { t: nowS(), value });
    return value;
  }

  /** Agentes que a orquestração da Hades registrou e ainda não terminaram, por nome. */
  function registered(): Map<string, Dict> {
    const out = new Map<string, Dict>();
    if (!orchestrationRoot) return out;
    let files: string[];
    try {
      files = readdirSync(join(orchestrationRoot, "agents")).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return out;
    }
    for (const f of files) {
      const text = readText(join(orchestrationRoot, "agents", f));
      let agent: Dict;
      try {
        agent = JSON.parse(text ?? "") as Dict;
      } catch {
        continue;
      }
      if (agent.name && agent.state !== "done") out.set(String(agent.name), { state: agent.state ?? null, mode: agent.mode ?? null });
    }
    return out;
  }

  async function sessionOf(name: string | undefined): Promise<string> {
    const session = name || "default";
    if (!(await sessions()).some((s) => s.name === session)) throw new BadRequest("sessão do herdr desconhecida");
    return session;
  }

  /** Valida o painel contra a listagem atual (nunca confia no ID vindo da tela). */
  async function paneOf(session: string, pane: unknown): Promise<{ id: string; info: Dict }> {
    const id = textOf(pane);
    const snap = await herdr.snap(session);
    if (!PANE_ID.test(id) || !snap) throw new BadRequest("painel inválido");
    const info = rows(snap.panes).find((p) => p.pane_id === id);
    if (!info) throw new BadRequest("painel inexistente: atualize a lista");
    return { id, info };
  }

  async function overview(requested?: string): Promise<Dict> {
    if (!which("herdr")) return { available: false, reason: "binário herdr ausente", sessions: [], tree: [] };
    const all = await sessions();
    const names = all.map((s) => String(s.name));
    const session = requested && names.includes(requested) ? requested : names.includes("default") ? "default" : (names[0] ?? null);
    const mine = process.env.HERDR_SOCKET_PATH;
    const views: Dict[] = [];
    for (const s of all) {
      const snap = s.running ? await herdr.snap(String(s.name)) : null;
      const agents = rows(snap?.agents);
      views.push({
        name: s.name, running: Boolean(s.running), default: Boolean(s.default), socket: s.socket_path ?? null, agents: agents.length,
        working: countStatus(agents, "working"), blocked: countStatus(agents, "blocked"), own: Boolean(mine && mine === s.socket_path),
      });
    }
    const out: Dict = { available: true, sessions: views, session, tree: [], reason: null };
    if (!session) return { ...out, reason: "nenhuma sessão do herdr" };
    const snap = await herdr.snap(session);
    if (!snap) return { ...out, reason: "servidor herdr desta sessão fora do ar" };
    const now = nowS();
    const reg = registered();
    const agents = new Map(rows(snap.agents).map((a) => [String(a.pane_id), a]));
    const panesByTab = new Map<string, Dict[]>();
    for (const p of rows(snap.panes)) {
      const a = agents.get(String(p.pane_id)) ?? {};
      const status = textOf(p.agent_status) || "unknown";
      const key = `${session}\0${String(p.pane_id)}`;
      const before = seen.get(key);
      if (!before || before.status !== status) seen.set(key, { status, t: now });
      const cwd = (p.foreground_cwd || p.cwd) as string | undefined;
      const name = a.name as string | undefined;
      const hades = name ? reg.get(name) : undefined;
      const list = panesByTab.get(String(p.tab_id)) ?? [];
      list.push({
        id: p.pane_id, focused: Boolean(p.focused), cwd: p.cwd ?? null, fcwd: p.foreground_cwd ?? null, branch: cwd ? await branchOf(cwd) : null,
        title: textOf(p.terminal_title_stripped) || null, agent: p.agent || a.agent || null, name: name ?? null, status,
        since: (seen.get(key) as { t: number }).t, ready: a.interactive_ready ?? null, hades: hades ? { ...hades, name } : null,
      });
      panesByTab.set(String(p.tab_id), list);
    }
    const tabsByWorkspace = new Map<string, Dict[]>();
    for (const t of rows(snap.tabs)) {
      const list = tabsByWorkspace.get(String(t.workspace_id)) ?? [];
      list.push({ id: t.tab_id, label: t.label ?? null, number: t.number ?? null, focused: Boolean(t.focused), status: t.agent_status ?? null, panes: panesByTab.get(String(t.tab_id)) ?? [] });
      tabsByWorkspace.set(String(t.workspace_id), list);
    }
    out.tree = rows(snap.workspaces).map((w) => {
      const wt = w.worktree as Dict | undefined;
      return {
        id: w.workspace_id, label: w.label ?? null, number: w.number ?? null, focused: Boolean(w.focused), status: w.agent_status ?? null,
        worktree: wt ? { repo: wt.repo_name ?? null, path: wt.checkout_path ?? null, linked: Boolean(wt.is_linked_worktree) } : null,
        tabs: tabsByWorkspace.get(String(w.workspace_id)) ?? [],
      };
    });
    return out;
  }

  async function read(requested: string | undefined, paneArg: string | undefined, linesArg: string | undefined): Promise<Dict> {
    const session = await sessionOf(requested);
    const { id, info } = await paneOf(session, paneArg);
    const lines = linesOf(linesArg);
    let text = "";
    // painel recém-aberto só tem a tela visível
    for (const source of ["recent-unwrapped", "visible"]) {
      const r = await herdr.call(session, ["pane", "read", id, "--source", source, "--lines", String(lines)]);
      text = r.out.replace(ANSI, "").trimEnd();
      if (text) break;
    }
    const processInfo = ((await herdr.json(session, ["pane", "process-info", "--pane", id])) ?? {}).process_info as Dict | undefined;
    const procs = rows(processInfo?.foreground_processes).map((x) => ({ name: x.name ?? null, cmd: x.cmdline ?? null, pid: x.pid ?? null, cwd: x.cwd ?? null }));
    return { session, pane: id, text, procs, shellPid: processInfo?.shell_pid ?? null, agent: info.agent ?? null };
  }

  async function scrollback(requested: string | undefined, paneArg: string | undefined, linesArg: string | undefined): Promise<Dict> {
    const lines = scrollbackLinesOf(linesArg);
    const session = await sessionOf(requested);
    const { id, info } = await paneOf(session, paneArg);
    const r = await herdr.call(session, ["pane", "read", id, "--source", "recent", "--format", "ansi", "--lines", String(lines)], SCROLLBACK_TIMEOUT_MS);
    if (r.rc !== 0) throw new BadRequest("o herdr não leu o histórico do painel");
    return { session, pane: id, lines, ansi: r.out, scroll: info.scroll ?? null };
  }

  function record(session: string, what: string, target: string, remote: boolean, ok: boolean): void {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${localStamp()} acao=${what} alvo=${target} sessao=${session} origem=${remote ? "remoto" : "local"} ${ok ? "ok" : "erro"}\n`);
  }

  /** Sinal de uso que não é do dono: hora, ação e alvo, nunca o texto. Um aviso por alvo a cada 60 s. */
  async function notifyRemote(what: string, target: string): Promise<void> {
    const key = `${what}\0${target}`;
    if (nowS() - (notified.get(key) ?? 0) < REMOTE_NOTICE_GAP_S) return;
    notified.set(key, nowS());
    await exec(
      ["bash", join(env.dir, "notify.sh"), "send", "herdr", "warn", `ação remota: ${what} em ${target}`, "--obj", "herdr", "--state", `${what}:${target}`],
      { timeoutMs: NOTIFY_TIMEOUT_MS, env: { ...process.env, HADES_DATA: env.dir } },
    );
  }

  const fireNotice = (what: string, target: string): void => {
    notifyRemote(what, target).catch((error: unknown) => console.warn(`aviso remoto do herdr falhou: ${error instanceof Error ? error.message : String(error)}`));
  };

  function actionArgv(what: string, id: string, info: Dict, body: Dict): { argv: string[]; text: string | null } {
    if (what === "prompt") {
      const text = textOf(body.text);
      if (!info.agent) throw new BadRequest("este painel não tem agente: use texto ou teclas");
      // `--` não funciona no agent prompt (medido)
      return { argv: ["agent", "prompt", id, text.startsWith("-") ? ` ${text}` : text], text };
    }
    if (what === "text") return { argv: ["pane", "send-text", id, textOf(body.text)], text: textOf(body.text) };
    if (what === "keys") {
      const keys = body.keys;
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS || keys.some((k) => typeof k !== "string" || !Object.hasOwn(KEYS, k))) {
        throw new BadRequest("tecla inválida");
      }
      return { argv: ["pane", "send-keys", id, ...keys.map((k) => KEYS[k as string] as string)], text: null };
    }
    if (what === "rename") {
      if (!info.agent) throw new BadRequest("este painel não tem agente");
      const name = textOf(body.name).trim();
      if (name && !AGENT_LABEL.test(name)) throw new BadRequest("nome inválido (até 40 letras, números, espaço, ponto, hífen)");
      return { argv: name ? ["agent", "rename", id, name] : ["agent", "rename", id, "--clear"], text: null };
    }
    throw new BadRequest("ação inválida");
  }

  async function act(body: Dict, remote: boolean): Promise<Dict> {
    const what = textOf(body.action);
    const session = await sessionOf(textOf(body.session) || undefined);
    const { id, info } = await paneOf(session, body.pane);
    const { argv, text } = actionArgv(what, id, info, body);
    if (text !== null && !text.trim()) throw new BadRequest("texto vazio");
    if (text !== null && text.length > MAX_TEXT) throw new BadRequest(`texto grande demais (${MAX_TEXT} caracteres)`);
    const r = await herdr.call(session, argv, ACT_TIMEOUT_MS);
    record(session, what, id, remote, r.rc === 0);
    if (r.rc !== 0) throw new BadRequest(r.err || "o herdr recusou");
    if (remote) fireNotice(what, id);
    herdr.forget(`${session}\0snap`);
    return { ok: true };
  }

  async function sessionAct(body: Dict, remote: boolean): Promise<Dict> {
    const what = textOf(body.action);
    const name = textOf(body.name);
    if ((what !== "stop" && what !== "delete") || !SESSION_NAME.test(name)) throw new BadRequest("ação inválida");
    const s = (await sessions()).find((x) => x.name === name);
    if (!s) throw new BadRequest("sessão do herdr desconhecida");
    if (typedConfirmRequired(configValues(env)) && body.confirm !== name) throw new BadRequest("digite o nome da sessão para confirmar");
    if (what === "delete" && s.running) throw new BadRequest("pare a sessão antes de apagá-la");
    if (what === "stop" && !s.running) throw new BadRequest("a sessão já está parada");
    const working = s.running ? countStatus(rows((await herdr.snap(name))?.agents), "working") : 0;
    const r = await herdr.call(null, ["session", what, name], SESSION_ACT_TIMEOUT_MS);
    record(name, `sessao-${what}(working=${working})`, name, remote, r.rc === 0);
    if (r.rc !== 0) throw new BadRequest(r.err || "o herdr recusou");
    if (remote) fireNotice(`sessao-${what}`, name);
    herdr.forget();
    return { ok: true };
  }

  async function admin(body: Dict, remote: boolean): Promise<Dict> {
    const what = textOf(body.action);
    if (!(ADMIN_ACTIONS as readonly string[]).includes(what)) throw new BadRequest("ação inválida");
    const session = await sessionOf(textOf(body.session) || undefined);
    const snap = await herdr.snap(session);
    if (!snap) throw new BadRequest("servidor herdr desta sessão fora do ar");
    const plan = adminPlan(what as AdminAction, body, snap);
    if (plan.confirmName !== undefined && typedConfirmRequired(configValues(env)) && body.confirm !== plan.confirmName) throw new BadRequest("digite o nome para confirmar");
    const r = await herdr.call(session, plan.argv, plan.timeoutMs);
    const created = r.rc === 0 ? createdIdOf(r.out) : undefined;
    record(session, what, created ?? plan.target, remote, r.rc === 0);
    if (r.rc !== 0) throw new BadRequest(r.err || "o herdr recusou");
    if (remote) fireNotice(what, created ?? plan.target);
    herdr.forget();
    return { ok: true, ...(created ? { created } : {}) };
  }

  async function socketOf(session: string): Promise<string | undefined> {
    const found = (await sessions()).find((s) => s.name === session && s.running);
    return typeof found?.socket_path === "string" && found.socket_path ? found.socket_path : undefined;
  }

  async function input(body: Dict, remote: boolean): Promise<{ session: string; pane: string }> {
    const session = await sessionOf(textOf(body.session) || undefined);
    const { id } = await paneOf(session, body.pane);
    const params = inputParams(id, body);
    const path = await socketOf(session);
    if (!path) throw new BadRequest("servidor herdr desta sessão fora do ar");
    let refusal: string | undefined;
    try {
      await socket.request(path, "pane.send_input", params, ACT_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof HerdrSocketError)) throw error;
      refusal = error.message || "o herdr recusou";
    }
    record(session, "input", id, remote, refusal === undefined);
    if (refusal !== undefined) throw new BadRequest(refusal);
    if (remote) fireNotice("input", id);
    return { session, pane: id };
  }

  return { overview, read, scrollback, act, sessionAct, admin, input, socketOf };
}
