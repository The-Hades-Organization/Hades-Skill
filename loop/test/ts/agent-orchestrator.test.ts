// O pane do orquestrador no registro do agente (src/lib/agent-registry.ts, callerPane/orchestratorField): quem chama
// `hades agent new|skill-new|review|adopt` de um pane do herdr fica gravado, e o Argos liga os dois (reference/argos.md
// §Orquestrador no canvas, Agentes alocados pela CLI).
import { describe, expect, test } from "bun:test";
import { callerPane, orchestratorField } from "../../../src/lib/agent-registry";

describe("orquestrador do agente alocado pela CLI", () => {
  test("dado pane e sessão fixa, então grava o par", () => {
    expect(callerPane({ HERDR_PANE_ID: "w1:p1", HADES_HERDR_SESSION: "s2" })).toEqual({ session: "s2", pane: "w1:p1" });
  });
  test("dado pane sem sessão nem socket, então a sessão é default", () => {
    expect(callerPane({ HERDR_PANE_ID: "w1:p1" })).toEqual({ session: "default", pane: "w1:p1" });
  });
  test("fora de pane, ou pane/sessão fora do formato, então nada", () => {
    expect(callerPane({})).toBeUndefined();
    expect(callerPane({ HERDR_PANE_ID: "../x" })).toBeUndefined();
    expect(callerPane({ HERDR_PANE_ID: "w1:p1", HADES_HERDR_SESSION: "a b" })).toBeUndefined();
  });
  test("dado o campo do registro, então só entra quando o pane de quem chama não é o do próprio agente", () => {
    expect(orchestratorField("w1:p2", { HERDR_PANE_ID: "w1:p1" })).toEqual({ orchestrator: { session: "default", pane: "w1:p1" } });
    expect(orchestratorField("w1:p1", { HERDR_PANE_ID: "w1:p1" })).toEqual({});
    expect(orchestratorField("w1:p2", {})).toEqual({});
  });
});
