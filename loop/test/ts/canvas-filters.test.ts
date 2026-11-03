// Grupo canvas-filters: barra de filtros do canvas (src/lib/canvas-filters.ts) — faixas de idade e custo, chips com
// contagem facetada, "ou" dentro da dimensão e "e" entre dimensões, ligação por qualquer ponta, relógio por parâmetro.
import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_ANY, ACTIVITY_WINDOWS, AGENT_DIMS, CHIP_DIMS, FILTER_DIMS, FILTER_ERRORS, FilterError, UNSET, activeFilterCount, activityOf,
  activityWindows, ageBand, applyFilters, buildFilterBar, clearChips, costBand, passesAgentDims, setActivity, setShowArchived, showsArchived,
  toggleFilter, type FilterDimension, type FilterEdge, type FilterNode, type FilterSelection,
} from "../../../src/lib/canvas-filters";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const NODES: FilterNode[] = [
  { id: "agent:p:a1", type: "agent", state: "working", role: "impl", registry: "p", lastEventTs: ago(5), costUsd: 0.4 },
  { id: "agent:p:a2", type: "agent", state: "idle", role: "review", registry: "p", lastEventTs: ago(600), costUsd: 3 },
  { id: "agent:s:a3", type: "agent", state: "working", role: null, registry: "_skill", lastEventTs: ago(60 * 24 * 10), costUsd: 25 },
  { id: "pr:p:7", type: "pr", state: "open", role: null, registry: "p", lastEventTs: null },
  { id: "gate:99", type: "gate", state: "waiting", role: null, registry: null, lastEventTs: null },
];
const EDGES: FilterEdge[] = [
  { from: "agent:p:a1", to: "pr:p:7", kind: "agent_pr" },
  { from: "agent:p:a2", to: "agent:p:a1", kind: "stack" },
];

const dimension = (bar: FilterDimension[], dim: string): FilterDimension => bar.find((d) => d.dim === dim) as FilterDimension;
const counts = (bar: FilterDimension[], dim: string): Record<string, number> => Object.fromEntries(dimension(bar, dim).chips.map((c) => [c.value, c.count]));
const idsOf = (selection: FilterSelection, nodes: FilterNode[] = NODES, edges: FilterEdge[] = EDGES): string[] => [...applyFilters(nodes, edges, selection, NOW).visible];

describe("canvas-filters: faixas", () => {
  test("dado a idade do último evento, então cai na faixa nomeada (limite incluso na faixa menor)", () => {
    expect(ageBand(ago(0), NOW)).toBe("m15");
    expect(ageBand(ago(15), NOW)).toBe("m15");
    expect(ageBand(ago(15.01), NOW)).toBe("d1");
    expect(ageBand(ago(60 * 24), NOW)).toBe("d1");
    expect(ageBand(ago(60 * 24 * 7), NOW)).toBe("d7");
    expect(ageBand(ago(60 * 24 * 7 + 1), NOW)).toBe("older");
  });

  test("dado evento no futuro (relógio adiantado), então conta como recente", () => {
    expect(ageBand(ago(-120), NOW)).toBe("m15");
  });

  test("dado evento ausente, texto sem fuso ou data inválida, então é sem evento", () => {
    for (const ts of [null, undefined, "", "lixo", "2026-11-02T11:59:00", "2026-13-45T00:00:00Z"]) expect(ageBand(ts, NOW)).toBe("none");
  });

  test("dado fuso explícito diferente de UTC, então o instante é o mesmo", () => {
    expect(ageBand("2026-11-02T08:00:00-03:00", NOW)).toBe("d1");
    expect(ageBand("2026-11-02T08:55:00-03:00", NOW)).toBe("m15");
  });

  test("dado o custo, então cai na faixa (limite superior é da faixa seguinte)", () => {
    expect(costBand(0)).toBe("low");
    expect(costBand(0.99)).toBe("low");
    expect(costBand(1)).toBe("mid");
    expect(costBand(9.99)).toBe("mid");
    expect(costBand(10)).toBe("high");
    expect(costBand(1e9)).toBe("high");
  });

  test("dado custo ausente, negativo ou não finito, então é sem custo medido", () => {
    for (const cost of [null, undefined, -1, Number.NaN, Infinity]) expect(costBand(cost)).toBe("none");
  });
});

describe("canvas-filters: aplicar", () => {
  test("dado seleção vazia, então tudo está visível", () => {
    expect(idsOf({})).toEqual(NODES.map((n) => n.id));
    expect(idsOf({ state: [], type: [] })).toEqual(NODES.map((n) => n.id));
  });

  test("dado dois valores na mesma dimensão, então vale o ou", () => {
    expect(idsOf({ state: ["idle", "open"] })).toEqual(["agent:p:a2", "pr:p:7"]);
  });

  test("dado duas dimensões, então vale o e", () => {
    expect(idsOf({ state: ["working"], registry: ["_skill"] })).toEqual(["agent:s:a3"]);
  });

  test("dado filtro de tipo de ligação, então vale pelas duas pontas da aresta", () => {
    expect(idsOf({ edgeKind: ["stack"] })).toEqual(["agent:p:a1", "agent:p:a2"]);
    expect(idsOf({ edgeKind: ["agent_pr"] })).toEqual(["agent:p:a1", "pr:p:7"]);
  });

  test("dado nó sem papel, raiz ou ligação, então ele é o valor UNSET", () => {
    expect(idsOf({ role: [UNSET] })).toEqual(["agent:s:a3", "pr:p:7", "gate:99"]);
    expect(idsOf({ registry: [UNSET] })).toEqual(["gate:99"]);
    expect(idsOf({ edgeKind: [UNSET] })).toEqual(["agent:s:a3", "gate:99"]);
  });

  test("dado filtro de idade e custo por faixa, então usa o relógio recebido", () => {
    expect(idsOf({ age: ["m15"] })).toEqual(["agent:p:a1"]);
    expect(idsOf({ age: ["older"] })).toEqual(["agent:s:a3"]);
    expect(idsOf({ age: ["none"] })).toEqual(["pr:p:7", "gate:99"]);
    expect(idsOf({ cost: ["high"] })).toEqual(["agent:s:a3"]);
    expect(idsOf({ cost: ["none"] })).toEqual(["pr:p:7", "gate:99"]);
    const later = applyFilters(NODES, EDGES, { age: ["m15"] }, NOW + 3_600_000);
    expect(later.visible.size).toBe(0);
  });

  test("dado valor que nenhum nó tem, então nada fica visível", () => {
    expect(idsOf({ state: ["inexistente"] })).toEqual([]);
  });

  test("dado filtro, então só as arestas entre nós visíveis sobrevivem", () => {
    const result = applyFilters(NODES, EDGES, { state: ["working", "open"] }, NOW);
    expect(result.edges).toEqual([{ from: "agent:p:a1", to: "pr:p:7", kind: "agent_pr" }]);
  });

  test("dado grafo vazio, então não há nada visível nem erro", () => {
    const result = applyFilters([], [], { state: ["x"] }, NOW);
    expect(result.visible.size).toBe(0);
    expect(result.edges).toEqual([]);
  });

  test("dado relógio inválido, então falha com código estável", () => {
    for (const bad of [Number.NaN, Infinity]) {
      try {
        applyFilters(NODES, EDGES, {}, bad);
        throw new Error("não lançou");
      } catch (error) {
        expect(error).toBeInstanceOf(FilterError);
        expect((error as FilterError).code).toBe(FILTER_ERRORS.invalidClock);
      }
    }
  });

  test("dado o mesmo relógio, então o resultado é o mesmo (determinismo)", () => {
    expect(idsOf({ age: ["d1"], cost: ["mid"] })).toEqual(idsOf({ age: ["d1"], cost: ["mid"] }));
  });
});

describe("canvas-filters: barra de chips", () => {
  test("dado seleção vazia, então a contagem é do total por valor e a ordem das dimensões é fixa", () => {
    const bar = buildFilterBar(NODES, EDGES, {}, NOW);
    expect(bar.map((d) => d.dim)).toEqual([...CHIP_DIMS]);
    expect(counts(bar, "state")).toEqual({ working: 2, idle: 1, open: 1, waiting: 1 });
    expect(counts(bar, "type")).toEqual({ agent: 3, unit: 0, pr: 1, gate: 1 });
    expect(counts(bar, "age")).toEqual({ m15: 1, d1: 1, d7: 0, older: 1, none: 2 });
    expect(counts(bar, "cost")).toEqual({ low: 1, mid: 1, high: 1, none: 2 });
    expect(counts(bar, "role")).toEqual({ [UNSET]: 3, impl: 1, review: 1 });
  });

  test("dado filtro em outra dimensão, então a contagem reflete esse filtro (faceta)", () => {
    const bar = buildFilterBar(NODES, EDGES, { type: ["agent"] }, NOW);
    expect(counts(bar, "state")).toEqual({ working: 2, idle: 1 });
    expect(counts(bar, "registry")).toEqual({ p: 2, _skill: 1 });
  });

  test("dado filtro na própria dimensão, então a contagem dela ignora o próprio filtro", () => {
    const bar = buildFilterBar(NODES, EDGES, { state: ["idle"] }, NOW);
    expect(counts(bar, "state")).toEqual({ working: 2, idle: 1, open: 1, waiting: 1 });
    expect(counts(bar, "type")).toEqual({ agent: 1, unit: 0, pr: 0, gate: 0 });
  });

  test("dado valor marcado que nenhum nó tem, então o chip continua com contagem 0 e ativo", () => {
    const state = dimension(buildFilterBar(NODES, EDGES, { state: ["sumiu"] }, NOW), "state");
    expect(state.chips.find((c) => c.value === "sumiu")).toEqual({ value: "sumiu", label: "sumiu", count: 0, active: true });
  });

  test("dado dimensão aberta, então ordena por contagem e depois pelo valor", () => {
    const state = dimension(buildFilterBar(NODES, EDGES, {}, NOW), "state");
    expect(state.chips.map((c) => c.value)).toEqual(["working", "idle", "open", "waiting"]);
  });

  test("dado nó com várias ligações do mesmo tipo, então conta o nó uma vez", () => {
    const edges: FilterEdge[] = [...EDGES, { from: "agent:p:a1", to: "gate:99", kind: "agent_pr" }];
    expect(counts(buildFilterBar(NODES, edges, {}, NOW), "edgeKind").agent_pr).toBe(3);
  });

  test("dado chips, então os rótulos são em português e o ativo vem marcado", () => {
    const bar = buildFilterBar(NODES, EDGES, { cost: ["high"] }, NOW);
    const cost = dimension(bar, "cost");
    expect(cost.label).toBe("Custo");
    expect(cost.chips.map((c) => c.label)).toEqual(["Até US$ 1", "Até US$ 10", "Acima de US$ 10", "Sem custo medido"]);
    expect(cost.chips.filter((c) => c.active).map((c) => c.value)).toEqual(["high"]);
    expect(dimension(bar, "role").chips.find((c) => c.value === UNSET)?.label).toBe("Sem papel");
  });

  test("dado grafo vazio, então os domínios fechados aparecem com 0 e os abertos vêm vazios", () => {
    const bar = buildFilterBar([], [], {}, NOW);
    expect(dimension(bar, "state").chips).toEqual([]);
    expect(Object.values(counts(bar, "type")).every((n) => n === 0)).toBe(true);
  });

  test("dado a soma facetada, então o total visível bate com a contagem de uma dimensão sem filtro", () => {
    const selection: FilterSelection = { type: ["agent"], cost: ["low", "mid"] };
    const bar = buildFilterBar(NODES, EDGES, selection, NOW);
    const visible = applyFilters(NODES, EDGES, selection, NOW).visible.size;
    const unfilteredDim = Object.values(counts(bar, "registry")).reduce((a, b) => a + b, 0);
    expect(unfilteredDim).toBe(visible);
  });
});

describe("canvas-filters: marcar e desmarcar", () => {
  test("dado valor desligado, então toggle liga; ligado, desliga e a dimensão vazia sai da seleção", () => {
    const on = toggleFilter({}, "state", "idle");
    expect(on).toEqual({ state: ["idle"] });
    expect(toggleFilter(on, "state", "working")).toEqual({ state: ["idle", "working"] });
    expect(toggleFilter(on, "state", "idle")).toEqual({});
  });

  test("não altera a seleção recebida e conta os valores ativos", () => {
    const base: FilterSelection = { state: ["idle"], type: ["pr", "gate"] };
    const copy = structuredClone(base);
    toggleFilter(base, "type", "pr");
    expect(base).toEqual(copy);
    expect(activeFilterCount(base)).toBe(3);
    expect(activeFilterCount({})).toBe(0);
  });
});

describe("canvas-filters: dimensões do agente (arquivados e última atividade)", () => {
  const agentAt = (state: string, minutesAgo: number | null) => ({ state, lastEventTs: minutesAgo === null ? null : ago(minutesAgo) });
  const DAY = 24 * 60;

  test("as dimensões do agente vão na seleção (endereço, filtros salvos) mas não na barra de chips", () => {
    expect(FILTER_DIMS).toEqual(expect.arrayContaining([...AGENT_DIMS]));
    expect(CHIP_DIMS.some((dim) => (AGENT_DIMS as readonly string[]).includes(dim))).toBe(false);
    expect(buildFilterBar(NODES, EDGES, { archived: ["show"], activity: ["d7"] }, NOW).map((d) => d.dim)).toEqual([...CHIP_DIMS]);
  });
  test("dado só dimensões do agente marcadas, então os chips não contam nem filtram", () => {
    const sel = { archived: ["show"], activity: ["d1"] };
    expect(activeFilterCount(sel)).toBe(0);
    expect(applyFilters(NODES, EDGES, sel, NOW).visible.size).toBe(NODES.length);
  });
  test("dado seleção sem arquivados, então o arquivado não passa; com o toggle, passa", () => {
    expect(passesAgentDims(agentAt("archived", 1), {}, NOW)).toBe(false);
    expect(passesAgentDims(agentAt("archived", 1), setShowArchived({}, true), NOW)).toBe(true);
    expect(passesAgentDims(agentAt("done", 1), {}, NOW)).toBe(true);
  });
  test("toggle de arquivados liga e desliga sem tocar no resto", () => {
    const on = setShowArchived({ state: ["working"] }, true);
    expect(showsArchived(on)).toBe(true);
    expect(on.state).toEqual(["working"]);
    expect(setShowArchived(on, false)).toEqual({ state: ["working"] });
  });
  test("janelas: 24 h cabe também em 7 e 30 dias; o limite é inclusivo; sem evento não cabe em nenhuma", () => {
    expect(ACTIVITY_WINDOWS.map((w) => w.id)).toEqual(["d1", "d7", "d30"]);
    expect(activityWindows(ago(DAY), NOW)).toEqual(["d1", "d7", "d30"]);
    expect(activityWindows(ago(DAY + 1), NOW)).toEqual(["d7", "d30"]);
    expect(activityWindows(ago(30 * DAY + 1), NOW)).toEqual([]);
    expect(activityWindows(null, NOW)).toEqual([]);
    expect(activityWindows("2026-11-02T11:00:00", NOW)).toEqual([]);
  });
  test("dada janela de 7 dias, então passa quem teve evento até 7 dias e sai quem não tem evento", () => {
    const sel = setActivity({}, "d7");
    expect(activityOf(sel)).toBe("d7");
    expect(passesAgentDims(agentAt("idle", 6 * DAY), sel, NOW)).toBe(true);
    expect(passesAgentDims(agentAt("idle", 8 * DAY), sel, NOW)).toBe(false);
    expect(passesAgentDims(agentAt("idle", null), sel, NOW)).toBe(false);
  });
  test("qualquer data é o padrão: a ausência da dimensão, e escolhê-la tira a dimensão", () => {
    expect(activityOf({})).toBe(ACTIVITY_ANY.id);
    expect(setActivity({ activity: ["d1"], role: ["impl"] }, ACTIVITY_ANY.id)).toEqual({ role: ["impl"] });
    expect(passesAgentDims(agentAt("idle", null), {}, NOW)).toBe(true);
  });
  test("dada janela desconhecida (endereço escrito à mão), então ninguém passa", () => {
    expect(passesAgentDims(agentAt("working", 1), { activity: ["d99"] }, NOW)).toBe(false);
  });
  test("o relógio entra por parâmetro: o mesmo agente sai da janela quando o relógio anda", () => {
    const sel = setActivity({}, "d1");
    const node = agentAt("idle", 60);
    expect(passesAgentDims(node, sel, NOW)).toBe(true);
    expect(passesAgentDims(node, sel, NOW + DAY * 60_000)).toBe(false);
  });
  test("dado relógio inválido, então lança o código estável", () => {
    expect(() => passesAgentDims(agentAt("idle", 1), {}, Number.NaN)).toThrow(expect.objectContaining({ code: FILTER_ERRORS.invalidClock }));
  });
  test("limpar os chips mantém arquivados e janela; seleção sem nada fica vazia", () => {
    expect(clearChips({ state: ["working"], archived: ["show"], activity: ["d7"], cost: ["low"] })).toEqual({ archived: ["show"], activity: ["d7"] });
    expect(clearChips({ role: ["impl"] })).toEqual({});
  });
});
