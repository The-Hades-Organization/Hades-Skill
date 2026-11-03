/* Camadas sobre o motor do canvas do Argos (montadas em #/argos): compõe o menu de contexto, o balão do nó, a permissão
 * pendente no nó, o minimapa e os gestos de toque num só componente. Script clássico: registra window.ArgosCanvasOverlays.
 * Depende de React, de window.CanvasModel (camera, touch) e dos scripts ArgosCanvasMenu, ArgosNodeBalloon, ArgosNodePermission
 * e ArgosCanvasMinimap. Só compõe e encaminha: não busca dado, não lê estado global (os módulos entram por `makeCanvasOverlays`)
 * e não decide regra; o que vale agora é de cada componente e dos modelos puros. Cada camada liga quando a prop dela vem. */
import type { ActionNode } from "../../../../src/lib/canvas-actions.ts";
import type * as CameraModule from "../../../../src/lib/canvas-camera.ts";
import type { Camera, PinchStart, Rect, Vec, Viewport } from "../../../../src/lib/canvas-camera.ts";
import type * as TouchModule from "../../../../src/lib/canvas-touch.ts";
import type { TouchEvent as GestureEvent } from "../../../../src/lib/canvas-touch.ts";
import type { ArgosCanvasMenuApi, CanvasMenuProps } from "./canvas-menu.tsx";
import type { NodeBalloonProps } from "./node-balloon.tsx";
import type { NodePermissionProps } from "./node-permission.tsx";

/** Nó visível: o dado que as ações leem e o retângulo no mundo (a câmera leva à tela). */
interface OverlayNode {
  node: ActionNode;
  rect: Rect;
}

/** O menu abre quando a prop vem: `target` e `at` dizem onde e sobre o quê; quem fecha é `onClose`. */
type MenuLayer<Ctx> = Omit<CanvasMenuProps<Ctx>, "view">;
/** O balão abre no nó `nodeId` (um dos `nodes`); id que não está entre eles não desenha nada. */
interface BalloonLayer extends Omit<NodeBalloonProps, "node" | "anchor" | "view"> {
  nodeId: string;
}
interface PermissionLayer extends Omit<NodePermissionProps, "node" | "className"> {}
interface MinimapLayer {
  onCamera(cam: Camera): void;
  size?: Viewport;
  label?: string;
}
interface TouchLayer {
  /** Elemento que recebe os dedos (o quadro do canvas): a camada escuta nele e devolve `touch-action` ao sair. */
  surface: HTMLElement | null;
  onCamera(cam: Camera): void;
  /** Toque curto e toque longo, em pixels do `surface`; a página decide (o toque longo costuma abrir o menu). */
  onTap?(at: Vec): void;
  onLongPress?(at: Vec): void;
  /** Gesto inválido (ponto não finito): sem isso a falha só vai ao console. */
  onError?(message: string): void;
}

interface CanvasOverlaysProps<Ctx = unknown> {
  camera: Camera;
  /** Tamanho da tela do canvas, em pixels. */
  view: Viewport;
  /** Só os nós visíveis: o minimapa e as permissões são desenhados a partir deles. */
  nodes: readonly OverlayNode[];
  menu?: MenuLayer<Ctx>;
  balloon?: BalloonLayer;
  permission?: PermissionLayer;
  minimap?: MinimapLayer;
  touch?: TouchLayer;
}

interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

interface OverlayDeps {
  Menu: ArgosCanvasMenuApi["CanvasMenu"];
  Balloon: (props: NodeBalloonProps) => unknown;
  Permission: (props: NodePermissionProps) => unknown;
  Minimap: (props: { rects: readonly Rect[]; camera: Camera; view: Viewport; size?: Viewport; onCamera(cam: Camera): void; label?: string }) => unknown;
  camera: Pick<typeof CameraModule, "panBy" | "pinchCamera" | "worldToScreen">;
  touch: Pick<typeof TouchModule, "createTouchRecognizer">;
  /** Relógio monotônico e temporizadores do reconhecedor de toque (entram aqui para o teste ser determinístico). */
  now(): number;
  timers: Timers;
}

/** Quantas caixas de permissão aparecem ao mesmo tempo: o excedente continua pedindo, e o painel de agentes mostra. */
const MAX_PERMISSION_BOXES = 24;
const PERMISSION_MIN_WIDTH_PX = 224;
const PERMISSION_GAP_PX = 4;
const MINIMAP_CORNER = "absolute bottom-2 right-2 z-10";
/** De quanto em quanto tempo o reconhecedor confere o toque longo (o limite é de `TOUCH_LIMITS.longPressMs`). */
const TOUCH_TICK_MS = 100;
const TOUCH_POINTER = "touch";
const ENABLE_POINTER = "pointer-events-auto";

interface PermissionSlot {
  node: ActionNode;
  x: number;
  y: number;
  w: number;
}

/** O retângulo do mundo na tela (pixels do canvas). */
const screenRect = (cam: Camera, rect: Rect, toScreen: OverlayDeps["camera"]["worldToScreen"]): Rect => {
  const origin = toScreen(cam, rect);
  return { x: origin.x, y: origin.y, w: rect.w * cam.k, h: rect.h * cam.k };
};

const intersects = (a: Rect, view: Viewport): boolean => a.x < view.w && a.x + a.w > 0 && a.y < view.h && a.y + a.h > 0;

/**
 * Onde cada caixa de permissão fica: embaixo do nó, na largura dele (com um mínimo legível), dentro da tela na horizontal.
 * Nó fora da tela não ganha caixa. Só entram os ids de `wanted`, na ordem de `nodes`, até o teto.
 */
function permissionSlots(nodes: readonly OverlayNode[], wanted: ReadonlySet<string>, cam: Camera, view: Viewport, toScreen: OverlayDeps["camera"]["worldToScreen"]): PermissionSlot[] {
  const slots: PermissionSlot[] = [];
  for (const { node, rect } of nodes) {
    if (slots.length >= MAX_PERMISSION_BOXES) break;
    if (!wanted.has(node.id)) continue;
    const on = screenRect(cam, rect, toScreen);
    if (!intersects(on, view)) continue;
    const w = Math.min(Math.max(on.w, PERMISSION_MIN_WIDTH_PX), view.w);
    slots.push({ node, x: Math.min(Math.max(on.x, 0), view.w - w), y: on.y + on.h + PERMISSION_GAP_PX, w });
  }
  return slots;
}

/**
 * O gesto vira câmera: arrastar de um dedo é `panBy`; a pinça é `pinchCamera` contra a câmera do primeiro `pinch` do gesto
 * (guardada em `pinch` até o `end`). Toque curto e longo não mexem na câmera.
 */
function gestureCamera(event: GestureEvent, cam: Camera, pinch: PinchStart | undefined, math: OverlayDeps["camera"]): { camera?: Camera; pinch: PinchStart | undefined } {
  switch (event.type) {
    case "pan":
      return { camera: math.panBy(cam, event.dx, event.dy), pinch };
    case "pinch": {
      const start = pinch ?? { cam, a: event.startA, b: event.startB };
      return { camera: math.pinchCamera(start, event.a, event.b), pinch: start };
    }
    case "end":
      return { pinch: undefined };
    case "tap":
    case "longpress":
      return { pinch };
  }
}

function makeCanvasOverlays(deps: OverlayDeps) {
  /** Gestos de toque no `surface`: sem elemento visível, só escuta e devolve; tudo que abriu fecha com a camada. */
  function TouchGestures(props: TouchLayer & { camera: Camera }): null {
    const { surface } = props;
    const live = React.useRef(props);
    live.current = props;
    React.useEffect(() => {
      if (!surface) return undefined;
      const recognizer = deps.touch.createTouchRecognizer(deps.now);
      const fingers = new Set<number>();
      let pinch: PinchStart | undefined;
      let ticker: unknown;
      const stopTicker = (): void => {
        if (ticker !== undefined) deps.timers.clear(ticker);
        ticker = undefined;
      };
      const apply = (events: readonly GestureEvent[]): void => {
        for (const event of events) {
          const cur = live.current;
          const step = gestureCamera(event, cur.camera, pinch, deps.camera);
          pinch = step.pinch;
          if (step.camera) {
            // vários eventos antes de a página redesenhar: o próximo parte da câmera que acabou de sair
            live.current = { ...cur, camera: step.camera };
            cur.onCamera(step.camera);
          }
          if (event.type === "tap") cur.onTap?.(event.at);
          if (event.type === "longpress") cur.onLongPress?.(event.at);
        }
      };
      const guard = (run: () => GestureEvent[]): void => {
        try {
          apply(run());
        } catch (error) {
          recognizer.cancel();
          fingers.clear();
          pinch = undefined;
          stopTicker();
          (live.current.onError ?? console.warn)(error instanceof Error ? error.message : "gesto de toque inválido");
        }
      };
      const local = (ev: PointerEvent): Vec => {
        const box = surface.getBoundingClientRect();
        return { x: ev.clientX - box.left, y: ev.clientY - box.top };
      };
      const touchOnly = (ev: PointerEvent): boolean => ev.pointerType === TOUCH_POINTER;
      const onDown = (ev: PointerEvent): void => {
        if (!touchOnly(ev)) return;
        fingers.add(ev.pointerId);
        if (ticker === undefined) ticker = deps.timers.set(() => guard(() => recognizer.tick()), TOUCH_TICK_MS);
        guard(() => recognizer.down(ev.pointerId, local(ev)));
      };
      const onMove = (ev: PointerEvent): void => {
        if (touchOnly(ev)) guard(() => recognizer.move(ev.pointerId, local(ev)));
      };
      const onUp = (ev: PointerEvent): void => {
        if (!touchOnly(ev)) return;
        fingers.delete(ev.pointerId);
        if (fingers.size === 0) stopTicker();
        guard(() => recognizer.up(ev.pointerId));
      };
      const onCancel = (ev: PointerEvent): void => {
        if (!touchOnly(ev)) return;
        recognizer.cancel();
        fingers.clear();
        pinch = undefined;
        stopTicker();
      };
      const previousAction = surface.style.touchAction;
      surface.style.touchAction = "none";
      surface.addEventListener("pointerdown", onDown);
      surface.addEventListener("pointermove", onMove);
      surface.addEventListener("pointerup", onUp);
      surface.addEventListener("pointercancel", onCancel);
      return () => {
        surface.removeEventListener("pointerdown", onDown);
        surface.removeEventListener("pointermove", onMove);
        surface.removeEventListener("pointerup", onUp);
        surface.removeEventListener("pointercancel", onCancel);
        surface.style.touchAction = previousAction;
        recognizer.cancel();
        stopTicker();
      };
    }, [surface]);
    return null;
  }

  /**
   * Uma caixa por nó com permissão pendente. O nó que já pediu continua montado enquanto estiver visível: é o que deixa a
   * confirmação ("Aprovada…") na tela depois que o grafo limpa o pedido. Nó que sai de `nodes` esquece.
   */
  function PermissionBoxes(props: PermissionLayer & Pick<CanvasOverlaysProps, "camera" | "view" | "nodes">) {
    const { camera, view, nodes, ...rest } = props;
    const h = React.createElement;
    const asked = React.useRef<Set<string>>(new Set());
    const present = new Set(nodes.map((n) => n.node.id));
    for (const id of [...asked.current]) if (!present.has(id)) asked.current.delete(id);
    for (const { node } of nodes) if (node.pendingPermission) asked.current.add(node.id);
    const slots = permissionSlots(nodes, asked.current, camera, view, deps.camera.worldToScreen);
    return h(
      React.Fragment,
      null,
      slots.map((slot) =>
        h(
          "div",
          { key: slot.node.id, className: `absolute z-10 ${ENABLE_POINTER}`, style: { left: slot.x, top: slot.y, width: slot.w } },
          h(deps.Permission, { ...rest, node: slot.node }),
        ),
      ),
    );
  }

  /**
   * Da base para o topo: minimapa e permissões (z-10), balão (z-20), menu (z-30). A camada de cima fica sobre a de baixo, e o
   * menu cobre tudo. O quadro é transparente aos ponteiros; só as caixas das camadas os recebem.
   */
  function CanvasOverlays<Ctx = unknown>(props: CanvasOverlaysProps<Ctx>) {
    const { camera, view, nodes, menu, balloon, permission, minimap, touch } = props;
    const h = React.createElement;
    const layers: unknown[] = [];
    if (minimap) {
      const { onCamera, size, label } = minimap;
      layers.push(
        h("div", { key: "minimap", "data-tour-step-id": "argos-minimapa", className: `${MINIMAP_CORNER} ${ENABLE_POINTER}` },
          h(deps.Minimap, { rects: nodes.map((n) => n.rect), camera, view, onCamera, ...(size ? { size } : {}), ...(label ? { label } : {}) })),
      );
    }
    if (permission) layers.push(h(PermissionBoxes, { key: "permission", ...permission, camera, view, nodes }));
    const target = balloon ? nodes.find((n) => n.node.id === balloon.nodeId) : undefined;
    if (balloon && target) {
      const { nodeId: _nodeId, ...rest } = balloon;
      layers.push(
        h("div", { key: "balloon", className: ENABLE_POINTER },
          h(deps.Balloon, { ...rest, node: target.node, anchor: screenRect(camera, target.rect, deps.camera.worldToScreen), view })),
      );
    }
    if (menu) layers.push(h("div", { key: "menu", className: ENABLE_POINTER }, h(deps.Menu as (p: CanvasMenuProps<Ctx>) => unknown, { ...menu, view })));
    if (touch) layers.push(h(TouchGestures, { key: "touch", ...touch, camera }));
    return h("div", { className: "pointer-events-none absolute inset-0 overflow-hidden", "data-canvas-overlays": true }, ...layers);
  }

  return { CanvasOverlays, TouchGestures, PermissionBoxes };
}

function readDeps(): OverlayDeps {
  const g = globalThis as unknown as {
    CanvasModel?: { camera?: OverlayDeps["camera"]; touch?: OverlayDeps["touch"] };
    ArgosCanvasMenu?: ArgosCanvasMenuApi;
    ArgosNodeBalloon?: { NodeBalloon: OverlayDeps["Balloon"] };
    ArgosNodePermission?: { NodePermission: OverlayDeps["Permission"] };
    ArgosCanvasMinimap?: { CanvasMinimap: OverlayDeps["Minimap"] };
  };
  const model = g.CanvasModel;
  if (!model?.camera || !model.touch) throw new Error("ArgosCanvasOverlays: carregue /ui/lib/canvas-model.js (com `camera` e `touch`) antes de canvas-overlays.js");
  if (!g.ArgosCanvasMenu || !g.ArgosNodeBalloon || !g.ArgosNodePermission || !g.ArgosCanvasMinimap) {
    throw new Error("ArgosCanvasOverlays: carregue canvas-menu.js, node-permission.js, node-balloon.js e canvas-minimap.js antes de canvas-overlays.js");
  }
  return {
    Menu: g.ArgosCanvasMenu.CanvasMenu,
    Balloon: g.ArgosNodeBalloon.NodeBalloon,
    Permission: g.ArgosNodePermission.NodePermission,
    Minimap: g.ArgosCanvasMinimap.CanvasMinimap,
    camera: model.camera,
    touch: model.touch,
    now: () => performance.now(),
    timers: { set: (run, ms) => setInterval(run, ms), clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>) },
  };
}

const api = { ...makeCanvasOverlays(readDeps()), makeCanvasOverlays, permissionSlots, gestureCamera, MAX_PERMISSION_BOXES, TOUCH_TICK_MS };
type ArgosCanvasOverlaysApi = typeof api;
(globalThis as unknown as { ArgosCanvasOverlays: ArgosCanvasOverlaysApi }).ArgosCanvasOverlays = api;
export type { ArgosCanvasOverlaysApi, CanvasOverlaysProps, OverlayDeps, OverlayNode, PermissionSlot, Timers };
