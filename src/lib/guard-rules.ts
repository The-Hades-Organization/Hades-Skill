// As expressões do hook hades guard e do hades-usage, lidas de loop/hooks/guard-rules.json: o hook (Python) e o
// consumo (TypeScript) enxergam a mesma definição de polling, sem duas cópias para manter em dia.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { skillRoot } from "./paths.ts";

interface RuleSpec {
  re: string;
  flags: string;
  what?: string;
}
interface RulesFile {
  fgPoll: RuleSpec[];
  repeat: RuleSpec[];
  usageChecks: RuleSpec;
  agentText: RuleSpec;
  quoted: RuleSpec;
  heredoc: RuleSpec;
}

export const RULES_FILE = join(skillRoot, "loop", "hooks", "guard-rules.json");

/** `flags` do arquivo usa a letra do Python que muda o que o JS faz diferente: `s` (o ponto casa quebra de linha). */
function compile(spec: RuleSpec, extra = ""): RegExp {
  return new RegExp(spec.re, spec.flags + extra);
}

function load(file: string): RulesFile {
  return JSON.parse(readFileSync(file, "utf8")) as RulesFile;
}

export interface GuardRules {
  fgPoll: { rx: RegExp; what: string }[];
  /** checagens que o hook só barra na repetição; o grupo 1 da expressão, quando há, entra na chave */
  repeat: { rx: RegExp; what: string }[];
  checks: RegExp;
  agentText: RegExp;
  quoted: RegExp;
  heredoc: RegExp;
}

export function guardRules(file: string = RULES_FILE): GuardRules {
  const raw = load(file);
  return {
    fgPoll: raw.fgPoll.map((spec) => ({ rx: compile(spec), what: spec.what ?? "" })),
    repeat: raw.repeat.map((spec) => ({ rx: compile(spec), what: spec.what ?? "" })),
    checks: compile(raw.usageChecks),
    agentText: compile(raw.agentText, "g"),
    quoted: compile(raw.quoted, "g"),
    heredoc: compile(raw.heredoc, "g"),
  };
}

/** hades agent answer|prompt|…: o que está entre aspas é dado, não comando (aspas com `$(` ou crase executam e ficam). */
export function stripAgentText(rules: GuardRules, cmd: string): string {
  return cmd.replace(rules.agentText, (_all, head: string, args: string) =>
    head + args.replace(rules.quoted, (quoted) => (quoted.includes("$(") || quoted.includes("`") ? quoted : '""')),
  );
}

/** Corpo de heredoc é dado (documento, script gravado em arquivo): fica só a linha de abertura. */
export function stripHeredocBodies(rules: GuardRules, cmd: string): string {
  return cmd.replace(rules.heredoc, "$1");
}

/** Comando de espera em primeiro plano, pela definição do hook mais as checagens que ele só barra na repetição. */
export function isPolling(rules: GuardRules, cmd: string): boolean {
  const text = stripHeredocBodies(rules, stripAgentText(rules, cmd));
  return rules.checks.test(text) || rules.fgPoll.some(({ rx }) => rx.test(text));
}

/** Comandos cujos argumentos são texto ou padrão (buscar, editar, imprimir), nunca um comando que roda. */
const DATA_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "sed", "awk", "gawk", "echo", "printf", "jq"]);
const ENV_ASSIGN = /^[A-Za-z_]\w*=/;

/** Divide em instruções por `;`, `&&`, `||`, `|` e quebra de linha fora de aspas; cada pedaço leva o separador que o fecha. */
function statements(cmd: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd.charAt(i);
    current += ch;
    if (quote !== "") {
      if (ch === "\\" && quote === '"') current += cmd.charAt(++i);
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      out.push(current);
      current = "";
    }
  }
  out.push(current);
  return out;
}

/**
 * `grep 'tail -f'`, `sed -i s/sleep 60//` e `echo "hades wait"` citam o padrão como dado: a instrução inteira sai antes da
 * detecção de polling. `$(…)` e crase dentro dela executam, então a instrução fica.
 */
export function maskDataStatements(cmd: string): string {
  return statements(cmd)
    .filter((stmt) => {
      if (stmt.includes("$(") || stmt.includes("`")) return true;
      const words = stmt.trim().split(/\s+/).filter((w) => !ENV_ASSIGN.test(w));
      const first = words[0]?.replace(/^\(+/, "") ?? "";
      return !DATA_COMMANDS.has(first.split("/").pop() ?? "");
    })
    .join("");
}
