// Grupo versao-check: hades version-check — semver, cache, intervalo 0, conta do gh, sem acesso. gh falso, nunca rede.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL, kv, readJson, MAC_BIN } from "./lib/rig";
import { isNewer, settings } from "../../../src/lib/version-check";

const r = new Rig();
afterAll(() => r.cleanup());
// porta 1 recusa na hora: o GET anônimo falha sem rede de verdade e a checagem cai no gh falso
const DEAD_RAW = "http://127.0.0.1:1";
const VD = `${r.T}/vc-d`, VB = `${r.T}/vc-bin`, VL = `${r.T}/vc-gh.log`;
const NODE_DIR = r.env0.PATH?.split(":")[1] ?? "/usr/bin";
const KIT = `${SKILL}/kit`;
mkdirSync(VD, { recursive: true }); mkdirSync(VB, { recursive: true });
// gh falso: anota a chamada, responde FAKE_VC_VERSION (ou sai com FAKE_VC_RC) e pode demorar FAKE_VC_SLEEP s
const installGh = () => { writeFileSync(`${VB}/gh`, '#!/usr/bin/env bash\necho "$*" >> "$FAKE_VC_LOG"\n[[ $1 != api ]] || echo "${GH_TOKEN:-}" >> "$FAKE_VC_LOG.tok"\nif [[ $1 == auth ]]; then [[ $4 == nobody ]] && exit 1; echo "tok-$4"; exit 0; fi\nsleep "${FAKE_VC_SLEEP:-0}"\n[[ ${FAKE_VC_RC:-0} == 0 ]] || exit "$FAKE_VC_RC"\nprintf "%s\\n" "${FAKE_VC_VERSION:-}"\n');
chmodSync(`${VB}/gh`, 0o755); };
installGh();

/** Variáveis do processo: FAKE_VC_* com o padrão do run.sh mais as que o caso pede. */
const vcp = (args: string[], e: Record<string, string> = {}) =>
  r.X([BUN, `${SKILL}/src/cli.ts`, "version-check", ...args], { merge: true, env: kv({
    PATH: `${VB}:${NODE_DIR}:${MAC_BIN}/usr/bin:/bin`, HADES_DATA: VD, FAKE_VC_LOG: VL, FAKE_VC_VERSION: "", FAKE_VC_RC: "0", FAKE_VC_SLEEP: "0",
    HADES_SKILL_DIR: "/skill", W: "/wt", HADES_VERSION_CHECK_RAW_BASE: DEAD_RAW }, e) }).out;
const calls = () => (existsSync(VL) ? readFileSync(VL, "utf8").split("\n").filter(Boolean).length : 0);
const tok = () => (existsSync(`${VL}.tok`) ? readFileSync(`${VL}.tok`, "utf8").replaceAll("\n", "") : "");
const cache = () => readJson(`${VD}/version-check.json`);
const reset = () => { for (const f of [VL, `${VL}.tok`, `${VD}/version-check.json`]) rmSync(f, { force: true }); writeFileSync(`${VD}/kit.version`, "4.6.0\n"); };
const semverMaisNovo = (pares: [string, string][]) => pares.map(([a, b]) => String(Number(isNewer(a, b)))).join(" ");
const access = () => String(JSON.parse(vcp(["status", "--json"])).access);

describe("versao-check", () => {
  test("semver: igual, menor, maior e 4.10 contra 4.9", () => {
    expect(semverMaisNovo([['4.6.0', '4.6.0'], ['4.5.9', '4.6.0'], ['4.7.0', '4.6.0'], ['4.10.0', '4.9.0'], ['4.9.0', '4.10.0']])).toBe("0 0 1 1 0");
  });
  test("semver: texto que não é X.Y.Z nunca é mais novo", () => {
    expect(semverMaisNovo([['', '4.6.0'], ['v5.0.0', '4.6.0'], ['5.0.0', '']])).toBe("0 0 0");
  });

  test("versão remota maior: o doctor devolve local, remota e o comando", () => {
    reset();
    const f = vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.7.0" }).replace(/\n$/, "").split("\t");
    expect(`${f[0]} ${f[1]} ${/\/skill\/kit\/install\.sh/.test(f[2] ?? "") ? 1 : 0}`).toBe("4.6.0 4.7.0 1");
  });
  test("a chamada é ao VERSION do repo padrão, com timeout do processo", () => {
    expect(readFileSync(VL, "utf8").replace(/\n$/, "")).toBe("api repos/The-Hades-Organization/Hades-Skill/contents/VERSION -H Accept: application/vnd.github.raw+json");
  });
  test("dentro do intervalo: nova consulta não vai à rede", () => { vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "9.9.9" }); expect(calls()).toBe(1); });
  test("cache em UTC com Z, acesso e versão remota", () => {
    const c = cache(); expect(`${c.access} ${c.remote} ${/Z$/.test(c.checkedAt) ? 1 : 0}`).toBe("true 4.7.0 1");
  });
  test("sem --refresh (doctor --quick) lê só o cache", () => { expect(vcp(["doctor"]).replace(/\n$/, "").split("\t")[1]).toBe("4.7.0"); });

  test("intervalo vencido: consulta de novo e guarda a nova versão", () => {
    const c = cache(); c.checkedAt = "2020-01-01T00:00:00Z"; writeFileSync(`${VD}/version-check.json`, JSON.stringify(c));
    vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.8.0" });
    expect(`${calls()} ${cache().remote}`).toBe("2 4.8.0");
  });
  test("repo diferente do guardado vence o cache", () => {
    vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.8.0", HADES_VERSION_CHECK_REPO: "Outro/Repo" }); expect(calls()).toBe(3);
  });

  test("versão igual: nada aparece", () => {
    reset(); writeFileSync(`${VD}/kit.version`, "4.6.0\n"); expect(vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.6.0" }).replace(/\n$/, "")).toBe("");
  });
  test("instalada mais nova que a remota: nada aparece", () => {
    reset(); writeFileSync(`${VD}/kit.version`, "4.7.0\n"); expect(vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.6.0" }).replace(/\n$/, "")).toBe("");
  });
  test("4.10.0 remota contra 4.9.0 instalada: avisa", () => {
    reset(); writeFileSync(`${VD}/kit.version`, "4.9.0\n");
    expect(vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.10.0" }).replace(/\n$/, "").split("\t")[1]).toBe("4.10.0");
  });

  test("intervalo 0 desliga: sem aviso e sem chamada", () => {
    reset(); expect(`${vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.7.0", HADES_VERSION_CHECK_HOURS: "0" }).replace(/\n$/, "")}|${calls()}`).toBe("|0");
  });
  test("intervalo 0 com cache de versão nova: oculto", () => {
    vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.7.0" });
    const s = JSON.parse(vcp(["status", "--json"], { HADES_VERSION_CHECK_HOURS: "0" })); expect(`${s.enabled} ${s.update}`).toBe("false false");
  });

  test("sem acesso (gh falha): nenhuma saída, sem erro", () => { reset(); expect(vcp(["doctor", "--refresh"], { FAKE_VC_RC: "1" }).replace(/\n$/, "")).toBe(""); });
  test("sem acesso: estado oculto e cache com acesso falso", () => {
    const s = JSON.parse(vcp(["status", "--json"])); expect(`${s.access} ${s.update} ${s.remote !== ""}`).toBe("false false false");
  });
  test("sem acesso: não insiste antes do intervalo", () => { vcp(["doctor", "--refresh"], { FAKE_VC_RC: "1" }); expect(calls()).toBe(1); });
  test("timeout do gh: calado e oculto", () => {
    reset(); const out = vcp(["doctor", "--refresh"], { FAKE_VC_SLEEP: "5", HADES_VERSION_CHECK_TIMEOUT: "2" }).replace(/\n$/, "");
    expect(`${out}|${access()}`).toBe("|false");
  }, 20_000); // o gh falso dorme 5 s de verdade (o sleep órfão segura o pipe até o fim): o teste espera o tempo real, não é ajuste
  test("resposta que não é X.Y.Z: calado e oculto", () => {
    reset(); const out = vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "<html>404</html>" }).replace(/\n$/, "");
    expect(`${out}|${access()}`).toBe("|false");
  });
  test("intervalo padrão é 1 h (config.tsv e fallback do código)", () => {
    reset();
    const row = readFileSync(`${KIT}/config.tsv`, "utf8").split("\n").map((l) => l.split("\t")).find((c) => c[0] === "HADES_VERSION_CHECK_HOURS")?.[1];
    expect(`${row} ${settings({}).hours}`).toBe("1 1");
  });
  test("sem a chave, cache de 90 min já venceu (padrão 1 h)", () => {
    const t = new Date(Date.now() - 90 * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
    writeFileSync(`${VD}/version-check.json`, JSON.stringify({ repo: "The-Hades-Organization/Hades-Skill", ghUser: "", checkedAt: t, access: true, remote: "4.6.0" }));
    vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.7.0" });
    expect(`${calls()} ${cache().remote}`).toBe("1 4.7.0");
  });
  test("conta vazia: usa a conta ativa (sem auth token, sem token no api)", () => {
    reset(); vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.7.0" }); expect(`${calls()} ${tok()}`).toBe("1 ");
  });
  test("HADES_GH_USER definido não interfere: segue a conta ativa", () => {
    reset(); vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.7.0", HADES_GH_USER: "projeto" }); expect(`${calls()} ${tok()}`).toBe("1 ");
  });
  test("conta preenchida: pede o token dela e chama a api com ele", () => {
    reset(); vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.7.0", HADES_VERSION_CHECK_GH_USER: "dono", HADES_GH_USER: "projeto" });
    expect(`${readFileSync(VL, "utf8").split("\n")[0]}|${tok()}`).toBe("auth token --user dono|tok-dono");
  });
  test("conta preenchida: o cache guarda a conta", () => { expect(cache().ghUser).toBe("dono"); });
  test("trocar a conta vence o cache", () => {
    vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "9.9.9", HADES_VERSION_CHECK_GH_USER: "outra" }); expect(`${calls()} ${cache().remote}`).toBe("4 9.9.9");
  });
  test("conta que não existe: calado, oculto e sem chamada à api", () => {
    reset(); const out = vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.7.0", HADES_VERSION_CHECK_GH_USER: "nobody" }).replace(/\n$/, "");
    expect(`${out}|${access()}|${calls()}`).toBe("|false|1");
  });
  test("conta fora do formato de login: recusada antes da chamada", () => {
    reset(); const out = vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.7.0", HADES_VERSION_CHECK_GH_USER: "--hostname" }).replace(/\n$/, "");
    expect(`${out}|${calls()}`).toBe("|0");
  });
  test("sem gh no PATH: calado e oculto", () => {
    reset(); rmSync(`${VB}/gh`, { force: true });
    expect(`${vcp(["doctor", "--refresh"]).replace(/\n$/, "")}|${access()}`).toBe("|false");
  });
  test("repo fora do padrão dono/nome: recusado antes da chamada", () => {
    reset(); expect(`${vcp(["doctor", "--refresh"], { FAKE_VC_VERSION: "4.7.0", HADES_VERSION_CHECK_REPO: "a/b;rm" }).replace(/\n$/, "")}|${calls()}`).toBe("|0");
  });
});

// GET anônimo (caminho principal do repo público): servidor local em outro processo, porque o rig roda o CLI de forma síncrona.
// O nome do repo escolhe a resposta: ok/ver → 4.7.0, ok/big → corpo grande, ok/junk → não é semver, ok/slow → 5 s; o resto → 404.
const SERVER = `${r.T}/vc-raw-server.ts`;
writeFileSync(SERVER, `const s = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const p = new URL(req.url).pathname;
  if (p === "/ok/ver/HEAD/VERSION") return new Response("4.7.0\\n");
  if (p === "/ok/big/HEAD/VERSION") return new Response("4.7.0\\n" + "x".repeat(1000));
  if (p === "/ok/junk/HEAD/VERSION") return new Response("<html>oi</html>");
  if (p === "/ok/slow/HEAD/VERSION") { await Bun.sleep(5000); return new Response("4.7.0\\n"); }
  return new Response("404: Not Found", { status: 404 });
} });
console.log(s.port);`);

describe("versao-check: GET anônimo (repo público)", () => {
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let base = "";
  beforeAll(async () => {
    server = Bun.spawn([BUN, SERVER], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    base = `http://127.0.0.1:${new TextDecoder().decode(first.value).trim()}`;
  });
  afterAll(() => { server?.kill(); });
  // PATH só com a pasta do gh falso (já sem o gh): nem o gh real da máquina é achado
  const SEM_GH = { PATH: VB };
  const raw = (repo: string, e: Record<string, string> = {}) => vcp(["status", "--refresh", "--json"], { HADES_VERSION_CHECK_RAW_BASE: base, HADES_VERSION_CHECK_REPO: repo, ...e });
  const st = (repo: string, e: Record<string, string> = {}) => JSON.parse(raw(repo, e));

  test("repo público: lê a VERSION sem gh (nem no PATH) e sem login", () => {
    reset(); rmSync(`${VB}/gh`, { force: true });
    const s = st("ok/ver", SEM_GH);
    expect(`${s.access} ${s.remote} ${s.update} ${calls()}`).toBe("true 4.7.0 true 0");
  });
  test("404 e sem gh: oculto, com o motivo do GET no cache (repo privado ou inexistente)", () => {
    reset(); const s = st("ok/privado", SEM_GH);
    expect(`${s.access} ${s.update} ${s.reason}`).toBe("false false repositório não encontrado ou privado (HTTP 404)");
  });
  test("sem rede e sem gh: oculto, motivo de rede", () => {
    reset(); const s = JSON.parse(vcp(["status", "--refresh", "--json"], { HADES_VERSION_CHECK_REPO: "ok/ver", ...SEM_GH }));
    expect(`${s.access} ${s.reason}`).toBe("false sem rede para o GitHub");
  });
  test("404 com gh: cai no gh e usa a versão dele", () => {
    reset(); installGh();
    const s = st("ok/privado", { FAKE_VC_VERSION: "4.8.0" });
    expect(`${s.access} ${s.remote} ${calls()}`).toBe("true 4.8.0 1");
  });
  test("sem rede com gh: cai no gh", () => {
    reset(); const s = JSON.parse(vcp(["status", "--refresh", "--json"], { HADES_VERSION_CHECK_REPO: "ok/ver", FAKE_VC_VERSION: "4.9.0" }));
    expect(`${s.access} ${s.remote} ${calls()}`).toBe("true 4.9.0 1");
  });
  test("resposta grande demais: recusada, sem tentar o gh", () => {
    reset(); const s = st("ok/big", { FAKE_VC_VERSION: "4.9.0" });
    expect(`${s.access} ${s.reason} ${calls()}`).toBe("false VERSION remota fora do formato X.Y.Z 0");
  });
  test("resposta que não é X.Y.Z: recusada, sem tentar o gh", () => {
    reset(); const s = st("ok/junk", { FAKE_VC_VERSION: "4.9.0" });
    expect(`${s.access} ${s.reason} ${calls()}`).toBe("false VERSION remota fora do formato X.Y.Z 0");
  });
  test("servidor lento: timeout calado, sem tentar o gh", () => {
    reset(); const s = st("ok/slow", { HADES_VERSION_CHECK_TIMEOUT: "2", FAKE_VC_VERSION: "4.9.0" });
    expect(`${s.access} ${s.reason} ${calls()}`).toBe("false timeout 0");
  }, 20_000); // o servidor falso dorme 5 s de verdade; o cliente desiste aos 2 s
  test("conta do gh preenchida: só o gh (o GET anônimo não é usado)", () => {
    reset(); const s = st("ok/ver", { HADES_VERSION_CHECK_GH_USER: "dono", FAKE_VC_VERSION: "4.9.0" });
    expect(`${s.remote} ${calls()}`).toBe("4.9.0 2");
  });
  test("o padrão do servidor do GET é o raw do GitHub (config.tsv e código)", () => {
    const row = readFileSync(`${KIT}/config.tsv`, "utf8").split("\n").map((l) => l.split("\t")).find((c) => c[0] === "HADES_VERSION_CHECK_RAW_BASE")?.[1];
    expect(`${row} ${settings({}).rawBase}`).toBe("https://raw.githubusercontent.com https://raw.githubusercontent.com");
  });
});
