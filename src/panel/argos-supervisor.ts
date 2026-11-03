// Rotas do supervisor do canvas (reference/argos.md §Supervisor). O cartão de fim/pausa é local: o servidor lê o pane
// (só leitura, a mesma leitura do /api/herdr/read) e passa pela heurística de src/lib/canvas-supervisor.ts. A consulta
// sob demanda e o resumo das notas conectadas vão ao `claude -p` (o mesmo binário da página Claude: HADES_CHAT_BIN ou o
// `claude` do PATH), sem ferramentas (`--tools ""`), com o contexto mínimo (últimas linhas do terminal alvo, texto das
// notas) e só com HADES_SUPERVISOR_CLAUDE ligado. Pelo acesso remoto, o que dispara o `claude -p` pede `confirm` com o
// nome do alvo e avisa o dono (D1). Nenhuma rota daqui escreve em pane, manda tecla ou texto a agente: as dependências
// nem oferecem isso. O texto (pergunta, linhas, notas, resposta) nunca vai a log.
import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CanvasDoc } from "../lib/canvas-doc.ts";
import {
  type AgentStatus, type OutgoingContext, SUPERVISOR_LIMITS, askContext, buildCard, clipAnswer, connectedNoteNames, isAgentStatus, notesContext,
} from "../lib/canvas-supervisor.ts";
import { isValidCanvasId } from "../lib/canvas-store.ts";
import { home } from "../lib/paths.ts";
import { which } from "../lib/proc.ts";
import { PANE_ID, SESSION_NAME } from "./herdr-page.ts";
import { send } from "./http.ts";
import type { Level } from "./log.ts";

type Dict = Record<string, unknown>;

export const SUPERVISOR_ERRORS = {
  invalid: "invalid",
  notFound: "not-found",
  confirmRequired: "confirm-required",
  off: "supervisor-claude-off",
  noClaude: "claude-missing",
  claudeFailed: "claude-failed",
  herdrFailed: "herdr-failed",
  busy: "busy",
  rateLimited: "rate-limited",
} as const;

export const SUPERVISOR_ROUTE_LIMITS = {
  /** chamadas ao claude por janela, por origem (local e remoto contam à parte) */
  claudePerWindow: 6,
  windowMs: 60_000,
  /** claude -p ao mesmo tempo, no painel inteiro */
  concurrent: 2,
  timeoutMs: 120_000,
  outBytes: 256 * 1024,
  /** a frase que o acesso remoto digita para o resumo das notas */
  notesPhrase: "notas",
  remoteNoticeGapMs: 60_000,
} as const;

export const CONFIG_KEY = "HADES_SUPERVISOR_CLAUDE";
const DEFAULT_MODEL = "claude-opus-5-5";
const BASE = "/api/argos/supervisor";

export interface ClaudeRun {
  status: number;
  out: string;
}

export interface SupervisorDeps {
  /** `$D`: o `claude -p` roda em `$D/supervisor/` (pasta vazia, fora de qualquer repositório) */
  dir: string;
  config(): Record<string, string>;
  /** O que o pane mostra (texto, com ou sem ANSI), só leitura; lança se o pane não existe ou o herdr falha. */
  readPane(session: string, pane: string, lines: number): Promise<string>;
  loadDoc(canvasId: string): Promise<CanvasDoc | undefined>;
  /** Texto e título da nota; `undefined` se a nota não existe. */
  readNote(name: string): Promise<{ text: string; title: string } | undefined>;
  /** Aviso ao dono pelo acesso remoto: só ação e alvo. */
  notify(what: string, target: string): Promise<void>;
  log(level: Level, event: string, fields?: Record<string, string | number | boolean | null>): void;
  /** Roda o `claude -p` com o prompt no stdin; o padrão é o processo de verdade. Os testes trocam por um falso. */
  runClaude?(argv: string[], input: string, options: { cwd: string; timeoutMs: number }): Promise<ClaudeRun>;
  now?(): number;
}

export interface SupervisorCaller {
  remote: boolean;
}

export interface SupervisorRoutes {
  get(path: string, query: Record<string, string>, caller: SupervisorCaller): Promise<Response> | undefined;
  post(path: string, body: Dict, caller: SupervisorCaller): Promise<Response> | undefined;
}

const refusal = (status: number, code: string, error: string, extra: Dict = {}): Response => send(status, { error, code, ...extra });
const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** O processo de verdade: prompt pelo stdin (no argv, um texto começando com "-" viraria opção), saída cortada no teto. */
async function spawnClaude(argv: string[], input: string, options: { cwd: string; timeoutMs: number }): Promise<ClaudeRun> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd, stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "ignore",
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
  });
  const timer = setTimeout(() => proc.kill("SIGTERM"), options.timeoutMs);
  try {
    const out = await new Response(proc.stdout).text();
    const status = await proc.exited;
    return { status, out: out.slice(0, SUPERVISOR_ROUTE_LIMITS.outBytes) };
  } finally {
    clearTimeout(timer);
  }
}

export function createSupervisorRoutes(deps: SupervisorDeps): SupervisorRoutes {
  const now = deps.now ?? Date.now;
  const runClaude = deps.runClaude ?? spawnClaude;
  const windows = new Map<string, number[]>();
  const noticed = new Map<string, number>();
  let running = 0;

  const claudeOn = (): boolean => (deps.config()[CONFIG_KEY] ?? "1") !== "0";

  function claudeBin(): string | undefined {
    const configured = (deps.config().HADES_CHAT_BIN ?? "").replace(/^~(?=$|\/)/, home());
    const bin = configured || which("claude");
    return bin && executable(bin) ? bin : undefined;
  }

  /** Janela deslizante por origem; devolve os segundos de espera quando cheia. */
  function rateWait(remote: boolean): number | undefined {
    const key = remote ? "remote" : "local";
    const t = now();
    const recent = (windows.get(key) ?? []).filter((at) => t - at < SUPERVISOR_ROUTE_LIMITS.windowMs);
    windows.set(key, recent);
    if (recent.length >= SUPERVISOR_ROUTE_LIMITS.claudePerWindow) return Math.max(1, Math.ceil((SUPERVISOR_ROUTE_LIMITS.windowMs - (t - (recent[0] as number))) / 1000));
    recent.push(t);
    return undefined;
  }

  function noticeRemote(what: string, target: string): void {
    const key = `${what}\0${target}`;
    if (now() - (noticed.get(key) ?? -Infinity) < SUPERVISOR_ROUTE_LIMITS.remoteNoticeGapMs) return;
    noticed.set(key, now());
    deps.notify(what, target).catch((error: unknown) => deps.log("warn", "supervisor: aviso remoto falhou", { reason: errText(error) }));
  }

  const target = (session: string, pane: string): Response | undefined =>
    SESSION_NAME.test(session) && PANE_ID.test(pane) ? undefined : refusal(400, SUPERVISOR_ERRORS.invalid, "terminal inválido");

  async function read(session: string, pane: string): Promise<string | Response> {
    try {
      return await deps.readPane(session, pane, SUPERVISOR_LIMITS.readLines);
    } catch (error) {
      deps.log("warn", "supervisor: leitura do pane falhou", { pane, reason: errText(error) });
      return refusal(502, SUPERVISOR_ERRORS.herdrFailed, "não consegui ler o terminal");
    }
  }

  /** Portão comum do que sai pelo claude: chave, confirmação remota (antes de ler qualquer coisa), taxa e teto. */
  function claudeGate(caller: SupervisorCaller, phrase: string, confirm: unknown): Response | undefined {
    if (!claudeOn()) return refusal(403, SUPERVISOR_ERRORS.off, "o supervisor não usa o claude -p (Configurações → Painel → Canvas: supervisor usa o claude -p)");
    if (caller.remote && confirm !== phrase) return refusal(403, SUPERVISOR_ERRORS.confirmRequired, "pelo acesso remoto, confirme digitando o nome", { phrase });
    const wait = rateWait(caller.remote);
    if (wait !== undefined) {
      return new Response(JSON.stringify({ error: "muitas consultas ao supervisor; espere um pouco", code: SUPERVISOR_ERRORS.rateLimited }), {
        status: 429, headers: { "content-type": "application/json", "retry-after": String(wait), "cache-control": "no-store" },
      });
    }
    if (running >= SUPERVISOR_ROUTE_LIMITS.concurrent) return refusal(429, SUPERVISOR_ERRORS.busy, "o supervisor já está respondendo; espere terminar");
    return undefined;
  }

  async function callClaude(context: OutgoingContext, what: string, label: string, caller: SupervisorCaller): Promise<Response> {
    const bin = claudeBin();
    if (!bin) return refusal(400, SUPERVISOR_ERRORS.noClaude, "binário claude não encontrado (Configurações → Sessão Claude → Caminho do claude)");
    const cwd = join(deps.dir, "supervisor");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const cfg = deps.config();
    const argv = [
      bin, "-p", "--output-format", "text", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
      "--model", cfg.HADES_MODEL_CHAT || DEFAULT_MODEL, "--effort", "low",
    ];
    if (caller.remote) noticeRemote(what, label);
    try {
      const r = await runClaude(argv, context.prompt, { cwd, timeoutMs: SUPERVISOR_ROUTE_LIMITS.timeoutMs });
      deps.log(r.status === 0 ? "info" : "warn", "supervisor: claude -p", {
        acao: what, alvo: label, rc: r.status, linhas: context.sent.lines ?? null, notas: context.sent.notes ?? null, chars: context.sent.chars, remoto: caller.remote,
      });
      const answer = clipAnswer(r.out);
      if (r.status !== 0 || !answer) return refusal(502, SUPERVISOR_ERRORS.claudeFailed, "o claude -p não respondeu (detalhe no log do painel)");
      return send(200, { answer, sent: context.sent, source: "claude" });
    } catch (error) {
      deps.log("warn", "supervisor: claude -p falhou", { acao: what, alvo: label, reason: errText(error) });
      return refusal(502, SUPERVISOR_ERRORS.claudeFailed, "o claude -p não respondeu (detalhe no log do painel)");
    }
  }

  /** Ocupa uma vaga do teto de simultâneos desde o portão até a resposta, leitura do pane incluída. */
  async function occupied(work: () => Promise<Response>): Promise<Response> {
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
    }
  }

  async function peek(query: Record<string, string>): Promise<Response> {
    const session = str(query.session);
    const pane = str(query.pane);
    const bad = target(session, pane);
    if (bad) return bad;
    const status: AgentStatus = isAgentStatus(query.status) ? query.status : "unknown";
    const text = await read(session, pane);
    if (text instanceof Response) return text;
    return send(200, { card: buildCard({ status, exited: query.exited === "1", text }) });
  }

  async function ask(body: Dict, caller: SupervisorCaller): Promise<Response> {
    const session = str(body.session);
    const pane = str(body.pane);
    const name = str(body.name).trim();
    const question = str(body.question).trim();
    const bad = target(session, pane);
    if (bad) return bad;
    if (!name || name.length > 80 || !question) return refusal(400, SUPERVISOR_ERRORS.invalid, "diga o terminal e a pergunta");
    const gate = claudeGate(caller, name, body.confirm);
    if (gate) return gate;
    return occupied(async () => {
      const text = await read(session, pane);
      if (text instanceof Response) return text;
      return callClaude(askContext({ name, question, text }), "consulta", name, caller);
    });
  }

  async function notes(body: Dict, caller: SupervisorCaller): Promise<Response> {
    const canvas = str(body.canvas);
    if (!isValidCanvasId(canvas)) return refusal(400, SUPERVISOR_ERRORS.invalid, "canvas inválido");
    const gate = claudeGate(caller, SUPERVISOR_ROUTE_LIMITS.notesPhrase, body.confirm);
    if (gate) return gate;
    return occupied(() => summarizeNotes(canvas, caller));
  }

  async function summarizeNotes(canvas: string, caller: SupervisorCaller): Promise<Response> {
    const doc = await deps.loadDoc(canvas).catch((error: unknown) => {
      deps.log("warn", "supervisor: canvas ilegível", { canvas, reason: errText(error) });
      return undefined;
    });
    if (!doc) return refusal(404, SUPERVISOR_ERRORS.notFound, "canvas não encontrado");
    const found: { title: string; text: string }[] = [];
    for (const name of connectedNoteNames(doc)) {
      const note = await deps.readNote(name).catch(() => undefined);
      if (note?.text.trim()) found.push(note);
    }
    if (!found.length) return refusal(404, SUPERVISOR_ERRORS.notFound, "nenhuma nota conectada com texto neste canvas");
    const r = await callClaude(notesContext(found), "resumo das notas", canvas, caller);
    if (r.status !== 200) return r;
    const out = (await r.json()) as Dict;
    return send(200, { summary: out.answer, sent: out.sent, source: "claude" });
  }

  return {
    get(path, query) {
      if (path === BASE) return Promise.resolve(send(200, { claude: claudeOn() }));
      if (path === `${BASE}/peek`) return peek(query);
      return undefined;
    },
    post(path, body, caller) {
      if (path === `${BASE}/ask`) return ask(body, caller);
      if (path === `${BASE}/notes`) return notes(body, caller);
      return undefined;
    },
  };
}
