// Validação de perfis, stacks, catálogo de qualidade e choices.tsv (subconjunto de JSON Schema, sem dependência).
// Mesmas regras e mesmas mensagens do `hades project validate`.
import { basename, dirname, join, sep } from "node:path";
import { isFile, listDir, readText, realpathMissingOk } from "./fs.ts";
import { hadesHome, skillRoot } from "./paths.ts";
import { type Json, type JsonObject, coreRange, isObject, pyRepr, pyText, readJson, stacksRoot } from "./profile.ts";
import { packsRoot } from "./project.ts";

const SCHEMAS = join(skillRoot, "loop", "schema");
// ERE que só existe em um dos três motores (bash, python, node) não vale no perfil
const ERE_FORBIDDEN = ["\\d", "\\D", "(?", "*?", "+?", "??", "\\p{", "[[:"];
const KINDS: Record<string, string> = { "hades.profile/1": "profile", "hades.stack/1": "stack", "hades.quality/1": "quality" };

function typeOk(value: Json, type: string): boolean {
  switch (type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function strings(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function regexMatches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}

function check(value: Json, schemaIn: JsonObject, path: string, root: JsonObject, errors: string[]): void {
  let schema = schemaIn;
  if (typeof schema.$ref === "string") {
    const defs = root.$defs;
    const target = isObject(defs) ? defs[schema.$ref.split("/").at(-1) as string] : undefined;
    schema = isObject(target) ? target : {};
  }
  const type = schema.type;
  if (type !== undefined) {
    const types = Array.isArray(type) ? strings(type) : [String(type)];
    if (!types.some((t) => typeOk(value, t))) {
      errors.push(`${path}: esperado ${pyText(type)}`);
      return;
    }
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: tem de ser ${pyRepr(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: ${pyRepr(value)} fora de ${pyRepr(schema.enum)}`);
  }
  if (typeof value === "string") {
    const minLength = typeof schema.minLength === "number" ? schema.minLength : 0;
    if ([...value].length < minLength) errors.push(`${path}: curto demais`);
    if (typeof schema.pattern === "string" && !regexMatches(schema.pattern, value)) {
      errors.push(`${path}: ${pyRepr(value)} não casa ${schema.pattern}`);
    }
    if (schema["x-regex"] === "ere") {
      const bad = ERE_FORBIDDEN.filter((fragment) => value.includes(fragment));
      if (bad.length > 0) errors.push(`${path}: regex não portável (bash/python/node): ${pyRepr(bad)}`);
      try {
        new RegExp(value);
      } catch (error) {
        errors.push(`${path}: regex inválida: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (Array.isArray(value)) {
    const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
    if (value.length < minItems) errors.push(`${path}: precisa de ${minItems} item(ns)`);
    if (isObject(schema.items)) {
      const items = schema.items;
      value.forEach((item, i) => check(item, items, `${path}[${i}]`, root, errors));
    }
  }
  if (isObject(value)) checkObject(value, schema, path, root, errors);
}

function checkObject(value: JsonObject, schema: JsonObject, path: string, root: JsonObject, errors: string[]): void {
  for (const key of strings(schema.required)) {
    if (!(key in value)) errors.push(`${path}.${key}: obrigatório`);
  }
  const props = isObject(schema.properties) ? schema.properties : {};
  const names = isObject(schema.propertyNames) && typeof schema.propertyNames.pattern === "string" ? schema.propertyNames.pattern : "";
  for (const [key, item] of Object.entries(value)) {
    const known = props[key];
    if (key in props && isObject(known)) {
      check(item, known, `${path}.${key}`, root, errors);
    } else if (schema.additionalProperties === false) {
      errors.push(`${path}.${key}: campo desconhecido`);
    } else if (isObject(schema.additionalProperties)) {
      if (!regexMatches(names, key)) errors.push(`${path}.${key}: nome fora do padrão`);
      check(item, schema.additionalProperties, `${path}.${key}`, root, errors);
    }
  }
}

function checkChoices(text: string): string[] {
  const errors: string[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line || line.startsWith("#")) return;
    const cols = line.split("\t");
    if (cols.length !== 2 || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(cols[0] as string) || !["on", "off"].includes(cols[1] as string)) {
      errors.push(`linha ${index + 1}: esperado "<id>\\t<on|off>"`);
    }
  });
  return errors;
}

function insidePack(pack: string, rel: string): boolean {
  const target = realpathMissingOk(join(pack, rel));
  return (target === pack || target.startsWith(pack + sep)) && isFile(target);
}

/** Erros do arquivo (vazio = válido). O tipo sai do campo `schema` (ou `.tsv` = escolhas do catálogo). */
export function validateFile(path: string): string[] {
  if (path.endsWith(".tsv")) {
    const text = readText(path);
    return text === undefined ? [`ilegível: ${path}`] : checkChoices(text.endsWith("\n") ? text.slice(0, -1) : text);
  }
  const doc = readJson(path);
  if (doc === undefined) return [isFile(path) ? `ilegível: ${path}` : `ilegível: [Errno 2] No such file or directory: ${pyRepr(path)}`];
  const kind = isObject(doc) && typeof doc.schema === "string" ? KINDS[doc.schema] : undefined;
  if (!isObject(doc) || kind === undefined) return [`campo schema desconhecido: ${pyRepr(isObject(doc) ? (doc.schema ?? null) : null)}`];
  const schema = readJson(join(SCHEMAS, `${kind}.schema.json`));
  if (!isObject(schema)) return [`ilegível: ${join(SCHEMAS, `${kind}.schema.json`)}`];
  const errors: string[] = [];
  check(doc, schema, "$", schema, errors);
  const folder = basename(dirname(path));
  if ((kind === "profile" || kind === "stack") && doc.name !== folder) {
    errors.push(`$.name: ${pyRepr(doc.name ?? null)} difere da pasta ${pyRepr(folder)}`);
  }
  if (kind === "profile" && typeof doc.core === "string") {
    try {
      coreRange(doc.core);
    } catch (error) {
      errors.push(`$.core: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (kind === "profile") {
    const pack = realpathMissingOk(dirname(path));
    const refs = isObject(doc.refs) ? Object.entries(doc.refs).map(([name, rel]): [string, Json] => [`refs.${name}`, rel]) : [];
    const create = isObject(doc.card) ? (doc.card.create ?? null) : null;
    for (const [key, rel] of [...refs, ["card.create", create], ["domainTerms", doc.domainTerms ?? null]] as [string, Json][]) {
      if (typeof rel === "string" && rel && !insidePack(pack, rel)) errors.push(`$.${key}: ${pyRepr(rel)} não é arquivo do pacote`);
    }
  }
  return errors;
}

function files(root: string, name: string): string[] {
  return listDir(root)
    .map((dir) => join(root, dir, name))
    .filter(isFile);
}

/** O que o `validate` sem argumento confere: perfis, stacks, catálogo e choices instalados. */
export function installedFiles(): string[] {
  const quality = join(hadesHome(), "quality");
  const jsons = listDir(quality)
    .filter((n) => n.endsWith(".json"))
    .map((n) => join(quality, n));
  const choices = join(quality, "choices.tsv");
  return [
    ...files(packsRoot(), "profile.json"),
    ...files(stacksRoot(), "stack.json"),
    ...files(join(skillRoot, "stacks"), "stack.json"),
    ...jsons,
    ...(isFile(choices) ? [choices] : []),
  ];
}

export function isProfileWithoutCore(path: string): boolean {
  const doc = readJson(path);
  return path.endsWith("profile.json") && isObject(doc) && !("core" in doc);
}
