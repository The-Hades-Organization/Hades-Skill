// Grupo canvas-types-live: tipos de nó vivos do canvas (kit/panel/ui/argos/types-live.tsx) — registro, busca com timeout e
// cancelamento, leitura das respostas das rotas, portal (iframe com sandbox ou link) e ciclo de vida dos nós. O .tsx é script
// de navegador: aqui ele roda sobre um React mínimo (elementos como objetos, estado e efeitos síncronos), com `fetch`, relógio
// e temporizadores falsos injetados por `deps`, e os módulos reais de src/lib.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as agentFiles from "../../../src/lib/canvas-agent-files.ts";
import * as conversation from "../../../src/lib/canvas-conversation.ts";
import * as portal from "../../../src/lib/canvas-portal.ts";
import { createNodeTypeRegistry, type NodeRenderInput } from "../../../src/lib/canvas-types.ts";

// O contorno do que o teste usa do .tsx (o tsconfig do projeto não tem jsx e não inclui o kit).
interface El {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}
interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
interface LiveDeps {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; cache: string }): Promise<FakeResponse>;
  now(): number;
  model?: unknown;
  portalPolicy?: unknown;
  panelToken?(): string | undefined;
  setTimeout?(run: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
  timeoutMs?: number;
  pollMs?: number;
  onOpen?(target: { kind: "file"; agent: string | undefined; path: string; role?: string }): void;
}
type LiveResult = { kind: "ok"; data: unknown } | { kind: "error"; error: { code: string; message: string } } | { kind: "aborted" };
interface LiveApi {
  registerLiveTypes(types: ReturnType<typeof createNodeTypeRegistry>, deps: LiveDeps): { type: string }[];
  requestJson(deps: LiveDeps, req: { url: string; method?: string; body?: unknown; signal: AbortSignal; headers?: Record<string, string> }): Promise<LiveResult>;
  treeViewOf(raw: unknown, base: string): { rows: { path: string; name: string; kind: string; depth: number; change: string | null; below: number }[]; hidden: number; truncated: boolean; marks: boolean } | undefined;
  planViewOf(raw: unknown): { title: string; state: string; stateClipped: boolean; units: { name: string; role: string; agentState: string | null }[]; hiddenUnits: number } | undefined;
  portalPlanOf(view: portal.PortalView, check: { status: string; data: Record<string, unknown> | undefined; at: number | undefined; error: { code: string; message: string } | undefined }): { kind: string; url?: string; reason?: string };
  agentRefOf(raw: unknown): { name: string; registry: string | undefined } | undefined;
  ageLabel(now: number, at: number | undefined): string;
  LIVE_TYPE: Record<string, string>;
  LIVE_ERRORS: { timeout: string; network: string; badBody: string; badData: string; unavailable: string };
}

const g = globalThis as unknown as Record<string, unknown>;
const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: props ?? {}, children });

// ------------------------------------------------------------------ React mínimo

interface Hooks {
  useState(init: unknown): [unknown, (next: unknown) => void];
  useRef(init: unknown): { current: unknown };
  useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
}
let hooks: Hooks;

function mount<P>(component: (props: P) => unknown, initial: P) {
  let props = initial;
  const slots: { value?: unknown; deps?: readonly unknown[]; cleanup?: void | (() => void) }[] = [];
  let tree: unknown = null;
  let dirty = false;
  let cursor = 0;
  const pending: (() => void)[] = [];
  const mine: Hooks = {
    useState: (init) => {
      const i = cursor++;
      const slot = (slots[i] ??= { value: typeof init === "function" ? (init as () => unknown)() : init });
      return [slot.value, (next) => {
        const value = typeof next === "function" ? (next as (prev: unknown) => unknown)(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        dirty = true;
      }];
    },
    useRef: (init) => {
      const i = cursor++;
      return (slots[i] ??= { value: { current: init } }).value as { current: unknown };
    },
    useEffect: (fn, deps) => {
      const i = cursor++;
      const slot = (slots[i] ??= {});
      const same = slot.deps && deps && slot.deps.length === deps.length && slot.deps.every((d, n) => Object.is(d, deps[n]));
      if (same) return;
      pending.push(() => {
        if (typeof slot.cleanup === "function") slot.cleanup();
        slot.deps = deps;
        slot.cleanup = fn();
      });
    },
  };
  const render = (): void => {
    cursor = 0;
    hooks = mine;
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
    /** Deixa as promessas da busca andarem e redesenha até o estado assentar. */
    async flush(): Promise<void> {
      for (let n = 0; n < 4; n++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        settle();
      }
    },
    rerender(next?: P): void {
      if (next !== undefined) props = next;
      settle();
    },
    unmount(): void {
      for (const s of slots) if (typeof s.cleanup === "function") s.cleanup();
    },
  };
}

/** Expande componentes sem estado (Note, Refresh) para a árvore ficar só de elementos nativos. */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== "object" || node === null) return node;
  const el = node as El;
  const children = el.children.map(expand);
  if (typeof el.type === "function" && !(el.type as { name: string }).name.endsWith("Node")) return expand((el.type as (p: unknown) => unknown)({ ...el.props, children: children.length === 1 ? children[0] : children }));
  return { ...el, children };
}

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const el = node as El;
  return [...el.children.map(textOf), textOf(el.props.children)].join(" ");
}

function findAll(node: unknown, pick: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, pick, out);
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  const el = node as El;
  if (pick(el)) out.push(el);
  findAll(el.children, pick, out);
  return out;
}

const shown = (m: { tree: unknown }): unknown => expand(m.tree);
const allText = (m: { tree: unknown }): string => textOf(shown(m));

// ------------------------------------------------------------------ dublês

interface Call {
  url: string;
  init: Parameters<LiveDeps["fetch"]>[1];
  reply(status: number, body?: unknown): void;
  replyText(status: number, raw: string): void;
  fail(error: Error): void;
}

/** `fetch` falso: cada pedido fica pendente até o teste responder; `honorSignal: false` imita um fetch que ignora o cancelamento. */
function fakeFetch(honorSignal = true) {
  const calls: Call[] = [];
  const fetch: LiveDeps["fetch"] = (url, init) =>
    new Promise<FakeResponse>((resolve, reject) => {
      const respond = (status: number, json: () => Promise<unknown>): void => resolve({ ok: status >= 200 && status < 300, status, json });
      calls.push({
        url, init,
        reply: (status, body) => respond(status, async () => body),
        replyText: (status, raw) => respond(status, async () => JSON.parse(raw)),
        fail: reject,
      });
      if (honorSignal) init.signal.addEventListener("abort", () => reject(new Error("abortado")), { once: true });
    });
  return { calls, fetch };
}

const timers = new Map<number, { run: () => void; ms: number }>();
let timerSeq = 0;
const clock = { t: Date.parse("2026-11-02T10:00:00.000Z") };
const timerDeps = {
  setTimeout: (run: () => void, ms: number): number => {
    timers.set(++timerSeq, { run, ms });
    return timerSeq;
  },
  clearTimeout: (id: unknown): void => {
    timers.delete(id as number);
  },
};
const fire = (): void => {
  for (const [id, t] of [...timers]) {
    timers.delete(id);
    t.run();
  }
};
const msOfTimers = (): number[] => [...timers.values()].map((t) => t.ms);

const model = { portal, conversation, agentFiles };

function makeDeps(fetch: LiveDeps["fetch"], extra: Partial<LiveDeps> = {}): LiveDeps {
  return { fetch, now: () => clock.t, model, panelToken: () => "tok", ...timerDeps, ...extra };
}

const node = (type: string, data: Record<string, unknown>, selected = false): NodeRenderInput => ({ id: `n-${type}`, type, w: 400, h: 300, selected, data, live: undefined });

/** O nó como a página o desenharia: `draw.render` devolve o elemento do componente, que se monta com os hooks. */
function mountNode(api: LiveApi, deps: LiveDeps, input: NodeRenderInput) {
  const registry = createNodeTypeRegistry();
  api.registerLiveTypes(registry, deps);
  const el = registry.get(input.type)?.draw.render(input) as El;
  return mount(el.type as (p: unknown) => unknown, el.props);
}

let Live: LiveApi;
beforeAll(async () => {
  g.React = {
    createElement,
    useState: (init: unknown) => hooks.useState(init),
    useRef: (init: unknown) => hooks.useRef(init),
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => hooks.useEffect(fn, deps),
  };
  // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
  await import("../../../kit/panel/ui/argos/types-live.tsx");
  Live = g.ArgosTypesLive as LiveApi;
});
afterAll(() => {
  delete g.React;
  delete g.ArgosTypesLive;
  delete g.ArgosNodeTerminal;
});
beforeEach(() => {
  timers.clear();
  delete g.ArgosNodeTerminal;
});

const URL_PORTAL = "http://localhost:3000/app";

// ------------------------------------------------------------------ registro

describe("tipos vivos: registro", () => {
  test("registra os sete tipos como nós de usuário em HTML, sem menu nem ação do servidor", () => {
    const registry = createNodeTypeRegistry();
    const defs = Live.registerLiveTypes(registry, makeDeps(fakeFetch().fetch));
    expect(defs.map((d) => d.type)).toEqual(["portal", "terminal", "tree", "plan", "agent-file", "conversation", "mark"]);
    for (const def of registry.list()) {
      expect(def.live).toBe(false);
      expect(def.draw.surface).toBe("html");
      expect([def.menu.length, def.actions.length]).toEqual([0, 0]);
    }
    expect(registry.sizeOf("portal")).toEqual(portal.PORTAL_DEFAULT_SIZE);
  });

  test("registrar de novo (modo estrito do React) não lança nem duplica", () => {
    const registry = createNodeTypeRegistry();
    const deps = makeDeps(fakeFetch().fetch);
    Live.registerLiveTypes(registry, deps);
    expect(() => Live.registerLiveTypes(registry, deps)).not.toThrow();
    expect(registry.list()).toHaveLength(7);
  });
});

// ------------------------------------------------------------------ busca

describe("requestJson: timeout, cancelamento e erro da rota", () => {
  test("dada resposta 200, devolve o JSON e não deixa temporizador", async () => {
    const f = fakeFetch();
    const pending = Live.requestJson(makeDeps(f.fetch), { url: "/x", signal: new AbortController().signal });
    f.calls[0]?.reply(200, { a: 1 });
    expect(await pending).toEqual({ kind: "ok", data: { a: 1 } });
    expect(timers.size).toBe(0);
    expect(f.calls[0]?.init.cache).toBe("no-store");
  });

  test("dado POST com corpo, envia JSON e o cabeçalho pedido", async () => {
    const f = fakeFetch();
    const pending = Live.requestJson(makeDeps(f.fetch), { url: "/x", method: "POST", body: { u: 1 }, headers: { "X-Panel-Token": "t" }, signal: new AbortController().signal });
    f.calls[0]?.reply(200, {});
    await pending;
    expect(f.calls[0]?.init).toMatchObject({ method: "POST", body: '{"u":1}', headers: { "Content-Type": "application/json", "X-Panel-Token": "t" } });
  });

  test("quando o prazo estoura, responde live_timeout e cancela o pedido", async () => {
    const f = fakeFetch();
    const pending = Live.requestJson(makeDeps(f.fetch, { timeoutMs: 1234 }), { url: "/x", signal: new AbortController().signal });
    expect(msOfTimers()).toEqual([1234]);
    fire();
    expect(await pending).toMatchObject({ kind: "error", error: { code: Live.LIVE_ERRORS.timeout } });
    expect(f.calls[0]?.init.signal.aborted).toBe(true);
    expect(timers.size).toBe(0);
  });

  test("quando quem chamou cancela, responde aborted e tira o temporizador", async () => {
    const f = fakeFetch();
    const ctl = new AbortController();
    const pending = Live.requestJson(makeDeps(f.fetch), { url: "/x", signal: ctl.signal });
    ctl.abort();
    expect(await pending).toEqual({ kind: "aborted" });
    expect(timers.size).toBe(0);
  });

  test("resposta que chega depois do cancelamento é descartada mesmo se o fetch ignorou o sinal", async () => {
    const f = fakeFetch(false);
    const ctl = new AbortController();
    const pending = Live.requestJson(makeDeps(f.fetch), { url: "/x", signal: ctl.signal });
    ctl.abort();
    f.calls[0]?.reply(200, { velho: true });
    expect(await pending).toEqual({ kind: "aborted" });
  });

  test("já cancelado antes de começar, nem chama o fetch", async () => {
    const f = fakeFetch();
    const ctl = new AbortController();
    ctl.abort();
    expect(await Live.requestJson(makeDeps(f.fetch), { url: "/x", signal: ctl.signal })).toEqual({ kind: "aborted" });
    expect(f.calls).toHaveLength(0);
  });

  test("erro da rota entra pelo código estável e pela mensagem fixa dela", async () => {
    const f = fakeFetch();
    const pending = Live.requestJson(makeDeps(f.fetch), { url: "/x", signal: new AbortController().signal });
    f.calls[0]?.reply(404, { error: "agente desconhecido", code: "unknown_agent" });
    expect(await pending).toEqual({ kind: "error", error: { code: "unknown_agent", message: "agente desconhecido" } });
  });

  test("status de erro sem corpo legível vira http_<status>", async () => {
    const f = fakeFetch();
    const pending = Live.requestJson(makeDeps(f.fetch), { url: "/x", signal: new AbortController().signal });
    f.calls[0]?.fail(new Error("x"));
    expect(await pending).toMatchObject({ kind: "error", error: { code: Live.LIVE_ERRORS.network } });
    const second = fakeFetch();
    const p2 = Live.requestJson(makeDeps(second.fetch), { url: "/x", signal: new AbortController().signal });
    second.calls[0]?.replyText(500, "[]");
    expect(await p2).toMatchObject({ kind: "error", error: { code: "http_500" } });
  });

  test("corpo que não é JSON num 200 é live_bad_body", async () => {
    const deps = makeDeps(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("x")) }));
    expect(await Live.requestJson(deps, { url: "/x", signal: new AbortController().signal })).toMatchObject({ kind: "error", error: { code: Live.LIVE_ERRORS.badBody } });
  });

  test("mensagem longa da rota é cortada", async () => {
    const f = fakeFetch();
    const pending = Live.requestJson(makeDeps(f.fetch), { url: "/x", signal: new AbortController().signal });
    f.calls[0]?.reply(500, { error: "x".repeat(5000), code: "c" });
    const res = await pending;
    expect(res.kind === "error" && res.error.message.length).toBeLessThanOrEqual(200);
  });
});

// ------------------------------------------------------------------ leitura das respostas

describe("árvore, plano e portal: leitura das respostas", () => {
  const entry = (path: string, type = "file", extra: Record<string, unknown> = {}) => ({ path, name: path.split("/").pop(), type, size: 1, change: null, changedBelow: 0, ...extra });

  test("a árvore indenta pelo nível abaixo da pasta pedida e marca o que mudou", () => {
    const view = Live.treeViewOf({ entries: [entry("src", "dir", { changedBelow: 2 }), entry("src/a.ts", "file", { change: "M" }), entry("src/lib/b.ts")], truncated: false, changes: { available: true } }, "");
    expect(view?.rows.map((r) => [r.path, r.depth, r.change, r.below])).toEqual([["src", 0, null, 2], ["src/a.ts", 1, "M", 0], ["src/lib/b.ts", 2, null, 0]]);
    expect(view?.marks).toBe(true);
    expect(Live.treeViewOf({ entries: [entry("src/a.ts")], changes: {} }, "src")?.rows[0]?.depth).toBe(0);
  });

  test("pasta vazia dá zero linhas; resposta que não é árvore é recusada", () => {
    expect(Live.treeViewOf({ entries: [], truncated: false, changes: { available: false } }, "")).toMatchObject({ rows: [], hidden: 0, marks: false });
    expect(Live.treeViewOf({ entries: "x" }, "")).toBeUndefined();
    expect(Live.treeViewOf(null, "")).toBeUndefined();
  });

  test("passando de 200 entradas desenha 200 e conta o resto; entrada malformada é pulada", () => {
    const many = Array.from({ length: 250 }, (_, i) => entry(`f${i}`));
    const view = Live.treeViewOf({ entries: [...many, 7, { path: 1 }], truncated: true }, "");
    expect(view?.rows).toHaveLength(200);
    expect(view?.hidden).toBe(52);
    expect(view?.truncated).toBe(true);
  });

  test("o plano corta o estado, limita as unidades e diferencia unidade com e sem agente", () => {
    const units = Array.from({ length: 45 }, (_, i) => ({ name: `u${i}`, role: "impl", agent: i === 0 ? { state: "running" } : null }));
    const view = Live.planViewOf({ title: "T", state: "e".repeat(5000), units });
    expect(view?.stateClipped).toBe(true);
    expect(view?.state.length).toBe(1200);
    expect(view?.units).toHaveLength(40);
    expect(view?.hiddenUnits).toBe(5);
    expect(view?.units[0]?.agentState).toBe("running");
    expect(view?.units[1]?.agentState).toBeNull();
    expect(Live.planViewOf({ title: 3 })).toBeUndefined();
  });

  test("o agente vem do id do nó (registro e nome) ou do nome puro; o resto é recusado", () => {
    expect(Live.agentRefOf("agent:proj:u-terminal")).toEqual({ registry: "proj", name: "u-terminal" });
    expect(Live.agentRefOf("u-terminal")).toEqual({ registry: undefined, name: "u-terminal" });
    for (const bad of ["", "../x", "a b", "agent:p:", 4, null, "x".repeat(81)]) expect(Live.agentRefOf(bad)).toBeUndefined();
  });

  test("há 5 s, há 2 min, há 3 h; sem instante, vazio", () => {
    expect([Live.ageLabel(10_000, 5000), Live.ageLabel(130_000, 10_000), Live.ageLabel(3 * 3600_000 + 1000, 1000), Live.ageLabel(1, undefined)]).toEqual(["há 5 s", "há 2 min", "há 3 h", ""]);
  });
});

describe("portal: o que o nó mostra", () => {
  const policy = portal.buildPortalPolicy();
  const view = portal.portalViewOf({ type: "portal", data: { url: URL_PORTAL } }, policy);
  const state = (over: Record<string, unknown>) => ({ status: "ok", data: undefined, at: 1, error: undefined, ...over }) as Parameters<LiveApi["portalPlanOf"]>[1];

  test("embutível vira quadro; sem resposta ainda, conferindo; página que proíbe vira link com o motivo", () => {
    expect(Live.portalPlanOf(view, state({ data: { embeddable: true } })).kind).toBe("frame");
    expect(Live.portalPlanOf(view, state({ status: "loading" })).kind).toBe("checking");
    const link = Live.portalPlanOf(view, state({ data: { embeddable: false, reason: portal.PORTAL_BLOCKS.frameOptionsDeny } }));
    expect(link).toMatchObject({ kind: "link", url: "http://localhost:3000/app" });
    expect(link.reason).toContain("X-Frame-Options");
  });

  test("a rota recusou o endereço: sem quadro e sem link; falha de rede ainda deixa o link", () => {
    expect(Live.portalPlanOf(view, state({ status: "error", error: { code: "portal_host_not_allowed", message: "m" } })).kind).toBe("refused");
    expect(Live.portalPlanOf(view, state({ status: "error", error: { code: "live_network", message: "m" } })).kind).toBe("link");
  });

  test("URL fora da política do documento é recusada antes de qualquer pedido", () => {
    const blocked = portal.portalViewOf({ type: "portal", data: { url: "https://outro.example/" } }, policy);
    expect(Live.portalPlanOf(blocked, state({ data: { embeddable: true } })).kind).toBe("refused");
  });

  test("todo motivo do modelo tem texto próprio", () => {
    const reasons = Object.values(portal.PORTAL_BLOCKS);
    for (const r of reasons) {
      const link = Live.portalPlanOf(view, state({ data: { embeddable: false, reason: r } }));
      expect(link.reason).not.toBe("Não foi possível embutir esta página.");
    }
  });
});

// ------------------------------------------------------------------ nós montados

describe("nó portal", () => {
  test("página embutível: confere pela rota e desenha o quadro com sandbox mínimo e sem referrer", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("portal", { url: URL_PORTAL }));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("/api/canvas/portal/check");
    expect(f.calls[0]?.init).toMatchObject({ method: "POST", body: JSON.stringify({ url: URL_PORTAL }), headers: { "X-Panel-Token": "tok", "Content-Type": "application/json" } });
    expect(allText(m)).toContain("Conferindo");
    f.calls[0]?.reply(200, { embeddable: true, reason: null });
    await m.flush();
    const [frame] = findAll(shown(m), (e) => e.type === "iframe");
    expect(frame?.props).toMatchObject({ src: URL_PORTAL, sandbox: "allow-scripts allow-forms", referrerPolicy: "no-referrer" });
    expect(String(frame?.props.sandbox)).not.toContain("allow-same-origin");
  });

  test("página que proíbe embutir vira link seguro com o motivo", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("portal", { url: URL_PORTAL }));
    f.calls[0]?.reply(200, { embeddable: false, reason: "frame_options_deny" });
    await m.flush();
    expect(findAll(shown(m), (e) => e.type === "iframe")).toHaveLength(0);
    const [link] = findAll(shown(m), (e) => e.type === "a");
    expect(link?.props).toMatchObject({ href: URL_PORTAL, target: "_blank", rel: "noopener noreferrer" });
    expect(allText(m)).toContain("X-Frame-Options");
  });

  test.each([["javascript:alert(1)"], ["https://fora.example/"], ["http://u:p@localhost/"], [""], [42]])("URL %p do documento não gera pedido, quadro nem link", (url) => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("portal", { url }));
    expect(f.calls).toHaveLength(0);
    expect(findAll(shown(m), (e) => e.type === "iframe" || e.type === "a")).toHaveLength(0);
    expect(allText(m).trim()).not.toBe("");
  });

  test("erro da rota aparece no nó como link com o motivo, sem quebrar", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("portal", { url: URL_PORTAL }));
    f.calls[0]?.reply(429, { error: "limite", code: "portal_rate_limited" });
    await m.flush();
    expect(allText(m)).toContain("Conferências demais");
    expect(findAll(shown(m), (e) => e.type === "a")).toHaveLength(1);
  });

  test("a rota recusou o host: nada de quadro nem link", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("portal", { url: URL_PORTAL }));
    f.calls[0]?.reply(403, { error: "host", code: "portal_host_not_allowed" });
    await m.flush();
    expect(findAll(shown(m), (e) => e.type === "iframe" || e.type === "a")).toHaveLength(0);
    expect(allText(m)).toContain("lista permitida");
  });

  test("desmontar cancela a conferência em voo e deixa o prazo sem dono", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("portal", { url: URL_PORTAL }));
    expect(timers.size).toBe(1);
    m.unmount();
    expect(f.calls[0]?.init.signal.aborted).toBe(true);
    await m.flush();
    expect(timers.size).toBe(0);
  });

  test("trocar a URL cancela a conferência da anterior e confere a nova", async () => {
    const f = fakeFetch();
    const deps = makeDeps(f.fetch);
    const registry = createNodeTypeRegistry();
    Live.registerLiveTypes(registry, deps);
    const el = registry.get("portal")?.draw.render(node("portal", { url: URL_PORTAL })) as El;
    const m = mount(el.type as (p: unknown) => unknown, el.props);
    m.rerender({ deps, node: node("portal", { url: "http://localhost:4000/" }) });
    expect(f.calls.map((c) => c.init.signal.aborted)).toEqual([true, false]);
    expect(f.calls[1]?.init.body).toBe(JSON.stringify({ url: "http://localhost:4000/" }));
  });
});

describe("nó terminal", () => {
  const Terminal = (): null => null;

  test("monta o terminal do herdr com sessão e painel, e só lê ao vivo com o nó selecionado", () => {
    g.ArgosNodeTerminal = { NodeTerminal: Terminal };
    const deps = makeDeps(fakeFetch().fetch);
    const solto = mountNode(Live, deps, node("terminal", { session: "s1", pane: "p-2", hasAgent: true }));
    expect((solto.tree as El).type).toBe(Terminal);
    expect((solto.tree as El).props).toEqual({ session: "s1", pane: "p-2", hasAgent: true, live: false });
    const preso = mountNode(Live, deps, node("terminal", { session: "s1", pane: "p-2" }, true));
    expect((preso.tree as El).props).toMatchObject({ live: true, hasAgent: false });
  });

  test("sem o script do terminal carregado, ou com painel inválido, mostra o motivo no nó", () => {
    const deps = makeDeps(fakeFetch().fetch);
    expect(allText(mountNode(Live, deps, node("terminal", { session: "s1", pane: "p" })))).toContain("ainda não está carregada");
    g.ArgosNodeTerminal = { NodeTerminal: Terminal };
    for (const data of [{}, { session: "s1" }, { session: "s 1", pane: "p" }, { session: "s", pane: "../p" }]) {
      const m = mountNode(Live, deps, node("terminal", data));
      expect((m.tree as El).type).not.toBe(Terminal);
      expect(allText(m)).toContain("dados inválidos");
    }
  });
});

describe("nó árvore de arquivos", () => {
  const entry = (path: string, type = "file") => ({ path, name: path.split("/").pop(), type, size: 1, change: null, changedBelow: 0 });

  test("lê a árvore do agente pela rota, com o registro do id do nó, e desenha as linhas", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("tree", { agent: "agent:proj:u-terminal", depth: 2 }));
    expect(f.calls[0]?.url).toBe("/api/canvas-content/tree?agent=u-terminal&registry=proj&depth=2");
    f.calls[0]?.reply(200, { entries: [entry("src", "dir"), entry("README.md")], truncated: false, changes: { available: false } });
    await m.flush();
    expect(findAll(shown(m), (e) => e.type === "button" && textOf(e).includes("src/"))).toHaveLength(1);
    expect(allText(m)).toContain("README.md");
    expect(allText(m)).toContain("Sem as marcas");
  });

  test("clicar numa pasta desce nela (novo pedido, o anterior sai) e Subir volta", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("tree", { agent: "u-terminal" }));
    f.calls[0]?.reply(200, { entries: [entry("src", "dir")], changes: { available: true } });
    await m.flush();
    (findAll(shown(m), (e) => e.type === "button" && textOf(e).includes("src/"))[0]?.props.onClick as () => void)();
    m.rerender();
    await m.flush();
    expect(f.calls[1]?.url).toBe("/api/canvas-content/tree?agent=u-terminal&path=src&depth=1");
    f.calls[1]?.reply(200, { entries: [entry("src/a.ts")], changes: { available: true } });
    await m.flush();
    expect(allText(m)).toContain("a.ts");
    (findAll(shown(m), (e) => e.type === "button" && textOf(e).trim() === "Subir")[0]?.props.onClick as () => void)();
    m.rerender();
    expect(f.calls[2]?.url).toBe("/api/canvas-content/tree?agent=u-terminal&depth=1");
  });

  test("pasta vazia diz que está vazia", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("tree", { agent: "u-terminal" }));
    f.calls[0]?.reply(200, { entries: [], truncated: false, changes: { available: true } });
    await m.flush();
    expect(allText(m)).toContain("Pasta vazia");
  });

  test.each([[{}], [{ agent: "../x" }], [{ agent: "u", path: "../fora" }], [{ agent: "u", path: "/abs" }], [{ agent: "u", registry: "a b" }]])("dados %p inválidos não geram pedido", (data) => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("tree", data));
    expect(f.calls).toHaveLength(0);
    expect(allText(m)).toContain("dados inválidos");
  });

  test("erro da rota aparece no nó com o código, e a profundidade pedida é limitada a 1..4", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("tree", { agent: "u", depth: 99 }));
    expect(f.calls[0]?.url).toContain("depth=4");
    f.calls[0]?.reply(404, { error: "agente desconhecido", code: "unknown_agent" });
    await m.flush();
    expect(allText(m)).toContain("agente desconhecido (unknown_agent)");
  });

  test("arquivo só é clicável quando a página escuta onOpen, e entrega agente e caminho", async () => {
    const opened: unknown[] = [];
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch, { onOpen: (t) => opened.push(t) }), node("tree", { agent: "u" }));
    f.calls[0]?.reply(200, { entries: [entry("a.ts")], changes: {} });
    await m.flush();
    (findAll(shown(m), (e) => e.type === "button" && textOf(e).includes("a.ts"))[0]?.props.onClick as () => void)();
    expect(opened).toEqual([{ kind: "file", agent: "u", path: "a.ts" }]);
    const mudo = mountNode(Live, makeDeps(f.fetch), node("tree", { agent: "u" }));
    f.calls[1]?.reply(200, { entries: [entry("a.ts")], changes: {} });
    await mudo.flush();
    expect(findAll(shown(mudo), (e) => e.type === "button" && textOf(e).includes("a.ts"))[0]?.props.disabled).toBe(true);
  });

  test("desmontar cancela a busca em voo", () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("tree", { agent: "u" }));
    m.unmount();
    expect(f.calls[0]?.init.signal.aborted).toBe(true);
    expect(timers.size).toBe(0);
  });
});

describe("nó plano", () => {
  test("com nome, lê o plano (nome codificado) e mostra estado e unidades", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("plan", { name: "argos-canvas-p5.md".replace(".md", "") }));
    expect(f.calls[0]?.url).toBe("/api/canvas-content/plan/argos-canvas-p5");
    f.calls[0]?.reply(200, { name: "argos-canvas-p5", title: "Rodada 5", state: "tudo em voo", units: [{ name: "l-tipos-vivos", role: "impl", agent: { name: "l", registry: "p", state: "running" } }, { name: "x", role: "impl", agent: null }] });
    await m.flush();
    const text = allText(m);
    expect(text).toContain("Rodada 5");
    expect(text).toContain("tudo em voo");
    expect(text).toContain("running");
    expect(text).toContain("sem agente");
  });

  test("sem nome, lista os planos para escolher e escolher lê aquele plano", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("plan", {}));
    expect(f.calls[0]?.url).toBe("/api/canvas-content/plans");
    f.calls[0]?.reply(200, { plans: [{ name: "a-plano", modifiedAt: "x" }, { name: "../mau", modifiedAt: "x" }] });
    await m.flush();
    const buttons = findAll(shown(m), (e) => e.type === "button" && textOf(e).includes("a-plano"));
    expect(buttons).toHaveLength(1);
    expect(findAll(shown(m), (e) => e.type === "button" && textOf(e).includes("mau"))).toHaveLength(0);
    (buttons[0]?.props.onClick as () => void)();
    m.rerender();
    expect(f.calls[1]?.url).toBe("/api/canvas-content/plan/a-plano");
  });

  test("lista vazia de planos e nome inválido são avisados, e nome inválido não gera pedido", async () => {
    const f = fakeFetch();
    const vazio = mountNode(Live, makeDeps(f.fetch), node("plan", {}));
    f.calls[0]?.reply(200, { plans: [] });
    await vazio.flush();
    expect(allText(vazio)).toContain("Nenhum plano");
    const ruim = mountNode(Live, makeDeps(f.fetch), node("plan", { name: "../etc/passwd" }));
    expect(f.calls).toHaveLength(1);
    expect(allText(ruim)).toContain("Nome de plano inválido");
  });

  test("plano grande demais: o erro da rota aparece no nó", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("plan", { name: "p" }));
    f.calls[0]?.reply(413, { error: "plano grande demais", code: "plan_too_large" });
    await m.flush();
    expect(allText(m)).toContain("plan_too_large");
  });
});

describe("nó arquivo do agente", () => {
  const data = { path: ".design-sync-reports/brief.md", role: "brief", agent: "agent:proj:u-terminal", label: "brief.md" };

  test("confere na pasta do arquivo se ele existe e, clicado, entrega agente, caminho e papel", async () => {
    const opened: unknown[] = [];
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch, { onOpen: (t) => opened.push(t) }), node("agent-file", data));
    expect(f.calls[0]?.url).toBe("/api/canvas-content/tree?agent=u-terminal&registry=proj&path=.design-sync-reports&depth=1");
    f.calls[0]?.reply(200, { entries: [{ path: ".design-sync-reports/brief.md", name: "brief.md", type: "file" }] });
    await m.flush();
    expect(allText(m)).toContain("brief");
    expect(allText(m)).not.toContain("ainda não existe");
    (shown(m) as El).props.onClick && ((shown(m) as El).props.onClick as () => void)();
    expect(opened).toEqual([{ kind: "file", agent: "u-terminal", path: ".design-sync-reports/brief.md", role: "brief" }]);
  });

  test("arquivo ausente na pasta é avisado; a pasta que a rota nega vira 'não confirmei', sem quebrar", async () => {
    const f = fakeFetch();
    const ausente = mountNode(Live, makeDeps(f.fetch), node("agent-file", data));
    f.calls[0]?.reply(200, { entries: [] });
    await ausente.flush();
    expect(allText(ausente)).toContain("ainda não existe");
    const negado = mountNode(Live, makeDeps(f.fetch), node("agent-file", data));
    f.calls[1]?.reply(404, { error: "x", code: "path_not_found" });
    await negado.flush();
    expect(allText(negado)).toContain("Não confirmei");
  });

  test.each([[{ ...data, path: "../fora" }], [{ ...data, role: "outro" }], [{ ...data, agent: "x y" }], [{ role: "brief" }]])("dados %p inválidos não geram pedido", (bad) => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("agent-file", bad));
    expect(f.calls).toHaveLength(0);
    expect(allText(m)).toContain("inválido");
  });
});

describe("nó conversa", () => {
  const ev = (s: number, kind: string, summary: string) => ({ v: 1, ts: new Date(Date.parse("2026-11-02T10:00:00Z") + s * 1000).toISOString(), agent: "u", session: "s", source: "guard", kind, summary });

  test("lê o diário do agente com teto e desenha a conversa em ordem", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch), node("conversation", { agent: "agent:proj:u-terminal" }));
    expect(f.calls[0]?.url).toBe("/api/journal?agent=u-terminal&limit=200");
    f.calls[0]?.reply(200, { events: [ev(1, "stop", "fim"), ev(0, "prompt", "faça o item")], count: 2 });
    await m.flush();
    const items = findAll(shown(m), (e) => e.type === "li").map(textOf);
    expect(items[0]).toContain("faça o item");
    expect(items[1]).toContain("fim");
  });

  test("diário vazio, evento inválido e resposta fora do formato", async () => {
    const f = fakeFetch();
    const vazio = mountNode(Live, makeDeps(f.fetch), node("conversation", { agent: "u" }));
    f.calls[0]?.reply(200, { events: [] });
    await vazio.flush();
    expect(allText(vazio)).toContain("não tem eventos");
    const invalido = mountNode(Live, makeDeps(f.fetch), node("conversation", { agent: "u" }));
    f.calls[1]?.reply(200, { events: [ev(0, "prompt", "ok"), { lixo: true }] });
    await invalido.flush();
    expect(allText(invalido)).toContain("1 linhas ignoradas");
    const torto = mountNode(Live, makeDeps(f.fetch), node("conversation", { agent: "u" }));
    f.calls[2]?.reply(200, { eventos: [] });
    await torto.flush();
    expect(allText(torto)).toContain(Live.LIVE_ERRORS.badBody);
  });

  test("o limite do nó vale até 200; sem agente válido não há pedido", () => {
    const f = fakeFetch();
    mountNode(Live, makeDeps(f.fetch), node("conversation", { agent: "u", limit: 50 }));
    mountNode(Live, makeDeps(f.fetch), node("conversation", { agent: "u", limit: 5000 }));
    expect(f.calls.map((c) => c.url)).toEqual(["/api/journal?agent=u&limit=50", "/api/journal?agent=u&limit=200"]);
    const m = mountNode(Live, makeDeps(f.fetch), node("conversation", { agent: "a/b" }));
    expect(f.calls).toHaveLength(2);
    expect(allText(m)).toContain("dados inválidos");
  });

  test("selecionado, relê a cada intervalo depois de cada leitura; solto, lê uma vez e não deixa temporizador", async () => {
    const f = fakeFetch();
    const sel = mountNode(Live, makeDeps(f.fetch, { pollMs: 7000 }), node("conversation", { agent: "u" }, true));
    f.calls[0]?.reply(200, { events: [] });
    await sel.flush();
    expect(msOfTimers().filter((ms) => ms === 7000)).toHaveLength(1);
    fire();
    expect(f.calls).toHaveLength(2);
    f.calls[1]?.reply(200, { events: [ev(0, "prompt", "novo")] });
    await sel.flush();
    expect(allText(sel)).toContain("novo");
    sel.unmount();
    expect(timers.size).toBe(0);

    timers.clear();
    const solto = mountNode(Live, makeDeps(f.fetch), node("conversation", { agent: "u" }, false));
    f.calls[2]?.reply(200, { events: [] });
    await solto.flush();
    expect(timers.size).toBe(0);
  });

  test("falha numa releitura mantém a última conversa e mostra o erro", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch, { pollMs: 10 }), node("conversation", { agent: "u" }, true));
    f.calls[0]?.reply(200, { events: [ev(0, "prompt", "ficou")] });
    await m.flush();
    fire();
    f.calls[1]?.reply(503, { error: "diário fora", code: "journal_down" });
    await m.flush();
    expect(allText(m)).toContain("ficou");
    expect(allText(m)).toContain("journal_down");
  });

  test("resposta atrasada de uma busca cancelada não vira estado", async () => {
    const f = fakeFetch(false);
    const m = mountNode(Live, makeDeps(f.fetch), node("conversation", { agent: "u" }));
    m.unmount();
    f.calls[0]?.reply(200, { events: [ev(0, "prompt", "tarde")] });
    await m.flush();
    expect(allText(m)).not.toContain("tarde");
  });

  test("prazo estourado aparece no nó como erro, com o código", async () => {
    const f = fakeFetch();
    const m = mountNode(Live, makeDeps(f.fetch, { timeoutMs: 50 }), node("conversation", { agent: "u" }));
    fire();
    await m.flush();
    expect(allText(m)).toContain(Live.LIVE_ERRORS.timeout);
  });
});
