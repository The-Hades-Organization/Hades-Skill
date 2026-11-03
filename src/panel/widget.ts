// Widget Android do painel: GET /api/widget (token Bearer próprio), o token (criar/revogar), o APK e o listener dedicado.
// Contrato em reference/panel.md §Widget Android: o v1 só ganha campos, nunca muda nem perde.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readText } from "../lib/fs.ts";
import { pyJsonDumps } from "../lib/kit.ts";
import { listSourceFiles, sourcesShaOf } from "../lib/widget-sources.ts";
import type { Auth } from "./auth.ts";
import type { PanelEnv } from "./env.ts";
import { exec } from "./exec.ts";
import { BadRequest, JSON_TYPE, send } from "./http.ts";
import { log } from "./log.ts";
import { isoEpoch } from "./system.ts";

type Dict = Record<string, unknown>;

const WIDGET_CONTRACT = 1;
const FAIL_LIMIT = 8;
const FAIL_WINDOW_S = 600;
const FAIL_MAX_IPS = 1024;
const FORWARDED_PART_MAX = 64;
const DEFAULT_EVENTS = 8;
const PRS_MAX = 20;
const PRS_TITLE_MAX = 120;
const PRS_TIMEOUT_MS = 120_000;
const GH_TTL_S = 300;
const WIDGET_PORT_MIN = 1024;
const WIDGET_PORT_MAX = 65535;
const TOKEN_BYTES = 32;
const TOKEN_FILE_MODE = 0o600;
const APK_MIME = "application/vnd.android.package-archive";
const APK_NAME = /^[0-9A-Za-z.+-]{1,40}$/;

export const STATE_ACTIVE = "active";
export const STATE_STOPPED = "stopped";
export const STATE_ASKING = "asking";
const EVENT_FIELDS: readonly [string, string][] = [["createdAt", "allocated"], ["adoptedAt", "adopted"], ["promptedAt", "prompted"], ["escalatedAt", "escalated"], ["doneAt", "done"], ["archivedAt", "archived"]];
const SINCE_FIELDS = ["promptedAt", "adoptedAt", "createdAt"];
const CLOSED_STATES = ["done", "archived"];
// checks.verdict do coletor -> contrato (lista fechada: o contrato só ganha valores)
const CI_BY_VERDICT: Record<string, string> = { green: "green", red: "failing", pending: "running", none: "none" };
const CI_UNKNOWN = "none";
const ERR_COLLECTOR = "collector_failed";

export const utcIso = (epoch: number): string => `${new Date(Math.floor(epoch) * 1000).toISOString().slice(0, 19)}Z`;

const asDict = (value: unknown): Dict => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {});
const asList = (value: unknown): Dict[] => (Array.isArray(value) ? value.map(asDict) : []);

function widgetState(agent: Dict): string {
  if ((Array.isArray(agent.openQuestions) && agent.openQuestions.length > 0) || agent.live === "blocked") return STATE_ASKING;
  return agent.live === "working" ? STATE_ACTIVE : STATE_STOPPED;
}

/** Contrato do GET /api/widget. Função pura: recebe o snapshot da orquestração e o instante. */
export function widgetPayload(snapshot: Dict, now: number, maxEvents: number, system?: Dict, prs?: Dict): Dict {
  const agents: { state: string }[] = [];
  const events: { at: string }[] = [];
  for (const a of asList(snapshot.agents)) {
    const name = a.name;
    for (const [field, kind] of EVENT_FIELDS) {
      const at = isoEpoch(String(a[field] ?? ""));
      if (at !== null && name) events.push({ at: utcIso(at), type: kind, agent: name, role: a.role ?? null } as { at: string });
    }
    if (CLOSED_STATES.includes(String(a.state)) || !name) continue;
    const since = SINCE_FIELDS.map((f) => isoEpoch(String(a[f] ?? ""))).find((t) => t !== null) ?? null;
    agents.push({
      name, role: a.role ?? null, state: widgetState(a), since: since === null ? null : utcIso(since),
      ageSeconds: since === null ? null : Math.max(0, Math.trunc(now - since)), openQuestions: Array.isArray(a.openQuestions) ? a.openQuestions.length : 0,
    } as { state: string });
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  const counts = Object.fromEntries([STATE_ACTIVE, STATE_STOPPED, STATE_ASKING].map((s) => [s, agents.filter((a) => a.state === s).length]));
  const payload: Dict = { version: WIDGET_CONTRACT, updatedAt: utcIso(now), available: Boolean(snapshot.available), counts, agents, events: events.slice(0, maxEvents) };
  // seções acrescentadas depois do v1 original: aditivas, ausentes só em chamada antiga
  if (system !== undefined) payload.system = system;
  if (prs !== undefined) payload.prs = prs;
  return payload;
}

function widgetMemory(host: Dict): Dict | null {
  const total = host.memTotal;
  const avail = host.memAvailable;
  if (!Number.isInteger(total) || !Number.isInteger(avail) || (total as number) <= 0) return null;
  return { totalBytes: total, usedBytes: Math.max(0, (total as number) - (avail as number)), availableBytes: avail };
}

/** Serviços ligados e containers de longa duração de pé, contra o que deveria estar; nome só dos que caíram. */
function widgetInfra(services: Dict[], containers: Dict[], optional: ReadonlySet<string>): Dict {
  const enabled = services.filter((s) => s.enabled);
  const up = enabled.filter((s) => s.state === "active" && s.ready);
  const required = enabled.filter((s) => s.required);
  const longRunning = containers.filter((c) => !c.oneshot && !optional.has(String(c.service)));
  const cUp = longRunning.filter((c) => c.state === "running");
  return {
    services: {
      enabled: enabled.length, up: up.length, required: required.length, requiredUp: required.filter((s) => up.includes(s)).length,
      down: enabled.filter((s) => !up.includes(s)).map((s) => String(s.name)).sort(),
    },
    containers: { total: longRunning.length, up: cUp.length, down: longRunning.filter((c) => !cUp.includes(c)).map((c) => String(c.service)).sort() },
  };
}

function widgetQueue(gates: Dict[]): Dict {
  const running = gates.find((g) => g.state === "running");
  const waiting = gates.filter((g) => g.state === "waiting").length;
  let active: Dict | null = null;
  if (running) {
    const age = running.age;
    active = { label: running.label || "-", ageSeconds: typeof age === "number" ? Math.max(0, Math.trunc(age)) : null, rssBytes: running.rss ?? null };
  }
  return { running: active, waiting };
}

/** Seção `system`: memória, infra e fila de builds. Fonte ausente vira seção nula, não zero. */
export function widgetSystem(gateSnapshot: Dict, samplerSnapshot: Dict, optional: ReadonlySet<string>): Dict {
  const host = asDict(gateSnapshot.host);
  const infra = Object.keys(samplerSnapshot).length ? widgetInfra(asList(samplerSnapshot.services), asList(samplerSnapshot.containers), optional) : null;
  return { memory: widgetMemory(host), infra, queue: widgetQueue(asList(gateSnapshot.gates)) };
}

const nonEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : Boolean(v));
const reviewPending = (pr: Dict): boolean => Boolean(pr.unresolved || nonEmpty(pr.live) || nonEmpty(pr.topLevelLive) || pr.unseenReviewSincePush);

/** PRs abertas fora de draft do relatório do coletor, na ordem dele; só o gate do GitHub (o rollup de checks). */
export function widgetPrItems(report: Dict): Dict[] {
  const items: Dict[] = [];
  for (const pr of asList(report.prs)) {
    if (pr.isDraft || !Number.isInteger(pr.number)) continue;
    const verdict = asDict(pr.checks).verdict;
    items.push({ number: pr.number, title: String(pr.title ?? "").slice(0, PRS_TITLE_MAX), reviewPending: reviewPending(pr), ci: CI_BY_VERDICT[String(verdict)] ?? CI_UNKNOWN });
  }
  return items.slice(0, PRS_MAX);
}

export interface PrsCache {
  /** Dado atual (e dispara a coleta em segundo plano quando venceu): nunca espera o coletor. */
  get(now: number): { items: Dict[]; fetchedAt: number | null; error: string | null };
}

/** O coletor do loop roda quando o dado vence e nunca dentro da leitura do widget; falha mantém o último dado bom. */
export function createPrsCache(collect: () => Promise<Dict>, ttl: () => number): PrsCache {
  let items: Dict[] = [];
  let fetchedAt: number | null = null;
  let error: string | null = null;
  let busy = false;
  let triedAt: number | null = null;
  async function refresh(now: number): Promise<void> {
    try {
      const next = widgetPrItems(await collect());
      items = next;
      fetchedAt = now;
      error = null;
    } catch (failure) {
      // o detalhe (caminho, saída do gh) fica só no log do painel
      error = ERR_COLLECTOR;
      log("warn", "widget: coleta de PRs falhou", { reason: failure instanceof Error ? failure.message : String(failure) });
    }
    triedAt = now;
    busy = false;
  }
  return {
    get(now) {
      if ((triedAt === null || now - triedAt >= ttl()) && !busy) {
        busy = true;
        void refresh(now);
      }
      return { items, fetchedAt, error };
    },
  };
}

export function prsSection(cached: { items: Dict[]; fetchedAt: number | null; error: string | null }, now: number): Dict {
  const { items, fetchedAt, error } = cached;
  return {
    available: fetchedAt !== null, fetchedAt: fetchedAt === null ? null : utcIso(fetchedAt),
    ageSeconds: fetchedAt === null ? null : Math.max(0, Math.trunc(now - fetchedAt)), error, items,
  };
}

export interface WidgetDeps {
  env: PanelEnv;
  auth: Auth;
  config: () => Record<string, string>;
  panelPort: number;
  orchestration: () => Promise<Dict>;
  gates: () => Dict;
  sampler: () => Dict;
  optionalContainers: () => ReadonlySet<string>;
  now?: () => number;
}

export interface Widget {
  /** GET /api/widget no painel e no listener próprio: token do widget, só leitura. */
  handle(req: Request, clientIp: string | undefined): Promise<Response>;
  status(): Dict;
  tokenAct(op: unknown): Dict;
  apkInfo(): Dict;
  /** Corpo do download do APK (ou só os cabeçalhos no HEAD). */
  apkDownload(head: boolean): Response;
  /** Sobe o listener dedicado (túnel anônimo) em 127.0.0.1; undefined se a porta é inválida, igual à do painel ou ocupada. */
  serve(): { stop(): void } | undefined;
}

export function createWidget(deps: WidgetDeps): Widget {
  const { env, auth } = deps;
  const now = deps.now ?? ((): number => Date.now() / 1000);
  const tokenFile = join(env.panelDir, "widget-token.json");
  const logFile = join(env.dir, "logs", "panel-widget.log");
  const apkFile = join(env.dir, "android", "hades-widget.apk");
  const apkMeta = join(env.dir, "android", "hades-widget.apk.json");
  const sourcesDir = join(env.dir, "android", "widget");
  const fails = new Map<string, number[]>();
  const apkCache = new Map<string, { key: string; value: string }>();

  const maxEvents = (): number => {
    const n = Number.parseInt(deps.config().HADES_WIDGET_EVENTS ?? "", 10);
    // config.tsv é a fonte do padrão; sem o catálogo (instalação quebrada) o widget ainda responde
    return Number.isNaN(n) ? DEFAULT_EVENTS : Math.max(1, n);
  };
  const prsTtl = (): number => {
    const n = Number.parseInt(deps.config().HADES_WIDGET_PRS_TTL ?? "", 10);
    // nunca abaixo do TTL do gh: ele não roda mais que isso, qualquer que seja a config
    return Number.isNaN(n) ? GH_TTL_S : Math.max(GH_TTL_S, n);
  };
  const prs = createPrsCache(async () => {
    const res = await exec([process.execPath, join(env.skillDir, "src", "cli.ts"), "pr-loop-state", "--json"], { timeoutMs: PRS_TIMEOUT_MS, cwd: env.worktree });
    if (res.status !== 0 || res.timedOut) throw new Error(`coletor rc=${res.status}`);
    const report: unknown = JSON.parse(res.stdout);
    if (report === null || typeof report !== "object" || Array.isArray(report)) throw new Error("relatório fora do formato");
    return report as Dict;
  }, prsTtl);

  function failPrune(at: number): void {
    for (const [ip, ts] of fails) if (!ts.length || at - (ts[ts.length - 1] as number) >= FAIL_WINDOW_S) fails.delete(ip);
    const excess = fails.size - FAIL_MAX_IPS;
    if (excess > 0) {
      const oldest = [...fails].sort((a, b) => (a[1][a[1].length - 1] as number) - (b[1][b[1].length - 1] as number)).slice(0, excess);
      for (const [ip] of oldest) fails.delete(ip);
    }
  }
  function failRecord(ip: string, at: number): void {
    fails.set(ip, [...(fails.get(ip) ?? []), at].filter((t) => at - t < FAIL_WINDOW_S).slice(-FAIL_LIMIT));
    failPrune(at);
  }
  /** Segundos até o IP poder tentar de novo; 0 = livre. Libera quando a falha mais antiga da janela sai dela. */
  function retryAfter(ip: string, at: number): number {
    const recent = (fails.get(ip) ?? []).filter((t) => at - t < FAIL_WINDOW_S);
    return recent.length < FAIL_LIMIT ? 0 : Math.max(1, Math.ceil(FAIL_WINDOW_S - (at - (recent[0] as number))));
  }

  /** IPs que contam no bloqueio: o primeiro e o último do X-Forwarded-For (o último é o que a borda anexou, que o cliente não escolhe). */
  function clientIps(req: Request, socketIp: string | undefined): string[] {
    const parts = (req.headers.get("x-forwarded-for") ?? "").split(",").map((x) => x.trim().slice(0, FORWARDED_PART_MAX)).filter(Boolean);
    return parts.length ? [...new Set([parts[0] as string, parts[parts.length - 1] as string])] : [socketIp ?? ""];
  }

  async function handle(req: Request, socketIp: string | undefined): Promise<Response> {
    if (auth.widgetInfo() === undefined) return send(404, { error: "widget desligado", code: "widget_off" });
    const ips = clientIps(req, socketIp);
    const at = now();
    const retry = Math.max(...ips.map((ip) => retryAfter(ip, at)));
    if (retry) {
      // sem X-Frame-Options nem Cache-Control, como o original
      return new Response(pyJsonDumps({ error: "muitas tentativas", code: "widget_rate_limited" }), { status: 429, headers: { "Retry-After": String(retry), "Content-Type": JSON_TYPE } });
    }
    const bearer = auth.bearer(req.headers);
    if (!auth.widgetTokenValid(bearer)) {
      if (bearer) for (const ip of ips) failRecord(ip, at);
      return send(401, { error: "token do widget ausente ou inválido", code: "widget_token" });
    }
    const system = widgetSystem(deps.gates(), deps.sampler(), deps.optionalContainers());
    return send(200, widgetPayload(await deps.orchestration(), at, maxEvents(), system, prsSection(prs.get(at), at)));
  }

  function audit(what: string): void {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${utcIso(now())} acao=${what} origem=local\n`);
  }

  function tokenAct(op: unknown): Dict {
    if (op === "create") {
      const token = `hdw_${randomBytes(TOKEN_BYTES).toString("base64url")}`;
      const createdAt = utcIso(now());
      const tmp = `${tokenFile.replace(/\.json$/, "")}.tmp`;
      writeFileSync(tmp, pyJsonDumps({ hash: createHash("sha256").update(token).digest("hex"), createdAt }), { mode: TOKEN_FILE_MODE });
      renameSync(tmp, tokenFile);
      audit("token-criado");
      return { token, createdAt };
    }
    if (op === "revoke") {
      try {
        unlinkSync(tokenFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { configured: false };
      }
      audit("token-revogado");
      return { configured: false };
    }
    throw new BadRequest("operação inválida");
  }

  function listenerPort(): number {
    const port = Number.parseInt(deps.config().HADES_WIDGET_PORT ?? "", 10);
    return port >= WIDGET_PORT_MIN && port <= WIDGET_PORT_MAX ? port : 0;
  }

  function status(): Dict {
    const info = auth.widgetInfo();
    const line = (name: string): string | null => (readText(join(env.dir, name)) ?? "").trim() || null;
    return {
      configured: info !== undefined, createdAt: info ? (info.createdAt ?? null) : null, port: listenerPort(),
      tunnel: { url: line("widget-tunnel.url"), expiresAt: line("widget-tunnel.expires") },
    };
  }

  const hashFile = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
  function cached(kind: string, key: string, compute: () => string): string {
    const hit = apkCache.get(kind);
    if (hit && hit.key === key) return hit.value;
    const value = compute();
    apkCache.set(kind, { key, value });
    return value;
  }

  /** Hash das fontes em $D/android/widget: a mesma conta do build (lib/widget-sources.ts), refeita só quando um arquivo muda. */
  function sourcesSha(): string | null {
    let files: string[];
    let key: string;
    try {
      files = listSourceFiles(sourcesDir);
      if (!files.length) return null;
      key = `${Math.max(...files.map((f) => statSync(f).mtimeMs))}:${files.length}`;
    } catch {
      return null;
    }
    return cached("sources", key, () => sourcesShaOf(sourcesDir, files));
  }

  function apkInfo(): Dict {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(apkFile);
    } catch {
      return { exists: false };
    }
    const sha = cached("apk", `${st.mtimeMs}:${st.size}`, () => hashFile(apkFile));
    let meta: Dict = {};
    try {
      const parsed: unknown = JSON.parse(readText(apkMeta) ?? "");
      // o sidecar só vale se o sha256 dele é o do arquivo (APK trocado à mão não herda a versão)
      if (asDict(parsed).sha256 === sha) meta = asDict(parsed);
    } catch {
      meta = {};
    }
    const name = meta.versionName;
    const src = sourcesSha();
    return {
      exists: true, size: st.size, sha256: sha, versionName: APK_NAME.test(String(name ?? "")) ? name : null,
      versionCode: Number.isInteger(meta.versionCode) ? meta.versionCode : null, builtAt: meta.builtAt ?? null, certSha256: meta.certSha256 ?? null,
      kitVersion: (readText(join(env.dir, "kit.version")) ?? "").trim() || null, outdated: src !== null && meta.sourcesSha256 !== src,
    };
  }

  function apkDownload(head: boolean): Response {
    let fd: number;
    try {
      fd = openSync(apkFile, "r");
    } catch {
      return send(404, { error: "APK do widget ainda não foi gerado: use Gerar APK (ou rode android/build.sh)", code: "apk_missing" });
    }
    const size = fstatSync(fd).size;
    closeSync(fd);
    const name = apkInfo().versionName;
    const headers = {
      "Content-Type": APK_MIME, "Content-Length": String(size), "Cache-Control": "no-store",
      "Content-Disposition": name ? `attachment; filename="hades-widget-${String(name)}.apk"` : 'attachment; filename="hades-widget.apk"',
      "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    };
    return new Response(head ? null : Bun.file(apkFile), { status: 200, headers });
  }

  function serve(): { stop(): void } | undefined {
    const port = listenerPort();
    if (!port || port === deps.panelPort) {
      log("warn", "listener do widget desligado: HADES_WIDGET_PORT inválida ou igual à do painel", { port });
      return undefined;
    }
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        async fetch(req, srv) {
          if (req.method === "GET" && new URL(req.url).pathname === "/api/widget") return handle(req, srv.requestIP(req)?.address);
          return send(404, { error: "not found", code: "not_found" });
        },
      });
      log("info", "listener do widget no ar", { port });
      return { stop: () => void server.stop(true) };
    } catch (error) {
      log("warn", "listener do widget desligado: porta indisponível", { port, reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  return { handle, status, tokenAct, apkInfo, apkDownload, serve };
}
