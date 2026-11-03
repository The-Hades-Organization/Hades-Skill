// Fade Content, play() (kit/panel/ui/fx/fade-content.tsx): casos sem elemento, com movimento reduzido, cancelamento e fim do
// efeito mist, com um DOM mínimo simulado (o visual do ruído se confere por captura).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Playing = { cancel(): void };
type Fx = { play(el: unknown, o?: Record<string, unknown>): Playing | null };

const SRC = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/fx/fade-content.tsx"), "utf8");
const JS = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react" } } }).transformSync(SRC);

function bancada(reduced = false) {
  let clock = 0;
  let frame: (() => void) | null = null;
  const svgs: unknown[] = [];
  const makeSvg = () => {
    const node = { style: {} as Record<string, string>, setAttribute() {}, appendChild() {}, append() {}, remove() { svgs.splice(svgs.indexOf(node), 1); } };
    return node;
  };
  const doc = { createElementNS: makeSvg, body: { appendChild: (n: unknown) => { svgs.push(n); } } };
  const win: { HadesFx?: { FadeContent: Fx } } = {};
  new Function("React", "window", "matchMedia", "navigator", "document", "requestAnimationFrame", "cancelAnimationFrame", "performance", "MutationObserver", JS)(
    { useLayoutEffect: () => {}, useRef: () => ({ current: null }) },
    win,
    () => ({ matches: reduced }),
    {},
    doc,
    (cb: () => void) => { frame = cb; return 1; },
    () => { frame = null; },
    { now: () => clock },
    undefined,
  );
  const el = (filha = 0) => {
    const e = { style: { filter: "" } as Record<string, string>, children: [] as unknown[], parentElement: null, isConnected: true, getBoundingClientRect: () => ({ width: 300, height: 200 }), getAttribute: () => "", removeAttribute() {}, querySelector: () => null };
    for (let i = 0; i < filha; i++) e.children.push({ ...e, style: { filter: "" }, children: [], parentElement: e });
    return e;
  };
  const avanca = (ms: number) => { clock += ms; const f = frame; frame = null; f?.(); };
  return { fx: win.HadesFx!.FadeContent, el, avanca, svgs, quadroAgendado: () => frame !== null };
}

describe("fade content play", () => {
  test("dado nenhum elemento, então devolve null e chama onComplete na hora", () => {
    const b = bancada();
    let n = 0;
    expect(b.fx.play(null, { onComplete: () => n++ })).toBeNull();
    expect(n).toBe(1);
  });

  test("dado movimento reduzido, então devolve null e chama onComplete na hora", () => {
    const b = bancada(true);
    let n = 0;
    expect(b.fx.play(b.el(), { effect: "mist", onComplete: () => n++ })).toBeNull();
    expect(n).toBe(1);
    expect(b.svgs.length).toBe(0);
  });

  test("dado fade sem Web Animations, então chama onComplete na hora", () => {
    const b = bancada();
    let n = 0;
    expect(b.fx.play(b.el(), { onComplete: () => n++ })).toBeNull();
    expect(n).toBe(1);
  });

  test("dado mist em andamento, então há um filtro por alvo; cancelar remove filtro, auxiliares e quadro", () => {
    const b = bancada();
    const el = b.el(3);
    const a = b.fx.play(el, { effect: "mist", duration: 1, stagger: 0.1 });
    expect(b.svgs.length).toBe(3);
    expect(String((el.children[0] as { style: { filter: string } }).style.filter)).toContain("url(#");
    a!.cancel();
    expect(b.svgs.length).toBe(0);
    expect((el.children as Array<{ style: { filter: string } }>).every((c) => c.style.filter === "")).toBe(true);
    expect(b.quadroAgendado()).toBe(false);
  });

  test("dado mist até o fim, então onComplete dispara uma vez e nada sobra no elemento nem no documento", () => {
    const b = bancada();
    const el = b.el(2);
    let n = 0;
    b.fx.play(el, { effect: "mist", duration: 1, stagger: 0.1, onComplete: () => n++ });
    b.avanca(500);
    expect(n).toBe(0);
    expect(b.svgs.length).toBe(2);
    b.avanca(700);
    b.avanca(100);
    expect(n).toBe(1);
    expect(b.svgs.length).toBe(0);
    expect((el.children as Array<{ style: { filter: string } }>).every((c) => c.style.filter === "")).toBe(true);
    expect(b.quadroAgendado()).toBe(false);
  });
});
