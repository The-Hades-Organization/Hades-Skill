// Higiene do índice de memória do projeto (~/.claude/projects/<slug do cwd>/memory/MEMORY.md): modelo puro, sem disco.
// O que lê o disco entra por `MemoryProbe`; reference/memory.md descreve o problema e o `hades memory tidy`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 24,4 KB: o Claude Code carrega só esse começo do MEMORY.md em cada sessão e corta o resto em silêncio (medido numa instalação real, issue #66). */
export const MEMORY_LOAD_LIMIT_BYTES = Math.round(24.4 * 1024);
/** Linha de índice acima disso perde o gancho no `tidy`; o título e o link bastam para o agente decidir se abre o arquivo. */
export const LONG_LINE_CHARS = 150;
/** Memória `type: project` sem mudança há mais que isso vira histórico encerrado. */
export const STALE_DAYS = 60;
const DAY_MS = 86_400_000;
/** Texto que marca trabalho já entregue; a heurística é de propósito simples e está escrita aqui. */
const CLOSED_TEXT = /mergead[ao]|entregue|conclu[íi]d[ao]/i;
const ORCHESTRATION_TEXT = /orquestra|orchestrat/i;
const ENTRY = /^\s*[-*]\s+\[([^\]]*)\]\(([^)\s]+)\)(.*)$/;

export interface MemoryMeta {
  type?: string;
  modified?: Date;
}

export interface MemoryProbe {
  exists(target: string): boolean;
  meta(target: string): MemoryMeta | undefined;
}

export interface IndexEntry {
  line: number;
  raw: string;
  title: string;
  target: string;
  hook: string;
}

export interface Analysis {
  bytes: number;
  lines: number;
  overLimit: boolean;
  /** linhas que ficam depois do byte 24,4 KB e por isso nunca chegam ao agente */
  truncatedLines: number;
  longLines: { line: number; chars: number }[];
  duplicates: { line: number; target: string }[];
  missing: { line: number; target: string }[];
  closed: { line: number; target: string }[];
}

export interface TidyPlan {
  principal: string;
  /** só as linhas de entrada que vão para o ORQUESTRACAO.md (vazio quando não há) */
  orquestracao: string;
  arquivo: string;
}

export const slugOfCwd = (cwd: string): string => cwd.replace(/\/+$/, "").replace(/[/.]/g, "-");
export const memoryDirOf = (cwd: string, home: string): string => join(home, ".claude", "projects", slugOfCwd(cwd), "memory");

export function parseEntry(raw: string, line: number): IndexEntry | undefined {
  const m = ENTRY.exec(raw);
  if (!m) return undefined;
  return { line, raw, title: m[1] ?? "", target: m[2] ?? "", hook: (m[3] ?? "").replace(/^\s*[—–-]\s*/, "").trim() };
}

const isRemote = (target: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(target);
/** Alvo que sai da pasta da memória nunca é lido: conta como ausente. */
const isUnsafe = (target: string): boolean => target.startsWith("/") || target.split("/").includes("..");

function entriesOf(text: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  text.split("\n").forEach((raw, i) => {
    const entry = parseEntry(raw, i + 1);
    if (entry && !isRemote(entry.target)) out.push(entry);
  });
  return out;
}

export function isClosed(entry: IndexEntry, probe: MemoryProbe, now: Date): boolean {
  if (CLOSED_TEXT.test(`${entry.title} ${entry.hook}`)) return true;
  if (isUnsafe(entry.target)) return false;
  const meta = probe.meta(entry.target);
  if (meta?.type !== "project" || meta.modified === undefined) return false;
  return now.getTime() - meta.modified.getTime() > STALE_DAYS * DAY_MS;
}

export function analyzeIndex(text: string, probe: MemoryProbe, now: Date): Analysis {
  const rawLines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const bytes = Buffer.byteLength(text);
  let acc = 0;
  let truncatedLines = 0;
  for (const raw of rawLines) {
    acc += Buffer.byteLength(raw) + 1;
    if (acc > MEMORY_LOAD_LIMIT_BYTES) truncatedLines += 1;
  }
  const result: Analysis = {
    bytes,
    lines: rawLines.length,
    overLimit: bytes > MEMORY_LOAD_LIMIT_BYTES,
    truncatedLines,
    longLines: [],
    duplicates: [],
    missing: [],
    closed: [],
  };
  rawLines.forEach((raw, i) => {
    if (raw.length > LONG_LINE_CHARS) result.longLines.push({ line: i + 1, chars: raw.length });
  });
  const seen = new Set<string>();
  for (const entry of entriesOf(text)) {
    if (seen.has(entry.target)) result.duplicates.push({ line: entry.line, target: entry.target });
    seen.add(entry.target);
    if (isUnsafe(entry.target) || !probe.exists(entry.target)) {
      result.missing.push({ line: entry.line, target: entry.target });
      continue;
    }
    if (isClosed(entry, probe, now)) result.closed.push({ line: entry.line, target: entry.target });
  }
  return result;
}

const shorten = (entry: IndexEntry): string =>
  entry.raw.length > LONG_LINE_CHARS ? `- [${entry.title}](${entry.target})` : entry.raw;

/** Plano do `tidy`: encurta, tira duplicata (fica a primeira) e divide as entradas; linha que não é entrada fica no principal. */
export function planTidy(text: string, probe: MemoryProbe, now: Date): TidyPlan {
  const principal: string[] = [];
  const orquestracao: string[] = [];
  const arquivo: string[] = [];
  const seen = new Set<string>();
  const rawLines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  rawLines.forEach((raw, i) => {
    const entry = parseEntry(raw, i + 1);
    if (!entry || isRemote(entry.target)) {
      principal.push(raw);
      return;
    }
    if (seen.has(entry.target)) return;
    seen.add(entry.target);
    const line = shorten(entry);
    const missing = isUnsafe(entry.target) || !probe.exists(entry.target);
    if (missing) principal.push(line);
    else if (isClosed(entry, probe, now)) arquivo.push(line);
    else if (ORCHESTRATION_TEXT.test(`${entry.title} ${entry.target} ${entry.hook}`)) orquestracao.push(line);
    else principal.push(line);
  });
  const join = (lines: string[]): string => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  return { principal: join(principal), orquestracao: join(orquestracao), arquivo: join(arquivo) };
}

/** Frontmatter mínimo: `type:` na raiz ou sob `metadata:`, e `modified:`; sem `modified`, vale o mtime do arquivo. */
export function metaOfFile(path: string): MemoryMeta | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const type = /^\s*type:\s*(\S+)/m.exec(front)?.[1];
  const stamp = /^\s*modified:\s*(\S+)/m.exec(front)?.[1];
  let modified = stamp === undefined ? undefined : new Date(stamp);
  if (modified === undefined || Number.isNaN(modified.getTime())) {
    try {
      modified = statSync(path).mtime;
    } catch {
      modified = undefined;
    }
  }
  return { ...(type === undefined ? {} : { type }), ...(modified === undefined ? {} : { modified }) };
}

export function diskProbe(dir: string): MemoryProbe {
  return {
    exists: (target) => existsSync(join(dir, target)),
    meta: (target) => metaOfFile(join(dir, target)),
  };
}

/** Pasta de memória do primeiro cwd cujo MEMORY.md existe; `undefined` quando nenhum tem índice. */
export function findMemoryDir(cwds: string[], home: string): string | undefined {
  for (const cwd of cwds) {
    const dir = memoryDirOf(cwd, home);
    if (existsSync(join(dir, "MEMORY.md"))) return dir;
  }
  return undefined;
}
