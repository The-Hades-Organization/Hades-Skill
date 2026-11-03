// Grupo canvas-plan: parser puro do plano (src/lib/canvas-plan.ts) — título, seções, "Estado atual", tabela de unidades
// (colunas, dependências, `|` dentro de código), blocos de código ignorados, tetos e recusas, e a ligação unidade → agente.
import { describe, expect, test } from "bun:test";
import { type AgentRef, linkUnitsToAgents, parsePlan, PLAN_ERRORS, PLAN_LIMITS, PlanError } from "../../../src/lib/canvas-plan";

const PLAN = [
  "# Plano — rodada de teste",
  "",
  "## Estado atual",
  "- **Em voo (2):** u-a, u-b",
  "- próximo passo: auditar",
  "",
  "## Objetivo",
  "Entregar duas unidades.",
  "",
  "## Unidades",
  "| Unidade | Card | Papel | Modelo/esforço | Base | Depende de | Specs |",
  "|---|---|---|---|---|---|---|",
  "| u-a | — (skill) | impl | sonnet/high | main | — | — |",
  "| `u-b` | — | review | sonnet/medium | main | u-a, `u-c` | uma `a|b` aqui |",
  "",
  "## Riscos",
  "Nenhum.",
].join("\n");

const names = (units: { name: string }[]): string[] => units.map((u) => u.name);

describe("canvas-plan: parsePlan", () => {
  test("dado um plano completo, devolve título, seções na ordem e a seção Estado atual", () => {
    const plan = parsePlan(PLAN);
    expect(plan.title).toBe("Plano — rodada de teste");
    expect(plan.sections.map((s) => s.title)).toEqual(["Estado atual", "Objetivo", "Unidades", "Riscos"]);
    expect(plan.state?.body).toBe("- **Em voo (2):** u-a, u-b\n- próximo passo: auditar");
    expect(plan.truncated).toEqual({ sections: false, units: false });
  });

  test("dado a tabela de unidades, lê nome, papel, base e dependências (crases e vazios saem)", () => {
    const { units, skippedRows } = parsePlan(PLAN);
    expect(skippedRows).toBe(0);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ name: "u-a", role: "impl", base: "main", dependsOn: [] });
    expect(units[1]).toMatchObject({ name: "u-b", role: "review", dependsOn: ["u-a", "u-c"] });
  });

  test("dado `|` no texto da última coluna, o excesso volta para ela", () => {
    const { units } = parsePlan(PLAN);
    expect(units[1]?.cells.specs).toBe("uma `a|b` aqui");
  });

  test("dado um plano sem tabela nem Estado atual, units vazio e state nulo", () => {
    const plan = parsePlan("# Só título\n\n## Objetivo\ntexto\n");
    expect([plan.state, plan.units, plan.sections.length]).toEqual([null, [], 1]);
  });

  test("dado texto vazio, devolve tudo vazio sem erro", () => {
    expect(parsePlan("")).toEqual({ title: null, state: null, sections: [], units: [], skippedRows: 0, truncated: { sections: false, units: false } });
  });

  test("dado `## Unidades` dentro de bloco de código, não vira seção nem tabela", () => {
    const plan = parsePlan(["# T", "```", "## Unidades", "| Unidade |", "|---|", "| x |", "```", "## Fim", "ok"].join("\n"));
    expect(plan.sections.map((s) => s.title)).toEqual(["Fim"]);
    expect(plan.units).toEqual([]);
  });

  test("dado CRLF, lê igual ao LF", () => {
    expect(parsePlan(PLAN.replaceAll("\n", "\r\n"))).toEqual(parsePlan(PLAN));
  });

  test("dado linha com nome de unidade inválido, conta em skippedRows em vez de sumir", () => {
    const text = ["## Unidades", "| Unidade | Papel |", "|---|---|", "| ok-1 | impl |", "| nome com espaço | impl |", "| | impl |"].join("\n");
    const plan = parsePlan(text);
    expect(names(plan.units)).toEqual(["ok-1"]);
    expect(plan.skippedRows).toBe(2);
  });

  test("dado tabela sem coluna Papel, o papel padrão é impl", () => {
    expect(parsePlan(["## Unidades", "| Unidade | Base |", "|---|---|", "| u | main |"].join("\n")).units[0]?.role).toBe("impl");
  });

  test("dado mais unidades que o teto, corta no teto e avisa em truncated", () => {
    const rows = Array.from({ length: PLAN_LIMITS.units + 5 }, (_, i) => `| u-${i} | impl |`);
    const plan = parsePlan(["## Unidades", "| Unidade | Papel |", "|---|---|", ...rows].join("\n"));
    expect(plan.units).toHaveLength(PLAN_LIMITS.units);
    expect(plan.truncated.units).toBe(true);
  });

  test("dado mais seções que o teto, corta no teto e avisa em truncated", () => {
    const text = Array.from({ length: PLAN_LIMITS.sections + 3 }, (_, i) => `## S${i}\ncorpo`).join("\n");
    const plan = parsePlan(text);
    expect(plan.sections).toHaveLength(PLAN_LIMITS.sections);
    expect(plan.truncated.sections).toBe(true);
  });

  test("dado corpo de seção maior que o teto, corta e marca clipped (o Estado atual tem teto próprio, maior)", () => {
    const big = "x".repeat(PLAN_LIMITS.sectionChars + 10);
    const plan = parsePlan(`## Corpo\n${big}\n## Estado atual\n${big}`);
    expect([plan.sections[0]?.body.length, plan.sections[0]?.clipped]).toEqual([PLAN_LIMITS.sectionChars, true]);
    expect([plan.state?.body.length, plan.state?.clipped]).toEqual([PLAN_LIMITS.sectionChars + 10, false]);
  });

  test("dado célula maior que o teto, a célula é cortada", () => {
    const plan = parsePlan(["## Unidades", "| Unidade | Specs |", "|---|---|", `| u | ${"y".repeat(PLAN_LIMITS.cellChars + 50)} |`].join("\n"));
    expect(plan.units[0]?.cells.specs).toHaveLength(PLAN_LIMITS.cellChars);
  });

  test("dado texto acima do teto de bytes, recusa com plan_too_large", () => {
    let error: unknown;
    try {
      parsePlan("a".repeat(PLAN_LIMITS.textBytes + 1));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PlanError);
    expect((error as PlanError).code).toBe(PLAN_ERRORS.tooLarge);
  });

  test("dado entrada que não é texto, recusa com plan_invalid_text", () => {
    expect(() => parsePlan(42 as unknown as string)).toThrow(PlanError);
    try {
      parsePlan(null as unknown as string);
    } catch (e) {
      expect((e as PlanError).code).toBe(PLAN_ERRORS.invalidText);
    }
  });

  test("dado o mesmo texto duas vezes, o resultado é idêntico (puro)", () => {
    expect(parsePlan(PLAN)).toEqual(parsePlan(PLAN));
  });
});

describe("canvas-plan: linkUnitsToAgents", () => {
  const agents: AgentRef[] = [
    { name: "u-a", registry: "owner__repo", state: "working" },
    { name: "u-a", registry: "_skill", state: "done" },
    { name: "outro", registry: "_skill", state: "idle" },
  ];

  test("dado agente de mesmo nome, liga a unidade; sem agente, agent é nulo", () => {
    const linked = linkUnitsToAgents(parsePlan(PLAN).units, agents);
    expect(linked.map((u) => [u.name, u.agent?.registry ?? null])).toEqual([["u-a", "owner__repo"], ["u-b", null]]);
  });

  test("dado o nome em dois registros, vence o primeiro da lista", () => {
    expect(linkUnitsToAgents(parsePlan(PLAN).units, [...agents].reverse())[0]?.agent).toEqual({ name: "u-a", registry: "_skill", state: "done" });
  });

  test("dado lista vazia de unidades ou de agentes, não quebra", () => {
    expect(linkUnitsToAgents([], agents)).toEqual([]);
    expect(linkUnitsToAgents(parsePlan(PLAN).units, []).every((u) => u.agent === null)).toBe(true);
  });

  test("a ligação não muda a unidade original", () => {
    const units = parsePlan(PLAN).units;
    const before = JSON.stringify(units);
    linkUnitsToAgents(units, agents);
    expect(JSON.stringify(units)).toBe(before);
  });
});
