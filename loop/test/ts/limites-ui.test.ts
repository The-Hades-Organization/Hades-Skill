// Limites de uso, parte de tela e aviso (reference/limites.md §Painel, aviso e orquestrador): formatação do painel com e
// sem amostra, limiar do watch (uma vez por janela e por renovação), coleta ligada e o item do doctor.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { limitesItem } from "../../../src/commands/doctor";
import type { Atual } from "../../../src/lib/limites";
import { coletaLigada, janelasParaAvisar, linhaDeLimite, painelDeLimites, statusLineColeta, type Limiares } from "../../../src/lib/limites-aviso";
import { BUN, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

const NOW = new Date("2026-11-01T12:00:00Z");
const S = NOW.getTime() / 1000;
const atual = (pct: number, resetsAt: number, lidoHa = 30): Atual => ({ pct, resetsAt, at: new Date((S - lidoHa) * 1000).toISOString() });
const LIM: Limiares = { five: 80, seven: 90 };

describe("painel de limites", () => {
  test("dado as duas janelas, então traz % arredondado a 0,1, renovação em UTC e idade da amostra", () => {
    const p = painelDeLimites({ five: atual(23.46, S + 3600, 90), seven: atual(41, S + 4 * 86_400) }, NOW);
    expect(p.coleta).toBe(true);
    expect(p.janelas.map((j) => [j.janela, j.pct, j.renova, j.idadeS])).toEqual([
      ["five", 23.5, "13:00Z", 90],
      ["seven", 41, "11-05 12:00Z", 30],
    ]);
  });
  test("dado uma janela só, então a outra não aparece", () => {
    expect(painelDeLimites({ seven: atual(5, S + 86_400) }, NOW).janelas.map((j) => j.janela)).toEqual(["seven"]);
  });
  test("dado nenhuma amostra, então coleta falsa e nenhum número", () => {
    expect(painelDeLimites({}, NOW)).toEqual({ coleta: false, janelas: [] });
  });
  test("dado leitura com horário no futuro, então a idade não fica negativa", () => {
    expect(painelDeLimites({ five: atual(1, S + 60, -500) }, NOW).janelas[0]?.idadeS).toBe(0);
  });
});

describe("limiar do aviso", () => {
  const renova = S + 3600;
  test("dado % abaixo do limiar, então nada sai", () => {
    expect(janelasParaAvisar({ five: atual(79.9, renova) }, LIM, {})).toEqual([]);
  });
  test("dado % no limiar e janela nunca avisada, então sai com % inteiro e renovação", () => {
    const [a] = janelasParaAvisar({ five: atual(80, renova) }, LIM, {});
    expect(a && linhaDeLimite(a)).toBe("LIMITE 5h 80 renova 13:00Z");
  });
  test("dado a janela já avisada nesta renovação, então não repete (nem com a renovação variando segundos)", () => {
    expect(janelasParaAvisar({ five: atual(95, renova + 30) }, LIM, { five: renova })).toEqual([]);
  });
  test("dado a janela renovada e acima do limiar de novo, então avisa outra vez", () => {
    expect(janelasParaAvisar({ five: atual(85, renova + 5 * 3600) }, LIM, { five: renova })).toHaveLength(1);
  });
  test("dado cada janela com o seu limiar, então a semanal só avisa a partir do dela", () => {
    const avisos = janelasParaAvisar({ five: atual(85, renova), seven: atual(85, renova + 86_400) }, LIM, {});
    expect(avisos.map((a) => a.janela)).toEqual(["five"]);
  });
});

describe("coleta ligada e doctor", () => {
  const settings = (command: string) => JSON.stringify({ statusLine: { type: "command", command } });
  test.each([
    ["comando direto", settings("hades usage sample"), true],
    ["encadeado com tee", settings("tee >(hades usage sample --quiet >/dev/null) | ~/x.sh"), true],
    ["outro status line", settings("~/x.sh"), false],
    ["sem statusLine", "{}", false],
    ["json inválido", "{", false],
    ["arquivo ausente", undefined, false],
  ])("dado %s, então statusLineColeta é %p", (_n, text, esperado) => {
    expect(statusLineColeta(text)).toBe(esperado);
  });
  test("dado amostra aberta sem statusLine da Hades, então a coleta conta como ligada", () => {
    expect(coletaLigada("{}", 1)).toBe(true);
  });
  test("dado coleta desligada, então o doctor avisa (nível aviso) e explica como ligar", () => {
    const item = limitesItem("{}", 0);
    expect(item.level).toBe("warn");
    expect(item.fix).toContain("hades usage sample");
  });
  test("dado coleta ligada, então o item do doctor é ok", () => {
    expect(limitesItem(settings("hades usage sample"), 0).level).toBe("ok");
  });
});

describe("hades watch: LIMITE", () => {
  const home = `${r.T}/limui/home`;
  const amostras = `${home}/.claude/hades/limits/samples.jsonl`;
  mkdirSync(`${home}/.claude/hades/limits`, { recursive: true });
  const futuro = Math.floor(Date.now() / 1000) + 3600;
  const grava = (five: number, resetsAt: number) =>
    writeFileSync(amostras, `${JSON.stringify({ at: new Date().toISOString(), five: { pct: five, resetsAt } })}\n`);
  const watch = (state: string): string[] =>
    r.X(["timeout", "5", BUN, `${SKILL}/src/cli.ts`, "watch", "--all", "1"], { cwd: r.C, merge: true, env: { HOME: home, HADES_WATCH_STATE: state, HADES_HERDR_SESSION: "default" } })
      .out.split("\n").filter((l) => l.startsWith("LIMITE "));

  test("dado 83% da janela de 5 h, então emite uma vez e só reemite depois da renovação", () => {
    const state = `${r.T}/limui/st`;
    grava(83, futuro);
    expect(watch(state)).toHaveLength(1);
    expect(watch(state)).toEqual([]);
    grava(84, futuro + 5 * 3600);
    expect(watch(state)).toHaveLength(1);
  }, 40_000);
  test("dado % abaixo do limiar, então não emite", () => {
    grava(10, futuro);
    expect(watch(`${r.T}/limui/st-baixo`)).toEqual([]);
  }, 20_000);
});
