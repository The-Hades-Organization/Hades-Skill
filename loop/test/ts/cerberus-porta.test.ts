// Grupo cerberus-porta (reference/cerberus/porta.md): cada guarda no ok, no barra (ou aviso) com a evidência certa e na
// falha ao conferir; mais a cabeça em avisa e em off pelo `avaliar`. gh falso no PATH, repositórios temporários, sem rede.
import { afterAll, describe } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BUN, Rig, SKILL, STUBS, SYS_PATH } from "./lib/rig";
import { Cases, json, sub } from "./lib/cerberus";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const c = new Cases();

const NODE_DIR = dirname(Bun.which("node") ?? "/usr/bin/node");
const PATH_STD = `${STUBS}:${NODE_DIR}:${SYS_PATH}`;
const P = `${r.T}/porta`, PB = `${P}/bin`, PACKS = `${P}/packs`;
mkdirSync(PACKS, { recursive: true }); mkdirSync(PB, { recursive: true });
let penv: Record<string, string> = {};

// gh falso: responde do ambiente (GH_LOGIN, GH_LOGIN_TOKEN, GH_HEAD, GH_PROTECTED); GH_FAIL=1 falha tudo
writeFileSync(`${PB}/gh`, `#!/usr/bin/env bash
[[ \${GH_FAIL:-0} == 1 ]] && { echo "sem rede (gh falso)" >&2; exit 1; }
case "$1 $2" in
  "api user") [[ -n \${GH_TOKEN:-} && -n \${GH_LOGIN_TOKEN:-} ]] && echo "$GH_LOGIN_TOKEN" || echo "\${GH_LOGIN:-ativa}" ;;
  "pr view") echo "\${GH_HEAD:-}" ;;
  "api repos"*) echo "\${GH_PROTECTED:-false}" ;;
  *) case "$2" in repos/*) echo "\${GH_PROTECTED:-false}" ;; *) exit 1 ;; esac ;;
esac
`);
chmodSync(`${PB}/gh`, 0o755);

/** pg <guarda> <dir> <momento> [chave=valor…]: roda o script da guarda como o motor roda (cwd, CERBERUS_*, contexto em JSON). */
const pg = (guarda: string, dir: string, momento: string, ...kv: string[]): string => {
  const ctx = Object.fromEntries(kv.map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
  return sub(r.X([BUN, `${SKILL}/src/cli.ts`, "cerberus-check", `porta/${guarda}`], {
    cwd: dir, env: { PATH: `${PB}:${PATH_STD}`, HADES_PACKS_ROOT: PACKS, CERBERUS_DIR: dir, CERBERUS_SKILL: SKILL, CERBERUS_MOMENTO: momento, CERBERUS_CTX: JSON.stringify(ctx), ...penv },
  }).out);
};
const pr_ = (v: string): string => json(v).resultado;
const pe_ = (v: string): string => json(v).evidencia.map((e: { conferido: string }) => e.conferido).join(" | ");
const git = (d: string, ...a: string[]) => r.git(d, ...a);
const rw = (p: string, s: string) => writeFileSync(p, s);

/** Clone com origin (bare) e branch feat/x rastreando origin/feat/x. */
const portaRepo = (nome: string): string => {
  const d = `${P}/${nome}`;
  r.X(["git", "init", "-q", "--bare", "-b", "main", `${d}.git`]);
  r.X(["git", "init", "-q", "-b", "main", d]); git(d, "remote", "add", "origin", `${d}.git`);
  rw(`${d}/a.txt`, "a\n");
  git(d, "add", "-A"); git(d, "commit", "-qm", "base"); git(d, "push", "-q", "origin", "main");
  git(d, "checkout", "-q", "-b", "feat/x"); git(d, "push", "-q", "-u", "origin", "feat/x");
  return d;
};
// montado em execução: a guarda de nome do release também lê loop/test
const PROJ = ["zyx", "proj"].join("-");
const OWNER = ["q", "w", "v"].join("");
const profile = (v: Record<string, unknown>) => rw(`${PACKS}/${PROJ}/profile.json`, JSON.stringify({ schema: "hades.profile/1", name: PROJ, ...v }, null, 2) + "\n");

const rp = portaRepo("a");
let v: string;

// -- upstream-push
v = pg("upstream-push", rp, "push", "head=feat/x"); c.want("upstream = branch da PR: ok", "ok", pr_(v));
c.has("ok cita o upstream", pe_(v), "@{upstream} = origin/feat/x");
v = pg("upstream-push", rp, "push", "head=feat/y"); c.want("upstream de outra branch: barra", "barra", pr_(v));
c.has("barra cita as duas branches", pe_(v), "headRefName da PR = feat/y");
penv = { GH_HEAD: "feat/y" }; v = pg("upstream-push", rp, "push", "pr=7"); c.want("headRefName pelo gh pr view: barra", "barra", pr_(v));
c.has("cita a PR lida", pe_(v), "PR #7"); penv = {};
git(rp, "branch", "-q", "--set-upstream-to=origin/main", "feat/x");
v = pg("upstream-push", rp, "push", "head=feat/x"); c.want("branch rastreando a base: barra", "barra", pr_(v));
c.has("cita origin/main", pe_(v), "origin/main");
git(rp, "branch", "-q", "--set-upstream-to=origin/feat/x", "feat/x");
git(rp, "checkout", "-q", "-b", "feat/novo"); git(rp, "branch", "-q", "--unset-upstream", "feat/novo");
v = pg("upstream-push", rp, "push", "head=feat/novo"); c.want("sem upstream, mesmo nome da PR: ok", "ok", pr_(v));
v = pg("upstream-push", rp, "push", "head=feat/outro"); c.want("sem upstream, nome diferente: barra", "barra", pr_(v));
v = pg("upstream-push", rp, "push"); c.want("sem PR no contexto: aviso", "aviso", pr_(v));
penv = { GH_FAIL: "1" }; v = pg("upstream-push", rp, "push", "pr=7"); c.want("gh sem rede: aviso (não ok)", "aviso", pr_(v));
c.has("diz o que faltou", pe_(v), "não consegui ler o headRefName da PR #7");
penv = {}; git(rp, "checkout", "-q", "feat/x");

// -- remote-push
v = pg("remote-push", rp, "push"); c.want("remote normal: ok", "ok", pr_(v));
git(rp, "config", "remote.origin.pushurl", "no_push");
v = pg("remote-push", rp, "push"); c.want("pushurl no_push: barra", "barra", pr_(v));
c.has("cita a url", pe_(v), "url de push do remote origin = no_push");
git(rp, "config", "--unset", "remote.origin.pushurl");
git(rp, "config", "branch.feat/x.pushRemote", "no_push");
v = pg("remote-push", rp, "push"); c.want("pushRemote da branch = no_push: barra", "barra", pr_(v));
git(rp, "config", "--unset", "branch.feat/x.pushRemote");
git(rp, "config", "branch.feat/x.pushRemote", "fantasma");
v = pg("remote-push", rp, "push"); c.want("remote inexistente: barra", "barra", pr_(v));
git(rp, "config", "--unset", "branch.feat/x.pushRemote");
const n = `${P}/sem-remote`; r.X(["git", "init", "-q", "-b", "main", n]); git(n, "commit", "-q", "--allow-empty", "-m", "x");
v = pg("remote-push", n, "push"); c.want("sem remote configurado: aviso", "aviso", pr_(v));

// -- branch-protegida (perfil com base e conta)
mkdirSync(`${PACKS}/${PROJ}`, { recursive: true });
profile({ identity: { repo: `${OWNER}/${PROJ}`, gh: { user: "dono-gh" } }, flow: { kind: "pr", base: "trunk-x" } });
git(rp, "remote", "set-url", "origin", `https://example.invalid/${OWNER}/${PROJ}.git`);
git(rp, "remote", "set-url", "--push", "origin", `${P}/a.git`);
v = pg("branch-protegida", rp, "push"); c.want("branch de feature desprotegida: ok", "ok", pr_(v));
c.has("cita a base do perfil", pe_(v), "flow.base) = trunk-x");
penv = { GH_PROTECTED: "true" }; v = pg("branch-protegida", rp, "push"); c.want("branch protegida no GitHub: barra", "barra", pr_(v));
c.has("cita a proteção", pe_(v), "feat/x protegida no GitHub");
penv = {}; git(rp, "branch", "-q", "--set-upstream-to=origin/main", "feat/x");
v = pg("branch-protegida", rp, "push"); c.want("destino main: barra pelo nome de tronco", "barra", pr_(v));
git(rp, "config", "branch.feat/x.merge", "refs/heads/trunk-x");
v = pg("branch-protegida", rp, "push"); c.want("destino = base do projeto: barra", "barra", pr_(v));
c.has("cita a base", pe_(v), "trunk-x");
git(rp, "config", "branch.feat/x.merge", "refs/heads/feat/x");
penv = { GH_FAIL: "1" }; v = pg("branch-protegida", rp, "push"); c.want("gh sem rede: aviso", "aviso", pr_(v));
c.has("diz o que faltou", pe_(v), "não consegui ler a proteção de feat/x");
penv = {};

// -- conta-gh
penv = { GH_LOGIN: "dono-gh" }; v = pg("conta-gh", rp, "push"); c.want("conta ativa = a do perfil: ok", "ok", pr_(v));
penv = { GH_LOGIN: "outra" }; v = pg("conta-gh", rp, "push"); c.want("conta ativa diferente: barra", "barra", pr_(v));
c.has("cita as duas contas", pe_(v), "conta que empurra = outra, perfil declara dono-gh");
penv = { GH_FAIL: "1" }; v = pg("conta-gh", rp, "push"); c.want("gh sem rede: aviso", "aviso", pr_(v));
profile({ identity: { repo: `${OWNER}/${PROJ}`, gh: { tokenEnv: "PORTA_TOK" } }, flow: { kind: "pr", base: "trunk-x" } });
penv = { GH_LOGIN: "ativa" }; v = pg("conta-gh", rp, "push"); c.want("tokenEnv ausente no ambiente: barra", "barra", pr_(v));
c.has("cita a variável", pe_(v), "PORTA_TOK vazia ou ausente");
penv = { PORTA_TOK: "t0", GH_LOGIN_TOKEN: "conta-do-token" }; v = pg("conta-gh", rp, "push"); c.want("tokenEnv presente: ok, com a conta do token", "ok", pr_(v));
c.has("cita a conta do token", pe_(v), "conta que empurra = conta-do-token");
profile({ identity: { repo: `${OWNER}/${PROJ}` }, flow: { kind: "pr", base: "trunk-x" } });
penv = {}; v = pg("conta-gh", rp, "push"); c.want("perfil sem conta declarada: aviso", "aviso", pr_(v));

// -- segredo-diff
git(rp, "checkout", "-q", "feat/x"); git(rp, "branch", "-q", "--set-upstream-to=origin/feat/x", "feat/x");
v = pg("segredo-diff", rp, "push"); c.want("nada a sair: ok", "ok", pr_(v));
rw(`${rp}/cfg.txt`, `token = "ghp_${"a".repeat(36)}"\nok=1\n`);
appendFileSync(`${rp}/cfg.txt`, `-----BEGIN ${"R"}SA PRIVATE KEY-----\n`);
rw(`${rp}/env.example`, 'API_KEY="exemplo-de-chave-longa-aaaaaaaa"\n');
git(rp, "add", "-A"); git(rp, "commit", "-qm", "seg");
v = pg("segredo-diff", rp, "push"); c.want("token e chave no diff: barra", "barra", pr_(v));
c.has("cita arquivo e linha", pe_(v), "cfg.txt:1");
c.has("cita a chave privada", pe_(v), "chave privada em cfg.txt:3");
c.has("mascara o valor", pe_(v), "ghp_…(40 caracteres)");
c.want("o segredo não vai inteiro à evidência", 0, pe_(v).includes("aaaaaaaaaaaa") ? 1 : 0);
c.want("marcador de exemplo não é segredo", 0, pe_(v).includes("env.example") ? 1 : 0);
v = pg("segredo-diff", rp, "release", "range=HEAD~1..HEAD"); c.want("release com intervalo do contexto: barra", "barra", pr_(v));
rw(`${rp}/grande.txt`, "linha sem segredo\n".repeat(150_000));
git(rp, "add", "-A"); git(rp, "commit", "-qm", "grande");
v = pg("segredo-diff", rp, "release", "range=HEAD~1..HEAD"); c.want("diff acima de 1 MB: lê e dá ok", "ok", pr_(v));
git(rp, "push", "-q", "origin", "feat/x");
v = pg("segredo-diff", rp, "push"); c.want("já empurrado, nada novo a sair: ok", "ok", pr_(v));
git(rp, "branch", "-q", "--unset-upstream", "feat/x"); git(rp, "checkout", "-q", "main"); git(rp, "checkout", "-q", "--detach", "HEAD");
v = pg("segredo-diff", n, "push"); c.want("sem delimitar o que sai: aviso", "aviso", pr_(v));
v = pg("segredo-diff", rp, "push", "range=nao-existe..HEAD"); c.want("intervalo inválido: barra com o erro", "barra", pr_(v));

// -- nome-dominio
const s = `${P}/skill`; r.skillCopy(s);
v = pg("nome-dominio", rp, "release"); c.want("fora do núcleo da skill: ok, com o motivo", "ok", pr_(v));
renameSync(`${PACKS}/${PROJ}`, `${P}/${PROJ}.off`);
v = pg("nome-dominio", s, "release"); c.want("sem perfil instalado: aviso", "aviso", pr_(v));
c.has("diz que não há perfil", pe_(v), "nenhum perfil instalado");
renameSync(`${P}/${PROJ}.off`, `${PACKS}/${PROJ}`);
v = pg("nome-dominio", s, "release"); c.want("núcleo limpo com perfil: ok", "ok", pr_(v));
appendFileSync(`${s}/reference/projects.md`, `referência a ${PROJ} num texto do núcleo\n`);
v = pg("nome-dominio", s, "release"); c.want("núcleo cita o projeto: barra", "barra", pr_(v));
c.has("cita o arquivo", pe_(v), "reference/projects.md");
if (git(s, "checkout", "-q", "--", ".").rc !== 0) copyFileSync(`${SKILL}/reference/projects.md`, `${s}/reference/projects.md`);
rw(`${PACKS}/${PROJ}/domain-terms.txt`, "termo-do-dominio\n");
{ const pj = json(readFileSync(`${PACKS}/${PROJ}/profile.json`, "utf8")); pj.domainTerms = "domain-terms.txt"; rw(`${PACKS}/${PROJ}/profile.json`, JSON.stringify(pj, null, 2) + "\n"); }
appendFileSync(`${s}/reference/projects.md`, "usa termo-do-dominio aqui\n");
v = pg("nome-dominio", s, "release"); c.want("núcleo cita termo de domínio: barra", "barra", pr_(v));
c.has("cita a guarda de domínio", pe_(v), "guarda de domínio");

// -- plano-aprovado
const w = `${P}/work`; mkdirSync(`${w}/${OWNER}__${PROJ}/orchestration`, { recursive: true }); penv = { HADES_WORK_ROOT: w };
git(rp, "remote", "set-url", "origin", `https://example.invalid/${OWNER}/${PROJ}.git`);
v = pg("plano-aprovado", rp, "release"); c.want("sem registro: barra", "barra", pr_(v));
c.has("diz o que procurou", pe_(v), `${w}/${OWNER}__${PROJ}/orchestration/plan.json`);
const pl = `${P}/plan.md`; rw(pl, "# Plano\n\n## Objetivo\nx\n\n## Estado atual\nantes\n");
/** awk: tudo menos a seção "## Estado atual"; sha256 em hex. */
const planSha = (file: string): string => {
  let skip = false, keep = "";
  for (const l of readFileSync(file, "utf8").split("\n").slice(0, -1)) { if (l.startsWith("## ")) skip = /^## Estado atual[ \t\n\r\f\v]*$/.test(l); if (!skip) keep += l + "\n"; }
  return createHash("sha256").update(keep).digest("hex");
};
const planJson = `${w}/${OWNER}__${PROJ}/orchestration/plan.json`;
rw(planJson, JSON.stringify({ path: pl, sha: planSha(pl), approvedAt: "2026-01-01T00:00:00Z" }));
v = pg("plano-aprovado", rp, "release"); c.want("plano aprovado e íntegro: ok", "ok", pr_(v));
c.has("cita a hora da aprovação", pe_(v), "2026-01-01T00:00:00Z");
v = pg("plano-aprovado", rp, "consolidacao"); c.want("mesma guarda na consolidação: ok", "ok", pr_(v));
appendFileSync(pl, "## Estado atual\ndepois\n");
v = pg("plano-aprovado", rp, "release"); c.want("só o Estado atual mudou: ainda ok", "ok", pr_(v));
appendFileSync(pl, "\n## Objetivo novo\ny\n");
v = pg("plano-aprovado", rp, "release"); c.want("plano mudou depois da aprovação: barra", "barra", pr_(v));
c.has("cita a mudança", pe_(v), "mudou depois da aprovação");
rw(planJson, "{\n");
v = pg("plano-aprovado", rp, "release"); c.want("registro ilegível: barra", "barra", pr_(v));
v = pg("plano-aprovado", rp, "release", `plano=${P}/nao-existe.json`); c.want("plano do contexto ausente: barra", "barra", pr_(v));
penv = {};

// -- momentos comentario e artefato (segredo-diff por texto= e arquivo=)
rw(`${P}/comentario.md`, `olhe o log\nficou assim: ghp_${"b".repeat(36)}\n`);
v = pg("segredo-diff", rp, "comentario", `texto=${P}/comentario.md`); c.want("comentário com token: barra", "barra", pr_(v));
c.has("cita o arquivo e a linha", pe_(v), "comentario.md:2");
rw(`${P}/limpo.md`, "sem nada sensível\n");
v = pg("segredo-diff", rp, "comentario", `texto=${P}/limpo.md`); c.want("comentário limpo: ok", "ok", pr_(v));
v = pg("segredo-diff", rp, "comentario", `texto=${P}/nao-existe.md`); c.want("texto inexistente: barra", "barra", pr_(v));
mkdirSync(`${P}/art/sub`, { recursive: true }); rw(`${P}/art/a.html`, "x=1\n"); copyFileSync(`${P}/comentario.md`, `${P}/art/sub/b.js`);
v = pg("segredo-diff", rp, "artefato", `arquivo=${P}/art`); c.want("artefato (pasta) com token: barra", "barra", pr_(v));
c.has("cita o arquivo da pasta", pe_(v), "b.js:2");
v = pg("segredo-diff", rp, "artefato", `arquivo=${P}/art/a.html`); c.want("artefato (arquivo) limpo: ok", "ok", pr_(v));

// -- tunel-acesso (momento tunel)
const th = "HADES_CERBERUS_PORTA_TUNEL_HOSTS";
penv = { [th]: "*.exemplo.invalid" }; v = pg("tunel-acesso", rp, "tunel", "host=https://abc.exemplo.invalid/x", "acesso=autenticado"); c.want("host na lista, autenticado: ok", "ok", pr_(v));
v = pg("tunel-acesso", rp, "tunel", "host=abc.exemplo.invalid", "acesso=anonimo"); c.want("acesso anônimo: barra", "barra", pr_(v));
v = pg("tunel-acesso", rp, "tunel", "host=abc.exemplo.invalid"); c.want("acesso não declarado: barra", "barra", pr_(v));
v = pg("tunel-acesso", rp, "tunel", "host=abc.fora.invalid", "acesso=autenticado"); c.want("host fora da lista: barra", "barra", pr_(v));
c.has("cita host e lista", pe_(v), "host abc.fora.invalid fora da lista (*.exemplo.invalid)");
v = pg("tunel-acesso", rp, "tunel", "acesso=autenticado"); c.want("sem host: barra", "barra", pr_(v));
penv = { [th]: "" }; v = pg("tunel-acesso", rp, "tunel", "host=abc.exemplo.invalid", "acesso=autenticado"); c.want("lista vazia fecha: barra", "barra", pr_(v));
c.has("diz que a lista está vazia", pe_(v), "lista de hosts permitidos vazia");
rw(`${PB}/devtunnel`, '#!/usr/bin/env bash\n[[ ${DT_FAIL:-0} == 1 ]] && exit 1\necho "${DT_ACCESS:-Scope: tunnel ports\n  user@x  Connect}"\n'); chmodSync(`${PB}/devtunnel`, 0o755);
penv = { [th]: "*.exemplo.invalid", DT_ACCESS: "Anonymous  Connect" }; v = pg("tunel-acesso", rp, "tunel", "host=a.exemplo.invalid", "tunel=hades"); c.want("devtunnel lista acesso anônimo: barra", "barra", pr_(v));
penv = { [th]: "*.exemplo.invalid", DT_ACCESS: "user  Connect" }; v = pg("tunel-acesso", rp, "tunel", "host=a.exemplo.invalid", "tunel=hades"); c.want("devtunnel sem anônimo: ok", "ok", pr_(v));
penv = { [th]: "*.exemplo.invalid", DT_FAIL: "1" }; v = pg("tunel-acesso", rp, "tunel", "host=a.exemplo.invalid", "tunel=hades"); c.want("devtunnel falhou: aviso", "aviso", pr_(v));
penv = {};

// -- plano-aprovado: by
const pl2 = `${P}/plan2.md`; rw(pl2, "## Objetivo\nx\n");
const sha2 = createHash("sha256").update(readFileSync(pl2)).digest("hex");
rw(`${P}/plan2.json`, JSON.stringify({ path: pl2, sha: sha2, approvedAt: "2026-01-02T00:00:00Z", by: { user: "fulano", origem: "terminal" } }));
v = pg("plano-aprovado", rp, "release", `plano=${P}/plan2.json`); c.want("plano com by: ok", "ok", pr_(v));
c.has("mostra quem e a origem", pe_(v), "por fulano (terminal)");
rw(`${P}/plan3.json`, JSON.stringify({ path: pl2, sha: sha2, approvedAt: "2026-01-02T00:00:00Z" }));
v = pg("plano-aprovado", rp, "release", `plano=${P}/plan3.json`); c.want("plano sem by: ok, com o detalhe de sempre", "ok", pr_(v));
c.has("detalhe diz que não registra o autor", json(v).detalhe, "não guarda quem aprovou");

// -- cabeça pelo avaliar (modos)
const rs = `${P}/work2`; mkdirSync(rs, { recursive: true });
const av = (modo: string, momento: string, ...extra: string[]) =>
  r.X([BUN, `${SKILL}/src/cli.ts`, "cerberus", "avaliar", momento, "--cabeca", "porta", ...extra, "--json"],
    { cwd: rp, env: { HADES_WORK_ROOT: rs, HADES_PACKS_ROOT: PACKS, PATH: `${PB}:${PATH_STD}`, HADES_CERBERUS_PORTA: modo } });
const guardaUp = (o: string) => json(o).vereditos.filter((x: { guarda: string }) => x.guarda === "upstream-push");
let a = av("barra", "push", "--ctx", "head=feat/y");
c.want("barra: o momento sai 1", 1, a.rc);
c.want("barra: efeito barra na guarda do upstream", "barra", guardaUp(a.out).map((x: { efeito: string }) => x.efeito).join("\n"));
a = av("avisa", "push", "--ctx", "head=feat/y");
c.want("avisa: o momento passa (exit 0)", 0, a.rc);
c.want("avisa: o resultado segue barra, o efeito vira aviso", "barra aviso", guardaUp(a.out).map((x: { resultado: string; efeito: string }) => `${x.resultado} ${x.efeito}`).join("\n"));
a = av("off", "push", "--ctx", "head=feat/y");
c.want("off: passa, sem veredito, a cabeça ignorada", "0 0 porta", `${a.rc} ${json(a.out).vereditos.length} ${json(a.out).ignoradas.join(",")}`);
a = av("barra", "release");
c.want("release sem plano aprovado: barra", "1 barra", `${a.rc} ${json(a.out).vereditos.filter((x: { guarda: string }) => x.guarda === "plano-aprovado").map((x: { efeito: string }) => x.efeito).join("\n")}`);

describe("cerberus-porta", () => c.register());
