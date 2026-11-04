// Grupo minos-comando: `hades minos` de ponta a ponta com dados e HOME do rig (nunca o ambiente real, nunca rede).
// O ponto central: a guarda roda antes de qualquer saída; recusado, nada fica em $D/minos.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { BUN, Rig, SKILL, kv } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

const D = `${r.T}/dados`;
const MINOS = `${D}/minos`;
const PLANO = `${r.T}/plano-exemplo.md`;
const SAIDA = "orquestracao-plano-exemplo";
const URL_ARTIFACT = "https://claude.ai/artifact/abc123";
// montados em partes: este arquivo não casa com a varredura de segredos do release
const TOKEN_FICTICIO = `${"gh"}p_${"a1B2".repeat(9)}`;
const VALOR_COFRE = `${"cofre"}-${"x9Y8".repeat(4)}`;

const PLANO_BASE = `# Plano — Entrega de exemplo

## Estado atual
- **Unidades:** api — trabalhando

## Objetivo
Acompanhar a entrega.

## Unidades
| Unidade | Card | Papel | Modelo/esforço | Base | Depende de | Specs |
|---|---|---|---|---|---|---|
| api | novo | impl | x | main | — | S1 |
`;

// o segredo precisa cair num campo que o modelo publica (o objetivo), senão a guarda não tem o que ver
const comObjetivo = (texto: string): string => PLANO_BASE.replace("Acompanhar a entrega.", texto);

const minos = (args: string[], e: Record<string, string> = {}) =>
  r.X([BUN, `${SKILL}/src/cli.ts`, "minos", ...args], { merge: true, cwd: r.C, env: kv({ HADES_DATA: D, HADES_WT: r.C, NO_COLOR: "1", HADES_MINOS_TEAM: "0" }, e) });
const gravados = (): string[] => (existsSync(MINOS) ? Bun.spawnSync(["find", MINOS, "-type", "f"]).stdout.toString().split("\n").filter(Boolean) : []);

beforeEach(() => {
  rmSync(MINOS, { recursive: true, force: true });
  rmSync(`${D}/credenciais.md`, { force: true });
  mkdirSync(D, { recursive: true });
  writeFileSync(PLANO, PLANO_BASE);
});

describe("hades minos publish: guarda antes de gerar", () => {
  test("dado dado plano com credencial fictícia, quando publica, então recusa com rc=1 e não grava nada", () => {
    writeFileSync(PLANO, comObjetivo(`Token de teste: ${TOKEN_FICTICIO}`));
    const a = minos(["publish", "orquestracao", PLANO]);
    expect(a.rc, a.out).toBe(1);
    expect(a.out).toContain("o Cerberus barrou");
    expect(a.out).not.toContain(TOKEN_FICTICIO);
    expect(gravados()).toEqual([]);
  });

  test("dado plano com valor do credenciais.md, quando publica, então recusa e não grava nada", () => {
    writeFileSync(`${D}/credenciais.md`, `COFRE_CHAVE=${VALOR_COFRE}\n`);
    writeFileSync(PLANO, comObjetivo(`Token de teste: ${VALOR_COFRE}`));
    const a = minos(["publish", "orquestracao", PLANO]);
    expect(a.rc, a.out).toBe(1);
    expect(a.out).toContain("credenciais.md");
    expect(a.out).not.toContain(VALOR_COFRE);
    expect(gravados()).toEqual([]);
  });

  test("dado credencial fictícia e --html, quando publica, então o arquivo offline também não é gerado", () => {
    writeFileSync(PLANO, comObjetivo(`Token de teste: ${TOKEN_FICTICIO}`));
    const saida = `${r.T}/offline.html`;
    const a = minos(["publish", "orquestracao", PLANO, "--html", saida]);
    expect(a.rc, a.out).toBe(1);
    expect(existsSync(saida)).toBe(false);
  });
});

describe("hades minos publish: página do time", () => {
  test("dado HADES_MINOS_TEAM=0, quando pede --team, então recusa e não grava nada", () => {
    const a = minos(["publish", "orquestracao", PLANO, "--team"]);
    expect(a.rc, a.out).toBe(1);
    expect(a.out).toContain("HADES_MINOS_TEAM=0");
    expect(gravados()).toEqual([]);
  });

  test("dado HADES_MINOS_TEAM=1, quando pede --team, então grava a saída do time", () => {
    const a = minos(["publish", "orquestracao", PLANO, "--team"], { HADES_MINOS_TEAM: "1" });
    expect(a.rc, a.out).toBe(0);
    expect(a.out).toContain("publique:");
    expect(existsSync(`${MINOS}/${SAIDA}-team/index.html`)).toBe(true);
  });
});

describe("hades minos publish: saída, link e abertura", () => {
  test("dado --html, quando publica, então grava a página autocontida e nenhum registro", () => {
    const saida = `${r.T}/offline.html`;
    const a = minos(["publish", "orquestracao", PLANO, "--html", saida]);
    expect(a.rc, a.out).toBe(0);
    const html = readFileSync(saida, "utf8");
    expect(html).toContain("Entrega de exemplo");
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=["']https?:/i);
    expect(gravados()).toEqual([]);
  });

  test("dado link registrado, quando publica de novo, então devolve o mesmo link", () => {
    const p = minos(["publish", "orquestracao", PLANO]); expect(p.rc, p.out).toBe(0);
    const ligado = minos(["link", SAIDA, URL_ARTIFACT]);
    expect(ligado.rc, ligado.out).toBe(0);
    const b = minos(["publish", "orquestracao", PLANO]);
    expect(b.rc, b.out).toBe(0);
    expect(b.out).toContain(`link registrado: ${URL_ARTIFACT}`);
  });

  test("dado host fora do claude.ai, quando grava o link, então recusa", () => {
    const p = minos(["publish", "orquestracao", PLANO]); expect(p.rc, p.out).toBe(0);
    const a = minos(["link", SAIDA, "https://exemplo.invalid/artifact/abc123"]);
    expect(a.rc).not.toBe(0);
    expect(minos(["list"]).out).toContain("sem link");
  });

  test("dado saída com link, quando abre com --print, então mostra o link sem abrir nada", () => {
    const p = minos(["publish", "orquestracao", PLANO]); expect(p.rc, p.out).toBe(0);
    expect(minos(["link", SAIDA, URL_ARTIFACT]).rc).toBe(0);
    const a = minos(["open", SAIDA, "--print"]);
    expect(a.rc, a.out).toBe(0);
    expect(a.out.trim()).toBe(URL_ARTIFACT);
  });

  test("dado saída inexistente, quando abre, então recusa", () => {
    expect(minos(["open", "orquestracao-nao-existe", "--print"]).rc).not.toBe(0);
  });
});
