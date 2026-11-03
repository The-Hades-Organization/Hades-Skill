// Grupo thanatos: post-mortem de incidente em produção do projeto (src/lib/thanatos*.ts, src/commands/thanatos.ts,
// src/panel/thanatos.ts, reference/thanatos.md). git e gh entram por dublê na fronteira (Exec), o relógio é injetado; o fim
// a fim usa a CLI real com um gh falso no PATH.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runThanatos, type ThanatosContext } from "../../../src/commands/thanatos";
import { HadesError } from "../../../src/lib/output";
import { gather, journalFacts, prOf, type Exec, type ProcResult } from "../../../src/lib/thanatos-gather";
import { declaredSource, fetchSource, parseSourceOutput, tokenFromCredentials } from "../../../src/lib/thanatos-source";
import {
  buildPostmortem, citedFiles, fixRuleOf, idOf, isProductionFix, listPostmortems, parseInput, readPostmortem, searchPostmortems,
  sectionOf, type Gathered, type PrFact, type SourceResult,
} from "../../../src/lib/thanatos";
import { createThanatosRoutes } from "../../../src/panel/thanatos";
import { BadRequest } from "../../../src/panel/http";
import { Rig } from "./lib/rig";

const r = new Rig();
afterAll(() => r.cleanup());

const NOW = new Date("2026-03-02T12:00:00.000Z");
const ok = (stdout: string): ProcResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): ProcResult => ({ status: 1, stdout: "", stderr });
const BODY = "## Impacto\nCheckout fora do ar por 2h.\n\n## Causa\nTimeout sem retry no gateway.\n\n## Correção\nRetry com backoff.\n";
const ghPr = (over: Record<string, unknown> = {}) => ({
  number: 12, title: "fix: retry no gateway", body: BODY, url: "https://example.invalid/pr/12", author: { login: "ana" }, headRefName: "fix/gateway",
  labels: [{ name: "incident" }], createdAt: "2026-03-01T12:00:00-03:00", mergedAt: "2026-03-01T17:00:00Z", state: "MERGED",
  commits: [{ oid: "a".repeat(40), messageHeadline: "fix: retry", authors: [{ login: "ana" }], committedDate: "2026-03-01T14:00:00Z" }],
  files: [{ path: "src/gateway.ts" }, { path: "src/pay.ts" }], reviews: [{ author: { login: "bia" }, submittedAt: "2026-03-01T16:00:00Z", state: "APPROVED" }],
  ...over,
});
const noSource: SourceResult = { status: "absent", note: "sem plugin", events: [], metrics: [] };

function tmp(name: string): string {
  const dir = `${r.T}/${name}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function capture(fn: () => number): { rc: number; out: string } {
  const real = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    return { rc: fn(), out };
  } finally {
    process.stdout.write = real;
  }
}

function context(name: string, exec: Exec, over: Partial<ThanatosContext> = {}): ThanatosContext {
  return {
    now: () => NOW, exec, dir: `${tmp(name)}/postmortems`, slug: "acme__fixer", repo: "acme/fixer", cardPattern: "FIX-[0-9]+",
    settings: { sourceTimeoutS: 20, ioTimeoutS: 20, maxPrs: 30, journalMax: 40 }, ...over,
  };
}

const prExec: Exec = (cmd, args) => (cmd === "gh" && args[0] === "pr" && args[1] === "view" ? ok(JSON.stringify(ghPr())) : fail(`inesperado: ${cmd} ${args.join(" ")}`));

describe("thanatos: entrada", () => {
  test("número de PR, com ou sem #, vira PR", () => {
    expect(parseInput("12")).toEqual({ kind: "pr", number: 12 });
    expect(parseInput("#12")).toEqual({ kind: "pr", number: 12 });
  });
  test("intervalo normaliza as pontas para UTC", () => {
    expect(parseInput("2026-03-01T09:00:00-03:00..2026-03-01T18:00:00Z")).toEqual({ kind: "range", from: "2026-03-01T12:00:00Z", to: "2026-03-01T18:00:00Z" });
  });
  test("intervalo sem fuso, vazio ou invertido é recusado", () => {
    for (const bad of ["2026-03-01T09:00:00..2026-03-01T18:00:00Z", "2026-03-02T00:00:00Z..2026-03-01T00:00:00Z", "x..y"]) {
      expect(() => parseInput(bad)).toThrow(HadesError);
    }
  });
  test("id de card só vale pelo idPattern do perfil, sem caixa", () => {
    expect(parseInput("fix-77", "FIX-[0-9]+")).toEqual({ kind: "card", id: "fix-77" });
    expect(() => parseInput("fix-77")).toThrow(HadesError);
    expect(() => parseInput("OUTRO-1", "FIX-[0-9]+")).toThrow(HadesError);
  });
  test("ids dos arquivos são estáveis e sem caracteres de caminho", () => {
    expect(idOf({ kind: "pr", number: 12 })).toBe("pr-12");
    expect(idOf({ kind: "card", id: "FIX-77/../x" })).toBe("card-fix-77-x");
    expect(idOf({ kind: "range", from: "2026-03-01T12:00:00Z", to: "2026-03-01T18:00:00Z" })).toBe("range-20260301T120000Z-20260301T180000Z");
  });
});

describe("thanatos: montagem a partir de PR", () => {
  const gathered = (): Gathered => ({ prs: [prOf(ghPr()) as PrFact], commits: [] });
  const withSource: SourceResult = {
    status: "ok", note: "1 evento", start: "2026-03-01T09:00:00Z", metrics: [{ name: "erros/min", value: 42 }],
    events: [{ ts: "2026-03-01T13:15:00Z", text: "erro 500 no checkout", level: "error" }],
  };

  test("linha do tempo em ordem e em UTC, de todas as fontes", () => {
    const pm = buildPostmortem({ kind: "pr", number: 12 }, gathered(), withSource, [{ ts: "2026-03-01T15:30:00Z", agent: "impl-x", kind: "watch.done", summary: "DONE impl-x" }], NOW);
    expect(pm.timeline.map((e) => `${e.ts} ${e.source}`)).toEqual([
      "2026-03-01T13:15:00Z fonte", "2026-03-01T14:00:00Z git", "2026-03-01T15:00:00Z gh", "2026-03-01T15:30:00Z diario", "2026-03-01T16:00:00Z gh", "2026-03-01T17:00:00Z gh",
    ]);
    expect(pm.timeline.every((e) => /Z$/.test(e.ts))).toBe(true);
  });
  test("seções vêm do corpo da PR e os dados da correção somam PRs, commits, arquivos e autores", () => {
    const pm = buildPostmortem({ kind: "pr", number: 12 }, gathered(), withSource, [], NOW);
    expect(pm).toMatchObject({ v: 1, id: "pr-12", createdAt: "2026-03-02T12:00:00Z", impact: "Checkout fora do ar por 2h.", cause: "Timeout sem retry no gateway.", fix: "Retry com backoff." });
    expect(pm.fixData).toMatchObject({ files: ["src/gateway.ts", "src/pay.ts"], authors: ["ana"], commits: [{ sha: "a".repeat(12), author: "ana" }] });
    expect(pm.fixData.timeToFix).toEqual({ ms: 8 * 3_600_000, from: "2026-03-01T09:00:00Z", to: "2026-03-01T17:00:00Z", basis: "fonte" });
    expect(pm.gaps).toEqual([]);
  });
  test("sem a fonte, o tempo conta do primeiro commit e a lacuna diz o que faltou", () => {
    const pm = buildPostmortem({ kind: "pr", number: 12 }, gathered(), noSource, [], NOW);
    expect(pm.fixData.timeToFix).toMatchObject({ ms: 3 * 3_600_000, basis: "primeiro-commit" });
    expect(pm.gaps).toEqual(["fonte externa: sem plugin"]);
  });
  test("PR sem seções declara as lacunas de causa e impacto; PR sem merge não tem tempo de correção", () => {
    const pr = prOf(ghPr({ body: "só um texto", mergedAt: null, state: "OPEN" })) as PrFact;
    const pm = buildPostmortem({ kind: "pr", number: 12 }, { prs: [pr], commits: [] }, noSource, [], NOW);
    expect(pm.fixData.timeToFix).toBeNull();
    expect(pm.gaps.filter((g) => /causa|impacto|mergeada/.test(g)).length).toBeGreaterThanOrEqual(4);
  });
  test("sectionOf pega até o próximo cabeçalho e ignora caixa e dois-pontos", () => {
    expect(sectionOf("# Intro\nx\n### Causa raiz:\nA\nB\n## Outra\nC", ["causa raiz"])).toBe("A\nB");
    expect(sectionOf("sem cabeçalho", ["causa"])).toBe("");
  });
});

describe("thanatos: new, list, show, search (contexto injetado)", () => {
  test("new a partir de PR grava .md e .json e recusa sobrescrever sem --force", () => {
    const ctx = context("new-pr", prExec);
    const first = capture(() => runThanatos(["new", "12"], () => ctx));
    expect(first.rc).toBe(0);
    expect(first.out).toContain("post-mortem pr-12 gravado");
    const md = readFileSync(`${ctx.dir}/pr-12.md`, "utf8");
    for (const heading of ["## Resumo", "## Impacto", "## Linha do tempo (UTC)", "## Causa", "## Como foi corrigido", "## Dados da correção", "## Lacunas"]) expect(md).toContain(heading);
    expect(readPostmortem(ctx.dir, "pr-12")?.createdAt).toBe("2026-03-02T12:00:00Z");
    expect(() => capture(() => runThanatos(["new", "12"], () => ctx))).toThrow(/já existe/);
    expect(capture(() => runThanatos(["new", "12", "--force"], () => ctx)).rc).toBe(0);
  });
  test("new de intervalo lê as PRs mergeadas e os commits do git, sem duplicar commit de PR", () => {
    const calls: string[] = [];
    const exec: Exec = (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "gh" && args[1] === "list") return ok(JSON.stringify([{ number: 12 }]));
      if (cmd === "gh" && args[1] === "view") return ok(JSON.stringify(ghPr()));
      if (cmd === "git") return ok(`${"a".repeat(40)}\x1fana\x1f2026-03-01T11:00:00-03:00\x1ffix: retry\n${"b".repeat(40)}\x1fcaio\x1f2026-03-01T16:30:00+00:00\x1fchore: logs\n`);
      return fail("inesperado");
    };
    const ctx = context("new-range", exec);
    const res = capture(() => runThanatos(["new", "2026-03-01T00:00:00Z..2026-03-02T00:00:00Z", "--json"], () => ctx));
    const pm = JSON.parse(res.out);
    expect(pm.id).toBe("range-20260301T000000Z-20260302T000000Z");
    expect(pm.fixData.commits.map((c: { sha: string }) => c.sha[0])).toEqual(["a", "b"]);
    expect(pm.fixData.timeToFix.basis).toBe("intervalo");
    expect(calls.find((c) => c.startsWith("gh pr list"))).toContain("merged:2026-03-01T00:00:00Z..2026-03-02T00:00:00Z");
  });
  test("new de card busca as PRs mergeadas que citam o id (título, branch ou corpo)", () => {
    const exec: Exec = (cmd, args) => {
      if (args[1] === "list") return ok(JSON.stringify([{ number: 12, title: "FIX-77 retry", headRefName: "x", body: "" }, { number: 13, title: "outra", headRefName: "y", body: "" }]));
      return args[1] === "view" && args[2] === "12" ? ok(JSON.stringify(ghPr())) : fail("só a 12 deveria ser lida");
    };
    const ctx = context("new-card", exec);
    const pm = JSON.parse(capture(() => runThanatos(["new", "FIX-77", "--json"], () => ctx)).out);
    expect(pm.id).toBe("card-fix-77");
    expect(pm.fixData.prs.map((p: { number: number }) => p.number)).toEqual([12]);
  });
  test("falha do gh vira erro com a causa, sem gravar nada", () => {
    const ctx = context("new-erro", () => fail("HTTP 404: Not Found"));
    expect(() => capture(() => runThanatos(["new", "99"], () => ctx))).toThrow(/gh pr view 99: HTTP 404/);
    expect(listPostmortems(ctx.dir)).toEqual([]);
  });
  test("list, show e search, com --json em todos", () => {
    const ctx = context("leitura", prExec);
    capture(() => runThanatos(["new", "12"], () => ctx));
    const list = capture(() => runThanatos(["list", "--json"], () => ctx));
    expect(JSON.parse(list.out)).toEqual([expect.objectContaining({ id: "pr-12", kind: "pr", prs: [12], files: 2, gaps: 1, timeToFixMs: 3 * 3_600_000 })]);
    expect(capture(() => runThanatos(["list"], () => ctx)).out).toContain("pr-12\t2026-03-02T12:00:00Z\tpr\t#12\tfix: retry no gateway");
    expect(capture(() => runThanatos(["show", "pr-12"], () => ctx)).out).toContain("# Post-mortem pr-12");
    expect(JSON.parse(capture(() => runThanatos(["show", "pr-12", "--json"], () => ctx)).out).id).toBe("pr-12");
    expect(JSON.parse(capture(() => runThanatos(["search", "BACKOFF", "--json"], () => ctx)).out)).toEqual([expect.objectContaining({ id: "pr-12", line: "Retry com backoff." })]);
    expect(searchPostmortems(ctx.dir, ".*")).toEqual([]);
    expect(() => capture(() => runThanatos(["show", "nao-existe"], () => ctx))).toThrow(/não encontrado/);
    expect(() => capture(() => runThanatos(["show", "../x"], () => ctx))).toThrow(/inválido/);
  });
  test("list sem post-mortem e sem pasta é vazio", () => {
    expect(listPostmortems(`${r.T}/nada/postmortems`)).toEqual([]);
  });
});

describe("thanatos: gather (fronteira)", () => {
  test("campos ausentes do gh viram vazio, nunca valor inventado", () => {
    expect(prOf({ number: 5 })).toMatchObject({ number: 5, title: "", author: "", mergedAt: null, commits: [], files: [], reviews: [] });
    expect(prOf({ title: "sem número" })).toBeUndefined();
  });
  test("gh que devolve texto que não é JSON é erro claro", () => {
    expect(() => gather({ kind: "pr", number: 1 }, () => ok("<html>"), { repo: "a/b", maxPrs: 5, journalMax: 5 })).toThrow(/não é JSON/);
  });
  test("o teto de PRs vai ao gh", () => {
    let seen: string[] = [];
    gather({ kind: "range", from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" }, (c, a) => { if (c === "gh") seen = a; return c === "git" ? ok("") : ok("[]"); }, { repo: "a/b", maxPrs: 7, journalMax: 5 });
    expect(seen[seen.indexOf("--limit") + 1]).toBe("7");
  });
});

describe("thanatos: diário na linha do tempo", () => {
  const root = `${r.T}/jroot`;
  const line = (ts: string, kind: string, summary: string) => JSON.stringify({ v: 1, ts, agent: "impl-x", session: "s", source: "watch", kind, summary, cwd: "/w" });
  mkdirSync(`${root}/acme__fixer/journal`, { recursive: true });
  mkdirSync(`${root}/outro__repo/journal`, { recursive: true });
  writeFileSync(`${root}/acme__fixer/journal/impl-x.jsonl`, [
    line("2026-03-01T15:30:00Z", "watch.done", "DONE impl-x"), line("2026-03-01T15:31:00Z", "tool_pre", "Bash ls"),
    line("2026-03-05T00:00:00Z", "watch.done", "fora do período"), "linha que não parseia",
  ].join("\n") + "\n");
  writeFileSync(`${root}/outro__repo/journal/z.jsonl`, `${line("2026-03-01T15:40:00Z", "watch.done", "de outro projeto")}\n`);

  test("só o projeto, só o período, sem ruído de ferramenta e sem a linha quebrada", () => {
    expect(journalFacts("acme__fixer", "2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z", 10, root)).toEqual([
      { ts: "2026-03-01T15:30:00Z", agent: "impl-x", kind: "watch.done", summary: "DONE impl-x" },
    ]);
  });
  test("o new inclui os eventos do diário na janela da PR", () => {
    const ctx = context("diario", prExec, { journalRoot: root });
    const pm = JSON.parse(capture(() => runThanatos(["new", "12", "--json"], () => ctx)).out);
    expect(pm.timeline.filter((e: { source: string }) => e.source === "diario")).toHaveLength(1);
  });
});

describe("thanatos: fonte externa do plugin", () => {
  const SCRIPT = (body: string) => `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`;
  function plugin(name: string, commands: unknown, scripts: Record<string, string> = {}): string {
    const env = tmp(`plugin-${name}/env`);
    writeFileSync(`${env}/plugin.json`, JSON.stringify({ name, commands }));
    for (const [file, body] of Object.entries(scripts)) {
      mkdirSync(`${env}/${file.split("/").slice(0, -1).join("/") || "."}`, { recursive: true });
      writeFileSync(`${env}/${file}`, body);
      chmodSync(`${env}/${file}`, 0o755);
    }
    return env;
  }
  const deps = (envDir: string | undefined, credentials?: string) => ({ envDir, credentials, timeoutS: 10 });
  const FROM = "2026-03-01T09:00:00Z";
  const TO = "2026-03-01T18:00:00Z";
  const GOOD = SCRIPT(`echo '{"v":1,"start":"2026-03-01T09:00:00Z","events":[{"ts":"2026-03-01T10:15:00-03:00","text":"erro 500 após $1 até $2 --token valor1234","level":"error"},{"ts":"sem-fuso","text":"descartado"}],"metrics":[{"name":"erros/min","value":42,"unit":"1/min"},{"name":"ruim","value":"x"}]}'`);

  test("sem plugin ou sem o comando declarado: ausente, com o motivo", () => {
    expect(fetchSource(FROM, TO, deps(undefined))).toMatchObject({ status: "absent", note: expect.stringContaining("env/") });
    expect(fetchSource(FROM, TO, deps(plugin("vazio", [])))).toMatchObject({ status: "absent", note: expect.stringContaining("thanatos-source") });
  });
  test("script fora do env/ ou de tipo desconhecido é recusado", () => {
    expect(declaredSource(plugin("fora", [{ name: "thanatos-source", script: "../x.sh" }]))).toHaveProperty("absent");
    expect(declaredSource(plugin("abs", [{ name: "thanatos-source", script: "/bin/ls" }]))).toHaveProperty("absent");
    expect(declaredSource(plugin("tipo", [{ name: "thanatos-source", script: "commands/s.py" }], { "commands/s.py": "print(1)" }))).toHaveProperty("absent");
  });
  test("plugin de exemplo: eventos e métricas validados, em UTC e com segredo mascarado", () => {
    const env = plugin("ok", [{ name: "thanatos-source", script: "commands/thanatos-source.sh" }], { "commands/thanatos-source.sh": GOOD });
    const res = fetchSource(FROM, TO, deps(env));
    expect(res.status).toBe("ok");
    expect(res.start).toBe(FROM);
    expect(res.events).toEqual([{ ts: "2026-03-01T13:15:00Z", text: "erro 500 após $1 até $2 --token ***", level: "error" }]);
    expect(res.metrics).toEqual([{ name: "erros/min", value: 42, unit: "1/min" }]);
  });
  test("token declarado e ausente de credenciais.md: no-token, sem rodar o script", () => {
    const env = plugin("tok", [{ name: "thanatos-source", script: "commands/s.sh", tokenKey: "FONTE_TOKEN" }], { "commands/s.sh": SCRIPT("echo '{\"v\":1}' > \"$(dirname \"$0\")/rodou\"; echo '{\"v\":1}'") });
    expect(fetchSource(FROM, TO, deps(env, "OUTRA=1"))).toMatchObject({ status: "no-token", note: expect.stringContaining("FONTE_TOKEN") });
    expect(existsSync(`${env}/commands/rodou`)).toBe(false);
  });
  test("o token chega ao script pela variável do contrato e não aparece no resultado", () => {
    const env = plugin("tok2", [{ name: "thanatos-source", script: "commands/s.sh", tokenKey: "FONTE_TOKEN" }], {
      "commands/s.sh": SCRIPT(`echo '{"v":1,"events":[{"ts":"2026-03-01T10:00:00Z","text":"tamanho '"\${#HADES_THANATOS_TOKEN}"'"}]}'`),
    });
    const res = fetchSource(FROM, TO, deps(env, "- FONTE_TOKEN=abcdefghij\n"));
    expect(res.status).toBe("ok");
    expect(JSON.stringify(res)).not.toContain("abcdefghij");
    expect(res.events[0]?.text).toBe("tamanho 10");
  });
  test("script que falha, passa do tempo ou devolve lixo: erro, e o post-mortem sai com a lacuna", () => {
    const bad = plugin("rc", [{ name: "thanatos-source", script: "commands/s.sh" }], { "commands/s.sh": SCRIPT("echo 'Loki fora do ar' >&2; exit 3") });
    expect(fetchSource(FROM, TO, deps(bad))).toMatchObject({ status: "error", note: "thanatos-source saiu com 3: Loki fora do ar" });
    const slow = plugin("lento", [{ name: "thanatos-source", script: "commands/s.sh" }], { "commands/s.sh": SCRIPT("sleep 5") });
    expect(fetchSource(FROM, TO, { envDir: slow, credentials: undefined, timeoutS: 1 })).toMatchObject({ status: "error", note: "thanatos-source passou de 1s" });
    const lixo = plugin("lixo", [{ name: "thanatos-source", script: "commands/s.sh" }], { "commands/s.sh": SCRIPT("echo nada") });
    expect(fetchSource(FROM, TO, deps(lixo))).toMatchObject({ status: "error", note: expect.stringContaining("contrato") });
    const ctx = context("fonte-erro", prExec, { pluginEnv: bad });
    const pm = JSON.parse(capture(() => runThanatos(["new", "12", "--json"], () => ctx)).out);
    expect(pm.gaps).toContain("fonte externa: thanatos-source saiu com 3: Loki fora do ar");
    expect(pm.source.status).toBe("error");
  });
  test("parse da saída: v maior vale, v ausente não; token em credenciais.md tolera formatos", () => {
    expect(parseSourceOutput('{"v":2,"campo_novo":1}')).toEqual({ events: [], metrics: [] });
    expect(parseSourceOutput('{"events":[]}')).toBeUndefined();
    expect(tokenFromCredentials("A=1\n`K_TOKEN`: \"valor\"\n", "K_TOKEN")).toBe("valor");
    expect(tokenFromCredentials("K_TOKEN=\n", "K_TOKEN")).toBeUndefined();
  });
});

describe("thanatos: sugestão no watch e aviso de arquivo citado", () => {
  test("a regra do perfil casa por branch (sem caixa) ou por label; sem regra, nunca sugere", () => {
    const rule = fixRuleOf({ thanatos: { fixBranchPattern: "^(hotfix|fix)/", fixLabels: ["Incident"] } });
    expect(isProductionFix(rule, { branch: "Hotfix/pagamento", labels: [] })).toBe(true);
    expect(isProductionFix(rule, { branch: "feat/x", labels: ["incident"] })).toBe(true);
    expect(isProductionFix(rule, { branch: "feat/x", labels: ["bug"] })).toBe(false);
    expect(fixRuleOf({})).toBeUndefined();
    expect(fixRuleOf({ thanatos: {} })).toBeUndefined();
    expect(isProductionFix(undefined, { branch: "fix/x", labels: ["incident"] })).toBe(false);
  });
  test("regex inválida ou grande demais no perfil não derruba nem sugere", () => {
    expect(fixRuleOf({ thanatos: { fixBranchPattern: "(" } })).toBeUndefined();
    expect(fixRuleOf({ thanatos: { fixBranchPattern: "a".repeat(201) } })).toBeUndefined();
  });
  test("cited avisa só dos arquivos que algum post-mortem citou, por caminho exato", () => {
    const ctx = context("cited", prExec);
    capture(() => runThanatos(["new", "12"], () => ctx));
    expect(citedFiles(ctx.dir, ["src/gateway.ts", "src/outro.ts", "gateway.ts"])).toEqual([
      { file: "src/gateway.ts", id: "pr-12", title: "fix: retry no gateway", mergedAt: "2026-03-01T17:00:00Z" },
    ]);
    const warn = capture(() => runThanatos(["cited", "src/pay.ts", "src/livre.ts"], () => ctx));
    expect(warn.rc).toBe(0);
    expect(warn.out).toContain("AVISO src/pay.ts já foi citado no post-mortem pr-12");
    expect(warn.out).not.toContain("livre");
    expect(capture(() => runThanatos(["cited", "src/livre.ts"], () => ctx)).out).toBe("");
    const viaBase = context("cited-base", (c, a) => (c === "git" && a[0] === "diff" ? ok("src/gateway.ts\n") : prExec(c, a)), { dir: ctx.dir });
    expect(capture(() => runThanatos(["cited", "--base", "origin/main", "--json"], () => viaBase)).out).toContain('"id":"pr-12"');
  });
});

describe("thanatos: rotas do painel", () => {
  const env = { locks: `${r.T}/painel/work/acme__fixer/locks` } as Parameters<typeof createThanatosRoutes>[0];
  const dir = `${r.T}/painel/work/acme__fixer/postmortems`;
  test("lista e leitura vêm da pasta do projeto; id fora do padrão é 400 e inexistente é undefined", () => {
    const routes = createThanatosRoutes(env);
    expect(routes.list()).toEqual({ items: [] });
    capture(() => runThanatos(["new", "12"], () => context("painel-x", prExec, { dir })));
    expect(routes.list().items).toEqual([expect.objectContaining({ id: "pr-12" })]);
    expect(routes.one("pr-12")).toMatchObject({ id: "pr-12", markdown: expect.stringContaining("## Causa"), postmortem: { v: 1 } });
    expect(routes.one("pr-99")).toBeUndefined();
    for (const bad of ["../x", ".oculto", "a/b", ""]) expect(() => routes.one(bad)).toThrow(BadRequest);
  });
  test("painel sem pasta de locks lista vazio", () => {
    const routes = createThanatosRoutes({ locks: undefined } as Parameters<typeof createThanatosRoutes>[0]);
    expect(routes.list()).toEqual({ items: [] });
    expect(routes.one("pr-1")).toBeUndefined();
  });
});
