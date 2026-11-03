// Grupo guard: guarda de nome do skill-release.sh — acha o termo em qualquer posição e sem caixa (foo_GUARD_x, WEB_GUARD_URL)
// e o vocabulário (ERE) do perfil; a slug do repo da skill é isenta.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { FX, Rig, SKILL, checkText, readJson, writeJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("guard", () => {
  const pk = `${r.T}/packs-guard/guard-proj`, dir = `${r.T}/guard-dir`;
  mkdirSync(pk, { recursive: true }); mkdirSync(`${dir}/sub`, { recursive: true });
  const base = readJson(`${FX}/packs/example-monorepo/profile.json`);
  const guard = (env: Record<string, string> = {}) => r.X(["bash", `${SKILL}/kit/skill-release.sh`, "guard", dir], { merge: true, env: { HADES_PACKS_ROOT: `${r.T}/packs-guard`, ...env } });

  test("guard.txt", () => {
    writeJson(`${pk}/profile.json`, { ...base, name: "guard-proj", identity: { repo: "acme/guard-proj", aliases: ["guard"], vocabulary: ["\\bms-[a-z]", "sim-tool"] } });
    writeFileSync(`${dir}/foo_GUARD_x.md`, "banco guard_x e GUARD_URL\n"); writeFileSync(`${dir}/sub/conf.txt`, "WEB_GUARD_URL=1\n");
    writeFileSync(`${dir}/sub/vocab.md`, `sobe o ${"ms" + "-svc"} e o sim-tool\n`); writeFileSync(`${dir}/limpo.md`, "texto limpo, sem nada do projeto\n");
    const strict = guard();
    const rep = guard({ HADES_NAME_GUARD: "report" });
    rmSync(`${dir}/sub`, { recursive: true }); rmSync(`${dir}/foo_GUARD_x.md`);
    const limpa = guard();
    const out = `$ guard strict\n${strict.all}rc=${strict.rc}\n$ guard report\n${rep.all.split("\n")[0]}\nrc=${rep.rc}\n$ pasta limpa\n${limpa.all}rc=${limpa.rc}\n`;
    checkText("guard.txt", r.norm(out));
  });

  test("guarda de nome: a slug do repo da skill passa", () => {
    writeJson(`${pk}/profile.json`, { ...base, name: "guard-proj", identity: { repo: "acme/guard-proj", aliases: ["guard"] } });
    mkdirSync(`${dir}/kit`, { recursive: true });
    writeFileSync(`${dir}/kit/config.tsv`, "HADES_VERSION_CHECK_REPO\tacme/skill-repo\trepo\tPainel\tRepo\tnext\tdesc\n");
    writeFileSync(`${dir}/slug.md`, "padrão acme/skill-repo no catálogo\n");
    const g = guard();
    expect(`${g.rc} ${g.all.replace(/\n+$/, "")}`).toBe("0 guarda de nome: núcleo sem nome de projeto");
  });

  test("guarda de nome: outro nome do perfil ainda reprova (linha sem a slug)", () => {
    writeFileSync(`${dir}/misto.md`, "veja acme/guard-proj e acme/skill-repo\n"); writeFileSync(`${dir}/outro.md`, "sobe o guard-proj\n");
    const g = guard();
    const lines = g.all.replace(/\n+$/, "").split("\n");
    const cited = lines.filter((l) => l.includes("citam projeto")).length;
    const names = lines.filter((l) => l.startsWith("  ")).map((l) => l.trim().split(/\s+/)[0]).join("\n");
    expect(`${g.rc} ${cited} ${names}`).toBe("1 1 outro.md");
  });

  test("guarda de nome: fixture em test/ que cita o projeto reprova; a que não cita passa", () => {
    const t = `${r.T}/guard-test-dir`;
    mkdirSync(`${t}/loop/test/fixtures`, { recursive: true });
    writeFileSync(`${t}/loop/test/fixtures/limpa.json`, "{}\n");
    const limpa = r.X(["bash", `${SKILL}/kit/skill-release.sh`, "guard", t], { merge: true, env: { HADES_PACKS_ROOT: `${r.T}/packs-guard` } });
    writeFileSync(`${t}/loop/test/fixtures/cita.json`, "{\"project\": \"guard-proj\"}\n");
    const cita = r.X(["bash", `${SKILL}/kit/skill-release.sh`, "guard", t], { merge: true, env: { HADES_PACKS_ROOT: `${r.T}/packs-guard` } });
    expect(`${limpa.rc} ${cita.rc} ${cita.all.includes("loop/test/fixtures/cita.json")}`).toBe("0 1 true");
  });

  describe("repositório proibido (HADES_FORBIDDEN_REPOS)", () => {
    const d = `${r.T}/guard-repos`;
    mkdirSync(`${d}/docs`, { recursive: true });
    const run = (env: Record<string, string>) => r.X(["bash", `${SKILL}/kit/skill-release.sh`, "guard", d], { merge: true, env: { HADES_PACKS_ROOT: `${r.T}/packs-vazio`, ...env } });
    const files = (all: string) => all.split("\n").filter((l) => l.startsWith("  ")).map((l) => l.trim().split(/\s+/)[0]).sort().join(",");

    test("sem lista: passa e a saída não muda", () => {
      writeFileSync(`${d}/docs/a.md`, "veja https://github.com/acme/privado\n");
      const g = run({ HADES_FORBIDDEN_REPOS: "" });
      expect(`${g.rc} ${g.all.includes("proibido")}`).toBe("0 false");
    });
    test("link, ssh e gh api ao repositório da lista reprovam, sem diferenciar caixa", () => {
      writeFileSync(`${d}/docs/b.md`, "git clone git@github.com:ACME/Privado.git\n");
      writeFileSync(`${d}/docs/c.sh`, "gh api repos/acme/privado/contents/VERSION\n");
      const g = run({ HADES_FORBIDDEN_REPOS: "acme/privado" });
      expect(`${g.rc} ${files(g.all)}`).toBe("1 docs/a.md,docs/b.md,docs/c.sh");
    });
    test("só o nome inteiro: acme/privado-publico e acme/privadoX não pegam", () => {
      rmSync(`${d}/docs`, { recursive: true }); mkdirSync(`${d}/docs`, { recursive: true });
      writeFileSync(`${d}/docs/ok.md`, "https://github.com/acme/privado-publico e github.com/acme/privadoX\n");
      const g = run({ HADES_FORBIDDEN_REPOS: "acme/privado" });
      expect(`${g.rc} ${g.all.includes("proibido")}`).toBe("0 true");
    });
    test("vários repositórios na lista (vírgula e espaço)", () => {
      writeFileSync(`${d}/docs/z.md`, "github.com/acme/outro.git\n");
      const g = run({ HADES_FORBIDDEN_REPOS: "acme/privado, acme/outro.git" });
      expect(`${g.rc} ${files(g.all)}`).toBe("1 docs/z.md");
    });
    test("o ponto do nome não é curinga: acme/outroXgit não pega", () => {
      rmSync(`${d}/docs/z.md`); writeFileSync(`${d}/docs/w.md`, "github.com/acme/outroXgit\n");
      const g = run({ HADES_FORBIDDEN_REPOS: "acme/outro.git" });
      expect(g.rc).toBe(0);
    });
    test("item fora do formato dono/nome reprova a guarda (não vira busca silenciosa)", () => {
      const g = run({ HADES_FORBIDDEN_REPOS: "so-um-nome" });
      expect(`${g.rc} ${g.all.includes("HADES_FORBIDDEN_REPOS fora do formato dono/nome: 1 item(ns)")}`).toBe("1 true");
    });
  });
});
