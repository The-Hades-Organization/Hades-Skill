// Registro de tipos de nó do canvas (reference/argos.md §Tipos de nó e comandos). Cada tipo declara de uma vez o desenho,
// o tamanho padrão, o ícone, os itens de menu, as ações e se é vivo (vem de /api/argos/graph) ou do usuário. Lógica pura e
// sem Node: roda no painel e no navegador. O ponto de extensão para plugins é só `register` + a validação daqui.
import { CANVAS_LIMITS, isLiveNodeType } from "./canvas-doc.ts";

/** Onde o nó é desenhado: direto no canvas (SVG) ou como HTML por cima dele. */
export const NODE_SURFACES = ["canvas", "html"] as const;
export type NodeSurface = (typeof NODE_SURFACES)[number];

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const REGISTRY_ERRORS = {
  invalidType: "registry_invalid_type",
  missingField: "registry_missing_field",
  invalidField: "registry_invalid_field",
  duplicate: "registry_duplicate",
  liveMismatch: "registry_live_mismatch",
  unknownType: "registry_unknown_type",
  invalidShortcut: "registry_invalid_shortcut",
  shortcutConflict: "registry_shortcut_conflict",
  unknownReference: "registry_unknown_reference",
} as const;
export type RegistryErrorCode = (typeof REGISTRY_ERRORS)[keyof typeof REGISTRY_ERRORS];

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  /** Campo ou id que causou o erro, quando há um. */
  readonly subject: string | undefined;
  constructor(code: RegistryErrorCode, message: string, subject?: string) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
    this.subject = subject;
  }
}

/** O que o motor entrega a quem desenha um nó. `data` é o do documento (vazio nos nós vivos: o conteúdo vem do grafo). */
export interface NodeRenderInput {
  id: string;
  type: string;
  w: number;
  h: number;
  selected: boolean;
  data: Readonly<Record<string, unknown>>;
  /** Registro vivo do grafo (agente, PR, unidade, gate); `undefined` nos nós do usuário. */
  live: Readonly<Record<string, unknown>> | undefined;
}
/** O retorno é opaco: elemento SVG ou HTML conforme `surface`; o registro só garante que existe e é função. */
export type NodeRender = (input: NodeRenderInput) => unknown;

export interface NodeTypeDef {
  /** Mesmo padrão do `type` do documento: `[a-z][a-z0-9_-]{0,39}`. */
  type: string;
  label: string;
  /** Nome do ícone no conjunto do painel (`HadesCore.I`). */
  icon: string;
  defaultSize: { w: number; h: number };
  draw: { surface: NodeSurface; render: NodeRender };
  /** Ids de comando (registro de comandos) do menu de botão direito deste tipo, em ordem. */
  menu: readonly string[];
  /** Ids das ações do servidor (`POST /api/argos/action`) que o tipo oferece. */
  actions: readonly string[];
  /** Vivo: vem de `/api/argos/graph` e só existe para `agent`, `unit`, `pr` e `gate` (a regra do documento). */
  live: boolean;
}

const TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const COMMAND_ID_PATTERN = /^[\w.:-]{1,200}$/;
const LABEL_MAX = 80;
const ICON_PATTERN = /^[A-Z][A-Za-z0-9]{0,39}$/;

const fail = (code: RegistryErrorCode, message: string, subject?: string): never => {
  throw new RegistryError(code, message, subject);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (raw: Record<string, unknown>, field: string, max: number): string => {
  const value = raw[field];
  if (value === undefined) return fail(REGISTRY_ERRORS.missingField, `tipo de nó sem o campo "${field}"`, field);
  if (typeof value !== "string" || value.trim() === "" || value.length > max) return fail(REGISTRY_ERRORS.invalidField, `"${field}" deve ser um texto de 1 a ${max} caracteres`, field);
  return value;
};

const requireDimension = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > CANVAS_LIMITS.size) {
    return fail(REGISTRY_ERRORS.invalidField, `"${field}" deve ser inteiro de 1 a ${CANVAS_LIMITS.size}`, field);
  }
  return value;
};

const requireIdList = (raw: Record<string, unknown>, field: string): readonly string[] => {
  const value = raw[field];
  if (value === undefined) return fail(REGISTRY_ERRORS.missingField, `tipo de nó sem o campo "${field}"`, field);
  if (!Array.isArray(value)) return fail(REGISTRY_ERRORS.invalidField, `"${field}" deve ser uma lista`, field);
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !COMMAND_ID_PATTERN.test(item)) return fail(REGISTRY_ERRORS.invalidField, `"${field}" tem um id inválido`, field);
    if (seen.has(item)) return fail(REGISTRY_ERRORS.invalidField, `"${field}" repete o id "${item}"`, field);
    seen.add(item);
  }
  return [...value] as string[];
};

/** Confere uma declaração vinda de fora (plugin) e devolve uma cópia congelada. Lança `RegistryError`. */
export function validateNodeType(raw: unknown): NodeTypeDef {
  if (!isRecord(raw)) return fail(REGISTRY_ERRORS.invalidField, "a declaração do tipo deve ser um objeto");
  const type = raw.type;
  if (type === undefined) return fail(REGISTRY_ERRORS.missingField, 'tipo de nó sem o campo "type"', "type");
  if (typeof type !== "string" || !TYPE_PATTERN.test(type)) return fail(REGISTRY_ERRORS.invalidType, `"type" deve seguir ${TYPE_PATTERN.source}`, "type");
  const label = requireString(raw, "label", LABEL_MAX);
  const icon = requireString(raw, "icon", 40);
  if (!ICON_PATTERN.test(icon)) return fail(REGISTRY_ERRORS.invalidField, `"icon" deve ser o nome de um ícone (${ICON_PATTERN.source})`, "icon");

  const size = raw.defaultSize;
  if (size === undefined) return fail(REGISTRY_ERRORS.missingField, 'tipo de nó sem o campo "defaultSize"', "defaultSize");
  if (!isRecord(size)) return fail(REGISTRY_ERRORS.invalidField, '"defaultSize" deve ser {w, h}', "defaultSize");
  const defaultSize = { w: requireDimension(size.w, "defaultSize.w"), h: requireDimension(size.h, "defaultSize.h") };

  const draw = raw.draw;
  if (draw === undefined) return fail(REGISTRY_ERRORS.missingField, 'tipo de nó sem o campo "draw"', "draw");
  if (!isRecord(draw)) return fail(REGISTRY_ERRORS.invalidField, '"draw" deve ser {surface, render}', "draw");
  const surface = draw.surface;
  if (typeof surface !== "string" || !(NODE_SURFACES as readonly string[]).includes(surface)) {
    return fail(REGISTRY_ERRORS.invalidField, `"draw.surface" deve ser um de: ${NODE_SURFACES.join(", ")}`, "draw.surface");
  }
  if (typeof draw.render !== "function") return fail(REGISTRY_ERRORS.invalidField, '"draw.render" deve ser uma função', "draw.render");

  const menu = requireIdList(raw, "menu");
  const actions = requireIdList(raw, "actions");

  const live = raw.live;
  if (live === undefined) return fail(REGISTRY_ERRORS.missingField, 'tipo de nó sem o campo "live"', "live");
  if (typeof live !== "boolean") return fail(REGISTRY_ERRORS.invalidField, '"live" deve ser verdadeiro ou falso', "live");
  if (live !== isLiveNodeType(type)) {
    return fail(REGISTRY_ERRORS.liveMismatch, `"${type}" ${live ? "não é um tipo vivo do grafo" : "é um tipo vivo do grafo e precisa de live: true"}`, "live");
  }

  return Object.freeze({
    type,
    label,
    icon,
    defaultSize: Object.freeze(defaultSize),
    draw: Object.freeze({ surface: surface as NodeSurface, render: draw.render as NodeRender }),
    menu: Object.freeze(menu),
    actions: Object.freeze(actions),
    live,
  });
}

export interface NodeTypeRegistry {
  /** Valida e guarda (a validação vale também para plugin em JS puro). Lança `RegistryError`; nada é guardado se falhar. */
  register(def: NodeTypeDef): NodeTypeDef;
  get(type: string): NodeTypeDef | undefined;
  has(type: string): boolean;
  /** Na ordem do registro. */
  list(): readonly NodeTypeDef[];
  /** Tamanho padrão do tipo; tipo desconhecido lança `registry_unknown_type`. */
  sizeOf(type: string): { w: number; h: number };
}

export function createNodeTypeRegistry(): NodeTypeRegistry {
  const byType = new Map<string, NodeTypeDef>();
  return {
    register(def) {
      const valid = validateNodeType(def);
      if (byType.has(valid.type)) return fail(REGISTRY_ERRORS.duplicate, `o tipo "${valid.type}" já está registrado`, valid.type);
      byType.set(valid.type, valid);
      return valid;
    },
    get: (type) => byType.get(type),
    has: (type) => byType.has(type),
    list: () => [...byType.values()],
    sizeOf(type) {
      const def = byType.get(type);
      if (!def) return fail(REGISTRY_ERRORS.unknownType, `tipo "${type}" não registrado`, type);
      return { ...def.defaultSize };
    },
  };
}
