// Terminal de shell do canvas (`shell: true` em POST /api/argos/terminals, src/panel/argos-terminals.ts) com herdr falso:
// só o pane na pasta escolhida, sem `agent start`, e fechar fecha o pane.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArgosTerminalsRoutes } from "../../../src/panel/argos-terminals";
import type { HerdrCall } from "../../../src/panel/herdr";

type Dict = Record<string, unknown>;

const T = realpathSync(mkdtempSync(join(tmpdir(), "hades-terminal-shell-")));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const SHELL_PID = 10;

/** herdr falso: panes vivos, processos do primeiro plano por pane e as chamadas recebidas. */
function fakeHerdr() {
  const calls: { session: string | null; args: string[] }[] = [];
  const panes = new Set<string>();
  const procs = new Map<string, number[]>();
  const state = { next: 1, nextPid: 500, failStart: false, stuck: false, down: false, blankReads: 0, reads: 0 };
  const ok = (out = "{}"): HerdrCall => ({ rc: 0, out, err: "" });
  return {
    calls, panes, procs, state,
    herdr: {
      async call(session: string | null, args: string[]): Promise<HerdrCall> {
        calls.push({ session, args });
        const [a, b] = args;
        if (a === "workspace" && b === "create") {
          const pane = `w${state.next++}:p1`;
          panes.add(pane);
          procs.set(pane, []);
          return ok(JSON.stringify({ result: { workspace: { workspace_id: "w" }, pane: { pane_id: pane } } }));
        }
        if (a === "agent" && b === "start") {
          // como o herdr real (0.8.2): quebra de linha em argumento depois do `--` é recusada
          if (args.slice(args.indexOf("--") + 1).some((arg) => arg.includes("\n"))) return { rc: 1, out: "", err: "invalid_agent_argument: agent arguments cannot be encoded safely for the target shell" };
          if (state.failStart) return { rc: 1, out: "", err: `agent not ready em ${T}/segredo` };
          const pane = args[args.indexOf("--pane") + 1] as string;
          procs.set(pane, [state.nextPid++]);
          return ok();
        }
        if (a === "pane" && b === "read") {
          // o shell recém-aberto ainda não desenhou o prompt nas primeiras `blankReads` leituras
          state.reads++;
          return ok(state.reads <= state.blankReads ? "" : "~/clone ❯ ");
        }
        if (a === "pane" && b === "close") {
          panes.delete(args[2] as string);
          return ok();
        }
        return { rc: 1, out: "", err: "comando inesperado" };
      },
      async json(_session: string | null, args: string[]): Promise<Dict | null> {
        if (args[0] !== "pane" || args[1] !== "process-info") return null;
        const pane = args[3] as string;
        return { process_info: { shell_pid: SHELL_PID, foreground_processes: [{ pid: SHELL_PID }, ...(procs.get(pane) ?? []).map((pid) => ({ pid }))] } };
      },
      async snap(): Promise<Dict | null> {
        return state.down ? null : { panes: [...panes].map((pane_id) => ({ pane_id })) };
      },
      forget(): void {},
    },
  };
}

let n = 0;
function rig() {
  const D = join(T, `d${n++}`);
  const clone = join(D, "clone");
  const wt = join(D, "wt-agente");
  mkdirSync(join(clone, "sub"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(D, "fora"), { recursive: true });
  symlinkSync(join(D, "fora"), join(clone, "atalho"));
  const fake = fakeHerdr();
  const logs: string[] = [];
  const notices: string[][] = [];
  const signals: number[] = [];
  const clock = { now: 1_800_000_000_000 };
  const routes = createArgosTerminalsRoutes({
    dir: D, herdr: fake.herdr, roots: () => [clone, wt],
    notify: async (what, target) => void notices.push([what, target]),
    signal: (pid) => {
      signals.push(pid);
      if (!fake.state.stuck) for (const [pane, pids] of fake.procs) fake.procs.set(pane, pids.filter((p) => p !== pid));
    },
    sleep: async () => undefined,
    now: () => clock.now,
    log: (level, event, fields) => void logs.push(JSON.stringify({ level, event, ...fields })),
    canvasPanes: () => [],
  });
  const post = async (path: string, body: Dict, remote = false): Promise<{ status: number; body: Dict }> => {
    const res = await (routes.post(path, body, { remote }) as Promise<Response>);
    return { status: res.status, body: (await res.json()) as Dict };
  };
  const get = async (path: string): Promise<Dict> => (await (routes.get(path) as Response).json()) as Dict;
  const registry = (): Dict[] => (existsSync(join(D, "argos/terminals.json")) ? (JSON.parse(readFileSync(join(D, "argos/terminals.json"), "utf8")) as { terminals: Dict[] }).terminals : []);
  return { D, clone, wt, fake, logs, notices, signals, clock, routes, post, get, registry };
}


const agentStarts = (r: ReturnType<typeof rig>): string[][] => r.fake.calls.filter((c) => c.args[0] === "agent").map((c) => c.args);

describe("argos-terminals: terminal de shell", () => {
  test("abre o pane no clone, sem agent start, e registra como shell", async () => {
    const r = rig();
    const res = await r.post("/api/argos/terminals", { name: "shell", shell: true });
    expect(res).toEqual({ status: 200, body: { herdr: { session: "default", pane: "w1:p1" }, agent: "shell", shell: true } });
    expect(r.fake.calls[0]).toEqual({ session: null, args: ["workspace", "create", "--cwd", r.clone, "--label", "shell", "--no-focus"] });
    expect(agentStarts(r)).toEqual([]);
    expect(r.fake.calls.some((c) => c.args[0] === "pane" && c.args[1] === "read")).toBe(false);
    expect(r.registry()).toMatchObject([{ pane: "w1:p1", name: "shell", agent: "shell", cwd: r.clone, shell: true }]);
  });

  test("a pasta escolhida vale e fica contida: fora do clone e das worktrees é invalid sem abrir pane", async () => {
    const r = rig();
    expect((await r.post("/api/argos/terminals", { name: "s1", shell: true, cwd: join(r.clone, "sub") })).status).toBe(200);
    const out = await r.post("/api/argos/terminals", { name: "s2", shell: true, cwd: join(r.D, "fora") });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe("invalid");
    expect(r.fake.panes.size).toBe(1);
  });

  test.each(["preset", "role", "agent", "model", "effort", "orchestrator", "instructions"])("shell com %s é invalid, sem abrir pane", async (field) => {
    const r = rig();
    const out = await r.post("/api/argos/terminals", { name: "shell", shell: true, [field]: field === "orchestrator" ? true : "x" });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe("invalid");
    expect(r.fake.calls).toEqual([]);
  });

  test("shell que não é booleano é invalid", async () => {
    const r = rig();
    expect((await r.post("/api/argos/terminals", { name: "shell", shell: "sim" })).body.code).toBe("invalid");
  });

  test("shell: false segue o caminho do agente", async () => {
    const r = rig();
    const res = await r.post("/api/argos/terminals", { name: "dev", shell: false });
    expect(res.body.agent).toBe("claude");
    expect(agentStarts(r).length).toBe(1);
  });

  test("remoto sem confirm igual ao nome é 403, com confirm cria e avisa o dono", async () => {
    const r = rig();
    expect((await r.post("/api/argos/terminals", { name: "shell", shell: true }, true)).status).toBe(403);
    expect(r.fake.calls).toEqual([]);
    expect((await r.post("/api/argos/terminals", { name: "shell", shell: true, confirm: "shell" }, true)).status).toBe(200);
    expect(r.notices).toEqual([["terminal-criar", "shell"]]);
  });

  test("nome repetido de terminal vivo é invalid, e o shell conta no limite com os de agente", async () => {
    const r = rig();
    await r.post("/api/argos/terminals", { name: "shell", shell: true });
    expect((await r.post("/api/argos/terminals", { name: "shell" })).body.code).toBe("invalid");
    expect((await r.post("/api/argos/terminals", { name: "shell", shell: true })).body.code).toBe("invalid");
  });

  test("fechar o nó fecha o pane e tira do registro", async () => {
    const r = rig();
    await r.post("/api/argos/terminals", { name: "shell", shell: true });
    const closed = await r.post("/api/argos/terminals/close", { session: "default", pane: "w1:p1", name: "shell" });
    expect(closed).toEqual({ status: 200, body: { ok: true } });
    expect(r.fake.panes.has("w1:p1")).toBe(false);
    expect(r.registry()).toEqual([]);
  });

  test("trocar o papel de um shell é invalid e não mexe no processo", async () => {
    const r = rig();
    await r.post("/api/argos/terminals", { name: "shell", shell: true });
    const before = r.fake.calls.length;
    const out = await r.post("/api/argos/terminals/role", { session: "default", pane: "w1:p1", name: "shell", role: null });
    expect(out.status).toBe(400);
    expect(r.fake.calls.length).toBe(before);
    expect(r.signals).toEqual([]);
  });

  test("shell vivo sem nó no canvas aparece como órfão marcado shell", async () => {
    const r = rig();
    await r.post("/api/argos/terminals", { name: "shell", shell: true });
    const res = (await (r.routes.orphans("/api/argos/terminals/orphans") as Promise<Response>)).json() as Promise<Dict>;
    expect((await res).orphans).toEqual([expect.objectContaining({ name: "shell", agent: "shell", shell: true })]);
  });
});
