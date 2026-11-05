// Servidor do herdr ausente (depois do reboot só o painel sobe): criar terminal devolve código próprio, sobe o servidor
// por demanda uma vez só e cai no erro legível se a subida falha. Herdr falso: nenhum servidor nem pane de verdade.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGOS_ERROR_CODES } from "../../../src/lib/argos-roles";
import { herdrServerDown } from "../../../src/lib/herdr";
import { ARGOS_ERROR_STATUS, createArgosTerminalsRoutes, TERMINAL_TIMEOUTS } from "../../../src/panel/argos-terminals";
import type { HerdrCall } from "../../../src/panel/herdr";

type Dict = Record<string, unknown>;
const T = realpathSync(mkdtempSync(join(tmpdir(), "hades-herdr-ausente-")));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const DOWN_STDERR = "no herdr server is running at /run/user/1000/herdr.sock; run `herdr` to start or attach it";
const SHELL_PID = 10;

/** herdr falso com servidor que pode estar fora; `startServer` o põe no ar (ou não, se `startWorks` é false). */
function rig(opts: { startWorks?: boolean; withStarter?: boolean; serverUp?: boolean } = {}) {
  const D = join(T, `d${Math.random().toString(36).slice(2)}`);
  const clone = join(D, "clone");
  mkdirSync(clone, { recursive: true });
  const calls: string[][] = [];
  const panes = new Set<string>();
  const state = { up: opts.serverUp ?? false, starts: 0, next: 1 };
  const down = (): HerdrCall => ({ rc: 1, out: "", err: DOWN_STDERR });
  const ok = (out = "{}"): HerdrCall => ({ rc: 0, out, err: "" });
  const herdr = {
    async call(_session: string | null, args: string[]): Promise<HerdrCall> {
      calls.push(args);
      if (!state.up) return down();
      const [a, b] = args;
      if (a === "api") return ok();
      if (a === "workspace" && b === "create") {
        const pane = `w${state.next++}:p1`;
        panes.add(pane);
        return ok(JSON.stringify({ result: { pane: { pane_id: pane } } }));
      }
      if (a === "agent" && b === "start") return ok();
      if (a === "pane" && b === "read") return ok("~ ❯ ");
      if (a === "pane" && b === "close") {
        panes.delete(args[2] as string);
        return ok();
      }
      return { rc: 1, out: "", err: "comando inesperado" };
    },
    async json(_s: string | null, args: string[]): Promise<Dict | null> {
      return args[1] === "process-info" ? { process_info: { shell_pid: SHELL_PID, foreground_processes: [{ pid: SHELL_PID }] } } : null;
    },
    async snap(): Promise<Dict | null> {
      return null;
    },
    forget(): void {},
    ...(opts.withStarter === false
      ? {}
      : {
          async startServer(): Promise<"detached"> {
            state.starts++;
            // a subida leva um tempo: o servidor só responde depois de alguns `sleep`
            if (opts.startWorks !== false) setTimeout(() => (state.up = true), 0);
            return "detached";
          },
        }),
  };
  const logs: string[] = [];
  const routes = createArgosTerminalsRoutes({
    dir: D, herdr, roots: () => [clone],
    notify: async () => undefined,
    signal: () => undefined,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    now: () => 1_800_000_000_000,
    log: (level, event, fields) => void logs.push(JSON.stringify({ level, event, ...fields })),
  });
  const create = async (name: string): Promise<{ status: number; body: Dict }> => {
    const res = await (routes.post("/api/argos/terminals", { name }, { remote: false }) as Promise<Response>);
    return { status: res.status, body: (await res.json()) as Dict };
  };
  return { calls, panes, state, logs, create };
}

describe("herdr ausente: reconhecer o erro", () => {
  test("o stderr do CLI e socket recusando conexão contam como servidor ausente", () => {
    expect(herdrServerDown(DOWN_STDERR)).toBe(true);
    expect(herdrServerDown("connect: Connection refused")).toBe(true);
    expect(herdrServerDown("agent not ready")).toBe(false);
    expect(herdrServerDown("")).toBe(false);
  });
  test("o código novo só acrescenta e tem status próprio", () => {
    expect(ARGOS_ERROR_CODES.herdrServerDown).toBe("herdr-server-down");
    expect(ARGOS_ERROR_CODES.herdrFailed).toBe("herdr-failed");
    expect(ARGOS_ERROR_STATUS[ARGOS_ERROR_CODES.herdrServerDown]).toBe(503);
  });
});

describe("herdr ausente: criar terminal", () => {
  test("sem como subir o servidor: devolve o código novo (não herdr-failed) e nenhum pane órfão", async () => {
    const r = rig({ withStarter: false });
    const res = await r.create("dev");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe(ARGOS_ERROR_CODES.herdrServerDown);
    expect(String(res.body.error)).toContain("abra o `herdr`");
    expect(r.panes.size).toBe(0);
  });
  test("servidor ausente na primeira chamada e no ar depois da subida: a criação conclui", async () => {
    const r = rig();
    const res = await r.create("dev");
    expect(res.status).toBe(200);
    expect(r.state.starts).toBe(1);
    expect(r.logs.some((l) => l.includes("subida automática por demanda"))).toBe(true);
    expect(r.panes.size).toBe(1);
  });
  test("dois pedidos simultâneos com o servidor ausente: uma subida só", async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.create("dev a"), r.create("dev b")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(r.state.starts).toBe(1);
  });
  test("servidor já no ar: não sobe nada", async () => {
    const r = rig({ serverUp: true });
    expect((await r.create("dev")).status).toBe(200);
    expect(r.state.starts).toBe(0);
  });
  test("a subida roda mas o servidor nunca responde: no teto sai o código novo, sem pane", async () => {
    const r = rig({ startWorks: false });
    const res = await r.create("dev");
    expect(res.body.code).toBe(ARGOS_ERROR_CODES.herdrServerDown);
    expect(r.state.starts).toBe(1);
    expect(r.panes.size).toBe(0);
    const polls = r.calls.filter((c) => c[0] === "api").length;
    expect(polls).toBeGreaterThanOrEqual(Math.ceil(TERMINAL_TIMEOUTS.serverUpMs / TERMINAL_TIMEOUTS.serverUpPollMs));
    expect(r.logs.some((l) => l.includes("não respondeu no teto"))).toBe(true);
  });
});
