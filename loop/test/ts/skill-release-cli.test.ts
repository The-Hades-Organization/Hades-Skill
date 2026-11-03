// Grupo skill-release: `hades skill-release` (guard, drift e os erros do release) dá a saída (stderr junto) e o código gravados
// em golden/legado. O `check` mudou de propósito (regressão em bun test, pulo por HEAD verde, fila de gates): o comportamento
// novo está em skill-release.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { BUN, FX, Rig, SKILL, readJson, writeJson } from "./lib/rig";
import { legado } from "./lib/legado";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const g = legado(import.meta.path);

const both = (key: string, args: string[], env: Record<string, string> = {}) => {
  const old = g.get<{ rc: number; all: string }>(key);
  const x = r.X([BUN, `${SKILL}/src/cli.ts`, "skill-release", ...args], { merge: true, env });
  return { old, now: { rc: x.rc, all: r.norm(x.all) } };
};
const same = (key: string, args: string[], env: Record<string, string> = {}) => {
  const { now } = both(key, args, env);
  g.confere(key, now);
  return now;
};

describe("skill-release (CLI)", () => {
  const rd = `${r.T}/data`, dir = `${r.T}/guard-dir`, pk = `${r.T}/packs-guard/guard-proj`;
  mkdirSync(rd, { recursive: true }); mkdirSync(`${dir}/sub`, { recursive: true }); mkdirSync(pk, { recursive: true });
  writeFileSync(`${rd}/env.sh`, `W="${r.C}"\n`);
  const base = readJson(`${FX}/packs/example-monorepo/profile.json`);
  writeJson(`${pk}/profile.json`, { ...base, name: "guard-proj", identity: { repo: "acme/guard-proj", aliases: ["guard"], vocabulary: ["\\bms-[a-z]"] } });
  writeFileSync(`${dir}/a_GUARD_x.md`, "banco guard_x e GUARD_URL\n"); writeFileSync(`${dir}/sub/v.md`, `sobe o ${"ms" + "-svc"}\n`); writeFileSync(`${dir}/limpo.md`, "limpo\n");

  test("guard: reprova e lista (strict), só avisa em report", () => {
    const env = { HADES_PACKS_ROOT: `${r.T}/packs-guard` };
    expect(same("guard strict", ["guard", dir], env).rc).toBe(1);
    expect(same("guard report", ["guard", dir], { ...env, HADES_NAME_GUARD: "report" }).rc).toBe(0);
  });
  test("guard: sem perfil instalado não há o que procurar", () => { expect(same("guard sem perfil", ["guard", dir], { HADES_PACKS_ROOT: `${r.T}/packs-vazio` }).rc).toBe(0); });
  test("sem ambiente instalado: recusa com a mesma mensagem", () => {
    const x = same("check sem ambiente", ["check"], { HADES_DATA: `${r.T}/inexistente` });
    expect(x.rc).toBe(2);
    expect(x.all).toContain("ambiente da Hades não encontrado");
  });
  test("sem argumento: uso e saída 2 (a primeira linha é a mesma)", () => {
    const { old, now } = both("sem argumento", [], { HADES_DATA: rd });
    expect(now.rc).toBe(2); expect(old.rc).toBe(2);
    expect(now.all.split("\n")[0]).toBe(old.all.split("\n")[0]);
  });
  test("drift: o kit inteiro 'só em' sem nada instalado, e 'editado' depois de mexer em um arquivo", () => {
    const env = { HADES_DATA: rd, HADES_WT: r.C, HADES_PACKS_ROOT: `${r.T}/packs-vazio` };
    const a = same("drift", ["drift"], env);
    expect(a.rc).toBe(1);
    expect(a.all).toContain("drift:");
  });
  test("release: nível inválido, sem resumo e opção desconhecida são recusados do mesmo jeito", () => {
    const env = { HADES_DATA: rd, HADES_WT: r.C, HADES_PACKS_ROOT: `${r.T}/packs-vazio` };
    for (const args of [["release", "bogus", "x"], ["release"], ["release", "minor"], ["release", "same", "--bad"]]) expect(same(`release ${args.join(" ")}`, args, env).rc).toBe(2);
  });
});
