// Grupo canvas-links: conexões do dono no canvas (src/lib/canvas-links.ts) — quem conecta com quem e o que significa, as
// operações com ida e volta exata pelo inverso, os códigos de erro, a forma da aresta `link` no documento, a rota do
// circuito, a corda (repouso, pinos, passo) e o traço que cruza. Lógica pura.
import { describe, expect, test } from "bun:test";
import {
  CANVAS_ERRORS, CANVAS_LIMITS, type CanvasDoc, CanvasError, type CanvasEdge, type CanvasNode, emptyCanvasDoc, readCanvasDoc, validateCanvasDoc,
} from "../../../src/lib/canvas-doc";
import { applyOp, type CanvasOp, invert } from "../../../src/lib/canvas-history";
import {
  CLAMP_T_MARGIN, circuitRoute, clampPoint, clampsOf, createRope, freshLinkId, LINK_EDGE_KIND, LINK_ERRORS, LINK_ERROR_TEXT, LinkError,
  canStartLink, linkAnchors, linkCount, linkMeaning, linkRefusal, linksOf, opClampLinks, opCreateLink, opMoveClamp, opReleaseClamp, opRemoveLink,
  opSetLinkStyle, pinIndex, projectT, ROPE, ropeReach, ropeRest, stepRopeInPlace, strokeCrossing,
} from "../../../src/lib/canvas-links";

const T1 = "agent:p:t1";
const T2 = "agent:p:t2";
const node = (id: string, type: string, x = 0, y = 0): CanvasNode => ({ id, type, x, y, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false });
const link = (id: string, from: string, to: string, extra: Partial<CanvasEdge> = {}): CanvasEdge => ({ id, from, to, kind: LINK_EDGE_KIND, ...extra });
/** Dois terminais (t1, t2) e duas notas (n1, n2), lado a lado. */
const docOf = (edges: CanvasEdge[] = []): CanvasDoc => ({
  ...emptyCanvasDoc(),
  nodes: [node(T1, "agent", 0), node(T2, "agent", 300), node("n1", "note", 600), node("n2", "note", 900)],
  edges,
});
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof LinkError || error instanceof CanvasError) return error.code;
    throw error;
  }
  return undefined;
};
/** Aplica, confere com `validateCanvasDoc`, desfaz e confere que voltou exatamente ao anterior. */
function roundTrip(doc: CanvasDoc, op: CanvasOp): CanvasDoc {
  const next = applyOp(doc, op);
  expect(validateCanvasDoc(next)).toEqual(next);
  expect(applyOp(next, invert(op))).toEqual(doc);
  return next;
}

describe("canvas-links: quem conecta e o que significa", () => {
  test("terminal com nota dá acesso à nota, nos dois sentidos", () => {
    expect(linkMeaning("agent", "note")).toBe("note-access");
    expect(linkMeaning("note", "agent")).toBe("note-access");
  });

  test("nota com nota é cadeia", () => {
    expect(linkMeaning("note", "note")).toBe("chain");
  });

  test("terminal com terminal não tem leitor e é recusado", () => {
    expect(linkMeaning("agent", "agent")).toBeUndefined();
    expect(linkRefusal(docOf(), T1, T2)).toBe(LINK_ERRORS.noReader);
  });

  test("tipo de nó fora da tabela não conecta, nem por nome herdado de objeto", () => {
    expect(linkMeaning("pr", "note")).toBeUndefined();
    expect(linkMeaning("constructor", "note")).toBeUndefined();
  });

  test("ponta inexistente, laço e par já conectado (em qualquer sentido) são recusados pelo código", () => {
    const doc = docOf([link("l1", T1, "n1")]);
    expect(linkRefusal(doc, T1, "zz")).toBe(LINK_ERRORS.danglingNode);
    expect(linkRefusal(doc, "n1", "n1")).toBe(LINK_ERRORS.selfLoop);
    expect(linkRefusal(doc, "n1", T1)).toBe(LINK_ERRORS.duplicateLink);
    expect(linkRefusal(doc, T2, "n1")).toBeUndefined();
  });

  test("documento no teto de arestas recusa mais uma", () => {
    const edges = Array.from({ length: CANVAS_LIMITS.edges }, (_, i) => ({ id: `e${i}`, from: T1, to: T2, kind: "manual" }));
    expect(linkRefusal(docOf(edges), T1, "n1")).toBe(LINK_ERRORS.limitExceeded);
  });

  test("terminal criado pela barra (tipo terminal) começa conexão e vale como destino, como o agent", () => {
    const doc: CanvasDoc = { ...docOf(), nodes: [...docOf().nodes, node("tty1", "terminal", 1200)] };
    expect(canStartLink(doc.nodes.find((n) => n.id === "tty1"))).toBe(true);
    expect(linkMeaning("terminal", "note")).toBe("note-access");
    expect(linkMeaning("note", "terminal")).toBe("note-access");
    expect(linkRefusal(doc, "tty1", "n1")).toBeUndefined();
    expect(linkRefusal(doc, "n1", "tty1")).toBeUndefined();
    expect(linkRefusal(doc, "tty1", T1)).toBe(LINK_ERRORS.noReader);
    expect(canStartLink(node("p1", "pr"))).toBe(false);
    expect(canStartLink(undefined)).toBe(false);
  });

  test("todo código de erro tem mensagem", () => {
    for (const code of Object.values(LINK_ERRORS)) expect(LINK_ERROR_TEXT[code].length).toBeGreaterThan(0);
  });
});

describe("canvas-links: criar, remover e trocar estilo", () => {
  test("criar uma corda não grava style e desfazer volta ao documento sem a conexão", () => {
    const doc = docOf();
    const next = roundTrip(doc, opCreateLink(doc, { id: "l1", from: T1, to: "n1" }));
    expect(next.edges).toEqual([link("l1", T1, "n1")]);
  });

  test("criar um circuito grava o estilo", () => {
    const doc = docOf();
    const next = roundTrip(doc, opCreateLink(doc, { id: "l1", from: "n1", to: "n2", style: "circuit" }));
    expect(next.edges[0]?.style).toBe("circuit");
  });

  test("criar recusa id inválido, id repetido, estilo desconhecido e par sem leitor, cada um pelo seu código", () => {
    const doc = docOf([link("l1", T1, "n1")]);
    expect(codeOf(() => opCreateLink(doc, { id: "com espaço", from: T2, to: "n1" }))).toBe(LINK_ERRORS.invalidId);
    expect(codeOf(() => opCreateLink(doc, { id: "l1", from: T2, to: "n1" }))).toBe(LINK_ERRORS.duplicateId);
    expect(codeOf(() => opCreateLink(doc, { id: "l2", from: T2, to: "n1", style: "zigue" as never }))).toBe(LINK_ERRORS.invalidStyle);
    expect(codeOf(() => opCreateLink(doc, { id: "l2", from: T1, to: T2 }))).toBe(LINK_ERRORS.noReader);
  });

  test("remover devolve a conexão no mesmo lugar ao desfazer", () => {
    const doc = docOf([link("l1", T1, "n1"), link("l2", "n1", "n2", { style: "circuit" }), link("l3", T2, "n2")]);
    const next = roundTrip(doc, opRemoveLink(doc, "l2"));
    expect(next.edges.map((e) => e.id)).toEqual(["l1", "l3"]);
  });

  test("remover recusa aresta que não existe e aresta que não é conexão", () => {
    const doc = docOf([{ id: "m1", from: T1, to: T2, kind: "manual" }]);
    expect(codeOf(() => opRemoveLink(doc, "zz"))).toBe(LINK_ERRORS.missingLink);
    expect(codeOf(() => opRemoveLink(doc, "m1"))).toBe(LINK_ERRORS.notLink);
  });

  test("trocar o estilo mantém a conexão no mesmo índice e o desfazer devolve o estilo de antes", () => {
    const doc = docOf([link("l1", T1, "n1"), link("l2", "n1", "n2"), link("l3", T2, "n2")]);
    const op = opSetLinkStyle(doc, "l2", "circuit");
    expect(op).toBeDefined();
    const next = roundTrip(doc, op as CanvasOp);
    expect(next.edges.map((e) => e.id)).toEqual(["l1", "l2", "l3"]);
    expect(next.edges[1]?.style).toBe("circuit");
  });

  test("voltar para corda apaga o campo style", () => {
    const doc = docOf([link("l1", T1, "n1", { style: "circuit" })]);
    const next = roundTrip(doc, opSetLinkStyle(doc, "l1", "rope") as CanvasOp);
    expect("style" in (next.edges[0] as CanvasEdge)).toBe(false);
  });

  test("trocar para o estilo atual não gera operação", () => {
    expect(opSetLinkStyle(docOf([link("l1", T1, "n1")]), "l1", "rope")).toBeUndefined();
  });

  test("trocar o estilo preserva as abraçadeiras", () => {
    const doc = docOf([link("l1", T1, "n1", { clamps: [{ id: "c1", t: 0.4 }] })]);
    const next = roundTrip(doc, opSetLinkStyle(doc, "l1", "circuit") as CanvasOp);
    expect(next.edges[0]?.clamps).toEqual([{ id: "c1", t: 0.4 }]);
  });
});

describe("canvas-links: abraçadeiras", () => {
  const two = (): CanvasDoc => docOf([link("l1", T1, "n1"), link("l2", T2, "n2"), link("l3", "n1", "n2")]);

  test("prender duas conexões grava a mesma abraçadeira em cada uma e desfazer solta", () => {
    const doc = two();
    const next = roundTrip(doc, opClampLinks(doc, "c1", [{ edgeId: "l1", t: 0.3 }, { edgeId: "l2", t: 0.6 }]));
    expect(clampsOf(next).get("c1")).toEqual([{ edgeId: "l1", t: 0.3 }, { edgeId: "l2", t: 0.6 }]);
    expect(next.edges[2]?.clamps).toBeUndefined();
  });

  test("prender recusa traço vazio, conexão repetida, t fora de (0, 1) e id já usado", () => {
    const doc = docOf([link("l1", T1, "n1", { clamps: [{ id: "c1", t: 0.5 }] }), link("l2", T2, "n2")]);
    expect(codeOf(() => opClampLinks(doc, "c2", []))).toBe(LINK_ERRORS.invalidClamp);
    expect(codeOf(() => opClampLinks(doc, "c2", [{ edgeId: "l2", t: 0.2 }, { edgeId: "l2", t: 0.3 }]))).toBe(LINK_ERRORS.invalidClamp);
    for (const t of [0, 1, Number.NaN]) expect(codeOf(() => opClampLinks(doc, "c2", [{ edgeId: "l2", t }]))).toBe(LINK_ERRORS.invalidClamp);
    expect(codeOf(() => opClampLinks(doc, "c1", [{ edgeId: "l2", t: 0.5 }]))).toBe(LINK_ERRORS.duplicateId);
  });

  test("conexão no teto de abraçadeiras recusa mais uma", () => {
    const clamps = Array.from({ length: CANVAS_LIMITS.edgeClamps }, (_, i) => ({ id: `c${i}`, t: 0.1 }));
    const doc = docOf([link("l1", T1, "n1", { clamps })]);
    expect(codeOf(() => opClampLinks(doc, "cx", [{ edgeId: "l1", t: 0.5 }]))).toBe(LINK_ERRORS.clampLimit);
  });

  test("mover troca só o t de quem mudou e desfazer devolve o t de antes", () => {
    const doc = roundTrip(two(), opClampLinks(two(), "c1", [{ edgeId: "l1", t: 0.3 }, { edgeId: "l2", t: 0.6 }]));
    const op = opMoveClamp(doc, "c1", new Map([["l1", 0.5], ["l2", 0.6]]));
    const next = roundTrip(doc, op as CanvasOp);
    expect(clampsOf(next).get("c1")).toEqual([{ edgeId: "l1", t: 0.5 }, { edgeId: "l2", t: 0.6 }]);
    expect((op as { ops: unknown[] }).ops).toHaveLength(2);
  });

  test("mover sem mudança não gera operação; abraçadeira inexistente é recusada", () => {
    const doc = docOf([link("l1", T1, "n1", { clamps: [{ id: "c1", t: 0.5 }] })]);
    expect(opMoveClamp(doc, "c1", new Map([["l1", 0.5]]))).toBeUndefined();
    expect(codeOf(() => opMoveClamp(doc, "zz", new Map()))).toBe(LINK_ERRORS.missingClamp);
  });

  test("soltar tira a abraçadeira de todas as conexões e mantém as outras", () => {
    const doc = docOf([
      link("l1", T1, "n1", { clamps: [{ id: "c1", t: 0.3 }, { id: "c2", t: 0.7 }] }),
      link("l2", T2, "n2", { clamps: [{ id: "c1", t: 0.5 }] }),
    ]);
    const next = roundTrip(doc, opReleaseClamp(doc, "c1"));
    expect(next.edges[0]?.clamps).toEqual([{ id: "c2", t: 0.7 }]);
    expect(next.edges[1]?.clamps).toBeUndefined();
    expect(codeOf(() => opReleaseClamp(next, "c1"))).toBe(LINK_ERRORS.missingClamp);
  });

  test("id livre pula os ids de arestas e de abraçadeiras já usados", () => {
    const doc = docOf([link("link-a", T1, "n1", { clamps: [{ id: "link-a-2", t: 0.5 }] })]);
    expect(freshLinkId(doc, "link", "b")).toBe("link-b");
    expect(freshLinkId(doc, "link", "a")).toBe("link-a-3");
  });
});

describe("canvas-links: popover", () => {
  test("lista as conexões do nó com o outro lado, o estilo, o significado e as abraçadeiras", () => {
    const doc = docOf([link("l1", T1, "n1"), link("l2", "n1", "n2", { style: "circuit", clamps: [{ id: "c1", t: 0.5 }] }), link("l3", T2, "n2")]);
    expect(linksOf(doc, "n1")).toEqual([
      { edgeId: "l1", other: T1, otherType: "agent", style: "rope", meaning: "note-access", clamps: [] },
      { edgeId: "l2", other: "n2", otherType: "note", style: "circuit", meaning: "chain", clamps: ["c1"] },
    ]);
    expect(linkCount(doc, "n1")).toBe(2);
  });

  test("nó sem conexão, nó inexistente e aresta que não é conexão dão lista vazia", () => {
    const doc = docOf([{ id: "m1", from: T1, to: "n1", kind: "manual" }]);
    expect(linksOf(doc, T1)).toEqual([]);
    expect(linksOf(doc, "zz")).toEqual([]);
    expect(linkCount(doc, T1)).toBe(0);
  });
});

describe("canvas-links: a aresta link no documento", () => {
  const raw = (edge: Record<string, unknown>): unknown => ({ ...docOf(), edges: [{ id: "l1", from: T1, to: "n1", kind: "link", ...edge }] });
  const docCode = (input: unknown): string => {
    try {
      readCanvasDoc(input);
      return "ok";
    } catch (error) {
      if (error instanceof CanvasError) return error.code;
      throw error;
    }
  };

  test("conexão com estilo e abraçadeiras valida e sai igual", () => {
    const input = raw({ style: "circuit", clamps: [{ id: "c1", t: 0.25 }] });
    expect(readCanvasDoc(input).edges[0]).toEqual({ id: "l1", from: T1, to: "n1", kind: "link", style: "circuit", clamps: [{ id: "c1", t: 0.25 }] });
  });

  test("documento antigo, sem style nem clamps, abre igual e sem os campos novos", () => {
    const edge = readCanvasDoc({ ...docOf(), edges: [{ id: "m1", from: T1, to: T2, kind: "manual" }] }).edges[0] as CanvasEdge;
    expect(Object.keys(edge)).toEqual(["id", "from", "to", "kind"]);
  });

  test("style e clamps fora de conexão são recusados", () => {
    expect(docCode(raw({ kind: "manual", style: "rope" }))).toBe(CANVAS_ERRORS.invalidEdge);
    expect(docCode(raw({ kind: "manual", clamps: [{ id: "c1", t: 0.5 }] }))).toBe(CANVAS_ERRORS.invalidEdge);
  });

  test("estilo desconhecido, lista vazia, t nos limites e chave a mais na abraçadeira são recusados", () => {
    expect(docCode(raw({ style: "zigue" }))).toBe(CANVAS_ERRORS.invalidEdge);
    expect(docCode(raw({ clamps: [] }))).toBe(CANVAS_ERRORS.invalidEdge);
    for (const t of [0, 1, -0.1, "0.5", null]) expect(docCode(raw({ clamps: [{ id: "c1", t }] }))).toBe(CANVAS_ERRORS.invalidEdge);
    expect(docCode(raw({ clamps: [{ id: "c1", t: 0.5, x: 1 }] }))).toBe(CANVAS_ERRORS.invalidEdge);
  });

  test("abraçadeira repetida na mesma conexão e abraçadeiras demais são recusadas pelo código certo", () => {
    expect(docCode(raw({ clamps: [{ id: "c1", t: 0.2 }, { id: "c1", t: 0.4 }] }))).toBe(CANVAS_ERRORS.duplicateId);
    const many = Array.from({ length: CANVAS_LIMITS.edgeClamps + 1 }, (_, i) => ({ id: `c${i}`, t: 0.5 }));
    expect(docCode(raw({ clamps: many }))).toBe(CANVAS_ERRORS.limitExceeded);
    expect(docCode(raw({ clamps: many.slice(0, CANVAS_LIMITS.edgeClamps) }))).toBe("ok");
  });
});

describe("canvas-links: geometria", () => {
  const box = (x: number, y: number) => ({ x, y, w: 100, h: 60 });
  const turns = (points: readonly { x: number; y: number }[]): number => Math.max(0, points.length - 2);
  const axisAligned = (points: readonly { x: number; y: number }[]): boolean =>
    points.every((p, i) => i === 0 || p.x === (points[i - 1] as typeof p).x || p.y === (points[i - 1] as typeof p).y);

  test("as pontas saem da borda de cada nó virada para o outro", () => {
    expect(linkAnchors(box(0, 0), box(300, 0))).toEqual([{ x: 100, y: 30 }, { x: 300, y: 30 }]);
  });

  test("o circuito anda nos eixos, sai das bordas e faz no máximo duas curvas", () => {
    const cases = [[box(0, 0), box(400, 200)], [box(0, 0), box(30, 400)], [box(0, 0), box(50, 20)], [box(0, 0), box(400, 0)], [box(0, 0), box(0, 400)]] as const;
    for (const [a, b] of cases) {
      const route = circuitRoute(a, b);
      expect(axisAligned(route)).toBe(true);
      expect(turns(route)).toBeLessThanOrEqual(2);
    }
  });

  test("nós lado a lado na mesma altura ligam por reta, das laterais", () => {
    expect(circuitRoute(box(0, 0), box(400, 0))).toEqual([{ x: 100, y: 30 }, { x: 400, y: 30 }]);
  });

  test("a projeção no traço respeita a folga das pontas", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    expect(projectT(a, b, { x: 40, y: 50 })).toBeCloseTo(0.4);
    expect(projectT(a, b, { x: -50, y: 0 })).toBe(CLAMP_T_MARGIN);
    expect(projectT(a, b, { x: 500, y: 0 })).toBe(1 - CLAMP_T_MARGIN);
    expect(projectT(a, a, { x: 5, y: 5 })).toBe(0.5);
  });

  test("a abraçadeira fica na média dos pontos presos; sem conexão, não tem lugar", () => {
    expect(clampPoint([{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, t: 0.5 }, { a: { x: 0, y: 100 }, b: { x: 100, y: 100 }, t: 0.5 }])).toEqual({ x: 50, y: 50 });
    expect(clampPoint([])).toBeUndefined();
  });

  test("o traço cruza a linha no primeiro ponto a partir do começo do traço; paralelo ou curto demais não cruza", () => {
    const line = [{ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 150 }];
    expect(strokeCrossing({ x: 50, y: 0 }, { x: 50, y: 100 }, line)).toEqual({ x: 50, y: 50 });
    expect(strokeCrossing({ x: 0, y: 0 }, { x: 100, y: 0 }, line)).toBeUndefined();
    expect(strokeCrossing({ x: 50, y: 0 }, { x: 50, y: 40 }, line)).toBeUndefined();
  });
});

describe("canvas-links: corda", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 160, y: 0 };

  test("em repouso, a corda vai de ponta a ponta com a barriga para baixo", () => {
    const points = ropeRest(a, b);
    expect(points).toHaveLength(ROPE.segments + 1);
    expect(points[0]).toEqual(a);
    expect(points.at(-1)).toEqual(b);
    expect((points[ROPE.segments / 2] as { y: number }).y).toBeGreaterThan(0);
  });

  test("a abraçadeira prende o ponto do seu índice, e nunca uma ponta", () => {
    const at = { x: 80, y: -40 };
    expect(ropeRest(a, b, [{ index: 8, at }])[8]).toEqual(at);
    expect(pinIndex(0.01)).toBe(1);
    expect(pinIndex(0.99)).toBe(ROPE.segments - 1);
  });

  test("o passo mantém pontas e pinos no lugar e a corda solta assenta (deslocamento abaixo do repouso)", () => {
    const rope = createRope(a, { x: 100, y: 0 });
    const pins = [{ index: 8, at: { x: 80, y: 20 } }];
    let moved = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 400 && moved > ROPE.sleep; i++) moved = stepRopeInPlace(rope, a, b, pins, ROPE.maxDt);
    expect(moved).toBeLessThanOrEqual(ROPE.sleep);
    expect(rope.points[0]).toEqual(a);
    expect(rope.points.at(-1)).toEqual(b);
    expect(rope.points[8]).toEqual({ x: 80, y: 20 });
  });

  test("passo com dt enorme é limitado: aba que volta do segundo plano não dá salto", () => {
    const slow = createRope(a, { x: 100, y: 0 });
    const capped = createRope(a, { x: 100, y: 0 });
    stepRopeInPlace(slow, a, b, [], 10);
    stepRopeInPlace(capped, a, b, [], ROPE.maxDt);
    expect(slow.points).toEqual(capped.points);
  });

  test("o alcance da corda cobre as pontas, os pinos e a barriga", () => {
    const reach = ropeReach(a, b, [{ index: 8, at: { x: 80, y: -50 } }]);
    const rest = ropeRest(a, b);
    for (const p of [a, b, { x: 80, y: -50 }, ...rest]) {
      expect(p.x).toBeGreaterThanOrEqual(reach.x);
      expect(p.x).toBeLessThanOrEqual(reach.x + reach.w);
      expect(p.y).toBeGreaterThanOrEqual(reach.y);
      expect(p.y).toBeLessThanOrEqual(reach.y + reach.h);
    }
  });
});
