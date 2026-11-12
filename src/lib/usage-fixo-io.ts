// Leitura de disco do contexto fixo: repositório da pasta da sessão, tamanho das partes e retratos diários dos tamanhos.
// A conta fica em usage-fixo.ts; aqui só entram o disco e o relógio, injetados por quem chama.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PARTS, type PartBytes, type PartsHistory } from "./usage-fixo.ts";

/** Quantos dias de retrato dos tamanhos ficam gravados (o doctor compara com 7 dias atrás). */
export const HISTORY_KEEP_DAYS = 30;
const MS_PER_DAY = 86_400_000;

const sizeOf = (path: string): number | undefined => {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
};

const textOf = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Repositório da pasta: a raiz do clone principal, mesmo para um worktree (o `.git` do worktree é um arquivo
 * `gitdir: <clone>/.git/worktrees/<nome>`). Sem git acima, o nome da própria pasta.
 */
export function repoOf(cwd: string): string {
  let dir = cwd.replace(/\/+$/, "") || "/";
  for (;;) {
    const marker = join(dir, ".git");
    try {
      const stat = statSync(marker);
      if (stat.isDirectory()) return dir.split("/").pop() || dir;
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(textOf(marker) ?? "")?.[1];
      const clone = pointer?.split("/.git/worktrees/")[0];
      return (clone ? clone : dir).split("/").pop() || dir;
    } catch {
      const up = dirname(dir);
      if (up === dir) return cwd.replace(/\/+$/, "").split("/").pop() || cwd;
      dir = up;
    }
  }
}

/** Pasta do projeto em `~/.claude/projects` para o cwd (a mesma regra de `newestTranscript`). */
const projectSlug = (cwd: string): string => cwd.replace(/\/+$/, "").replace(/[/.]/g, "-");

/**
 * Bytes em disco do que a sessão carrega de fixo: a cadeia de CLAUDE.md do cwd para cima (mais o do `~/.claude`), o
 * MEMORY.md do projeto, o SKILL.md da Hades (papéis que não são a sessão interativa) e o brief.md do agente. Parte ausente não entra.
 */
export function partsOf(cwd: string, role: string, home: string, skillDir: string): PartBytes | undefined {
  const parts: PartBytes = {};
  let claudeMd = sizeOf(join(home, ".claude", "CLAUDE.md")) ?? 0;
  for (let dir = cwd.replace(/\/+$/, "") || "/"; ; dir = dirname(dir)) {
    claudeMd += sizeOf(join(dir, "CLAUDE.md")) ?? 0;
    if (dirname(dir) === dir) break;
  }
  if (claudeMd > 0) parts.claudeMd = claudeMd;
  const memory = sizeOf(join(home, ".claude", "projects", projectSlug(cwd), "memory", "MEMORY.md"));
  if (memory !== undefined) parts.memory = memory;
  const skill = role === "interactive" ? undefined : sizeOf(join(skillDir, "SKILL.md"));
  if (skill !== undefined) parts.skill = skill;
  const brief = sizeOf(join(cwd, ".design-sync-reports", "brief.md"));
  if (brief !== undefined) parts.brief = brief;
  return Object.keys(parts).length > 0 ? parts : undefined;
}

/** Soma das partes de várias pastas (o retrato do dia). */
export function sumParts(list: PartBytes[]): PartBytes {
  const total: PartBytes = {};
  for (const one of list) for (const part of PARTS) if (one[part] !== undefined) total[part] = (total[part] ?? 0) + (one[part] as number);
  return total;
}

/** O arquivo de retratos; ausente ou fora do formato: sem histórico. */
export function readHistory(file: string): PartsHistory {
  const raw = textOf(file);
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as PartsHistory) : {};
  } catch {
    return {};
  }
}

/** Grava o retrato de `today` e descarta os mais velhos que `HISTORY_KEEP_DAYS`; devolve o histórico gravado. */
export function recordHistory(file: string, history: PartsHistory, today: string, snapshot: PartBytes): PartsHistory {
  const limit = Date.parse(`${today}T00:00:00Z`) - HISTORY_KEEP_DAYS * MS_PER_DAY;
  const kept = Object.fromEntries(Object.entries(history).filter(([day]) => Date.parse(`${day}T00:00:00Z`) >= limit));
  const next: PartsHistory = { ...kept, [today]: snapshot };
  writeFileSync(file, `${JSON.stringify(next)}\n`);
  return next;
}
