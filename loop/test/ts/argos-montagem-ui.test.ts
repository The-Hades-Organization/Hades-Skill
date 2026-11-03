/// <reference path="../../../kit/panel/ui/argos/logic.tsx" />
// Montagem na página do compositor, da ferramenta Nota e das Conexões: comandos que decidem pelo tipo do nó
// (commands-canvas.tsx), teclas que sobem do terminal focado (node-tty.tsx), barra com Nota e Conexão (canvas-toolbar.tsx)
// e os pontos de encaixe da página e do index.html. Sem DOM: os scripts clássicos rodam num escopo próprio.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CANVAS_UI_BUNDLE, createCanvasModuleBundler, createUiTranspiler } from "../../../src/panel/ui-transpile";
import "../../../kit/panel/ui/argos/logic.tsx";

const L = (globalThis as unknown as { ArgosLogic: ArgosLogicApi }).ArgosLogic;
const uiDir = join(import.meta.dir, "../../../kit/panel/ui");

type Dict = Record<string, any>;

let loaded: Promise<Dict> | null = null;
function load(): Promise<Dict> {
  loaded ??= (async () => {
    const mod: { exports: any } = { exports: {} };
    new Function("exports", "module", readFileSync(join(uiDir, "vendor/react.js"), "utf8"))(mod.exports, mod);
    const React = mod.exports;
    const bundle = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const holder: Dict = {};
    new Function("globalThis", bundle as string)(holder);
    const stub = (tag: string) => (p: object) => React.createElement(tag, p);
    const HadesCore = {
      useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => undefined],
      useEffect: () => undefined, useRef: (v: unknown) => ({ current: v }), useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(),
      cn: (...a: unknown[]) => a.filter(Boolean).join(" "),
      I: new Proxy({}, { get: () => stub("svg") }),
      post: () => Promise.reject(new Error("sem rede no teste")), getJSON: () => Promise.reject(new Error("sem rede no teste")),
      Button: stub("button"), Input: stub("input"), Dialog: stub("div"), DialogHeader: stub("div"), DialogFooter: stub("div"), Segmented: stub("div"),
      Checkbox: stub("button"), Dot: stub("span"), Mono: stub("span"), Tip: stub("span"), Empty: stub("div"), useApp: () => ({}),
    };
    const scope: Dict = { CanvasModel: holder.CanvasModel };
    const transpiler = createUiTranspiler();
    for (const rel of ["argos/node-terminal.tsx", "argos/node-tty.tsx", "argos/commands-canvas.tsx", "argos/types-user.tsx", "argos/types-live.tsx",
      "argos/canvas-toolbar.tsx"]) {
      new Function("globalThis", "window", "React", "HadesCore", transpiler.transpile(join(uiDir, rel)))(scope, scope, React, HadesCore);
    }
    return { ...scope, M: holder.CanvasModel };
  })();
  return loaded;
}

type Mount = { terminal?: string | null; note?: string | null; composer?: boolean; linkStarts?: boolean };

/** Registro montado com as portas que a página dá: terminal, nota, compositor e conexão (cada uma pode faltar). */
async function mount({ terminal = null, note = null, composer, linkStarts }: Mount) {
  const { M, ArgosCanvasCommands, ArgosTypesUser, ArgosTypesLive } = await load();
  const reg = M.argos.createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null });
  const ran: string[] = [];
  const notes: string[] = [];
  const api: Dict = {
    doc: { doc: () => M.doc.emptyCanvasDoc(), selection: () => [], select: () => undefined, commit: () => undefined, reveal: () => undefined, notify: (n: { text: string }) => void notes.push(n.text) },
    dialogs: { askText: async () => null, choose: async () => null, confirm: async () => false },
    terminals: {
      armTool: () => void ran.push("arm"), target: () => terminal, edit: async () => undefined, role: async () => undefined,
      connections: async (id: string) => void ran.push(`conn:${id}`), close: async (id: string) => void ran.push(`close-term:${id}`), roles: () => undefined,
    },
    notes: { target: () => note, close: async (id: string) => void ran.push(`close-note:${id}`) },
  };
  if (composer !== undefined) api.composer = { available: () => composer, toggle: () => void ran.push("composer") };
  if (linkStarts !== undefined) api.links = { start: () => { ran.push("link"); return linkStarts; } };
  const deps = { fetch: () => Promise.reject(new Error("sem rede no teste")), now: () => 0 };
  const report = L.mountCanvasRegistries(reg as never, { canvasCommands: ArgosCanvasCommands, typesUser: ArgosTypesUser, typesLive: ArgosTypesLive } as never,
    { api, userDeps: deps, liveDeps: deps }) as { refused: unknown[] };
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  return { commands: reg.commands, ran, notes, report, settle };
}

const labelOf = (cmd: { label: string | ((ctx: object) => string) }): string => (typeof cmd.label === "function" ? cmd.label({}) : cmd.label);
const keyOf = (key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean }, code: string) =>
  ({ key, code, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: false });

describe("fechar decide pelo tipo do nó (tty:close, mod+alt+w)", () => {
  test("dada só uma nota selecionada, quando fecha, então o fluxo da nota roda e o rótulo diz Fechar nota", async () => {
    const t = await mount({ note: "note-1" });
    const cmd = t.commands.get("tty:close");
    expect(labelOf(cmd)).toBe("Fechar nota");
    cmd.run({});
    await t.settle();
    expect(t.ran).toEqual(["close-note:note-1"]);
  });
  test("dado um terminal e uma nota, quando fecha, então o terminal vence", async () => {
    const t = await mount({ terminal: "term-1", note: "note-1" });
    const cmd = t.commands.get("tty:close");
    expect(labelOf(cmd)).toBe("Fechar terminal");
    cmd.run({});
    await t.settle();
    expect(t.ran).toEqual(["close-term:term-1"]);
  });
  test("sem terminal nem nota, quando fecha, então avisa e não chama a página", async () => {
    const t = await mount({});
    t.commands.get("tty:close").run({});
    await t.settle();
    expect(t.ran).toEqual([]);
    expect(t.notes).toEqual(["Selecione um terminal criado no canvas ou uma nota."]);
  });
});

describe("Conexões… da nota (term:connections)", () => {
  test("dada só uma nota selecionada, quando pede Conexões…, então a página abre o popover dela", async () => {
    const t = await mount({ note: "note-1" });
    t.commands.get("term:connections").run({});
    await t.settle();
    expect(t.ran).toEqual(["conn:note-1"]);
  });
});

describe("compositor (tty:composer, mod+alt+p)", () => {
  test("dada a porta do compositor, quando o comando roda, então alterna o compositor", async () => {
    const t = await mount({ composer: true });
    t.commands.get("tty:composer").run({});
    await t.settle();
    expect(t.ran).toEqual(["composer"]);
  });
  test("sem a porta do compositor, o comando não existe", async () => {
    const t = await mount({});
    expect(t.commands.get("tty:composer")).toBeUndefined();
  });
  test("Ctrl+Alt+P resolve para o compositor mesmo num campo, e o terminal focado o deixa passar", async () => {
    const t = await mount({ composer: true });
    const { ArgosNodeTerminal: NT, ArgosNodeTty: Tty } = await load();
    const cmd = t.commands.resolveKey(NT.ttyKeyInput(keyOf("p", { ctrl: true, alt: true }, "KeyP")), { editable: true, ctx: {} });
    expect(cmd?.id).toBe("tty:composer");
    expect(NT.ttyLetsCommand(true, "tty:composer")).toBe(true);
    expect(Tty.TTY_CANVAS_KEYS).toContain("Ctrl+Alt+P");
  });
  test("a ajuda de atalhos lista o compositor com mod+alt+p", async () => {
    const t = await mount({ composer: false });
    const row = t.commands.help({}).find((r: { id: string }) => r.id === "tty:composer");
    expect(row?.shortcuts).toEqual(["mod+alt+p"]);
  });
});

describe("conexão pelo teclado (tty:link, mod+l)", () => {
  test("dada uma origem que conecta, quando o comando roda, então arma a conexão sem aviso", async () => {
    const t = await mount({ linkStarts: true });
    t.commands.get("tty:link").run({});
    await t.settle();
    expect(t.ran).toEqual(["link"]);
    expect(t.notes).toEqual([]);
  });
  test("sem origem que conecte, quando o comando roda, então avisa o que selecionar", async () => {
    const t = await mount({ linkStarts: false });
    t.commands.get("tty:link").run({});
    await t.settle();
    expect(t.notes).toEqual(["Selecione um terminal ou uma nota para conectar."]);
  });
  test("Ctrl+L resolve para a conexão com o terminal focado e não vira texto para o agente", async () => {
    const t = await mount({ linkStarts: true });
    const { ArgosNodeTerminal: NT, ArgosNodeTty: Tty } = await load();
    const key = keyOf("l", { ctrl: true }, "KeyL");
    expect(t.commands.resolveKey(NT.ttyKeyInput(key), { editable: true, ctx: {} })?.id).toBe("tty:link");
    expect(NT.ttyLetsCommand(true, "tty:link")).toBe(true);
    expect(Tty.TTY_CANVAS_KEYS).toContain("Ctrl+L");
    expect(Tty.translateKey(key)).toBeNull();
  });
});

describe("barra do canvas (canvas-toolbar.tsx)", () => {
  /** Elementos da árvore que a barra devolve, em ordem (sem renderizar: os componentes ficam como elementos). */
  function buttons(tree: Dict): Dict[] {
    const out: Dict[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== "object") return;
      const el = node as Dict;
      if (el.props?.label) out.push(el.props);
      walk(el.props?.children);
    };
    walk(tree);
    return out;
  }
  test("Nota vem registrada depois de Terminal", async () => {
    const { ArgosCanvasToolbar: TB } = await load();
    const ids = TB.listTools().map((t: Dict) => t.id);
    expect(ids.indexOf("note")).toBeGreaterThan(ids.indexOf("terminal"));
  });
  test("dado link, então o botão Conexão aparece depois das ferramentas e acende com active", async () => {
    const { ArgosCanvasToolbar: TB } = await load();
    const onClick = () => undefined;
    const labels = (active: boolean) => buttons(TB.CanvasToolbar({ armed: null, onArm: () => undefined, link: { active, onClick } }));
    const on = labels(true);
    const names = on.map((b) => b.label);
    expect(names.indexOf("Conexão")).toBeGreaterThan(names.indexOf("Nota"));
    expect(on.find((b) => b.label === "Conexão")).toMatchObject({ pressed: true, onClick });
    expect(labels(false).find((b) => b.label === "Conexão")?.pressed).toBe(false);
  });
  test("sem link, a barra não mostra Conexão", async () => {
    const { ArgosCanvasToolbar: TB } = await load();
    expect(buttons(TB.CanvasToolbar({ armed: null, onArm: () => undefined })).some((b) => b.label === "Conexão")).toBe(false);
  });
});

describe("encaixe na página (pages/argos.tsx, index.html)", () => {
  const page = readFileSync(join(uiDir, "pages/argos.tsx"), "utf8");
  test("o script do compositor carrega depois do balão", () => {
    const html = readFileSync(join(uiDir, "index.html"), "utf8");
    const balloon = html.indexOf('src="/ui/argos/node-balloon.js"');
    const composer = html.indexOf('src="/ui/argos/canvas-composer.js"');
    expect(balloon).toBeGreaterThan(-1);
    expect(composer).toBeGreaterThan(balloon);
  });
  test("a página monta o compositor, o popover de conexões, a ferramenta Nota e o soltar de arquivos", () => {
    for (const mark of ["CMP.CanvasComposerLayer", "LINKS.LinksPopover", "onLinkState={onLinkState}", "link={{ active: linking, onClick: toggleLink }}",
      "note: (rect, cam)", "onDrop={onStageDrop}", "M.note.noteDropPaths", "noteClient.link", "noteClient.remove"]) {
      expect(page).toContain(mark);
    }
  });
  test("o menu do nó da nota ganha Conexões, Conectar e Fechar; o do terminal ganha Conectar", () => {
    expect(page).toContain("[NT.TERMINAL_TYPE]: Object.freeze(['tty:link'])");
    expect(page).toContain("[M.note.NOTE_TYPE]: Object.freeze(['term:connections', 'tty:link', 'tty:close'])");
  });
});
