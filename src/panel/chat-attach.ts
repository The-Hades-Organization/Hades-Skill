// Anexos do chat: o navegador manda o arquivo em JSON (base64) e ele vai para $D/claude/attach/<sessão>/, nunca para dentro do
// repositório do projeto. A mensagem cita o caminho, que é como o Claude Code lê arquivo. Regra pura (nome, tipo, limite) aqui;
// o chat.ts só liga ao registro e ao log.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Códigos estáveis da recusa (só ganham valores); a interface ramifica por eles, não pelo texto. */
export const ATTACH_CODES = {
  disabled: "attach_disabled", badRequest: "attach_bad_request", tooLarge: "attach_too_large", badType: "attach_bad_type",
  tooMany: "attach_too_many", unknownSession: "attach_unknown_session",
} as const;
export type AttachCode = (typeof ATTACH_CODES)[keyof typeof ATTACH_CODES];

export const ATTACH_STATUS: Record<AttachCode, number> = {
  attach_disabled: 403, attach_bad_request: 400, attach_too_large: 413, attach_bad_type: 415, attach_too_many: 429, attach_unknown_session: 404,
};

export class AttachRefused extends Error {
  readonly code: AttachCode;
  constructor(code: AttachCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const ATTACH_DEFAULT_MB = 5;
export const ATTACH_MAX_FILES = 20;
const NAME_MAX = 80;
const ENVELOPE_BYTES = 4096;
const BASE64_RATIO = 4 / 3;
const BYTES_PER_MB = 1024 * 1024;
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const DRAFT_ID = /^[0-9a-f]{8}$/;
const STORED_NAME = /^[0-9a-f]{4}-[A-Za-z0-9._-]{1,80}$/;
const DRAFT_MAX_AGE_MS = 24 * 3600 * 1000;

/** Assinaturas de imagem; texto não tem assinatura, então vale a lista de extensões e a ausência de byte nulo. */
const IMAGES: Record<string, (b: Uint8Array) => boolean> = {
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  webp: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "json", "log", "csv", "tsv", "yaml", "yml", "toml", "ini", "diff", "patch", "ts", "tsx", "js", "jsx", "mjs", "py", "sh", "rs", "go",
  "java", "kt", "c", "h", "cpp", "css", "html", "sql", "xml", "env",
]);
const NUL_SCAN = 8192;

/** Nome sem pasta, sem `..` e só com [A-Za-z0-9._-]; vazio vira `arquivo`. A extensão (em minúsculas) decide o tipo. */
export function safeName(raw: string): { name: string; ext: string } {
  const last = raw.split(/[\\/]/).pop() ?? "";
  let name = last.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{2,}/g, ".").replace(/^[._-]+/, "").slice(-NAME_MAX);
  if (!name) name = "arquivo";
  const dot = name.lastIndexOf(".");
  return { name, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "" };
}

export function attachKind(ext: string, bytes: Uint8Array): "imagem" | "texto" {
  const image = IMAGES[ext];
  if (image) {
    if (!image(bytes)) throw new AttachRefused(ATTACH_CODES.badType, "o conteúdo não é a imagem que a extensão diz");
    return "imagem";
  }
  if (!TEXT_EXTENSIONS.has(ext)) throw new AttachRefused(ATTACH_CODES.badType, "só imagem (png, jpg, gif, webp) ou arquivo de texto");
  if (bytes.subarray(0, NUL_SCAN).includes(0)) throw new AttachRefused(ATTACH_CODES.badType, "o arquivo de texto tem bytes binários");
  return "texto";
}

export const attachLimitBytes = (mb: string | undefined): number => {
  const n = Number.parseInt(mb ?? "", 10);
  return (Number.isFinite(n) && n > 0 ? n : ATTACH_DEFAULT_MB) * BYTES_PER_MB;
};
/** Teto do corpo da requisição: base64 cresce 4/3, mais o envelope JSON. */
export const attachBodyLimit = (limitBytes: number): number => Math.ceil(limitBytes * BASE64_RATIO) + ENVELOPE_BYTES;

export interface Stored { name: string; bytes: number; kind: "imagem" | "texto"; path: string; file: string }

export interface Attachments {
  save(id: string, rawName: string, base64: string, limitBytes: number): Stored;
  /** Caminhos absolutos dos arquivos citados (nomes guardados), conferidos dentro da pasta da sessão. */
  resolveFiles(id: string, files: string[]): string[];
  remove(id: string): void;
  exists(id: string): boolean;
  /** Pastas de rascunho (anexo antes da primeira mensagem) que ninguém reivindicou em 24 h. */
  sweep(registered: (id: string) => boolean, now: number): void;
}

export function createAttachments(root: string): Attachments {
  const base = join(root, "attach");
  const folder = (id: string): string => {
    if (!DRAFT_ID.test(id)) throw new AttachRefused(ATTACH_CODES.badRequest, "sessão inválida");
    return join(base, id);
  };
  /** O caminho resolvido tem de estar dentro da pasta da sessão (o prefixo, não o sufixo). */
  const inside = (dir: string, path: string): boolean => resolve(path).startsWith(resolve(dir) + sep);

  return {
    save(id, rawName, base64, limitBytes) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) throw new AttachRefused(ATTACH_CODES.badRequest, "conteúdo inválido");
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length === 0) throw new AttachRefused(ATTACH_CODES.badRequest, "arquivo vazio");
      if (bytes.length > limitBytes) throw new AttachRefused(ATTACH_CODES.tooLarge, `arquivo acima de ${Math.floor(limitBytes / BYTES_PER_MB)} MB`);
      const { name, ext } = safeName(rawName);
      const kind = attachKind(ext, bytes);
      const dir = folder(id);
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
      chmodSync(dir, PRIVATE_DIR);
      if (readdirSync(dir).length >= ATTACH_MAX_FILES) throw new AttachRefused(ATTACH_CODES.tooMany, `no máximo ${ATTACH_MAX_FILES} anexos por conversa`);
      const file = `${randomBytes(2).toString("hex")}-${name}`;
      const path = join(dir, file);
      if (!inside(dir, path)) throw new AttachRefused(ATTACH_CODES.badRequest, "nome inválido");
      writeFileSync(path, bytes, { mode: PRIVATE_FILE, flag: "wx" });
      return { name, bytes: bytes.length, kind, path: realpathSync(path), file };
    },
    resolveFiles(id, files) {
      const dir = folder(id);
      return files.map((file) => {
        const path = join(dir, file);
        if (!STORED_NAME.test(file) || !inside(dir, path) || !existsSync(path)) throw new AttachRefused(ATTACH_CODES.badRequest, "anexo desconhecido");
        return realpathSync(path);
      });
    },
    remove: (id) => rmSync(folder(id), { recursive: true, force: true }),
    exists: (id) => DRAFT_ID.test(id) && existsSync(join(base, id)),
    sweep(registered, now) {
      if (!existsSync(base)) return;
      for (const id of readdirSync(base)) {
        if (!DRAFT_ID.test(id) || registered(id)) continue;
        const dir = join(base, id);
        const newest = Math.max(0, ...readdirSync(dir).map((f) => Bun.file(join(dir, f)).lastModified));
        if (now - newest > DRAFT_MAX_AGE_MS) rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
