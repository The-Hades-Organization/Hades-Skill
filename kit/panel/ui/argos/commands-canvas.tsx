/* Comandos de organização do canvas do Argos (reference/argos.md §Comandos de organização): grupos, alinhar e distribuir,
 * encaixe, copiar/colar/duplicar/excluir, andar pelas conexões, próximo que precisa do dono, ações em lote, desfocar,
 * elevar e acoplar, vários canvases e exportar/importar, filtros salvos, canvas por worktree/rodada e esboço de unidade.
 * Script clássico: registra window.ArgosCanvasCommands. Depende de window.CanvasModel com as chaves history, groups, align,
 * clipboard, walk, next, batch, blur, dock, store e export; savedFilters, create e doc só quando a porta que as usa vem.
 * A regra mora nos modelos de src/lib; aqui só se liga cada comando a um modelo e a operação sai por `api`, que a página
 * fornece. Toda mudança no documento chega a `api.doc.commit` como `CanvasOp`, um passo só no desfazer. */
import type { ActionContext, ActionNode, ActionRequest } from "../../../../src/lib/canvas-actions.ts";
import type * as AlignModule from "../../../../src/lib/canvas-align.ts";
import type * as AreasModule from "../../../../src/lib/canvas-areas.ts";
import type * as BatchModule from "../../../../src/lib/canvas-batch.ts";
import type * as BlurModule from "../../../../src/lib/canvas-blur.ts";
import type * as ClipboardModule from "../../../../src/lib/canvas-clipboard.ts";
import type { CommandDef, CommandRegistry } from "../../../../src/lib/canvas-commands.ts";
import type * as CreateModule from "../../../../src/lib/canvas-create.ts";
import type * as DockModule from "../../../../src/lib/canvas-dock.ts";
import type * as DocModule from "../../../../src/lib/canvas-doc.ts";
import type { CanvasDoc } from "../../../../src/lib/canvas-doc.ts";
import type * as ExportModule from "../../../../src/lib/canvas-export.ts";
import type { FilterSelection } from "../../../../src/lib/canvas-filters.ts";
import type * as GroupsModule from "../../../../src/lib/canvas-groups.ts";
import type * as HistoryModule from "../../../../src/lib/canvas-history.ts";
import type * as NextModule from "../../../../src/lib/canvas-next.ts";
import type * as SavedFiltersModule from "../../../../src/lib/canvas-saved-filters.ts";
import type * as StoreModule from "../../../../src/lib/canvas-store.ts";
import type * as WalkModule from "../../../../src/lib/canvas-walk.ts";

type CanvasOp = HistoryModule.CanvasOp;
type DockState = DockModule.DockState;
type BatchPlan = BatchModule.BatchPlan;
type BatchResponse = BatchModule.BatchResponse;
type BatchResult = BatchModule.BatchResult;
type NextNode = NextModule.NextNode;
type SavedFilterSet = SavedFiltersModule.SavedFilterSet;

/** O que o comando diz ao dono: `code` é o código estável do erro do modelo (quando há), `text` é para a tela. */
interface CanvasNote {
  level: "info" | "warn" | "error";
  code?: string;
  text: string;
}

/** O documento e a seleção: a parte que todo comando usa. */
interface CanvasDocPort {
  /** O documento que o dono vê e edita agora. Leitura na hora de executar, nunca guardada. */
  doc(): CanvasDoc;
  /** Ids selecionados; id que o documento não tem é ignorado. */
  selection(): readonly string[];
  select(ids: readonly string[]): void;
  /** Aplica a operação ao documento pela pilha de desfazer (um passo só) e agenda a gravação. */
  commit(op: CanvasOp): void;
  /** Leva a câmera até o nó (centraliza com o detalhe completo). */
  reveal(id: string): void;
  notify(note: CanvasNote): void;
}

/** Perguntas ao dono. `null` (ou `false`) é ele cancelar. */
interface CanvasDialogPort {
  askText(request: { title: string; initial?: string }): Promise<string | null>;
  choose(request: { title: string; options: readonly { value: string; label: string }[] }): Promise<string | null>;
  confirm(request: { title: string; text: string }): Promise<boolean>;
}

/** Encaixe magnético como modo da tela (o gesto com Ctrl continua sendo do motor). */
interface CanvasSnapPort {
  enabled(): boolean;
  setEnabled(on: boolean): void;
}

/** "Esconder controles" da página (só o canvas, sem o HUD): estado de tela, fora da pilha de desfazer. O id `canvas:focus` e a chave do endereço seguem os de antes. */
interface CanvasFocusPort {
  enabled(): boolean;
  /** Vale agora; falso some o comando da paleta e a tecla não faz nada. */
  available(): boolean;
  setEnabled(on: boolean): void;
}

/** Elevar e acoplar é estado de tela, fora da pilha de desfazer. */
interface CanvasDockPort {
  state(): DockState;
  set(next: DockState): void;
}

/** Fila de quem precisa do dono (permissão pendente, pergunta aberta, gate falho): o grafo é da página. */
interface CanvasOwnerPort {
  nodes(): readonly NextNode[];
}

/** Ação em lote: a página lê o grafo, pergunta ao dono, faz os POSTs e mostra o resultado por agente. */
interface CanvasBatchPort {
  /** Os nós de `ids` como a ação os lê; só o grafo sabe o estado de cada agente. */
  nodes(ids: readonly string[]): ActionNode[];
  context(): ActionContext;
  /** Ids que passam pelos filtros da vista agora. */
  filteredIds(): readonly string[];
  /** Mostra alvos e efeito. Ação destrutiva devolve também o que o dono digitou (`plan.confirmPhrase`). */
  confirm(plan: BatchPlan): Promise<{ confirmed: boolean; typed?: string }>;
  /** Um POST por pedido; `status: 0` para o que não teve resposta. */
  send(requests: readonly ActionRequest[]): Promise<BatchResponse[]>;
  show(result: BatchResult): void;
}

interface CanvasInfo {
  id: string;
  name: string;
}

/** Vários canvases (W1) e arquivo (W3). */
interface CanvasWorkspacePort {
  current(): CanvasInfo;
  list(): readonly CanvasInfo[];
  /** Cria o canvas (vazio ou com `doc`, já validado); não troca para ele. */
  create(request: { id: string; name: string; doc?: CanvasDoc }): Promise<void>;
  switchTo(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Entrega o arquivo ao dono (baixar). */
  saveFile(file: { filename: string; text: string }): void;
  /** Deixa o dono escolher um arquivo e devolve o texto; `null` se cancelou. */
  pickFile(): Promise<string | null>;
  /** Relógio de quem chama (padrão: o do navegador). */
  now?(): Date;
}

/** Filtros salvos da instância (L5): a página guarda o conjunto lido do servidor e grava pelo PUT com a revisão. */
interface CanvasSavedFiltersPort {
  /** O conjunto como a página o leu por último. */
  set(): SavedFilterSet;
  /** A seleção de filtros da vista agora. */
  current(): FilterSelection;
  apply(selection: FilterSelection): void;
  /** Grava o conjunto inteiro; recusa com o código do servidor (`saved_filters_stale_revision` quando outra aba gravou antes). */
  save(next: SavedFilterSet): Promise<{ ok: true } | { ok: false; code: string }>;
  /** Relê o conjunto do servidor. */
  reload(): Promise<void>;
}

interface CanvasScopeChoice {
  kind: "worktree" | "round";
  key: string;
}

/** Canvas por worktree ou rodada (W2): a página cria (ou reabre) o canvas do escopo e troca para ele. */
interface CanvasScopePort {
  /** As worktrees que o grafo mostra agora, com o rótulo para a lista. */
  options(): readonly (CanvasScopeChoice & { label: string })[];
  /** Id do canvas aberto. */
  current(): string;
  open(scope: CanvasScopeChoice): Promise<void>;
  openDefault(): Promise<void>;
}

/** Esboço de unidade (A6): onde o nó novo nasce, em coordenadas do mundo (o centro da tela, na página). */
interface CanvasSketchPort {
  at(): { x: number; y: number };
}

/** Nó de agente como terminal: a página tem o host dos terminais (foco do teclado, atenção, números de salto). */
interface CanvasTtyPort {
  /** Foca o próximo terminal que pede atenção; `false` se nenhum pede. */
  nextAttention(): boolean;
  /** Foca o terminal do número de salto `n` (1–9, os visíveis); `false` se o número não existe. */
  jump(n: number): boolean;
  /** Devolve o teclado ao canvas. */
  release(): void;
  focused(): boolean;
  /** Há terminal-alvo do zoom do texto: o focado no teclado, senão o nó com terminal selecionado sozinho. */
  zoomable?(): boolean;
  /** Zoom do texto do terminal-alvo: o nó cresce ou encolhe na proporção do quadro (um passo do desfazer); `false` sem alvo ou sem quadro. */
  zoomText?(kind: "in" | "out" | "reset"): boolean;
}

/** Terminais criados no canvas (nó `terminal`): a página faz as rotas, os diálogos e as operações do documento. */
interface CanvasTerminalPort {
  /** Arma a ferramenta Terminal: o próximo retângulo arrastado no canvas abre o modal de criação. */
  armTool(): void;
  /** O terminal-alvo: o focado no teclado, senão o nó `terminal` selecionado sozinho; `null` sem alvo. */
  target(): string | null;
  edit(id: string, tab: "details" | "appearance"): Promise<void>;
  role(id: string): Promise<void>;
  /** Abre o popover de conexões do nó (terminal ou nota): pular até a outra ponta, trocar o estilo, remover. */
  connections(id: string): Promise<void>;
  /** Diálogo com o nome do nó, fecha o pane do herdr e tira o nó (um passo do desfazer). */
  close(id: string): Promise<void>;
  /** O nó é um terminal criado no canvas com processo vivo: excluir fecha o processo (`close`) em vez de só tirar o nó. */
  closable?(id: string): boolean;
  /** Abre a tela de papéis (criar, editar, descobrir, apagar). */
  roles(): void;
}

/** Compositor flutuante do terminal (canvas-composer.tsx): a página guarda qual terminal ele segue. */
interface CanvasComposerPort {
  /** Abre sobre o terminal focado no teclado; aberto, fecha. */
  toggle(): void;
  /** Há terminal focado, ou o compositor já está aberto (para o atalho também fechar). */
  available(): boolean;
}

/** Supervisor do canvas (supervisor.tsx): painel flutuante que a página abre e fecha. */
interface CanvasSupervisorPort {
  /** Abre o painel; aberto, fecha. */
  toggle(): void;
}

/** Conexões do canvas (aresta `link`): o motor desenha a linha que segue o cursor e o clique no destino a completa. */
interface CanvasLinkPort {
  /** Arma a conexão a partir do terminal focado ou do nó selecionado sozinho; `false` se a origem não conecta. */
  start(): boolean;
}

/** Notas do canvas (nó `note`). */
interface CanvasNotePort {
  /** A nota selecionada sozinha; `null` sem alvo. */
  target(): string | null;
  /** Confirma com o dono, tira o nó (um passo do desfazer) e apaga o arquivo se ele está na pasta padrão. */
  close(id: string): Promise<void>;
}

/** O que a página fornece. Só `doc` e `dialogs` são obrigatórios: sem uma porta opcional, os comandos dela não são registrados. */
interface CanvasCommandsApi {
  doc: CanvasDocPort;
  dialogs: CanvasDialogPort;
  snap?: CanvasSnapPort;
  dock?: CanvasDockPort;
  owner?: CanvasOwnerPort;
  batch?: CanvasBatchPort;
  workspace?: CanvasWorkspacePort;
  focus?: CanvasFocusPort;
  savedFilters?: CanvasSavedFiltersPort;
  scope?: CanvasScopePort;
  sketch?: CanvasSketchPort;
  tty?: CanvasTtyPort;
  terminals?: CanvasTerminalPort;
  composer?: CanvasComposerPort;
  supervisor?: CanvasSupervisorPort;
  links?: CanvasLinkPort;
  notes?: CanvasNotePort;
}

/** Os comandos leem a seleção da `api`, não do contexto: a página passa o contexto dela e ele não é lido aqui. */
type CanvasCommandCtx = object;

interface CanvasCommandRow {
  /** O item do catálogo de features (O1, O2, …). */
  feature: string;
  def: CommandDef<CanvasCommandCtx>;
}

interface RegisterReport {
  registered: string[];
  /** Comando que o registro recusou (atalho tomado, por exemplo): só ele fica de fora. */
  refused: { id: string; code: string; subject?: string }[];
}

interface CanvasModels {
  history: typeof HistoryModule;
  groups: typeof GroupsModule;
  align: typeof AlignModule;
  clipboard: typeof ClipboardModule;
  walk: typeof WalkModule;
  next: typeof NextModule;
  batch: typeof BatchModule;
  blur: typeof BlurModule;
  dock: typeof DockModule;
  store: typeof StoreModule;
  export: typeof ExportModule;
}

const MODEL_KEYS = ["history", "groups", "align", "clipboard", "walk", "next", "batch", "blur", "dock", "store", "export"] as const;

/** Modelos que só as portas opcionais usam: pedidos na hora de registrar os comandos daquela porta. */
interface OptionalModels {
  savedFilters: typeof SavedFiltersModule;
  create: typeof CreateModule;
  doc: typeof DocModule;
  areas: typeof AreasModule;
}

const GROUP_ORGANIZE = "Organização";
const GROUP_OWNER = "Agentes";
const GROUP_CANVAS = "Canvases";
const GROUP_VIEW = "Vista";
const GROUP_FILTERS = "Filtros";
const GROUP_CREATE = "Criar";
const SURFACES_ALL = ["palette", "canvas-menu", "node-menu"] as const;
const SURFACES_CANVAS = ["palette", "canvas-menu"] as const;

const MIN_TO_GROUP = 2;
const MIN_TO_ALIGN = 2;
const MIN_TO_DISTRIBUTE = 3;
const EXPORT_NAME_CHARS = 60;
const EXPORT_SUFFIX = ".hades-canvas.json";
const GROUP_ID_PREFIX = "grp";
const PASTE_ID_PREFIX = "col";
const DUPLICATE_ID_PREFIX = "dup";
const SKETCH_ID_PREFIX = "esb";
const AREA_ID_PREFIX = "area";
/** Código do 409 de `PUT /api/canvases/_filters` (src/panel/canvas.ts): outra aba gravou o conjunto antes. */
const SAVED_FILTERS_STALE_CODE = "saved_filters_stale_revision";
/** Valor da opção "Nenhum" ao marcar o padrão: id de filtro começa por letra ou número, então nunca colide. */
const NO_DEFAULT_FILTER = "-";
/** Valor da opção "Rodada…" no seletor de escopo: chave de worktree nunca é vazia. */
const ROUND_CHOICE = "";
/** Tamanho do nó `unit-sketch` (o mesmo que types-user.tsx declara no registro de tipos). */
const SKETCH_FRAME = { w: 320, h: 220 } as const;
/** Números de salto dos terminais visíveis: Alt+1 a Alt+9. */
const TTY_JUMP_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const GROUP_AREAS = "Áreas";
const GROUP_TERMINAL = "Terminais";
const GROUP_LINKS = "Conexões";
const UNIT_KIND_LABELS: Readonly<Record<CreateModule.UnitKind, string>> = { project: "Unidade de projeto", skill: "Unidade de skill" };

/** Texto de cada recusa do lote: o código vem do modelo e a tela não ramifica por ele. */
const BATCH_PROBLEM_TEXT: Readonly<Record<BatchModule.BatchErrorCode, string>> = {
  batch_action_not_supported: "Essa ação não vale em lote.",
  batch_empty_selection: "Selecione os agentes antes.",
  batch_too_large: "Seleção grande demais para um lote.",
  batch_missing_args: "Falta um argumento da ação.",
  batch_no_valid_targets: "Nenhum dos nós selecionados aceita essa ação agora.",
  batch_confirm_required: "A confirmação não bateu: nada foi enviado.",
  batch_no_response: "Sem resposta.",
  batch_unexpected_response: "Resposta inesperada.",
};

const COMMAND_FAILED_CODE = "canvas_command_failed";

/** Erro com código estável (os dos modelos): vira aviso na tela. O resto é defeito e continua subindo. */
function codedError(error: unknown): { code: string; message: string } | undefined {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return undefined;
  return { code: error.code, message: error.message };
}

function readModels(): CanvasModels {
  const found = (globalThis as unknown as { CanvasModel?: Partial<Record<(typeof MODEL_KEYS)[number], unknown>> }).CanvasModel;
  if (!found) throw new Error("ArgosCanvasCommands: carregue /ui/lib/canvas-model.js antes de commands-canvas.js");
  const missing = MODEL_KEYS.filter((key) => found[key] === undefined);
  if (missing.length > 0) throw new Error(`ArgosCanvasCommands: window.CanvasModel não tem ${missing.join(", ")}`);
  return found as unknown as CanvasModels;
}

function readOptionalModel<K extends keyof OptionalModels>(key: K): OptionalModels[K] {
  const found = (globalThis as unknown as { CanvasModel?: Partial<Record<keyof OptionalModels, unknown>> }).CanvasModel?.[key];
  if (found === undefined) throw new Error(`ArgosCanvasCommands: window.CanvasModel não tem ${key}`);
  return found as OptionalModels[K];
}

function makeArgosCanvasCommands() {
  /** Os comandos (com o item do catálogo de cada um) para a `api` dada; as portas ausentes deixam seus comandos de fora. */
  function canvasCommandRows(api: CanvasCommandsApi): CanvasCommandRow[] {
    const M = readModels();
    const { doc: docPort, dialogs } = api;
    const rows: CanvasCommandRow[] = [];
    const add = (feature: string, def: CommandDef<CanvasCommandCtx>): void => void rows.push({ feature, def });

    // ---- base: seleção, avisos e execução protegida ----
    const say = (level: CanvasNote["level"], text: string, code?: string): void => docPort.notify(code === undefined ? { level, text } : { level, text, code });
    const report = (error: unknown): void => {
      const coded = codedError(error);
      if (coded === undefined) throw error;
      say("error", coded.message, coded.code);
    };
    /** Erro de modelo (código estável) vira aviso e o comando termina; defeito de programação continua subindo. */
    const guarded = (run: () => void): (() => void) => () => {
      try {
        run();
      } catch (error) {
        report(error);
      }
    };
    /** Promessa de comando: nunca solta. Erro de modelo vira aviso; qualquer outro sobe como erro registrado. */
    const guardedAsync = (task: () => Promise<void>): (() => void) => () => {
      task().catch((error: unknown) => {
        const coded = codedError(error);
        if (coded !== undefined) say("error", coded.message, coded.code);
        else {
          console.error("ArgosCanvasCommands: comando falhou", error);
          say("error", "O comando falhou. Veja o console.", COMMAND_FAILED_CODE);
        }
      });
    };

    const selectedIds = (): string[] => {
      const present = new Set(docPort.doc().nodes.map((node) => node.id));
      return [...new Set(docPort.selection())].filter((id) => present.has(id));
    };
    const hasSelection = (min: number) => (): boolean => selectedIds().length >= min;
    const primary = (): string | undefined => {
      const ids = selectedIds();
      return ids.length === 1 ? ids[0] : undefined;
    };
    const commitIf = (op: CanvasOp | undefined): boolean => {
      if (op === undefined) return false;
      docPort.commit(op);
      return true;
    };
    const skippedText = (skipped: readonly string[]): string =>
      `${skipped.length} ${skipped.length === 1 ? "nó vivo ficou" : "nós vivos ficaram"} de fora: só nós do usuário se copiam e se excluem.`;
    const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

    // ---- O1 grupos ----
    const groupsTouched = (ids: readonly string[]): string[] => {
      const index = M.groups.groupIndex(docPort.doc());
      return [...new Set(ids.flatMap((id) => index.get(id) ?? []))];
    };
    add("O1", {
      id: "group:create", label: "Agrupar a seleção", hint: "dois ou mais nós", group: GROUP_ORGANIZE, shortcut: "mod+g", surfaces: SURFACES_ALL,
      inEditable: false, when: hasSelection(MIN_TO_GROUP),
      run: guarded(() => {
        const doc = docPort.doc();
        const members = selectedIds();
        const id = M.clipboard.sequentialIds(doc, GROUP_ID_PREFIX)("group");
        commitIf(M.groups.createGroup(doc, { id, label: `Grupo ${doc.groups.length + 1}`, members }));
      }),
    });
    add("O1", {
      id: "group:ungroup", label: "Desfazer o grupo", hint: "os nós ficam onde estão", group: GROUP_ORGANIZE, shortcut: "mod+shift+g", surfaces: SURFACES_ALL,
      inEditable: false, when: () => groupsTouched(selectedIds()).length > 0,
      run: guarded(() => {
        // Um passo só: cada grupo sai sobre o documento já sem o anterior.
        let working = docPort.doc();
        const steps: HistoryModule.AtomicOp[] = [];
        for (const groupId of groupsTouched(selectedIds())) {
          const step = M.history.opUngroup(working, groupId);
          steps.push(step);
          working = M.history.applyOp(working, step);
        }
        if (steps.length > 0) docPort.commit(steps.length === 1 ? (steps[0] as HistoryModule.AtomicOp) : M.history.opBatch(steps));
      }),
    });
    add("O1", {
      id: "group:rename", label: "Renomear o grupo", group: GROUP_ORGANIZE, surfaces: SURFACES_ALL,
      when: () => groupsTouched(selectedIds()).length === 1,
      run: guardedAsync(async () => {
        const [groupId] = groupsTouched(selectedIds());
        const group = docPort.doc().groups.find((candidate) => candidate.id === groupId);
        if (group === undefined) return;
        const label = await dialogs.askText({ title: "Nome do grupo", initial: group.label });
        if (label === null) return;
        // o documento pode ter mudado enquanto o dono digitava: o modelo confere o grupo de novo
        commitIf(M.groups.renameGroup(docPort.doc(), group.id, label));
      }),
    });

    // ---- O2 alinhar, distribuir, organizar ----
    const ALIGN_ROWS: readonly { mode: AlignModule.AlignMode; label: string; shortcut: string }[] = [
      { mode: "left", label: "Alinhar à esquerda", shortcut: "alt+shift+ArrowLeft" },
      { mode: "center", label: "Alinhar ao centro", shortcut: "alt+shift+h" },
      { mode: "right", label: "Alinhar à direita", shortcut: "alt+shift+ArrowRight" },
      { mode: "top", label: "Alinhar ao topo", shortcut: "alt+shift+ArrowUp" },
      { mode: "middle", label: "Alinhar ao meio", shortcut: "alt+shift+v" },
      { mode: "bottom", label: "Alinhar à base", shortcut: "alt+shift+ArrowDown" },
    ];
    for (const row of ALIGN_ROWS) {
      add("O2", {
        id: `align:${row.mode}`, label: row.label, hint: "dois ou mais nós", group: GROUP_ORGANIZE, shortcut: row.shortcut, surfaces: SURFACES_CANVAS,
        inEditable: false, when: hasSelection(MIN_TO_ALIGN),
        run: guarded(() => void commitIf(M.align.alignNodes(docPort.doc(), selectedIds(), row.mode))),
      });
    }
    const DISTRIBUTE_ROWS: readonly { axis: AlignModule.DistributeAxis; label: string; shortcut: string }[] = [
      { axis: "horizontal", label: "Distribuir na horizontal", shortcut: "mod+alt+shift+ArrowRight" },
      { axis: "vertical", label: "Distribuir na vertical", shortcut: "mod+alt+shift+ArrowDown" },
    ];
    for (const row of DISTRIBUTE_ROWS) {
      add("O2", {
        id: `distribute:${row.axis}`, label: row.label, hint: "vãos iguais; as pontas ficam", group: GROUP_ORGANIZE, shortcut: row.shortcut,
        surfaces: SURFACES_CANVAS, inEditable: false, when: hasSelection(MIN_TO_DISTRIBUTE),
        run: guarded(() => void commitIf(M.align.distributeNodes(docPort.doc(), selectedIds(), row.axis))),
      });
    }
    add("O2", {
      id: "grid:snap", label: "Organizar na grade", hint: "encaixa os cantos na grade", group: GROUP_ORGANIZE, shortcut: "shift+g", surfaces: SURFACES_CANVAS,
      when: hasSelection(1),
      run: guarded(() => void commitIf(M.align.snapNodesToGrid(docPort.doc(), selectedIds()))),
    });

    // ---- O3 encaixe magnético ----
    const snap = api.snap;
    if (snap !== undefined) {
      add("O3", {
        id: "snap:toggle", label: () => (snap.enabled() ? "Desligar o encaixe magnético" : "Ligar o encaixe magnético"),
        hint: "paredes e vãos dos vizinhos; Ctrl ao arrastar também encaixa", group: GROUP_ORGANIZE, shortcut: "shift+m", surfaces: SURFACES_CANVAS,
        run: () => snap.setEnabled(!snap.enabled()),
      });
    }

    // ---- esconder controles ----
    const focus = api.focus;
    if (focus !== undefined) {
      // `f` já é enquadrar (canvas-argos): esconder os controles fica no Shift+F
      add("F1", {
        id: "canvas:focus", label: () => (focus.enabled() ? "Mostrar controles" : "Esconder controles"), hint: "só o canvas, sem barras nem ilhas", group: GROUP_VIEW,
        shortcut: "shift+f", surfaces: SURFACES_CANVAS, when: () => focus.available(),
        run: () => focus.setEnabled(!focus.enabled()),
      });
    }

    // ---- O5 copiar, colar, duplicar, excluir ----
    let clip: ClipboardModule.Clip | undefined;
    let pastes = 0;
    add("O5", {
      id: "clip:copy", label: "Copiar", hint: "só nós do usuário", group: GROUP_ORGANIZE, shortcut: "mod+c", surfaces: SURFACES_ALL,
      inEditable: false, when: hasSelection(1),
      run: guarded(() => {
        const copied = M.clipboard.copyNodes(docPort.doc(), selectedIds());
        if (copied.skipped.length > 0) say("warn", skippedText(copied.skipped));
        if (copied.clip.nodes.length === 0) return;
        clip = copied.clip;
        pastes = 0;
        say("info", `${plural(copied.clip.nodes.length, "nó copiado", "nós copiados")}.`);
      }),
    });
    add("O5", {
      id: "clip:paste", label: "Colar", hint: "deslocado a cada colagem", group: GROUP_ORGANIZE, shortcut: "mod+v", surfaces: SURFACES_CANVAS,
      inEditable: false, when: () => clip !== undefined && clip.nodes.length > 0,
      run: guarded(() => {
        if (clip === undefined) return;
        const doc = docPort.doc();
        pastes += 1;
        const offset = { dx: M.clipboard.PASTE_OFFSET.dx * pastes, dy: M.clipboard.PASTE_OFFSET.dy * pastes };
        const pasted = M.clipboard.pasteClip(doc, clip, M.clipboard.sequentialIds(doc, PASTE_ID_PREFIX), offset);
        if (commitIf(pasted.op)) docPort.select(pasted.nodeIds);
      }),
    });
    add("O5", {
      id: "clip:duplicate", label: "Duplicar", hint: "nó vivo não se duplica", group: GROUP_ORGANIZE, shortcut: "mod+d", surfaces: SURFACES_ALL,
      inEditable: false, when: hasSelection(1),
      run: guarded(() => {
        const doc = docPort.doc();
        const copy = M.clipboard.duplicateNodes(doc, selectedIds(), M.clipboard.sequentialIds(doc, DUPLICATE_ID_PREFIX));
        if (copy.skipped.length > 0) say("warn", skippedText(copy.skipped));
        if (commitIf(copy.op)) docPort.select(copy.nodeIds);
      }),
    });
    add("O5", {
      id: "clip:delete", label: "Excluir", hint: "desfazer devolve", group: GROUP_ORGANIZE, shortcut: ["Delete", "Backspace"], surfaces: SURFACES_ALL,
      when: hasSelection(1),
      run: guardedAsync(async () => {
        // terminal com processo vivo: excluir fecha o processo pelo mesmo diálogo de Ctrl+Alt+W (só tirar o nó deixava o pane órfão)
        const terminals = api.terminals;
        const ids = selectedIds();
        const closing = terminals?.closable === undefined ? [] : ids.filter((id) => terminals.closable?.(id) === true);
        const rest = ids.filter((id) => !closing.includes(id));
        if (rest.length > 0) {
          const removal = M.clipboard.deleteNodes(docPort.doc(), rest);
          if (removal.skipped.length > 0) say("warn", skippedText(removal.skipped));
          if (commitIf(removal.op) && closing.length === 0) docPort.select([]);
        }
        for (const id of closing) await terminals?.close(id);
      }),
    });

    // ---- N4 andar pelas conexões ----
    const walk = (direction: WalkModule.WalkDirection) => guarded(() => {
      const order = M.walk.walkOrder(docPort.doc());
      if (order.length === 0) return;
      const current = primary();
      // sem um nó só selecionado não há de onde partir: "próximo" começa no primeiro e "anterior" no último
      const target = current === undefined ? (direction === "next" ? order[0] : order[order.length - 1]) : M.walk.walkStep(order, current, direction);
      if (target === undefined) return;
      docPort.select([target]);
      docPort.reveal(target);
    });
    add("N4", {
      id: "walk:next", label: "Próximo nó ligado", hint: "segue as conexões", group: GROUP_ORGANIZE, shortcut: ["mod+alt+ArrowRight", "mod+alt+ArrowDown"],
      surfaces: SURFACES_CANVAS, inEditable: false, run: walk("next"),
    });
    add("N4", {
      id: "walk:previous", label: "Nó ligado anterior", hint: "segue as conexões", group: GROUP_ORGANIZE, shortcut: ["mod+alt+ArrowLeft", "mod+alt+ArrowUp"],
      surfaces: SURFACES_CANVAS, inEditable: false, run: walk("previous"),
    });

    // ---- N5 próximo que precisa de você ----
    const owner = api.owner;
    if (owner !== undefined) {
      const cycle = (direction: NextModule.CycleDirection) => guarded(() => {
        const queue = M.next.ownerQueue(owner.nodes());
        const item = M.next.cycleOwner(queue, primary(), direction);
        if (item === undefined) {
          say("info", "Nada espera por você agora.");
          return;
        }
        docPort.select([item.id]);
        docPort.reveal(item.id);
        say("info", M.next.OWNER_REASON_LABELS[item.reason]);
      });
      add("N5", { id: "owner:next", label: "Próximo que precisa de você", hint: "permissão, pergunta ou gate falho", group: GROUP_OWNER, shortcut: "n", surfaces: SURFACES_CANVAS, run: cycle("next") });
      add("N5", { id: "owner:previous", label: "Anterior que precisa de você", group: GROUP_OWNER, shortcut: "shift+n", surfaces: SURFACES_CANVAS, run: cycle("previous") });
    }

    // ---- A4 ações em lote ----
    const batch = api.batch;
    if (batch !== undefined) {
      const runBatch = (action: (typeof BatchModule.BATCH_ACTIONS)[number]) => guardedAsync(async () => {
        const plan = M.batch.planBatch(batch.nodes(selectedIds()), action, {}, batch.context());
        if (plan.problem !== undefined) {
          say("warn", BATCH_PROBLEM_TEXT[plan.problem], plan.problem);
          return;
        }
        const answer = await batch.confirm(plan);
        if (!answer.confirmed) return;
        const built = M.batch.batchRequests(plan, answer.typed);
        if (!built.ok) {
          say("warn", BATCH_PROBLEM_TEXT[built.code], built.code);
          return;
        }
        batch.show(M.batch.summarizeBatch(plan, await batch.send(built.requests)));
      });
      add("A4", {
        id: "batch:select-filtered", label: "Selecionar o filtrado", hint: "todos os nós que passam pelos filtros", group: GROUP_OWNER, shortcut: "mod+alt+a",
        surfaces: SURFACES_CANVAS, inEditable: false,
        run: guarded(() => {
          const present = new Set(docPort.doc().nodes.map((node) => node.id));
          const ids = batch.filteredIds().filter((id) => present.has(id));
          if (ids.length === 0) say("info", "Nenhum nó passa pelos filtros.");
          else docPort.select(ids);
        }),
      });
      add("A4", { id: "batch:resume", label: "Retomar os selecionados", hint: "confirma antes de enviar", group: GROUP_OWNER, shortcut: "shift+r", surfaces: SURFACES_CANVAS, when: hasSelection(1), run: runBatch("resume") });
      add("A4", { id: "batch:approve", label: "Aprovar as permissões dos selecionados", hint: "confirma antes de enviar", group: GROUP_OWNER, shortcut: "shift+a", surfaces: SURFACES_CANVAS, when: hasSelection(1), run: runBatch("approve_permission") });
      add("A4", { id: "batch:deny", label: "Negar as permissões dos selecionados", hint: "confirma antes de enviar", group: GROUP_OWNER, shortcut: "shift+x", surfaces: SURFACES_CANVAS, when: hasSelection(1), run: runBatch("deny_permission") });
      add("A4", { id: "batch:park", label: "Estacionar os selecionados", hint: "pede o handoff a cada um; confirma antes de enviar", group: GROUP_OWNER, surfaces: SURFACES_CANVAS, when: hasSelection(1), run: runBatch("park") });
    }

    // ---- O6 desfocar ----
    add("O6", {
      id: "blur:toggle",
      label: () => {
        const nodes = docPort.doc().nodes.filter((node) => selectedIds().includes(node.id));
        return nodes.length > 0 && nodes.every((node) => node.blurred) ? "Revelar o conteúdo" : "Desfocar o conteúdo";
      },
      hint: "o cabeçalho e o nome ficam", group: GROUP_ORGANIZE, shortcut: "shift+b", surfaces: SURFACES_ALL, when: hasSelection(1),
      run: guarded(() => void commitIf(M.blur.toggleBlur(docPort.doc(), selectedIds()))),
    });

    // ---- O7 elevar e acoplar ----
    const dock = api.dock;
    if (dock !== undefined) {
      const change = (next: (state: DockState, doc: CanvasDoc, id: string) => DockState) => guarded(() => {
        const id = primary();
        if (id !== undefined) dock.set(next(dock.state(), docPort.doc(), id));
      });
      const docked = (): boolean => {
        const id = primary();
        return id !== undefined && dock.state().columns.some((column) => column.id === id);
      };
      add("O7", {
        id: "dock:elevate", label: () => (primary() !== undefined && dock.state().elevated === primary() ? "Baixar o nó elevado" : "Elevar o nó"),
        hint: "painel central", group: GROUP_ORGANIZE, shortcut: "e", surfaces: SURFACES_ALL, when: () => primary() !== undefined,
        run: change((state, doc, id) => M.dock.toggleElevated(state, doc, id)),
      });
      add("O7", {
        id: "dock:left", label: "Acoplar à esquerda", hint: "coluna fixa", group: GROUP_ORGANIZE, shortcut: "[", surfaces: SURFACES_ALL, when: () => primary() !== undefined,
        run: change((state, doc, id) => M.dock.dockNode(state, doc, id, "left")),
      });
      add("O7", {
        id: "dock:right", label: "Acoplar à direita", hint: "coluna fixa", group: GROUP_ORGANIZE, shortcut: "]", surfaces: SURFACES_ALL, when: () => primary() !== undefined,
        run: change((state, doc, id) => M.dock.dockNode(state, doc, id, "right")),
      });
      add("O7", {
        id: "dock:undock", label: "Soltar a coluna", hint: "o nó volta ao canvas", group: GROUP_ORGANIZE, shortcut: "shift+e", surfaces: SURFACES_ALL, when: docked,
        run: change((state, _doc, id) => M.dock.undock(state, id)),
      });
    }

    // ---- L5 filtros salvos ----
    const saved = api.savedFilters;
    if (saved !== undefined) {
      const SF = readOptionalModel("savedFilters");
      const hasSaved = (): boolean => saved.set().filters.length > 0;
      const filtering = (): boolean => Object.values(saved.current()).some((values) => values !== undefined && values.length > 0);
      const options = () => saved.set().filters.map((filter) => ({ value: filter.id, label: filter.name }));
      /** Grava o conjunto novo; revisão velha relê do servidor e avisa (o dono repete sobre o conjunto atual). */
      const persist = async (next: SavedFilterSet): Promise<void> => {
        if (next === saved.set()) return;
        const result = await saved.save(next);
        if (result.ok) return;
        if (result.code !== SAVED_FILTERS_STALE_CODE) {
          say("error", "Os filtros salvos não foram gravados.", result.code);
          return;
        }
        await saved.reload();
        say("warn", "Outra aba mudou os filtros salvos: recarreguei; repita.", result.code);
      };
      add("L5", {
        id: "filters:save", label: "Salvar só os filtros", hint: "os filtros atuais, com um nome (a vista guarda a câmera)", group: GROUP_FILTERS, surfaces: SURFACES_CANVAS, when: filtering,
        run: guardedAsync(async () => {
          const name = await dialogs.askText({ title: "Nome do filtro" });
          if (name === null) return;
          await persist(SF.addSavedFilter(saved.set(), name, saved.current()).set);
        }),
      });
      add("L5", {
        id: "filters:apply", label: "Aplicar um filtro salvo", group: GROUP_FILTERS, surfaces: SURFACES_CANVAS, when: hasSaved,
        run: guardedAsync(async () => {
          const chosen = await dialogs.choose({ title: "Aplicar um filtro salvo", options: options() });
          const found = saved.set().filters.find((filter) => filter.id === chosen);
          if (found !== undefined) saved.apply(SF.readSelection(found.selection));
        }),
      });
      add("L5", {
        id: "filters:delete", label: "Apagar um filtro salvo", group: GROUP_FILTERS, surfaces: SURFACES_CANVAS, when: hasSaved,
        run: guardedAsync(async () => {
          const chosen = await dialogs.choose({ title: "Apagar um filtro salvo", options: options() });
          const found = saved.set().filters.find((filter) => filter.id === chosen);
          if (found === undefined) return;
          if (!(await dialogs.confirm({ title: "Apagar o filtro", text: `Apagar o filtro "${found.name}"?` }))) return;
          await persist(SF.removeSavedFilter(saved.set(), found.id));
        }),
      });
      add("L5", {
        id: "filters:default", label: "Marcar o filtro padrão", hint: "aplicado ao abrir, se o link não traz filtro", group: GROUP_FILTERS,
        surfaces: SURFACES_CANVAS, when: hasSaved,
        run: guardedAsync(async () => {
          const chosen = await dialogs.choose({ title: "Filtro padrão", options: [{ value: NO_DEFAULT_FILTER, label: "Nenhum" }, ...options()] });
          if (chosen === null) return;
          await persist(SF.setDefaultSavedFilter(saved.set(), chosen === NO_DEFAULT_FILTER ? null : chosen));
        }),
      });
    }

    // ---- T1 nó de agente como terminal (com o terminal focado, só estes atalhos chegam ao canvas) ----
    const tty = api.tty;
    if (tty !== undefined) {
      add("T1", {
        id: "tty:attention-next", label: "Próximo terminal que espera por você", hint: "em ordem; dá a volta", group: GROUP_TERMINAL, shortcut: "mod+shift+a",
        surfaces: ["palette"], inEditable: true,
        run: guarded(() => {
          if (!tty.nextAttention()) say("info", "Nenhum terminal espera por você agora.");
        }),
      });
      for (const n of TTY_JUMP_KEYS) {
        add("T1", {
          id: `tty:jump-${n}`, label: `Ir para o terminal ${n}`, hint: "segure Alt para ver os números", group: GROUP_TERMINAL, shortcut: `alt+${n}`,
          surfaces: [], inEditable: true,
          run: guarded(() => {
            if (!tty.jump(n)) say("info", `Nenhum terminal visível com o número ${n}.`);
          }),
        });
      }
      const zoomText = tty.zoomText;
      if (zoomText !== undefined) {
        const zoomRows: { id: string; label: string; hint: string; shortcut: string[]; kind: "in" | "out" | "reset" }[] = [
          { id: "tty:text-bigger", label: "Aumentar o texto do terminal", hint: "o nó cresce na proporção do terminal", shortcut: ["mod+alt+=", "mod+alt++"], kind: "in" },
          { id: "tty:text-smaller", label: "Diminuir o texto do terminal", hint: "o nó encolhe na proporção do terminal", shortcut: ["mod+alt+-"], kind: "out" },
          { id: "tty:text-reset", label: "Texto do terminal em 100%", hint: "o nó vai ao tamanho natural do terminal", shortcut: ["mod+alt+0"], kind: "reset" },
        ];
        for (const row of zoomRows) {
          add("T1", {
            id: row.id, label: row.label, hint: row.hint, group: GROUP_TERMINAL, shortcut: row.shortcut,
            surfaces: ["palette", "node-menu"], inEditable: true, when: () => tty.zoomable?.() === true,
            run: guarded(() => {
              if (!zoomText(row.kind)) say("info", "Selecione um terminal com a tela carregada para mudar o tamanho do texto.");
            }),
          });
        }
      }
      add("T1", {
        id: "tty:release", label: "Soltar o teclado do terminal", hint: "clicar fora também solta", group: GROUP_TERMINAL, shortcut: "mod+]",
        surfaces: ["palette"], inEditable: true, when: () => tty.focused(),
        run: guarded(() => tty.release()),
      });
    }

    // ---- W2 canvas por worktree ou rodada ----
    const scope = api.scope;
    if (scope !== undefined) {
      add("W2", {
        id: "canvas:scope", label: "Abrir o canvas de uma worktree ou rodada", hint: "cria na primeira vez", group: GROUP_CANVAS, surfaces: SURFACES_CANVAS,
        run: guardedAsync(async () => {
          const worktrees = scope.options().map((option) => ({ value: option.key, label: option.label }));
          const chosen = await dialogs.choose({ title: "Canvas de qual worktree ou rodada?", options: [...worktrees, { value: ROUND_CHOICE, label: "Abrir rodada…" }] });
          if (chosen === null) return;
          if (chosen !== ROUND_CHOICE) {
            await scope.open({ kind: "worktree", key: chosen });
            return;
          }
          const key = await dialogs.askText({ title: "Chave da rodada" });
          if (key !== null) await scope.open({ kind: "round", key });
        }),
      });
      add("W2", {
        id: "canvas:default", label: "Voltar ao canvas padrão", group: GROUP_CANVAS, surfaces: SURFACES_CANVAS,
        when: () => scope.current() !== M.store.DEFAULT_CANVAS_ID,
        run: guardedAsync(() => scope.openDefault()),
      });
    }

    // ---- A6 esboço de unidade ----
    const sketch = api.sketch;
    if (sketch !== undefined) {
      const C = readOptionalModel("create");
      const D = readOptionalModel("doc");
      add("A6", {
        id: "unit:sketch", label: "Novo esboço de unidade", hint: "gera os comandos de criar e iniciar", group: GROUP_CREATE, surfaces: SURFACES_CANVAS,
        run: guardedAsync(async () => {
          const kind = await dialogs.choose({ title: "Tipo de unidade", options: C.UNIT_KINDS.map((value) => ({ value, label: UNIT_KIND_LABELS[value] })) });
          const unitKind = C.UNIT_KINDS.find((candidate) => candidate === kind);
          if (unitKind === undefined) return;
          const name = await dialogs.askText({ title: "Nome curto da unidade" });
          if (name === null) return;
          const unit: CreateModule.UnitSketch = { kind: unitKind, name: name.trim() };
          if (unitKind === "project") {
            const branch = await dialogs.askText({ title: "Branch da unidade" });
            if (branch === null) return;
            unit.branch = branch.trim();
          }
          // valida antes de criar: esboço que não gera comando não entra no documento
          C.designUnit(unit);
          const doc = docPort.doc();
          const { x, y } = sketch.at();
          const top = doc.nodes.reduce((layer, node) => Math.max(layer, node.z), 0);
          const id = M.clipboard.sequentialIds(doc, SKETCH_ID_PREFIX)("node");
          const node = {
            id, type: C.UNIT_SKETCH_TYPE, x: Math.round(x - SKETCH_FRAME.w / 2), y: Math.round(y - SKETCH_FRAME.h / 2), ...SKETCH_FRAME,
            z: Math.min(D.CANVAS_LIMITS.layer, top + 1), data: { ...unit }, locked: false, blurred: false,
          };
          docPort.commit(M.history.opCreate(doc, [node]));
          docPort.select([id]);
          docPort.reveal(id);
        }),
      });
    }

    // ---- áreas: criar, encaixar, retirar, renomear e recolorir (o equivalente de menu e teclado do arrastar) ----
    {
      const A = readOptionalModel("areas");
      const isArea = (id: string): boolean => {
        const node = docPort.doc().nodes.find((candidate) => candidate.id === id);
        return node !== undefined && A.isAreaNode(node);
      };
      const loose = (): string[] => selectedIds().filter((id) => !isArea(id));
      const pickedAreas = (): string[] => selectedIds().filter(isArea);
      const areaOptions = (): { value: string; label: string }[] => A.areaReport(docPort.doc()).map((area) => ({ value: area.id, label: area.title }));
      add("O8", {
        id: "area:create", label: "Nova área", hint: "em volta da seleção, ou no centro da vista", group: GROUP_AREAS, surfaces: SURFACES_CANVAS,
        run: guarded(() => {
          const doc = docPort.doc();
          const members = loose();
          const id = M.clipboard.sequentialIds(doc, AREA_ID_PREFIX)("node");
          const around = doc.nodes.filter((node) => members.includes(node.id));
          let frame: { x: number; y: number; w?: number; h?: number };
          if (around.length > 0) {
            const pad = A.AREA_LIMITS.padding;
            const left = Math.min(...around.map((node) => node.x)) - pad;
            const top = Math.min(...around.map((node) => node.y)) - pad - A.AREA_HEADER;
            const right = Math.max(...around.map((node) => node.x + node.w)) + pad;
            const bottom = Math.max(...around.map((node) => node.y + node.h)) + pad;
            frame = { x: left, y: top, w: Math.max(A.AREA_LIMITS.minWidth, right - left), h: Math.max(A.AREA_LIMITS.minHeight, bottom - top) };
          } else {
            const center = api.sketch?.at() ?? { x: 0, y: 0 };
            frame = { x: Math.round(center.x - A.AREA_LIMITS.width / 2), y: Math.round(center.y - A.AREA_LIMITS.height / 2) };
          }
          const { op } = A.createAreaNode(doc, { id, ...frame, members });
          docPort.commit(op);
          docPort.select([id]);
          docPort.reveal(id);
        }),
      });
      add("O8", {
        id: "area:dock", label: "Encaixar em uma área…", hint: "o nó selecionado entra na área escolhida", group: GROUP_AREAS, surfaces: SURFACES_ALL,
        when: () => loose().length > 0 && A.areaReport(docPort.doc()).length > 0,
        run: guardedAsync(async () => {
          const chosen = await dialogs.choose({ title: "Encaixar em qual área?", options: areaOptions() });
          if (chosen === null) return;
          // o documento pode ter mudado enquanto o dono escolhia: o modelo confere a área e os nós de novo
          try {
            commitIf(A.dockNodes(docPort.doc(), loose(), chosen));
          } catch (error) {
            report(error);
          }
        }),
      });
      add("O8", {
        id: "area:undock", label: "Retirar da área", hint: "o nó sai da área e fica ao lado dela", group: GROUP_AREAS, surfaces: SURFACES_ALL,
        when: () => {
          const index = A.areaIndex(docPort.doc());
          return selectedIds().some((id) => index.has(id));
        },
        run: guarded(() => void commitIf(A.undockNodes(docPort.doc(), loose()))),
      });
      add("O8", {
        id: "area:rename", label: "Renomear a área", group: GROUP_AREAS, surfaces: SURFACES_ALL, when: () => pickedAreas().length === 1,
        run: guardedAsync(async () => {
          const [areaId] = pickedAreas();
          const area = A.areaReport(docPort.doc()).find((candidate) => candidate.id === areaId);
          if (area === undefined) return;
          const title = await dialogs.askText({ title: "Título da área", initial: area.title });
          if (title === null) return;
          try {
            commitIf(A.renameArea(docPort.doc(), area.id, title));
          } catch (error) {
            report(error);
          }
        }),
      });
      add("O8", {
        id: "area:color", label: "Cor da área…", hint: "uma das cores do painel", group: GROUP_AREAS, surfaces: SURFACES_ALL, when: () => pickedAreas().length === 1,
        run: guardedAsync(async () => {
          const [areaId] = pickedAreas();
          if (areaId === undefined) return;
          const chosen = await dialogs.choose({ title: "Cor da área", options: A.AREA_COLORS.map((color, i) => ({ value: color, label: `Cor ${i + 1}` })) });
          if (chosen === null) return;
          try {
            commitIf(A.recolorArea(docPort.doc(), areaId, chosen));
          } catch (error) {
            report(error);
          }
        }),
      });
    }

    // ---- W1 vários canvases e W3 exportar/importar ----
    const workspace = api.workspace;
    if (workspace !== undefined) {
      const isProtected = (): boolean => workspace.current().id === M.store.DEFAULT_CANVAS_ID;
      const taken = (): Set<string> => new Set(workspace.list().map((canvas) => canvas.id));
      /** Cria o canvas com o nome (e o documento, se vier) e troca para ele. Recusa acima do teto de canvases. */
      const createAndOpen = async (rawName: string, doc?: CanvasDoc): Promise<void> => {
        const name = M.store.requireCanvasName(rawName);
        if (workspace.list().length >= M.store.CANVAS_STORE_LIMITS.canvases) {
          say("error", `Já são ${M.store.CANVAS_STORE_LIMITS.canvases} canvases: exclua algum antes.`, M.store.CANVAS_STORE_ERRORS.limitReached);
          return;
        }
        const id = M.store.freshCanvasId(name, taken());
        await workspace.create(doc === undefined ? { id, name } : { id, name, doc });
        await workspace.switchTo(id);
      };
      const step = (delta: 1 | -1) => guardedAsync(async () => {
        const list = workspace.list();
        const at = list.findIndex((canvas) => canvas.id === workspace.current().id);
        const target = list[(Math.max(at, 0) + delta + list.length) % list.length];
        if (target !== undefined && target.id !== workspace.current().id) await workspace.switchTo(target.id);
      });
      const many = (): boolean => workspace.list().length > 1;

      add("W1", {
        id: "canvas:new", label: "Novo canvas", hint: "um por orquestração ou plano", group: GROUP_CANVAS, surfaces: SURFACES_CANVAS,
        run: guardedAsync(async () => {
          const name = await dialogs.askText({ title: "Nome do canvas novo" });
          if (name !== null) await createAndOpen(name);
        }),
      });
      add("W1", {
        id: "canvas:switch", label: "Trocar de canvas", group: GROUP_CANVAS, surfaces: SURFACES_CANVAS, when: many,
        run: guardedAsync(async () => {
          const options = workspace.list().map((canvas) => ({ value: canvas.id, label: canvas.name }));
          const chosen = await dialogs.choose({ title: "Trocar de canvas", options });
          if (chosen !== null && chosen !== workspace.current().id) await workspace.switchTo(chosen);
        }),
      });
      add("W1", { id: "canvas:next", label: "Próximo canvas", group: GROUP_CANVAS, shortcut: "mod+alt+]", surfaces: SURFACES_CANVAS, inEditable: false, when: many, run: step(1) });
      add("W1", { id: "canvas:previous", label: "Canvas anterior", group: GROUP_CANVAS, shortcut: "mod+alt+[", surfaces: SURFACES_CANVAS, inEditable: false, when: many, run: step(-1) });
      add("W1", {
        id: "canvas:rename", label: "Renomear o canvas", hint: "o padrão não se renomeia", group: GROUP_CANVAS, surfaces: SURFACES_CANVAS, when: () => !isProtected(),
        run: guardedAsync(async () => {
          const { id, name } = workspace.current();
          const next = await dialogs.askText({ title: "Nome do canvas", initial: name });
          if (next !== null) await workspace.rename(id, M.store.requireCanvasName(next));
        }),
      });
      add("W1", {
        id: "canvas:delete", label: "Excluir o canvas", hint: "o padrão não se exclui", group: GROUP_CANVAS, surfaces: SURFACES_CANVAS, when: () => !isProtected(),
        run: guardedAsync(async () => {
          const { id, name } = workspace.current();
          if (!(await dialogs.confirm({ title: "Excluir o canvas", text: `Excluir "${name}" e tudo o que ele guarda? Não há como desfazer.` }))) return;
          await workspace.switchTo(M.store.DEFAULT_CANVAS_ID);
          await workspace.remove(id);
        }),
      });
      add("W3", {
        id: "canvas:export", label: "Exportar o canvas", hint: "arquivo JSON", group: GROUP_CANVAS, surfaces: SURFACES_CANVAS,
        run: guarded(() => {
          const { name } = workspace.current();
          const file = M.export.exportCanvas(docPort.doc(), name, workspace.now?.() ?? new Date());
          const base = M.store.slugify(name, EXPORT_NAME_CHARS) || "canvas";
          workspace.saveFile({ filename: `${base}${EXPORT_SUFFIX}`, text: JSON.stringify(file, null, 2) });
        }),
      });
      add("W3", {
        id: "canvas:import", label: "Importar um canvas", hint: "vira um canvas novo; nada é sobrescrito", group: GROUP_CANVAS, surfaces: SURFACES_CANVAS,
        run: guardedAsync(async () => {
          const text = await workspace.pickFile();
          if (text === null) return;
          const imported = M.export.parseCanvasExport(text);
          await createAndOpen(imported.name, imported.doc);
        }),
      });
    }

    // ---- T2 terminal criado no canvas (ferramenta, menu do nó, fechar, papéis) ----
    const terminals = api.terminals;
    if (terminals !== undefined) {
      const withTarget = (task: (id: string) => Promise<void>) => guardedAsync(async () => {
        const id = terminals.target();
        if (id === null) say("info", "Selecione um terminal criado no canvas.");
        else await task(id);
      });
      const hasTarget = (): boolean => terminals.target() !== null;
      // conexões e fechar valem também para a nota: o terminal (focado ou selecionado) vem antes
      const notes = api.notes;
      const nodeTarget = (): { kind: "terminal" | "note"; id: string } | null => {
        const terminal = terminals.target();
        if (terminal !== null) return { kind: "terminal", id: terminal };
        const note = notes?.target() ?? null;
        return note === null ? null : { kind: "note", id: note };
      };
      const withNode = (task: (target: { kind: "terminal" | "note"; id: string }) => Promise<void>) => guardedAsync(async () => {
        const target = nodeTarget();
        if (target === null) say("info", notes === undefined ? "Selecione um terminal criado no canvas." : "Selecione um terminal criado no canvas ou uma nota.");
        else await task(target);
      });
      const hasNode = (): boolean => nodeTarget() !== null;
      add("T2", {
        id: "term:tool", label: "Novo terminal (ferramenta Terminal)", hint: "arraste um retângulo no canvas", group: GROUP_CREATE, surfaces: SURFACES_CANVAS,
        run: guarded(() => terminals.armTool()),
      });
      add("T2", {
        id: "term:edit", label: "Editar o terminal…", hint: "nome, ícone e predefinição", group: GROUP_TERMINAL, surfaces: ["node-menu"], when: hasTarget,
        run: withTarget((id) => terminals.edit(id, "details")),
      });
      add("T2", {
        id: "term:role", label: "Papel do terminal…", hint: "trocar reinicia só o processo", group: GROUP_TERMINAL, surfaces: ["node-menu"], when: hasTarget,
        run: withTarget((id) => terminals.role(id)),
      });
      add("T2", {
        id: "term:appearance", label: "Aparência…", hint: "ícone, cor, tema e fonte", group: GROUP_TERMINAL, surfaces: ["node-menu"], when: hasTarget,
        run: withTarget((id) => terminals.edit(id, "appearance")),
      });
      add("T2", {
        id: "term:connections", label: "Conexões…", hint: "pular até a outra ponta, trocar o estilo ou remover", group: GROUP_TERMINAL, surfaces: ["node-menu"], when: hasNode,
        run: withNode(({ id }) => terminals.connections(id)),
      });
      // `tty:` deixa o atalho valer com o teclado no terminal (a tecla está em TTY_CANVAS_KEYS, que o NodeTty não consome).
      // O mesmo atalho fecha a nota selecionada: o tipo do nó decide o fluxo
      add("T2", {
        id: "tty:close", label: () => (nodeTarget()?.kind === "note" ? "Fechar nota" : "Fechar terminal"),
        hint: "terminal: pede o nome e fecha o processo; nota: confirma e apaga o arquivo da pasta padrão", group: GROUP_TERMINAL, shortcut: "mod+alt+w",
        surfaces: ["palette", "node-menu"], inEditable: true, when: hasNode,
        run: withNode((target) => (target.kind === "note" && notes !== undefined ? notes.close(target.id) : terminals.close(target.id))),
      });
      add("T2", {
        id: "term:roles", label: "Papéis dos terminais…", hint: "criar, editar, descobrir e apagar", group: GROUP_TERMINAL, surfaces: SURFACES_CANVAS,
        run: guarded(() => terminals.roles()),
      });
    }

    // ---- compositor e conexões montados na página (`tty:` deixa o atalho valer com o teclado no terminal) ----
    const composer = api.composer;
    if (composer !== undefined) {
      add("T1", {
        id: "tty:composer", label: "Compositor do terminal", hint: "abre e fecha; segue o foco", group: GROUP_TERMINAL, shortcut: "mod+alt+p",
        surfaces: ["palette"], inEditable: true, when: () => composer.available(),
        run: guarded(() => composer.toggle()),
      });
    }
    const supervisor = api.supervisor;
    if (supervisor !== undefined) {
      // `tty:` deixa o atalho valer com o teclado no terminal (Ctrl+Shift+O está em TTY_CANVAS_KEYS, que o NodeTty não consome)
      add("S1", {
        id: "tty:supervisor", label: "Supervisor", hint: "abre e fecha o painel do supervisor", group: GROUP_TERMINAL,
        shortcut: "mod+shift+o", surfaces: ["palette"], inEditable: true, run: guarded(() => supervisor.toggle()),
      });
    }
    const links = api.links;
    if (links !== undefined) {
      add("D5", {
        id: "tty:link", label: "Conectar a outro terminal ou nota", hint: "a linha segue o cursor; clique no destino, Esc cancela", group: GROUP_LINKS,
        shortcut: "mod+l", surfaces: ["palette", "node-menu"], inEditable: true,
        run: guarded(() => {
          if (!links.start()) say("info", "Selecione um terminal ou uma nota para conectar.");
        }),
      });
    }

    return rows;
  }

  /**
   * Registra os comandos no registro de comandos da página (Ctrl+K, botão direito, ajuda `?`). Chamar de novo (modo estrito
   * do React) não repete nem lança. Comando recusado pelo registro (atalho já tomado, por exemplo) fica de fora sozinho e
   * entra em `refused`; o resto segue.
   */
  function registerCanvasCommands(registry: CommandRegistry<CanvasCommandCtx>, api: CanvasCommandsApi): RegisterReport {
    const report: RegisterReport = { registered: [], refused: [] };
    for (const { def } of canvasCommandRows(api)) {
      if (registry.get(def.id) !== undefined) continue;
      try {
        registry.register(def);
        report.registered.push(def.id);
      } catch (error) {
        const coded = codedError(error);
        if (coded === undefined || !coded.code.startsWith("registry_")) throw error;
        const subject = error instanceof Error && "subject" in error && typeof error.subject === "string" ? error.subject : undefined;
        report.refused.push(subject === undefined ? { id: def.id, code: coded.code } : { id: def.id, code: coded.code, subject });
      }
    }
    return report;
  }

  return { registerCanvasCommands, canvasCommandRows };
}

type ArgosCanvasCommandsApi = ReturnType<typeof makeArgosCanvasCommands>;
(globalThis as unknown as { ArgosCanvasCommands: ArgosCanvasCommandsApi }).ArgosCanvasCommands = makeArgosCanvasCommands();
export type {
  ArgosCanvasCommandsApi, CanvasBatchPort, CanvasCommandCtx, CanvasCommandRow, CanvasCommandsApi, CanvasDialogPort, CanvasDockPort, CanvasDocPort, CanvasFocusPort, CanvasInfo, CanvasNote,
  CanvasOwnerPort, CanvasSavedFiltersPort, CanvasComposerPort, CanvasLinkPort, CanvasNotePort, CanvasSupervisorPort, CanvasScopeChoice, CanvasScopePort, CanvasSketchPort, CanvasSnapPort, CanvasTerminalPort, CanvasTtyPort, CanvasWorkspacePort, RegisterReport,
};
