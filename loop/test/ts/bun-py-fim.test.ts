// Grupo bun-py-fim: o hook do guard em TypeScript (`bun src/hook.ts`), sobre as mesmas entradas de antes: mesma decisão (código de
// saída e mensagem) e mesmos arquivos de estado, conforme gravado em golden/legado/bun-py-fim.json.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { legado } from "./lib/legado";
import { BUN, FX, Rig, SKILL } from "./lib/rig";
import { hookCases } from "./lib/hook";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const T = r.T;
const g = legado(import.meta.path);
const wr = (p: string, s: string) => writeFileSync(p, s);

/** HOME próprio por ponta: o estado do hook (checagens repetidas) não pode vazar de uma para a outra. */
function homeOf(name: string): string {
  const h = `${T}/home-${name}`;
  mkdirSync(`${h}/.claude/skills`, { recursive: true });
  if (!existsSync(`${h}/.claude/skills/hades`)) symlinkSync(SKILL, `${h}/.claude/skills/hades`);
  return h;
}

describe("hook em TypeScript", () => {
  const dirs = r.hookDirs();
  const bun = [BUN, `${SKILL}/src/hook.ts`];

  for (const file of ["cases.tsv", "cases-defeitos.tsv"]) {
    test(`decisões de ${file}`, () => {
      expect(r.norm(hookCases(r, `${FX}/hook/${file}`, dirs, { HOME: homeOf(`b-${file}`) }, bun))).toBe(g.get(`decisões ${file}`));
    });
  }

  test("arquivos de estado do hook (checagens e teto de contexto) são os mesmos", () => {
    const state = (home: string) => {
      const d = `${home}/.claude/hades/guard`;
      return readdirSync(d).sort().map((n) => `${n}=${JSON.stringify(Object.keys(JSON.parse(readFileSync(`${d}/${n}`, "utf8")) as object).sort())}`).join("\n");
    };
    expect(state(`${T}/home-b-cases.tsv`)).toBe(g.get("estado do hook (chaves dos arquivos)"));
  });

  test("context <cwd> devolve o contexto da sessão mais recente do diretório", () => {
    const cwd = `${T}/ctx-dir`, proj = `${T}/home-ctx/.claude/projects/${cwd.replace(/[/.]/g, "-")}`;
    mkdirSync(proj, { recursive: true }); mkdirSync(cwd, { recursive: true });
    wr(`${proj}/s.jsonl`, `{"type":"user"}\n${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 70, cache_creation_input_tokens: 3 } } })}\nlixo\n`);
    const run = (argv: string[]) => r.X([...argv, "context", cwd], { env: { HOME: `${T}/home-ctx` } });
    expect(g.get("context <cwd>")).toBe("78\n");
    expect(run(bun).out).toBe("78\n");
    // sem sessão nenhuma: 0
    expect(r.X([...bun, "context", `${T}/nada`], { env: { HOME: `${T}/home-ctx` } }).out).toBe("0\n");
  });

  test("stdin que não é JSON não barra nem escreve", () => {
    const o = r.X(bun, { stdin: "isto não é json", env: { HOME: `${T}/home-ctx` } });
    expect([o.rc, o.out, o.err]).toEqual([0, "", ""]);
  });

  test("leitura grande: cat, head e sed de faixa grande sobre arquivo acima do limite avisam, sem barrar", () => {
    const big = `${T}/grande.txt`;
    wr(big, "x".repeat(40 * 1024));
    const cases = [`cat ${big}`, `head -n 500 ${big}`, `sed -n '1,900p' ${big}`, `cat ${big} | wc -l`, `head -5 ${big}`, `cat "${big}`, `tail -500 ${big} && echo ok`];
    for (const cmd of cases) {
      const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "g1", cwd: T, tool_name: "Bash", tool_input: { command: cmd } });
      const a = g.get<[number, string, string]>(`leitura grande: ${cmd.replace(big, "<big>")}`);
      const b = r.X(bun, { stdin: payload, env: { HOME: homeOf("g-b") } });
      expect([b.rc, r.norm(b.out), r.norm(b.err)]).toEqual(a);
    }
    const read = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "g1", cwd: T, tool_name: "Read", tool_input: { file_path: big } });
    expect(r.norm(r.X(bun, { stdin: read, env: { HOME: homeOf("g-b") } }).out)).toBe(g.get("leitura grande: Read"));
  });
});
