// Checks do Limiar em TypeScript: as três guardas do momento `plugin` (`hades cerberus-check limiar <guarda>`) sobre os
// mesmos pacotes, prévias e log de auditoria; o veredito (uma linha JSON), o stderr e o código de saída têm de sair iguais
// ao gravado em loop/test/golden/legado/. Sem rede: o clone vai a um repositório local pelo insteadOf; as guardas só leem
// o estado.
import { afterAll, describe } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Cases, json, sub } from "./lib/cerberus";
import { legado } from "./lib/legado";
import { FX, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const c = new Cases();
const g = legado(import.meta.path);

// o contrato de plugin exige núcleo >=5: a skill do teste é uma cópia com VERSION 5.0.0 (independe da versão em desenvolvimento)
const SK = `${r.T}/skill-5`;
r.skillCopy(SK); writeFileSync(`${SK}/VERSION`, "5.0.0\n");
const PR = `${r.T}/pl-packs`, RM = `${r.T}/pl-remotes`, SRC = `${r.T}/pl-src`, Dp = `${r.T}/pl-data`, GC = `${r.T}/pl-gitconfig`;
const BASE = "https://plugins.example.invalid";
writeFileSync(GC, `[url "${RM}/"]\n\tinsteadOf = ${BASE}/\n`);
mkdirSync(PR, { recursive: true }); mkdirSync(`${Dp}/logs`, { recursive: true }); mkdirSync(SRC, { recursive: true });
const env = { GIT_CONFIG_GLOBAL: GC, HADES_PACKS_ROOT: PR, HADES_DATA: Dp, HADES_WT: r.C, HADES_SKILL_DIR: SK, HADES_PLUGIN_GIT_TIMEOUT: "30" };
const PL = (...a: string[]) => r.hadesIn(SK, ["plugins", ...a], { cwd: r.T, env }).out;
const sg = (...a: string[]) => r.git(SRC, ...a);

/** Uma execução da guarda pela CLI: stdout, stderr e código, sem o caminho do rig. */
const norm = (o: { out: string; err: string; rc: number }): string => `${o.out}--stderr--\n${o.err}rc=${o.rc}\n`.split(r.T).join("<T>")
  .replace(/plugins-staging\/[0-9a-f]{16}/g, "plugins-staging/<id>") // o id da prévia é sorteado a cada execução
  .replace(/ilegível: [^"]*/g, "ilegível: <erro do parser>"); // o texto do erro do parser de JSON é do Python/Bun
const side = (args: string[], ctx: Record<string, string>, extra: Record<string, string>): string =>
  norm(r.hadesIn(SK, ["cerberus-check", "limiar", ...args], {
    cwd: r.T, env: { ...env, CERBERUS_DIR: r.T, CERBERUS_SKILL: SK, CERBERUS_MOMENTO: "plugin", CERBERUS_CTX: JSON.stringify(ctx), ...extra },
  }));
/** A guarda pela CLI × o gravado; devolve o veredito gravado para as asserções sobre o conteúdo. */
const both = (label: string, guard: string, ctx: Record<string, string>, extra: Record<string, string> = {}): { resultado: string; evidencia: string } => {
  const gravado = g.get<string>(label);
  const atual = side([guard], ctx, extra);
  g.fix(label, atual);
  c.want(label, sub(gravado), sub(atual));
  const first = gravado.split("\n")[0] ?? "";
  const v = first.startsWith("{") ? json(first) : { resultado: "", evidencia: [] };
  return { resultado: v.resultado, evidencia: v.evidencia.map((e: { conferido: string }) => e.conferido).join(" | ") };
};
const all = (label: string, plugin: string, commit: string, op: string, extra: Record<string, string> = {}, more: Record<string, string> = {}) => {
  const ctx = { plugin, commit, op, ...more };
  return ["commit-fixado", "executavel", "invariante"].map((g) => both(`${label} [${g}]`, g, ctx, extra));
};

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
writeFileSync(`${SRC}/env/plugin.json`, JSON.stringify({ name: "lim", panel: { pages: [{ id: "lim", label: "LIM", script: "lim.js" }], routes: [{ path: "eco", fn: "eco" }], actions: ["lim-run"] } }) + "\n");
r.must(sg("add", "-A")); r.must(sg("commit", "-qm", "v1")); r.must(sg("push", "-q", `${RM}/lim.git`, "main"));

// ---- uso e contexto
{
  for (const args of [[], ["nada"], ["commit-fixado", "x"]]) {
    const label = `uso com ${JSON.stringify(args)}: stderr e código 2`;
    c.want(label, sub(g.get<string>(label)), sub(side(args, {}, {})));
  }
  both("contexto sem plugin, commit nem op: barra e diz o que faltou", "commit-fixado", {});
  both("op desconhecido", "executavel", { plugin: "lim", commit: "a".repeat(40), op: "apagar" });
  both("nome de plugin inválido", "invariante", { plugin: "Lim/..", commit: "a".repeat(40), op: "add" });
}

// ---- add: a prévia que o dono viu
const out0 = PL("add", `${BASE}/lim.git`, "--json");
const id: string = json(out0).id, c1: string = json(out0).commit;
{
  const [fixado, exec, inv] = all("add com a prévia", "lim", c1, "add");
  c.want("add: as três guardas ok", "ok ok ok", `${fixado?.resultado} ${exec?.resultado} ${inv?.resultado}`);
}
all("add com ref móvel", "lim", "main", "add");
all("add com sha abreviado", "lim", c1.slice(0, 12), "add");
all("add com sha sem prévia", "lim", "0".repeat(40), "add");
const prev = `${Dp}/plugins-staging/${id}/preview.json`, bak = `${r.T}/pl-preview.bak`;
copyFileSync(prev, bak);
const pv = () => json(readFileSync(bak, "utf8"));
const x1 = pv(); x1.runs.find((q: { path: string }) => q.path === "env/post-install.sh").sha256 = "00";
writeFileSync(prev, JSON.stringify(x1, null, 2));
all("add com executável diferente da prévia", "lim", c1, "add");
const x2 = pv(); x2.runs = x2.runs.filter((q: { path: string }) => q.path !== "env/panel/api.ts");
writeFileSync(prev, JSON.stringify(x2, null, 2));
all("add com executável fora da prévia", "lim", c1, "add");
const x3 = pv(); x3.other = []; x3.adds = { pages: [{ id: "outra" }], routes: ["GET outra"] };
writeFileSync(prev, JSON.stringify(x3, null, 2));
all("add com script fora da prévia e páginas e rotas diferentes", "lim", c1, "add");
const x4 = pv(); x4.runs = [{ path: "env/post-install.sh" }];
writeFileSync(prev, JSON.stringify(x4, null, 2));
both("add com a prévia sem sha256 num executável: falha ao conferir", "executavel", { plugin: "lim", commit: c1, op: "add" });
copyFileSync(bak, prev);
appendFileSync(`${Dp}/plugins-staging/${id}/lim/env/lim-svc.sh`, "# solto\n");
all("add com mudança solta no clone", "lim", c1, "add");
r.git(`${Dp}/plugins-staging/${id}/lim`, "checkout", "-q", "--", ".");
all("add com pack_dir no contexto", "lim", c1, "add", {}, { pack_dir: `${Dp}/plugins-staging/${id}/lim` });
all("add com pack_dir sem prévia ao lado", "lim", c1, "add", {}, { pack_dir: `${r.T}/nao-existe/lim` });
PL("add", "--apply", id, "--commit", c1, "--json");

// ---- enable: o pacote instalado é o da última instalação registrada
all("enable do que foi instalado", "lim", c1, "enable");
appendFileSync(`${PR}/lim/env/lim-svc.sh`, "# à mão\n");
all("enable com o pacote mexido à mão", "lim", c1, "enable");
r.git(`${PR}/lim`, "checkout", "-q", "--", ".");
if (r.git(`${PR}/lim`, "commit", "-q", "--allow-empty", "-m", "local").rc === 0) {
  all("enable de commit que ninguém instalou", "lim", sub(r.git(`${PR}/lim`, "rev-parse", "HEAD").out), "enable");
}
r.git(`${PR}/lim`, "reset", "-q", "--hard", c1);
all("enable sem registro de instalação", "lim", c1, "enable", { HADES_DATA: `${r.T}/pl-sem-log` });

// ---- update: o que muda no que executa. c2 muda o post-install; as outras saem do c2, uma por branch
sg("checkout", "-q", "-b", "main2");
appendFileSync(`${SRC}/env/post-install.sh`, "echo v2\n");
sg("add", "-A"); sg("commit", "-qm", "v2"); sg("push", "-q", `${RM}/lim.git`, "main2:main");
sg("checkout", "-q", "main"); sg("reset", "-q", "--hard", sub(sg("rev-parse", "main2").out));
const c2 = sub(sg("rev-parse", "HEAD").out);
PL("update", "lim", "--json");
all("update previsto", "lim", c2, "update");
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
writeFileSync(`${SRC}/env/plugin.json`, JSON.stringify({ name: "lim", panel: { pages: [{ id: "outra", label: "O" }], routes: [{ path: "x", method: "post" }], actions: ["a", 3] } }) + "\n"); mkBranch("b-manifesto");
appendFileSync(`${SRC}/env/post-install.sh`, "tee ~/.claude/skills/hades/x\nrm -rf $HADES_SKILL_DIR/loop\n# cp skills/hades\n"); mkBranch("b-escreve");
writeFileSync(`${SRC}/env/plugin.json`, JSON.stringify({ name: "lim", panel: { pages: [{ id: "cerberus" }] } }) + "\n"); mkBranch("b-pagina");
writeFileSync(`${SRC}/profile.json`, "{nao"); mkBranch("b-perfil");
prof.env = { pack: "../fora" }; writeFileSync(`${SRC}/profile.json`, JSON.stringify(prof)); mkBranch("b-fora");
prof.env = { pack: "env" };
r.X(["git", "-C", `${PR}/lim`, "fetch", "-q", "origin"], { env });
const tip = (b: string) => sub(r.git(`${PR}/lim`, "rev-parse", `origin/${b}`).out);
const branches = ["b-neutro", "b-novo", "b-mod", "b-nucleo", "b-guard", "b-modo", "b-settings", "b-settings-hook", "b-loop", "b-cerberus", "b-manifesto", "b-escreve", "b-pagina"];
for (const b of branches) all(`update ${b}`, "lim", tip(b), "update");
for (const b of ["b-perfil", "b-fora"]) all(`update ${b}: perfil ilegível ou env.pack fora do pacote`, "lim", tip(b), "update");

// ---- falha ao conferir: nunca ok em silêncio
all("pacote que não existe", "inexistente", c2, "update");
all("update com commit não-sha", "lim", "main", "update");
all("update com sha que o pacote não tem", "lim", "f".repeat(40), "update");

describe("cerberus-limiar-legado", () => c.register());
