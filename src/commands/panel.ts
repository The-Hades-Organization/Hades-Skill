// Servidor do painel em TypeScript: `hades panel serve --port <porta>` (HADES_DATA = pasta de dados da instalação).
import { EXIT, die } from "../lib/output.ts";
import { startPanel } from "../panel/server.ts";

const DEFAULT_PORT = 21220;
const PORT_MAX = 65535;

export const USAGE = `Uso: hades panel serve [--port <porta>]   (HADES_DATA = pasta de dados; padrão 21220)
     hades panel service start|stop|restart|status|url|autostart   o painel como serviço do usuário (kit/panel.sh)`;

export async function panelCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "service") return (await import("./panel-service.ts")).panelServiceCommand(rest);
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
