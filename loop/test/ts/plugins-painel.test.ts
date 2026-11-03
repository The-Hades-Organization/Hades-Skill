// Grupo plugins-painel: página Plugins e plugins.sh — prévia, recusas, desligar, remover. Sem rede: o insteadOf troca a URL https de
// teste por um repositório local.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from "node:fs";
import { FX, Rig, SKILL, kv, readJson, writeJson } from "./lib/rig";
import { pluginsRoute } from "./lib/plugins-route";

const r = new Rig().setup();
afterAll(() => r.cleanup());
// o contrato de plugin exige núcleo >=5: a skill do teste é uma cópia com VERSION 5.0.0 (independe da versão em desenvolvimento)
const SK = `${r.T}/skill-5`;
r.skillCopy(SK); writeFileSync(`${SK}/VERSION`, "5.0.0\n");
const I = `${SK}/kit/install.sh`;
const PR = `${r.T}/pp-packs`, RM = `${r.T}/pp-remotes`, wt = `${r.T}/wt-pp`, Dp = `${r.T}/pp-data`, GC = `${r.T}/pp-gitconfig`, BASE = "https://plugins.example.invalid";
const ppEnv = () => kv({ GIT_CONFIG_GLOBAL: GC, HADES_PACKS_ROOT: PR, HADES_WT: wt, HADES_DATA: Dp, HADES_SKILL_DIR: SK, SKIP_SYSTEMD: "1", SKIP_WORKTREE: "1", SKIP_DOCTOR: "1" });
const XP = (argv: string[], extra: Record<string, string> = {}) => r.X(argv, { env: { ...ppEnv(), ...extra } });
// sem SKIP_WORKTREE no plugins.sh: o install.sh só roda o post-install.sh do plugin com ele (a prova de "nada roda antes da confirmação")
const P = (...a: string[]) => { const e = ppEnv(); delete e.SKIP_WORKTREE; return r.X(["bash", `${Dp}/plugins.sh`, ...a], { env: e }).out; };
const pj = (...a: string[]) => JSON.parse(P(...a, "--json")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const sim = (b: boolean) => (b ? "sim" : "não");
const ent = (d: string) => (existsSync(d) ? readdirSync(d).length : 0);
const git = (d: string, ...a: string[]) => r.git(d, ...a);

function pkrepo(slug: string, edit: (p: Record<string, any>) => void, apiPy = false): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  const src = `${r.T}/pp-src/${slug}`;
  mkdirSync(`${src}/env/panel/ui`, { recursive: true }); mkdirSync(`${src}/env/checks`, { recursive: true });
  r.must(r.X(["git", "init", "-q", "--bare", "-b", "main", `${RM}/${slug}.git`])); r.must(r.X(["git", "init", "-q", "-b", "main", src]));
  const prof = readJson(`${FX}/packs/example-monorepo/profile.json`); edit(prof); writeJson(`${src}/profile.json`, prof);
  writeFileSync(`${src}/env/post-install.sh`, '#!/usr/bin/env bash\ntouch "$HADES_DATA/pp-post-install.ran"\n');
  writeFileSync(`${src}/env/pp-svc.sh`, "#!/usr/bin/env bash\necho svc\n");
  writeFileSync(`${src}/env/config.tsv`, "PP_LANES\t3\tint:1:9\tProjeto PP\tFaixas do teste\tnext\tChave que só o plugin declara.\n");
  writeFileSync(`${src}/env/panel/api.ts`, "export function eco() { return { ok: true }; }\n");
  if (apiPy) writeFileSync(`${src}/env/panel/api.py`, "def eco(ctx, dados):\n    return dict(ok=True)\n");
  writeFileSync(`${src}/env/panel/ui/pp.js`, 'window.HadesPanel.registerPage("pp", () => null);\n');
  writeJson(`${src}/env/plugin.json`, { name: "pp", panel: { pages: [{ id: "pp", label: "Página PP", script: "pp.js" }], routes: [{ path: "eco", fn: "eco" }] } });
  r.must(git(src, "add", "-A")); r.must(git(src, "commit", "-qm", "v1")); r.must(git(src, "push", "-q", `${RM}/${slug}.git`, "main"));
}

describe("plugins-painel", () => {
  writeFileSync(GC, `[url "${RM}/"]\n\tinsteadOf = ${BASE}/\n`);
  r.must(git(r.C, "worktree", "add", "-q", "-b", "pp/wt", wt));
  mkdirSync(PR, { recursive: true });
  pkrepo("acme/pp", (p) => { p.env = { pack: "env" }; p.core = ">=5"; });
  pkrepo("acme/outro", (p) => { p.name = "outro"; p.identity.repo = "acme/outro"; p.env = { pack: "env" }; p.core = ">=5"; });
  pkrepo("acme/fora", (p) => { p.name = "fora"; p.identity.repo = "acme/fora"; p.core = "<1"; });
  pkrepo("acme/ruim", (p) => { p.name = "ruim"; p.identity.repo = "acme/ruim"; delete p.flow; });
  pkrepo("acme/legado", (p) => { p.name = "legado"; p.identity.repo = "acme/legado"; p.env = { pack: "env" }; p.core = ">=5"; }, true);
  pkrepo("acme/core4", (p) => { p.name = "core4"; p.identity.repo = "acme/core4"; p.env = { pack: "env" }; p.core = ">=4.0"; });
  const ins = XP(["bash", I]);
  if (ins.rc !== 0) throw new Error(`install falhou: ${ins.all.split("\n").slice(-5).join("\n")}`);
  let id = "", c = "", t = "";

  test("listar sem pacote: ok e lista vazia", () => { const o = pj("list"); expect(`${o.ok} ${o.packs.length}`).toBe("true 0"); });
  test("URL com credencial é recusada", () => { expect(pj("add", "https://u:tok@plugins.example.invalid/acme/pp.git").code).toBe("url_credentials"); });
  test("URL fora de https:// e git@ é recusada", () => { expect(pj("add", `file://${RM}/acme/pp.git`).code).toBe("invalid_url"); });
  test("pacote inválido é recusado e não fica na prévia", () => {
    expect(`${pj("add", `${BASE}/acme/ruim.git`).code} ${ent(`${Dp}/plugins-staging`)}`).toBe("invalid_pack 0");
  });
  test("pacote fora da faixa core é recusado", () => { expect(pj("add", `${BASE}/acme/fora.git`).code).toBe("core_out_of_range"); });
  test("pacote com panel/api.py é recusado (legacy_api_py): o contrato atual só lê api.ts", () => { expect(pj("add", `${BASE}/acme/legado.git`).code).toBe("legacy_api_py"); });
  test("pacote cujo core aceita <5 é recusado (core_out_of_range)", () => { expect(pj("add", `${BASE}/acme/core4.git`).code).toBe("core_out_of_range"); });

  describe("prévia: nada do pacote roda nem entra na pasta de pacotes antes da confirmação com o commit mostrado", () => {
    test("prévia mostra o commit, o que executa e o que acrescenta", () => {
      const o = pj("add", `${BASE}/acme/pp.git`); id = o.id; c = o.commit;
      const head = git(`${r.T}/pp-src/acme/pp`, "rev-parse", "HEAD").out.trim();
      expect(`${o.ok} ${o.commit} ${(o.runs as { path: string }[]).map((x) => x.path).sort().join(",")} ${o.adds.keys[0].key} ${o.activates}`)
        .toBe(`true ${head} env/panel/api.ts,env/panel/ui/pp.js,env/post-install.sh PP_LANES true`);
    });
    test("prévia: nada instalado nem executado ainda", () => {
      expect(`${ent(PR)} ${sim(existsSync(`${Dp}/plugin`))} ${sim(existsSync(`${Dp}/pp-post-install.ran`))}`).toBe("0 não não");
    });
    test("confirmar outro commit é recusado", () => { expect(pj("add", "--apply", id, "--commit", "0".repeat(40)).code).toBe("commit_mismatch"); });
    test("prévia inexistente é recusada", () => { expect(pj("add", "--apply", "a".repeat(16), "--commit", c).code).toBe("preview_expired"); });
    test("confirmado: pacote na pasta, plugin no $D, post-install rodou", () => {
      P("add", "--apply", id, "--commit", c, "--json");
      expect([existsSync(`${PR}/example-monorepo/profile.json`), existsSync(`${Dp}/plugin/plugin.json`), existsSync(`${Dp}/pp-post-install.ran`)].map(sim).join(" ")).toBe("sim sim sim");
    });
    test("listar com pacote: ativo, core ok, url sem reescrita", () => {
      const p = pj("list").packs[0]; expect(`${p.state} ${p.core.state} ${p.url} ${p.branch}`).toBe(`ativo ok ${BASE}/acme/pp.git main`);
    });
    test("o mesmo pacote de novo é recusado", () => { expect(pj("add", `${BASE}/acme/pp.git`).code).toBe("already_installed"); });
  });

  describe("desligar: sai do $D o que o env/ pôs; a chave gravada fica; reinstalar não religa; religar devolve tudo", () => {
    test("desligar tira o $D/plugin e o script do env/, e mantém pacote e chave", () => {
      appendFileSync(`${Dp}/config.env`, "PP_LANES=7\n"); P("disable", "example-monorepo", "--json");
      const key = readFileSync(`${Dp}/config.env`, "utf8").split("\n").find((l) => l.startsWith("PP_LANES="));
      expect(`${sim(existsSync(`${Dp}/plugin`))} ${sim(existsSync(`${Dp}/pp-svc.sh`))} ${sim(existsSync(`${PR}/example-monorepo/profile.json`))} ${key}`).toBe("não não sim PP_LANES=7");
    });
    test("install.sh mantém o plugin desligado", () => {
      const out = XP(["bash", I], { }).all.split("\n").filter((l) => l.startsWith("kit instalado")).join("\n");
      expect(`${sim(existsSync(`${Dp}/plugin`))} ${sim(out.includes("example-monorepo desligado"))}`).toBe("não sim");
    });
    test("listar mostra desligado", () => { expect(pj("list").packs[0].state).toBe("desligado"); });
    test("religar: plugin de volta e a chave gravada volta a valer", () => {
      P("enable", "example-monorepo", "--json");
      const v = r.X(["bash", "-c", 'source "$D/config.sh"; echo "${PP_LANES:-}"'], { env: { D: Dp } }).out.trim();
      expect(`${sim(existsSync(`${Dp}/plugin/plugin.json`))} ${v}`).toBe("sim 7");
    });
  });

  describe("atualizar: prévia do que muda no que executa; aplica só o commit da prévia", () => {
    test("prévia de atualizar: 1 commit, muda o que executa, diff do post-install", () => {
      const src = `${r.T}/pp-src/acme/pp`;
      appendFileSync(`${src}/env/post-install.sh`, "echo v2\n");
      r.must(git(src, "commit", "-qam", "v2")); r.must(git(src, "push", "-q", `${RM}/acme/pp.git`, "main"));
      const o = pj("update", "example-monorepo"); t = o.target;
      expect(`${o.commits.length} ${o.runsChanged} ${sim((o.diff as string).includes("+echo v2"))}`).toBe("1 true sim");
    });
    test("atualizar com outro commit é recusado", () => { expect(pj("update", "example-monorepo", "--apply", "--commit", c).code).toBe("commit_mismatch"); });
    test("atualizado para o commit da prévia", () => {
      P("update", "example-monorepo", "--apply", "--commit", t, "--json");
      expect(git(`${PR}/example-monorepo`, "rev-parse", "HEAD").out.trim()).toBe(t);
    });
  });

  describe("outro projeto: dá para guardar, não para ligar aqui", () => {
    test("pacote de outro projeto: a prévia diz que não ativa", () => {
      const o = pj("add", `${BASE}/acme/outro.git`); id = o.id; c = o.commit; expect(o.activates).toBe(false);
    });
    test("pacote de outro projeto não liga nem desliga aqui", () => {
      P("add", "--apply", id, "--commit", c, "--json");
      const st = (pj("list").packs as { name: string; state: string }[]).find((p) => p.name === "outro")?.state;
      expect(`${st} ${pj("disable", "outro").code}`).toBe("outro-projeto other_project");
    });
  });

  describe("painel: leitura também pelo acesso remoto; o que muda só no painel local e com o token", () => {
    writeFileSync(`${Dp}/panel/remote.key`, "chave-do-teste\n");
    let outText = "";
    const out = () => outText;
    beforeAll(async () => { outText = await pluginsRoute(r, Dp, `${BASE}/acme/fora.git`, "example-monorepo", ppEnv()); });
    const rt = (k: string) => out().split("\n").filter((l) => l.startsWith(`${k} `)).map((l) => l.slice(k.length + 1))[0] ?? "";
    const cases: [string, string, () => string][] = [
      ["GET /api/plugins no painel local", "200 ok false", () => `${rt("lista-local")} ${rt("lista-local-remote")}`],
      ["GET /api/plugins pelo acesso remoto: só leitura", "200 ok true", () => `${rt("lista-remota")} ${rt("lista-remota-remote")}`],
      ["desligar pelo acesso remoto: 403 plugins_local_only", "403 plugins_local_only", () => rt("remoto-desligar")],
      ["prévia pelo acesso remoto: 403 plugins_local_only", "403 plugins_local_only", () => rt("remoto-previa")],
      ["POST sem o token: 403", "403 token", () => rt("sem-token")],
      ["operação fora da lista: 400 plugins_bad_request", "400 plugins_bad_request", () => rt("op-desconhecida")],
      ["nome fora do padrão: 400 plugins_bad_request", "400 plugins_bad_request", () => rt("nome-invalido")],
      ["commit fora do padrão: 400 plugins_bad_request", "400 plugins_bad_request", () => rt("sha-invalido")],
      ["URL com credencial pela página: recusada com o código", "200 url_credentials", () => rt("url-credencial")],
      ["URL longa demais: 400 invalid_url", "400 invalid_url", () => rt("url-longa")],
      ["confirmar prévia inexistente: 400 preview_expired", "400 preview_expired", () => rt("previa-expirada")],
      ["remover com o nome errado: 400 name_mismatch", "400 name_mismatch", () => rt("remover-nome-errado")],
      ["prévia pela página devolve a recusa do pacote", "200 core_out_of_range", () => rt("previa-local")],
      ["desligar no painel local: conferido e lançado como execução", "200 ok disable example-monorepo 1", () => `${rt("desligar-local")} ${rt("job-desligar")} ${rt("lancados")}`],
    ];
    for (const [nome, esperado, got] of cases) test(nome, () => { expect(got()).toBe(esperado); });
  });

  describe("remover: recusa commit não publicado e mudança local; com tudo publicado, desliga e apaga", () => {
    const pk = `${PR}/example-monorepo`;
    test("remover com commit não publicado é recusado", () => {
      r.must(git(pk, "commit", "-q", "--allow-empty", "-m", "local"));
      expect(pj("remove", "example-monorepo", "--confirm", "example-monorepo").code).toBe("unpublished_commits");
    });
    test("remover com mudança local é recusado", () => {
      r.must(git(pk, "reset", "-q", "--hard", "HEAD~1")); appendFileSync(`${pk}/profile.json`, "x\n");
      expect(pj("remove", "example-monorepo", "--confirm", "example-monorepo").code).toBe("local_changes");
    });
    test("remover com o nome errado é recusado", () => {
      r.must(git(pk, "checkout", "-q", "--", "profile.json"));
      expect(pj("remove", "example-monorepo", "--confirm", "outro").code).toBe("name_mismatch");
    });
    test("removido: pacote apagado, $D sem plugin, sem estado de desligado", () => {
      P("remove", "example-monorepo", "--confirm", "example-monorepo", "--json");
      const dis = existsSync(`${Dp}/plugins.disabled`) && readFileSync(`${Dp}/plugins.disabled`, "utf8").split("\n").includes("example-monorepo");
      expect(`${sim(existsSync(pk))} ${sim(existsSync(`${Dp}/plugin`))} ${sim(dis)}`).toBe("não não não");
    });
    test("auditoria: cada operação com origem", () => {
      const ops = readFileSync(`${Dp}/logs/plugins.log`, "utf8").split("\n").map((l) => l.split(/\s+/)).filter((f) => f[2] === "plugin=example-monorepo")
        .map((f) => (f[1] ?? "").replace("op=", "")).filter((o) => !/^(update-preview|remove-disable)$/.test(o));
      expect([...new Set(ops)].join(" ")).toBe("add-preview add disable enable update remove");
    });
  });
});
