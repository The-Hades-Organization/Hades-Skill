import { readFileSync, writeFileSync } from "node:fs";
import { EXIT, warn } from "../lib/output.ts";

// O marcador final pode ser a última linha do arquivo, sem quebra depois.
const CONFLICT = /<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*(?:\n|$)/g;
const OPENERS = /[({[]/g;
const CLOSERS = /[)}\]]/g;

/** Abertos menos fechados do trecho: positivo = deixa bloco aberto. Contagem simples, sem ler string nem comentário. */
function openBalance(text: string): number {
  return (text.match(OPENERS)?.length ?? 0) - (text.match(CLOSERS)?.length ?? 0);
}

/**
 * Fechamento que o git deixou comum, logo depois do conflito: quando os dois lados terminam com o mesmo número de blocos
 * abertos, `ours + theirs` fecharia só o último e o primeiro ficaria aberto. As primeiras linhas depois do conflito que
 * fecham exatamente esse saldo (`  });`) valem para cada lado; o resto do arquivo segue como estava.
 */
function sharedClosing(ours: string, theirs: string, after: string): string {
  const open = openBalance(ours);
  if (open <= 0 || open !== openBalance(theirs)) return "";
  let balance = open;
  let closing = "";
  for (const line of after.split(/(?<=\n)/)) {
    closing += line;
    balance += openBalance(line);
    if (balance === 0) return closing;
    if (balance < 0) return "";
  }
  return "";
}

function resolve(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(CONFLICT)) {
    const [all, ours = "", theirs = ""] = match;
    const end = match.index + all.length;
    out += text.slice(last, match.index) + ours + sharedClosing(ours, theirs, text.slice(end)) + theirs;
    last = end;
  }
  return out + text.slice(last);
}

/** Resolve cada conflito de merge do arquivo mantendo os dois lados (o nosso e depois o deles). */
export function keepBothCommand(files: string[]): number {
  for (const file of files) {
    try {
      // o original lia em modo texto do Python: fim de linha CRLF/CR vira LF na releitura
      const text = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
      writeFileSync(file, resolve(text));
    } catch (error) {
      warn(`keep-both: ${file}: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT.fail;
    }
  }
  return EXIT.ok;
}
