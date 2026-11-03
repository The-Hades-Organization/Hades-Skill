// Grupo neutro: guarda de domínio — vocabulário do pacote (domainTerms), nunca do núcleo; @allow é dívida declarada.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { FX, Rig, SKILL, readJson, writeJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

describe("neutro", () => {
  const pk = `${r.T}/packs-neutro/neutro-proj`, sujo = `${r.T}/neutro-sujo`, limpo = `${r.T}/neutro-limpo`, legado = `${r.T}/neutro-legado`;
  for (const d of [pk, `${sujo}/ref`, `${limpo}/ref`, `${legado}/antigo`]) mkdirSync(d, { recursive: true });
  const fx = readJson(`${FX}/packs/example-monorepo/profile.json`);
  writeJson(`${pk}/profile.json`, { ...fx, name: "neutro-proj", identity: { repo: "acme/neutro-proj" }, domainTerms: "domain-terms.txt" });
  writeFileSync(`${pk}/domain-terms.txt`, "# vocabulário do projeto de teste\n\nflux-capacitor\n\\bwidget-[0-9]+\n@allow antigo/*\n");
  writeFileSync(`${sujo}/ref/guia.md`, "ligue o Flux-Capacitor antes de subir\n"); writeFileSync(`${sujo}/outro.md`, "o widget-42 do ambiente\n");
  writeFileSync(`${limpo}/ref/guia.md`, "texto genérico: simule, configure e suba o ambiente do projeto\n");
  writeFileSync(`${legado}/antigo/painel.md`, "dívida: ainda cita o flux-capacitor\n");
  const guard = (dir: string, env: Record<string, string> = {}, root = `${r.T}/packs-neutro`) =>
    r.X(["bash", `${SKILL}/kit/skill-release.sh`, "guard", dir], { merge: true, env: { HADES_PACKS_ROOT: root, ...env } });

  test("núcleo que cita o termo é acusado em strict", () => {
    const g = guard(sujo);
    expect(g.rc !== 0 && g.out.includes("guarda de domínio (strict): 2 arquivo(s), 2 linha(s)") && g.out.includes("ref/guia.md") && g.out.includes("outro.md"), `rc=${g.rc}`).toBe(true);
  });
  test("report lista e não reprova", () => {
    const g = guard(sujo, { HADES_DOMAIN_GUARD: "report" });
    expect(g.rc === 0 && g.out.includes("guarda de domínio (report)"), `rc=${g.rc}`).toBe(true);
  });
  test("núcleo que não cita o termo fica limpo", () => {
    const g = guard(limpo);
    expect(g.rc === 0 && g.out.includes("núcleo sem vocabulário de domínio"), `rc=${g.rc}`).toBe(true);
  });
  test("@allow tira o arquivo declarado da contagem", () => {
    const g = guard(legado);
    expect(g.rc === 0 && g.out.includes("núcleo sem vocabulário de domínio"), `rc=${g.rc}`).toBe(true);
  });
  test("o modo do domínio é independente do modo do nome", () => {
    expect(guard(limpo, { HADES_DOMAIN_GUARD: "report", HADES_NAME_GUARD: "strict" }).rc).toBe(0);
  });
  test("perfil com domainTerms válido", () => {
    const v = r.hades(["project", "validate", `${pk}/profile.json`], { merge: true, env: { HADES_PACKS_ROOT: `${r.T}/packs-neutro` } });
    expect(v.out.includes("ok  ") && !v.out.includes("✗"), v.out).toBe(true);
  });
  test("domainTerms que não é arquivo do pacote é recusado", () => {
    const bad = readJson(`${pk}/profile.json`); bad.domainTerms = "falta.txt"; writeJson(`${pk}/ruim.json`, bad);
    const v = r.hades(["project", "validate", `${pk}/ruim.json`], { merge: true, env: { HADES_PACKS_ROOT: `${r.T}/packs-neutro` } });
    expect(v.out.includes("domainTerms") && v.out.includes("não é arquivo do pacote")).toBe(true);
  });
  test("sem domainTerms em nenhum perfil a guarda passa em silêncio", () => {
    mkdirSync(`${r.T}/packs-neutro-sem/p`, { recursive: true });
    const p: Record<string, unknown> = { ...fx, name: "p", identity: { repo: "acme/p" } }; delete p.domainTerms;
    writeJson(`${r.T}/packs-neutro-sem/p/profile.json`, p);
    const g = guard(sujo, {}, `${r.T}/packs-neutro-sem`);
    expect(g.rc === 0 && !g.out.includes("domínio"), `rc=${g.rc}`).toBe(true);
  });
});
