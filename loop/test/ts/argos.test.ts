// Grupo argos: o servidor do Argos (src/lib/argos.ts, src/panel/argos*.ts, reference/argos.md) — grafo (stack, consolidação,
// dependência do plano aprovado, PR, gate), nó com faixa do diário, ações pelo mesmo caminho do `hades agent` e da página
// Herdr (dublê só no herdr e no gh), lista fechada, confirmação das destrutivas, remoto com aviso e log, permissão pendente.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGOS_ERRORS, ArgosError, parseNodeId, parsePlanUnits, pendingPermission, planHash } from "../../../src/lib/argos";
import { AGENT_END_KIND, eventOfHook, eventOfSource, type JournalEvent } from "../../../src/lib/journal";
import { createArgos, type Argos } from "../../../src/panel/argos";
import { createGraph, registriesOf } from "../../../src/panel/argos-graph";
import type { Caller } from "../../../src/panel/argos-actions";
import { createHerdr } from "../../../src/panel/herdr";
import { createHerdrPage } from "../../../src/panel/herdr-page";
import type { PanelEnv } from "../../../src/panel/env";
import { LIMIT_MAX } from "../../../src/panel/journal";
import { SKILL } from "./lib/rig";

const T = mkdtempSync(join(tmpdir(), "hades-argos-"));
const HOME = join(T, "home");
const WORK = join(T, "work");
const BIN = join(T, "bin");
const D = join(T, "data");
const HERDR_LOG = join(T, "herdr.log");
const GH_LOG = join(T, "gh.log");
const NOTIFY_LOG = join(T, "notify.log");
const PROJECT = "ex__proj";
const reg = (slug: string) => join(WORK, slug, "orchestration");
const SAVED = { PATH: process.env.PATH, HOME: process.env.HOME, HADES_WORK_ROOT: process.env.HADES_WORK_ROOT, HADES_DATA: process.env.HADES_DATA };
const PATH0 = SAVED.PATH;

const HERDR_FAKE = `#!/usr/bin/env bash
echo "herdr $*" >> "${HERDR_LOG}"
case "\${1:-} \${2:-}" in
  'agent list') echo '{"result":{"agents":[{"name":"impl-a","pane_id":"w1:p1","agent_status":"working","cwd":"${T}/wt/impl-a","foreground_cwd":"${T}/wt/impl-a","terminal_title_stripped":"titulo"},{"name":"unit-a","pane_id":"w2:p1","agent_status":"blocked","cwd":"${T}/wt/unit-a"}]}}' ;;
  'session list') echo '{"sessions":[{"name":"default","running":true,"default":true},{"name":"outra","running":true}]}' ;;
  'api snapshot') echo '{"result":{"snapshot":{"agents":[{"pane_id":"w2:p1","name":"unit-a","agent_status":"blocked"}],"panes":[{"pane_id":"w2:p1","agent":"claude","agent_status":"blocked"}]}}}' ;;
  *) echo '{}' ;;
esac
`;
const GH_FAKE = `#!/usr/bin/env bash
echo "gh $* [cwd=$PWD]" >> "${GH_LOG}"
echo '{"state":"OPEN","isDraft":true,"mergeable":"MERGEABLE","headRefOid":"0123456789abcdef","url":"https://example.invalid/pr/7","statusCheckRollup":[{"conclusion":"SUCCESS"},{"conclusion":"FAILURE"},{"status":"IN_PROGRESS"}]}'
`;
const NOTIFY_FAKE = `#!/usr/bin/env bash
echo "notify $*" >> "${NOTIFY_LOG}"
`;

function write(path: string, body: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}
const lines = (file: string) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; } };
const agentJson = (slug: string, name: string, extra: Record<string, unknown>) =>
  write(join(reg(slug), "agents", `${name}.json`), JSON.stringify({ name, mode: "deliver", role: "impl", state: "working", worktree: join(T, "wt", name), ...extra }));
const journalOf = (slug: string, name: string, events: JournalEvent[]) =>
  write(join(WORK, slug, "journal", `${name}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
const at = (iso: string) => new Date(iso);
const hook = (name: string, iso: string, over: Record<string, unknown>) => eventOfHook({ session_id: "s", cwd: join(T, "wt", name), ...over }, name, at(iso))!;

const PLAN = `# Plano — demo

## Estado atual
- tudo certo

## Unidades
| Unidade | Papel | Base | Depende de |
|---|---|---|---|
| \`argos-api\` | impl | main | — |
| \`argos-ui\` | impl | \`skill/argos-api\` | \`argos-api\` |
| \`thanatos\` | impl | main | \`argos-api\`, \`ghost\` |

## Riscos
nada

## Estimativa
Gerada em 2026-11-02 · histórico: 6 unidades

| Unidade | Custo p25 (US$) | Custo mediana (US$) | Custo p75 (US$) | Duração p25 (min) | Duração mediana (min) | Duração p75 (min) | Gate mediana (min) | Amostra | Confiança | Base |
|---|---|---|---|---|---|---|---|---|---|---|
| unit-a | 1.00 | 2.00 | 4.50 | 20 | 35 | 60 | 1 | 6 | media | parecidas |
`;
const encodeCwd = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
const transcript = (worktree: string, outputTokens: number) =>
  write(join(HOME, ".claude/projects", encodeCwd(worktree), "s1.jsonl"), `${JSON.stringify({ type: "assistant", requestId: "r1", timestamp: "2026-10-01T10:00:00Z", message: { model: "claude-opus-5-5", usage: { output_tokens: outputTokens } } })}\n`);

let argos: Argos;
const caller: Caller = { remote: false };
const call = async (res: Promise<Response>) => { const r = await res; return { status: r.status, body: (await r.json()) as Record<string, any> }; };
const graph = () => call(argos.get("/api/argos/graph", {}) as Promise<Response>);
const node = (id: string, q: Record<string, string> = {}) => call(argos.get(`/api/argos/node/${encodeURIComponent(id)}`, q) as Promise<Response>);
const act = (body: Record<string, unknown>, c = caller) => call(argos.act(body, c));
const AGENT_A = `agent:${PROJECT}:impl-a`;
const UNIT_A = "agent:_skill:unit-a";

beforeAll(() => {
  for (const [name, body] of [["herdr", HERDR_FAKE], ["gh", GH_FAKE], ["notify.sh", NOTIFY_FAKE]] as const) {
    write(join(name === "notify.sh" ? D : BIN, name), body);
    chmodSync(join(name === "notify.sh" ? D : BIN, name), 0o755);
  }
  process.env.PATH = `${BIN}:${PATH0}`;
  mkdirSync(join(T, "wt/impl-a"), { recursive: true });
  mkdirSync(join(T, "wt/unit-a"), { recursive: true });
  mkdirSync(join(T, "wt/impl-b"), { recursive: true });
  mkdirSync(join(HOME, ".claude/hades"), { recursive: true });
  mkdirSync(join(WORK, PROJECT, "locks"), { recursive: true });
  // projeto: impl-a (PR 7, branch base) ← impl-b (empilhada) ← junta (consolida 7 e 8)
  agentJson(PROJECT, "impl-a", { branch: "feat/a", base: "origin/develop", pr: 7, key: "pr-7", card: "QTO-12" });
  agentJson(PROJECT, "impl-b", { branch: "feat/b", base: "origin/feat/a" });
  agentJson(PROJECT, "junta", { branch: "feat/junta", base: "origin/develop", role: "consolidate", mode: "consolidate", state: "done" });
  write(join(reg(PROJECT), "consolidations", "feat_junta.json"), JSON.stringify({ branch: "feat/junta", members: [7, 8] }));
  write(join(WORK, PROJECT, "state", "global.json"), JSON.stringify({ deliveries: { "pr-7": { pr: 7, status: "open" } } }));
  // skill: unit-a (modo skill) e o plano aprovado
  agentJson("_skill", "unit-a", { mode: "skill", branch: "skill/unit-a", base: "main", worktree: join(T, "wt/unit-a"), pane: "w2:p1" });
  write(join(T, "plan.md"), PLAN);
  write(join(reg("_skill"), "plan.json"), JSON.stringify({ path: join(T, "plan.md"), sha: planHash(PLAN) }));
  mkdirSync(join(T, "wt/unit-a/.design-sync-reports"), { recursive: true });
  write(join(T, "wt/unit-a/.design-sync-reports/brief.md"), "# Brief — unit-a\n\ncorpo longo\n");
  write(join(T, "wt/unit-a/.design-sync-reports/questions.md"), "## Q1 — qual porta\n\ntexto\n## Q2 — outra (respondida)\n");
  journalOf("_skill", "unit-a", [
    hook("unit-a", "2026-03-10T10:00:00Z", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
    hook("unit-a", "2026-03-10T10:00:05Z", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }),
    eventOfSource("gate", "gate.enqueue", "fila", { agent: "unit-a", now: at("2026-03-10T10:00:09Z") }),
  ]);

  // custo só no unit-a; o impl-b reprovou o último gate
  transcript(join(T, "wt/unit-a"), 100_000);
  journalOf(PROJECT, "impl-b", [eventOfSource("gate", "gate.done", "tsc impl-b rc=1 dur=3s cmd=tsc", { agent: "impl-b", now: at("2026-03-10T10:00:00Z") })]);

  const env = { dir: D, locks: join(WORK, PROJECT, "locks"), worktree: join(T, "wt/impl-a"), ui: "", panelDir: "", skillDir: SKILL } as unknown as PanelEnv;
  const herdr = createHerdr();
  argos = createArgos({
    env, herdr, herdrPage: createHerdrPage(env, herdr), workRoot: WORK, journalRoot: () => WORK,
    config: () => ({ HADES_ARGOS_ACTION_TIMEOUT_S: "60" }),
    gates: () => [{ pid: 4242, kind: "tsc", label: "impl-a", state: "waiting", clone: join(T, "wt/impl-a") }],
  });
  // o subprocesso do `hades agent` e o herdr do herdrPage herdam estes
  process.env.HOME = HOME;
  process.env.HADES_WORK_ROOT = WORK;
  process.env.HADES_DATA = D;
});
afterAll(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(T, { recursive: true, force: true });
});

describe("argos: regras puras", () => {
  test("id de nó: só os quatro formatos, sem barra; lixo é invalid_node", () => {
    expect(parseNodeId("agent:_skill:x")).toEqual({ type: "agent", parts: ["_skill", "x"] });
    expect(parseNodeId("gate:12").type).toBe("gate");
    for (const bad of ["", "agent:x", "agent:a:b:c", "agent:../x:y", "pr:a:b", "gate:x", "foo:1", "agent:a:"]) {
      expect(() => parseNodeId(bad)).toThrow(ArgosError);
    }
  });

  test("tabela do plano: unidades, base e dependências (crases, vírgula, traço = nenhuma)", () => {
    expect(parsePlanUnits(PLAN)).toEqual([
      { name: "argos-api", base: "main", dependsOn: [] },
      { name: "argos-ui", base: "skill/argos-api", dependsOn: ["argos-api"] },
      { name: "thanatos", base: "main", dependsOn: ["argos-api", "ghost"] },
    ]);
    expect(parsePlanUnits("# sem unidades")).toEqual([]);
  });

  test("hash do plano ignora o Estado atual, como o plan-approve", () => {
    expect(planHash(PLAN)).toBe(planHash(PLAN.replace("tudo certo", "outra coisa")));
    expect(planHash(PLAN)).not.toBe(planHash(PLAN.replace("main", "dev")));
  });

  test("permissão pendente: o pedido é o último evento de atividade; ferramenta, parada ou prompt depois a resolvem", () => {
    const p = (kind: string, source: JournalEvent["source"] = "guard"): JournalEvent => ({ v: 1, ts: "2026-03-10T10:00:00Z", agent: "a", session: "s", source, kind, summary: "", cwd: "" });
    expect(pendingPermission([p("tool_pre"), { ...p("permission"), tool: "Bash" }])).toEqual({ ts: "2026-03-10T10:00:00Z", tool: "Bash" });
    expect(pendingPermission([p("permission"), p("gate.done", "gate"), p("watch.question", "watch"), p("notification")])).not.toBeNull();
    for (const resolved of ["tool_pre", "tool_post", "stop", "prompt", "tool_blocked"]) expect(pendingPermission([p("permission"), p(resolved)])).toBeNull();
    expect(pendingPermission([])).toBeNull();
  });

  test("permissão pendente: o encerramento do agente (orch agent.end) a fecha, e um pedido novo depois dele vale", () => {
    const e = (kind: string, source: JournalEvent["source"], ts: string): JournalEvent => ({ v: 1, ts, agent: "a", session: "s", source, kind, summary: "", cwd: "" });
    const asked = e("permission", "guard", "2026-03-10T10:00:00Z");
    const ended = e(AGENT_END_KIND, "orch", "2026-03-10T10:01:00Z");
    expect(pendingPermission([asked, ended])).toBeNull();
    expect(pendingPermission([asked, ended, e("permission", "guard", "2026-03-10T10:02:00Z")])).toEqual({ ts: "2026-03-10T10:02:00Z", tool: null });
    expect(pendingPermission([asked, e("decision", "orch", "2026-03-10T10:01:00Z")])).not.toBeNull();
  });
});

describe("argos: pendência de agente que já não existe", () => {
  const ask = (name: string) => hook(name, "2026-03-10T10:00:05Z", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  const nodeOf = async (name: string) => (await node(`agent:${PROJECT}:${name}`)).body.node as Record<string, any>;
  // o pane w2:p1 existe no herdr falso (casa pelo pane, não pelo nome)
  const seed = (name: string, extra: Record<string, unknown>, events: JournalEvent[]) => { agentJson(PROJECT, name, { pane: "w2:p1", ...extra }); journalOf(PROJECT, name, events); };

  test("dado permission seguido do encerramento gravado pelo done, então o nó sai sem pendingPermission", async () => {
    seed("fim-viva", {}, [ask("fim-viva")]);
    expect((await nodeOf("fim-viva")).pendingPermission).not.toBeNull();
    seed("fim-end", {}, [ask("fim-end"), eventOfSource("orch", AGENT_END_KIND, "agente encerrado: done", { agent: "fim-end", now: at("2026-03-10T10:01:00Z") })]);
    expect((await nodeOf("fim-end")).pendingPermission).toBeNull();
  });

  test("dado registro done ou archived, mesmo com o pane ainda no herdr, então o nó sai sem pendingPermission", async () => {
    for (const state of ["done", "archived"]) {
      seed(`fim-${state}`, { state }, [ask(`fim-${state}`)]);
      expect((await nodeOf(`fim-${state}`)).pendingPermission).toBeNull();
    }
  });

  test("dado pane fora do herdr agent list, então o nó sai sem pendingPermission e aprovar ou negar é recusado com pane_gone", async () => {
    seed("fim-fora", { pane: "w9:p9" }, [ask("fim-fora")]);
    expect((await nodeOf("fim-fora")).pendingPermission).toBeNull();
    const before = lines(HERDR_LOG).length;
    for (const action of ["approve_permission", "deny_permission"]) {
      expect(await act({ node: `agent:${PROJECT}:fim-fora`, action })).toMatchObject({ status: 409, body: { code: ARGOS_ERRORS.paneGone } });
    }
    expect(lines(HERDR_LOG).slice(before).some((l) => l.includes("send-keys"))).toBe(false);
  });
});

describe("argos: GET /api/argos/graph", () => {
  test("nós dos dois registros, com id, type, label, role, state (registro + herdr), lastEventTs e pendingPermission", async () => {
    const { status, body } = await graph();
    expect(status).toBe(200);
    expect(body.v).toBe(1);
    const byId = Object.fromEntries((body.nodes as Record<string, any>[]).map((n) => [n.id, n]));
    expect(byId[AGENT_A]).toMatchObject({ type: "agent", label: "impl-a", role: "impl", state: "working", registryState: "working", herdrState: "working", pendingPermission: null, lastEventTs: null });
    expect(byId[UNIT_A]).toMatchObject({ type: "agent", mode: "skill", state: "blocked", lastEventTs: expect.stringMatching(/^2026-03-10T10:00:09/) });
    expect(byId[UNIT_A].pendingPermission).toEqual({ ts: "2026-03-10T10:00:05.000Z", tool: "Bash" });
    expect(byId[`agent:${PROJECT}:junta`]).toMatchObject({ state: "done", herdrState: "fora" });
    expect(body.herdr).toEqual({ available: true });
  });

  test("arestas: stack, agente→PR, consolidação, agente→gate e dependência do plano aprovado (unidade sem agente vira nó unit)", async () => {
    const { body } = await graph();
    const edge = (kind: string, from: string, to: string) => (body.edges as Record<string, string>[]).some((e) => e.kind === kind && e.from === from && e.to === to);
    expect(edge("stack", `agent:${PROJECT}:impl-b`, AGENT_A)).toBe(true);
    expect(edge("agent_pr", AGENT_A, `pr:${PROJECT}:7`)).toBe(true);
    expect(edge("consolidation", `agent:${PROJECT}:junta`, `pr:${PROJECT}:7`)).toBe(true);
    expect(edge("consolidation", `agent:${PROJECT}:junta`, `pr:${PROJECT}:8`)).toBe(true);
    expect(edge("agent_gate", AGENT_A, "gate:4242")).toBe(true);
    // as unidades do plano são do registro _skill: argos-api e argos-ui não têm agente, viram unit
    expect(edge("depends_on", "unit:_skill:argos-ui", "unit:_skill:argos-api")).toBe(true);
    expect(edge("depends_on", "unit:_skill:thanatos", "unit:_skill:ghost")).toBe(true);
    const nodes = body.nodes as Record<string, any>[];
    expect(nodes.find((n) => n.id === "unit:_skill:ghost")).toMatchObject({ type: "unit", state: "planned" });
    expect(nodes.find((n) => n.id === `pr:${PROJECT}:7`)).toMatchObject({ type: "pr", state: "open", number: 7 });
    expect(nodes.find((n) => n.id === "gate:4242")).toMatchObject({ type: "gate", label: "tsc/impl-a", state: "waiting" });
  });

  test("plano mudado depois da aprovação não vale: sem arestas de dependência", async () => {
    write(join(T, "plan.md"), PLAN.replace("`argos-api`, `ghost`", "`argos-api`, `outro`"));
    try {
      const { body } = await graph();
      expect((body.edges as Record<string, string>[]).filter((e) => e.kind === "depends_on")).toEqual([]);
      expect(body.registries.find((r: Record<string, unknown>) => r.slug === "_skill").planApproved).toBe(false);
    } finally {
      write(join(T, "plan.md"), PLAN);
    }
  });

  test("corte por idade: agente parado há mais que o corte sai com PR e ligações; unidade dele não volta como unit; 0 mostra todos", async () => {
    const old = join(reg("_skill"), "agents", "argos-api.json");
    agentJson("_skill", "argos-api", { mode: "skill", branch: "skill/argos-api", base: "main", pr: 9, createdAt: "2026-03-09T08:00:00Z", doneAt: "2026-03-10T09:00:00Z", state: "done" });
    // o watch e o Cerberus seguem escrevendo sobre o agente parado: não é atividade dele
    journalOf("_skill", "argos-api", [
      eventOfSource("watch", "watch.done", "DONE argos-api", { agent: "argos-api", now: at("2026-03-11T11:00:00Z") }),
      eventOfSource("cerberus", "cerberus.barra", "vigilia", { agent: "argos-api", now: at("2026-03-11T11:30:00Z") }),
    ]);
    try {
      const build = (hours: number) =>
        createGraph({
          registries: () => registriesOf(join(WORK, PROJECT, "locks"), WORK), journalRoot: () => WORK, herdr: createHerdr(), gates: () => [],
          reportsDir: () => ".design-sync-reports", now: () => at("2026-03-11T12:00:00Z"), agentMaxAgeHours: () => hours,
        }).graph();
      const cut = await build(24);
      const ids = (cut.nodes as Record<string, any>[]).map((n) => n.id);
      // unit-a: último evento do diário em 2026-03-10T10:00:09Z, 26 h antes; argos-api: doneAt 27 h antes
      expect(ids).not.toContain(UNIT_A);
      expect(ids).not.toContain("agent:_skill:argos-api");
      expect(ids).not.toContain("unit:_skill:argos-api");
      expect(ids).not.toContain("pr:_skill:9");
      // sem instante nenhum no registro nem no diário, o agente fica
      expect(ids).toContain(AGENT_A);
      const touches = (cut.edges as Record<string, string>[]).filter((e) => [e.from, e.to].some((id = "") => id.includes("argos-api") || id === UNIT_A));
      expect(touches).toEqual([]);
      // a unidade que depende da cortada segue, só sem a aresta para ela
      expect(ids).toContain("unit:_skill:argos-ui");
      const all = ((await build(0)).nodes as Record<string, any>[]).map((n) => n.id);
      expect(all).toContain(UNIT_A);
      expect(all).toContain("agent:_skill:argos-api");
    } finally {
      rmSync(old, { force: true });
      rmSync(join(WORK, "_skill", "journal", "argos-api.jsonl"), { force: true });
    }
  });
});

describe("argos: GET /api/argos/graph, campos de indicador no nó", () => {
  const nodeOf = async (id: string) => ((await graph()).body.nodes as Record<string, any>[]).find((n) => n.id === id) as Record<string, any>;

  test("nó com dado ganha card, files, custo, estimado e pergunta aberta; nó sem dado não ganha campo nenhum", async () => {
    const withData = await nodeOf(UNIT_A);
    expect(withData.card).toBeUndefined();
    expect(withData.files).toEqual([".design-sync-reports/brief.md", ".design-sync-reports/questions.md"]);
    expect(withData.openQuestions).toBe(1);
    expect(withData.costUsd).toBeGreaterThan(0);
    expect(withData.estimateUsd).toBe(4.5);
    expect((await nodeOf(AGENT_A)).card).toBe("QTO-12");
    const bare = await nodeOf(`agent:${PROJECT}:impl-b`);
    for (const field of ["costUsd", "estimateUsd", "card", "files", "openQuestions", "pr", "ci"]) expect(Object.hasOwn(bare, field)).toBe(false);
  });

  test("teto de leitura de transcript: o agente em andamento é lido antes do aposentado, mesmo que venha depois no registro", async () => {
    const root = join(T, "teto");
    const projects = join(root, "projects");
    for (const [name, state] of [["aaa-aposentado", "archived"], ["zzz-ativo", "working"]] as const) {
      const wt = join(root, "wt", name);
      write(join(root, "work/_skill/orchestration/agents", `${name}.json`), JSON.stringify({ name, mode: "deliver", role: "impl", state, worktree: wt }));
      write(join(projects, encodeCwd(wt), "s1.jsonl"), `${JSON.stringify({ type: "assistant", requestId: `r-${name}`, timestamp: "2026-10-01T10:00:00Z", message: { model: "claude-opus-5-5", usage: { output_tokens: 50_000 } } })}\n`);
    }
    const herdr = { cached: async (_key: string, load: () => Promise<unknown>) => load(), json: async () => null } as unknown as Parameters<typeof createGraph>[0]["herdr"];
    const g = createGraph({ registries: () => registriesOf(undefined, join(root, "work")), journalRoot: () => join(root, "work"), herdr, gates: () => [], reportsDir: () => ".design-sync-reports", projectsDir: projects, costBudgetBytes: 1 });
    const nodes = (await g.graph()).nodes as Record<string, any>[];
    expect(nodes.map((n) => n.id)).toEqual(["agent:_skill:aaa-aposentado", "agent:_skill:zzz-ativo"]);
    expect(nodes[1]?.costUsd).toBeGreaterThan(0);
    expect(Object.hasOwn(nodes[0] as object, "costUsd")).toBe(false);
  });

  test("orquestrador: o pane do registro vira campo do nó e aresta orchestrates agente → agente; par inválido some", async () => {
    const root = join(T, "orquestra");
    const agents = join(root, "work/_skill/orchestration/agents");
    write(join(agents, "orq.json"), JSON.stringify({ name: "orq", mode: "deliver", role: "impl", state: "working", pane: "w1:p1" }));
    write(join(agents, "filho.json"), JSON.stringify({ name: "filho", mode: "deliver", role: "impl", state: "done", pane: "w1:p2", orchestrator: { session: "default", pane: "w1:p1" } }));
    write(join(agents, "do-canvas.json"), JSON.stringify({ name: "do-canvas", mode: "deliver", role: "impl", state: "working", orchestrator: { session: "default", pane: "w7:p7" } }));
    write(join(agents, "torto.json"), JSON.stringify({ name: "torto", mode: "deliver", role: "impl", state: "working", orchestrator: { session: "default", pane: "../x" } }));
    const rows = [{ name: "orq", pane_id: "w1:p1" }, { name: "filho", pane_id: "w1:p2" }];
    const herdr = { cached: async (_key: string, load: () => Promise<unknown>) => load(), json: async () => ({ agents: rows }) } as unknown as Parameters<typeof createGraph>[0]["herdr"];
    const body = await createGraph({ registries: () => registriesOf(undefined, join(root, "work")), journalRoot: () => join(root, "work"), herdr, gates: () => [], reportsDir: () => ".design-sync-reports" }).graph();
    const nodes = body.nodes as Record<string, any>[];
    const byName = (name: string) => nodes.find((n) => n.id === `agent:_skill:${name}`) as Record<string, any>;
    expect(byName("filho").orchestrator).toEqual({ session: "default", pane: "w1:p1" });
    expect(byName("do-canvas").orchestrator).toEqual({ session: "default", pane: "w7:p7" });
    expect(Object.hasOwn(byName("torto"), "orchestrator")).toBe(false);
    expect(Object.hasOwn(byName("orq"), "orchestrator")).toBe(false);
    const orchestrates = (body.edges as Record<string, string>[]).filter((e) => e.kind === "orchestrates");
    // encerrado mantém a ligação; o terminal do canvas (w7:p7) não é nó do grafo, a página é que liga
    expect(orchestrates).toEqual([{ from: "agent:_skill:orq", to: "agent:_skill:filho", kind: "orchestrates" }]);
  });

  test("o contrato de antes segue: os campos de sempre continuam, com os mesmos valores", async () => {
    expect(await nodeOf(UNIT_A)).toMatchObject({ type: "agent", label: "unit-a", state: "blocked", registry: "_skill", branch: "skill/unit-a", pendingPermission: { tool: "Bash" } });
  });

  test("gate: a fila manda (na fila, rodando); sem gate vivo, reprovado no diário é failed; sem nada, sem campo", async () => {
    expect((await nodeOf(AGENT_A)).gate).toBe("waiting");
    expect((await nodeOf(`agent:${PROJECT}:impl-b`)).gate).toBe("failed");
    expect(Object.hasOwn(await nodeOf(UNIT_A), "gate")).toBe(false);
  });

  test("gate: rodando e lease contam como rodando; gate aprovado depois do que reprovou limpa; timeout é failed", async () => {
    const herdr = { cached: async (_key: string, load: () => Promise<unknown>) => load(), json: async () => null } as unknown as Parameters<typeof createGraph>[0]["herdr"];
    const gateNode = async (gates: Record<string, unknown>[]) => {
      const g = createGraph({ registries: () => registriesOf(join(WORK, PROJECT, "locks"), WORK), journalRoot: () => WORK, herdr, gates: () => gates, reportsDir: () => ".design-sync-reports" });
      return ((await g.graph()).nodes as Record<string, any>[]).find((n) => n.id === `agent:${PROJECT}:impl-b`) as Record<string, any>;
    };
    const clone = join(T, "wt/impl-b");
    expect((await gateNode([{ pid: 1, kind: "tsc", label: "outro", state: "waiting", clone }, { pid: 2, kind: "tsc", label: "impl-b", state: "running", clone }])).gate).toBe("running");
    expect((await gateNode([{ pid: 3, kind: "tsc", label: "x", state: "lease", clone: join(clone, "sub") }])).gate).toBe("running");
    const pass = eventOfSource("gate", "gate.done", "tsc impl-b rc=0 dur=3s cmd=tsc", { agent: "impl-b", now: at("2026-03-10T11:00:00Z") });
    const timeout = eventOfSource("gate", "gate.timeout", "tsc impl-b waited=900s (fila)", { agent: "impl-b", now: at("2026-03-10T12:00:00Z") });
    const fail = eventOfSource("gate", "gate.done", "tsc impl-b rc=1 dur=3s cmd=tsc", { agent: "impl-b", now: at("2026-03-10T10:00:00Z") });
    try {
      journalOf(PROJECT, "impl-b", [fail, pass]);
      expect(Object.hasOwn(await gateNode([]), "gate")).toBe(false);
      journalOf(PROJECT, "impl-b", [pass, timeout]);
      expect((await gateNode([])).gate).toBe("failed");
    } finally {
      journalOf(PROJECT, "impl-b", [fail]);
    }
  });

  test("PR e CI: o número vem do registro; o CI chega do gh (no agente e no nó da PR) e some se o gh falha", async () => {
    await node(AGENT_A);
    const agent = await nodeOf(AGENT_A);
    expect(agent.pr).toBe(7);
    expect(agent.ci).toEqual({ passing: 1, failing: 1, pending: 1 });
    expect((await nodeOf(`pr:${PROJECT}:7`)).ci).toEqual({ passing: 1, failing: 1, pending: 1 });
    expect(Object.hasOwn(await nodeOf(`pr:${PROJECT}:8`), "ci")).toBe(false);
  });
});

describe("argos: GET /api/argos/node/:id", () => {
  test("detalhe: faixa do diário, herdr, PR (estado e CI pelo gh) e arquivos com caminho e resumo", async () => {
    const { status, body } = await node(UNIT_A);
    expect(status).toBe(200);
    expect(body.timeline.count).toBe(3);
    expect(body.timeline.stream).toBe("/api/journal/stream?agent=unit-a");
    expect(body.herdr).toMatchObject({ status: "blocked", pane: "w2:p1" });
    expect(body.files.brief).toMatchObject({ head: "Brief — unit-a", path: join(T, "wt/unit-a/.design-sync-reports/brief.md") });
    expect(body.files.questions.openQuestions).toEqual(["Q1 — qual porta"]);
    expect(body.files.report).toBeNull();
    expect(JSON.stringify(body.files)).not.toContain("corpo longo");
    const withPr = await node(AGENT_A);
    expect(withPr.body.pr).toMatchObject({ number: 7, state: "OPEN", isDraft: true, head: "0123456789a", ci: { passing: 1, failing: 1, pending: 1 } });
    expect(readFileSync(GH_LOG, "utf8")).toContain(`gh pr view 7 --json`);
  });

  test("limit e since: o teto é do servidor (acima é recusado), instante inválido é invalid_query", async () => {
    expect((await node(UNIT_A, { limit: "1" })).body.timeline.events).toHaveLength(1);
    expect((await node(UNIT_A, { since: "2026-03-10T10:00:06Z" })).body.timeline.count).toBe(1);
    for (const q of [{ limit: String(LIMIT_MAX + 1) }, { limit: "0" }, { limit: "x" }, { since: "ontem" }] as Record<string, string>[]) {
      const r = await node(UNIT_A, q);
      expect([r.status, r.body.code]).toEqual([400, ARGOS_ERRORS.invalidQuery]);
    }
  });

  test("nó que não existe é 404 unknown_node; id fora do formato é 400 invalid_node; gate e PR não têm detalhe", async () => {
    expect(await node("agent:_skill:fantasma")).toMatchObject({ status: 404, body: { code: "unknown_node" } });
    expect(await node("agent:../../etc:passwd")).toMatchObject({ status: 400, body: { code: "invalid_node" } });
    expect(await node("gate:4242")).toMatchObject({ status: 404, body: { code: "unknown_node" } });
  });
});

describe("argos: POST /api/argos/action", () => {
  test("ação desconhecida é 400 unknown_action", async () => {
    for (const action of ["rm", "approve", "", undefined]) {
      expect(await act({ node: UNIT_A, action })).toMatchObject({ status: 400, body: { code: "unknown_action" } });
    }
  });

  test("prompt roda o `hades agent prompt` de verdade (herdr falso): manda a tarefa ao agente e atualiza o registro", async () => {
    const { status, body } = await act({ node: UNIT_A, action: "prompt", args: { text: "faça X" } });
    expect(status).toBe(200);
    expect(body).toMatchObject({ v: 1, ok: true, node: UNIT_A, action: "prompt" });
    expect(body.output).toContain("tarefa enviada a unit-a");
    expect(lines(HERDR_LOG)).toContain("herdr agent prompt unit-a faça X");
    expect(JSON.parse(readFileSync(join(reg("_skill"), "agents/unit-a.json"), "utf8")).promptedAt).toBeTruthy();
  });

  test("answer grava a resposta no questions.md (mesma função do hades agent answer) e avisa o agente", async () => {
    const { status } = await act({ node: UNIT_A, action: "answer", args: { question: "Q1", reply: "21271" } });
    expect(status).toBe(200);
    const q = readFileSync(join(T, "wt/unit-a/.design-sync-reports/questions.md"), "utf8");
    expect(q).toContain("## Q1 — qual porta (respondida)");
    expect(q).toContain("## Resposta do dono (Q1)\n\n21271");
    expect(lines(HERDR_LOG).some((l) => l.startsWith("herdr agent prompt unit-a O dono respondeu Q1"))).toBe(true);
  });

  test("falha do comando vira 422 action_failed com a última linha do erro; agente que não está no herdr", async () => {
    agentJson("_skill", "unit-c", { mode: "skill", worktree: join(T, "wt/unit-c"), branch: "skill/unit-c" });
    const r = await act({ node: "agent:_skill:unit-c", action: "prompt" });
    expect([r.status, r.body.code]).toEqual([422, ARGOS_ERRORS.actionFailed]);
    expect(r.body.error).toContain("não está no herdr");
  });

  test("texto e teclas vão pela página Herdr (pane do registro, validado contra o snapshot)", async () => {
    expect((await act({ node: UNIT_A, action: "free_prompt", args: { text: "oi" } })).status).toBe(200);
    expect((await act({ node: UNIT_A, action: "text", args: { text: "ls" } })).status).toBe(200);
    expect((await act({ node: UNIT_A, action: "keys", args: { keys: ["Enter"] } })).status).toBe(200);
    const log = lines(HERDR_LOG);
    expect(log).toContain("herdr agent prompt w2:p1 oi");
    expect(log).toContain("herdr pane send-text w2:p1 ls");
    expect(log).toContain("herdr pane send-keys w2:p1 Enter");
    expect(await act({ node: UNIT_A, action: "keys", args: { keys: ["Alt+F4"] } })).toMatchObject({ status: 422, body: { code: "action_failed" } });
  });

  test("permissão: approve = Enter e deny = Escape só com pedido pendente de ferramenta simples e herdr blocked", async () => {
    expect((await act({ node: UNIT_A, action: "approve_permission" })).status).toBe(200);
    expect((await act({ node: UNIT_A, action: "deny_permission" })).status).toBe(200);
    const log = lines(HERDR_LOG);
    expect(log).toContain("herdr pane send-keys w2:p1 Enter");
    expect(log).toContain("herdr pane send-keys w2:p1 Escape");
    // herdr não blocked (impl-a está working), mesmo com pedido no diário: recusa e nada é enviado
    journalOf(PROJECT, "impl-a", [hook("impl-a", "2026-03-10T10:00:05Z", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "needs your permission to use Bash" })]);
    const before = lines(HERDR_LOG).length;
    expect(await act({ node: AGENT_A, action: "approve_permission" })).toMatchObject({ status: 409, body: { code: "permission_not_pending" } });
    // sem pedido pendente (tool_post depois dele)
    const saved = readFileSync(join(WORK, "_skill/journal/unit-a.jsonl"), "utf8");
    const resolved = hook("unit-a", "2026-03-10T10:01:00Z", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {} });
    write(join(WORK, "_skill/journal/unit-a.jsonl"), `${saved}${JSON.stringify(resolved)}\n`);
    expect(await act({ node: UNIT_A, action: "approve_permission" })).toMatchObject({ status: 409, body: { code: "permission_not_pending" } });
    // plano e pergunta (ferramenta fora da lista) ficam fora, com recusa clara
    const plan = hook("unit-a", "2026-03-10T10:02:00Z", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use ExitPlanMode" });
    write(join(WORK, "_skill/journal/unit-a.jsonl"), `${saved}${JSON.stringify(plan)}\n`);
    expect(await act({ node: UNIT_A, action: "deny_permission" })).toMatchObject({ status: 422, body: { code: "permission_not_supported" } });
    // pedido sem a ferramenta (tool null, sem tool_pre aberto) também fica fora; MCP passa
    const mcp = hook("unit-a", "2026-03-10T10:03:00Z", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use mcp__x__y" });
    write(join(WORK, "_skill/journal/unit-a.jsonl"), `${saved}${JSON.stringify(mcp)}\n`);
    expect((await act({ node: UNIT_A, action: "approve_permission" })).status).toBe(200);
    const bare = hook("unit-a", "2026-03-10T10:04:00Z", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "permission needed" });
    const stop = hook("unit-a", "2026-03-10T10:03:30Z", { hook_event_name: "Stop" });
    write(join(WORK, "_skill/journal/unit-a.jsonl"), `${saved}${JSON.stringify(stop)}\n${JSON.stringify(bare)}\n`);
    expect((await act({ node: UNIT_A, action: "approve_permission" })).status).toBe(422);
    // sem a ferramenta no texto, mas com o tool_pre Bash aberto antes do pedido: a ferramenta vem do diário
    const open = hook("unit-a", "2026-03-10T10:03:40Z", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} });
    write(join(WORK, "_skill/journal/unit-a.jsonl"), `${saved}${JSON.stringify(stop)}\n${JSON.stringify(open)}\n${JSON.stringify(bare)}\n`);
    expect((await act({ node: UNIT_A, action: "approve_permission" })).status).toBe(200);
    write(join(WORK, "_skill/journal/unit-a.jsonl"), saved);
    expect(lines(HERDR_LOG).slice(before).filter((l) => l.includes("send-keys")).length).toBe(2);
  });

  test("argumentos inválidos e nó errado: invalid_args, invalid_node, unknown_node", async () => {
    for (const args of [{ question: "x", reply: "r" }, { question: "Q1" }, { question: "Q1", reply: "" }, { question: "Q1", reply: "x".repeat(20_001) }]) {
      expect(await act({ node: UNIT_A, action: "answer", args })).toMatchObject({ status: 400, body: { code: "invalid_args" } });
    }
    expect(await act({ node: UNIT_A, action: "phase", args: { phase: "../x" } })).toMatchObject({ status: 400, body: { code: "invalid_args" } });
    expect(await act({ node: UNIT_A, action: "prompt", args: "texto" })).toMatchObject({ status: 400, body: { code: "invalid_args" } });
    expect(await act({ node: "gate:4242", action: "prompt" })).toMatchObject({ status: 404, body: { code: "unknown_node" } });
    expect(await act({ node: "lixo", action: "prompt" })).toMatchObject({ status: 400, body: { code: "invalid_node" } });
  });

  test("destrutivas (done, stop_session) sem o nome do alvo em confirm são recusadas e nada roda", async () => {
    const before = lines(HERDR_LOG).length;
    for (const body of [
      { node: UNIT_A, action: "done" }, { node: UNIT_A, action: "done", confirm: "outro" },
      { node: UNIT_A, action: "stop_session", args: { session: "outra" }, confirm: "outra" },
    ]) {
      expect(await act(body)).toMatchObject({ status: 400, body: { code: "confirm_required" } });
    }
    expect(lines(HERDR_LOG).length).toBe(before);
    // com o nome certo, o `done` roda: a auditoria falha (sem report) e a falha vem como action_failed
    const done = await act({ node: UNIT_A, action: "done", confirm: "unit-a" });
    expect([done.status, done.body.code]).toEqual([422, ARGOS_ERRORS.actionFailed]);
    // stop_session confirmada leva ao herdr pela página (que confere o nome da sessão)
    expect((await act({ node: UNIT_A, action: "stop_session", args: { session: "outra" }, confirm: "unit-a" })).status).toBe(200);
    expect(lines(HERDR_LOG)).toContain("herdr session stop outra");
  });

  test("o log leva quem, ação, alvo, resultado e UTC; nunca o texto; ação local não notifica", async () => {
    const log = lines(join(D, "logs/panel-argos.log"));
    expect(log.length).toBeGreaterThan(5);
    expect(log[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z quem=local acao=\w+ alvo=\S+ resultado=\S+$/);
    expect(log.join("\n")).toContain(`acao=prompt alvo=${UNIT_A} resultado=ok`);
    expect(log.join("\n")).toContain("resultado=recusada:unknown_action");
    expect(log.join("\n")).not.toContain("faça X");
    expect(lines(NOTIFY_LOG)).toEqual([]);
  });

  test("remoto: executa sem trava, notifica (herdr/argos, só ação e alvo) e grava origem remoto no log", async () => {
    const before = lines(join(D, "logs/panel-argos.log")).length;
    const r = await act({ node: UNIT_A, action: "prompt", args: { text: "segredo do prompt" } }, { remote: true, ip: "203.0.113.9" });
    expect(r.status).toBe(200);
    const notices = lines(NOTIFY_LOG);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("send herdr warn ação remota: prompt em agent:_skill:unit-a (ok) --obj argos");
    expect(notices[0]).not.toContain("segredo do prompt");
    const added = lines(join(D, "logs/panel-argos.log")).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/quem=remoto:203\.0\.113\.9 acao=prompt alvo=agent:_skill:unit-a resultado=ok$/);
    // recusa também notifica; IP forjado fora do formato não entra no log
    await act({ node: UNIT_A, action: "done" }, { remote: true, ip: "x; rm -rf" });
    expect(lines(NOTIFY_LOG)).toHaveLength(2);
    expect(lines(join(D, "logs/panel-argos.log")).at(-1)).toContain("quem=remoto acao=done");
  });
});
