/* Regra pura do Select do painel: lista com grupos, índice ativo, teclado, digitar para pular e filtro da busca.
 * Sem DOM e sem React: o navegador carrega como script (window.SelectLogic, antes do app.js) e o bun test importa o mesmo
 * arquivo. O app.tsx desenha o gatilho e a lista; toda decisão do teclado sai daqui. Contrato: reference/panel.md §Select. */

interface SelectItem {
  value: string;
  label: string;
  count?: number;
  icon?: unknown;
  hint?: string;
  disabled?: boolean;
  group?: string;
}
/** Linha da lista desenhada: cabeçalho de grupo ou opção (`index` aponta para o item visível, o que `active` usa). */
type SelectRow = { kind: "group"; label: string } | { kind: "option"; item: SelectItem; index: number };
interface SelectKeyEvent { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }
interface SelectTyped { text: string; at: number }
interface SelectState {
  open: boolean;
  /** índice no vetor de itens visíveis; -1 sem opção ativa */
  active: number;
  typed: SelectTyped;
}
interface SelectStep {
  state: SelectState;
  /** valor escolhido por Enter, Espaço ou Tab */
  pick?: string;
  /** o evento foi tratado: o componente chama preventDefault (e stopPropagation no Esc) */
  handled: boolean;
}

function makeSelectLogic() {
  /** A lista com mais opções que isto ganha o campo de busca. */
  const SEARCH_MIN_OPTIONS = 10;
  /** Pausa que zera o texto digitado para pular (ms). */
  const TYPE_RESET_MS = 700;
  /** Quanto PageUp/PageDown andam. */
  const PAGE_STEP = 10;

  const fold = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const enabled = (item: SelectItem | undefined): boolean => item !== undefined && item.disabled !== true;

  const searchable = (items: readonly SelectItem[]): boolean => items.length > SEARCH_MIN_OPTIONS;

  /** Itens que casam com a busca (rótulo, dica ou grupo, sem acento nem caixa); busca vazia devolve tudo. */
  function filter(items: readonly SelectItem[], query: string): SelectItem[] {
    const q = fold(query.trim());
    if (q === "") return [...items];
    return items.filter((it) => fold(`${it.label} ${it.hint ?? ""} ${it.group ?? ""}`).includes(q));
  }

  /** Linhas da lista: itens do mesmo grupo ficam juntos (ordem da primeira aparição); sem grupo, sem cabeçalho. */
  function rows(items: readonly SelectItem[]): SelectRow[] {
    const sections = new Map<string, number[]>();
    items.forEach((it, i) => {
      const key = it.group ?? "";
      const list = sections.get(key);
      if (list) list.push(i); else sections.set(key, [i]);
    });
    const out: SelectRow[] = [];
    for (const [group, indexes] of sections) {
      if (group !== "") out.push({ kind: "group", label: group });
      for (const index of indexes) {
        const item = items[index];
        if (item) out.push({ kind: "option", item, index });
      }
    }
    return out;
  }

  /** Itens na ordem em que aparecem na tela (agrupados), para o teclado andar na mesma ordem que o olho. */
  function ordered(items: readonly SelectItem[]): SelectItem[] {
    return rows(items).flatMap((r) => (r.kind === "option" ? [r.item] : []));
  }

  const firstEnabled = (items: readonly SelectItem[]): number => items.findIndex(enabled);
  const lastEnabled = (items: readonly SelectItem[]): number => {
    for (let i = items.length - 1; i >= 0; i--) if (enabled(items[i])) return i;
    return -1;
  };

  /** Opção ativa ao abrir: a selecionada se puder ser escolhida; senão a primeira habilitada. */
  function initialActive(items: readonly SelectItem[], value: string): number {
    const at = items.findIndex((it) => it.value === value && enabled(it));
    return at >= 0 ? at : firstEnabled(items);
  }

  /** Próxima habilitada a partir de `from` na direção `dir`, sem dar a volta; sem uma, fica onde está. */
  function stepFrom(items: readonly SelectItem[], from: number, dir: 1 | -1): number {
    for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (enabled(items[i])) return i;
    return from;
  }

  /** Move o índice ativo pelas teclas de navegação; outra tecla devolve o mesmo índice. */
  function move(items: readonly SelectItem[], active: number, key: string): number {
    if (items.length === 0) return -1;
    switch (key) {
      case "ArrowDown": return active < 0 ? firstEnabled(items) : stepFrom(items, active, 1);
      case "ArrowUp": return active < 0 ? lastEnabled(items) : stepFrom(items, active, -1);
      case "Home": return firstEnabled(items);
      case "End": return lastEnabled(items);
      case "PageDown": {
        let at = active;
        for (let n = 0; n < PAGE_STEP; n++) at = stepFrom(items, at < 0 ? -1 : at, 1);
        return at;
      }
      case "PageUp": {
        let at = active < 0 ? items.length : active;
        for (let n = 0; n < PAGE_STEP; n++) at = stepFrom(items, at, -1);
        return at;
      }
      default: return active;
    }
  }

  /** Acumula o que foi digitado; passada a pausa, recomeça do caractere novo. */
  function typedAfter(prev: SelectTyped, key: string, now: number): SelectTyped {
    return { text: now - prev.at > TYPE_RESET_MS ? key : prev.text + key, at: now };
  }

  /**
   * Opção para onde digitar pula. Um caractere repetido (aaa) percorre as que começam por ele; senão acha a primeira que
   * começa pelo texto, a partir da ativa e dando a volta. Sem casamento, fica na ativa.
   */
  function typeahead(items: readonly SelectItem[], active: number, text: string): number {
    if (text === "" || items.length === 0) return active;
    const t = fold(text);
    const cycling = t.length > 1 && [...t].every((c) => c === t[0]);
    const needle = cycling ? (t[0] ?? t) : t;
    const from = cycling || t.length === 1 ? active + 1 : Math.max(active, 0);
    for (let n = 0; n < items.length; n++) {
      const i = (from + n) % items.length;
      const it = items[i];
      if (enabled(it) && it && fold(it.label).startsWith(needle)) return i;
    }
    return active;
  }

  const isPrintable = (e: SelectKeyEvent): boolean => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  const OPEN_KEYS: readonly string[] = ["ArrowDown", "ArrowUp", "Enter", " ", "Home", "End"];
  const NAV_KEYS: readonly string[] = ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"];

  const initial = (): SelectState => ({ open: false, active: -1, typed: { text: "", at: 0 } });

  /**
   * Uma tecla no gatilho ou na lista. `items` são os visíveis (já filtrados e na ordem da tela); `hasSearch` diz que o campo
   * de busca recebe o texto digitado e o Espaço (então esses não são tratados aqui). `now` entra por parâmetro (teste).
   */
  function keyStep(items: readonly SelectItem[], value: string, state: SelectState, e: SelectKeyEvent, now: number, hasSearch: boolean): SelectStep {
    const idle: SelectStep = { state, handled: false };
    if (e.ctrlKey || e.metaKey || (e.altKey && e.key !== "ArrowDown" && e.key !== "ArrowUp")) return idle;
    if (!state.open) {
      if (OPEN_KEYS.includes(e.key)) {
        const active = e.key === "Home" ? firstEnabled(items) : e.key === "End" ? lastEnabled(items) : initialActive(items, value);
        return { state: { ...state, open: true, active }, handled: true };
      }
      if (isPrintable(e) && !hasSearch) {
        const typed = typedAfter(state.typed, e.key, now);
        return { state: { open: true, active: typeahead(items, initialActive(items, value), typed.text), typed }, handled: true };
      }
      if (isPrintable(e)) return { state: { ...state, open: true, active: firstEnabled(items) }, handled: false };
      return idle;
    }
    if (e.key === "Escape") return { state: { ...state, open: false }, handled: true };
    if (NAV_KEYS.includes(e.key)) return { state: { ...state, active: move(items, state.active, e.key) }, handled: true };
    if (e.key === "Enter" || (e.key === " " && !hasSearch)) {
      const it = items[state.active];
      return { state: { ...state, open: false }, pick: it && enabled(it) ? it.value : undefined, handled: true };
    }
    if (e.key === "Tab") {
      const it = items[state.active];
      return { state: { ...state, open: false }, pick: it && enabled(it) ? it.value : undefined, handled: false };
    }
    if (isPrintable(e) && !hasSearch) {
      const typed = typedAfter(state.typed, e.key, now);
      return { state: { ...state, active: typeahead(items, state.active, typed.text), typed }, handled: true };
    }
    return idle;
  }

  /** Índice ativo depois que a busca mudou a lista: a primeira habilitada (a selecionada, se ainda aparece). */
  const afterFilter = (items: readonly SelectItem[], value: string): number => initialActive(items, value);

  return { SEARCH_MIN_OPTIONS, TYPE_RESET_MS, searchable, filter, rows, ordered, initialActive, move, typedAfter, typeahead, initial, keyStep, afterFilter };
}

type SelectLogicApi = ReturnType<typeof makeSelectLogic>;
(globalThis as unknown as { SelectLogicFactory: typeof makeSelectLogic; SelectLogic: SelectLogicApi }).SelectLogicFactory = makeSelectLogic;
(globalThis as unknown as { SelectLogic: SelectLogicApi }).SelectLogic = makeSelectLogic();
