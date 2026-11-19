// Rotas do nó `cardinal` do canvas (reference/argos.md §Nó cardinal): cada diagrama é um arquivo `.cardinal` em
// `$D/canvas-cardinal/` (modo 0600) ou um arquivo de fora adotado pelo índice. O painel guarda bytes e controla a revisão; o
// conteúdo é opaco (só o envelope é lido). GET lê, PUT grava (atômico, com revisão contra escrita concorrente). As rotas são
// por nó (`<canvas>/<nó>`), porque o acesso do agente depende do documento. O dono lê e escreve em qualquer diagrama; o agente
// só no que o documento o liga, e só no painel local; fora do escopo responde 404. A chave e o token da sessão são conferidos
// pelo servidor antes de chegar aqui.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type CanvasDoc } from "../lib/canvas-doc.ts";
import {
  adoptedNameOf, canReadCardinal, canWriteCardinal, CARDINAL_ERRORS, CARDINAL_LIMITS, CardinalError, type CardinalEnvelope, cardinalFileOf, isCardinalName,
  isCardinalNode, readEnvelope, requireWritableEnvelope,
} from "../lib/canvas-cardinal.ts";
import { OWNER, requireWriterId, type NoteWriter } from "../lib/canvas-note.ts";
import { isValidCanvasId } from "../lib/canvas-store.ts";
import { send } from "./http.ts";
import { log } from "./log.ts";

const FOLDER = "canvas-cardinal";
const EXT = ".cardinal";
const BASE = "/api/canvas-cardinal/";
const FILE_MODE = 0o600;
const REV_CHARS = 16;
const OK_STATUS = 200;
const INVALID_STATUS = 400;
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const CONFLICT_STATUS = 409;
const TOO_LARGE_STATUS = 413;
const UNREADABLE_STATUS = 500;
/** Cabe o arquivo máximo e o envelope JSON do corpo (aspas e quebras de linha dobram de tamanho no máximo). */
export const CARDINAL_BODY_BYTES = 2 * CARDINAL_LIMITS.bodyBytes + 4096;
const SMALL_BODY_BYTES = 16 * 1024;
const INDEX_FILE = ".index.json";
const INDEX_VERSION = 1;
export const CARDINAL_LIST_LIMITS = { fallback: 50, max: 200 } as const;

/** Códigos estáveis da rota: só ganham valores. Os de dado (`cardinal_invalid_*`) vêm de `CARDINAL_ERRORS`. */
export const CARDINAL_ROUTE_ERRORS = {
  invalidBody: "cardinal_invalid_body",
  tooLarge: "cardinal_too_large",
  notFound: "cardinal_not_found",
  staleRevision: "cardinal_stale_revision",
  agentLocalOnly: "cardinal_agent_local_only",
  unreadable: "cardinal_unreadable",
  localOnly: "cardinal_local_only",
  invalidPath: "cardinal_invalid_path",
  exists: "cardinal_exists",
  invalidQuery: "cardinal_invalid_query",
} as const;
type RouteErrorCode = (typeof CARDINAL_ROUTE_ERRORS)[keyof typeof CARDINAL_ROUTE_ERRORS] | (typeof CARDINAL_ERRORS)[keyof typeof CARDINAL_ERRORS];

export interface CardinalCaller {
  remote: boolean;
}

export interface CardinalDeps {
  /** O documento do canvas `id`, ou `undefined` se não existe ou não abre. */
  loadDoc(canvasId: string): Promise<CanvasDoc | undefined>;
  /** Pastas onde um diagrama pode morar fora da pasta padrão (adoção). Padrão: a pasta pessoal. */
  roots?: readonly string[];
  /** Pedaço aleatório do nome de um arquivo adotado (minúsculas e números); injetado no teste. */
  token?: () => string;
  /** Gravação feita por esta rota (PUT): o servidor avisa as páginas e o vigia aprende a revisão nova. */
  onWrite?(name: string, rev: string): void;
}

/** Um arquivo que a rota conhece: o vigia confere o carimbo de cada um. */
export interface CardinalFileRef {
  name: string;
  file: string;
}

export interface CardinalRoutes {
  /** `GET /api/canvas-cardinal/<canvas>[/<nó>]`; `undefined` fora da família. */
  get(path: string, query: Readonly<Record<string, string>>, caller: CardinalCaller): Promise<Response> | undefined;
  /** `PUT /api/canvas-cardinal/<canvas>/<nó>`; `undefined` fora da família. */
  write(path: string, req: Request, caller: CardinalCaller): Promise<Response> | undefined;
  /** `GET /api/canvas-cardinal?limit=&after=`: os arquivos conhecidos, por nome, em páginas (dono). */
  list(query: Readonly<Record<string, string>>): Response;
  /** `POST /api/canvas-cardinal/link {path}`; `undefined` fora da família. */
  action(path: string, req: Request, caller: CardinalCaller): Promise<Response> | undefined;
  /** Os arquivos conhecidos agora (pasta padrão e adotados), para o vigia. Não lança: índice ilegível dá só a pasta padrão. */
  files(): CardinalFileRef[];
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

const refusal = (status: number, code: RouteErrorCode, extra: Dict = {}): Response => send(status, { error: `diagrama recusado (${code})`, code, ...extra });
const notFound = (): Response => refusal(NOT_FOUND_STATUS, CARDINAL_ROUTE_ERRORS.notFound);

/** Revisão = hash do conteúdo: qualquer mudança no arquivo (inclusive por fora da rota) muda a revisão. */
export const revisionOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, REV_CHARS);

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

interface Stored {
  text: string;
  rev: string;
  updatedAt: string;
  bytes: number;
}

interface Place {
  file: string;
  custom: boolean;
}

class Unreadable extends Error {}
class TooLarge extends Error {}
class Refused extends Error {
  readonly status: number;
  readonly code: RouteErrorCode;
  constructor(status: number, code: RouteErrorCode) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const defaultToken = (): string => randomBytes(6).toString("hex");

export function createCanvasCardinalRoutes(dir: string, deps: CardinalDeps): CardinalRoutes {
  const folder = join(dir, FOLDER);
  const folderPrefix = resolve(folder) + sep;
  const indexPath = join(folder, INDEX_FILE);
  const token = deps.token ?? defaultToken;
  const roots = (): string[] => (deps.roots ?? [homedir()]).flatMap((root) => {
    try {
      return [realpathSync(root) + sep];
    } catch {
      return []; // raiz que não existe nesta máquina não contém nada
    }
  });

  // ---- índice: nome → arquivo adotado ----

  function loadIndex(): Record<string, string> {
    let raw: string;
    try {
      raw = readFileSync(indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Unreadable("índice não abre");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Unreadable("índice não é JSON");
    }
    if (!isDict(parsed) || parsed.v !== INDEX_VERSION || !isDict(parsed.files)) throw new Unreadable("índice fora do formato");
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.files)) {
      if (!isCardinalName(name) || !isDict(value) || typeof value.path !== "string" || !isAbsolute(value.path)) throw new Unreadable("índice com entrada inválida");
      out[name] = value.path;
    }
    return out;
  }

  function saveIndex(index: Record<string, string>): void {
    const files: Record<string, { path: string }> = {};
    for (const [name, path] of Object.entries(index)) files[name] = { path };
    mkdirSync(folder, { recursive: true });
    const tmp = `${indexPath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ v: INDEX_VERSION, files }, null, 2), { mode: FILE_MODE });
      renameSync(tmp, indexPath);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  // ---- caminho ----

  /** Arquivo de fora: absoluto, `.cardinal`, com a pasta (caminho real) dentro de uma raiz e fora da pasta padrão. */
  function checkCustomPath(path: string): string {
    if (!isAbsolute(path) || path.includes("\u0000") || !basename(path).endsWith(EXT) || basename(path) === EXT) throw new Refused(INVALID_STATUS, CARDINAL_ROUTE_ERRORS.invalidPath);
    let realDir: string;
    try {
      realDir = realpathSync(dirname(resolve(path)));
    } catch {
      throw new Refused(INVALID_STATUS, CARDINAL_ROUTE_ERRORS.invalidPath);
    }
    const full = join(realDir, basename(path));
    const within = roots().some((root) => full.startsWith(root));
    if (!within || full.startsWith(folderPrefix)) throw new Refused(INVALID_STATUS, CARDINAL_ROUTE_ERRORS.invalidPath);
    return full;
  }

  function defaultPathOf(name: string): string {
    const full = resolve(folder, `${name}${EXT}`);
    if (!full.startsWith(folderPrefix)) throw new Unreadable("nome fora da pasta");
    return full;
  }

  /** O caminho do índice é conferido de novo a cada uso (a raiz ou um link simbólico podem ter mudado). */
  function placeOf(name: string, index: Record<string, string>): Place {
    const custom = index[name];
    if (custom === undefined) return { file: defaultPathOf(name), custom: false };
    try {
      return { file: checkCustomPath(custom), custom: true };
    } catch (error) {
      if (error instanceof Refused) throw new Unreadable("local personalizado fora das raízes");
      throw error;
    }
  }

  // ---- arquivo ----

  /** O diagrama gravado, `undefined` se não há arquivo. Link simbólico, não UTF-8 e acima do teto não são lidos. */
  function readAt(file: string): Stored | undefined {
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Unreadable("arquivo não abre");
    }
    if (!info.isFile()) throw new Unreadable("não é arquivo comum");
    if (info.size > CARDINAL_LIMITS.bodyBytes) throw new TooLarge("diagrama acima do teto");
    const bytes = readFileSync(file);
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), rev: revisionOf(bytes), updatedAt: info.mtime.toISOString(), bytes: bytes.length };
    } catch {
      throw new Unreadable("não é UTF-8");
    }
  }

  function storeAt(place: Place, bytes: Uint8Array): void {
    if (!place.custom) mkdirSync(folder, { recursive: true });
    // arquivo de fora mantém a permissão que tinha; o da pasta padrão é só do dono
    let mode = FILE_MODE;
    if (place.custom) {
      try {
        mode = statSync(place.file).mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const tmp = `${place.file}.tmp`;
    try {
      writeFileSync(tmp, bytes, { mode });
      renameSync(tmp, place.file);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  function failure(error: unknown): Response {
    if (error instanceof Refused) return refusal(error.status, error.code);
    if (error instanceof CardinalError) return refusal(INVALID_STATUS, error.code);
    if (error instanceof TooLarge) return refusal(TOO_LARGE_STATUS, CARDINAL_ROUTE_ERRORS.tooLarge);
    if (error instanceof Unreadable) {
      log("error", "diagrama ilegível", { code: CARDINAL_ROUTE_ERRORS.unreadable, reason: error.message });
      return refusal(UNREADABLE_STATUS, CARDINAL_ROUTE_ERRORS.unreadable);
    }
    throw error;
  }

  // ---- escopo ----

  /** Quem chama, como agente: `undefined` = dono. Agente só local (sem credencial por agente, a identidade só vale onde eles rodam). */
  function agentOf(value: unknown, caller: CardinalCaller): { agent: string | undefined } | Response {
    if (value === undefined) return { agent: undefined };
    let id: string;
    try {
      id = requireWriterId(value);
    } catch {
      return refusal(INVALID_STATUS, CARDINAL_ROUTE_ERRORS.invalidBody);
    }
    if (caller.remote) return refusal(FORBIDDEN_STATUS, CARDINAL_ROUTE_ERRORS.agentLocalOnly);
    return { agent: id };
  }

  const segments = (path: string): string[] | undefined => (path.startsWith(BASE) ? path.slice(BASE.length).split("/") : undefined);

  function view(name: string, place: Place, stored: Stored): Dict {
    let envelope: CardinalEnvelope | undefined;
    try {
      envelope = readEnvelope(stored.text);
    } catch (error) {
      if (!(error instanceof CardinalError)) throw error;
    }
    return {
      name, text: stored.text, rev: stored.rev, updatedAt: stored.updatedAt, bytes: stored.bytes,
      format: envelope?.format ?? null, version: envelope?.version ?? null, app: envelope?.app ?? null, diagrams: envelope?.diagrams ?? 0,
      supported: envelope?.supported ?? false, valid: envelope !== undefined,
      location: place.custom ? "custom" : "default", path: place.custom ? place.file : null,
    };
  }

  async function read(canvasId: string, nodeId: string | undefined, query: Readonly<Record<string, string>>, caller: CardinalCaller): Promise<Response> {
    if (!isValidCanvasId(canvasId)) return notFound();
    const who = agentOf(query.as, caller);
    if (who instanceof Response) return who;
    const doc = await deps.loadDoc(canvasId);
    if (!doc) return notFound();
    try {
      const index = loadIndex();
      if (nodeId === undefined) {
        const nodes = doc.nodes.filter(isCardinalNode).filter((node) => canReadCardinal(doc, node.id, who.agent)).flatMap((node) => {
          const name = cardinalFileOf(doc, node.id);
          if (name === undefined) return [];
          const stored = readAtSafe(placeOf(name, index).file);
          const envelope = stored ? envelopeOf(stored.text) : undefined;
          return [{ id: node.id, name, exists: stored !== undefined, rev: stored?.rev ?? null, version: envelope?.version ?? null, diagrams: envelope?.diagrams ?? 0 }];
        });
        return send(OK_STATUS, { rev: doc.rev, nodes });
      }
      // fora do escopo responde como inexistente: nó que não existe, de outro tipo ou que o agente não alcança são o mesmo 404
      const name = cardinalFileOf(doc, nodeId);
      if (name === undefined || !canReadCardinal(doc, nodeId, who.agent)) return notFound();
      const place = placeOf(name, index);
      const stored = readAt(place.file);
      if (!stored) return refusal(NOT_FOUND_STATUS, CARDINAL_ROUTE_ERRORS.notFound, { name });
      return send(OK_STATUS, view(name, place, stored));
    } catch (error) {
      return failure(error);
    }
  }

  function readAtSafe(file: string): Stored | undefined {
    try {
      return readAt(file);
    } catch (error) {
      if (error instanceof Unreadable || error instanceof TooLarge) return undefined;
      throw error;
    }
  }

  function envelopeOf(text: string): CardinalEnvelope | undefined {
    try {
      return readEnvelope(text);
    } catch (error) {
      if (error instanceof CardinalError) return undefined;
      throw error;
    }
  }

  async function put(canvasId: string, nodeId: string, req: Request, caller: CardinalCaller): Promise<Response> {
    if (!isValidCanvasId(canvasId)) return notFound();
    const raw = await readBody(req, CARDINAL_BODY_BYTES);
    if (!raw) return refusal(TOO_LARGE_STATUS, CARDINAL_ROUTE_ERRORS.tooLarge);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return refusal(INVALID_STATUS, CARDINAL_ROUTE_ERRORS.invalidBody);
    }
    if (!isDict(body) || typeof body.text !== "string" || !(body.rev === null || typeof body.rev === "string")) return refusal(INVALID_STATUS, CARDINAL_ROUTE_ERRORS.invalidBody);
    const bytes = new TextEncoder().encode(body.text);
    if (bytes.length > CARDINAL_LIMITS.bodyBytes) return refusal(TOO_LARGE_STATUS, CARDINAL_ROUTE_ERRORS.tooLarge);
    let writer: NoteWriter = OWNER;
    if (body.as !== undefined) {
      if (!isDict(body.as)) return refusal(INVALID_STATUS, CARDINAL_ROUTE_ERRORS.invalidBody);
      const who = agentOf(body.as.agent, caller);
      if (who instanceof Response) return who;
      if (who.agent !== undefined) writer = { kind: "agent", id: who.agent };
    }
    const doc = await deps.loadDoc(canvasId);
    // a decisão de acesso vem antes de qualquer leitura do arquivo; fora do escopo é 404, igual a nó que não existe
    if (!doc || !canWriteCardinal(doc, nodeId, writer)) return notFound();
    const name = cardinalFileOf(doc, nodeId) as string;
    try {
      requireWritableEnvelope(body.text);
      // Leitura, conferência da revisão e gravação sem await no meio: o laço de eventos não deixa outro PUT intercalar.
      const place = placeOf(name, loadIndex());
      const current = readAt(place.file);
      if ((current?.rev ?? null) !== body.rev) return refusal(CONFLICT_STATUS, CARDINAL_ROUTE_ERRORS.staleRevision, { rev: current?.rev ?? null });
      storeAt(place, bytes);
      const rev = revisionOf(bytes);
      deps.onWrite?.(name, rev);
      log("info", "diagrama gravado", { canvas: canvasId, node: nodeId, name, bytes: bytes.length, by: writer.kind, remote: caller.remote });
      return send(OK_STATUS, { ok: true, name, rev, bytes: bytes.length });
    } catch (error) {
      return failure(error);
    }
  }

  // ---- adoção ----

  /** Aponta para um arquivo de fora sem movê-lo; apontar de novo para o mesmo arquivo devolve o mesmo nome. */
  async function link(req: Request, caller: CardinalCaller): Promise<Response> {
    try {
      if (caller.remote) throw new Refused(FORBIDDEN_STATUS, CARDINAL_ROUTE_ERRORS.localOnly);
      const raw = await readBody(req, SMALL_BODY_BYTES);
      if (!raw) throw new Refused(TOO_LARGE_STATUS, CARDINAL_ROUTE_ERRORS.tooLarge);
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        throw new Refused(INVALID_STATUS, CARDINAL_ROUTE_ERRORS.invalidBody);
      }
      if (!isDict(body) || typeof body.path !== "string") throw new Refused(INVALID_STATUS, CARDINAL_ROUTE_ERRORS.invalidBody);
      const path = checkCustomPath(body.path);
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(path);
      } catch {
        throw new Refused(NOT_FOUND_STATUS, CARDINAL_ROUTE_ERRORS.notFound);
      }
      // `lstat` não segue link simbólico: arquivo que é link não passa
      if (!info.isFile()) throw new Refused(INVALID_STATUS, CARDINAL_ROUTE_ERRORS.invalidPath);
      if (info.size > CARDINAL_LIMITS.bodyBytes) throw new Refused(TOO_LARGE_STATUS, CARDINAL_ROUTE_ERRORS.tooLarge);
      const stored = readAt(path);
      if (stored) readEnvelope(stored.text);
      const index = loadIndex();
      const known = Object.entries(index).find(([, indexed]) => indexed === path);
      if (known) return send(OK_STATUS, { ok: true, name: known[0], path, created: false });
      for (let attempt = 0; attempt < 8; attempt++) {
        const value = token();
        if (!/^[a-z0-9]{6,32}$/.test(value)) throw new Error("token de diagrama inválido");
        const name = adoptedNameOf(value);
        if (index[name] || existsSync(defaultPathOf(name))) continue;
        index[name] = path;
        saveIndex(index);
        log("info", "diagrama adotado", { name, remote: caller.remote });
        return send(OK_STATUS, { ok: true, name, path, created: true });
      }
      throw new Refused(CONFLICT_STATUS, CARDINAL_ROUTE_ERRORS.exists);
    } catch (error) {
      return failure(error);
    }
  }

  function files(): CardinalFileRef[] {
    let index: Record<string, string> = {};
    try {
      index = loadIndex();
    } catch {
      index = {};
    }
    const names = new Set(Object.keys(index));
    if (existsSync(folder)) {
      for (const entry of readdirSync(folder)) {
        const name = entry.endsWith(EXT) ? entry.slice(0, -EXT.length) : "";
        if (isCardinalName(name) && index[name] === undefined) names.add(name);
      }
    }
    return [...names].sort().flatMap((name) => {
      try {
        return [{ name, file: placeOf(name, index).file }];
      } catch {
        return [];
      }
    });
  }

  return {
    get(path, query, caller) {
      const parts = segments(path);
      if (!parts || parts.length === 0 || parts.length > 2 || parts.some((part) => part === "")) return undefined;
      const [canvasId, nodeId] = parts as [string, string | undefined];
      return read(canvasId, nodeId, query, caller);
    },

    write(path, req, caller) {
      const parts = segments(path);
      if (!parts) return undefined;
      if (req.method !== "PUT") return Promise.resolve(send(NOT_FOUND_STATUS, { error: "not found" }));
      if (parts.length !== 2 || parts.some((part) => part === "")) return Promise.resolve(notFound());
      return put(parts[0] as string, parts[1] as string, req, caller);
    },

    list(query) {
      const limitRaw = query.limit ?? String(CARDINAL_LIST_LIMITS.fallback);
      const limit = /^\d{1,4}$/.test(limitRaw) ? Number(limitRaw) : Number.NaN;
      // pedido acima do teto é recusado, não atendido pela metade
      if (!(limit >= 1 && limit <= CARDINAL_LIST_LIMITS.max)) return refusal(INVALID_STATUS, CARDINAL_ROUTE_ERRORS.invalidQuery);
      const after = query.after;
      if (after !== undefined && !isCardinalName(after)) return refusal(INVALID_STATUS, CARDINAL_ROUTE_ERRORS.invalidQuery);
      try {
        const index = loadIndex();
        const sorted = files().filter((ref) => after === undefined || ref.name > after);
        const page = sorted.slice(0, limit);
        const out = page.map((ref) => {
          let info: ReturnType<typeof lstatSync> | undefined;
          try {
            info = lstatSync(ref.file);
          } catch {
            info = undefined; // arquivo ainda não gravado (ou que saiu por fora)
          }
          const exists = info?.isFile() === true;
          return {
            name: ref.name, location: index[ref.name] === undefined ? "default" : "custom", path: index[ref.name] ?? null,
            exists, bytes: exists ? info?.size ?? 0 : 0, updatedAt: exists ? info?.mtime.toISOString() ?? null : null,
          };
        });
        return send(OK_STATUS, { files: out, next: sorted.length > limit ? page[page.length - 1]?.name ?? null : null });
      } catch (error) {
        return failure(error);
      }
    },

    action(path, req, caller) {
      const parts = segments(path);
      if (!parts) return undefined;
      if (req.method !== "POST" || parts.length !== 1 || parts[0] !== "link") return Promise.resolve(send(NOT_FOUND_STATUS, { error: "not found" }));
      return link(req, caller);
    },

    files,
  };
}
