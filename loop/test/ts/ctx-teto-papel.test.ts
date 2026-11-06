// Teto de contexto por papel: o `roleOf` do hook escolhe o papel certo e o registro recusa worktree que contém outras.
// Em-processo (decide() com ambiente falso): o que importa é qual papel e qual teto a sessão recebe.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, terminalOf, type HookEnv } from "../../../src/lib/guard-hook";
import { assertNoNestedWorktrees, WORKTREE_CONTAINS_AGENTS } from "../../../src/lib/agent-registry";
import { containsDir, mostSpecific } from "../../../src/lib/worktree-scope";

const T = mkdtempSync(join(tmpdir(), "hades-ctx-teto-"));
const HOME = join(T, "home");
const DATA = join(T, "data");
const WORK = join(T, "work");
const AGENTS = join(WORK, "proj", "orchestration", "agents");
const CLONE = join(T, "clone");
const savedEnv = { HOME: process.env.HOME, HADES_WORK_ROOT: process.env.HADES_WORK_ROOT, HADES_DATA: process.env.HADES_DATA };

const CAPS = ["HADES_CTX_CAP_IMPL\t200000", "HADES_CTX_CAP_REVIEW\t100000", "HADES_CTX_CAP_ORCHESTRATOR\t250000", "HADES_CTX_CAP_INTERACTIVE\t300000", "HADES_CTX_CAP_REVISOR\t120000", "HADES_CTX_CAP_RECRUIT\t180000", "HADES_CTX_REWARN\t50000", ""];

beforeAll(() => {
  process.env.HOME = HOME;
  process.env.HADES_WORK_ROOT = WORK;
  // o gate roda com HADES_DATA apontando para outra instância: o hook preferiria essa à do teste
  process.env.HADES_DATA = DATA;
  mkdirSync(join(HOME, ".claude/hades"), { recursive: true });
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(HOME, ".claude/hades/instance"), `${DATA}\n`);
  writeFileSync(join(DATA, "config.tsv"), CAPS.join("\n"));
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(T, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(AGENTS, { recursive: true, force: true });
  rmSync(join(HOME, ".claude/hades/guard"), { recursive: true, force: true });
  mkdirSync(AGENTS, { recursive: true });
});

const register = (name: string, record: Record<string, unknown>): void => writeFileSync(join(AGENTS, `${name}.json`), JSON.stringify({ name, ...record }));

function envOf(extra: Partial<HookEnv> = {}): HookEnv {
  return {
    now: () => 0, cwd: () => CLONE, home: () => HOME, gatePatterns: () => [], projectOf: () => "proj",
    cerberusEmit: () => undefined, ...extra,
  };
}

let seq = 0;
/** Uma chamada de ferramenta de uma sessão em `cwd` com `tokens` de contexto; devolve o additionalContext ("" sem aviso). */
function postTool(cwd: string, tokens: number, extra: Partial<HookEnv> = {}): string {
  seq += 1;
  const transcript = join(T, `transcript-${seq}.jsonl`);
  const usage = { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { usage } })}\n`);
  const result = decide({ hook_event_name: "PostToolUse", session_id: `s${seq}`, cwd, tool_name: "Bash", transcript_path: transcript }, envOf(extra));
  if (result.stdout === "") return "";
  return (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

describe("roleOf: agente encerrado mantém o papel do registro", () => {
  test("sessão na worktree de agente done, acima do teto do papel impl, recebe o aviso do impl (não o do interativo)", () => {
    const wt = join(T, "wt", "wp-done");
    register("wp-done", { role: "impl", state: "done", worktree: wt });
    expect(postTool(wt, 250_000)).toContain("papel impl (200k)");
  });

  test("agente done e agente vivo na mesma worktree: o vivo vale", () => {
    const wt = join(T, "wt", "retomado");
    register("a-velho", { role: "review", state: "done", worktree: wt });
    register("b-novo", { role: "impl", state: "working", worktree: wt });
    expect(postTool(wt, 250_000)).toContain("papel impl (200k)");
  });
});

describe("roleOf: worktree mais específica", () => {
  test("registro com worktree pai não toma o papel de quem está numa worktree filha registrada", () => {
    const pai = join(CLONE, ".fixes");
    register("a-pai", { role: "review", state: "working", worktree: pai });
    register("b-filho", { role: "impl", state: "working", worktree: join(pai, "wp-1") });
    expect(postTool(join(pai, "wp-1", "src"), 250_000)).toContain("papel impl (200k)");
  });

  test("a ordem dos arquivos do registro não decide: o filho vale também quando sorteia antes do pai", () => {
    const pai = join(CLONE, ".fixes");
    register("a-filho", { role: "impl", state: "working", worktree: join(pai, "wp-1") });
    register("b-pai", { role: "review", state: "working", worktree: pai });
    expect(postTool(join(pai, "wp-1"), 250_000)).toContain("papel impl (200k)");
  });

  test("worktree irmã com o mesmo prefixo de texto não casa (fronteira de diretório)", () => {
    register("wp-a", { role: "review", state: "working", worktree: join(T, "wt", "wp") });
    expect(postTool(join(T, "wt", "wp-extra"), 150_000, { projectOf: () => undefined })).toBe("");
  });

  test("containsDir e mostSpecific casam por componente de caminho", () => {
    expect(containsDir("/a/b", "/a/b/c")).toBe(true);
    expect(containsDir("/a/b", "/a/b")).toBe(true);
    expect(containsDir("/a/b", "/a/bc")).toBe(false);
    expect(containsDir("/", "/qualquer")).toBe(true);
    expect(containsDir("", "/a")).toBe(false);
    expect(mostSpecific("/a/b/c/d", ["/a", "/a/b/c", "/a/b"], (p) => p)).toBe("/a/b/c");
    expect(mostSpecific("/x", ["/a"], (p) => p)).toBeUndefined();
  });
});

describe("roleOf: recruta do canvas sem registro", () => {
  const wt = join(T, "wt", "recruta");
  const gitFile = (): void => {
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /nao/importa\n");
  };

  test("papel do recruta no argos/terminals.json vale antes de cair em interactive", () => {
    gitFile();
    const aviso = postTool(wt, 150_000, { terminal: (cwd) => (cwd === wt ? { role: "revisor" } : undefined) });
    expect(aviso).toContain("revisor");
    expect(aviso).toContain("120k");
  });

  test("sem injeção, o hook lê o argos/terminals.json da instância ativa", () => {
    gitFile();
    mkdirSync(join(DATA, "argos"), { recursive: true });
    writeFileSync(join(DATA, "argos", "terminals.json"), JSON.stringify({ terminals: [{ cwd: wt, role: "revisor" }] }));
    try {
      expect(postTool(wt, 150_000)).toContain("revisor");
    } finally {
      rmSync(join(DATA, "argos"), { recursive: true, force: true });
    }
  });

  test("recruta: chave própria do papel vence; papel sem chave e terminal sem papel usam HADES_CTX_CAP_RECRUIT (180k)", () => {
    gitFile();
    const em = (role: string | undefined) => ({ terminal: (cwd: string) => (cwd === wt ? { role } : undefined) });
    expect(postTool(wt, 150_000, em("revisor"))).toContain("120k");
    expect(postTool(wt, 150_000, em("sem-chave-propria"))).toBe("");
    expect(postTool(wt, 190_000, em("sem-chave-propria"))).toContain("180k");
    expect(postTool(wt, 150_000, em(undefined))).toBe("");
    expect(postTool(wt, 190_000, em(undefined))).toContain("180k");
  });

  test("sem papel no terminals.json, a worktree sem registro segue interativa (300k)", () => {
    gitFile();
    expect(postTool(wt, 150_000, { terminal: () => undefined })).toBe("");
    expect(postTool(wt, 350_000, { terminal: () => undefined })).toContain("sessões interativas (300k)");
  });

  test("terminalOf lê o terminal cujo cwd contém a sessão (o mais específico), com ou sem papel, e ignora arquivo ilegível", () => {
    const file = join(T, "terminals.json");
    const doc = { terminals: [{ cwd: join(T, "wt"), role: "geral" }, { cwd: wt, role: "revisor" }, { cwd: join(T, "outro") }] };
    writeFileSync(file, JSON.stringify(doc));
    expect(terminalOf(file, join(wt, "sub"))).toEqual({ role: "revisor" });
    expect(terminalOf(file, join(T, "outro"))).toEqual({ role: undefined });
    expect(terminalOf(file, join(T, "longe"))).toBeUndefined();
    writeFileSync(file, "{ não é json");
    expect(terminalOf(file, wt)).toBeUndefined();
    expect(terminalOf(join(T, "nao-existe.json"), wt)).toBeUndefined();
  });
});
