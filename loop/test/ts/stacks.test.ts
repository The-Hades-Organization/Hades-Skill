// Grupo stacks: pacotes de stack — o hook lê as etapas do perfil; a fila lê custo da etapa, _maquina e as configurações; stack-add propõe e grava.
import { afterAll, describe, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FX, GATE_ENV, Rig, checkText, cutF2, gateSeds, jqS } from "./lib/rig";
import { hookCases } from "./lib/hook";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const PK = `${r.T}/packs-stk`;
const chomp = (s: string) => (s.endsWith("\n") ? s.slice(0, -1) : s);

describe("stacks", () => {
  mkdirSync(`${PK}/stk-nx`, { recursive: true }); mkdirSync(`${PK}/stk-cargo`, { recursive: true });
  mkdirSync(`${r.T}/stacks`, { recursive: true }); cpSync(`${FX}/stacks`, `${r.T}/stacks`, { recursive: true });
  for (const [k, s] of [["nx", "node-nx"], ["cargo", "rust-cargo"]] as const) {
    writeFileSync(`${PK}/stk-${k}/profile.json`, JSON.stringify({ schema: "hades.profile/1", name: `stk-${k}`, identity: { repo: `stk/${k}` }, stacks: [s] }, null, 2) + "\n");
    r.mkrepo(`stk/${k}`, `${r.T}/clone/stk-${k}`);
  }
  const nx = `${r.T}/clone/stk-nx`;
  const gl = (args: string[], cwd: string, env: Record<string, string> = {}) =>
    r.hades(["gate-lock", ...args], { cwd, merge: true, env: { ...GATE_ENV, ...env } });

  test("hook-stacks.txt", () => {
    const dirs = { nx, cargo: `${r.T}/clone/stk-cargo`, plain: r.P };
    checkText("hook-stacks.txt", r.norm(hookCases(r, `${FX}/hook/cases-stacks.tsv`, dirs, { HADES_PACKS_ROOT: PK })));
  });

  test("stacks-list.txt", () => {
    let out = `# stacks instaladas\n${r.hades(["project", "stacks"]).out}# step\n`;
    for (const j of ["node-nx:lint", "node-nx:test", "rust-cargo:build", "tauri:build", "node-nx:nada"]) out += `${j}: ${r.hades(["project", "step", j], { merge: true }).all.replace(/\n+$/, "")}\n`;
    checkText("stacks-list.txt", r.norm(out));
  });

  test("stacks-gate.txt", () => {
    let out = "";
    const run = (label: string, args: string[], cwd: string) => { const p = gl(args, cwd); out += `${p.out}${label} rc=${p.rc}\n`; };
    run("step", ["run", "--step", "node-nx:test", "--label", "st-a", "--timeout", "30", "--", "true"], nx);
    run("etapa-ruim", ["run", "--step", "node-nx:nada", "--label", "st-b", "--", "true"], nx);
    run("custo-explicito", ["run", "--step", "node-nx:test", "--cost-gb", "1", "--label", "st-c", "--timeout", "30", "--", "true"], nx);
    run("sem-origin", ["run", "lint", "--label", "sem-origin", "--timeout", "30", "--", "true"], `${r.T}/nogit`);
    out += gl(["status"], `${r.T}/nogit`).out.replace(/\n$/, "").split("\n").slice(0, 3).join("\n") + "\n";
    const j = (p: string) => chomp(cutF2(readFileSync(p, "utf8")));
    out += gateSeds(`# journal do projeto\n${j(`${r.T}/work/stk__nx/locks/gate-journal.tsv`)}\n# journal da maquina\n${j(`${r.T}/work/_maquina/locks/gate-journal.tsv`)}`) + "\n";
    const t = r.norm(out).replace(/MemAvailable [0-9]+ MB/g, "MemAvailable <MB>").replace(/PSI some avg10 [0-9.]+%/g, "PSI <P>");
    checkText("stacks-gate.txt", t);
  });

  // O gate espera de verdade (`--timeout 6` na janela pesada): o teste leva mais que os 5 s padrão do bun
  test("stacks-cfg.txt", () => {
    const at = new Date(Date.now() + 12 * 3600e3), at1 = new Date(Date.now() + 12 * 3600e3 + 60e3);
    const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const win = `${hm(at)}-${hm(at1)}`; // nunca contém agora
    let out = "";
    const run = (label: string, args: string[], env: Record<string, string> = {}) => { const p = gl(args, nx, env); out += `${p.out}${label} rc=${p.rc}\n`; };
    run("janela-leve", ["run", "lint", "--label", "cfg-leve", "--timeout", "30", "--", "true"], { HADES_GATE_WINDOW: win, HADES_GATE_SCOPE: "maquina" });
    run("janela-pesado", ["run", "test", "--label", "cfg-pesado", "--timeout", "6", "--", "true"], { HADES_GATE_WINDOW: win });
    run("orcamento-projeto-vazio", ["run", "lint", "--label", "cfg-proj", "--timeout", "30", "--", "true"], { HADES_GATE_PROJECT_BUDGET_GB: "1" });
    run("medido-sem-pico", ["run", "--step", "node-nx:lint", "--label", "cfg-med", "--timeout", "30", "--", "true"], { HADES_GATE_COST_MEASURED: "1" });
    const t = r.norm(out).split(win).join("<JANELA>").replace(/\b[0-9]+s\b/g, "<S>").split("\n").map((l) => l.replace(/^ {2}[0-9-]+\.t: .*/, "  <ticket>")).join("\n");
    checkText("stacks-cfg.txt", t);
  }, 30000);

  test("stacks-add.txt", () => {
    const R = `${r.T}/stkadd`;
    mkdirSync(`${R}/repo/.github/workflows`, { recursive: true }); mkdirSync(`${R}/draft`, { recursive: true }); mkdirSync(`${R}/user`, { recursive: true });
    writeFileSync(`${R}/repo/package.json`, '{"name":"d","scripts":{"lint":"eslint .","test":"jest","start":"node ."}}\n');
    writeFileSync(`${R}/repo/.github/workflows/ci.yml`, "jobs:\n  ci:\n    steps:\n      - run: npm run lint\n");
    const u = { HADES_STACKS_ROOT: `${R}/user` };
    const sa = (args: string[], env: Record<string, string> = {}) => r.hades(["stack-add", ...args], { merge: true, env });
    let out = jqS(r.hades(["stack-add", "propose", `${R}/repo`, "--name", "add-npm", "--stage", `${R}/draft`]).out, ["draft"]);
    let p = sa(["save", `${R}/draft/add-npm`]); out += `${p.out}sem-ok rc=${p.rc}\n`;
    p = sa(["save", `${R}/draft/add-npm`, "--confirmed"], u); out += `${p.out}salvo rc=${p.rc}\n`;
    p = sa(["save", `${R}/draft/add-npm`, "--confirmed"], u); out += `${p.out}de-novo rc=${p.rc}\n`;
    out += `detect: ${r.hades(["project", "detect", `${R}/repo`], { env: u }).out.split("\n").slice(0, -1).join(" ")} \n`;
    p = sa(["propose", `${r.T}/nogit`]); out += `${p.out}sem-manifest rc=${p.rc}\n`;
    checkText("stacks-add.txt", r.norm(out));
  });
});
