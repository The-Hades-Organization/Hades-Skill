/* Harness de escala do motor do canvas (/dev/canvas, fora da navegação do dono): documento sintético de até 2000 nós,
 * contador de quadros visível e a medição automática (pan, zoom, arrasto de 50 selecionados, tempo até o primeiro
 * quadro). `?n=<nós>` escolhe o tamanho; `?bench=1` mede sozinho ao abrir e deixa o resultado em window.__canvasBench
 * (título da aba `bench:done`), para o roteiro de medição por navegador remoto. */
import type { CanvasDoc, CanvasNode } from "../../../../src/lib/canvas-doc.ts";
import type { CanvasOp, History } from "../../../../src/lib/canvas-history.ts";
import type { ArgosCanvasApi, CanvasEngineApi, CanvasModelApi, FrameInfo, NodeMenuRequest } from "./canvas-engine.tsx";

interface SynthApi {
  SYNTH_MAX: number;
  syntheticDoc(opts: { count: number; seed?: number }): CanvasDoc;
}

interface PhaseResult {
  name: string;
  /** Quadros do navegador por segundo durante a fase. */
  fps: number;
  /** Quadros que o motor desenhou e o custo de CPU de cada um. */
  drawn: number;
  p50: number;
  p95: number;
  max: number;
  /** Intervalos acima de 25 ms (quadro perdido a 60 Hz). */
  long: number;
  details: string;
}

interface BenchResult {
  nodes: number;
  edges: number;
  firstFrameMs: number | null;
  firstFrameSinceNavMs: number | null;
  phases: PhaseResult[];
  viewport: { w: number; h: number };
  dpr: number;
  userAgent: string;
}

/** Marco zero do harness: o tempo até o primeiro quadro conta a geração e a validação do documento. */
const HARNESS_T0 = performance.now();

function makeCanvasHarness() {
  const g = globalThis as unknown as { CanvasModel: CanvasModelApi; ArgosCanvas: ArgosCanvasApi; ArgosCanvasSynth: SynthApi; __canvasBench?: BenchResult };
  const M = g.CanvasModel;
  const { CanvasView } = g.ArgosCanvas;
  const synth = g.ArgosCanvasSynth;
  const h = React.createElement;
  const SIZES = [100, 500, 1000, 2000] as const;
  const PHASE_MS = 3000;
  const DRAG_COUNT = 50;
  const SEED = 1;

  const quantile = (sorted: readonly number[], q: number): number => (sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number) : 0);
  const round = (n: number): number => Math.round(n * 10) / 10;
  const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
  const frames = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await nextFrame();
  };

  const sizeFromQuery = (): number => {
    const n = Number(new URLSearchParams(location.search).get("n"));
    return (SIZES as readonly number[]).includes(n) ? n : 1000;
  };

  // fora do componente: identidade estável, senão cada render do harness (o contador) redesenharia o canvas
  const describeNode = (node: CanvasNode): string => (typeof node.data.label === "string" ? node.data.label : node.id);

  const makeDoc = (count: number): CanvasDoc => M.doc.validateCanvasDoc(synth.syntheticDoc({ count, seed: SEED }));

  /** Ponteiro sintético no host do canvas: passa pelo mesmo caminho do gesto real. */
  function pointer(host: HTMLElement, type: string, x: number, y: number, button: number): void {
    const r = host.getBoundingClientRect();
    host.dispatchEvent(new PointerEvent(type, {
      pointerId: 77, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true,
      button, buttons: type === "pointerup" ? 0 : button === 1 ? 4 : 1, clientX: r.left + x, clientY: r.top + y,
    }));
  }

  /** Uma fase: `step` roda a cada quadro do navegador por PHASE_MS; conta os quadros e o custo de cada desenho. */
  async function phase(name: string, api: CanvasEngineApi, step: (t: number) => void): Promise<PhaseResult> {
    const costs: number[] = [];
    const details = new Set<string>();
    const stop = api.onFrame((f: FrameInfo) => {
      costs.push(f.ms);
      details.add(f.detail);
    });
    const stamps: number[] = [];
    const start = await nextFrame();
    let now = start;
    while (now - start < PHASE_MS) {
      step((now - start) / PHASE_MS);
      stamps.push(now);
      now = await nextFrame();
    }
    stop();
    const gaps = stamps.slice(1).map((t, i) => t - (stamps[i] as number));
    const sorted = [...costs].sort((a, b) => a - b);
    return {
      name,
      fps: round((stamps.length - 1) / ((now - start) / 1000)),
      drawn: costs.length,
      p50: round(quantile(sorted, 0.5)),
      p95: round(quantile(sorted, 0.95)),
      max: round(sorted[sorted.length - 1] ?? 0),
      long: gaps.filter((gap) => gap > 25).length,
      details: [...details].join("/"),
    };
  }

  function Harness(): ReactNode {
    const [count, setCount] = React.useState(sizeFromQuery);
    const [doc, setDoc] = React.useState<CanvasDoc>(() => makeDoc(count));
    const [history, setHistoryState] = React.useState<History>(() => M.history.createHistory());
    const historyRef = React.useRef(history);
    const setHistory = React.useCallback((next: History) => {
      historyRef.current = next;
      setHistoryState(next);
    }, []);
    const [selection, setSelection] = React.useState<readonly string[]>([]);
    const [meter, setMeter] = React.useState({ fps: 0, p50: 0, p95: 0, visible: 0, detail: "-" });
    const [firstFrame, setFirstFrame] = React.useState<{ ms: number; nav: number } | null>(null);
    const [bench, setBench] = React.useState<BenchResult | null>(null);
    const [running, setRunning] = React.useState(false);
    const [message, setMessage] = React.useState("");
    const apiRef = React.useRef<CanvasEngineApi | null>(null);
    const boxRef = React.useRef<HTMLDivElement | null>(null);
    const recent = React.useRef<FrameInfo[]>([]);
    const docRef = React.useRef(doc);
    docRef.current = doc;
    const firstRef = React.useRef<{ ms: number; nav: number } | null>(null);

    const onReady = React.useCallback((api: CanvasEngineApi) => {
      apiRef.current = api;
      api.onFrame((f) => {
        recent.current.push(f);
        if (!firstRef.current) {
          firstRef.current = { ms: round(performance.now() - HARNESS_T0), nav: round(performance.now()) };
          setFirstFrame(firstRef.current);
        }
      });
    }, []);

    // contador visível: quadros desenhados no último segundo (parado, 0 é o esperado: não há laço contínuo)
    React.useEffect(() => {
      const timer = setInterval(() => {
        const now = performance.now();
        recent.current = recent.current.filter((f) => now - f.at < 1000);
        const sorted = recent.current.map((f) => f.ms).sort((a, b) => a - b);
        const last = recent.current[recent.current.length - 1];
        setMeter({ fps: recent.current.length, p50: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)), visible: last?.visible ?? 0, detail: last?.detail ?? "-" });
      }, 250);
      return () => clearInterval(timer);
    }, []);

    const onOp = React.useCallback((op: CanvasOp, next: CanvasDoc) => {
      setHistory(M.history.record(historyRef.current, op));
      docRef.current = next;
      setDoc(next);
    }, []);

    const undo = React.useCallback((back: boolean) => {
      const applied = back ? M.history.undo(historyRef.current, docRef.current) : M.history.redo(historyRef.current, docRef.current);
      if (!applied) return;
      setHistory(applied.history);
      docRef.current = applied.doc;
      setDoc(applied.doc);
      setSelection((sel) => M.selection.pruneSelection(sel, applied.doc));
    }, []);

    const onNodeMenu = React.useCallback((req: NodeMenuRequest) => setMessage(`menu pedido para ${req.id} (o menu é da próxima unidade)`), []);

    // desfazer/refazer só no harness (o registro de atalhos é da página)
    React.useEffect(() => {
      const onKey = (e: KeyboardEvent): void => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const key = e.key.toLowerCase();
        if (key === "z" || key === "y") {
          e.preventDefault();
          undo(key === "z" && !e.shiftKey);
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [undo]);

    const changeSize = (n: number): void => {
      const next = makeDoc(n);
      setCount(n);
      docRef.current = next;
      setDoc(next);
      setHistory(M.history.createHistory());
      setSelection([]);
      requestAnimationFrame(() => apiRef.current?.fitAll(false));
    };

    /** 50 nós livres mais perto do centro da tela (o arrasto de vários). */
    const pickNearCenter = (api: CanvasEngineApi, n: number): string[] => {
      const cam = api.getCamera();
      const view = api.viewport();
      const c = M.camera.screenToWorld(cam, { x: view.w / 2, y: view.h / 2 });
      return docRef.current.nodes
        .filter((node) => !node.locked)
        .map((node) => ({ id: node.id, d: Math.hypot(node.x + node.w / 2 - c.x, node.y + node.h / 2 - c.y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, n)
        .map((x) => x.id);
    };

    async function runBench(): Promise<void> {
      const api = apiRef.current;
      const host = boxRef.current?.querySelector<HTMLElement>("[aria-roledescription=canvas]");
      if (!api || !host || running) return;
      setRunning(true);
      setBench(null);
      try {
        const view = api.viewport();
        const cx = view.w / 2;
        const cy = view.h / 2;
        const sweep = (t: number): { x: number; y: number } => ({ x: cx + 200 * Math.sin(t * Math.PI * 4), y: cy + 100 * Math.cos(t * Math.PI * 4) });
        const panPhase = async (name: string): Promise<PhaseResult> => {
          pointer(host, "pointerdown", cx, cy, 1);
          const result = await phase(name, api, (t) => {
            const p = sweep(t);
            pointer(host, "pointermove", p.x, p.y, 1);
          });
          pointer(host, "pointerup", cx, cy, 1);
          return result;
        };
        const results: PhaseResult[] = [];
        api.fitAll(false);
        await frames(3);
        results.push(await panPhase("pan, tudo à vista"));
        const all = M.camera.boundsOf(docRef.current.nodes) ?? { x: 0, y: 0, w: 0, h: 0 };
        const center = { x: all.x + all.w / 2, y: all.y + all.h / 2 };
        const at = (k: number) => ({ x: center.x - view.w / 2 / k, y: center.y - view.h / 2 / k, k });
        api.setCamera(at(0.4));
        await frames(3);
        results.push(await panPhase("pan, rótulos (k=0.4)"));
        api.fitAll(false);
        await frames(3);
        let frame = 0;
        results.push(await phase("zoom pela roda", api, () => {
          const dir = Math.floor(frame++ / 40) % 2 === 0 ? -1 : 1;
          const r = host.getBoundingClientRect();
          host.dispatchEvent(new WheelEvent("wheel", { deltaY: dir * 40, deltaMode: 0, clientX: r.left + cx, clientY: r.top + cy, bubbles: true, cancelable: true }));
        }));
        api.setCamera(at(0.7));
        await frames(3);
        const ids = pickNearCenter(api, DRAG_COUNT);
        setSelection(ids);
        await frames(4);
        const anchor = docRef.current.nodes.find((n) => n.id === ids[0]);
        if (anchor) {
          const grab = M.camera.worldToScreen(api.getCamera(), { x: anchor.x + 10, y: anchor.y + 8 });
          pointer(host, "pointerdown", grab.x, grab.y, 0);
          results.push(await phase(`arrasto de ${ids.length} selecionados`, api, (t) => {
            pointer(host, "pointermove", grab.x + 150 * Math.sin(t * Math.PI * 4), grab.y + 80 * Math.sin(t * Math.PI * 2), 0);
          }));
          pointer(host, "pointerup", grab.x, grab.y, 0);
        }
        const out: BenchResult = {
          nodes: docRef.current.nodes.length,
          edges: docRef.current.edges.length,
          firstFrameMs: firstRef.current?.ms ?? null,
          firstFrameSinceNavMs: firstRef.current?.nav ?? null,
          phases: results,
          viewport: view,
          dpr: window.devicePixelRatio || 1,
          userAgent: navigator.userAgent,
        };
        g.__canvasBench = out;
        setBench(out);
        document.title = "bench:done";
      } finally {
        setRunning(false);
      }
    }

    React.useEffect(() => {
      if (new URLSearchParams(location.search).get("bench") !== "1") return undefined;
      // espera o primeiro quadro assentar antes de medir
      const timer = setTimeout(() => {
        runBench().catch((error: unknown) => {
          document.title = "bench:error";
          setMessage(`medição falhou: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, 500);
      return () => clearTimeout(timer);
    }, []);

    const button = (label: string, onClick: () => void, disabled = false): ReactNode =>
      h("button", { type: "button", onClick, disabled, style: { font: "inherit", padding: "4px 10px", border: "1px solid var(--border-strong)", background: "var(--card)", color: "inherit", cursor: "pointer" } }, label);

    const stat = `quadros/s: ${meter.fps} · custo do quadro p50/p95: ${meter.p50}/${meter.p95} ms · à vista: ${meter.visible} · detalhe: ${meter.detail}` +
      ` · primeiro quadro: ${firstFrame ? `${firstFrame.ms} ms (${firstFrame.nav} ms desde a navegação)` : "…"} · selecionados: ${selection.length}` +
      ` · desfazer: ${history.past.length}`;

    return h("div", { style: { display: "flex", flexDirection: "column", height: "100%" } },
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", padding: "8px 16px", borderBottom: "1px solid var(--border)" } },
        h("strong", null, "Canvas: harness de escala"),
        h("label", null, "nós ",
          h("select", { value: count, onChange: (e: Event) => changeSize(Number((e.target as HTMLSelectElement).value)), style: { font: "inherit" } },
            SIZES.map((n) => h("option", { key: n, value: n }, String(n))))),
        button("Enquadrar", () => apiRef.current?.fitAll(true)),
        button(`Selecionar ${DRAG_COUNT}`, () => apiRef.current && setSelection(pickNearCenter(apiRef.current, DRAG_COUNT))),
        button("Desfazer", () => undo(true), history.past.length === 0),
        button("Refazer", () => undo(false), history.future.length === 0),
        button(running ? "Medindo…" : "Medir", () => {
          runBench().catch((error: unknown) => setMessage(`medição falhou: ${error instanceof Error ? error.message : String(error)}`));
        }, running)),
      h("div", { role: "status", style: { padding: "4px 16px", fontVariantNumeric: "tabular-nums", color: "var(--muted-foreground)" } }, stat),
      message ? h("div", { role: "alert", style: { padding: "4px 16px" } }, message) : null,
      bench ? h("table", { style: { margin: "4px 16px", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" } },
        h("thead", null, h("tr", null, ["fase", "fps", "quadros desenhados", "custo p50", "p95", "máx", "intervalos > 25 ms", "detalhe"].map((c) => h("th", { key: c, style: { textAlign: "left", paddingRight: "16px" } }, c)))),
        h("tbody", null, bench.phases.map((p) => h("tr", { key: p.name },
          [p.name, p.fps, p.drawn, `${p.p50} ms`, `${p.p95} ms`, `${p.max} ms`, p.long, p.details].map((c, i) => h("td", { key: i, style: { paddingRight: "16px" } }, String(c))))))) : null,
      h("div", { style: { padding: "2px 16px 6px", color: "var(--muted-foreground)" } },
        "Arrastar o fundo move a câmera; Shift+arrastar seleciona por retângulo; roda aproxima; Tab percorre os nós, setas movem, Espaço seleciona, Enter pede o menu; + − 0 na câmera; Ctrl+Z desfaz."),
      h("div", { ref: boxRef, style: { flex: "1 1 auto", minHeight: 0, borderTop: "1px solid var(--border)" } },
        h(CanvasView, {
          doc, selection, onSelectionChange: setSelection, onOp, onReady, label: "Canvas de teste",
          onNodeMenu, describeNode,
        })));
  }

  return { Harness };
}

const harness = makeCanvasHarness();
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(harness.Harness));
