// Nó `cardinal` do canvas (reference/argos.md §Nó cardinal): o diagrama é um arquivo `.cardinal` (JSON do Cardinal) e o nó só
// aponta para ele. O Hades não interpreta o conteúdo: lê o envelope (`format`, `version`, `app`) para exibir e recusar versão
// futura, e o resto passa por um programa do Cardinal. Lógica pura, sem dependência de Node, como `canvas-note.ts`.
import { type CanvasDoc, type CanvasNode } from "./canvas-doc.ts";
import { type NoteWriter, requireWriterId } from "./canvas-note.ts";

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

/** O leitor é o agente ligado ao diagrama pelo `data` (como `NoteData.agent`; o agente do grafo não é nó do documento). A ligação por conexão entra na U8. */
export const isCardinalAgent = (doc: CanvasDoc, nodeId: string, readerId: string): boolean => findCardinalNode(doc, nodeId)?.data.agent === readerId;

/** Escreve no diagrama: o dono sempre; o agente só se tem acesso de escrita. Nó inexistente ou de outro tipo: `false`. */
export function canWriteCardinal(doc: CanvasDoc, nodeId: string, writer: NoteWriter): boolean {
  if (findCardinalNode(doc, nodeId) === undefined) return false;
  return writer.kind === "owner" || isCardinalAgent(doc, nodeId, writer.id);
}

/** Lê o diagrama: o dono sempre; o agente se tem acesso de leitura. */
export function canReadCardinal(doc: CanvasDoc, nodeId: string, readerId: string | undefined): boolean {
  if (findCardinalNode(doc, nodeId) === undefined) return false;
  return readerId === undefined || isCardinalAgent(doc, nodeId, readerId);
}
