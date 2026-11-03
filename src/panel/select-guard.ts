// Guarda do Select do painel (reference/panel.md §Select): nenhum select nativo em `kit/panel/ui/` fora de `vendor/`, exceto nos
// arquivos de SELECT_PENDING, que a migração esvazia.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Arquivos (relativos a `kit/panel/ui/`) que ainda têm o elemento nativo. Cada migração tira o seu daqui; a consolidação exige a
 * lista vazia (`SELECT_REQUIRE_EMPTY=1 bun test loop/test/ts/painel-select.test.ts`).
 */
export const SELECT_PENDING: readonly string[] = [];

const SOURCE = /\.(tsx|ts|js|html)$/;
/**
 * Busca de texto, sem ler comentário nem string: qualquer abertura do elemento conta onde estiver. Em comentário, escreva
 * "select nativo" em vez da tag.
 */
const NATIVE_SELECT = /<select\b/; // minúsculo: <Select é o componente do painel

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (name === "vendor") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(name)) out.push(full);
  }
}

/** Arquivos de `ui` (caminho relativo, com "/") que têm o elemento nativo. */
export function nativeSelectFiles(ui: string): string[] {
  if (!existsSync(ui)) return [];
  const files: string[] = [];
  walk(ui, files);
  return files
    .filter((f) => NATIVE_SELECT.test(readFileSync(f, "utf8")))
    .map((f) => relative(ui, f).split(sep).join("/"));
}

/** Problemas do Select em `ui` (vazio = ok). `pending` é a lista de arquivos que ainda podem ter o nativo. */
export function selectGuardProblems(ui: string, pending: readonly string[] = SELECT_PENDING, requireEmpty = false): string[] {
  const found = nativeSelectFiles(ui);
  const problems: string[] = [];
  for (const f of found) if (!pending.includes(f)) problems.push(`${f}: select nativo fora de SELECT_PENDING (use o Select do painel)`);
  for (const f of pending) if (!found.includes(f)) problems.push(`${f}: está em SELECT_PENDING mas não tem select nativo, tire da lista`);
  if (requireEmpty && pending.length > 0) problems.push(`SELECT_PENDING não está vazia (${pending.length} arquivo(s))`);
  return problems;
}
