// Grupo mark-proxy: o proxy do painel para a ponte do Mark-LVI (src/panel/mark.ts) contra um Mark falso em loopback que segue o
// contrato (bridge.json, Bearer, /api/state, /api/command, /api/wake, /ws). Cobre estado, comando, wake, eventos, fora do ar
// (arquivo ausente, pid morto, porta fechada), teto do texto, relatório e o token que nunca sai nas respostas.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARK_ERRORS } from "../../../src/lib/mark-bridge";
import { createMark, MARK_LIMITS, type Mark } from "../../../src/panel/mark";

type Dict = Record<string, unknown>;

const TOKEN = "tok-de-exemplo";
const STATE: Dict = {
  name: "Mark", state: "LISTENING", speaking: false, muted: false, claude: { enabled: true, permission_mode: "plan" }, last_report: null,
};
const LOCAL = { remote: false };
const json = async (res: Response | undefined): Promise<Dict> => (await (res as Response).json()) as Dict;

interface Fake {
  port: number;
  commands: string[];
  wakes: number;
  state: Dict;
  rejectAuth: boolean;
  sockets: Set<{ send(data: string): void; close(): void }>;
  stop(): void;
}

function startFakeMark(): Fake {
  const fake: Fake = { port: 0, commands: [], wakes: 0, state: { ...STATE }, rejectAuth: false, sockets: new Set(), stop: () => undefined };
  const authorized = (req: Request): boolean => !fake.rejectAuth && req.headers.get("authorization") === `Bearer ${TOKEN}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (!authorized(req)) return new Response("no", { status: 401 });
      if (url.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("upgrade", { status: 400 });
      if (url.pathname === "/api/state") return Response.json(fake.state);
      if (url.pathname === "/api/command" && req.method === "POST") {
        fake.commands.push(((await req.json()) as { text: string }).text);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/wake" && req.method === "POST") {
        fake.wakes += 1;
        return Response.json({ ok: true });
      }
      return new Response("nope", { status: 404 });
    },
    websocket: {
      open(ws) {
        fake.sockets.add(ws);
        ws.send(JSON.stringify({ type: "log", speaker: "user", text: "oi", ts: "10:00:00" }));
        ws.send(JSON.stringify({ type: "state", ...fake.state }));
      },
      close(ws) {
        fake.sockets.delete(ws);
      },
      message() {},
    },
  });
  fake.port = server.port as number;
  fake.stop = () => server.stop(true);
  return fake;
}

let dir = "";
let fake: Fake;
let bridgeFile = "";

const writeBridge = (patch: Dict = {}): void => {
  writeFileSync(bridgeFile, JSON.stringify({ port: fake.port, token: TOKEN, scheme: "http", pid: process.pid, ...patch }));
};
const makeMark = (extra: Partial<Parameters<typeof createMark>[0]> = {}): Mark => createMark({ bridgePath: () => bridgeFile, timeoutMs: () => 1500, ...extra });
const post = (mark: Mark, path: string, body: Dict) => mark.post(path, body, LOCAL);
const get = (mark: Mark, path: string, signal?: AbortSignal) => mark.get(path, new Request(`http://127.0.0.1${path}`, { signal }));
const deadPid = (): number => spawnSync("true").pid;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mark-proxy-"));
  bridgeFile = join(dir, "bridge.json");
  fake = startFakeMark();
});
afterAll(() => {
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("estado", () => {
  test("dado o Mark no ar, GET /api/mark/state devolve online com o estado e sem o token", async () => {
    writeBridge();
    const res = await get(makeMark(), "/api/mark/state");
    const body = await json(res);
    expect(res?.status).toBe(200);
    expect(body).toMatchObject({ online: true, available: true, name: "Mark", state: "LISTENING", muted: false });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  test("dado o bridge.json ausente, o estado é offline sem disponibilidade e com a explicação do catálogo", async () => {
    rmSync(bridgeFile, { force: true });
    const body = await json(await get(makeMark(), "/api/mark/state"));
    expect(body).toMatchObject({ online: false, available: false, cause: MARK_ERRORS.bridgeMissing });
    expect(body.explain).toMatchObject({ code: MARK_ERRORS.bridgeMissing });
    expect(String((body.explain as Dict).action)).toContain("mark");
  });

  test("dado o pid morto no arquivo, a causa é process_gone e o nó ainda é oferecido", async () => {
    writeBridge({ pid: deadPid() });
    const body = await json(await get(makeMark(), "/api/mark/state"));
    expect(body).toMatchObject({ online: false, available: true, cause: MARK_ERRORS.processGone });
  });

  test("dada a porta fechada, a causa é unreachable", async () => {
    const closed = startFakeMark();
    const port = closed.port;
    closed.stop();
    writeBridge({ port });
    const body = await json(await get(makeMark(), "/api/mark/state"));
    expect(body).toMatchObject({ online: false, cause: MARK_ERRORS.unreachable });
  });

  test("dado o token recusado pelo Mark, a causa é rejected", async () => {
    writeBridge();
    fake.rejectAuth = true;
    try {
      const body = await json(await get(makeMark(), "/api/mark/state"));
      expect(body).toMatchObject({ online: false, cause: MARK_ERRORS.rejected });
    } finally {
      fake.rejectAuth = false;
    }
  });

  test("dado um estado fora do contrato, a causa é bad_response", async () => {
    writeBridge();
    const saved = fake.state;
    fake.state = { ...STATE, state: "DANCING" };
    try {
      const body = await json(await get(makeMark(), "/api/mark/state"));
      expect(body).toMatchObject({ online: false, cause: MARK_ERRORS.badResponse });
    } finally {
      fake.state = saved;
    }
  });

  test("dado o bridge.json com campo inválido ou grande demais, a causa é bridge_invalid", async () => {
    writeFileSync(bridgeFile, JSON.stringify({ port: 0, token: TOKEN, scheme: "http", pid: process.pid }));
    expect(await json(await get(makeMark(), "/api/mark/state"))).toMatchObject({ cause: MARK_ERRORS.bridgeInvalid });
    writeFileSync(bridgeFile, JSON.stringify({ port: fake.port, token: TOKEN, scheme: "ftp", pid: process.pid }));
    expect(await json(await get(makeMark(), "/api/mark/state"))).toMatchObject({ cause: MARK_ERRORS.bridgeInvalid });
    writeFileSync(bridgeFile, "x".repeat(8192));
    expect(await json(await get(makeMark(), "/api/mark/state"))).toMatchObject({ cause: MARK_ERRORS.bridgeInvalid });
  });
});

describe("comando e wake", () => {
  test("dado um texto, POST /api/mark/command o entrega ao Mark com o token e responde ok", async () => {
    writeBridge();
    fake.commands.length = 0;
    const res = await post(makeMark(), "/api/mark/command", { text: "  abra o relatório  " });
    expect(res?.status).toBe(200);
    expect(fake.commands).toEqual(["abra o relatório"]);
  });

  test("dado texto vazio, responde 400 text_empty e nada chega ao Mark", async () => {
    writeBridge();
    fake.commands.length = 0;
    const res = await post(makeMark(), "/api/mark/command", { text: "   " });
    expect(res?.status).toBe(400);
    expect((await json(res)).code).toBe(MARK_ERRORS.textEmpty);
    expect(fake.commands).toEqual([]);
  });

  test("dado texto no teto, passa; um caractere acima, responde 400 text_too_long", async () => {
    writeBridge();
    fake.commands.length = 0;
    const mark = makeMark();
    expect((await post(mark, "/api/mark/command", { text: "a".repeat(MARK_LIMITS.commandChars) }))?.status).toBe(200);
    const over = await post(mark, "/api/mark/command", { text: "a".repeat(MARK_LIMITS.commandChars + 1) });
    expect(over?.status).toBe(400);
    expect((await json(over)).code).toBe(MARK_ERRORS.textTooLong);
    expect(fake.commands).toHaveLength(1);
  });

  test("dado texto que não é string, responde 400 text_empty", async () => {
    writeBridge();
    const res = await post(makeMark(), "/api/mark/command", { text: 42 });
    expect(res?.status).toBe(400);
    expect((await json(res)).code).toBe(MARK_ERRORS.textEmpty);
  });

  test("dado o Mark fora do ar, o comando responde 503 com o código da causa", async () => {
    rmSync(bridgeFile, { force: true });
    const res = await post(makeMark(), "/api/mark/command", { text: "oi" });
    expect(res?.status).toBe(503);
    expect((await json(res)).code).toBe(MARK_ERRORS.bridgeMissing);
  });

  test("POST /api/mark/wake chega ao Mark uma vez", async () => {
    writeBridge();
    const before = fake.wakes;
    const res = await post(makeMark(), "/api/mark/wake", {});
    expect(res?.status).toBe(200);
    expect(fake.wakes).toBe(before + 1);
  });

  test("dado o décimo primeiro pedido na janela, responde 429 com Retry-After", async () => {
    writeBridge();
    let clock = 1_000_000;
    const mark = makeMark({ now: () => clock });
    for (let i = 0; i < MARK_LIMITS.rateCount; i += 1) expect((await post(mark, "/api/mark/wake", {}))?.status).toBe(200);
    const limited = await post(mark, "/api/mark/wake", {});
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await json(limited)).code).toBe(MARK_ERRORS.rateLimited);
    clock += MARK_LIMITS.rateWindowMs;
    expect((await post(mark, "/api/mark/wake", {}))?.status).toBe(200);
  });

  test("dado um caminho que não é do Mark, devolve undefined", async () => {
    const mark = makeMark();
    expect(await get(mark, "/api/mark/nada")).toBeUndefined();
    expect(await post(mark, "/api/mark/nada", {})).toBeUndefined();
  });
});

describe("eventos", () => {
  async function readFrames(res: Response, want: number): Promise<string> {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (text.match(/^event: /gm) ?? []).length < want) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    return text;
  }

  test("dado o Mark no ar, o SSE repassa o log e o estado do /ws sem o token", async () => {
    writeBridge();
    const ctl = new AbortController();
    const res = await get(makeMark(), "/api/mark/events", ctl.signal);
    expect(res?.headers.get("content-type")).toContain("text/event-stream");
    const text = await readFrames(res as Response, 2);
    ctl.abort();
    expect(text).toContain("event: log");
    expect(text).toContain('"text":"oi"');
    expect(text).toContain("event: state");
    expect(text).toContain('"state":"LISTENING"');
    expect(text).not.toContain(TOKEN);
  });

  test("dada mudança de estado no Mark, o SSE entrega o evento novo", async () => {
    writeBridge();
    const ctl = new AbortController();
    const res = await get(makeMark(), "/api/mark/events", ctl.signal);
    const reader = (res?.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const pump = async (until: string): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !text.includes(until)) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value);
      }
    };
    await pump('"state":"LISTENING"');
    for (const socket of fake.sockets) socket.send(JSON.stringify({ type: "state", ...STATE, state: "SPEAKING", speaking: true }));
    await pump('"state":"SPEAKING"');
    await reader.cancel();
    ctl.abort();
    expect(text).toContain('"state":"SPEAKING"');
  });

  test("dado o bridge.json ausente, o SSE manda offline com a causa e fecha", async () => {
    rmSync(bridgeFile, { force: true });
    const res = await get(makeMark(), "/api/mark/events");
    const text = await readFrames(res as Response, 1);
    expect(text).toContain("event: offline");
    expect(text).toContain(MARK_ERRORS.bridgeMissing);
  });

  test("dado o cliente que desconecta, o ws do Mark fecha junto e o proxy não guarda o stream", async () => {
    writeBridge();
    const mark = makeMark();
    const ctl = new AbortController();
    const res = await get(mark, "/api/mark/events", ctl.signal);
    await readFrames(res as Response, 1);
    ctl.abort();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (mark.size() > 0 || fake.sockets.size > 0)) await Bun.sleep(20);
    expect(mark.size()).toBe(0);
    expect(fake.sockets.size).toBe(0);
  });

  test("dado o limite de streams, o excedente recebe 429 com Retry-After", async () => {
    writeBridge();
    const mark = makeMark({ maxStreams: 1 });
    const ctl = new AbortController();
    const first = await get(mark, "/api/mark/events", ctl.signal);
    expect(first?.status).toBe(200);
    const second = await get(mark, "/api/mark/events");
    expect(second?.status).toBe(429);
    expect(second?.headers.get("Retry-After")).not.toBeNull();
    expect((await json(second)).code).toBe(MARK_ERRORS.streamsBusy);
    ctl.abort();
    mark.close();
  });

  test("dado o Mark que recusa o token no ws, o SSE termina com offline", async () => {
    writeBridge();
    fake.rejectAuth = true;
    try {
      const res = await get(makeMark(), "/api/mark/events");
      const text = await readFrames(res as Response, 1);
      expect(text).toContain("event: offline");
    } finally {
      fake.rejectAuth = false;
    }
  });
});

describe("relatório", () => {
  const withReport = (path: string): void => {
    fake.state = { ...STATE, last_report: { path, title: "Resumo do dia", ts: 1_700_000_000 } };
  };

  test("dado um .md dentro de reports, devolve título e texto, sem o caminho", async () => {
    writeBridge();
    mkdirSync(join(dir, "reports"), { recursive: true });
    const file = join(dir, "reports", "dia.md");
    writeFileSync(file, "# Dia\nfeito");
    withReport(file);
    const body = await json(await get(makeMark(), "/api/mark/report"));
    expect(body).toMatchObject({ title: "Resumo do dia", text: "# Dia\nfeito", clipped: false });
    expect(JSON.stringify(body)).not.toContain(dir);
  });

  test("dado um arquivo fora de uma pasta reports, responde 404 no_report", async () => {
    writeBridge();
    const outside = join(dir, "segredo.md");
    writeFileSync(outside, "não sai daqui");
    withReport(outside);
    const res = await get(makeMark(), "/api/mark/report");
    expect(res?.status).toBe(404);
    expect((await json(res)).code).toBe(MARK_ERRORS.noReport);
  });

  test("dado um link em reports que aponta para fora, o caminho resolvido é recusado", async () => {
    writeBridge();
    const outside = join(dir, "alvo.md");
    writeFileSync(outside, "fora");
    mkdirSync(join(dir, "reports"), { recursive: true });
    const link = join(dir, "reports", "link.md");
    rmSync(link, { force: true });
    symlinkSync(outside, link);
    withReport(link);
    const res = await get(makeMark(), "/api/mark/report");
    expect(res?.status).toBe(404);
  });

  test("dado um arquivo que não é .md em reports, responde 404", async () => {
    writeBridge();
    const file = join(dir, "reports", "dia.txt");
    writeFileSync(file, "texto");
    withReport(file);
    expect((await get(makeMark(), "/api/mark/report"))?.status).toBe(404);
  });

  test("dado o Mark sem relatório, responde 404 no_report", async () => {
    writeBridge();
    fake.state = { ...STATE };
    const res = await get(makeMark(), "/api/mark/report");
    expect(res?.status).toBe(404);
    expect((await json(res)).code).toBe(MARK_ERRORS.noReport);
  });

  test("dado um relatório maior que o teto, corta e marca clipped", async () => {
    writeBridge();
    const file = join(dir, "reports", "grande.md");
    writeFileSync(file, "x".repeat(MARK_LIMITS.reportBytes + 10));
    withReport(file);
    const body = await json(await get(makeMark(), "/api/mark/report"));
    expect(body.clipped).toBe(true);
    expect(String(body.text).length).toBe(MARK_LIMITS.reportBytes);
    fake.state = { ...STATE };
  });
});
