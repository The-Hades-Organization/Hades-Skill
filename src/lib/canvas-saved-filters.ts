// Filtros salvos do canvas do Argos (reference/argos.md §Filtros salvos): uma lista de seleções da barra de filtros
// (`FilterSelection` de canvas-filters.ts) com nome, e no máximo uma delas como padrão da instância. É estado da instância
// (vale para todos os canvases), não do documento do canvas: por isso não passa pela pilha de desfazer. Tudo puro e sem Node:
// cada operação devolve o conjunto novo e deixa o recebido intacto; quem grava (src/panel/canvas.ts) confere a revisão.
import { FILTER_DIMS, type FilterDim, type FilterSelection } from "./canvas-filters.ts";
import { slugify } from "./canvas-store.ts";

export const SAVED_FILTERS_VERSION = 1;

export const SAVED_FILTER_LIMITS = { filters: 50, idChars: 64, nameChars: 80, valuesPerDim: 50, valueChars: 100 } as const;

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const SAVED_FILTER_ERRORS = {
  invalidShape: "saved_filters_invalid_shape",
  unsupportedVersion: "saved_filters_unsupported_version",
  invalidName: "saved_filters_invalid_name",
  invalidSelection: "saved_filters_invalid_selection",
  duplicateName: "saved_filters_duplicate_name",
  duplicateId: "saved_filters_duplicate_id",
  notFound: "saved_filters_not_found",
  limitReached: "saved_filters_limit_reached",
} as const;
export type SavedFilterErrorCode = (typeof SAVED_FILTER_ERRORS)[keyof typeof SAVED_FILTER_ERRORS];

export class SavedFilterError extends Error {
  readonly code: SavedFilterErrorCode;
  constructor(code: SavedFilterErrorCode, message: string) {
    super(message);
    this.name = "SavedFilterError";
    this.code = code;
  }
}

export interface SavedFilter {
  /** Gerado pelo nome na criação e nunca muda (renomear não muda o id). */
  id: string;
  name: string;
  selection: FilterSelection;
}

export interface SavedFilterSet {
  v: typeof SAVED_FILTERS_VERSION;
  /** Revisão do arquivo: a rota só grava se a recebida for igual à gravada, e grava com +1. */
  rev: number;
  /** Filtro aplicado ao abrir a página (um por instância); `null` = nenhum. */
  defaultId: string | null;
  filters: SavedFilter[];
}

export const emptySavedFilters = (): SavedFilterSet => ({ v: SAVED_FILTERS_VERSION, rev: 0, defaultId: null, filters: [] });

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (code: SavedFilterErrorCode, message: string): SavedFilterError => new SavedFilterError(code, message);

// eslint-disable-next-line no-control-regex -- recusa caractere de controle em texto que vai para tela e arquivo
const CONTROL = /[\u0000-\u001f\u007f]/;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Nome de exibição: 1 a 80 caracteres, sem controle, aparado. Lança `saved_filters_invalid_name`. */
export function requireFilterName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length === 0 || trimmed.length > SAVED_FILTER_LIMITS.nameChars || CONTROL.test(trimmed)) throw fail(SAVED_FILTER_ERRORS.invalidName, "nome de filtro inválido");
  return trimmed;
}

const sameName = (a: string, b: string): boolean => a.toLocaleLowerCase("pt-BR") === b.toLocaleLowerCase("pt-BR");

/**
 * Seleção de entrada externa, estrita: dimensão fora de `FILTER_DIMS`, valor que não é texto (ou vazio, longo, com controle) e
 * lista acima do teto são recusados (`saved_filters_invalid_selection`), nunca descartados em silêncio. Valor repetido vale
 * uma vez; dimensão com lista vazia sai. A seleção devolvida é uma cópia nova, na ordem de `FILTER_DIMS`.
 */
export function readSelection(raw: unknown): FilterSelection {
  const invalid = (why: string): SavedFilterError => fail(SAVED_FILTER_ERRORS.invalidSelection, `seleção inválida: ${why}`);
  if (!isDict(raw)) throw invalid("não é um objeto");
  const known = new Set<string>(FILTER_DIMS);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw invalid("dimensão desconhecida");
  const out: Partial<Record<FilterDim, string[]>> = {};
  for (const dim of FILTER_DIMS) {
    const values = raw[dim];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > SAVED_FILTER_LIMITS.valuesPerDim) throw invalid("lista de valores inválida ou acima do teto");
    const unique: string[] = [];
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0 || value.length > SAVED_FILTER_LIMITS.valueChars || CONTROL.test(value)) throw invalid("valor inválido");
      if (!unique.includes(value)) unique.push(value);
    }
    if (unique.length > 0) out[dim] = unique;
  }
  return out;
}

const hasSelection = (selection: FilterSelection): boolean => FILTER_DIMS.some((dim) => (selection[dim]?.length ?? 0) > 0);

function readFilter(raw: unknown): SavedFilter {
  if (!isDict(raw)) throw fail(SAVED_FILTER_ERRORS.invalidShape, "filtro fora do formato");
  const { id, name, selection } = raw;
  if (typeof id !== "string" || id.length > SAVED_FILTER_LIMITS.idChars || !ID_PATTERN.test(id)) throw fail(SAVED_FILTER_ERRORS.invalidShape, "id de filtro inválido");
  return { id, name: requireFilterName(name), selection: readSelection(selection) };
}

/**
 * Conjunto de entrada externa (corpo da rota, arquivo gravado): confere forma, versão, limites, ids e nomes únicos e o padrão
 * apontando para um filtro que existe. Campo desconhecido é recusado. `rev` é número inteiro ≥ 0.
 */
export function readSavedFilters(raw: unknown): SavedFilterSet {
  if (!isDict(raw)) throw fail(SAVED_FILTER_ERRORS.invalidShape, "conjunto de filtros fora do formato");
  const extra = Object.keys(raw).filter((key) => !["v", "rev", "defaultId", "filters"].includes(key));
  if (extra.length > 0) throw fail(SAVED_FILTER_ERRORS.invalidShape, "campo desconhecido no conjunto de filtros");
  if (raw.v !== SAVED_FILTERS_VERSION) throw fail(SAVED_FILTER_ERRORS.unsupportedVersion, "versão dos filtros salvos não suportada");
  const { rev, defaultId, filters } = raw;
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) throw fail(SAVED_FILTER_ERRORS.invalidShape, "rev inválida");
  if (!Array.isArray(filters)) throw fail(SAVED_FILTER_ERRORS.invalidShape, "lista de filtros inválida");
  if (filters.length > SAVED_FILTER_LIMITS.filters) throw fail(SAVED_FILTER_ERRORS.limitReached, "filtros acima do teto");
  const read = filters.map(readFilter);
  const ids = new Set<string>();
  for (const filter of read) {
    if (ids.has(filter.id)) throw fail(SAVED_FILTER_ERRORS.duplicateId, "id de filtro repetido");
    ids.add(filter.id);
  }
  for (let i = 0; i < read.length; i += 1) {
    for (let j = i + 1; j < read.length; j += 1) {
      if (sameName((read[i] as SavedFilter).name, (read[j] as SavedFilter).name)) throw fail(SAVED_FILTER_ERRORS.duplicateName, "nome de filtro repetido");
    }
  }
  if (defaultId !== null && (typeof defaultId !== "string" || !ids.has(defaultId))) throw fail(SAVED_FILTER_ERRORS.notFound, "o filtro padrão não existe");
  return { v: SAVED_FILTERS_VERSION, rev, defaultId, filters: read };
}

const withFilters = (set: SavedFilterSet, filters: SavedFilter[], defaultId: string | null = set.defaultId): SavedFilterSet => ({ ...set, defaultId, filters });

function requireIndex(set: SavedFilterSet, id: string): number {
  const index = set.filters.findIndex((filter) => filter.id === id);
  if (index < 0) throw fail(SAVED_FILTER_ERRORS.notFound, "filtro não existe");
  return index;
}

function requireFreeName(set: SavedFilterSet, name: string, exceptId?: string): void {
  if (set.filters.some((filter) => filter.id !== exceptId && sameName(filter.name, name))) throw fail(SAVED_FILTER_ERRORS.duplicateName, "já existe filtro com esse nome");
}

/** Id livre derivado do nome (`Só agentes` → `so-agentes`, `so-agentes-2`…). */
function freshFilterId(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name, SAVED_FILTER_LIMITS.idChars - 5) || "filtro";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Salva a seleção atual com um nome (no fim da lista). Seleção vazia é recusada (um filtro que não filtra nada não se salva);
 * nome repetido (sem distinguir caixa) e lista cheia também. Devolve o conjunto novo e o id do filtro criado.
 */
export function addSavedFilter(set: SavedFilterSet, name: unknown, selection: unknown): { set: SavedFilterSet; id: string } {
  const cleanName = requireFilterName(name);
  const cleanSelection = readSelection(selection);
  if (!hasSelection(cleanSelection)) throw fail(SAVED_FILTER_ERRORS.invalidSelection, "seleção vazia não se salva");
  if (set.filters.length >= SAVED_FILTER_LIMITS.filters) throw fail(SAVED_FILTER_ERRORS.limitReached, "limite de filtros salvos atingido");
  requireFreeName(set, cleanName);
  const id = freshFilterId(cleanName, new Set(set.filters.map((filter) => filter.id)));
  return { set: withFilters(set, [...set.filters, { id, name: cleanName, selection: cleanSelection }]), id };
}

export interface SavedFilterChange {
  name?: unknown;
  selection?: unknown;
}

/** Renomeia e/ou troca a seleção de um filtro; o id e a posição ficam. Campo ausente não muda; mudança vazia devolve o mesmo conjunto. */
export function updateSavedFilter(set: SavedFilterSet, id: string, change: SavedFilterChange): SavedFilterSet {
  const index = requireIndex(set, id);
  const current = set.filters[index] as SavedFilter;
  const name = change.name === undefined ? current.name : requireFilterName(change.name);
  const selection = change.selection === undefined ? current.selection : readSelection(change.selection);
  if (!hasSelection(selection)) throw fail(SAVED_FILTER_ERRORS.invalidSelection, "seleção vazia não se salva");
  requireFreeName(set, name, id);
  if (name === current.name && selection === current.selection) return set;
  return withFilters(set, set.filters.map((filter, i) => (i === index ? { id, name, selection } : filter)));
}

/** Remove o filtro; se era o padrão, a instância fica sem padrão. */
export function removeSavedFilter(set: SavedFilterSet, id: string): SavedFilterSet {
  requireIndex(set, id);
  return withFilters(set, set.filters.filter((filter) => filter.id !== id), set.defaultId === id ? null : set.defaultId);
}

/** Define (ou, com `null`, limpa) o filtro padrão da instância. Só um filtro existente pode ser o padrão. */
export function setDefaultSavedFilter(set: SavedFilterSet, id: string | null): SavedFilterSet {
  if (id !== null) requireIndex(set, id);
  return set.defaultId === id ? set : withFilters(set, set.filters, id);
}

/** A seleção do filtro padrão (cópia), ou `undefined` sem padrão: a página a aplica ao abrir, quando a URL não traz filtro. */
export function defaultSelection(set: SavedFilterSet): FilterSelection | undefined {
  const found = set.filters.find((filter) => filter.id === set.defaultId);
  return found ? readSelection(found.selection) : undefined;
}
