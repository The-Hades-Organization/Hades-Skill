// Grupo canvas-walk: passeio pelas ligações (src/lib/canvas-walk.ts) — ordem determinística, desempate estável, ciclos,
// componentes soltos, e o passo para o próximo e o anterior. Lógica pura.
import { describe, expect, test } from "bun:test";
import { type CanvasDoc, type CanvasEdge, type CanvasNode } from "../../../src/lib/canvas-doc";
import { walkOrder, walkStep } from "../../../src/lib/canvas-walk";

const node = (id: string, x = 0, y = 0): CanvasNode => ({ id, type: "note", x, y, w: 10, h: 10, z: 0, data: {}, locked: false, blurred: false });
const edge = (from: string, to: string, id = `${from}>${to}`): CanvasEdge => ({ id, from, to, kind: "link" });
const graph = (nodes: CanvasNode[], edges: CanvasEdge[]): Pick<CanvasDoc, "nodes" | "edges"> => ({ nodes, edges });

describe("walkOrder", () => {
  test("segue as ligações em profundidade, com os filhos por posição", () => {
    // a -> b, a -> c, b -> d ; c fica à esquerda de b
    const doc = graph([node("a", 0, 0), node("b", 200, 100), node("c", 100, 100), node("d", 200, 200)], [edge("a", "b"), edge("a", "c"), edge("b", "d")]);
    expect(walkOrder(doc)).toEqual(["a", "c", "b", "d"]);
  });

  test("o mesmo grafo, em outra ordem de nós e de ligações, dá a mesma ordem", () => {
    const nodes = [node("a", 0, 0), node("b", 200, 100), node("c", 100, 100), node("d", 200, 200)];
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d")];
    expect(walkOrder(graph([...nodes].reverse(), [...edges].reverse()))).toEqual(walkOrder(graph(nodes, edges)));
  });

  test("empate de posição desempata pelo id", () => {
    const doc = graph([node("z"), node("m"), node("a")], []);
    expect(walkOrder(doc)).toEqual(["a", "m", "z"]);
  });

  test("começa pelos nós sem ligação de entrada, de cima para baixo e da esquerda para a direita", () => {
    const doc = graph([node("p", 0, 100), node("q", 50, 0), node("r", 0, 0), node("s", 0, 300)], [edge("p", "s")]);
    expect(walkOrder(doc)).toEqual(["r", "q", "p", "s"]);
  });

  test("losango: o nó de junção aparece uma vez, sob o primeiro caminho", () => {
    const doc = graph([node("a", 0, 0), node("b", 0, 100), node("c", 100, 100), node("d", 0, 200)], [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")]);
    expect(walkOrder(doc)).toEqual(["a", "b", "d", "c"]);
  });

  test("ciclo sem raiz começa pelo primeiro na ordem de posição", () => {
    const doc = graph([node("a", 0, 0), node("b", 0, 100), node("c", 0, 200)], [edge("a", "b"), edge("b", "c"), edge("c", "a")]);
    expect(walkOrder(doc)).toEqual(["a", "b", "c"]);
  });

  test("laço, ligação repetida e ligação para nó que não existe não mudam nada", () => {
    const plain = graph([node("a", 0, 0), node("b", 0, 100)], [edge("a", "b")]);
    const noisy = graph(plain.nodes, [edge("a", "b"), edge("a", "b", "dup"), edge("a", "a"), edge("a", "fora"), edge("fora", "b")]);
    expect(walkOrder(noisy)).toEqual(walkOrder(plain));
  });

  test("grafo vazio e nó solto", () => {
    expect(walkOrder(graph([], []))).toEqual([]);
    expect(walkOrder(graph([node("a")], []))).toEqual(["a"]);
  });

  test("cadeia longa não estoura a pilha e todo nó aparece uma vez", () => {
    const size = 2000;
    const nodes = Array.from({ length: size }, (_, i) => node(`n${i}`, 0, i));
    const edges = nodes.slice(1).map((n, i) => edge(`n${i}`, n.id));
    const order = walkOrder(graph(nodes, edges));
    expect(order).toHaveLength(size);
    expect(new Set(order).size).toBe(size);
    expect(order[0]).toBe("n0");
    expect(order[size - 1]).toBe(`n${size - 1}`);
  });
});

describe("walkStep", () => {
  const order = ["a", "b", "c"];

  test("próximo e anterior, dando a volta nas pontas", () => {
    expect(walkStep(order, "a", "next")).toBe("b");
    expect(walkStep(order, "c", "next")).toBe("a");
    expect(walkStep(order, "b", "previous")).toBe("a");
    expect(walkStep(order, "a", "previous")).toBe("c");
  });

  test("nó fora da ordem, ordem vazia ou de um nó só não tem para onde ir", () => {
    expect(walkStep(order, "zz", "next")).toBeUndefined();
    expect(walkStep([], "a", "next")).toBeUndefined();
    expect(walkStep(["a"], "a", "previous")).toBeUndefined();
  });

  test("ida e volta: próximo seguido de anterior devolve o nó", () => {
    for (const id of order) {
      const next = walkStep(order, id, "next") as string;
      expect(walkStep(order, next, "previous")).toBe(id);
    }
  });
});
