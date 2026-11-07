// Grupo canvas-live: ligação ao vivo da página com o servidor (reference/argos.md §Sincronia automática). O transporte roda sobre
// um stream e um relógio de mentira: religação com recuo depois de o EventSource fechar de vez, conferência de reserva só com a
// aba visível, aviso ilegível ignorado e `stop` sem timer nem ouvinte vivo.
import { describe, expect, test } from "bun:test";
import { backoffMs, createLiveLink, LIVE_BACKOFF, LIVE_POLL, type LiveDeps, type LiveStream } from "../../../src/lib/canvas-live";

const OPEN = 1;
const CLOSED = 2;

class FakeStream implements LiveStream {
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, ((ev: unknown) => void)[]>();
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
  }
  emit(type: string, ev: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  opened(): void {
    this.readyState = OPEN;
    this.emit("open");
  }
}

interface Timer { id: number; at: number; run: () => void }

function harness(over: Partial<LiveDeps> = {}) {
  const streams: FakeStream[] = [];
  const timers = new Map<number, Timer>();
  const calls = { canvas: [] as { id: string; rev: number }[], registry: 0, check: 0, log: [] as string[] };
  let now = 0;
  let nextId = 1;
  let hidden = false;
  let visibility: (() => void) | undefined;
  let checkFails = false;
  const deps: LiveDeps = {
    open: () => {
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
    hidden: () => hidden,
    onVisibility: (fn) => {
      visibility = fn;
      return () => { visibility = undefined; };
    },
    setTimer: (run, ms) => {
      const id = nextId++;
      timers.set(id, { id, at: now + ms, run });
      return id;
    },
    clearTimer: (handle) => { timers.delete(handle as number); },
    random: () => 0.5,
    onCanvas: (n) => calls.canvas.push(n),
    onRegistry: () => { calls.registry += 1; },
    check: () => {
      calls.check += 1;
      return checkFails ? Promise.reject(new Error("rede")) : Promise.resolve();
    },
    log: (m) => calls.log.push(m),
    ...over,
  };
  const advance = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.values()].filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      timers.delete(due.id);
      now = due.at;
      due.run();
    }
    now = until;
  };
  return {
    deps,
    streams,
    calls,
    timers,
    advance,
    setHidden(value: boolean) {
      hidden = value;
      visibility?.();
    },
    failChecks(value: boolean) { checkFails = value; },
    hasVisibilityListener: () => visibility !== undefined,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("canvas-live: recuo da religação", () => {
  test("dado tentativas seguidas, então a espera dobra até o teto", () => {
    const waits = [0, 1, 2, 3, 4, 5, 6, 10].map((n) => backoffMs(n, 0.5));
    expect(waits.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(waits[5]).toBe(LIVE_BACKOFF.capMs);
    expect(waits[7]).toBe(LIVE_BACKOFF.capMs);
  });

  test("dado o sorteio nos extremos, então a espera varia só dentro da faixa de jitter e nunca passa do teto", () => {
    expect(backoffMs(0, 0)).toBe(750);
    expect(backoffMs(0, 1)).toBe(1250);
    expect(backoffMs(9, 1)).toBe(LIVE_BACKOFF.capMs);
  });

  test("dado tentativa negativa, então vale a primeira espera", () => {
    expect(backoffMs(-3, 0.5)).toBe(LIVE_BACKOFF.baseMs);
  });
});

describe("canvas-live: ligação", () => {
  test("dado aviso canvas válido, então a página recebe id e revisão; registry chama onRegistry", () => {
    const h = harness();
    const link = createLiveLink(h.deps);
    link.start();
    h.streams[0]!.opened();
    h.streams[0]!.emit("canvas", { data: JSON.stringify({ id: "default", rev: 7 }) });
    h.streams[0]!.emit("registry");
    expect(h.calls.canvas).toEqual([{ id: "default", rev: 7 }]);
    expect(h.calls.registry).toBe(1);
    expect(link.state()).toBe("open");
    link.stop();
  });

  test.each([
    ["não é JSON", { data: "{ruim" }],
    ["sem revisão", { data: JSON.stringify({ id: "x" }) }],
    ["revisão fracionária", { data: JSON.stringify({ id: "x", rev: 1.5 }) }],
    ["sem data", {}],
    ["valor nulo", { data: "null" }],
  ])("dado aviso ilegível (%s), então é registrado e não chega à página", (_nome, ev) => {
    const h = harness();
    const link = createLiveLink(h.deps);
    link.start();
    h.streams[0]!.emit("canvas", ev);
    expect(h.calls.canvas).toEqual([]);
    expect(h.calls.log).toEqual(["aviso do servidor ilegível"]);
    link.stop();
  });

  test("dado o stream aberto, então confere a revisão ao ligar", async () => {
    const h = harness();
    const link = createLiveLink(h.deps);
    link.start();
    h.streams[0]!.opened();
    await flush();
    expect(h.calls.check).toBe(1);
    link.stop();
  });
});

describe("canvas-live: religação", () => {
  test("dado EventSource fechado de vez, então abre outro depois do recuo e zera as tentativas ao ligar", () => {
    const h = harness();
    const link = createLiveLink(h.deps);
    link.start();
    const first = h.streams[0]!;
    first.readyState = CLOSED;
    first.emit("error");
    expect(link.state()).toBe("down");
    expect(first.closed).toBe(true);
    h.advance(backoffMs(0, 0.5) - 1);
    expect(h.streams).toHaveLength(1);
    h.advance(1);
    expect(h.streams).toHaveLength(2);

    // segunda queda: ainda dentro da mesma sequência, a espera é a da tentativa 1
    h.streams[1]!.readyState = CLOSED;
    h.streams[1]!.emit("error");
    h.advance(backoffMs(1, 0.5));
    expect(h.streams).toHaveLength(3);

    // ligou: a próxima queda volta à primeira espera
    h.streams[2]!.opened();
    h.streams[2]!.readyState = CLOSED;
    h.streams[2]!.emit("error");
    h.advance(backoffMs(0, 0.5));
    expect(h.streams).toHaveLength(4);
    link.stop();
  });

  test("dado erro com o navegador ainda tentando sozinho, então não abre segundo stream", () => {
    const h = harness();
    const link = createLiveLink(h.deps);
    link.start();
    h.streams[0]!.readyState = 0;
    h.streams[0]!.emit("error");
    h.advance(120_000);
    expect(h.streams).toHaveLength(1);
    expect(link.state()).toBe("down");
    link.stop();
  });

  test("dado erro repetido do mesmo stream fechado, então agenda uma religação só", () => {
    const h = harness();
    const link = createLiveLink(h.deps);
    link.start();
    h.streams[0]!.readyState = CLOSED;
    h.streams[0]!.emit("error");
    h.streams[0]!.emit("error");
    h.advance(120_000);
    expect(h.streams).toHaveLength(2);
    link.stop();
  });
});

describe("canvas-live: conferência de reserva", () => {
  test("dado stream fora do ar, então confere a cada 4 s; no ar, a cada 30 s", async () => {
    const h = harness();
    const link = createLiveLink(h.deps);
    link.start();
    h.streams[0]!.readyState = 0;
    h.streams[0]!.emit("error");
    h.advance(LIVE_POLL.downMs);
    await flush();
    expect(h.calls.check).toBe(1);
    h.advance(LIVE_POLL.downMs);
    await flush();
    expect(h.calls.check).toBe(2);

    h.streams[0]!.opened();
    await flush();
    const afterOpen = h.calls.check;
    h.advance(LIVE_POLL.openMs - 1);
    await flush();
    expect(h.calls.check).toBe(afterOpen);
    h.advance(1);
    await flush();
    expect(h.calls.check).toBe(afterOpen + 1);
    link.stop();
  });

  test("dado aba escondida, então nenhum timer fica armado; ao voltar, confere na hora e rearma", async () => {
    const h = harness();
    const link = createLiveLink(h.deps);
    link.start();
    h.streams[0]!.opened();
    await flush();
    h.setHidden(true);
    expect(h.timers.size).toBe(0);
    h.advance(10 * 60_000);
    await flush();
    expect(h.calls.check).toBe(1);

    h.setHidden(false);
    await flush();
    expect(h.calls.check).toBe(2);
    expect(h.timers.size).toBe(1);
    link.stop();
  });

  test("dado conferência que falha, então vai ao log sem derrubar a ligação e a próxima continua agendada", async () => {
    const h = harness();
    const link = createLiveLink(h.deps);
    link.start();
    h.streams[0]!.readyState = 0;
    h.streams[0]!.emit("error");
    h.failChecks(true);
    h.advance(LIVE_POLL.downMs);
    await flush();
    expect(h.calls.log).toEqual(["conferência da revisão falhou: Error"]);
    expect(h.timers.size).toBe(1);
    h.failChecks(false);
    h.advance(LIVE_POLL.downMs);
    await flush();
    expect(h.calls.check).toBe(2);
    link.stop();
  });
});

describe("canvas-live: encerramento", () => {
  test("dado stop, então fecha o stream, cancela os timers, solta a visibilidade e ignora avisos tardios", async () => {
    const h = harness();
    const link = createLiveLink(h.deps);
    link.start();
    const stream = h.streams[0]!;
    stream.readyState = CLOSED;
    stream.emit("error");
    expect(h.timers.size).toBeGreaterThan(0);
    link.stop();
    expect(h.timers.size).toBe(0);
    expect(h.hasVisibilityListener()).toBe(false);
    expect(stream.closed).toBe(true);

    stream.emit("canvas", { data: JSON.stringify({ id: "default", rev: 9 }) });
    stream.emit("registry");
    h.advance(120_000);
    await flush();
    expect(h.calls.canvas).toEqual([]);
    expect(h.calls.registry).toBe(0);
    expect(h.streams).toHaveLength(1);
  });

  test("dado stop antes do open, então o open tardio não confere nem rearma", async () => {
    const h = harness();
    const link = createLiveLink(h.deps);
    link.start();
    const stream = h.streams[0]!;
    link.stop();
    stream.opened();
    await flush();
    expect(h.calls.check).toBe(0);
    expect(h.timers.size).toBe(0);
  });

  test("dado start chamado duas vezes, então abre um stream só", () => {
    const h = harness();
    const link = createLiveLink(h.deps);
    link.start();
    link.start();
    expect(h.streams).toHaveLength(1);
    link.stop();
  });
});
