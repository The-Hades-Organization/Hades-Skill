// Conjunto de PRs do Hades ($D/prs.list), kit/prs.sh. Sem arquivo = "@me" (abertas não-draft do dono).
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, out } from "../lib/output.ts";
import { readText } from "../lib/fs.ts";
import { stateDir } from "../lib/kit.ts";
import { resolvePrSet } from "./pr-set.ts";

export const USAGE = `Conjunto de PRs do Hades ($D/prs.list). Sem arquivo = "@me" (abertas não-draft do dono).
  prs.sh show                 entradas + resolução (o que entraria agora, em ordem)
  prs.sh set 4937 4959 @me    substitui a lista (números, @me, author:<login>, -<n> para excluir)
  prs.sh add 5020 -4964       acrescenta entradas
  prs.sh remove 5020          tira entradas
  prs.sh reset                volta ao padrão (@me)
Depois de mudar: $D/update.sh para aplicar.`;
const OID_CHARS = 10;

/** Linhas do arquivo, como o grep as imprime: sem a quebra final, e cada uma com a sua quebra. */
function fileLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function show(list: string): number {
  const text = readText(list) ?? "";
  // `tr '\n' ' '` do original: cada entrada sai com um espaço depois, inclusive a última
  const entries = text.length
    ? fileLines(text)
        .filter((line) => !/^\s*#/.test(line))
        .map((line) => `${line} `)
        .join("")
    : "@me (padrão)";
  out(`entradas: ${entries}`);
  for (const row of resolvePrSet()) out(`  #${row.number} ${row.oid.slice(0, OID_CHARS)} base=${row.base} ${row.title}`);
  return EXIT.ok;
}

export function prsCommand(args: string[]): number {
  const list = join(stateDir(), "prs.list");
  const [sub = "", ...rest] = args;
  // printf '%s\n' "$@": sem argumentos escreve uma linha vazia
  const lines = rest.length ? rest.map((entry) => `${entry}\n`).join("") : "\n";
  switch (sub || "show") {
    case "show":
      return show(list);
    case "set":
      writeFileSync(list, lines);
      return show(list);
    case "add":
      appendFileSync(list, lines);
      return show(list);
    case "remove": {
      const text = readText(list);
      if (text !== undefined) {
        const gone = new Set(rest);
        writeFileSync(list, fileLines(text).filter((line) => !gone.has(line)).map((line) => `${line}\n`).join(""));
      }
      return show(list);
    }
    case "reset":
      rmSync(list, { force: true });
      return show(list);
    default:
      out(USAGE);
      return EXIT.usage;
  }
}
