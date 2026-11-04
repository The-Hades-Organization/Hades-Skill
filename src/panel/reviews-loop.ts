// Rota do card "Loop de revisão" (página Revisões): o status do loop e as últimas rodadas, lidos de
// `<work>/review-loop/` (status.json e rounds.jsonl, gravados por `hades review --loop`). Só leitura.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDirFor } from "../commands/review-record.ts";
import { run } from "../lib/proc.ts";
import { loopRunning, readStatus } from "../lib/review-loop-store.ts";
import type { PanelEnv } from "./env.ts";

type Dict = Record<string, unknown>;

const ROUNDS_MAX = 20;
const GIT_TIMEOUT_MS = 10_000;
const GITHUB_REMOTE = /github\.com[:/]([^/]+)\/([^/.]+)/;
const isRecord = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

/** A rodada do `rounds.jsonl` pronta para a tela; linha cortada ou fora do formato é ignorada. */
export function roundView(line: string): Dict | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(line);
  } catch {
    return undefined; // última linha cortada por uma queda: o resto do arquivo segue valendo
  }
  if (!isRecord(doc) || typeof doc.id !== "string" || typeof doc.round !== "number" || typeof doc.startedAt !== "string") return undefined;
  const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    id: doc.id, round: doc.round, startedAt: doc.startedAt, outcome: typeof doc.outcome === "string" ? doc.outcome : "?",
    reviewed: count(doc.reviewed), skipped: count(doc.skipped), costUsd: num(doc.costUsd), tokens: num(doc.tokens),
    usage: isRecord(doc.usage) ? doc.usage : {},
  };
}

/** Status do loop do repositório do worktree e as últimas rodadas (mais recente primeiro). */
export function reviewsLoopOverview(worktree: string): Dict {
  const url = run("git", ["-C", worktree, "config", "--get", "remote.origin.url"], { timeoutMs: GIT_TIMEOUT_MS }).stdout.trim();
  const m = GITHUB_REMOTE.exec(url);
  const none: Dict = { active: false, status: null, rounds: [] };
  if (m === null) return none;
  const dir = join(dirname(stateDirFor(m[1] ?? "", m[2] ?? "")), "review-loop");
  if (!existsSync(dir)) return none;
  const status = readStatus(dir);
  const file = join(dir, "rounds.jsonl");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "") : [];
  const rounds = lines.slice(-ROUNDS_MAX * 2).flatMap((l): Dict[] => {
    const view = roundView(l);
    return view === undefined ? [] : [view];
  }).slice(-ROUNDS_MAX).reverse();
  const active = existsSync(join(dir, "loop.flock")) && loopRunning(dir);
  // o serializador do painel não descarta `undefined`: campo ausente vai como null
  const view = status === undefined ? null : { state: status.state, pid: status.pid, since: status.since, round: status.round, nextAt: status.nextAt ?? null, reason: status.reason ?? null };
  return { active, status: view, rounds };
}

export const createReviewsLoop = (env: PanelEnv): { overview(): Dict } => ({ overview: () => reviewsLoopOverview(env.worktree) });
