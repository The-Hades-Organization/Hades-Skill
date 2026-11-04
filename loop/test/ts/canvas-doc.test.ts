// Grupo canvas-doc: o documento do canvas (src/lib/canvas-doc.ts) — forma válida, cada forma inválida com o código
// estável, limites, migração por versão e mescla com o grafo vivo. Lógica pura: sem painel, sem disco.
import { describe, expect, test } from "bun:test";
import {
  CANVAS_ERRORS,
  CANVAS_LIMITS,
  CANVAS_MIGRATIONS,
  CANVAS_VERSION,
  CanvasError,
  type CanvasDoc,
  type CanvasMigration,
  type CanvasNode,
  emptyCanvasDoc,
  hiddenIds,
  mergeWithGraph,
  migrateCanvasDoc,
  parseCanvasText,
  readCanvasDoc,
  validateCanvasDoc,
  withHidden,
} from "../../../src/lib/canvas-doc";

type Dict = Record<string, unknown>;

const node = (id: string, over: Dict = {}): Dict => ({ id, type: "note", x: 10, y: 20, w: 100, h: 50, z: 0, data: { text: "oi" }, locked: false, blurred: false, ...over });
const live = (type: string, name: string, over: Dict = {}): Dict => node(`${type}:proj:${name}`, { type, data: {}, ...over });
const docOf = (over: Dict = {}): Dict => ({ v: 1, rev: 0, nodes: [], edges: [], groups: [], ...over });

const valid = (): Dict =>
  docOf({
    rev: 3,
    nodes: [live("agent", "impl-a", { x: -5.5, locked: true }), live("pr", "7", { blurred: true }), node("n1")],
    edges: [{ id: "e1", from: "agent:proj:impl-a", to: "n1", kind: "link" }],
    groups: [{ id: "g1", label: "meu grupo", members: ["n1", "pr:proj:7"] }],
  });

/** Código do erro que a validação lança para a entrada (ou "ok"). */
function codeOf(input: unknown): string {
  try {
    readCanvasDoc(input);
    return "ok";
  } catch (error) {
    if (error instanceof CanvasError) return error.code;
    throw error;
  }
}

describe("canvas-doc: documento válido", () => {
  test("dado um documento completo, quando valida, então devolve cópia igual e não o mesmo objeto", () => {
    const input = valid();
    const out = validateCanvasDoc(input);
    expect(out).toEqual(input as unknown as CanvasDoc);
    expect(out).not.toBe(input);
    expect(out.nodes[2]?.data).not.toBe((input.nodes as Dict[])[2]?.data);
  });

  test("dado o documento vazio v1, quando valida, então passa com rev 0", () => {
    expect(validateCanvasDoc(emptyCanvasDoc())).toEqual({ v: CANVAS_VERSION, rev: 0, nodes: [], edges: [], groups: [] });
  });

  test("dado nó livre com data aninhado dentro do limite de profundidade, então passa", () => {
    let data: Dict = { leaf: 1 };
    for (let i = 0; i < CANVAS_LIMITS.dataDepth - 2; i++) data = { inner: data };
    expect(codeOf(docOf({ nodes: [node("n1", { data })] }))).toBe("ok");
  });
});

describe("canvas-doc: formas inválidas", () => {
  const shape = CANVAS_ERRORS.invalidShape;
  const badNode = CANVAS_ERRORS.invalidNode;
  const cases: [string, unknown, string][] = [
    ["raiz que não é objeto", "texto", shape],
    ["raiz que é lista", [], shape],
    ["raiz nula", null, shape],
    ["campo desconhecido na raiz", docOf({ extra: 1 }), shape],
    ["rev ausente", { v: 1, nodes: [], edges: [], groups: [] }, shape],
    ["rev negativo", docOf({ rev: -1 }), shape],
    ["rev fracionário", docOf({ rev: 1.5 }), shape],
    ["rev texto", docOf({ rev: "1" }), shape],
    ["nodes que não é lista", docOf({ nodes: {} }), shape],
    ["edges ausente", { v: 1, rev: 0, nodes: [], groups: [] }, shape],
    ["groups nulo", docOf({ groups: null }), shape],
    ["nó que não é objeto", docOf({ nodes: ["n1"] }), badNode],
    ["nó com campo desconhecido", docOf({ nodes: [node("n1", { extra: 1 })] }), badNode],
    ["nó sem id", docOf({ nodes: [node("", {})] }), badNode],
    ["nó com id com espaço", docOf({ nodes: [node("a b")] }), badNode],
    ["nó com id número", docOf({ nodes: [node("n1", { id: 7 })] }), badNode],
    ["nó com id acima do limite", docOf({ nodes: [node("a".repeat(CANVAS_LIMITS.idChars + 1))] }), badNode],
    ["nó com type em maiúscula", docOf({ nodes: [node("n1", { type: "Note" })] }), badNode],
    ["nó com type vazio", docOf({ nodes: [node("n1", { type: "" })] }), badNode],
    ["nó com x texto", docOf({ nodes: [node("n1", { x: "10" })] }), badNode],
    ["nó com x nulo (NaN no JSON)", docOf({ nodes: [node("n1", { x: null })] }), badNode],
    ["nó com x acima do limite", docOf({ nodes: [node("n1", { x: CANVAS_LIMITS.coordinate + 1 })] }), badNode],
    ["nó com w zero", docOf({ nodes: [node("n1", { w: 0 })] }), badNode],
    ["nó com h negativo", docOf({ nodes: [node("n1", { h: -3 })] }), badNode],
    ["nó com z fracionário", docOf({ nodes: [node("n1", { z: 0.5 })] }), badNode],
    ["nó com locked texto", docOf({ nodes: [node("n1", { locked: "sim" })] }), badNode],
    ["nó sem blurred", docOf({ nodes: [node("n1", { blurred: undefined })] }), badNode],
    ["nó com data lista", docOf({ nodes: [node("n1", { data: [] })] }), badNode],
    ["nó sem data", docOf({ nodes: [node("n1", { data: undefined })] }), badNode],
    ["nó livre com data profundo demais", docOf({ nodes: [node("n1", { data: JSON.parse(`${'{"a":'.repeat(CANVAS_LIMITS.dataDepth + 1)}1${"}".repeat(CANVAS_LIMITS.dataDepth + 1)}`) })] }), badNode],
    ["nó vivo com conteúdo", docOf({ nodes: [live("agent", "x", { data: { label: "copiado" } })] }), badNode],
    ["nó vivo com id de outro tipo", docOf({ nodes: [node("pr:proj:7", { type: "agent", data: {} })] }), badNode],
    ["aresta que não é objeto", docOf({ nodes: [node("n1")], edges: [1] }), CANVAS_ERRORS.invalidEdge],
    ["aresta sem kind", docOf({ nodes: [node("n1")], edges: [{ id: "e", from: "n1", to: "n1" }] }), CANVAS_ERRORS.invalidEdge],
    ["aresta com campo a mais", docOf({ nodes: [node("n1")], edges: [{ id: "e", from: "n1", to: "n1", kind: "a", w: 1 }] }), CANVAS_ERRORS.invalidEdge],
    ["aresta sem id", docOf({ nodes: [node("n1")], edges: [{ from: "n1", to: "n1", kind: "a" }] }), CANVAS_ERRORS.invalidEdge],
    ["aresta para nó que não existe", docOf({ nodes: [node("n1")], edges: [{ id: "e", from: "n1", to: "zz", kind: "a" }] }), CANVAS_ERRORS.danglingReference],
    ["grupo sem membros", docOf({ nodes: [node("n1")], groups: [{ id: "g", label: "x", members: [] }] }), CANVAS_ERRORS.invalidGroup],
    ["grupo com membro repetido", docOf({ nodes: [node("n1")], groups: [{ id: "g", label: "x", members: ["n1", "n1"] }] }), CANVAS_ERRORS.invalidGroup],
    ["grupo com label número", docOf({ nodes: [node("n1")], groups: [{ id: "g", label: 1, members: ["n1"] }] }), CANVAS_ERRORS.invalidGroup],
    ["grupo com label acima do limite", docOf({ nodes: [node("n1")], groups: [{ id: "g", label: "x".repeat(CANVAS_LIMITS.labelChars + 1), members: ["n1"] }] }), CANVAS_ERRORS.invalidGroup],
    ["grupo com membro que não existe", docOf({ nodes: [node("n1")], groups: [{ id: "g", label: "x", members: ["zz"] }] }), CANVAS_ERRORS.danglingReference],
    ["ids de nó repetidos", docOf({ nodes: [node("n1"), node("n1")] }), CANVAS_ERRORS.duplicateId],
    ["ids de aresta repetidos", docOf({ nodes: [node("n1")], edges: [{ id: "e", from: "n1", to: "n1", kind: "a" }, { id: "e", from: "n1", to: "n1", kind: "b" }] }), CANVAS_ERRORS.duplicateId],
    ["ids de grupo repetidos", docOf({ nodes: [node("n1")], groups: [{ id: "g", label: "", members: ["n1"] }, { id: "g", label: "", members: ["n1"] }] }), CANVAS_ERRORS.duplicateId],
  ];
  test.each(cases)("dado %s, então o código é o estável", (_, input, code) => {
    expect(codeOf(input)).toBe(code);
  });

  test("o mesmo id pode existir em coleções diferentes (nó, aresta e grupo)", () => {
    expect(codeOf(docOf({ nodes: [node("x")], edges: [{ id: "x", from: "x", to: "x", kind: "a" }], groups: [{ id: "x", label: "", members: ["x"] }] }))).toBe("ok");
  });
});

describe("canvas-doc: limites", () => {
  const many = (n: number): Dict[] => Array.from({ length: n }, (_, i) => node(`n${i}`));

  test("no limite de nós passa; um acima é limit_exceeded", () => {
    expect(codeOf(docOf({ nodes: many(CANVAS_LIMITS.nodes) }))).toBe("ok");
    expect(codeOf(docOf({ nodes: many(CANVAS_LIMITS.nodes + 1) }))).toBe(CANVAS_ERRORS.limitExceeded);
  });

  test("no limite de arestas passa; um acima é limit_exceeded", () => {
    const edges = (n: number): Dict[] => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, from: "n0", to: "n1", kind: "a" }));
    const nodes = many(2);
    expect(codeOf(docOf({ nodes, edges: edges(CANVAS_LIMITS.edges) }))).toBe("ok");
    expect(codeOf(docOf({ nodes, edges: edges(CANVAS_LIMITS.edges + 1) }))).toBe(CANVAS_ERRORS.limitExceeded);
  });

  test("no limite de grupos passa; um acima é limit_exceeded", () => {
    const groups = (n: number): Dict[] => Array.from({ length: n }, (_, i) => ({ id: `g${i}`, label: "", members: ["n0"] }));
    expect(codeOf(docOf({ nodes: many(1), groups: groups(CANVAS_LIMITS.groups) }))).toBe("ok");
    expect(codeOf(docOf({ nodes: many(1), groups: groups(CANVAS_LIMITS.groups + 1) }))).toBe(CANVAS_ERRORS.limitExceeded);
  });

  test("corpo com exatamente o teto de bytes passa; um byte a mais é too_large", () => {
    const withPad = (n: number): string => JSON.stringify(docOf({ nodes: [node("n1", { data: { pad: "x".repeat(n) } })] }));
    const base = new TextEncoder().encode(withPad(0)).length;
    const exact = withPad(CANVAS_LIMITS.bodyBytes - base);
    expect(new TextEncoder().encode(exact).length).toBe(CANVAS_LIMITS.bodyBytes);
    expect(parseCanvasText(exact).nodes).toHaveLength(1);
    expect(() => parseCanvasText(withPad(CANVAS_LIMITS.bodyBytes - base + 1))).toThrow(expect.objectContaining({ code: CANVAS_ERRORS.tooLarge }));
  });

  test("o teto conta bytes, não caracteres", () => {
    const text = JSON.stringify(docOf({ nodes: [node("n1", { data: { pad: "é".repeat(CANVAS_LIMITS.bodyBytes / 2 + 1) } })] }));
    expect(text.length).toBeLessThan(CANVAS_LIMITS.bodyBytes + 200);
    expect(() => parseCanvasText(text)).toThrow(expect.objectContaining({ code: CANVAS_ERRORS.tooLarge }));
  });

  test("texto que não é JSON é invalid_json, e vazio também", () => {
    expect(() => parseCanvasText("{nope")).toThrow(expect.objectContaining({ code: CANVAS_ERRORS.invalidJson }));
    expect(() => parseCanvasText("")).toThrow(expect.objectContaining({ code: CANVAS_ERRORS.invalidJson }));
  });
});

describe("canvas-doc: migração por versão", () => {
  const toV2: CanvasMigration = (doc) => ({ ...doc, v: 2, renamed: doc.nodes });
  const toV3: CanvasMigration = (doc) => ({ v: 3, rev: doc.rev, nodes: doc.renamed, edges: doc.edges, groups: doc.groups });

  test("dada uma cadeia v1→v2→v3, quando migra para 3, então aplica cada passo na ordem", () => {
    const out = migrateCanvasDoc({ v: 1, rev: 2, nodes: ["a"], edges: [], groups: [] }, { 1: toV2, 2: toV3 }, 3) as Dict;
    expect(out).toEqual({ v: 3, rev: 2, nodes: ["a"], edges: [], groups: [] });
  });

  test("dado documento já na versão alvo, então volta o mesmo objeto sem rodar passo", () => {
    const input = docOf();
    expect(migrateCanvasDoc(input, { 1: () => { throw new Error("não devia rodar"); } }, 1)).toBe(input);
  });

  test("dada versão mais nova que a alvo, então é unsupported_version (não se adivinha a forma)", () => {
    expect(codeOf(docOf({ v: 2 }))).toBe(CANVAS_ERRORS.unsupportedVersion);
    expect(() => migrateCanvasDoc({ v: 4 }, { 1: toV2, 2: toV3 }, 3)).toThrow(expect.objectContaining({ code: CANVAS_ERRORS.unsupportedVersion }));
  });

  test("dado passo que falta na tabela, então é unsupported_version", () => {
    expect(() => migrateCanvasDoc({ v: 1 }, { 2: toV3 }, 3)).toThrow(expect.objectContaining({ code: CANVAS_ERRORS.unsupportedVersion }));
    expect(codeOf(docOf({ v: 0 }))).toBe(CANVAS_ERRORS.unsupportedVersion);
  });

  test("dado passo que não avança a versão, então é unsupported_version (sem laço infinito)", () => {
    expect(() => migrateCanvasDoc({ v: 1 }, { 1: (doc) => doc }, 3)).toThrow(expect.objectContaining({ code: CANVAS_ERRORS.unsupportedVersion }));
  });

  test("dado v que não é inteiro, ausente ou texto, então é unsupported_version", () => {
    for (const v of [1.5, "1", null, undefined]) expect(codeOf(docOf({ v }))).toBe(CANVAS_ERRORS.unsupportedVersion);
  });

  test("a tabela real só tem a v1: vazia, e o documento v1 atravessa a leitura intacto", () => {
    expect(Object.keys(CANVAS_MIGRATIONS)).toEqual([]);
    expect(readCanvasDoc(valid())).toEqual(valid() as unknown as CanvasDoc);
  });
});

describe("canvas-doc: mescla com o grafo vivo", () => {
  const base = (): CanvasDoc =>
    validateCanvasDoc(
      docOf({
        rev: 4,
        nodes: [live("agent", "impl-a"), live("agent", "impl-b", { x: 300 }), live("pr", "7"), node("n1"), node("n2")],
        edges: [
          { id: "e1", from: "agent:proj:impl-a", to: "agent:proj:impl-b", kind: "stack" },
          { id: "e2", from: "n1", to: "n2", kind: "link" },
          { id: "e3", from: "n1", to: "pr:proj:7", kind: "link" },
        ],
        groups: [
          { id: "g1", label: "só vivos", members: ["agent:proj:impl-b", "pr:proj:7"] },
          { id: "g2", label: "misto", members: ["agent:proj:impl-b", "n1"] },
        ],
      }),
    );
  const ref = (type: string, name: string) => ({ id: `${type}:proj:${name}`, type });

  test("dado grafo igual ao salvo, então nada sai e nada fica sem posição", () => {
    const doc = base();
    const out = mergeWithGraph(doc, [ref("agent", "impl-a"), ref("agent", "impl-b"), ref("pr", "7")]);
    expect(out).toEqual({ doc, unplaced: [], removed: [] });
  });

  test("dado nó vivo que sumiu do grafo, então sai com suas arestas, membros de grupo e grupo que ficou vazio", () => {
    const out = mergeWithGraph(base(), [ref("agent", "impl-a"), ref("pr", "7")]);
    expect(out.removed).toEqual(["agent:proj:impl-b"]);
    expect(out.doc.nodes.map((n) => n.id)).toEqual(["agent:proj:impl-a", "pr:proj:7", "n1", "n2"]);
    expect(out.doc.edges.map((e) => e.id)).toEqual(["e2", "e3"]);
    expect(out.doc.groups).toEqual([
      { id: "g1", label: "só vivos", members: ["pr:proj:7"] },
      { id: "g2", label: "misto", members: ["n1"] },
    ]);
    expect(validateCanvasDoc(out.doc)).toEqual(out.doc);
  });

  test("dado grupo que só tinha o nó sumido, então o grupo some", () => {
    const out = mergeWithGraph(base(), [ref("agent", "impl-a"), ref("agent", "impl-b")]);
    expect(out.removed).toEqual(["pr:proj:7"]);
    expect(out.doc.groups.map((g) => g.id)).toEqual(["g1", "g2"]);
    const alone = mergeWithGraph(base(), [ref("agent", "impl-a")]);
    expect(alone.doc.groups).toEqual([{ id: "g2", label: "misto", members: ["n1"] }]);
  });

  test("dado nó novo no grafo, então vai em unplaced na ordem do grafo e o documento não ganha posição inventada", () => {
    const doc = base();
    const out = mergeWithGraph(doc, [ref("unit", "u1"), ref("agent", "impl-a"), ref("agent", "impl-b"), ref("pr", "7"), { id: "gate:123", type: "gate" }]);
    expect(out.unplaced).toEqual(["unit:proj:u1", "gate:123"]);
    expect(out.doc.nodes).toEqual(doc.nodes);
  });

  test("dado nó que não é vivo, então a mescla nunca o remove", () => {
    const out = mergeWithGraph(base(), [ref("agent", "impl-a")]);
    expect(out.doc.nodes.map((n) => n.id)).toEqual(["agent:proj:impl-a", "n1", "n2"]);
    expect(out.removed).toEqual(["agent:proj:impl-b", "pr:proj:7"]);
  });

  test("dado tipo desconhecido ou repetido no grafo, então é ignorado", () => {
    const out = mergeWithGraph(base(), [{ id: "widget:x", type: "widget" }, ref("agent", "impl-a"), ref("agent", "impl-a"), ref("agent", "impl-b"), ref("pr", "7")]);
    expect(out.unplaced).toEqual([]);
  });

  test("a mescla não altera o documento de entrada", () => {
    const doc = base();
    const before = structuredClone(doc);
    mergeWithGraph(doc, [ref("unit", "u9")]);
    expect(doc).toEqual(before);
  });

  test("dado documento vazio e grafo vazio, então resultado vazio", () => {
    expect(mergeWithGraph(emptyCanvasDoc(), [])).toEqual({ doc: emptyCanvasDoc(), unplaced: [], removed: [] });
  });
});

describe("canvas-doc: nó vivo guarda só posição e estado visual", () => {
  test("o nó vivo validado leva data vazio e os campos visuais", () => {
    const out = validateCanvasDoc(docOf({ nodes: [live("gate", "1", { id: "gate:1", locked: true, blurred: true, z: 3 })] }));
    const n = out.nodes[0] as CanvasNode;
    expect([n.data, n.locked, n.blurred, n.z, n.x, n.y, n.w, n.h]).toEqual([{}, true, true, 3, 10, 20, 100, 50]);
  });
});

describe("canvas-doc: ocultos (hidden)", () => {
  const two = (over: Dict = {}): Dict => docOf({ nodes: [live("agent", "a"), node("n1")], ...over });

  test("dado documento antigo sem o campo, então segue válido e nada está oculto", () => {
    const out = validateCanvasDoc(two());
    expect("hidden" in out).toBe(false);
    expect(hiddenIds(out).size).toBe(0);
  });
  test("dado ocultos que apontam para nós do documento, então a lista volta na ordem dada", () => {
    expect(validateCanvasDoc(two({ hidden: ["n1", "agent:proj:a"] })).hidden).toEqual(["n1", "agent:proj:a"]);
  });
  test("dada lista vazia ou que não é lista, então é forma inválida", () => {
    for (const hidden of [[], "n1", { n1: true }]) {
      expect(() => validateCanvasDoc(two({ hidden }))).toThrow(expect.objectContaining({ code: CANVAS_ERRORS.invalidShape }));
    }
  });
  test("dado id repetido, então é id duplicado", () => {
    expect(() => validateCanvasDoc(two({ hidden: ["n1", "n1"] }))).toThrow(expect.objectContaining({ code: CANVAS_ERRORS.duplicateId }));
  });
  test("dado oculto sem nó no documento, então é referência pendurada", () => {
    expect(() => validateCanvasDoc(two({ hidden: ["n9"] }))).toThrow(expect.objectContaining({ code: CANVAS_ERRORS.danglingReference }));
  });
  test("dado mais ocultos que o limite, então é limite excedido", () => {
    const hidden = Array.from({ length: CANVAS_LIMITS.hidden + 1 }, (_, i) => `n${i}`);
    expect(() => validateCanvasDoc(two({ hidden }))).toThrow(expect.objectContaining({ code: CANVAS_ERRORS.limitExceeded }));
  });
  test("withHidden com lista vazia tira o campo (a forma gravada não leva hidden: [])", () => {
    const base = validateCanvasDoc(two({ hidden: ["n1"] }));
    expect("hidden" in withHidden(base, [])).toBe(false);
    expect(withHidden(base, ["agent:proj:a"]).hidden).toEqual(["agent:proj:a"]);
    expect(base.hidden).toEqual(["n1"]);
  });
  test("dado oculto que segue no grafo, então a mescla o mantém oculto e não o põe em unplaced", () => {
    const doc = validateCanvasDoc(two({ hidden: ["agent:proj:a"] }));
    const out = mergeWithGraph(doc, [{ id: "agent:proj:a", type: "agent" }]);
    expect(out.doc.hidden).toEqual(["agent:proj:a"]);
    expect(out.unplaced).toEqual([]);
  });
  test("dado oculto vivo que saiu do grafo, então sai da lista junto com o nó (e a lista vazia some)", () => {
    const doc = validateCanvasDoc(two({ hidden: ["agent:proj:a"] }));
    const out = mergeWithGraph(doc, []);
    expect(out.removed).toEqual(["agent:proj:a"]);
    expect("hidden" in out.doc).toBe(false);
    expect(validateCanvasDoc(out.doc).nodes.map((n) => n.id)).toEqual(["n1"]);
  });
});
