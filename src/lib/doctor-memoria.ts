// Linha `memoria-indice` do doctor (reference/memory.md): higiene do índice MEMORY.md do projeto. Só lê; o `hades memory tidy` corrige.
import { LONG_LINE_CHARS, MEMORY_LOAD_LIMIT_BYTES, analyzeIndex, type MemoryProbe } from "./memory-index.ts";

export interface MemoriaItem {
  level: "ok" | "warn";
  msg: string;
  fix: string;
}

const kb = (bytes: number): string => (bytes / 1024).toFixed(1).replace(".", ",");
const FIX = "hades memory tidy --dry-run mostra o diff; com o ok, hades memory tidy --apply grava (reference/memory.md)";

export function doctorMemoriaItem(index: string | undefined, probe: MemoryProbe, now: Date): MemoriaItem {
  if (index === undefined) return { level: "ok", msg: "memoria: sem índice MEMORY.md neste projeto (nada a conferir)", fix: "" };
  const a = analyzeIndex(index, probe, now);
  const size = `memoria: índice ${kb(a.bytes)} KB de ${kb(MEMORY_LOAD_LIMIT_BYTES)} KB, ${a.lines} linha(s)`;
  const problems: string[] = [];
  if (a.overLimit) problems.push(`acima do limite de carregamento (${a.truncatedLines} linha(s) cortadas em silêncio)`);
  if (a.longLines.length > 0) problems.push(`${a.longLines.length} linha(s) acima de ${LONG_LINE_CHARS} caracteres`);
  if (a.duplicates.length > 0) problems.push(`${a.duplicates.length} duplicada(s)`);
  if (a.missing.length > 0) problems.push(`${a.missing.length} link(s) para arquivo inexistente`);
  if (a.closed.length > 0) problems.push(`${a.closed.length} entrada(s) com cara de histórico encerrado`);
  if (problems.length === 0) return { level: "ok", msg: `${size}, sem problemas`, fix: "" };
  return { level: "warn", msg: `${size}: ${problems.join("; ")}`, fix: FIX };
}
