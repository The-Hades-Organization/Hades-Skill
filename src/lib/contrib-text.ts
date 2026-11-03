// Texto da contribuição (título, corpo da PR) montado dos campos que o dev informa e dos arquivos que entram.
import type { FileDiff, LeftOut } from "./contrib-diff.ts";

export interface Meta {
  title: string;
  what: string;
  why: string;
  gains: string;
  proof: string;
}

export const REQUIRED_META = ["title", "why", "gains", "proof"] as const;

/** Linhas de um campo de lista: uma por linha, sem o marcador `- ` que o dev já tenha posto. */
export function listItems(text: string): string[] {
  return text.split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
}

export function fileLine(f: FileDiff): string {
  return `\`${f.path}\` (+${f.plus} −${f.minus})`;
}

export function buildBody(meta: Meta, core: FileDiff[], left: LeftOut[]): string {
  const sections = [
    `## O que é\n\n${meta.what}`,
    `## Por quê\n\n${meta.why}`,
    `## Ganhos\n\n${listItems(meta.gains).map((g) => `- ${g}`).join("\n")}`,
    `## Prova\n\n${meta.proof}`,
    `## Arquivos\n\n${core.map((f) => `- ${fileLine(f)}`).join("\n")}`,
  ];
  if (left.length) {
    sections.push(`## Ficou de fora\n\nA mudança local tocou mais do que isto; o que segue não faz parte da contribuição.\n\n${left.map((l) => `- \`${l.path}\` — ${l.reason}`).join("\n")}`);
  }
  return `${sections.join("\n\n")}\n`;
}
