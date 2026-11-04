// Limites de uso (reference/limites.md): amostra do JSON do status line, conversão tokens → % calibrada por amostras
// sintéticas, "sem calibração" e "cabe na janela". A borda (hades usage sample, colunas, moirai) roda no CLI com HOME falso.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  amostraDoStatusLine, amostrasDe, atuais, cabeNaJanela, calibra, intervalos, limitesDoPlano, mtok, pctDeTokens, pctDeUsd, textoPct, vale,
  type Amostra, type Opcoes,
} from "../../../src/lib/limites";
import type { Req } from "../../../src/lib/usage";
import { BUN, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

const opcoes: Opcoes = { minDeltaPct: 1, minIntervals: 5, cacheReadWeight: 0.1 };
const T0 = Date.parse("2026-11-01T10:00:00Z") / 1000;
const MIN = 60;
const renova = T0 + 5 * 3600;
const at = (s: number): string => new Date(s * 1000).toISOString();
const sample = (s: number, five: number, resetsAt = renova, seven?: number): Amostra => ({
  at: at(s), five: { pct: five, resetsAt }, ...(seven === undefined ? {} : { seven: { pct: seven, resetsAt: T0 + 7 * 86_400 } }),
});
/** Requisição de `milhoes` de tokens de entrada do modelo, a US$ `usd`, no instante `s`. */
const req = (s: number, model: string, milhoes: number, usd = milhoes): Req => [s, model, milhoes * 1e6, 0, 0, 0, usd];

describe("amostra do status line", () => {
  const json = (rate_limits: unknown) => JSON.stringify({ version: "2.1.317", rate_limits });
  const now = new Date("2026-11-01T10:00:00Z");
  test("dado as duas janelas, então a amostra leva % e renovação de cada uma", () => {
    const a = amostraDoStatusLine(json({ five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } }), now);
    expect(a).toEqual({ at: "2026-11-01T10:00:00.000Z", five: { pct: 23.5, resetsAt: 1738425600 }, seven: { pct: 41.2, resetsAt: 1738857600 }, version: "2.1.317" });
  });
  test("dado uma janela só, então a outra fica ausente", () => {
    const a = amostraDoStatusLine(json({ seven_day: { used_percentage: 3, resets_at: 5 } }), now);
    expect(a?.five).toBeUndefined();
    expect(a?.seven).toEqual({ pct: 3, resetsAt: 5 });
  });
  test.each([
    ["sem rate_limits", JSON.stringify({ model: "x" })],
    ["rate_limits vazio", json({})],
    ["% como texto", json({ five_hour: { used_percentage: "9", resets_at: 5 } })],
    ["% negativo", json({ five_hour: { used_percentage: -1, resets_at: 5 } })],
    ["sem renovação", json({ five_hour: { used_percentage: 9 } })],
    ["JSON inválido", "{ não é json"],
    ["vazio", ""],
  ])("dado %s, então não há amostra", (_nome, texto) => {
    expect(amostraDoStatusLine(texto, now)).toBeUndefined();
  });
  test("dado arquivo com linha corrompida, então só ela é ignorada e as demais vêm em ordem de horário", () => {
    const linhas = [JSON.stringify(sample(T0 + 60, 5)), "lixo", JSON.stringify({ at: "x" }), JSON.stringify(sample(T0, 4))].join("\n");
    expect(amostrasDe(linhas).map((a) => a.five?.pct)).toEqual([4, 5]);
  });
});

describe("quando gravar", () => {
  const a = sample(T0, 10);
  test("dado a mesma leitura, então não grava, mesmo passado o intervalo", () => {
    expect(vale(sample(T0 + 3600, 10), a, 60)).toBe(false);
  });
  test("dado leitura nova antes do intervalo, então não grava; no intervalo, grava", () => {
    expect(vale(sample(T0 + 59, 11), a, 60)).toBe(false);
    expect(vale(sample(T0 + 60, 11), a, 60)).toBe(true);
  });
  test("dado nenhuma amostra anterior, então grava", () => {
    expect(vale(a, undefined, 60)).toBe(true);
  });
});

describe("medida atual", () => {
  test("dado janela já renovada, então não conta como medida; a ainda aberta, sim", () => {
    const amostras: Amostra[] = [{ at: at(T0), five: { pct: 90, resetsAt: T0 - 1 }, seven: { pct: 40, resetsAt: T0 + 86_400 } }];
    const atual = atuais(amostras, new Date(T0 * 1000));
    expect(atual.five).toBeUndefined();
    expect(atual.seven).toMatchObject({ pct: 40 });
  });
  test("dado duas amostras, então vale a última", () => {
    const atual = atuais([sample(T0, 10), sample(T0 + 60, 12)], new Date((T0 + 120) * 1000));
    expect(atual.five?.pct).toBe(12);
  });
});

describe("calibração tokens → %", () => {
  /** 8 passos de 10 min; a cada passo, `milhoes` de tokens e `taxa` % por milhão. */
  function serie(taxa: number, milhoes: number, model = "opus-5-5"): { amostras: Amostra[]; reqs: Req[] } {
    const amostras = [sample(T0, 0)];
    const reqs: Req[] = [];
    for (let i = 1; i <= 8; i += 1) {
      reqs.push(req(T0 + i * 10 * MIN - 5 * MIN, model, milhoes));
      amostras.push(sample(T0 + i * 10 * MIN, i * taxa * milhoes));
    }
    return { amostras, reqs };
  }
  test("dado 2% por milhão em todos os passos, então a taxa do modelo e a por US$ saem 2", () => {
    const { amostras, reqs } = serie(2, 1);
    const cal = calibra(amostras, reqs, opcoes);
    expect(cal.five.porModelo["opus-5-5"]).toBeCloseTo(2, 6);
    expect(cal.five.porUsd).toBeCloseTo(2, 6);
    expect(cal.five.intervalos).toBe(8);
  });
  test("dado dois modelos em misturas diferentes, então cada taxa é recuperada", () => {
    const amostras = [sample(T0, 0)];
    const reqs: Req[] = [];
    let pct = 0;
    const mix = [[1, 0], [0, 2], [1, 1], [2, 1], [1, 3], [3, 0], [0, 1], [2, 2]] as const;
    mix.forEach(([opus, sonnet], i) => {
      const t = T0 + (i + 1) * 10 * MIN;
      if (opus) reqs.push(req(t - 60, "opus-5-5", opus, opus * 4));
      if (sonnet) reqs.push(req(t - 30, "sonnet-5-5", sonnet, sonnet * 2));
      pct += opus * 3 + sonnet * 1;
      amostras.push(sample(t, pct));
    });
    const cal = calibra(amostras, reqs, opcoes);
    expect(cal.five.porModelo["opus-5-5"]).toBeCloseTo(3, 3);
    expect(cal.five.porModelo["sonnet-5-5"]).toBeCloseTo(1, 3);
  });
  test("dado menos intervalos que o mínimo, então sem calibração (nada estimado)", () => {
    const { amostras, reqs } = serie(2, 1);
    const cal = calibra(amostras.slice(0, 5), reqs, opcoes);
    expect(cal.five.porModelo).toEqual({});
    expect(cal.five.porUsd).toBeNull();
    expect(cal.five.intervalos).toBe(4);
    expect(textoPct(pctDeTokens(cal.five, { "opus-5-5": [1e6, 0, 0, 0] }, 0.1))).toBe("sem calib.");
  });
  test("dado modelo com poucos intervalos, então só ele fica sem taxa e o % sai parcial", () => {
    const { amostras, reqs } = serie(2, 1);
    reqs.push(req(T0 + 25 * MIN, "haiku-5-5", 1));
    const cal = calibra(amostras, reqs, opcoes);
    expect(cal.five.porModelo["haiku-5-5"]).toBeUndefined();
    const est = pctDeTokens(cal.five, { "opus-5-5": [1e6, 0, 0, 0], "haiku-5-5": [1e6, 0, 0, 0] }, 0.1);
    expect(est.pct).toBeCloseTo(2, 5);
    expect(est.parcial).toBe(true);
    expect(textoPct(est)).toBe("~2.0%+");
  });
  test("dado janela que renovou no meio, então o intervalo que a cruza é descartado", () => {
    const amostras = [sample(T0, 0), sample(T0 + 600, 2), sample(T0 + 1200, 4), sample(T0 + 1800, 1, renova + 5 * 3600), sample(T0 + 2400, 3, renova + 5 * 3600)];
    const reqs = [req(T0 + 300, "opus-5-5", 1), req(T0 + 900, "opus-5-5", 1), req(T0 + 1500, "opus-5-5", 1), req(T0 + 2100, "opus-5-5", 1)];
    expect(intervalos(amostras, "five", reqs, opcoes).map((i) => i.dPct)).toEqual([2, 2, 2]);
  });
  test("dado % que não passa da variação mínima, então o intervalo acumula até passar", () => {
    const amostras = [sample(T0, 0), sample(T0 + 600, 0.4), sample(T0 + 1200, 1.2)];
    const reqs = [req(T0 + 300, "opus-5-5", 1), req(T0 + 900, "opus-5-5", 1)];
    const [unico] = intervalos(amostras, "five", reqs, opcoes);
    expect(unico?.dPct).toBeCloseTo(1.2, 9);
    expect(unico?.mtok["opus-5-5"]).toBeCloseTo(2, 9);
  });
  test("dado a janela semanal, então ela calibra à parte da de 5 h", () => {
    const amostras = Array.from({ length: 9 }, (_, i) => sample(T0 + i * 600, i * 4, renova, i));
    const reqs = Array.from({ length: 8 }, (_, i) => req(T0 + i * 600 + 300, "opus-5-5", 2));
    const cal = calibra(amostras, reqs, opcoes);
    expect(cal.five.porModelo["opus-5-5"]).toBeCloseTo(2, 6);
    expect(cal.seven.porModelo["opus-5-5"]).toBeCloseTo(0.5, 6);
  });
  test("dado cache de leitura, então pesa a fração configurada de um token novo", () => {
    expect(mtok([0, 0, 0, 1e6], 0.1)).toBeCloseTo(0.1, 9);
    expect(mtok([1e6, 1e6, 1e6, 0], 0.1)).toBeCloseTo(3, 9);
  });
  test("dado nenhuma amostra, então tudo sem calibração", () => {
    const cal = calibra([], [], opcoes);
    expect(cal.five).toEqual({ porModelo: {}, porUsd: null, intervalos: 0 });
    expect(cal.seven).toEqual({ porModelo: {}, porUsd: null, intervalos: 0 });
  });
});

describe("cabe na janela", () => {
  const atual = { pct: 70, resetsAt: renova, at: at(T0) };
  test("dado p75 abaixo do que resta, então cabe; igual ao que resta, ainda cabe; acima, não", () => {
    expect(cabeNaJanela(atual, 29)).toEqual({ resta: 30, cabe: true });
    expect(cabeNaJanela(atual, 30)).toEqual({ resta: 30, cabe: true });
    expect(cabeNaJanela(atual, 30.1)).toEqual({ resta: 30, cabe: false });
  });
  test("dado janela já estourada (acima de 100%), então resta 0 e nada cabe", () => {
    expect(cabeNaJanela({ ...atual, pct: 104 }, 1)).toEqual({ resta: 0, cabe: false });
  });
  test("dado sem medida atual ou sem p75 calibrado, então não dá para dizer", () => {
    expect(cabeNaJanela(undefined, 5)).toEqual({ resta: null, cabe: null });
    expect(cabeNaJanela(atual, null)).toEqual({ resta: 30, cabe: null });
  });
  const cal = { five: { porModelo: {}, porUsd: 2, intervalos: 9 }, seven: { porModelo: {}, porUsd: null, intervalos: 0 } };
  const faixa = { p25: 1, median: 2, p75: 3 };
  test("dado US$ do plano e taxa por US$, então a faixa em % sai da taxa; sem taxa, sem faixa", () => {
    expect(pctDeUsd(cal.five, faixa)).toEqual({ p25: 2, median: 4, p75: 6 });
    expect(pctDeUsd(cal.seven, faixa)).toBeNull();
    expect(pctDeUsd(cal.five, null)).toBeNull();
  });
  test("dado unidade sem custo estimado, então a soma é piso: pode dizer que não cabe, nunca que cabe", () => {
    const unidades = [{ unit: "a", costUsd: { p25: 10, median: 20, p75: 30 } }, { unit: "b", costUsd: null }];
    const justo = limitesDoPlano(unidades, cal, { five: { pct: 50, resetsAt: renova, at: at(T0) } });
    expect(justo.five.plano?.p75).toBe(60);
    expect(justo.five.completo).toBe(false);
    expect(justo.five.cabe).toBe(false);
    const folga = limitesDoPlano(unidades, cal, { five: { pct: 0, resetsAt: renova, at: at(T0) } });
    expect(folga.five.cabe).toBeNull();
    expect(folga.seven.plano).toBeNull();
  });
});

describe("CLI", () => {
  const home = `${r.T}/lim/home`;
  const agora = Math.floor(Date.now() / 1000);
  const fecha = agora + 3 * 3600; // janelas que ainda estão abertas quando o teste roda
  const run = (args: string[], stdin = "") => r.X([BUN, `${SKILL}/src/cli.ts`, ...args], { env: { HOME: home, HADES_WORK_ROOT: `${r.T}/lim/work` }, stdin });
  const status = (five: number, seven = five / 4) =>
    JSON.stringify({ version: "2.1.317", rate_limits: { five_hour: { used_percentage: five, resets_at: fecha }, seven_day: { used_percentage: seven, resets_at: fecha + 4 * 86_400 } } });
  const samples = `${home}/.claude/hades/limits/samples.jsonl`;

  test("dado o JSON do status line, então grava a amostra e imprime a linha de status; a repetida não duplica", () => {
    const first = run(["usage", "sample"], status(23));
    expect(first.rc).toBe(0);
    expect(first.out).toContain("5 h 23%");
    expect(first.out).toContain("semana 6%");
    run(["usage", "sample", "--quiet"], status(23));
    expect(readFileSync(samples, "utf8").trim().split("\n")).toHaveLength(1);
  });
  test("dado stdin sem limites, então não grava, não imprime e sai 0 (o status line não pode quebrar)", () => {
    const before = readFileSync(samples, "utf8");
    const o = run(["usage", "sample"], JSON.stringify({ model: "x" }));
    expect(o.rc).toBe(0);
    expect(o.out.trim()).toMatch(/^5 h 23% \(renova \d\d:\d\dZ\) · semana 6% \(renova \d\d-\d\d \d\d:\d\dZ\)$/);
    expect(readFileSync(samples, "utf8")).toBe(before);
  });
  test("dado argumento desconhecido no sample, então erro de uso", () => {
    expect(run(["usage", "sample", "--nada"]).rc).toBe(2);
  });

  test("dado amostras mas poucas, então usage mostra o % medido e as colunas dizem sem calib.", () => {
    mkdirSync(`${home}/.claude/projects/p`, { recursive: true });
    const turn = (id: string, s: number) => JSON.stringify({ type: "assistant", requestId: id, timestamp: at(s), sessionId: "s", cwd: `${r.T}/lim/x`, message: { model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, output_tokens: 0 } } });
    writeFileSync(`${home}/.claude/projects/p/s.jsonl`, [turn("a", T0 + 100), turn("b", T0 + 700)].join("\n") + "\n");
    const o = run(["usage", "--days", "400"]);
    expect(o.rc).toBe(0);
    expect(o.out).toMatch(/5 h: 23\.0% usado, renova \d\d:\d\dZ \(medido\) · sem calibração/);
    expect(o.out).toContain("% 5h");
    expect(o.out).toContain("sem calib.");
    expect(existsSync(`${home}/.claude/hades/usage/latest.json`)).toBe(true);
  });

  test("dado plano, então moirai estimate acrescenta as faixas em % e a pergunta de caber", () => {
    mkdirSync(`${r.T}/lim`, { recursive: true });
    writeFileSync(`${r.T}/lim/plan.md`, "# plano\n\n## Unidades\n\n| Unidade | Papel | Escopo |\n|---|---|---|\n| a | impl | x |\n");
    const o = run(["moirai", "estimate", `${r.T}/lim/plan.md`]);
    expect(o.rc).toBe(0);
    expect(o.out).toContain("% das janelas");
    expect(o.out).toMatch(/janela de 5 h: plano sem calib\. · restam 77\.0% .* cabe na janela atual\? não dá para dizer/);
    const json = JSON.parse(run(["moirai", "estimate", `${r.T}/lim/plan.md`, "--json"]).out) as { limits: { five: { cabe: boolean | null } } };
    expect(json.limits.five.cabe).toBeNull();
  });

  test("dado amostras que bastam, então usage calibra e mostra os % por papel e dia (estimados)", () => {
    const h2 = `${r.T}/lim/home2`;
    const base = Math.floor(Date.now() / 1000) - 3 * 3600;
    const lines: string[] = [];
    const turns: string[] = [];
    lines.push(JSON.stringify({ at: at(base), five: { pct: 0, resetsAt: fecha }, seven: { pct: 0, resetsAt: fecha + 4 * 86_400 } }));
    for (let i = 1; i <= 8; i += 1) {
      turns.push(JSON.stringify({ type: "assistant", requestId: `q${i}`, timestamp: at(base + i * 600 - 300), sessionId: "s", cwd: `${r.T}/lim/x`, message: { model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, output_tokens: 0 } } }));
      lines.push(JSON.stringify({ at: at(base + i * 600), five: { pct: i * 2, resetsAt: fecha }, seven: { pct: i, resetsAt: fecha + 4 * 86_400 } }));
    }
    mkdirSync(`${h2}/.claude/projects/p`, { recursive: true });
    mkdirSync(`${h2}/.claude/hades/limits`, { recursive: true });
    writeFileSync(`${h2}/.claude/projects/p/s.jsonl`, `${turns.join("\n")}\n`);
    writeFileSync(`${h2}/.claude/hades/limits/samples.jsonl`, `${lines.join("\n")}\n`);
    const o = r.X([BUN, `${SKILL}/src/cli.ts`, "usage", "--days", "2"], { env: { HOME: h2, HADES_WORK_ROOT: `${r.T}/lim/work` } });
    expect(o.rc).toBe(0);
    expect(o.out).toContain("calibrada em 8 intervalos");
    expect(o.out).toMatch(/interactive\s.*~16\.0%\s+~8\.0%/);
    const json = JSON.parse(r.X([BUN, `${SKILL}/src/cli.ts`, "usage", "--days", "2", "--json"], { env: { HOME: h2, HADES_WORK_ROOT: `${r.T}/lim/work` } }).out) as { byDay: { pct5h: number; pctWeek: number }[] };
    expect(json.byDay[0]).toMatchObject({ pct5h: 16, pctWeek: 8 });
  });
});
