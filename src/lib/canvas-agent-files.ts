// Arquivos do agente no canvas (reference/argos.md §Terminal, conversa e arquivos do agente): nós de usuário e ligações para
// o brief, o report, as questions e o handoff de um agente. Funções puras sobre o documento que devolvem uma `CanvasOp` da
// pilha de desfazer (`undefined` quando não há o que mudar). Sem Node e sem DOM; o nó é do usuário (`type` próprio, `data`
// livre), então o documento não muda de formato.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasEdge, type CanvasNode } from "./canvas-doc.ts";
import { type CanvasOp, opCreate } from "./canvas-history.ts";
import type { AgentNodeFiles } from "../panel/argos-graph.ts";
import { deleteNodes, type IdSource } from "./canvas-clipboard.ts";

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const AGENT_FILES_ERRORS = {
  unknownAgent: "agent_files_unknown_agent",
  notAgent: "agent_files_not_agent",
  invalidFile: "agent_files_invalid_file",
  invalidId: "agent_files_invalid_id",
  duplicateId: "agent_files_duplicate_id",
  limitExceeded: "agent_files_limit_exceeded",
  invalidNumber: "agent_files_invalid_number",
} as const;
export type AgentFilesErrorCode = (typeof AGENT_FILES_ERRORS)[keyof typeof AGENT_FILES_ERRORS];

export class AgentFilesError extends Error {
  readonly code: AgentFilesErrorCode;
  constructor(code: AgentFilesErrorCode, message: string) {
    super(message);
    this.name = "AgentFilesError";
    this.code = code;
  }
}

const fail = (code: AgentFilesErrorCode, message: string): never => {
  throw new AgentFilesError(code, message);
};

/** Papel de cada arquivo, na ordem em que os nós aparecem empilhados. */
export const AGENT_FILE_ROLES = ["brief", "report", "questions", "handoff"] as const;
export type AgentFileRole = (typeof AGENT_FILE_ROLES)[number];

/** Entrada com o papel dito; o campo `files` do nó do agente (`AgentNodeFiles`, só caminhos) também vale: o papel sai do nome do arquivo. */
export interface AgentFileEntry {
  path: string;
  role: AgentFileRole;
}

export interface AgentFilesInput {
  /** Id do nó do agente no documento (`agent:<...>`). */
  agentId: string;
  files: AgentNodeFiles | readonly AgentFileEntry[];
}

/** Tipo do nó de usuário criado e ligação que o une ao agente. */
export const AGENT_FILE_NODE_TYPE = "agent-file";
export const AGENT_FILE_EDGE_KIND = "agent-file";

export const AGENT_FILE_LIMITS = {
  /** Arquivos por agente (o documento tem teto de nós; um agente não pode consumi-lo). */
  files: 20,
  pathChars: 500,
} as const;

/** Tamanho do nó e vãos do empilhamento à direita do agente, em unidades do canvas (múltiplos da grade de 20). */
export const AGENT_FILE_LAYOUT = { w: 240, h: 60, gapX: 40, gapY: 20 } as const;

const ID_PATTERN = /^[\w.:-]+$/;
// eslint-disable-next-line no-control-regex -- NUL e demais controles não entram em caminho
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Caminho aceito: relativo, com `/`, sem segmento `..` nem `.`, sem controle, até `pathChars`. Devolve o caminho
 * normalizado (sem `./` à frente nem `/` repetida), ou `undefined` se não serve. O nó só guarda o caminho; quem o abre
 * confere de novo contra a worktree no servidor.
 */
export function normalizeAgentFilePath(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length === 0 || path.length > AGENT_FILE_LIMITS.pathChars) return undefined;
  if (CONTROL_CHARS.test(path) || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return undefined;
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return undefined;
  return segments.join("/");
}

const isRole = (value: unknown): value is AgentFileRole => typeof value === "string" && (AGENT_FILE_ROLES as readonly string[]).includes(value);

/** Papel de um caminho do campo `files` do grafo: o nome do arquivo sem `.md` (brief, report, questions, handoff). */
function roleOfPath(path: string): string {
  const name = baseName(path);
  return name.endsWith(".md") ? name.slice(0, -3) : "";
}

export interface CheckedFiles {
  files: AgentFileEntry[];
  /** Caminhos repetidos na entrada (o primeiro vale). */
  duplicates: string[];
}

/** Valida a lista de entrada na fronteira: forma, papel, caminho e teto. Falha com `agent_files_invalid_file` ou `agent_files_limit_exceeded`. */
export function checkAgentFiles(raw: unknown): CheckedFiles {
  if (!Array.isArray(raw)) return fail(AGENT_FILES_ERRORS.invalidFile, "files precisa ser uma lista");
  if (raw.length > AGENT_FILE_LIMITS.files) return fail(AGENT_FILES_ERRORS.limitExceeded, `no máximo ${AGENT_FILE_LIMITS.files} arquivos por agente`);
  const seen = new Set<string>();
  const files: AgentFileEntry[] = [];
  const duplicates: string[] = [];
  for (const entry of raw) {
    const item = typeof entry === "string" ? { path: entry, role: roleOfPath(entry) } : entry;
    if (!isDict(item) || !isRole(item.role)) return fail(AGENT_FILES_ERRORS.invalidFile, "cada arquivo precisa de path e de um papel conhecido");
    const path = normalizeAgentFilePath(item.path);
    if (path === undefined) return fail(AGENT_FILES_ERRORS.invalidFile, "caminho inválido (relativo, sem .., sem controle)");
    if (seen.has(path)) {
      duplicates.push(path);
      continue;
    }
    seen.add(path);
    files.push({ path, role: item.role });
  }
  return { files, duplicates };
}

/** Nós de arquivo já criados para o agente (por `data.agent`), na ordem do documento. */
export function agentFileNodes(doc: CanvasDoc, agentId: string): CanvasNode[] {
  return doc.nodes.filter((node) => node.type === AGENT_FILE_NODE_TYPE && node.data.agent === agentId);
}

const roleRank = (role: unknown): number => {
  const rank = (AGENT_FILE_ROLES as readonly unknown[]).indexOf(role);
  return rank < 0 ? AGENT_FILE_ROLES.length : rank;
};

export interface AgentFilesResult {
  /** `undefined` quando não há nada a criar. */
  op: CanvasOp | undefined;
  /** Ids dos nós criados, na ordem de papel (brief, report, questions, handoff) e depois na da entrada. */
  nodeIds: string[];
  edgeIds: string[];
  /** Caminhos que já tinham nó e por isso ficaram como estavam. */
  existing: string[];
  /** Caminhos repetidos na entrada. */
  duplicates: string[];
}

function freshId(newId: IdSource, kind: "node" | "edge", used: Set<string>): string {
  const id = newId(kind);
  if (typeof id !== "string" || id.length === 0 || id.length > CANVAS_LIMITS.idChars || !ID_PATTERN.test(id)) return fail(AGENT_FILES_ERRORS.invalidId, "id novo inválido");
  const scoped = `${kind}:${id}`;
  if (used.has(scoped)) return fail(AGENT_FILES_ERRORS.duplicateId, "id novo já existe no documento");
  used.add(scoped);
  return id;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * Cria um nó por arquivo e uma ligação do agente a ele, empilhados à direita do agente (o novo começa abaixo do último
 * nó de arquivo que o agente já tem). Idempotente: o caminho que já tem nó não é recriado, nem a ligação que o usuário tenha
 * apagado (a pilha de desfazer não sabe desfazer ligação criada sozinha). Um passo só no desfazer. O nó leva `data: { path, role, agent, label }`.
 * Erros: `agent_files_unknown_agent` (id fora do documento), `agent_files_not_agent` (o nó não é do tipo agent),
 * `agent_files_invalid_file`, `agent_files_limit_exceeded` (arquivos do agente, nós, ligações), `agent_files_invalid_id`,
 * `agent_files_duplicate_id`, `agent_files_invalid_number` (coordenada fora do documento).
 */
export function addAgentFiles(doc: CanvasDoc, input: AgentFilesInput, newId: IdSource): AgentFilesResult {
  const agent = doc.nodes.find((node) => node.id === input.agentId);
  if (!agent) return fail(AGENT_FILES_ERRORS.unknownAgent, "o agente não está no documento");
  if (agent.type !== "agent") return fail(AGENT_FILES_ERRORS.notAgent, "o nó não é um agente");
  const { files, duplicates } = checkAgentFiles(input.files);

  const present = agentFileNodes(doc, input.agentId);
  const byPath = new Map(present.map((node) => [node.data.path, node]));
  const existing: string[] = [];
  const fresh: AgentFileEntry[] = [];
  for (const file of files) {
    if (byPath.has(file.path)) existing.push(file.path);
    else fresh.push(file);
  }
  fresh.sort((a, b) => roleRank(a.role) - roleRank(b.role));
  if (fresh.length === 0) return { op: undefined, nodeIds: [], edgeIds: [], existing, duplicates };
  if (
    present.length + fresh.length > AGENT_FILE_LIMITS.files ||
    doc.nodes.length + fresh.length > CANVAS_LIMITS.nodes ||
    doc.edges.length + fresh.length > CANVAS_LIMITS.edges
  ) {
    return fail(AGENT_FILES_ERRORS.limitExceeded, "documento ou agente passaria do limite");
  }

  const used = new Set<string>([...doc.nodes.map((node) => `node:${node.id}`), ...doc.edges.map((edge) => `edge:${edge.id}`)]);
  const { w, h, gapX, gapY } = AGENT_FILE_LAYOUT;
  const x = agent.x + agent.w + gapX;
  const stackTop = present.length === 0 ? agent.y : Math.max(...present.map((node) => node.y + node.h)) + gapY;
  const nodes = fresh.map((file, i): CanvasNode => {
    const y = stackTop + i * (h + gapY);
    if (Math.abs(x) > CANVAS_LIMITS.coordinate || Math.abs(y) > CANVAS_LIMITS.coordinate) return fail(AGENT_FILES_ERRORS.invalidNumber, "o nó sairia do limite de coordenadas");
    return {
      id: freshId(newId, "node", used),
      type: AGENT_FILE_NODE_TYPE,
      x,
      y,
      w,
      h,
      z: agent.z,
      data: { path: file.path, role: file.role, agent: input.agentId, label: baseName(file.path) },
      locked: false,
      blurred: false,
    };
  });
  const edges = nodes.map((node): CanvasEdge => ({ id: freshId(newId, "edge", used), from: input.agentId, to: node.id, kind: AGENT_FILE_EDGE_KIND }));
  const op = opCreate(doc, nodes, edges);
  return { op, nodeIds: nodes.map((node) => node.id), edgeIds: edges.map((edge) => edge.id), existing, duplicates };
}

export interface RemoveAgentFilesResult {
  /** `undefined` quando o agente não tem nó de arquivo. */
  op: CanvasOp | undefined;
  nodeIds: string[];
}

/**
 * Remove os nós de arquivo de um agente com as ligações que os tocam; o grupo que ficar com menos de dois membros se
 * desfaz no mesmo passo (`deleteNodes`). Um passo só no desfazer; o agente em si não é tocado.
 */
export function removeAgentFiles(doc: CanvasDoc, agentId: string): RemoveAgentFilesResult {
  const ids = agentFileNodes(doc, agentId).map((node) => node.id);
  if (ids.length === 0) return { op: undefined, nodeIds: [] };
  return { op: deleteNodes(doc, ids).op, nodeIds: ids };
}
