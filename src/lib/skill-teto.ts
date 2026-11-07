import { statSync } from "node:fs";

/** Teto do SKILL.md em bytes: ele é carregado inteiro em cada `/hades`, então detalhe vai para `reference/`. */
export const TETO_SKILL_BYTES = 20480;

/** Tamanho do arquivo e se passa do teto (`limite` existe para o teste usar uma fixture). */
export function checaTeto(arquivo: string, limite: number = TETO_SKILL_BYTES): { bytes: number; limite: number; acima: boolean } {
  const bytes = statSync(arquivo).size;
  return { bytes, limite, acima: bytes > limite };
}
