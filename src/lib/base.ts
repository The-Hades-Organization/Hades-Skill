// Base da branch hades/local (hades_base do config.sh): branch.base do perfil > origin/<flow.base> > origin/develop.
import { selfCli } from "./paths.ts";
import { run } from "./proc.ts";

const DEFAULT_BASE = "origin/develop";

export function hadesBase(worktree: string): string {
  const get = (key: string): string => {
    const cli = selfCli("project", "get", key, "", "--dir", worktree);
    return run(cli.command, cli.args).stdout.replace(/\n+$/, "");
  };
  const branchBase = get("branch.base");
  if (branchBase) return branchBase;
  const flowBase = get("flow.base");
  return flowBase ? `origin/${flowBase}` : DEFAULT_BASE;
}
