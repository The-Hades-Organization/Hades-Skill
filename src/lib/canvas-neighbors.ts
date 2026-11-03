// Vizinhança de um nó (ou seleção) no canvas do Argos (reference/argos.md §Vizinhança): quem está a 0, 1 e 2 saltos, com
// a aresta valendo nos dois sentidos, e o resto esmaecido. Lógica pura e sem Node; custo linear em nós + arestas.

/** Saltos além da seleção que a leitura mostra: 0 = o nó, 1 = vizinhos diretos, 2 = segundo salto. */
export const NEIGHBOR_DEPTH = 2;

export interface NeighborEdge {
  from: string;
  to: string;
}

export interface Neighborhood {
  /** Há foco: a seleção tinha ao menos um nó que existe. Sem foco nada é esmaecido (não há o que destacar). */
  active: boolean;
  /** `levels[n]` = ids a exatamente `n` saltos do foco, na ordem de `nodeIds`; nunca repete um id de nível menor. */
  levels: readonly [string[], string[], string[]];
  /** O resto: nós que existem e ficaram fora dos três níveis (vazio sem foco). */
  dimmed: string[];
  /** Ids da seleção que não existem em `nodeIds` (ignorados). */
  unknown: string[];
}

const EMPTY_LEVELS = (): [string[], string[], string[]] => [[], [], []];

/**
 * Níveis de vizinhança de `selection` sobre as arestas. Aresta que aponta para id fora de `nodeIds`, laço (`a`→`a`) e
 * aresta repetida não mudam o resultado; id repetido em `nodeIds` ou em `selection` conta uma vez.
 */
export function neighborhood(selection: readonly string[], edges: readonly NeighborEdge[], nodeIds: readonly string[]): Neighborhood {
  const known = new Set(nodeIds);
  const seeds = new Set<string>();
  const unknownSet = new Set<string>();
  for (const id of selection) {
    if (known.has(id)) seeds.add(id);
    else unknownSet.add(id);
  }
  const unknown = [...unknownSet];
  if (seeds.size === 0) return { active: false, levels: EMPTY_LEVELS(), dimmed: [], unknown };

  const adjacent = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const list = adjacent.get(a);
    if (list) list.push(b);
    else adjacent.set(a, [b]);
  };
  for (const { from, to } of edges) {
    if (from === to || !known.has(from) || !known.has(to)) continue;
    link(from, to);
    link(to, from);
  }

  const level = new Map<string, number>();
  for (const id of seeds) level.set(id, 0);
  let frontier: string[] = [...seeds];
  for (let depth = 1; depth <= NEIGHBOR_DEPTH; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of adjacent.get(id) ?? []) {
        if (level.has(other)) continue;
        level.set(other, depth);
        next.push(other);
      }
    }
    frontier = next;
  }

  const levels = EMPTY_LEVELS();
  const dimmed: string[] = [];
  const emitted = new Set<string>();
  for (const id of nodeIds) {
    if (emitted.has(id)) continue;
    emitted.add(id);
    const depth = level.get(id);
    if (depth === undefined) dimmed.push(id);
    else levels[depth]?.push(id);
  }
  return { active: true, levels, dimmed, unknown };
}
