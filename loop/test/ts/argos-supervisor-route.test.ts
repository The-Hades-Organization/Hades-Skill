// Grupo argos-supervisor-route: rotas do supervisor do canvas (src/panel/argos-supervisor.ts) — cartão local pelo peek,
// consulta e resumo das notas pelo claude -p (falso aqui), a chave que desliga, a confirmação e o aviso pelo acesso remoto,
// a taxa e o teto de simultâneos, e a prova de que nenhuma rota escreve em pane nem manda texto, tecla ou comando a agente.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CanvasDoc, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import {
  CONFIG_KEY, type ClaudeRun, SUPERVISOR_ERRORS, SUPERVISOR_ROUTE_LIMITS, type SupervisorDeps, createSupervisorRoutes,
} from "../../../src/panel/argos-supervisor";

type Dict = Record<string, unknown>;

const T = mkdtempSync(join(tmpdir(), "hades-supervisor-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));
// binário existente e executável: a rota confere que o claude existe antes de chamar o `runClaude` (falso)
const BIN = join(T, "claude-falso");
writeFileSync(BIN, "#!/bin/sh\nexit 0\n");
chmodSync(BIN, 0o755);

const SESSION = "proj";
const PANE = "w1:p2";
const PANE_TEXT = "⏺ Bash(bun test)\n  ⎿  12 pass\n⏺ Pronto: testes verdes.\n  ? for shortcuts\n";
const AGENT = "agent:o__r:revisor";
const node = (id: string, type: string, data: Dict = {}): Dict => ({ id, type, x: 0, y: 0, w: 100, h: 60, z: 0, data, locked: false, blurred: false });
const DOC: CanvasDoc = validateCanvasDoc({
  v: 1, rev: 0, groups: [],
  nodes: [node(AGENT, "agent"), node("n1", "note", { note: "roteiro" }), node("n2", "note", { note: "solta" })],
  edges: [{ id: "e1", from: AGENT, to: "n1", kind: "link" }],
});
const NOTES: Record<string, { text: string; title: string }> = { roteiro: { title: "Roteiro", text: "fazer A, depois B" }, solta: { title: "Solta", text: "não vai" } };

const local = { remote: false };
const remote = { remote: true };
const json = async (res: Response): Promise<Dict> => (await res.json()) as Dict;

interface Calls {
  reads: { session: string; pane: string; lines: number }[];
  claude: { argv: string[]; input: string; cwd: string }[];
  notices: { what: string; target: string }[];
  logs: { event: string; fields: Dict }[];
}

function fresh(over: Partial<SupervisorDeps> & { cfg?: Record<string, string>; reply?: ClaudeRun | (() => Promise<ClaudeRun>) } = {}) {
  const calls: Calls = { reads: [], claude: [], notices: [], logs: [] };
  let clock = 1_000_000;
  const cfg = { HADES_CHAT_BIN: BIN, ...over.cfg };
  const reply = over.reply ?? { status: 0, out: "Ele rodou os testes e terminou.\n" };
  const routes = createSupervisorRoutes({
    dir: T,
    config: () => cfg,
    readPane: async (session, pane, lines) => { calls.reads.push({ session, pane, lines }); return PANE_TEXT; },
    loadDoc: async (id) => (id === "default" ? DOC : undefined),
    readNote: async (name) => NOTES[name],
    notify: async (what, target) => { calls.notices.push({ what, target }); },
    log: (_level, event, fields = {}) => { calls.logs.push({ event, fields }); },
    runClaude: async (argv, input, options) => {
      calls.claude.push({ argv, input, cwd: options.cwd });
      return typeof reply === "function" ? reply() : reply;
    },
    now: () => clock,
    ...over,
  });
  return { routes, calls, tick: (ms: number) => { clock += ms; } };
}

const peek = (routes: ReturnType<typeof fresh>["routes"], query: Record<string, string>) =>
  routes.get("/api/argos/supervisor/peek", query, local) as Promise<Response>;
const ask = (routes: ReturnType<typeof fresh>["routes"], body: Dict, caller = local) =>
  routes.post("/api/argos/supervisor/ask", body, caller) as Promise<Response>;
const notes = (routes: ReturnType<typeof fresh>["routes"], body: Dict, caller = local) =>
  routes.post("/api/argos/supervisor/notes", body, caller) as Promise<Response>;
const ASK = { session: SESSION, pane: PANE, name: "revisor", question: "o que ele está fazendo?" };

describe("argos-supervisor-route: estado e cartão local", () => {
  test("dada a chave ausente, quando GET da base, então claude ligado (padrão)", async () => {
    const { routes } = fresh();
    expect(await json(await (routes.get("/api/argos/supervisor", {}, local) as Promise<Response>))).toEqual({ claude: true });
  });

  test("dada a chave em 0, quando GET da base, então claude desligado", async () => {
    const { routes } = fresh({ cfg: { [CONFIG_KEY]: "0" } });
    expect(await json(await (routes.get("/api/argos/supervisor", {}, local) as Promise<Response>))).toEqual({ claude: false });
  });

  test("dado caminho fora das rotas, então não responde (o servidor segue adiante)", () => {
    const { routes } = fresh();
    expect(routes.get("/api/argos/outra", {}, local)).toBeUndefined();
    expect(routes.post("/api/argos/supervisor/peek", {}, local)).toBeUndefined();
  });

  test("dado pane válido, quando peek, então lê o teto de linhas e devolve o cartão local sem chamar o claude", async () => {
    const { routes, calls } = fresh();
    const res = await peek(routes, { session: SESSION, pane: PANE, status: "done" });
    expect(res.status).toBe(200);
    const card = (await json(res)).card as Dict;
    expect(card.kind).toBe("done");
    expect(card.source).toBe("local");
    expect(card.summary).toBe("Terminou: Pronto: testes verdes.");
    expect(calls.reads).toEqual([{ session: SESSION, pane: PANE, lines: 120 }]);
    expect(calls.claude).toHaveLength(0);
  });

  test("dado status desconhecido e pane que saiu, quando peek, então status vira unknown e o cartão é de fim", async () => {
    const { routes } = fresh();
    const card = (await json(await peek(routes, { session: SESSION, pane: PANE, status: "xyz", exited: "1" }))).card as Dict;
    expect(card.status).toBe("unknown");
    expect(card.kind).toBe("done");
  });

  test.each([
    ["sessão com barra", { session: "../x", pane: PANE }],
    ["pane sem :p", { session: SESSION, pane: "w1" }],
    ["sem nada", {}],
  ])("dado %s, quando peek, então 400 invalid sem ler o pane", async (_name, query) => {
    const { routes, calls } = fresh();
    const res = await peek(routes, query as Record<string, string>);
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe(SUPERVISOR_ERRORS.invalid);
    expect(calls.reads).toHaveLength(0);
  });

  test("dado herdr que falha, quando peek, então 502 herdr-failed e o log não leva texto do pane", async () => {
    const { routes, calls } = fresh({ readPane: async () => { throw new Error("pane sumiu"); } });
    const res = await peek(routes, { session: SESSION, pane: PANE, status: "idle" });
    expect(res.status).toBe(502);
    expect((await json(res)).code).toBe(SUPERVISOR_ERRORS.herdrFailed);
    expect(calls.logs[0]?.fields).toEqual({ pane: PANE, reason: "pane sumiu" });
  });
});

describe("argos-supervisor-route: consulta e resumo pelo claude -p", () => {
  test("dada consulta local, então claude -p sem ferramentas, prompt pelo stdin, cwd próprio e selo claude", async () => {
    const { routes, calls } = fresh();
    const res = await ask(routes, ASK);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ answer: "Ele rodou os testes e terminou.", source: "claude" });
    expect((body.sent as Dict).lines).toBe(3);
    const [call] = calls.claude;
    expect(call?.argv.slice(0, 6)).toEqual([BIN, "-p", "--output-format", "text", "--tools", ""]);
    expect(call?.argv).toContain("--no-session-persistence");
    expect(call?.argv).toContain("--strict-mcp-config");
    expect(call?.argv.join(" ")).not.toContain("o que ele está fazendo");
    expect(call?.input).toContain("Pergunta: o que ele está fazendo?");
    expect(call?.input).toContain("⏺ Pronto: testes verdes.");
    expect(call?.input).not.toContain("for shortcuts");
    expect(call?.cwd).toBe(join(T, "supervisor"));
  });

  test("dada consulta, então o log tem ação, alvo e contagens, e nunca a pergunta, as linhas ou a resposta", async () => {
    const { routes, calls } = fresh();
    await ask(routes, ASK);
    const logged = JSON.stringify(calls.logs);
    expect(calls.logs.at(-1)?.fields).toMatchObject({ acao: "consulta", alvo: "revisor", rc: 0, linhas: 3, remoto: false });
    for (const secret of ["o que ele está fazendo", "testes verdes", "Ele rodou"]) expect(logged).not.toContain(secret);
  });

  test("dado HADES_MODEL_CHAT, então o modelo da página Claude vai ao argv", async () => {
    const { routes, calls } = fresh({ cfg: { HADES_MODEL_CHAT: "claude-sonnet-5-5" } });
    await ask(routes, ASK);
    const argv = calls.claude[0]?.argv ?? [];
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
  });

  test.each([
    ["sem nome", { ...ASK, name: "" }],
    ["sem pergunta", { ...ASK, question: "   " }],
    ["nome longo", { ...ASK, name: "x".repeat(81) }],
    ["pane inválido", { ...ASK, pane: "nada" }],
  ])("dada consulta %s, então 400 invalid sem chamar o claude", async (_name, body) => {
    const { routes, calls } = fresh();
    const res = await ask(routes, body);
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe(SUPERVISOR_ERRORS.invalid);
    expect(calls.claude).toHaveLength(0);
  });

  test("dada a chave em 0, então consulta e resumo 403 supervisor-claude-off, sem ler pane nem nota", async () => {
    const { routes, calls } = fresh({ cfg: { [CONFIG_KEY]: "0" } });
    for (const res of [await ask(routes, ASK), await notes(routes, { canvas: "default" })]) {
      expect(res.status).toBe(403);
      expect((await json(res)).code).toBe(SUPERVISOR_ERRORS.off);
    }
    expect(calls.reads).toHaveLength(0);
    expect(calls.claude).toHaveLength(0);
  });

  test("dado claude ausente, então 400 claude-missing", async () => {
    const { routes, calls } = fresh({ cfg: { HADES_CHAT_BIN: join(T, "nao-existe") } });
    const res = await ask(routes, ASK);
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe(SUPERVISOR_ERRORS.noClaude);
    expect(calls.claude).toHaveLength(0);
  });

  test("dado claude com rc≠0 ou saída vazia, então 502 claude-failed", async () => {
    for (const reply of [{ status: 1, out: "algo" }, { status: 0, out: "  \n" }]) {
      const { routes } = fresh({ reply });
      const res = await ask(routes, ASK);
      expect(res.status).toBe(502);
      expect((await json(res)).code).toBe(SUPERVISOR_ERRORS.claudeFailed);
    }
  });

  test("dado claude que lança, então 502 claude-failed e o painel segue respondendo", async () => {
    const { routes } = fresh({ reply: async () => { throw new Error("spawn falhou"); } });
    expect((await ask(routes, ASK)).status).toBe(502);
    expect((await ask(routes, ASK)).status).toBe(502);
  });

  test("dado canvas com uma nota ligada e uma solta, quando resume, então só a ligada vai ao claude", async () => {
    const { routes, calls } = fresh({ reply: { status: 0, out: "Visão geral: A antes de B." } });
    const res = await notes(routes, { canvas: "default" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ summary: "Visão geral: A antes de B.", sent: { notes: 1, chars: "fazer A, depois B".length }, source: "claude" });
    expect(calls.claude[0]?.input).toContain("## Roteiro\nfazer A, depois B");
    expect(calls.claude[0]?.input).not.toContain("não vai");
  });

  test("dado canvas inválido, inexistente ou sem nota ligada com texto, então 400/404 sem chamar o claude", async () => {
    const empty = validateCanvasDoc({ v: 1, rev: 0, groups: [], nodes: [node("n2", "note", { note: "solta" })], edges: [] });
    const { routes, calls } = fresh({ loadDoc: async (id) => (id === "vazio" ? empty : undefined) });
    expect((await notes(routes, { canvas: "../x" })).status).toBe(400);
    expect((await notes(routes, { canvas: "nenhum" })).status).toBe(404);
    const res = await notes(routes, { canvas: "vazio" });
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe(SUPERVISOR_ERRORS.notFound);
    expect(calls.claude).toHaveLength(0);
  });
});

describe("argos-supervisor-route: acesso remoto (D1), taxa e simultâneos", () => {
  test("dada consulta remota sem confirmação, então 403 com a frase, antes de ler o pane e sem aviso", async () => {
    const { routes, calls } = fresh();
    const res = await ask(routes, ASK, remote);
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: SUPERVISOR_ERRORS.confirmRequired, phrase: "revisor" });
    expect(calls.reads).toHaveLength(0);
    expect(calls.notices).toHaveLength(0);
  });

  test("dada confirmação errada, então ainda 403", async () => {
    const { routes } = fresh();
    expect((await ask(routes, { ...ASK, confirm: "Revisor" }, remote)).status).toBe(403);
  });

  test("dada consulta remota confirmada, então responde e avisa o dono 1× por alvo na janela", async () => {
    const { routes, calls, tick } = fresh();
    expect((await ask(routes, { ...ASK, confirm: "revisor" }, remote)).status).toBe(200);
    expect((await ask(routes, { ...ASK, confirm: "revisor" }, remote)).status).toBe(200);
    expect(calls.notices).toEqual([{ what: "consulta", target: "revisor" }]);
    tick(SUPERVISOR_ROUTE_LIMITS.remoteNoticeGapMs);
    await ask(routes, { ...ASK, confirm: "revisor" }, remote);
    expect(calls.notices).toHaveLength(2);
  });

  test("dado resumo remoto, então a frase é 'notas'; confirmado, avisa o dono", async () => {
    const { routes, calls } = fresh();
    const refused = await notes(routes, { canvas: "default" }, remote);
    expect(await json(refused)).toMatchObject({ code: SUPERVISOR_ERRORS.confirmRequired, phrase: SUPERVISOR_ROUTE_LIMITS.notesPhrase });
    expect((await notes(routes, { canvas: "default", confirm: "notas" }, remote)).status).toBe(200);
    expect(calls.notices).toEqual([{ what: "resumo das notas", target: "default" }]);
  });

  test("dado aviso remoto que falha, então a consulta responde e o log registra o aviso", async () => {
    const { routes, calls } = fresh({ notify: async () => { throw new Error("notify.sh ausente"); } });
    expect((await ask(routes, { ...ASK, confirm: "revisor" }, remote)).status).toBe(200);
    await Promise.resolve();
    expect(calls.logs.some((l) => l.event === "supervisor: aviso remoto falhou")).toBe(true);
  });

  test("dadas consultas além da taxa, então 429 rate-limited com Retry-After; local e remoto contam à parte", async () => {
    const { routes, tick } = fresh();
    for (let i = 0; i < SUPERVISOR_ROUTE_LIMITS.claudePerWindow; i++) expect((await ask(routes, ASK)).status).toBe(200);
    const over = await ask(routes, ASK);
    expect(over.status).toBe(429);
    expect((await json(over)).code).toBe(SUPERVISOR_ERRORS.rateLimited);
    expect(Number(over.headers.get("retry-after"))).toBe(SUPERVISOR_ROUTE_LIMITS.windowMs / 1000);
    expect((await ask(routes, { ...ASK, confirm: "revisor" }, remote)).status).toBe(200);
    tick(SUPERVISOR_ROUTE_LIMITS.windowMs);
    expect((await ask(routes, ASK)).status).toBe(200);
  });

  test("dadas consultas ao mesmo tempo além do teto, então a de fora recebe 429 busy", async () => {
    const releases: (() => void)[] = [];
    // as primeiras ficam presas até a liberação; as seguintes respondem na hora
    const reply = (): Promise<ClaudeRun> => releases.length < SUPERVISOR_ROUTE_LIMITS.concurrent
      ? new Promise<ClaudeRun>((resolve) => releases.push(() => resolve({ status: 0, out: "ok" })))
      : Promise.resolve({ status: 0, out: "ok" });
    const { routes } = fresh({ reply });
    const running = Array.from({ length: SUPERVISOR_ROUTE_LIMITS.concurrent }, () => ask(routes, ASK));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const extra = await ask(routes, ASK);
    expect(extra.status).toBe(429);
    expect((await json(extra)).code).toBe(SUPERVISOR_ERRORS.busy);
    releases.forEach((release) => release());
    for (const res of await Promise.all(running)) expect(res.status).toBe(200);
    expect((await ask(routes, ASK)).status).toBe(200);
  });

  test("dadas consultas disparadas juntas com a leitura do pane ainda pendente, então a vaga já conta e a de fora é busy", async () => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const { routes, calls } = fresh({ readPane: async () => { await gate; return PANE_TEXT; } });
    const all = Array.from({ length: SUPERVISOR_ROUTE_LIMITS.concurrent + 1 }, () => ask(routes, ASK));
    const extra = await all[SUPERVISOR_ROUTE_LIMITS.concurrent];
    expect(extra?.status).toBe(429);
    open();
    for (const res of await Promise.all(all.slice(0, -1))) expect(res.status).toBe(200);
    expect(calls.claude).toHaveLength(SUPERVISOR_ROUTE_LIMITS.concurrent);
  });
});

describe("argos-supervisor-route: só lê, resume e anota", () => {
  const ROOT = join(import.meta.dir, "../../..");
  const SOURCES = ["src/panel/argos-supervisor.ts", "src/lib/canvas-supervisor.ts", "kit/panel/ui/argos/supervisor.tsx"];
  // os caminhos pelos quais o painel manda texto ou tecla a um pane (rota de entrada do herdr, chamada da CLI, tmux)
  const WRITES = [/\/api\/herdr\/input/, /send_input/, /send-keys/, /\.input\(/, /\bsendKeys\b/, /\bwritePane\b/, /herdr["',\s]+(?:pane\s+)?(?:send|input|write)/];

  test.each(SOURCES)("dado o fonte %s, então nenhum caminho de escrita em pane aparece", (rel) => {
    const source = readFileSync(join(ROOT, rel), "utf8");
    for (const pattern of WRITES) expect({ rel, pattern: String(pattern), found: pattern.test(source) }).toEqual({ rel, pattern: String(pattern), found: false });
  });

  test("dadas todas as rotas exercidas, então as dependências só leram (pane, canvas, nota) e nada foi escrito", async () => {
    const touched: string[] = [];
    // um proxy nas dependências: qualquer função além das de leitura, aviso, log e claude falharia aqui
    const allowed = new Set(["dir", "config", "readPane", "loadDoc", "readNote", "notify", "log", "runClaude", "now"]);
    const deps = new Proxy({} as SupervisorDeps, {
      get(_t, key: string) {
        touched.push(key);
        if (!allowed.has(key)) throw new Error(`dependência inesperada: ${key}`);
        const real: Partial<SupervisorDeps> = {
          dir: T, config: () => ({ HADES_CHAT_BIN: BIN }), readPane: async () => PANE_TEXT, loadDoc: async () => DOC,
          readNote: async (name) => NOTES[name], notify: async () => undefined, log: () => undefined,
          runClaude: async () => ({ status: 0, out: "ok" }), now: () => 0,
        };
        return real[key as keyof SupervisorDeps];
      },
    });
    const routes = createSupervisorRoutes(deps);
    await (routes.get("/api/argos/supervisor", {}, local) as Promise<Response>);
    await (routes.get("/api/argos/supervisor/peek", { session: SESSION, pane: PANE, status: "idle" }, local) as Promise<Response>);
    expect((await (routes.post("/api/argos/supervisor/ask", ASK, local) as Promise<Response>)).status).toBe(200);
    expect((await (routes.post("/api/argos/supervisor/notes", { canvas: "default" }, local) as Promise<Response>)).status).toBe(200);
    expect((await (routes.post("/api/argos/supervisor/ask", { ...ASK, confirm: "revisor" }, remote) as Promise<Response>)).status).toBe(200);
    expect(new Set(touched)).toEqual(new Set(["now", "runClaude", "config", "readPane", "dir", "log", "loadDoc", "readNote", "notify"]));
  });
});
