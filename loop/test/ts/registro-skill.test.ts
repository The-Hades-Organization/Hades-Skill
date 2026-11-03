// Grupo registro-skill: registro único `_skill` — skill-new, adopt, status, prompt, phase, resume, done e watch, do repo da skill e de um clone.
// Contra o comando novo (`hades agent`, `hades watch`); não compara com o wrapper, então fica fora dos parity-*.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { BUN, Rig, readJson, writeJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const S = `${r.T}/skill-rs`, sd = `${r.H}/.claude/hades/skill-dev`, sk = `${r.T}/work/_skill/orchestration/agents`, pj = `${r.T}/work/example__monorepo/orchestration/agents`, ws = `${r.T}/rs-watch`;
const from = (cwd: string, args: string[], ag = "") => r.hadesIn(S, ["agent", ...args], { cwd, merge: true, env: { ...r.ae, FAKE_HERDR_AGENTS: ag } });
const one = (name: string) => {
  let n = 0;
  for (const p of readdirSync(`${r.T}/work`, { recursive: true }).map(String)) if (/orchestration\/agents\/[^/]+$/.test(p) && p.endsWith(`/${name}.json`)) n++;
  return n;
};
const count = (text: string, re: RegExp) => text.split("\n").filter((l) => re.test(l)).length;
const has = (p: string) => (existsSync(p) ? 1 : 0);
const agents = (name: string, pane: string) => JSON.stringify({ result: { agents: [{ name, cwd: `${sd}/${name}`, foreground_cwd: `${sd}/${name}`, pane_id: pane, agent_status: "idle" }] } });
const watch = (cwd: string, state: string) => r.X(["timeout", "60", BUN, `${S}/src/cli.ts`, "watch", "--next", "1"], { cwd, merge: true, env: { ...r.ae, HADES_WATCH_STATE: state } }).out;

describe("registro-skill", () => {
  r.skillCopy(S);
  const ag1 = agents("rs1", "p1"), ag2 = agents("rs2", "p2");

  test("skill-new: do repo da skill e do clone, o registro é o _skill", () => {
    from(S, ["skill-new", "rs1", "--port", "21297"]); from(r.C, ["skill-new", "rs2", "--port", "21298"]);
    expect(`${readJson(`${sk}/rs1.json`).mode} ${readJson(`${sk}/rs2.json`).mode}`).toBe("skill skill");
  });
  test("skill-new: nada no registro do projeto do clone", () => { expect(`${has(`${pj}/rs1.json`)} ${has(`${pj}/rs2.json`)}`).toBe("0 0"); });

  test("adopt: do clone e da worktree da unidade, modo skill e painel religado", () => {
    from(r.C, ["adopt", "rs1"], ag1); from(`${sd}/rs2`, ["adopt", "rs2"], ag2);
    expect(`${readJson(`${sk}/rs1.json`).mode} ${readJson(`${sk}/rs2.json`).mode} ${readJson(`${sk}/rs1.json`).pane} ${readJson(`${sk}/rs2.json`).pane}`).toBe("skill skill p1 p2");
  });
  test("adopt: o registro do projeto continua sem a unidade", () => { expect(`${has(`${pj}/rs1.json`)} ${has(`${pj}/rs2.json`)}`).toBe("0 0"); });

  test("status <nome> do clone: a unidade da skill aparece", () => { expect(count(from(r.C, ["status", "rs1"], ag1).out, /^rs1 .*skill/)).toBe(1); });
  test("status do repo da skill: lista as duas unidades", () => {
    const o = from(S, ["status"]).out; expect(`${count(o, /^rs1 /)} ${count(o, /^rs2 /)}`).toBe("1 1");
  });
  test("status do clone: soma as unidades de _skill aos agentes do projeto", () => {
    const o = from(r.C, ["status"]).out; expect(`${count(o, /^rs1 /)} ${count(o, /^rs2 /)}`).toBe("1 1");
  });
  test("list --json do clone: inclui as unidades da skill", () => {
    const l = JSON.parse(from(r.C, ["list", "--json"]).out) as { mode: string; name: string }[];
    expect(l.filter((u) => u.mode === "skill" && u.name.startsWith("rs")).map((u) => u.name).join(" ")).toBe("rs1 rs2");
  });
  test("prompt do clone: grava o estado no registro único", () => {
    from(r.C, ["prompt", "rs1"], ag1); const j = readJson(`${sk}/rs1.json`);
    expect(`${j.state} ${j.promptedAt ? "sim" : "não"}`).toBe("working sim");
  });
  test("phase do clone e resume do repo da skill: o mesmo contador de /clear", () => {
    from(r.C, ["phase", "rs1", "impl"], ag1); from(S, ["resume", "rs1"], ag1);
    expect(String(readJson(`${sk}/rs1.json`).clears)).toBe("2");
  });

  test("watch do repo da skill: QUESTION da unidade", () => {
    writeFileSync(`${sd}/rs1/.design-sync-reports/questions.md`, "## Q1 — assunto\ncontexto\n");
    expect(count(watch(S, `${ws}-s`), /^QUESTION rs1 1$/)).toBe(1);
  });
  test("watch do clone: a mesma unidade, do registro único", () => { expect(count(watch(r.C, `${ws}-c`), /^QUESTION rs1 1$/)).toBe(1); });

  test("done do clone: sai 0, sem cobrar upstream, push nem PR", () => {
    rmSync(`${sd}/rs1/.design-sync-reports/questions.md`, { force: true });
    writeFileSync(`${sd}/rs1/.design-sync-reports/report.md`, "STATUS: DONE\n\nok\n");
    const o = from(r.C, ["done", "rs1"], ag1); expect(`${o.rc} ${count(o.out, /upstream|sem push|nenhuma PR/)}`).toBe("0 0");
  });
  test("done do clone: o estado fecha em _skill", () => { expect(readJson(`${sk}/rs1.json`).state).toBe("done"); });
  test("done do repo da skill: sai 0 e fecha em _skill", () => {
    writeFileSync(`${sd}/rs2/.design-sync-reports/report.md`, "STATUS: DONE\n\nok\n");
    const o = from(S, ["done", "rs2"], ag2); expect(`${o.rc} ${readJson(`${sk}/rs2.json`).state}`).toBe("0 done");
  });

  describe("unidade gravada no registro do projeto por um skill-new antigo: o primeiro comando com o nome a traz para _skill", () => {
    let out = "";
    test("movido para _skill ao primeiro uso", () => {
      mkdirSync(pj, { recursive: true });
      writeJson(`${pj}/rs3.json`, { name: "rs3", mode: "skill", role: "impl", worktree: `${sd}/rs2`, state: "allocated" });
      out = from(r.C, ["status", "rs3"]).out;
      expect(`${has(`${sk}/rs3.json`) ? "sim" : "não"} ${has(`${pj}/rs3.json`) ? "sim" : "não"}`).toBe("sim não");
    });
    test("o aviso diz que moveu", () => { expect(count(out, /movida do registro do projeto/)).toBe(1); });
  });

  test("um registro só por unidade (rs1, rs2, rs3)", () => {
    expect(`${one("rs1")} ${one("rs2")} ${one("rs3")}`).toBe("1 1 1");
    for (const f of readdirSync(pj)) if (/^rs.*\.json$/.test(f)) rmSync(`${pj}/${f}`);
  });
});
