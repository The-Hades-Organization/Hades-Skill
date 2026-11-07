// Pacote anti-slop: ligado em frontend, fora do brief de backend, com atribuição; doctor e deps avisam do Impeccable sem erro.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { Rig, SKILL, readJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const base = readJson(`${SKILL}/quality/base.json`), packsJson = readJson(`${SKILL}/quality/packs.json`);
const pack = packsJson.packs.find((p: { id: string }) => p.id === "anti-slop");
const uiRules = base.rules.filter((x: { id: string }) => x.id.startsWith("ui."));

function repo(nome: string, pkg: object): string {
  const dir = `${r.T}/${nome}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/package.json`, JSON.stringify(pkg));
  return dir;
}
const data = `${r.T}/data-antislop`;
mkdirSync(data, { recursive: true });
writeFileSync(`${data}/env.sh`, `W="${r.C}"\n`);
const doctor = () => r.hades(["doctor", "--quick", "--json"], { env: { HADES_DATA: data } }).out;
const front = repo("web", { dependencies: { react: "^19.0.0" } });
const back = repo("api", { dependencies: { express: "^5.0.0" } });
r.hades(["quality", "on", "--all"]); // o Rig parte com tudo desligado
const inject = (dir: string) => r.hades(["quality", "inject", "--phase", "brief", "--dir", dir]).out;

describe("qualidade anti-slop", () => {
  test("pacote cobre todas as regras ui. e só elas, todas com scope frontend", () => {
    expect([...pack.rules].sort()).toEqual(uiRules.map((x: { id: string }) => x.id).sort());
    expect(uiRules.every((x: { scope?: string[] }) => x.scope?.[0] === "frontend")).toBe(true);
  });
  test("atribuição presente: autor, origem, licença e commit do upstream", () => {
    expect(pack.attribution).toMatchObject({ author: "Paul Bakaus", license: "Apache-2.0", origin: "https://github.com/pbakaus/impeccable" });
    expect(pack.attribution.commit).toMatch(/^[0-9a-f]{40}$/);
  });
  test("catálogo válido e esquema aceita scope e attribution", () => {
    expect(r.hades(["quality", "validate"]).rc).toBe(0);
    expect(r.hades(["project", "validate", `${SKILL}/quality/base.json`, `${SKILL}/quality/packs.json`]).rc).toBe(0);
  });
  test("brief de frontend leva as regras ui.", () => {
    const out = inject(front);
    expect(out).toContain("`ui.contraste-minimo`");
    expect(out).toContain("`ui.estados-completos`");
  });
  test("brief de backend não leva nenhuma regra ui.", () => {
    const out = inject(back);
    expect(out).toContain("## Qualidade");
    expect(out).not.toContain("`ui.");
  });
  test("o dono desliga o pacote e ele some até do frontend", () => {
    r.hades(["quality", "off", "--pack", "anti-slop"]);
    expect(inject(front)).not.toContain("`ui.");
    r.hades(["quality", "on", "--pack", "anti-slop"]);
    expect(inject(front)).toContain("`ui.");
  });
  test("deps e doctor sem o Impeccable: aviso, nunca erro", () => {
    const d = JSON.parse(r.hades(["deps", "--json"]).out) as { optionalSkills: { id: string; found: boolean }[] };
    expect(d.optionalSkills.find((s) => s.id === "impeccable")?.found).toBe(false);
    const doc = doctor();
    expect(doc).toContain("impeccable não encontrado");
    expect(doc).not.toMatch(/"level":\s*"error"[^}]*impeccable/);
  });
  test("com a skill instalada, doctor e deps a reconhecem", () => {
    mkdirSync(`${r.H}/.claude/skills/impeccable`, { recursive: true });
    writeFileSync(`${r.H}/.claude/skills/impeccable/SKILL.md`, "---\nname: impeccable\nversion: 9.9.9\n---\n");
    const d = JSON.parse(r.hades(["deps", "--json"]).out) as { optionalSkills: { found: boolean; version: string }[] };
    expect(`${d.optionalSkills[0]?.found} ${d.optionalSkills[0]?.version}`).toBe("true 9.9.9");
    expect(doctor()).toContain("impeccable 9.9.9");
  });
});
