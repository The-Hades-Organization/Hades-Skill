// Regras da fila de gates (kit/gate/gate-lock.sh): ticket, custo por tipo, janela, admissão e histórico de picos.
// Tudo aqui é puro (sem disco, sem relógio, sem /proc): quem lê o estado da máquina é src/commands/gate-lock.ts.

export const EX_USAGE = 2;
export const EX_TEMPFAIL = 75;

export interface GateSpec {
  cost: number;
  heavy: boolean;
}

/** kind → custo (pico de PSS em GB) e se é pesado; undefined para kind desconhecido. */
export function specFor(kind: string): GateSpec | undefined {
  switch (kind) {
    case "lint":
      return { cost: 2, heavy: false };
    case "build":
      return { cost: 3, heavy: false };
    case "test":
    case "unit":
    case "test:unit":
      return { cost: 4, heavy: true };
    case "integration":
    case "test:integration":
    case "test-integration":
    case "gate":
      return { cost: 5, heavy: true };
    default:
      return undefined;
  }
}

/** Custo de um gate pesado a partir do qual qualquer kind vira pesado. */
export const HEAVY_COST_GB = 4;

/** Ticket: linhas `chave=valor`; a primeira ocorrência de cada chave vale (como o `sed | head -1` do bash). */
export type Ticket = ReadonlyMap<string, string>;

export function parseTicket(text: string): Ticket {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!fields.has(key)) fields.set(key, line.slice(eq + 1));
  }
  return fields;
}

export function field(ticket: Ticket, key: string): string {
  return ticket.get(key) ?? "";
}

/** Campo numérico do ticket; ausente ou não numérico conta 0, como a aritmética do bash. */
export function num(ticket: Ticket, key: string): number {
  const n = Number.parseInt(field(ticket, key), 10);
  return Number.isNaN(n) ? 0 : n;
}

export interface QueueEntry {
  /** Caminho do arquivo do ticket: a ordem de chegada é a ordem lexicográfica dele (prefixo = ns da chegada). */
  path: string;
  ticket: Ticket;
}

export interface GateLimits {
  budgetGb: number;
  heavyMax: number;
  parLint: number;
  parBuild: number;
  projectBudgetGb: number;
  reserveGb: number;
  psiMax: number;
}

export interface MachineState {
  /** Ocupação de wrappers do protocolo v1 (slots antigos ainda vivos). */
  legacyUsedGb: number;
  legacyHeavy: number;
  inWindow: boolean;
  window: string;
  availMb: number;
  psi: number;
}

/** O ticket `other` passa à frente de `mine`? Prioridade maior primeiro, depois ordem de chegada; pesado fora da janela não disputa a vez. */
function isAhead(other: QueueEntry, mine: QueueEntry, inWindow: boolean): boolean {
  if (field(other.ticket, "state") !== "waiting") return false;
  if (num(other.ticket, "heavy") > 0 && !inWindow) return false;
  const theirs = num(other.ticket, "prio");
  const ours = num(mine.ticket, "prio");
  if (theirs !== ours) return theirs > ours;
  return other.path < mine.path;
}

interface Running {
  usedGb: number;
  heavy: number;
  sameKind: number;
  sameStep: number;
  sameProjectGb: number;
  ahead: number;
}

function tally(queue: readonly QueueEntry[], mine: QueueEntry, state: MachineState): Running {
  const kind = field(mine.ticket, "kind");
  const step = field(mine.ticket, "step");
  const project = field(mine.ticket, "project");
  const totals: Running = { usedGb: state.legacyUsedGb, heavy: state.legacyHeavy, sameKind: 0, sameStep: 0, sameProjectGb: 0, ahead: 0 };
  for (const entry of queue) {
    const t = entry.ticket;
    if (field(t, "state") === "running") {
      totals.usedGb += num(t, "cost");
      totals.heavy += num(t, "heavy");
      if (field(t, "kind") === kind) totals.sameKind += 1;
      if (step !== "" && field(t, "step") === step) totals.sameStep += 1;
      if (field(t, "project") === project) totals.sameProjectGb += num(t, "cost");
    } else if (entry.path !== mine.path && isAhead(entry, mine, state.inWindow)) {
      totals.ahead += 1;
    }
  }
  return totals;
}

/** Motivo de o ticket `mine` ainda não entrar; null = entra agora. A ordem das checagens é a do original. */
export function admissionBlock(queue: readonly QueueEntry[], mine: QueueEntry, cost: number, heavy: boolean, limits: GateLimits, state: MachineState): string | null {
  const kind = field(mine.ticket, "kind");
  const step = field(mine.ticket, "step");
  const stepParallel = num(mine.ticket, "steppar");
  const running = tally(queue, mine, state);
  if (heavy && !state.inWindow) return `fora da janela de gates pesados (${state.window})`;
  if (running.ahead > 0) return `fila: ${running.ahead} gate(s) a frente`;
  if (heavy && running.heavy >= limits.heavyMax) return "ja ha gate pesado rodando";
  if ((kind === "lint" && limits.parLint > 0 && running.sameKind >= limits.parLint) || (kind === "build" && limits.parBuild > 0 && running.sameKind >= limits.parBuild)) {
    return `ja ha ${running.sameKind} ${kind} rodando (teto de paralelismo)`;
  }
  if (stepParallel > 0 && running.sameStep >= stepParallel) return `ja ha ${running.sameStep} de ${step} rodando (parallel da etapa)`;
  // Custo maior que o orçamento inteiro só entra com a máquina vazia de gates.
  if (running.usedGb > 0 && running.usedGb + cost > limits.budgetGb) return `orcamento: ${running.usedGb}+${cost} GB > ${limits.budgetGb} GB`;
  const project = field(mine.ticket, "project");
  if (limits.projectBudgetGb > 0 && running.sameProjectGb > 0 && running.sameProjectGb + cost > limits.projectBudgetGb) {
    return `orcamento do projeto ${project}: ${running.sameProjectGb}+${cost} GB > ${limits.projectBudgetGb} GB`;
  }
  const neededMb = (cost + limits.reserveGb) * 1024;
  if (state.availMb < neededMb) return `MemAvailable ${state.availMb} MB < ${neededMb} MB (custo ${cost} + reserva ${limits.reserveGb} GB)`;
  if (state.psi > limits.psiMax) return `pressao de memoria some avg10=${state.psi}% > ${limits.psiMax}%`;
  return null;
}

const WINDOW = /^(\d+):(\d+)-(\d+):(\d+)$/;

/** Minutos do dia de início e fim da janela `HH:MM-HH:MM`; undefined se malformada. */
export function parseWindow(window: string): [number, number] | undefined {
  const m = WINDOW.exec(window);
  if (!m) return undefined;
  const [, ah = "", am = "", bh = "", bm = ""] = m;
  return [Number(ah) * 60 + Number(am), Number(bh) * 60 + Number(bm)];
}

/** Dentro da janela (que pode virar a meia-noite)? Janela vazia = sempre. `minutes` = minutos desde 00:00 do relógio local do dono. */
export function inWindow(window: string, minutes: number): boolean {
  if (window === "") return true;
  const parsed = parseWindow(window);
  if (!parsed) throw new Error(`HADES_GATE_WINDOW invalida: '${window}' (use HH:MM-HH:MM)`);
  const [start, end] = parsed;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Chave estável de um passo para o histórico de duração: sem o prefixo `env VAR=...` nem o caminho do interpretador. */
export function normalizeCommand(argv: readonly string[]): string {
  const kept: string[] = [];
  let inEnv = false;
  for (const token of argv) {
    if (!inEnv && token === "env") {
      inEnv = true;
      continue;
    }
    if (inEnv && token.includes("=")) continue;
    inEnv = false;
    kept.push(token.slice(token.lastIndexOf("/") + 1));
  }
  return kept.join(" ").replace(/[\t\n]/g, " ").slice(0, 120);
}

const PEAK = /^peak=([0-9]+)MB$/;
const MB_PER_GB = 1024;
const MEASURED_WINDOW = 5;

interface Done {
  fields: string[];
}

function doneLines(journal: string): Done[] {
  const rows: Done[] = [];
  for (const line of journal.split("\n")) {
    const fields = line.split("\t");
    if (fields[1] === "done") rows.push({ fields });
  }
  return rows;
}

function lastPeakMb(fields: readonly string[]): number {
  let peak = 0;
  for (const f of fields.slice(2)) {
    const m = PEAK.exec(f);
    if (m) peak = Number(m[1]);
  }
  return peak;
}

/** Maior pico medido (MB → GB, para cima) das últimas 5 execuções da etapa; undefined se nunca medida. */
export function measuredCostGb(journal: string, step: string): number | undefined {
  const peaks: number[] = [];
  for (const { fields } of doneLines(journal)) {
    const peak = lastPeakMb(fields);
    if (fields.slice(2).includes(`step=${step}`) && peak > 0) peaks.push(peak);
  }
  const best = Math.max(0, ...peaks.slice(-MEASURED_WINDOW));
  return best > 0 ? Math.floor((best + MB_PER_GB - 1) / MB_PER_GB) : undefined;
}

/** Pico (MB) da última execução com o label no histórico; undefined se nunca foi medida. */
export function peakOfLabel(journal: string, label: string): number | undefined {
  let last: number | undefined;
  for (const { fields } of doneLines(journal)) {
    if (fields[3] !== label) continue;
    for (const f of fields.slice(2)) {
      const m = PEAK.exec(f);
      if (m) last = Number(m[1]);
    }
  }
  return last;
}

const DUR = /^dur=(\d+)s$/;

/** Mediana (s) das execuções concluídas do label no histórico; undefined sem histórico. */
export function typicalDurationS(journal: string, label: string): number | undefined {
  const durations: number[] = [];
  for (const { fields } of doneLines(journal)) {
    if (fields[3] !== label) continue;
    for (const f of fields.slice(2)) {
      const m = DUR.exec(f);
      if (m) durations.push(Number(m[1]));
    }
  }
  if (durations.length === 0) return undefined;
  durations.sort((a, b) => a - b);
  return durations[Math.floor(durations.length / 2)];
}

/** Tempo (s) a partir do qual um gate rodando é acusado: o maior entre o piso e `factor` vezes o tempo normal do label. */
export function gateOverrunLimitS(typicalS: number | undefined, overrunMin: number, factor: number): number {
  return Math.max(overrunMin * 60, typicalS === undefined ? 0 : typicalS * factor);
}

/** Aviso de gate rodando muito acima do normal (ticket `running` com `started=`); undefined se está dentro do limite. */
export function runningOverrun(ticket: Ticket, journal: string, nowS: number, overrunMin: number, factor: number): string | undefined {
  if (field(ticket, "state") !== "running") return undefined;
  const started = Number(field(ticket, "started"));
  if (!Number.isFinite(started) || started <= 0) return undefined;
  const typical = typicalDurationS(journal, field(ticket, "label"));
  const limit = gateOverrunLimitS(typical, overrunMin, factor);
  const elapsed = nowS - started;
  if (elapsed <= limit) return undefined;
  const normal = typical === undefined ? "sem histórico" : `normal ${Math.round(typical / 60)} min`;
  return `ESTOURO: rodando há ${Math.round(elapsed / 60)} min (${normal}; limite ${Math.round(limit / 60)} min)`;
}
