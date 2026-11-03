// Grupo defeitos-4101 (4.10.1): páginas com campo ausente, install reinicia o painel ativo, skill-* do repo da skill,
// artefatos das provas no skill-clean.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { Rig, SKILL, STUBS, BUN, kv, readJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const S = `${r.T}/skill-d41`, sd = `${r.H}/.claude/hades/skill-dev`, sk = `${r.T}/work/_skill/orchestration/agents`;
const pg = `${SKILL}/kit/panel/ui/pages`;
const skIn = (cwd: string, args: string[]) => r.hadesIn(S, ["agent", ...args], { cwd, merge: true, env: r.ae });
const render = (file: string, id: string, ...rest: string[]) =>
  r.X([BUN, `${import.meta.dir}/lib/page-render.cjs`, `${pg}/${file}`, id, ...rest]).out.trim();
const count = (text: string, re: RegExp) => text.split("\n").filter((l) => re.test(l)).length;

describe("defeitos-4101", () => {
  r.skillCopy(S);

  test("as páginas do painel renderizam com o servidor antigo em memória (campo novo ausente)", () => {
    expect(render("cerberus.tsx", "cerberus", "{}"), "cerberus: resposta sem erros/cabecas/historico renderiza").toBe("ok");
    expect(render("remote.tsx", "remote", "{}", '{"d":{}}'), "remote: sem extras/widgetTunnel renderiza").toBe("ok");
  });

  describe("install reinicia o painel que está no ar, e só ele", () => {
    const wt = `${r.T}/wt-d41`, D = `${r.T}/d41-d`, SC = `${r.T}/d41-sc`, BB = `${r.T}/d41-bin`;
    mkdirSync(BB, { recursive: true });
    symlinkSync(Bun.which("node") ?? "/usr/bin/node", `${BB}/node`); symlinkSync(`${STUBS}/systemctl`, `${BB}/systemctl`);
    const PB = `${BB}:${r.env0.PATH}`;
    r.must(r.git(r.C, "worktree", "add", "-q", "-b", "d41/wt", wt));
    const inst = () => r.X(["bash", `${SKILL}/kit/install.sh`], { merge: true, env: kv({ PATH: PB, HADES_WT: wt, HADES_DATA: D, FAKE_SYSTEMCTL_DIR: SC,
      HADES_LOGINCTL: `${STUBS}/loginctl`, FAKE_LINGER: `${r.T}/d41-linger`, SKIP_WORKTREE: "1", SKIP_DOCTOR: "1" }) }).out;
    let u = "";
    const calls = () => (existsSync(`${SC}/calls.log`) ? readFileSync(`${SC}/calls.log`, "utf8") : "");

    test("install com o painel parado: não o reinicia nem diz que reiniciou", () => {
      inst();
      const id = readFileSync(`${D}/env.sh`, "utf8").match(/^HADES_ID="([^"]*)"/m)?.[1] ?? "";
      u = `hds${id ? `_${id}` : ""}-panel`;
      const out = inst();
      expect(`${count(calls(), new RegExp(`^(--user )?(stop|start) ${u}`))} ${count(out, /painel .* reiniciado/)}`).toBe("0 0");
    });
    test("install com o painel no ar: stop e start da unit, uma linha, painel segue ativo", () => {
      mkdirSync(`${SC}/active`, { recursive: true }); writeFileSync(`${SC}/active/${u}`, ""); writeFileSync(`${SC}/calls.log`, "");
      const out = inst();
      expect(`${count(calls(), new RegExp(`^--user stop ${u}$`))} ${count(calls(), new RegExp(`^--user start ${u}$`))}`, "stop e start da unit").toBe("1 1");
      expect(count(out, new RegExp(`^painel ${u} reiniciado`)), "diz que reiniciou numa linha").toBe(1);
      expect(existsSync(`${SC}/active/${u}`), "o painel segue ativo").toBe(true);
    });
  });

  describe("os skill-* rodam do repo da skill (sem origin) e de diretório fora de git", () => {
    test("skill-new do repo da skill cria worktree, branch e registro na raiz da skill", () => {
      const out = skIn(S, ["skill-new", "d41a", "--port", "21295"]);
      expect(`${out.rc} ${existsSync(`${sd}/d41a/.design-sync-reports`) && r.git(S, "show-ref", "--verify", "-q", "refs/heads/skill/d41a").rc === 0 ? "sim" : `não: ${out.all}`}`, "sai 0, cria a worktree e a branch").toBe("0 sim");
      expect(readJson(`${sk}/d41a.json`).mode, "registro na raiz da skill").toBe("skill");
    });
    test("skill-clean --merged --dry-run do repo da skill: sem recusa de origin", () => {
      const out = skIn(S, ["skill-clean", "--merged", "--dry-run"]);
      expect([out.rc, count(out.all, /remote\.origin\.url/)]).toEqual([0, 0]);
    });
    test("skill-clean de diretório fora de git: sai 0", () => {
      const out = skIn(`${r.T}/nogit`, ["skill-clean", "--merged", "--dry-run"]);
      expect([out.rc, count(out.all, /rode dentro|remote\.origin\.url/)]).toEqual([0, 0]);
    });
    test("skill-new de novo, ainda sem origin", () => {
      expect(skIn(S, ["skill-new", "d41b", "--port", "21296"]).rc).toBe(0);
    });
  });

  describe("artefatos conhecidos das provas contam como descartáveis; o resto segue recusando", () => {
    test("clean: artefato desconhecido recusa e lista só ele", () => {
      for (const u of ["d41a", "d41b"]) {
        mkdirSync(`${sd}/_data/${u}/data`, { recursive: true }); mkdirSync(`${sd}/_data/${u}/data-rt`, { recursive: true });
        writeFileSync(`${sd}/_data/${u}/data/estado`, "d\n");
        for (const f of ["install.log", "check.log", "panel.log"]) writeFileSync(`${sd}/_data/${u}/${f}`, "x\n");
        writeFileSync(`${sd}/_data/${u}/data-rt/estado`, "x\n");
      }
      writeFileSync(`${sd}/_data/d41b/export.tgz`, "export\n");
      const out = skIn(S, ["skill-clean", "d41b"]).all;
      expect(`${existsSync(`${sd}/d41b`) && existsSync(`${sd}/_data/d41b/export.tgz`) ? "sim" : "não"} ${count(out, /export\.tgz/)} ${count(out, /install\.log|check\.log|panel\.log|data-rt/)}`).toBe("sim 1 0");
    });
    test("clean: data/, install.log, check.log, panel.log e data-rt/ são descartáveis", () => {
      Bun.spawnSync(["rm", "-f", `${sd}/_data/d41b/export.tgz`]);
      const out = skIn(S, ["skill-clean", "d41a", "d41b"]).all;
      const gone = (u: string) => !existsSync(`${sd}/${u}`) && !existsSync(`${sd}/_data/${u}`);
      expect(`${gone("d41a") ? "sim" : `não: ${out}`} ${gone("d41b") ? "sim" : "não"}`).toBe("sim sim");
    });
  });
});
