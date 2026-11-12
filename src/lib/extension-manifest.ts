// Manifesto de extensão (extensions/<nome>/extension.json): ferramenta externa da máquina que a Hades detecta e consome.
// Aqui só se valida: ler o manifesto não executa nada. Cada erro leva o caminho do campo e um código estável.
import { isObject } from "./profile.ts";

/** Códigos estáveis: só ganham valores, nunca mudam de nome (quem consome ramifica por eles). */
export const EXT_ERRORS = {
  notJson: "ext.manifest.not-json",
  notObject: "ext.manifest.not-object",
  fieldMissing: "ext.manifest.field-missing",
  fieldType: "ext.manifest.field-type",
  fieldValue: "ext.manifest.field-value",
  capabilityUnknown: "ext.manifest.capability-unknown",
  schemaUnsupported: "ext.manifest.schema-unsupported",
  nameMismatch: "ext.manifest.name-mismatch",
  binaryMissing: "ext.binary-missing",
  versionUnreadable: "ext.version-unreadable",
  versionBelowMin: "ext.version-below-min",
  healthFailed: "ext.health-failed",
} as const;
export type ExtErrorCode = (typeof EXT_ERRORS)[keyof typeof EXT_ERRORS];

export interface ExtError {
  code: ExtErrorCode;
  /** caminho do campo no manifesto (`binary.names[0]`); vazio quando o erro é do arquivo ou do ambiente */
  field: string;
  message: string;
}

/** Lista fechada; capacidade nova entra aqui (e na doc) antes de algum manifesto usá-la. */
export const CAPABILITIES = ["canvas.terminal", "voice", "window"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const MANIFEST_SCHEMA = 1;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONFIG_KEY = /^[A-Z][A-Z0-9_]*$/;
const BINARY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_MIN = /^\d+\.\d+\.\d+$/;
const TEXT_MAX = 600;
const ARGV_MAX = 16;

export interface ExtensionManifest {
  name: string;
  description: string;
  binary: { names: string[]; configKey: string | null };
  version: { command: string[]; min: string } | null;
  capabilities: Capability[];
  install: { text: string };
  health: { command: string[] } | null;
  configKeys: string[];
  enableKey: string;
}

export type ParseResult = { ok: true; manifest: ExtensionManifest } | { ok: false; errors: ExtError[] };

class Collector {
  readonly errors: ExtError[] = [];
  add(code: ExtErrorCode, field: string, message: string): void {
    this.errors.push({ code, field, message });
  }
}

function text(c: Collector, value: unknown, field: string, max = TEXT_MAX): string | undefined {
  if (value === undefined) return void c.add(EXT_ERRORS.fieldMissing, field, `campo ausente: ${field}`);
  if (typeof value !== "string") return void c.add(EXT_ERRORS.fieldType, field, `${field}: esperado texto`);
  if (value.trim() === "" || value.length > max) return void c.add(EXT_ERRORS.fieldValue, field, `${field}: texto vazio ou maior que ${max}`);
  return value;
}

function textList(c: Collector, value: unknown, field: string, pattern: RegExp, minItems: number): string[] | undefined {
  if (value === undefined) return void c.add(EXT_ERRORS.fieldMissing, field, `campo ausente: ${field}`);
  if (!Array.isArray(value)) return void c.add(EXT_ERRORS.fieldType, field, `${field}: esperada lista`);
  if (value.length < minItems || value.length > ARGV_MAX) return void c.add(EXT_ERRORS.fieldValue, field, `${field}: de ${minItems} a ${ARGV_MAX} itens`);
  const items: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== "string") return c.add(EXT_ERRORS.fieldType, `${field}[${i}]`, `${field}[${i}]: esperado texto`);
    if (!pattern.test(item)) return c.add(EXT_ERRORS.fieldValue, `${field}[${i}]`, `${field}[${i}]: formato inválido`);
    items.push(item);
  });
  return items;
}

/** argv sem shell: o primeiro item é um dos binários declarados, o resto é texto livre curto. */
function command(c: Collector, value: unknown, field: string, names: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > ARGV_MAX) {
    return void c.add(value === undefined ? EXT_ERRORS.fieldMissing : EXT_ERRORS.fieldType, field, `${field}: esperada lista de 1 a ${ARGV_MAX} argumentos`);
  }
  const argv: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== "string" || item === "" || item.length > TEXT_MAX) c.add(EXT_ERRORS.fieldType, `${field}[${i}]`, `${field}[${i}]: esperado texto curto`);
    else argv.push(item);
  });
  if (names.length > 0 && argv.length === value.length && !names.includes(argv[0] as string)) {
    c.add(EXT_ERRORS.fieldValue, `${field}[0]`, `${field}[0]: tem de ser um dos binários declarados em binary.names`);
  }
  return argv;
}

function object(c: Collector, value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return void c.add(EXT_ERRORS.fieldMissing, field, `campo ausente: ${field}`);
  if (!isObject(value)) return void c.add(EXT_ERRORS.fieldType, field, `${field}: esperado objeto`);
  return value;
}

function capabilities(c: Collector, value: unknown): Capability[] {
  const items = textList(c, value, "capabilities", /^.+$/, 1) ?? [];
  const known: Capability[] = [];
  items.forEach((item, i) => {
    const match = CAPABILITIES.find((cap) => cap === item);
    if (match === undefined) c.add(EXT_ERRORS.capabilityUnknown, `capabilities[${i}]`, `capabilities[${i}]: capacidade desconhecida '${item}' (${CAPABILITIES.join(", ")})`);
    else known.push(match);
  });
  return known;
}

/** Valida um manifesto já lido do JSON. Junta todos os erros em vez de parar no primeiro. */
export function parseManifest(raw: unknown): ParseResult {
  const c = new Collector();
  if (!isObject(raw)) return { ok: false, errors: [{ code: EXT_ERRORS.notObject, field: "", message: "o manifesto deve ser um objeto JSON" }] };
  if (raw.schema !== MANIFEST_SCHEMA) c.add(EXT_ERRORS.schemaUnsupported, "schema", `schema: esperado ${MANIFEST_SCHEMA}`);

  const nameRaw = text(c, raw.name, "name", 64);
  if (nameRaw !== undefined && !NAME.test(nameRaw)) c.add(EXT_ERRORS.fieldValue, "name", "name: minúsculas, números, ponto, hífen ou sublinhado");
  const description = text(c, raw.description, "description");

  const bin = object(c, raw.binary, "binary");
  const names = bin ? (textList(c, bin.names, "binary.names", BINARY_NAME, 1) ?? []) : [];
  let binaryKey: string | null = null;
  if (bin && bin.configKey !== undefined && bin.configKey !== null) {
    if (typeof bin.configKey !== "string") c.add(EXT_ERRORS.fieldType, "binary.configKey", "binary.configKey: esperado texto");
    else if (!CONFIG_KEY.test(bin.configKey)) c.add(EXT_ERRORS.fieldValue, "binary.configKey", "binary.configKey: chave em MAIÚSCULAS");
    else binaryKey = bin.configKey;
  }

  let version: ExtensionManifest["version"] = null;
  if (raw.version === undefined) c.add(EXT_ERRORS.fieldMissing, "version", "campo ausente: version (use null sem comando de versão)");
  else if (raw.version !== null) {
    const v = object(c, raw.version, "version");
    if (v) {
      const argv = command(c, v.command, "version.command", names);
      const min = text(c, v.min, "version.min", 32);
      if (min !== undefined && !VERSION_MIN.test(min)) c.add(EXT_ERRORS.fieldValue, "version.min", "version.min: formato x.y.z");
      if (argv !== undefined && min !== undefined) version = { command: argv, min };
    }
  }

  const caps = capabilities(c, raw.capabilities);
  const inst = object(c, raw.install, "install");
  const installText = inst ? text(c, inst.text, "install.text") : undefined;

  let health: ExtensionManifest["health"] = null;
  if (raw.health === undefined) c.add(EXT_ERRORS.fieldMissing, "health", "campo ausente: health (use null sem comando de saúde)");
  else if (raw.health !== null) {
    const h = object(c, raw.health, "health");
    const argv = h ? command(c, h.command, "health.command", names) : undefined;
    if (argv !== undefined) health = { command: argv };
  }

  const configKeys = textList(c, raw.configKeys, "configKeys", CONFIG_KEY, 0) ?? [];
  const enableKey = text(c, raw.enableKey, "enableKey", 64);
  if (enableKey !== undefined && !CONFIG_KEY.test(enableKey)) c.add(EXT_ERRORS.fieldValue, "enableKey", "enableKey: chave em MAIÚSCULAS");

  if (c.errors.length > 0 || nameRaw === undefined || description === undefined || installText === undefined || enableKey === undefined) {
    return { ok: false, errors: c.errors };
  }
  return {
    ok: true,
    manifest: { name: nameRaw, description, binary: { names, configKey: binaryKey }, version, capabilities: caps, install: { text: installText }, health, configKeys, enableKey },
  };
}

/** Primeiro x.y.z da saída de um `--version`; undefined se não houver. */
export function extractVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+/.exec(output.slice(0, 4096))?.[0];
}

/** Compara x.y.z numericamente: negativo, zero ou positivo. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
