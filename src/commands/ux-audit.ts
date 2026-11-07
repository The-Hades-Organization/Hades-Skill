// `hades ux-audit`: auditoria de usabilidade recorrente do painel e do Argos com o Impeccable (reference/ux-audit.md).
// Quem audita é o agente do papel `ux-audit` (roles/ux-audit.md); este comando guarda os achados como itens de trabalho
// e os encaminha. Sem o Impeccable instalado, `start` recusa com o jeito de instalar e nada mais da Hades muda.
import { join } from "node:path";
import { workRoot } from "../lib/cerberus.ts";
import { EXIT, die, out, warn } from "../lib/output.ts";
import { home, skillRoot } from "../lib/paths.ts";
import { run } from "../lib/proc.ts";
import { configValue } from "../lib/work.ts";
import {
  IMPECCABLE_INSTALL_HINT, REMINDER_MODES, SEVERITIES, STATUSES, addItem, impeccableDir, impeccableInstalled, isRoundName, issueDraft,
  latestByKey, newRound, readLast, reminderText, roundItems, rounds, setStatus, sortItems, writeLast, type Status, type UxItem,
} from "../lib/ux-audit.ts";

export const USAGE = `Auditoria de usabilidade do painel e do Argos com o Impeccable (reference/ux-audit.md).
Uso: hades ux-audit start [--json]
     hades ux-audit add --round <rodada> --page <página> --rule <regra> --severity ${SEVERITIES.join("|")} --title <texto>
                        [--fix <texto>] [--evidence <captura|texto>]… [--json]
     hades ux-audit list [--round <rodada>] [--status ${STATUSES.join("|")}|all] [--json]
     hades ux-audit forward [--round <rodada>] [--issues [--repo <dono/nome>]] [--json]
     hades ux-audit resolve <chave> [--json]
     hades ux-audit done --round <rodada>
     hades ux-audit reminder
  start     confere o Impeccable e abre a rodada de hoje; imprime o nome da rodada e a pasta
  add       grava um achado; chave (página + regra) já registrada em rodada anterior não se repete (sai 0, "repetido")
  list      itens por severidade; sem --round, o último estado de cada chave em todas as rodadas (abertos por padrão)
  forward   mostra o rascunho de issue de cada item aberto; só --issues abre as issues (conta e repositório da org)
  resolve   marca o item como resolvido (se voltar numa rodada futura, entra de novo como regressão)
  done      fecha a rodada: grava o último commit da UI do painel, que o lembrete do skill-release compara
  reminder  imprime o lembrete do skill-release, se houver (chave HADES_UX_AUDIT_REMINDER)`;

const ISSUE_TIMEOUT_MS = 60_000;
const UI_PATH = "kit/panel/ui";

interface Parsed {
  positional: string[];
  json: boolean;
  issues: boolean;
  evidence: string[];
  values: Map<string, string>;
}

const VALUE_FLAGS = new Set(["--round", "--page", "--rule", "--severity", "--title", "--fix", "--status", "--repo"]);

function parse(args: string[]): Parsed {
  const parsed: Parsed = { positional: [], json: false, issues: false, evidence: [], values: new Map() };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--json") parsed.json = true;
    else if (arg === "--issues") parsed.issues = true;
    else if (arg === "--evidence" || VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined) die(`${arg} exige um valor\n${USAGE}`);
      i += 1;
      if (arg === "--evidence") parsed.evidence.push(value);
      else parsed.values.set(arg, value);
    } else if (arg.startsWith("--")) die(`opção desconhecida: ${arg}\n${USAGE}`);
    else parsed.positional.push(arg);
  }
  return parsed;
}

function root(): string {
  return join(workRoot(), "_skill", "ux-audit");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function roundArg(p: Parsed): string {
  const round = p.values.get("--round") ?? "";
  if (!isRoundName(round)) die(`--round <rodada> é obrigatório (o nome que o start imprimiu)\n${USAGE}`);
  return round;
}

function need(p: Parsed, flag: string): string {
  const value = p.values.get(flag);
  if (!value) die(`${flag} é obrigatório\n${USAGE}`);
  return value;
}

function requireImpeccable(): number | undefined {
  const dir = impeccableDir(home());
  if (impeccableInstalled(dir)) return undefined;
  warn(IMPECCABLE_INSTALL_HINT);
  return EXIT.missingDependency;
}

function line(item: UxItem): string {
  const mark = item.regression ? " (regressão)" : "";
  return `${item.severity.padEnd(10)} ${item.page}  ${item.rule}  ${item.title}${mark}  [${item.status}${item.issue ? ` ${item.issue}` : ""}] ${item.key}`;
}

function start(p: Parsed): number {
  const missing = requireImpeccable();
  if (missing !== undefined) return missing;
  const base = root();
  const round = newRound(base, today());
  const dir = join(base, round);
  if (p.json) out(JSON.stringify({ round, dir, capturas: join(dir, "capturas"), impeccable: impeccableDir(home()) }));
  else {
    out(`rodada ${round}`);
    out(`pasta: ${dir}`);
    out(`capturas: ${join(dir, "capturas")}`);
  }
  return EXIT.ok;
}

function add(p: Parsed): number {
  const round = roundArg(p);
  const result = addItem(root(), round, {
    page: need(p, "--page"),
    rule: need(p, "--rule"),
    severity: need(p, "--severity"),
    title: need(p, "--title"),
    fix: p.values.get("--fix") ?? "",
    evidence: p.evidence,
  });
  if (result.kind === "invalid") return die(`achado inválido: ${result.reason}`);
  if (result.kind === "duplicate") {
    out(p.json ? JSON.stringify({ result: "duplicate", key: result.key, round: result.round, status: result.status }) : `repetido: ${result.key} já registrado em ${result.round} (${result.status})`);
    return EXIT.ok;
  }
  out(p.json ? JSON.stringify({ result: "added", item: result.item }) : `registrado: ${result.item.key}${result.item.regression ? " (regressão)" : ""}`);
  return EXIT.ok;
}

function select(p: Parsed): UxItem[] {
  const status = p.values.get("--status") ?? "open";
  if (status !== "all" && !STATUSES.includes(status as Status)) die(`--status: ${STATUSES.join("|")}|all`);
  const round = p.values.get("--round");
  const items = round ? roundItems(root(), round) : [...latestByKey(root()).values()];
  return sortItems(status === "all" ? items : items.filter((i) => i.status === status));
}

function list(p: Parsed): number {
  const items = select(p);
  if (p.json) out(JSON.stringify({ version: 1, items }));
  else if (items.length === 0) out("nenhum item");
  else for (const item of items) out(line(item));
  return EXIT.ok;
}

function openIssue(item: UxItem, round: string, repo: string): { url?: string; error?: string } {
  const draft = issueDraft(item, round);
  const r = run("gh", ["issue", "create", "-R", repo, "--title", draft.title, "--body", draft.body], { timeoutMs: ISSUE_TIMEOUT_MS });
  if (r.status !== 0) return { error: r.timedOut ? "gh excedeu o tempo" : (r.stderr.trim().split("\n").pop() ?? "gh falhou") };
  const url = r.stdout.trim().split("\n").pop() ?? "";
  return url ? { url } : { error: "gh não devolveu a URL da issue" };
}

function forward(p: Parsed): number {
  const items = select(p);
  const repo = p.values.get("--repo") ?? configValue("HADES_VERSION_CHECK_REPO", "");
  if (p.issues && !repo) return die("sem repositório: passe --repo <dono/nome>");
  let failed = 0;
  const done: Array<{ key: string; issue?: string; error?: string }> = [];
  for (const item of items) {
    if (!p.issues) {
      const draft = issueDraft(item, item.round);
      if (!p.json) out(`### ${draft.title}\n\n${draft.body}\n`);
      done.push({ key: item.key });
      continue;
    }
    const r = openIssue(item, item.round, repo);
    if (r.url) {
      setStatus(root(), item.key, "issue", r.url);
      done.push({ key: item.key, issue: r.url });
      if (!p.json) out(`issue: ${item.key} → ${r.url}`);
    } else {
      failed += 1;
      done.push({ key: item.key, error: r.error });
      warn(`${item.key}: ${r.error}`);
    }
  }
  if (p.json) out(JSON.stringify({ version: 1, issues: p.issues, items: done }));
  else if (items.length === 0) out("nenhum item aberto para encaminhar");
  else if (!p.issues) out("rascunhos acima; --issues abre as issues na conta da org (só por ordem do orquestrador)");
  return failed ? EXIT.fail : EXIT.ok;
}

function resolveItem(p: Parsed): number {
  const key = p.positional[0];
  if (!key) return die(USAGE);
  const item = setStatus(root(), key, "resolved");
  if (!item) return die(`item desconhecido: ${key}`, EXIT.fail);
  out(p.json ? JSON.stringify({ item }) : `resolvido: ${key}`);
  return EXIT.ok;
}

function uiCommit(): string {
  const r = run("git", ["-C", skillRoot, "log", "-1", "--format=%H", "--", UI_PATH]);
  return r.status === 0 ? r.stdout.trim() : "";
}

function done(p: Parsed): number {
  const round = roundArg(p);
  if (!rounds(root()).includes(round)) return die(`rodada ${round} não existe`, EXIT.fail);
  writeLast(root(), { round, uiCommit: uiCommit() });
  const items = roundItems(root(), round);
  out(`rodada ${round} fechada: ${items.length} item(ns) novo(s)`);
  return EXIT.ok;
}

/** O que o skill-release imprime: vazio quando desligado, sem Impeccable ou sem mudança de UI desde a última rodada. */
export function reminderLine(): string | undefined {
  const raw = configValue("HADES_UX_AUDIT_REMINDER", "release");
  const mode = (REMINDER_MODES as readonly string[]).includes(raw) ? raw : "off";
  if (!impeccableInstalled(impeccableDir(home()))) return undefined;
  return reminderText(mode, uiCommit(), readLast(root()));
}

export function uxAuditCommand(args: string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "start": return start(parse(rest));
    case "add": return add(parse(rest));
    case "list": return list(parse(rest));
    case "forward": return forward(parse(rest));
    case "resolve": return resolveItem(parse(rest));
    case "done": return done(parse(rest));
    case "reminder": {
      const text = reminderLine();
      if (text) out(text);
      return EXIT.ok;
    }
    default: return die(USAGE);
  }
}
