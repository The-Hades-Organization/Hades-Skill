/* Motor do canvas do Argos: câmera, desenho em camadas, seleção e manipulação direta, teclado e leitor de tela.
 * Script clássico: registra window.ArgosCanvas = { createCanvasEngine, CanvasView }. Depende de window.CanvasModel
 * (/ui/lib/canvas-model.js, os módulos de src/lib) e, só no CanvasView, de React. A regra (câmera, acerto, seleção,
 * operações) mora nos módulos do modelo; aqui ficam os eventos, o desenho e o foco. Os `import type` somem na transpilação. */
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../../../../src/lib/canvas-doc.ts";
import type { CanvasOp } from "../../../../src/lib/canvas-history.ts";
import type { Camera, Detail, Rect, SelectionOrigin, Vec, Viewport } from "../../../../src/lib/canvas-camera.ts";
import type * as DocModule from "../../../../src/lib/canvas-doc.ts";
import type * as HistoryModule from "../../../../src/lib/canvas-history.ts";
import type * as CameraModule from "../../../../src/lib/canvas-camera.ts";
import type * as SelectionModule from "../../../../src/lib/canvas-selection.ts";
import type * as ArgosModule from "../../../../src/lib/canvas-argos.ts";
import type { Shape } from "../../../../src/lib/canvas-argos.ts";
import type { SnapGuide, SnapMove, SnapOptions } from "../../../../src/lib/canvas-snap.ts";
import type * as LinksModule from "../../../../src/lib/canvas-links.ts";
import type { ClampHit, LinkStyle, Rope, RopePin } from "../../../../src/lib/canvas-links.ts";

interface CanvasModelApi {
  doc: typeof DocModule;
  history: typeof HistoryModule;
  camera: typeof CameraModule;
  selection: typeof SelectionModule;
  /** Só `shapePoints` é lido, e só quando a página passa `nodeShape`. */
  argos: typeof ArgosModule;
  /** Conexões do dono (aresta `link`); sem o módulo, a aresta `link` sai reta como as outras e a ferramenta não arma. */
  links?: typeof LinksModule;
}

/** Pedido de menu do nó (Enter, tecla de menu, Shift+F10). O menu em si é de quem usa o motor. */
interface NodeMenuRequest {
  id: string;
  /** Centro do nó em pixels, relativo ao canto do canvas. */
  screen: Vec;
}

interface FrameInfo {
  /** Tempo de CPU do quadro (desenho das camadas sujas), em ms. */
  ms: number;
  at: number;
  visible: number;
  detail: Detail;
  /** Cordas no quadro e quantas a física andou nele (fora do viewport nenhuma anda). */
  ropes: { visible: number; stepped: number };
}

interface CanvasEngineOptions {
  doc: CanvasDoc;
  selection: readonly string[];
  /** `origin` diz quem selecionou: a página só leva a câmera ao nó quando foi o dono (`selectionRevealsCamera`). */
  onSelectionChange(ids: readonly string[], origin?: SelectionOrigin): void;
  /** Gesto terminado: uma operação do canvas-history e o documento já com ela. O motor não grava nada sozinho. */
  onOp(op: CanvasOp, next: CanvasDoc): void;
  onNodeMenu?(req: NodeMenuRequest): void;
  onCameraChange?(cam: Camera): void;
  /** Nós com conteúdo HTML visíveis no detalhe completo (a camada HTML os desenha); lista vazia longe. */
  onRichNodes?(ids: readonly string[]): void;
  /** Rótulo do nó (desenho e nome acessível); padrão: tipo e id. */
  describeNode?(node: CanvasNode): string;
  /** Cor do nó (bloco de longe, faixa do cabeçalho de perto); padrão: uma cor da paleta por tipo. */
  nodeColor?(node: CanvasNode): string;
  /** Se o nó tem conteúdo HTML (camada por cima); padrão: nenhum. */
  isRich?(node: CanvasNode): boolean;
  /** Escala a partir da qual o nó aparece completo (com o conteúdo HTML); padrão `DETAIL_THRESHOLDS.full`. */
  fullDetail?: number;
  /**
   * Forma do nó no desenho de longe (ponto) e no bloco; sem a prop, ou devolvendo `square`, o nó é o retângulo de sempre.
   * Nó com conteúdo HTML (`isRich`) volta ao retângulo no detalhe completo, porque a camada HTML por cima é retangular.
   * O acerto do clique, a seleção e o anel seguem o retângulo do nó.
   */
  nodeShape?(node: CanvasNode): Shape;
  /** Arrastar o fundo: `pan` (padrão; Shift+arrasto faz o retângulo de seleção) ou `select` (retângulo; pan pelo botão do meio). */
  backgroundDrag?: "pan" | "select";
  /** Câmera inicial; sem ela, o motor enquadra todos os nós no primeiro quadro. */
  initialCamera?: Camera;
  /** Nome acessível da área do canvas. */
  label?: string;
  /** Sem ela, o arrasto encaixa só na grade, como sempre. */
  snap?: CanvasSnapHook;
  /** Sem ela, duplo clique e soltar na borda não fazem nada de novo. */
  dock?: CanvasDockHook;
  /** Conexão armada (`from`) ou desarmada (`undefined`): a página acende a ferramenta na barra. */
  onLinkState?(from: string | undefined): void;
}

interface CanvasEngineApi {
  getCamera(): Camera;
  setCamera(cam: Camera, animate?: boolean): void;
  fitAll(animate?: boolean): void;
  fitRect(rect: Rect, animate?: boolean): void;
  /** Zoom pelo fator em torno de `anchor` (padrão: centro da tela); instantâneo, a menos que `animate`. */
  zoomBy(factor: number, anchor?: Vec, animate?: boolean): void;
  /** Um passo de zoom em torno do centro da tela (o mesmo das teclas `+` e `-`). */
  zoomIn(animate?: boolean): void;
  zoomOut(animate?: boolean): void;
  /** Escala 100% em torno do centro da tela. */
  zoomReset(animate?: boolean): void;
  /** Enquadra os nós selecionados (zoom limitado a `focusZoomMax`); sem seleção, enquadra tudo. */
  fitSelection(animate?: boolean): void;
  /** Câmera no nó `id`: centraliza e garante o detalhe completo. Não mexe no foco do teclado (veja `focusNode`). */
  centerNode(id: string, animate?: boolean): void;
  /** Ouve cada mudança de câmera (gesto, teclado, API, animação); devolve o cancelamento. */
  onCamera(listener: (cam: Camera) => void): () => void;
  /** Leva o foco do teclado ao nó e o traz para a tela. */
  focusNode(id: string): void;
  revealNode(id: string, animate?: boolean): void;
  viewport(): Viewport;
  /** Ouve cada quadro desenhado (harness de escala, contador de fps); devolve o cancelamento. */
  onFrame(listener: (frame: FrameInfo) => void): () => void;
  /** Mostra um documento provisório sem passar pelas props (quadros de um layout animado); o próximo `doc` das props vence. */
  showDoc(doc: CanvasDoc): void;
  /** Opacidade por nó (destaque de vizinhança, resultado de busca), multiplicada pela do `blurred`; `null` volta tudo ao normal. */
  setEmphasis(alpha: ReadonlyMap<string, number> | null): void;
  /** Tamanho mínimo por nó para a alça de redimensionar (o nó de agente como terminal); `null` volta ao lado mínimo de sempre. */
  setMinSize(minSizeOf: NodeMinSize | null): void;
  /**
   * Arma a ferramenta Conexão a partir de `from` (padrão: o único selecionado, senão o nó focado): uma linha segue o cursor
   * e o clique (ou Enter no nó focado) num terminal ou nota completa; Esc, clique no vazio ou botão direito cancelam.
   * Devolve `false` (e anuncia) se a ponta não conecta.
   */
  startLink(from?: string): boolean;
  cancelLink(): void;
}

type NodeMinSize = (node: CanvasNode) => { w: number; h: number } | undefined;

/** Encaixe magnético do arrasto: a regra é de canvas-snap (`snapSelectionMove`); o motor só pergunta e desenha as guias. */
interface CanvasSnapHook {
  /** Modo ligado na tela; com ele desligado, Ctrl (ou Cmd) segurado ao arrastar encaixa do mesmo jeito. */
  enabled(): boolean;
  move(doc: CanvasDoc, ids: readonly string[], delta: { dx: number; dy: number }, options: SnapOptions): SnapMove;
}

type DockEdgeName = "left" | "right";

/** Elevar e acoplar (canvas-dock): estado de tela, de quem usa o motor. */
interface CanvasDockHook {
  /** Duplo clique no cabeçalho do nó. */
  toggleElevated(id: string): void;
  /** Borda em que soltar acopla, para um ponto em pixels do canvas; `undefined` fora das faixas. */
  edgeAt(point: Vec, view: Viewport): DockEdgeName | undefined;
  /** Largura da faixa de cada borda, em pixels (o realce que o motor desenha durante o arrasto). */
  edgeZone: number;
  /** Nó solto na faixa da borda: acopla em vez de mover. */
  dock(id: string, edge: DockEdgeName): void;
}

/** Elementos que o motor usa: `canvasBox` e `a11yBox` vazios (o motor os preenche), `htmlLayer` com os nós ricos. */
interface CanvasParts {
  host: HTMLElement;
  canvasBox: HTMLElement;
  htmlLayer: HTMLElement;
  a11yBox: HTMLElement;
}

interface CanvasEngine {
  update(next: Partial<CanvasEngineOptions>): void;
  /** Registra o elemento HTML do nó rico `id` (ref do React); `null` desfaz. */
  bindHtml(id: string, el: HTMLElement | null): void;
  api: CanvasEngineApi;
  destroy(): void;
}

interface CanvasViewProps extends CanvasEngineOptions {
  /** Conteúdo HTML do nó rico (só os visíveis no detalhe completo são montados). */
  renderNode?(node: CanvasNode): ReactNode;
  onReady?(api: CanvasEngineApi): void;
  className?: string;
}

type Gesture =
  | { kind: "none" }
  | { kind: "pan"; pointer: number; start: Vec; cam: Camera; moved: boolean; clearOnClick: boolean; onClick: readonly string[] | undefined; grab: boolean }
  | { kind: "pinch"; start: CameraModule.PinchStart; ids: [number, number] }
  | { kind: "marquee"; pointer: number; start: Vec; end: Vec; base: readonly string[]; additive: boolean; moved: boolean }
  | {
    kind: "move"; pointer: number; start: Vec; ids: string[]; set: Set<string>; anchor: string; dx: number; dy: number; moved: boolean; onClick: readonly string[] | undefined;
    /** Ajuste do encaixe magnético da última posição (só quando acendeu alguma guia). */
    snap: SnapMove | undefined;
    /** Ctrl/Cmd segurado no último movimento: o soltar encaixa também. */
    snapKey: boolean;
    /** Borda sob o ponteiro com um nó só sendo arrastado: soltar acopla. */
    edge: DockEdgeName | undefined;
  }
  | { kind: "resize"; pointer: number; start: Vec; id: string; edge: SelectionModule.ResizeEdge; dw: number; dh: number; moved: boolean }
  /** Alt+arrastar: traço no mundo; as cordas que ele cruzar ganham uma abraçadeira ao soltar. */
  | { kind: "clamp-stroke"; pointer: number; start: Vec; from: Vec; end: Vec; moved: boolean }
  /** Abraçadeira arrastada ao longo das cordas: `ts` é o novo `t` de cada conexão presa. */
  | { kind: "clamp-move"; pointer: number; start: Vec; clampId: string; ts: Map<string, number>; moved: boolean };

/** Conexão à vista no quadro: as pontas, a forma desenhada (pontos da corda ou rota do circuito) e as abraçadeiras. */
interface LinkGeom {
  edge: CanvasEdge;
  style: LinkStyle;
  from: CanvasNode;
  a: Vec;
  b: Vec;
  points: readonly Vec[];
  alpha: number;
}

interface LinkFrame {
  geoms: readonly LinkGeom[];
  ropes: number;
  stepped: number;
}

const NO_LINKS: LinkFrame = { geoms: [], ropes: 0, stepped: 0 };
/** Cursor da alça de redimensionar (canto de baixo à direita) e a classe que o impõe sobre o nó rico (index.html). */
const RESIZE_CURSOR_CLASS = "canvas-resize-cursor";

const overlaps = (a: Rect, b: Rect): boolean => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

function boundsOf(points: readonly Vec[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Corda suave: curva pelos pontos médios (o ponto simulado vira o controle). */
function traceRope(ctx: CanvasRenderingContext2D, points: readonly Vec[]): void {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return;
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i + 1 < points.length; i++) {
    const p = points[i] as Vec;
    const q = points[i + 1] as Vec;
    ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
  }
  ctx.lineTo(last.x, last.y);
}

/** Circuito: trechos retos com as curvas arredondadas (raio menor em trecho curto, para a curva caber). */
function traceCircuit(ctx: CanvasRenderingContext2D, points: readonly Vec[], radius: number): void {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return;
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i + 1 < points.length; i++) {
    const prev = points[i - 1] as Vec;
    const p = points[i] as Vec;
    const next = points[i + 1] as Vec;
    const r = Math.min(radius, Math.hypot(p.x - prev.x, p.y - prev.y) / 2, Math.hypot(next.x - p.x, next.y - p.y) / 2);
    ctx.arcTo(p.x, p.y, next.x, next.y, r);
  }
  ctx.lineTo(last.x, last.y);
}

function makeArgosCanvas() {
  const model = (globalThis as unknown as { CanvasModel?: CanvasModelApi }).CanvasModel;
  if (!model) throw new Error("ArgosCanvas: carregue /ui/lib/canvas-model.js antes de canvas-engine.js");
  const C = model.camera;
  const S = model.selection;
  const H = model.history;
  const LINKS = model.links;

  /** Cores lidas das variáveis do tema; o harness e a página definem as mesmas. */
  const THEME_VARS = {
    background: "--background", card: "--card", fg: "--foreground", muted: "--muted-foreground",
    border: "--border", strong: "--border-strong", ring: "--ring", vivo: "--vivo",
  } as const;
  const THEME_FALLBACK: Record<keyof typeof THEME_VARS, string> = {
    background: "#f9f2eb", card: "#fffaf5", fg: "#391a2c", muted: "#7a5a6a", border: "rgba(57,26,44,.14)", strong: "rgba(57,26,44,.3)", ring: "#c8264a", vivo: "#c8264a",
  };
  const PALETTE_VARS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];
  const PALETTE_FALLBACK = ["#c8264a", "#2f6fb5", "#c08a1a", "#2f8a5f", "#9a4f7a"];
  /** Só a linha maior da grade é desenhada; ela some quando fica mais próxima que isto em pixels de tela (vira ruído). */
  const GRID_MIN_PX = 16;
  const GRID_MAJOR = 5;
  /** Piso do rótulo em pixels de tela (`--fs-micro`): o bloco usa ele e o nó cheio nunca fica abaixo dele, então a troca de um para o outro não dá salto. */
  const MIN_LABEL_PX = 11;
  /** Largura máxima, em pixels de tela, do nome posto fora da forma. */
  const OUTSIDE_LABEL_PX = 240;
  /** Fonte do nó completo, em unidades de mundo (cresce com o zoom até passar do piso). */
  const FULL_FONT = 13;
  const FONT_FALLBACK = "ui-sans-serif, system-ui, sans-serif";
  /** Preenchimento do nó trabalhando: o `--vivo` diluído no cartão, para o `--vivo` cheio e o anel ficarem só no que pede atenção. */
  const LIVE_FILL_PCT = 55;
  /** Concluído e ocioso: o tom `muted` diluído no cartão, sem a mancha rosada de longe. */
  const REST_FILL_PCT = 40;
  const mixOver = (color: string, pct: number, base: string): string => `color-mix(in oklch, ${color} ${pct}%, ${base})`;
  /** Conexões: espessura em unidades de mundo (corda, circuito) com piso em pixels de tela, e a abraçadeira em pixels. */
  const ROPE_WIDTH = 3;
  const CIRCUIT_WIDTH = 2;
  const LINK_MIN_PX = 1.25;
  const CLAMP_PX = 11;
  /** Raio do acerto da abraçadeira, em pixels de tela (maior que o desenho: alvo de dedo). */
  const CLAMP_HIT_PX = 12;

  const typeHash = (type: string): number => {
    let hash = 0;
    for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) >>> 0;
    return hash;
  };

  const KNOWN_SHAPES: ReadonlySet<string> = new Set<Shape>(["square", "circle", "diamond", "hexagon"]);
  /** Fração da largura do nó que cabe no rótulo centrado sem sair da forma (a corda horizontal na altura do texto). */
  const LABEL_FIT: Record<Shape, number> = { square: 1, hexagon: 0.7, circle: 0.65, diamond: 0.45 };

  /** Caminho fechado da forma dentro do retângulo do nó (o mesmo `shapePoints` do SVG de perto). */
  function traceShape(ctx: CanvasRenderingContext2D, shape: Shape, n: Rect): void {
    ctx.beginPath();
    let first = true;
    for (const [x, y] of model.argos.shapePoints(shape, n.x, n.y, n.w, n.h)) {
      if (first) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      first = false;
    }
    ctx.closePath();
  }

  /** Preenche o nó pela forma; `square` é o `fillRect` de antes (nenhum caminho montado). */
  function fillShape(ctx: CanvasRenderingContext2D, shape: Shape, n: Rect): void {
    if (shape === "square") {
      ctx.fillRect(n.x, n.y, n.w, n.h);
      return;
    }
    traceShape(ctx, shape, n);
    ctx.fill();
  }

  function strokeShape(ctx: CanvasRenderingContext2D, shape: Shape, n: Rect): void {
    if (shape === "square") {
      ctx.strokeRect(n.x, n.y, n.w, n.h);
      return;
    }
    traceShape(ctx, shape, n);
    ctx.stroke();
  }

  /** A forma pedida por `nodeShape` já filtrada: valor fora do contrato vira `square` com um aviso (uma vez por valor). */
  const warnedShapes = new Set<string>();
  function sanitizeShape(shape: unknown): Shape {
    if (shape === undefined) return "square";
    if (typeof shape === "string" && KNOWN_SHAPES.has(shape)) return shape as Shape;
    const key = String(shape);
    if (!warnedShapes.has(key)) {
      warnedShapes.add(key);
      console.warn(`canvas: nodeShape devolveu forma desconhecida (${key}); desenhando o retângulo`);
    }
    return "square";
  }

  function createCanvasEngine(parts: CanvasParts, initial: CanvasEngineOptions): CanvasEngine {
    const { host, canvasBox, htmlLayer, a11yBox } = parts;
    let opts: CanvasEngineOptions = { ...initial };
    let doc = opts.doc;
    let selected = new Set(opts.selection);
    let cam: Camera = opts.initialCamera ?? { ...C.DEFAULT_CAMERA };
    let fitPending = !opts.initialCamera;
    let view: Viewport = { w: 0, h: 0 };
    let dpr = window.devicePixelRatio || 1;
    let gesture: Gesture = { kind: "none" };
    let focusId: string | undefined;
    let order: string[] = [];
    let orderStale = true;
    let animation: { from: Camera; to: Camera; start: number } | undefined;
    let frameRequested = 0;
    let destroyed = false;
    let richIds: readonly string[] = [];
    let colors = { ...THEME_FALLBACK };
    let palette = [...PALETTE_FALLBACK];
    let softLive = mixOver(THEME_FALLBACK.vivo, LIVE_FILL_PCT, THEME_FALLBACK.card);
    let softRest = mixOver(THEME_FALLBACK.muted, REST_FILL_PCT, THEME_FALLBACK.card);
    let fontFamily = FONT_FALLBACK;
    /** Antes de a fonte do tema carregar o texto sairia na do sistema e mudaria de medida depois: o primeiro desenho espera. */
    let fontsReady = typeof document === "undefined" || !document.fonts;
    const dirty = { grid: true, edges: true, nodes: true, overlay: true };
    const frameListeners = new Set<(frame: FrameInfo) => void>();
    const cameraListeners = new Set<(cam: Camera) => void>();
    /** Espaço segurado (com o foco no canvas): arrastar com o botão principal move a câmera, seja o que for sob o cursor. */
    let spaceHeld = false;
    /** Espaço virou pan: soltar a tecla não seleciona o nó focado. */
    let spaceUsed = false;
    let spaceShift = false;
    const htmlEls = new Map<string, HTMLElement>();
    let emphasis: ReadonlyMap<string, number> | null = null;
    let minSizeOf: NodeMinSize | null = null;
    const alphaOf = (n: CanvasNode): number => (n.blurred ? 0.35 : 1) * (emphasis?.get(n.id) ?? 1);
    const pointers = new Map<number, Vec>();
    const cleanups: (() => void)[] = [];
    const L = LINKS;
    /** Ferramenta Conexão armada: a ponta de origem e o cursor (mundo) para a linha que o segue. */
    let linking: { from: string; cursor: Vec | undefined; target: string | undefined } | undefined;
    let selectedClamp: string | undefined;
    /** Uma corda simulada por conexão `rope`; `seen` é o último quadro em que ela esteve à vista. */
    const ropes = new Map<string, { rope: Rope; seen: number }>();
    let ropesAwake = true;
    let renderNo = 0;
    let lastStepAt = 0;
    /** Conexões à vista no último quadro (o traço da abraçadeira cruza o que está desenhado). */
    let shownLinks: LinkGeom[] = [];

    // ---- índices do documento (refeitos só quando o documento muda) ----
    let byId = new Map<string, CanvasNode>();
    let drawOrder: CanvasNode[] = [];
    let labels = new Map<string, string>();
    let fills = new Map<string, string>();
    const reindex = (): void => {
      byId = new Map(doc.nodes.map((n) => [n.id, n]));
      // z sobe, empate pela ordem do documento: o mesmo critério do hitTest (o de cima é o que recebe o clique)
      drawOrder = doc.nodes.map((n, i) => ({ n, i })).sort((a, b) => a.n.z - b.n.z || a.i - b.i).map((x) => x.n);
      labels = new Map();
      fills = new Map();
      orderStale = true;
      reindexLinks();
    };
    let linkEdges: CanvasEdge[] = [];
    let edgeById = new Map<string, CanvasEdge>();
    let clampIndex = new Map<string, ClampHit[]>();
    function reindexLinks(): void {
      if (!L) return;
      linkEdges = doc.edges.filter(L.isLinkEdge);
      edgeById = new Map(linkEdges.map((edge) => [edge.id, edge]));
      clampIndex = L.clampsOf(doc);
      for (const id of ropes.keys()) if (!edgeById.has(id)) ropes.delete(id);
      if (selectedClamp !== undefined && !clampIndex.has(selectedClamp)) selectedClamp = undefined;
      ropesAwake = true;
    }
    reindex();

    const labelOf = (node: CanvasNode): string => {
      let label = labels.get(node.id);
      if (label === undefined) {
        label = opts.describeNode?.(node) ?? `${node.type} ${node.id}`;
        labels.set(node.id, label);
      }
      return label;
    };
    const fillOf = (node: CanvasNode): string => {
      let fill = fills.get(node.id);
      if (fill === undefined) {
        fill = opts.nodeColor?.(node) ?? (palette[typeHash(node.type) % palette.length] as string);
        // o nó trabalhando e o em repouso chegam na cor cheia do estado; o motor os dilui (o `--vivo` cheio é de "espera por você")
        if (fill === colors.vivo) fill = softLive;
        else if (fill === colors.muted) fill = softRest;
        fills.set(node.id, fill);
      }
      return fill;
    };
    const tabOrder = (): string[] => {
      if (orderStale) {
        order = S.tabOrder(doc.nodes);
        orderStale = false;
      }
      return order;
    };

    // ---- camadas ----
    const makeLayer = (name: string): CanvasRenderingContext2D => {
      const canvas = document.createElement("canvas");
      canvas.dataset.layer = name;
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none";
      canvasBox.appendChild(canvas);
      const ctx = canvas.getContext("2d", { alpha: name !== "grid" });
      if (!ctx) throw new Error("canvas 2D indisponível neste navegador");
      return ctx;
    };
    const layers = { grid: makeLayer("grid"), edges: makeLayer("edges"), nodes: makeLayer("nodes"), overlay: makeLayer("overlay") };

    // foco visível e leitor de tela: um botão por cima do nó focado (refeito a cada troca, para o leitor anunciar)
    let proxy: HTMLButtonElement | undefined;
    /** Troca do botão do nó focado em curso: remover o botão com foco pode disparar focusout, que não é saída do canvas. */
    let swappingFocus = false;
    /**
     * Foco devolvido ao canvas de propósito (Esc): o host não reentra no primeiro nó até o foco sair do canvas ou ir a um
     * nó. Marca que dura, não passageira: o Firefox entrega o `focus` do host depois que o botão focado sai do DOM.
     */
    let hostLevel = false;
    const live = document.createElement("div");
    live.setAttribute("aria-live", "polite");
    live.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap";
    a11yBox.appendChild(live);
    const announce = (text: string): void => {
      live.textContent = "";
      live.textContent = text;
    };

    host.tabIndex = 0;
    host.setAttribute("role", "application");
    host.setAttribute("aria-roledescription", "canvas");
    const applyLabel = (): void => host.setAttribute("aria-label", `${opts.label ?? "Canvas"}. Tab percorre os nós, setas movem o nó focado, Enter abre o menu do nó, Espaço com arrasto move a câmera.`);
    applyLabel();
    host.style.touchAction = "none";
    htmlLayer.style.transformOrigin = "0 0";

    const readTheme = (): void => {
      const style = getComputedStyle(host);
      const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
      colors = Object.fromEntries(Object.entries(THEME_VARS).map(([key, name]) => [key, read(name, THEME_FALLBACK[key as keyof typeof THEME_VARS])])) as typeof colors;
      palette = PALETTE_VARS.map((name, i) => read(name, PALETTE_FALLBACK[i] as string));
      fontFamily = read("--font-sans", FONT_FALLBACK);
      softLive = mixOver(colors.vivo, LIVE_FILL_PCT, colors.card);
      softRest = mixOver(colors.muted, REST_FILL_PCT, colors.card);
      fills = new Map();
      labels = new Map();
      markAll();
    };

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    // ligar o movimento reduzido no meio de uma animação: vai ao destino já, sem terminar o trajeto
    const onReducedMotion = (): void => {
      if (!reducedMotion.matches || !animation) return;
      const { to } = animation;
      animation = undefined;
      setCam(to);
    };
    reducedMotion.addEventListener("change", onReducedMotion);
    cleanups.push(() => reducedMotion.removeEventListener("change", onReducedMotion));

    // ---- quadros: só quando algo muda (sem laço contínuo parado) ----
    const markAll = (): void => {
      dirty.grid = dirty.edges = dirty.nodes = dirty.overlay = true;
      requestFrame();
    };
    /** Nível de detalhe na escala `k`, com o limite do nó completo escolhido pelo dono (`fullDetail`). */
    const detailOf = (k: number): Detail => C.detailFor(k, opts.fullDetail ?? C.DETAIL_THRESHOLDS.full);
    const markContent = (): void => {
      dirty.edges = dirty.nodes = true;
      ropesAwake = true;
      requestFrame();
    };
    function requestFrame(): void {
      if (frameRequested || destroyed) return;
      frameRequested = requestAnimationFrame(frame);
    }

    function frame(now: number): void {
      frameRequested = 0;
      if (animation) {
        const t = Math.min(1, (now - animation.start) / C.CAMERA_LIMITS.animationMs);
        setCam(C.interpolateCamera(animation.from, animation.to, t, view));
        if (t >= 1) animation = undefined;
        else requestFrame();
      }
      render(now);
    }

    function render(now: number): void {
      if (view.w === 0 || view.h === 0 || !fontsReady) return;
      if (fitPending && doc.nodes.length > 0) {
        fitPending = false;
        cam = C.openingCamera(doc.nodes, view) ?? C.fitAll(doc.nodes, view);
        opts.onCameraChange?.(cam);
        for (const listener of cameraListeners) listener(cam);
      }
      const t0 = performance.now();
      const visibleWorld = C.inflate(C.visibleRect(cam, view), 2 / cam.k);
      const detail = detailOf(cam.k);
      const visible = C.cullRects(drawOrder.map(placed), visibleWorld);
      renderNo++;
      const links = L && linkEdges.length > 0 ? linkFrame(visibleWorld, now) : NO_LINKS;
      if (dirty.grid) drawGrid();
      if (dirty.edges) drawEdges(visibleWorld, links.geoms);
      if (dirty.nodes) drawNodes(visible, detail);
      if (dirty.overlay) drawOverlay();
      dirty.grid = dirty.edges = dirty.nodes = dirty.overlay = false;
      syncHtml(visible, detail);
      positionProxy();
      const info: FrameInfo = { ms: performance.now() - t0, at: now, visible: visible.length, detail, ropes: { visible: links.ropes, stepped: links.stepped } };
      for (const listener of frameListeners) listener(info);
      // só a física pede o próximo quadro, e só enquanto alguma corda à vista ainda balança
      if (ropesAwake && links.stepped > 0) {
        dirty.edges = true;
        requestFrame();
      }
    }

    /** Nó na posição do quadro: com o deslocamento ao vivo do arrasto ou da alça. */
    function placed(node: CanvasNode): CanvasNode {
      if (gesture.kind === "move" && gesture.set.has(node.id)) {
        return { ...node, x: node.x + gesture.dx + (gesture.snap?.dx ?? 0), y: node.y + gesture.dy + (gesture.snap?.dy ?? 0) };
      }
      if (gesture.kind === "resize" && gesture.id === node.id) return { ...node, ...S.resizePreview(node, gesture.dw, gesture.dh, gesture.edge) };
      return node;
    }

    const worldTransform = (ctx: CanvasRenderingContext2D): void => {
      ctx.setTransform(dpr * cam.k, 0, 0, dpr * cam.k, -cam.x * cam.k * dpr, -cam.y * cam.k * dpr);
    };
    const clear = (ctx: CanvasRenderingContext2D): void => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    };

    function drawGrid(): void {
      const ctx = layers.grid;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      const step: number = S.SELECTION_LIMITS.grid * GRID_MAJOR;
      if (step * cam.k < GRID_MIN_PX) return;
      const rect = C.visibleRect(cam, view);
      worldTransform(ctx);
      ctx.lineWidth = 1 / cam.k;
      ctx.beginPath();
      for (let x = Math.floor(rect.x / step) * step; x <= rect.x + rect.w; x += step) {
        ctx.moveTo(x, rect.y);
        ctx.lineTo(x, rect.y + rect.h);
      }
      for (let y = Math.floor(rect.y / step) * step; y <= rect.y + rect.h; y += step) {
        ctx.moveTo(rect.x, y);
        ctx.lineTo(rect.x + rect.w, y);
      }
      ctx.strokeStyle = colors.border;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const centerOf = (id: string): Vec | undefined => {
      const node = byId.get(id);
      if (!node) return undefined;
      const p = placed(node);
      return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
    };

    function drawEdges(visibleWorld: Rect, links: readonly LinkGeom[]): void {
      const ctx = layers.edges;
      clear(ctx);
      drawPlainEdges(ctx, visibleWorld);
      drawLinks(ctx, links, visibleWorld);
    }

    function drawPlainEdges(ctx: CanvasRenderingContext2D, visibleWorld: Rect): void {
      const edges = C.cullSegments(doc.edges, (edge) => {
        if (L?.isLinkEdge(edge)) return undefined;
        const a = centerOf(edge.from);
        const b = centerOf(edge.to);
        return a && b ? [a, b] : undefined;
      }, visibleWorld);
      if (edges.length === 0) return;
      worldTransform(ctx);
      ctx.lineWidth = 1.5 / cam.k;
      ctx.strokeStyle = colors.strong;
      // com destaque, a aresta leva a opacidade da ponta mais apagada (um traço por nível, não por aresta)
      const byAlpha = new Map<number, typeof edges>();
      for (const edge of edges) {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        const alpha = emphasis && from && to ? Math.min(alphaOf(from), alphaOf(to)) : 1;
        const list = byAlpha.get(alpha);
        if (list) list.push(edge);
        else byAlpha.set(alpha, [edge]);
      }
      for (const [alpha, list] of byAlpha) {
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (const edge of list) {
          const a = centerOf(edge.from) as Vec;
          const b = centerOf(edge.to) as Vec;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // ---- conexões (aresta `link`): rota, física da corda só à vista e abraçadeiras ----
    const chordOf = (edge: CanvasEdge): [Vec, Vec] | undefined => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      return L && from && to ? L.linkAnchors(placed(from), placed(to)) : undefined;
    };
    /** `t` da abraçadeira na conexão, com a prévia do arrasto em curso. */
    const clampT = (clampId: string, member: ClampHit): number =>
      (gesture.kind === "clamp-move" && gesture.clampId === clampId ? gesture.ts.get(member.edgeId) : undefined) ?? member.t;
    /** Onde cada abraçadeira está agora (só as que prendem alguma corda: circuito não tem abraçadeira). */
    function clampPoints(): Map<string, Vec> {
      const out = new Map<string, Vec>();
      if (!L) return out;
      for (const [id, members] of clampIndex) {
        const chords: { a: Vec; b: Vec; t: number }[] = [];
        for (const member of members) {
          const edge = edgeById.get(member.edgeId);
          const chord = edge && L.linkStyleOf(edge) === "rope" ? chordOf(edge) : undefined;
          if (chord) chords.push({ a: chord[0], b: chord[1], t: clampT(id, member) });
        }
        const at = L.clampPoint(chords);
        if (at) out.set(id, at);
      }
      return out;
    }
    let shownClamps = new Map<string, Vec>();

    function pinsOf(edge: CanvasEdge, clampAt: ReadonlyMap<string, Vec>): RopePin[] {
      const Lm = L as typeof LinksModule;
      return (edge.clamps ?? []).flatMap((clamp) => {
        const at = clampAt.get(clamp.id);
        return at ? [{ index: Lm.pinIndex(clampT(clamp.id, { edgeId: edge.id, t: clamp.t })), at }] : [];
      });
    }

    /**
     * Conexões à vista neste quadro. A corda só anda aqui e só se está à vista: fora do viewport ela fica parada, e ao
     * voltar à tela (ou com movimento reduzido) assume a forma de repouso em vez de balançar de um estado velho.
     */
    function linkFrame(visibleWorld: Rect, now: number): LinkFrame {
      const Lm = L as typeof LinksModule;
      const clampAt = clampPoints();
      const dt = lastStepAt === 0 ? Lm.ROPE.maxDt : (now - lastStepAt) / 1000;
      const still = reducedMotion.matches;
      const stepping = ropesAwake && !still;
      let moved = 0;
      let shown = 0;
      let stepped = 0;
      const geoms: LinkGeom[] = [];
      for (const edge of linkEdges) {
        const fromNode = byId.get(edge.from);
        const toNode = byId.get(edge.to);
        if (!fromNode || !toNode) continue;
        const pf = placed(fromNode);
        const pt = placed(toNode);
        const style = Lm.linkStyleOf(edge);
        const alpha = emphasis ? Math.min(alphaOf(fromNode), alphaOf(toNode)) : 1;
        if (style === "circuit") {
          const points = Lm.circuitRoute(pf, pt);
          if (!overlaps(boundsOf(points), visibleWorld)) continue;
          geoms.push({ edge, style, from: fromNode, a: points[0] as Vec, b: points[points.length - 1] as Vec, points, alpha });
          continue;
        }
        const [a, b] = Lm.linkAnchors(pf, pt);
        const pins = pinsOf(edge, clampAt);
        if (!overlaps(Lm.ropeReach(a, b, pins), visibleWorld)) continue;
        shown++;
        let sim = ropes.get(edge.id);
        if (!sim) {
          sim = { rope: Lm.createRope(a, b, pins), seen: renderNo };
          ropes.set(edge.id, sim);
        } else if (sim.seen !== renderNo - 1 || still) {
          Lm.restRopeInPlace(sim.rope, a, b, pins);
        } else if (stepping) {
          moved = Math.max(moved, Lm.advanceRope(sim.rope, a, b, pins, dt).energy);
          stepped++;
        }
        sim.seen = renderNo;
        geoms.push({ edge, style, from: fromNode, a, b, points: sim.rope.points, alpha });
      }
      lastStepAt = now;
      ropesAwake = stepped > 0 && moved > Lm.ROPE.sleep;
      if (stepped > 0) dirty.edges = true;
      shownLinks = geoms;
      shownClamps = clampAt;
      return { geoms, ropes: shown, stepped };
    }

    function drawLinks(ctx: CanvasRenderingContext2D, links: readonly LinkGeom[], visibleWorld: Rect): void {
      if (links.length === 0 && shownClamps.size === 0) return;
      worldTransform(ctx);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const radius = L?.CIRCUIT_RADIUS ?? 0;
      for (const link of links) {
        const color = fillOf(link.from);
        ctx.globalAlpha = link.alpha;
        ctx.strokeStyle = color;
        ctx.beginPath();
        if (link.style === "rope") {
          ctx.lineWidth = Math.max(ROPE_WIDTH, LINK_MIN_PX / cam.k);
          traceRope(ctx, link.points);
          ctx.stroke();
          continue;
        }
        ctx.lineWidth = Math.max(CIRCUIT_WIDTH, LINK_MIN_PX / cam.k);
        traceCircuit(ctx, link.points, radius);
        ctx.stroke();
        // terminais do trilho: um ponto em cada borda
        const pad = Math.max(3, 2 / cam.k);
        ctx.fillStyle = color;
        ctx.fillRect(link.a.x - pad, link.a.y - pad, 2 * pad, 2 * pad);
        ctx.fillRect(link.b.x - pad, link.b.y - pad, 2 * pad, 2 * pad);
      }
      ctx.globalAlpha = 1;
      ctx.lineCap = "butt";
      ctx.lineJoin = "miter";
      const size = CLAMP_PX / cam.k;
      for (const [id, at] of shownClamps) {
        if (!overlaps({ x: at.x - size, y: at.y - size, w: 2 * size, h: 2 * size }, visibleWorld)) continue;
        ctx.fillStyle = colors.fg;
        ctx.fillRect(at.x - size / 2, at.y - size / 2, size, size);
        ctx.lineWidth = 1.5 / cam.k;
        ctx.strokeStyle = colors.card;
        ctx.strokeRect(at.x - size / 2, at.y - size / 2, size, size);
        if (id !== selectedClamp) continue;
        const gap = 3 / cam.k;
        ctx.lineWidth = 2 / cam.k;
        ctx.strokeStyle = colors.ring;
        ctx.strokeRect(at.x - size / 2 - gap, at.y - size / 2 - gap, size + 2 * gap, size + 2 * gap);
      }
    }

    /** Abraçadeira sob o ponto da tela (a mais próxima dentro do raio de acerto). */
    function clampAtScreen(p: Vec): string | undefined {
      let best: { id: string; d: number } | undefined;
      for (const [id, at] of shownClamps) {
        const s = C.worldToScreen(cam, at);
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d <= CLAMP_HIT_PX && (!best || d < best.d)) best = { id, d };
      }
      return best?.id;
    }

    /** Prévia da ferramenta Conexão: linha da borda de origem até o cursor, ou até o destino válido sob ele (com anel). */
    function drawLinkPreview(ctx: CanvasRenderingContext2D): void {
      if (!linking?.cursor || !L) return;
      const from = byId.get(linking.from);
      if (!from) return;
      const target = linking.target === undefined ? undefined : byId.get(linking.target);
      worldTransform(ctx);
      const end = target ? L.linkAnchors(from, target)[1] : linking.cursor;
      const start = L.borderPoint(from, target ? { x: target.x + target.w / 2, y: target.y + target.h / 2 } : linking.cursor);
      ctx.lineWidth = 2 / cam.k;
      ctx.strokeStyle = colors.ring;
      ctx.setLineDash([6 / cam.k, 4 / cam.k]);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!target) return;
      const gap = 5 / cam.k;
      ctx.strokeRect(target.x - gap, target.y - gap, target.w + 2 * gap, target.h + 2 * gap);
    }

    function drawNodes(visible: readonly CanvasNode[], detail: Detail): void {
      const ctx = layers.nodes;
      clear(ctx);
      worldTransform(ctx);
      if (detail === "dot") drawDots(ctx, visible);
      else drawBlocks(ctx, visible, detail);
    }

    /** Forma com que o nó é desenhado neste detalhe (veja `nodeShape` nas opções). */
    const shapeOf = (n: CanvasNode, detail: Detail): Shape => {
      const shape = sanitizeShape(opts.nodeShape?.(n));
      return detail === "full" && opts.isRich?.(n) ? "square" : shape;
    };

    /** Longe: só a cor, agrupada por cor (uma troca de fillStyle por cor, não por nó). */
    function drawDots(ctx: CanvasRenderingContext2D, visible: readonly CanvasNode[]): void {
      const byFill = new Map<string, CanvasNode[]>();
      for (const node of visible) {
        const fill = fillOf(node);
        const list = byFill.get(fill);
        if (list) list.push(node);
        else byFill.set(fill, [node]);
      }
      for (const [fill, nodes] of byFill) {
        ctx.fillStyle = fill;
        for (const n of nodes) {
          ctx.globalAlpha = alphaOf(n);
          fillShape(ctx, shapeOf(n, "dot"), n);
        }
      }
      ctx.globalAlpha = 1;
      const ring = 2 / cam.k;
      ctx.lineWidth = ring;
      ctx.strokeStyle = colors.ring;
      for (const n of visible) if (selected.has(n.id)) ctx.strokeRect(n.x - ring, n.y - ring, n.w + 2 * ring, n.h + 2 * ring);
      drawOutsideLabels(ctx, visible);
    }

    /** De longe a forma é só cor: o nome do nó selecionado vai abaixo dela, em tamanho de tela fixo, sobre uma pastilha do fundo. */
    function drawOutsideLabels(ctx: CanvasRenderingContext2D, visible: readonly CanvasNode[]): void {
      const fontWorld = MIN_LABEL_PX / cam.k;
      ctx.font = `${fontWorld}px ${fontFamily}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      const padX = 4 / cam.k;
      const boxH = fontWorld + 4 / cam.k;
      for (const n of visible) {
        if (!selected.has(n.id)) continue;
        const text = C.shortLabel(labelOf(n), OUTSIDE_LABEL_PX, MIN_LABEL_PX);
        const w = Array.from(text).length * MIN_LABEL_PX * 0.6 / cam.k;
        const cx = n.x + n.w / 2;
        const top = n.y + n.h + 6 / cam.k;
        ctx.fillStyle = colors.background;
        ctx.fillRect(cx - w / 2 - padX, top, w + 2 * padX, boxH);
        ctx.fillStyle = colors.fg;
        ctx.fillText(text, cx, top + boxH / 2);
      }
      ctx.textAlign = "start";
    }

    /** Nó de forma própria: fundo do cartão, contorno na cor do nó (no lugar da faixa) e o rótulo centrado dentro da forma. */
    function drawShapedBlock(ctx: CanvasRenderingContext2D, n: CanvasNode, shape: Shape, fontScreen: number, hair: number): void {
      ctx.fillStyle = colors.card;
      fillShape(ctx, shape, n);
      ctx.lineWidth = 2 * hair;
      ctx.strokeStyle = fillOf(n);
      if (n.locked) ctx.setLineDash([4 / cam.k, 3 / cam.k]);
      strokeShape(ctx, shape, n);
      if (n.locked) ctx.setLineDash([]);
      const text = C.shortLabel(labelOf(n), n.w * LABEL_FIT[shape] * cam.k, fontScreen);
      if (!text || n.h * cam.k < fontScreen + 4) return;
      ctx.fillStyle = colors.fg;
      ctx.textAlign = "center";
      ctx.fillText(text, n.x + n.w / 2, n.y + n.h / 2);
      ctx.textAlign = "start";
    }

    /** Bloco (rótulo curto, fonte fixa de tela) ou nó completo (cabeçalho, rótulo e tipo em escala de mundo). */
    function drawBlocks(ctx: CanvasRenderingContext2D, visible: readonly CanvasNode[], detail: Detail): void {
      const full = detail === "full";
      const header = full ? S.SELECTION_LIMITS.header : 0;
      const fontScreen = full ? Math.max(FULL_FONT * cam.k, MIN_LABEL_PX) : MIN_LABEL_PX;
      const fontWorld = fontScreen / cam.k;
      const strip = full ? header : 4 / cam.k;
      const pad = full ? 8 : 6 / cam.k;
      ctx.font = `${fontWorld}px ${fontFamily}`;
      ctx.textBaseline = "middle";
      const hair = 1 / cam.k;
      for (const n of visible) {
        ctx.globalAlpha = alphaOf(n);
        const shape = shapeOf(n, detail);
        if (shape !== "square") {
          drawShapedBlock(ctx, n, shape, fontScreen, hair);
          continue;
        }
        ctx.fillStyle = colors.card;
        ctx.fillRect(n.x, n.y, n.w, n.h);
        ctx.fillStyle = fillOf(n);
        if (full) ctx.fillRect(n.x, n.y, n.w, Math.min(header, n.h));
        else ctx.fillRect(n.x, n.y, Math.min(strip, n.w), n.h);
        ctx.lineWidth = hair;
        ctx.strokeStyle = colors.strong;
        if (n.locked) ctx.setLineDash([4 / cam.k, 3 / cam.k]);
        ctx.strokeRect(n.x, n.y, n.w, n.h);
        if (n.locked) ctx.setLineDash([]);
        const textW = (n.w - (full ? 2 * pad : strip + 2 * pad)) * cam.k;
        const text = C.shortLabel(labelOf(n), textW, fontScreen);
        if (text && (full || n.h * cam.k >= fontScreen + 4)) {
          ctx.fillStyle = full ? colors.background : colors.fg;
          ctx.fillText(text, full ? n.x + pad : n.x + strip + pad, full ? n.y + Math.min(header, n.h) / 2 : n.y + Math.min(n.h / 2, pad + fontWorld / 2));
          if (full && !opts.isRich?.(n) && n.h > header + fontWorld + pad) {
            ctx.fillStyle = colors.muted;
            ctx.fillText(C.shortLabel(n.type, textW, fontScreen), n.x + pad, n.y + header + pad + fontWorld / 2);
          }
        }
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2 / cam.k;
      ctx.strokeStyle = colors.ring;
      const handle = S.SELECTION_LIMITS.handlePx / cam.k;
      // anel afastado da borda: o anel é o foco (`--ring`), a única marca de seleção; o vermelho de estado nunca a representa
      const gap = 3 / cam.k;
      for (const n of visible) {
        if (!selected.has(n.id)) continue;
        ctx.strokeRect(n.x - gap, n.y - gap, n.w + 2 * gap, n.h + 2 * gap);
        if (!n.locked) {
          ctx.fillStyle = colors.ring;
          ctx.fillRect(n.x + n.w - handle, n.y + n.h - handle, handle, handle);
        }
      }
    }

    /** Guias do encaixe (no mundo) e faixa da borda de acoplar (na tela) durante o arrasto. */
    function drawMoveHints(ctx: CanvasRenderingContext2D, g: Extract<Gesture, { kind: "move" }>): void {
      if (g.edge !== undefined && opts.dock) {
        const zone = opts.dock.edgeZone;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = colors.ring;
        ctx.globalAlpha = 0.16;
        ctx.fillRect(g.edge === "left" ? 0 : view.w - zone, 0, zone, view.h);
        ctx.globalAlpha = 1;
      }
      if (!g.snap) return;
      worldTransform(ctx);
      ctx.lineWidth = 1 / cam.k;
      ctx.strokeStyle = colors.ring;
      ctx.beginPath();
      for (const guide of g.snap.guides) traceGuide(ctx, guide);
      ctx.stroke();
    }
    function traceGuide(ctx: CanvasRenderingContext2D, guide: SnapGuide): void {
      const segment = (axis: "x" | "y", at: number, from: number, to: number): void => {
        // `axis: "x"` é linha vertical em x = at; `"y"`, horizontal em y = at
        if (axis === "x") {
          ctx.moveTo(at, from);
          ctx.lineTo(at, to);
        } else {
          ctx.moveTo(from, at);
          ctx.lineTo(to, at);
        }
      };
      if (guide.kind === "gap") {
        // o vão é medido no eixo `axis` e desenhado na coordenada `cross` do outro
        for (const gap of guide.segments) segment(guide.axis === "x" ? "y" : "x", gap.cross, gap.from, gap.to);
        return;
      }
      segment(guide.axis, guide.at, guide.from, guide.to);
    }

    function drawOverlay(): void {
      const ctx = layers.overlay;
      clear(ctx);
      if (gesture.kind === "move" && gesture.moved) {
        drawMoveHints(ctx, gesture);
        return;
      }
      if (gesture.kind === "clamp-stroke" && gesture.moved) {
        worldTransform(ctx);
        ctx.lineWidth = 2 / cam.k;
        ctx.strokeStyle = colors.ring;
        ctx.beginPath();
        ctx.moveTo(gesture.from.x, gesture.from.y);
        ctx.lineTo(gesture.end.x, gesture.end.y);
        ctx.stroke();
        return;
      }
      drawLinkPreview(ctx);
      if (gesture.kind !== "marquee" || !gesture.moved) return;
      worldTransform(ctx);
      const r = S.rectFrom(gesture.start, gesture.end);
      ctx.fillStyle = colors.ring;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1 / cam.k;
      ctx.strokeStyle = colors.ring;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    /** Camada HTML: transforma pela câmera e posiciona os nós ricos; a lista só vai ao React quando muda. */
    function syncHtml(visible: readonly CanvasNode[], detail: Detail): void {
      htmlLayer.style.transform = `translate(${-cam.x * cam.k}px, ${-cam.y * cam.k}px) scale(${cam.k})`;
      const isRich = opts.isRich;
      const ids = detail === "full" && isRich ? visible.filter((n) => isRich(n)).map((n) => n.id) : [];
      if (ids.length !== richIds.length || ids.some((id, i) => id !== richIds[i])) {
        richIds = ids;
        opts.onRichNodes?.(ids);
      }
      const header = S.SELECTION_LIMITS.header;
      for (const [id, el] of htmlEls) {
        const node = byId.get(id);
        if (!node) continue;
        const p = placed(node);
        // o cabeçalho fica de fora: é desenhado no canvas e é por ele que o nó se move
        el.style.transform = `translate(${p.x}px, ${p.y + header}px)`;
        el.style.width = `${p.w}px`;
        el.style.height = `${Math.max(0, p.h - header)}px`;
        el.style.opacity = String(alphaOf(node));
      }
    }

    function positionProxy(): void {
      if (!proxy || focusId === undefined) return;
      const node = byId.get(focusId);
      if (!node) return;
      const p = placed(node);
      const s = C.worldToScreen(cam, p);
      proxy.style.transform = `translate(${s.x}px, ${s.y}px)`;
      proxy.style.width = `${p.w * cam.k}px`;
      proxy.style.height = `${p.h * cam.k}px`;
    }

    // ---- câmera ----
    function setCam(next: Camera): void {
      if (!C.isCamera(next)) return;
      if (next.x === cam.x && next.y === cam.y && next.k === cam.k) return;
      const detailChanged = detailOf(next.k) !== detailOf(cam.k);
      cam = next;
      fitPending = false;
      markAll();
      if (detailChanged) labels = new Map();
      opts.onCameraChange?.(cam);
      for (const listener of cameraListeners) listener(cam);
    }
    function moveCamera(next: Camera, animate: boolean): void {
      animation = undefined;
      if (!animate || reducedMotion.matches) {
        setCam(next);
        return;
      }
      animation = { from: cam, to: next, start: performance.now() };
      requestFrame();
    }

    // ---- foco do teclado ----
    function setFocus(id: string | undefined, moveDomFocus: boolean): void {
      focusId = id;
      swappingFocus = true;
      try {
        proxy?.remove();
      } finally {
        swappingFocus = false;
      }
      proxy = undefined;
      host.tabIndex = id === undefined ? 0 : -1;
      hostLevel = id === undefined && moveDomFocus;
      if (id === undefined) {
        if (moveDomFocus) host.focus({ preventScroll: true });
        return;
      }
      const node = byId.get(id);
      if (!node) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.tabIndex = -1;
      btn.dataset.canvasFocus = id;
      btn.setAttribute("aria-label", S.nodeName(node, labelOf(node), selected.has(id)));
      btn.style.cssText = "position:absolute;left:0;top:0;padding:0;margin:0;border:0;background:transparent;pointer-events:none;outline:2px solid var(--ring, #c8264a);outline-offset:3px";
      a11yBox.appendChild(btn);
      proxy = btn;
      moveCamera(C.revealRect(cam, node, view), true);
      positionProxy();
      if (moveDomFocus) btn.focus({ preventScroll: true });
    }
    const refreshProxyLabel = (): void => {
      if (!proxy || focusId === undefined) return;
      const node = byId.get(focusId);
      if (node) proxy.setAttribute("aria-label", S.nodeName(node, labelOf(node), selected.has(focusId)));
    };

    // ---- saída: seleção e operação ----
    function emitSelection(next: readonly string[], origin: SelectionOrigin = "pointer"): void {
      const current = [...selected];
      if (S.sameSelection(current, next)) return;
      selected = new Set(next);
      markContent();
      refreshProxyLabel();
      opts.onSelectionChange(next, origin);
    }
    function emitOp(op: CanvasOp | undefined): void {
      if (!op) return;
      opts.onOp(op, H.applyOp(doc, op));
    }

    // ---- ponteiro ----
    const screenPoint = (e: { clientX: number; clientY: number }): Vec => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const beyondSlop = (a: Vec, b: Vec): boolean => Math.hypot(a.x - b.x, a.y - b.y) > S.SELECTION_LIMITS.clickSlopPx;
    const capture = (id: number): void => {
      try {
        host.setPointerCapture(id);
      } catch (error) {
        // ponteiro já solto ou sintético (o harness de escala): o gesto segue sem captura enquanto estiver sobre o canvas
        if (!(error instanceof DOMException)) throw error;
      }
    };
    /** Mão aberta com Espaço segurado, fechada enquanto arrasta por ele ou pelo botão do meio. */
    const applyCursor = (): void => {
      const grabbing = gesture.kind === "pan" && gesture.grab;
      const resizeEdge = gesture.kind === "resize" ? gesture.edge : gesture.kind === "none" ? overResize : undefined;
      const resizing = resizeEdge !== undefined;
      host.style.cursor = grabbing ? "grabbing" : spaceHeld ? "grab" : linking ? "crosshair" : resizeEdge ? S.resizeCursor(resizeEdge) : "";
      // o nó rico (nota, terminal) cobre a alça e tem cursor próprio (texto): a classe o vence enquanto vale
      // a classe vence o cursor do conteúdo rico; o formato da seta (borda ou canto) vai na variável que o CSS lê
      if (resizeEdge) host.style.setProperty("--canvas-resize-cursor", S.resizeCursor(resizeEdge));
      host.classList.toggle(RESIZE_CURSOR_CLASS, resizing && !grabbing && !spaceHeld && !linking);
    };
    /** Lados sob o mouse parado sobre a alça ou a borda de redimensionar (sem botão apertado). */
    let overResize: SelectionModule.ResizeEdge | undefined;
    // a borda do terminal vale sem selecionar: a faixa é fina e fica abaixo do cabeçalho, que segue sendo a alça de mover
    const EDGE_NODE_TYPE = "terminal";
    const resizeOptions = (): SelectionModule.HitOptions => ({
      k: cam.k, detail: detailOf(cam.k), resizable: (n) => selected.has(n.id) && !n.locked,
      edgeResizable: (n) => n.type === EDGE_NODE_TYPE && !n.locked,
    });
    /** Alça (nó selecionado) ou borda (terminal) de redimensionar sob o ponto: vale também sobre o conteúdo do nó rico, que a cobre. */
    const resizeHitAt = (e: PointerEvent): SelectionModule.Hit | undefined => {
      const hit = S.hitTest(doc.nodes, C.screenToWorld(cam, screenPoint(e)), resizeOptions());
      return hit?.region === "resize" ? hit : undefined;
    };
    const trackResizeHover = (e: PointerEvent): void => {
      const over = e.pointerType === "mouse" && gesture.kind === "none" ? resizeHitAt(e)?.edge : undefined;
      if (over?.left === overResize?.left && over?.right === overResize?.right && over?.bottom === overResize?.bottom && (over === undefined) === (overResize === undefined)) return;
      overResize = over;
      applyCursor();
    };
    const cancelGesture = (): void => {
      if (gesture.kind === "none") return;
      gesture = { kind: "none" };
      applyCursor();
      markContent();
      dirty.overlay = true;
    };

    // ---- ferramenta Conexão e abraçadeiras ----
    /** Semente dos ids novos (`link-<semente>`, `clamp-<semente>`): o instante em base 36, com sufixo se já existir. */
    const idSeed = (): string => Date.now().toString(36);
    /** Monta e emite uma operação de conexão; a recusa da regra (código estável) é anunciada, não lançada. */
    function tryLinkOp(build: () => CanvasOp | undefined): boolean {
      try {
        const op = build();
        if (!op) return false;
        emitOp(op);
        return true;
      } catch (error) {
        if (!(L && error instanceof L.LinkError)) throw error;
        announce(`${L.LINK_ERROR_TEXT[error.code]}.`);
        return false;
      }
    }
    const hitNode = (p: Vec): string | undefined =>
      S.hitTest(doc.nodes, C.screenToWorld(cam, p), { k: cam.k, detail: detailOf(cam.k), resizable: () => false })?.id;

    function startLink(from?: string): boolean {
      const origin = from ?? (selected.size === 1 ? [...selected][0] : focusId);
      if (!L || origin === undefined || !L.canStartLink(byId.get(origin))) {
        announce("Selecione um terminal ou uma nota para conectar.");
        return false;
      }
      cancelGesture();
      linking = { from: origin, cursor: undefined, target: undefined };
      applyCursor();
      // o Esc e o Enter que completam são do canvas: o foco vem para ele sem pular para o primeiro nó
      if (!host.contains(document.activeElement)) {
        hostLevel = true;
        host.focus({ preventScroll: true });
      }
      opts.onLinkState?.(origin);
      announce("Conexão armada: clique no terminal ou na nota de destino. Esc cancela.");
      return true;
    }
    function endLink(): void {
      if (!linking) return;
      linking = undefined;
      applyCursor();
      dirty.overlay = true;
      requestFrame();
      opts.onLinkState?.(undefined);
    }
    function cancelLink(): void {
      if (!linking) return;
      endLink();
      announce("Conexão cancelada.");
    }
    function completeLink(target: string): void {
      if (!linking || !L || target === linking.from) return;
      const from = linking.from;
      const refusal = L.linkRefusal(doc, from, target);
      if (refusal) {
        announce(`${L.LINK_ERROR_TEXT[refusal]}.`);
        return;
      }
      if (!tryLinkOp(() => L.opCreateLink(doc, { id: L.freshLinkId(doc, "link", idSeed()), from, to: target }))) return;
      endLink();
      announce("Conectado.");
    }
    function trackLinkCursor(p: Vec): void {
      if (!linking || !L) return;
      const over = hitNode(p);
      linking.cursor = C.screenToWorld(cam, p);
      linking.target = over !== undefined && !L.linkRefusal(doc, linking.from, over) ? over : undefined;
      dirty.overlay = true;
      requestFrame();
    }
    /**
     * Com a conexão armada, o clique é dela em qualquer lugar do canvas, inclusive sobre o conteúdo HTML de um nó (fase de
     * captura: o conteúdo não chega a ver o clique).
     */
    function onLinkPointerDown(e: PointerEvent): void {
      if (!linking) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) {
        cancelLink();
        return;
      }
      const content = e.target instanceof Element ? e.target.closest("[data-canvas-node]") : null;
      const id = content instanceof HTMLElement && content.dataset.canvasNode ? content.dataset.canvasNode : hitNode(screenPoint(e));
      if (id === undefined) cancelLink();
      else completeLink(id);
    }

    function selectClamp(id: string): void {
      selectedClamp = id;
      emitSelection([]);
      markContent();
      announce("Abraçadeira selecionada: arraste ao longo das cordas; Delete solta.");
    }
    function clearClamp(): void {
      if (selectedClamp === undefined) return;
      selectedClamp = undefined;
      markContent();
    }
    function finishClampStroke(from: Vec, end: Vec): void {
      if (!L) return;
      const hits: ClampHit[] = [];
      for (const link of shownLinks) {
        if (link.style !== "rope") continue;
        const at = L.strokeCrossing(from, end, link.points);
        if (at) hits.push({ edgeId: link.edge.id, t: L.projectT(link.a, link.b, at) });
      }
      if (hits.length === 0) {
        announce("O traço não cruzou nenhuma corda.");
        return;
      }
      const id = L.freshLinkId(doc, "clamp", idSeed());
      if (!tryLinkOp(() => L.opClampLinks(doc, id, hits))) return;
      selectedClamp = id;
      announce(`Abraçadeira presa em ${hits.length} corda(s).`);
    }
    /** O cursor arrastando a abraçadeira: cada corda presa escorrega até o ponto dela mais perto do cursor. */
    function dragClamp(g: Extract<Gesture, { kind: "clamp-move" }>, p: Vec): void {
      if (!L) return;
      const world = C.screenToWorld(cam, p);
      for (const member of clampIndex.get(g.clampId) ?? []) {
        const edge = edgeById.get(member.edgeId);
        const chord = edge && L.linkStyleOf(edge) === "rope" ? chordOf(edge) : undefined;
        if (chord) g.ts.set(member.edgeId, L.projectT(chord[0], chord[1], world));
      }
      markContent();
    }

    function onPointerDown(e: PointerEvent): void {
      // com Espaço segurado o gesto é do canvas até sobre o conteúdo de um nó rico
      // conteúdo do nó rico trata o próprio clique, menos na alça de redimensionar (que ele cobre)
      const overRich = !spaceHeld && e.target instanceof Element && e.target.closest("[data-canvas-node]");
      if (overRich && !(e.button === 0 && resizeHitAt(e))) return;
      if (overRich) {
        // a alça é do canvas: o nó não seleciona texto nem toma o foco por baixo do arrasto
        e.preventDefault();
        e.stopPropagation();
      }
      animation = undefined;
      const p = screenPoint(e);
      pointers.set(e.pointerId, p);
      if (e.pointerType === "touch" && pointers.size === 2) {
        cancelGesture();
        const [[ia, a], [ib, b]] = [...pointers] as [[number, Vec], [number, Vec]];
        gesture = { kind: "pinch", start: { cam, a, b }, ids: [ia, ib] };
        return;
      }
      if (gesture.kind !== "none" || e.button === 2) return;
      capture(e.pointerId);
      if (e.button === 1 || (e.button === 0 && spaceHeld)) {
        e.preventDefault();
        if (e.button === 0) spaceUsed = true;
        gesture = { kind: "pan", pointer: e.pointerId, start: p, cam, moved: false, clearOnClick: false, onClick: undefined, grab: true };
        applyCursor();
        return;
      }
      if (e.button !== 0) return;
      const world = C.screenToWorld(cam, p);
      if (L && e.altKey) {
        gesture = { kind: "clamp-stroke", pointer: e.pointerId, start: p, from: world, end: world, moved: false };
        return;
      }
      const clamp = clampAtScreen(p);
      if (clamp !== undefined) {
        selectClamp(clamp);
        gesture = { kind: "clamp-move", pointer: e.pointerId, start: p, clampId: clamp, ts: new Map(), moved: false };
        return;
      }
      clearClamp();
      const hit = S.hitTest(doc.nodes, world, resizeOptions());
      const shift = e.shiftKey;
      if (hit?.region === "resize" && hit.edge) {
        gesture = { kind: "resize", pointer: e.pointerId, start: p, id: hit.id, edge: hit.edge, dw: 0, dh: 0, moved: false };
        applyCursor();
        return;
      }
      if (hit) {
        const press = S.pressNode([...selected], hit.id, shift);
        emitSelection(press.selection);
        if (hit.region === "header") {
          const ids = S.movableIds(doc, press.selection, hit.id);
          if (ids.length === 0 && byId.get(hit.id)?.locked) announce("Nó bloqueado: não se move.");
          gesture = {
            kind: "move", pointer: e.pointerId, start: p, ids, set: new Set(ids), anchor: hit.id, dx: 0, dy: 0, moved: false, onClick: press.onClick,
            snap: undefined, snapKey: false, edge: undefined,
          };
        } else {
          gesture = { kind: "pan", pointer: e.pointerId, start: p, cam, moved: false, clearOnClick: false, onClick: press.onClick, grab: false };
        }
        return;
      }
      const marquee = shift || (opts.backgroundDrag ?? "pan") === "select";
      gesture = marquee
        ? { kind: "marquee", pointer: e.pointerId, start: world, end: world, base: [...selected], additive: shift, moved: false }
        : { kind: "pan", pointer: e.pointerId, start: p, cam, moved: false, clearOnClick: true, onClick: undefined, grab: false };
    }

    function onPointerMove(e: PointerEvent): void {
      if (linking && e.pointerType !== "touch") trackLinkCursor(screenPoint(e));
      if (!pointers.has(e.pointerId)) {
        trackResizeHover(e);
        return;
      }
      const p = screenPoint(e);
      pointers.set(e.pointerId, p);
      const g = gesture;
      if (g.kind === "pinch") {
        const a = pointers.get(g.ids[0]);
        const b = pointers.get(g.ids[1]);
        if (a && b) setCam(C.pinchCamera(g.start, a, b));
        return;
      }
      if (g.kind === "none" || g.pointer !== e.pointerId) return;
      if (g.kind !== "marquee" && !g.moved && !beyondSlop(p, g.start)) return;
      switch (g.kind) {
        case "pan":
          g.moved = true;
          setCam(C.panBy(g.cam, p.x - g.start.x, p.y - g.start.y));
          return;
        case "marquee": {
          const end = C.screenToWorld(cam, p);
          if (!g.moved && !beyondSlop(C.worldToScreen(cam, g.start), p)) return;
          g.moved = true;
          g.end = end;
          dirty.overlay = true;
          emitSelection(S.marqueeSelect(doc.nodes, S.rectFrom(g.start, end), g.base, g.additive));
          requestFrame();
          return;
        }
        case "move":
          g.moved = true;
          if (g.ids.length === 0) return;
          g.dx = (p.x - g.start.x) / cam.k;
          g.dy = (p.y - g.start.y) / cam.k;
          g.snapKey = e.ctrlKey || e.metaKey;
          g.snap = snapOf(g);
          g.edge = g.ids.length === 1 ? opts.dock?.edgeAt(p, view) : undefined;
          dirty.overlay = true;
          markContent();
          return;
        case "resize":
          g.moved = true;
          ({ dw: g.dw, dh: g.dh } = clampResize(g.id, g.edge, (p.x - g.start.x) / cam.k, (p.y - g.start.y) / cam.k));
          markContent();
          return;
        case "clamp-stroke":
          g.moved = true;
          g.end = C.screenToWorld(cam, p);
          dirty.overlay = true;
          requestFrame();
          return;
        case "clamp-move":
          g.moved = true;
          dragClamp(g, p);
          return;
        default: {
          const never: never = g;
          return never;
        }
      }
    }

    /** Encaixe magnético do arrasto, se ligado (modo ou Ctrl/Cmd) e se alguma guia acendeu; senão o soltar usa a grade. */
    // a borda solta encaixa na grade (resizeOp): o limite é a primeira linha da grade que ainda cabe o mínimo
    function clampResize(id: string, edge: SelectionModule.ResizeEdge, dx: number, dy: number): { dw: number; dh: number } {
      const node = byId.get(id);
      const min = node && minSizeOf ? minSizeOf(node) : undefined;
      if (!node || !min) return { dw: dx, dh: dy };
      const grid = S.SELECTION_LIMITS.grid;
      const leastEnd = (start: number, side: number, minSide: number) => Math.ceil((start + minSide) / grid) * grid - start - side;
      // a borda esquerda anda para a direita até a última linha da grade que ainda deixa o mínimo
      const mostStart = (start: number, side: number, minSide: number) => Math.floor((start + side - minSide) / grid) * grid - start;
      return {
        dw: edge.left ? Math.min(dx, mostStart(node.x, node.w, min.w)) : edge.right ? Math.max(dx, leastEnd(node.x, node.w, min.w)) : dx,
        dh: edge.bottom ? Math.max(dy, leastEnd(node.y, node.h, min.h)) : dy,
      };
    }
    function snapOf(g: Extract<Gesture, { kind: "move" }>): SnapMove | undefined {
      const snap = opts.snap;
      if (!snap || !(g.snapKey || snap.enabled())) return undefined;
      const result = snap.move(doc, g.ids, { dx: g.dx, dy: g.dy }, { zoom: cam.k });
      return result.guides.length > 0 ? result : undefined;
    }

    function onDoubleClick(e: MouseEvent): void {
      const dock = opts.dock;
      if (!dock || e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest("[data-canvas-node]")) return;
      const hit = S.hitTest(doc.nodes, C.screenToWorld(cam, screenPoint(e)), { k: cam.k, detail: detailOf(cam.k), resizable: () => false });
      if (hit?.region !== "header") return;
      e.preventDefault();
      dock.toggleElevated(hit.id);
    }

    function onPointerUp(e: PointerEvent): void {
      pointers.delete(e.pointerId);
      const g = gesture;
      if (g.kind === "pinch") {
        if (!g.ids.includes(e.pointerId)) return;
        gesture = { kind: "none" };
        return;
      }
      if (g.kind === "none" || g.pointer !== e.pointerId) return;
      gesture = { kind: "none" };
      applyCursor();
      if (e.type === "pointercancel") {
        markContent();
        dirty.overlay = true;
        return;
      }
      switch (g.kind) {
        case "pan":
          if (!g.moved && g.clearOnClick) emitSelection(S.pressEmpty([...selected], e.shiftKey));
          else if (!g.moved && g.onClick) emitSelection(g.onClick);
          break;
        case "marquee":
          dirty.overlay = true;
          if (!g.moved) emitSelection(S.pressEmpty(g.base, g.additive));
          break;
        case "move": {
          dirty.overlay = true;
          if (!g.moved) {
            if (g.onClick) emitSelection(g.onClick);
            break;
          }
          if (g.edge !== undefined && opts.dock) {
            opts.dock.dock(g.anchor, g.edge);
            break;
          }
          // de novo sobre o documento de agora: ele pode ter mudado desde o último movimento
          emitOp(snapOf(g)?.op ?? S.moveOp(doc, g.ids, g.anchor, g.dx, g.dy));
          break;
        }
        case "resize":
          if (g.moved) emitOp(S.resizeOp(doc, g.id, g.dw, g.dh, S.SELECTION_LIMITS.grid, g.edge));
          break;
        case "clamp-stroke":
          dirty.overlay = true;
          if (g.moved) finishClampStroke(g.from, g.end);
          break;
        case "clamp-move":
          if (g.moved && L) tryLinkOp(() => L.opMoveClamp(doc, g.clampId, g.ts));
          break;
        default: {
          const never: never = g;
          return never;
        }
      }
      markContent();
    }

    /** A roda sobre um campo de texto ou lista que rola dentro de um nó: se ainda há curso na direção, é do elemento. */
    function scrollsItself(target: EventTarget | null, e: WheelEvent): boolean {
      for (let el = target instanceof Element ? target : null; el && el !== host; el = el.parentElement) {
        const style = getComputedStyle(el);
        const y = /auto|scroll/.test(style.overflowY) && C.hasScrollRoom(el.scrollTop, el.clientHeight, el.scrollHeight, e.deltaY);
        const x = /auto|scroll/.test(style.overflowX) && C.hasScrollRoom(el.scrollLeft, el.clientWidth, el.scrollWidth, e.deltaX);
        if (y || x) return true;
      }
      return false;
    }

    function onWheel(e: WheelEvent): void {
      // Ctrl e Alt são do canvas em qualquer lugar; a roda comum sobre um campo que rola é dele, e a página não rola por baixo
      if (!e.ctrlKey && !e.altKey && scrollsItself(e.target, e)) return;
      // o terminal ao vivo (node-tty.tsx) é dono da roda comum sobre ele: nunca chega ao zoom/pan do canvas
      if (!e.ctrlKey && !e.altKey && e.target instanceof Element && e.target.closest("[data-tty-wheel]")) return;
      e.preventDefault();
      animation = undefined;
      // zoom com Espaço segurado é navegação: soltar o Espaço depois não seleciona o nó focado
      if (spaceHeld) spaceUsed = true;
      setCam(C.wheelCamera(cam, e, screenPoint(e)));
    }

    // ---- teclado ----
    function onKeyDown(e: KeyboardEvent): void {
      if (e.target instanceof Element && e.target.closest("[data-canvas-node]")) return;
      const key = e.key;
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if ((key === "Delete" || key === "Backspace") && selectedClamp !== undefined && L) {
          e.preventDefault();
          const id = selectedClamp;
          if (tryLinkOp(() => L.opReleaseClamp(doc, id))) {
            selectedClamp = undefined;
            announce("Abraçadeira solta.");
          }
          return;
        }
        // Enter no nó focado completa a conexão armada (o equivalente do clique, pelo teclado)
        if (key === "Enter" && linking && focusId !== undefined) {
          e.preventDefault();
          completeLink(focusId);
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        // Ctrl+= Ctrl+- Ctrl+0 com o canvas focado: zoom do canvas, não o da página; se a página já tratou (comando), não repete
        const chord = e.defaultPrevented ? undefined : C.cameraChord(key);
        if (!chord) return;
        e.preventDefault();
        moveCamera(chord.kind === "reset" ? C.zoomReset(cam, view) : C.zoomAt(cam, { x: view.w / 2, y: view.h / 2 }, chord.factor), true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return; // os demais atalhos com modificador são da página
      if (key === " ") {
        // segurar Espaço arma o pan; a seleção do nó focado, que era do Espaço, passa para quando ele é solto sem arrastar
        e.preventDefault();
        if (!spaceHeld) {
          spaceHeld = true;
          spaceUsed = false;
          spaceShift = e.shiftKey;
          applyCursor();
        }
        return;
      }
      if (key === "Tab") {
        const next = S.nextInOrder(tabOrder(), focusId, e.shiftKey);
        if (next === undefined) return; // ponta da ordem: o foco sai do canvas
        e.preventDefault();
        setFocus(next, true);
        return;
      }
      if (key === "Escape") {
        if (linking) cancelLink();
        else if (gesture.kind !== "none") cancelGesture();
        else if (selectedClamp !== undefined) clearClamp();
        else if (selected.size > 0) emitSelection([]);
        else if (focusId !== undefined) setFocus(undefined, true);
        else return;
        e.preventDefault();
        return;
      }
      if (focusId !== undefined && byId.has(focusId)) {
        const node = byId.get(focusId) as CanvasNode;
        if (key === "Enter" || key === "ContextMenu" || (key === "F10" && e.shiftKey)) {
          e.preventDefault();
          const s = C.worldToScreen(cam, { x: node.x + node.w / 2, y: node.y + node.h / 2 });
          opts.onNodeMenu?.({ id: node.id, screen: s });
          return;
        }
        if (S.isArrowKey(key)) {
          e.preventDefault();
          const op = S.nudgeOp(doc, [...selected], node.id, key, e.shiftKey);
          if (op) emitOp(op);
          else if (node.locked) announce("Nó bloqueado: não se move.");
          return;
        }
      }
      const action = C.cameraKey(key);
      if (!action) return;
      e.preventDefault();
      if (spaceHeld) spaceUsed = true;
      if (action.kind === "zoom") moveCamera(C.zoomAt(cam, { x: view.w / 2, y: view.h / 2 }, action.factor), true);
      else if (action.kind === "fit") moveCamera(C.fitAll(doc.nodes, view), true);
      else setCam(C.panBy(cam, action.dx, action.dy));
    }

    function onKeyUp(e: KeyboardEvent): void {
      if (e.key !== " " || !spaceHeld) return;
      const used = spaceUsed;
      releaseSpace();
      const node = focusId === undefined ? undefined : byId.get(focusId);
      if (used || !node) return;
      e.preventDefault();
      const next = S.keySelect([...selected], node.id, spaceShift);
      emitSelection(next, "key");
      announce(next.includes(node.id) ? `${next.length} selecionado(s).` : "Fora da seleção.");
    }
    function releaseSpace(): void {
      spaceHeld = false;
      spaceUsed = false;
      applyCursor();
    }

    function onFocus(e: FocusEvent): void {
      if (e.target !== host || focusId !== undefined || hostLevel) return;
      const ids = tabOrder();
      if (ids.length === 0) return;
      // Shift+Tab vindo de depois do canvas entra pelo último nó
      const from = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      const backward = from !== null && (host.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      setFocus(backward ? ids[ids.length - 1] : ids[0], true);
    }
    function onFocusOut(e: FocusEvent): void {
      const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (swappingFocus || (to && host.contains(to))) return;
      hostLevel = false;
      releaseSpace();
      // o foco saiu do canvas: o host volta a ser a parada do Tab (o botão do nó tem tabindex -1)
      proxy?.remove();
      proxy = undefined;
      focusId = undefined;
      host.tabIndex = 0;
    }

    // ---- tamanho, densidade de pixels e tema ----
    function resize(): void {
      const r = host.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      view = { w: Math.max(0, Math.round(r.width)), h: Math.max(0, Math.round(r.height)) };
      for (const ctx of Object.values(layers)) {
        ctx.canvas.width = Math.max(1, Math.round(view.w * dpr));
        ctx.canvas.height = Math.max(1, Math.round(view.h * dpr));
      }
      markAll();
      // desenha já: trocar o tamanho do canvas o apaga, e esperar o próximo quadro piscaria
      if (frameRequested) {
        cancelAnimationFrame(frameRequested);
        frameRequested = 0;
      }
      render(performance.now());
    }

    const listen = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void => {
      target.addEventListener(type, fn, options);
      cleanups.push(() => target.removeEventListener(type, fn, options));
    };
    listen(host, "pointerdown", onLinkPointerDown, { capture: true });
    listen(host, "pointerdown", onPointerDown);
    listen(host, "pointermove", onPointerMove);
    listen(host, "pointerup", onPointerUp);
    listen(host, "pointercancel", onPointerUp);
    listen(host, "pointerleave", () => { if (overResize) { overResize = undefined; applyCursor(); } });
    listen(host, "wheel", onWheel, { passive: false });
    listen(host, "keydown", onKeyDown);
    listen(host, "keyup", onKeyUp);
    // botão do meio: sem isto o navegador abre o autoscroll ou cola a seleção no Linux
    listen(host, "mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    listen(host, "focus", onFocus);
    listen(host, "focusout", onFocusOut);
    listen(host, "contextmenu", (e) => e.preventDefault());
    listen(host, "dblclick", onDoubleClick);

    const observer = new ResizeObserver(resize);
    observer.observe(host);
    cleanups.push(() => observer.disconnect());

    let dprQuery: MediaQueryList | undefined;
    const watchDpr = (): void => {
      dprQuery?.removeEventListener("change", onDpr);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener("change", onDpr);
    };
    function onDpr(): void {
      resize();
      watchDpr();
    }
    watchDpr();
    cleanups.push(() => dprQuery?.removeEventListener("change", onDpr));

    const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    darkQuery.addEventListener("change", readTheme);
    cleanups.push(() => darkQuery.removeEventListener("change", readTheme));
    const themeObserver = new MutationObserver(readTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    cleanups.push(() => themeObserver.disconnect());
    readTheme();
    if (!fontsReady) {
      void document.fonts.ready.then(() => {
        if (destroyed) return;
        fontsReady = true;
        readTheme();
      }, () => {
        fontsReady = true;
        markAll();
      });
    }

    const api: CanvasEngineApi = {
      getCamera: () => cam,
      setCamera: (next, animate = false) => moveCamera(next, animate),
      fitAll: (animate = true) => moveCamera(C.fitAll(doc.nodes, view), animate),
      fitRect: (rect, animate = true) => moveCamera(C.fitRect(rect, view), animate),
      zoomBy: (factor, anchor, animate = false) => moveCamera(C.zoomAt(cam, anchor ?? { x: view.w / 2, y: view.h / 2 }, factor), animate),
      zoomIn: (animate = true) => moveCamera(C.zoomStep(cam, view, 1), animate),
      zoomOut: (animate = true) => moveCamera(C.zoomStep(cam, view, -1), animate),
      zoomReset: (animate = true) => moveCamera(C.zoomReset(cam, view), animate),
      fitSelection: (animate = true) => {
        const rects = doc.nodes.filter((n) => selected.has(n.id));
        moveCamera(C.fitSelectionCamera(rects, view) ?? C.fitAll(doc.nodes, view), animate);
      },
      centerNode: (id, animate = true) => {
        const node = byId.get(id);
        if (node) moveCamera(C.focusNodeCamera(cam, node, view), animate);
      },
      onCamera: (listener) => {
        cameraListeners.add(listener);
        return () => cameraListeners.delete(listener);
      },
      focusNode: (id) => {
        if (byId.has(id)) setFocus(id, true);
      },
      revealNode: (id, animate = true) => {
        const node = byId.get(id);
        if (node) moveCamera(C.revealRect(cam, node, view), animate);
      },
      viewport: () => view,
      onFrame: (listener) => {
        frameListeners.add(listener);
        return () => frameListeners.delete(listener);
      },
      showDoc: (next) => handle.update({ doc: next }),
      setMinSize: (next) => {
        minSizeOf = next;
      },
      setEmphasis: (alpha) => {
        emphasis = alpha && alpha.size > 0 ? alpha : null;
        markContent();
      },
      startLink,
      cancelLink,
    };

    const handle: CanvasEngine = {
      api,
      update(next) {
        const prevDoc = doc;
        const shapeChanged = "nodeShape" in next && next.nodeShape !== opts.nodeShape;
        opts = { ...opts, ...next };
        if (shapeChanged) markContent();
        if (next.label !== undefined) applyLabel();
        if (next.describeNode || next.nodeColor) {
          labels = new Map();
          fills = new Map();
          markContent();
        }
        if (next.doc && next.doc !== prevDoc) {
          doc = next.doc;
          reindex();
          // gesto sobre nó que sumiu (desfazer, sincronia) é cancelado sem gerar operação
          if ((gesture.kind === "move" && gesture.ids.some((id) => !byId.has(id))) || (gesture.kind === "resize" && !byId.has(gesture.id))) cancelGesture();
          if (gesture.kind === "clamp-move" && !clampIndex.has(gesture.clampId)) cancelGesture();
          if (linking && !byId.has(linking.from)) endLink();
          if (focusId !== undefined && !byId.has(focusId)) setFocus(undefined, false);
          markContent();
          refreshProxyLabel();
        }
        if (next.selection && !S.sameSelection([...selected], next.selection)) {
          selected = new Set(next.selection);
          if (selected.size > 0) selectedClamp = undefined;
          markContent();
          refreshProxyLabel();
        }
        if (next.isRich) markContent();
        if ("fullDetail" in next) markAll();
      },
      bindHtml(id, el) {
        if (el) htmlEls.set(id, el);
        else htmlEls.delete(id);
        if (el) requestFrame();
      },
      destroy() {
        destroyed = true;
        if (frameRequested) cancelAnimationFrame(frameRequested);
        for (const cleanup of cleanups.splice(0)) cleanup();
        frameListeners.clear();
        cameraListeners.clear();
        htmlEls.clear();
        proxy?.remove();
        live.remove();
        for (const ctx of Object.values(layers)) ctx.canvas.remove();
      },
    };
    return handle;
  }

  /** Componente React do motor: monta as camadas e repassa as props; os nós ricos são filhos da camada HTML. */
  function CanvasView(props: CanvasViewProps): ReactNode {
    const h = React.createElement;
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const canvasRef = React.useRef<HTMLDivElement | null>(null);
    const htmlRef = React.useRef<HTMLDivElement | null>(null);
    const a11yRef = React.useRef<HTMLDivElement | null>(null);
    const engineRef = React.useRef<CanvasEngine | null>(null);
    const [rich, setRich] = React.useState<readonly string[]>([]);
    const latest = React.useRef(props);
    latest.current = props;

    React.useEffect(() => {
      const host = hostRef.current;
      const canvasBox = canvasRef.current;
      const htmlLayer = htmlRef.current;
      const a11yBox = a11yRef.current;
      if (!host || !canvasBox || !htmlLayer || !a11yBox) return undefined;
      // os retornos de chamada leem as props mais recentes: o motor nasce uma vez e não é recriado a cada render
      const p = latest.current;
      const engine = createCanvasEngine({ host, canvasBox, htmlLayer, a11yBox }, {
        ...p,
        onSelectionChange: (ids) => latest.current.onSelectionChange(ids),
        onOp: (op, next) => latest.current.onOp(op, next),
        onNodeMenu: (req) => latest.current.onNodeMenu?.(req),
        onCameraChange: (c) => latest.current.onCameraChange?.(c),
        onRichNodes: (ids) => setRich(ids),
      });
      engineRef.current = engine;
      p.onReady?.(engine.api);
      return () => {
        engine.destroy();
        engineRef.current = null;
      };
    }, []);

    React.useEffect(() => {
      engineRef.current?.update({ doc: props.doc, selection: props.selection });
    }, [props.doc, props.selection]);
    React.useEffect(() => {
      engineRef.current?.update({ describeNode: props.describeNode, nodeColor: props.nodeColor, isRich: props.isRich, nodeShape: props.nodeShape, backgroundDrag: props.backgroundDrag, label: props.label });
    }, [props.describeNode, props.nodeColor, props.isRich, props.nodeShape, props.backgroundDrag, props.label]);
    React.useEffect(() => {
      engineRef.current?.update({ fullDetail: props.fullDetail });
    }, [props.fullDetail]);
    React.useEffect(() => {
      engineRef.current?.update({ snap: props.snap, dock: props.dock });
    }, [props.snap, props.dock]);

    const byId = React.useMemo(() => new Map(props.doc.nodes.map((n) => [n.id, n])), [props.doc]);
    return h("div", { ref: hostRef, className: props.className, style: { position: "relative", overflow: "hidden", width: "100%", height: "100%", outline: "none" } },
      h("div", { ref: canvasRef, style: { position: "absolute", inset: 0 } }),
      h("div", { ref: htmlRef, style: { position: "absolute", left: 0, top: 0, pointerEvents: "none" } },
        props.renderNode ? rich.map((id) => {
          const node = byId.get(id);
          if (!node) return null;
          return h("div", {
            key: id,
            "data-canvas-node": id,
            ref: (el: HTMLDivElement | null) => engineRef.current?.bindHtml(id, el),
            style: { position: "absolute", left: 0, top: 0, overflow: "hidden", pointerEvents: "auto" },
          }, props.renderNode?.(node));
        }) : null),
      h("div", { ref: a11yRef, style: { position: "absolute", inset: 0, pointerEvents: "none" } }));
  }

  /** O desenho por forma, sem DOM, para o teste ler com um contexto que só registra as chamadas. */
  const shapePaint = { fillShape, strokeShape, sanitizeShape, LABEL_FIT };
  return { createCanvasEngine, CanvasView, shapePaint };
}

type ArgosCanvasApi = ReturnType<typeof makeArgosCanvas>;
(globalThis as unknown as { ArgosCanvas: ArgosCanvasApi }).ArgosCanvas = makeArgosCanvas();
export type {
  ArgosCanvasApi, CanvasDockHook, CanvasEngine, CanvasEngineApi, CanvasEngineOptions, CanvasModelApi, CanvasParts, CanvasSnapHook, CanvasViewProps, DockEdgeName, FrameInfo,
  NodeMenuRequest,
};
