// Grupo canvas-cli: `hades canvas` (src/commands/canvas.ts) contra as rotas reais do painel (documento, notas e terminais)
// sobre uma pasta temporária, com herdr falso (nenhum pane de verdade) — a leitura e a escrita de nota pela conexão (e a
// cadeia nota↔nota), o recrutamento com auto-layout e identidade, as recusas a quem não é orquestrador e o dispensar.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_CLI_ERRORS, type CanvasCliDeps, recruitBody, runCanvas, USAGE } from "../../../src/commands/canvas";
import { type CanvasDoc, type CanvasEdge, type CanvasNode, emptyCanvasDoc } from "../../../src/lib/canvas-doc";
import { LINK_EDGE_KIND } from "../../../src/lib/canvas-links";
import { RECRUIT_EDGE_KIND, RECRUIT_ERRORS, recruitSlots, terminalTargetOf } from "../../../src/lib/canvas-recruit";
import { EXIT } from "../../../src/lib/output";
import { createCanvasRoutes } from "../../../src/panel/canvas";
import { createCanvasNotesRoutes } from "../../../src/panel/canvas-notes";
import { createArgosTerminalsRoutes } from "../../../src/panel/argos-terminals";
import type { HerdrCall } from "../../../src/panel/herdr";

type Dict = Record<string, unknown>;

const T = realpathSync(mkdtempSync(join(tmpdir(), "hades-canvas-cli-")));
afterAll(() => rmSync(T, { recursive: true, force: true }));

const ORQ_PANE = "w0:p1";
const MANAGER = "INSTRUCOES-DE-GERENTE";
const SHELL_PID = 10;

const terminal = (id: string, pane: string, data: Dict = {}): CanvasNode =>
  ({ id, type: "terminal", x: 100, y: 50, w: 400, h: 240, z: 1, data: { name: id, agent: "claude", herdr: { session: "default", pane }, ...data }, locked: false, blurred: false });
const note = (id: string, file: string): CanvasNode => ({ id, type: "note", x: 900, y: 0, w: 200, h: 120, z: 1, data: { note: file }, locked: false, blurred: false });
const link = (id: string, from: string, to: string): CanvasEdge => ({ id, from, to, kind: LINK_EDGE_KIND });

/** herdr falso compartilhado pela rota de terminais (criar/fechar/reiniciar) e pela CLI (prompt da identidade). */
function fakeHerdr() {
  const calls: { session: string | null; args: string[] }[] = [];
  const panes = new Set<string>([ORQ_PANE]);
  const procs = new Map<string, number[]>();
  const state = { next: 1, nextPid: 500 };
  const ok = (out = "{}"): HerdrCall => ({ rc: 0, out, err: "" });
  return {
    calls, panes,
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
          // como o herdr real: quebra de linha em argumento depois do `--` é recusada
          if (args.slice(args.indexOf("--") + 1).some((arg) => arg.includes("\n"))) return { rc: 1, out: "", err: "invalid_agent_argument: agent arguments cannot be encoded safely for the target shell" };
          procs.set(args[args.indexOf("--pane") + 1] as string, [state.nextPid++]);
          return ok();
        }
        if (a === "agent" && b === "prompt") return panes.has(args[2] as string) ? ok() : { rc: 1, out: "", err: "pane não existe" };
        if (a === "pane" && b === "get") return panes.has(args[2] as string) ? ok() : { rc: 1, out: "", err: "pane não existe" };
        if (a === "pane" && b === "close") {
          panes.delete(args[2] as string);
          return ok();
        }
        return { rc: 1, out: "", err: "comando inesperado" };
      },
      async json(_session: string | null, args: string[]): Promise<Dict | null> {
        if (args[0] !== "pane" || args[1] !== "process-info") return null;
        const pids = procs.get(args[3] as string) ?? [];
        return { process_info: { shell_pid: SHELL_PID, foreground_processes: [{ pid: SHELL_PID }, ...pids.map((pid) => ({ pid }))] } };
      },
      async snap(): Promise<Dict | null> {
        return { panes: [...panes].map((pane_id) => ({ pane_id })) };
      },
      forget(): void {},
    },
    kill(pid: number) {
      for (const [pane, pids] of procs) procs.set(pane, pids.filter((p) => p !== pid));
    },
  };
}

let n = 0;
/** Painel de verdade (rotas do documento, das notas e dos terminais) numa pasta nova, com o documento `doc` gravado. */
async function rig(doc: CanvasDoc, managerText: () => string = () => MANAGER) {
  const D = join(T, `d${n++}`);
  const clone = join(D, "clone");
  mkdirSync(clone, { recursive: true });
  const canvas = createCanvasRoutes(D, () => new Date("2026-11-02T12:00:00Z"));
  const seeded = await canvas.put(new Request("http://127.0.0.1/api/canvas", { method: "PUT", body: JSON.stringify({ ...doc, rev: 0 }) }), { remote: false });
  expect(seeded.status).toBe(200);
  const loadDoc = async (id: string): Promise<CanvasDoc | undefined> => {
    const res = canvas.getMany(`/api/canvases/${id}`);
    return res?.status === 200 ? ((await res.json()) as CanvasDoc) : undefined;
  };
  let docNow: CanvasDoc | undefined = doc;
  const notes = createCanvasNotesRoutes(D, { loadDoc });
  const fake = fakeHerdr();
  const terminals = createArgosTerminalsRoutes({
    dir: D, herdr: fake.herdr, roots: () => [clone], managerText,
    notify: async () => undefined, signal: (pid) => fake.kill(pid), sleep: async () => undefined,
    now: () => 1_800_000_000_000, log: () => undefined,
    canvasPanes: () => (docNow ? docNow.nodes.flatMap((node) => { const at = terminalTargetOf(node); return at ? [at] : []; }) : []),
  });
  const panelCalls: string[] = [];
  const reply = async (res: Response | undefined) => {
    if (!res) return { status: 404, body: { error: "not found" } };
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
  };
  const req = (method: string, path: string, body: unknown): Request =>
    new Request(`http://127.0.0.1${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out: string[] = [];
  const err: string[] = [];
  const notified: [string, string][] = [];
  const io = { caller: { session: "default", pane: ORQ_PANE }, stdin: "" };
  const deps: CanvasCliDeps = {
    async panel(method, path, body) {
      panelCalls.push(`${method} ${path}`);
      if (method === "GET" && path === "/api/argos/graph") return { status: 200, body: { nodes: [] } };
      if (path.startsWith("/api/canvas-notes/")) {
        return reply(method === "GET" ? notes.get(path) : await notes.write(path, req(method, path, body), { remote: false }));
      }
      if (path.startsWith("/api/canvases")) {
        return reply(method === "GET" ? canvas.getMany(path) : await canvas.writeMany(method as "POST" | "PUT", path, {}, req(method, path, body), { remote: false }));
      }
      if (method === "GET" && path === "/api/argos/terminals/orphans") {
        docNow = await loadDoc("default");
        return reply(await terminals.orphans(path));
      }
      if (method === "POST" && path.startsWith("/api/argos/terminals")) return reply(await terminals.post(path, body as Dict, { remote: false }));
      return { status: 404, body: { error: "not found" } };
    },
    async herdr(session, args) {
      const r = await fake.herdr.call(session, args);
      return { rc: r.rc, err: r.err };
    },
    caller: async () => io.caller,
    prReady: () => ({ assignee: "dono-da-pr", labels: "fix,bug", reviewers: "revisora" }),
    stdin: async () => io.stdin,
    async notify(text, obj) {
      notified.push([text, obj]);
      return { rc: 0, err: "" };
    },
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
  };
  const run = async (...args: string[]): Promise<number> => {
    out.length = 0;
    err.length = 0;
    return runCanvas(args, deps);
  };
  const current = async (): Promise<CanvasDoc> => (await loadDoc("default")) as CanvasDoc;
  const noteText = async (name: string): Promise<string | undefined> => {
    const res = notes.get(`/api/canvas-notes/${name}`) as Response;
    return res.status === 200 ? ((await res.json()) as { text: string }).text : undefined;
  };
  const writeNote = async (name: string, text: string) =>
    expect((await notes.write(`/api/canvas-notes/${name}`, req("PUT", `/api/canvas-notes/${name}`, { text, rev: null }), { remote: false }) as Response).status).toBe(200);
  const terminal = async (path: string, body: Dict) => reply(await terminals.post(path, body, { remote: false }));
  return { D, fake, deps, io, out, err, notified, panelCalls, run, current, noteText, writeNote, terminal };
}

const lastCode = (err: string[]): string | undefined => /\(([a-z_0-9]+)\)\s*$/.exec(err.at(-1) ?? "")?.[1];

/** Orquestrador ligado à nota `briefing`, que liga em cadeia a `contexto`; `solta` não liga a ninguém; `comum` é terminal sem caixa. */
const baseDoc = (): CanvasDoc => ({
  ...emptyCanvasDoc(),
  nodes: [
    terminal("term-orq", ORQ_PANE, { name: "Chefe", orchestrator: true, color: "#36c" }),
    terminal("term-comum", "w9:p1", { name: "Comum" }),
    note("n-brief", "briefing"), note("n-ctx", "contexto"), note("n-solta", "solta"),
  ],
  edges: [link("l-brief", "term-orq", "n-brief"), link("l-cadeia", "n-brief", "n-ctx")],
});

describe("canvas-cli: argumentos", () => {
  test("sem subcomando mostra o uso e sai 0; subcomando desconhecido sai com uso", async () => {
    const r = await rig(baseDoc());
    expect(await r.run()).toBe(EXIT.ok);
    expect(r.err).toEqual([USAGE]);
    expect(await r.run("voar")).toBe(EXIT.usage);
    expect(await r.run("note", "apagar")).toBe(EXIT.usage);
  });

  test("opção desconhecida e opção sem valor saem com uso, sem chamar o painel", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("note", "list", "--xyz")).toBe(EXIT.usage);
    expect(await r.run("recruit", "--name")).toBe(EXIT.usage);
    expect(r.panelCalls).toEqual([]);
  });

  test("processo fora de um pane do herdr é recusado com código próprio", async () => {
    const r = await rig(baseDoc());
    r.io.caller = undefined as unknown as typeof r.io.caller;
    expect(await r.run("note", "list")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(CANVAS_CLI_ERRORS.noCaller);
  });

  test("pane que não é nó de nenhum canvas é recusado como fora do canvas", async () => {
    const r = await rig(baseDoc());
    r.io.caller = { session: "default", pane: "w77:p1" };
    expect(await r.run("note", "list")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(RECRUIT_ERRORS.notInCanvas);
  });

  test("um canvas que o painel não serve é pulado com aviso; o do terminal segue respondendo", async () => {
    const r = await rig(baseDoc());
    const panel = r.deps.panel;
    r.deps.panel = async (method, path, body) => {
      if (method === "GET" && path === "/api/canvases") {
        const list = await panel(method, path, body);
        const rows = (list.body as { canvases: Dict[] }).canvases;
        return { status: 200, body: { canvases: [{ id: "quebrado" }, ...rows] } };
      }
      if (method === "GET" && path === "/api/canvases/quebrado") return { status: 500, body: { error: "erro interno" } };
      return panel(method, path, body);
    };
    expect(await r.run("note", "list")).toBe(EXIT.ok);
    expect(r.out.join("\n")).toContain("briefing");
    expect(r.err.join("\n")).toContain("quebrado");
  });

  test("--canvas lê só o canvas pedido, sem listar os outros", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("note", "list", "--canvas", "default")).toBe(EXIT.ok);
    expect(r.panelCalls).not.toContain("GET /api/canvases");
    expect(r.out.join("\n")).toContain("briefing");
  });
});

describe("canvas-cli: notas pela conexão", () => {
  test("dado terminal sem aresta para a nota, quando lê, então recusa com saída 1 e não lê o arquivo", async () => {
    const r = await rig(baseDoc());
    await r.writeNote("solta", "segredo de outra equipe");
    expect(await r.run("note", "read", "solta")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(CANVAS_CLI_ERRORS.noteNoAccess);
    expect(r.out.join("\n")).not.toContain("segredo");
    expect(r.panelCalls).not.toContain("GET /api/canvas-notes/solta");
  });

  test("nota inexistente responde igual a nota sem conexão", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("note", "read", "nao-existe")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(CANVAS_CLI_ERRORS.noteNoAccess);
  });

  test("dado terminal ligado à nota, quando lê, então recebe ela e a cadeia, cada uma com cabeçalho", async () => {
    const r = await rig(baseDoc());
    await r.writeNote("briefing", "plano da sprint");
    await r.writeNote("contexto", "decisões antigas");
    expect(await r.run("note", "read", "briefing")).toBe(EXIT.ok);
    expect(r.out).toEqual(["=== briefing ===", "plano da sprint", "", "=== contexto (cadeia de briefing) ===", "decisões antigas"]);
    expect(await r.run("note", "read", "briefing", "--only")).toBe(EXIT.ok);
    expect(r.out).toEqual(["=== briefing ===", "plano da sprint"]);
  });

  test("a nota da cadeia também se lê direto, e a lista mostra diretas e encadeadas", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("note", "read", "contexto")).toBe(EXIT.ok);
    expect(r.out[0]).toBe("=== contexto ===");
    expect(await r.run("note", "list")).toBe(EXIT.ok);
    expect(r.out).toEqual(["briefing\tdireta", "contexto\tcadeia de briefing"]);
  });

  test("cadeia em laço não trava: cada nota sai uma vez", async () => {
    const doc = baseDoc();
    const r = await rig({ ...doc, edges: [...doc.edges, link("l-volta", "n-ctx", "n-brief")] });
    expect(await r.run("note", "read", "briefing")).toBe(EXIT.ok);
    expect(r.out.filter((line) => line.startsWith("==="))).toEqual(["=== briefing ===", "=== contexto (cadeia de briefing) ==="]);
  });

  test("terminal sem nenhuma conexão lista vazio", async () => {
    const r = await rig(baseDoc());
    r.io.caller = { session: "default", pane: "w9:p1" };
    expect(await r.run("note", "list")).toBe(EXIT.ok);
    expect(r.out).toEqual(["nenhuma nota ligada ao seu terminal"]);
  });

  test("escreve na nota ligada direto (texto do argumento, depois anexado pela entrada padrão)", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("note", "write", "briefing", "primeira", "linha")).toBe(EXIT.ok);
    expect(await r.noteText("briefing")).toBe("primeira linha");
    r.io.stdin = "segunda parte";
    expect(await r.run("note", "write", "briefing", "--append")).toBe(EXIT.ok);
    expect(await r.noteText("briefing")).toBe("primeira linha\n\nsegunda parte");
  });

  test("a nota da cadeia só se lê: escrever nela é recusado e o arquivo fica como estava", async () => {
    const r = await rig(baseDoc());
    await r.writeNote("contexto", "original");
    expect(await r.run("note", "write", "contexto", "sobrescrito")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(CANVAS_CLI_ERRORS.noteWriteDirect);
    expect(await r.noteText("contexto")).toBe("original");
  });
});

/** HADES_* só pelo ambiente do teste (a configuração real da máquina não entra); o que o teste pôs volta ao fim. */
async function withEnv(vars: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await body();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const startArgs = (r: Awaited<ReturnType<typeof rig>>): string[] => {
  const call = r.fake.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "start").at(-1);
  return call ? call.args.slice(call.args.indexOf("--") + 1) : [];
};
const SETTINGS = { HADES_MODEL_IMPL: "claude-sonnet-5-5", HADES_EFFORT_IMPL: "medium" };

describe("canvas-cli: modelo e esforço do recruta (Configurações)", () => {
  test("dado papel sem modelo e Configurações do papel, quando recruta, então o agente sobe com --model e --effort delas", async () => {
    await withEnv(SETTINGS, async () => {
      const r = await rig(baseDoc());
      await r.terminal("/api/argos/roles", { role: { name: "impl", color: "#a0b", instructions: "implemente" } });
      expect(await r.run("recruit", "--role", "impl")).toBe(EXIT.ok);
      const args = startArgs(r);
      expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "claude-sonnet-5-5"]);
      expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "medium"]);
      const node = (await r.current()).nodes.find((n2) => (n2.data as Dict).name === "Chefe 1") as CanvasNode;
      expect([(node.data as Dict).model, (node.data as Dict).effort]).toEqual(["claude-sonnet-5-5", "medium"]);
      const saved = JSON.parse(readFileSync(join(r.D, "argos", "terminals.json"), "utf8")) as { terminals: Dict[] };
      expect([saved.terminals[0]!.model, saved.terminals[0]!.effort]).toEqual(["claude-sonnet-5-5", "medium"]);
      expect(r.err).toEqual([]);
    });
  });

  test("dada flag e papel com modelo próprio, quando recruta, então a flag vence o papel e o papel vence as Configurações", async () => {
    await withEnv(SETTINGS, async () => {
      const r = await rig(baseDoc());
      await r.terminal("/api/argos/roles", { role: { name: "impl", color: "#a0b", instructions: "implemente", model: "claude-opus-5-5" } });
      expect(await r.run("recruit", "--role", "impl")).toBe(EXIT.ok);
      expect(startArgs(r)).toContain("claude-opus-5-5");
      expect(startArgs(r)).not.toContain("claude-sonnet-5-5");
      expect(startArgs(r)).toContain("medium"); // esforço: o papel não tem, valem as Configurações
      expect(await r.run("recruit", "--role", "impl", "--model", "claude-haiku-5-5", "--effort", "low")).toBe(EXIT.ok);
      const args = startArgs(r);
      expect(args).toContain("claude-haiku-5-5");
      expect(args).toContain("low");
      expect(args).not.toContain("medium");
    });
  });

  test("dado recruta sem papel e sem modelo, quando recruta, então avisa que herda o settings.json e o nó fica sem modelo", async () => {
    await withEnv(SETTINGS, async () => {
      const r = await rig(baseDoc());
      expect(await r.run("recruit", "--no-role")).toBe(EXIT.ok);
      expect(startArgs(r)).not.toContain("--model");
      expect(startArgs(r)).not.toContain("--effort");
      expect(r.err.join("\n")).toContain("herda o default do settings.json");
      const node = (await r.current()).nodes.find((n2) => (n2.data as Dict).name === "Chefe 1") as CanvasNode;
      expect((node.data as Dict).model).toBeUndefined();
    });
  });

  test("dado valor inválido nas Configurações, quando recruta, então o terminal sobe sem ele e avisa", async () => {
    await withEnv({ HADES_MODEL_IMPL: "modelo com espaço", HADES_EFFORT_IMPL: "enorme" }, async () => {
      const r = await rig(baseDoc());
      await r.terminal("/api/argos/roles", { role: { name: "impl", color: "#a0b", instructions: "implemente" } });
      expect(await r.run("recruit", "--role", "impl")).toBe(EXIT.ok);
      expect(startArgs(r)).not.toContain("--model");
      expect(r.err.join("\n")).toContain("herda o default do settings.json");
    });
  });
});

describe("canvas-cli: bloco PR pronta no prompt do recruta", () => {
  const promptOf = (r: Awaited<ReturnType<typeof rig>>): string => String(r.fake.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "prompt").at(-1)?.args[3]);

  test("dado papel que abre PR, quando recruta, então o primeiro prompt leva assignee, labels e reviewers antes da tarefa", async () => {
    await withEnv(SETTINGS, async () => {
      const r = await rig(baseDoc());
      await r.terminal("/api/argos/roles", { role: { name: "impl", color: "#a0b", instructions: "implemente" } });
      expect(await r.run("recruit", "--role", "impl", "--prompt", "faça X")).toBe(EXIT.ok);
      const prompt = promptOf(r);
      expect(prompt).toContain("assignee `dono-da-pr`, labels `fix,bug`, reviewers `revisora`");
      expect(prompt.indexOf("PR pronta")).toBeLessThan(prompt.indexOf("faça X"));
    });
  });

  test("dado papel que não abre PR ou sem papel, quando recruta, então o prompt não leva o bloco", async () => {
    await withEnv(SETTINGS, async () => {
      const r = await rig(baseDoc());
      await r.terminal("/api/argos/roles", { role: { name: "review", color: "#a0b", instructions: "revise" } });
      expect(await r.run("recruit", "--role", "review")).toBe(EXIT.ok);
      expect(promptOf(r)).not.toContain("PR pronta");
      expect(await r.run("recruit", "--no-role")).toBe(EXIT.ok);
      expect(promptOf(r)).not.toContain("PR pronta");
    });
  });

  test("as instruções de gerente mandam consolidar com `hades consolidate ready <N> --post`", () => {
    const text = readFileSync(join(import.meta.dir, "../../../kit/panel/argos/orchestrator-role.md"), "utf8");
    expect(text).toContain("hades consolidate ready <N> --post");
  });
});

describe("canvas-cli: orquestrador", () => {
  test("dois recrutas: cada um ganha pane, nó abaixo do orquestrador com espaçamento uniforme e a identidade no prompt", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("recruit", "--note", "briefing", "--prompt", "revise o módulo X")).toBe(EXIT.ok);
    expect(await r.run("recruit", "--name", "Testador")).toBe(EXIT.ok);
    const doc = await r.current();
    const orq = doc.nodes.find((node) => node.id === "term-orq") as CanvasNode;
    const team = doc.nodes.filter((node) => (node.data as Dict).recruiter === "term-orq");
    expect(team.map((node) => (node.data as Dict).name)).toEqual(["Chefe 1", "Testador"]);
    expect(team.map((node) => ({ x: node.x, y: node.y }))).toEqual(recruitSlots(orq, team.map((node) => ({ w: node.w, h: node.h }))));
    expect(team[1]!.x - team[0]!.x).toBe(team[0]!.w + 48);
    expect(team.every((node) => node.y > orq.y + orq.h)).toBe(true);
    // a aparência e o agente vêm do orquestrador; a caixa Orquestrador nunca
    expect(team.map((node) => [(node.data as Dict).color, (node.data as Dict).agent, (node.data as Dict).orchestrator])).toEqual([["#36c", "claude", undefined], ["#36c", "claude", undefined]]);
    expect(doc.edges.filter((edge) => edge.kind === RECRUIT_EDGE_KIND).map((edge) => [edge.from, edge.to])).toEqual(team.map((node) => ["term-orq", node.id]));
    // só o primeiro recebeu a nota
    expect(doc.edges.filter((edge) => edge.kind === LINK_EDGE_KIND && edge.to === "n-brief").map((edge) => edge.from)).toEqual(["term-orq", team[0]!.id]);
    const prompts = r.fake.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "prompt").map((c) => c.args);
    expect(prompts.map((args): unknown => args[2])).toEqual(team.map((node) => ((node.data as Dict).herdr as Dict).pane));
    expect(prompts[0]![3]).toContain("Você é Chefe 1, recruta do orquestrador Chefe");
    expect(prompts[0]![3]).toContain("Notas ligadas a você: briefing.");
    expect(prompts[0]![3]).toEndWith("revise o módulo X");
    expect(prompts[1]![3]).toContain("Nenhuma nota ligada a você");
  });

  test("o recruta não herda as instruções de gerente: a rota de criar não recebe orchestrator", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("recruit")).toBe(EXIT.ok);
    const start = r.fake.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start")?.args ?? [];
    expect(start.join(" ")).not.toContain(MANAGER);
  });

  test("recruta comum que tenta recrutar, reatribuir ou dispensar é recusado e nada muda", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("recruit")).toBe(EXIT.ok);
    const before = await r.current();
    const recruitNode = before.nodes.find((node) => (node.data as Dict).recruiter === "term-orq") as CanvasNode;
    r.io.caller = (recruitNode.data as Dict).herdr as typeof r.io.caller;
    for (const args of [["recruit"], ["dismiss", "Chefe 1"], ["reassign", "Chefe 1", "--no-role"], ["connect", "Chefe 1", "briefing"]]) {
      expect(await r.run(...args)).toBe(EXIT.fail);
      expect(lastCode(r.err)).toBe(RECRUIT_ERRORS.notOrchestrator);
    }
    expect((await r.current()).rev).toBe(before.rev);
  });

  test("orquestrador não comanda terminal que não recrutou", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("dismiss", "Comum")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(RECRUIT_ERRORS.notYourRecruit);
  });

  test("recruit com nota que não está ligada ao orquestrador é recusado antes de abrir pane", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("recruit", "--note", "solta")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(RECRUIT_ERRORS.noteNotShared);
    expect(r.fake.calls.filter((c) => c.args[0] === "workspace")).toEqual([]);
  });

  test("connect liga o recruta à nota do orquestrador; repetir não duplica", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("recruit")).toBe(EXIT.ok);
    expect(await r.run("connect", "Chefe 1", "briefing")).toBe(EXIT.ok);
    expect(r.out).toEqual(["Chefe 1 ligado a briefing"]);
    expect(await r.run("connect", "Chefe 1", "briefing")).toBe(EXIT.ok);
    expect(r.out).toEqual(["Chefe 1 já estava ligado a briefing"]);
    const links = (await r.current()).edges.filter((edge) => edge.kind === LINK_EDGE_KIND && edge.to === "n-brief");
    expect(links).toHaveLength(2);
    expect(await r.run("connect", "Chefe 1", "solta")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(RECRUIT_ERRORS.noteNotShared);
  });

  test("reassign reinicia só o processo: posição, nome e conexões ficam, e a identidade sai de novo", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("recruit", "--note", "briefing")).toBe(EXIT.ok);
    const before = (await r.current()).nodes.find((node) => (node.data as Dict).name === "Chefe 1") as CanvasNode;
    expect(await r.run("reassign", "Chefe 1", "--instructions", "foque em testes")).toBe(EXIT.ok);
    const after = await r.current();
    const node = after.nodes.find((n2) => n2.id === before.id) as CanvasNode;
    expect([node.x, node.y, (node.data as Dict).name]).toEqual([before.x, before.y, "Chefe 1"]);
    expect(after.edges.some((edge) => edge.from === node.id && edge.to === "n-brief")).toBe(true);
    const starts = r.fake.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "start");
    expect(starts).toHaveLength(2);
    expect(r.fake.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "prompt")).toHaveLength(2);
  });

  test("orquestrador de nome no limite da rota: o nome padrão do recruta encurta a base e cabe nela", async () => {
    const long = "Orquestrador do modulo de notas e cabos x";
    const doc = baseDoc();
    doc.nodes[0] = { ...doc.nodes[0]!, data: { ...(doc.nodes[0]!.data as Dict), name: long.slice(0, 40) } };
    const r = await rig(doc);
    expect(await r.run("recruit")).toBe(EXIT.ok);
    const made = (await r.current()).nodes.find((node) => (node.data as Dict).recruiter === "term-orq") as CanvasNode;
    const name = (made.data as Dict).name as string;
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.endsWith(" 1")).toBe(true);
  });

  test("reassign com o documento recusando a gravação não reinicia o processo", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("recruit")).toBe(EXIT.ok);
    expect((await r.terminal("/api/argos/roles", { role: { name: "Revisor", color: "#a0b", instructions: "revise" } })).status).toBe(200);
    const panel = r.deps.panel;
    r.deps.panel = async (method, path, body) =>
      (method === "PUT" && path.startsWith("/api/canvases") ? { status: 500, body: { error: "falha" } } : panel(method, path, body));
    expect(await r.run("reassign", "Chefe 1", "--role", "revisor")).toBe(EXIT.fail);
    expect(r.fake.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "start")).toHaveLength(1);
  });

  test("reassign com o reinício recusado devolve o papel de antes ao nó", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("recruit", "--no-role")).toBe(EXIT.ok);
    const before = (await r.current()).nodes.find((node) => (node.data as Dict).name === "Chefe 1") as CanvasNode;
    expect(await r.run("reassign", "Chefe 1", "--role", "papel-que-nao-existe")).toBe(EXIT.fail);
    const node = (await r.current()).nodes.find((n2) => n2.id === before.id) as CanvasNode;
    expect(node.data).toEqual(before.data);
  });

  test("dismiss fecha o pane pela rota de fechar e tira o nó; o outro recruta fica onde estava", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("recruit")).toBe(EXIT.ok);
    expect(await r.run("recruit")).toBe(EXIT.ok);
    const before = await r.current();
    const [first, second] = before.nodes.filter((node) => (node.data as Dict).recruiter === "term-orq") as [CanvasNode, CanvasNode];
    const pane = ((first.data as Dict).herdr as Dict).pane as string;
    expect(await r.run("dismiss", "Chefe 1")).toBe(EXIT.ok);
    expect(r.fake.panes.has(pane)).toBe(false);
    const after = await r.current();
    expect(after.nodes.some((node) => node.id === first.id)).toBe(false);
    expect(after.edges.some((edge) => edge.from === first.id || edge.to === first.id)).toBe(false);
    expect(after.nodes.find((node) => node.id === second.id)).toEqual(second);
  });

  test("notify manda o texto com o nome do terminal de quem chama", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("notify", "equipe", "pronta")).toBe(EXIT.ok);
    expect(r.notified).toEqual([["equipe pronta", "Chefe"]]);
    expect(await r.run("notify")).toBe(EXIT.usage);
  });
});

describe("canvas-cli: corpo do recrutamento", () => {
  const parsedOf = (flags: Record<string, string>) => ({ positional: [], flags: new Map(Object.entries(flags).map(([k, v]) => [k, [v]])) });
  const ORQ_DATA = { agent: "codex", model: "m1", effort: "high", role: "revisor", preset: "p1", orchestrator: true };

  test("sem escolha, copia agente, modelo, esforço, papel e predefinição do orquestrador, nunca a caixa", () => {
    expect(recruitBody(ORQ_DATA, parsedOf({}), "R 1")).toEqual({ name: "R 1", agent: "codex", model: "m1", effort: "high", role: "revisor", preset: "p1" });
  });

  test("com papel escolhido, não copia nada do orquestrador; --no-role tira o papel", () => {
    expect(recruitBody(ORQ_DATA, parsedOf({ role: "testador" }), "R 1")).toEqual({ name: "R 1", role: "testador" });
    expect(recruitBody(ORQ_DATA, parsedOf({ "no-role": "1" }), "R 1")).toEqual({ name: "R 1" });
  });
});

describe("canvas-cli: caixa Orquestrador na rota de terminais", () => {
  const systemPrompt = (r: Awaited<ReturnType<typeof rig>>): string | undefined => {
    const args = r.fake.calls.filter((c) => c.args[0] === "agent" && c.args[1] === "start").at(-1)?.args ?? [];
    expect(args.slice(args.indexOf("--") + 1).some((arg) => arg.includes("\n"))).toBe(false);
    const at = args.indexOf("--append-system-prompt-file");
    if (at < 0) return undefined;
    const file = args[at + 1] as string;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    return readFileSync(file, "utf8");
  };

  test("criar com a caixa: as instruções de gerente vão ao papel do processo, depois das próprias, e a resposta confirma", async () => {
    const r = await rig(baseDoc());
    const res = await r.terminal("/api/argos/terminals", { name: "chefe", orchestrator: true, instructions: "PROPRIAS" });
    expect([res.status, (res.body as Dict).orchestrator]).toEqual([200, true]);
    expect(systemPrompt(r)).toBe(`PROPRIAS\n\n${MANAGER}`);
  });

  test("criar sem a caixa não leva as instruções de gerente nem a confirmação", async () => {
    const r = await rig(baseDoc());
    const res = await r.terminal("/api/argos/terminals", { name: "comum" });
    expect([res.status, (res.body as Dict).orchestrator]).toEqual([200, undefined]);
    expect(systemPrompt(r)).toBeUndefined();
  });

  test("instruções de gerente ausentes na instalação: recusa sem abrir pane", async () => {
    const r = await rig(baseDoc(), () => {
      throw new Error("ENOENT");
    });
    const res = await r.terminal("/api/argos/terminals", { name: "chefe", orchestrator: true });
    expect(res.status).toBe(400);
    expect(r.fake.calls.filter((c) => c.args[0] === "workspace")).toEqual([]);
  });

  test("orchestrator que não é booleano é recusado", async () => {
    const r = await rig(baseDoc());
    expect((await r.terminal("/api/argos/terminals", { name: "chefe", orchestrator: "sim" })).status).toBe(400);
  });

  test("trocar o papel: desligar a caixa tira as instruções; sem o campo, o terminal mantém o que tinha", async () => {
    const r = await rig(baseDoc());
    const created = await r.terminal("/api/argos/terminals", { name: "chefe", orchestrator: true });
    const herdr = (created.body as Dict).herdr as Dict;
    const kept = await r.terminal("/api/argos/terminals/role", { ...herdr, name: "chefe", role: null });
    expect([kept.status, (kept.body as Dict).orchestrator, systemPrompt(r)]).toEqual([200, true, MANAGER]);
    const off = await r.terminal("/api/argos/terminals/role", { ...herdr, name: "chefe", role: null, orchestrator: false });
    expect([off.status, (off.body as Dict).orchestrator, systemPrompt(r)]).toEqual([200, undefined, undefined]);
    expect(existsSync(join(r.D, "argos/terminal-prompts", `default-${herdr.pane as string}`.replace(":", "-") + ".md"))).toBe(false);
  });
});

describe("canvas-cli: join e leave", () => {
  const FOREIGN = "w40:p1";
  /** Um pane do herdr que ninguém registrou: criado à mão, fora do canvas. */
  const handmade = (r: Awaited<ReturnType<typeof rig>>, pane = FOREIGN) => void r.fake.panes.add(pane);
  const terminalsAt = (doc: CanvasDoc, pane: string) => doc.nodes.filter((n) => terminalTargetOf(n)?.pane === pane);

  test("join do próprio pane cria um nó terminal vinculado ao pane, sem tocar no processo", async () => {
    const r = await rig(baseDoc());
    handmade(r);
    r.io.caller = { session: "default", pane: FOREIGN };
    expect(await r.run("join", "--name", "Solto", "--role", "revisor")).toBe(EXIT.ok);
    const [node] = terminalsAt(await r.current(), FOREIGN);
    expect(node?.data).toMatchObject({ name: "Solto", role: "revisor", herdr: { session: "default", pane: FOREIGN } });
    expect(r.fake.calls.filter((c) => c.args[0] === "pane" && c.args[1] !== "get")).toEqual([]);
  });

  test("join por --pane traz o pane de outro terminal", async () => {
    const r = await rig(baseDoc());
    handmade(r);
    expect(await r.run("join", "--pane", FOREIGN)).toBe(EXIT.ok);
    expect(terminalsAt(await r.current(), FOREIGN)).toHaveLength(1);
    expect(r.out.at(-1)).toContain(FOREIGN);
  });

  test("join repetido não duplica o nó nem mexe no documento", async () => {
    const r = await rig(baseDoc());
    handmade(r);
    await r.run("join", "--pane", FOREIGN);
    const first = await r.current();
    expect(await r.run("join", "--pane", FOREIGN)).toBe(EXIT.ok);
    const again = await r.current();
    expect([terminalsAt(again, FOREIGN).length, again.rev]).toEqual([1, first.rev]);
    expect(r.out.at(-1)).toContain("nada a mudar");
  });

  test("join repetido com --name e --to atualiza o nó que já existe", async () => {
    const r = await rig(baseDoc());
    handmade(r);
    await r.run("join", "--pane", FOREIGN);
    expect(await r.run("join", "--pane", FOREIGN, "--name", "Outro", "--to", "Chefe", "--note", "briefing")).toBe(EXIT.ok);
    const doc = await r.current();
    const [node] = terminalsAt(doc, FOREIGN);
    expect(terminalsAt(doc, FOREIGN)).toHaveLength(1);
    expect(node?.data).toMatchObject({ name: "Outro", recruiter: "term-orq" });
    expect(doc.edges.filter((e) => e.to === node?.id && e.kind === RECRUIT_EDGE_KIND)).toHaveLength(1);
    expect(doc.edges.some((e) => e.from === node?.id && e.to === "n-brief" && e.kind === LINK_EDGE_KIND)).toBe(true);
  });

  test("join de pane que o agent adopt já pôs no canvas funde num nó só", async () => {
    const doc = baseDoc();
    doc.nodes.push({ id: "agent:x", type: "agent", x: 0, y: 0, w: 100, h: 100, z: 1, data: {}, locked: false, blurred: false });
    doc.edges.push({ id: "e-agent", from: "term-orq", to: "agent:x", kind: "orchestrates" });
    const r = await rig(doc);
    handmade(r);
    const graph = r.deps.panel;
    r.deps.panel = async (method, path, body) =>
      method === "GET" && path === "/api/argos/graph" ? { status: 200, body: { nodes: [{ id: "agent:x", herdr: { session: "default", pane: FOREIGN } }] } } : graph(method, path, body);
    expect(await r.run("join", "--pane", FOREIGN)).toBe(EXIT.ok);
    const after = await r.current();
    expect(after.nodes.some((n) => n.id === "agent:x")).toBe(false);
    expect(after.edges.some((e) => e.id === "e-agent")).toBe(false);
    expect(terminalsAt(after, FOREIGN)).toHaveLength(1);
  });

  test("join fora do herdr é recusado com a instrução de abrir dentro dele, sem tocar no painel", async () => {
    const r = await rig(baseDoc());
    r.io.caller = undefined as unknown as typeof r.io.caller;
    expect(await r.run("join")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(CANVAS_CLI_ERRORS.joinOutsideHerdr);
    expect(r.err.at(-1)).toContain("dentro do herdr");
    expect(r.panelCalls).toEqual([]);
  });

  test("join de pane que o herdr não conhece é recusado", async () => {
    const r = await rig(baseDoc());
    expect(await r.run("join", "--pane", "w77:p9")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(CANVAS_CLI_ERRORS.joinPaneNotFound);
    expect((await r.current()).nodes).toHaveLength(baseDoc().nodes.length);
  });

  test("--pane com formato inválido e --to que não é orquestrador são recusados", async () => {
    const r = await rig(baseDoc());
    handmade(r);
    expect(await r.run("join", "--pane", "a b")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(CANVAS_CLI_ERRORS.joinBadPane);
    expect(await r.run("join", "--pane", FOREIGN, "--to", "Comum")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(RECRUIT_ERRORS.notOrchestratorTarget);
    expect(terminalsAt(await r.current(), FOREIGN)).toEqual([]);
  });

  test("com --to o terminal entra como recruta abaixo do orquestrador, e --note liga a nota", async () => {
    const r = await rig(baseDoc());
    handmade(r);
    expect(await r.run("join", "--pane", FOREIGN, "--to", "term-orq", "--note", "briefing")).toBe(EXIT.ok);
    const doc = await r.current();
    const orq = doc.nodes.find((n) => n.id === "term-orq") as CanvasNode;
    const [node] = terminalsAt(doc, FOREIGN) as [CanvasNode];
    expect(node.data).toMatchObject({ recruiter: "term-orq" });
    expect(node.y).toBeGreaterThan(orq.y + orq.h);
    expect(doc.edges.some((e) => e.from === "term-orq" && e.to === node.id && e.kind === RECRUIT_EDGE_KIND)).toBe(true);
    expect(doc.edges.some((e) => e.from === node.id && e.to === "n-brief")).toBe(true);
  });

  test("leave tira o nó e as arestas, o processo segue, e join volta a trazê-lo", async () => {
    const r = await rig(baseDoc());
    handmade(r);
    await r.run("join", "--pane", FOREIGN, "--to", "term-orq");
    const before = await r.current();
    expect(await r.run("leave", "--pane", FOREIGN)).toBe(EXIT.ok);
    const left = await r.current();
    expect(terminalsAt(left, FOREIGN)).toEqual([]);
    expect(left.edges.filter((e) => e.kind === RECRUIT_EDGE_KIND)).toEqual([]);
    expect(r.fake.panes.has(FOREIGN)).toBe(true);
    expect(r.fake.calls.some((c) => c.args[0] === "pane" && c.args[1] === "close")).toBe(false);
    expect(await r.run("join", "--pane", FOREIGN)).toBe(EXIT.ok);
    expect(terminalsAt(await r.current(), FOREIGN)).toHaveLength(1);
    expect(before.nodes.length).toBe((await r.current()).nodes.length);
  });

  test("leave de pane que não é nó de canvas nenhum é recusado", async () => {
    const r = await rig(baseDoc());
    handmade(r);
    expect(await r.run("leave", "--pane", FOREIGN)).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(RECRUIT_ERRORS.notInCanvas);
  });

  test("join de orquestrador do registro volta como orquestrador e o recruit funciona depois", async () => {
    const r = await rig(baseDoc());
    const created = await r.terminal("/api/argos/terminals", { name: "Gerente", orchestrator: true });
    const herdr = (created.body as Dict).herdr as { session: string; pane: string };
    r.io.caller = herdr;
    expect(await r.run("recruit")).toBe(EXIT.fail);
    expect(lastCode(r.err)).toBe(RECRUIT_ERRORS.notInCanvas);
    expect(await r.run("join")).toBe(EXIT.ok);
    const [node] = terminalsAt(await r.current(), herdr.pane) as [CanvasNode];
    expect(node.data).toMatchObject({ name: "Gerente", orchestrator: true, agent: "claude" });
    expect(await r.run("recruit", "--name", "Ajudante")).toBe(EXIT.ok);
    const doc = await r.current();
    expect(doc.nodes.find((n) => (n.data as Dict).name === "Ajudante")?.data).toMatchObject({ recruiter: node.id });
  });

  test("join de terminal comum do registro herda nome e agente, sem virar orquestrador", async () => {
    const r = await rig(baseDoc());
    const created = await r.terminal("/api/argos/terminals", { name: "Comum 2" });
    const herdr = (created.body as Dict).herdr as { session: string; pane: string };
    expect(await r.run("join", "--pane", herdr.pane)).toBe(EXIT.ok);
    const [node] = terminalsAt(await r.current(), herdr.pane) as [CanvasNode];
    expect(node.data).toMatchObject({ name: "Comum 2" });
    expect((node.data as Dict).orchestrator).toBeUndefined();
  });
});
