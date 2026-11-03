// Grupo canvas-content-route: /api/canvas-content/* (src/panel/canvas-content.ts) — árvore da worktree de agente registrado
// (marca do que mudou na branch, tetos, caminho contido, symlink, `.git`), plano (lista, parser, ligação ao agente, nome
// contido, teto de tamanho) e o regime de acesso do painel real (chave remota). Tudo em pasta temporária; git de verdade.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_LIMITS } from "../../../src/lib/canvas-plan";
import {
  CHANGES_UNAVAILABLE,
  CONTENT_ERRORS,
  CONTENT_LIMITS,
  createCanvasContentRoutes,
  parseNameStatus,
  parseRelPath,
  type ContentDeps,
} from "../../../src/panel/canvas-content";
import type { Exec } from "../../../src/panel/exec";
import { Rig } from "./lib/rig";
import { fetchRaw, remoteHeaders, startTestPanel, widgetData } from "./lib/widget-rig";

type Dict = Record<string, unknown>;

const ROOT = mkdtempSync(join(tmpdir(), "canvas-content-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const PLANS = join(ROOT, "plans");
const ORCH = join(ROOT, "work", "_skill", "orchestration");
const registries = (): { slug: string; orch: string }[] => [{ slug: "_skill", orch: ORCH }];

const write = (file: string, text: string): void => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** Repositório com `main` e uma branch com um arquivo mudado, um novo e um apagado. */
function repo(name: string): string {
  const dir = join(ROOT, "trees", name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  write(join(dir, "keep.txt"), "um\n");
  write(join(dir, "src", "a.ts"), "a\n");
  write(join(dir, "src", "deep", "b.ts"), "b\n");
  write(join(dir, "gone.txt"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base");
  git(dir, "checkout", "-b", "feat");
  write(join(dir, "src", "a.ts"), "a2\n");
  write(join(dir, "src", "deep", "novo.ts"), "n\n");
  rmSync(join(dir, "gone.txt"));
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "mudanças");
  return dir;
}

function agent(name: string, extra: Dict = {}): void {
  write(join(ORCH, "agents", `${name}.json`), JSON.stringify({ name, role: "impl", base: "main", state: "working", ...extra }));
}

const routes = (over: Partial<ContentDeps> = {}) => createCanvasContentRoutes({ registries, plansDir: PLANS, ...over });
const call = async (r: ReturnType<typeof routes>, path: string, query: Record<string, string> = {}): Promise<{ status: number; body: Dict }> => {
  const res = await r.get(path, query);
  if (!res) throw new Error(`rota não atendida: ${path}`);
  return { status: res.status, body: (await res.json()) as Dict };
};
const tree = (r: ReturnType<typeof routes>, query: Record<string, string>) => call(r, "/api/canvas-content/tree", query);
const entries = (body: Dict): { path: string; type: string; change: string | null; changedBelow: number }[] => body.entries as never;
const paths = (body: Dict): string[] => entries(body).map((e) => e.path);

let feat = "";
beforeAll(() => {
  feat = repo("feat");
  agent("u-feat", { worktree: feat, branch: "feat" });
});

describe("canvas-content-route: árvore da worktree", () => {
  test("dado agente registrado, lista a raiz (pastas primeiro, depois nome) sem o .git e marca o que mudou na branch", async () => {
    const { status, body } = await tree(routes(), { agent: "u-feat" });
    expect(status).toBe(200);
    expect(paths(body)).toEqual(["src", "keep.txt"]);
    expect(body).toMatchObject({ agent: "u-feat", registry: "_skill", path: "", depth: 1, truncated: false });
    expect(body.changes).toMatchObject({ base: "main", available: true });
    const byPath = Object.fromEntries(entries(body).map((e) => [e.path, e]));
    expect(byPath.src).toMatchObject({ type: "dir", changedBelow: 2, change: null });
    expect(byPath["keep.txt"]).toMatchObject({ type: "file", changedBelow: 0, change: null });
  });

  test("dado profundidade 3, desce e marca A, M e D (o apagado só consta em changes.files)", async () => {
    const { body } = await tree(routes(), { agent: "u-feat", depth: "3" });
    const byPath = Object.fromEntries(entries(body).map((e) => [e.path, e.change]));
    expect(byPath["src/a.ts"]).toBe("M");
    expect(byPath["src/deep/novo.ts"]).toBe("A");
    expect(byPath["src/deep/b.ts"]).toBeNull();
    expect((body.changes as { files: { path: string; status: string }[] }).files).toContainEqual({ path: "gone.txt", status: "D" });
  });

  test("dado subcaminho, lista a pasta com os caminhos relativos à raiz da worktree", async () => {
    const { body } = await tree(routes(), { agent: "u-feat", path: "src/deep" });
    expect(paths(body)).toEqual(["src/deep/b.ts", "src/deep/novo.ts"]);
    expect(body.path).toBe("src/deep");
    expect(entries(body)[1]).toMatchObject({ change: "A" });
  });

  test("dado o teto de entradas, corta no teto e avisa em truncated", async () => {
    const { body } = await tree(routes({ limits: { entries: 2 } }), { agent: "u-feat", depth: "3" });
    expect(entries(body)).toHaveLength(2);
    expect(body.truncated).toBe(true);
  });

  test("dado pasta vazia, devolve entries vazio sem erro", async () => {
    const dir = join(ROOT, "trees", "vazia");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-b", "main");
    agent("u-vazia", { worktree: dir, base: "main" });
    const { status, body } = await tree(routes(), { agent: "u-vazia" });
    expect([status, body.entries, body.truncated]).toEqual([200, [], false]);
  });

  test("dado profundidade fora de 1..teto, não inteira ou vazia de sentido, responde 400 invalid_depth", async () => {
    for (const depth of ["0", String(CONTENT_LIMITS.depth + 1), "x", "-1", "1.5", "999"]) {
      const { status, body } = await tree(routes(), { agent: "u-feat", depth });
      expect([depth, status, body.code]).toEqual([depth, 400, CONTENT_ERRORS.invalidDepth]);
    }
  });

  test("dado nome de agente fora do registro ou malformado, responde unknown_agent 404 ou invalid_agent 400", async () => {
    expect(await tree(routes(), { agent: "nao-existe" })).toMatchObject({ status: 404, body: { code: CONTENT_ERRORS.unknownAgent } });
    for (const name of ["", "../u-feat", "a/b", "x".repeat(81)]) {
      expect(await tree(routes(), name === "" ? {} : { agent: name })).toMatchObject({ status: 400, body: { code: CONTENT_ERRORS.invalidAgent } });
    }
  });

  test("dado registry que não é o do agente, o agente é desconhecido", async () => {
    expect(await tree(routes(), { agent: "u-feat", registry: "outro__repo" })).toMatchObject({ status: 404, body: { code: CONTENT_ERRORS.unknownAgent } });
    expect((await tree(routes(), { agent: "u-feat", registry: "_skill" })).status).toBe(200);
  });

  test("dado caminho com .., absoluto, barra invertida, NUL ou longo demais, responde 400 invalid_path", async () => {
    const tooDeep = Array.from({ length: CONTENT_LIMITS.pathSegments + 1 }, () => "a").join("/");
    for (const path of ["..", "src/../..", "/etc", "src\\deep", "src\0", "a".repeat(CONTENT_LIMITS.pathChars + 1), tooDeep]) {
      const { status, body } = await tree(routes(), { agent: "u-feat", path });
      expect([status, body.code]).toEqual([400, CONTENT_ERRORS.invalidPath]);
    }
  });

  test("dado caminho que não existe, é de arquivo ou é o .git, responde como inexistente ou não-pasta, sem vazar o caminho", async () => {
    expect(await tree(routes(), { agent: "u-feat", path: "nao/existe" })).toMatchObject({ status: 404, body: { code: CONTENT_ERRORS.pathNotFound } });
    expect(await tree(routes(), { agent: "u-feat", path: ".git" })).toMatchObject({ status: 404, body: { code: CONTENT_ERRORS.pathNotFound } });
    expect(await tree(routes(), { agent: "u-feat", path: ".git/objects" })).toMatchObject({ status: 404, body: { code: CONTENT_ERRORS.pathNotFound } });
    const file = await tree(routes(), { agent: "u-feat", path: "keep.txt" });
    expect([file.status, file.body.code]).toEqual([400, CONTENT_ERRORS.notDirectory]);
    expect(JSON.stringify(file.body)).not.toContain(ROOT);
  });

  test("dado symlink para fora da worktree, não segue: lista como symlink e o caminho por ele é inexistente", async () => {
    const outside = join(ROOT, "fora");
    write(join(outside, "segredo.txt"), "s\n");
    symlinkSync(outside, join(feat, "atalho"));
    const root = await tree(routes(), { agent: "u-feat" });
    expect(entries(root.body).find((e) => e.path === "atalho")).toMatchObject({ type: "symlink" });
    const deep = await tree(routes(), { agent: "u-feat", depth: "4" });
    expect(paths(deep.body).some((p) => p.includes("segredo"))).toBe(false);
    const through = await tree(routes(), { agent: "u-feat", path: "atalho" });
    expect([through.status, through.body.code]).toEqual([404, CONTENT_ERRORS.pathNotFound]);
    rmSync(join(feat, "atalho"));
  });

  test("dado worktree ausente ou fora do registro, responde worktree_missing 404", async () => {
    agent("u-sem-tree", { worktree: join(ROOT, "trees", "apagada") });
    agent("u-sem-campo");
    for (const name of ["u-sem-tree", "u-sem-campo"]) {
      expect(await tree(routes(), { agent: name })).toMatchObject({ status: 404, body: { code: CONTENT_ERRORS.worktreeMissing } });
    }
  });

  test("dado base ausente ou malformada no registro, lista a árvore sem marcas e diz por que (no_base)", async () => {
    for (const base of ["", "--output=/tmp/x", "a..b", "-n"]) {
      agent("u-base", { worktree: feat, base });
      const { status, body } = await tree(routes(), { agent: "u-base", path: "src" });
      expect([status, body.changes]).toEqual([200, { base: base || null, available: false, reason: CHANGES_UNAVAILABLE.noBase, files: [], truncated: false }]);
      expect(entries(body).every((e) => e.change === null)).toBe(true);
    }
  });

  test("dado base que o git não resolve, a árvore sai sem marcas com reason git_failed", async () => {
    agent("u-base2", { worktree: feat, base: "origin/nao-existe" });
    const { body } = await tree(routes(), { agent: "u-base2" });
    expect(body.changes).toMatchObject({ available: false, reason: CHANGES_UNAVAILABLE.gitFailed });
  });

  test("dado git que estoura o tempo, a árvore sai sem marcas com reason git_timeout (e o teto vai ao git)", async () => {
    const seen: { args: string[]; timeoutMs: number }[] = [];
    const git = async (_cwd: string, args: string[], timeoutMs: number): Promise<Exec> => {
      seen.push({ args, timeoutMs });
      return { status: 143, stdout: "", stderr: "", timedOut: true };
    };
    const { body } = await tree(routes({ git, limits: { gitTimeoutMs: 123 } }), { agent: "u-feat" });
    expect(body.changes).toMatchObject({ available: false, reason: CHANGES_UNAVAILABLE.gitTimeout });
    expect(seen[0]?.timeoutMs).toBe(123);
    expect(seen[0]?.args).toContain("main...HEAD");
  });

  test("dado mais arquivos mudados que o teto, a lista corta e avisa em changes.truncated", async () => {
    const { body } = await tree(routes({ limits: { changed: 1 } }), { agent: "u-feat" });
    expect(body.changes).toMatchObject({ available: true, truncated: true });
    expect((body.changes as { files: unknown[] }).files).toHaveLength(1);
  });

  test("a resposta nunca leva o caminho da worktree", async () => {
    const { body } = await tree(routes(), { agent: "u-feat", depth: "4" });
    expect(JSON.stringify(body)).not.toContain(ROOT);
  });
});

describe("canvas-content-route: funções puras da rota", () => {
  test("parseNameStatus lê pares status/caminho do -z, descarta o par incompleto e respeita o teto", () => {
    expect(parseNameStatus("M\0a.ts\0A\0dir/b.ts\0D\0c.ts\0", 10)).toEqual({ files: [{ path: "a.ts", status: "M" }, { path: "dir/b.ts", status: "A" }, { path: "c.ts", status: "D" }], truncated: false });
    expect(parseNameStatus("M\0a.ts\0A\0", 10).files).toEqual([{ path: "a.ts", status: "M" }]);
    expect(parseNameStatus("", 10)).toEqual({ files: [], truncated: false });
    expect(parseNameStatus("M\0a\0M\0b\0", 1)).toEqual({ files: [{ path: "a", status: "M" }], truncated: true });
  });

  test("parseRelPath normaliza barras e pontos e recusa .. e excesso", () => {
    expect(parseRelPath("", 8, 100)).toEqual([]);
    expect(parseRelPath("./a//b/", 8, 100)).toEqual(["a", "b"]);
    expect(parseRelPath("a/../b", 8, 100)).toBeUndefined();
    expect(parseRelPath("a/b/c", 2, 100)).toBeUndefined();
  });
});

describe("canvas-content-route: planos", () => {
  const PLAN = [
    "# Plano de teste", "", "## Estado atual", "- em voo: u-feat", "", "## Unidades",
    "| Unidade | Papel | Base | Depende de |", "|---|---|---|---|",
    "| u-feat | impl | main | — |", "| u-solta | review | main | u-feat |",
  ].join("\n");

  beforeAll(() => {
    write(join(PLANS, "teste.md"), PLAN);
    write(join(PLANS, "teste.log.md"), "log\n");
    write(join(PLANS, "outra.txt"), "x\n");
    write(join(PLANS, "velho.md"), "# velho\n");
    utimesSync(join(PLANS, "velho.md"), new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  });

  test("dado a pasta de planos, lista só .md (sem .log.md), do mais novo ao mais antigo", async () => {
    const { status, body } = await call(routes(), "/api/canvas-content/plans");
    expect(status).toBe(200);
    expect((body.plans as { name: string }[]).map((p) => p.name)).toEqual(["teste", "velho"]);
    expect((body.plans as { modifiedAt: string }[])[1]?.modifiedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  test("dado pasta de planos inexistente, a lista é vazia e o plano é desconhecido", async () => {
    const r = routes({ plansDir: join(ROOT, "sem-planos") });
    expect((await call(r, "/api/canvas-content/plans")).body.plans).toEqual([]);
    expect((await call(r, "/api/canvas-content/plan/teste")).body.code).toBe(CONTENT_ERRORS.unknownPlan);
  });

  test("dado o plano, devolve Estado atual, seções e unidades ligadas ao agente do registro", async () => {
    const { status, body } = await call(routes(), "/api/canvas-content/plan/teste");
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "teste", title: "Plano de teste", skippedRows: 0 });
    expect((body.state as { body: string }).body).toBe("- em voo: u-feat");
    const units = body.units as { name: string; dependsOn: string[]; agent: Dict | null }[];
    expect(units.map((u) => u.name)).toEqual(["u-feat", "u-solta"]);
    expect(units[0]?.agent).toEqual({ name: "u-feat", registry: "_skill", state: "working" });
    expect(units[1]).toMatchObject({ agent: null, dependsOn: ["u-feat"] });
  });

  test("dado nome inválido (barra, .., ponto inicial, escape malformado, longo), responde 400 invalid_plan", async () => {
    for (const name of ["..%2Fsecret", "a%2Fb", ".oculto", "%E0%A4%A", "x".repeat(101), "teste.md%00"]) {
      const { status, body } = await call(routes(), `/api/canvas-content/plan/${name}`);
      expect([name, status, body.code]).toEqual([name, 400, CONTENT_ERRORS.invalidPlan]);
    }
  });

  test("dado nome válido sem arquivo, ou o .log.md, responde 404 unknown_plan", async () => {
    for (const name of ["nao-existe", "teste.log", "outra"]) {
      expect(await call(routes(), `/api/canvas-content/plan/${name}`)).toMatchObject({ status: 404, body: { code: CONTENT_ERRORS.unknownPlan } });
    }
  });

  test("dado plano que é symlink para fora da pasta de planos, responde como inexistente", async () => {
    const outside = join(ROOT, "fora-plano.md");
    write(outside, "# fora\n");
    symlinkSync(outside, join(PLANS, "atalho.md"));
    expect(await call(routes(), "/api/canvas-content/plan/atalho")).toMatchObject({ status: 404, body: { code: CONTENT_ERRORS.unknownPlan } });
    rmSync(join(PLANS, "atalho.md"));
  });

  test("dado plano acima do teto de bytes, responde 413 plan_too_large sem ler o arquivo", async () => {
    write(join(PLANS, "enorme.md"), "a".repeat(PLAN_LIMITS.textBytes + 1));
    expect(await call(routes(), "/api/canvas-content/plan/enorme")).toMatchObject({ status: 413, body: { code: CONTENT_ERRORS.planTooLarge } });
  });

  test("dado plano sem unidades, a lista de unidades é vazia", async () => {
    write(join(PLANS, "sem-tabela.md"), "# só texto\n");
    const { body } = await call(routes(), "/api/canvas-content/plan/sem-tabela");
    expect([body.units, body.state]).toEqual([[], null]);
  });
});

describe("canvas-content-route: despacho", () => {
  test("caminho de fora do prefixo ou desconhecido não é atendido (undefined), e a mensagem de erro é fixa", async () => {
    expect(await routes().get("/api/canvas", {})).toBeUndefined();
    expect(await routes().get("/api/canvas-content/outra", {})).toBeUndefined();
  });
});

describe("canvas-content-route: pelo painel real (acesso)", () => {
  const r = new Rig().setup();
  let D = "";
  let P: Awaited<ReturnType<typeof startTestPanel>>;
  beforeAll(async () => {
    D = widgetData(r, "canvas-content").D;
    P = await startTestPanel(D);
  });
  afterAll(() => {
    P?.stop();
    r.cleanup();
  });

  test("local: a rota responde (agente fora do registro é 404 com código)", async () => {
    const res = await fetchRaw(P.base, "/api/canvas-content/tree?agent=nao-existe");
    expect([res.status, res.json?.code]).toEqual([404, CONTENT_ERRORS.unknownAgent]);
    expect((await fetchRaw(P.base, "/api/canvas-content/plans")).status).toBe(200);
  });

  test("pelo túnel: sem a chave é 401 nas três rotas; com a chave, atende como no local", async () => {
    const anon = remoteHeaders(D, false);
    for (const path of ["/api/canvas-content/tree?agent=x", "/api/canvas-content/plans", "/api/canvas-content/plan/teste"]) {
      expect([path, (await fetchRaw(P.base, path, anon)).status]).toEqual([path, 401]);
    }
    const keyed = remoteHeaders(D, true);
    const res = await fetchRaw(P.base, "/api/canvas-content/tree?agent=nao-existe", keyed);
    expect([res.status, res.json?.code]).toEqual([404, CONTENT_ERRORS.unknownAgent]);
  });

  test("a rota é só de leitura: POST e PUT nela são 404", async () => {
    const headers = { "Content-Type": "application/json", "x-panel-token": P.token };
    expect((await fetchRaw(P.base, "/api/canvas-content/tree", headers, {}, "POST")).status).toBe(404);
    expect((await fetchRaw(P.base, "/api/canvas-content/tree", headers, {}, "PUT")).status).toBe(404);
  });
});
