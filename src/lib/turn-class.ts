// Acompanhamento × decisão: classifica o turno do orquestrador pelo que ele fez, sem olhar o resultado.
// Acompanhamento = despertar de wait/watch, leitura de pane, `agent list`/`status`: sem escrita nem decisão.
// Qualquer outra coisa (escrever, recrutar, mandar prompt, investigar arquivo, responder o dono) é decisão.
// O que não se reconhece com certeza cai em decisão: a medida subestima o acompanhamento, nunca o infla.

export type TurnKind = "follow" | "decision";

export interface TurnTool {
  name: string;
  /** Texto do comando, só no Bash. */
  command?: string;
}

export interface TurnFacts {
  /** Os tool_use do turno, na ordem. */
  tools: readonly TurnTool[];
  /** O turno responde direto a um aviso de segundo plano (`<task-notification>`): o despertar de um wait/watch. */
  afterWake: boolean;
}

/** Tools que só armam ou esperam o próximo evento; não escrevem nem decidem. */
const WAIT_TOOLS: ReadonlySet<string> = new Set(["Monitor", "ScheduleWakeup"]);

/** Subcomandos do `hades` de acompanhamento: o programa é o primeiro token, o resto casa com o padrão. */
const HADES_FOLLOW = /^(wait|watch|agent\s+(list|ls|status)|gate-lock\s+status)(\s|$)/;
const HERDR_FOLLOW = /^(pane\s+(read|list|get)|agent\s+(list|read|get|status)|workspace\s+list|tab\s+list)(\s|$)/;

const WAKE_TAG = "<task-notification";

/** Texto de usuário que é o aviso de um comando em segundo plano (o despertar do wait). */
export function isWakeText(text: string): boolean {
  return text.trimStart().startsWith(WAKE_TAG);
}

interface Segment {
  text: string;
  /** Vem depois de um `|`: recebe a saída do trecho anterior. */
  piped: boolean;
}

/** Trechos do comando entre `&&`, `||`, `;` e quebra de linha, e as etapas de cada pipeline. */
function segments(command: string): Segment[] {
  return command.split(/&&|\|\||[;\n]/).flatMap((chain) =>
    chain.split("|").map((text, index) => ({ text: text.trim(), piped: index > 0 })).filter((part) => part.text !== ""));
}

/** Filtro que só lê a entrada padrão do pipeline: não acrescenta escrita nem decisão. */
const PIPE_FILTER = /^(head|tail|grep|egrep|wc|sort|uniq|cut|tr)(\s|$)/;

/** Sem o que antecede o programa: `cd dir`, atribuição de variável, `export`, `rtk [proxy]`, `time`, `timeout N`. */
function stripPrefix(segment: string): string | undefined {
  let rest = segment;
  for (;;) {
    const next = rest
      .replace(/^(rtk(\s+proxy)?|time|command|exec)\s+/, "")
      .replace(/^timeout\s+\S+\s+/, "")
      .replace(/^export\s+\S+=\S*\s*/, "")
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/, "");
    if (next === rest) break;
    rest = next;
  }
  if (rest === "" || /^cd(\s|$)/.test(rest)) return undefined;
  return rest;
}

/** Redireção que grava arquivo: `>` ou `>>` que não vai para /dev/null nem para outro descritor (`2>&1`). */
function writesFile(segment: string): boolean {
  const withoutSafe = segment.replace(/\d?&?>\s*\/dev\/null/g, "").replace(/\d?>&\d/g, "");
  return withoutSafe.includes(">") || withoutSafe.includes("<<");
}

/** Saída de um comando em segundo plano do Claude Code (`…/tasks/<id>.output`): ler o que o wait/watch acabou de devolver. */
const TASK_OUTPUT = /\/tasks\/[A-Za-z0-9_-]+\.output$/;

/** `cat`/`tail`/`head` só sobre arquivos de saída de tarefa em segundo plano (flags livres). */
function readsTaskOutput(program: string, words: readonly string[]): boolean {
  if (!/^(cat|tail|head)$/.test(program)) return false;
  const files = words.filter((word) => !word.startsWith("-") && !/^\d+$/.test(word));
  return files.length > 0 && files.every((file) => TASK_OUTPUT.test(file));
}

/** O programa do segmento: `hades`, caminho que termina em `hades`/`hades-agent.sh`/`hades-watch.sh` ou variável (`$H`, `$B/hades`). */
function followsUp(segment: string): boolean {
  const body = stripPrefix(segment);
  if (body === undefined || writesFile(body)) return false;
  const [program = "", ...restWords] = body.split(/\s+/);
  const rest = restWords.join(" ");
  if (readsTaskOutput(program, restWords)) return true;
  if (/(^|\/)hades-watch(\.sh)?$/.test(program)) return true;
  if (/(^|\/)hades-agent(\.sh)?$/.test(program)) return /^(list|ls|status)(\s|$)/.test(rest);
  if (/(^|\/)hades$/.test(program) || /^\$\{?[A-Za-z_]+\}?(\/hades)?$/.test(program)) return HADES_FOLLOW.test(rest);
  if (/(^|\/)herdr$/.test(program)) return HERDR_FOLLOW.test(rest);
  return false;
}

/** O comando Bash inteiro é acompanhamento: tem trecho de programa e todos eles são de acompanhamento (`cd` sozinho não conta). */
export function bashIsFollowUp(command: string): boolean {
  const programs = segments(command).filter((part) => stripPrefix(part.text) !== undefined);
  const first = programs.findIndex((part) => !part.piped);
  return first >= 0 && programs.every((part) => (part.piped && PIPE_FILTER.test(stripPrefix(part.text) ?? "")) || followsUp(part.text));
}

function toolFollowsUp(tool: TurnTool): boolean {
  if (WAIT_TOOLS.has(tool.name)) return true;
  return tool.name === "Bash" && typeof tool.command === "string" && bashIsFollowUp(tool.command);
}

/**
 * Sem tool: só o despertar de um aviso vira acompanhamento (o orquestrador registrando que segue esperando);
 * texto solto fora de um despertar é resposta ao dono, decisão. Com tool: todas de acompanhamento.
 */
export function classifyTurn(turn: TurnFacts): TurnKind {
  if (turn.tools.length === 0) return turn.afterWake ? "follow" : "decision";
  return turn.tools.every(toolFollowsUp) ? "follow" : "decision";
}
