// Área que cresce para caber o que nasce nela (reference/argos.md §Áreas que crescem). Quem cria nó por conta de um
// terminal que mora numa área (recrutar, nota nova, desenho novo, trazer terminal para um orquestrador) põe o nó dentro da
// área; se ela está cheia, a vaga sai abaixo do que ela tem (`findFreeBox` com `grow`) e aqui a área estica até cobri-lo.
// O que estiver no caminho (outra área com os membros dela, ou nó solto) desce ou vai para a direita na mesma medida, em
// cascata, sem sobrepor. Lógica pura e determinística, sem Node: tudo sai como `AtomicOp` do desfazer.
import { AREA_HEADER, AREA_LIMITS, areaIndex, areaNodes, isAreaNode } from "./canvas-areas.ts";
import { type CanvasDoc, type CanvasNode, isLiveNodeType } from "./canvas-doc.ts";
import { type AtomicOp, opMove, opResize } from "./canvas-history.ts";
import { LAYOUT_GAP } from "./canvas-layout.ts";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** O que anda junto ao abrir espaço: uma área com os membros dela, ou um nó solto. */
interface Unit {
  ids: string[];
  box: Box;
  /** Nó travado, vivo (o layout do grafo cuida dele) ou área com um membro assim não anda: vira obstáculo. */
  fixed: boolean;
}

const union = (boxes: readonly Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
};

const touches = (a: Box, b: Box, gap: number): boolean =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

const shifted = (box: Box, dx: number, dy: number): Box => ({ ...box, x: box.x + dx, y: box.y + dy });

const immovable = (node: CanvasNode): boolean => node.locked || isLiveNodeType(node.type);

/** As unidades do documento fora da área que cresce: as outras áreas (com os membros) e os nós soltos, menos `skip`. */
function unitsOf(doc: CanvasDoc, areaId: string, skip: ReadonlySet<string>): Unit[] {
  const index = areaIndex(doc);
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const units: Unit[] = [];
  for (const { node, data } of areaNodes(doc)) {
    if (node.id === areaId) continue;
    const members = data.members.flatMap((id) => {
      const member = byId.get(id);
      return member && !isAreaNode(member) && index.get(id) === node.id ? [member] : [];
    });
    units.push({ ids: [node.id, ...members.map((m) => m.id)], box: union([node, ...members]), fixed: immovable(node) || members.some(immovable) });
  }
  for (const node of doc.nodes) {
    if (isAreaNode(node) || index.has(node.id) || skip.has(node.id)) continue;
    units.push({ ids: [node.id], box: node, fixed: immovable(node) });
  }
  return units;
}

/**
 * Empurra para fora de `grown` quem a área nova tocaria. Quem está abaixo da área de antes desce; quem está à direita vai
 * para a direita. Varredura na ordem da distância: cada unidade só se afasta das que já foram postas (e de `grown`), então
 * o empurrão em cascata não volta a encostar em ninguém. Unidade fixa não anda (e segura as de trás).
 */
function makeRoom(units: readonly Unit[], before: Box, grown: Box): Map<Unit, { dx: number; dy: number }> {
  const moves = new Map<Unit, { dx: number; dy: number }>();
  const bottom = before.y + before.h;
  const right = before.x + before.w;
  const below = units.filter((u) => u.box.y + u.box.h / 2 >= bottom).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const beside = units.filter((u) => !below.includes(u) && u.box.x + u.box.w / 2 >= right).sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y);
  const placed: Box[] = [grown, ...units.filter((u) => u.fixed).map((u) => u.box)];
  const sweep = (group: readonly Unit[], axis: "y" | "x"): void => {
    for (const unit of group) {
      if (unit.fixed) continue;
      let d = 0;
      for (let hit = placed.find((b) => touches(shifted(unit.box, axis === "x" ? d : 0, axis === "y" ? d : 0), b, LAYOUT_GAP)); hit;
        hit = placed.find((b) => touches(shifted(unit.box, axis === "x" ? d : 0, axis === "y" ? d : 0), b, LAYOUT_GAP))) {
        d = axis === "y" ? hit.y + hit.h + LAYOUT_GAP - unit.box.y : hit.x + hit.w + LAYOUT_GAP - unit.box.x;
      }
      const move = axis === "y" ? { dx: 0, dy: d } : { dx: d, dy: 0 };
      if (d !== 0) moves.set(unit, move);
      placed.push(shifted(unit.box, move.dx, move.dy));
    }
  };
  sweep(below, "y");
  sweep(beside, "x");
  return moves;
}

/**
 * Faz a área `areaId` cobrir os nós `ids` (com a folga das bordas e a faixa do título) e abre espaço em volta. Nada muda se
 * eles já cabem. A pertença não é tratada aqui: depois disto o centro deles cai na área e o encaixe (`dropOps`) os põe na
 * lista. As operações seguem `doc` (o documento já com os nós novos).
 */
export function growAreaOps(doc: CanvasDoc, areaId: string, ids: readonly string[]): AtomicOp[] {
  const area = doc.nodes.find((node) => node.id === areaId && isAreaNode(node));
  const nodes = ids.flatMap((id) => doc.nodes.filter((node) => node.id === id && !isAreaNode(node)));
  if (area === undefined || nodes.length === 0) return [];
  const pad = AREA_LIMITS.padding;
  const need = union([area, ...nodes.map((n) => ({ x: n.x - pad, y: n.y - AREA_HEADER - pad, w: n.w + 2 * pad, h: n.h + AREA_HEADER + 2 * pad }))]);
  if (need.x === area.x && need.y === area.y && need.w === area.w && need.h === area.h) return [];
  const grown = { x: Math.round(need.x), y: Math.round(need.y), w: Math.round(need.w), h: Math.round(need.h) };
  const ops: AtomicOp[] = [opResize(doc, area.id, grown)];
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  for (const [unit, { dx, dy }] of makeRoom(unitsOf(doc, area.id, new Set(ids)), area, grown)) {
    for (const id of unit.ids) {
      const node = byId.get(id) as CanvasNode;
      ops.push(opMove(doc, id, { x: node.x + dx, y: node.y + dy }));
    }
  }
  return ops;
}
