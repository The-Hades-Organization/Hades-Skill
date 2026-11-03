// Grupo multi-instancia: várias instâncias na mesma máquina (HADES_ID, registro, porta, túneis, painel, base do perfil).
// A comparação com o original saiu na 5.0.0; o que ele produzia está em golden/legado (multi-instancia-cli.test.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { BUN, FX, Rig, SKILL, STUBS, readJson, writeJson } from "./lib/rig";
import { mi } from "./lib/mi";
import { healthPaths } from "../../../src/lib/config";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const I = `${SKILL}/kit/install.sh`, HI = [BUN, `${SKILL}/src/cli.ts`, "instance"];
const { PR, MH, BB, SC, MI } = mi(r);
const D1 = `${r.T}/mi-d1`, D2 = `${r.T}/mi-d2`, D3 = `${r.T}/mi-d3`, wt1 = `${r.T}/wt-mi1`, wt2 = `${r.T}/wt-mi2`, wt3 = `${r.T}/wt-mi3`, REG = `${MH}/.claude/hades`;
const rd = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const nl = (s: string) => s.replace(/\n$/, "");
const cnt = (text: string, re: RegExp) => text.split("\n").filter((l) => re.test(l)).length;
const grep1 = (p: string, re: RegExp) => rd(p).split("\n").find((l) => re.test(l)) ?? "";
const inst = (wt: string, D: string, extra: Record<string, string> = {}, o: { cwd?: string; noSystemd?: boolean } = {}) =>
  MI(["bash", I], { HADES_WT: wt, HADES_DATA: D, ...extra }, { ...o, merge: true });
const sim = (b: boolean) => (b ? "sim" : "não");

describe("multi-instancia", () => {
  // HOME próprio (o registro de instâncias dos outros grupos não entra)
  for (const d of [`${PR}/example-monorepo`, `${PR}/other-plain`, `${MH}/.claude/skills`, BB, SC]) mkdirSync(d, { recursive: true });
  symlinkSync(SKILL, `${MH}/.claude/skills/hades`);
  symlinkSync(Bun.which("node") ?? "/usr/bin/node", `${BB}/node`); symlinkSync(`${STUBS}/systemctl`, `${BB}/systemctl`);
  writeFileSync(`${BB}/systemd-run`, '#!/usr/bin/env bash\necho "$*" >> "$FAKE_SC_LOG"\n');
  writeFileSync(`${BB}/journalctl`, '#!/usr/bin/env bash\necho "$FAKE_JOURNAL_URL"\n');
  writeFileSync(`${BB}/devtunnel`, '#!/usr/bin/env bash\necho "$*" >> "$FAKE_DT_LOG"\ncase $1 in list) cat "$FAKE_DT_LOG.names" 2>/dev/null ;; create) echo "$2.reg 0 0" >> "$FAKE_DT_LOG.names" ;; user) echo "Logged in as regressao" ;; show) for p in 3000 21220 21221 21222 21223; do echo "https://rnd$p-$p.brs.devtunnels.ms"; done ;; esac\nexit 0\n');
  for (const f of ["systemd-run", "journalctl", "devtunnel"]) chmodSync(`${BB}/${f}`, 0o755);
  copyFileSync(`${FX}/packs/example-monorepo/profile.json`, `${PR}/example-monorepo/profile.json`);
  const op = readJson(`${FX}/packs/example-monorepo/profile.json`); op.name = "other-plain"; op.identity.repo = "other/plain"; op.flow.base = "main"; delete op.branch.base;
  writeJson(`${PR}/other-plain/profile.json`, op);
  r.must(r.git(r.C, "worktree", "add", "-q", "-b", "mi/wt1", wt1)); r.must(r.git(r.C, "worktree", "add", "-q", "-b", "mi/wt3", wt3)); r.must(r.git(r.P, "worktree", "add", "-q", "-b", "mi/wt2", wt2));

  describe("nomes derivados (config.sh): sem env.sh, HADES_ID vazio e com id", () => {
    const CF = `${r.T}/mi-cfg`; mkdirSync(CF, { recursive: true });
    for (const f of ["config.sh", "config.tsv"]) copyFileSync(`${SKILL}/kit/${f}`, `${CF}/${f}`);
    const nmSh = (extra: Record<string, string> = {}) => nl(MI(["bash", "-c", 'source "$D/config.sh"; echo "$HU $HSLICE $HPROJ"'], { D: CF, ...extra }).out);
    test("config.sh sem env.sh: nomes de sempre", () => { expect(nmSh()).toBe("hds hades hades"); });
    test("config.sh com HADES_ID vazio: nomes de sempre", () => {
      writeFileSync(`${CF}/env.sh`, 'HADES_ID=""\n'); expect(`${nmSh()}`).toBe("hds hades hades");
    });
    test("config.sh com HADES_ID=projb: hds_projb, hades_projb (sem hífen no slice)", () => {
      writeFileSync(`${CF}/env.sh`, 'HADES_ID="projb"   # comentário\n');
      expect(`${nmSh()}`).toBe("hds_projb hades_projb hades_projb");
    });
    test("HADES_ID do ambiente vence a linha do env.sh (o env.sh o define antes do config.sh)", () => { expect(nmSh({ HADES_ID: "x" })).toBe("hds_x hades_x hades_x"); });
  });

  describe("instâncias e registro", () => {
    test("primeira instalação: sai 0, HADES_ID=\"\" no env.sh, sem porta escolhida", () => {
      const o = inst(wt1, D1);
      expect(`${o.rc} ${cnt(rd(`${D1}/env.sh`), /^HADES_ID=""/)} ${cnt(rd(`${D1}/config.env`), /^HADES_PANEL_PORT=/)}`, o.out).toBe("0 1 0");
    });
    test("primeira instalação: instance e instances/example-monorepo apontam para ela", () => {
      expect(`${nl(rd(`${REG}/instance`))} ${nl(rd(`${REG}/instances/example-monorepo`))}`).toBe(`${D1} ${D1}`);
    });
    let out = "";
    test("segunda instância (outro projeto, HADES_ID=projb): não toca a instance", () => {
      const o = inst(wt2, D2, { HADES_ID: "projb", HADES_INSTALL_BUSY_PORTS: "21221" }); out = o.out;
      expect(`${o.rc} ${cnt(rd(`${D2}/env.sh`), /^HADES_ID="projb"/)} ${nl(rd(`${REG}/instance`))} ${nl(rd(`${REG}/instances/other-plain`))}`).toBe(`0 1 ${D1} ${D2}`);
    });
    test("segunda instância: porta 21222 (pula a da primeira e a que escuta) e o resumo com os nomes", () => {
      expect(`${grep1(`${D2}/config.env`, /^HADES_PANEL_PORT=/)} ${cnt(out, /^instância projb: units hds_projb-\*, slice hades_projb, projeto compose hades_projb, painel :21222/)}`).toBe("HADES_PANEL_PORT=21222 1");
    });
    test("reinstalar com outro HADES_ID: recusa e o env.sh fica", () => {
      const o = inst(wt2, D2, { HADES_ID: "outro" });
      expect(`${o.rc} ${cnt(o.out, /diverge do/)} ${cnt(rd(`${D2}/env.sh`), /^HADES_ID="projb"/)}`).toBe("1 1 1");
    });
    test("reinstalar sem HADES_ID: mantém o do env.sh e a porta", () => {
      const o = inst(wt2, D2);
      expect(`${o.rc} ${cnt(rd(`${D2}/env.sh`), /^HADES_ID="projb"/)} ${grep1(`${D2}/config.env`, /^HADES_PANEL_PORT=/)}`).toBe("0 1 HADES_PANEL_PORT=21222");
    });
    test("HADES_ID já usado por outra instância (com systemd): recusa antes de criar o $D", () => {
      const o = inst(wt3, `${r.T}/mi-d4`, { HADES_ID: "projb" }, { noSystemd: true });
      expect(`${o.rc} ${cnt(o.out, /já é da instância/)} ${existsSync(`${r.T}/mi-d4`) ? "presente" : "ausente"}`).toBe("1 1 ausente");
    });
    test("mesmo projeto sem HADES_ID: id derivado do pacote, porta 21221, instances/example-monorepo fica na primeira", () => {
      const o = inst(wt3, D3);
      expect(`${o.rc} ${cnt(rd(`${D3}/env.sh`), /^HADES_ID="example_monorepo"/)} ${grep1(`${D3}/config.env`, /^HADES_PANEL_PORT=/)} ${nl(rd(`${REG}/instances/example-monorepo`))} ${cnt(o.out, /^registro instances\/example-monorepo mantido/)}`)
        .toBe(`0 1 HADES_PANEL_PORT=21221 ${D1} 1`);
    });
    test("env.sh antigo: ganha HADES_ID=\"\" antes do source do config.sh e segue a instância padrão", () => {
      writeFileSync(`${D1}/env.sh`, rd(`${D1}/env.sh`).split("\n").filter((l) => !l.startsWith("HADES_ID=")).join("\n"));
      const o = inst(wt1, D1), L = rd(`${D1}/env.sh`).split("\n");
      const at = L.findIndex((l) => l.startsWith("HADES_ID=")), src = L.findIndex((l) => l.includes('source "$D/config.sh"'));
      expect(`${o.rc} ${cnt(rd(`${D1}/env.sh`), /^HADES_ID=""/)} ${sim(at < src)} ${nl(rd(`${REG}/instance`))}`).toBe(`0 1 sim ${D1}`);
    });
  });

  describe("hades-instance.sh: o $D do projeto do diretório, a padrão fora de projeto registrado, e a lista", () => {
    test("projeto da segunda, projeto da primeira, fora de repo (padrão)", () => {
      const q = (d: string) => nl(MI([...HI, "--dir", d]).out);
      expect(`${q(wt2)} ${q(wt1)} ${q(`${r.T}/nogit`)}`).toBe(`${D2} ${D1} ${D1}`);
    });
    test("list: projeto, $D e HADES_ID", () => {
      expect(MI([...HI, "list"]).out.replaceAll("\t", "|").replaceAll("\n", ";")).toBe(`example-monorepo|${D1}|;other-plain|${D2}|projb;`);
    });
  });

  describe("units, slice e túneis: a original com os nomes de sempre, a projb com os dela", () => {
    test("publish-cmds: unit e slice do túnel do front", () => {
      writeFileSync(`${D1}/tunnel.id`, "tid\n"); writeFileSync(`${D2}/tunnel.id`, "tid\n");
      const last = (D: string) => nl(MI(["bash", `${D}/tunnel.sh`, "publish-cmds"], { HADES_TUNNEL_PORT: "3000" }).out).split("\n").pop();
      expect(`${last(D1)}|${last(D2)}`).toBe("! systemd-run --user --unit=hds-devtunnel --slice=hades devtunnel host tid|! systemd-run --user --unit=hds_projb-devtunnel --slice=hades_projb devtunnel host tid");
    });
    test("devtunnel: hades e hades-panel na original, hades-projb e hades-panel-projb na outra", () => {
      writeFileSync(`${r.T}/mi-devtunnel.log`, ""); Bun.spawnSync(["rm", "-f", `${r.T}/mi-devtunnel.log.names`]);
      MI(["bash", `${D1}/tunnel.sh`, "create"], { HADES_TUNNEL_PORT: "3000" }); MI(["bash", `${D2}/tunnel.sh`, "create"], { HADES_TUNNEL_PORT: "3000" });
      MI(["bash", `${D1}/tunnel.sh`, "panel-start"], { FAKE_JOURNAL_URL: "https://a-21220.x.devtunnels.ms" });
      MI(["bash", `${D2}/tunnel.sh`, "panel-start"], { FAKE_JOURNAL_URL: "https://a-21222.x.devtunnels.ms" });
      expect(rd(`${r.T}/mi-devtunnel.log`).split("\n").map((l) => l.split(" ")).filter((f) => f[0] === "create").map((f) => f[1]).join(" ")).toBe("hades hades-projb hades-panel hades-panel-projb");
    });
    test("túnel do painel: unit hds-panel-tunnel e hds_projb-panel-tunnel", () => {
      expect([...rd(`${r.T}/mi-systemd-run.log`).matchAll(/--unit=[^ \n]*/g)].map((m) => m[0]).join(" ")).toBe("--unit=hds-panel-tunnel --unit=hds_projb-panel-tunnel");
    });
    test("units do painel e slices: hds-panel/hades.slice e hds_projb-panel/hades_projb.slice, HADES_ID no Environment", () => {
      MI(["bash", `${D1}/panel.sh`, "autostart"]); MI(["bash", `${D2}/panel.sh`, "autostart"]);
      MI(["bash", `${D1}/config.sh`, "apply-slice"], {}, { noSystemd: true }); MI(["bash", `${D2}/config.sh`, "apply-slice"], {}, { noSystemd: true });
      const UD = `${MH}/.config/systemd/user`;
      const files = ["hds-panel.service", "hds_projb-panel.service", "hades.slice", "hades_projb.slice"].map((f) => sim(existsSync(`${UD}/${f}`))).join(" ");
      expect(`${files} ${cnt(rd(`${UD}/hds-panel.service`), /"HADES_ID="/)} ${cnt(rd(`${UD}/hds_projb-panel.service`), /"HADES_ID=projb"/)}`).toBe("sim sim sim sim 1 1");
    });
  });

  describe("painel: prefixo, slice, projeto compose, cookie e unit aceita nos logs; base do perfil", () => {
    const srv = (D: string) => nl(MI(["timeout", "60", BUN, `${import.meta.dir}/lib/panel-env.ts`, D], { HADES_DATA: D }).out).split("\n")[0];
    test("painel da original: nomes de sempre e base origin/develop", () => { expect(srv(D1)).toBe("hds hades hades hds_panel hds-pjob hds-chat true false origin/develop"); });
    test("painel da projb: nomes dela, logs só das units dela e base origin/main (flow.base)", () => {
      expect(srv(D2)).toBe("hds_projb hades_projb hades_projb hds_projb_panel hds_projb-pjob hds_projb-chat false true origin/main");
    });
  });

  test("doctor: padrão ok, registrada em instances/ ok, sem registro avisa", () => {
    const lv = (D: string) => ((JSON.parse(MI(["timeout", "60", "bash", `${D}/doctor.sh`, "--quick", "--json"], { USER: "regressao", HADES_DATA: D }).out).items as { id: string; level: string }[]).find((i) => i.id === "instance")?.level ?? "");
    expect(`${lv(D1)} ${lv(D2)} ${lv(D3)}`).toBe("ok ok warn");
  });

  describe("saúde por serviço (plugin.json → panel.health) e as checagens do doctor que são do projeto", () => {
    test("panel.health: só as entradas válidas; sem plugin, nada (fica /health/ready)", () => {
      mkdirSync(`${D2}/plugin`, { recursive: true });
      writeFileSync(`${D2}/plugin/plugin.json`, '{"panel": {"health": {"web": "/", "api": "/health/ready", "ruim": "sem-barra", "x y": "/"}}}\n');
      expect(JSON.stringify([healthPaths(D2), healthPaths(D1)])).toBe(JSON.stringify([{ web: "/", api: "/health/ready" }, {}]));
    });
    test("o painel lê o panel.health do plugin", () => {
      const o = MI(["timeout", "60", BUN, `${import.meta.dir}/lib/panel-env.ts`, D2], { HADES_DATA: D2 }).out;
      expect(nl(o).split("\n").pop()).toBe(JSON.stringify({ web: "/", api: "/health/ready" }));
    });
    test("doctor: rede e node_modules com o padrão; sem checagem com HADES_DOCTOR_SUBNET e HADES_DOCTOR_NODE_BINS vazios", () => {
      const ids = (extra: Record<string, string>) => (JSON.parse(MI(["timeout", "60", "bash", `${D1}/doctor.sh`, "--quick", "--json"], { USER: "regressao", HADES_DATA: D1, ...extra }).out).items as { id: string }[])
        .map((i) => i.id).filter((i) => i === "rede" || i === "node_modules").sort().join(" ");
      expect(`${ids({})}|${ids({ HADES_DOCTOR_SUBNET: "", HADES_DOCTOR_NODE_BINS: "" })}`).toBe("node_modules rede|");
    });
  });

  describe("base da hades/local: branch.base > origin/<flow.base> > origin/develop sem perfil", () => {
    test("hades_base: branch.base, flow.base, sem perfil", () => {
      const b = (d: string) => nl(MI(["bash", "-c", 'source "$1/config.sh"; hades_base "$2"', "_", D1, d]).out);
      expect([wt1, wt2, `${r.T}/nogit`].map(b).join(" ")).toBe("origin/develop origin/main origin/develop");
    });
    test("install sem HADES_WT: worktree <clone>-hades nasce da origin/main do perfil", () => {
      for (const a of [["switch", "-q", "-c", "main"], ["commit", "-q", "--allow-empty", "-m", "só na main"], ["push", "-q", "origin", "main"], ["switch", "-q", "develop"]]) r.must(r.git(r.P, ...a));
      const o = MI(["bash", I], { HADES_DATA: `${r.T}/mi-d5` }, { cwd: r.P, merge: true });
      expect(`${o.rc} ${r.git(`${r.P}-hades`, "rev-parse", "HEAD").all.trim()}`).toBe(`0 ${r.git(r.P, "rev-parse", "origin/main").out.trim()}`);
    });
  });
});
