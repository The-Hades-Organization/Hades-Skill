/* Menu de contexto do canvas do Argos (montado em #/argos): botão direito num nó (ações do agente e os comandos que o
 * tipo declara) ou no vazio (comandos da superfície `canvas-menu`). Script clássico: registra window.ArgosCanvasMenu.
 * Depende de React e de window.CanvasModel (actions, commands). As ações vêm de src/lib/canvas-actions.ts (o que vale agora
 * e por quê), os comandos do registro de src/lib/canvas-commands.ts. Teclado: setas, Home/End, Enter e Espaço ativam, Esc e
 * Tab fecham e devolvem o foco a quem abriu o menu. O menu não faz POST: uma ação do agente é entregue a `onAction` (a página
 * abre o formulário e a confirmação); um comando roda direto pelo registro. Desabilitar item é só tela: o servidor confere. */
import type { ActionContext, ActionItem, ActionNode } from "../../../../src/lib/canvas-actions.ts";
import type * as ActionsModule from "../../../../src/lib/canvas-actions.ts";
import type { Viewport } from "../../../../src/lib/canvas-camera.ts";
import type * as CommandsModule from "../../../../src/lib/canvas-commands.ts";
import type { CommandRegistry } from "../../../../src/lib/canvas-commands.ts";
import type { NodeTypeDef } from "../../../../src/lib/canvas-types.ts";

type MenuTarget =
  | { kind: "node"; node: ActionNode; /** Tipo do nó no registro: dele vêm os ids de comando do menu (`menu`). Sem ele, só as ações do agente. */ nodeType?: NodeTypeDef }
  | { kind: "canvas" };

interface MenuItem {
  /** `action:<ação>` ou `command:<id>`. */
  id: string;
  kind: "action" | "command";
  label: string;
  hint: string;
  group: string;
  /** Primeiro atalho, já escrito para a tela (`Ctrl+K`). */
  shortcut?: string;
  disabled: boolean;
  /** Por que o item não vale agora. */
  reason?: string;
  /** Ação destrutiva: a página pede o nome do agente antes de enviar. */
  dangerous: boolean;
}

type MenuMove = { type: "move"; index: number } | { type: "activate"; item: MenuItem } | { type: "close" } | { type: "none" };

interface CanvasMenuProps<Ctx> {
  target: MenuTarget;
  /** Ponto da tela (pixels do canvas) onde o botão direito foi dado. */
  at: { x: number; y: number };
  view: Viewport;
  registry: CommandRegistry<Ctx>;
  commandCtx: Ctx;
  actionCtx?: ActionContext;
  /** Ação do agente escolhida: a página abre o formulário (campos, confirmação) e faz o POST. */
  onAction(item: ActionItem, node: ActionNode): void;
  onClose(): void;
  /** Falha ao montar o menu ou ao rodar um comando; sem isso a falha só vai ao console. */
  onError?(message: string): void;
  /** Menu do vazio enxuto: só estes comandos (já agrupados para a tela) e, no fim, "Mais N comandos…" que abre a paleta. Sem isso, todos. */
  essentials?: readonly CanvasEssential[];
}

/** Um comando que fica no menu enxuto do vazio e o grupo com que aparece nele. */
interface CanvasEssential {
  id: string;
  group: string;
}

const MENU_WIDTH_PX = 300;
const ROW_PX = 32;
const GROUP_PX = 24;
const PADDING_PX = 8;
const EDGE_PX = 8;
const REASON_PX = 14;
const ACTION_GROUP = "Agente";
const MORE_GROUP = "Mais";
const PALETTE_COMMAND = "palette";
/** O que o dono mais faz com o clique no vazio: criar aqui, arrumar, enquadrar, voltar ao que pede ele. O resto está na paleta. */
const CANVAS_ESSENTIALS: readonly CanvasEssential[] = [
  { id: "unit:sketch", group: "Criar aqui" },
  { id: "term:tool", group: "Criar aqui" },
  { id: "area:create", group: "Criar aqui" },
  { id: "tidy:arrange", group: "Arrumar" },
  { id: "layout:toggle", group: "Arrumar" },
  { id: "fit", group: "Ver" },
  { id: "view:list", group: "Ver" },
  { id: "view:save", group: "Ver" },
  { id: "owner:next", group: "Ir para" },
  { id: "search:clear", group: "Limpar" },
  { id: "filters:clear", group: "Limpar" },
  { id: "help", group: "Ajuda" },
];
const EMPTY_LABEL = "Nenhuma ação aqui";
const ITEM_ID_PREFIX = "argos-menu-item-";

const MOVE_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);
const ACTIVATE_KEYS = new Set(["Enter", " "]);
const CLOSE_KEYS = new Set(["Escape", "Tab"]);

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

/** Primeiro item que se pode ativar, ou 0 (o menu sem item ativável ainda abre no primeiro). */
const firstEnabled = (items: readonly MenuItem[]): number => Math.max(0, items.findIndex((i) => !i.disabled));

/**
 * A tecla vira um movimento: setas e Home/End andam (do último volta ao primeiro e vice-versa), Enter e Espaço ativam o item
 * atual se ele vale, Esc e Tab fecham. Item desabilitado continua alcançável (o leitor de tela lê o motivo) mas não ativa.
 */
function menuKey(items: readonly MenuItem[], active: number, key: string): MenuMove {
  if (CLOSE_KEYS.has(key)) return { type: "close" };
  if (items.length === 0) return { type: "none" };
  if (MOVE_KEYS.has(key)) {
    const last = items.length - 1;
    const index = key === "Home" ? 0 : key === "End" ? last : key === "ArrowDown" ? (active >= last ? 0 : active + 1) : active <= 0 ? last : active - 1;
    return { type: "move", index };
  }
  const item = items[active];
  if (ACTIVATE_KEYS.has(key) && item && !item.disabled) return { type: "activate", item };
  return { type: "none" };
}

/** Canto do menu: abre no ponto do clique; sem espaço à direita ou embaixo, abre para a esquerda ou para cima; sempre dentro da tela. */
function placeMenu(at: { x: number; y: number }, view: Viewport, size: Viewport): { x: number; y: number } {
  const x = at.x + size.w > view.w - EDGE_PX ? at.x - size.w : at.x;
  const y = at.y + size.h > view.h - EDGE_PX ? at.y - size.h : at.y;
  return { x: Math.round(clamp(x, EDGE_PX, view.w - size.w - EDGE_PX)), y: Math.round(clamp(y, EDGE_PX, view.h - size.h - EDGE_PX)) };
}

/** Altura estimada: uma linha por item, uma faixa por grupo, e nunca mais que a tela (o excedente rola). */
function menuSize(items: readonly MenuItem[], view: Viewport): Viewport {
  const groups = new Set(items.map((i) => i.group)).size;
  const rows = Math.max(1, items.length);
  const reasons = items.filter((i) => i.disabled && i.reason).length;
  return { w: MENU_WIDTH_PX, h: Math.min(rows * ROW_PX + reasons * REASON_PX + groups * GROUP_PX + 2 * PADDING_PX, view.h - 2 * EDGE_PX) };
}

function makeArgosCanvasMenu() {
  const model = (globalThis as unknown as { CanvasModel?: { actions: typeof ActionsModule; commands: typeof CommandsModule } }).CanvasModel;
  if (!model?.actions || !model.commands) throw new Error("ArgosCanvasMenu: carregue /ui/lib/canvas-model.js (com `actions` e `commands`) antes de canvas-menu.js");
  const A = model.actions;
  const K = model.commands;

  const shortcutOf = (shortcuts: readonly string[]): string | undefined => {
    const first = shortcuts[0];
    return first === undefined ? undefined : K.chordLabel(first);
  };

  const fromAction = (item: ActionItem): MenuItem => {
    const base: MenuItem = { id: `action:${item.key}`, kind: "action", label: item.label, hint: item.hint, group: ACTION_GROUP, disabled: !item.available, dangerous: item.dangerous };
    return item.reason ? { ...base, reason: item.reason.message } : base;
  };
  const fromCommand = (entry: CommandsModule.CommandEntry): MenuItem => {
    const base: MenuItem = { id: `command:${entry.id}`, kind: "command", label: entry.label, hint: entry.hint, group: entry.group, disabled: false, dangerous: false };
    const shortcut = shortcutOf(entry.shortcuts);
    return shortcut === undefined ? base : { ...base, shortcut };
  };

  /**
   * Os itens do menu, na ordem da tela. Nó: as ações do agente (as que não valem ficam desabilitadas, com o motivo) e depois
   * os comandos do `menu` do tipo, só os que valem agora. Vazio: os comandos de `canvas-menu`. Lança `RegistryError` se o
   * `menu` do tipo cita comando que não existe (quem chama mostra o erro).
   */
  function menuItems<Ctx>(target: MenuTarget, deps: { registry: CommandRegistry<Ctx>; commandCtx: Ctx; actionCtx?: ActionContext }): MenuItem[] {
    if (target.kind === "canvas") return deps.registry.canvasMenu(deps.commandCtx).map(fromCommand);
    const actions = A.actionsFor(target.node, deps.actionCtx ?? {}).map(fromAction);
    const commands = target.nodeType ? deps.registry.nodeMenu(target.nodeType, deps.commandCtx).map(fromCommand) : [];
    return [...actions, ...commands];
  }

  /**
   * Menu enxuto do vazio: os comandos de `essentials` que valem agora (na ordem da lista, no grupo dela) e, se a paleta existe,
   * o item "Mais N comandos…" com o que ficou de fora. Um comando fora da lista só some daqui: continua na paleta.
   */
  function curateCanvasItems<Ctx>(items: readonly MenuItem[], essentials: readonly CanvasEssential[], registry: CommandRegistry<Ctx>): MenuItem[] {
    const byId = new Map(items.map((i) => [i.id, i]));
    const kept = essentials.flatMap(({ id, group }) => {
      const item = byId.get(`command:${id}`);
      return item ? [{ ...item, group }] : [];
    });
    if (!registry.get(PALETTE_COMMAND)) return kept;
    const hidden = items.length - kept.length;
    const more: MenuItem = { id: `command:${PALETTE_COMMAND}`, kind: "command", label: hidden > 0 ? `Mais ${hidden} comandos…` : "Buscar um comando…", hint: "a paleta tem todos os comandos", group: MORE_GROUP, shortcut: "Ctrl+K", disabled: false, dangerous: false };
    return [...kept, more];
  }

  function safeItems<Ctx>(target: MenuTarget, deps: { registry: CommandRegistry<Ctx>; commandCtx: Ctx; actionCtx?: ActionContext }): { items: MenuItem[]; error?: string } {
    try {
      return { items: menuItems(target, deps) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "não foi possível montar o menu";
      return { items: target.kind === "node" ? A.actionsFor(target.node, deps.actionCtx ?? {}).map(fromAction) : [], error: message };
    }
  }

  interface MenuUi {
    h: ReactApi["createElement"];
    items: readonly MenuItem[];
    active: number;
    at: { x: number; y: number };
    size: Viewport;
    label: string;
    setRoot?(el: unknown): void;
    onActive(index: number): void;
    onPick(item: MenuItem): void;
    onKeyDown(event: { key: string; preventDefault(): void }): void;
  }

  const ROOT = "absolute z-30 flex flex-col overflow-y-auto border border-border-strong bg-background py-1 t-body outline-none";
  const ROW = "flex min-h-8 w-full cursor-pointer items-center gap-2 px-3 text-left outline-none max-md:min-h-11";

  /** Árvore de elementos do menu: pura, sem hooks, para o teste ler sem DOM. Os grupos seguidos ganham um cabeçalho cada. */
  function renderMenu(ui: MenuUi): ReactNode {
    const { h } = ui;
    const rows: ReactNode[] = [];
    let group: string | undefined;
    ui.items.forEach((item, index) => {
      if (item.group !== group) {
        group = item.group;
        rows.push(h("div", { key: `group:${group}`, role: "presentation", className: "px-3 pt-1 t-meta text-muted-foreground" }, group));
      }
      const active = index === ui.active;
      const description = [item.reason ?? item.hint, item.dangerous ? "pede o nome do agente" : ""].filter(Boolean).join(" · ");
      rows.push(h("div", {
        key: item.id, id: `${ITEM_ID_PREFIX}${index}`, role: "menuitem", "aria-disabled": item.disabled || undefined, "aria-keyshortcuts": item.shortcut, title: description || undefined,
        "data-active": active || undefined, "data-dangerous": item.dangerous || undefined,
        className: `${ROW} ${active ? "bg-accent" : ""} ${item.disabled ? "opacity-50 cursor-default" : ""} ${item.dangerous ? "text-bad" : ""}`,
        onPointerMove: () => ui.onActive(index), onClick: () => ui.onPick(item),
      },
      // o motivo de um item que não vale agora fica à vista (não só no title): o dono vê o que falta para valer
      h("span", { className: "flex min-w-0 flex-1 flex-col py-1" },
        h("span", { className: "truncate" }, item.label),
        item.disabled && item.reason ? h("span", { className: "t-meta truncate text-muted-foreground" }, item.reason) : null),
      item.shortcut ? h("span", { className: "t-meta text-muted-foreground" }, item.shortcut) : null));
    });
    if (ui.items.length === 0) rows.push(h("div", { key: "empty", role: "menuitem", "aria-disabled": true, className: `${ROW} cursor-default opacity-50` }, EMPTY_LABEL));
    return h("div", {
      ref: ui.setRoot, role: "menu", tabIndex: -1, "aria-label": ui.label, "aria-activedescendant": ui.items.length > 0 ? `${ITEM_ID_PREFIX}${ui.active}` : undefined,
      className: ROOT, style: { left: ui.at.x, top: ui.at.y, width: ui.size.w, maxHeight: ui.size.h }, onKeyDown: ui.onKeyDown,
    }, ...rows);
  }

  function CanvasMenu<Ctx>(props: CanvasMenuProps<Ctx>): ReactNode {
    const { target, registry, commandCtx, onClose } = props;
    // o menu do tipo cita comando que não existe: o menu abre só com o que dá (as ações do agente) e o erro é avisado
    const safe = safeItems(target, { registry, commandCtx, ...(props.actionCtx ? { actionCtx: props.actionCtx } : {}) });
    const error = safe.error;
    const items = target.kind === "canvas" && props.essentials ? curateCanvasItems(safe.items, props.essentials, registry) : safe.items;
    React.useEffect(() => {
      if (error !== undefined) (props.onError ?? console.warn)(error);
    }, [error]);
    const [active, setActive] = React.useState<number>(firstEnabled(items));
    const root = React.useRef<{ contains(n: unknown): boolean; focus(): void } | null>(null);
    const safeActive = Math.min(active, Math.max(0, items.length - 1));
    const size = menuSize(items, props.view);

    // foco no menu ao abrir e de volta a quem o abriu ao fechar; clique fora fecha. Ouvinte e foco têm o dono do menu.
    React.useEffect(() => {
      if (typeof document === "undefined") return undefined;
      const opener = document.activeElement as { focus?: () => void; isConnected?: boolean } | null;
      root.current?.focus();
      const outside = (event: { target: unknown }): void => {
        if (root.current && !root.current.contains(event.target)) onClose();
      };
      document.addEventListener("pointerdown", outside);
      return () => {
        document.removeEventListener("pointerdown", outside);
        if (opener?.isConnected && typeof opener.focus === "function") opener.focus();
      };
    }, []);
    React.useEffect(() => {
      if (typeof document === "undefined") return;
      document.getElementById(`${ITEM_ID_PREFIX}${safeActive}`)?.scrollIntoView?.({ block: "nearest" });
    }, [safeActive]);

    const pick = (item: MenuItem): void => {
      if (item.disabled) return;
      if (item.kind === "action") {
        const key = item.id.slice("action:".length);
        const action = target.kind === "node" ? A.actionsFor(target.node, props.actionCtx ?? {}).find((a) => a.key === key) : undefined;
        if (action && target.kind === "node") props.onAction(action, target.node);
      } else {
        const def = registry.get(item.id.slice("command:".length));
        try {
          if (def && (def.when === undefined || def.when(commandCtx))) def.run(commandCtx);
          else (props.onError ?? console.warn)(`o comando "${item.label}" já não vale`);
        } catch (error) {
          (props.onError ?? console.warn)(error instanceof Error ? error.message : `o comando "${item.label}" falhou`);
        }
      }
      onClose();
    };
    const onKeyDown = (event: { key: string; preventDefault(): void }): void => {
      const move = menuKey(items, safeActive, event.key);
      if (move.type === "none") return;
      event.preventDefault();
      if (move.type === "move") setActive(move.index);
      else if (move.type === "activate") pick(move.item);
      else onClose();
    };

    return renderMenu({
      h: React.createElement, items, active: safeActive, at: placeMenu(props.at, props.view, size), size, setRoot: (el) => { root.current = el as typeof root.current; },
      label: target.kind === "node" ? `Ações de ${target.node.label}` : "Ações do canvas", onActive: setActive, onPick: pick, onKeyDown,
    });
  }

  return { CanvasMenu, menuItems, safeItems, curateCanvasItems, CANVAS_ESSENTIALS, menuKey, placeMenu, menuSize, renderMenu, firstEnabled, EMPTY_LABEL, ACTION_GROUP };
}

type ArgosCanvasMenuApi = ReturnType<typeof makeArgosCanvasMenu>;
(globalThis as unknown as { ArgosCanvasMenu: ArgosCanvasMenuApi }).ArgosCanvasMenu = makeArgosCanvasMenu();
export type { ArgosCanvasMenuApi, CanvasEssential, CanvasMenuProps, MenuItem, MenuMove, MenuTarget };
