// Impeccable (https://github.com/pbakaus/impeccable): skill de design do dono, opcional. A Hades nunca a empacota nem a exige;
// só usa a que está instalada em ~/.claude/skills/impeccable (caminho por HOME) e degrada com aviso quando falta.
import { join } from "node:path";
import { readText } from "./fs.ts";
import { home } from "./paths.ts";

export const IMPECCABLE_URL = "https://github.com/pbakaus/impeccable";
export const IMPECCABLE_INSTALL = `instale a skill do Impeccable (${IMPECCABLE_URL}) em ~/.claude/skills/impeccable`;
export const IMPECCABLE_LOSS =
  "sem ele ficam de fora a auditoria de usabilidade do painel e a crítica de UI; as regras anti-slop do catálogo de qualidade seguem valendo";

export interface ImpeccableStatus {
  found: boolean;
  path: string;
  version: string;
}

/** Instalado = existe SKILL.md na pasta da skill; a versão sai do frontmatter. */
export function impeccableStatus(): ImpeccableStatus {
  const path = join(home(), ".claude", "skills", "impeccable");
  const text = readText(join(path, "SKILL.md"));
  if (text === undefined) return { found: false, path, version: "" };
  const version = /^version:\s*"?([^"\n]+)"?\s*$/m.exec(text.split(/\n---\n/)[0] ?? "")?.[1]?.trim() ?? "";
  return { found: true, path, version };
}
