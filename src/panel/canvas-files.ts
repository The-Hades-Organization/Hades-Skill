// Arquivos do compositor do canvas (reference/argos.md §Compositor).
//   GET  /api/argos/terminal-files?session=<s>&pane=<p>[&path=<relativo>][&q=<busca>]
//   POST /api/argos/compose/attachment   { name, type, data (base64) }
// O seletor só lista nomes debaixo do diretório de trabalho do pane do herdr, que o servidor lê na listagem atual do herdr
// (nunca da tela): o caminho pedido é normalizado, resolvido pelo caminho real e conferido dentro dessa raiz; link
// simbólico que sai dela some da listagem e, pedido como pasta, responde como inexistente. Conteúdo de arquivo nunca é lido.
// O anexo (colar, arrastar, clipe) é gravado em `$D/canvas-compose/` com nome gerado aqui e extensão da lista fechada de
// tipos; a resposta é o caminho que o compositor insere no texto. Quem chega aqui já passou pela chave e pelo token do painel.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { type Herdr } from "./herdr.ts";
import { PANE_ID, SESSION_NAME } from "./herdr-page.ts";
import { send } from "./http.ts";
import { log } from "./log.ts";

export const TERMINAL_FILES_PATH = "/api/argos/terminal-files";
export const COMPOSE_ATTACHMENT_PATH = "/api/argos/compose/attachment";
const FOLDER = "canvas-compose";

export const FILES_LIMITS = {
  /** entradas devolvidas por pedido (o resto sai com `truncated: true`) */
  entries: 200,
  pathChars: 1024,
  pathSegments: 32,
  queryChars: 80,
  /** a busca desce até esta profundidade abaixo do caminho pedido */
  searchDepth: 8,
  /**
   * pastas e entradas que a busca olha antes de parar (com `truncated: true`): um monorepo real tem dezenas de milhares
   * de arquivos de código antes do primeiro acerto, e 20 mil entradas paravam a busca sem nenhum
   */
  searchDirs: 20_000,
  searchEntries: 100_000,
  /** anexo: bytes do arquivo, o corpo (base64 + JSON) e o nome mostrado */
  attachmentBytes: 8 * 1024 * 1024,
  attachmentNameChars: 200,
  /** anexos guardados e por quanto tempo: a gravação apaga o que passou disso */
  attachmentsKept: 500,
  attachmentDays: 7,
} as const;

/** Códigos estáveis: só ganham valores. */
export const FILES_ERRORS = {
  invalidTarget: "files_invalid_target",
  unknownPane: "files_unknown_pane",
  noCwd: "files_no_cwd",
  invalidPath: "files_invalid_path",
  pathNotFound: "files_path_not_found",
  notDirectory: "files_not_directory",
  invalidQuery: "files_invalid_query",
  invalidAttachment: "attachment_invalid",
  attachmentType: "attachment_type",
  attachmentTooLarge: "attachment_too_large",
  attachmentFailed: "attachment_failed",
} as const;
export type FilesErrorCode = (typeof FILES_ERRORS)[keyof typeof FILES_ERRORS];

const STATUS: Record<FilesErrorCode, number> = {
  [FILES_ERRORS.invalidTarget]: 400,
  [FILES_ERRORS.unknownPane]: 404,
  [FILES_ERRORS.noCwd]: 404,
  [FILES_ERRORS.invalidPath]: 400,
  [FILES_ERRORS.pathNotFound]: 404,
  [FILES_ERRORS.notDirectory]: 400,
  [FILES_ERRORS.invalidQuery]: 400,
  [FILES_ERRORS.invalidAttachment]: 400,
  [FILES_ERRORS.attachmentType]: 415,
  [FILES_ERRORS.attachmentTooLarge]: 413,
  [FILES_ERRORS.attachmentFailed]: 500,
};

/** Mensagem fixa por código: nunca caminho nem texto de erro do sistema. */
const MESSAGES: Record<FilesErrorCode, string> = {
  [FILES_ERRORS.invalidTarget]: "terminal inválido",
  [FILES_ERRORS.unknownPane]: "terminal desconhecido",
  [FILES_ERRORS.noCwd]: "diretório do terminal desconhecido",
  [FILES_ERRORS.invalidPath]: "caminho inválido",
  [FILES_ERRORS.pathNotFound]: "caminho não encontrado",
  [FILES_ERRORS.notDirectory]: "o caminho não é uma pasta",
  [FILES_ERRORS.invalidQuery]: "busca inválida",
  [FILES_ERRORS.invalidAttachment]: "anexo inválido",
  [FILES_ERRORS.attachmentType]: "tipo de anexo não aceito",
  [FILES_ERRORS.attachmentTooLarge]: "anexo grande demais",
  [FILES_ERRORS.attachmentFailed]: "não deu para guardar o anexo",
};

const refuse = (code: FilesErrorCode): Response => send(STATUS[code], { error: MESSAGES[code], code });

/** Tipos aceitos no anexo → extensão do arquivo gravado. O nome vindo do navegador nunca entra no caminho. */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
};

/**
 * Pastas que a busca não desce: dependências, saídas de build e pastas ocultas (caches como `.angular` esgotavam o teto de
 * pastas antes de chegar ao código num projeto real). A listagem ainda as mostra, e entrar nelas pelo `path` funciona.
 */
const SEARCH_SKIP = new Set(["node_modules", "dist", "build", "target", "vendor"]);
const skipInSearch = (name: string): boolean => name.startsWith(".") || SEARCH_SKIP.has(name);
const DAY_MS = 86_400_000;

export type FileEntryType = "dir" | "file";

export interface FileEntry {
  /** relativo ao diretório do terminal, com `/` */
  path: string;
  name: string;
  type: FileEntryType;
}

export interface FilesDeps {
  /** Diretório de trabalho do pane, pela listagem atual do herdr; `undefined` sem pane, `null` com pane sem diretório. */
  paneCwd(session: string, pane: string): Promise<string | null | undefined>;
  /** `$D`: o anexo vai para `$D/canvas-compose/`. */
  dataDir: string;
  now?(): number;
  limits?: Partial<{ [K in keyof typeof FILES_LIMITS]: number }>;
}

export interface FilesRoutes {
  get(path: string, query: Record<string, string>): Promise<Response | undefined>;
  /** Lê o próprio corpo (teto maior que o dos outros POST); `undefined` se o caminho não é daqui. */
  post(path: string, req: Request, opts: { remote: boolean }): Promise<Response> | undefined;
}

/** Diretório de trabalho do pane no retrato do herdr: o do processo em primeiro plano, senão o do pane. */
export async function paneCwdOf(herdr: Pick<Herdr, "snap">, session: string, pane: string): Promise<string | null | undefined> {
  const snap = await herdr.snap(session);
  const panes = snap && Array.isArray(snap.panes) ? (snap.panes as unknown[]) : [];
  for (const raw of panes) {
    if (typeof raw !== "object" || raw === null) continue;
    const info = raw as Record<string, unknown>;
    if (info.pane_id !== pane) continue;
    for (const dir of [info.foreground_cwd, info.cwd]) if (typeof dir === "string" && dir.startsWith("/")) return dir;
    return null;
  }
  return undefined;
}

/** Caminho pedido em segmentos; `undefined` com `..`, NUL, barra invertida, absoluto ou acima dos tetos. */
export function parseRelPath(raw: string, maxSegments: number, maxChars: number): string[] | undefined {
  if (raw.length > maxChars || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) return undefined;
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length > maxSegments || segments.includes("..")) return undefined;
  return segments;
}

const inside = (root: string, real: string): boolean => real === root || real.startsWith(root + sep);
const codeCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const fold = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Caminho real, ou `undefined` se não existe ou não se lê (link quebrado, sem permissão). */
function realOf(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "ELOOP") return undefined;
    throw error;
  }
}

/** Tipo de uma entrada da pasta; link simbólico vale pelo alvo, e só se o alvo fica dentro da raiz. */
function entryType(root: string, full: string, isLink: boolean, isDir: boolean): FileEntryType | undefined {
  if (!isLink) return isDir ? "dir" : "file";
  const real = realOf(full);
  if (real === undefined || !inside(root, real)) return undefined;
  return statSync(real).isDirectory() ? "dir" : "file";
}

type DirEntry = { name: string; isLink: boolean; isDir: boolean };
const unreadable = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "ENOENT" || code === "ENOTDIR";
};
const toEntry = (d: { name: string; isSymbolicLink(): boolean; isDirectory(): boolean }): DirEntry => ({
  name: d.name,
  isLink: d.isSymbolicLink(),
  isDir: d.isDirectory(),
});

function readDir(dir: string): DirEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map(toEntry);
  } catch (error) {
    if (unreadable(error)) return [];
    throw error;
  }
}

/** Como `readDir`, sem segurar o laço de eventos: a busca lê milhares de pastas e o painel serve os terminais. */
async function readDirAsync(dir: string): Promise<DirEntry[]> {
  try {
    const found = (await readdir(dir, { withFileTypes: true })).map(toEntry);
    // o readdir do Bun pode resolver sem passar pelo laço; ceder a vez por pasta é o que garante isso
    await new Promise<void>((resolve) => setImmediate(resolve));
    return found;
  } catch (error) {
    if (unreadable(error)) return [];
    throw error;
  }
}

type Found = { dir: string } | { code: FilesErrorCode };

export function createCanvasFilesRoutes(deps: FilesDeps): FilesRoutes {
  const limit = { ...FILES_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  /** Busca em curso por terminal: a nova (o dono digitou mais) encerra a anterior, que ninguém mais espera. */
  const searching = new Map<string, number>();
  let searchSeq = 0;

  /** Raiz do terminal (caminho real) a partir de `session` e `pane`, ou o código da recusa. */
  async function rootOf(query: Record<string, string>): Promise<Found> {
    const session = query.session ?? "";
    const pane = query.pane ?? "";
    if (!SESSION_NAME.test(session) || !PANE_ID.test(pane)) return { code: FILES_ERRORS.invalidTarget };
    const cwd = await deps.paneCwd(session, pane);
    if (cwd === undefined) return { code: FILES_ERRORS.unknownPane };
    const real = cwd === null ? undefined : realOf(cwd);
    return real === undefined ? { code: FILES_ERRORS.noCwd } : { dir: real };
  }

  /** Pasta pedida dentro da raiz: o caminho real tem de ficar nela (link para fora responde como inexistente). */
  function dirOf(root: string, segments: string[]): Found {
    const real = realOf(join(root, ...segments));
    if (real === undefined || !inside(root, real)) return { code: FILES_ERRORS.pathNotFound };
    return statSync(real).isDirectory() ? { dir: real } : { code: FILES_ERRORS.notDirectory };
  }

  const relOf = (root: string, full: string): string => full.slice(root.length + 1).split(sep).join("/");

  function list(root: string, dir: string): { entries: FileEntry[]; truncated: boolean } {
    const entries: FileEntry[] = [];
    for (const d of readDir(dir).sort((a, b) => codeCompare(a.name, b.name))) {
      const full = join(dir, d.name);
      const type = entryType(root, full, d.isLink, d.isDir);
      if (type === undefined) continue;
      if (entries.length >= limit.entries) return { entries, truncated: true };
      entries.push({ path: relOf(root, full), name: d.name, type });
    }
    // pastas primeiro, cada grupo em ordem de código
    entries.sort((a, b) => (a.type === b.type ? codeCompare(a.name, b.name) : a.type === "dir" ? -1 : 1));
    return { entries, truncated: false };
  }

  /**
   * Busca pelo nome em largura, sem seguir link para pasta e sem descer nas pastas de `skipInSearch`, com tetos de trabalho.
   * `current()` falso (veio outra busca do mesmo terminal) para a varredura com o que já achou.
   */
  async function search(root: string, dir: string, want: string, current: () => boolean): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    const entries: FileEntry[] = [];
    let queue: string[] = [dir];
    let dirs = 0;
    let seen = 0;
    for (let depth = 0; depth <= limit.searchDepth && queue.length > 0; depth += 1) {
      const next: string[] = [];
      for (const folder of queue) {
        dirs += 1;
        if (dirs > limit.searchDirs || !current()) return { entries, truncated: true };
        for (const d of (await readDirAsync(folder)).sort((a, b) => codeCompare(a.name, b.name))) {
          seen += 1;
          if (seen > limit.searchEntries) return { entries, truncated: true };
          const full = join(folder, d.name);
          if (d.isDir && !d.isLink && !skipInSearch(d.name)) next.push(full);
          if (!fold(d.name).includes(want)) continue;
          const type = entryType(root, full, d.isLink, d.isDir);
          if (type === undefined) continue;
          if (entries.length >= limit.entries) return { entries, truncated: true };
          entries.push({ path: relOf(root, full), name: d.name, type });
        }
      }
      queue = next;
    }
    return { entries, truncated: queue.length > 0 };
  }

  async function files(query: Record<string, string>): Promise<Response> {
    const found = await rootOf(query);
    if ("code" in found) return refuse(found.code);
    const root = found.dir;
    const segments = parseRelPath(query.path ?? "", limit.pathSegments, limit.pathChars);
    if (segments === undefined) return refuse(FILES_ERRORS.invalidPath);
    const q = (query.q ?? "").trim();
    if (q.length > limit.queryChars || q.includes("\0")) return refuse(FILES_ERRORS.invalidQuery);
    const target = dirOf(root, segments);
    if ("code" in target) return refuse(target.code);
    const dir = target.dir;
    const result = q === "" ? list(root, dir) : await searchFor(`${query.session}\0${query.pane}`, root, dir, fold(q));
    return send(200, { path: dir === root ? "" : relOf(root, dir), query: q, ...result });
  }

  async function searchFor(terminal: string, root: string, dir: string, want: string): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    searchSeq += 1;
    const mine = searchSeq;
    searching.set(terminal, mine);
    try {
      return await search(root, dir, want, () => searching.get(terminal) === mine);
    } finally {
      if (searching.get(terminal) === mine) searching.delete(terminal);
    }
  }

  /** Apaga os anexos mais velhos que o prazo e os que passam da quantidade guardada (os mais antigos primeiro). */
  function prune(folder: string): void {
    const kept = readDir(folder)
      .filter((d) => !d.isDir && !d.isLink)
      .map((d) => ({ path: join(folder, d.name), at: lstatSync(join(folder, d.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    const oldest = now() - limit.attachmentDays * DAY_MS;
    kept.forEach((file, i) => {
      if (i >= limit.attachmentsKept || file.at < oldest) rmSync(file.path, { force: true });
    });
  }

  function attachment(body: Record<string, unknown>, remote: boolean): Response {
    const { name, type, data } = body;
    if (typeof name !== "string" || name.length > limit.attachmentNameChars || typeof type !== "string" || typeof data !== "string") {
      return refuse(FILES_ERRORS.invalidAttachment);
    }
    const ext = Object.hasOwn(ATTACHMENT_TYPES, type) ? ATTACHMENT_TYPES[type] : undefined;
    if (ext === undefined) return refuse(FILES_ERRORS.attachmentType);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return refuse(FILES_ERRORS.invalidAttachment);
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return refuse(FILES_ERRORS.invalidAttachment);
    if (bytes.length > limit.attachmentBytes) return refuse(FILES_ERRORS.attachmentTooLarge);
    const folder = join(deps.dataDir, FOLDER);
    const stamp = new Date(now()).toISOString().slice(0, 10);
    const file = join(folder, `${stamp}-${randomBytes(8).toString("hex")}.${ext}`);
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      prune(folder);
      writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
    } catch (error) {
      log("error", "anexo do compositor não gravado", { reason: (error as NodeJS.ErrnoException).code ?? "erro" });
      return refuse(FILES_ERRORS.attachmentFailed);
    }
    // auditoria: quem (local/remoto), o quê e quanto; nunca o nome dado nem o conteúdo
    log("info", "anexo do compositor gravado", { remote, type, bytes: bytes.length });
    return send(200, { path: file, type, bytes: bytes.length, image: type.startsWith("image/") });
  }

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

  async function attachmentRequest(req: Request, remote: boolean): Promise<Response> {
    // base64 cresce 4/3, mais o envelope JSON
    const raw = await readBody(req, Math.ceil((limit.attachmentBytes * 4) / 3) + 4096);
    if (raw === undefined) return refuse(FILES_ERRORS.attachmentTooLarge);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return refuse(FILES_ERRORS.invalidAttachment);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refuse(FILES_ERRORS.invalidAttachment);
    return attachment(parsed as Record<string, unknown>, remote);
  }

  return {
    get: async (path, query) => (path === TERMINAL_FILES_PATH ? files(query) : undefined),
    post: (path, req, opts) => (path === COMPOSE_ATTACHMENT_PATH ? attachmentRequest(req, opts.remote) : undefined),
  };
}
