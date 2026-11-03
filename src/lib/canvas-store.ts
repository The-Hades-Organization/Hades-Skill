// Estado do canvas da página `#/argos` (reference/argos.md §A página): documento + pilha de desfazer, a vista que o motor
// recebe (filtros e arestas do grafo), a sincronia com o grafo a cada atualização, a câmera de abertura e o gravador com
// espera (debounce) e revisão. Tudo puro ou com o efeito injetado (`put`, temporizador), então roda sem a página nem rede.
// Sem dependência de Node: roda no painel e no navegador.
import { openingCamera, OPENING_MIN_SCALE, type Camera, type Rect, type Viewport } from "./canvas-camera.ts";
import { type CanvasDoc, type CanvasEdge } from "./canvas-doc.ts";
import { createHistory, HistoryError, perform, redo, undo, type CanvasOp, type History } from "./canvas-history.ts";
import { syncWithGraph, type GraphSnapshot, type SyncOptions } from "./canvas-sync.ts";

export interface CanvasState {
  doc: CanvasDoc;
  history: History;
}

export const initialCanvasState = (doc: CanvasDoc): CanvasState => ({ doc, history: createHistory() });

/** Gesto terminado do motor: aplica ao documento inteiro (o motor só vê a parte visível) e registra o passo. Lança `HistoryError`. */
export function commitGesture(state: CanvasState, op: CanvasOp): CanvasState {
  const applied = perform(state.history, state.doc, op);
  return { doc: applied.doc, history: applied.history };
}

export type HistoryDirection = "undo" | "redo";

/**
 * Desfaz ou refaz um passo. Passo que aponta para nó que já saiu do grafo não se aplica mais (`HistoryError`): é descartado e o
 * próximo é tentado, então um nó que some nunca trava a pilha. `undefined` quando não sobrou passo aplicável.
 */
export function stepHistory(state: CanvasState, direction: HistoryDirection): CanvasState | undefined {
  let history = state.history;
  for (;;) {
    const stack = direction === "undo" ? history.past : history.future;
    if (stack.length === 0) return undefined;
    try {
      const applied = (direction === "undo" ? undo : redo)(history, state.doc);
      return applied ? { doc: applied.doc, history: applied.history } : undefined;
    } catch (error) {
      if (!(error instanceof HistoryError)) throw error;
      const dropped = stack.slice(0, -1);
      history = direction === "undo" ? { ...history, past: dropped } : { ...history, future: dropped };
    }
  }
}

export interface ReconcileResult {
  state: CanvasState;
  added: string[];
  removed: string[];
  skipped: string[];
  changed: boolean;
}

/** Sincroniza o documento com o grafo (nó novo perto dos vizinhos, nó sumido sai, posição do dono vence). A pilha não muda. */
export function reconcileGraph(state: CanvasState, graph: GraphSnapshot, options: SyncOptions): ReconcileResult {
  const result = syncWithGraph(state.doc, graph, options);
  if (!result.changed) return { state, added: [], removed: [], skipped: result.skipped, changed: false };
  return { state: { doc: result.doc, history: state.history }, added: result.added, removed: result.removed, skipped: result.skipped, changed: true };
}

export interface GraphEdgeRef {
  from: string;
  to: string;
  kind: string;
}

export const GRAPH_EDGE_PREFIX = "graph:";

/**
 * O documento que o motor desenha: só os nós visíveis (o filtro não apaga posição do documento), as arestas do usuário e as
 * do grafo (que nunca entram no documento salvo) cujas duas pontas estão visíveis.
 */
export function projectView(doc: CanvasDoc, visible: ReadonlySet<string>, graphEdges: readonly GraphEdgeRef[]): CanvasDoc {
  const nodes = doc.nodes.filter((node) => visible.has(node.id));
  const present = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const fromGraph: CanvasEdge[] = [];
  for (const edge of graphEdges) {
    if (!present.has(edge.from) || !present.has(edge.to)) continue;
    const id = `${GRAPH_EDGE_PREFIX}${edge.kind}:${edge.from}:${edge.to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    fromGraph.push({ id, from: edge.from, to: edge.to, kind: edge.kind });
  }
  const own = doc.edges.filter((edge) => present.has(edge.from) && present.has(edge.to));
  return { ...doc, nodes, edges: [...own, ...fromGraph] };
}

/** O nó em foco no painel lateral: só vale com exatamente um selecionado (ação sobre vários é ambígua). */
export const primarySelection = (selection: readonly string[]): string | null => (selection.length === 1 ? (selection[0] as string) : null);

/** Mantém só os ids que ainda estão visíveis, preservando a ordem; devolve o mesmo array se nada saiu. */
export function visibleSelection(selection: readonly string[], visible: ReadonlySet<string>): readonly string[] {
  return selection.every((id) => visible.has(id)) ? selection : selection.filter((id) => visible.has(id));
}

/** Escala mínima em que o nó aparece completo; abaixo dela o texto vira bloco e a abertura não se lê. */
export const READABLE_ZOOM = OPENING_MIN_SCALE;

/** Câmera de abertura (a regra mora em `openingCamera`, que o motor também usa no enquadramento inicial). */
export const firstCamera: (nodes: readonly Rect[], view: Viewport) => Camera | undefined = openingCamera;

// ---- gravador ----

/** Códigos estáveis do gravador: só ganham valores. */
export const SAVE_ERRORS = { unreachable: "canvas_save_unreachable", conflict: "canvas_save_conflict" } as const;

export type SaveReply =
  | { kind: "saved"; rev: number }
  /** O servidor está em outra revisão (outra aba gravou): `rev` é a dele. */
  | { kind: "stale"; rev: number }
  | { kind: "failed"; code: string };

export type SaveStatus = { kind: "idle" } | { kind: "saving" } | { kind: "error"; code: string };

export const SAVE_DELAY_MS = 600;
export const SAVE_RETRY_MS = 5000;

export interface SaverDeps {
  /** Envia o documento já com a revisão; `leaving`: a aba está saindo (o envio precisa sobreviver a ela). */
  put(doc: CanvasDoc, options: { leaving: boolean }): Promise<SaveReply>;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onStatus(status: SaveStatus): void;
  /**
   * Outra aba gravou antes e o gravador não sabe reconciliar (sem `fetchServer`): o chamador recarrega o documento do servidor e
   * o que estava na fila é descartado. `lost` é esse documento descartado, para o chamador avisar e oferecer recuperá-lo.
   */
  onStale(serverRev: number, lost: CanvasDoc): void;
  /**
   * Lê o documento atual do servidor. Com ele, o 409 não perde a edição: o gravador reaplica a edição da aba sobre o documento do
   * servidor (`rebaseDoc`) e envia de novo, até `MAX_REBASES` vezes.
   */
  fetchServer?(): Promise<CanvasDoc>;
  /** O documento reconciliado entrou na fila: o chamador mostra na tela o mesmo que vai ser gravado. */
  onRebased?(doc: CanvasDoc): void;
  delayMs?: number;
  retryMs?: number;
}

export interface DocSaver {
  /** Revisão lida do servidor (a que o próximo envio devolve); `doc` é o que foi lido, a base da reconciliação num 409. */
  setRev(rev: number, doc?: CanvasDoc): void;
  /** Agenda a gravação; vários agendamentos seguidos viram um envio só, com o último documento. */
  schedule(doc: CanvasDoc): void;
  /** Envia já o que estiver na fila (e espera o envio em andamento). Nunca rejeita: a falha vira estado e nova tentativa. */
  flush(options?: { leaving?: boolean }): Promise<void>;
  /** Cancela o temporizador; o que estava na fila não é enviado. */
  dispose(): void;
}

/** Quantas vezes seguidas o gravador reconcilia e reenvia antes de mostrar erro (outra aba gravando no mesmo instante). */
export const MAX_REBASES = 3;

type Keyed = { id: string };

/** Três vias por id: o que a aba mexeu (ou criou) vence; o que ela não tocou segue o servidor (inclusive criação e remoção). */
function mergeById<T extends Keyed>(base: readonly T[], mine: readonly T[], theirs: readonly T[]): T[] {
  const inBase = new Map(base.map((item) => [item.id, JSON.stringify(item)]));
  const inMine = new Map(mine.map((item) => [item.id, item]));
  const touched = (item: T): boolean => inBase.get(item.id) !== JSON.stringify(item);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const theirItem of theirs) {
    seen.add(theirItem.id);
    const mineItem = inMine.get(theirItem.id);
    if (mineItem === undefined) {
      // a aba não tem o item: apagou (se estava na base) ou nunca o viu (nasceu no servidor)
      if (!inBase.has(theirItem.id) || JSON.stringify(theirItem) !== inBase.get(theirItem.id)) out.push(theirItem);
      continue;
    }
    out.push(touched(mineItem) ? mineItem : theirItem);
  }
  for (const mineItem of mine) if (!seen.has(mineItem.id) && touched(mineItem)) out.push(mineItem);
  return out;
}

/**
 * Reaplica a edição da aba (`mine`, feita sobre `base`) no documento do servidor (`theirs`), que andou. Item (nó, aresta, grupo,
 * oculto) que só um lado mexeu fica como esse lado deixou; mexido pelos dois, vence a aba (o dono acabou de fazer). Remoção pela
 * aba só vale se o servidor não mexeu no item. Sem `base`, nada do servidor se apaga: a aba vence nos ids em comum.
 * A revisão e os campos do documento (`v`) são os do servidor.
 */
export function rebaseDoc(base: CanvasDoc | undefined, mine: CanvasDoc, theirs: CanvasDoc): CanvasDoc {
  const from = base ?? { ...theirs, nodes: [], edges: [], groups: [], hidden: undefined };
  const ids = (list: readonly string[] | undefined): { id: string }[] => (list ?? []).map((id) => ({ id }));
  const hidden = mergeById(ids(from.hidden), ids(mine.hidden), ids(theirs.hidden)).map((item) => item.id);
  const { hidden: _drop, ...rest } = theirs;
  const nodes = mergeById(from.nodes, mine.nodes, theirs.nodes);
  const present = new Set(nodes.map((item) => item.id));
  return {
    ...rest,
    nodes,
    // ponta que sumiu (o servidor apagou o nó): a aresta ou o membro cai, senão o documento inteiro seria recusado
    edges: mergeById(from.edges, mine.edges, theirs.edges).filter((edge) => present.has(edge.from) && present.has(edge.to)),
    groups: mergeById(from.groups, mine.groups, theirs.groups).map((group) => ({ ...group, members: group.members.filter((id) => present.has(id)) })),
    ...(hidden.length > 0 ? { hidden } : {}),
  };
}

export function createDocSaver(deps: SaverDeps): DocSaver {
  const delayMs = deps.delayMs ?? SAVE_DELAY_MS;
  const retryMs = deps.retryMs ?? SAVE_RETRY_MS;
  let rev = 0;
  /** O documento como o servidor o tem na revisão `rev`: a base da reconciliação. */
  let base: CanvasDoc | undefined;
  let rebases = 0;
  let pending: CanvasDoc | undefined;
  let timer: unknown;
  let running: Promise<void> | undefined;
  let disposed = false;

  const clear = (): void => {
    if (timer === undefined) return;
    deps.clearTimer(timer);
    timer = undefined;
  };
  const arm = (ms: number): void => {
    clear();
    // drain nunca rejeita (a falha vira estado e nova tentativa), então a promessa solta aqui não esconde erro
    timer = deps.setTimer(() => {
      timer = undefined;
      void drain(false);
    }, ms);
  };

  async function attempt(doc: CanvasDoc, leaving: boolean): Promise<SaveReply> {
    try {
      return await deps.put({ ...doc, rev }, { leaving });
    } catch {
      // `put` devolve a falha como resposta; uma exceção solta (rede) também vira o mesmo estado, com nova tentativa
      return { kind: "failed", code: SAVE_ERRORS.unreachable };
    }
  }

  function drain(leaving: boolean): Promise<void> {
    if (running) return running;
    running = (async () => {
      try {
        while (pending !== undefined && !disposed) {
          const doc = pending;
          pending = undefined;
          deps.onStatus({ kind: "saving" });
          const reply = await attempt(doc, leaving);
          if (reply.kind === "saved") {
            rev = reply.rev;
            base = { ...doc, rev };
            rebases = 0;
            deps.onStatus({ kind: "idle" });
          } else if (reply.kind === "stale" && deps.fetchServer && rebases < MAX_REBASES) {
            rebases += 1;
            try {
              const theirs = await deps.fetchServer();
              const merged = rebaseDoc(base, doc, theirs);
              // edição nova que chegou durante a conversa também é reconciliada (senão o próximo envio apagaria o que o servidor ganhou)
              pending = pending === undefined ? merged : rebaseDoc(base, pending, theirs);
              rev = theirs.rev;
              base = theirs;
              deps.onRebased?.(pending);
            } catch {
              pending ??= doc;
              deps.onStatus({ kind: "error", code: SAVE_ERRORS.conflict });
              if (!disposed) arm(retryMs);
              return;
            }
          } else if (reply.kind === "stale" && deps.fetchServer) {
            pending ??= doc;
            deps.onStatus({ kind: "error", code: SAVE_ERRORS.conflict });
            if (!disposed) arm(retryMs);
            rebases = 0;
            return;
          } else if (reply.kind === "stale") {
            rev = reply.rev;
            base = undefined;
            pending = undefined;
            deps.onStatus({ kind: "idle" });
            deps.onStale(reply.rev, doc);
          } else {
            pending ??= doc;
            deps.onStatus({ kind: "error", code: reply.code });
            if (!disposed) arm(retryMs);
            return;
          }
        }
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  return {
    setRev(next, doc) {
      rev = next;
      base = doc;
      rebases = 0;
    },
    schedule(doc) {
      if (disposed) return;
      pending = doc;
      arm(delayMs);
    },
    flush(options) {
      clear();
      return drain(options?.leaving === true);
    },
    dispose() {
      disposed = true;
      pending = undefined;
      clear();
    },
  };
}

// ---- vários canvases (reference/argos.md §Vários canvases e exportação) ----
// Só a parte pura (id, nome, códigos): o disco fica em src/panel/canvas.ts, porque este módulo também roda no navegador.

/** Id do canvas que vive em `$D/canvas.json` (o documento único de antes). Reservado: nunca se cria, apaga ou renomeia. */
export const DEFAULT_CANVAS_ID = "default";
export const DEFAULT_CANVAS_NAME = "Padrão";

export const CANVAS_STORE_LIMITS = { idChars: 64, nameChars: 200, canvases: 100, scopeKeyChars: 128 } as const;

/** Lista fechada: minúscula, dígito, `_` e `-`; sem ponto nem barra, então `..` e separadores nunca passam. */
const CANVAS_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Códigos estáveis de quem gerencia os canvases: só ganham valores. */
export const CANVAS_STORE_ERRORS = {
  invalidId: "canvas_invalid_id",
  invalidName: "canvas_invalid_name",
  notFound: "canvas_not_found",
  exists: "canvas_exists",
  defaultProtected: "canvas_default_protected",
  limitReached: "canvas_limit_reached",
  invalidScope: "canvas_invalid_scope",
} as const;
export type CanvasStoreErrorCode = (typeof CANVAS_STORE_ERRORS)[keyof typeof CANVAS_STORE_ERRORS];

export class CanvasStoreError extends Error {
  readonly code: CanvasStoreErrorCode;
  constructor(code: CanvasStoreErrorCode, message: string) {
    super(message);
    this.name = "CanvasStoreError";
    this.code = code;
  }
}

export const isValidCanvasId = (id: unknown): id is string =>
  typeof id === "string" && id.length >= 1 && id.length <= CANVAS_STORE_LIMITS.idChars && CANVAS_ID_PATTERN.test(id);

/** Id de entrada externa já conferido; lança `canvas_invalid_id`. */
export function requireCanvasId(id: unknown): string {
  if (!isValidCanvasId(id)) throw new CanvasStoreError(CANVAS_STORE_ERRORS.invalidId, "id de canvas inválido");
  return id;
}

/** Nome de exibição: texto de 1 a 200 caracteres, sem controle, aparado. Lança `canvas_invalid_name`. */
export function requireCanvasName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  // eslint-disable-next-line no-control-regex -- recusa caractere de controle em nome que vai para tela e arquivo
  if (trimmed.length === 0 || trimmed.length > CANVAS_STORE_LIMITS.nameChars || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new CanvasStoreError(CANVAS_STORE_ERRORS.invalidName, "nome de canvas inválido");
  }
  return trimmed;
}

/** Texto → `[a-z0-9-]` sem acento nem hífen nas pontas, cortado em `maxChars`; vazio se nada sobra. */
export function slugify(text: string, maxChars: number): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxChars).replace(/-+$/g, "");
}

/** Id livre derivado do nome (`Meu mapa` → `meu-mapa`, `meu-mapa-2`…); `default` e ids tomados contam como ocupados. */
export function freshCanvasId(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name, CANVAS_STORE_LIMITS.idChars - 5) || "canvas";
  const busy = (id: string): boolean => id === DEFAULT_CANVAS_ID || taken.has(id);
  if (!busy(base)) return base;
  for (let n = 2; ; n += 1) {
    const id = `${base}-${n}`;
    if (!busy(id)) return id;
  }
}

// ---- canvas por worktree ou rodada (reference/argos.md §Canvas por worktree ou rodada) ----
// Um canvas por "escopo": uma worktree que a Hades criou ou uma rodada de orquestração. O escopo é só uma chave opaca; o id do
// canvas sai dela de forma determinística, então a página acha o canvas sem consultar o servidor e o servidor não confia na
// chave para formar caminho (só o id derivado, que passa pela lista fechada de `isValidCanvasId`).

export const CANVAS_SCOPE_KINDS = ["worktree", "round"] as const;
export type CanvasScopeKind = (typeof CANVAS_SCOPE_KINDS)[number];

export interface CanvasScope {
  kind: CanvasScopeKind;
  /** Texto livre de 1 a 128 caracteres (nome da worktree, id da rodada), sem controle; guardado como veio, só aparado. */
  key: string;
}

const SCOPE_ID_PREFIX: Readonly<Record<CanvasScopeKind, string>> = { worktree: "wt", round: "rd" };
const SCOPE_NAME_PREFIX: Readonly<Record<CanvasScopeKind, string>> = { worktree: "Worktree", round: "Rodada" };
const SCOPE_SLUG_CHARS = 40;
/** 53 bits em hexadecimal cabem em 14 dígitos. */
const SCOPE_HASH_DIGITS = 14;

/** Hash de texto de 53 bits (cyrb53), puro e igual em qualquer motor: separa chaves cujo trecho legível do id é o mesmo. */
function hashText(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Escopo de entrada externa já conferido (`{kind, key}`); lança `canvas_invalid_scope`. */
export function requireCanvasScope(raw: unknown): CanvasScope {
  const invalid = (): CanvasStoreError => new CanvasStoreError(CANVAS_STORE_ERRORS.invalidScope, "escopo de canvas inválido");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid();
  const { kind, key } = raw as { kind?: unknown; key?: unknown };
  const knownKind = CANVAS_SCOPE_KINDS.find((candidate) => candidate === kind);
  const trimmed = typeof key === "string" ? key.trim() : "";
  // eslint-disable-next-line no-control-regex -- recusa caractere de controle em chave que vai para tela e log
  if (!knownKind || trimmed.length === 0 || trimmed.length > CANVAS_STORE_LIMITS.scopeKeyChars || /[\u0000-\u001f\u007f]/.test(trimmed)) throw invalid();
  return { kind: knownKind, key: trimmed };
}

/**
 * Id do canvas do escopo: `wt-<trecho legível>-<hash>` ou `rd-…`. Mesma chave, mesmo id; chaves diferentes dão ids diferentes
 * (o hash cobre a chave inteira, inclusive o que o trecho legível perde). Sempre passa por `isValidCanvasId`.
 */
export function scopedCanvasId(scope: CanvasScope): string {
  const { kind, key } = requireCanvasScope(scope);
  const readable = slugify(key, SCOPE_SLUG_CHARS) || "k";
  return `${SCOPE_ID_PREFIX[kind]}-${readable}-${hashText(`${kind}\u0000${key}`).toString(16).padStart(SCOPE_HASH_DIGITS, "0")}`;
}

/** Nome de exibição padrão do canvas do escopo (`Worktree: p-org`, `Rodada: p4`); sempre cabe no limite do nome. */
export const scopedCanvasName = (scope: CanvasScope): string => `${SCOPE_NAME_PREFIX[scope.kind]}: ${scope.key}`;

export const sameScope = (a: CanvasScope, b: CanvasScope): boolean => a.kind === b.kind && a.key === b.key;
