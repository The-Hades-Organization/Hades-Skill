import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ctxCapKey, ctxCapOf, DEFAULT_INTERACTIVE_CAP, DEFAULT_RECRUIT_CAP } from "../../../src/lib/ctx-cap";
import { createGraph, registriesOf } from "../../../src/panel/argos-graph";

const T = mkdtempSync(join(tmpdir(), "ctx-teto-argos-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));

describe("teto de contexto por papel (ctxCapOf)", () => {
  const read = (cfg: Record<string, string>) => (key: string) => cfg[key];

  test("dado papel com chave própria, então vale a chave", () => {
    expect(ctxCapOf("impl", read({ HADES_CTX_CAP_IMPL: "200000", HADES_CTX_CAP_INTERACTIVE: "300000" }))).toBe(200_000);
  });

  test("dado papel sem chave que não é recruta, então cai no teto interativo", () => {
    expect(ctxCapOf("revisor", read({ HADES_CTX_CAP_INTERACTIVE: "310000" }))).toBe(310_000);
  });

  test("dado recruta, então chave própria vence, depois HADES_CTX_CAP_RECRUIT, depois o padrão de 200k", () => {
    const cfg = { HADES_CTX_CAP_REVISOR: "120000", HADES_CTX_CAP_RECRUIT: "180000", HADES_CTX_CAP_INTERACTIVE: "310000" };
    expect(ctxCapOf("revisor", read(cfg), true)).toBe(120_000);
    expect(ctxCapOf("outro", read(cfg), true)).toBe(180_000);
    expect(ctxCapOf("recruit", read(cfg), true)).toBe(180_000);
    expect(ctxCapOf("outro", read({ HADES_CTX_CAP_INTERACTIVE: "310000" }), true)).toBe(DEFAULT_RECRUIT_CAP);
  });

  test("dado slug com hífen e caixa, então a chave é normalizada para variável de ambiente", () => {
    expect(ctxCapKey("Revisor-2")).toBe("HADES_CTX_CAP_REVISOR_2");
    expect(ctxCapOf("Revisor-2", read({ HADES_CTX_CAP_REVISOR_2: "120000" }))).toBe(120_000);
  });

  test("dado valor inválido, zero ou ausente, então segue a cadeia até o padrão", () => {
    expect(ctxCapOf("impl", read({ HADES_CTX_CAP_IMPL: "abc", HADES_CTX_CAP_INTERACTIVE: "0" }))).toBe(DEFAULT_INTERACTIVE_CAP);
    expect(ctxCapOf("impl", read({}))).toBe(DEFAULT_INTERACTIVE_CAP);
  });
});

describe("argos: ctxOver no nó do agente", () => {
  const herdr = { cached: async (_key: string, load: () => Promise<unknown>) => load(), json: async () => null } as unknown as Parameters<typeof createGraph>[0]["herdr"];
  const root = join(T, "work");
  const agent = (name: string, fields: Record<string, unknown>): void => {
    const file = join(root, "_skill/orchestration/agents", `${name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ name, mode: "deliver", role: "impl", state: "working", worktree: join(T, "wt", name), ...fields }));
  };
  agent("estourou", {});
  agent("no-teto", {});
  agent("revisando", { mode: "review", role: undefined });
  agent("encerrado", { state: "done" });
  const used: Record<string, number> = { estourou: 320_000, "no-teto": 200_000, revisando: 150_000, encerrado: 900_000 };
  const caps: Record<string, number> = { impl: 200_000, review: 100_000 };
  const build = (extra: Record<string, unknown>) =>
    createGraph({ registries: () => registriesOf(undefined, root), journalRoot: () => root, herdr, gates: () => [], reportsDir: () => ".design-sync-reports", ...extra } as Parameters<typeof createGraph>[0]);
  const nodes = async (extra: Record<string, unknown>): Promise<Record<string, Record<string, any>>> => Object.fromEntries(((await build(extra).graph()).nodes as Record<string, any>[]).map((n) => [n.label, n]));
  const nodeOf = async (name: string, extra: Record<string, unknown>): Promise<Record<string, any>> => {
    const node = (await nodes(extra))[name];
    if (!node) throw new Error(`nó ${name} ausente do grafo`);
    return node;
  };
  const injected = { ctxCap: (role: string) => caps[role] ?? 300_000, contextOf: (tree: string) => used[tree.split("/").at(-1) as string] ?? 0 };

  test("dado agente acima do teto do papel, então o nó leva usado e teto em k", async () => {
    expect((await nodeOf("estourou", injected)).ctxOver).toEqual({ usedK: 320, capK: 200 });
  });

  test("dado agente exatamente no teto, então o nó não é marcado (mesma regra do watch: só acima)", async () => {
    expect(Object.hasOwn((await nodeOf("no-teto", injected)), "ctxOver")).toBe(false);
  });

  test("dado agente de revisão sem role declarado, então vale o teto do modo (o mesmo papel do hook)", async () => {
    expect((await nodeOf("revisando", injected)).ctxOver).toEqual({ usedK: 150, capK: 100 });
  });

  test("dado agente encerrado, então não é marcado mesmo com o contexto alto", async () => {
    expect(Object.hasOwn((await nodeOf("encerrado", injected)), "ctxOver")).toBe(false);
  });

  test("dado grafo sem teto injetado, então nenhum nó ganha o campo", async () => {
    for (const node of Object.values(await nodes({}))) expect(Object.hasOwn(node, "ctxOver")).toBe(false);
  });
});
