// O nó do agente no Argos marca a sessão que roda num modelo diferente do configurado para o papel.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodeIndicators } from "../../../src/lib/canvas-argos";
import { createGraph, registriesOf } from "../../../src/panel/argos-graph";

const agent = { type: "agent", state: "working" };

describe("argos: indicador de modelo", () => {
  test("com divergência o nó ganha o indicador, com o real e o configurado no rótulo", () => {
    const found = nodeIndicators({ ...agent, modelMismatch: { real: "opus-5-5", configured: "sonnet-5-5" } }).find((i) => i.kind === "model");
    expect(found).toMatchObject({ tone: "warn", short: "opus-5-5", label: "Modelo opus-5-5, diferente do configurado para o papel (sonnet-5-5)" });
  });

  test("sem divergência (campo ausente ou nulo) o nó não ganha indicador", () => {
    expect(nodeIndicators(agent).some((i) => i.kind === "model")).toBe(false);
    expect(nodeIndicators({ ...agent, modelMismatch: null }).some((i) => i.kind === "model")).toBe(false);
  });
});

describe("argos: modelMismatch no nó do agente", () => {
  const T = mkdtempSync(join(tmpdir(), "argos-modelo-"));
  const previousHome = process.env.HOME;
  process.env.HOME = join(T, "home");
  afterAll(() => {
    process.env.HOME = previousHome;
    rmSync(T, { recursive: true, force: true });
  });
  const root = join(T, "work");
  const herdr = { cached: async (_key: string, load: () => Promise<unknown>) => load(), json: async () => null } as unknown as Parameters<typeof createGraph>[0]["herdr"];
  const register = (name: string, model: string, fields: Record<string, unknown> = {}): void => {
    const worktree = join(T, "wt", name);
    const file = join(root, "_skill/orchestration/agents", `${name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ name, mode: "deliver", role: "impl", state: "working", worktree, ...fields }));
    const project = join(process.env.HOME as string, ".claude/projects", worktree.replace(/[/.]/g, "-"));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "s.jsonl"), `${JSON.stringify({ type: "assistant", timestamp: "2026-11-01T10:00:00Z", message: { model, usage: { input_tokens: 1 } } })}\n`);
  };
  register("diverge", "claude-opus-5-5");
  register("certo", "claude-sonnet-5-5");
  register("escalado", "claude-opus-5-5", { escalatedAt: "2026-11-01T09:00:00Z" });
  register("encerrado", "claude-opus-5-5", { state: "done" });
  const build = (extra: Record<string, unknown>) =>
    createGraph({ registries: () => registriesOf(undefined, root), journalRoot: () => root, herdr, gates: () => [], reportsDir: () => ".design-sync-reports", ...extra } as Parameters<typeof createGraph>[0]);
  const nodes = async (extra: Record<string, unknown>): Promise<Record<string, Record<string, unknown>>> =>
    Object.fromEntries(((await build(extra).graph()).nodes as Record<string, unknown>[]).map((n) => [n.label as string, n]));
  const modelOf = (role: string): string | undefined => (role === "impl" ? "claude-sonnet-5-5" : undefined);

  test("agente em opus com o papel em sonnet leva real e configurado; no modelo certo, escalado ou encerrado, o campo não existe", async () => {
    const graph = await nodes({ modelOf });
    expect(graph.diverge?.modelMismatch).toEqual({ real: "opus-5-5", configured: "sonnet-5-5" });
    for (const name of ["certo", "escalado", "encerrado"]) expect(Object.hasOwn(graph[name] as object, "modelMismatch")).toBe(false);
  });

  test("sem a leitura do modelo configurado nenhum nó é marcado", async () => {
    for (const node of Object.values(await nodes({}))) expect(Object.hasOwn(node, "modelMismatch")).toBe(false);
  });
});
