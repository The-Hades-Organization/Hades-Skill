// Grupo quality: liga/desliga, injeção nos briefs e nas fases, precedência do perfil e relatório de conflito (reference/quality.md).
import { afterAll, describe, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { FX, Rig, SKILL, checkText, cutBytes, readJson, writeJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const ch = `${r.H}/.claude/hades/quality/choices.tsv`;
const q = (args: string[], o: { cwd?: string; env?: Record<string, string>; merge?: boolean } = {}) => r.hades(["quality", ...args], o);
const count = (s: string) => s.split("\n").filter((l, i, a) => l !== "" || i < a.length - 1).length - (s === "" ? 1 : 0);
const cut60 = (s: string) => s.split("\n").map((l) => cutBytes(l, 60)).join("\n");

describe("quality", () => {
  test("quality-cli.txt", () => {
    let out = "$ list --group banco\n" + cut60(q(["list", "--group", "banco"]).out);
    out += "$ on --all (default)\n";
    q(["on", "--all"]); q(["off", "ts.sem-any", "py.sem-except-nu", "--group", "banco"]);
    out += `on: ${count(q(["list", "--on"]).out)} off: ${count(q(["list", "--off"]).out)}\n`;
    out += "$ off --all, on 2 regras\n";
    q(["off", "--all"]); q(["on", "pratica.erro-explicito", "teste.deterministico"]);
    out += cut60(q(["list", "--on"]).out);
    const bad = q(["on", "nao.existe"], { merge: true });
    out += `$ id ruim\n${bad.out}rc=${bad.rc}\n`;
    out += `$ inject --phase review\n${q(["inject", "--phase", "review", "--dir", r.C], { merge: true }).out}`;
    q(["reset"]);
    out += `$ reset\nchoices: ${existsSync(ch) ? "existe" : "ausente"}\n`;
    checkText("quality-cli.txt", r.norm(out));
  });

  test("quality-brief.md e quality-phases.txt", () => {
    q(["off", "--all"]); q(["on", "pratica.erro-explicito", "teste.deterministico"]);
    r.agent("new q-a --role impl --branch svc/feat/SOFTWARE-77-q --card SOFTWARE-77".split(" "));
    const brief = readFileSync(`${r.T}/agents/q-a/.design-sync-reports/brief.md`, "utf8");
    const i = brief.split("\n").findIndex((l) => l.startsWith("## Qualidade"));
    checkText("quality-brief.md", r.norm(brief.split("\n").slice(i).join("\n")));
    let out = "";
    for (const ph of ["deliver", "inbox", "review"]) out += `# ${ph}\n${q(["inject", "--phase", ph, "--dir", r.C]).out.split("\n")[0]}\n`;
    checkText("quality-phases.txt", out);
  });

  test("quality-profile.txt", () => {
    mkdirSync(`${r.T}/packs-q/example-monorepo`, { recursive: true });
    const prof = readJson(`${FX}/packs/example-monorepo/profile.json`);
    prof.rules = { ...prof.rules, quality: [
      { id: "teste.deterministico", severity: "bloqueante", note: "flaky quebra o CI" },
      { id: "pratica.erro-explicito", severity: "baixa", note: "legado" },
      { id: "teste.sem-mock-do-que-e-seu", contradicts: true, note: "o projeto mocka a camada de dados" },
      { id: "x.nao-existe" }] };
    writeJson(`${r.T}/packs-q/example-monorepo/profile.json`, prof);
    q(["on", "teste.sem-mock-do-que-e-seu"]);
    const PQ = { HADES_PACKS_ROOT: `${r.T}/packs-q` };
    let out = "# sobe\n";
    out += q(["inject", "--phase", "brief", "--dir", r.C], { env: PQ }).out.split("\n").filter((l) => /teste.deterministico|erro-explicito/.test(l)).map((l) => l + "\n").join("");
    out += `# conflitos\n${q(["conflicts", "--dir", r.C], { env: PQ, merge: true }).out}`;
    const np = q(["conflicts", "--dir", r.P], { merge: true });
    out += `# sem perfil\n${np.out}rc=${np.rc}\n`;
    // o Python gravava o aviso (stderr, sem buffer) antes do stdout (bloco), então o esperado traz o aviso primeiro
    const sep = r.hades(["project", "validate", `${r.T}/packs-q/example-monorepo/profile.json`, `${SKILL}/quality/base.json`, ch]);
    out += `# validação\n${sep.err}${sep.out}`;
    checkText("quality-profile.txt", r.norm(out));
    q(["off", "--all"]);
  });
});
