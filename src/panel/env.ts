// Ambiente do painel: pasta de dados ($D), worktree, instância e caminhos.
import { join } from "node:path";
import { instanceId, healthPaths } from "../lib/config.ts";
import { readText } from "../lib/fs.ts";
import { home } from "../lib/paths.ts";

const ENV_LINE = /^([A-Z_0-9]+)="([^"]*)"/;
const INSTANCE_ID = /^[a-z0-9_]{0,24}$/;

export interface PanelEnv {
  /** $D: a pasta de dados da instalação */
  dir: string;
  /** worktree do ambiente (HADES_WT no env.sh) */
  worktree: string;
  /** pasta da UI servida ($D/panel/ui) */
  ui: string;
  /** pasta do painel ($D/panel): remote.key e widget-token.json ficam nela */
  panelDir: string;
  /** a skill instalada: docs e scripts de loop/bin */
  skillDir: string;
  hu: string;
  /** HADES_ID da instância ("" na original) e os nomes derivados dela: slice, projeto compose, túnel */
  instanceId: string;
  slice: string;
  project: string;
  tunnelId: string;
  /** pasta de locks do ambiente (LOCKS no env.sh), se há */
  locks: string | undefined;
  nodeBin: string;
  cookie: string;
  health: Record<string, string>;
}

/** W, LOCKS, NODE_BIN… do env.sh instalado: só as atribuições `K="v"`. */
export function readEnvSh(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (readText(join(dir, "env.sh")) ?? "").split("\n")) {
    const m = ENV_LINE.exec(line);
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

export function panelEnv(dir: string): PanelEnv {
  const shEnv = readEnvSh(dir);
  let id = process.env.HADES_ID ?? instanceId(dir);
  if (!INSTANCE_ID.test(id)) id = id.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24);
  const hu = id ? `hds_${id}` : "hds";
  return {
    instanceId: id,
    slice: id ? `hades_${id}` : "hades",
    project: id ? `hades_${id}` : "hades",
    // o devtunnel não aceita "_"
    tunnelId: id ? `-${id.replaceAll("_", "-")}` : "",
    locks: shEnv.LOCKS || undefined,
    nodeBin: shEnv.NODE_BIN || "node",
    dir,
    worktree: shEnv.W || dir.slice(0, -"-data".length),
    ui: join(dir, "panel", "ui"),
    panelDir: join(dir, "panel"),
    skillDir: join(home(), ".claude", "skills", "hades"),
    hu,
    cookie: `${hu}_panel`,
    health: healthPaths(dir),
  };
}
