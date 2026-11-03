// Argos (reference/argos.md): tipos, códigos de erro e as regras puras do grafo dos agentes: id dos nós, permissão
// pendente a partir do diário, unidades e dependências do plan.md aprovado. Sem I/O fora de ler arquivo pequeno.
import { createHash } from "node:crypto";
import { type JournalEvent, parseEvent, readTailText } from "./journal.ts";

export const ARGOS_SCHEMA_VERSION = 1;
export const TAIL_BYTES = 64 * 1024;
const SUMMARY_MAX = 200;
const CODE_FENCE = /^```/;

/** Códigos de erro estáveis: só ganham valores, nunca renomeiam. A mensagem é para o dono; quem consome ramifica pelo código. */
export const ARGOS_ERRORS = {
  unknownAction: "unknown_action",
  unknownNode: "unknown_node",
  invalidNode: "invalid_node",
  invalidArgs: "invalid_args",
  invalidQuery: "invalid_query",
  confirmRequired: "confirm_required",
  actionNotForNode: "action_not_for_node",
  actionFailed: "action_failed",
  actionTimeout: "action_timeout",
  permissionNotPending: "permission_not_pending",
  permissionNotSupported: "permission_not_supported",
} as const;
export type ArgosErrorCode = (typeof ARGOS_ERRORS)[keyof typeof ARGOS_ERRORS];

export class ArgosError extends Error {
  readonly status: number;
  readonly code: ArgosErrorCode;
  constructor(status: number, code: ArgosErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type NodeType = "agent" | "unit" | "gate" | "pr";
export type EdgeKind = "stack" | "consolidation" | "depends_on" | "agent_pr" | "agent_gate" | "orchestrates";

export interface PendingPermission {
  ts: string;
  tool: string | null;
}

/** Id de nó sem barra (cabe no caminho da URL): `agent:<registro>:<nome>`, `unit:<registro>:<nome>`, `pr:<registro>:<n>`, `gate:<pid>`. */
export const nodeId = (type: NodeType, ...parts: (string | number)[]): string => `${type}:${parts.join(":")}`;

const AGENT_NAME = /^[\w.-]{1,80}$/;
const REGISTRY_SLUG = /^[\w.-]{1,160}$/;

export interface ParsedNodeId {
  type: NodeType;
  parts: string[];
}

/** O id vindo do cliente é estreitado aqui; qualquer coisa fora do formato é `invalid_node`. */
export function parseNodeId(raw: string): ParsedNodeId {
  const [type, ...parts] = raw.split(":");
  const shape: Record<string, number> = { agent: 2, unit: 2, pr: 2, gate: 1 };
  const expected = type === undefined ? undefined : shape[type];
  const ok = expected !== undefined && parts.length === expected && parts.every((p) => p !== "");
  if (!ok) throw new ArgosError(400, ARGOS_ERRORS.invalidNode, "id de nó inválido");
  const named = type === "agent" || type === "unit";
  if (named && !(REGISTRY_SLUG.test(parts[0] as string) && AGENT_NAME.test(parts[1] as string))) throw new ArgosError(400, ARGOS_ERRORS.invalidNode, "id de nó inválido");
  if (type === "pr" && !(REGISTRY_SLUG.test(parts[0] as string) && /^\d{1,9}$/.test(parts[1] as string))) throw new ArgosError(400, ARGOS_ERRORS.invalidNode, "id de nó inválido");
  if (type === "gate" && !/^\d{1,9}$/.test(parts[0] as string)) throw new ArgosError(400, ARGOS_ERRORS.invalidNode, "id de nó inválido");
  return { type: type as NodeType, parts };
}

/** Eventos de quem decide algo sobre o agente; `watch`, `gate` e `cerberus` chegam a qualquer hora e não respondem a permissão. */
const ACTIVITY_SOURCE = "guard";
const PASSIVE_KINDS = new Set(["notification"]);

/** Permissão pendente: o último evento de atividade do agente é o pedido, sem ferramenta, parada ou prompt depois dele. */
export function pendingPermission(events: readonly JournalEvent[]): PendingPermission | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as JournalEvent;
    if (event.source !== ACTIVITY_SOURCE || PASSIVE_KINDS.has(event.kind)) continue;
    return event.kind === "permission" ? { ts: event.ts, tool: event.tool ?? null } : null;
  }
  return null;
}

/** Eventos do fim de um ou dois arquivos do diário (a geração `.1` vem antes), já validados, em ordem de gravação. */
export function tailEvents(files: readonly string[], maxBytes: number = TAIL_BYTES): JournalEvent[] {
  const events: JournalEvent[] = [];
  for (const file of files) {
    for (const line of readTailText(file, maxBytes).split("\n")) {
      const event = line === "" ? undefined : parseEvent(line);
      if (event) events.push(event);
    }
  }
  return events;
}

// ------------------------------------------------------------------ plano aprovado

export interface PlanUnit {
  name: string;
  base: string;
  dependsOn: string[];
}

/** Mesmo hash do `plan-approve` (sem a seção "Estado atual"), para saber se o plano mudou depois da aprovação. */
export function planHash(planText: string): string {
  let inFence = false;
  let skip = false;
  const kept: string[] = [];
  const lines = planText.replaceAll("\r", "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (CODE_FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith("## ")) skip = /^## Estado atual([^A-Za-z0-9_]|$)/.test(line);
    if (!skip) kept.push(line);
  }
  return createHash("sha256").update(kept.map((l) => `${l}\n`).join("")).digest("hex");
}

const cells = (row: string): string[] => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const bare = (text: string): string => text.replaceAll("`", "").trim();
const EMPTY_CELL = /^(—|-|–|n\/a|nenhuma?)?$/i;

/** Tabela de "## Unidades" do plano: nome, base e "Depende de" (nomes entre crases ou separados por vírgula). */
export function parsePlanUnits(planText: string): PlanUnit[] {
  const lines = planText.split("\n");
  const start = lines.findIndex((l) => /^## Unidades\s*$/.test(l));
  if (start < 0) return [];
  const units: PlanUnit[] = [];
  let header: string[] | undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break;
    if (!line.trim().startsWith("|")) {
      if (header && units.length > 0) break;
      continue;
    }
    const row = cells(line);
    if (row.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!header) {
      header = row.map((c) => c.toLowerCase());
      continue;
    }
    const heads = header;
    const column = (pattern: RegExp): string => row[heads.findIndex((h) => pattern.test(h))] ?? "";
    const name = bare(column(/^unidade/));
    if (!AGENT_NAME.test(name)) continue;
    const deps = column(/^depende/).split(/[,;]/).map(bare).filter((d) => !EMPTY_CELL.test(d) && AGENT_NAME.test(d));
    units.push({ name, base: bare(column(/^base/)), dependsOn: deps });
  }
  return units;
}

// ------------------------------------------------------------------ resumo de arquivo

export interface FileSummary {
  path: string;
  bytes: number;
  /** primeira linha com conteúdo, sem `#` */
  head: string;
  /** só no questions.md: os títulos `## Qn` ainda sem resposta */
  openQuestions?: string[];
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function summarizeFile(path: string, text: string): FileSummary {
  const head = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return { path, bytes: Buffer.byteLength(text), head: clip(head.replace(/^#+\s*/, "").trim(), SUMMARY_MAX) };
}

/** Títulos `## Qn` sem "(respondida)" e sem `## Resposta do dono (Qn)` depois (a mesma regra do `hades agent status`). */
export function openQuestionHeads(text: string): string[] {
  const heads = [...text.matchAll(/^## (Q\d+.*)$/gm)].map((m) => m[1] as string);
  const answered = new Set([...text.matchAll(/^## Resposta do dono \((Q\d+)\)/gm)].map((m) => m[1] as string));
  return heads.filter((h) => !h.includes("(respondida)") && !answered.has(h.split(/\s+/)[0] as string)).map((h) => clip(h, SUMMARY_MAX));
}

const SAFE_PERMISSION_TOOLS = new Set(["Bash", "Edit", "Write", "NotebookEdit"]);

/** Só os diálogos em que Enter é a opção "Yes" simples: ferramentas de arquivo/shell e MCP. Plano, pergunta e o resto ficam fora. */
export const isSimplePermissionTool = (tool: string | null): boolean => tool !== null && (SAFE_PERMISSION_TOOLS.has(tool) || tool.startsWith("mcp__"));
