// Linger do systemd (user manager de pé sem login), do painel do Hades (kit/linger.sh). Precisa dele só o painel em modo
// boot (HADES_PANEL_AUTOSTART=boot). Uma marca só, $D/linger.mine: o Hades só desliga o linger que ele mesmo ligou, e só
// quando ninguém mais o pede. O launchd não tem linger: o agente do usuário sobe no login e `state` diz n/a.
import { appendFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { need } from "../lib/deps.ts";
import { EXIT, out } from "../lib/output.ts";
import { stateDir, runInherit } from "../lib/kit.ts";
import { run } from "../lib/proc.ts";
import { serviceManager } from "../lib/service-manager.ts";

export const USAGE = `Linger do systemd (user manager de pé sem login), do painel do Hades.
Precisa dele só o painel em modo boot (HADES_PANEL_AUTOSTART=boot). Uma marca só,
$D/linger.mine: o Hades só desliga o linger que ele mesmo ligou, e só quando ninguém mais o pede.
Uso: linger.sh sync|state
  sync    liga ou desliga conforme as Configurações (sai 1 se não conseguir ligar)
  state   yes | no`;

export const LINGER_NOT_APPLICABLE = "n/a";

/** yes | no | n/a (launchd). */
export function lingerState(): string {
  if (serviceManager().kind === "launchd") return LINGER_NOT_APPLICABLE;
  return run(process.env.HADES_LOGINCTL || "loginctl", ["show-user", process.env.USER ?? "", "-p", "Linger", "--value"]).stdout.replace(/\n+$/, "") === "yes" ? "yes" : "no";
}

export function lingerCommand(args: string[]): number {
  const kit = stateDir();
  const mine = join(kit, "linger.mine");
  const user = process.env.USER ?? "";
  // HADES_LOGINCTL: só o teste troca (loginctl falso); com ele o registro não confere o loginctl do sistema
  const loginctl = process.env.HADES_LOGINCTL || "loginctl";
  const needLoginctl = (): void => {
    if (!process.env.HADES_LOGINCTL) need("loginctl");
  };
  const legacyMark = join(kit, "panel-linger.mine"); // marca de antes da 3.6
  if (existsSync(legacyMark)) renameSync(legacyMark, mine);

  switch (args[0] ?? "") {
    case "state":
      out(lingerState());
      return EXIT.ok;
    case "sync":
      if (lingerState() === LINGER_NOT_APPLICABLE) return EXIT.ok;
      if (process.env.HADES_PANEL_AUTOSTART === "boot") {
        if (lingerState() === "yes") return EXIT.ok;
        needLoginctl();
        if (runInherit(loginctl, ["enable-linger", user]) === 0) {
          appendFileSync(mine, ""); // touch: cria sem truncar
          return EXIT.ok;
        }
        out(`não foi possível ligar o linger (loginctl enable-linger ${user}): o painel com a máquina fica só no login`);
        return EXIT.fail;
      }
      if (existsSync(mine)) {
        needLoginctl();
        const rc = runInherit(loginctl, ["disable-linger", user]);
        if (rc === 0) rmSync(mine, { force: true });
        return rc;
      }
      return EXIT.ok;
    default:
      out(USAGE);
      return EXIT.usage;
  }
}
