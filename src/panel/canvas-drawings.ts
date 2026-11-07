// Rotas do desenho do canvas (reference/argos.md §Desenho): o desenho é um nó `drawing` do documento, e a cena versionada mora no `data`
// dele. GET lê (estruturado ou SVG), POST `…/edit` aplica uma lista de edições de uma vez. O dono lê e escreve em qualquer desenho;
// o agente (`as`) lê o que está ligado a ele e a cadeia, e escreve só no ligado direto, e só no painel local. A chave e o token da
// sessão são conferidos pelo servidor antes de chegar aqui; este módulo decide o que cada chamador pode, antes de tocar na cena.
import { type CanvasDoc } from "../lib/canvas-doc.ts";
import {
  addElement, canReadDrawing, canWriteDrawing, DRAWING_ERRORS, DrawingError, type DrawingScene, describeDrawing, drawingToSvg, isDrawingNode,
  moveElement, readableDrawingsOf, removeElement, sceneData, sceneOfNode, setElementText,
} from "../lib/canvas-drawing.ts";
import { OWNER, requireWriterId, type NoteWriter } from "../lib/canvas-note.ts";
import { isValidCanvasId } from "../lib/canvas-store.ts";
import { type PatchResult } from "./canvas.ts";
import { send } from "./http.ts";
import { log } from "./log.ts";

const BASE = "/api/canvas-drawings/";
const OK_STATUS = 200;
const INVALID_STATUS = 400;
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const CONFLICT_STATUS = 409;
const TOO_LARGE_STATUS = 413;
const UNREADABLE_STATUS = 500;
/** Corpo máximo de uma chamada de edição (traços de 500 pontos cabem folgados; mais que isso nem é lido). */
export const DRAWING_BODY_BYTES = 256 * 1024;
/** Edições por chamada. */
export const DRAWING_EDITS_PER_CALL = 100;

/** Códigos estáveis da rota (só ganham valores); os de dado (`drawing_*`) vêm de `DRAWING_ERRORS`. */
export const DRAWING_ROUTE_ERRORS = {
  invalidBody: "drawing_invalid_body",
  tooLarge: "drawing_body_too_large",
  notFound: "drawing_not_found",
  staleRevision: "drawing_stale_revision",
  agentLocalOnly: "drawing_agent_local_only",
  unreadable: "drawing_unreadable",
  tooManyEdits: "drawing_too_many_edits",
} as const;
type RouteErrorCode = (typeof DRAWING_ROUTE_ERRORS)[keyof typeof DRAWING_ROUTE_ERRORS] | (typeof DRAWING_ERRORS)[keyof typeof DRAWING_ERRORS];

export interface DrawingCaller {
  remote: boolean;
}

export interface DrawingDeps {
  /** O documento do canvas `id`, ou `undefined` se não existe ou não abre. */
  loadDoc(canvasId: string): Promise<CanvasDoc | undefined>;
  /** Troca o `data` do nó com a regra de revisão do canvas (`createCanvasRoutes().patchNodeData`). */
  patchNodeData(canvasId: string, nodeId: string, rev: number, check: (doc: CanvasDoc) => boolean, data: Record<string, unknown>): PatchResult;
}

export interface DrawingRoutes {
  /** `GET /api/canvas-drawings/<canvas>[?as=<agente>]` (lista) e `…/<canvas>/<nó>[/svg][?as=]`; `undefined` fora da família. */
  get(path: string, query: Readonly<Record<string, string>>, caller: DrawingCaller): Promise<Response> | undefined;
  /** `POST /api/canvas-drawings/<canvas>/<nó>/edit`; `undefined` fora da família. */
  post(path: string, req: Request, caller: DrawingCaller): Promise<Response> | undefined;
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

const refusal = (status: number, code: RouteErrorCode, extra: Dict = {}): Response => send(status, { error: `desenho recusado (${code})`, code, ...extra });
const notFound = (): Response => refusal(NOT_FOUND_STATUS, DRAWING_ROUTE_ERRORS.notFound);

/** Corpo até `max` bytes; `undefined` se passa dele (sem ler o resto). */
async function readBody(req: Request, max: number): Promise<Uint8Array | undefined> {
  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > max) return undefined;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Aplica uma edição à cena; erro de dado sobe como `DrawingError`. */
function applyEdit(scene: DrawingScene, edit: unknown): DrawingScene {
  if (!isDict(edit) || typeof edit.op !== "string") throw new DrawingError(DRAWING_ERRORS.invalidElement, "edição inválida");
  switch (edit.op) {
    case "add": {
      if (!isDict(edit.element)) throw new DrawingError(DRAWING_ERRORS.invalidElement, "edição add sem element");
      return addElement(scene, edit.element).scene;
    }
    case "move": {
      if (typeof edit.id !== "string") throw new DrawingError(DRAWING_ERRORS.invalidId, "edição move sem id");
      return moveElement(scene, edit.id, edit.dx as number, edit.dy as number);
    }
    case "remove": {
      if (typeof edit.id !== "string") throw new DrawingError(DRAWING_ERRORS.invalidId, "edição remove sem id");
      return removeElement(scene, edit.id);
    }
    case "text": {
      if (typeof edit.id !== "string" || typeof edit.text !== "string") throw new DrawingError(DRAWING_ERRORS.invalidElement, "edição text sem id ou texto");
      return setElementText(scene, edit.id, edit.text);
    }
    default:
      throw new DrawingError(DRAWING_ERRORS.invalidElement, "operação desconhecida");
  }
}

export function createCanvasDrawingsRoutes(deps: DrawingDeps): DrawingRoutes {
  /** Quem chama, como leitor: `undefined` = dono; texto = nó do agente/terminal. Agente só local (sem credencial por agente). */
  function readerOf(value: unknown, caller: DrawingCaller): { reader: string | undefined } | Response {
    if (value === undefined) return { reader: undefined };
    let id: string;
    try {
      id = requireWriterId(value);
    } catch {
      return refusal(INVALID_STATUS, DRAWING_ROUTE_ERRORS.invalidBody);
    }
    if (caller.remote) return refusal(FORBIDDEN_STATUS, DRAWING_ROUTE_ERRORS.agentLocalOnly);
    return { reader: id };
  }

  const segments = (path: string): string[] | undefined => (path.startsWith(BASE) ? path.slice(BASE.length).split("/") : undefined);

  async function read(canvasId: string, nodeId: string | undefined, format: string | undefined, query: Readonly<Record<string, string>>, caller: DrawingCaller): Promise<Response> {
    if (!isValidCanvasId(canvasId)) return notFound();
    const who = readerOf(query.as, caller);
    if (who instanceof Response) return who;
    const doc = await deps.loadDoc(canvasId);
    if (!doc) return notFound();
    if (nodeId === undefined) {
      const ids = who.reader === undefined ? doc.nodes.filter(isDrawingNode).map((node) => ({ id: node.id, via: null as string | null })) : readableDrawingsOf(doc, who.reader);
      const drawings = ids.flatMap((entry) => {
        const node = doc.nodes.find((candidate) => candidate.id === entry.id);
        const scene = node ? safeScene(node) : undefined;
        return node && scene ? [{ id: node.id, title: scene.title ?? null, elements: scene.elements.length, via: entry.via }] : [];
      });
      return send(OK_STATUS, { rev: doc.rev, drawings });
    }
    // fora do escopo responde como inexistente: desenho que não existe, de outro tipo ou que o agente não alcança são o mesmo 404
    const node = doc.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || !isDrawingNode(node) || (who.reader !== undefined && !canReadDrawing(doc, nodeId, who.reader))) return notFound();
    const scene = safeScene(node);
    if (!scene) return refusal(UNREADABLE_STATUS, DRAWING_ROUTE_ERRORS.unreadable);
    if (format === "svg") return send(OK_STATUS, { rev: doc.rev, id: nodeId, svg: drawingToSvg(scene) });
    if (format !== undefined) return notFound();
    return send(OK_STATUS, { rev: doc.rev, id: nodeId, drawing: describeDrawing(scene) });
  }

  function safeScene(node: CanvasDoc["nodes"][number]): DrawingScene | undefined {
    try {
      return sceneOfNode(node);
    } catch (error) {
      if (!(error instanceof DrawingError)) throw error;
      log("warn", "desenho ilegível", { node: node.id, code: error.code });
      return undefined;
    }
  }

  async function edit(canvasId: string, nodeId: string, req: Request, caller: DrawingCaller): Promise<Response> {
    if (!isValidCanvasId(canvasId)) return notFound();
    const raw = await readBody(req, DRAWING_BODY_BYTES);
    if (!raw) return refusal(TOO_LARGE_STATUS, DRAWING_ROUTE_ERRORS.tooLarge);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return refusal(INVALID_STATUS, DRAWING_ROUTE_ERRORS.invalidBody);
    }
    if (!isDict(body) || typeof body.rev !== "number" || !Number.isInteger(body.rev) || !Array.isArray(body.edits) || body.edits.length === 0) {
      return refusal(INVALID_STATUS, DRAWING_ROUTE_ERRORS.invalidBody);
    }
    if (body.edits.length > DRAWING_EDITS_PER_CALL) return refusal(INVALID_STATUS, DRAWING_ROUTE_ERRORS.tooManyEdits);
    let writer: NoteWriter = OWNER;
    if (body.as !== undefined) {
      if (!isDict(body.as)) return refusal(INVALID_STATUS, DRAWING_ROUTE_ERRORS.invalidBody);
      const who = readerOf(body.as.agent, caller);
      if (who instanceof Response) return who;
      if (who.reader !== undefined) writer = { kind: "agent", id: who.reader };
    }
    const doc = await deps.loadDoc(canvasId);
    // a decisão de acesso vem antes de qualquer leitura da cena; fora do escopo é 404, igual a desenho que não existe
    if (!doc || !canWriteDrawing(doc, nodeId, writer)) return notFound();
    const node = doc.nodes.find((candidate) => candidate.id === nodeId);
    const scene = node ? safeScene(node) : undefined;
    if (!scene) return refusal(UNREADABLE_STATUS, DRAWING_ROUTE_ERRORS.unreadable);
    let next = scene;
    try {
      for (const one of body.edits) next = applyEdit(next, one);
    } catch (error) {
      if (!(error instanceof DrawingError)) throw error;
      log("warn", "desenho recusado", { canvas: canvasId, node: nodeId, code: error.code, remote: caller.remote });
      return refusal(INVALID_STATUS, error.code);
    }
    // a gravação confere de novo o acesso no documento que vai sobrescrever: se a ligação saiu no meio, é como inexistente
    const saved = deps.patchNodeData(canvasId, nodeId, body.rev, (current) => canWriteDrawing(current, nodeId, writer), sceneData(next));
    if (!saved.ok) {
      if (saved.reason === "stale") return refusal(CONFLICT_STATUS, DRAWING_ROUTE_ERRORS.staleRevision, { rev: saved.rev });
      if (saved.reason === "unreadable") return refusal(UNREADABLE_STATUS, DRAWING_ROUTE_ERRORS.unreadable);
      if (saved.reason === "invalid") return refusal(INVALID_STATUS, DRAWING_ERRORS.limitExceeded);
      return notFound();
    }
    log("info", "desenho gravado", { canvas: canvasId, node: nodeId, rev: saved.rev, edits: body.edits.length, by: writer.kind === "agent" ? "agent" : "owner" });
    return send(OK_STATUS, { ok: true, rev: saved.rev, elements: next.elements.length });
  }

  return {
    get(path, query, caller) {
      const parts = segments(path);
      if (!parts || parts.length === 0 || parts.length > 3 || parts.some((part) => part === "")) return undefined;
      const [canvasId, nodeId, format] = parts as [string, string | undefined, string | undefined];
      return read(canvasId, nodeId, format, query, caller);
    },
    post(path, req, caller) {
      const parts = segments(path);
      if (!parts || parts.length !== 3 || parts[2] !== "edit" || parts.some((part) => part === "")) return undefined;
      return edit(parts[0] as string, parts[1] as string, req, caller);
    },
  };
}
