// Rotas das notas do canvas (reference/argos.md §Notas e texto livre): cada nota é um arquivo `.md` em `$D/canvas-notes/`
// (fora do repositório). GET lê, PUT grava (atômico, com revisão contra escrita concorrente). O dono escreve em qualquer
// nota; o agente só na nota a que o documento o liga, e só no painel local. A chave e o token da sessão são conferidos pelo
// servidor antes de chegar aqui; este módulo decide o que cada chamador pode.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { type CanvasDoc } from "../lib/canvas-doc.ts";
import {
  assetDirOf, canWriteNote, isAssetFile, isNoteFileName, isNoteName, NOTE_ERRORS, NOTE_FILE_LIMITS, NOTE_IMAGE_MIME, NOTE_LIMITS, NoteError, noteFileOf,
  noteTitle, type NoteWriter, OWNER, readNoteTitle, requireWriterId, sniffImage, imageMarkdown,
} from "../lib/canvas-note.ts";
import { isValidCanvasId } from "../lib/canvas-store.ts";
import { send } from "./http.ts";
import { log } from "./log.ts";

const FOLDER = "canvas-notes";
const EXT = ".md";
const BASE = "/api/canvas-notes/";
const FILE_MODE = 0o600;
const REV_CHARS = 16;
const OK_STATUS = 200;
const INVALID_STATUS = 400;
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const CONFLICT_STATUS = 409;
const TOO_LARGE_STATUS = 413;
const LOCKED_STATUS = 423;
const UNREADABLE_STATUS = 500;
/** Cabe o corpo máximo da nota e o envelope; mais que isso nem é lido (teto próprio da rota, bem acima dos 64 KiB dos demais POST). */
export const NOTE_BODY_BYTES = 2 * NOTE_LIMITS.bodyBytes;
/** Imagem em base64 (4/3 do tamanho) e o envelope: teto próprio do POST de imagem. */
export const NOTE_IMAGE_BODY_BYTES = Math.ceil((NOTE_FILE_LIMITS.imageBytes * 4) / 3) + 4096;
/** Os outros POST da família (bloquear, renomear, mover, apagar, apontar) levam só um campo curto. */
const SMALL_BODY_BYTES = 16 * 1024;
/** Índice das notas: local personalizado, bloqueio e nome fixado. Arquivo oculto na pasta padrão (a listagem o ignora). */
const INDEX_FILE = ".index.json";
const INDEX_VERSION = 1;
export const NOTE_LIST_LIMITS = { fallback: 50, max: 200 } as const;
/** Quanto do começo do arquivo a listagem lê para o nome automático (a primeira linha com conteúdo). */
const TITLE_PEEK_BYTES = 4096;
const ASSET_CACHE = "private, max-age=86400, immutable";
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Códigos estáveis da rota: só ganham valores. `note_too_large` e `note_invalid_name` são os mesmos de `canvas-note.ts`. */
export const NOTE_ROUTE_ERRORS = {
  invalidName: NOTE_ERRORS.invalidName,
  tooLarge: NOTE_ERRORS.tooLarge,
  invalidBody: "note_invalid_body",
  notFound: "note_not_found",
  staleRevision: "note_stale_revision",
  agentLocalOnly: "note_agent_local_only",
  unreadable: "note_unreadable",
  locked: "note_locked",
  localOnly: "note_local_only",
  invalidPath: "note_invalid_path",
  exists: "note_exists",
  invalidImage: NOTE_ERRORS.invalidImage,
  tooManyImages: "note_too_many_images",
  invalidTitle: NOTE_ERRORS.invalidTitle,
  invalidQuery: "note_invalid_query",
} as const;
type NoteRouteErrorCode = (typeof NOTE_ROUTE_ERRORS)[keyof typeof NOTE_ROUTE_ERRORS];

export interface NoteCaller {
  remote: boolean;
}

export interface NoteRoutes {
  /** `GET /api/canvas-notes/<nome>` e `GET /api/canvas-notes/<nome>/assets/<arquivo>`; `undefined` se o caminho não é desta família. */
  get(path: string): Response | undefined;
  /** `PUT /api/canvas-notes/<nome>`; `undefined` se o caminho não é desta família. */
  write(path: string, req: Request, caller: NoteCaller): Promise<Response> | undefined;
  /** `GET /api/canvas-notes?limit=&after=`: as notas conhecidas, por nome, em páginas. */
  list(query: Readonly<Record<string, string>>): Response;
  /** `POST /api/canvas-notes/<nome>/{lock,rename,move,images,delete}` e `POST /api/canvas-notes/link`; `undefined` fora da família. */
  action(path: string, req: Request, caller: NoteCaller): Promise<Response> | undefined;
}

export interface NoteDeps {
  /** O documento do canvas `id` (o que `GET /api/canvases/<id>` devolve), ou `undefined` se não existe ou não abre. */
  loadDoc(canvasId: string): Promise<CanvasDoc | undefined>;
  /** Pastas onde uma nota pode morar fora da pasta padrão ("Mover para…", arrastar de fora). Padrão: a pasta pessoal. */
  roots?: readonly string[];
  /** Pedaço aleatório do nome de uma nota que aponta para arquivo de fora (minúsculas e números); injetado no teste. */
  token?: () => string;
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

const refusal = (status: number, code: NoteRouteErrorCode, extra: Dict = {}): Response => send(status, { error: `nota recusada (${code})`, code, ...extra });

/** Revisão = hash do conteúdo: qualquer mudança no arquivo (inclusive por fora da rota) muda a revisão. */
const revisionOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, REV_CHARS);

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
}

/** O que o índice guarda de uma nota; nota sem nada disso nem aparece no índice. */
interface NoteMeta {
  /** Caminho absoluto do arquivo, quando a nota mora fora da pasta padrão. */
  path?: string;
  locked?: boolean;
  title?: string;
}

/** Onde a nota está agora: o arquivo, a pasta dele e o nome sem extensão (que dá nome à pasta das imagens). */
interface Place {
  file: string;
  dir: string;
  base: string;
  custom: boolean;
}

class Unreadable extends Error {}
class TooLarge extends Error {}
/** Recusa com código da rota (caminho fora das raízes, destino que já existe…), levada até a resposta. */
class Refused extends Error {
  readonly status: number;
  readonly code: NoteRouteErrorCode;
  constructor(status: number, code: NoteRouteErrorCode) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const defaultToken = (): string => randomBytes(6).toString("hex");

export function createCanvasNotesRoutes(dir: string, deps: NoteDeps): NoteRoutes {
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

  // ---- índice ----

  function loadIndex(): Record<string, NoteMeta> {
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
    if (!isDict(parsed) || parsed.v !== INDEX_VERSION || !isDict(parsed.notes)) throw new Unreadable("índice fora do formato");
    const out: Record<string, NoteMeta> = {};
    for (const [name, value] of Object.entries(parsed.notes)) {
      if (!isNoteName(name) || !isDict(value)) throw new Unreadable("índice com entrada inválida");
      const meta: NoteMeta = {};
      if (typeof value.path === "string" && isAbsolute(value.path)) meta.path = value.path;
      if (value.locked === true) meta.locked = true;
      if (typeof value.title === "string" && value.title !== "") meta.title = value.title;
      out[name] = meta;
    }
    return out;
  }

  function saveIndex(index: Record<string, NoteMeta>): void {
    const notes: Record<string, NoteMeta> = {};
    for (const [name, meta] of Object.entries(index)) if (meta.path || meta.locked || meta.title) notes[name] = meta;
    mkdirSync(folder, { recursive: true });
    const tmp = `${indexPath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ v: INDEX_VERSION, notes }, null, 2), { mode: FILE_MODE });
      renameSync(tmp, indexPath);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  /** Muda a entrada `name` do índice (ler, mudar e gravar sem await no meio: outro POST não intercala). */
  function patchIndex(name: string, change: (meta: NoteMeta) => NoteMeta | undefined): void {
    const index = loadIndex();
    const next = change({ ...(index[name] ?? {}) });
    if (next === undefined) delete index[name];
    else index[name] = next;
    saveIndex(index);
  }

  // ---- caminho ----

  /** Caminho de fora da pasta padrão: absoluto, de arquivo de nota, com a pasta (caminho real) dentro de uma raiz. */
  function checkCustomPath(path: string): string {
    if (!isAbsolute(path) || path.includes("\u0000") || !isNoteFileName(basename(path))) throw new Refused(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidPath);
    let realDir: string;
    try {
      realDir = realpathSync(dirname(resolve(path)));
    } catch {
      throw new Refused(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidPath);
    }
    const full = join(realDir, basename(path));
    const within = roots().some((root) => full.startsWith(root));
    // a pasta padrão tem dono: nota apontada para dentro dela confundiria o que "fechar" apaga
    if (!within || (full + sep).startsWith(folderPrefix) || full.startsWith(folderPrefix)) throw new Refused(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidPath);
    return full;
  }

  /** Caminho do arquivo na pasta padrão; o nome já passou pela lista fechada e o caminho resolvido é conferido mesmo assim. */
  function defaultPathOf(name: string): string {
    const full = resolve(folder, `${name}${EXT}`);
    if (!full.startsWith(folderPrefix)) throw new Unreadable("nome fora da pasta");
    return full;
  }

  function placeOf(name: string, meta: NoteMeta | undefined): Place {
    if (meta?.path) {
      const file = checkCustomPathForUse(meta.path);
      return { file, dir: dirname(file), base: basename(file, extname(file)), custom: true };
    }
    const file = defaultPathOf(name);
    return { file, dir: folder, base: name, custom: false };
  }

  /** O caminho guardado no índice é conferido de novo a cada uso (a raiz ou um link simbólico podem ter mudado). */
  function checkCustomPathForUse(path: string): string {
    try {
      return checkCustomPath(path);
    } catch (error) {
      if (error instanceof Refused) throw new Unreadable("local personalizado fora das raízes");
      throw error;
    }
  }

  // ---- arquivo ----

  /** A nota gravada, `undefined` se não há arquivo. Link simbólico, não UTF-8 e acima do teto não são lidos (nunca viram vazio). */
  function readAt(file: string): Stored | undefined {
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Unreadable("arquivo não abre");
    }
    if (!info.isFile()) throw new Unreadable("não é arquivo comum");
    if (info.size > NOTE_LIMITS.bodyBytes) throw new TooLarge("nota acima do teto");
    const bytes = readFileSync(file);
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), rev: revisionOf(bytes), updatedAt: info.mtime.toISOString() };
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

  /** `/api/canvas-notes/<nome>[/<resto>]` → partes cruas; `undefined` se o caminho não é desta família. */
  function partsOf(path: string): string[] | undefined {
    return path.startsWith(BASE) ? path.slice(BASE.length).split("/") : undefined;
  }

  function failure(error: unknown): Response {
    if (error instanceof Refused) return refusal(error.status, error.code);
    if (error instanceof NoteError) return refusal(INVALID_STATUS, error.code === NOTE_ERRORS.invalidTitle ? NOTE_ROUTE_ERRORS.invalidTitle : NOTE_ROUTE_ERRORS.invalidBody);
    if (error instanceof TooLarge) return refusal(TOO_LARGE_STATUS, NOTE_ROUTE_ERRORS.tooLarge);
    if (error instanceof Unreadable) {
      log("error", "nota ilegível", { code: NOTE_ROUTE_ERRORS.unreadable, reason: error.message });
      return refusal(UNREADABLE_STATUS, NOTE_ROUTE_ERRORS.unreadable);
    }
    throw error;
  }

  /**
   * Quem escreve: o dono por padrão; `as: { agent, canvas, node }` é o agente (nó `agent:…` ou terminal do canvas), e vale
   * só se o documento o liga àquela nota (pelo `data` da nota ou por conexão direta).
   */
  async function writerOf(as: unknown, name: string, caller: NoteCaller): Promise<NoteWriter | Response> {
    if (as === undefined) return OWNER;
    if (!isDict(as) || typeof as.canvas !== "string" || typeof as.node !== "string") return refusal(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidBody);
    let agent: string;
    try {
      agent = requireWriterId(as.agent);
    } catch {
      return refusal(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidBody);
    }
    // sem credencial por agente, a identidade declarada só se aceita onde os agentes rodam: na máquina do painel
    if (caller.remote) return refusal(FORBIDDEN_STATUS, NOTE_ROUTE_ERRORS.agentLocalOnly);
    const doc = isValidCanvasId(as.canvas) ? await deps.loadDoc(as.canvas) : undefined;
    const writer: NoteWriter = { kind: "agent", id: agent };
    // fora do escopo responde como inexistente: nó que não existe, que é de outra nota ou ligado a outro agente são o mesmo 404
    const linked = doc !== undefined && canWriteNote(doc, as.node, writer) && noteFileOf(doc, as.node) === name;
    return linked ? writer : refusal(NOT_FOUND_STATUS, NOTE_ROUTE_ERRORS.notFound);
  }

  async function put(name: string, req: Request, caller: NoteCaller): Promise<Response> {
    const raw = await readBody(req, NOTE_BODY_BYTES);
    if (!raw) return refusal(TOO_LARGE_STATUS, NOTE_ROUTE_ERRORS.tooLarge);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return refusal(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidBody);
    }
    if (!isDict(body) || typeof body.text !== "string" || !(body.rev === null || typeof body.rev === "string")) return refusal(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidBody);
    const bytes = new TextEncoder().encode(body.text);
    if (bytes.length > NOTE_LIMITS.bodyBytes) return refusal(TOO_LARGE_STATUS, NOTE_ROUTE_ERRORS.tooLarge);
    const writer = await writerOf(body.as, name, caller);
    if (writer instanceof Response) return writer;
    // Leitura, conferência da revisão e gravação sem await no meio: o laço de eventos não deixa outro PUT intercalar.
    try {
      const meta = loadIndex()[name];
      // bloqueada: o dono desbloqueia antes; o agente ligado continua lendo, mas não escreve
      if (meta?.locked) return refusal(LOCKED_STATUS, NOTE_ROUTE_ERRORS.locked);
      const place = placeOf(name, meta);
      const current = readAt(place.file);
      if ((current?.rev ?? null) !== body.rev) return refusal(CONFLICT_STATUS, NOTE_ROUTE_ERRORS.staleRevision, { rev: current?.rev ?? null });
      storeAt(place, bytes);
      const rev = revisionOf(bytes);
      log("info", "nota gravada", { note: name, bytes: bytes.length, writer: writer.kind, remote: caller.remote });
      return send(OK_STATUS, { ok: true, name, rev, bytes: bytes.length });
    } catch (error) {
      return failure(error);
    }
  }

  // ---- ações (POST) ----

  async function jsonBody(req: Request, max: number): Promise<Dict> {
    const raw = await readBody(req, max);
    if (!raw) throw new Refused(TOO_LARGE_STATUS, NOTE_ROUTE_ERRORS.tooLarge);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new Refused(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidBody);
    }
    if (!isDict(body)) throw new Refused(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidBody);
    return body;
  }

  const audit = (action: string, name: string, caller: NoteCaller, extra: Dict = {}): void => log("info", "nota alterada", { action, note: name, remote: caller.remote, ...extra });

  function setLock(name: string, body: Dict, caller: NoteCaller): Response {
    if (typeof body.locked !== "boolean") throw new Refused(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidBody);
    const locked = body.locked;
    patchIndex(name, (meta) => ({ ...meta, locked: locked || undefined }));
    audit(locked ? "lock" : "unlock", name, caller);
    return send(OK_STATUS, { ok: true, name, locked });
  }

  function rename(name: string, body: Dict, caller: NoteCaller): Response {
    const title = readNoteTitle(body.title);
    patchIndex(name, (meta) => ({ ...meta, title: title ?? undefined }));
    audit("rename", name, caller);
    return send(OK_STATUS, { ok: true, name, title });
  }

  /** Arquivo e pasta de imagens para o destino; o texto troca a pasta das imagens se o nome do arquivo mudou. */
  function move(name: string, body: Dict, caller: NoteCaller): Response {
    if (caller.remote) throw new Refused(FORBIDDEN_STATUS, NOTE_ROUTE_ERRORS.localOnly);
    if (!(body.to === null || typeof body.to === "string")) throw new Refused(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidBody);
    const index = loadIndex();
    const from = placeOf(name, index[name]);
    const target = body.to === null ? defaultPathOf(name) : checkCustomPath(body.to);
    if (target === from.file) return send(OK_STATUS, { ok: true, name, location: from.custom ? "custom" : "default", path: from.custom ? from.file : null });
    if (existsSync(target)) throw new Refused(CONFLICT_STATUS, NOTE_ROUTE_ERRORS.exists);
    const to: Place = body.to === null ? { file: target, dir: folder, base: name, custom: false } : { file: target, dir: dirname(target), base: basename(target, extname(target)), custom: true };
    const fromAssets = join(from.dir, assetDirOf(from.base));
    const toAssets = join(to.dir, assetDirOf(to.base));
    const hasAssets = existsSync(fromAssets);
    if (hasAssets && existsSync(toAssets)) throw new Refused(CONFLICT_STATUS, NOTE_ROUTE_ERRORS.exists);
    const current = readAt(from.file);
    if (current) {
      const text = from.base === to.base ? current.text : current.text.split(`](${assetDirOf(from.base)}/`).join(`](${assetDirOf(to.base)}/`);
      if (!to.custom) mkdirSync(folder, { recursive: true });
      // cria sem sobrescrever (wx): entre a conferência e a escrita outro processo pode ter criado o destino
      writeFileSync(to.file, text, { flag: "wx", mode: FILE_MODE });
    }
    if (hasAssets) {
      cpSync(fromAssets, toAssets, { recursive: true, errorOnExist: true, force: false });
      rmSync(fromAssets, { recursive: true, force: true });
    }
    if (current) rmSync(from.file, { force: true });
    patchIndex(name, (meta) => ({ ...meta, path: to.custom ? to.file : undefined }));
    audit("move", name, caller, { location: to.custom ? "custom" : "default" });
    return send(OK_STATUS, { ok: true, name, location: to.custom ? "custom" : "default", path: to.custom ? to.file : null });
  }

  function addImage(name: string, body: Dict, caller: NoteCaller): Response {
    if (typeof body.data !== "string" || !BASE64.test(body.data)) throw new Refused(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidImage);
    const bytes = Buffer.from(body.data, "base64");
    if (bytes.length > NOTE_FILE_LIMITS.imageBytes) throw new Refused(TOO_LARGE_STATUS, NOTE_ROUTE_ERRORS.tooLarge);
    const ext = sniffImage(bytes);
    if (ext === undefined) throw new Refused(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidImage);
    const meta = loadIndex()[name];
    if (meta?.locked) throw new Refused(LOCKED_STATUS, NOTE_ROUTE_ERRORS.locked);
    const place = placeOf(name, meta);
    const assets = join(place.dir, assetDirOf(place.base));
    const file = `${createHash("sha256").update(bytes).digest("hex").slice(0, REV_CHARS)}.${ext}`;
    const target = join(assets, file);
    if (!existsSync(target)) {
      const count = existsSync(assets) ? readdirSync(assets).filter(isAssetFile).length : 0;
      if (count >= NOTE_FILE_LIMITS.imagesPerNote) throw new Refused(CONFLICT_STATUS, NOTE_ROUTE_ERRORS.tooManyImages);
      mkdirSync(assets, { recursive: true });
      writeFileSync(target, bytes, { mode: FILE_MODE });
      audit("image", name, caller, { bytes: bytes.length });
    }
    return send(OK_STATUS, { ok: true, name, file, markdown: imageMarkdown(place.base, file) });
  }

  /** Fechar: arquivo e imagens da pasta padrão saem; o de local personalizado fica onde está. A entrada do índice sai. */
  function remove(name: string, caller: NoteCaller): Response {
    const index = loadIndex();
    const meta = index[name];
    let deleted = false;
    if (!meta?.path) {
      const file = defaultPathOf(name);
      deleted = existsSync(file);
      rmSync(file, { force: true });
      rmSync(join(folder, assetDirOf(name)), { recursive: true, force: true });
    }
    if (meta) {
      delete index[name];
      saveIndex(index);
    }
    audit("delete", name, caller, { deleted });
    return send(OK_STATUS, { ok: true, name, deleted });
  }

  /** Nota que aponta para um arquivo de fora, sem mover o original; apontar de novo para o mesmo arquivo devolve a mesma nota. */
  function link(body: Dict, caller: NoteCaller): Response {
    if (caller.remote) throw new Refused(FORBIDDEN_STATUS, NOTE_ROUTE_ERRORS.localOnly);
    if (typeof body.path !== "string") throw new Refused(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidBody);
    const path = checkCustomPath(body.path);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(path);
    } catch {
      throw new Refused(NOT_FOUND_STATUS, NOTE_ROUTE_ERRORS.notFound);
    }
    if (!info.isFile()) throw new Refused(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidPath);
    if (info.size > NOTE_LIMITS.bodyBytes) throw new Refused(TOO_LARGE_STATUS, NOTE_ROUTE_ERRORS.tooLarge);
    const index = loadIndex();
    const known = Object.entries(index).find(([, meta]) => meta.path === path);
    if (known) return send(OK_STATUS, { ok: true, name: known[0], path, created: false });
    for (let attempt = 0; attempt < 8; attempt++) {
      const value = token();
      if (!/^[a-z0-9]{6,32}$/.test(value)) throw new Error("token de nota inválido");
      const name = `nota-${value}`;
      if (index[name] || existsSync(defaultPathOf(name))) continue;
      index[name] = { path };
      saveIndex(index);
      audit("link", name, caller);
      return send(OK_STATUS, { ok: true, name, path, created: true });
    }
    throw new Refused(CONFLICT_STATUS, NOTE_ROUTE_ERRORS.exists);
  }

  async function act(parts: string[], req: Request, caller: NoteCaller): Promise<Response> {
    try {
      if (parts.length === 1 && parts[0] === "link") return link(await jsonBody(req, SMALL_BODY_BYTES), caller);
      const [name, verb] = parts;
      // POST na própria nota (sem ação) não existe: gravar é PUT
      if (parts.length !== 2) return send(NOT_FOUND_STATUS, { error: "not found" });
      if (name === undefined || !isNoteName(name)) return refusal(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidName);
      switch (verb) {
        case "lock":
          return setLock(name, await jsonBody(req, SMALL_BODY_BYTES), caller);
        case "rename":
          return rename(name, await jsonBody(req, SMALL_BODY_BYTES), caller);
        case "move":
          return move(name, await jsonBody(req, SMALL_BODY_BYTES), caller);
        case "images":
          return addImage(name, await jsonBody(req, NOTE_IMAGE_BODY_BYTES), caller);
        case "delete":
          await jsonBody(req, SMALL_BODY_BYTES);
          return remove(name, caller);
        default:
          return send(NOT_FOUND_STATUS, { error: "not found" });
      }
    } catch (error) {
      return failure(error);
    }
  }

  // ---- leitura ----

  function noteResponse(name: string): Response {
    const meta = loadIndex()[name];
    const place = placeOf(name, meta);
    const stored = readAt(place.file);
    if (!stored) return refusal(NOT_FOUND_STATUS, NOTE_ROUTE_ERRORS.notFound, { locked: meta?.locked === true, title: meta?.title ?? null });
    return send(OK_STATUS, {
      name, text: stored.text, rev: stored.rev, updatedAt: stored.updatedAt,
      locked: meta?.locked === true, title: meta?.title ?? null, location: place.custom ? "custom" : "default", path: place.custom ? place.file : null, base: place.base,
    });
  }

  function assetResponse(name: string, file: string): Response {
    if (!isAssetFile(file)) return refusal(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidName);
    const place = placeOf(name, loadIndex()[name]);
    const full = join(place.dir, assetDirOf(place.base), file);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(full);
    } catch {
      return refusal(NOT_FOUND_STATUS, NOTE_ROUTE_ERRORS.notFound);
    }
    if (!info.isFile() || info.size > NOTE_FILE_LIMITS.imageBytes) return refusal(NOT_FOUND_STATUS, NOTE_ROUTE_ERRORS.notFound);
    const bytes = readFileSync(full);
    const ext = sniffImage(bytes);
    // o tipo servido é o dos bytes, nunca o da extensão; o nosniff impede o navegador de adivinhar outro
    if (ext === undefined) return refusal(NOT_FOUND_STATUS, NOTE_ROUTE_ERRORS.notFound);
    return new Response(bytes, { status: OK_STATUS, headers: { "Content-Type": NOTE_IMAGE_MIME[ext], "Cache-Control": ASSET_CACHE, "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" } });
  }

  /** Começo do arquivo, para o nome automático; arquivo que não abre dá `""` (a listagem não cai por uma nota). */
  function peek(file: string): string {
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const buffer = Buffer.alloc(TITLE_PEEK_BYTES);
      const n = readSync(fd, buffer, 0, TITLE_PEEK_BYTES, 0);
      return new TextDecoder("utf-8").decode(buffer.subarray(0, n));
    } catch (error) {
      log("warn", "nota sem prévia na listagem", { reason: error instanceof Error ? error.message : String(error) });
      return "";
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  return {
    get(path) {
      const parts = partsOf(path);
      if (parts === undefined) return undefined;
      const [name, kind, file] = parts;
      if (name === undefined || !isNoteName(name)) return refusal(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidName);
      try {
        if (parts.length === 1) return noteResponse(name);
        if (parts.length === 3 && kind === "assets" && file !== undefined) return assetResponse(name, file);
        return refusal(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidName);
      } catch (error) {
        return failure(error);
      }
    },

    write(path, req, caller) {
      const parts = partsOf(path);
      if (parts === undefined) return undefined;
      if (req.method !== "PUT") return Promise.resolve(send(NOT_FOUND_STATUS, { error: "not found" }));
      const [name] = parts;
      if (parts.length !== 1 || name === undefined || !isNoteName(name)) return Promise.resolve(refusal(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidName));
      return put(name, req, caller);
    },

    list(query) {
      const limitRaw = query.limit ?? String(NOTE_LIST_LIMITS.fallback);
      const limit = /^\d{1,4}$/.test(limitRaw) ? Number(limitRaw) : Number.NaN;
      // pedido acima do teto é recusado, não atendido pela metade
      if (!(limit >= 1 && limit <= NOTE_LIST_LIMITS.max)) return refusal(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidQuery);
      const after = query.after;
      if (after !== undefined && !isNoteName(after)) return refusal(INVALID_STATUS, NOTE_ROUTE_ERRORS.invalidQuery);
      try {
        const index = loadIndex();
        const names = new Set(Object.keys(index));
        if (existsSync(folder)) {
          for (const entry of readdirSync(folder)) {
            const name = entry.endsWith(EXT) ? entry.slice(0, -EXT.length) : "";
            if (isNoteName(name) && !index[name]?.path) names.add(name);
          }
        }
        const sorted = [...names].sort().filter((name) => after === undefined || name > after);
        const page = sorted.slice(0, limit);
        const notes = page.map((name) => {
          const meta = index[name];
          let file: string | undefined;
          try {
            file = placeOf(name, meta).file;
          } catch (error) {
            if (!(error instanceof Unreadable)) throw error;
          }
          let info: ReturnType<typeof lstatSync> | undefined;
          try {
            info = file ? lstatSync(file) : undefined;
          } catch {
            info = undefined; // arquivo ainda não gravado (ou que saiu por fora): a nota aparece sem tamanho
          }
          const exists = info?.isFile() === true;
          return {
            name, title: meta?.title ?? (exists && file ? noteTitle(peek(file)) : ""), titleFixed: meta?.title !== undefined, locked: meta?.locked === true,
            location: meta?.path ? "custom" : "default", path: meta?.path ?? null, exists, bytes: exists ? info?.size ?? 0 : 0,
            updatedAt: exists ? info?.mtime.toISOString() ?? null : null,
          };
        });
        return send(OK_STATUS, { notes, next: sorted.length > limit ? page[page.length - 1] ?? null : null });
      } catch (error) {
        return failure(error);
      }
    },

    action(path, req, caller) {
      const parts = partsOf(path);
      if (parts === undefined) return undefined;
      if (req.method !== "POST") return Promise.resolve(send(NOT_FOUND_STATUS, { error: "not found" }));
      return act(parts, req, caller);
    },
  };
}
