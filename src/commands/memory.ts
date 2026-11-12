// `hades memory tidy [--dry-run|--apply] [--json] [--cwd <dir>]`: higiene do índice de memória (reference/memory.md).
// Só reescreve os índices (MEMORY.md, ORQUESTRACAO.md, ARQUIVO.md), com backup ao lado; nunca apaga nem move arquivo de memória.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryDirOf, analyzeIndex, diskProbe, planTidy, parseEntry } from "../lib/memory-index.ts";
import { EXIT, die, out } from "../lib/output.ts";
import { home } from "../lib/paths.ts";

export const HELP = `Higiene do índice de memória do projeto.
Uso: hades memory tidy [--dry-run | --apply] [--json] [--cwd <dir>]
  --dry-run  mostra o diff e não grava (é o padrão)
  --apply    grava MEMORY.md, ORQUESTRACAO.md e ARQUIVO.md, com backup ao lado; só o dono roda
  --json     saída para máquina
  --cwd      projeto cuja memória se limpa (padrão: o diretório atual)`;

const USAGE = "uso: hades memory tidy [--dry-run | --apply] [--json] [--cwd <dir>]";
const HEADERS = {
  "ORQUESTRACAO.md": "# Memória de orquestração\n\nLida no início da orquestração; fora do MEMORY.md para não pesar em toda sessão.\n\n",
  "ARQUIVO.md": "# Arquivo\n\nHistórico encerrado, lido sob demanda.\n\n",
} as const;

const stamp = (now: Date): string => now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** Linhas de entrada novas (por alvo) somadas ao que o arquivo já tem; sem arquivo, começa pelo cabeçalho. */
function mergeSideIndex(existing: string | undefined, name: keyof typeof HEADERS, entries: string): string {
  if (existing === undefined) return `${HEADERS[name]}${entries}`;
  const have = new Set(existing.split("\n").map((l) => parseEntry(l, 0)?.target).filter((t): t is string => t !== undefined));
  const fresh = entries.split("\n").filter((l) => {
    const target = parseEntry(l, 0)?.target;
    return l !== "" && (target === undefined || !have.has(target));
  });
  if (fresh.length === 0) return existing;
  return `${existing.replace(/\n*$/, "\n")}${fresh.join("\n")}\n`;
}

/** Diff por linha, sem dependência: o que sai (-) e o que entra (+) num índice. */
function lineDiff(name: string, before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const inB = new Set(b);
  const inA = new Set(a);
  const lines = [...a.filter((l) => l !== "" && !inB.has(l)).map((l) => `- ${l}`), ...b.filter((l) => l !== "" && !inA.has(l)).map((l) => `+ ${l}`)];
  return lines.length === 0 ? [] : [`--- ${name}`, ...lines];
}

export function memoryCommand(args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "-h" || sub === "--help") {
    out(HELP);
    return sub === undefined ? EXIT.usage : EXIT.ok;
  }
  if (sub !== "tidy") die(USAGE);
  let apply = false;
  let dry = false;
  let json = false;
  let cwd = process.cwd();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dry = true;
    else if (arg === "--json") json = true;
    else if (arg === "--cwd") cwd = rest[++i] ?? die(USAGE);
    else die(USAGE);
  }
  if (apply && dry) die("--apply e --dry-run não combinam");
  const dir = memoryDirOf(cwd, home());
  const indexPath = join(dir, "MEMORY.md");
  if (!existsSync(indexPath)) die(`sem MEMORY.md em ${dir}`, EXIT.fail);
  const now = new Date();
  const probe = diskProbe(dir);
  const before = readFileSync(indexPath, "utf8");
  const analysis = analyzeIndex(before, probe, now);
  const plan = planTidy(before, probe, now);
  const side = (name: "ORQUESTRACAO.md" | "ARQUIVO.md", entries: string): { path: string; before: string | undefined; after: string } => {
    const path = join(dir, name);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    return { path, before: existing, after: entries === "" ? (existing ?? "") : mergeSideIndex(existing, name, entries) };
  };
  const orq = side("ORQUESTRACAO.md", plan.orquestracao);
  const arq = side("ARQUIVO.md", plan.arquivo);
  const diff = [
    ...lineDiff("MEMORY.md", before, plan.principal),
    ...lineDiff("ORQUESTRACAO.md", orq.before ?? "", orq.after),
    ...lineDiff("ARQUIVO.md", arq.before ?? "", arq.after),
  ];
  const backups: string[] = [];
  if (apply) {
    const suffix = `.bak-${stamp(now)}`;
    for (const [path, content, original] of [
      [indexPath, plan.principal, before],
      [orq.path, orq.after, orq.before],
      [arq.path, arq.after, arq.before],
    ] as const) {
      if (content === (original ?? "") || (original === undefined && content === "")) continue;
      if (original !== undefined) {
        copyFileSync(path, `${path}${suffix}`);
        backups.push(`${path}${suffix}`);
      }
      writeFileSync(path, content);
    }
  }
  const problems = {
    bytes: analysis.bytes,
    longLines: analysis.longLines.length,
    duplicates: analysis.duplicates.length,
    missing: analysis.missing.length,
    closed: analysis.closed.length,
  };
  if (json) {
    out(JSON.stringify({ dir, applied: apply, problems, bytesAfter: Buffer.byteLength(plan.principal), diff, backups }));
    return EXIT.ok;
  }
  out(`${apply ? "aplicado" : "dry-run (nada gravado; --apply grava)"}: ${dir}`);
  out(`índice ${analysis.bytes} B -> ${Buffer.byteLength(plan.principal)} B; linhas longas ${problems.longLines}, duplicadas ${problems.duplicates}, links quebrados ${problems.missing}, histórico ${problems.closed}`);
  for (const line of diff) out(line);
  for (const backup of backups) out(`backup: ${backup}`);
  return EXIT.ok;
}
