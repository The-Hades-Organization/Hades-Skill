// Manifesto do diretório devolvido por `--out <dir>`: o worker lista arquivo + sha256 + mtime (no relógio dele) e o
// cliente confere a árvore que chegou antes de promovê-la. Só arquivos regulares valem: link, dispositivo e afins
// derrubam o retorno, porque o cliente não confia no que o tar do outro lado trouxe.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { safeRelative } from "./protocol.ts";

export const MANIFEST_NAME = ".hades-manifest.json";
export const MANIFEST_VERSION = 1;
const MANIFEST_MAX_FILES = 200_000;
const MANIFEST_MAX_DEPTH = 64;

export interface ManifestFile {
  /** relativo ao diretório */
  path: string;
  sha256: string;
  mtimeMs: number;
}

export interface ManifestDir {
  /** caminho absoluto do diretório no worker (igual ao do cliente) */
  dir: string;
  files: ManifestFile[];
}

export interface Manifest {
  v: number;
  /** início do job no relógio do worker: o `--fresh` compara mtime com isto, sem depender do relógio do cliente */
  startedMs: number;
  dirs: ManifestDir[];
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** Lista a árvore com sha256 e mtime, em ordem estável. Link simbólico ou arquivo especial = erro. */
export function hashTree(root: string): ManifestFile[] {
  const files: ManifestFile[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > MANIFEST_MAX_DEPTH) throw new ManifestError(`árvore funda demais em ${rel}`);
    for (const name of readdirSync(join(root, rel)).sort()) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const info = lstatSync(join(root, path));
      if (info.isDirectory()) walk(path, depth + 1);
      else if (info.isFile()) {
        if (files.length >= MANIFEST_MAX_FILES) throw new ManifestError("arquivos demais no diretório");
        files.push({ path, sha256: sha256(readFileSync(join(root, path))), mtimeMs: Math.floor(info.mtimeMs) });
      } else throw new ManifestError(`${path}: só arquivo regular volta (link e especial não)`);
    }
  };
  walk("", 0);
  return files;
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ManifestError("manifesto não é JSON");
  }
  const m = raw as { v?: unknown; startedMs?: unknown; dirs?: unknown };
  if (typeof raw !== "object" || raw === null || m.v !== MANIFEST_VERSION || typeof m.startedMs !== "number" || !Array.isArray(m.dirs)) throw new ManifestError("manifesto com formato inesperado");
  const dirs = m.dirs.map((d: unknown): ManifestDir => {
    const entry = d as { dir?: unknown; files?: unknown };
    if (typeof d !== "object" || d === null || typeof entry.dir !== "string" || !Array.isArray(entry.files)) throw new ManifestError("manifesto: diretório inválido");
    const files = entry.files.map((f: unknown): ManifestFile => {
      const file = f as { path?: unknown; sha256?: unknown; mtimeMs?: unknown };
      if (typeof f !== "object" || f === null || typeof file.path !== "string" || file.path === "" || !safeRelative(file.path) || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256) || typeof file.mtimeMs !== "number") {
        throw new ManifestError("manifesto: arquivo inválido");
      }
      return { path: file.path, sha256: file.sha256, mtimeMs: file.mtimeMs };
    });
    return { dir: entry.dir, files };
  });
  return { v: MANIFEST_VERSION, startedMs: m.startedMs, dirs };
}

/** Diferenças entre o manifesto e o que chegou (vazio = íntegro). Pura: recebe as duas listas. */
export function diffTree(expected: readonly ManifestFile[], actual: readonly ManifestFile[]): string[] {
  const problems: string[] = [];
  const got = new Map(actual.map((f) => [f.path, f.sha256]));
  for (const f of expected) {
    const sha = got.get(f.path);
    if (sha === undefined) problems.push(`faltou ${f.path}`);
    else if (sha !== f.sha256) problems.push(`checksum diferente: ${f.path}`);
  }
  const want = new Set(expected.map((f) => f.path));
  for (const f of actual) if (!want.has(f.path)) problems.push(`arquivo fora do manifesto: ${f.path}`);
  return problems;
}

/** `--fresh`: o arquivo existe no manifesto e foi gravado depois do início do job. */
export function freshProblem(dir: ManifestDir, fresh: string, startedMs: number): string | undefined {
  const file = dir.files.find((f) => f.path === fresh);
  if (file === undefined) return `${fresh} não está no diretório devolvido`;
  if (file.mtimeMs < startedMs) return `${fresh} é mais velho que o início do job (o build não o regravou)`;
  return undefined;
}
