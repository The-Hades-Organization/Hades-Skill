// Busca do canvas do Argos (reference/argos.md §Busca): casa o termo com nome do agente, card, PR, branch e arquivo, e
// devolve os ids e a caixa que os enquadra (para a câmera). Comparação de texto (sem acento, sem caixa), nunca uma regex
// montada com a entrada. O índice normaliza os campos uma vez; cada busca é linear nos nós.
import { boundsOf, type Rect } from "./canvas-camera.ts";

export const SEARCH_LIMITS = {
  /** Teto do termo depois de aparar e juntar espaços; acima disso a busca recusa em vez de truncar. */
  termChars: 100,
  /** Teto do texto cru, conferido antes de normalizar: a entrada gigante não custa um passo sobre ela inteira. */
  rawChars: 400,
} as const;

/** Códigos estáveis: só ganham valores, nunca renomeiam. */
export const SEARCH_PROBLEMS = { termTooLong: "search_term_too_long" } as const;
export type SearchProblem = (typeof SEARCH_PROBLEMS)[keyof typeof SEARCH_PROBLEMS];

/** O que a busca lê de um nó mais a caixa dele no canvas. `label` é o nome (agente, unidade) ou `#<n>` (PR). */
export interface SearchItem extends Rect {
  id: string;
  label: string;
  card?: string | null;
  /** Número da PR (nó `pr`). */
  number?: number | null;
  branch?: string | null;
  files?: readonly string[] | null;
}

export interface SearchResult {
  /** Ids que casaram, na ordem de `items`. Vazio com termo vazio. */
  ids: string[];
  /** Menor retângulo que contém os nós achados; `undefined` sem resultado. */
  box: Rect | undefined;
  /** Termo normalizado (aparado, espaços juntados, sem acento e minúsculo) com que se buscou. */
  term: string;
  problem?: SearchProblem;
}

export interface SearchIndex {
  size: number;
  search(term: string): SearchResult;
}

const MARKS = /\p{M}/gu;

/** Texto comparável: sem acento, minúsculo, espaços juntados. */
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(MARKS, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const PR_REFERENCE = /^#(\d{1,9})$/;
const DIGITS = /^\d{1,9}$/;

interface Entry {
  item: SearchItem;
  /** Campos de texto já normalizados (nome, card, branch, arquivos). */
  haystacks: string[];
  number: string | undefined;
}

function entryOf(item: SearchItem): Entry {
  const haystacks = [item.label, item.card, item.branch, ...(item.files ?? [])]
    .filter((field): field is string => typeof field === "string" && field !== "")
    .map(normalizeText);
  const number = typeof item.number === "number" && Number.isInteger(item.number) && item.number >= 0 ? String(item.number) : undefined;
  return { item, haystacks, number };
}

/**
 * `#123` casa só a PR de número 123. `123` casa PR cujo número começa por 123 e também qualquer texto que o contenha
 * (um card `ABC-123`, um arquivo `v123.md`). Qualquer outro termo casa por trecho de texto.
 */
function matches(entry: Entry, term: string): boolean {
  const reference = PR_REFERENCE.exec(term);
  if (reference) return entry.number === reference[1];
  if (DIGITS.test(term) && entry.number?.startsWith(term)) return true;
  return entry.haystacks.some((field) => field.includes(term));
}

export function createSearchIndex(items: readonly SearchItem[]): SearchIndex {
  const entries = items.map(entryOf);
  return {
    size: entries.length,
    search(raw) {
      if (raw.length > SEARCH_LIMITS.rawChars) return { ids: [], box: undefined, term: "", problem: SEARCH_PROBLEMS.termTooLong };
      const term = normalizeText(raw);
      if (term.length > SEARCH_LIMITS.termChars) return { ids: [], box: undefined, term: "", problem: SEARCH_PROBLEMS.termTooLong };
      if (term === "") return { ids: [], box: undefined, term };
      const found = entries.filter((entry) => matches(entry, term)).map((entry) => entry.item);
      return { ids: found.map((item) => item.id), box: boundsOf(found), term };
    },
  };
}

/** Busca única; para vários termos sobre os mesmos nós, `createSearchIndex` evita normalizar de novo. */
export const searchNodes = (items: readonly SearchItem[], term: string): SearchResult => createSearchIndex(items).search(term);
