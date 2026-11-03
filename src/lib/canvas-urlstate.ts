// Estado do canvas do Argos na URL e vistas salvas (reference/argos.md §Estado na URL): câmera, filtros, busca e o nó
// aberto vão no hash e voltam exatos; hash inválido ou de versão desconhecida vira o estado padrão com um aviso de
// código estável, nunca exceção. As vistas de câmera salvas com nome são um modelo puro (adicionar, renomear, remover).
// Lógica pura e sem Node; quem lê e grava `location.hash` e o armazenamento das vistas é a página.
import { CAMERA_LIMITS, type Camera } from "./canvas-camera.ts";
import { CANVAS_LIMITS } from "./canvas-doc.ts";
import { FILTER_DIMS, type FilterDim, type FilterSelection } from "./canvas-filters.ts";
import { SEARCH_LIMITS } from "./canvas-search.ts";

export const URLSTATE_VERSION = 1;
export const URLSTATE_BASE = "#/argos";

export const URLSTATE_LIMITS = {
  /** Teto do hash inteiro, conferido antes de qualquer leitura. */
  hashChars: 4096,
  /** Teto de cada valor de filtro e do id do nó aberto. */
  valueChars: 200,
  /** Valores marcados por dimensão. */
  valuesPerDim: 50,
} as const;

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const URLSTATE_WARNINGS = {
  invalid: "urlstate_invalid",
  unsupportedVersion: "urlstate_unsupported_version",
  tooLong: "urlstate_too_long",
} as const;
export type UrlStateWarning = (typeof URLSTATE_WARNINGS)[keyof typeof URLSTATE_WARNINGS];

export class UrlStateError extends Error {
  readonly code: UrlStateWarning;
  constructor(code: UrlStateWarning, message: string) {
    super(message);
    this.name = "UrlStateError";
    this.code = code;
  }
}

/** Presets de estado da página (`#/argos?preset=<valor>`): lista fechada; só ganha valores. */
export const URLSTATE_PRESETS = ["active", "attention", "stalled", "done", "all", "working", "idle"] as const;
export type UrlStatePreset = (typeof URLSTATE_PRESETS)[number];

const isPreset = (value: string): value is UrlStatePreset => (URLSTATE_PRESETS as readonly string[]).includes(value);

export interface UrlState {
  /** `null` = a URL não fixa a câmera (a página enquadra). */
  camera: Camera | null;
  filters: FilterSelection;
  search: string;
  /** Nó aberto (`#/argos?node=<id>`, o link direto que já existe). */
  node: string | null;
  /** Ausente = a URL não fixa preset; só aparece quando o hash o traz. */
  preset?: UrlStatePreset;
  /** Esconder controles (`focus=1`): só o canvas, sem HUD, toolbar, lista nem gaveta. Ausente ou `false` = desligado; o hash só leva o ligado. */
  focus?: boolean;
}

export interface UrlStateRead {
  state: UrlState;
  /** Presente quando o hash foi recusado e `state` é o padrão. */
  warning?: UrlStateWarning;
}

export const defaultUrlState = (): UrlState => ({ camera: null, filters: {}, search: "", node: null });

const NODE_ID = /^[\w.:-]+$/;
const NUMBER_TEXT = /^-?\d+(\.\d+)?(e[+-]\d+)?$/;
const FILTER_KEY_PREFIX = "f.";
const SCALAR_KEYS = ["v", "node", "cx", "cy", "ck", "q", "preset", "focus"] as const;
// o foco só tem um valor no hash: desligado é a chave ausente
const FOCUS_ON = "1";

/** Câmera aceitável: números finitos, escala nos limites do motor e centro dentro do mundo do documento. */
export function isValidCamera(camera: Camera): boolean {
  const { x, y, k } = camera;
  const bound = CANVAS_LIMITS.coordinate;
  return (
    [x, y, k].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    Math.abs(x) <= bound && Math.abs(y) <= bound &&
    k >= CAMERA_LIMITS.zoomMin && k <= CAMERA_LIMITS.zoomMax
  );
}

const isFilterDim = (value: string): value is FilterDim => (FILTER_DIMS as readonly string[]).includes(value);

const validFilterValue = (value: unknown): value is string => typeof value === "string" && value !== "" && value.length <= URLSTATE_LIMITS.valueChars;

/** Confere um estado já montado (o que `serializeUrlState` aceita); devolve o motivo ou `undefined`. */
function stateProblem(state: UrlState): string | undefined {
  if (state.camera && !isValidCamera(state.camera)) return "câmera fora dos limites";
  if (state.search.length > SEARCH_LIMITS.termChars) return "busca acima do limite";
  if (state.node !== null && (state.node.length > URLSTATE_LIMITS.valueChars || !NODE_ID.test(state.node))) return "id do nó inválido";
  if (state.preset !== undefined && !isPreset(state.preset)) return "preset desconhecido";
  if (state.focus !== undefined && typeof state.focus !== "boolean") return "foco inválido";
  for (const [dim, values] of Object.entries(state.filters)) {
    if (!isFilterDim(dim)) return "dimensão de filtro desconhecida";
    if (!values || values.length > URLSTATE_LIMITS.valuesPerDim || !values.every(validFilterValue) || new Set(values).size !== values.length) return "valores de filtro inválidos";
  }
  return undefined;
}

// -0 vira 0: o texto não carrega o sinal, e a ida e volta tem de ser exata
const numberText = (n: number): string => String(n === 0 ? 0 : n);

/** Estado → hash. Estado padrão dá só a base. Lança `UrlStateError` para estado que não caberia numa URL válida. */
export function serializeUrlState(state: UrlState, base: string = URLSTATE_BASE): string {
  const problem = stateProblem(state);
  if (problem) throw new UrlStateError(URLSTATE_WARNINGS.invalid, `estado inválido: ${problem}`);
  const params = new URLSearchParams();
  if (state.node !== null) params.set("node", state.node);
  if (state.camera) {
    params.set("cx", numberText(state.camera.x));
    params.set("cy", numberText(state.camera.y));
    params.set("ck", numberText(state.camera.k));
  }
  for (const dim of FILTER_DIMS) for (const value of state.filters[dim] ?? []) params.append(`${FILTER_KEY_PREFIX}${dim}`, value);
  if (state.search !== "") params.set("q", state.search);
  if (state.preset !== undefined) params.set("preset", state.preset);
  if (state.focus === true) params.set("focus", FOCUS_ON);
  if (params.keys().next().done) return base;
  params.set("v", String(URLSTATE_VERSION));
  const hash = `${base}?${params.toString()}`;
  if (hash.length > URLSTATE_LIMITS.hashChars) throw new UrlStateError(URLSTATE_WARNINGS.tooLong, "estado grande demais para o hash");
  return hash;
}

const refuse = (warning: UrlStateWarning): UrlStateRead => ({ state: defaultUrlState(), warning });

function readNumber(text: string | undefined): number | undefined {
  if (text === undefined || !NUMBER_TEXT.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function legacyNodeLink(entries: readonly (readonly [string, string])[]): UrlStateRead {
  const [only] = entries;
  if (entries.length !== 1 || !only || only[0] !== "node") return refuse(URLSTATE_WARNINGS.invalid);
  const state: UrlState = { ...defaultUrlState(), node: only[1] };
  return stateProblem(state) ? refuse(URLSTATE_WARNINGS.invalid) : { state };
}

/** Hash → estado. Nunca lança: o que não se entende é o estado padrão mais um aviso. */
export function parseUrlState(hash: string, base: string = URLSTATE_BASE): UrlStateRead {
  if (typeof hash !== "string") return refuse(URLSTATE_WARNINGS.invalid);
  if (hash.length > URLSTATE_LIMITS.hashChars) return refuse(URLSTATE_WARNINGS.tooLong);
  const question = hash.indexOf("?");
  const path = question === -1 ? hash : hash.slice(0, question);
  if (path !== base) return refuse(URLSTATE_WARNINGS.invalid);
  if (question === -1 || question === hash.length - 1) return { state: defaultUrlState() };

  const entries = [...new URLSearchParams(hash.slice(question + 1)).entries()];
  const version = entries.find(([key]) => key === "v")?.[1];
  // o link direto antigo (`?node=<id>`, sem versão) segue valendo: é o único formato sem `v` que a página já emitiu
  if (version === undefined) return legacyNodeLink(entries);
  if (version !== String(URLSTATE_VERSION)) return refuse(/^\d{1,9}$/.test(version) ? URLSTATE_WARNINGS.unsupportedVersion : URLSTATE_WARNINGS.invalid);

  const scalars = new Map<string, string>();
  const filters: Partial<Record<FilterDim, string[]>> = {};
  for (const [key, value] of entries) {
    if ((SCALAR_KEYS as readonly string[]).includes(key)) {
      if (scalars.has(key)) return refuse(URLSTATE_WARNINGS.invalid);
      scalars.set(key, value);
      continue;
    }
    const dim = key.startsWith(FILTER_KEY_PREFIX) ? key.slice(FILTER_KEY_PREFIX.length) : "";
    if (!isFilterDim(dim)) return refuse(URLSTATE_WARNINGS.invalid);
    (filters[dim] ??= []).push(value);
  }

  const [x, y, k] = [scalars.get("cx"), scalars.get("cy"), scalars.get("ck")].map(readNumber);
  const given = [x, y, k].filter((n) => n !== undefined).length;
  const wanted = ["cx", "cy", "ck"].filter((key) => scalars.has(key)).length;
  if (wanted !== 0 && (wanted !== 3 || given !== 3)) return refuse(URLSTATE_WARNINGS.invalid);
  let camera: Camera | null = null;
  if (x !== undefined && y !== undefined && k !== undefined) camera = { x, y, k };

  const state: UrlState = { camera, filters, search: scalars.get("q") ?? "", node: scalars.get("node") ?? null };
  const preset = scalars.get("preset");
  if (preset !== undefined) {
    if (!isPreset(preset)) return refuse(URLSTATE_WARNINGS.invalid);
    state.preset = preset;
  }
  const focus = scalars.get("focus");
  if (focus !== undefined) {
    if (focus !== FOCUS_ON) return refuse(URLSTATE_WARNINGS.invalid);
    state.focus = true;
  }
  return stateProblem(state) ? refuse(URLSTATE_WARNINGS.invalid) : { state };
}

// ---- vistas salvas ----

export const VIEW_LIMITS = { nameChars: 60, count: 50 } as const;

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const VIEW_ERRORS = {
  nameEmpty: "view_name_empty",
  nameTooLong: "view_name_too_long",
  nameTaken: "view_name_taken",
  notFound: "view_not_found",
  limit: "view_limit",
  invalidCamera: "view_invalid_camera",
} as const;
export type ViewErrorCode = (typeof VIEW_ERRORS)[keyof typeof VIEW_ERRORS];

export interface SavedView {
  name: string;
  camera: Camera;
}

export type ViewChange = { ok: true; views: SavedView[] } | { ok: false; code: ViewErrorCode };

const cleanName = (name: string): string => name.replace(/\s+/g, " ").trim();
/** Chave de unicidade: a grafia da caixa não cria outra vista. */
const nameKey = (name: string): string => cleanName(name).toLowerCase();
const failed = (code: ViewErrorCode): ViewChange => ({ ok: false, code });

function nameProblem(name: string): ViewErrorCode | undefined {
  const clean = cleanName(name);
  if (clean === "") return VIEW_ERRORS.nameEmpty;
  return clean.length > VIEW_LIMITS.nameChars ? VIEW_ERRORS.nameTooLong : undefined;
}

/** Acrescenta ao fim; o nome sai aparado e com espaços juntados. Não muda a lista recebida. */
export function addView(views: readonly SavedView[], name: string, camera: Camera): ViewChange {
  const problem = nameProblem(name);
  if (problem) return failed(problem);
  if (!isValidCamera(camera)) return failed(VIEW_ERRORS.invalidCamera);
  if (views.length >= VIEW_LIMITS.count) return failed(VIEW_ERRORS.limit);
  const key = nameKey(name);
  if (views.some((view) => nameKey(view.name) === key)) return failed(VIEW_ERRORS.nameTaken);
  return { ok: true, views: [...views, { name: cleanName(name), camera: { ...camera } }] };
}

/** Troca o nome mantendo a posição na lista; mudar só a caixa do próprio nome é permitido. */
export function renameView(views: readonly SavedView[], from: string, to: string): ViewChange {
  const index = views.findIndex((view) => nameKey(view.name) === nameKey(from));
  if (index === -1) return failed(VIEW_ERRORS.notFound);
  const problem = nameProblem(to);
  if (problem) return failed(problem);
  const key = nameKey(to);
  if (views.some((view, i) => i !== index && nameKey(view.name) === key)) return failed(VIEW_ERRORS.nameTaken);
  return { ok: true, views: views.map((view, i) => (i === index ? { ...view, name: cleanName(to) } : view)) };
}

export function removeView(views: readonly SavedView[], name: string): ViewChange {
  const key = nameKey(name);
  if (!views.some((view) => nameKey(view.name) === key)) return failed(VIEW_ERRORS.notFound);
  return { ok: true, views: views.filter((view) => nameKey(view.name) !== key) };
}

export interface ViewsRead {
  views: SavedView[];
  /** Entradas recusadas (forma inválida, nome repetido, acima do teto de quantidade). */
  dropped: number;
  /** `true` quando o valor lido nem era uma lista: nada aproveitado. */
  notAList: boolean;
}

/** Lê o que veio de fora (armazenamento do navegador): fica só o que passa pelas mesmas regras de `addView`. */
export function readViews(raw: unknown): ViewsRead {
  if (!Array.isArray(raw)) return { views: [], dropped: 0, notAList: true };
  let views: SavedView[] = [];
  let dropped = 0;
  for (const [index, item] of raw.entries()) {
    if (views.length >= VIEW_LIMITS.count) {
      dropped += raw.length - index;
      break;
    }
    const view = viewShape(item);
    const added = view ? addView(views, view.name, view.camera) : undefined;
    if (added?.ok) views = added.views;
    else dropped++;
  }
  return { views, dropped, notAList: false };
}

function viewShape(item: unknown): SavedView | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const { name, camera } = item as Record<string, unknown>;
  if (typeof name !== "string" || typeof camera !== "object" || camera === null) return undefined;
  const { x, y, k } = camera as Record<string, unknown>;
  return typeof x === "number" && typeof y === "number" && typeof k === "number" ? { name, camera: { x, y, k } } : undefined;
}
