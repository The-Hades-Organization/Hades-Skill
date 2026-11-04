// Loop de revisão (`hades review --loop`): as regras, todas puras. Disco, gh, relógio e processo entram pelas bordas
// (review-loop-store.ts, commands/review-loop.ts), que passam o que estas funções pedem. Fluxo: reference/loop/review.md §7.
import { JANELAS, ROTULO, type Atual, type Janela } from "./limites.ts";

const MS_MINUTE = 60_000;
const MS_HOUR = 3_600_000;
const MIN_EVERY_MS = MS_MINUTE;
const MAX_EVERY_MS = 24 * MS_HOUR;
const MAX_PR_NUMBER = 10_000_000;
const MINUTES_PER_DAY = 1440;
const SHORT_OID = 8;

export type Severity = "red" | "yellow";

/** Achado que o revisor devolve na linha `HADES-ACHADO`; `file` e `code` formam a identidade dele entre heads. */
export interface Finding {
  sev: Severity;
  code: string;
  file: string;
  line: number;
}

export interface LoopOptions {
  everyMs: number;
  author: string | undefined;
  prs: number[];
  max: number | undefined;
  deep: boolean;
  untilMs: number | undefined;
  rounds: number | undefined;
  post: boolean;
  dryRun: boolean;
  note: string | undefined;
  wt: string | undefined;
}

export class LoopArgError extends Error {}

/** `30m`, `2h`, `1d`: o piso é 1 min (a rodada inclui `gh` e fila) e o teto 24 h. */
export function parseEvery(text: string): number {
  const m = /^(\d+)([mhd])$/.exec(text);
  if (m === null) throw new LoopArgError(`--every: '${text}' não é uma duração (use 30m, 2h, 1d)`);
  const unit = { m: MS_MINUTE, h: MS_HOUR, d: 24 * MS_HOUR }[m[2] as "m" | "h" | "d"];
  const ms = Number(m[1]) * unit;
  if (ms < MIN_EVERY_MS || ms > MAX_EVERY_MS) throw new LoopArgError(`--every: '${text}' fora de 1m..24h`);
  return ms;
}

/**
 * `--until`: um instante ISO com fuso (`2026-11-04T18:00:00Z`) ou `HH:MM` no fuso do dono, que chega como parâmetro
 * (`offsetMin` = minutos a leste de UTC). `HH:MM` já passada hoje vale amanhã.
 */
export function parseUntil(text: string, now: Date, offsetMin: number): number {
  const clock = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (clock !== null) {
    const localNow = now.getTime() + offsetMin * MS_MINUTE;
    const dayStart = localNow - (((localNow % (24 * MS_HOUR)) + 24 * MS_HOUR) % (24 * MS_HOUR));
    let target = dayStart + (Number(clock[1]) * 60 + Number(clock[2])) * MS_MINUTE - offsetMin * MS_MINUTE;
    if (target <= now.getTime()) target += 24 * MS_HOUR;
    return target;
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) throw new LoopArgError(`--until: '${text}' precisa de HH:MM ou de um instante ISO com fuso (Z ou ±hh:mm)`);
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new LoopArgError(`--until: '${text}' não é uma data válida`);
  return ms;
}

function positiveInt(flag: string, text: string, ceiling: number): number {
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > ceiling) throw new LoopArgError(`${flag}: '${text}' fora de 1..${ceiling}`);
  return Number(text);
}

const VALUED = ["--every", "--author", "--pr", "--max", "--until", "--rounds", "--note", "--wt"];

/** `defaultEveryMin` vem da configuração (HADES_REVIEW_LOOP_EVERY_MIN); `--loop` já foi consumido por quem roteou. */
export function parseLoopArgs(args: string[], now: Date, offsetMin: number, defaultEveryMin: number): LoopOptions {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const raw = args[i] ?? "";
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    if (flag === "--loop") continue;
    if (flag === "--deep" || flag === "--dry-run" || flag === "--no-post") flags.add(flag);
    else if (VALUED.includes(flag)) {
      const value = eq > 0 ? raw.slice(eq + 1) : args[++i];
      if (value === undefined || value.startsWith("--")) throw new LoopArgError(`${flag}: faltou o valor`);
      values.set(flag, [...(values.get(flag) ?? []), value]);
    } else throw new LoopArgError(`argumento desconhecido: ${raw}`);
  }
  const one = (flag: string): string | undefined => values.get(flag)?.at(-1);
  const author = one("--author");
  const prs = (values.get("--pr") ?? []).map((p) => positiveInt("--pr", p, MAX_PR_NUMBER));
  if (author !== undefined && prs.length > 0) throw new LoopArgError("--author e --pr não se combinam: o escopo é um ou outro");
  if (author !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(author)) throw new LoopArgError(`--author: '${author}' não é um login do GitHub`);
  const every = one("--every");
  const until = one("--until");
  const rounds = one("--rounds");
  const max = one("--max");
  return {
    everyMs: every === undefined ? defaultEveryMin * MS_MINUTE : parseEvery(every),
    author,
    prs: [...new Set(prs)],
    max: max === undefined ? undefined : positiveInt("--max", max, MAX_PR_NUMBER),
    deep: flags.has("--deep"),
    untilMs: until === undefined ? undefined : parseUntil(until, now, offsetMin),
    rounds: rounds === undefined ? undefined : positiveInt("--rounds", rounds, MINUTES_PER_DAY),
    post: !flags.has("--no-post"),
    dryRun: flags.has("--dry-run"),
    note: one("--note"),
    wt: one("--wt"),
  };
}

// ------------------------------------------------------------------ achados

/** Linha `HADES-ACHADO: <red|yellow>|<aberto|novo>|<codigo>|<arquivo>|<linha>`: o que o revisor deixa em pé no head. */
const FINDING_LINE = /^HADES-ACHADO:\s*(red|yellow)\|(?:aberto|novo)\|([^|\n]+)\|([^|\n]+)\|(\d+)\s*$/gm;

export function parseFindings(text: string): Finding[] {
  const found = new Map<string, Finding>();
  for (const m of text.matchAll(FINDING_LINE)) {
    const finding: Finding = { sev: m[1] as Severity, code: (m[2] ?? "").trim(), file: (m[3] ?? "").trim(), line: Number(m[4]) };
    found.set(findingKey(finding), finding);
  }
  return [...found.values()];
}

/** A linha anda entre heads; código da regra e arquivo identificam o achado. */
export const findingKey = (f: Pick<Finding, "code" | "file">): string => `${f.code}|${f.file}`;

/** Em pé agora e que o review anterior ainda não tinha: o que pode ser postado e o que merece aviso. */
export function newFindings(previousOpen: readonly Finding[], current: readonly Finding[]): Finding[] {
  const known = new Set(previousOpen.map(findingKey));
  return current.filter((f) => !known.has(findingKey(f)));
}

export const blockingOf = (findings: readonly Finding[]): Finding[] => findings.filter((f) => f.sev === "red");

/** Valida na fronteira um achado vindo de JSON (registro da revisão, estado da PR). */
export function asFinding(value: unknown): Finding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { sev, code, file, line } = value as Record<string, unknown>;
  if ((sev !== "red" && sev !== "yellow") || typeof code !== "string" || typeof file !== "string" || typeof line !== "number") return undefined;
  return { sev, code, file, line };
}

/** Os achados válidos de uma lista vinda de JSON; o que não passa na validação sai. */
export const asFindings = (list: unknown[]): Finding[] => list.flatMap((item) => {
  const finding = asFinding(item);
  return finding === undefined ? [] : [finding];
});

/** Regra de saída que toda revisão do loop recebe: é por estas linhas que o loop sabe o que ficou em pé no head. */
export const LOOP_FINDINGS_RULE = `Antes da linha \`HADES-REVIEW:\`, escreva uma linha por achado que continua em pé no head (novo ou já aberto):
\`HADES-ACHADO: <red|yellow>|<aberto|novo>|<codigo>|<arquivo>|<linha>\` (red = bloqueante, yellow = ajuste).`;

/** Seção do prompt com o que já foi reportado e não pode voltar ao GitHub; vazia na primeira revisão da PR. */
export function priorContext(previous: PrState | undefined): string {
  if (previous === undefined || previous.open.length === 0) return "";
  const lines = previous.open.map((f) => `- ${f.sev === "red" ? "🔴" : "🟡"} \`${f.code}\` ${f.file}:${f.line}`);
  const where = previous.reviewUrl === undefined ? "" : ` (${previous.reviewUrl})`;
  return `Achados já reportados e ainda abertos (loop de revisão). O review anterior, no head \`${previous.headOid.slice(0, SHORT_OID)}\`${where}, deixou:
${lines.join("\n")}
Para cada um, confira no head atual. Resolvido: não o cite. Ainda presente: NÃO o publique de novo (nem in-line, nem no
resumo): ele já está na PR. Publique só achado NOVO. Sem achado novo e com abertos, não publique review (feche com
\`posted=no\`) e diga isso no relatório. Sem achado novo e sem abertos: review curto, \`✅ aprovado\`.`;
}

// ------------------------------------------------------------------ estado e decisão da rodada

/** O que a rodada seguinte precisa saber de uma PR (guardado em `<work>/review-loop/pr-<n>.json`, nunca no repo). */
export interface PrState {
  pr: number;
  headOid: string;
  reviewedAt: string;
  reviewUrl: string | undefined;
  verdict: string | undefined;
  open: Finding[];
}

export interface Candidate {
  number: number;
  headOid: string;
  isDraft: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  author: string;
  title: string;
}

export type SkipReason = "head-igual" | "lock" | "propria" | "rascunho" | "fora-do-escopo" | "adiada";
export type Decision =
  | { pr: number; action: "revisar"; headOid: string; why: "head-novo" | "nunca-revisada" }
  | { pr: number; action: "pular"; reason: SkipReason; detail?: string };

export const SKIP_TEXT: Record<SkipReason, string> = {
  "head-igual": "head igual ao último revisado",
  lock: "outra sessão tem o lock da PR",
  propria: "PR minha (assunto do inbox)",
  rascunho: "rascunho (só entra se pedida com --pr)",
  "fora-do-escopo": "fechada ou mergeada",
  adiada: "além do --max desta rodada",
};

export interface PlanInput {
  candidates: readonly Candidate[];
  states: ReadonlyMap<number, PrState>;
  /** PR → texto do dono do lock, quando outra sessão a tem. */
  locked: ReadonlyMap<number, string>;
  me: string;
  /** `--pr` explícito: rascunho entra. */
  explicit: ReadonlySet<number>;
  max: number | undefined;
}

/** Quem a rodada revisa e quem pula com o motivo; ordem por número da PR (determinística). `--max` adia o excedente. */
export function planRound(input: PlanInput): Decision[] {
  const decisions: Decision[] = [];
  let toReview = 0;
  for (const c of [...input.candidates].sort((a, b) => a.number - b.number)) {
    const skip = (reason: SkipReason, detail?: string): void => {
      decisions.push({ pr: c.number, action: "pular", reason, ...(detail === undefined ? {} : { detail }) });
    };
    const previous = input.states.get(c.number);
    if (c.state !== "OPEN") skip("fora-do-escopo");
    else if (c.author === input.me) skip("propria");
    else if (c.isDraft && !input.explicit.has(c.number)) skip("rascunho");
    else if (previous?.headOid === c.headOid) skip("head-igual");
    else if (input.locked.has(c.number)) skip("lock", input.locked.get(c.number));
    else if (input.max !== undefined && toReview >= input.max) skip("adiada");
    else {
      toReview++;
      decisions.push({ pr: c.number, action: "revisar", headOid: c.headOid, why: previous === undefined ? "nunca-revisada" : "head-novo" });
    }
  }
  return decisions;
}

/** Escopo vazio = nenhuma PR aberta nele (todas mergeadas ou fechadas, ou a busca veio vazia). */
export const scopeEmpty = (candidates: readonly Candidate[]): boolean => !candidates.some((c) => c.state === "OPEN");

// ------------------------------------------------------------------ limite de uso e parada

export interface Pause {
  janela: Janela;
  pct: number;
  limiar: number;
  resetsAt: number;
}

/** Janelas medidas que passaram do limiar de pausa; vazio = pode rodar. Sem medida de uma janela, ela não pausa. */
export function limitsReached(atual: Partial<Record<Janela, Pick<Atual, "pct" | "resetsAt">>>, limiars: Record<Janela, number>): Pause[] {
  return JANELAS.flatMap((janela): Pause[] => {
    const a = atual[janela];
    const limiar = limiars[janela];
    return a !== undefined && a.pct >= limiar ? [{ janela, pct: Math.floor(a.pct), limiar, resetsAt: a.resetsAt }] : [];
  });
}

export const pauseText = (p: Pause): string => `janela de ${ROTULO[p.janela]} em ${p.pct}% (limiar ${p.limiar}%)`;

export type StopReason = "rodadas" | "ate" | "comando" | "escopo-vazio";
export const STOP_TEXT: Record<StopReason, string> = {
  rodadas: "atingiu --rounds",
  ate: "passou do --until",
  comando: "parada pelo comando `hades review loop stop`",
  "escopo-vazio": "escopo vazio: nenhuma PR aberta",
};

/** Parada decidida entre rodadas (o escopo vazio é decidido na rodada, depois da busca). */
export function stopBefore(opts: Pick<LoopOptions, "rounds" | "untilMs">, roundsDone: number, now: Date, stopRequested: boolean): StopReason | undefined {
  if (stopRequested) return "comando";
  if (opts.rounds !== undefined && roundsDone >= opts.rounds) return "rodadas";
  if (opts.untilMs !== undefined && now.getTime() >= opts.untilMs) return "ate";
  return undefined;
}

// ------------------------------------------------------------------ registro da rodada

export interface RoundRecord {
  round: number;
  id: string;
  startedAt: string;
  endedAt: string;
  outcome: "revisada" | "sem-mudanca" | "pausada" | "escopo-vazio" | "erro";
  reviewed: { pr: number; headOid: string; state: string; recordId: string; blocking: number; costUsd: number }[];
  skipped: { pr: number; reason: SkipReason }[];
  costUsd: number;
  tokens: number;
  /** % usado de cada janela antes e depois da rodada, quando há medida. */
  usage: Partial<Record<Janela, { before: number; after: number | undefined }>>;
}

const usd = (n: number): string => `US$ ${n.toFixed(2)}`;

/** Resumo da rodada para a nota do canvas e o log. */
export function roundSummary(r: RoundRecord): string {
  const head = `## Rodada ${r.round} — ${r.startedAt.slice(0, 16).replace("T", " ")}Z · ${r.outcome}`;
  const reviewed = r.reviewed.map((p) => `- #${p.pr} @ ${p.headOid.slice(0, SHORT_OID)}: ${p.state}, ${p.blocking} bloqueante(s) novo(s), ${usd(p.costUsd)}`);
  const skipped = r.skipped.map((p) => `- #${p.pr} pulada: ${SKIP_TEXT[p.reason]}`);
  const windows = JANELAS.flatMap((j) => {
    const u = r.usage[j];
    return u === undefined ? [] : [`${ROTULO[j]} ${u.before}%→${u.after ?? "?"}%`];
  });
  const cost = r.reviewed.length > 0 ? `Consumo estimado: ${usd(r.costUsd)} · ${r.tokens} tokens${windows.length > 0 ? ` · ${windows.join(" · ")}` : ""}` : "";
  return [head, ...reviewed, ...skipped, cost].filter((l) => l !== "").join("\n");
}
