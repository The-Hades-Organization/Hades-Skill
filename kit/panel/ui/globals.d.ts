// Tipos da interface do painel: React, lucide-react e htm chegam por <script> (vendor/), sem @types; aqui fica o mínimo
// que o app e as páginas usam, mais as primitivas que o app expõe em HadesCore/HadesPanel.

type ReactNode = string | number | boolean | null | undefined | ReactElement | readonly ReactNode[];
interface ReactElement {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  readonly key: string | null;
}
type Dispatch<A> = (action: A) => void;
type SetStateAction<S> = S | ((prev: S) => S);
type EffectCleanup = void | (() => void);
interface RefObject<T> {
  current: T;
}
type FC<P = Record<string, unknown>> = (props: P & { children?: ReactNode }) => ReactNode;

interface ReactApi {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: ReactNode[]): ReactElement;
  Fragment: FC;
  useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  useEffect(effect: () => EffectCleanup, deps?: readonly unknown[]): void;
  useRef<T>(initial: T): RefObject<T>;
  useRef<T>(initial: T | null): RefObject<T | null>;
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  useCallback<F extends (...args: never[]) => unknown>(fn: F, deps: readonly unknown[]): F;
  useId(): string;
  createContext<T>(initial: T): { Provider: FC<{ value: T }>; Consumer: FC };
  useContext<T>(ctx: { Provider: FC<{ value: T }> }): T;
}
declare const React: ReactApi;
declare const ReactDOM: { createRoot(el: Element | null): { render(node: ReactNode): void }; createPortal(node: ReactNode, container: Element): ReactElement };

declare namespace JSX {
  type Element = ReactElement;
  type ElementType = string | ((props: never) => ReactNode);
  interface ElementChildrenAttribute {
    children: unknown;
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
  interface IntrinsicElements {
    [tag: string]: Record<string, unknown>;
  }
}

type PanelComponent = FC<Record<string, unknown>>;
type IconComponent = FC<Record<string, unknown>>;
declare const LucideReact: Readonly<Record<string, IconComponent>>;
declare const htm: { bind(h: ReactApi["createElement"]): (strings: TemplateStringsArray, ...values: unknown[]) => ReactNode };
declare const marked: { parse(md: string, opts?: Record<string, unknown>): string };

/** Resposta de erro dos POSTs do painel: `{ error }` com código estável. */
interface PanelError {
  error?: string;
}

type PanelPost = (path: string, body: unknown, retry?: boolean) => Promise<Record<string, unknown> & PanelError>;
type PanelGet = (url: string) => Promise<Record<string, unknown>>;

/** Passo de um tour de página (`registerPage(id, Comp, { tour })` ou `HadesCore.registerTour`); só texto. */
interface PanelTourStep {
  /** valor de `data-tour-step-id` no card da página (ou `tour-<página>`, o cabeçalho) */
  id: string;
  title: string;
  body: string;
  /** equivalente de terminal, mostrado em mono com copiar */
  command?: string;
  /** seção da referência; o link leva à página Documentação */
  ref?: string;
  /** o que falta para o card aparecer e como ligar; mostrado quando o alvo não existe */
  fallback?: string;
  side?: "top" | "bottom" | "left" | "right";
}
interface PanelTour {
  steps: readonly PanelTourStep[];
  /** dados fictícios da página; só em página que pode aparecer vazia */
  preview?: () => unknown;
}

interface PanelPageOptions {
  badge?: () => ReactNode;
  tour?: PanelTour;
}

/** API que os scripts de página do plugin usam (window.HadesPanel); contrato até a 5.0.0. */
interface HadesPanelApi {
  readonly React: ReactApi;
  readonly html: (strings: TemplateStringsArray, ...values: unknown[]) => ReactNode;
  readonly I: Readonly<Record<string, IconComponent>>;
  cn(...parts: unknown[]): string;
  post: PanelPost;
  getJSON: PanelGet;
  registerPage(id: string, component: FC, options?: PanelPageOptions): void;
  registerDialog(id: string, component: FC): void;
  readonly [name: string]: unknown;
}

/** Primitivas e ganchos que as páginas do núcleo recebem da base (HadesCore). */
interface HadesCoreApi extends HadesPanelApi {
  useState: ReactApi["useState"];
  useEffect: ReactApi["useEffect"];
  useRef: ReactApi["useRef"];
  useMemo: ReactApi["useMemo"];
  useCallback: ReactApi["useCallback"];
  useId: ReactApi["useId"];
  /** Primitivas visuais: props abertas, o contrato é o do app.tsx. */
  Button: PanelComponent;
  Badge: PanelComponent;
  Dot: PanelComponent;
  Card: PanelComponent;
  CardHeader: PanelComponent;
  CardContent: PanelComponent;
  Progress: PanelComponent;
  Mono: PanelComponent;
  Tip: PanelComponent;
  Empty: PanelComponent;
  Loading: PanelComponent;
  Kpi: PanelComponent;
  Fio: PanelComponent;
  Regua: PanelComponent;
  Leitura: PanelComponent;
  LinhaDeEstado: PanelComponent;
  Num: PanelComponent;
  Tracos: PanelComponent;
  QuickAction: PanelComponent;
  JobRow: PanelComponent;
  CopyButton: PanelComponent;
  /** Erro com causa, ação e referência (ui/parts/erro.tsx; reference/erros.md §No painel). */
  ErroExplicado: PanelComponent;
  /** Texto do toast de falha: mensagem mais a ação do `explain`, se o painel mandou. */
  errDesc(e: unknown): string;
  WidgetApk: PanelComponent;
  Th: PanelComponent;
  Td: PanelComponent;
  Tr: PanelComponent;
  Table: PanelComponent;
  Segmented: PanelComponent;
  Choice: PanelComponent;
  /** Substitui o select nativo: `value`/`onChange(value)` em texto, `items`, `label`, `size` (sm|md), `placeholder`, `ref` no gatilho. */
  Select: PanelComponent;
  useWide(px: number): boolean;
  niceTicks(max: number, n: number): number[];
  niceTicksCovering(max: number, n: number): number[];
  Kbd: PanelComponent;
  Input: PanelComponent;
  Switch: PanelComponent;
  Checkbox: PanelComponent;
  Field: PanelComponent;
  Skeleton: PanelComponent;
  StateBadge: PanelComponent;
  HoldConfirm: PanelComponent;
  useConfirmPrefs(fresh?: boolean): { hold: boolean; typed: boolean };
  Dialog: PanelComponent;
  DialogHeader: PanelComponent;
  DialogFooter: PanelComponent;
  Sheet: PanelComponent;
  Menu: PanelComponent;
  AreaChart: PanelComponent;
  Legend: PanelComponent;
  PrPicker: PanelComponent;
  Terminal: PanelComponent;
  /** Terminal PTY (xterm.js): props `id` | `open`, `onExit`, `onState`, `onOpened`, `className`, `fontSize`. Contrato: reference/panel.md §Terminal › Interface. */
  PtyTerminal: PanelComponent;
  /** Celular (mobile-term.tsx): ganchos de nível e viewport, barra de teclas e terminal em tela cheia. Contrato: reference/panel.md §Layout no celular. */
  Mobile: { useIsMobile: () => boolean; useMobileLevel: () => { level: "list" | "detail"; enter: () => void; leave: () => void };
    useViewBox: (active: boolean) => { top: number; left: number; width: number; height: number; keyboard: boolean };
    TermKeyBar: PanelComponent; MobileTermScreen: PanelComponent };
  copyText: (text: string) => void;
  LogViewer: PanelComponent;
  ExampleSeal: PanelComponent;
  registerTour(id: string, tour: PanelTour): void;
  hasTour(id: string): boolean;
  startPageTour(id: string): boolean;
  /** Dados de exemplo da página enquanto o tour dela roda com prévia; senão null (use os reais). */
  useTourPreview(id: string): unknown;
}

interface Window {
  __TOKEN: string;
  HadesPanel: HadesPanelApi;
  HadesCore: HadesCoreApi;
  /** Regra pura do terminal (term-logic.tsx) e as bibliotecas do xterm (vendor/), carregadas antes do term.js. */
  TermLogic: Record<string, unknown>;
  Terminal: new (options?: Record<string, unknown>) => unknown;
  FitAddon: { FitAddon: new () => unknown };
  HadesFx?: Record<string, FC<Record<string, unknown>> | undefined>;
  /** Partes reutilizáveis (ui/parts/*.tsx), carregadas antes do app.js. */
  HadesParts?: { ErroExplicado?: PanelComponent } & Record<string, unknown>;
}
declare const HadesCore: HadesCoreApi;
