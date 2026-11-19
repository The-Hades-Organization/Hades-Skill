// Nó `cardinal` do canvas (reference/argos.md §Nó cardinal): o diagrama é um arquivo `.cardinal` (JSON do Cardinal) e o nó só
// aponta para ele. O Hades não interpreta o conteúdo: lê o envelope (`format`, `version`, `app`) para exibir e recusar versão
// futura, e o resto passa por um programa do Cardinal. Lógica pura, sem dependência de Node, como `canvas-note.ts`.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNode, LINK_EDGE_KIND, validateCanvasDoc } from "./canvas-doc.ts";
import { type AtomicOp, opCreate } from "./canvas-history.ts";
import { NOTE_READER_TYPES, type NoteWriter, requireWriterId } from "./canvas-note.ts";

export const CARDINAL_TYPE = "cardinal";
/** Valor do campo `format` do envelope. */
export const CARDINAL_FORMAT = "cardinal";
/** Versão mais nova do envelope que este painel aceita gravar (a de `cardinal --version`, campo `format`). */
export const CARDINAL_FORMAT_MAX = 2;

export const CARDINAL_LIMITS = {
  /** Nome do arquivo, sem a extensão. */
  nameChars: 64,
  /** Arquivo `.cardinal`, em bytes UTF-8. */
  bodyBytes: 4 * 1024 * 1024,
  /** Rótulo do nó. */
  titleChars: 80,
} as const;

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const CARDINAL_ERRORS = {
  invalidName: "cardinal_invalid_name",
  invalidData: "cardinal_invalid_data",
  invalidEnvelope: "cardinal_invalid_envelope",
  formatTooNew: "cardinal_format_too_new",
} as const;
export type CardinalErrorCode = (typeof CARDINAL_ERRORS)[keyof typeof CARDINAL_ERRORS];

export class CardinalError extends Error {
  readonly code: CardinalErrorCode;
  constructor(code: CardinalErrorCode, message: string) {
    super(message);
    this.name = "CardinalError";
    this.code = code;
  }
}

const fail = (code: CardinalErrorCode, message: string): never => {
  throw new CardinalError(code, message);
};

/** Lista fechada, a mesma das notas: sem ponto nem barra (então sem `..`); a extensão `.cardinal` é do servidor. */
const CARDINAL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NAME_PREFIX = "cardinal-";

export interface CardinalData {
  /** Nome do arquivo `.cardinal` (sem a extensão) na pasta da instância. */
  cardinal: string;
  /** Rótulo do nó; o título do diagrama pertence ao arquivo. */
  title?: string;
  /** Agente ligado ao diagrama (vínculo no `data`, como `NoteData.agent`). */
  agent?: string;
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

export const isCardinalName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= CARDINAL_LIMITS.nameChars && CARDINAL_NAME.test(value);

export const requireCardinalName = (value: unknown): string => (isCardinalName(value) ? value : fail(CARDINAL_ERRORS.invalidName, "nome de diagrama inválido"));

/** Nome de um arquivo adotado de fora: `cardinal-<token>` (token de letras minúsculas e números). */
export const adoptedNameOf = (token: string): string => `${NAME_PREFIX}${token}`;

/** `data` de um nó `cardinal`, vindo de fora: `cardinal` e, opcionais, `title` e `agent`. Devolve uma cópia. */
export function readCardinalData(raw: unknown): CardinalData {
  if (!isDict(raw)) return fail(CARDINAL_ERRORS.invalidData, "cardinal: data precisa ser objeto");
  for (const key of Object.keys(raw)) {
    if (!["cardinal", "title", "agent"].includes(key)) return fail(CARDINAL_ERRORS.invalidData, `cardinal: campo desconhecido "${key.slice(0, 40)}"`);
  }
  const data: CardinalData = { cardinal: requireCardinalName(raw.cardinal) };
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string" || raw.title.length === 0 || [...raw.title].length > CARDINAL_LIMITS.titleChars) return fail(CARDINAL_ERRORS.invalidData, "cardinal: title inválido");
    data.title = raw.title;
  }
  if (raw.agent !== undefined) {
    if (typeof raw.agent !== "string") return fail(CARDINAL_ERRORS.invalidData, "cardinal: agent inválido");
    try {
      data.agent = requireWriterId(raw.agent);
    } catch {
      return fail(CARDINAL_ERRORS.invalidData, "cardinal: agent inválido");
    }
  }
  return data;
}

export const isCardinalNode = (node: CanvasNode): boolean => node.type === CARDINAL_TYPE;

export interface CardinalEnvelope {
  format: string;
  version: number;
  app: string | null;
  /** Quantos modelos (diagramas) o projeto tem; 0 se o campo não está no formato esperado. */
  diagrams: number;
  /** `false` quando a versão do arquivo é mais nova que `CARDINAL_FORMAT_MAX`. */
  supported: boolean;
}

/**
 * Lê só o envelope do texto de um `.cardinal`. Erros: `cardinal_invalid_envelope` (não é JSON, não é objeto, `format` errado,
 * `version` que não é inteiro positivo). Versão futura não lança: volta com `supported: false` para a tela exibir e recusar.
 */
export function readEnvelope(text: string): CardinalEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(CARDINAL_ERRORS.invalidEnvelope, "o arquivo não é JSON");
  }
  if (!isDict(parsed) || parsed.format !== CARDINAL_FORMAT) return fail(CARDINAL_ERRORS.invalidEnvelope, "o arquivo não é um diagrama do Cardinal");
  if (typeof parsed.version !== "number" || !Number.isInteger(parsed.version) || parsed.version < 1) return fail(CARDINAL_ERRORS.invalidEnvelope, "versão do formato inválida");
  const models = isDict(parsed.project) && Array.isArray(parsed.project.models) ? parsed.project.models.length : 0;
  return {
    format: parsed.format,
    version: parsed.version,
    app: typeof parsed.app === "string" ? parsed.app.slice(0, 80) : null,
    diagrams: models,
    supported: parsed.version <= CARDINAL_FORMAT_MAX,
  };
}

/** Como `readEnvelope`, mas recusa versão futura (o que a gravação exige): `cardinal_format_too_new`. */
export function requireWritableEnvelope(text: string): CardinalEnvelope {
  const envelope = readEnvelope(text);
  return envelope.supported ? envelope : fail(CARDINAL_ERRORS.formatTooNew, `formato ${envelope.version} é mais novo que o ${CARDINAL_FORMAT_MAX} suportado`);
}

// ---- acesso (reference/argos.md §Ligações) ----

/** O nó `cardinal` com esse id e o `data` já lido; `undefined` se não existe, é de outro tipo ou tem `data` inválido. */
export function findCardinalNode(doc: CanvasDoc, nodeId: string): (Omit<CanvasNode, "data"> & { data: CardinalData }) | undefined {
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.type !== CARDINAL_TYPE) return undefined;
  try {
    return { ...node, data: readCardinalData(node.data) };
  } catch (error) {
    if (error instanceof CardinalError) return undefined;
    throw error;
  }
}

/** O arquivo a que o nó aponta; `undefined` se o nó não existe, não é `cardinal` ou tem `data` inválido. */
export const cardinalFileOf = (doc: CanvasDoc, nodeId: string): string | undefined => findCardinalNode(doc, nodeId)?.data.cardinal;

const nodeAt = (doc: CanvasDoc, id: string): CanvasNode | undefined => doc.nodes.find((node) => node.id === id);
/** A outra ponta de uma aresta `link` que toca `id`, ou `undefined`. */
const otherEnd = (edge: CanvasDoc["edges"][number], id: string): string | undefined =>
  edge.kind !== LINK_EDGE_KIND ? undefined : edge.from === id ? edge.to : edge.to === id ? edge.from : undefined;

/**
 * Os diagramas ligados direto ao leitor: os das conexões (`cardinal-access`), na ordem das arestas, e depois os que o ligam
 * pelo `data.agent` (vale mesmo sem o leitor ser nó do documento: o agente do grafo não é). Leitor presente que não é agente
 * nem terminal não tem nenhum.
 */
export function directCardinalsOf(doc: CanvasDoc, readerId: string): string[] {
  const reader = nodeAt(doc, readerId);
  if (reader && !NOTE_READER_TYPES.includes(reader.type)) return [];
  const out: string[] = [];
  for (const edge of reader ? doc.edges : []) {
    const other = otherEnd(edge, readerId);
    if (other !== undefined && nodeAt(doc, other)?.type === CARDINAL_TYPE && !out.includes(other)) out.push(other);
  }
  for (const node of doc.nodes) {
    if (node.type === CARDINAL_TYPE && isDict(node.data) && node.data.agent === readerId && !out.includes(node.id)) out.push(node.id);
  }
  return out;
}

/** A cadeia a partir do diagrama `nodeId` (ele primeiro), em largura pelas conexões cardinal↔cardinal; cada nó entra uma vez. */
export function cardinalChainFrom(doc: CanvasDoc, nodeId: string): { id: string; via: string | null }[] {
  if (nodeAt(doc, nodeId)?.type !== CARDINAL_TYPE) return [];
  const out: { id: string; via: string | null }[] = [{ id: nodeId, via: null }];
  const seen = new Set([nodeId]);
  for (let i = 0; i < out.length; i++) {
    const from = (out[i] as { id: string }).id;
    for (const edge of doc.edges) {
      const other = otherEnd(edge, from);
      if (other === undefined || seen.has(other) || nodeAt(doc, other)?.type !== CARDINAL_TYPE) continue;
      seen.add(other);
      out.push({ id: other, via: from });
    }
  }
  return out;
}

/** Tudo que o leitor alcança: os diagramas diretos e as cadeias deles, sem repetir (o direto vence o de cadeia). */
export function readableCardinalsOf(doc: CanvasDoc, readerId: string): { id: string; via: string | null }[] {
  const direct = directCardinalsOf(doc, readerId);
  const out = direct.map((id) => ({ id, via: null as string | null }));
  const seen = new Set(direct);
  for (const entry of direct) {
    for (const hop of cardinalChainFrom(doc, entry)) {
      if (seen.has(hop.id)) continue;
      seen.add(hop.id);
      out.push(hop);
    }
  }
  return out;
}

/** Escreve no diagrama: o dono sempre; o agente só se está ligado direto a ele (a cadeia só se lê). Nó inexistente ou de outro tipo: `false`. */
export function canWriteCardinal(doc: CanvasDoc, nodeId: string, writer: NoteWriter): boolean {
  if (findCardinalNode(doc, nodeId) === undefined) return false;
  return writer.kind === "owner" || directCardinalsOf(doc, writer.id).includes(nodeId);
}

/** Lê o diagrama: o dono sempre; o agente se o alcança, direto ou pela cadeia. */
export function canReadCardinal(doc: CanvasDoc, nodeId: string, readerId: string | undefined): boolean {
  if (findCardinalNode(doc, nodeId) === undefined) return false;
  return readerId === undefined || readableCardinalsOf(doc, readerId).some((entry) => entry.id === nodeId);
}

/** Tamanho do nó de um diagrama criado pela CLI. */
export const CARDINAL_FRAME = Object.freeze({ w: 420, h: 300 });

export interface CardinalNodeInput {
  id: string;
  /** Nome do arquivo `.cardinal` a que o nó aponta (sem a extensão). */
  name: string;
  title?: string;
  x: number;
  y: number;
  z?: number;
}

/** O nó `cardinal` novo conferido pelas regras do documento (id, caixa, limite de nós) e pelas do `data`. */
export function createCardinalNode(doc: CanvasDoc, input: CardinalNodeInput): { op: AtomicOp; node: CanvasNode } {
  const data = readCardinalData({ cardinal: input.name, ...(input.title !== undefined && { title: input.title }) });
  if (doc.nodes.length >= CANVAS_LIMITS.nodes) return fail(CARDINAL_ERRORS.invalidData, "limite de nós do documento atingido");
  if (doc.nodes.some((existing) => existing.id === input.id)) return fail(CARDINAL_ERRORS.invalidData, "já existe nó com esse id");
  const raw: CanvasNode = { id: input.id, type: CARDINAL_TYPE, x: input.x, y: input.y, ...CARDINAL_FRAME, z: input.z ?? 0, data: { ...data }, locked: false, blurred: false };
  const [node] = validateCanvasDoc({ v: doc.v, rev: 0, nodes: [raw], edges: [], groups: [] }).nodes;
  return { op: opCreate(doc, [node as CanvasNode]), node: node as CanvasNode };
}
