// Criar unidade pelo canvas (reference/argos.md §Compor e criar): um esboço de unidade vira o texto dos comandos
// `hades agent skill-new`/`new` e do start, que o dono cola e roda (o start continua sendo passo dele). Nada é executado
// aqui: só validação e texto, com cada argumento entre aspas simples. Puro e sem Node.
import { type CanvasNode } from "./canvas-doc.ts";

export const CREATE_ERRORS = {
  invalidName: "create_invalid_name",
  invalidField: "create_invalid_field",
  missingField: "create_missing_field",
  invalidSketch: "create_invalid_sketch",
} as const;
export type CreateErrorCode = (typeof CREATE_ERRORS)[keyof typeof CREATE_ERRORS];

export class CreateError extends Error {
  readonly code: CreateErrorCode;
  readonly field: string | undefined;
  constructor(code: CreateErrorCode, message: string, field?: string) {
    super(message);
    this.name = "CreateError";
    this.code = code;
    this.field = field;
  }
}

const fail = (code: CreateErrorCode, message: string, field?: string): never => {
  throw new CreateError(code, message, field);
};

/** Tipo do nó do usuário que guarda o esboço; o motor de tipos o registra, aqui só se lê o `data`. */
export const UNIT_SKETCH_TYPE = "unit-sketch";

/** Mesma regra de nome do `hades agent new` e do `skill-new` (`agent-new.ts`, `agent-skill.ts`). */
export const UNIT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

export const UNIT_KINDS = ["project", "skill"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** Papéis do `agent new` (`spec|impl|consolidate`); o `skill-new` aceita só `impl|consolidate`. */
export const PROJECT_ROLES = ["spec", "impl", "consolidate"] as const;
export const SKILL_ROLES = ["impl", "consolidate"] as const;
export type UnitRole = (typeof PROJECT_ROLES)[number];

export const CREATE_LIMITS = { refChars: 200, titleChars: 200, descChars: 2000, tags: 10, tagChars: 40, specs: 20 } as const;

const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const CARD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
const CONTROL_SINGLE_LINE = /[\u0000-\u001f\u007f]/;
const CONTROL_MULTI_LINE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export interface UnitSketch {
  kind: UnitKind;
  name: string;
  role?: UnitRole;
  /** Só `project`: obrigatório. */
  branch?: string;
  base?: string;
  /** Só `skill`: porta de teste. */
  port?: number;
  /** Só `project`: card existente ou um novo (título, etiquetas e descrição). */
  card?: string;
  newCard?: { title: string; tags: readonly string[]; desc?: string };
  /** Só `project`: specs que o brief cita. */
  specs?: readonly string[];
}

export interface UnitCommands {
  /** Os comandos na ordem em que o dono os roda: criar e depois start. */
  commands: string[];
  /** O mesmo, um por linha, para colar no terminal. */
  text: string;
}

/** Aspas simples, que não expandem nada; aspa simples dentro vira `'\''`. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, field: string, max: number, multiline = false): string => {
  if (typeof value !== "string" || value.trim() === "") return fail(CREATE_ERRORS.invalidField, `"${field}" deve ser um texto não vazio`, field);
  if (value.length > max) return fail(CREATE_ERRORS.invalidField, `"${field}" passa de ${max} caracteres`, field);
  if ((multiline ? CONTROL_MULTI_LINE : CONTROL_SINGLE_LINE).test(value)) return fail(CREATE_ERRORS.invalidField, `"${field}" tem caractere de controle`, field);
  return value;
};

const gitRef = (value: unknown, field: string): string => {
  const ref = text(value, field, CREATE_LIMITS.refChars);
  if (!REF_PATTERN.test(ref) || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock")) {
    return fail(CREATE_ERRORS.invalidField, `"${field}" não é um nome de ref válido`, field);
  }
  return ref;
};

const requireString = (value: unknown, field: string): string => (value === undefined ? fail(CREATE_ERRORS.missingField, `falta "${field}"`, field) : text(value, field, CREATE_LIMITS.titleChars));

const flag = (name: string, value: string): string => `${name} ${shellQuote(value)}`;

function projectCommand(sketch: UnitSketch, role: UnitRole): string {
  if (sketch.port !== undefined) fail(CREATE_ERRORS.invalidField, '"port" só vale para unidade de skill', "port");
  const branch = sketch.branch === undefined ? fail(CREATE_ERRORS.missingField, 'falta "branch"', "branch") : gitRef(sketch.branch, "branch");
  if (sketch.card !== undefined && sketch.newCard !== undefined) fail(CREATE_ERRORS.invalidField, '"card" e "newCard" não vão juntos', "card");
  const parts = ["hades agent new", shellQuote(sketch.name), flag("--role", role), flag("--branch", branch)];
  if (sketch.base !== undefined) parts.push(flag("--base", gitRef(sketch.base, "base")));
  if (sketch.card !== undefined) {
    const card = text(sketch.card, "card", CREATE_LIMITS.titleChars);
    if (!CARD_PATTERN.test(card)) fail(CREATE_ERRORS.invalidField, '"card" não é um id de card', "card");
    parts.push(flag("--card", card));
  }
  if (sketch.newCard !== undefined) {
    const { title, tags, desc } = sketch.newCard;
    parts.push(flag("--new-card", text(title, "newCard.title", CREATE_LIMITS.titleChars)));
    if (!Array.isArray(tags) || tags.length === 0 || tags.length > CREATE_LIMITS.tags) fail(CREATE_ERRORS.invalidField, `"newCard.tags" deve ter de 1 a ${CREATE_LIMITS.tags} etiquetas`, "newCard.tags");
    for (const tag of tags) {
      if (typeof tag !== "string" || tag.length > CREATE_LIMITS.tagChars || !TAG_PATTERN.test(tag)) fail(CREATE_ERRORS.invalidField, `etiqueta inválida: ${String(tag)}`, "newCard.tags");
    }
    parts.push(flag("--tags", tags.join(",")));
    if (desc !== undefined) parts.push(flag("--desc", text(desc, "newCard.desc", CREATE_LIMITS.descChars, true)));
  }
  if (sketch.specs !== undefined) {
    if (sketch.specs.length === 0 || sketch.specs.length > CREATE_LIMITS.specs) fail(CREATE_ERRORS.invalidField, `"specs" deve ter de 1 a ${CREATE_LIMITS.specs} itens`, "specs");
    const specs = sketch.specs.map((spec) => text(spec, "specs", CREATE_LIMITS.refChars));
    for (const spec of specs) if (spec.includes(",") || spec.startsWith("-")) fail(CREATE_ERRORS.invalidField, `spec inválida: ${spec}`, "specs");
    parts.push(flag("--specs", specs.join(",")));
  }
  return parts.join(" ");
}

function skillCommand(sketch: UnitSketch, role: UnitRole): string {
  const forbidden = (["branch", "card", "newCard", "specs"] as const).find((field) => sketch[field] !== undefined);
  if (forbidden) fail(CREATE_ERRORS.invalidField, `"${forbidden}" só vale para unidade de projeto`, forbidden);
  if (!(SKILL_ROLES as readonly string[]).includes(role)) fail(CREATE_ERRORS.invalidField, "unidade de skill aceita papel impl ou consolidate", "role");
  const parts = ["hades agent skill-new", shellQuote(sketch.name)];
  if (sketch.base !== undefined) parts.push(flag("--base", gitRef(sketch.base, "base")));
  parts.push(flag("--role", role));
  if (sketch.port !== undefined) {
    if (!Number.isInteger(sketch.port) || sketch.port < 1 || sketch.port > 65_535) fail(CREATE_ERRORS.invalidField, '"port" deve ser inteiro de 1 a 65535', "port");
    parts.push(flag("--port", String(sketch.port)));
  }
  return parts.join(" ");
}

/** Valida o esboço e devolve os comandos (criar, depois start). Lança `CreateError` com código estável. */
export function designUnit(sketch: UnitSketch): UnitCommands {
  if (!isRecord(sketch)) return fail(CREATE_ERRORS.invalidField, "o esboço deve ser um objeto");
  if (!(UNIT_KINDS as readonly string[]).includes(sketch.kind)) return fail(CREATE_ERRORS.invalidField, `"kind" deve ser ${UNIT_KINDS.join(" ou ")}`, "kind");
  if (typeof sketch.name !== "string" || !UNIT_NAME_PATTERN.test(sketch.name)) return fail(CREATE_ERRORS.invalidName, "nome curto: minúsculas, números e hífen (até 31 caracteres)", "name");
  const role: UnitRole = sketch.role ?? "impl";
  if (!(PROJECT_ROLES as readonly string[]).includes(role)) return fail(CREATE_ERRORS.invalidField, `"role" deve ser ${PROJECT_ROLES.join(", ")}`, "role");
  const create = sketch.kind === "skill" ? skillCommand(sketch, role) : projectCommand(sketch, role);
  const commands = [create, `hades agent start-cmd ${shellQuote(sketch.name)}`];
  return { commands, text: commands.join("\n") };
}

/** Lê o esboço de um nó do usuário do tipo `unit-sketch` (`data` do documento) e valida; outro tipo de nó é erro. */
export function readUnitSketch(node: Pick<CanvasNode, "id" | "type" | "data">): UnitSketch {
  if (node.type !== UNIT_SKETCH_TYPE) return fail(CREATE_ERRORS.invalidSketch, `o nó ${node.id} não é um esboço de unidade`);
  const { data } = node;
  const sketch: UnitSketch = { kind: requireString(data.kind, "kind") as UnitKind, name: requireString(data.name, "name") };
  if (data.role !== undefined) sketch.role = data.role as UnitRole;
  if (data.branch !== undefined) sketch.branch = data.branch as string;
  if (data.base !== undefined) sketch.base = data.base as string;
  if (data.port !== undefined) sketch.port = data.port as number;
  if (data.card !== undefined) sketch.card = data.card as string;
  if (data.newCard !== undefined) {
    if (!isRecord(data.newCard)) return fail(CREATE_ERRORS.invalidField, '"newCard" deve ser um objeto', "newCard");
    sketch.newCard = data.newCard as UnitSketch["newCard"] & object;
  }
  if (data.specs !== undefined) sketch.specs = data.specs as string[];
  designUnit(sketch);
  return sketch;
}
