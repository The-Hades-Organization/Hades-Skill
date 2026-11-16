// Toolchain do usuário no PATH do worker. O ssh do `command="hades worker exec"` é não interativo: não lê .bashrc nem
// carrega o nvm, então node/npm ficam fora do PATH e o preparo falha só depois do código enviado. Aqui o PATH é montado
// de forma explícita (sem shell de login): ~/.local/bin, ~/.cargo/bin, ~/.bun/bin, nvm/fnm (versão do .nvmrc do repo ou a padrão) e os
// shims de volta/asdf/mise. A parte pura recebe um "fs" e é testável com uma árvore falsa.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { which } from "../proc.ts";

export const PATH_PREPEND_ENV = "HADES_WORKER_PATH_PREPEND";

const VERSION_PROBE_MS = 3000;
const TOOL_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export interface ToolchainFs {
  exists(path: string): boolean;
  list(dir: string): string[];
  read(path: string): string | undefined;
}

export const realFs: ToolchainFs = {
  exists: (path) => existsSync(path),
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
};

export interface ToolchainInput {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /** raiz do worktree do job: o `.nvmrc` dela escolhe a versão do nvm/fnm; undefined = a versão padrão */
  repoDir?: string;
  fs?: ToolchainFs;
}

const numeric = (version: string): number[] => version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);

function compareVersions(a: string, b: string): number {
  const x = numeric(a);
  const y = numeric(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Versão instalada que atende ao pedido (`22`, `22.22`, `v22.22.1`): a maior que casa por prefixo; undefined = nenhuma. */
export function matchVersion(installed: readonly string[], wanted: string): string | undefined {
  const bare = wanted.trim().replace(/^v/, "");
  if (!/^\d+(\.\d+){0,2}$/.test(bare)) return undefined;
  const hits = installed.filter((name) => {
    const v = name.replace(/^v/, "");
    return v === bare || v.startsWith(`${bare}.`);
  });
  return hits.sort(compareVersions).at(-1);
}

const highest = (installed: readonly string[]): string | undefined => installed.filter((n) => /^v?\d/.test(n)).sort(compareVersions).at(-1);

/** Versão de node a usar: `.nvmrc` do repo, depois o alias `default` do nvm, depois a maior instalada. */
function pickVersion(installed: readonly string[], wanted: string | undefined, fallbackWanted: string | undefined): string | undefined {
  for (const spec of [wanted, fallbackWanted]) {
    if (spec === undefined) continue;
    const hit = matchVersion(installed, spec);
    if (hit !== undefined) return hit;
  }
  return highest(installed);
}

const firstLine = (text: string | undefined): string | undefined => text?.split("\n")[0]?.trim() || undefined;

/** Diretórios `bin` da toolchain do usuário que existem nesta máquina, na ordem de precedência. */
export function toolchainDirs(input: ToolchainInput): string[] {
  const fs = input.fs ?? realFs;
  const { home, env } = input;
  const dirs: string[] = [];
  const add = (dir: string | undefined): void => {
    if (dir !== undefined && isAbsolute(dir) && fs.exists(dir) && !dirs.includes(dir)) dirs.push(dir);
  };

  for (const dir of (env[PATH_PREPEND_ENV] ?? "").split(delimiter)) add(dir);

  const nvmrc = input.repoDir === undefined ? undefined : firstLine(fs.read(join(input.repoDir, ".nvmrc")));
  const nvmDir = env.NVM_DIR || join(home, ".nvm");
  const nvmVersions = join(nvmDir, "versions", "node");
  const nvmInstalled = fs.list(nvmVersions);
  const nvmVersion = pickVersion(nvmInstalled, nvmrc, firstLine(fs.read(join(nvmDir, "alias", "default"))));
  if (nvmVersion !== undefined) add(join(nvmVersions, nvmVersion, "bin"));

  const fnmVersions = join(env.FNM_DIR || join(home, ".local", "share", "fnm"), "node-versions");
  const fnmVersion = pickVersion(fs.list(fnmVersions), nvmrc, undefined);
  if (fnmVersion !== undefined) add(join(fnmVersions, fnmVersion, "installation", "bin"));

  add(join(env.VOLTA_HOME || join(home, ".volta"), "bin"));
  add(join(env.ASDF_DATA_DIR || join(home, ".asdf"), "shims"));
  add(join(env.MISE_DATA_DIR || join(home, ".local", "share", "mise"), "shims"));
  add(join(home, ".cargo", "bin"));
  add(join(home, ".bun", "bin"));
  add(join(home, ".local", "bin"));
  return dirs;
}

/** PATH com a toolchain na frente do que o ssh já entregou; entrada repetida sai da cauda. */
export function pathWithToolchain(basePath: string, dirs: readonly string[]): string {
  const merged = [...dirs, ...basePath.split(delimiter).filter((p) => p !== "")];
  return merged.filter((p, i) => merged.indexOf(p) === i).join(delimiter);
}

/** Resultado de `status --json`: versão achada no PATH, ou null quando a ferramenta não está lá. */
export type ToolReport = Record<string, string | null>;

/** Procura cada ferramenta no PATH dado e lê a versão (`<tool> --version`, 3 s). Nome fora do padrão é ignorado. */
export function probeTools(names: readonly string[], pathVar: string): ToolReport {
  const report: ToolReport = {};
  for (const name of [...new Set(names)].filter((n) => TOOL_NAME.test(n))) {
    const found = which(name, pathVar);
    if (found === undefined) {
      report[name] = null;
      continue;
    }
    const r = spawnSync(found, ["--version"], { encoding: "utf8", timeout: VERSION_PROBE_MS, env: { ...process.env, PATH: pathVar } });
    report[name] = firstLine(r.stdout) ?? "";
  }
  return report;
}

/** Nomes ausentes de um relatório, na ordem de `required`. Chave que o worker não mediu não conta como ausente. */
export function missingTools(report: Readonly<ToolReport> | undefined, required: readonly string[]): string[] {
  if (report === undefined) return [];
  return required.filter((name) => report[name] === null);
}
