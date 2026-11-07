// Grupo canvas-tidy: organizar o canvas por equipes (src/lib/canvas-tidy.ts). Lógica pura: nada se sobrepõe, o orquestrador
// fica sobre os recrutas, a área acompanha a equipe, o travado fica onde está e o arranjo desfaz num passo só.
import { describe, expect, test } from "bun:test";
import { AREA_TYPE, areaDataOf } from "../../../src/lib/canvas-areas";
import { type CanvasDoc, type CanvasNode, emptyCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, invert } from "../../../src/lib/canvas-history";
import { NOTE_TYPE } from "../../../src/lib/canvas-note";
import { tidyArrange, tidyOp, tweenPlacements } from "../../../src/lib/canvas-tidy";

const term = (id: string, x: number, y: number, data: Record<string, unknown> = {}, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, type: "terminal", x, y, w: 400, h: 240, z: 1, data: { name: id, ...data }, locked: false, blurred: false, ...extra });
const note = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, type: NOTE_TYPE, x, y, w: 280, h: 180, z: 1, data: { note: id }, locked: false, blurred: false, ...extra });
const area = (id: string, x: number, y: number, w: number, h: number, members: string[] = [], extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, type: AREA_TYPE, x, y, w, h, z: -1, data: areaDataOf({ title: id, color: "chart-1", members }), locked: false, blurred: false, ...extra });
const docOf = (nodes: CanvasNode[], edges: CanvasDoc["edges"] = []): CanvasDoc => ({ ...emptyCanvasDoc(), nodes, edges });
const edge = (id: string, from: string, to: string, kind = "link"): CanvasDoc["edges"][number] => ({ id, from, to, kind }) as CanvasDoc["edges"][number];
const neighborsOf = (doc: CanvasDoc): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const e of doc.edges) {
    map.set(e.from, [...(map.get(e.from) ?? []), e.to]);
    map.set(e.to, [...(map.get(e.to) ?? []), e.from]);
  }
  return map;
};
const tidy = (doc: CanvasDoc, pinned?: ReadonlySet<string>) => tidyArrange({ doc, neighbors: neighborsOf(doc) }, { pinned });
const tidied = (doc: CanvasDoc, pinned?: ReadonlySet<string>): CanvasDoc => {
  const result = tidy(doc, pinned);
  const op = tidyOp(doc, result);
  return op ? applyOp(doc, op) : doc;
};
const overlap = (a: CanvasNode, b: CanvasNode): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const at = (doc: CanvasDoc, id: string): CanvasNode => doc.nodes.find((n) => n.id === id) as CanvasNode;
/** Pares que se sobrepõem, ignorando área contra o nó que ela guarda (isso é o esperado). */
const clashes = (doc: CanvasDoc): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < doc.nodes.length; i++) {
    for (let j = i + 1; j < doc.nodes.length; j++) {
      const a = doc.nodes[i] as CanvasNode;
      const b = doc.nodes[j] as CanvasNode;
      if (a.type === AREA_TYPE || b.type === AREA_TYPE) continue;
      if (overlap(a, b)) out.push([a.id, b.id]);
    }
  }
  return out;
};

const ORQ = "orq";
/** Orquestrador com `n` recrutas e `m` notas, todos empilhados na origem. */
const team = (n: number, m: number, orq = ORQ): CanvasNode[] => [
  term(orq, 0, 0, { orchestrator: true }),
  ...Array.from({ length: n }, (_, i) => term(`${orq}-r${i}`, 0, 0, { recruiter: orq })),
  ...Array.from({ length: m }, (_, i) => note(`${orq}-n${i}`, 0, 0)),
];
const noteEdges = (orq: string, m: number): CanvasDoc["edges"] => Array.from({ length: m }, (_, i) => edge(`e-${orq}-${i}`, `${orq}-n${i}`, orq));

describe("tidyArrange", () => {
  test("dados 9 recrutas e 5 notas empilhados, quando organiza, então nenhum nó se sobrepõe", () => {
    const doc = docOf(team(9, 5), noteEdges(ORQ, 5));
    expect(clashes(tidied(doc))).toEqual([]);
  });

  test("dado um orquestrador com recrutas e notas, quando organiza, então notas ficam acima e recrutas abaixo dele", () => {
    const out = tidied(docOf(team(3, 2), noteEdges(ORQ, 2)));
    const orq = at(out, ORQ);
    for (const id of ["orq-n0", "orq-n1"]) expect(at(out, id).y + at(out, id).h).toBeLessThanOrEqual(orq.y);
    for (const id of ["orq-r0", "orq-r1", "orq-r2"]) expect(at(out, id).y).toBeGreaterThanOrEqual(orq.y + orq.h);
  });

  test("dado o orquestrador, quando organiza, então ele fica centrado sobre a fileira dos recrutas", () => {
    const out = tidied(docOf(team(2, 0)));
    const [left, right] = ["orq-r0", "orq-r1"].map((id) => at(out, id).x + at(out, id).w / 2) as [number, number];
    const orq = at(out, ORQ);
    expect(Math.abs(orq.x + orq.w / 2 - (left + right) / 2)).toBeLessThanOrEqual(1);
  });

  test("dado o mesmo documento, quando organiza duas vezes, então o resultado é idêntico", () => {
    const doc = docOf(team(5, 3), noteEdges(ORQ, 3));
    expect(tidy(doc)).toEqual(tidy({ ...doc, nodes: [...doc.nodes].reverse() }));
  });

  test("dado um canvas já organizado, quando organiza de novo, então não há operação (nada muda)", () => {
    const doc = docOf(team(4, 2), noteEdges(ORQ, 2));
    const once = tidied(doc);
    expect(tidyOp(once, tidy(once))).toBeUndefined();
  });

  test("dado dois orquestradores, quando organiza, então as equipes ficam lado a lado sem sobrepor", () => {
    const doc = docOf([...team(3, 1, "a"), ...team(4, 2, "b")], [...noteEdges("a", 1), ...noteEdges("b", 2)]);
    const out = tidied(doc);
    expect(clashes(out)).toEqual([]);
  });

  test("dada a nota ligada a dois orquestradores, quando organiza, então ela vai ao primeiro por id", () => {
    const nodes = [term("a", 0, 0, { orchestrator: true }), term("b", 0, 0, { orchestrator: true }), note("n", 0, 0)];
    const out = tidied(docOf(nodes, [edge("e1", "n", "a"), edge("e2", "n", "b")]));
    expect(at(out, "n").y + at(out, "n").h).toBeLessThanOrEqual(at(out, "a").y);
  });

  test("dados nós soltos sem ligação, quando organiza, então formam uma grade sem sobreposição", () => {
    const doc = docOf(Array.from({ length: 14 }, (_, i) => term(`t${i}`, 0, 0)));
    const out = tidied(doc);
    expect(clashes(out)).toEqual([]);
    expect(new Set(out.nodes.map((n) => n.y)).size).toBeGreaterThan(1);
  });

  test("dados nós ligados entre si, quando organiza, então ficam juntos e longe dos soltos", () => {
    const doc = docOf([term("a", 0, 0), term("b", 0, 0), term("solto", 0, 0)], [edge("e", "a", "b")]);
    const out = tidied(doc);
    expect(clashes(out)).toEqual([]);
    expect(at(out, "a").y).toBe(at(out, "b").y);
  });

  test("dado um nó travado, quando organiza, então ele não se move e nenhum outro cai sobre ele", () => {
    const doc = docOf([...team(4, 0), term("fixo", 100, 100, {}, { locked: true })]);
    const out = tidied(doc);
    expect(at(out, "fixo")).toMatchObject({ x: 100, y: 100 });
    expect(clashes(out)).toEqual([]);
  });

  test("dado um id fixado pelo chamador, quando organiza, então ele fica onde está", () => {
    const doc = docOf([term("a", 30, 40), term("b", 0, 0), term("c", 0, 0)]);
    const out = tidied(doc, new Set(["a"]));
    expect(at(out, "a")).toMatchObject({ x: 30, y: 40 });
    expect(clashes(out)).toEqual([]);
  });

  test("dado um documento vazio, quando organiza, então não há nada a fazer", () => {
    expect(tidy(docOf([]))).toEqual({ placements: [], frames: [] });
  });

  test("dado um único nó, quando organiza, então ele não sai do lugar", () => {
    const doc = docOf([term("t", 500, 300)]);
    expect(tidyOp(doc, tidy(doc))).toBeUndefined();
  });
});

describe("tidyArrange com áreas", () => {
  test("dada uma área com a equipe, quando organiza, então ela cresce para conter todos os membros", () => {
    const nodes = [...team(5, 2), area("equipe", 0, 0, 200, 150, [ORQ, ...Array.from({ length: 5 }, (_, i) => `orq-r${i}`), "orq-n0", "orq-n1"])];
    const out = tidied(docOf(nodes, noteEdges(ORQ, 2)));
    const box = at(out, "equipe");
    for (const n of out.nodes.filter((o) => o.type !== AREA_TYPE)) {
      expect(n.x).toBeGreaterThanOrEqual(box.x);
      expect(n.y).toBeGreaterThanOrEqual(box.y);
      expect(n.x + n.w).toBeLessThanOrEqual(box.x + box.w);
      expect(n.y + n.h).toBeLessThanOrEqual(box.y + box.h);
    }
  });

  test("dadas duas áreas, quando organiza, então uma não cobre a outra", () => {
    const nodes = [...team(2, 0, "a"), ...team(3, 0, "b"), area("A", 0, 0, 100, 100, ["a", "a-r0", "a-r1"]), area("B", 0, 0, 100, 100, ["b", "b-r0", "b-r1", "b-r2"])];
    const out = tidied(docOf(nodes));
    expect(overlap(at(out, "A"), at(out, "B"))).toBe(false);
    expect(clashes(out)).toEqual([]);
  });

  test("dado um membro travado, quando organiza, então a área inteira fica como estava", () => {
    const nodes = [term("a", 100, 100, {}, { locked: true }), term("b", 560, 160), area("A", 80, 60, 1000, 400, ["a", "b"]), term("fora", 0, 0)];
    const doc = docOf(nodes);
    const result = tidy(doc);
    expect(result.frames.find((f) => f.id === "A")).toBeUndefined();
    expect(result.placements.find((p) => p.id === "b")).toBeUndefined();
    expect(clashes(tidied(doc))).toEqual([]);
  });

  test("dada uma área vazia, quando organiza, então ela mantém o tamanho e não sobrepõe ninguém", () => {
    const doc = docOf([term("a", 0, 0), term("b", 0, 0), area("vazia", 0, 0, 300, 200)]);
    const out = tidied(doc);
    expect(at(out, "vazia")).toMatchObject({ w: 300, h: 200 });
    for (const n of out.nodes.filter((o) => o.type !== AREA_TYPE)) expect(overlap(n, at(out, "vazia"))).toBe(false);
  });

  test("dada a equipe cujos recrutas estão em áreas diferentes, quando organiza, então a equipe se parte entre as áreas", () => {
    const nodes = [...team(2, 0), area("A", 0, 0, 100, 100, [ORQ, "orq-r0"]), area("B", 0, 0, 100, 100, ["orq-r1"])];
    const out = tidied(docOf(nodes));
    expect(overlap(at(out, "A"), at(out, "B"))).toBe(false);
    const inside = (n: CanvasNode, a: CanvasNode): boolean => n.x >= a.x && n.y >= a.y && n.x + n.w <= a.x + a.w && n.y + n.h <= a.y + a.h;
    expect(inside(at(out, "orq-r1"), at(out, "B"))).toBe(true);
    expect(inside(at(out, ORQ), at(out, "A"))).toBe(true);
  });
});

describe("tidyArrange em escala e no desfazer", () => {
  test("dado o limite de nós do documento, quando organiza, então termina sem sobreposição", () => {
    const nodes = [...team(400, 100, "g1"), ...team(400, 100, "g2"), ...Array.from({ length: 998 }, (_, i) => term(`s${i}`, 0, 0))].slice(0, 2000);
    const doc = docOf(nodes);
    const started = performance.now();
    const out = tidied(doc);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(clashes(out)).toEqual([]);
  });

  test("dado o arranjo aplicado, quando desfaz, então o documento volta ao que era (um passo só)", () => {
    const doc = docOf([...team(4, 2), area("A", 0, 0, 200, 150, [ORQ])], noteEdges(ORQ, 2));
    const op = tidyOp(doc, tidy(doc)) as NonNullable<ReturnType<typeof tidyOp>>;
    expect(applyOp(applyOp(doc, op), invert(op))).toEqual(doc);
  });
});

describe("tweenPlacements", () => {
  const from = [{ id: "a", x: 0, y: 0 }];
  const to = [{ id: "a", x: 100, y: 200 }, { id: "novo", x: 5, y: 6 }];

  test("dado t=0, quando interpola, então cada nó está na origem e o que não tinha origem já no destino", () => {
    expect(tweenPlacements(from, to, 0)).toEqual([{ id: "a", x: 0, y: 0 }, { id: "novo", x: 5, y: 6 }]);
  });

  test("dado t=1, quando interpola, então cada nó está no destino", () => {
    expect(tweenPlacements(from, to, 1)).toEqual(to);
  });

  test("dado t fora de 0 a 1, quando interpola, então o valor é preso ao intervalo", () => {
    expect(tweenPlacements(from, to, 7)).toEqual(to);
    expect(tweenPlacements(from, to, -3)[0]).toEqual({ id: "a", x: 0, y: 0 });
  });

  test("dado t=0.5, quando interpola, então passou da metade do caminho (saída suave)", () => {
    expect((tweenPlacements(from, to, 0.5)[0] as { x: number }).x).toBeGreaterThan(50);
  });
});
