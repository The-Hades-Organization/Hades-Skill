// Notificações do Hades: desktop (notify-send; osascript no macOS) e celular (ntfy). Estado em $D (o install.sh nunca toca): ntfy.topic
// (600, o tópico é o segredo do canal do celular) e notify/ (history.jsonl, dedupe.json, pr-marks.json, heartbeat.json, agents/).
// Configurações: HADES_NOTIFY* do config.tsv; variável exportada no shell vence o config.env.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { effectiveConfig, unitPrefix } from "./config.ts";
import { FlockTimeoutError, withFlockAsync } from "./flock.ts";
import { listDir, readText } from "./fs.ts";
import { pyDumps, splitLines } from "./pyjson.ts";
import { which } from "./proc.ts";
import { managerKind, serviceManager } from "./service-manager.ts";

export type Severity = "info" | "warn" | "error";
export const KEEP = 50;
const DEDUPE_TTL_S = 7 * 86400;
const DEFAULT_DEDUPE_MIN = 60;
const DESKTOP_TIMEOUT_MS = 6000;
const NTFY_TIMEOUT_MS = 8000;
// Passa do envio mais longo (ntfy + desktop) que um outro processo pode estar fazendo com o lock tomado.
const DEFAULT_LOCK_WAIT_S = 15;
const DEFAULT_NTFY_URL = "https://ntfy.sh";

const SEVERITIES: Record<Severity, { prio: string; urg: string; tag: string }> = {
  info: { prio: "2", urg: "low", tag: "information_source" },
  warn: { prio: "3", urg: "normal", tag: "warning" },
  error: { prio: "4", urg: "critical", tag: "rotating_light" },
};
export const EVENTS: Record<string, string> = {
  gate: "Gate",
  restart: "Serviço reiniciando",
  health: "Serviço fora do ar",
  pr: "PR",
  ci: "CI",
  agent: "Agente",
  snapshot: "Snapshot falhou",
  doctor: "Diagnóstico",
  chat: "Sessão Claude remota",
  herdr: "Herdr remoto",
  test: "Teste",
};
/** Nome que a tela mostra para cada tipo (o título da notificação é o curto, de EVENTS). */
export const EVENT_LABELS: Record<string, string> = {
  gate: "Gate, build ou teste falhou",
  pr: "Review novo",
  ci: "CI vermelho",
  test: "Notificação de teste (botão de testar o envio)",
};
/** Eventos com interruptor HADES_NOTIFY_EV_*: o de teste ignora os switches de propósito (botão de testar o envio). */
export const SWITCHABLE_EVENTS = Object.keys(EVENTS).filter((event) => event !== "test");
// O CI nasceu dentro do `pr` e o padrão dele era seguir o canal do review. Hoje cada tipo tem o interruptor próprio (padrão
// both), mas o valor `pr` já gravado por quem instalou continua aceito e segue o canal do review: o contrato só cresce.
const FOLLOWS_PR = "pr";
export const WHY_REPEATED = "repetido na janela";
const evKey = (event: string): string => `HADES_NOTIFY_EV_${event.toUpperCase()}`;

export interface DedupeEntry {
  ts: number;
  sig: string;
  src: string;
}
export type Channels = Record<string, string>;
export interface NotifyResult {
  sent: boolean;
  channels?: Channels;
  why?: string;
}
export interface HistoryEntry {
  ts: number;
  event: string;
  sev: string;
  obj: string;
  text: string;
  channels: Channels;
}

/** Tudo que depende da instância ($D) fica aqui, calculado uma vez na subida do comando. */
export class NotifyContext {
  readonly dir: string;
  readonly state: string;
  readonly topicFile: string;
  readonly history: string;
  readonly dedupe: string;
  readonly marks: string;
  readonly beat: string;
  readonly lockFile: string;
  readonly hu: string;
  readonly unit: string;
  /** Relógio em ms desde a época; o teste injeta o dele para avançar além da janela do dedupe. */
  readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
    this.state = join(dir, "notify");
    this.topicFile = join(dir, "ntfy.topic");
    this.history = join(this.state, "history.jsonl");
    this.dedupe = join(this.state, "dedupe.json");
    this.marks = join(this.state, "pr-marks.json");
    this.beat = join(this.state, "heartbeat.json");
    this.lockFile = join(this.state, ".lock");
    this.hu = unitPrefix(dir);
    this.unit = process.env.HADES_NOTIFY_UNIT || `${this.hu}-notify`;
  }

  /** Variável exportada > config.env > padrão do catálogo (o vigia roda sem as chaves exportadas e relê a cada ciclo). */
  cfg(key: string): string {
    const exported = process.env[key];
    if (exported !== undefined) return exported;
    return effectiveConfig(this.dir, {}).get(key) ?? "";
  }

  cint(key: string, fallback: number): number {
    const value = this.cfg(key);
    return /^\s*[+-]?\d+\s*$/.test(value) ? Number.parseInt(value, 10) : fallback;
  }

  /** Canais do evento: off | desktop | phone | both (eventos fora do catálogo valem 'both'). */
  eventChannels(event: string): string {
    if (!(event in EVENTS)) return "both";
    const channels = this.cfg(evKey(event)) || "both";
    return channels === FOLLOWS_PR ? this.eventChannels("pr") : channels;
  }

  /** Exportada no ambiente com valor diferente do config.env: o export vence e mudar na tela não tem efeito.
   * O env.sh exporta o próprio config.env em todo processo, então valor igual ao da tela não conta como fixo. */
  isPinnedByEnv(key: string): boolean {
    const exported = process.env[key];
    return exported !== undefined && exported !== (effectiveConfig(this.dir, {}).get(key) ?? "");
  }

  quietNow(now: Date = new Date(this.now())): boolean {
    const m = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(this.cfg("HADES_NOTIFY_QUIET"));
    if (!m) return false;
    const from = Number(m[1]) * 60 + Number(m[2]);
    const to = Number(m[3]) * 60 + Number(m[4]);
    const t = now.getHours() * 60 + now.getMinutes();
    return from <= to ? from <= t && t < to : t >= from || t < to;
  }

  ntfyBase(): string {
    return (this.cfg("HADES_NOTIFY_NTFY_URL") || DEFAULT_NTFY_URL).replace(/\/+$/, "");
  }
}

// ---------------------------------------------------------------- tópico (segredo do ntfy)
export function rotateTopic(ctx: NotifyContext): string {
  const topic = `hades-${randomBytes(18).toString("base64url")}`;
  mkdirSync(ctx.dir, { recursive: true });
  const tmp = join(ctx.dir, "ntfy.topic.tmp");
  writeFileSync(tmp, `${topic}\n`, { mode: 0o600 });
  renameSync(tmp, ctx.topicFile);
  chmodSync(ctx.topicFile, 0o600);
  return topic;
}

export function topic(ctx: NotifyContext, create = true): string {
  const current = (readText(ctx.topicFile) ?? "").trim();
  if (current) return current;
  return create ? rotateTopic(ctx) : "";
}

// ---------------------------------------------------------------- mensagem
const clip = (text: string, limit: number): string => {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
};

/** Mensagem sem URL, e-mail, token nem caminho da casa: o texto sai da máquina para o ntfy. */
export function scrub(value: unknown, limit = 140): string {
  let text = String(value);
  text = text.replace(/https?:\/\/\S+/g, "[url]");
  text = text.replace(/[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu, "[email]");
  text = text.replaceAll(process.env.HOME || homedir(), "~");
  text = text.replace(/[A-Za-z0-9_+/=-]{24,}/g, "[…]");
  return clip(text.split(/\s+/).filter(Boolean).join(" "), limit);
}

const latin1 = (text: string): string => Array.from(text, (ch) => ((ch.codePointAt(0) as number) > 255 ? "?" : ch)).join("");

/** notify-send em unit de usuário não herda a sessão: acha o barramento e o display em /run/user. */
function desktopEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const runDir = join("/run/user", String(process.getuid?.() ?? ""));
  if (!env.DBUS_SESSION_BUS_ADDRESS && existsSync(join(runDir, "bus"))) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runDir}/bus`;
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) {
    const sockets = listWaylandSockets(runDir);
    if (sockets[0]) env.WAYLAND_DISPLAY = sockets[0];
    else if (existsSync("/tmp/.X11-unix/X0")) env.DISPLAY = ":0";
  }
  return env;
}

const listWaylandSockets = (runDir: string): string[] =>
  listDir(runDir).filter((name) => name.startsWith("wayland-") && !name.endsWith(".lock"));

/** macOS: osascript recebe o texto por argv (item 1 e 2 do `on run`), nunca montado dentro do script. */
function sendDesktopMac(title: string, body: string): string {
  const exe = which("osascript");
  if (!exe) return "ausente";
  const script = ["on run argv", "display notification (item 1 of argv) with title (item 2 of argv)", "end run"].flatMap((line) => ["-e", line]);
  const r = spawnSync(exe, [...script, "--", body, title], { stdio: "ignore", timeout: DESKTOP_TIMEOUT_MS });
  return r.error || r.status !== 0 ? "sem sessão" : "ok";
}

function sendDesktop(ctx: NotifyContext, title: string, body: string, sev: Severity): string {
  if (managerKind() === "launchd") return sendDesktopMac(title, body);
  const exe = which("notify-send");
  if (!exe) return "ausente";
  const icon = join(ctx.dir, "panel", "ui", "brand", "icon-192.png");
  const args = ["-a", "Hades", "-u", SEVERITIES[sev].urg, ...(existsSync(icon) ? ["-i", icon] : []), "--", title, body];
  const r = spawnSync(exe, args, { env: desktopEnv(), stdio: "ignore", timeout: DESKTOP_TIMEOUT_MS });
  // sem sessão gráfica (linger no boot) é esperado: falha calada
  return r.error || r.status !== 0 ? "sem sessão" : "ok";
}

async function sendNtfy(ctx: NotifyContext, title: string, body: string, sev: Severity): Promise<string> {
  const url = `${ctx.ntfyBase()}/${topic(ctx)}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      body,
      headers: { Title: latin1(title), Priority: SEVERITIES[sev].prio, Tags: `${SEVERITIES[sev].tag},hades` },
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
    return response.ok ? "ok" : `http ${response.status}`;
  } catch (error) {
    // a exceção pode carregar a URL (com o tópico): só o tipo vai para o histórico
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return `falhou: ${timedOut ? "TimeoutError" : "URLError"}`;
  }
}

// ---------------------------------------------------------------- estado (histórico e dedupe), sob lock
function locked<T>(ctx: NotifyContext, fn: () => Promise<T>, waitSeconds?: number): Promise<T> {
  mkdirSync(ctx.state, { recursive: true });
  return withFlockAsync(ctx.lockFile, fn, waitSeconds);
}

export function jload<T>(path: string, fallback: T): T {
  const text = readText(path);
  if (text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function jsave(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, pyDumps(data));
  renameSync(tmp, path);
}

export function history(ctx: NotifyContext, count = KEEP): HistoryEntry[] {
  const text = readText(ctx.history);
  if (text === undefined) return [];
  const entries: HistoryEntry[] = [];
  for (const line of splitLines(text).slice(-count).reverse()) {
    try {
      entries.push(JSON.parse(line) as HistoryEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

function record(ctx: NotifyContext, entry: HistoryEntry): void {
  const lines = [...splitLines(readText(ctx.history) ?? ""), pyDumps(entry)].slice(-KEEP);
  writeFileSync(ctx.history, `${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------- envio
export interface NotifyOptions {
  obj?: string;
  sig?: string;
  src?: string;
  test?: boolean;
}

const isSeverity = (value: string): value is Severity => value in SEVERITIES;
const hhmm = (nowMs: number): string => {
  const now = new Date(nowMs);
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
};

/** Manda pelos canais do evento. Dedupe por evento+objeto: só reenvia se o estado (sig) mudou ou passou a janela.
 * `test` ignora chave geral, switches, silêncio e dedupe. */
export async function notify(ctx: NotifyContext, event: string, severity: string, rawText: string, options: NotifyOptions = {}): Promise<NotifyResult> {
  const sev: Severity = isSeverity(severity) ? severity : "info";
  const obj = scrub(options.obj || event, 60);
  const text = scrub(rawText);
  const test = options.test === true;
  if (!test) {
    if (ctx.cfg("HADES_NOTIFY") !== "1") return { sent: false, why: "HADES_NOTIFY desligado" };
    if (ctx.eventChannels(event) === "off") return { sent: false, why: "evento desligado" };
  }
  const sig = options.sig || createHash("sha1").update(`${sev}|${text}`).digest("hex").slice(0, 12);
  const key = `${event}|${obj}`;
  const wait = ctx.cint("HADES_NOTIFY_LOCK_WAIT_S", DEFAULT_LOCK_WAIT_S);
  // A rede fica fora do lock: reserva o dedupe, solta, envia e volta ao lock só para gravar o histórico.
  const reserved = await lockedOrBusy(ctx, async () => {
    const now = ctx.now() / 1000;
    const stored = jload<Record<string, DedupeEntry>>(ctx.dedupe, {});
    const dedupe = Object.fromEntries(Object.entries(stored).filter(([, v]) => now - (v.ts ?? 0) < DEDUPE_TTL_S));
    const old = dedupe[key];
    if (!test && old && old.sig === sig && now - old.ts < ctx.cint("HADES_NOTIFY_DEDUPE_MIN", DEFAULT_DEDUPE_MIN) * 60) return undefined;
    dedupe[key] = { ts: now, sig, src: options.src ?? "" };
    jsave(ctx.dedupe, dedupe);
    return now;
  }, wait);
  if (reserved === BUSY) return { sent: false, why: "lock do notify ocupado" };
  if (reserved === undefined) return { sent: false, why: WHY_REPEATED };
  const channel = test ? "both" : ctx.eventChannels(event);
  const wantDesktop = channel === "both" || channel === "desktop";
  const wantPhone = channel === "both" || channel === "phone";
  const channels: Channels = {};
  const title = `Hades · ${EVENTS[event] ?? event}`;
  const clockText = hhmm(ctx.now());
  const body = obj !== event ? `${obj}: ${text} (${clockText})` : `${text} (${clockText})`;
  if (wantDesktop) channels.desktop = ctx.cfg("HADES_NOTIFY_DESKTOP") === "1" ? sendDesktop(ctx, title, body, sev) : "desligado";
  if (wantPhone) {
    if (ctx.cfg("HADES_NOTIFY_NTFY") !== "1") channels.phone = "desligado";
    else if (!test && ctx.quietNow()) channels.phone = "silêncio";
    else channels.phone = await sendNtfy(ctx, title, body, sev);
  }
  // O aviso já saiu: lock ocupado na volta só perde a linha do histórico.
  await lockedOrBusy(ctx, async () => record(ctx, { ts: Math.trunc(reserved), event, sev, obj, text, channels }), wait);
  return { sent: true, channels };
}

const BUSY = Symbol("lock do notify ocupado");

/** Seção sob o lock com prazo. Quem manda (agent decide, vigia) não fica preso ao lock de outro processo: aviso perdido é
 * melhor que processo que não sai. */
async function lockedOrBusy<T>(ctx: NotifyContext, fn: () => Promise<T>, waitSeconds: number): Promise<T | typeof BUSY> {
  try {
    return await locked(ctx, fn, waitSeconds);
  } catch (error) {
    if (error instanceof FlockTimeoutError) return BUSY;
    throw error;
  }
}

/** Problema que sumiu: apaga a marca do dedupe, para a próxima ocorrência avisar na hora. */
export async function forget(ctx: NotifyContext, src: string, keep: Set<string>): Promise<void> {
  // lock ocupado: a marca fica até o próximo ciclo do vigia
  await lockedOrBusy(ctx, async () => {
    const dedupe = jload<Record<string, DedupeEntry>>(ctx.dedupe, {});
    const gone = Object.keys(dedupe).filter((k) => dedupe[k]?.src === src && !keep.has(k));
    for (const k of gone) delete dedupe[k];
    if (gone.length > 0) jsave(ctx.dedupe, dedupe);
  }, ctx.cint("HADES_NOTIFY_LOCK_WAIT_S", DEFAULT_LOCK_WAIT_S));
}

// ---------------------------------------------------------------- status (CLI e painel)
export interface Heartbeat {
  ts?: number;
  pid?: number;
  gate_off?: number;
  sources?: Record<string, { ts: number; err: string | null }>;
}

export function status(ctx: NotifyContext, reveal = false): Record<string, unknown> {
  const beat = jload<Heartbeat>(ctx.beat, {});
  const t = topic(ctx, false);
  const state = serviceManager().activeState(ctx.unit) || "inactive";
  return {
    enabled: ctx.cfg("HADES_NOTIFY") === "1",
    unit: ctx.unit,
    unitState: state,
    beatAge: beat.ts ? Math.trunc(Date.now() / 1000 - beat.ts) : null,
    sources: beat.sources ?? {},
    desktop: ctx.cfg("HADES_NOTIFY_DESKTOP") === "1",
    ntfy: ctx.cfg("HADES_NOTIFY_NTFY") === "1",
    server: ctx.ntfyBase(),
    hasTopic: t !== "",
    topic: reveal ? t : null,
    subscribe: reveal && t ? `${ctx.ntfyBase()}/${t}` : null,
    quiet: ctx.cfg("HADES_NOTIFY_QUIET"),
    quietNow: ctx.quietNow(),
    qr: which("qrencode") !== undefined,
    events: SWITCHABLE_EVENTS.map((event) => ({
      event,
      label: EVENT_LABELS[event] ?? EVENTS[event],
      channels: ctx.eventChannels(event),
      pinnedByEnv: ctx.isPinnedByEnv(evKey(event)),
    })),
    history: history(ctx),
  };
}

export const readBeat = (ctx: NotifyContext): Heartbeat => jload<Heartbeat>(ctx.beat, {});
