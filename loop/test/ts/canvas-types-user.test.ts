// Grupo canvas-types-user: tipos de nó do usuário (kit/panel/ui/argos/types-user.tsx) — registro, cliente da rota das notas,
// editor da nota (conflito mostrado ao dono), texto no lugar, desenho, esboço de unidade e banda. O .tsx é um script clássico
// de navegador: aqui ele roda sobre um React mínimo (elementos como objetos, estado e efeitos), com os modelos reais de
// src/lib e `fetch`, relógio e agendador falsos, sem rede nem DOM.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as bands from "../../../src/lib/canvas-bands";
import * as create from "../../../src/lib/canvas-create";
import * as draw from "../../../src/lib/canvas-draw";
import * as drawingLib from "../../../src/lib/canvas-drawing";
import * as note from "../../../src/lib/canvas-note";
import { type CanvasDoc, type CanvasNode, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { createHistory, perform, undo } from "../../../src/lib/canvas-history";
import { createNodeTypeRegistry, RegistryError } from "../../../src/lib/canvas-types";

// Os tipos do .tsx não entram aqui (o tsconfig do projeto não tem jsx): este é o contorno do que o teste usa dele.
type Model = { note: typeof note; draw: typeof draw; create: typeof create; bands: typeof bands; drawing?: typeof drawingLib };
type Tree = { type: unknown; props: Record<string, unknown>; children: unknown[] };
type FakeResponse = { status: number; json(): Promise<unknown> };
type FetchCall = { url: string; init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } };
interface NoteResult { ok: boolean; code?: string; rev?: string | null; text?: string }
interface NoteStateShape { phase: string; base: string; draft: string; rev: string | null; remoteRev: string | null; code: string | null; savedAt: number | null }
interface Deps {
  fetch: (url: string, init: FetchCall["init"]) => Promise<FakeResponse>;
  now: () => number;
  model: Model;
  schedule?: (fn: () => void, ms: number) => () => void;
  copy?: (text: string) => void;
  onTextChange?: (id: string, data: { text: string; style: string }) => void;
  onDrawingChange?: (id: string, scene: drawingLib.DrawingScene) => void;
  onRemove?: (id: string) => void;
  band?: { doc(): CanvasDoc | undefined; live(): bands.BandLive; focus(id: string): void };
  timeoutMs?: number;
}
interface TypeDef { type: string; label: string; icon: string; defaultSize: { w: number; h: number }; draw: { surface: string; render(input: unknown): unknown }; menu: string[]; actions: string[]; live: boolean }
interface Api {
  registerUserTypes(types: ReturnType<typeof createNodeTypeRegistry>, deps: Partial<Deps>): TypeDef[];
  userTypeDefs(deps: Partial<Deps>): TypeDef[];
  createNoteClient(deps: Deps, model: Model): { load(name: string): Promise<NoteResult>; save(name: string, text: string, rev: string | null): Promise<NoteResult> };
  noteReducer(state: NoteStateShape, action: unknown): NoteStateShape;
  NOTE_INITIAL: NoteStateShape;
  NoteBody(props: { name: string; agent?: string; client: unknown; model: Model; now: () => number }): unknown;
  decideText(model: Model, previous: { text: string; style: string }, draft: string): { kind: string; code?: string; data?: unknown };
  TextBody(props: { id: string; data: Record<string, unknown>; model: Model; deps: Deps }): unknown;
  drawPrimitives(model: Model, node: { id: string; type: string; w: number; h: number; data: Record<string, unknown> }): { tag: string; attrs: Record<string, string | number> }[];
  renderDraw(model: Model, input: unknown): Tree;
  unitSketchView(model: Model, node: { id: string; type: string; data: Record<string, unknown> }): { ok: boolean; code?: string; text?: string; title?: string };
  renderUnitSketch(model: Model, deps: Deps, input: unknown): Tree;
  bandView(model: Model, source: Deps["band"], data: Record<string, unknown>): { ok: boolean; code?: string; status?: bands.BandStatus };
  BandBody(props: { data: Record<string, unknown>; model: Model; source: Deps["band"] }): unknown;
  MENU: Record<string, string>;
}

const g = globalThis as unknown as Record<string, unknown>;
const model: Model = { note, draw, create, bands };
let Api: Api;

// ---------- React mínimo: estado por posição, efeitos com limpeza, ref e callback ----------
const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Tree => ({ type, props: props ?? {}, children });

function mount<P>(component: (props: P) => unknown, initial: P) {
  let props = initial;
  const slots: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const effects: { deps?: readonly unknown[]; cleanup?: void | (() => void) }[] = [];
  const callbacks: { deps: readonly unknown[]; fn: unknown }[] = [];
  let tree: unknown = null;
  let dirty = false;
  let cursor = 0;
  let refCursor = 0;
  let effectCursor = 0;
  let callbackCursor = 0;
  const pending: (() => void)[] = [];
  const sameDeps = (a?: readonly unknown[], b?: readonly unknown[]): boolean => !!a && !!b && a.length === b.length && a.every((d, n) => Object.is(d, b[n]));
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
    useRef: (init: unknown) => (refs[refCursor] ??= { current: init }, refs[refCursor++] as { current: unknown }),
    useCallback: (fn: unknown, deps: readonly unknown[]) => {
      const i = callbackCursor++;
      if (!callbacks[i] || !sameDeps(callbacks[i]?.deps, deps)) callbacks[i] = { deps, fn };
      return callbacks[i]?.fn;
    },
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const i = effectCursor++;
      const prev = effects[i];
      if (prev && sameDeps(prev.deps, deps)) return;
      pending.push(() => {
        if (typeof prev?.cleanup === "function") prev.cleanup();
        effects[i] = { deps, cleanup: fn() };
      });
    },
  };
  const render = (): void => {
    cursor = 0; refCursor = 0; effectCursor = 0; callbackCursor = 0;
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
    get tree(): Tree { return tree as Tree; },
    settle,
    unmount(): void { for (const e of effects) if (typeof e?.cleanup === "function") e.cleanup(); },
  };
}

/** Deixa as promessas (a resposta do fetch falso) correrem e relê a árvore. */
const flush = async (view: { settle(): void }): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.settle();
};

const walk = (tree: unknown, visit: (el: Tree) => void): void => {
  if (typeof tree !== "object" || tree === null) return;
  const el = tree as Tree;
  if (!("children" in el)) return;
  visit(el);
  for (const child of el.children) walk(child, visit);
};
const findAll = (tree: unknown, match: (el: Tree) => boolean): Tree[] => {
  const hits: Tree[] = [];
  walk(tree, (el) => { if (match(el)) hits.push(el); });
  return hits;
};
const textOf = (tree: unknown): string => {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (typeof tree !== "object" || tree === null) return "";
  return (tree as Tree).children.map(textOf).join("");
};
const buttonWith = (tree: unknown, label: string): Tree => {
  const hit = findAll(tree, (el) => el.type === "button" && textOf(el).includes(label))[0];
  if (!hit) throw new Error(`sem botão "${label}"`);
  return hit;
};
const press = (el: Tree): void => (el.props.onClick as () => void)();
const typeInto = (el: Tree, value: string): void => (el.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const textarea = (tree: unknown): Tree => findAll(tree, (el) => el.type === "textarea")[0] as Tree;

// ---------- fetch falso ----------
const reply = (status: number, body: unknown): FakeResponse => ({ status, json: async () => body });
function fakeFetch(handler: (call: FetchCall) => FakeResponse | Promise<FakeResponse>) {
  const calls: FetchCall[] = [];
  const fn = (url: string, init: FetchCall["init"]): Promise<FakeResponse> => {
    calls.push({ url, init });
    return Promise.resolve(handler({ url, init }));
  };
  return { fn, calls };
}
const deps = (over: Partial<Deps> = {}): Deps => ({ fetch: fakeFetch(() => reply(404, { code: "note_not_found" })).fn, now: () => 1_000, model, ...over });

beforeAll(async () => {
  // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
  await import("../../../kit/panel/ui/argos/types-user.tsx");
  Api = g.ArgosTypesUser as Api;
});
afterAll(() => {
  delete g.React;
  delete g.ArgosTypesUser;
});

// ---------- registro ----------
describe("registro dos tipos do usuário", () => {
  const EXPECTED = ["note", "text", "draw-rect", "draw-ellipse", "draw-arrow", "draw-stroke", "unit-sketch", "area", "band"];

  test("dado o registro vazio, então registra os tipos do usuário como HTML, não vivos e sem ação de servidor", () => {
    const registry = createNodeTypeRegistry();
    const defs = Api.registerUserTypes(registry, deps());
    expect(defs.map((d) => d.type)).toEqual(EXPECTED);
    for (const def of defs) {
      expect(def.live).toBe(false);
      expect(def.draw.surface).toBe(def.type === "area" ? "canvas" : "html");
      expect(def.actions).toEqual([]);
      expect(registry.has(def.type)).toBe(true);
    }
  });

  test("dado o tamanho padrão da nota, então é o mesmo de createNoteNode", () => {
    const registry = createNodeTypeRegistry();
    Api.registerUserTypes(registry, deps());
    const created = note.createNoteNode(validateCanvasDoc({ v: 1, rev: 1, nodes: [], edges: [], groups: [] }), { id: "n", x: 0, y: 0, note: "nota-abc123" });
    expect(registry.sizeOf("note")).toEqual({ w: created.node.w, h: created.node.h });
  });

  test("dado registro já com um dos tipos, então pula o repetido sem lançar e registra o resto", () => {
    const registry = createNodeTypeRegistry();
    Api.registerUserTypes(registry, deps());
    expect(Api.registerUserTypes(registry, deps())).toEqual([]);
    const partial = createNodeTypeRegistry();
    partial.register(Api.userTypeDefs(deps())[0] as TypeDef as never);
    expect(Api.registerUserTypes(partial, deps()).map((d) => d.type)).toEqual(EXPECTED.slice(1));
  });

  test("dado deps sem os modelos, então falha na hora do registro", () => {
    expect(() => Api.registerUserTypes(createNodeTypeRegistry(), { ...deps(), model: undefined })).toThrow("note, draw, create e bands");
    expect(() => Api.registerUserTypes(createNodeTypeRegistry(), { ...deps(), model: { note } as unknown as Model })).toThrow("note, draw, create e bands");
  });

  test("dado o menu de cada tipo, então só cita ids de comando conhecidos e sem repetir", () => {
    const known = new Set(Object.values(Api.MENU));
    for (const def of Api.userTypeDefs(deps())) {
      expect(def.menu.every((id) => known.has(id))).toBe(true);
      expect(new Set(def.menu).size).toBe(def.menu.length);
    }
  });

  test("dado tipo vivo declarado como do usuário, então o registro recusa (a marca vale)", () => {
    const registry = createNodeTypeRegistry();
    const [first] = Api.userTypeDefs(deps()) as [TypeDef];
    expect(() => registry.register({ ...first, type: "agent" } as never)).toThrow(RegistryError);
  });
});

// ---------- cliente da rota das notas ----------
describe("cliente da rota das notas", () => {
  const client = (d: Deps) => Api.createNoteClient(d, model);

  test("dado nota existente, então lê texto e revisão pela rota certa", async () => {
    const f = fakeFetch(() => reply(200, { name: "nota-a", text: "oi", rev: "abc", updatedAt: "2026-01-01T00:00:00.000Z" }));
    expect(await client(deps({ fetch: f.fn })).load("nota-a")).toEqual({ ok: true, text: "oi", rev: "abc" });
    expect(f.calls[0]).toMatchObject({ url: "/api/canvas-notes/nota-a", init: { method: "GET" } });
  });

  test("dado nome fora da lista fechada, então recusa sem chamar a rede", async () => {
    const f = fakeFetch(() => reply(200, {}));
    const c = client(deps({ fetch: f.fn }));
    for (const name of ["../x", "a/b", ".md", "", "a".repeat(65)]) {
      expect(await c.load(name)).toEqual({ ok: false, code: "note_invalid_name" });
      expect(await c.save(name, "x", null)).toEqual({ ok: false, code: "note_invalid_name" });
    }
    expect(f.calls).toHaveLength(0);
  });

  test("dado nota sem arquivo, então devolve o código note_not_found", async () => {
    expect(await client(deps()).load("nota-a")).toEqual({ ok: false, code: "note_not_found" });
  });

  test("dado gravação, então envia JSON com texto e revisão lida e devolve a nova", async () => {
    const f = fakeFetch(() => reply(200, { ok: true, name: "nota-a", rev: "r2", bytes: 2 }));
    expect(await client(deps({ fetch: f.fn })).save("nota-a", "oi", "r1")).toEqual({ ok: true, rev: "r2" });
    expect(f.calls[0]?.init.method).toBe("PUT");
    expect(f.calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(f.calls[0]?.init.body ?? "")).toEqual({ text: "oi", rev: "r1" });
  });

  test("dado revisão velha, então devolve o conflito com a revisão atual do servidor", async () => {
    const f = fakeFetch(() => reply(409, { error: "x", code: "note_stale_revision", rev: "atual" }));
    expect(await client(deps({ fetch: f.fn })).save("nota-a", "oi", "velha")).toEqual({ ok: false, code: "note_stale_revision", rev: "atual" });
    const nulo = fakeFetch(() => reply(409, { code: "note_stale_revision", rev: null }));
    expect(await client(deps({ fetch: nulo.fn })).save("nota-a", "oi", "velha")).toEqual({ ok: false, code: "note_stale_revision", rev: null });
  });

  test("dado o teto de 262144 bytes, então 262144 vai e 262145 é recusado antes da rede (conta bytes, não caracteres)", async () => {
    const f = fakeFetch(() => reply(200, { rev: "r" }));
    const c = client(deps({ fetch: f.fn }));
    expect((await c.save("nota-a", "a".repeat(262_144), null)).ok).toBe(true);
    expect(await c.save("nota-a", "a".repeat(262_145), null)).toEqual({ ok: false, code: "note_too_large" });
    expect(await c.save("nota-a", "é".repeat(131_073), null)).toEqual({ ok: false, code: "note_too_large" });
    expect(f.calls).toHaveLength(1);
  });

  test("dado falha de rede, resposta que não é JSON ou fora do contrato, então vira código e nunca rejeita", async () => {
    const boom = client(deps({ fetch: () => Promise.reject(new Error("rede")) }));
    expect(await boom.load("nota-a")).toEqual({ ok: false, code: "note_network" });
    const notJson = client(deps({ fetch: () => Promise.resolve({ status: 200, json: () => Promise.reject(new Error("x")) }) }));
    expect(await notJson.load("nota-a")).toEqual({ ok: false, code: "note_network" });
    const array = client(deps({ fetch: fakeFetch(() => reply(200, [])).fn }));
    expect(await array.load("nota-a")).toEqual({ ok: false, code: "note_bad_response" });
    const noRev = client(deps({ fetch: fakeFetch(() => reply(200, { ok: true })).fn }));
    expect(await noRev.save("nota-a", "x", null)).toEqual({ ok: false, code: "note_bad_response" });
    const server = client(deps({ fetch: fakeFetch(() => reply(500, { code: "note_unreadable" })).fn }));
    expect(await server.load("nota-a")).toEqual({ ok: false, code: "note_unreadable" });
  });

  test("dado painel que não responde, então o agendador aborta a chamada e o código é note_timeout; o timer é cancelado ao fim", async () => {
    let fire: (() => void) | undefined;
    let cancelled = 0;
    const schedule = (fn: () => void, ms: number): (() => void) => {
      expect(ms).toBe(5);
      fire = fn;
      return () => { cancelled += 1; };
    };
    const hang = (_url: string, init: FetchCall["init"]): Promise<FakeResponse> => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("abortado")));
    });
    const pending = client(deps({ fetch: hang, schedule, timeoutMs: 5 })).load("nota-a");
    fire?.();
    expect(await pending).toEqual({ ok: false, code: "note_timeout" });
    expect(cancelled).toBe(1);
    const ok = client(deps({ fetch: fakeFetch(() => reply(200, { text: "", rev: "r" })).fn, schedule, timeoutMs: 5 }));
    await ok.load("nota-a");
    expect(cancelled).toBe(2);
  });
});

// ---------- estado do editor ----------
describe("estado do editor da nota", () => {
  const ready = (over: Partial<NoteStateShape> = {}): NoteStateShape => ({ ...Api.NOTE_INITIAL, phase: "ready", base: "a", draft: "a", rev: "r1", ...over });

  test("dado leitura ok, então abre pronta com o texto e a revisão", () => {
    expect(Api.noteReducer(Api.NOTE_INITIAL, { type: "loaded", result: { ok: true, text: "oi", rev: "r1" } })).toMatchObject({ phase: "ready", base: "oi", draft: "oi", rev: "r1" });
  });

  test("dado nota sem arquivo, então abre vazia com revisão nula (gravar cria)", () => {
    expect(Api.noteReducer(Api.NOTE_INITIAL, { type: "loaded", result: { ok: false, code: "note_not_found" } })).toMatchObject({ phase: "ready", draft: "", rev: null });
  });

  test("dado outra falha de leitura, então fica em failed com o código e não vira nota vazia", () => {
    expect(Api.noteReducer(Api.NOTE_INITIAL, { type: "loaded", result: { ok: false, code: "note_unreadable" } })).toMatchObject({ phase: "failed", code: "note_unreadable" });
  });

  test("dado gravação ok, então a base passa a ser o texto enviado, mesmo que o rascunho tenha seguido mudando", () => {
    let s = Api.noteReducer(ready(), { type: "edit", draft: "b" });
    s = Api.noteReducer(s, { type: "save" });
    expect(s).toMatchObject({ phase: "saving", sent: "b" });
    s = Api.noteReducer(s, { type: "edit", draft: "c" });
    expect(s.draft).toBe("b");
    s = Api.noteReducer(s, { type: "saved", result: { ok: true, rev: "r2" }, now: 7 });
    expect(s).toMatchObject({ phase: "ready", base: "b", rev: "r2", savedAt: 7, code: null });
  });

  test("dado revisão velha, então vai a conflito guardando a revisão do servidor e o rascunho intacto", () => {
    let s = Api.noteReducer(ready({ draft: "meu" }), { type: "save" });
    s = Api.noteReducer(s, { type: "saved", result: { ok: false, code: "note_stale_revision", rev: "r9" }, now: 7 });
    expect(s).toMatchObject({ phase: "conflict", remoteRev: "r9", draft: "meu", code: "note_stale_revision" });
  });

  test("dado erro de gravação que não é conflito, então volta a pronta com o código e sem perder o rascunho", () => {
    let s = Api.noteReducer(ready({ draft: "meu" }), { type: "save" });
    s = Api.noteReducer(s, { type: "saved", result: { ok: false, code: "note_network" }, now: 7 });
    expect(s).toMatchObject({ phase: "ready", draft: "meu", code: "note_network", base: "a" });
  });

  test("dado resposta de gravação fora de uma gravação em voo, então é ignorada", () => {
    const s = ready();
    expect(Api.noteReducer(s, { type: "saved", result: { ok: true, rev: "x" }, now: 1 })).toBe(s);
  });

  test("dado edição durante o carregamento ou a gravação, então não muda o rascunho", () => {
    expect(Api.noteReducer(Api.NOTE_INITIAL, { type: "edit", draft: "x" })).toBe(Api.NOTE_INITIAL);
  });
});

// ---------- componente da nota ----------
describe("nota no canvas", () => {
  const mountNote = (d: Deps, agent?: string) => {
    const c = Api.createNoteClient(d, model);
    return mount(Api.NoteBody as (p: unknown) => unknown, { name: "nota-a", agent, client: c, model, now: d.now });
  };
  const router = (store: { text: string; rev: string }) => fakeFetch(({ init }) => {
    if (init.method === "GET") return reply(200, { name: "nota-a", text: store.text, rev: store.rev });
    const body = JSON.parse(init.body ?? "{}") as { text: string; rev: string | null };
    if (body.rev !== store.rev) return reply(409, { code: "note_stale_revision", rev: store.rev });
    store.text = body.text;
    store.rev = `${store.rev}+`;
    return reply(200, { ok: true, rev: store.rev });
  });

  test("dado nota aberta, então lê pela rota, edita e grava com a revisão lida", async () => {
    const store = { text: "um", rev: "r1" };
    const f = router(store);
    const view = mountNote(deps({ fetch: f.fn }));
    expect(textOf(view.tree)).toContain("Carregando");
    await flush(view);
    expect(textarea(view.tree).props.value).toBe("um");
    expect(buttonWith(view.tree, "Gravar").props.disabled).toBe(true);
    typeInto(textarea(view.tree), "dois");
    view.settle();
    expect(textOf(view.tree)).toContain("Alterações não gravadas");
    press(buttonWith(view.tree, "Gravar"));
    view.settle();
    expect(textarea(view.tree).props.disabled).toBe(true);
    await flush(view);
    expect(store).toEqual({ text: "dois", rev: "r1+" });
    expect(textOf(view.tree)).toContain("Gravada");
    expect(buttonWith(view.tree, "Gravar").props.disabled).toBe(true);
    view.unmount();
  });

  test("dado outra gravação no meio, então mostra o conflito ao dono e oferece gravar por cima ou recarregar", async () => {
    const store = { text: "um", rev: "r1" };
    const f = router(store);
    const view = mountNote(deps({ fetch: f.fn }));
    await flush(view);
    typeInto(textarea(view.tree), "meu");
    view.settle();
    store.text = "de outro"; // alguém grava por fora depois da leitura
    store.rev = "r7";
    press(buttonWith(view.tree, "Gravar"));
    view.settle();
    await flush(view);
    const alert = findAll(view.tree, (el) => el.props.role === "alert")[0] as Tree;
    expect(textOf(alert)).toContain("note_stale_revision");
    expect(store.text).toBe("de outro");
    expect(textarea(view.tree).props.value).toBe("meu");
    press(buttonWith(view.tree, "Gravar o meu por cima"));
    view.settle();
    await flush(view);
    expect(store).toEqual({ text: "meu", rev: "r7+" });
    expect(findAll(view.tree, (el) => el.props.role === "alert")).toHaveLength(0);
    view.unmount();
  });

  test("dado conflito, então recarregar descarta o rascunho e traz o texto do servidor", async () => {
    const store = { text: "um", rev: "r1" };
    const view = mountNote(deps({ fetch: router(store).fn }));
    await flush(view);
    typeInto(textarea(view.tree), "meu");
    store.text = "de outro";
    store.rev = "r7";
    view.settle();
    press(buttonWith(view.tree, "Gravar"));
    view.settle();
    await flush(view);
    press(buttonWith(view.tree, "Recarregar"));
    view.settle();
    await flush(view);
    expect(textarea(view.tree).props.value).toBe("de outro");
    view.unmount();
  });

  test("dado nota sem arquivo, então abre vazia e grava com revisão nula", async () => {
    const f = fakeFetch(({ init }) => (init.method === "GET" ? reply(404, { code: "note_not_found" }) : reply(200, { ok: true, rev: "novo" })));
    const view = mountNote(deps({ fetch: f.fn }));
    await flush(view);
    typeInto(textarea(view.tree), "primeira");
    view.settle();
    press(buttonWith(view.tree, "Gravar"));
    view.settle();
    await flush(view);
    expect(JSON.parse(f.calls[1]?.init.body ?? "")).toEqual({ text: "primeira", rev: null });
    view.unmount();
  });

  test("dado texto acima do teto, então o botão fica desligado e o motivo aparece", async () => {
    const view = mountNote(deps({ fetch: router({ text: "", rev: "r1" }).fn }));
    await flush(view);
    typeInto(textarea(view.tree), "a".repeat(262_145));
    view.settle();
    expect(buttonWith(view.tree, "Gravar").props.disabled).toBe(true);
    expect(textOf(view.tree)).toContain("256 KiB");
    view.unmount();
  });

  test("dado falha de leitura, então mostra o erro com o botão de tentar de novo", async () => {
    let fail = true;
    const f = fakeFetch(() => (fail ? reply(500, { code: "note_unreadable" }) : reply(200, { text: "ok", rev: "r" })));
    const view = mountNote(deps({ fetch: f.fn }));
    await flush(view);
    expect(textOf(view.tree)).toContain("note_unreadable");
    fail = false;
    press(buttonWith(view.tree, "Tentar de novo"));
    view.settle();
    await flush(view);
    expect(textarea(view.tree).props.value).toBe("ok");
    view.unmount();
  });

  test("dado componente desmontado antes da resposta, então a resposta tardia é descartada sem erro", async () => {
    let release: (() => void) | undefined;
    const slow = (): Promise<FakeResponse> => new Promise((resolve) => { release = () => resolve(reply(200, { text: "tarde", rev: "r" })); });
    const view = mountNote(deps({ fetch: slow }));
    view.unmount();
    release?.();
    await flush(view);
    expect(textOf(view.tree)).toContain("Carregando");
  });

  test("dado agente ligado, então o cabeçalho mostra o arquivo e o agente", async () => {
    const view = mountNote(deps({ fetch: router({ text: "", rev: "r" }).fn }), "agent:p:a");
    await flush(view);
    expect(textOf(view.tree)).toContain("nota-a.md");
    expect(textOf(view.tree)).toContain("agente: agent:p:a");
    view.unmount();
  });

  test("dado nó criado pelo modelo e depois desfeito, então o render lê o nó e o desfazer o tira (ida e volta)", () => {
    const empty = validateCanvasDoc({ v: 1, rev: 1, nodes: [], edges: [], groups: [] });
    const { op, node } = note.createNoteNode(empty, { id: "n1", x: 1, y: 2, note: "nota-abc123" });
    const [def] = Api.userTypeDefs(deps()) as [TypeDef];
    const tree = def.draw.render({ id: node.id, type: node.type, w: node.w, h: node.h, selected: false, data: node.data, live: undefined }) as Tree;
    expect(tree.props.name).toBe("nota-abc123");
    const history = createHistory();
    const done = perform(history, empty, op);
    expect(done.doc.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(undo(done.history, done.doc)?.doc).toEqual(empty);
  });

  test("dado data inválido no documento, então o render mostra aviso em vez de lançar", () => {
    const [def] = Api.userTypeDefs(deps()) as [TypeDef];
    const tree = def.draw.render({ id: "n", type: "note", w: 10, h: 10, selected: false, data: { note: "../x" }, live: undefined }) as Tree;
    expect(textOf(tree)).toContain("Nota inválida");
  });
});

// ---------- texto livre ----------
describe("texto livre", () => {
  const prev = { text: "oi", style: "label" };

  test("dado rascunho vazio ou só espaço, então pede para apagar o nó", () => {
    expect(Api.decideText(model, prev, "").kind).toBe("remove");
    expect(Api.decideText(model, prev, " \n ").kind).toBe("remove");
  });

  test("dado o mesmo texto, então não muda nada", () => {
    expect(Api.decideText(model, prev, "oi").kind).toBe("unchanged");
  });

  test("dado texto novo, então atualiza mantendo o estilo", () => {
    expect(Api.decideText(model, { text: "oi", style: "title" }, "tchau")).toEqual({ kind: "update", data: { text: "tchau", style: "title" } });
  });

  test("dado 2000 caracteres, então aceita; 2001, então recusa com note_too_large", () => {
    expect(Api.decideText(model, prev, "a".repeat(2000)).kind).toBe("update");
    expect(Api.decideText(model, prev, "a".repeat(2001))).toEqual({ kind: "invalid", code: "note_too_large" });
  });

  const mountText = (d: Deps, data: Record<string, unknown> = { text: "oi", style: "label" }) => mount(Api.TextBody as (p: unknown) => unknown, { id: "t1", data, model, deps: d });

  test("dado host sem onTextChange, então o texto é só de leitura", () => {
    const view = mountText(deps());
    expect(view.tree.props.role).toBeUndefined();
    (view.tree.props.onDoubleClick as () => void)();
    view.settle();
    expect(findAll(view.tree, (el) => el.type === "textarea")).toHaveLength(0);
  });

  test("dado duplo clique, edição e Ctrl+Enter, então entrega o novo data ao host", () => {
    const changes: unknown[] = [];
    const view = mountText(deps({ onTextChange: (id, data) => changes.push([id, data]) }));
    (view.tree.props.onDoubleClick as () => void)();
    view.settle();
    typeInto(textarea(view.tree), "novo");
    view.settle();
    (textarea(view.tree).props.onKeyDown as (e: { key: string; ctrlKey: boolean }) => void)({ key: "Enter", ctrlKey: true });
    view.settle();
    expect(changes).toEqual([["t1", { text: "novo", style: "label" }]]);
    expect(findAll(view.tree, (el) => el.type === "textarea")).toHaveLength(0);
  });

  test("dado Esc, então cancela sem avisar o host", () => {
    const changes: unknown[] = [];
    const view = mountText(deps({ onTextChange: () => changes.push(1) }));
    (view.tree.props.onDoubleClick as () => void)();
    view.settle();
    typeInto(textarea(view.tree), "novo");
    view.settle();
    (textarea(view.tree).props.onKeyDown as (e: { key: string }) => void)({ key: "Escape" });
    view.settle();
    expect(changes).toEqual([]);
    expect(textOf(view.tree)).toBe("oi");
  });

  test("dado texto esvaziado, então pede ao host para apagar o nó", () => {
    const removed: string[] = [];
    const view = mountText(deps({ onTextChange: () => undefined, onRemove: (id) => removed.push(id) }));
    (view.tree.props.onDoubleClick as () => void)();
    view.settle();
    typeInto(textarea(view.tree), "");
    view.settle();
    (textarea(view.tree).props.onBlur as () => void)();
    expect(removed).toEqual(["t1"]);
  });

  test("dado texto acima do teto, então fica editando com o erro e não avisa o host", () => {
    const changes: unknown[] = [];
    const view = mountText(deps({ onTextChange: () => changes.push(1) }));
    (view.tree.props.onDoubleClick as () => void)();
    view.settle();
    typeInto(textarea(view.tree), "a".repeat(2001));
    view.settle();
    (textarea(view.tree).props.onBlur as () => void)();
    view.settle();
    expect(changes).toEqual([]);
    expect(textOf(view.tree)).toContain("note_too_large");
  });

  test("dado data corrompido, então mostra aviso em vez de lançar", () => {
    expect(textOf(mountText(deps(), { text: "", style: "x" }).tree)).toContain("Texto inválido");
  });
});

// ---------- desenho ----------
describe("desenho (só exibição)", () => {
  const shape = (type: string, data: Record<string, unknown>, w = 100, h = 50) => ({ id: "d", type, w, h, data });

  test("dado retângulo, então desenha a caixa menos a espessura, com a cor do tema por padrão", () => {
    const [rect] = Api.drawPrimitives(model, shape("draw-rect", { style: { width: 4 } }));
    expect(rect).toMatchObject({ tag: "rect", attrs: { x: 2, y: 2, width: 96, height: 46, stroke: "currentColor", fill: "none", "stroke-width": 4 } });
  });

  test("dado elipse com cores válidas, então usa traço e preenchimento", () => {
    const [ellipse] = Api.drawPrimitives(model, shape("draw-ellipse", { style: { width: 2, stroke: "#f00", fill: "#00ff0080" } }));
    expect(ellipse).toMatchObject({ tag: "ellipse", attrs: { cx: 50, cy: 25, rx: 49, ry: 24, stroke: "#f00", fill: "#00ff0080" } });
  });

  test("dado cor ou espessura inválida, então volta ao padrão em vez de ir ao SVG", () => {
    const [rect] = Api.drawPrimitives(model, shape("draw-rect", { style: { stroke: "red;x", fill: 5, width: 1e9 } }));
    expect(rect?.attrs).toMatchObject({ stroke: "currentColor", fill: "none", "stroke-width": 64 });
    const [thin] = Api.drawPrimitives(model, shape("draw-rect", { style: { width: 0 } }));
    expect(thin?.attrs["stroke-width"]).toBe(0.5);
  });

  test("dado seta, então traça a linha de from a to e a ponta no fim", () => {
    const [line, head] = Api.drawPrimitives(model, shape("draw-arrow", { style: { width: 2 }, from: [0, 0], to: [1, 1] }));
    expect(line).toMatchObject({ tag: "line", attrs: { x1: 0, y1: 0, x2: 100, y2: 50 } });
    expect(head?.tag).toBe("polygon");
    expect(String(head?.attrs.points).startsWith("100,50 ")).toBe(true);
  });

  test("dado traço, então vira uma polilinha com os pontos escalados pela caixa", () => {
    const [stroke] = Api.drawPrimitives(model, shape("draw-stroke", { style: { width: 2 }, points: [[0, 0], [0.5, 1], [1, 0]] }));
    expect(stroke).toMatchObject({ tag: "polyline", attrs: { points: "0,0 50,50 100,0", fill: "none" } });
  });

  test("dado data corrompido (pontos que não são pares, seta sem fim, tipo desconhecido), então não desenha nada", () => {
    expect(Api.drawPrimitives(model, shape("draw-stroke", { points: [[0, "a"]] }))).toEqual([]);
    expect(Api.drawPrimitives(model, shape("draw-stroke", {}))).toEqual([]);
    expect(Api.drawPrimitives(model, shape("draw-arrow", { from: [0, 0] }))).toEqual([]);
    expect(Api.drawPrimitives(model, shape("draw-star", {}))).toEqual([]);
  });

  test("dado desenho criado pelo modelo, então o SVG tem nome acessível e o desfazer volta ao documento anterior", () => {
    const empty = validateCanvasDoc({ v: 1, rev: 1, nodes: [], edges: [], groups: [] });
    const { op, node } = draw.createArrow(empty, "a1", { x: 10, y: 10 }, { x: 110, y: 60 });
    const svg = Api.renderDraw(model, { id: node.id, type: node.type, w: node.w, h: node.h, selected: false, data: node.data, live: undefined });
    expect(svg).toMatchObject({ type: "svg", props: { role: "img", "aria-label": "Seta", viewBox: "0 0 100 50" } });
    expect(svg.children).toHaveLength(2);
    const done = perform(createHistory(), empty, op);
    expect(undo(done.history, done.doc)?.doc).toEqual(empty);
  });
});

// ---------- esboço de unidade ----------
describe("esboço de unidade", () => {
  const sketch = (data: Record<string, unknown>) => ({ id: "u1", type: "unit-sketch", data });

  test("dado esboço de skill válido, então mostra os comandos que o dono roda", () => {
    const view = Api.unitSketchView(model, sketch({ kind: "skill", name: "minha-un", port: 21277 }));
    expect(view.ok).toBe(true);
    expect(view.text).toBe("hades agent skill-new 'minha-un' --role 'impl' --port '21277'\nhades agent start-cmd 'minha-un'");
    expect(view.title).toBe("Unidade de skill: minha-un");
  });

  test("dado esboço sem nome, com nome inválido ou com campo que não cabe, então devolve o código do modelo", () => {
    expect(Api.unitSketchView(model, sketch({ kind: "skill" }))).toMatchObject({ ok: false, code: "create_missing_field" });
    expect(Api.unitSketchView(model, sketch({ kind: "skill", name: "Nome Ruim" }))).toMatchObject({ ok: false, code: "create_invalid_name" });
    expect(Api.unitSketchView(model, sketch({ kind: "skill", name: "ok", branch: "x" }))).toMatchObject({ ok: false, code: "create_invalid_field" });
  });

  test("dado nome com aspas e metacaracteres de shell, então sai recusado e nunca no texto", () => {
    expect(Api.unitSketchView(model, sketch({ kind: "skill", name: "a'; rm -rf /" })).ok).toBe(false);
  });

  test("dado o botão de copiar, então entrega o texto dos comandos; sem host de cópia o botão não existe", () => {
    const copied: string[] = [];
    const input = { id: "u1", type: "unit-sketch", w: 1, h: 1, selected: false, data: { kind: "skill", name: "x" }, live: undefined };
    const withCopy = Api.renderUnitSketch(model, deps({ copy: (t) => copied.push(t) }), input);
    press(buttonWith(withCopy, "Copiar comandos"));
    expect(copied).toEqual(["hades agent skill-new 'x' --role 'impl'\nhades agent start-cmd 'x'"]);
    expect(findAll(Api.renderUnitSketch(model, deps(), input), (el) => el.type === "button")).toHaveLength(0);
  });

  test("dado esboço inválido, então o nó mostra o aviso com o código", () => {
    const tree = Api.renderUnitSketch(model, deps(), { id: "u1", type: "unit-sketch", w: 1, h: 1, selected: false, data: {}, live: undefined });
    expect(textOf(tree)).toContain("create_missing_field");
  });
});

// ---------- banda ----------
describe("banda", () => {
  const n = (id: string, type = "note"): CanvasNode => ({ id, type, x: 0, y: 0, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false });
  const doc = validateCanvasDoc({
    v: 1, rev: 1, nodes: [n("agent:r:a1", "agent"), n("agent:r:a2", "agent"), n("agent:r:a3", "agent"), n("n1")], edges: [],
    groups: [{ id: "g1", label: "Equipe", members: ["agent:r:a1", "agent:r:a2", "agent:r:a3"] }],
  });
  const live: bands.BandLive = new Map([
    ["agent:r:a1", { state: "idle", waitingOwner: false }],
    ["agent:r:a2", { state: "working", waitingOwner: false }],
    ["agent:r:a3", { state: "working", waitingOwner: true }],
  ]);
  const source = (focused: string[] = [], current: CanvasDoc | null = doc): NonNullable<Deps["band"]> => ({ doc: () => current ?? undefined, live: () => live, focus: (id) => focused.push(id) });

  test("dado a banda do documento, então a lista põe quem espera o dono primeiro", () => {
    const view = Api.bandView(model, source(), { group: "g1" });
    expect(view.status?.members.map((m) => m.id)).toEqual(["agent:r:a3", "agent:r:a2", "agent:r:a1"]);
  });

  test("dado grupo que não existe, que não é banda, sem id ou sem fonte, então devolve o código", () => {
    expect(Api.bandView(model, source(), { group: "nada" })).toMatchObject({ ok: false, code: "org_unknown_group" });
    expect(Api.bandView(model, source(), {})).toMatchObject({ ok: false, code: "band_invalid_data" });
    expect(Api.bandView(model, source(), { group: "" })).toMatchObject({ ok: false, code: "band_invalid_data" });
    expect(Api.bandView(model, undefined, { group: "g1" })).toMatchObject({ ok: false, code: "band_no_source" });
    expect(Api.bandView(model, source([], null), { group: "g1" })).toMatchObject({ ok: false, code: "band_no_source" });
  });

  test("dado cliques em Próximo e Anterior, então leva o foco de agente em agente, dando a volta", () => {
    const focused: string[] = [];
    const view = mount(Api.BandBody as (p: unknown) => unknown, { data: { group: "g1" }, model, source: source(focused) });
    press(buttonWith(view.tree, "Próximo"));
    view.settle();
    press(buttonWith(view.tree, "Próximo"));
    view.settle();
    press(buttonWith(view.tree, "Anterior"));
    view.settle();
    press(buttonWith(view.tree, "Anterior"));
    view.settle();
    press(buttonWith(view.tree, "Anterior"));
    expect(focused).toEqual(["agent:r:a3", "agent:r:a2", "agent:r:a3", "agent:r:a1", "agent:r:a2"]);
  });

  test("dado agente na lista, então o estado vem em palavra (não só cor) e clicar nele leva o foco", () => {
    const focused: string[] = [];
    const view = mount(Api.BandBody as (p: unknown) => unknown, { data: { group: "g1" }, model, source: source(focused) });
    const first = findAll(view.tree, (el) => el.type === "button" && textOf(el).includes("agent:r:a3"))[0] as Tree;
    expect(textOf(first)).toContain("espera por você");
    press(first);
    expect(focused).toEqual(["agent:r:a3"]);
    expect(textOf(view.tree)).toContain("1 esperam você · 1 trabalham");
  });

  test("dado banda inválida no documento, então o nó mostra o aviso com o código", () => {
    const view = mount(Api.BandBody as (p: unknown) => unknown, { data: { group: "nada" }, model, source: source() });
    expect(textOf(view.tree)).toContain("org_unknown_group");
  });
});

// ---------- desenho (nó `drawing`) ----------
describe("desenho no motor", () => {
  const drawingModel: Model & { drawing: typeof drawingLib } = { note, draw, create, bands, drawing: drawingLib };
  const scene = { v: 1, title: "Fluxo", elements: [{ id: "a", type: "rect", x: 0, y: 0, w: 80, h: 40 }] };
  const input = { id: "d1", type: "drawing", x: 0, y: 0, w: 480, h: 320, data: scene };
  const defOf = (m: Model) => Api.userTypeDefs({ ...deps(), model: m }).find((d) => d.type === "drawing");
  const mountDrawing = (data: unknown = scene) => {
    const def = defOf(drawingModel);
    const tree = (def as TypeDef).draw.render({ ...input, data }) as Tree;
    return mount(tree.type as (p: unknown) => unknown, tree.props);
  };
  const svgOf = (tree: unknown): Tree => findAll(tree, (el) => el.type === "svg")[0] as Tree;
  const toolbar = (tree: unknown): Tree[] => findAll(tree, (el) => el.props.role === "toolbar");
  const key = (name: string, target: unknown = {}) => ({ key: name, preventDefault() {}, stopPropagation() {}, target });
  const down = { clientX: 0, clientY: 0, button: 0, pointerId: 1, currentTarget: {}, stopPropagation() {} };
  const withChange = (calls: { id: string; scene: drawingLib.DrawingScene }[]) => ({ ...deps(), model: drawingModel, onDrawingChange: (id: string, next: drawingLib.DrawingScene) => calls.push({ id, scene: next }) });
  const mountEditable = (calls: { id: string; scene: drawingLib.DrawingScene }[]) => {
    const def = Api.userTypeDefs(withChange(calls)).find((d) => d.type === "drawing") as TypeDef;
    const tree = def.draw.render(input) as Tree;
    return mount(tree.type as (p: unknown) => unknown, tree.props);
  };
  const enter = (view: ReturnType<typeof mountEditable>) => {
    (view.tree.props.onKeyDown as (e: unknown) => void)(key("Enter"));
    view.settle();
  };

  test("dado modelo sem `drawing`, então o tipo não é registrado; com modelo, entra depois da Área", () => {
    expect(defOf(model)).toBeUndefined();
    const types = Api.userTypeDefs({ ...deps(), model: drawingModel }).map((d) => d.type);
    expect(types.indexOf("drawing")).toBeGreaterThan(types.indexOf("area"));
  });

  test("dado desenho fora de edição, então mostra as formas sem barra de ferramentas", () => {
    const view = mountDrawing();
    expect(toolbar(view.tree)).toHaveLength(0);
    expect(findAll(view.tree, (el) => el.type === "rect")).not.toHaveLength(0);
  });

  test("dado dado inválido (versão desconhecida), então avisa em vez de desenhar", () => {
    const view = mountDrawing({ v: 99, elements: [] });
    expect(textOf(view.tree)).toContain("Desenho inválido");
  });

  test("dado host sem onDrawingChange, então Enter não abre a edição (somente leitura)", () => {
    const view = mountDrawing();
    (view.tree.props.onKeyDown as (e: unknown) => void)(key("Enter"));
    view.settle();
    expect(toolbar(view.tree)).toHaveLength(0);
  });

  test("dado Enter e depois Esc, então a barra aparece e some", () => {
    const view = mountEditable([]);
    enter(view);
    expect(toolbar(view.tree)).toHaveLength(1);
    (view.tree.props.onKeyDown as (e: unknown) => void)(key("Escape"));
    view.settle();
    expect(toolbar(view.tree)).toHaveLength(0);
  });

  test("dada a ferramenta Texto, então o texto digitado vira um elemento e sai um passo de edição", () => {
    const calls: { id: string; scene: drawingLib.DrawingScene }[] = [];
    const view = mountEditable(calls);
    enter(view);
    press(buttonWith(view.tree, "Texto"));
    view.settle();
    (svgOf(view.tree).props.onPointerDown as (e: unknown) => void)(down);
    view.settle();
    const field = findAll(view.tree, (el) => el.type === "input")[0] as Tree;
    typeInto(field, "fila");
    view.settle();
    ((findAll(view.tree, (el) => el.type === "input")[0] as Tree).props.onKeyDown as (e: unknown) => void)({ key: "Enter" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe("d1");
    expect(calls[0]?.scene.elements.map((el) => el.type)).toEqual(["rect", "text"]);
  });

  test("dado texto só com espaço, então não grava elemento", () => {
    const calls: { id: string; scene: drawingLib.DrawingScene }[] = [];
    const view = mountEditable(calls);
    enter(view);
    press(buttonWith(view.tree, "Texto"));
    view.settle();
    (svgOf(view.tree).props.onPointerDown as (e: unknown) => void)(down);
    view.settle();
    typeInto(findAll(view.tree, (el) => el.type === "input")[0] as Tree, "   ");
    view.settle();
    ((findAll(view.tree, (el) => el.type === "input")[0] as Tree).props.onKeyDown as (e: unknown) => void)({ key: "Enter" });
    expect(calls).toHaveLength(0);
  });

  test("dado elemento selecionado, então Apagar remove e Delete também", () => {
    const calls: { id: string; scene: drawingLib.DrawingScene }[] = [];
    const view = mountEditable(calls);
    enter(view);
    expect(buttonWith(view.tree, "Apagar").props.disabled).toBe(true);
    (svgOf(view.tree).props.onPointerDown as (e: unknown) => void)(down);
    view.settle();
    expect(buttonWith(view.tree, "Apagar").props.disabled).toBe(false);
    press(buttonWith(view.tree, "Apagar"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.scene.elements).toEqual([]);
  });
});
