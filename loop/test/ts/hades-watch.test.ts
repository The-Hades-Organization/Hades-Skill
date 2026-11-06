// Grupo hades-watch: eventos do `hades watch --next` (agentes de projeto e unidades da skill), contra o gh e o herdr falsos.
// Saída, estado visto, registros e chamadas ao gh comparados com golden/legado/hades-watch.json. Saiu do bun-loop para rodar
// sozinho sob `bun test --parallel`: cada caso sai na primeira varredura, sem esperar o `timeout` matar o vigia.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { legado } from "./lib/legado";
import { shaCitavel } from "./sha-citavel";
import { BUN, Rig, SKILL, STUBS, lines, sortedJson, type Run, SYS_PATH } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const T = r.T, H = r.H, C = r.C;
const gravado = legado(import.meta.path);
/** as chaves citam caminhos do rig (iguais só dentro de uma rodada): o golden guarda `<T>` no lugar */
const g = { get: <V>(chave: string) => gravado.get<V>(r.norm(chave)) };
const NODE_DIR = r.env0.PATH?.split(":")[1] ?? "/usr/bin";
const NOGIT = `${T}/nogit`;
const PATH_STD = `${STUBS}:${NODE_DIR}:${SYS_PATH}`;
const rcLine = (o: Run) => `${o.out}rc=${o.rc}`;
const slurp = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const trimEnd = (s: string) => s.replace(/\n+$/, "");
const wr = (p: string, s: string) => writeFileSync(p, s);
const link = (dir: string, names: string[]) => {
  mkdirSync(dir, { recursive: true });
  for (const n of names) if (!existsSync(`${dir}/${n}`)) symlinkSync(Bun.which(n) ?? `/usr/bin/${n}`, `${dir}/${n}`);
  if (!existsSync(`${dir}/bun`)) symlinkSync(BUN, `${dir}/bun`);
};
const grepc = (re: RegExp, s: string) => lines(s).filter((l) => re.test(l)).length;

describe("hades-watch: eventos de agentes de projeto e de unidade da skill", () => {
  const WB = `${T}/bl-w-bin`, WT = `${T}/bl-w-wt`, WG = `${T}/bl-w-gh.json`;
  const key = (p: string) => p.replace(/[/.]/g, "-");
  function wunit(root: string, reg: string, nome: string, modo: string, estado: string, prompted: string, pr: string, branch = ""): void {
    const d = `${root}/${reg}/orchestration/agents`; mkdirSync(d, { recursive: true }); mkdirSync(`${WT}/${nome}/.design-sync-reports`, { recursive: true });
    const o: Record<string, unknown> = { name: nome, mode: modo, role: "impl", worktree: `${WT}/${nome}`, state: estado };
    if (prompted !== "—") o.promptedAt = prompted;
    if (pr !== "—") o.pr = Number(pr);
    if (branch !== "") o.branch = branch;
    writeFileSync(`${d}/${nome}.json`, JSON.stringify(o));
  }
  beforeAll(() => {
    mkdirSync(WB, { recursive: true }); mkdirSync(WT, { recursive: true });
    wr(`${WB}/gh`, `#!/usr/bin/env bash
for a in "$@"; do [[ $a == query=* ]] || printf '%s ' "$a"; done >> "$WGH_LOG"; echo >> "$WGH_LOG"
case "$1 $2" in
  'pr list') cat "$WGH_PRLIST" ;;
  'api graphql') cat "$WGH_JSON" ;;
  *) exit 1 ;;
esac
`);
    chmodSync(`${WB}/gh`, 0o755);
    wr(`${T}/bl-w-prlist`, "55\n");
    wr(WG, '{"data":{"repository":{"pullRequest":{"state":"MERGED","reviews":{"nodes":[{"id":"R1"}]},"comments":{"nodes":[{"id":"C1"}]},"reviewThreads":{"nodes":[{"comments":{"nodes":[{"id":"T1"}]}}]}}}}}\n');
    for (const d of ["wp-q", "wp-done", "wp-park", "wp-ctx", "ws-q"]) mkdirSync(`${WT}/${d}/.design-sync-reports`, { recursive: true });
    wr(`${WT}/wp-q/.design-sync-reports/questions.md`, "## Q1 — a\nx\n## Q2 — b (respondida)\ny\n");
    r.X(["git", "init", "-q", "-b", "main", `${WT}/wp-done`]); r.git(`${WT}/wp-done`, "commit", "-q", "--allow-empty", "-m", "entrega");
    const shaDone = shaCitavel(`${WT}/wp-done`, (d, ...a) => r.git(d, ...a).out.trim());
    wr(`${WT}/wp-done/.design-sync-reports/report.md`, `STATUS: DONE\nCommit \`${shaDone}\`.\n- \`bun test x.test.ts\` passou.\n`);
    wr(`${WT}/wp-park/.design-sync-reports/handoff.md`, "STATUS: PARKED — teto de contexto\n");
    utimesSync(`${WT}/wp-park/.design-sync-reports/handoff.md`, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
    wr(`${WT}/ws-q/.design-sync-reports/questions.md`, "## Q1 — da skill\nx\n");
    const pd = `${H}/.claude/projects/${key(`${WT}/wp-ctx`)}`; mkdirSync(pd, { recursive: true });
    wr(`${pd}/s.jsonl`, '{"type":"assistant","message":{"usage":{"input_tokens":300000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n');
  });
  /** registros e estado visto de partida (tudo novo a cada rodada) */
  function wprep(root: string): void {
    for (const p of [root, `${root}-st`, `${root}-gh.log`]) rmSync(p, { recursive: true, force: true });
    mkdirSync(`${root}-st`, { recursive: true });
    const t = "2026-01-02T00:00:00Z";
    wunit(root, "example__monorepo", "wp-q", "deliver", "working", t, "7", "b/q"); wunit(root, "example__monorepo", "wp-done", "deliver", "working", t, "8", "b/done");
    wunit(root, "example__monorepo", "wp-new", "deliver", "working", t, "—", "b/new"); wunit(root, "example__monorepo", "wp-park", "deliver", "working", t, "—");
    wunit(root, "example__monorepo", "wp-stall", "deliver", "working", t, "—"); wunit(root, "example__monorepo", "wp-ctx", "deliver", "working", t, "—");
    wunit(root, "example__monorepo", "wp-arq", "deliver", "archived", t, "9", "b/arq"); wunit(root, "example__monorepo", "wp-rev", "review", "working", "—", "—", "b/rev");
    wunit(root, "_skill", "ws-q", "skill", "working", "—", "—", "skill/ws-q");
    wr(`${root}-st/wp-q.ids`, "R1\n"); wr(`${root}-st/wp-stall.idle`, `${Math.floor(Date.now() / 1000) - 3600}\n`);
  }
  /** saída, código, estado visto, registros e chamadas ao gh */
  function wrun(root: string, cwd: string): string {
    const o = r.X(["timeout", "60", BUN, `${SKILL}/src/cli.ts`, "watch", "--next", "1"], { cwd, merge: true, env: {
      PATH: `${WB}:${PATH_STD}`, HADES_WORK_ROOT: root, HADES_WATCH_STATE: `${root}-st`, HADES_ORCH_STALL_MIN: "5",
      FAKE_HERDR_AGENTS: '{"result":{"agents":[{"name":"wp-stall","agent_status":"idle"},{"name":"wp-q","agent_status":"working"}]}}',
      WGH_LOG: `${root}-gh.log`, WGH_PRLIST: `${T}/bl-w-prlist`, WGH_JSON: WG } });
    let t = rcLine(o) + "\n";
    for (const f of readdirSync(`${root}-st`).sort()) t += `${f}=${trimEnd(readFileSync(`${root}-st/${f}`, "utf8"))}\n`;
    for (const d of readdirSync(root).sort()) {
      const ad = `${root}/${d}/orchestration/agents`;
      if (existsSync(ad)) for (const f of readdirSync(ad).sort()) t += `${d}/orchestration/agents/${f}=${sortedJson(readFileSync(`${ad}/${f}`, "utf8"))}\n`;
    }
    return t + slurp(`${root}-gh.log`);
  }
  const eventos = (s: string) => lines(s).filter((l) => /^(QUESTION|DONE|PR-OPEN|REVIEW|MERGED|CLOSED|PARKED|CTX-OVER|STALLED) /.test(l));
  const wnorm = (s: string) => lines(r.norm(s)).map((l) => l.replace(/^(STALLED [^ ]+) [0-9]+$/, "$1 <min>").replace(/^(wp-(?:stall\.idle|done\.done))=.*/, "$1=<epoch>").split("bl-w-b").join("bl-w-a")).filter((l) => l !== "--version ").join("\n");
  for (const [nome, wd] of [["monorepo", C], ["nogit", NOGIT]] as const) {
    test(`hades-watch.sh em ${nome}: eventos, estado visto, registros e chamadas ao gh iguais ao gravado`, () => {
      wprep(`${T}/bl-w-b`);
      expect(wnorm(wrun(`${T}/bl-w-b`, wd))).toBe(wnorm(g.get<string>(`watch ${nome}`)));
    });
    test(`hades-watch.sh em ${nome}: segunda rodada não repete evento já visto`, () => {
      // um agente novo com QUESTION faz o `--next` sair na primeira varredura (sem esperar o `timeout` matar o vigia)
      wunit(`${T}/bl-w-b`, "_skill", "wp-novo", "skill", "working", "—", "—", "skill/wp-novo");
      wr(`${WT}/wp-novo/.design-sync-reports/questions.md`, "## Q1 — novo\nx\n");
      expect(eventos(wrun(`${T}/bl-w-b`, wd))).toEqual(["QUESTION wp-novo 1"]);
    });
  }
  test("hades-watch.sh: unidade da skill só aparece no escopo certo (fora de repo e no clone: registro único)", () => {
    wprep(`${T}/bl-w-c`);
    const a = grepc(/^QUESTION ws-q 1$/, wrun(`${T}/bl-w-c`, NOGIT));
    wprep(`${T}/bl-w-c`);
    const b = grepc(/^QUESTION ws-q 1$/, wrun(`${T}/bl-w-c`, C));
    expect(`${a} ${b}`).toBe("1 1");
  });
  test("hades-watch.sh sem o herdr no PATH: sai 69 com a instrução do registro", () => {
    for (const x of readdirSync(T).filter((f) => /^bl-w-[abc]/.test(f))) rmSync(`${T}/${x}`, { recursive: true, force: true });
    const d = `${T}/bl-w-nopath`; link(d, ["git", "awk", "cut", "dirname"]);
    const o = r.X([BUN, `${SKILL}/src/cli.ts`, "watch", "--next", "1"], { cwd: C, merge: true, env: { PATH: d } });
    expect(`${o.rc} ${o.out.includes("dependência ausente: herdr") ? "sim" : "não"}`).toBe("69 sim");
  });
});
