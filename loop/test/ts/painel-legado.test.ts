// Painel em TypeScript: config (`hades config`), version-check (`hades version-check`) e o servidor (`hades panel serve`),
// cada um com a saída, o código de saída e os arquivos de estado iguais ao gravado em loop/test/golden/legado/, em pastas
// $D iguais.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { legado } from "./lib/legado";
import { BUN, Rig, SKILL, SKILL_VERSION, type Env, MAC_BIN } from "./lib/rig";

const r = new Rig().setup();
const g = legado(import.meta.path);
afterAll(() => r.cleanup());
const T = r.T, K = `${SKILL}/kit`, DN = `${T}/bp-dn`;
const NODE_DIR = r.env0.PATH?.split(":")[1] ?? "/usr/bin";

const wr = (p: string, s: string) => writeFileSync(p, s);
const slurp = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const mk = (...d: string[]) => { for (const x of d) mkdirSync(x, { recursive: true }); };

/** mkd: $D com o catálogo do kit */
function mkd(d: string): void {
  rmSync(d, { recursive: true, force: true }); mk(d); copyFileSync(`${K}/config.tsv`, `${d}/config.tsv`);
}
const xx = (d: string, argv: string[], env: Env = {}) => r.X(argv, { merge: true, env: { HADES_SKILL_DIR: SKILL, HADES_DATA: d, HADES_KIT_DIR: d, ...env } });
/** side2: o comando com `$1` = $D; saída (caminhos e hora normalizados) e código */
const side2 = (d: string, cmd: string) => { const o = xx(d, ["bash", "-c", cmd, "_", d]); return `${o.out.split(d).join("<D>").split(SKILL_VERSION).join("<V>").replace(/exportado em [0-9: -]*/g, "exportado em <HORA>")}rc=${o.rc}`; };
/** cmp2: o comando pela CLI (`@CFG@` = `hades config`) × a saída gravada */
const NEW_CFG = `"$HADES_BUN" "$HADES_SKILL_DIR/src/cli.ts" config`;
const cmp2 = (label: string, cmd: string) => test(`${label}: saída e código iguais ao gravado`, () => {
  const atual = side2(DN, cmd.replaceAll("@CFG@", NEW_CFG)); g.fix(label, atual); expect(atual).toBe(g.get(label));
}, 30_000);

// ---- config: show, get, set, unset, export, import ----
describe("config", () => {
  beforeAll(() => { mkd(DN); });
  const C = (...a: string[]) => `@CFG@ ${a.join(" ")}`.trimEnd();
  cmp2("config show", C("show"));
  cmp2("config sem argumento", C());
  cmp2("config get", `${C("get HADES_SLICE_MAX")}; ${C("get NAO_EXISTE")}`);
  cmp2("config uso (get sem chave, comando solto)", `${C("get")}; ${C("zzz")}`);
  cmp2("config set válido (tipos variados)", C("set HADES_SLICE_MAX=4g HADES_SVC_HEAP_MB=0512 HADES_GATE_COST_MEASURED=sim"));
  cmp2("config set inválido (inteiro fora da faixa)", C("set HADES_SVC_HEAP_MB=99999"));
  cmp2("config set inválido (tamanho)", C("set HADES_SLICE_MAX=12"));
  cmp2("config set com chave desconhecida", C("set NAO_EXISTE=1"));
  cmp2("config set sem KEY=VALUE", C("set HADES_SLICE_MAX"));
  cmp2("config set com MemoryHigh acima do teto", C("set HADES_SLICE_HIGH=9G"));
  cmp2("config show depois do set", C("show"));
  test("config: config.env igual depois do set", () => { expect(slurp(`${DN}/config.env`)).toBe(g.get<string>("config.env depois do set")); });
  cmp2("config unset", `${C("unset HADES_SVC_HEAP_MB")}; ${C("unset NAO_EXISTE")}`);
  cmp2("config export (padrão, --all, --include-identity)", `${C("export")}; ${C("export --all")} | head -5; ${C("export --include-identity")} | tail -2`);
  cmp2("config export com flag inválida", C("export --x"));
  // um valor por tipo do catálogo: o validador tem de aceitar e recusar igual
  test("config: tipos do catálogo conhecidos", () => {
    const known = new Set("size int bool percent enum multi globs ttl login logins emails tags modelmap id digits path secret relpath cidr port repo url hours".split(" "));
    const tipos = new Set<string>();
    for (const l of readFileSync(`${K}/config.tsv`, "utf8").split("\n")) { if (l.startsWith("#") || !l.includes("\t")) continue; const c = l.split("\t")[2]; if (c !== undefined) tipos.add(c.replace(/:.*/, "")); }
    const novos = [...tipos].filter((t) => t && !known.has(t)).map((t) => `novo:${t}`);
    expect(novos.length ? novos.join("\n") : "sim").toBe("sim");
  });
  for (const v of ["HADES_SLICE_SWAP=1GB", "HADES_SLICE_SWAP=63M", "HADES_GATE_PSI_MAX=-1", "HADES_GATE_PRIORITY=-9", "HADES_GATE_PRIORITY=x", "HADES_GATE_COST_MEASURED=talvez", "HADES_GATE_COST_MEASURED=Não"])
    cmp2(`config set ${v}`, `@CFG@ set '${v}'`);
  const IMP = `${T}/bp-imp.env`;
  beforeAll(() => wr(IMP, "HADES_SVC_HEAP_MB=256\nHADES_BUILD_COST_GB=zz\nNAO_EXISTE=1\nlixo\n# comentário\n\nHADES_SLICE_MAX=2G\n"));
  cmp2("config import --dry-run", C(`import ${IMP} --dry-run`));
  cmp2("config import sem --yes com erro", `${C(`import ${IMP}`)} < /dev/null`);
  cmp2("config import --yes", C(`import ${IMP} --yes`));
  cmp2("config import sem TTY e sem --yes", `printf "HADES_SVC_HEAP_MB=300\\n" > "$1/ok.env"; ${C('import "$1/ok.env"')} < /dev/null`);
  cmp2("config import de arquivo inexistente", `${C("import /nao/existe")} > /dev/null 2>&1; echo $?`);
  cmp2("config import uso", C("import"));
  test("config: config.env igual depois do import", () => { expect(slurp(`${DN}/config.env`)).toBe(g.get<string>("config.env depois do import")); });
  // o painel importa o corpo do config: a API (effective, save, plan, exportText, catalog, validate, instanceId, healthPaths) segue exportada
  test("config: API de módulo (effective, save, plan, exportText) segue importável", () => {
    const script = `const cc = await import(process.argv[2] + "/src/lib/config-catalog.ts"); const cf = await import(process.argv[2] + "/src/lib/config.ts");
const store = { dir: process.argv[3], kit: process.argv[3] };
const ok = ["effective", "save", "plan", "exportText", "catalog", "validate"].every((n) => typeof cc[n] === "function") && ["instanceId", "healthPaths"].every((n) => typeof cf[n] === "function") && cc.effective(store).length > 0;
console.log(ok ? "sim" : "não");`;
    wr(`${T}/bp-api.ts`, script);
    const o = xx(DN, [BUN, `${T}/bp-api.ts`, SKILL, DN]);
    expect(o.out.trim()).toBe("sim");
  });
  // plugin: catálogo do plugin soma chaves e troca padrão
  beforeAll(() => { for (const d of [DN]) { mk(`${d}/plugin`); wr(`${d}/plugin/config.tsv`, "HADES_SLICE_SWAP\t1G\tsize\tMemória\tSwap\tslice\tx\nPLUGIN_CHAVE\t7\tint:1:9\tPlugin\tChave\tnext\ty\n"); } });
  cmp2("config show com catálogo do plugin", `${C("show")} | grep -E "SWAP|PLUGIN"; ${C("set PLUGIN_CHAVE=8")}; cat "$1/config.env" | grep PLUGIN`);
  cmp2("config catálogo do plugin malformado", `printf "ruim\\n" > "$1/plugin/config.tsv"; ${C("show")} 2>&1 | tail -1`);
});

// ---- version-check: status, doctor, --refresh, --json (gh falso, nunca rede) ----
describe("version-check", () => {
  const VB = `${T}/bp-gh`;
  beforeAll(() => {
    mk(VB);
    wr(`${VB}/gh`, `#!/usr/bin/env bash
echo "$*" >> "\${FAKE_VC_LOG:-/dev/null}"
if [[ $1 == auth ]]; then [[ $4 == nobody ]] && exit 1; echo "tok-$4"; exit 0; fi
sleep "\${FAKE_VC_SLEEP:-0}"
[[ \${FAKE_VC_RC:-0} == 0 ]] || exit "\${FAKE_VC_RC}"
printf "%s\\n" "\${FAKE_VC_VERSION:-}"
`); chmodSync(`${VB}/gh`, 0o755);
  });
  const chk = (s: string) => s.replace(/"checkedAt": "[^"]*"/g, '"checkedAt": "<T>"');
  /** vcmp: <ambiente…> -- <argumentos de `hades version-check`> */
  const vcmp = (label: string, env: Env, args: string[]) => test(`${label}: saída, código e cache iguais ao gravado`, () => {
    const run = (d: string, argv: string[]) => { const o = xx(d, argv, { PATH: `${VB}:${MAC_BIN}/usr/bin:/bin:${NODE_DIR}`, HADES_SKILL_DIR: "/skill", W: "/wt", HADES_VERSION_CHECK_RAW_BASE: "http://127.0.0.1:1", ...env }); return `${chk(o.out)}rc=${o.rc}`; };
    mkd(DN); wr(`${DN}/kit.version`, "4.6.0\n");
    // HADES_SKILL_DIR do ambiente é o `/skill` falso do caso: o `bun` da CLI vem de HADES_BUN e o cli.ts do caminho da skill
    expect(run(DN, [BUN, `${SKILL}/src/cli.ts`, "version-check", ...args]), "saída").toBe(g.get(`${label}: saída`));
    expect(chk(slurp(`${DN}/version-check.json`)), "cache").toBe(g.get(`${label}: cache`));
  }, 60_000);
  const R = ["status", "--refresh", "--json"];
  vcmp("version-check status sem cache", {}, ["status", "--json"]);
  vcmp("version-check sem argumento (uso)", {}, []);
  vcmp("version-check subcomando inválido", {}, ["zzz"]);
  vcmp("version-check status --refresh com versão nova", { FAKE_VC_VERSION: "4.7.0" }, ["status", "--refresh"]);
  vcmp("version-check status --refresh --json", { FAKE_VC_VERSION: "4.7.0" }, R);
  vcmp("version-check doctor --refresh", { FAKE_VC_VERSION: "4.10.0" }, ["doctor", "--refresh"]);
  vcmp("version-check em dia", { FAKE_VC_VERSION: "4.6.0" }, R);
  vcmp("version-check gh sai com erro", { FAKE_VC_RC: "4" }, R);
  vcmp("version-check versão remota fora do formato", { FAKE_VC_VERSION: "lixo" }, R);
  vcmp("version-check intervalo 0 desliga", { HADES_VERSION_CHECK_HOURS: "0", FAKE_VC_VERSION: "9.0.0" }, R);
  vcmp("version-check repo inválido", { HADES_VERSION_CHECK_REPO: "x" }, R);
  vcmp("version-check conta do gh", { HADES_VERSION_CHECK_GH_USER: "fulano", FAKE_VC_VERSION: "4.9.0" }, R);
  vcmp("version-check conta do gh sem login", { HADES_VERSION_CHECK_GH_USER: "nobody", FAKE_VC_VERSION: "4.9.0" }, R);
  vcmp("version-check conta do gh inválida", { HADES_VERSION_CHECK_GH_USER: "a b" }, R);
  vcmp("version-check timeout", { HADES_VERSION_CHECK_TIMEOUT: "1", FAKE_VC_SLEEP: "3", FAKE_VC_VERSION: "4.9.0" }, R);
});

// ---- servidor: rotas de `hades panel serve` × o gravado do servidor Python ----
describe("servidor", () => {
  const DS = `${T}/bp-srv`;
  let pn = "", procs: ReturnType<typeof Bun.spawn>[] = [];
  const freePort = () => { const s = Bun.serve({ port: 0, fetch: () => new Response("") }); const p = String(s.port); s.stop(true); return p; };
  const curl = (port: string, args: string[], env: Env = {}) => r.X(["curl", "-s", ...args.map((a) => a.replace("@P@", port))], { env });
  beforeAll(() => {
    rmSync(DS, { recursive: true, force: true }); mk(DS);
    copyFileSync(`${K}/config.tsv`, `${DS}/config.tsv`);
    // o painel lê a checagem de versão do config.env, não do ambiente do processo: sem isto o teste iria ao GitHub de verdade
    // (a porta 1 recusa na hora e a checagem cai no gh, como antes do GET anônimo)
    writeFileSync(`${DS}/config.env`, "HADES_VERSION_CHECK_RAW_BASE=http://127.0.0.1:1\n");
    // cache recém-gravado e sem acesso: a checagem não está vencida, então o snapshot não depende de uma consulta em segundo plano
    // terminar a tempo (sob carga ela atrasava e `checkedAt` saía nulo)
    writeFileSync(`${DS}/version-check.json`, JSON.stringify({ repo: "The-Hades-Organization/Hades-Skill", ghUser: "", checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), access: false, remote: "" }));
    // /api/notify roda $D/notify.sh (e este o hades-ts.sh): o painel espera o kit instalado em $D
    for (const f of ["notify.sh", "hades-ts.sh"]) copyFileSync(`${K}/${f}`, `${DS}/${f}`);
    r.X(["cp", "-r", `${K}/panel`, `${DS}/panel`]); // a interface e o service worker saem de $D/panel
    // docker falso e mudo: o /api/snapshot listaria os containers vivos da máquina (o projeto compose `hades` do dono)
    const fakeDocker = `${T}/bp-docker`;
    mkdirSync(fakeDocker, { recursive: true }); writeFileSync(`${fakeDocker}/docker`, "#!/bin/sh\nexit 0\n"); chmodSync(`${fakeDocker}/docker`, 0o755);
    // qrencode falso: o `qr` do /api/notify diz se a ferramenta existe no PATH, e o golden foi gravado com ela; sem o stub o resultado seguiria a máquina
    writeFileSync(`${fakeDocker}/qrencode`, "#!/bin/sh\nexit 0\n"); chmodSync(`${fakeDocker}/qrencode`, 0o755);
    pn = freePort();
    procs.push(Bun.spawn([BUN, `${SKILL}/src/cli.ts`, "panel", "serve", "--port", pn], { env: { ...r.env0, PATH: `${fakeDocker}:${r.env0.PATH}`, HADES_SKILL_DIR: SKILL, HADES_DATA: DS }, stdout: "ignore", stderr: "ignore" }));
    for (let i = 0; i < 40; i++) { if (curl(pn, ["-o", "/dev/null", "localhost:@P@/auth"]).rc === 0) break; Bun.sleepSync(250); }
  }, 30_000);
  afterAll(() => { for (const p of procs) p.kill(); });
  const BODY = `${T}/bp-body`;
  /** scmp: mesmo status, cabeçalhos (sem Date/Server/Content-Length) e corpo */
  const resp = (port: string, m: string, route: string, b: string) => {
    const a = m === "POST" ? ["-D", "-", "-o", BODY, "-X", "POST", "-H", "Content-Type: application/json", "-d", b, `localhost:@P@${route}`] : ["-D", "-", "-o", BODY, `localhost:@P@${route}`];
    const h = curl(port, a).out.replace(/\r/g, "").split("\n").filter((l) => !/^(date:|server:|content-length)/i.test(l)).map((l) => l.replace(/^HTTP\/[0-9.]* /, "HTTP ")).sort().join("\n");
    return `${h}\n${slurp(BODY)}`.split(T).join("<T>").split(SKILL_VERSION).join("<V>"); // o caminho do $D entra em /api/config
  };
  const scmp = (label: string, m: string, route: string, b = "{}") => test(`${label}: servidor igual ao gravado`, () => { g.confere(label, resp(pn, m, route, b)); }, 30_000);
  for (const rt of ["/api/config", "/api/quality", "/api/doctor", "/api/docs", "/api/remote", "/auth", "/sw.js", "/manifest.webmanifest", "/offline.html", "/nada", "/api/doc?name=nada"]) scmp(`GET ${rt}`, "GET", rt);
  for (const rt of ["/api/log-files", "/api/log", "/api/notify", "/api/notify/qr", "/api/orchestration", "/api/orchestration/file", "/api/orchestration/terminal", "/api/reviews", "/api/review/report",
    "/api/github/prs", "/api/github/authors", "/api/disk/preview?cat=images", "/api/widget", "/api/widget/token", "/api/widget/apk", "/api/widget/apk/download"]) scmp(`GET ${rt}`, "GET", rt);
  // /api/gates: mesma forma e mesmos valores estáveis (horários, memória e histórico mudam entre as duas leituras)
  test("GET /api/gates: mesmas chaves e gates do gravado", () => {
    const f = (port: string) => { const d = JSON.parse(curl(port, ["localhost:@P@/api/gates"]).out); return JSON.stringify([Object.keys(d).sort(), Object.keys(d.host ?? {}).sort(), d.repo, (d.gates ?? []).map((g: { label: string }) => g.label)]); };
    expect(f(pn)).toBe(g.get<string>("GET /api/gates"));
  });
  scmp("POST /api/config/preview", "POST", "/api/config/preview", '{"values":{"HADES_SLICE_MAX":"4g"}}');
  scmp("POST /api/config/preview corpo que não é objeto", "POST", "/api/config/preview", "[1]");
  scmp("POST /api/login chave errada", "POST", "/api/login", '{"key":"x"}');
  test("Host forjado é recusado como no gravado", () => {
    const f = (port: string) => curl(port, ["-H", "Host: evil.com", "-o", "/dev/null", "-w", "%{http_code}", "localhost:@P@/api/config"]).out;
    expect(f(pn)).toBe(g.get<string>("Host forjado"));
  });
  // snapshot: mesma estrutura e valores estáveis (horários, memória, cpu, histórico e carga mudam entre as duas leituras)
  const V = new Set(["t", "age", "cpu", "mem", "avail", "slice", "svc", "infra", "extra", "memAvailable", "swapUsed", "load", "history", "fetchedAt", "statusAt", "readyCode", "ready"]);
  const norm = (x: unknown): unknown => Array.isArray(x) ? x.map(norm) : x && typeof x === "object"
    ? Object.fromEntries(Object.entries(x).filter(([k]) => !V.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, norm(v)])) : x;
  test("GET /api/snapshot: servidor igual ao gravado (campos estáveis)", () => {
    const f = (port: string) => JSON.stringify(norm(JSON.parse(curl(port, ["localhost:@P@/api/snapshot"]).out))).split(T).join("<T>")
      .replace(/\d+ (?:second|minute|hour|day|week|month)s? ago/g, "<N> ago").replace(/"checkedAt":"[^"]*"/g, '"checkedAt":"<T>"')
      .replace(/"(memTotal|swapTotal|ncpu)":\d+/g, '"$1":<N>'); // idade dos containers, hora da checagem e memória/swap totais dependem da máquina e do momento
    g.confere("GET /api/snapshot", f(pn));
  });
  test("GET /api/snapshot: mesma ordem das chaves do topo", () => {
    const f = (port: string) => JSON.stringify(Object.keys(JSON.parse(curl(port, ["localhost:@P@/api/snapshot"]).out)));
    expect(f(pn)).toBe(g.get<string>("GET /api/snapshot: ordem das chaves"));
  });
  // acmp: POST com o token da sessão de cada servidor (as recusas de entrada, sem lançar job)
  const acmp = (label: string, route: string, b: string) => test(`${label}: servidor igual ao gravado`, () => {
    const f = (port: string) => { const t = JSON.parse(curl(port, ["localhost:@P@/api/token"]).out).token; return curl(port, ["-w", " %{http_code}", "-X", "POST", "-H", `X-Panel-Token: ${t}`, "-H", "Content-Type: application/json", "-d", b, `localhost:@P@${route}`]).out; };
    g.confere(label, f(pn));
  }, 30_000);
  acmp("POST /api/action ação desconhecida", "/api/action", '{"action":"zzz"}');
  acmp("POST /api/action op fora da lista", "/api/action", '{"action":"pause","op":"x"}');
  acmp("POST /api/action PR inválida", "/api/action", '{"action":"run-hades","prs":"x"}');
  acmp("POST /api/action revisão sem PR", "/api/action", '{"action":"review","pr":"x"}');
  acmp("POST /api/action container fora da lista", "/api/action", '{"action":"container","op":"stop","name":"nope"}');
  acmp("POST /api/action prs sem entrada", "/api/action", '{"action":"prs","op":"set"}');
  acmp("POST /api/job/stop id inválido", "/api/job/stop", '{"id":"a b"}');
  // interface: /ui/<x>.js sem arquivo serve o <x>.tsx transpilado (sem html`, com createElement); arquivo inexistente é 404
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".tsx") ? [join(d, e.name)] : []));
  for (const tsx of walk(`${K}/panel/ui`).sort()) {
    const rel = tsx.slice(`${K}/panel/ui/`.length).replace(/\.tsx$/, "");
    test(`UI ${rel}.js: servida do .tsx com 200, sem html\` sem transpilar`, () => {
      const out = curl(pn, ["-w", "\n%{http_code}", `localhost:@P@/ui/${rel}.js`]).out;
      expect(`${out.slice(out.lastIndexOf("\n") + 1)} ${out.includes("html`") ? "html" : "ok"}`).toBe("200 ok");
    });
  }
  test("UI: .js sem .tsx correspondente é 404", () => { expect(curl(pn, ["-o", "/dev/null", "-w", "%{http_code}", "localhost:@P@/ui/nao-existe.js"]).out).toBe("404"); });
});
