// Grupo canvas-controls: controles de câmera do canvas (kit/panel/ui/argos/canvas-controls.tsx) — o modelo dos quatro botões
// (nome acessível, dica com o atalho, limites de zoom), a árvore desenhada, o ciclo de vida do ouvinte de câmera e a ligação dos
// comandos de câmera ao registro de comandos. O .tsx é um script clássico de navegador: aqui ele roda sobre um React mínimo
// (elementos como objetos, estado e efeitos síncronos) e o modelo de câmera real, sem DOM.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as camera from "../../../src/lib/canvas-camera";
import { argosCommandDefs, type ArgosCommandCtx } from "../../../src/lib/canvas-argos";
import { createCommandRegistry, type CommandDef } from "../../../src/lib/canvas-commands";
import type { Camera, CameraCommandCtx, CameraHandlers } from "../../../src/lib/canvas-camera";

// Os tipos do .tsx não entram aqui (o tsconfig do projeto não tem jsx): este é o contorno do que o teste usa dele.
interface ControlItem {
  id: string;
  label: string;
  title: string;
  text?: string;
  disabled: boolean;
  run(): void;
}
interface ControlActions { zoomIn(): void; zoomOut(): void; zoomReset(): void; fitAll(): void }
interface CanvasEngineApi { readonly engine: "api-de-mentira" }
interface ArgosCanvasControlsApi {
  CanvasControls: (props: { api: CanvasEngineApi | null; className?: string }) => unknown;
  controlsModel(k: number, actions: ControlActions): ControlItem[];
  renderControls(ui: { h: never; Button?: never; icons?: Record<string, never>; className?: string }, items: readonly ControlItem[], said: string): unknown;
  cameraHandlers(getApi: () => CanvasEngineApi | null | undefined, getPrimary: () => string | null | undefined): CameraHandlers;
  registerCameraCommands(registry: { list(): readonly unknown[]; get(id: string): unknown; register(def: never): void }): void;
  GROUP_LABEL: string;
}

interface El {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}

const g = globalThis as unknown as Record<string, unknown>;
const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: props ?? {}, children });

/** Relógio manual: o ouvinte de câmera agenda o anúncio do nível, e o teste decide quando o tempo passa. */
const timers = new Map<number, { run: () => void; ms: number }>();
let timerSeq = 0;
const setTimeoutStub = (run: () => void, ms: number): number => {
  timers.set(++timerSeq, { run, ms });
  return timerSeq;
};
const clearTimeoutStub = (id: number | undefined): void => {
  if (id !== undefined) timers.delete(id);
};
const runTimers = (): void => {
  for (const [id, t] of [...timers]) {
    timers.delete(id);
    t.run();
  }
};

/** React mínimo: estado por posição, efeitos que rodam quando as dependências mudam e limpam ao desmontar. */
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
    rerender(next: P): void {
      props = next;
      settle();
    },
    unmount(): void {
      for (const e of effects) if (typeof e?.cleanup === "function") e.cleanup();
    },
  };
}

/** Motor de mentira: guarda os ouvintes de câmera e conta o que os controles pedem. */
function fakeEngine(start: Camera) {
  let cam = start;
  const listeners = new Set<(c: Camera) => void>();
  const calls: string[] = [];
  const api = {
    getCamera: () => cam,
    zoomIn: () => calls.push("in"),
    zoomOut: () => calls.push("out"),
    zoomReset: () => calls.push("reset"),
    fitAll: (animate?: boolean) => calls.push(`fit:${animate}`),
    fitSelection: () => calls.push("selection"),
    centerNode: (id: string) => calls.push(`center:${id}`),
    onCamera: (l: (c: Camera) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  } as unknown as CanvasEngineApi;
  return {
    api,
    calls,
    listeners,
    move(next: Camera): void {
      cam = next;
      for (const l of [...listeners]) l(next);
    },
  };
}

let Controls: ArgosCanvasControlsApi;
const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };

beforeAll(async () => {
  g.CanvasModel = { camera };
  // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
  await import("../../../kit/panel/ui/argos/canvas-controls.tsx");
  Controls = g.ArgosCanvasControls as ArgosCanvasControlsApi;
  globalThis.setTimeout = setTimeoutStub as unknown as typeof setTimeout;
  globalThis.clearTimeout = clearTimeoutStub as unknown as typeof clearTimeout;
});
afterAll(() => {
  globalThis.setTimeout = saved.setTimeout;
  globalThis.clearTimeout = saved.clearTimeout;
  delete g.CanvasModel;
  delete g.ArgosCanvasControls;
  delete g.React;
});
beforeEach(() => timers.clear());

const noop = (): void => undefined;
const actions = { zoomIn: noop, zoomOut: noop, zoomReset: noop, fitAll: noop };
const byId = (items: readonly ControlItem[], id: string): ControlItem => items.find((i: ControlItem) => i.id === id) as ControlItem;
const buttons = (tree: unknown): El[] => (tree as El).children.filter((c): c is El => (c as El).type !== "span");

describe("canvas-controls: modelo dos botões", () => {
  test("quatro controles na ordem da tela, cada um com nome acessível e dica com o atalho", () => {
    const items = Controls.controlsModel(1, actions);
    expect(items.map((i) => i.id)).toEqual(["zoom-out", "zoom-level", "zoom-in", "fit"]);
    for (const item of items) {
      expect(item.label.trim()).not.toBe("");
      expect(item.title.trim()).not.toBe("");
    }
    expect(byId(items, "zoom-in").title).toContain("Ctrl+=");
    expect(byId(items, "zoom-out").title).toContain("Ctrl+-");
    expect(byId(items, "zoom-level").title).toContain("Ctrl+0");
    expect(byId(items, "fit").title).toContain("F");
  });

  test("o controle de nível mostra a porcentagem e o nome acessível diz o valor e o que a ativação faz", () => {
    const level = byId(Controls.controlsModel(0.5, actions), "zoom-level");
    expect(level.text).toBe("50%");
    expect(level.label).toContain("50%");
    expect(level.label).toContain("100%");
  });

  test("no zoom máximo só aproximar desliga; no mínimo só afastar; no meio nenhum", () => {
    const max = Controls.controlsModel(camera.CAMERA_LIMITS.zoomMax, actions);
    expect([byId(max, "zoom-in").disabled, byId(max, "zoom-out").disabled]).toEqual([true, false]);
    const min = Controls.controlsModel(camera.CAMERA_LIMITS.zoomMin, actions);
    expect([byId(min, "zoom-in").disabled, byId(min, "zoom-out").disabled]).toEqual([false, true]);
    const mid = Controls.controlsModel(1, actions);
    expect(mid.some((i) => i.disabled)).toBe(false);
  });

  test("ativar cada controle chama a ação dele e nenhuma outra", () => {
    const calls: string[] = [];
    const items = Controls.controlsModel(1, { zoomIn: () => calls.push("in"), zoomOut: () => calls.push("out"), zoomReset: () => calls.push("reset"), fitAll: () => calls.push("fit") });
    for (const id of ["zoom-in", "zoom-out", "zoom-level", "fit"]) byId(items, id).run();
    expect(calls).toEqual(["in", "out", "reset", "fit"]);
  });
});

describe("canvas-controls: árvore desenhada", () => {
  const ui = { h: createElement as never, className: "caixa" };

  test("o grupo tem papel e nome e cada botão é um botão nativo com tipo, nome acessível e dica", () => {
    const tree = Controls.renderControls(ui, Controls.controlsModel(1, actions), "") as El;
    expect(tree.type).toBe("div");
    expect(tree.props.role).toBe("group");
    expect(tree.props["aria-label"]).toBe(Controls.GROUP_LABEL);
    expect(tree.props.className).toBe("caixa");
    const found = buttons(tree);
    expect(found.map((b) => b.type)).toEqual(["button", "button", "button", "button"]);
    for (const b of found) {
      expect(b.props.type).toBe("button");
      expect(typeof b.props["aria-label"]).toBe("string");
      expect(b.props.title).toBeTruthy();
      expect(typeof b.props.onClick).toBe("function");
    }
  });

  test("os botões de ícone levam o glifo como conteúdo e o de nível o texto; o desligado sai disabled", () => {
    const tree = Controls.renderControls(ui, Controls.controlsModel(camera.CAMERA_LIMITS.zoomMax, actions), "");
    const [out, level, zin, fit] = buttons(tree);
    expect(out?.children).toEqual(["−"]);
    expect(level?.children).toEqual(["400%"]);
    expect(zin?.children).toEqual(["+"]);
    expect(fit?.children).toEqual(["⤢"]);
    expect([out?.props.disabled, zin?.props.disabled]).toEqual([false, true]);
  });

  test("com o Button da página, ele recebe variante, ícone e o mesmo nome acessível; o nível mostra texto", () => {
    const Button = (): null => null;
    const icons = { "zoom-out": (() => null) as never, "zoom-in": (() => null) as never, fit: (() => null) as never };
    const tree = Controls.renderControls({ ...ui, Button: Button as never, icons }, Controls.controlsModel(1, actions), "");
    const [out, level] = buttons(tree);
    expect(out?.type).toBe(Button);
    expect(out?.props.icon).toBe(icons["zoom-out"]);
    expect(out?.props["aria-label"]).toBe("Afastar");
    expect(level?.children).toEqual(["100%"]);
  });

  test("a região de status leva o texto anunciado e fica fora da tela", () => {
    const tree = Controls.renderControls(ui, Controls.controlsModel(1, actions), "Zoom 120%") as El;
    const status = tree.children.find((c) => (c as El).type === "span") as El;
    expect(status.props.role).toBe("status");
    expect(status.props.className).toBe("sr-only");
    expect(status.children).toEqual(["Zoom 120%"]);
  });
});

describe("canvas-controls: componente ligado ao motor", () => {
  test("sem motor nada é desenhado; com o motor, os botões nascem com o nível da câmera dele", () => {
    const view = mount(Controls.CanvasControls, { api: null as CanvasEngineApi | null });
    expect(view.tree).toBeNull();
    const engine = fakeEngine({ x: 0, y: 0, k: 0.5 });
    view.rerender({ api: engine.api });
    expect(byId(Controls.controlsModel(0.5, actions), "zoom-level").text).toBe("50%");
    expect(buttons(view.tree).at(1)?.children).toEqual(["50%"]);
    view.unmount();
  });

  test("mudar a câmera atualiza o nível na hora; o anúncio ao leitor de tela só vem quando o zoom para", () => {
    const engine = fakeEngine({ x: 0, y: 0, k: 1 });
    const view = mount(Controls.CanvasControls, { api: engine.api });
    const status = (): unknown[] => ((view.tree as El).children.find((c) => (c as El).type === "span") as El).children;
    engine.move({ x: 0, y: 0, k: 1.25 });
    engine.move({ x: 0, y: 0, k: 1.5 });
    view.settle();
    expect(buttons(view.tree).at(1)?.children).toEqual(["150%"]);
    expect(status()).toEqual([""]);
    runTimers();
    view.settle();
    expect(status()).toEqual(["Zoom 150%"]);
    view.unmount();
  });

  test("pan sem mudar a escala não refaz nada e cada movimento rearma o anúncio (um só temporizador vivo)", () => {
    const engine = fakeEngine({ x: 0, y: 0, k: 1 });
    const view = mount(Controls.CanvasControls, { api: engine.api });
    const before = view.tree;
    engine.move({ x: 50, y: 20, k: 1 });
    view.settle();
    expect(buttons(view.tree).at(1)?.children).toEqual(["100%"]);
    expect(buttons(before).at(1)?.children).toEqual(["100%"]);
    engine.move({ x: 60, y: 20, k: 2 });
    engine.move({ x: 60, y: 20, k: 2.5 });
    expect(timers.size).toBe(1);
    view.unmount();
  });

  test("desmontar solta o ouvinte de câmera e cancela o anúncio pendente; trocar o motor passa a ouvir o novo", () => {
    const first = fakeEngine({ x: 0, y: 0, k: 1 });
    const view = mount(Controls.CanvasControls, { api: first.api });
    expect(first.listeners.size).toBe(1);
    first.move({ x: 0, y: 0, k: 2 });
    expect(timers.size).toBe(1);
    const second = fakeEngine({ x: 0, y: 0, k: 0.25 });
    view.rerender({ api: second.api });
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    expect(buttons(view.tree).at(1)?.children).toEqual(["25%"]);
    view.unmount();
    expect(second.listeners.size).toBe(0);
    expect(timers.size).toBe(0);
  });

  test("os botões do componente chamam o motor: aproximar, afastar, 100% e enquadrar tudo (animado)", () => {
    const engine = fakeEngine({ x: 0, y: 0, k: 1 });
    const view = mount(Controls.CanvasControls, { api: engine.api });
    const [out, level, zin, fit] = buttons(view.tree);
    for (const b of [zin, out, level, fit]) (b?.props.onClick as () => void)();
    expect(engine.calls).toEqual(["in", "out", "reset", "fit:true"]);
    view.unmount();
  });
});

describe("canvas-controls: comandos de câmera na página", () => {
  const argosActions = [{ id: "approve_permission", label: "Aprovar", hint: "" }];

  test("os comandos entram uma vez no registro da página e repetir a chamada não lança nem duplica", () => {
    const registry = createCommandRegistry<ArgosCommandCtx & CameraCommandCtx>();
    for (const def of argosCommandDefs({ actions: argosActions, stateFilters: [] })) registry.register(def as CommandDef<ArgosCommandCtx & CameraCommandCtx>);
    const before = registry.list().length;
    Controls.registerCameraCommands(registry);
    Controls.registerCameraCommands(registry);
    expect(registry.list().length).toBe(before + camera.CAMERA_COMMAND_IDS.length);
    for (const id of camera.CAMERA_COMMAND_IDS) expect(registry.get(id)).toBeDefined();
  });

  test("os comandos chegam à paleta e ao menu do fundo da página, e os atalhos ao motor", () => {
    const registry = createCommandRegistry<ArgosCommandCtx & CameraCommandCtx>();
    for (const def of argosCommandDefs({ actions: argosActions, stateFilters: [] })) registry.register(def as CommandDef<ArgosCommandCtx & CameraCommandCtx>);
    Controls.registerCameraCommands(registry);
    const engine = fakeEngine({ x: 0, y: 0, k: 1 });
    const handlers = { ...Controls.cameraHandlers(() => engine.api, () => "agent:a1") };
    const ctx = { selectedLabel: "a1", availableActions: [], canUndo: false, canRedo: false, handlers } as unknown as ArgosCommandCtx & CameraCommandCtx;
    const ids = registry.palette(ctx).map((e) => e.id);
    for (const id of camera.CAMERA_COMMAND_IDS) expect(ids).toContain(id);
    expect(registry.canvasMenu(ctx).map((e) => e.id)).toContain("zoom-reset");
    for (const key of [{ key: "=", ctrlKey: true }, { key: "-", ctrlKey: true }, { key: "0", ctrlKey: true }, { key: "z" }, { key: "c" }]) {
      registry.resolveKey(key, { editable: false, ctx })?.run(ctx);
    }
    expect(engine.calls).toEqual(["in", "out", "reset", "selection", "center:agent:a1"]);
  });

  test("os manipuladores leem o motor e o nó principal na hora de executar: motor ausente e sem seleção não fazem nada nem lançam", () => {
    let api: CanvasEngineApi | null = null;
    let primary: string | null = null;
    const engine = fakeEngine({ x: 0, y: 0, k: 1 });
    const handlers = Controls.cameraHandlers(() => api, () => primary);
    expect(() => {
      handlers.zoomIn();
      handlers.zoomOut();
      handlers.zoomReset();
      handlers.fitSelection();
      handlers.focusNode();
    }).not.toThrow();
    api = engine.api;
    handlers.focusNode();
    expect(engine.calls).toEqual([]);
    primary = "agent:b2";
    handlers.focusNode();
    handlers.zoomIn();
    expect(engine.calls).toEqual(["center:agent:b2", "in"]);
  });
});
