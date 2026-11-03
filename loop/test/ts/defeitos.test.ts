// Grupo defeitos (4.1): skill-clean, porta, watch, guard e release — cada caso falhava na main de antes da correção.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { FX, Rig, SKILL, readJson, writeJson } from "./lib/rig";
import { hookCases } from "./lib/hook";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const S = `${r.T}/skill-def`, sd = `${r.H}/.claude/hades/skill-dev`, o = `${r.T}/work/_skill/orchestration/agents`;
const agent = (args: string[], env: Record<string, string> = {}) => r.agentIn(S, args, { env });
const nl = (s: string) => s.replace(/\n+$/, "");
const lsOf = (d: string, names: string[]) => names.filter((n) => existsSync(`${d}/${n}`)).sort().join(" ");
const brief = (n: string) => { try { return (readFileSync(`${sd}/${n}/.design-sync-reports/brief.md`, "utf8").match(/painel: [^ \n]*/g) ?? []).join("\n"); } catch { return ""; } };

describe("defeitos", () => {
  r.skillCopy(S);

  test("skill-clean arquiva patch/diff/tsv/json/txt e recusa quando _data/<u> tem algo além de data/", () => {
    agent(["skill-new", "cl1", "--port", "21289"]); agent(["skill-new", "cl2", "--port", "21288"]);
    for (const u of ["cl1", "cl2"]) {
      for (const f of ["x.patch", "y.diff", "t.tsv", "d.json", "n.txt", "p.png"]) writeFileSync(`${sd}/${u}/.design-sync-reports/${f}`, `${u}\n`);
      mkdirSync(`${sd}/_data/${u}/data`, { recursive: true }); writeFileSync(`${sd}/_data/${u}/data/estado`, "d\n");
    }
    mkdirSync(`${sd}/_data/cl1/nucleo`, { recursive: true }); writeFileSync(`${sd}/_data/cl1/nucleo/arquivo`, "export\n");
    const out = agent(["skill-clean", "cl1"]).out;
    expect(existsSync(`${sd}/cl1`) && existsSync(`${sd}/_data/cl1/nucleo/arquivo`) && out.includes("nucleo"), "clean: recusa _data com conteúdo fora de data/").toBe(true);
    agent(["skill-clean", "cl1", "--force-data"]);
    expect(!existsSync(`${sd}/cl1`) && !existsSync(`${sd}/_data/cl1`), "clean: --force-data remove a unidade").toBe(true);
    agent(["skill-clean", "cl2"]);
    expect(!existsSync(`${sd}/cl2`) && !existsSync(`${sd}/_data/cl2`), "clean: só data/ é descartável").toBe(true);
    for (const u of ["cl1", "cl2"]) expect(lsOf(`${sd}/_arquivo/${u}`, ["d.json", "n.txt", "p.png", "t.tsv", "x.patch", "y.diff"]), `clean: arquivo de ${u}`).toBe("d.json n.txt p.png t.tsv x.patch y.diff");
  });

  test("skill-new: unidade arquivada libera a porta; faixa esgotada falha sem criar nada", () => {
    mkdirSync(o, { recursive: true });
    for (let i = 0; i < 10; i++) writeJson(`${o}/arq${i}.json`, { name: `arq${i}`, mode: "skill", state: "archived", port: 21280 + i });
    const faixa10 = { HADES_SKILL_PORT_MIN: "21280", HADES_SKILL_PORT_MAX: "21289" }; // o padrão tem 20 portas; este caso mede a borda de 10
    agent(["skill-new", "p11"], faixa10);
    expect(brief("p11"), "porta: a 11ª unidade ganha porta da faixa").toMatch(/^painel: 2128[0-9]\.$/);
    for (let i = 1; i < 10; i++) { const j = readJson(`${o}/arq${i}.json`); j.state = "allocated"; writeJson(`${o}/arq${i}.json`, j); }
    const p12 = agent(["skill-new", "p12"], faixa10);
    expect(p12.rc !== 0 && p12.out.includes("faixa"), "porta: faixa esgotada falha com mensagem").toBe(true);
    expect(!existsSync(`${sd}/p12`) && r.git(S, "show-ref", "--verify", "-q", "refs/heads/skill/p12").rc !== 0, "porta: faixa esgotada não cria worktree nem branch").toBe(true);
    agent(["skill-new", "p13"], { HADES_SKILL_PORT_MIN: "21270", HADES_SKILL_PORT_MAX: "21270" });
    expect(brief("p13"), "porta: a faixa vem de HADES_SKILL_PORT_MIN/MAX").toBe("painel: 21270.");
    for (const f of readdirSync(o)) if (/^(arq.*|p1.*)\.json$/.test(f)) rmSync(`${o}/${f}`);
  });

  test("hades-watch: só os eventos legítimos saem", () => {
    const w = `${r.T}/wdef`, ws = `${r.T}/wstate`, now = Math.floor(Date.now() / 1000);
    mkdirSync(ws, { recursive: true });
    const mkunit = (n: string, state: string, prompted?: string) => {
      mkdirSync(`${w}/${n}/.design-sync-reports`, { recursive: true });
      writeJson(`${o}/${n}.json`, { name: n, mode: "skill", role: "impl", branch: `skill/${n}`, worktree: `${w}/${n}`, state, ...(prompted ? { promptedAt: prompted } : {}) });
    };
    mkunit("w-semprompt", "working"); mkunit("w-comprompt", "working", "2026-01-02T00:00:00Z");
    mkunit("w-arquivada", "archived", "2026-01-02T00:00:00Z"); mkunit("w-contexto", "working", "2026-01-02T00:00:00Z");
    mkunit("w-retomada", "working", "2026-01-02T00:00:00Z"); mkunit("w-reparked", "working", "2026-01-02T00:00:00Z");
    for (const n of ["w-arquivada", "w-contexto"]) {
      const d = `${r.H}/.claude/projects/${`${w}/${n}`.replace(/[/.]/g, "-")}`;
      mkdirSync(d, { recursive: true });
      writeFileSync(`${d}/s.jsonl`, '{"type":"assistant","message":{"usage":{"input_tokens":300000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n');
    }
    const parked = (n: string, when: string) => { const f = `${w}/${n}/.design-sync-reports/handoff.md`; writeFileSync(f, "STATUS: PARKED — teto\n"); utimesSync(f, new Date(when), new Date(when)); };
    parked("w-retomada", "2026-01-01T00:00:00Z"); parked("w-reparked", "2026-01-03T00:00:00Z");
    for (const n of ["w-semprompt", "w-comprompt"]) writeFileSync(`${ws}/${n}.idle`, `${now - 3600}\n`);
    const ag = '{"result":{"agents":[{"name":"w-semprompt","agent_status":"idle"},{"name":"w-comprompt","agent_status":"idle"}]}}';
    const p = r.X(["timeout", "30", process.execPath, `${SKILL}/src/cli.ts`, "watch", "--next", "1"], {
      cwd: r.C, merge: true, env: { ...r.ae, FAKE_HERDR_AGENTS: ag, HADES_WATCH_STATE: ws, HADES_ORCH_STALL_MIN: "5" } });
    const got = nl(p.out).split("\n").map((l) => l.replace(/^(STALLED [^ ]+) [0-9]+$/, "$1 <min>")).sort().join("\n");
    expect(got, "watch: só os eventos legítimos saem").toBe("CONTEXT w-contexto 300k\nPARKED w-reparked teto\nSTALLED w-comprompt <min>");
    for (const f of readdirSync(o)) if (f.startsWith("w-")) rmSync(`${o}/${f}`);
  });

  describe("guard: só o comando executado conta, não o texto entre aspas", () => {
    const names = readFileSync(`${FX}/hook/cases-defeitos.tsv`, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")[0] as string);
    const blocked = new Set(["answer-e-gate-real", "resume-e-gate-real", "answer-aspas-no-gate", "leitura-repetida", "rel-leitura-apos-gate-2", "sono-curto-entre-2"]);
    let rcs: Map<string, string> | undefined;
    const load = () => {
      if (!rcs) {
        const out = r.norm(hookCases(r, `${FX}/hook/cases-defeitos.tsv`, r.hookDirs()));
        rcs = new Map(out.split("\n").filter(Boolean).map((l) => { const [n, rc] = l.split("\t"); return [n as string, rc as string]; }));
      }
      return rcs;
    };
    for (const n of names) test(n, () => expect(load().get(n), `guard: ${n}`).toBe(blocked.has(n) ? "rc=2" : "rc=0"));
  });

  test("skill-release: `same` empacota a VERSION atual sem bump e exige a entrada dela no CHANGELOG", () => {
    const R = `${r.T}/skill-rel`, rd = `${r.T}/rel-data`;
    mkdirSync(R, { recursive: true }); mkdirSync(rd, { recursive: true });
    cpSync(`${SKILL}/kit`, `${R}/kit`, { recursive: true }); cpSync(`${SKILL}/loop`, `${R}/loop`, { recursive: true });
    writeFileSync(`${R}/VERSION`, "9.9.9\n"); writeFileSync(`${R}/CHANGELOG.md`, "# Changelog\n\n## 9.9.8 — 2026-01-01\n\n- antes\n");
    writeFileSync(`${rd}/env.sh`, `W="${r.C}"\n`);
    const rel = (args: string[]) => r.X(["bash", `${R}/kit/skill-release.sh`, "release", ...args], { merge: true, env: { HADES_DATA: rd, HADES_WT: r.C } });
    const a = rel(["same", "x", "--out", `${r.T}/rel-out`]);
    expect(a.rc !== 0 && a.out.includes("CHANGELOG") && readFileSync(`${R}/VERSION`, "utf8").trim() === "9.9.9" && !existsSync(`${r.T}/rel-out`), "release same: sem entrada no CHANGELOG falha").toBe(true);
    expect(rel(["bogus", "x"]).rc, "release: nível inválido continua recusado").toBe(2);
  });
});
void renameSync;
