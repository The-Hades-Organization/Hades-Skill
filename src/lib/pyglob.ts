// pathlib.Path.glob do Python, só com o que os scripts usam (`*`, `?`, `[…]`, `**/`): sem seguir link simbólico para pasta,
// `*` casa nome começado por ponto, maiúscula e minúscula diferem. Os resultados vêm na ordem do `sorted(Path)`: por partes.
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MAGIC = /[*?[]/;

/** fnmatch.translate de um trecho do caminho. */
function segmentRegex(segment: string): RegExp {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] as string;
    if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (c === "[") {
      const close = segment.indexOf("]", i + 2);
      if (close < 0) source += "\\[";
      else {
        const body = segment.slice(i + 1, close).replace(/\\/g, "\\\\");
        source += body.startsWith("!") ? `[^${body.slice(1)}]` : `[${body}]`;
        i = close;
      }
    } else source += c.replace(/[.+^${}()|\\/-]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "su");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function realSubdirectories(dir: string): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    const path = join(dir, name);
    try {
      if (lstatSync(path).isDirectory()) found.push(path, ...realSubdirectories(path));
    } catch {
      continue;
    }
  }
  return found;
}

function walk(dir: string, segments: string[], found: Set<string>): void {
  const [segment, ...rest] = segments;
  if (segment === undefined) {
    found.add(dir);
    return;
  }
  if (segment === "**") {
    for (const base of [dir, ...realSubdirectories(dir)]) walk(base, rest, found);
    return;
  }
  if (!MAGIC.test(segment)) {
    const path = join(dir, segment);
    try {
      statSync(path);
    } catch {
      return;
    }
    if (rest.length === 0 || isDirectory(path)) walk(path, rest, found);
    return;
  }
  const matcher = segmentRegex(segment);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!matcher.test(name)) continue;
    const path = join(dir, name);
    if (rest.length === 0 || isDirectory(path)) walk(path, rest, found);
  }
}

/** Caminhos que casam o padrão, relativo a `root`, sem ordem garantida (use `comparePaths`). */
export function pyGlob(root: string, pattern: string): string[] {
  const found = new Set<string>();
  walk(root, pattern.split("/"), found);
  return [...found];
}

/** A ordem de `sorted(Path)`: compara as partes, não o texto (`a/b` vem antes de `a-b/c`). */
export function comparePaths(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i] as string;
    const y = pb[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}
