// Grupo canvas-engine-shape: o gancho `nodeShape` do motor (kit/panel/ui/argos/canvas-engine.tsx) — o desenho de longe (ponto)
// e o bloco pela forma que a página devolve, e o desenho de sempre sem a prop. O motor roda sem navegador: DOM falso
// e um contexto 2D que só registra as chamadas.
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
  onSelectionChange(ids: readonly string[]): void;
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
  api: { onFrame(listener: (frame: FrameInfo) => void): () => void };
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

let layers: Recorder[] = [];
let frames: ((now: number) => void)[] = [];
const saved: Record<string, unknown> = {};
const STUBBED = ["document", "window", "getComputedStyle", "ResizeObserver", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "CanvasModel", "ArgosCanvas"];

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
  await import("../../../kit/panel/ui/argos/canvas-engine.tsx");
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

const node = (id: string, x: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, type: id, x, y: 0, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false, ...extra,
});
const docOf = (nodes: CanvasNode[]): CanvasDoc => ({ v: 1, rev: 0, nodes, edges: [], groups: [] });

/** Cria o motor com a câmera no zoom pedido e devolve o que a camada dos nós registrou depois do primeiro desenho. */
function paint(nodes: CanvasNode[], k: number, extra: Partial<EngineOptions> = {}): { engine: Engine; nodesLayer: Recorder } {
  const engine = Canvas.createCanvasEngine(
    { host: fakeElement(), canvasBox: fakeElement(), htmlLayer: fakeElement(), a11yBox: fakeElement() },
    { doc: docOf(nodes), selection: [], onSelectionChange: () => undefined, onOp: () => undefined, initialCamera: { x: 0, y: 0, k }, ...extra },
  );
  // a ordem de criação das camadas é grade, arestas, nós, sobreposição
  return { engine, nodesLayer: layers[2] as Recorder };
}
const names = (calls: Call[]): string[] => calls.map((c) => c[0]);
const count = (calls: Call[], name: string): number => calls.filter((c) => c[0] === name).length;
const DOT_K = 0.1;
const BLOCK_K = 0.4;
const FULL_K = 1;
const POINTS: Record<Exclude<Shape, "square">, number> = { diamond: 4, hexagon: 6, circle: 16 };

describe("canvas-engine-shape: o desenho por forma", () => {
  test("quadrado é um fillRect só, sem caminho montado", () => {
    const rec = recorder();
    Canvas.shapePaint.fillShape(rec.ctx, "square", node("a", 5));
    expect(rec.calls).toEqual([["fillRect", 5, 0, 100, 60]]);
  });

  for (const [shape, points] of Object.entries(POINTS) as [Exclude<Shape, "square">, number][]) {
    test(`${shape} preenche um caminho fechado de ${points} vértices e não usa fillRect`, () => {
      const rec = recorder();
      Canvas.shapePaint.fillShape(rec.ctx, shape, node("a", 0));
      expect(count(rec.calls, "moveTo")).toBe(1);
      expect(count(rec.calls, "lineTo")).toBe(points - 1);
      expect(names(rec.calls)[0]).toBe("beginPath");
      expect(names(rec.calls).slice(-2)).toEqual(["closePath", "fill"]);
      expect(count(rec.calls, "fillRect")).toBe(0);
    });

    test(`${shape}: o contorno usa o mesmo caminho e termina em stroke`, () => {
      const rec = recorder();
      Canvas.shapePaint.strokeShape(rec.ctx, shape, node("a", 0));
      expect(count(rec.calls, "lineTo")).toBe(points - 1);
      expect(names(rec.calls).at(-1)).toBe("stroke");
    });
  }

  test("o quadrado contorna com strokeRect", () => {
    const rec = recorder();
    Canvas.shapePaint.strokeShape(rec.ctx, "square", node("a", 0));
    expect(rec.calls).toEqual([["strokeRect", 0, 0, 100, 60]]);
  });

  test("forma fora do contrato vira quadrado e avisa uma vez por valor", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(Canvas.shapePaint.sanitizeShape("triangulo")).toBe("square");
      expect(Canvas.shapePaint.sanitizeShape("triangulo")).toBe("square");
      expect(Canvas.shapePaint.sanitizeShape(42)).toBe("square");
      expect(Canvas.shapePaint.sanitizeShape(null)).toBe("square");
      expect(warn).toHaveBeenCalledTimes(3);
      expect(Canvas.shapePaint.sanitizeShape(undefined)).toBe("square");
      expect(Canvas.shapePaint.sanitizeShape("hexagon")).toBe("hexagon");
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  test("o rótulo centrado cabe em cada forma: quanto mais cortada a forma, menor a fração da largura", () => {
    const fit = Canvas.shapePaint.LABEL_FIT;
    expect(fit.square).toBe(1);
    for (const shape of ["diamond", "hexagon", "circle"] as const) {
      expect(fit[shape]).toBeGreaterThan(0);
      expect(fit[shape]).toBeLessThan(1);
    }
  });
});

describe("canvas-engine-shape: o motor", () => {
  test("sem a prop, o desenho de longe é só fillRect, como antes", () => {
    const { nodesLayer } = paint([node("a", 0), node("b", 200)], DOT_K);
    expect(count(nodesLayer.calls, "fillRect")).toBe(2);
    expect(count(nodesLayer.calls, "beginPath")).toBe(0);
  });

  test("nodeShape devolvendo quadrado em tudo desenha igual a sem a prop", () => {
    const nodes = [node("a", 0), node("b", 200)];
    const plain = paint(nodes, DOT_K).nodesLayer.calls;
    layers = [];
    const squared = paint(nodes, DOT_K, { nodeShape: () => "square" }).nodesLayer.calls;
    expect(squared).toEqual(plain);
  });

  test("de longe, cada nó sai pela forma que a prop devolve", () => {
    const shapes: Record<string, Shape> = { a: "square", b: "diamond", c: "circle" };
    const { nodesLayer } = paint([node("a", 0), node("b", 200), node("c", 400)], DOT_K, { nodeShape: (n) => shapes[n.id] as Shape });
    expect(count(nodesLayer.calls, "fillRect")).toBe(1);
    expect(count(nodesLayer.calls, "closePath")).toBe(2);
    expect(count(nodesLayer.calls, "fill")).toBe(2);
    expect(count(nodesLayer.calls, "lineTo")).toBe(POINTS.diamond - 1 + POINTS.circle - 1);
  });

  test("documento vazio desenha sem erro e sem nenhuma chamada de forma", () => {
    const { nodesLayer } = paint([], DOT_K, { nodeShape: () => "hexagon" });
    expect(count(nodesLayer.calls, "beginPath")).toBe(0);
    expect(count(nodesLayer.calls, "fillRect")).toBe(0);
  });

  test("forma desconhecida devolvida pela página cai no quadrado sem derrubar o quadro", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { nodesLayer } = paint([node("a", 0)], DOT_K, { nodeShape: () => "estrela" as unknown as Shape });
      expect(count(nodesLayer.calls, "fillRect")).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("o bloco de forma própria leva o contorno na cor do nó e o rótulo centrado", () => {
    const { nodesLayer } = paint([node("alvo", 0)], BLOCK_K, { nodeShape: () => "hexagon", nodeColor: () => "#123456", describeNode: () => "Ok" });
    expect(nodesLayer.calls).toContainEqual(["set:strokeStyle", "#123456"]);
    expect(nodesLayer.calls).toContainEqual(["set:textAlign", "center"]);
    expect(nodesLayer.calls.some((c) => c[0] === "fillText" && c[1] === "Ok" && c[2] === 50 && c[3] === 30)).toBe(true);
    expect(count(nodesLayer.calls, "strokeRect")).toBe(0);
    expect(nodesLayer.calls.at(-1)).not.toEqual(["set:textAlign", "center"]);
  });

  test("o bloco quadrado segue com a faixa lateral, sem centralizar", () => {
    const { nodesLayer } = paint([node("alvo", 0)], BLOCK_K, { nodeShape: () => "square", describeNode: () => "Ok" });
    expect(count(nodesLayer.calls, "set:textAlign")).toBe(0);
    expect(count(nodesLayer.calls, "strokeRect")).toBe(1);
  });

  test("no detalhe completo o nó rico volta ao retângulo e o simples mantém a forma", () => {
    const { nodesLayer } = paint([node("rico", 0), node("simples", 300)], FULL_K, {
      nodeShape: () => "diamond",
      isRich: (n) => n.id === "rico",
    });
    // rico: cartão e cabeçalho em retângulo; simples: um caminho de losango
    expect(count(nodesLayer.calls, "closePath")).toBe(2);
    expect(count(nodesLayer.calls, "fillRect")).toBeGreaterThanOrEqual(2);
  });

  test("trocar nodeShape depois redesenha no próximo quadro; a mesma função não", () => {
    const nodes = [node("a", 0)];
    const shape = (): Shape => "diamond";
    const { engine, nodesLayer } = paint(nodes, DOT_K);
    // o quadro pendente da abertura roda antes: com ele marcado, o motor não pede outro
    while (frames.length > 0) frames.shift()?.(0);
    nodesLayer.calls.length = 0;
    engine.update({ nodeShape: shape });
    expect(frames.length).toBe(1);
    frames.shift()?.(0);
    expect(count(nodesLayer.calls, "closePath")).toBe(1);
    nodesLayer.calls.length = 0;
    engine.update({ nodeShape: shape });
    expect(frames.length).toBe(0);
    engine.update({ nodeShape: undefined });
    frames.shift()?.(0);
    expect(count(nodesLayer.calls, "fillRect")).toBe(1);
    expect(count(nodesLayer.calls, "closePath")).toBe(0);
  });

  test("o anel de seleção segue o retângulo do nó, qualquer que seja a forma", () => {
    const { nodesLayer } = paint([node("a", 0)], DOT_K, { selection: ["a"], nodeShape: () => "circle" });
    expect(count(nodesLayer.calls, "strokeRect")).toBe(1);
  });
});

// ---- cor de estado, rótulo e grade (aud-visual QT-3, QT-4, QT-5, TY-2; aud-critique CR-6) ----
describe("canvas-engine-shape: cor de estado e rótulo", () => {
  const fills = (calls: Call[]): string[] => calls.filter((c) => c[0] === "set:fillStyle").map((c) => String(c[1]));
  const fontOf = (calls: Call[]): string[] => calls.filter((c) => c[0] === "set:font").map((c) => String(c[1]));
  const LIVE = "#c8264a";
  const REST = "#7a5a6a";

  test("dado nó trabalhando de longe, então o preenchimento é o vivo diluído, não o cheio", () => {
    const { nodesLayer } = paint([node("a", 0)], DOT_K, { nodeColor: () => LIVE });
    const used = fills(nodesLayer.calls);
    expect(used).not.toContain(LIVE);
    expect(used.some((c) => c.startsWith("color-mix(") && c.includes(LIVE))).toBe(true);
  });

  test("dado nó concluído de longe, então o preenchimento é o muted diluído", () => {
    const { nodesLayer } = paint([node("a", 0)], DOT_K, { nodeColor: () => REST });
    const used = fills(nodesLayer.calls);
    expect(used).not.toContain(REST);
    expect(used.some((c) => c.startsWith("color-mix(") && c.includes(REST))).toBe(true);
  });

  test("dado cor de outro estado, então ela segue cheia", () => {
    const { nodesLayer } = paint([node("a", 0)], DOT_K, { nodeColor: () => "#c08a1a" });
    expect(fills(nodesLayer.calls)).toContain("#c08a1a");
  });

  test("dado nó selecionado de longe, então o nome sai fora da forma e a seleção usa o anel", () => {
    const { nodesLayer } = paint([node("a", 0)], DOT_K, { selection: ["a"], describeNode: () => "agente alfa", nodeColor: () => LIVE });
    const texts = nodesLayer.calls.filter((c) => c[0] === "fillText");
    expect(texts.length).toBe(1);
    expect(texts[0]?.[1]).toBe("agente alfa");
    expect(nodesLayer.calls).toContainEqual(["set:strokeStyle", "#c8264a"]);
  });

  test("dado nó cheio em zoom baixo, então a fonte de tela não passa de baixo de 11 px", () => {
    const { nodesLayer } = paint([node("a", 0)], 0.6, {});
    const px = fontOf(nodesLayer.calls).map((f) => Number.parseFloat(f) * 0.6);
    expect(px.length).toBeGreaterThan(0);
    for (const v of px) expect(v).toBeGreaterThanOrEqual(11 - 1e-9);
  });

  test("dado bloco, então a fonte de tela é a do piso do nó cheio", () => {
    const { nodesLayer } = paint([node("a", 0)], BLOCK_K, {});
    for (const f of fontOf(nodesLayer.calls)) expect(Number.parseFloat(f) * BLOCK_K).toBeCloseTo(11, 6);
  });
});

describe("canvas-engine-shape: abertura", () => {
  test("dado grafo enorme sem câmera salva, então o primeiro quadro abre no piso de 0,6", () => {
    const many = Array.from({ length: 300 }, (_, i) => node(`n${i}`, (i % 30) * 300, { y: Math.floor(i / 30) * 120 }));
    const seen: number[] = [];
    Canvas.createCanvasEngine(
      { host: fakeElement(), canvasBox: fakeElement(), htmlLayer: fakeElement(), a11yBox: fakeElement() },
      { doc: docOf(many), selection: [], onSelectionChange: () => undefined, onOp: () => undefined, onCameraChange: (c: { k: number }) => seen.push(c.k) } as Partial<EngineOptions> as EngineOptions,
    );
    expect(seen[0]).toBe(0.6);
  });
});

describe("canvas-engine-shape: grade", () => {
  test("dado zoom em que a linha maior fica abaixo do piso, então a grade só pinta o fundo", () => {
    paint([node("a", 0)], 0.1, {});
    const grid = (layers[0] as Recorder).calls;
    expect(count(grid, "stroke")).toBe(0);
  });

  test("dado zoom legível, então uma passada só desenha as linhas maiores", () => {
    paint([node("a", 0)], 1, {});
    const grid = (layers[0] as Recorder).calls;
    expect(count(grid, "stroke")).toBe(1);
  });
});

// ---- conexões (aresta `link`): a corda só anda à vista; fora do viewport nada anima nem pede quadro ----
describe("canvas-engine-shape: conexões fora da tela", () => {
  const FAR = 50_000;
  const box = (id: string, type: string, x: number, y: number): CanvasNode => ({ id, type, x, y, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false });
  /** `count` pares terminal–nota longe da câmera, cada um com a sua conexão (corda). */
  function farLinks(count: number, dx = 0): Pick<CanvasDoc, "nodes" | "edges"> {
    const nodes: CanvasNode[] = [];
    const edges: CanvasDoc["edges"] = [];
    for (let i = 0; i < count; i++) {
      nodes.push(box(`agent:p:a${i}`, "agent", FAR + dx, FAR + i * 100), box(`n${i}`, "note", FAR + 300 + dx, FAR + i * 100));
      edges.push({ id: `l${i}`, from: `agent:p:a${i}`, to: `n${i}`, kind: "link" });
    }
    return { nodes, edges };
  }
  const NEAR = [box("agent:p:v", "agent", 100, 100), box("nv", "note", 400, 100)];
  const NEAR_LINK = { id: "lv", from: "agent:p:v", to: "nv", kind: "link" };
  const withNear = (far: Pick<CanvasDoc, "nodes" | "edges">, dy = 0): CanvasDoc => ({
    v: 1, rev: 0, nodes: [...far.nodes, NEAR[0] as CanvasNode, { ...(NEAR[1] as CanvasNode), y: 100 + dy }], edges: [...far.edges, NEAR_LINK], groups: [],
  });
  let clock = 0;
  /** Roda os quadros pedidos (16 ms cada) até não sobrar nenhum; o teto pega laço que nunca dorme. */
  const drain = (limit = 2000): number => {
    let ran = 0;
    while (frames.length > 0 && ran < limit) {
      clock += 16;
      frames.shift()?.(clock);
      ran++;
    }
    return ran;
  };
  function open(doc: CanvasDoc): { engine: Engine; infos: FrameInfo[] } {
    const engine = Canvas.createCanvasEngine(
      { host: fakeElement(), canvasBox: fakeElement(), htmlLayer: fakeElement(), a11yBox: fakeElement() },
      { doc, selection: [], onSelectionChange: () => undefined, onOp: () => undefined, initialCamera: { x: 0, y: 0, k: 1 } },
    );
    const infos: FrameInfo[] = [];
    engine.api.onFrame((info) => infos.push(info));
    return { engine, infos };
  }

  test("dadas 200 conexões fora do viewport, quando os nós se movem, então nenhuma corda anda e nenhum quadro extra é pedido", () => {
    const { engine, infos } = open({ v: 1, rev: 0, ...farLinks(200), groups: [] });
    drain();
    engine.update({ doc: { v: 1, rev: 1, ...farLinks(200, 40), groups: [] } });
    expect(drain()).toBe(1);
    expect(infos.length).toBeGreaterThan(0);
    expect(infos.every((info) => info.ropes.visible === 0 && info.ropes.stepped === 0)).toBe(true);
    expect(frames).toHaveLength(0);
    engine.destroy();
  });

  test("dada uma corda à vista entre 200 fora, quando o nó dela se move, então só ela anda e o motor dorme quando assenta", () => {
    const far = farLinks(200);
    const { engine, infos } = open(withNear(far));
    drain();
    infos.length = 0;
    engine.update({ doc: withNear(far, 80) });
    const ran = drain();
    expect(ran).toBeGreaterThan(1);
    expect(ran).toBeLessThan(2000);
    expect(infos.some((info) => info.ropes.stepped === 1)).toBe(true);
    expect(infos.every((info) => info.ropes.visible === 1 && info.ropes.stepped <= 1)).toBe(true);
    expect(frames).toHaveLength(0);
    engine.destroy();
  });

  test("dado o movimento reduzido, quando o nó se move, então a corda vai direto ao repouso sem passos", () => {
    const media = g.window as { matchMedia: (q: string) => { matches: boolean } };
    const original = media.matchMedia;
    media.matchMedia = (q: string) => ({ ...original(q), matches: q.includes("reduced-motion") });
    try {
      const far = farLinks(10);
      const { engine, infos } = open(withNear(far));
      drain();
      engine.update({ doc: withNear(far, 80) });
      expect(drain()).toBe(1);
      expect(infos.every((info) => info.ropes.stepped === 0)).toBe(true);
      engine.destroy();
    } finally {
      media.matchMedia = original;
    }
  });
});
