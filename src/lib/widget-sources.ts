// Fontes do widget Android: a lista, o hash (a regra única que o painel e o build do APK compartilham) e a cópia para a
// pasta de build. O hash é o do `sha256sum` de cada arquivo em ordem de bytes, que o build grava no sidecar do APK.
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { join, relative } from "node:path";
import { walkTree } from "./install-copy.ts";

/** Saída de build do Gradle: fica fora do hash e da cópia, e a cópia não a apaga do destino (como o --exclude do rsync). */
const IGNORED_SOURCE_NAMES: ReadonlySet<string> = new Set(["build", ".gradle"]);

/** Arquivos regulares das fontes (caminhos absolutos), sem build/ e .gradle; lança se a pasta não existe. */
export function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (IGNORED_SOURCE_NAMES.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(dir);
  return files;
}

const hashFile = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** sha256 da saída de `sha256sum` sobre `files` (de `listSourceFiles(dir)`), com os caminhos relativos a `dir` como `./x`. */
export function sourcesShaOf(dir: string, files: readonly string[]): string {
  const entries = files.map((file) => ({ rel: Buffer.from(`./${relative(dir, file)}`), hash: hashFile(file) }));
  entries.sort((a, b) => Buffer.compare(a.rel, b.rel));
  return createHash("sha256").update(entries.map((e) => `${e.hash}  ${e.rel.toString()}\n`).join("")).digest("hex");
}

export function sourcesSha(dir: string): string {
  return sourcesShaOf(dir, listSourceFiles(dir));
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

const isIgnored = (_rel: string, name: string): boolean => IGNORED_SOURCE_NAMES.has(name);

/** Espelha `src` em `dst` (modo e data preservados), tira do destino o que a origem não tem e deixa build/ e .gradle onde estão. */
export function syncSources(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  const wanted = walkTree(src, isIgnored);
  const keep = new Set(wanted.map((e) => e.rel));
  for (const entry of walkTree(dst, isIgnored)) {
    if (!keep.has(entry.rel)) rmSync(join(dst, entry.rel), { recursive: true, force: true });
  }
  for (const entry of wanted) {
    const from = join(src, entry.rel);
    const to = join(dst, entry.rel);
    const present = lstatOrNull(to);
    if (present && present.isDirectory() !== (entry.kind === "dir")) rmSync(to, { recursive: true, force: true });
    if (entry.kind === "dir") {
      mkdirSync(to, { recursive: true });
      continue;
    }
    if (entry.kind !== "file") continue;
    mkdirSync(join(to, ".."), { recursive: true });
    const st = lstatSync(from);
    copyFileSync(from, to);
    chmodSync(to, entry.mode);
    utimesSync(to, st.atime, st.mtime);
  }
}
