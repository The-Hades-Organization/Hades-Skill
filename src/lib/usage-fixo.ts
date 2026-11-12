// Contexto fixo por sessão: o que a primeira resposta da sessão já carregava (input + cache read + cache creation), antes de
// qualquer trabalho. Funções puras sobre as linhas do Consumo; quem lê disco e configuração injeta (usage-fixo-io.ts).
import { PRICE } from "./price.ts";
import type { Row } from "./usage.ts";

/** Partes do contexto fixo que dá para medir em disco. Estimativa por tamanho, não por token. */
export const PARTS = ["claudeMd", "memory", "skill", "brief"] as const;
export type Part = (typeof PARTS)[number];
export type PartBytes = Partial<Record<Part, number>>;

export const PART_LABEL: Record<Part, string> = {
  claudeMd: "cadeia de CLAUDE.md",
  memory: "MEMORY.md do projeto",
  skill: "SKILL.md da Hades",
  brief: "brief.md do agente",
};

/** Mínimo de sessões em cada janela de 7 dias para o doctor comparar; abaixo disso o estado é neutro. */
export const MIN_SESSIONS_PER_WINDOW = 3;
const WINDOW_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const P90 = 0.9;
const GROUP_LIMIT = 20;

/** A primeira resposta de uma sessão principal: onde e com que modelo, e quanto contexto já pesava. */
export interface Opening {
  session: string;
  day: string;
  cwd: string;
  model: string;
  ctx: number;
  /** Turnos e custo (US$) da sessão inteira, para a conta do piso. */
  turns: number;
  cost: number;
}

/** Uma abertura por sessão principal; a sessão sem resposta com uso (sem linha `open`) não entra. */
export function openingsOf(rows: Row[]): Opening[] {
  const totals = new Map<string, { turns: number; cost: number }>();
  for (const row of rows) {
    if (row.sidechain) continue;
    const total = totals.get(row.session) ?? { turns: 0, cost: 0 };
    total.turns += row.turns;
    total.cost += row.cost;
    totals.set(row.session, total);
  }
  const found: Opening[] = [];
  for (const row of rows) {
    if (row.sidechain || row.open === undefined) continue;
    const total = totals.get(row.session) ?? { turns: row.turns, cost: row.cost };
    found.push({ session: row.session, day: row.day, cwd: row.cwd, model: row.open.model, ctx: row.open.ctx, turns: total.turns, cost: total.cost });
  }
  return found;
}

/** Nearest-rank: o menor valor com ao menos `p` da amostra à esquerda. Amostra vazia: undefined. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Mediana; nas amostras pares, a média dos dois do meio, arredondada. */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

export interface Spread {
  sessions: number;
  median: number;
  p90: number;
}

function spreadOf(ctxs: number[]): Spread | undefined {
  const mid = median(ctxs);
  const high = percentile(ctxs, P90);
  return mid === undefined || high === undefined ? undefined : { sessions: ctxs.length, median: mid, p90: high };
}

export interface FixedGroup extends Spread {
  repo: string;
  role: string;
  model: string;
  /** Bytes em disco das partes, medidas na pasta da sessão mais recente do grupo; ausente quando ninguém mediu. */
  parts?: PartBytes;
}

export interface FixedDay extends Spread {
  day: string;
}

/** Quanto do custo vem só do piso: contexto fixo relido a cada turno, ao preço de leitura de cache do modelo. */
export interface FixedFloor {
  sessions: number;
  turns: number;
  /** US$ da soma, nas sessões com abertura medida, de contexto fixo × turnos × preço de leitura de cache. */
  floorCost: number;
  cost: number;
  /** floorCost / cost, em %; ausente sem custo. */
  share?: number;
  method: string;
}

export interface FixedContext extends Spread {
  note: string;
  byDay: FixedDay[];
  groups: FixedGroup[];
  floor: FixedFloor;
}

export const FIXED_NOTE =
  "contexto da primeira resposta da sessão (input + cache read + cache creation); as partes em disco são estimativa por tamanho de arquivo, não tokens medidos";
export const FLOOR_METHOD =
  "piso = contexto da primeira resposta × turnos da sessão × preço de leitura de cache do modelo; é um mínimo, pois o contexto só cresce e a primeira escrita de cache custa mais";

export interface FixedInputs {
  roleOf: (cwd: string) => string;
  repoOf: (cwd: string) => string;
  partsOf?: (cwd: string, role: string) => PartBytes | undefined;
}

const keyOf = (...parts: string[]): string => JSON.stringify(parts);

function floorOf(openings: Opening[]): FixedFloor {
  let floorCost = 0;
  let cost = 0;
  let turns = 0;
  for (const o of openings) {
    const readPrice = PRICE[o.model]?.[2];
    cost += o.cost;
    turns += o.turns;
    if (readPrice !== undefined) floorCost += (o.ctx * o.turns * readPrice) / 1e6;
  }
  return { sessions: openings.length, turns, floorCost, cost, ...(cost > 0 ? { share: (100 * floorCost) / cost } : {}), method: FLOOR_METHOD };
}

/** O bloco do relatório; undefined quando nenhuma sessão da janela tem primeira resposta medida. */
export function buildFixedContext(rows: Row[], inputs: FixedInputs): FixedContext | undefined {
  const openings = openingsOf(rows);
  const overall = spreadOf(openings.map((o) => o.ctx));
  if (overall === undefined) return undefined;
  const groups = new Map<string, { repo: string; role: string; model: string; items: Opening[] }>();
  const days = new Map<string, number[]>();
  for (const o of openings) {
    const role = inputs.roleOf(o.cwd);
    const repo = inputs.repoOf(o.cwd);
    const slot = groups.get(keyOf(repo, role, o.model)) ?? { repo, role, model: o.model, items: [] };
    slot.items.push(o);
    groups.set(keyOf(repo, role, o.model), slot);
    days.set(o.day, [...(days.get(o.day) ?? []), o.ctx]);
  }
  const listed = [...groups.values()]
    .map((g): FixedGroup | undefined => {
      const spread = spreadOf(g.items.map((o) => o.ctx));
      const latest = g.items.reduce((a, b) => (b.day >= a.day ? b : a));
      const parts = inputs.partsOf?.(latest.cwd, g.role);
      return spread === undefined ? undefined : { repo: g.repo, role: g.role, model: g.model, ...spread, ...(parts ? { parts } : {}) };
    })
    .filter((g): g is FixedGroup => g !== undefined)
    .sort((a, b) => b.sessions - a.sessions || b.median - a.median)
    .slice(0, GROUP_LIMIT);
  const byDay = [...days]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([day, ctxs]) => {
      const spread = spreadOf(ctxs);
      return spread === undefined ? [] : [{ day, ...spread }];
    });
  return { ...overall, note: FIXED_NOTE, byDay, groups: listed, floor: floorOf(openings) };
}

// ---------------------------------------------------------------- doctor

export type FixedVerdict =
  | { level: "ok"; msg: string }
  | { level: "warn"; msg: string; fix: string };

/** Tamanhos das partes, por dia gravado (`AAAA-MM-DD`), somados nas pastas medidas. */
export type PartsHistory = Record<string, PartBytes>;

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const kbText = (bytes: number): string => `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
const ktokText = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/**
 * A parte que mais cresceu em bytes entre o retrato mais antigo que cai antes da janela recente e o atual.
 * Sem retrato antigo (a Hades só passou a gravar agora) ou sem crescimento: undefined.
 */
export function grownPart(history: PartsHistory, now: PartBytes, today: string): { part: Part; delta: number } | undefined {
  const cutoff = dayMs(today) - WINDOW_DAYS * MS_PER_DAY;
  const before = Object.keys(history)
    .filter((day) => dayMs(day) <= cutoff)
    .sort()
    .at(-1);
  const old = before === undefined ? undefined : history[before];
  if (old === undefined) return undefined;
  let best: { part: Part; delta: number } | undefined;
  for (const part of PARTS) {
    const delta = (now[part] ?? 0) - (old[part] ?? 0);
    if (delta > 0 && (best === undefined || delta > best.delta)) best = { part, delta };
  }
  return best;
}

/**
 * A linha `contexto-fixo` do doctor: a mediana dos últimos 7 dias contra a dos 7 anteriores (por dia da sessão, UTC).
 * Janela com menos de `MIN_SESSIONS_PER_WINDOW` sessões: estado neutro com o motivo, nunca aviso.
 */
export function judgeFixedContext(openings: Opening[], today: string, warnPct: number, partsNow?: PartBytes, history?: PartsHistory): FixedVerdict {
  const end = dayMs(today) + MS_PER_DAY;
  const recentFrom = end - WINDOW_DAYS * MS_PER_DAY;
  const priorFrom = recentFrom - WINDOW_DAYS * MS_PER_DAY;
  const recent = openings.filter((o) => dayMs(o.day) >= recentFrom && dayMs(o.day) < end).map((o) => o.ctx);
  const prior = openings.filter((o) => dayMs(o.day) >= priorFrom && dayMs(o.day) < recentFrom).map((o) => o.ctx);
  if (recent.length < MIN_SESSIONS_PER_WINDOW || prior.length < MIN_SESSIONS_PER_WINDOW) {
    return { level: "ok", msg: `contexto-fixo: sem dados suficientes para comparar (${recent.length} sessões nos últimos 7 dias e ${prior.length} nos 7 anteriores; mínimo ${MIN_SESSIONS_PER_WINDOW} em cada)` };
  }
  const nowMedian = median(recent) as number;
  const beforeMedian = median(prior) as number;
  const rise = beforeMedian > 0 ? (100 * (nowMedian - beforeMedian)) / beforeMedian : 0;
  const summary = `mediana ${ktokText(nowMedian)} nos últimos 7 dias contra ${ktokText(beforeMedian)} nos 7 anteriores (${rise >= 0 ? "+" : ""}${rise.toFixed(1).replace(".", ",")}%)`;
  if (rise <= warnPct) return { level: "ok", msg: `contexto-fixo: ${summary}, dentro do limite de ${warnPct}%` };
  const grown = partsNow && history ? grownPart(history, partsNow, today) : undefined;
  const which = grown ? `cresceu: ${PART_LABEL[grown.part]} (+${kbText(grown.delta)} em disco, estimativa)` : "parte não identificada: sem retrato dos tamanhos de uma semana atrás";
  return {
    level: "warn",
    msg: `contexto-fixo: o contexto do primeiro turno subiu: ${summary}; ${which}`,
    fix: "hades usage mostra a decomposição; enxugue a parte que cresceu (CLAUDE.md, MEMORY.md, skills) ou ajuste HADES_USAGE_BASELINE_WARN_PCT",
  };
}
