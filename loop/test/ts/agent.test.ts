// Grupo agent: hades agent new/skill-new/skill-clean/list sobre o clone da fixture, contra golden/agent-*.
import { afterAll, describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Rig, checkJson, checkText } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const o = join(r.T, "work/example__monorepo");

// O grupo roda depois do coletor e do hook: estado do coletor e o agente impl-x do hook já existem no registro
r.stateFixture();
r.hookDirs();

const $ = (args: string) => args.split(" ");


describe("agent", () => {
  test("agent-new.txt e brief", () => {
    let out = "";
    for (const args of [
      "new impl-b --role impl --branch svc/feat/sem-card", "new impl-b --branch svc/feat/SOFTWARE-9-x --card SOFTWARE-123",
      "new Nome_Ruim --branch x", "new impl-c --for inbox", "new impl-d --role impl --card SOFTWARE-1",
      "new impl-a --role impl --branch svc/feat/SOFTWARE-123-demo --card SOFTWARE-123 --specs UC-1,UC-2 --dry-run",
    ]) { const p = r.agent($(args)); out += `$ hades agent ${args}\n${p.out}rc=${p.rc}\n`; }
    out += "$ hades agent new impl-a (de verdade)\n";
    const p = r.agent($("new impl-a --role impl --branch svc/feat/SOFTWARE-123-demo --card SOFTWARE-123 --specs UC-1,UC-2"));
    out += `${p.out}rc=${p.rc}\n`;
    checkText("agent-new.txt", r.norm(out));
    checkText("agent-new-brief.md", r.norm(readFileSync(`${r.T}/agents/impl-a/.design-sync-reports/brief.md`, "utf8")));
  });

  test("agent-new.json", () => {
    const reg = JSON.parse(readFileSync(`${o}/orchestration/agents/impl-a.json`, "utf8")) as Record<string, unknown>;
    delete reg.createdAt;
    const glob = JSON.parse(readFileSync(`${o}/state/global.json`, "utf8")) as { deliveries: Record<string, Record<string, unknown>> };
    const entrega = Object.fromEntries(Object.entries(glob.deliveries).map(([k, v]) => { const { since: _s, ...rest } = v; return [k, rest]; }));
    const owner = readFileSync(`${o}/locks/deliver-SOFTWARE-123.lock/owner`, "utf8").replace(/\n$/, "").split("\n")
      .map((l) => l.replace(/^(host|pid|since)=.*/, "$1=<VAR>"));
    checkJson("agent-new.json", r.norm(JSON.stringify({ registro: reg, entrega, lock: owner })));
  });

  test("skill-new/skill-clean", () => {
    const s2 = join(r.T, "skill");
    r.skillCopy(s2);
    const sha = r.git(s2, "rev-parse", "--short", "main").out.trim();
    const at = (args: string) => { const p = r.hadesIn(s2, ["agent", ...$(args)], { cwd: r.C, merge: true, env: r.ae }); return `${p.out}rc=${p.rc}\n`; };
    const out = `$ hades agent skill-new demo --port 21289\n${at("skill-new demo --port 21289")}`
      + `$ hades agent skill-new demo (de novo)\n${at("skill-new demo --port 21289")}`
      + `$ hades agent skill-clean demo --dry-run\n${at("skill-clean demo --dry-run")}`;
    const shaRe = new RegExp(`\\b${sha}\\b`, "g");
    checkText("agent-skill.txt", r.norm(out.replace(shaRe, "<SHA>")));
    checkText("agent-skill-brief.md", r.norm(readFileSync(`${r.H}/.claude/hades/skill-dev/demo/.design-sync-reports/brief.md`, "utf8").replace(shaRe, "<SHA>")));
  });

  test("agent-list.json", () => {
    const p = r.agent($("list --all --json"), { merge: false });
    const list = (JSON.parse(p.out) as Record<string, unknown>[]).map((a) => { const { herdr: _h, ...rest } = a; return rest; });
    checkJson("agent-list.json", r.norm(JSON.stringify(list)));
  });
});

