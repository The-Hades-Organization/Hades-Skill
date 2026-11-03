// Grupo init: project-init — rascunho a partir do repo, mapeamento ao catálogo, schema, gravação com ok e re-run com diff.
import { afterAll, describe, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { FX, Rig, checkJson, checkText, readJson, writeJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const R = `${r.T}/init`, PK = `${r.T}/packs-init`;
const E = { HADES_PACKS_ROOT: PK };
const pi = (args: string[], o: { env?: Record<string, string>; cwd?: string; merge?: boolean } = {}) => r.hades(["project-init", ...args], { env: E, ...o });
/** `jq -r`: string crua, o resto como JSON com recuo de 2. */
const jqRaw = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2)) + "\n";
const lsCount = (d: string) => (existsSync(d) ? readdirSync(d).length : 0);

describe("init", () => {
  mkdirSync(R, { recursive: true }); mkdirSync(PK, { recursive: true });
  for (const [dir, name] of [["nx", "widget"], ["node", "tiny"]] as const) {
    cpSync(`${FX}/init/${dir}`, `${R}/${dir}`, { recursive: true });
    r.must(r.git(`${R}/${dir}`, "init", "-q", "-b", "main"));
    r.must(r.git(`${R}/${dir}`, "remote", "add", "origin", `https://github.com/acme/${name}.git`));
  }
  r.hades(["quality", "on", "ts.sem-any"]); // ligado: a regra do repo que o contraria vira conflito
  const dry = pi(["draft", `${R}/nx`, "--dry-run"]);

  test("init-dry.txt", () => {
    checkText("init-dry.txt", r.norm(`$ draft (dry-run, nada gravado)\nrc=${dry.rc}\npacotes: ${lsCount(PK)} · rascunhos: ${lsCount(`${r.T}/init-stage`)}\n${dry.err}`));
  });
  test("init-draft.json", () => checkJson("init-draft.json", r.norm(dry.out)));
  test("init-conflicts.txt", () => checkText("init-conflicts.txt", r.norm(jqRaw((JSON.parse(dry.out) as { quality: { conflicts: unknown } }).quality.conflicts))));
  test("init-small.json", () => {
    r.hades(["quality", "off", "--all"]);
    checkJson("init-small.json", r.norm(pi(["draft", `${R}/node`, "--dry-run"], { merge: true }).out));
  });

  test("init-save.txt", () => {
    pi(["draft", `${R}/nx`, "--stage", `${r.T}/init-stage`]); pi(["draft", `${R}/node`, "--stage", `${r.T}/init-stage`]);
    const st = `${r.T}/init-stage`;
    cpSync(`${st}/widget`, `${st}/bad`, { recursive: true });
    const bad = readJson(`${st}/widget/profile.json`); bad.name = "bad"; bad.flow = { ...bad.flow, kind: "ambos" }; writeJson(`${st}/bad/profile.json`, bad);
    let out = "";
    const step = (title: string, p: { out: string; rc: number }) => { out += `${title}\n${p.out}rc=${p.rc}\n`; };
    step("$ save sem ok", pi(["save", `${st}/widget`, `${R}/nx`], { merge: true }));
    step("$ save schema inválido", pi(["save", `${st}/bad`, `${R}/nx`, "--confirmed"], { merge: true }));
    out += `pacotes: ${readdirSync(PK).sort().map((n) => n + " ").join("")}\n`;
    out += `$ resolvedor antes\nrc=${r.hades(["project", "resolve"], { cwd: `${R}/nx`, env: E }).rc}\n`;
    step("$ save com ok", pi(["save", `${st}/widget`, `${R}/nx`, "--confirmed"], { merge: true }));
    out += `resolvedor rc=${r.hades(["project", "resolve"], { cwd: `${R}/nx`, env: E }).rc}\n`;
    const val = r.hades(["project", "validate", `${PK}/widget/profile.json`]);
    out += `${val.err}validate: ${val.out.split("\n")[0]!.slice(0, 2)}\n`; // o aviso (stderr) sai antes do eco, fora do $(…)
    out += `pacote com git: ${existsSync(`${PK}/widget/.git`) ? "sim" : "não"}\n`;
    step("$ save repo pequeno", pi(["save", `${st}/tiny`, `${R}/node`, "--confirmed"], { merge: true }));
    checkText("init-save.txt", r.norm(out));
  });

  test("init-rerun.txt", () => {
    const prof = readJson(`${PK}/widget/profile.json`);
    prof.refs = { deliver: "loop/deliver.md" }; prof.pr = { labels: ["backend"] }; prof.flow = { ...prof.flow, base: "main" };
    writeJson(`${PK}/widget/profile.json`, prof);
    mkdirSync(`${PK}/widget/loop`, { recursive: true }); writeFileSync(`${PK}/widget/loop/deliver.md`, "# deliver\n");
    let out = "$ re-run: draft\n";
    const d = pi(["draft", `${R}/nx`, "--stage", `${r.T}/init-stage2`]);
    const dj = JSON.parse(d.out) as { preserved: unknown; diff: unknown };
    out += `rc=${d.rc}\n${jqRaw(dj.preserved)}${jqRaw(dj.diff)}`;
    const tail = (s: string, n: number) => s.replace(/\n$/, "").split("\n").slice(-n).join("\n") + "\n";
    const base = () => readJson(`${PK}/widget/profile.json`);
    let p = pi(["save", `${r.T}/init-stage2/widget`, `${R}/nx`, "--confirmed"], { merge: true });
    out += `$ re-run: save sem --force\n${tail(p.out, 1)}rc=${p.rc}\nbase no pacote: ${base().flow.base}\n`;
    p = pi(["save", `${r.T}/init-stage2/widget`, `${R}/nx`, "--confirmed", "--force"], { merge: true });
    out += `$ re-run: save com --force\n${tail(p.out, 2)}rc=${p.rc}\nbase no pacote: ${base().flow.base} · refs: ${JSON.stringify(base().refs)}\n`;
    const d3 = JSON.parse(pi(["draft", `${R}/nx`, "--stage", `${r.T}/init-stage3`]).out) as { diff: string | unknown[] };
    out += `$ re-run sem mudança\n${d3.diff.length}\n`;
    checkText("init-rerun.txt", r.norm(out));
  });
});
