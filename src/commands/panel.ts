// Servidor do painel em TypeScript: `hades panel serve --port <porta>` (HADES_DATA = pasta de dados da instalação).
import { EXIT, die } from "../lib/output.ts";
import { startPanel } from "../panel/server.ts";

const DEFAULT_PORT = 21220;
const PORT_MAX = 65535;

export const USAGE = `Uso: hades panel serve [--port <porta>]   (HADES_DATA = pasta de dados; padrão 21220)
     hades panel service start|stop|restart|status|url|autostart   o painel como serviço do usuário (kit/panel.sh)
     hades panel dump <rota> [k=v ...]   o JSON de uma rota GET do painel, sem subir HTTP (rc 2 lista as rotas)
     hades panel action <id> [k=v ...] --json   lança a ação da rota POST /api/action, sem HTTP (rc 2 lista as ações)
     hades panel action --list --json   as ações com id, rótulo, ops e as que pedem confirmação`;

export async function panelCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "service") return (await import("./panel-service.ts")).panelServiceCommand(rest);
  if (sub === "dump") return dump(rest);
  if (sub === "action") return action(rest);
  if (sub !== "serve") {
    process.stderr.write(`${USAGE}\n`);
    return EXIT.usage;
  }
  const dir = process.env.HADES_DATA;
  if (!dir) die("HADES_DATA não definido: aponte para a pasta de dados do painel", EXIT.fail);
  const at = rest.indexOf("--port");
  const port = at >= 0 ? Number(rest[at + 1]) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > PORT_MAX) die(`porta inválida: ${rest[at + 1]}`, EXIT.usage);
  const panel = await startPanel(dir, port);
  process.stdout.write(`painel do Hades em http://127.0.0.1:${panel.port}\n`);
  // o servidor mantém o processo vivo; o SIGTERM do systemd o encerra
  process.on("SIGTERM", () => {
    panel.stop();
    process.exit(EXIT.ok);
  });
  return new Promise<number>(() => undefined);
}

async function dump(args: string[]): Promise<number> {
  const [route, ...query] = args;
  if (!route) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT.usage;
  }
  const dir = process.env.HADES_DATA;
  if (!dir) die("HADES_DATA não definido: aponte para a pasta de dados do painel", EXIT.fail);
  const { panelDump } = await import("../panel/dump.ts");
  const { rc, body } = await panelDump(dir, route, query);
  const text = typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`;
  process.stdout.write(text);
  return rc;
}

async function action(args: string[]): Promise<number> {
  const rest = args.filter((a) => a !== "--json");
  const [id, ...kv] = rest;
  if (!id) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT.usage;
  }
  const dir = process.env.HADES_DATA;
  if (!dir) die("HADES_DATA não definido: aponte para a pasta de dados do painel", EXIT.fail);
  const mod = await import("../panel/action-cli.ts");
  const { rc, body } = id === "--list" ? { rc: EXIT.ok, body: await mod.panelActionList(dir) } : await mod.panelAction(dir, id, kv);
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  return rc;
}
