// Organizar o canvas em áreas por orquestrador (reference/argos.md §Organizar em áreas). Modelo puro: recebe o documento e as
// regras opcionais de sub-área e devolve as áreas (membros por id e caixa), as posições novas e o que ficou de fora. Trabalha
// por id (o nome é só rótulo, duplicata não confunde) e é determinístico: a ordem vem da posição do documento, nunca do nome,
// então reorganizar sem mudança no grafo não move nada e uma equipe nova entra no fim, sem mexer nas que já existem.
// Nada é apagado: só move nós e cria ou atualiza nós `area`. Sem Node e sem DOM.
import { AREA_COLORS, AREA_HEADER, AREA_LIMITS, AREA_TYPE, AREA_Z, areaDataOf, areaNodes, isAreaNode } from "./canvas-areas.ts";
import { type CanvasDoc, type CanvasNode, isLiveNodeType, LINK_EDGE_KIND } from "./canvas-doc.ts";
import { type AtomicOp, type CanvasOp, opBatch, opCreate, opUpdate } from "./canvas-history.ts";
import type { Placement } from "./canvas-layout.ts";
import { isOrchestrator, nodeName, RECRUIT_EDGE_KIND, recruiterOf, TERMINAL_NODE_TYPE } from "./canvas-recruit.ts";
import { NOTE_TYPE } from "./canvas-note.ts";
import { type TidyFrame, tidyOp } from "./canvas-tidy.ts";

/** Medidas do arranjo: o espaço que cada nó ocupa (nunca menos que o próprio tamanho) e as folgas. */
export const ORGANIZE_LAYOUT = {
  terminalW: 1340,
  terminalH: 800,
  noteW: 280,
  noteH: 200,
  /** Folga entre a borda da área e o conteúdo. */
  padding: 48,
  /** Espaço entre nós vizinhos dentro de uma área. */
  gap: 48,
  /** Espaço entre áreas empilhadas e entre colunas de equipes. */
  areaGap: 96,
  /** Recrutas lado a lado em cada fileira da grade. */
  recruitColumns: 2,
  /** Notas por fileira no cabeçalho e nas sub-áreas. */
  noteColumns: 4,
  /** Nós por fileira no bloco dos que ficaram de fora. */
  foraColumns: 6,
} as const;

/** Prefixo dos ids das áreas que este modelo cria e mantém; áreas do dono com outro id nunca são redimensionadas. */
export const ORGANIZE_AREA_PREFIX = "org:";

export const RULES_LIMITS = { rules: 100, textChars: 100, fileBytes: 64 * 1024 } as const;

/** Códigos estáveis: só ganham valores. */
export const ORGANIZE_ERRORS = { invalidRules: "organize_invalid_rules" } as const;

export class OrganizeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OrganizeError";
    this.code = code;
  }
}

/** Regra de sub-área: nó cujo nome começa com `prefix` ou casa com `pattern` (`*` e `?`) vai para a sub-área `title`. */
export interface AreaRule {
  title: string;
  prefix?: string;
  pattern?: string;
  /** Só vale para este orquestrador (nome ou id); ausente vale para todos. */
  orchestrator?: string;
}
export interface OrganizeRules { areas: AreaRule[] }

export type OrganizedKind = "team" | "sub";

export interface OrganizedArea {
  id: string;
  title: string;
  kind: OrganizedKind;
  /** Id do terminal dono da equipe. */
  owner: string;
  /** Ids dos nós da área, na ordem do arranjo. */
  members: string[];
  box: { x: number; y: number; w: number; h: number };
}

export interface OrganizeResult {
  areas: OrganizedArea[];
  /** Posição de cada nó que o arranjo move (inclui os que já estão no lugar). */
  placements: Placement[];
  /** Ids sem equipe: vão para o bloco no fim e não entram em nenhuma área. */
  fora: string[];
  /** Ids que não se movem (travados ou fixados). */
  fixed: string[];
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (message: string): never => {
  throw new OrganizeError(ORGANIZE_ERRORS.invalidRules, message);
};

/** Valida o `canvas-areas.json` (`{ "areas": [{ "title", "prefix"?, "pattern"?, "orchestrator"? }] }`). Lança `organize_invalid_rules`. */
export function parseAreaRules(text: string): OrganizeRules {
  if (text.length > RULES_LIMITS.fileBytes) return invalid("canvas-areas.json passa do tamanho aceito");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return invalid("canvas-areas.json não é JSON válido");
  }
  if (!isDict(raw) || !Array.isArray(raw.areas)) return invalid('canvas-areas.json deve ser { "areas": [...] }');
  if (raw.areas.length > RULES_LIMITS.rules) return invalid(`no máximo ${RULES_LIMITS.rules} regras`);
  const slugs = new Set<string>();
  const areas = raw.areas.map((entry, index): AreaRule => {
    const where = `regra ${index + 1}`;
    if (!isDict(entry)) return invalid(`${where}: deve ser um objeto`);
    for (const key of Object.keys(entry)) if (!["title", "prefix", "pattern", "orchestrator"].includes(key)) invalid(`${where}: campo desconhecido "${key.slice(0, 40)}"`);
    const text = (key: string, required: boolean): string | undefined => {
      const value = entry[key];
      if (value === undefined && !required) return undefined;
      if (typeof value !== "string" || value.trim() === "" || value.length > RULES_LIMITS.textChars) return invalid(`${where}: "${key}" deve ser um texto de até ${RULES_LIMITS.textChars} caracteres`);
      return value;
    };
    const title = text("title", true) as string;
    const prefix = text("prefix", false);
    const pattern = text("pattern", false);
    if (prefix === undefined && pattern === undefined) return invalid(`${where}: informe "prefix" ou "pattern"`);
    const orchestrator = text("orchestrator", false);
    const slug = slugOf(title);
    if (slugs.has(slug)) return invalid(`${where}: título repetido`);
    slugs.add(slug);
    return { title, ...(prefix !== undefined && { prefix }), ...(pattern !== undefined && { pattern }), ...(orchestrator !== undefined && { orchestrator }) };
  });
  return { areas };
}

const slugOf = (title: string): string => `s-${title.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\w.-]+/g, "-")}`;

/** `*` e `?` viram `.*` e `.`; o resto é escapado, então o padrão do arquivo nunca vira expressão regular livre. */
function globMatches(pattern: string, value: string): boolean {
  const source = [...pattern].map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${source}$`, "s").test(value);
}

/** O rótulo que as regras leem: o nome do terminal, o nome da nota, ou o id. */
function labelOf(node: CanvasNode): string {
  if (node.type === TERMINAL_NODE_TYPE) return nodeName(node);
  const note = node.data.note;
  return typeof note === "string" && note ? note : node.id;
}

// ---- geometria ----

interface Slot { id: string; w: number; h: number }
/** Um bloco arrumado: itens em coordenadas relativas ao canto superior esquerdo. */
interface Laid { w: number; h: number; items: Placement[] }

const L = ORGANIZE_LAYOUT;
const slotOf = (node: CanvasNode): Slot =>
  node.type === TERMINAL_NODE_TYPE
    ? { id: node.id, w: Math.max(L.terminalW, node.w), h: Math.max(L.terminalH, node.h) }
    : { id: node.id, w: Math.max(L.noteW, node.w), h: Math.max(L.noteH, node.h) };

const single = (slot: Slot): Laid => ({ w: slot.w, h: slot.h, items: [{ id: slot.id, x: 0, y: 0 }] });

/** O terminal com as notas ao lado, em colunas que descem até a altura do terminal. */
function cell(lead: Slot, notes: readonly Slot[]): Laid {
  const items: Placement[] = [{ id: lead.id, x: 0, y: 0 }];
  let x = lead.w + L.gap;
  let y = 0;
  let colW = 0;
  let height = lead.h;
  let used = 0;
  for (const slot of notes) {
    if (y > 0 && y + slot.h > lead.h) {
      x += colW + L.gap;
      y = 0;
      colW = 0;
    }
    items.push({ id: slot.id, x, y });
    colW = Math.max(colW, slot.w);
    y += slot.h + L.gap;
    used = Math.max(used, x + colW);
    height = Math.max(height, y - L.gap);
  }
  return { w: notes.length > 0 ? used : lead.w, h: height, items };
}

const shift = (items: readonly Placement[], dx: number, dy: number): Placement[] => items.map((it) => ({ id: it.id, x: it.x + dx, y: it.y + dy }));

/** Grade fileira a fileira, com colunas alinhadas pela maior largura. */
function grid(cells: readonly Laid[], columns: number): Laid {
  if (cells.length === 0) return { w: 0, h: 0, items: [] };
  const colW: number[] = [];
  const rowH: number[] = [];
  cells.forEach((c, i) => {
    colW[i % columns] = Math.max(colW[i % columns] ?? 0, c.w);
    rowH[Math.floor(i / columns)] = Math.max(rowH[Math.floor(i / columns)] ?? 0, c.h);
  });
  const xs = colW.map((_, c) => colW.slice(0, c).reduce((sum, w) => sum + w + L.gap, 0));
  const ys = rowH.map((_, r) => rowH.slice(0, r).reduce((sum, h) => sum + h + L.gap, 0));
  const items = cells.flatMap((c, i) => shift(c.items, xs[i % columns] as number, ys[Math.floor(i / columns)] as number));
  return { w: colW.reduce((sum, w) => sum + w, 0) + L.gap * (colW.length - 1), h: rowH.reduce((sum, h) => sum + h, 0) + L.gap * (rowH.length - 1), items };
}

/** Blocos um sobre o outro, alinhados à esquerda, ignorando os vazios. */
function stack(blocks: readonly Laid[], gap: number): Laid {
  const filled = blocks.filter((b) => b.items.length > 0);
  let y = 0;
  const items: Placement[] = [];
  for (const block of filled) {
    items.push(...shift(block.items, 0, y));
    y += block.h + gap;
  }
  return { w: Math.max(0, ...filled.map((b) => b.w)), h: filled.length > 0 ? y - gap : 0, items };
}

interface AreaBox { w: number; h: number; items: Placement[] }
const boxAround = (content: Laid): AreaBox => ({
  w: Math.max(AREA_LIMITS.minWidth, content.w + 2 * L.padding),
  h: Math.max(AREA_LIMITS.minHeight, content.h + AREA_HEADER + 2 * L.padding),
  items: shift(content.items, L.padding, AREA_HEADER + L.padding),
});

// ---- agrupamento ----

interface Team {
  lead: CanvasNode;
  solo: boolean;
  recruits: CanvasNode[];
  headerNotes: CanvasNode[];
  /** Id do recruta → notas ao lado dele. */
  beside: Map<string, CanvasNode[]>;
}

export interface OrganizeOptions {
  rules?: OrganizeRules;
  /** Ids que não se movem, além dos nós travados. */
  pinned?: ReadonlySet<string>;
}

interface Hit { x: number; y: number; w: number; h: number }
const overlaps = (a: Hit, b: Hit, gap: number): boolean => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** O `x` mais à esquerda, a partir de `from`, em que a caixa não toca nenhum obstáculo fixo. */
function clearX(box: Hit, from: number, obstacles: readonly Hit[]): number {
  let x = from;
  for (let pass = 0; pass <= obstacles.length; pass++) {
    const hit = obstacles.find((o) => overlaps({ ...box, x }, o, L.areaGap / 2));
    if (!hit) return x;
    x = hit.x + hit.w + L.areaGap / 2;
  }
  return x;
}

/** O arranjo por áreas. Ver o cabeçalho do arquivo e `reference/argos.md` §Organizar em áreas. */
export function organizeCanvas(doc: CanvasDoc, options: OrganizeOptions = {}): OrganizeResult {
  const rules = options.rules?.areas ?? [];
  const pinned = options.pinned ?? new Set<string>();
  const order = new Map(doc.nodes.map((node, i) => [node.id, i] as const));
  const at = (node: CanvasNode): number => order.get(node.id) as number;
  const byDoc = (a: CanvasNode, b: CanvasNode): number => at(a) - at(b);

  const movable = new Map<string, CanvasNode>();
  const fixed: string[] = [];
  const obstacles: Hit[] = [];
  for (const node of doc.nodes) {
    if (isAreaNode(node)) continue;
    if (isLiveNodeType(node.type)) obstacles.push(node);
    else if (node.locked || pinned.has(node.id)) {
      fixed.push(node.id);
      obstacles.push(node);
    } else movable.set(node.id, node);
  }
  const nodes = [...movable.values()];

  // quem lidera e quem é recruta (aresta `recruit` ou `data.recruiter`), tudo por id
  const recruitedBy = new Map<string, string>();
  for (const edge of doc.edges) if (edge.kind === RECRUIT_EDGE_KIND) recruitedBy.set(edge.to, edge.from);
  const teams = new Map<string, Team>();
  const teamOf = new Map<string, string>();
  const terminals = nodes.filter((node) => node.type === TERMINAL_NODE_TYPE);
  for (const node of terminals) {
    if (!isOrchestrator(node)) continue;
    teams.set(node.id, { lead: node, solo: false, recruits: [], headerNotes: [], beside: new Map() });
    teamOf.set(node.id, node.id);
  }
  for (const node of terminals) {
    if (teamOf.has(node.id)) continue;
    const boss = recruiterOf(node) ?? recruitedBy.get(node.id);
    const team = boss !== undefined ? teams.get(boss) : undefined;
    if (team && !team.solo) {
      team.recruits.push(node);
      teamOf.set(node.id, team.lead.id);
    } else teamOf.set(node.id, node.id);
  }

  // as notas (e qualquer nó que não é terminal) pelas conexões com terminais
  const linked = new Map<string, Set<string>>();
  const touch = (a: string, b: string): void => {
    linked.set(a, (linked.get(a) ?? new Set()).add(b));
    linked.set(b, (linked.get(b) ?? new Set()).add(a));
  };
  for (const edge of doc.edges) if (edge.kind === LINK_EDGE_KIND) touch(edge.from, edge.to);
  for (const node of nodes) if (node.type === NOTE_TYPE && typeof node.data.agent === "string") touch(node.id, node.data.agent);
  const attachables = nodes.filter((node) => node.type !== TERMINAL_NODE_TYPE);
  const home = new Map<string, string>();
  const teamFor = (key: string): Team => {
    const found = teams.get(key);
    if (found) return found;
    const solo: Team = { lead: movable.get(key) as CanvasNode, solo: true, recruits: [], headerNotes: [], beside: new Map() };
    teams.set(key, solo);
    return solo;
  };
  const attach = (node: CanvasNode, key: string, owners: readonly string[]): void => {
    const team = teamFor(key);
    home.set(node.id, key);
    const inside = owners.filter((owner) => teamOf.get(owner) === key);
    const only = inside.length === 1 ? (inside[0] as string) : undefined;
    if (only !== undefined && only !== key && team.recruits.some((r) => r.id === only)) team.beside.set(only, [...(team.beside.get(only) ?? []), node]);
    else team.headerNotes.push(node);
  };
  for (const node of attachables) {
    const owners = [...(linked.get(node.id) ?? [])].filter((id) => teamOf.has(id)).sort((a, b) => (order.get(a) as number) - (order.get(b) as number));
    if (owners.length === 0) continue;
    const keys = [...new Set(owners.map((owner) => teamOf.get(owner) as string))].sort((a, b) => (order.get(a) as number) - (order.get(b) as number));
    attach(node, keys[0] as string, owners);
  }
  // nó ligado só a outra nota vai para o cabeçalho da equipe dessa nota
  for (let moved = true; moved; ) {
    moved = false;
    for (const node of attachables) {
      if (home.has(node.id)) continue;
      const via = [...(linked.get(node.id) ?? [])].filter((id) => home.has(id)).sort((a, b) => (order.get(a) as number) - (order.get(b) as number))[0];
      if (via === undefined) continue;
      attach(node, home.get(via) as string, []);
      moved = true;
    }
  }

  const fora = nodes.filter((node) => (node.type === TERMINAL_NODE_TYPE ? !teams.has(teamOf.get(node.id) as string) : !home.has(node.id)));
  const teamKeys = [...teams.keys()];

  // ordem das equipes: as que já têm área ficam onde estão (esquerda para a direita), as novas entram no fim pela ordem do documento
  const existing = new Map(areaNodes(doc).map(({ node }) => [node.id, node] as const));
  const rank = (key: string): [number, number, number, number] => {
    const area = existing.get(`${ORGANIZE_AREA_PREFIX}${key}`);
    return area ? [0, area.x, area.y, 0] : [1, order.get(key) as number, 0, 0];
  };
  teamKeys.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || (order.get(a) as number) - (order.get(b) as number);
  });

  // origem: o canto das áreas que já existem; sem nenhuma, o canto superior esquerdo do que se organiza
  const known = teamKeys.flatMap((key) => [...existing.values()].filter((area) => area.id === `${ORGANIZE_AREA_PREFIX}${key}` || area.id.startsWith(`${ORGANIZE_AREA_PREFIX}${key}:`)));
  const corners = known.length > 0 ? known : nodes;
  const origin = corners.length > 0 ? { x: Math.min(...corners.map((n) => n.x)), y: Math.min(...corners.map((n) => n.y)) } : { x: 0, y: 0 };

  const areas: OrganizedArea[] = [];
  const placements: Placement[] = [];
  let cursor = origin.x;
  const nameOf = (node: CanvasNode): string => labelOf(node);
  for (const key of teamKeys) {
    const team = teams.get(key) as Team;
    const leadName = nameOf(team.lead);
    const matching = (node: CanvasNode): number =>
      team.solo ? -1 : rules.findIndex((rule) => {
        if (rule.orchestrator !== undefined && rule.orchestrator !== leadName && rule.orchestrator !== team.lead.id) return false;
        const label = nameOf(node);
        return (rule.prefix !== undefined && label.startsWith(rule.prefix)) || (rule.pattern !== undefined && globMatches(rule.pattern, label));
      });
    const recruitCell = (node: CanvasNode): Laid => cell(slotOf(node), (team.beside.get(node.id) ?? []).sort(byDoc).map(slotOf));
    const sub = new Map<number, { recruits: CanvasNode[]; notes: CanvasNode[] }>();
    const into = (rule: number): { recruits: CanvasNode[]; notes: CanvasNode[] } => sub.get(rule) ?? sub.set(rule, { recruits: [], notes: [] }).get(rule) as { recruits: CanvasNode[]; notes: CanvasNode[] };
    const mainRecruits: CanvasNode[] = [];
    const mainNotes: CanvasNode[] = [];
    for (const node of [...team.recruits].sort(byDoc)) {
      const rule = matching(node);
      (rule < 0 ? mainRecruits : into(rule).recruits).push(node);
    }
    for (const node of [...team.headerNotes].sort(byDoc)) {
      const rule = matching(node);
      (rule < 0 ? mainNotes : into(rule).notes).push(node);
    }

    const columns: { id: string; title: string; kind: OrganizedKind; box: AreaBox; ids: string[] }[] = [];
    const main = boxAround(stack([cell(slotOf(team.lead), mainNotes.map(slotOf)), grid(mainRecruits.map(recruitCell), L.recruitColumns)], L.gap));
    columns.push({ id: `${ORGANIZE_AREA_PREFIX}${key}`, title: leadName, kind: "team", box: main, ids: main.items.map((it) => it.id) });
    for (const [index, rule] of rules.entries()) {
      const part = sub.get(index);
      if (!part || part.recruits.length + part.notes.length === 0) continue;
      const box = boxAround(stack([grid(part.notes.map((n) => single(slotOf(n))), L.noteColumns), grid(part.recruits.map(recruitCell), L.recruitColumns)], L.gap));
      columns.push({ id: `${ORGANIZE_AREA_PREFIX}${key}:${slugOf(rule.title)}`, title: `${leadName} · ${rule.title}`, kind: "sub", box, ids: box.items.map((it) => it.id) });
    }

    const width = Math.max(...columns.map((c) => c.box.w));
    const height = columns.reduce((sum, c) => sum + c.box.h + L.areaGap, -L.areaGap);
    const x = clearX({ x: cursor, y: origin.y, w: width, h: height }, cursor, obstacles);
    let y = origin.y;
    for (const column of columns) {
      areas.push({ id: column.id, title: column.title, kind: column.kind, owner: key, members: column.ids, box: { x, y, w: column.box.w, h: column.box.h } });
      placements.push(...shift(column.box.items, x, y));
      y += column.box.h + L.areaGap;
    }
    cursor = x + width + L.areaGap;
  }

  // o resto, em grade no fim
  const rest = [...fora].sort(byDoc);
  if (rest.length > 0) {
    const cols = Math.max(1, Math.min(L.foraColumns, Math.ceil(Math.sqrt(rest.length))));
    const block = grid(rest.map((node) => single(slotOf(node))), cols);
    const x = clearX({ x: cursor, y: origin.y, w: block.w, h: block.h }, cursor, obstacles);
    placements.push(...shift(block.items, x, origin.y));
  }

  return { areas, placements: placements.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), fora: rest.map((node) => node.id), fixed };
}

/**
 * O arranjo como uma operação só da pilha de desfazer: cria as áreas novas, atualiza `data.members` e a caixa das que já
 * existem (título e cor do dono ficam), tira dos membros de outras áreas os nós que o arranjo levou, e move os nós.
 * `undefined` quando o canvas já está arrumado.
 */
export function organizeOp(doc: CanvasDoc, result: OrganizeResult): CanvasOp | undefined {
  const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));
  const known = new Map(areaNodes(doc).map(({ node, data }) => [node.id, { node, data }] as const));
  const ours = new Set(result.areas.map((area) => area.id));
  const placed = new Set(result.areas.flatMap((area) => area.members));
  const ops: AtomicOp[] = [];

  const fresh: CanvasNode[] = [];
  const frames: TidyFrame[] = [];
  result.areas.forEach((area) => {
    const current = known.get(area.id);
    if (!current) {
      const color = AREA_COLORS[(areaNodes(doc).length + fresh.length) % AREA_COLORS.length];
      fresh.push({ id: area.id, type: AREA_TYPE, ...area.box, z: AREA_Z, data: areaDataOf({ title: area.title, color: color as (typeof AREA_COLORS)[number], members: area.members }), locked: false, blurred: false });
      return;
    }
    frames.push({ id: area.id, ...area.box });
    if (current.data.members.join("\n") !== area.members.join("\n")) ops.push(opUpdate(doc, area.id, areaDataOf({ ...current.data, members: area.members })));
  });
  for (const [id, { data }] of known) {
    if (ours.has(id) || !data.members.some((member) => placed.has(member))) continue;
    ops.push(opUpdate(doc, id, areaDataOf({ ...data, members: data.members.filter((member) => !placed.has(member)) })));
  }
  const moves = tidyOp(doc, { placements: result.placements.filter((p) => byId.has(p.id)), frames });
  const rest = moves === undefined ? [] : moves.kind === "batch" ? moves.ops : [moves];
  const all = [...(fresh.length > 0 ? [opCreate(doc, fresh)] : []), ...ops, ...rest];
  if (all.length === 0) return undefined;
  return all.length === 1 ? (all[0] as AtomicOp) : opBatch(all);
}

/** Quantos nós o arranjo leva para outra posição. */
export function movedCount(doc: CanvasDoc, result: OrganizeResult): number {
  const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));
  return result.placements.filter((place) => {
    const node = byId.get(place.id);
    return node !== undefined && (node.x !== place.x || node.y !== place.y);
  }).length;
}

/** O resumo que a CLI imprime: totais, uma linha por área (`id`, título, caixa e quantos) e uma por nó em `FORA`. */
export function organizeSummary(doc: CanvasDoc, result: OrganizeResult): string[] {
  const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));
  const lines = [`áreas: ${result.areas.length}\tmovidos: ${movedCount(doc, result)}\tfixos: ${result.fixed.length}\tFORA: ${result.fora.length}`];
  for (const area of result.areas) lines.push(`${area.id}\t${area.title}\t${area.box.x},${area.box.y} ${area.box.w}x${area.box.h}\t${area.members.length}`);
  for (const id of result.fora) {
    const node = byId.get(id);
    lines.push(`FORA\t${node ? labelOf(node) : id}\t${id}\t${node?.type ?? "?"}`);
  }
  return lines;
}
