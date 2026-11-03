// Grupo cerberus-vigilia (reference/cerberus/vigilia.md): cada guarda no ok, no barra/aviso com a evidência certa e na
// falha ao conferir; a cabeça em avisa, barra e off pelo avaliar, no done e na consolidação. Sem rede: gh, herdr e git
// lento falsos num PATH próprio, repositórios em T.
import { afterAll, describe } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL } from "./lib/rig";
import { Cases, json, sub } from "./lib/cerberus";
import { shaCitavel } from "./sha-citavel";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const c = new Cases();

const V = `${r.T}/vig`, CLI = `${SKILL}/src/cli.ts`;
const R = `${V}/repo`, W = `${V}/wt`, O = `${r.T}/work/acme__proj/orchestration`, J = `${r.T}/work/acme__proj/locks/gate-journal.tsv`;
for (const d of [`${V}/bin`, `${V}/lento`, `${O}/agents`, `${O}/consolidations`, `${r.T}/work/acme__proj/locks`]) mkdirSync(d, { recursive: true });
const rw = (p: string, s: string) => writeFileSync(p, s);
const exe = (p: string, s: string) => { writeFileSync(p, s); chmodSync(p, 0o755); };
const git = (d: string, ...a: string[]) => r.git(d, ...a);

// gh e herdr falsos: respondem do arquivo apontado (ausente = falha); VIG_HERDR_SLEEP segura o herdr além do tempo
exe(`${V}/bin/gh`, `#!/usr/bin/env bash
[[ "$1 $2" == 'pr list' && -f \${VIG_GH:-} ]] || { echo 'gh: sem acesso' >&2; exit 1; }
cat "$VIG_GH"
`);
exe(`${V}/bin/herdr`, `#!/usr/bin/env bash
[[ -n \${VIG_HERDR_SLEEP:-} ]] && sleep "$VIG_HERDR_SLEEP"
[[ "$1 $2" == 'agent list' && -f \${VIG_HERDR:-} ]] || { echo 'herdr: fora do ar' >&2; exit 1; }
cat "$VIG_HERDR"
`);
exe(`${V}/lento/git`, "#!/usr/bin/env bash\nsleep 3\n");

// repositório com origin (slug acme__proj), worktree da unidade em feat/x com um commit em src/meu.txt
r.X(["git", "init", "-q", "-b", "main", R]); git(R, "config", "remote.origin.url", "https://example.invalid/acme/proj.git");
mkdirSync(`${R}/src`, { recursive: true }); rw(`${R}/src/meu.txt`, "a\n"); rw(`${R}/src/alheio.txt`, "b\n");
git(R, "add", "-A"); git(R, "commit", "-qm", "base");
const gitOut = (d: string, ...a: string[]) => sub(git(d, ...a).out);
const base = shaCitavel(R, gitOut);
git(R, "worktree", "add", "-q", "-b", "feat/x", W, "main");
appendFileSync(`${W}/src/meu.txt`, "mudou\n"); git(W, "commit", "-qam", "feat: meu");
const c1 = shaCitavel(W, gitOut);
const rep = `${W}/.design-sync-reports`; mkdirSync(`${rep}/shots`, { recursive: true }); rw(`${rep}/shots/tela.png`, "PNG");
const brief = `${rep}/brief.md`, q = `${rep}/questions.md`;
rw(brief, "# Brief\n**Arquivos seus:** `src/meu.txt`, `src/novo/` e `src/<id>.json`.\n\n**Em voo, não toque:** `src/alheio.txt` e `run.sh`.\n");
const relatorio = (primeira = "STATUS: DONE") => rw(`${rep}/report.md`, `${primeira}
Branch \`feat/x\` sobre \`${base}\`: commit \`${c1}\`.

- Regressão pela fila (\`gate-lock.sh run test --label ag-x -- bash t.sh\`): ok, 0 ✗.
- Capturas: \`shots/tela.png\` e o molde \`<pagina>-{390,1280}.png\`.
`);
relatorio();
rw(q, "## Q1 — base\nqual base?\n## Resposta do dono\nmain\n");
const agentJson = `${O}/agents/ag-x.json`;
const agent = { name: "ag-x", mode: "deliver", role: "impl", branch: "feat/x", base, worktree: W, pane: "w9:p1", port: 21999, pr: 7, state: "working", createdAt: "2026-01-01T00:00:00Z" };
rw(agentJson, JSON.stringify(agent));
const jline = (ts: string, label: string, rc: number) => `${ts}\tdone\ttest\t${label}\t4\t${W}\trc=${rc}\tdur=3s\tcmd=bash t.sh\n`;
rw(J, jline("2026-01-02T00:00:00Z", "ag-x", 0));
const plan = `${V}/plan.md`;
rw(plan, `# Plano\n\n## Estado atual\n- **ag-x** — working, w9:p1, porta 21999, PR #7, em ${c1}\n- **outra** — w1:p1\n\n## Objetivo\nx\n`);
const planJson = `${O}/plan.json`;
rw(planJson, JSON.stringify({ path: plan }));
rw(`${V}/gh-ok.json`, '[{"number":7,"state":"OPEN","headRefName":"feat/x"}]\n');
rw(`${V}/herdr-ok.json`, JSON.stringify({ result: { agents: [{ name: "ag-x", pane_id: "w9:p1", agent_status: "working", cwd: W }] } }) + "\n");
rw(`${V}/herdr-sem-nome.json`, JSON.stringify({ result: { agents: [{ pane_id: "w9:p1", agent_status: "working", cwd: W }] } }) + "\n");

const PATH_VIG = r.env0.PATH;
const VE: Record<string, string> = { PATH: `${V}/bin:${PATH_VIG}`, VIG_GH: `${V}/gh-ok.json`, VIG_HERDR: `${V}/herdr-ok.json`, HADES_CERBERUS_VIGILIA_IO_S: "1" };
/** vg <script> <guarda> [<agente>] [VAR=valor…]: "<resultado>|<evidência dos achados não-ok>". */
const vg = (script: string, guarda: string, ag = "ag-x", ...vars: string[]): string => {
  const extra = Object.fromEntries(vars.map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
  const o = r.X([BUN, CLI, "cerberus-check", `vigilia/${script}`, guarda], { env: { ...VE, ...extra, CERBERUS_MOMENTO: "done", CERBERUS_DIR: W, CERBERUS_CTX: JSON.stringify({ agente: ag }) } });
  const j = json(o.out);
  return `${j.resultado}|${j.evidencia.filter((e: { conferido: string }) => e.conferido.startsWith("[")).map((e: { conferido: string }) => e.conferido).join(" ; ")}`;
};
const has = (label: string, resultado: string, trecho: string, saida: string) => {
  const ev = saida.slice(saida.indexOf("|") + 1);
  c.want(label, `${resultado} 1`, `${saida.slice(0, saida.indexOf("|"))} ${ev.includes(trecho) ? 1 : `0: ${ev}`}`);
};
const setAgent = (patch: Record<string, unknown>) => rw(agentJson, JSON.stringify({ ...agent, ...patch }));

// status
c.want("status: report em DONE passa", "ok|", vg("auditoria", "status"));
relatorio("STATUS: PARKED — gate");
has("status: report sem DONE barra com a primeira linha", "barra", "não é STATUS: DONE", vg("auditoria", "status"));
relatorio();
has("status: agente sem registro vira aviso (não conferido)", "aviso", "não conferido: agente fantasma sem registro", vg("auditoria", "status", "fantasma"));

// gates
c.want("gates: verde citado com rc=0 da worktree passa", "ok|", vg("auditoria", "gates"));
appendFileSync(J, jline("2026-01-03T00:00:00Z", "ag-x", 1));
has("gates: último registro com rc=1 barra", "barra", "último registro (kind test, label ag-x) saiu rc=1", vg("auditoria", "gates"));
rw(J, jline("2026-01-02T00:00:00Z", "outro", 0));
has("gates: sem registro do label citado barra", "barra", "sem registro done (kind test, label ag-x)", vg("auditoria", "gates"));
rw(J, jline("2025-12-31T00:00:00Z", "ag-x", 0));
has("gates: registro anterior à criação do agente não conta", "barra", "desde 2026-01-01T00:00:00Z", vg("auditoria", "gates"));
chmodSync(J, 0o000);
has("gates: journal ilegível vira aviso", "aviso", "não conferido: gate-journal ilegível", vg("auditoria", "gates"));
chmodSync(J, 0o644); rw(J, jline("2026-01-02T00:00:00Z", "ag-x", 0));

// capturas
c.want("capturas: citada existe passa (molde não é conferido)", "ok|", vg("auditoria", "capturas"));
appendFileSync(`${rep}/report.md`, "- Captura nova: `shots/sumiu.png`.\n");
has("capturas: citada e ausente barra", "barra", "captura citada não existe: shots/sumiu.png", vg("auditoria", "capturas"));
relatorio(); rw(`${rep}/shots/tela.png`, "");
has("capturas: citada e vazia barra", "barra", "captura citada está vazia", vg("auditoria", "capturas"));
rw(`${rep}/shots/tela.png`, "PNG"); chmodSync(`${rep}/report.md`, 0o000);
has("capturas: report ilegível vira aviso", "aviso", "não conferido: leitura falhou", vg("auditoria", "capturas"));
chmodSync(`${rep}/report.md`, 0o644);

// commits
c.want("commits: citado na branch passa", "ok|", vg("auditoria", "commits"));
appendFileSync(`${rep}/report.md`, "- Commit extra na branch `feat/x`: `deadbee1`.\n");
has("commits: citado inexistente barra", "barra", "commit citado deadbee1 não existe", vg("auditoria", "commits"));
relatorio(); appendFileSync(`${rep}/report.md`, "- Commit do pacote, branch `feat/pacote` em `~/pacotes/acme`: `deadbee1`.\n");
has("commits: hash de outro repositório citado é só aviso", "aviso", "(o trecho cita feat/pacote)", vg("auditoria", "commits"));
relatorio(); appendFileSync(`${rep}/report.md`, "- Commit da entrega na branch `feat/x`:\n  hash do service worker `deadbee1` na linha de baixo.\n");
has("commits: hash em linha que não fala de commit (bloco fala) vira aviso, não barra", "aviso", "deadbee1 em linha que não fala de commit", vg("auditoria", "commits"));
relatorio();
has("commits: git que passa do tempo vira aviso", "aviso", "não conferido: git passou de 1 s", vg("auditoria", "commits", "ag-x", `PATH=${V}/lento:${V}/bin:${PATH_VIG}`));

// escopo
c.want("escopo: só arquivos seus passa", "ok|", vg("auditoria", "escopo"));
appendFileSync(`${W}/src/alheio.txt`, "x\n"); git(W, "commit", "-qam", "fix: alheio");
has('escopo: arquivo de "não toque" barra', "barra", "tocou src/alheio.txt", vg("auditoria", "escopo"));
git(W, "reset", "-q", "--hard", "HEAD~1"); rw(`${W}/src/extra.txt`, "y\n"); git(W, "add", "src/extra.txt"); git(W, "commit", "-qm", "feat: extra");
has("escopo: fora da lista e sem registro barra", "barra", 'src/extra.txt fora de "Arquivos seus", sem registro', vg("auditoria", "escopo"));
appendFileSync(`${rep}/report.md`, "- Acréscimo em `src/extra.txt` (aditivo).\n");
has("escopo: fora da lista registrado no report é aviso", "aviso", "registrado no report", vg("auditoria", "escopo"));
git(W, "reset", "-q", "--hard", "HEAD~1"); relatorio();
setAgent({ base: "naoexiste" });
has("escopo: base que não resolve vira aviso", "aviso", "base naoexiste não resolve", vg("auditoria", "escopo"));
setAgent({});

// perguntas
c.want("perguntas: respondida passa", "ok|", vg("auditoria", "perguntas"));
appendFileSync(q, "## Q2 — porta\nqual porta?\n");
has("perguntas: DONE com pergunta aberta barra", "barra", "Q2 — porta", vg("auditoria", "perguntas"));
chmodSync(q, 0o000);
has("perguntas: questions.md ilegível vira aviso", "aviso", "não conferido: leitura falhou", vg("auditoria", "perguntas"));
chmodSync(q, 0o644); rw(q, "## Q1 — base (respondida)\nmain\n");

// registro × git, herdr, GitHub
c.want("registro: branch, base, sessão e PR conferem", "ok|", vg("coerencia", "registro"));
has("registro: sessão no herdr sem o nome barra", "barra", "nome perdido", vg("coerencia", "registro", "ag-x", `VIG_HERDR=${V}/herdr-sem-nome.json`));
rw(`${V}/gh-outra.json`, '[{"number":8,"state":"OPEN","headRefName":"feat/x"}]\n');
has("registro: PR do registro diferente da do GitHub barra", "barra", "registro aponta a PR #7", vg("coerencia", "registro", "ag-x", `VIG_GH=${V}/gh-outra.json`));
git(W, "checkout", "-q", "-b", "feat/y");
has("registro: worktree em outra branch barra", "barra", "registro diz branch feat/x, a worktree está em feat/y", vg("coerencia", "registro"));
git(W, "checkout", "-q", "feat/x");
has("registro: gh indisponível vira aviso", "aviso", "não conferido: gh pr list saiu 1", vg("coerencia", "registro", "ag-x", "VIG_GH="));
has("registro: herdr que passa do tempo vira aviso", "aviso", "não conferido: herdr passou de 1 s", vg("coerencia", "registro", "ag-x", "VIG_HERDR_SLEEP=3"));

// plano × registro
const sedPlan = (f: (l: string) => string) => rw(plan, readFileSync(plan, "utf8").split("\n").map(f).join("\n"));
c.want("plano: Estado atual confere com o registro", "ok|", vg("coerencia", "plano"));
sedPlan((l) => l.replace("w9:p1", "w8:p1"));
has("plano: painel divergente é aviso", "aviso", "o plano cita o painel w8:p1, o registro diz w9:p1", vg("coerencia", "plano"));
sedPlan((l) => l.replace("w8:p1", "w9:p1").replace(/- \*\*ag-x\*\*.*/, "- **zz** — w9:p1"));
has("plano: agente ativo fora do Estado atual é aviso", "aviso", "não aparece no Estado atual", vg("coerencia", "plano"));
rw(planJson, JSON.stringify({ path: "/nao/existe.md" }));
has("plano: plan.json apontando arquivo ausente vira aviso", "aviso", "que não existe", vg("coerencia", "plano"));
rw(planJson, JSON.stringify({ path: plan }));
rw(plan, `# Plano\n\n## Estado atual\n- **ag-x** — working, w9:p1, porta 21999, PR #7, em ${c1}\n`);

// avaliar: a cabeça em avisa (padrão), barra e off; done e consolidação
const av = (momento: string, vars: Record<string, string>, ...args: string[]): string => {
  const o = r.X([BUN, CLI, "cerberus", "avaliar", momento, "--cabeca", "vigilia", "--json", ...args], { env: { ...VE, ...vars } });
  const j = json(o.out);
  return `${o.rc} ${j.resultado} ${j.barras} ${j.avisos} ${j.ignoradas.join(",")}`;
};
const hist = `${r.T}/work/_maquina/cerberus/vereditos.jsonl`;
const n0 = existsSync(hist) ? (readFileSync(hist, "utf8").match(/\n/g) ?? []).length : 0;
c.want("avaliar done: tudo confere, nenhum barra nem aviso", "0 ok 0 0 ", av("done", {}, "--dir", W, "--ctx", "agente=ag-x"));
c.want("avaliar done: as 8 guardas da vigília no histórico", 8,
  readFileSync(hist, "utf8").split("\n").slice(n0).filter(Boolean).map((l) => json(l)).filter((h) => h.cabeca === "vigilia" && h.origem === "avaliar").length);
relatorio("STATUS: PARKED");
c.want("avaliar done em avisa: o barra vira aviso e passa", "0 aviso 0 1 ", av("done", {}, "--dir", W, "--ctx", "agente=ag-x"));
c.want("avaliar done em barra: o barra barra (exit 1)", "1 barra 1 0 ", av("done", { HADES_CERBERUS_VIGILIA: "barra" }, "--dir", W, "--ctx", "agente=ag-x"));
c.want("avaliar done em off: a cabeça não roda", "0 ok 0 0 vigilia", av("done", { HADES_CERBERUS_VIGILIA: "off" }, "--dir", W, "--ctx", "agente=ag-x"));
relatorio();
rw(`${O}/consolidations/cons_x.json`, JSON.stringify({ branch: "cons/x", members: [7] }));
c.want("avaliar consolidação: membros pela PR do registro, tudo ok", "0 ok 0 0 ", av("consolidacao", {}, "--dir", R, "--ctx", "pr=9", "--ctx", "branch=cons/x"));
appendFileSync(q, "## Q3 — aberta\n");
c.want("avaliar consolidação em barra: membro com pergunta aberta barra", "1 barra 1 0 ", av("consolidacao", { HADES_CERBERUS_VIGILIA: "barra" }, "--dir", R, "--ctx", "pr=9", "--ctx", "branch=cons/x"));

describe("cerberus-vigilia", () => c.register());
