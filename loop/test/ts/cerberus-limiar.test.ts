// Grupo cerberus-limiar (reference/cerberus/limiar.md): as três guardas do momento `plugin`, cada uma no ok, no barra
// (ou aviso) com a evidência certa e na falha ao conferir, e a cabeça em avisa e em off. Sem rede: o clone vai a um
// repositório local pelo insteadOf, o git roda sobre repositórios temporários.
import { afterAll, describe } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BUN, FX, Rig } from "./lib/rig";
import { Cases, json, sub } from "./lib/cerberus";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const c = new Cases();

// o contrato de plugin exige núcleo >=5: a skill do teste é uma cópia com VERSION 5.0.0 (independe da versão em desenvolvimento)
const SK = `${r.T}/skill-5`;
r.skillCopy(SK); writeFileSync(`${SK}/VERSION`, "5.0.0\n");
const PR = `${r.T}/cl-packs`, RM = `${r.T}/cl-remotes`, SRC = `${r.T}/cl-src`, Dc = `${r.T}/cl-data`, wt = r.C, GC = `${r.T}/cl-gitconfig`;
const BASE = "https://plugins.example.invalid";
writeFileSync(GC, `[url "${RM}/"]\n\tinsteadOf = ${BASE}/\n`);
mkdirSync(PR, { recursive: true }); mkdirSync(`${Dc}/logs`, { recursive: true }); mkdirSync(SRC, { recursive: true });
const XLenv = { GIT_CONFIG_GLOBAL: GC, HADES_PACKS_ROOT: PR, HADES_DATA: Dc, HADES_WT: wt, HADES_SKILL_DIR: SK, HADES_PLUGIN_GIT_TIMEOUT: "30" };
const XL = (argv: string[], env: Record<string, string> = {}) => r.X(argv, { cwd: r.T, env: { ...XLenv, ...env } });
const PL = (...a: string[]) => XL([BUN, `${SK}/src/cli.ts`, "plugins", ...a]).out;
let out = "", rc = 0;
const av = (p: string, cm: string, op: string, env: Record<string, string> = {}) => {
  const o = XL([BUN, `${SK}/src/cli.ts`, "cerberus", "avaliar", "plugin", "--cabeca", "limiar", "--json", "--ctx", `plugin=${p}`, "--ctx", `commit=${cm}`, "--ctx", `op=${op}`], env);
  out = o.out; rc = o.rc;
};
const vr = (g: string) => json(out).vereditos.filter((v: { guarda: string }) => v.guarda === g).map((v: { resultado: string }) => v.resultado).join("\n");
const evd = (g: string) => json(out).vereditos.filter((v: { guarda: string }) => v.guarda === g)
  .map((v: { evidencia: { conferido: string }[] }) => v.evidencia.map((e) => e.conferido).join(" | ")).join("\n");
const gs = () => `${vr("plugin-commit-fixado")} ${vr("plugin-executavel-na-previa")} ${vr("plugin-invariante-do-nucleo")}`;
/** `grep -c`: linhas que contêm o trecho. */
const grepc = (text: string, part: string) => text.split("\n").filter((l) => l.includes(part)).length;
const sg = (...a: string[]) => r.git(SRC, ...a);

// pacote de teste (identidade de outro projeto: o apply não reinstala o kit) publicado num remote local
r.must(r.X(["git", "init", "-q", "--bare", "-b", "main", `${RM}/lim.git`]));
r.must(r.X(["git", "init", "-q", "-b", "main", SRC]));
mkdirSync(`${SRC}/env/panel/ui`, { recursive: true }); mkdirSync(`${SRC}/env/checks`, { recursive: true });
const prof = json(readFileSync(`${FX}/packs/example-monorepo/profile.json`, "utf8"));
prof.name = "lim"; prof.identity.repo = "acme/lim"; prof.env = { pack: "env" }; prof.core = ">=5";
writeFileSync(`${SRC}/profile.json`, JSON.stringify(prof, null, 2) + "\n");
writeFileSync(`${SRC}/env/post-install.sh`, '#!/usr/bin/env bash\ntouch "$HADES_DATA/lim.ran"\n');
writeFileSync(`${SRC}/env/lim-svc.sh`, "#!/usr/bin/env bash\necho svc\n");
writeFileSync(`${SRC}/env/config.tsv`, "LIM_LANES\t3\tint:1:9\tProjeto LIM\tFaixas\tnext\tChave do plugin.\n");
writeFileSync(`${SRC}/env/panel/api.ts`, "export function eco() { return { ok: true }; }\n");
writeFileSync(`${SRC}/env/panel/ui/lim.js`, 'window.HadesPanel.registerPage("lim", () => null);\n');
writeFileSync(`${SRC}/env/plugin.json`, JSON.stringify({ name: "lim", panel: { pages: [{ id: "lim", label: "LIM", script: "lim.js" }], routes: [{ path: "eco", fn: "eco" }] } }) + "\n");
r.must(sg("add", "-A")); r.must(sg("commit", "-qm", "v1")); r.must(sg("push", "-q", `${RM}/lim.git`, "main"));

// ---- add: a prévia que o dono viu
out = PL("add", `${BASE}/lim.git`, "--json");
const id: string = json(out).id, c1: string = json(out).commit;
av("lim", c1, "add");
c.want("add com a prévia: as três guardas ok, exit 0", "ok ok ok 0", `${gs()} ${rc}`);
c.want("commit-fixado ok: a evidência traz o sha da prévia", 1, grepc(evd("plugin-commit-fixado"), `commit da prévia = ${c1.slice(0, 12)}`));
c.want("executavel ok: arquivos e rotas na evidência", 1, grepc(evd("plugin-executavel-na-previa"), "rotas: ['GET eco']"));
av("lim", "main", "add");
c.want("ref móvel (branch) barra, e a evidência diz que não é sha", "barra 1 1", `${vr("plugin-commit-fixado")} ${rc} ${grepc(evd("plugin-commit-fixado"), "não é um sha completo")}`);
av("lim", c1.slice(0, 12), "add");
c.want("sha abreviado barra", "barra", vr("plugin-commit-fixado"));
av("lim", "0".repeat(40), "add");
c.want("sha diferente do da prévia: barra por falta de prévia (falha ao conferir com a evidência do que faltou)", "barra 1",
  `${vr("plugin-commit-fixado")} ${grepc(evd("plugin-commit-fixado"), "nenhuma prévia de lim")}`);
const prev = `${Dc}/plugins-staging/${id}/preview.json`, bak = `${r.T}/cl-preview.bak`;
copyFileSync(prev, bak);
const pv = () => json(readFileSync(bak, "utf8"));
const x1 = pv(); x1.runs.find((q: { path: string }) => q.path === "env/post-install.sh").sha256 = "00";
writeFileSync(prev, JSON.stringify(x1, null, 2));
av("lim", c1, "add");
c.want("executável diferente da prévia barra, e nomeia o arquivo", "barra 1",
  `${vr("plugin-executavel-na-previa")} ${grepc(evd("plugin-executavel-na-previa"), "executável diferente da prévia: env/post-install.sh")}`);
const x2 = pv(); x2.runs = x2.runs.filter((q: { path: string }) => q.path !== "env/panel/api.ts");
writeFileSync(prev, JSON.stringify(x2, null, 2));
av("lim", c1, "add");
c.want("executável que a prévia não lista barra", "barra", vr("plugin-executavel-na-previa"));
copyFileSync(bak, prev);
appendFileSync(`${Dc}/plugins-staging/${id}/lim/env/lim-svc.sh`, "# solto\n");
av("lim", c1, "add");
c.want("mudança solta no clone em prévia barra", "barra", vr("plugin-commit-fixado"));
r.git(`${Dc}/plugins-staging/${id}/lim`, "checkout", "-q", "--", ".");
{
  const o = XL([BUN, `${SK}/src/cli.ts`, "cerberus", "avaliar", "plugin", "--cabeca", "limiar", "--json", "--ctx", "plugin=lim", "--ctx", `commit=${c1}`, "--ctx", "op=add", "--ctx", `pack_dir=${Dc}/plugins-staging/${id}/lim`]);
  out = o.out; rc = o.rc;
}
c.want("pack_dir no contexto vale (sem a busca por nome e commit)", "ok ok ok 0", `${gs()} ${rc}`);
PL("add", "--apply", id, "--commit", c1, "--json");

// ---- enable: o pacote instalado é o da última instalação registrada
av("lim", c1, "enable");
c.want("enable do que foi instalado: ok nas três", "ok ok ok 0", `${gs()} ${rc}`);
appendFileSync(`${PR}/lim/env/lim-svc.sh`, "# à mão\n");
av("lim", c1, "enable");
c.want("enable com o pacote mexido à mão barra", "barra", vr("plugin-commit-fixado"));
r.git(`${PR}/lim`, "checkout", "-q", "--", ".");
if (r.git(`${PR}/lim`, "commit", "-q", "--allow-empty", "-m", "local").rc === 0) av("lim", sub(r.git(`${PR}/lim`, "rev-parse", "HEAD").out), "enable");
c.want("enable de commit que ninguém instalou barra, e cita a última instalação", "barra 1",
  `${vr("plugin-commit-fixado")} ${grepc(evd("plugin-commit-fixado"), `último commit instalado no log = ${c1.slice(0, 12)}`)}`);
r.git(`${PR}/lim`, "reset", "-q", "--hard", c1);
av("lim", c1, "enable", { HADES_DATA: `${r.T}/cl-sem-log` });
c.want("enable sem registro de instalação: aviso (não há com o que conferir)", "aviso", vr("plugin-commit-fixado"));

// ---- update: o que muda no que executa. c2 muda o post-install; as outras saem do c2, uma por branch
sg("checkout", "-q", "-b", "main2");
appendFileSync(`${SRC}/env/post-install.sh`, "echo v2\n");
sg("add", "-A"); sg("commit", "-qm", "v2"); sg("push", "-q", `${RM}/lim.git`, "main2:main");
sg("checkout", "-q", "main"); sg("reset", "-q", "--hard", sub(sg("rev-parse", "main2").out));
const c2 = sub(sg("rev-parse", "HEAD").out);
PL("update", "lim", "--json");
av("lim", c2, "update");
c.want("update previsto: commit ok, executável alterado listado, núcleo intacto", "ok ok ok 0", `${gs()} ${rc}`);
c.want("executavel: o post-install alterado aparece na evidência", 1, grepc(evd("plugin-executavel-na-previa"), "alterado: post-install.sh"));
const mkBranch = (b: string) => { // branch a partir do c2 com o que o chamador escreveu em SRC
  sg("add", "-A"); sg("commit", "-qm", b); sg("branch", "-f", b, "HEAD"); sg("push", "-q", `${RM}/lim.git`, b); sg("reset", "-q", "--hard", c2); sg("clean", "-qfd");
};
writeFileSync(`${SRC}/env/extra.sh`, "#!/usr/bin/env bash\n"); mkBranch("b-novo");
appendFileSync(`${SRC}/env/lim-svc.sh`, "# v2\n"); mkBranch("b-mod");
writeFileSync(`${SRC}/env/config.sh`, "echo ok\n"); mkBranch("b-nucleo");
appendFileSync(`${SRC}/env/post-install.sh`, "cp x ~/.claude/skills/hades/loop/hooks/hades-guard.py\n"); mkBranch("b-guard");
appendFileSync(`${SRC}/env/config.tsv`, "HADES_CERBERUS_PORTA\toff\tenum:off,barra\tG\tL\tnext\tD\n"); mkBranch("b-modo");
appendFileSync(`${SRC}/env/post-install.sh`, "jq . ~/.claude/settings.json\n"); mkBranch("b-settings");
appendFileSync(`${SRC}/env/post-install.sh`, 'jq ".hooks = {}" ~/.claude/settings.json\n'); mkBranch("b-settings-hook");
mkdirSync(`${SRC}/loop/hooks`, { recursive: true }); writeFileSync(`${SRC}/loop/hooks/guard-rules.json`, "{}\n"); mkBranch("b-loop");
writeFileSync(`${SRC}/env/cerberus-x.sh`, "echo oi\n"); mkBranch("b-cerberus");
writeFileSync(`${SRC}/env/README.txt`, "ok\n"); mkBranch("b-neutro");
XL(["git", "-C", `${PR}/lim`, "fetch", "-q", "origin"]);
const tip = (b: string) => sub(r.git(`${PR}/lim`, "rev-parse", `origin/${b}`).out);
av("lim", tip("b-neutro"), "update");
c.want("update sem código novo: executável e núcleo ok (o commit não foi o previsto: commit-fixado barra)", "barra ok ok", gs());
av("lim", tip("b-novo"), "update");
c.want("executável novo fora do diff da prévia barra", "barra 1", `${vr("plugin-executavel-na-previa")} ${grepc(evd("plugin-executavel-na-previa"), "novo: extra.sh (fora do diff da prévia)")}`);
av("lim", tip("b-mod"), "update");
c.want("script alterado fora do diff: aviso", "aviso", vr("plugin-executavel-na-previa"));
av("lim", tip("b-nucleo"), "update");
c.want("env/ que cai sobre arquivo do núcleo barra", "barra 1", `${vr("plugin-invariante-do-nucleo")} ${grepc(evd("plugin-invariante-do-nucleo"), "env/config.sh cai por cima de kit/config.sh")}`);
av("lim", tip("b-guard"), "update");
c.want("script que escreve na pasta da skill ou mexe no hook barra", "barra 1", `${vr("plugin-invariante-do-nucleo")} ${grepc(evd("plugin-invariante-do-nucleo"), "escreve na pasta da skill")}`);
av("lim", tip("b-modo"), "update");
c.want("config.tsv que declara HADES_CERBERUS_* barra", "barra 1", `${vr("plugin-invariante-do-nucleo")} ${grepc(evd("plugin-invariante-do-nucleo"), "declara HADES_CERBERUS_PORTA")}`);
av("lim", tip("b-settings"), "update");
c.want("mexer em settings.json sem hook: aviso", "aviso", vr("plugin-invariante-do-nucleo"));
av("lim", tip("b-settings-hook"), "update");
c.want("mexer em settings.json onde o hook mora: barra", "barra", vr("plugin-invariante-do-nucleo"));
av("lim", tip("b-loop"), "update");
c.want("pacote com arquivo de loop/hooks barra", "barra 1",
  `${vr("plugin-invariante-do-nucleo")} ${grepc(evd("plugin-invariante-do-nucleo"), "arquivo que já é do núcleo (loop/): substituiria o núcleo")}`);
av("lim", tip("b-cerberus"), "update");
c.want("arquivo com cerberus no nome (guarda ou bloco numa cabeça) barra", "barra", vr("plugin-invariante-do-nucleo"));

// ---- falha ao conferir: nunca ok em silêncio
av("inexistente", c2, "update");
c.want("pacote que não existe: barra com a evidência do que faltou", "barra barra barra 1", `${gs()} ${rc}`);
c.want("a evidência diz o que não deu para conferir", 1, grepc(evd("plugin-invariante-do-nucleo"), "não consegui conferir"));
{
  const o = XL([BUN, `${SK}/src/cli.ts`, "cerberus", "avaliar", "plugin", "--cabeca", "limiar", "--json", "--ctx", "plugin=lim"]);
  out = o.out; rc = o.rc;
}
c.want("contexto incompleto barra e diz a chave que faltou", "barra 1", `${vr("plugin-commit-fixado")} ${grepc(evd("plugin-commit-fixado"), "commit, op")}`);

// ---- a cabeça em avisa e em off, pelo avaliar
av("lim", tip("b-nucleo"), "update", { HADES_CERBERUS_LIMIAR: "avisa" });
c.want("modo avisa: o barra vira aviso e o momento passa", "barra aviso 0",
  `${vr("plugin-invariante-do-nucleo")} ${json(out).vereditos.filter((v: { guarda: string }) => v.guarda === "plugin-invariante-do-nucleo").map((v: { efeito: string }) => v.efeito).join("\n")} ${rc}`);
av("lim", tip("b-nucleo"), "update", { HADES_CERBERUS_LIMIAR: "off" });
c.want("modo off: a cabeça não é avaliada", "limiar 0 0", `${json(out).ignoradas.join(",")} ${json(out).vereditos.length} ${rc}`);

describe("cerberus-limiar", () => c.register());
