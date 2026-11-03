// Registro de comandos e atalhos do canvas (reference/argos.md §Tipos de nó e comandos). Um comando é declarado uma vez
// (id, rótulo, atalho, condição) e alimenta a paleta (Ctrl+K), o menu de botão direito do nó e do fundo e a ajuda `?`.
// Atalho em conflito é erro no registro, nunca silêncio. Lógica pura e sem Node: roda no painel e no navegador.
import { REGISTRY_ERRORS, RegistryError, type NodeTypeDef, type RegistryErrorCode } from "./canvas-types.ts";

/** Onde o comando é listado. A ajuda `?` não é uma superfície: lista todo comando que tem atalho. */
export const COMMAND_SURFACES = ["palette", "node-menu", "canvas-menu"] as const;
export type CommandSurface = (typeof COMMAND_SURFACES)[number];

export interface CommandDef<Ctx> {
  id: string;
  /** Texto fixo ou calculado do contexto (ex.: leva o nome do nó selecionado). */
  label: string | ((ctx: Ctx) => string);
  hint?: string;
  group: string;
  /** Um acorde (`mod+k`, `j`, `?`, `Escape`) ou vários para o mesmo comando. `mod` = Ctrl ou Cmd. */
  shortcut?: string | readonly string[];
  surfaces: readonly CommandSurface[];
  /** Condição: comando que não vale agora some das listas e o atalho não dispara. Sem ela, vale sempre. */
  when?: (ctx: Ctx) => boolean;
  /**
   * Com o foco num campo de texto: `true` vale também para acorde sem `mod`; `false` não vale nem com `mod` (desfazer do campo
   * é do campo). Sem ele, só os acordes com `mod` valem.
   */
  inEditable?: boolean;
  run: (ctx: Ctx) => void;
}

export interface CommandEntry {
  id: string;
  label: string;
  hint: string;
  group: string;
  /** Acordes normalizados (`mod+k`); `chordLabel` os escreve para a tela. */
  shortcuts: readonly string[];
}

export interface KeyInput { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }

interface Chord { mod: boolean; alt: boolean; shift: boolean; key: string }

const COMMAND_ID = /^[\w.:-]{1,200}$/;
const LABEL_MAX = 120;
const NAMED_KEYS = ["Enter", "Escape", "Tab", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"] as const;
const EVENT_KEY_OF_NAMED: Readonly<Record<string, string>> = { Space: " " };
const CHORD_PATTERN = /^((?:(?:mod|alt|shift)\+)*)(.+)$/;

const fail = (code: RegistryErrorCode, message: string, subject?: string): never => {
  throw new RegistryError(code, message, subject);
};

const isLetter = (key: string): boolean => key.length === 1 && key.toLowerCase() !== key.toUpperCase();
/** Em tecla de pontuação o caractere já traz o shift (`?` é shift+/), então o shift não entra na comparação. */
const shiftMatters = (key: string): boolean => key.length > 1 || isLetter(key);

function parseChord(raw: string): Chord {
  const found = CHORD_PATTERN.exec(raw);
  if (!found) return fail(REGISTRY_ERRORS.invalidShortcut, `acorde inválido: "${raw}"`, raw);
  const modifiers = (found[1] ?? "").split("+").filter(Boolean);
  const key = found[2] as string;
  if (new Set(modifiers).size !== modifiers.length) return fail(REGISTRY_ERRORS.invalidShortcut, `modificador repetido em "${raw}"`, raw);
  const named = (NAMED_KEYS as readonly string[]).includes(key);
  if (!named && key.length !== 1) return fail(REGISTRY_ERRORS.invalidShortcut, `tecla desconhecida em "${raw}"`, raw);
  if (isLetter(key) && key !== key.toLowerCase()) return fail(REGISTRY_ERRORS.invalidShortcut, `letra em minúscula e shift à parte: "${raw}"`, raw);
  const shift = modifiers.includes("shift");
  if (shift && !shiftMatters(key)) return fail(REGISTRY_ERRORS.invalidShortcut, `"${key}" já traz o shift: escreva só o caractere ("${raw}")`, raw);
  return { mod: modifiers.includes("mod"), alt: modifiers.includes("alt"), shift, key };
}

/**
 * Acordes que o navegador (Firefox, Chrome) ou o sistema (macOS) tomam antes da página: o `keydown` não chega ou o
 * `preventDefault` não vale. Comando que pedir um deles é recusado no registro.
 */
export const BROWSER_RESERVED_CHORDS: readonly string[] = Object.freeze([
  "mod+n", "mod+shift+n", "mod+t", "mod+shift+t", "mod+w", "mod+shift+w", "mod+shift+p", "mod+q", "mod+shift+q",
  "mod+Tab", "mod+shift+Tab", "mod+PageUp", "mod+PageDown", "mod+h", "mod+m",
]);

/** O navegador fica com copiar, colar e recortar quando nenhum comando vale: texto selecionado no HUD continua copiável. */
const BROWSER_KEEPS = new Set(["mod+c", "mod+v", "mod+x"]);

const chordText = (c: Chord): string => `${c.mod ? "mod+" : ""}${c.alt ? "alt+" : ""}${c.shift ? "shift+" : ""}${c.key}`;

/** Acorde para a tela: `mod+k` → `Ctrl+K`, `Escape` → `Esc`, `shift+z` → `Shift+Z`. */
export function chordLabel(chord: string): string {
  const c = parseChord(chord);
  const key = c.key === "Escape" ? "Esc" : c.key.length === 1 ? c.key.toUpperCase() : c.key;
  return `${c.mod ? "Ctrl+" : ""}${c.alt ? "Alt+" : ""}${c.shift ? "Shift+" : ""}${key}`;
}

function chordMatches(c: Chord, e: KeyInput): boolean {
  const key = c.key.length > 1 ? (EVENT_KEY_OF_NAMED[c.key] ?? c.key) : c.key;
  const typed = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (typed !== key) return false;
  if (c.mod !== !!(e.ctrlKey || e.metaKey) || c.alt !== !!e.altKey) return false;
  return !shiftMatters(c.key) || c.shift === !!e.shiftKey;
}

interface Stored<Ctx> { def: CommandDef<Ctx>; chords: readonly Chord[] }

const asList = (shortcut: string | readonly string[] | undefined): readonly string[] =>
  shortcut === undefined ? [] : typeof shortcut === "string" ? [shortcut] : shortcut;

export interface CommandRegistry<Ctx> {
  /** Valida e guarda. Lança `RegistryError`: campo faltando, id duplicado, acorde inválido ou em conflito. */
  register(def: CommandDef<Ctx>): void;
  get(id: string): CommandDef<Ctx> | undefined;
  /** Na ordem do registro. */
  list(): readonly CommandDef<Ctx>[];
  /** Ctrl+K: comandos da superfície `palette` cuja condição vale. */
  palette(ctx: Ctx): CommandEntry[];
  /** Botão direito no fundo do canvas. */
  canvasMenu(ctx: Ctx): CommandEntry[];
  /** Botão direito no nó: os ids que o tipo declara em `menu`, na ordem dele, só os que valem agora. */
  nodeMenu(type: NodeTypeDef, ctx: Ctx): CommandEntry[];
  /** Ajuda `?`: todo comando com atalho, valha ou não agora. */
  help(ctx: Ctx): CommandEntry[];
  /** Comando que o teclado dispara, ou `null`. Condição falsa e campo de texto sem `inEditable` (fora `mod`) não disparam. */
  resolveKey(event: KeyInput, state: { editable: boolean; ctx: Ctx }): CommandDef<Ctx> | null;
  /**
   * O comando dono do acorde com Ctrl, Cmd ou Alt, valha ou não agora (sem olhar o `when`). A página segura o acorde com
   * ele: sem isto, Ctrl+D sem seleção vira favorito e Alt+3 sem o terminal 3 troca a aba do navegador. Copiar, colar e
   * recortar ficam fora.
   */
  claimedKey(event: KeyInput, state: { editable: boolean }): CommandDef<Ctx> | null;
  /** Todo id citado por `menu` do tipo existe e tem a superfície `node-menu`; senão lança `registry_unknown_reference`. */
  checkTypeMenu(type: NodeTypeDef): void;
}

export function createCommandRegistry<Ctx>(): CommandRegistry<Ctx> {
  const byId = new Map<string, Stored<Ctx>>();
  const owner = new Map<string, string>();

  const entry = (s: Stored<Ctx>, ctx: Ctx): CommandEntry => ({
    id: s.def.id,
    label: typeof s.def.label === "function" ? s.def.label(ctx) : s.def.label,
    hint: s.def.hint ?? "",
    group: s.def.group,
    shortcuts: s.chords.map(chordText),
  });
  const applies = (s: Stored<Ctx>, ctx: Ctx): boolean => s.def.when === undefined || s.def.when(ctx);
  const onSurface = (surface: CommandSurface, ctx: Ctx): CommandEntry[] =>
    [...byId.values()].filter((s) => s.def.surfaces.includes(surface) && applies(s, ctx)).map((s) => entry(s, ctx));

  const validate = (raw: CommandDef<Ctx>): Stored<Ctx> => {
    const def = raw as unknown as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) return fail(REGISTRY_ERRORS.invalidField, "a declaração do comando deve ser um objeto");
    for (const field of ["id", "label", "group", "surfaces", "run"]) {
      if (def[field] === undefined) return fail(REGISTRY_ERRORS.missingField, `comando sem o campo "${field}"`, field);
    }
    if (typeof raw.id !== "string" || !COMMAND_ID.test(raw.id)) return fail(REGISTRY_ERRORS.invalidField, '"id" deve seguir [\\w.:-]{1,200}', "id");
    const labelOk = typeof raw.label === "function" || (typeof raw.label === "string" && raw.label.trim() !== "" && raw.label.length <= LABEL_MAX);
    if (!labelOk) return fail(REGISTRY_ERRORS.invalidField, `"label" deve ser um texto de 1 a ${LABEL_MAX} caracteres ou uma função`, "label");
    if (typeof raw.group !== "string" || raw.group.trim() === "") return fail(REGISTRY_ERRORS.invalidField, '"group" deve ser um texto', "group");
    if (raw.hint !== undefined && typeof raw.hint !== "string") return fail(REGISTRY_ERRORS.invalidField, '"hint" deve ser um texto', "hint");
    if (typeof raw.run !== "function") return fail(REGISTRY_ERRORS.invalidField, '"run" deve ser uma função', "run");
    if (raw.when !== undefined && typeof raw.when !== "function") return fail(REGISTRY_ERRORS.invalidField, '"when" deve ser uma função', "when");
    if (raw.inEditable !== undefined && typeof raw.inEditable !== "boolean") return fail(REGISTRY_ERRORS.invalidField, '"inEditable" deve ser verdadeiro ou falso', "inEditable");
    if (!Array.isArray(raw.surfaces) || new Set(raw.surfaces).size !== raw.surfaces.length || !raw.surfaces.every((s) => (COMMAND_SURFACES as readonly string[]).includes(s))) {
      return fail(REGISTRY_ERRORS.invalidField, `"surfaces" deve ser uma lista sem repetição de: ${COMMAND_SURFACES.join(", ")}`, "surfaces");
    }
    const shortcuts = asList(raw.shortcut);
    if (raw.shortcut !== undefined && !shortcuts.every((s) => typeof s === "string")) return fail(REGISTRY_ERRORS.invalidShortcut, '"shortcut" deve ser texto ou lista de textos', "shortcut");
    if (raw.surfaces.length === 0 && shortcuts.length === 0) return fail(REGISTRY_ERRORS.invalidField, "comando sem superfície e sem atalho não se alcança de lugar nenhum", raw.id);
    if (byId.has(raw.id)) return fail(REGISTRY_ERRORS.duplicate, `o comando "${raw.id}" já está registrado`, raw.id);
    const chords = shortcuts.map(parseChord);
    const seen = new Set<string>();
    for (const chord of chords) {
      const text = chordText(chord);
      if (BROWSER_RESERVED_CHORDS.includes(text)) return fail(REGISTRY_ERRORS.invalidShortcut, `o atalho "${text}" de "${raw.id}" é do navegador e não chega à página`, text);
      const holder = owner.get(text);
      if (holder !== undefined) return fail(REGISTRY_ERRORS.shortcutConflict, `o atalho "${text}" de "${raw.id}" já é de "${holder}"`, text);
      if (seen.has(text)) return fail(REGISTRY_ERRORS.shortcutConflict, `"${raw.id}" repete o atalho "${text}"`, text);
      seen.add(text);
    }
    return { def: raw, chords };
  };

  const checkMenu = (type: NodeTypeDef): void => {
    for (const id of type.menu) {
      const def = byId.get(id)?.def;
      if (!def || !def.surfaces.includes("node-menu")) return fail(REGISTRY_ERRORS.unknownReference, `o menu de "${type.type}" cita "${id}", que não é um comando de menu de nó`, id);
    }
  };

  return {
    register(def) {
      const stored = validate(def);
      byId.set(stored.def.id, stored);
      for (const chord of stored.chords) owner.set(chordText(chord), stored.def.id);
    },
    get: (id) => byId.get(id)?.def,
    list: () => [...byId.values()].map((s) => s.def),
    palette: (ctx) => onSurface("palette", ctx),
    canvasMenu: (ctx) => onSurface("canvas-menu", ctx),
    nodeMenu(type, ctx) {
      checkMenu(type);
      return type.menu.map((id) => byId.get(id) as Stored<Ctx>).filter((stored) => applies(stored, ctx)).map((stored) => entry(stored, ctx));
    },
    help: (ctx) => [...byId.values()].filter((s) => s.chords.length > 0).map((s) => entry(s, ctx)),
    resolveKey(event, state) {
      for (const stored of byId.values()) {
        for (const chord of stored.chords) {
          if (!chordMatches(chord, event)) continue;
          if (state.editable && (chord.mod ? stored.def.inEditable === false : stored.def.inEditable !== true)) return null;
          return applies(stored, state.ctx) ? stored.def : null;
        }
      }
      return null;
    },
    claimedKey(event, state) {
      for (const stored of byId.values()) {
        for (const chord of stored.chords) {
          if (!chordMatches(chord, event)) continue;
          if (!(chord.mod || chord.alt) || BROWSER_KEEPS.has(chordText(chord))) return null;
          if (state.editable && (chord.mod ? stored.def.inEditable === false : stored.def.inEditable !== true)) return null;
          return stored.def;
        }
      }
      return null;
    },
    checkTypeMenu: checkMenu,
  };
}
