// Orçamento de gate pela máquina: a admissão soma os gates vivos das outras filas; status e run avisam das outras filas.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_ENV, Rig } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const DEAD_PID = "2147483646";

function ticket(slug: string, name: string, state: string, pid: string, cost: number): void {
  const dir = join(r.T, "work", slug, "locks", "gate-queue");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.t`), `kind=build\nlabel=vizinho\ncost=${cost}\nheavy=0\npid=${pid}\nstate=${state}\nproject=${slug}\n`);
}
const gate = (args: string[], cwd = r.C) => r.hades(["gate-lock", ...args], { cwd, env: GATE_ENV });
const live = String(process.pid);

describe("gate-orcamento", () => {
  test("dado gate vivo em outra fila, quando a soma passa do orçamento, então a admissão recusa", () => {
    ticket("other__plain", "1-live", "running", live, 6);
    const p = gate(["run", "build", "--label", "soma", "--cost-gb", "3", "--timeout", "1", "--", "true"]);
    expect(p.rc).toBe(75);
    expect(p.err).toContain("orcamento: 6+3 GB > 8 GB");
  }, 30_000);

  test("dado gate vivo em outra fila, quando a soma cabe, então a admissão entra", () => {
    const p = gate(["run", "build", "--label", "cabe", "--cost-gb", "2", "--timeout", "30", "--", "true"]);
    expect(p.rc).toBe(0);
  });

  test("dado ticket morto ou não running em outra fila, então não conta", () => {
    ticket("other__plain", "1-live", "running", DEAD_PID, 6);
    ticket("other__plain", "2-wait", "waiting", live, 6);
    const p = gate(["run", "build", "--label", "morto", "--cost-gb", "3", "--timeout", "30", "--", "true"]);
    expect(p.rc).toBe(0);
    expect(gate(["status"]).out).not.toContain("outras filas");
  });

  test("dado gate vivo em outra fila, então o status mostra a linha e o slug", () => {
    ticket("other__plain", "1-live", "running", live, 6);
    expect(gate(["status"]).out).toContain("outras filas: 1 gates, 6 GB (other__plain: 1 gates, 6 GB)");
  });

  test("dado HADES_GATE_SCOPE=maquina, então as outras filas não entram na conta", () => {
    const p = r.hades(["gate-lock", "status"], { cwd: r.C, env: { ...GATE_ENV, HADES_GATE_SCOPE: "maquina" } });
    expect(p.out).not.toContain("outras filas");
  });

  test("dado repo aninhado com origin diferente, quando roda, então avisa a fila usada", () => {
    const nested = join(r.C, ".fixes", "b");
    r.mkrepo("other/nested", nested);
    const p = gate(["run", "lint", "--label", "aninhado", "--timeout", "30", "--", "true"], nested);
    expect(p.rc).toBe(0);
    expect(p.err).toContain("fila de other__nested, separada da de example__monorepo; o orçamento é somado entre as filas");
    expect(gate(["run", "lint", "--label", "raiz", "--timeout", "30", "--", "true"]).err).not.toContain("separada da de");
  });
});
