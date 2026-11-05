// herdr (multiplexador de agentes): as mesmas leituras do hades agent (herdr_agent, pane_from, agent_active).
import { isObject, type Json, type JsonObject } from "./profile.ts";
import { run, which, type RunResult } from "./proc.ts";

export const HERDR_CALL_TIMEOUT_MS = 60_000;
/** Folga do processo sobre o `--timeout` do herdr agent wait: o herdr é quem devolve o veredito. */
const WAIT_GRACE_MS = 15_000;

export function herdr(args: string[], options: { cwd?: string; timeoutMs?: number; showStderr?: boolean } = {}): RunResult {
  const result = run("herdr", args, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? HERDR_CALL_TIMEOUT_MS });
  if (options.showStderr && result.stderr) process.stderr.write(result.stderr);
  return result;
}

export function herdrWait(name: string, until: string[], timeoutMs: number): RunResult {
  const flags = until.flatMap((state) => ["--until", state]);
  return herdr(["agent", "wait", name, ...flags, "--timeout", String(timeoutMs)], { timeoutMs: timeoutMs + WAIT_GRACE_MS });
}

/** Teto da sondagem do servidor: ele responde em milissegundos quando está no ar. */
const SERVER_PROBE_TIMEOUT_MS = 5000;

/**
 * Stderr do CLI quando o servidor não está no ar ("no herdr server is running at <socket>; run `herdr` to start or
 * attach it"), ou o socket sumiu/recusa a conexão.
 */
const SERVER_DOWN_PATTERN = /no herdr server is running|connection refused|(?:socket|\.sock)\b.*(?:no such file|not found|does not exist)/i;
export const herdrServerDown = (stderr: string): boolean => SERVER_DOWN_PATTERN.test(stderr);

/** O servidor do herdr responde no socket? (`api snapshot` é só leitura.) */
export function herdrServerResponds(): boolean {
  return herdr(["api", "snapshot"], { timeoutMs: SERVER_PROBE_TIMEOUT_MS }).status === 0;
}

function parse(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

/** Todos os objetos do documento, em pré-ordem (o `..` do jq). */
function* objects(value: Json | undefined): Generator<JsonObject> {
  if (Array.isArray(value)) for (const item of value) yield* objects(item);
  else if (isObject(value)) {
    yield value;
    for (const item of Object.values(value)) yield* objects(item);
  }
}

/** `[.. | objects | .pane_id? // empty][0] // empty` */
export function paneFrom(text: string): string {
  for (const object of objects(parse(text))) {
    const pane = object.pane_id;
    if (pane !== undefined && pane !== null && pane !== false) return String(pane);
  }
  return "";
}

/** `[.. | objects | select((.cwd? // "") == $w) | .pane_id][0] // empty` */
export function paneInCwd(text: string, cwd: string): string {
  for (const object of objects(parse(text))) {
    if (String(object.cwd ?? "") !== cwd) continue;
    const pane = object.pane_id;
    return pane === undefined || pane === null || pane === false ? "" : String(pane);
  }
  return "";
}

/** Agentes do `herdr agent list`; vazio se o herdr falta, falha ou devolve lixo. */
export function listAgents(): JsonObject[] {
  if (!which("herdr")) return [];
  const doc = parse(herdr(["agent", "list"]).stdout);
  const result = isObject(doc) ? doc.result : undefined;
  const agents = isObject(result) ? result.agents : undefined;
  return Array.isArray(agents) ? agents.filter(isObject) : [];
}

export function findAgent(name: string): JsonObject | undefined {
  return listAgents().find((agent) => agent.name === name);
}

/** Painéis do `herdr pane list`. */
export function listPanes(): JsonObject[] {
  if (!which("herdr")) return [];
  const doc = parse(herdr(["pane", "list"]).stdout);
  const result = isObject(doc) ? doc.result : undefined;
  const panes = isObject(result) ? result.panes : undefined;
  return Array.isArray(panes) ? panes.filter(isObject) : [];
}

/** Há agente working/idle com a sessão viva nessa worktree? */
export function agentActiveIn(worktree: string): boolean {
  return listAgents().some((agent) => {
    const cwd = String(agent.cwd ?? "");
    const inside = cwd === worktree || String(agent.foreground_cwd ?? "") === worktree || cwd.startsWith(`${worktree}/`);
    return inside && (agent.agent_status === "working" || agent.agent_status === "idle");
  });
}
