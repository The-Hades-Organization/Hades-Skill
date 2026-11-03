/// <reference path="../../../kit/panel/ui/argos/logic.tsx" />
/// <reference path="../../../kit/panel/ui/argos/reading-runner.tsx" />
// Leitura do grafo na página Argos: a regra da página (argos/logic.tsx) e o executor das forças (argos/reading-runner.tsx)
// sobre os modelos reais de src/lib (registro de comandos, vizinhança, busca, filtros, forças).
import { describe, expect, test } from "bun:test";
import "../../../kit/panel/ui/argos/logic.tsx";
import "../../../kit/panel/ui/argos/reading-runner.tsx";
import "../../../kit/panel/ui/argos/canvas-synth.tsx";
import { readFileSync } from "node:fs";
import { createArgosRegistries, type ArgosCommandCtx, type ArgosHandlers } from "../../../src/lib/canvas-argos.ts";
import { applyFilters, buildFilterBar } from "../../../src/lib/canvas-filters.ts";
import { FORCE_ERRORS, ForceError, forceArrange, startArrange } from "../../../src/lib/canvas-force.ts";
import { neighborhood } from "../../../src/lib/canvas-neighbors.ts";
import { createSearchIndex } from "../../../src/lib/canvas-search.ts";

const L = (globalThis as unknown as { ArgosLogic: ArgosLogicApi }).ArgosLogic;
const Runner = (globalThis as unknown as { ArgosReadingRunner: ArgosReadingRunnerApi }).ArgosReadingRunner;
const Synth = (globalThis as unknown as { ArgosCanvasSynth: { syntheticDoc(o: { count: number; seed?: number }): import("../../../src/lib/canvas-doc.ts").CanvasDoc } }).ArgosCanvasSynth;

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const agent = (name: string, extra: Partial<ArgosNode> = {}): ArgosNode => ({
  id: `agent:o__r:${name}`, type: "agent", label: name, role: "impl", state: "working", lastEventTs: new Date(NOW - 60_000).toISOString(),
  pendingPermission: null, registry: "o__r", ...extra,
});

describe("comandos da leitura no registro da página", () => {
  type Ctx = ArgosCommandCtx & ReadingCommandCtx;
  const calls: string[] = [];
  const argosHandlers: ArgosHandlers = {
    palette: () => calls.push("palette"), next: () => calls.push("next"), prev: () => calls.push("prev"), open: () => calls.push("open"),
    close: () => calls.push("close"), fit: () => calls.push("fit"), toggleView: () => calls.push("toggle-view"), help: () => calls.push("help"),
    setView: (v) => calls.push(`view:${v}`), setStateFilter: (v) => calls.push(`filter:${v}`), runAction: (id) => calls.push(`action:${id}`),
    undo: () => calls.push("undo"), redo: () => calls.push("redo"),
  };
  const readingHandlers: ReadingCommandCtx["handlers"] = {
    openFilters: () => calls.push("open-filters"), toggleLayout: () => calls.push("toggle-layout"), arrange: () => calls.push("arrange"), stopLayout: () => calls.push("stop"),
    togglePin: (id) => calls.push(`pin:${id}`), focusSearch: () => calls.push("search"), clearSearch: () => calls.push("clear-search"),
    clearFilters: () => calls.push("clear-filters"), saveView: () => calls.push("save-view"),
  };
  const ctx = (reading: Partial<ReadingCommandCtx["reading"]> = {}): Ctx => ({
    selectedLabel: null, availableActions: [], canUndo: false, canRedo: false, handlers: { ...argosHandlers, ...readingHandlers },
    reading: { layout: "free", running: false, nodeId: null, pinned: false, searching: false, filtering: false, ...reading },
  });
  const registries = (): ReturnType<typeof createArgosRegistries> => {
    const made = createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null });
    for (const def of L.readingCommandDefs()) made.commands.register(def as unknown as Parameters<typeof made.commands.register>[0]);
    return made;
  };

  test("dado o registro do Argos, os comandos da leitura entram sem atalho em conflito", () => {
    expect(registries).not.toThrow();
  });
  test("Shift+L alterna o layout, Shift+P fixa o nó em foco e b leva à busca", () => {
    const { commands } = registries();
    calls.length = 0;
    commands.resolveKey({ key: "L", shiftKey: true }, { editable: false, ctx: ctx() })?.run(ctx());
    commands.resolveKey({ key: "P", shiftKey: true }, { editable: false, ctx: ctx({ nodeId: "n1" }) })?.run(ctx({ nodeId: "n1" }));
    commands.resolveKey({ key: "b" }, { editable: false, ctx: ctx() })?.run(ctx());
    expect(calls).toEqual(["toggle-layout", "pin:n1", "search"]);
  });
  test("fixar sem nó em foco não dispara; b dentro de campo de texto é do campo", () => {
    const { commands } = registries();
    expect(commands.resolveKey({ key: "P", shiftKey: true }, { editable: false, ctx: ctx() })).toBeNull();
    expect(commands.resolveKey({ key: "b" }, { editable: true, ctx: ctx() })).toBeNull();
  });
  test("parar só aparece com forças rodando; reorganizar só com forças paradas", () => {
    const { commands } = registries();
    const idsOf = (c: Ctx): string[] => commands.palette(c).map((e) => e.id);
    expect(idsOf(ctx({ layout: "force" }))).toContain("layout:arrange");
    expect(idsOf(ctx({ layout: "force" }))).not.toContain("layout:stop");
    expect(idsOf(ctx({ layout: "force", running: true }))).toEqual(expect.arrayContaining(["layout:stop"]));
    expect(idsOf(ctx({ layout: "force", running: true }))).not.toContain("layout:arrange");
    expect(idsOf(ctx())).not.toContain("layout:arrange");
  });
  test("rótulo do pin segue o estado do nó; o menu do nó o recebe pela lista READING_NODE_MENU", () => {
    const { commands } = registries();
    const entry = (c: Ctx) => commands.palette(c).filter((e) => L.READING_NODE_MENU.includes(e.id));
    expect(entry(ctx({ nodeId: "n1" })).map((e) => e.label)).toEqual(["Fixar o nó"]);
    expect(entry(ctx({ nodeId: "n1", pinned: true })).map((e) => e.label)).toEqual(["Soltar o nó"]);
    expect(entry(ctx())).toEqual([]);
  });
});

describe("ênfase sobre a vizinhança real", () => {
  test("dada a cadeia a-b-c-d com a selecionado, a e b inteiros, c mais claro e d esmaecido", () => {
    const ids = ["a", "b", "c", "d"];
    const hood = neighborhood(["a"], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }], ids);
    const alpha = L.emphasisFor(hood, null, ids);
    expect(ids.map((id) => alpha?.get(id) ?? 1)).toEqual([1, 1, L.EMPHASIS_ALPHA.second, L.EMPHASIS_ALPHA.dimmed]);
  });
  test("seleção vazia não destaca nada", () => {
    expect(L.emphasisFor(neighborhood([], [{ from: "a", to: "b" }], ["a", "b"]), null, ["a", "b"])).toBeNull();
  });
});

describe("busca sobre o índice real", () => {
  const nodes = [agent("alfa", { branch: "feat/mapa", number: 42 }), agent("beta", { files: ["src/lib/canvas-force.ts"] }), agent("gama")];
  const rects = [
    { id: "agent:o__r:alfa", x: 0, y: 0, w: 100, h: 50 },
    { id: "agent:o__r:beta", x: 400, y: 300, w: 100, h: 50 },
    { id: "agent:o__r:gama", x: 900, y: 900, w: 100, h: 50 },
  ];
  const index = createSearchIndex(L.searchItems(nodes, rects));
  test("acha pelo branch e pelo número da PR", () => {
    expect(index.search("mapa").ids).toEqual(["agent:o__r:alfa"]);
    expect(index.search("42").ids).toEqual(["agent:o__r:alfa"]);
  });
  test("acha pelo arquivo e devolve a caixa dos achados", () => {
    const r = index.search("canvas-force");
    expect(r.ids).toEqual(["agent:o__r:beta"]);
    expect(r.box).toEqual({ x: 400, y: 300, w: 100, h: 50 });
  });
  test("termo acima do limite devolve o código do problema e nenhum achado", () => {
    const r = index.search("x".repeat(101));
    expect(r.problem).toBe("search_term_too_long");
    expect(r.ids).toEqual([]);
  });
});

describe("filtros sobre os nós da página", () => {
  const nodes = [agent("caro", { costUsd: 50 }), agent("barato", { costUsd: 0.1 }), agent("sem", { costUsd: Number.NaN })];
  test("nó com custo inválido cai em 'sem custo medido', não em zero", () => {
    const bar = buildFilterBar(L.filterNodes(nodes), [], {}, NOW);
    const cost = bar.find((d) => d.dim === "cost");
    expect(cost?.chips.find((c) => c.value === "none")?.count).toBe(1);
  });
  test("chip de custo esconde quem não tem custo medido", () => {
    const visible = applyFilters(L.filterNodes(nodes), [], { cost: ["none"] }, NOW).visible;
    expect([...visible]).toEqual(["agent:o__r:sem"]);
  });
});

describe("executor das forças", () => {
  interface Fake { frames: (() => void)[]; time: number; shown: number; done: ForceRunResult[]; errors: unknown[] }
  const fakeRunner = (extra: Partial<ForceRunnerDeps> = {}): { runner: ForceRunner; fake: Fake; pump(max?: number): void } => {
    const fake: Fake = { frames: [], time: 0, shown: 0, done: [], errors: [] };
    const runner = Runner.createForceRunner({
      frame: (run) => fake.frames.push(run), cancel: (h) => { fake.frames[h - 1] = () => {}; },
      // cada leitura do relógio anda 1 ms: o passo "custa" tempo e a fatia cresce pela medida
      clock: () => ++fake.time,
      show: () => { fake.shown++; }, onDone: (r) => fake.done.push(r), onError: (e) => fake.errors.push(e), ...extra,
    });
    const pump = (max = 10_000): void => {
      for (let i = 0; i < fake.frames.length && i < max; i++) fake.frames[i]?.();
    };
    return { runner, fake, pump };
  };
  const doc = Synth.syntheticDoc({ count: 60, seed: 3 });
  const neighbors = L.neighborMap(doc.edges);

  test("dada uma rodada até o fim, o resultado é o mesmo da rodada de uma vez só", () => {
    const { runner, fake, pump } = fakeRunner();
    runner.start(startArrange({ doc, neighbors }));
    pump();
    expect(fake.done).toHaveLength(1);
    expect(runner.running()).toBe(false);
    const once = forceArrange({ doc, neighbors });
    expect(fake.done[0]?.placements).toEqual(once.placements);
    expect(fake.done[0]?.steps).toBe(once.steps);
    expect(fake.done[0]?.settled).toBe(once.settled);
  });
  test("cada quadro mostra as posições; com movimento reduzido nada é mostrado até o fim", () => {
    const animated = fakeRunner();
    animated.runner.start(startArrange({ doc, neighbors }));
    animated.pump();
    expect(animated.fake.shown).toBeGreaterThan(0);
    const still = fakeRunner({ reducedMotion: true });
    still.runner.start(startArrange({ doc, neighbors }));
    still.pump();
    expect(still.fake.shown).toBe(0);
    expect(still.fake.done).toHaveLength(1);
  });
  test("parar no meio devolve o parcial, sem onDone, e o quadro pendente não roda mais", () => {
    const { runner, fake, pump } = fakeRunner();
    runner.start(startArrange({ doc, neighbors }));
    pump(3);
    const partial = runner.stop();
    expect(partial?.settled).toBe(false);
    expect(partial?.placements).toHaveLength(doc.nodes.length);
    pump();
    expect(fake.done).toEqual([]);
    expect(runner.stop()).toBeNull();
  });
  test("relógio sem resolução (sempre o mesmo instante): a fatia dobra e a rodada ainda acaba", () => {
    const { runner, fake, pump } = fakeRunner({ clock: () => 0 });
    runner.start(startArrange({ doc, neighbors }));
    pump();
    expect(fake.done).toHaveLength(1);
    expect(fake.frames.length).toBeLessThan(fake.done[0]?.steps ?? 0);
  });
  test("erro no passo para a rodada e chega com o código; nada é gravado", () => {
    const { runner, fake, pump } = fakeRunner();
    runner.start({ step: () => { throw new ForceError(FORCE_ERRORS.diverged, "saiu do controle"); }, placements: () => [] });
    pump();
    expect(fake.done).toEqual([]);
    expect((fake.errors[0] as ForceError).code).toBe(FORCE_ERRORS.diverged);
    expect(runner.running()).toBe(false);
  });
  test("começar de novo descarta a rodada anterior sem onDone dela", () => {
    const { runner, fake, pump } = fakeRunner();
    runner.start(startArrange({ doc, neighbors }));
    pump(2);
    runner.start(startArrange({ doc, neighbors }));
    pump();
    expect(fake.done).toHaveLength(1);
  });
});

// A página não tem teste com DOM: esta guarda lê o fonte. O estado de eventos da página se chama `history` e sombreia o do
// navegador; `history.pushState` solto quebrou a abertura de #/argos (TypeError ao gravar a vista no endereço).
describe("vista no endereço (fonte da página)", () => {
  const page = readFileSync(new URL("../../../kit/panel/ui/pages/argos.tsx", import.meta.url), "utf8");

  test("dado o estado local `history`, quando a página grava o hash, então usa window.history", () => {
    expect(page).toMatch(/const \[history, setHistory\]/);
    expect(page.match(/(?<![\w.$])history(\[|\.(state|pushState|replaceState|back)\b)/g)).toBeNull();
    expect(page).toMatch(/window\.history\[push \? 'pushState' : 'replaceState'\]/);
  });
});
