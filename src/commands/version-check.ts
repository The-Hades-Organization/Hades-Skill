// Checagem de versão do Hades pela linha de comando (hades version-check): status [--refresh] [--json] | doctor [--refresh].
import { join } from "node:path";
import { EXIT, out } from "../lib/output.ts";
import { findStateDir, kitDir } from "../lib/kit.ts";
import { pyDumps } from "../lib/pyjson.ts";
import { localVersion, refresh, settings, status } from "../lib/version-check.ts";

export const USAGE = `hades version-check status [--refresh] [--json]   estado (lê o cache; --refresh consulta a rede se o intervalo venceu)
     hades version-check doctor [--refresh]            uma linha \`local<TAB>remota<TAB>comando\` se há versão nova, senão nada`;

export async function versionCheckCommand(args: string[]): Promise<number> {
  const [sub] = args;
  if (sub !== "status" && sub !== "doctor") {
    process.stderr.write(`${USAGE}\n`);
    return EXIT.usage;
  }
  const dir = findStateDir() ?? kitDir();
  const cache = join(dir, "version-check.json");
  const cfg = settings();
  if (args.includes("--refresh")) await refresh(cfg, cache);
  const st = status(cfg, cache, localVersion(dir));
  if (sub === "doctor") {
    if (st.update) out(`${st.local}\t${st.remote}\t${st.command}`);
    return EXIT.ok;
  }
  if (args.includes("--json")) out(pyDumps(st));
  else if (st.update) out(`versão ${st.remote} disponível; você está na ${st.local}\n  ${st.command}`);
  return EXIT.ok;
}
