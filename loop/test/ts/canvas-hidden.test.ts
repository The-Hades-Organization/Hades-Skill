// Grupo canvas-hidden: os ocultos do canvas (kit/panel/ui/argos/canvas-hidden.tsx) — alvo de "Ocultar" (seleção ou nó do
// menu), comandos no registro de verdade (rótulo, condição, atalho, superfícies) e a árvore do botão "Ocultos do canvas (N)" com a
// lista. O .tsx é script de navegador: publica em globalThis; aqui a árvore sai de um createElement mínimo, sem DOM.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type CommandDef, createCommandRegistry } from "../../../src/lib/canvas-commands";
import type { NodeTypeDef } from "../../../src/lib/canvas-types";

// o .tsx do kit não entra no tsc do projeto (sem --jsx): o contrato que o teste lê fica aqui, como em canvas-overlays.test.ts
interface El { type: unknown; props: Record<string, unknown>; children: unknown[] }
interface HiddenCommandCtx { reading: { nodeId: string | null } }
interface HiddenPort {
  targets(nodeId: string | null): readonly string[];
  hide(ids: readonly string[]): void;
  unhideAll(): void;
  count(): number;
  openList(): void;
}
interface HiddenItem { id: string; label: string; kind: string }
interface HiddenUi {
  h: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => El;
  items: readonly HiddenItem[];
  open: boolean;
  checked: ReadonlySet<string>;
  onToggleOpen(): void;
  onCheck(id: string): void;
  onUnhide(ids: readonly string[]): void;
  onKeyDown(event: unknown): void;
}
interface ArgosCanvasHiddenApi {
  HIDE_COMMAND: string;
  EMPTY_LABEL: string;
  hideTargets(selection: readonly string[], nodeId: string | null): string[];
  hiddenCommandDefs(port: HiddenPort): CommandDef<HiddenCommandCtx>[];
  keepChecked(checked: ReadonlySet<string>, items: readonly HiddenItem[]): string[];
  renderHiddenMenu(ui: HiddenUi): unknown;
}
const g = globalThis as unknown as Record<string, unknown>;
const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: props ?? {}, children });
let H: ArgosCanvasHiddenApi;

beforeAll(async () => {
  // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
  await import("../../../kit/panel/ui/argos/canvas-hidden.tsx");
  H = g.ArgosCanvasHidden as ArgosCanvasHiddenApi;
});
afterAll(() => {
  delete g.ArgosCanvasHidden;
});

/** Porta falsa: guarda o que a página receberia. */
function fakePort(selection: string[], hiddenCount = 0) {
  const calls: { hide: (readonly string[])[]; unhideAll: number; openList: number } = { hide: [], unhideAll: 0, openList: 0 };
  const port: HiddenPort = {
    targets: (nodeId) => H.hideTargets(selection, nodeId),
    hide: (ids) => { calls.hide.push(ids); },
    unhideAll: () => { calls.unhideAll += 1; },
    count: () => hiddenCount,
    openList: () => { calls.openList += 1; },
  };
  return { port, calls };
}

const ctxOf = (nodeId: string | null): HiddenCommandCtx => ({ reading: { nodeId } });

describe("canvas-hidden: alvo de ocultar", () => {
  test("dado nó do menu dentro da seleção, então o alvo é a seleção inteira", () => {
    expect(H.hideTargets(["a", "b", "c"], "b")).toEqual(["a", "b", "c"]);
  });
  test("dado nó do menu fora da seleção, então o alvo é só ele", () => {
    expect(H.hideTargets(["a", "b"], "z")).toEqual(["z"]);
  });
  test("sem nó do menu (paleta, atalho), então o alvo é a seleção, sem repetir; seleção vazia não dá alvo", () => {
    expect(H.hideTargets(["a", "a", "b"], null)).toEqual(["a", "b"]);
    expect(H.hideTargets([], null)).toEqual([]);
  });
});

describe("canvas-hidden: comandos", () => {
  const registered = (selection: string[], hiddenCount = 0) => {
    const { port, calls } = fakePort(selection, hiddenCount);
    const reg = createCommandRegistry<HiddenCommandCtx>();
    for (const def of H.hiddenCommandDefs(port)) reg.register(def);
    return { reg, calls };
  };

  test("os três comandos entram no registro com Shift+H só no de ocultar", () => {
    const { reg } = registered(["a"], 1);
    const ids = reg.palette(ctxOf("a")).map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining([H.HIDE_COMMAND, "canvas:unhide-all", "canvas:hidden-list"]));
    expect(reg.resolveKey({ key: "H", shiftKey: true }, { editable: false, ctx: ctxOf("a") })?.id).toBe(H.HIDE_COMMAND);
  });
  test("dada seleção de 3 com o nó do menu nela, então o rótulo diz 3 e rodar oculta os 3", () => {
    const { reg, calls } = registered(["a", "b", "c"]);
    const entry = reg.palette(ctxOf("b")).find((e) => e.id === H.HIDE_COMMAND);
    expect(entry?.label).toBe("Ocultar 3 nós do canvas");
    reg.get(H.HIDE_COMMAND)?.run(ctxOf("b"));
    expect(calls.hide).toEqual([["a", "b", "c"]]);
  });
  test("dado um nó só, então o rótulo é o curto", () => {
    const { reg } = registered([], 0);
    expect(reg.palette(ctxOf("z")).find((e) => e.id === H.HIDE_COMMAND)?.label).toBe("Ocultar do canvas");
  });
  test("sem alvo, ocultar some; sem ocultos, reexibir e a lista somem", () => {
    const { reg } = registered([], 0);
    expect(reg.palette(ctxOf(null)).map((e) => e.id)).toEqual([]);
    expect(reg.resolveKey({ key: "H", shiftKey: true }, { editable: false, ctx: ctxOf(null) })).toBeNull();
  });
  test("ocultar está no menu do nó; reexibir e a lista, no menu do canvas", () => {
    const { reg } = registered(["a"], 2);
    const agentType: NodeTypeDef = { type: "agent", label: "Agente", icon: "Bot", defaultSize: { w: 1, h: 1 }, draw: { surface: "html", render: () => null },
      menu: [H.HIDE_COMMAND], actions: [], live: true };
    expect(reg.nodeMenu(agentType, ctxOf("a")).map((e) => e.id)).toEqual([H.HIDE_COMMAND]);
    const canvas = reg.canvasMenu(ctxOf(null)).map((e) => e.id);
    expect(canvas).toEqual(["canvas:unhide-all", "canvas:hidden-list"]);
  });
  test("reexibir todos e a lista encaminham à porta", () => {
    const { reg, calls } = registered([], 2);
    reg.get("canvas:unhide-all")?.run(ctxOf(null));
    reg.get("canvas:hidden-list")?.run(ctxOf(null));
    expect([calls.unhideAll, calls.openList]).toEqual([1, 1]);
  });
});

describe("canvas-hidden: botão e lista", () => {
  const items: HiddenItem[] = [
    { id: "agent:o__r:a", label: "a", kind: "agente · archived" },
    { id: "agent:o__r:b", label: "b", kind: "" },
    { id: "note:1", label: "plano.md", kind: "Nota" },
  ];
  const ui = (over: Partial<HiddenUi> = {}) => {
    const unhidden: (readonly string[])[] = [];
    const tree = H.renderHiddenMenu({
      h: createElement, items, open: true, checked: new Set<string>(), onToggleOpen: () => undefined, onCheck: () => undefined,
      onUnhide: (ids) => { unhidden.push(ids); }, onKeyDown: () => undefined, ...over,
    }) as El;
    return { tree, unhidden };
  };
  const all = (el: unknown): El[] => {
    if (!el || typeof el !== "object") return [];
    const node = el as El;
    return [node, ...node.children.flatMap((child) => (Array.isArray(child) ? child.flatMap(all) : all(child)))];
  };
  const text = (el: El): string => all(el).flatMap((n) => n.children.filter((c) => typeof c === "string")).join("");
  const buttons = (tree: El): El[] => all(tree).filter((n) => n.type === "button");
  const byText = (tree: El, label: string): El => {
    const found = buttons(tree).find((b) => text(b) === label);
    if (!found) throw new Error(`sem botão "${label}"`);
    return found;
  };
  const click = (el: El): void => (el.props.onClick as () => void)();

  test("fechada: só o botão com a contagem; sem ocultos ele fica desabilitado", () => {
    const { tree } = ui({ open: false });
    expect(buttons(tree).map(text)).toEqual(["Ocultos do canvas (3)"]);
    expect(buttons(tree)[0]?.props["aria-expanded"]).toBe(false);
    const empty = ui({ open: false, items: [] }).tree;
    expect(buttons(empty)[0]?.props.disabled).toBe(true);
  });
  test("aberta: diálogo com nome acessível, uma linha por oculto com caixa e Reexibir", () => {
    const { tree } = ui();
    const dialog = all(tree).find((n) => n.props.role === "dialog");
    expect(dialog?.props["aria-label"]).toBe("Nós ocultos");
    expect(all(tree).filter((n) => n.props["data-hidden"]).map((n) => n.props["data-hidden"])).toEqual(items.map((i) => i.id));
    expect(all(tree).filter((n) => n.type === "input")).toHaveLength(3);
    expect(text(tree)).toContain("3 nós ocultos");
  });
  test("Reexibir da linha reexibe só aquele", () => {
    const { tree, unhidden } = ui();
    const row = buttons(tree).find((b) => b.props["aria-label"] === "Reexibir plano.md") as El;
    click(row);
    expect(unhidden).toEqual([["note:1"]]);
  });
  test("com marcados, o botão diz quantos e reexibe só eles; sem marcados, fica desabilitado", () => {
    const { tree, unhidden } = ui({ checked: new Set(["agent:o__r:a", "note:1", "sumiu"]) });
    click(byText(tree, "Reexibir 2"));
    expect(unhidden).toEqual([["agent:o__r:a", "note:1"]]);
    expect(byText(ui().tree, "Reexibir marcados").props.disabled).toBe(true);
  });
  test("Reexibir todos reexibe a lista inteira", () => {
    const { tree, unhidden } = ui();
    click(byText(tree, "Reexibir todos"));
    expect(unhidden).toEqual([items.map((i) => i.id)]);
  });
  test("aberta sem ocultos: mensagem de vazio e Reexibir todos desabilitado", () => {
    const { tree } = ui({ items: [] });
    expect(text(tree)).toContain(H.EMPTY_LABEL);
    expect(byText(tree, "Reexibir todos").props.disabled).toBe(true);
  });
  test("marcados que saíram da lista não contam", () => {
    expect(H.keepChecked(new Set(["x", "note:1"]), items)).toEqual(["note:1"]);
  });
});
