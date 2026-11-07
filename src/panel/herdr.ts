// O herdr ativo na máquina inteira (qualquer sessão), com leitura em cache curto. Argumentos sempre em lista (nunca shell).
import { which } from "../lib/proc.ts";
import { exec } from "./exec.ts";

const TTL_S = 3;
const CALL_TIMEOUT_MS = 8000;

type Dict = Record<string, unknown>;
export interface HerdrCall {
  rc: number;
  out: string;
  err: string;
}

export interface Herdr {
  /** Binário que o painel chama (HADES_HERDR_BIN): nome simples (resolvido no PATH) ou caminho absoluto. */
  readonly bin: string;
  /** O binário existe (caminho absoluto) ou está no PATH. */
  installed(): boolean;
  call(session: string | null, args: string[], timeoutMs?: number): Promise<HerdrCall>;
  json(session: string | null, args: string[]): Promise<Dict | null>;
  cached<T>(key: string, load: () => Promise<T>, ttlS?: number): Promise<T>;
  snap(session: string): Promise<Dict | null>;
  /** Descarta uma entrada do cache (ou todas, sem chave): a próxima leitura vê o efeito de uma escrita. */
  forget(key?: string): void;
  badge(): Promise<{ working: number; blocked: number } | null>;
  /**
   * Sobe um `herdr server` fora do processo (e do cgroup) do painel e devolve como: reiniciar o painel não o derruba.
   * Só dispara; quem chama espera o socket responder.
   */
  startServer(): Promise<"systemd-run" | "detached">;
}

function errorMessage(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    const error = (parsed as Dict | null)?.error;
    const message = (error as Dict | undefined)?.message;
    return typeof message === "string" && message ? message : undefined;
  } catch {
    return undefined;
  }
}

/** Teto de uma linha da API de socket: um quadro visível em ANSI cabe com folga; acima disso é erro, não truncamento. */
export const SOCKET_LINE_MAX = 4 * 1024 * 1024;
const SOCKET_REQUEST_ID = "hades-panel";

/** Falha numa chamada ao socket do herdr: `code` é o do herdr (`pane_not_found`, `invalid_key`…) ou um dos locais abaixo. */
export class HerdrSocketError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export const SOCKET_ERRORS = { timeout: "timeout", closed: "closed", unreachable: "unreachable", tooLarge: "too_large", badReply: "bad_reply" } as const;

export interface HerdrSubscription {
  close(): void;
}
export interface SubscriptionHandlers {
  event(name: string, data: Dict): void;
  /** A assinatura caiu sem `close()` (servidor do herdr parou, socket quebrou). */
  closed(reason: string): void;
}
/**
 * A API de socket do herdr (JSON por linha). Medido no 0.8.2: uma requisição por conexão (a segunda linha fica sem
 * resposta) e `events.subscribe` mantém a conexão aberta mandando um evento por linha.
 */
export interface HerdrSocket {
  request(socketPath: string, method: string, params: Dict, timeoutMs?: number): Promise<Dict>;
  subscribe(socketPath: string, subscriptions: Dict[], handlers: SubscriptionHandlers, timeoutMs?: number): Promise<HerdrSubscription>;
}

function replyOf(line: string): Dict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new HerdrSocketError(SOCKET_ERRORS.badReply, "resposta do herdr ilegível");
  }
  const reply = typeof parsed === "object" && parsed !== null ? (parsed as Dict) : {};
  const error = reply.error as Dict | undefined;
  if (error) throw new HerdrSocketError(String(error.code ?? SOCKET_ERRORS.badReply), String(error.message ?? "o herdr recusou"));
  const result = reply.result;
  if (typeof result !== "object" || result === null) throw new HerdrSocketError(SOCKET_ERRORS.badReply, "resposta do herdr sem result");
  return result as Dict;
}

/** Junta os pedaços do socket em linhas; linha acima do teto derruba a conexão em vez de crescer sem limite. */
function lineSplitter(onLine: (line: string) => void, onTooLarge: () => void): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  let pending = "";
  return (chunk) => {
    pending += decoder.decode(chunk, { stream: true });
    let nl = pending.indexOf("\n");
    while (nl >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.trim()) onLine(line);
      nl = pending.indexOf("\n");
    }
    if (pending.length > SOCKET_LINE_MAX) onTooLarge();
  };
}

export function createHerdrSocket(): HerdrSocket {
  const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  function request(socketPath: string, method: string, params: Dict, timeoutMs = CALL_TIMEOUT_MS): Promise<Dict> {
    return new Promise<Dict>((resolve, reject) => {
      let settled = false;
      let socket: { end(): void } | undefined;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.end();
        outcome();
      };
      const timer = setTimeout(() => finish(() => reject(new HerdrSocketError(SOCKET_ERRORS.timeout, `${method}: tempo esgotado`))), timeoutMs);
      const feed = lineSplitter(
        (line) => finish(() => {
          try {
            resolve(replyOf(line));
          } catch (error) {
            reject(error);
          }
        }),
        () => finish(() => reject(new HerdrSocketError(SOCKET_ERRORS.tooLarge, `${method}: resposta grande demais`))),
      );
      Bun.connect({
        unix: socketPath,
        socket: {
          open(s) {
            socket = s;
            if (settled) s.end();
            else s.write(`${JSON.stringify({ id: SOCKET_REQUEST_ID, method, params })}\n`);
          },
          data: (_s, chunk) => feed(chunk),
          close: () => finish(() => reject(new HerdrSocketError(SOCKET_ERRORS.closed, `${method}: o herdr fechou a conexão`))),
          error: (_s, error) => finish(() => reject(new HerdrSocketError(SOCKET_ERRORS.unreachable, `${method}: ${reasonOf(error)}`))),
        },
      }).catch((error: unknown) => finish(() => reject(new HerdrSocketError(SOCKET_ERRORS.unreachable, `${method}: ${reasonOf(error)}`))));
    });
  }

  function subscribe(socketPath: string, subscriptions: Dict[], handlers: SubscriptionHandlers, timeoutMs = CALL_TIMEOUT_MS): Promise<HerdrSubscription> {
    return new Promise<HerdrSubscription>((resolve, reject) => {
      let started = false;
      let ended = false;
      let socket: { end(): void } | undefined;
      const subscription: HerdrSubscription = {
        close() {
          ended = true;
          socket?.end();
        },
      };
      const fail = (error: HerdrSocketError): void => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        socket?.end();
        if (started) handlers.closed(error.message);
        else reject(error);
      };
      const timer = setTimeout(() => fail(new HerdrSocketError(SOCKET_ERRORS.timeout, "events.subscribe: tempo esgotado")), timeoutMs);
      const feed = lineSplitter(
        (line) => {
          if (ended) return;
          if (!started) {
            try {
              replyOf(line);
            } catch (error) {
              fail(error instanceof HerdrSocketError ? error : new HerdrSocketError(SOCKET_ERRORS.badReply, reasonOf(error)));
              return;
            }
            started = true;
            clearTimeout(timer);
            resolve(subscription);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            // um evento ilegível não derruba a assinatura: o próximo quadro relê o pane de qualquer jeito
            console.warn("evento do herdr ilegível, ignorado");
            return;
          }
          const envelope = typeof parsed === "object" && parsed !== null ? (parsed as Dict) : {};
          if (typeof envelope.event === "string" && typeof envelope.data === "object" && envelope.data !== null) {
            handlers.event(envelope.event, envelope.data as Dict);
          }
        },
        () => fail(new HerdrSocketError(SOCKET_ERRORS.tooLarge, "evento do herdr grande demais")),
      );
      Bun.connect({
        unix: socketPath,
        socket: {
          open(s) {
            socket = s;
            if (ended) s.end();
            else s.write(`${JSON.stringify({ id: SOCKET_REQUEST_ID, method: "events.subscribe", params: { subscriptions } })}\n`);
          },
          data: (_s, chunk) => feed(chunk),
          close: () => fail(new HerdrSocketError(SOCKET_ERRORS.closed, "o herdr encerrou a assinatura")),
          error: (_s, error) => fail(new HerdrSocketError(SOCKET_ERRORS.unreachable, reasonOf(error))),
        },
      }).catch((error: unknown) => fail(new HerdrSocketError(SOCKET_ERRORS.unreachable, reasonOf(error))));
    });
  }

  return { request, subscribe };
}

export function createHerdr(options: { bin?: string } = {}): Herdr {
  const bin = options.bin ?? "herdr";
  const cache = new Map<string, { t: number; value: unknown }>();
  const resolved = (): string | undefined => (bin.startsWith("/") ? bin : which(bin));

  const argv = (session: string | null, args: string[]): string[] => [bin, ...(session && session !== "default" ? ["--session", session] : []), ...args];

  async function call(session: string | null, args: string[], timeoutMs = CALL_TIMEOUT_MS): Promise<HerdrCall> {
    const r = await exec(argv(session, args), { timeoutMs });
    if (r.status === 127 || r.timedOut) return { rc: 1, out: "", err: r.timedOut ? "tempo esgotado" : r.stderr };
    // o herdr devolve {"error":{"message"}} na saída de erro ou na padrão
    const message = errorMessage(r.stderr) ?? errorMessage(r.stdout);
    const err = message ?? r.stderr.trim();
    return { rc: r.status, out: r.stdout, err: err || (r.status ? r.stdout.trim() : "") };
  }

  async function json(session: string | null, args: string[]): Promise<Dict | null> {
    const r = await call(session, args);
    if (r.rc !== 0) return null;
    try {
      const result = (JSON.parse(r.out) as Dict).result;
      return result === undefined ? null : (result as Dict);
    } catch {
      return null;
    }
  }

  async function cached<T>(key: string, load: () => Promise<T>, ttlS = TTL_S): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() / 1000 - hit.t < ttlS) return hit.value as T;
    const value = await load();
    cache.set(key, { t: Date.now() / 1000, value });
    return value;
  }

  /** Retrato do servidor da sessão (api snapshot), ou null se estiver fora do ar. */
  const snap = (session: string): Promise<Dict | null> =>
    cached(`${session}\0snap`, async () => ((await json(session, ["api", "snapshot"]))?.snapshot as Dict | undefined) ?? null);

  async function startServer(): Promise<"systemd-run" | "detached"> {
    const server = resolved() ?? bin;
    // unit transitória do usuário: o KillMode do hds-panel mata tudo no cgroup dele, então só `detached` não basta sob systemd.
    // O PATH do gerenciador de usuário costuma não ter ~/.local/bin nem o node do nvm, e os panes do servidor herdam o
    // ambiente dele: sem o PATH do painel, o shell do pane não acha o CLI do agente.
    if (which("systemd-run")) {
      const r = await exec(["systemd-run", "--user", "--collect", "--quiet", `--setenv=PATH=${process.env.PATH ?? ""}`, server, "server"], { timeoutMs: CALL_TIMEOUT_MS });
      if (r.status === 0) return "systemd-run";
    }
    const child = Bun.spawn([server, "server"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    child.unref();
    return "detached";
  }

  return {
    bin,
    installed: () => resolved() !== undefined,
    call,
    json,
    startServer,
    cached,
    snap,
    forget: (key) => (key === undefined ? cache.clear() : void cache.delete(key)),
    async badge() {
      if (!resolved()) return null;
      const retrato = await snap("default");
      if (!retrato) return null;
      const agents = (Array.isArray(retrato.agents) ? retrato.agents : []) as Dict[];
      const count = (status: string): number => agents.filter((a) => a.agent_status === status).length;
      return { working: count("working"), blocked: count("blocked") };
    },
  };
}
