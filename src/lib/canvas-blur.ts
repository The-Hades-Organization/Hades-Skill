// Desfocar nós do canvas (reference/argos.md §Organização avançada): esconde o conteúdo e mantém cabeçalho e nome. Funções
// puras sobre o documento; cada operação devolve uma `CanvasOp` da pilha de desfazer (`undefined` quando não há o que mudar).
// Sem Node e sem DOM.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasEdge, type CanvasNode } from "./canvas-doc.ts";
import { type AtomicOp, type CanvasOp, opBatch, opDelete, opPatch, type Placed } from "./canvas-history.ts";
import { ORG_ERRORS, orgFail, pickNodes } from "./canvas-groups.ts";

/** Teto antes de qualquer busca: uma lista maior que o documento admite é recusada sem varrê-lo. */
function pickWithinLimit(doc: CanvasDoc, ids: readonly string[]): CanvasNode[] {
  if (ids.length > CANVAS_LIMITS.nodes) return orgFail(ORG_ERRORS.limitExceeded, "nós demais em uma operação");
  return pickNodes(doc, ids);
}

/**
 * Troca nós por uma versão modificada em um passo só do desfazer. A pilha não tem operação de "alterar campo", então o passo
 * é `delete` + `create` dos mesmos nós, no mesmo índice, com as conexões e os grupos que eles tinham devolvidos. `keepEdge`
 * decide quais conexões que tocam esses nós sobrevivem (padrão: todas). `undefined` quando nada muda.
 * Erros: `org_unknown_node`, `org_limit_exceeded`.
 */
export interface ReplaceOptions {
  change?: (node: CanvasNode) => CanvasNode;
  /** Conexões que tocam os nós e sobrevivem (padrão: todas). */
  keepEdge?: (edge: CanvasEdge) => boolean;
  /** Conexões novas, no fim da lista; precisam tocar um dos nós. A pilha só desfaz conexão pela troca do nó, por isso entram aqui. */
  addEdges?: readonly CanvasEdge[];
}

export function replaceNodes(doc: CanvasDoc, ids: readonly string[], options: ReplaceOptions): CanvasOp | undefined {
  const { change = (node: CanvasNode) => node, keepEdge = () => true, addEdges = [] } = options;
  const picked = pickWithinLimit(doc, ids);
  if (picked.length === 0) return undefined;
  const touched = new Set(picked.map((node) => node.id));
  const next = new Map(picked.map((node) => [node.id, change(structuredClone(node))]));
  const touches = (edge: CanvasEdge): boolean => touched.has(edge.from) || touched.has(edge.to);
  const edges = [...doc.edges.filter((edge) => !touches(edge) || keepEdge(edge)), ...addEdges.map((edge) => ({ ...edge }))];
  const nodeChanged = picked.some((node) => JSON.stringify(node) !== JSON.stringify(next.get(node.id)));
  const edgesChanged = edges.length !== doc.edges.length || addEdges.length > 0;
  if (!nodeChanged && !edgesChanged) return undefined;

  const placed = <T>(items: readonly T[], hit: (item: T) => boolean): Placed<T>[] =>
    items.flatMap((item, at) => (hit(item) ? [{ at, item: structuredClone(item) }] : []));
  const remove = opDelete(doc, [...touched]);
  const restore: AtomicOp = {
    kind: "create",
    snapshot: {
      nodes: doc.nodes.flatMap((node, at) => (touched.has(node.id) ? [{ at, item: next.get(node.id) ?? node }] : [])),
      edges: placed(edges, touches),
      groups: placed(doc.groups, (group) => group.members.some((member) => touched.has(member))),
    },
  };
  return opBatch([remove, restore]);
}

/** O que o nó mostra desfocado: cabeçalho e nome ficam sempre; o corpo some. */
export interface BlurView {
  blurred: boolean;
  showHeader: true;
  showName: true;
  showBody: boolean;
  title: string;
}

const TITLE_KEYS = ["title", "name", "label"] as const;

/** Nome que o nó mostra: o primeiro texto não vazio de `data.title|name|label`, ou o id. */
export function nodeTitle(node: CanvasNode): string {
  for (const key of TITLE_KEYS) {
    const value = node.data[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, CANVAS_LIMITS.labelChars);
  }
  return node.id;
}

export function blurView(node: CanvasNode): BlurView {
  return { blurred: node.blurred, showHeader: true, showName: true, showBody: !node.blurred, title: nodeTitle(node) };
}

/**
 * Desfoca (ou, com `blurred: false`, revela) os nós de `ids`. Quem já está no estado pedido não entra no passo; se todos já
 * estão, `undefined`. Nó travado e nó vivo também desfocam: é só visual. Cada nó vira uma operação `patch` do campo `blurred`
 * (um nó: ela só; vários: um lote), então o desfazer troca só o campo e nada mais do documento.
 * Erros: `org_unknown_node`, `org_limit_exceeded`.
 */
export function blurNodes(doc: CanvasDoc, ids: readonly string[], blurred = true): CanvasOp | undefined {
  const ops = pickWithinLimit(doc, ids)
    .filter((node) => node.blurred !== blurred)
    .map((node) => opPatch(doc, node.id, { blurred }));
  if (ops.length === 0) return undefined;
  return ops.length === 1 ? (ops[0] as AtomicOp) : opBatch(ops);
}

/** Alterna a seleção: se todos já estão desfocados revela, senão desfoca todos (um atalho só). */
export function toggleBlur(doc: CanvasDoc, ids: readonly string[]): CanvasOp | undefined {
  const picked = pickWithinLimit(doc, ids);
  return blurNodes(doc, ids, !(picked.length > 0 && picked.every((node) => node.blurred)));
}

/** Ids dos nós cujo conteúdo continua visível (não desfocados), na ordem do documento; `ids` restringe o conjunto. */
export function visibleNodeIds(doc: CanvasDoc, ids?: readonly string[]): string[] {
  const only = ids ? new Set(ids) : undefined;
  return doc.nodes.filter((node) => !node.blurred && (!only || only.has(node.id))).map((node) => node.id);
}

/** Ids dos nós desfocados na ordem do documento. */
export const blurredNodeIds = (doc: CanvasDoc): string[] => doc.nodes.filter((node) => node.blurred).map((node) => node.id);
