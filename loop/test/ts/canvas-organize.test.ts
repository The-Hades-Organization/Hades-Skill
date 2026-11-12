// Grupo canvas-organize: organizar o canvas em áreas por orquestrador (src/lib/canvas-organize.ts). Lógica pura: o
// agrupamento sai do grafo, tudo é por id, nada se sobrepõe e reorganizar sem mudança no grafo não move nada.
import { describe, expect, test } from "bun:test";
import { AREA_TYPE, areaDataOf, areaNodes } from "../../../src/lib/canvas-areas";
import { type CanvasDoc, type CanvasNode, emptyCanvasDoc } from "../../../src/lib/canvas-doc";
import { type CanvasCliDeps, runCanvas } from "../../../src/commands/canvas";
import { applyOp } from "../../../src/lib/canvas-history";
import { EXIT } from "../../../src/lib/output";
import { ORGANIZE_AREA_PREFIX, ORGANIZE_ERRORS, ORGANIZE_LAYOUT, OrganizeError, organizeCanvas, organizeOp, parseAreaRules } from "../../../src/lib/canvas-organize";

const term = (id: string, data: Record<string, unknown> = {}, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, type: "terminal", x: 0, y: 0, w: 1340, h: 800, z: 1, data: { name: id, ...data }, locked: false, blurred: false, ...extra });
const note = (id: string, name = id, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, type: "note", x: 0, y: 0, w: 280, h: 200, z: 1, data: { note: name }, locked: false, blurred: false, ...extra });
const edge = (id: string, from: string, to: string, kind = "link"): CanvasDoc["edges"][number] => ({ id, from, to, kind }) as CanvasDoc["edges"][number];
const docOf = (nodes: CanvasNode[], edges: CanvasDoc["edges"] = []): CanvasDoc => ({ ...emptyCanvasDoc(), nodes, edges });
const orq = (id: string): CanvasNode => term(id, { orchestrator: true });
const recruit = (id: string, boss: string): CanvasNode => term(id, { recruiter: boss });

const organized = (doc: CanvasDoc, options?: Parameters<typeof organizeCanvas>[1]): CanvasDoc => {
  const op = organizeOp(doc, organizeCanvas(doc, options));
  return op ? applyOp(doc, op) : doc;
};
const at = (doc: CanvasDoc, id: string): CanvasNode => doc.nodes.find((n) => n.id === id) as CanvasNode;
const membersOf = (doc: CanvasDoc, areaId: string): string[] => areaNodes(doc).find((a) => a.node.id === areaId)?.data.members ?? [];
const overlap = (a: CanvasNode, b: CanvasNode): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const clashes = (doc: CanvasDoc): string[][] => {
  const out: string[][] = [];
  const list = doc.nodes.filter((n) => n.type !== AREA_TYPE);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (overlap(list[i] as CanvasNode, list[j] as CanvasNode)) out.push([(list[i] as CanvasNode).id, (list[j] as CanvasNode).id]);
  return out;
};
const areaOf = (id: string): string => `${ORGANIZE_AREA_PREFIX}${id}`;

/** Três orquestradores com recrutas, notas de andamento, uma nota compartilhada, um órfão e um terminal do dono com nota. */
function world(): CanvasDoc {
  const nodes = [
    orq("a"), recruit("a1", "a"), recruit("a2", "a"), note("a1n"), note("a2n"), note("a-shared"),
    orq("b"), recruit("b1", "b"), note("b1n"),
    orq("c"), recruit("c1", "c"),
    term("dono"), note("dono-n"), note("solta"), term("sem-nada"),
  ];
  const edges = [
    edge("e1", "a1", "a1n"), edge("e2", "a2", "a2n"), edge("e3", "a1", "a-shared"), edge("e4", "a2", "a-shared"),
    edge("e5", "b1", "b1n"), edge("e6", "dono", "dono-n"),
    edge("r1", "a", "a1", "recruit"), edge("r2", "a", "a2", "recruit"), edge("r3", "b", "b1", "recruit"), edge("r4", "c", "c1", "recruit"),
  ];
  return docOf(nodes, edges);
}

describe("organizeCanvas: agrupamento", () => {
  test("dados três orquestradores, quando organiza, então cada equipe tem a sua área com terminal, recrutas e notas", () => {
    const result = organizeCanvas(world());
    const team = (id: string) => result.areas.find((a) => a.id === areaOf(id));
    expect(team("a")?.members.sort()).toEqual(["a", "a-shared", "a1", "a1n", "a2", "a2n"]);
    expect(team("b")?.members.sort()).toEqual(["b", "b1", "b1n"]);
    expect(team("c")?.members.sort()).toEqual(["c", "c1"]);
  });

  test("dada nota ligada só a um recruta, quando organiza, então ela fica ao lado dele, na altura do recruta", () => {
    const next = organized(world());
    const [recruitNode, side] = [at(next, "a1"), at(next, "a1n")];
    expect(side.x).toBeGreaterThanOrEqual(recruitNode.x + recruitNode.w);
    expect(side.y).toBeGreaterThanOrEqual(recruitNode.y);
    expect(side.y + side.h).toBeLessThanOrEqual(recruitNode.y + ORGANIZE_LAYOUT.terminalH);
  });

  test("dada nota ligada a dois recrutas do mesmo orquestrador, quando organiza, então vai ao cabeçalho ao lado do orquestrador", () => {
    const next = organized(world());
    const [lead, shared, first] = [at(next, "a"), at(next, "a-shared"), at(next, "a1")];
    expect(shared.y).toBe(lead.y);
    expect(shared.x).toBeGreaterThanOrEqual(lead.x + lead.w);
    expect(first.y).toBeGreaterThan(lead.y + lead.h);
  });

  test("dado terminal do dono com nota própria, quando organiza, então ganha área própria", () => {
    const result = organizeCanvas(world());
    expect(result.areas.find((a) => a.id === areaOf("dono"))?.members.sort()).toEqual(["dono", "dono-n"]);
  });

  test("dado nó órfão e terminal sem nota, quando organiza, então ficam em FORA, fora de toda área e sem sobrepor nada", () => {
    const result = organizeCanvas(world());
    expect(result.fora).toEqual(["solta", "sem-nada"]);
    for (const area of result.areas) expect(area.members).not.toContain("solta");
    expect(clashes(organized(world()))).toEqual([]);
  });

  test("dado canvas com três orquestradores, quando organiza, então todo terminal e nota ligados estão em área, sem sobreposição", () => {
    const next = organized(world());
    const inArea = new Set(areaNodes(next).flatMap((a) => a.data.members));
    for (const id of ["a", "a1", "a2", "a1n", "a2n", "a-shared", "b", "b1", "b1n", "c", "c1", "dono", "dono-n"]) expect(inArea.has(id)).toBe(true);
    expect(clashes(next)).toEqual([]);
  });

  test("dado recruta só pela aresta recruit, quando organiza, então entra na área do orquestrador sem edição de configuração", () => {
    const doc = docOf([orq("a"), term("novo")], [edge("r", "a", "novo", "recruit")]);
    expect(organizeCanvas(doc).areas[0]?.members).toContain("novo");
  });

  test("dados dois terminais com o mesmo nome, quando organiza, então cada um vai para a equipe do seu id", () => {
    const doc = docOf(
      [orq("a"), orq("b"), term("a1", { name: "lib", recruiter: "a" }), term("b1", { name: "lib", recruiter: "b" })],
    );
    const result = organizeCanvas(doc);
    expect(result.areas.find((x) => x.id === areaOf("a"))?.members).toContain("a1");
    expect(result.areas.find((x) => x.id === areaOf("b"))?.members).toContain("b1");
    expect(result.areas.find((x) => x.id === areaOf("a"))?.members).not.toContain("b1");
  });
});

describe("organizeCanvas: medidas", () => {
  test("dada uma equipe, quando organiza, então a área cabe o conteúdo com o padding", () => {
    const next = organized(world());
    const box = at(next, areaOf("b"));
    for (const id of membersOf(next, areaOf("b"))) {
      const node = at(next, id);
      expect(node.x).toBeGreaterThanOrEqual(box.x + ORGANIZE_LAYOUT.padding);
      expect(node.x + node.w).toBeLessThanOrEqual(box.x + box.w - ORGANIZE_LAYOUT.padding);
      expect(node.y + node.h).toBeLessThanOrEqual(box.y + box.h - ORGANIZE_LAYOUT.padding);
    }
  });

  test("dado terminal menor que a medida padrão, quando organiza, então o espaço dele é o da medida (sem sobreposição)", () => {
    const small = docOf([orq("a"), term("a1", { recruiter: "a" }, { w: 400, h: 240 }), term("a2", { recruiter: "a" }, { w: 400, h: 240 })]);
    const next = organized(small);
    expect(Math.abs(at(next, "a2").x - at(next, "a1").x)).toBeGreaterThanOrEqual(ORGANIZE_LAYOUT.terminalW);
  });
});

describe("organizeCanvas: estabilidade", () => {
  test("dada uma segunda rodada sem mudança no grafo, então o documento é idêntico byte a byte e não há operação", () => {
    const once = organized(world());
    expect(organizeOp(once, organizeCanvas(once))).toBeUndefined();
    expect(JSON.stringify(organized(once))).toBe(JSON.stringify(once));
  });

  test("dado um orquestrador novo, quando reorganiza, então as áreas existentes não se movem", () => {
    const once = organized(world());
    const grown = { ...once, nodes: [...once.nodes, orq("novo"), recruit("novo1", "novo")], edges: [...once.edges, edge("r9", "novo", "novo1", "recruit")] };
    const twice = organized(grown);
    for (const id of ["a", "b", "c", "dono"]) expect(at(twice, areaOf(id)).x).toBe(at(once, areaOf(id)).x);
    for (const id of ["a", "a1", "b1", "c1", "dono-n"]) expect([at(twice, id).x, at(twice, id).y]).toEqual([at(once, id).x, at(once, id).y]);
    expect(at(twice, areaOf("novo")).x).toBeGreaterThan(at(twice, areaOf("dono")).x);
    expect(clashes(twice)).toEqual([]);
  });

  test("dado um recruta novo, quando reorganiza, então entra na área do orquestrador e o resto da equipe não se move", () => {
    const once = organized(world());
    const grown = { ...once, nodes: [...once.nodes, recruit("a3", "a")], edges: [...once.edges, edge("r8", "a", "a3", "recruit")] };
    const twice = organized(grown);
    expect(membersOf(twice, areaOf("a"))).toContain("a3");
    for (const id of ["a", "a1", "a2", "a1n"]) expect([at(twice, id).x, at(twice, id).y]).toEqual([at(once, id).x, at(once, id).y]);
    expect(clashes(twice)).toEqual([]);
  });

  test("dada a ordem das equipes, então vem da posição no canvas e não do nome", () => {
    const doc = docOf([orq("z"), orq("a")]);
    const once = organized(doc);
    expect(at(once, areaOf("z")).x).toBeLessThan(at(once, areaOf("a")).x);
  });

  test("dado nó travado ou fixado, quando organiza, então ele não se move e nenhum nó cai em cima dele", () => {
    const doc = docOf([orq("a"), recruit("a1", "a"), { ...recruit("a2", "a"), x: 5, y: 7, locked: true }, recruit("a3", "a")], []);
    const next = organized(doc);
    expect([at(next, "a2").x, at(next, "a2").y]).toEqual([5, 7]);
    expect(organizeCanvas(doc).fixed).toEqual(["a2"]);
    const pinned = organized(docOf([orq("a"), { ...term("p"), x: 3, y: 4 }]), { pinned: new Set(["p"]) });
    expect([at(pinned, "p").x, at(pinned, "p").y]).toEqual([3, 4]);
  });

  test("dada uma rodada, então nada é apagado: os mesmos nós e arestas, só posição e áreas mudam", () => {
    const doc = world();
    const next = organized(doc);
    expect(next.edges).toEqual(doc.edges);
    expect(next.nodes.filter((n) => n.type !== AREA_TYPE).map((n) => n.id)).toEqual(doc.nodes.map((n) => n.id));
    expect(next.nodes.filter((n) => n.type === AREA_TYPE).every((n) => n.id.startsWith(ORGANIZE_AREA_PREFIX))).toBe(true);
  });

  test("dado nó que estava em área do dono, quando organiza, então sai dela e a área do dono segue de pé", () => {
    const own: CanvasNode = { id: "minha", type: AREA_TYPE, x: 0, y: 0, w: 400, h: 300, z: -1, data: areaDataOf({ title: "minha", color: "chart-1", members: ["a1"] }), locked: false, blurred: false };
    const doc = docOf([orq("a"), recruit("a1", "a"), own], []);
    const next = organized(doc);
    expect(membersOf(next, "minha")).toEqual([]);
    expect(membersOf(next, areaOf("a"))).toContain("a1");
  });

  test("dado título renomeado pelo dono numa área nossa, quando reorganiza, então o título fica", () => {
    const once = organized(docOf([orq("a")]));
    const renamed = { ...once, nodes: once.nodes.map((n) => (n.type === AREA_TYPE ? { ...n, data: areaDataOf({ title: "Meu nome", color: "chart-3", members: ["a"] }) } : n)) };
    expect(areaNodes(organized(renamed))[0]?.data.title).toBe("Meu nome");
  });
});

describe("organizeCanvas: sub-áreas por regra", () => {
  const rules = parseAreaRules(JSON.stringify({ areas: [{ title: "Specs", prefix: "spec-" }, { title: "Núcleo", pattern: "*-core" }] }));
  const base = (): CanvasDoc => docOf(
    [orq("a"), term("r1", { name: "spec-login", recruiter: "a" }), term("r2", { name: "x-core", recruiter: "a" }), term("r3", { name: "outro", recruiter: "a" }), note("n1", "spec-notas"), note("n2", "livre")],
    [edge("l1", "a", "n1"), edge("l2", "a", "n2")],
  );

  test("dadas regras por prefixo e padrão, quando organiza, então o nó que casa vai para a sub-área e o que não casa fica na do orquestrador", () => {
    const next = organized(base(), { rules });
    expect(membersOf(next, `${areaOf("a")}:s-specs`).sort()).toEqual(["n1", "r1"]);
    expect(membersOf(next, `${areaOf("a")}:s-nucleo`)).toEqual(["r2"]);
    expect(membersOf(next, areaOf("a")).sort()).toEqual(["a", "n2", "r3"]);
    expect(clashes(next)).toEqual([]);
  });

  test("dado sem regras, então nenhuma sub-área nasce", () => {
    expect(organizeCanvas(base()).areas.map((a) => a.kind)).toEqual(["team"]);
  });

  test("dada regra de outro orquestrador, então ela não vale para este", () => {
    const only = parseAreaRules(JSON.stringify({ areas: [{ title: "Specs", prefix: "spec-", orchestrator: "outro-orq" }] }));
    expect(organizeCanvas(base(), { rules: only }).areas).toHaveLength(1);
  });

  test("dada uma segunda rodada com regras, então o documento é idêntico", () => {
    const once = organized(base(), { rules });
    expect(JSON.stringify(organized(once, { rules }))).toBe(JSON.stringify(once));
  });

  test("dado arquivo de regras inválido, então recusa com o código estável", () => {
    for (const bad of ["{", "[]", '{"areas":[{"title":"x"}]}', '{"areas":[{"title":"x","prefix":"a","extra":1}]}', '{"areas":[{"title":"x","prefix":"a"},{"title":"X","prefix":"b"}]}', `{"areas":[{"title":"${"x".repeat(101)}","prefix":"a"}]}`]) {
      expect(() => parseAreaRules(bad)).toThrow(OrganizeError);
      try {
        parseAreaRules(bad);
      } catch (error) {
        expect((error as OrganizeError).code).toBe(ORGANIZE_ERRORS.invalidRules);
      }
    }
  });

  test("dado padrão com metacaracteres de regex, então são literais (só * e ? valem)", () => {
    const literal = parseAreaRules(JSON.stringify({ areas: [{ title: "P", pattern: "a.b(c" }] }));
    const doc = docOf([orq("o"), term("r1", { name: "a.b(c", recruiter: "o" }), term("r2", { name: "aXb(c", recruiter: "o" })]);
    expect(organizeCanvas(doc, { rules: literal }).areas.find((a) => a.kind === "sub")?.members).toEqual(["r1"]);
  });
});

describe("hades canvas organize", () => {
  const stored = (): CanvasDoc => ({ ...world(), rev: 4 });
  const run = async (args: string[], options: { rules?: string } = {}) => {
    let doc = stored();
    const calls: { method: string; path: string }[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const deps = {
      async panel(method: string, path: string, body?: unknown) {
        calls.push({ method, path });
        if (method === "GET") return { status: 200, body: doc };
        doc = { ...(body as CanvasDoc), rev: doc.rev + 1 };
        return { status: 200, body: { rev: doc.rev } };
      },
      areaRules: () => options.rules,
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    } as unknown as CanvasCliDeps;
    const code = await runCanvas(args, deps);
    return { code, calls, out, err, doc: () => doc };
  };

  test("dado --dry-run, quando roda, então imprime áreas, medidas e FORA e não chama o PUT", async () => {
    const r = await run(["organize", "--dry-run"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.calls.every((c) => c.method === "GET")).toBe(true);
    expect(r.out[0]).toMatch(/^áreas: 4\tmovidos: \d+\tfixos: 0\tFORA: 2$/);
    expect(r.out.some((l) => l.startsWith("org:a\t"))).toBe(true);
    expect(r.out.filter((l) => l.startsWith("FORA\t"))).toHaveLength(2);
    expect(r.out.at(-1)).toContain("nada foi gravado");
  });

  test("dado o canvas padrão, quando roda, então grava uma vez com a revisão lida e o painel guarda as áreas", async () => {
    const r = await run(["organize"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.calls).toEqual([{ method: "GET", path: "/api/canvases/default" }, { method: "PUT", path: "/api/canvases/default" }]);
    expect(areaNodes(r.doc()).map((a) => a.node.id)).toContain("org:a");
  });

  test("dado --canvas, quando roda, então usa o canvas pedido", async () => {
    const r = await run(["organize", "--canvas", "outro", "--dry-run"]);
    expect(r.calls[0]?.path).toBe("/api/canvases/outro");
  });

  test("dado canvas-areas.json inválido, quando roda, então sai 1 com o código estável e nada é gravado", async () => {
    const r = await run(["organize"], { rules: "{" });
    expect(r.code).toBe(EXIT.fail);
    expect(r.err.join("\n")).toContain(ORGANIZE_ERRORS.invalidRules);
    expect(r.calls).toEqual([]);
  });

  test("dado canvas já organizado, quando roda de novo, então não grava", async () => {
    const once = await run(["organize"]);
    const again = organizeOp(once.doc(), organizeCanvas(once.doc()));
    expect(again).toBeUndefined();
  });
});
