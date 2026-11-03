// Fade Content, efeito Mist (kit/panel/ui/fx/fade-content.tsx): a curva expo.out e o escalonamento saem de funções puras,
// carregadas aqui sem DOM com o React e o window simulados.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Node = { parentElement: Node | null; children: Node[] };
type Fx = { arrivalTargets: (n: Node, el: Node, owned: { has: (n: Node) => boolean }) => Node[]; expoOut: (t: number) => number; staggerStarts: (n: number, each: number, from?: "start" | "end" | "center") => number[]; play: unknown };

function carrega(): Fx {
  const src = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/fx/fade-content.tsx"), "utf8");
  const js = new Bun.Transpiler({ loader: "tsx" }).transformSync(src);
  const win: { HadesFx?: { FadeContent: Fx } } = {};
  const react = { useLayoutEffect: () => {}, useRef: () => ({ current: null }) };
  new Function("React", "window", "matchMedia", "navigator", js)(react, win, () => ({ matches: false }), {});
  return win.HadesFx!.FadeContent;
}
const fx = carrega();

describe("fade content mist", () => {
  test("dado t em 0, 1 e acima de 1, então expo.out vai de 0 a 1 e fica em 1", () => {
    expect(fx.expoOut(0)).toBe(0);
    expect(fx.expoOut(1)).toBe(1);
    expect(fx.expoOut(1.5)).toBe(1);
  });

  test("dado t em 0.5, então expo.out vale 1 - 2^-5", () => {
    expect(fx.expoOut(0.5)).toBeCloseTo(1 - 2 ** -5, 10);
  });

  test("dado o stagger 0,1 s de início, então os alvos começam defasados de 0,1 s em 0,1 s", () => {
    expect(fx.staggerStarts(4, 0.1, "start").map((v) => +v.toFixed(3))).toEqual([0, 0.1, 0.2, 0.3]);
  });

  test("dado from end ou center, então a ordem do stagger inverte ou parte do meio", () => {
    expect(fx.staggerStarts(3, 0.1, "end").map((v) => +v.toFixed(3))).toEqual([0.2, 0.1, 0]);
    expect(fx.staggerStarts(3, 0.1, "center").map((v) => +v.toFixed(3))).toEqual([0.1, 0, 0.1]);
  });

  test("dado zero alvos, então o stagger é vazio; dado um só, então começa em 0", () => {
    expect(fx.staggerStarts(0, 0.1)).toEqual([]);
    expect(fx.staggerStarts(1, 0.1)).toEqual([0]);
  });
});

describe("fade content mist, conteúdo tardio", () => {
  const no = (parent: Node | null, filhos = 0): Node => { const n: Node = { parentElement: parent, children: [] }; for (let i = 0; i < filhos; i++) n.children.push(no(n)); return n; };
  const vazio = { has: () => false };

  const filho = (pai: Node, i: number): Node => {
    const n = pai.children[i];
    if (!n) throw new Error(`o nó de teste não tem o filho ${i}`);
    return n;
  };

  test("dado a página que chega como filho único do bloco, então os alvos são os filhos dela", () => {
    const bloco = no(null);
    const raiz = no(bloco, 3);
    bloco.children = [raiz];
    expect(fx.arrivalTargets(raiz, bloco, vazio)).toEqual(raiz.children);
  });

  test("dado um nó que chega dentro de alvo já mascarado, então não ganha máscara", () => {
    const bloco = no(null);
    const alvo = no(bloco, 1);
    bloco.children = [alvo];
    expect(fx.arrivalTargets(filho(alvo, 0), bloco, { has: (n) => n === alvo })).toEqual([]);
  });

  test("dado um nó que chega fundo no bloco e fora de máscara, então ele próprio é o alvo", () => {
    const bloco = no(null);
    const meio = no(bloco, 1);
    bloco.children = [meio];
    expect(fx.arrivalTargets(filho(meio, 0), bloco, vazio)).toEqual([filho(meio, 0)]);
  });

  test("dado um irmão novo ao lado de um alvo já mascarado, então só o novo entra", () => {
    const bloco = no(null, 2);
    const velho = filho(bloco, 0);
    const novo = filho(bloco, 1);
    expect(fx.arrivalTargets(novo, bloco, { has: (n) => n === velho })).toEqual([novo]);
  });
});
