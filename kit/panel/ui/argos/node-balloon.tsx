/* Balão junto do nó do canvas do Argos: escreve um prompt ou um texto para o agente sem sair do
 * canvas. Rascunho por agente (src/lib/canvas-compose.ts: o mapa de rascunhos é da página, o balão só o lê e devolve o novo),
 * referência `@nota` resolvida no envio, POST /api/argos/action (`prompt` ou `text`) pelo envio injetado. Script clássico:
 * registra window.ArgosNodeBalloon. Depende de React, de window.CanvasModel (actions, compose) e de window.ArgosNodePermission
 * (o envio do POST, `createActionSender`). Ctrl+Enter envia, Esc fecha e devolve o foco a quem abriu o balão. */
import type { ActionContext, ActionNode } from "../../../../src/lib/canvas-actions.ts";
import type * as ActionsModule from "../../../../src/lib/canvas-actions.ts";
import type * as ComposeModule from "../../../../src/lib/canvas-compose.ts";
import type { Rect, Viewport } from "../../../../src/lib/canvas-camera.ts";
import type { ActionOutcome, ActionSender, ArgosNodePermissionApi, FetchLike } from "./node-permission.tsx";

type BalloonMode = "prompt" | "text";
type Side = "right" | "left" | "below" | "above";

interface BalloonPlacement {
  x: number;
  y: number;
  side: Side;
}

interface NodeBalloonProps {
  node: ActionNode;
  ctx?: ActionContext;
  /** Rascunhos de todos os agentes (`Drafts` do canvas-compose); a página guarda e passa de volta. */
  drafts: ComposeModule.Drafts;
  onDrafts(next: ComposeModule.Drafts): void;
  /** O documento do canvas: dele saem as notas e nós das referências `@`. */
  doc: Parameters<typeof ComposeModule.composeMessage>[1];
  /** Retângulo do nó na tela (pixels do canvas), e o tamanho da tela: o balão fica ao lado do nó, dentro da tela. */
  anchor: Rect;
  view: Viewport;
  send?: ActionSender;
  fetch?: FetchLike;
  timeoutMs?: number;
  onClose(): void;
  /** Depois que o servidor aceitou: a página atualiza o grafo e pode avisar. */
  onSent?(mode: BalloonMode, outcome: ActionOutcome): void;
}

const BALLOON_SIZE: Viewport = { w: 320, h: 220 };
const GAP_PX = 12;
const EDGE_PX = 8;
/** O servidor espera o turno do agente em `prompt` (até 120 s); o balão espera um pouco mais que ele. */
const SEND_TIMEOUT_MS = 130_000;
const PROMPT: BalloonMode = "prompt";
const TEXT: BalloonMode = "text";
/** `text` só vale onde o herdr vê o agente; a tabela de ações usa a mesma trava em `free_prompt`. */
const ACTION_FOR_AVAILABILITY: Readonly<Record<BalloonMode, "prompt" | "free_prompt">> = { prompt: "prompt", text: "free_prompt" };

const MODE_LABELS: Readonly<Record<BalloonMode, { tab: string; send: string; sent: string; placeholder: string }>> = {
  prompt: { tab: "Prompt", send: "Enviar prompt", sent: "Prompt enviado", placeholder: "Prompt para o agente (Ctrl+Enter envia, @ cita uma nota)" },
  text: { tab: "Texto", send: "Digitar no terminal", sent: "Texto digitado", placeholder: "Texto para o terminal, sem Enter (Ctrl+Enter envia)" },
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Onde o balão fica: à direita do nó se couber, senão à esquerda, abaixo ou acima; sem espaço em nenhum lado, ele se
 * encosta na borda dentro da tela. A posição devolvida é sempre inteira dentro da tela (o balão maior que a tela cola em 0).
 */
function placeBalloon(anchor: Rect, view: Viewport, size: Viewport = BALLOON_SIZE, gap: number = GAP_PX): BalloonPlacement {
  const fitsX = (x: number): boolean => x >= EDGE_PX && x + size.w <= view.w - EDGE_PX;
  const fitsY = (y: number): boolean => y >= EDGE_PX && y + size.h <= view.h - EDGE_PX;
  const centeredY = anchor.y + anchor.h / 2 - size.h / 2;
  const centeredX = anchor.x + anchor.w / 2 - size.w / 2;
  const tries: readonly (BalloonPlacement & { fits: boolean })[] = [
    { side: "right", x: anchor.x + anchor.w + gap, y: clamp(centeredY, EDGE_PX, view.h - size.h - EDGE_PX), fits: fitsX(anchor.x + anchor.w + gap) },
    { side: "left", x: anchor.x - gap - size.w, y: clamp(centeredY, EDGE_PX, view.h - size.h - EDGE_PX), fits: fitsX(anchor.x - gap - size.w) },
    { side: "below", x: clamp(centeredX, EDGE_PX, view.w - size.w - EDGE_PX), y: anchor.y + anchor.h + gap, fits: fitsY(anchor.y + anchor.h + gap) },
    { side: "above", x: clamp(centeredX, EDGE_PX, view.w - size.w - EDGE_PX), y: anchor.y - gap - size.h, fits: fitsY(anchor.y - gap - size.h) },
  ];
  const chosen = tries.find((t) => t.fits) ?? tries[0];
  if (!chosen) return { x: EDGE_PX, y: EDGE_PX, side: "right" };
  return { side: chosen.side, x: Math.round(clamp(chosen.x, 0, view.w - size.w)), y: Math.round(clamp(chosen.y, 0, view.h - size.h)) };
}

function makeArgosNodeBalloon() {
  const g = globalThis as unknown as {
    CanvasModel?: { actions: typeof ActionsModule; compose: typeof ComposeModule };
    ArgosNodePermission?: ArgosNodePermissionApi;
    ArgosLogic?: { errorText(code: string | undefined, fallback: string): string };
  };
  if (!g.CanvasModel?.actions || !g.CanvasModel.compose) throw new Error("ArgosNodeBalloon: carregue /ui/lib/canvas-model.js (com `actions` e `compose`) antes de node-balloon.js");
  const A = g.CanvasModel.actions;
  const C = g.CanvasModel.compose;
  const { COMPOSE_ERRORS, COMPOSE_LIMITS } = C;

  // Um texto por código do compose: o código é o contrato, a mensagem do módulo não se traduz aqui.
  const COMPOSE_TEXT: Readonly<Record<ComposeModule.ComposeErrorCode, string>> = {
    [COMPOSE_ERRORS.invalidAgent]: "O nome deste agente não serve para guardar rascunho.",
    [COMPOSE_ERRORS.invalidText]: "O texto não é válido.",
    [COMPOSE_ERRORS.tooLong]: "Mensagem longa demais.",
    [COMPOSE_ERRORS.tooManyDrafts]: "Rascunhos demais guardados: envie ou apague algum.",
    [COMPOSE_ERRORS.tooManyReferences]: "Referências @ demais na mensagem.",
    [COMPOSE_ERRORS.unknownReference]: "Referência @ a um nó que não existe",
    [COMPOSE_ERRORS.referenceTooLong]: "A nota citada é longa demais para ir na mensagem",
    [COMPOSE_ERRORS.emptyMessage]: "Escreva a mensagem antes de enviar.",
  };

  /** Texto de um erro do compose, com os ids que o causaram quando eles ajudam a corrigir. */
  function composeErrorText(error: unknown): string {
    if (!(error instanceof C.ComposeError)) return error instanceof Error ? error.message : "Erro ao preparar a mensagem.";
    const base = COMPOSE_TEXT[error.code];
    const needsIds = error.code === COMPOSE_ERRORS.unknownReference || error.code === COMPOSE_ERRORS.referenceTooLong;
    return needsIds && error.subjects.length > 0 ? `${base}: ${error.subjects.join(", ")}.` : base;
  }

  /** Quais modos valem agora para o nó (a mesma conta do menu), com o motivo do que não vale. */
  function balloonModes(node: ActionNode, ctx: ActionContext = {}): { mode: BalloonMode; label: string; available: boolean; reason?: string }[] {
    const items = A.actionsFor(node, ctx);
    return ([PROMPT, TEXT] as const).map((mode) => {
      const item = items.find((i) => i.key === ACTION_FOR_AVAILABILITY[mode]);
      const available = item?.available === true;
      const reason = item?.reason?.message ?? (item ? undefined : "só agentes recebem mensagem");
      return reason === undefined ? { mode, label: MODE_LABELS[mode].tab, available } : { mode, label: MODE_LABELS[mode].tab, available, reason };
    });
  }

  type PreparedSend =
    | { ok: true; action: "prompt" | "text"; text: string; references: ComposeModule.ResolvedReference[] }
    | { ok: false; code: string; message: string };

  /** Resolve as referências `@` do rascunho e confere o modo; nada sai se algo falhar (o rascunho fica como está). */
  function prepareSend(node: ActionNode, mode: BalloonMode, draft: string, doc: NodeBalloonProps["doc"], ctx: ActionContext = {}): PreparedSend {
    const modeInfo = balloonModes(node, ctx).find((m) => m.mode === mode);
    if (!modeInfo?.available) return { ok: false, code: "balloon_mode_unavailable", message: modeInfo?.reason ?? "Este modo não vale agora." };
    try {
      const composed = C.composeMessage(draft, doc);
      return { ok: true, action: mode, text: composed.text, references: composed.references };
    } catch (error) {
      return { ok: false, code: error instanceof C.ComposeError ? error.code : "compose_unexpected", message: composeErrorText(error) };
    }
  }

  /** Envia o que `prepareSend` aprovou. Devolve o desfecho do servidor; o chamador decide o que fazer com o rascunho. */
  async function sendPrepared(node: ActionNode, prepared: Extract<PreparedSend, { ok: true }>, send: ActionSender, signal?: AbortSignal): Promise<ActionOutcome> {
    return send(A.actionRequest(node, prepared.action, { text: prepared.text }), signal ? { signal, timeoutMs: SEND_TIMEOUT_MS } : { timeoutMs: SEND_TIMEOUT_MS });
  }

  type BalloonState = { phase: "idle" } | { phase: "sending" } | { phase: "error"; code: string; message: string };

  const BOX = "elev-float absolute z-20 flex flex-col gap-2 bg-background p-2 t-body";
  const FIELD = "min-h-20 w-full resize-y border border-border-strong bg-background px-2 py-1.5 text-base outline-none focus-visible:outline-2 focus-visible:outline-ring md:text-sm";
  const BTN = "inline-flex min-h-8 cursor-pointer items-center justify-center border border-border-strong px-3 t-label outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40 max-md:min-h-11";

  interface BalloonUi {
    h: ReactApi["createElement"];
    placement: BalloonPlacement;
    size: Viewport;
    title: string;
    mode: BalloonMode;
    modes: ReturnType<typeof balloonModes>;
    draft: string;
    state: BalloonState;
    errorText(code: string | undefined, fallback: string): string;
    onMode(mode: BalloonMode): void;
    onInput(text: string): void;
    onSend(): void;
    onClose(): void;
    onKeyDown(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; preventDefault(): void }): void;
  }

  /** Árvore de elementos do balão: pura, sem hooks, para o teste ler sem DOM. */
  function renderBalloon(ui: BalloonUi): ReactNode {
    const { h, state } = ui;
    const sending = state.phase === "sending";
    const current = ui.modes.find((m) => m.mode === ui.mode);
    const blocked = current?.available !== true;
    const labels = MODE_LABELS[ui.mode];
    return h("div", { role: "dialog", "aria-label": ui.title, "aria-modal": "false", className: BOX, style: { left: ui.placement.x, top: ui.placement.y, width: ui.size.w }, onKeyDown: ui.onKeyDown },
      h("div", { role: "radiogroup", "aria-label": "Como enviar", className: "flex gap-1" },
        ...ui.modes.map((m) => h("button", { key: m.mode, type: "button", role: "radio", "aria-checked": m.mode === ui.mode, disabled: !m.available || sending, title: m.reason, className: BTN, onClick: () => ui.onMode(m.mode) }, m.label))),
      h("textarea", { value: ui.draft, rows: 4, maxLength: COMPOSE_LIMITS.draftChars, "aria-label": `Mensagem para ${ui.title}`, placeholder: labels.placeholder, disabled: sending || blocked, className: FIELD, onInput: (e: { target: { value: string } }) => ui.onInput(e.target.value) }),
      blocked && current?.reason ? h("span", { className: "t-meta text-muted-foreground" }, current.reason) : null,
      h("div", { className: "flex items-center gap-2" },
        h("button", { type: "button", className: BTN, disabled: sending || blocked || ui.draft.trim() === "", "aria-busy": sending ? true : undefined, onClick: ui.onSend }, sending ? "Enviando…" : labels.send),
        h("button", { type: "button", className: BTN, onClick: ui.onClose }, "Fechar")),
      h("span", { role: state.phase === "error" ? "alert" : "status", className: state.phase === "error" ? "t-meta text-bad" : "sr-only" },
        state.phase === "error" ? ui.errorText(state.code, state.message) : ""));
  }

  function NodeBalloon(props: NodeBalloonProps): ReactNode {
    const { node, drafts, onDrafts } = props;
    const [mode, setMode] = React.useState<BalloonMode>(PROMPT);
    const [state, setState] = React.useState<BalloonState>({ phase: "idle" });
    const live = React.useRef({ drafts, onDrafts, agent: node.label });
    const inflight = React.useRef<AbortController | null>(null);
    live.current = { drafts, onDrafts, agent: node.label };
    const ctx = props.ctx ?? {};
    const draft = C.getDraft(drafts, node.label);

    // quem abriu o balão recebe o foco de volta quando ele fecha; o envio em voo morre junto com o balão
    React.useEffect(() => {
      const opener = typeof document === "undefined" ? null : (document.activeElement as { focus?: () => void; isConnected?: boolean } | null);
      return () => {
        inflight.current?.abort();
        if (opener?.isConnected && typeof opener.focus === "function") opener.focus();
      };
    }, []);
    // outro agente: erro e envio do anterior não valem
    React.useEffect(() => {
      inflight.current?.abort();
      setState({ phase: "idle" });
    }, [node.id]);

    const send = props.send ?? (props.fetch && g.ArgosNodePermission ? g.ArgosNodePermission.createActionSender({ fetch: props.fetch, timeoutMs: props.timeoutMs ?? SEND_TIMEOUT_MS }) : undefined);
    const errorText = (code: string | undefined, fallback: string): string => (code === undefined ? fallback : (g.ArgosLogic?.errorText(code, fallback) ?? fallback));

    const onInput = (text: string): void => {
      try {
        live.current.onDrafts(C.setDraft(live.current.drafts, live.current.agent, text));
        if (state.phase === "error") setState({ phase: "idle" });
      } catch (error) {
        setState({ phase: "error", code: error instanceof C.ComposeError ? error.code : "compose_unexpected", message: composeErrorText(error) });
      }
    };
    const onSend = (): void => {
      if (state.phase === "sending" || !send) return;
      const prepared = prepareSend(node, mode, draft, props.doc, ctx);
      if (!prepared.ok) {
        setState({ phase: "error", code: prepared.code, message: prepared.message });
        return;
      }
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      const agent = node.label;
      setState({ phase: "sending" });
      void sendPrepared(node, prepared, send, controller.signal).then((outcome) => {
        if (controller.signal.aborted) return;
        if (!outcome.ok) {
          setState({ phase: "error", code: outcome.code, message: outcome.message });
          return;
        }
        // só sai o rascunho que foi enviado: se outra superfície o trocou durante o envio, o novo texto continua
        const latest = live.current;
        if (C.getDraft(latest.drafts, agent) === draft) latest.onDrafts(C.clearDraft(latest.drafts, agent));
        setState({ phase: "idle" });
        props.onSent?.(mode, outcome);
      });
    };
    const onKeyDown = (event: { key: string; ctrlKey?: boolean; metaKey?: boolean; preventDefault(): void }): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onSend();
      }
    };

    return renderBalloon({
      h: React.createElement, placement: placeBalloon(props.anchor, props.view), size: BALLOON_SIZE, title: node.label, mode, modes: balloonModes(node, ctx), draft, state, errorText,
      onMode: setMode, onInput, onSend, onClose: props.onClose, onKeyDown,
    });
  }

  return { NodeBalloon, balloonModes, prepareSend, sendPrepared, renderBalloon, composeErrorText, placeBalloon, BALLOON_SIZE, SEND_TIMEOUT_MS };
}

type ArgosNodeBalloonApi = ReturnType<typeof makeArgosNodeBalloon>;
(globalThis as unknown as { ArgosNodeBalloon: ArgosNodeBalloonApi }).ArgosNodeBalloon = makeArgosNodeBalloon();
export type { ArgosNodeBalloonApi, BalloonMode, BalloonPlacement, NodeBalloonProps };
