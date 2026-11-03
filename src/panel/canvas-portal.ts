// Rota do nó portal (reference/argos.md §Portal web): POST /api/canvas/portal/check confere só os cabeçalhos da URL
// (`X-Frame-Options`, `frame-ancestors` da CSP) e diz se a página pode ser embutida ou se o nó vira link. Nunca lê o corpo da
// página, não segue redirecionamento para fora da lista e cada pedido tem timeout. A chave e o token da sessão são conferidos
// pelo servidor antes de chegar aqui, como nas demais rotas do canvas.
import {
  buildPortalPolicy,
  checkPortalUrl,
  judgeEnvironment,
  judgeFraming,
  PORTAL_BLOCKS,
  PORTAL_ERRORS,
  PORTAL_LIMITS,
  PortalError,
  type PortalBlock,
  type PortalErrorCode,
  type PortalPolicy,
  resolveRedirect,
} from "../lib/canvas-portal.ts";
import { send } from "./http.ts";
import { log } from "./log.ts";

export const PORTAL_ROUTE_ERRORS = {
  rateLimited: "portal_rate_limited",
} as const;

const OK_STATUS = 200;
const INVALID_STATUS = 400;
const FORBIDDEN_STATUS = 403;
const RATE_STATUS = 429;
const TIMEOUT_MS_DEFAULT = 5000;
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60_000;
const CONCURRENT_MAX = 4;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 200;
/** HEAD que a página recusa (método não permitido ou não implementado) repete como GET, cujo corpo nunca é lido. */
const HEAD_REFUSED = new Set([405, 501]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const PROBE_AGENT = "hades-panel-portal-check";

const STATUS_BY_CODE: Record<PortalErrorCode, number> = {
  [PORTAL_ERRORS.invalidUrl]: INVALID_STATUS,
  [PORTAL_ERRORS.urlTooLong]: INVALID_STATUS,
  [PORTAL_ERRORS.scheme]: INVALID_STATUS,
  [PORTAL_ERRORS.credentials]: INVALID_STATUS,
  [PORTAL_ERRORS.hostNotAllowed]: FORBIDDEN_STATUS,
  [PORTAL_ERRORS.invalidNode]: INVALID_STATUS,
};

export type PortalFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PortalDeps {
  /** Hosts dos serviços do Hades que não são loopback e o valor cru de `HADES_CANVAS_PORTAL_HOSTS`; lido a cada pedido. */
  hosts(): { hadesHosts: readonly string[]; extraHosts: string };
  /** Só para teste: o `fetch` que sai do processo. */
  fetchImpl?: PortalFetch;
  /** Teto de cada pedido de cabeçalho (padrão 5 s). */
  timeoutMs?: number;
  now?(): number;
}

export interface PortalCaller {
  /** Chegou pelo túnel: o navegador de quem olha não é esta máquina. */
  remote: boolean;
  /** Origem do painel como esse navegador a vê; é só dica de leitura (quem barra o quadro é o navegador). */
  ancestorOrigin: string | undefined;
}

export interface PortalRoutes {
  check(body: Record<string, unknown>, caller: PortalCaller): Promise<Response>;
  /** GET /api/canvas/portal/policy: os hosts que o portal aceita, para a página filtrar antes de perguntar ao `check`. */
  policy(): Response;
}

interface Verdict {
  url: string;
  finalUrl: string;
  embeddable: boolean;
  reason: PortalBlock | null;
  status: number | null;
  checkedAt: string;
}

export type PortalPolicyView = {
  exact: string[];
  suffixes: string[];
};

const CLOSED_POLICY: PortalPolicyView = { exact: [], suffixes: [] };

const refusal = (status: number, code: string, message: string, headers?: Record<string, string>): Response => {
  const res = send(status, { error: message, code });
  for (const [name, value] of Object.entries(headers ?? {})) res.headers.set(name, value);
  return res;
};

const blocked = (url: URL, finalUrl: URL, reason: PortalBlock, status: number | null, at: Date): Verdict => ({
  url: url.href, finalUrl: finalUrl.href, embeddable: false, reason, status, checkedAt: at.toISOString(),
});

export function createCanvasPortalRoutes(deps: PortalDeps): PortalRoutes {
  const fetchImpl: PortalFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS_DEFAULT;
  const now = (): number => (deps.now ? deps.now() : Date.now());
  const cache = new Map<string, { at: number; verdict: Verdict }>();
  const stamps: number[] = [];
  let inflight = 0;
  let policyKey = "";
  let policy: PortalPolicy = buildPortalPolicy();

  /** A política só se refaz quando a configuração ou o host do túnel mudam. */
  function currentPolicy(): PortalPolicy {
    const { hadesHosts, extraHosts } = deps.hosts();
    const key = `${hadesHosts.join(",")}|${extraHosts}`;
    if (key !== policyKey) {
      policy = buildPortalPolicy({ hadesHosts, extraHosts });
      policyKey = key;
      if (policy.ignored.length > 0) log("warn", "canvas_portal_hosts_ignored", { count: policy.ignored.length });
    }
    return policy;
  }

  function remember(key: string, at: number, verdict: Verdict): void {
    const oldest = cache.size >= CACHE_MAX ? cache.keys().next() : undefined;
    if (oldest && !oldest.done) cache.delete(oldest.value);
    cache.set(key, { at, verdict });
  }

  /** Janela deslizante de `RATE_MAX` pedidos por minuto; devolve os segundos até liberar, ou 0 se o pedido entra. */
  function retryAfterS(at: number): number {
    while (stamps.length > 0 && at - (stamps[0] as number) >= RATE_WINDOW_MS) stamps.shift();
    if (stamps.length >= RATE_MAX || inflight >= CONCURRENT_MAX) {
      return Math.max(1, Math.ceil((RATE_WINDOW_MS - (at - (stamps[0] ?? at))) / 1000));
    }
    stamps.push(at);
    return 0;
  }

  /** Um pedido só de cabeçalhos, sem seguir redirecionamento; o corpo, se vier, é cancelado sem ler. */
  async function headersOf(url: URL): Promise<Response> {
    const ask = async (method: "HEAD" | "GET"): Promise<Response> =>
      fetchImpl(url.href, { method, redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": PROBE_AGENT } });
    let res = await ask("HEAD");
    if (HEAD_REFUSED.has(res.status)) {
      await res.body?.cancel();
      res = await ask("GET");
    }
    await res.body?.cancel();
    return res;
  }

  async function probe(start: URL, caller: PortalCaller, current: PortalPolicy, at: Date): Promise<Verdict> {
    let url = start;
    for (let hop = 0; hop <= PORTAL_LIMITS.redirects; hop += 1) {
      const res = await headersOf(url);
      if (REDIRECT_STATUS.has(res.status)) {
        const next = resolveRedirect(url, res.headers.get("location"), current);
        if (next === undefined) return blocked(start, url, PORTAL_BLOCKS.redirectOutside, res.status, at);
        url = next;
        continue;
      }
      const reason =
        judgeEnvironment(url, caller) ??
        judgeFraming(
          { frameOptions: res.headers.get("x-frame-options"), csp: res.headers.get("content-security-policy") },
          { pageOrigin: url.origin, ancestorOrigin: caller.ancestorOrigin },
        );
      return { url: start.href, finalUrl: url.href, embeddable: reason === undefined, reason: reason ?? null, status: res.status, checkedAt: at.toISOString() };
    }
    return blocked(start, url, PORTAL_BLOCKS.redirectLimit, null, at);
  }

  async function verdictFor(url: URL, caller: PortalCaller, current: PortalPolicy, at: Date): Promise<Verdict> {
    const early = judgeEnvironment(url, caller);
    if (early !== undefined) return blocked(url, url, early, null, at);
    try {
      return await probe(url, caller, current, at);
    } catch (error) {
      const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      // só o host vai ao log: a URL inteira pode levar parâmetro sensível
      log("warn", "canvas_portal_probe_failed", { host: url.hostname, timeout: timedOut });
      return blocked(url, url, timedOut ? PORTAL_BLOCKS.timeout : PORTAL_BLOCKS.unreachable, null, at);
    }
  }

  /**
   * Hosts liberados, sem a chave bruta da configuração e sem as entradas que a política descartou. Configuração que não se
   * lê ou não tem a forma esperada fecha: listas vazias, nenhum host liberado.
   */
  function exposedPolicy(): PortalPolicyView {
    try {
      const configured = deps.hosts();
      if (!Array.isArray(configured.hadesHosts) || typeof configured.extraHosts !== "string") return CLOSED_POLICY;
      const open = currentPolicy();
      return { exact: [...open.exact].sort(), suffixes: [...open.suffixes].sort() };
    } catch (error) {
      log("warn", "canvas_portal_policy_unreadable", { reason: error instanceof Error ? error.name : "unknown" });
      return CLOSED_POLICY;
    }
  }

  return {
    policy: () => send(OK_STATUS, exposedPolicy()),
    async check(body, caller) {
      const current = currentPolicy();
      let url: URL;
      try {
        url = checkPortalUrl(body.url, current);
      } catch (error) {
        if (error instanceof PortalError) return refusal(STATUS_BY_CODE[error.code], error.code, `portal recusado (${error.code})`);
        throw error;
      }
      const at = now();
      const key = `${caller.remote ? "r" : "l"}|${caller.ancestorOrigin ?? ""}|${url.href}`;
      const cached = cache.get(key);
      if (cached && at - cached.at < CACHE_TTL_MS) return send(OK_STATUS, { ok: true, ...cached.verdict });
      const wait = retryAfterS(at);
      if (wait > 0) return refusal(RATE_STATUS, PORTAL_ROUTE_ERRORS.rateLimited, "muitas conferências de portal; tente de novo em instantes", { "Retry-After": String(wait) });
      inflight += 1;
      try {
        const verdict = await verdictFor(url, caller, current, new Date(at));
        // fora do ar não fica guardado: o serviço pode subir no segundo seguinte
        if (verdict.reason !== PORTAL_BLOCKS.unreachable && verdict.reason !== PORTAL_BLOCKS.timeout) remember(key, at, verdict);
        return send(OK_STATUS, { ok: true, ...verdict });
      } finally {
        inflight -= 1;
      }
    },
  };
}
