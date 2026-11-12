// Higiene do índice de memória (reference/memory.md): modelo puro e `hades memory tidy`, só com fixture em HOME temporário.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LONG_LINE_CHARS,
  MEMORY_LOAD_LIMIT_BYTES,
  STALE_DAYS,
  analyzeIndex,
  memoryDirOf,
  planTidy,
  type MemoryProbe,
} from "../../../src/lib/memory-index";
import { doctorMemoriaItem } from "../../../src/lib/doctor-memoria";
import { memoryCommand } from "../../../src/commands/memory";

const NOW = new Date("2026-11-12T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

const probeOf = (files: Record<string, { type?: string; modified?: Date }>): MemoryProbe => ({
  exists: (target) => target in files,
  meta: (target) => files[target],
});

const longHook = "x".repeat(LONG_LINE_CHARS);
const INDEX = [
  "# Memória",
  "- [Regra durável](regra.md) — sempre rode o gate",
  "- [Regra durável](regra.md) — duplicada",
  `- [Linha longa](longa.md) — ${longHook}`,
  "- [Fantasma](nao-existe.md) — aponta para arquivo ausente",
  "- [PR antiga](pr-antiga.md) — contexto da PR 12",
  "- [Entrega](entrega.md) — a PR foi mergeada na main",
  "- [Orquestração do loop](orquestracao-loop.md) — como o orquestrador espera gates",
  "",
].join("\n");

const FILES = {
  "regra.md": { type: "feedback", modified: daysAgo(1) },
  "longa.md": { type: "feedback", modified: daysAgo(1) },
  "pr-antiga.md": { type: "project", modified: daysAgo(STALE_DAYS + 1) },
  "entrega.md": { type: "project", modified: daysAgo(2) },
  "orquestracao-loop.md": { type: "feedback", modified: daysAgo(3) },
};

describe("analyzeIndex", () => {
  test("dado um índice com cada problema, então cada contagem sai certa", () => {
    const a = analyzeIndex(INDEX, probeOf(FILES), NOW);
    expect(a.longLines.map((l) => l.line)).toEqual([4]);
    expect(a.duplicates.map((d) => d.target)).toEqual(["regra.md"]);
    expect(a.missing.map((m) => m.target)).toEqual(["nao-existe.md"]);
    expect(a.closed.map((c) => c.target).sort()).toEqual(["entrega.md", "pr-antiga.md"]);
    expect(a.bytes).toBe(Buffer.byteLength(INDEX));
    expect(a.overLimit).toBe(false);
  });

  test("dado índice acima do limite, então overLimit liga e conta as linhas cortadas", () => {
    const big = `${"- [a](a.md)\n".repeat(3000)}`;
    const a = analyzeIndex(big, probeOf({ "a.md": { type: "feedback" } }), NOW);
    expect(a.bytes).toBeGreaterThan(MEMORY_LOAD_LIMIT_BYTES);
    expect(a.overLimit).toBe(true);
    expect(a.truncatedLines).toBeGreaterThan(0);
  });

  test("dado índice vazio, então tudo zera", () => {
    const a = analyzeIndex("", probeOf({}), NOW);
    expect([a.bytes, a.longLines.length, a.duplicates.length, a.missing.length, a.closed.length]).toEqual([0, 0, 0, 0, 0]);
  });

  test("dado project exatamente no limite de dias, então ainda não é histórico", () => {
    const a = analyzeIndex("- [x](x.md) — nota", probeOf({ "x.md": { type: "project", modified: daysAgo(STALE_DAYS) } }), NOW);
    expect(a.closed).toHaveLength(0);
  });

  test("dado link com .. ou absoluto, então não conta como arquivo existente nem lê fora da pasta", () => {
    const seen: string[] = [];
    const probe: MemoryProbe = { exists: (t) => (seen.push(t), true), meta: () => undefined };
    const a = analyzeIndex("- [x](../../etc/passwd) — a\n- [y](/etc/passwd) — b", probe, NOW);
    expect(a.missing.map((m) => m.target)).toEqual(["../../etc/passwd", "/etc/passwd"]);
    expect(seen).toEqual([]);
  });
});

describe("planTidy", () => {
  test("dado o índice problemático, então corta gancho, tira duplicata e divide em três", () => {
    const plan = planTidy(INDEX, probeOf(FILES), NOW);
    expect(plan.principal).toContain("- [Regra durável](regra.md) — sempre rode o gate");
    expect(plan.principal.match(/regra\.md/g)).toHaveLength(1);
    expect(plan.principal).toContain("- [Linha longa](longa.md)");
    expect(plan.principal).not.toContain(longHook);
    expect(plan.orquestracao).toContain("orquestracao-loop.md");
    expect(plan.principal).not.toContain("orquestracao-loop.md");
    expect(plan.arquivo).toContain("pr-antiga.md");
    expect(plan.arquivo).toContain("entrega.md");
    expect(plan.principal).not.toContain("entrega.md");
    expect(Buffer.byteLength(plan.principal)).toBeLessThan(Buffer.byteLength(INDEX));
  });

  test("dado link para arquivo inexistente, então a entrada fica no principal e é só reportada", () => {
    const plan = planTidy(INDEX, probeOf(FILES), NOW);
    expect(plan.principal).toContain("nao-existe.md");
  });

  test("dado o plano aplicado de novo, então nada muda", () => {
    const first = planTidy(INDEX, probeOf(FILES), NOW);
    const again = planTidy(first.principal, probeOf(FILES), NOW);
    expect(again.principal).toBe(first.principal);
    expect(again.orquestracao.trim()).toBe("");
    expect(again.arquivo.trim()).toBe("");
  });
});

describe("doctorMemoriaItem", () => {
  test("dado índice ausente, então ok neutro com o motivo", () => {
    const item = doctorMemoriaItem(undefined, probeOf({}), NOW);
    expect(item.level).toBe("ok");
    expect(item.msg).toContain("sem índice");
  });

  test("dado índice limpo, então ok com o tamanho", () => {
    const item = doctorMemoriaItem("- [a](a.md) — ok", probeOf({ "a.md": { type: "feedback" } }), NOW);
    expect(item.level).toBe("ok");
    expect(item.msg).toContain("memoria:");
  });

  test("dado índice com problemas, então avisa com a contagem de cada um e o comando", () => {
    const item = doctorMemoriaItem(INDEX, probeOf(FILES), NOW);
    expect(item.level).toBe("warn");
    expect(item.msg).toMatch(/1 linha\(s\) acima de 150/);
    expect(item.msg).toMatch(/1 duplicada/);
    expect(item.msg).toMatch(/1 link/);
    expect(item.msg).toMatch(/2 .*histórico/);
    expect(item.fix).toContain("hades memory tidy");
  });
});

describe("hades memory tidy", () => {
  let home = "";
  let cwd = "";
  let dir = "";
  const saved = { HOME: process.env.HOME };
  let stdout = "";
  const realWrite = process.stdout.write.bind(process.stdout);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hades-memory-"));
    cwd = join(home, "proj");
    mkdirSync(cwd);
    process.env.HOME = home;
    dir = memoryDirOf(cwd, home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), INDEX);
    for (const [name, m] of Object.entries(FILES)) {
      writeFileSync(join(dir, name), `---\nname: ${name}\nmetadata:\n  type: ${m.type}\n---\ncorpo\n`);
    }
    stdout = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = realWrite;
    process.env.HOME = saved.HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test("dado sem flag, então é dry-run: mostra o diff e não grava", async () => {
    const code = await memoryCommand(["tidy", "--cwd", cwd]);
    expect(code).toBe(0);
    expect(stdout).toContain("dry-run");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe(INDEX);
    expect(existsSync(join(dir, "ARQUIVO.md"))).toBe(false);
  });

  test("dado --json, então a saída é JSON com o plano e as contagens", async () => {
    await memoryCommand(["tidy", "--dry-run", "--json", "--cwd", cwd]);
    const parsed = JSON.parse(stdout) as { applied: boolean; problems: { duplicates: number } };
    expect(parsed.applied).toBe(false);
    expect(parsed.problems.duplicates).toBe(1);
  });

  test("dado --apply, então grava os três índices, faz backup e não toca nos arquivos de memória", async () => {
    const before = Object.fromEntries(Object.keys(FILES).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    const code = await memoryCommand(["tidy", "--apply", "--cwd", cwd]);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).not.toBe(INDEX);
    expect(readFileSync(join(dir, "ARQUIVO.md"), "utf8")).toContain("entrega.md");
    expect(readFileSync(join(dir, "ORQUESTRACAO.md"), "utf8")).toContain("orquestracao-loop.md");
    const backups = readdirSync(dir).filter((f) => f.startsWith("MEMORY.md.bak"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0] as string), "utf8")).toBe(INDEX);
    for (const [f, text] of Object.entries(before)) expect(readFileSync(join(dir, f), "utf8")).toBe(text);
  });

  test("dado --apply com ARQUIVO.md existente, então guarda backup dele e preserva o que já tinha", async () => {
    writeFileSync(join(dir, "ARQUIVO.md"), "- [Velha](velha.md) — antiga\n");
    await memoryCommand(["tidy", "--apply", "--cwd", cwd]);
    const text = readFileSync(join(dir, "ARQUIVO.md"), "utf8");
    expect(text).toContain("velha.md");
    expect(text).toContain("entrega.md");
    expect(readdirSync(dir).some((f) => f.startsWith("ARQUIVO.md.bak"))).toBe(true);
  });

  test("dado --apply e --dry-run juntos, então recusa", async () => {
    await expect(Promise.resolve().then(() => memoryCommand(["tidy", "--apply", "--dry-run", "--cwd", cwd]))).rejects.toThrow();
  });

  test("dado projeto sem índice, então sai com erro claro e sem criar nada", async () => {
    rmSync(join(dir, "MEMORY.md"));
    await expect(Promise.resolve().then(() => memoryCommand(["tidy", "--cwd", cwd]))).rejects.toThrow(/MEMORY\.md/);
  });
});
