// Grupo painel-term: o servidor do terminal do painel (src/panel/term*.ts). PTY de verdade, mas só com `cat`/bash falso:
// nunca o claude nem o herdr reais.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../../../src/panel/auth.ts";
import { panelEnv } from "../../../src/panel/env.ts";
import { startPanel, type Panel } from "../../../src/panel/server.ts";
import { createTerm, type Term, type TermAttachment } from "../../../src/panel/term.ts";
import { createRing } from "../../../src/panel/term-ring.ts";
import { TERM_CLOSE, TERM_CODES, TERM_LIMITS, type TermServerMessage } from "../../../src/panel/term-protocol.ts";

const SKILL = join(import.meta.dir, "../../..");
const T = mkdtempSync(join(tmpdir(), "hades-term-"));
const BIN = join(T, "bin");
const SHELL_BEFORE = process.env.SHELL;
let seq = 0;
const SECRET = "SEGREDO-DIGITADO-9f3a";

const script = (name: string, body: string): string => {
  const path = join(BIN, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
let RAWCAT = "", BASHI = "", SLOW = "", BGCAT = "";
beforeAll(() => {
  mkdirSync(BIN, { recursive: true });
  RAWCAT = script("rawcat", 'stty raw -echo\necho "PID=$$"\nexec cat');
  BASHI = script("bashi", "export PS1=''\nexec bash --norc --noprofile -i");
  SLOW = script("slow", 'stty raw -echo\nprintf one\nsleep 0.5\nprintf two\nsleep 0.5\nprintf three\nexec cat');
  BGCAT = script("bgcat", 'stty raw -echo\nsleep 300 &\necho "BG=$!"\necho "PID=$$"\nexec cat');
});
afterAll(() => {
  if (SHELL_BEFORE === undefined) delete process.env.SHELL; else process.env.SHELL = SHELL_BEFORE;
  rmSync(T, { recursive: true, force: true });
});

// ------------------------------------------------------------------ cliente de WebSocket de teste
interface Client {
  texts: TermServerMessage[];
  bytes: () => Buffer;
  closed: () => { code: number; reason: string } | undefined;
  send: (data: string | Uint8Array) => void;
  until: (ok: () => boolean, what: string) => Promise<void>;
  close: () => void;
}

function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    const texts: TermServerMessage[] = [];
    const chunks: Buffer[] = [];
    let closed: { code: number; reason: string } | undefined;
    const waiters = new Set<() => void>();
    const wake = (): void => { for (const w of [...waiters]) w(); };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") texts.push(JSON.parse(event.data) as TermServerMessage);
      else chunks.push(Buffer.from(event.data as ArrayBuffer));
      wake();
    };
    ws.onclose = (event) => { closed = { code: event.code, reason: event.reason }; wake(); };
    ws.onerror = () => reject(new Error("WebSocket recusado no upgrade"));
    ws.onopen = () => resolve({
      texts, bytes: () => Buffer.concat(chunks), closed: () => closed,
      send: (data) => ws.send(data),
      close: () => ws.close(),
      until: (ok, what) => new Promise((res, rej) => {
        const timer = setTimeout(() => { waiters.delete(check); rej(new Error(`tempo esgotado esperando ${what}`)); }, 8000);
        const check = (): void => { if (ok()) { clearTimeout(timer); waiters.delete(check); res(); } };
        waiters.add(check);
        check();
      }),
    });
  });
}

// ------------------------------------------------------------------ painel de teste
interface Rig { panel: Panel; base: string; D: string; wt: string; token: string; pub: string; cookie: string; opener: string }

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  void probe.stop(true);
  return port;
}

async function startRig(): Promise<Rig> {
  const root = join(T, `rig${seq++}`);
  const wt = join(root, "proj");
  const D = join(root, "proj-data");
  mkdirSync(join(wt), { recursive: true });
  mkdirSync(join(D, "panel"), { recursive: true });
  copyFileSync(join(SKILL, "kit/config.tsv"), join(D, "config.tsv"));
  writeFileSync(join(D, "env.sh"), `W="${wt}"\n`);
  const pub = "term-teste.devtunnels.example";
  writeFileSync(join(D, "panel-tunnel.url"), `https://${pub}\n`);
  writeFileSync(join(D, "panel", "remote.key"), "chave-de-teste\n");
  const panel = await startPanel(D, await freePort());
  const base = `http://127.0.0.1:${panel.port}`;
  const env = panelEnv(D);
  const cookie = `${env.cookie}=${createAuth(env).sessionValue("chave-de-teste")}`;
  return { panel, base, D, wt, token: panel.token, pub, cookie, opener: `https://${pub}` };
}

const local = (rig: Rig): Record<string, string> => ({ "x-panel-token": rig.token, "content-type": "application/json", origin: rig.base });
const remote = (rig: Rig): Record<string, string> => ({
  "x-panel-token": rig.token, "content-type": "application/json", origin: rig.opener, "x-forwarded-for": "203.0.113.9", "x-forwarded-host": rig.pub, cookie: rig.cookie,
});
const post = (rig: Rig, path: string, headers: Record<string, string>, body: unknown): Promise<Response> =>
  fetch(`${rig.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const setConfig = async (rig: Rig, values: Record<string, string>): Promise<void> => {
  const r = await post(rig, "/api/config", local(rig), { values });
  expect(r.status).toBe(200);
};
const wsUrl = (rig: Rig, id: string, offset?: number): string => `${rig.base.replace("http", "ws")}/api/term/ws?id=${id}${offset === undefined ? "" : `&offset=${offset}`}`;
const openSession = async (rig: Rig, body: Record<string, unknown> = { kind: "shell" }): Promise<{ id: string; cwd: string; kind: string }> => {
  const r = await post(rig, "/api/term/open", local(rig), body);
  expect(r.status).toBe(200);
  return (await r.json()) as { id: string; cwd: string; kind: string };
};
const upgradeProbe = (rig: Rig, id: string, headers: Record<string, string>): Promise<Response> =>
  fetch(wsUrl(rig, id).replace("ws://", "http://"), {
    headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
  });
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const deadWithin = (pid: number, ms: number): Promise<boolean> => new Promise((resolve) => {
  const started = Date.now();
  const tick = (): void => {
    if (!alive(pid)) return resolve(true);
    if (Date.now() - started > ms) return resolve(false);
    setTimeout(tick, 50);
  };
  tick();
});
const pidFrom = (text: string, tag: string): number => Number.parseInt(new RegExp(`${tag}=(\\d+)`).exec(text)?.[1] ?? "", 10);

// ------------------------------------------------------------------ anel
describe("anel de saída", () => {
  test("dado escrita que passa da capacidade, então guarda a cauda e conta o offset absoluto", () => {
    const ring = createRing(8);
    ring.write(Buffer.from("abcdef"));
    ring.write(Buffer.from("ghij"));
    expect([ring.start, ring.end]).toEqual([2, 10]);
    expect(Buffer.from(ring.read(2, 100)).toString()).toBe("cdefghij");
    expect(Buffer.from(ring.read(6, 2)).toString()).toBe("gh");
  });
  test("dado bloco maior que o anel, então só a cauda fica e o contador anda tudo", () => {
    const ring = createRing(4);
    ring.write(Buffer.from("0123456789"));
    expect([ring.start, ring.end]).toEqual([6, 10]);
    expect(Buffer.from(ring.read(0, 100)).toString()).toBe("6789");
  });
  test("dado offset no fim, então a leitura vem vazia", () => {
    const ring = createRing(4);
    ring.write(Buffer.from("ab"));
    expect(ring.read(2, 10).length).toBe(0);
  });
});

// ------------------------------------------------------------------ gerenciador (sem HTTP)
function memoryAttachment(): TermAttachment & { texts: TermServerMessage[]; bytes: () => string; closes: number[]; backlog: number } {
  const texts: TermServerMessage[] = [];
  const chunks: Buffer[] = [];
  const closes: number[] = [];
  const att = {
    texts, closes, backlog: 0,
    bytes: () => Buffer.concat(chunks).toString(),
    send: (chunk: Uint8Array) => { chunks.push(Buffer.from(chunk)); },
    sendJson: (m: TermServerMessage) => { texts.push(m); },
    buffered: () => att.backlog,
    close: (code: number) => { closes.push(code); },
  };
  return att;
}

describe("gerenciador de sessões", () => {
  const made: Term[] = [];
  afterEach(() => { for (const t of made.splice(0)) t.stop(); });

  function mk(over: { config?: Record<string, string>; command?: (kind: string) => string[]; now?: () => number; notify?: (m: string, s: string) => Promise<void> } = {}): { term: Term; D: string; wt: string } {
    const root = join(T, `m${seq++}`);
    const wt = join(root, "wt");
    const D = join(root, "data");
    mkdirSync(wt, { recursive: true });
    mkdirSync(D, { recursive: true });
    const term = createTerm({
      dataDir: D, defaultCwd: wt, roots: () => [wt, D],
      config: () => ({ HADES_TERMINAL: "1", ...over.config }),
      notify: over.notify ?? (async () => undefined),
      log: () => undefined, now: over.now,
      command: over.command ? (kind) => over.command?.(kind) : undefined,
    });
    made.push(term);
    return { term, D, wt };
  }
  const logOf = (D: string): string => (existsSync(join(D, "logs", "panel-term.log")) ? readFileSync(join(D, "logs", "panel-term.log"), "utf8") : "");

  test("dado a chave desligada, quando abre, então recusa com term_disabled dizendo como ligar", async () => {
    const { term } = mk({ config: { HADES_TERMINAL: "0" } });
    const error = await term.open({ kind: "shell" }, "local").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: TERM_CODES.disabled });
    expect((error as Error).message).toContain("HADES_TERMINAL=1");
  });

  test("dado o teto, quando passa dele, então recusa com term_max_sessions e uma vaga volta ao fechar", async () => {
    const { term } = mk({ config: { HADES_TERMINAL_MAX: "2" }, command: () => ["cat"] });
    const a = await term.open({ kind: "shell" }, "local");
    await term.open({ kind: "shell" }, "local");
    expect(await term.open({ kind: "shell" }, "local").catch((e: unknown) => e)).toMatchObject({ code: TERM_CODES.maxSessions });
    term.close(a.id, "local");
    expect((await term.open({ kind: "shell" }, "local")).kind).toBe("shell");
  });

  test("dado pedido de fora além do ritmo, quando abre muitas vezes, então term_rate_limited com Retry-After", async () => {
    const { term } = mk({ config: { HADES_TERMINAL_MAX: "16" }, command: () => ["cat"] });
    for (let i = 0; i < TERM_LIMITS.opensPerMinute; i++) await term.open({ kind: "shell" }, "remote").then((s) => term.close(s.id, "remote"));
    const error = await term.open({ kind: "shell" }, "remote").catch((e: unknown) => e);
    await term.open({ kind: "shell" }, "local").then((s) => term.close(s.id, "local"));
    expect(error).toMatchObject({ code: TERM_CODES.rateLimited });
    expect((error as { retryAfterS: number }).retryAfterS).toBeGreaterThan(0);
  });

  test("dado cols e rows fora dos limites ou kind desconhecido, então term_bad_request", async () => {
    const { term } = mk({ command: () => ["cat"] });
    for (const body of [{ kind: "shell", cols: 5 }, { kind: "shell", cols: 501 }, { kind: "shell", rows: 4 }, { kind: "shell", rows: 1.5 }, { kind: "rm" }, { kind: "shell", resume: "x" }, {}]) {
      expect(await term.open(body, "local").catch((e: unknown) => e)).toMatchObject({ code: TERM_CODES.badRequest });
    }
    expect(await term.open({ kind: "claude", resume: "a b; rm -rf /" }, "local").catch((e: unknown) => e)).toMatchObject({ code: TERM_CODES.badRequest });
  });

  test("dado sessão parada, quando passa o tempo de inatividade, então expira, mata o processo e registra expirar", async () => {
    let clock = 1_000_000;
    const { term, D } = mk({ config: { HADES_TERMINAL_IDLE_MIN: "5" }, command: () => [RAWCAT], now: () => clock });
    const s = await term.open({ kind: "shell" }, "local");
    const att = memoryAttachment();
    const link = term.attach(s.id, undefined, att, "local");
    await until(() => /PID=\d+/.test(att.bytes()), "o pid do shell");
    const pid = pidFrom(att.bytes(), "PID");
    clock += 4 * 60_000;
    link.input(Buffer.from("x"));
    clock += 4 * 60_000;
    term.sweep();
    expect(term.has(s.id)).toBe(true);
    clock += 2 * 60_000;
    term.sweep();
    expect(term.has(s.id)).toBe(false);
    expect(att.closes).toContain(TERM_CLOSE.expired);
    expect(await deadWithin(pid, 4000)).toBe(true);
    expect(logOf(D)).toContain('"action":"expirar"');
  });

  test("dado IDLE_MIN=0, quando passa muito tempo, então a sessão não expira", async () => {
    let clock = 0;
    const { term } = mk({ config: { HADES_TERMINAL_IDLE_MIN: "0" }, command: () => ["cat"], now: () => clock });
    const s = await term.open({ kind: "shell" }, "local");
    clock += 10 * 24 * 3600_000;
    term.sweep();
    expect(term.has(s.id)).toBe(true);
  });

  test("dado a chave desligada depois de aberta, quando o vigia passa, então fecha as sessões", async () => {
    const config: Record<string, string> = { HADES_TERMINAL: "1" };
    const { term } = mk({ config, command: () => ["cat"] });
    const s = await term.open({ kind: "shell" }, "local");
    config.HADES_TERMINAL = "0";
    term.sweep();
    expect(term.has(s.id)).toBe(false);
  });

  test("dado offset antes do anel, quando retoma, então avisa term_offset_truncated e entrega o que ainda há", async () => {
    const { term } = mk({ config: { HADES_TERMINAL_SCROLLBACK_KB: "1" }, command: () => ["bash", "-c", "head -c 3000 /dev/zero | tr '\\0' a; printf FIM; sleep 30"] });
    const s = await term.open({ kind: "shell" }, "local");
    const probe = memoryAttachment();
    term.attach(s.id, undefined, probe, "local");
    await until(() => probe.bytes().includes("FIM"), "o fim da saída");
    const att = memoryAttachment();
    term.attach(s.id, 0, att, "local");
    const hello = att.texts[0];
    expect(hello).toMatchObject({ t: "hello", offset: 3003 - 1024, start: 3003 - 1024, end: 3003 });
    expect(att.texts[1]).toMatchObject({ t: "warn", code: TERM_CODES.offsetTruncated, requested: 0, lost: 3003 - 1024 });
    expect(att.bytes().length).toBe(1024);
    expect(att.bytes().endsWith("FIM")).toBe(true);
  });

  test("dado offset à frente do fim, quando retoma, então avisa term_offset_ahead e segue do fim", async () => {
    const { term } = mk({ command: () => ["cat"] });
    const s = await term.open({ kind: "shell" }, "local");
    const att = memoryAttachment();
    term.attach(s.id, 999_999, att, "local");
    expect(att.texts[1]).toMatchObject({ t: "warn", code: TERM_CODES.offsetAhead, requested: 999_999 });
    expect(att.texts[0]).toMatchObject({ t: "hello", offset: 0, end: 0 });
  });

  test("dado cliente lento, quando a fila do socket enche, então espera o drain e entrega do anel sem perder byte", async () => {
    const { term } = mk({ command: () => ["bash", "-c", "head -c 200000 /dev/zero | tr '\\0' z; sleep 30"] });
    const s = await term.open({ kind: "shell" }, "local");
    const att = memoryAttachment();
    att.backlog = TERM_LIMITS.sendHighWater;
    const link = term.attach(s.id, undefined, att, "local");
    await Bun.sleep(300);
    expect(att.bytes().length).toBe(0);
    att.backlog = 0;
    link.drain();
    await until(() => att.bytes().length === 200000, "os 200000 bytes depois do drain");
    expect(att.bytes()).toBe("z".repeat(200000));
  });

  test("dado segundo cliente na mesma sessão, quando anexa, então o primeiro é fechado com 4001", async () => {
    const { term } = mk({ command: () => ["cat"] });
    const s = await term.open({ kind: "shell" }, "local");
    const first = memoryAttachment();
    const second = memoryAttachment();
    term.attach(s.id, undefined, first, "local");
    term.attach(s.id, undefined, second, "local");
    expect(first.closes).toEqual([TERM_CLOSE.replaced]);
  });

  test("dado mensagem de controle inválida ou desconhecida, então avisa term_bad_message e a sessão segue", async () => {
    const { term } = mk({ command: () => ["cat"] });
    const s = await term.open({ kind: "shell" }, "local");
    const att = memoryAttachment();
    const link = term.attach(s.id, undefined, att, "local");
    for (const text of ["{nao-json", "[1]", '{"t":"explode"}', '{"t":"resize","cols":9999,"rows":24}', `{"t":"ping","x":"${"a".repeat(TERM_LIMITS.controlBytes)}"}`]) link.control(text);
    expect(att.texts.filter((m) => m.t === "warn" && m.code === TERM_CODES.badMessage).length).toBe(5);
    link.control('{"t":"ping"}');
    expect(att.texts.at(-1)).toEqual({ t: "pong" });
    expect(term.has(s.id)).toBe(true);
  });

  test("dado entrada acima do limite por mensagem, então não chega ao processo e avisa", async () => {
    const { term } = mk({ command: () => ["cat"] });
    const s = await term.open({ kind: "shell" }, "local");
    const att = memoryAttachment();
    const link = term.attach(s.id, undefined, att, "local");
    link.input(new Uint8Array(TERM_LIMITS.inputBytes + 1));
    expect(att.texts.at(-1)).toMatchObject({ t: "warn", code: TERM_CODES.badMessage });
  });

  test("dado sessão aberta de fora, então avisa o dono com tipo, pasta e hora, sem conteúdo; a local não avisa", async () => {
    const sent: { message: string; state: string }[] = [];
    const { term, wt } = mk({ command: () => ["cat"], notify: async (message, state) => { sent.push({ message, state }); } });
    await term.open({ kind: "shell" }, "local");
    expect(sent.length).toBe(0);
    await term.open({ kind: "shell" }, "remote");
    expect(sent.length).toBe(1);
    expect(sent[0]?.message).toContain("shell");
    expect(sent[0]?.message).toContain(wt);
    expect(sent[0]?.message).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/);
  });

  test("dado sessão aberta no local e anexada pelo remoto, então avisa uma vez por sessão e registra 'anexar' com a origem", async () => {
    const sent: { message: string; state: string }[] = [];
    const { term, D, wt } = mk({ command: () => ["cat"], notify: async (message, state) => { sent.push({ message, state }); } });
    const s = await term.open({ kind: "shell" }, "local");
    term.attach(s.id, undefined, memoryAttachment(), "local");
    expect(sent.length).toBe(0);
    term.attach(s.id, undefined, memoryAttachment(), "remote");
    expect(sent.length).toBe(1);
    expect(sent[0]?.message).toContain("shell");
    expect(sent[0]?.message).toContain(wt);
    expect(sent[0]?.message).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/);
    term.attach(s.id, undefined, memoryAttachment(), "remote");
    expect(sent.length).toBe(1);
    const other = await term.open({ kind: "shell" }, "local");
    term.attach(other.id, undefined, memoryAttachment(), "remote");
    expect(sent.length).toBe(2);
    const lines = readFileSync(join(D, "logs", "panel-term.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, string>);
    expect(lines.filter((l) => l.action === "anexar" && l.id === s.id).map((l) => l.origin)).toEqual(["local", "remote", "remote"]);
    expect(sent.map((x) => x.message).join()).not.toContain("anexar");
  });

  test("dado sessão aberta de fora e anexada pelo remoto, então não repete o aviso da abertura", async () => {
    const sent: string[] = [];
    const { term } = mk({ command: () => ["cat"], notify: async (message) => { sent.push(message); } });
    const s = await term.open({ kind: "shell" }, "remote");
    term.attach(s.id, undefined, memoryAttachment(), "remote");
    expect(sent.length).toBe(1);
  });

  test("dado uso com texto digitado e impresso, então o log tem ação, tipo, pasta, origem e id e nunca o conteúdo", async () => {
    const { term, D, wt } = mk({ command: () => [RAWCAT] });
    const s = await term.open({ kind: "shell" }, "remote");
    const att = memoryAttachment();
    const link = term.attach(s.id, undefined, att, "remote");
    link.input(Buffer.from(SECRET));
    await until(() => att.bytes().includes(SECRET), "o eco do texto digitado");
    await term.open({ kind: "shell", cwd: "/etc" }, "remote").catch(() => undefined);
    term.close(s.id, "remote");
    const log = logOf(D);
    expect(log).not.toContain(SECRET);
    const lines = log.trim().split("\n").map((l) => JSON.parse(l) as Record<string, string>);
    expect(lines.map((l) => l.action)).toEqual(["abrir", "anexar", "recusar", "fechar"]);
    expect(lines[0]).toMatchObject({ kind: "shell", cwd: wt, origin: "remote", id: s.id });
    expect(lines[1]).toMatchObject({ action: "anexar", kind: "shell", cwd: wt, origin: "remote", id: s.id });
    expect(lines[2]).toMatchObject({ code: TERM_CODES.forbiddenCwd });
    expect(lines.every((l) => typeof l.t === "string" && l.t.endsWith("Z"))).toBe(true);
  });

  test("dado fechar, então o grupo inteiro morre, inclusive o job em segundo plano", async () => {
    const { term } = mk({ command: () => [BGCAT] });
    const s = await term.open({ kind: "shell" }, "local");
    const att = memoryAttachment();
    term.attach(s.id, undefined, att, "local");
    await until(() => /BG=\d+/.test(att.bytes()) && /PID=\d+/.test(att.bytes()), "os pids");
    const [pid, bg] = [pidFrom(att.bytes(), "PID"), pidFrom(att.bytes(), "BG")];
    expect(alive(pid) && alive(bg)).toBe(true);
    term.close(s.id, "local");
    expect(await deadWithin(pid, 4000)).toBe(true);
    expect(await deadWithin(bg, 4000)).toBe(true);
  });

  test("dado o processo que sai sozinho, então o cliente recebe o fim da saída, depois exit, e a sessão fica como encerrada", async () => {
    const { term } = mk({ command: () => ["bash", "-c", "printf bye; exit 3"] });
    const s = await term.open({ kind: "shell" }, "local");
    await until(() => term.list().sessions.find((x) => x.id === s.id)?.state === "exited", "o fim do processo");
    const att = memoryAttachment();
    term.attach(s.id, undefined, att, "local");
    expect(att.bytes()).toBe("bye");
    expect(att.texts.at(-1)).toEqual({ t: "exit", code: 3, signal: null });
    expect(att.closes).toEqual([TERM_CLOSE.exited]);
    expect(term.list().active).toBe(0);
  });

  test("dado stop do gerenciador, então todas as sessões morrem e os clientes recebem 4004", async () => {
    const { term } = mk({ command: () => [RAWCAT] });
    const s = await term.open({ kind: "shell" }, "local");
    const att = memoryAttachment();
    term.attach(s.id, undefined, att, "local");
    await until(() => /PID=\d+/.test(att.bytes()), "o pid");
    const pid = pidFrom(att.bytes(), "PID");
    term.stop();
    expect(att.closes).toEqual([TERM_CLOSE.shutdown]);
    expect(await deadWithin(pid, 4000)).toBe(true);
  });
});

async function until(ok: () => boolean, what: string, ms = 8000): Promise<void> {
  const started = Date.now();
  while (!ok()) {
    if (Date.now() - started > ms) throw new Error(`tempo esgotado esperando ${what}`);
    await Bun.sleep(25);
  }
}

// ------------------------------------------------------------------ painel de verdade (HTTP + WebSocket)
describe("painel: rotas e WebSocket do terminal", () => {
  let rig: Rig;
  beforeAll(async () => { rig = await startRig(); });
  afterAll(() => { rig.panel.stop(); });
  afterEach(() => { process.env.SHELL = SHELL_BEFORE ?? "/bin/sh"; });

  test("dado a chave desligada (padrão), então abrir sessão e abrir o WebSocket recusam dizendo como ligar", async () => {
    const r = await post(rig, "/api/term/open", local(rig), { kind: "shell" });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { code: string; error: string };
    expect(body.code).toBe(TERM_CODES.disabled);
    expect(body.error).toContain("HADES_TERMINAL=1");
    const ws = await upgradeProbe(rig, "0".repeat(32), { origin: rig.base });
    expect(ws.status).toBe(403);
    expect(((await ws.json()) as { code: string }).code).toBe(TERM_CODES.disabled);
    const list = (await (await fetch(`${rig.base}/api/term`)).json()) as { enabled: boolean; sessions: unknown[] };
    expect(list.enabled).toBe(false);
  });

  test("dado o acesso remoto, quando tenta ligar a chave ou mudar os limites, então a gravação é recusada e a chave segue desligada", async () => {
    for (const values of [{ HADES_TERMINAL: "1" }, { HADES_TERMINAL_MAX: "16" }, { HADES_TERMINAL_IDLE_MIN: "0" }, { HADES_TERMINAL_SCROLLBACK_KB: "8192" }]) {
      const r = await post(rig, "/api/config", remote(rig), { values });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain("painel local");
    }
    const r = await post(rig, "/api/term/open", local(rig), { kind: "shell" });
    expect(r.status).toBe(403);
  });

  test("dado o painel local, quando liga a chave, então abre sessão e o pedido de fora também passa (com a chave de acesso)", async () => {
    await setConfig(rig, { HADES_TERMINAL: "1" });
    process.env.SHELL = RAWCAT;
    const r = await post(rig, "/api/term/open", remote(rig), { kind: "shell" });
    expect(r.status).toBe(200);
    const sem = await post(rig, "/api/term/open", { ...remote(rig), cookie: "" }, { kind: "shell" });
    expect(sem.status).toBe(401);
    const s = (await r.json()) as { id: string; origin: string };
    expect(s.origin).toBe("remote");
    await post(rig, "/api/term/close", local(rig), { id: s.id });
  });

  test("dado entrada binária e UTF-8 partido entre quadros, quando o terminal devolve, então os bytes voltam idênticos", async () => {
    process.env.SHELL = RAWCAT;
    const s = await openSession(rig);
    const c = await connect(wsUrl(rig, s.id), { origin: rig.base });
    await c.until(() => c.bytes().toString().includes("PID="), "o pid");
    const marker = c.bytes().length;
    const all = new Uint8Array(256).map((_, i) => i);
    c.send(all);
    c.send(new Uint8Array([0xc3]));
    c.send(new Uint8Array([0xa9]));
    c.send(Buffer.from("\x1b[200~colado\x1b[201~"));
    const expected = Buffer.concat([Buffer.from(all), Buffer.from("é"), Buffer.from("\x1b[200~colado\x1b[201~")]);
    await c.until(() => c.bytes().length - marker >= expected.length, "o eco binário");
    expect(c.bytes().subarray(marker, marker + expected.length).equals(expected)).toBe(true);
    expect(Buffer.from("é").toString("hex")).toBe("c3a9");
    c.close();
    await post(rig, "/api/term/close", local(rig), { id: s.id });
  });

  test("dado resize, então o processo vê o novo tamanho", async () => {
    process.env.SHELL = BASHI;
    const s = await openSession(rig, { kind: "shell", cols: 100, rows: 30 });
    const c = await connect(wsUrl(rig, s.id), { origin: rig.base });
    expect(c.texts[0] ?? await (async () => { await c.until(() => c.texts.length > 0, "o hello"); return c.texts[0]; })()).toMatchObject({ t: "hello", v: 1, cols: 100, rows: 30, kind: "shell" });
    c.send(Buffer.from("tput cols; echo ---\n"));
    await c.until(() => /(^|\r|\n)100\r?\n/.test(c.bytes().toString()), "tput cols = 100");
    c.send(JSON.stringify({ t: "resize", cols: 57, rows: 20 }));
    c.send(Buffer.from("tput cols; tput lines; echo ---\n"));
    await c.until(() => /(^|\r|\n)57\r?\n20\r?\n---/.test(c.bytes().toString()), "tput cols = 57");
    c.close();
    await post(rig, "/api/term/close", local(rig), { id: s.id });
  });

  test("dado desconexão no meio, quando retoma pelo offset, então recebe só o que faltava, sem perder nem repetir", async () => {
    process.env.SHELL = SLOW;
    const s = await openSession(rig);
    const first = await connect(wsUrl(rig, s.id), { origin: rig.base });
    await first.until(() => first.bytes().toString().includes("one"), "one");
    await first.until(() => first.texts.length > 0, "o hello");
    const hello = first.texts[0] as Extract<TermServerMessage, { t: "hello" }>;
    const offset = hello.offset + first.bytes().length;
    first.close();
    await first.until(() => first.closed() !== undefined, "o fechamento");
    const second = await connect(wsUrl(rig, s.id, offset), { origin: rig.base });
    await second.until(() => second.bytes().toString().includes("three"), "three");
    expect(second.bytes().toString()).toBe("twothree");
    expect(second.texts[0]).toMatchObject({ t: "hello", offset });
    second.close();
    await post(rig, "/api/term/close", local(rig), { id: s.id });
  });

  test("dado frame de entrada maior que o limite, então o servidor derruba o socket e a sessão continua", async () => {
    process.env.SHELL = RAWCAT;
    const s = await openSession(rig);
    const c = await connect(wsUrl(rig, s.id), { origin: rig.base });
    c.send(new Uint8Array(TERM_LIMITS.inputBytes + 1024));
    await c.until(() => c.closed() !== undefined, "o fechamento por tamanho");
    expect(c.closed()).toBeDefined();
    const list = (await (await fetch(`${rig.base}/api/term`)).json()) as { sessions: { id: string }[] };
    expect(list.sessions.some((x) => x.id === s.id)).toBe(true);
    await post(rig, "/api/term/close", local(rig), { id: s.id });
  });

  test("dado pasta fora da lista (absoluta, com .., por symlink ou relativa), então recusa com term_forbidden_cwd", async () => {
    symlinkSync("/etc", join(rig.wt, "atalho"));
    for (const cwd of ["/etc", `${rig.wt}/../..`, `${rig.wt}/atalho`, "/proc/1"]) {
      const r = await post(rig, "/api/term/open", local(rig), { kind: "shell", cwd });
      expect([cwd, r.status, ((await r.json()) as { code: string }).code]).toEqual([cwd, 403, TERM_CODES.forbiddenCwd]);
    }
    const rel = await post(rig, "/api/term/open", local(rig), { kind: "shell", cwd: "proj" });
    expect(rel.status).toBe(400);
  });

  test("dado pasta dentro da lista (clone e $D), então abre e a sessão mostra a pasta já resolvida", async () => {
    process.env.SHELL = RAWCAT;
    for (const cwd of [rig.wt, rig.D]) {
      const s = await openSession(rig, { kind: "shell", cwd });
      expect(s.cwd).toBe(cwd);
      await post(rig, "/api/term/close", local(rig), { id: s.id });
    }
  });

  test("dado o WebSocket pelo túnel, então sem cookie é 401, com Origin estranho é 403 e com cookie e Origin do túnel abre", async () => {
    process.env.SHELL = RAWCAT;
    const s = await openSession(rig);
    const viaTunnel = { "x-forwarded-for": "203.0.113.9", "x-forwarded-host": rig.pub };
    expect((await upgradeProbe(rig, s.id, { ...viaTunnel, origin: rig.opener })).status).toBe(401);
    const strange = await upgradeProbe(rig, s.id, { ...viaTunnel, cookie: rig.cookie, origin: "https://evil.example" });
    expect(strange.status).toBe(403);
    expect(((await strange.json()) as { code: string }).code).toBe(TERM_CODES.origin);
    expect((await upgradeProbe(rig, s.id, { ...viaTunnel, cookie: rig.cookie })).status).toBe(403);
    expect((await upgradeProbe(rig, s.id, { ...viaTunnel, cookie: "x=y", origin: rig.opener })).status).toBe(401);
    const c = await connect(wsUrl(rig, s.id), { ...viaTunnel, cookie: rig.cookie, origin: rig.opener });
    await c.until(() => c.texts.length > 0, "o hello");
    c.close();
    await post(rig, "/api/term/close", local(rig), { id: s.id });
  });

  test("dado o WebSocket no painel local, então Origin de outro site é 403, Host estranho é 403 e sem Origin (cliente de script) abre", async () => {
    process.env.SHELL = RAWCAT;
    const s = await openSession(rig);
    expect((await upgradeProbe(rig, s.id, { origin: "https://evil.example" })).status).toBe(403);
    expect((await upgradeProbe(rig, s.id, { origin: `http://127.0.0.1:${rig.panel.port + 1}` })).status).toBe(403);
    expect((await upgradeProbe(rig, s.id, { origin: rig.base, "x-forwarded-host": "evil.example", "x-forwarded-for": "1.1.1.1" })).status).toBe(403);
    const c = await connect(wsUrl(rig, s.id));
    await c.until(() => c.texts.length > 0, "o hello");
    c.close();
    await post(rig, "/api/term/close", local(rig), { id: s.id });
  });

  test("dado id inexistente ou malformado e offset inválido, então 404/400 com código estável", async () => {
    expect(((await (await upgradeProbe(rig, "f".repeat(32), { origin: rig.base })).json()) as { code: string }).code).toBe(TERM_CODES.unknownSession);
    expect(((await (await upgradeProbe(rig, "../etc", { origin: rig.base })).json()) as { code: string }).code).toBe(TERM_CODES.unknownSession);
    process.env.SHELL = RAWCAT;
    const s = await openSession(rig);
    const r = await fetch(`${wsUrl(rig, s.id, 0).replace("ws://", "http://")}x`, { headers: { connection: "Upgrade", upgrade: "websocket", origin: rig.base } });
    expect(r.status).toBe(400);
    const closed = await post(rig, "/api/term/close", local(rig), { id: "f".repeat(32) });
    expect(closed.status).toBe(404);
    await post(rig, "/api/term/close", local(rig), { id: s.id });
  });

  test("dado POST sem o token do painel, então 403, e a listagem exige a chave pelo túnel", async () => {
    const semToken = await post(rig, "/api/term/open", { "content-type": "application/json", origin: rig.base }, { kind: "shell" });
    expect(semToken.status).toBe(403);
    const lista = await fetch(`${rig.base}/api/term`, { headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-host": rig.pub } });
    expect(lista.status).toBe(401);
  });

  test("dado a lista de sessões, então traz tipo, pasta, início, último uso e origem, sem conteúdo", async () => {
    process.env.SHELL = RAWCAT;
    const s = await openSession(rig);
    const c = await connect(wsUrl(rig, s.id), { origin: rig.base });
    c.send(Buffer.from(SECRET));
    await c.until(() => c.bytes().toString().includes(SECRET), "o eco");
    const text = await (await fetch(`${rig.base}/api/term`)).text();
    expect(text).not.toContain(SECRET);
    const list = JSON.parse(text) as { sessions: Record<string, unknown>[] };
    const mine = list.sessions.find((x) => x.id === s.id);
    expect(mine).toMatchObject({ kind: "shell", cwd: rig.wt, origin: "local", state: "running", attached: true });
    expect(Object.keys(mine ?? {}).sort()).toEqual(["attached", "cols", "cwd", "id", "kind", "lastUsedAt", "origin", "rows", "startedAt", "state"]);
    c.close();
    await post(rig, "/api/term/close", local(rig), { id: s.id });
  });

  test("dado o filho do PTY, então roda no mesmo cgroup do painel (a unit do painel o leva junto)", async () => {
    process.env.SHELL = RAWCAT;
    const s = await openSession(rig);
    const c = await connect(wsUrl(rig, s.id), { origin: rig.base });
    await c.until(() => /PID=\d+/.test(c.bytes().toString()), "o pid");
    const pid = pidFrom(c.bytes().toString(), "PID");
    expect(readFileSync(`/proc/${pid}/cgroup`, "utf8")).toBe(readFileSync("/proc/self/cgroup", "utf8"));
    c.close();
    await post(rig, "/api/term/close", local(rig), { id: s.id });
  });

  test("dado o log do painel, então tem abrir, anexar, recusar e fechar sem nenhum conteúdo digitado", async () => {
    const log = readFileSync(join(rig.D, "logs", "panel-term.log"), "utf8");
    expect(log).not.toContain(SECRET);
    const actions = new Set(log.trim().split("\n").map((l) => (JSON.parse(l) as { action: string }).action));
    expect([...actions].sort()).toEqual(["abrir", "anexar", "fechar", "recusar"]);
  });

  test("dado desligar a chave pelo painel local, então abrir nova sessão passa a recusar", async () => {
    process.env.SHELL = RAWCAT;
    const s = await openSession(rig);
    const c = await connect(wsUrl(rig, s.id), { origin: rig.base });
    await c.until(() => c.texts.length > 0, "o hello");
    await setConfig(rig, { HADES_TERMINAL: "0" });
    const r = await post(rig, "/api/term/open", local(rig), { kind: "shell" });
    expect(r.status).toBe(403);
    c.close();
  });
});
