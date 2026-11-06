// Tipos de nó e comandos do Argos de hoje, registrados pelas mesmas funções de registro que um plugin usaria
// (reference/argos.md §Tipos de nó e comandos). O desenho de cada nó e a lista de ações vêm de fora (a página os tem):
// aqui só se declara o que o registro pede, em um lugar só. Sem dependência de Node.
import { createCommandRegistry, type CommandDef, type CommandRegistry } from "./canvas-commands.ts";
import { createNodeTypeRegistry, type NodeRender, type NodeTypeDef, type NodeTypeRegistry } from "./canvas-types.ts";

/** Tamanho do cartão do nó do Argos (o mesmo da página em colunas que o canvas substitui). */
export const ARGOS_NODE_SIZE: Readonly<{ w: number; h: number }> = Object.freeze({ w: 200, h: 66 });

/** Ação do servidor (`POST /api/argos/action`) como o registro precisa vê-la. */
export interface ArgosActionRef { id: string; label: string; hint: string }
export interface ArgosStateFilterRef { value: string; label: string }

export type ArgosView = "graph" | "list";

/** O que a página oferece para os comandos executarem. */
export interface ArgosHandlers {
  palette(): void;
  next(): void;
  prev(): void;
  open(): void;
  close(): void;
  fit(): void;
  toggleView(): void;
  help(): void;
  setView(view: ArgosView): void;
  setStateFilter(value: string): void;
  runAction(id: string): void;
  undo(): void;
  redo(): void;
}

/** Contexto das condições e dos rótulos: o que está selecionado e o que o servidor oferece agora. */
export interface ArgosCommandCtx {
  selectedLabel: string | null;
  /** Ids das ações oferecidas ao nó selecionado agora (aprovar só com pedido pendente, responder só com pergunta aberta). */
  availableActions: readonly string[];
  canUndo: boolean;
  canRedo: boolean;
  handlers: ArgosHandlers;
}

export const ACTION_COMMAND_PREFIX = "action:";
export const FILTER_COMMAND_PREFIX = "filter:";
export const actionCommandId = (actionId: string): string => `${ACTION_COMMAND_PREFIX}${actionId}`;

/** Atalho de uma tecla por ação (as demais só pela paleta e pelo menu). */
const ACTION_SHORTCUTS: Readonly<Record<string, string>> = { approve_permission: "a", deny_permission: "x", prompt: "p", resume: "r" };
const GROUP_NODE = "Ação no nó selecionado";
const GROUP_VIEW = "Vista";
const GROUP_FILTER = "Filtros";

export type Shape = "circle" | "square" | "diamond" | "hexagon";

/** Tipo de nó: rótulo, ícone e forma. A forma é o canal que não depende de cor (L3). */
const ARGOS_TYPE_ROWS: readonly { type: string; label: string; icon: string; shape: Shape }[] = [
  { type: "unit", label: "Unidade", icon: "ClipboardList", shape: "square" },
  { type: "agent", label: "Agente", icon: "Bot", shape: "circle" },
  { type: "pr", label: "PR", icon: "GitPullRequest", shape: "diamond" },
  { type: "gate", label: "Fila do gate", icon: "ListOrdered", shape: "hexagon" },
];

export function argosCommandDefs(deps: { actions: readonly ArgosActionRef[]; stateFilters: readonly ArgosStateFilterRef[] }): CommandDef<ArgosCommandCtx>[] {
  const defs: CommandDef<ArgosCommandCtx>[] = [
    { id: "palette", label: "Abrir a paleta", group: GROUP_VIEW, shortcut: ["mod+k", "/"], surfaces: [], run: (ctx) => ctx.handlers.palette() },
    { id: "next", label: "Próximo nó", group: GROUP_VIEW, shortcut: "j", surfaces: [], run: (ctx) => ctx.handlers.next() },
    { id: "prev", label: "Nó anterior", group: GROUP_VIEW, shortcut: "k", surfaces: [], run: (ctx) => ctx.handlers.prev() },
    { id: "open", label: "Abrir o detalhe do nó", group: GROUP_VIEW, shortcut: "Enter", surfaces: [], run: (ctx) => ctx.handlers.open() },
    { id: "close", label: "Fechar o detalhe do nó", group: GROUP_VIEW, shortcut: "Escape", surfaces: [], inEditable: true, run: (ctx) => ctx.handlers.close() },
    { id: "fit", label: "Enquadrar o canvas", hint: "tudo na tela", group: GROUP_VIEW, shortcut: "f", surfaces: ["palette", "canvas-menu"], run: (ctx) => ctx.handlers.fit() },
    { id: "toggle-view", label: "Alternar canvas e lista", group: GROUP_VIEW, shortcut: "l", surfaces: [], run: (ctx) => ctx.handlers.toggleView() },
    { id: "help", label: "Atalhos de teclado", hint: "?", group: GROUP_VIEW, shortcut: "?", surfaces: ["palette", "canvas-menu"], run: (ctx) => ctx.handlers.help() },
    { id: "view:graph", label: "Ver o canvas", hint: "principal", group: GROUP_VIEW, surfaces: ["palette", "canvas-menu"], run: (ctx) => ctx.handlers.setView("graph") },
    { id: "view:list", label: "Ver lista", hint: "boa no celular", group: GROUP_VIEW, surfaces: ["palette", "canvas-menu"], run: (ctx) => ctx.handlers.setView("list") },
    // inEditable: false: com o foco num campo de texto, Ctrl+Z é do campo, não do canvas
    { id: "undo", label: "Desfazer", hint: "última mudança de posição ou tamanho", group: GROUP_VIEW, shortcut: "mod+z", surfaces: ["palette", "canvas-menu"], inEditable: false, when: (ctx) => ctx.canUndo, run: (ctx) => ctx.handlers.undo() },
    { id: "redo", label: "Refazer", group: GROUP_VIEW, shortcut: "mod+shift+z", surfaces: ["palette", "canvas-menu"], inEditable: false, when: (ctx) => ctx.canRedo, run: (ctx) => ctx.handlers.redo() },
  ];
  for (const action of deps.actions) {
    const shortcut = ACTION_SHORTCUTS[action.id];
    defs.push({
      id: actionCommandId(action.id),
      label: (ctx) => `${action.label}${ctx.selectedLabel ? ` · ${ctx.selectedLabel}` : ""}`,
      hint: action.hint,
      group: GROUP_NODE,
      ...(shortcut ? { shortcut } : {}),
      surfaces: ["palette", "node-menu"],
      when: (ctx) => ctx.availableActions.includes(action.id),
      run: (ctx) => ctx.handlers.runAction(action.id),
    });
  }
  for (const filter of deps.stateFilters) {
    defs.push({
      id: `${FILTER_COMMAND_PREFIX}${filter.value}`,
      label: `Filtrar: ${filter.label}`,
      hint: "estado",
      group: GROUP_FILTER,
      surfaces: ["palette", "canvas-menu"],
      run: (ctx) => ctx.handlers.setStateFilter(filter.value),
    });
  }
  return defs;
}

export function argosNodeTypeDefs(deps: { actions: readonly ArgosActionRef[]; render: (type: string) => NodeRender }): NodeTypeDef[] {
  return ARGOS_TYPE_ROWS.map((row) => {
    const hasActions = row.type === "agent";
    return {
      type: row.type,
      label: row.label,
      icon: row.icon,
      defaultSize: { ...ARGOS_NODE_SIZE },
      draw: { surface: "html", render: deps.render(row.type) },
      menu: hasActions ? deps.actions.map((action) => actionCommandId(action.id)) : [],
      actions: hasActions ? deps.actions.map((action) => action.id) : [],
      live: true,
    };
  });
}

export interface ArgosRegistries { types: NodeTypeRegistry; commands: CommandRegistry<ArgosCommandCtx> }

/** Registra os tipos e os comandos do Argos e confere que o menu de cada tipo só cita comando que existe. */
export function createArgosRegistries(deps: {
  actions: readonly ArgosActionRef[];
  stateFilters: readonly ArgosStateFilterRef[];
  render: (type: string) => NodeRender;
}): ArgosRegistries {
  const types = createNodeTypeRegistry();
  const commands = createCommandRegistry<ArgosCommandCtx>();
  for (const def of argosCommandDefs(deps)) commands.register(def);
  for (const def of argosNodeTypeDefs(deps)) commands.checkTypeMenu(types.register(def));
  return { types, commands };
}

// ------------------------------------------------------------------ cor, forma e legenda (L3)
// Tipo do nó = forma + ícone; estado do nó = cor + ícone + palavra. Nunca só cor: quem não distingue o tom lê a forma, o
// ícone ou a palavra. Esta é a única tabela de estados: a página, o corpo do nó, a lista e a legenda leem daqui.

/** Tom semântico; cada um é um token de cor do tema (`TONE_VAR`), que muda com o tema claro ou escuro. */
export type Tone = "vivo" | "warn" | "bad" | "info" | "muted";
export type Severity = "attention" | "stalled" | "normal";

export const TONE_VAR: Readonly<Record<Tone, string>> = Object.freeze({ vivo: "--vivo", warn: "--warn", bad: "--bad", info: "--info", muted: "--muted-foreground" });

export interface StateLook { tone: Tone; icon: string; word: string }

const STATE_LOOKS: Readonly<Record<string, StateLook>> = Object.freeze({
  working: { tone: "vivo", icon: "Activity", word: "trabalhando" },
  blocked: { tone: "warn", icon: "Hand", word: "espera por você" },
  idle: { tone: "info", icon: "Moon", word: "ocioso" },
  done: { tone: "muted", icon: "CircleCheck", word: "concluído" },
  archived: { tone: "muted", icon: "Archive", word: "arquivado" },
  fora: { tone: "muted", icon: "Unplug", word: "fora do herdr" },
  unknown: { tone: "muted", icon: "CircleHelp", word: "sem agente" },
  planned: { tone: "muted", icon: "CircleDashed", word: "planejada" },
  open: { tone: "info", icon: "CircleDot", word: "aberta" },
  merged: { tone: "muted", icon: "GitMerge", word: "mergeada" },
  closed: { tone: "muted", icon: "CircleX", word: "fechada" },
  running: { tone: "vivo", icon: "Play", word: "rodando" },
  waiting: { tone: "info", icon: "Hourglass", word: "na fila" },
});
const ATTENTION_LOOK: StateLook = { tone: "warn", icon: "Hand", word: "espera por você" };
const STALLED_LOOK: StateLook = { tone: "bad", icon: "Clock", word: "parado" };

/** Estado como o servidor o entrega; `severity` (da página: pede você, parado) vale mais que o estado. Estado novo aparece com a própria palavra. */
export function stateLook(state: string, severity: Severity = "normal"): StateLook {
  if (severity === "attention") return ATTENTION_LOOK;
  if (severity === "stalled") return STALLED_LOOK;
  return STATE_LOOKS[state] ?? { tone: "muted", icon: "CircleHelp", word: state };
}

export interface TypeLook { type: string; label: string; icon: string; shape: Shape }

export function typeLook(type: string): TypeLook {
  const row = ARGOS_TYPE_ROWS.find((r) => r.type === type);
  return row ? { ...row } : { type, label: type, icon: "CircleHelp", shape: "square" };
}

/** Os vértices da forma dentro do retângulo, em ordem de desenho, para o canvas (a forma longe do zoom) e para o SVG de perto. */
export function shapePoints(shape: Shape, x: number, y: number, w: number, h: number): [number, number][] {
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (shape) {
    case "square":
      return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    case "diamond":
      return [[cx, y], [x + w, cy], [cx, y + h], [x, cy]];
    case "hexagon":
      return [[x + w * 0.25, y], [x + w * 0.75, y], [x + w, cy], [x + w * 0.75, y + h], [x + w * 0.25, y + h], [x, cy]];
    case "circle": {
      const steps = 16;
      return Array.from({ length: steps }, (_, i): [number, number] => [cx + (w / 2) * Math.cos((2 * Math.PI * i) / steps), cy + (h / 2) * Math.sin((2 * Math.PI * i) / steps)]);
    }
    default: {
      const unreachable: never = shape;
      throw new Error(`forma desconhecida: ${String(unreachable)}`);
    }
  }
}

// ------------------------------------------------------------------ indicadores no nó (T1, T2)

export type IndicatorKind = "permission" | "question" | "context" | "gate" | "ci" | "pr" | "cost" | "herdr";
export interface Indicator { kind: IndicatorKind; icon: string; tone: Tone; short: string; label: string }

export interface CiCounts { passing: number; failing: number; pending: number }
export type GateState = "running" | "waiting" | "failed";

/** O que os indicadores leem de um nó do grafo (campo a mais é ignorado; campo ausente é indicador ausente). */
export interface IndicatorNode {
  type: string;
  state: string;
  herdrState?: string | null;
  pendingPermission?: { tool: string | null } | null;
  openQuestions?: number | null;
  /** sessão do agente acima do teto de contexto do papel (`argos-graph`); ausente = dentro do teto */
  ctxOver?: { usedK: number; capK: number } | null;
  gate?: string | null;
  costUsd?: number | null;
  estimateUsd?: number | null;
  pr?: number | null;
  ci?: Partial<CiCounts> | null;
}

/** Os limites do custo × estimado seguem os padrões da Moirai (`HADES_MOIRAI_WARN_PCT` e `HADES_MOIRAI_ASK_PCT`); o navegador não lê a configuração. */
export const COST_WARN_PCT = 100;
export const COST_BAD_PCT = 150;

const GATE_LOOKS: Readonly<Record<GateState, { icon: string; tone: Tone; short: string; label: string }>> = Object.freeze({
  running: { icon: "Play", tone: "vivo", short: "gate", label: "Gate rodando" },
  waiting: { icon: "Hourglass", tone: "info", short: "fila", label: "Gate esperando na fila" },
  failed: { icon: "OctagonAlert", tone: "bad", short: "falhou", label: "Gate falhou" },
});
export type CiVerdict = "passed" | "failed" | "running";
const CI_LOOKS: Readonly<Record<CiVerdict, { icon: string; tone: Tone; short: string; label: string }>> = Object.freeze({
  passed: { icon: "CircleCheck", tone: "muted", short: "CI", label: "CI passou" },
  failed: { icon: "CircleX", tone: "bad", short: "CI", label: "CI falhou" },
  running: { icon: "Loader", tone: "warn", short: "CI", label: "CI rodando" },
});
/** Ordem de importância: o que pede o dono primeiro; o que couber é mostrado. */
const KIND_ORDER: readonly IndicatorKind[] = ["permission", "question", "context", "gate", "ci", "pr", "cost", "herdr"];
const ICON_PERMISSION = "Hand";
const ICON_QUESTION = "MessageCircleQuestion";
const ICON_CONTEXT = "Gauge";
const ICON_PR = "GitPullRequest";
const ICON_COST = "CircleDollarSign";
const ICON_HERDR = "Terminal";

export function ciVerdict(ci: Partial<CiCounts> | null | undefined): CiVerdict | undefined {
  if (!ci) return undefined;
  const failing = Number(ci.failing) || 0;
  const pending = Number(ci.pending) || 0;
  const passing = Number(ci.passing) || 0;
  if (failing > 0) return "failed";
  if (pending > 0) return "running";
  return passing > 0 ? "passed" : undefined;
}

const isGateState = (value: string): value is GateState => Object.hasOwn(GATE_LOOKS, value);
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** US$ curto para o corpo do nó: centavos abaixo de 1, uma casa abaixo de 10, inteiro daí em diante. */
export function usdShort(usd: number): string {
  return usd < 1 ? usd.toFixed(2) : usd < 10 ? usd.toFixed(1) : String(Math.round(usd));
}
const usdLong = (usd: number): string => `US$ ${usd.toFixed(2).replace(".", ",")}`;

/** Custo sobre o estimado, em %, sem arredondar (como o `budgetOf` da Moirai: 99,5% ainda não passou do limite). */
export function costPct(costUsd: number, estimateUsd: number | null | undefined): number | null {
  return finite(estimateUsd) && estimateUsd > 0 ? (costUsd / estimateUsd) * 100 : null;
}

function costIndicator(costUsd: number, estimateUsd: number | null | undefined): Indicator {
  const pct = costPct(costUsd, estimateUsd);
  const tone: Tone = pct === null ? "muted" : pct >= COST_BAD_PCT ? "bad" : pct >= COST_WARN_PCT ? "warn" : "muted";
  const short = finite(estimateUsd) && pct !== null ? `$${usdShort(costUsd)}/${usdShort(estimateUsd)}` : `$${usdShort(costUsd)}`;
  const label = pct !== null && finite(estimateUsd) ? `Custo ${usdLong(costUsd)} de ${usdLong(estimateUsd)} estimados (${Math.round(pct)}%)` : `Custo ${usdLong(costUsd)}, sem estimativa`;
  return { kind: "cost", icon: ICON_COST, tone, short, label };
}

/** Os indicadores do nó, do mais para o menos importante. Cada um só existe quando o grafo trouxe o dado. */
export function nodeIndicators(node: IndicatorNode): Indicator[] {
  const found: Indicator[] = [];
  if (node.pendingPermission) {
    const tool = node.pendingPermission.tool;
    found.push({ kind: "permission", icon: ICON_PERMISSION, tone: "warn", short: "perm", label: `Pede permissão${tool ? ` para ${tool}` : ""}` });
  }
  const questions = Number(node.openQuestions) || 0;
  if (questions > 0) found.push({ kind: "question", icon: ICON_QUESTION, tone: "warn", short: String(questions), label: `${questions} pergunta${questions === 1 ? "" : "s"} aberta${questions === 1 ? "" : "s"} para o dono` });
  const over = node.ctxOver;
  if (over && finite(over.usedK) && finite(over.capK)) {
    found.push({ kind: "context", icon: ICON_CONTEXT, tone: "warn", short: `${over.usedK}k`, label: `Contexto em ${over.usedK}k, acima do teto do papel (${over.capK}k): estacionar` });
  }
  if (typeof node.gate === "string" && isGateState(node.gate)) found.push({ kind: "gate", ...GATE_LOOKS[node.gate] });
  const verdict = ciVerdict(node.ci);
  if (verdict) {
    const counts = node.ci as Partial<CiCounts>;
    found.push({ kind: "ci", ...CI_LOOKS[verdict], label: `${CI_LOOKS[verdict].label}: ${counts.passing ?? 0} passando, ${counts.failing ?? 0} falhando, ${counts.pending ?? 0} pendentes` });
  }
  if (Number.isInteger(node.pr) && (node.pr as number) > 0) found.push({ kind: "pr", icon: ICON_PR, tone: "muted", short: `#${node.pr}`, label: `PR ${node.pr}` });
  if (finite(node.costUsd)) found.push(costIndicator(node.costUsd, node.estimateUsd));
  // o estado do agente já é o do herdr; o chip só aparece quando os dois divergem (registro diz uma coisa, herdr outra)
  const herdr = node.type === "agent" ? node.herdrState : undefined;
  if (herdr && herdr !== node.state && herdr !== "fora") {
    const look = stateLook(herdr);
    found.push({ kind: "herdr", icon: ICON_HERDR, tone: look.tone, short: look.word, label: `No herdr: ${look.word}` });
  }
  return found.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

const CHIP_ICON_PX = 12;
const CHIP_GAP_PX = 4;
const CHIP_CHAR_PX = 6;
const MORE_CHIP_PX = 26;
const chipWidth = (i: Indicator): number => CHIP_ICON_PX + CHIP_GAP_PX + i.short.length * CHIP_CHAR_PX + CHIP_GAP_PX;

/** Os que cabem numa linha de `widthPx`, na ordem de importância; o resto vira `hidden` (o corpo mostra "+n" e o rótulo falado leva todos). */
export function fitIndicators(indicators: readonly Indicator[], widthPx: number): { shown: Indicator[]; hidden: number } {
  const shown: Indicator[] = [];
  let used = 0;
  for (const i of indicators) {
    const w = chipWidth(i);
    if (used + w > widthPx) break;
    shown.push(i);
    used += w;
  }
  while (shown.length < indicators.length && shown.length > 0 && used + MORE_CHIP_PX > widthPx) used -= chipWidth(shown.pop() as Indicator);
  return { shown, hidden: indicators.length - shown.length };
}

// ------------------------------------------------------------------ legenda

export interface LegendState { id: string; look: StateLook }
export interface LegendIndicator { kind: IndicatorKind; icon: string; tone: Tone; label: string }

/** Os estados que a legenda explica, na ordem em que se lê: o que pede você, o que vive, o que espera, o que acabou. */
const LEGEND_STATE_ROWS: readonly { id: string; state: string; severity?: Severity }[] = [
  { id: "attention", state: "blocked", severity: "attention" },
  { id: "stalled", state: "working", severity: "stalled" },
  { id: "working", state: "working" },
  { id: "running", state: "running" },
  { id: "idle", state: "idle" },
  { id: "open", state: "open" },
  { id: "waiting", state: "waiting" },
  { id: "planned", state: "planned" },
  { id: "merged", state: "merged" },
  { id: "closed", state: "closed" },
  { id: "done", state: "done" },
  { id: "archived", state: "archived" },
  { id: "fora", state: "fora" },
  { id: "unknown", state: "unknown" },
];

export function legendModel(): { types: TypeLook[]; states: LegendState[]; indicators: LegendIndicator[] } {
  const sample = (kind: IndicatorKind, node: Partial<IndicatorNode>): LegendIndicator => {
    const found = nodeIndicators({ type: "agent", state: "working", ...node }).find((i) => i.kind === kind) as Indicator;
    return { kind, icon: found.icon, tone: found.tone, label: found.label };
  };
  const ci = (counts: CiCounts): Partial<IndicatorNode> => ({ ci: counts });
  return {
    types: ARGOS_TYPE_ROWS.map((row) => ({ ...row })),
    states: LEGEND_STATE_ROWS.map((row) => ({ id: row.id, look: stateLook(row.state, row.severity) })),
    indicators: [
      sample("permission", { pendingPermission: { tool: null } }),
      sample("question", { openQuestions: 1 }),
      sample("context", { ctxOver: { usedK: 320, capK: 200 } }),
      ...(["running", "waiting", "failed"] as const).map((gate) => sample("gate", { gate })),
      ...[{ passing: 1, failing: 0, pending: 0 }, { passing: 0, failing: 1, pending: 0 }, { passing: 0, failing: 0, pending: 1 }].map((counts) => sample("ci", ci(counts))),
      sample("pr", { pr: 1 }),
      { ...sample("cost", { costUsd: 1, estimateUsd: 2 }), label: "Custo × estimado da Moirai (amarelo a partir de 100%, vermelho a partir de 150%)" },
      { ...sample("herdr", { herdrState: "idle" }), label: "Estado no herdr, quando difere do registro" },
    ],
  };
}
