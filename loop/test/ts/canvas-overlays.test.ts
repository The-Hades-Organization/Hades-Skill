// Grupo canvas-overlays: as camadas sobre o motor do canvas (kit/panel/ui/argos/canvas-overlays.tsx) — cada uma liga quando a
// prop vem e some quando não vem, o menu encaminha ao despacho recebido, o toque vira câmera pelo modelo puro e o componente
// não faz fetch nem lê estado global. O .tsx é script de navegador: aqui roda sobre um React mínimo e componentes falsos.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as camera from "../../../src/lib/canvas-camera";
import type { Camera } from "../../../src/lib/canvas-camera";
import * as touch from "../../../src/lib/canvas-touch";

interface El { type: unknown; props: Record<string, unknown>; children: unknown[] }
type Fn = (props: Record<string, unknown>) => unknown;
interface Deps { Menu: Fn; Balloon: Fn; Permission: Fn; Minimap: Fn; camera: typeof camera; touch: typeof touch; now(): number; timers: { set(run: () => void, ms: number): unknown; clear(h: unknown): void } }
interface OverlaysApi {
  makeCanvasOverlays(deps: Deps): { CanvasOverlays: Fn; TouchGestures: Fn; PermissionBoxes: Fn };
  CanvasOverlays: Fn;
  permissionSlots(nodes: unknown[], wanted: Set<string>, cam: Camera, view: { w: number; h: number }, toScreen: typeof camera.worldToScreen): { node: { id: string }; x: number; y: number; w: number }[];
  gestureCamera(event: unknown, cam: Camera, pinch: unknown, math: typeof camera): { camera?: Camera; pinch: unknown };
  MAX_PERMISSION_BOXES: number;
  TOUCH_TICK_MS: number;
}

const g = globalThis as unknown as Record<string, unknown>;
const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: props ?? {}, children });
const noop = (): null => null;
const Menu: Fn = noop;
const Balloon: Fn = noop;
const Permission: Fn = noop;
const Minimap: Fn = noop;

/** React mínimo: estado/ref por posição e efeitos que rodam quando as dependências mudam e limpam ao desmontar. */
function mount<P>(component: (props: P) => unknown, initial: P) {
  let props = initial;
  const slots: unknown[] = [];
  const effects: { deps?: readonly unknown[]; cleanup?: void | (() => void) }[] = [];
  let tree: unknown = null;
  let cursor = 0;
  let effectCursor = 0;
  const pending: (() => void)[] = [];
  g.React = {
    createElement,
    Fragment: "fragment",
    useRef: (init: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i];
    },
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const i = effectCursor++;
      const prev = effects[i];
      if (prev?.deps && deps && prev.deps.length === deps.length && prev.deps.every((d, n) => Object.is(d, deps[n]))) return;
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
  render();
  return {
    get tree(): unknown { return tree; },
    rerender(next: P): void { props = next; render(); },
    unmount(): void { for (const e of effects) if (typeof e?.cleanup === "function") e.cleanup(); },
  };
}

const flat = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(flat);
  if (typeof node !== "object" || node === null) return [];
  const el = node as El;
  return [el, ...el.children.flatMap(flat)];
};
const ofType = (tree: unknown, type: unknown): El[] => flat(tree).filter((e) => e.type === type);

let Overlays: OverlaysApi;
beforeAll(async () => {
  g.CanvasModel = { camera, touch };
  g.ArgosCanvasMenu = { CanvasMenu: Menu };
  g.ArgosNodeBalloon = { NodeBalloon: Balloon };
  g.ArgosNodePermission = { NodePermission: Permission };
  g.ArgosCanvasMinimap = { CanvasMinimap: Minimap };
  // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
  await import("../../../kit/panel/ui/argos/canvas-overlays.tsx");
  Overlays = g.ArgosCanvasOverlays as OverlaysApi;
});
afterAll(() => {
  for (const key of ["CanvasModel", "ArgosCanvasMenu", "ArgosNodeBalloon", "ArgosNodePermission", "ArgosCanvasMinimap", "ArgosCanvasOverlays", "React"]) delete g[key];
});

const VIEW = { w: 1000, h: 700 };
const CAM: Camera = { x: 0, y: 0, k: 1 };
const agent = (id: string, pending = false) => ({
  node: { id, type: "agent", label: id, pendingPermission: pending ? { ts: "2026-01-01T00:00:00Z", tool: "Bash" } : null },
  rect: { x: 100, y: 100, w: 300, h: 80 },
});
const FAKE_TIME = { now: 0 };
const timersLog = { set: [] as { run: () => void; ms: number }[], cleared: 0 };
const build = () => {
  FAKE_TIME.now = 0;
  timersLog.set = [];
  timersLog.cleared = 0;
  return Overlays.makeCanvasOverlays({
    Menu, Balloon, Permission, Minimap, camera, touch, now: () => FAKE_TIME.now,
    timers: { set: (run, ms) => { timersLog.set.push({ run, ms }); return timersLog.set.length; }, clear: () => { timersLog.cleared++; } },
  });
};
const base = { camera: CAM, view: VIEW, nodes: [agent("a1", true), agent("a2")] };

describe("camadas ligam pela prop", () => {
  test("dado nenhuma prop de camada, o quadro sai vazio", () => {
    const { CanvasOverlays } = build();
    const m = mount(CanvasOverlays, base);
    expect(m.tree).toMatchObject({ type: "div", children: [] });
  });

  test("dado a prop do minimapa, ele recebe os retângulos dos nós, a câmera e o encaminhamento", () => {
    const { CanvasOverlays } = build();
    const onCamera = (): void => {};
    const [mini] = ofType(mount(CanvasOverlays, { ...base, minimap: { onCamera, size: { w: 100, h: 60 } } }).tree, Minimap);
    expect(mini?.props).toMatchObject({ camera: CAM, view: VIEW, size: { w: 100, h: 60 }, onCamera });
    expect(mini?.props.rects).toEqual(base.nodes.map((n) => n.rect));
  });

  test("dado minimapa sem tamanho nem rótulo, esses campos não são repassados", () => {
    const { CanvasOverlays } = build();
    const [mini] = ofType(mount(CanvasOverlays, { ...base, minimap: { onCamera: () => {} } }).tree, Minimap);
    expect("size" in (mini as El).props).toBe(false);
    expect("label" in (mini as El).props).toBe(false);
  });

  test("dado a prop do menu, ele abre com a tela e o resto vai como veio", () => {
    const { CanvasOverlays } = build();
    const menu = { target: { kind: "canvas" }, at: { x: 5, y: 6 }, registry: {}, commandCtx: {}, onAction: () => {}, onClose: () => {} };
    const [el] = ofType(mount(CanvasOverlays, { ...base, menu }).tree, Menu);
    expect(el?.props).toMatchObject({ ...menu, view: VIEW });
  });

  test("dado o menu, a ação escolhida chega ao despacho recebido sem passar por outra mão", () => {
    const { CanvasOverlays } = build();
    const chosen: unknown[] = [];
    const onAction = (item: unknown, node: unknown): void => { chosen.push([item, node]); };
    const [el] = ofType(mount(CanvasOverlays, { ...base, menu: { target: { kind: "canvas" }, at: { x: 0, y: 0 }, registry: {}, commandCtx: {}, onAction, onClose: () => {} } }).tree, Menu);
    expect(el?.props.onAction).toBe(onAction);
  });

  test("dado o balão, ele abre no nó pedido com o retângulo dele na tela", () => {
    const { CanvasOverlays } = build();
    const cam = { x: 50, y: 20, k: 2 };
    const [el] = ofType(mount(CanvasOverlays, { ...base, camera: cam, balloon: { nodeId: "a2", drafts: {}, onDrafts: () => {}, doc: {}, onClose: () => {} } }).tree, Balloon);
    expect(el?.props.node).toBe(base.nodes[1]?.node);
    expect(el?.props.anchor).toEqual({ x: 100, y: 160, w: 600, h: 160 });
    expect(el?.props.view).toEqual(VIEW);
    expect("nodeId" in (el as El).props).toBe(false);
  });

  test("dado balão para nó que não está entre os visíveis, nada é desenhado", () => {
    const { CanvasOverlays } = build();
    const m = mount(CanvasOverlays, { ...base, balloon: { nodeId: "fora", drafts: {}, onDrafts: () => {}, doc: {}, onClose: () => {} } });
    expect(ofType(m.tree, Balloon)).toHaveLength(0);
  });

  test("dado a prop de permissão, só o nó com pedido ganha caixa, embaixo dele", () => {
    const { CanvasOverlays, PermissionBoxes } = build();
    const m = mount(CanvasOverlays, { ...base, permission: { onResult: () => {} } });
    const [boxes] = ofType(m.tree, PermissionBoxes);
    const inner = mount(PermissionBoxes as Fn, boxes?.props as Record<string, unknown>);
    const perms = ofType(inner.tree, Permission);
    expect(perms).toHaveLength(1);
    expect((perms[0]?.props.node as { id: string }).id).toBe("a1");
    expect(flat(inner.tree)[1]?.props.style).toEqual({ left: 100, top: 184, width: 300 });
  });

  test("dado o pedido que o grafo já limpou, a caixa segue montada para a confirmação", () => {
    const { PermissionBoxes } = build();
    const m = mount(PermissionBoxes as Fn, { ...base, onResult: () => {} });
    m.rerender({ ...base, nodes: [agent("a1", false), agent("a2")], onResult: () => {} });
    expect(ofType(m.tree, Permission)).toHaveLength(1);
  });

  test("dado o nó que saiu dos visíveis, a caixa dele é esquecida", () => {
    const { PermissionBoxes } = build();
    const m = mount(PermissionBoxes as Fn, { ...base });
    m.rerender({ ...base, nodes: [agent("a2")] });
    m.rerender({ ...base, nodes: [agent("a1", false), agent("a2")] });
    expect(ofType(m.tree, Permission)).toHaveLength(0);
  });

  test("dado o toque, a camada monta o reconhecedor do surface e sem a prop não monta nada", () => {
    const { CanvasOverlays, TouchGestures } = build();
    expect(ofType(mount(CanvasOverlays, base).tree, TouchGestures)).toHaveLength(0);
    expect(ofType(mount(CanvasOverlays, { ...base, touch: { surface: null, onCamera: () => {} } }).tree, TouchGestures)).toHaveLength(1);
  });

  test("dado o quadro, ele deixa os ponteiros passarem e as camadas os reabilitam", () => {
    const { CanvasOverlays } = build();
    const tree = mount(CanvasOverlays, { ...base, minimap: { onCamera: () => {} } }).tree as El;
    expect(String(tree.props.className)).toContain("pointer-events-none");
    expect(String((tree.children[0] as El).props.className)).toContain("pointer-events-auto");
  });

  test("dado todas as camadas, a ordem de montagem é minimapa, permissão, balão, menu e toque", () => {
    const { CanvasOverlays } = build();
    const tree = mount(CanvasOverlays, {
      ...base, minimap: { onCamera: () => {} }, permission: {}, balloon: { nodeId: "a1", drafts: {}, onDrafts: () => {}, doc: {}, onClose: () => {} },
      menu: { target: { kind: "canvas" }, at: { x: 0, y: 0 }, registry: {}, commandCtx: {}, onAction: () => {}, onClose: () => {} }, touch: { surface: null, onCamera: () => {} },
    }).tree as El;
    expect(tree.children.map((c) => (c as El).props.key)).toEqual(["minimap", "permission", "balloon", "menu", "touch"]);
  });
});

describe("permissionSlots", () => {
  const id = (s: string) => new Set([s]);
  test("nó fora da tela não ganha caixa", () => {
    const far = { ...agent("a1", true), rect: { x: 5000, y: 5000, w: 300, h: 80 } };
    expect(Overlays.permissionSlots([far], id("a1"), CAM, VIEW, camera.worldToScreen)).toEqual([]);
  });
  test("nó estreito ganha a largura mínima e a caixa fica dentro da tela", () => {
    const edge = { ...agent("a1", true), rect: { x: 950, y: 10, w: 40, h: 20 } };
    const [slot] = Overlays.permissionSlots([edge], id("a1"), CAM, VIEW, camera.worldToScreen);
    expect(slot?.w).toBe(224);
    expect((slot?.x ?? 0) + (slot?.w ?? 0)).toBeLessThanOrEqual(VIEW.w);
  });
  test("o teto de caixas é imposto", () => {
    const many = Array.from({ length: Overlays.MAX_PERMISSION_BOXES + 5 }, (_, i) => agent(`n${i}`, true));
    const slots = Overlays.permissionSlots(many, new Set(many.map((n) => n.node.id)), CAM, VIEW, camera.worldToScreen);
    expect(slots).toHaveLength(Overlays.MAX_PERMISSION_BOXES);
  });
});

describe("gestureCamera", () => {
  test("pan vira panBy da câmera atual", () => {
    expect(Overlays.gestureCamera({ type: "pan", dx: 20, dy: -10 }, { x: 0, y: 0, k: 2 }, undefined, camera).camera).toEqual(camera.panBy({ x: 0, y: 0, k: 2 }, 20, -10));
  });
  test("a pinça parte da câmera do primeiro pinch e a guarda até o fim do gesto", () => {
    const first = Overlays.gestureCamera({ type: "pinch", startA: { x: 100, y: 100 }, startB: { x: 200, y: 100 }, a: { x: 100, y: 100 }, b: { x: 300, y: 100 } }, CAM, undefined, camera);
    expect(first.camera?.k).toBeCloseTo(2);
    const later = Overlays.gestureCamera({ type: "pinch", startA: { x: 100, y: 100 }, startB: { x: 200, y: 100 }, a: { x: 100, y: 100 }, b: { x: 400, y: 100 } }, first.camera as Camera, first.pinch, camera);
    expect(later.camera?.k).toBeCloseTo(3);
    expect(Overlays.gestureCamera({ type: "end" }, CAM, later.pinch, camera).pinch).toBeUndefined();
  });
  test("toque curto e longo não mexem na câmera", () => {
    expect(Overlays.gestureCamera({ type: "tap", at: { x: 1, y: 1 } }, CAM, undefined, camera).camera).toBeUndefined();
    expect(Overlays.gestureCamera({ type: "longpress", at: { x: 1, y: 1 } }, CAM, undefined, camera).camera).toBeUndefined();
  });
});

describe("TouchGestures", () => {
  type Listener = (ev: unknown) => void;
  const makeSurface = () => {
    const listeners = new Map<string, Listener>();
    return {
      style: { touchAction: "auto" },
      listeners,
      addEventListener: (name: string, fn: Listener) => { listeners.set(name, fn); },
      removeEventListener: (name: string, fn: Listener) => { if (listeners.get(name) === fn) listeners.delete(name); },
      getBoundingClientRect: () => ({ left: 10, top: 20 }),
    };
  };
  const ptr = (id: number, x: number, y: number, pointerType = "touch") => ({ pointerId: id, clientX: x, clientY: y, pointerType });
  const setup = (extra: Record<string, unknown> = {}) => {
    const { TouchGestures } = build();
    const surface = makeSurface();
    const cams: Camera[] = [];
    const taps: unknown[] = [];
    const longs: unknown[] = [];
    const m = mount<Record<string, unknown>>(TouchGestures as Fn, { surface, camera: CAM, onCamera: (c: Camera) => { cams.push(c); }, onTap: (p: unknown) => taps.push(p), onLongPress: (p: unknown) => longs.push(p), ...extra });
    return { surface, cams, taps, longs, m };
  };

  test("dado o surface, a camada escuta nele, desliga o gesto nativo e devolve tudo ao sair", () => {
    const { surface, m } = setup();
    expect([...surface.listeners.keys()].sort()).toEqual(["pointercancel", "pointerdown", "pointermove", "pointerup"]);
    expect(surface.style.touchAction).toBe("none");
    m.unmount();
    expect(surface.listeners.size).toBe(0);
    expect(surface.style.touchAction).toBe("auto");
  });

  test("dado um dedo que arrasta, a câmera sai por panBy em pixels do surface", () => {
    const { surface, cams } = setup();
    surface.listeners.get("pointerdown")?.(ptr(1, 110, 120));
    surface.listeners.get("pointermove")?.(ptr(1, 150, 120));
    expect(cams).toEqual([camera.panBy(CAM, 40, 0)]);
  });

  test("dado arrasto em dois movimentos antes de a página redesenhar, o segundo parte da câmera do primeiro", () => {
    const { surface, cams } = setup();
    surface.listeners.get("pointerdown")?.(ptr(1, 110, 120));
    surface.listeners.get("pointermove")?.(ptr(1, 150, 120));
    surface.listeners.get("pointermove")?.(ptr(1, 170, 120));
    expect(cams[1]).toEqual({ x: -60, y: 0, k: 1 });
  });

  test("dado dois dedos que se afastam, a escala cresce pela pinça", () => {
    const { surface, cams } = setup();
    surface.listeners.get("pointerdown")?.(ptr(1, 110, 120));
    surface.listeners.get("pointerdown")?.(ptr(2, 210, 120));
    surface.listeners.get("pointermove")?.(ptr(2, 310, 120));
    expect(cams.at(-1)?.k).toBeCloseTo(2);
  });

  test("dado toque curto, a página recebe o ponto em pixels do surface", () => {
    const { surface, taps } = setup();
    surface.listeners.get("pointerdown")?.(ptr(1, 110, 120));
    FAKE_TIME.now = 100;
    surface.listeners.get("pointerup")?.(ptr(1, 110, 120));
    expect(taps).toEqual([{ x: 100, y: 100 }]);
  });

  test("dado dedo parado, o timer do reconhecedor dispara o toque longo e o fim do gesto o para", () => {
    const { surface, longs } = setup();
    surface.listeners.get("pointerdown")?.(ptr(1, 110, 120));
    expect(timersLog.set).toHaveLength(1);
    expect(timersLog.set[0]?.ms).toBe(Overlays.TOUCH_TICK_MS);
    FAKE_TIME.now = 600;
    timersLog.set[0]?.run();
    expect(longs).toEqual([{ x: 100, y: 100 }]);
    surface.listeners.get("pointerup")?.(ptr(1, 110, 120));
    expect(timersLog.cleared).toBe(1);
  });

  test("dado o mouse, o gesto não é tratado como toque", () => {
    const { surface, cams } = setup();
    surface.listeners.get("pointerdown")?.(ptr(1, 110, 120, "mouse"));
    surface.listeners.get("pointermove")?.(ptr(1, 190, 120, "mouse"));
    expect(cams).toEqual([]);
    expect(timersLog.set).toHaveLength(0);
  });

  test("dado ponto inválido, o gesto é cancelado, o erro vai a onError e o timer para", () => {
    const errors: string[] = [];
    const { surface, cams } = setup({ onError: (msg: string) => errors.push(msg) });
    surface.listeners.get("pointerdown")?.(ptr(1, 110, 120));
    surface.listeners.get("pointermove")?.(ptr(1, Number.NaN, 120));
    expect(errors).toEqual(["toque inválido"]);
    expect(cams).toEqual([]);
    expect(timersLog.cleared).toBe(1);
  });

  test("dado pointercancel, nada é emitido e o timer para", () => {
    const { surface, cams, taps } = setup();
    surface.listeners.get("pointerdown")?.(ptr(1, 110, 120));
    surface.listeners.get("pointercancel")?.(ptr(1, 110, 120));
    expect(timersLog.cleared).toBe(1);
    expect(cams).toEqual([]);
    expect(taps).toEqual([]);
  });

  test("dado surface nulo, nada é escutado", () => {
    const { m } = setup({ surface: null });
    m.unmount();
    expect(timersLog.set).toEqual([]);
  });

  test("dado outro surface, o ouvinte do anterior sai", () => {
    const { surface, m } = setup();
    const next = makeSurface();
    m.rerender({ surface: next, camera: CAM, onCamera: () => {} });
    expect(surface.listeners.size).toBe(0);
    expect(next.listeners.size).toBe(4);
  });
});

describe("sem rede nem estado global", () => {
  const source = readFileSync(new URL("../../../kit/panel/ui/argos/canvas-overlays.tsx", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  test("o componente não chama fetch nem lê storage, janela ou documento", () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/localStorage|sessionStorage|\bwindow\.|\bdocument\.|XMLHttpRequest|WebSocket/);
  });
  test("o arquivo cabe em ~300 linhas", () => {
    expect(source.split("\n").length).toBeLessThanOrEqual(320);
  });
});
