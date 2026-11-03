// Notificações do Hades no desktop (notify-send, osascript no macOS) e no celular (ntfy), vigia persistente <HU>-notify
// (kit/notify.sh). A definição do serviço é regravada a cada apply pelo gerenciador de serviço (systemd: unit em
// ~/.config/systemd/user; launchd: plist); HADES_NOTIFY_UNIT troca o nome (testes).
import { join } from "node:path";
import { need } from "../lib/deps.ts";
import { stateDir } from "../lib/kit.ts";
import { Watcher } from "../lib/notify-watch.ts";
import { NotifyContext, notify, rotateTopic, status, topic } from "../lib/notify.ts";
import { EXIT, out, warn } from "../lib/output.ts";
import { pyDumps } from "../lib/pyjson.ts";
import { which } from "../lib/proc.ts";
import { serviceManager, type ServiceSpec } from "../lib/service-manager.ts";

export const USAGE = `Uso: notify.sh send <evento> <info|warn|error> <texto> [--obj NOME] [--state S]   (texto sem token, URL nem log)
     notify.sh test                  manda em todos os canais ligados (ignora switches de evento e silêncio)
     notify.sh apply                 liga/desliga o vigia conforme HADES_NOTIFY (o painel chama ao salvar)
     notify.sh restart|status|watch
     notify.sh topic [show|rotate]   tópico secreto do ntfy ($D/ntfy.topic, 600)`;

const SEND_USAGE = "Uso (pelo notify.sh): send <evento> <info|warn|error> <texto> [--obj NOME] [--state S] | test | watch";
const OK_CHANNELS = new Set(["ok", "desligado", "sem sessão", "ausente"]);
const RESTART_SEC = 10;

function spec(ctx: NotifyContext): ServiceSpec {
  const env = process.env;
  return {
    unit: ctx.unit,
    description: `Vigia de notificações do Hades${env.HADES_ID ? ` ${env.HADES_ID}` : ""}`,
    workdir: ctx.dir,
    env: [["PATH", env.PATH ?? ""], ["HADES_WT", env.HADES_WT ?? ""], ["HADES_DATA", ctx.dir], ["LOCKS", env.LOCKS ?? ""], ["HADES_NOTIFY_UNIT", ctx.unit], ["HADES_ID", env.HADES_ID ?? ""]],
    argv: [which("bash") ?? "bash", join(ctx.dir, "notify.sh"), "watch"],
    logFile: join(ctx.dir, "logs", "notify.log"),
    restart: "on-failure",
    restartSec: RESTART_SEC,
  };
}

function apply(ctx: NotifyContext): number {
  const manager = serviceManager();
  need(manager.requires);
  const changed = manager.write(spec(ctx));
  const unit = ctx.unit;
  if (process.env.HADES_NOTIFY === "1") {
    if (!manager.isEnabled(unit)) manager.enable(unit);
    if (changed && manager.isActive(unit)) manager.restart(unit);
    else manager.start(unit);
    if (process.env.HADES_NOTIFY_NTFY === "1") topic(ctx); // gera o tópico na primeira ativação
  } else {
    manager.disable(unit, true);
    manager.resetFailed(unit);
  }
  out(`vigia ${unit}: ${manager.activeState(unit)}`);
  return EXIT.ok;
}

async function send(ctx: NotifyContext, rest: string[]): Promise<number> {
  if (rest.length < 3) {
    warn(SEND_USAGE);
    return EXIT.fail;
  }
  let obj = "";
  let sig = "";
  const text: string[] = [];
  for (let i = 2; i < rest.length; ) {
    const arg = rest[i] as string;
    const value = rest[i + 1];
    if (arg === "--obj" && value !== undefined) [obj, i] = [value, i + 2];
    else if (arg === "--state" && value !== undefined) [sig, i] = [value, i + 2];
    else {
      text.push(arg);
      i += 1;
    }
  }
  out(pyDumps(await notify(ctx, rest[0] as string, rest[1] as string, text.join(" "), { obj, sig })));
  return EXIT.ok;
}

async function watch(ctx: NotifyContext): Promise<number> {
  // o vigia relê o config.env a cada ciclo: sem as chaves já exportadas pelo env.sh (que congelariam o valor)
  for (const key of Object.keys(process.env)) if (key.startsWith("HADES_NOTIFY_") && key !== "HADES_NOTIFY_UNIT") delete process.env[key];
  delete process.env.HADES_NOTIFY;
  const watcher = new Watcher(ctx);
  const stop = (): void => {
    watcher.stop();
    process.exit(EXIT.ok);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return watcher.loop();
}

export async function notifyCommand(args: string[]): Promise<number> {
  const [cmd = "", ...rest] = args;
  const ctx = new NotifyContext(stateDir());
  process.env.HADES_NOTIFY_UNIT = ctx.unit;
  switch (cmd) {
    case "send":
      return send(ctx, rest);
    case "test": {
      const result = await notify(ctx, "test", "info", "notificação de teste", { obj: "teste", test: true });
      out(pyDumps(result));
      return Object.values(result.channels ?? {}).every((v) => OK_CHANNELS.has(v)) ? EXIT.ok : EXIT.fail;
    }
    case "topic":
      out(rest[0] === "rotate" ? rotateTopic(ctx) : topic(ctx));
      return EXIT.ok;
    case "status": {
      const s = status(ctx, rest.includes("--reveal"));
      out(rest.includes("--json") ? pyDumps(s) : `vigia ${s.unit}: ${s.unitState} · desktop ${s.desktop ? "on" : "off"} · ntfy ${s.ntfy ? "on" : "off"} (${s.server})`);
      return EXIT.ok;
    }
    case "watch":
      return watch(ctx);
    case "apply":
      return apply(ctx);
    case "restart": {
      const manager = serviceManager();
      need(manager.requires);
      return manager.restart(ctx.unit);
    }
    default:
      out(USAGE);
      return EXIT.usage;
  }
}
