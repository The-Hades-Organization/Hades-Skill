// Grupo cerberus-corpo (reference/cerberus.md): veredito, registro, modos, exceção, histórico e painel.
import { afterAll, describe } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { BUN, Rig, SKILL } from "./lib/rig";
import { caso } from "./lib/route";
import { Cases, dropExecGuards, ev, json, sub, writeGuard } from "./lib/cerberus";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const c = new Cases();

const S = `${r.T}/cb-skill`, D = `${r.T}/cb-data`, st = `${r.T}/work/_maquina/cerberus`;
r.skillCopy(S);
const R = `${S}/loop/cerberus`, CLI = `${S}/src/cli.ts`;
// o corpo é provado sem as guardas exec que as cabeças entregam (elas têm grupo próprio): só as de teste mais as emitidas/regras
dropExecGuards(R);

const cb = (args: string[], env: Record<string, string> = {}) =>
  r.X([BUN, CLI, "cerberus", ...args], { cwd: r.T, env: { HADES_CERBERUS_TIMEOUT_S: "10", ...env } });
const guard = (cab: string, id: string, momento: string, saida: string) =>
  writeGuard(R, cab, id, [momento], `echo '${saida}'`);
const porcelain = () => sub(r.git(S, "status", "--porcelain", "--untracked-files=all").out).split("\n").filter(Boolean);

guard("porta", "upstream-push", "publicacao", ev("ok", "loop/test/cerberus/corpo.sh")); // o teste do painel abre exceção sobre ela
// zero guardas exec no momento: nada avaliado, nada impresso, passa
let o = cb(["avaliar", "push"]);
c.want("sem guarda exec no momento: passa calado", "0 ", `${o.rc} ${sub(o.out)}`);
let codes = "";
for (const m of ["comentario", "artefato", "tunel"]) codes += cb(["avaliar", m, "--ctx", "pr=1"]).rc;
c.want("momentos comentario, artefato e tunel aceitos pelo contrato", "000", codes);

// guarda nova só por registro: um json e o script dela, nada do corpo muda
const E = (res: string) => ev(res, "loop/test/cerberus/corpo.sh");
guard("porta", "t-barra", "push", E("barra"));
guard("porta", "t-aviso", "release", E("aviso"));
guard("limiar", "t-aviso", "release", E("aviso"));
guard("limiar", "t-sem-evidencia", "plugin", '{"resultado": "ok"}');
guard("vigilia", "t-barra", "consolidacao", E("barra"));
c.want("guarda nova entra só pelo registro (loop/cerberus/)", "", porcelain().map((l) => l.trim().split(/\s+/)[1] ?? "").filter((p) => !p.startsWith("loop/cerberus/")).join("\n"));
c.want("registro lista as guardas novas", 5, json(cb(["guardas", "--json"]).out).guardas.filter((g: { id: string }) => g.id.startsWith("t-")).length);

// barra de uma guarda barra o momento
o = cb(["avaliar", "push", "--json"]);
let j = json(o.out);
c.want("barra barra o momento (exit 1)", "1 barra barra", `${o.rc} ${j.resultado} ${j.vereditos[0].efeito}`);

// avisos somados
o = cb(["avaliar", "release", "--json"]); j = json(o.out);
c.want("avisos de duas cabeças somados", "0 aviso 2", `${o.rc} ${j.resultado} ${j.avisos}`);

// veredito sem evidência não vale: vira barra inválido com a evidência do corpo
o = cb(["avaliar", "plugin", "--json"]); j = json(o.out);
c.want("veredito sem evidência recusado (barra inválido)", "1 true veredito recusado: veredito sem evidência", `${o.rc} ${j.vereditos[0].invalido} ${j.vereditos[0].evidencia[0].conferido}`);
c.want("registrar sem evidência: recusado (exit 2)", 2, cb(["registrar", "--cabeca", "porta", "--guarda", "dominio", "--momento", "release", "--resultado", "ok"]).rc);

// modos: Vigília em avisa por padrão rebaixa o barra; em barra barra; em off não é avaliada
o = cb(["avaliar", "consolidacao", "--json"]); j = json(o.out);
c.want("cabeça em avisa: barra vira aviso", "0 aviso barra", `${o.rc} ${j.vereditos[0].efeito} ${j.vereditos[0].resultado}`);
o = cb(["avaliar", "consolidacao", "--json"], { HADES_CERBERUS_VIGILIA: "barra" });
c.want("cabeça em barra: barra", "1 barra", `${o.rc} ${json(o.out).resultado}`);
o = cb(["avaliar", "consolidacao", "--json"], { HADES_CERBERUS_VIGILIA: "off" }); j = json(o.out);
c.want("cabeça em off: não avaliada", "0 0 vigilia", `${o.rc} ${j.vereditos.length} ${j.ignoradas.join(",")}`);
c.want("modo fora da lista: recusado (exit 2)", 2, cb(["avaliar", "consolidacao", "--json"], { HADES_CERBERUS_VIGILIA: "talvez" }).rc);

// exceção: só com motivo; casa o alvo; libera uma vez e fica no veredito
c.want("exceção sem motivo de verdade: recusada", 2, cb(["excecao", "abrir", "--cabeca", "porta", "--guarda", "t-barra", "--momento", "push", "--motivo", "curto"]).rc);
cb(["excecao", "abrir", "--cabeca", "porta", "--guarda", "t-barra", "--momento", "push", "--alvo", "pr=12", "--motivo", "hotfix aprovado pelo dono"]);
o = cb(["avaliar", "push", "--ctx", "pr=13", "--json"]);
c.want("exceção de outro alvo não libera", "1 barra", `${o.rc} ${json(o.out).resultado}`);
o = cb(["avaliar", "push", "--ctx", "pr=12", "--json"]); j = json(o.out);
c.want("exceção libera o barra, com o motivo no veredito", "0 liberado hotfix aprovado pelo dono", `${o.rc} ${j.vereditos[0].efeito} ${j.vereditos[0].excecao.motivo}`);
c.want("exceção é de uso único", 1, cb(["avaliar", "push", "--ctx", "pr=12", "--json"]).rc);
const ex = json(cb(["excecao", "listar", "--json"]).out)[0];
c.want("exceção usada fica registrada com a origem", "terminal true", `${ex.origem} ${ex.usada != null}`);

// histórico fora do repositório, com rotação
c.want("histórico em <work>/_maquina/cerberus, fora do repo", "sim limpo",
  `${existsSync(`${st}/vereditos.jsonl`) && statSync(`${st}/vereditos.jsonl`).size > 0 ? "sim" : ""} ${porcelain().filter((l) => !l.includes(" loop/cerberus/")).length === 0 ? "limpo" : ""}`);
c.want("histórico filtra por efeito", "porta/t-barra", json(cb(["historico", "--efeito", "liberado", "--json"]).out).map((h: { cabeca: string; guarda: string }) => `${h.cabeca}/${h.guarda}`).join("\n"));
r.X([BUN, "-e", `const c = await import(process.argv[1] + "/src/lib/cerberus.ts");
for (let i = 0; i < 80; i++) c.record("porta", "dominio", "release", "ok", [{ conferido: "rotação " + "x".repeat(200), onde: "teste" }]);`, S], { env: { HADES_CERBERUS_HIST_KB: "16" } });
c.want("histórico gira em HADES_CERBERUS_HIST_KB (duas gerações, a atual abaixo do teto)", "sim sim",
  `${existsSync(`${st}/vereditos.1.jsonl`) && statSync(`${st}/vereditos.1.jsonl`).size > 0 ? "sim" : ""} ${statSync(`${st}/vereditos.jsonl`).size <= 16384 ? "sim" : ""}`);

// momento plugin: a guarda recebe pack_dir (contexto) e os três lugares vêm do ambiente do chamador (o `hades plugins` os põe quando faltam)
rmSync(`${R}/limiar/t-sem-evidencia.json`);
writeGuard(R, "limiar", "t-ctx", ["plugin"],
  `echo "$CERBERUS_CTX_OP $CERBERUS_CTX_PACK_DIR \${HADES_DATA:+D} \${HADES_PACKS_ROOT:+P} \${HADES_SKILL_DIR:+S}" > ${r.T}/cb-plugin.ctx\necho '${ev("ok", "loop/test/cerberus/corpo.sh")}'`,
  { titulo: "contexto do plugin" });
cb(["avaliar", "plugin", "--ctx", "plugin=pc", "--ctx", "op=add", "--ctx", `commit=${"0".repeat(40)}`, "--ctx", `pack_dir=${r.T}/staging/pc`],
  { HADES_DATA: `${r.T}/cb-data`, HADES_PACKS_ROOT: `${r.T}/cb-packs`, HADES_SKILL_DIR: S });
c.want("avaliar plugin: pack_dir e HADES_DATA/PACKS_ROOT/SKILL_DIR chegam à guarda", `add ${r.T}/staging/pc D P S`,
  existsSync(`${r.T}/cb-plugin.ctx`) ? sub(readFileSync(`${r.T}/cb-plugin.ctx`, "utf8")) : "");

// painel: leitura também pelo remoto; exceção e modo só pelo local, com o token
mkdirSync(D, { recursive: true });
cpSync(`${S}/kit/panel`, `${D}/panel`, { recursive: true });
cpSync(`${S}/kit/config.tsv`, `${D}/config.tsv`);
writeFileSync(`${D}/panel/remote.key`, "chave-do-teste\n");
const rt = caso(r.X(["timeout", "120", BUN, `${import.meta.dir}/lib/corpo-route.ts`, S, D], { env: { HADES_DATA: D } }).out);
c.want("painel local lê as três cabeças com o modo", "porta:barra,limiar:barra,vigilia:avisa local", rt("estado"));
c.want("painel remoto lê (só leitura)", "remote", rt("estado-remoto"));
c.want("remoto não abre exceção", "400 exceção do Cerberus só se abre pelo painel local", rt("remoto-excecao"));
c.want("remoto não muda o modo", "400 o Cerberus só se configura pelo painel local", rt("remoto-modo"));
c.want("POST sem o token: recusado", 403, rt("local-sem-token").split(" ")[0] ?? "");
c.want("motivo curto: 400", 400, rt("local-motivo-curto").split(" ")[0] ?? "");
c.want("painel local abre exceção com origem painel", 'painel porta upstream-push {"pr": "7"}', rt("excecao"));

// hook: o caminho do agente para exceção, rota e modo é barrado; a leitura passa; o barrado vira veredito da Vigília
const hk = (cmd: string) => r.X([BUN, `${SKILL}/src/hook.ts`],
  { stdin: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "cb", cwd: r.T, tool_name: "Bash", tool_input: { command: cmd } }) }).rc;
c.want("hook barra excecao abrir vindo do Claude", 2, hk(`hades cerberus excecao abrir --cabeca porta --guarda t-barra --momento push --motivo 'por minha conta'`));
c.want("hook barra a rota /api/cerberus", 2, hk("curl -s -X POST http://127.0.0.1:21220/api/cerberus"));
c.want("hook barra a troca de modo", 2, hk("hades config set HADES_CERBERUS_PORTA=off"));
c.want("hook deixa ler o histórico", 0, hk(`hades cerberus historico --limite 5`));
c.want("barrado pelo hook vira veredito vigilia/excecao-so-dono", 3,
  readdirSync(st).filter((f) => /^vereditos.*\.jsonl$/.test(f)).map((f) => readFileSync(`${st}/${f}`, "utf8")).join("")
    .split("\n").filter((l) => l.includes('"guarda": "excecao-so-dono"')).length);

// registro inválido: --validar reprova e a avaliação recusa em vez de seguir sem a guarda
writeFileSync(`${R}/porta/t-quebrada.json`, '{"titulo": "x", "momentos": ["push"], "tipo": "magia", "origem": "teste"}\n');
c.want("registro inválido: guardas --validar sai 2", 2, cb(["guardas", "--validar"]).rc);
c.want("registro inválido: avaliação recusa (exit 2)", 2, cb(["avaliar", "push"]).rc);

describe("cerberus-corpo", () => c.register());
