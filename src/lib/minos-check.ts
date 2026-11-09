// Minos: as conferências de fronteira que todos os modelos usam. Tipo errado, enum desconhecido, texto ou lista acima do
// teto são recusados com o caminho do campo, nunca coagidos; o valor não entra na mensagem (ele pode ser segredo).

export const SCOPES = ["personal", "team"] as const;
export type Scope = (typeof SCOPES)[number];

export const TEXT_MAX = 500;
export const LIST_MAX = 200;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export class ContractError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.path = path;
    this.name = "ContractError";
  }
}

export type Obj = Record<string, unknown>;

export function obj(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ContractError(path, "esperava um objeto");
  return value as Obj;
}

export function text(value: unknown, path: string, max: number = TEXT_MAX): string {
  if (typeof value !== "string") throw new ContractError(path, "esperava texto");
  if (value.length > max) throw new ContractError(path, `texto acima de ${max} caracteres`);
  return value;
}

export function list(value: unknown, path: string, max: number = LIST_MAX): unknown[] {
  if (!Array.isArray(value)) throw new ContractError(path, "esperava uma lista");
  if (value.length > max) throw new ContractError(path, `lista acima de ${max} itens`);
  return value;
}

export function count(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new ContractError(path, "esperava inteiro não negativo");
  return value;
}

export function nullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ContractError(path, "esperava número finito não negativo ou null");
  return value;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new ContractError(path, `esperava um de ${allowed.join(", ")}`);
  return value as T;
}

export function utc(value: unknown, path: string): string {
  const t = text(value, path);
  if (!ISO_UTC.test(t) || Number.isNaN(Date.parse(t))) throw new ContractError(path, "esperava instante ISO 8601 em UTC (com Z)");
  return t;
}
