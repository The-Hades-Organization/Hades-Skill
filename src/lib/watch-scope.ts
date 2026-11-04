// Quais agentes um `hades watch` acompanha e onde guarda o "já visto" (reference/loop/orchestrate.md §4): por padrão só os
// que o orquestrador do pane atual alocou; cada observador tem o seu estado, para um watch não consumir o evento do outro.
import { callerPane } from "./agent-registry.ts";
import { herdrRefOf, orchestratorOf, type HerdrRef } from "./argos-graph-ui.ts";

export interface WatchScope {
  /** true: sem filtro nenhum (`--all`, ou fora de pane e sem flag: o comportamento de antes). */
  all: boolean;
  /** só estes nomes (`--agent`/`--agents`); vazio = sem filtro por nome. */
  agents: string[];
  /** só os agentes deste orquestrador (`--orchestrator` ou o pane atual). */
  orchestrator?: HerdrRef;
}

export interface WatchArgs {
  next: boolean;
  everySeconds?: number;
  scope: WatchScope;
}

export class WatchUsageError extends Error {}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseOrchestrator(value: string): HerdrRef {
  const cut = value.indexOf(":");
  const ref = cut > 0 ? herdrRefOf(value.slice(cut + 1), value.slice(0, cut)) : null;
  if (!ref) throw new WatchUsageError(`--orchestrator ${value}: esperava <sessão>:<pane> (ex.: default:w1:p1)`);
  return ref;
}

function agentNames(value: string): string[] {
  const names = value.split(",").map((n) => n.trim()).filter((n) => n !== "");
  const bad = names.find((n) => !AGENT_NAME.test(n));
  if (names.length === 0 || bad !== undefined) throw new WatchUsageError(`nome de agente inválido: ${bad ?? value}`);
  return names;
}

/** Flags e o intervalo do `hades watch`; sem flag de escopo, o pane atual (se houver) vira o dono a seguir. */
export function parseWatchArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): WatchArgs {
  let next = false;
  let all = false;
  let everySeconds: number | undefined;
  let orchestrator: HerdrRef | undefined;
  const agents: string[] = [];
  const valueOf = (i: number, flag: string): string => {
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new WatchUsageError(`${flag} pede um valor`);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--next") next = true;
    else if (arg === "--all") all = true;
    else if (arg === "--agent" || arg === "--agents") agents.push(...agentNames(valueOf(i++, arg)));
    else if (arg === "--orchestrator") orchestrator = parseOrchestrator(valueOf(i++, arg));
    else if (arg.startsWith("--")) throw new WatchUsageError(`flag desconhecida: ${arg}`);
    else everySeconds = Number(arg);
  }
  if (all && (agents.length > 0 || orchestrator !== undefined)) throw new WatchUsageError("--all não combina com --agent/--agents/--orchestrator");
  if (all) return { next, everySeconds, scope: { all: true, agents: [] } };
  const unique = [...new Set(agents)].sort();
  const owner = orchestrator ?? (unique.length === 0 ? callerPane(env) : undefined);
  return { next, everySeconds, scope: { all: owner === undefined && unique.length === 0, agents: unique, ...(owner ? { orchestrator: owner } : {}) } };
}

/**
 * O agente entra no escopo? Registro sem `orchestrator` (antigo, ou alocado fora de pane) é visto por todos;
 * com `--agent`, o nome decide e o dono só entra se também foi pedido.
 */
export function inScope(scope: WatchScope, record: Record<string, unknown>): boolean {
  if (scope.all) return true;
  if (scope.agents.length > 0 && !scope.agents.includes(String(record.name ?? ""))) return false;
  if (scope.orchestrator === undefined) return true;
  const owner = orchestratorOf(record);
  return owner === undefined || (owner.session === scope.orchestrator.session && owner.pane === scope.orchestrator.pane);
}

/** Nome da pasta do "já visto" do observador; `undefined` = a pasta compartilhada de sempre (painel, `--all`, fora de pane). */
export function observerKey(scope: WatchScope): string | undefined {
  if (scope.all) return undefined;
  const parts: string[] = [];
  if (scope.orchestrator) parts.push(`o-${scope.orchestrator.session}-${scope.orchestrator.pane}`);
  if (scope.agents.length > 0) parts.push(`a-${scope.agents.join("+")}`);
  return parts.join("_").replace(/[^A-Za-z0-9._+-]/g, "_");
}
