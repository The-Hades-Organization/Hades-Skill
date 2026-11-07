// Grupo argos-park: a ação `park` de POST /api/argos/action (src/panel/argos-actions.ts) roda o `hades agent park` de verdade
// (herdr falso): manda o prompt de handoff, confere o `STATUS: PARKED` fresco do jeito do CLI, e entra no lote do canvas.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGOS_ERRORS } from "../../../src/lib/argos";
import { actionsFor, MENU_ACTIONS, type ActionNode } from "../../../src/lib/canvas-actions";
import { BATCH_ACTIONS, batchRequests, planBatch } from "../../../src/lib/canvas-batch";
import { ACTION_NAMES, type Actions, createActions } from "../../../src/panel/argos-actions";

const T = mkdtempSync(join(tmpdir(), "hades-argos-park-"));
const WORK = join(T, "work");
const D = join(T, "data");
const BIN = join(T, "bin");
const HERDR_LOG = join(T, "herdr.log");
const REPORTS = ".design-sync-reports";
const reg = join(WORK, "_skill", "orchestration");
const wt = (name: string): string => join(T, "wt", name);
const id = (name: string): string => `agent:_skill:${name}`;

// `agent list` conhece só quem está no herdr; `agent prompt` de quem está em MODO_ESCREVE grava o handoff como o agente faria
const HERDR_FAKE = `#!/usr/bin/env bash
echo "herdr $*" >> "${HERDR_LOG}"
case "\${1:-} \${2:-}" in
  'agent list') echo '{"result":{"agents":[{"name":"p-ok","pane_id":"w1:p1","agent_status":"idle"},{"name":"p-mudo","pane_id":"w1:p2","agent_status":"idle"}]}}' ;;
  'agent prompt') [ "\${3:-}" = "p-ok" ] && printf 'STATUS: PARKED — pausa\\n\\nfeito tudo\\n' > "${T}/wt/p-ok/${REPORTS}/handoff.md"; echo '{}' ;;
  *) echo '{}' ;;
esac
`;

const SAVED = { PATH: process.env.PATH, HADES_HERDR_BIN: process.env.HADES_HERDR_BIN, HOME: process.env.HOME, HADES_WORK_ROOT: process.env.HADES_WORK_ROOT, HADES_DATA: process.env.HADES_DATA };
const agentJson = (name: string, extra: Record<string, unknown> = {}): void => {
  mkdirSync(join(reg, "agents"), { recursive: true });
  mkdirSync(join(wt(name), REPORTS), { recursive: true });
  writeFileSync(join(reg, "agents", `${name}.json`), JSON.stringify({ name, mode: "skill", role: "impl", state: "working", worktree: wt(name), branch: `skill/${name}`, ...extra }));
};
const record = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(reg, "agents", `${name}.json`), "utf8"));
const herdrLines = (): string[] => {
  try {
    return readFileSync(HERDR_LOG, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

// criado em beforeAll: o PATH com o herdr falso precisa estar pronto quando o ambiente do subprocesso é montado
let act: Actions["act"];
const makeAct = (): Actions["act"] => createActions({
  logFile: join(D, "logs", "panel-argos.log"), fallbackCwd: T, herdrPage: {} as never,
  target: (node) => {
    const name = node.split(":")[2] ?? "";
    if (!/^p-/.test(name) && name !== "fantasma") throw Object.assign(new Error("nó"), { status: 404, code: ARGOS_ERRORS.unknownNode });
    return { id: node, name, worktree: wt(name), pane: "w1:p1" };
  },
  live: async () => ({ herdrState: "idle", pending: null }), config: () => ({ HADES_ARGOS_ACTION_TIMEOUT_S: "60" }),
  notify: async () => undefined,
  env: { ...process.env, HOME: join(T, "home"), HADES_WORK_ROOT: WORK, HADES_DATA: D },
}).act;
const run = (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> =>
  act(body, { remote: false }).then(
    (out) => ({ status: 200, body: out }),
    (error: { status?: number; code?: string; message?: string }) => ({ status: error.status ?? 500, body: { code: error.code, error: error.message } }),
  );

beforeAll(() => {
  mkdirSync(BIN, { recursive: true });
  mkdirSync(D, { recursive: true });
  writeFileSync(join(BIN, "herdr"), HERDR_FAKE);
  chmodSync(join(BIN, "herdr"), 0o755);
  process.env.PATH = `${BIN}:${SAVED.PATH}`;
  // a fila de gates exporta o HADES_HERDR_BIN da máquina e o herdr() o respeita: o falso vai explícito
  process.env.HADES_HERDR_BIN = join(BIN, "herdr");
  act = makeAct();
  agentJson("p-ok");
  agentJson("p-mudo");
  agentJson("p-fim", { state: "done" });
});
afterAll(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(T, { recursive: true, force: true });
});

describe("park: a ação do Argos", () => {
  test("dado agente que grava o handoff, então responde ok como as outras ações e o registro fica parked", async () => {
    const r = await run({ node: id("p-ok"), action: "park" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ v: 1, ok: true, node: id("p-ok"), action: "park" });
    expect(String(r.body.output)).toContain("p-ok estacionado");
    expect(record("p-ok")).toMatchObject({ state: "parked" });
    expect(herdrLines().some((l) => l.startsWith("herdr agent prompt p-ok O orquestrador pede para estacionar"))).toBe(true);
  });

  test("dado motivo, então ele segue no prompt de handoff", async () => {
    agentJson("p-ok");
    // sem handoff.md de antes: um STATUS: PARKED já gravado conta como estacionado e o CLI nem pergunta ao agente
    rmSync(join(wt("p-ok"), REPORTS, "handoff.md"), { force: true });
    expect((await run({ node: id("p-ok"), action: "park", args: { reason: "fim do dia" } })).status).toBe(200);
    expect(herdrLines().some((l) => l.includes("estacionar (fim do dia)"))).toBe(true);
  });

  test("dado agente que não escreveu o STATUS: PARKED fresco, então 422 action_failed e o registro não muda", async () => {
    const r = await run({ node: id("p-mudo"), action: "park" });
    expect([r.status, r.body.code]).toEqual([422, ARGOS_ERRORS.actionFailed]);
    expect(String(r.body.error)).toContain("ainda não começa com STATUS: PARKED");
    expect(record("p-mudo")).toMatchObject({ state: "working" });
  });

  test("dado agente já encerrado, então responde ok sem mandar nada ao herdr", async () => {
    const before = herdrLines().length;
    const r = await run({ node: id("p-fim"), action: "park" });
    expect(r.status).toBe(200);
    expect(String(r.body.output)).toContain("já encerrado");
    expect(herdrLines().length).toBe(before);
  });

  test("dado agente desconhecido ou id inválido, então responde como as outras ações (unknown_node, invalid_node)", async () => {
    expect(await run({ node: id("zzz"), action: "park" })).toMatchObject({ status: 404, body: { code: ARGOS_ERRORS.unknownNode } });
    expect((await run({ node: "lixo", action: "park" })).body.code).toBeDefined();
  });

  test("dado motivo inválido, então 400 invalid_args e nada roda", async () => {
    const before = herdrLines().length;
    for (const reason of ["", "  ", 7, "x".repeat(401)]) {
      expect(await run({ node: id("p-ok"), action: "park", args: { reason } })).toMatchObject({ status: 400, body: { code: ARGOS_ERRORS.invalidArgs } });
    }
    expect(herdrLines().length).toBe(before);
  });

  test("dado agente registrado sem sessão no herdr, então responde ok dizendo que não há o que parar", async () => {
    agentJson("fantasma");
    const r = await run({ node: id("fantasma"), action: "park" });
    expect(r.status).toBe(200);
    expect(String(r.body.output)).toContain("sem sessão no herdr");
  });
});

describe("park: no lote do canvas", () => {
  const agent = (name: string, over: Partial<ActionNode> = {}): ActionNode => ({ id: id(name), type: "agent", label: name, state: "working", ...over }) as ActionNode;

  test("dado a lista fechada da rota, então park é ação de lote, existe na rota e no menu", () => {
    expect(BATCH_ACTIONS).toContain("park");
    expect(ACTION_NAMES).toContain("park");
    expect(MENU_ACTIONS).toContain("park");
    expect(actionsFor(agent("p-ok")).find((i) => i.key === "park")).toMatchObject({ available: true, dangerous: false });
  });

  test("dado seleção de agentes, então o lote gera um pedido park por agente, sem confirm", () => {
    const plan = planBatch([agent("p-ok"), agent("p-mudo")], "park");
    expect(plan.problem).toBeUndefined();
    expect(plan.dangerous).toBe(false);
    expect(plan.effect).toContain("Estacionar");
    expect(batchRequests(plan)).toEqual({
      ok: true,
      requests: [{ node: id("p-ok"), action: "park", args: {} }, { node: id("p-mudo"), action: "park", args: {} }],
    });
  });
});
