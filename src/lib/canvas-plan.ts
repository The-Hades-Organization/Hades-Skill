// Plano de orquestração no canvas: parser puro do `plan.md` (seções `##`, "Estado atual" e a tabela de "## Unidades") e a
// ligação unidade → agente do registro. Sem disco, sem relógio: o texto e a lista de agentes entram por parâmetro
// (reference/argos.md §Conteúdo de agente e de plano).

export const PLAN_ERRORS = {
  tooLarge: "plan_too_large",
  invalidText: "plan_invalid_text",
} as const;
export type PlanErrorCode = (typeof PLAN_ERRORS)[keyof typeof PLAN_ERRORS];

export class PlanError extends Error {
  readonly code: PlanErrorCode;
  constructor(code: PlanErrorCode, message: string) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

export const PLAN_LIMITS = {
  /** tamanho do texto aceito, em bytes; acima disso o parser recusa em vez de varrer */
  textBytes: 512 * 1024,
  sections: 200,
  units: 200,
  /** colunas lidas da tabela; as de fora são ignoradas */
  columns: 16,
  cellChars: 400,
  sectionChars: 8000,
  stateChars: 20_000,
  titleChars: 200,
} as const;

/** Mesma forma de nome que o registro de agentes aceita (`AGENT_NAME` de argos.ts). */
const UNIT_NAME = /^[\w.-]{1,80}$/;
const STATE_TITLE = /^Estado atual([^A-Za-z0-9_]|$)/;
const UNITS_TITLE = /^## Unidades\s*$/;
const CODE_FENCE = /^\s*(```|~~~)/;
const EMPTY_CELL = /^(—|-|–|n\/a|nenhuma?)?$/i;

export interface PlanSection {
  title: string;
  /** corpo da seção até o próximo `##`, sem a linha do título; cortado em `sectionChars` */
  body: string;
  clipped: boolean;
}

export interface PlanUnit {
  name: string;
  role: string;
  base: string;
  dependsOn: string[];
  /** as demais colunas da linha, pelo cabeçalho em minúsculas */
  cells: Record<string, string>;
}

export interface ParsedPlan {
  title: string | null;
  state: PlanSection | null;
  sections: PlanSection[];
  units: PlanUnit[];
  /** linhas da tabela sem nome de unidade válido */
  skippedRows: number;
  /** o que passou do teto e foi cortado */
  truncated: { sections: boolean; units: boolean };
}

export interface AgentRef {
  name: string;
  registry: string;
  state: string;
}

export interface LinkedUnit extends PlanUnit {
  /** o agente de mesmo nome no registro (o primeiro da lista, que vem com o registro do projeto antes do `_skill`) */
  agent: AgentRef | null;
}

const clip = (text: string, max: number): { text: string; clipped: boolean } =>
  text.length > max ? { text: text.slice(0, max), clipped: true } : { text, clipped: false };

const splitRow = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isRule = (row: string[]): boolean => row.every((c) => /^:?-{2,}:?$/.test(c));
const bare = (text: string): string => text.replaceAll("`", "").trim();

function section(title: string, bodyLines: string[], maxBody: number): PlanSection {
  const { text, clipped } = clip(bodyLines.join("\n").trim(), maxBody);
  return { title: clip(title, PLAN_LIMITS.titleChars).text, body: text, clipped };
}

/** Linhas de dados da tabela: uma linha com mais células que o cabeçalho devolve o excesso à última coluna (código com `|`). */
function unitFromRow(header: string[], row: string[]): PlanUnit | undefined {
  const width = Math.min(header.length, PLAN_LIMITS.columns);
  const values = row.length > header.length ? [...row.slice(0, header.length - 1), row.slice(header.length - 1).join("|")] : row;
  const cells: Record<string, string> = {};
  for (let i = 0; i < width; i++) {
    const head = header[i] as string;
    if (head !== "" && !(head in cells)) cells[head] = clip(values[i] ?? "", PLAN_LIMITS.cellChars).text;
  }
  const column = (pattern: RegExp): string => {
    const at = header.findIndex((h) => pattern.test(h));
    return at < 0 || at >= width ? "" : (cells[header[at] as string] ?? "");
  };
  const name = bare(column(/^unidade/));
  if (!UNIT_NAME.test(name)) return undefined;
  const dependsOn = column(/^depende/).split(/[,;]/).map(bare).filter((d) => !EMPTY_CELL.test(d) && UNIT_NAME.test(d));
  return { name, role: bare(column(/^papel/)).toLowerCase() || "impl", base: bare(column(/^base/)), dependsOn, cells };
}

/** O plano em partes: título (`# `), seções `##` fora de bloco de código, "Estado atual" e a tabela de "## Unidades". */
export function parsePlan(text: string): ParsedPlan {
  if (typeof text !== "string") throw new PlanError(PLAN_ERRORS.invalidText, "texto do plano inválido");
  if (Buffer.byteLength(text) > PLAN_LIMITS.textBytes) throw new PlanError(PLAN_ERRORS.tooLarge, "plano grande demais");
  const lines = text.replaceAll("\r", "").split("\n");
  const sections: PlanSection[] = [];
  const units: PlanUnit[] = [];
  const truncated = { sections: false, units: false };
  let title: string | null = null;
  let state: PlanSection | null = null;
  let skippedRows = 0;
  let inFence = false;
  let current: { title: string; body: string[] } | undefined;
  let inUnits = false;
  let header: string[] | undefined;

  const close = (): void => {
    if (!current) return;
    const isState = STATE_TITLE.test(current.title);
    const made = section(current.title, current.body, isState ? PLAN_LIMITS.stateChars : PLAN_LIMITS.sectionChars);
    if (isState && state === null) state = made;
    if (sections.length < PLAN_LIMITS.sections) sections.push(made);
    else truncated.sections = true;
    current = undefined;
  };

  for (const line of lines) {
    if (CODE_FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith("## ")) {
      close();
      current = { title: line.slice(3).trim(), body: [] };
      inUnits = UNITS_TITLE.test(line);
      header = undefined;
      continue;
    }
    if (!inFence && title === null && line.startsWith("# ")) title = clip(line.slice(2).trim(), PLAN_LIMITS.titleChars).text;
    if (current) current.body.push(line);
    if (inFence || !inUnits || !line.trim().startsWith("|")) continue;
    const row = splitRow(line);
    if (isRule(row)) continue;
    if (!header) {
      header = row.map((c) => c.toLowerCase());
      continue;
    }
    if (units.length >= PLAN_LIMITS.units) {
      truncated.units = true;
      continue;
    }
    const unit = unitFromRow(header, row);
    if (unit) units.push(unit);
    else skippedRows++;
  }
  close();
  return { title, state, sections, units, skippedRows, truncated };
}

/** Cada unidade com o agente de mesmo nome; o primeiro da lista vence se dois registros têm o nome. */
export function linkUnitsToAgents(units: readonly PlanUnit[], agents: readonly AgentRef[]): LinkedUnit[] {
  const byName = new Map<string, AgentRef>();
  for (const agent of agents) if (!byName.has(agent.name)) byName.set(agent.name, agent);
  return units.map((unit) => ({ ...unit, agent: byName.get(unit.name) ?? null }));
}
