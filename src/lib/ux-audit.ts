// Auditoria de usabilidade recorrente (reference/ux-audit.md): os achados da crítica do Impeccable viram itens de trabalho
// em <raiz de trabalho>/_skill/ux-audit/<data>/items/<chave>.json. Aqui só regra e arquivo; o comando injeta a raiz.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isDir, isFile, readText } from "./fs.ts";

export const SEVERITIES = ["bloqueante", "alta", "media", "baixa"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const STATUSES = ["open", "issue", "resolved"] as const;
export type Status = (typeof STATUSES)[number];

export interface UxItem {
  /** chave estável: página + regra; é o nome do arquivo e o que impede o achado de se repetir */
  key: string;
  page: string;
  rule: string;
  severity: Severity;
  title: string;
  /** capturas (relativas à pasta da rodada) e linhas de evidência em texto */
  evidence: string[];
  fix: string;
  round: string;
  status: Status;
  /** URL da issue, quando o orquestrador encaminhou com --issues */
  issue?: string;
  /** voltou depois de resolvido numa rodada anterior */
  regression?: boolean;
}

export interface LastAudit {
  round: string;
  /** último commit que mexeu na UI do painel quando a rodada fechou */
  uiCommit: string;
}

/** Pasta do Impeccable instalado pelo dev: nunca vem no kit, o caminho sai de $HOME. */
export function impeccableDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.HADES_IMPECCABLE_DIR || join(home, ".claude", "skills", "impeccable");
}

export function impeccableInstalled(dir: string): boolean {
  return isFile(join(dir, "SKILL.md"));
}

export const IMPECCABLE_INSTALL_HINT =
  "o Impeccable não está instalado (a Hades não o empacota). Instale a skill do dev em ~/.claude/skills/impeccable " +
  "(https://github.com/pbakaus/impeccable, Apache-2.0) e rode de novo; o resto da Hades segue igual sem ele.";

export function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function itemKey(page: string, rule: string): string {
  const p = slug(page);
  const r = slug(rule);
  return p && r ? `${p}--${r}` : "";
}

export function isRoundName(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(-\d+)?$/.test(value);
}

export function roundDir(root: string, round: string): string {
  return join(root, round);
}

function parseItem(text: string | undefined): UxItem | undefined {
  if (text === undefined) return undefined;
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data !== "object" || data === null) return undefined;
    const o = data as Record<string, unknown>;
    if (typeof o.key !== "string" || typeof o.page !== "string" || typeof o.rule !== "string") return undefined;
    if (!SEVERITIES.includes(o.severity as Severity) || !STATUSES.includes(o.status as Status)) return undefined;
    return {
      key: o.key,
      page: o.page,
      rule: o.rule,
      severity: o.severity as Severity,
      title: typeof o.title === "string" ? o.title : "",
      evidence: Array.isArray(o.evidence) ? o.evidence.filter((e): e is string => typeof e === "string") : [],
      fix: typeof o.fix === "string" ? o.fix : "",
      round: typeof o.round === "string" ? o.round : "",
      status: o.status as Status,
      ...(typeof o.issue === "string" ? { issue: o.issue } : {}),
      ...(o.regression === true ? { regression: true } : {}),
    };
  } catch {
    return undefined;
  }
}

export function rounds(root: string): string[] {
  if (!isDir(root)) return [];
  return readdirSync(root).filter((n) => isRoundName(n) && isDir(join(root, n))).sort();
}

export function roundItems(root: string, round: string): UxItem[] {
  const dir = join(root, round, "items");
  if (!isDir(dir)) return [];
  const items: UxItem[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const item = parseItem(readText(join(dir, name)));
    if (item) items.push(item);
  }
  return items;
}

/** A versão mais recente de cada chave, olhando todas as rodadas (a mais nova vence). */
export function latestByKey(root: string): Map<string, UxItem> {
  const map = new Map<string, UxItem>();
  for (const round of rounds(root)) for (const item of roundItems(root, round)) map.set(item.key, item);
  return map;
}

/** Rodada de hoje: `<data>`, ou `<data>-<n>` quando já existe uma fechada no mesmo dia. */
export function newRound(root: string, today: string): string {
  const taken = new Set(rounds(root));
  let name = today;
  for (let n = 2; taken.has(name); n += 1) name = `${today}-${n}`;
  mkdirSync(join(root, name, "items"), { recursive: true });
  mkdirSync(join(root, name, "capturas"), { recursive: true });
  return name;
}

export type AddResult =
  | { kind: "added"; item: UxItem }
  | { kind: "duplicate"; key: string; round: string; status: Status }
  | { kind: "invalid"; reason: string };

export interface AddInput {
  page: string;
  rule: string;
  severity: string;
  title: string;
  fix: string;
  evidence: string[];
}

function saveItem(root: string, item: UxItem): void {
  const file = join(root, item.round, "items", `${item.key}.json`);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(item, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * Grava um achado na rodada. Chave já registrada (qualquer rodada) não se repete, exceto a resolvida que voltou:
 * essa entra de novo marcada como regressão. Capturas existentes são copiadas para <rodada>/capturas.
 */
export function addItem(root: string, round: string, input: AddInput): AddResult {
  const key = itemKey(input.page, input.rule);
  if (!key) return { kind: "invalid", reason: "página e regra precisam ter ao menos uma letra ou número" };
  if (!SEVERITIES.includes(input.severity as Severity)) return { kind: "invalid", reason: `severidade: ${SEVERITIES.join("|")}` };
  if (!input.title.trim()) return { kind: "invalid", reason: "título vazio" };
  if (!isDir(join(root, round))) return { kind: "invalid", reason: `rodada ${round} não existe (ux-audit start)` };
  const known = latestByKey(root).get(key);
  if (known && known.status !== "resolved") return { kind: "duplicate", key, round: known.round, status: known.status };
  if (known && known.round === round) return { kind: "duplicate", key, round, status: known.status };
  const evidence = input.evidence.map((e) => {
    if (!existsSync(e) || !isFile(e)) return e;
    const target = join(root, round, "capturas", basename(e));
    if (e !== target) copyFileSync(e, target);
    return join("capturas", basename(e));
  });
  const item: UxItem = {
    key,
    page: input.page,
    rule: input.rule,
    severity: input.severity as Severity,
    title: input.title.trim(),
    evidence,
    fix: input.fix.trim(),
    round,
    status: "open",
    ...(known ? { regression: true } : {}),
  };
  saveItem(root, item);
  return { kind: "added", item };
}

export function setStatus(root: string, key: string, status: Status, issue?: string): UxItem | undefined {
  const item = latestByKey(root).get(key);
  if (!item) return undefined;
  const next: UxItem = { ...item, status, ...(issue ? { issue } : {}) };
  saveItem(root, next);
  return next;
}

const SEVERITY_ORDER = new Map<string, number>(SEVERITIES.map((s, i) => [s, i]));

export function sortItems(items: UxItem[]): UxItem[] {
  return [...items].sort(
    (a, b) => (SEVERITY_ORDER.get(a.severity) ?? 9) - (SEVERITY_ORDER.get(b.severity) ?? 9) || a.page.localeCompare(b.page) || a.key.localeCompare(b.key),
  );
}

export function issueDraft(item: UxItem, round: string): { title: string; body: string } {
  const evidence = item.evidence.length ? item.evidence.map((e) => `- ${e}`).join("\n") : "- (sem captura)";
  const body = [
    `Achado da auditoria de usabilidade (rodada ${round}), regra \`${item.rule}\` na página \`${item.page}\`. Severidade: ${item.severity}.`,
    "",
    "**Evidência**",
    evidence,
    "",
    "**Correção proposta**",
    item.fix || "(a definir)",
    "",
    `Chave estável: \`${item.key}\``,
  ].join("\n");
  return { title: `[ux-audit] ${item.title}`, body };
}

const LAST_FILE = "last.json";

export function readLast(root: string): LastAudit | undefined {
  const text = readText(join(root, LAST_FILE));
  if (text === undefined) return undefined;
  try {
    const o: unknown = JSON.parse(text);
    if (typeof o !== "object" || o === null) return undefined;
    const r = o as Record<string, unknown>;
    return typeof r.round === "string" && typeof r.uiCommit === "string" ? { round: r.round, uiCommit: r.uiCommit } : undefined;
  } catch {
    return undefined;
  }
}

export function writeLast(root: string, last: LastAudit): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${LAST_FILE}.tmp`), `${JSON.stringify(last, null, 2)}\n`);
  renameSync(join(root, `${LAST_FILE}.tmp`), join(root, LAST_FILE));
}

export const REMINDER_MODES = ["off", "release"] as const;

/**
 * Lembrete do skill-release: a UI do painel mudou desde a última auditoria fechada. Só texto, nunca roda a auditoria.
 * `uiCommit` vazio (sem git) ou modo `off` ficam calados.
 */
export function reminderText(mode: string, uiCommit: string, last: LastAudit | undefined): string | undefined {
  if (mode !== "release" || !uiCommit) return undefined;
  if (!last) return "lembrete: o painel e o Argos ainda não passaram por auditoria de usabilidade (hades ux-audit start; reference/ux-audit.md)";
  if (last.uiCommit === uiCommit) return undefined;
  return `lembrete: a UI do painel mudou desde a auditoria de usabilidade de ${last.round} (hades ux-audit start; reference/ux-audit.md)`;
}
