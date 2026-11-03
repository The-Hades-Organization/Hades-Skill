// Moirai-real: o teto da execução (limiares do p75, um aviso por limiar por fase, sem estimativa = nada), o custo corrente
// por offset (lê só o acréscimo), `resumes` no registro e as rotas do painel (nome inválido recusado). O ciclo do watch
// roda o `hades watch` de verdade com dublê só no herdr e no gh.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { currentCost, type CostCache } from "../../../src/commands/moirai";
import { afterFreshSession } from "../../../src/lib/agent-registry";
import {
  addTranscriptText, budgetOf, budgetQuestion, emptyFileCost, estimateOfUnit, nextQuestionNumber, TABLE_HEADER,
} from "../../../src/lib/moirai";
import { createMoiraiRoutes, MOIRAI_ERRORS, MoiraiError } from "../../../src/panel/moirai";
import { BUN, Rig, SKILL } from "./lib/rig";

const r = new Rig().setup();
afterAll(() => r.cleanup());

const encode = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");
/** Uma resposta do assistente no formato do transcript: opus-5-5 custa US$ 20 por MTok de saída. */
const line = (id: string, outputTokens: number): string =>
  `${JSON.stringify({ type: "assistant", requestId: id, timestamp: "2026-10-01T10:00:00Z", message: { model: "claude-opus-5-5", usage: { output_tokens: outputTokens } } })}\n`;
const plan = (unit: string, p75: string): string =>
  `# plano\n\n## Unidades\n\n| Unidade | Papel | Escopo |\n|---|---|---|\n| ${unit} | impl | x |\n\n## Estimativa\n\n| ${TABLE_HEADER.join(" | ")} |\n|${"---|".repeat(TABLE_HEADER.length)}\n| ${unit} | 0.50 | 0.80 | ${p75} | 1 | 2 | 3 | — | 9 | media | parecidas |\n`;

describe("moirai-real: limiar do p75", () => {
  test("dado custo abaixo do p75, então nada passa de limiar", () => {
    expect(budgetOf(0.99, 1, 100, 150)).toMatchObject({ warn: false, ask: false, level: "ok" });
  });
  test("dado custo em 100% do p75, então avisa e ainda não pergunta", () => {
    expect(budgetOf(1, 1, 100, 150)).toMatchObject({ pct: 100, warn: true, ask: false, level: "warn" });
  });
  test("dado custo em 150% do p75, então pergunta", () => {
    expect(budgetOf(1.5, 1, 100, 150)).toMatchObject({ warn: true, ask: true, level: "ask" });
  });
  test("dado limiares da Configuração, então valem no lugar dos padrões", () => {
    expect(budgetOf(0.6, 1, 50, 80)).toMatchObject({ warn: true, ask: false });
  });
  test("dado p75 ausente ou zero, então não há percentual nem aviso", () => {
    for (const p75 of [null, 0]) expect(budgetOf(99, p75, 100, 150)).toEqual({ pct: null, warn: false, ask: false, level: "ok" });
  });
  test("dado a seção Estimativa do plano, então a linha da unidade sai e unidade sem linha não", () => {
    expect(estimateOfUnit(plan("u1", "1.00"), "u1")?.costP75).toBe(1);
    expect(estimateOfUnit(plan("u1", "1.00"), "outra")).toBeUndefined();
    expect(estimateOfUnit("# plano sem seção\n", "u1")).toBeUndefined();
  });
  test("dado questions.md, então a próxima pergunta é a maior + 1, e a pergunta do teto leva as três saídas", () => {
    expect(nextQuestionNumber("")).toBe(1);
    expect(nextQuestionNumber("## Q1 — a\n## Q4 — b (respondida)\n")).toBe(5);
    const q = budgetQuestion({ number: 2, unit: "u1", phase: "impl", costUsd: 2, p75: 1, pct: 200, askPct: 150 });
    expect(q).toMatch(/^## Q2 — custo passou de 150% do estimado/);
    expect(q).toMatch(/Seguir[\s\S]*Reestimar[\s\S]*Estacionar/);
  });
});

describe("moirai-real: custo corrente por offset", () => {
  const worktree = `${r.T}/wt-cost`;
  const projects = `${r.T}/projects`;
  const dir = `${projects}/${encode(worktree)}`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/s.jsonl`;
  const cache: CostCache = {};

  test("dado um transcript, então a primeira leitura soma tudo (100k saída = US$ 2)", () => {
    writeFileSync(file, line("a", 100_000));
    const first = currentCost(worktree, cache, projects);
    expect(first.costUsd).toBeCloseTo(2, 6);
    expect(first.read).toBeGreaterThan(0);
  });
  test("dado nada novo, então não lê byte nenhum e o custo fica", () => {
    expect(currentCost(worktree, cache, projects)).toEqual({ costUsd: expect.closeTo(2, 6), read: 0 });
  });
  test("dado um acréscimo, então lê só ele; o mesmo requestId em outra linha não soma de novo", () => {
    const add = line("b", 50_000) + line("b", 50_000);
    appendFileSync(file, add);
    const next = currentCost(worktree, cache, projects);
    expect(next.read).toBe(Buffer.byteLength(add));
    expect(next.costUsd).toBeCloseTo(3, 6);
  });
  test("dado uma linha ainda incompleta, então fica para o próximo ciclo", () => {
    const whole = line("c", 50_000);
    appendFileSync(file, whole.slice(0, 40));
    expect(currentCost(worktree, cache, projects).read).toBe(0);
    appendFileSync(file, whole.slice(40));
    const done = currentCost(worktree, cache, projects);
    expect(done.read).toBe(Buffer.byteLength(whole));
    expect(done.costUsd).toBeCloseTo(4, 6);
  });
  test("dado arquivo que encolheu, então recomeça do zero", () => {
    writeFileSync(file, line("z", 25_000));
    expect(currentCost(worktree, cache, projects).costUsd).toBeCloseTo(0.5, 6);
  });
  test("dado cache corrompido no disco, então a entrada é descartada e relida", () => {
    const bad: CostCache = { [file]: { offset: "x" } };
    expect(currentCost(worktree, bad, projects).costUsd).toBeCloseTo(0.5, 6);
  });
  test("dado worktree vazio ou sem transcript, então custo zero", () => {
    expect(currentCost("", {}, projects)).toEqual({ costUsd: 0, read: 0 });
    expect(currentCost(`${r.T}/nada`, {}, projects)).toEqual({ costUsd: 0, read: 0 });
  });
  test("dado modelo desconhecido ou linha sem horário, então não custa", () => {
    const odd = `${JSON.stringify({ type: "assistant", requestId: "q", timestamp: "t", message: { model: "outro", usage: { output_tokens: 9e9 } } })}\n${JSON.stringify({ type: "assistant", requestId: "p", message: { model: "claude-opus-5-5", usage: { output_tokens: 9e9 } } })}\nnão é json\n`;
    expect(addTranscriptText(emptyFileCost(), odd, Buffer.byteLength(odd)).costUsd).toBe(0);
  });
});

describe("moirai-real: resumes no registro", () => {
  test("dado resume, então resumes sobe e clears também (os dois fazem /clear)", () => {
    expect(afterFreshSession({ clears: 2, resumes: 1 }, "resume", "impl", "T")).toMatchObject({ clears: 3, resumes: 2, phase: "impl", promptedAt: "T", state: "working" });
  });
  test("dado phase, então só clears sobe e resumes não aparece", () => {
    const after = afterFreshSession({ clears: 2 }, "phase", "review", "T");
    expect(after.clears).toBe(3);
    expect("resumes" in after).toBe(false);
  });
  test("dado registro antigo sem os campos, então começa de zero", () => {
    expect(afterFreshSession({}, "resume", "x", "T")).toMatchObject({ clears: 1, resumes: 1 });
  });
});

describe("moirai-real: rotas do painel", () => {
  const orch = `${r.T}/panelwork/ex__proj/orchestration`;
  const worktree = `${r.T}/wt-panel`;
  const projects = `${r.T}/projects-panel`;
  mkdirSync(`${orch}/agents`, { recursive: true });
  mkdirSync(`${projects}/${encode(worktree)}`, { recursive: true });
  writeFileSync(`${projects}/${encode(worktree)}/s.jsonl`, line("a", 100_000));
  writeFileSync(`${r.T}/plan-panel.md`, plan("u-um", "1.00"));
  writeFileSync(`${orch}/plan.json`, JSON.stringify({ path: `${r.T}/plan-panel.md`, sha: "x" }));
  writeFileSync(`${orch}/agents/u-um.json`, JSON.stringify({ name: "u-um", role: "impl", worktree, state: "working", createdAt: "2026-10-01T10:00:00Z" }));
  const routes = createMoiraiRoutes({
    registries: () => [{ slug: "ex__proj", orch }], config: () => ({}), projectsDir: projects, now: () => new Date("2026-10-01T11:00:00Z"),
  });

  test("dado o plano, então estimado × real por unidade, com nível ask a US$ 2 de p75 1", () => {
    const [p] = routes.plan().plans as { units: { unit: string; pct: number; level: string; real: { costUsd: number; wallMin: number } }[]; approved: boolean }[];
    expect(p?.approved).toBe(false);
    expect(p?.units[0]).toMatchObject({ unit: "u-um", level: "ask" });
    expect(p?.units[0]?.pct).toBeCloseTo(200, 3);
    expect(p?.units[0]?.real.wallMin).toBeCloseTo(60, 3);
  });
  test("dado nome registrado, então a unidade sai com o mesmo estimado × real", () => {
    expect(routes.unit("u-um", "ex__proj")).toMatchObject({ unit: "u-um", level: "ask", registry: "ex__proj" });
  });
  test("dado nome inválido (caminho, ponto inicial, vazio, longo), então 400 com código estável", () => {
    for (const name of ["../x", "a/b", ".oculto", "", "x".repeat(101), "a b"]) {
      try {
        routes.unit(name, undefined);
        throw new Error(`aceitou ${name}`);
      } catch (error) {
        expect(error).toBeInstanceOf(MoiraiError);
        expect(error).toMatchObject({ status: 400, code: MOIRAI_ERRORS.invalidUnit });
      }
    }
  });
  test("dado nome bem formado que não está no registro, então 404", () => {
    expect(() => routes.unit("nao-existe", undefined)).toThrow(expect.objectContaining({ status: 404, code: MOIRAI_ERRORS.unknownUnit }));
  });
  test("dado registro de outro projeto na query, então a unidade não é achada", () => {
    expect(() => routes.unit("u-um", "outro__proj")).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("moirai-real: ciclo real do hades watch", () => {
  const unit = (name: string, costTokens: number, phase = "impl"): string => {
    const worktree = `${r.T}/wtw/${name}`;
    const reports = `${worktree}/.design-sync-reports`;
    const orch = `${r.T}/work/example__monorepo/orchestration`;
    mkdirSync(reports, { recursive: true });
    mkdirSync(`${orch}/agents`, { recursive: true });
    mkdirSync(`${r.H}/.claude/projects/${encode(worktree)}`, { recursive: true });
    writeFileSync(`${r.H}/.claude/projects/${encode(worktree)}/s.jsonl`, line("a", costTokens));
    writeFileSync(`${orch}/agents/${name}.json`, JSON.stringify({ name, mode: "skill", role: "impl", phase, worktree, state: "working", branch: `skill/${name}` }));
    return worktree;
  };
  const approve = (name: string, p75: string): void => {
    const orch = `${r.T}/work/example__monorepo/orchestration`;
    writeFileSync(`${r.T}/plan-${name}.md`, plan(name, p75));
    writeFileSync(`${orch}/plan.json`, JSON.stringify({ path: `${r.T}/plan-${name}.md`, sha: "x" }));
  };
  const watch = (state: string, seconds = 4, env: Record<string, string> = {}): string =>
    r.X(["timeout", String(seconds), BUN, `${SKILL}/src/cli.ts`, "watch", "1"], { cwd: r.C, merge: true, env: { HADES_WATCH_STATE: state, ...env } }).out;
  const only = (out: string, word: string): string[] => out.split("\n").filter((l) => l.startsWith(word));

  test("dado custo em 120% do p75, então um BUDGET (não repete nos ciclos seguintes) e nenhuma pergunta", () => {
    const wt = unit("w-aviso", 60_000); // US$ 1,20
    approve("w-aviso", "1.00");
    const out = watch(`${r.T}/st-aviso`);
    expect(only(out, "BUDGET")).toEqual(["BUDGET w-aviso 120"]);
    expect(only(out, "QUESTION")).toEqual([]);
    expect(() => readFileSync(`${wt}/.design-sync-reports/questions.md`)).toThrow();
  });
  test("dado custo em 200% do p75, então BUDGET e a pergunta no questions.md do agente, uma vez só", () => {
    const wt = unit("w-pergunta", 100_000); // US$ 2,00
    approve("w-pergunta", "1.00");
    const out = watch(`${r.T}/st-pergunta`);
    expect(only(out, "BUDGET")).toEqual(["BUDGET w-pergunta 200"]);
    expect(only(out, "QUESTION")).toEqual(["QUESTION w-pergunta 1"]);
    const questions = readFileSync(`${wt}/.design-sync-reports/questions.md`, "utf8");
    expect(questions.match(/^## Q/gm)).toHaveLength(1);
    expect(questions).toMatch(/^## Q1 — custo passou de 150% do estimado/);
  });
  test("dado limiares da Configuração, então valem (50% avisa a US$ 0,60 de p75 1)", () => {
    unit("w-limiar", 30_000); // US$ 0,60
    approve("w-limiar", "1.00");
    expect(only(watch(`${r.T}/st-limiar`, 4, { HADES_MOIRAI_WARN_PCT: "50", HADES_MOIRAI_ASK_PCT: "500" }), "BUDGET")).toEqual(["BUDGET w-limiar 60"]);
  });
  test("dado a pergunta de 150% já respondida e o visto perdido, então a mesma fase não pergunta de novo", () => {
    const wt = unit("w-respondida", 100_000, "impl");
    approve("w-respondida", "1.00");
    const state = `${r.T}/st-respondida`;
    expect(only(watch(state), "QUESTION w-respondida")).toEqual(["QUESTION w-respondida 1"]);
    const questions = `${wt}/.design-sync-reports/questions.md`;
    appendFileSync(questions, "\n## Resposta do dono\n\nSeguir.\n");
    rmSync(state, { recursive: true, force: true });
    const out = watch(state);
    expect(only(out, "QUESTION w-respondida")).toEqual([]);
    expect(readFileSync(questions, "utf8").match(/^## Q/gm)).toHaveLength(1);
  }, 15_000);
  test("dado a pergunta de 150% apagada do questions.md e o visto perdido, então a mesma fase não pergunta de novo", () => {
    const wt = unit("w-apagada", 100_000, "impl");
    approve("w-apagada", "1.00");
    const state = `${r.T}/st-apagada`;
    expect(only(watch(state), "QUESTION w-apagada")).toEqual(["QUESTION w-apagada 1"]);
    const questions = `${wt}/.design-sync-reports/questions.md`;
    writeFileSync(questions, "");
    rmSync(state, { recursive: true, force: true });
    expect(only(watch(state), "QUESTION w-apagada")).toEqual([]);
    expect(readFileSync(questions, "utf8")).toBe("");
  }, 15_000);
  test("dado a pergunta de 150% feita na fase impl, então outra fase do mesmo agente pergunta uma vez", () => {
    const wt = unit("w-fases", 100_000, "impl");
    approve("w-fases", "1.00");
    const state = `${r.T}/st-fases`;
    expect(only(watch(state), "QUESTION w-fases")).toEqual(["QUESTION w-fases 1"]);
    const orch = `${r.T}/work/example__monorepo/orchestration`;
    writeFileSync(`${orch}/agents/w-fases.json`, JSON.stringify({ name: "w-fases", mode: "skill", role: "impl", phase: "review", worktree: wt, state: "working", branch: "skill/w-fases" }));
    rmSync(state, { recursive: true, force: true });
    expect(only(watch(state), "QUESTION w-fases")).toEqual(["QUESTION w-fases 2"]);
    expect(readFileSync(`${wt}/.design-sync-reports/questions.md`, "utf8").match(/^## Q/gm)).toHaveLength(2);
  }, 15_000);
  test("dado a mesma unidade nas raízes do projeto e _skill (fases diferentes), então um BUDGET só", () => {
    unit("w-raizes", 60_000, "impl");
    approve("w-raizes", "1.00");
    const skillAgents = `${r.T}/work/_skill/orchestration/agents`;
    mkdirSync(skillAgents, { recursive: true });
    writeFileSync(`${r.T}/work/_skill/orchestration/plan.json`, JSON.stringify({ path: `${r.T}/plan-w-raizes.md`, sha: "x" }));
    writeFileSync(`${skillAgents}/w-raizes.json`, JSON.stringify({ name: "w-raizes", mode: "skill", role: "impl", phase: "review", worktree: `${r.T}/wtw/w-raizes`, state: "working", branch: "skill/w-raizes" }));
    expect(only(watch(`${r.T}/st-raizes`, 4), "BUDGET")).toEqual(["BUDGET w-raizes 120"]);
  });
  test("dado plano sem a unidade na Estimativa, então nada é emitido", () => {
    unit("w-sem", 900_000);
    approve("outra-unidade", "1.00");
    const out = watch(`${r.T}/st-sem`, 3);
    expect(only(out, "BUDGET")).toEqual([]);
    expect(only(out, "QUESTION w-sem")).toEqual([]);
  });
  test("dado limiar inválido na Configuração, então avisa e usa o padrão", () => {
    unit("w-invalido", 60_000);
    approve("w-invalido", "1.00");
    const out = watch(`${r.T}/st-invalido`, 3, { HADES_MOIRAI_WARN_PCT: "abc" });
    expect(out).toMatch(/HADES_MOIRAI_WARN_PCT=abc/);
    expect(only(out, "BUDGET")).toEqual(["BUDGET w-invalido 120"]);
  });
});
