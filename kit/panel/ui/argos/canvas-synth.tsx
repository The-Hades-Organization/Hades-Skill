/* Gerador determinístico de documentos de canvas para a prova de escala (harness em /dev/canvas) e para os testes.
 * Sem DOM e sem React: o navegador carrega como script (window.ArgosCanvasSynth) e o bun test importa o mesmo arquivo. */
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../../../../src/lib/canvas-doc.ts";

interface SynthOptions {
  count: number;
  /** Mesma semente, mesmo documento. */
  seed?: number;
}

function makeCanvasSynth() {
  /** Tipos livres (não vivos): o documento sintético não depende do grafo. */
  const SYNTH_TYPES = ["note", "task", "card", "box", "link"] as const;
  /** Teto do documento (CANVAS_LIMITS.nodes); o gerador não passa dele. */
  const SYNTH_MAX = 2000;
  const COL_W = 280;
  const ROW_H = 160;

  /** mulberry32: PRNG de 32 bits, pequeno e bom o bastante para posições (não é criptográfico). */
  const prng = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /** `count` nós numa grade larga com folga aleatória, tamanhos múltiplos da grade, ~3% bloqueados e arestas entre vizinhos. */
  function syntheticDoc({ count, seed = 1 }: SynthOptions): CanvasDoc {
    if (!Number.isInteger(count) || count < 0 || count > SYNTH_MAX) throw new RangeError(`count fora de 0..${SYNTH_MAX}`);
    const rand = prng(seed);
    const cols = Math.max(1, Math.ceil(Math.sqrt(count * 2.5)));
    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      nodes.push({
        id: `n${i + 1}`,
        type: SYNTH_TYPES[Math.floor(rand() * SYNTH_TYPES.length)] as string,
        x: col * COL_W + Math.floor(rand() * 3) * 20,
        y: row * ROW_H + Math.floor(rand() * 3) * 20,
        w: 160 + Math.floor(rand() * 4) * 20,
        h: 80 + Math.floor(rand() * 3) * 20,
        z: i,
        data: { label: `Nó ${i + 1}` },
        locked: rand() < 0.03,
        blurred: rand() < 0.02,
      });
      if (col > 0 && rand() < 0.5) edges.push({ id: `e${i}-${i + 1}`, from: `n${i}`, to: `n${i + 1}`, kind: "link" });
      if (row > 0 && rand() < 0.3) edges.push({ id: `e${i + 1 - cols}-${i + 1}`, from: `n${i + 1 - cols}`, to: `n${i + 1}`, kind: "link" });
    }
    return { v: 1, rev: 0, nodes, edges, groups: [] };
  }

  return { SYNTH_TYPES, SYNTH_MAX, syntheticDoc };
}

type ArgosCanvasSynthApi = ReturnType<typeof makeCanvasSynth>;
(globalThis as unknown as { ArgosCanvasSynth: ArgosCanvasSynthApi }).ArgosCanvasSynth = makeCanvasSynth();
