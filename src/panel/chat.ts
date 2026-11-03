// A página Claude: cada mensagem é um `claude -p --output-format stream-json` numa unit transitória <HU>-chat-<id> (systemd-run
// ou plist do launchd, fora do slice, com o PATH do painel), então sobrevive a um restart do painel. A saída crua, mais os marcadores hds_user/hds_end,
// fica em $D/claude/<id>.jsonl e é lida por offset (SSE retomável). O registro (título, custo, tokens, id da sessão do Claude
// Code para --resume) fica em $D/claude/sessions.json e é reconciliado da própria saída, não depende da tela aberta.
import { randomBytes } from "node:crypto";
import { accessSync, appendFileSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pyJsonDumps } from "../lib/kit.ts";
import { home } from "../lib/paths.ts";
import { which } from "../lib/proc.ts";
import { serviceManager } from "../lib/service-manager.ts";
import { ListFailedError } from "../lib/service-manager-ctl.ts";
import { exec, shlexQuote } from "./exec.ts";
import type { PanelEnv } from "./env.ts";
import { BadRequest, send as respond } from "./http.ts";
import { type ChatEvent, type Tokens, chatEvents, pyDumpsUtf8 } from "./chat-events.ts";

type Dict = Record<string, unknown>;

const CHAT_ID = /^[0-9a-f]{8}$/;
const CLAUDE_SESSION = /^[0-9a-f-]{36}$/;
const MAX_TEXT = 20_000;
const MAX_CONCURRENT_DEFAULT = 2;
const TITLE_MAX = 60;
const READ_CHUNK = 1 << 20;
const TAIL_BYTES = 4096;
const POLL_MS = 250;
const KEEP_ALIVE_S = 15;
const LAUNCH_TIMEOUT_MS = 30_000;
const NOTIFY_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 8000;
const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_EFFORT = "high";
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

/** Resposta em andamento ou teto de sessões simultâneas (409). */
export class ChatBusy extends Error {}

export interface SessionMeta {
  id: string;
  title?: string;
  created?: number;
  updated?: number;
  remote?: boolean;
  off?: number;
  cost?: number;
  tokens?: Partial<Tokens>;
  turns?: number;
  claudeSession?: string;
  model?: string;
  lastRemote?: boolean;
  notified?: boolean;
}

type Registry = Record<string, SessionMeta>;

export interface ChatDeps {
  env: PanelEnv;
  /** prefixo da unit; os testes usam skilldev-chat */
  unit: string;
  config(): Record<string, string>;
}

export interface Chat {
  overview(remote: boolean): Promise<Dict>;
  send(sid: string, text: string, remote: boolean): Promise<string>;
  stop(sid: string): Promise<void>;
  remove(sid: string): Promise<void>;
  /** SSE da sessão a partir de um offset; 404 se a sessão não existe */
  stream(req: Request, id: string, offset: string | undefined): Promise<Response>;
  isId(sid: string): boolean;
}

const nowS = (): number => Date.now() / 1000;
const localStamp = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function strictInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) throw new Error(`valor inteiro inválido: ${raw}`);
  return Number.parseInt(raw, 10);
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function titleOf(text: string): string {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  const points = Array.from(flat);
  return points.length > TITLE_MAX ? `${points.slice(0, TITLE_MAX - 1).join("")}…` : flat;
}

/** Exclusão mútua das operações que leem e gravam o registro (o original usava um RLock). */
function createMutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createChat(deps: ChatDeps): Chat {
  const { env, unit } = deps;
  const manager = serviceManager();
  const dir = join(env.dir, "claude");
  const logFile = join(env.dir, "logs", "claude-chat.log");
  const registryFile = join(dir, "sessions.json");
  const locked = createMutex();
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });

  const outFile = (sid: string): string => join(dir, `${sid}.jsonl`);
  const inFile = (sid: string): string => join(dir, `${sid}.in`);

  function load(): Registry {
    try {
      const data: unknown = JSON.parse(readFileSync(registryFile, "utf8"));
      return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Registry) : {};
    } catch {
      return {};
    }
  }

  function save(meta: Registry): void {
    const tmp = `${registryFile}.tmp`;
    writeFileSync(tmp, pyJsonDumps(meta));
    chmodSync(tmp, PRIVATE_FILE);
    renameSync(tmp, registryFile);
  }

  const append = (sid: string, event: Dict): void => appendFileSync(outFile(sid), `${JSON.stringify(event)}\n`);

  /** Sem o texto das mensagens: hora, sessão, origem e custo. */
  function record(sid: string, remote: boolean | undefined, what: string): void {
    mkdirSync(join(env.dir, "logs"), { recursive: true });
    appendFileSync(logFile, `${localStamp()} sessão=${sid} origem=${remote ? "remoto" : "local"} ${what}\n`);
  }

  /** Quando a listagem do gerenciador falha, vale o último conjunto conhecido e nada é recolhido nem encerrado (`listingFailed`). */
  let lastRunning = new Set<string>();
  let listingFailed = false;

  async function active(): Promise<Set<string>> {
    try {
      const running = new Set(await manager.listActiveAsync(`${unit}-`, true));
      manager.collectFinished(`${unit}-`, running);
      lastRunning = new Set([...running].map((name) => name.slice(unit.length + 1)));
      listingFailed = false;
    } catch (error) {
      if (!(error instanceof ListFailedError)) throw error;
      listingFailed = true;
    }
    return lastRunning;
  }

  /** Unit morreu sem o wrapper gravar o fim (Parar, kill, OOM): fecha o turno para a tela não esperar para sempre. */
  function finalize(sid: string, running: Set<string>): void {
    const file = outFile(sid);
    if (listingFailed || !existsSync(file) || running.has(sid)) return;
    const size = statSync(file).size;
    const fd = openSync(file, "r");
    let tail: Buffer;
    try {
      const start = Math.max(0, size - TAIL_BYTES);
      tail = Buffer.alloc(size - start);
      readSync(fd, tail, 0, tail.length, start);
    } finally {
      closeSync(fd);
    }
    const lines = tail.toString("latin1").split("\n").filter((l) => l.trim());
    const last = lines[lines.length - 1];
    if (last !== undefined && !last.includes('"type":"hds_end"')) append(sid, { type: "hds_end", rc: null, stopped: true });
  }

  /** Lê o que a saída ganhou desde o último offset: id da sessão do Claude Code, custo e tokens de cada resposta. */
  function reconcile(sid: string, m: SessionMeta): boolean {
    const file = outFile(sid);
    const off = m.off ?? 0;
    if (!existsSync(file) || statSync(file).size <= off) return false;
    const fd = openSync(file, "r");
    let data: Buffer;
    try {
      data = Buffer.alloc(statSync(file).size - off);
      readSync(fd, data, 0, data.length, off);
    } finally {
      closeSync(fd);
    }
    const end = data.lastIndexOf(0x0a) + 1;
    for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof o !== "object" || o === null || Array.isArray(o)) continue;
      const ev = o as Dict;
      if (ev.type === "hds_user") m.lastRemote = Boolean(ev.remote);
      else if (ev.type === "system" && ev.subtype === "init" && CLAUDE_SESSION.test(String(ev.session_id ?? ""))) {
        m.claudeSession = ev.session_id as string;
        m.model = (ev.model as string | undefined) || m.model;
      } else if (ev.type === "result") applyResult(sid, m, chatEvents(line, false)[0] as ChatEvent);
    }
    m.off = off + end;
    return true;
  }

  function applyResult(sid: string, m: SessionMeta, r: ChatEvent): void {
    const cost = (r.cost as number | null) ?? 0;
    m.cost = Math.round(((m.cost ?? 0) + cost) * 1e6) / 1e6;
    const tokens = r.tokens as Tokens;
    const before = m.tokens ?? {};
    m.tokens = Object.fromEntries((Object.keys(tokens) as (keyof Tokens)[]).map((k) => [k, (before[k] ?? 0) + tokens[k]]));
    m.turns = (m.turns ?? 0) + 1;
    m.updated = nowS();
    record(sid, m.lastRemote, `fim custo=${cost.toFixed(4)} ok=${r.ok ? "sim" : "não"}`);
  }

  async function sessionsUnlocked(): Promise<Registry> {
    const meta = load();
    const running = await active();
    let dirty = false;
    for (const sid of Object.keys(meta)) {
      finalize(sid, running);
      dirty = reconcile(sid, meta[sid] as SessionMeta) || dirty;
    }
    if (dirty) save(meta);
    return meta;
  }

  const sessions = (): Promise<Registry> => locked(sessionsUnlocked);

  async function chatClone(): Promise<string | undefined> {
    const r = await exec(["git", "-C", env.worktree, "worktree", "list", "--porcelain"], { timeoutMs: GIT_TIMEOUT_MS });
    // o primeiro do `git worktree list`: o clone principal, nunca o worktree do Hades
    return r.stdout.split("\n").find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
  }

  async function overview(remote: boolean): Promise<Dict> {
    const cfg = deps.config();
    const meta = await sessions();
    const running = await active();
    const items = Object.values(meta).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    const clone = await chatClone();
    return {
      enabled: cfg.HADES_CHAT === "1", max: strictInt(cfg.HADES_CHAT_MAX, MAX_CONCURRENT_DEFAULT), active: running.size,
      model: cfg.HADES_MODEL_CHAT ?? null, effort: cfg.HADES_EFFORT_CHAT ?? null, remote,
      clone: clone ? clone.slice(clone.lastIndexOf("/") + 1) : null, notify: cfg.HADES_NOTIFY === "1",
      sessions: items.map((m) => ({
        id: m.id, title: m.title ?? null, created: m.created ?? null, updated: m.updated ?? null, remote: Boolean(m.remote), cost: m.cost ?? 0,
        tokens: m.tokens ?? null, turns: m.turns ?? 0, running: running.has(m.id),
      })),
    };
  }

  /** Sinal para o dono perceber uso que não é dele: hora e "sessão remota", nunca o texto. */
  function notifyRemote(sid: string): void {
    exec(["bash", join(env.dir, "notify.sh"), "send", "chat", "warn", "sessão remota", "--obj", "claude", "--state", sid], {
      timeoutMs: NOTIFY_TIMEOUT_MS, env: { ...process.env, HADES_DATA: env.dir },
    }).catch((error: unknown) => console.warn(`aviso remoto do chat falhou: ${error instanceof Error ? error.message : String(error)}`));
  }

  async function sendUnlocked(sid: string, rawText: string, remote: boolean): Promise<{ sid: string; notify: boolean }> {
    const cfg = deps.config();
    if (cfg.HADES_CHAT !== "1") throw new BadRequest("a página Claude está desligada (Configurações → Sessão Claude)");
    const text = rawText.trim();
    if (!text) throw new BadRequest("mensagem vazia");
    if (Array.from(text).length > MAX_TEXT) throw new BadRequest(`mensagem acima de ${MAX_TEXT} caracteres`);
    const configured = (cfg.HADES_CHAT_BIN ?? "").replace(/^~(?=$|\/)/, home());
    const bin = configured || which("claude");
    if (!bin || !executable(bin)) throw new BadRequest("binário claude não encontrado (Configurações → Sessão Claude → Caminho do claude)");
    const clone = await chatClone();
    if (!clone || !existsSync(clone)) throw new BadRequest("clone principal do repositório não encontrado");
    const meta = load();
    let running = await active();
    if (sid) {
      if (!meta[sid]) throw new BadRequest("sessão desconhecida");
      finalize(sid, running);
      reconcile(sid, meta[sid] as SessionMeta);
      if (running.has(sid)) throw new ChatBusy("essa sessão ainda está respondendo");
    }
    const limit = strictInt(cfg.HADES_CHAT_MAX, MAX_CONCURRENT_DEFAULT);
    running = await active();
    if (running.size >= limit) throw new ChatBusy(`já há ${limit} sessões respondendo; espere uma terminar ou aumente o limite nas Configurações`);
    const created = !sid;
    const id = sid || randomBytes(4).toString("hex");
    if (created) meta[id] = { id, title: titleOf(text), created: nowS(), remote, off: 0, cost: 0, tokens: {}, turns: 0 };
    const m = meta[id] as SessionMeta;
    m.updated = nowS();
    m.lastRemote = remote;
    const argv = [
      bin, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "auto",
      "--model", cfg.HADES_MODEL_CHAT || DEFAULT_MODEL, "--effort", cfg.HADES_EFFORT_CHAT || DEFAULT_EFFORT,
      ...(m.claudeSession ? ["--resume", m.claudeSession] : []),
    ];
    const out = outFile(id);
    const input = inFile(id);
    // a mensagem entra pelo stdin: no argv, um texto começando com "-" viraria opção do claude
    writeFileSync(input, text);
    chmodSync(input, PRIVATE_FILE);
    append(id, { type: "hds_user", text, remote, ts: nowS() });
    chmodSync(out, PRIVATE_FILE);
    const script = `"$@"; rc=$?; printf '{"type":"hds_end","rc":%s}\\n' "$rc" >> ${shlexQuote(out)}; exit $rc`;
    const launch = manager.transientArgv({
      unit: `${unit}-${id}`, workdir: clone, stdin: input, stdout: out, argv: ["/bin/bash", "-c", script, "hds-chat", ...argv],
      env: [["PATH", process.env.PATH ?? ""], ["NO_COLOR", "1"], ["TERM", "dumb"], ["HADES_WT", env.worktree], ["HADES_DATA", env.dir]],
    });
    const r = await exec(launch, { timeoutMs: LAUNCH_TIMEOUT_MS });
    if (r.status !== 0) {
      if (created) {
        delete meta[id];
        for (const p of [out, input]) if (existsSync(p)) unlinkSync(p);
        save(meta);
      } else append(id, { type: "hds_end", rc: 127 });
      throw new BadRequest(`${launch[0]} falhou: ${r.stderr.trim().slice(0, 300)}`);
    }
    const notify = remote && !m.notified;
    if (notify) m.notified = true;
    save(meta);
    record(id, remote, "envio");
    return { sid: id, notify };
  }

  async function send(sid: string, text: string, remote: boolean): Promise<string> {
    const done = await locked(() => sendUnlocked(sid, text, remote));
    if (done.notify) notifyRemote(done.sid);
    return done.sid;
  }

  const stop = (sid: string): Promise<void> =>
    locked(async () => {
      if (!load()[sid]) throw new BadRequest("sessão desconhecida");
      await manager.stopTransientAsync(`${unit}-${sid}`);
      finalize(sid, await active());
    });

  /** Só o registro e a nossa saída; o transcript do Claude Code (~/.claude/projects) fica. */
  const remove = (sid: string): Promise<void> =>
    locked(async () => {
      const meta = load();
      if (!meta[sid]) throw new BadRequest("sessão desconhecida");
      if ((await active()).has(sid)) throw new ChatBusy("pare a resposta antes de apagar a sessão");
      delete meta[sid];
      save(meta);
      for (const p of [outFile(sid), inFile(sid)]) if (existsSync(p)) unlinkSync(p);
    });

  /** Eventos novos a partir de `off`: [(offset_depois, evento)] e o novo offset. Deltas de texto só a partir de `deltaFrom`
   *  (a mensagem em curso); o resto da história vem pelos eventos de texto completos. */
  function readEvents(sid: string, off: number, deltaFrom: number | undefined): { events: [number, ChatEvent][]; off: number } {
    const file = outFile(sid);
    if (!existsSync(file)) return { events: [], off };
    const fd = openSync(file, "r");
    let data: Buffer;
    try {
      data = Buffer.alloc(READ_CHUNK);
      data = data.subarray(0, readSync(fd, data, 0, READ_CHUNK, off));
    } finally {
      closeSync(fd);
    }
    const events: [number, ChatEvent][] = [];
    let pos = off;
    let from = 0;
    for (;;) {
      const nl = data.indexOf(0x0a, from);
      if (nl < 0) break;
      const start = pos;
      pos += nl + 1 - from;
      const line = data.subarray(from, nl + 1).toString("utf8");
      from = nl + 1;
      for (const e of chatEvents(line, deltaFrom !== undefined && start >= deltaFrom)) events.push([pos, e]);
    }
    return { events, off: pos };
  }

  const lastUser = (sid: string): number => {
    try {
      return readFileSync(outFile(sid)).lastIndexOf('{"type":"hds_user"');
    } catch {
      return -1;
    }
  };

  const frame = (offset: number, event: ChatEvent): string => `id: ${offset}\ndata: ${pyDumpsUtf8(event)}\n\n`;

  async function stream(req: Request, id: string, offsetQuery: string | undefined): Promise<Response> {
    if (!CHAT_ID.test(id) || !(id in (await sessions()))) return respond(404, { error: "sessão desconhecida" });
    const raw = req.headers.get("last-event-id") || offsetQuery || "0";
    let off = /^\s*[+-]?\d+\s*$/.test(raw) ? Math.max(0, Number.parseInt(raw, 10)) : 0;
    const deltaFrom = (await active()).has(id) ? Math.max(lastUser(id), 0) : undefined;
    const encoder = new TextEncoder();
    let open = true;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (text: string): void => controller.enqueue(encoder.encode(text));
        let beat = nowS();
        try {
          while (open && !req.signal.aborted) {
            const wasRunning = (await active()).has(id);
            const read = readEvents(id, off, deltaFrom);
            off = read.off;
            for (const [o, e] of read.events) write(frame(o, e));
            if (read.events.length) beat = nowS();
            else if (!wasRunning) {
              await locked(async () => finalize(id, await active()));
              const last = readEvents(id, off, deltaFrom);
              off = last.off;
              for (const [o, e] of last.events) write(frame(o, e));
              write(`event: done\nid: ${off}\ndata: {"offset":${off}}\n\n`);
              await sessions(); // fecha o registro (custo, tokens) mesmo sem outra tela aberta
              return;
            } else {
              await Bun.sleep(POLL_MS);
              if (nowS() - beat > KEEP_ALIVE_S) {
                write(": keep-alive\n\n");
                beat = nowS();
              }
            }
          }
        } catch (error) {
          // a conexão caiu: o EventSource religa sozinho com o último id
          if (open) console.warn(`stream do chat encerrado: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          open = false;
          try {
            controller.close();
          } catch {
            // já fechado pelo cancelamento do cliente
          }
        }
      },
      cancel() {
        open = false;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Frame-Options": "DENY" },
    });
  }

  return { overview, send, stop, remove, stream, isId: (sid) => CHAT_ID.test(sid) };
}
