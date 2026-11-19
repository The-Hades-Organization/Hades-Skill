// Rota estática do build web do Cardinal (reference/extensoes.md §Editor embutido): `/ext/cardinal/web/*` serve só arquivos
// de HADES_CARDINAL_WEB. O iframe do nó tem origem opaca (sandbox sem allow-same-origin) e não manda cookie, então a rota
// responde antes da chave remota: não entrega dado do usuário, só o build. A API do painel continua atrás da chave.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { home } from "../lib/paths.ts";
import { CTYPES, send, type SendExtras } from "./http.ts";

export const CARDINAL_WEB_PREFIX = "/ext/cardinal/web";

/** Códigos estáveis da rota (só ganham valores). */
export const CARDINAL_WEB_ERRORS = {
  missing: "cardinal_web_missing",
  notFound: "cardinal_web_not_found",
} as const;

const HASHED = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/; // saída do Vite: nome-HASH.ext
const IMMUTABLE = "public, max-age=31536000, immutable";
const COMPRESSIBLE = new Set([".wasm", ".js", ".css", ".html", ".svg", ".json"]);
const GZIP_MIN = 1024;

interface Packed {
  key: string;
  bytes: Uint8Array;
}

export interface CardinalWebRoute {
  /** `undefined` quando o caminho não é desta rota */
  serve(req: Request, url: URL): Response | undefined;
}

export interface CardinalWebDeps {
  /** HADES_CARDINAL_WEB atual (lido a cada pedido: o dono pode mudar na página Configurações) */
  dir: () => string | undefined;
}

/** `~` e `~/x` viram o home; vazio vira `undefined`. */
export function expandWebDir(dir: string | undefined): string | undefined {
  if (dir === undefined || dir === "") return undefined;
  return dir === "~" || dir.startsWith("~/") ? join(home(), dir.slice(1)) : dir;
}

const isUnder = (child: string, parent: string): boolean => child.startsWith(parent + sep);
const extOf = (name: string): string => name.slice(name.lastIndexOf("."));

/** Caminho relativo pedido, já decodificado; `undefined` se tenta sair da pasta. */
function relativeOf(pathname: string): string | undefined {
  let rest: string;
  try {
    rest = decodeURIComponent(pathname.slice(CARDINAL_WEB_PREFIX.length));
  } catch {
    return undefined;
  }
  if (rest.includes("\0") || rest.includes("\\")) return undefined;
  const parts = rest.split("/").filter((p) => p !== "");
  if (parts.some((p) => p === ".." || p === ".")) return undefined;
  return parts.length === 0 ? "index.html" : parts.join("/");
}

export function createCardinalWebRoute(deps: CardinalWebDeps): CardinalWebRoute {
  const gzipped = new Map<string, Packed>();

  function resolve(root: string, rel: string): string | undefined {
    try {
      const real = realpathSync(join(root, rel));
      return isUnder(real, realpathSync(root)) && statSync(real).isFile() ? real : undefined;
    } catch {
      return undefined;
    }
  }

  /** `.br`/`.gz` pré-comprimido ao lado; sem ele, gzip na hora (com cache por arquivo, tamanho e mtime). */
  function encoded(real: string, accept: string, root: string, rel: string): { bytes: Uint8Array; encoding?: string } {
    const wants = (name: string): boolean => accept.split(",").some((p) => p.trim().split(";")[0] === name);
    if (wants("br")) {
      const br = resolve(root, `${rel}.br`);
      if (br !== undefined) return { bytes: readFileSync(br), encoding: "br" };
    }
    if (wants("gzip")) {
      const gz = resolve(root, `${rel}.gz`);
      if (gz !== undefined) return { bytes: readFileSync(gz), encoding: "gzip" };
      const st = statSync(real);
      if (COMPRESSIBLE.has(extOf(real)) && st.size >= GZIP_MIN) {
        const key = `${st.size}:${st.mtimeMs}`;
        const hit = gzipped.get(real);
        if (hit?.key === key) return { bytes: hit.bytes, encoding: "gzip" };
        const bytes = gzipSync(readFileSync(real));
        gzipped.set(real, { key, bytes });
        return { bytes, encoding: "gzip" };
      }
    }
    return { bytes: readFileSync(real) };
  }

  return {
    serve(req, url) {
      const path = url.pathname;
      if (path !== CARDINAL_WEB_PREFIX && !path.startsWith(`${CARDINAL_WEB_PREFIX}/`)) return undefined;
      const frame = { frame: "self", headers: { "Access-Control-Allow-Origin": "*" } } as const satisfies SendExtras;
      const root = expandWebDir(deps.dir());
      if (root === undefined || !existsSync(join(root, "index.html"))) {
        return send(404, { error: "build web do Cardinal ausente (HADES_CARDINAL_WEB)", code: CARDINAL_WEB_ERRORS.missing }, undefined, undefined, frame);
      }
      const rel = relativeOf(path);
      const real = rel === undefined ? undefined : resolve(root, rel);
      if (rel === undefined || real === undefined) return send(404, { error: "not found", code: CARDINAL_WEB_ERRORS.notFound }, undefined, undefined, frame);
      const ext = extOf(real);
      const type = CTYPES[ext] ?? "application/octet-stream";
      const cache = HASHED.test(real.slice(real.lastIndexOf(sep) + 1)) ? IMMUTABLE : "no-cache";
      const { bytes, encoding } = encoded(real, req.headers.get("accept-encoding") ?? "", root, rel);
      const headers: Record<string, string> = { ...frame.headers, Vary: "Accept-Encoding" };
      if (encoding !== undefined) headers["Content-Encoding"] = encoding;
      return send(200, bytes, type, cache, { frame: "self", headers });
    },
  };
}
