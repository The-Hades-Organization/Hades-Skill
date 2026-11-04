// Grupo bun-loop: os comandos do loop na CLI hades (project, models, quality, review, review-record, review-anchors,
// pr-loop-state, watch, wait, consolidate, gate-lock). Cada caso roda a CLI e compara saída, código de saída e arquivos de
// estado com o que foi gravado em golden/legado/bun-loop.json.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { legado } from "./lib/legado";
import { procStartTime } from "../../../src/lib/proc";
import { BUN, FX, Rig, SKILL, STUBS, jqS, kv, lines, readJson, sortedJson, writeJson, type Env, type Run, SYS_PATH } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const T = r.T, H = r.H, C = r.C, P = r.P;
const gravado = legado(import.meta.path);
/** as chaves citam caminhos do rig (iguais só dentro de uma rodada): o golden guarda `<T>` no lugar */
const g = { get: <V>(chave: string) => gravado.get<V>(r.norm(chave)) };
const CLI = `${BUN} ${SKILL}/src/cli.ts`;
const NODE_DIR = r.env0.PATH?.split(":")[1] ?? "/usr/bin";
const NOGIT = `${T}/nogit`;
const PATH_STD = `${STUBS}:${NODE_DIR}:${SYS_PATH}`;

const ws = (s: string) => s.split(/\s+/).filter(Boolean);
const rcLine = (o: Run) => `${o.out}rc=${o.rc}`;
const slurp = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const trimEnd = (s: string) => s.replace(/\n+$/, "");
const wr = (p: string, s: string) => writeFileSync(p, s);
const sh = (cmd: string, env: Env = {}, cwd?: string) => r.X(["bash", "-c", cmd], { env, cwd });
const link = (dir: string, names: string[]) => {
  mkdirSync(dir, { recursive: true });
  for (const n of names) if (!existsSync(`${dir}/${n}`)) symlinkSync(Bun.which(n) ?? `/usr/bin/${n}`, `${dir}/${n}`);
  if (!existsSync(`${dir}/bun`)) symlinkSync(BUN, `${dir}/bun`);
};
/** `same`: stdout (sem as linhas HADES_LIB_) com o código, depois o stderr; a ordem entre os dois canais não é contrato. */
function sameOf(o: Run): string {
  const body = (o.out + `rc=${o.rc}`).split("\n").filter((l) => !l.startsWith("HADES_LIB_")).join("\n");
  return r.norm(`${body}\n${trimEnd(o.err)}`);
}
const sameTest = (lbl: string, cmd: string, args: string[], cwd: string, env: Env, newEnv: Env = {}) =>
  test(lbl, () => { expect(sameOf(r.X([...ws(cmd), ...args], { cwd, env: { ...env, ...newEnv } }))).toBe(g.get(lbl)); });
const grepc = (re: RegExp, s: string) => lines(s).filter((l) => re.test(l)).length;

describe("hades-project, hades-models, hades-quality", () => {
  const R = `${T}/packs-bl`, pk = `${R}/example-monorepo`;
  beforeAll(() => {
    cpSync(`${T}/packs`, R, { recursive: true });
    mkdirSync(`${pk}/loop`, { recursive: true }); wr(`${pk}/loop/invariants.md`, "# invariantes\n");
    const p = readJson(`${pk}/profile.json`);
    Object.assign(p, { refs: { invariants: "loop/invariants.md", falta: "loop/falta.md" }, core: ">=4.0 <9", flag: false, vazio: "" });
    p.pr = { ...p.pr, labels: ["backend", "extra"] }; p.stacks = ["nx"];
    writeJson(`${pk}/profile.json`, p);
    mkdirSync(`${T}/bl-bad`, { recursive: true });
    writeJson(`${T}/bl-bad/profile.json`, { ...p, name: "outro", identity: { ...p.identity, repo: "sem barra" }, xx: 1, refs: { ...p.refs, invariants: "../fora.md" } });
  });
  const PE = () => kv({ HADES_PACKS_ROOT: R });

  describe("hades-project: entrada da CLI", () => {
    const SH = `${CLI} project`;
    for (const a of ["resolve", "", "pack", "get name", "get pr.labels", "get identity.repo", "get nao.existe", "get nao.existe padrao", "get flag", "get vazio fallback", "ref invariants", "ref falta", "ref gates", "ref",
                     "core-check", "core-check --version 3.0.0", "core-check --version 99.1", "core-check --bogus", "names", `validate ${pk}/profile.json`, "validate", "bogus",
                     "get nao.existe d", "packs", "patterns", "domain", "domain allow", "stacks", "detect", "step nx:build", "step nx:falta", "step", `core-check --dir ${NOGIT}`]) {
      sameTest(`hades-project.sh ${a || "sem argumento"}: CLI igual ao gravado`, SH, ws(a), C, PE());
    }
    for (const [nome, cwd] of [["plain", P], ["nogit", NOGIT]] as const) {
      for (const a of ["resolve", "pack", "get name x", "ref invariants", "core-check"]) sameTest(`hades-project.sh ${a} (${nome}): CLI igual ao gravado`, SH, ws(a), cwd, PE());
    }
    for (const a of [`validate ${T}/bl-bad/profile.json`, `validate ${SKILL}/quality/base.json`, `validate ${T}/nao-existe.json`]) {
      sameTest(`hades-project.sh ${a}: erros de validação iguais ao gravado`, SH, ws(a), C, PE());
    }
  });

  describe("hades-models: o frontmatter dos subagentes e a saída, com e sem --dry-run", () => {
    const AG = `${H}/.claude/agents`, INST = `${H}/.claude/hades/instance`, idata = `${T}/bl-inst`, snap = `${T}/bl-agents-snap`;
    const stateOf = () => md5(readdirSync(AG).filter((f) => f.endsWith(".md")).sort().map((f) => readFileSync(`${AG}/${f}`, "utf8")).join(""));
    const reset = () => { rmSync(AG, { recursive: true, force: true }); cpSync(snap, AG, { recursive: true }); };
    beforeAll(() => {
      mkdirSync(AG, { recursive: true }); mkdirSync(idata, { recursive: true }); mkdirSync(`${H}/.claude/hades`, { recursive: true });
      wr(INST, idata + "\n");
      wr(`${idata}/config.env`, "HADES_REVIEW_SUBAGENT_MODELS=default=sonnet,review-a=opus,review-d=haiku\nOUTRA=x\n");
      wr(`${AG}/review-a.md`, "---\nname: review-a\nmodel: inherit\ntools: Read\n---\ncorpo a\nmodel: no corpo\n");
      wr(`${AG}/review-b.md`, "---\nname: review-b\ndescription: sem linha model\n---\ncorpo b\n");
      wr(`${AG}/review-c.md`, "sem frontmatter\n");
      wr(`${AG}/review-d.md`, "---\nname: review-d\nmodel: haiku\n---\nigual\n");
      wr(`${AG}/outro.md`, "---\nname: outro\nmodel: x\n---\nnão é review-*\n");
      cpSync(AG, snap, { recursive: true });
    });
    for (const a of ["--dry-run", ""]) {
      test(`hades-models.py ${a || "sem argumento"}: saída e arquivos iguais ao gravado`, () => {
        reset(); const ob = r.hades(["models", ...ws(a)], { merge: true });
        expect(r.norm(`${rcLine(ob)} ${stateOf()}`)).toBe(g.get(`models ${a}`));
      });
    }
    test("hades-models.py: o model: de review-b entrou e o corpo de review-a ficou", () => {
      const b = lines(readFileSync(`${AG}/review-b.md`, "utf8")).find((l) => l.startsWith("model: "))?.slice(7);
      expect(`${b} ${grepc(/^model: no corpo$/, readFileSync(`${AG}/review-a.md`, "utf8"))}`).toBe("sonnet 1");
    });
    afterAll(() => { rmSync(AG, { recursive: true, force: true }); rmSync(snap, { recursive: true, force: true }); rmSync(INST, { force: true }); });
  });

  describe("hades-quality: leitura e escrita contra o original", () => {
    const ch = `${H}/.claude/hades/quality/choices.tsv`, qsnap = `${T}/bl-choices`, RQ = `${T}/packs-bq`;
    const qpack = (readJson(`${SKILL}/quality/packs.json`).packs as { id: string }[])[0]?.id ?? "";
    const fileState = () => `${slurp(ch)}existe=${existsSync(ch) ? "sim" : "não"}`;
    beforeAll(() => {
      cpSync(`${T}/packs`, RQ, { recursive: true });
      const p = readJson(`${RQ}/example-monorepo/profile.json`);
      p.rules = { ...p.rules, quality: [{ id: "ts.sem-any", severity: "bloqueante", note: "o projeto exige mais" }, { id: "py.sem-except-nu", severity: "baixa", note: "o projeto afrouxa" },
        { id: "seg.dependencia-minima", contradicts: true, note: "contradiz" }, { id: "nao.existe", note: "fora do catálogo" }] };
      writeJson(`${RQ}/example-monorepo/profile.json`, p);
      mkdirSync(`${H}/.claude/hades/quality`, { recursive: true });
      if (existsSync(ch)) copyFileSync(ch, qsnap); else wr(qsnap, "");
    });
    for (const a of ["on ts. py.sem-except-nu", "on --group testes", `on --pack ${qpack}`, `off --pack ${qpack}`, "on --all", "off --all", "on nao.existe", "on", "on --group xx", "on --pack xx", "reset ts.sem-any", "reset", "reset nao.existe"]) {
      test(`hades-quality.sh ${a}: saída e choices.tsv iguais ao gravado`, () => {
        copyFileSync(qsnap, ch); const ob = r.hades(["quality", ...ws(a)], { merge: true });
        expect(r.norm(`${rcLine(ob)} ${fileState()}`)).toBe(g.get(`quality escrita ${a}`));
      });
    }
    test("hades-quality.sh on: comentários do dono mantidos e escolha igual ao padrão sai do arquivo, como gravado", () => {
      wr(qsnap, "# comentário do dono\nts.sem-any\ton\nlixo\n");
      copyFileSync(qsnap, ch); r.hades(["quality", "on", "ts.sem-any", "py.sem-except-nu"]);
      expect(slurp(ch)).toBe(g.get("quality on comentários do dono"));
    });
    describe("leituras com as regras ligadas", () => {
      beforeAll(() => { copyFileSync(qsnap, ch); r.hades(["quality", "on", "ts.", "py.", "seg."]); });
      for (const a of ["list", "list --json", "list --group testes --on", "list --off", `list --pack ${qpack}`, "list --pack xx", "packs", "packs --json", "validate", "inject", "inject --phase review", `inject --phase deliver --dir ${C}`,
                       `inject --phase inbox --dir ${NOGIT}`, `conflicts --dir ${C}`, "conflicts", `state --dir ${C}`, "state", "bogus", ""]) {
        sameTest(`hades-quality.sh ${a || "sem argumento"}: CLI igual ao gravado`, `${CLI} quality`, ws(a), C, kv({ HADES_PACKS_ROOT: RQ }));
      }
      test("qualityBlock (o que o agent grava nos briefs) injeta o mesmo bloco que o inject", () => {
        const e = kv({ HADES_PACKS_ROOT: RQ });
        const inj = r.hades(["quality", "inject", "--phase", "review", "--dir", C], { cwd: C, env: e }).out;
        const blk = r.X([BUN, "-e", 'import { qualityBlock } from "./src/lib/agent-project.ts"; process.stdout.write(qualityBlock("review", process.argv[1] ?? ""));', C], { cwd: SKILL, env: e }).out;
        expect(inj).not.toBe("");
        expect(trimEnd(blk)).toBe(trimEnd(inj));
      });
      test("hades_quality.py (biblioteca do painel): `quality packs --json` dá a mesma saída gravada do módulo", () => {
        expect(trimEnd(r.hades(["quality", "packs", "--json"]).out)).toBe(g.get("quality packs --json (módulo)"));
      });
      afterAll(() => { r.hades(["quality", "off", "--all"]); });
    });
    test("hades_ts sem Bun: sai 69 com a instrução do registro", () => {
      const d = `${T}/bl-nobun`; mkdirSync(d, { recursive: true });
      for (const n of ["bash", "awk", "cut", "dirname"]) if (!existsSync(`${d}/${n}`)) symlinkSync(Bun.which(n) ?? `/usr/bin/${n}`, `${d}/${n}`);
      const o = r.X([Bun.which("bash") ?? "bash", "-c", 'HADES_LIB_BUN_ONLY=1 source "$1/loop/bin/lib.sh"; hades_ts project packs', "_", SKILL], { merge: true, env: { PATH: d, HADES_BUN: "" } });
      expect(`${o.rc} ${o.out.includes("dependência ausente: bun") ? "sim" : "não"}`).toBe("69 sim");
    });
  });
});

describe("hades-review: worktree descartável, prompt, registro do histórico e relatório", () => {
  const RV = `${T}/bl-rv`, rg = `${T}/bl-rv-gh`, rvh = `${H}/.claude/hades/reviews`;
  const wtLeft = () => readdirSync(T).filter((f) => f.startsWith("wt-review-7-"));
  const clean = () => { rmSync(rvh, { recursive: true, force: true }); for (const f of wtLeft()) rmSync(`${T}/${f}`, { recursive: true, force: true }); };
  beforeAll(() => {
    mkdirSync(RV, { recursive: true }); mkdirSync(rg, { recursive: true });
    const g = (d: string, ...a: string[]) => r.must(r.git(d, ...a));
    r.must(r.X(["git", "init", "-q", "--bare", "-b", "main", `${RV}/remote.git`])); r.must(r.X(["git", "init", "-q", "-b", "main", `${RV}/src`])); wr(`${RV}/src/a.txt`, "base\n");
    g(`${RV}/src`, "add", "-A"); g(`${RV}/src`, "commit", "-qm", "base"); g(`${RV}/src`, "push", "-q", `${RV}/remote.git`, "main");
    g(`${RV}/src`, "checkout", "-q", "-b", "feat"); wr(`${RV}/src/b.txt`, "pr\n"); g(`${RV}/src`, "add", "-A"); g(`${RV}/src`, "commit", "-qm", "a PR muda b");
    g(`${RV}/src`, "push", "-q", `${RV}/remote.git`, "feat:refs/pull/7/head");
    r.must(r.X(["git", "clone", "-q", `${RV}/remote.git`, `${RV}/wt`]));
    g(`${RV}/wt`, "remote", "set-url", "origin", "https://github.com/o/r.git"); g(`${RV}/wt`, "config", `url.${RV}/remote.git.insteadOf`, "https://github.com/o/r.git");
    const oid = g(`${RV}/src`, "rev-parse", "HEAD").out.trim();
    writeJson(`${rg}/pr-view.json`, { title: "Muda b", author: { login: "dev-x" }, baseRefName: "main", headRefName: "feat", headRefOid: oid, url: "https://github.com/o/r/pull/7", isDraft: false, state: "OPEN" });
    const L = (o: unknown) => JSON.stringify(o);
    wr(`${RV}/claude-ok.jsonl`, [
      L({ type: "system", subtype: "init", session_id: "sess-1" }), "não é json",
      L({ type: "assistant", message: { content: [{ type: "text", text: "  lendo o diff  " }, { type: "tool_use", name: "Bash", input: { command: "git diff main\nmais" } }] } }),
      L({ type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/x/b.txt" } }, { type: "text", text: "do subagente" }] } }),
      L({ type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", input: {} }] } }),
      L({ type: "result", is_error: false, result: "Relatório\nbloqueios: 0\nHADES-REVIEW: verdict=yellow blocking=0 important=2 inline=3 posted=no reviewId=-", total_cost_usd: 0.5, num_turns: 4, duration_ms: 1200,
        modelUsage: { "claude-opus-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.4 }, "claude-sonnet-5-5": { inputTokens: 1, outputTokens: 2 } } }), ""].join("\n"));
    wr(`${RV}/claude-notail.jsonl`, L({ type: "result", is_error: false, result: "sem linha final", usage: { input_tokens: 5, output_tokens: 6 } }) + "\n");
    wr(`${RV}/claude-err.jsonl`, L({ type: "result", is_error: true, subtype: "error_max_turns", result: "parou\nHADES-REVIEW: verdict=red blocking=x important=1 inline=0 posted=yes reviewId=99" }) + "\n");
    wr(`${RV}/claude-vazio.jsonl`, "");
  });
  /** saída, código, registro (sem horas), relatório, chamada do claude e sobras do worktree */
  function rvRun(cmd: string[], jl: string, crc: string, args: string[]): string {
    clean(); wr(`${RV}/claude.log`, "");
    const o = r.X([...cmd, "--wt", `${RV}/wt`, ...args], { merge: true, env: { FAKE_GH_DIR: rg, FAKE_CLAUDE_OUT: jl, FAKE_CLAUDE_RC: crc, FAKE_CLAUDE_LOG: `${RV}/claude.log`, HADES_PANEL_JOB: "job-9" } });
    // o prompt cita o comando do Cerberus e o de registro; a forma do comando é do código e muda, o resto do prompt é o contrato
    const fix = (s: string) => r.norm(s);
    let t = fix(rcLine(o)) + "\n";
    if (existsSync(rvh)) {
      for (const f of readdirSync(rvh).filter((x) => x.endsWith(".json")).sort()) t += jqS(readFileSync(`${rvh}/${f}`, "utf8"), ["started", "ended", "claudePid", "faseDesde"]);
      for (const f of readdirSync(rvh).filter((x) => x.endsWith(".md")).sort()) t += `--- ${f}\n${readFileSync(`${rvh}/${f}`, "utf8")}`;
    }
    t += lines(slurp(`${RV}/claude.log`)).filter((l) => l !== "" && !/^cwd=\S* --version$/.test(l)).map(fix).join("\n") + "\n";
    const wl = lines(trimEnd(r.git(`${RV}/wt`, "worktree", "list").out)).length, refs = r.git(`${RV}/wt`, "for-each-ref", "refs/hades-review").out.split("\n").filter(Boolean).length;
    return lines(t + `worktrees=${wl} refs=${refs}`).filter((l) => !/avaliar comentario|review-record/.test(l)).join("\n");
  }
  const RW = [BUN, `${SKILL}/src/cli.ts`, "review"];
  const base = (cmd: string, model: string, effort: string, id: string, extra: string[] = []) => ["--pr", "7", "--cmd", cmd, "--model", model, "--effort", effort, ...extra, "--id", id];
  const cases: [string, string, string, string[]][] = [
    ["ok", "claude-ok", "0", base("review-pr", "opus", "high", "20260101-000000-aaaa")],
    ["ok-post", "claude-ok", "0", base("review-agents", "sonnet", "low", "20260101-000000-bbbb", ["--post"])],
    ["sem-linha-final", "claude-notail", "0", base("review-pr", "sonnet", "medium", "20260101-000000-cccc")],
    ["erro-do-claude", "claude-err", "1", base("review-pr", "opus", "high", "20260101-000000-dddd")],
    ["claude-sai-3-sem-saida", "claude-vazio", "3", base("review-pr", "opus", "high", "20260101-000000-eeee")],
    ["dry-run", "claude-ok", "0", base("review-agents", "opus", "high", "20260101-000000-ffff", ["--post", "--dry-run"])],
  ];
  for (const [lbl, jl, crc, args] of cases) {
    test(`hades-review.py ${lbl}: saída, registro, relatório e limpeza iguais ao gravado`, () => {
      expect(rvRun(RW, `${RV}/${jl}.jsonl`, crc, args)).toBe(g.get(`review ${lbl}`));
    });
  }
  test("hades-review.py ok: registro com veredito, tokens somados dos modelos e relatório sem a linha final", () => {
    rvRun(RW, `${RV}/claude-ok.jsonl`, "0", base("review-pr", "opus", "high", "20260101-000000-aaaa"));
    const j = readJson(`${rvh}/20260101-000000-aaaa.json`);
    expect(`${j.verdict} ${j.tokens.cacheWrite} ${j.important} ${lines(readFileSync(`${rvh}/20260101-000000-aaaa.md`, "utf8"))[0]}`).toBe("yellow 40 2 Relatório");
  });
  test("hades-review.py JSON do gh sem campo: sai 1 e o registro fica falhou (como o original)", () => {
    const view = readJson(`${rg}/pr-view.json`); delete view.title;
    writeJson(`${rg}/pr-ok.json`, readJson(`${rg}/pr-view.json`)); writeJson(`${rg}/pr-view.json`, view);
    const args = base("review-pr", "opus", "high", "20260101-000000-gggg");
    const ob = grepc(/^rc=1$/, rvRun(RW, `${RV}/claude-ok.jsonl`, "0", args));
    const st = readJson(`${rvh}/20260101-000000-gggg.json`).state;
    writeJson(`${rg}/pr-view.json`, readJson(`${rg}/pr-ok.json`));
    expect(`${g.get("review json sem campo: rc=1 do original")} ${ob} ${st}`).toBe("1 1 falhou");
  });
  for (const a of ["", "--pr 7", "--pr x --wt w --cmd review-pr --model opus --effort high", "--pr 7 --wt w --cmd bogus --model opus --effort high", "--pr 7 --wt w --cmd review-pr --model gpt --effort high",
                   "--pr 7 --wt w --cmd review-pr --model opus --effort extreme", "--pr 7 --wt w --cmd review-pr --model opus --effort high --bogus"]) {
    test(`hades-review.py argumentos '${a || "vazio"}': mesma mensagem de erro e código 2`, () => {
      const f = (cmd: string[]) => { const e = r.X([...cmd, ...ws(a)]); const t = `${e.err}rc=${e.rc}`.replace(/^(hades review|hades-review\.py): /gm, "review: "); return `${lines(t).filter((l) => l.includes("error:")).join("\n")} ${lines(t).at(-1)}`; };
      expect(f(RW)).toBe(g.get(`review argumentos '${a}'`));
    });
  }
  test("hades-review.py sem o claude no PATH (fora do --dry-run): sai 69 com a instrução do registro", () => {
    const d = `${T}/bl-rv-path`; mkdirSync(d, { recursive: true });
    for (const b of ["git", "python3", "bun"]) if (!existsSync(`${d}/${b}`)) symlinkSync(b === "bun" ? BUN : Bun.which(b) ?? `/usr/bin/${b}`, `${d}/${b}`);
    if (!existsSync(`${d}/gh`)) symlinkSync(`${STUBS}/gh`, `${d}/gh`);
    rmSync(rvh, { recursive: true, force: true });
    const o = r.X([...RW, "--wt", `${RV}/wt`, "--pr", "7", "--cmd", "review-pr", "--model", "opus", "--effort", "high", "--id", "20260101-000000-hhhh"], { merge: true, env: { PATH: d, FAKE_GH_DIR: rg } });
    clean();
    expect(`${o.rc} ${o.out.includes("dependência ausente: claude") ? "sim" : "não"}`).toBe("69 sim");
  });
});

describe("pr-review-record e pr-review-anchors: shard e payload", () => {
  const rs = `${T}/bl-rr`, ra = `${T}/bl-ra`;
  beforeAll(() => {
    for (const d of [`${rs}/a`, `${rs}/b`, `${ra}/gh`, `${ra}/scratch/findings`]) mkdirSync(d, { recursive: true });
    wr(`${rs}/seed-old.json`, '{"pr":5,"keep":true,"reviewRounds":2,"version":2}\n'); wr(`${rs}/seed-new.json`, '{"pr":5,"version":3}\n');
    const patch1 = "@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n d\n@@ -20,2 +21,3 @@\n x\n+y\n z\n\\ No newline at end of file";
    writeFileSync(`${ra}/gh/pr-files.json`, JSON.stringify([[{ filename: "src/a.ts", status: "modified", patch: patch1 }, { filename: "img.png", status: "added" }], [{ filename: "src/b.ts", status: "renamed" }]]));
    wr(`${ra}/scratch/findings/findings-pr-9.json`, JSON.stringify({ inline: [{ path: "src/a.ts", line: 2, body: "ok no contexto" }, { path: "src/a.ts", line: 3, start_line: 2, body: "faixa válida" }, { path: "src/a.ts", line: 9, body: "fora do hunk" },
      { path: "src/a.ts", line: 22, start_line: 8, body: "início fora" }, { path: "img.png", line: 1, body: "binário" }, { path: "nao/existe.ts", line: 1, body: "fora do diff" }], outOfHunk: [{ x: 1 }] }));
  });
  for (const [lbl, seed] of [["sem-shard", ""], ["shard-existente", "seed-old.json"], ["versao-futura", "seed-new.json"]] as const) {
    test(`pr-review-record.mjs ${lbl}: saída, código e shard iguais ao gravado`, () => {
      const one = () => {
        for (const f of readdirSync(`${rs}/b`)) rmSync(`${rs}/b/${f}`, { force: true });
        if (seed) copyFileSync(`${rs}/${seed}`, `${rs}/b/pr-5.json`);
        const o = r.hades(["review-record", ...ws("5 0123456789abcdef 4242 yellow 1 2 3 4")], { merge: true, env: { HADES_STATE: `${rs}/b` } });
        const f = `${rs}/b/pr-5.json`;
        return `${rcLine(o)} ${existsSync(f) ? md5(jqS(readFileSync(f, "utf8").replace(/"at":\s*"[^"]*"/, '"at": ""'))) : "-"}`;
      };
      expect(one()).toBe(g.get(`review-record ${lbl}`));
    });
  }
  test("pr-review-record.mjs: a rodada soma e o campo do dono fica", () => {
    const run = () => r.hades(["review-record", ...ws("5 aa 1 green 0 0 0 0")], { env: { HADES_STATE: `${rs}/b` } });
    run(); rmSync(`${rs}/b/pr-5.json`, { force: true }); copyFileSync(`${rs}/seed-old.json`, `${rs}/b/pr-5.json`); run();
    const j = readJson(`${rs}/b/pr-5.json`);
    expect(`${j.reviewRounds} ${j.keep} ${j.review.event}`).toBe("3 true COMMENT");
  });
  test("pr-review-record.mjs fora de repo e sem HADES_STATE: falha com código 1, como o original", () => {
    expect(`rc=${r.hades(["review-record", ...ws("5 aa 1 green 0 0 0 0")], { cwd: NOGIT, env: { HADES_WORK_ROOT: "" } }).rc}`).toBe("rc=1");
  });
  for (const [lbl, decl, args] of [["ok", "3", ["9", "--emit", "@"]], ["sem-emit", "3", ["9"]], ["coleta-incompleta", "5", ["9"]], ["sem-argumento", "3", []]] as const) {
    test(`pr-review-anchors.mjs ${lbl}: saída, código e payload iguais ao gravado`, () => {
      wr(`${ra}/gh/pr-changed-files.txt`, decl + "\n");
      const one = () => {
        rmSync(`${ra}/emit-b.json`, { force: true });
        const argv = args.map((x) => (x === "@" ? `${ra}/emit-b.json` : x));
        const o = r.hades(["review-anchors", ...argv], { merge: true, env: { FAKE_GH_DIR: `${ra}/gh`, HADES_REPO: "o/r", HADES_FINDINGS: `${ra}/scratch` } });
        return r.norm(`${rcLine(o).split("emit-b").join("emit-X")}${slurp(`${ra}/emit-b.json`)}`);
      };
      expect(one()).toBe(g.get(`review-anchors ${lbl}`));
    });
  }
});

describe("pr-loop-state: coleta sem rede (gh falso)", () => {
  const cs = `${T}/bl-cs`, cgl = `${T}/bl-cs-gl`;
  beforeAll(() => {
    // o gravado parte de um state/ vazio (o set_work_dirs do lib.sh antigo o criava antes do stateFixture copiar o fixture)
    mkdirSync(`${T}/work/example__monorepo/state`, { recursive: true }); r.stateFixture(); mkdirSync(cs, { recursive: true }); mkdirSync(cgl, { recursive: true });
    cpSync(existsSync(`${T}/packs-alt`) ? `${T}/packs-alt` : `${FX}/packs-alt`, `${cs}/packs-alt`, { recursive: true });
    wr(`${cs}/legacy.json`, '{"version":2,"handledThreads":{"T_x":{"verdict":"applied","at":"2026-01-01T00:00:00Z"}},"lastClaudeTrigger":{"101":{"at":"x"}}}\n');
    wr(`${cs}/bad.json`, "{nao json"); wr(`${cs}/future.json`, '{"version":9}\n');
    cpSync(`${FX}/collector`, cgl, { recursive: true }); wr(`${cgl}/graphql.json`, '{"errors":[{"message":"boom"},{"message":"dois"}]}\n');
  });
  /** saída (normalizada), código e as chamadas ao gh */
  function csRun(args: string[], o: { cwd?: string; env?: Env; dir?: string } = {}): string {
    const lg = `${T}/bl-cs-b.log`; rmSync(lg, { force: true });
    const x = r.hades(["pr-loop-state", ...args], { cwd: o.cwd ?? C, merge: true, env: { ...o.env, FAKE_GH_LOG: lg, FAKE_GH_DIR: o.dir ?? `${FX}/collector` } });
    return `${r.norm(x.out)}rc=${x.rc}\n${existsSync(lg) ? r.norm(readFileSync(lg, "utf8")) : ""}`;
  }
  const st = `${T}/work/example__monorepo/state`;
  for (const a of ["--json", "", "--json --pr 103 --pr 999", "--pr 999", "--help", "-h", "--bogus", "--json --author dev-a", "--others", "--json --limit 5", "--limit 2", "--json --repo example/monorepo", "--repo semdono",
                   `--json --state ${st}`, `--json --state ${cs}/legacy.json`, `--json --state ${cs}/future.json`, `--json --state ${T}/nao-existe`]) {
    test(`pr-loop-state.mjs ${a || "tabela"}: saída, código e chamadas ao gh iguais ao gravado`, () => {
      expect(csRun(ws(a))).toBe(g.get(`pr-loop-state ${a}`));
    });
  }
  test("pr-loop-state.mjs --state ilegível: os mesmos avisos (a mensagem do JSON.parse é do motor)", () => {
    const kinds = () => {
      const out = csRun(["--json", "--state", `${cs}/bad.json`]);
      const json = out.slice(0, out.indexOf("\nrc=") + 1);
      return JSON.stringify((JSON.parse(json).warnings as { kind: string }[]).map((w) => w.kind));
    };
    expect(kinds()).toBe(g.get("pr-loop-state --state ilegível: tipos dos avisos"));
  });
  for (const a of ["--json", ""]) {
    test(`pr-loop-state.mjs ${a || "tabela"} com o perfil alternativo (token por variável): saída e chamadas iguais`, () => {
      const env = { HADES_PACKS_ROOT: `${cs}/packs-alt`, ZN_TOKEN: "tok-zn" };
      expect(csRun(ws(a), { env })).toBe(g.get(`pr-loop-state perfil alternativo ${a}`));
    });
  }
  test("pr-loop-state.mjs com erro do GraphQL: mesma mensagem e código", () => {
    expect(csRun(["--json"], { dir: cgl })).toBe(g.get("pr-loop-state erro do GraphQL"));
  });
  for (const [nome, cwd] of [["plain", P], ["nogit", NOGIT]] as const) {
    test(`pr-loop-state.mjs em ${nome}: recusa igual ao gravado`, () => {
      expect(csRun(["--json"], { cwd })).toBe(g.get(`pr-loop-state recusa ${nome}`));
    });
  }
  test("pr-loop-state.mjs sem o gh no PATH: sai 69 com a instrução do registro", () => {
    const d = `${T}/bl-cs-path`; link(d, ["git", "python3", "node"]);
    const o = r.X([BUN, `${SKILL}/src/cli.ts`, "pr-loop-state", "--json"], { cwd: C, merge: true, env: { PATH: d } });
    expect(`${o.rc} ${o.out.includes("dependência ausente: gh") ? "sim" : "não"}`).toBe("69 sim");
  });
});

describe("hades-wait: cada subcomando contra o original, com gh e herdr falsos", () => {
  const EB = `${T}/bl-e-bin`, ED = `${T}/bl-e`;
  const pa = `${EB}:${PATH_STD}`;
  const wcmp = (lbl: string, env: Env, args: string[], pre: () => void = () => {}) =>
  // Espera real por construção: HADES_WAIT_MAX é em segundos inteiros, então o piso é 1 s de relógio por caso (era 2 s, 40% do teto de 5 s do bun,
  // que a carga da suíte em paralelo comia); o intervalo curto faz o caso gastar só esse piso, sem tique perdido.
    test(`hades-wait.sh ${lbl}: saída e código iguais ao gravado`, () => {
      pre();
      const run = () => { rmSync(`${ED}/calls`, { force: true }); const o = r.X(["timeout", "30", BUN, `${SKILL}/src/cli.ts`, "wait", ...args], { cwd: C, env: { PATH: pa, ED, HADES_WAIT_EVERY: "0.2", ...env } }); return r.norm(`${o.out}rc=${o.rc}`); };
      expect(run()).toBe(g.get(`wait ${lbl}`));
    });
  const roll = (v: string) => () => wr(`${ED}/roll`, v + "\n");
  const stt = (v: string) => () => wr(`${ED}/state`, v + "\n");
  const MAX = (n: string) => ({ HADES_WAIT_MAX: n });
  beforeAll(() => {
    mkdirSync(EB, { recursive: true }); mkdirSync(ED, { recursive: true });
    wr(`${EB}/gh`, `#!/usr/bin/env bash
case "$1 $2" in
  'pr view') [[ $* == *statusCheckRollup* ]] && cat "$ED/roll" || cat "$ED/state" ;;
  'repo view') [[ -f $ED/norepo ]] && exit 1; echo "example monorepo" ;;
  'api graphql')
    n=$(cat "$ED/calls" 2> /dev/null || echo 0); echo $((n + 1)) > "$ED/calls"
    f=$ED/ids2; [[ $n == 0 ]] && f=$ED/ids1
    while (($#)); do [[ $1 == --jq ]] && { jq -r "$2" "$f"; exit; }; shift; done   # o original filtra no gh; o wrapper lê o JSON inteiro
    cat "$f" ;;
  *) exit 1 ;;
esac
`);
    wr(`${EB}/herdr`, '#!/usr/bin/env bash\n[[ "$1 $2" == "agent wait" ]] && exit 1\necho {}\n'); chmodSync(`${EB}/gh`, 0o755); chmodSync(`${EB}/herdr`, 0o755);
    mkdirSync(`${ED}/ok`, { recursive: true }); wr(`${ED}/ok/herdr`, '#!/usr/bin/env bash\n[[ "$1 $2" == "agent wait" ]] && exit 0\necho {}\n'); chmodSync(`${ED}/ok/herdr`, 0o755);
  });
  wcmp("ci verde", MAX("5"), ["ci", "5"], roll('[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"lint","status":"COMPLETED","conclusion":"SKIPPED"},{"context":"ci/x","state":"SUCCESS"}]'));
  wcmp("ci vermelho", MAX("5"), ["ci", "5"], roll('[{"name":"build","status":"COMPLETED","conclusion":"FAILURE"},{"context":"ci/x","state":"ERROR"},{"name":"t","status":"COMPLETED","conclusion":"TIMED_OUT"}]'));
  wcmp("ci sem checks", MAX("5"), ["ci", "5"], roll("[]"));
  wcmp("ci pendente até o limite", MAX("1"), ["ci", "5"], roll('[{"name":"build","status":"IN_PROGRESS"}]'));
  wcmp("ci com StatusContext pendente", MAX("1"), ["ci", "5"], roll('[{"context":"ci/x","state":"PENDING"}]'));
  wcmp("ci sem resposta do gh", MAX("1"), ["ci", "5"], () => wr(`${ED}/roll`, ""));
  wcmp("merged", MAX("5"), ["merged", "5"], stt("MERGED"));
  wcmp("merged CLOSED", MAX("5"), ["merged", "5"], stt("CLOSED"));
  wcmp("merged ainda aberta", MAX("1"), ["merged", "5"], stt("OPEN"));
  const ids = (reviews: string[], comment: boolean) => `{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[${reviews.map((i) => `{"id":"${i}"}`).join(",")}]},"comments":{"nodes":[${comment ? '{"id":"C1"}' : ""}]},"reviewThreads":{"nodes":[{"comments":{"nodes":[{"id":"T1"}]}}]}}}}}\n`;
  const setIds = () => { wr(`${ED}/ids1`, ids(["R1"], false)); wr(`${ED}/ids2`, ids(["R1", "R2"], true)); };
  wcmp("review", MAX("5"), ["review", "5"], setIds);
  test("hades-wait.sh review: contou os dois ids novos", () => {
    setIds(); rmSync(`${ED}/calls`, { force: true });
    const o = r.X(["timeout", "30", BUN, `${SKILL}/src/cli.ts`, "wait", "review", "5"], { cwd: C, env: { PATH: pa, ED, HADES_WAIT_EVERY: "1", HADES_WAIT_MAX: "5" } });
    expect(`${o.out}rc=${o.rc}`).toBe("REVIEW #5 2 novos\nrc=0");
  });
  wcmp("review sem novidade até o limite", MAX("1"), ["review", "5"], () => { setIds(); copyFileSync(`${ED}/ids1`, `${ED}/ids2`); });
  wcmp("review sem repo", MAX("1"), ["review", "5"], () => { setIds(); copyFileSync(`${ED}/ids1`, `${ED}/ids2`); wr(`${ED}/norepo`, ""); });
  const wtq = () => { rmSync(`${ED}/norepo`, { force: true }); mkdirSync(`${ED}/wt/.design-sync-reports`, { recursive: true }); wr(`${ED}/wt/.design-sync-reports/questions.md`, "## Q1 — a (respondida)\n## Q2 — b\n## Q12 — c\n## Resposta do dono (Q3)\n"); };
  for (const q of ["Q1", "Q2", "Q3", "Q12", "Q4"]) wcmp(`answer ${q}`, MAX("1"), ["answer", `${ED}/wt`, q], wtq);
  wcmp("answer com HADES_ORCH_REPORTS_DIR", { ...MAX("1"), HADES_ORCH_REPORTS_DIR: "outros" }, ["answer", `${ED}/wt2`, "Q1"], () => { mkdirSync(`${ED}/wt2/outros`, { recursive: true }); wr(`${ED}/wt2/outros/questions.md`, "## Q1 — a (respondida)\n"); });
  /** gate_run: um processo de 1 s (ou o pid dado), o GATE e as 15 últimas linhas do sumário */
  const gateRun = (p: string, extra: string[]) => {
    // sleep órfão (o init o recolhe): um filho zumbi do teste ainda responderia ao kill -0 e a espera não acabaria
    const pid = p === "novo" ? r.X(["sh", "-c", "sleep 1 > /dev/null 2>&1 & echo $!"]).out.trim() : p;
    const o = r.hades(["wait", "gate", pid, ...extra], { merge: true });
    return o.out.replace(/GATE [0-9]+/g, "GATE <pid>");
  };
  for (const [p, extra] of [["novo", [`${ED}/sum.txt`]], ["novo", [`${ED}/nao-existe.txt`]], ["novo", []], ["999999", [`${ED}/sum.txt`]]] as const) {
    test(`hades-wait.sh gate (${[p, ...extra].join(" ")}): GATE e as 15 últimas linhas do sumário iguais ao gravado`, () => {
      wr(`${ED}/sum.txt`, Array.from({ length: 20 }, (_, i) => i + 1).join("\n") + "\n");
      expect(r.norm(gateRun(p, [...extra]))).toBe(g.get(`wait gate ${[p, ...extra].join(" ")}`));
    }, 60_000); // o gate espera o processo de 1 s no intervalo de checagem padrão, duas vezes
  }
  wcmp("queue sem ticket", MAX("5"), ["queue", "nenhum"]);
  wcmp("agent (herdr falho: TIMEOUT)", MAX("5"), ["agent", "a1"]);
  wcmp("agent (herdr ok)", MAX("5"), ["agent", "a1", "working"]);
  wcmp("agent (herdr ok, estado padrão)", MAX("5"), ["agent", "a1"], () => { rmSync(`${EB}/herdr`, { force: true }); copyFileSync(`${ED}/ok/herdr`, `${EB}/herdr`); });
  wcmp("sem argumento (uso)", {}, []);
  wcmp("subcomando desconhecido (uso)", {}, ["bogus"]);
  wcmp("ci sem PR", {}, ["ci"]);
  test("hades-wait.sh ci sem o gh no PATH: sai 69 com a instrução do registro", () => {
    const d = `${T}/bl-e-nopath`; link(d, ["git", "awk", "cut", "dirname"]);
    const o = r.X([BUN, `${SKILL}/src/cli.ts`, "wait", "ci", "5"], { cwd: C, merge: true, env: { PATH: d } });
    expect(`${o.rc} ${o.out.includes("dependência ausente: gh") ? "sim" : "não"}`).toBe("69 sim");
  });
});

describe("hades-consolidate: plan, merge (com conflito), verify, comment, ready e after-merge", () => {
  const CB = `${T}/bl-c-bin`, CG = `${T}/bl-c-gh`, CW = `${T}/bl-c-wt`;
  const git = (...a: string[]) => r.git(C, ...a);
  beforeAll(() => {
    for (const d of [CB, CG, CW]) mkdirSync(d, { recursive: true });
    wr(`${CB}/gh`, `#!/usr/bin/env bash
case "$1 $2" in
  'pr view')
    f=$CG/pr-$3.json; [[ -f $f ]] || exit 1
    if [[ $* == *--jq* ]]; then jq -r "\${@: -1}" "$f"; else cat "$f"; fi ;;
  'pr comment' | 'pr edit' | 'pr ready') echo "gh $*" >> "$CG/log" ;;
  *) exit 1 ;;
esac
`);
    chmodSync(`${CB}/gh`, 0o755);
    git("fetch", "-q", "origin");
    for (const [b, conteudo] of [["b1", "one"], ["b2", "two"], ["b3", "conflict"]] as const) {
      git("checkout", "-q", "-b", b, "origin/develop");
      if (b === "b2") wr(`${C}/g.txt`, "dois\n"); else wr(`${C}/f.txt`, conteudo + "\n");
      git("add", "-A"); git("commit", "-qm", b); git("push", "-q", "origin", b);
    }
    git("checkout", "-q", "develop");
    for (const [n, head, base] of [[11, "b1", "develop"], [12, "b2", "develop"], [13, "b3", "develop"], [14, "b2", "b1"]] as const) {
      const oid = git("rev-parse", `origin/${head}`).out.trim();
      writeJson(`${CG}/pr-${n}.json`, { number: n, title: "t", state: "OPEN", isDraft: false, headRefName: head, baseRefName: base, headRefOid: oid, mergeable: "MERGEABLE" });
    }
    writeJson(`${CG}/pr-15.json`, { ...readJson<Record<string, unknown>>(`${CG}/pr-11.json`), state: "MERGED", number: 15 });
  });
  /** a sequência numa worktree nova: saída, códigos e registros */
  function cmons(suf: string): string {
    const script = [BUN, `${SKILL}/src/cli.ts`, "consolidate"], wt = `${CW}/${suf}`, br = `cons-${suf}`;
    rmSync(wt, { recursive: true, force: true }); git("worktree", "add", "-q", "-b", br, wt, "origin/develop");
    let t = "";
    for (const a of ["plan 11 12 13", "plan 99", "merge 11 12", "merge 11 12", "verify 11 12 13", "merge 13", "verify 13", "comment 20 11 12", "ready 20", "after-merge 20 11 12 14 15",
                     "plan", "merge", "verify", "comment", "comment 20", "ready", "after-merge", "plan x", "bogus", "", "comment 20 11 --post=nao"]) {
      const o = r.X(["timeout", "60", ...script, ...ws(a)], { cwd: wt, merge: true, env: { PATH: `${CB}:${PATH_STD}`, CG, HADES_ORCH_PR_ASSIGNEE: "dono-x" } });
      t += `$ ${a}\n${rcLine(o)}\n`;
      if (a === "merge 13") r.git(wt, "merge", "--abort");
    }
    t += `log: ${lines(trimEnd(slurp(`${CG}/log`))).filter((l) => l !== "").length}\n`;
    const st = `${T}/work/example__monorepo/orchestration/consolidations/${br}.json`;
    if (existsSync(st)) { const j = readJson(st); for (const k of ["plannedAt", "mergedAt", "verifiedAt", "head", "worktree", "branch"]) delete j[k]; t += sortedJson(JSON.stringify(j)) + "\n"; }
    return t + r.git(wt, "log", "--format=%s").out.split("\n").filter(Boolean).join("|") + "|\n";
  }
  test("hades-consolidate.sh: plan, merge, verify, comment, ready e after-merge iguais ao gravado", () => {
    expect(cmons("b").split(`${CW}/b`).join("<wt>").split("cons-b").join("<br>")).toBe(g.get("consolidate sequência"));
  });
  test("hades-consolidate.sh: o merge de b1 e b2 entrou e o conflito de b3 foi reportado", () => {
    const merged = grepc(/^Merge remote-tracking branch 'origin\/b[12]'/, r.git(`${CW}/b`, "log", "--format=%s").out);
    expect(`${merged} ${grepc(/^#13: conflito com f.txt/, cmons("c"))}`).toBe("2 1");
  });
  for (const [nome, cwd] of [["plain", P], ["nogit", NOGIT]] as const) {
    test(`hades-consolidate.sh em ${nome}: recusa igual ao gravado`, () => {
      const run = (cmd: string[]) => r.norm(rcLine(r.X([...cmd, "plan", "11"], { cwd, merge: true })));
      expect(run([BUN, `${SKILL}/src/cli.ts`, "consolidate"])).toBe(g.get(`consolidate recusa ${nome}`));
    });
  }
});

// O gate de custo 5 GB só é admitido com MemAvailable >= 5120 MB (a fila mede a memória de verdade; HADES_GATE_MEMCAP=0 só tira o
// teto do cgroup). Máquina com menos que isso (mais folga de 1 GB) nunca admite o gate: o teste não tem o que provar, então é
// PULADO com o motivo no nome, em vez de enfraquecido. Runner do GitHub (16 GB) e máquina de dev folgada rodam.
const GATE5_NEEDS_MB = 5120 + 1024;
const memAvailableMb = (): number => Number(/^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) / 1024;
const gateMemMb = Math.floor(memAvailableMb());
const gate5 = (name: string, fn: () => void) => gateMemMb >= GATE5_NEEDS_MB ? test(name, fn)
  : test.skip(`${name} [pulado: MemAvailable ${gateMemMb} MB < ${GATE5_NEEDS_MB} MB, o gate de custo 5 GB não seria admitido]`, fn);

describe("gate-lock.sh: fila de gates contra o original e concessões concorrentes", () => {
  const GW = [BUN, `${SKILL}/src/cli.ts`, "gate-lock"], GN = `${T}/gl-nogit`;
  const gk = { HADES_GATE_MEMCAP: "0", HADES_GATE_RESERVE_GB: "0", HADES_GATE_PSI_MAX: "100" };
  const BASH = Bun.which("bash") ?? "bash";
  beforeAll(() => { mkdirSync(GN, { recursive: true }); });
  const gate = (script: string[], work: string, args: string[], o: { cwd?: string; env?: Env; merge?: boolean } = {}) =>
    r.X(["timeout", "60", ...script, ...args], { cwd: o.cwd ?? C, merge: o.merge ?? true, env: { ...gk, HADES_WORK_ROOT: work, ...o.env } });
  /** a mesma sequência, saída com código; o journal e o estado vêm depois */
  function gsteps(script: string[], w: string, cwd: string): string {
    const seqs: string[][] = [
      ws("run lint --label demo --timeout 30 -- true"), ["run", "test", "--label", "demo", "--timeout", "30", "--", "sh", "-c", "exit 3"],
      ws("run build --label demo --cost-gb 2 --timeout 30 -- env NX_PARALLEL=9 /usr/bin/true"), ws("run bogus -- true"), ws("run lint --label demo"),
      ws("run lint --cost-gb x -- true"), ws("run lint --priority x -- true"), ws("run lint --timeout x -- true"), ws("run --step node-nx:nada -- true"),
      ws("run lint --bogus -- true"), ["run", "gate", "--label", "g", "--priority", "3", "--", "sh", "-c", "echo $GATE_LOCK_TICKET $JEST_WORKERS $NX_PARALLEL"],
      ["status"], ["peak", "demo"], ["peak"], ["acquire"], ["release"], ["bogus"], [], ["run"]];
    let t = "";
    for (const a of seqs) {
      const o = gate(script, w, a, { cwd });
      const text = o.out.split("\n").map((l) => l.replace(/\/[0-9]{19}-[0-9]+\.t/g, "/<ticket>.t")
        .replace(/MemAvailable [0-9]+ MB/, "MemAvailable <MB>").replace(/PSI some avg10 [0-9]+%/, "PSI <P>")).join("\n");
      t += `$ ${a.join(" ")}\n${text}rc=${o.rc}\n`;
    }
    t += "journal:\n";
    let nfila = 0;
    for (const d of existsSync(w) ? readdirSync(w).sort() : []) {
      const j = `${w}/${d}/locks/gate-journal.tsv`;
      if (existsSync(j)) t += lines(trimEnd(readFileSync(j, "utf8"))).map((l) => (l.includes("\t") ? l.split("\t").slice(1).join("\t") : l)).join("\n").replace(/avail=[0-9]+MB/g, "avail=<MB>").replace(/dur=[0-9]+s/g, "dur=<S>").replace(/waited=[0-9]+/g, "waited=<S>") + "\n";
      if (existsSync(`${w}/${d}/locks/gate-queue`)) nfila += readdirSync(`${w}/${d}/locks/gate-queue`).length;
    }
    return t + `fila: ${nfila}\n`;
  }
  gate5("gate-lock.sh: run, status, peak e erros iguais ao gravado (clone com origin)", () => {
    expect(r.norm(gsteps(GW, `${T}/gl-b`, C).split(`${T}/gl-b`).join("<w>"))).toBe(g.get("gate-lock sequência (clone)"));
  });
  gate5("gate-lock.sh: run, status e erros iguais ao gravado (fora de git: fila _maquina)", () => {
    expect(r.norm(gsteps(GW, `${T}/gl-d`, GN).split(`${T}/gl-d`).join("<w>"))).toBe(g.get("gate-lock sequência (fora de git)"));
  });
  test("gate-lock.sh: o gate herda as chaves do catálogo de Configurações", () => {
    const o = gate(GW, `${T}/gl-e`, ["run", "lint", "--timeout", "30", "--", "sh", "-c", "echo $HADES_GATE_BUDGET_GB"], { merge: false });
    expect(lines(o.out).includes("8") ? "sim" : "não").toBe("sim");
  });
  test("gate-lock.sh: variável exportada vence o padrão do catálogo", () => {
    const o = gate(GW, `${T}/gl-e`, ["run", "lint", "--timeout", "30", "--", "sh", "-c", "echo $HADES_GATE_BUDGET_GB"], { merge: false, env: { HADES_GATE_BUDGET_GB: "3" } });
    expect(trimEnd(o.out)).toBe("3");
  });

  // O segundo gate pesado espera de verdade pelo primeiro (sleep 6): o teto de 5 s do bun não vale para a espera, por isso os timeouts explícitos.
  const bgGate = (script: string[], work: string, label: string, args: string[], order: string) =>
    Bun.spawn([...script, "run", "test", "--label", label, ...args, "--", "sh", "-c", label === "a" ? `sleep 6; echo a >> "$0"` : `echo ${label} >> "$0"`, order],
      { cwd: C, env: { ...r.env0, ...gk, HADES_WORK_ROOT: work }, stdout: "ignore", stderr: "ignore" }).exited;
  const GWORK = `${T}/gl-conc`;
  // Espera o evento (ticket na fila), não um tempo fixo: sob carga o bun de cada gate demora a subir e o sleep fixo corria na frente dele.
  const nTickets = (w: string) => (existsSync(queueOf(w)) ? readdirSync(queueOf(w)).filter((f) => f.endsWith(".t")).length : 0);
  const tickets = async (w: string, n: number) => { for (let i = 0; i < 600 && nTickets(w) < n; i++) await Bun.sleep(50); };
  test("gate-lock.sh (novo/novo): com o gate pesado rodando, o segundo sai 75 e a fila é FIFO: a, b, c", async () => {
    const order = `${T}/gl-order`;
    rmSync(GWORK, { recursive: true, force: true }); wr(order, "");
    const pend = [bgGate(GW, GWORK, "a", ["--timeout", "60"], order)];
    await tickets(GWORK, 1);
    const o = gate(GW, GWORK, ["run", "test", "--label", "b", "--timeout", "0", "--", "true"]);
    expect(`rc=${o.rc} ${o.out.includes("ja ha gate pesado rodando") ? "sim" : "não"}`).toBe("rc=75 sim");
    pend.push(bgGate(GW, GWORK, "b", ["--timeout", "60"], order));
    await tickets(GWORK, 2);
    pend.push(bgGate(GW, GWORK, "c", ["--timeout", "60"], order));
    await Promise.all(pend);
    expect(lines(trimEnd(readFileSync(order, "utf8"))).join(" ")).toBe("a b c");
  }, 90_000);
  // O ticket do original (gravado enquanto ele ainda existia) é o contrato de compatibilidade da fila: a CLI respeita um ticket
  // desse formato (original/novo) e escreve o mesmo conjunto de campos, na mesma ordem (novo/original).
  const queueOf = (work: string) => `${work}/example__monorepo/locks/gate-queue`;
  const ticketKeys = (t: string) => lines(trimEnd(t)).map((l) => l.split("=")[0]);
  const origTicket = () => g.get<string>("gate-lock ticket do original em execução");
  const procStart = (pid: number) => procStartTime(pid) ?? "";
  test("gate-lock.sh (original/novo): ticket do original em execução faz o segundo sair 75", () => {
    const tk = origTicket();
    rmSync(GWORK, { recursive: true, force: true }); mkdirSync(queueOf(GWORK), { recursive: true });
    const holder = Bun.spawn(["sleep", "8"]);
    try {
      const live = tk.split("\n").map((l) => l.startsWith("pid=") ? `pid=${holder.pid}` : l.startsWith("pstart=") ? `pstart=${procStart(holder.pid)}` : l.startsWith("host=") ? `host=${hostname()}` : l.startsWith("clone=") ? `clone=${C}` : l).join("\n");
      wr(`${queueOf(GWORK)}/1-1.t`, live);
      const o = gate(GW, GWORK, ["run", "test", "--label", "b", "--timeout", "0", "--", "true"]);
      expect(`rc=${o.rc} ${o.out.includes("ja ha gate pesado rodando") ? "sim" : "não"}`).toBe("rc=75 sim");
    } finally { holder.kill(); }
  }, 30_000);
  test("gate-lock.sh (novo/original): o ticket novo tem os mesmos campos do original, na mesma ordem", async () => {
    const want = ticketKeys(origTicket());
    rmSync(GWORK, { recursive: true, force: true }); wr(`${T}/gl-order`, "");
    const run = bgGate(GW, GWORK, "a", ["--timeout", "60"], `${T}/gl-order`);
    await tickets(GWORK, 1);
    // o ticket nasce na espera e ganha started/child/childstart na admissão: com a máquina carregada a admissão demora,
    // então a leitura espera o ticket admitido (ou o gate acabar) em vez de pegar o da espera
    const ticketNow = (): string => {
      const files = readdirSync(queueOf(GWORK)).filter((f) => f.endsWith(".t"));
      return files[0] === undefined ? "" : readFileSync(`${queueOf(GWORK)}/${files[0]}`, "utf8");
    };
    let text = ticketNow();
    for (let i = 0; i < 400 && text !== "" && !/^childstart=/m.test(text); i++) { await Bun.sleep(50); text = ticketNow() || text; }
    const got = text === "" ? [] : ticketKeys(text);
    await run;
    expect(got).toEqual(want);
  }, 30_000);
  test("gate-lock.sh: prioridade maior entra antes: a, d, c", async () => {
    const order = `${T}/gl-order`;
    rmSync(GWORK, { recursive: true, force: true }); wr(order, "");
    const pend = [bgGate(GW, GWORK, "a", ["--timeout", "60"], order)];
    await tickets(GWORK, 1);
    pend.push(bgGate(GW, GWORK, "c", ["--timeout", "60"], order));
    await tickets(GWORK, 2);
    pend.push(bgGate(GW, GWORK, "d", ["--priority", "5", "--timeout", "60"], order));
    await Promise.all(pend);
    expect(lines(trimEnd(readFileSync(order, "utf8"))).join(" ")).toBe("a d c");
  }, 90_000);
  gate5("gate-lock.sh: passo dentro de uma concessão gate roda direto e a fila fica vazia no fim", () => {
    const o = gate(GW, `${T}/gl-f`, ["run", "gate", "--timeout", "30", "--", ...GW, "run", "lint", "--timeout", "0", "--", "sh", "-c", "echo ok"], { merge: false });
    const q = `${T}/gl-f/example__monorepo/locks/gate-queue`;
    expect(`${o.out.split("\n").filter(Boolean).join(" ")} ${existsSync(q) ? readdirSync(q).length : 0}`).toBe("ok 0");
  });
  test("gate-lock.sh: ticket órfão em execução é removido e o próximo gate entra", () => {
    const q = `${T}/gl-g/example__monorepo/locks/gate-queue`; mkdirSync(q, { recursive: true });
    wr(`${q}/1-1.t`, `kind=test\nlabel=morto\ncost=5\nheavy=1\nclone=/x\npid=999999\npstart=1\nhost=${hostname()}\nsince=x\nproject=p\nprio=0\nstep=\nsteppar=0\nstate=running\n`);
    const o = gate(GW, `${T}/gl-g`, ["run", "test", "--timeout", "0", "--", "true"], { merge: false });
    expect(`rc=${o.rc} ${grepc(/orphan/, slurp(`${T}/gl-g/example__monorepo/locks/gate-journal.tsv`))}`).toBe("rc=0 1");
  });
  test("gate-lock.sh run sem o flock no PATH: roda, o mutex é o flock(2) da libc", () => {
    const d = `${T}/gl-nopath`; link(d, ["git", "awk", "cut", "dirname", "head", "true"]);
    const o = r.X([...GW, "run", "lint", "--", "true"], { cwd: C, merge: true, env: { PATH: d, HADES_WORK_ROOT: `${T}/gl-h` } });
    expect(`${o.rc} ${o.out.includes("dependência ausente: flock") ? "pede o binário" : "sem pedido"}`).toBe("0 sem pedido");
  });
});
