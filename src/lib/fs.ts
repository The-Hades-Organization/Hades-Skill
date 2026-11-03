import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Texto do arquivo, ou undefined se ele não existe ou não abre. */
export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Primeira linha do arquivo, como o `head -1` dos scripts (sem o \n final). */
export function firstLine(path: string): string {
  const text = readText(path);
  if (text === undefined) return "";
  const nl = text.indexOf("\n");
  return nl < 0 ? text : text.slice(0, nl);
}

/** Nomes das entradas de uma pasta em ordem estável (o glob do bash também ordena); vazio se a pasta não existe. */
export function listDir(path: string): string[] {
  try {
    return readdirSync(path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

/** `realpath -m`: resolve os links do trecho que existe e mantém o resto como veio. */
export function realpathMissingOk(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(realpathSync(current), ...rest);
}
