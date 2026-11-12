// Extensões: carrega os manifestos embutidos, detecta o binário e a versão e lê o estado ligado/desligado.
// Extensão não é plugin (reference/extensoes.md): é ferramenta externa da máquina, com binário próprio.
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { effective, save, type ConfigStore } from "./config-catalog.ts";
import { resolveHerdrBin } from "./config.ts";
import { findStateDir, kitDir } from "./kit.ts";
import { skillRoot } from "./paths.ts";
import { run, which, type RunResult } from "./proc.ts";
import { compareVersions, EXT_ERRORS, extractVersion, parseManifest, type ExtError, type ExtensionManifest } from "./extension-manifest.ts";

export const EXTENSIONS_DIR = join(skillRoot, "extensions");
const PROBE_TIMEOUT_MS = 5000;
const OFF = "0";
const ON = "1";

export interface ExtensionDeps {
  /** ligado/desligado e chaves próprias já resolvidos (ambiente > config.env > padrão) */
  config: ReadonlyMap<string, string>;
  which: (command: string) => string | undefined;
  run: (command: string, args: string[]) => RunResult;
}

export interface LoadedExtension {
  manifest: ExtensionManifest;
  dir: string;
}
export interface BrokenExtension {
  /** nome da pasta em extensions/ */
  dir: string;
  errors: ExtError[];
}
export interface LoadResult {
  extensions: LoadedExtension[];
  broken: BrokenExtension[];
}

/** Lê `extensions/<nome>/extension.json`. Só leitura e validação: nada do manifesto é executado. */
export function loadManifests(root: string = EXTENSIONS_DIR): LoadResult {
  const result: LoadResult = { extensions: [], broken: [] };
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const dir of dirs) {
    const file = join(root, dir, "extension.json");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      result.broken.push({ dir, errors: [{ code: EXT_ERRORS.notJson, field: "", message: missing ? "extension.json ausente" : "extension.json não é JSON válido" }] });
      continue;
    }
    const parsed = parseManifest(raw);
    if (!parsed.ok) result.broken.push({ dir, errors: parsed.errors });
    else if (parsed.manifest.name !== dir) {
      result.broken.push({ dir, errors: [{ code: EXT_ERRORS.nameMismatch, field: "name", message: `name '${parsed.manifest.name}' difere da pasta '${dir}'` }] });
    } else result.extensions.push({ manifest: parsed.manifest, dir: join(root, dir) });
  }
  return result;
}

export interface ExtensionStatus {
  name: string;
  description: string;
  capabilities: string[];
  enabled: boolean;
  installed: boolean;
  path: string | null;
  version: string | null;
  minVersion: string | null;
  /** vazio = saudável; cada item tem código estável e o campo do manifesto quando houver */
  problems: ExtError[];
  install: string;
  configKeys: string[];
  enableKey: string;
}

/** Ligada, salvo `0` explícito: quem não configurou nada continua com o comportamento de antes. */
export function isEnabled(manifest: ExtensionManifest, config: ReadonlyMap<string, string>): boolean {
  return config.get(manifest.enableKey) !== OFF;
}

interface Resolved {
  path?: string;
  /** a chave do binário aponta algo inválido: a mensagem diz o que corrigir */
  error?: string;
}

function resolveBinary(manifest: ExtensionManifest, deps: ExtensionDeps): Resolved {
  const configured = manifest.binary.configKey === null ? undefined : deps.config.get(manifest.binary.configKey);
  if (configured) {
    try {
      const resolved = resolveHerdrBin(configured);
      return { path: isAbsolute(resolved) ? resolved : deps.which(resolved) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  for (const name of manifest.binary.names) {
    const found = deps.which(name);
    if (found !== undefined) return { path: found };
  }
  return {};
}

/** Detecta o binário, mede a versão (só o comando de versão do manifesto) e confere o mínimo. */
export function statusOf(manifest: ExtensionManifest, deps: ExtensionDeps): ExtensionStatus {
  const problems: ExtError[] = [];
  const resolved = resolveBinary(manifest, deps);
  const path = resolved.path ?? null;
  let version: string | null = null;
  if (path === null) {
    problems.push({ code: EXT_ERRORS.binaryMissing, field: "binary.names", message: resolved.error ?? `binário não encontrado (${manifest.binary.names.join(", ")})` });
  } else if (manifest.version !== null) {
    const probe = deps.run(path, manifest.version.command.slice(1));
    version = probe.status === 0 ? (extractVersion(probe.stdout + probe.stderr) ?? null) : null;
    if (version === null) problems.push({ code: EXT_ERRORS.versionUnreadable, field: "version.command", message: "não consegui ler a versão do binário" });
    else if (compareVersions(version, manifest.version.min) < 0) {
      problems.push({ code: EXT_ERRORS.versionBelowMin, field: "version.min", message: `versão ${version} abaixo da mínima ${manifest.version.min}` });
    }
  }
  if (path !== null && manifest.health !== null && deps.run(path, manifest.health.command.slice(1)).status !== 0) {
    problems.push({ code: EXT_ERRORS.healthFailed, field: "health.command", message: "o comando de saúde falhou" });
  }
  return {
    name: manifest.name,
    description: manifest.description,
    capabilities: manifest.capabilities,
    enabled: isEnabled(manifest, deps.config),
    installed: path !== null,
    path,
    version,
    minVersion: manifest.version?.min ?? null,
    problems,
    install: manifest.install.text,
    configKeys: manifest.configKeys,
    enableKey: manifest.enableKey,
  };
}

function configStore(): ConfigStore {
  return { dir: findStateDir() ?? kitDir(), kit: kitDir() };
}

/** Configuração efetiva (ambiente > config.env > padrão do kit) das chaves que as extensões usam. */
export function readExtensionConfig(env: NodeJS.ProcessEnv = process.env, store: ConfigStore = configStore()): Map<string, string> {
  const values = new Map<string, string>();
  for (const item of effective(store)) values.set(item.key, env[item.key] ?? item.value);
  return values;
}

export function realDeps(env: NodeJS.ProcessEnv = process.env, store?: ConfigStore): ExtensionDeps {
  return {
    config: readExtensionConfig(env, store),
    which: (command) => which(command),
    run: (command, args) => run(command, args, { timeoutMs: PROBE_TIMEOUT_MS }),
  };
}

/** Grava o estado ligado/desligado em config.env (exige instalação: nunca grava dentro da skill). */
export function setEnabled(manifest: ExtensionManifest, enabled: boolean, store: ConfigStore): void {
  save(store, { [manifest.enableKey]: enabled ? ON : OFF });
}

export function writableStore(): ConfigStore | undefined {
  const dir = findStateDir();
  return dir === undefined ? undefined : { dir, kit: kitDir() };
}

/** A extensão `name` está ligada? Extensão desconhecida conta como desligada. Consulta barata para as superfícies. */
export function extensionEnabled(name: string, config: ReadonlyMap<string, string> = readExtensionConfig(), root: string = EXTENSIONS_DIR): boolean {
  const found = loadManifests(root).extensions.find((e) => e.manifest.name === name);
  return found !== undefined && isEnabled(found.manifest, config);
}
