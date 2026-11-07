// Grupo canvas-commands-canvas: comandos de organização do canvas (kit/panel/ui/argos/commands-canvas.tsx) sobre um `api` falso
// e os modelos puros reais (src/lib). O .tsx é um script clássico de navegador: ele publica em globalThis e lê
// globalThis.CanvasModel, então o teste monta o mesmo CanvasModel que a página terá. Cada comando que muda o documento passa
// pela pilha de desfazer real (`perform`/`undo`) e o teste confere que desfazer devolve o documento idêntico.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as align from "../../../src/lib/canvas-align";
import * as areas from "../../../src/lib/canvas-areas";
import * as batch from "../../../src/lib/canvas-batch";
import * as blur from "../../../src/lib/canvas-blur";
import * as clipboard from "../../../src/lib/canvas-clipboard";
import { createCommandRegistry, type CommandDef, type CommandRegistry } from "../../../src/lib/canvas-commands";
import * as dock from "../../../src/lib/canvas-dock";
import type { CanvasDoc, CanvasEdge, CanvasGroup, CanvasNode } from "../../../src/lib/canvas-doc";
import * as exportModel from "../../../src/lib/canvas-export";
import * as groups from "../../../src/lib/canvas-groups";
import * as history from "../../../src/lib/canvas-history";
import * as next from "../../../src/lib/canvas-next";
import * as store from "../../../src/lib/canvas-store";
import * as walk from "../../../src/lib/canvas-walk";

// Os tipos do .tsx não entram aqui (o tsconfig do projeto não tem jsx): este é o contorno do que o teste usa dele.
interface Note { level: "info" | "warn" | "error"; code?: string; text: string }
interface Info { id: string; name: string }
interface Row { feature: string; def: CommandDef<object> }
interface Report { registered: string[]; refused: { id: string; code: string; subject?: string }[] }
interface Api {
  doc: {
    doc(): CanvasDoc;
    selection(): readonly string[];
    select(ids: readonly string[]): void;
    commit(op: history.CanvasOp): void;
    reveal(id: string): void;
    notify(note: Note): void;
  };
  dialogs: {
    askText(request: { title: string; initial?: string }): Promise<string | null>;
    choose(request: { title: string; options: readonly { value: string; label: string }[] }): Promise<string | null>;
    confirm(request: { title: string; text: string }): Promise<boolean>;
  };
  snap?: { enabled(): boolean; setEnabled(on: boolean): void };
  dock?: { state(): dock.DockState; set(next: dock.DockState): void };
  owner?: { nodes(): readonly next.NextNode[] };
  batch?: {
    nodes(ids: readonly string[]): import("../../../src/lib/canvas-actions").ActionNode[];
    context(): import("../../../src/lib/canvas-actions").ActionContext;
    filteredIds(): readonly string[];
    confirm(plan: batch.BatchPlan): Promise<{ confirmed: boolean; typed?: string }>;
    send(requests: readonly import("../../../src/lib/canvas-actions").ActionRequest[]): Promise<batch.BatchResponse[]>;
    show(result: batch.BatchResult): void;
  };
  workspace?: {
    current(): Info;
    list(): readonly Info[];
    create(request: { id: string; name: string; doc?: CanvasDoc }): Promise<void>;
    switchTo(id: string): Promise<void>;
    rename(id: string, name: string): Promise<void>;
    remove(id: string): Promise<void>;
    saveFile(file: { filename: string; text: string }): void;
    pickFile(): Promise<string | null>;
    now?(): Date;
  };
}
interface Commands {
  registerCanvasCommands(registry: CommandRegistry<object>, api: Api): Report;
  canvasCommandRows(api: Api): Row[];
}

const g = globalThis as unknown as Record<string, unknown>;
let Cmd: Commands;

beforeAll(async () => {
  g.CanvasModel = { history, groups, align, clipboard, walk, next, batch, blur, dock, store, export: exportModel, areas };
  // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
  await import("../../../kit/panel/ui/argos/commands-canvas.tsx");
  Cmd = g.ArgosCanvasCommands as Commands;
});
afterAll(() => {
  delete g.CanvasModel;
  delete g.ArgosCanvasCommands;
});

// ---- montagem ----

const note = (id: string, x: number, y: number, over: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: "note", x, y, w: 100, h: 60, z: 0, data: { title: id }, locked: false, blurred: false, ...over });
const live = (id: string, x: number, y: number): CanvasNode => ({ id, type: "agent", x, y, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false });
const edge = (id: string, from: string, to: string): CanvasEdge => ({ id, from, to, kind: "link" });
const group = (id: string, members: string[]): CanvasGroup => ({ id, label: id, members });
const makeDoc = (nodes: CanvasNode[], edges: CanvasEdge[] = [], gs: CanvasGroup[] = []): CanvasDoc => ({ v: 1, rev: 0, nodes, edges, groups: gs });
const clone = <T,>(value: T): T => structuredClone(value);

interface Answers { text: (string | null)[]; choose: (string | null)[]; confirm: boolean[] }
interface Setup {
  snap?: boolean;
  dock?: boolean;
  owner?: next.NextNode[];
  batch?: { filtered?: string[]; confirmed?: boolean; typed?: string; responses?: (ids: string[]) => batch.BatchResponse[] };
  workspace?: { canvases?: Info[]; current?: string; picked?: string | null };
}

function harness(start: CanvasDoc, setup: Setup = {}) {
  const s = {
    doc: start,
    history: history.createHistory(),
    selection: [] as string[],
    notes: [] as Note[],
    revealed: [] as string[],
    commits: 0,
    answers: { text: [], choose: [], confirm: [] } as Answers,
    snapOn: setup.snap ?? false,
    dock: dock.emptyDock(),
    sent: [] as unknown[],
    shown: [] as batch.BatchResult[],
    confirmedPlans: [] as batch.BatchPlan[],
    canvases: setup.workspace?.canvases ?? [{ id: store.DEFAULT_CANVAS_ID, name: store.DEFAULT_CANVAS_NAME }],
    currentId: setup.workspace?.current ?? store.DEFAULT_CANVAS_ID,
    created: [] as { id: string; name: string; doc?: CanvasDoc }[],
    switched: [] as string[],
    renamed: [] as [string, string][],
    removed: [] as string[],
    files: [] as { filename: string; text: string }[],
  };
  const api: Api = {
    doc: {
      doc: () => s.doc,
      selection: () => s.selection,
      select: (ids) => void (s.selection = [...ids]),
      commit: (op) => {
        const applied = history.perform(s.history, s.doc, op);
        s.doc = applied.doc;
        s.history = applied.history;
        s.commits += 1;
      },
      reveal: (id) => void s.revealed.push(id),
      notify: (n) => void s.notes.push(n),
    },
    dialogs: {
      askText: async () => s.answers.text.shift() ?? null,
      choose: async () => s.answers.choose.shift() ?? null,
      confirm: async () => s.answers.confirm.shift() ?? false,
    },
  };
  if (setup.snap !== undefined) api.snap = { enabled: () => s.snapOn, setEnabled: (on) => void (s.snapOn = on) };
  if (setup.dock) api.dock = { state: () => s.dock, set: (nextState) => void (s.dock = nextState) };
  if (setup.owner) api.owner = { nodes: () => setup.owner as next.NextNode[] };
  if (setup.batch) {
    const cfg = setup.batch;
    api.batch = {
      nodes: (ids) => ids.map((id) => ({ id, type: "agent", label: id.split(":").pop() as string, state: "working", herdrState: "blocked", pendingPermission: { ts: "2026-01-01T00:00:00Z", tool: "Bash" } })),
      context: () => ({}),
      filteredIds: () => cfg.filtered ?? [],
      confirm: async (plan) => {
        s.confirmedPlans.push(plan);
        return { confirmed: cfg.confirmed ?? true, ...(cfg.typed === undefined ? {} : { typed: cfg.typed }) };
      },
      send: async (requests) => {
        s.sent.push(...requests);
        const ids = requests.map((r) => r.node);
        return cfg.responses ? cfg.responses(ids) : ids.map((id) => ({ id, status: 200, body: { ok: true } }));
      },
      show: (result) => void s.shown.push(result),
    };
  }
  if (setup.workspace) {
    const cfg = setup.workspace;
    api.workspace = {
      current: () => s.canvases.find((c) => c.id === s.currentId) as Info,
      list: () => s.canvases,
      create: async (request) => void (s.created.push(request), s.canvases = [...s.canvases, { id: request.id, name: request.name }]),
      switchTo: async (id) => void (s.switched.push(id), s.currentId = id),
      rename: async (id, name) => void s.renamed.push([id, name]),
      remove: async (id) => void s.removed.push(id),
      saveFile: (file) => void s.files.push(file),
      pickFile: async () => cfg.picked ?? null,
      now: () => new Date("2026-03-04T05:06:07.000Z"),
    };
  }
  const registry = createCommandRegistry<object>();
  const report = Cmd.registerCanvasCommands(registry, api);
  const def = (id: string): CommandDef<object> => registry.get(id) ?? expect.unreachable(`comando ${id} não registrado`);
  const applies = (id: string): boolean => def(id).when?.({}) ?? true;
  /** Executa pelo caminho do teclado/paleta: só roda se a condição vale. Espera as promessas do comando. */
  const run = async (id: string): Promise<void> => {
    if (!applies(id)) return expect.unreachable(`${id} não vale agora`);
    def(id).run({});
    await new Promise((resolve) => setImmediate(resolve));
  };
  const undoAll = (): void => {
    for (let step = history.undo(s.history, s.doc); step; step = history.undo(s.history, s.doc)) {
      s.doc = step.doc;
      s.history = step.history;
    }
  };
  const label = (id: string): string => {
    const l = def(id).label;
    return typeof l === "function" ? l({}) : l;
  };
  return { s, api, registry, report, def, applies, run, undoAll, label };
}

const ids = (d: CanvasDoc): string[] => d.nodes.map((n) => n.id);
const at = (d: CanvasDoc, id: string): CanvasNode => d.nodes.find((n) => n.id === id) as CanvasNode;

// ---- registro ----

describe("canvas-commands-canvas: registro", () => {
  test("com a api mínima registra os comandos do documento, e cada um tem id, título, atalho e item do catálogo", () => {
    const h = harness(makeDoc([]));
    const rows = Cmd.canvasCommandRows(h.api);
    expect(new Set(rows.map((r) => r.def.id)).size).toBe(rows.length);
    expect(h.report.refused).toEqual([]);
    expect(h.report.registered.length).toBe(rows.length);
    for (const { feature, def } of rows) {
      expect(feature).toMatch(/^[A-Z]\d$/);
      expect(typeof def.label === "function" || def.label.trim() !== "").toBe(true);
      expect(def.shortcut !== undefined || def.surfaces.length > 0).toBe(true);
    }
    expect(new Set(rows.map((r) => r.feature))).toEqual(new Set(["O1", "O2", "N4", "O5", "O6", "O8"]));
  });

  test("com todas as portas cobre os doze itens do catálogo e nenhum atalho repete", () => {
    const h = harness(makeDoc([]), { snap: false, dock: true, owner: [], batch: {}, workspace: {} });
    const rows = Cmd.canvasCommandRows(h.api);
    expect(new Set(rows.map((r) => r.feature))).toEqual(new Set(["O1", "O2", "O3", "O5", "N4", "N5", "A4", "O6", "O7", "O8", "W1", "W3"]));
    const chords = h.registry.help({}).flatMap((e) => e.shortcuts);
    expect(new Set(chords).size).toBe(chords.length);
    expect(h.report.refused).toEqual([]);
  });

  test("não usa nenhum atalho que a página já registra (câmera, vista, ação, leitura)", () => {
    const taken = ["mod+k", "/", "j", "k", "Enter", "Escape", "f", "l", "?", "mod+z", "mod+shift+z", "a", "x", "p", "r", "shift+l", "shift+p", "b", "mod+=", "mod++", "mod+-", "mod+0", "z", "c"];
    const h = harness(makeDoc([]), { snap: false, dock: true, owner: [], batch: {}, workspace: {} });
    const mine = h.registry.help({}).flatMap((e) => e.shortcuts);
    expect(mine.filter((chord) => taken.includes(chord))).toEqual([]);
  });

  test("atalho já tomado recusa só aquele comando, e o resto segue", () => {
    const registry = createCommandRegistry<object>();
    registry.register({ id: "page:other", label: "Outro", group: "Página", shortcut: "mod+g", surfaces: ["palette"], run: () => undefined });
    const h = harness(makeDoc([]));
    const report = Cmd.registerCanvasCommands(registry, h.api);
    expect(report.refused.map((r) => r.id)).toEqual(["group:create"]);
    expect(report.refused[0]?.code).toBe("registry_shortcut_conflict");
    expect(registry.get("group:create")).toBeUndefined();
    expect(registry.get("group:ungroup")).toBeDefined();
    expect(report.registered).toContain("align:left");
  });

  test("registrar de novo (modo estrito do React) não repete nem lança", () => {
    const h = harness(makeDoc([]));
    const again = Cmd.registerCanvasCommands(h.registry, h.api);
    expect(again).toEqual({ registered: [], refused: [] });
  });

  test("sem as portas opcionais, os comandos delas não existem", () => {
    const h = harness(makeDoc([]));
    for (const id of ["snap:toggle", "owner:next", "batch:resume", "dock:left", "canvas:new", "canvas:export"]) expect(h.registry.get(id)).toBeUndefined();
  });

  test("sem o CanvasModel completo o registro falha alto, dizendo o que falta", () => {
    const saved = g.CanvasModel;
    g.CanvasModel = { history };
    try {
      expect(() => Cmd.canvasCommandRows(harness(makeDoc([])).api)).toThrow(/groups/);
    } finally {
      g.CanvasModel = saved;
    }
  });
});

// ---- O1 grupos ----

describe("canvas-commands-canvas: grupos (O1)", () => {
  const base = (): CanvasDoc => makeDoc([note("a", 0, 0), note("b", 200, 0), note("c", 400, 0), live("agent:r:z", 600, 0)], [edge("e1", "a", "b")]);

  test("Ctrl+G agrupa a seleção em um passo e desfazer devolve o documento idêntico", async () => {
    const h = harness(base());
    const before = clone(h.s.doc);
    h.s.selection = ["a", "b", "c"];
    await h.run("group:create");
    expect(h.s.doc.groups).toHaveLength(1);
    expect(h.s.doc.groups[0]?.members).toEqual(["a", "b", "c"]);
    expect(h.s.history.past).toHaveLength(1);
    h.undoAll();
    expect(h.s.doc).toEqual(before);
  });

  test("agrupar vale com dois ou mais nós: com um só, ou sem seleção, o comando não vale", () => {
    const h = harness(base());
    expect(h.applies("group:create")).toBe(false);
    h.s.selection = ["a"];
    expect(h.applies("group:create")).toBe(false);
    h.s.selection = ["a", "b"];
    expect(h.applies("group:create")).toBe(true);
  });

  test("seleção com id que o documento não tem ignora o fantasma e conta só os nós reais", () => {
    const h = harness(base());
    h.s.selection = ["a", "ghost"];
    expect(h.applies("group:create")).toBe(false);
  });

  test("nó que já era de outro grupo sai dele; o grupo que sobra com um membro se desfaz", async () => {
    const h = harness({ ...base(), groups: [group("g0", ["a", "b"])] });
    const before = clone(h.s.doc);
    h.s.selection = ["b", "c"];
    await h.run("group:create");
    expect(h.s.doc.groups.map((x) => x.members)).toEqual([["b", "c"]]);
    h.undoAll();
    expect(h.s.doc).toEqual(before);
  });

  test("Ctrl+Shift+G desfaz os grupos tocados pela seleção em um passo só", async () => {
    const h = harness({ ...base(), groups: [group("g1", ["a", "b"]), group("g2", ["c", "agent:r:z"])] });
    const before = clone(h.s.doc);
    h.s.selection = ["a", "c"];
    await h.run("group:ungroup");
    expect(h.s.doc.groups).toEqual([]);
    expect(h.s.history.past).toHaveLength(1);
    h.undoAll();
    expect(h.s.doc).toEqual(before);
  });

  test("desfazer o grupo só vale se a seleção toca um grupo", () => {
    const h = harness({ ...base(), groups: [group("g1", ["a", "b"])] });
    h.s.selection = ["c"];
    expect(h.applies("group:ungroup")).toBe(false);
    h.s.selection = ["a"];
    expect(h.applies("group:ungroup")).toBe(true);
  });

  test("renomear usa o nome que o dono digitou; cancelar não grava nada", async () => {
    const h = harness({ ...base(), groups: [group("g1", ["a", "b"])] });
    h.s.selection = ["a"];
    h.s.answers.text = ["Frente"];
    await h.run("group:rename");
    expect(h.s.doc.groups[0]?.label).toBe("Frente");
    h.s.answers.text = [null];
    await h.run("group:rename");
    expect(h.s.commits).toBe(1);
  });

  test("nome vazio é recusado pelo modelo: o aviso leva o código estável e nada é gravado", async () => {
    const h = harness({ ...base(), groups: [group("g1", ["a", "b"])] });
    h.s.selection = ["a"];
    h.s.answers.text = ["   "];
    await h.run("group:rename");
    expect(h.s.commits).toBe(0);
    expect(h.s.notes).toHaveLength(1);
    expect(h.s.notes[0]).toMatchObject({ level: "error", code: groups.ORG_ERRORS.invalidLabel });
  });

  test("defeito que não é erro de modelo continua subindo, sem virar aviso", () => {
    const h = harness(base());
    h.s.selection = ["a", "b"];
    h.api.doc.commit = () => {
      throw new TypeError("defeito");
    };
    expect(() => h.def("group:create").run({})).toThrow(TypeError);
    expect(h.s.notes).toEqual([]);
  });
});

// ---- O2 / O3 alinhar, distribuir, grade, encaixe ----

describe("canvas-commands-canvas: alinhar, distribuir e grade (O2) e encaixe (O3)", () => {
  const row = (): CanvasDoc => makeDoc([note("a", 10, 0), note("b", 200, 50), note("c", 500, 20), note("d", 330, 90)]);

  test("alinhar à esquerda leva todos ao menor x, em um passo, e desfazer volta ao anterior", async () => {
    const h = harness(row());
    const before = clone(h.s.doc);
    h.s.selection = ["a", "b", "c"];
    await h.run("align:left");
    expect(["a", "b", "c"].map((id) => at(h.s.doc, id).x)).toEqual([10, 10, 10]);
    expect(at(h.s.doc, "d").x).toBe(330);
    expect(h.s.history.past).toHaveLength(1);
    h.undoAll();
    expect(h.s.doc).toEqual(before);
  });

  test("os seis modos existem com o modo certo do modelo", async () => {
    const expected: Record<string, (d: CanvasDoc) => boolean> = {
      "align:left": (d) => new Set(d.nodes.map((n) => n.x)).size === 1,
      "align:right": (d) => new Set(d.nodes.map((n) => n.x + n.w)).size === 1,
      "align:center": (d) => new Set(d.nodes.map((n) => n.x + n.w / 2)).size === 1,
      "align:top": (d) => new Set(d.nodes.map((n) => n.y)).size === 1,
      "align:bottom": (d) => new Set(d.nodes.map((n) => n.y + n.h)).size === 1,
      "align:middle": (d) => new Set(d.nodes.map((n) => n.y + n.h / 2)).size === 1,
    };
    for (const [id, aligned] of Object.entries(expected)) {
      const h = harness(row());
      h.s.selection = ids(h.s.doc);
      await h.run(id);
      expect(aligned(h.s.doc)).toBe(true);
    }
  });

  test("alinhar exige dois nós; distribuir, três", () => {
    const h = harness(row());
    h.s.selection = ["a"];
    expect(h.applies("align:left")).toBe(false);
    h.s.selection = ["a", "b"];
    expect(h.applies("align:left")).toBe(true);
    expect(h.applies("distribute:horizontal")).toBe(false);
    h.s.selection = ["a", "b", "c"];
    expect(h.applies("distribute:horizontal")).toBe(true);
  });

  test("distribuir na horizontal deixa vãos iguais entre os três e desfazer volta", async () => {
    const h = harness(makeDoc([note("a", 0, 0), note("b", 50, 0), note("c", 600, 0)]));
    const before = clone(h.s.doc);
    h.s.selection = ["a", "b", "c"];
    await h.run("distribute:horizontal");
    const [a, b, c] = ["a", "b", "c"].map((id) => at(h.s.doc, id));
    expect((b as CanvasNode).x - ((a as CanvasNode).x + 100)).toBe((c as CanvasNode).x - ((b as CanvasNode).x + 100));
    h.undoAll();
    expect(h.s.doc).toEqual(before);
  });

  test("nó travado fica onde está ao alinhar", async () => {
    const h = harness(makeDoc([note("a", 0, 0), note("b", 300, 40, { locked: true })]));
    h.s.selection = ["a", "b"];
    await h.run("align:right");
    expect(at(h.s.doc, "b").x).toBe(300);
    expect(at(h.s.doc, "a").x).toBe(300);
  });

  test("já alinhado não grava passo nenhum", async () => {
    const h = harness(makeDoc([note("a", 0, 0), note("b", 0, 100)]));
    h.s.selection = ["a", "b"];
    await h.run("align:left");
    expect(h.s.commits).toBe(0);
  });

  test("organizar na grade encaixa os cantos nos múltiplos da grade", async () => {
    const h = harness(makeDoc([note("a", 13, 27), note("b", 41, 3)]));
    h.s.selection = ["a", "b"];
    await h.run("grid:snap");
    for (const n of h.s.doc.nodes) {
      expect(n.x % align.GRID_SIZE).toBe(0);
      expect(n.y % align.GRID_SIZE).toBe(0);
    }
    h.undoAll();
    expect(at(h.s.doc, "a")).toMatchObject({ x: 13, y: 27 });
  });

  test("o encaixe magnético liga e desliga pela porta, e o título diz o que fará", async () => {
    const h = harness(makeDoc([]), { snap: false });
    expect(h.label("snap:toggle")).toBe("Ligar o encaixe magnético");
    await h.run("snap:toggle");
    expect(h.s.snapOn).toBe(true);
    expect(h.label("snap:toggle")).toBe("Desligar o encaixe magnético");
    await h.run("snap:toggle");
    expect(h.s.snapOn).toBe(false);
  });
});

// ---- O5 copiar, colar, duplicar, excluir ----

describe("canvas-commands-canvas: copiar, colar, duplicar e excluir (O5)", () => {
  const base = (): CanvasDoc => makeDoc([note("a", 0, 0), note("b", 200, 0), note("c", 400, 0), live("agent:r:z", 600, 0)], [edge("e1", "a", "b"), edge("e2", "b", "c")], [group("g1", ["a", "b"])]);

  test("colar sem nada copiado não vale", () => {
    expect(harness(base()).applies("clip:paste")).toBe(false);
  });

  test("selecionar tudo marca os nós à vista e deixa de fora os ocultos", async () => {
    const h = harness({ ...base(), hidden: ["c"] });
    await h.run("select:all");
    expect([...h.s.selection].sort()).toEqual(["a", "agent:r:z", "b"]);
  });

  test("selecionar tudo com o canvas vazio não vale e com tudo oculto também não", () => {
    expect(harness(makeDoc([])).applies("select:all")).toBe(false);
    expect(harness({ ...makeDoc([note("a", 0, 0)]), hidden: ["a"] }).applies("select:all")).toBe(false);
  });

  test("selecionar tudo é Ctrl+A e não vale com campo ou terminal em foco", () => {
    const def = harness(base()).def("select:all");
    expect(def.shortcut).toBe("mod+a");
    expect(def.inEditable).toBe(false);
  });

  test("copiar e colar leva os nós, a conexão interna e o grupo; seleciona os novos; desfazer volta ao anterior", async () => {
    const h = harness(base());
    const before = clone(h.s.doc);
    h.s.selection = ["a", "b"];
    await h.run("clip:copy");
    await h.run("clip:paste");
    expect(h.s.doc.nodes).toHaveLength(6);
    expect(h.s.selection).toHaveLength(2);
    expect(h.s.selection.every((id) => !["a", "b"].includes(id))).toBe(true);
    expect(h.s.doc.edges).toHaveLength(3);
    expect(h.s.doc.groups).toHaveLength(2);
    expect(h.s.doc.groups[1]?.members).toEqual(h.s.selection);
    h.undoAll();
    expect(h.s.doc).toEqual(before);
  });

  test("cada colagem seguinte anda mais um passo, para não cair em cima da anterior", async () => {
    const h = harness(base());
    h.s.selection = ["c"];
    await h.run("clip:copy");
    await h.run("clip:paste");
    const first = at(h.s.doc, h.s.selection[0] as string);
    await h.run("clip:paste");
    const second = at(h.s.doc, h.s.selection[0] as string);
    expect(first.x - at(h.s.doc, "c").x).toBe(clipboard.PASTE_OFFSET.dx);
    expect(second.x - first.x).toBe(clipboard.PASTE_OFFSET.dx);
  });

  test("copiar um nó vivo avisa e não guarda nada; a mistura copia só os do usuário", async () => {
    const h = harness(base());
    h.s.selection = ["agent:r:z"];
    await h.run("clip:copy");
    expect(h.s.notes.at(-1)).toMatchObject({ level: "warn" });
    expect(h.applies("clip:paste")).toBe(false);
    h.s.selection = ["c", "agent:r:z"];
    await h.run("clip:copy");
    expect(h.applies("clip:paste")).toBe(true);
  });

  test("duplicar cria cópias deslocadas dos nós do usuário e avisa dos vivos que ficaram de fora", async () => {
    const h = harness(base());
    const before = clone(h.s.doc);
    h.s.selection = ["c", "agent:r:z"];
    await h.run("clip:duplicate");
    expect(h.s.doc.nodes).toHaveLength(5);
    expect(h.s.selection).toHaveLength(1);
    expect(h.s.notes.at(-1)?.level).toBe("warn");
    h.undoAll();
    expect(h.s.doc).toEqual(before);
  });

  test("duplicar só nó vivo não grava nada e avisa", async () => {
    const h = harness(base());
    h.s.selection = ["agent:r:z"];
    await h.run("clip:duplicate");
    expect(h.s.commits).toBe(0);
    expect(h.s.notes).toHaveLength(1);
  });

  test("excluir tira os nós e as conexões, desfaz o grupo que ficou com um membro e limpa a seleção; desfazer devolve tudo", async () => {
    const h = harness(base());
    const before = clone(h.s.doc);
    h.s.selection = ["a"];
    await h.run("clip:delete");
    expect(ids(h.s.doc)).not.toContain("a");
    expect(h.s.doc.edges.map((e) => e.id)).toEqual(["e2"]);
    expect(h.s.doc.groups).toEqual([]);
    expect(h.s.selection).toEqual([]);
    expect(h.s.history.past).toHaveLength(1);
    h.undoAll();
    expect(h.s.doc).toEqual(before);
  });

  test("excluir só um nó vivo avisa e não muda o documento", async () => {
    const h = harness(base());
    h.s.selection = ["agent:r:z"];
    await h.run("clip:delete");
    expect(h.s.commits).toBe(0);
    expect(h.s.notes[0]?.level).toBe("warn");
  });

  test("Delete e Backspace disparam excluir, mas não com o foco num campo de texto", () => {
    const h = harness(base());
    h.s.selection = ["a"];
    const ctx = { editable: false, ctx: {} };
    expect(h.registry.resolveKey({ key: "Delete" }, ctx)?.id).toBe("clip:delete");
    expect(h.registry.resolveKey({ key: "Backspace" }, ctx)?.id).toBe("clip:delete");
    expect(h.registry.resolveKey({ key: "Delete" }, { editable: true, ctx: {} })).toBeNull();
    expect(h.registry.resolveKey({ key: "c", ctrlKey: true }, { editable: true, ctx: {} })).toBeNull();
  });

  test("Ctrl+G, Ctrl+D e Ctrl+C chegam ao comando certo pelo teclado", () => {
    const h = harness(base());
    h.s.selection = ["a", "b"];
    const ctx = { editable: false, ctx: {} };
    expect(h.registry.resolveKey({ key: "g", ctrlKey: true }, ctx)?.id).toBe("group:create");
    expect(h.registry.resolveKey({ key: "G", ctrlKey: true, shiftKey: true }, ctx)?.id).toBe("group:ungroup");
    expect(h.registry.resolveKey({ key: "d", ctrlKey: true }, ctx)?.id).toBe("clip:duplicate");
    expect(h.registry.resolveKey({ key: "c", ctrlKey: true }, ctx)?.id).toBe("clip:copy");
  });
});

// ---- N4 / N5 ----

describe("canvas-commands-canvas: andar pelas conexões (N4) e próximo do dono (N5)", () => {
  const chain = (): CanvasDoc => makeDoc([note("a", 0, 0), note("b", 0, 100), note("c", 0, 200), note("lone", 500, 0)], [edge("e1", "a", "b"), edge("e2", "b", "c")]);

  test("o próximo segue a ordem de passeio do modelo, seleciona o nó e leva a câmera até ele", async () => {
    const h = harness(chain());
    h.s.selection = ["a"];
    await h.run("walk:next");
    expect(h.s.selection).toEqual(["b"]);
    expect(h.s.revealed).toEqual(["b"]);
    await h.run("walk:next");
    expect(h.s.selection).toEqual(["c"]);
  });

  test("anterior volta, e dá a volta nas pontas", async () => {
    const h = harness(chain());
    const order = walk.walkOrder(h.s.doc);
    h.s.selection = [order[0] as string];
    await h.run("walk:previous");
    expect(h.s.selection).toEqual([order.at(-1) as string]);
  });

  test("sem seleção, próximo começa no primeiro e anterior no último", async () => {
    const h = harness(chain());
    const order = walk.walkOrder(h.s.doc);
    await h.run("walk:next");
    expect(h.s.selection).toEqual([order[0] as string]);
    h.s.selection = [];
    await h.run("walk:previous");
    expect(h.s.selection).toEqual([order.at(-1) as string]);
  });

  test("documento vazio e documento com um nó só não andam para lugar nenhum", async () => {
    const empty = harness(makeDoc([]));
    await empty.run("walk:next");
    expect(empty.s.selection).toEqual([]);
    const one = harness(makeDoc([note("a", 0, 0)]));
    one.s.selection = ["a"];
    await one.run("walk:next");
    expect(one.s.revealed).toEqual([]);
  });

  test("Ctrl+Alt+setas disparam o passeio; a seta sozinha não", () => {
    const h = harness(chain());
    const ctx = { editable: false, ctx: {} };
    expect(h.registry.resolveKey({ key: "ArrowRight", ctrlKey: true, altKey: true }, ctx)?.id).toBe("walk:next");
    expect(h.registry.resolveKey({ key: "ArrowLeft", ctrlKey: true, altKey: true }, ctx)?.id).toBe("walk:previous");
    expect(h.registry.resolveKey({ key: "ArrowRight" }, ctx)).toBeNull();
  });

  const waiting = (id: string, ts: string): next.NextNode => ({ id, type: "agent", state: "working", pendingPermission: { ts, tool: "Bash" }, lastEventTs: ts });

  test("o próximo que precisa do dono anda pela fila, com ciclo, e diz o motivo", async () => {
    const owner = [waiting("a", "2026-01-02T00:00:00Z"), waiting("b", "2026-01-01T00:00:00Z"), { id: "c", type: "agent", state: "working" }];
    const h = harness(chain(), { owner });
    await h.run("owner:next");
    expect(h.s.selection).toEqual(["b"]);
    expect(h.s.notes.at(-1)?.text).toBe(next.OWNER_REASON_LABELS.permission);
    await h.run("owner:next");
    expect(h.s.selection).toEqual(["a"]);
    await h.run("owner:next");
    expect(h.s.selection).toEqual(["b"]);
    await h.run("owner:previous");
    expect(h.s.selection).toEqual(["a"]);
    expect(h.s.revealed).toEqual(["b", "a", "b", "a"]);
  });

  test("fila vazia avisa e não mexe na seleção", async () => {
    const h = harness(chain(), { owner: [{ id: "c", type: "agent", state: "working" }] });
    h.s.selection = ["c"];
    await h.run("owner:next");
    expect(h.s.selection).toEqual(["c"]);
    expect(h.s.notes[0]).toMatchObject({ level: "info" });
  });
});

// ---- A4 lote ----

describe("canvas-commands-canvas: ações em lote (A4)", () => {
  const agents = (n: number): CanvasDoc => makeDoc(Array.from({ length: n }, (_, i) => live(`agent:r:ag${i}`, i * 150, 0)));

  test("aprovar: planeja, confirma com o dono, envia um pedido por agente e mostra o resultado por agente", async () => {
    const h = harness(agents(3), { batch: {} });
    h.s.selection = ["agent:r:ag0", "agent:r:ag1"];
    await h.run("batch:approve");
    expect(h.s.confirmedPlans).toHaveLength(1);
    expect(h.s.confirmedPlans[0]?.targets.map((t) => t.label)).toEqual(["ag0", "ag1"]);
    expect(h.s.sent).toHaveLength(2);
    expect(h.s.sent[0]).toMatchObject({ node: "agent:r:ag0", action: "approve_permission" });
    expect(h.s.shown).toHaveLength(1);
    expect(h.s.shown[0]?.totals).toMatchObject({ ok: 2, refused: 0, error: 0, pending: 0 });
  });

  test("o dono cancela na confirmação: nada é enviado", async () => {
    const h = harness(agents(2), { batch: { confirmed: false } });
    h.s.selection = ["agent:r:ag0"];
    await h.run("batch:resume");
    expect(h.s.sent).toEqual([]);
    expect(h.s.shown).toEqual([]);
  });

  test("resposta recusada de um agente aparece no resultado sem derrubar o resto", async () => {
    const h = harness(agents(2), {
      batch: { responses: (list) => list.map((id, i) => (i === 0 ? { id, status: 409, body: { code: "no_pending_permission", error: "sem pedido" } } : { id, status: 200, body: { ok: true } })) },
    });
    h.s.selection = ["agent:r:ag0", "agent:r:ag1"];
    await h.run("batch:deny");
    expect(h.s.shown[0]?.totals).toMatchObject({ ok: 1, refused: 1 });
  });

  test("acima do teto o lote é recusado com o código, sem perguntar nem enviar", async () => {
    const h = harness(agents(batch.BATCH_MAX_TARGETS + 1), { batch: {} });
    h.s.selection = ids(h.s.doc);
    await h.run("batch:resume");
    expect(h.s.confirmedPlans).toEqual([]);
    expect(h.s.notes[0]).toMatchObject({ level: "warn", code: batch.BATCH_ERRORS.tooLarge });
  });

  test("nó que não é agente fica de fora; se nenhum serve, avisa com o código", async () => {
    const h = harness(makeDoc([note("n1", 0, 0)]), { batch: {} });
    h.api.batch = { ...(h.api.batch as NonNullable<Api["batch"]>), nodes: (list) => list.map((id) => ({ id, type: "note", label: id })) };
    const registry = createCommandRegistry<object>();
    Cmd.registerCanvasCommands(registry, h.api);
    h.s.selection = ["n1"];
    registry.get("batch:resume")?.run({});
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.s.notes[0]).toMatchObject({ code: batch.BATCH_ERRORS.noValidTargets });
    expect(h.s.sent).toEqual([]);
  });

  test("lote sem seleção não vale; selecionar o filtrado marca só o que o documento tem", async () => {
    const h = harness(agents(3), { batch: { filtered: ["agent:r:ag1", "agent:r:ag2", "agent:r:fantasma"] } });
    expect(h.applies("batch:resume")).toBe(false);
    await h.run("batch:select-filtered");
    expect(h.s.selection).toEqual(["agent:r:ag1", "agent:r:ag2"]);
  });

  test("filtro vazio avisa e não altera a seleção", async () => {
    const h = harness(agents(2), { batch: { filtered: [] } });
    h.s.selection = ["agent:r:ag0"];
    await h.run("batch:select-filtered");
    expect(h.s.selection).toEqual(["agent:r:ag0"]);
    expect(h.s.notes[0]?.level).toBe("info");
  });

  test("falha de rede inesperada no envio vira aviso de erro em vez de promessa solta", async () => {
    const h = harness(agents(1), { batch: {} });
    (h.api.batch as NonNullable<Api["batch"]>).send = async () => {
      throw new Error("rede caiu");
    };
    const registry = createCommandRegistry<object>();
    Cmd.registerCanvasCommands(registry, h.api);
    const quiet = console.error;
    console.error = () => undefined;
    try {
      h.s.selection = ["agent:r:ag0"];
      registry.get("batch:resume")?.run({});
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = quiet;
    }
    expect(h.s.notes.at(-1)).toMatchObject({ level: "error", code: "canvas_command_failed" });
  });
});

// ---- O6 / O7 ----

describe("canvas-commands-canvas: desfocar (O6) e elevar/acoplar (O7)", () => {
  const base = (): CanvasDoc => makeDoc([note("a", 0, 0), note("b", 200, 0), live("agent:r:z", 400, 0)]);

  test("desfocar a seleção em um passo; o título vira Revelar; desfazer volta ao anterior", async () => {
    const h = harness(base());
    const before = clone(h.s.doc);
    h.s.selection = ["a", "agent:r:z"];
    expect(h.label("blur:toggle")).toBe("Desfocar o conteúdo");
    await h.run("blur:toggle");
    expect(at(h.s.doc, "a").blurred && at(h.s.doc, "agent:r:z").blurred).toBe(true);
    expect(at(h.s.doc, "b").blurred).toBe(false);
    expect(h.label("blur:toggle")).toBe("Revelar o conteúdo");
    expect(h.s.history.past).toHaveLength(1);
    await h.run("blur:toggle");
    expect(h.s.doc.nodes.every((n) => !n.blurred)).toBe(true);
    h.undoAll();
    expect(h.s.doc).toEqual(before);
  });

  test("desfocar não vale sem seleção", () => {
    expect(harness(base()).applies("blur:toggle")).toBe(false);
  });

  test("elevar alterna pelo mesmo comando e só vale com um nó selecionado", async () => {
    const h = harness(base(), { dock: true });
    h.s.selection = ["a", "b"];
    expect(h.applies("dock:elevate")).toBe(false);
    h.s.selection = ["a"];
    expect(h.label("dock:elevate")).toBe("Elevar o nó");
    await h.run("dock:elevate");
    expect(h.s.dock.elevated).toBe("a");
    expect(h.label("dock:elevate")).toBe("Baixar o nó elevado");
    await h.run("dock:elevate");
    expect(h.s.dock.elevated).toBeNull();
    expect(h.s.commits).toBe(0);
  });

  test("acoplar nas duas bordas e soltar a coluna", async () => {
    const h = harness(base(), { dock: true });
    h.s.selection = ["a"];
    expect(h.applies("dock:undock")).toBe(false);
    await h.run("dock:left");
    expect(h.s.dock.columns).toMatchObject([{ id: "a", edge: "left" }]);
    expect(h.applies("dock:undock")).toBe(true);
    await h.run("dock:right");
    expect(h.s.dock.columns).toMatchObject([{ id: "a", edge: "right" }]);
    await h.run("dock:undock");
    expect(h.s.dock.columns).toEqual([]);
  });

  test("borda cheia: o modelo recusa com o código e o estado não muda", async () => {
    const many = makeDoc(Array.from({ length: dock.DOCK_LIMITS.columnsPerEdge + 1 }, (_, i) => note(`n${i}`, i * 150, 0)));
    const h = harness(many, { dock: true });
    for (let i = 0; i < dock.DOCK_LIMITS.columnsPerEdge; i += 1) {
      h.s.selection = [`n${i}`];
      await h.run("dock:left");
    }
    const full = h.s.dock;
    h.s.selection = [`n${dock.DOCK_LIMITS.columnsPerEdge}`];
    await h.run("dock:left");
    expect(h.s.dock).toBe(full);
    expect(h.s.notes.at(-1)).toMatchObject({ level: "error", code: groups.ORG_ERRORS.limitExceeded });
  });
});

// ---- W1 / W3 ----

describe("canvas-commands-canvas: vários canvases (W1) e exportar/importar (W3)", () => {
  const two = [{ id: "default", name: "Padrão" }, { id: "plano-p5", name: "Plano p5" }];
  const base = (): CanvasDoc => makeDoc([note("a", 0, 0), note("b", 200, 0)], [edge("e1", "a", "b")], [group("g1", ["a", "b"])]);

  test("novo canvas: o nome vira id livre, o canvas é criado e a página troca para ele", async () => {
    const h = harness(base(), { workspace: { canvases: two } });
    h.s.answers.text = ["Plano p5"];
    await h.run("canvas:new");
    expect(h.s.created).toEqual([{ id: "plano-p5-2", name: "Plano p5" }]);
    expect(h.s.switched).toEqual(["plano-p5-2"]);
  });

  test("nome inválido ou cancelado não cria nada; o inválido avisa com o código", async () => {
    const h = harness(base(), { workspace: {} });
    h.s.answers.text = [null];
    await h.run("canvas:new");
    h.s.answers.text = ["   "];
    await h.run("canvas:new");
    expect(h.s.created).toEqual([]);
    expect(h.s.notes).toEqual([expect.objectContaining({ level: "error", code: store.CANVAS_STORE_ERRORS.invalidName })]);
  });

  test("no teto de canvases recusa com o código do modelo", async () => {
    const full = Array.from({ length: store.CANVAS_STORE_LIMITS.canvases }, (_, i) => ({ id: i === 0 ? "default" : `c${i}`, name: `C${i}` }));
    const h = harness(base(), { workspace: { canvases: full } });
    h.s.answers.text = ["Mais um"];
    await h.run("canvas:new");
    expect(h.s.created).toEqual([]);
    expect(h.s.notes[0]).toMatchObject({ code: store.CANVAS_STORE_ERRORS.limitReached });
  });

  test("trocar: pela escolha, e próximo/anterior dão a volta; com um canvas só nenhum vale", async () => {
    const solo = harness(base(), { workspace: {} });
    for (const id of ["canvas:switch", "canvas:next", "canvas:previous"]) expect(solo.applies(id)).toBe(false);
    const h = harness(base(), { workspace: { canvases: two } });
    h.s.answers.choose = ["plano-p5"];
    await h.run("canvas:switch");
    expect(h.s.switched).toEqual(["plano-p5"]);
    await h.run("canvas:next");
    expect(h.s.switched.at(-1)).toBe("default");
    await h.run("canvas:previous");
    expect(h.s.switched.at(-1)).toBe("plano-p5");
  });

  test("o canvas padrão não se renomeia nem se exclui", () => {
    const h = harness(base(), { workspace: { canvases: two } });
    expect(h.applies("canvas:rename")).toBe(false);
    expect(h.applies("canvas:delete")).toBe(false);
  });

  test("renomear grava o nome aparado; nome inválido avisa", async () => {
    const h = harness(base(), { workspace: { canvases: two, current: "plano-p5" } });
    h.s.answers.text = ["  Novo nome  "];
    await h.run("canvas:rename");
    expect(h.s.renamed).toEqual([["plano-p5", "Novo nome"]]);
    h.s.answers.text = [""];
    await h.run("canvas:rename");
    expect(h.s.renamed).toHaveLength(1);
    expect(h.s.notes[0]).toMatchObject({ code: store.CANVAS_STORE_ERRORS.invalidName });
  });

  test("excluir pede confirmação; confirmado, volta ao padrão antes de apagar", async () => {
    const h = harness(base(), { workspace: { canvases: two, current: "plano-p5" } });
    h.s.answers.confirm = [false];
    await h.run("canvas:delete");
    expect(h.s.removed).toEqual([]);
    h.s.answers.confirm = [true];
    await h.run("canvas:delete");
    expect(h.s.switched).toEqual(["default"]);
    expect(h.s.removed).toEqual(["plano-p5"]);
  });

  test("exportar entrega um arquivo que o importador lê de volta com o mesmo documento (relógio injetado)", async () => {
    const h = harness(base(), { workspace: { canvases: two, current: "plano-p5" } });
    await h.run("canvas:export");
    expect(h.s.files).toHaveLength(1);
    expect(h.s.files[0]?.filename).toBe("plano-p5.hades-canvas.json");
    const parsed = exportModel.parseCanvasExport(h.s.files[0]?.text as string);
    expect(parsed.name).toBe("Plano p5");
    expect(parsed.doc).toEqual(base());
    expect(JSON.parse(h.s.files[0]?.text as string).exportedAt).toBe("2026-03-04T05:06:07.000Z");
  });

  test("importar cria um canvas novo com o documento do arquivo e troca para ele, sem tocar no atual", async () => {
    const source = harness(base(), { workspace: { canvases: two, current: "plano-p5" } });
    await source.run("canvas:export");
    const h = harness(makeDoc([]), { workspace: { canvases: two, picked: source.s.files[0]?.text as string } });
    await h.run("canvas:import");
    expect(h.s.created).toHaveLength(1);
    expect(h.s.created[0]?.id).toBe("plano-p5-2");
    expect(h.s.created[0]?.doc).toEqual(base());
    expect(h.s.switched).toEqual(["plano-p5-2"]);
    expect(h.s.commits).toBe(0);
  });

  test("arquivo que não é JSON, de outro formato, ou cancelado: nada é criado e o erro leva o código", async () => {
    const cancelled = harness(makeDoc([]), { workspace: { picked: null } });
    await cancelled.run("canvas:import");
    expect(cancelled.s.notes).toEqual([]);
    for (const [text, code] of [["isto não é json", "canvas_invalid_json"], [JSON.stringify({ format: "outro" }), "canvas_export_invalid_format"]] as const) {
      const h = harness(makeDoc([]), { workspace: { picked: text } });
      await h.run("canvas:import");
      expect(h.s.created).toEqual([]);
      expect(h.s.notes[0]?.level).toBe("error");
      expect(h.s.notes[0]?.code).toBe(code);
    }
  });

  test("arquivo acima do limite de bytes é recusado antes de ler", async () => {
    const h = harness(makeDoc([]), { workspace: { picked: " ".repeat(5 * 1024 * 1024) } });
    await h.run("canvas:import");
    expect(h.s.created).toEqual([]);
    expect(h.s.notes[0]?.code).toBe("canvas_too_large");
  });
});

describe("canvas-commands-canvas: áreas (O8)", () => {
  const base = (): CanvasDoc => makeDoc([note("a", 100, 100), note("b", 300, 100), note("far", 3000, 3000)]);
  const areaOf = (d: CanvasDoc, id: string): string[] => areas.areaMembers(d, id).map((n) => n.id);
  const firstArea = (d: CanvasDoc): CanvasNode => d.nodes.find((n) => n.type === "area") as CanvasNode;

  test("area:create em volta da seleção encaixa os nós, seleciona a área e desfazer devolve o documento", async () => {
    const h = harness(base());
    const before = clone(h.s.doc);
    h.s.selection = ["a", "b"];
    await h.run("area:create");
    const created = firstArea(h.s.doc);
    expect(areaOf(h.s.doc, created.id)).toEqual(["a", "b"]);
    expect(created.x).toBeLessThan(100);
    expect(created.x + created.w).toBeGreaterThan(400);
    expect(h.s.selection).toEqual([created.id]);
    expect(h.s.history.past).toHaveLength(1);
    h.undoAll();
    expect(h.s.doc).toEqual(before);
  });

  test("area:create sem seleção cria uma área vazia", async () => {
    const h = harness(base());
    await h.run("area:create");
    expect(areaOf(h.s.doc, firstArea(h.s.doc).id)).toEqual([]);
  });

  test("area:dock só vale com nó solto e área; encaixa a escolhida e area:undock retira", async () => {
    const h = harness(base());
    h.s.selection = ["far"];
    expect(h.applies("area:dock")).toBe(false);
    h.s.selection = [];
    await h.run("area:create");
    const id = firstArea(h.s.doc).id;
    h.s.selection = ["far"];
    expect(h.applies("area:undock")).toBe(false);
    h.s.answers.choose.push(id);
    await h.run("area:dock");
    expect(areaOf(h.s.doc, id)).toEqual(["far"]);
    h.s.selection = ["far"];
    await h.run("area:undock");
    expect(areaOf(h.s.doc, id)).toEqual([]);
  });

  test("area:rename e area:color trocam título e cor; cancelar não grava; título inválido avisa", async () => {
    const h = harness(base());
    await h.run("area:create");
    const id = firstArea(h.s.doc).id;
    h.s.selection = [id];
    const commits = h.s.commits;
    await h.run("area:rename");
    expect(h.s.commits).toBe(commits);
    h.s.answers.text.push("Squad");
    await h.run("area:rename");
    expect(firstArea(h.s.doc).data.title).toBe("Squad");
    h.s.answers.text.push("   ");
    await h.run("area:rename");
    expect(h.s.notes.at(-1)?.level).toBe("error");
    h.s.answers.choose.push("chart-4");
    await h.run("area:color");
    expect(firstArea(h.s.doc).data.color).toBe("chart-4");
  });
});
