// Reconhecedor de toque do canvas do Argos: pinça (dois dedos), arrastar (um dedo) e toque longo. Puro e sem DOM: o
// componente repassa os pontos dos eventos de ponteiro e o relógio entra por injeção (teste determinístico).
import type { Vec } from "./canvas-camera.ts";

export const TOUCH_LIMITS = {
  /** Deslocamento, em pixels, acima do qual um dedo deixa de ser toque e vira arrasto. */
  slopPx: 8,
  /** Tempo parado com um dedo até virar toque longo (valor usual do menu de contexto no toque). */
  longPressMs: 500,
  /** Toque mais demorado que isto, mesmo parado, não é um toque curto. */
  tapMaxMs: 300,
  /** Dedos que o reconhecedor acompanha; o terceiro em diante é ignorado. */
  maxPointers: 2,
} as const;

export type TouchEvent =
  | { type: "tap"; at: Vec }
  | { type: "longpress"; at: Vec }
  /** Deslocamento desde o último evento de arrasto (o primeiro já inclui o que passou da folga). */
  | { type: "pan"; dx: number; dy: number }
  /** Pontos iniciais e atuais dos dois dedos: o mesmo formato que `pinchCamera` consome (com a câmera do início). */
  | { type: "pinch"; startA: Vec; startB: Vec; a: Vec; b: Vec }
  /** Todos os dedos saíram depois de um arrasto ou pinça. */
  | { type: "end" };

export interface TouchRecognizer {
  down(id: number, at: Vec): TouchEvent[];
  move(id: number, at: Vec): TouchEvent[];
  up(id: number): TouchEvent[];
  /** Chamada periódica (timer do componente): dispara o toque longo quando o tempo passou. */
  tick(): TouchEvent[];
  /** Cancela tudo (perda de foco, `pointercancel`); não emite nada. */
  cancel(): void;
}

type Mode = "idle" | "press" | "pan" | "pinch" | "spent";

const finitePoint = (p: Vec): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * `now` devolve milissegundos monotônicos. Um dedo parado até `longPressMs` dá `longpress` (uma vez, no `tick`); um dedo
 * que se move além de `slopPx` vira `pan`; o segundo dedo cancela o resto e começa a `pinch`. Depois da pinça, o dedo que
 * sobra não arrasta (evita o salto): o reconhecedor só recomeça quando todos saem (`end`).
 */
export function createTouchRecognizer(now: () => number): TouchRecognizer {
  const points = new Map<number, Vec>();
  let mode: Mode = "idle";
  let startedAt = 0;
  let origin: Vec = { x: 0, y: 0 };
  let last: Vec = { x: 0, y: 0 };
  let pinchStart: { a: Vec; b: Vec; ids: [number, number] } | undefined;

  const reset = (): void => {
    points.clear();
    mode = "idle";
    pinchStart = undefined;
  };

  const pinchEvent = (): TouchEvent[] => {
    if (!pinchStart) return [];
    const a = points.get(pinchStart.ids[0]);
    const b = points.get(pinchStart.ids[1]);
    return a && b ? [{ type: "pinch", startA: pinchStart.a, startB: pinchStart.b, a: { ...a }, b: { ...b } }] : [];
  };

  return {
    down(id, at) {
      if (!Number.isFinite(id) || !finitePoint(at)) throw new RangeError("toque inválido");
      if (points.has(id) || points.size >= TOUCH_LIMITS.maxPointers) return [];
      points.set(id, { ...at });
      if (points.size === 1) {
        mode = "press";
        startedAt = now();
        origin = { ...at };
        last = { ...at };
        return [];
      }
      const [first, second] = [...points.keys()] as [number, number];
      pinchStart = { a: { ...(points.get(first) as Vec) }, b: { ...(points.get(second) as Vec) }, ids: [first, second] };
      mode = "pinch";
      return [];
    },
    move(id, at) {
      if (!Number.isFinite(id) || !finitePoint(at)) throw new RangeError("toque inválido");
      if (!points.has(id)) return [];
      points.set(id, { ...at });
      if (mode === "pinch") return pinchEvent();
      if (mode === "press" || mode === "pan") {
        if (mode === "press" && Math.hypot(at.x - origin.x, at.y - origin.y) <= TOUCH_LIMITS.slopPx) return [];
        mode = "pan";
        const dx = at.x - last.x;
        const dy = at.y - last.y;
        last = { ...at };
        return dx === 0 && dy === 0 ? [] : [{ type: "pan", dx, dy }];
      }
      return [];
    },
    up(id) {
      if (!points.has(id)) return [];
      const was = mode;
      const at = points.get(id) as Vec;
      points.delete(id);
      if (points.size > 0) {
        mode = "spent";
        pinchStart = undefined;
        return [];
      }
      const elapsed = now() - startedAt;
      reset();
      if (was === "press" && elapsed <= TOUCH_LIMITS.tapMaxMs) return [{ type: "tap", at }];
      return was === "pan" || was === "pinch" || was === "spent" ? [{ type: "end" }] : [];
    },
    tick() {
      if (mode !== "press" || now() - startedAt < TOUCH_LIMITS.longPressMs) return [];
      mode = "spent";
      return [{ type: "longpress", at: { ...origin } }];
    },
    cancel: reset,
  };
}
