// Erros que se explicam (reference/erros.md): do código estável ao texto para humano. O código continua sendo o que a
// máquina lê; o texto vem do catálogo (human-errors-catalog.ts) e nunca leva segredo, caminho de usuário nem pilha. Módulo
// sem dependência de runtime: a CLI, o hook e o painel o carregam, e o hook roda em toda chamada de ferramenta.
import { CLI_ERRORS, HUMAN_ERRORS, type HumanError } from "./human-errors-catalog.ts";

export { CLI_ERRORS, CLIENT_ERRORS, HOOK_ERRORS, HUMAN_ERRORS, PANEL_ERRORS, type HumanError } from "./human-errors-catalog.ts";

export const ERRORS_DOC = "reference/erros.md";
const ADD_ENTRY_REF = `${ERRORS_DOC} §Como acrescentar uma entrada`;

/** O que o painel anexa às respostas de erro (campo `explain`) e a UI mostra; `known` diz se veio do catálogo. */
export interface Explanation extends HumanError {
  code: string;
  known: boolean;
}

/** Texto de quem não tem entrada: mostra o código e aponta o doctor, que é por onde o usuário novo descobre o que falta. */
function fallback(code: string): Explanation {
  return {
    code,
    known: false,
    title: "Esse erro ainda não tem explicação própria",
    cause: `A Hades registrou a falha com o código \`${code}\`, mas ninguém escreveu ainda o que ele significa. A mensagem original (acima) é o que se sabe.`,
    action: "Rode `hades doctor` para ver se falta algo na máquina e `hades explain <código>` para procurar outro erro parecido.",
    ref: ADD_ENTRY_REF,
  };
}

/** Entrada do catálogo para o código, ou o texto de fallback (nunca `undefined`). */
export function explain(code: string | undefined): Explanation {
  const key = code ?? CLI_ERRORS.failed;
  const entry = Object.hasOwn(HUMAN_ERRORS, key) ? HUMAN_ERRORS[key] : undefined;
  return entry === undefined ? fallback(key) : { code: key, known: true, ...entry };
}

/** Códigos do catálogo, em ordem alfabética (para `hades explain` sem argumento e para o teste de cobertura). */
export function knownCodes(): string[] {
  return Object.keys(HUMAN_ERRORS).sort();
}

/**
 * Saída da CLI no formato do catálogo. A primeira linha é a mensagem original (o que aconteceu, com o dado que a sustenta),
 * para que quem filtra a saída pelo texto continue achando o que achava; o resto explica a causa e o que fazer agora.
 */
export function renderCli(message: string, code: string | undefined, prefix = "hades"): string {
  const e = explain(code);
  const lines = [`${prefix}: ${message}`, `  Por quê:      ${e.cause}`, `  O que fazer:  ${e.action}`, `  Saiba mais:   ${e.ref}`, `  (código: ${e.code})`];
  return lines.join("\n");
}

/**
 * Razão de uma recusa do hook (stderr, exit 2): a primeira linha diz o que foi barrado (o diário a grava como resumo), e o bloco
 * traz a causa e o que fazer no lugar. `action` troca a ação do catálogo quando a recusa sabe o comando exato (o `hades wait` do alvo).
 */
export function renderHook(message: string, code: string, action?: string): string {
  const e = explain(code);
  return [`${message}`, `  Por quê:                ${e.cause}`, `  O que fazer no lugar:   ${action ?? e.action}`, `  Saiba mais:             ${e.ref}`, `  (código: ${e.code})`].join("\n") + "\n";
}

const CODE_LINE = /^\s*\(código: [^)]+\)\s*$/;

/**
 * A mensagem de um comando que falhou, para quem lê o stderr dele (o painel repassa essa linha ao usuário). Com o bloco do
 * `renderCli` no fim, a mensagem é a linha antes das indentadas; sem ele, vale a última linha, como sempre foi.
 */
export function messageOfCliFailure(stderr: string): string {
  const lines = stderr.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return "";
  const last = lines.length - 1;
  if (!CODE_LINE.test(lines[last] ?? "")) return lines[last] ?? "";
  let i = last;
  while (i > 0 && /^\s/.test(lines[i] ?? "")) i -= 1;
  return lines[i] ?? "";
}

/** Saída de `hades explain <código>`: o catálogo inteiro da entrada, sem mensagem de runtime. */
export function renderEntry(code: string): string {
  const e = explain(code);
  return [`${e.title}`, "", `  Código:       ${e.code}`, `  Por quê:      ${e.cause}`, `  O que fazer:  ${e.action}`, `  Saiba mais:   ${e.ref}`].join("\n");
}

/** Código padrão de uma saída não-zero da CLI sem código próprio: a classe do erro vem do código de saída (contrato antigo). */
export function cliCodeOfExit(exit: number): string {
  switch (exit) {
    case 2:
      return CLI_ERRORS.usage;
    case 3:
      return CLI_ERRORS.noProfile;
    case 4:
      return CLI_ERRORS.outsideRepo;
    case 69:
      return CLI_ERRORS.missingDependency;
    case 75:
      return CLI_ERRORS.gateNotAdmitted;
    default:
      return CLI_ERRORS.failed;
  }
}

/** Distância de edição (Levenshtein) com duas linhas: para sugerir o subcomando que o usuário quis digitar. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

const SUGGEST_MAX_DISTANCE = 3;

/** O subcomando mais parecido com o digitado (até 3 edições, e menos que o tamanho do nome), ou `undefined`. */
export function suggestName(typed: string, names: readonly string[]): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const name of names) {
    const d = distance(typed.toLowerCase(), name);
    if (d <= SUGGEST_MAX_DISTANCE && d < Math.max(typed.length, 2) && (best === undefined || d < best.d)) best = { name, d };
  }
  return best?.name;
}
