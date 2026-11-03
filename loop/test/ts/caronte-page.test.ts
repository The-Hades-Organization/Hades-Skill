// Página Caronte (src/panel/caronte.ts, reference/panel.md §Caronte): listagem de planos e prontidão, prévia do pack,
// pacotes, prompt de retomada, park (ok, já estacionado, ocupado), nome inválido (400), desconhecido (404) e ação remota
// que avisa e registra. Tudo em pasta temporária; o `hades agent park` é um dublê (o painel só o dispara).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARONTE_ERRORS, CaronteRouteError, createCaronteRoutes, type CaronteRoutes } from "../../../src/panel/caronte";
import type { Exec } from "../../../src/panel/exec";
import { loadWorkEnv } from "../../../src/lib/work";

const ROOT = mkdtempSync(join(tmpdir(), "caronte-page-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const PLANS = join(ROOT, "plans");
const OUT = join(ROOT, "out");
const WORK = join(ROOT, "work");
const ORCH = join(WORK, "_skill", "orchestration");
const LOG = join(ROOT, "logs", "panel-argos.log");
const REPORTS = ".design-sync-reports";
// marcador de segredo montado em partes: o literal não pode existir nos fontes (a varredura do check o procuraria)
const SECRET_VALUE = ["Hds", "!", "abcdef1234"].join("");
const NOW = new Date("2026-10-29T12:00:00Z");

const write = (file: string, text: string): void => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function tree(agent: string, handoff: boolean, extra: Record<string, string> = {}): string {
  const dir = join(ROOT, "trees", agent);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  write(join(dir, "a.txt"), "um\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base");
  write(join(dir, REPORTS, "brief.md"), "# brief\n");
  if (handoff) write(join(dir, REPORTS, "handoff.md"), "STATUS: PARKED — pausa\n");
  for (const [name, text] of Object.entries(extra)) write(join(dir, name), text);
  return dir;
}

function agent(name: string, state: string, worktree: string): void {
  write(join(ORCH, "agents", `${name}.json`), JSON.stringify({ name, mode: "skill", role: "impl", base: "main", state, worktree, promptedAt: "2020-01-01T00:00:00Z" }));
}

interface Rig {
  routes: CaronteRoutes;
  runs: { name: string; cwd: string }[];
  notices: string[];
  release(): void;
}

function rig(options: { run?: (name: string) => Promise<Exec> } = {}): Rig {
  const runs: { name: string; cwd: string }[] = [];
  const notices: string[] = [];
  let release = (): void => {};
  const routes = createCaronteRoutes({
    plansDir: PLANS,
    outDir: () => OUT,
    work: () => loadWorkEnv({ skillOk: true, skillForce: true }, { HADES_WORK_ROOT: WORK }),
    config: () => ({}),
    logFile: LOG,
    notify: async (message) => { notices.push(message); },
    runPark: async (name, cwd) => {
      runs.push({ name, cwd });
      return options.run ? options.run(name) : { status: 0, stdout: "estacionado\n", stderr: "", timedOut: false };
    },
    now: () => NOW,
  });
  return { routes, runs, notices, release: () => release() };
}

const refusal = async (call: () => unknown): Promise<CaronteRouteError> => {
  try {
    await call();
  } catch (error) {
    if (error instanceof CaronteRouteError) return error;
    throw error;
  }
  throw new Error("esperava a recusa");
};

beforeEach(() => {
  for (const dir of [PLANS, OUT, WORK, join(ROOT, "trees"), join(ROOT, "logs")]) rmSync(dir, { recursive: true, force: true });
  write(join(PLANS, "demo.md"), "# Plano demo\n\n## Estado atual\n- fake-a e fake-w\n");
  write(join(PLANS, "demo.log.md"), "histórico\n");
  write(join(PLANS, "outro.md"), "# Outro plano sem agentes\n");
  write(join(PLANS, "notas.txt"), "não é plano\n");
  agent("fake-a", "parked", tree("fake-a", true));
  agent("fake-w", "working", tree("fake-w", false));
  agent("de-fora", "working", tree("de-fora", false));
});

describe("lista de planos e prontidão", () => {
  test("dado planos e agentes, quando lista, então só os .md sem log e a prontidão por agente", () => {
    const { plans } = rig().routes.list() as { plans: { name: string; ready: boolean; missing: string[]; agents: { name: string; readiness: string; command: string | null }[]; pack: string }[] };
    expect(plans.map((p) => p.name).sort()).toEqual(["demo", "outro"]);
    const demo = plans.find((p) => p.name === "demo")!;
    expect(demo.ready).toBe(false);
    expect(demo.agents.map((a) => [a.name, a.readiness])).toEqual([["fake-a", "parked"], ["fake-w", "working"]]);
    expect(demo.missing).toEqual(["hades agent park fake-w"]);
    expect(demo.pack).toBe("! hades caronte pack demo");
  });

  test("dado um plano sem agentes, quando lista, então está pronto", () => {
    const { plans } = rig().routes.list() as { plans: { name: string; ready: boolean; agents: unknown[] }[] };
    expect(plans.find((p) => p.name === "outro")).toMatchObject({ ready: true, agents: [] });
  });

  test("dado um agente que o registro encerrou, quando lista, então conta como encerrado", () => {
    agent("fake-w", "done", join(ROOT, "trees", "fake-w"));
    const { plans } = rig().routes.list() as { plans: { name: string; ready: boolean; agents: { readiness: string }[] }[] };
    expect(plans.find((p) => p.name === "demo")).toMatchObject({ ready: true });
  });

  test("dado a pasta de planos vazia, quando lista, então devolve listas vazias", () => {
    rmSync(PLANS, { recursive: true, force: true });
    expect(rig().routes.list()).toMatchObject({ plans: [], packages: [] });
  });
});

describe("pacotes", () => {
  test("dado arquivos na pasta de saída, quando lista, então só os .caronte, do mais novo ao mais antigo, com tamanho e o comando", () => {
    write(join(OUT, "velho.caronte"), "x".repeat(10));
    write(join(OUT, "novo.caronte"), "y".repeat(2048));
    write(join(OUT, "lixo.txt"), "z");
    utimesSync(join(OUT, "velho.caronte"), new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    utimesSync(join(OUT, "novo.caronte"), new Date("2026-10-28T00:00:00Z"), new Date("2026-10-28T00:00:00Z"));
    const { packages } = rig().routes.list() as { packages: { name: string; size: number; modifiedAt: string; unpack: string }[] };
    expect(packages.map((p) => p.name)).toEqual(["novo.caronte", "velho.caronte"]);
    expect(packages[0]).toMatchObject({ size: 2048, modifiedAt: "2026-10-28T00:00:00.000Z", unpack: `! hades caronte unpack ${join(OUT, "novo.caronte")}` });
  });

  test("dado um nome de pacote com espaço, quando lista, então o comando vem entre aspas", () => {
    write(join(OUT, "meu pacote.caronte"), "x");
    const { packages } = rig().routes.list() as { packages: { unpack: string }[] };
    expect(packages[0]?.unpack).toBe(`! hades caronte unpack '${join(OUT, "meu pacote.caronte")}'`);
  });

  test("dado pacotes, quando lista, então o conteúdo nunca é lido nem devolvido", () => {
    write(join(OUT, "a.caronte"), "CONTEUDO-CIFRADO");
    expect(JSON.stringify(rig().routes.list())).not.toContain("CONTEUDO-CIFRADO");
  });
});

describe("plano: prévia e retomada", () => {
  test("dado agentes estacionados, quando abre o plano, então a prévia traz partes, worktrees e tamanho", () => {
    agent("fake-w", "done", join(ROOT, "trees", "fake-w"));
    const detail = rig().routes.plan("demo") as { ready: boolean; previewError: unknown; preview: { parts: { path: string; size: number }[]; rawBytes: number; worktrees: { agent: string }[]; blocked: unknown[] } };
    expect(detail.ready).toBe(true);
    expect(detail.previewError).toBeNull();
    expect(detail.preview.parts.map((p) => p.path)).toContain("plan/demo.md");
    expect(detail.preview.parts.map((p) => p.path)).toContain("reports/fake-a/handoff.md");
    expect(detail.preview.worktrees.map((w) => w.agent).sort()).toEqual(["fake-a", "fake-w"]);
    expect(detail.preview.rawBytes).toBe(detail.preview.parts.reduce((sum, p) => sum + p.size, 0));
    expect(detail.preview.blocked).toEqual([]);
  });

  test("dado um agente trabalhando, quando abre o plano, então não há prévia e o motivo nomeia o agente", () => {
    const detail = rig().routes.plan("demo") as { ready: boolean; preview: unknown; previewError: { code: string; agents: string[] } };
    expect(detail.ready).toBe(false);
    expect(detail.preview).toBeNull();
    expect(detail.previewError).toEqual({ code: "not_ready", agents: ["fake-w"] });
  });

  test("dado um segredo no não commitado, quando abre o plano, então a guarda o nomeia pelo caminho e o valor não aparece", () => {
    agent("fake-w", "done", join(ROOT, "trees", "fake-w"));
    write(join(ROOT, "trees", "fake-a", ".env"), `SENHA=${SECRET_VALUE}\n`);
    const detail = rig().routes.plan("demo");
    const preview = detail.preview as { blocked: { path: string; rule: string }[] };
    expect(preview.blocked.map((f) => f.path)).toContain("worktrees/fake-a/.env");
    expect(JSON.stringify(detail)).not.toContain(SECRET_VALUE);
  });

  test("dado o plano pronto, quando abre, então a prévia vem do cache dentro do TTL", () => {
    agent("fake-w", "done", join(ROOT, "trees", "fake-w"));
    const r = rig();
    const first = r.routes.plan("demo");
    write(join(ROOT, "trees", "fake-a", "novo.txt"), "depois\n");
    expect(r.routes.plan("demo").preview).toEqual(first.preview);
  });

  test("dado agentes estacionados, quando abre o plano, então o prompt de retomada lista o resume só dos estacionados", () => {
    const { brief } = rig().routes.plan("demo") as { brief: string };
    expect(brief).toContain(join(PLANS, "demo.md"));
    expect(brief).toContain("hades agent resume fake-a");
    expect(brief).not.toContain("hades agent resume fake-w");
  });

  test("dado o plano, quando abre, então traz os comandos de pack e unpack para copiar", () => {
    const { commands } = rig().routes.plan("demo") as { commands: { pack: string; unpack: string; dryRun: string } };
    expect(commands).toEqual({ pack: "! hades caronte pack demo", unpack: "! hades caronte unpack <arq>", dryRun: "hades caronte pack demo --dry-run" });
  });
});

describe("nome de plano: 400 inválido, 404 desconhecido", () => {
  test.each(["../demo", "demo/../outro", "/etc/passwd", ".oculto", "a b", "", "x".repeat(101)])("dado o nome %p, quando abre, então 400", async (name) => {
    expect(await refusal(() => rig().routes.plan(name))).toMatchObject({ status: 400, code: CARONTE_ERRORS.invalidPlan });
  });

  test("dado um nome válido fora da lista, quando abre, então 404", async () => {
    expect(await refusal(() => rig().routes.plan("nao-existe"))).toMatchObject({ status: 404, code: CARONTE_ERRORS.unknownPlan });
  });

  test("dado o arquivo de log do plano, quando abre como plano, então 404", async () => {
    expect(await refusal(() => rig().routes.plan("demo.log"))).toMatchObject({ status: 404, code: CARONTE_ERRORS.unknownPlan });
  });

  test("dado plano e agente inválidos no park, quando estaciona, então 400 e nada roda", async () => {
    const r = rig();
    expect(await refusal(() => r.routes.park({ plan: "../demo", agent: "fake-w" }, { remote: false }))).toMatchObject({ status: 400, code: "invalid_plan" });
    expect(await refusal(() => r.routes.park({ plan: "demo", agent: "fake w; rm -rf" }, { remote: false }))).toMatchObject({ status: 400, code: "invalid_agent" });
    expect(await refusal(() => r.routes.park({ plan: "demo" }, { remote: false }))).toMatchObject({ status: 400, code: "invalid_agent" });
    expect(await refusal(() => r.routes.park({ agent: "fake-w" }, { remote: false }))).toMatchObject({ status: 400, code: "invalid_plan" });
    expect(r.runs).toEqual([]);
  });

  test("dado plano ou agente desconhecidos no park, quando estaciona, então 404 e nada roda", async () => {
    const r = rig();
    expect(await refusal(() => r.routes.park({ plan: "nao-existe", agent: "fake-w" }, { remote: false }))).toMatchObject({ status: 404, code: "unknown_plan" });
    expect(await refusal(() => r.routes.park({ plan: "demo", agent: "fantasma" }, { remote: false }))).toMatchObject({ status: 404, code: "unknown_agent" });
    // existe no registro, mas o plano não o cita: fora da lista do plano
    expect(await refusal(() => r.routes.park({ plan: "demo", agent: "de-fora" }, { remote: false }))).toMatchObject({ status: 404, code: "unknown_agent" });
    expect(r.runs).toEqual([]);
  });
});

describe("park", () => {
  test("dado um agente trabalhando, quando estaciona, então roda o park na worktree e devolve a saída", async () => {
    const r = rig();
    const done = await r.routes.park({ plan: "demo", agent: "fake-w" }, { remote: false });
    expect(done).toMatchObject({ ok: true, agent: "fake-w", already: null, output: "estacionado" });
    expect(r.runs).toEqual([{ name: "fake-w", cwd: join(ROOT, "trees", "fake-w") }]);
  });

  test("dado um agente já estacionado, quando estaciona, então avisa que já estava e não roda nada", async () => {
    const r = rig();
    expect(await r.routes.park({ plan: "demo", agent: "fake-a" }, { remote: false })).toMatchObject({ ok: true, already: "parked" });
    expect(r.runs).toEqual([]);
  });

  test("dado o park que falha, quando estaciona, então 422 com a última linha do erro", async () => {
    const r = rig({ run: async () => ({ status: 1, stdout: "", stderr: "ruído\nhandoff não chegou\n", timedOut: false }) });
    expect(await refusal(() => r.routes.park({ plan: "demo", agent: "fake-w" }, { remote: false }))).toMatchObject({ status: 422, code: "action_failed", message: "handoff não chegou" });
  });

  test("dado o park que estoura o tempo, quando estaciona, então 504", async () => {
    const r = rig({ run: async () => ({ status: 0, stdout: "", stderr: "", timedOut: true }) });
    expect(await refusal(() => r.routes.park({ plan: "demo", agent: "fake-w" }, { remote: false }))).toMatchObject({ status: 504, code: "action_timeout" });
  });

  test("dado um park em andamento, quando pede o mesmo agente de novo, então 409 e libera depois", async () => {
    let finish: (e: Exec) => void = () => {};
    const r = rig({ run: () => new Promise<Exec>((resolve) => { finish = resolve; }) });
    const first = r.routes.park({ plan: "demo", agent: "fake-w" }, { remote: false });
    await Promise.resolve();
    expect(await refusal(() => r.routes.park({ plan: "demo", agent: "fake-w" }, { remote: false }))).toMatchObject({ status: 409, code: "busy" });
    finish({ status: 0, stdout: "ok", stderr: "", timedOut: false });
    await first;
    expect(r.runs.length).toBe(1);
    // o 409 não derrubou a trava de quem está rodando e a trava é solta no fim: de novo, roda
    const again = r.routes.park({ plan: "demo", agent: "fake-w" }, { remote: false });
    await Promise.resolve();
    finish({ status: 0, stdout: "ok", stderr: "", timedOut: false });
    expect(await again).toMatchObject({ ok: true });
    expect(r.runs.length).toBe(2);
  });

  test("dado o park, quando termina, então a prévia em cache do plano é descartada", async () => {
    agent("fake-w", "done", join(ROOT, "trees", "fake-w"));
    const r = rig();
    r.routes.plan("demo");
    write(join(ROOT, "trees", "fake-a", "novo.txt"), "depois\n");
    agent("fake-w", "working", join(ROOT, "trees", "fake-w"));
    await r.routes.park({ plan: "demo", agent: "fake-w" }, { remote: false });
    agent("fake-w", "done", join(ROOT, "trees", "fake-w"));
    const parts = (r.routes.plan("demo").preview as { parts: { path: string }[] }).parts.map((p) => p.path);
    expect(parts).toContain("worktrees/fake-a/uncommitted.patch");
  });
});

describe("acesso remoto", () => {
  test("dado o painel remoto, quando estaciona, então executa, avisa o dono e registra no log", async () => {
    const r = rig();
    await r.routes.park({ plan: "demo", agent: "fake-w" }, { remote: true, ip: "203.0.113.7" });
    expect(r.runs.length).toBe(1);
    expect(r.notices).toEqual(["ação remota: park em demo/fake-w (ok)"]);
    expect(readFileSync(LOG, "utf8")).toBe("2026-10-29T12:00:00.000Z quem=remoto:203.0.113.7 acao=caronte-park alvo=demo/fake-w resultado=ok\n");
  });

  test("dado o painel local, quando estaciona, então registra e não avisa", async () => {
    const r = rig();
    await r.routes.park({ plan: "demo", agent: "fake-w" }, { remote: false });
    expect(r.notices).toEqual([]);
    expect(readFileSync(LOG, "utf8")).toContain("quem=local acao=caronte-park alvo=demo/fake-w resultado=ok");
  });

  test("dado o painel remoto e um nome inválido, quando estaciona, então recusa, avisa e registra sem o texto cru", async () => {
    const r = rig();
    await refusal(() => r.routes.park({ plan: "demo", agent: "x; rm -rf /" }, { remote: true }));
    expect(r.notices).toEqual(["ação remota: park em - (recusada:invalid_agent)"]);
    expect(readFileSync(LOG, "utf8")).toContain("alvo=- resultado=recusada:invalid_agent");
    expect(readFileSync(LOG, "utf8")).not.toContain("rm -rf");
  });

  test("dado o aviso que falha, quando estaciona pelo remoto, então a ação segue ok", async () => {
    const routes = createCaronteRoutes({
      plansDir: PLANS, outDir: () => OUT, work: () => loadWorkEnv({ skillOk: true, skillForce: true }, { HADES_WORK_ROOT: WORK }), config: () => ({}),
      logFile: LOG, notify: async () => { throw new Error("ntfy fora"); }, runPark: async () => ({ status: 0, stdout: "ok", stderr: "", timedOut: false }), now: () => NOW,
    });
    expect(await routes.park({ plan: "demo", agent: "fake-w" }, { remote: true })).toMatchObject({ ok: true });
  });
});
