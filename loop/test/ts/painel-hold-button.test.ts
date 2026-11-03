// Hold Button (kit/panel/ui/fx/hold-button.tsx): a máquina de estados do gesto roda aqui com relógio, quadros e timers simulados,
// sem DOM; o visual (preenchimento, crista, brilho) se confere por captura.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Phase = "idle" | "holding" | "done";
type Controller = { start(k: "pointer" | "key"): boolean; release(): void; cancel(): void; active(): string | null; dispose(): void };
type Fx = {
  createController(timing: () => unknown, env: unknown, out: unknown): Controller;
  frontPolygon(p: number, w: number, h: number, dir: "right" | "up", amp: number, phase: number): string;
  holdSeconds(ms: number): string;
};

const SRC = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/fx/hold-button.tsx"), "utf8");
const JS = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react" } } }).transformSync(SRC);

function carrega(): Fx {
  const win: { HadesFx?: { HoldButton: Fx } } = {};
  new Function("React", "window", JS)({}, win);
  return win.HadesFx!.HoldButton;
}
const fx = carrega();

type Timing = { holdTime: number; releaseTime: number; resetAfter: number; disabled: boolean };

function bancada(over: Partial<Timing> = {}, dropFrames = false) {
  const timing: Timing = { holdTime: 1000, releaseTime: 200, resetAfter: 500, disabled: false, ...over };
  let clock = 0;
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { at: number; cb: () => void }>();
  const env = {
    now: () => clock,
    raf: (cb: () => void) => { const id = nextId++; frames.set(id, cb); return id; },
    caf: (id: number) => { frames.delete(id); },
    after: (cb: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: clock + ms, cb }); return id; },
    clear: (id: number) => { timers.delete(id); },
  };
  const log = { holds: 0, taps: 0, phases: [] as Phase[], progress: 0 };
  const ctl = fx.createController(() => timing, env, {
    progress: (p: number) => { log.progress = p; },
    phase: (p: Phase) => { log.phases.push(p); },
    hold: () => { log.holds++; },
    tap: () => { log.taps++; },
  });
  // avança o relógio em passos de 16 ms, disparando quadros e timers vencidos
  const advance = (ms: number) => {
    const end = clock + ms;
    while (clock < end) {
      clock = Math.min(end, clock + 16);
      for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.cb(); }
      const pending = [...frames];
      frames.clear();
      if (!dropFrames) for (const [, cb] of pending) cb();
    }
  };
  return { ctl, advance, log, timing, framesPendentes: () => frames.size };
}

describe("hold button, gesto", () => {
  test("dado o gesto segurado por holdTime, então onHold dispara uma vez e o estado vira feito", () => {
    const b = bancada();
    expect(b.ctl.start("pointer")).toBe(true);
    b.advance(1100);
    expect(b.log.holds).toBe(1);
    expect(b.log.progress).toBe(1);
    expect(b.log.phases.at(-1)).toBe("done");
    b.ctl.release();
    expect(b.log.taps).toBe(0);
  });

  test("dado o avanço, então o preenchimento é linear no tempo", () => {
    const b = bancada();
    b.ctl.start("pointer");
    b.advance(500);
    expect(b.log.progress).toBeGreaterThan(0.45);
    expect(b.log.progress).toBeLessThan(0.55);
  });

  test("dado soltar aos 100 ms, então chama onTap e não conclui", () => {
    const b = bancada();
    b.ctl.start("pointer");
    b.advance(100);
    b.ctl.release();
    b.advance(2000);
    expect(b.log.taps).toBe(1);
    expect(b.log.holds).toBe(0);
  });

  test("dado soltar aos 600 ms, então não chama onTap nem onHold e o preenchimento recua a zero", () => {
    const b = bancada();
    b.ctl.start("pointer");
    b.advance(600);
    b.ctl.release();
    b.advance(400);
    expect(b.log.taps + b.log.holds).toBe(0);
    expect(b.log.progress).toBe(0);
    expect(b.log.phases.at(-1)).toBe("idle");
  });

  test("dado cancelar aos 100 ms, então não chama onTap", () => {
    const b = bancada();
    b.ctl.start("key");
    b.advance(100);
    b.ctl.cancel();
    expect(b.log.taps).toBe(0);
    expect(b.ctl.active()).toBeNull();
  });

  test("dado o retorno, então a saída é cúbica: rápida no começo e lenta no fim", () => {
    const b = bancada({ releaseTime: 160 });
    b.ctl.start("pointer");
    b.advance(500);
    b.ctl.cancel();
    const de = b.log.progress;
    b.advance(32);
    expect(b.log.progress).toBeLessThan(de * 0.8);
    b.advance(200);
    expect(b.log.progress).toBe(0);
  });

  test("dado o quadro de animação que nunca chega, então o relógio de reserva conclui em holdTime + 100 ms", () => {
    const b = bancada({}, true);
    b.ctl.start("pointer");
    b.advance(1000);
    expect(b.log.holds).toBe(0);
    b.advance(160);
    expect(b.log.holds).toBe(1);
  });

  test("dado desabilitado, então nenhum gesto começa", () => {
    const b = bancada({ disabled: true });
    expect(b.ctl.start("pointer")).toBe(false);
    expect(b.ctl.start("key")).toBe(false);
    b.advance(2000);
    expect(b.log.phases).toEqual([]);
  });

  test("dado um gesto em curso, então um segundo não começa; dado feito, então gestos novos são ignorados", () => {
    const b = bancada({ resetAfter: 0 });
    expect(b.ctl.start("pointer")).toBe(true);
    expect(b.ctl.start("key")).toBe(false);
    b.advance(1100);
    expect(b.ctl.start("pointer")).toBe(false);
    b.advance(5000);
    expect(b.log.phases.at(-1)).toBe("done");
  });

  test("dado resetAfter positivo, então volta a repouso depois dele e o preenchimento recua", () => {
    const b = bancada({ resetAfter: 300 });
    b.ctl.start("pointer");
    b.advance(1100);
    expect(b.log.phases.at(-1)).toBe("done");
    b.advance(600);
    expect(b.log.phases.at(-1)).toBe("idle");
    expect(b.log.progress).toBe(0);
    expect(b.ctl.start("pointer")).toBe(true);
  });

  test("dado dispose, então não sobra quadro agendado", () => {
    const b = bancada();
    b.ctl.start("pointer");
    b.ctl.dispose();
    expect(b.framesPendentes()).toBe(0);
  });
});

describe("hold button, funções puras", () => {
  test("dado holdTime, então a frase acessível usa uma casa decimal com vírgula e sem casa quando inteiro", () => {
    expect(fx.holdSeconds(1200)).toBe("1,2");
    expect(fx.holdSeconds(2000)).toBe("2");
    expect(fx.holdSeconds(1250)).toBe("1,3");
  });

  test("dado progresso 0 e 1 com onda, então o polígono não deixa sobra visível nas pontas", () => {
    const amp = 6;
    const xs = (css: string) => [...css.matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)].map((m) => Number(m[1]));
    expect(Math.max(...xs(fx.frontPolygon(0, 200, 44, "right", amp, 1.3)))).toBeLessThanOrEqual(1e-9);
    expect(Math.min(...xs(fx.frontPolygon(1, 200, 44, "right", amp, 1.3)))).toBeGreaterThanOrEqual(200 - 1e-9);
  });

  test("dado fillDirection up, então a frente sobe de baixo para cima", () => {
    const ys = (css: string) => [...css.matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)].map((m) => Number(m[2]));
    expect(Math.min(...ys(fx.frontPolygon(0.5, 100, 40, "up", 0, 0)))).toBeCloseTo(20, 6);
  });
});
