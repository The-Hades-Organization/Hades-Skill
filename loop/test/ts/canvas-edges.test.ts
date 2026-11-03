// Grupo canvas-edges: estilo por tipo de aresta e arestas manuais (src/lib/canvas-edges.ts), com ida e volta pelo
// inverso. Lógica pura.
import { describe, expect, test } from "bun:test";
import { type CanvasDoc, type CanvasNode, emptyCanvasDoc, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, createHistory, HistoryError, invert, opDelete, perform, redo, undo } from "../../../src/lib/canvas-history";
import {
  edgeLegend, EdgeError, edgeStyle, GRAPH_EDGE_KINDS, MANUAL_EDGE_KIND, opCreateManualEdge, opRemoveManualEdge,
} from "../../../src/lib/canvas-edges";

const node = (id: string): CanvasNode => ({ id, type: "note", x: 0, y: 0, w: 10, h: 10, z: 0, data: {}, locked: false, blurred: false });
const docWith = (...ids: string[]): CanvasDoc => ({ ...emptyCanvasDoc(), nodes: ids.map(node) });
const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof EdgeError ? e.code : `outro:${String(e)}`; }
  return undefined;
};

describe("estilo", () => {
  test("os seis kinds do grafo e o manual têm estilo próprio e distinto", () => {
    const seen = new Set<string>();
    for (const kind of [...GRAPH_EDGE_KINDS, MANUAL_EDGE_KIND]) {
      const style = edgeStyle(kind);
      expect(style.known).toBe(true);
      seen.add(JSON.stringify([style.tone, style.dash, style.width]));
    }
    expect(seen.size).toBe(GRAPH_EDGE_KINDS.length + 1);
  });

  test("kind desconhecido recebe o neutro, sem seta, marcado como não conhecido", () => {
    expect(edgeStyle("qualquer")).toMatchObject({ known: false, arrow: false, tone: "muted" });
    expect(edgeStyle("constructor").known).toBe(false);
    expect(edgeStyle("__proto__").known).toBe(false);
  });

  test("a legenda lista os kinds conhecidos em ordem fixa", () => {
    expect(edgeLegend().map((item) => item.kind)).toEqual([...GRAPH_EDGE_KINDS, MANUAL_EDGE_KIND]);
  });

  test("o estilo devolvido é cópia: alterar não muda o próximo", () => {
    edgeStyle("stack").width = 99;
    expect(edgeStyle("stack").width).toBe(2);
  });
});

const historyCode = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof HistoryError ? e.code : `outro:${String(e)}`; }
  return undefined;
};
const apply = (doc: CanvasDoc, op: ReturnType<typeof opCreateManualEdge>): CanvasDoc => applyOp(doc, op);

describe("aresta manual", () => {
  test("cria entre dois nós quaisquer e o documento continua válido", () => {
    const doc = docWith("a", "b");
    const op = opCreateManualEdge(doc, "m1", "a", "b");
    expect(op.kind).toBe("edge-create");
    const next = apply(doc, op);
    expect(next.edges).toEqual([{ id: "m1", from: "a", to: "b", kind: "manual" }]);
    expect(() => validateCanvasDoc(next)).not.toThrow();
    expect(doc.edges).toEqual([]);
  });

  test("criar e desfazer voltam exatamente ao anterior; refazer repete (pela pilha)", () => {
    const doc = docWith("a", "b");
    const first = perform(createHistory(), doc, opCreateManualEdge(doc, "m1", "a", "b"));
    const back = undo(first.history, first.doc)!;
    expect(back.doc).toEqual(doc);
    expect(redo(back.history, back.doc)?.doc).toEqual(first.doc);
  });

  test("remover e desfazer devolvem a aresta ao mesmo índice", () => {
    let doc = docWith("a", "b", "c");
    for (const [id, f, t] of [["m1", "a", "b"], ["m2", "b", "c"], ["m3", "a", "c"]] as const) doc = apply(doc, opCreateManualEdge(doc, id, f, t));
    const op = opRemoveManualEdge(doc, "m2");
    expect(op.kind).toBe("edge-delete");
    const removed = apply(doc, op);
    expect(removed.edges.map((e) => e.id)).toEqual(["m1", "m3"]);
    expect(applyOp(removed, invert(op))).toEqual(doc);
  });

  test("aresta para nó inexistente é recusada, na criação e na aplicação", () => {
    const doc = docWith("a", "b");
    expect(codeOf(() => opCreateManualEdge(doc, "m", "a", "fantasma"))).toBe("edges_dangling_node");
    expect(codeOf(() => opCreateManualEdge(doc, "m", "fantasma", "a"))).toBe("edges_dangling_node");
    const op = opCreateManualEdge(doc, "m", "a", "b");
    expect(historyCode(() => applyOp(docWith("a"), op))).toBe("history_dangling_reference");
  });

  test("recusa laço, par manual repetido, id repetido e id inválido", () => {
    const base = docWith("a", "b");
    const doc = apply(base, opCreateManualEdge(base, "m1", "a", "b"));
    expect(codeOf(() => opCreateManualEdge(doc, "m2", "a", "a"))).toBe("edges_self_loop");
    expect(codeOf(() => opCreateManualEdge(doc, "m2", "a", "b"))).toBe("edges_duplicate_edge");
    expect(codeOf(() => opCreateManualEdge(doc, "m1", "b", "a"))).toBe("edges_duplicate_id");
    expect(codeOf(() => opCreateManualEdge(doc, "tem espaço", "b", "a"))).toBe("edges_invalid_id");
    expect(() => opCreateManualEdge(doc, "m2", "b", "a")).not.toThrow();
  });

  test("manual entre os mesmos nós de uma aresta do grafo é permitida", () => {
    const base = { ...docWith("a", "b"), edges: [{ id: "g1", from: "a", to: "b", kind: "stack" }] };
    expect(() => opCreateManualEdge(base, "m1", "a", "b")).not.toThrow();
  });

  test("teto de arestas do documento", () => {
    const edges = Array.from({ length: 5000 }, (_, i) => ({ id: `g${i}`, from: "a", to: "b", kind: "stack" }));
    expect(codeOf(() => opCreateManualEdge({ ...docWith("a", "b"), edges }, "m", "b", "a"))).toBe("edges_limit_exceeded");
  });

  test("remover: aresta inexistente e aresta do grafo são recusadas", () => {
    const doc = { ...docWith("a", "b"), edges: [{ id: "g1", from: "a", to: "b", kind: "stack" }] };
    expect(codeOf(() => opRemoveManualEdge(doc, "nada"))).toBe("edges_missing_edge");
    expect(codeOf(() => opRemoveManualEdge(doc, "g1"))).toBe("edges_not_manual");
  });

  test("aplicar remoção de aresta que já saiu e criação com id em uso lançam sem alterar", () => {
    const doc = docWith("a", "b");
    const create = opCreateManualEdge(doc, "m", "a", "b");
    const done = apply(doc, create);
    expect(historyCode(() => applyOp(done, create))).toBe("history_duplicate_target");
    expect(historyCode(() => applyOp(doc, invert(create)))).toBe("history_missing_target");
    expect(done.edges).toHaveLength(1);
  });

  test("excluir um nó pela pilha leva a aresta manual junto, como qualquer outra", () => {
    const doc = docWith("a", "b");
    const withEdge = apply(doc, opCreateManualEdge(doc, "m", "a", "b"));
    expect(applyOp(withEdge, opDelete(withEdge, ["a"])).edges).toEqual([]);
  });
});
