/* Editor do Cardinal dentro do nó `cardinal` (reference/extensoes.md §Editor embutido, plano U15): monta o iframe do build web
 * (`/ext/cardinal/web/index.html?host=1`, sandbox="allow-scripts" sem allow-same-origin: origem opaca, sem cookie, sem
 * localStorage, sem API do painel), liga a ponte postMessage de src/lib/cardinal-bridge.ts e mostra o estado, o aviso de
 * merge e os botões de exportar. Script clássico: registra window.ArgosNodeCardinal; o cartão do nó (U11) monta
 * `CardinalEditor` só com o nó expandido. Quem fala com as rotas é o pai (a página), nunca o iframe. */
import type * as BridgeModule from "../../../../src/lib/cardinal-bridge.ts";

type BridgeModel = typeof BridgeModule;
type Tree = ReactElement;

/** Rota do build web (U14): sem chave, o iframe não manda cookie. */
const WEB_URL = "/ext/cardinal/web/index.html?host=1";
/** Texto por estado e por código: o código é o contrato, a mensagem do editor não se mostra. */
const STATE_TEXT: Readonly<Record<string, string>> = {
  waiting: "Abrindo o editor…",
  loading: "Carregando o diagrama…",
  ready: "",
  readonly: "Só leitura",
  gone: "O arquivo saiu do disco",
  failed: "O editor não abriu",
  limit: "Há editores demais abertos; recolha outro nó para editar este.",
};
const REASON_TEXT: Readonly<Record<string, string>> = {
  format_too_new: "o arquivo é de um formato mais novo que o do editor",
  protocol_mismatch: "o editor fala outra versão da ponte",
  ready_timeout: "o build web não respondeu (confira `hades ext doctor cardinal`)",
  cardinal_not_found: "o diagrama não existe",
  cardinal_unreadable: "o arquivo não pôde ser lido",
  cardinal_format_too_new: "o arquivo é de um formato mais novo que o do editor",
};
const CONFLICT_TEXT: Readonly<Record<string, string>> = {
  "both-changed": "alterado dos dois lados",
  "deleted-vs-changed": "apagado de um lado e alterado do outro",
  "dangling-reference": "referência sem destino",
};

function makeArgosNodeCardinal() {
  const g = globalThis as unknown as { CanvasModel?: { cardinalBridge?: BridgeModel } };
  if (!g.CanvasModel?.cardinalBridge) throw new Error("ArgosNodeCardinal: carregue /ui/lib/canvas-model.js (com `cardinalBridge`) antes de node-cardinal.js");
  const B = g.CanvasModel.cardinalBridge;
  const h = (type: unknown, props?: Record<string, unknown> | null, ...children: ReactNode[]): Tree => React.createElement(type, props, ...children);

  /** Altura da barra: a do cabeçalho dos outros nós do Argos (SELECTION_LIMITS.header, 24). */
  const BAR = "h-6 shrink-0";
  const BTN = "h-full shrink-0 px-1.5 t-label hover:bg-hover focus-visible:bg-accent outline-none disabled:opacity-40";
  /** Lado, em unidades de mundo, da área sobre o iframe que deixa a alça de redimensionar do canvas chegar ao motor (o iframe engole o ponteiro). */
  const RESIZE_CORNER = 24;
  /** Escala do PNG exportado (nitidez em tela densa). */
  const PNG_SCALE = 2;

  interface EditorProps {
    canvasId: string;
    nodeId: string;
    /** Nome do diagrama (`data.cardinal`): os avisos do SSE vêm por ele. */
    name: string;
    /** Título do nó, mostrado na barra do editor. */
    title?: string;
    /** O botão da barra que fecha o editor (atalho: o zoom também fecha). */
    onToggle?(): void;
    /** O nó está no tamanho grande de `onExpand`; a ação vira "Recolher". Ausente `onExpand`, a barra não oferece a ação. */
    expanded?: boolean;
    onExpand?(): void;
    /** O `fetch` com chave da página. */
    fetch: BridgeModule.ClientFetch;
    /** Recolher o nó: salva o que estiver pendente e, ao terminar, chama `onClosed`. */
    closing?: boolean;
    onClosed?(saved: boolean): void;
    /** Resultado de um export (SVG ou PNG), com os bytes para quem quiser baixar. */
    onExported?(format: BridgeModule.ImageFormat, outcome: BridgeModule.ExportOutcome): void;
    /** Troca os avisos e os editores vivos nos testes. */
    feed?: BridgeModule.CardinalFeed;
    slots?: BridgeModule.EditorSlots;
    webUrl?: string;
  }

  function CardinalEditor(props: EditorProps): Tree {
    const feed = props.feed ?? B.cardinalFeed;
    const slots = props.slots ?? B.editorSlots;
    const [state, setState] = React.useState<BridgeModule.EditorState | "limit">("waiting");
    const [reason, setReason] = React.useState<string | undefined>(undefined);
    const [dirty, setDirty] = React.useState(false);
    const [saved, setSaved] = React.useState<string | undefined>(undefined);
    const [notice, setNotice] = React.useState<BridgeModule.MergeConflict[] | null>(null);
    const [message, setMessage] = React.useState<string | undefined>(undefined);
    const [busy, setBusy] = React.useState(false);
    const frame = React.useRef<HTMLIFrameElement | null>(null);
    const bridge = React.useRef<BridgeModule.Bridge | null>(null);
    // o lugar entre os editores vivos é pedido na montagem (o iframe nem existe sem ele) e devolvido só ao desmontar
    const [hasSlot] = React.useState(() => slots.acquire(props.nodeId));
    React.useEffect(() => () => slots.release(props.nodeId), []);

    React.useEffect(() => {
      if (!hasSlot) {
        setState("limit");
        return undefined;
      }
      const iframe = frame.current;
      if (!iframe) return undefined;
      const instance = B.createBridge({
        frame: { post: (data, transfer) => iframe.contentWindow?.postMessage(data, "*", transfer) },
        api: B.createCardinalClient({ fetch: props.fetch, canvasId: props.canvasId, nodeId: props.nodeId }),
        onState: (next, why) => {
          setState(next);
          setReason(why);
        },
        onDirty: setDirty,
        onSaved: (rev) => setSaved(rev),
        onMergeNotice: setNotice,
        onError: (code) => setMessage(REASON_TEXT[code] ?? `erro do editor (${code})`),
      });
      bridge.current = instance;
      const onMessage = (event: MessageEvent): void => {
        if (B.isFromFrame(event, iframe.contentWindow)) instance.handle(event.data);
      };
      window.addEventListener("message", onMessage);
      const unsubscribe = feed.subscribe(props.name, (n) => instance.fileChanged(n.rev));
      // aba escondida: tirar o foco do iframe dispara o salvamento do editor antes de o navegador congelar a página
      const onHidden = (): void => {
        if (document.hidden && instance.dirty()) iframe.contentWindow?.blur();
      };
      document.addEventListener("visibilitychange", onHidden);
      const readyTimer = setTimeout(() => {
        if (instance.state() === "waiting") {
          setState("failed");
          setReason("ready_timeout");
        }
      }, B.READY_TIMEOUT_MS);
      return () => {
        clearTimeout(readyTimer);
        document.removeEventListener("visibilitychange", onHidden);
        unsubscribe();
        window.removeEventListener("message", onMessage);
        instance.close();
        bridge.current = null;
      };
    }, [hasSlot, props.canvasId, props.nodeId, props.name]);

    // recolher o nó: salva o pendente (ou desiste no prazo) e só então o pai destrói o iframe
    React.useEffect(() => {
      if (!props.closing) return;
      const instance = bridge.current;
      if (!instance) {
        props.onClosed?.(true);
        return;
      }
      void instance.flush(() => frame.current?.contentWindow?.blur()).then((ok) => props.onClosed?.(ok));
    }, [props.closing]);

    const exportAs = async (format: BridgeModule.ImageFormat): Promise<void> => {
      const instance = bridge.current;
      if (!instance || busy) return;
      setBusy(true);
      setMessage(undefined);
      const outcome = await instance.requestExport(format, format === "png" ? { scale: PNG_SCALE } : {});
      setBusy(false);
      props.onExported?.(format, outcome);
      if (!outcome.ok) setMessage(`Não exportou ${format.toUpperCase()} (${outcome.error ?? "erro"})`);
      else if (outcome.stored) setMessage(`${format.toUpperCase()} gravado ao lado do diagrama`);
      else setMessage(outcome.storedReason === "dirty" ? `${format.toUpperCase()} gerado; salve o diagrama para gravá-lo ao lado` : `${format.toUpperCase()} gerado`);
    };

    const status = state === "ready" ? (dirty ? "Editando…" : saved !== undefined ? "Salvo" : "") : STATE_TEXT[state] ?? "";
    const why = reason === undefined ? "" : REASON_TEXT[reason] ?? reason;
    const usable = state === "ready" || state === "readonly";

    return h("div", { className: "relative flex h-full min-h-0 w-full flex-col", "data-cardinal-editor": state },
      h("div", { className: `flex ${BAR} items-center gap-1 overflow-hidden pl-1`, role: "toolbar", "aria-label": "Editor do Cardinal" },
        props.title ? h("span", { className: "t-label max-w-[40%] truncate font-semibold", title: props.name }, props.title) : null,
        h("span", { className: "t-label flex-1 truncate", role: "status", "aria-live": "polite" }, [status, why && state !== "ready" ? `: ${why}` : "", message ? ` · ${message}` : ""].join("")),
        h("button", { type: "button", className: BTN, disabled: !usable || busy, "aria-label": "Exportar SVG", title: "Exportar SVG", onClick: () => void exportAs("svg") }, "SVG"),
        h("button", { type: "button", className: BTN, disabled: !usable || busy, "aria-label": "Exportar PNG", title: "Exportar PNG", onClick: () => void exportAs("png") }, "PNG"),
        props.onExpand
          ? h("button", { type: "button", className: BTN, "aria-pressed": props.expanded === true, "data-cardinal-expand": "", title: props.expanded ? "Voltar ao tamanho anterior" : "Abrir numa área grande", onClick: props.onExpand }, props.expanded ? "Recolher" : "Expandir")
          : null,
        props.onToggle
          ? h("button", { type: "button", className: BTN, disabled: props.closing, "aria-expanded": true, "aria-label": `Fechar o editor de ${props.title ?? props.name}`, "data-cardinal-toggle": "", onClick: props.onToggle }, "Fechar")
          : null),
      notice && notice.length > 0
        ? h("div", { className: "flex items-start gap-2 bg-popover px-2 py-1 t-label", role: "alert", "data-cardinal-merge-notice": "" },
          h("span", { className: "flex-1" }, `Alguém alterou o diagrama enquanto você editava. Sua versão ficou em ${notice.length} ${notice.length === 1 ? "ponto" : "pontos"}: ${[...new Set(notice.map((c) => CONFLICT_TEXT[c.kind] ?? c.kind))].join(", ")}.`),
          h("button", { type: "button", className: BTN, onClick: () => setNotice(null) }, "Entendi"))
        : null,
      hasSlot
        ? h("iframe", {
          ref: frame, src: props.webUrl ?? WEB_URL, title: `Editor do diagrama ${props.name}`, sandbox: "allow-scripts",
          referrerPolicy: "no-referrer", className: "min-h-0 w-full flex-1 border-0", "data-cardinal-frame": "",
        })
        : h("div", { className: "flex flex-1 items-center justify-center px-2 t-label", role: "status" }, STATE_TEXT.limit),
      hasSlot ? h("div", { className: "absolute bottom-0 right-0 z-10", style: { width: RESIZE_CORNER, height: RESIZE_CORNER, cursor: "nwse-resize" }, "aria-hidden": "true", "data-cardinal-resize-corner": "" }) : null);
  }

  return { CardinalEditor, WEB_URL, STATE_TEXT, REASON_TEXT, CONFLICT_TEXT };
}

type ArgosNodeCardinalApi = ReturnType<typeof makeArgosNodeCardinal>;
(globalThis as unknown as { ArgosNodeCardinal: ArgosNodeCardinalApi }).ArgosNodeCardinal = makeArgosNodeCardinal();
export type { ArgosNodeCardinalApi };
