// Contexto fixo (1º turno): primeira resposta da sessão, mediana e p90, decomposição em disco, piso de custo e a linha do
// doctor (subida acima e abaixo do limiar, sem dados).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFile, type Row } from "../../../src/lib/usage";
import { guardRules } from "../../../src/lib/guard-rules";
import {
  buildFixedContext, grownPart, judgeFixedContext, median, MIN_SESSIONS_PER_WINDOW, openingsOf, percentile, type Opening,
} from "../../../src/lib/usage-fixo";
import { partsOf, repoOf, sumParts } from "../../../src/lib/usage-fixo-io";

const row = (over: Partial<Row>): Row => ({
  session: "s1", sidechain: false, day: "2026-11-01", cwd: "/wt/a", cost: 1, turns: 10, poll_turns: 0, poll_cost: 0, rewrite_cost: 0,
  ctx_sum: 0, ctx_max: 0, models: {}, efforts: {}, read: 0, write: 0, output: 0, first: "", last: "", tok: {}, ...over,
});

describe("mediana e p90", () => {
  test("dada amostra vazia, então não há valor", () => {
    expect(median([])).toBeUndefined();
    expect(percentile([], 0.9)).toBeUndefined();
  });
  test("dado um valor só, então mediana e p90 são ele", () => {
    expect(median([7])).toBe(7);
    expect(percentile([7], 0.9)).toBe(7);
  });
  test("dada amostra par, então a mediana é a média dos dois do meio; o p90 é o rank mais próximo", () => {
    expect(median([40, 10, 20, 30])).toBe(25);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});

describe("primeira resposta da sessão (parseFile)", () => {
  const assistant = (ts: string, id: string, input: number, read: number, create: number, side = false): string =>
    JSON.stringify({ type: "assistant", timestamp: ts, sessionId: "S", requestId: id, cwd: "/wt/a", isSidechain: side,
      message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: input, output_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: create } } });
  const transcript = (lines: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "fixo-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, lines.join("\n"));
    return file;
  };

  test("dada uma sessão de três turnos, então o contexto fixo é input + leitura + escrita da primeira resposta", () => {
    const rows = parseFile(transcript([
      assistant("2026-11-01T10:00:00Z", "a", 3, 1000, 40000),
      assistant("2026-11-01T10:01:00Z", "b", 3, 41000, 500),
      assistant("2026-11-02T10:01:00Z", "c", 3, 41500, 500),
    ]), guardRules());
    expect(rows.map((r) => r.open)).toEqual([{ ctx: 41003, model: "sonnet-5-5" }, undefined]);
  });
  test("dada a resposta de subagente, então não conta como abertura", () => {
    const rows = parseFile(transcript([assistant("2026-11-01T10:00:00Z", "a", 1, 2, 3, true)]), guardRules());
    expect(rows[0]?.open).toBeUndefined();
  });
  test("dada uma sessão sem nenhuma resposta, então não há linha nem abertura", () => {
    const rows = parseFile(transcript([JSON.stringify({ type: "user", timestamp: "2026-11-01T10:00:00Z", message: { content: "oi" } })]), guardRules());
    expect(rows).toEqual([]);
  });
});

describe("bloco do relatório", () => {
  const rows = [
    row({ session: "a", open: { ctx: 40_000, model: "sonnet-5-5" }, turns: 10, cost: 2 }),
    row({ session: "a", day: "2026-11-02", turns: 5, cost: 1 }),
    row({ session: "b", open: { ctx: 60_000, model: "sonnet-5-5" }, turns: 10, cost: 3 }),
    row({ session: "c", sidechain: true, open: { ctx: 999, model: "sonnet-5-5" } }),
    row({ session: "d", turns: 4 }),
  ];
  const inputs = { roleOf: () => "impl", repoOf: () => "hades", partsOf: () => ({ claudeMd: 2048 }) };

  test("dadas sessões com e sem abertura, então só as medidas contam, por sessão principal", () => {
    expect(openingsOf(rows).map((o) => [o.session, o.turns])).toEqual([["a", 15], ["b", 10]]);
    const fixed = buildFixedContext(rows, inputs);
    expect(fixed).toMatchObject({ sessions: 2, median: 50_000, p90: 60_000 });
    expect(fixed?.groups).toEqual([{ repo: "hades", role: "impl", model: "sonnet-5-5", sessions: 2, median: 50_000, p90: 60_000, parts: { claudeMd: 2048 } }]);
    expect(fixed?.byDay).toEqual([{ day: "2026-11-01", sessions: 2, median: 50_000, p90: 60_000 }]);
  });
  test("dado o piso, então é contexto × turnos × preço de leitura de cache sobre o custo das sessões", () => {
    const floor = buildFixedContext(rows, inputs)?.floor;
    // sonnet-5-5 lê a US$ 0,20/MTok: (40k×15 + 60k×10) × 0,2 / 1e6
    expect(floor?.floorCost).toBeCloseTo(0.24);
    expect(floor?.cost).toBe(6);
    expect(floor?.share).toBeCloseTo(4);
  });
  test("dada janela sem nenhuma abertura, então não há bloco", () => {
    expect(buildFixedContext([row({})], inputs)).toBeUndefined();
  });
});

describe("decomposição em disco", () => {
  test("dado o cwd com CLAUDE.md na cadeia, MEMORY.md e brief, então cada parte é o tamanho em bytes; parte ausente fica de fora", () => {
    const home = mkdtempSync(join(tmpdir(), "fixo-home-"));
    const cwd = join(home, "proj", "wt");
    mkdirSync(join(cwd, ".design-sync-reports"), { recursive: true });
    writeFileSync(join(cwd, "..", "CLAUDE.md"), "x".repeat(100));
    writeFileSync(join(cwd, "CLAUDE.md"), "x".repeat(50));
    writeFileSync(join(cwd, ".design-sync-reports", "brief.md"), "x".repeat(30));
    const slug = cwd.replace(/[/.]/g, "-");
    mkdirSync(join(home, ".claude", "projects", slug, "memory"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", slug, "memory", "MEMORY.md"), "x".repeat(20));
    expect(partsOf(cwd, "impl", home, join(home, "sem-skill"))).toEqual({ claudeMd: 150, memory: 20, brief: 30 });
    expect(partsOf(join(home, "vazio"), "interactive", home, home)).toBeUndefined();
  });
  test("dado um worktree, então o repositório é o do clone apontado pelo .git", () => {
    const base = mkdtempSync(join(tmpdir(), "fixo-repo-"));
    const wt = join(base, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${base}/meu-repo/.git/worktrees/wt\n`);
    expect(repoOf(wt)).toBe("meu-repo");
  });
  test("dadas várias pastas, então a soma é por parte", () => {
    expect(sumParts([{ claudeMd: 1, memory: 2 }, { claudeMd: 3 }])).toEqual({ claudeMd: 4, memory: 2 });
  });
});

describe("linha contexto-fixo do doctor", () => {
  const today = "2026-11-14";
  const opening = (day: string, ctx: number, n: number): Opening[] =>
    Array.from({ length: n }, (_, i) => ({ session: `${day}-${i}`, day, cwd: "/x", model: "sonnet-5-5", ctx, turns: 1, cost: 1 }));
  const prior = opening("2026-11-03", 50_000, 4);
  const cases: [string, number][] = [["acima do limiar", 60_000], ["no limiar", 57_500], ["abaixo do limiar", 52_000]];

  for (const [name, ctx] of cases) {
    test(`dada a mediana ${name} de 15%, então ${ctx > 57_500 ? "avisa" : "fica ok"}`, () => {
      const verdict = judgeFixedContext([...prior, ...opening("2026-11-12", ctx, 4)], today, 15);
      expect(verdict.level).toBe(ctx > 57_500 ? "warn" : "ok");
    });
  }
  test("dada a subida, então diz qual parte cresceu quando há retrato antigo", () => {
    const history = { "2026-11-05": { claudeMd: 1000, memory: 5000 } };
    const verdict = judgeFixedContext([...prior, ...opening("2026-11-12", 70_000, 4)], today, 15, { claudeMd: 1500, memory: 21_384 }, history);
    expect(verdict.level).toBe("warn");
    expect(verdict.msg).toContain("MEMORY.md do projeto (+16,0 KB");
  });
  test("dada a subida sem retrato antigo, então avisa sem apontar parte", () => {
    const verdict = judgeFixedContext([...prior, ...opening("2026-11-12", 70_000, 4)], today, 15, { claudeMd: 1500 }, {});
    expect(verdict.level).toBe("warn");
    expect(verdict.msg).toContain("parte não identificada");
  });
  test("dada pouca amostra numa janela, então o estado é neutro com o motivo, nunca aviso", () => {
    const few = judgeFixedContext([...prior, ...opening("2026-11-12", 900_000, MIN_SESSIONS_PER_WINDOW - 1)], today, 15);
    expect(few.level).toBe("ok");
    expect(few.msg).toContain("sem dados suficientes");
    expect(judgeFixedContext([], today, 15).msg).toContain("0 sessões");
  });
  test("dado crescimento só em bytes que não subiram, então grownPart não aponta nada", () => {
    expect(grownPart({ "2026-11-01": { claudeMd: 900 } }, { claudeMd: 900 }, today)).toBeUndefined();
    expect(grownPart({ "2026-11-13": { claudeMd: 1 } }, { claudeMd: 900 }, today)).toBeUndefined();
  });
});
