// `hades agent status --compact`: uma linha (nome herdr fase evento pr ctx custo) por agente, sem cabeçalho, para o orquestrador acompanhar sem abrir o pane.
// A parte pura (linha, formatos) não toca disco; os coletores leem o transcript e o diário do agente.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { contextOfDir } from "../lib/guard-hook.ts";
import { guardRules } from "../lib/guard-rules.ts";
import { home } from "../lib/paths.ts";
import { parseFileFull, transcriptsIn } from "../lib/usage.ts";

export interface CompactFields {
  name: string;
  /** estado do agente no herdr; "fora" quando ele não aparece lá */
  herdr: string;
  phase: string;
  /** último evento do diário já formatado (`lastEventLabel`); vazio sem diário */
  lastEvent: string;
  /** número da PR sem o "#"; vazio sem PR */
  pr: string;
  /** tokens do último turno */
  ctxTokens: number;
  /** dólares somados das transcrições do worktree */
  costUsd: number;
}

/** `123k`, `1.2M`; abaixo de mil, o número puro. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.max(0, Math.round(tokens)));
}

export const formatCost = (usd: number): string => `$${usd.toFixed(2)}`;

/** Um campo vazio vira "—": a linha tem sempre sete campos separados por espaço, parseável com split. */
const field = (text: string): string => text.trim().replace(/\s+/g, "_") || "—";

export function compactLine(f: CompactFields): string {
  return [field(f.name), field(f.herdr), field(f.phase), field(f.lastEvent), f.pr ? `#${f.pr}` : "—", formatTokens(f.ctxTokens), formatCost(f.costUsd)].join(" ");
}

/** `tool@5m`, `agent.end@2h`: o nome do evento (a ferramenta, quando há) e a idade, sem espaço. */
export function lastEventLabel(event: { ts: string; kind: string; tool?: string } | undefined, nowMs: number): string {
  if (!event) return "";
  const at = Date.parse(event.ts);
  const name = event.tool || event.kind;
  if (Number.isNaN(at)) return name;
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  const age = seconds < 90 ? `${seconds}s` : seconds < 5400 ? `${Math.round(seconds / 60)}m` : seconds < 129_600 ? `${Math.round(seconds / 3600)}h` : `${Math.round(seconds / 86_400)}d`;
  return `${name}@${age}`;
}

const TAIL_BYTES = 8192;

/** Última linha válida do diário do agente (`<raiz>/journal/<agente>.jsonl`); lê só o fim do arquivo. */
export function lastJournalEvent(journalDir: string, agent: string): { ts: string; kind: string; tool?: string } | undefined {
  const file = join(journalDir, `${agent}.jsonl`);
  let text: string;
  try {
    const size = statSync(file).size;
    const buffer = readFileSync(file);
    text = buffer.subarray(Math.max(0, size - TAIL_BYTES)).toString("utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const doc: unknown = JSON.parse(lines[i] ?? "");
      if (doc && typeof doc === "object" && typeof (doc as { ts?: unknown }).ts === "string") {
        const e = doc as { ts: string; kind?: unknown; tool?: unknown };
        return { ts: e.ts, kind: typeof e.kind === "string" ? e.kind : "evento", ...(typeof e.tool === "string" ? { tool: e.tool } : {}) };
      }
    } catch {
      // linha cortada pelo início da janela: tenta a anterior
    }
  }
  return undefined;
}

/** Custo (US$) de todas as transcrições do worktree, subagentes inclusive (estão dentro da pasta do projeto). */
export function costOfWorktree(worktree: string, h: string = home()): number {
  const project = join(h, ".claude", "projects", worktree.replace(/\/+$/, "").replace(/[/.]/g, "-"));
  try {
    readdirSync(project);
  } catch {
    return 0;
  }
  const rules = guardRules();
  let total = 0;
  for (const path of transcriptsIn(project)) for (const row of parseFileFull(path, rules).rows) total += row.cost;
  return total;
}

export function contextOfWorktree(worktree: string, h: string = home()): number {
  return worktree ? contextOfDir(worktree, h) : 0;
}
