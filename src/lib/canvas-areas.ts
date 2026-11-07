// Áreas do canvas (reference/argos.md §Áreas): retângulos coloridos que agrupam nós por encaixe. A área é um nó do usuário
// (`type` "area"); quem está nela vive no `data` da própria área (`members`), então o documento não muda de forma: só
// cresce (documento antigo, sem área, segue válido). Funções puras sobre o documento: cada operação devolve uma `CanvasOp`
// da pilha de desfazer (`undefined` quando nada muda). Sem Node e sem DOM: roda no painel e na CLI.
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNode } from "./canvas-doc.ts";
import { type AtomicOp, applyOp, type CanvasOp, opBatch, opCreate, opMove, opUpdate } from "./canvas-history.ts";
import { SELECTION_LIMITS } from "./canvas-selection.ts";

export const AREA_TYPE = "area";

/** Atrás de tudo: a área nunca cobre um nó, e o acerto do clique escolhe sempre o nó de cima. */
export const AREA_Z = -CANVAS_LIMITS.layer;

/** Paleta fechada: os tokens `--chart-N` do painel, que já existem nos dois temas. */
export const AREA_COLORS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const;
export type AreaColor = (typeof AREA_COLORS)[number];

export const AREA_LIMITS = {
  /** Áreas por documento. */
  areas: 200,
  /** Tamanho padrão e mínimo, em unidades do canvas. */
  width: 480,
  height: 320,
  minWidth: 160,
  minHeight: 120,
  /** Folga entre a borda da área e o nó encaixado por comando. */
  padding: 16,
  /** Distância entre a borda e o nó que sai da área por comando. */
  gap: 20,
} as const;

/** Faixa do título no topo da área (a mesma do cabeçalho dos nós): por ela a área se move. */
export const AREA_HEADER = SELECTION_LIMITS.header;

/** Códigos estáveis: só ganham valores. */
export const AREA_ERRORS = {
  invalidData: "area_invalid_data",
  invalidTitle: "area_invalid_title",
  invalidColor: "area_invalid_color",
  invalidId: "area_invalid_id",
  invalidFrame: "area_invalid_frame",
  duplicateId: "area_duplicate_id",
  duplicateMember: "area_duplicate_member",
  unknownArea: "area_unknown_area",
  unknownNode: "area_unknown_node",
  nested: "area_nested",
  limitExceeded: "area_limit_exceeded",
} as const;
export type AreaErrorCode = (typeof AREA_ERRORS)[keyof typeof AREA_ERRORS];

export class AreaError extends Error {
  readonly code: AreaErrorCode;
  constructor(code: AreaErrorCode, message: string) {
    super(message);
    this.name = "AreaError";
    this.code = code;
  }
}

const fail = (code: AreaErrorCode, message: string): never => {
  throw new AreaError(code, message);
};

const ID = /^[\w.:-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const DATA_KEYS = ["title", "color", "members"];

export interface AreaData {
  title: string;
  color: AreaColor;
  /** Ids dos nós encaixados, na ordem em que entraram. Ausente no documento é nenhum. */
  members: string[];
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

export const isAreaNode = (node: Pick<CanvasNode, "type">): boolean => node.type === AREA_TYPE;
export const isAreaColor = (value: unknown): value is AreaColor => typeof value === "string" && (AREA_COLORS as readonly string[]).includes(value);

/** O título aparado, de 1 a `labelChars` caracteres e sem caractere de controle. */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== "string") return fail(AREA_ERRORS.invalidTitle, "o título da área deve ser um texto");
  const title = raw.trim();
  if (title === "" || title.length > CANVAS_LIMITS.labelChars || CONTROL.test(title)) {
    return fail(AREA_ERRORS.invalidTitle, `o título da área deve ter de 1 a ${CANVAS_LIMITS.labelChars} caracteres, sem controle`);
  }
  return title;
}

/** Valida o `data` de uma área (campo desconhecido é recusado) e devolve uma cópia. */
export function readAreaData(raw: unknown): AreaData {
  if (!isDict(raw)) return fail(AREA_ERRORS.invalidData, "o data da área deve ser um objeto");
  const unknown = Object.keys(raw).find((key) => !DATA_KEYS.includes(key));
  if (unknown !== undefined) return fail(AREA_ERRORS.invalidData, `campo desconhecido no data da área: ${unknown}`);
  if (!isAreaColor(raw.color)) return fail(AREA_ERRORS.invalidColor, `a cor da área deve ser uma de ${AREA_COLORS.join(", ")}`);
  const members = raw.members ?? [];
  if (!Array.isArray(members) || members.length > CANVAS_LIMITS.groupMembers) return fail(AREA_ERRORS.invalidData, "members da área deve ser uma lista pequena");
  const seen = new Set<string>();
  for (const member of members) {
    if (typeof member !== "string" || !ID.test(member) || member.length > CANVAS_LIMITS.idChars) return fail(AREA_ERRORS.invalidData, "id de membro inválido");
    if (seen.has(member)) return fail(AREA_ERRORS.invalidData, "membro repetido na área");
    seen.add(member);
  }
  return { title: cleanTitle(raw.title), color: raw.color, members: [...members] as string[] };
}

/**
 * Título e cor para desenhar. Documento editado à mão pode trazer `data` fora do formato: o quadro nunca quebra por isso,
 * e a área sem cor válida sai neutra (`color` indefinido); quem grava passa por `readAreaData`, que recusa.
 */
export function areaLook(node: Pick<CanvasNode, "data">): { title: string; color: AreaColor | undefined } {
  const { title, color } = node.data;
  return { title: typeof title === "string" ? title : "", color: isAreaColor(color) ? color : undefined };
}

/** O `data` a gravar: sem `members` quando a lista é vazia (a forma gravada não leva lista vazia). */
export function areaDataOf(data: AreaData): Dict {
  return data.members.length > 0 ? { title: data.title, color: data.color, members: [...data.members] } : { title: data.title, color: data.color };
}

function dataOrFail(node: CanvasNode): AreaData {
  return readAreaData(node.data);
}

/** As áreas do documento com `data` válido, na ordem do documento. Área de `data` inválido não entra (o resto segue valendo). */
export function areaNodes(doc: CanvasDoc): { node: CanvasNode; data: AreaData }[] {
  const out: { node: CanvasNode; data: AreaData }[] = [];
  for (const node of doc.nodes) {
    if (!isAreaNode(node)) continue;
    try {
      out.push({ node, data: dataOrFail(node) });
    } catch (error) {
      if (!(error instanceof AreaError)) throw error;
    }
  }
  return out;
}

function areaOrFail(doc: CanvasDoc, areaId: string): { node: CanvasNode; data: AreaData } {
  const node = doc.nodes.find((candidate) => candidate.id === areaId);
  if (!node || !isAreaNode(node)) return fail(AREA_ERRORS.unknownArea, "a área não existe no documento");
  return { node, data: dataOrFail(node) };
}

/** Os nós encaixados na área que ainda existem no documento, na ordem da lista. */
export function areaMembers(doc: CanvasDoc, areaId: string): CanvasNode[] {
  const { data } = areaOrFail(doc, areaId);
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  return data.members.flatMap((id) => {
    const node = byId.get(id);
    return node && !isAreaNode(node) ? [node] : [];
  });
}

/** Id do nó → id da área em que ele está encaixado. Em documento com um nó em duas áreas (alterado por fora) vale a primeira. */
export function areaIndex(doc: CanvasDoc): Map<string, string> {
  const present = new Set(doc.nodes.map((node) => node.id));
  const index = new Map<string, string>();
  for (const { node, data } of areaNodes(doc)) for (const member of data.members) if (present.has(member) && !index.has(member)) index.set(member, node.id);
  return index;
}

export interface AreaReport {
  id: string;
  title: string;
  color: AreaColor;
  members: { id: string; type: string }[];
}

/** Quem está em cada área (para a CLI e para agentes): só leitura. */
export function areaReport(doc: CanvasDoc): AreaReport[] {
  return areaNodes(doc).map(({ node, data }) => ({
    id: node.id,
    title: data.title,
    color: data.color,
    members: areaMembers(doc, node.id).map((member) => ({ id: member.id, type: member.type })),
  }));
}

/** A área que contém o ponto; com áreas sobrepostas vale a menor (a de dentro), e no empate a última da lista. */
export function areaAtPoint(doc: CanvasDoc, point: { x: number; y: number }, ignore: ReadonlySet<string> = new Set()): string | undefined {
  let best: CanvasNode | undefined;
  for (const { node } of areaNodes(doc)) {
    if (ignore.has(node.id)) continue;
    if (point.x < node.x || point.x > node.x + node.w || point.y < node.y || point.y > node.y + node.h) continue;
    if (!best || node.w * node.h <= best.w * best.h) best = node;
  }
  return best?.id;
}

const centerOf = (node: CanvasNode): { x: number; y: number } => ({ x: node.x + node.w / 2, y: node.y + node.h / 2 });

/** Os nós (sem as áreas) cujo centro cai dentro do retângulo, na ordem do documento: quem a área desenhada em volta encaixa. */
export function nodesCenteredIn(doc: CanvasDoc, rect: { x: number; y: number; w: number; h: number }): string[] {
  return doc.nodes
    .filter((node) => !isAreaNode(node))
    .filter((node) => {
      const center = centerOf(node);
      return center.x >= rect.x && center.x <= rect.x + rect.w && center.y >= rect.y && center.y <= rect.y + rect.h;
    })
    .map((node) => node.id);
}

/** Os ids com os membros das áreas que estão entre eles: mover a área leva quem está encaixado. Sem repetir, na ordem. */
export function withAreaMembers(doc: CanvasDoc, ids: readonly string[]): string[] {
  const out = new Set(ids);
  for (const id of ids) {
    const node = doc.nodes.find((candidate) => candidate.id === id);
    if (!node || !isAreaNode(node)) continue;
    for (const member of areaMembers(doc, id)) out.add(member.id);
  }
  return [...out];
}

/** Lista nova de membros de uma área; igual à atual devolve `undefined`. */
function setMembers(doc: CanvasDoc, areaId: string, members: readonly string[]): AtomicOp | undefined {
  const { node, data } = areaOrFail(doc, areaId);
  if (members.length === data.members.length && members.every((id, i) => id === data.members[i])) return undefined;
  if (members.length > CANVAS_LIMITS.groupMembers) return fail(AREA_ERRORS.limitExceeded, "área com membros demais");
  return opUpdate(doc, node.id, areaDataOf({ ...data, members: [...members] }));
}

/** Aplica as listas novas (área → membros) sobre o documento, um `update` por área que mudou. */
function memberOps(doc: CanvasDoc, next: ReadonlyMap<string, readonly string[]>): AtomicOp[] {
  const ops: AtomicOp[] = [];
  for (const [areaId, members] of next) {
    const op = setMembers(doc, areaId, members);
    if (op) ops.push(op);
  }
  return ops;
}

const asOp = (ops: readonly AtomicOp[]): CanvasOp | undefined => (ops.length === 0 ? undefined : ops.length === 1 ? ops[0] : opBatch(ops));

/** Lista de membros de cada área do documento (a lista bruta do `data`), para ir alterando antes de gravar. */
function memberLists(doc: CanvasDoc): Map<string, string[]> {
  return new Map(areaNodes(doc).map(({ node, data }) => [node.id, [...data.members]]));
}

/**
 * Ao soltar um arrasto (o documento já com o movimento): cada nó solto cujo centro caiu dentro de uma área entra nela; o
 * que caiu fora da área em que estava sai. Área arrastada junto leva os membros dela, então eles não mudam; área não é
 * encaixável (área dentro de área fica fora). `undefined` quando nada muda.
 */
export function dropOps(doc: CanvasDoc, draggedIds: readonly string[]): CanvasOp | undefined {
  const dragged = new Set(draggedIds);
  const draggedAreas = new Set(doc.nodes.filter((node) => dragged.has(node.id) && isAreaNode(node)).map((node) => node.id));
  const current = areaIndex(doc);
  const lists = memberLists(doc);
  for (const node of doc.nodes) {
    if (!dragged.has(node.id) || isAreaNode(node)) continue;
    const from = current.get(node.id);
    if (from !== undefined && draggedAreas.has(from)) continue;
    const to = areaAtPoint(doc, centerOf(node), draggedAreas);
    if (to === from) continue;
    if (from !== undefined) lists.set(from, (lists.get(from) ?? []).filter((id) => id !== node.id));
    if (to !== undefined) lists.set(to, [...(lists.get(to) ?? []), node.id]);
  }
  return asOp(memberOps(doc, lists));
}

/** As operações atômicas de `op`, em ordem (um lote se abre; uma atômica vira lista de uma). */
const atomsOf = (op: CanvasOp): AtomicOp[] => (op.kind === "batch" ? op.ops : [op]);

/**
 * O movimento de um arrasto ou de uma seta mais o encaixe que ele provoca, num passo só do desfazer: `move` já calculado
 * sobre `doc` (com os membros das áreas movidas) e `draggedIds` os nós que o gesto levou. Sem movimento, nada encaixa.
 */
export function settleMove(doc: CanvasDoc, move: CanvasOp | undefined, draggedIds: readonly string[]): CanvasOp | undefined {
  if (!move) return undefined;
  const drop = dropOps(applyOp(doc, move), draggedIds);
  return drop ? asOp([...atomsOf(move), ...atomsOf(drop)]) : move;
}

/** A área que receberia o nó solto agora (retorno visual do arrasto), com o deslocamento `dx`, `dy`; `undefined` fora de área. */
export function dropTargets(doc: CanvasDoc, draggedIds: readonly string[], dx: number, dy: number): string[] {
  const dragged = new Set(draggedIds);
  const draggedAreas = new Set(doc.nodes.filter((node) => dragged.has(node.id) && isAreaNode(node)).map((node) => node.id));
  const current = areaIndex(doc);
  const targets = new Set<string>();
  for (const node of doc.nodes) {
    if (!dragged.has(node.id) || isAreaNode(node)) continue;
    const from = current.get(node.id);
    if (from !== undefined && draggedAreas.has(from)) continue;
    const center = centerOf(node);
    const to = areaAtPoint(doc, { x: center.x + dx, y: center.y + dy }, draggedAreas);
    if (to !== undefined) targets.add(to);
  }
  return [...targets];
}

function dockableOrFail(doc: CanvasDoc, ids: readonly string[]): CanvasNode[] {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const picked: CanvasNode[] = [];
  for (const id of new Set(ids)) {
    const node = byId.get(id);
    if (!node) return fail(AREA_ERRORS.unknownNode, "o nó não existe no documento");
    if (isAreaNode(node)) return fail(AREA_ERRORS.nested, "área dentro de área não existe");
    picked.push(node);
  }
  return picked;
}

/**
 * Encaixa os nós na área (o equivalente de teclado e de menu do arrasto): quem já está dentro fica onde está; quem está fora
 * vai para dentro, por baixo do título. Sai de qualquer outra área em que estivesse. Nó travado não anda, mas entra na
 * lista. Erros: `area_unknown_area`, `area_unknown_node`, `area_nested`, `area_limit_exceeded`.
 */
export function dockNodes(doc: CanvasDoc, ids: readonly string[], areaId: string): CanvasOp | undefined {
  const { node: area } = areaOrFail(doc, areaId);
  const picked = dockableOrFail(doc, ids);
  const lists = memberLists(doc);
  const moves: AtomicOp[] = [];
  const grid = SELECTION_LIMITS.grid;
  let slot = 0;
  for (const node of picked) {
    for (const [otherId, members] of lists) if (otherId !== areaId) lists.set(otherId, members.filter((id) => id !== node.id));
    const members = lists.get(areaId) ?? [];
    if (!members.includes(node.id)) lists.set(areaId, [...members, node.id]);
    const center = centerOf(node);
    const inside = center.x >= area.x && center.x <= area.x + area.w && center.y >= area.y && center.y <= area.y + area.h;
    if (inside || node.locked) continue;
    const pad = AREA_LIMITS.padding;
    const minX = area.x + pad;
    const minY = area.y + AREA_HEADER + pad;
    const maxX = Math.max(minX, area.x + area.w - pad - node.w);
    const maxY = Math.max(minY, area.y + area.h - pad - node.h);
    const x = Math.min(maxX, minX + slot * grid);
    const y = Math.min(maxY, minY + slot * grid);
    slot += 1;
    moves.push(opMove(doc, node.id, { x, y }));
  }
  return asOp([...moves, ...memberOps(doc, lists)]);
}

/**
 * Tira os nós da área em que estão (o equivalente de teclado e de menu de arrastar para fora): o nó vai para logo à direita
 * da área, na mesma altura, para a posição não contradizer a pertença. Nó que não está em área é ignorado; `undefined` se
 * nenhum está.
 */
export function undockNodes(doc: CanvasDoc, ids: readonly string[]): CanvasOp | undefined {
  const picked = dockableOrFail(doc, ids);
  const current = areaIndex(doc);
  const lists = memberLists(doc);
  const moves: AtomicOp[] = [];
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  for (const node of picked) {
    const from = current.get(node.id);
    const area = from === undefined ? undefined : byId.get(from);
    if (from === undefined || !area) continue;
    lists.set(from, (lists.get(from) ?? []).filter((id) => id !== node.id));
    if (!node.locked) moves.push(opMove(doc, node.id, { x: area.x + area.w + AREA_LIMITS.gap, y: node.y }));
  }
  return asOp([...moves, ...memberOps(doc, lists)]);
}

export interface NewArea {
  id: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  title?: string;
  color?: AreaColor;
  /** Nós que já nascem encaixados (saem de qualquer outra área). */
  members?: readonly string[];
}

/** A cor que segue a última área criada na paleta (a primeira sem área nenhuma). */
export function nextAreaColor(doc: CanvasDoc): AreaColor {
  return AREA_COLORS[areaNodes(doc).length % AREA_COLORS.length] as AreaColor;
}

/**
 * Cria a área, atrás de tudo (`AREA_Z`), e encaixa `members`. Um passo só no desfazer. Erros: `area_invalid_id`,
 * `area_duplicate_id`, `area_invalid_title`, `area_invalid_color`, `area_invalid_frame`, `area_unknown_node`, `area_nested`,
 * `area_limit_exceeded`.
 */
export function createAreaNode(doc: CanvasDoc, request: NewArea): { op: CanvasOp; node: CanvasNode } {
  if (!ID.test(request.id) || request.id.length > CANVAS_LIMITS.idChars) return fail(AREA_ERRORS.invalidId, "id de área inválido");
  if (doc.nodes.some((node) => node.id === request.id)) return fail(AREA_ERRORS.duplicateId, "já existe um nó com esse id");
  if (doc.nodes.length >= CANVAS_LIMITS.nodes || areaNodes(doc).length >= AREA_LIMITS.areas) return fail(AREA_ERRORS.limitExceeded, "documento passaria do limite de áreas");
  const w = request.w ?? AREA_LIMITS.width;
  const h = request.h ?? AREA_LIMITS.height;
  const limit = CANVAS_LIMITS.coordinate;
  const finiteIn = (value: number, min: number, max: number): boolean => Number.isFinite(value) && value >= min && value <= max;
  if (!finiteIn(request.x, -limit, limit) || !finiteIn(request.y, -limit, limit) || !finiteIn(w, AREA_LIMITS.minWidth, CANVAS_LIMITS.size) || !finiteIn(h, AREA_LIMITS.minHeight, CANVAS_LIMITS.size)) {
    return fail(AREA_ERRORS.invalidFrame, "posição ou tamanho da área fora do intervalo");
  }
  const color = request.color ?? nextAreaColor(doc);
  if (!isAreaColor(color)) return fail(AREA_ERRORS.invalidColor, `a cor da área deve ser uma de ${AREA_COLORS.join(", ")}`);
  const members = dockableOrFail(doc, request.members ?? []).map((node) => node.id);
  const title = cleanTitle(request.title ?? `Área ${areaNodes(doc).length + 1}`);
  const node: CanvasNode = {
    id: request.id, type: AREA_TYPE, x: request.x, y: request.y, w, h, z: AREA_Z,
    data: areaDataOf({ title, color, members }), locked: false, blurred: false,
  };
  const create = opCreate(doc, [node]);
  const taken = new Set(members);
  const lists = memberLists(doc);
  for (const [areaId, list] of lists) lists.set(areaId, list.filter((id) => !taken.has(id)));
  return { op: asOp([create, ...memberOps(doc, lists)]) as CanvasOp, node };
}

/** Troca o título; igual ao de agora (depois de aparar) devolve `undefined`. Erros: `area_unknown_area`, `area_invalid_title`. */
export function renameArea(doc: CanvasDoc, areaId: string, title: string): CanvasOp | undefined {
  const { node, data } = areaOrFail(doc, areaId);
  const clean = cleanTitle(title);
  return clean === data.title ? undefined : opUpdate(doc, node.id, areaDataOf({ ...data, title: clean }));
}

/** Troca a cor (da paleta fechada); igual à de agora devolve `undefined`. Erros: `area_unknown_area`, `area_invalid_color`. */
export function recolorArea(doc: CanvasDoc, areaId: string, color: string): CanvasOp | undefined {
  const { node, data } = areaOrFail(doc, areaId);
  if (!isAreaColor(color)) return fail(AREA_ERRORS.invalidColor, `a cor da área deve ser uma de ${AREA_COLORS.join(", ")}`);
  return color === data.color ? undefined : opUpdate(doc, node.id, areaDataOf({ ...data, color }));
}

/**
 * Passos que tiram `gone` (nós que saem do documento) da lista de membros das áreas que ficam. Quem apaga nós os junta ao
 * `delete`: desfazer devolve os nós e a pertença no mesmo passo. Área que também sai não precisa de passo.
 */
export function pruneMembersOps(doc: CanvasDoc, gone: ReadonlySet<string>): AtomicOp[] {
  const ops: AtomicOp[] = [];
  for (const { node, data } of areaNodes(doc)) {
    if (gone.has(node.id) || !data.members.some((id) => gone.has(id))) continue;
    ops.push(opUpdate(doc, node.id, areaDataOf({ ...data, members: data.members.filter((id) => !gone.has(id)) })));
  }
  return ops;
}

/**
 * O `data` de uma área colada: os membros que também foram copiados passam para os ids novos (`renamed`), os demais saem,
 * para a cópia nunca disputar com o original os nós de quem não foi junto. Nó que não é área volta como veio.
 */
export function remapAreaData(node: Pick<CanvasNode, "type" | "data">, renamed: ReadonlyMap<string, string>): Dict {
  if (!isAreaNode(node)) return node.data;
  const data = readAreaData(node.data);
  return areaDataOf({ ...data, members: data.members.flatMap((id) => renamed.get(id) ?? []) });
}

/** Confere as áreas do documento: `data` válido, nó em uma área só e nenhuma área como membro. Lança `AreaError`. */
export function checkAreas(doc: CanvasDoc): void {
  const owner = new Map<string, string>();
  const ids = new Set(doc.nodes.filter(isAreaNode).map((node) => node.id));
  for (const node of doc.nodes) {
    if (!isAreaNode(node)) continue;
    for (const member of dataOrFail(node).members) {
      if (ids.has(member)) fail(AREA_ERRORS.nested, "área dentro de área não existe");
      if (owner.has(member)) fail(AREA_ERRORS.duplicateMember, "um nó só fica em uma área");
      owner.set(member, node.id);
    }
  }
}
