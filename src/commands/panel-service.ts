// O painel como serviço do usuário: `hades panel service start|stop|restart|status|url|autostart` (kit/panel.sh é o wrapper).
// Fica FORA do slice do Hades: não conta no teto e continua no ar com o Hades pausado. A definição (unit do systemd ou
// plist do launchd) é regravada a cada start, com porta, PATH e caminhos de agora, para o início automático
// (HADES_PANEL_AUTOSTART: off | login | boot) subir o mesmo serviço que o start usa.
import { join } from "node:path";
import { unitPrefix } from "../lib/config.ts";
import { stateDir } from "../lib/kit.ts";
import { EXIT, out } from "../lib/output.ts";
import { home } from "../lib/paths.ts";
import { which } from "../lib/proc.ts";
import { serviceManager, type ServiceManager, type ServiceSpec } from "../lib/service-manager.ts";
import { lingerCommand, lingerState } from "./linger.ts";

export const USAGE = "uso: panel.sh start|stop|restart|status|url|autostart";

const DEFAULT_PORT = "21220";
const RESTART_SEC = 5;

interface PanelContext {
  manager: ServiceManager;
  unit: string;
  port: string;
  data: string;
}

function context(): PanelContext {
  const data = process.env.HADES_DATA || stateDir();
  return { manager: serviceManager(), unit: `${unitPrefix(data)}-panel`, port: process.env.HADES_PANEL_PORT || DEFAULT_PORT, data };
}

const urlOf = (ctx: PanelContext): string => `http://127.0.0.1:${ctx.port}`;

function spec(ctx: PanelContext): ServiceSpec {
  const env = process.env;
  // a CLI do painel (hades panel serve) vem da skill; o kit instalado ($D) não leva o src/
  const skill = env.HADES_SKILL_DIR || join(home(), ".claude", "skills", "hades");
  return {
    unit: ctx.unit,
    description: `Painel do Hades${env.HADES_ID ? ` ${env.HADES_ID}` : ""} (${urlOf(ctx)})`,
    workdir: ctx.data,
    // PATH completo: as ações chamam docker, git, gh, devtunnel e o node do nvm
    env: [["PATH", env.PATH ?? ""], ["HADES_WT", env.HADES_WT ?? ""], ["HADES_DATA", ctx.data], ["HADES_ID", env.HADES_ID ?? ""], ["HADES_KIT_DIR", ctx.data], ["HADES_SKILL_DIR", skill]],
    argv: [which("bash") ?? "bash", join(ctx.data, "hades-ts.sh"), "panel", "serve", "--port", ctx.port],
    logFile: join(ctx.data, "logs", "panel.log"),
    restart: "on-failure",
    restartSec: RESTART_SEC,
  };
}

/** Liga ou desliga o início automático conforme as Configurações e acerta o linger; false se o linger não ligou. */
function autostartSync(ctx: PanelContext): boolean {
  const { manager, unit } = ctx;
  if ((process.env.HADES_PANEL_AUTOSTART ?? "off") === "off") {
    if (manager.isEnabled(unit)) manager.disable(unit);
  } else if (!manager.isEnabled(unit)) manager.enable(unit);
  // linger sync: só desliga o que o Hades ligou e ninguém mais pede
  return lingerCommand(["sync"]) === EXIT.ok;
}

function autostartState(ctx: PanelContext): string {
  if (ctx.manager.enabledState(ctx.unit) !== "enabled") return "desligado";
  return lingerState() === "yes" ? "com a máquina (linger)" : "no login do usuário";
}

function start(ctx: PanelContext): number {
  const { manager, unit } = ctx;
  if (manager.isActive(unit)) {
    out(`já está no ar: ${urlOf(ctx)}`);
    return EXIT.ok;
  }
  manager.resetFailed(unit);
  manager.write(spec(ctx));
  autostartSync(ctx);
  const status = manager.start(unit);
  if (status === 0) out(`painel em ${urlOf(ctx)}`);
  return status;
}

function stop(ctx: PanelContext): number {
  const status = ctx.manager.stop(ctx.unit);
  ctx.manager.resetFailed(ctx.unit);
  return status;
}

export function panelServiceCommand(args: string[]): number {
  const verb = args[0] ?? "";
  if (!["start", "stop", "restart", "status", "url", "autostart"].includes(verb)) {
    out(USAGE);
    return EXIT.usage;
  }
  const ctx = context();
  switch (verb) {
    case "start":
      return start(ctx);
    case "stop":
      return stop(ctx);
    case "restart":
      stop(ctx);
      return start(ctx);
    case "autostart":
      ctx.manager.write(spec(ctx));
      autostartSync(ctx);
      out(`início automático (${process.env.HADES_PANEL_AUTOSTART ?? "off"}): ${autostartState(ctx)}`);
      return EXIT.ok;
    case "status":
      out(`${ctx.unit}: ${ctx.manager.activeState(ctx.unit)} ${urlOf(ctx)} · início automático: ${autostartState(ctx)}`);
      return EXIT.ok;
    default:
      out(urlOf(ctx));
      return EXIT.ok;
  }
}
