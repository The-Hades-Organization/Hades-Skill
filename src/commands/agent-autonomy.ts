// `hades agent decide|auto-start`: autonomia do orquestrador (reference/autonomia.md).
import { appendFileSync, realpathSync } from "node:fs";
import { save, ConfigError } from "../lib/config-catalog.ts";
import {
  AUTO_START_KEY, AUTO_START_RULE, AUTONOMY_KEY, EXIT_ASK_OWNER, LEVEL_LABELS, MAX_LEVEL, NEVER_CLASSES, autoStartStatus,
  currentLevel, isNeverClass, judge, ownerConfig, setAutoStartRule, type NeverClass,
} from "../lib/autonomy.ts";
import { startCommand } from "../lib/agent-registry.ts";
import { startForWorktree } from "../lib/rtk-trust.ts";
import { emitJournal } from "../lib/journal.ts";
import { kitDir, stateDir } from "../lib/kit.ts";
import { NotifyContext, notify } from "../lib/notify.ts";
import { die, out, warn } from "../lib/output.ts";

const isoNow = (): string => `${new Date().toISOString().slice(0, 19)}Z`;
const LOG_FIELD_MAX = 400;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, LOG_FIELD_MAX);

interface DecideArgs {
  plan: string;
  needed: number;
  question: string;
  chosen: string;
  alternatives: string[];
  neverClass?: NeverClass;
}

function parseDecide(args: string[]): DecideArgs {
  const plan = args[0];
  if (!plan || plan.startsWith("--")) die("faltou <plano>");
  const found: Record<string, string> = {};
  const alternatives: string[] = [];
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i] ?? "";
    const value = args[i + 1];
    if (!["--level-needed", "--question", "--chosen", "--alternatives", "--class"].includes(flag)) die(`opção desconhecida: ${flag}`);
    if (value === undefined) die(`faltou o valor de ${flag}`);
    if (flag === "--alternatives") alternatives.push(...value.split(";").map((a) => a.trim()).filter(Boolean));
    else found[flag] = value;
  }
  const needed = Number(found["--level-needed"]);
  if (!Number.isInteger(needed) || needed < 1 || needed > MAX_LEVEL) die(`--level-needed: inteiro de 1 a ${MAX_LEVEL}`);
  const question = found["--question"]?.trim() ?? "";
  const chosen = found["--chosen"]?.trim() ?? "";
  if (!question) die("faltou --question");
  if (!chosen) die("faltou --chosen");
  const klass = found["--class"];
  if (klass !== undefined && !isNeverClass(klass)) die(`--class: ${NEVER_CLASSES.join("|")}`);
  return { plan, needed, question, chosen, alternatives, ...(klass ? { neverClass: klass as NeverClass } : {}) };
}

async function notifyDecision(text: string): Promise<void> {
  try {
    await notify(new NotifyContext(stateDir()), "agent", "info", text, { obj: "autonomia" });
  } catch (error) {
    // notificação é aviso ao dono: sem ela a decisão já está no log e no diário
    warn(`hades: notificação da decisão não saiu: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Sai 0 se o nível atual permite (e deixa o rastro), 3 se é pergunta ao dono. */
export async function decide(args: string[]): Promise<number> {
  const input = parseDecide(args);
  let plan: string;
  try {
    plan = realpathSync(input.plan);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return die("plano não encontrado");
    throw error;
  }
  const level = currentLevel();
  const verdict = judge({ levelNeeded: input.needed, currentLevel: level, question: input.question, chosen: input.chosen, neverClass: input.neverClass });
  if (!verdict.allowed) {
    out(`PERGUNTAR AO DONO: ${verdict.reason}`);
    return EXIT_ASK_OWNER;
  }
  const alternatives = input.alternatives.length > 0 ? ` [alternativas: ${input.alternatives.map(oneLine).join("; ")}]` : "";
  const line = `- ${isoNow()} decisão autônoma (nível ${level}, exige ${input.needed}): ${oneLine(input.question)} → ${oneLine(input.chosen)}${alternatives}\n`;
  appendFileSync(`${plan.replace(/\.md$/, "")}.log.md`, line);
  emitJournal("orch", "decision", `nível ${level}/${input.needed} | ${input.question} → ${input.chosen}`, {
    get: (key) => ownerConfig(key, ""),
    decision: { level, needed: input.needed, question: input.question, chosen: input.chosen, alternatives: input.alternatives },
  });
  await notifyDecision(`decidi (nível ${level}): ${oneLine(input.question)} → ${oneLine(input.chosen)}`);
  out(`DECIDIDO: ${verdict.reason} (nível ${level}: ${LEVEL_LABELS[level]}); registrado no log do plano e no diário`);
  return 0;
}

export function autoStart(args: string[]): number {
  const [op = "status"] = args;
  if (op === "status") {
    const s = autoStartStatus();
    out(`auto-alocação: ${s.active ? "ativa" : "inativa"} (toggle ${AUTO_START_KEY}=${s.toggle ? 1 : 0}, regra ${AUTO_START_RULE} ${s.rule ? "presente" : "ausente"} em ${s.settings})`);
    return 0;
  }
  if (op !== "on" && op !== "off") die("uso: hades agent auto-start on|off|status");
  const on = op === "on";
  try {
    save({ dir: stateDir(), kit: kitDir() }, { [AUTO_START_KEY]: on ? "1" : "0" });
  } catch (error) {
    if (error instanceof ConfigError) die(error.message, 1);
    throw error;
  }
  const change = setAutoStartRule(on);
  out(`auto-alocação ${on ? "ligada" : "desligada"}: regra ${AUTO_START_RULE} ${change === "unchanged" ? "já estava assim" : change === "added" ? "gravada" : "removida"}`);
  return 0;
}

/** Aplica o toggle gravado (painel): a regra do settings acompanha o valor da chave. */
export function syncAutoStartRule(): string {
  return setAutoStartRule(ownerConfig(AUTO_START_KEY, "0").trim() === "1");
}

/**
 * Com o toggle ligado e a regra presente, o comando de start sai sem o `! `: quem o roda é o orquestrador, como Bash, sob a
 * regra allow e o classificador (nunca um subprocesso do hades). Senão sai o comando do dono, como sempre, com o `rtk trust` da
 * worktree na frente quando ela tem filtro gerado e não confiado (texto: a sessão não executa).
 */
export function startOrOwnerCommand(name: string, pane: string, role: string, worktree = ""): { byOrchestrator: boolean; command: string } {
  const command = startCommand(name, pane, role);
  if (!pane || !autoStartStatus().active) return { byOrchestrator: false, command: startForWorktree(command, worktree) };
  return { byOrchestrator: true, command: command.replace(/^! /, "") };
}
