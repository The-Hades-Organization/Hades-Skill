// Parte do install que fala com o gerenciador de serviço do usuário. No systemd: a slice, os timers e o vigia (cada script do
// $D regrava a própria unit), a migração do boot antigo, o linger e o restart do painel que já está no ar. No launchd: o timer da
// limpeza, o vigia e o restart do painel (slice e linger não existem lá; ADR 0003).
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, save } from "./config-catalog.ts";
import { home } from "./paths.ts";
import { mustStep, runStep, say } from "./install-io.ts";
import { die, EXIT } from "./output.ts";
import { need } from "./deps.ts";
import { serviceManager, type ServiceManager } from "./service-manager.ts";

export interface SystemdContext {
  data: string;
  kit: string;
  /** prefixo das units da instância (hds, hds_<id>) */
  unitPrefix: string;
}

function setSlice(ctx: SystemdContext, key: string, value: string): void {
  try {
    save({ dir: ctx.data, kit: ctx.kit }, { [key]: value });
  } catch (error) {
    if (error instanceof ConfigError) die(`config set ${key}=${value}: ${error.message}`, EXIT.fail);
    throw error;
  }
}

/** Slice, timers e vigia da instância; reinicia o painel só se já estava ativo (o install troca servidor e UI no disco). */
export function applySystemd(ctx: SystemdContext, env: NodeJS.ProcessEnv = process.env): void {
  const manager = serviceManager();
  need(manager.requires);
  if (manager.kind === "launchd") return applyLaunchd(ctx, manager);
  if (env.SLICE_MEMORY_MAX) setSlice(ctx, "HADES_SLICE_MAX", env.SLICE_MEMORY_MAX);
  if (env.SLICE_MEMORY_HIGH) setSlice(ctx, "HADES_SLICE_HIGH", env.SLICE_MEMORY_HIGH);
  mustStep("bash", [join(ctx.data, "config.sh"), "apply-slice"], { env: { D: ctx.data } });
  // timer da rotação de logs ($HU-logrotate): regravado com o intervalo das Configurações, ligado ou não por HADES_CLEAN_TIMER
  runStep("bash", [join(ctx.data, "clean.sh"), "apply"]);
  // vigia de notificações ($HU-notify): unit regravada com os caminhos desta instalação; liga ou desliga por HADES_NOTIFY
  runStep("bash", [join(ctx.data, "notify.sh"), "apply"]);
  retireBootUnit(ctx, env);
  runStep("bash", [join(ctx.data, "linger.sh"), "sync"]);
  restartPanelIfActive(ctx);
}

/** launchd: o timer da limpeza, o vigia de notificações (liga ou desliga por HADES_NOTIFY) e o painel que já estava no ar. */
function applyLaunchd(ctx: SystemdContext, manager: ServiceManager): void {
  runStep("bash", [join(ctx.data, "clean.sh"), "apply"]);
  runStep("bash", [join(ctx.data, "notify.sh"), "apply"]);
  restartPanelIfActive(ctx, manager);
}

function restartPanelIfActive(ctx: SystemdContext, manager: ServiceManager = serviceManager()): void {
  const unit = `${ctx.unitPrefix}-panel`;
  if (!manager.isActive(unit)) return;
  const restarted = runStep("bash", [join(ctx.data, "panel.sh"), "restart"], { quiet: true, quietErr: true }) === 0;
  say(restarted ? `painel ${unit} reiniciado (código novo no ar)` : `painel ${unit}: o restart falhou; rode ${ctx.data}/panel.sh restart`);
}

/** Migração: a subida completa com a máquina ($HU-boot) saiu; só o painel inicia sozinho. HADES_BOOT_UNIT só o teste troca. */
function retireBootUnit(ctx: SystemdContext, env: NodeJS.ProcessEnv): void {
  const unit = env.HADES_BOOT_UNIT || `${ctx.unitPrefix}-boot`;
  const dir = join(home(), ".config", "systemd", "user");
  if (!existsSync(join(dir, `${unit}.timer`)) && !existsSync(join(dir, `${unit}.service`))) return;
  runStep("systemctl", ["--user", "disable", "--now", `${unit}.timer`], { quiet: true, quietErr: true });
  rmSync(join(dir, `${unit}.timer`), { force: true });
  rmSync(join(dir, `${unit}.service`), { force: true });
  mustStep("systemctl", ["--user", "daemon-reload"]);
  say(`subida automática do Hades inteiro (${unit}) removida: só o painel inicia sozinho (HADES_PANEL_AUTOSTART); infra e serviços sobem pelo painel ou pelo run-hades`);
}
