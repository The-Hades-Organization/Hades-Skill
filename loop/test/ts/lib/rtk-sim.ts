// Simulador do pipeline de filtro TOML do rtk 1.x (src/core/toml_filter.rs, apply_filter): strip_ansi, replace por linha,
// strip_lines_matching, truncate_lines_at, head/tail_lines, max_lines. Só as chaves que os filtros entregues usam; as demais
// o simulador recusa, para o teste não passar em silêncio com uma chave que ele não modela.
import type { FilterDef } from "../../../../src/lib/rtk-filters";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const MODELED = new Set(["description", "match_command", "strip_ansi", "replace", "strip_lines_matching", "head_lines", "tail_lines", "max_lines"]);

export interface Rule { pattern: string; replacement: string }
export const OMIT_NOTICE = /^\.\.\. \((\d+) lines (?:omitted|truncated)\)$/;

/** Regex do rtk (Rust) para JS: as sintaxes usadas pelos filtros entregues coincidem. */
const rx = (pattern: string): RegExp => new RegExp(pattern);

export function applyRtkFilter(def: FilterDef, output: string): string {
  for (const key of Object.keys(def)) if (!MODELED.has(key)) throw new Error(`o simulador não modela '${key}'`);
  let lines = output.split("\n");
  if (def.strip_ansi === true) lines = lines.map((l) => l.replace(ANSI, ""));
  for (const rule of (def.replace ?? []) as Rule[]) lines = lines.map((l) => l.replace(rx(rule.pattern), rule.replacement));
  const strip = ((def.strip_lines_matching ?? []) as string[]).map(rx);
  if (strip.length > 0) lines = lines.filter((l) => !strip.some((r) => r.test(l)));
  const head = def.head_lines as number | undefined;
  const tail = def.tail_lines as number | undefined;
  const total = lines.length;
  if (head !== undefined && tail !== undefined) {
    if (total > head + tail) lines = [...lines.slice(0, head), `... (${total - head - tail} lines omitted)`, ...lines.slice(total - tail)];
  } else if (head !== undefined) {
    if (total > head) lines = [...lines.slice(0, head), `... (${total - head} lines omitted)`];
  } else if (tail !== undefined && total > tail) {
    lines = [`... (${total - tail} lines omitted)`, ...lines.slice(total - tail)];
  }
  const max = def.max_lines as number | undefined;
  if (max !== undefined && lines.length > max) lines = [...lines.slice(0, max), `... (${lines.length - max} lines truncated)`];
  return lines.join("\n");
}

/** Nome de arquivo ou comando que o `match_command` do filtro casa (o rtk testa a regex no comando inteiro). */
export const matches = (def: FilterDef, command: string): boolean => rx(def.match_command as string).test(command);
