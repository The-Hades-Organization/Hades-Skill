// Registro de comandos e atalhos (src/lib/canvas-commands.ts): condição, atalho em conflito, e as quatro listas
// (paleta, menu do nó, menu do fundo, ajuda).
import { describe, expect, test } from "bun:test";
import { BROWSER_RESERVED_CHORDS, chordLabel, createCommandRegistry, type CommandDef } from "../../../src/lib/canvas-commands.ts";
import { REGISTRY_ERRORS, RegistryError, type NodeTypeDef } from "../../../src/lib/canvas-types.ts";

interface Ctx { selected: string | null; ran: string[] }
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ selected: null, ran: [], ...over });
const cmd = (over: Partial<CommandDef<Ctx>> = {}): CommandDef<Ctx> => ({
  id: "c1", label: "Comando", group: "Grupo", surfaces: ["palette"], run: () => undefined, ...over,
});
const codeOf = (run: () => unknown): { code: string; subject: string | undefined } => {
  try {
    run();
  } catch (error) {
    if (error instanceof RegistryError) return { code: error.code, subject: error.subject };
    throw error;
  }
  throw new Error("não lançou");
};
const typeWithMenu = (menu: string[]): NodeTypeDef => ({ type: "note", label: "Nota", icon: "FileText", defaultSize: { w: 1, h: 1 }, draw: { surface: "html", render: () => null }, menu, actions: [], live: false });
const ids = (entries: { id: string }[]): string[] => entries.map((entry) => entry.id);

describe("registro de comandos: validação", () => {
  test("dado comando válido, quando registra, então get e list o devolvem", () => {
    const registry = createCommandRegistry<Ctx>();
    registry.register(cmd());
    expect(registry.get("c1")?.label).toBe("Comando");
    expect(registry.list()).toHaveLength(1);
  });

  test("dado o mesmo id duas vezes, então registry_duplicate", () => {
    const registry = createCommandRegistry<Ctx>();
    registry.register(cmd());
    expect(codeOf(() => registry.register(cmd({ label: "Outro" })))).toEqual({ code: REGISTRY_ERRORS.duplicate, subject: "c1" });
  });

  test.each(["id", "label", "group", "surfaces", "run"])("dado o campo %s faltando, então registry_missing_field", (field) => {
    const raw: Record<string, unknown> = { ...cmd() };
    delete raw[field];
    expect(codeOf(() => createCommandRegistry<Ctx>().register(raw as unknown as CommandDef<Ctx>))).toEqual({ code: REGISTRY_ERRORS.missingField, subject: field });
  });

  test.each([
    ["id com espaço", { id: "a b" }],
    ["label vazio", { label: "" }],
    ["run que não é função", { run: 1 }],
    ["when que não é função", { when: true }],
    ["superfície desconhecida", { surfaces: ["toolbar"] }],
    ["superfície repetida", { surfaces: ["palette", "palette"] }],
    ["sem superfície e sem atalho (inalcançável)", { surfaces: [] }],
  ])("dado %s, então registry_invalid_field", (_name, over) => {
    expect(codeOf(() => createCommandRegistry<Ctx>().register(cmd(over as Partial<CommandDef<Ctx>>))).code).toBe(REGISTRY_ERRORS.invalidField);
  });

  test.each(["", "mod+", "ctrl+k", "K", "shift+?", "mod+mod+k", "ab", "mod+shift+shift+k", "Esc"])("dado o acorde inválido %p, então registry_invalid_shortcut", (shortcut) => {
    expect(codeOf(() => createCommandRegistry<Ctx>().register(cmd({ shortcut }))).code).toBe(REGISTRY_ERRORS.invalidShortcut);
  });

  test("dado atalho que outro comando já tem, então registry_shortcut_conflict e o segundo não é registrado", () => {
    const registry = createCommandRegistry<Ctx>();
    registry.register(cmd({ id: "a", shortcut: "mod+k" }));
    expect(codeOf(() => registry.register(cmd({ id: "b", shortcut: ["j", "mod+k"] })))).toEqual({ code: REGISTRY_ERRORS.shortcutConflict, subject: "mod+k" });
    expect(registry.get("b")).toBeUndefined();
    registry.register(cmd({ id: "c", shortcut: "j" }));
  });

  test("dado o mesmo acorde escrito de dois jeitos no mesmo comando, então conflito", () => {
    expect(codeOf(() => createCommandRegistry<Ctx>().register(cmd({ shortcut: ["mod+shift+z", "mod+shift+z"] }))).code).toBe(REGISTRY_ERRORS.shortcutConflict);
  });

  test("dado k e mod+k, então não há conflito: são acordes diferentes", () => {
    const registry = createCommandRegistry<Ctx>();
    registry.register(cmd({ id: "a", shortcut: "k" }));
    registry.register(cmd({ id: "b", shortcut: "mod+k" }));
    registry.register(cmd({ id: "c", shortcut: "shift+k" }));
  });
});

describe("registro de comandos: as listas", () => {
  const build = () => {
    const registry = createCommandRegistry<Ctx>();
    registry.register(cmd({ id: "fit", label: "Enquadrar", shortcut: "f", surfaces: ["palette", "canvas-menu"] }));
    registry.register(cmd({ id: "del", label: (c) => `Apagar ${c.selected ?? ""}`.trim(), shortcut: ["Delete", "Backspace"], surfaces: ["palette", "node-menu"], when: (c) => c.selected !== null }));
    registry.register(cmd({ id: "only-menu", label: "Só no menu do nó", surfaces: ["node-menu"] }));
    registry.register(cmd({ id: "quiet", label: "Só atalho", shortcut: "q", surfaces: [] }));
    return registry;
  };

  test("dado um comando em palette e canvas-menu, então aparece nas duas e na ajuda (tem atalho)", () => {
    const registry = build();
    expect(ids(registry.palette(ctx()))).toEqual(["fit"]);
    expect(ids(registry.canvasMenu(ctx()))).toEqual(["fit"]);
    expect(ids(registry.help(ctx()))).toEqual(["fit", "del", "quiet"]);
  });

  test("dado um comando em palette e node-menu com condição, então só aparece quando ela vale e o rótulo usa o contexto", () => {
    const registry = build();
    const note = typeWithMenu(["del", "only-menu"]);
    expect(ids(registry.palette(ctx()))).toEqual(["fit"]);
    expect(ids(registry.nodeMenu(note, ctx()))).toEqual(["only-menu"]);
    const picked = ctx({ selected: "n1" });
    expect(registry.palette(picked).map((entry) => entry.label)).toEqual(["Enquadrar", "Apagar n1"]);
    expect(ids(registry.nodeMenu(note, picked))).toEqual(["del", "only-menu"]);
  });

  test("dado o menu do tipo, então a ordem é a do tipo e não a do registro", () => {
    expect(ids(build().nodeMenu(typeWithMenu(["only-menu", "del"]), ctx({ selected: "n1" })))).toEqual(["only-menu", "del"]);
  });

  test("dado menu de tipo que cita comando inexistente ou fora de node-menu, então registry_unknown_reference", () => {
    const registry = build();
    expect(codeOf(() => registry.nodeMenu(typeWithMenu(["nada"]), ctx()))).toEqual({ code: REGISTRY_ERRORS.unknownReference, subject: "nada" });
    expect(codeOf(() => registry.checkTypeMenu(typeWithMenu(["fit"])))).toEqual({ code: REGISTRY_ERRORS.unknownReference, subject: "fit" });
    registry.checkTypeMenu(typeWithMenu(["del"]));
  });

  test("dado a ajuda, então traz o atalho normalizado de cada comando, inclusive os que não valem agora", () => {
    const entries = build().help(ctx());
    expect(entries.find((entry) => entry.id === "del")?.shortcuts).toEqual(["Delete", "Backspace"]);
    expect(entries.find((entry) => entry.id === "fit")?.shortcuts).toEqual(["f"]);
  });

  test("dado chordLabel, então escreve para a tela", () => {
    expect(chordLabel("mod+k")).toBe("Ctrl+K");
    expect(chordLabel("Escape")).toBe("Esc");
    expect(chordLabel("mod+shift+z")).toBe("Ctrl+Shift+Z");
    expect(chordLabel("?")).toBe("?");
  });
});

describe("registro de comandos: atalho do teclado", () => {
  const registry = createCommandRegistry<Ctx>();
  registry.register(cmd({ id: "palette", shortcut: ["mod+k", "/"], surfaces: [], inEditable: true }));
  registry.register(cmd({ id: "prev", shortcut: "k", surfaces: [] }));
  registry.register(cmd({ id: "close", shortcut: "Escape", surfaces: [], inEditable: true }));
  registry.register(cmd({ id: "help", shortcut: "?", surfaces: [] }));
  registry.register(cmd({ id: "redo", shortcut: "mod+shift+z", surfaces: [] }));
  registry.register(cmd({ id: "undo", shortcut: "mod+z", surfaces: [], inEditable: false }));
  registry.register(cmd({ id: "approve", shortcut: "a", surfaces: [], when: (c) => c.selected !== null }));
  const key = (event: Parameters<typeof registry.resolveKey>[0], state: { editable?: boolean; ctx?: Ctx } = {}) =>
    registry.resolveKey(event, { editable: state.editable ?? false, ctx: state.ctx ?? ctx() })?.id ?? null;

  test("dado Ctrl+K ou Cmd+K, então palette; k puro é prev", () => {
    expect(key({ key: "k", ctrlKey: true })).toBe("palette");
    expect(key({ key: "K", metaKey: true })).toBe("palette");
    expect(key({ key: "k" })).toBe("prev");
  });

  test("dado ? (que o navegador entrega com shift), então help; Alt+k não é k", () => {
    expect(key({ key: "?", shiftKey: true })).toBe("help");
    expect(key({ key: "k", altKey: true })).toBeNull();
  });

  test("dado Ctrl+Shift+Z, então redo; Ctrl+Z sem shift é undo, não redo", () => {
    expect(key({ key: "Z", ctrlKey: true, shiftKey: true })).toBe("redo");
    expect(key({ key: "z", ctrlKey: true })).toBe("undo");
  });

  test("dado foco em campo de texto, então só mod e os comandos inEditable valem", () => {
    expect(key({ key: "k" }, { editable: true })).toBeNull();
    expect(key({ key: "/" }, { editable: true })).toBe("palette");
    expect(key({ key: "k", ctrlKey: true }, { editable: true })).toBe("palette");
    expect(key({ key: "Escape" }, { editable: true })).toBe("close");
    expect(key({ key: "?", shiftKey: true }, { editable: true })).toBeNull();
  });

  test("dado comando com mod e inEditable false, então em campo de texto o atalho é do campo; fora dele, dispara", () => {
    expect(key({ key: "z", ctrlKey: true }, { editable: true })).toBeNull();
    expect(key({ key: "z", ctrlKey: true })).toBe("undo");
  });

  test("dado comando com condição falsa, então o atalho não dispara; verdadeira, dispara", () => {
    expect(key({ key: "a" })).toBeNull();
    expect(key({ key: "a" }, { ctx: ctx({ selected: "n1" }) })).toBe("approve");
  });

  test("dado tecla sem comando, então null", () => {
    expect(key({ key: "g" })).toBeNull();
  });
});

describe("atalhos e o navegador", () => {
  test.each(["mod+shift+p", "mod+t", "mod+w", "mod+shift+n", "mod+q", "mod+Tab"])("dado %s, que o navegador toma antes da página, então o registro recusa", (shortcut) => {
    expect(codeOf(() => createCommandRegistry<Ctx>().register(cmd({ shortcut })))).toEqual({ code: REGISTRY_ERRORS.invalidShortcut, subject: shortcut });
  });
  test("dada a lista de reservados, então todo item é um acorde válido fora dela", () => {
    for (const chord of BROWSER_RESERVED_CHORDS) expect(chord.startsWith("mod+")).toBe(true);
    expect(() => createCommandRegistry<Ctx>().register(cmd({ shortcut: "mod+alt+p" }))).not.toThrow();
  });

  const registry = createCommandRegistry<Ctx>();
  registry.register(cmd({ id: "dup", shortcut: "mod+d", when: (c) => c.selected !== null }));
  registry.register(cmd({ id: "jump", shortcut: "alt+3", when: () => false }));
  registry.register(cmd({ id: "copy", shortcut: "mod+c", when: () => false }));
  registry.register(cmd({ id: "next", shortcut: "j", when: () => false }));
  registry.register(cmd({ id: "field", shortcut: "mod+g", inEditable: false, when: () => false }));
  const claimed = (key: string, mods: { ctrlKey?: boolean; altKey?: boolean } = {}, editable = false): string | undefined =>
    registry.claimedKey({ key, ...mods }, { editable })?.id;

  test("dado acorde com Ctrl ou Alt cujo comando não vale agora, então a página o segura (não vira favorito nem troca de aba)", () => {
    expect(registry.resolveKey({ key: "d", ctrlKey: true }, { editable: false, ctx: ctx() })).toBeNull();
    expect(claimed("d", { ctrlKey: true })).toBe("dup");
    expect(claimed("3", { altKey: true })).toBe("jump");
  });
  test("dado copiar, tecla sem modificador ou tecla sem dono, então fica com o navegador", () => {
    expect(claimed("c", { ctrlKey: true })).toBeUndefined();
    expect(claimed("j")).toBeUndefined();
    expect(claimed("y", { ctrlKey: true })).toBeUndefined();
  });
  test("dado foco num campo, então só segura o acorde que vale em campo", () => {
    expect(claimed("g", { ctrlKey: true }, true)).toBeUndefined();
    expect(claimed("d", { ctrlKey: true }, true)).toBe("dup");
  });
});
