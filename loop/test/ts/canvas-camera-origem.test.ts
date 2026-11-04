// Grupo canvas-camera-origem: a câmera do Argos só se move por gesto do dono. O motor roda sem navegador (DOM falso que
// guarda os ouvintes do host para o teste disparar eventos) e a seleção emitida leva a origem que a página usa para decidir.
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as argos from "../../../src/lib/canvas-argos";
import * as camera from "../../../src/lib/canvas-camera";
import * as docModule from "../../../src/lib/canvas-doc";
import * as history from "../../../src/lib/canvas-history";
import * as links from "../../../src/lib/canvas-links";
import * as selection from "../../../src/lib/canvas-selection";
import type { CanvasDoc, CanvasNode } from "../../../src/lib/canvas-doc";
import type { Shape } from "../../../src/lib/canvas-argos";

// Os tipos do .tsx não entram aqui (o tsconfig do projeto não tem jsx nem DOM): este é o contorno do que o teste usa dele.
interface EngineOptions {
  doc: CanvasDoc;
  selection: readonly string[];
  onSelectionChange(ids: readonly string[], origin?: string): void;
  onOp(op: unknown, next: CanvasDoc): void;
  initialCamera?: { x: number; y: number; k: number };
  describeNode?(node: CanvasNode): string;
  nodeColor?(node: CanvasNode): string;
  isRich?(node: CanvasNode): boolean;
  nodeShape?(node: CanvasNode): Shape;
}
interface FrameInfo {
  ms: number;
  ropes: { visible: number; stepped: number };
}
interface Engine {
  update(next: Partial<EngineOptions>): void;
  api: { onFrame(listener: (frame: FrameInfo) => void): () => void; focusNode(id: string): void; getCamera(): { x: number; y: number; k: number } };
  destroy(): void;
}
interface Ctx2D {
  canvas: unknown;
}
interface Element {
  readonly kind: "elemento-de-mentira";
}
interface ShapePaint {
  fillShape(ctx: Ctx2D, shape: Shape, n: CanvasNode): void;
  strokeShape(ctx: Ctx2D, shape: Shape, n: CanvasNode): void;
  sanitizeShape(shape: unknown): Shape;
  LABEL_FIT: Record<Shape, number>;
}
interface ArgosCanvasApi {
  createCanvasEngine(parts: { host: Element; canvasBox: Element; htmlLayer: Element; a11yBox: Element }, opts: EngineOptions): Engine;
  shapePaint: ShapePaint;
}

type Call = [name: string, ...args: unknown[]];
interface Recorder {
  ctx: Ctx2D;
  calls: Call[];
}

const g = globalThis as Record<string, unknown>;
const VIEW = { w: 800, h: 600 };

/** Contexto 2D falso: todo método vira um registro; atribuir propriedade também (`set:fillStyle`). */
function recorder(): Recorder {
  const calls: Call[] = [];
  const canvas = { remove: () => undefined, width: 0, height: 0, dataset: {}, style: {}, setAttribute: () => undefined };
  const ctx = new Proxy({ canvas } as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push([key, ...args]);
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      calls.push([`set:${key}`, value]);
      return true;
    },
  });
  return { ctx: ctx as unknown as Ctx2D, calls };
}

/** Elemento falso: aceita qualquer método do DOM que o motor chame e mede `VIEW`. */
function fakeElement(): Element {
  const own: Record<string, unknown> = { style: {}, dataset: {}, getBoundingClientRect: () => ({ width: VIEW.w, height: VIEW.h, left: 0, top: 0 }) };
  return new Proxy(own, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
    set: (t, k: string, v) => {
      t[k] = v;
      return true;
    },
  }) as unknown as Element;
}

type Handler = (e: unknown) => void;
let layers: Recorder[] = [];
let frames: ((now: number) => void)[] = [];
const saved: Record<string, unknown> = {};
const STUBBED = ["document", "window", "getComputedStyle", "ResizeObserver", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "CanvasModel", "ArgosCanvas", "Element", "Node"];

let Canvas: ArgosCanvasApi;

beforeAll(async () => {
  for (const key of STUBBED) saved[key] = g[key];
  g.CanvasModel = { doc: docModule, history, camera, selection, argos, links };
  g.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) };
  g.document = {
    createElement: (tag: string) => {
      if (tag !== "canvas") return fakeElement();
      const rec = recorder();
      layers.push(rec);
      (rec.ctx.canvas as { getContext: () => unknown }).getContext = () => rec.ctx;
      return rec.ctx.canvas;
    },
    documentElement: fakeElement(),
  };
  g.Element = class {};
  g.Node = class {};
  g.getComputedStyle = () => ({ getPropertyValue: () => "" });
  g.ResizeObserver = class {
    private readonly fn: () => void;
    constructor(fn: () => void) {
      this.fn = fn;
    }
    observe(): void {
      this.fn();
    }
    disconnect(): void {}
  };
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
  g.requestAnimationFrame = (fn: (now: number) => void) => frames.push(fn);
  g.cancelAnimationFrame = () => undefined;
  // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito (e não há jsx no tsconfig)
  await import("../../../kit/panel/ui/argos/canvas-engine.tsx?camera-origem"); // a query dá módulo próprio: o do outro teste já publicou e limpou o global
  Canvas = g.ArgosCanvas as ArgosCanvasApi;
});
afterAll(() => {
  for (const key of STUBBED) {
    if (saved[key] === undefined) delete g[key];
    else g[key] = saved[key];
  }
});
beforeEach(() => {
  layers = [];
  frames = [];
});


const node = (id: string, x: number): CanvasNode => ({ id, type: id, x, y: 0, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false });
const docOf = (nodes: CanvasNode[]): CanvasDoc => ({ v: 1, rev: 0, nodes, edges: [], groups: [] });

/** Host que guarda os ouvintes: `fire` dispara o evento como o navegador faria. */
function listeningHost(): { host: Element; fire(type: string, e?: Record<string, unknown>): void } {
  const handlers = new Map<string, Handler[]>();
  const own: Record<string, unknown> = {
    style: {}, dataset: {}, classList: { toggle: () => undefined },
    getBoundingClientRect: () => ({ width: VIEW.w, height: VIEW.h, left: 0, top: 0 }),
    addEventListener: (type: string, fn: Handler) => handlers.set(type, [...(handlers.get(type) ?? []), fn]),
  };
  const host = new Proxy(own, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
    set: (t, k: string, v) => {
      t[k] = v;
      return true;
    },
  }) as unknown as Element;
  const fire = (type: string, e: Record<string, unknown> = {}): void => {
    for (const fn of handlers.get(type) ?? []) fn({ preventDefault: () => undefined, stopPropagation: () => undefined, ...e });
  };
  return { host, fire };
}

interface Emitted {
  ids: readonly string[];
  origin: string | undefined;
}
function start(nodes: CanvasNode[], selection: string[] = []): { engine: Engine; fire: (type: string, e?: Record<string, unknown>) => void; emitted: Emitted[] } {
  const { host, fire } = listeningHost();
  const emitted: Emitted[] = [];
  const engine = Canvas.createCanvasEngine(
    { host, canvasBox: fakeElement(), htmlLayer: fakeElement(), a11yBox: fakeElement() },
    { doc: docOf(nodes), selection, onSelectionChange: (ids, origin) => emitted.push({ ids, origin }), onOp: () => undefined, initialCamera: { x: 0, y: 0, k: 1 } },
  );
  return { engine, fire, emitted };
}
const key = (k: string): Record<string, unknown> => ({ key: k, target: {}, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });

describe("canvas-camera-origem: o motor", () => {
  test("dado Espaço segurado, quando o zoom é pela roda e o Espaço é solto, então o nó focado não é selecionado", () => {
    const { engine, fire, emitted } = start([node("a", 0), node("b", 300)]);
    engine.api.focusNode("a");
    fire("keydown", key(" "));
    fire("wheel", { target: {}, ctrlKey: true, deltaY: -100, deltaMode: 0, clientX: 10, clientY: 10 });
    fire("keyup", key(" "));
    expect(emitted).toEqual([]);
  });

  test("dado Espaço segurado, quando a câmera anda por tecla e o Espaço é solto, então o nó focado não é selecionado", () => {
    const { engine, fire, emitted } = start([node("a", 0)]);
    engine.api.focusNode("a");
    fire("keydown", key(" "));
    fire("keydown", key("+"));
    fire("keyup", key(" "));
    expect(emitted).toEqual([]);
  });

  test("dado Espaço solto sem nenhum gesto, então o nó focado é selecionado, com origem de teclado", () => {
    const { engine, fire, emitted } = start([node("a", 0)]);
    engine.api.focusNode("a");
    fire("keydown", key(" "));
    fire("keyup", key(" "));
    expect(emitted).toEqual([{ ids: ["a"], origin: "key" }]);
  });

  test("dado clique do dono num nó, então a seleção sai com origem de ponteiro", () => {
    const { fire, emitted } = start([node("a", 0)]);
    fire("pointerdown", { target: {}, pointerId: 1, pointerType: "mouse", button: 0, clientX: 50, clientY: 30, shiftKey: false, altKey: false });
    expect(emitted).toEqual([{ ids: ["a"], origin: "pointer" }]);
  });

  test("dado grafo que muda (nó sai, volta recriado, outro entra), então o motor não emite seleção nenhuma", () => {
    const { engine, emitted } = start([node("a", 0), node("b", 300)], ["a", "b"]);
    engine.update({ doc: docOf([node("a", 0)]), selection: ["a"] });
    engine.update({ doc: docOf([node("a", 0), node("b", 300)]), selection: ["a"] });
    engine.update({ doc: docOf([node("a", 0), node("c", 600)]), selection: [] });
    expect(emitted).toEqual([]);
  });

  test("dado foco de teclado vindo de evento num nó, então não há seleção emitida e a câmera fica onde estava", () => {
    const { engine, emitted } = start([node("a", 0), node("far", 5000)]);
    const before = engine.api.getCamera();
    engine.api.focusNode("far");
    engine.api.focusNode("a");
    expect(emitted).toEqual([]);
    expect(engine.api.getCamera()).toEqual(before);
  });
});

describe("canvas-camera-origem: a regra", () => {
  test("seleção do dono (ponteiro, teclado, comando) leva a câmera; a da sincronia não", () => {
    expect(camera.selectionRevealsCamera("pointer")).toBe(true);
    expect(camera.selectionRevealsCamera("key")).toBe(true);
    expect(camera.selectionRevealsCamera("command")).toBe(true);
    expect(camera.selectionRevealsCamera("sync")).toBe(false);
  });

  test("o registro guarda só os últimos movimentos, do mais velho ao mais novo", () => {
    const trace = camera.createCameraTrace(2);
    const at = { x: 0, y: 0, k: 1 };
    for (const origin of ["a", "b", "c"]) trace.push({ origin, from: at, selectionBefore: [], selectionAfter: [] });
    expect(trace.entries.map((e) => e.origin)).toEqual(["b", "c"]);
  });
});
