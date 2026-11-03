/* Permissão pendente no próprio nó do canvas do Argos: mostra qual ferramenta pede licença e
 * oferece aprovar ou negar por POST /api/argos/action (approve_permission / deny_permission), com estado de envio, erro e
 * confirmação. Script clássico: registra window.ArgosNodePermission. Depende de React e de window.CanvasModel.actions
 * (src/lib/canvas-actions.ts, que decide se a ação vale agora). O servidor continua sendo o controle: esconder ou desligar o
 * botão aqui é só tela. Todo fetch é injetado e tem timeout; o pedido em voo morre com o componente.
 * Também entrega `createActionSender`, o envio do POST que o balão (node-balloon.tsx) reaproveita. */
import type { ActionContext, ActionNode, ActionRequest } from "../../../../src/lib/canvas-actions.ts";
import type * as ActionsModule from "../../../../src/lib/canvas-actions.ts";

/** Códigos estáveis das falhas do lado do cliente (as do servidor chegam como vieram, em `code`). Só ganham valores. */
const SEND_ERRORS = {
  timeout: "send_timeout",
  network: "send_network",
  aborted: "send_aborted",
  unexpected: "send_unexpected_response",
  notAvailable: "send_not_available",
} as const;
type SendErrorCode = (typeof SEND_ERRORS)[keyof typeof SEND_ERRORS];

type ActionOutcome =
  | { ok: true; output: string }
  | { ok: false; code: string; message: string; status: number };

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}
type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;
interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
type ActionSender = (request: ActionRequest, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<ActionOutcome>;

interface SenderOptions {
  fetch: FetchLike;
  /** Teto de espera por padrão; cada envio pode pedir outro. */
  timeoutMs?: number;
  timers?: Timers;
  /** Token do painel (`X-Panel-Token`); lido a cada envio, porque o painel pode reiniciar com a aba aberta. */
  getToken?: () => string | undefined;
  onToken?: (token: string) => void;
}

interface PermissionView {
  /** Ferramenta do pedido (`Bash`, `Edit`…); `null` quando o diário não a registrou. */
  tool: string | null;
  /** Instante do pedido: muda a cada pedido novo e reinicia o estado do componente. */
  since: string;
  approve: ButtonView;
  deny: ButtonView;
  /** Por que nenhum dos dois vale (a permissão se responde no terminal, o herdr não vê o agente…). */
  blockedReason: string | undefined;
}
interface ButtonView {
  action: "approve_permission" | "deny_permission";
  label: string;
  available: boolean;
}

type PermissionState =
  | { phase: "idle" }
  | { phase: "sending"; action: ButtonView["action"] }
  | { phase: "confirmed"; action: ButtonView["action"] }
  | { phase: "error"; action: ButtonView["action"]; code: string; message: string };

type PermissionEvent =
  | { type: "send"; action: ButtonView["action"] }
  | { type: "outcome"; action: ButtonView["action"]; outcome: ActionOutcome }
  | { type: "reset" };

interface NodePermissionProps {
  node: ActionNode;
  ctx?: ActionContext;
  /** Envio pronto (`createActionSender`); sem ele, monta-se um com `fetch`. */
  send?: ActionSender;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Texto de um código de erro do servidor; padrão: `ArgosLogic.errorText` da página, senão a mensagem recebida. */
  errorText?: (code: string | undefined, fallback: string) => string;
  /** Depois da resposta do servidor (aceita ou recusada): a página atualiza o grafo. */
  onResult?: (action: ButtonView["action"], outcome: ActionOutcome) => void;
  className?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MESSAGE_MAX = 300;
const ACTION_URL = "/api/argos/action";
const TOKEN_URL = "/api/token";
const TOKEN_REJECTED = "token";
const FORBIDDEN = 403;
const SERVER_ERROR_FROM = 500;
const INTERNAL_ERROR_CODE = "internal_error";

const APPROVE = "approve_permission";
const DENY = "deny_permission";
const WORDS = {
  approve: "Aprovar",
  deny: "Negar",
  sending: "Enviando…",
  approved: "Aprovada: o agente deve seguir em instantes.",
  denied: "Negada: o agente recebeu o Escape.",
  unknownTool: "uma ferramenta",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clip = (text: string): string => (text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}…` : text);

const realTimers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

const failure = (code: string, message: string, status = 0): ActionOutcome => ({ ok: false, code, message, status });

/**
 * O envio de uma ação ao servidor. Nunca lança: devolve `{ ok: true, output }` ou `{ ok: false, code, message, status }`.
 * Timeout, queda de rede e cancelamento viram códigos próprios (`send_*`); o resto vem da rota. O temporizador e o ouvinte do
 * sinal externo saem juntos no fim de cada envio.
 */
function createActionSender(options: SenderOptions): ActionSender {
  const timers = options.timers ?? realTimers;
  const post = async (request: ActionRequest, signal: AbortSignal, token: string | undefined): Promise<FetchResponse> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["X-Panel-Token"] = token;
    return options.fetch(ACTION_URL, { method: "POST", headers, body: JSON.stringify(request), signal });
  };
  const readBody = async (res: FetchResponse): Promise<Record<string, unknown>> => {
    try {
      const body = await res.json();
      return isRecord(body) ? body : {};
    } catch {
      // corpo que não é JSON: quem lê trata como resposta fora do contrato
      return {};
    }
  };
  /** Painel reiniciado com a aba aberta: o token da página ficou velho; pede um novo e tenta uma vez mais. */
  const refreshToken = async (signal: AbortSignal): Promise<string | undefined> => {
    const res = await options.fetch(TOKEN_URL, { method: "GET", headers: {}, signal });
    const body = await readBody(res);
    return typeof body.token === "string" && body.token !== "" ? body.token : undefined;
  };

  return async (request, own = {}) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = timers.set(() => {
      timedOut = true;
      controller.abort();
    }, own.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const relay = (): void => controller.abort();
    if (own.signal?.aborted) controller.abort();
    own.signal?.addEventListener("abort", relay, { once: true });
    try {
      let token = options.getToken?.();
      let res = await post(request, controller.signal, token);
      let body = await readBody(res);
      if (res.status === FORBIDDEN && body.error === TOKEN_REJECTED) {
        const fresh = await refreshToken(controller.signal);
        if (fresh !== undefined && fresh !== token) {
          token = fresh;
          options.onToken?.(fresh);
          res = await post(request, controller.signal, token);
          body = await readBody(res);
        }
      }
      if (res.ok && body.ok === true) return { ok: true, output: typeof body.output === "string" ? body.output : "" };
      const text = typeof body.error === "string" ? clip(body.error) : `HTTP ${res.status}`;
      if (typeof body.code === "string") return failure(body.code, text, res.status);
      return failure(res.status >= SERVER_ERROR_FROM ? INTERNAL_ERROR_CODE : SEND_ERRORS.unexpected, text, res.status);
    } catch (error) {
      if (timedOut) return failure(SEND_ERRORS.timeout, "o painel não respondeu a tempo");
      if (controller.signal.aborted) return failure(SEND_ERRORS.aborted, "envio cancelado");
      return failure(SEND_ERRORS.network, clip(error instanceof Error ? error.message : "sem resposta do painel"));
    } finally {
      timers.clear(timer);
      own.signal?.removeEventListener("abort", relay);
    }
  };
}

function makeArgosNodePermission() {
  const model = (globalThis as unknown as { CanvasModel?: { actions: typeof ActionsModule } }).CanvasModel;
  if (!model?.actions) throw new Error("ArgosNodePermission: carregue /ui/lib/canvas-model.js (com a chave `actions`) antes de node-permission.js");
  const A = model.actions;

  /** O que a tela mostra de um nó com permissão pendente; `null` quando não há pedido (nada é desenhado). */
  function permissionView(node: ActionNode, ctx: ActionContext = {}): PermissionView | null {
    const pending = node.pendingPermission;
    if (!pending) return null;
    const items = A.actionsFor(node, ctx);
    const button = (action: ButtonView["action"], label: string): ButtonView => ({ action, label, available: items.find((i) => i.key === action)?.available === true });
    const approve = button(APPROVE, WORDS.approve);
    const deny = button(DENY, WORDS.deny);
    const reason = items.find((i) => i.key === APPROVE)?.reason?.message;
    return { tool: pending.tool, since: pending.ts, approve, deny, blockedReason: approve.available ? undefined : reason };
  }

  const initialState: PermissionState = { phase: "idle" };

  function permissionReducer(state: PermissionState, event: PermissionEvent): PermissionState {
    switch (event.type) {
      case "reset":
        return initialState;
      case "send":
        return state.phase === "sending" ? state : { phase: "sending", action: event.action };
      case "outcome":
        if (state.phase !== "sending" || state.action !== event.action) return state;
        return event.outcome.ok
          ? { phase: "confirmed", action: event.action }
          : { phase: "error", action: event.action, code: event.outcome.code, message: event.outcome.message };
      default: {
        const never: never = event;
        return never;
      }
    }
  }

  /** Confere que a ação vale agora (a mesma conta do menu) e a envia; ação que não vale nem sai do navegador. */
  async function answerPermission(
    node: ActionNode,
    action: ButtonView["action"],
    deps: { send: ActionSender; ctx?: ActionContext; signal?: AbortSignal },
  ): Promise<ActionOutcome> {
    const item = A.actionsFor(node, deps.ctx ?? {}).find((i) => i.key === action);
    if (!item || !item.available) return failure(item?.reason?.code ?? SEND_ERRORS.notAvailable, item?.reason?.message ?? "a ação não vale para este nó");
    return deps.send(A.actionRequest(node, action), deps.signal ? { signal: deps.signal } : {});
  }

  const stateMessage = (state: PermissionState, errorText: (code: string | undefined, fallback: string) => string): string => {
    if (state.phase === "sending") return WORDS.sending;
    if (state.phase === "confirmed") return state.action === APPROVE ? WORDS.approved : WORDS.denied;
    return state.phase === "error" ? errorText(state.code, state.message) : "";
  };

  const BOX = "flex flex-col gap-1.5 border border-warn bg-background p-2 t-body";
  const BTN = "inline-flex min-h-8 cursor-pointer items-center justify-center border border-border-strong px-3 t-label outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40 max-md:min-h-11";

  interface PermissionUi {
    h: ReactApi["createElement"];
    className?: string;
    onApprove(): void;
    onDeny(): void;
  }

  /** Árvore de elementos: pura, sem hooks, para o teste ler sem DOM. `message` é o texto de estado (envio, erro, confirmação). */
  function renderPermission(ui: PermissionUi, view: PermissionView, state: PermissionState, message: string): ReactNode {
    const { h } = ui;
    const sending = state.phase === "sending";
    const tool = view.tool ?? WORDS.unknownTool;
    const done = state.phase === "confirmed";
    const clickable = (b: ButtonView): boolean => b.available && !sending && !done;
    return h("div", { className: ui.className ?? BOX, role: "group", "aria-label": `Permissão pendente: ${tool}` },
      h("span", { className: "t-meta-em" }, `Pede permissão: ${tool}`),
      view.blockedReason ? h("span", { className: "t-meta text-muted-foreground" }, view.blockedReason) : null,
      h("div", { className: "flex gap-2" },
        h("button", { type: "button", className: BTN, disabled: !clickable(view.approve), "aria-busy": sending && state.action === APPROVE ? true : undefined, onClick: ui.onApprove }, view.approve.label),
        h("button", { type: "button", className: BTN, disabled: !clickable(view.deny), "aria-busy": sending && state.action === DENY ? true : undefined, onClick: ui.onDeny }, view.deny.label)),
      // região viva sempre presente: o leitor de tela ouve o envio, o erro e a confirmação sem o foco sair do botão
      h("span", { role: state.phase === "error" ? "alert" : "status", className: state.phase === "error" ? "t-meta text-bad" : "t-meta text-muted-foreground" }, message));
  }

  function NodePermission(props: NodePermissionProps): ReactNode {
    const { node, ctx } = props;
    const [state, setState] = React.useState<PermissionState>(initialState);
    const alive = React.useRef<AbortController | null>(null);
    const view = permissionView(node, ctx);
    const since = view?.since;

    // outro agente, ou pedido novo (outro `ts`): o resultado do pedido anterior não vale mais. Sem pedido (o grafo já limpou)
    // a confirmação fica na tela até chegar outro.
    const reset = (): void => {
      alive.current?.abort();
      setState(initialState);
    };
    React.useEffect(reset, [node.id]);
    React.useEffect(() => {
      if (since !== undefined) reset();
    }, [since]);
    // o envio em voo tem o mesmo dono do componente: sai junto
    React.useEffect(() => () => alive.current?.abort(), []);
    const logic = (globalThis as unknown as { ArgosLogic?: { errorText(code: string | undefined, fallback: string): string } }).ArgosLogic;
    const errorText = props.errorText ?? logic?.errorText ?? ((_code: string | undefined, fallback: string) => fallback);
    if (!view) return state.phase === "confirmed" ? React.createElement("span", { role: "status", className: "t-meta text-muted-foreground" }, stateMessage(state, errorText)) : null;
    const send = props.send ?? (props.fetch ? createActionSender({ fetch: props.fetch, timeoutMs: props.timeoutMs ?? DEFAULT_TIMEOUT_MS }) : undefined);

    const run = (action: ButtonView["action"]): void => {
      if (state.phase === "sending" || !send) return;
      alive.current?.abort();
      const controller = new AbortController();
      alive.current = controller;
      setState((cur) => permissionReducer(cur, { type: "send", action }));
      void answerPermission(node, action, { send, ctx: ctx ?? {}, signal: controller.signal }).then((outcome) => {
        // resposta de um envio cancelado (desmontou, ou veio outro pedido) não mexe na tela
        if (controller.signal.aborted) return;
        setState((cur) => permissionReducer(cur, { type: "outcome", action, outcome }));
        props.onResult?.(action, outcome);
      });
    };
    return renderPermission({ h: React.createElement, ...(props.className ? { className: props.className } : {}), onApprove: () => run(APPROVE), onDeny: () => run(DENY) },
      view, state, stateMessage(state, errorText));
  }

  return { NodePermission, permissionView, permissionReducer, answerPermission, renderPermission, stateMessage, createActionSender, SEND_ERRORS, DEFAULT_TIMEOUT_MS };
}

type ArgosNodePermissionApi = ReturnType<typeof makeArgosNodePermission>;
(globalThis as unknown as { ArgosNodePermission: ArgosNodePermissionApi }).ArgosNodePermission = makeArgosNodePermission();
export type { ArgosNodePermissionApi, ActionOutcome, ActionSender, FetchLike, NodePermissionProps, PermissionState, PermissionView, SendErrorCode, SenderOptions, Timers };
