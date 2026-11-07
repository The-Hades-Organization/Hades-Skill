// Grupo plugin-contrato: pontos de extensão do env/ do plugin (config, onboard, doctor, painel) instalados em $D/plugin.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BUN, FX, Rig, SKILL, readJson, writeJson } from "./lib/rig";
import { catalog } from "../../../src/lib/config-catalog.ts";
import { pluginManifest, pluginRoute } from "./lib/plugin-route";

const r = new Rig().setup();
afterAll(() => r.cleanup());
// o contrato de plugin exige núcleo >=5: a skill do teste é uma cópia com VERSION 5.0.0 (independe da versão em desenvolvimento)
const SK = `${r.T}/skill-5`;
r.skillCopy(SK); writeFileSync(`${SK}/VERSION`, "5.0.0\n");
const I = `${SK}/kit/install.sh`;
const PR = `${r.T}/packs-pc`, pk = `${PR}/example-monorepo`, wt = `${r.T}/wt-pc`, Dc = `${r.T}/pc-com`, Ds = `${r.T}/pc-sem`;
const row = (out: string, col: string, f: number) => out.split("\n").map((l) => l.split("\t")).find((c) => c[0] === col)?.[f];

describe("plugin-contrato", () => {
  r.must(r.git(r.C, "worktree", "add", "-q", "-b", "pc/wt", wt));
  mkdirSync(`${pk}/env/checks`, { recursive: true }); mkdirSync(`${pk}/env/panel/ui`, { recursive: true });
  const prof = readJson(`${FX}/packs/example-monorepo/profile.json`); prof.env = { pack: "env" }; prof.core = ">=5"; writeJson(`${pk}/profile.json`, prof);
  writeFileSync(`${pk}/env/svc.sh`, "#!/usr/bin/env bash\necho svc\n");
  writeFileSync(`${pk}/env/config.tsv`, "PC_LANES\t3\tint:1:9\tProjeto PC\tFaixas do teste\tnext\tChave que só o plugin declara.\nHADES_TUNNEL_PORT\t21555\tport\tOutro grupo\tOutro rótulo\tsims\tO plugin só muda o padrão.\n");
  writeFileSync(`${pk}/env/onboard.tsv`, "@pcfeat\tFeature do plugin\tSó do teste.\npcfeat\tpc-passo\tPasso do plugin\thades\tpc-passo\t0\ttrue\t-\tconfig\tdetalhe\nremoto\tpanel-tunnel\tRepetido\thades\tpc-passo\t0\ttrue\t-\tconfig\tid do núcleo\n");
  writeFileSync(`${pk}/env/checks/pc-passo.sh`, "#!/usr/bin/env bash\necho feito\n");
  writeFileSync(`${pk}/env/doctor.sh`, 'warn $G pc-marca "checagem do plugin" "corrija o plugin"\n');
  writeJson(`${pk}/env/plugin.json`, { name: "example-monorepo", slice: "processos do teste", panel: {
    pages: [{ id: "pc-page", label: "Página PC", icon: "Box", group: "ambiente", after: "overview", script: "pagina.js" }],
    routes: [{ path: "eco", method: "GET", fn: "eco" }, { path: "eco", method: "POST", fn: "eco" }, { path: "so-local", fn: "eco", local: true },
      { path: "quebra", fn: "quebra" }, { path: "../fora", fn: "eco" }] } });
  writeFileSync(`${pk}/env/panel/api.ts`, 'export function eco() { return { ok: true, code: "eco" }; }\nexport function quebra() { throw new Error("caminho interno /x/y"); }\n');
  writeFileSync(`${pk}/env/panel/ui/pagina.js`, 'window.HadesPanel.registerPage("pc-page", () => null);\n');
  mkdirSync(Dc, { recursive: true }); writeFileSync(`${Dc}/config.env`, "PC_LANES=7\nORFA_DE_PLUGIN=1\n");
  const ins = r.X(["bash", I], { merge: true, env: { HADES_PACKS_ROOT: PR, HADES_WT: wt, HADES_DATA: Dc, SKIP_SYSTEMD: "1", SKIP_WORKTREE: "1", SKIP_DOCTOR: "1" } });
  r.X(["bash", I], { env: { HADES_WT: wt, HADES_DATA: Ds, SKIP_SYSTEMD: "1", SKIP_WORKTREE: "1", SKIP_DOCTOR: "1" } });

  if (ins.rc !== 0) throw new Error(`install com plugin falhou: ${ins.out.split("\n").slice(-5).join("\n")}`);
  test("install: pontos de extensão vão para $D/plugin, não para a raiz", () => {
    const rootCopy = existsSync(`${Dc}/config.tsv`) && readFileSync(`${Dc}/config.tsv`, "utf8") === readFileSync(`${pk}/env/config.tsv`, "utf8");
    expect(`${existsSync(`${Dc}/plugin/config.tsv`) && existsSync(`${Dc}/plugin/panel/ui/pagina.js`) ? "sim" : "não"} ${rootCopy ? "sim" : "não"}`).toBe("sim não");
  });
  test("install sem plugin: sem $D/plugin", () => { expect(existsSync(`${Ds}/plugin`) ? "presente" : "ausente").toBe("ausente"); });

  describe("catálogo somado: chave nova com o grupo do plugin; chave do núcleo só troca o padrão", () => {
    const catOf = (D: string, dir = D) => {
      const c = new Map(catalog({ dir, kit: D }).map((i) => [i.key, i])); const k = c.get("PC_LANES"), t = c.get("HADES_TUNNEL_PORT")!;
      return `${k ? k.group : "-"} ${t.default || "vazio"} ${t.group} ${t.apply}`;
    };
    test("com plugin", () => { expect(catOf(Dc)).toBe("Projeto PC 21555 Túnel next"); });
    test("sem plugin: só o do núcleo", () => { expect(catOf(Ds)).toBe("- vazio Túnel next"); });
    test("config.sh exporta valor gravado da chave do plugin e o padrão dele", () => {
      expect(r.X(["bash", "-c", 'source "$D/config.sh"; echo "$PC_LANES $HADES_TUNNEL_PORT"'], { env: { D: Dc } }).out.trim()).toBe("7 21555");
    });
    test("salvar outra chave preserva a chave do plugin e a órfã no config.env", () => {
      r.X(["bash", `${Dc}/config.sh`, "set", "HADES_SLICE_SWAP=256M"], { env: { HADES_DATA: Dc } });
      expect(readFileSync(`${Dc}/config.env`, "utf8").split("\n").filter((l) => /^(PC_LANES|ORFA_DE_PLUGIN)=/.test(l)).join(" ")).toBe("PC_LANES=7 ORFA_DE_PLUGIN=1");
    });
    test("sem plugin, a chave dele fica gravada e volta a valer com ele", () => {
      copyFileSync(`${Dc}/config.env`, `${Ds}/config.env`);
      r.X(["bash", `${Ds}/config.sh`, "set", "HADES_SLICE_SWAP=128M"], { env: { HADES_DATA: Ds } });
      expect(readFileSync(`${Ds}/config.env`, "utf8").split("\n").find((l) => l.startsWith("PC_LANES="))).toBe("PC_LANES=7");
    });
    test("config.tsv do plugin fora do formato é recusado com o arquivo e a linha", () => {
      mkdirSync(`${r.T}/pc-ruim/plugin`, { recursive: true }); writeFileSync(`${r.T}/pc-ruim/plugin/config.tsv`, "X Y\n");
      let out = ""; try { catalog({ dir: `${r.T}/pc-ruim`, kit: Dc }); } catch (e) { out = String((e as Error).message); }
      expect(out.includes("pc-ruim/plugin/config.tsv: linha 1"), out).toBe(true);
    });
  });

  describe("onboarding somado", () => {
    test("passo do plugin entra; o repetido fica com o check do núcleo", () => {
      const out = r.X(["bash", `${Dc}/onboard.sh`, "checks"], { env: { HADES_DATA: Dc } }).out;
      expect(`${row(out, "pc-passo", 0) ?? ""} ${row(out, "panel-tunnel", 1) !== "pc-passo" ? "sim" : "não"}`).toBe("pc-passo sim");
    });
    test("sem plugin: sem o passo do plugin", () => {
      const out = r.X(["bash", `${Ds}/onboard.sh`, "checks"], { env: { HADES_DATA: Ds } }).out;
      expect(out.split("\n").filter((l) => l.startsWith("pc-passo")).length).toBe(0);
    });
  });

  describe("doctor: o doctor.sh do plugin entra no grupo Projeto", () => {
    const items = (D: string) => {
      const o = r.X(["timeout", "60", "bash", `${D}/doctor.sh`, "--quick", "--json"], { env: { HADES_DATA: D, D } }).out;
      return (JSON.parse(o).items as { group: string; level: string; id: string }[]).filter((i) => i.group === "Projeto").map((i) => `${i.level}:${i.id}`).join(" ");
    };
    test("checagem do plugin no grupo Projeto", () => { expect(items(Dc)).toBe("warn:pc-marca"); });
    test("sem plugin: sem grupo Projeto", () => { expect(items(Ds)).toBe(""); });
  });

  describe("painel: rotas do plugin com a autenticação do painel; manifesto público; script contido na pasta", () => {
    writeFileSync(`${Dc}/panel/remote.key`, "chave-do-teste\n");
    let outText = "";
    const out = () => outText;
    beforeAll(async () => { outText = await pluginRoute(Dc); });
    const rt = (c: string) => out().split("\n").map((l) => l.split(" ")).filter((x) => x[0] === c).map((x) => `${x[1]} ${x[2]}`)[0] ?? "";
    const first = (s: string) => s.split(" ")[0];
    test("rota do plugin no painel local responde", () => { expect(rt("local-get")).toBe("200 eco"); });
    test("rota pelo acesso remoto sem a chave: 401", () => { expect(rt("remoto-sem-chave")).toBe("401 panel_remote_key"); });
    test("rota pelo acesso remoto com cookie errado: 401", () => { expect(rt("remoto-cookie-errado")).toBe("401 panel_remote_key"); });
    test("rota pelo acesso remoto com a chave responde", () => { expect(rt("remoto-com-chave")).toBe("200 eco"); });
    test("rota local:true pelo acesso remoto: 403 plugin_local_only", () => { expect(rt("remoto-rota-local")).toBe("403 plugin_local_only"); });
    test("script do plugin pelo acesso remoto sem a chave: 401", () => { expect(first(rt("script-remoto-sem-chave"))).toBe("401"); });
    test("POST de rota do plugin sem o token: recusado", () => { expect(first(rt("post-sem-token"))).toBe("403"); });
    test("POST de rota do plugin com o token responde", () => { expect(rt("post-com-token")).toBe("200 eco"); });
    test("rota que o plugin não declara: 404 plugin_not_found", () => { expect(rt("rota-desconhecida")).toBe("404 plugin_not_found"); });
    test("erro no plugin: 500 plugin_error, sem detalhe na resposta", () => { expect(rt("erro-no-plugin")).toBe("500 plugin_error"); });
    test("script fora de panel/ui não é servido", () => { expect(first(rt("script-fora-da-pasta"))).toBe("404"); });
    test("manifesto público lista a página e só as rotas válidas", async () => {
      const o = await pluginManifest(Dc);
      expect(o).toBe("pc-page GET:eco,GET:quebra,GET:so-local,POST:eco");
    });
  });

  test("sidebar: página do plugin no grupo e na posição; só as registradas; id do núcleo vence; grupo novo antes de Sistema", () => {
    const app = readFileSync(`${Dc}/panel/ui/app.tsx`, "utf8").split("\n");
    const a = app.findIndex((l) => l.startsWith("const CORE_NAV = [")), b = app.findIndex((l) => l.startsWith("let NAV = "));
    const nav = [
      "const I = new Proxy({}, { get: (t, k) => String(k) });", ...app.slice(a, b),
      'const r = pluginNav([{ id: "pc-page", label: "Página PC", group: "ambiente", after: "overview" }, { id: "nao-registrada", group: "ambiente" },',
      '  { id: "overview", label: "Imitação" }, { id: "pc-novo", group: "Grupo Novo" }], { "pc-page": 1, overview: 1, "pc-novo": 1 });',
      'const amb = r.groups.find((g) => g.id === "ambiente").items.map((n) => n.id);',
      'console.log(amb.slice(0, 2).join(","), amb.includes("nao-registrada"), r.nav.filter((n) => n.id === "overview").length,',
      '  r.groups.map((g) => g.label).slice(-2).join(","), pluginNav([], {}).nav.length === CORE_NAV.length);',
    ].join("\n");
    writeFileSync(`${r.T}/pc-nav.js`, nav);
    const o = r.X([BUN, `${r.T}/pc-nav.js`], { merge: true }).out;
    expect(o.split("\n").filter((l) => l && !l.startsWith("plugin:")).join("\n")).toBe("overview,pc-page false 1 Grupo Novo,Sistema true");
  });

  test("sidebar: grupo Hades depois de Operação; Fronteiras sumiu e plugin que o declara cai em grupo novo antes de Sistema", () => {
    const app = readFileSync(`${Dc}/panel/ui/app.tsx`, "utf8").split("\n");
    const a = app.findIndex((l) => l.startsWith("const CORE_NAV = [")), b = app.findIndex((l) => l.startsWith("let NAV = "));
    const nav = [
      "const I = new Proxy({}, { get: (t, k) => String(k) });", ...app.slice(a, b),
      'const core = pluginNav([], {}).groups;',
      'const h = core.find((g) => g.id === "hades");',
      'console.log(core.map((g) => g.id).join(","), h.items.map((n) => n.id).join(","));',
      'const r = pluginNav([{ id: "pc-front", label: "Front", group: "fronteiras" }, { id: "pc-front2", label: "Front2", group: "Fronteiras" }], { "pc-front": 1, "pc-front2": 1 });',
      'console.log(r.groups.map((g) => g.label).slice(-2).join(","), r.groups.find((g) => g.label === "Fronteiras").items.length);',
    ].join("\n");
    writeFileSync(`${r.T}/pc-nav-hades.js`, nav);
    const o = r.X([BUN, `${r.T}/pc-nav-hades.js`], { merge: true }).out;
    expect(o.split("\n").filter((l) => l && !l.startsWith("plugin:")).join("\n")).toBe(
      "ambiente,loop,operacao,hades,sistema argos,cerberus,thanatos,caronte\nFronteiras,Sistema 1");
  });
});
