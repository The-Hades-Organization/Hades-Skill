// Grupo mark-voice: a voz do Mark pelo painel (src/panel/mark-voice.ts, mark-voice-logic.ts) contra um Mark falso de voz em
// loopback que segue o protocolo do `/ws/voice` (Bearer da ponte, `hello` primeiro, `ready`, `state`, `interrupted`, `busy`,
// `error`). Cobre hello/ready, binário nos dois sentidos, um cliente por vez, Mark fora do ar ou sem voz, as guardas de
// Origin/host/chave, teto de duração, fechamento conjunto, teto de quadro e de taxa, e o token que nunca chega ao navegador.
// O "áudio" dos testes é zero sintético: nenhum som real passa por aqui, e nenhum quadro é guardado ou impresso.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARK_ERRORS } from "../../../src/lib/mark-bridge";
import { explain } from "../../../src/lib/human-errors";
import type { Auth } from "../../../src/panel/auth";
import { createMarkVoice, type MarkVoice, type VoiceSocketData } from "../../../src/panel/mark-voice";
import {
  checkControl, CLIENT_VOICE_ERRORS, FrameGate, VOICE_ERRORS, VOICE_LIMITS, voiceCodeOf,
} from "../../../src/panel/mark-voice-logic";
import { originAllowedFor } from "../../../src/panel/term-http";

type Dict = Record<string, unknown>;

const TOKEN = "tok-de-exemplo";
const TUNNEL_HOST = "tunel.exemplo.dev";
const REMOTE_COOKIE = "hds=exemplo";
const MARK_STATE: Dict = {
  name: "Mark", state: "LISTENING", speaking: false, muted: false, claude: { enabled: true, permission_mode: "plan" },
  last_report: { path: "/segredo/reports/x.md", title: "Relatório", ts: 1 },
};
const SILENCE_20MS = new Uint8Array(640);
const PLAY_24K = new Uint8Array(960);

interface FakeMark {
  port: number;
  connections: number;
  controls: Dict[];
  frames: number[];
  closedByClient: number;
  /** Quando definido, o upgrade não é respondido (para o timeout de conexão). */
  hang: boolean;
  /** Quando falso, `/ws/voice` responde 404 (Mark sem voz remota). */
  voiceEnabled: boolean;
  held: boolean;
  sockets: Set<{ send(data: string | Uint8Array): void; close(code?: number): void }>;
  stop(): void;
}

function startFakeMark(): FakeMark {
  const fake: FakeMark = { port: 0, connections: 0, controls: [], frames: [], closedByClient: 0, hang: false, voiceEnabled: true, held: false, sockets: new Set(), stop: () => undefined };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/api/state") return Response.json(MARK_STATE);
      if (url.pathname !== "/ws/voice" || !fake.voiceEnabled) return new Response("nope", { status: 404 });
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("no", { status: 401 });
      if (fake.hang) return new Promise<Response>(() => undefined);
      return srv.upgrade(req) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      open(ws) {
        fake.connections += 1;
        fake.sockets.add(ws);
        if (fake.held) {
          ws.send(JSON.stringify({ type: "busy" }));
          ws.close();
        }
      },
      message(ws, message) {
        if (typeof message !== "string") {
          fake.frames.push(message.byteLength);
          ws.send(PLAY_24K);
          return;
        }
        const body = JSON.parse(message) as Dict;
        fake.controls.push(body);
        if (body.type === "hello") {
          ws.send(JSON.stringify({ type: "ready" }));
          ws.send(JSON.stringify({ type: "state", ...MARK_STATE, voice: { remote: true, mode: body.mode } }));
        }
      },
      close(ws) {
        fake.sockets.delete(ws);
        fake.closedByClient += 1;
      },
    },
  });
  fake.port = server.port ?? 0;
  fake.stop = () => void server.stop(true);
  return fake;
}

/** Cliente de teste: guarda o que o painel manda (texto como objeto, binário só pelo tamanho). */
class Client {
  readonly texts: Dict[] = [];
  readonly binaries: number[] = [];
  closeCode: number | undefined;
  readonly ws: WebSocket;
  private readonly waiters: Array<() => void> = [];
  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers } as unknown as string[]);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") this.texts.push(JSON.parse(event.data) as Dict);
      else this.binaries.push((event.data as ArrayBuffer).byteLength);
      this.wake();
    };
    this.ws.onclose = (event: CloseEvent) => {
      this.closeCode = event.code;
      this.wake();
    };
  }
  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
  async until(done: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!done()) {
      if (Date.now() > deadline) throw new Error("tempo esgotado esperando o painel");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }
  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.onopen = () => resolve();
      const prior = this.ws.onclose;
      this.ws.onclose = (event: CloseEvent) => {
        (prior as ((e: CloseEvent) => void) | null)?.(event);
        reject(new Error(`fechou antes de abrir (${event.code})`));
      };
    });
  }
  hasType = (type: string): boolean => this.texts.some((t) => t.type === type);
  sendJson(body: Dict): void {
    this.ws.send(JSON.stringify(body));
  }
  closed = (): boolean => this.closeCode !== undefined;
}

const stubAuth = {
  localHosts: (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`],
  isRemote: (headers: Headers) => Boolean(headers.get("x-forwarded-for")),
  hostOk: (headers: Headers, port: number) => headers.get("x-forwarded-host") === TUNNEL_HOST || headers.get("host") === `127.0.0.1:${port}`,
  authed: (headers: Headers) => !headers.get("x-forwarded-for") || headers.get("cookie") === REMOTE_COOKIE,
  publicHost: () => TUNNEL_HOST,
} as unknown as Auth;

let dir: string;
let fake: FakeMark;
let panel: ReturnType<typeof Bun.serve<VoiceSocketData>>;
let voice: MarkVoice;
let reachableCause: string | undefined;
let maxSessionMs = 60_000;
let connectMs = 3000;
let bridgeFile: string;

const writeBridge = (port: number): void => writeFileSync(bridgeFile, JSON.stringify({ port, token: TOKEN, scheme: "http", pid: process.pid }));
const url = (): string => `ws://127.0.0.1:${panel.port}/api/mark/voice`;
const open = async (headers: Record<string, string> = {}): Promise<Client> => {
  const client = new Client(url(), headers);
  await client.opened();
  return client;
};
const clients: Client[] = [];
const track = async (headers?: Record<string, string>): Promise<Client> => {
  const client = await open(headers);
  clients.push(client);
  return client;
};
const hello = (client: Client, mode?: string): void => client.sendJson(mode === undefined ? { type: "hello" } : { type: "hello", mode });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mark-voice-"));
  bridgeFile = join(dir, "bridge.json");
  fake = startFakeMark();
  writeBridge(fake.port);
  panel = Bun.serve<VoiceSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const res = voice.isVoicePath(new URL(req.url).pathname) ? voice.handle(req, srv) : new Response("nope", { status: 404 });
      return res;
    },
    websocket: { maxPayloadLength: 16_384, open: (ws) => voice.websocket.open?.(ws), message: (ws, m) => voice.websocket.message?.(ws, m), close: (ws, c, r) => voice.websocket.close?.(ws, c, r) },
  });
  voice = createMarkVoice({
    auth: stubAuth,
    port: panel.port ?? 0,
    originAllowed: originAllowedFor(stubAuth, panel.port ?? 0),
    bridgePath: () => bridgeFile,
    connectTimeoutMs: () => connectMs,
    maxSessionMs: () => maxSessionMs,
    reachable: () => Promise.resolve(reachableCause as never),
    auditFile: join(dir, "audit.log"),
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.close();
  voice.close();
  // espera os dois lados terminarem de fechar antes de zerar o que o Mark falso contou (o bye de cortesia chega depois)
  await waitFor(() => fake.sockets.size === 0 && !voice.active());
  await Bun.sleep(50);
  fake.hang = false;
  fake.voiceEnabled = true;
  fake.held = false;
  fake.controls.length = 0;
  fake.frames.length = 0;
  fake.connections = 0;
  fake.closedByClient = 0;
  writeBridge(fake.port);
  maxSessionMs = 60_000;
  connectMs = 3000;
  reachableCause = undefined;
});

afterAll(() => {
  voice.close();
  void panel.stop(true);
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("voz do Mark pelo painel: repasse", () => {
  test("dado um hello, então o Mark recebe o hello e o cliente recebe ready com o teto e o state da voz", async () => {
    const client = await track();
    hello(client, "open");
    await client.until(() => client.hasType("ready") && client.hasType("state"));
    expect(fake.controls[0]).toEqual({ type: "hello", mode: "open" });
    expect(client.texts.find((t) => t.type === "ready")).toEqual({ type: "ready", max_s: 60 });
    const state = client.texts.find((t) => t.type === "state") as Dict;
    expect(state.voice).toEqual({ remote: true, mode: "open" });
  });

  test("dado um hello sem modo, então o painel usa o modo padrão da configuração", async () => {
    const client = await track();
    hello(client);
    await client.until(() => client.hasType("ready"));
    expect(fake.controls[0]).toEqual({ type: "hello", mode: "ptt" });
  });

  test("dado o state do Mark com relatório, então o caminho do relatório não chega ao navegador", async () => {
    const client = await track();
    hello(client, "ptt");
    await client.until(() => client.hasType("state"));
    const state = client.texts.find((t) => t.type === "state") as Dict;
    expect(state.last_report).toEqual({ title: "Relatório", ts: 1 });
    expect(JSON.stringify(client.texts)).not.toContain("/segredo");
  });

  test("dado áudio depois do hello, então o quadro sobe ao Mark e o áudio do Mark volta ao cliente", async () => {
    const client = await track();
    hello(client, "open");
    await client.until(() => client.hasType("ready"));
    client.ws.send(SILENCE_20MS);
    await client.until(() => client.binaries.length === 1);
    expect(fake.frames).toEqual([SILENCE_20MS.byteLength]);
    expect(client.binaries).toEqual([PLAY_24K.byteLength]);
  });

  test("dados ptt e mode, então o painel repassa só os campos conhecidos", async () => {
    const client = await track();
    hello(client, "ptt");
    await client.until(() => client.hasType("ready"));
    client.sendJson({ type: "ptt", down: true, extra: "x" });
    client.sendJson({ type: "mode", mode: "open" });
    client.sendJson({ type: "tipo-novo" });
    await client.until(() => fake.controls.length === 3);
    expect(fake.controls.slice(1)).toEqual([{ type: "ptt", down: true }, { type: "mode", mode: "open" }]);
  });

  test("dado o interrupted do Mark, então o cliente o recebe", async () => {
    const client = await track();
    hello(client, "ptt");
    await client.until(() => client.hasType("ready"));
    for (const socket of fake.sockets) socket.send(JSON.stringify({ type: "interrupted" }));
    await client.until(() => client.hasType("interrupted"));
  });

  test("dado o erro do Mark, então o cliente recebe o código estável do painel com o texto do catálogo e a conexão fecha", async () => {
    const client = await track();
    hello(client, "open");
    await client.until(() => client.hasType("ready"));
    for (const socket of fake.sockets) socket.send(JSON.stringify({ type: "error", code: "idle_timeout" }));
    await client.until(() => client.closed());
    const error = client.texts.find((t) => t.type === "error") as Dict;
    expect(error.code).toBe(VOICE_ERRORS.idleTimeout);
    expect((error.explain as Dict).action).toBe(explain(VOICE_ERRORS.idleTimeout).action);
  });

  test("dado um código de erro que o painel não conhece, então vira mark_voice_failed", async () => {
    const client = await track();
    hello(client, "open");
    await client.until(() => client.hasType("ready"));
    for (const socket of fake.sockets) socket.send(JSON.stringify({ type: "error", code: "codigo-novo" }));
    await client.until(() => client.closed());
    expect((client.texts.find((t) => t.type === "error") as Dict).code).toBe(VOICE_ERRORS.failed);
  });

  test("dada toda a conversa, então o token da ponte nunca aparece no que o navegador recebe", async () => {
    const client = await track();
    hello(client, "open");
    await client.until(() => client.hasType("state"));
    client.ws.send(SILENCE_20MS);
    await client.until(() => client.binaries.length === 1);
    expect(JSON.stringify(client.texts)).not.toContain(TOKEN);
  });
});

describe("voz do Mark pelo painel: um cliente por vez e fechamento conjunto", () => {
  test("dado um cliente com a voz aberta, então o segundo recebe busy e o Mark não vê uma segunda conexão", async () => {
    const first = await track();
    hello(first, "ptt");
    await first.until(() => first.hasType("ready"));
    const second = await track();
    await second.until(() => second.hasType("busy"));
    await second.until(() => second.closed());
    expect((second.texts[0] as Dict).code).toBe(VOICE_ERRORS.busy);
    expect(fake.connections).toBe(1);
    expect(first.closed()).toBe(false);
  });

  test("dado o primeiro cliente que saiu, então a vaga volta e um novo cliente abre", async () => {
    const first = await track();
    hello(first, "ptt");
    await first.until(() => first.hasType("ready"));
    first.ws.close();
    await Bun.sleep(100);
    const again = await track();
    hello(again, "ptt");
    await again.until(() => again.hasType("ready"));
  });

  test("dado o cliente que fecha, então o painel fecha o lado do Mark", async () => {
    const client = await track();
    hello(client, "ptt");
    await client.until(() => client.hasType("ready"));
    client.ws.close();
    await waitFor(() => fake.closedByClient === 1);
    expect(voice.active()).toBe(false);
  });

  test("dado o Mark que fecha, então o painel fecha o cliente", async () => {
    const client = await track();
    hello(client, "ptt");
    await client.until(() => client.hasType("ready"));
    for (const socket of fake.sockets) socket.close(1000);
    await client.until(() => client.closed());
    expect(voice.active()).toBe(false);
  });

  test("dado o bye do cliente, então o Mark o recebe e as duas pontas fecham", async () => {
    const client = await track();
    hello(client, "ptt");
    await client.until(() => client.hasType("ready"));
    client.sendJson({ type: "bye" });
    await client.until(() => client.closed());
    await waitFor(() => fake.closedByClient === 1);
    expect(fake.controls.at(-1)).toEqual({ type: "bye" });
  });

  test("dado o teto de duração, então o painel avisa mark_voice_too_long e fecha os dois lados", async () => {
    maxSessionMs = 150;
    const client = await track();
    hello(client, "open");
    await client.until(() => client.closed());
    expect((client.texts.find((t) => t.type === "error") as Dict).code).toBe(VOICE_ERRORS.tooLong);
    await waitFor(() => fake.closedByClient === 1);
    expect(voice.active()).toBe(false);
  });

  test("dado o desligamento do painel, então a sessão aberta fecha", async () => {
    const client = await track();
    hello(client, "ptt");
    await client.until(() => client.hasType("ready"));
    voice.close();
    await client.until(() => client.closed());
  });
});

describe("voz do Mark pelo painel: tetos na entrada", () => {
  test("dado um quadro acima de 3200 bytes, então frame_too_large e a conexão fecha sem chegar ao Mark", async () => {
    const client = await track();
    hello(client, "open");
    await client.until(() => client.hasType("ready"));
    client.ws.send(new Uint8Array(VOICE_LIMITS.frameBytes + 2));
    await client.until(() => client.closed());
    expect((client.texts.find((t) => t.type === "error") as Dict).code).toBe(VOICE_ERRORS.frameTooLarge);
    expect(fake.frames).toEqual([]);
  });

  test("dado um quadro de tamanho ímpar, então bad_frame", async () => {
    const client = await track();
    hello(client, "open");
    await client.until(() => client.hasType("ready"));
    client.ws.send(new Uint8Array(641));
    await client.until(() => client.closed());
    expect((client.texts.find((t) => t.type === "error") as Dict).code).toBe(VOICE_ERRORS.badFrame);
  });

  test("dado o quadro de exatamente 3200 bytes, então passa", async () => {
    const client = await track();
    hello(client, "open");
    await client.until(() => client.hasType("ready"));
    client.ws.send(new Uint8Array(VOICE_LIMITS.frameBytes));
    await waitFor(() => fake.frames.length === 1);
    expect(client.closed()).toBe(false);
  });

  test("dado áudio antes do hello, então hello_required", async () => {
    const client = await track();
    client.ws.send(SILENCE_20MS);
    await client.until(() => client.closed());
    expect((client.texts.find((t) => t.type === "error") as Dict).code).toBe(VOICE_ERRORS.helloRequired);
  });

  test("dado um controle antes do hello, então hello_required", async () => {
    const client = await track();
    client.sendJson({ type: "ptt", down: true });
    await client.until(() => client.closed());
    expect((client.texts.find((t) => t.type === "error") as Dict).code).toBe(VOICE_ERRORS.helloRequired);
  });

  test("dado um modo inválido no hello, então bad_mode", async () => {
    const client = await track();
    hello(client, "grito");
    await client.until(() => client.closed());
    expect((client.texts.find((t) => t.type === "error") as Dict).code).toBe(VOICE_ERRORS.badMode);
    expect(fake.controls).toEqual([]);
  });

  test("dado texto que não é JSON, então bad_message", async () => {
    const client = await track();
    client.ws.send("{nao é json");
    await client.until(() => client.closed());
    expect((client.texts.find((t) => t.type === "error") as Dict).code).toBe(VOICE_ERRORS.badMessage);
  });
});

describe("voz do Mark pelo painel: Mark fora do ar ou sem voz", () => {
  test("dado o bridge.json ausente, então mark_bridge_missing com o texto do catálogo", async () => {
    rmSync(bridgeFile);
    const client = await track();
    await client.until(() => client.closed());
    const error = client.texts[0] as Dict;
    expect(error.code).toBe(MARK_ERRORS.bridgeMissing);
    expect((error.explain as Dict).title).toBe(explain(MARK_ERRORS.bridgeMissing).title);
    expect((error.explain as Dict).action).toContain("mark");
  });

  test("dada a porta do Mark fechada, então mark_unreachable", async () => {
    writeBridge(1);
    reachableCause = MARK_ERRORS.unreachable;
    const client = await track();
    await client.until(() => client.closed());
    expect((client.texts[0] as Dict).code).toBe(MARK_ERRORS.unreachable);
  });

  test("dado o Mark de pé sem /ws/voice, então mark_voice_unavailable", async () => {
    fake.voiceEnabled = false;
    reachableCause = undefined;
    const client = await track();
    await client.until(() => client.closed());
    expect((client.texts[0] as Dict).code).toBe(VOICE_ERRORS.unavailable);
  });

  test("dado o Mark que não aceita a conexão a tempo, então o painel desiste no timeout e fecha o cliente", async () => {
    fake.hang = true;
    connectMs = 150;
    reachableCause = MARK_ERRORS.unreachable;
    const client = await track();
    await client.until(() => client.closed());
    expect((client.texts[0] as Dict).code).toBe(MARK_ERRORS.unreachable);
    expect(voice.active()).toBe(false);
  });

  test("dado o Mark ocupado com outro cliente de voz, então o cliente recebe busy", async () => {
    fake.held = true;
    const client = await track();
    hello(client, "ptt");
    await client.until(() => client.hasType("busy"));
    await client.until(() => client.closed());
  });
});

describe("voz do Mark pelo painel: guardas do upgrade", () => {
  const FORGED = { "x-forwarded-for": "203.0.113.9", "x-forwarded-host": TUNNEL_HOST };

  test("dada uma Origin de fora, então o upgrade é recusado com 403 antes de abrir", async () => {
    const res = await fetch(`http://127.0.0.1:${panel.port}/api/mark/voice`, { headers: { Upgrade: "websocket", Connection: "Upgrade", Origin: "https://outro.exemplo" } });
    expect(res.status).toBe(403);
    expect(fake.connections).toBe(0);
  });

  test("dado um acesso remoto sem a chave, então 401", async () => {
    const res = await fetch(`http://127.0.0.1:${panel.port}/api/mark/voice`, { headers: { ...FORGED, Upgrade: "websocket", Connection: "Upgrade", Origin: `https://${TUNNEL_HOST}` } });
    expect(res.status).toBe(401);
  });

  test("dado um acesso remoto com a chave e a Origin do túnel, então abre", async () => {
    const client = await track({ ...FORGED, Cookie: REMOTE_COOKIE, Origin: `https://${TUNNEL_HOST}` });
    hello(client, "ptt");
    await client.until(() => client.hasType("ready"));
  });

  test("dado um acesso remoto com a chave mas sem Origin, então 403", async () => {
    const res = await fetch(`http://127.0.0.1:${panel.port}/api/mark/voice`, { headers: { ...FORGED, Cookie: REMOTE_COOKIE, Upgrade: "websocket", Connection: "Upgrade" } });
    expect(res.status).toBe(403);
  });

  test("dado um host que o painel não atende, então 403", async () => {
    const res = await fetch(`http://127.0.0.1:${panel.port}/api/mark/voice`, { headers: { Host: "evil.exemplo", Upgrade: "websocket", Connection: "Upgrade" } });
    expect(res.status).toBe(403);
  });

  test("dado o GET sem upgrade, então devolve a configuração e o texto dos erros do navegador", async () => {
    const res = await fetch(`http://127.0.0.1:${panel.port}/api/mark/voice`);
    const body = (await res.json()) as Dict;
    expect(res.status).toBe(200);
    expect(body.mode).toBe("ptt");
    expect(body.max_s).toBe(60);
    expect(Object.keys(body.explain as Dict).sort()).toEqual([...CLIENT_VOICE_ERRORS].sort());
  });
});

describe("regras puras da voz", () => {
  test("dado o hello, o ptt, o mode e o bye válidos, então vira a mensagem reconstruída", () => {
    expect(checkControl('{"type":"hello","mode":"open"}', false, "ptt")).toEqual({ ok: true, message: { type: "hello", mode: "open" } });
    expect(checkControl('{"type":"ptt","down":false}', true, "ptt")).toEqual({ ok: true, message: { type: "ptt", down: false } });
    expect(checkControl('{"type":"mode","mode":"ptt"}', true, "open")).toEqual({ ok: true, message: { type: "mode", mode: "ptt" } });
    expect(checkControl('{"type":"bye"}', true, "ptt")).toEqual({ ok: true, message: { type: "bye" } });
  });

  test("dados os casos inválidos, então cada um volta com o código certo", () => {
    expect(checkControl('{"type":"ptt","down":1}', true, "ptt")).toEqual({ ok: false, code: VOICE_ERRORS.badMessage });
    expect(checkControl('{"type":"mode","mode":"x"}', true, "ptt")).toEqual({ ok: false, code: VOICE_ERRORS.badMode });
    expect(checkControl("[]", true, "ptt")).toEqual({ ok: false, code: VOICE_ERRORS.badMessage });
    expect(checkControl("x".repeat(VOICE_LIMITS.controlBytes + 1), true, "ptt")).toEqual({ ok: false, code: VOICE_ERRORS.badMessage });
    expect(checkControl('{"type":"bye"}', false, "ptt")).toEqual({ ok: false, code: VOICE_ERRORS.helloRequired });
  });

  test("dado um tipo desconhecido depois do hello, então é ignorado", () => {
    expect(checkControl('{"type":"novo"}', true, "ptt")).toEqual({ ok: true, message: undefined });
  });

  test("dado o teto de taxa, então o quadro 101 na janela recusa e a janela seguinte zera", () => {
    let t = 0;
    const gate = new FrameGate(() => t);
    for (let i = 0; i < VOICE_LIMITS.framesPerSecond; i += 1) expect(gate.check(640)).toBeUndefined();
    expect(gate.check(640)).toBe(VOICE_ERRORS.rateLimit);
    t = 1000;
    expect(gate.check(640)).toBeUndefined();
  });

  test("dado o tamanho, então 3200 passa, 3202 recusa e ímpar recusa", () => {
    const gate = new FrameGate(() => 0);
    expect(gate.check(VOICE_LIMITS.frameBytes)).toBeUndefined();
    expect(gate.check(VOICE_LIMITS.frameBytes + 2)).toBe(VOICE_ERRORS.frameTooLarge);
    expect(gate.check(3)).toBe(VOICE_ERRORS.badFrame);
    expect(gate.check(0)).toBeUndefined();
  });

  test("dado cada código do protocolo do Mark, então mapeia para um código com entrada no catálogo", () => {
    for (const code of ["hello_required", "bad_mode", "bad_message", "frame_too_large", "bad_frame", "rate_limit", "idle_timeout"]) {
      expect(explain(voiceCodeOf(code)).known).toBe(true);
    }
    expect(voiceCodeOf(undefined)).toBe(VOICE_ERRORS.failed);
  });

  test("dado cada código de voz, então tem entrada própria no catálogo", () => {
    expect(Object.values(VOICE_ERRORS).filter((code) => !explain(code).known)).toEqual([]);
  });
});

async function waitFor(done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("tempo esgotado");
    await Bun.sleep(20);
  }
}
