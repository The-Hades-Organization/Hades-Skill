// Modelo real × configurado: a divergência e o custo dela, a sessão sem divergência, a escalada que não conta, o esforço
// que só entra quando observável, e a ordem de custo do settings-default vinda da tabela de preço.
import { describe, expect, test } from "bun:test";
import { MODEL_COST_ORDER, PRICE, tokCost } from "../../../src/lib/price";
import { costOf, MODEL_COST_ORDER as SETTINGS_ORDER } from "../../../src/lib/settings-default";
import { agentDivergence, dominantModel, firstDivergence, startedAfterEscalation } from "../../../src/lib/usage-model";
import { byRoles, buildReport, type Row, type Tok } from "../../../src/lib/usage";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MILLION = 1_000_000;
const row = (over: Partial<Row> & { tok: Record<string, Tok> }): Row => ({
  session: "s1", sidechain: false, day: "2026-11-01", cwd: "/wt/a", cost: 0, turns: 1, poll_turns: 0, poll_cost: 0, rewrite_cost: 0,
  ctx_sum: 0, ctx_max: 0, models: Object.fromEntries(Object.keys(over.tok).map((k) => [k, 1])), efforts: {}, read: 0, write: 0, output: 0,
  first: "2026-11-01T10:00:00Z", last: "2026-11-01T10:05:00Z", ...over,
});
const SONNET: Tok = [MILLION, 0, 0, 0];

describe("agentDivergence", () => {
  test("sessão em opus com o papel em sonnet: diverge, com o custo real menos o custo no modelo configurado", () => {
    const found = agentDivergence([row({ tok: { "opus-5-5": SONNET } })], undefined, { model: "claude-sonnet-5-5" });
    expect(found?.configured).toBe("sonnet-5-5");
    expect(found?.models).toEqual([{ real: "opus-5-5", turns: 1, extraCost: 2 }]);
    expect(found?.extraCost).toBeCloseTo(tokCost("opus-5-5", SONNET) - tokCost("sonnet-5-5", SONNET));
  });

  test("sessão no modelo configurado: sem divergência", () => {
    expect(agentDivergence([row({ tok: { "sonnet-5-5": SONNET } })], undefined, { model: "claude-sonnet-5-5" })).toBeUndefined();
  });

  test("apelido de família no papel (sonnet) vale como a versão mais nova", () => {
    expect(agentDivergence([row({ tok: { "sonnet-5-5": SONNET } })], undefined, { model: "sonnet" })).toBeUndefined();
    expect(agentDivergence([row({ tok: { "opus-5-5": SONNET } })], undefined, { model: "sonnet" })?.configured).toBe("sonnet-5-5");
  });

  test("papel sem modelo configurado ou com modelo fora da tabela: nada a comparar", () => {
    const rows = [row({ tok: { "opus-5-5": SONNET } })];
    expect(agentDivergence(rows, undefined, {})).toBeUndefined();
    expect(agentDivergence(rows, undefined, { model: "claude-desconhecido" })).toBeUndefined();
  });

  test("sessão aberta depois da escalada (escalatedAt) não conta; a anterior continua contando", () => {
    const record = { escalatedAt: "2026-11-01T12:00:00Z" };
    const before = row({ tok: { "opus-5-5": SONNET }, first: "2026-11-01T10:00:00Z" });
    const after = row({ session: "s2", tok: { "opus-5-5": SONNET }, first: "2026-11-01T12:30:00Z" });
    expect(agentDivergence([after], record, { model: "claude-sonnet-5-5" })).toBeUndefined();
    expect(agentDivergence([before, after], record, { model: "claude-sonnet-5-5" })?.models[0]?.turns).toBe(1);
    expect(startedAfterEscalation(record, after.first)).toBe(true);
    expect(startedAfterEscalation(undefined, after.first)).toBe(false);
  });

  test("subagente tem modelo próprio: fica fora da comparação", () => {
    expect(agentDivergence([row({ sidechain: true, tok: { "haiku-5-5": SONNET } })], undefined, { model: "claude-sonnet-5-5" })).toBeUndefined();
  });

  test("esforço não observável (transcrição sem o campo) não é divergência", () => {
    const rows = [row({ tok: { "sonnet-5-5": SONNET }, efforts: { "?": 1 } })];
    expect(agentDivergence(rows, undefined, { model: "claude-sonnet-5-5", effort: "medium" })).toBeUndefined();
  });

  test("esforço observável e diferente do configurado diverge, sem custo atribuído", () => {
    const rows = [row({ tok: { "sonnet-5-5": SONNET }, efforts: { high: 1 } })];
    const found = agentDivergence(rows, undefined, { model: "claude-sonnet-5-5", effort: "medium" });
    expect(found?.effort).toEqual({ real: "high", configured: "medium" });
    expect(found?.models).toEqual([]);
    expect(found?.extraCost).toBe(0);
  });

  test("dominantModel: o de mais turnos; vazio sem turnos", () => {
    expect(dominantModel({ "opus-5-5": 1, "sonnet-5-5": 3 })).toBe("sonnet-5-5");
    expect(dominantModel({})).toBe("");
  });
});

describe("byRoles e buildReport", () => {
  const agent = { name: "impl-a", role: "impl", worktree: "/wt/a", escalatedAt: "2026-11-01T12:00:00Z" };
  const rows = [row({ tok: { "opus-5-5": SONNET } }), row({ session: "s2", first: "2026-11-01T13:00:00Z", tok: { "opus-5-5": SONNET } })];

  test("o relatório do agente leva o modelo real e a divergência só da sessão anterior à escalada", () => {
    const roles = byRoles(rows, [agent], () => undefined, () => ({ model: "claude-sonnet-5-5" }));
    const [a] = buildReport(rows, roles, 7, "2026-11-01", "agora").byAgent as { model: string; divergence?: { models: { turns: number }[] } }[];
    expect(a?.model).toBe("opus-5-5");
    expect(a?.divergence?.models[0]?.turns).toBe(1);
  });

  test("sem leitor de configuração o agente não ganha divergência (relatório igual ao anterior)", () => {
    const roles = byRoles(rows, [agent], () => undefined);
    expect((buildReport(rows, roles, 7, "2026-11-01", "agora").byAgent as Record<string, unknown>[])[0]).not.toHaveProperty("divergence");
  });
});

describe("watch: primeiro turno divergente", () => {
  const dir = mkdtempSync(join(tmpdir(), "um-"));
  const turn = (model: string, timestamp: string) => JSON.stringify({ type: "assistant", timestamp, message: { model, usage: { input_tokens: 1 } } });
  const write = (name: string, lines: string[]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
    return join(dir, name);
  };

  test("devolve a sessão e o modelo real do primeiro turno fora do configurado", () => {
    const file = write("sess-1.jsonl", [turn("claude-sonnet-5-5", "2026-11-01T10:00:00Z"), turn("claude-opus-5-5", "2026-11-01T10:01:00Z")]);
    expect(firstDivergence(file, undefined, "claude-sonnet-5-5")).toEqual({ session: "sess-1", real: "opus-5-5" });
  });

  test("sessão toda no configurado, turno sintético ou sessão da escalada: nada", () => {
    expect(firstDivergence(write("sess-2.jsonl", [turn("claude-sonnet-5-5", "2026-11-01T10:00:00Z"), turn("<synthetic>", "2026-11-01T10:01:00Z")]), undefined, "claude-sonnet-5-5")).toBeUndefined();
    const escalated = write("sess-3.jsonl", [turn("claude-opus-5-5", "2026-11-01T13:00:00Z")]);
    expect(firstDivergence(escalated, { escalatedAt: "2026-11-01T12:00:00Z" }, "claude-sonnet-5-5")).toBeUndefined();
  });
});

describe("ordem de custo única", () => {
  test("a do settings-default é a da tabela de preço, do mais barato ao mais caro", () => {
    expect(SETTINGS_ORDER).toEqual(MODEL_COST_ORDER);
    expect(MODEL_COST_ORDER).toEqual(["haiku", "sonnet", "opus", "fable"]);
  });

  test("costOf segue a mesma ordem; toda família do preço entra nela", () => {
    expect(costOf("claude-haiku-5-5", "low")).toBeLessThan(costOf("claude-sonnet-5-5", "low"));
    expect(costOf("claude-opus-5-5", "max")).toBeLessThan(costOf("claude-fable-5-1", "low"));
    for (const key of Object.keys(PRICE)) expect(MODEL_COST_ORDER).toContain(key.split("-")[0] as string);
  });
});
