// Consumo destaca as sessões que passaram do teto de contexto do papel (campos aditivos: quem está dentro do teto não muda).
import { describe, expect, test } from "bun:test";
import { buildReport, byRoles, classify, plain, type Agent, type Row } from "../../../src/lib/usage";

const CAP = 200_000;
const capOf = (): number => CAP;
const NOW = "2026-01-02T00:00:00+00:00";
const noGit = (): undefined => undefined;

const row = (session: string, cwd: string, ctxMax: number, sidechain = false): Row => ({
  session, sidechain, day: "2026-01-01", cwd, cost: 1.5, turns: 4, poll_turns: 0, poll_cost: 0, rewrite_cost: 0, ctx_sum: ctxMax * 2,
  ctx_max: ctxMax, models: {}, efforts: {}, read: 0, write: 0, output: 0, first: "a", last: "b", tok: {},
});

const agents: Agent[] = [
  { name: "impl-a", role: "impl", worktree: "/w/a" },
  { name: "impl-b", role: "impl", worktree: "/w/b" },
];

const report = (rows: Row[], cap?: (role: string) => number) =>
  buildReport(rows, byRoles(rows, agents, noGit), 7, "2025-12-26", NOW, undefined, cap);

describe("consumo: sessões acima do teto de contexto", () => {
  test("dada sessão acima e outra exatamente no teto, então só a acima entra em overCap", () => {
    const out = report([row("s1", "/w/a", CAP + 1), row("s2", "/w/b", CAP)], capOf);
    const over = out.overCap as { cwd: string; ctxMax: number; ctxCap: number; role: string }[];
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ cwd: "/w/a", role: "impl", ctxMax: CAP + 1, ctxCap: CAP });
  });

  test("dado agente acima do teto, então a linha do agente leva ctxCap e overCap; o do teto fica sem os campos", () => {
    const out = report([row("s1", "/w/a", CAP + 1), row("s2", "/w/b", CAP)], capOf);
    const byName = Object.fromEntries((out.byAgent as { name: string }[]).map((a) => [a.name, a]));
    expect(byName["impl-a"]).toMatchObject({ ctxCap: CAP, overCap: true });
    expect(byName["impl-b"]).not.toHaveProperty("overCap");
    expect(byName["impl-b"]).not.toHaveProperty("ctxCap");
  });

  test("dado subagente acima do teto, então ele não entra em overCap nem ganha marca nas sessões", () => {
    const out = report([row("s1", "/w/a", CAP + 50_000, true)], capOf);
    expect(out).not.toHaveProperty("overCap");
    expect((out.topSessions as object[])[0]).not.toHaveProperty("overCap");
  });

  test("dadas várias sessões acima, então vêm ordenadas pelo excesso, a maior primeiro", () => {
    const out = report([row("s1", "/w/a", CAP + 10), row("s2", "/w/b", CAP + 90_000)], capOf);
    expect((out.overCap as { cwd: string }[]).map((s) => s.cwd)).toEqual(["/w/b", "/w/a"]);
  });

  test("dado teto por papel, então cada sessão é medida pelo teto do seu papel", () => {
    const perRole = (role: string): number => (role === "impl" ? 100_000 : 400_000);
    const out = report([row("s1", "/w/a", 150_000), row("s2", "/solto", 350_000)], perRole);
    expect((out.overCap as { cwd: string }[]).map((s) => s.cwd)).toEqual(["/w/a"]);
  });

  test("dado relatório sem capOf, então nada muda: sem overCap nem ctxCap", () => {
    const out = report([row("s1", "/w/a", CAP * 3)]);
    expect(out).not.toHaveProperty("overCap");
    expect((out.byAgent as object[])[0]).not.toHaveProperty("ctxCap");
  });

  test("dada sessão acima do teto, então a lista traz o custo arredondado da sessão", () => {
    const out = report([row("s1", "/w/a", CAP + 1)], capOf);
    expect(plain((out.overCap as { cost: unknown }[])[0]?.cost)).toBe(1.5);
  });
});

describe("classify: worktree mais específica", () => {
  test("dado registro pai e registro filho, então a sessão na pasta do filho é do filho", () => {
    const nested: Agent[] = [
      { name: "pai", role: "orchestrator", worktree: "/w" },
      { name: "filho", role: "impl", worktree: "/w/filho" },
    ];
    expect(classify("/w/filho/src", nested, noGit)).toMatchObject({ name: "filho", role: "impl" });
    expect(classify("/w/outra", nested, noGit)).toMatchObject({ name: "pai" });
  });

  test("dado prefixo de texto sem fronteira de diretório, então não casa", () => {
    expect(classify("/w/abc", [{ name: "a", worktree: "/w/ab" }], noGit).name).toBeNull();
  });
});
