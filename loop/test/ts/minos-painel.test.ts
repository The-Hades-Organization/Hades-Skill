// Grupo minos-painel: o botão "Publicar" da página Orquestração (POST /api/orchestration/publish) sem subir o painel:
// gera a página offline do plano aprovado, avisa quando não há plano e recusa o que o Cerberus barra.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Rig } from "./lib/rig";
import { createOrchestration } from "../../../src/panel/orchestration";
import type { PanelEnv } from "../../../src/panel/env";

const r = new Rig();
afterAll(() => r.cleanup());

const DADOS = `${r.T}/dados`;
const ORCH = `${r.T}/trabalho/orchestration`;
const PLANO = `${r.T}/plano-painel.md`;
const PLANO_TEXTO = "# Plano — Entrega do painel\n\n## Objetivo\nAcompanhar.\n\n## Unidades\n| Unidade | Papel | Depende de |\n|---|---|---|\n| api | impl | — |\n";
// montado em partes: este arquivo não casa com a varredura de segredos do release
const TOKEN_FICTICIO = `${"gh"}p_${"a1B2".repeat(9)}`;

const painel = () => createOrchestration({ dir: DADOS, worktree: r.T, locks: `${r.T}/trabalho/locks` } as PanelEnv, () => ({}));
const aprova = (plano: string): void => {
  mkdirSync(ORCH, { recursive: true });
  writeFileSync(PLANO, plano);
  writeFileSync(`${ORCH}/plan.json`, JSON.stringify({ path: PLANO }));
};

describe("painel: publicar o acompanhamento", () => {
  test("dado nenhum plano aprovado, quando publica, então avisa sem erro e não gera arquivo", () => {
    const a = painel().publishPage();
    expect(a.ok).toBe(false);
    expect(String(a.message)).toContain("Sem plano aprovado");
    expect(existsSync(`${DADOS}/minos/offline/orquestracao.html`)).toBe(false);
  });

  test("dado plano aprovado, quando publica, então grava a página offline e devolve o comando de publicação", () => {
    aprova(PLANO_TEXTO);
    const a = painel().publishPage();
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect(a.command).toBe(`hades minos publish orquestracao ${PLANO}`);
    expect(readFileSync(String(a.file), "utf8")).toContain("Entrega do painel");
  });

  test("dado credencial no plano, quando publica, então o Cerberus recusa e diz o que barrou sem repetir o trecho", () => {
    aprova(PLANO_TEXTO.replace("Acompanhar.", `Token de teste: ${TOKEN_FICTICIO}`));
    const a = painel().publishPage();
    expect(a.ok).toBe(false);
    expect(a.guard).toBe(true);
    expect(JSON.stringify(a)).not.toContain(TOKEN_FICTICIO);
  });
});
