// `hades guard`: o hook da Hades (PreToolUse/PostToolUse) lendo o JSON do Claude Code no stdin; `guard context <cwd>`
// imprime o contexto atual da sessão mais recente do diretório (hades-watch); `guard register` grava o comando do hook no
// settings.json (o install.sh chama). Wrapper do hook: hades guard.
import { runHook } from "../lib/guard-hook-main.ts";
import { registerHook, shouldRegister } from "../lib/guard-register.ts";
import { EXIT, out, warn } from "../lib/output.ts";

function register(): number {
  if (!shouldRegister()) {
    out("hook: instalação descartável, settings.json do Claude Code intocado (HADES_CLAUDE_SETTINGS aponta outro arquivo)");
    return EXIT.ok;
  }
  const result = registerHook();
  if ("error" in result) {
    warn(`aviso: ${result.error}`);
    return EXIT.fail;
  }
  if (!result.changed) out(`hook: já registrado em ${result.file}`);
  else out(`hook: ${result.file} agora chama ${result.command} (${result.replaced} trocado, ${result.added} novo, ${result.removedDuplicates} duplicado removido)`);
  return EXIT.ok;
}

export function guardCommand(args: string[]): number | Promise<number> {
  return args[0] === "register" ? register() : runHook(args);
}
