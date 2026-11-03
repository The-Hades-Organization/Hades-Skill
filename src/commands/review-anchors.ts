// `hades review-anchors`: valida os inline[] de findings-pr-<n>.json contra os hunks RIGHT do diff limpo
// (gh api .../pulls/<n>/files) e monta o payload do review.
import { readFileSync, writeFileSync } from "node:fs";
import { EXIT, die, out, warn } from "../lib/output.ts";
import { need } from "../lib/deps.ts";
import { run } from "../lib/proc.ts";
import { originOwnerRepo } from "../lib/remote.ts";

const INCOMPLETE_EXIT = 4;
const GH_TIMEOUT_MS = 120_000;
const GH_MAX_BUFFER = 256 * 1024 * 1024;
const NEAR_LINES = 6;
const NEAR_SHOWN = 5;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface DiffFile {
  filename: string;
  status: string | undefined;
  patch: string | undefined;
}

interface Finding {
  path: string;
  line: number;
  start_line?: number | null;
  body: string;
  [key: string]: unknown;
}

interface Findings {
  inline?: Finding[];
  outOfHunk?: unknown[];
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gh(args: string[]): string {
  const r = run("gh", args, { timeoutMs: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER });
  if (r.status !== 0) return die(`gh ${args.slice(0, 3).join(" ")}…: ${(r.stderr || r.stdout).trim().split("\n").pop() ?? `rc=${r.status}`}`, EXIT.fail);
  return r.stdout;
}

function toFile(raw: unknown): DiffFile {
  if (!isRecord(raw) || typeof raw.filename !== "string") return die("gh api files: item sem 'filename'", EXIT.fail);
  return {
    filename: raw.filename,
    status: typeof raw.status === "string" ? raw.status : undefined,
    patch: typeof raw.patch === "string" ? raw.patch : undefined,
  };
}

/** `--paginate --slurp` junta as páginas num array de arrays; achatar uma vez dá a lista real (a partir de 101 arquivos há mais de uma página). */
function collectFiles(pr: string, repo: string): DiffFile[] {
  const pages: unknown = JSON.parse(gh(["api", `repos/${repo}/pulls/${pr}/files`, "--paginate", "--slurp"]));
  if (!Array.isArray(pages)) return die("gh api files: resposta não é uma lista", EXIT.fail);
  const flat = pages.length > 0 && Array.isArray(pages[0]) ? (pages as unknown[][]).flat() : pages;
  return flat.map(toFile);
}

/** Linhas do arquivo novo dentro de um hunk: o GitHub aceita comentário em linha adicionada ou de contexto. */
function rightLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines; // binário ou renomeado puro
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      newLine = Number.parseInt(hunk[1] ?? "0", 10);
      continue;
    }
    if (line.startsWith("-") || line.startsWith("\\")) continue; // lado LEFT, e "\ No newline at end of file"
    lines.add(newLine);
    newLine++;
  }
  return lines;
}

function rejectionReason(finding: Finding, set: Set<number> | undefined, status: string | undefined): string | undefined {
  if (!set) return `arquivo fora do diff (status=${status ?? "ausente"})`;
  if (!set.has(finding.line)) {
    const near = [...set].filter((n) => Math.abs(n - finding.line) <= NEAR_LINES).sort((a, b) => Math.abs(a - finding.line) - Math.abs(b - finding.line));
    return `linha ${finding.line} fora de hunk RIGHT${near.length ? ` (proximas validas: ${near.slice(0, NEAR_SHOWN).join(", ")})` : ""}`;
  }
  if (finding.start_line != null && !set.has(finding.start_line)) return `start_line ${finding.start_line} fora de hunk RIGHT`;
  return undefined;
}

export function reviewAnchorsCommand(args: string[]): number {
  const pr = args[0];
  if (!pr) {
    warn("uso: validate.mjs <pr> [--emit <file>]");
    return EXIT.usage;
  }
  need("gh");
  need("git");
  const emitIdx = args.indexOf("--emit");
  const emitPath = emitIdx > -1 ? args[emitIdx + 1] : undefined;
  const repo = process.env.HADES_REPO ?? ((o) => `${o.owner}/${o.repo}`)(originOwnerRepo());
  const files = collectFiles(pr, repo);

  // O diff coletado tem de casar com o changedFiles da PR: coleta parcial silenciosa validaria âncora contra meio diff.
  const declared = Number(gh(["pr", "view", String(pr), "--repo", repo, "--json", "changedFiles", "--jq", ".changedFiles"]).trim());
  if (Number.isFinite(declared) && declared !== files.length) {
    warn(`PR #${pr}: coleta incompleta — ${files.length} arquivos coletados vs ${declared} declarados pela PR. Abortando.`);
    return INCOMPLETE_EXIT;
  }

  const sets = new Map<string, Set<number>>();
  const statuses = new Map<string, string | undefined>();
  for (const f of files) {
    statuses.set(f.filename, f.status);
    sets.set(f.filename, rightLines(f.patch));
  }

  const scratch = process.env.HADES_FINDINGS ?? ".";
  const findings = JSON.parse(readFileSync(`${scratch}/findings/findings-pr-${pr}.json`, "utf8")) as Findings; // formato do artefato escrito pela sessão de review
  const proposed = findings.inline ?? [];
  const valid: Record<string, unknown>[] = [];
  const rejected: Record<string, unknown>[] = [];
  for (const c of proposed) {
    const why = rejectionReason(c, sets.get(c.path), statuses.get(c.path));
    if (why !== undefined) {
      rejected.push({ ...c, why });
      continue;
    }
    const entry: Record<string, unknown> = { path: c.path, line: c.line, side: "RIGHT", body: c.body };
    if (c.start_line != null) {
      entry.start_line = c.start_line;
      entry.start_side = "RIGHT";
    }
    valid.push(entry);
  }

  out(`PR #${pr}: ${files.length} arquivos no diff · inline propostos ${proposed.length} · validos ${valid.length} · rejeitados ${rejected.length} · outOfHunk declarados ${(findings.outOfHunk ?? []).length}`);
  for (const r of rejected) out(`  REJEITADO ${String(r.path)}:${String(r.line)} — ${String(r.why)}\n    ${String(r.body)}`);
  if (emitPath) {
    writeFileSync(emitPath, JSON.stringify({ valid, rejected, findings }, null, 2));
    out(`  -> ${emitPath}`);
  }
  return EXIT.ok;
}
