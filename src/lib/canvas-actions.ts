// Ações válidas para um nó do canvas do Argos (reference/argos.md §Ações (modelos puros)): o menu de um agente, montado só
// sobre as ações que `POST /api/argos/action` aceita, cada uma com rótulo, se é destrutiva e, quando não vale agora, o
// motivo. Lógica pura e sem Node: quem chama faz o POST. Esconder ou desabilitar item não é controle de acesso: o servidor
// confere tudo de novo (permissão pendente, confirmação, argumentos).
import type { ActionName } from "../panel/argos-actions.ts";

/** Códigos estáveis do motivo de uma ação indisponível: só ganham valores, nunca renomeiam. */
export const ACTION_REASONS = {
  notAgent: "action_not_agent",
  agentClosed: "action_agent_closed",
  noPendingPermission: "action_no_pending_permission",
  permissionNotSupported: "action_permission_not_supported",
  noOpenQuestion: "action_no_open_question",
  herdrUnavailable: "action_herdr_unavailable",
  herdrNotSeeing: "action_herdr_not_seeing",
} as const;
export type ActionReasonCode = (typeof ACTION_REASONS)[keyof typeof ACTION_REASONS];

export interface ActionReason {
  code: ActionReasonCode;
  message: string;
}

/** O que o menu lê de um nó do grafo (campo a mais é ignorado). `openQuestions` vem do detalhe do nó, não do grafo. */
export interface ActionNode {
  id: string;
  type: string;
  /** O nome do agente: é o que o servidor pede em `confirm` nas ações destrutivas. */
  label: string;
  state?: string | null;
  registryState?: string | null;
  herdrState?: string | null;
  pendingPermission?: { ts: string; tool: string | null } | null;
  /** Títulos `Q<n> — assunto` ainda sem resposta (`files.questions.openQuestions` do detalhe do nó). */
  openQuestions?: readonly string[] | null;
}

export interface ActionContext {
  /** `herdr.available` do grafo. Ausente = não se sabe, e não bloqueia: o servidor decide. */
  herdrAvailable?: boolean;
}

export interface ActionField {
  name: string;
  required: boolean;
  kind: "text" | "phase" | "question" | "session";
  /** Só em `question`: as perguntas abertas do nó. */
  choices?: readonly { value: string; label: string }[];
}

export interface ActionItem {
  key: ActionName;
  label: string;
  hint: string;
  /** Destrutiva: o servidor exige `confirm` igual ao nome do agente. */
  dangerous: boolean;
  available: boolean;
  reason?: ActionReason;
  fields: readonly ActionField[];
}

/** Corpo do `POST /api/argos/action`. */
export interface ActionRequest {
  node: string;
  action: ActionName;
  args: Record<string, unknown>;
  confirm?: string;
}

const CLOSED_STATES: ReadonlySet<string> = new Set(["done", "archived"]);
const HERDR_ABSENT = "fora";
const QUESTION_ID = /^(Q\d{1,4})(?=\s|$)/;
// Espelho de `isSimplePermissionTool` (src/lib/argos.ts, que lê o diário e não roda no navegador); o teste confere a paridade.
const SIMPLE_PERMISSION_TOOLS: ReadonlySet<string> = new Set(["Bash", "Edit", "Write", "NotebookEdit"]);
const MCP_PREFIX = "mcp__";

const why = (code: ActionReasonCode, message: string): ActionReason => ({ code, message });

const isClosed = (node: ActionNode): boolean => CLOSED_STATES.has(node.state ?? "") || CLOSED_STATES.has(node.registryState ?? "");
const isSimpleTool = (tool: string | null): boolean => tool !== null && (SIMPLE_PERMISSION_TOOLS.has(tool) || tool.startsWith(MCP_PREFIX));

const needsOpenAgent = (node: ActionNode): ActionReason | undefined =>
  isClosed(node) ? why(ACTION_REASONS.agentClosed, "o agente já foi encerrado") : undefined;

const needsHerdr = (node: ActionNode, ctx: ActionContext): ActionReason | undefined => {
  if (ctx.herdrAvailable === false) return why(ACTION_REASONS.herdrUnavailable, "o herdr não está disponível");
  return node.herdrState === HERDR_ABSENT ? why(ACTION_REASONS.herdrNotSeeing, "o herdr não vê este agente") : undefined;
};

/** As três travas do servidor: pedido pendente, herdr `blocked` e ferramenta de diálogo "Yes" simples. */
const needsAnswerablePermission = (node: ActionNode, ctx: ActionContext): ActionReason | undefined => {
  const pending = node.pendingPermission;
  if (!pending || node.herdrState !== "blocked") return why(ACTION_REASONS.noPendingPermission, "não há permissão pendente neste agente");
  if (!isSimpleTool(pending.tool)) return why(ACTION_REASONS.permissionNotSupported, "este diálogo (plano, pergunta ou ferramenta desconhecida) se responde no terminal");
  return needsHerdr(node, ctx);
};

const openQuestionChoices = (node: ActionNode): { value: string; label: string }[] => {
  const choices: { value: string; label: string }[] = [];
  for (const head of node.openQuestions ?? []) {
    const id = QUESTION_ID.exec(head)?.[1];
    if (id !== undefined) choices.push({ value: id, label: head });
  }
  return choices;
};

const text = (name: string, required: boolean): ActionField => ({ name, required, kind: "text" });

interface ActionRow {
  label: string;
  hint: string;
  dangerous: boolean;
  fields(node: ActionNode): readonly ActionField[];
  /** `undefined` = vale agora. */
  blocked(node: ActionNode, ctx: ActionContext): ActionReason | undefined;
}

/** Uma linha por ação da rota: se a rota ganhar ação, o compilador cobra a linha aqui. */
const ROWS: Readonly<Record<ActionName, ActionRow>> = {
  approve_permission: {
    label: "Aprovar permissão", hint: "Enter na opção \"Yes\" simples", dangerous: false,
    fields: () => [], blocked: needsAnswerablePermission,
  },
  deny_permission: {
    label: "Negar permissão", hint: "Escape no diálogo", dangerous: false,
    fields: () => [], blocked: needsAnswerablePermission,
  },
  answer: {
    label: "Responder pergunta", hint: "responde um Q<n> aberto do questions.md", dangerous: false,
    fields: (node) => [{ name: "question", required: true, kind: "question", choices: openQuestionChoices(node) }, text("reply", true)],
    blocked: (node) => needsOpenAgent(node) ?? (openQuestionChoices(node).length === 0 ? why(ACTION_REASONS.noOpenQuestion, "não há pergunta aberta") : undefined),
  },
  prompt: {
    label: "Enviar prompt", hint: "sem texto, a tarefa padrão do brief", dangerous: false,
    fields: () => [text("text", false)], blocked: needsOpenAgent,
  },
  resume: {
    label: "Retomar", hint: "continua o agente parado", dangerous: false,
    fields: () => [text("text", false)], blocked: needsOpenAgent,
  },
  phase: {
    label: "Mudar de fase", hint: "hades agent phase", dangerous: false,
    fields: () => [{ name: "phase", required: true, kind: "phase" }, text("text", false)], blocked: needsOpenAgent,
  },
  escalate: {
    label: "Escalar ao dono", hint: "registra o motivo e estaciona", dangerous: false,
    fields: () => [text("reason", true)], blocked: needsOpenAgent,
  },
  park: {
    label: "Estacionar agente", hint: "pede o handoff.md (STATUS: PARKED); a sessão segue aberta", dangerous: false,
    fields: () => [text("reason", false)], blocked: needsOpenAgent,
  },
  free_prompt: {
    label: "Prompt livre no terminal", hint: "pela página Herdr", dangerous: false,
    fields: () => [text("text", true), { name: "session", required: false, kind: "session" }], blocked: needsHerdr,
  },
  done: {
    label: "Encerrar agente", hint: "hades agent done", dangerous: true,
    fields: () => [], blocked: needsOpenAgent,
  },
  stop_session: {
    label: "Parar a sessão do herdr", hint: "derruba a sessão inteira", dangerous: true,
    fields: () => [{ name: "session", required: true, kind: "session" }], blocked: needsHerdr,
  },
  // Teclas e texto cru são do compositor e do teclado, não de um menu de ações.
  text: { label: "Texto no terminal", hint: "", dangerous: false, fields: () => [text("text", true)], blocked: needsHerdr },
  keys: { label: "Teclas no terminal", hint: "", dangerous: false, fields: () => [], blocked: needsHerdr },
};

/** As ações do menu do nó, na ordem em que aparecem. Fora dela: `text` e `keys` (terminal cru). */
export const MENU_ACTIONS: readonly ActionName[] = [
  "approve_permission", "deny_permission", "answer", "prompt", "resume", "phase", "escalate", "park", "free_prompt", "done", "stop_session",
];

/** `true` se a rota exige `confirm` para a ação. */
export const isDangerousAction = (key: ActionName): boolean => ROWS[key].dangerous;

/**
 * O menu de um nó. Só agente recebe ação (gate, PR e unidade: lista vazia). Para agente vêm todas as de `MENU_ACTIONS`;
 * as que não valem agora levam `available: false` e o `reason`, para a tela mostrar desabilitada com o motivo.
 */
export function actionsFor(node: ActionNode, ctx: ActionContext = {}): ActionItem[] {
  if (node.type !== "agent") return [];
  return MENU_ACTIONS.map((key) => {
    const row = ROWS[key];
    const reason = row.blocked(node, ctx);
    const item: ActionItem = { key, label: row.label, hint: row.hint, dangerous: row.dangerous, available: reason === undefined, fields: row.fields(node) };
    return reason === undefined ? item : { ...item, reason };
  });
}

/** O corpo do POST de uma ação. `confirm` (o que o dono digitou) segue como veio: quem confere é o servidor. */
export function actionRequest(node: Pick<ActionNode, "id">, key: ActionName, args: Record<string, unknown> = {}, confirm?: string): ActionRequest {
  return confirm === undefined ? { node: node.id, action: key, args } : { node: node.id, action: key, args, confirm };
}
