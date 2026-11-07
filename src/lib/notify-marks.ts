// O que o vigia de notificações já avisou de cada PR (CI vermelho e review novo). Estado em $D/notify/pr-marks.json: o
// install.sh nunca toca em notify/. A identidade do evento decide se avisa, não a janela HADES_NOTIFY_DEDUPE_MIN nem o
// `forget` do dedupe: a marca vive até a PR sumir da lista do coletor (fechou, mergeou) ou, no CI, até o head mudar.
// `planPrNotices` é pura; ler e gravar o arquivo fica em loadMarks/saveMarks. Um só escritor: o vigia da instância.
import { mkdirSync } from "node:fs";
import { jload, jsave, type NotifyContext } from "./notify.ts";

/** Tolerância para a PR faltar na lista (busca do GitHub falha de passagem) antes da marca expirar. */
export const MARK_GRACE_S = 3600;
const HOUR_S = 3600;
const MAX_NAMES = 200;
const MAX_COMMENT_IDS = 200;
const UNNAMED_CHECK = "(sem nome)";

export interface CheckLabel {
  name?: string | undefined;
  url?: string | null | undefined;
}

/** O que o vigia lê de uma PR do coletor (`hades pr-loop-state --json`). */
export interface PrSnapshot {
  number: number;
  headRefOid: string;
  checks: { failing: CheckLabel[] };
  live: readonly unknown[];
  topLevelLive: ReadonlyArray<{ commentId?: number | null | undefined }>;
  unseenReviewSincePush: boolean;
  lastReviewAt: string | null | undefined;
}

export interface CiMark {
  head: string;
  /** Checks que já geraram aviso neste head (união: o rerun que falha de novo no mesmo check não reavisa). */
  names: string[];
  /** Primeiro aviso de CI vermelho neste head, em segundos. */
  since: number;
  /** Último aviso ou lembrete, em segundos. */
  at: number;
}

export interface ReviewMark {
  /** `lastReviewAt` do review já avisado. */
  at: string;
  topIds: number[];
}

export interface PrMark {
  /** Último ciclo em que a PR apareceu na lista, em segundos. */
  seen: number;
  ci?: CiMark;
  review?: ReviewMark;
}
export type PrMarks = Record<string, PrMark>;

export interface PrEvent {
  event: "ci" | "pr";
  severity: "error" | "warn";
  obj: string;
  text: string;
  sig: string;
  number: number;
  /** A marca que passa a valer quando o aviso sai (ou já tinha saído na janela). */
  ack: { ci: CiMark } | { review: ReviewMark };
}

export interface PlanOptions {
  /** Segundos desde a época, do relógio injetado. */
  now: number;
  /** Horas de CI vermelho até o lembrete; 0 = desligado. */
  remindHours: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

// ---------------------------------------------------------------- fronteira: o que vem do coletor e do arquivo
export function toSnapshot(raw: unknown): PrSnapshot | undefined {
  if (!isRecord(raw) || typeof raw.number !== "number") return undefined;
  const checks = isRecord(raw.checks) ? raw.checks : {};
  return {
    number: raw.number,
    headRefOid: asText(raw.headRefOid) ?? "",
    checks: { failing: asArray(checks.failing).map((label) => (isRecord(label) ? { name: asText(label.name), url: asText(label.url) ?? null } : {})) },
    live: asArray(raw.live),
    topLevelLive: asArray(raw.topLevelLive).map((c) => ({ commentId: isRecord(c) && typeof c.commentId === "number" ? c.commentId : null })),
    unseenReviewSincePush: raw.unseenReviewSincePush === true,
    lastReviewAt: asText(raw.lastReviewAt) ?? null,
  };
}

const toCiMark = (value: unknown): CiMark | undefined => {
  if (!isRecord(value) || typeof value.head !== "string" || typeof value.since !== "number" || typeof value.at !== "number") return undefined;
  return { head: value.head, names: asArray(value.names).filter((n): n is string => typeof n === "string"), since: value.since, at: value.at };
};

const toReviewMark = (value: unknown): ReviewMark | undefined => {
  if (!isRecord(value) || typeof value.at !== "string") return undefined;
  return { at: value.at, topIds: asArray(value.topIds).filter((n): n is number => typeof n === "number") };
};

/** Arquivo corrompido ou de outra versão: o que não casa com o formato é descartado (a PR volta a avisar uma vez). */
export function sanitizeMarks(value: unknown): PrMarks {
  const marks: PrMarks = {};
  if (!isRecord(value)) return marks;
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.seen !== "number") continue;
    const ci = toCiMark(raw.ci);
    const review = toReviewMark(raw.review);
    marks[key] = { seen: raw.seen, ...(ci ? { ci } : {}), ...(review ? { review } : {}) };
  }
  return marks;
}

export const loadMarks = (ctx: NotifyContext): PrMarks => sanitizeMarks(jload<unknown>(ctx.marks, {}));

export function saveMarks(ctx: NotifyContext, marks: PrMarks): void {
  mkdirSync(ctx.state, { recursive: true });
  jsave(ctx.marks, marks);
}

// ---------------------------------------------------------------- decisão (pura)
const failingNames = (pr: PrSnapshot): string[] =>
  [...new Set(pr.checks.failing.map((c) => c.name ?? c.url ?? UNNAMED_CHECK))].sort();

/** `mark` é a do head atual: head novo chega aqui sem marca. */
function planCi(pr: PrSnapshot, mark: CiMark | undefined, options: PlanOptions): PrEvent | undefined {
  const names = failingNames(pr);
  if (names.length === 0) return undefined;
  const obj = `PR #${pr.number} CI`;
  const known = mark?.names ?? [];
  if (names.some((name) => !known.includes(name))) {
    const ci: CiMark = { head: pr.headRefOid, names: [...new Set([...known, ...names])].slice(-MAX_NAMES), since: mark?.since ?? options.now, at: options.now };
    return { event: "ci", severity: "error", obj, text: "CI vermelho", sig: `${pr.headRefOid}|${names.join(",")}`, number: pr.number, ack: { ci } };
  }
  if (!mark || options.remindHours <= 0 || options.now - mark.at < options.remindHours * HOUR_S) return undefined;
  const hours = Math.floor((options.now - mark.since) / HOUR_S);
  const text = `Lembrete: segue vermelho há ${hours} h (não é falha nova)`;
  return { event: "ci", severity: "error", obj, text, sig: `${pr.headRefOid}|lembrete|${mark.at}`, number: pr.number, ack: { ci: { ...mark, at: options.now } } };
}

function planReview(pr: PrSnapshot, mark: ReviewMark | undefined): PrEvent | undefined {
  const pending = pr.live.length > 0 || pr.topLevelLive.length > 0 || pr.unseenReviewSincePush;
  if (!pending) return undefined;
  const at = pr.lastReviewAt ?? "";
  const known = new Set(mark?.topIds ?? []);
  const newIds = pr.topLevelLive.flatMap((c) => (typeof c.commentId === "number" && !known.has(c.commentId) ? [c.commentId] : []));
  // Identidade do review, não a contagem de threads vivas: responder ou resolver thread não é review novo.
  if (mark && mark.at === at && newIds.length === 0) return undefined;
  const review: ReviewMark = { at, topIds: [...(mark?.topIds ?? []), ...newIds].slice(-MAX_COMMENT_IDS) };
  return { event: "pr", severity: "warn", obj: `PR #${pr.number} review`, text: "review novo para tratar", sig: `${at}|${newIds.join(",")}`, number: pr.number, ack: { review } };
}

/** Decide o que avisar. `marks` devolvido já traz a expiração (PR ausente além da tolerância, head novo no CI); a marca de
 * cada evento só entra com `ackMark`, depois que o aviso saiu. */
export function planPrNotices(prs: readonly PrSnapshot[], marks: PrMarks, options: PlanOptions): { marks: PrMarks; events: PrEvent[] } {
  const present = new Set(prs.map((pr) => String(pr.number)));
  const next: PrMarks = {};
  for (const [key, mark] of Object.entries(marks)) {
    if (!present.has(key) && options.now - mark.seen <= MARK_GRACE_S) next[key] = mark;
  }
  const events: PrEvent[] = [];
  for (const pr of prs) {
    const key = String(pr.number);
    const prev = marks[key];
    const ci = prev?.ci?.head === pr.headRefOid ? prev.ci : undefined;
    next[key] = { seen: options.now, ...(ci ? { ci } : {}), ...(prev?.review ? { review: prev.review } : {}) };
    for (const event of [planCi(pr, ci, options), planReview(pr, prev?.review)]) {
      if (event) events.push(event);
    }
  }
  return { marks: next, events };
}

export const ackMark = (marks: PrMarks, event: PrEvent): PrMarks => {
  const key = String(event.number);
  const current = marks[key];
  return current ? { ...marks, [key]: { ...current, ...event.ack } } : marks;
};
