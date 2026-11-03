// Terminal do painel (reference/panel.md §Terminal): sessões PTY (Bun.spawn com `terminal`), anel de saída com offset
// absoluto para retomar depois de reconectar, teto de sessões, encerramento por inatividade e grupo de processos morto no
// fim. Não conhece HTTP nem WebSocket (term-http.ts): quem fala com o cliente é uma `TermAttachment`.
// Nunca guarda nem registra o que foi digitado ou impresso além do anel em memória.
import { randomBytes } from "node:crypto";
import { accessSync, appendFileSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { which } from "../lib/proc.ts";
import { createRateLimiter } from "./argos-terminals.ts";
import { createRing, type Ring } from "./term-ring.ts";
import {
  TERM_CLOSE, TERM_CODES, TERM_KINDS, TERM_LIMITS, TERM_PROTOCOL_VERSION, TermError, type TermClientMessage, type TermKind, type TermServerMessage,
} from "./term-protocol.ts";

export type TermOrigin = "local" | "remote";
type LogAction = "abrir" | "anexar" | "fechar" | "expirar" | "recusar";

const ID_BYTES = 16;
const PATH_MAX = 4096;
const LOG_FIELD_MAX = 256;
const SWEEP_MS = 15_000;
const MS_PER_MIN = 60_000;
const SCROLLBACK_DEFAULT_KB = 256;
const MAX_DEFAULT = 4;
const IDLE_DEFAULT_MIN = 30;
const BYTES_PER_KB = 1024;
const RESUME_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HERDR_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_HERDR_SESSION = "default";
const FALLBACK_SHELL = "/bin/sh";

/** O pedaço do processo que o gerenciador usa: o `Bun.spawn` com `terminal`, atrás de uma interface para o teste trocar. */
export interface TermProc {
  readonly pid: number;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface SpawnSpec { argv: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
export type TermSpawn = (spec: SpawnSpec, onData: (chunk: Uint8Array) => void) => TermProc;

export function bunSpawn(spec: SpawnSpec, onData: (chunk: Uint8Array) => void): TermProc {
  const proc = Bun.spawn(spec.argv, {
    cwd: spec.cwd, env: spec.env, terminal: { cols: spec.cols, rows: spec.rows, data: (_terminal, chunk) => onData(chunk) },
  });
  const terminal = proc.terminal;
  if (!terminal) throw new Error("o Bun não abriu o terminal do processo");
  return {
    pid: proc.pid,
    write: (data) => { if (!terminal.closed) terminal.write(data); },
    resize: (cols, rows) => { if (!terminal.closed) terminal.resize(cols, rows); },
    close: () => { if (!terminal.closed) terminal.close(); },
    exited: proc.exited.then((code) => ({ code: proc.signalCode ? null : code, signal: proc.signalCode === null ? null : String(proc.signalCode) })),
  };
}

/** Quem fala com o cliente (o WebSocket, no painel). `buffered` é a fila de envio ainda não escoada. */
export interface TermAttachment {
  send(chunk: Uint8Array): void;
  sendJson(message: TermServerMessage): void;
  buffered(): number;
  close(code: number, reason: string): void;
}

/** O que o cliente anexado usa: entrada crua, mensagem de controle (texto) e o `drain` do socket. */
export interface TermLink {
  input(bytes: Uint8Array): void;
  control(text: string): void;
  drain(): void;
  detach(): void;
}

export interface TermInfo {
  id: string;
  kind: TermKind;
  cwd: string;
  startedAt: string;
  lastUsedAt: string;
  origin: TermOrigin;
  state: "running" | "exited";
  cols: number;
  rows: number;
  attached: boolean;
}

export interface OpenRequest { kind: TermKind; cwd?: string; cols?: number; rows?: number; resume?: string; session?: string }

export interface TermDeps {
  /** $D: o log fica em $D/logs/panel-term.log */
  dataDir: string;
  config: () => Record<string, string>;
  /** pastas onde uma sessão pode abrir: o clone principal, as worktrees de agente registradas e $D */
  roots: () => string[];
  defaultCwd: string;
  notify: (message: string, state: string) => Promise<void>;
  now?: () => number;
  /** erro operacional do painel (log do painel; o log do terminal é o arquivo) */
  log: (level: "info" | "warn" | "error", event: string, fields?: Record<string, string | number | boolean | null>) => void;
  spawn?: TermSpawn;
  /** sobrescreve o comando de cada tipo (teste); undefined = o comando real */
  command?: (kind: TermKind, req: OpenRequest) => string[] | undefined;
  environment?: () => Record<string, string | undefined>;
}

interface Attach { attachment: TermAttachment; link: TermLink; sent: number; finished: boolean }

interface Session {
  id: string;
  kind: TermKind;
  cwd: string;
  startedAt: number;
  lastUsedAt: number;
  origin: TermOrigin;
  proc: TermProc;
  ring: Ring;
  cols: number;
  rows: number;
  state: "running" | "exited";
  exit?: { code: number | null; signal: string | null };
  closing: boolean;
  /** O dono já foi avisado de um anexo remoto desta sessão (um aviso por sessão). */
  remoteAttachNotified?: boolean;
  attach?: Attach;
  reapTimer?: ReturnType<typeof setTimeout>;
}

const intOf = (text: string | undefined, fallback: number, min: number): number => {
  const value = Number.parseInt(text ?? "", 10);
  return Number.isInteger(value) && value >= min ? value : fallback;
};

const within = (value: unknown, range: { min: number; max: number; def: number }, name: string): number => {
  if (value === undefined) return range.def;
  if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw new TermError(TERM_CODES.badRequest, `${name} deve ser inteiro entre ${range.min} e ${range.max}`);
  }
  return value;
};

export function createTerm(deps: TermDeps) {
  const now = deps.now ?? Date.now;
  const spawn = deps.spawn ?? bunSpawn;
  const sessions = new Map<string, Session>();
  const opens = createRateLimiter({ max: TERM_LIMITS.opensPerMinute, windowMs: MS_PER_MIN }, now);
  const logFile = join(deps.dataDir, "logs", "panel-term.log");
  let sweeper: ReturnType<typeof setInterval> | undefined;

  // ------------------------------------------------------------------ log do terminal (nunca conteúdo)
  function record(action: LogAction, fields: { kind?: string; cwd?: string; origin: TermOrigin; id?: string; code?: string }): void {
    const line = `${JSON.stringify({ t: new Date(now()).toISOString(), action, kind: fields.kind ?? "-", cwd: fields.cwd ?? "-", origin: fields.origin, id: fields.id ?? "-", ...(fields.code ? { code: fields.code } : {}) })}\n`;
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(logFile, line, { mode: 0o600 });
    } catch (error) {
      deps.log("error", "log do terminal não gravou", { reason: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Registra a recusa (só tipo, pasta e código, nunca o corpo do pedido). */
  const noteRefusal = (error: TermError, origin: TermOrigin, req?: { kind?: unknown; cwd?: unknown }): void => {
    record("recusar", { kind: typeof req?.kind === "string" ? req.kind.slice(0, LOG_FIELD_MAX) : undefined, cwd: typeof req?.cwd === "string" ? req.cwd.slice(0, LOG_FIELD_MAX) : undefined, origin, code: error.code });
  };

  const refuse = (error: TermError, origin: TermOrigin, req?: { kind?: unknown; cwd?: unknown }): never => {
    noteRefusal(error, origin, req);
    throw error;
  };

  // ------------------------------------------------------------------ configuração e validação
  const enabled = (): boolean => deps.config().HADES_TERMINAL === "1";
  const maxSessions = (): number => intOf(deps.config().HADES_TERMINAL_MAX, MAX_DEFAULT, 1);
  const idleMs = (): number => intOf(deps.config().HADES_TERMINAL_IDLE_MIN, IDLE_DEFAULT_MIN, 0) * MS_PER_MIN;
  const scrollbackBytes = (): number => intOf(deps.config().HADES_TERMINAL_SCROLLBACK_KB, SCROLLBACK_DEFAULT_KB, 1) * BYTES_PER_KB;
  const live = (): Session[] => [...sessions.values()].filter((s) => s.state === "running");

  const realRoots = (): string[] => {
    const out: string[] = [];
    for (const root of deps.roots()) {
      try {
        out.push(realpathSync(root));
      } catch {
        continue;
      }
    }
    return out;
  };

  /** O `cwd` pedido (ou o clone principal) já resolvido por `realpath` e conferido dentro de uma raiz permitida. */
  function resolveCwd(requested: unknown): string {
    const wanted = requested === undefined ? deps.defaultCwd : requested;
    if (typeof wanted !== "string" || wanted === "" || wanted.length > PATH_MAX || wanted.includes("\0") || !isAbsolute(wanted)) {
      throw new TermError(TERM_CODES.badRequest, "cwd deve ser um caminho absoluto");
    }
    let real: string;
    try {
      real = realpathSync(wanted);
      if (!statSync(real).isDirectory()) throw new Error("não é pasta");
    } catch {
      throw new TermError(TERM_CODES.forbiddenCwd, "pasta fora da lista permitida para o terminal");
    }
    if (!realRoots().some((root) => real === root || real.startsWith(root + sep))) {
      throw new TermError(TERM_CODES.forbiddenCwd, "pasta fora da lista permitida para o terminal");
    }
    return real;
  }

  function shellPath(): string {
    const configured = (deps.environment?.() ?? process.env).SHELL;
    return configured && isAbsolute(configured) && isExecutable(configured) ? configured : FALLBACK_SHELL;
  }

  function claudeBin(): string | undefined {
    const configured = (deps.config().HADES_CHAT_BIN ?? "").replace(/^~(?=$|\/)/, homedir());
    // caminho configurado que não existe ou não executa é "binário indisponível" (422), não falha de spawn (500)
    if (configured) return isExecutable(configured) ? configured : undefined;
    return which("claude");
  }

  /** argv em lista, nunca string de shell. undefined = o binário do tipo não existe nesta máquina. */
  function commandFor(req: OpenRequest): string[] | undefined {
    const override = deps.command?.(req.kind, req);
    if (override) return override;
    if (req.kind === "shell") return [shellPath()];
    if (req.kind === "claude") {
      const bin = claudeBin();
      if (!bin) return undefined;
      return [bin, "--permission-mode", "auto", ...(req.resume ? ["--resume", req.resume] : [])];
    }
    const herdr = which("herdr");
    const session = req.session ?? DEFAULT_HERDR_SESSION;
    return herdr ? [herdr, "--session", session] : undefined;
  }

  function parseRequest(body: Record<string, unknown>): OpenRequest {
    const kind = body.kind;
    if (typeof kind !== "string" || !(TERM_KINDS as readonly string[]).includes(kind)) throw new TermError(TERM_CODES.badRequest, "kind inválido");
    const text = (name: string): string | undefined => {
      const value = body[name];
      if (value === undefined) return undefined;
      if (typeof value !== "string" || value.length > TERM_LIMITS.resumeIdMax || value.includes("\0")) throw new TermError(TERM_CODES.badRequest, `${name} inválido`);
      return value;
    };
    const extra = { resume: text("resume"), session: text("session") };
    if (extra.resume !== undefined && !RESUME_ID.test(extra.resume)) throw new TermError(TERM_CODES.badRequest, "resume inválido");
    if (extra.session !== undefined && !HERDR_SESSION.test(extra.session)) throw new TermError(TERM_CODES.badRequest, "session inválida");
    if (extra.resume !== undefined && kind !== "claude") throw new TermError(TERM_CODES.badRequest, "resume só vale para o tipo claude");
    if (extra.session !== undefined && kind !== "herdr-client") throw new TermError(TERM_CODES.badRequest, "session só vale para o tipo herdr-client");
    return {
      kind: kind as TermKind, cwd: typeof body.cwd === "string" ? body.cwd : undefined,
      cols: within(body.cols, TERM_LIMITS.cols, "cols"), rows: within(body.rows, TERM_LIMITS.rows, "rows"), ...extra,
    };
  }

  // ------------------------------------------------------------------ ciclo de vida
  function killGroup(pid: number): void {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        return;
      }
    }, TERM_LIMITS.killGraceMs);
    timer.unref();
  }

  function flush(s: Session): void {
    const a = s.attach;
    if (!a) return;
    if (a.sent < s.ring.start) {
      a.attachment.sendJson({ t: "warn", code: TERM_CODES.outputTruncated, message: "saída antiga descartada pelo anel", offset: s.ring.start, lost: s.ring.start - a.sent });
      a.sent = s.ring.start;
    }
    while (a.sent < s.ring.end && a.attachment.buffered() < TERM_LIMITS.sendHighWater) {
      const chunk = s.ring.read(a.sent, TERM_LIMITS.frameBytes);
      a.attachment.send(chunk);
      a.sent += chunk.length;
    }
    if (s.state === "exited" && s.exit && a.sent >= s.ring.end && !a.finished) {
      a.finished = true;
      a.attachment.sendJson({ t: "exit", code: s.exit.code, signal: s.exit.signal });
      a.attachment.close(TERM_CLOSE.exited, "exited");
    }
  }

  function markExited(s: Session, exit: { code: number | null; signal: string | null }): void {
    if (s.state === "exited" || s.closing) return;
    s.state = "exited";
    s.exit = exit;
    s.proc.close();
    // sobras do grupo (jobs em segundo plano) não ficam órfãs
    killGroup(s.proc.pid);
    flush(s);
    s.reapTimer = setTimeout(() => sessions.delete(s.id), TERM_LIMITS.exitedKeepMs);
    s.reapTimer.unref();
  }

  function end(s: Session, action: "fechar" | "expirar", closeCode: number): void {
    if (s.closing) return;
    s.closing = true;
    record(action, { kind: s.kind, cwd: s.cwd, origin: s.origin, id: s.id });
    s.attach?.attachment.close(closeCode, action);
    s.attach = undefined;
    s.proc.close();
    killGroup(s.proc.pid);
    if (s.reapTimer) clearTimeout(s.reapTimer);
    sessions.delete(s.id);
  }

  async function open(body: Record<string, unknown>, origin: TermOrigin): Promise<TermInfo> {
    let req: OpenRequest;
    try {
      if (!enabled()) throw new TermError(TERM_CODES.disabled, "o terminal está desligado: ligue HADES_TERMINAL=1 em Configurações → Terminal, pelo painel local");
      req = parseRequest(body);
      // o ritmo limita quem vem de fora; no painel local o teto de sessões já basta (o dono é quem digita)
      const wait = origin === "remote" ? opens.take(origin) : undefined;
      if (wait !== undefined) throw new TermError(TERM_CODES.rateLimited, "muitas sessões abertas em pouco tempo", wait);
      if (live().length >= maxSessions()) throw new TermError(TERM_CODES.maxSessions, `teto de ${maxSessions()} sessões abertas (HADES_TERMINAL_MAX)`);
    } catch (error) {
      if (error instanceof TermError) return refuse(error, origin, body as { kind?: unknown; cwd?: unknown });
      throw error;
    }
    let cwd: string;
    let argv: string[] | undefined;
    try {
      cwd = resolveCwd(req.cwd);
      argv = commandFor(req);
      if (!argv) throw new TermError(TERM_CODES.kindUnavailable, `o comando do tipo ${req.kind} não está instalado nesta máquina`);
    } catch (error) {
      if (error instanceof TermError) return refuse(error, origin, body as { kind?: unknown; cwd?: unknown });
      throw error;
    }
    const id = randomBytes(ID_BYTES).toString("hex");
    const cols = req.cols ?? TERM_LIMITS.cols.def;
    const rows = req.rows ?? TERM_LIMITS.rows.def;
    const ring = createRing(scrollbackBytes());
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(deps.environment?.() ?? process.env)) if (value !== undefined) env[key] = value;
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    let proc: TermProc;
    try {
      proc = spawn({ argv, cwd, env, cols, rows }, (chunk) => {
        ring.write(chunk);
        const s = sessions.get(id);
        if (s) flush(s);
      });
    } catch (error) {
      deps.log("error", "terminal não subiu", { kind: req.kind, reason: error instanceof Error ? error.message : String(error) });
      return refuse(new TermError(TERM_CODES.spawnFailed, "o processo do terminal não subiu (detalhe no log do painel)"), origin, req);
    }
    const t = now();
    const s: Session = { id, kind: req.kind, cwd, startedAt: t, lastUsedAt: t, origin, proc, ring, cols, rows, state: "running", closing: false };
    sessions.set(id, s);
    void proc.exited.then((exit) => markExited(s, exit));
    record("abrir", { kind: s.kind, cwd, origin, id });
    if (origin === "remote") {
      deps.notify(`terminal aberto de fora: ${s.kind} em ${cwd} às ${new Date(t).toISOString()}`, `term:${id}`).catch((error: unknown) => {
        deps.log("warn", "aviso do terminal não saiu", { reason: error instanceof Error ? error.message : String(error) });
      });
    }
    return info(s);
  }

  const info = (s: Session): TermInfo => ({
    id: s.id, kind: s.kind, cwd: s.cwd, startedAt: new Date(s.startedAt).toISOString(), lastUsedAt: new Date(s.lastUsedAt).toISOString(),
    origin: s.origin, state: s.state, cols: s.cols, rows: s.rows, attached: s.attach !== undefined,
  });

  function get(id: unknown): Session {
    const s = typeof id === "string" ? sessions.get(id) : undefined;
    if (!s || s.closing) throw new TermError(TERM_CODES.unknownSession, "sessão de terminal inexistente");
    return s;
  }

  function close(id: unknown, origin: TermOrigin): void {
    let s: Session;
    try {
      s = get(id);
    } catch (error) {
      if (error instanceof TermError) return refuse(error, origin);
      throw error;
    }
    end(s, "fechar", TERM_CLOSE.closed);
  }

  function applyResize(s: Session, cols: unknown, rows: unknown): void {
    const c = within(cols, TERM_LIMITS.cols, "cols");
    const r = within(rows, TERM_LIMITS.rows, "rows");
    s.cols = c;
    s.rows = r;
    s.lastUsedAt = now();
    if (s.state === "running") s.proc.resize(c, r);
  }

  /**
   * Avisa o dono no primeiro anexo remoto de uma sessão que não foi aberta de fora (a aberta de fora já avisou no
   * `open`): sem isso, uma sessão local anexada pelo túnel daria o mesmo shell sem aviso. Só tipo, pasta e hora.
   */
  function noteRemoteAttach(s: Session, origin: TermOrigin): void {
    if (origin !== "remote" || s.origin === "remote" || s.remoteAttachNotified) return;
    s.remoteAttachNotified = true;
    deps.notify(`terminal anexado de fora: ${s.kind} em ${s.cwd} às ${new Date(now()).toISOString()}`, `term-attach:${s.id}`).catch((error: unknown) => {
      deps.log("warn", "aviso do terminal não saiu", { reason: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Anexa o cliente. Outro já anexado é fechado (4001): uma tela por sessão. `offset` ausente = tudo o que o anel guarda. */
  function attach(id: unknown, offset: number | undefined, attachment: TermAttachment, origin: TermOrigin): TermLink {
    const s = get(id);
    record("anexar", { kind: s.kind, cwd: s.cwd, origin, id: s.id });
    noteRemoteAttach(s, origin);
    if (s.attach) s.attach.attachment.close(TERM_CLOSE.replaced, "replaced");
    s.lastUsedAt = now();
    const start = offset === undefined ? s.ring.start : Math.min(Math.max(offset, s.ring.start), s.ring.end);
    const mine: Attach = {
      attachment, sent: start, finished: false,
      link: {
        input(bytes) {
          if (s.attach !== mine || s.state !== "running") return;
          if (bytes.length > TERM_LIMITS.inputBytes) return protocolWarn(mine, "entrada acima do limite por mensagem");
          s.lastUsedAt = now();
          s.proc.write(bytes);
        },
        control(text) {
          if (s.attach !== mine) return;
          controlMessage(s, mine, text);
        },
        drain() { if (s.attach === mine) flush(s); },
        detach() {
          if (s.attach === mine) { s.attach = undefined; s.lastUsedAt = now(); }
        },
      },
    };
    s.attach = mine;
    attachment.sendJson({
      t: "hello", v: TERM_PROTOCOL_VERSION, id: s.id, kind: s.kind, cwd: s.cwd, cols: s.cols, rows: s.rows,
      offset: start, start: s.ring.start, end: s.ring.end, state: s.state,
    });
    if (offset !== undefined && offset < s.ring.start) {
      attachment.sendJson({ t: "warn", code: TERM_CODES.offsetTruncated, message: "o offset pedido já saiu do anel; segue do mais antigo guardado", requested: offset, offset: s.ring.start, lost: s.ring.start - offset });
    } else if (offset !== undefined && offset > s.ring.end) {
      attachment.sendJson({ t: "warn", code: TERM_CODES.offsetAhead, message: "o offset pedido está à frente da saída; segue do fim", requested: offset, offset: s.ring.end });
    }
    flush(s);
    return mine.link;
  }

  function protocolWarn(a: Attach, message: string): void {
    a.attachment.sendJson({ t: "warn", code: TERM_CODES.badMessage, message });
  }

  function controlMessage(s: Session, a: Attach, text: string): void {
    if (text.length > TERM_LIMITS.controlBytes) return protocolWarn(a, "mensagem de controle acima do limite");
    let message: Partial<TermClientMessage> & Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("não é objeto");
      message = parsed as typeof message;
    } catch {
      return protocolWarn(a, "mensagem de controle não é JSON de objeto");
    }
    if (message.t === "ping") return a.attachment.sendJson({ t: "pong" });
    if (message.t === "close") return end(s, "fechar", TERM_CLOSE.closed);
    if (message.t === "resize") {
      try {
        applyResize(s, message.cols, message.rows);
      } catch (error) {
        if (error instanceof TermError) return protocolWarn(a, error.message);
        throw error;
      }
      return;
    }
    protocolWarn(a, "tipo de mensagem desconhecido");
  }

  /** Fecha as sessões sem cliente mexendo há mais que o limite (entrada, resize ou conexão; saída e ping não contam). */
  function sweep(): void {
    // a chave desligada fecha o que está aberto: o dono não fica com sessão viva depois de desligar
    if (!enabled()) {
      for (const s of [...sessions.values()]) end(s, "fechar", TERM_CLOSE.closed);
      return;
    }
    const limit = idleMs();
    if (limit === 0) return;
    for (const s of [...sessions.values()]) if (s.state === "running" && now() - s.lastUsedAt >= limit) end(s, "expirar", TERM_CLOSE.expired);
  }

  function list(): { enabled: boolean; max: number; idleMin: number; scrollbackKb: number; active: number; roots: string[]; sessions: TermInfo[] } {
    return {
      enabled: enabled(), max: maxSessions(), idleMin: idleMs() / MS_PER_MIN, scrollbackKb: scrollbackBytes() / BYTES_PER_KB, active: live().length,
      roots: realRoots(), sessions: [...sessions.values()].filter((s) => !s.closing).map(info),
    };
  }

  function start(): void {
    sweeper ??= setInterval(sweep, SWEEP_MS);
    sweeper.unref();
  }

  function stop(): void {
    if (sweeper) clearInterval(sweeper);
    sweeper = undefined;
    for (const s of [...sessions.values()]) {
      s.attach?.attachment.close(TERM_CLOSE.shutdown, "shutdown");
      s.attach = undefined;
      s.closing = true;
      s.proc.close();
      killGroup(s.proc.pid);
      if (s.reapTimer) clearTimeout(s.reapTimer);
    }
    sessions.clear();
  }

  const has = (id: string): boolean => {
    const s = sessions.get(id);
    return s !== undefined && !s.closing;
  };

  return { open, close, attach, list, sweep, start, stop, enabled, has, noteRefusal };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export type Term = ReturnType<typeof createTerm>;
