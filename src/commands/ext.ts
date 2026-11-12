// `hades ext list|info|enable|disable|doctor [<nome>]` (reference/extensoes.md). Ler o manifesto não executa nada;
// só `info` e `doctor` rodam os comandos de versão e de saúde declarados, sem shell. Instalar é passo do dono: o
// comando de instalação sai como texto e nunca é executado.
import { ConfigError } from "../lib/config-catalog.ts";
import { EXIT, out, warn } from "../lib/output.ts";
import { loadManifests, realDeps, setEnabled, statusOf, writableStore, type ExtensionDeps, type ExtensionStatus, type LoadedExtension } from "../lib/extension.ts";
import { judgeExtension } from "../lib/doctor-ext.ts";

const USAGE = "ext list [--json] | info <nome> [--json] | enable <nome> | disable <nome> | doctor [<nome>] [--json]";
const JSON_VERSION = 1;

/** Códigos estáveis do que a CLI recusa (o `--json` os devolve; a mensagem é para o dono). */
export const EXT_CLI_ERRORS = { unknown: "ext.unknown", usage: "ext.usage", noInstance: "ext.no-instance", configInvalid: "ext.config-invalid" } as const;

function fail(code: string, message: string, json: boolean): number {
  if (json) out(JSON.stringify({ version: JSON_VERSION, ok: false, code, error: message }));
  else warn(message);
  return code === EXT_CLI_ERRORS.usage ? EXIT.usage : EXIT.fail;
}

function line(s: ExtensionStatus): string {
  const mark = !s.installed ? "-" : s.problems.length === 0 ? "✓" : "!";
  const parts = [s.installed ? `instalada${s.version === null ? "" : ` ${s.version}`}` : "não instalada", s.enabled ? "ligada" : "desligada"];
  return `${mark} ${s.name.padEnd(8)} ${parts.join(", ")}  ${s.description}`;
}

function info(s: ExtensionStatus): string[] {
  const rows = [
    `${s.name}: ${s.description}`,
    `  capacidades: ${s.capabilities.join(", ")}`,
    `  estado: ${s.enabled ? "ligada" : "desligada"} (${s.enableKey})`,
    `  binário: ${s.path ?? "não encontrado"}`,
    `  versão: ${s.version ?? "desconhecida"}${s.minVersion === null ? "" : ` (mínima ${s.minVersion})`}`,
    `  chaves: ${s.configKeys.join(", ") || "nenhuma"}`,
    `  instalar (passo seu, a Hades não executa): ${s.install}`,
  ];
  for (const p of s.problems) rows.push(`  problema [${p.code}]: ${p.message}`);
  return rows;
}

function select(all: LoadedExtension[], name: string | undefined): LoadedExtension[] | undefined {
  if (name === undefined) return all;
  const found = all.find((e) => e.manifest.name === name);
  return found === undefined ? undefined : [found];
}

export function extCommand(args: string[], deps: ExtensionDeps = realDeps()): number {
  const json = args.includes("--json");
  const [sub, ...rest] = args.filter((a) => a !== "--json");
  const name = rest[0];
  if (sub === undefined || rest.length > 1 || (["info", "enable", "disable"].includes(sub) && name === undefined)) {
    return fail(EXT_CLI_ERRORS.usage, `uso: hades ${USAGE}`, json);
  }
  const { extensions, broken } = loadManifests();
  for (const b of broken) warn(`manifesto de ${b.dir} inválido: ${b.errors.map((e) => `${e.field || "arquivo"} (${e.code})`).join("; ")}`);
  const chosen = select(extensions, name);
  if (chosen === undefined) return fail(EXT_CLI_ERRORS.unknown, `extensão desconhecida: ${name} (conhecidas: ${extensions.map((e) => e.manifest.name).join(", ")})`, json);
  if (sub === "list" || sub === "info" || sub === "doctor") {
    const statuses = chosen.map((e) => statusOf(e.manifest, deps));
    if (json) {
      out(JSON.stringify({ version: JSON_VERSION, extensions: statuses.map((s) => (sub === "doctor" ? { ...s, verdict: judgeExtension(s) } : s)) }));
    } else if (sub === "list") statuses.forEach((s) => out(line(s)));
    else if (sub === "info") statuses.forEach((s) => info(s).forEach((r) => out(r)));
    else statuses.forEach((s) => out(`${judgeExtension(s).level === "ok" ? "✓" : "!"} ${judgeExtension(s).msg}`));
    return sub === "doctor" && statuses.some((s) => s.enabled && s.installed && s.problems.length > 0) ? EXIT.fail : EXIT.ok;
  }
  if (sub === "enable" || sub === "disable") {
    const store = writableStore();
    if (store === undefined) return fail(EXT_CLI_ERRORS.noInstance, "sem instalação do Hades para gravar o estado: rode kit/install.sh (ou defina HADES_DATA)", json);
    const target = (chosen[0] as LoadedExtension).manifest;
    try {
      setEnabled(target, sub === "enable", store);
    } catch (error) {
      if (error instanceof ConfigError) return fail(EXT_CLI_ERRORS.configInvalid, error.message, json);
      throw error;
    }
    if (json) out(JSON.stringify({ version: JSON_VERSION, ok: true, name: target.name, enabled: sub === "enable" }));
    else out(`${target.name}: ${sub === "enable" ? "ligada" : "desligada"} (${target.enableKey})`);
    return EXIT.ok;
  }
  return fail(EXT_CLI_ERRORS.usage, `uso: hades ${USAGE}`, json);
}

export const extCommandEntry = (args: string[]): number => extCommand(args);
