// `hades plugins` (reference/cli.md): cenário sequencial (prévia, confirmação por commit, atualização, Cerberus, liga/desliga,
// remoção) com $D, pasta de pacotes e raiz de trabalho próprias. Cada passo compara stdout, stderr, código de saída e o estado
// em disco (plugins.disabled, plugins-staging, log de auditoria, pacotes) com o gravado em golden/legado/plugins-cli.json,
// depois de normalizar ids, instantes e caminhos. Sem rede: o clone vai a repositórios locais pelo insteadOf; o install.sh é um falso.
import { afterAll, describe } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { legado } from "./lib/legado";
import { BUN, FX, Rig } from "./lib/rig";
import { Cases, dropExecGuards, json, sub, writeGuard } from "./lib/cerberus";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const c = new Cases();
const g = legado(import.meta.path);

const S = `${r.T}/pl-s`;
const RM = `${r.T}/pl-remotes`, SRC = `${r.T}/pl-src`, GC = `${r.T}/pl-gitconfig`, FLAG = `${r.T}/pl-barra.flag`;
const BASE = "https://plugins.example.invalid";
writeFileSync(GC, `[url "${RM}/"]\n\tinsteadOf = ${BASE}/\n`);
{
  r.skillCopy(S);
  writeFileSync(`${S}/VERSION`, "5.0.0\n"); // o contrato de plugin exige núcleo >=5
  // o install.sh do falso só registra a chamada: o real mexeria no painel e na máquina
  writeFileSync(`${S}/kit/install.sh`, '#!/usr/bin/env bash\necho "install wt=$HADES_WT" >> "$HADES_DATA/install.log"\n');
  chmodSync(`${S}/kit/install.sh`, 0o755);
  dropExecGuards(`${S}/loop/cerberus`);
  writeGuard(`${S}/loop/cerberus`, "limiar", "t-plugin", ["plugin"], `[ -e '${FLAG}' ] && echo '{"resultado": "barra", "evidencia": [{"conferido": "bandeira", "onde": "teste"}], "detalhe": "bandeira de teste"}' || echo '{"resultado": "ok", "evidencia": [{"conferido": "sem bandeira", "onde": "teste"}]}'`);
}

const D = { D: `${r.T}/pl-d`, PR: `${r.T}/pl-p`, WR: `${r.T}/pl-w` };
let extra: Record<string, string> = {};
/** `hades plugins <args>` no $D do cenário: stdout, stderr e código */
const px = (args: string[]): string => {
  const o = r.X([BUN, `${S}/src/cli.ts`, "plugins", ...args], { cwd: r.T, env: { GIT_CONFIG_GLOBAL: GC, HADES_PACKS_ROOT: D.PR, HADES_DATA: D.D, HADES_WT: r.C, HADES_SKILL_DIR: S, HADES_PLUGIN_GIT_TIMEOUT: "30", HADES_WORK_ROOT: D.WR, HADES_PANEL_JOB: "", ...extra } });
  return nz(`${o.out}--stderr--\n${o.err}rc=${o.rc}\n`);
};
/** nz: o que muda de uma rodada para outra sem ser comportamento (ids, instantes, caminhos) */
function nz(s: string): string {
  return s.split(D.D).join("<D>").split(D.PR).join("<PR>").split(D.WR).join("<WR>").split(S).join("<S>").split(r.T).join("<T>")
    .replace(/\b[0-9a-f]{16}\b/g, "<id>").replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z/g, "<ts>");
}
const both = (label: string, args: string[] | (() => string[])) => { const atual = sub(px(typeof args === "function" ? args() : args)); g.fix(label, atual); c.want(label, g.get(label), atual); };
/** o estado em disco: arquivos do $D que o plugins grava, e os pacotes */
function state(): string {
  const d = D;
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "(sem)\n");
  const tree = (p: string): string[] => (existsSync(p) && statSync(p).isDirectory()
    ? readdirSync(p).sort().flatMap((e) => (e === ".git" ? [] : tree(`${p}/${e}`).map((x) => `${e}/${x}`).concat(statSync(`${p}/${e}`).isDirectory() ? [] : [e])))
    : []);
  const stage = existsSync(`${d.D}/plugins-staging`) ? readdirSync(`${d.D}/plugins-staging`).length : -1;
  return nz(`disabled:\n${read(`${d.D}/plugins.disabled`)}log:\n${read(`${d.D}/logs/plugins.log`).replace(/commit=[0-9a-f]{40}/g, "commit=<sha>")}install:\n${read(`${d.D}/install.log`)}packs:\n${tree(d.PR).join("\n")}\nstaging=${stage}\n`);
}
const sameState = (label: string) => { const atual = sub(state()); g.fix(label, atual); c.want(label, g.get(label), atual); };

// ---- pacotes de teste, cada um num remote local
const sg = (...a: string[]) => r.git(SRC, ...a);
const base = json(readFileSync(`${FX}/packs/example-monorepo/profile.json`, "utf8"));
function publish(name: string, repo: string, opts: { core?: string; noProfile?: boolean; mutate?: (p: Record<string, unknown>) => void } = {}): void {
  r.must(r.X(["rm", "-rf", SRC]));
  r.must(r.X(["git", "init", "-q", "--bare", "-b", "main", `${RM}/${name}.git`]));
  r.must(r.X(["git", "init", "-q", "-b", "main", SRC]));
  mkdirSync(`${SRC}/env/panel/ui`, { recursive: true }); mkdirSync(`${SRC}/env/checks`, { recursive: true });
  if (!opts.noProfile) {
    const prof = { ...base, name, identity: { ...base.identity, repo }, env: { pack: "env" }, core: opts.core ?? ">=5" };
    opts.mutate?.(prof);
    writeFileSync(`${SRC}/profile.json`, JSON.stringify(prof, null, 2) + "\n");
  } else writeFileSync(`${SRC}/README.md`, "sem profile\n");
  writeFileSync(`${SRC}/env/post-install.sh`, '#!/usr/bin/env bash\ntouch "$HADES_DATA/x.ran"\n');
  writeFileSync(`${SRC}/env/svc.sh`, "#!/usr/bin/env bash\necho svc\n");
  writeFileSync(`${SRC}/env/doctor.sh`, "echo ok\n");
  writeFileSync(`${SRC}/env/checks/um.sh`, "echo um\n");
  writeFileSync(`${SRC}/env/config.tsv`, `${name.toUpperCase().replace(/-/g, "_")}_N\t3\tint:1:9\tProjeto\tFaixas\tnext\tChave.\n`);
  writeFileSync(`${SRC}/env/onboard.tsv`, "feature\tpasso\tPasso do plugin\n");
  writeFileSync(`${SRC}/env/panel/api.ts`, "export function eco() { return { ok: true }; }\n");
  writeFileSync(`${SRC}/env/panel/ui/p.js`, 'window.HadesPanel.registerPage("p", () => null);\n');
  writeFileSync(`${SRC}/env/plugin.json`, JSON.stringify({ name, panel: { pages: [{ id: "p", label: "P", script: "p.js" }], routes: [{ path: "eco", fn: "eco" }], actions: ["acao"] } }) + "\n");
  r.must(sg("add", "-A")); r.must(sg("commit", "-qm", "v1")); r.must(sg("push", "-q", `${RM}/${name}.git`, "main"));
}
publish("pa", "acme/pa");
publish("pm", "example/monorepo");
publish("pdup", "acme/pa");
publish("pcore", "acme/pcore", { core: ">=99" });
publish("pinv", "acme/pinv", { core: "abc" });
publish("psemperfil", "acme/x", { noProfile: true });
const url = (n: string) => `${BASE}/${n}.git`;

// ---- uso e listagem vazia
for (const a of [[], ["bogus"], ["list", "--bogus"], ["add"], ["enable"], ["enable", "a", "b"], ["--json", "list"], ["add", "--json"], ["list", "--json"], ["list"],
  ["remove", "nada"], ["enable", "Maiuscula"], ["disable", "nao-existe", "--json"], ["update", "nao-existe", "--json"], ["add", "--apply", "x", "--commit"]]) {
  both(`plugins ${a.join(" ") || "sem argumento"}: igual (saída e código)`, a);
}
// ---- URL recusada
for (const u of ["", "http://x.example/a", `https://u:t@host.example/a/b`, "git@host:a b", "file:///tmp/x", "ext::sh -c x", `https://h.example/${"a".repeat(300)}`, "-oProxyCommand=x"]) {
  both(`add ${JSON.stringify(u.slice(0, 30))}: igual`, ["add", u, "--json"]);
}
both("add sem profile.json: igual (no_profile)", ["add", url("psemperfil"), "--json"]);
both("add com core fora da faixa: igual (prévia na recusa)", ["add", url("pcore"), "--json"]);
both("add com core inválido: igual", ["add", url("pinv")]);
sameState("estado depois das recusas: igual (nada ficou na prévia)");

// ---- prévia e confirmação do plugin de outro projeto
const idOf = (out: string): { id: string; commit: string } => ({ id: json(out).id, commit: json(out).commit });
const raw = (args: string[]): string =>
  r.X([BUN, `${S}/src/cli.ts`, "plugins", ...args], { cwd: r.T, env: { GIT_CONFIG_GLOBAL: GC, HADES_PACKS_ROOT: D.PR, HADES_DATA: D.D, HADES_WT: r.C, HADES_SKILL_DIR: S, HADES_PLUGIN_GIT_TIMEOUT: "30", HADES_WORK_ROOT: D.WR, ...extra } }).out;
const pv: Record<string, { id: string; commit: string }> = {};
const preview = (name: string): void => { pv[name] = idOf(raw(["add", url(name), "--json"])); };
both("add (texto): a prévia", ["add", url("pa")]);
both("add --json: a prévia", ["add", url("pa"), "--json"]);
preview("pa");
const apply = (name: string, extraArgs: string[] = [], sha?: string) => () => ["add", "--apply", pv[name]?.id ?? "", "--commit", sha ?? pv[name]?.commit ?? "", ...extraArgs];
both("add --apply com commit errado: commit_mismatch", apply("pa", ["--json"], "0".repeat(40)));
both("add --apply com id inexistente: preview_expired", ["add", "--apply", "0123456789abcdef", "--commit", "0".repeat(40), "--json"]);
both("add --apply com id malformado: preview_expired", ["add", "--apply", "../../etc", "--commit", "0".repeat(40), "--json"]);
both("add --apply --check: confere e não muda", apply("pa", ["--check", "--json"]));
sameState("estado depois do --check: igual");
both("add --apply: instala (outro projeto: sem reinstalar)", apply("pa", ["--json"]));
sameState("estado depois do apply: igual");
both("list (texto) com o pacote instalado", ["list"]);
both("list --json com o pacote instalado", ["list", "--json"]);
both("add do mesmo pacote de novo: already_installed (prévia na recusa)", ["add", url("pa"), "--json"]);
both("add de outro pacote do mesmo repo: duplicate_repo", ["add", url("pdup"), "--json"]);
both("enable do plugin de outro projeto: other_project", ["enable", "pa", "--json"]);
both("disable do plugin de outro projeto: other_project", ["disable", "pa"]);
both("remove sem a confirmação: name_mismatch", ["remove", "pa", "--json"]);
both("remove com confirmação errada: name_mismatch", ["remove", "pa", "--confirm", "pb", "--json"]);

// ---- atualizar
both("update sem novidade: upToDate", ["update", "pa", "--json"]);
both("update --apply sem novidade: commit_mismatch", ["update", "pa", "--apply", "--commit", "0".repeat(40), "--json"]);
{
  // v2 do pa: clona o remote do pa, altera o que executa e publica
  const w = `${r.T}/pl-pa-v2`;
  r.must(r.X(["git", "clone", "-q", `${RM}/pa.git`, w]));
  writeFileSync(`${w}/env/post-install.sh`, '#!/usr/bin/env bash\ntouch "$HADES_DATA/x.ran"\necho v2\n');
  writeFileSync(`${w}/env/novo.sh`, "echo novo\n");
  r.must(r.git(w, "add", "-A")); r.must(r.git(w, "commit", "-qm", "v2")); r.must(r.git(w, "push", "-q", `${RM}/pa.git`, "main"));
}
both("update <nome>: a prévia do que muda (texto)", ["update", "pa"]);
both("update <nome> --json", ["update", "pa", "--json"]);
const target = () => sub(raw(["update", "pa", "--json"]));
both("update --apply com commit errado: commit_mismatch", ["update", "pa", "--apply", "--commit", "1".repeat(40), "--json"]);
both("update --apply --check", () => ["update", "pa", "--apply", "--commit", json(target()).target, "--check", "--json"]);
sameState("estado depois do update --check: igual");
{
  // mudança local barra a atualização
  writeFileSync(`${D.PR}/pa/solto.txt`, "x\n");
  both("update com mudança local: local_changes", ["update", "pa", "--json"]);
  r.must(r.X(["rm", "-f", `${D.PR}/pa/solto.txt`]));
}
both("update --apply: avança", () => ["update", "pa", "--apply", "--commit", json(target()).target, "--json"]);
sameState("estado depois do update --apply: igual");
both("update de novo: upToDate", ["update", "pa", "--json"]);

// ---- o Cerberus (momento plugin) barra a instalação
writeFileSync(FLAG, "x\n");
both("remove do pa libera o repo", ["remove", "pa", "--confirm", "pa", "--json"]);
sameState("estado depois do remove: igual");
preview("pa");
both("add --apply com o Cerberus barrando: cerberus_barred", apply("pa", ["--json"]));
sameState("estado depois do Cerberus barrar: igual (nada instalado)");
r.must(r.X(["rm", "-f", FLAG]));

// ---- o plugin desta instalação: reinstala, liga e desliga
preview("pm");
both("add --apply do plugin desta instalação: ativa e reinstala", apply("pm", ["--json"]));
sameState("estado depois do apply ativo: igual (install.log)");
both("list com o plugin ativo", ["list"]);
both("disable --check", ["disable", "pm", "--check", "--json"]);
both("disable", ["disable", "pm"]);
both("disable de novo: sem mudança", ["disable", "pm", "--json"]);
both("list com o plugin desligado", ["list", "--json"]);
both("enable --check", ["enable", "pm", "--check", "--json"]);
writeFileSync(FLAG, "x\n");
both("enable com o Cerberus barrando", ["enable", "pm", "--json"]);
r.must(r.X(["rm", "-f", FLAG]));
both("enable", ["enable", "pm", "--json"]);
both("enable de novo: sem mudança", ["enable", "pm", "--json"]);
{
  // commit não publicado e mudança local barram a remoção
  writeFileSync(`${D.PR}/pm/solto.txt`, "x\n");
  both("remove com mudança local: local_changes", ["remove", "pm", "--confirm", "pm", "--json"]);
  {
    const p = `${D.PR}/pm`;
    r.must(r.X(["rm", "-f", `${p}/solto.txt`]));
    writeFileSync(`${p}/novo.txt`, "y\n");
    r.must(r.git(p, "add", "-A")); r.must(r.git(p, "commit", "-qm", "local"));
  }
  both("remove com commit não publicado: unpublished_commits", ["remove", "pm", "--confirm", "pm", "--json"]);
  r.must(r.git(`${D.PR}/pm`, "push", "-q", `${RM}/pm.git`, "HEAD:refs/heads/local"));
}
both("remove --check", ["remove", "pm", "--confirm", "pm", "--check", "--json"]);
both("remove: desliga, reinstala e apaga", ["remove", "pm", "--confirm", "pm", "--json"]);
sameState("estado final: igual");
// timeout do git ausente
extra = { HADES_PLUGIN_GIT_TIMEOUT: "" };
both("add sem HADES_PLUGIN_GIT_TIMEOUT: erro de configuração", ["add", url("pa"), "--json"]);
extra = {};

// as mesmas chamadas no estado final, com os argumentos que o painel e o plugins.sh passam
for (const args of [["list", "--json"], ["add", "--json"], ["nada"], ["enable", "inexistente", "--json"]]) {
  const atual = sub(px(args)); g.fix(`wrapper ${args.join(" ")}`, atual);
  c.want(`plugins ${args.join(" ")} no estado final: igual ao gravado`, g.get(`wrapper ${args.join(" ")}`), atual);
}

describe("plugins-cli", () => c.register());
