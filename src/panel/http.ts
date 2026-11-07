// Respostas e leitura de requisição do painel. Cabeçalhos de segurança: sem cache e sem moldura.
import { explain } from "../lib/human-errors.ts";
import { pyJsonDumps } from "../lib/kit.ts";

export const CTYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};
export const JSON_TYPE = "application/json";
const NO_STORE = "no-store";
const BODY_MAX = 65536;
const FORM_MAX = 4096;

export type Body = Record<string, unknown> | unknown[] | Uint8Array | string;

/** Erro de entrada do dono: vira 400 com a mensagem (o ValueError do original). */
export class BadRequest extends Error {}

/** Acrescenta `explain` ao corpo de erro que já leva `code` (reference/erros.md); o resto do corpo fica como está. */
function withExplain(status: number, body: Body): Body {
  if (status < 400 || body instanceof Uint8Array || typeof body === "string" || Array.isArray(body)) return body;
  const code = body.code;
  if (typeof code !== "string" || "explain" in body) return body;
  const { title, cause, action, ref } = explain(code);
  return { ...body, explain: { code, title, cause, action, ref } };
}

export function send(status: number, body: Body, contentType: string = JSON_TYPE, cache: string = NO_STORE): Response {
  const shaped = withExplain(status, body);
  const payload = shaped instanceof Uint8Array || typeof shaped === "string" ? shaped : pyJsonDumps(shaped);
  return new Response(payload, {
    status,
    headers: { "Content-Type": contentType, "Cache-Control": cache, "X-Frame-Options": "DENY" },
  });
}

/** parse_qs do Python: só o primeiro valor de cada chave, e valor em branco não conta. */
export function queryOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) if (value !== "" && !(key in out)) out[key] = value;
  return out;
}

export function cookiesOf(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1);
  }
  return out;
}

async function readCapped(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number.parseInt(req.headers.get("content-length") ?? "0", 10) || 0;
  const bytes = new Uint8Array(await req.arrayBuffer());
  return bytes.subarray(0, Math.min(declared, max, bytes.length));
}

/** JSON do POST (até 64 KiB); undefined se não é JSON de objeto. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | undefined> {
  const raw = await readCapped(req, BODY_MAX);
  try {
    const parsed: unknown = raw.length === 0 ? {} : JSON.parse(new TextDecoder().decode(raw));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Formulário do /auth (até 4 KiB), como o parse_qs: em branco não conta. */
export async function readForm(req: Request): Promise<Record<string, string>> {
  const text = new TextDecoder("utf-8").decode(await readCapped(req, FORM_MAX));
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) if (value !== "" && !(key in out)) out[key] = value;
  return out;
}
