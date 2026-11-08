// Ponte do Mark-LVI (reference/argos.md §Mark): lê o `bridge.json` que o Mark grava ao subir e monta as URLs da ponte.
// Lógica sem rede: o painel (src/panel/mark.ts) e o doctor usam a mesma leitura. O host é fixo em 127.0.0.1; a porta
// vem do arquivo e o host nunca. O token só existe aqui e no servidor; nenhuma resposta ao navegador o carrega.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Códigos estáveis: só ganham valores, nunca renomeiam. A explicação para humano mora em human-errors-catalog.ts. */
export const MARK_ERRORS = {
  bridgeMissing: "mark_bridge_missing",
  bridgeInvalid: "mark_bridge_invalid",
  processGone: "mark_process_gone",
  unreachable: "mark_unreachable",
  rejected: "mark_rejected",
  badResponse: "mark_bad_response",
  textEmpty: "mark_text_empty",
  textTooLong: "mark_text_too_long",
  streamsBusy: "mark_streams_busy",
  rateLimited: "mark_rate_limited",
  noReport: "mark_no_report",
  reportUnreadable: "mark_report_unreadable",
} as const;
export type MarkErrorCode = (typeof MARK_ERRORS)[keyof typeof MARK_ERRORS];

/** Causas de "fora do ar" (o nó mostra a causa e a ação do catálogo). */
export const OFFLINE_CAUSES = [MARK_ERRORS.bridgeMissing, MARK_ERRORS.bridgeInvalid, MARK_ERRORS.processGone, MARK_ERRORS.unreachable, MARK_ERRORS.rejected, MARK_ERRORS.badResponse] as const;
export type OfflineCause = (typeof OFFLINE_CAUSES)[number];

/** Chave de configuração (kit/config.tsv) e o padrão que o Mark usa quando ninguém o muda. */
export const MARK_BRIDGE_KEY = "HADES_MARK_BRIDGE";
export const DEFAULT_BRIDGE_FILE = "~/.config/mark-lvi/bridge.json";

/** O host da ponte nunca vem de dado: o Mark só aceita o token de loopback. */
export const MARK_HOST = "127.0.0.1";

export const BRIDGE_FILE_MAX_BYTES = 4096;
const MAX_PORT = 65535;

export interface Bridge {
  port: number;
  token: string;
  scheme: "http" | "https";
  pid: number;
}

export type BridgeRead = { ok: true; bridge: Bridge } | { ok: false; cause: OfflineCause };

/** `~/` vira a home; caminho relativo é recusado na leitura da configuração (a chave é do tipo `path`). */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** Caminho do `bridge.json`: o configurado, ou o padrão. Valor relativo cai no padrão (a configuração só aceita absoluto ou `~/`). */
export function bridgePathOf(configured: string | undefined, home: string = homedir()): string {
  const raw = (configured ?? "").trim();
  const expanded = expandHome(raw === "" ? DEFAULT_BRIDGE_FILE : raw, home);
  return isAbsolute(expanded) ? expanded : expandHome(DEFAULT_BRIDGE_FILE, home);
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Valida o JSON do arquivo na fronteira, uma vez; o resto do código trabalha com `Bridge`. */
export function parseBridge(raw: unknown): Bridge | undefined {
  if (!isRecord(raw)) return undefined;
  const { port, token, scheme, pid } = raw;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > MAX_PORT) return undefined;
  if (typeof token !== "string" || token.trim() === "") return undefined;
  if (scheme !== "http" && scheme !== "https") return undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return undefined;
  return { port, token, scheme, pid };
}

/** O processo existe? `EPERM` quer dizer que existe e é de outro usuário. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface BridgeDeps {
  readFile(path: string): string;
  size(path: string): number;
  alive(pid: number): boolean;
}

export const realBridgeDeps: BridgeDeps = {
  readFile: (path) => readFileSync(path, "utf8"),
  size: (path) => statSync(path).size,
  alive: pidAlive,
};

/**
 * Lê o arquivo da ponte. Ausente, ilegível, grande demais ou com campo inválido: causa estável, sem texto do erro do sistema
 * (o caminho e a mensagem do `fs` ficam fora da resposta). `pid` morto é o Mark que saiu por SIGKILL e deixou o arquivo.
 */
export function readBridge(path: string, deps: BridgeDeps = realBridgeDeps): BridgeRead {
  let text: string;
  try {
    if (deps.size(path) > BRIDGE_FILE_MAX_BYTES) return { ok: false, cause: MARK_ERRORS.bridgeInvalid };
    text = deps.readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, cause: code === "ENOENT" || code === "ENOTDIR" ? MARK_ERRORS.bridgeMissing : MARK_ERRORS.bridgeInvalid };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, cause: MARK_ERRORS.bridgeInvalid };
  }
  const bridge = parseBridge(parsed);
  if (bridge === undefined) return { ok: false, cause: MARK_ERRORS.bridgeInvalid };
  if (!deps.alive(bridge.pid)) return { ok: false, cause: MARK_ERRORS.processGone };
  return { ok: true, bridge };
}

/** URL HTTP(S) da ponte. `path` começa com `/`. */
export function markUrl(bridge: Bridge, path: string): string {
  return `${bridge.scheme}://${MARK_HOST}:${bridge.port}${path}`;
}

/** URL do WebSocket do Mark (`/ws`). O token vai no cabeçalho Authorization, nunca na URL. */
export function markWsUrl(bridge: Bridge): string {
  return `${bridge.scheme === "https" ? "wss" : "ws"}://${MARK_HOST}:${bridge.port}/ws`;
}

/** Estados do Mark (`GET /api/state`); o nó escolhe a cor por eles. */
export const MARK_STATES = ["INITIALISING", "LISTENING", "SPEAKING", "THINKING", "PROCESSING", "SLEEPING", "MUTED"] as const;
export type MarkState = (typeof MARK_STATES)[number];


export interface MarkStateBody {
  name: string;
  state: MarkState;
  speaking: boolean;
  muted: boolean;
  claude: { enabled: boolean; permission_mode: string };
  last_report: { path: string; title: string; ts: number } | null;
}

/** Valida o corpo do `/api/state` na fronteira; o que não bate com o contrato é `undefined` (nunca um padrão em silêncio). */
export function parseState(raw: unknown): MarkStateBody | undefined {
  if (!isRecord(raw)) return undefined;
  const { name, state, speaking, muted, claude, last_report: report } = raw;
  if (typeof name !== "string" || typeof speaking !== "boolean" || typeof muted !== "boolean") return undefined;
  if (typeof state !== "string" || !(MARK_STATES as readonly string[]).includes(state)) return undefined;
  if (!isRecord(claude) || typeof claude.enabled !== "boolean" || typeof claude.permission_mode !== "string") return undefined;
  let lastReport: MarkStateBody["last_report"] = null;
  if (report !== null && report !== undefined) {
    if (!isRecord(report) || typeof report.path !== "string" || typeof report.title !== "string" || typeof report.ts !== "number" || !Number.isFinite(report.ts)) return undefined;
    lastReport = { path: report.path, title: report.title, ts: report.ts };
  }
  return { name, state: state as MarkState, speaking, muted, claude: { enabled: claude.enabled, permission_mode: claude.permission_mode }, last_report: lastReport };
}

