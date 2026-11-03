// `hades journal`: lê o diário de eventos por agente (src/lib/journal.ts, reference/journal.md). Só leitura.
import { AGENT_NAME, SESSIONS_DIR, listJournals, parseSince, readEvents, type JournalEvent } from "../lib/journal.ts";
import { EXIT, die, out } from "../lib/output.ts";

const TAIL_DEFAULT = 20;
const SHOW_DEFAULT = 200;
export const LIMIT_MAX = 1000;

export const USAGE = `Diário de eventos por agente (reference/journal.md).
Uso: hades journal list [--json]
     hades journal tail <agente> [--since <dur|iso>] [--kind <k>] [--limit <n>] [--json]
     hades journal show <agente> [--since <dur|iso>] [--kind <k>] [--limit <n>] [--json]
  list    um item por agente: eventos, bytes e o instante do último
  tail    os últimos eventos (padrão ${TAIL_DEFAULT})
  show    os eventos do período, até o teto (padrão ${SHOW_DEFAULT}, máximo ${LIMIT_MAX})
  --since 30m | 2h | 1d | 2026-01-01T00:00:00Z   --kind tool | permission | gate | watch | cerberus | stop | prompt
  Sessão sem agente registrado: <agente> = ${SESSIONS_DIR}/<session_id>.`;

interface Options {
  since?: string;
  kind?: string;
  limit?: string;
  json: boolean;
}

function parseOptions(args: string[]): { positional: string[]; options: Options } {
  const options: Options = { json: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--json") options.json = true;
    else if (arg === "--since" || arg === "--kind" || arg === "--limit") {
      const value = args[i + 1];
      if (value === undefined) die(`${arg} exige um valor`);
      options[arg.slice(2) as "since" | "kind" | "limit"] = value;
      i += 1;
    } else if (arg.startsWith("--")) die(`opção desconhecida: ${arg}\n${USAGE}`);
    else positional.push(arg);
  }
  return { positional, options };
}

function limitOf(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!(n >= 1 && n <= LIMIT_MAX)) die(`--limit é de 1 a ${LIMIT_MAX}: ${text}`);
  return n;
}

const line = (e: JournalEvent): string => `${e.ts} ${e.source.padEnd(7)} ${e.kind.padEnd(13)}${e.tool ? ` ${e.tool}` : ""} ${e.summary}`;

function events(verb: string, positional: string[], options: Options): number {
  const agent = positional[0];
  if (agent === undefined || positional.length > 1) die(`hades journal ${verb} <agente>\n${USAGE}`);
  const name = agent.startsWith(`${SESSIONS_DIR}/`) ? agent.slice(SESSIONS_DIR.length + 1) : agent;
  if (!AGENT_NAME.test(name)) die(`nome de agente inválido: ${agent}`);
  let sinceMs: number | undefined;
  if (options.since !== undefined) {
    sinceMs = parseSince(options.since, new Date());
    if (sinceMs === undefined) die(`--since não entendido: ${options.since} (30m, 2h, 1d ou um instante ISO com Z)`);
  }
  const found = readEvents({ agent, sinceMs, kind: options.kind, limit: limitOf(options.limit, verb === "tail" ? TAIL_DEFAULT : SHOW_DEFAULT) });
  if (options.json) for (const e of found) out(JSON.stringify(e));
  else for (const e of found) out(line(e));
  return EXIT.ok;
}

export function journalCommand(args: string[]): number {
  const [verb, ...rest] = args;
  const { positional, options } = parseOptions(rest);
  switch (verb) {
    case "list": {
      const items = listJournals();
      if (options.json) out(JSON.stringify(items));
      else for (const i of items) out(`${i.agent}\t${i.project}\t${i.events} eventos\t${i.bytes} bytes\t${i.last || "-"}`);
      return EXIT.ok;
    }
    case "tail":
    case "show":
      return events(verb, positional, options);
    default:
      process.stderr.write(`${USAGE}\n`);
      return verb === undefined || verb === "-h" || verb === "--help" ? EXIT.ok : EXIT.usage;
  }
}
