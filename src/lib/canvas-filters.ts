// Barra de filtros do canvas do Argos (reference/argos.md §Filtros): chips com contagem por dimensão e o conjunto
// visível. Dentro de uma dimensão os valores marcados valem como "ou"; entre dimensões, "e". A contagem de cada chip é
// facetada: considera os filtros das outras dimensões, nunca o da própria. Lógica pura e sem Node; um passo linear.

export const FILTER_DIMS = ["state", "type", "edgeKind", "role", "registry", "age", "cost", "archived", "activity"] as const;
export type FilterDim = (typeof FILTER_DIMS)[number];

/**
 * Dimensões do agente (reference/argos.md §Ocultar e podar o canvas): "Mostrar arquivados" e "Última atividade". Vão na
 * seleção como as outras (endereço, filtros salvos), mas quem as aplica é o preset de estado, sobre o agente (PR e gate
 * seguem o agente ligado); a barra de chips e `applyFilters` não as leem.
 */
export const AGENT_DIMS = ["archived", "activity"] as const satisfies readonly FilterDim[];
type AgentDim = (typeof AGENT_DIMS)[number];
/** Dimensões dos chips, na ordem da barra. */
type ChipDim = Exclude<FilterDim, AgentDim>;
export const CHIP_DIMS = FILTER_DIMS.filter((dim): dim is ChipDim => !(AGENT_DIMS as readonly string[]).includes(dim));

/** Dimensão → valores marcados; ausente ou lista vazia = sem filtro nela. */
export type FilterSelection = Partial<Record<FilterDim, readonly string[]>>;

/** Valor de quem não tem nada na dimensão (sem papel, sem raiz, sem ligação). */
export const UNSET = "-";

export const FILTER_DIM_LABELS: Readonly<Record<FilterDim, string>> = {
  state: "Estado",
  type: "Tipo de nó",
  edgeKind: "Tipo de ligação",
  role: "Papel",
  registry: "Raiz",
  age: "Idade",
  cost: "Custo",
  archived: "Arquivados",
  activity: "Última atividade",
};

interface Band {
  id: string;
  label: string;
}

/** Idade do último evento (`lastEventTs`) até o relógio recebido. A ordem é a do chip; cada faixa vai até o limite dado. */
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const AGE_BANDS: readonly (Band & { upToMs: number })[] = [
  { id: "m15", label: "Até 15 min", upToMs: 15 * MINUTE_MS },
  { id: "d1", label: "Até 1 dia", upToMs: DAY_MS },
  { id: "d7", label: "Até 7 dias", upToMs: 7 * DAY_MS },
  { id: "older", label: "Mais de 7 dias", upToMs: Infinity },
];
export const AGE_NONE: Band = { id: "none", label: "Sem evento" };

/**
 * Janelas do seletor "Última atividade": o agente passa se o último evento cabe na janela (pela mesma leitura de
 * `ageBand`). Sem evento conhecido, só passa em "qualquer data", que é a ausência da dimensão na seleção.
 */
export const ACTIVITY_WINDOWS: readonly (Band & { upToMs: number })[] = [
  { id: "d1", label: "24 h", upToMs: DAY_MS },
  { id: "d7", label: "7 dias", upToMs: 7 * DAY_MS },
  { id: "d30", label: "30 dias", upToMs: 30 * DAY_MS },
];
export const ACTIVITY_ANY: Band = { id: "any", label: "Qualquer data" };
/** Único valor de `archived`: presente mostra os arquivados; ausente (o padrão) os tira de qualquer preset. */
export const SHOW_ARCHIVED = "show";
export const ARCHIVED_STATE = "archived";

/** Custo acumulado do nó em dólares (`costUsd`). Faixa vai até o limite (exclusivo). */
export const COST_BANDS: readonly (Band & { belowUsd: number })[] = [
  { id: "low", label: "Até US$ 1", belowUsd: 1 },
  { id: "mid", label: "Até US$ 10", belowUsd: 10 },
  { id: "high", label: "Acima de US$ 10", belowUsd: Infinity },
];
export const COST_NONE: Band = { id: "none", label: "Sem custo medido" };

const TYPE_LABELS: Readonly<Record<string, string>> = { agent: "Agente", unit: "Unidade", pr: "PR", gate: "Gate" };
const EDGE_KIND_LABELS: Readonly<Record<string, string>> = {
  stack: "Empilhado",
  consolidation: "Consolidação",
  depends_on: "Depende de",
  agent_pr: "Agente → PR",
  agent_gate: "Agente → gate",
  orchestrates: "Orquestrador → agente",
};
const UNSET_LABELS: Readonly<Partial<Record<FilterDim, string>>> = { role: "Sem papel", registry: "Sem raiz", edgeKind: "Sem ligação" };

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const FILTER_ERRORS = { invalidClock: "filters_invalid_clock" } as const;
export type FilterErrorCode = (typeof FILTER_ERRORS)[keyof typeof FILTER_ERRORS];

export class FilterError extends Error {
  readonly code: FilterErrorCode;
  constructor(code: FilterErrorCode, message: string) {
    super(message);
    this.name = "FilterError";
    this.code = code;
  }
}

/** O que o filtro lê de um nó do grafo (campo a mais é ignorado; `registry` é a raiz do nó, `costUsd` vem de fora do grafo). */
export interface FilterNode {
  id: string;
  type: string;
  state: string;
  role?: string | null;
  registry?: string | null;
  lastEventTs?: string | null;
  costUsd?: number | null;
}

export interface FilterEdge {
  from: string;
  to: string;
  kind: string;
}

export interface FilterChip {
  value: string;
  label: string;
  /** Nós que passam pelos filtros das outras dimensões e têm este valor. */
  count: number;
  active: boolean;
}

export interface FilterDimension {
  dim: FilterDim;
  label: string;
  chips: FilterChip[];
}

export interface FilterResult {
  visible: Set<string>;
  /** Arestas com as duas pontas visíveis. */
  edges: FilterEdge[];
}

// Instante sem fuso explícito não é lido como hora local (ficaria ambíguo): vira "sem evento".
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

/** Idade do último evento em ms (evento no futuro conta 0); `null` sem instante legível com fuso. */
function eventAgeMs(lastEventTs: string | null | undefined, nowMs: number): number | null {
  if (typeof lastEventTs !== "string" || !HAS_OFFSET.test(lastEventTs)) return null;
  const at = Date.parse(lastEventTs);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, nowMs - at);
}

export function ageBand(lastEventTs: string | null | undefined, nowMs: number): string {
  const age = eventAgeMs(lastEventTs, nowMs);
  if (age === null) return AGE_NONE.id;
  for (const band of AGE_BANDS) if (age <= band.upToMs) return band.id;
  return AGE_NONE.id;
}

/** As janelas de "Última atividade" em que o evento cabe (a de 24 h cabe também nas maiores). */
export function activityWindows(lastEventTs: string | null | undefined, nowMs: number): string[] {
  const age = eventAgeMs(lastEventTs, nowMs);
  return age === null ? [] : ACTIVITY_WINDOWS.filter((window) => age <= window.upToMs).map((window) => window.id);
}

export function costBand(costUsd: number | null | undefined): string {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) return COST_NONE.id;
  for (const band of COST_BANDS) if (costUsd < band.belowUsd) return band.id;
  return COST_NONE.id;
}

const orUnset = (value: string | null | undefined): string => (typeof value === "string" && value !== "" ? value : UNSET);

function selectedSet(selection: FilterSelection, dim: FilterDim): ReadonlySet<string> | undefined {
  const values = selection[dim];
  return values && values.length > 0 ? new Set(values) : undefined;
}

function assertClock(nowMs: number): void {
  if (!Number.isFinite(nowMs)) throw new FilterError(FILTER_ERRORS.invalidClock, "relógio do filtro precisa ser um número finito (ms)");
}

/** Tipos de ligação de cada nó (de qualquer sentido), sem repetir. */
function edgeKindsByNode(edges: readonly FilterEdge[]): Map<string, Set<string>> {
  const byNode = new Map<string, Set<string>>();
  const add = (id: string, kind: string): void => {
    const kinds = byNode.get(id);
    if (kinds) kinds.add(kind);
    else byNode.set(id, new Set([kind]));
  };
  for (const edge of edges) {
    add(edge.from, edge.kind);
    add(edge.to, edge.kind);
  }
  return byNode;
}

type DimValues = Record<ChipDim, readonly string[]>;

function valuesOf(node: FilterNode, kinds: ReadonlySet<string> | undefined, nowMs: number): DimValues {
  return {
    state: [orUnset(node.state)],
    type: [orUnset(node.type)],
    edgeKind: kinds && kinds.size > 0 ? [...kinds] : [UNSET],
    role: [orUnset(node.role)],
    registry: [orUnset(node.registry)],
    age: [ageBand(node.lastEventTs, nowMs)],
    cost: [costBand(node.costUsd)],
  };
}

interface Evaluated {
  node: FilterNode;
  values: DimValues;
  /** Dimensões em que o nó não passa. Vazio = visível. */
  failing: ChipDim[];
}

function evaluate(nodes: readonly FilterNode[], edges: readonly FilterEdge[], selection: FilterSelection, nowMs: number): Evaluated[] {
  assertClock(nowMs);
  const kindsByNode = edgeKindsByNode(edges);
  const wanted = CHIP_DIMS.map((dim) => [dim, selectedSet(selection, dim)] as const);
  return nodes.map((node) => {
    const values = valuesOf(node, kindsByNode.get(node.id), nowMs);
    const failing: ChipDim[] = [];
    for (const [dim, set] of wanted) {
      if (set && !values[dim].some((value) => set.has(value))) failing.push(dim);
    }
    return { node, values, failing };
  });
}

/** Conjunto visível e arestas entre visíveis. Seleção vazia mostra tudo. */
export function applyFilters(nodes: readonly FilterNode[], edges: readonly FilterEdge[], selection: FilterSelection, nowMs: number): FilterResult {
  const visible = new Set<string>();
  for (const row of evaluate(nodes, edges, selection, nowMs)) if (row.failing.length === 0) visible.add(row.node.id);
  return { visible, edges: edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)) };
}

/** Domínios fechados: aparecem sempre, mesmo com contagem 0, para a barra não pular. */
const FIXED_DOMAINS: Readonly<Partial<Record<FilterDim, readonly Band[]>>> = {
  type: Object.entries(TYPE_LABELS).map(([id, label]) => ({ id, label })),
  edgeKind: Object.entries(EDGE_KIND_LABELS).map(([id, label]) => ({ id, label })),
  age: [...AGE_BANDS, AGE_NONE],
  cost: [...COST_BANDS, COST_NONE],
};

function labelOf(dim: FilterDim, value: string): string {
  if (value === UNSET) return UNSET_LABELS[dim] ?? value;
  switch (dim) {
    case "type": return TYPE_LABELS[value] ?? value;
    case "edgeKind": return EDGE_KIND_LABELS[value] ?? value;
    case "age": return [...AGE_BANDS, AGE_NONE].find((band) => band.id === value)?.label ?? value;
    case "cost": return [...COST_BANDS, COST_NONE].find((band) => band.id === value)?.label ?? value;
    case "activity": return [...ACTIVITY_WINDOWS, ACTIVITY_ANY].find((band) => band.id === value)?.label ?? value;
    case "archived": return value === SHOW_ARCHIVED ? "Mostrar arquivados" : value;
    case "state":
    case "role":
    case "registry":
      return value;
    default: {
      const unreachable: never = dim;
      return unreachable;
    }
  }
}

/**
 * Chips de cada dimensão com a contagem facetada. Valor marcado que nenhum nó tem agora segue na barra com contagem 0
 * (para o dono poder desmarcá-lo). Dimensões abertas (estado, papel, raiz) ordenam por contagem e depois pelo valor.
 */
export function buildFilterBar(nodes: readonly FilterNode[], edges: readonly FilterEdge[], selection: FilterSelection, nowMs: number): FilterDimension[] {
  const rows = evaluate(nodes, edges, selection, nowMs);
  return CHIP_DIMS.map((dim) => {
    const counts = new Map<string, number>();
    for (const { values, failing } of rows) {
      if (failing.some((other) => other !== dim)) continue;
      for (const value of values[dim]) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const active = new Set(selection[dim] ?? []);
    const order: string[] = (FIXED_DOMAINS[dim] ?? []).map((band) => band.id);
    const extras = new Set([...counts.keys(), ...active].filter((value) => !order.includes(value)));
    const sortedExtras = [...extras].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
    const chips = [...order, ...sortedExtras].map((value) => ({ value, label: labelOf(dim, value), count: counts.get(value) ?? 0, active: active.has(value) }));
    return { dim, label: FILTER_DIM_LABELS[dim], chips };
  });
}

/** Liga ou desliga um valor sem mudar a seleção recebida; dimensão que fica vazia sai da seleção. */
export function toggleFilter(selection: FilterSelection, dim: FilterDim, value: string): FilterSelection {
  const current = selection[dim] ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  const { [dim]: _dropped, ...rest } = selection;
  return next.length > 0 ? { ...rest, [dim]: next } : rest;
}

/** Chips marcados (as dimensões do agente têm controle próprio na barra e não contam aqui). */
export const activeFilterCount = (selection: FilterSelection): number => CHIP_DIMS.reduce((sum, dim) => sum + (selection[dim]?.length ?? 0), 0);

/** Limpa os chips e mantém as dimensões do agente ("Limpar" da barra de chips não liga os arquivados nem tira a janela). */
export function clearChips(selection: FilterSelection): FilterSelection {
  const kept: FilterSelection = {};
  for (const dim of AGENT_DIMS) if (selection[dim]?.length) kept[dim] = selection[dim];
  return kept;
}

// ---- dimensões do agente ----

export const showsArchived = (selection: FilterSelection): boolean => selection.archived?.includes(SHOW_ARCHIVED) === true;

export function setShowArchived(selection: FilterSelection, on: boolean): FilterSelection {
  const { archived: _dropped, ...rest } = selection;
  return on ? { ...rest, archived: [SHOW_ARCHIVED] } : rest;
}

/** A janela escolhida, ou `any`. Valor desconhecido vindo do endereço segue como está (o seletor mostra e ninguém passa). */
export const activityOf = (selection: FilterSelection): string => selection.activity?.[0] ?? ACTIVITY_ANY.id;

export function setActivity(selection: FilterSelection, windowId: string): FilterSelection {
  const { activity: _dropped, ...rest } = selection;
  return windowId === ACTIVITY_ANY.id ? rest : { ...rest, activity: [windowId] };
}

/**
 * O agente passa pelas dimensões do agente: arquivado só com "Mostrar arquivados"; com janela de atividade, só se o último
 * evento cabe nela (sem evento não cabe). Mais de um valor em `activity` (endereço escrito à mão) vale como "ou".
 */
export function passesAgentDims(node: Pick<FilterNode, "state" | "lastEventTs">, selection: FilterSelection, nowMs: number): boolean {
  assertClock(nowMs);
  if (node.state === ARCHIVED_STATE && !showsArchived(selection)) return false;
  const windows = selection.activity;
  if (!windows || windows.length === 0) return true;
  const fits = activityWindows(node.lastEventTs, nowMs);
  return windows.some((id) => fits.includes(id));
}
