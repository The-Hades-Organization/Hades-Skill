// Compor mensagem pelo canvas (reference/argos.md §Compor e criar): rascunho por agente e referência `@` a uma nota ou
// a um nó, resolvida no texto que vai ser enviado. Puro, imutável e sem Node: o painel guarda o mapa de rascunhos onde
// quiser e só chama estas funções. Não há operação sobre o documento, então nada entra na pilha de desfazer.
import { type CanvasDoc, type CanvasNode } from "./canvas-doc.ts";

export const COMPOSE_LIMITS = {
  /** Texto digitado, antes de resolver as referências. */
  draftChars: 20_000,
  /** Quantos agentes podem ter rascunho guardado ao mesmo tempo. */
  drafts: 200,
  /** Referências `@` por mensagem. */
  references: 50,
  /** Texto de uma nota inserido no lugar da referência. */
  referenceChars: 2_000,
  /** Mensagem final, já com as referências resolvidas. */
  messageChars: 60_000,
  agentChars: 31,
} as const;

/** Códigos estáveis: só ganham valores. */
export const COMPOSE_ERRORS = {
  invalidAgent: "compose_invalid_agent",
  invalidText: "compose_invalid_text",
  tooLong: "compose_too_long",
  tooManyDrafts: "compose_too_many_drafts",
  tooManyReferences: "compose_too_many_references",
  unknownReference: "compose_unknown_reference",
  referenceTooLong: "compose_reference_too_long",
  emptyMessage: "compose_empty_message",
} as const;
export type ComposeErrorCode = (typeof COMPOSE_ERRORS)[keyof typeof COMPOSE_ERRORS];

export class ComposeError extends Error {
  readonly code: ComposeErrorCode;
  /** Ids (referências) ou agente que causaram o erro. */
  readonly subjects: readonly string[];
  constructor(code: ComposeErrorCode, message: string, subjects: readonly string[] = []) {
    super(message);
    this.name = "ComposeError";
    this.code = code;
    this.subjects = subjects;
  }
}

const fail = (code: ComposeErrorCode, message: string, subjects: readonly string[] = []): never => {
  throw new ComposeError(code, message, subjects);
};

/** Mesma regra de nome do `hades agent` (`agent-new.ts`); o módulo não importa de `src/commands` para rodar no navegador. */
const AGENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
const ID_CHAR = /[\w.:-]/;
const NOTE_TYPE = "note";

/** Rascunhos por agente. Nunca é mudado no lugar: cada função devolve um mapa novo. */
export type Drafts = Readonly<Record<string, string>>;

const checkAgent = (agent: string): void => {
  if (typeof agent !== "string" || !AGENT_PATTERN.test(agent)) fail(COMPOSE_ERRORS.invalidAgent, "nome de agente inválido", [String(agent)]);
};

const checkText = (text: unknown): string => {
  if (typeof text !== "string") return fail(COMPOSE_ERRORS.invalidText, "o texto deve ser uma string");
  if (text.length > COMPOSE_LIMITS.draftChars) return fail(COMPOSE_ERRORS.tooLong, `o texto passa de ${COMPOSE_LIMITS.draftChars} caracteres`);
  return text;
};

/** Texto guardado do agente, ou "" quando não há rascunho. */
export const getDraft = (drafts: Drafts, agent: string): string => (Object.hasOwn(drafts, agent) ? (drafts[agent] ?? "") : "");

/** Guarda o rascunho do agente. Texto vazio (só espaço inclusive) apaga o rascunho. */
export function setDraft(drafts: Drafts, agent: string, text: string): Drafts {
  checkAgent(agent);
  const value = checkText(text);
  const next: Record<string, string> = { ...drafts };
  if (value.trim() === "") {
    delete next[agent];
    return next;
  }
  if (!Object.hasOwn(next, agent) && Object.keys(next).length >= COMPOSE_LIMITS.drafts) {
    return fail(COMPOSE_ERRORS.tooManyDrafts, `no máximo ${COMPOSE_LIMITS.drafts} rascunhos guardados`);
  }
  next[agent] = value;
  return next;
}

/** Descarta o rascunho (depois de enviar). Agente sem rascunho devolve o mesmo conteúdo. */
export function clearDraft(drafts: Drafts, agent: string): Drafts {
  checkAgent(agent);
  const next: Record<string, string> = { ...drafts };
  delete next[agent];
  return next;
}

/** Agentes com rascunho, em ordem alfabética (comparação de código). */
export const draftAgents = (drafts: Drafts): string[] => Object.keys(drafts).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export interface Reference {
  /** Posição do `@` e do fim do id no texto: `text.slice(start, end)` é a referência inteira. */
  start: number;
  end: number;
  id: string;
}

/**
 * Referências `@id` do texto, em ordem. O `@` só vale no começo ou depois de espaço/pontuação (e-mail não conta), `@@` é
 * um `@` literal e ponto, dois-pontos ou hífen no fim do id são pontuação da frase. Varredura linear.
 */
export function findReferences(text: string): Reference[] {
  const found: Reference[] = [];
  let at = 0;
  while (at < text.length) {
    if (text[at] !== "@") {
      at += 1;
      continue;
    }
    const before = at === 0 ? "" : (text[at - 1] ?? "");
    if (text[at + 1] === "@") {
      at += 2;
      continue;
    }
    if (before !== "" && ID_CHAR.test(before)) {
      at += 1;
      continue;
    }
    let end = at + 1;
    while (end < text.length && ID_CHAR.test(text[end] ?? "")) end += 1;
    while (end > at + 1 && /[.:-]/.test(text[end - 1] ?? "")) end -= 1;
    if (end > at + 1) found.push({ start: at, end, id: text.slice(at + 1, end) });
    at = Math.max(end, at + 1);
  }
  return found;
}

export interface ResolvedReference {
  id: string;
  kind: "note" | "node";
}

export interface ComposedMessage {
  /** O que vai ao agente: as referências já trocadas pelo conteúdo, `@@` já virou `@`. */
  text: string;
  /** Cada id referenciado uma vez, na ordem em que aparece. */
  references: ResolvedReference[];
}

const nodeLabel = (node: CanvasNode): string => {
  const label = node.data.label ?? node.data.title ?? node.data.name;
  return typeof label === "string" && label.trim() !== "" ? ` "${label.trim()}"` : "";
};

const expand = (node: CanvasNode): { kind: "note" | "node"; text: string } => {
  if (node.type !== NOTE_TYPE) return { kind: "node", text: `[nó ${node.id} (${node.type})${nodeLabel(node)}]` };
  const body = node.data.text;
  const content = typeof body === "string" ? body.trim() : "";
  if (content.length > COMPOSE_LIMITS.referenceChars) {
    return fail(COMPOSE_ERRORS.referenceTooLong, `a nota ${node.id} passa de ${COMPOSE_LIMITS.referenceChars} caracteres`, [node.id]);
  }
  return { kind: "note", text: `[nota ${node.id}: ${content}]` };
};

/**
 * Resolve as referências `@` contra o documento. Referência que não existe é erro (`compose_unknown_reference`, com todos
 * os ids que faltam em `subjects`), nunca some do texto. Mensagem vazia, acima do teto ou com referência demais também
 * falha, com código próprio.
 */
export function composeMessage(text: string, doc: Pick<CanvasDoc, "nodes">): ComposedMessage {
  const source = checkText(text);
  if (source.trim() === "") return fail(COMPOSE_ERRORS.emptyMessage, "a mensagem está vazia");
  const found = findReferences(source);
  if (found.length > COMPOSE_LIMITS.references) {
    return fail(COMPOSE_ERRORS.tooManyReferences, `no máximo ${COMPOSE_LIMITS.references} referências por mensagem`);
  }
  const byId = new Map<string, CanvasNode>();
  for (const node of doc.nodes) byId.set(node.id, node);
  const missing = [...new Set(found.map((ref) => ref.id).filter((id) => !byId.has(id)))];
  if (missing.length > 0) return fail(COMPOSE_ERRORS.unknownReference, `referência a nó inexistente: ${missing.join(", ")}`, missing);

  const references: ResolvedReference[] = [];
  const seen = new Set<string>();
  const parts: string[] = [];
  let cursor = 0;
  for (const ref of found) {
    const node = byId.get(ref.id);
    if (!node) continue;
    const expanded = expand(node);
    parts.push(source.slice(cursor, ref.start), expanded.text);
    cursor = ref.end;
    if (!seen.has(ref.id)) {
      seen.add(ref.id);
      references.push({ id: ref.id, kind: expanded.kind });
    }
  }
  parts.push(source.slice(cursor));
  const message = parts.join("").replaceAll("@@", "@");
  if (message.length > COMPOSE_LIMITS.messageChars) {
    return fail(COMPOSE_ERRORS.tooLong, `a mensagem resolvida passa de ${COMPOSE_LIMITS.messageChars} caracteres`);
  }
  return { text: message, references };
}

// ---- Compositor flutuante (reference/argos.md §Compositor) ----
// Rascunho por terminal com colagens grandes recolhidas em pílulas numeradas e menções `@`. A pílula vive no texto como um
// marcador `⟦colagem N · L linhas⟧` e o conteúdo fica no mapa `pastes` do rascunho: recortar, colar e desfazer mexem só no
// texto, então o número acompanha o marcador. O mapa só esvazia no envio.

export const COMPOSER_LIMITS = {
  /** Rascunhos de compositor guardados ao mesmo tempo (um por terminal). */
  drafts: 200,
  terminalIdChars: 200,
  /** Colagens (pílulas) por rascunho e o tamanho de cada uma. */
  pastes: 50,
  pasteChars: 20_000,
  /** O que vai ao terminal: o teto de texto do `POST /api/herdr/input` (herdr-page.ts MAX_TEXT, 20 000) menos a folga do
   * envelope de colagem que o compositor põe em volta do texto de várias linhas. */
  messageChars: 19_980,
  /** Texto depois do `@` que ainda conta como menção sendo digitada. */
  mentionQueryChars: 80,
  /** Opções no menu de menção. */
  mentionOptions: 20,
} as const;

/** Colagem que passa de 800 caracteres ou de 2 linhas vira pílula (reference/argos.md §Compositor). */
export const PASTE_PILL = { chars: 800, lines: 2 } as const;

/** Códigos estáveis do compositor (só ganham valores), ao lado dos `COMPOSE_ERRORS`. */
export const COMPOSER_ERRORS = {
  invalidTerminal: "composer_invalid_terminal",
  tooManyPastes: "composer_too_many_pastes",
  pasteTooLong: "composer_paste_too_long",
} as const;

export class ComposerError extends Error {
  readonly code: (typeof COMPOSER_ERRORS)[keyof typeof COMPOSER_ERRORS];
  constructor(code: (typeof COMPOSER_ERRORS)[keyof typeof COMPOSER_ERRORS], message: string) {
    super(message);
    this.name = "ComposerError";
    this.code = code;
  }
}

export interface ComposerDraft {
  text: string;
  /** Conteúdo de cada pílula pelo número (em texto, a chave do marcador). */
  pastes: Readonly<Record<string, string>>;
}

/** Rascunhos do compositor pelo id do nó do terminal. Nunca mudado no lugar. */
export type ComposerDrafts = Readonly<Record<string, ComposerDraft>>;

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = Object.freeze({ text: "", pastes: Object.freeze({}) });

const checkTerminal = (id: string): void => {
  if (typeof id !== "string" || id === "" || id.length > COMPOSER_LIMITS.terminalIdChars) {
    throw new ComposerError(COMPOSER_ERRORS.invalidTerminal, "terminal inválido");
  }
};

export const getComposerDraft = (drafts: ComposerDrafts, terminal: string): ComposerDraft =>
  (Object.hasOwn(drafts, terminal) ? drafts[terminal] : undefined) ?? EMPTY_COMPOSER_DRAFT;

/** Guarda o rascunho do terminal; texto vazio (só espaço inclusive) apaga, pílulas junto. */
export function setComposerDraft(drafts: ComposerDrafts, terminal: string, draft: ComposerDraft): ComposerDrafts {
  checkTerminal(terminal);
  const text = checkText(draft.text);
  const next: Record<string, ComposerDraft> = { ...drafts };
  if (text.trim() === "") {
    delete next[terminal];
    return next;
  }
  if (!Object.hasOwn(next, terminal) && Object.keys(next).length >= COMPOSER_LIMITS.drafts) {
    return fail(COMPOSE_ERRORS.tooManyDrafts, `no máximo ${COMPOSER_LIMITS.drafts} rascunhos guardados`);
  }
  next[terminal] = { text, pastes: draft.pastes };
  return next;
}

/** Só o envio limpa: o rascunho e as pílulas dele saem. */
export function clearComposerDraft(drafts: ComposerDrafts, terminal: string): ComposerDrafts {
  checkTerminal(terminal);
  const next: Record<string, ComposerDraft> = { ...drafts };
  delete next[terminal];
  return next;
}

const lineCount = (text: string): number => text.split("\n").length;

/** Colagem que vira pílula: mais de 800 caracteres ou mais de 2 linhas. */
export const isLargePaste = (text: string): boolean => text.length > PASTE_PILL.chars || lineCount(text) > PASTE_PILL.lines;

const PILL_OPEN = "⟦";
const PILL_CLOSE = "⟧";
const PILL_PATTERN = /⟦colagem (\d{1,4}) · (\d{1,7}) linhas?⟧/g;

/** Marcador da pílula `n` para a colagem `content`. */
export const pillToken = (n: number, content: string): string => {
  const lines = lineCount(content);
  return `${PILL_OPEN}colagem ${n} · ${lines} ${lines === 1 ? "linha" : "linhas"}${PILL_CLOSE}`;
};

export interface Pill {
  start: number;
  end: number;
  n: number;
  lines: number;
}

/** Pílulas do texto que têm conteúdo no rascunho, em ordem; marcador sem conteúdo é texto comum. */
export function findPills(draft: ComposerDraft): Pill[] {
  const found: Pill[] = [];
  for (const match of draft.text.matchAll(PILL_PATTERN)) {
    const key = match[1] ?? "";
    if (!Object.hasOwn(draft.pastes, key)) continue;
    found.push({ start: match.index, end: match.index + match[0].length, n: Number(key), lines: Number(match[2]) });
  }
  return found;
}

export interface Edit {
  draft: ComposerDraft;
  /** Onde o cursor fica depois da edição. */
  caret: number;
}

const splice = (text: string, start: number, end: number, insert: string): string => text.slice(0, start) + insert + text.slice(end);

/** Troca `[start, end)` por `insert` e devolve o cursor no fim do que entrou. */
export function replaceRange(draft: ComposerDraft, start: number, end: number, insert: string): Edit {
  const text = checkText(splice(draft.text, start, end, insert));
  return { draft: { text, pastes: draft.pastes }, caret: start + insert.length };
}

/** Colagem grande na seleção `[start, end)`: o conteúdo entra no mapa com o próximo número e o texto ganha o marcador. */
export function insertPaste(draft: ComposerDraft, start: number, end: number, content: string): Edit {
  if (content.length > COMPOSER_LIMITS.pasteChars) {
    throw new ComposerError(COMPOSER_ERRORS.pasteTooLong, `a colagem passa de ${COMPOSER_LIMITS.pasteChars} caracteres`);
  }
  const numbers = Object.keys(draft.pastes).map(Number);
  if (numbers.length >= COMPOSER_LIMITS.pastes) {
    throw new ComposerError(COMPOSER_ERRORS.tooManyPastes, `no máximo ${COMPOSER_LIMITS.pastes} colagens por rascunho`);
  }
  // o número nunca volta a ser usado no mesmo rascunho: um marcador recortado e colado de volta acha o seu conteúdo
  const n = numbers.reduce((max, value) => Math.max(max, value), 0) + 1;
  const edit = replaceRange(draft, start, end, pillToken(n, content));
  return { draft: { text: edit.draft.text, pastes: { ...draft.pastes, [String(n)]: content } }, caret: edit.caret };
}

/** Pílula sob o cursor (dentro dela) ou exatamente selecionada; `null` fora de pílula. */
export function pillAt(draft: ComposerDraft, selStart: number, selEnd: number = selStart): Pill | null {
  for (const pill of findPills(draft)) {
    if (selStart === pill.start && selEnd === pill.end) return pill;
    if (selStart === selEnd && selStart > pill.start && selStart < pill.end) return pill;
  }
  return null;
}

/** Abre a pílula para edição: o marcador vira o conteúdo, selecionado. */
export function expandPill(draft: ComposerDraft, pill: Pill): Edit & { selectFrom: number } {
  const content = draft.pastes[String(pill.n)] ?? "";
  const edit = replaceRange(draft, pill.start, pill.end, content);
  return { ...edit, selectFrom: pill.start };
}

/**
 * Backspace (`back`) ou Delete (`forward`) com o cursor encostado ou dentro de uma pílula apaga a pílula inteira: o
 * marcador pela metade iria ao terminal como texto. `null` quando a tecla não toca pílula (o campo faz o normal).
 */
export function deletePill(draft: ComposerDraft, caret: number, direction: "back" | "forward"): Edit | null {
  for (const pill of findPills(draft)) {
    const touches = direction === "back" ? caret > pill.start && caret <= pill.end : caret >= pill.start && caret < pill.end;
    if (touches) return replaceRange(draft, pill.start, pill.end, "");
  }
  return null;
}

/**
 * O texto que vai ao terminal: cada pílula volta ao conteúdo colado, sem alteração, na posição dela; no texto digitado,
 * `@<id>` de uma nota do documento vira o texto da nota (a regra do `composeMessage`) e `@@` vira `@`. Menção a terminal,
 * `@orquestrador` e `@Nova nota` seguem como texto para o agente.
 */
export function composerMessage(draft: ComposerDraft, doc: Pick<CanvasDoc, "nodes">): string {
  const source = checkText(draft.text);
  if (source.trim() === "") return fail(COMPOSE_ERRORS.emptyMessage, "a mensagem está vazia");
  const notes = new Map<string, CanvasNode>();
  for (const node of doc.nodes) if (node.type === NOTE_TYPE) notes.set(node.id, node);
  const typed = (segment: string): string => {
    const refs = findReferences(segment).filter((ref) => notes.has(ref.id));
    if (refs.length > COMPOSE_LIMITS.references) {
      return fail(COMPOSE_ERRORS.tooManyReferences, `no máximo ${COMPOSE_LIMITS.references} referências por mensagem`);
    }
    const parts: string[] = [];
    let cursor = 0;
    for (const ref of refs) {
      const node = notes.get(ref.id);
      if (!node) continue;
      parts.push(segment.slice(cursor, ref.start).replaceAll("@@", "@"), expand(node).text);
      cursor = ref.end;
    }
    parts.push(segment.slice(cursor).replaceAll("@@", "@"));
    return parts.join("");
  };
  const out: string[] = [];
  let cursor = 0;
  for (const pill of findPills(draft)) {
    out.push(typed(source.slice(cursor, pill.start)), draft.pastes[String(pill.n)] ?? "");
    cursor = pill.end;
  }
  out.push(typed(source.slice(cursor)));
  const message = out.join("");
  if (message.length > COMPOSER_LIMITS.messageChars) {
    return fail(COMPOSE_ERRORS.tooLong, `a mensagem passa de ${COMPOSER_LIMITS.messageChars} caracteres`);
  }
  return message;
}

export interface MentionQuery {
  /** Posição do `@`; a menção vai de `start` ao cursor. */
  start: number;
  /** O que foi digitado depois do `@` (sem o `#`, no modo arquivos). */
  query: string;
  /** `#` logo depois do `@`: seletor de arquivos do diretório do terminal. */
  files: boolean;
}

const MENTION_STOP = /\s/;

/** Menção sendo digitada no cursor: `@` no começo ou depois de espaço, sem espaço até o cursor. `null` fora de menção. */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  const floor = Math.max(0, caret - COMPOSER_LIMITS.mentionQueryChars - 1);
  for (let at = caret - 1; at >= floor; at -= 1) {
    const ch = text[at] ?? "";
    if (MENTION_STOP.test(ch)) return null;
    if (ch !== "@") continue;
    const before = at === 0 ? "" : (text[at - 1] ?? "");
    if (before !== "" && !MENTION_STOP.test(before)) return null;
    const typed = text.slice(at + 1, caret);
    if (typed.includes("@")) return null;
    const files = typed.startsWith("#");
    return { start: at, query: files ? typed.slice(1) : typed, files };
  }
  return null;
}

export const MENTION_KINDS = { terminal: "terminal", note: "note", file: "file", orchestrator: "orchestrator", newNote: "new-note" } as const;
export type MentionKind = (typeof MENTION_KINDS)[keyof typeof MENTION_KINDS];

export interface MentionOption {
  kind: MentionKind;
  label: string;
  /** Texto que entra no lugar da menção; `null` em "Arquivo…", que abre o seletor e insere o caminho escolhido. */
  insert: string | null;
}

export interface MentionSources {
  /** Terminais ligados por aresta ao terminal do compositor. */
  terminals: readonly { id: string; label: string }[];
  notes: readonly { id: string; title: string }[];
  /** O terminal do compositor tem o papel de orquestrador ligado. */
  orchestrator: boolean;
}

const fold = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Opções do menu de menção para o texto digitado depois do `@`, na ordem: terminais, notas, Arquivo…, orquestrador, Nova nota. */
export function mentionOptions(query: string, sources: MentionSources): MentionOption[] {
  const want = fold(query);
  const hit = (label: string): boolean => want === "" || fold(label).includes(want);
  const options: MentionOption[] = [];
  for (const t of sources.terminals) if (hit(t.label)) options.push({ kind: MENTION_KINDS.terminal, label: t.label, insert: `@${t.label} ` });
  for (const n of sources.notes) if (hit(n.title) || hit(n.id)) options.push({ kind: MENTION_KINDS.note, label: n.title, insert: `@${n.id} ` });
  if (hit("Arquivo")) options.push({ kind: MENTION_KINDS.file, label: "Arquivo…", insert: null });
  if (sources.orchestrator && hit("orquestrador")) options.push({ kind: MENTION_KINDS.orchestrator, label: "orquestrador", insert: "@orquestrador " });
  if (hit("Nova nota")) options.push({ kind: MENTION_KINDS.newNote, label: "Nova nota", insert: "@Nova nota " });
  return options.slice(0, COMPOSER_LIMITS.mentionOptions);
}

/** Ids ligados ao nó por qualquer aresta do documento, sem repetir, na ordem das arestas. */
export function connectedIds(doc: Pick<CanvasDoc, "edges">, id: string): string[] {
  const out = new Set<string>();
  for (const edge of doc.edges) {
    if (edge.from === id && edge.to !== id) out.add(edge.to);
    else if (edge.to === id && edge.from !== id) out.add(edge.from);
  }
  return [...out];
}

/** Título de uma nota para o menu: o `title`, senão a primeira linha do texto, senão o id. */
export function noteTitle(node: CanvasNode): string {
  const title = node.data.title;
  if (typeof title === "string" && title.trim() !== "") return title.trim();
  const body = node.data.text;
  const first = typeof body === "string" ? (body.split("\n").find((line) => line.trim() !== "") ?? "") : "";
  return first.trim().replace(/^#+\s*/, "").slice(0, 80) || node.id;
}
