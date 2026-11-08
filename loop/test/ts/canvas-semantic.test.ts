import { describe, expect, test } from "bun:test";
import {
  bucketOf, ciWord, countBuckets, countText, labelAt, LABEL_MIN_AREA_PX, placeLabels, SUMMARY_MAX_CHARS, SUMMARY_MIN_BLOCK_PX, summaryFits, summaryOf,
} from "../../../src/lib/canvas-semantic";

describe("canvas-semantic: contagem por estado", () => {
  test("dado permissão pendente ou bloqueio, então o nó pede você", () => {
    expect(bucketOf({ state: "working", pendingPermission: { tool: "Bash" } })).toBe("attention");
    expect(bucketOf({ state: "blocked" })).toBe("attention");
  });

  test("dado agente trabalhando, então conta como trabalhando; idle, done e fora contam como repouso", () => {
    expect(bucketOf({ state: "working", pendingPermission: null })).toBe("working");
    for (const state of ["idle", "done", "fora", "unknown"]) expect(bucketOf({ state })).toBe("rest");
  });

  test("dado nó do usuário, então não tem balde e não entra na conta", () => {
    expect(bucketOf(undefined)).toBeUndefined();
    expect(countBuckets([undefined, "working", "working", "rest", "attention"])).toEqual({ attention: 1, working: 2, rest: 1 });
  });

  test("dado contagem, então o texto põe o que pede você primeiro e omite o zero", () => {
    expect(countText({ attention: 1, working: 3, rest: 2 })).toBe("1 pede você · 3 trabalhando · 2 em repouso");
    expect(countText({ attention: 0, working: 2, rest: 0 })).toBe("2 trabalhando");
    expect(countText({ attention: 0, working: 0, rest: 0 })).toBe("");
  });
});

describe("canvas-semantic: rótulos de área", () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

  test("dado área menor que o mínimo, então fica sem rótulo", () => {
    const small = box(0, 0, LABEL_MIN_AREA_PX.w - 1, 200);
    expect(placeLabels([{ id: "a", box: small, lines: 2 }], 11)).toEqual([]);
    expect(placeLabels([{ id: "a", box: box(0, 0, 200, LABEL_MIN_AREA_PX.h - 1), lines: 1 }], 11)).toEqual([]);
  });

  test("dado duas áreas sobrepostas, então só a maior leva rótulo", () => {
    const placed = placeLabels([
      { id: "pequena", box: box(10, 10, 80, 60), lines: 1 },
      { id: "grande", box: box(0, 0, 300, 200), lines: 1 },
    ], 11);
    expect(placed.map((p) => p.id)).toEqual(["grande"]);
  });

  test("dado áreas lado a lado, então cada uma leva o seu e eles não se cruzam", () => {
    const placed = placeLabels([
      { id: "a", box: box(0, 0, 100, 100), lines: 2 },
      { id: "b", box: box(120, 0, 100, 100), lines: 2 },
    ], 11);
    expect(placed.map((p) => p.id).sort()).toEqual(["a", "b"]);
    const [a, b] = placed;
    expect((a?.rect.x ?? 0) + (a?.rect.w ?? 0)).toBeLessThanOrEqual(b?.rect.x ?? 0);
  });

  test("dado caixa baixa, então a contagem (segunda linha) é cortada e o nome fica", () => {
    const [placed] = placeLabels([{ id: "a", box: box(0, 0, 200, 30), lines: 2 }], 11);
    expect(placed?.lines).toBe(1);
  });

  test("dado o ponto sobre o rótulo, então labelAt devolve a área; fora dele, nada", () => {
    const placed = placeLabels([{ id: "a", box: box(100, 100, 200, 120), lines: 2 }], 11);
    expect(labelAt(placed, { x: 110, y: 108 })?.id).toBe("a");
    expect(labelAt(placed, { x: 110, y: 215 })).toBeUndefined();
    expect(labelAt([], { x: 0, y: 0 })).toBeUndefined();
  });

  test("dado o mesmo tamanho, então vale a ordem recebida (resultado estável)", () => {
    const input = [
      { id: "x", box: box(0, 0, 100, 100), lines: 1 },
      { id: "y", box: box(50, 0, 100, 100), lines: 1 },
    ];
    expect(placeLabels(input, 11).map((p) => p.id)).toEqual(["x"]);
  });
});

describe("canvas-semantic: resumo por tipo", () => {
  test("dado agente, então o resumo é o estado e a fase", () => {
    expect(summaryOf({ type: "agent", live: { state: "working", phase: "impl" } })).toBe("trabalhando · impl");
    expect(summaryOf({ type: "agent", live: { state: "idle", phase: null } })).toBe("ocioso");
  });

  test("dado agente com permissão pendente, então o estado dito é o de espera por você", () => {
    expect(summaryOf({ type: "agent", live: { state: "working", pendingPermission: { tool: "Bash" }, phase: "impl" } })).toBe("espera por você · impl");
  });

  test("dado agente sem registro vivo, então não há resumo", () => {
    expect(summaryOf({ type: "agent" })).toBeUndefined();
  });

  test("dado PR, então o resumo traz número, estado e CI", () => {
    expect(summaryOf({ type: "pr", live: { number: 42, state: "open", ci: { passing: 3, failing: 0, pending: 0 } } })).toBe("#42 · aberta · CI ok");
    expect(summaryOf({ type: "pr", live: { number: 7, state: "open", ci: null } })).toContain("#7");
  });

  test("dado CI, então falha vale mais que pendente, que vale mais que ok", () => {
    expect(ciWord({ passing: 5, failing: 1, pending: 2 })).toBe("CI falhou");
    expect(ciWord({ passing: 5, failing: 0, pending: 2 })).toBe("CI rodando");
    expect(ciWord({ passing: 5, failing: 0, pending: 0 })).toBe("CI ok");
    expect(ciWord({ passing: 0, failing: 0, pending: 0 })).toBeUndefined();
    expect(ciWord(undefined)).toBeUndefined();
    expect(ciWord("falhou")).toBeUndefined();
  });

  test("dado nota, então vale o título; sem título, a primeira linha não vazia sem os #", () => {
    expect(summaryOf({ type: "note", data: { title: "  Plano  ", text: "outra coisa" } })).toBe("Plano");
    expect(summaryOf({ type: "note", data: { text: "\n\n## Decisões\ncorpo" } })).toBe("Decisões");
  });

  test("dado nota que só aponta para um arquivo, então não há resumo", () => {
    expect(summaryOf({ type: "note", data: { note: "plano" } })).toBeUndefined();
    expect(summaryOf({ type: "note", data: { text: "   \n " } })).toBeUndefined();
  });

  test("dado terminal ou tipo desconhecido, então não há resumo", () => {
    expect(summaryOf({ type: "terminal", data: { name: "x" } })).toBeUndefined();
    expect(summaryOf({ type: "gate", live: { state: "running" } })).toBeUndefined();
  });

  test("dado texto enorme, então o resumo respeita o teto de caracteres", () => {
    const out = summaryOf({ type: "note", data: { title: "a".repeat(5000) } });
    expect(out?.length).toBe(SUMMARY_MAX_CHARS);
  });

  test("dado o bloco baixo, então não há altura para o resumo; no limiar, há", () => {
    expect(summaryFits(SUMMARY_MIN_BLOCK_PX - 0.1)).toBe(false);
    expect(summaryFits(SUMMARY_MIN_BLOCK_PX)).toBe(true);
  });
});
