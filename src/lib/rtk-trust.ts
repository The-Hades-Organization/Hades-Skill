// Filtros do rtk gerados e ainda não confiados nas worktrees dos agentes (reference/rtk.md §Confiança). Só lê: o `rtk trust`
// é do dono e nunca roda aqui.
import { join } from "node:path";
import { HadesError } from "./output.ts";
import { isDir, readText } from "./fs.ts";
import { FILTERS_REL, GENERATED_MARK, type RtkBinary, rtkBinary, type TrustState, trustState } from "./rtk-filters.ts";
import { agentFiles, loadWorkEnv, readJson, type WorkEnv } from "./work.ts";

export const TRUST_SHOWN_MAX = 5;

export interface UntrustedWorktree {
  dir: string;
  state: "nao-confiado" | "alterado";
}

export interface TrustSummary {
  count: number;
  shown: UntrustedWorktree[];
  more: number;
}

/** Pastas de worktree do registro dos agentes (as `skill-dev` entram: o registro `_skill` é lido junto). */
export function agentWorktrees(work: Pick<WorkEnv, "orch" | "skillOrch" | "skillScope">): string[] {
  return agentFiles(work).flatMap((file) => {
    const dir = readJson(file)?.worktree;
    return typeof dir === "string" && dir !== "" ? [dir] : [];
  });
}

/** Worktrees do registro visto de `cwd` (clone ou worktree do projeto); fora de um repositório, não há registro e a lista é vazia. */
export function registeredWorktrees(cwd: string): string[] {
  try {
    return agentWorktrees(loadWorkEnv({ cwd, skillOk: true, skillForce: false }));
  } catch (error) {
    if (error instanceof HadesError) return [];
    throw error;
  }
}

/** Só o arquivo que a Hades gerou conta; filtro do dono (sem a marca) não é assunto dela. `stateOf` entra por parâmetro para o teste. */
export function untrustedWorktrees(
  dirs: string[],
  rtk: RtkBinary,
  stateOf: (dir: string) => TrustState = (dir) => trustState(dir, rtk),
): UntrustedWorktree[] {
  const found: UntrustedWorktree[] = [];
  for (const dir of new Set(dirs)) {
    if (!isDir(dir) || !(readText(join(dir, FILTERS_REL)) ?? "").startsWith(GENERATED_MARK)) continue;
    const state = stateOf(dir);
    if (state === "nao-confiado" || state === "alterado") found.push({ dir, state });
  }
  return found;
}

const SAFE_PATH = /^[A-Za-z0-9_./:@%+=,-]+$/;
const quote = (path: string): string => (SAFE_PATH.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`);

/** O que o dono cola no terminal para confiar uma worktree. */
export const trustCommand = (dir: string): string => `cd ${quote(dir)} && rtk trust`;

/**
 * Comando de start do dono (`! herdr agent start …`) com o `rtk trust` da worktree antes. Sem o prefixo `! ` o comando é
 * do orquestrador, que não pode confiar filtro (o hook barra): fica como veio.
 */
export function startWithTrust(start: string, dir: string, state: TrustState): string {
  if ((state !== "nao-confiado" && state !== "alterado") || !start.startsWith("! ")) return start;
  return `! (cd ${quote(dir)} && rtk trust) && ${start.slice(2)}`;
}

export function trustSummary(list: UntrustedWorktree[]): TrustSummary {
  return { count: list.length, shown: list.slice(0, TRUST_SHOWN_MAX), more: Math.max(0, list.length - TRUST_SHOWN_MAX) };
}

/** `startWithTrust` com a confiança lida do rtk desta máquina; sem rtk ou sem pasta, o comando fica como veio. */
export function startForWorktree(start: string, dir: string): string {
  const rtk = rtkBinary();
  if (!rtk || !dir || !isDir(dir) || !start.startsWith("! ")) return start;
  return startWithTrust(start, dir, trustState(dir, rtk));
}
