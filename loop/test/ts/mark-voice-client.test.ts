// Grupo mark-voice-client: o lado do navegador da voz do Mark — reamostragem 48→16 kHz do worklet de captura, fila de jitter do worklet de
// reprodução, protocolo de segurar-para-falar (voice-logic.tsx), erro de microfone e carga sob demanda no nó mark. Nenhum áudio real:
// os sinais são senoides sintéticas geradas no teste.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createUiTranspiler } from "../../../src/panel/ui-transpile";

const root = join(import.meta.dir, "../../..");
const ui = join(root, "kit/panel/ui");
const transpiler = createUiTranspiler();

interface Protocol {
  hello(): void;
  ptt(down: boolean): void;
  setMode(mode: string): void;
  receive(msg: unknown): { kind: string; maxS?: number | null; code?: string };
  canSend(bytes: number): boolean;
  bye(): void;
  readonly mode: string;
  readonly ready: boolean;
}
interface Logic {
  FRAME_BYTES_MAX: number;
  RECONNECT_TRIES: number;
  reconnectMs(n: number): number;
  isFatalCode(code: string): boolean;
  voiceUrl(loc: { protocol: string; host: string }): string;
  micErrorCode(err: unknown, secure: boolean): string;
  explainFor(code: string, served: unknown, texts: unknown): { title: string; cause: string };
  levelOfPcm16(samples: Int16Array): number;
  createVoiceProtocol(send: (o: unknown) => void, mode: string): Protocol;
  isTypingTarget(t: unknown): boolean;
}

const loadLogic = (): Logic => {
  const scope: Record<string, unknown> = {};
  new Function("window", transpiler.transpile(join(ui, "argos/voice-logic.tsx")))(scope);
  return scope.ArgosVoiceLogic as Logic;
};

class FakeProcessor {
  port = { postMessage: (_data: unknown, _transfer?: unknown[]) => undefined as void, onmessage: null as null | ((e: { data: unknown }) => void) };
}

/** Executa um worklet com os globais do AudioWorkletGlobalScope falsos e devolve a classe registrada. */
const loadWorklet = (file: string, rate: number): { new (): any } => {
  let registered: { new (): any } | undefined;
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", readFileSync(join(ui, file), "utf8"))(
    FakeProcessor,
    (_name: string, cls: { new (): any }) => { registered = cls; },
    rate,
  );
  if (!registered) throw new Error(`${file} não registrou processador`);
  return registered;
};

const sine = (rate: number, hz: number, seconds: number, amp: number): Float32Array =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

const feed = (proc: any, signal: Float32Array, block = 128): Int16Array[] => {
  const frames: Int16Array[] = [];
  proc.port.postMessage = (buf: ArrayBuffer) => { frames.push(new Int16Array(buf)); };
  for (let at = 0; at < signal.length; at += block) proc.process([[signal.subarray(at, at + block)]]);
  return frames;
};

describe("captura: reamostragem para 16 kHz PCM16", () => {
  test("dado 1 s a 48 kHz, quando reamostra, então saem 16000 amostras em quadros de 30 ms (960 B, par, abaixo do teto)", () => {
    const frames = feed(new (loadWorklet("argos/voice-capture-worklet.js", 48000))(), sine(48000, 440, 1, 0.5));
    expect(frames.length).toBe(Math.floor(16000 / 480));
    for (const f of frames) {
      expect(f.byteLength).toBe(960);
      expect(f.byteLength % 2).toBe(0);
      expect(f.byteLength).toBeLessThanOrEqual(3200);
    }
  });

  test("dado um tom de 440 Hz a 48 kHz com amplitude 0,5, quando reamostra, então o pico fica perto de 16384", () => {
    const frames = feed(new (loadWorklet("argos/voice-capture-worklet.js", 48000))(), sine(48000, 440, 0.5, 0.5));
    const peak = Math.max(...frames.flatMap((f) => [...f].map(Math.abs)));
    expect(peak).toBeGreaterThan(16384 * 0.95);
    expect(peak).toBeLessThanOrEqual(16384 + 64);
  });

  test("dado 44,1 kHz (razão fracionária), quando reamostra, então a contagem acompanha a razão e nada passa de 16 bits", () => {
    const frames = feed(new (loadWorklet("argos/voice-capture-worklet.js", 44100))(), sine(44100, 300, 1, 1.5));
    const total = frames.reduce((n, f) => n + f.length, 0);
    expect(Math.abs(total - 16000)).toBeLessThanOrEqual(480);
    for (const f of frames) for (const x of f) { expect(x).toBeGreaterThanOrEqual(-32768); expect(x).toBeLessThanOrEqual(32767); }
  });

  test("dado silêncio, quando reamostra, então todas as amostras são zero", () => {
    const frames = feed(new (loadWorklet("argos/voice-capture-worklet.js", 48000))(), new Float32Array(48000));
    expect(frames.every((f) => f.every((x) => x === 0))).toBe(true);
  });

  test("dado um tom de 12 kHz acima da banda de 16 kHz, quando reamostra, então a média por janela o atenua", () => {
    const frames = feed(new (loadWorklet("argos/voice-capture-worklet.js", 48000))(), sine(48000, 12000, 0.5, 0.5));
    const peak = Math.max(...frames.flatMap((f) => [...f].map(Math.abs)));
    expect(peak).toBeLessThan(16384 * 0.6);
  });
});

describe("reprodução: fila de jitter de 24 kHz", () => {
  const pcm = (n: number, value: number): ArrayBuffer => new Int16Array(n).fill(value).buffer as ArrayBuffer;
  const pull = (proc: any, n = 128): Float32Array => { const out = new Float32Array(n); proc.process([], [[out]]); return out; };

  test("dado menos que o buffer de jitter (120 ms), quando toca, então sai silêncio até acumular", () => {
    const proc = new (loadWorklet("argos/voice-play-worklet.js", 24000))();
    proc.port.onmessage!({ data: pcm(1000, 16384) });
    expect(pull(proc).every((x) => x === 0)).toBe(true);
    proc.port.onmessage!({ data: pcm(2400, 16384) });
    expect(pull(proc)[0]).toBeCloseTo(0.5, 2);
  });

  test("dado `clear` (interrupted), quando toca, então a fila esvazia e volta o silêncio", () => {
    const proc = new (loadWorklet("argos/voice-play-worklet.js", 24000))();
    proc.port.onmessage!({ data: pcm(4800, 16384) });
    expect(pull(proc)[0]).toBeCloseTo(0.5, 2);
    proc.port.onmessage!({ data: { clear: true } });
    expect(pull(proc).every((x) => x === 0)).toBe(true);
  });

  test("dado o contexto a 48 kHz, quando toca 24 kHz constante, então o valor se mantém (interpolação)", () => {
    const proc = new (loadWorklet("argos/voice-play-worklet.js", 48000))();
    proc.port.onmessage!({ data: pcm(4800, 8192) });
    const out = pull(proc, 256);
    expect(out.every((x) => Math.abs(x - 0.25) < 0.01)).toBe(true);
  });

  test("dada a fila secando no meio do bloco, quando faltar amostra, então o resto é silêncio e volta a esperar o buffer", () => {
    const proc = new (loadWorklet("argos/voice-play-worklet.js", 24000))();
    proc.port.onmessage!({ data: pcm(2900, 16384) });
    pull(proc, 2800);
    const out = pull(proc, 256);
    expect(out[out.length - 1]).toBe(0);
    proc.port.onmessage!({ data: pcm(500, 16384) });
    expect(pull(proc).every((x) => x === 0)).toBe(true);
  });

  test("dado mais que 3 s na fila, quando chega mais, então o bloco velho sai e a fila não passa do teto", () => {
    const proc = new (loadWorklet("argos/voice-play-worklet.js", 24000))();
    for (let i = 0; i < 10; i++) proc.port.onmessage!({ data: pcm(24000, 1000) });
    expect(proc.queue.queued).toBeLessThanOrEqual(24000 * 4);
  });
});

describe("protocolo de segurar para falar", () => {
  const logic = loadLogic();
  const make = (mode = "ptt") => {
    const sent: any[] = [];
    return { sent, p: logic.createVoiceProtocol((o) => sent.push(o), mode) };
  };

  test("dado o início, quando manda o hello, então vai primeiro e com o modo escolhido", () => {
    const { sent, p } = make("open");
    p.hello();
    expect(sent).toEqual([{ type: "hello", mode: "open" }]);
  });

  test("dado ptt e modo pedidos antes do ready, quando o ready chega, então saem em ordem com o último valor de cada", () => {
    const { sent, p } = make();
    p.hello();
    p.ptt(true);
    p.ptt(false);
    p.ptt(true);
    p.setMode("open");
    expect(sent).toHaveLength(1);
    expect(p.receive({ type: "ready", max_s: 600 })).toEqual({ kind: "ready", maxS: 600 });
    expect(sent.slice(1)).toEqual([{ type: "mode", mode: "open" }, { type: "ptt", down: true }]);
  });

  test("dado o ready, quando aperta e solta, então cada gesto vira um ptt", () => {
    const { sent, p } = make();
    p.hello();
    p.receive({ type: "ready" });
    p.ptt(true);
    p.ptt(false);
    expect(sent.slice(1)).toEqual([{ type: "ptt", down: true }, { type: "ptt", down: false }]);
  });

  test("dado ptt sem o botão apertado, quando um quadro chega, então é descartado; apertado, passa", () => {
    const { p } = make();
    p.hello();
    expect(p.canSend(960)).toBe(false);
    p.receive({ type: "ready" });
    expect(p.canSend(960)).toBe(false);
    p.ptt(true);
    expect(p.canSend(960)).toBe(true);
    p.ptt(false);
    expect(p.canSend(960)).toBe(false);
  });

  test("dado o modo aberto, quando um quadro chega, então passa sem o botão, mesmo com o Mark falando", () => {
    const { p } = make("open");
    p.hello();
    p.receive({ type: "ready" });
    p.receive({ type: "state", state: "SPEAKING" });
    expect(p.canSend(960)).toBe(true);
  });

  test("dado um quadro ímpar, vazio ou acima de 3200 B, quando confere, então nunca sai", () => {
    const { p } = make("open");
    p.hello();
    p.receive({ type: "ready" });
    expect(p.canSend(961)).toBe(false);
    expect(p.canSend(0)).toBe(false);
    expect(p.canSend(3202)).toBe(false);
    expect(p.canSend(3200)).toBe(true);
  });

  test("dado o bye, quando manda, então avisa o painel e nenhum quadro mais passa", () => {
    const { sent, p } = make("open");
    p.hello();
    p.receive({ type: "ready" });
    p.bye();
    expect(sent[sent.length - 1]).toEqual({ type: "bye" });
    expect(p.canSend(960)).toBe(false);
  });

  test("dado busy, error e lixo, quando recebe, então busy e error trazem o código e o resto é ignorado", () => {
    const { p } = make();
    expect(p.receive({ type: "busy", code: "mark_voice_busy", explain: { title: "x" } })).toMatchObject({ kind: "busy", code: "mark_voice_busy" });
    expect(p.receive({ type: "error" })).toMatchObject({ kind: "error", code: "mark_voice_failed" });
    expect(p.receive({ type: "interrupted" })).toEqual({ kind: "interrupted" });
    expect(p.receive("texto")).toEqual({ kind: "ignored" });
    expect(p.receive(null)).toEqual({ kind: "ignored" });
  });

  test("dado um modo inválido, quando pede, então nada é mandado e o modo não muda", () => {
    const { sent, p } = make();
    p.hello();
    p.receive({ type: "ready" });
    p.setMode("shout");
    expect(sent).toHaveLength(1);
    expect(p.mode).toBe("ptt");
  });
});

describe("religação, erros e ajudantes", () => {
  const logic = loadLogic();

  test("dada a tentativa 0, quando pede o recuo, então 1 s; além da tabela repete o teto de 15 s", () => {
    expect(logic.reconnectMs(0)).toBe(1000);
    expect(logic.reconnectMs(99)).toBe(15000);
    expect(logic.reconnectMs(-3)).toBe(1000);
  });

  test("dados códigos de causa humana, quando decide religar, então busy, microfone e sessão longa são fatais e queda de rede não", () => {
    for (const code of ["mark_voice_busy", "mark_voice_mic_denied", "mark_voice_too_long", "mark_voice_insecure_context"]) expect(logic.isFatalCode(code)).toBe(true);
    expect(logic.isFatalCode("mark_voice_rate_limit")).toBe(false);
    expect(logic.isFatalCode("mark_voice_failed")).toBe(false);
  });

  test("dado o erro do getUserMedia, quando mapeia, então vira o código do catálogo", () => {
    expect(logic.micErrorCode({ name: "NotAllowedError" }, true)).toBe("mark_voice_mic_denied");
    expect(logic.micErrorCode({ name: "NotFoundError" }, true)).toBe("mark_voice_mic_missing");
    expect(logic.micErrorCode({ name: "NotAllowedError" }, false)).toBe("mark_voice_insecure_context");
    expect(logic.micErrorCode(new Error("x"), true)).toBe("mark_voice_failed");
  });

  test("dado o texto do servidor, do catálogo ou nenhum, quando explica, então a ordem é servidor, catálogo, genérico", () => {
    const served = { title: "do servidor", cause: "c", action: "a" };
    const texts = { mark_voice_mic_denied: { title: "do catálogo", cause: "c", action: "a" } };
    expect(logic.explainFor("mark_voice_mic_denied", served, texts).title).toBe("do servidor");
    expect(logic.explainFor("mark_voice_mic_denied", null, texts).title).toBe("do catálogo");
    expect(logic.explainFor("mark_voice_x", null, texts).title).toBe("Voz indisponível");
  });

  test("dado https ou http, quando monta o endereço, então wss ou ws no mesmo host, no caminho do painel", () => {
    expect(logic.voiceUrl({ protocol: "https:", host: "x.trycloudflare.com" })).toBe("wss://x.trycloudflare.com/api/mark/voice");
    expect(logic.voiceUrl({ protocol: "http:", host: "127.0.0.1:2800" })).toBe("ws://127.0.0.1:2800/api/mark/voice");
  });

  test("dado silêncio e sinal cheio, quando mede o nível, então 0 e 1", () => {
    expect(logic.levelOfPcm16(new Int16Array(480))).toBe(0);
    expect(logic.levelOfPcm16(new Int16Array(480).fill(20000))).toBe(1);
    expect(logic.levelOfPcm16(new Int16Array(0))).toBe(0);
  });

  test("dado foco em campo de texto, quando aperta espaço, então não conta como falar", () => {
    expect(logic.isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(logic.isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(logic.isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(logic.isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(logic.isTypingTarget(null)).toBe(false);
  });
});

describe("carga sob demanda e arquivos servidos", () => {
  test("dado index.html, quando lê os scripts, então a voz não entra na carga inicial (só o nó mark)", () => {
    const html = readFileSync(join(ui, "index.html"), "utf8");
    expect(html).toContain("/ui/argos/node-mark.js");
    expect(html).not.toContain("voice");
  });

  test("dado o nó mark, quando lê as listas, então carrega primeiro as regras e depois a vista", () => {
    const src = readFileSync(join(ui, "argos/node-mark.tsx"), "utf8");
    expect(src).toMatch(/VOICE_SCRIPTS = \['\/ui\/argos\/voice-logic\.js', '\/ui\/argos\/voice\.js'\]/);
  });

  test("dados os worklets, quando conferem o nome, então nenhum tem um .tsx de mesmo nome (o .tsx venceria o .js plano)", () => {
    for (const name of ["voice-capture-worklet", "voice-play-worklet"]) {
      expect(() => readFileSync(join(ui, `argos/${name}.tsx`))).toThrow();
    }
  });

  test("dado o código de voz, quando procura gravação ou log de áudio, então não há", () => {
    for (const file of ["argos/voice.tsx", "argos/voice-logic.tsx", "argos/voice-capture-worklet.js", "argos/voice-play-worklet.js"]) {
      const src = readFileSync(join(ui, file), "utf8");
      expect(src).not.toMatch(/MediaRecorder|console\.(log|debug)|localStorage|indexedDB|SpeechRecognition|speechSynthesis/);
    }
  });
});
