// Grupo painel-claude: modo terminal da página Claude (tipo `claude` com pasta e `resume`) e o bloqueio de ferramenta no chat.
// Nunca o claude real: HADES_CHAT_BIN aponta para um script que grava o argv e fica vivo, e outro que imprime stream-json gravado.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatEvents } from "../../../src/panel/chat-events.ts";
import { startPanel, type Panel } from "../../../src/panel/server.ts";
import { TERM_CODES } from "../../../src/panel/term-protocol.ts";

const SKILL = join(import.meta.dir, "../../..");
const T = realpathSync(mkdtempSync(join(tmpdir(), "hades-claude-term-")));
const ARGV = join(T, "argv.txt");
const SESSION = "11111111-2222-3333-4444-555555555555";
let panel: Panel;
let base = "";
let wt = "";
let FAKE_TTY = "";
let FAKE_STREAM = "";

beforeAll(async () => {
  wt = join(T, "proj");
  const D = join(T, "proj-data");
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(D, "panel"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q", wt]);
  copyFileSync(join(SKILL, "kit/config.tsv"), join(D, "config.tsv"));
  writeFileSync(join(D, "env.sh"), `W="${wt}"\n`);
  FAKE_TTY = join(T, "claude-tty");
  writeFileSync(FAKE_TTY, `#!/bin/bash\nprintf '%s\\n' "$PWD" "$@" > ${ARGV}\nexec sleep 30\n`);
  // o que o `claude -p` imprime quando o auto mode barra uma ferramenta (stream-json gravado)
  FAKE_STREAM = join(T, "claude-stream");
  const lines = [
    { type: "system", subtype: "init", session_id: SESSION, model: "claude-opus-5-5" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "rm -rf build" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "Permission to use Bash has been denied by the auto mode classifier" }] } },
    { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, permission_denials: [{ tool_name: "Bash", tool_input: { command: "rm -rf build" } }] },
  ];
  writeFileSync(FAKE_STREAM, `#!/bin/bash\ncat <<'EOF'\n${lines.map((l) => JSON.stringify(l)).join("\n")}\nEOF\n`);
  for (const f of [FAKE_TTY, FAKE_STREAM]) chmodSync(f, 0o755);
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  void probe.stop(true);
  panel = await startPanel(D, port);
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => {
  panel.stop();
  rmSync(T, { recursive: true, force: true });
});

const headers = (): Record<string, string> => ({ "x-panel-token": panel.token, "content-type": "application/json", origin: base });
const post = (path: string, body: unknown): Promise<Response> => fetch(`${base}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
const config = async (values: Record<string, string>): Promise<void> => {
  expect((await post("/api/config", { values })).status).toBe(200);
};
const waitFor = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(25);
};

describe("modo terminal da página Claude", () => {
  test("dado a chave desligada (padrão), então a lista diz enabled:false e abrir recusa term_disabled com a dica de como ligar", async () => {
    const list = (await (await fetch(`${base}/api/term`)).json()) as { enabled: boolean };
    expect(list.enabled).toBe(false);
    const r = await post("/api/term/open", { kind: "claude" });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { code: string; error: string };
    expect(body.code).toBe(TERM_CODES.disabled);
    expect(body.error).toContain("HADES_TERMINAL=1");
  });

  test("dado a chave ligada, quando abre sessão nova na pasta escolhida entre as roots, então roda o claude com auto mode e sem --resume", async () => {
    await config({ HADES_TERMINAL: "1", HADES_CHAT_BIN: FAKE_TTY });
    const list = (await (await fetch(`${base}/api/term`)).json()) as { enabled: boolean; roots: string[] };
    expect(list.enabled).toBe(true);
    expect(list.roots[0]).toBe(wt);
    const r = await post("/api/term/open", { kind: "claude", cwd: wt });
    expect(r.status).toBe(200);
    const s = (await r.json()) as { id: string; kind: string; cwd: string };
    expect(s).toMatchObject({ kind: "claude", cwd: wt });
    await waitFor(() => existsSync(ARGV));
    const argv = readFileSync(ARGV, "utf8").trim().split("\n");
    expect(argv).toEqual([wt, "--permission-mode", "auto"]);
    await post("/api/term/close", { id: s.id });
  });

  test("dado o id da sessão do chat, quando retoma no terminal, então o argv leva --resume <id>", async () => {
    rmSync(ARGV, { force: true });
    const r = await post("/api/term/open", { kind: "claude", resume: SESSION });
    expect(r.status).toBe(200);
    const s = (await r.json()) as { id: string };
    await waitFor(() => existsSync(ARGV));
    expect(readFileSync(ARGV, "utf8").trim().split("\n").slice(1)).toEqual(["--permission-mode", "auto", "--resume", SESSION]);
    await post("/api/term/close", { id: s.id });
  });

  test("dado resume com lixo, pasta fora das roots e pasta relativa, então recusa por código", async () => {
    const codeOf = async (body: Record<string, unknown>): Promise<string> => ((await (await post("/api/term/open", body)).json()) as { code: string }).code;
    expect(await codeOf({ kind: "claude", resume: "a b; rm -rf /" })).toBe(TERM_CODES.badRequest);
    expect(await codeOf({ kind: "claude", resume: "x".repeat(65) })).toBe(TERM_CODES.badRequest);
    expect(await codeOf({ kind: "claude", cwd: "/etc" })).toBe(TERM_CODES.forbiddenCwd);
    expect(await codeOf({ kind: "claude", cwd: `${wt}/../..` })).toBe(TERM_CODES.forbiddenCwd);
    expect(await codeOf({ kind: "claude", cwd: "relativa" })).toBe(TERM_CODES.badRequest);
  });

  test("dado binário do claude ausente, então 422 term_kind_unavailable", async () => {
    await config({ HADES_CHAT_BIN: join(T, "nao-existe") });
    const r = await post("/api/term/open", { kind: "claude" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { code: string }).code).toBe(TERM_CODES.kindUnavailable);
  });
});

describe("bloqueio de ferramenta no chat", () => {
  test("dado o stream-json gravado de um claude falso, então a recusa chega como denials do resultado e o id da sessão para retomar", async () => {
    const out = await new Response(Bun.spawn([FAKE_STREAM], { stdout: "pipe" }).stdout).text();
    const events = out.split("\n").filter(Boolean).flatMap((l) => chatEvents(l, false));
    expect(events.find((e) => e.t === "init")).toMatchObject({ session: SESSION });
    expect(events.find((e) => e.t === "tool_result")).toMatchObject({ error: true, denied: true });
    expect(events.find((e) => e.t === "result")).toMatchObject({ ok: true, denials: [{ tool: "Bash", input: "rm -rf build" }] });
  });

  test("dado a sessão registrada com o id do Claude Code, então o overview o expõe para o botão de aprovar no terminal", async () => {
    mkdirSync(join(T, "proj-data", "claude"), { recursive: true });
    writeFileSync(join(T, "proj-data", "claude", "sessions.json"), JSON.stringify({ aaaaaaaa: { id: "aaaaaaaa", title: "t", claudeSession: SESSION } }));
    const ov = (await (await fetch(`${base}/api/claude`)).json()) as { sessions: { id: string; claudeSession: string | null }[] };
    expect(ov.sessions.find((s) => s.id === "aaaaaaaa")?.claudeSession).toBe(SESSION);
  });
});
