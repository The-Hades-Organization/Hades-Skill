// Rotas do canvas (reference/argos.md §Documento do canvas e §Vários canvases e exportação): GET/PUT /api/canvas é o canvas
// padrão ($D/canvas.json, vazio v1 se não há arquivo); /api/canvases/* guarda vários, cada um em $D/canvases/<id>.json.
// Também daqui: o canvas por worktree/rodada (POST /api/canvases/_scope) e os filtros salvos da instância (GET/PUT
// /api/canvases/_filters, $D/canvas-filters.json); `_` não abre um id de canvas válido, então os dois caminhos nunca colidem
// com um canvas. Gravação atômica (tmp + rename). A chave e o token da sessão são conferidos pelo servidor antes de chegar aqui.
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  CANVAS_ERRORS,
  CANVAS_LIMITS,
  CANVAS_VERSION,
  CanvasError,
  type CanvasErrorCode,
  type CanvasDoc,
  emptyCanvasDoc,
  isMassUserRemoval,
  parseCanvasText,
  readCanvasDoc,
  type Removals,
  removalsBetween,
  userRemovals,
} from "../lib/canvas-doc.ts";
import { CANVAS_EXPORT_ENVELOPE_BYTES, CanvasExportError, exportCanvas, parseCanvasExport } from "../lib/canvas-export.ts";
import {
  CANVAS_STORE_ERRORS,
  CANVAS_STORE_LIMITS,
  CanvasStoreError,
  type CanvasScope,
  DEFAULT_CANVAS_ID,
  DEFAULT_CANVAS_NAME,
  freshCanvasId,
  isValidCanvasId,
  requireCanvasId,
  requireCanvasName,
  requireCanvasScope,
  sameScope,
  scopedCanvasId,
  scopedCanvasName,
  type CanvasStoreErrorCode,
} from "../lib/canvas-store.ts";
import {
  emptySavedFilters,
  readSavedFilters,
  SAVED_FILTER_ERRORS,
  SavedFilterError,
  type SavedFilterErrorCode,
  type SavedFilterSet,
} from "../lib/canvas-saved-filters.ts";
import { readText } from "../lib/fs.ts";
import { send } from "./http.ts";
import { log } from "./log.ts";

const FILE = "canvas.json";
const FOLDER = "canvases";
const EXT = ".json";
const BASE = "/api/canvases";
const SCOPE_SEGMENT = "_scope";
const FILTERS_SEGMENT = "_filters";
const FILTERS_FILE = "canvas-filters.json";
/** Corpo do conjunto de filtros salvos: 50 filtros de poucos valores cabem folgados. */
const FILTERS_BODY_BYTES = 64 * 1024;
/** Códigos próprios dos filtros salvos que não vêm do módulo puro (corpo e arquivo, como no documento). */
const FILTERS_ERRORS = { stale: "saved_filters_stale_revision", unreadable: "saved_filters_unreadable" } as const;
const OK_STATUS = 200;
const CREATED_STATUS = 201;
const INVALID_STATUS = 400;
const NOT_FOUND_STATUS = 404;
const CONFLICT_STATUS = 409;
const UNPROCESSABLE_STATUS = 422;
const UNREADABLE_STATUS = 500;
/** Cabeçalhos aditivos do PUT: quem grava diz a causa e o tamanho do grafo lido (vão para o diário) e confirma a remoção em massa. */
const CAUSE_HEADER = "x-canvas-cause";
const GRAPH_SIZE_HEADER = "x-canvas-graph-size";
const CONFIRM_REMOVAL_HEADER = "x-canvas-confirm-removal";
/** Causas que o cliente pode declarar (lista fechada); fora dela vale `unknown`. */
const REMOVAL_CAUSES = ["user", "graph", "undo", "rebase"] as const;
const CAUSE_UNKNOWN = "unknown";
const CAUSE_GRAPH = "graph";
/** Pasta (em `$D`) das versões sobrescritas por gravação que tirou nó do usuário, e quantas ficam por canvas. */
const TRASH_FOLDER = "canvas-trash";
const TRASH_KEEP = 20;
/** Quantos ids de nó removido vão para o diário (o resto vira só a contagem). */
const LOGGED_IDS = 20;
/** Corpo de criar e renomear: só um nome (e um id); bem abaixo do teto do documento. */
const SMALL_BODY_BYTES = 4096;

export interface CanvasCaller {
  remote: boolean;
}

/** Ganchos opcionais da rota (o painel liga o empurrão do canvas aqui; sem eles a rota é a de sempre). */
export interface CanvasHooks {
  /** O canvas `id` foi gravado em disco, agora na revisão `rev` (gravação do documento, criação, importação, nome). */
  onWrite?: (id: string, rev: number) => void;
}

/** O par sessão/pane do herdr de um nó `terminal` de algum canvas. */
export interface CanvasTerminalPane {
  session: string;
  pane: string;
}

export interface CanvasRoutes {
  get(): Response;
  /** Os terminais que algum canvas tem como nó (para achar o terminal registrado que ficou fora de todos); canvas ilegível é pulado. */
  terminalPanes(): CanvasTerminalPane[];
  put(req: Request, caller: CanvasCaller): Promise<Response>;
  /** GET de `/api/canvases` (lista), `/api/canvases/<id>`, `/api/canvases/<id>/export` e `/api/canvases/_filters`; `undefined` se o caminho não é daqui. */
  getMany(path: string): Response | undefined;
  /** POST/PUT de `/api/canvases…` (criar, gravar, renomear, apagar, importar, abrir por escopo, gravar filtros salvos); `undefined` se o caminho não é daqui. */
  writeMany(method: "POST" | "PUT", path: string, query: Record<string, string>, req: Request, caller: CanvasCaller): Promise<Response> | undefined;
}

/** O arquivo de filtros salvos existe mas não se lê: a rota recusa (500) em vez de tratá-lo como vazio, que o próximo PUT apagaria. */
class UnreadableFilters extends Error {}

interface StoredCanvas {
  name: string;
  doc: CanvasDoc;
  /** Só nos canvases de worktree/rodada; fica no arquivo para a lista e para conferir a chave no reencontro. */
  scope?: CanvasScope;
}

/** Mensagem genérica por código: nunca o texto interno nem o caminho do arquivo. */
function refusal(status: number, code: CanvasErrorCode | CanvasStoreErrorCode | SavedFilterErrorCode | string, extra: Record<string, unknown> = {}): Response {
  return send(status, { error: `canvas recusado (${code})`, code, ...extra });
}

const STORE_STATUS: Record<CanvasStoreErrorCode, number> = {
  [CANVAS_STORE_ERRORS.invalidId]: INVALID_STATUS,
  [CANVAS_STORE_ERRORS.invalidName]: INVALID_STATUS,
  [CANVAS_STORE_ERRORS.notFound]: NOT_FOUND_STATUS,
  [CANVAS_STORE_ERRORS.exists]: CONFLICT_STATUS,
  [CANVAS_STORE_ERRORS.defaultProtected]: INVALID_STATUS,
  [CANVAS_STORE_ERRORS.limitReached]: CONFLICT_STATUS,
  [CANVAS_STORE_ERRORS.invalidScope]: INVALID_STATUS,
};

const FILTER_STATUS: Record<SavedFilterErrorCode, number> = {
  [SAVED_FILTER_ERRORS.invalidShape]: INVALID_STATUS,
  [SAVED_FILTER_ERRORS.unsupportedVersion]: INVALID_STATUS,
  [SAVED_FILTER_ERRORS.invalidName]: INVALID_STATUS,
  [SAVED_FILTER_ERRORS.invalidSelection]: INVALID_STATUS,
  [SAVED_FILTER_ERRORS.duplicateName]: INVALID_STATUS,
  [SAVED_FILTER_ERRORS.duplicateId]: INVALID_STATUS,
  [SAVED_FILTER_ERRORS.notFound]: INVALID_STATUS,
  [SAVED_FILTER_ERRORS.limitReached]: INVALID_STATUS,
};

/** Corpo da requisição até `max` bytes; `undefined` se passa dele (sem ler o resto). */
async function readBody(req: Request, max: number = CANVAS_LIMITS.bodyBytes): Promise<Uint8Array | undefined> {
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

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

/** Causa declarada pelo cliente; sem declaração, só remoção de nó vivo (que sai pelo grafo) tem causa inferida. */
function removalCause(req: Request, removals: Removals): string {
  const declared = req.headers.get(CAUSE_HEADER);
  const known = REMOVAL_CAUSES.find((cause) => cause === declared);
  if (known) return known;
  return removals.nodes.length > 0 && userRemovals(removals).length === 0 ? CAUSE_GRAPH : CAUSE_UNKNOWN;
}

/** Tamanho do grafo que o cliente leu ao decidir a remoção; ausente ou fora de 0..100000 é `null`. */
function graphSizeOf(req: Request): number | null {
  const raw = req.headers.get(GRAPH_SIZE_HEADER);
  const size = raw === null || !/^\d{1,6}$/.test(raw) ? Number.NaN : Number(raw);
  return Number.isInteger(size) && size <= 100_000 ? size : null;
}

export function createCanvasRoutes(dir: string, now: () => Date = () => new Date(), hooks: CanvasHooks = {}): CanvasRoutes {
  const defaultPath = join(dir, FILE);
  const folder = join(dir, FOLDER);
  const folderPrefix = resolve(folder) + sep;
  const filtersPath = join(dir, FILTERS_FILE);

  /** Caminho do canvas; o id já foi validado e o caminho resolvido é conferido dentro da pasta mesmo assim. */
  function pathOf(id: string): string {
    if (id === DEFAULT_CANVAS_ID) return defaultPath;
    const full = resolve(folder, `${id}${EXT}`);
    if (!full.startsWith(folderPrefix)) throw new CanvasStoreError(CANVAS_STORE_ERRORS.invalidId, "id de canvas inválido");
    return full;
  }

  const trashFolder = join(dir, TRASH_FOLDER);

  /**
   * Guarda a versão que a gravação vai sobrescrever (só quando ela tira nó do usuário): é o que permite recuperar uma nota levada
   * por engano. Fica `TRASH_KEEP` por canvas, as mais novas. Falha ao guardar vai para o log e não impede a gravação do dono.
   */
  function keepOverwritten(id: string, overwritten: CanvasDoc): void {
    try {
      mkdirSync(trashFolder, { recursive: true });
      const name = `${id}-rev${String(overwritten.rev).padStart(10, "0")}.json`;
      const path = join(trashFolder, name);
      writeFileSync(`${path}.tmp`, JSON.stringify(overwritten));
      renameSync(`${path}.tmp`, path);
      const mine = readdirSync(trashFolder).filter((file) => file.startsWith(`${id}-rev`) && file.endsWith(EXT)).sort();
      for (const old of mine.slice(0, Math.max(0, mine.length - TRASH_KEEP))) rmSync(join(trashFolder, old), { force: true });
    } catch (error) {
      log("error", "canvas: versão sobrescrita não guardada", { canvas: id, rev: overwritten.rev, reason: error instanceof Error ? error.name : "erro" });
    }
  }

  const unreadableError = (): CanvasError => new CanvasError(CANVAS_ERRORS.unreadable, "arquivo do canvas ilegível");

  /** Canvas gravado (migrado à versão atual); `undefined` sem arquivo; arquivo ilegível lança, nunca vira vazio (o próximo PUT o apagaria). */
  function read(id: string): StoredCanvas | undefined {
    const text = readText(pathOf(id));
    if (text === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (id === DEFAULT_CANVAS_ID) return { name: DEFAULT_CANVAS_NAME, doc: readCanvasDoc(parsed) };
      if (!isDict(parsed)) throw unreadableError();
      const scope = parsed.scope === undefined ? undefined : requireCanvasScope(parsed.scope);
      // o escopo gravado tem de ser o do id do arquivo: arquivo copiado à mão para outro nome não vira o canvas de outra worktree
      if (scope && scopedCanvasId(scope) !== id) throw unreadableError();
      return { name: requireCanvasName(parsed.name), doc: readCanvasDoc(parsed.doc), ...(scope ? { scope } : {}) };
    } catch (error) {
      if (error instanceof CanvasError || error instanceof CanvasStoreError || error instanceof SyntaxError) throw unreadableError();
      throw error;
    }
  }

  /** Como `read`, mas o padrão sem arquivo é o vazio e qualquer outro id sem arquivo é `canvas_not_found`. */
  function load(id: string): StoredCanvas {
    const stored = read(id);
    if (stored) return stored;
    if (id === DEFAULT_CANVAS_ID) return { name: DEFAULT_CANVAS_NAME, doc: emptyCanvasDoc() };
    throw new CanvasStoreError(CANVAS_STORE_ERRORS.notFound, "canvas não existe");
  }

  function store(id: string, canvas: StoredCanvas): void {
    const path = pathOf(id);
    if (id !== DEFAULT_CANVAS_ID) mkdirSync(folder, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(id === DEFAULT_CANVAS_ID ? canvas.doc : { name: canvas.name, doc: canvas.doc, ...(canvas.scope ? { scope: canvas.scope } : {}) }));
    renameSync(tmp, path);
    hooks.onWrite?.(id, canvas.doc.rev);
  }

  /** Ids gravados além do padrão, em ordem; nome de arquivo fora da lista fechada (ou temporário) é ignorado. */
  function storedIds(): string[] {
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return [];
    }
    return names.filter((name) => name.endsWith(EXT) && isValidCanvasId(name.slice(0, -EXT.length))).map((name) => name.slice(0, -EXT.length)).sort();
  }

  function summary(id: string): CanvasSummary {
    const { name, doc, scope } = load(id);
    let updatedAt: string | null = null;
    try {
      updatedAt = statSync(pathOf(id)).mtime.toISOString();
    } catch {
      // padrão ainda sem arquivo: sem data
    }
    return { id, name, rev: doc.rev, nodes: doc.nodes.length, edges: doc.edges.length, updatedAt, ...(scope ? { scope } : {}) };
  }

  /** Um arquivo ilegível não derruba a lista: aparece marcado, para o dono ver e corrigir. */
  function summaryOrBroken(id: string): CanvasSummary | BrokenSummary {
    try {
      return summary(id);
    } catch (error) {
      if (!(error instanceof CanvasError) || error.code !== CANVAS_ERRORS.unreadable) throw error;
      log("error", "canvas ilegível", { canvas: id, code: error.code });
      return { id, unreadable: true };
    }
  }

  function unreadable(error: unknown): Response {
    if (!(error instanceof CanvasError) || error.code !== CANVAS_ERRORS.unreadable) throw error;
    log("error", "canvas ilegível", { code: error.code });
    return refusal(UNREADABLE_STATUS, CANVAS_ERRORS.unreadable);
  }

  /** Erro conhecido → resposta com código estável (e o motivo, só onde a entrada do dono o explica); desconhecido sobe. */
  function failure(error: unknown, withReason = false): Response {
    const reason = withReason && error instanceof Error ? { reason: error.message } : {};
    if (error instanceof CanvasStoreError) return refusal(STORE_STATUS[error.code], error.code, reason);
    if (error instanceof CanvasExportError) return refusal(INVALID_STATUS, error.code, reason);
    if (error instanceof CanvasError) return error.code === CANVAS_ERRORS.unreadable ? unreadable(error) : refusal(INVALID_STATUS, error.code, reason);
    throw error;
  }

  /** O que o diário guarda de uma gravação que tira nó ou aresta: causa, tamanhos e a revisão sobrescrita (ids só os primeiros). */
  function removalFields(canvas: string, before: CanvasDoc, after: CanvasDoc, removals: Removals, req: Request, caller: CanvasCaller): Record<string, string | number | boolean | null> {
    const user = userRemovals(removals);
    return {
      canvas,
      cause: removalCause(req, removals),
      overwritten_rev: before.rev,
      nodes_before: before.nodes.length,
      nodes_after: after.nodes.length,
      removed_nodes: removals.nodes.length,
      removed_user_nodes: user.length,
      removed_edges: removals.edges.length,
      graph_nodes: graphSizeOf(req),
      ids: removals.nodes.slice(0, LOGGED_IDS).map((node) => `${node.type}:${node.id}`).join(","),
      remote: caller.remote,
    };
  }

  /** PUT do documento inteiro de um canvas que já existe (o padrão sempre existe), com a regra de revisão de sempre. */
  async function putTo(id: string, req: Request, caller: CanvasCaller): Promise<Response> {
    const raw = await readBody(req);
    if (!raw) {
      log("warn", "canvas recusado", { canvas: id, code: CANVAS_ERRORS.tooLarge, remote: caller.remote });
      return refusal(INVALID_STATUS, CANVAS_ERRORS.tooLarge);
    }
    let incoming: CanvasDoc;
    try {
      incoming = parseCanvasText(new TextDecoder().decode(raw));
    } catch (error) {
      if (!(error instanceof CanvasError)) throw error;
      log("warn", "canvas recusado", { canvas: id, code: error.code, remote: caller.remote });
      return refusal(INVALID_STATUS, error.code);
    }
    // Leitura, conferência da revisão e gravação sem await no meio: o laço de eventos não deixa outro PUT intercalar.
    try {
      const current = load(id);
      if (incoming.rev !== current.doc.rev) {
        log("warn", "canvas recusado", { canvas: id, code: CANVAS_ERRORS.staleRevision, sent: incoming.rev, rev: current.doc.rev, remote: caller.remote });
        return refusal(CONFLICT_STATUS, CANVAS_ERRORS.staleRevision, { rev: current.doc.rev });
      }
      const removals = removalsBetween(current.doc, incoming);
      const removing = removals.nodes.length > 0 || removals.edges.length > 0;
      const detail = removing ? removalFields(id, current.doc, incoming, removals, req, caller) : undefined;
      if (detail && isMassUserRemoval(current.doc, removals) && req.headers.get(CONFIRM_REMOVAL_HEADER) !== "1") {
        log("warn", "canvas remoção recusada", { ...detail, code: CANVAS_ERRORS.massRemoval });
        return refusal(UNPROCESSABLE_STATUS, CANVAS_ERRORS.massRemoval, { removed: userRemovals(removals).length });
      }
      const saved: CanvasDoc = { ...incoming, v: CANVAS_VERSION, rev: current.doc.rev + 1 };
      if (userRemovals(removals).length > 0) keepOverwritten(id, current.doc);
      store(id, { ...current, doc: saved });
      if (detail) log("info", "canvas remoção", { ...detail, rev: saved.rev });
      log("info", "canvas gravado", { canvas: id, rev: saved.rev, nodes: saved.nodes.length, edges: saved.edges.length, remote: caller.remote });
      return send(OK_STATUS, { v: CANVAS_VERSION, ok: true, rev: saved.rev });
    } catch (error) {
      return failure(error);
    }
  }

  /** Corpo JSON pequeno (criar e renomear); objeto ou nada. */
  async function smallJson(req: Request): Promise<Dict | undefined> {
    const raw = await readBody(req, SMALL_BODY_BYTES);
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
      return isDict(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  const malformed = (): Response => refusal(INVALID_STATUS, CANVAS_ERRORS.invalidShape);

  async function create(req: Request, caller: CanvasCaller): Promise<Response> {
    const body = await smallJson(req);
    if (!body) return malformed();
    try {
      const name = requireCanvasName(body.name);
      const taken = new Set(storedIds());
      const id = body.id === undefined ? freshCanvasId(name, taken) : requireCanvasId(body.id);
      if (id === DEFAULT_CANVAS_ID || taken.has(id)) throw new CanvasStoreError(CANVAS_STORE_ERRORS.exists, "já existe canvas com esse id");
      if (taken.size >= CANVAS_STORE_LIMITS.canvases) throw new CanvasStoreError(CANVAS_STORE_ERRORS.limitReached, "limite de canvases atingido");
      store(id, { name, doc: emptyCanvasDoc() });
      log("info", "canvas criado", { canvas: id, remote: caller.remote });
      return send(CREATED_STATUS, { id, name, rev: 0 });
    } catch (error) {
      return failure(error);
    }
  }

  async function rename(id: string, req: Request, caller: CanvasCaller): Promise<Response> {
    const body = await smallJson(req);
    if (!body) return malformed();
    try {
      if (id === DEFAULT_CANVAS_ID) throw new CanvasStoreError(CANVAS_STORE_ERRORS.defaultProtected, "o canvas padrão não se renomeia");
      const name = requireCanvasName(body.name);
      const current = load(id);
      store(id, { ...current, name });
      log("info", "canvas renomeado", { canvas: id, remote: caller.remote });
      return send(OK_STATUS, { ok: true, id, name });
    } catch (error) {
      return failure(error);
    }
  }

  function remove(id: string, caller: CanvasCaller): Response {
    try {
      if (id === DEFAULT_CANVAS_ID) throw new CanvasStoreError(CANVAS_STORE_ERRORS.defaultProtected, "o canvas padrão não se apaga");
      load(id);
      rmSync(pathOf(id));
      log("info", "canvas apagado", { canvas: id, remote: caller.remote });
      return send(OK_STATUS, { ok: true, id });
    } catch (error) {
      return failure(error);
    }
  }

  /**
   * Importa o arquivo exportado. Sem `id` o canvas nasce com id novo (nunca sobrescreve); com `id` que já existe só grava com
   * `overwrite=true`, e então a revisão segue a do canvas que foi substituído.
   */
  async function importFrom(query: Record<string, string>, req: Request, caller: CanvasCaller): Promise<Response> {
    const raw = await readBody(req, CANVAS_LIMITS.bodyBytes + CANVAS_EXPORT_ENVELOPE_BYTES);
    if (!raw) return refusal(INVALID_STATUS, CANVAS_ERRORS.tooLarge);
    try {
      const imported = parseCanvasExport(new TextDecoder().decode(raw));
      const taken = new Set(storedIds());
      const id = query.id === undefined ? freshCanvasId(imported.name, taken) : requireCanvasId(query.id);
      const existing = read(id);
      if (existing && query.overwrite !== "true") throw new CanvasStoreError(CANVAS_STORE_ERRORS.exists, "já existe canvas com esse id");
      if (!existing && taken.size >= CANVAS_STORE_LIMITS.canvases) throw new CanvasStoreError(CANVAS_STORE_ERRORS.limitReached, "limite de canvases atingido");
      const rev = existing ? existing.doc.rev + 1 : 0;
      const name = id === DEFAULT_CANVAS_ID ? DEFAULT_CANVAS_NAME : imported.name;
      store(id, { name, doc: { ...imported.doc, rev }, ...(existing?.scope ? { scope: existing.scope } : {}) });
      log("info", "canvas importado", { canvas: id, rev, overwrite: existing !== undefined, remote: caller.remote });
      return send(existing ? OK_STATUS : CREATED_STATUS, { id, name, rev, replaced: existing !== undefined });
    } catch (error) {
      return failure(error, true);
    }
  }

  /**
   * Abre o canvas de uma worktree ou rodada, criando-o vazio se ainda não existe. Idempotente: a mesma chave devolve sempre o mesmo
   * canvas (`200`, `created: false`); a primeira vez grava e responde `201`. O id sai só da chave (`scopedCanvasId`), então o
   * cliente também o calcula sem perguntar. Arquivo que ocupa o id sem ser deste escopo é `canvas_exists`, nunca sobrescrito.
   */
  async function openScoped(req: Request, caller: CanvasCaller): Promise<Response> {
    const body = await smallJson(req);
    if (!body) return malformed();
    try {
      const scope = requireCanvasScope({ kind: body.kind, key: body.key });
      const id = scopedCanvasId(scope);
      const existing = read(id);
      if (existing) {
        if (!existing.scope || !sameScope(existing.scope, scope)) throw new CanvasStoreError(CANVAS_STORE_ERRORS.exists, "já existe canvas com esse id");
        return send(OK_STATUS, { id, name: existing.name, rev: existing.doc.rev, scope, created: false });
      }
      if (storedIds().length >= CANVAS_STORE_LIMITS.canvases) throw new CanvasStoreError(CANVAS_STORE_ERRORS.limitReached, "limite de canvases atingido");
      const name = body.name === undefined ? scopedCanvasName(scope) : requireCanvasName(body.name);
      store(id, { name, doc: emptyCanvasDoc(), scope });
      log("info", "canvas de escopo criado", { canvas: id, kind: scope.kind, remote: caller.remote });
      return send(CREATED_STATUS, { id, name, rev: 0, scope, created: true });
    } catch (error) {
      return failure(error);
    }
  }

  // ---- filtros salvos da instância ($D/canvas-filters.json) ----

  /** Conjunto gravado; sem arquivo é o vazio; arquivo ilegível lança `saved_filters_unreadable` (o próximo PUT não o apaga). */
  function loadFilters(): SavedFilterSet {
    const text = readText(filtersPath);
    if (text === undefined) return emptySavedFilters();
    try {
      return readSavedFilters(JSON.parse(text));
    } catch (error) {
      if (error instanceof SavedFilterError || error instanceof SyntaxError) throw new UnreadableFilters();
      throw error;
    }
  }

  function filtersFailure(error: unknown): Response {
    if (error instanceof UnreadableFilters) {
      log("error", "filtros salvos ilegíveis", { code: FILTERS_ERRORS.unreadable });
      return refusal(UNREADABLE_STATUS, FILTERS_ERRORS.unreadable);
    }
    if (error instanceof SavedFilterError) return refusal(FILTER_STATUS[error.code], error.code, { reason: error.message });
    throw error;
  }

  function getFilters(): Response {
    try {
      return send(OK_STATUS, { ...loadFilters() });
    } catch (error) {
      return filtersFailure(error);
    }
  }

  /** PUT do conjunto inteiro, com a regra de revisão do documento: `rev` do corpo = `rev` gravado, grava com +1, senão 409. */
  async function putFilters(req: Request, caller: CanvasCaller): Promise<Response> {
    const raw = await readBody(req, FILTERS_BODY_BYTES);
    if (!raw) return refusal(INVALID_STATUS, CANVAS_ERRORS.tooLarge);
    let incoming: SavedFilterSet;
    try {
      incoming = readSavedFilters(JSON.parse(new TextDecoder().decode(raw)));
    } catch (error) {
      if (error instanceof SyntaxError) return refusal(INVALID_STATUS, CANVAS_ERRORS.invalidJson);
      return filtersFailure(error);
    }
    // leitura, conferência e gravação sem await no meio, como no documento
    try {
      const current = loadFilters();
      if (incoming.rev !== current.rev) return refusal(CONFLICT_STATUS, FILTERS_ERRORS.stale, { rev: current.rev });
      const saved: SavedFilterSet = { ...incoming, rev: current.rev + 1 };
      const tmp = `${filtersPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(saved));
      renameSync(tmp, filtersPath);
      log("info", "filtros salvos gravados", { rev: saved.rev, filters: saved.filters.length, remote: caller.remote });
      return send(OK_STATUS, { v: saved.v, ok: true, rev: saved.rev });
    } catch (error) {
      return filtersFailure(error);
    }
  }

  /** `/api/canvases[/<id>[/<ação>]]` → partes; `undefined` se o caminho não é desta família. */
  function split(path: string): string[] | undefined {
    if (path !== BASE && !path.startsWith(`${BASE}/`)) return undefined;
    return path.slice(BASE.length).split("/").slice(1);
  }

  const notFound = (): Response => send(NOT_FOUND_STATUS, { error: "not found" });

  function terminalPanes(): CanvasTerminalPane[] {
    const out: CanvasTerminalPane[] = [];
    for (const id of [DEFAULT_CANVAS_ID, ...storedIds()]) {
      let stored: StoredCanvas;
      try {
        stored = load(id);
      } catch (error) {
        if (!(error instanceof CanvasError) || error.code !== CANVAS_ERRORS.unreadable) throw error;
        log("error", "canvas ilegível", { canvas: id, code: error.code });
        continue;
      }
      for (const n of stored.doc.nodes) {
        const herdr = n.type === "terminal" && isDict(n.data) && isDict(n.data.herdr) ? n.data.herdr : undefined;
        if (herdr && typeof herdr.session === "string" && typeof herdr.pane === "string") out.push({ session: herdr.session, pane: herdr.pane });
      }
    }
    return out;
  }

  return {
    terminalPanes,
    get() {
      try {
        return send(OK_STATUS, { ...load(DEFAULT_CANVAS_ID).doc });
      } catch (error) {
        return unreadable(error);
      }
    },

    put: (req, caller) => putTo(DEFAULT_CANVAS_ID, req, caller),

    getMany(path) {
      const parts = split(path);
      if (!parts) return undefined;
      try {
        if (parts.length === 1 && parts[0] === FILTERS_SEGMENT) return getFilters();
        if (parts.length === 0) return send(OK_STATUS, { default: DEFAULT_CANVAS_ID, canvases: [DEFAULT_CANVAS_ID, ...storedIds()].map(summaryOrBroken) });
        const id = requireCanvasId(parts[0]);
        if (parts.length === 1) return send(OK_STATUS, { ...load(id).doc });
        if (parts.length === 2 && parts[1] === "export") {
          const { name, doc } = load(id);
          return send(OK_STATUS, { ...exportCanvas(doc, name, now()) });
        }
        return notFound();
      } catch (error) {
        return failure(error);
      }
    },

    writeMany(method, path, query, req, caller) {
      const parts = split(path);
      if (!parts) return undefined;
      if (method === "POST" && parts.length === 0) return create(req, caller);
      if (method === "POST" && parts.length === 1 && parts[0] === "import") return importFrom(query, req, caller);
      if (method === "POST" && parts.length === 1 && parts[0] === SCOPE_SEGMENT) return openScoped(req, caller);
      if (method === "PUT" && parts.length === 1 && parts[0] === FILTERS_SEGMENT) return putFilters(req, caller);
      const [rawId, action] = parts;
      if (parts.length === 0 || parts.length > 2) return Promise.resolve(notFound());
      let id: string;
      try {
        id = requireCanvasId(rawId);
      } catch (error) {
        return Promise.resolve(failure(error));
      }
      // `putTo` lê o canvas antes de gravar: id que não existe é 404 (criar é POST), e o padrão sempre existe
      if (method === "PUT" && parts.length === 1) return putTo(id, req, caller);
      if (method === "POST" && action === "rename") return rename(id, req, caller);
      if (method === "POST" && action === "delete") return Promise.resolve(remove(id, caller));
      return Promise.resolve(notFound());
    },
  };
}

interface BrokenSummary {
  id: string;
  unreadable: true;
}

/** O que a lista mostra de cada canvas. */
interface CanvasSummary {
  id: string;
  name: string;
  rev: number;
  nodes: number;
  edges: number;
  /** ISO 8601 UTC; `null` se o canvas padrão ainda não foi gravado. */
  updatedAt: string | null;
  /** Só nos canvases de worktree/rodada. */
  scope?: CanvasScope;
}
