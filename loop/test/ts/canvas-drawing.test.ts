// Grupo canvas-drawing: modelo do desenho como entidade (src/lib/canvas-drawing.ts) — formato versionado e validação, limites,
// conectores que seguem o elemento, leitura estruturada, SVG, acesso pelas conexões e desfazer. Lógica pura.
import { describe, expect, test } from "bun:test";
import { type CanvasDoc, type CanvasNode, LINK_EDGE_KIND, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { createHistory, perform, redo, undo } from "../../../src/lib/canvas-history";
import {
  addElement, canReadDrawing, canWriteDrawing, type ConnectorElement, connectorEnds, createDrawingNode, describeDrawing, DRAWING_ERRORS, DRAWING_LIMITS,
  DrawingError, type DrawingScene, drawingChainFrom, drawingToSvg, emptyScene, moveElement, opSetDrawing, readableDrawingsOf, readDrawingData,
  removeElement, sceneBounds, setElementText, directDrawingsOf,
} from "../../../src/lib/canvas-drawing";
import { OWNER } from "../../../src/lib/canvas-note";
import { linkMeaning, linkRefusal } from "../../../src/lib/canvas-links";

const AGENT = "agent:proj:impl-1";
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof DrawingError) return error.code;
    throw error;
  }
  return "no-error";
};
const node = (id: string, type: string, data: Record<string, unknown> = {}): CanvasNode => ({ id, type, x: 0, y: 0, w: 100, h: 60, z: 0, data, locked: false, blurred: false });
const doc = (nodes: CanvasNode[] = [], edges: CanvasDoc["edges"] = []): CanvasDoc => validateCanvasDoc({ v: 1, rev: 1, nodes, edges, groups: [] });
const link = (id: string, from: string, to: string): CanvasDoc["edges"][number] => ({ id, from, to, kind: LINK_EDGE_KIND });
const rect = (id: string, x = 0, y = 0, w = 100, h = 50) => ({ id, type: "rect", x, y, w, h });
const sceneOf = (...elements: Record<string, unknown>[]): DrawingScene => readDrawingData({ v: 1, elements });
const connector = (scene: DrawingScene, id: string): ConnectorElement => {
  const found = scene.elements.find((el) => el.id === id);
  if (!found || (found.type !== "arrow" && found.type !== "line")) throw new Error(`sem conector ${id}`);
  return found;
};

describe("formato e validação", () => {
  test("dado uma cena completa, quando lida, então devolve cópia com todos os tipos de elemento", () => {
    const raw = {
      v: 1, title: "Fluxo",
      elements: [
        { id: "a", type: "rect", x: 0, y: 0, w: 80, h: 40, stroke: "#ff0000", fill: "#00ff0080", width: 3 },
        { id: "b", type: "ellipse", x: 200, y: 0, w: 80, h: 40 },
        { id: "s", type: "stroke", points: [[0, 0], [5, 5], [10, 0]], width: 2 },
        { id: "c", type: "arrow", from: { ref: "a" }, to: { ref: "b" } },
        { id: "l", type: "line", from: { x: 0, y: 100 }, to: { x: 50, y: 100 } },
        { id: "t", type: "text", x: 10, y: 10, text: "olá\nmundo", size: 20 },
      ],
    };
    const scene = readDrawingData(raw);
    expect(scene as unknown).toEqual(raw);
    expect(scene.elements).not.toBe(raw.elements);
  });

  test("dado versão desconhecida ou ausente, quando lida, então é recusada com código próprio", () => {
    expect(codeOf(() => readDrawingData({ v: 2, elements: [] }))).toBe(DRAWING_ERRORS.unsupportedVersion);
    expect(codeOf(() => readDrawingData({ elements: [] }))).toBe(DRAWING_ERRORS.unsupportedVersion);
    expect(codeOf(() => readDrawingData({ v: "1", elements: [] }))).toBe(DRAWING_ERRORS.unsupportedVersion);
  });

  test("dado entrada que não é objeto, campo desconhecido ou elements que não é lista, então recusa invalid_data", () => {
    for (const raw of [null, [], "x", 3]) expect(codeOf(() => readDrawingData(raw))).toBe(DRAWING_ERRORS.invalidData);
    expect(codeOf(() => readDrawingData({ v: 1, elements: [], extra: 1 }))).toBe(DRAWING_ERRORS.invalidData);
    expect(codeOf(() => readDrawingData({ v: 1, elements: {} }))).toBe(DRAWING_ERRORS.invalidData);
  });

  test("dado elemento malformado, então recusa pelo código certo", () => {
    const bad = (el: Record<string, unknown>): string => codeOf(() => sceneOf(el));
    expect(bad({ id: "a", type: "polygon" })).toBe(DRAWING_ERRORS.invalidElement);
    expect(bad({ id: "a b", type: "rect", x: 0, y: 0, w: 1, h: 1 })).toBe(DRAWING_ERRORS.invalidId);
    expect(bad({ id: "a", type: "rect", x: 0, y: 0, w: 0, h: 1 })).toBe(DRAWING_ERRORS.invalidElement);
    expect(bad({ id: "a", type: "rect", x: Number.NaN, y: 0, w: 1, h: 1 })).toBe(DRAWING_ERRORS.invalidElement);
    expect(bad({ id: "a", type: "rect", x: 0, y: 0, w: 1, h: 1, stroke: "red" })).toBe(DRAWING_ERRORS.invalidElement);
    expect(bad({ id: "a", type: "rect", x: 0, y: 0, w: 1, h: 1, width: 65 })).toBe(DRAWING_ERRORS.invalidElement);
    expect(bad({ id: "a", type: "rect", x: 0, y: 0, w: 1, h: 1, onclick: "x" })).toBe(DRAWING_ERRORS.invalidElement);
    expect(bad({ id: "a", type: "text", x: 0, y: 0, text: "   " })).toBe(DRAWING_ERRORS.invalidElement);
    expect(bad({ id: "a", type: "text", x: 0, y: 0, text: "x", size: 4 })).toBe(DRAWING_ERRORS.invalidElement);
    expect(bad({ id: "a", type: "stroke", points: [] })).toBe(DRAWING_ERRORS.invalidElement);
    expect(bad({ id: "a", type: "stroke", points: [[1]] })).toBe(DRAWING_ERRORS.invalidElement);
    expect(bad({ id: "a", type: "arrow", from: { x: 0 }, to: { x: 1, y: 1 } })).toBe(DRAWING_ERRORS.invalidElement);
    expect(bad({ id: "a", type: "arrow", from: { ref: "" }, to: { x: 1, y: 1 } })).toBe(DRAWING_ERRORS.invalidConnector);
  });

  test("dado fill em traço ou em seta, então campo desconhecido é recusado", () => {
    expect(codeOf(() => sceneOf({ id: "s", type: "stroke", points: [[0, 0]], fill: "#fff" }))).toBe(DRAWING_ERRORS.invalidElement);
    expect(codeOf(() => sceneOf({ id: "c", type: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, fill: "#fff" }))).toBe(DRAWING_ERRORS.invalidElement);
  });

  test("dado id repetido, então duplicate_id", () => {
    expect(codeOf(() => sceneOf(rect("a"), rect("a")))).toBe(DRAWING_ERRORS.duplicateId);
  });

  test("dado título longo ou com controle, então invalid_title; título vazio some", () => {
    expect(codeOf(() => readDrawingData({ v: 1, elements: [], title: "x".repeat(DRAWING_LIMITS.titleChars + 1) }))).toBe(DRAWING_ERRORS.invalidTitle);
    expect(codeOf(() => readDrawingData({ v: 1, elements: [], title: "a\u0000b" }))).toBe(DRAWING_ERRORS.invalidTitle);
    expect(readDrawingData({ v: 1, elements: [], title: "  " }).title).toBeUndefined();
    expect(readDrawingData({ v: 1, elements: [], title: " Fluxo " }).title).toBe("Fluxo");
  });
});

describe("limites", () => {
  test("dado exatamente o máximo de elementos, então passa; um a mais, limit_exceeded", () => {
    const many = (n: number): Record<string, unknown>[] => Array.from({ length: n }, (_, i) => rect(`r${i}`));
    expect(sceneOf(...many(DRAWING_LIMITS.elements)).elements).toHaveLength(DRAWING_LIMITS.elements);
    expect(codeOf(() => sceneOf(...many(DRAWING_LIMITS.elements + 1)))).toBe(DRAWING_ERRORS.limitExceeded);
  });

  test("dado traço no máximo de pontos, então passa; um a mais, limit_exceeded", () => {
    const stroke = (n: number): Record<string, unknown> => ({ id: "s", type: "stroke", points: Array.from({ length: n }, (_, i) => [i, i]) });
    expect(sceneOf(stroke(DRAWING_LIMITS.strokePoints)).elements).toHaveLength(1);
    expect(codeOf(() => sceneOf(stroke(DRAWING_LIMITS.strokePoints + 1)))).toBe(DRAWING_ERRORS.limitExceeded);
  });

  test("dado pontos somados acima do total, então limit_exceeded mesmo com cada traço dentro do limite", () => {
    const strokes = Array.from({ length: 13 }, (_, i) => ({ id: `s${i}`, type: "stroke", points: Array.from({ length: 500 }, (_, k) => [k, i]) }));
    expect(codeOf(() => sceneOf(...strokes))).toBe(DRAWING_ERRORS.limitExceeded);
    expect(sceneOf(...strokes.slice(0, 12)).elements).toHaveLength(12);
  });

  test("dado texto no limite, então passa; acima, limit_exceeded", () => {
    expect(sceneOf({ id: "t", type: "text", x: 0, y: 0, text: "a".repeat(DRAWING_LIMITS.textChars) }).elements).toHaveLength(1);
    expect(codeOf(() => sceneOf({ id: "t", type: "text", x: 0, y: 0, text: "a".repeat(DRAWING_LIMITS.textChars + 1) }))).toBe(DRAWING_ERRORS.limitExceeded);
  });

  test("dado a cena no pior caso, então cabe no documento (1 MiB) com folga", () => {
    const strokes = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, type: "stroke", points: Array.from({ length: 500 }, (_, k) => [123456.78 + k, 987654.32 + i]) }));
    const bytes = JSON.stringify(sceneOf(...strokes)).length;
    expect(bytes).toBeLessThan(250_000);
  });
});

describe("conectores", () => {
  const base = (): DrawingScene => sceneOf(rect("a", 0, 0, 100, 50), { id: "b", type: "ellipse", x: 300, y: 0, w: 100, h: 50 }, { id: "c", type: "arrow", from: { ref: "a" }, to: { ref: "b" } });

  test("dado conector preso a dois elementos, quando resolvido, então as pontas ficam na borda virada para o outro", () => {
    const [a, b] = connectorEnds(base(), connector(base(), "c"));
    expect(a).toEqual({ x: 100, y: 25 });
    expect(b).toEqual({ x: 300, y: 25 });
  });

  test("dado elemento movido, quando o conector é resolvido, então a ponta segue o elemento", () => {
    const moved = moveElement(base(), "b", 0, 200);
    const [a, b] = connectorEnds(moved, connector(moved, "c"));
    expect(b.y).toBeGreaterThan(25);
    expect(a.x).toBeGreaterThan(50);
    expect(connector(moved, "c").to).toEqual({ ref: "b" });
  });

  test("dado conector com ponta livre e outra presa, quando o conector é movido, então só a livre anda", () => {
    const scene = sceneOf(rect("a", 0, 0, 100, 50), { id: "c", type: "line", from: { ref: "a" }, to: { x: 300, y: 25 } });
    const moved = moveElement(scene, "c", 10, 20);
    expect(connector(moved, "c").from).toEqual({ ref: "a" });
    expect(connector(moved, "c").to).toEqual({ x: 310, y: 45 });
  });

  test("dado alvo apagado, quando removido, então a ponta presa vira ponto livre onde estava", () => {
    const next = removeElement(base(), "b");
    expect(next.elements.map((el) => el.id)).toEqual(["a", "c"]);
    expect(connector(next, "c").from).toEqual({ ref: "a" });
    expect(connector(next, "c").to).toEqual({ x: 300, y: 25 });
  });

  test("dado ref para elemento que não existe ou para outro conector, então invalid_connector", () => {
    expect(codeOf(() => sceneOf({ id: "c", type: "arrow", from: { ref: "zzz" }, to: { x: 1, y: 1 } }))).toBe(DRAWING_ERRORS.invalidConnector);
    expect(codeOf(() => sceneOf(rect("a"), { id: "c", type: "line", from: { ref: "a" }, to: { x: 1, y: 1 } }, { id: "d", type: "line", from: { ref: "c" }, to: { x: 1, y: 1 } }))).toBe(DRAWING_ERRORS.invalidConnector);
  });

  test("dado elipse como alvo, então a ponta cai na elipse e não na caixa", () => {
    const scene = sceneOf({ id: "e", type: "ellipse", x: 0, y: 0, w: 100, h: 100 }, { id: "c", type: "line", from: { ref: "e" }, to: { x: 200, y: 200 } });
    const [a] = connectorEnds(scene, connector(scene, "c"));
    expect(a.x).toBeCloseTo(50 + 50 / Math.SQRT2, 5);
    expect(a.y).toBeCloseTo(50 + 50 / Math.SQRT2, 5);
  });
});

describe("edição pura", () => {
  test("dado cena vazia, quando acrescenta sem id, então ganha e1, e2…", () => {
    const first = addElement(emptyScene(), { type: "rect", x: 0, y: 0, w: 10, h: 10 });
    expect(first.id).toBe("e1");
    expect(addElement(first.scene, { type: "text", x: 0, y: 0, text: "oi" }).id).toBe("e2");
  });

  test("dado id já usado, quando acrescenta, então duplicate_id; cena original intacta", () => {
    const scene = sceneOf(rect("a"));
    expect(codeOf(() => addElement(scene, rect("a")))).toBe(DRAWING_ERRORS.duplicateId);
    expect(scene.elements).toHaveLength(1);
  });

  test("dado elemento inexistente, quando move, remove ou edita texto, então missing_element", () => {
    const scene = sceneOf(rect("a"));
    expect(codeOf(() => moveElement(scene, "x", 1, 1))).toBe(DRAWING_ERRORS.missingElement);
    expect(codeOf(() => removeElement(scene, "x"))).toBe(DRAWING_ERRORS.missingElement);
    expect(codeOf(() => setElementText(scene, "x", "oi"))).toBe(DRAWING_ERRORS.missingElement);
  });

  test("dado texto, quando troca o texto, então muda; em retângulo recusa", () => {
    const scene = sceneOf(rect("a"), { id: "t", type: "text", x: 0, y: 0, text: "antes" });
    expect(setElementText(scene, "t", "depois").elements[1]).toMatchObject({ text: "depois" });
    expect(codeOf(() => setElementText(scene, "a", "x"))).toBe(DRAWING_ERRORS.invalidElement);
  });

  test("dado traço, quando move, então todos os pontos andam", () => {
    const scene = sceneOf({ id: "s", type: "stroke", points: [[0, 0], [10, 5]] });
    expect(moveElement(scene, "s", 3, 4).elements[0]).toMatchObject({ points: [[3, 4], [13, 9]] });
  });

  test("dado deslocamento não finito, então invalid_element", () => {
    expect(codeOf(() => moveElement(sceneOf(rect("a")), "a", Number.NaN, 0))).toBe(DRAWING_ERRORS.invalidElement);
  });

  test("dado mover para fora do intervalo de coordenadas, então recusa em vez de gravar", () => {
    expect(codeOf(() => moveElement(sceneOf(rect("a")), "a", DRAWING_LIMITS.coordinate * 2, 0))).toBe(DRAWING_ERRORS.invalidElement);
  });
});

describe("leitura estruturada", () => {
  test("dado desenho com texto e conector, quando descrito, então traz elementos, textos e ligações", () => {
    const scene = readDrawingData({
      v: 1, title: "Arquitetura",
      elements: [rect("a", 0, 0, 100, 50), { id: "b", type: "ellipse", x: 300, y: 0, w: 100, h: 50 }, { id: "c", type: "arrow", from: { ref: "a" }, to: { ref: "b" } }, { id: "t", type: "text", x: 5, y: 60, text: "API" }, { id: "free", type: "line", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }],
    });
    const out = describeDrawing(scene);
    expect(out.title).toBe("Arquitetura");
    expect(out.elements.map((e) => e.id)).toEqual(["a", "b", "c", "t", "free"]);
    expect(out.elements[0]).toMatchObject({ type: "rect", x: 0, y: 0, w: 100, h: 50 });
    expect(out.texts).toEqual([{ id: "t", text: "API", x: 5, y: 60 }]);
    expect(out.links).toEqual([{ id: "c", kind: "arrow", from: "a", to: "b" }]);
  });

  test("dado cena vazia, então descrição vazia e limites nulos", () => {
    expect(describeDrawing(emptyScene())).toEqual({ v: 1, elements: [], texts: [], links: [] });
    expect(sceneBounds(emptyScene())).toBeUndefined();
  });
});

describe("SVG", () => {
  const scene = readDrawingData({
    v: 1, title: "A & B <x>",
    elements: [rect("a", 0, 0, 100, 50), { id: "c", type: "arrow", from: { ref: "a" }, to: { x: 200, y: 25 } }, { id: "t", type: "text", x: 0, y: 70, text: "<script>alert(1)</script>\nlinha 2" }, { id: "s", type: "stroke", points: [[0, 0], [10, 10]] }],
  });

  test("dado a cena, quando exportada, então é um SVG autônomo, determinístico e com cada elemento", () => {
    const svg = drawingToSvg(scene);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="')).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain("<rect ");
    expect(svg).toContain("<line ");
    expect(svg).toContain("<polyline ");
    expect(svg).toContain("<text ");
    expect(drawingToSvg(scene)).toBe(svg);
  });

  test("dado texto e título com marcação, quando exportados, então saem escapados (sem script no SVG)", () => {
    const svg = drawingToSvg(scene);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(svg).toContain("<title>A &amp; B &lt;x&gt;</title>");
  });

  test("dado desenho vazio, então um SVG válido em branco; com fundo, ganha o retângulo de fundo", () => {
    expect(drawingToSvg(emptyScene())).toMatch(/^<svg [^>]*><\/svg>$/);
    expect(drawingToSvg(emptyScene(), { background: "#ffffff" })).toContain('fill="#ffffff"');
    expect(codeOf(() => drawingToSvg(emptyScene(), { background: "url(x)" }))).toBe(DRAWING_ERRORS.invalidElement);
  });

  test("dado elemento fora da origem, então a viewBox o contém com respiro", () => {
    const far = sceneOf(rect("a", 500, 400, 100, 50));
    const match = /viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(drawingToSvg(far));
    const [x, y, w, h] = (match ?? []).slice(1).map(Number) as [number, number, number, number];
    expect(x).toBeLessThan(500);
    expect(y).toBeLessThan(400);
    expect(x + w).toBeGreaterThan(600);
    expect(y + h).toBeGreaterThan(450);
  });
});

describe("nó drawing e desfazer", () => {
  test("dado documento, quando cria o nó, então vira create do desfazer e ida e volta restaura exatamente", () => {
    const d = doc();
    const { op, node: created } = createDrawingNode(d, { id: "d1", x: 10, y: 20, title: "Esboço", elements: [rect("a")] });
    expect(created.type).toBe("drawing");
    expect(created.data).toEqual({ v: 1, title: "Esboço", elements: [rect("a")] });
    const done = perform(createHistory(), d, op);
    expect(done.doc.nodes).toHaveLength(1);
    expect(undo(done.history, done.doc)?.doc.nodes).toEqual([]);
  });

  test("dado id repetido ou cena inválida, quando cria, então recusa antes de virar operação", () => {
    const d = doc([node("d1", "drawing", { v: 1, elements: [] })]);
    expect(codeOf(() => createDrawingNode(d, { id: "d1", x: 0, y: 0 }))).toBe(DRAWING_ERRORS.duplicateId);
    expect(codeOf(() => createDrawingNode(d, { id: "d2", x: 0, y: 0, elements: [{ id: "a", type: "x" }] }))).toBe(DRAWING_ERRORS.invalidElement);
  });

  test("dado edição da cena, quando aplicada e desfeita e refeita, então cada edição é um passo e a cena volta exata", () => {
    let d = doc([node("d1", "drawing", { v: 1, elements: [] })]);
    let h = createHistory();
    const steps: DrawingScene[] = [];
    let scene = readDrawingData(d.nodes[0]?.data);
    for (const input of [rect("a"), { id: "t", type: "text", x: 0, y: 0, text: "oi" }]) {
      scene = addElement(scene, input).scene;
      const op = opSetDrawing(d, "d1", scene);
      if (!op) throw new Error("sem operação");
      const done = perform(h, d, op);
      h = done.history;
      d = done.doc;
      steps.push(scene);
    }
    expect(readDrawingData(d.nodes[0]?.data).elements).toHaveLength(2);
    const back = undo(h, d);
    expect(back && readDrawingData(back.doc.nodes[0]?.data).elements).toHaveLength(1);
    const again = back && redo(back.history, back.doc);
    expect(again && readDrawingData(again.doc.nodes[0]?.data)).toEqual(steps[1]);
  });

  test("dado cena igual à guardada, quando grava, então não há operação; nó que não é desenho recusa", () => {
    const d = doc([node("d1", "drawing", { v: 1, elements: [] }), node("n1", "note", { note: "x" })]);
    expect(opSetDrawing(d, "d1", emptyScene())).toBeUndefined();
    expect(codeOf(() => opSetDrawing(d, "n1", emptyScene()))).toBe(DRAWING_ERRORS.invalidNode);
    expect(codeOf(() => opSetDrawing(d, "nao-existe", emptyScene()))).toBe(DRAWING_ERRORS.invalidNode);
  });
});

describe("acesso pelas conexões", () => {
  const d = doc(
    [node(AGENT, "agent"), node("t1", "terminal", { name: "t" }), node("d1", "drawing", { v: 1, elements: [] }), node("d2", "drawing", { v: 1, elements: [] }), node("d3", "drawing", { v: 1, elements: [] }), node("n1", "note", { note: "x" })],
    [link("l1", "t1", "d1"), link("l2", "d1", "d2")],
  );

  test("dado terminal ligado a d1 que liga a d2, então d1 é direto, d2 vem pela cadeia e d3 não é alcançado", () => {
    expect(directDrawingsOf(d, "t1")).toEqual(["d1"]);
    expect(readableDrawingsOf(d, "t1")).toEqual([{ id: "d1", via: null }, { id: "d2", via: "d1" }]);
    expect(drawingChainFrom(d, "d1").map((e) => e.id)).toEqual(["d1", "d2"]);
  });

  test("dado agente, dono e não ligado, quando escreve, então só o dono e o ligado direto escrevem", () => {
    expect(canWriteDrawing(d, "d1", OWNER)).toBe(true);
    expect(canWriteDrawing(d, "d3", OWNER)).toBe(true);
    expect(canWriteDrawing(d, "d1", { kind: "agent", id: "t1" })).toBe(true);
    expect(canWriteDrawing(d, "d2", { kind: "agent", id: "t1" })).toBe(false);
    expect(canWriteDrawing(d, "d3", { kind: "agent", id: "t1" })).toBe(false);
    expect(canWriteDrawing(d, "n1", { kind: "agent", id: "t1" })).toBe(false);
    expect(canWriteDrawing(d, "nao-existe", { kind: "agent", id: "t1" })).toBe(false);
    expect(canWriteDrawing(d, "n1", OWNER)).toBe(false);
  });

  test("dado cadeia, quando lê, então d2 se lê e d3 não; nota e leitor que não é terminal não leem", () => {
    expect(canReadDrawing(d, "d2", "t1")).toBe(true);
    expect(canReadDrawing(d, "d3", "t1")).toBe(false);
    expect(directDrawingsOf(d, "n1")).toEqual([]);
    expect(directDrawingsOf(d, "d1")).toEqual([]);
  });

  test("dado laço na cadeia, então a leitura termina", () => {
    const loop = doc([node("a", "drawing", { v: 1, elements: [] }), node("b", "drawing", { v: 1, elements: [] })], [link("l1", "a", "b"), link("l2", "b", "a")]);
    expect(drawingChainFrom(loop, "a").map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("ligações: o lado drawing", () => {
  test("dado terminal e desenho, então conectam; desenho com desenho encadeia; com nota, não", () => {
    expect(linkMeaning("terminal", "drawing")).toBe("drawing-access");
    expect(linkMeaning("agent", "drawing")).toBe("drawing-access");
    expect(linkMeaning("drawing", "terminal")).toBe("drawing-access");
    expect(linkMeaning("drawing", "drawing")).toBe("drawing-chain");
    expect(linkMeaning("drawing", "note")).toBeUndefined();
    expect(linkMeaning("note", "drawing")).toBeUndefined();
  });

  test("dado documento com terminal e desenho, quando liga, então não há recusa; sem leitor, recusa", () => {
    const d = doc([node("t1", "terminal"), node("d1", "drawing", { v: 1, elements: [] }), node("n1", "note", { note: "x" })]);
    expect(linkRefusal(d, "t1", "d1")).toBeUndefined();
    expect(linkRefusal(d, "d1", "n1")).toBe("links_no_reader");
  });
});
