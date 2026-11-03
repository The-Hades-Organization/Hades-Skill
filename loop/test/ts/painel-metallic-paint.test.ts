// Metallic Paint (kit/panel/ui/fx/metallic-paint.tsx): o que dá para provar sem navegador, com React, document e WebGL simulados.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Ref = { current: unknown };
type Hooks = { refs: Ref[]; effects: Array<() => unknown> };

const SRC = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/fx/metallic-paint.tsx"), "utf8");
const JS = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react" } } }).transformSync(SRC);

function montagem(webgl2: boolean) {
  const hooks: Hooks = { refs: [], effects: [] };
  const react = {
    useRef: (v: unknown) => { const r = { current: v }; hooks.refs.push(r); return r; },
    useEffect: (fn: () => unknown) => { hooks.effects.push(fn); },
    createElement: (type: unknown, props: unknown) => ({ type, props }),
  };
  const gl = new Proxy({}, { get: (_, k) => (k === "getExtension" ? () => ({ loseContext() {} }) : () => true) });
  const canvas = { style: {}, setAttribute() {}, addEventListener() {}, removeEventListener() {}, remove() {}, getContext: (k: string) => (k === "webgl2" && webgl2 ? gl : null), width: 0, height: 0 };
  const registrados: string[] = [];
  const removidos: string[] = [];
  const frames: number[] = [];
  const observadores = { vivos: 0 };
  class Observer {
    constructor() { observadores.vivos++; }
    observe() {}
    disconnect() { observadores.vivos--; }
  }
  const doc = {
    createElement: () => canvas,
    visibilityState: "visible",
    addEventListener: (t: string) => registrados.push(`doc:${t}`),
    removeEventListener: (t: string) => removidos.push(`doc:${t}`),
  };
  const host = {
    clientWidth: 400, clientHeight: 400, style: {},
    appendChild() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
    addEventListener: (t: string) => registrados.push(`host:${t}`),
    removeEventListener: (t: string) => removidos.push(`host:${t}`),
  };
  const win: { HadesFx?: { MetallicPaint: (p: Record<string, unknown>) => unknown }; devicePixelRatio: number } = { devicePixelRatio: 1 };
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  new Function("React", "window", "document", "matchMedia", "ResizeObserver", "IntersectionObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", JS)(
    react, win, doc, matchMedia, Observer, Observer, (f: unknown) => frames.push(f as number), () => {}, () => ({ color: "" }));
  const render = (props: Record<string, unknown>) => {
    hooks.refs.length = 0; hooks.effects.length = 0;
    win.HadesFx!.MetallicPaint(props);
    hooks.refs[0]!.current = host;
    return hooks.effects.map((e) => e());
  };
  return { win, render, registrados, removidos, frames, observadores };
}

describe("metallic paint", () => {
  test("dado o arquivo carregado, então registra MetallicPaint em window.HadesFx", () => {
    expect(typeof montagem(true).win.HadesFx?.MetallicPaint).toBe("function");
  });

  test("dado um navegador sem WebGL2, quando monta e desmonta, então não lança, não cria ouvintes nem quadros", () => {
    const m = montagem(false);
    expect(() => { const limpezas = m.render({ imageSrc: "/x.svg" }); for (const l of limpezas) if (typeof l === "function") l(); }).not.toThrow();
    expect(m.registrados).toEqual([]);
    expect(m.frames).toEqual([]);
  });

  test("dado WebGL2 e paused sem imagem, quando monta, então não agenda quadro contínuo", () => {
    const m = montagem(true);
    m.render({ paused: true });
    expect(m.frames).toEqual([]);
  });

  test("dado WebGL2, quando desmonta, então remove cada ouvinte registrado e solta os observadores", () => {
    const m = montagem(true);
    const limpezas = m.render({});
    expect(m.registrados.length).toBeGreaterThan(0);
    expect(m.observadores.vivos).toBe(2);
    for (const l of limpezas) if (typeof l === "function") l();
    expect([...m.removidos].sort()).toEqual([...m.registrados].sort());
    expect(m.observadores.vivos).toBe(0);
  });
});
