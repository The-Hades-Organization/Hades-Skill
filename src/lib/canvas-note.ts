// Nós de anotação do canvas (reference/argos.md §Notas e texto livre): `note` (nota em Markdown guardada num arquivo, o nó só
// aponta para ele) e `text` (rótulo ou título, o texto vive no próprio `data`). Lógica pura e sem dependência de Node: o
// mesmo módulo roda no servidor (rota de notas) e no navegador. Os nós são nós do usuário do documento (`type` próprio e
// `data` livre): nada aqui muda o formato do documento; as mudanças saem como `AtomicOp` da pilha de desfazer.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNode, LINK_EDGE_KIND, validateCanvasDoc } from "./canvas-doc.ts";
import { type AtomicOp, opCreate, opDelete, opUpdate } from "./canvas-history.ts";

export const NOTE_TYPE = "note";
export const TEXT_TYPE = "text";

export const NOTE_LIMITS = {
  /** Nome do arquivo da nota, sem a extensão. */
  nameChars: 64,
  /** Corpo da nota (Markdown), em bytes UTF-8. */
  bodyBytes: 262_144,
  /** Texto livre, em caracteres. */
  textChars: 2000,
  /** Título derivado do texto livre. */
  titleChars: 80,
  /** Letras e números minúsculos do pedaço aleatório de um nome novo. */
  tokenMin: 6,
  tokenMax: 32,
} as const;

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const NOTE_ERRORS = {
  invalidName: "note_invalid_name",
  invalidData: "note_invalid_data",
  invalidAgent: "note_invalid_agent",
  invalidNode: "note_invalid_node",
  tokenInvalid: "note_invalid_token",
  tooLarge: "note_too_large",
  duplicateId: "note_duplicate_id",
  limitExceeded: "note_limit_exceeded",
  invalidTitle: "note_invalid_title",
  invalidImage: "note_invalid_image",
} as const;
export type NoteErrorCode = (typeof NOTE_ERRORS)[keyof typeof NOTE_ERRORS];

export class NoteError extends Error {
  readonly code: NoteErrorCode;
  constructor(code: NoteErrorCode, message: string) {
    super(message);
    this.name = "NoteError";
    this.code = code;
  }
}

const fail = (code: NoteErrorCode, message: string): never => {
  throw new NoteError(code, message);
};

/** Lista fechada: começa por letra ou número, sem ponto nem barra (então sem `..` e sem separador); a extensão `.md` é do servidor. */
const NOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** O agente ligado é um nó vivo do grafo: `agent:<registro>:<nome>` (o mesmo id do documento). */
const AGENT_ID = /^agent:[\w.:-]+$/;
/** Formato dos ids do documento (o mesmo de `canvas-doc`). */
const TOKEN = /^[a-z0-9]+$/;
const NAME_PREFIX = "nota-";

export const TEXT_STYLES = ["title", "label"] as const;
export type TextStyle = (typeof TEXT_STYLES)[number];

export interface NoteData {
  /** Nome do arquivo `.md` (sem a extensão) na pasta de notas da instância. */
  note: string;
  /** Agente ligado à nota: pode escrever nela além do dono. Ausente = só o dono. */
  agent?: string;
}

export interface TextData {
  text: string;
  style: TextStyle;
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

function onlyKeys(value: Dict, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(NOTE_ERRORS.invalidData, `${what}: campo desconhecido "${key.slice(0, 40)}"`);
}

export const isNoteName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= NOTE_LIMITS.nameChars && NOTE_NAME.test(value);

export function requireNoteName(value: unknown): string {
  return isNoteName(value) ? value : fail(NOTE_ERRORS.invalidName, "nome de nota inválido");
}

export function requireAgentId(value: unknown): string {
  if (typeof value !== "string" || value.length > CANVAS_LIMITS.idChars || !AGENT_ID.test(value)) return fail(NOTE_ERRORS.invalidAgent, "agente da nota inválido");
  return value;
}

/** Id de nó criado no próprio canvas (terminal, nota): sem `:`, que é a marca dos nós do grafo (`<tipo>:…`). */
const LOCAL_NODE_ID = /^[\w.-]+$/;

/**
 * Quem escreve como agente: o id do nó do agente (`agent:…`) ou do terminal criado no canvas (id local do documento).
 * Outro nó do grafo (`pr:…`, `gate:…`) não lê nota: é identidade malformada.
 */
export function requireWriterId(value: unknown): string {
  if (typeof value === "string" && value.startsWith("agent:")) return requireAgentId(value);
  if (typeof value !== "string" || value.length === 0 || value.length > CANVAS_LIMITS.idChars || !LOCAL_NODE_ID.test(value)) {
    return fail(NOTE_ERRORS.invalidAgent, "quem escreve na nota é inválido");
  }
  return value;
}

/** `data` de um nó `note`, vindo de fora: só `note` e (opcional) `agent`. Devolve uma cópia. */
export function readNoteData(raw: unknown): NoteData {
  if (!isDict(raw)) return fail(NOTE_ERRORS.invalidData, "nota: data precisa ser objeto");
  onlyKeys(raw, ["note", "agent"], "nota");
  const data: NoteData = { note: requireNoteName(raw.note) };
  if (raw.agent !== undefined) data.agent = requireAgentId(raw.agent);
  return data;
}

/** `data` de um nó `text`: texto de 1 a `textChars` caracteres (não só espaço) e o estilo de uma lista fechada. */
export function readTextData(raw: unknown): TextData {
  if (!isDict(raw)) return fail(NOTE_ERRORS.invalidData, "texto: data precisa ser objeto");
  onlyKeys(raw, ["text", "style"], "texto");
  if (typeof raw.text !== "string" || raw.text.trim().length === 0) return fail(NOTE_ERRORS.invalidData, "texto: não pode ser vazio");
  if (raw.text.length > NOTE_LIMITS.textChars) return fail(NOTE_ERRORS.tooLarge, "texto acima do limite de caracteres");
  const style = TEXT_STYLES.find((candidate) => candidate === raw.style);
  if (style === undefined) return fail(NOTE_ERRORS.invalidData, "texto: style inválido");
  return { text: raw.text, style };
}

export const isNoteNode = (node: CanvasNode): boolean => node.type === NOTE_TYPE;
export const isTextNode = (node: CanvasNode): boolean => node.type === TEXT_TYPE;

/** Confere o `data` de um nó que o documento já aceitou; nó de outro tipo passa sem mudança. Devolve o próprio nó. */
export function checkAnnotationNode(node: CanvasNode): CanvasNode {
  if (node.type === NOTE_TYPE) readNoteData(node.data);
  else if (node.type === TEXT_TYPE) readTextData(node.data);
  return node;
}

/** Valida as anotações de um documento inteiro (o que o servidor ou a importação conferem). Lança no primeiro nó inválido. */
export function checkAnnotations(doc: CanvasDoc): void {
  for (const node of doc.nodes) checkAnnotationNode(node);
}

// ---- texto livre: título e área ----

/** Título curto do texto livre (primeira linha com conteúdo, aparada e cortada com reticências); `""` se não há texto. */
export function textTitle(data: TextData, maxChars: number = NOTE_LIMITS.titleChars): string {
  const line = data.text.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  const chars = [...line];
  return chars.length <= maxChars ? line : `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

/** Medidas em unidades do canvas por estilo: largura média de um caractere, altura da linha e respiro. */
const TEXT_METRICS: Record<TextStyle, { charW: number; lineH: number; pad: number; minW: number; maxW: number }> = {
  title: { charW: 16, lineH: 36, pad: 8, minW: 80, maxW: 640 },
  label: { charW: 8, lineH: 20, pad: 6, minW: 40, maxW: 400 },
};

/**
 * Área que o texto livre ocupa: largura pelo trecho mais comprido (entre o mínimo e o máximo do estilo) e altura pelas linhas
 * já quebradas nessa largura. Estimativa de caixa para o nó nascer do tamanho certo; quem desenha mede de verdade.
 */
export function textFrame(data: TextData): { w: number; h: number } {
  const m = TEXT_METRICS[data.style];
  const lines = data.text.split("\n");
  const longest = lines.reduce((max, line) => Math.max(max, [...line].length), 0);
  const w = Math.min(m.maxW, Math.max(m.minW, longest * m.charW + 2 * m.pad));
  const perLine = Math.max(1, Math.floor((w - 2 * m.pad) / m.charW));
  const rows = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].length / perLine)), 0);
  return { w, h: rows * m.lineH + 2 * m.pad };
}

// ---- quem pode escrever ----

export type NoteWriter = { kind: "owner" } | { kind: "agent"; id: string };

export const OWNER: NoteWriter = { kind: "owner" };

export type NoteNode = Omit<CanvasNode, "data"> & { data: NoteData };

/** O nó `note` com esse id, ou `undefined` (id de outro tipo de nó também é `undefined`). */
export function findNoteNode(doc: CanvasDoc, nodeId: string): NoteNode | undefined {
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.type !== NOTE_TYPE) return undefined;
  const data = readNoteData(node.data);
  return { ...node, data };
}

// ---- acesso pela conexão (reference/argos.md §Conexões, D5) ----

/**
 * Tipos de nó que leem nota pela conexão: o agente do grafo e o terminal criado no canvas (as pontas "terminal" de
 * `canvas-links`; o teste confere que as duas listas andam juntas).
 */
export const NOTE_READER_TYPES: readonly string[] = ["agent", "terminal"];

const nodeAt = (doc: CanvasDoc, id: string): CanvasNode | undefined => doc.nodes.find((node) => node.id === id);
/** A outra ponta de uma aresta `link` que toca `id`, ou `undefined`. */
const otherEnd = (edge: CanvasDoc["edges"][number], id: string): string | undefined =>
  edge.kind !== LINK_EDGE_KIND ? undefined : edge.from === id ? edge.to : edge.to === id ? edge.from : undefined;

/**
 * As notas ligadas direto ao nó leitor: as das conexões (`note-access`), na ordem das arestas, e depois as que o ligam pelo
 * vínculo antigo do `data` da nota (`agent`), o mesmo que a escrita aceita. Leitor de outro tipo não tem nenhuma.
 */
export function directNotesOf(doc: CanvasDoc, readerId: string): string[] {
  const reader = nodeAt(doc, readerId);
  if (!reader || !NOTE_READER_TYPES.includes(reader.type)) return [];
  const out: string[] = [];
  for (const edge of doc.edges) {
    const other = otherEnd(edge, readerId);
    if (other !== undefined && nodeAt(doc, other)?.type === NOTE_TYPE && !out.includes(other)) out.push(other);
  }
  for (const node of doc.nodes) {
    if (node.type === NOTE_TYPE && isDict(node.data) && node.data.agent === readerId && !out.includes(node.id)) out.push(node.id);
  }
  return out;
}

/**
 * A cadeia a partir da nota `noteId` (ela primeiro), em largura pelas conexões nota↔nota; cada nota entra uma vez, então
 * um laço na cadeia não prende a leitura. `via` é a nota de onde se chegou (`null` na de entrada).
 */
export function noteChainFrom(doc: CanvasDoc, noteId: string): { id: string; via: string | null }[] {
  if (nodeAt(doc, noteId)?.type !== NOTE_TYPE) return [];
  const out: { id: string; via: string | null }[] = [{ id: noteId, via: null }];
  const seen = new Set([noteId]);
  for (let i = 0; i < out.length; i++) {
    const from = (out[i] as { id: string }).id;
    for (const edge of doc.edges) {
      const other = otherEnd(edge, from);
      if (other === undefined || seen.has(other) || nodeAt(doc, other)?.type !== NOTE_TYPE) continue;
      seen.add(other);
      out.push({ id: other, via: from });
    }
  }
  return out;
}

/** Tudo que o leitor alcança: as notas diretas e as cadeias delas, sem repetir (a direta vence a de cadeia). */
export function readableNotesOf(doc: CanvasDoc, readerId: string): { id: string; via: string | null }[] {
  const direct = directNotesOf(doc, readerId);
  const out = direct.map((id) => ({ id, via: null as string | null }));
  const seen = new Set(direct);
  for (const entry of direct) {
    for (const hop of noteChainFrom(doc, entry)) {
      if (seen.has(hop.id)) continue;
      seen.add(hop.id);
      out.push(hop);
    }
  }
  return out;
}

/** O leitor está ligado direto à nota: lê e escreve nela (a cadeia só se lê). */
export const hasNoteAccess = (doc: CanvasDoc, noteId: string, readerId: string): boolean => directNotesOf(doc, readerId).includes(noteId);

/**
 * Quem escreve na nota do nó `nodeId`: o dono sempre; o agente se ele é o ligado àquela nota no `data` do documento ou se
 * uma conexão o liga direto à nota. Nó que não existe, que não é nota ou de dado inválido responde `false` (sem lançar):
 * na dúvida, ninguém além do dono.
 */
export function canWriteNote(doc: CanvasDoc, nodeId: string, writer: NoteWriter): boolean {
  if (writer.kind === "owner") return true;
  try {
    const note = findNoteNode(doc, nodeId);
    return note !== undefined && (note.data.agent === writer.id || hasNoteAccess(doc, nodeId, writer.id));
  } catch (error) {
    if (error instanceof NoteError) return false;
    throw error;
  }
}

/** O arquivo a que o nó `note` aponta; `undefined` se o nó não existe, não é nota ou tem `data` inválido. */
export function noteFileOf(doc: CanvasDoc, nodeId: string): string | undefined {
  try {
    return findNoteNode(doc, nodeId)?.data.note;
  } catch (error) {
    if (error instanceof NoteError) return undefined;
    throw error;
  }
}

/** Todas as notas do documento ligadas a esse agente (ordem do documento). */
export function notesOfAgent(doc: CanvasDoc, agentId: string): string[] {
  return doc.nodes.flatMap((node) => {
    if (node.type !== NOTE_TYPE) return [];
    try {
      return readNoteData(node.data).agent === agentId ? [node.id] : [];
    } catch (error) {
      if (error instanceof NoteError) return [];
      throw error;
    }
  });
}

// ---- criar nós (operações da pilha de desfazer) ----

const NOTE_FRAME = { w: 280, h: 200 } as const;

export interface NewNodeBase {
  /** Escolhido por quem cria (o documento exige id único e no formato dos ids). */
  id: string;
  x: number;
  y: number;
  z?: number;
}

/** Id de nome de arquivo novo: `nota-<token>`; o `token` (minúsculas e números, 6 a 32) vem de fora, para o teste ser determinístico. */
export function freshNoteName(doc: CanvasDoc, token: () => string): string {
  const used = new Set(doc.nodes.flatMap((node) => (node.type === NOTE_TYPE && isDict(node.data) && typeof node.data.note === "string" ? [node.data.note] : [])));
  for (let attempt = 0; attempt < 8; attempt++) {
    const value = token();
    if (value.length < NOTE_LIMITS.tokenMin || value.length > NOTE_LIMITS.tokenMax || !TOKEN.test(value)) return fail(NOTE_ERRORS.tokenInvalid, "pedaço do nome da nota inválido");
    const name = `${NAME_PREFIX}${value}`;
    if (!used.has(name)) return name;
  }
  return fail(NOTE_ERRORS.duplicateId, "não achei nome livre para a nota");
}

/** Confere o nó novo com as regras do documento (id, caixa, `data`) e o limite de nós, antes de virar operação. */
function placeNode(doc: CanvasDoc, node: CanvasNode): CanvasNode {
  if (doc.nodes.length >= CANVAS_LIMITS.nodes) return fail(NOTE_ERRORS.limitExceeded, "limite de nós do documento atingido");
  if (doc.nodes.some((existing) => existing.id === node.id)) return fail(NOTE_ERRORS.duplicateId, "já existe nó com esse id");
  try {
    const [valid] = validateCanvasDoc({ v: doc.v, rev: 0, nodes: [node], edges: [], groups: [] }).nodes;
    return checkAnnotationNode(valid as CanvasNode);
  } catch (error) {
    if (error instanceof NoteError) throw error;
    return fail(NOTE_ERRORS.invalidNode, error instanceof Error ? error.message : "nó inválido");
  }
}

export interface NoteNodeInput extends NewNodeBase {
  /** Nome do arquivo (sem `.md`); veja `freshNoteName`. */
  note: string;
  agent?: string;
  w?: number;
  h?: number;
}

/** Cria um nó `note`: `create` da pilha de desfazer (desfazer tira o nó, o arquivo `.md` não é tocado) e o nó criado. */
export function createNoteNode(doc: CanvasDoc, input: NoteNodeInput): { op: AtomicOp; node: CanvasNode } {
  const data: NoteData = { note: requireNoteName(input.note) };
  if (input.agent !== undefined) data.agent = requireAgentId(input.agent);
  const node = placeNode(doc, {
    id: input.id, type: NOTE_TYPE, x: input.x, y: input.y, w: input.w ?? NOTE_FRAME.w, h: input.h ?? NOTE_FRAME.h,
    z: input.z ?? 0, data: { ...data }, locked: false, blurred: false,
  });
  return { op: opCreate(doc, [node]), node };
}

export interface TextNodeInput extends NewNodeBase {
  text: string;
  style?: TextStyle;
}

/** Cria um nó `text` do tamanho que `textFrame` estima. Mesmo contrato de `createNoteNode`. */
export function createTextNode(doc: CanvasDoc, input: TextNodeInput): { op: AtomicOp; node: CanvasNode } {
  const data = readTextData({ text: input.text, style: input.style ?? "label" });
  const { w, h } = textFrame(data);
  const node = placeNode(doc, { id: input.id, type: TEXT_TYPE, x: input.x, y: input.y, w, h, z: input.z ?? 0, data: { ...data }, locked: false, blurred: false });
  return { op: opCreate(doc, [node]), node };
}

// ---- editar nós (operações da pilha de desfazer) ----

function ownNode(doc: CanvasDoc, id: string, type: string): CanvasNode {
  const node = doc.nodes.find((candidate) => candidate.id === id);
  return node && node.type === type ? node : fail(NOTE_ERRORS.invalidNode, "o nó não existe ou é de outro tipo");
}

/**
 * Liga um agente à nota (`agent`) ou solta o agente (`undefined`): `update` do `data`, o arquivo `.md` não é tocado.
 * `undefined` quando já está assim. Erros: `note_invalid_node`, `note_invalid_agent`, `note_invalid_data` (data do nó corrompido).
 */
export function opSetNoteAgent(doc: CanvasDoc, id: string, agent: string | undefined): AtomicOp | undefined {
  const current = readNoteData(ownNode(doc, id, NOTE_TYPE).data);
  if (current.agent === agent) return undefined;
  const next: NoteData = { note: current.note };
  if (agent !== undefined) next.agent = requireAgentId(agent);
  return opUpdate(doc, id, { ...next });
}

/** Troca o texto (e, se vier, o estilo) de um nó `text`: `update` do `data`; o tamanho do nó não muda. `undefined` quando nada muda. */
export function opEditText(doc: CanvasDoc, id: string, text: string, style?: TextStyle): AtomicOp | undefined {
  const current = readTextData(ownNode(doc, id, TEXT_TYPE).data);
  const next = readTextData({ text, style: style ?? current.style });
  return next.text === current.text && next.style === current.style ? undefined : opUpdate(doc, id, { ...next });
}

// ---- nota de verdade: nome, arquivo, imagem, tabela e diagrama (reference/argos.md §Notas) ----

export const NOTE_FILE_LIMITS = {
  /** Nome que o dono fixa no cabeçalho, em caracteres. */
  titleChars: NOTE_LIMITS.titleChars,
  /** Imagem colada, em bytes (depois de decodificada). */
  imageBytes: 5 * 1024 * 1024,
  /** Imagens guardadas ao lado de uma nota. */
  imagesPerNote: 200,
  /** Menor retângulo que a ferramenta Nota aceita; menos que isso nasce no tamanho padrão. */
  minW: 160,
  minH: 100,
} as const;

/** Extensões que um arquivo de nota pode ter fora da pasta padrão (arrastar de fora e "Mover para…"). */
export const NOTE_FILE_EXTS = [".md", ".markdown", ".txt"] as const;

/** `true` se o nome do arquivo (só o nome, com extensão) é de nota: `.md`, `.markdown` ou `.txt`, sem diferenciar caixa. */
export function isNoteFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return NOTE_FILE_EXTS.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Nome fixado pelo dono: aparado, até `titleChars`, sem caractere de controle. Vazio = `null` (volta ao automático). */
export function readNoteTitle(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return fail(NOTE_ERRORS.invalidTitle, "nome da nota precisa ser texto");
  const title = value.trim();
  if (title === "") return null;
  if ([...title].length > NOTE_FILE_LIMITS.titleChars || CONTROL_CHARS.test(title)) return fail(NOTE_ERRORS.invalidTitle, "nome da nota inválido");
  return title;
}

/** Marcas de Markdown no começo da linha (título, citação, item de lista, tarefa) e ênfase em volta, para o nome automático. */
const LINE_MARKS = /^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)+/;
const EMPHASIS = /[*_`~]+/g;

/**
 * Nome que o cabeçalho mostra: o fixado pelo dono vence; senão a primeira linha com conteúdo, sem as marcas de Markdown,
 * cortada com reticências; `""` se a nota não tem texto (quem desenha mostra o nome do arquivo).
 */
export function noteTitle(text: string, custom: string | null = null): string {
  if (custom !== null && custom.trim() !== "") return custom.trim();
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(LINE_MARKS, "").replace(EMPHASIS, "").trim();
    if (line === "" || /^(?:```|~~~|---+|\|)/.test(raw.trim())) continue;
    const chars = [...line];
    return chars.length <= NOTE_FILE_LIMITS.titleChars ? line : `${chars.slice(0, NOTE_FILE_LIMITS.titleChars - 1).join("")}…`;
  }
  return "";
}

// ---- imagem colada ----

export const NOTE_IMAGE_EXTS = ["png", "jpg", "gif", "webp"] as const;
export type NoteImageExt = (typeof NOTE_IMAGE_EXTS)[number];

export const NOTE_IMAGE_MIME: Readonly<Record<NoteImageExt, string>> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean => prefix.every((byte, i) => bytes[at + i] === byte);

/**
 * Tipo da imagem pelos primeiros bytes (PNG, JPEG, GIF, WebP), nunca pelo tipo declarado; SVG e o resto ficam de fora
 * (SVG carrega script). `undefined` = não é imagem aceita.
 */
export function sniffImage(bytes: Uint8Array): NoteImageExt | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return undefined;
}

/** Arquivo de imagem guardado ao lado da nota: 16 hexadecimais do hash do conteúdo e a extensão do tipo. */
const ASSET_FILE = /^[a-f0-9]{16}\.(?:png|jpg|gif|webp)$/;
export const isAssetFile = (name: string): boolean => ASSET_FILE.test(name);

/** Pasta das imagens da nota, ao lado do arquivo: `<nome do arquivo sem extensão>.assets`. */
export const assetDirOf = (fileBase: string): string => `${fileBase}.assets`;

/** O que entra no texto da nota: caminho relativo ao arquivo, o mesmo que um agente que lê o `.md` resolve. */
export const imageMarkdown = (fileBase: string, file: string): string => `![imagem](${assetDirOf(fileBase)}/${file})`;

/** Referência relativa `<base>.assets/<arquivo>` → o arquivo, se for uma imagem desta nota; `undefined` para o resto. */
export function assetOfRef(fileBase: string, ref: string): string | undefined {
  const prefix = `${assetDirOf(fileBase)}/`;
  const rest = ref.startsWith("./") ? ref.slice(2) : ref;
  if (!rest.startsWith(prefix)) return undefined;
  const file = rest.slice(prefix.length);
  return isAssetFile(file) ? file : undefined;
}

// ---- tabela: as cópias que o menu oferece ----

export interface NoteTable {
  header: string[];
  rows: string[][];
}

const tsvCell = (text: string): string => text.replace(/[\t\r\n]+/g, " ");
const htmlCell = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const mdCell = (text: string): string => text.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

/** Linhas com o mesmo número de colunas do cabeçalho (falta vira vazio, sobra sai): todo formato de cópia sai retangular. */
const squared = (table: NoteTable): string[][] => table.rows.map((row) => table.header.map((_, i) => row[i] ?? ""));

export function tableToTsv(table: NoteTable): string {
  return [table.header, ...squared(table)].map((row) => row.map(tsvCell).join("\t")).join("\n");
}

export function tableToHtml(table: NoteTable): string {
  const head = `<tr>${table.header.map((c) => `<th>${htmlCell(c)}</th>`).join("")}</tr>`;
  const body = squared(table).map((row) => `<tr>${row.map((c) => `<td>${htmlCell(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

export function tableToMarkdown(table: NoteTable): string {
  const line = (cells: readonly string[]): string => `| ${cells.map(mdCell).join(" | ")} |`;
  return [line(table.header), line(table.header.map(() => "---")), ...squared(table).map(line)].join("\n");
}

/** RTF (seção "Table Definitions" da especificação RTF 1.9.1): texto fora do ASCII sai como `\uN?`. */
const rtfText = (text: string): string =>
  [...text.replace(/[\r\n]+/g, " ")].map((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\" || ch === "{" || ch === "}") return `\\${ch}`;
    if (code < 0x80) return ch;
    // fora do plano básico: dois \u (par substituto), cada um com o número com sinal de 16 bits que o RTF pede
    return [...ch.split("")].map((unit) => { const n = unit.charCodeAt(0); return `\\u${n > 32767 ? n - 65536 : n}?`; }).join("");
  }).join("");

const RTF_CELL_TWIPS = 2000;

export function tableToRtf(table: NoteTable): string {
  const cols = table.header.length;
  const def = Array.from({ length: cols }, (_, i) => `\\cellx${(i + 1) * RTF_CELL_TWIPS}`).join("");
  const row = (cells: readonly string[], bold: boolean): string =>
    `\\trowd${def}${cells.map((c) => `\\pard\\intbl ${bold ? "{\\b " : ""}${rtfText(c)}${bold ? "}" : ""}\\cell`).join("")}\\row`;
  return `{\\rtf1\\ansi\\deff0 ${row(table.header, true)}${squared(table).map((r) => row(r, false)).join("")}}`;
}

// ---- criar pela ferramenta Nota, arrastar de fora e fechar ----

/** Retângulo arrastado pela ferramenta Nota → caixa do nó: pequeno demais nasce no tamanho padrão, no mesmo canto. */
export function noteFrameFromRect(rect: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const w = Math.abs(rect.w);
  const h = Math.abs(rect.h);
  const x = rect.w < 0 ? rect.x + rect.w : rect.x;
  const y = rect.h < 0 ? rect.y + rect.h : rect.y;
  if (w < NOTE_FILE_LIMITS.minW || h < NOTE_FILE_LIMITS.minH) return { x, y, w: NOTE_FRAME.w, h: NOTE_FRAME.h };
  return { x, y, w, h };
}

/**
 * Nó `note` novo a partir do retângulo da ferramenta Nota: nome de arquivo livre (`freshNoteName`) e o `create` do
 * desfazer. O arquivo nasce na primeira gravação (PUT com revisão nula), na pasta padrão.
 */
export function createNoteFromRect(doc: CanvasDoc, input: { id: string; rect: { x: number; y: number; w: number; h: number }; token: () => string }): { op: AtomicOp; node: CanvasNode; note: string } {
  const note = freshNoteName(doc, input.token);
  const frame = noteFrameFromRect(input.rect);
  const { op, node } = createNoteNode(doc, { id: input.id, note, ...frame });
  return { op, node, note };
}

/**
 * Fechar a nota: o `delete` do desfazer e o nome do arquivo, que o host manda apagar pela rota (a rota só apaga arquivo
 * da pasta padrão; arquivo em local personalizado fica). `undefined` se o nó não é nota.
 */
export function closeNotePlan(doc: CanvasDoc, nodeId: string): { op: AtomicOp; note: string } | undefined {
  const note = noteFileOf(doc, nodeId);
  return note === undefined ? undefined : { op: opDelete(doc, [nodeId]), note };
}

/**
 * Caminhos locais de `text/uri-list` (o que o gerenciador de arquivos põe no arrastar): só `file://` sem host, decodificado,
 * de arquivo de nota. Comentário (`#`), outra origem e outra extensão saem. Até `max` caminhos.
 */
export function noteDropPaths(uriList: string, max = 20): string[] {
  const out: string[] = [];
  for (const raw of uriList.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || !line.startsWith("file:///")) continue;
    let path: string;
    try {
      path = decodeURIComponent(line.slice("file://".length));
    } catch {
      continue; // %-sequência inválida: não é um caminho que o gerenciador de arquivos mandaria
    }
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (isNoteFileName(base) && !path.includes("\u0000")) out.push(path);
    if (out.length >= max) break;
  }
  return out;
}
