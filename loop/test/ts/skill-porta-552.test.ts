// 5.5.2: a faixa padrão de portas de teste das unidades da skill tem 20 portas e não toca o painel, o widget nem o túnel.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Rig, SKILL, readJson } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());
const S = `${r.T}/skill-pt`, orch = `${r.T}/work/_skill/orchestration/agents`;
const config = new Map(readFileSync(join(SKILL, "kit/config.tsv"), "utf8").split("\n").map((l) => l.split("\t")).filter((c) => c.length > 2).map((c) => [c[0] as string, c[1] as string]));
const chave = (nome: string) => Number(config.get(nome));

describe("faixa de portas de teste da skill", () => {
  test("o padrão do config.tsv cobre 20 portas, fora do painel e do widget", () => {
    const [min, max] = [chave("HADES_SKILL_PORT_MIN"), chave("HADES_SKILL_PORT_MAX")];
    expect(max - min + 1).toBe(20);
    for (const ocupada of [chave("HADES_PANEL_PORT"), chave("HADES_WIDGET_PORT")]) expect(ocupada < min || ocupada > max, `porta ${ocupada} dentro da faixa`).toBe(true);
  });

  test("a 20ª unidade ainda ganha porta, a 21ª falha (sem criar worktree)", () => {
    r.skillCopy(S);
    for (let i = 1; i <= 20; i++) expect(r.agentIn(S, ["skill-new", `pt${i}`]).rc, `skill-new pt${i}`).toBe(0);
    const portas = new Set(Array.from({ length: 20 }, (_, i) => String(readJson(`${orch}/pt${i + 1}.json`).port)));
    expect(portas.size, "20 portas distintas").toBe(20);
    const ultima = r.agentIn(S, ["skill-new", "pt21"]);
    expect(ultima.rc !== 0 && ultima.out.includes("faixa"), "faixa esgotada").toBe(true);
  }, 60_000);
});
