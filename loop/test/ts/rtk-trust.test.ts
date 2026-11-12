// Grupo rtk-trust: worktrees de agente com filtro gerado e não confiado (modelo puro, sem rtk de verdade). reference/rtk.md.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILTERS_REL, GENERATED_MARK, type RtkBinary, type TrustState } from "../../../src/lib/rtk-filters";
import { TRUST_SHOWN_MAX, startWithTrust, trustCommand, trustSummary, untrustedWorktrees } from "../../../src/lib/rtk-trust";

const RTK: RtkBinary = { path: "/fake/rtk", version: "1.1.0" };
const root = mkdtempSync(join(tmpdir(), "rtk-trust-"));
let seq = 0;
function worktree(text: string | undefined): string {
  const dir = join(root, `wt-${seq++}`);
  mkdirSync(join(dir, ".rtk"), { recursive: true });
  if (text !== undefined) writeFileSync(join(dir, FILTERS_REL), text);
  return dir;
}
const stateOf = (states: Record<string, TrustState>) => (dir: string): TrustState => states[dir] ?? "";

describe("untrustedWorktrees", () => {
  test("dado filtro gerado e não confiado, quando listo, então entra com o estado", () => {
    const a = worktree(`${GENERATED_MARK}\n`);
    expect(untrustedWorktrees([a], RTK, stateOf({ [a]: "nao-confiado" }))).toEqual([{ dir: a, state: "nao-confiado" }]);
  });
  test("dado filtro alterado depois de confiado, então entra como alterado", () => {
    const a = worktree(`${GENERATED_MARK}\n`);
    expect(untrustedWorktrees([a], RTK, stateOf({ [a]: "alterado" }))).toEqual([{ dir: a, state: "alterado" }]);
  });
  test("dado filtro confiado, sem arquivo ou do dono (sem a marca), então não entra", () => {
    const ok = worktree(`${GENERATED_MARK}\n`);
    const none = worktree(undefined);
    const own = worktree("# meu filtro\n");
    const all = { [ok]: "confiado", [none]: "", [own]: "nao-confiado" } as const;
    expect(untrustedWorktrees([ok, none, own], RTK, stateOf(all))).toEqual([]);
  });
  test("dado pasta repetida ou inexistente, então conta uma vez e ignora a que não existe", () => {
    const a = worktree(`${GENERATED_MARK}\n`);
    const got = untrustedWorktrees([a, a, join(root, "nao-existe")], RTK, stateOf({ [a]: "nao-confiado" }));
    expect(got.map((g) => g.dir)).toEqual([a]);
  });
  test("dado lista vazia, então devolve vazio", () => {
    expect(untrustedWorktrees([], RTK, stateOf({}))).toEqual([]);
  });
});

describe("trustCommand e startWithTrust", () => {
  test("o comando do dono entra na pasta e roda rtk trust", () => {
    expect(trustCommand("/w/a b")).toBe("cd '/w/a b' && rtk trust");
  });
  test("dado worktree não confiada, o start leva o rtk trust antes do herdr agent start", () => {
    const start = "! herdr agent start x --kind claude --pane p -- --permission-mode auto";
    const got = startWithTrust(start, "/w/a", "nao-confiado");
    expect(got).toBe(`! (cd /w/a && rtk trust) && ${start.slice(2)}`);
  });
  test("dado confiado ou sem filtro, o start não muda; sem o prefixo `! ` (orquestrador), o trust não entra", () => {
    const start = "! herdr agent start x";
    expect(startWithTrust(start, "/w/a", "confiado")).toBe(start);
    expect(startWithTrust(start, "/w/a", "")).toBe(start);
    expect(startWithTrust("herdr agent start x", "/w/a", "nao-confiado")).toBe("herdr agent start x");
  });
});

describe("trustSummary", () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => ({ dir: `/w/${i}`, state: "nao-confiado" as const }));
  test("nenhuma: ok, contagem zero", () => {
    expect(trustSummary([])).toEqual({ count: 0, shown: [], more: 0 });
  });
  test(`até ${TRUST_SHOWN_MAX} aparecem inteiras`, () => {
    expect(trustSummary(list(TRUST_SHOWN_MAX))).toMatchObject({ count: TRUST_SHOWN_MAX, more: 0 });
  });
  test("acima do teto, mostra as primeiras e conta o resto", () => {
    const s = trustSummary(list(TRUST_SHOWN_MAX + 3));
    expect(s.shown).toHaveLength(TRUST_SHOWN_MAX);
    expect(s.more).toBe(3);
    expect(s.count).toBe(TRUST_SHOWN_MAX + 3);
  });
});
