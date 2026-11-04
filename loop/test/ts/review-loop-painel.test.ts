// Rota do card "Loop de revisão" (src/panel/reviews-loop.ts): status e rodadas lidos de <work>/review-loop/.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewsLoopOverview, roundView } from "../../../src/panel/reviews-loop.ts";
import { takeLoopLock, writeStatus } from "../../../src/lib/review-loop-store.ts";

const root = mkdtempSync(join(tmpdir(), "hades-review-loop-painel-"));
const envAntes = process.env.HADES_WORK_ROOT;
afterAll(() => {
  if (envAntes === undefined) delete process.env.HADES_WORK_ROOT;
  else process.env.HADES_WORK_ROOT = envAntes;
  rmSync(root, { recursive: true, force: true });
});

function repoComRemote(url: string): string {
  const dir = mkdtempSync(join(root, "clone-"));
  expect(Bun.spawnSync(["git", "-C", dir, "init", "-q"]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", url]).exitCode).toBe(0);
  return dir;
}

const round = (n: number, extra: object = {}): string => JSON.stringify({
  round: n, id: `id-${n}`, startedAt: "2026-11-04T12:00:00Z", endedAt: "2026-11-04T12:01:00Z", outcome: "revisada",
  reviewed: [{ pr: 7 }], skipped: [{ pr: 8 }, { pr: 9 }], costUsd: 0.5, tokens: 1500, usage: { five: { before: 10, after: 14 } }, ...extra,
});

describe("rota do loop de revisão no painel", () => {
  test("dado um repositório sem loop, quando a rota é lida, então vem inativa e sem rodadas", () => {
    process.env.HADES_WORK_ROOT = join(root, "work-vazio");
    expect(reviewsLoopOverview(repoComRemote("https://github.com/org/repo.git"))).toEqual({ active: false, status: null, rounds: [] });
  });

  test("dado remote que não é do GitHub, quando a rota é lida, então vem vazia sem erro", () => {
    expect(reviewsLoopOverview(repoComRemote("/tmp/qualquer.git"))).toEqual({ active: false, status: null, rounds: [] });
  });

  test("dado loop com rodadas e o lock tomado, quando a rota é lida, então traz o status, está ativo e as rodadas vêm da mais recente para a mais antiga", () => {
    process.env.HADES_WORK_ROOT = join(root, "work");
    const dir = join(root, "work", "org__repo", "review-loop");
    mkdirSync(dir, { recursive: true });
    writeStatus(dir, { state: "pausada", pid: 1, since: "2026-11-04T11:00:00Z", round: 2, nextAt: "2026-11-04T12:30:00Z", reason: "pausada" });
    writeFileSync(join(dir, "rounds.jsonl"), `${round(1)}\n${round(2, { outcome: "pausada", reviewed: [] })}\n{linha cortada`);
    expect(takeLoopLock(dir)).toBe(true);
    const v = reviewsLoopOverview(repoComRemote("git@github.com:org/repo.git"));
    expect(v.active).toBe(true);
    expect(v.status).toMatchObject({ state: "pausada", round: 2, nextAt: "2026-11-04T12:30:00Z" });
    expect((v.rounds as { round: number; reviewed: number; skipped: number }[]).map((r) => [r.round, r.reviewed, r.skipped])).toEqual([[2, 0, 2], [1, 1, 2]]);
    expect(JSON.stringify(v)).not.toContain("undefined");
    expect(JSON.parse(JSON.stringify(v)).status.reason).toBe("pausada");
    appendFileSync(join(dir, "rounds.jsonl"), "\n");
  });

  test("roundView descarta linha sem os campos da rodada", () => {
    expect(roundView("{}")).toBeUndefined();
    expect(roundView("nao json")).toBeUndefined();
    expect(roundView(round(3))).toMatchObject({ id: "id-3", reviewed: 1, tokens: 1500 });
  });
});
