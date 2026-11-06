// Grupo argos-terminals: rotas dos terminais criados no canvas (src/panel/argos-terminals.ts) com herdr falso (nenhum
// pane de verdade) — criar e fechar (D1: confirmação e aviso pelo acesso remoto), escolha por corpo > predefinição >
// papel > padrão, cwd contido, troca de papel reiniciando só o processo, CRUD de papéis e predefinições, descoberta e
// importação de role.json. O texto do papel nunca vai a log nem ao aviso.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGOS_ERROR_CODES } from "../../../src/lib/argos-roles";
import {
  agentWorktrees, chooseTerminal, createArgosTerminalsRoutes, createRateLimiter, DISCOVERED_TTL_MS, IMPORT_SKIP, TERMINAL_RATE, TERMINAL_REQUEST_TIMEOUT_S, TERMINAL_TIMEOUTS,
} from "../../../src/panel/argos-terminals";
import type { HerdrCall } from "../../../src/panel/herdr";

type Dict = Record<string, unknown>;

const T = realpathSync(mkdtempSync(join(tmpdir(), "hades-terminals-")));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const ROLE_TEXT = "INSTRUCOES-PRIVADAS-DO-PAPEL";
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
  });
  const post = async (path: string, body: Dict, remote = false): Promise<{ status: number; body: Dict }> => {
    const res = await (routes.post(path, body, { remote }) as Promise<Response>);
    return { status: res.status, body: (await res.json()) as Dict };
  };
  const get = async (path: string): Promise<Dict> => (await (routes.get(path) as Response).json()) as Dict;
  const registry = (): Dict[] => (existsSync(join(D, "argos/terminals.json")) ? (JSON.parse(readFileSync(join(D, "argos/terminals.json"), "utf8")) as { terminals: Dict[] }).terminals : []);
  return { D, clone, wt, fake, logs, notices, signals, clock, routes, post, get, registry };
}

const startCall = (r: ReturnType<typeof rig>): string[] | undefined => r.fake.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "start").at(-1)?.args;
/** O arquivo do papel de um pane (`$D/argos/terminal-prompts/default-<pane>.md`). */
const promptFile = (r: ReturnType<typeof rig>, pane = "w1:p1"): string => join(r.D, "argos/terminal-prompts", `default-${pane.replace(":", "-")}.md`);
const ROLE = { name: "Revisor", color: "#a0b", instructions: ROLE_TEXT };

describe("argos-terminals: criar terminal", () => {
  test("pane novo com a tela ainda vazia: o agent start só sai depois do prompt desenhado (herdr 0.8.2 aceita cedo e perde o comando)", async () => {
    const r = rig();
    r.fake.state.blankReads = 3;
    const res = await r.post("/api/argos/terminals", { name: "dev 1" });
    expect(res.status).toBe(200);
    const ops = r.fake.calls.map((c) => `${c.args[0]} ${c.args[1]}`);
    const start = ops.indexOf("agent start");
    expect(ops.slice(0, start).filter((op) => op === "pane read").length).toBe(3 + TERMINAL_TIMEOUTS.promptSteady);
    expect(r.logs.some((l) => l.includes("não chegou ao prompt"))).toBe(false);
  });
  test("shell que nunca desenha o prompt: no teto o agent start segue e o aviso fica no log", async () => {
    const r = rig();
    r.fake.state.blankReads = Number.POSITIVE_INFINITY;
    const res = await r.post("/api/argos/terminals", { name: "dev 1" });
    expect(res.status).toBe(200);
    expect(r.fake.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "read").length).toBe(TERMINAL_TIMEOUTS.promptPolls);
    expect(startCall(r)).toBeDefined();
    expect(r.logs.some((l) => l.includes("não chegou ao prompt"))).toBe(true);
  });
  test("o prazo da requisição no servidor cobre criar o pane, esperar o prompt, o start e o fechar de um start que falhou", () => {
    const worst = 2 * TERMINAL_TIMEOUTS.paneMs + TERMINAL_TIMEOUTS.promptPolls * TERMINAL_TIMEOUTS.promptPollMs + TERMINAL_TIMEOUTS.startMs;
    expect(TERMINAL_REQUEST_TIMEOUT_S * 1000).toBeGreaterThan(worst);
  });
  test("local, sem confirm nem campos: abre no clone com o agente padrão e devolve só o escolhido", async () => {
    const r = rig();
    const res = await r.post("/api/argos/terminals", { name: "dev 1" });
    expect(res).toEqual({ status: 200, body: { herdr: { session: "default", pane: "w1:p1" }, agent: "claude" } });
    expect(r.fake.calls[0]).toEqual({ session: null, args: ["workspace", "create", "--cwd", r.clone, "--label", "dev 1", "--no-focus"] });
    expect(startCall(r)).toEqual(["agent", "start", "dev 1", "--kind", "claude", "--pane", "w1:p1", "--timeout", String(TERMINAL_TIMEOUTS.startMs - 5000)]);
    expect(r.registry()).toMatchObject([{ session: "default", pane: "w1:p1", name: "dev 1", agent: "claude", cwd: r.clone }]);
    expect(r.notices).toEqual([]);
  });

  test("predefinição e papel entram como --model/--effort/--append-system-prompt; o corpo vence a predefinição", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: ROLE });
    await r.post("/api/argos/presets", { preset: { name: "Rápido", agent: "claude", model: "claude-sonnet-5-5", effort: "low", role: "revisor" } });
    const res = await r.post("/api/argos/terminals", { name: "rev", preset: "rapido", effort: "high" });
    expect(res.body).toEqual({ herdr: { session: "default", pane: "w1:p1" }, agent: "claude", model: "claude-sonnet-5-5", effort: "high", role: "revisor" });
    expect(startCall(r)?.slice(-7)).toEqual(["--", "--model", "claude-sonnet-5-5", "--effort", "high", "--append-system-prompt-file", promptFile(r)]);
    expect(readFileSync(promptFile(r), "utf8")).toBe(ROLE_TEXT);
  });

  test("sem predefinição, o modelo do papel vale; papel em agente que não aceita instruções é invalid sem abrir pane", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: { ...ROLE, model: "claude-opus-5-5" } });
    expect((await r.post("/api/argos/terminals", { name: "a", role: "revisor" })).body.model).toBe("claude-opus-5-5");
    const calls = r.fake.calls.length;
    const res = await r.post("/api/argos/terminals", { name: "b", role: "revisor", agent: "codex" });
    expect([res.status, res.body.code]).toEqual([400, ARGOS_ERROR_CODES.invalid]);
    expect(r.fake.calls.length).toBe(calls);
  });

  test("remoto sem confirm igual ao nome é 403 confirm-required, sem tocar no herdr", async () => {
    const r = rig();
    for (const confirm of [undefined, "outro"]) {
      const res = await r.post("/api/argos/terminals", { name: "dev", confirm }, true);
      expect([res.status, res.body.code]).toEqual([403, ARGOS_ERROR_CODES.confirmRequired]);
    }
    expect(r.fake.calls).toEqual([]);
  });

  test("remoto com confirm cria e avisa o dono só com ação e nome", async () => {
    const r = rig();
    expect((await r.post("/api/argos/terminals", { name: "dev", confirm: "dev" }, true)).status).toBe(200);
    expect(r.notices).toEqual([["terminal-criar", "dev"]]);
    expect(r.logs.some((l) => l.includes('"origem":"remoto"'))).toBe(true);
  });

  test("cwd fora do worktree do canvas e do clone é invalid: outra pasta, `..` e link para fora", async () => {
    const r = rig();
    for (const cwd of [join(r.D, "fora"), join(r.clone, "..", "fora"), join(r.clone, "atalho"), "relativo/x", join(r.clone, "nao-existe")]) {
      const res = await r.post("/api/argos/terminals", { name: "x", cwd });
      expect([cwd, res.status, res.body.code]).toEqual([cwd, 400, ARGOS_ERROR_CODES.invalid]);
    }
    expect(r.fake.calls).toEqual([]);
  });

  test("cwd numa subpasta do clone ou na worktree de um agente é aceito", async () => {
    const r = rig();
    await r.post("/api/argos/terminals", { name: "a", cwd: join(r.clone, "sub") });
    await r.post("/api/argos/terminals", { name: "b", cwd: r.wt });
    expect(r.registry().map((t) => t.cwd)).toEqual([join(r.clone, "sub"), r.wt]);
  });

  test("predefinição ou papel inexistente é 404 not-found", async () => {
    const r = rig();
    expect((await r.post("/api/argos/terminals", { name: "a", preset: "nao-ha" })).status).toBe(404);
    expect((await r.post("/api/argos/terminals", { name: "a", role: "nao-ha" })).body.code).toBe(ARGOS_ERROR_CODES.notFound);
  });

  test("nome repetido de terminal vivo é invalid; o nome de um pane que já sumiu volta a valer", async () => {
    const r = rig();
    await r.post("/api/argos/terminals", { name: "dev" });
    expect((await r.post("/api/argos/terminals", { name: "dev" })).status).toBe(400);
    r.fake.panes.clear();
    expect((await r.post("/api/argos/terminals", { name: "dev" })).status).toBe(200);
    expect(r.registry().map((t) => t.pane)).toEqual(["w2:p1"]);
  });

  test("agent start recusado: 502 herdr-failed com mensagem genérica, pane fechado e nada registrado", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: ROLE });
    r.fake.state.failStart = true;
    const res = await r.post("/api/argos/terminals", { name: "dev", role: "revisor" });
    expect([res.status, res.body.code]).toEqual([502, ARGOS_ERROR_CODES.herdrFailed]);
    expect(String(res.body.error)).not.toContain(T);
    expect(r.fake.calls.at(-1)?.args).toEqual(["pane", "close", "w1:p1"]);
    expect(r.registry()).toEqual([]);
  });

  test("o texto do papel nunca vai a log nem ao aviso", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: ROLE });
    await r.post("/api/argos/terminals", { name: "dev", role: "revisor", confirm: "dev" }, true);
    r.fake.state.failStart = true;
    await r.post("/api/argos/terminals", { name: "dev2", role: "revisor", confirm: "dev2" }, true);
    expect([...r.logs, ...r.notices.flat()].join("\n")).not.toContain(ROLE_TEXT);
  });

  test("nome fora do formato é invalid", async () => {
    const r = rig();
    for (const name of ["", "-x", "a/b", "x".repeat(41), 3]) expect((await r.post("/api/argos/terminals", { name })).status).toBe(400);
  });
});

describe("argos-terminals: papel por arquivo", () => {
  const MULTI = "linha 1\n\nlinha 3 com `crase`, $VAR, \"aspas\", acentos é ã e apóstrofo d'água";
  const afterDashes = (r: ReturnType<typeof rig>): string[] => (startCall(r) ?? []).slice((startCall(r) ?? []).indexOf("--") + 1);

  test("papel de várias linhas vira --append-system-prompt-file <caminho>, sem quebra de linha em nenhum argumento", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: { ...ROLE, instructions: MULTI } });
    const res = await r.post("/api/argos/terminals", { name: "dev", role: "revisor" });
    expect(res.status).toBe(200);
    expect(afterDashes(r)).toEqual(["--append-system-prompt-file", promptFile(r)]);
    expect((startCall(r) ?? []).some((arg) => arg.includes("\n"))).toBe(false);
  });

  test("o arquivo é 600, a pasta 700, com o texto exato (papel e blocos extras separados por linha em branco)", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: { ...ROLE, instructions: MULTI } });
    await r.post("/api/argos/terminals", { name: "dev", role: "revisor", instructions: "PROPRIAS" });
    expect(readFileSync(promptFile(r), "utf8")).toBe(`${MULTI}\n\nPROPRIAS`);
    expect(statSync(promptFile(r)).mode & 0o777).toBe(0o600);
    expect(statSync(join(r.D, "argos/terminal-prompts")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(r.D, "argos/terminal-prompts"))).toEqual(["default-w1-p1.md"]);
  });

  test("o texto do papel não vai a log", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: { ...ROLE, instructions: MULTI } });
    await r.post("/api/argos/terminals", { name: "dev", role: "revisor" });
    expect(r.logs.join("\n")).not.toContain("linha 3");
  });

  test("fechar o terminal apaga o arquivo", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: { ...ROLE, instructions: MULTI } });
    await r.post("/api/argos/terminals", { name: "dev", role: "revisor" });
    await r.post("/api/argos/terminals/close", { session: "default", pane: "w1:p1", name: "dev" });
    expect(existsSync(promptFile(r))).toBe(false);
  });

  test("trocar o papel regrava o arquivo com o texto novo", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: { ...ROLE, instructions: MULTI } });
    await r.post("/api/argos/roles", { role: { name: "Outro", color: "#0a0", instructions: "novo\npapel" } });
    await r.post("/api/argos/terminals", { name: "dev", role: "revisor" });
    const res = await r.post("/api/argos/terminals/role", { session: "default", pane: "w1:p1", name: "dev", role: "outro" });
    expect(res.status).toBe(200);
    expect(readFileSync(promptFile(r), "utf8")).toBe("novo\npapel");
    expect(afterDashes(r)).toEqual(["--append-system-prompt-file", promptFile(r)]);
  });

  test("agent start recusado: o arquivo não fica para trás", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: { ...ROLE, instructions: MULTI } });
    r.fake.state.failStart = true;
    expect((await r.post("/api/argos/terminals", { name: "dev", role: "revisor" })).body.code).toBe(ARGOS_ERROR_CODES.herdrFailed);
    expect(existsSync(promptFile(r))).toBe(false);
  });

  test("pane que sumiu: o arquivo dele é apagado na próxima criação", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: { ...ROLE, instructions: MULTI } });
    await r.post("/api/argos/terminals", { name: "dev", role: "revisor" });
    r.fake.panes.delete("w1:p1");
    await r.post("/api/argos/terminals", { name: "outro" });
    expect(existsSync(promptFile(r))).toBe(false);
  });

  test("agente sem flag de arquivo com papel de várias linhas: 400 unsafe-argument, sem tocar no herdr", async () => {
    const r = rig();
    const sys = await import("../../../src/lib/argos-roles");
    (sys.AGENT_KINDS as Record<string, object>).inline = { systemPrompt: "--prompt" };
    try {
      await r.post("/api/argos/roles", { role: { ...ROLE, agent: "claude", instructions: MULTI } });
      const calls = r.fake.calls.length;
      const res = await r.post("/api/argos/terminals", { name: "dev", role: "revisor", agent: "inline" });
      expect([res.status, res.body.code]).toEqual([400, ARGOS_ERROR_CODES.unsafeArgument]);
      expect(String(res.body.error)).toContain("várias linhas");
      expect(r.fake.calls.length).toBe(calls);
      // uma linha só passa pelo argumento
      await r.post("/api/argos/roles", { role: { name: "Curto", color: "#111", instructions: "uma linha" } });
      expect((await r.post("/api/argos/terminals", { name: "dev2", role: "curto", agent: "inline" })).status).toBe(200);
      expect(afterDashes(r)).toEqual(["--prompt", "uma linha"]);
    } finally {
      delete (sys.AGENT_KINDS as Record<string, object>).inline;
    }
  });

  test("argumento fora do papel com quebra de linha (modelo) é recusado antes do herdr, com código próprio", async () => {
    const r = rig();
    const agentArgs = (await import("../../../src/panel/argos-terminals")).agentArgs;
    expect(() => agentArgs({ agent: "claude", model: "a\nb" })).toThrow(expect.objectContaining({ code: ARGOS_ERROR_CODES.unsafeArgument }));
    expect(r.fake.calls).toEqual([]);
  });
});

describe("argos-terminals: fechar terminal", () => {
  test("fecha o pane do herdr e tira do registro", async () => {
    const r = rig();
    await r.post("/api/argos/terminals", { name: "dev" });
    expect((await r.post("/api/argos/terminals/close", { session: "default", pane: "w1:p1", name: "dev" })).body).toEqual({ ok: true });
    expect(r.fake.calls.at(-1)?.args).toEqual(["pane", "close", "w1:p1"]);
    expect(r.registry()).toEqual([]);
  });

  test("pane que o canvas não criou (ou nome que não bate) é 404 not-found, sem fechar nada", async () => {
    const r = rig();
    await r.post("/api/argos/terminals", { name: "dev" });
    r.fake.panes.add("w9:p1");
    const calls = r.fake.calls.length;
    expect((await r.post("/api/argos/terminals/close", { session: "default", pane: "w9:p1", name: "dev" })).status).toBe(404);
    expect((await r.post("/api/argos/terminals/close", { session: "default", pane: "w1:p1", name: "outro" })).status).toBe(404);
    expect((await r.post("/api/argos/terminals/close", { session: "../x", pane: "w1:p1", name: "dev" })).status).toBe(400);
    expect(r.fake.calls.length).toBe(calls);
  });

  test("remoto sem confirm é 403; com confirm fecha e avisa", async () => {
    const r = rig();
    await r.post("/api/argos/terminals", { name: "dev" });
    const target = { session: "default", pane: "w1:p1", name: "dev" };
    expect((await r.post("/api/argos/terminals/close", target, true)).body.code).toBe(ARGOS_ERROR_CODES.confirmRequired);
    expect((await r.post("/api/argos/terminals/close", { ...target, confirm: "dev" }, true)).status).toBe(200);
    expect(r.notices).toEqual([["terminal-fechar", "dev"]]);
  });

  test("pane que já sumiu do herdr só sai do registro (repetir é inofensivo)", async () => {
    const r = rig();
    await r.post("/api/argos/terminals", { name: "dev" });
    r.fake.panes.clear();
    const calls = r.fake.calls.length;
    expect((await r.post("/api/argos/terminals/close", { session: "default", pane: "w1:p1", name: "dev" })).status).toBe(200);
    expect(r.fake.calls.length).toBe(calls);
    expect(r.registry()).toEqual([]);
  });
});

describe("argos-terminals: trocar papel", () => {
  const target = { session: "default", pane: "w1:p1", name: "dev" };

  test("mata só o processo do agente (não o shell) e sobe de novo no mesmo pane com o papel novo", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: ROLE });
    await r.post("/api/argos/terminals", { name: "dev", model: "claude-opus-5-5" });
    const res = await r.post("/api/argos/terminals/role", { ...target, role: "revisor" });
    expect(res.body).toEqual({ herdr: { session: "default", pane: "w1:p1" } });
    expect(r.signals).toEqual([500]);
    expect(startCall(r)?.slice(-5)).toEqual(["--", "--model", "claude-opus-5-5", "--append-system-prompt-file", promptFile(r)]);
    expect(readFileSync(promptFile(r), "utf8")).toBe(ROLE_TEXT);
    expect(r.fake.calls.filter((c) => c.args[0] === "workspace").length).toBe(1);
    expect(r.registry()[0]?.role).toBe("revisor");
  });

  test("role null tira o papel: o agente sobe sem --append-system-prompt-file e o arquivo some", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: ROLE });
    await r.post("/api/argos/terminals", { name: "dev", role: "revisor" });
    expect(existsSync(promptFile(r))).toBe(true);
    await r.post("/api/argos/terminals/role", { ...target, role: null });
    expect(startCall(r)).not.toContain("--append-system-prompt-file");
    expect(existsSync(promptFile(r))).toBe(false);
    expect(r.registry()[0]?.role).toBeUndefined();
  });

  test("processo que não sai é 502 herdr-failed e o agente não é iniciado de novo", async () => {
    const r = rig();
    await r.post("/api/argos/terminals", { name: "dev" });
    r.fake.state.stuck = true;
    const starts = r.fake.calls.filter((c) => c.args[1] === "start").length;
    const res = await r.post("/api/argos/terminals/role", { ...target, role: null });
    expect([res.status, res.body.code]).toEqual([502, ARGOS_ERROR_CODES.herdrFailed]);
    expect(r.fake.calls.filter((c) => c.args[1] === "start").length).toBe(starts);
  });

  test("remoto sem confirm é 403 sem matar nada; papel inexistente é 404; role ausente é invalid", async () => {
    const r = rig();
    await r.post("/api/argos/terminals", { name: "dev" });
    expect((await r.post("/api/argos/terminals/role", { ...target, role: null }, true)).status).toBe(403);
    expect((await r.post("/api/argos/terminals/role", { ...target, role: "nao-ha" })).status).toBe(404);
    expect((await r.post("/api/argos/terminals/role", target)).status).toBe(400);
    expect(r.signals).toEqual([]);
  });
});

describe("argos-terminals: papéis e predefinições pelas rotas", () => {
  test("CRUD de predefinições e as listas por GET", async () => {
    const r = rig();
    const saved = await r.post("/api/argos/presets", { preset: { name: "Claude", agent: "claude" } });
    expect(saved.body).toEqual({ preset: { name: "Claude", agent: "claude", slug: "claude" } });
    await r.post("/api/argos/presets", { preset: { name: "Claude", agent: "claude", icon: "🤖" }, slug: "claude" });
    expect(await r.get("/api/argos/presets")).toEqual({ presets: [{ name: "Claude", agent: "claude", icon: "🤖", slug: "claude" }] });
    expect((await r.post("/api/argos/presets/delete", { slug: "claude" })).body).toEqual({ ok: true });
    expect((await r.post("/api/argos/presets/delete", { slug: "claude" })).status).toBe(404);
  });

  test("apagar papel sem confirm igual ao slug é 403 confirm-required e o papel fica", async () => {
    const r = rig();
    await r.post("/api/argos/roles", { role: ROLE });
    for (const confirm of [undefined, "Revisor"]) {
      const res = await r.post("/api/argos/roles/delete", { slug: "revisor", confirm });
      expect([res.status, res.body.code]).toEqual([403, ARGOS_ERROR_CODES.confirmRequired]);
    }
    expect(((await r.get("/api/argos/roles")).roles as Dict[]).length).toBe(1);
    expect((await r.post("/api/argos/roles/delete", { slug: "revisor", confirm: "revisor" })).body).toEqual({ ok: true });
    expect(await r.get("/api/argos/roles")).toEqual({ roles: [] });
  });

  test("papel inválido é 400 invalid com { error, code }", async () => {
    const r = rig();
    const res = await r.post("/api/argos/roles", { role: { name: "x" } });
    expect([res.status, res.body.code, typeof res.body.error]).toEqual([400, ARGOS_ERROR_CODES.invalid, "string"]);
  });

  test("caminho de outra família não é destas rotas", () => {
    const r = rig();
    expect(r.routes.get("/api/argos/graph")).toBeUndefined();
    expect(r.routes.post("/api/argos/action", {}, { remote: false })).toBeUndefined();
    expect(r.routes.post("/api/argos/terminals/__proto__", {}, { remote: false })).toBeUndefined();
  });
});

describe("argos-terminals: descobrir e importar role.json", () => {
  const seed = (r: ReturnType<typeof rig>): void => {
    const put = (rel: string, name: string): void => {
      mkdirSync(join(r.clone, rel), { recursive: true });
      writeFileSync(join(r.clone, rel, "role.json"), JSON.stringify({ ...ROLE, name }));
    };
    put("papeis/a", "Testador");
    put("papeis/b", "Revisor");
    put("n1/n2/n3/n4", "Profundo");
  };

  test("acha até 3 níveis abaixo do cwd (o 4º fica de fora) e marca o que já existe", async () => {
    const r = rig();
    seed(r);
    await r.post("/api/argos/roles", { role: ROLE });
    const res = await r.post("/api/argos/roles/discover", { cwd: r.clone });
    const found = res.body.found as { path: string; slug: string; exists: boolean; role: Dict }[];
    expect(found.map((f) => [f.slug, f.exists])).toEqual([["testador", false], ["revisor", true]]);
    expect(found[0]?.path).toBe(join(r.clone, "papeis/a/role.json"));
  });

  test("cwd de descoberta fora das raízes é invalid", async () => {
    const r = rig();
    expect((await r.post("/api/argos/roles/discover", { cwd: join(r.D, "fora") })).body.code).toBe(ARGOS_ERROR_CODES.invalid);
  });

  test("importa só o que a descoberta devolveu; o que já existe é pulado; caminho estranho é not-discovered", async () => {
    const r = rig();
    seed(r);
    await r.post("/api/argos/roles", { role: ROLE });
    await r.post("/api/argos/roles/discover", { cwd: r.clone });
    const paths = [join(r.clone, "papeis/a/role.json"), join(r.clone, "papeis/b/role.json"), join(r.clone, "n1/n2/n3/n4/role.json"), "/etc/passwd"];
    const res = await r.post("/api/argos/roles/import", { paths });
    expect((res.body.imported as Dict[]).map((x) => x.slug)).toEqual(["testador"]);
    expect(res.body.skipped).toEqual([
      { path: paths[1], reason: IMPORT_SKIP.exists }, { path: paths[2], reason: IMPORT_SKIP.notDiscovered }, { path: paths[3], reason: IMPORT_SKIP.notDiscovered },
    ]);
  });

  test("caminho descoberto vence depois do prazo", async () => {
    const r = rig();
    seed(r);
    await r.post("/api/argos/roles/discover", { cwd: r.clone });
    r.clock.now += DISCOVERED_TTL_MS + 1;
    const res = await r.post("/api/argos/roles/import", { paths: [join(r.clone, "papeis/a/role.json")] });
    expect(res.body).toEqual({ imported: [], skipped: [{ path: join(r.clone, "papeis/a/role.json"), reason: IMPORT_SKIP.notDiscovered }] });
  });

  test("paths que não é lista de texto é invalid", async () => {
    const r = rig();
    for (const paths of [undefined, "x", [1]]) expect((await r.post("/api/argos/roles/import", { paths })).status).toBe(400);
  });
});

describe("argos-terminals: limite de taxa em criar e fechar", () => {
  const raw = (r: ReturnType<typeof rig>, path: string, body: Dict, remote = false): Promise<Response> =>
    r.routes.post(path, body, { remote }) as Promise<Response>;

  test(`a ${TERMINAL_RATE.max + 1}ª criação no minuto é 429 rate-limited com Retry-After, sem tocar no herdr`, async () => {
    const r = rig();
    for (let i = 0; i < TERMINAL_RATE.max; i++) expect((await r.post("/api/argos/terminals", { name: `t${i}` })).status).toBe(200);
    const calls = r.fake.calls.length;
    const res = await raw(r, "/api/argos/terminals", { name: "demais" });
    expect([res.status, ((await res.json()) as Dict).code, res.headers.get("Retry-After")]).toEqual([429, ARGOS_ERROR_CODES.rateLimited, "60"]);
    expect(r.fake.calls.length).toBe(calls);
  });

  test("tentativa recusada por validação também conta; passada a janela, volta a valer", async () => {
    const r = rig();
    for (let i = 0; i < TERMINAL_RATE.max; i++) expect((await r.post("/api/argos/terminals", { name: "" })).status).toBe(400);
    r.clock.now += 30_000;
    const res = await raw(r, "/api/argos/terminals", { name: "dev" });
    expect([res.status, res.headers.get("Retry-After")]).toEqual([429, "30"]);
    r.clock.now += 30_000;
    expect((await r.post("/api/argos/terminals", { name: "dev" })).status).toBe(200);
  });

  test("o limite é por origem: local esgotado não barra o remoto (e o 429 vem antes do confirm)", async () => {
    const r = rig();
    for (let i = 0; i < TERMINAL_RATE.max; i++) await r.post("/api/argos/terminals", { name: "" });
    expect((await r.post("/api/argos/terminals", { name: "dev", confirm: "dev" }, true)).status).toBe(200);
    for (let i = 0; i < TERMINAL_RATE.max - 1; i++) await r.post("/api/argos/terminals", { name: "x" }, true);
    expect((await r.post("/api/argos/terminals", { name: "y" }, true)).body.code).toBe(ARGOS_ERROR_CODES.rateLimited);
  });

  test("fechar tem contagem própria, com o mesmo teto", async () => {
    const r = rig();
    for (let i = 0; i < TERMINAL_RATE.max; i++) await r.post("/api/argos/terminals", { name: "" });
    const target = { session: "default", pane: "w1:p1", name: "nao-ha" };
    for (let i = 0; i < TERMINAL_RATE.max; i++) expect((await r.post("/api/argos/terminals/close", target)).status).toBe(404);
    const res = await raw(r, "/api/argos/terminals/close", target);
    expect([res.status, res.headers.get("Retry-After")]).toEqual([429, "60"]);
  });

  test("papéis e predefinições não entram no limite", async () => {
    const r = rig();
    for (let i = 0; i < TERMINAL_RATE.max + 2; i++) expect((await r.post("/api/argos/presets", { preset: { name: `p${i}`, agent: "claude" } })).status).toBe(200);
  });

  test("janela deslizante: o Retry-After conta até a tentativa mais antiga sair, nunca menos de 1 s", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 2, windowMs: 10_000 }, () => t);
    expect([limiter.take("k"), (t = 4000, limiter.take("k"))]).toEqual([undefined, undefined]);
    t = 9_999.5;
    expect(limiter.take("k")).toBe(1);
    t = 10_000;
    expect([limiter.take("k"), limiter.take("outra")]).toEqual([undefined, undefined]);
    expect(limiter.take("k")).toBe(4);
  });
});

describe("argos-terminals: raízes das worktrees de agente", () => {
  test("lê worktree absoluta dos agentes não encerrados; registro ilegível é pulado", () => {
    const orch = join(T, "orch");
    mkdirSync(join(orch, "agents"), { recursive: true });
    writeFileSync(join(orch, "agents", "a.json"), JSON.stringify({ worktree: "/wt/a", state: "working" }));
    writeFileSync(join(orch, "agents", "b.json"), JSON.stringify({ worktree: "/wt/b", state: "done" }));
    writeFileSync(join(orch, "agents", "c.json"), JSON.stringify({ worktree: "relativa" }));
    writeFileSync(join(orch, "agents", "d.json"), "{");
    expect(agentWorktrees([orch, join(T, "nao-ha")])).toEqual(["/wt/a"]);
  });
});

describe("argos-terminals: escolha com as Configurações do papel", () => {
  const role = (extra: Dict = {}) => ({ slug: "impl", name: "impl", color: "#000000", instructions: "x", ...extra }) as never;
  const settings = { model: "claude-sonnet-5-5", effort: "medium" };

  test("dado nada mandado nem no papel, quando escolhe, então valem as Configurações", () => {
    expect(chooseTerminal({}, undefined, role(), settings)).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
  });

  test("dado campo no corpo, na predefinição ou no papel, quando escolhe, então ele vence as Configurações, nessa ordem", () => {
    const preset = { slug: "p", name: "p", agent: "claude", model: "do-preset" } as never;
    expect(chooseTerminal({ model: "do-corpo" }, preset, role({ model: "do-papel" }), settings).model).toBe("do-corpo");
    expect(chooseTerminal({}, preset, role({ model: "do-papel" }), settings).model).toBe("do-preset");
    expect(chooseTerminal({}, undefined, role({ model: "do-papel" }), settings).model).toBe("do-papel");
  });

  test("dado agente sem flag de esforço, quando escolhe, então o esforço das Configurações não entra (não recusa a criação)", () => {
    const choice = chooseTerminal({ agent: "codex" }, undefined, role(), settings);
    expect(choice.effort).toBeUndefined();
    expect(choice.model).toBe("claude-sonnet-5-5");
  });

  test("dado sem Configurações, quando escolhe, então modelo e esforço ficam ausentes (herda o settings.json)", () => {
    const choice = chooseTerminal({}, undefined, role());
    expect([choice.model, choice.effort]).toEqual([undefined, undefined]);
  });
});
