/* Tipos de nó "vivos" do canvas do Argos (#/argos): portal, terminal, árvore de arquivos, plano, arquivo
 * do agente e conversa. São nós de usuário (`live: false` no registro; o vivo do grafo é só agent/unit/pr/gate): o documento
 * guarda poucos campos em `data` e o conteúdo vem de rotas de leitura. Script clássico: publica window.ArgosTypesLive.
 * Depende de React e, para o terminal, de window.ArgosNodeTerminal (node-terminal.tsx, que não muda aqui).
 * Toda busca passa por `deps.fetch`, com timeout e cancelamento na desmontagem (ou quando a chave da busca muda); erro da
 * rota aparece no próprio nó. As regras (política do portal, conversa, caminho de arquivo) moram em src/lib e chegam por
 * `deps.model` (ou por window.CanvasModel, quando a montagem as empacotar). Sem operação no documento: nada aqui edita o canvas. */
import type { Conversation } from "../../../../src/lib/canvas-conversation.ts";
import type { PortalPolicy, PortalView } from "../../../../src/lib/canvas-portal.ts";
import type { NodeRenderInput, NodeTypeDef, NodeTypeRegistry } from "../../../../src/lib/canvas-types.ts";

/** O que as rotas e o fetch injetado devolvem: só o que se lê. */
interface LiveResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
type LiveFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; cache: "no-store" }) => Promise<LiveResponse>;

/** As funções de src/lib que os nós usam; a página entrega os módulos reais, o teste entrega os mesmos. */
interface LiveModel {
  portal: { portalViewOf(node: { type: string; data: Record<string, unknown> }, policy: PortalPolicy): PortalView; buildPortalPolicy(): PortalPolicy };
  conversation: { conversationFromEvents(raw: unknown, options?: { maxEntries?: number; maxChars?: number }): Conversation };
  agentFiles: { normalizeAgentFilePath(path: unknown): string | undefined; AGENT_FILE_ROLES: readonly string[] };
}

interface LiveOpenTarget {
  kind: "file";
  agent: string | undefined;
  path: string;
  role?: string;
}

interface LiveDeps {
  fetch: LiveFetch;
  /** Relógio em milissegundos desde a época (UTC); só serve para "há X s". */
  now(): number;
  /** Política do portal no navegador; sem ela vale a mais estreita (só loopback). A rota confere de novo no servidor. */
  portalPolicy?: PortalPolicy;
  model?: LiveModel;
  /** `X-Panel-Token` da sessão, exigido pela rota de conferência do portal (padrão: window.__TOKEN). */
  panelToken?(): string | undefined;
  setTimeout?(run: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
  /** Teto de cada busca (padrão 8 s). */
  timeoutMs?: number;
  /** Intervalo da conversa de um nó selecionado (padrão 5 s; 0 desliga). */
  pollMs?: number;
  onOpen?(target: LiveOpenTarget): void;
}

type Dict = Record<string, unknown>;
type LiveStatus = "idle" | "loading" | "ok" | "error";
interface LiveError {
  code: string;
  message: string;
}
interface LiveState<T> {
  status: LiveStatus;
  /** Último dado bom: continua na tela durante a atualização e depois de um erro. */
  data: T | undefined;
  /** Instante (relógio injetado) do último dado bom. */
  at: number | undefined;
  error: LiveError | undefined;
}
type LiveResult<T> = { kind: "ok"; data: T } | { kind: "error"; error: LiveError } | { kind: "aborted" };

/** Códigos estáveis do que o nó mostra quando a busca falha (só ganham valores). Erro da rota entra pelo código dela. */
const LIVE_ERRORS = {
  timeout: "live_timeout",
  network: "live_network",
  badBody: "live_bad_body",
  badData: "live_bad_data",
  unavailable: "live_unavailable",
} as const;

const LIVE_TYPE = { portal: "portal", terminal: "terminal", tree: "tree", plan: "plan", agentFile: "agent-file", conversation: "conversation", mark: "mark" } as const;

const TIMEOUT_MS = 8000;
const POLL_MS = 5000;
const ROUTE_TREE = "/api/canvas-content/tree";
const ROUTE_PLANS = "/api/canvas-content/plans";
const ROUTE_PLAN = "/api/canvas-content/plan/";
const ROUTE_JOURNAL = "/api/journal";
const ROUTE_PORTAL_CHECK = "/api/canvas/portal/check";
const TREE_DEPTH = { min: 1, max: 4 } as const;
/** Linhas desenhadas por nó: a rota entrega até 2000 entradas, o nó mostra o começo e conta o resto. */
const VIEW_ROWS = 200;
const VIEW_UNITS = 40;
const VIEW_CONVERSATION = 200;
const STATE_CHARS = 1200;
const MESSAGE_CHARS = 200;
const AGENT_NAME = /^[\w.-]{1,80}$/;
const REGISTRY_SLUG = /^[\w.-]{1,120}$/;
const AGENT_NODE_ID = /^agent:([\w.-]{1,120}):([\w.-]{1,80})$/;
const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PANE_REF = /^[\w.:@-]{1,200}$/;

/** Texto de cada motivo de o portal não embutir (PORTAL_BLOCKS) e de recusa da rota; código novo cai na mensagem genérica. */
const PORTAL_REASON: Record<string, string> = {
  frame_options_deny: "A página proíbe ser embutida (X-Frame-Options).",
  frame_options_sameorigin: "A página só se embute na própria origem (X-Frame-Options).",
  frame_options_unknown: "A página declara uma regra de embutir que não dá para cumprir.",
  csp_frame_ancestors: "A página restringe quem pode embuti-la (frame-ancestors).",
  redirect_outside: "A página redireciona para fora da lista permitida.",
  redirect_limit: "A página redireciona vezes demais.",
  mixed_content: "Página http dentro de um painel https: o navegador bloqueia.",
  remote_loopback: "Endereço local não existe para quem acessa pelo túnel.",
  unreachable: "A página não respondeu.",
  timeout: "A página não respondeu a tempo.",
  portal_invalid_url: "Endereço do portal inválido.",
  portal_url_too_long: "Endereço do portal longo demais.",
  portal_scheme: "O portal só aceita http ou https.",
  portal_credentials: "O endereço do portal não pode levar usuário nem senha.",
  portal_host_not_allowed: "Esse host não está na lista permitida do portal.",
  portal_invalid_node: "O nó não é um portal válido.",
  portal_rate_limited: "Conferências demais; tente de novo em instantes.",
};
const PORTAL_REFUSED = new Set(["portal_invalid_url", "portal_url_too_long", "portal_scheme", "portal_credentials", "portal_host_not_allowed"]);
const REASON_FALLBACK = "Não foi possível embutir esta página.";

const ERROR_TEXT: Record<string, string> = {
  [LIVE_ERRORS.timeout]: "Sem resposta no prazo.",
  [LIVE_ERRORS.network]: "Sem resposta do painel.",
  [LIVE_ERRORS.badBody]: "Resposta ilegível do painel.",
  [LIVE_ERRORS.badData]: "O nó está com dados inválidos.",
  [LIVE_ERRORS.unavailable]: "Esta parte da página ainda não está carregada.",
};

const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const clip = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);
const liveError = (code: string, message?: string): LiveError => ({ code, message: message ? clip(message, MESSAGE_CHARS) : (ERROR_TEXT[code] ?? code) });

// ------------------------------------------------------------------ busca (timeout, cancelamento, relógio injetado)

interface Request {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  signal: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Uma busca: o timeout e o `signal` de quem chamou cancelam o mesmo pedido, e o temporizador sempre sai no fim. Resposta
 * que chega depois do cancelamento é descartada (`aborted`), mesmo se o fetch injetado ignorou o sinal. Erro da rota
 * (`{ error, code }`) vira `LiveError` com o código dela, sem ramificar pelo texto.
 */
async function requestJson(deps: LiveDeps, req: Request): Promise<LiveResult<unknown>> {
  if (req.signal.aborted) return { kind: "aborted" };
  const setTimer = deps.setTimeout ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const own = new AbortController();
  let timedOut = false;
  const timer = setTimer(() => {
    timedOut = true;
    own.abort();
  }, deps.timeoutMs ?? TIMEOUT_MS);
  const relay = (): void => {
    clearTimer(timer);
    own.abort();
  };
  req.signal.addEventListener("abort", relay, { once: true });
  try {
    const headers: Record<string, string> = { ...req.headers };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await deps.fetch(req.url, { method: req.method ?? "GET", headers, ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}), signal: own.signal, cache: "no-store" });
    let body: unknown;
    let parsed = true;
    try {
      body = await res.json();
    } catch {
      parsed = false;
    }
    if (req.signal.aborted) return { kind: "aborted" };
    if (timedOut) return { kind: "error", error: liveError(LIVE_ERRORS.timeout) };
    if (!res.ok) {
      const code = isDict(body) && typeof body.code === "string" ? body.code : `http_${res.status}`;
      return { kind: "error", error: liveError(code, isDict(body) ? text(body.error) || undefined : undefined) };
    }
    if (!parsed) return { kind: "error", error: liveError(LIVE_ERRORS.badBody) };
    return { kind: "ok", data: body };
  } catch {
    if (req.signal.aborted) return { kind: "aborted" };
    return { kind: "error", error: liveError(timedOut ? LIVE_ERRORS.timeout : LIVE_ERRORS.network) };
  } finally {
    clearTimer(timer);
    req.signal.removeEventListener("abort", relay);
  }
}

const IDLE: LiveState<never> = { status: "idle", data: undefined, at: undefined, error: undefined };

/**
 * Busca de um nó: roda quando `key` muda (ou `reload` é chamado) e, se `refreshMs > 0`, de novo a cada intervalo depois que
 * a anterior terminou (nunca duas em voo). `key === null` desliga. A desmontagem e a troca de chave cancelam o pedido e o
 * temporizador juntos. `load` devolve o dado já interpretado ou lança `LiveError`-like via `{ kind: "error" }`.
 */
function useLive<T>(deps: LiveDeps, key: string | null, load: (signal: AbortSignal) => Promise<LiveResult<T>>, refreshMs: number): [LiveState<T>, () => void] {
  const [state, setState] = React.useState<LiveState<T>>(IDLE as LiveState<T>);
  const [tick, setTick] = React.useState(0);
  const seen = React.useRef<string | null>(null);
  React.useEffect(() => {
    // outra chave é outro recurso: o dado do anterior não fica na tela; recarregar (tick) ou renovar mantém o último dado bom
    if (seen.current !== key) {
      seen.current = key;
      setState(IDLE as LiveState<T>);
    }
    if (key === null) return undefined;
    const ctl = new AbortController();
    const setTimer = deps.setTimeout ?? ((run, ms) => setTimeout(run, ms));
    const clearTimer = deps.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    let timer: unknown;
    const run = async (): Promise<void> => {
      setState((prev) => ({ ...prev, status: "loading", error: undefined }));
      const result = await load(ctl.signal);
      if (ctl.signal.aborted || result.kind === "aborted") return;
      if (result.kind === "ok") setState({ status: "ok", data: result.data, at: deps.now(), error: undefined });
      else setState((prev) => ({ ...prev, status: "error", error: result.error }));
      if (refreshMs > 0) timer = setTimer(() => void run(), refreshMs);
    };
    void run();
    return () => {
      ctl.abort();
      if (timer !== undefined) clearTimer(timer);
    };
  }, [key, tick, refreshMs]);
  return [state, () => setTick((n) => n + 1)];
}

/** Busca que devolve o JSON já conferido por `read`; o que `read` recusa vira `live_bad_body`. */
async function fetchRead<T>(deps: LiveDeps, req: Request, read: (raw: unknown) => T | undefined): Promise<LiveResult<T>> {
  const res = await requestJson(deps, req);
  if (res.kind !== "ok") return res;
  const data = read(res.data);
  return data === undefined ? { kind: "error", error: liveError(LIVE_ERRORS.badBody) } : { kind: "ok", data };
}

// ------------------------------------------------------------------ dados do nó (conferidos na fronteira)

const modelOf = (deps: LiveDeps): LiveModel | undefined => deps.model ?? (globalThis as unknown as { CanvasModel?: Partial<LiveModel> }).CanvasModel as LiveModel | undefined;

/** `agent:<registro>:<nome>` (o id do nó do agente) ou só o nome; qualquer outra forma é recusada. */
function agentRefOf(raw: unknown): { name: string; registry: string | undefined } | undefined {
  const value = text(raw);
  const id = AGENT_NODE_ID.exec(value);
  if (id) return { registry: id[1] as string, name: id[2] as string };
  return AGENT_NAME.test(value) ? { name: value, registry: undefined } : undefined;
}

const query = (pairs: Record<string, string | number | undefined>): string => {
  const parts = Object.entries(pairs).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
};

const depthOf = (raw: unknown): number => (typeof raw === "number" && Number.isInteger(raw) ? Math.min(TREE_DEPTH.max, Math.max(TREE_DEPTH.min, raw)) : TREE_DEPTH.min);

interface TreeRow {
  path: string;
  name: string;
  kind: string;
  depth: number;
  change: string | null;
  below: number;
}
interface TreeView {
  rows: TreeRow[];
  hidden: number;
  truncated: boolean;
  marks: boolean;
}

/** A resposta da rota de árvore como linhas indentadas (até `VIEW_ROWS`); o resto só é contado. */
function treeViewOf(raw: unknown, base: string): TreeView | undefined {
  if (!isDict(raw) || !Array.isArray(raw.entries)) return undefined;
  const baseDepth = base === "" ? 0 : base.split("/").length;
  const rows: TreeRow[] = [];
  for (const entry of raw.entries.slice(0, VIEW_ROWS)) {
    if (!isDict(entry) || typeof entry.path !== "string" || typeof entry.name !== "string") continue;
    rows.push({
      path: entry.path,
      name: entry.name,
      kind: text(entry.type),
      depth: Math.max(0, entry.path.split("/").length - baseDepth - 1),
      change: typeof entry.change === "string" ? entry.change : null,
      below: typeof entry.changedBelow === "number" ? entry.changedBelow : 0,
    });
  }
  const changes = isDict(raw.changes) ? raw.changes : {};
  return { rows, hidden: Math.max(0, raw.entries.length - rows.length), truncated: raw.truncated === true, marks: changes.available === true };
}

interface PlanView {
  title: string;
  state: string;
  stateClipped: boolean;
  units: { name: string; role: string; agentState: string | null }[];
  hiddenUnits: number;
}

function planViewOf(raw: unknown): PlanView | undefined {
  if (!isDict(raw) || typeof raw.title !== "string" || !Array.isArray(raw.units)) return undefined;
  const units = raw.units.slice(0, VIEW_UNITS).flatMap((u) => {
    if (!isDict(u) || typeof u.name !== "string") return [];
    return [{ name: u.name, role: text(u.role), agentState: isDict(u.agent) ? text(u.agent.state) || "?" : null }];
  });
  const state = text(raw.state);
  return { title: raw.title, state: clip(state, STATE_CHARS), stateClipped: state.length > STATE_CHARS, units, hiddenUnits: Math.max(0, raw.units.length - units.length) };
}

const planNamesOf = (raw: unknown): string[] | undefined =>
  isDict(raw) && Array.isArray(raw.plans) ? raw.plans.flatMap((p) => (isDict(p) && typeof p.name === "string" && PLAN_NAME.test(p.name) ? [p.name] : [])) : undefined;

/** O que o portal mostra, a partir do que o documento diz (`view`) e do que a rota respondeu (`verdict`). */
type PortalPlan =
  | { kind: "checking"; url: string }
  | { kind: "frame"; url: string }
  | { kind: "link"; url: string; reason: string }
  | { kind: "refused"; reason: string };

function portalPlanOf(view: PortalView, check: LiveState<Dict>): PortalPlan {
  if (view.state === "blocked") return { kind: "refused", reason: PORTAL_REASON[view.code] ?? REASON_FALLBACK };
  const code = check.error?.code ?? "";
  if (check.status === "error" && check.data === undefined) {
    const reason = PORTAL_REASON[code] ?? check.error?.message ?? REASON_FALLBACK;
    // a rota recusou o endereço (400/403): não se oferece nem o link; falha de rede, prazo ou limite de taxa ainda deixam abrir
    return PORTAL_REFUSED.has(code) ? { kind: "refused", reason } : { kind: "link", url: view.url, reason };
  }
  const verdict = check.data;
  if (verdict === undefined) return { kind: "checking", url: view.url };
  if (verdict.embeddable === true) return { kind: "frame", url: view.url };
  return { kind: "link", url: view.url, reason: PORTAL_REASON[text(verdict.reason)] ?? REASON_FALLBACK };
}

/** "há 5 s" a partir de um instante em milissegundos e do relógio injetado. */
function ageLabel(nowMs: number, atMs: number | undefined): string {
  if (atMs === undefined) return "";
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  return s < 60 ? `há ${s} s` : s < 3600 ? `há ${Math.floor(s / 60)} min` : `há ${Math.floor(s / 3600)} h`;
}

// ------------------------------------------------------------------ desenho

const h = React.createElement;
const ROLE_TONE: Record<string, string> = { user: "text-foreground", agent: "text-muted-foreground", system: "text-warn" };
const CHANGE_WORD: Record<string, string> = { A: "novo", M: "mudado", D: "apagado", T: "tipo" };
const BODY = "flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2 t-body";
const LINK = "underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-ring";
const ROW_BTN = "flex w-full items-center gap-2 px-2 py-1 text-left t-body outline-none hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-md:min-h-11 disabled:cursor-default";

function Note(props: { children: ReactNode; tone?: string; status?: boolean }): ReactNode {
  return h("p", { className: `t-meta ${props.tone ?? "text-muted-foreground"}`, ...(props.status ? { role: "status" } : {}) }, props.children);
}

const errorLine = (state: LiveState<unknown>): ReactNode => (state.error ? h(Note, { tone: "text-bad", status: true }, `${state.error.message} (${state.error.code})`) : null);

function Refresh(props: { onClick(): void; busy: boolean; at: string }): ReactNode {
  return h("div", { className: "flex items-center gap-2" },
    h("button", { type: "button", onClick: props.onClick, disabled: props.busy, className: `${LINK} t-meta max-md:min-h-11` }, props.busy ? "Atualizando…" : "Atualizar"),
    props.at ? h("span", { className: "t-meta text-muted-foreground" }, props.at) : null);
}

function PortalNode(props: { deps: LiveDeps; node: NodeRenderInput }): ReactNode {
  const { deps, node } = props;
  const model = modelOf(deps);
  const policy = deps.portalPolicy ?? model?.portal.buildPortalPolicy();
  const view = model && policy ? model.portal.portalViewOf({ type: node.type, data: { ...node.data } }, policy) : undefined;
  const url = view?.state === "ready" ? view.url : null;
  const [check, reload] = useLive<Dict>(deps, url, (signal) => {
    const token = deps.panelToken ? deps.panelToken() : (globalThis as unknown as { __TOKEN?: string }).__TOKEN;
    return fetchRead(deps, { url: ROUTE_PORTAL_CHECK, method: "POST", body: { url }, signal, headers: token ? { "X-Panel-Token": token } : {} }, (raw) => (isDict(raw) ? raw : undefined));
  }, 0);
  if (!view) return h("div", { className: BODY }, h(Note, { tone: "text-bad", status: true }, ERROR_TEXT[LIVE_ERRORS.unavailable]));
  const plan = portalPlanOf(view, check);
  if (plan.kind === "frame") {
    // sandbox mínimo: scripts e formulários da página, sem allow-same-origin (a página não alcança o painel nem seus cookies)
    return h("iframe", { src: plan.url, title: `Portal ${plan.url}`, sandbox: "allow-scripts allow-forms", referrerPolicy: "no-referrer", loading: "lazy", className: "size-full border-0 bg-background" });
  }
  return h("div", { className: BODY },
    plan.kind === "checking" ? h(Note, { status: true }, "Conferindo se a página pode ser embutida…") : null,
    plan.kind === "refused" ? h(Note, { tone: "text-bad", status: true }, plan.reason) : null,
    plan.kind === "link" ? h(Note, { status: true }, plan.reason) : null,
    plan.kind === "link" ? h("a", { href: plan.url, target: "_blank", rel: "noopener noreferrer", className: `${LINK} break-all` }, `Abrir ${plan.url} em outra aba`) : null,
    plan.kind === "link" || plan.kind === "checking" ? h(Refresh, { onClick: reload, busy: check.status === "loading", at: ageLabel(deps.now(), check.at) }) : null);
}

function TerminalNode(props: { deps: LiveDeps; node: NodeRenderInput }): ReactNode {
  const { node } = props;
  const api = (globalThis as unknown as { ArgosNodeTerminal?: { NodeTerminal: (p: Dict) => ReactNode } }).ArgosNodeTerminal;
  const session = text(node.data.session);
  const pane = text(node.data.pane);
  if (!api) return h("div", { className: BODY }, h(Note, { tone: "text-bad", status: true }, ERROR_TEXT[LIVE_ERRORS.unavailable]));
  if (!PANE_REF.test(session) || !PANE_REF.test(pane)) return h("div", { className: BODY }, h(Note, { tone: "text-bad", status: true }, `${ERROR_TEXT[LIVE_ERRORS.badData]} Falta a sessão ou o painel do herdr.`));
  // o terminal só lê de tempos em tempos com o nó selecionado; solto, mostra a última leitura
  return h(api.NodeTerminal, { session, pane, hasAgent: node.data.hasAgent === true, live: node.selected });
}

/** O nó do Mark vive em node-mark.tsx; o painel fala com ele em /api/mark/*, e o token do Mark nunca passa por aqui. */
function MarkNode(): ReactNode {
  const api = (globalThis as unknown as { ArgosNodeMark?: { MarkNode: () => ReactNode } }).ArgosNodeMark;
  if (!api) return h("div", { className: BODY }, h(Note, { tone: "text-bad", status: true }, ERROR_TEXT[LIVE_ERRORS.unavailable]));
  return h(api.MarkNode);
}

function TreeNode(props: { deps: LiveDeps; node: NodeRenderInput }): ReactNode {
  const { deps, node } = props;
  const model = modelOf(deps);
  const agent = agentRefOf(node.data.agent);
  const registry = text(node.data.registry) || agent?.registry;
  const [path, setPath] = React.useState(text(node.data.path));
  const depth = depthOf(node.data.depth);
  const checkedPath = path === "" ? "" : model?.agentFiles.normalizeAgentFilePath(path);
  const valid = agent !== undefined && model !== undefined && checkedPath !== undefined && (registry === undefined || REGISTRY_SLUG.test(registry));
  const key = valid ? `${agent.name}|${registry ?? ""}|${checkedPath}|${depth}` : null;
  const [state, reload] = useLive<TreeView>(deps, key, (signal) =>
    fetchRead(deps, { url: `${ROUTE_TREE}${query({ agent: agent?.name, registry, path: checkedPath, depth })}`, signal }, (raw) => treeViewOf(raw, checkedPath ?? "")), 0);
  if (!valid) return h("div", { className: BODY }, h(Note, { tone: "text-bad", status: true }, `${ERROR_TEXT[LIVE_ERRORS.badData]} Falta o agente ou o caminho é inválido.`));
  const up = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const view = state.data;
  return h("div", { className: BODY },
    h("div", { className: "flex items-center gap-2" },
      h("span", { className: "t-meta-em min-w-0 flex-1 truncate" }, `${agent.name}/${path}`),
      path !== "" ? h("button", { type: "button", className: `${LINK} t-meta max-md:min-h-11`, onClick: () => setPath(up) }, "Subir") : null,
      h(Refresh, { onClick: reload, busy: state.status === "loading", at: ageLabel(deps.now(), state.at) })),
    errorLine(state),
    view && view.rows.length === 0 ? h(Note, null, "Pasta vazia.") : null,
    view ? h("ul", { className: "min-h-0 flex-1 overflow-auto scrollbar-thin", "aria-label": `Arquivos de ${agent.name}` }, ...view.rows.map((row) =>
      h("li", { key: row.path },
        h("button", {
          type: "button", style: { paddingLeft: `${0.5 + row.depth}rem` }, className: ROW_BTN,
          disabled: row.kind !== "dir" && !deps.onOpen,
          onClick: () => (row.kind === "dir" ? setPath(row.path) : deps.onOpen?.({ kind: "file", agent: agent.name, path: row.path })),
        },
        h("span", { className: "min-w-0 flex-1 truncate" }, row.kind === "dir" ? `${row.name}/` : row.name),
        row.change ? h("span", { className: "t-meta text-warn" }, CHANGE_WORD[row.change] ?? row.change) : null,
        row.below > 0 ? h("span", { className: "t-meta text-warn" }, `${row.below} mudados`) : null)))) : null,
    view && view.hidden > 0 ? h(Note, null, `Mais ${view.hidden} entradas fora da lista.`) : null,
    view && view.truncated ? h(Note, null, "A pasta passa do teto de entradas; a lista foi cortada.") : null,
    view && !view.marks ? h(Note, null, "Sem as marcas do que mudou na branch.") : null);
}

function PlanNode(props: { deps: LiveDeps; node: NodeRenderInput }): ReactNode {
  const { deps, node } = props;
  const [picked, setPicked] = React.useState(text(node.data.name));
  const named = picked !== "" && PLAN_NAME.test(picked);
  const [plan, reloadPlan] = useLive<PlanView>(deps, named ? picked : null, (signal) =>
    fetchRead(deps, { url: `${ROUTE_PLAN}${encodeURIComponent(picked)}`, signal }, planViewOf), 0);
  const [names, reloadNames] = useLive<string[]>(deps, picked === "" ? "plans" : null, (signal) => fetchRead(deps, { url: ROUTE_PLANS, signal }, planNamesOf), 0);
  if (picked !== "" && !named) return h("div", { className: BODY }, h(Note, { tone: "text-bad", status: true }, `${ERROR_TEXT[LIVE_ERRORS.badData]} Nome de plano inválido.`));
  if (picked === "") {
    return h("div", { className: BODY },
      h(Note, null, "Escolha um plano"),
      errorLine(names),
      names.data && names.data.length === 0 ? h(Note, null, "Nenhum plano encontrado.") : null,
      h("ul", { className: "min-h-0 flex-1 overflow-auto scrollbar-thin" }, ...(names.data ?? []).map((name) =>
        h("li", { key: name }, h("button", { type: "button", className: ROW_BTN, onClick: () => setPicked(name) }, name)))),
      h(Refresh, { onClick: reloadNames, busy: names.status === "loading", at: ageLabel(deps.now(), names.at) }));
  }
  const view = plan.data;
  return h("div", { className: BODY },
    h("div", { className: "flex items-center gap-2" },
      h("span", { className: "t-meta-em min-w-0 flex-1 truncate" }, view?.title || picked),
      h(Refresh, { onClick: reloadPlan, busy: plan.status === "loading", at: ageLabel(deps.now(), plan.at) })),
    errorLine(plan),
    view ? h("div", { className: "min-h-0 flex-1 overflow-auto scrollbar-thin" },
      view.state ? h("pre", { className: "whitespace-pre-wrap break-words t-data" }, view.state + (view.stateClipped ? "…" : "")) : h(Note, null, "O plano não tem a seção de estado."),
      h("ul", { "aria-label": "Unidades do plano", className: "mt-2 grid gap-1" }, ...view.units.map((u) =>
        h("li", { key: u.name, className: "flex items-center gap-2" },
          h("span", { className: "t-meta-em min-w-0 flex-1 truncate" }, u.name),
          h("span", { className: "t-meta text-muted-foreground" }, u.role),
          h("span", { className: "t-meta" }, u.agentState === null ? "sem agente" : u.agentState)))),
      view.hiddenUnits > 0 ? h(Note, null, `Mais ${view.hiddenUnits} unidades fora da lista.`) : null) : null);
}

function AgentFileNode(props: { deps: LiveDeps; node: NodeRenderInput }): ReactNode {
  const { deps, node } = props;
  const model = modelOf(deps);
  const agent = agentRefOf(node.data.agent);
  const path = model?.agentFiles.normalizeAgentFilePath(node.data.path);
  const role = text(node.data.role);
  const roleOk = model?.agentFiles.AGENT_FILE_ROLES.includes(role) === true;
  const dir = path === undefined ? "" : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const key = agent && path !== undefined && roleOk ? `${agent.name}|${agent.registry ?? ""}|${dir}` : null;
  // a rota de árvore diz se o arquivo ainda existe; o conteúdo do arquivo nunca passa por ela
  const [state] = useLive<boolean>(deps, key, (signal) =>
    fetchRead(deps, { url: `${ROUTE_TREE}${query({ agent: agent?.name, registry: agent?.registry, path: dir, depth: 1 })}`, signal }, (raw) =>
      (isDict(raw) && Array.isArray(raw.entries) ? raw.entries.some((e) => isDict(e) && e.path === path) : undefined)), 0);
  if (!agent || path === undefined || !roleOk) return h("div", { className: BODY }, h(Note, { tone: "text-bad", status: true }, `${ERROR_TEXT[LIVE_ERRORS.badData]} Caminho ou papel inválido.`));
  const missing = state.status === "ok" && state.data === false;
  return h("button", {
    type: "button", disabled: !deps.onOpen, className: `${ROW_BTN} size-full flex-col items-start justify-center border`,
    onClick: () => deps.onOpen?.({ kind: "file", agent: agent.name, path, role }),
  },
  h("span", { className: "t-meta-em" }, role),
  h("span", { className: "t-data w-full truncate text-muted-foreground" }, path),
  missing ? h("span", { className: "t-meta text-warn", role: "status" }, "O arquivo ainda não existe na worktree.") : null,
  state.status === "error" ? h("span", { className: "t-meta text-muted-foreground", role: "status" }, "Não confirmei se o arquivo existe.") : null);
}

function ConversationNode(props: { deps: LiveDeps; node: NodeRenderInput }): ReactNode {
  const { deps, node } = props;
  const model = modelOf(deps);
  const agent = agentRefOf(node.data.agent);
  const limit = typeof node.data.limit === "number" && Number.isInteger(node.data.limit) ? Math.min(VIEW_CONVERSATION, Math.max(1, node.data.limit)) : VIEW_CONVERSATION;
  const key = agent && model ? `${agent.name}|${limit}` : null;
  const pollMs = node.selected ? (deps.pollMs ?? POLL_MS) : 0;
  const [state, reload] = useLive<Conversation>(deps, key, async (signal) => {
    const res = await requestJson(deps, { url: `${ROUTE_JOURNAL}${query({ agent: agent?.name, limit })}`, signal });
    if (res.kind !== "ok") return res;
    if (!isDict(res.data) || !Array.isArray(res.data.events)) return { kind: "error", error: liveError(LIVE_ERRORS.badBody) };
    try {
      return { kind: "ok", data: (model as LiveModel).conversation.conversationFromEvents(res.data.events, { maxEntries: limit }) };
    } catch {
      return { kind: "error", error: liveError(LIVE_ERRORS.badBody) };
    }
  }, pollMs);
  if (!agent || !model) return h("div", { className: BODY }, h(Note, { tone: "text-bad", status: true }, `${ERROR_TEXT[LIVE_ERRORS.badData]} Falta o agente.`));
  const conv = state.data;
  return h("div", { className: BODY },
    h("div", { className: "flex items-center gap-2" },
      h("span", { className: "t-meta-em min-w-0 flex-1 truncate" }, `Conversa de ${agent.name}`),
      h(Refresh, { onClick: reload, busy: state.status === "loading", at: ageLabel(deps.now(), state.at) })),
    errorLine(state),
    conv && conv.entries.length === 0 ? h(Note, null, "O diário não tem eventos deste agente.") : null,
    conv && (conv.omitted > 0 || conv.invalid > 0) ? h(Note, null, `${conv.omitted} entradas mais antigas fora da lista · ${conv.invalid} linhas ignoradas`) : null,
    conv ? h("ol", { className: "min-h-0 flex-1 overflow-auto scrollbar-thin", "aria-label": `Conversa de ${agent.name}` }, ...conv.entries.map((e, i) =>
      h("li", { key: `${e.ts}-${i}`, className: `break-words ${ROLE_TONE[e.role] ?? ""}` }, h("span", { className: "t-meta-em mr-1.5" }, e.label), e.text))) : null);
}

// ------------------------------------------------------------------ registro

const SIZES = { portal: { w: 640, h: 420 }, terminal: { w: 640, h: 400 }, tree: { w: 320, h: 400 }, plan: { w: 420, h: 400 }, agentFile: { w: 240, h: 60 }, conversation: { w: 420, h: 400 }, mark: { w: 360, h: 420 } } as const;

type LiveComponent = (props: { deps: LiveDeps; node: NodeRenderInput }) => ReactNode;

function liveTypeDefs(deps: LiveDeps): NodeTypeDef[] {
  const def = (type: string, label: string, icon: string, size: { w: number; h: number }, Component: LiveComponent): NodeTypeDef => ({
    type, label, icon, defaultSize: { ...size }, menu: [], actions: [], live: false,
    draw: { surface: "html", render: (input: NodeRenderInput) => h(Component, { key: input.id, deps, node: input }) },
  });
  return [
    def(LIVE_TYPE.portal, "Portal", "Globe", SIZES.portal, PortalNode),
    def(LIVE_TYPE.terminal, "Terminal", "Terminal", SIZES.terminal, TerminalNode),
    def(LIVE_TYPE.tree, "Árvore de arquivos", "FolderTree", SIZES.tree, TreeNode),
    def(LIVE_TYPE.plan, "Plano", "ClipboardList", SIZES.plan, PlanNode),
    def(LIVE_TYPE.agentFile, "Arquivo do agente", "FileText", SIZES.agentFile, AgentFileNode),
    def(LIVE_TYPE.conversation, "Conversa", "MessagesSquare", SIZES.conversation, ConversationNode),
    def(LIVE_TYPE.mark, "Mark", "Orbit", SIZES.mark, MarkNode),
  ];
}

/** Registra os sete tipos; chamar de novo (modo estrito do React) não repete nem lança: o que já existe fica como está. */
function registerLiveTypes(types: NodeTypeRegistry, deps: LiveDeps): NodeTypeDef[] {
  const done: NodeTypeDef[] = [];
  for (const def of liveTypeDefs(deps)) done.push(types.get(def.type) ?? types.register(def));
  return done;
}

/** Vistas Conversa e Arquivos do nó `agent` desenhado como terminal: os mesmos nós de conversa e de árvore, ligados ao agente. */
function agentView(deps: LiveDeps, kind: "conversation" | "files", input: NodeRenderInput): ReactNode {
  if (kind === "conversation") return h(ConversationNode, { deps, node: { ...input, data: { agent: input.id } } });
  return h(TreeNode, { deps, node: { ...input, data: { agent: input.id, path: "" } } });
}

const ArgosTypesLive = { registerLiveTypes, liveTypeDefs, agentView, requestJson, useLive, treeViewOf, planViewOf, portalPlanOf, agentRefOf, ageLabel, LIVE_TYPE, LIVE_ERRORS, PORTAL_REASON };
type ArgosTypesLiveApi = typeof ArgosTypesLive;
(globalThis as unknown as { ArgosTypesLive: ArgosTypesLiveApi }).ArgosTypesLive = ArgosTypesLive;
export type { ArgosTypesLiveApi, LiveDeps, LiveModel, LiveOpenTarget, LiveState, TreeView, PlanView, PortalPlan };
