// Atalhos de criar terminal no canvas do Argos (reference/argos.md §Teclas): Shift+A agente, Shift+O orquestrador e
// Shift+S shell. Puro e sem Node: o mapa tecla → ação, o corpo do POST de criação e o ponto em que o nó nasce. Quem
// registra os comandos e fala com o servidor é a página.
import { chordLabel, createCommandRegistry, type CommandDef, type KeyInput } from "./canvas-commands.ts";

export const CREATE_KINDS = ["agent", "orchestrator", "shell"] as const;
export type CreateKind = (typeof CREATE_KINDS)[number];

/** Onde está o foco do teclado: só no canvas a tecla é da criação; nos outros ela é de quem tem o foco. */
export type CreateFocus = "canvas" | "terminal" | "note" | "field";

export const CREATE_SHORTCUT_CHORDS: Readonly<Record<CreateKind, string>> = Object.freeze({ agent: "shift+a", orchestrator: "shift+o", shell: "shift+s" });

const CREATE_ROWS: Readonly<Record<CreateKind, { label: string; hint: string }>> = {
  agent: { label: "Novo terminal de agente", hint: "agente comum, com os padrões do menu de criação" },
  orchestrator: { label: "Novo terminal de orquestrador", hint: "agente com instruções de gerente" },
  shell: { label: "Novo terminal de shell", hint: "só o shell, sem agente, na pasta do projeto" },
};

const GROUP_CREATE = "Terminal";
const commandId = (kind: CreateKind): string => `create:${kind}`;

/** Comandos do registro; `onCreate` recebe o tipo. Aparecem na paleta, no menu do fundo e na ajuda `?`. */
export function createCommandDefs<Ctx>(onCreate: (kind: CreateKind, ctx: Ctx) => void): CommandDef<Ctx>[] {
  return CREATE_KINDS.map((kind) => ({
    id: commandId(kind), label: CREATE_ROWS[kind].label, hint: CREATE_ROWS[kind].hint, group: GROUP_CREATE,
    shortcut: CREATE_SHORTCUT_CHORDS[kind], surfaces: ["palette", "canvas-menu"], run: (ctx: Ctx) => onCreate(kind, ctx),
  }));
}

const keyRegistry = createCommandRegistry<undefined>();
for (const def of createCommandDefs<undefined>(() => undefined)) keyRegistry.register(def);

/** A ação que a tecla pede com este foco, ou `null`. Com o foco fora do canvas a tecla não é da criação. */
export function createKeyAction(event: KeyInput, focus: CreateFocus): CreateKind | null {
  if (focus !== "canvas") return null;
  const found = keyRegistry.resolveKey(event, { editable: false, ctx: undefined });
  return CREATE_KINDS.find((kind) => commandId(kind) === found?.id) ?? null;
}

/** Linhas da legenda: tipo, rótulo e o acorde escrito para a tela. */
export function createLegendRows(): { kind: CreateKind; label: string; keys: string }[] {
  return CREATE_KINDS.map((kind) => ({ kind, label: CREATE_ROWS[kind].label, keys: chordLabel(CREATE_SHORTCUT_CHORDS[kind]) }));
}

/**
 * Corpo do POST /api/argos/terminals. Agente e orquestrador seguem os padrões globais (predefinição, papel e agente vazios);
 * shell leva só `shell: true`: sem agente, papel, predefinição nem instruções de gerente.
 */
export function terminalCreateBody(kind: CreateKind, form: { name: string; cwd?: string }): Record<string, unknown> {
  const body: Record<string, unknown> = { name: form.name.trim() };
  const cwd = form.cwd?.trim();
  if (cwd) body.cwd = cwd;
  if (kind === "orchestrator") body.orchestrator = true;
  if (kind === "shell") body.shell = true;
  return body;
}

export interface Point { x: number; y: number }
export interface Size { w: number; h: number }

/** Retângulo do nó novo: centrado no cursor quando ele está sobre o canvas, senão no centro da vista. */
export function createRect(cursor: Point | null, center: Point, size: Size): Point & Size {
  const at = cursor ?? center;
  return { x: at.x - size.w / 2, y: at.y - size.h / 2, w: size.w, h: size.h };
}
