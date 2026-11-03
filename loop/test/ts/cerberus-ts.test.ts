// Cerberus em TypeScript (reference/cli.md): cada caso roda na cópia da skill, com raiz de trabalho própria, e compara
// saída, código de saída e arquivos de estado (histórico e exceções) com o gravado em loop/test/golden/legado/, depois de
// normalizar ids, instantes e o caminho da cópia. As guardas exec são as de teste.
import { afterAll, describe } from "bun:test";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL } from "./lib/rig";
import { legado } from "./lib/legado";
import { Cases, dropExecGuards, ev as evJson, sub, writeGuard } from "./lib/cerberus";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const c = new Cases();
const g = legado(import.meta.path);

const S1 = `${r.T}/cts-new`, W1 = `${r.T}/cts-w1`;
const SS: string[] = [S1], WS: string[] = [W1]; // as cópias da skill e as raízes de trabalho em que os casos rodam
r.skillCopy(S1);
dropExecGuards(`${S1}/loop/cerberus`);

let extra: Record<string, string> = {};
/** A CLI `hades cerberus <args>` na cópia, com a raiz de trabalho dela; stderr junto e `rc=` no fim. */
const pc = (args: string[]): string => {
  const o = r.hadesIn(S1, ["cerberus", ...args], { cwd: r.T, merge: true, env: { HADES_WORK_ROOT: W1, HADES_CERBERUS_TIMEOUT_S: "3", ...extra } });
  return `${o.out}rc=${o.rc}\n`;
};
/** nz: o que muda entre uma execução e outra sem ser comportamento (ids, instantes, caminhos). */
const nz = (s: string): string => s
  .replaceAll(r.T, "<T>").replaceAll(SKILL, "<REPO>").replace(/hades-ts-[A-Za-z0-9]{6}/g, "hades-ts-<R>").replace(/[0-9a-f]{12}/g, "<id>").replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z/g, "<ts>")
  .replace(/cts-(old|new)/g, "cts-X").replace(/cts-w[01]/g, "cts-wX").replace(/[0-9]{10}(\.[0-9]+)?/g, "<n>");
const same = (label: string, ...args: string[]) => c.want(label, sub(g.get<string>(label)), sub(nz(pc(args))));
const words = (s: string) => s.split(/\s+/).filter(Boolean);

// guardas de teste na cópia: cabeça, id, momentos (vírgula) e o corpo do script (bash)
const guard = (cab: string, id: string, ms: string, body: string, ext: Record<string, unknown> = {}) => {
  for (const S of SS) writeGuard(`${S}/loop/cerberus`, cab, id, ms.split(","), body, ext);
};
const ev = (res: string) => evJson(res, "loop/test/cerberus/ts.sh", { detalhe: "d" });
for (const [id, res] of [["t-o", "ok"], ["t-a", "aviso"], ["t-b", "barra"]] as [string, string][]) guard("porta", id, "release,done,continuo,push", `echo '${ev(res)}'`);
guard("limiar", "t-sem-evidencia", "release", `echo '{"resultado": "ok"}'`);
guard("limiar", "t-lixo", "release", "echo nao-e-json");
guard("limiar", "t-saiu-1", "done", "exit 1");
guard("limiar", "t-nada", "continuo", "true");
guard("limiar", "t-outro-id", "release", `echo '{"guarda": "outra", "resultado": "ok", "evidencia": [{"conferido": "a", "onde": "b"}]}'`);
guard("vigilia", "t-lenta", "release", "sleep 6", { timeoutS: 1 });
guard("vigilia", "t-ctx", "release", String.raw`echo "{\"resultado\": \"ok\", \"evidencia\": [{\"conferido\": \"$CERBERUS_CTX_PR $CERBERUS_MOMENTO $CERBERUS_CABECA\", \"onde\": \"$(basename "$CERBERUS_DIR")\"}]}"`);
guard("vigilia", "t-barra", "continuo", `echo '${ev("barra")}'`);
// script sem permissão de execução: "não executou"
guard("vigilia", "t-sem-x", "release", "true");
for (const S of SS) chmodSync(`${S}/loop/cerberus/vigilia/checks/t-sem-x.sh`, 0o644);

// leitura e uso
for (const a of ["modos", "modos --json", "guardas", "guardas --json", "guardas --validar", "guardas --cabeca porta", "historico", "historico --json",
  "excecao listar", "excecao listar --json", "estado --json", "-h", "", "bogus", "avaliar", "avaliar bogus", "avaliar push --cabeca x",
  "registrar", "excecao", "excecao abrir", "historico --limite 0", "historico --limite x", "avaliar push --ctx Ruim=1", "avaliar push --dir"]) {
  same(`cerberus ${a || "sem argumento"}: saída e código iguais ao gravado`, ...words(a));
}
extra = { HADES_CERBERUS_VIGILIA: "talvez" }; same("modo inválido: igual (recusa, exit 2)", "avaliar", "release"); same("modo inválido: modos", "modos");
extra = { HADES_CERBERUS_TIMEOUT_S: "0" }; same("timeout fora da faixa: igual", "avaliar", "release"); extra = {};

// registrar: veredito de guarda emitida, e as recusas
const REG = ["registrar", "--cabeca", "vigilia", "--guarda", "excecao-so-dono", "--momento", "continuo"];
same("registrar válido: igual", ...REG, "--resultado", "barra", "--evidencia", "regra conferida|loop/hooks/hades-guard.py", "--detalhe", "x", "--ctx", "a=1");
same("registrar sem evidência: igual", ...REG, "--resultado", "barra");
same("registrar evidência sem |: igual", ...REG, "--resultado", "barra", "--evidencia", "so conferido");
same("registrar momento fora do registro: igual", "registrar", "--cabeca", "vigilia", "--guarda", "excecao-so-dono", "--momento", "release", "--resultado", "ok", "--evidencia", "a|b");
same("registrar resultado inválido: igual", ...REG, "--resultado", "talvez", "--evidencia", "a|b");
same("registrar guarda exec: igual", "registrar", "--cabeca", "porta", "--guarda", "t-o", "--momento", "push", "--resultado", "ok", "--evidencia", "a|b");
same("registrar efeito inválido: igual", ...REG, "--resultado", "ok", "--evidencia", "a|b", "--efeito", "x");
same("registrar com efeito e contexto: igual", ...REG, "--resultado", "barra", "--evidencia", "a|b", "--efeito", "aviso", "--ctx", "k=v", "--dir", r.T);

// avaliação de cada momento, nos três modos da Vigília
for (const m of ["release", "done", "continuo", "push", "plugin"]) {
  same(`avaliar ${m}: igual`, "avaliar", m);
  same(`avaliar ${m} --json: igual`, "avaliar", m, "--json", "--ctx", "pr=7");
}
same("avaliar com --cabeca: igual", "avaliar", "release", "--cabeca", "porta");
for (const md of ["off", "avisa", "barra"]) { extra = { HADES_CERBERUS_VIGILIA: md, HADES_CERBERUS_PORTA: md }; same(`avaliar release com cabeças em ${md}: igual`, "avaliar", "release", "--json"); extra = {}; }
same("avaliar com --dir: igual", "avaliar", "release", "--dir", r.T, "--ctx", "pr=3");

// exceção: aberta, usada uma vez, listada
const EXC = ["excecao", "abrir", "--cabeca", "porta", "--guarda", "t-b"];
same("excecao abrir: igual", ...EXC, "--momento", "push", "--motivo", "teste de paridade", "--alvo", "pr=9");
same("excecao abrir com --json: igual", ...EXC, "--momento", "done", "--motivo", "teste de paridade", "--json");
same("excecao abrir guarda inexistente: igual", "excecao", "abrir", "--cabeca", "porta", "--guarda", "nao-existe", "--momento", "push", "--motivo", "teste de paridade");
same("excecao abrir momento inválido: igual", ...EXC, "--momento", "x", "--motivo", "teste de paridade");
same("excecao abrir motivo curto: igual", ...EXC, "--momento", "push", "--motivo", "curto");
same("excecao abrir sem --motivo: igual", ...EXC, "--momento", "push");
same("excecao abrir --alvo inválido: igual", ...EXC, "--momento", "push", "--motivo", "teste de paridade", "--alvo", "Ruim");
extra = { HADES_CERBERUS_PORTA: "barra" };
same("avaliar push com exceção de alvo errado: barra", "avaliar", "push", "--ctx", "pr=1");
same("avaliar push com exceção de alvo certo: libera", "avaliar", "push", "--ctx", "pr=9");
same("avaliar push de novo: exceção de uso único", "avaliar", "push", "--ctx", "pr=9");
same("avaliar done: exceção sem alvo libera", "avaliar", "done", "--json");
extra = {};
same("excecao listar depois do uso: igual", "excecao", "listar");
same("excecao listar --json depois do uso: igual", "excecao", "listar", "--json");
same("historico depois de tudo: igual", "historico", "--limite", "500");
same("historico filtrado: igual", "historico", "--cabeca", "porta", "--efeito", "liberado", "--json");
same("estado depois de tudo: igual", "estado", "--json");
for (const f of ["vereditos.jsonl", "excecoes.json"]) {
  const label = `arquivo de estado ${f}: byte a byte igual (normalizado)`;
  c.want(label, sub(g.get<string>(label)), sub(nz(readFileSync(`${W1}/_maquina/cerberus/${f}`, "utf8"))));
}

// rotação do histórico (duas gerações) e arquivos corrompidos
const ROTACAO = `const { record } = await import(process.argv[2] + "/src/lib/cerberus.ts");
for (let i = 0; i < 80; i++) record("vigilia", "excecao-so-dono", "continuo", "ok", [{ conferido: "rotação " + "x".repeat(200), onde: "teste" }], { now: 1761480000.0 + i });
`;
writeFileSync(`${r.T}/cts-rotacao.ts`, ROTACAO);
r.must(r.X([BUN, `${r.T}/cts-rotacao.ts`, S1], { env: { HADES_WORK_ROOT: W1, HADES_CERBERUS_HIST_KB: "16" } }));
for (const W of WS) appendFileSync(`${W}/_maquina/cerberus/vereditos.jsonl`, '{"ts": "cortada');
same("histórico com linha cortada: igual", "historico", "--json", "--limite", "3");
for (const W of WS) writeFileSync(`${W}/_maquina/cerberus/excecoes.json`, "{\n");
same("excecoes.json ilegível: igual (recusa)", "excecao", "listar");
for (const W of WS) writeFileSync(`${W}/_maquina/cerberus/excecoes.json`, '{"a": 1}\n');
same("excecoes.json que não é lista: igual", "excecao", "listar", "--json");

// registro inválido: --validar reprova e a avaliação recusa (a mensagem do JSON quebrado é a de cada linguagem: só o código)
for (const S of SS) writeFileSync(`${S}/loop/cerberus/porta/t-quebrada.json`, '{"titulo": "x", "momentos": ["push"], "tipo": "magia", "origem": "teste"}\n');
// stdout e stderr à parte: o Python em pipe esvazia o stderr antes do stdout, a ordem entre eles não é contrato
const splitOut = (o: { out: string; err: string; rc: number }) => `${sub(nz(o.out))}|${sub(nz(`${o.err}${o.rc}\n`))}`;
const split = () => splitOut(r.hadesIn(S1, ["cerberus", "guardas", "--validar"], { env: { HADES_WORK_ROOT: W1 } }));
c.want("registro com tipo inválido: guardas --validar igual (stdout, stderr e código)", g.get<string>("registro com tipo inválido: guardas --validar"), split());
same("registro com tipo inválido: avaliar igual", "avaliar", "push");
for (const S of SS) writeFileSync(`${S}/loop/cerberus/porta/t-json.json`, "{\n");
const rcOf = (saida: string) => sub(saida).split("\n").pop()?.replace("rc=", "") ?? "";
c.want("registro com JSON quebrado: ambos recusam (exit 2)", g.get<string>("registro com JSON quebrado: rc"), rcOf(pc(["avaliar", "push"])));
for (const S of SS) r.X(["rm", "-f", `${S}/loop/cerberus/porta/t-json.json`]);

// o corpo (src/lib/cerberus.ts) chamado direto, o que o painel, o plugins e os checks usam, com o instante fixo
// (saída idêntica ao gravado; o Python grava o instante como float 1761480000.0, o TypeScript como 1761480000: só a grafia)
const MODULO = String.raw`import { pathToFileURL } from "node:url";
const [, , bin, T] = process.argv;
const lib = await import(bin + "/src/lib/cerberus.ts");
const { Recusa } = lib;
const pyj = (v) => (v === undefined || v === null ? "null" : Array.isArray(v) ? "[" + v.map(pyj).join(", ") + "]"
  : typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ": " + pyj(v[k])).join(", ") + "}" : JSON.stringify(v));
const show = (label, f) => {
  let r;
  try { r = f(); } catch (e) { if (e instanceof Recusa) r = ["Recusa", e.message]; else throw e; }
  console.log(label + " " + pyj(r).replaceAll(bin, "<bin>"));
};
const semAvaliacao = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "avaliacao"));
const semId = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "id"));
const NOW = 1761480000.0;
show("consts", () => [[...lib.CABECAS], [...lib.MOMENTOS], lib.EVID_MAX, lib.TEXT_MAX, lib.DETAIL_MAX, lib.CTX_MAX]);
const cfg = lib.config(process.env);
show("config", () => Object.keys(cfg).filter((k) => k.startsWith("HADES_CERBERUS_")).sort());
show("config-sem-env", () => lib.config()["HADES_CERBERUS_PORTA"]);
show("cfg_int", () => lib.cfgInt(cfg, "HADES_CERBERUS_TIMEOUT_S", 1, 600));
show("cfg_int-fora", () => lib.cfgInt(cfg, "HADES_CERBERUS_TIMEOUT_S", 10, 600));
show("cfg_int-ausente", () => lib.cfgInt(cfg, "NAO_EXISTE", 1, 2));
show("modes", () => lib.modes(cfg));
show("modes-ruim", () => lib.modes({ ...cfg, HADES_CERBERUS_PORTA: "x'y" }));
show("work_root", () => String(lib.workRoot()).replaceAll(T, "<T>"));
show("registry", () => { const r = lib.registry(); return [r.guardas.map((g) => g.cabeca + "/" + g.id), r.erros]; });
show("parse_ctx", () => lib.parseCtx(["a=1", "b=x=y"]));
show("parse_ctx-ruim", () => lib.parseCtx(["A=1"]));
show("verdict_error", () => lib.verdictError({ resultado: "ok", evidencia: [] }, "porta", "x", "push") ?? null);
show("verdict_error-cabeca", () => lib.verdictError({ cabeca: "z", resultado: "ok" }, "porta", "x", "push") ?? null);
show("record", () => semAvaliacao(lib.record("vigilia", "excecao-so-dono", "continuo", "barra", [{ conferido: "a", onde: "b" }], { ctx: { k: "v" }, cwd: "/tmp", now: NOW })));
show("record-recusa", () => lib.record("vigilia", "excecao-so-dono", "continuo", "barra", [], { now: NOW }));
show("evaluate", () => [semAvaliacao(lib.evaluate("push", { pr: "1" }, "/tmp", { only: "porta", now: NOW }))]);
show("evaluate-momento", () => lib.evaluate("x", {}, "/tmp"));
show("open_exception", () => semId(lib.openException("porta", "t-b", "push", "motivo de teste", { alvo: { pr: 1 }, por: "dono", origem: "painel", ttlS: 3600, now: NOW })));
show("open_exception-recusa", () => lib.openException("porta", "nao", "push", "motivo de teste", { por: "dono", origem: "painel", ttlS: 3600, now: NOW }));
show("load_exceptions", () => lib.loadExceptions().map(semId));
show("history", () => lib.history("porta", undefined, 5).map(semAvaliacao));
const st = lib.state(cfg);
show("state", () => Object.fromEntries(Object.entries(st).filter(([k]) => k !== "barrados").map(([k, v]) => [k, k === "excecoes" || k === "historico" ? v.map((x) => Object.fromEntries(Object.entries(x).filter(([kk]) => kk !== "id" && kk !== "avaliacao"))) : v])));
show("store", () => String(lib.store()).replaceAll(T, "<T>"));
show("now_iso", () => lib.nowIso(NOW));
`;
writeFileSync(`${r.T}/cts-modulo.ts`, MODULO);
const modulo = () => r.X([BUN, `${r.T}/cts-modulo.ts`, S1, r.T],
  { merge: true, env: { HADES_WORK_ROOT: `${r.T}/cts-f1`, HADES_CERBERUS_TIMEOUT_S: "3", HADES_CERBERUS_PORTA: "barra" } }).out;
// o instante gravado é float (1761480000.0) e o do TypeScript é número JSON (1761480000): mesmo valor, outra grafia
const instante = (s: string) => s.replace(/(\d{10})\.0\b/g, "$1");
c.want("módulo: o que o painel e o plugins chamam, igual ao gravado", instante(sub(g.get<string>("módulo: o que o painel e o plugins chamam"))), instante(sub(modulo().replace(/cts-f1/g, "cts-fX").replaceAll(r.T, "<T>"))));
{
  const o = r.hadesIn(S1, ["cerberus", "registrar", "--cabeca", "vigilia", "--guarda", "excecao-so-dono", "--momento", "continuo", "--resultado", "ok", "--evidencia", "a|b"],
    { env: { HADES_WORK_ROOT: `${r.T}/cts-f1` } });
  const hist = `${r.T}/cts-f1/_maquina/cerberus/vereditos.jsonl`;
  const gravou = existsSync(hist) && readFileSync(hist, "utf8").includes('"origem": "emitida"');
  c.want("módulo: CLI (registrar pela linha de comando, como o gate-lock)", "0 sim", sub(`${o.out}${o.rc} ${gravou ? "sim\n" : ""}`));
}

// sem Bun o lançador `hades` falha cedo: 69 com a instrução de instalar
const NB = `${r.T}/cts-nobun`;
mkdirSync(NB, { recursive: true });
for (const t of ["bash", "awk", "cut", "dirname", "readlink"]) symlinkSync(Bun.which(t) ?? `/usr/bin/${t}`, `${NB}/${t}`);
const semBun = (argv: string[]) => {
  const o = r.X(argv, { env: { PATH: NB, HADES_BUN: "", HOME: `${r.T}/nada` } });
  return sub(`${o.out}${o.rc} ${o.err.includes("Como instalar") ? "sim\n" : ""}`);
};
c.want("sem Bun: o lançador hades sai 69 com a instrução de instalar", "69 sim", semBun([Bun.which("bash") ?? "/usr/bin/bash", `${S1}/loop/bin/hades`, "cerberus", "modos"]));

describe("cerberus-ts", () => c.register());
