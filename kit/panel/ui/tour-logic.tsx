/* Regra pura do tour por página: registro dos tours, prévia de exemplo e progresso por página.
 * Sem DOM e sem React: o navegador carrega como script (window.TourLogic, antes do app.js) e o bun test importa o mesmo
 * arquivo. O app.tsx expõe isto às páginas (HadesCore.registerTour, useTourPreview…); o tour.tsx desenha. */

type TourSide = "top" | "bottom" | "left" | "right";
interface TourStepDef {
  /** valor de data-tour-step-id no card da página (ou `tour-<página>`, o cabeçalho) */
  id: string;
  title: string;
  body: string;
  /** equivalente de terminal, mostrado em mono com copiar */
  command?: string;
  /** seção da referência (texto); o link leva à página Documentação */
  ref?: string;
  /** o que falta para o card aparecer e como ligar; mostrado quando o alvo não existe na tela */
  fallback?: string;
  side?: TourSide;
}
interface TourDef {
  steps: readonly TourStepDef[];
  /** dados fictícios da página; só em página que pode aparecer vazia */
  preview?: () => unknown;
}
interface TourKeyEvent { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; defaultPrevented?: boolean; repeat?: boolean }
interface TourKeyState { hasTour: boolean; typing: boolean; dialogOpen: boolean }
interface TourStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
type TourVerb = "seen" | "skip";

function makeTourLogic() {
  const TOUR_SIDES: readonly string[] = ["top", "bottom", "left", "right"];
  const TOUR_PROGRESS_KEY = "hades-tour-pages";
  const TOUR_PREVIEW_ERROR = "tour_preview";
  const tours = new Map<string, TourDef>();
  const subscribers = new Set<() => void>();
  let running: string | null = null;
  let previewId: string | null = null;
  let previewData: unknown = null;

  const notify = (): void => { for (const fn of [...subscribers]) fn(); };
  const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const optionalText = (v: unknown): boolean => v === undefined || text(v);

  /** Valida na entrada: tour malformado falha ao registrar (com a página no texto), não no meio do passo. */
  const register = (id: string, def: TourDef): void => {
    const where = `registerTour("${id}")`;
    if (!text(id)) throw new TypeError("registerTour(id, { steps, preview? }): id vazio");
    if (typeof def !== "object" || def === null || !Array.isArray(def.steps) || def.steps.length === 0) throw new TypeError(`${where}: steps vazio`);
    if (def.preview !== undefined && typeof def.preview !== "function") throw new TypeError(`${where}: preview deve ser função`);
    const seen = new Set<string>();
    for (const step of def.steps) {
      if (!text(step?.id) || !text(step.title) || !text(step.body)) throw new TypeError(`${where}: todo passo tem id, title e body`);
      if (!optionalText(step.command) || !optionalText(step.ref) || !optionalText(step.fallback)) throw new TypeError(`${where}: passo ${step.id}: command, ref e fallback são texto não vazio`);
      if (step.side !== undefined && !TOUR_SIDES.includes(step.side)) throw new TypeError(`${where}: passo ${step.id}: side inválido`);
      if (seen.has(step.id)) throw new TypeError(`${where}: passo repetido: ${step.id}`);
      seen.add(step.id);
    }
    tours.set(id, { steps: def.steps.map((s) => ({ ...s })), preview: def.preview });
  };

  /** Liga o tour da página; com `preview`, a página passa a ler os dados de exemplo. Falha da prévia deixa o tour sem ela. */
  const begin = (id: string): boolean => {
    const def = tours.get(id);
    if (!def) return false;
    running = id;
    previewId = null;
    previewData = null;
    if (def.preview) {
      try {
        const data = def.preview();
        if (data !== null && data !== undefined) { previewId = id; previewData = data; }
      } catch (e) {
        console.error(`tour: a prévia de ${id} falhou, o tour segue sem exemplo`, e);
      }
    }
    notify();
    return true;
  };

  const end = (): void => {
    if (running === null) return;
    running = null;
    previewId = null;
    previewData = null;
    notify();
  };

  const readProgress = (storage: TourStorage): Record<string, TourVerb> => {
    try {
      const parsed: unknown = JSON.parse(storage.getItem(TOUR_PROGRESS_KEY) ?? "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const out: Record<string, TourVerb> = {};
      for (const [page, verb] of Object.entries(parsed)) if (verb === "seen" || verb === "skip") out[page] = verb;
      return out;
    } catch {
      return {}; // armazenamento ilegível ou bloqueado: o tour é oferecido de novo, sem dano
    }
  };

  const markProgress = (storage: TourStorage, id: string, verb: TourVerb): void => {
    try {
      storage.setItem(TOUR_PROGRESS_KEY, JSON.stringify({ ...readProgress(storage), [id]: verb }));
    } catch {
      // navegação privada: não guarda e oferece de novo
    }
  };

  /**
   * Shift+? abre o tour da página, fora de campo de texto e sem diálogo aberto. O teclado não distingue ? de Shift+?, então
   * quem já tratou o ? (a ajuda de atalhos do Argos marca o evento) fica com ele: `defaultPrevented` recusa.
   */
  const opensTour = (e: TourKeyEvent, state: TourKeyState): boolean =>
    state.hasTour && running === null && e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.defaultPrevented && !e.repeat
    && !state.typing && !state.dialogOpen;

  /** Um tour por vez: o card que oferece o tour geral do onboarding some enquanto o tour de uma página roda e volta depois. */
  const offerVisible = (offered: boolean): boolean => offered && running === null;

  /** O localStorage do navegador sem lançar (navegação privada, armazenamento bloqueado). */
  const browserStorage = (): TourStorage => {
    const store = (): TourStorage | undefined => (globalThis as unknown as { localStorage?: TourStorage }).localStorage;
    return {
      getItem: (key) => { try { return store()?.getItem(key) ?? null; } catch { return null; } },
      setItem: (key, value) => { try { store()?.setItem(key, value); } catch { /* sem armazenamento: o tour é oferecido de novo */ } },
    };
  };

  return {
    register,
    opensTour,
    offerVisible,
    storage: browserStorage,
    begin,
    end,
    drop: (id: string): void => { tours.delete(id); },
    has: (id: string): boolean => tours.has(id),
    get: (id: string): TourDef | undefined => tours.get(id),
    ids: (): string[] => [...tours.keys()],
    running: (): string | null => running,
    /** Dados de exemplo da página, só enquanto o tour dela roda com prévia; senão null (a página lê os reais). */
    previewOf: (id: string): unknown => (previewId === id ? previewData : null),
    previewing: (): boolean => previewId !== null,
    /** Erro que o post do painel devolve durante a prévia: nenhuma rede, nada gravado. */
    previewRefusal: (): Error => Object.assign(new Error("Exemplo do tour: nada é gravado nem executado."), { code: TOUR_PREVIEW_ERROR }),
    subscribe: (fn: () => void): (() => void) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
    readProgress,
    markProgress,
    TOUR_PROGRESS_KEY,
    TOUR_PREVIEW_ERROR,
  };
}
type TourLogicApi = ReturnType<typeof makeTourLogic>;
(globalThis as unknown as { TourLogicFactory: typeof makeTourLogic; TourLogic: TourLogicApi }).TourLogicFactory = makeTourLogic;
(globalThis as unknown as { TourLogic: TourLogicApi }).TourLogic = makeTourLogic();
