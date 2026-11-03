// Filtros salvos (src/lib/canvas-saved-filters.ts): validação estrita, operações puras sobre o conjunto, padrão da instância
// e limites. Sem disco nem relógio; a rota fica em canvas-route.test.ts.
import { describe, expect, test } from "bun:test";
import { applyFilters, type FilterNode, type FilterSelection } from "../../../src/lib/canvas-filters.ts";
import {
  addSavedFilter, defaultSelection, emptySavedFilters, readSavedFilters, readSelection, removeSavedFilter, requireFilterName, SAVED_FILTER_ERRORS,
  SAVED_FILTER_LIMITS, SAVED_FILTERS_VERSION, setDefaultSavedFilter, updateSavedFilter, type SavedFilterSet,
} from "../../../src/lib/canvas-saved-filters.ts";

const codeOf = (code: string) => expect.objectContaining({ code });
const working: FilterSelection = { state: ["working"] };
const agents: FilterSelection = { type: ["agent"], state: ["working", "idle"] };

function withFilters(...entries: [string, FilterSelection][]): SavedFilterSet {
  return entries.reduce((set, [name, selection]) => addSavedFilter(set, name, selection).set, emptySavedFilters());
}

describe("filtros salvos: nome e seleção", () => {
  test("dado nome com espaços nas pontas, então volta aparado", () => {
    expect(requireFilterName("  Só agentes ")).toBe("Só agentes");
  });

  test.each(["", "   ", "a\nb", "x".repeat(SAVED_FILTER_LIMITS.nameChars + 1), 3, undefined])("dado o nome %j, então saved_filters_invalid_name", (name) => {
    expect(() => requireFilterName(name)).toThrow(codeOf(SAVED_FILTER_ERRORS.invalidName));
  });

  test("dado seleção válida, então volta cópia na ordem das dimensões, sem repetidos e sem lista vazia", () => {
    const input = { cost: ["low"], state: ["idle", "idle", "working"], role: [] };
    const out = readSelection(input);
    expect(out).toEqual({ state: ["idle", "working"], cost: ["low"] });
    expect(Object.keys(out)).toEqual(["state", "cost"]);
    expect(out.state).not.toBe(input.state);
  });

  test("dado objeto vazio, então a seleção vazia é válida", () => {
    expect(readSelection({})).toEqual({});
  });

  test.each([
    ["não é objeto", "state"],
    ["lista", []],
    ["nulo", null],
    ["dimensão desconhecida", { colour: ["x"] }],
    ["valores que não são lista", { state: "working" }],
    ["valor que não é texto", { state: [1] }],
    ["valor vazio", { state: [""] }],
    ["valor com controle", { state: ["a\u0000b"] }],
    ["valor longo", { state: ["x".repeat(SAVED_FILTER_LIMITS.valueChars + 1)] }],
    ["valores acima do teto", { state: Array.from({ length: SAVED_FILTER_LIMITS.valuesPerDim + 1 }, (_, i) => `s${i}`) }],
  ])("dado seleção inválida (%s), então saved_filters_invalid_selection", (_, raw) => {
    expect(() => readSelection(raw)).toThrow(codeOf(SAVED_FILTER_ERRORS.invalidSelection));
  });

  test("dado valores no teto, então passam", () => {
    const values = Array.from({ length: SAVED_FILTER_LIMITS.valuesPerDim }, (_, i) => `s${i}`);
    expect(readSelection({ state: values }).state).toHaveLength(SAVED_FILTER_LIMITS.valuesPerDim);
    expect(readSelection({ state: ["x".repeat(SAVED_FILTER_LIMITS.valueChars)] }).state).toHaveLength(1);
  });
});

describe("filtros salvos: operações sobre o conjunto", () => {
  test("dado conjunto vazio, então salvar cria o filtro com id do nome e não muda o conjunto recebido", () => {
    const empty = emptySavedFilters();
    const { set, id } = addSavedFilter(empty, "Só agentes", agents);
    expect(id).toBe("so-agentes");
    expect(set.filters).toEqual([{ id: "so-agentes", name: "Só agentes", selection: agents }]);
    expect(set.defaultId).toBeNull();
    expect(empty.filters).toEqual([]);
  });

  test("dado nomes que dão o mesmo id, então o segundo ganha sufixo", () => {
    const set = withFilters(["Agentes!", working], ["Agentes?", agents]);
    expect(set.filters.map((f) => f.id)).toEqual(["agentes", "agentes-2"]);
  });

  test("dado nome repetido (qualquer caixa), então saved_filters_duplicate_name", () => {
    const set = withFilters(["Só agentes", agents]);
    expect(() => addSavedFilter(set, "SÓ AGENTES", working)).toThrow(codeOf(SAVED_FILTER_ERRORS.duplicateName));
  });

  test("dado seleção vazia, então não se salva", () => {
    expect(() => addSavedFilter(emptySavedFilters(), "Nada", {})).toThrow(codeOf(SAVED_FILTER_ERRORS.invalidSelection));
    expect(() => addSavedFilter(emptySavedFilters(), "Nada", { state: [] })).toThrow(codeOf(SAVED_FILTER_ERRORS.invalidSelection));
  });

  test("dado o teto de filtros, então o seguinte é saved_filters_limit_reached e o último que cabe entra", () => {
    let set = emptySavedFilters();
    for (let i = 0; i < SAVED_FILTER_LIMITS.filters; i += 1) set = addSavedFilter(set, `f${i}`, working).set;
    expect(set.filters).toHaveLength(SAVED_FILTER_LIMITS.filters);
    expect(() => addSavedFilter(set, "um a mais", working)).toThrow(codeOf(SAVED_FILTER_ERRORS.limitReached));
  });

  test("dado renomear, então o id e a posição ficam; renomear para o próprio nome em outra caixa vale", () => {
    const set = withFilters(["A", working], ["B", agents]);
    const renamed = updateSavedFilter(set, "a", { name: "Novo" });
    expect(renamed.filters.map((f) => [f.id, f.name])).toEqual([["a", "Novo"], ["b", "B"]]);
    expect(updateSavedFilter(set, "a", { name: "a" }).filters[0]?.name).toBe("a");
    expect(() => updateSavedFilter(set, "a", { name: "b" })).toThrow(codeOf(SAVED_FILTER_ERRORS.duplicateName));
  });

  test("dado trocar a seleção, então só ela muda; vazia é recusada; sem mudança devolve o mesmo conjunto", () => {
    const set = withFilters(["A", working]);
    expect(updateSavedFilter(set, "a", { selection: agents }).filters[0]).toEqual({ id: "a", name: "A", selection: agents });
    expect(() => updateSavedFilter(set, "a", { selection: {} })).toThrow(codeOf(SAVED_FILTER_ERRORS.invalidSelection));
    expect(updateSavedFilter(set, "a", {})).toBe(set);
  });

  test("dado id que não existe, então saved_filters_not_found em atualizar, remover e definir padrão", () => {
    const set = withFilters(["A", working]);
    expect(() => updateSavedFilter(set, "x", { name: "n" })).toThrow(codeOf(SAVED_FILTER_ERRORS.notFound));
    expect(() => removeSavedFilter(set, "x")).toThrow(codeOf(SAVED_FILTER_ERRORS.notFound));
    expect(() => setDefaultSavedFilter(set, "x")).toThrow(codeOf(SAVED_FILTER_ERRORS.notFound));
  });

  test("dado padrão definido, então é um por instância, troca ao definir outro e limpa com null", () => {
    const set = withFilters(["A", working], ["B", agents]);
    const a = setDefaultSavedFilter(set, "a");
    expect(a.defaultId).toBe("a");
    expect(setDefaultSavedFilter(a, "b").defaultId).toBe("b");
    expect(setDefaultSavedFilter(a, "a")).toBe(a);
    expect(setDefaultSavedFilter(a, null).defaultId).toBeNull();
  });

  test("dado remover o filtro padrão, então a instância fica sem padrão; remover outro mantém o padrão", () => {
    const set = setDefaultSavedFilter(withFilters(["A", working], ["B", agents]), "a");
    expect(removeSavedFilter(set, "a")).toMatchObject({ defaultId: null, filters: [{ id: "b" }] });
    expect(removeSavedFilter(set, "b")).toMatchObject({ defaultId: "a", filters: [{ id: "a" }] });
  });

  test("dado o padrão, então defaultSelection devolve cópia; sem padrão, undefined", () => {
    const set = withFilters(["A", agents]);
    expect(defaultSelection(set)).toBeUndefined();
    const withDefault = setDefaultSavedFilter(set, "a");
    const picked = defaultSelection(withDefault);
    expect(picked).toEqual(agents);
    expect(picked?.state).not.toBe(withDefault.filters[0]?.selection.state);
  });

  test("dado filtro salvo, então a seleção aplicada ao grafo mostra o mesmo que a seleção original (ida e volta pelo conjunto)", () => {
    const nodes: FilterNode[] = [
      { id: "agent:1", type: "agent", state: "working" },
      { id: "agent:2", type: "agent", state: "done" },
      { id: "pr:1", type: "pr", state: "working" },
    ];
    const now = Date.parse("2026-11-02T12:00:00Z");
    const set = readSavedFilters(JSON.parse(JSON.stringify(withFilters(["Agentes ativos", agents]))));
    const stored = set.filters[0]?.selection ?? {};
    expect([...applyFilters(nodes, [], stored, now).visible]).toEqual([...applyFilters(nodes, [], agents, now).visible]);
    expect([...applyFilters(nodes, [], stored, now).visible]).toEqual(["agent:1"]);
  });
});

describe("filtros salvos: leitura de conjunto externo", () => {
  const valid = (): Record<string, unknown> => ({ v: SAVED_FILTERS_VERSION, rev: 2, defaultId: "a", filters: [{ id: "a", name: "A", selection: { state: ["working"] } }] });

  test("dado conjunto válido, então volta idêntico (ida e volta por JSON)", () => {
    const set = setDefaultSavedFilter(withFilters(["A", working], ["B", agents]), "b");
    expect(readSavedFilters(JSON.parse(JSON.stringify(set)))).toEqual(set);
    expect(readSavedFilters(JSON.parse(JSON.stringify(emptySavedFilters())))).toEqual(emptySavedFilters());
  });

  test.each([
    ["não é objeto", [], SAVED_FILTER_ERRORS.invalidShape],
    ["campo desconhecido", { ...valid(), extra: 1 }, SAVED_FILTER_ERRORS.invalidShape],
    ["sem versão", { ...valid(), v: undefined }, SAVED_FILTER_ERRORS.unsupportedVersion],
    ["versão nova", { ...valid(), v: 2 }, SAVED_FILTER_ERRORS.unsupportedVersion],
    ["rev negativa", { ...valid(), rev: -1 }, SAVED_FILTER_ERRORS.invalidShape],
    ["rev fracionária", { ...valid(), rev: 1.5 }, SAVED_FILTER_ERRORS.invalidShape],
    ["rev texto", { ...valid(), rev: "0" }, SAVED_FILTER_ERRORS.invalidShape],
    ["filtros que não é lista", { ...valid(), filters: {} }, SAVED_FILTER_ERRORS.invalidShape],
    ["filtro que não é objeto", { ...valid(), filters: [1] }, SAVED_FILTER_ERRORS.invalidShape],
    ["id inválido", { ...valid(), filters: [{ id: "../x", name: "A", selection: { state: ["w"] } }], defaultId: null }, SAVED_FILTER_ERRORS.invalidShape],
    ["nome inválido", { ...valid(), filters: [{ id: "a", name: "", selection: { state: ["w"] } }] }, SAVED_FILTER_ERRORS.invalidName],
    ["seleção com dimensão desconhecida", { ...valid(), filters: [{ id: "a", name: "A", selection: { x: ["w"] } }] }, SAVED_FILTER_ERRORS.invalidSelection],
    ["ids repetidos", { ...valid(), filters: [{ id: "a", name: "A", selection: {} }, { id: "a", name: "B", selection: {} }] }, SAVED_FILTER_ERRORS.duplicateId],
    ["nomes repetidos", { ...valid(), filters: [{ id: "a", name: "A", selection: {} }, { id: "b", name: "a", selection: {} }] }, SAVED_FILTER_ERRORS.duplicateName],
    ["padrão que não existe", { ...valid(), defaultId: "z" }, SAVED_FILTER_ERRORS.notFound],
    ["padrão que não é texto", { ...valid(), defaultId: 1 }, SAVED_FILTER_ERRORS.notFound],
    [
      "filtros acima do teto",
      { ...valid(), defaultId: null, filters: Array.from({ length: SAVED_FILTER_LIMITS.filters + 1 }, (_, i) => ({ id: `f${i}`, name: `f${i}`, selection: {} })) },
      SAVED_FILTER_ERRORS.limitReached,
    ],
  ])("dado conjunto inválido (%s), então o código estável", (_, raw, code) => {
    expect(() => readSavedFilters(raw)).toThrow(codeOf(code));
  });
});
