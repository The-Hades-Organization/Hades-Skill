// Grupo node-balloon: balão de mensagem junto do nó (kit/panel/ui/argos/node-balloon.tsx) — posição junto do nó e dentro
// da tela, modos que valem para o agente, rascunho por agente e referências `@` (src/lib/canvas-compose.ts), envio por
// `prompt` ou `text` e o ciclo de vida do componente. O .tsx é um script clássico de navegador: aqui ele roda sobre um React
// mínimo, um envio falso e um documento de mentira, sem DOM e sem rede.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as actions from "../../../src/lib/canvas-actions";
import type { ActionNode } from "../../../src/lib/canvas-actions";
import * as compose from "../../../src/lib/canvas-compose";
import { COMPOSE_ERRORS, COMPOSE_LIMITS, ComposeError } from "../../../src/lib/canvas-compose";

// Os tipos do .tsx não entram aqui (o tsconfig do projeto não tem jsx): este é o contorno do que o teste usa dele.
type Outcome = { ok: true; output: string } | { ok: false; code: string; message: string; status: number };
type Sender = (request: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<Outcome>;
interface Placement { x: number; y: number; side: string }
interface Rect { x: number; y: number; w: number; h: number }
interface ModeInfo { mode: string; label: string; available: boolean; reason?: string }
type Prepared = { ok: true; action: string; text: string; references: { id: string; kind: string }[] } | { ok: false; code: string; message: string };
interface BalloonApi {
  NodeBalloon: (props: Record<string, unknown>) => unknown;
  balloonModes(node: ActionNode, ctx?: object): ModeInfo[];
  prepareSend(node: ActionNode, mode: string, draft: string, doc: object, ctx?: object): Prepared;
  sendPrepared(node: ActionNode, prepared: Prepared, send: Sender, signal?: AbortSignal): Promise<Outcome>;
  composeErrorText(error: unknown): string;
  placeBalloon(anchor: Rect, view: { w: number; h: number }, size?: { w: number; h: number }, gap?: number): Placement;
  BALLOON_SIZE: { w: number; h: number };
  SEND_TIMEOUT_MS: number;
}
interface El { type: unknown; props: Record<string, unknown>; children: unknown[] }

const g = globalThis as unknown as Record<string, unknown>;
const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: props ?? {}, children });

/** React mínimo: estado e ref por posição, efeitos que rodam quando as dependências mudam e limpam ao desmontar. */
function mount<P>(component: (props: P) => unknown, initial: P) {
  let props = initial;
  const slots: unknown[] = [];
  const effects: { deps?: readonly unknown[]; cleanup?: void | (() => void) }[] = [];
  let tree: unknown = null;
  let dirty = false;
  let cursor = 0;
  let effectCursor = 0;
  const pending: (() => void)[] = [];
  g.React = {
    createElement,
    useState: (init: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      return [slots[i], (next: unknown) => {
        const value = typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[i]) : next;
        if (Object.is(value, slots[i])) return;
        slots[i] = value;
        dirty = true;
      }];
    },
    useRef: (init: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i];
    },
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const i = effectCursor++;
      const prev = effects[i];
      const same = prev?.deps && deps && prev.deps.length === deps.length && prev.deps.every((d, n) => Object.is(d, deps[n]));
      if (same) return;
      pending.push(() => {
        if (typeof prev?.cleanup === "function") prev.cleanup();
        effects[i] = { deps, cleanup: fn() };
      });
    },
  };
  const render = (): void => {
    cursor = 0;
    effectCursor = 0;
    tree = component(props);
    for (const run of pending.splice(0)) run();
  };
  const settle = (): void => {
    render();
    while (dirty) {
      dirty = false;
      render();
    }
  };
  settle();
  return {
    get tree(): unknown {
      return tree;
    },
    settle,
    /** Deixa as promessas terminarem e redesenha. */
    async flush(): Promise<void> {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      settle();
    },
    rerender(next: P): void {
      props = next;
      settle();
    },
    unmount(): void {
      for (const e of effects) if (typeof e?.cleanup === "function") e.cleanup();
    },
  };
}

const flat = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(flat);
  if (typeof node !== "object" || node === null) return [];
  const el = node as El;
  return [el, ...el.children.flatMap(flat)];
};
const text = (el: El): string => el.children.filter((c): c is string => typeof c === "string").join("");
const button = (tree: unknown, label: string): El => flat(tree).find((e) => e.type === "button" && text(e) === label) as El;
const area = (tree: unknown): El => flat(tree).find((e) => e.type === "textarea") as El;
const line = (tree: unknown): El => flat(tree).find((e) => e.type === "span" && (e.props.role === "status" || e.props.role === "alert")) as El;
const click = (el: El): void => (el.props.onClick as () => void)();
const press = (tree: unknown, k: string, ctrl = false): { prevented: boolean } => {
  const event = { key: k, ctrlKey: ctrl, prevented: false, preventDefault() { this.prevented = true; } };
  ((tree as El).props.onKeyDown as (e: typeof event) => void)(event);
  return event;
};
const typeInto = (tree: unknown, value: string): void => (area(tree).props.onInput as (e: { target: { value: string } }) => void)({ target: { value } });

let Balloon: BalloonApi;
beforeAll(async () => {
  g.CanvasModel = { actions, compose };
  // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
  await import("../../../kit/panel/ui/argos/node-balloon.tsx");
  Balloon = g.ArgosNodeBalloon as BalloonApi;
});
afterAll(() => {
  delete g.CanvasModel;
  delete g.ArgosNodeBalloon;
  delete g.React;
  delete g.document;
});

const agent = (over: Partial<ActionNode> = {}): ActionNode => ({
  id: "agent:p:a1", type: "agent", label: "a1", state: "working", registryState: "active", herdrState: "working", pendingPermission: null, ...over,
});
const doc = { nodes: [
  { id: "n1", type: "note", x: 0, y: 0, w: 1, h: 1, selected: false, data: { text: "decisão do dono" }, live: undefined },
  { id: "agent:p:a1", type: "agent", x: 0, y: 0, w: 1, h: 1, selected: false, data: { label: "a1" }, live: undefined },
] };
const VIEW = { w: 1200, h: 800 };
const ANCHOR: Rect = { x: 100, y: 300, w: 200, h: 100 };

/** Envio controlado pelo teste: guarda o corpo e as opções, e só termina quando o teste manda. */
function controlledSend() {
  const calls: { body: unknown; options: { signal?: AbortSignal; timeoutMs?: number } | undefined }[] = [];
  let finish: (o: Outcome) => void = () => undefined;
  const send: Sender = (body, options) => {
    calls.push({ body, options });
    return new Promise<Outcome>((resolve) => (finish = resolve));
  };
  return { send, calls, finish: (o: Outcome): void => finish(o) };
}

/** Página de mentira: guarda o mapa de rascunhos e redesenha o balão a cada mudança dele. */
function page(initial: Record<string, string>, extra: Record<string, unknown> = {}) {
  const c = controlledSend();
  const state = { drafts: initial, closed: 0, sent: [] as string[], writes: [] as Record<string, string>[] };
  const props = (): Record<string, unknown> => ({
    node: agent(), drafts: state.drafts, doc, anchor: ANCHOR, view: VIEW, send: c.send,
    onDrafts: (next: Record<string, string>) => { state.drafts = next; state.writes.push(next); m.rerender(props()); },
    onClose: () => { state.closed++; }, onSent: (mode: string) => state.sent.push(mode), ...extra,
  });
  const m = mount(Balloon.NodeBalloon, props());
  return { m, c, state };
}

describe("node-balloon: posição junto do nó", () => {
  test("dado espaço à direita, então o balão fica à direita do nó, centrado na altura dele", () => {
    const p = Balloon.placeBalloon(ANCHOR, VIEW);
    expect(p.side).toBe("right");
    expect(p.x).toBe(ANCHOR.x + ANCHOR.w + 12);
    expect(p.y).toBe(Math.round(ANCHOR.y + ANCHOR.h / 2 - Balloon.BALLOON_SIZE.h / 2));
  });

  test("dado nó colado na borda direita, então o balão passa para a esquerda", () => {
    const p = Balloon.placeBalloon({ x: 900, y: 300, w: 200, h: 100 }, VIEW);
    expect(p.side).toBe("left");
    expect(p.x).toBe(900 - 12 - Balloon.BALLOON_SIZE.w);
  });

  test("dado nó largo que ocupa a tela, então o balão vai abaixo e, sem espaço abaixo, acima", () => {
    expect(Balloon.placeBalloon({ x: 10, y: 100, w: 1180, h: 100 }, VIEW).side).toBe("below");
    expect(Balloon.placeBalloon({ x: 10, y: 600, w: 1180, h: 190 }, VIEW).side).toBe("above");
  });

  test("dado qualquer nó, inclusive fora da tela, então a posição nunca sai da tela", () => {
    const { w, h } = Balloon.BALLOON_SIZE;
    for (const x of [-500, 0, 400, 1100, 3000]) {
      for (const y of [-500, 0, 350, 700, 3000]) {
        const p = Balloon.placeBalloon({ x, y, w: 200, h: 100 }, VIEW);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x + w).toBeLessThanOrEqual(VIEW.w);
        expect(p.y + h).toBeLessThanOrEqual(VIEW.h);
      }
    }
  });

  test("dado tela menor que o balão, então ele cola no canto em vez de ficar com posição negativa", () => {
    const p = Balloon.placeBalloon(ANCHOR, { w: 100, h: 100 });
    expect([p.x, p.y]).toEqual([0, 0]);
  });
});

describe("node-balloon: que modos valem", () => {
  const by = (modes: ModeInfo[], mode: string): ModeInfo => modes.find((m) => m.mode === mode) as ModeInfo;

  test("dado agente aberto, então prompt e texto valem", () => {
    expect(Balloon.balloonModes(agent()).map((m) => [m.mode, m.available])).toEqual([["prompt", true], ["text", true]]);
  });

  test("dado agente encerrado, então nenhum modo vale e o motivo vem da tabela de ações", () => {
    const modes = Balloon.balloonModes(agent({ state: "done" }));
    expect(by(modes, "prompt")).toMatchObject({ available: false, reason: "o agente já foi encerrado" });
  });

  test("dado herdr que não vê o agente, então o prompt vale e o texto cru não", () => {
    const modes = Balloon.balloonModes(agent({ herdrState: "fora" }));
    expect([by(modes, "prompt").available, by(modes, "text").available, by(modes, "text").reason]).toEqual([true, false, "o herdr não vê este agente"]);
  });

  test("dado nó que não é agente, então nada vale", () => {
    expect(Balloon.balloonModes(agent({ type: "pr" })).every((m) => !m.available)).toBe(true);
  });
});

describe("node-balloon: preparar o envio", () => {
  test("dado rascunho com referência a uma nota, então a nota entra no texto e a referência é listada", () => {
    const p = Balloon.prepareSend(agent(), "prompt", "siga @n1", doc);
    expect(p).toEqual({ ok: true, action: "prompt", text: "siga [nota n1: decisão do dono]", references: [{ id: "n1", kind: "note" }] });
  });

  test("dado rascunho vazio ou só de espaço, então compose_empty_message e nada é preparado", () => {
    for (const draft of ["", "   \n "]) expect(Balloon.prepareSend(agent(), "prompt", draft, doc)).toMatchObject({ ok: false, code: COMPOSE_ERRORS.emptyMessage });
  });

  test("dado referência que não existe, então o erro cita o id e o rascunho fica como está", () => {
    const p = Balloon.prepareSend(agent(), "prompt", "veja @fantasma", doc);
    expect(p).toMatchObject({ ok: false, code: COMPOSE_ERRORS.unknownReference });
    expect((p as { message: string }).message).toContain("fantasma");
  });

  test("dado texto acima do teto, então compose_too_long", () => {
    expect(Balloon.prepareSend(agent(), "prompt", "x".repeat(COMPOSE_LIMITS.draftChars + 1), doc)).toMatchObject({ ok: false, code: COMPOSE_ERRORS.tooLong });
  });

  test("dado modo que não vale agora, então balloon_mode_unavailable e nada é composto", () => {
    expect(Balloon.prepareSend(agent({ state: "done" }), "prompt", "oi", doc)).toMatchObject({ ok: false, code: "balloon_mode_unavailable" });
  });

  test("dado cada código do compose, então há um texto próprio (e o desconhecido cai na mensagem do erro)", () => {
    for (const code of Object.values(COMPOSE_ERRORS)) expect(Balloon.composeErrorText(new ComposeError(code, "x", ["a"])).length).toBeGreaterThan(5);
    expect(Balloon.composeErrorText(new Error("outra coisa"))).toBe("outra coisa");
  });

  test("dado prompt e texto, então o corpo do POST usa a ação certa, leva o texto e o teto de espera do balão", async () => {
    const c = controlledSend();
    const prompt = Balloon.prepareSend(agent(), "prompt", "oi", doc);
    void Balloon.sendPrepared(agent(), prompt, c.send);
    const typed = Balloon.prepareSend(agent(), "text", "ls", doc);
    void Balloon.sendPrepared(agent(), typed, c.send);
    expect(c.calls.map((x) => x.body)).toEqual([
      { node: "agent:p:a1", action: "prompt", args: { text: "oi" } },
      { node: "agent:p:a1", action: "text", args: { text: "ls" } },
    ]);
    expect(c.calls[0]?.options?.timeoutMs).toBe(Balloon.SEND_TIMEOUT_MS);
  });
});

describe("node-balloon: componente", () => {
  test("dado rascunhos de dois agentes, então cada balão mostra o do seu agente", () => {
    const a = mount(Balloon.NodeBalloon, { node: agent(), drafts: { a1: "para o a1", a2: "para o a2" }, doc, anchor: ANCHOR, view: VIEW, send: controlledSend().send, onDrafts() {}, onClose() {} });
    expect(area(a.tree).props.value).toBe("para o a1");
    a.rerender({ node: agent({ id: "agent:p:a2", label: "a2" }), drafts: { a1: "para o a1", a2: "para o a2" }, doc, anchor: ANCHOR, view: VIEW, send: controlledSend().send, onDrafts() {}, onClose() {} });
    expect(area(a.tree).props.value).toBe("para o a2");
  });

  test("dado digitação, então o mapa novo de rascunhos sai por onDrafts e apagar o texto apaga o rascunho", () => {
    const { m, state } = page({ outro: "guardado" });
    typeInto(m.tree, "olá");
    expect(state.drafts).toEqual({ outro: "guardado", a1: "olá" });
    typeInto(m.tree, "");
    expect(state.drafts).toEqual({ outro: "guardado" });
  });

  test("dado campo de texto, então o teto de caracteres é o do compose e a mensagem tem nome acessível", () => {
    const { m } = page({});
    expect(area(m.tree).props.maxLength).toBe(COMPOSE_LIMITS.draftChars);
    expect(area(m.tree).props["aria-label"]).toBe("Mensagem para a1");
    expect((m.tree as El).props.role).toBe("dialog");
  });

  test("dado rascunho vazio, então enviar fica desligado; com texto, liga", () => {
    const { m } = page({});
    expect(button(m.tree, "Enviar prompt").props.disabled).toBe(true);
    typeInto(m.tree, "oi");
    expect(button(m.tree, "Enviar prompt").props.disabled).toBe(false);
  });

  test("dado Ctrl+Enter, então envia o prompt com as referências resolvidas e o botão fica ocupado; um segundo envio não sai", () => {
    const { m, c } = page({ a1: "siga @n1" });
    expect(press(m.tree, "Enter", true).prevented).toBe(true);
    m.settle();
    expect(c.calls.map((x) => x.body)).toEqual([{ node: "agent:p:a1", action: "prompt", args: { text: "siga [nota n1: decisão do dono]" } }]);
    expect(button(m.tree, "Enviando…").props["aria-busy"]).toBe(true);
    press(m.tree, "Enter", true);
    expect(c.calls.length).toBe(1);
  });

  test("dado aceite, então o rascunho do agente é apagado, onSent avisa o modo e os outros rascunhos ficam", async () => {
    const { m, c, state } = page({ a1: "oi", a2: "outro" });
    click(button(m.tree, "Enviar prompt"));
    m.settle();
    c.finish({ ok: true, output: "" });
    await m.flush();
    expect(state.drafts).toEqual({ a2: "outro" });
    expect(state.sent).toEqual(["prompt"]);
    expect(area(m.tree).props.value).toBe("");
  });

  test("dado recusa do servidor, então o rascunho fica, o erro aparece como alerta e dá para tentar de novo", async () => {
    const { m, c, state } = page({ a1: "oi" });
    click(button(m.tree, "Enviar prompt"));
    m.settle();
    c.finish({ ok: false, code: "action_failed", message: "o agente recusou", status: 422 });
    await m.flush();
    expect(state.drafts).toEqual({ a1: "oi" });
    expect([line(m.tree).props.role, text(line(m.tree))]).toEqual(["alert", "o agente recusou"]);
    expect(button(m.tree, "Enviar prompt").props.disabled).toBe(false);
    expect(state.sent).toEqual([]);
  });

  test("dado texto no modo texto, então a ação do POST é text", async () => {
    const { m, c } = page({ a1: "ls -la" });
    click(button(m.tree, "Texto"));
    m.settle();
    expect(button(m.tree, "Digitar no terminal")).toBeDefined();
    click(button(m.tree, "Digitar no terminal"));
    expect((c.calls[0]?.body as { action: string }).action).toBe("text");
  });

  test("dado referência inexistente ao enviar, então nada vai ao servidor e o erro cita o id", () => {
    const { m, c } = page({ a1: "veja @fantasma" });
    click(button(m.tree, "Enviar prompt"));
    m.settle();
    expect(c.calls.length).toBe(0);
    expect(text(line(m.tree))).toContain("fantasma");
  });

  test("dado agente encerrado, então o campo e o envio ficam desligados e o motivo aparece", () => {
    const { m } = page({ a1: "oi" }, { node: agent({ state: "done" }) });
    expect(area(m.tree).props.disabled).toBe(true);
    expect(button(m.tree, "Enviar prompt").props.disabled).toBe(true);
    expect(flat(m.tree).some((e) => e.type === "span" && text(e) === "o agente já foi encerrado")).toBe(true);
  });

  test("dado teto de rascunhos guardados, então digitar num agente novo mostra o erro e não grava", () => {
    const full: Record<string, string> = {};
    for (let i = 0; i < COMPOSE_LIMITS.drafts; i++) full[`ag${i}`] = "x";
    const { m, state } = page(full);
    typeInto(m.tree, "mais um");
    m.settle();
    expect(state.writes).toEqual([]);
    expect(line(m.tree).props.role).toBe("alert");
    expect(text(line(m.tree))).toContain("Rascunhos demais");
  });

  test("dado Esc, então fecha e a tecla é consumida; sem Esc e sem Ctrl, nada acontece", () => {
    const { m, state } = page({});
    expect(press(m.tree, "a").prevented).toBe(false);
    expect(press(m.tree, "Escape").prevented).toBe(true);
    expect(state.closed).toBe(1);
  });

  test("dado desmontagem com envio em voo, então o sinal é abortado e a resposta tardia não apaga o rascunho", async () => {
    const { m, c, state } = page({ a1: "oi" });
    click(button(m.tree, "Enviar prompt"));
    m.settle();
    m.unmount();
    expect(c.calls[0]?.options?.signal?.aborted).toBe(true);
    c.finish({ ok: true, output: "" });
    await m.flush();
    expect(state.drafts).toEqual({ a1: "oi" });
    expect(state.sent).toEqual([]);
  });

  test("dado outro agente durante o envio, então o envio é cancelado e a tela volta ao início", () => {
    const { m, c } = page({ a1: "oi" });
    click(button(m.tree, "Enviar prompt"));
    m.settle();
    m.rerender({ node: agent({ id: "agent:p:a2", label: "a2" }), drafts: {}, doc, anchor: ANCHOR, view: VIEW, send: c.send, onDrafts() {}, onClose() {} });
    expect(c.calls[0]?.options?.signal?.aborted).toBe(true);
    expect(button(m.tree, "Enviar prompt").props.disabled).toBe(true);
    expect(text(line(m.tree))).toBe("");
  });

  test("dado o foco antes de abrir, então ele volta a quem abriu quando o balão desmonta", () => {
    const opener = { focused: 0, isConnected: true, focus() { this.focused++; } };
    g.document = { activeElement: opener };
    const { m } = page({});
    m.unmount();
    expect(opener.focused).toBe(1);
  });

  test("dado quem abriu que já saiu da página, então o foco não é devolvido a ele", () => {
    const opener = { focused: 0, isConnected: false, focus() { this.focused++; } };
    g.document = { activeElement: opener };
    const { m } = page({});
    m.unmount();
    expect(opener.focused).toBe(0);
  });
});
