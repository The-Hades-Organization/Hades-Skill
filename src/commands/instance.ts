import { EXIT, out, warn } from "../lib/output.ts";
import { instanceFor, listInstances } from "../lib/instance.ts";

export const USAGE = `Instâncias do Hades nesta máquina (reference/projects.md §Várias instâncias). O install.sh registra cada $D em
~/.claude/hades/instances/<projeto> (\`default\` sem pacote) e a instância padrão em ~/.claude/hades/instance.
  hades instance [--dir <d>]   $D da instância do projeto do diretório (padrão: o atual); sem registro do projeto,
                                  a instância padrão. Sai 1 se nenhuma das duas tem env.sh
  hades instance list          projeto<TAB>$D<TAB>HADES_ID de cada instância registrada (a padrão sem registro de
                                  projeto, de instalação anterior à 4.7.0, entra com o projeto do worktree dela)`;

export function instanceCommand(args: string[]): number {
  const [sub, value] = args;
  if (sub === "list") {
    for (const row of listInstances()) out(`${row.project}\t${row.dir}\t${row.id}`);
    return EXIT.ok;
  }
  if (sub === undefined || sub === "" || sub === "--dir") {
    const dir = value || process.cwd();
    const found = instanceFor(dir);
    if (found) {
      out(found);
      return EXIT.ok;
    }
    warn(`nenhuma instância do Hades para ${dir}: HADES_WT=<worktree> <skill>/kit/install.sh`);
    return EXIT.fail;
  }
  process.stdout.write(`${USAGE}\n`);
  return EXIT.usage;
}

