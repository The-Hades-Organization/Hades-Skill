// Grupo canvas-menu: menu de contexto do nó e do vazio (kit/panel/ui/argos/canvas-menu.tsx) — os itens (ações do agente e
// comandos do registro), a navegação por teclado, a posição na tela e o ciclo de vida do componente (foco, clique fora,
// ouvinte). O .tsx é um script clássico de navegador: aqui ele roda sobre um React mínimo e um documento de mentira.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as actions from "../../../src/lib/canvas-actions";
import { MENU_ACTIONS, type ActionItem, type ActionNode } from "../../../src/lib/canvas-actions";
import * as commands from "../../../src/lib/canvas-commands";
import { createCommandRegistry, type CommandDef } from "../../../src/lib/canvas-commands";
import type { NodeTypeDef } from "../../../src/lib/canvas-types";

// Os tipos do .tsx não entram aqui (o tsconfig do projeto não tem jsx): este é o contorno do que o teste usa dele.
interface Item { id: string; kind: string; label: string; hint: string; group: string; shortcut?: string; disabled: boolean; reason?: string; dangerous: boolean }
type Move = { type: "move"; index: number } | { type: "activate"; item: Item } | { type: "close" } | { type: "none" };
type Target = { kind: "node"; node: ActionNode; nodeType?: NodeTypeDef } | { kind: "canvas" };
interface MenuApi {
  CanvasMenu: (props: Record<string, unknown>) => unknown;
  menuItems(target: Target, deps: { registry: unknown; commandCtx: unknown; actionCtx?: object }): Item[];
  safeItems(target: Target, deps: { registry: unknown; commandCtx: unknown; actionCtx?: object }): { items: Item[]; error?: string };
  menuKey(items: readonly Item[], active: number, key: string): Move;
  placeMenu(at: { x: number; y: number }, view: { w: number; h: number }, size: { w: number; h: number }): { x: number; y: number };
  menuSize(items: readonly Item[], view: { w: number; h: number }): { w: number; h: number };
  firstEnabled(items: readonly Item[]): number;
  curateCanvasItems(items: readonly Item[], essentials: readonly { id: string; group: string }[], registry: unknown): Item[];
  CANVAS_ESSENTIALS: readonly { id: string; group: string }[];
  EMPTY_LABEL: string;
}
interface El { type: unknown; props: Record<string, unknown>; children: unknown[] }
interface Ctx { ran: string[]; allow: boolean }

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
const rows = (tree: unknown): El[] => flat(tree).filter((e) => e.props.role === "menuitem");
const row = (tree: unknown, label: string): El => rows(tree).find((e) => flat(e).some((x) => text(x) === label)) as El;
const press = (tree: unknown, k: string): { prevented: boolean } => {
  const event = { key: k, prevented: false, preventDefault() { this.prevented = true; } };
  ((tree as El).props.onKeyDown as (e: typeof event) => void)(event);
  return event;
};

let Menu: MenuApi;
beforeAll(async () => {
  g.CanvasModel = { actions, commands };
  // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
  await import("../../../kit/panel/ui/argos/canvas-menu.tsx");
  Menu = g.ArgosCanvasMenu as MenuApi;
});
afterAll(() => {
  delete g.CanvasModel;
  delete g.ArgosCanvasMenu;
  delete g.React;
  delete g.document;
});

const agent = (over: Partial<ActionNode> = {}): ActionNode => ({
  id: "agent:p:a1", type: "agent", label: "a1", state: "working", registryState: "active", herdrState: "working", pendingPermission: null, ...over,
});
const VIEW = { w: 1200, h: 800 };
const AT = { x: 100, y: 100 };

const cmd = (id: string, over: Partial<CommandDef<Ctx>> = {}): CommandDef<Ctx> => ({
  id, label: `Comando ${id}`, group: "Canvas", surfaces: ["node-menu", "canvas-menu"], run: (ctx) => void ctx.ran.push(id), ...over,
});
/** Registro com três comandos: um para o menu do nó e do vazio (com atalho), um só do vazio e um que depende do contexto. */
function registry() {
  const r = createCommandRegistry<Ctx>();
  r.register(cmd("focus", { label: "Focar", shortcut: "mod+k" }));
  r.register(cmd("only-canvas", { surfaces: ["canvas-menu"] }));
  r.register(cmd("when-allowed", { when: (ctx) => ctx.allow }));
  return r;
}
const agentType = (menu: string[]): NodeTypeDef => ({ type: "agent", menu } as unknown as NodeTypeDef);
const ctxOf = (over: Partial<Ctx> = {}): Ctx => ({ ran: [], allow: true, ...over });

describe("canvas-menu: itens", () => {
  test("dado agente, então as ações vêm na ordem do modelo, as que não valem ficam desabilitadas com o motivo", () => {
    const items = Menu.menuItems({ kind: "node", node: agent() }, { registry: registry(), commandCtx: ctxOf() });
    expect(items.map((i) => i.id)).toEqual(MENU_ACTIONS.map((k) => `action:${k}`));
    const approve = items.find((i) => i.id === "action:approve_permission") as Item;
    expect([approve.disabled, approve.reason]).toEqual([true, "não há permissão pendente neste agente"]);
    expect((items.find((i) => i.id === "action:prompt") as Item).disabled).toBe(false);
  });

  test("dado ação destrutiva, então o item sai marcado como perigoso", () => {
    const items = Menu.menuItems({ kind: "node", node: agent() }, { registry: registry(), commandCtx: ctxOf() });
    expect(items.filter((i) => i.dangerous).map((i) => i.id)).toEqual(["action:done", "action:stop_session"]);
  });

  test("dado tipo com menu, então os comandos dele vêm depois das ações, com o atalho escrito para a tela", () => {
    const items = Menu.menuItems({ kind: "node", node: agent(), nodeType: agentType(["focus"]) }, { registry: registry(), commandCtx: ctxOf() });
    const last = items[items.length - 1] as Item;
    expect([last.id, last.kind, last.label, last.shortcut, last.group]).toEqual(["command:focus", "command", "Focar", "Ctrl+K", "Canvas"]);
  });

  test("dado comando cuja condição não vale agora, então ele nem aparece", () => {
    const deps = (allow: boolean) => ({ registry: registry(), commandCtx: ctxOf({ allow }) });
    const target: Target = { kind: "node", node: agent(), nodeType: agentType(["when-allowed"]) };
    expect(Menu.menuItems(target, deps(true)).some((i) => i.id === "command:when-allowed")).toBe(true);
    expect(Menu.menuItems(target, deps(false)).some((i) => i.id === "command:when-allowed")).toBe(false);
  });

  test("dado o vazio do canvas, então só os comandos da superfície canvas-menu, na ordem do registro", () => {
    const items = Menu.menuItems({ kind: "canvas" }, { registry: registry(), commandCtx: ctxOf() });
    expect(items.map((i) => i.id)).toEqual(["command:focus", "command:only-canvas", "command:when-allowed"]);
  });

  test("dado nó que não é agente e sem tipo, então o menu vem vazio", () => {
    expect(Menu.menuItems({ kind: "node", node: agent({ type: "pr" }) }, { registry: registry(), commandCtx: ctxOf() })).toEqual([]);
  });

  test("dado menu do tipo que cita comando inexistente, então menuItems lança e safeItems devolve só as ações e o erro", () => {
    const target: Target = { kind: "node", node: agent(), nodeType: agentType(["nao-existe"]) };
    const deps = { registry: registry(), commandCtx: ctxOf() };
    expect(() => Menu.menuItems(target, deps)).toThrow();
    const safe = Menu.safeItems(target, deps);
    expect(safe.items.length).toBe(MENU_ACTIONS.length);
    expect(safe.error).toContain("nao-existe");
  });
});

describe("canvas-menu: menu enxuto do vazio", () => {
  const essentials = [{ id: "only-canvas", group: "Criar aqui" }, { id: "focus", group: "Ver" }, { id: "ausente", group: "Ver" }];
  const all = (reg = registry()) => Menu.menuItems({ kind: "canvas" }, { registry: reg, commandCtx: ctxOf() });
  const withPalette = () => {
    const r = registry();
    r.register(cmd("palette", { surfaces: [], shortcut: "mod+p" }));
    return r;
  };

  test("dado a lista de essenciais, então o menu leva só eles, na ordem da lista e no grupo dela", () => {
    const reg = withPalette();
    const items = Menu.curateCanvasItems(all(reg), essentials, reg);
    expect(items.slice(0, 2).map((i) => [i.id, i.group])).toEqual([["command:only-canvas", "Criar aqui"], ["command:focus", "Ver"]]);
  });

  test("dado comando essencial que não existe ou não vale agora, então ele não aparece", () => {
    const reg = withPalette();
    const ids = Menu.curateCanvasItems(all(reg), [...essentials, { id: "when-allowed", group: "Ver" }], reg).map((i) => i.id);
    expect(ids).not.toContain("command:ausente");
    expect(Menu.curateCanvasItems(Menu.menuItems({ kind: "canvas" }, { registry: reg, commandCtx: ctxOf({ allow: false }) }), [{ id: "when-allowed", group: "Ver" }], reg).map((i) => i.id)).toEqual(["command:palette"]);
  });

  test("dado comandos fora da lista, então o último item diz quantos ficaram na paleta e abre a paleta", () => {
    const reg = withPalette();
    const items = Menu.curateCanvasItems(all(reg), essentials, reg);
    const more = items[items.length - 1] as Item;
    expect([more.id, more.label, more.group, more.shortcut]).toEqual(["command:palette", "Mais 1 comandos…", "Mais", "Ctrl+K"]);
  });

  test("dado registro sem paleta, então não há item Mais (nada para abrir)", () => {
    const items = Menu.curateCanvasItems(all(), essentials, registry());
    expect(items.map((i) => i.id)).toEqual(["command:only-canvas", "command:focus"]);
  });

  test("dado a lista real, então todo id dela é de comando que a página registra para o menu do vazio", () => {
    const ids = Menu.CANVAS_ESSENTIALS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("tidy:arrange");
  });
});

describe("canvas-menu: motivo do item desabilitado", () => {
  test("dado item que não vale agora, então o motivo aparece como texto da linha, não só no title", () => {
    const items = Menu.menuItems({ kind: "node", node: agent() }, { registry: registry(), commandCtx: ctxOf() });
    const approve = items.find((i) => i.id === "action:approve_permission") as Item;
    expect(Menu.menuSize([approve], VIEW).h).toBeGreaterThan(Menu.menuSize([{ ...approve, reason: undefined } as Item], VIEW).h);
  });
});

describe("canvas-menu: teclado", () => {
  const item = (id: string, disabled = false): Item => ({ id, kind: "action", label: id, hint: "", group: "g", disabled, dangerous: false });
  const list = [item("a", true), item("b"), item("c")];

  test("dado seta para baixo e para cima, então anda e do último volta ao primeiro (e vice-versa)", () => {
    expect(Menu.menuKey(list, 0, "ArrowDown")).toEqual({ type: "move", index: 1 });
    expect(Menu.menuKey(list, 2, "ArrowDown")).toEqual({ type: "move", index: 0 });
    expect(Menu.menuKey(list, 0, "ArrowUp")).toEqual({ type: "move", index: 2 });
    expect(Menu.menuKey(list, 2, "ArrowUp")).toEqual({ type: "move", index: 1 });
  });

  test("dado Home e End, então vão ao primeiro e ao último", () => {
    expect(Menu.menuKey(list, 1, "Home")).toEqual({ type: "move", index: 0 });
    expect(Menu.menuKey(list, 1, "End")).toEqual({ type: "move", index: 2 });
  });

  test("dado Enter ou Espaço num item que vale, então ativa; num desabilitado, nada", () => {
    expect(Menu.menuKey(list, 1, "Enter")).toEqual({ type: "activate", item: list[1] as Item });
    expect(Menu.menuKey(list, 2, " ")).toEqual({ type: "activate", item: list[2] as Item });
    expect(Menu.menuKey(list, 0, "Enter")).toEqual({ type: "none" });
  });

  test("dado Esc ou Tab, então fecha, mesmo com o menu vazio", () => {
    expect(Menu.menuKey(list, 1, "Escape")).toEqual({ type: "close" });
    expect(Menu.menuKey([], 0, "Escape")).toEqual({ type: "close" });
    expect(Menu.menuKey(list, 1, "Tab")).toEqual({ type: "close" });
  });

  test("dado menu vazio ou tecla sem função, então nada (e nenhuma exceção com índice fora)", () => {
    expect(Menu.menuKey([], 0, "ArrowDown")).toEqual({ type: "none" });
    expect(Menu.menuKey([], 0, "Enter")).toEqual({ type: "none" });
    expect(Menu.menuKey(list, 1, "x")).toEqual({ type: "none" });
    expect(Menu.menuKey(list, 9, "Enter")).toEqual({ type: "none" });
  });

  test("dado o menu que abre, então o item ativo inicial é o primeiro que vale", () => {
    expect(Menu.firstEnabled(list)).toBe(1);
    expect(Menu.firstEnabled([item("x", true)])).toBe(0);
    expect(Menu.firstEnabled([])).toBe(0);
  });
});

describe("canvas-menu: posição", () => {
  const size = { w: 264, h: 300 };

  test("dado espaço, então abre no ponto do clique", () => {
    expect(Menu.placeMenu({ x: 100, y: 100 }, VIEW, size)).toEqual({ x: 100, y: 100 });
  });

  test("dado clique perto da borda direita ou de baixo, então abre para a esquerda ou para cima", () => {
    expect(Menu.placeMenu({ x: 1150, y: 100 }, VIEW, size)).toEqual({ x: 1150 - 264, y: 100 });
    expect(Menu.placeMenu({ x: 100, y: 780 }, VIEW, size)).toEqual({ x: 100, y: 780 - 300 });
  });

  test("dado clique fora da tela ou tela minúscula, então o menu fica dentro da tela (ou colado no canto)", () => {
    const p = Menu.placeMenu({ x: -300, y: 5000 }, VIEW, size);
    expect(p.x).toBeGreaterThanOrEqual(8);
    expect(p.y + size.h).toBeLessThanOrEqual(VIEW.h);
    expect(Menu.placeMenu({ x: 50, y: 50 }, { w: 100, h: 100 }, size)).toEqual({ x: 8, y: 8 });
  });

  test("dado muitos itens, então a altura é limitada pela tela (o excedente rola) e menu vazio tem uma linha", () => {
    const many = Array.from({ length: 200 }, (_, i): Item => ({ id: `i${i}`, kind: "action", label: "x", hint: "", group: "g", disabled: false, dangerous: false }));
    expect(Menu.menuSize(many, VIEW).h).toBe(VIEW.h - 16);
    expect(Menu.menuSize([], VIEW).h).toBeGreaterThan(0);
  });
});

describe("canvas-menu: componente", () => {
  /** Documento de mentira: guarda os ouvintes e deixa o teste disparar um clique fora. */
  function fakeDocument() {
    const listeners = new Map<string, Set<(e: { target: unknown }) => void>>();
    const opener = { focused: 0, isConnected: true, focus() { this.focused++; } };
    g.document = {
      activeElement: opener,
      addEventListener: (t: string, fn: (e: { target: unknown }) => void) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t))?.add(fn),
      removeEventListener: (t: string, fn: (e: { target: unknown }) => void) => void listeners.get(t)?.delete(fn),
      getElementById: () => null,
    };
    return { listeners, opener, fire: (t: string, target: unknown): void => listeners.get(t)?.forEach((fn) => fn({ target })) };
  }

  function open(target: Target, over: Record<string, unknown> = {}, reg = registry()) {
    const ctx = ctxOf();
    const seen = { closed: 0, actions: [] as [ActionItem, ActionNode][], errors: [] as string[] };
    const props = { target, at: AT, view: VIEW, registry: reg, commandCtx: ctx, onAction: (i: ActionItem, n: ActionNode) => seen.actions.push([i, n]), onClose: () => { seen.closed++; }, onError: (m: string) => seen.errors.push(m), ...over };
    return { m: mount(Menu.CanvasMenu, props), seen, ctx };
  }
  const nodeTarget: Target = { kind: "node", node: agent(), nodeType: agentType(["focus"]) };

  test("dado o menu aberto com essentials, então só os essenciais aparecem e o item Mais roda a paleta", () => {
    const reg = registry();
    reg.register(cmd("palette", { surfaces: [], shortcut: "mod+p" }));
    const ctx = ctxOf();
    const { m } = open({ kind: "canvas" }, { commandCtx: ctx, essentials: [{ id: "focus", group: "Ver" }] }, reg);
    press(m.tree, "End");
    m.settle();
    press(m.tree, "Enter");
    expect(ctx.ran).toEqual(["palette"]);
  });

  test("dado nó, então o menu tem papel, nome acessível, item ativo e cabeçalhos por grupo", () => {
    const { m } = open(nodeTarget);
    const root = m.tree as El;
    expect([root.props.role, root.props["aria-label"]]).toEqual(["menu", "Ações de a1"]);
    expect(root.props["aria-activedescendant"]).toBe(`argos-menu-item-${Menu.firstEnabled(Menu.menuItems(nodeTarget, { registry: registry(), commandCtx: ctxOf() }))}`);
    expect(flat(m.tree).filter((e) => e.props.role === "presentation").map(text)).toEqual(["Agente", "Canvas"]);
    expect(rows(m.tree).length).toBe(MENU_ACTIONS.length + 1);
  });

  test("dado setas, então o item ativo muda (aria-activedescendant) e a tecla é consumida", () => {
    const { m } = open(nodeTarget);
    const before = (m.tree as El).props["aria-activedescendant"];
    expect(press(m.tree, "ArrowDown").prevented).toBe(true);
    m.settle();
    expect((m.tree as El).props["aria-activedescendant"]).not.toBe(before);
    press(m.tree, "End");
    m.settle();
    expect((m.tree as El).props["aria-activedescendant"]).toBe(`argos-menu-item-${MENU_ACTIONS.length}`);
  });

  test("dado Enter numa ação do agente, então a página recebe a ação e o nó, e o menu fecha", () => {
    const { m, seen } = open(nodeTarget);
    press(m.tree, "Enter");
    expect(seen.actions.map(([i, n]) => [i.key, n.id])).toEqual([["prompt", "agent:p:a1"]]);
    expect(seen.closed).toBe(1);
  });

  test("dado Enter num comando, então ele roda pelo registro com o contexto e o menu fecha", () => {
    const { m, seen, ctx } = open(nodeTarget);
    press(m.tree, "End");
    m.settle();
    press(m.tree, "Enter");
    expect(ctx.ran).toEqual(["focus"]);
    expect([seen.closed, seen.actions.length]).toEqual([1, 0]);
  });

  test("dado comando que lança, então o erro vai a onError e o menu fecha mesmo assim", () => {
    const reg = registry();
    reg.register(cmd("quebra", { run: () => { throw new Error("falhou ao rodar"); } }));
    const { m, seen } = open({ kind: "canvas" }, {}, reg);
    press(m.tree, "End");
    m.settle();
    press(m.tree, "Enter");
    expect(seen.errors).toEqual(["falhou ao rodar"]);
    expect(seen.closed).toBe(1);
  });

  test("dado comando que deixou de valer entre abrir e escolher, então não roda e avisa", () => {
    const ctx = ctxOf();
    const { m, seen } = open({ kind: "canvas" }, { commandCtx: ctx });
    press(m.tree, "End");
    m.settle();
    ctx.allow = false;
    press(m.tree, "Enter");
    expect(ctx.ran).toEqual([]);
    expect(seen.errors[0]).toContain("já não vale");
  });

  test("dado clique num item desabilitado, então nada acontece e o menu continua aberto", () => {
    const { m, seen } = open(nodeTarget);
    (row(m.tree, "Aprovar permissão").props.onClick as () => void)();
    expect([seen.closed, seen.actions.length]).toEqual([0, 0]);
    expect(row(m.tree, "Aprovar permissão").props["aria-disabled"]).toBe(true);
  });

  test("dado o mouse sobre um item, então ele vira o ativo", () => {
    const { m } = open(nodeTarget);
    (row(m.tree, "Retomar").props.onPointerMove as () => void)();
    m.settle();
    expect(row(m.tree, "Retomar").props["data-active"]).toBe(true);
  });

  test("dado Esc, então fecha; dado o vazio sem comando algum, então mostra a linha 'Nenhuma ação aqui' sem quebrar", () => {
    const { m, seen } = open({ kind: "canvas" }, {}, createCommandRegistry<Ctx>());
    expect(rows(m.tree).map((r) => text(r))).toEqual([Menu.EMPTY_LABEL]);
    expect(press(m.tree, "Escape").prevented).toBe(true);
    expect(press(m.tree, "Enter").prevented).toBe(false);
    expect(seen.closed).toBe(1);
  });

  test("dado menu do tipo com comando inexistente, então abre só com as ações e avisa o erro uma vez", () => {
    const { m, seen } = open({ kind: "node", node: agent(), nodeType: agentType(["nao-existe"]) });
    expect(rows(m.tree).length).toBe(MENU_ACTIONS.length);
    m.settle();
    expect(seen.errors.length).toBe(1);
    expect(seen.errors[0]).toContain("nao-existe");
  });

  test("dado o ciclo de vida, então o ouvinte de clique fora sai com o menu e o foco volta a quem o abriu", () => {
    const doc = fakeDocument();
    const { m } = open(nodeTarget);
    expect(doc.listeners.get("pointerdown")?.size).toBe(1);
    m.unmount();
    expect(doc.listeners.get("pointerdown")?.size).toBe(0);
    expect(doc.opener.focused).toBe(1);
  });

  test("dado o elemento do menu, então clique dentro não fecha e clique fora fecha", () => {
    const doc = fakeDocument();
    const { m, seen } = open(nodeTarget);
    const element = { contains: (n: unknown) => n === "dentro", focus: () => undefined };
    // o ref do menu entra pela árvore: quem monta o DOM chama setRoot
    ((m.tree as El).props.ref as (el: unknown) => void)(element);
    doc.fire("pointerdown", "dentro");
    expect(seen.closed).toBe(0);
    doc.fire("pointerdown", "fora");
    expect(seen.closed).toBe(1);
  });
});
