// Grupo gate-admission: a regra de memória da fila não trava a cabeça quando nenhum gate está rodando.
import { describe, expect, test } from "bun:test";
import { admissionBlock, parseTicket, type GateLimits, type MachineState, type QueueEntry } from "../../../src/lib/gate.ts";

const LIMITS: GateLimits = { budgetGb: 8, heavyMax: 1, parLint: 0, parBuild: 0, projectBudgetGb: 0, reserveGb: 2, psiMax: 100 };
const LOW_MEMORY: MachineState = { legacyUsedGb: 0, legacyHeavy: 0, inWindow: true, window: "", availMb: 4200, psi: 0 };

const entry = (path: string, fields: string): QueueEntry => ({ path, ticket: parseTicket(fields) });
const mine = entry("2", "state=waiting\nkind=build\ncost=4\n");

describe("admissão por memória", () => {
  test("dada a máquina sem gates e pouca memória livre, quando a cabeça pede vez, então entra", () => {
    expect(admissionBlock([mine], mine, 4, false, LIMITS, LOW_MEMORY)).toBeNull();
  });

  test("dado outro gate rodando e pouca memória livre, quando a cabeça pede vez, então espera a memória", () => {
    const running = entry("1", "state=running\nkind=lint\ncost=2\n");
    expect(admissionBlock([running, mine], mine, 4, false, LIMITS, LOW_MEMORY)).toContain("MemAvailable");
  });

  test("dado gate antigo do protocolo v1 ocupando memória, quando a cabeça pede vez, então espera a memória", () => {
    const legacy = { ...LOW_MEMORY, legacyUsedGb: 2 };
    expect(admissionBlock([mine], mine, 4, false, LIMITS, legacy)).toContain("MemAvailable");
  });
});
