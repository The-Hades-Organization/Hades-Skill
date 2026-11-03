// Grupo canvas-batch: ação em lote sobre a seleção (src/lib/canvas-batch.ts) — alvos e exclusões com motivo, texto do
// efeito, confirmação de ação destrutiva, pedidos por agente e resultado (ok, recusado, erro) a partir das respostas.
import { describe, expect, test } from "bun:test";
import type { ActionNode } from "../../../src/lib/canvas-actions";
import {
  BATCH_ACTIONS, BATCH_ERRORS, BATCH_MAX_TARGETS, batchRequests, planBatch, summarizeBatch, type BatchPlan,
} from "../../../src/lib/canvas-batch";
import { ACTION_NAMES } from "../../../src/panel/argos-actions";

const agent = (name: string, over: Partial<ActionNode> = {}): ActionNode => ({
  id: `agent:p:${name}`, type: "agent", label: name, state: "working", registryState: "active", herdrState: "working", pendingPermission: null, ...over,
});
const blocked = (name: string, tool: string | null = "Bash"): ActionNode => agent(name, { herdrState: "blocked", pendingPermission: { ts: "2026-11-02T10:00:00Z", tool } });
const ok = (id: string) => ({ id, status: 200, body: { v: 1, ok: true, node: id, action: "resume", output: "" } });
const refused = (id: string, status: number, code: string) => ({ id, status, body: { error: "recusado", code } });

describe("canvas-batch: alvos e exclusões", () => {
  test("dado lote misto, então os válidos viram alvo e os outros ficam de fora com o motivo", () => {
    const plan = planBatch([agent("a1"), agent("a2", { state: "done" }), { ...agent("p7"), id: "pr:p:7", type: "pr" }, agent("a3")], "resume");
    expect(plan.targets.map((t) => t.id)).toEqual(["agent:p:a1", "agent:p:a3"]);
    expect(plan.excluded.map((e) => [e.id, e.code])).toEqual([["agent:p:a2", "action_agent_closed"], ["pr:p:7", "action_not_agent"]]);
    expect(plan.excluded.every((e) => e.reason !== "")).toBe(true);
    expect(plan.problem).toBeUndefined();
  });

  test("dado aprovar em lote, então só entra quem tem pedido pendente que a rota aceita", () => {
    const plan = planBatch([blocked("a1"), agent("a2"), blocked("a3", "ExitPlanMode"), blocked("a4", "mcp__x__y")], "approve_permission");
    expect(plan.targets.map((t) => t.label)).toEqual(["a1", "a4"]);
    expect(plan.excluded.map((e) => [e.label, e.code])).toEqual([["a2", "action_no_pending_permission"], ["a3", "action_permission_not_supported"]]);
  });

  test("dado id repetido na seleção, então conta uma vez, na ordem em que apareceu", () => {
    const plan = planBatch([agent("b"), agent("a"), agent("b")], "resume");
    expect(plan.targets.map((t) => t.label)).toEqual(["b", "a"]);
  });

  test("dado lote em que ninguém serve, então o problema é nenhum alvo válido e as exclusões seguem", () => {
    const plan = planBatch([agent("a1", { state: "done" })], "resume");
    expect(plan.problem).toBe(BATCH_ERRORS.noValidTargets);
    expect(plan.excluded).toHaveLength(1);
    expect(batchRequests(plan)).toEqual({ ok: false, code: BATCH_ERRORS.noValidTargets });
  });

  test("dado seleção vazia, então o problema é seleção vazia", () => {
    expect(planBatch([], "resume").problem).toBe(BATCH_ERRORS.emptySelection);
  });

  test("dado seleção acima do teto, então o lote é recusado inteiro, sem truncar", () => {
    const many = Array.from({ length: BATCH_MAX_TARGETS + 1 }, (_, i) => agent(`a${i}`));
    const plan = planBatch(many, "resume");
    expect(plan.problem).toBe(BATCH_ERRORS.tooLarge);
    expect(plan.targets).toEqual([]);
    expect(planBatch(many.slice(0, BATCH_MAX_TARGETS), "resume").problem).toBeUndefined();
  });

  test("dado ação que pede algo por agente ou que não é de lote, então o problema é ação não suportada", () => {
    for (const action of ACTION_NAMES.filter((a) => !(BATCH_ACTIONS as readonly string[]).includes(a))) {
      expect(planBatch([agent("a1")], action, { reply: "x", question: "Q1", session: "s", text: "x", reason: "x" }).problem).toBe(BATCH_ERRORS.actionNotSupported);
    }
  });

  test("dado toda ação de lote, então ela existe na lista fechada da rota", () => {
    for (const action of BATCH_ACTIONS) expect(ACTION_NAMES).toContain(action);
  });

  test("dado mudar de fase sem a fase, então o problema é argumento faltando; com a fase, segue", () => {
    expect(planBatch([agent("a1")], "phase").problem).toBe(BATCH_ERRORS.missingArgs);
    expect(planBatch([agent("a1")], "phase", { phase: "  " }).problem).toBe(BATCH_ERRORS.missingArgs);
    expect(planBatch([agent("a1")], "phase", { phase: "review" }).problem).toBeUndefined();
  });

  test("dado a seleção recebida, então ela não é alterada", () => {
    const selection = [agent("a1"), agent("a2", { state: "done" })];
    const before = JSON.stringify(selection);
    planBatch(selection, "resume");
    expect(JSON.stringify(selection)).toBe(before);
  });
});

describe("canvas-batch: texto do efeito", () => {
  test("dado o lote, então o efeito diz a ação, a quantidade, os nomes e quantos ficaram de fora", () => {
    const plan = planBatch([agent("a1"), agent("a2"), agent("a3", { state: "done" })], "resume");
    expect(plan.effect).toBe("Retomar 2 agentes: a1, a2. 1 nó fica de fora.");
  });

  test("dado lote de um só, então o texto fica no singular", () => {
    expect(planBatch([agent("a1")], "resume").effect).toBe("Retomar 1 agente: a1.");
  });

  test("dado mais de dez alvos, então lista dez nomes e conta o resto", () => {
    const plan = planBatch(Array.from({ length: 13 }, (_, i) => agent(`a${i}`)), "resume");
    expect(plan.effect).toContain("a9 e mais 3.");
    expect(plan.effect).not.toContain("a10");
  });

  test("dado prompt em lote, então o efeito mostra o tamanho do texto e nunca o texto", () => {
    const plan = planBatch([agent("a1")], "prompt", { text: "segredo do dono" });
    expect(plan.effect).toContain("15 caracteres");
    expect(plan.effect).not.toContain("segredo");
  });

  test("dado mudar de fase, então o efeito cita a fase; encerrar vem marcado como destrutivo", () => {
    expect(planBatch([agent("a1")], "phase", { phase: "review" }).effect).toContain('"review"');
    expect(planBatch([agent("a1")], "done").effect).toContain("destrutivo");
  });
});

describe("canvas-batch: nada dispara sozinho", () => {
  test("dado lote seguro, então os pedidos saem na ordem do plano, um por alvo, sem confirm", () => {
    const plan = planBatch([agent("a1"), agent("a2")], "resume", { text: "siga" });
    expect(batchRequests(plan)).toEqual({
      ok: true,
      requests: [
        { node: "agent:p:a1", action: "resume", args: { text: "siga" } },
        { node: "agent:p:a2", action: "resume", args: { text: "siga" } },
      ],
    });
  });

  test("dado lote destrutivo, então sem a frase de confirmação não sai pedido nenhum", () => {
    const plan = planBatch([agent("a1"), agent("a2")], "done");
    expect(plan.dangerous).toBe(true);
    expect(plan.confirmPhrase).toBe("2");
    for (const typed of [undefined, "", "1", "3", "dois", "a1"]) expect(batchRequests(plan, typed)).toEqual({ ok: false, code: BATCH_ERRORS.confirmRequired });
  });

  test("dado a frase certa, então cada pedido leva o confirm do próprio agente", () => {
    const plan = planBatch([agent("a1"), agent("a2")], "done");
    expect(batchRequests(plan, " 2 ")).toEqual({
      ok: true,
      requests: [
        { node: "agent:p:a1", action: "done", args: {}, confirm: "a1" },
        { node: "agent:p:a2", action: "done", args: {}, confirm: "a2" },
      ],
    });
  });

  test("dado lote seguro, então não há frase de confirmação e dangerous é falso", () => {
    const plan = planBatch([agent("a1")], "approve_permission");
    expect(plan.dangerous).toBe(false);
    expect(plan.confirmPhrase).toBeUndefined();
  });

  test("dado lote com problema, então nenhuma frase o libera", () => {
    const plan = planBatch([agent("a1", { state: "done" })], "done");
    expect(batchRequests(plan, "1").ok).toBe(false);
  });

  test("dado plano forjado sem alvos válidos mas marcado destrutivo, então a confirmação ainda é exigida", () => {
    const forged: BatchPlan = { ...planBatch([agent("a1")], "done"), confirmPhrase: undefined as never };
    expect(batchRequests(forged, "1")).toEqual({ ok: false, code: BATCH_ERRORS.confirmRequired });
  });
});

describe("canvas-batch: resultado por agente", () => {
  const plan = planBatch([agent("a1"), agent("a2"), agent("a3"), agent("a4"), agent("a5"), agent("a6", { state: "done" })], "resume");

  test("dado ok, recusa 4xx com código e falhas, então cada agente cai em ok, recusado ou erro", () => {
    const result = summarizeBatch(plan, [
      ok("agent:p:a1"),
      refused("agent:p:a2", 409, "permission_not_pending"),
      refused("agent:p:a3", 504, "action_timeout"),
      { id: "agent:p:a4", status: 0 },
      { id: "agent:p:a5", status: 500, body: "<html>" },
    ]);
    expect(result.items.map((i) => [i.label, i.outcome, i.code])).toEqual([
      ["a1", "ok", undefined],
      ["a2", "refused", "permission_not_pending"],
      ["a3", "error", "action_timeout"],
      ["a4", "error", BATCH_ERRORS.noResponse],
      ["a5", "error", BATCH_ERRORS.unexpectedResponse],
    ]);
    expect(result.totals).toEqual({ ok: 1, refused: 1, error: 3, pending: 0 });
    expect(result.finished).toBe(true);
    expect(result.excluded.map((e) => e.label)).toEqual(["a6"]);
  });

  test("dado alvo sem resposta ainda, então fica pending e o lote não terminou", () => {
    const result = summarizeBatch(plan, [ok("agent:p:a1")]);
    expect(result.totals).toEqual({ ok: 1, refused: 0, error: 0, pending: 4 });
    expect(result.finished).toBe(false);
  });

  test("dado resposta de quem não é alvo, então é ignorada; duas respostas ao mesmo alvo valem pela última", () => {
    const result = summarizeBatch(plan, [ok("agent:p:zzz"), refused("agent:p:a1", 422, "action_failed"), ok("agent:p:a1")]);
    expect(result.items[0]?.outcome).toBe("ok");
    expect(result.items).toHaveLength(5);
  });

  test("dado 2xx sem ok verdadeiro ou 4xx sem código, então não conta como sucesso nem como recusa", () => {
    const result = summarizeBatch(plan, [
      { id: "agent:p:a1", status: 200, body: { ok: false } },
      { id: "agent:p:a2", status: 200, body: null },
      { id: "agent:p:a3", status: 404, body: { error: "x" } },
    ]);
    expect(result.items.slice(0, 3).map((i) => i.outcome)).toEqual(["error", "error", "error"]);
  });

  test("dado mensagem de erro longa, então vai cortada em 300 caracteres", () => {
    const result = summarizeBatch(plan, [{ id: "agent:p:a1", status: 422, body: { error: "x".repeat(900), code: "action_failed" } }]);
    expect(result.items[0]?.message?.length).toBe(300);
    expect(result.items[0]?.outcome).toBe("refused");
  });

  test("dado lote sem alvo, então o resultado é vazio e terminado", () => {
    const empty = summarizeBatch(planBatch([], "resume"), []);
    expect(empty.items).toEqual([]);
    expect(empty.finished).toBe(true);
  });
});
