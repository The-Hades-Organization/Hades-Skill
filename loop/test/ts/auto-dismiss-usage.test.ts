// Consumo: unidades reaproveitadas (mais de uma fase na sessão, ou sessão que seguiu depois do DONE) separadas das novas.
import { describe, expect, test } from "bun:test";
import { PyFloat } from "../../../src/lib/pyjson";
import { agentReused, buildReport, byRoles, type Agent, type Dict, type Row } from "../../../src/lib/usage";

const DONE_AT = "2026-03-10T12:00:00Z";
const BEFORE_DONE = "2026-03-10T11:00:00Z";
const AFTER_DONE = "2026-03-10T13:00:00Z";

const row = (cwd: string, session: string, last: string, cost = 1, turns = 2): Row => ({
  session, sidechain: false, day: last.slice(0, 10), cwd, cost, turns, poll_turns: 0, poll_cost: 0, rewrite_cost: 0, ctx_sum: 0, ctx_max: 0,
  models: {}, efforts: {}, read: 0, write: 0, output: 0, first: last, last, tok: {},
});
const agent = (name: string, extra: Agent = {}): Agent => ({ name, role: "impl", worktree: `/wt/${name}`, pr: null, ...extra });
const report = (rows: Row[], agents: Agent[]): Dict => buildReport(rows, byRoles(rows, agents, () => undefined), 7, "2026-03-04", "2026-03-10T14:00:00Z");
const plainNumber = (value: unknown): number => (value instanceof PyFloat ? value.value : Number(value));

describe("agentReused", () => {
  test("dado agente sem registro, então não é reaproveitado", () => {
    expect(agentReused(undefined, Date.parse(AFTER_DONE))).toBe(false);
  });
  test("dado clears maior que zero, então é reaproveitado", () => {
    expect(agentReused(agent("a", { clears: 1 }), 0)).toBe(true);
  });
  test("dado clears zero e sem doneAt, então é novo", () => {
    expect(agentReused(agent("a", { clears: 0 }), Date.parse(AFTER_DONE))).toBe(false);
  });
  test("dado reopenedAfterDone no registro, então é reaproveitado", () => {
    expect(agentReused(agent("a", { reopenedAfterDone: true, doneAt: DONE_AT }), Date.parse(BEFORE_DONE))).toBe(true);
  });
  test("dado atividade depois do doneAt, então é reaproveitado", () => {
    expect(agentReused(agent("a", { doneAt: DONE_AT }), Date.parse(AFTER_DONE))).toBe(true);
  });
  test("dado atividade no instante do doneAt ou antes, então é novo", () => {
    expect(agentReused(agent("a", { doneAt: DONE_AT }), Date.parse(DONE_AT))).toBe(false);
    expect(agentReused(agent("a", { doneAt: DONE_AT }), Date.parse(BEFORE_DONE))).toBe(false);
  });
  test("dado doneAt ilegível, então não conta como depois", () => {
    expect(agentReused(agent("a", { doneAt: "ontem" }), Date.parse(AFTER_DONE))).toBe(false);
  });
});

describe("buildReport: reuse", () => {
  test("dado nenhum agente nomeado, então o relatório não ganha o campo reuse", () => {
    expect(report([row("/outro", "s0", AFTER_DONE)], [])).not.toHaveProperty("reuse");
  });

  test("dado uma unidade reaproveitada e outra nova, então os turnos, o custo e as sessões saem separados", () => {
    const agents = [agent("velha", { doneAt: DONE_AT }), agent("nova")];
    const rows = [
      row("/wt/velha", "s1", BEFORE_DONE, 3, 5),
      row("/wt/velha", "s2", AFTER_DONE, 1, 2),
      row("/wt/nova", "s3", BEFORE_DONE, 2, 4),
    ];
    const { reuse, byAgent } = report(rows, agents) as { reuse: Record<"reused" | "fresh", Record<string, unknown>>; byAgent: Dict[] };
    expect(reuse.reused).toMatchObject({ units: 1, sessions: 2, turns: 7 });
    expect(plainNumber(reuse.reused.cost)).toBe(4);
    expect(reuse.fresh).toMatchObject({ units: 1, sessions: 1, turns: 4 });
    expect(plainNumber(reuse.fresh.cost)).toBe(2);
    expect(byAgent.find((a) => a.name === "velha")).toMatchObject({ reused: true, sessions: 2 });
    expect(byAgent.find((a) => a.name === "nova")).toMatchObject({ reused: false, sessions: 1 });
  });

  test("dado só unidades novas, então reused fica zerado e fresh leva tudo", () => {
    const { reuse } = report([row("/wt/a", "s1", BEFORE_DONE, 2, 3)], [agent("a")]) as { reuse: Record<string, Record<string, unknown>> };
    expect(reuse.reused).toMatchObject({ units: 0, sessions: 0, turns: 0 });
    expect(reuse.fresh).toMatchObject({ units: 1, sessions: 1, turns: 3 });
  });
});
