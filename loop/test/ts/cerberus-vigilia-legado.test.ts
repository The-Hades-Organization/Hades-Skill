// Checks da Vigília em TypeScript: auditoria (status, gates, capturas, commits, escopo, perguntas) e coerência (registro,
// plano) pela CLI (`hades cerberus-check vigilia/...`), no mesmo registro do orquestrador e em ambiente fechado.
// `gh` e `herdr` são stubs no PATH; o veredito (uma linha JSON) e o código de saída têm de sair iguais ao gravado em
// loop/test/golden/legado/.
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checksRig } from "./lib/checks-rig";
import { legado } from "./lib/legado";
import { shaCitavel as shaCitavelDe } from "./sha-citavel";

const { T, next, git, repo, same, resultado, work } = checksRig(legado(import.meta.path), "vigilia");

const shaCitavel = (wt: string) => shaCitavelDe(wt, git);

const ORCH = join(work, "acme__widget", "orchestration");
mkdirSync(join(ORCH, "agents"), { recursive: true });
mkdirSync(join(ORCH, "consolidations"), { recursive: true });
mkdirSync(join(work, "acme__widget", "locks"), { recursive: true });

interface Reg { name: string; worktree: string; branch: string; base: string; mode: string; state: string; pr: string; pane: string; port: string; createdAt: string }

/** Agente no registro do orquestrador, com a worktree (repositório git) e os arquivos de `.design-sync-reports`. */
function agente(o: { report?: string | null; brief?: string; questions?: string; reg?: Partial<Reg> } = {}) {
  const nome = `ag${next()}`;
  const wt = repo();
  const reports = join(wt, ".design-sync-reports");
  mkdirSync(reports, { recursive: true });
  if (o.report !== null) writeFileSync(join(reports, "report.md"), o.report ?? "STATUS: DONE\n");
  if (o.brief !== undefined) writeFileSync(join(reports, "brief.md"), o.brief);
  if (o.questions !== undefined) writeFileSync(join(reports, "questions.md"), o.questions);
  const base = git(wt, "rev-parse", "HEAD");
  const reg: Reg = { name: nome, worktree: wt, branch: "feature", base, mode: "impl", state: "active", pr: "7", pane: "w1:p1", port: "21290", createdAt: "2000-01-01T00:00:00Z", ...o.reg };
  writeFileSync(join(ORCH, "agents", `${nome}.json`), JSON.stringify(reg));
  return { nome, wt, reg, ctx: { agente: nome } };
}

// o texto do erro do parser de JSON é do Python/Bun: o resto do veredito é idêntico
const semParser = (s: string) => s.replace(/ilegível \((?:Expecting property name enclosed in double quotes: line 1 column 2 \(char 1\)|JSON Parse error: Expected '\}')\)/g, "ilegível (<erro do parser>)");

const done = (a: { wt: string; ctx: Record<string, string> }, args: string[], extra: { env?: Record<string, string> } = {}) => ({ dir: a.wt, momento: "done", ctx: a.ctx, args, ...extra });

describe("uso", () => {
  const d = repo();
  test("sem guarda sai 2 com a lista", () => expect(same("auditoria", { dir: d, args: [] })).toContain("rc=2"));
  test("guarda desconhecida sai 2", () => expect(same("auditoria", { dir: d, args: ["nada"] })).toContain("rc=2"));
  test("guarda a mais sai 2", () => expect(same("coerencia", { dir: d, args: ["registro", "x"] })).toContain("rc=2"));
  test("coerência desconhecida sai 2", () => expect(same("coerencia", { dir: d, args: ["status"] })).toContain("rc=2"));
});

describe("alvos", () => {
  test("done sem agente no contexto avisa", () => expect(resultado(same("auditoria", { dir: repo(), momento: "done", args: ["status"] }))).toBe("aviso"));
  test("agente fora do padrão avisa", () => expect(resultado(same("auditoria", { dir: repo(), momento: "done", ctx: { agente: "../x" }, args: ["status"] }))).toBe("aviso"));
  test("agente sem registro avisa", () => expect(resultado(same("auditoria", { dir: repo(), momento: "done", ctx: { agente: "fantasma" }, args: ["status"] }))).toBe("aviso"));
  test("contexto que não é objeto vira vazio", () => {
    expect(resultado(same("auditoria", { dir: repo(), momento: "done", args: ["status"], env: { CERBERUS_CTX: "[1]" } }))).toBe("aviso");
    expect(resultado(same("auditoria", { dir: repo(), momento: "done", args: ["status"], env: { CERBERUS_CTX: "{nao" } }))).toBe("aviso");
  });
  test("registro ilegível avisa", () => {
    const nome = `ag${next()}`;
    const f = join(ORCH, "agents", `${nome}.json`);
    writeFileSync(f, "{nao");
    try {
      expect(resultado(same("auditoria", { dir: repo(), momento: "done", ctx: { agente: nome }, args: ["status"] }, semParser))).toBe("aviso");
    } finally {
      rmSync(f); // um registro ilegível travaria os testes de consolidação, que leem todos os agentes
    }
  });
  test("registro que não é objeto avisa", () => {
    const nome = `ag${next()}`;
    const f = join(ORCH, "agents", `${nome}.json`);
    writeFileSync(f, "[1]");
    try {
      expect(resultado(same("auditoria", { dir: repo(), momento: "done", ctx: { agente: nome }, args: ["status"] }))).toBe("aviso");
    } finally {
      rmSync(f);
    }
  });
  test("fora do done sem registro do repositório avisa", () => expect(resultado(same("auditoria", { dir: repo("git@github.com:acme/outro.git"), momento: "push", args: ["status"] }))).toBe("aviso"));
  test("consolidação sem registro de membros: todos os não arquivados", () => {
    agente();
    expect(resultado(same("auditoria", { dir: repo(), momento: "consolidar", ctx: { branch: "hades/x" }, args: ["status"] }))).toMatch(/ok|barra|aviso/);
  });
  test("consolidação com membros pelas PRs", () => {
    const a = agente({ reg: { pr: "9101" } });
    const b = agente({ report: "sem status\n", reg: { pr: "9102" } });
    writeFileSync(join(ORCH, "consolidations", "hades_cons.json"), JSON.stringify({ members: [9101, 9102] }));
    expect(resultado(same("auditoria", { dir: repo(), momento: "consolidar", ctx: { branch: "hades/cons" }, args: ["status"] }))).toBe("barra");
    expect(a.nome).not.toBe(b.nome);
  });
  test("registro da consolidação ilegível avisa", () => {
    writeFileSync(join(ORCH, "consolidations", "hades_ruim.json"), "{nao");
    const out = same("auditoria", { dir: repo(), momento: "consolidar", ctx: { branch: "hades/ruim" }, args: ["status"] }, semParser);
    expect(resultado(out)).toBe("aviso");
  });
  test("mesmo agente em dois repositórios: vale o do diretório", () => {
    const nome = `dup${next()}`;
    const outro = join(work, "acme__outro", "orchestration", "agents");
    mkdirSync(outro, { recursive: true });
    const wt = repo();
    mkdirSync(join(wt, ".design-sync-reports"));
    writeFileSync(join(wt, ".design-sync-reports", "report.md"), "STATUS: DONE\n");
    const reg = { name: nome, worktree: wt, branch: "feature", base: "main", mode: "impl", state: "active" };
    writeFileSync(join(ORCH, "agents", `${nome}.json`), JSON.stringify(reg));
    writeFileSync(join(outro, `${nome}.json`), JSON.stringify(reg));
    expect(resultado(same("auditoria", { dir: wt, momento: "done", ctx: { agente: nome }, args: ["status"] }))).toBe("ok");
    expect(resultado(same("auditoria", { dir: repo(""), momento: "done", ctx: { agente: nome }, args: ["status"] }))).toBe("aviso");
  });
});

describe("auditoria status", () => {
  test("DONE passa", () => expect(resultado(same("auditoria", done(agente(), ["status"])))).toBe("ok"));
  test("PARKED barra", () => expect(resultado(same("auditoria", done(agente({ report: "STATUS: PARKED — teto\n" }), ["status"])))).toBe("barra"));
  test("report vazio barra", () => expect(resultado(same("auditoria", done(agente({ report: "" }), ["status"])))).toBe("barra"));
  test("report ausente barra", () => expect(resultado(same("auditoria", done(agente({ report: null }), ["status"])))).toBe("barra"));
  test("pasta de reports configurada", () => {
    const a = agente();
    expect(resultado(same("auditoria", done(a, ["status"], { env: { HADES_ORCH_REPORTS_DIR: "outra" } })))).toBe("barra");
  });
});

describe("auditoria gates", () => {
  const JOURNAL = join(work, "acme__widget", "locks", "gate-journal.tsv");
  const linha = (a: { wt: string }, kind: string, label: string, rc: number, ts = "2026-01-01T00:00:00Z") => `${ts}\tdone\t${kind}\t${label}\t1\t${a.wt}\trc=${rc}\n`;
  test("report sem gate citado passa", () => expect(resultado(same("auditoria", done(agente({ report: "STATUS: DONE\n\nnada\n" }), ["gates"])))).toBe("ok"));
  test("gate citado sem registro barra", () => {
    const a = agente({ report: "STATUS: DONE\n\n- `gate-lock.sh run test --label zz-sem -- bun test` passou\n" });
    expect(resultado(same("auditoria", done(a, ["gates"])))).toBe("barra");
  });
  test("gate citado com rc=0 no journal passa", () => {
    const a = agente({ report: "STATUS: DONE\n\n- `gate-lock.sh run test --label bun-x -- bun test` verde\n" });
    writeFileSync(JOURNAL, linha(a, "test", "bun-x", 0), { flag: "a" });
    expect(resultado(same("auditoria", done(a, ["gates"])))).toBe("ok");
  });
  test("último registro com rc≠0 barra", () => {
    const a = agente({ report: "STATUS: DONE\n\n- pela fila: run test --label bun-y ok\n" });
    writeFileSync(JOURNAL, linha(a, "test", "bun-y", 0) + linha(a, "test", "bun-y", 1, "2026-01-02T00:00:00Z"), { flag: "a" });
    expect(resultado(same("auditoria", done(a, ["gates"])))).toBe("barra");
  });
  test("registro anterior à criação do agente é ignorado", () => {
    const a = agente({ report: "STATUS: DONE\n\n- pela fila: run lint --label bun-z passou\n", reg: { createdAt: "2030-01-01T00:00:00Z" } });
    writeFileSync(JOURNAL, linha(a, "lint", "bun-z", 0), { flag: "a" });
    expect(resultado(same("auditoria", done(a, ["gates"])))).toBe("barra");
  });
  test("kind test casa test:integration", () => {
    const a = agente({ report: "STATUS: DONE\n\n- pela fila: run test --label bun-w passou\n" });
    writeFileSync(JOURNAL, linha(a, "test:integration", "bun-w", 0), { flag: "a" });
    expect(resultado(same("auditoria", done(a, ["gates"])))).toBe("ok");
  });
  test("bloco com falha ou título seguido do corpo", () => {
    same("auditoria", done(agente({ report: "STATUS: DONE\n\n- pela fila: run test falhou, depois ok\n" }), ["gates"]));
    same("auditoria", done(agente({ report: "STATUS: DONE\n\n## Gate (fila)\n\nrun build --label q passou\n" }), ["gates"]));
  });
  test("cerca de código não conta", () => { same("auditoria", done(agente({ report: "STATUS: DONE\n\n```\npela fila: run test passou\n```\n" }), ["gates"])); });
});

describe("auditoria capturas", () => {
  test("sem captura por nome passa", () => expect(resultado(same("auditoria", done(agente({ report: "STATUS: DONE\n\ncapturas: nenhuma\n" }), ["capturas"])))).toBe("ok"));
  test("captura existente passa", () => {
    const a = agente({ report: "STATUS: DONE\n\n- captura `tela.png` da home\n" });
    writeFileSync(join(a.wt, ".design-sync-reports", "tela.png"), "x");
    expect(resultado(same("auditoria", done(a, ["capturas"])))).toBe("ok");
  });
  test("captura ausente barra", () => expect(resultado(same("auditoria", done(agente({ report: "STATUS: DONE\n\n- captura `sumiu.png`\n" }), ["capturas"])))).toBe("barra"));
  test("captura vazia barra", () => {
    const a = agente({ report: "STATUS: DONE\n\n- screenshot docs/vazia.png\n" });
    mkdirSync(join(a.wt, "docs"));
    writeFileSync(join(a.wt, "docs", "vazia.png"), "");
    expect(resultado(same("auditoria", done(a, ["capturas"])))).toBe("barra");
  });
  test("caminho com pasta inexistente avisa", () => expect(resultado(same("auditoria", done(agente({ report: "STATUS: DONE\n\n- captura nada/aqui/x.png\n" }), ["capturas"])))).toBe("aviso"));
  test("molde não é conferido", () => { same("auditoria", done(agente({ report: "STATUS: DONE\n\n- capturas `<pagina>-{antes,depois}.png` e `a*.png`\n" }), ["capturas"])); });
  test("nome solto achado em subpasta", () => {
    const a = agente({ report: "STATUS: DONE\n\n- captura `perdida.webp`\n" });
    mkdirSync(join(a.wt, "deep", "er"), { recursive: true });
    writeFileSync(join(a.wt, "deep", "er", "perdida.webp"), "x");
    expect(resultado(same("auditoria", done(a, ["capturas"])))).toBe("ok");
  });
  test("nome solto herda a pasta de outra captura", () => {
    const a = agente({ report: "STATUS: DONE\n\n- captura `shots/um.png`, `dois.png`\n" });
    mkdirSync(join(a.wt, "shots"));
    writeFileSync(join(a.wt, "shots", "um.png"), "x");
    writeFileSync(join(a.wt, "shots", "dois.png"), "y");
    expect(resultado(same("auditoria", done(a, ["capturas"])))).toBe("ok");
  });
  test("caminho absoluto e ~", () => {
    const a = agente({ report: `STATUS: DONE\n\n- captura ${join(T, "abs.png")} e ~/nao-existe-x.png\n` });
    writeFileSync(join(T, "abs.png"), "x");
    same("auditoria", done(a, ["capturas"]));
  });
});

describe("auditoria commits", () => {
  test("sem commit citado passa", () => expect(resultado(same("auditoria", done(agente({ report: "STATUS: DONE\n\nnada\n" }), ["commits"])))).toBe("ok"));
  test("commit na branch passa", () => {
    const a = agente();
    const sha = shaCitavel(a.wt);
    writeFileSync(join(a.wt, ".design-sync-reports", "report.md"), `STATUS: DONE\n\n- commit \`${sha}\` na branch feature\n`);
    expect(resultado(same("auditoria", done(a, ["commits"])))).toBe("ok");
  });
  test("commit inexistente na branch da unidade barra", () => expect(resultado(same("auditoria", done(agente({ report: "STATUS: DONE\n\n- commit `abc1234def` na branch feature\n" }), ["commits"])))).toBe("barra"));
  test("commit inexistente com outra ref avisa", () => expect(resultado(same("auditoria", done(agente({ report: "STATUS: DONE\n\n- commit `abc1234def` de skill/outra\n" }), ["commits"])))).toBe("aviso"));
  test("commit inexistente com caminho fora da worktree avisa", () => expect(resultado(same("auditoria", done(agente({ report: "STATUS: DONE\n\n- commit `abc1234def` em /opt/outro/repo\n" }), ["commits"])))).toBe("aviso"));
  test("commit fora da branch barra", () => {
    const a = agente();
    git(a.wt, "checkout", "-q", "-b", "lateral");
    writeFileSync(join(a.wt, "l.txt"), "l\n");
    git(a.wt, "add", "l.txt");
    git(a.wt, "commit", "-qm", "lateral");
    const sha = git(a.wt, "rev-parse", "HEAD");
    git(a.wt, "checkout", "-q", "feature");
    writeFileSync(join(a.wt, ".design-sync-reports", "report.md"), `STATUS: DONE\n\n- commit ${sha} sobre a branch feature\n`);
    expect(resultado(same("auditoria", done(a, ["commits"])))).toBe("barra");
  });
  test("objeto que não é commit é ignorado", () => {
    const a = agente();
    const tree = git(a.wt, "rev-parse", "--short", "HEAD^{tree}");
    writeFileSync(join(a.wt, ".design-sync-reports", "report.md"), `STATUS: DONE\n\n- commit ${tree} (árvore)\n`);
    same("auditoria", done(a, ["commits"]));
  });
  test("hash sem a fala de commit e sem dígitos não conta", () => { same("auditoria", done(agente({ report: "STATUS: DONE\n\nversão abc1234def\n\n- commit deadbeef sem dígito? não: dead\n" }), ["commits"])); });
});

describe("auditoria escopo", () => {
  const brief = "## Item\n\n**Arquivos seus (e só estes):** `src/`, `docs/*.md`, `kit/<x>.sh`\n\n**Em voo, não toque:** `lib.sh`, `loop/bin/`\n";
  const comArquivos = (a: ReturnType<typeof agente>, arquivos: Record<string, string>) => {
    for (const [f, t] of Object.entries(arquivos)) {
      mkdirSync(join(a.wt, f, ".."), { recursive: true });
      writeFileSync(join(a.wt, f), t);
    }
    git(a.wt, "add", "-A", "--", ".", ":!.design-sync-reports");
    git(a.wt, "commit", "-qm", "muda");
  };
  test("brief ausente avisa", () => expect(resultado(same("auditoria", done(agente(), ["escopo"])))).toBe("aviso"));
  test("brief sem escopo declarado passa", () => expect(resultado(same("auditoria", done(agente({ brief: "# só texto\n" }), ["escopo"])))).toBe("ok"));
  test("dentro do escopo passa", () => {
    const a = agente({ brief });
    comArquivos(a, { "src/x.ts": "1", "docs/a.md": "2", "kit/y.sh": "3" });
    expect(resultado(same("auditoria", done(a, ["escopo"])))).toBe("ok");
  });
  test("arquivo em não toque barra", () => {
    const a = agente({ brief });
    comArquivos(a, { "lib.sh": "1" });
    expect(resultado(same("auditoria", done(a, ["escopo"])))).toBe("barra");
  });
  test("prefixo proibido barra", () => {
    const a = agente({ brief });
    comArquivos(a, { "loop/bin/z.py": "1" });
    expect(resultado(same("auditoria", done(a, ["escopo"])))).toBe("barra");
  });
  test("fora do escopo sem registro no report barra, registrado avisa", () => {
    const a = agente({ brief });
    comArquivos(a, { "outro/a.txt": "1" });
    expect(resultado(same("auditoria", done(a, ["escopo"])))).toBe("barra");
    const b = agente({ brief, report: "STATUS: DONE\n\naditivo em outro/a.txt\n" });
    comArquivos(b, { "outro/a.txt": "1" });
    expect(resultado(same("auditoria", done(b, ["escopo"])))).toBe("aviso");
  });
  test("base que não resolve avisa", () => expect(resultado(same("auditoria", done(agente({ brief, reg: { base: "naoexiste" } }), ["escopo"])))).toBe("aviso"));
  test("base vazia avisa", () => expect(resultado(same("auditoria", done(agente({ brief, reg: { base: "" } }), ["escopo"])))).toBe("aviso"));
  test("só não toque, nome com extensão casa pelo nome", () => {
    const a = agente({ brief: "**Não toque:** `run.sh`\n" });
    comArquivos(a, { "sub/run.sh": "1" });
    expect(resultado(same("auditoria", done(a, ["escopo"])))).toBe("barra");
  });
});

describe("auditoria perguntas", () => {
  test("sem questions.md passa", () => expect(resultado(same("auditoria", done(agente(), ["perguntas"])))).toBe("ok"));
  test("pergunta aberta com DONE barra", () => expect(resultado(same("auditoria", done(agente({ questions: "## Q1 — x\n\nctx\n" }), ["perguntas"])))).toBe("barra"));
  test("respondida pelo título ou pela seção passa", () => {
    expect(resultado(same("auditoria", done(agente({ questions: "## Q1 — x (respondida)\n" }), ["perguntas"])))).toBe("ok");
    expect(resultado(same("auditoria", done(agente({ questions: "## Q1 — x\n\n## Resposta do dono\n\nfaça\n" }), ["perguntas"])))).toBe("ok");
  });
  test("report fora de DONE não barra", () => expect(resultado(same("auditoria", done(agente({ report: "STATUS: ACTIVE\n", questions: "## Q1 — x\n" }), ["perguntas"])))).toBe("ok"));
  test("muitas abertas são resumidas", () => { same("auditoria", done(agente({ questions: Array.from({ length: 8 }, (_, i) => `## Q${i + 1} — ${"longo ".repeat(30)}\n`).join("\n") }), ["perguntas"])); });
});

describe("coerência registro", () => {
  const herdr = (...ags: Record<string, string>[]) => JSON.stringify({ result: { agents: ags } });
  const viva = (a: { nome: string }, extra: Record<string, string> = {}) => herdr({ name: a.nome, pane_id: "w1:p1", agent_status: "idle", ...extra });
  const prs = (...p: { number: number; state: string; headRefName: string }[]) => JSON.stringify(p);
  const reg = (a: ReturnType<typeof agente>, env: Record<string, string>) => done(a, ["registro"], { env });
  test("tudo confere passa", () => {
    const a = agente();
    expect(resultado(same("coerencia", reg(a, { STUB_HERDR: viva(a), STUB_PRS: prs({ number: 7, state: "OPEN", headRefName: "feature" }) })))).toBe("ok");
  });
  test("worktree inexistente barra", () => {
    const a = agente({ reg: { worktree: join(T, "fantasma") } });
    expect(resultado(same("coerencia", reg(a, { STUB_HERDR: viva(a), STUB_PRS: "[]" })))).toBe("barra");
  });
  test("branch diferente da do registro barra", () => {
    const a = agente({ reg: { branch: "outra" } });
    expect(resultado(same("coerencia", reg(a, { STUB_HERDR: viva(a), STUB_PRS: prs({ number: 7, state: "OPEN", headRefName: "outra" }) })))).toBe("barra");
  });
  test("modo review não confere branch nem base", () => {
    const a = agente({ reg: { mode: "review", branch: "outra" } });
    expect(resultado(same("coerencia", reg(a, { STUB_HERDR: viva(a) })))).toBe("ok");
  });
  test("base sha que não é ancestral barra; ref móvel inexistente avisa", () => {
    const a = agente({ reg: { base: "deadbeef1234" } });
    expect(resultado(same("coerencia", reg(a, { STUB_HERDR: viva(a), STUB_PRS: prs({ number: 7, state: "OPEN", headRefName: "feature" }) })))).toBe("barra");
    const b = agente({ reg: { base: "origin/naoexiste" } });
    expect(resultado(same("coerencia", reg(b, { STUB_HERDR: viva(b), STUB_PRS: prs({ number: 7, state: "OPEN", headRefName: "feature" }) })))).toBe("aviso");
  });
  test("base sha que não é ancestral de HEAD barra", () => {
    const a = agente();
    git(a.wt, "checkout", "-q", "-b", "lat");
    writeFileSync(join(a.wt, "z"), "z");
    git(a.wt, "add", "z");
    git(a.wt, "commit", "-qm", "z");
    const alheia = git(a.wt, "rev-parse", "HEAD");
    git(a.wt, "checkout", "-q", "feature");
    writeFileSync(join(ORCH, "agents", `${a.nome}.json`), JSON.stringify({ ...a.reg, base: alheia }));
    expect(resultado(same("coerencia", reg(a, { STUB_HERDR: viva(a), STUB_PRS: prs({ number: 7, state: "OPEN", headRefName: "feature" }) })))).toBe("barra");
  });
  test("base em ref móvel com ancestral comum passa", () => {
    const a = agente({ reg: { base: "feature" } });
    expect(resultado(same("coerencia", reg(a, { STUB_HERDR: viva(a), STUB_PRS: prs({ number: 7, state: "OPEN", headRefName: "feature" }) })))).toBe("ok");
  });
  test("herdr indisponível ou ilegível avisa", () => {
    const a = agente();
    const env = { STUB_PRS: prs({ number: 7, state: "OPEN", headRefName: "feature" }) };
    expect(resultado(same("coerencia", reg(a, env)))).toBe("aviso");
    expect(resultado(same("coerencia", reg(a, { ...env, STUB_HERDR: "nao-json" })))).toBe("aviso");
    expect(resultado(same("coerencia", reg(a, { ...env, STUB_HERDR: "{}" })))).toBe("aviso");
  });
  test("sessão em outro painel avisa", () => {
    const a = agente();
    expect(resultado(same("coerencia", reg(a, { STUB_HERDR: viva(a, { pane_id: "w9:p9" }), STUB_PRS: prs({ number: 7, state: "OPEN", headRefName: "feature" }) })))).toBe("aviso");
  });
  test("sessão órfã (sem o nome) barra; sem sessão nenhuma avisa", () => {
    const a = agente();
    const env = { STUB_PRS: prs({ number: 7, state: "OPEN", headRefName: "feature" }) };
    expect(resultado(same("coerencia", reg(a, { ...env, STUB_HERDR: herdr({ name: "x", pane_id: "w1:p1" }) })))).toBe("barra");
    expect(resultado(same("coerencia", reg(a, { ...env, STUB_HERDR: herdr({ name: "x", cwd: a.wt }) })))).toBe("barra");
    expect(resultado(same("coerencia", reg(a, { ...env, STUB_HERDR: herdr({ name: "x", pane_id: "w5:p5" }) })))).toBe("aviso");
  });
  test("agente concluído não exige sessão", () => {
    const a = agente({ reg: { state: "done" } });
    expect(resultado(same("coerencia", reg(a, { STUB_HERDR: herdr(), STUB_PRS: prs({ number: 7, state: "MERGED", headRefName: "feature" }) })))).toBe("ok");
  });
  test("PR: ausente, divergente, fechada, mergeada com registro ativo", () => {
    const a = agente();
    const h = { STUB_HERDR: viva(a) };
    expect(resultado(same("coerencia", reg(a, { ...h, STUB_PRS: "[]" })))).toBe("barra");
    expect(resultado(same("coerencia", reg(agente({ reg: { pr: "" } }), { STUB_HERDR: herdr(), STUB_PRS: "[]" })))).toBe("aviso");
    expect(resultado(same("coerencia", reg(a, { ...h, STUB_PRS: prs({ number: 8, state: "OPEN", headRefName: "feature" }) })))).toBe("barra");
    expect(resultado(same("coerencia", reg(a, { ...h, STUB_PRS: prs({ number: 7, state: "CLOSED", headRefName: "feature" }) })))).toBe("barra");
    expect(resultado(same("coerencia", reg(a, { ...h, STUB_PRS: prs({ number: 7, state: "MERGED", headRefName: "feature" }) })))).toBe("aviso");
    expect(resultado(same("coerencia", reg(a, { ...h, STUB_PRS: prs({ number: 7, state: "OPEN", headRefName: "outra" }) })))).toBe("barra");
  });
  test("PR: sem número no registro usa a primeira", () => {
    const a = agente({ reg: { pr: "" } });
    expect(resultado(same("coerencia", reg(a, { STUB_HERDR: viva(a), STUB_PRS: prs({ number: 3, state: "OPEN", headRefName: "feature" }) })))).toBe("ok");
  });
  test("PR: gh falha ou devolve lixo avisa", () => {
    const a = agente();
    expect(resultado(same("coerencia", reg(a, { STUB_HERDR: viva(a), STUB_PRS: "erro" })))).toBe("aviso");
    expect(resultado(same("coerencia", reg(a, { STUB_HERDR: viva(a), STUB_PRS: "lixo" })))).toBe("aviso");
  });
  test("modos skill e review não têm PR; registro sem branch barra", () => {
    const s = agente({ reg: { mode: "skill" } });
    expect(resultado(same("coerencia", reg(s, { STUB_HERDR: viva(s) })))).toBe("ok");
    const v = agente({ reg: { branch: "" } });
    expect(resultado(same("coerencia", reg(v, { STUB_HERDR: viva(v) })))).toBe("barra");
  });
});

describe("coerência plano", () => {
  const planoComEstado = (estado: string | null) => {
    const f = join(T, `plano-${next()}.md`);
    writeFileSync(f, estado === null ? "# Plano\n\n## Objetivo\nx\n" : `# Plano\n\n## Objetivo\nx\n\n## Estado atual\n<!-- modelo -->\n${estado}\n\n## Depois\ny\n`);
    writeFileSync(join(ORCH, "plan.json"), JSON.stringify({ path: f }));
    return f;
  };
  const plano = (a: ReturnType<typeof agente>) => done(a, ["plano"]);
  test("sem plan.json passa", () => {
    rmSync(join(ORCH, "plan.json"), { force: true });
    expect(resultado(same("coerencia", plano(agente())))).toBe("ok");
  });
  test("plan.json ilegível avisa", () => {
    writeFileSync(join(ORCH, "plan.json"), "{nao");
    expect(resultado(same("coerencia", plano(agente()), semParser))).toBe("aviso");
  });
  test("plan.json sem path avisa", () => {
    writeFileSync(join(ORCH, "plan.json"), "{}");
    expect(resultado(same("coerencia", plano(agente()), semParser))).toBe("aviso");
  });
  test("plano apontado inexistente avisa", () => {
    writeFileSync(join(ORCH, "plan.json"), JSON.stringify({ path: join(T, "sumiu-plano.md") }));
    expect(resultado(same("coerencia", plano(agente())))).toBe("aviso");
  });
  test("plano sem Estado atual avisa", () => {
    planoComEstado(null);
    expect(resultado(same("coerencia", plano(agente())))).toBe("aviso");
  });
  test("agente ativo ausente do Estado atual avisa; concluído passa", () => {
    planoComEstado("- outro agente em curso");
    expect(resultado(same("coerencia", plano(agente())))).toBe("aviso");
    expect(resultado(same("coerencia", plano(agente({ reg: { state: "done" } }))))).toBe("ok");
  });
  test("linha do agente confere com painel, porta e PR", () => {
    const a = agente();
    planoComEstado(`- ${a.nome} no w1:p1, porta 21290, PR #7`);
    expect(resultado(same("coerencia", plano(a)))).toBe("ok");
  });
  test("painel, porta e PR divergentes avisam", () => {
    const a = agente();
    planoComEstado(`- ${a.nome} no w9:p9, porta 1234, PR #99`);
    expect(resultado(same("coerencia", plano(a)))).toBe("aviso");
  });
  test("commit citado que não existe avisa; existente passa", () => {
    const a = agente();
    planoComEstado(`- ${a.nome} commit deadbee1234 feito`);
    expect(resultado(same("coerencia", plano(a)))).toBe("aviso");
    planoComEstado(`- ${a.nome} commit ${shaCitavel(a.wt)} feito`);
    expect(resultado(same("coerencia", plano(a)))).toBe("ok");
  });
  test("item com vários agentes é recortado no nome", () => {
    const a = agente();
    const b = agente();
    planoComEstado(`- ${a.nome} PR #7; ${b.nome} PR #55 w4:p4\n  continuação do item`);
    expect(resultado(same("coerencia", plano(a)))).toBe("ok");
  });
  test("modo skill fica fora do Estado atual", () => {
    planoComEstado("- ninguém");
    expect(resultado(same("coerencia", plano(agente({ reg: { mode: "skill" } }))))).toBe("ok");
  });
});

describe("evidência", () => {
  test("muitos itens são cortados no limite do corpo", () => {
    for (let i = 0; i < 12; i++) agente({ report: "sem status\n", reg: { pr: String(9300 + i) } });
    writeFileSync(join(ORCH, "consolidations", "hades_muitos.json"), JSON.stringify({ members: Array.from({ length: 12 }, (_, i) => 9300 + i) }));
    expect(resultado(same("auditoria", { dir: repo(), momento: "consolidar", ctx: { branch: "hades/muitos" }, args: ["status"] }))).toBe("barra");
  });
});
