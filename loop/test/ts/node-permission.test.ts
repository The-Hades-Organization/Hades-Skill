// Grupo node-permission: permissão pendente no nó do canvas (kit/panel/ui/argos/node-permission.tsx) — o que a tela mostra
// de um pedido, o envio do POST /api/argos/action (timeout, cancelamento, recusa do servidor, token velho), a máquina de
// estados (envio, erro, confirmação) e o ciclo de vida do componente. O .tsx é um script clássico de navegador: aqui ele roda
// sobre um React mínimo e um `fetch` falso, sem DOM e sem rede.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as actions from "../../../src/lib/canvas-actions";
import type { ActionNode } from "../../../src/lib/canvas-actions";

// Os tipos do .tsx não entram aqui (o tsconfig do projeto não tem jsx): este é o contorno do que o teste usa dele.
type Outcome = { ok: true; output: string } | { ok: false; code: string; message: string; status: number };
interface Res { ok: boolean; status: number; json(): Promise<unknown> }
interface Init { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
type Fetch = (url: string, init: Init) => Promise<Res>;
type Sender = (request: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<Outcome>;
interface Timers { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
type State = { phase: "idle" } | { phase: "sending" | "confirmed"; action: string } | { phase: "error"; action: string; code: string; message: string };
interface View { tool: string | null; since: string; approve: { available: boolean; label: string }; deny: { available: boolean }; blockedReason: string | undefined }
interface PermissionApi {
  NodePermission: (props: Record<string, unknown>) => unknown;
  permissionView(node: ActionNode, ctx?: object): View | null;
  permissionReducer(state: State, event: unknown): State;
  answerPermission(node: ActionNode, action: string, deps: { send: Sender; ctx?: object; signal?: AbortSignal }): Promise<Outcome>;
  stateMessage(state: State, errorText: (code: string | undefined, fallback: string) => string): string;
  createActionSender(options: { fetch: Fetch; timeoutMs?: number; timers?: Timers; getToken?: () => string | undefined; onToken?: (t: string) => void }): Sender;
  SEND_ERRORS: Record<string, string>;
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
const statusLine = (tree: unknown): El => flat(tree).find((e) => e.type === "span" && (e.props.role === "status" || e.props.role === "alert")) as El;

let Perm: PermissionApi;
beforeAll(async () => {
  g.CanvasModel = { actions };
  // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
  await import("../../../kit/panel/ui/argos/node-permission.tsx");
  Perm = g.ArgosNodePermission as PermissionApi;
});
afterAll(() => {
  delete g.CanvasModel;
  delete g.ArgosNodePermission;
  delete g.React;
});

const TS = "2026-11-02T10:00:00.000Z";
const agent = (over: Partial<ActionNode> = {}): ActionNode => ({
  id: "agent:p:a1", type: "agent", label: "a1", state: "working", registryState: "active", herdrState: "blocked", pendingPermission: { ts: TS, tool: "Bash" }, ...over,
});

/** `fetch` falso: responde com a fila de respostas e guarda cada chamada. */
function fakeFetch(...answers: (Res | Error | "hang")[]) {
  const calls: { url: string; init: Init }[] = [];
  const fn: Fetch = (url, init) => {
    calls.push({ url, init });
    const answer = answers.shift();
    if (answer === "hang" || answer === undefined) {
      return new Promise<Res>((_, reject) => {
        // como o fetch de verdade: sinal já abortado rejeita na hora
        if (init.signal.aborted) reject(new Error("abortado"));
        init.signal.addEventListener("abort", () => reject(new Error("abortado")), { once: true });
      });
    }
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { fn, calls };
}
const reply = (status: number, body: unknown): Res => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const OK = reply(200, { v: 1, ok: true, node: "agent:p:a1", action: "approve_permission", output: "feito" });

/** Relógio manual: o teste decide quando o tempo passa. */
function manualTimers() {
  const live = new Map<number, () => void>();
  let seq = 0;
  const timers: Timers = { set: (run) => (live.set(++seq, run), seq), clear: (h) => void live.delete(h as number) };
  return { timers, live, fire: (): void => [...live.values()].forEach((run) => run()) };
}

describe("node-permission: o que a tela mostra", () => {
  test("dado nó sem pedido pendente, então nada é desenhado", () => {
    expect(Perm.permissionView(agent({ pendingPermission: null }))).toBeNull();
  });

  test("dado pedido de ferramenta simples com o herdr bloqueado, então aprovar e negar valem", () => {
    const view = Perm.permissionView(agent()) as View;
    expect([view.tool, view.since, view.approve.available, view.deny.available, view.blockedReason]).toEqual(["Bash", TS, true, true, undefined]);
  });

  test("dado diálogo que só se responde no terminal, então nenhum botão vale e o motivo aparece", () => {
    const view = Perm.permissionView(agent({ pendingPermission: { ts: TS, tool: "ExitPlanMode" } })) as View;
    expect([view.approve.available, view.deny.available]).toEqual([false, false]);
    expect(view.blockedReason).toContain("terminal");
  });

  test("dado pedido mas herdr indisponível, então nenhum botão vale e o motivo é o herdr", () => {
    const view = Perm.permissionView(agent(), { herdrAvailable: false }) as View;
    expect([view.approve.available, view.blockedReason]).toEqual([false, "o herdr não está disponível"]);
  });
});

describe("node-permission: o motivo do bloqueio fica na tela", () => {
  const texts = (tree: unknown): string[] => {
    const out: string[] = [];
    const walk = (n: unknown): void => {
      if (typeof n === "string") out.push(n);
      else if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object") walk((n as { props?: { children?: unknown } }).props?.children);
    };
    walk(tree);
    return out;
  };
  const h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: { ...(props ?? {}), children } });

  test("dado ferramenta desconhecida, então o diálogo mostra o motivo e manda ao terminal do agente", () => {
    const view = Perm.permissionView(agent({ pendingPermission: { ts: TS, tool: "ExitPlanMode" } })) as View;
    const shown = texts(Perm.renderPermission({ h: h as never, onApprove() {}, onDeny() {} }, view as never, { phase: "idle" } as never, ""));
    expect(shown.some((t) => t.includes("terminal"))).toBe(true);
    expect(shown).toContain(view.blockedReason as string);
  });

  test("dado herdr fora de blocked, então o motivo cita o estado do herdr e o terminal", () => {
    const view = Perm.permissionView(agent({ herdrState: "working" })) as View;
    expect([view.approve.available, view.blockedReason]).toEqual([false, expect.stringContaining("working")]);
    expect(view.blockedReason).toContain("terminal");
  });
});

describe("node-permission: o envio ao servidor", () => {
  const request = actions.actionRequest({ id: "agent:p:a1" }, "approve_permission");

  test("dado aceite do servidor, então devolve o texto da saída e manda o corpo, o token e o sinal", async () => {
    const f = fakeFetch(OK);
    const out = await Perm.createActionSender({ fetch: f.fn, getToken: () => "tok" })(request);
    expect(out).toEqual({ ok: true, output: "feito" });
    const call = f.calls[0] as { url: string; init: Init };
    expect(call.url).toBe("/api/argos/action");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["X-Panel-Token"]).toBe("tok");
    expect(JSON.parse(call.init.body as string)).toEqual({ node: "agent:p:a1", action: "approve_permission", args: {} });
  });

  test("dado recusa do servidor com código, então o código chega como veio (não se ramifica pelo texto)", async () => {
    const f = fakeFetch(reply(409, { error: "não há permissão pendente neste agente", code: "permission_not_pending" }));
    expect(await Perm.createActionSender({ fetch: f.fn })(request)).toEqual({ ok: false, code: "permission_not_pending", message: "não há permissão pendente neste agente", status: 409 });
  });

  test("dado erro 5xx sem código, então vira internal_error; dado 200 fora do contrato, então send_unexpected_response", async () => {
    const f = fakeFetch(reply(500, {}), reply(200, { tudo: "certo" }), reply(502, "<html>"));
    const send = Perm.createActionSender({ fetch: f.fn });
    expect(((await send(request)) as { code: string }).code).toBe("internal_error");
    expect(((await send(request)) as { code: string }).code).toBe("send_unexpected_response");
    expect(((await send(request)) as { code: string }).code).toBe("internal_error");
  });

  test("dado queda de rede, então send_network com a mensagem do erro, e a promessa não rejeita", async () => {
    const f = fakeFetch(new Error("falhou a conexão"));
    expect(await Perm.createActionSender({ fetch: f.fn })(request)).toEqual({ ok: false, code: "send_network", message: "falhou a conexão", status: 0 });
  });

  test("dado painel que não responde, então o timeout aborta o pedido, vira send_timeout e o temporizador é desmontado", async () => {
    const f = fakeFetch("hang");
    const clock = manualTimers();
    const pending = Perm.createActionSender({ fetch: f.fn, timers: clock.timers })(request);
    expect(clock.live.size).toBe(1);
    clock.fire();
    expect(await pending).toEqual({ ok: false, code: "send_timeout", message: "o painel não respondeu a tempo", status: 0 });
    expect((f.calls[0] as { init: Init }).init.signal.aborted).toBe(true);
    expect(clock.live.size).toBe(0);
  });

  test("dado timeout próprio do envio, então ele vale no lugar do padrão", async () => {
    const seen: number[] = [];
    const timers: Timers = { set: (_run, ms) => (seen.push(ms), 1), clear: () => undefined };
    await Perm.createActionSender({ fetch: fakeFetch(OK).fn, timers, timeoutMs: 1000 })(request, { timeoutMs: 42 });
    await Perm.createActionSender({ fetch: fakeFetch(OK).fn, timers, timeoutMs: 1000 })(request);
    expect(seen).toEqual([42, 1000]);
  });

  test("dado sinal externo cancelado (antes ou durante), então send_aborted e o pedido em voo é abortado", async () => {
    const early = new AbortController();
    early.abort();
    const f1 = fakeFetch("hang");
    expect(((await Perm.createActionSender({ fetch: f1.fn })(request, { signal: early.signal })) as { code: string }).code).toBe("send_aborted");
    const during = new AbortController();
    const f2 = fakeFetch("hang");
    const pending = Perm.createActionSender({ fetch: f2.fn })(request, { signal: during.signal });
    during.abort();
    expect(((await pending) as { code: string }).code).toBe("send_aborted");
  });

  test("dado token velho (403 token), então pede outro, tenta uma vez mais com ele e avisa quem guarda o token", async () => {
    const f = fakeFetch(reply(403, { error: "token" }), reply(200, { token: "novo" }), OK);
    const got: string[] = [];
    const out = await Perm.createActionSender({ fetch: f.fn, getToken: () => "velho", onToken: (t) => got.push(t) })(request);
    expect(out.ok).toBe(true);
    expect(f.calls.map((c) => c.url)).toEqual(["/api/argos/action", "/api/token", "/api/argos/action"]);
    expect((f.calls[2] as { init: Init }).init.headers["X-Panel-Token"]).toBe("novo");
    expect(got).toEqual(["novo"]);
  });

  test("dado 403 token e o painel devolve o mesmo token, então não repete o pedido em laço", async () => {
    const f = fakeFetch(reply(403, { error: "token" }), reply(200, { token: "igual" }));
    const out = await Perm.createActionSender({ fetch: f.fn, getToken: () => "igual" })(request);
    expect(f.calls.length).toBe(2);
    expect(out.ok).toBe(false);
  });

  test("dado erro longo do servidor, então a mensagem é cortada em 300 caracteres", async () => {
    const f = fakeFetch(reply(422, { error: "x".repeat(900), code: "action_failed" }));
    expect(((await Perm.createActionSender({ fetch: f.fn })(request)) as { message: string }).message.length).toBe(300);
  });
});

describe("node-permission: estados", () => {
  const approve = "approve_permission";
  const ok: Outcome = { ok: true, output: "" };
  const bad: Outcome = { ok: false, code: "action_failed", message: "recusou", status: 422 };

  test("dado envio, então vai a sending, e um segundo envio durante o primeiro não troca de estado", () => {
    const sending = Perm.permissionReducer({ phase: "idle" }, { type: "send", action: approve });
    expect(sending).toEqual({ phase: "sending", action: approve });
    expect(Perm.permissionReducer(sending, { type: "send", action: "deny_permission" })).toBe(sending);
  });

  test("dado desfecho, então ok confirma e falha guarda o código; desfecho sem envio em curso é ignorado", () => {
    const sending: State = { phase: "sending", action: approve };
    expect(Perm.permissionReducer(sending, { type: "outcome", action: approve, outcome: ok })).toEqual({ phase: "confirmed", action: approve });
    expect(Perm.permissionReducer(sending, { type: "outcome", action: approve, outcome: bad })).toEqual({ phase: "error", action: approve, code: "action_failed", message: "recusou" });
    const idle: State = { phase: "idle" };
    expect(Perm.permissionReducer(idle, { type: "outcome", action: approve, outcome: ok })).toBe(idle);
    expect(Perm.permissionReducer(sending, { type: "outcome", action: "deny_permission", outcome: ok })).toBe(sending);
  });

  test("dado cada estado, então a mensagem diz envio, confirmação por ação ou o texto do código", () => {
    const plain = (_c: string | undefined, fallback: string): string => fallback;
    expect(Perm.stateMessage({ phase: "idle" }, plain)).toBe("");
    expect(Perm.stateMessage({ phase: "sending", action: approve }, plain)).toBe("Enviando…");
    expect(Perm.stateMessage({ phase: "confirmed", action: approve }, plain)).toContain("Aprovada");
    expect(Perm.stateMessage({ phase: "confirmed", action: "deny_permission" }, plain)).toContain("Negada");
    expect(Perm.stateMessage({ phase: "error", action: approve, code: "x", message: "m" }, (c) => `código ${c}`)).toBe("código x");
  });
});

describe("node-permission: responder o pedido", () => {
  test("dado ação que não vale, então nada é enviado e o motivo vira o código da falha", async () => {
    let sent = 0;
    const send: Sender = async () => (sent++, { ok: true, output: "" });
    const out = await Perm.answerPermission(agent({ pendingPermission: { ts: TS, tool: "ExitPlanMode" } }), "approve_permission", { send });
    expect(sent).toBe(0);
    expect(out).toMatchObject({ ok: false, code: "action_permission_not_supported" });
  });

  test("dado pedido que vale, então envia o corpo da ação para o nó", async () => {
    const bodies: unknown[] = [];
    const send: Sender = async (r) => (bodies.push(r), { ok: true, output: "" });
    await Perm.answerPermission(agent(), "deny_permission", { send });
    expect(bodies).toEqual([{ node: "agent:p:a1", action: "deny_permission", args: {} }]);
  });
});

describe("node-permission: componente", () => {
  /** Envio controlado pelo teste: guarda o sinal e só termina quando o teste manda. */
  function controlledSend() {
    const signals: (AbortSignal | undefined)[] = [];
    const bodies: unknown[] = [];
    let finish: (o: Outcome) => void = () => undefined;
    const send: Sender = (body, options) => {
      bodies.push(body);
      signals.push(options?.signal);
      return new Promise<Outcome>((resolve) => (finish = resolve));
    };
    return { send, signals, bodies, finish: (o: Outcome): void => finish(o) };
  }

  test("dado clique em aprovar, então entra em envio com o botão ocupado, e o segundo clique não envia de novo", async () => {
    const c = controlledSend();
    const m = mount(Perm.NodePermission, { node: agent(), send: c.send });
    (button(m.tree, "Aprovar").props.onClick as () => void)();
    m.settle();
    expect(button(m.tree, "Aprovar").props["aria-busy"]).toBe(true);
    expect([button(m.tree, "Aprovar").props.disabled, button(m.tree, "Negar").props.disabled]).toEqual([true, true]);
    expect(text(statusLine(m.tree))).toBe("Enviando…");
    (button(m.tree, "Aprovar").props.onClick as () => void)();
    expect(c.bodies.length).toBe(1);
  });

  test("dado aceite, então a confirmação aparece, os botões ficam desligados e quem integra é avisado", async () => {
    const c = controlledSend();
    const results: unknown[] = [];
    const m = mount(Perm.NodePermission, { node: agent(), send: c.send, onResult: (a: string, o: Outcome) => results.push([a, o.ok]) });
    (button(m.tree, "Aprovar").props.onClick as () => void)();
    m.settle();
    c.finish({ ok: true, output: "" });
    await m.flush();
    expect(text(statusLine(m.tree))).toContain("Aprovada");
    expect(button(m.tree, "Aprovar").props.disabled).toBe(true);
    expect(results).toEqual([["approve_permission", true]]);
  });

  test("dado recusa do servidor, então o erro aparece como alerta com o texto do código e dá para tentar de novo", async () => {
    const c = controlledSend();
    const errorText = (code: string | undefined, fallback: string): string => (code === "permission_not_pending" ? "Sem permissão pendente: o agente já seguiu." : fallback);
    const m = mount(Perm.NodePermission, { node: agent(), send: c.send, errorText });
    (button(m.tree, "Negar").props.onClick as () => void)();
    m.settle();
    c.finish({ ok: false, code: "permission_not_pending", message: "x", status: 409 });
    await m.flush();
    const line = statusLine(m.tree);
    expect([line.props.role, text(line)]).toEqual(["alert", "Sem permissão pendente: o agente já seguiu."]);
    expect(button(m.tree, "Negar").props.disabled).toBe(false);
    (button(m.tree, "Negar").props.onClick as () => void)();
    expect(c.bodies.length).toBe(2);
  });

  test("dado pedido novo (outro ts) depois de uma confirmação, então o estado volta ao início", async () => {
    const c = controlledSend();
    const m = mount(Perm.NodePermission, { node: agent(), send: c.send });
    (button(m.tree, "Aprovar").props.onClick as () => void)();
    m.settle();
    c.finish({ ok: true, output: "" });
    await m.flush();
    m.rerender({ node: agent({ pendingPermission: { ts: "2026-11-02T10:05:00.000Z", tool: "Edit" } }), send: c.send });
    expect(text(statusLine(m.tree))).toBe("");
    expect(button(m.tree, "Aprovar").props.disabled).toBe(false);
  });

  test("dado o grafo que já limpou a permissão, então a confirmação continua na tela, e some só com outro pedido", async () => {
    const c = controlledSend();
    const m = mount(Perm.NodePermission, { node: agent(), send: c.send });
    (button(m.tree, "Aprovar").props.onClick as () => void)();
    m.settle();
    c.finish({ ok: true, output: "" });
    await m.flush();
    m.rerender({ node: agent({ pendingPermission: null, herdrState: "working" }), send: c.send });
    expect(text(m.tree as El)).toContain("Aprovada");
    m.rerender({ node: agent({ pendingPermission: null }), send: c.send });
    expect(text(m.tree as El)).toContain("Aprovada");
  });

  test("dado desmontagem com envio em voo, então o sinal é abortado e a resposta tardia não mexe em nada", async () => {
    const c = controlledSend();
    const results: unknown[] = [];
    const m = mount(Perm.NodePermission, { node: agent(), send: c.send, onResult: (a: string) => results.push(a) });
    (button(m.tree, "Aprovar").props.onClick as () => void)();
    m.settle();
    m.unmount();
    expect(c.signals[0]?.aborted).toBe(true);
    c.finish({ ok: true, output: "" });
    await m.flush();
    expect(results).toEqual([]);
  });

  test("dado outro agente no mesmo componente durante o envio, então o envio é cancelado e a tela volta ao início", async () => {
    const c = controlledSend();
    const m = mount(Perm.NodePermission, { node: agent(), send: c.send });
    (button(m.tree, "Aprovar").props.onClick as () => void)();
    m.settle();
    m.rerender({ node: agent({ id: "agent:p:a2", label: "a2" }), send: c.send });
    expect(c.signals[0]?.aborted).toBe(true);
    expect(button(m.tree, "Aprovar").props.disabled).toBe(false);
  });

  test("dado pedido que só se responde no terminal, então os botões ficam desligados e nenhum envio sai", () => {
    const c = controlledSend();
    const m = mount(Perm.NodePermission, { node: agent({ pendingPermission: { ts: TS, tool: "AskUserQuestion" } }), send: c.send });
    expect(button(m.tree, "Aprovar").props.disabled).toBe(true);
    (button(m.tree, "Aprovar").props.onClick as () => void)();
    expect(c.bodies.length).toBe(0);
  });

  test("dado fetch injetado e sem envio pronto, então o componente monta o envio com ele", async () => {
    const f = fakeFetch(OK);
    const m = mount(Perm.NodePermission, { node: agent(), fetch: f.fn });
    (button(m.tree, "Aprovar").props.onClick as () => void)();
    await m.flush();
    expect(f.calls.length).toBe(1);
    expect(text(statusLine(m.tree))).toContain("Aprovada");
  });

  test("dado nó sem permissão e sem confirmação em curso, então não desenha nada", () => {
    expect(mount(Perm.NodePermission, { node: agent({ pendingPermission: null }), send: controlledSend().send }).tree).toBeNull();
  });

  test("dado pedido sem ferramenta registrada, então o nome acessível não inventa uma ferramenta", () => {
    const m = mount(Perm.NodePermission, { node: agent({ pendingPermission: { ts: TS, tool: null } }), send: controlledSend().send });
    expect((m.tree as El).props["aria-label"]).toBe("Permissão pendente: uma ferramenta");
  });
});
