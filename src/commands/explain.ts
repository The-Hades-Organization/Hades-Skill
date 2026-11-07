// hades explain [<código>]: o que um erro quer dizer, por quê e o que fazer agora (reference/erros.md). Sem argumento lista
// os códigos que têm explicação; com um código desconhecido mostra o texto de fallback e sai com 1.
import { explain, knownCodes, renderEntry } from "../lib/human-errors.ts";
import { EXIT, out } from "../lib/output.ts";

const USAGE = "uso: hades explain [<código>]   (o código aparece entre parênteses no fim da mensagem de erro e no campo `code` do painel)";

export function explainCommand(args: string[]): number {
  const [code, ...extra] = args;
  if (code === "-h" || code === "--help" || extra.length > 0) {
    out(USAGE);
    return code === "-h" || code === "--help" ? EXIT.ok : EXIT.usage;
  }
  if (code === undefined) {
    out(`${USAGE}\n\nCódigos com explicação (${knownCodes().length}):`);
    for (const known of knownCodes()) out(`  ${known.padEnd(30)} ${explain(known).title}`);
    return EXIT.ok;
  }
  out(renderEntry(code));
  return explain(code).known ? EXIT.ok : EXIT.fail;
}
