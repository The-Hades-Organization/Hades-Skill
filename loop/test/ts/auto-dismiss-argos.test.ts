import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGraph, registriesOf } from "../../../src/panel/argos-graph";

const T = mkdtempSync(join(tmpdir(), "auto-dismiss-argos-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

describe("argos: closedOnDone no nó do agente", () => {
  const herdr = { cached: async (_key: string, load: () => Promise<unknown>) => load(), json: async () => null } as unknown as Parameters<typeof createGraph>[0]["herdr"];
  const root = join(T, "work");
  const agent = (name: string, fields: Record<string, unknown>): void => {
    const file = join(root, "_skill/orchestration/agents", `${name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ name, mode: "skill", role: "impl", worktree: join(T, "wt", name), ...fields }));
  };
  agent("fechado-ao-concluir", { state: "done", closedOnDone: true });
  agent("fechado-na-mao", { state: "done" });
  agent("vivo", { state: "working" });
  const nodeOf = async (name: string): Promise<Record<string, unknown>> => {
    const graph = createGraph({ registries: () => registriesOf(undefined, root), journalRoot: () => root, herdr, gates: () => [], reportsDir: () => ".design-sync-reports" } as Parameters<typeof createGraph>[0]);
    const node = ((await graph.graph()).nodes as Record<string, unknown>[]).find((n) => n.label === name);
    if (!node) throw new Error(`nó ${name} ausente do grafo`);
    return node;
  };

  test("dado agente fechado pelo watch ao concluir, então o nó leva closedOnDone", async () => {
    expect((await nodeOf("fechado-ao-concluir")).closedOnDone).toBe(true);
  });

  test("dado agente encerrado à mão ou ainda vivo, então o nó não ganha o campo", async () => {
    expect(Object.hasOwn(await nodeOf("fechado-na-mao"), "closedOnDone")).toBe(false);
    expect(Object.hasOwn(await nodeOf("vivo"), "closedOnDone")).toBe(false);
  });
});
