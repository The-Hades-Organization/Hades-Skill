// Defeito 3 do piloto #126: OOM do scope do worker e folga de memória do job.
import { describe, expect, test } from "bun:test";
import { journalOomLines, oomKillsOf, rcAfterOom } from "../../../src/lib/oom-scope.ts";
import { ProtocolError, validateJob, workerHeadroomGb } from "../../../src/lib/gate-remote/protocol.ts";

describe("oomKillsOf", () => {
  test("dado memory.events com oom_kill, então devolve o contador", () => {
    expect(oomKillsOf("low 0\nhigh 0\nmax 12\noom 3\noom_kill 2\n")).toBe(2);
  });
  test("dado sem oom_kill, vazio ou ausente, então 0", () => {
    expect(oomKillsOf("oom 0\noom_kill 0\n")).toBe(0);
    expect(oomKillsOf("")).toBe(0);
    expect(oomKillsOf(undefined)).toBe(0);
  });
});

describe("journalOomLines", () => {
  const log = [
    "nov 16 07:18:01 h systemd[1]: hades-gate-111-9.scope: A process of this unit has been killed by the OOM killer.",
    "nov 16 07:18:02 h systemd[1]: hades-gate-111-9.scope: Failed with result 'oom-kill'.",
    "nov 16 07:18:03 h systemd[1]: hades-gate-222-1.scope: Failed with result 'oom-kill'.",
  ].join("\n");
  test("dado o journal, então só as linhas de oom-kill do scope pedido", () => {
    expect(journalOomLines(log, "hades-gate-111-9")).toHaveLength(1);
    expect(journalOomLines(log, "hades-gate-333-3")).toEqual([]);
  });
});

describe("rcAfterOom", () => {
  test("dado oom no scope, então 130, 1 ou 127 viram 137", () => {
    for (const rc of [130, 1, 127]) expect(rcAfterOom(rc, true)).toBe(137);
  });
  test("dado 137 ou 143, então fica como veio", () => {
    expect(rcAfterOom(137, true)).toBe(137);
    expect(rcAfterOom(143, true)).toBe(143);
  });
  test("dado sem oom, ou rc 0, então não muda", () => {
    expect(rcAfterOom(130, false)).toBe(130);
    expect(rcAfterOom(0, true)).toBe(0);
  });
});

describe("workerHeadroomGb", () => {
  test("dado -1, então a folga é a do worker", () => {
    expect(workerHeadroomGb(-1, 3, 15)).toBeUndefined();
  });
  test("dado folga que cabe, então é a pedida", () => {
    expect(workerHeadroomGb(7, 3, 15.3)).toBe(7);
  });
  test("dado folga maior que a memória do worker, então é limitada (custo + folga + 1 GB ≤ total)", () => {
    expect(workerHeadroomGb(20, 3, 15.3)).toBe(11);
    expect(workerHeadroomGb(5, 14, 15)).toBe(0);
  });
});

describe("campo headroom do job", () => {
  const base = {
    v: 1, nonce: "a".repeat(32), id: "job-12345678", repo: "o__r", sha: "b".repeat(40), cwd: "/h/repo", subdir: "", kind: "build", label: "x",
    cost: 5, timeout: 60, priority: 0, step: "", stack: "", argv: ["true"], out: [], warmInline: false,
  };
  test("dado job sem headroom, então -1", () => {
    expect(validateJob({ ...base }, "/h").headroom).toBe(-1);
  });
  test("dado headroom inteiro, então é mantido; fora da faixa é recusado", () => {
    expect(validateJob({ ...base, headroom: 5 }, "/h").headroom).toBe(5);
    expect(() => validateJob({ ...base, headroom: 500 }, "/h")).toThrow(ProtocolError);
    expect(() => validateJob({ ...base, headroom: "5" }, "/h")).toThrow(ProtocolError);
  });
});
