// Waves (kit/panel/ui/fx/waves.tsx): o que não precisa de navegador. Carrega o arquivo com React, window e document simulados.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Fn = (...a: unknown[]) => unknown;
interface Rig { out: { HadesFx?: { Waves: Fn } }; listeners: Map<string, Set<unknown>>; frames: Fn[]; contextos: number; appended: number; removed: number; run: (props: Record<string, unknown>) => () => void }

function rig(webgl2: boolean): Rig {
  const listeners = new Map<string, Set<unknown>>();
  const frames: Fn[] = [];
  const state = { contextos: 0, appended: 0, removed: 0 };
  const alvo = () => ({
    addEventListener: (t: string, f: unknown) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t))?.add(f); },
    removeEventListener: (t: string, f: unknown) => { listeners.get(t)?.delete(f); },
  });
  const gl = new Proxy({}, { get: (_t, k) => (k === "getExtension" ? () => null : k === "getShaderParameter" || k === "getProgramParameter" ? () => true : typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({})) });
  const plano = { clearRect() {}, fillRect() {}, fillStyle: "", getImageData: () => ({ data: [255, 255, 255, 255] }) };
  const canvas = { ...alvo(), style: {}, setAttribute() {}, remove() { state.removed++; }, getContext: (kind: string) => (kind === "2d" ? plano : webgl2 ? (state.contextos++, gl) : null) };
  const document = { ...alvo(), hidden: false, documentElement: alvo(), createElement: () => canvas };
  const host = { ...alvo(), clientWidth: 400, clientHeight: 300, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }), appendChild() { state.appended++; } };
  const win: Record<string, unknown> = {
    ...alvo(), devicePixelRatio: 1,
    matchMedia: () => ({ ...alvo(), matches: false }),
    requestAnimationFrame: (f: Fn) => frames.push(f),
    cancelAnimationFrame: () => {},
  };
  let efeitos: Array<() => unknown> = [];
  const react = {
    createElement: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
    useRef: (v: unknown) => ({ current: v }),
    useEffect: (f: () => unknown) => { efeitos.push(f); },
  };
  const js = new Bun.Transpiler({ loader: "tsx" }).transformSync(readFileSync(join(import.meta.dir, "../../../kit/panel/ui/fx/waves.tsx"), "utf8"));
  new Function("React", "window", "document", js)(react, win, document);
  const out = win as Rig["out"];
  const run = (props: Record<string, unknown>) => {
    efeitos = [];
    const el = (out.HadesFx?.Waves as Fn)(props) as { props: { ref: { current: unknown } } };
    el.props.ref.current = host;
    const limpezas = efeitos.map((f) => f());
    return () => limpezas.forEach((l) => typeof l === "function" && l());
  };
  return { out, listeners, frames, run, get contextos() { return state.contextos; }, get appended() { return state.appended; }, get removed() { return state.removed; } };
}

const total = (r: Rig) => [...r.listeners.values()].reduce((n, s) => n + s.size, 0);

describe("waves", () => {
  test("dado um navegador sem webgl2, quando monta, então não lança e não anexa tela", () => {
    const r = rig(false);
    expect(() => r.run({})()).not.toThrow();
    expect(r.appended).toBe(0);
    expect(r.frames.length).toBe(0);
  });

  test("dado webgl2, quando monta e desmonta, então os ouvintes de window e document somem e a tela sai", () => {
    const r = rig(true);
    const limpa = r.run({});
    expect(r.appended).toBe(1);
    expect(total(r)).toBeGreaterThan(0);
    limpa();
    expect(total(r)).toBe(0);
    expect(r.removed).toBe(1);
  });

  test("dado paused, quando monta, então desenha um quadro e não agenda outro", () => {
    const r = rig(true);
    r.run({ paused: true });
    expect(r.frames.length).toBe(1);
    r.frames.shift()?.(16);
    expect(r.frames.length).toBe(0);
  });

  test("dado o escoamento ligado, quando um quadro roda, então agenda o seguinte", () => {
    const r = rig(true);
    r.run({});
    r.frames.shift()?.(16);
    expect(r.frames.length).toBe(1);
  });
});
