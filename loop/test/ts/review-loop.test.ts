// Loop de revisão (src/commands/review-loop.ts + src/lib/review-loop*.ts): rodada, estado por PR, dedup de achado, lock,
// limite de uso e as paradas. `gh`, `hades review`, relógio e notify entram por dublê: nada vai ao GitHub.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop, type LoopDeps, type ReviewRequest, type ReviewResult } from "../../../src/commands/review-loop.ts";
import {
  type Candidate, type Finding, LoopArgError, type LoopOptions, newFindings, parseFindings, parseLoopArgs, planRound, priorContext, type PrState,
} from "../../../src/lib/review-loop.ts";
import { loopDir, readPrState, requestStop, writePrState } from "../../../src/lib/review-loop-store.ts";

const root = mkdtempSync(join(tmpdir(), "hades-review-loop-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-04T12:00:00Z");
const MIN = 60_000;
let seq = 0;

const pr = (number: number, headOid: string, extra: Partial<Candidate> = {}): Candidate => ({ number, headOid, isDraft: false, state: "OPEN", author: "outra", title: `PR ${number}`, ...extra });
const finding = (code: string, file: string, sev: Finding["sev"] = "yellow", line = 10): Finding => ({ sev, code, file, line });
const ok = (findings: Finding[] = [], reviewId = "99"): ReviewResult => ({
  ok: true, recordId: "r", headOid: undefined, reviewId, verdict: "yellow", posted: true, findings, costUsd: 0.5, tokens: 1000,
});

const opts = (extra: Partial<LoopOptions> = {}): LoopOptions => ({
  everyMs: 30 * MIN, author: undefined, prs: [], max: undefined, deep: false, untilMs: undefined, rounds: 1, post: true, dryRun: false, note: undefined, wt: undefined, ...extra,
});

interface Rig {
  deps: LoopDeps;
  dir: string;
  locks: string;
  requests: ReviewRequest[];
  notices: { event: string; severity: string; text: string }[];
  notes: string[];
  registered: string[];
  dismissed: string[];
  logs: string[];
  clock: { t: number };
  /** O que a busca devolve em cada rodada (a última se repete). */
  candidates: Candidate[][];
  usage: { five?: { pct: number; resetsAt: number }; seven?: { pct: number; resetsAt: number } };
  onSleep: (ms: number) => void;
  review: (req: ReviewRequest) => Promise<ReviewResult>;
}

function rig(): Rig {
  const work = join(root, `w${++seq}`);
  mkdirSync(work, { recursive: true });
  const r: Rig = {
    dir: join(work, "review-loop"), locks: join(work, "locks"), requests: [], notices: [], notes: [], registered: [], dismissed: [], logs: [],
    clock: { t: T0 }, candidates: [[]], usage: {}, onSleep: () => {}, review: async () => ok(),
    deps: undefined as unknown as LoopDeps,
  };
  let round = 0;
  r.deps = {
    now: () => new Date(r.clock.t),
    sleep: async (ms) => { r.clock.t += ms; r.onSleep(ms); },
    me: "eu", slug: "org/repo", work, clone: "/clone",
    listCandidates: () => r.candidates[Math.min(round++, r.candidates.length - 1)] ?? [],
    reviewPr: async (req) => { r.requests.push(req); return r.review(req); },
    usage: () => r.usage,
    pauseAt: { five: 85, seven: 90 },
    notify: async (event, severity, text) => { r.notices.push({ event, severity, text }); },
    canvas: { register: (n) => { r.registered.push(n); }, dismiss: (n) => { r.dismissed.push(n); }, note: async (t) => { r.notes.push(t); } },
    newId: () => `20261104-120000-${String(++seq).padStart(4, "0")}`,
    out: (t) => { r.logs.push(t); },
    warn: (t) => { r.logs.push(`WARN ${t}`); },
  };
  return r;
}

const state = (n: number, head: string, open: Finding[] = []): PrState => ({ pr: n, headOid: head, reviewedAt: "2026-11-04T11:00:00Z", reviewUrl: "https://x/review", verdict: "yellow", open });

describe("rodada do loop", () => {
  test("dado a PR no mesmo head já revisado, quando a rodada roda, então nada é revisado", async () => {
    const r = rig();
    writePrState(loopDir(r.deps.work), state(7, "aaaa1111"));
    r.candidates = [[pr(7, "aaaa1111")]];
    const res = await runLoop(r.deps, opts());
    expect(res.code).toBe(0);
    expect(r.requests).toEqual([]);
    expect(r.logs.join("\n")).toContain("#7 pular: head igual");
  });

  test("dado um head novo, quando a rodada roda, então revisa, grava o estado e libera o lock da PR", async () => {
    const r = rig();
    writePrState(loopDir(r.deps.work), state(7, "aaaa1111"));
    r.candidates = [[pr(7, "bbbb2222"), pr(8, "cccc3333")]];
    r.review = async (req) => ({ ...ok([finding("sec.x", "a.ts")], `r${req.pr}`), headOid: req.headOid });
    await runLoop(r.deps, opts());
    expect(r.requests.map((q) => q.pr).sort()).toEqual([7, 8]);
    expect(r.requests.every((q) => q.cmd === "review-pr")).toBe(true);
    const saved = readPrState(r.dir, 7);
    expect(saved?.headOid).toBe("bbbb2222");
    expect(saved?.reviewUrl).toBe("https://github.com/org/repo/pull/7#pullrequestreview-r7");
    expect(saved?.open).toEqual([finding("sec.x", "a.ts")]);
    expect(readPrState(r.dir, 8)?.headOid).toBe("cccc3333");
    expect(existsSync(join(r.locks, "pr-7.lock"))).toBe(false);
    expect(r.registered.sort()).toEqual(r.dismissed.sort());
    expect(r.notes[0]).toContain("Rodada 1");
  });

  test("dado --deep, quando revisa, então usa o review-agents", async () => {
    const r = rig();
    r.candidates = [[pr(7, "aaaa1111")]];
    await runLoop(r.deps, opts({ deep: true }));
    expect(r.requests[0]?.cmd).toBe("review-agents");
  });

  test("dado a PR com lock de outra sessão, quando a rodada roda, então pula com o motivo e não toca no lock", async () => {
    const r = rig();
    mkdirSync(join(r.locks, "pr-7.lock"), { recursive: true });
    writeFileSync(join(r.locks, "pr-7.lock", "owner"), "clone=/outro\nmode=deliver\n");
    r.candidates = [[pr(7, "aaaa1111"), pr(8, "bbbb2222")]];
    await runLoop(r.deps, opts());
    expect(r.requests.map((q) => q.pr)).toEqual([8]);
    expect(r.logs.join("\n")).toContain("#7 pular: outra sessão tem o lock da PR [clone=/outro mode=deliver]");
    expect(existsSync(join(r.locks, "pr-7.lock", "owner"))).toBe(true);
  });

  test("dado uma revisão que falha, quando a rodada fecha, então o estado da PR não avança e a próxima rodada tenta de novo", async () => {
    const r = rig();
    r.candidates = [[pr(7, "aaaa1111")]];
    r.review = async () => ({ ...ok(), ok: false });
    await runLoop(r.deps, opts());
    expect(readPrState(r.dir, 7)).toBeUndefined();
  });

  test("dado PR própria, rascunho e --max 1, quando planeja, então só a primeira elegível entra e as outras pulam com motivo", () => {
    const plan = planRound({
      candidates: [pr(1, "a", { author: "eu" }), pr(2, "b", { isDraft: true }), pr(3, "c"), pr(4, "d")],
      states: new Map(), locked: new Map(), me: "eu", explicit: new Set(), max: 1,
    });
    expect(plan.map((d) => `${d.pr}:${d.action === "pular" ? d.reason : "revisar"}`)).toEqual(["1:propria", "2:rascunho", "3:revisar", "4:adiada"]);
  });

  test("dado rascunho pedido com --pr, quando planeja, então entra", () => {
    const plan = planRound({ candidates: [pr(2, "b", { isDraft: true })], states: new Map(), locked: new Map(), me: "eu", explicit: new Set([2]), max: undefined });
    expect(plan[0]?.action).toBe("revisar");
  });
});

describe("achado repetido", () => {
  test("dado achado aberto do review anterior, quando o head muda, então o prompt leva o achado e a ordem de não repostar", async () => {
    const r = rig();
    writePrState(loopDir(r.deps.work), state(7, "aaaa1111", [finding("sec.x", "a.ts", "red", 12)]));
    r.candidates = [[pr(7, "bbbb2222")]];
    await runLoop(r.deps, opts());
    const file = r.requests[0]?.contextFile;
    expect(file).toBeDefined();
    const text = readFileSync(file ?? "", "utf8");
    expect(text).toContain("`sec.x` a.ts:12");
    expect(text).toContain("NÃO o publique de novo");
    expect(text).toContain("https://x/review");
  });

  test("dado achado bloqueante que já estava aberto, quando continua em pé, então não há aviso; um bloqueante novo avisa", async () => {
    const r = rig();
    writePrState(loopDir(r.deps.work), state(7, "aaaa1111", [finding("sec.x", "a.ts", "red")]));
    r.candidates = [[pr(7, "bbbb2222")]];
    r.review = async () => ok([finding("sec.x", "a.ts", "red", 30)]);
    await runLoop(r.deps, opts());
    expect(r.notices).toEqual([]);

    const s = rig();
    writePrState(loopDir(s.deps.work), state(7, "aaaa1111", [finding("sec.x", "a.ts", "red")]));
    s.candidates = [[pr(7, "bbbb2222")]];
    s.review = async () => ok([finding("sec.x", "a.ts", "red"), finding("sec.y", "b.ts", "red")]);
    await runLoop(s.deps, opts());
    expect(s.notices).toEqual([{ event: "pr", severity: "warn", text: "Loop de revisão: achado bloqueante novo em #7 (1)" }]);
  });

  test("dado a primeira revisão da PR, quando o prompt é montado, então não há contexto de achados abertos", async () => {
    const r = rig();
    r.candidates = [[pr(7, "aaaa1111")]];
    await runLoop(r.deps, opts());
    expect(r.requests[0]?.contextFile).toBeUndefined();
    expect(priorContext(undefined)).toBe("");
  });

  test("newFindings ignora a linha: o mesmo código no mesmo arquivo é o mesmo achado", () => {
    const novos = newFindings([finding("a", "x.ts", "red", 1)], [finding("a", "x.ts", "red", 99), finding("a", "y.ts")]);
    expect(novos).toEqual([finding("a", "y.ts")]);
  });

  test("parseFindings lê as linhas HADES-ACHADO, descarta lixo e repetição", () => {
    const text = "relatório\nHADES-ACHADO: red|novo|sec.x|a/b.ts|12\nHADES-ACHADO: yellow|aberto|py.y|c.ts|3\nHADES-ACHADO: red|novo|sec.x|a/b.ts|40\nHADES-ACHADO: roxo|novo|z|w|1\nHADES-REVIEW: verdict=red";
    expect(parseFindings(text)).toEqual([finding("sec.x", "a/b.ts", "red", 40), finding("py.y", "c.ts", "yellow", 3)]);
  });
});

describe("concorrência", () => {
  test("dado um loop rodando, quando outro sobe no mesmo repositório, então o segundo recusa e não revisa nada", async () => {
    const a = rig();
    a.candidates = [[pr(7, "aaaa1111")]];
    const b = { ...rig(), } as Rig;
    b.deps = { ...b.deps, work: a.deps.work };
    b.candidates = [[pr(8, "bbbb2222")]];
    let segundo: Awaited<ReturnType<typeof runLoop>> | undefined;
    const primeiro = runLoop({ ...a.deps, reviewPr: async (req) => {
      segundo = await runLoop(b.deps, opts());
      return ok([], String(req.pr));
    } }, opts({ rounds: 1 }));
    await primeiro;
    expect(segundo?.code).toBe(1);
    expect(b.requests).toEqual([]);
    expect(b.logs.join("\n")).toContain("já existe um loop de revisão rodando");
  });
});

describe("limite de uso", () => {
  test("dado a janela de 5 h acima do limiar, quando a rodada começa, então pausa, avisa uma vez e retoma quando baixa", async () => {
    const r = rig();
    r.candidates = [[pr(7, "aaaa1111")]];
    r.usage = { five: { pct: 91.4, resetsAt: Math.floor(T0 / 1000) + 3600 } };
    r.onSleep = () => { if (r.clock.t >= T0 + 35 * MIN) r.usage = { five: { pct: 20, resetsAt: Math.floor(T0 / 1000) + 3600 } }; };
    await runLoop(r.deps, opts({ rounds: 1 }));
    expect(r.notices.filter((n) => n.event === "agent")).toHaveLength(1);
    expect(r.notices[0]?.text).toContain("janela de 5 h em 91% (limiar 85%)");
    expect(r.requests.map((q) => q.pr)).toEqual([7]);
    expect(readPrState(r.dir, 7)?.headOid).toBe("aaaa1111");
  });

  test("dado a janela semanal acima do limiar sem renovar, quando pausada por várias rodadas, então o aviso não se repete", async () => {
    const r = rig();
    r.candidates = [[pr(7, "aaaa1111")]];
    r.usage = { seven: { pct: 95, resetsAt: Math.floor(T0 / 1000) + 86_400 } };
    r.onSleep = () => { if (r.clock.t >= T0 + 100 * MIN) requestStop(r.dir); };
    const res = await runLoop(r.deps, opts({ rounds: undefined }));
    expect(res.stop).toBe("comando");
    expect(r.requests).toEqual([]);
    expect(r.logs.filter((l) => l.startsWith("WARN loop pausado"))).toHaveLength(4);
    expect(r.notices).toHaveLength(1);
  });

  test("dado janela sem medida, quando a rodada roda, então não pausa", async () => {
    const r = rig();
    r.candidates = [[pr(7, "aaaa1111")]];
    r.usage = {};
    await runLoop(r.deps, opts());
    expect(r.requests).toHaveLength(1);
  });
});

describe("paradas", () => {
  test("--rounds N: para depois de N rodadas e a segunda, no mesmo head, não revisa de novo", async () => {
    const r = rig();
    r.candidates = [[pr(7, "aaaa1111")]];
    const res = await runLoop(r.deps, opts({ rounds: 2 }));
    expect(res.stop).toBe("rodadas");
    expect(res.rounds).toBe(2);
    expect(r.requests).toHaveLength(1);
  });

  test("um push entre rodadas gera a revisão na rodada seguinte", async () => {
    const r = rig();
    r.candidates = [[pr(7, "aaaa1111")], [pr(7, "bbbb2222")]];
    await runLoop(r.deps, opts({ rounds: 2 }));
    expect(r.requests.map((q) => q.headOid)).toEqual(["aaaa1111", "bbbb2222"]);
  });

  test("--until: para quando o relógio passa da hora, sem esperar a rodada seguinte", async () => {
    const r = rig();
    r.candidates = [[pr(7, "aaaa1111")]];
    const res = await runLoop(r.deps, opts({ rounds: undefined, untilMs: T0 + 45 * MIN }));
    expect(res.stop).toBe("ate");
    expect(r.clock.t).toBe(T0 + 45 * MIN);
  });

  test("comando de parar: o loop dorme e encerra quando o pedido chega", async () => {
    const r = rig();
    r.candidates = [[pr(7, "aaaa1111")]];
    r.onSleep = () => { if (r.clock.t >= T0 + 10 * MIN) requestStop(r.dir); };
    const res = await runLoop(r.deps, opts({ rounds: undefined }));
    expect(res.stop).toBe("comando");
    expect(r.requests).toHaveLength(1);
    expect(r.clock.t).toBeLessThan(T0 + 30 * MIN);
  });

  test("escopo vazio: todas as PRs mergeadas ou fechadas encerram o loop sozinho", async () => {
    const r = rig();
    r.candidates = [[pr(7, "aaaa1111", { state: "MERGED" }), pr(8, "bbbb2222", { state: "CLOSED" })]];
    const res = await runLoop(r.deps, opts({ rounds: undefined }));
    expect(res.stop).toBe("escopo-vazio");
    expect(r.requests).toEqual([]);
  });

  test("busca vazia do gh também é escopo vazio", async () => {
    const r = rig();
    r.candidates = [[]];
    expect((await runLoop(r.deps, opts({ rounds: undefined }))).stop).toBe("escopo-vazio");
  });

  test("falha da busca não derruba o loop: a rodada não conta e a seguinte tenta de novo", async () => {
    const r = rig();
    let calls = 0;
    r.deps.listCandidates = () => {
      if (++calls === 1) throw new Error("gh: sem rede");
      return [pr(7, "aaaa1111")];
    };
    await runLoop(r.deps, opts({ rounds: 1 }));
    expect(r.requests).toHaveLength(1);
    expect(r.logs.join("\n")).toContain("a busca das PRs falhou (gh: sem rede)");
  });
});

describe("--dry-run", () => {
  test("mostra o plano da rodada e não revisa, não trava, não grava estado nem status", async () => {
    const r = rig();
    writePrState(loopDir(r.deps.work), state(7, "aaaa1111"));
    r.candidates = [[pr(7, "aaaa1111"), pr(8, "bbbb2222"), pr(9, "cccc3333", { isDraft: true })]];
    const res = await runLoop(r.deps, opts({ dryRun: true, rounds: undefined }));
    expect(res.code).toBe(0);
    expect(r.requests).toEqual([]);
    expect(r.logs).toContain("rodada 1: #7 pular: head igual ao último revisado · #8 revisar (nunca revisada bbbb2222) · #9 pular: rascunho (só entra se pedida com --pr)");
    expect(existsSync(join(r.dir, "status.json"))).toBe(false);
    expect(existsSync(join(r.locks, "pr-8.lock"))).toBe(false);
    expect(readPrState(r.dir, 8)).toBeUndefined();
  });
});

describe("argumentos", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  test("lê escopo, cadência e paradas", () => {
    const o = parseLoopArgs(["--loop", "--every", "45m", "--pr", "7", "--pr=9", "--max", "2", "--deep", "--rounds", "3", "--until", "2026-11-04T18:00:00Z", "--no-post"], now, 0, 30);
    expect(o).toMatchObject({ everyMs: 45 * MIN, prs: [7, 9], max: 2, deep: true, rounds: 3, untilMs: Date.parse("2026-11-04T18:00:00Z"), post: false });
  });
  test("padrão da cadência vem da configuração", () => {
    expect(parseLoopArgs(["--loop"], now, 0, 20).everyMs).toBe(20 * MIN);
  });
  test("HH:MM vale no fuso do dono e, já passada, vale amanhã", () => {
    expect(parseLoopArgs(["--until", "18:00"], now, -180, 30).untilMs).toBe(Date.parse("2026-11-04T21:00:00Z"));
    expect(parseLoopArgs(["--until", "08:00"], now, -180, 30).untilMs).toBe(Date.parse("2026-11-05T11:00:00Z"));
  });
  test.each([
    [["--every", "10s"]], [["--every", "30"]], [["--every", "48h"]], [["--until", "amanhã"]], [["--until", "2026-11-04T18:00:00"]],
    [["--author", "x", "--pr", "1"]], [["--rounds", "0"]], [["--pr", "abc"]], [["--wat"]], [["--max"]],
  ])("recusa %j", (args) => {
    expect(() => parseLoopArgs(args, now, 0, 30)).toThrow(LoopArgError);
  });
});
