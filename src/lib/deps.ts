// Registro único das dependências externas (src/deps/registry.tsv): detectar, mostrar o que falta e falhar cedo.
import { delimiter, join } from "node:path";
import { EXIT, die } from "./output.ts";
import { readText } from "./fs.ts";
import { run, which } from "./proc.ts";
import { home, skillRoot } from "./paths.ts";
import { managerKind } from "./service-manager.ts";

export type DepLevel = "error" | "warn";
export type DepPlatform = "linux" | "macos";

export interface Dependency {
  id: string;
  command: string;
  versionArgs: string[];
  level: DepLevel;
  doctor: "own" | "registry";
  install: string;
  purpose: string;
  /** vazio = vale em todos os sistemas */
  platform: DepPlatform | "";
}

export interface DepStatus extends Dependency {
  found: boolean;
  path: string | null;
  version: string | null;
}

export const REGISTRY_FILE = join(skillRoot, "src", "deps", "registry.tsv");
const VERSION_TIMEOUT_MS = 5000;

function parseLevel(value: string, line: string): DepLevel {
  if (value === "error" || value === "warn") return value;
  return die(`${REGISTRY_FILE}: nível '${value}' desconhecido em '${line}' (error|warn)`, EXIT.fail);
}

function parsePlatform(value: string, line: string): DepPlatform | "" {
  if (value === "linux" || value === "macos" || value === "") return value;
  return die(`${REGISTRY_FILE}: sistema '${value}' desconhecido em '${line}' (linux|macos)`, EXIT.fail);
}

/** O sistema do registro: acompanha o gerenciador de serviço, que HADES_SERVICE_MANAGER força nos testes. */
export const currentPlatform = (): DepPlatform => (managerKind() === "launchd" ? "macos" : "linux");

export function loadRegistry(file: string = REGISTRY_FILE): Dependency[] {
  const text = readText(file);
  if (text === undefined) return die(`registro de dependências ausente: ${file}`, EXIT.fail);
  const deps: Dependency[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [id = "", command = "", version = "", level = "", doctor = "", install = "", purpose = "", platform = ""] = line.split("\t");
    if (!id || !command) die(`${file}: linha malformada '${line}'`, EXIT.fail);
    deps.push({
      id,
      command,
      versionArgs: version ? version.split(" ") : [],
      level: parseLevel(level, line),
      doctor: doctor === "registry" ? "registry" : "own",
      install,
      purpose,
      platform: parsePlatform(platform, line),
    });
  }
  return deps;
}

/** O instalador oficial do Bun não mexe no PATH de quem já tem shell aberto: ~/.bun/bin também vale. */
function extraDir(dep: Dependency): string {
  return dep.id === "bun" ? join(home(), ".bun", "bin") : "";
}

export function detect(dep: Dependency, pathVar: string = process.env.PATH ?? ""): DepStatus {
  const path = which(dep.command, `${pathVar}${extraDir(dep) ? `${delimiter}${extraDir(dep)}` : ""}`) ?? null;
  let version: string | null = null;
  if (path && dep.versionArgs.length) {
    const r = run(path, dep.versionArgs, { timeoutMs: VERSION_TIMEOUT_MS });
    version = (r.stdout || r.stderr).split("\n", 1)[0]?.trim() || null;
  }
  return { ...dep, found: path !== null, path, version };
}

/** As dependências do sistema atual (as de outro sistema não entram na lista nem no que falta). */
export function checkAll(pathVar?: string): DepStatus[] {
  const here = currentPlatform();
  return loadRegistry().filter((dep) => dep.platform === "" || dep.platform === here).map((dep) => detect(dep, pathVar));
}

/** A mensagem de dependência ausente; a mesma do dep_need do lib.sh. */
export function missingMessage(dep: Dependency): string {
  return `dependência ausente: ${dep.id} (${dep.purpose}). Como instalar: ${dep.install}`;
}

/** Falha cedo (exit 69) com a instrução de instalar se a dependência não está no PATH. */
export function need(id: string, pathVar?: string): DepStatus {
  const dep = loadRegistry().find((d) => d.id === id);
  if (!dep) return die(`dependência '${id}' não está no registro (${REGISTRY_FILE})`, EXIT.fail);
  const status = detect(dep, pathVar);
  if (!status.found) die(missingMessage(dep), EXIT.missingDependency);
  return status;
}
