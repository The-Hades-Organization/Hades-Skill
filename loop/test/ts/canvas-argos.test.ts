/// <reference path="../../../kit/panel/ui/argos/logic.tsx" />
// Tipos e comandos do Argos de hoje no registro (src/lib/canvas-argos.ts): os quatro tipos do grafo, os comandos que a
// página já tinha (atalhos, filtros de estado, ações) e as quatro listas (paleta, menu do nó, menu do fundo, ajuda).
import { describe, expect, test } from "bun:test";
import "../../../kit/panel/ui/argos/logic.tsx";
import {
  createArgosRegistries, actionCommandId, ARGOS_NODE_SIZE, ciVerdict, costPct, fitIndicators, nodeIndicators, shapePoints, stateLook, typeLook, usdShort,
  type ArgosCommandCtx, type ArgosHandlers, type ArgosRegistries, type IndicatorNode, type Shape,
} from "../../../src/lib/canvas-argos.ts";
import { chordLabel } from "../../../src/lib/canvas-commands.ts";
import { isLiveNodeType } from "../../../src/lib/canvas-doc.ts";

const L = (globalThis as unknown as { ArgosLogic: ArgosLogicApi }).ArgosLogic;

const calls: string[] = [];
const handlers: ArgosHandlers = {
  palette: () => calls.push("palette"), next: () => calls.push("next"), prev: () => calls.push("prev"), open: () => calls.push("open"),
  close: () => calls.push("close"), fit: () => calls.push("fit"), toggleView: () => calls.push("toggle-view"), help: () => calls.push("help"),
  setView: (view) => calls.push(`view:${view}`), setStateFilter: (value) => calls.push(`filter:${value}`), runAction: (id) => calls.push(`action:${id}`),
  undo: () => calls.push("undo"), redo: () => calls.push("redo"),
};
const ctx = (over: Partial<ArgosCommandCtx> = {}): ArgosCommandCtx => ({ selectedLabel: null, availableActions: [], canUndo: false, canRedo: false, handlers, ...over });
const build = (): ArgosRegistries => createArgosRegistries({
  actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null,
});
const ids = (entries: { id: string }[]): string[] => entries.map((entry) => entry.id);

describe("argos no registro: tipos", () => {
  test("dado o registro do Argos, então os quatro tipos do grafo, todos vivos, com o tamanho do cartão de hoje", () => {
    const { types } = build();
    expect(types.list().map((def) => def.type)).toEqual(["unit", "agent", "pr", "gate"]);
    for (const def of types.list()) {
      expect(def.live).toBe(true);
      expect(isLiveNodeType(def.type)).toBe(true);
      expect(def.defaultSize).toEqual({ w: L.NODE_W, h: L.NODE_H });
      expect(def.draw.surface).toBe("html");
    }
    expect(ARGOS_NODE_SIZE).toEqual({ w: L.NODE_W, h: L.NODE_H });
  });

  test("dado o tipo agente, então oferece todas as ações do servidor e cada uma é item do menu; os demais não têm ação", () => {
    const { types } = build();
    expect(types.get("agent")?.actions).toEqual(L.ACTIONS.map((a) => a.id));
    expect(types.get("agent")?.menu).toEqual(L.ACTIONS.map((a) => actionCommandId(a.id)));
    for (const type of ["unit", "pr", "gate"]) expect(types.get(type)?.actions).toEqual([]);
  });
});

describe("argos no registro: comandos migrados", () => {
  test("dado a tabela de atalhos da página, então cada comando tem exatamente as teclas dela e nenhum outro tem atalho", () => {
    const { commands } = build();
    const expected: Record<string, string | string[]> = { palette: ["mod+k", "/"], next: "j", prev: "k", open: "Enter", close: "Escape", fit: "f", "toggle-view": "l", help: "?",
      undo: "mod+z", redo: "mod+shift+z", "action:approve_permission": "a", "action:deny_permission": "x", "action:prompt": "p", "action:resume": "r" };
    for (const [id, chords] of Object.entries(expected)) expect(commands.get(id)?.shortcut, id).toEqual(chords);
    const withShortcut = commands.list().filter((def) => def.shortcut !== undefined).map((def) => def.id).sort();
    expect(withShortcut).toEqual(Object.keys(expected).sort());
  });

  test("dado os filtros de estado antigos, então cada um é um comando de paleta e de menu do fundo com o mesmo rótulo", () => {
    const { commands } = build();
    for (const f of L.STATE_FILTERS) {
      const def = commands.get(`filter:${f.value}`);
      expect(def?.label).toBe(`Filtrar: ${f.label}`);
      expect(def?.surfaces).toEqual(["palette", "canvas-menu"]);
    }
  });

  test("dado cada ação do servidor, então há um comando de paleta e de menu do nó", () => {
    const { commands } = build();
    for (const a of L.ACTIONS) expect(commands.get(actionCommandId(a.id))?.surfaces).toEqual(["palette", "node-menu"]);
  });

  test("dado o teclado, então cada tecla resolve para o comando da tabela, dentro e fora de campo de texto", () => {
    const { commands } = build();
    const picked = ctx({ selectedLabel: "a1", availableActions: L.ACTIONS.map((a) => a.id), canUndo: true, canRedo: true });
    const at = (event: { key: string; ctrlKey?: boolean; shiftKey?: boolean }, editable: boolean): string | null => commands.resolveKey(event, { editable, ctx: picked })?.id ?? null;
    const table: [{ key: string; ctrlKey?: boolean; shiftKey?: boolean }, string, string | null][] = [
      [{ key: "k", ctrlKey: true }, "palette", "palette"], [{ key: "k" }, "prev", null], [{ key: "j" }, "next", null], [{ key: "Enter" }, "open", null],
      [{ key: "Escape" }, "close", "close"], [{ key: "/" }, "palette", null], [{ key: "f" }, "fit", null], [{ key: "l" }, "toggle-view", null],
      [{ key: "a" }, "action:approve_permission", null], [{ key: "x" }, "action:deny_permission", null], [{ key: "p" }, "action:prompt", null],
      [{ key: "r" }, "action:resume", null], [{ key: "?", shiftKey: true }, "help", null],
      [{ key: "z", ctrlKey: true }, "undo", null], [{ key: "z", ctrlKey: true, shiftKey: true }, "redo", null],
    ];
    for (const [event, outside, inside] of table) {
      expect(at(event, false), `fora ${event.key}`).toBe(outside);
      expect(at(event, true), `em campo ${event.key}`).toBe(inside);
    }
  });

  test("dado Ctrl+Z em campo de texto, então não é do canvas (o campo desfaz o próprio texto)", () => {
    const { commands } = build();
    const picked = ctx({ canUndo: true, canRedo: true });
    expect(commands.resolveKey({ key: "z", ctrlKey: true }, { editable: true, ctx: picked })).toBeNull();
    expect(commands.resolveKey({ key: "z", ctrlKey: true, shiftKey: true }, { editable: true, ctx: picked })).toBeNull();
  });

  test("dado nada a desfazer, então Ctrl+Z não dispara e desfazer some da paleta; com histórico, volta", () => {
    const { commands } = build();
    expect(commands.resolveKey({ key: "z", ctrlKey: true }, { editable: false, ctx: ctx() })).toBeNull();
    expect(ids(commands.palette(ctx()))).not.toContain("undo");
    expect(ids(commands.palette(ctx({ canUndo: true })))).toContain("undo");
  });

  test("dado o grupo das ações no nó, então é o mesmo que a paleta da página usa para pô-las antes de 'Ir para o nó'", () => {
    const { commands } = build();
    expect(commands.get("action:prompt")?.group).toBe(L.ACTION_GROUP);
  });
});

describe("argos no registro: as listas", () => {
  test("dado nada selecionado, então a paleta traz filtros, vistas, enquadrar e atalhos; sem ações de nó", () => {
    const { commands } = build();
    const palette = ids(commands.palette(ctx()));
    expect(palette).toEqual(expect.arrayContaining(["fit", "help", "view:graph", "view:list", ...L.STATE_FILTERS.map((f) => `filter:${f.value}`)]));
    expect(palette.some((id) => id.startsWith("action:"))).toBe(false);
  });

  test("dado agente com permissão pendente, então a paleta e o menu do nó trazem aprovar e negar (e não responder); rótulo com o nome do nó", () => {
    const { commands, types } = build();
    const pending = ctx({ selectedLabel: "impl-a", availableActions: ["approve_permission", "deny_permission", "prompt", "resume"] });
    const palette = commands.palette(pending);
    expect(palette.find((e) => e.id === "action:approve_permission")?.label).toBe("Aprovar permissão · impl-a");
    expect(ids(palette)).not.toContain("action:answer");
    const menu = commands.nodeMenu(types.get("agent") as NonNullable<ReturnType<typeof types.get>>, pending);
    expect(ids(menu)).toEqual(["action:approve_permission", "action:deny_permission", "action:prompt", "action:resume"]);
  });

  test("dado nó que não é agente, então o menu do nó é vazio", () => {
    const { commands, types } = build();
    expect(commands.nodeMenu(types.get("pr") as NonNullable<ReturnType<typeof types.get>>, ctx())).toEqual([]);
  });

  test("dado o menu do fundo, então traz enquadrar, ajuda, vistas e filtros, e nenhuma ação de nó", () => {
    const { commands } = build();
    const menu = ids(commands.canvasMenu(ctx()));
    expect(menu).toEqual(expect.arrayContaining(["fit", "help", "view:graph", "view:list", "filter:attention"]));
    expect(menu.some((id) => id.startsWith("action:"))).toBe(false);
  });

  test("dado a ajuda, então lista todo comando com atalho, escritos para a tela, sem repetir comando", () => {
    const { commands } = build();
    const help = commands.help(ctx());
    expect(new Set(ids(help)).size).toBe(help.length);
    expect(help.find((e) => e.id === "palette")?.shortcuts.map(chordLabel)).toEqual(["Ctrl+K", "/"]);
    expect(help.find((e) => e.id === "close")?.shortcuts.map(chordLabel)).toEqual(["Esc"]);
    expect(ids(help)).toEqual(expect.arrayContaining(["palette", "next", "prev", "open", "close", "fit", "toggle-view", "help", "undo", "redo"]));
  });

  test("dado um comando escolhido nas listas, então run chama o gancho da página", () => {
    const { commands } = build();
    calls.length = 0;
    for (const id of ["fit", "help", "view:list", "filter:stalled", "action:prompt", "palette", "close"]) commands.get(id)?.run(ctx());
    expect(calls).toEqual(["fit", "help", "view:list", "filter:stalled", "action:prompt", "palette", "close"]);
  });
});

describe("argos: forma e estado do nó (L3)", () => {
  test("dado cada tipo do registro, então a forma é uma só por tipo (não depende de cor)", () => {
    const shapes = ["unit", "agent", "pr", "gate"].map((type) => typeLook(type).shape);
    expect(new Set(shapes).size).toBe(4);
    expect(build().types.list().map((def) => def.type)).toEqual(["unit", "agent", "pr", "gate"]);
  });

  test("dado um tipo que o registro não tem, então forma neutra e o próprio nome", () => {
    expect(typeLook("nota")).toEqual({ type: "nota", label: "nota", icon: "CircleHelp", shape: "square" });
  });

  test("dado estado novo do servidor, então aparece com a própria palavra e tom neutro (não some nem vira outro)", () => {
    expect(stateLook("hibernando")).toEqual({ tone: "muted", icon: "CircleHelp", word: "hibernando" });
  });

  test("dado cada estado, então o ícone diz o que o tom diz (estados de mesmo tom têm ícones diferentes)", () => {
    const states = ["working", "blocked", "idle", "done", "archived", "fora", "unknown", "planned", "open", "merged", "closed", "running", "waiting"];
    const byTone = new Map<string, string[]>();
    for (const state of states) {
      const look = stateLook(state);
      byTone.set(look.tone, [...(byTone.get(look.tone) ?? []), look.icon]);
    }
    for (const icons of byTone.values()) expect(new Set(icons).size).toBe(icons.length);
  });

  test("dado pede você ou parado, então vale mais que o estado", () => {
    expect(stateLook("working", "attention")).toMatchObject({ tone: "warn", icon: "Hand" });
    expect(stateLook("working", "stalled")).toMatchObject({ tone: "bad", icon: "Clock" });
    expect(stateLook("working", "normal").tone).toBe("vivo");
  });

  test.each<[Shape, number]>([["square", 4], ["diamond", 4], ["hexagon", 6], ["circle", 16]])("dado a forma %s, então %i vértices dentro do retângulo", (shape, count) => {
    const points = shapePoints(shape, 10, 20, 200, 66);
    expect(points).toHaveLength(count);
    for (const [px, py] of points) {
      expect(px).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(px).toBeLessThanOrEqual(210 + 1e-9);
      expect(py).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(py).toBeLessThanOrEqual(86 + 1e-9);
    }
  });
});

describe("argos: indicadores no nó (T1, T2)", () => {
  const agent = (over: Partial<IndicatorNode> = {}): IndicatorNode => ({ type: "agent", state: "working", ...over });
  const kinds = (node: IndicatorNode) => nodeIndicators(node).map((i) => i.kind);

  test("dado nó sem nenhum dado extra, então nenhum indicador", () => {
    expect(nodeIndicators(agent())).toEqual([]);
    expect(nodeIndicators({ type: "unit", state: "planned" })).toEqual([]);
  });

  test("dado tudo junto, então a ordem é a do que pede o dono primeiro", () => {
    const all = agent({ pendingPermission: { tool: "Bash" }, openQuestions: 2, ctxOver: { usedK: 320, capK: 200 }, gate: "failed", ci: { passing: 1, failing: 1, pending: 0 }, pr: 12, costUsd: 3, estimateUsd: 2, herdrState: "idle", closedOnDone: true });
    expect(kinds(all)).toEqual(["permission", "question", "context", "gate", "ci", "pr", "cost", "herdr", "closed"]);
  });

  test("dado contexto acima do teto, então o chip diz usado e teto; sem o campo ou com valor inválido, nenhum chip", () => {
    expect(nodeIndicators(agent({ ctxOver: { usedK: 320, capK: 200 } }))[0]).toMatchObject({ kind: "context", tone: "warn", short: "320k", label: "Contexto em 320k, acima do teto do papel (200k): estacionar" });
    expect(kinds(agent({ ctxOver: null }))).toEqual([]);
    expect(kinds(agent({ ctxOver: { usedK: Number.NaN, capK: 200 } }))).toEqual([]);
  });

  test("dado permissão pendente, então diz a ferramenta; sem ferramenta, só o pedido", () => {
    expect(nodeIndicators(agent({ pendingPermission: { tool: "Bash" } }))[0]).toMatchObject({ kind: "permission", tone: "warn", label: "Pede permissão para Bash" });
    expect(nodeIndicators(agent({ pendingPermission: { tool: null } }))[0]?.label).toBe("Pede permissão");
  });

  test("dado perguntas abertas, então a contagem e o plural; zero e lixo não mostram", () => {
    expect(nodeIndicators(agent({ openQuestions: 1 }))[0]).toMatchObject({ short: "1", label: "1 pergunta aberta para o dono" });
    expect(nodeIndicators(agent({ openQuestions: 3 }))[0]?.label).toBe("3 perguntas abertas para o dono");
    expect(kinds(agent({ openQuestions: 0 }))).toEqual([]);
    expect(kinds(agent({ openQuestions: Number.NaN }))).toEqual([]);
  });

  test.each([["running", "vivo"], ["waiting", "info"], ["failed", "bad"]])("dado gate %s, então o tom %s", (gate, tone) => {
    expect(nodeIndicators(agent({ gate }))[0]).toMatchObject({ kind: "gate", tone });
  });

  test("dado gate com valor que o servidor não conhece, então nenhum indicador (não inventa estado)", () => {
    expect(kinds(agent({ gate: "pausado" }))).toEqual([]);
  });

  test("dado o CI, então falhou vale mais que pendente, que vale mais que passou; sem checks, nada", () => {
    expect(ciVerdict({ passing: 3, failing: 1, pending: 2 })).toBe("failed");
    expect(ciVerdict({ passing: 3, failing: 0, pending: 2 })).toBe("running");
    expect(ciVerdict({ passing: 3, failing: 0, pending: 0 })).toBe("passed");
    expect(ciVerdict({ passing: 0, failing: 0, pending: 0 })).toBeUndefined();
    expect(ciVerdict(null)).toBeUndefined();
    expect(nodeIndicators({ type: "pr", state: "open", ci: { passing: 0, failing: 2, pending: 0 } })[0]).toMatchObject({ kind: "ci", tone: "bad", label: expect.stringContaining("2 falhando") });
  });

  test("dado o número da PR, então mostra #n; zero, negativo ou fracionado não mostra", () => {
    expect(nodeIndicators(agent({ pr: 12 }))[0]).toMatchObject({ kind: "pr", short: "#12" });
    for (const pr of [0, -1, 1.5]) expect(kinds(agent({ pr }))).toEqual([]);
  });

  test("dado custo e estimado, então o tom sobe em 100% e em 150% do estimado (limites da Moirai)", () => {
    const tone = (costUsd: number) => nodeIndicators(agent({ costUsd, estimateUsd: 2 }))[0]?.tone;
    expect([tone(0.5), tone(1.99), tone(2), tone(2.99), tone(3), tone(9)]).toEqual(["muted", "muted", "warn", "warn", "bad", "bad"]);
    expect(nodeIndicators(agent({ costUsd: 3.1, estimateUsd: 5.21 }))[0]).toMatchObject({ short: "$3.1/5.2", label: "Custo US$ 3,10 de US$ 5,21 estimados (60%)" });
  });

  test("dado custo sem estimado (ou estimado zero), então só o custo, em tom neutro; custo zero ainda é dado", () => {
    expect(nodeIndicators(agent({ costUsd: 4 }))[0]).toMatchObject({ short: "$4.0", tone: "muted", label: "Custo US$ 4,00, sem estimativa" });
    expect(nodeIndicators(agent({ costUsd: 4, estimateUsd: 0 }))[0]?.short).toBe("$4.0");
    expect(nodeIndicators(agent({ costUsd: 0 }))[0]?.short).toBe("$0.00");
    expect(costPct(4, 0)).toBeNull();
    expect(kinds(agent({ costUsd: -1 }))).toEqual([]);
    expect(kinds(agent({ costUsd: null }))).toEqual([]);
  });

  test.each([[0.004, "0.00"], [0.42, "0.42"], [0.99, "0.99"], [1, "1.0"], [9.94, "9.9"], [12.4, "12"], [150.6, "151"]])("dado US$ %f, então %s", (usd, out) => {
    expect(usdShort(usd)).toBe(out);
  });

  test("dado o herdr igual ao estado, então sem chip; divergindo, mostra; fora do herdr nunca (o estado já diz)", () => {
    expect(kinds(agent({ herdrState: "working" }))).toEqual([]);
    expect(nodeIndicators(agent({ state: "done", herdrState: "working" }))[0]).toMatchObject({ kind: "herdr", label: "No herdr: trabalhando" });
    expect(kinds(agent({ state: "done", herdrState: "fora" }))).toEqual([]);
    expect(kinds({ type: "gate", state: "running", herdrState: "idle" })).toEqual([]);
  });

  test("dado agente fechado ao concluir, então o chip informativo aparece; em nó que não é agente ou sem a marca, não", () => {
    expect(nodeIndicators(agent({ state: "done", closedOnDone: true }))).toEqual([
      { kind: "closed", icon: "DoorClosed", tone: "muted", short: "fechado", label: "Fechado ao concluir" },
    ]);
    expect(kinds(agent({ state: "done", closedOnDone: false }))).toEqual([]);
    expect(kinds({ type: "gate", state: "done", closedOnDone: true })).toEqual([]);
  });

  test("dado pouco espaço, então cabem os mais importantes e o resto vira contagem; ao menos um cabe com a contagem", () => {
    const list = nodeIndicators(agent({ pendingPermission: { tool: null }, openQuestions: 2, gate: "waiting", pr: 123, costUsd: 3, estimateUsd: 4 }));
    expect(fitIndicators(list, 1000)).toEqual({ shown: list, hidden: 0 });
    const narrow = fitIndicators(list, 120);
    expect(narrow.shown.map((i) => i.kind)).toEqual(list.slice(0, narrow.shown.length).map((i) => i.kind));
    expect(narrow.hidden).toBe(list.length - narrow.shown.length);
    expect(narrow.hidden).toBeGreaterThan(0);
    expect(fitIndicators(list, 0)).toEqual({ shown: [], hidden: list.length });
    expect(fitIndicators([], 100)).toEqual({ shown: [], hidden: 0 });
  });
});
