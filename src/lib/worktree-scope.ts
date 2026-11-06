// Contenção de diretório por fronteira de componente: `/a/b` contém `/a/b/c` mas não `/a/bc`. Puro e leve de propósito,
// porque o hook (que roda a cada chamada de ferramenta) e o registro dos agentes usam a mesma regra.
import { resolve } from "node:path";

/** Caminho absoluto sem barra no fim (a raiz fica `/`). Vazio continua vazio: registro sem worktree não contém nada. */
export function normDir(path: string): string {
  return path === "" ? "" : resolve(path);
}

/** `child` é `parent` ou está abaixo dele, casando por componente de caminho e não por prefixo de texto. */
export function containsDir(parent: string, child: string): boolean {
  const p = normDir(parent);
  const c = normDir(child);
  if (p === "" || c === "") return false;
  return c === p || c.startsWith(p === "/" ? "/" : `${p}/`);
}

/** O candidato de caminho mais longo (o mais específico) entre os que contêm `child`; empate fica com o primeiro. */
export function mostSpecific<T>(child: string, candidates: readonly T[], pathOf: (candidate: T) => string): T | undefined {
  let best: T | undefined;
  let bestLength = -1;
  for (const candidate of candidates) {
    const path = normDir(pathOf(candidate));
    if (!containsDir(path, child) || path.length <= bestLength) continue;
    best = candidate;
    bestLength = path.length;
  }
  return best;
}

/** Os de `others` que ficam estritamente abaixo de `parent` (o mesmo caminho não conta: retomar a worktree é legítimo). */
export function nestedUnder(parent: string, others: readonly string[]): string[] {
  const p = normDir(parent);
  return others.filter((other) => normDir(other) !== p && containsDir(p, other));
}
