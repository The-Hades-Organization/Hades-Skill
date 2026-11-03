// Andar pelas conexões (reference/argos.md §Organização): uma ordem de passeio determinística sobre os nós, seguindo as
// ligações, e o passo para o próximo e o anterior. Puro, sem Node e sem DOM. O passeio é iterativo (sem recursão sobre o
// grafo) e custa O((N + E) log N).
import type { CanvasDoc } from "./canvas-doc.ts";

export type WalkDirection = "next" | "previous";

interface Placed {
  id: string;
  x: number;
  y: number;
}

/** Desempate estável: de cima para baixo, da esquerda para a direita, depois pelo id (comparação de código, não de idioma). */
const byPlace = (a: Placed, b: Placed): number => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Ordem de passeio dos nós: cada componente é percorrido em profundidade, descendo pelas ligações no sentido `from → to`,
 * então o próximo de um nó é, sempre que existe, um nó ligado a ele. Começam por nós sem ligação de entrada; o que sobra
 * (ciclos) começa pelo primeiro na ordem de posição. Os filhos e os inícios são ordenados por posição (`y`, `x`, `id`).
 * Ligação para nó que não existe, laço e ligação repetida não mudam o resultado. Todo nó aparece uma vez.
 */
export function walkOrder(doc: Pick<CanvasDoc, "nodes" | "edges">): string[] {
  const placed = new Map<string, Placed>();
  for (const node of doc.nodes) placed.set(node.id, node);
  const successors = new Map<string, Set<string>>();
  const hasIncoming = new Set<string>();
  for (const { from, to } of doc.edges) {
    if (from === to || !placed.has(from) || !placed.has(to)) continue;
    let targets = successors.get(from);
    if (!targets) successors.set(from, (targets = new Set()));
    targets.add(to);
    hasIncoming.add(to);
  }
  const sorted = [...placed.values()].sort(byPlace);
  const childrenOf = (id: string): Placed[] =>
    [...(successors.get(id) ?? [])].map((child) => placed.get(child) as Placed).sort(byPlace);

  const order: string[] = [];
  const seen = new Set<string>();
  const walkFrom = (start: Placed): void => {
    const stack: Placed[] = [start];
    for (let top = stack.pop(); top; top = stack.pop()) {
      if (seen.has(top.id)) continue;
      seen.add(top.id);
      order.push(top.id);
      // empilha ao contrário para sair o primeiro filho primeiro
      const children = childrenOf(top.id);
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i] as Placed);
    }
  };
  for (const root of sorted) if (!hasIncoming.has(root.id)) walkFrom(root);
  for (const rest of sorted) if (!seen.has(rest.id)) walkFrom(rest);
  return order;
}

/**
 * O nó seguinte (ou anterior) a `current` na ordem, dando a volta nas pontas. `undefined` se `current` não está na ordem
 * ou se não há outro nó para onde ir.
 */
export function walkStep(order: readonly string[], current: string, direction: WalkDirection): string | undefined {
  const at = order.indexOf(current);
  if (at === -1 || order.length < 2) return undefined;
  return order[(at + (direction === "next" ? 1 : order.length - 1)) % order.length];
}
