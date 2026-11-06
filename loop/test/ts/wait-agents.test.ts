// `wait agents --any`: agrupamento, intervalo mínimo, timeout e dedupe, com relógio virtual e fonte roteirizada.
import { describe, expect, test } from "bun:test";
import { LineQueue, formatWake, gatherWake, readLastWake, type NextResult, type WakeClock, type WakeSource } from "../../../src/lib/wait-agents";

/** Fonte roteirizada: cada evento tem o instante (ms) em que chega; `next(t)` avança o relógio até a linha ou até o timeout. */
class Script implements WakeSource, WakeClock {
  t = 0;
  private readonly events: { at: number; line: string }[];
  private readonly endsAt: number | undefined;

  constructor(events: { at: number; line: string }[], endsAt?: number) {
    this.events = events;
    this.endsAt = endsAt;
  }

  now(): number {
    return this.t;
  }

  async next(timeoutMs: number): Promise<NextResult> {
    const deadline = this.t + timeoutMs;
    const event = this.events[0];
    if (event && event.at <= deadline) {
      this.events.shift();
      this.t = Math.max(this.t, event.at);
      return { kind: "line", line: event.line };
    }
    if (this.endsAt !== undefined && this.endsAt <= deadline) {
      this.t = Math.max(this.t, this.endsAt);
      return { kind: "end" };
    }
    this.t = deadline;
    return { kind: "timeout" };
  }
}

const base = { minIntervalS: 30, settleMs: 2000, maxMs: 3_600_000 };

describe("gatherWake", () => {
  test("dois eventos próximos viram um despertar só", async () => {
    const s = new Script([
      { at: 10_000, line: "DONE a" },
      { at: 11_200, line: "QUESTION b 1" },
    ]);
    const got = await gatherWake({ ...base, source: s, clock: s, lastWakeAt: undefined });
    expect(got).toEqual({ kind: "events", lines: ["DONE a", "QUESTION b 1"], wokeAt: 12_000 });
  });

  test("evento depois da folga fica para o próximo despertar", async () => {
    const s = new Script([
      { at: 10_000, line: "DONE a" },
      { at: 12_500, line: "DONE b" },
    ]);
    const got = await gatherWake({ ...base, source: s, clock: s, lastWakeAt: undefined });
    expect(got.kind === "events" && got.lines).toEqual(["DONE a"]);
  });

  test("respeita o intervalo mínimo desde o despertar anterior e junta o que chega nele", async () => {
    const s = new Script([
      { at: 5_000, line: "DONE a" },
      { at: 20_000, line: "BUDGET b 80" },
      { at: 40_000, line: "DONE c" },
    ]);
    const got = await gatherWake({ ...base, source: s, clock: s, lastWakeAt: 0 });
    expect(got).toEqual({ kind: "events", lines: ["DONE a", "BUDGET b 80"], wokeAt: 30_000 });
  });

  test("intervalo já vencido: vale só a folga", async () => {
    const s = new Script([{ at: 100_000, line: "DONE a" }]);
    const got = await gatherWake({ ...base, source: s, clock: s, lastWakeAt: 0 });
    expect(got).toEqual({ kind: "events", lines: ["DONE a"], wokeAt: 102_000 });
  });

  test("linha repetida entra uma vez; linha vazia some", async () => {
    const s = new Script([
      { at: 1000, line: "DONE a" },
      { at: 1100, line: "" },
      { at: 1200, line: "DONE a" },
      { at: 1300, line: "STALLED b 30" },
    ]);
    const got = await gatherWake({ ...base, source: s, clock: s, lastWakeAt: undefined });
    expect(got.kind === "events" && got.lines).toEqual(["DONE a", "STALLED b 30"]);
  });

  test("sem evento até o teto: timeout", async () => {
    const s = new Script([{ at: 9_999_999, line: "DONE a" }]);
    expect(await gatherWake({ ...base, source: s, clock: s, lastWakeAt: undefined, maxMs: 60_000 })).toEqual({ kind: "timeout" });
    expect(s.now()).toBe(60_000);
  });

  test("a fonte fecha sem evento: end; fecha depois do primeiro: entrega o que tem", async () => {
    const empty = new Script([], 5000);
    expect(await gatherWake({ ...base, source: empty, clock: empty, lastWakeAt: undefined })).toEqual({ kind: "end" });
    const partial = new Script([{ at: 1000, line: "DONE a" }], 1500);
    const got = await gatherWake({ ...base, source: partial, clock: partial, lastWakeAt: undefined });
    expect(got.kind === "events" && got.lines).toEqual(["DONE a"]);
  });
});

describe("formatWake", () => {
  test("AGENTS <n> e as linhas", () => {
    expect(formatWake(["DONE a", "QUESTION b 2"])).toEqual(["AGENTS 2", "DONE a", "QUESTION b 2"]);
  });
});

describe("LineQueue (fonte real, timers curtos)", () => {
  test("linhas completas entram; o resto espera o próximo pedaço", async () => {
    const q = new LineQueue();
    q.feed("DONE a\nQUEST");
    expect(await q.next(0)).toEqual({ kind: "line", line: "DONE a" });
    expect(await q.next(0)).toEqual({ kind: "timeout" });
    q.feed("ION b 1\n");
    expect(await q.next(50)).toEqual({ kind: "line", line: "QUESTION b 1" });
  });

  test("espera pendente acorda com a linha; timeout curto; close vira end", async () => {
    const q = new LineQueue();
    const pending = q.next(1000);
    q.feed("DONE a\n");
    expect(await pending).toEqual({ kind: "line", line: "DONE a" });
    expect(await q.next(10)).toEqual({ kind: "timeout" });
    const closing = q.next(1000);
    q.close();
    expect(await closing).toEqual({ kind: "end" });
    expect(await q.next(0)).toEqual({ kind: "end" });
  });
});

describe("readLastWake", () => {
  test("arquivo ausente ou lixo = nenhum despertar anterior", () => {
    expect(readLastWake("/nao/existe/wake.last")).toBeUndefined();
  });
});
