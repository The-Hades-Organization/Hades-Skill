/* Minimapa do canvas do Argos: quadro pequeno com os nós e o viewport; clicar ou arrastar leva
 * a câmera. Script clássico: registra window.ArgosCanvasMinimap = { CanvasMinimap }. Depende de React e de
 * window.CanvasModel (camera, minimap). A regra de projeção mora em src/lib/canvas-minimap.ts; aqui só se desenha e se coleta. */
import type { Camera, Rect, Viewport } from "../../../../src/lib/canvas-camera.ts";
import type * as MinimapModule from "../../../../src/lib/canvas-minimap.ts";

interface MinimapModelApi {
  minimap: typeof MinimapModule;
}

interface CanvasMinimapProps {
  /** Retângulos dos nós no mundo. */
  rects: readonly Rect[];
  camera: Camera;
  /** Tamanho da tela do canvas, em pixels. */
  view: Viewport;
  /** Tamanho do quadro do minimapa, em pixels. */
  size?: Viewport;
  /** Câmera nova pedida por clique ou arrasto no minimapa. */
  onCamera(cam: Camera): void;
  /** Rótulo acessível do botão do minimapa. */
  label?: string;
}

const DEFAULT_SIZE: Viewport = { w: 176, h: 120 };

function makeCanvasMinimap() {
  const g = globalThis as unknown as { CanvasModel: MinimapModelApi };
  const M = g.CanvasModel.minimap;
  const { useRef, useMemo, useCallback, useState, createElement: h } = React;

  function CanvasMinimap({ rects, camera, view, size = DEFAULT_SIZE, onCamera, label = "Minimapa do canvas" }: CanvasMinimapProps) {
    const frame = useRef<HTMLDivElement | null>(null);
    const [dragging, setDragging] = useState(false);
    const quadro = useMemo(() => {
      try {
        return M.minimapView(rects, camera, view, size);
      } catch (err) {
        // entrada fora dos limites (nós demais, câmera inválida): sem quadro, o canvas segue funcionando
        console.warn("minimapa indisponível", err);
        return undefined;
      }
    }, [rects, camera, view, size]);

    const move = useCallback(
      (ev: React.PointerEvent) => {
        const box = frame.current?.getBoundingClientRect();
        if (!box || !quadro) return;
        onCamera(M.minimapCamera(quadro.projection, { x: ev.clientX - box.left, y: ev.clientY - box.top }, camera, view));
      },
      [quadro, camera, view, onCamera],
    );

    if (!quadro) return null;
    return h(
      "div",
      {
        ref: frame,
        role: "img",
        "aria-label": label,
        className: "elev-float relative overflow-hidden bg-card touch-none cursor-pointer",
        style: { width: size.w, height: size.h },
        onPointerDown: (ev: React.PointerEvent) => {
          (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
          setDragging(true);
          move(ev);
        },
        onPointerMove: (ev: React.PointerEvent) => dragging && move(ev),
        onPointerUp: () => setDragging(false),
        onPointerCancel: () => setDragging(false),
      },
      quadro.nodes.map((r, i) =>
        h("div", { key: i, className: "absolute bg-muted-foreground/60", style: { left: r.x, top: r.y, width: r.w, height: r.h } }),
      ),
      h("div", {
        className: "absolute border border-foreground bg-foreground/10 pointer-events-none",
        style: { left: quadro.viewport.x, top: quadro.viewport.y, width: quadro.viewport.w, height: quadro.viewport.h },
      }),
    );
  }

  return { CanvasMinimap };
}

(globalThis as unknown as { ArgosCanvasMinimap: ReturnType<typeof makeCanvasMinimap> }).ArgosCanvasMinimap = makeCanvasMinimap();
