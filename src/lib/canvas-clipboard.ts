// Duplicar, copiar, colar e excluir (reference/argos.md §Organização). Funções puras sobre o documento que devolvem uma
// `CanvasOp` da pilha de desfazer. Só nó do usuário entra na cópia e sai do documento: nó vivo (agent, unit, pr, gate) vem
// do grafo do Argos, então é pulado e listado em `skipped`. Na cópia ficam as conexões entre os nós copiados e os grupos
// inteiramente copiados; conexão para fora da seleção não vai. Sem Node e sem DOM.
import {
  CANVAS_LIMITS,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasGroup,
  type CanvasNode,
  CANVAS_VERSION,
  isLiveNodeType,
  validateCanvasDoc,
} from "./canvas-doc.ts";
import { type AtomicOp, applyOp, type CanvasOp, opBatch, opCreate, opDelete } from "./canvas-history.ts";
import { GRID_SIZE } from "./canvas-align.ts";
import { dissolveSmallGroups, GROUP_MIN_MEMBERS, ID_PATTERN, orgFail, ORG_ERRORS, OrgError, pickNodes } from "./canvas-groups.ts";

/** O que a cópia guarda: cópias profundas, no formato do documento, e só com referências internas. */
export interface Clip {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  groups: CanvasGroup[];
}

export type IdKind = "node" | "edge" | "group";
/** Quem cola escolhe os ids novos (como nos demais construtores de operação); o retorno não pode existir no documento. */
export type IdSource = (kind: IdKind) => string;

export interface PasteOffset {
  dx: number;
  dy: number;
}

/** A colagem vem deslocada para não cair em cima do original. */
export const PASTE_OFFSET: Readonly<PasteOffset> = { dx: GRID_SIZE, dy: GRID_SIZE };

/** Gerador determinístico: `<prefixo>-node-1`, `-edge-1`, `-group-1`..., pulando o que o documento já usa. */
export function sequentialIds(doc: CanvasDoc, prefix = "c"): IdSource {
  const taken: Record<IdKind, Set<string>> = {
    node: new Set(doc.nodes.map((node) => node.id)),
    edge: new Set(doc.edges.map((edge) => edge.id)),
    group: new Set(doc.groups.map((group) => group.id)),
  };
  const counters: Record<IdKind, number> = { node: 0, edge: 0, group: 0 };
  return (kind) => {
    let id: string;
    do {
      counters[kind] += 1;
      id = `${prefix}-${kind}-${counters[kind]}`;
    } while (taken[kind].has(id));
    taken[kind].add(id);
    return id;
  };
}

export interface CopyResult {
  clip: Clip;
  /** Ids pedidos que são nós vivos e por isso ficaram fora. */
  skipped: string[];
}

/** Copia os nós do usuário de `ids`, na ordem do documento. Seleção vazia (ou só de nós vivos): clipe vazio. */
export function copyNodes(doc: CanvasDoc, ids: readonly string[]): CopyResult {
  const picked = pickNodes(doc, ids);
  const skipped = picked.filter((node) => isLiveNodeType(node.type)).map((node) => node.id);
  const copied = new Set(picked.filter((node) => !isLiveNodeType(node.type)).map((node) => node.id));
  return {
    clip: {
      nodes: doc.nodes.filter((node) => copied.has(node.id)).map((node) => structuredClone(node)),
      edges: doc.edges.filter((edge) => copied.has(edge.from) && copied.has(edge.to)).map((edge) => ({ ...edge })),
      groups: doc.groups.filter((group) => group.members.length >= GROUP_MIN_MEMBERS && group.members.every((member) => copied.has(member))).map((group) => structuredClone(group)),
    },
    skipped,
  };
}

/**
 * Valida um clipe que veio de fora (texto colado, armazenamento): o mesmo rigor do documento, sem referência solta e sem
 * nó vivo. Lança `OrgError` com `org_invalid_clip`.
 */
export function readClip(raw: unknown): Clip {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return orgFail(ORG_ERRORS.invalidClip, "o clipe precisa ser um objeto");
  const { nodes, edges, groups } = raw as Record<string, unknown>;
  let doc: CanvasDoc;
  try {
    doc = validateCanvasDoc({ v: CANVAS_VERSION, rev: 0, nodes, edges, groups });
  } catch (error) {
    throw new OrgError(ORG_ERRORS.invalidClip, `clipe inválido: ${error instanceof Error ? error.message : "formato desconhecido"}`);
  }
  if (doc.nodes.some((node) => isLiveNodeType(node.type))) return orgFail(ORG_ERRORS.invalidClip, "o clipe não pode levar nó vivo");
  return { nodes: doc.nodes, edges: doc.edges, groups: doc.groups };
}

export interface PasteResult {
  /** `undefined` com clipe vazio. */
  op: CanvasOp | undefined;
  /** Ids dos nós criados, na ordem do clipe (a seleção depois de colar). */
  nodeIds: string[];
}

function freshId(newId: IdSource, kind: IdKind, used: Set<string>): string {
  const id = newId(kind);
  if (typeof id !== "string" || id.length === 0 || id.length > CANVAS_LIMITS.idChars || !ID_PATTERN.test(id)) return orgFail(ORG_ERRORS.invalidId, "id novo inválido");
  const scoped = `${kind}:${id}`;
  if (used.has(scoped)) return orgFail(ORG_ERRORS.duplicateId, "id novo já existe no documento");
  used.add(scoped);
  return id;
}

/**
 * Cola o clipe com ids novos e deslocado em `offset` (padrão `PASTE_OFFSET`); os nós novos ficam na mesma camada `z` dos
 * originais. Conexões e grupos do clipe são refeitos entre os nós novos. Um passo só no desfazer.
 * Erros: `org_invalid_clip` (nó vivo, referência solta), `org_invalid_id`, `org_duplicate_id`, `org_invalid_number`
 * (coordenada fora do documento) e `org_limit_exceeded`.
 */
export function pasteClip(doc: CanvasDoc, clip: Clip, newId: IdSource, offset: PasteOffset = PASTE_OFFSET): PasteResult {
  if (clip.nodes.length === 0) return { op: undefined, nodeIds: [] };
  if (clip.nodes.some((node) => isLiveNodeType(node.type))) return orgFail(ORG_ERRORS.invalidClip, "o clipe não pode levar nó vivo");
  if (doc.nodes.length + clip.nodes.length > CANVAS_LIMITS.nodes || doc.edges.length + clip.edges.length > CANVAS_LIMITS.edges) {
    return orgFail(ORG_ERRORS.limitExceeded, "documento passaria do limite");
  }
  const used = new Set<string>([...doc.nodes.map((node) => `node:${node.id}`), ...doc.edges.map((edge) => `edge:${edge.id}`), ...doc.groups.map((group) => `group:${group.id}`)]);
  const renamed = new Map<string, string>();
  const nodes = clip.nodes.map((node) => {
    const copy = structuredClone(node);
    copy.id = freshId(newId, "node", used);
    copy.x = node.x + offset.dx;
    copy.y = node.y + offset.dy;
    if (!Number.isFinite(copy.x) || !Number.isFinite(copy.y) || Math.abs(copy.x) > CANVAS_LIMITS.coordinate || Math.abs(copy.y) > CANVAS_LIMITS.coordinate) {
      return orgFail(ORG_ERRORS.invalidNumber, "a colagem sairia do limite de coordenadas");
    }
    renamed.set(node.id, copy.id);
    return copy;
  });
  const edges = clip.edges.map((edge) => {
    const from = renamed.get(edge.from);
    const to = renamed.get(edge.to);
    if (from === undefined || to === undefined) return orgFail(ORG_ERRORS.invalidClip, "conexão do clipe aponta para nó fora dele");
    return { id: freshId(newId, "edge", used), from, to, kind: edge.kind };
  });
  const groups = clip.groups.map((group) => {
    const members = group.members.map((member) => renamed.get(member));
    if (members.some((member) => member === undefined)) return orgFail(ORG_ERRORS.invalidClip, "grupo do clipe aponta para nó fora dele");
    return { id: freshId(newId, "group", used), label: group.label, members: members as string[] };
  });
  if (doc.groups.length + groups.length > CANVAS_LIMITS.groups) return orgFail(ORG_ERRORS.limitExceeded, "documento passaria do limite de grupos");

  const steps: AtomicOp[] = [opCreate(doc, nodes, edges)];
  groups.forEach((item, i) => steps.push({ kind: "group", group: { at: doc.groups.length + i, item } }));
  return { op: steps.length === 1 ? steps[0] : opBatch(steps), nodeIds: nodes.map((node) => node.id) };
}

export interface DuplicateResult extends PasteResult {
  skipped: string[];
}

/** Copiar e colar de uma vez (Alt+arrastar, "duplicar"); sem passar pela área de transferência. */
export function duplicateNodes(doc: CanvasDoc, ids: readonly string[], newId: IdSource, offset: PasteOffset = PASTE_OFFSET): DuplicateResult {
  const { clip, skipped } = copyNodes(doc, ids);
  return { ...pasteClip(doc, clip, newId, offset), skipped };
}

export interface DeleteResult {
  /** `undefined` quando não há nó do usuário na seleção. */
  op: CanvasOp | undefined;
  /** Nós vivos pedidos que ficaram: eles somem do documento só quando saem do grafo. */
  skipped: string[];
}

/**
 * Exclui os nós do usuário de `ids`, com as conexões que os tocavam. O grupo que fica com menos de dois membros se desfaz
 * no mesmo passo. Nó travado pode ser excluído (travar impede mover, não apagar).
 */
export function deleteNodes(doc: CanvasDoc, ids: readonly string[]): DeleteResult {
  const picked = pickNodes(doc, ids);
  const skipped = picked.filter((node) => isLiveNodeType(node.type)).map((node) => node.id);
  const doomed = picked.filter((node) => !isLiveNodeType(node.type)).map((node) => node.id);
  if (doomed.length === 0) return { op: undefined, skipped };
  const removal = opDelete(doc, doomed);
  const gone = new Set(doomed);
  const touched = new Set(doc.groups.filter((group) => group.members.some((member) => gone.has(member))).map((group) => group.id));
  const dissolved = dissolveSmallGroups(applyOp(doc, removal), touched);
  return { op: dissolved.length === 0 ? removal : opBatch([removal, ...dissolved]), skipped };
}
