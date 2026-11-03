// Instâncias do Hades nesta máquina (reference/projects.md §Várias instâncias): ~/.claude/hades/instances/<projeto>
// guarda o $D de cada instalação e ~/.claude/hades/instance a padrão.
import { basename, join } from "node:path";
import { firstLine, isDir, isFile, listDir, readText, realpathMissingOk } from "./fs.ts";
import { hadesHome } from "./paths.ts";
import { instanceId } from "./config.ts";
import { packOf, resolveProject } from "./project.ts";

export interface InstanceRow {
  project: string;
  dir: string;
  id: string;
}

function isValid(dir: string): boolean {
  return dir !== "" && isFile(join(dir, "env.sh"));
}

function registeredFor(dir: string): string | undefined {
  const pack = packOf(resolveProject(dir));
  if (!pack) return undefined;
  const registered = firstLine(join(hadesHome(), "instances", basename(pack)));
  return isValid(registered) ? registered : undefined;
}

/** $D da instância do projeto do diretório; sem registro do projeto, a padrão; undefined se nenhuma tem env.sh. */
export function instanceFor(dir: string): string | undefined {
  const own = registeredFor(dir);
  if (own) return own;
  const fallback = firstLine(join(hadesHome(), "instance"));
  return isValid(fallback) ? fallback : undefined;
}

/** Cada instância registrada; a padrão sem registro de projeto (instalação anterior à 4.7.0) entra com o projeto do worktree. */
export function listInstances(): InstanceRow[] {
  const rows: InstanceRow[] = [];
  const seen = new Set<string>();
  const registry = join(hadesHome(), "instances");
  for (const name of listDir(registry)) {
    const file = join(registry, name);
    if (isDir(file) || !isFile(file)) continue;
    const dir = firstLine(file);
    seen.add(realpathMissingOk(dir));
    rows.push({ project: name, dir, id: instanceId(dir) });
  }
  const standard = firstLine(join(hadesHome(), "instance"));
  if (isValid(standard) && !seen.has(realpathMissingOk(standard))) {
    const worktree = /^W="([^"]*)"/m.exec(readText(join(standard, "env.sh")) ?? "")?.[1] ?? "";
    const pack = packOf(resolveProject(worktree || process.cwd()));
    rows.push({ project: pack ? basename(pack) : "default", dir: standard, id: instanceId(standard) });
  }
  return rows;
}

