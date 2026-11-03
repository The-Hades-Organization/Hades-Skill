// Grupo canvas-neighbors: vizinhança do canvas (src/lib/canvas-neighbors.ts) — níveis 0/1/2, aresta nos dois sentidos,
// sem repetir quem já está num nível menor, esmaecido, seleção múltipla e entradas vazias ou inválidas.
import { describe, expect, test } from "bun:test";
import { NEIGHBOR_DEPTH, neighborhood, type NeighborEdge } from "../../../src/lib/canvas-neighbors";

const IDS = ["a", "b", "c", "d", "e", "f"];
// a → b → c → d, e solto, f aponta para a
const CHAIN: NeighborEdge[] = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }, { from: "f", to: "a" }];

describe("canvas-neighbors: níveis", () => {
  test("dado um nó, quando calcula, então 0 é ele, 1 os vizinhos diretos, 2 o segundo salto e o resto esmaece", () => {
    const n = neighborhood(["b"], CHAIN, IDS);
    expect(n.active).toBe(true);
    expect(n.levels[0]).toEqual(["b"]);
    expect(n.levels[1]).toEqual(["a", "c"]);
    expect(n.levels[2]).toEqual(["d", "f"]);
    expect(n.dimmed).toEqual(["e"]);
    expect(NEIGHBOR_DEPTH).toBe(2);
  });

  test("dado uma aresta só de saída e outra só de chegada, então os dois sentidos contam", () => {
    const n = neighborhood(["a"], CHAIN, IDS);
    expect(n.levels[1]).toEqual(["b", "f"]);
  });

  test("dado um ciclo, então ninguém aparece em dois níveis", () => {
    const ring: NeighborEdge[] = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }];
    const n = neighborhood(["a"], ring, ["a", "b", "c"]);
    expect(n.levels).toEqual([["a"], ["b", "c"], []]);
    const all = [...n.levels.flat(), ...n.dimmed];
    expect(new Set(all).size).toBe(all.length);
  });

  test("dado um nó alcançável por dois caminhos, então fica no menor nível", () => {
    const edges: NeighborEdge[] = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }];
    expect(neighborhood(["a"], edges, ["a", "b", "c"]).levels).toEqual([["a"], ["b", "c"], []]);
  });

  test("dado um nó a três saltos, então fica esmaecido", () => {
    const n = neighborhood(["a"], CHAIN, IDS);
    expect(n.levels[2]).toEqual(["c"]);
    expect(n.dimmed).toEqual(["d", "e"]);
  });

  test("dado vários nós selecionados, então todos são nível 0 e a expansão parte de todos", () => {
    const n = neighborhood(["a", "d"], CHAIN, IDS);
    expect(n.levels[0]).toEqual(["a", "d"]);
    expect(n.levels[1]).toEqual(["b", "c", "f"]);
    expect(n.levels[2]).toEqual([]);
    expect(n.dimmed).toEqual(["e"]);
  });

  test("dado vizinho de um selecionado que também é selecionado, então fica no nível 0", () => {
    const n = neighborhood(["a", "b"], CHAIN, IDS);
    expect(n.levels[0]).toEqual(["a", "b"]);
    expect(n.levels[1]).toEqual(["c", "f"]);
  });

  test("a ordem dos níveis segue a lista de nós, não a das arestas", () => {
    const n = neighborhood(["a"], [{ from: "a", to: "d" }, { from: "a", to: "b" }], ["d", "b", "a"]);
    expect(n.levels[1]).toEqual(["d", "b"]);
  });
});

describe("canvas-neighbors: vazio, limite e entrada inválida", () => {
  test("dado seleção vazia, então não há foco e nada esmaece", () => {
    expect(neighborhood([], CHAIN, IDS)).toEqual({ active: false, levels: [[], [], []], dimmed: [], unknown: [] });
  });

  test("dado grafo sem nós, então não há foco", () => {
    const n = neighborhood(["a"], [], []);
    expect(n.active).toBe(false);
    expect(n.unknown).toEqual(["a"]);
  });

  test("dado id selecionado que não existe, então é ignorado e listado em unknown", () => {
    const n = neighborhood(["b", "zzz", "zzz"], CHAIN, IDS);
    expect(n.levels[0]).toEqual(["b"]);
    expect(n.unknown).toEqual(["zzz"]);
  });

  test("dado só ids que não existem, então não há foco", () => {
    expect(neighborhood(["x"], CHAIN, IDS).active).toBe(false);
  });

  test("dado nó sem arestas, então só ele é nível 0 e o resto esmaece", () => {
    const n = neighborhood(["e"], CHAIN, IDS);
    expect(n.levels).toEqual([["e"], [], []]);
    expect(n.dimmed).toEqual(["a", "b", "c", "d", "f"]);
  });

  test("dado laço, aresta repetida e aresta para id inexistente, então não mudam o resultado", () => {
    const noisy: NeighborEdge[] = [...CHAIN, { from: "b", to: "b" }, { from: "a", to: "b" }, { from: "a", to: "ghost" }, { from: "ghost", to: "b" }];
    expect(neighborhood(["b"], noisy, IDS)).toEqual(neighborhood(["b"], CHAIN, IDS));
  });

  test("dado id repetido na lista de nós, então aparece uma vez", () => {
    const n = neighborhood(["a"], [{ from: "a", to: "b" }], ["a", "b", "b", "c", "c"]);
    expect(n.levels[1]).toEqual(["b"]);
    expect(n.dimmed).toEqual(["c"]);
  });

  test("dado ids de objeto herdado (`__proto__`, `constructor`), então são ids comuns", () => {
    const n = neighborhood(["__proto__"], [{ from: "__proto__", to: "constructor" }], ["__proto__", "constructor", "x"]);
    expect(n.levels).toEqual([["__proto__"], ["constructor"], []]);
    expect(n.dimmed).toEqual(["x"]);
  });

  test("dado o limite do documento (2000 nós em corrente), então termina e enxerga só 2 saltos", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `n${i}`);
    const edges = ids.slice(1).map((id, i) => ({ from: ids[i] as string, to: id }));
    const n = neighborhood(["n1000"], edges, ids);
    expect(n.levels.map((level) => level.length)).toEqual([1, 2, 2]);
    expect(n.dimmed.length).toBe(1995);
  });

  test("não altera as listas recebidas", () => {
    const edges = structuredClone(CHAIN);
    const ids = [...IDS];
    const selection = ["b"];
    neighborhood(selection, edges, ids);
    expect(edges).toEqual(CHAIN);
    expect(ids).toEqual(IDS);
    expect(selection).toEqual(["b"]);
  });
});
