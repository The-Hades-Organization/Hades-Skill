// Texto no formato do Python (json.dumps com ensure_ascii=False e repr): histórico, exceções e saída do Cerberus são
// lidos por jq, grep e pelo painel, e o contrato de arquivo é o do original em Python.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Número que o Python teria como float: `3.0` sai com a casa decimal (o `3` do JS seria int). */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

/** round(valor, casas) do Python: metade vai para o par (0.125 → 0.12), como o round() de float do CPython. */
export function pyRound(value: number, digits: number): PyFloat {
  // a conferência de metade precisa da expansão decimal exata do double: value * 10 ** digits já arredonda
  const [whole = "", fraction = ""] = Math.abs(value).toFixed(100).split(".");
  const tail = fraction.slice(digits);
  if (!/^50*$/.test(tail)) return new PyFloat(Number(value.toFixed(digits)));
  const kept = BigInt(whole + fraction.slice(0, digits));
  const even = kept % 2n === 0n ? kept : kept + 1n;
  return new PyFloat((value < 0 ? -1 : 1) * Number(even) / 10 ** digits);
}

function pyFloatText(value: number): string {
  if (!Number.isFinite(value)) return "null";
  const text = JSON.stringify(value);
  return Number.isInteger(value) && !text.includes("e") ? `${text}.0` : text;
}

/** json.dumps(valor, ensure_ascii=False[, indent]): separadores ", " e ": " (ou quebra de linha com indent). */
export function pyDumps(value: unknown, indent?: number, level = 0): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof PyFloat) return pyFloatText(value.value);
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  const pad = indent === undefined ? "" : `\n${" ".repeat(indent * (level + 1))}`;
  const close = indent === undefined ? "" : `\n${" ".repeat(indent * level)}`;
  const sep = indent === undefined ? ", " : `,${pad}`;
  const open = (text: string) => (indent === undefined ? text : `${text}${pad}`);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `${open("[")}${value.map((item) => pyDumps(item, indent, level + 1)).join(sep)}${close}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
  if (entries.length === 0) return "{}";
  const body = entries.map(([key, item]) => `${JSON.stringify(key)}: ${pyDumps(item, indent, level + 1)}`);
  return `${open("{")}${body.join(sep)}${close}}`;
}

/** repr() do Python: aspas simples (duplas se o texto tem aspas simples), None/True/False, listas e dicts. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return reprString(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${reprString(key)}: ${pyRepr(item)}`)
    .join(", ")}}`;
}

function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + quote;
}

const LINE_BREAK = new RegExp(String.raw`\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]`);

/** str.splitlines(): quebra em \n, \r\n, \r e nos separadores que o Python também trata como fim de linha. */
export function splitLines(text: string): string[] {
  const lines = text.split(LINE_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
