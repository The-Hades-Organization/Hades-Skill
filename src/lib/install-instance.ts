// Instância do Hades nesta máquina (reference/projects.md §Várias instâncias): HADES_ID, portas do painel e do widget
// provadas por bind e registro em ~/.claude/hades/instances/<projeto> e instance.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { effective, save, ConfigError } from "./config-catalog.ts";
import { instanceId } from "./config.ts";
import { firstLine, isFile, listDir, readText, realpathMissingOk } from "./fs.ts";
import { EXIT, die } from "./output.ts";

const ID_FORMAT = /^[a-z0-9_]{0,24}$/;
const ID_MAX = 24;
const PANEL_PORT_FIRST = 21220;
const WIDGET_PORT_FIRST = 21221;
const PORT_SPAN = 200;
const BIND_HOSTS = ["0.0.0.0", "::"] as const;
/** bind que não prova nada: a máquina não tem o endereço ou a família */
const UNSUPPORTED_BIND = new Set(["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"]);

/** O nome do projeto como HADES_ID: minúsculo, [a-z0-9_] (byte a byte), até 24, sem `_` no fim. */
export function sanitizeId(name: string): string {
  const bytes = Buffer.from(name.replace(/[A-Z]/g, (c) => c.toLowerCase())).toString("latin1");
  return bytes.replace(/[^a-z0-9]/g, "_").slice(0, ID_MAX).replace(/_+$/, "");
}

/** $D das outras instâncias registradas (instance e instances/*) que ainda têm env.sh, sem repetir. */
export function otherInstances(registry: string, data: string): string[] {
  const self = realpathMissingOk(data);
  const files = [join(registry, "instance"), ...listDir(join(registry, "instances")).map((n) => join(registry, "instances", n))];
  const found = new Set<string>();
  for (const file of files) {
    if (!isFile(file)) continue;
    const dir = firstLine(file);
    if (dir !== "" && isFile(join(dir, "env.sh")) && realpathMissingOk(dir) !== self) found.add(dir);
  }
  return [...found].sort();
}

export interface IdContext {
  data: string;
  /** HADES_ID do ambiente: `undefined` = não definido (definido e vazio é uma escolha: a original) */
  envId: string | undefined;
  project: string;
  slug: string;
  others: string[];
  skipSystemd: boolean;
  say: (line: string) => void;
  sayErr: (line: string) => void;
}

/**
 * O HADES_ID do env.sh existente manda (sem a linha = a original); numa instalação nova, o do ambiente ou, havendo outra
 * instância registrada, o nome do projeto saneado. Decide antes de tocar o $D: divergência recusa (exit 1).
 */
export function resolveHadesId(ctx: IdContext): string {
  let id: string;
  if (isFile(join(ctx.data, "env.sh"))) {
    id = instanceId(ctx.data);
    if (ctx.envId !== undefined && ctx.envId !== id) {
      ctx.say(`HADES_ID=${ctx.envId} diverge do ${ctx.data}/env.sh (HADES_ID="${id}"): o nome das units e do slice vem dele; para trocar, pare a instância e edite o env.sh`);
      die("", EXIT.fail);
    }
  } else if (ctx.envId !== undefined) {
    id = ctx.envId;
  } else if (ctx.others.length > 0) {
    id = sanitizeId(ctx.project || ctx.slug.slice(ctx.slug.lastIndexOf("__") + 2));
    ctx.say(`instância a mais nesta máquina: HADES_ID=${id} (do nome do projeto; HADES_ID=<id> escolhe outro)`);
  } else {
    id = "";
  }
  if (!ID_FORMAT.test(id)) {
    ctx.say(`HADES_ID inválido: '${id}' (só [a-z0-9_], até 24 caracteres)`);
    die("", EXIT.fail);
  }
  for (const other of ctx.others) {
    if (instanceId(other) !== id) continue;
    if (!ctx.skipSystemd) {
      ctx.say(`HADES_ID="${id}" já é da instância ${other}: as units e o slice colidiriam; rode com HADES_ID=<outro>`);
      die("", EXIT.fail);
    }
    ctx.sayErr(`instância: HADES_ID="${id}" também é de ${other} (sem systemd aqui, segue)`);
  }
  return id;
}

/** Só a regressão define: portas em uso separadas por espaço, no lugar do bind (a máquina real não entra no teste). */
const BUSY_PORTS_ENV = "HADES_INSTALL_BUSY_PORTS";

/** Porta livre provada por tentativa de bind (qualquer endereço, v4 e v6): quem escuta em outro endereço também conta. */
export async function isPortFree(port: number): Promise<boolean> {
  const fake = process.env[BUSY_PORTS_ENV];
  if (fake !== undefined) return !fake.split(/\s+/).includes(String(port));
  for (const host of BIND_HOSTS) {
    const outcome = await new Promise<"free" | "busy" | "skip">((done) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => done(UNSUPPORTED_BIND.has(error.code ?? "") ? "skip" : "busy"));
      server.listen({ port, host, exclusive: true }, () => server.close(() => done("free")));
    });
    if (outcome === "busy") return false;
  }
  return true;
}

/** A primeira porta de [first, first+span) que não está em `taken` e passa no teste de bind. */
export async function pickPort(first: number, end: number, taken: ReadonlySet<number>, isFree: (port: number) => Promise<boolean> = isPortFree): Promise<number | undefined> {
  for (let port = first; port < end; port += 1) {
    if (!taken.has(port) && (await isFree(port))) return port;
  }
  return undefined;
}

export interface PortContext {
  data: string;
  kit: string;
  others: string[];
  say: (line: string) => void;
}

/** Valor efetivo de uma chave nas Configurações de uma instância; `fallback` se a instância não conhece a chave ou o catálogo não abre. */
function configValue(dir: string, kit: string, key: string, fallback: number): number {
  try {
    const value = effective({ dir, kit }).find((item) => item.key === key)?.value ?? "";
    const port = Number(value);
    return Number.isInteger(port) && port > 0 ? port : fallback;
  } catch (error) {
    if (error instanceof ConfigError || (error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

const hasLine = (text: string | undefined, prefix: string): boolean => (text ?? "").split("\n").some((l) => l.startsWith(prefix));
/** Escolha do dono (config.env) ou do plugin (config.tsv) vence: a porta só é atribuída quando nenhum dos dois a tem. */
const chosen = (data: string, key: string): boolean =>
  hasLine(readText(join(data, "config.env")), `${key}=`) || hasLine(readText(join(data, "plugin", "config.tsv")), `${key}\t`);

function gravar(ctx: PortContext, key: string, port: number): void {
  try {
    save({ dir: ctx.data, kit: ctx.kit }, { [key]: String(port) });
  } catch (error) {
    if (error instanceof ConfigError) die(`config set ${key}=${port}: ${error.message}`, EXIT.fail);
    throw error;
  }
}

/** Instância a mais sem porta de painel escolhida: a primeira livre a partir de 21220 que nenhuma outra instância usa. */
export async function assignPanelPort(ctx: PortContext): Promise<void> {
  if (chosen(ctx.data, "HADES_PANEL_PORT")) return;
  const taken = new Set(ctx.others.map((o) => configValue(o, ctx.kit, "HADES_PANEL_PORT", PANEL_PORT_FIRST)));
  const port = await pickPort(PANEL_PORT_FIRST, PANEL_PORT_FIRST + PORT_SPAN, taken);
  if (port === undefined) return;
  gravar(ctx, "HADES_PANEL_PORT", port);
  ctx.say(`porta do painel desta instância: ${port}`);
}

/** Porta do listener do widget: a primeira livre a partir de 21221, fora das portas de painel e de widget das outras instâncias e deste painel. */
export async function assignWidgetPort(ctx: PortContext): Promise<void> {
  if (chosen(ctx.data, "HADES_WIDGET_PORT")) return;
  const taken = new Set<number>();
  for (const other of ctx.others) {
    taken.add(configValue(other, ctx.kit, "HADES_PANEL_PORT", PANEL_PORT_FIRST));
    taken.add(configValue(other, ctx.kit, "HADES_WIDGET_PORT", WIDGET_PORT_FIRST));
  }
  taken.add(configValue(ctx.data, ctx.kit, "HADES_PANEL_PORT", PANEL_PORT_FIRST));
  const port = await pickPort(WIDGET_PORT_FIRST, WIDGET_PORT_FIRST + PORT_SPAN, taken);
  if (port === undefined) return;
  gravar(ctx, "HADES_WIDGET_PORT", port);
  ctx.say(`porta do widget desta instância: ${port}`);
}

/**
 * Registro das instâncias: instances/<projeto> (o `hades instance` acha o $D do projeto de qualquer clone) e instance, a
 * padrão da máquina, que só muda se ausente, inválida ou já esta.
 */
export function registerInstance(registry: string, data: string, project: string, say: (line: string) => void): void {
  mkdirSync(join(registry, "instances"), { recursive: true });
  const name = project || "default";
  const entry = join(registry, "instances", name);
  const current = firstLine(entry);
  const self = realpathMissingOk(data);
  if (current !== "" && isFile(join(current, "env.sh")) && realpathMissingOk(current) !== self) {
    say(`registro instances/${name} mantido em ${current} (outra instalação do mesmo projeto); esta fica fora do hades instance`);
  } else {
    writeFileSync(entry, `${data}\n`);
  }
  const standard = firstLine(join(registry, "instance"));
  if (standard === "" || !isFile(join(standard, "env.sh")) || realpathMissingOk(standard) === self) {
    writeFileSync(join(registry, "instance"), `${data}\n`);
  } else {
    say(`instância padrão da máquina segue ${standard}; esta: instances/${name}`);
  }
}
