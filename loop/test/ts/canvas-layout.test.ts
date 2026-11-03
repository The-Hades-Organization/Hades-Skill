// Interface de layout e layout livre (src/lib/canvas-layout.ts).
import { describe, expect, test } from "bun:test";
import { emptyCanvasDoc, type CanvasDoc, type CanvasNode } from "../../../src/lib/canvas-doc.ts";
import { createLayoutRegistry, defaultLayoutRegistry, FREE_LAYOUT, FREE_LAYOUT_ID, LAYOUT_GAP, LOOSE_ROW_NODES, type CanvasLayout, type EnteringNode } from "../../../src/lib/canvas-layout.ts";
import { REGISTRY_ERRORS, RegistryError } from "../../../src/lib/canvas-types.ts";

const node = (id: string, x: number, y: number, w = 200, h = 66): CanvasNode => ({ id, type: "agent", x, y, w, h, z: 0, data: {}, locked: false, blurred: false });
const docOf = (...nodes: CanvasNode[]): CanvasDoc => ({ ...emptyCanvasDoc(), nodes });
const entering = (id: string, w = 200, h = 66): EnteringNode => ({ id, type: "agent", w, h });
const links = (...pairs: [string, string][]): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const [a, b] of pairs) {
    out.set(a, [...(out.get(a) ?? []), b]);
    out.set(b, [...(out.get(b) ?? []), a]);
  }
  return out;
};
type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box, gap = 0): boolean => a.x - gap < b.x + b.w && b.x < a.x + a.w + gap && a.y - gap < b.y + b.h && b.y < a.y + a.h + gap;

describe("layout livre: onde entra o nó novo", () => {
  test("dado um vizinho assentado, então o nó novo entra encostado nele, com a folga, sem sobrepor", () => {
    const anchor = node("a", 1000, 500);
    const [placed] = FREE_LAYOUT.place({ doc: docOf(anchor), entering: [entering("b")], neighbors: links(["a", "b"]) });
    const box = { x: placed?.x ?? NaN, y: placed?.y ?? NaN, w: 200, h: 66 };
    expect(overlap(box, anchor, LAYOUT_GAP)).toBe(false);
    expect(Math.hypot(box.x - anchor.x, box.y - anchor.y)).toBeLessThanOrEqual(2 * (200 + LAYOUT_GAP));
  });

  test("dado um vizinho e a direita livre, então o nó novo vai para a direita (o fluxo é da esquerda para a direita)", () => {
    const [placed] = FREE_LAYOUT.place({ doc: docOf(node("a", 0, 0)), entering: [entering("b")], neighbors: links(["a", "b"]) });
    expect(placed?.x).toBe(200 + LAYOUT_GAP);
    expect(placed?.y).toBe(0);
  });

  test("dado vários nós novos com o mesmo vizinho, então nenhum sobrepõe outro nem o vizinho", () => {
    const anchor = node("hub", 0, 0);
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const placements = FREE_LAYOUT.place({ doc: docOf(anchor), entering: ids.map((id) => entering(id)), neighbors: links(...ids.map((id): [string, string] => ["hub", id])) });
    expect(placements).toHaveLength(ids.length);
    const boxes: Box[] = [anchor, ...placements.map((p) => ({ x: p.x, y: p.y, w: 200, h: 66 }))];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i] as Box, boxes[j] as Box, LAYOUT_GAP)).toBe(false);
  });

  test("dado nó novo ligado a outro nó novo, então ele nasce perto do que já foi posto (em cadeia)", () => {
    const doc = docOf(node("a", 0, 0));
    const placements = FREE_LAYOUT.place({ doc, entering: [entering("c"), entering("b")], neighbors: links(["a", "b"], ["b", "c"]) });
    const at = new Map(placements.map((p) => [p.id, p]));
    const b = at.get("b") as { x: number; y: number };
    const c = at.get("c") as { x: number; y: number };
    expect(Math.hypot(b.x, b.y)).toBeLessThan(Math.hypot(c.x, c.y));
    expect(Math.hypot(c.x - b.x, c.y - b.y)).toBeLessThanOrEqual(2 * (200 + LAYOUT_GAP));
  });

  test("dado dois vizinhos assentados, então o nó novo fica entre eles (centroide), livre de sobreposição", () => {
    const a = node("a", 0, 0);
    const c = node("c", 1200, 0);
    const [placed] = FREE_LAYOUT.place({ doc: docOf(a, c), entering: [entering("b")], neighbors: links(["a", "b"], ["c", "b"]) });
    expect(placed?.x).toBeGreaterThan(300);
    expect(placed?.x).toBeLessThan(700);
  });

  test("dado nó novo sem nenhum vizinho, então entra abaixo do conteúdo, sem sobrepor", () => {
    const content = [node("a", 0, 0), node("b", 300, 400)];
    const [placed] = FREE_LAYOUT.place({ doc: docOf(...content), entering: [entering("z")], neighbors: new Map() });
    const box = { x: placed?.x ?? NaN, y: placed?.y ?? NaN, w: 200, h: 66 };
    for (const other of content) expect(overlap(box, other, LAYOUT_GAP)).toBe(false);
    expect(box.y).toBeGreaterThanOrEqual(400 + 66);
  });

  test("dado muitos nós sem vizinho, então preenchem uma faixa em linhas (largura limitada) abaixo do conteúdo, sem sobrepor", () => {
    const content = [node("a", 0, 0)];
    const ids = Array.from({ length: 30 }, (_, i) => `n${String(i).padStart(2, "0")}`);
    const placements = FREE_LAYOUT.place({ doc: docOf(...content), entering: ids.map((id) => entering(id)), neighbors: new Map() });
    const boxes = placements.map((p) => ({ x: p.x, y: p.y, w: 200, h: 66 }));
    expect(new Set(boxes.map((b) => b.x)).size).toBe(LOOSE_ROW_NODES);
    expect(new Set(boxes.map((b) => b.y)).size).toBe(Math.ceil(ids.length / LOOSE_ROW_NODES));
    for (const [i, box] of boxes.entries()) {
      expect(box.y).toBeGreaterThanOrEqual(66 + LAYOUT_GAP);
      for (const other of boxes.slice(i + 1)) expect(overlap(box, other, 0)).toBe(false);
    }
  });

  test("dado documento vazio, então o primeiro nó vai para a origem e o segundo não sobrepõe", () => {
    const placements = FREE_LAYOUT.place({ doc: docOf(), entering: [entering("a"), entering("b")], neighbors: new Map() });
    expect(placements).toHaveLength(2);
    const [a, b] = placements.map((p) => ({ x: p.x, y: p.y, w: 200, h: 66 }));
    expect(overlap(a as Box, b as Box, LAYOUT_GAP)).toBe(false);
  });

  test("dado um nó enorme do usuário no caminho, então o nó novo o contorna (nó grande não quebra o índice)", () => {
    const big = node("wall", -5000, -5000, 10_000, 10_000);
    const [placed] = FREE_LAYOUT.place({ doc: docOf(big), entering: [entering("a")], neighbors: links(["wall", "a"]) });
    expect(overlap({ x: placed?.x ?? NaN, y: placed?.y ?? NaN, w: 200, h: 66 }, big, LAYOUT_GAP)).toBe(false);
  });

  test("dado o ponto de busca todo ocupado, então cai para baixo de todo o conteúdo em vez de sobrepor", () => {
    const wall = Array.from({ length: 1 }, () => node("wall", -40_000, -40_000, 80_000, 80_000));
    const [placed] = FREE_LAYOUT.place({ doc: docOf(...wall), entering: [entering("a")], neighbors: links(["wall", "a"]) });
    expect(placed?.y).toBeGreaterThanOrEqual(40_000);
  });

  test("dado a mesma entrada em outra ordem, então as mesmas posições (determinismo)", () => {
    const doc = docOf(node("a", 0, 0), node("b", 600, 300));
    const ids = ["n3", "n1", "n2", "n4"];
    const neighbors = links(["a", "n1"], ["a", "n2"], ["b", "n3"], ["n3", "n4"]);
    const forward = FREE_LAYOUT.place({ doc, entering: ids.map((id) => entering(id)), neighbors });
    const backward = FREE_LAYOUT.place({ doc, entering: [...ids].reverse().map((id) => entering(id)), neighbors });
    const key = (list: { id: string; x: number; y: number }[]) => [...list].sort((p, q) => p.id.localeCompare(q.id));
    expect(key(backward)).toEqual(key(forward));
    expect(FREE_LAYOUT.place({ doc, entering: ids.map((id) => entering(id)), neighbors })).toEqual(forward);
  });

  test("dado nós assentados, então place não muda o documento recebido", () => {
    const doc = docOf(node("a", 10, 20));
    const before = JSON.stringify(doc);
    FREE_LAYOUT.place({ doc, entering: [entering("b")], neighbors: links(["a", "b"]) });
    expect(JSON.stringify(doc)).toBe(before);
  });

  test("dado nada a posicionar, então lista vazia", () => {
    expect(FREE_LAYOUT.place({ doc: docOf(node("a", 0, 0)), entering: [], neighbors: new Map() })).toEqual([]);
  });

  test("dado o layout livre, então não tem arrange (a posição é do dono)", () => {
    expect(FREE_LAYOUT.arrange).toBeUndefined();
  });
});

describe("registro de layouts", () => {
  const layout = (over: Record<string, unknown> = {}): CanvasLayout => ({ id: "forces", label: "Forças", place: () => [], ...over }) as CanvasLayout;
  const codeOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      if (error instanceof RegistryError) return error.code;
      throw error;
    }
    throw new Error("não lançou");
  };

  test("dado o registro padrão, então só o livre", () => {
    const registry = defaultLayoutRegistry();
    expect(registry.list().map((l) => l.id)).toEqual([FREE_LAYOUT_ID]);
    expect(registry.get("free")).toBe(FREE_LAYOUT);
  });

  test("dado um layout novo válido (o de forças, depois), então registra ao lado do livre", () => {
    const registry = defaultLayoutRegistry();
    registry.register(layout({ arrange: () => [] }));
    expect(registry.list().map((l) => l.id)).toEqual(["free", "forces"]);
  });

  test("dado id repetido, campo faltando ou inválido, então o código estável", () => {
    const registry = defaultLayoutRegistry();
    expect(codeOf(() => registry.register(layout({ id: "free" })))).toBe(REGISTRY_ERRORS.duplicate);
    expect(codeOf(() => registry.register(layout({ place: undefined })))).toBe(REGISTRY_ERRORS.missingField);
    expect(codeOf(() => registry.register(layout({ label: undefined })))).toBe(REGISTRY_ERRORS.missingField);
    expect(codeOf(() => registry.register(layout({ id: "Forças" })))).toBe(REGISTRY_ERRORS.invalidField);
    expect(codeOf(() => registry.register(layout({ place: "x" })))).toBe(REGISTRY_ERRORS.invalidField);
    expect(codeOf(() => registry.register(layout({ arrange: 3 })))).toBe(REGISTRY_ERRORS.invalidField);
    expect(codeOf(() => createLayoutRegistry().register(null as unknown as CanvasLayout))).toBe(REGISTRY_ERRORS.invalidField);
    expect(registry.list()).toHaveLength(1);
  });
});
