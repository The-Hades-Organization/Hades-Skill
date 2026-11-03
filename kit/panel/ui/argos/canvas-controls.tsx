/* Controles de câmera do canvas do Argos (canto inferior direito): aproximar, afastar, enquadrar tudo e o nível de zoom
 * (clicar nele volta a 100%). Script clássico: registra window.ArgosCanvasControls. Depende de window.CanvasModel
 * (/ui/lib/canvas-model.js) e de React; usa Button e ícones do HadesCore quando a página os tem e botão nativo sem eles.
 * A regra (limites, passos, nível) mora em src/lib/canvas-camera.ts; aqui só se desenha e se liga ao motor.
 * Também entrega os comandos de câmera para o registro de comandos (`registerCameraCommands`, `cameraHandlers`). */
import type { Camera, CameraHandlers } from "../../../../src/lib/canvas-camera.ts";
import type * as CameraModule from "../../../../src/lib/canvas-camera.ts";
import type { CommandRegistry } from "../../../../src/lib/canvas-commands.ts";
import type { CanvasEngineApi } from "./canvas-engine.tsx";

/** Quanto tempo o zoom fica parado antes de o leitor de tela ouvir o nível novo (pinça e roda mudam a cada quadro). */
const ANNOUNCE_IDLE_MS = 500;
const GROUP_LABEL = "Controles de câmera do canvas";

type ControlId = "undo" | "redo" | "zoom-out" | "zoom-level" | "zoom-in" | "fit";

/** Um controle como a tela o mostra: o nome acessível, a dica com o atalho, se vale agora e o que faz. */
interface ControlItem {
  id: ControlId;
  label: string;
  title: string;
  /** Texto visível do controle de nível; os demais mostram só o ícone. */
  text?: string;
  disabled: boolean;
  run(): void;
}

interface ControlActions {
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  fitAll(): void;
}

/** Desfazer e refazer entram no mesmo grupo da câmera quando a página os passa. */
interface HistoryControls {
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
}

interface CanvasControlsProps {
  /** O motor; `null` enquanto ele não nasceu (nada é desenhado). */
  api: CanvasEngineApi | null;
  history?: HistoryControls;
  className?: string;
}

/** O que `renderControls` precisa para desenhar: a fábrica de elementos e, se houver, os componentes da página. */
interface ControlsUi {
  h: ReactApi["createElement"];
  Button?: PanelComponent;
  icons?: Partial<Record<ControlId, IconComponent>>;
  className?: string;
}

function makeArgosCanvasControls() {
  const model = (globalThis as unknown as { CanvasModel?: { camera: typeof CameraModule } }).CanvasModel;
  if (!model) throw new Error("ArgosCanvasControls: carregue /ui/lib/canvas-model.js antes de canvas-controls.js");
  const C = model.camera;

  /** Os quatro controles na ordem da tela, com o nível de zoom do momento. */
  function controlsModel(k: number, actions: ControlActions, history?: HistoryControls): ControlItem[] {
    const past: ControlItem[] = history
      ? [
          { id: "undo", label: "Desfazer", title: "Desfazer (Ctrl+Z)", disabled: !history.canUndo, run: history.onUndo },
          { id: "redo", label: "Refazer", title: "Refazer (Ctrl+Shift+Z)", disabled: !history.canRedo, run: history.onRedo },
        ]
      : [];
    return [
      ...past,
      { id: "zoom-out", label: "Afastar", title: "Afastar (Ctrl+-)", disabled: !C.canZoom(k, -1), run: actions.zoomOut },
      {
        id: "zoom-level",
        label: `Nível de zoom: ${C.zoomLabel(k)}. Ativar volta a 100%`,
        title: "Voltar a 100% (Ctrl+0)",
        text: C.zoomLabel(k),
        disabled: false,
        run: actions.zoomReset,
      },
      { id: "zoom-in", label: "Aproximar", title: "Aproximar (Ctrl+=)", disabled: !C.canZoom(k, 1), run: actions.zoomIn },
      { id: "fit", label: "Enquadrar tudo", title: "Enquadrar tudo (F)", disabled: false, run: actions.fitAll },
    ];
  }

  const BUTTON_CLASS = "inline-flex size-8 cursor-pointer items-center justify-center t-label text-foreground outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring disabled:cursor-default disabled:opacity-40 max-md:size-11";
  const LEVEL_CLASS = "inline-flex h-8 min-w-14 cursor-pointer items-center justify-center px-2 t-label tabular-nums text-foreground outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring max-md:h-11";

  /** Árvore de elementos dos controles: pura, sem hooks, para o teste ler sem DOM. */
  function renderControls(ui: ControlsUi, items: readonly ControlItem[], said: string): ReactNode {
    const { h, Button, icons } = ui;
    const buttons = items.map((item) => {
      const Icon = icons?.[item.id];
      const common = { key: item.id, type: "button", "aria-label": item.label, title: item.title, disabled: item.disabled, onClick: item.run };
      if (Button) return h(Button, { ...common, variant: "ghost", size: item.text ? "sm" : "icon-sm", icon: Icon }, item.text);
      return h("button", { ...common, className: item.text ? LEVEL_CLASS : BUTTON_CLASS }, item.text ?? GLYPH[item.id]);
    });
    return h("div", { className: ui.className, role: "group", "aria-label": GROUP_LABEL, "data-region": "camera", "data-tour-step-id": "argos-camera" },
      ...buttons,
      // o nível só é anunciado quando o zoom para: a região fica fora da tela
      h("span", { role: "status", className: "sr-only" }, said));
  }

  const GLYPH: Record<ControlId, string> = { undo: "↶", redo: "↷", "zoom-out": "−", "zoom-level": "", "zoom-in": "+", fit: "⤢" };
  const DEFAULT_CLASS = "absolute right-2 bottom-2 z-10 flex items-center elev-float bg-background";

  function CanvasControls(props: CanvasControlsProps): ReactNode {
    const { api } = props;
    const [k, setK] = React.useState<number>(api ? api.getCamera().k : C.DEFAULT_CAMERA.k);
    const [said, setSaid] = React.useState("");
    React.useEffect(() => {
      if (!api) return undefined;
      setK(api.getCamera().k);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = api.onCamera((cam: Camera) => {
        setK(cam.k);
        clearTimeout(timer);
        timer = setTimeout(() => setSaid(`Zoom ${C.zoomLabel(cam.k)}`), ANNOUNCE_IDLE_MS);
      });
      // o ouvinte e o temporizador têm o mesmo dono: saem juntos
      return () => {
        off();
        clearTimeout(timer);
      };
    }, [api]);
    if (!api) return null;
    const core = typeof HadesCore === "undefined" ? undefined : HadesCore;
    const actions: ControlActions = { zoomIn: () => api.zoomIn(), zoomOut: () => api.zoomOut(), zoomReset: () => api.zoomReset(), fitAll: () => api.fitAll(true) };
    return renderControls({
      h: React.createElement,
      Button: core?.Button,
      icons: core ? { undo: core.I.Undo2, redo: core.I.Redo2, "zoom-out": core.I.Minus, "zoom-in": core.I.Plus, fit: core.I.Maximize } : undefined,
      className: props.className ?? DEFAULT_CLASS,
    }, controlsModel(k, actions, props.history), said);
  }

  /** Liga os comandos de câmera ao motor da página. `getApi` e `getPrimary` são lidos na hora de executar (o motor nasce depois). */
  function cameraHandlers(getApi: () => CanvasEngineApi | null | undefined, getPrimary: () => string | null | undefined): CameraHandlers {
    return {
      zoomIn: () => getApi()?.zoomIn(),
      zoomOut: () => getApi()?.zoomOut(),
      zoomReset: () => getApi()?.zoomReset(),
      fitSelection: () => getApi()?.fitSelection(),
      focusNode: () => {
        const id = getPrimary();
        if (id) getApi()?.centerNode(id);
      },
    };
  }

  /** Registra os comandos de câmera uma vez (chamar de novo, p.ex. no modo estrito do React, não repete nem lança). */
  function registerCameraCommands(registry: CommandRegistry<CameraModule.CameraCommandCtx>): void {
    for (const def of C.cameraCommandDefs<CameraModule.CameraCommandCtx>()) if (!registry.get(def.id)) registry.register(def);
  }

  return { CanvasControls, controlsModel, renderControls, cameraHandlers, registerCameraCommands, GROUP_LABEL };
}

type ArgosCanvasControlsApi = ReturnType<typeof makeArgosCanvasControls>;
(globalThis as unknown as { ArgosCanvasControls: ArgosCanvasControlsApi }).ArgosCanvasControls = makeArgosCanvasControls();
export type { ArgosCanvasControlsApi, CanvasControlsProps, ControlItem, HistoryControls };
