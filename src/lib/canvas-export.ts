// Exportar e importar um canvas (reference/argos.md §Vários canvases e exportação): um arquivo JSON com o documento e o nome.
// Puro e sem dependência de Node. Importar valida tudo pelo validador do documento e nunca decide sozinho sobre sobrescrever:
// quem chama escolhe o id (a rota exige id novo ou confirmação explícita).
import { CANVAS_ERRORS, CANVAS_LIMITS, CanvasError, isLiveNodeType, readCanvasDoc, type CanvasDoc } from "./canvas-doc.ts";
import { requireCanvasName } from "./canvas-store.ts";

export const CANVAS_EXPORT_FORMAT = "hades-canvas";
export const CANVAS_EXPORT_VERSION = 1;
/** Folga do envelope (formato, versão, nome, data) acima do teto de bytes do documento. */
export const CANVAS_EXPORT_ENVELOPE_BYTES = 4096;

export const CANVAS_EXPORT_ERRORS = {
  invalidFormat: "canvas_export_invalid_format",
  unsupportedVersion: "canvas_export_unsupported_version",
} as const;
export type CanvasExportErrorCode = (typeof CANVAS_EXPORT_ERRORS)[keyof typeof CANVAS_EXPORT_ERRORS];

export class CanvasExportError extends Error {
  readonly code: CanvasExportErrorCode;
  constructor(code: CanvasExportErrorCode, message: string) {
    super(message);
    this.name = "CanvasExportError";
    this.code = code;
  }
}

export interface CanvasExport {
  format: typeof CANVAS_EXPORT_FORMAT;
  exportVersion: number;
  name: string;
  /** Instante da exportação, ISO 8601 em UTC. */
  exportedAt: string;
  doc: CanvasDoc;
}

export interface ImportedCanvas {
  name: string;
  /** Documento válido e sem revisão (`rev: 0`): quem grava decide a revisão. */
  doc: CanvasDoc;
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** O arquivo de exportação de um canvas. O relógio vem de quem chama. */
export function exportCanvas(doc: CanvasDoc, name: string, now: Date): CanvasExport {
  return { format: CANVAS_EXPORT_FORMAT, exportVersion: CANVAS_EXPORT_VERSION, name: requireCanvasName(name), exportedAt: now.toISOString(), doc };
}

/** Nó vivo volta só como posição: o conteúdo vem do grafo, então `data` que o arquivo trouxer é descartado. */
function stripLiveData(rawDoc: Dict): Dict {
  if (!Array.isArray(rawDoc.nodes)) return rawDoc;
  const nodes = rawDoc.nodes.map((node) => (isDict(node) && typeof node.type === "string" && isLiveNodeType(node.type) ? { ...node, data: {} } : node));
  return { ...rawDoc, nodes };
}

/**
 * Texto de um arquivo exportado → nome e documento válidos. Lança `CanvasExportError` (envelope) ou `CanvasError` (documento,
 * com os mesmos códigos do `PUT`): `canvas_too_large`, `canvas_invalid_json`, `canvas_invalid_shape`, `canvas_unsupported_version`…
 */
export function parseCanvasExport(text: string): ImportedCanvas {
  if (byteLength(text) > CANVAS_LIMITS.bodyBytes + CANVAS_EXPORT_ENVELOPE_BYTES) throw new CanvasError(CANVAS_ERRORS.tooLarge, "arquivo acima do limite de bytes");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CanvasError(CANVAS_ERRORS.invalidJson, "arquivo não é JSON");
  }
  if (!isDict(parsed) || parsed.format !== CANVAS_EXPORT_FORMAT) throw new CanvasExportError(CANVAS_EXPORT_ERRORS.invalidFormat, "não é uma exportação de canvas");
  if (parsed.exportVersion !== CANVAS_EXPORT_VERSION) throw new CanvasExportError(CANVAS_EXPORT_ERRORS.unsupportedVersion, "versão da exportação não suportada");
  if (!isDict(parsed.doc)) throw new CanvasError(CANVAS_ERRORS.invalidShape, "documento precisa ser objeto");
  if (byteLength(JSON.stringify(parsed.doc)) > CANVAS_LIMITS.bodyBytes) throw new CanvasError(CANVAS_ERRORS.tooLarge, "documento acima do limite de bytes");
  const doc = readCanvasDoc(stripLiveData(parsed.doc));
  return { name: requireCanvasName(parsed.name), doc: { ...doc, rev: 0 } };
}
