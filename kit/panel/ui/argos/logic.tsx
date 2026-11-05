/* Regra pura da página Argos (#/argos): filtros, ações e confirmações, paleta e eventos. Posição dos nós, atalhos e comandos
 * são do canvas (src/lib/canvas-*.ts).
 * Sem DOM e sem React: o navegador carrega como script (window.ArgosLogic) e o bun test importa o mesmo arquivo. */

interface ArgosNode {
  id: string;
  type: string;
  label: string;
  role: string | null;
  state: string;
  lastEventTs: string | null;
  pendingPermission: { ts: string; tool: string | null } | null;
  registry?: string;
  [campo: string]: unknown;
}
interface ArgosEdge { from: string; to: string; kind: string }
interface ArgosGraph { v?: number; nodes?: ArgosNode[]; edges?: ArgosEdge[]; [campo: string]: unknown }
/**
 * O preset da barra. `hidden`: ids que o dono tirou do canvas (nunca aparecem). `agent`: o que mais o agente precisa passar
 * (arquivados e última atividade, de canvas-filters `passesAgentDims`); `narrowing` diz se ele estreita hoje (janela de
 * atividade marcada) e, como papel e estado, tira do desenho a unidade solta.
 */
interface ArgosFilters {
  registry: string;
  role: string;
  state: string;
  hidden?: ReadonlySet<string>;
  agent?: (n: ArgosNode) => boolean;
  narrowing?: boolean;
}
interface ArgosEvent { ts?: string; kind?: string; source?: string; tool?: string; summary?: string; session?: string }

type ArgosFieldKind = "text" | "textarea" | "select" | "check";
interface ArgosField { name: string; label: string; kind: ArgosFieldKind; required?: boolean; max?: number; pattern?: RegExp; options?: readonly string[] }
interface ArgosAction {
  id: string;
  /** Infinitivo para "Não deu para <verbo>". */
  verb: string;
  label: string;
  hint: string;
  icon: string;
  fields: readonly ArgosField[];
  destructive?: boolean;
  /** só com permissão pendente / pergunta aberta / sempre */
  needs?: "permission" | "question";
}
interface ArgosPaletteItem { id: string; label: string; hint: string; group: string; run: { type: "select" | "command" | "view" | "panel"; value: string } }
/** Entrada do registro de comandos como a paleta a recebe (src/lib/canvas-commands.ts). */
interface ArgosCommandRow { id: string; label: string; hint: string; group: string }
interface ArgosDetail { files?: { questions?: { openQuestions?: string[] } | null } | null }

/** Retângulo de um nó no documento do canvas (canto superior esquerdo e tamanho). */
interface ReadingRect { id: string; x: number; y: number; w: number; h: number }
interface ReadingPlacement { id: string; x: number; y: number }
/** O que a vizinhança (src/lib/canvas-neighbors.ts) devolve e a ênfase lê. */
interface ReadingNeighborhood { active: boolean; levels: readonly (readonly string[])[]; dimmed: readonly string[] }
/** O que o filtro (src/lib/canvas-filters.ts) lê de um nó. */
interface ReadingFilterNode { id: string; type: string; state: string; role: string | null; registry: string | null; lastEventTs: string | null; costUsd: number | null }
/** O que a busca (src/lib/canvas-search.ts) lê de um nó, com a caixa dele. */
interface ReadingSearchItem extends ReadingRect { label: string; card: string | null; number: number | null; branch: string | null; files: string[] }
type ReadingLayout = "free" | "force";
/** O que os comandos da leitura do grafo leem do contexto da página (somado ao contexto dos comandos do Argos). */
interface ReadingCommandCtx {
  reading: { layout: ReadingLayout; running: boolean; nodeId: string | null; pinned: boolean; searching: boolean; filtering: boolean };
  handlers: {
    openFilters(): void; toggleLayout(): void; arrange(): void; stopLayout(): void; togglePin(id: string): void;
    focusSearch(): void; clearSearch(): void; clearFilters(): void; saveView(): void;
  };
}
interface ReadingCommandDef {
  id: string;
  label: string | ((ctx: ReadingCommandCtx) => string);
  hint?: string;
  group: string;
  shortcut?: string;
  surfaces: readonly ("palette" | "node-menu" | "canvas-menu")[];
  when?: (ctx: ReadingCommandCtx) => boolean;
  inEditable?: boolean;
  run: (ctx: ReadingCommandCtx) => void;
}

/** Política do portal no navegador, na forma que `canvas-portal.ts` lê (`PortalPolicy`). */
interface MountPortalPolicy { exact: ReadonlySet<string>; suffixes: readonly string[]; ignored: readonly string[] }
/** O que os comandos `user:*` do menu dos nós do usuário fazem; cada um tem o id que `types-user.tsx` cita no `menu`. */
type UserMenuKind = "edit" | "duplicate" | "blur" | "remove" | "copyCommands" | "linkNote";
interface UserMenuCtx { reading: { nodeId: string | null }; handlers: { userMenu(kind: UserMenuKind, nodeId: string): void } }
interface UserMenuCommandDef {
  id: string;
  label: string;
  group: string;
  surfaces: readonly "node-menu"[];
  when: (ctx: UserMenuCtx) => boolean;
  run: (ctx: UserMenuCtx) => void;
}
/** A ação do agente escolhida no menu das camadas (`ActionItem` de `canvas-actions.ts`, só o que a rota lê). */
interface OverlayMenuAction {
  key: string;
  dangerous: boolean;
  fields: readonly { name: string; required: boolean; kind: string }[];
}
/**
 * Por onde a página roda a ação do menu: o balão do nó (mensagem), o diálogo de ações da página, um envio direto (no máximo
 * um campo de texto e, se destrutiva, a frase com o nome do agente) ou nenhum, quando o campo pede escolha que só o painel do
 * nó tem (sessão, fase, pergunta).
 */
type OverlayActionRoute =
  | { kind: "balloon" }
  | { kind: "dialog"; id: string }
  | { kind: "direct"; textField: { name: string; required: boolean } | null; confirm: boolean }
  | { kind: "unsupported" };
/** O nó das camadas sobre o canvas (`OverlayNode` de `canvas-overlays.tsx`): o dado das ações e o retângulo no mundo. */
interface OverlayNodeOut<N> { node: N; rect: { x: number; y: number; w: number; h: number } }
interface OverlayDocNode { id: string; type: string; x: number; y: number; w: number; h: number }
interface MountNode { id: string; type: string; data: Record<string, unknown> }
interface MountDoc { nodes: readonly MountNode[] }
/** A parte de `canvas-note` e `canvas-history` que o texto dos nós do usuário usa. */
interface MountTextModels<Op> {
  note: { opEditText(doc: MountDoc, id: string, text: string, style?: string): Op | undefined };
  history: { opDelete(doc: MountDoc, ids: readonly string[]): Op };
}
/** Por onde o texto vira passo do desfazer: `commit` aplica pela pilha e lança o erro com código se o documento recusar. */
interface MountTextPort<Op> { doc(): MountDoc | null; commit(op: Op): void; fail(code: string | undefined): void }
interface MountTypeDef { type: string; menu: readonly string[] }
interface MountRegistries {
  types: { has(type: string): boolean };
  commands: { get(id: string): unknown; register(def: UserMenuCommandDef): unknown; checkTypeMenu(def: MountTypeDef): void };
}
/** Os scripts que a montagem liga (window.ArgosCanvasCommands, ArgosTypesUser, ArgosTypesLive). */
interface MountParts {
  canvasCommands: { registerCanvasCommands(commands: MountRegistries["commands"], api: object): { registered: string[]; refused: { id: string; code: string }[] } };
  typesUser: { MENU: Readonly<Record<UserMenuKind, string>>; registerUserTypes(types: MountRegistries["types"], deps: object): MountTypeDef[] };
  typesLive: { registerLiveTypes(types: MountRegistries["types"], deps: object): MountTypeDef[] };
}
interface MountReport { refused: { id: string; code: string }[] }

function makeArgosLogic() {
  const NODE_TYPES: readonly string[] = ["unit", "agent", "pr", "gate"];
  const NODE_W = 200;
  const NODE_H = 66;
  // grupo dos comandos de ação no nó (src/lib/canvas-argos.ts): vêm antes de "Ir para o nó" na paleta
  const ACTION_GROUP = "Ação no nó selecionado";
  const STALL_MS = 10 * 60 * 1000;
  const EVENTS_CAP = 300;
  const TEXT_MAX = 20000;
  const HERDR_KEYS = ["Enter", "Escape", "Ctrl+C", "Tab", "Up", "Down", "Left", "Right", "y", "n"] as const;
  const EDGE_KINDS = ["stack", "consolidation", "depends_on", "agent_pr", "agent_gate", "orchestrates"] as const;

  const STATE_FILTERS: readonly { value: string; label: string }[] = [
    { value: "all", label: "Todos" }, { value: "active", label: "Ativos" }, { value: "attention", label: "Esperam por você" }, { value: "working", label: "Trabalhando" },
    { value: "stalled", label: "Sem sinal" }, { value: "idle", label: "Ociosos ou sem terminal" }, { value: "done", label: "Concluídos" },
  ];

  // Códigos estáveis de POST /api/argos/action (reference/argos.md §Erros); quem consome ramifica pelo código, nunca pelo texto.
  const ERROR_TEXT: Readonly<Record<string, string>> = {
    unknown_action: "Ação desconhecida nesta versão do painel.",
    invalid_args: "Campo com formato ou tamanho inválido.",
    invalid_node: "Nó inválido.",
    unknown_node: "Agente não registrado (talvez já encerrado).",
    invalid_query: "Consulta inválida.",
    confirm_required: "Digite o nome do agente.",
    action_failed: "O agente ou o terminal recusou.",
    action_timeout: "A ação demorou demais e foi interrompida.",
    permission_not_pending: "Sem permissão pendente: o agente já seguiu.",
    permission_not_supported: "Este pedido só se responde no terminal.",
    internal_error: "Erro interno; detalhe no log do painel.",
    canvas_stale_revision: "O canvas mudou em outra aba.",
    canvas_too_large: "O canvas passou do tamanho aceito.",
    canvas_unreadable: "O arquivo do canvas no painel está ilegível.",
    canvas_save_unreachable: "Sem resposta do painel ao gravar. Muitas abas do painel abertas esgotam as conexões do navegador: feche as que não usa.",
    canvas_save_conflict: "Outra aba gravou o canvas e a junção não coube.",
    canvas_mass_removal: "O canvas recusou apagar tantos nós de uma vez sem confirmação, e nada foi gravado. Desfaça (Ctrl+Z) ou recarregue a página; se a remoção é de propósito, apague de novo.",
    graph_failed: "O painel não conseguiu montar o grafo dos agentes.",
    graph_unreachable: "Sem resposta do painel.",
    http_403: "O painel recusou o pedido; recarregue a página.",
    http_500: "O painel falhou ao responder.",
    view_name_empty: "Dê um nome à vista.",
    view_name_too_long: "Nome de vista com mais de 60 caracteres.",
    view_name_taken: "Já existe uma vista com esse nome.",
    view_not_found: "Essa vista não existe mais.",
    view_limit: "Limite de 50 vistas salvas: exclua uma antes.",
    view_invalid_camera: "A câmera atual não pode ser salva.",
    force_too_many_nodes: "Nós demais para o layout automático.",
    force_too_many_springs: "Ligações demais para o layout automático.",
    force_diverged: "O layout automático saiu do controle e foi parado; as posições ficaram como estavam.",
    force_invalid_input: "Nó com posição ou tamanho inválido: o layout automático não rodou.",
    search_term_too_long: "Busca longa demais: só os primeiros 100 caracteres valem.",
    urlstate_invalid: "O endereço trazia uma vista ilegível; abrindo a vista padrão.",
    urlstate_unsupported_version: "O endereço é de outra versão do painel; abrindo a vista padrão.",
    urlstate_too_long: "O endereço passou do tamanho aceito; abrindo a vista padrão.",
  };

  const ACTIONS: readonly ArgosAction[] = [
    { id: "approve_permission", verb: "aprovar a permissão", label: "Aprovar permissão", hint: "Aprova só este pedido, uma vez: Enter no terminal do agente", icon: "ShieldCheck", fields: [], needs: "permission" },
    { id: "deny_permission", verb: "negar a permissão", label: "Negar permissão", hint: "Nega só este pedido: Escape no terminal do agente", icon: "ShieldX", fields: [], needs: "permission" },
    { id: "prompt", verb: "enviar o prompt", label: "Enviar prompt", hint: "Manda a tarefa do brief, ou o texto abaixo. Equivale a: hades agent prompt", icon: "SendHorizontal",
      fields: [{ name: "text", label: "Texto (vazio: tarefa do brief)", kind: "textarea", max: TEXT_MAX }] },
    { id: "resume", verb: "retomar o agente", label: "Retomar", hint: "Sessão limpa continuando do handoff.md, depois de estacionar ou do teto de contexto. Equivale a: hades agent resume", icon: "Play",
      fields: [{ name: "text", label: "Texto opcional", kind: "textarea", max: TEXT_MAX }] },
    { id: "phase", verb: "mudar de fase", label: "Mudar de fase", hint: "Limpa a sessão do agente (/clear) e manda o prompt da fase nova: o contexto atual se perde. Equivale a: hades agent phase", icon: "Flag",
      fields: [{ name: "phase", label: "Fase (ex.: review)", kind: "text", required: true, max: 40, pattern: /^[\w .-]+$/ },
        { name: "text", label: "Texto opcional", kind: "textarea", max: TEXT_MAX }] },
    { id: "answer", verb: "responder a pergunta", label: "Responder pergunta", hint: "Responde a pergunta que o agente deixou em questions.md. Equivale a: hades agent answer", icon: "Reply", needs: "question",
      fields: [{ name: "question", label: "Pergunta", kind: "select", required: true, pattern: /^Q\d+$/ },
        { name: "reply", label: "Resposta", kind: "textarea", required: true, max: TEXT_MAX }] },
    { id: "escalate", verb: "escalar o agente", label: "Escalar", hint: "Estaciona o agente e abre um terminal novo; falta um passo seu: iniciar nele a sessão com o modelo de escalada. Equivale a: hades agent escalate", icon: "Siren",
      fields: [{ name: "reason", label: "Motivo", kind: "textarea", required: true, max: 400 }] },
    { id: "free_prompt", verb: "digitar o prompt", label: "Digitar e dar Enter", hint: "Digita o prompt no terminal e aperta Enter, quando o agente estiver pronto", icon: "Type",
      fields: [{ name: "text", label: "Prompt", kind: "textarea", required: true, max: TEXT_MAX }] },
    { id: "text", verb: "digitar no terminal", label: "Digitar sem Enter", hint: "Digita no terminal sem apertar Enter", icon: "Keyboard",
      fields: [{ name: "text", label: "Texto literal", kind: "textarea", required: true, max: TEXT_MAX }] },
    { id: "keys", verb: "apertar a tecla", label: "Apertar uma tecla", hint: "Aperta uma tecla no terminal do agente, uma por vez", icon: "CornerDownLeft",
      fields: [{ name: "keys", label: "Tecla", kind: "select", required: true, options: HERDR_KEYS }] },
    { id: "done", verb: "encerrar o agente", label: "Encerrar agente", hint: "Confere report DONE, git limpo e PR aberta; libera o lock e fecha o terminal. A worktree fica enquanto a PR estiver aberta. Equivale a: hades agent done", icon: "OctagonX", destructive: true,
      fields: [{ name: "keepPane", label: "Manter o terminal aberto", kind: "check" }] },
  ];

  /** Título do aviso de falha: "Não deu para <verbo>" (a causa vai na descrição). */
  const actionFailTitle = (id: string): string => {
    const verb = ACTIONS.find((a) => a.id === id)?.verb;
    return `Não deu para ${verb ?? "rodar a ação"}`;
  };

  const tsMs = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  };

  const needsAttention = (n: ArgosNode): boolean => (n.pendingPermission !== null && n.pendingPermission !== undefined) || n.state === "blocked";
  /** "Parado": trabalhando no herdr, mas sem evento no diário há mais que STALL_MS. */
  const isStalled = (n: ArgosNode, now: number): boolean => {
    if (n.type !== "agent" || n.state !== "working") return false;
    const last = tsMs(n.lastEventTs);
    return last !== null && now - last > STALL_MS;
  };
  const severity = (n: ArgosNode, now: number): "attention" | "stalled" | "normal" =>
    needsAttention(n) ? "attention" : isStalled(n, now) ? "stalled" : "normal";

  const matchesState = (n: ArgosNode, filter: string, now: number): boolean => {
    switch (filter) {
      case "all": return true;
      case "active": return n.state !== "done" && n.state !== "archived";
      case "attention": return needsAttention(n);
      case "stalled": return isStalled(n, now);
      case "working": return n.state === "working";
      case "idle": return n.state === "idle" || n.state === "fora" || n.state === "unknown";
      case "done": return n.state === "done" || n.state === "archived";
      default: return true;
    }
  };

  const validNodes = (g: ArgosGraph | null | undefined): ArgosNode[] =>
    (g?.nodes ?? []).filter((n) => n && typeof n.id === "string" && NODE_TYPES.includes(n.type));

  const filterOptions = (g: ArgosGraph | null | undefined): { registries: string[]; roles: string[] } => {
    const nodes = validNodes(g);
    const registries = [...new Set(nodes.map((n) => n.registry).filter((r): r is string => typeof r === "string" && r !== ""))].sort();
    const roles = [...new Set(nodes.filter((n) => n.type === "agent").map((n) => n.role).filter((r): r is string => typeof r === "string" && r !== ""))].sort();
    return { registries, roles };
  };

  /**
   * Nós e arestas que passam nos filtros. Agente decide; unidade segue a raiz; PR e gate aparecem ligados a agente visível.
   * Oculto nunca aparece; nó ligado só a agentes ocultos ou podados por `agent` sai junto com eles, mesmo em "Todos".
   */
  const filterGraph = (g: ArgosGraph | null | undefined, f: ArgosFilters, now: number): { nodes: ArgosNode[]; edges: ArgosEdge[] } => {
    const all = validNodes(g);
    const edgesAll = (g?.edges ?? []).filter((e) => EDGE_KINDS.includes(e.kind as (typeof EDGE_KINDS)[number]));
    const hidden = f.hidden ?? new Set<string>();
    const pruned = (n: ArgosNode): boolean => hidden.has(n.id) || (f.agent !== undefined && !f.agent(n));
    const agentOk = (n: ArgosNode): boolean =>
      !pruned(n) && (f.registry === "all" || n.registry === f.registry) && (f.role === "all" || n.role === f.role) && matchesState(n, f.state, now);
    const agents = all.filter((n) => n.type === "agent");
    const visible = new Set(agents.filter(agentOk).map((n) => n.id));
    const prunedAgents = new Set(agents.filter(pruned).map((n) => n.id));
    const touches = (id: string, set: ReadonlySet<string>): boolean =>
      edgesAll.some((e) => (e.from === id && set.has(e.to)) || (e.to === id && set.has(e.from)));
    const narrowed = f.role !== "all" || f.state !== "all" || f.narrowing === true;
    for (const n of all) {
      if (n.type === "agent" || hidden.has(n.id)) continue;
      if (touches(n.id, visible)) visible.add(n.id);
      else if (!narrowed && !touches(n.id, prunedAgents) && (f.registry === "all" || n.registry === f.registry || (n.registry === undefined && n.type === "gate"))) visible.add(n.id);
    }
    return { nodes: all.filter((n) => visible.has(n.id)), edges: edgesAll.filter((e) => visible.has(e.from) && visible.has(e.to)) };
  };

  const filterKey = (f: ArgosFilters): string => `${f.registry}|${f.role}|${f.state}`;

  /** Vizinho do nó selecionado na ordem dada (j/k); sem seleção, o primeiro (ou o último). */
  const neighbor = (order: readonly ArgosNode[], selected: string | null, dir: 1 | -1): string | null => {
    if (!order.length) return null;
    const i = order.findIndex((n) => n.id === selected);
    if (i < 0) return (dir === 1 ? order[0] : order[order.length - 1])?.id ?? null;
    return order[(i + dir + order.length) % order.length]?.id ?? null;
  };

  const needsConfirm = (actionId: string): boolean => ACTIONS.find((a) => a.id === actionId)?.destructive === true;
  /** `typedRequired` = a preferência "digitar o nome" (HADES_CONFIRM_TYPED); desligada, o servidor também dispensa o `confirm`. */
  const confirmMatches = (typed: string, node: Pick<ArgosNode, "label">, typedRequired = true): boolean => !typedRequired || typed === node.label;

  const questionIds = (detail: ArgosDetail | null | undefined): string[] =>
    (detail?.files?.questions?.openQuestions ?? []).map((q) => /^(Q\d+)\b/.exec(q)?.[1]).filter((q): q is string => !!q);

  /** Ações oferecidas ao nó: aprovar/negar só com pedido pendente, responder só com pergunta aberta. */
  const availableActions = (node: ArgosNode | null, detail: ArgosDetail | null | undefined): ArgosAction[] => {
    if (!node || node.type !== "agent") return [];
    return ACTIONS.filter((a) => (a.needs === "permission" ? !!node.pendingPermission : a.needs === "question" ? questionIds(detail).length > 0 : true));
  };

  type FieldCheck = { ok: true; args: Record<string, string | boolean | string[]> } | { ok: false; field: string; reason: string };
  /** Confere o formato antes de enviar (o servidor confere de novo); texto vazio opcional não vai no corpo. */
  const validateArgs = (action: ArgosAction, raw: Readonly<Record<string, string | boolean | undefined>>): FieldCheck => {
    const args: Record<string, string | boolean | string[]> = {};
    for (const f of action.fields) {
      const v = raw[f.name];
      if (f.kind === "check") { if (v === true) args[f.name] = true; continue; }
      const s = typeof v === "string" ? v : "";
      if (s.trim() === "") {
        if (f.required) return { ok: false, field: f.name, reason: `${f.label}: obrigatório` };
        continue;
      }
      if (f.max !== undefined && s.length > f.max) return { ok: false, field: f.name, reason: `${f.label}: até ${f.max} caracteres` };
      if (f.pattern && !f.pattern.test(s)) return { ok: false, field: f.name, reason: `${f.label}: formato inválido` };
      if (f.options && !f.options.includes(s)) return { ok: false, field: f.name, reason: `${f.label}: opção inválida` };
      args[f.name] = f.name === "keys" ? [s] : s;
    }
    return { ok: true, args };
  };

  /** Corpo do POST. `confirm` só vai nas destrutivas. */
  const buildBody = (node: Pick<ArgosNode, "id">, action: ArgosAction, args: Record<string, unknown>, typed: string): Record<string, unknown> =>
    action.destructive ? { node: node.id, action: action.id, args, confirm: typed } : { node: node.id, action: action.id, args };

  const errorText = (code: string | undefined, fallback: string): string => (code !== undefined && Object.hasOwn(ERROR_TEXT, code) ? (ERROR_TEXT[code] as string) : fallback);

  // Erro persistente de leitura e de gravação: o código vira frase (nunca aparece cru) e a frase diz o que continua valendo.
  const GRAPH_RETRY_S = 4;
  const SAVE_RETRY_S = 5;
  /** Falhas seguidas de gravação a partir das quais o selo deixa de ser discreto e fala por extenso, em vermelho. */
  const SAVE_LOUD_AFTER = 3;
  const graphErrorText = (code: string | undefined): string => errorText(code, "O painel recusou a leitura dos agentes.");
  const saveBadgeOf = (code: string | undefined, fails: number): { label: string; title: string; loud: boolean } => {
    const why = errorText(code, "a gravação foi recusada");
    return {
      label: fails >= SAVE_LOUD_AFTER ? `Não deu para gravar o canvas: ${why.replace(/\.$/, "")}` : "Sem salvar",
      title: `${why} Suas mudanças seguem na tela; tento de novo a cada ${SAVE_RETRY_S} s.${code ? ` (código: ${code})` : ""}`,
      loud: fails >= SAVE_LOUD_AFTER,
    };
  };

  const eventKey = (e: ArgosEvent): string => `${e.ts ?? ""}|${e.kind ?? ""}|${e.session ?? ""}|${e.summary ?? ""}`;
  /** Junta o histórico com o que chega pelo SSE, sem duplicar, em ordem de tempo, só os últimos `cap`. */
  const mergeEvents = (a: readonly ArgosEvent[], b: readonly ArgosEvent[], cap: number = EVENTS_CAP): ArgosEvent[] => {
    const seen = new Map<string, ArgosEvent>();
    for (const e of [...a, ...b]) if (e && typeof e === "object") seen.set(eventKey(e), e);
    const out = [...seen.values()].sort((x, y) => (x.ts ?? "").localeCompare(y.ts ?? ""));
    return out.length > cap ? out.slice(out.length - cap) : out;
  };
  const eventTone = (e: ArgosEvent): "bad" | "warn" | "ok" | "idle" => {
    const k = e.kind ?? "";
    if (k === "tool_blocked" || k === "gate.timeout" || k === "cerberus.barra") return "bad";
    if (k === "permission" || k === "notification" || k === "cerberus.aviso") return "warn";
    if (k === "stop" || k === "gate.done" || k === "watch.done") return "ok";
    return "idle";
  };

  const PANEL_GROUP = "Painel";
  const PANEL_GO = "go:";
  const PANEL_THEME = "theme";
  const PANEL_FREEZE = "freeze";
  const PANEL_TOUR = "tour";
  /** Grupo "Painel" da paleta: ir para outra página, trocar o tema, congelar a atualização (o Argos não tem a barra do topo) e, se a página tem tour, "Tour desta página". */
  const panelItems = (ctx: { nav: readonly { id: string; label: string; desc?: string }[]; frozen: boolean; dark: boolean; tour?: boolean }): ArgosPaletteItem[] => [
    ...ctx.nav.map((n) => ({ id: `panel:go:${n.id}`, label: `Ir para ${n.label}`, hint: n.desc || "página do painel", group: PANEL_GROUP, run: { type: "panel" as const, value: PANEL_GO + n.id } })),
    { id: "panel:theme", label: ctx.dark ? "Tema claro" : "Tema escuro", hint: "trocar o tema do painel", group: PANEL_GROUP, run: { type: "panel", value: PANEL_THEME } },
    { id: "panel:freeze", label: ctx.frozen ? "Voltar a atualizar" : "Congelar a tela", hint: "pausa a atualização ao vivo", group: PANEL_GROUP, run: { type: "panel", value: PANEL_FREEZE } },
    ...(ctx.tour ? [{ id: "panel:tour", label: "Tour desta página", hint: "passo a passo dos cards, com exemplo", group: PANEL_GROUP, run: { type: "panel" as const, value: PANEL_TOUR } }] : []),
  ];

  /** Itens da paleta: os comandos do registro (já filtrados pela condição), "Ir para o nó" e, da moldura, o grupo "Painel". */
  const paletteItems = (ctx: { order: readonly ArgosNode[]; commands: readonly ArgosCommandRow[]; views?: readonly { name: string }[]; panel?: readonly ArgosPaletteItem[] }): ArgosPaletteItem[] => {
    const items: ArgosPaletteItem[] = ctx.commands.map((c) => ({ id: c.id, label: c.label, hint: c.hint, group: c.group, run: { type: "command", value: c.id } }));
    const goTo: ArgosPaletteItem[] = ctx.order.map((n) => ({ id: `node:${n.id}`, label: n.label, hint: `${n.type}${n.role ? ` · ${n.role}` : ""} · ${n.state}`, group: "Ir para o nó", run: { type: "select", value: n.id } }));
    const views: ArgosPaletteItem[] = (ctx.views ?? []).map((v) => ({ id: `saved-view:${v.name}`, label: v.name, hint: "câmera salva", group: "Vistas salvas", run: { type: "view", value: v.name } }));
    return [...items.filter((i) => i.group === ACTION_GROUP), ...goTo, ...views, ...items.filter((i) => i.group !== ACTION_GROUP), ...(ctx.panel ?? [])];
  };

  /** Caixa baixa e sem acento: "tunel" acha "Túnel". */
  const foldText = (text: string): string => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  /** Todos os termos da busca dentro do rótulo ou da dica; começo de rótulo antes. */
  const filterPalette = (items: readonly ArgosPaletteItem[], query: string): ArgosPaletteItem[] => {
    const terms = foldText(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return [...items];
    const scored: { item: ArgosPaletteItem; score: number }[] = [];
    for (const item of items) {
      const label = foldText(item.label);
      const hay = `${label} ${foldText(item.hint)} ${foldText(item.group)}`;
      if (!terms.every((t) => hay.includes(t))) continue;
      scored.push({ item, score: terms.every((t) => label.startsWith(t) || label.includes(` ${t}`)) ? 0 : 1 });
    }
    return scored.sort((a, b) => a.score - b.score).map((s) => s.item);
  };

  // ---- leitura do grafo na página (forças, vizinhança, filtros, busca, vista no endereço) ----

  /** Opacidade do 2º salto e do resto quando há foco; o nó e o 1º salto ficam inteiros. */
  const EMPHASIS_ALPHA = { second: 0.55, dimmed: 0.15 } as const;
  /** Arquivos por nó que a busca indexa: o grafo vem de fora e o índice não cresce sem teto. */
  const SEARCH_FILES_MAX = 200;
  /** Teto de passos de uma fatia por quadro (o tempo manda; isto só limita o primeiro chute errado). */
  const SLICE_STEPS_MAX = 200;
  /** Pins lembrados: o mesmo teto de nós do documento. */
  const PINS_MAX = 2000;
  const PIN_ID = /^[\w.:-]{1,200}$/;
  const LAYOUTS: readonly ReadingLayout[] = ["free", "force"];
  const READING_GROUP = "Leitura do grafo";
  /** Comandos da leitura que entram também no menu de botão direito de qualquer nó. */
  const READING_NODE_MENU: readonly string[] = ["node:pin-toggle"];

  /**
   * Opacidade por nó. Busca com resultado vence: acende os achados e apaga o resto. Sem busca, a vizinhança da seleção:
   * nó e 1º salto inteiros, 2º salto mais claro, o resto esmaecido. Sem foco nem busca: `null` (tudo normal).
   */
  const emphasisFor = (hood: ReadingNeighborhood | null, searchIds: readonly string[] | null, nodeIds: readonly string[]): Map<string, number> | null => {
    if (searchIds && searchIds.length > 0) {
      const hits = new Set(searchIds);
      return new Map(nodeIds.filter((id) => !hits.has(id)).map((id) => [id, EMPHASIS_ALPHA.dimmed]));
    }
    if (!hood || !hood.active) return null;
    const alpha = new Map<string, number>();
    for (const id of hood.levels[2] ?? []) alpha.set(id, EMPHASIS_ALPHA.second);
    for (const id of hood.dimmed) alpha.set(id, EMPHASIS_ALPHA.dimmed);
    return alpha;
  };

  const textOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

  /** Nós como o filtro os lê; custo só quando é número finito (o grafo pode não trazê-lo). */
  const filterNodes = (nodes: readonly ArgosNode[]): ReadingFilterNode[] => nodes.map((n) => ({
    id: n.id, type: n.type, state: n.state, role: n.role ?? null, registry: textOrNull(n.registry), lastEventTs: n.lastEventTs ?? null,
    costUsd: typeof n.costUsd === "number" && Number.isFinite(n.costUsd) ? n.costUsd : null,
  }));

  /** Caminhos de arquivo do nó: lista de textos ou de objetos com `path`; o resto é ignorado, até `SEARCH_FILES_MAX`. */
  const filePaths = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
      if (out.length >= SEARCH_FILES_MAX) break;
      const path = typeof item === "string" ? item : item && typeof item === "object" ? (item as { path?: unknown }).path : undefined;
      if (typeof path === "string" && path !== "") out.push(path);
    }
    return out;
  };

  /** Itens da busca: nome, card, PR, branch e arquivos de cada nó que tem caixa no canvas. */
  const searchItems = (nodes: readonly ArgosNode[], rects: readonly ReadingRect[]): ReadingSearchItem[] => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const items: ReadingSearchItem[] = [];
    for (const r of rects) {
      const n = byId.get(r.id);
      if (!n) continue;
      items.push({
        id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, label: n.label, card: textOrNull(n.card),
        number: typeof n.number === "number" && Number.isInteger(n.number) ? n.number : null, branch: textOrNull(n.branch), files: filePaths(n.files),
      });
    }
    return items;
  };

  /** Id → ids ligados a ele (dos dois lados), o `neighbors` que o layout de forças pede. */
  const neighborMap = (edges: readonly { from: string; to: string }[]): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    const link = (a: string, b: string): void => {
      const list = map.get(a);
      if (list) list.push(b);
      else map.set(a, [b]);
    };
    for (const e of edges) {
      if (e.from === e.to) continue;
      link(e.from, e.to);
      link(e.to, e.from);
    }
    return map;
  };

  /** Os nós com as posições dadas (mesma ordem; o que não tem posição nova fica). Não muda a lista recebida. */
  const withPositions = <T extends ReadingRect>(nodes: readonly T[], placements: readonly ReadingPlacement[]): T[] => {
    const at = new Map(placements.map((p) => [p.id, p]));
    return nodes.map((n) => {
      const p = at.get(n.id);
      return p && (p.x !== n.x || p.y !== n.y) ? { ...n, x: p.x, y: p.y } : n;
    });
  };

  /** Só as posições que mudam algo: nó que existe e saiu do lugar. É o que vira operação na pilha de desfazer. */
  const changedPlacements = (nodes: readonly ReadingRect[], placements: readonly ReadingPlacement[]): ReadingPlacement[] => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return placements.filter((p) => {
      const n = byId.get(p.id);
      return n !== undefined && (n.x !== p.x || n.y !== p.y);
    });
  };

  /** Ids que um gesto do dono moveu (`move` solto ou dentro de um lote): com forças ligadas, eles ficam fixos. */
  const movedIds = (op: { kind: string; id?: string; ops?: readonly { kind: string; id?: string }[] }): string[] => {
    const moves = op.kind === "batch" ? (op.ops ?? []) : [op];
    return moves.filter((m) => m.kind === "move" && typeof m.id === "string").map((m) => m.id as string);
  };

  /** Passos da próxima fatia pelo custo medido de um passo; sem medida ainda, um passo só (para medir). */
  const sliceSteps = (msPerStep: number | null, budgetMs: number): number => {
    if (msPerStep === null || !Number.isFinite(msPerStep) || msPerStep <= 0) return 1;
    return Math.max(1, Math.min(SLICE_STEPS_MAX, Math.floor(budgetMs / msPerStep)));
  };

  /** Caixa a enquadrar: a dos achados, alargada em volta do centro para a câmera não passar do zoom `maxZoom`. */
  const frameBox = (box: { x: number; y: number; w: number; h: number }, view: { w: number; h: number }, maxZoom: number): { x: number; y: number; w: number; h: number } => {
    const w = Math.max(box.w, view.w / maxZoom);
    const h = Math.max(box.h, view.h / maxZoom);
    return { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h };
  };

  /** Pins lidos do armazenamento do navegador: só ids válidos, sem repetir, até `PINS_MAX`. */
  const readPins = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    const out = new Set<string>();
    for (const id of raw) {
      if (out.size >= PINS_MAX) break;
      if (typeof id === "string" && PIN_ID.test(id)) out.add(id);
    }
    return [...out];
  };
  const readLayout = (raw: unknown): ReadingLayout => (LAYOUTS as readonly unknown[]).includes(raw) ? (raw as ReadingLayout) : "free";

  /** Comandos da leitura do grafo, para o registro de comandos da página (Ctrl+K, botão direito, `?`). */
  const readingCommandDefs = (): ReadingCommandDef[] => [
    { id: "layout:toggle", label: (ctx) => (ctx.reading.layout === "force" ? "Voltar ao layout livre" : "Ligar o layout automático"),
      hint: "livre ou automático", group: READING_GROUP, shortcut: "shift+l", surfaces: ["palette", "canvas-menu"], run: (ctx) => ctx.handlers.toggleLayout() },
    { id: "layout:arrange", label: "Reorganizar automaticamente", hint: "os nós fixados ficam onde estão", group: READING_GROUP, surfaces: ["palette", "canvas-menu"],
      when: (ctx) => ctx.reading.layout === "force" && !ctx.reading.running, run: (ctx) => ctx.handlers.arrange() },
    { id: "layout:stop", label: "Parar o layout", hint: "fica onde está", group: READING_GROUP, surfaces: ["palette", "canvas-menu"],
      when: (ctx) => ctx.reading.running, run: (ctx) => ctx.handlers.stopLayout() },
    { id: "node:pin-toggle", label: (ctx) => (ctx.reading.pinned ? "Soltar o nó" : "Fixar o nó"), hint: "o layout automático não o move", group: READING_GROUP,
      shortcut: "shift+p", surfaces: ["palette", "node-menu"], when: (ctx) => ctx.reading.nodeId !== null,
      run: (ctx) => { if (ctx.reading.nodeId !== null) ctx.handlers.togglePin(ctx.reading.nodeId); } },
    { id: "filters:open", label: "Abrir os filtros", hint: "estado, atividade, arquivados, ocultos e as outras dimensões", group: READING_GROUP, shortcut: "v", surfaces: ["palette"],
      run: (ctx) => ctx.handlers.openFilters() },
    { id: "search:focus", label: "Buscar no canvas", hint: "nó, PR, branch ou arquivo", group: READING_GROUP, shortcut: "b", surfaces: ["palette"],
      run: (ctx) => ctx.handlers.focusSearch() },
    { id: "search:clear", label: "Limpar a busca", group: READING_GROUP, surfaces: ["palette", "canvas-menu"], when: (ctx) => ctx.reading.searching,
      run: (ctx) => ctx.handlers.clearSearch() },
    { id: "filters:clear", label: "Limpar os filtros", hint: "estado, tipo, ligação, papel, raiz, idade, custo", group: READING_GROUP,
      surfaces: ["palette", "canvas-menu"], when: (ctx) => ctx.reading.filtering, run: (ctx) => ctx.handlers.clearFilters() },
    { id: "view:save", label: "Salvar a vista atual", hint: "guarda a câmera com um nome", group: READING_GROUP, surfaces: ["palette", "canvas-menu"],
      run: (ctx) => ctx.handlers.saveView() },
  ];

  /** Comandos do menu do nó de agente que abrem terminal: shell na worktree dele e o cliente do herdr da sessão dele. */
  const TERM_OPEN_GROUP = "Terminal";
  const TERM_OPEN_SHELL = "agent:open-terminal";
  const TERM_OPEN_CLIENT = "agent:open-herdr-client";
  const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/;
  /** Pasta do shell do agente: a worktree do nó, se for caminho absoluto; senão nada (o comando fica de fora do menu). */
  const worktreeOfNode = (node: { worktree?: unknown } | undefined): string | null =>
    typeof node?.worktree === "string" && node.worktree.startsWith("/") ? node.worktree : null;
  /** Sessão do herdr do nó, só se o nome é seguro para ir ao cliente. */
  const herdrSessionOfNode = (node: { herdr?: { session?: unknown } } | undefined): string | null => {
    const s = node?.herdr?.session;
    return typeof s === "string" && SESSION_NAME.test(s) ? s : null;
  };
  interface TermOpenPort { node(id: string): { worktree?: unknown; herdr?: { session?: unknown } } | undefined; open(spec: { kind: string; cwd?: string; session?: string }): void }
  const termOpenCommandDefs = (port: TermOpenPort): ReadingCommandDef[] => [
    { id: TERM_OPEN_SHELL, label: "Abrir terminal na worktree", hint: "um shell na pasta do agente, na página Herdr", group: TERM_OPEN_GROUP, surfaces: ["node-menu"],
      when: (ctx) => ctx.reading.nodeId !== null && worktreeOfNode(port.node(ctx.reading.nodeId)) !== null,
      run: (ctx) => { const cwd = ctx.reading.nodeId === null ? null : worktreeOfNode(port.node(ctx.reading.nodeId)); if (cwd !== null) port.open({ kind: "shell", cwd }); } },
    { id: TERM_OPEN_CLIENT, label: "Abrir cliente do herdr", hint: "a sessão do herdr deste agente, na página Herdr", group: TERM_OPEN_GROUP, surfaces: ["node-menu"],
      when: (ctx) => ctx.reading.nodeId !== null && herdrSessionOfNode(port.node(ctx.reading.nodeId)) !== null,
      run: (ctx) => { const session = ctx.reading.nodeId === null ? null : herdrSessionOfNode(port.node(ctx.reading.nodeId)); if (session !== null) port.open({ kind: "herdr-client", session }); } },
  ];

  // ---- montagem na página: registros, texto dos nós do usuário e política do portal

  const MOUNT_GROUP = "Nó";
  // `exact` traz os de loopback, os do Hades e os da configuração (até 100): o teto só barra resposta absurda
  const PORTAL_POLICY_HOSTS_MAX = 256;
  const PORTAL_HOST = /^(?:\[[0-9a-f:.]{2,45}\]|[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*)$/;
  const PORTAL_HOST_CHARS = 253;

  /** Nenhum host liberado: vale até a rota responder e em qualquer erro dela (falha fechada). */
  const emptyPortalPolicy = (): MountPortalPolicy => ({ exact: new Set<string>(), suffixes: [], ignored: [] });

  const hostList = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw) || raw.length > PORTAL_POLICY_HOSTS_MAX) return undefined;
    const hosts = raw.filter((h): h is string => typeof h === "string" && h.length <= PORTAL_HOST_CHARS && PORTAL_HOST.test(h));
    return hosts.length === raw.length ? hosts : undefined;
  };

  /**
   * Corpo de `GET /api/canvas/portal/policy` (`{ exact, suffixes }`) → política. Forma diferente, host fora do formato ou
   * lista acima do teto recusa a resposta inteira e devolve a política vazia: nada é liberado pela metade.
   */
  const readPortalPolicy = (raw: unknown): MountPortalPolicy => {
    if (typeof raw !== "object" || raw === null) return emptyPortalPolicy();
    const body = raw as { exact?: unknown; suffixes?: unknown };
    const exact = hostList(body.exact);
    const suffixes = hostList(body.suffixes);
    if (!exact || !suffixes) return emptyPortalPolicy();
    return { exact: new Set(exact), suffixes, ignored: [] };
  };

  const USER_MENU_LABELS: Readonly<Record<UserMenuKind, string>> = {
    edit: "Editar o texto", duplicate: "Duplicar", blur: "Desfocar ou revelar", remove: "Excluir", copyCommands: "Copiar os comandos", linkNote: "Ligar uma nota à banda",
  };

  /** Os comandos `user:*` que os tipos do usuário citam no `menu`, só no botão direito do nó; o id vem de `menu` (ArgosTypesUser.MENU). */
  const userMenuCommandDefs = (menu: Readonly<Record<UserMenuKind, string>>): UserMenuCommandDef[] =>
    (Object.keys(USER_MENU_LABELS) as UserMenuKind[]).map((kind) => ({
      id: menu[kind], label: USER_MENU_LABELS[kind], group: MOUNT_GROUP, surfaces: ["node-menu"],
      when: (ctx) => ctx.reading.nodeId !== null,
      run: (ctx) => { if (ctx.reading.nodeId !== null) ctx.handlers.userMenu(kind, ctx.reading.nodeId); },
    }));

  const codeOfError = (error: unknown): string | undefined =>
    typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;

  /**
   * Os callbacks `onTextChange` e `onRemove` dos nós do usuário: o texto novo vira `update` (opEditText) e o texto esvaziado
   * vira `delete`, cada um um passo do desfazer pela `port`. Recusa do modelo ou da pilha vai a `port.fail` com o código.
   */
  function userTextHost<Op>(models: MountTextModels<Op>, port: MountTextPort<Op>) {
    const apply = (build: (doc: MountDoc) => Op | undefined): void => {
      const doc = port.doc();
      if (!doc) return;
      let op: Op | undefined;
      try {
        op = build(doc);
        if (op !== undefined) port.commit(op);
      } catch (error) {
        const code = codeOfError(error);
        if (code === undefined) throw error;
        port.fail(code);
      }
    };
    return {
      onTextChange: (id: string, data: { text: string; style: string }): void => apply((doc) => models.note.opEditText(doc, id, data.text, data.style)),
      onRemove: (id: string): void => apply((doc) => models.history.opDelete(doc, [id])),
    };
  }

  /** A ação do menu que abre o balão do nó em vez do diálogo: o balão manda prompt ou texto ao agente. */
  const BALLOON_ACTION = "prompt";
  const DIRECT_FIELD_KIND = "text";

  const overlayActionRoute = (item: OverlayMenuAction): OverlayActionRoute => {
    if (item.key === BALLOON_ACTION) return { kind: "balloon" };
    if (ACTIONS.some((a) => a.id === item.key)) return { kind: "dialog", id: item.key };
    const [field, ...rest] = item.fields;
    if (rest.length > 0 || (field !== undefined && field.kind !== DIRECT_FIELD_KIND)) return { kind: "unsupported" };
    return { kind: "direct", textField: field ? { name: field.name, required: field.required } : null, confirm: item.dangerous };
  };

  /**
   * O tipo como o menu das camadas o lê: as ações do agente já vêm do próprio menu (grupo "Agente"), então os comandos
   * `action:*` do tipo saem; os comandos da leitura que valem para qualquer nó (fixar/soltar) entram depois dos do tipo.
   */
  const overlayMenuType = <T extends { menu: readonly string[] }>(type: T, actionPrefix: string): T => {
    const own = type.menu.filter((id) => !id.startsWith(actionPrefix));
    return { ...type, menu: [...own, ...READING_NODE_MENU.filter((id) => !own.includes(id))] };
  };

  /** Os nós da vista para as camadas: o do grafo vira o dado das ações; o do usuário só leva id, tipo e rótulo. */
  const overlayNodes = <N extends { id: string; type: string; label: string }>(nodes: readonly OverlayDocNode[], actionOf: (id: string) => N | null): OverlayNodeOut<N | { id: string; type: string; label: string }>[] =>
    nodes.map((n) => ({ node: actionOf(n.id) ?? { id: n.id, type: n.type, label: n.id }, rect: { x: n.x, y: n.y, w: n.w, h: n.h } }));

  /** O contexto das ações vindo do grafo: sem `herdr.available` booleano, não se sabe e o servidor decide. */
  const actionContextOf = (graph: ArgosGraph | null): { herdrAvailable?: boolean } => {
    const herdr = graph?.herdr as { available?: unknown } | undefined;
    return typeof herdr?.available === "boolean" ? { herdrAvailable: herdr.available } : {};
  };

  /**
   * Monta no registro da página o que as peças do canvas declaram: os `user:*` (superfície `node-menu`), os comandos de
   * organização, os tipos do usuário (com o `menu` conferido contra os comandos) e os tipos vivos. Comando ou tipo recusado
   * fica de fora e entra no relatório; o resto segue. Chamar de novo sobre os mesmos registros não repete nem lança.
   */
  const mountCanvasRegistries = (reg: MountRegistries, parts: MountParts, deps: { api: object; userDeps: object; liveDeps: object }): MountReport => {
    const refused: { id: string; code: string }[] = [];
    const attempt = (id: string, run: () => void): void => {
      try {
        run();
      } catch (error) {
        const code = codeOfError(error);
        if (code === undefined) throw error;
        refused.push({ id, code });
      }
    };
    for (const def of userMenuCommandDefs(parts.typesUser.MENU)) {
      if (reg.commands.get(def.id) === undefined) attempt(def.id, () => reg.commands.register(def));
    }
    refused.push(...parts.canvasCommands.registerCanvasCommands(reg.commands, deps.api).refused.map(({ id, code }) => ({ id, code })));
    for (const def of parts.typesUser.registerUserTypes(reg.types, deps.userDeps)) attempt(def.type, () => reg.commands.checkTypeMenu(def));
    parts.typesLive.registerLiveTypes(reg.types, deps.liveDeps);
    return { refused };
  };

  return {
    EMPHASIS_ALPHA, SEARCH_FILES_MAX, SLICE_STEPS_MAX, PINS_MAX, READING_GROUP, READING_NODE_MENU,
    emphasisFor, filterNodes, searchItems, neighborMap, withPositions, changedPlacements, movedIds, sliceSteps, frameBox, readPins, readLayout, readingCommandDefs, termOpenCommandDefs, worktreeOfNode, herdrSessionOfNode, TERM_OPEN_SHELL, TERM_OPEN_CLIENT,
    NODE_W, NODE_H, ACTION_GROUP, STALL_MS, EVENTS_CAP, TEXT_MAX, HERDR_KEYS, STATE_FILTERS, ERROR_TEXT, ACTIONS, actionFailTitle, GRAPH_RETRY_S, SAVE_RETRY_S, SAVE_LOUD_AFTER, graphErrorText, saveBadgeOf,
    needsAttention, isStalled, severity, matchesState, validNodes, filterOptions, filterGraph, filterKey,
    neighbor, needsConfirm, confirmMatches, questionIds, availableActions, validateArgs, buildBody, errorText, mergeEvents, eventTone,
    paletteItems, filterPalette, panelItems, PANEL_GROUP, PANEL_GO, PANEL_THEME, PANEL_FREEZE, PANEL_TOUR,
    emptyPortalPolicy, readPortalPolicy, userMenuCommandDefs, userTextHost, mountCanvasRegistries,
    BALLOON_ACTION, overlayActionRoute, overlayMenuType, overlayNodes, actionContextOf,
  };
}
type ArgosLogicApi = ReturnType<typeof makeArgosLogic>;
(globalThis as unknown as { ArgosLogic: ArgosLogicApi }).ArgosLogic = makeArgosLogic();
