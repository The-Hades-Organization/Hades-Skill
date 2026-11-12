// Grupo minos-guarda-projeto: a página pessoal de explicação/proposta cita o projeto ativo sem ser barrada; o resto da
// guarda (outros perfis, time, credencial, orquestração) segue inteiro.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { EXPLICACAO_EXAMPLE, PROPOSTA_EXAMPLE } from "../../../src/lib/minos-doc";
import { BUN, Rig, SKILL, kv } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const D = `${r.T}/dados`;
const FONTE = `${r.T}/fonte.json`;
// o repo do clone de teste (r.C) é example/monorepo: é o projeto ativo; "outro-servico" é um segundo perfil instalado
const ATIVO = "example/monorepo";
const OUTRO = "acme/outro-servico";
const minos = (args: string[], cwd = r.C) =>
  r.X([BUN, `${SKILL}/src/cli.ts`, "minos", ...args], { merge: true, cwd, env: kv({ HADES_DATA: D, HADES_WT: r.C, NO_COLOR: "1", HADES_MINOS_TEAM: "1" }) });
const explicacao = (repo: string, over: Record<string, unknown> = {}) => JSON.stringify({ ...EXPLICACAO_EXAMPLE, source: { repo, ref: "main@abc1234", paths: ["apps/monorepo/"] }, ...over });

beforeEach(() => {
  rmSync(`${D}/minos`, { recursive: true, force: true });
  mkdirSync(D, { recursive: true });
  mkdirSync(`${r.T}/packs/outro-servico`, { recursive: true });
  writeFileSync(`${r.T}/packs/outro-servico/profile.json`, JSON.stringify({ schema: "hades.profile/1", name: "outro-servico", identity: { repo: OUTRO } }));
});

describe("minos: guarda de nome de projeto", () => {
  test("dada explicação pessoal que cita o projeto ativo, então a página sai", () => {
    writeFileSync(FONTE, explicacao(ATIVO));
    const a = minos(["publish", "explicacao", FONTE]);
    expect(a.rc, a.out).toBe(0);
  });

  test("dada proposta pessoal que cita o projeto ativo, então a página sai", () => {
    writeFileSync(FONTE, JSON.stringify({ ...PROPOSTA_EXAMPLE, source: { repo: ATIVO, ref: null, paths: [] } }));
    const a = minos(["publish", "proposta", FONTE]);
    expect(a.rc, a.out).toBe(0);
  });

  test("dado --html com o projeto ativo, então grava o arquivo local", () => {
    writeFileSync(FONTE, explicacao(ATIVO));
    const a = minos(["publish", "explicacao", FONTE, "--html", `${r.T}/saida.html`]);
    expect(a.rc, a.out).toBe(0);
  });

  test("dada explicação que cita outro perfil instalado, então o Cerberus barra", () => {
    writeFileSync(FONTE, explicacao(OUTRO));
    const a = minos(["publish", "explicacao", FONTE]);
    expect(a.rc, a.out).toBe(1);
    expect(a.out).toContain("nome de projeto");
  });

  test("dada a mesma página com --team, então o nome do projeto ativo segue barrado", () => {
    writeFileSync(FONTE, explicacao(ATIVO));
    const a = minos(["publish", "explicacao", FONTE, "--team"]);
    expect(a.rc, a.out).toBe(1);
    expect(a.out).toContain("nome de projeto");
  });

  test("dado cwd sem perfil ativo, então a página que cita o projeto continua barrada", () => {
    writeFileSync(FONTE, explicacao(ATIVO));
    const a = minos(["publish", "explicacao", FONTE], r.P);
    expect(a.rc, a.out).toBe(1);
  });

  test("dado projeto ativo citado junto de e-mail, então o e-mail segue barrado", () => {
    writeFileSync(FONTE, explicacao(ATIVO, { caveats: ["fale com fulano@empresa.com.br"] }));
    const a = minos(["publish", "explicacao", FONTE]);
    expect(a.rc, a.out).toBe(1);
    expect(a.out).toContain("e-mail");
  });
});
