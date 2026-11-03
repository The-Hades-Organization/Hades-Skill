// Moirai: regra pura da estimativa (mediana e quartis, amostra pequena, raiz de fixture, plano sem tabela) e a seção
// `## Estimativa`; a borda é provada pelo estimador `--deep` com runner injetado.
import { describe, expect, test } from "bun:test";
import { deepHints, parseDeepAnswer } from "../../../src/commands/moirai";
import { planSha } from "../../../src/commands/agent";
import {
  bandOf, declaredLines, estimatePlan, estimateUnit, gateOfLabel, hasSection, historyUnit, isRealUnit, parseSection, planUnits, quantile,
  renderSection, spread, writeSection, type HistoryUnit, type Params,
} from "../../../src/lib/moirai";

const params: Params = { minSample: 5, highFactor: 3, smallLines: 150, largeLines: 600 };
const none = { costUsd: null, tokens: null, gateS: 0, gatePeakMb: null, files: null, lines: null };

function unit(over: Partial<HistoryUnit>): HistoryUnit {
  return {
    name: "u", root: "r", mode: "skill", role: "impl", state: "done", createdAt: "2026-10-01T00:00:00Z", doneAt: "2026-10-01T01:00:00Z",
    costUsd: 1, tokens: 1000, wallS: 3600, gateS: 0, gatePeakMb: null, clears: 0, resumes: null, files: null, lines: null, band: null, ...over,
  };
}
const many = (n: number, over: (i: number) => Partial<HistoryUnit>): HistoryUnit[] => Array.from({ length: n }, (_, i) => unit({ name: `u${i}`, ...over(i) }));

describe("estatística", () => {
  test("dado 1..5, então mediana 3, p25 2 e p75 4", () => {
    expect(spread([5, 1, 3, 2, 4])).toEqual({ n: 5, p25: 2, median: 3, p75: 4 });
  });
  test("dado número par, então o quantil interpola entre os vizinhos", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
  });
  test("dado um valor só, então os três quantis são ele; vazio e nulos não geram faixa", () => {
    expect(spread([7])).toEqual({ n: 1, p25: 7, median: 7, p75: 7 });
    expect(spread([])).toBeNull();
    expect(spread([null, null])).toBeNull();
  });
});

describe("tamanho declarado", () => {
  test("dado o escopo, então linhas valem direto e arquivos valem 60 linhas cada", () => {
    expect(declaredLines("mexe em ~300 linhas")).toBe(300);
    expect(declaredLines("uns 5 arquivos")).toBe(300);
    expect(declaredLines("sem número")).toBeNull();
  });
  test("dado o limite, então 149 é pequena, 150 média, 600 grande", () => {
    expect(bandOf(149, params)).toBe("pequena");
    expect(bandOf(150, params)).toBe("media");
    expect(bandOf(600, params)).toBe("grande");
  });
});

describe("raiz real × fixture", () => {
  test("dado registro encerrado sem transcript nem worktree, então é fixture e não entra", () => {
    expect(isRealUnit({ name: "x", state: "done" }, false, false)).toBe(false);
  });
  test("dado transcript ou worktree, então entra; em andamento nunca entra", () => {
    expect(isRealUnit({ name: "x", state: "archived" }, true, false)).toBe(true);
    expect(isRealUnit({ name: "x", state: "done" }, false, true)).toBe(true);
    expect(isRealUnit({ name: "x", state: "working" }, true, true)).toBe(false);
  });
  test("dado registro de skill, então relógio vai de createdAt a doneAt e o modo é skill", () => {
    const h = historyUnit({ name: "a", mode: "skill", role: "impl", state: "done", createdAt: "2026-10-01T00:00:00Z", doneAt: "2026-10-01T00:30:00Z", clears: 2 }, "_skill", { ...none, lines: 200 }, params);
    expect([h.mode, h.wallS, h.clears, h.band, h.resumes]).toEqual(["skill", 1800, 2, "media", null]);
  });
});

describe("gate do histórico", () => {
  const line = (label: string, dur: number, peak: number): string => `2026-10-01T00:00:00Z\tdone\ttest\t${label}\t4\t/wt\trc=0\tdur=${dur}s\tpeak=${peak}MB\tcmd=x`;
  test("dado execuções do label em dois históricos, então soma o tempo, pega o maior pico e ignora linha repetida", () => {
    const a = `${line("u", 60, 100)}\n${line("outro", 999, 9999)}\n`;
    const b = `${line("u", 120, 300)}\n${line("u", 60, 100)}\n`;
    expect(gateOfLabel([a, b], "u")).toEqual({ gateS: 180, peakMb: 300 });
  });
  test("dado label que nunca passou pelo gate, então zero e sem pico", () => {
    expect(gateOfLabel(["x\tdone\tt\tz\t1\t/w\trc=0\tdur=5s\n"], "u")).toEqual({ gateS: 0, peakMb: null });
  });
});

describe("estimativa por unidade", () => {
  test("dado 7 parecidas, então mediana e faixa vêm delas e a confiança é média (sem tamanho declarado)", () => {
    const history = many(7, (i) => ({ costUsd: i + 1, wallS: (i + 1) * 600 }));
    const e = estimateUnit({ name: "n", role: "impl", scope: "sem número" }, "skill", history, params);
    expect([e.basis, e.sample, e.confidence]).toEqual(["parecidas", 7, "media"]);
    expect(e.costUsd).toMatchObject({ p25: 2.5, median: 4, p75: 5.5 });
    expect(e.wallMin?.median).toBe(40);
  });
  test("dado tamanho declarado e 15 parecidas da mesma faixa, então a confiança é alta", () => {
    const history = many(15, () => ({ lines: 300, band: "media" as const }));
    expect(estimateUnit({ name: "n", role: "impl", scope: "~300 linhas" }, "skill", history, params).confidence).toBe("alta");
  });
  test("dado papel e modo diferentes, então as unidades não são parecidas", () => {
    const history = many(9, () => ({ role: "spec", mode: "projeto" as const }));
    expect(estimateUnit({ name: "n", role: "impl", scope: "" }, "skill", history, params).basis).toBe("geral");
  });
  test("dado menos de 5 parecidas e tamanho declarado, então cai para a regra só de tamanho com confiança baixa", () => {
    const sized = many(6, (i) => ({ role: "spec", costUsd: 10, lines: 100, wallS: 600, band: "pequena" as const, name: `s${i}` }));
    const e = estimateUnit({ name: "n", role: "impl", scope: "~200 linhas" }, "skill", [...sized, unit({ lines: 100, costUsd: 10 })], params);
    expect([e.basis, e.confidence]).toEqual(["tamanho", "baixa"]);
    expect(e.costUsd?.median).toBe(20);
    expect(e.note).toContain("só 0 parecidas");
  });
  test("dado exatamente 4 parecidas, então ainda é baixa; com 5, deixa de ser", () => {
    const four = many(4, () => ({}));
    expect(estimateUnit({ name: "n", role: "impl", scope: "" }, "skill", four, params).confidence).toBe("baixa");
    expect(estimateUnit({ name: "n", role: "impl", scope: "" }, "skill", many(5, () => ({})), params).confidence).toBe("media");
  });
  test("dado menos de 5 parecidas e escopo sem tamanho, então usa a mediana geral e avisa", () => {
    const e = estimateUnit({ name: "n", role: "impl", scope: "" }, "skill", many(3, () => ({})), params);
    expect([e.basis, e.confidence]).toEqual(["geral", "baixa"]);
    expect(e.note).toContain("sem tamanho declarado");
  });
  test("dado histórico vazio, então sem estimativa e confiança nenhuma", () => {
    const e = estimateUnit({ name: "n", role: "impl", scope: "~10 linhas" }, "skill", [], params);
    expect([e.basis, e.confidence, e.costUsd]).toEqual(["sem-historico", "nenhuma", null]);
  });
  test("dado tempo de gate zero em todas, então o gate não vira mediana zero", () => {
    expect(estimateUnit({ name: "n", role: "impl", scope: "" }, "skill", many(6, () => ({ gateS: 0 })), params).gateMin).toBeNull();
  });
  test("dado dica do --deep e escopo sem tamanho, então a faixa de tamanho vem da dica", () => {
    const history = many(6, () => ({ lines: 700, band: "grande" as const }));
    const [e] = estimatePlan([{ name: "n", role: "impl", scope: "" }], "skill", history, params, new Map([["n", 800]]));
    expect([e?.band, e?.basis]).toEqual(["grande", "parecidas"]);
  });
});

const PLAN = `# Plano

## Estado atual
- tudo certo

## Unidades
| Unidade | Papel | Base | Escopo |
|---|---|---|---|
| \`alfa\` | impl | main | mexe em ~300 linhas com \`a | b\` |
| beta | spec | alfa | 5 arquivos |

## Riscos
nenhum
`;

describe("plano", () => {
  test("dado a tabela, então lê unidade, papel e escopo (barra dentro do escopo fica com ele)", () => {
    expect(planUnits(PLAN)).toEqual([
      { name: "alfa", role: "impl", scope: "mexe em ~300 linhas com `a|b`" },
      { name: "beta", role: "spec", scope: "5 arquivos" },
    ]);
  });
  test("dado plano sem tabela de unidades, então nenhuma unidade", () => {
    expect(planUnits("# Plano\n\n## Objetivo\ntexto\n")).toEqual([]);
  });
  test("dado a tabela do modelo (coluna Specs e Card), então a unidade vem pelo cabeçalho", () => {
    const text = "## Unidades\n| Unidade | Card | Papel | Modelo/esforço | Base | Depende de | Specs |\n|---|---|---|---|---|---|---|\n| x | novo | impl | — | main | — | A, B |\n";
    expect(planUnits(text)).toEqual([{ name: "x", role: "impl", scope: "A, B" }]);
  });
  test("dado bloco de código com tabela falsa, então é ignorado", () => {
    expect(planUnits("```\n## Unidades\n| Unidade | Papel |\n|---|---|\n| x | impl |\n```\n")).toEqual([]);
  });
});

describe("seção ## Estimativa", () => {
  const history = many(6, (i) => ({ costUsd: i + 1, wallS: 600, lines: 300, band: "media" as const }));
  const estimates = estimatePlan(planUnits(PLAN), "skill", history, params);
  const section = renderSection({ date: "2026-10-28", estimates, historySize: 6, windowDays: 90, params });

  test("dado a estimativa, então a seção é gravada no fim e o resto do plano fica igual", () => {
    const written = writeSection(PLAN, section);
    expect(written.startsWith(PLAN.trimEnd())).toBe(true);
    expect(hasSection(PLAN)).toBe(false);
    expect(hasSection(written)).toBe(true);
  });
  test("dado plano que já tem a seção no meio, então ela é trocada e a seguinte fica", () => {
    const first = writeSection(PLAN.replace("## Riscos", `${section}\n## Riscos`), section.replace("2026-10-28", "2026-11-01"));
    expect(first).toContain("2026-11-01");
    expect(first).not.toContain("2026-10-28");
    expect(first).toContain("## Riscos\nnenhum");
    expect(first.match(/^## Estimativa$/gm)?.length).toBe(1);
  });
  test("dado gravar duas vezes igual, então é idempotente", () => {
    const once = writeSection(PLAN, section);
    expect(writeSection(once, section)).toBe(once);
  });
  test("dado a seção gravada, então ela entra no hash da aprovação e o Estado atual segue fora", () => {
    const written = writeSection(PLAN, section);
    expect(planSha(written)).not.toBe(planSha(PLAN));
    expect(planSha(written.replace("tudo certo", "outra coisa"))).toBe(planSha(written));
  });
  test("dado confiança baixa, então o aviso está no texto da seção, não só no JSON", () => {
    const low = estimatePlan(planUnits(PLAN), "skill", many(2, () => ({})), params);
    expect(renderSection({ date: "d", estimates: low, historySize: 2, windowDays: 0, params })).toContain("**Confiança baixa** em `alfa`");
  });
  test("dado a seção gravada, então parseSection devolve os números de volta", () => {
    const [alfa] = parseSection(writeSection(PLAN, section));
    expect(alfa).toMatchObject({ unit: "alfa", costMedian: 3.5, sample: 6, basis: "parecidas" });
    expect(alfa?.costP75).toBeGreaterThan(alfa?.costP25 ?? 99);
  });
});

describe("--deep", () => {
  test("dado resposta com JSON, então extrai as linhas; lixo, zero e absurdo são descartados", () => {
    expect(parseDeepAnswer('ok {"lines": 420}')).toBe(420);
    expect(parseDeepAnswer("sem json")).toBeNull();
    expect(parseDeepAnswer('{"lines": 0}')).toBeNull();
    expect(parseDeepAnswer('{"lines": 99999999}')).toBeNull();
  });
  test("dado um runner, então só as unidades com resposta utilizável ganham dica", () => {
    const hints = deepHints([{ name: "a", role: "impl", scope: "x" }, { name: "b", role: "impl", scope: "y" }], (p) => (p.includes("Unidade: a") ? '{"lines": 90}' : null));
    expect([...hints]).toEqual([["a", 90]]);
  });
});
