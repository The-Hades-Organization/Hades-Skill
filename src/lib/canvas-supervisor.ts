// Supervisor do canvas (reference/argos.md §Supervisor): heurística local sobre o que o terminal mostra quando o agente
// termina ou para (estado do herdr, últimas linhas, pergunta e permissão detectadas) e o contexto mínimo que vai ao
// `claude -p` na consulta sob demanda e no resumo das notas. Puro: sem rede, sem herdr, sem relógio (a hora vem de fora).
// O supervisor só lê, resume e anota: nada aqui monta texto ou tecla para um agente.
import type { CanvasDoc } from "./canvas-doc.ts";

export const SUPERVISOR_LIMITS = {
  /** linhas pedidas ao pane para o cartão e para a consulta */
  readLines: 120,
  /** prévia do quadro no cartão */
  previewLines: 14,
  /** "últimas linhas" no cartão */
  lastLines: 6,
  /** passos recentes do agente (linhas com marcador de ação) */
  steps: 3,
  /** onde procurar pergunta e permissão, a partir do fim */
  detectWindow: 14,
  lineChars: 240,
  /** consulta: últimas linhas e caracteres do terminal que saem da máquina */
  askLines: 80,
  askChars: 12_000,
  questionChars: 1_000,
  /** resumo das notas: quantas notas, caracteres por nota e no total */
  notesMax: 20,
  noteChars: 6_000,
  notesChars: 24_000,
  /** resposta do claude mostrada no cartão */
  answerChars: 4_000,
} as const;

export const SUPERVISOR_KINDS = ["done", "question", "permission", "idle", "error"] as const;
export type SupervisorKind = (typeof SUPERVISOR_KINDS)[number];

/** Estados do herdr que contam como "parou" depois de `working`. */
export const PAUSE_STATUSES = ["idle", "blocked", "done"] as const;
export const AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const isAgentStatus = (value: unknown): value is AgentStatus => typeof value === "string" && (AGENT_STATUSES as readonly string[]).includes(value);

/** O que a sugestão faz na tela do supervisor; nenhuma manda nada ao agente. */
export type SuggestionAction = "jump" | "ask" | "note" | "notes";
export interface Suggestion {
  label: string;
  action: SuggestionAction;
}

export interface SupervisorCard {
  kind: SupervisorKind;
  title: string;
  /** uma frase: o título e o detalhe mais útil (pergunta, pedido de permissão, último passo ou erro) */
  summary: string;
  status: AgentStatus;
  question?: string;
  permission?: string;
  error?: string;
  steps: string[];
  lastLines: string[];
  preview: string[];
  suggestions: Suggestion[];
  /** o cartão passivo é sempre local */
  source: "local";
}

export const KIND_TITLE: Readonly<Record<SupervisorKind, string>> = {
  done: "Terminou",
  question: "Fez uma pergunta",
  permission: "Pede permissão",
  idle: "Parou de trabalhar",
  error: "Parou com erro",
};

const SUGGESTIONS: Readonly<Record<SupervisorKind, readonly Suggestion[]>> = {
  permission: [
    { label: "Abrir o terminal e responder à permissão", action: "jump" },
    { label: "Perguntar o que ele quer rodar", action: "ask" },
  ],
  question: [
    { label: "Ir ao terminal para responder", action: "jump" },
    { label: "Pedir o contexto da pergunta", action: "ask" },
  ],
  done: [
    { label: "Revisar o resultado no terminal", action: "jump" },
    { label: "Resumir as notas conectadas", action: "notes" },
    { label: "Anotar o resultado", action: "note" },
  ],
  idle: [
    { label: "Ver onde ele parou", action: "jump" },
    { label: "Perguntar o que falta", action: "ask" },
    { label: "Anotar", action: "note" },
  ],
  error: [
    { label: "Ler o erro no terminal", action: "jump" },
    { label: "Perguntar o que falhou", action: "ask" },
  ],
};

// CSI, OSC (até BEL ou ST), outros ESC de dois caracteres, e controles (fica \n e \t)
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
// linha só de moldura, régua ou pontuação solta
const FRAME_ONLY = /^[\s─-▟⠀-⣿·•…=_~*+|-]*$/u;
const BORDER_EDGES = /^[\s│┃║|]+|[\s│┃║|]+$/gu;
// rodapé de atalhos e caixa de entrada vazia da CLI
const FOOTER = /^(?:\?\s+for shortcuts|esc to (?:interrupt|cancel)|.*shift\+tab to cycle|.*auto-accept edits|.*bypass permissions|⏵⏵|ctrl\+[a-z] to )/i;
const EMPTY_INPUT = /^[>❯›]\s*$/u;
const STEP = /^[⏺●•◆]\s*(.+)$/u;
const PERMISSION = /do you want to (?:proceed|make this edit|create|run|allow|delete|overwrite|fetch)|requires? (?:approval|permission)|permission to|\bpermitir\b|deseja (?:prosseguir|permitir|continuar)|\[y\/n\]|\(y\/n\)|\[s\/n\]/i;
const OPTION = /^[❯›>]?\s*\d[.)]\s+(?:yes|sim|no|não|allow|permitir|deny|negar)\b/iu;
const ERROR = /\b(?:error|erro|failed|falhou|falha|exception|traceback|panic|fatal)\b|[✗✘]/iu;

const clip = (text: string, max: number): string => {
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
};

export const stripAnsi = (text: string): string => text.replace(/\r\n?/g, "\n").replace(ANSI, "");

/** O texto cru do pane em linhas legíveis: sem ANSI, sem moldura, sem rodapé de atalhos e sem a caixa de entrada vazia. */
export function meaningfulLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of stripAnsi(text).split("\n")) {
    const inner = raw.replace(BORDER_EDGES, "").trim();
    if (!inner || FRAME_ONLY.test(inner) || FOOTER.test(inner) || EMPTY_INPUT.test(inner)) continue;
    out.push(clip(inner, SUPERVISOR_LIMITS.lineChars));
  }
  return out;
}

/** O fim da tela como ela é (para a prévia): sem ANSI, linhas vazias do fim fora. */
export function previewLines(text: string, max: number = SUPERVISOR_LIMITS.previewLines): string[] {
  const lines = stripAnsi(text).split("\n").map((line) => clip(line.trimEnd(), SUPERVISOR_LIMITS.lineChars));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-max);
}

/** Pedido de permissão no fim da tela: a linha do pedido e o que vem logo acima (o comando ou o arquivo). */
export function detectPermission(lines: readonly string[]): string | undefined {
  const start = Math.max(0, lines.length - SUPERVISOR_LIMITS.detectWindow);
  for (let i = lines.length - 1; i >= start; i--) {
    const line = lines[i] as string;
    if (!PERMISSION.test(line)) continue;
    // o assunto é a linha acima do pedido que não é outra opção nem o próprio pedido
    let subject: string | undefined;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const above = lines[j] as string;
      if (!OPTION.test(above) && !PERMISSION.test(above)) { subject = above.replace(STEP, "$1"); break; }
    }
    return subject ? `${line} — ${subject}` : line;
  }
  // só as opções (Yes/No numeradas) sem a frase do pedido
  const options = lines.slice(start).filter((line) => OPTION.test(line));
  return options.length >= 2 ? options.join(" · ") : undefined;
}

/** A última linha que termina em "?" no fim da tela (fora o rodapé, que já saiu em `meaningfulLines`). */
export function detectQuestion(lines: readonly string[]): string | undefined {
  const start = Math.max(0, lines.length - SUPERVISOR_LIMITS.detectWindow);
  for (let i = lines.length - 1; i >= start; i--) {
    const line = (lines[i] as string).replace(STEP, "$1").trim();
    if (/[?？]\s*$/u.test(line) && !OPTION.test(line)) return line;
  }
  return undefined;
}

export function detectError(lines: readonly string[]): string | undefined {
  const tail = lines.slice(-SUPERVISOR_LIMITS.lastLines);
  for (let i = tail.length - 1; i >= 0; i--) if (ERROR.test(tail[i] as string)) return tail[i];
  return undefined;
}

/** Passos recentes: linhas com o marcador de ação da CLI (⏺ Bash(…), ⏺ Update(…)), do mais antigo ao mais novo. */
export function recentSteps(lines: readonly string[], max: number = SUPERVISOR_LIMITS.steps): string[] {
  const steps: string[] = [];
  for (const line of lines) {
    const m = STEP.exec(line);
    if (m) steps.push((m[1] as string).trim());
  }
  return steps.slice(-max);
}

/** Qual cartão a tela pede: permissão vence; depois fim (ou erro), pergunta, erro, e o resto é "parou". */
export function classify(input: { status: AgentStatus; exited?: boolean; lines: readonly string[] }): { kind: SupervisorKind; question?: string; permission?: string; error?: string } {
  const permission = detectPermission(input.lines);
  if (permission) return { kind: "permission", permission };
  const error = detectError(input.lines);
  if (input.status === "done" || input.exited) return error ? { kind: "error", error } : { kind: "done" };
  const question = detectQuestion(input.lines);
  if (question) return { kind: "question", question };
  if (error) return { kind: "error", error };
  if (input.status === "blocked") return { kind: "question" };
  return { kind: "idle" };
}

/** O cartão do supervisor para um terminal que acabou de parar. `text` é o que o pane mostra (com ou sem ANSI). */
export function buildCard(input: { status: AgentStatus; exited?: boolean; text: string }): SupervisorCard {
  const lines = meaningfulLines(input.text);
  const found = classify({ status: input.status, exited: input.exited, lines });
  const steps = recentSteps(lines);
  const title = input.status === "blocked" && found.kind === "question" && !found.question ? "Espera uma resposta" : KIND_TITLE[found.kind];
  const detail = found.permission ?? found.question ?? found.error ?? steps[steps.length - 1];
  const card: SupervisorCard = {
    kind: found.kind, title, summary: detail ? `${title}: ${detail}` : title, status: input.status,
    steps, lastLines: lines.slice(-SUPERVISOR_LIMITS.lastLines), preview: previewLines(input.text),
    suggestions: SUGGESTIONS[found.kind].map((s) => ({ ...s })), source: "local",
  };
  if (found.question) card.question = found.question;
  if (found.permission) card.permission = found.permission;
  if (found.error) card.error = found.error;
  return card;
}

/** Corta do começo até caber: o fim da tela é o que importa. */
function tailWithin(lines: readonly string[], maxLines: number, maxChars: number): string[] {
  const out: string[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i] as string;
    if (chars + line.length + 1 > maxChars) break;
    out.unshift(line);
    chars += line.length + 1;
  }
  return out;
}

export interface OutgoingContext {
  prompt: string;
  /** o que sai da máquina, para o selo do cartão e o log (nunca o texto) */
  sent: { lines?: number; notes?: number; chars: number };
}

/** Consulta sob demanda: a pergunta do dono e as últimas linhas do terminal alvo, e mais nada. */
export function askContext(input: { name: string; question: string; text: string }): OutgoingContext {
  const lines = tailWithin(meaningfulLines(input.text), SUPERVISOR_LIMITS.askLines, SUPERVISOR_LIMITS.askChars);
  const question = clip(input.question.trim(), SUPERVISOR_LIMITS.questionChars);
  const prompt = [
    `Você acompanha um agente de código que roda num terminal chamado "${clip(input.name, 80)}".`,
    "Responda em português, em até 5 linhas, só com base nas últimas linhas do terminal abaixo.",
    "Descreva o que ele está fazendo e em que estado está. Não escreva comandos nem mensagens para mandar ao agente.",
    "",
    `Pergunta: ${question}`,
    "",
    "Últimas linhas do terminal:",
    "<<<",
    ...lines,
    ">>>",
  ].join("\n");
  return { prompt, sent: { lines: lines.length, chars: lines.reduce((n, l) => n + l.length + 1, 0) + question.length } };
}

/** Resumo das notas conectadas: título e texto de cada uma, cortados nos tetos. */
export function notesContext(notes: readonly { title: string; text: string }[]): OutgoingContext {
  const parts: string[] = [];
  let chars = 0;
  let count = 0;
  for (const note of notes.slice(0, SUPERVISOR_LIMITS.notesMax)) {
    const body = clip(note.text.trim(), SUPERVISOR_LIMITS.noteChars);
    if (!body) continue;
    if (chars + body.length > SUPERVISOR_LIMITS.notesChars) break;
    parts.push(`## ${clip(note.title, 80)}`, body, "");
    chars += body.length;
    count += 1;
  }
  const prompt = [
    "Abaixo estão as notas de trabalho de um canvas com agentes de código.",
    "Escreva em português uma visão geral coerente, em até 12 linhas: o objetivo, o que já foi feito, o que está pendente",
    "e as decisões registradas, para retomar o contexto depois de uma pausa ou passá-lo a um agente novo.",
    "",
    ...parts,
  ].join("\n");
  return { prompt, sent: { notes: count, chars } };
}

/** Notas ligadas por conexão (aresta `link`) a qualquer nó, na ordem do documento: as que o resumo lê. */
export function connectedNoteNames(doc: CanvasDoc): string[] {
  const linked = new Set<string>();
  for (const edge of doc.edges) if (edge.kind === "link") { linked.add(edge.from); linked.add(edge.to); }
  const names: string[] = [];
  for (const node of doc.nodes) {
    if (node.type !== "note" || !linked.has(node.id)) continue;
    const data = node.data as { note?: unknown } | undefined;
    if (typeof data?.note === "string" && !names.includes(data.note)) names.push(data.note);
  }
  return names;
}

export const clipAnswer = (text: string): string => clip(stripAnsi(text).trim(), SUPERVISOR_LIMITS.answerChars);
