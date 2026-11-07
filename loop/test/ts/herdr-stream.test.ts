// Grupo herdr-stream: o terminal ao vivo do nó de agente, lado do servidor (src/panel/herdr-stream.ts, a entrada direta de
// src/panel/herdr-page.ts e o cliente de socket de src/panel/herdr.ts). Dublê só no herdr: um servidor de socket unix
// que fala a API de linhas JSON do 0.8.2, conta assinaturas e leituras e recusa tecla que o herdr não conhece.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { createHerdrSocket, type Herdr } from "../../../src/panel/herdr";
import { createHerdrPage, inputParams, isUnsupportedMethod, KEYS, MAX_KEYS, MAX_TEXT, SIZE_ERRORS, SIZE_LIMITS, SIZE_RATE_MAX, SIZE_RATE_WINDOW_MS, SizeError, sizeParams } from "../../../src/panel/herdr-page";
import {
  createHerdrStream, ECHO_RETRY_MS, parseCursor, FRAME_INTERVAL_MS, IDLE_POLL_MAX_MS, type HerdrStream, nextPollMs, parseStreamQuery, STREAM_ERRORS, STREAM_PANES_MAX,
  subscriptionsFor, StreamRequestError,
} from "../../../src/panel/herdr-stream";
import type { PanelEnv } from "../../../src/panel/env";
import { BadRequest } from "../../../src/panel/http";

type Dict = Record<string, unknown>;

const T = mkdtempSync(join(tmpdir(), "hades-herdr-stream-"));
const SOCK = join(T, "herdr.sock");
const NOTIFY_LOG = join(T, "notify.log");
const D = join(T, "data");
// nomes que o herdr 0.8.2 aceita no `pane.send_input` (medido); o resto responde `invalid_key`
const HERDR_KEY_NAMES = new Set(["Enter", "Escape", "C-c", "Tab", "Up", "Down", "Left", "Right", "y", "n", "Backspace", "shift+tab", ...[..."abcdefghijklmnopqrstuvwxyz"].map((l) => `ctrl+${l}`)]);

interface FakePane {
  text: string;
  status: string;
  rows: number;
  cols: number;
  cursor?: Dict;
}
type SizeMode = "ok" | "unknown_method" | "invalid_request";

/** O herdr falso: uma requisição por conexão, `events.subscribe` segura a conexão aberta. */
function createFakeHerdr(path: string) {
  const panes = new Map<string, FakePane>();
  const subs = new Set<Socket<undefined>>();
  const counts = { subscribes: 0, reads: 0, lists: 0 };
  const inputs: Dict[] = [];
  const subscriptions: Dict[][] = [];
  let refuseSubscribe = false;
  let sizeMode: SizeMode = "unknown_method";
  const sizes: Dict[] = [];
  const reply = (s: Socket<undefined>, body: Dict): void => {
    s.write(`${JSON.stringify(body)}\n`);
  };
  const handle = (s: Socket<undefined>, line: string): void => {
    const { id, method, params } = JSON.parse(line) as { id: string; method: string; params: Dict };
    const pane = panes.get(String(params.pane_id));
    switch (method) {
      case "pane.list":
        counts.lists += 1;
        reply(s, { id, result: { type: "pane_list", panes: [...panes].map(([pane_id, p]) => ({ pane_id, agent_status: p.status, scroll: { viewport_rows: p.rows } })) } });
        return void s.end();
      case "pane.layout":
        if (!pane) return void reply(s, { id, error: { code: "pane_not_found", message: "pane not found" } });
        reply(s, { id, result: { type: "pane_layout", layout: { panes: [...panes].map(([pane_id, p]) => ({ pane_id, rect: { width: p.cols, height: p.rows } })) } } });
        return void s.end();
      case "pane.read":
        counts.reads += 1;
        if (!pane) return void reply(s, { id, error: { code: "pane_not_found", message: `pane ${String(params.pane_id)} not found` } });
        reply(s, { id, result: { type: "pane_read", read: { pane_id: params.pane_id, source: params.source, format: params.format, text: pane.text, revision: 0, truncated: false, ...(pane.cursor ? { cursor: pane.cursor } : {}) } } });
        return void s.end();
      case "pane.send_input": {
        const keys = (params.keys ?? []) as string[];
        const bad = keys.find((k) => !HERDR_KEY_NAMES.has(k));
        if (bad) return void reply(s, { id, error: { code: "invalid_key", message: `unsupported key ${bad}` } });
        inputs.push(params);
        reply(s, { id, result: { type: "ok" } });
        return void s.end();
      }
      case "pane.set_size":
        // 0.8.2: `invalid_request` com a variante desconhecida; outro herdr: `unknown_method`; o fork: aplica e devolve pane_info
        if (sizeMode === "invalid_request") return void reply(s, { id, error: { code: "invalid_request", message: "unknown variant `pane.set_size`, expected one of `pane.read`" } });
        if (sizeMode === "unknown_method" || !pane) return void reply(s, { id, error: sizeMode === "ok" ? { code: "pane_not_found", message: "pane not found" } : { code: "unknown_method", message: method } });
        sizes.push(params);
        reply(s, { id, result: { type: "pane_info", pane: params.release === true ? { pane_id: params.pane_id, size_pinned: false } : { pane_id: params.pane_id, cols: params.cols, rows: params.rows, size_pinned: true } } });
        return void s.end();
      case "events.subscribe":
        if (refuseSubscribe) return void reply(s, { id, error: { code: "invalid_request", message: "assinatura recusada" } });
        counts.subscribes += 1;
        subscriptions.push(params.subscriptions as Dict[]);
        subs.add(s);
        return void reply(s, { id, result: { type: "subscription_started" } });
      default:
        reply(s, { id, error: { code: "unknown_method", message: method } });
        s.end();
    }
  };
  const server = Bun.listen<undefined>({
    unix: path,
    socket: {
      data(s, chunk) {
        for (const line of new TextDecoder().decode(chunk).split("\n")) if (line.trim()) handle(s, line);
      },
      close(s) {
        subs.delete(s);
      },
    },
  });
  return {
    panes, counts, inputs, subscriptions, subs, sizes,
    setSizeMode(mode: SizeMode): void {
      sizeMode = mode;
    },
    emit(event: string, data: Dict): void {
      for (const s of subs) s.write(`${JSON.stringify({ event, data })}\n`);
    },
    refuseSubscriptions(on: boolean): void {
      refuseSubscribe = on;
    },
    reset(): void {
      panes.clear();
      inputs.length = 0;
      subscriptions.length = 0;
      sizes.length = 0;
      sizeMode = "unknown_method";
      Object.assign(counts, { subscribes: 0, reads: 0, lists: 0 });
      refuseSubscribe = false;
    },
    stop: () => server.stop(true),
  };
}

const fake = createFakeHerdr(SOCK);
const socket = createHerdrSocket();
let stream: HerdrStream | undefined;

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condição não chegou a tempo");
    await Bun.sleep(5);
  }
}

interface Received {
  event: string;
  data: Dict;
  at: number;
}
/** Abre o SSE como o EventSource faria e junta os eventos recebidos. */
async function connect(query: string): Promise<{ status: number; body: Dict | null; events: Received[]; ended: () => boolean; close: () => Promise<void> }> {
  const ac = new AbortController();
  if (!stream) throw new Error("abra o fluxo com freshStream()");
  const res = await stream.open(new Request(`http://127.0.0.1/api/herdr/stream?${query}`, { signal: ac.signal }), Object.fromEntries(new URLSearchParams(query)));
  const events: Received[] = [];
  if (res.status !== 200 || !res.body) return { status: res.status, body: (await res.json()) as Dict, events, ended: () => true, close: async () => {} };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let pending = "";
  const pump = async (): Promise<void> => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let cut = pending.indexOf("\n\n");
      while (cut >= 0) {
        const block = pending.slice(0, cut);
        pending = pending.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) as Dict, at: Date.now() });
        cut = pending.indexOf("\n\n");
      }
    }
  };
  pump().catch(() => undefined).finally(() => {
    done = true;
  });
  return {
    status: 200, body: null, events, ended: () => done,
    close: async () => {
      ac.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

const framesOf = (events: Received[], pane?: string): Dict[] => events.filter((e) => e.event === "frame" && (!pane || e.data.pane === pane)).map((e) => e.data);
const addPane = (id: string, text = `tela de ${id}`, status = "idle"): void => {
  fake.panes.set(id, { text, status, rows: 24, cols: 80 });
};

beforeAll(() => {
  mkdirSync(D, { recursive: true });
  writeFileSync(join(D, "notify.sh"), `#!/usr/bin/env bash\necho "$*" >> "${NOTIFY_LOG}"\n`);
  chmodSync(join(D, "notify.sh"), 0o755);
});
afterEach(() => {
  stream?.stop();
  fake.reset();
});
afterAll(() => {
  fake.stop();
  rmSync(T, { recursive: true, force: true });
});

const freshStream = (): HerdrStream => {
  stream = createHerdrStream({ socket, socketOf: async (session) => (session === "default" ? SOCK : undefined) });
  return stream;
};

describe("herdr-stream: regras puras", () => {
  test("dado quadro igual, o intervalo dobra até o teto ocioso; quadro novo volta ao teto de quadros", () => {
    expect(nextPollMs(FRAME_INTERVAL_MS, false)).toBe(FRAME_INTERVAL_MS * 2);
    expect(nextPollMs(IDLE_POLL_MAX_MS, false)).toBe(IDLE_POLL_MAX_MS);
    expect(nextPollMs(IDLE_POLL_MAX_MS, true)).toBe(FRAME_INTERVAL_MS);
  });

  test("a assinatura pede o estado do agente por pane e os eventos globais uma vez", () => {
    const subs = subscriptionsFor(["w1:p2", "w1:p1"]);
    expect(subs.filter((s) => s.type === "pane.agent_status_changed").map((s) => s.pane_id)).toEqual(["w1:p1", "w1:p2"]);
    expect(subs.map((s) => s.type)).toContain("pane.exited");
  });

  test("query: sessão e panes validados no formato, duplicata some, teto de panes por conexão", () => {
    expect(parseStreamQuery({ panes: "w1:p1, w1:p1,w2:p3" })).toEqual({ session: "default", panes: ["w1:p1", "w2:p3"] });
    const codeOf = (query: Record<string, string>): string => {
      try {
        parseStreamQuery(query);
        return "aceito";
      } catch (error) {
        if (error instanceof StreamRequestError) return error.code;
        throw error;
      }
    };
    expect(codeOf({ session: "../x", panes: "w1:p1" })).toBe(STREAM_ERRORS.sessionInvalid);
    expect(codeOf({})).toBe(STREAM_ERRORS.panesInvalid);
    expect(codeOf({ panes: "w1:p1;rm" })).toBe(STREAM_ERRORS.panesInvalid);
    const many = Array.from({ length: STREAM_PANES_MAX + 1 }, (_, i) => `w1:p${i}`).join(",");
    expect(codeOf({ panes: many })).toBe(STREAM_ERRORS.panesTooMany);
  });
});

describe("herdr-stream: SSE contra o herdr falso", () => {
  test("pane que cresce no layout: o quadro seguinte traz as linhas novas (o campo de digitação não some)", async () => {
    freshStream();
    addPane("w1:p1", "tela");
    const a = await connect("session=default&panes=w1:p1");
    await until(() => framesOf(a.events).length > 0);
    expect(framesOf(a.events)[0]).toMatchObject({ rows: 24 });
    fake.emit("layout_updated", { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 80, height: 40 } }] } });
    const pane = fake.panes.get("w1:p1");
    if (pane) pane.text = "tela maior";
    await until(() => framesOf(a.events).some((f) => f.rows === 40));
    expect(framesOf(a.events).at(-1)).toMatchObject({ cols: 80, rows: 40 });
    await a.close();
  });

  test("tamanho fixado pelo set_size vence o layout até ser liberado; liberado, o quadro volta ao layout", async () => {
    freshStream();
    addPane("w1:p1", "tela");
    const a = await connect("session=default&panes=w1:p1");
    await until(() => framesOf(a.events).length > 0);
    const pane = fake.panes.get("w1:p1");
    stream?.sized("default", "w1:p1", { cols: 100, rows: 30, pinned: true });
    if (pane) pane.text = "tela fixada";
    await until(() => framesOf(a.events).some((f) => f.cols === 100 && f.rows === 30));
    fake.emit("layout_updated", { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 60, height: 40 } }] } });
    if (pane) pane.text = "tela fixada depois do layout";
    stream?.nudge("default", "w1:p1");
    await until(() => framesOf(a.events).some((f) => String(f.ansi).includes("depois do layout")));
    expect(framesOf(a.events).at(-1)).toMatchObject({ cols: 100, rows: 30 });
    stream?.sized("default", "w1:p1", { pinned: false });
    if (pane) pane.text = "tela liberada";
    await until(() => framesOf(a.events).some((f) => f.cols === 80 && f.rows === 24));
    await a.close();
  });

  test("pane_updated com size_pinned do fork fixa a grade do quadro no tamanho do PTY", async () => {
    freshStream();
    addPane("w1:p1", "tela");
    const a = await connect("session=default&panes=w1:p1");
    await until(() => framesOf(a.events).length > 0);
    fake.emit("pane_updated", { pane: { pane_id: "w1:p1", cols: 120, rows: 35, size_pinned: true, scroll: { viewport_rows: 50 } } });
    const pane = fake.panes.get("w1:p1");
    if (pane) pane.text = "tela do pty";
    await until(() => framesOf(a.events).some((f) => f.cols === 120 && f.rows === 35));
    expect(framesOf(a.events).some((f) => f.rows === 50)).toBe(false);
    await a.close();
  });

  test("dois clientes no mesmo pane abrem uma assinatura só e recebem o mesmo quadro", async () => {
    freshStream();
    addPane("w1:p1", "\u001b[1mola\u001b[0m");
    const a = await connect("session=default&panes=w1:p1");
    const b = await connect("session=default&panes=w1:p1");
    await until(() => framesOf(a.events).length > 0 && framesOf(b.events).length > 0);
    expect(fake.counts.subscribes).toBe(1);
    expect(fake.subs.size).toBe(1);
    expect(framesOf(a.events)[0]).toMatchObject({ pane: "w1:p1", cols: 80, rows: 24, ansi: "\u001b[1mola\u001b[0m" });
    expect(framesOf(b.events)[0]?.revision).toBe(framesOf(a.events)[0]?.revision);
    await a.close();
    await b.close();
  });

  test("rajada de 50 eventos vira no máximo um quadro por FRAME_INTERVAL_MS, e o último estado chega", async () => {
    freshStream();
    addPane("w1:p1", "linha inicial");
    const c = await connect("panes=w1:p1");
    await until(() => framesOf(c.events).length === 1);
    const start = Date.now();
    const readsBefore = fake.counts.reads;
    for (let i = 0; i < 50; i += 1) {
      (fake.panes.get("w1:p1") as FakePane).text = `linha ${i}`;
      fake.emit("pane.agent_status_changed", { pane_id: "w1:p1", agent_status: i % 2 === 0 ? "working" : "idle" });
      await Bun.sleep(4);
    }
    await until(() => framesOf(c.events).at(-1)?.ansi === "linha 49");
    const elapsed = Date.now() - start;
    const frames = framesOf(c.events).length - 1;
    const ceiling = Math.floor(elapsed / FRAME_INTERVAL_MS) + 1;
    expect(frames).toBeLessThanOrEqual(ceiling);
    expect(frames).toBeLessThan(50);
    expect(fake.counts.reads - readsBefore).toBeLessThanOrEqual(ceiling + 1);
    // o estado do agente não coalesce: cada mudança chega
    expect(c.events.filter((e) => e.event === "status").length).toBeGreaterThanOrEqual(50);
    await c.close();
  });

  test("último cliente saindo fecha a assinatura; antes disso ela segue aberta", async () => {
    freshStream();
    addPane("w1:p1");
    addPane("w1:p2");
    const a = await connect("panes=w1:p1");
    const b = await connect("panes=w1:p1,w1:p2");
    await until(() => framesOf(b.events).length >= 2 && fake.subs.size === 1 && fake.counts.subscribes >= 2);
    await a.close();
    await Bun.sleep(30);
    expect(fake.subs.size).toBe(1);
    await b.close();
    await until(() => fake.subs.size === 0);
    expect(stream?.stats()).toMatchObject({ streams: 0, hubs: 0 });
  });

  test("pane fora da listagem: 400 se todos, evento error se só parte", async () => {
    freshStream();
    addPane("w1:p1");
    const all = await connect("panes=w9:p9");
    expect(all.status).toBe(400);
    expect(all.body).toMatchObject({ code: STREAM_ERRORS.paneUnknown });
    const some = await connect("panes=w1:p1,w9:p9");
    await until(() => framesOf(some.events).length === 1);
    expect(some.events.find((e) => e.event === "error")?.data).toMatchObject({ pane: "w9:p9", code: STREAM_ERRORS.paneUnknown });
    expect(framesOf(some.events, "w9:p9")).toEqual([]);
    expect(fake.subscriptions.at(-1)?.filter((s) => s.type === "pane.agent_status_changed").map((s) => s.pane_id)).toEqual(["w1:p1"]);
    await some.close();
    const unknownSession = await connect("session=outra&panes=w1:p1");
    expect(unknownSession).toMatchObject({ status: 400, body: { code: STREAM_ERRORS.sessionUnknown } });
  });

  test("reconexão recebe o quadro atual na hora; depois de todos saírem, a revisão não volta atrás", async () => {
    freshStream();
    addPane("w1:p1", "tela parada", "working");
    const first = await connect("panes=w1:p1");
    await until(() => framesOf(first.events).length === 1);
    const shown = framesOf(first.events)[0] as Dict;
    const readsBefore = fake.counts.reads;
    const again = await connect("panes=w1:p1");
    await until(() => framesOf(again.events).length === 1, FRAME_INTERVAL_MS);
    // sem nenhuma mudança na tela: o quadro sai do retrato guardado (mesma revisão), junto do estado
    expect(framesOf(again.events)[0]).toEqual(shown);
    expect(fake.counts.reads).toBeLessThanOrEqual(readsBefore + 1);
    expect(again.events.find((e) => e.event === "status")?.data).toEqual({ pane: "w1:p1", agentStatus: "working" });
    await first.close();
    await again.close();
    await until(() => fake.subs.size === 0);
    const later = await connect("panes=w1:p1");
    await until(() => framesOf(later.events).length === 1);
    expect(framesOf(later.events)[0]?.ansi).toBe("tela parada");
    expect(Number(framesOf(later.events)[0]?.revision)).toBeGreaterThan(Number(shown.revision));
    await later.close();
  });

  test("pane que sai vira evento exited e para de ser lido", async () => {
    freshStream();
    addPane("w1:p1");
    const c = await connect("panes=w1:p1");
    await until(() => framesOf(c.events).length === 1 && fake.subs.size === 1);
    fake.emit("pane_exited", { pane_id: "w1:p1", workspace_id: "w1", type: "pane_exited" });
    await until(() => c.events.some((e) => e.event === "exited"));
    const reads = fake.counts.reads;
    await Bun.sleep(IDLE_POLL_MAX_MS / 2);
    expect(fake.counts.reads).toBe(reads);
    await c.close();
  });

  test("assinatura recusada pelo herdr: evento error com código e o fluxo fecha (o EventSource religa)", async () => {
    freshStream();
    addPane("w1:p1");
    fake.refuseSubscriptions(true);
    const c = await connect("panes=w1:p1");
    await until(() => c.ended());
    expect(c.events.find((e) => e.event === "error" && !e.data.pane)?.data).toMatchObject({ code: STREAM_ERRORS.subscriptionFailed });
    expect(stream?.stats()).toMatchObject({ streams: 0, hubs: 0 });
  });
});

describe("herdr-stream: eco da entrada direta", () => {
  const settle = async (stream: HerdrStream, events: Received[]): Promise<void> => {
    await until(() => framesOf(events).length > 0);
    // deixa o leitor recuar do ritmo de quadros (o caso real: o dono para e depois digita)
    await Bun.sleep(FRAME_INTERVAL_MS * 3);
    expect(stream.stats().reads).toBeGreaterThan(0);
  };

  test("dado eco que o herdr processa depois do nudge, então o quadro chega antes de o intervalo dobrado", async () => {
    const stream = freshStream();
    addPane("w1:p1", "$ ");
    const a = await connect("session=default&panes=w1:p1");
    await settle(stream, a.events);
    const before = framesOf(a.events).length;
    stream.nudge("default", "w1:p1");
    const sent = Date.now();
    // o herdr só mostra o eco 25 ms depois do pane.send_input: a leitura imediata vê o quadro velho
    setTimeout(() => { const pane = fake.panes.get("w1:p1"); if (pane) pane.text = "$ a"; }, 25);
    await until(() => framesOf(a.events).length > before);
    expect(Date.now() - sent).toBeLessThan(FRAME_INTERVAL_MS);
    await a.close();
  });

  test("dado nudge logo depois de uma leitura, então o teto de quadros cede e o eco não espera os 100 ms", async () => {
    const stream = freshStream();
    addPane("w1:p1", "$ ");
    const a = await connect("session=default&panes=w1:p1");
    await until(() => framesOf(a.events).length > 0);
    const before = framesOf(a.events).length;
    stream.nudge("default", "w1:p1");
    const sent = Date.now();
    setTimeout(() => { const pane = fake.panes.get("w1:p1"); if (pane) pane.text = "$ a"; }, 10);
    await until(() => framesOf(a.events).length > before);
    expect(Date.now() - sent).toBeLessThan(FRAME_INTERVAL_MS * 0.7);
    await a.close();
  });

  test("dado nudge sem mudança, então só as releituras curtas da janela são acrescentadas e o ritmo ocioso volta", async () => {
    const stream = freshStream();
    addPane("w1:p1", "$ ");
    addPane("w1:p2", "$ ");
    const a = await connect("session=default&panes=w1:p1,w1:p2");
    await until(() => framesOf(a.events).length >= 2);
    await Bun.sleep(FRAME_INTERVAL_MS * 4);
    const base = stream.stats().reads;
    stream.nudge("default", "w1:p1");
    await Bun.sleep(ECHO_RETRY_MS.reduce((x, y) => x + y, 0) + 40);
    const burst = stream.stats().reads - base;
    // 1 do nudge + as da janela; o pane sem entrada não ganha leitura extra além do ritmo ocioso dele
    expect(burst).toBeGreaterThanOrEqual(1 + ECHO_RETRY_MS.length);
    expect(burst).toBeLessThanOrEqual(2 + ECHO_RETRY_MS.length);
    const settled = stream.stats().reads;
    await Bun.sleep(IDLE_POLL_MAX_MS / 2);
    expect(stream.stats().reads - settled).toBeLessThanOrEqual(2 * 3);
    await a.close();
  });

  test("dado eco já visto na primeira leitura, então a janela fecha sem as releituras curtas", async () => {
    const stream = freshStream();
    addPane("w1:p1", "$ ");
    const a = await connect("session=default&panes=w1:p1");
    await settle(stream, a.events);
    const base = stream.stats().reads;
    const pane = fake.panes.get("w1:p1");
    if (pane) pane.text = "$ a";
    stream.nudge("default", "w1:p1");
    await Bun.sleep(ECHO_RETRY_MS.reduce((x, y) => x + y, 0) + 20);
    // 1 leitura do nudge; a próxima só no ritmo de quadros
    expect(stream.stats().reads - base).toBeLessThanOrEqual(2);
    await a.close();
  });
});

describe("herdr-page: entrada direta", () => {
  const env = { dir: D, locks: undefined } as unknown as PanelEnv;
  // dublê do lado CLI do herdr (sessões e retrato); a escrita vai pelo socket falso
  const herdrCli = {
    cached: async <V>(_key: string, load: () => Promise<V>) => load(),
    call: async () => ({ rc: 0, out: JSON.stringify({ sessions: [{ name: "default", running: true, socket_path: SOCK }] }), err: "" }),
    snap: async () => ({ panes: [...fake.panes.keys()].map((pane_id) => ({ pane_id })) }),
    forget: () => undefined,
  } as unknown as Herdr;
  const page = (): ReturnType<typeof createHerdrPage> => createHerdrPage(env, herdrCli, socket);

  test("teclas novas são aceitas e chegam com o nome do herdr", async () => {
    addPane("w1:p1");
    expect(await page().input({ session: "default", pane: "w1:p1", keys: ["Ctrl+A", "Backspace", "Shift+Tab", "Ctrl+Z"] }, false)).toEqual({ session: "default", pane: "w1:p1" });
    expect(fake.inputs.at(-1)).toEqual({ pane_id: "w1:p1", keys: ["ctrl+a", "Backspace", "shift+tab", "ctrl+z"] });
  });

  test("tecla fora da lista: BadRequest (400 na rota) antes de chegar ao herdr", async () => {
    addPane("w1:p1");
    await expect(page().input({ session: "default", pane: "w1:p1", keys: ["Home"] }, false)).rejects.toThrow(new BadRequest("tecla inválida"));
    expect(fake.inputs).toEqual([]);
  });

  test("o texto vai ao herdr, mas nunca ao log nem ao aviso remoto", async () => {
    addPane("w1:p1");
    const typed = "segredo-do-dono-123";
    await page().input({ session: "default", pane: "w1:p1", text: typed, keys: ["Enter"] }, true);
    expect(fake.inputs.at(-1)).toEqual({ pane_id: "w1:p1", text: typed, keys: ["Enter"] });
    const logged = readFileSync(join(D, "logs", "panel-herdr.log"), "utf8");
    expect(logged).toContain("acao=input alvo=w1:p1");
    expect(logged).toContain("origem=remoto ok");
    expect(logged).not.toContain(typed);
    await until(() => {
      try {
        return readFileSync(NOTIFY_LOG, "utf8").includes("input");
      } catch {
        return false;
      }
    });
    expect(readFileSync(NOTIFY_LOG, "utf8")).not.toContain(typed);
  });

  test("pane fora da listagem e sessão desconhecida são recusados antes do herdr", async () => {
    addPane("w1:p1");
    await expect(page().input({ session: "default", pane: "w9:p9", text: "x" }, false)).rejects.toThrow(BadRequest);
    await expect(page().input({ session: "outra", pane: "w1:p1", text: "x" }, false)).rejects.toThrow(BadRequest);
    expect(fake.inputs).toEqual([]);
  });

  test("limites: vazio, texto acima de MAX_TEXT, teclas acima de MAX_KEYS e tipos errados", () => {
    const refused = (body: Dict): boolean => {
      try {
        inputParams("w1:p1", body);
        return false;
      } catch (error) {
        return error instanceof BadRequest;
      }
    };
    expect(refused({})).toBe(true);
    expect(refused({ text: "" })).toBe(true);
    expect(refused({ text: "x".repeat(MAX_TEXT + 1) })).toBe(true);
    expect(refused({ text: "x".repeat(MAX_TEXT) })).toBe(false);
    expect(refused({ keys: Array.from({ length: MAX_KEYS + 1 }, () => "Enter") })).toBe(true);
    expect(refused({ keys: "Enter" })).toBe(true);
    expect(refused({ text: 42 })).toBe(true);
  });

  test("a lista cresce sem perder as teclas de hoje (o /api/herdr/act segue aceitando)", () => {
    for (const key of ["Enter", "Escape", "Ctrl+C", "Tab", "Up", "Down", "Left", "Right", "y", "n"]) expect(Object.hasOwn(KEYS, key)).toBe(true);
    expect(KEYS["Ctrl+C"]).toBe("C-c");
    for (const name of Object.values(KEYS)) expect(HERDR_KEY_NAMES.has(name)).toBe(true);
  });
});

describe("herdr-stream: cursor real do pane.read", () => {
  test("parseCursor: só aceita row/col inteiros não negativos e visible booleano", () => {
    expect(parseCursor({ row: 3, col: 7, visible: true })).toEqual({ row: 3, col: 7, visible: true });
    expect(parseCursor({ row: 0, col: 0, visible: false })).toEqual({ row: 0, col: 0, visible: false });
    for (const bad of [undefined, null, 5, {}, { row: -1, col: 0, visible: true }, { row: 1.5, col: 0, visible: true }, { row: 1, col: 0 }, { row: "1", col: 0, visible: true }]) expect(parseCursor(bad)).toBeUndefined();
  });

  test("dado herdr que entrega o cursor, então o quadro o leva; sem ele, o campo some", async () => {
    freshStream();
    addPane("w1:p1", "$ ls");
    const withCursor = fake.panes.get("w1:p1");
    if (withCursor) withCursor.cursor = { row: 0, col: 4, visible: true };
    addPane("w1:p2", "sem cursor");
    const a = await connect("session=default&panes=w1:p1,w1:p2");
    await until(() => framesOf(a.events, "w1:p1").length > 0 && framesOf(a.events, "w1:p2").length > 0);
    expect(framesOf(a.events, "w1:p1")[0]?.cursor).toEqual({ row: 0, col: 4, visible: true });
    expect(Object.hasOwn(framesOf(a.events, "w1:p2")[0] as Dict, "cursor")).toBe(false);
    await a.close();
  });

  test("dado o cursor que muda com o texto igual, então sai quadro novo", async () => {
    freshStream();
    addPane("w1:p1", "$ ");
    const pane = fake.panes.get("w1:p1");
    if (pane) pane.cursor = { row: 0, col: 2, visible: true };
    const a = await connect("session=default&panes=w1:p1");
    await until(() => framesOf(a.events).length > 0);
    if (pane) pane.cursor = { row: 0, col: 2, visible: false };
    fake.emit("pane_updated", { pane_id: "w1:p1" });
    await until(() => framesOf(a.events).some((f) => (f.cursor as Dict | undefined)?.visible === false));
    await a.close();
  });
});

describe("herdr-page: rota de tamanho (/api/herdr/size)", () => {
  const env = { dir: D, locks: undefined } as unknown as PanelEnv;
  const herdrCli = {
    cached: async <V>(_key: string, load: () => Promise<V>) => load(),
    call: async () => ({ rc: 0, out: JSON.stringify({ sessions: [{ name: "default", running: true, socket_path: SOCK }] }), err: "" }),
    snap: async () => ({ panes: [...fake.panes.keys()].map((pane_id) => ({ pane_id })) }),
    forget: () => undefined,
  } as unknown as Herdr;
  const page = (): ReturnType<typeof createHerdrPage> => createHerdrPage(env, herdrCli, socket);
  const code = async (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (e: unknown) => (e instanceof SizeError ? e.code : e instanceof BadRequest ? "bad-request" : "outro"));

  test("sizeParams: limites do fork nas duas pontas, release sozinho", () => {
    const refused = (body: Dict): string | undefined => {
      try {
        sizeParams("w1:p1", body);
        return undefined;
      } catch (e) {
        return e instanceof SizeError ? e.code : "outro";
      }
    };
    expect(sizeParams("w1:p1", { cols: SIZE_LIMITS.colsMin, rows: SIZE_LIMITS.rowsMin })).toEqual({ pane_id: "w1:p1", cols: 4, rows: 2 });
    expect(sizeParams("w1:p1", { cols: SIZE_LIMITS.colsMax, rows: SIZE_LIMITS.rowsMax })).toEqual({ pane_id: "w1:p1", cols: 1000, rows: 500 });
    expect(sizeParams("w1:p1", { release: true })).toEqual({ pane_id: "w1:p1", release: true });
    for (const body of [{ cols: 3, rows: 10 }, { cols: 1001, rows: 10 }, { cols: 80, rows: 1 }, { cols: 80, rows: 501 }, { cols: 80.5, rows: 10 }, { cols: "80", rows: 10 }, { rows: 10 }, {}, { release: false }, { release: true, cols: 80 }]) expect(refused(body)).toBe(SIZE_ERRORS.invalid);
  });

  test("dado herdr com o método, então o pedido chega com pane_id, cols e rows e a resposta traz o pane_info", async () => {
    addPane("w1:p1");
    fake.setSizeMode("ok");
    const done = await page().size({ session: "default", pane: "w1:p1", cols: 100, rows: 30 }, false);
    expect(fake.sizes.at(-1)).toEqual({ pane_id: "w1:p1", cols: 100, rows: 30 });
    expect(done).toMatchObject({ session: "default", pane: "w1:p1", info: { cols: 100, rows: 30, size_pinned: true } });
    await page().size({ session: "default", pane: "w1:p1", release: true }, false);
    expect(fake.sizes.at(-1)).toEqual({ pane_id: "w1:p1", release: true });
  });

  test("dado herdr sem o método (unknown_method e invalid_request do 0.8.2), então herdr-unsupported com 501", async () => {
    addPane("w1:p1");
    for (const mode of ["unknown_method", "invalid_request"] as const) {
      fake.setSizeMode(mode);
      const p = page();
      const err = await p.size({ session: "default", pane: "w1:p1", cols: 80, rows: 24 }, false).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(SizeError);
      expect((err as SizeError).code).toBe(SIZE_ERRORS.unsupported);
      expect((err as SizeError).status).toBe(501);
    }
    expect(isUnsupportedMethod({ code: "invalid_request", message: "outro erro qualquer" } as never)).toBe(false);
  });

  test("dado herdr sem o método, então a negativa fica guardada e o segundo pedido nem chega ao herdr", async () => {
    addPane("w1:p1");
    fake.setSizeMode("invalid_request");
    const p = page();
    expect(await code(p.size({ session: "default", pane: "w1:p1", cols: 80, rows: 24 }, false, 1000))).toBe(SIZE_ERRORS.unsupported);
    fake.setSizeMode("ok");
    expect(await code(p.size({ session: "default", pane: "w1:p1", cols: 80, rows: 24 }, false, 2000))).toBe(SIZE_ERRORS.unsupported);
    expect(fake.sizes).toEqual([]);
  });

  test("dado rajada acima do teto, então size-rate-limited com 429 e Retry-After, e a janela volta depois", async () => {
    addPane("w1:p1");
    fake.setSizeMode("ok");
    const p = page();
    for (let i = 0; i < SIZE_RATE_MAX; i++) await p.size({ session: "default", pane: "w1:p1", cols: 80 + i, rows: 24 }, false, 5000);
    const err = await p.size({ session: "default", pane: "w1:p1", cols: 90, rows: 24 }, false, 5001).then(() => null, (e: unknown) => e);
    expect((err as SizeError).code).toBe(SIZE_ERRORS.rateLimited);
    expect((err as SizeError).status).toBe(429);
    expect((err as SizeError).retryAfterS).toBeGreaterThan(0);
    await p.size({ session: "default", pane: "w1:p1", cols: 90, rows: 24 }, false, 5000 + SIZE_RATE_WINDOW_MS + 1);
  });

  test("pane fora da listagem e sessão desconhecida são recusados antes do herdr", async () => {
    addPane("w1:p1");
    fake.setSizeMode("ok");
    expect(await code(page().size({ session: "default", pane: "w9:p9", cols: 80, rows: 24 }, false))).toBe("bad-request");
    expect(await code(page().size({ session: "outra", pane: "w1:p1", cols: 80, rows: 24 }, false))).toBe("bad-request");
    expect(fake.sizes).toEqual([]);
  });
});
