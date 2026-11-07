/// <reference path="../../../kit/panel/ui/argos/logic.tsx" />
// Regra pura da página Argos (kit/panel/ui/argos/logic.tsx): layout estável, filtros, atalhos, ações e confirmação.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Script, createContext } from "node:vm";
import { CANVAS_UI_BUNDLE, CANVAS_UI_MODULES, createCanvasModuleBundler, createUiTranspiler } from "../../../src/panel/ui-transpile";
import "../../../kit/panel/ui/argos/logic.tsx";

const L = (globalThis as unknown as { ArgosLogic: ArgosLogicApi }).ArgosLogic;
const NOW = Date.parse("2026-10-28T21:00:00.000Z");
const iso = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString();

const node = (id: string, type: string, extra: Partial<ArgosNode> = {}): ArgosNode => ({
  id, type, label: id.split(":").pop() as string, role: null, state: "idle", lastEventTs: iso(1), pendingPermission: null, registry: "o__r", ...extra,
});
const agent = (name: string, extra: Partial<ArgosNode> = {}): ArgosNode => node(`agent:o__r:${name}`, "agent", { role: "impl", ...extra });
const ALL: ArgosFilters = { registry: "all", role: "all", state: "all" };

describe("filtros", () => {
  const graph: ArgosGraph = {
    v: 1,
    nodes: [
      agent("a", { state: "blocked", pendingPermission: { ts: iso(1), tool: "Bash" } }),
      agent("b", { state: "working", lastEventTs: iso(30), role: "review" }),
      agent("c", { state: "working", lastEventTs: iso(2) }),
      agent("d", { state: "done" }),
      agent("s", { registry: "_skill", state: "idle" }),
      node("pr:o__r:7", "pr"), node("pr:o__r:8", "pr"), node("gate:9", "gate", { registry: undefined, state: "running" }),
      node("unit:o__r:u", "unit", { state: "planned" }),
      { ...node("zzz:1", "novo-tipo-futuro"), },
    ],
    edges: [
      { from: "agent:o__r:a", to: "pr:o__r:7", kind: "agent_pr" }, { from: "agent:o__r:d", to: "pr:o__r:8", kind: "agent_pr" },
      { from: "agent:o__r:b", to: "gate:9", kind: "agent_gate" }, { from: "agent:o__r:a", to: "agent:o__r:b", kind: "inventado" },
    ],
  };
  const ids = (f: ArgosFilters) => L.filterGraph(graph, f, NOW).nodes.map((n) => n.id).sort();

  test("sem filtro mostra tudo que conhece e ignora tipo desconhecido", () => {
    expect(ids(ALL)).not.toContain("zzz:1");
    expect(ids(ALL)).toHaveLength(9);
  });
  test("estado 'ativos' esconde concluído e arquivado, e o que só se liga a eles", () => {
    expect(ids({ ...ALL, state: "active" })).toEqual(["agent:o__r:a", "agent:o__r:b", "agent:o__r:c", "agent:o__r:s", "gate:9", "pr:o__r:7"]);
    expect(L.matchesState(agent("x", { state: "archived" }), "active", NOW)).toBe(false);
    expect(L.matchesState(agent("x", { state: "unknown" }), "active", NOW)).toBe(true);
  });
  test("estado 'pedem você' pega permissão pendente e herdr blocked, com o que se liga a eles", () => {
    expect(ids({ ...ALL, state: "attention" })).toEqual(["agent:o__r:a", "pr:o__r:7"]);
  });
  test("estado 'parados' é trabalhando sem evento há mais de 10 min", () => {
    expect(ids({ ...ALL, state: "stalled" })).toEqual(["agent:o__r:b", "gate:9"]);
    expect(L.isStalled(agent("x", { state: "idle", lastEventTs: iso(60) }), NOW)).toBe(false);
    expect(L.isStalled(agent("x", { state: "working", lastEventTs: null }), NOW)).toBe(false);
  });
  test("raiz _skill deixa só o que é dela", () => {
    expect(ids({ ...ALL, registry: "_skill" })).toEqual(["agent:o__r:s", "gate:9"]);
  });
  test("papel filtra agentes", () => {
    expect(ids({ ...ALL, role: "review" })).toEqual(["agent:o__r:b", "gate:9"]);
  });
  test("aresta com ponta escondida some, e kind desconhecido nunca entra", () => {
    const g = L.filterGraph(graph, { ...ALL, state: "attention" }, NOW);
    expect(g.edges).toEqual([{ from: "agent:o__r:a", to: "pr:o__r:7", kind: "agent_pr" }]);
  });
  test("opções de filtro vêm do grafo, ordenadas", () => {
    expect(L.filterOptions(graph)).toEqual({ registries: ["_skill", "o__r"], roles: ["impl", "review"] });
  });
  test("severity: permissão e blocked pedem você; parado vem depois", () => {
    expect(L.severity(agent("a", { state: "blocked" }), NOW)).toBe("attention");
    expect(L.severity(agent("a", { pendingPermission: { ts: iso(0), tool: null } }), NOW)).toBe("attention");
    expect(L.severity(agent("b", { state: "working", lastEventTs: iso(30) }), NOW)).toBe("stalled");
    expect(L.severity(agent("c"), NOW)).toBe("normal");
  });
});

describe("ações e confirmação", () => {
  const a = agent("fin", { label: "fin" });
  const act = (id: string) => L.ACTIONS.find((x) => x.id === id) as ArgosAction;

  test("só as destrutivas pedem o nome digitado", () => {
    const need = L.ACTIONS.filter((x) => L.needsConfirm(x.id)).map((x) => x.id);
    expect(need).toEqual(["done"]);
    expect(L.needsConfirm("approve_permission")).toBe(false);
    expect(L.needsConfirm("inexistente")).toBe(false);
  });
  test("confirmação exige o nome exato, sem aparar espaço nem ignorar caixa", () => {
    expect(L.confirmMatches("fin", a)).toBe(true);
    expect(L.confirmMatches("Fin", a)).toBe(false);
    expect(L.confirmMatches("fin ", a)).toBe(false);
    expect(L.confirmMatches("", a)).toBe(false);
  });
  test("com digitar o nome desligado, confirmMatches aceita qualquer texto", () => {
    expect(L.confirmMatches("", a, false)).toBe(true);
    expect(L.confirmMatches("", a, true)).toBe(false);
  });
  test("corpo leva confirm só na destrutiva", () => {
    expect(L.buildBody(a, act("done"), { keepPane: true }, "fin")).toEqual({ node: a.id, action: "done", args: { keepPane: true }, confirm: "fin" });
    expect(L.buildBody(a, act("prompt"), {}, "lixo")).toEqual({ node: a.id, action: "prompt", args: {} });
  });
  test("aprovar e negar só existem com permissão pendente; responder só com pergunta aberta", () => {
    const ids = (n: ArgosNode, d?: ArgosDetail) => L.availableActions(n, d).map((x) => x.id);
    expect(ids(a)).not.toContain("approve_permission");
    expect(ids(a)).not.toContain("answer");
    expect(ids(agent("p", { pendingPermission: { ts: iso(0), tool: "Bash" } }))).toEqual(expect.arrayContaining(["approve_permission", "deny_permission"]));
    expect(ids(a, { files: { questions: { openQuestions: ["Q2 — dúvida"] } } })).toContain("answer");
    expect(L.availableActions(node("pr:o__r:1", "pr"), undefined)).toEqual([]);
    expect(L.availableActions(null, undefined)).toEqual([]);
    expect(L.questionIds({ files: { questions: { openQuestions: ["Q2 — x", "sem número", "Q10 — y"] } } })).toEqual(["Q2", "Q10"]);
  });
  test("validação: obrigatório, tamanho, formato e opção; vazio opcional não vai no corpo", () => {
    expect(L.validateArgs(act("prompt"), { text: "  " })).toEqual({ ok: true, args: {} });
    expect(L.validateArgs(act("free_prompt"), { text: "" })).toMatchObject({ ok: false, field: "text" });
    expect(L.validateArgs(act("phase"), { phase: "a/b" })).toMatchObject({ ok: false, field: "phase" });
    expect(L.validateArgs(act("phase"), { phase: "x".repeat(41) })).toMatchObject({ ok: false, field: "phase" });
    expect(L.validateArgs(act("phase"), { phase: "entrega 2", text: "ok" })).toEqual({ ok: true, args: { phase: "entrega 2", text: "ok" } });
    expect(L.validateArgs(act("escalate"), { reason: "x".repeat(401) })).toMatchObject({ ok: false, field: "reason" });
    expect(L.validateArgs(act("answer"), { question: "Q1; rm", reply: "r" })).toMatchObject({ ok: false, field: "question" });
    expect(L.validateArgs(act("keys"), { keys: "Ctrl+Z" })).toMatchObject({ ok: false, field: "keys" });
    expect(L.validateArgs(act("keys"), { keys: "Enter" })).toEqual({ ok: true, args: { keys: ["Enter"] } });
    expect(L.validateArgs(act("done"), { keepPane: true })).toEqual({ ok: true, args: { keepPane: true } });
    expect(L.validateArgs(act("done"), {})).toEqual({ ok: true, args: {} });
  });
  test("erro: ramifica pelo código; código novo cai na mensagem do servidor", () => {
    expect(L.errorText("permission_not_pending", "x")).toContain("pendente");
    expect(L.errorText("codigo_do_futuro", "msg do servidor")).toBe("msg do servidor");
    expect(L.errorText("canvas_mass_removal", "x")).toContain("nada foi gravado");
    expect(L.errorText("canvas_mass_removal", "x")).toContain("apague de novo");
    expect(L.errorText(undefined, "rede caiu")).toBe("rede caiu");
    expect(L.errorText("constructor", "fallback")).toBe("fallback");
  });
});

describe("faixa do tempo", () => {
  const ev = (ts: string, kind = "tool_pre", summary = "x"): ArgosEvent => ({ ts, kind, summary, session: "s" });
  test("junta histórico e ao vivo sem duplicar, em ordem de tempo", () => {
    const h = [ev("2026-10-28T21:00:01Z"), ev("2026-10-28T21:00:03Z")];
    const out = L.mergeEvents(h, [ev("2026-10-28T21:00:03Z"), ev("2026-10-28T21:00:02Z", "stop")]);
    expect(out.map((e) => e.ts)).toEqual(["2026-10-28T21:00:01Z", "2026-10-28T21:00:02Z", "2026-10-28T21:00:03Z"]);
  });
  test("guarda só os últimos `cap` eventos", () => {
    const many = Array.from({ length: 10 }, (_, i) => ev(`2026-10-28T21:00:0${i}Z`, "tool_pre", String(i)));
    expect(L.mergeEvents(many, [], 3).map((e) => e.summary)).toEqual(["7", "8", "9"]);
  });
  test("tom: barrado é ruim, permissão é aviso, fim de turno é ok", () => {
    expect([L.eventTone(ev("t", "tool_blocked")), L.eventTone(ev("t", "permission")), L.eventTone(ev("t", "stop")), L.eventTone(ev("t", "tool_pre"))]).toEqual(["bad", "warn", "ok", "idle"]);
  });
});

describe("navegação e paleta", () => {
  test("j/k circulam pela ordem dada; sem seleção começa pelo primeiro ou último", () => {
    const order = [agent("a"), agent("b"), node("pr:o__r:7", "pr")];
    expect(L.neighbor(order, null, 1)).toBe("agent:o__r:a");
    expect(L.neighbor(order, null, -1)).toBe("pr:o__r:7");
    expect(L.neighbor(order, "pr:o__r:7", 1)).toBe("agent:o__r:a");
    expect(L.neighbor(order, "agent:o__r:a", -1)).toBe("pr:o__r:7");
    expect(L.neighbor([], "x", 1)).toBeNull();
  });
  test("paleta: ação do nó vem antes de 'Ir para o nó', e os demais comandos do registro depois", () => {
    const commands = [
      { id: "fit", label: "Enquadrar o canvas", hint: "", group: "Vista" },
      { id: "action:approve_permission", label: "Aprovar permissão · fin", hint: "aprova", group: L.ACTION_GROUP },
    ];
    const items = L.paletteItems({ order: [agent("fin"), agent("outro")], commands });
    expect(items.map((i) => i.id)).toEqual(["action:approve_permission", "node:agent:o__r:fin", "node:agent:o__r:outro", "fit"]);
    expect(items[0]?.run).toEqual({ type: "command", value: "action:approve_permission" });
    expect(items[1]?.run).toEqual({ type: "select", value: "agent:o__r:fin" });
  });
  test("paleta: busca por todos os termos, vazio devolve tudo, sem resultado devolve nada", () => {
    const items = L.paletteItems({ order: [agent("fin"), agent("outro")], commands: [{ id: "action:approve_permission", label: "Aprovar permissão · fin", hint: "aprova", group: L.ACTION_GROUP }] });
    expect(L.filterPalette(items, "")).toHaveLength(items.length);
    expect(L.filterPalette(items, "aprovar fin").map((i) => i.id)).toEqual(["action:approve_permission"]);
    expect(L.filterPalette(items, "outro").map((i) => i.run.type)).toEqual(["select"]);
    expect(L.filterPalette(items, "zzzz-nada")).toEqual([]);
  });
  test("paleta (issue 5): a página acha-se pelo que faz, sem acento, e o grupo Painel traz as páginas", () => {
    const panel = L.panelItems({ nav: [{ id: "thanatos", label: "Thanatos", desc: "Post-mortems de incidentes" }, { id: "remote", label: "Acesso remoto", desc: "Abrir o painel fora da máquina pelo túnel" }, { id: "x", label: "Sem desc" }], frozen: false, dark: false });
    const items = L.paletteItems({ order: [agent("fin")], commands: [], panel });
    expect(L.filterPalette(items, "post-mortem").map((i) => i.id)).toEqual(["panel:go:thanatos"]);
    expect(L.filterPalette(items, "tunel").map((i) => i.id)).toEqual(["panel:go:remote"]);
    expect(L.filterPalette(items, "MÁQUINA").map((i) => i.id)).toEqual(["panel:go:remote"]);
    expect(panel.find((i) => i.id === "panel:go:x")?.hint).toBe("página do painel");
  });
  test("tour (issue 9): o grupo Painel só traz 'Tour desta página' quando a página tem tour", () => {
    const nav = [{ id: "thanatos", label: "Thanatos" }];
    expect(L.panelItems({ nav, frozen: false, dark: false }).some((i) => i.id === "panel:tour")).toBe(false);
    const withTour = L.panelItems({ nav, frozen: false, dark: false, tour: true }).find((i) => i.id === "panel:tour");
    expect(withTour).toMatchObject({ label: "Tour desta página", group: L.PANEL_GROUP, run: { type: "panel", value: L.PANEL_TOUR } });
    expect(L.filterPalette(L.paletteItems({ order: [], commands: [], panel: L.panelItems({ nav, frozen: false, dark: false, tour: true }) }), "tour").map((i) => i.id)).toEqual(["panel:tour"]);
  });
});

describe("leitura do grafo: ênfase", () => {
  const ids = ["a", "b", "c", "d"];
  test("busca com achado vence a vizinhança: achados inteiros, o resto esmaecido", () => {
    const hood = { active: true, levels: [["a"], ["b"], ["c"]], dimmed: ["d"] };
    expect([...(L.emphasisFor(hood, ["c"], ids) ?? [])]).toEqual([["a", 0.15], ["b", 0.15], ["d", 0.15]]);
  });
  test("busca sem achado não apaga nada: vale a vizinhança", () => {
    const hood = { active: true, levels: [["a"], ["b"], ["c"]], dimmed: ["d"] };
    const alpha = L.emphasisFor(hood, [], ids);
    expect(alpha?.get("c")).toBe(L.EMPHASIS_ALPHA.second);
    expect(alpha?.get("d")).toBe(L.EMPHASIS_ALPHA.dimmed);
    expect(alpha?.has("a")).toBe(false);
    expect(alpha?.has("b")).toBe(false);
  });
  test("sem foco nem busca devolve null (tudo normal)", () => {
    expect(L.emphasisFor(null, null, ids)).toBeNull();
    expect(L.emphasisFor({ active: false, levels: [[], [], []], dimmed: [] }, null, ids)).toBeNull();
  });
});

describe("leitura do grafo: nós para filtro e busca", () => {
  test("custo só entra quando é número finito; raiz vazia vira null", () => {
    const rows = L.filterNodes([agent("a", { costUsd: 1.5 }), agent("b", { costUsd: Number.NaN, registry: "" }), agent("c")]);
    expect(rows.map((r) => r.costUsd)).toEqual([1.5, null, null]);
    expect(rows[1]?.registry).toBeNull();
  });
  test("busca indexa só nó com caixa no canvas, com card, PR inteiro, branch e arquivos", () => {
    const nodes = [agent("a", { card: "C-1", number: 7, branch: "feat/x", files: ["src/a.ts", { path: "src/b.ts" }, 3, { nada: 1 }] }), agent("sem-caixa")];
    const items = L.searchItems(nodes, [{ id: "agent:o__r:a", x: 1, y: 2, w: 3, h: 4 }]);
    expect(items).toEqual([{ id: "agent:o__r:a", x: 1, y: 2, w: 3, h: 4, label: "a", card: "C-1", number: 7, branch: "feat/x", files: ["src/a.ts", "src/b.ts"] }]);
  });
  test("arquivos do nó param no teto de SEARCH_FILES_MAX; número não inteiro não vira PR", () => {
    const files = Array.from({ length: L.SEARCH_FILES_MAX + 5 }, (_, i) => `f${i}`);
    const [item] = L.searchItems([agent("a", { files, number: 7.5 })], [{ id: "agent:o__r:a", x: 0, y: 0, w: 1, h: 1 }]);
    expect(item?.files).toHaveLength(L.SEARCH_FILES_MAX);
    expect(item?.number).toBeNull();
  });
});

describe("leitura do grafo: forças", () => {
  test("vizinhos dos dois lados, sem laço no próprio nó", () => {
    const map = L.neighborMap([{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "c" }]);
    expect(Object.fromEntries(map)).toEqual({ a: ["b"], b: ["a", "c"], c: ["b"] });
    expect(L.neighborMap([]).size).toBe(0);
  });
  test("withPositions troca só quem saiu do lugar e não muda a lista recebida", () => {
    const nodes = [{ id: "a", x: 0, y: 0, w: 1, h: 1 }, { id: "b", x: 5, y: 5, w: 1, h: 1 }];
    const out = L.withPositions(nodes, [{ id: "a", x: 9, y: 8 }, { id: "b", x: 5, y: 5 }, { id: "fora", x: 1, y: 1 }]);
    expect(out[0]).toEqual({ id: "a", x: 9, y: 8, w: 1, h: 1 });
    expect(out[1]).toBe(nodes[1] as (typeof nodes)[number]);
    expect(nodes[0]).toEqual({ id: "a", x: 0, y: 0, w: 1, h: 1 });
  });
  test("changedPlacements descarta nó parado e nó que não existe", () => {
    const nodes = [{ id: "a", x: 0, y: 0, w: 1, h: 1 }, { id: "b", x: 5, y: 5, w: 1, h: 1 }];
    expect(L.changedPlacements(nodes, [{ id: "a", x: 1, y: 0 }, { id: "b", x: 5, y: 5 }, { id: "fora", x: 1, y: 1 }])).toEqual([{ id: "a", x: 1, y: 0 }]);
    expect(L.changedPlacements([], [])).toEqual([]);
  });
  test("movedIds lê o move solto e os moves de um lote; outros gestos não movem", () => {
    expect(L.movedIds({ kind: "move", id: "a" })).toEqual(["a"]);
    expect(L.movedIds({ kind: "batch", ops: [{ kind: "move", id: "a" }, { kind: "resize", id: "b" }, { kind: "move", id: "c" }] })).toEqual(["a", "c"]);
    expect(L.movedIds({ kind: "resize", id: "a" })).toEqual([]);
  });
  test("sliceSteps: sem medida um passo; pelo custo medido; nunca menos de 1 nem mais que o teto", () => {
    expect(L.sliceSteps(null, 8)).toBe(1);
    expect(L.sliceSteps(0, 8)).toBe(1);
    expect(L.sliceSteps(Number.NaN, 8)).toBe(1);
    expect(L.sliceSteps(2, 8)).toBe(4);
    expect(L.sliceSteps(3, 8)).toBe(2);
    expect(L.sliceSteps(100, 8)).toBe(1);
    expect(L.sliceSteps(0.0001, 8)).toBe(L.SLICE_STEPS_MAX);
  });
  test("pins lidos de fora: só ids válidos, sem repetir, até o teto; lixo vira lista vazia", () => {
    expect(L.readPins(["a", "a", 3, "", "com espaço", "b:1"])).toEqual(["a", "b:1"]);
    expect(L.readPins(Array.from({ length: L.PINS_MAX + 3 }, (_, i) => `n${i}`))).toHaveLength(L.PINS_MAX);
    expect(L.readPins(null)).toEqual([]);
    expect(L.readPins({ a: 1 })).toEqual([]);
  });
  test("layout lido de fora: só 'free' ou 'force'; o resto cai no livre", () => {
    expect(L.readLayout("force")).toBe("force");
    expect(L.readLayout("free")).toBe("free");
    expect(L.readLayout("FORCE")).toBe("free");
    expect(L.readLayout(null)).toBe("free");
  });
});

describe("leitura do grafo: busca enquadrada e vistas", () => {
  test("frameBox alarga a caixa em volta do centro até o zoom máximo", () => {
    expect(L.frameBox({ x: 100, y: 100, w: 10, h: 10 }, { w: 800, h: 600 }, 1)).toEqual({ x: -295, y: -195, w: 800, h: 600 });
    expect(L.frameBox({ x: 0, y: 0, w: 2000, h: 1000 }, { w: 800, h: 600 }, 1)).toEqual({ x: 0, y: 0, w: 2000, h: 1000 });
  });
  test("paleta: vistas salvas entram como grupo próprio e rodam como 'view'", () => {
    const items = L.paletteItems({ order: [agent("a")], commands: [], views: [{ name: "Revisão" }] });
    const view = items.find((i) => i.group === "Vistas salvas");
    expect(view?.id).toBe("saved-view:Revisão");
    expect(view?.run).toEqual({ type: "view", value: "Revisão" });
  });
  test("códigos de vista, forças, busca e endereço têm texto; código desconhecido usa o reserva", () => {
    for (const code of ["view_name_taken", "view_limit", "force_diverged", "search_term_too_long", "urlstate_invalid"]) expect(L.errorText(code, "x")).not.toBe("x");
    expect(L.errorText("codigo_que_nao_existe", "reserva")).toBe("reserva");
  });
});

// ---- barra de histórico, controles de câmera e módulos do minimapa/toque (leitura do fonte: a página não roda sem navegador)
describe("canvas: onde ficam os controles", () => {
  const ui = (rel: string): string => readFileSync(join(import.meta.dir, "../../../kit/panel/ui", rel), "utf8");
  const labels = (src: string): string[] => [...src.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1] as string);

  test("parts.tsx não tem mais barra de histórico nem zoom; Desfazer e Refazer moram em canvas-controls", () => {
    for (const gone of ["Desfazer", "Refazer", "Ampliar", "Reduzir", "Enquadrar tudo"]) expect(labels(ui("argos/parts.tsx"))).not.toContain(gone);
    expect(ui("argos/parts.tsx")).not.toContain("zoomBy(");
    expect(ui("argos/canvas-controls.tsx")).toMatch(/Desfazer[\s\S]*Refazer|Refazer[\s\S]*Desfazer/);
  });

  test("os controles de câmera da página ficam em right-2, sem o desvio de right-12", () => {
    const page = ui("pages/argos.tsx");
    const mount = page.slice(page.indexOf("<CC.CanvasControls"), page.indexOf("<CC.CanvasControls") + 400);
    expect(mount).toContain("right-2 ");
    expect(mount).not.toContain("right-12");
  });

  test("o histórico mora no grupo da câmera: a barra solta saiu de parts.tsx", () => {
    expect(ui("argos/parts.tsx")).not.toContain('aria-label="Histórico do canvas"');
    expect(ui("pages/argos.tsx")).toContain("history={{ canUndo, canRedo, onUndo: () => stepHistory('undo'), onRedo: () => stepHistory('redo') }}");
  });

  test("a página passa nodeShape ao canvas, vindo da forma do tipo", () => {
    const page = ui("pages/argos.tsx");
    expect(page).toContain("nodeShape={nodeShape}");
    expect(page).toContain("M.argos.typeLook(n.type).shape");
    expect(ui("argos/parts.tsx")).toContain("nodeShape={nodeShape}");
  });
});

describe("canvas: minimapa e toque chegam ao navegador", () => {
  test("minimap e touch estão na lista de módulos e saem no pacote", async () => {
    expect(CANVAS_UI_MODULES.minimap).toBe("canvas-minimap.ts");
    expect(CANVAS_UI_MODULES.touch).toBe("canvas-touch.ts");
    const js = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const scope: Record<string, unknown> = {};
    new Function("globalThis", js as string)(scope);
    const model = scope.CanvasModel as Record<string, Record<string, unknown>>;
    expect(typeof model.minimap?.minimapView).toBe("function");
    expect(typeof model.touch?.createTouchRecognizer).toBe("function");
  });

  test("o index.html carrega o script do minimapa depois do pacote do modelo e do React", () => {
    const html = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/index.html"), "utf8");
    const at = (src: string): number => html.indexOf(`<script src="${src}"></script>`);
    expect(at("/ui/argos/canvas-minimap.js")).toBeGreaterThan(at("/ui/lib/canvas-model.js"));
    expect(at("/ui/lib/canvas-model.js")).toBeGreaterThan(-1);
    expect(html.match(/canvas-minimap\.js/g)).toHaveLength(1);
  });

  test("o minimapa transpila como script clássico, sem import nem export", () => {
    const js = createUiTranspiler().transpile(join(import.meta.dir, "../../../kit/panel/ui/argos/canvas-minimap.tsx"));
    expect(/^\s*(import|export)\b/m.test(js)).toBe(false);
  });
});

// ---- montagem na página: os scripts reais (commands-canvas, types-user, types-live) sobre os registros do Argos e os
// modelos reais. Cada script roda com um globalThis próprio (o transpilado como o navegador o recebe), sem cache de módulo.
describe("montagem do canvas na página", () => {
  const lib = join(import.meta.dir, "../../../src/lib");
  const ui = (rel: string): string => readFileSync(join(import.meta.dir, "../../../kit/panel/ui", rel), "utf8");
  const transpiler = createUiTranspiler();
  const runScript = (rel: string, scope: Record<string, unknown>): void => {
    new Function("globalThis", "React", transpiler.transpile(join(import.meta.dir, "../../../kit/panel/ui", rel)))(scope, scope.React);
  };
  const MENU_IDS = ["user:edit", "user:duplicate", "user:blur", "user:remove", "user:copy-commands", "user:link-note"];
  const USER_TYPES = ["note", "text", "draw-rect", "draw-ellipse", "draw-arrow", "draw-stroke", "unit-sketch", "band"];
  const LIVE_TYPES = ["portal", "terminal", "tree", "plan", "agent-file", "conversation"];

  interface Model { [key: string]: Record<string, unknown> }
  interface MountedCommand { id: string; surfaces: readonly string[]; group: string; run(ctx: object): unknown }
  interface Mounted {
    types: { has(type: string): boolean; get(type: string): { type: string; live: boolean; menu: readonly string[] } | undefined };
    commands: { get(id: string): MountedCommand | undefined; nodeMenu(type: unknown, ctx: object): { id: string }[]; register(def: object): unknown; checkTypeMenu(def: object): void };
  }
  interface Parts { canvasCommands: object; typesUser: { MENU: Record<string, string> }; typesLive: object }

  const loadModel = async (): Promise<Model> => {
    const js = await createCanvasModuleBundler(lib).bundle(CANVAS_UI_BUNDLE);
    const scope: Record<string, unknown> = {};
    new Function("globalThis", js as string)(scope);
    return scope.CanvasModel as Model;
  };

  const mount = (model: Model) => {
    const scope: Record<string, unknown> = { CanvasModel: model, React: { createElement: () => null } };
    for (const rel of ["argos/commands-canvas.tsx", "argos/types-user.tsx", "argos/types-live.tsx"]) runScript(rel, scope);
    const parts = { canvasCommands: scope.ArgosCanvasCommands, typesUser: scope.ArgosTypesUser, typesLive: scope.ArgosTypesLive } as Parts;
    const argos = model.argos as { createArgosRegistries(deps: object): Mounted };
    const reg = argos.createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null });
    for (const def of L.readingCommandDefs()) reg.commands.register(def);
    const docs = model.doc as { emptyCanvasDoc(): { nodes: object[] } };
    const s = { notes: [] as { level: string; code?: string }[], confirmed: [] as { action: string }[], selection: [] as string[], doc: docs.emptyCanvasDoc() };
    const api = {
      doc: { doc: () => s.doc, selection: () => s.selection, select: (ids: string[]) => { s.selection = ids; }, commit: () => undefined, reveal: () => undefined,
        notify: (n: { level: string; code?: string }) => { s.notes.push(n); } },
      dialogs: { askText: async () => null, choose: async () => null, confirm: async () => false },
      batch: {
        nodes: (ids: string[]) => ids.map((id) => ({ id, type: "agent", label: id.split(":").pop(), state: "idle", registryState: "active", herdrState: "idle", pendingPermission: null })),
        context: () => ({ herdrAvailable: true }), filteredIds: () => [],
        confirm: async (plan: { action: string }) => { s.confirmed.push(plan); return { confirmed: false }; },
        send: async () => [], show: () => undefined,
      },
    };
    const deps = { fetch: () => Promise.reject(new Error("sem rede no teste")), now: () => NOW };
    const report = L.mountCanvasRegistries(reg as never, parts as never, { api, userDeps: deps, liveDeps: deps });
    return { reg, parts, report, s, api, deps };
  };

  test("monta os comandos de organização, os user:* só no node-menu e os tipos do usuário e vivos", async () => {
    const { reg, parts, report } = mount(await loadModel());
    expect(report.refused).toEqual([]);
    for (const id of ["group:create", "align:left", "clip:duplicate", "blur:toggle", "batch:resume"]) expect(reg.commands.get(id)).toBeDefined();
    expect(Object.values(parts.typesUser.MENU).sort()).toEqual([...MENU_IDS].sort());
    for (const id of MENU_IDS) expect(reg.commands.get(id)?.surfaces).toEqual(["node-menu"]);
    for (const type of [...USER_TYPES, ...LIVE_TYPES]) expect(reg.types.get(type)?.live).toBe(false);
    const text = reg.types.get("text");
    expect(reg.commands.nodeMenu(text, { reading: { nodeId: "t1" } }).map((e) => e.id)).toEqual(["user:edit", "user:duplicate", "user:blur", "user:remove"]);
    expect(reg.commands.nodeMenu(text, { reading: { nodeId: null } })).toEqual([]);
  });

  test("o user:* do menu chama o handler da página com o tipo do comando e o nó", async () => {
    const { reg } = mount(await loadModel());
    const calls: [string, string][] = [];
    reg.commands.get("user:link-note")?.run({ reading: { nodeId: "b1" }, handlers: { userMenu: (kind: string, id: string) => calls.push([kind, id]) } });
    expect(calls).toEqual([["linkNote", "b1"]]);
  });

  test("montar de novo sobre os mesmos registros não repete nem lança", async () => {
    const first = mount(await loadModel());
    const again = L.mountCanvasRegistries(first.reg as never, first.parts as never, { api: first.api, userDeps: first.deps, liveDeps: first.deps });
    expect(again.refused).toEqual([]);
  });

  test("comando já tomado por outro id fica de fora no relatório e o resto monta", async () => {
    const model = await loadModel();
    const scope: Record<string, unknown> = { CanvasModel: model, React: { createElement: () => null } };
    for (const rel of ["argos/commands-canvas.tsx", "argos/types-user.tsx", "argos/types-live.tsx"]) runScript(rel, scope);
    const reg = (model.argos as { createArgosRegistries(deps: object): Mounted }).createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null });
    // `user:edit` sem a superfície node-menu: o tipo `text` não passa na conferência do menu
    reg.commands.register({ id: "user:edit", label: "outro", group: "x", surfaces: ["palette"], run: () => undefined });
    const parts = { canvasCommands: scope.ArgosCanvasCommands, typesUser: scope.ArgosTypesUser, typesLive: scope.ArgosTypesLive };
    const deps = { fetch: () => Promise.reject(new Error("sem rede")), now: () => NOW };
    const docs = model.doc as { emptyCanvasDoc(): object };
    const api = { doc: { doc: () => docs.emptyCanvasDoc(), selection: () => [], select: () => undefined, commit: () => undefined, reveal: () => undefined, notify: () => undefined },
      dialogs: { askText: async () => null, choose: async () => null, confirm: async () => false } };
    const report = L.mountCanvasRegistries(reg as never, parts as never, { api, userDeps: deps, liveDeps: deps });
    expect(report.refused).toEqual([{ id: "text", code: "registry_unknown_reference" }]);
    expect(reg.types.has("portal")).toBe(true);
  });

  test("batch:park entra no lote e leva a ação park ao plano", async () => {
    const model = await loadModel();
    const realBatch = model.batch as { planBatch(...args: unknown[]): { action: string } };
    const planned: unknown[] = [];
    // o plano é do modelo real; só se registra a ação que a linha entrega a ele
    const spied: Model = { ...model, batch: { ...realBatch, planBatch: (...args: unknown[]) => { planned.push(args[1]); return realBatch.planBatch(...args); } } };
    const { reg, s } = mount(spied);
    const park = reg.commands.get("batch:park");
    expect(park?.surfaces).toEqual(["palette", "canvas-menu"]);
    s.selection = ["agent:o__r:a", "agent:o__r:b"];
    // os comandos só leem a seleção que está no documento
    s.doc = { ...s.doc, nodes: s.selection.map((id) => ({ id, type: "agent", x: 0, y: 0, w: 10, h: 10, data: {} })) };
    await park?.run({});
    expect(planned).toEqual(["park"]);
    // park está em BATCH_ACTIONS: o plano sai e o dono confirma o lote de park antes de qualquer envio
    expect(s.confirmed.map((p) => p.action)).toEqual(["park"]);
    expect(s.notes).toEqual([]);
  });

  test("onTextChange vira update na pilha e desfazer volta exatamente ao anterior", async () => {
    const model = await loadModel();
    const note = model.note as { createTextNode(doc: object, input: object): { op: object } };
    const history = model.history as { applyOp(doc: object, op: object): object; createHistory(): object };
    const store = model.store as { commitGesture(state: object, op: object): State; stepHistory(state: State, dir: string): State | undefined };
    interface State { doc: { nodes: { id: string; data: Record<string, unknown> }[] }; history: { past: { kind: string }[] } }
    const empty = (model.doc as { emptyCanvasDoc(): object }).emptyCanvasDoc();
    const doc = history.applyOp(empty, note.createTextNode(empty, { id: "t1", x: 0, y: 0, text: "antes", style: "label" }).op) as State["doc"];
    let state = { doc, history: history.createHistory() } as State;
    const failed: (string | undefined)[] = [];
    const host = L.userTextHost(model as never, { doc: () => state.doc as never, commit: (op) => { state = store.commitGesture(state, op as object); }, fail: (code) => failed.push(code) });
    const before = structuredClone(state.doc);

    host.onTextChange("t1", { text: "depois", style: "title" });
    expect(state.doc.nodes[0]?.data).toEqual({ text: "depois", style: "title" });
    expect(state.history.past.at(-1)?.kind).toBe("update");
    state = store.stepHistory(state, "undo") as State;
    expect(state.doc).toEqual(before);

    // texto e estilo iguais aos do documento: nada entra na pilha
    host.onTextChange("t1", { text: "antes", style: "label" });
    expect(state.history.past).toHaveLength(0);
    host.onRemove("t1");
    expect(state.doc.nodes).toEqual([]);
    state = store.stepHistory(state, "undo") as State;
    expect(state.doc).toEqual(before);
    expect(failed).toEqual([]);
  });

  test("texto recusado pelo modelo vai a fail com o código e não entra na pilha", async () => {
    const model = await loadModel();
    const note = model.note as { createTextNode(doc: object, input: object): { op: object } };
    const history = model.history as { applyOp(doc: object, op: object): object };
    const empty = (model.doc as { emptyCanvasDoc(): object }).emptyCanvasDoc();
    const doc = history.applyOp(empty, note.createTextNode(empty, { id: "t1", x: 0, y: 0, text: "a" }).op);
    const committed: unknown[] = [];
    const failed: (string | undefined)[] = [];
    const host = L.userTextHost(model as never, { doc: () => doc as never, commit: (op) => committed.push(op), fail: (code) => failed.push(code) });
    host.onTextChange("t1", { text: "x".repeat(5000), style: "label" });
    host.onTextChange("nao-existe", { text: "b", style: "label" });
    expect(committed).toEqual([]);
    expect(failed[0]).toBe("note_too_large");
    expect(failed).toHaveLength(2);
  });

  test("sem documento carregado o texto não faz nada", () => {
    const committed: unknown[] = [];
    const host = L.userTextHost({ note: { opEditText: () => ({}) }, history: { opDelete: () => ({}) } }, { doc: () => null, commit: (op) => committed.push(op), fail: () => undefined });
    host.onTextChange("t1", { text: "b", style: "label" });
    host.onRemove("t1");
    expect(committed).toEqual([]);
  });

  test("política do portal: a resposta da rota vira a política; forma errada fecha tudo", async () => {
    const model = await loadModel();
    const portal = model.portal as { isHostAllowed(host: string, policy: object): boolean };
    const ok = L.readPortalPolicy({ exact: ["localhost", "127.0.0.1", "[::1]", "grafana.lan"], suffixes: ["exemplo.com"] });
    expect(portal.isHostAllowed("grafana.lan", ok)).toBe(true);
    expect(portal.isHostAllowed("app.exemplo.com", ok)).toBe(true);
    expect(portal.isHostAllowed("outro.net", ok)).toBe(false);
    const closed = [null, "x", {}, { exact: [] }, { exact: ["ok.lan"], suffixes: [1] }, { exact: ["Mal Formado"], suffixes: [] },
      { exact: ["a".repeat(254)], suffixes: [] }, { exact: Array.from({ length: 257 }, (_, i) => `h${i}.lan`), suffixes: [] }];
    for (const raw of closed) {
      const policy = L.readPortalPolicy(raw);
      expect([...policy.exact]).toEqual([]);
      expect(policy.suffixes).toEqual([]);
    }
  });

  test("política vazia não libera nem o loopback (falha fechada até a rota responder)", async () => {
    const model = await loadModel();
    const portal = model.portal as { isHostAllowed(host: string, policy: object): boolean; portalViewOf(node: object, policy: object): { state: string } };
    const empty = L.emptyPortalPolicy();
    expect(portal.isHostAllowed("localhost", empty)).toBe(false);
    expect(portal.portalViewOf({ type: "portal", data: { url: "http://localhost:3000/" } }, empty).state).not.toBe("ready");
  });

  test("a página parte da política vazia e volta a ela em erro ou sem resposta da rota", () => {
    const page = ui("pages/argos.tsx");
    expect(page).toContain("useRef(L.emptyPortalPolicy())");
    expect(page).toContain("get portalPolicy() { return portalPolicy.current; }");
    const fn = page.slice(page.indexOf("async function getPortalPolicy"), page.indexOf("async function sendBatch"));
    expect(fn).toContain("AbortSignal.timeout(PORTAL_POLICY_TIMEOUT_MS)");
    expect(fn.match(/return L\.emptyPortalPolicy\(\);/g)).toHaveLength(2);
  });

  test("a página monta pelos scripts que o index.html carrega antes dela", () => {
    const page = ui("pages/argos.tsx");
    expect(page).toContain("L.mountCanvasRegistries(made, MOUNT_PARTS, { api, userDeps, liveDeps })");
    const html = ui("index.html");
    const at = (src: string): number => html.indexOf(`<script src="${src}"></script>`);
    for (const src of ["/ui/argos/node-terminal.js", "/ui/argos/commands-canvas.js", "/ui/argos/types-user.js", "/ui/argos/types-live.js"]) {
      expect(at(src)).toBeGreaterThan(at("/ui/lib/canvas-model.js"));
      expect(at(src)).toBeLessThan(at("/ui/pages/argos.js"));
    }
  });

  test("o pacote do modelo traz o que os comandos, os tipos e o menu pedem", () => {
    const keys = ["groups", "align", "clipboard", "walk", "next", "batch", "blur", "dock", "export", "note", "draw", "create", "bands", "portal", "conversation", "agentFiles", "actions", "compose"];
    for (const key of keys) expect(Object.keys(CANVAS_UI_MODULES)).toContain(key);
  });
});

// ---- camadas sobre o canvas (canvas-overlays.tsx) montadas na página: a regra pura que a página usa para ligá-las, os
// scripts na ordem do index.html e a forma das props do contrato (reference/argos.md, "Camadas sobre o canvas").
describe("camadas sobre o canvas na página", () => {
  const ui = (rel: string): string => readFileSync(join(import.meta.dir, "../../../kit/panel/ui", rel), "utf8");
  const transpiler = createUiTranspiler();
  const loadModel = async (): Promise<Record<string, Record<string, unknown>>> => {
    const js = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const scope: Record<string, unknown> = {};
    new Function("globalThis", js as string)(scope);
    return scope.CanvasModel as Record<string, Record<string, unknown>>;
  };
  const OVERLAY_SCRIPTS = ["argos/canvas-minimap", "argos/node-permission", "argos/node-balloon", "argos/canvas-menu", "argos/canvas-overlays"];
  const runScripts = (rels: readonly string[], scope: Record<string, unknown>): void => {
    for (const rel of rels) new Function("globalThis", "React", transpiler.transpile(join(import.meta.dir, "../../../kit/panel/ui", `${rel}.tsx`)))(scope, scope.React);
  };
  const openAgent = { id: "agent:o__r:a", type: "agent", label: "a", state: "idle", registryState: "active", herdrState: "idle", pendingPermission: null };
  type MenuAction = Parameters<typeof L.overlayActionRoute>[0];
  const menuActions = async (): Promise<Map<string, MenuAction>> => {
    const actions = (await loadModel()).actions as { actionsFor(node: object, ctx: object): (MenuAction & { key: string })[] };
    return new Map(actions.actionsFor(openAgent, { herdrAvailable: true }).map((item) => [item.key, item]));
  };

  test("dada a ação prompt do menu, quando escolhida, então abre o balão do nó", async () => {
    expect(L.overlayActionRoute((await menuActions()).get("prompt") as MenuAction)).toEqual({ kind: "balloon" });
  });

  test("dada uma ação que o diálogo da página conhece, então a rota é o diálogo com o mesmo id", async () => {
    const items = await menuActions();
    for (const key of ["resume", "approve_permission", "answer", "phase", "free_prompt", "done"]) {
      expect(L.overlayActionRoute(items.get(key) as MenuAction)).toEqual({ kind: "dialog", id: key });
    }
  });

  test("dada estacionar (fora do diálogo da página), então vai direto, com o motivo opcional e sem frase", async () => {
    expect(L.overlayActionRoute((await menuActions()).get("park") as MenuAction)).toEqual({ kind: "direct", textField: { name: "reason", required: false }, confirm: false });
  });

  test("dada uma destrutiva sem campo fora do diálogo, então vai direto pedindo a frase do nome", () => {
    expect(L.overlayActionRoute({ key: "x_destrutiva", dangerous: true, fields: [] })).toEqual({ kind: "direct", textField: null, confirm: true });
  });

  test("dada uma ação cujo campo pede escolha do painel (sessão), então a página não a roda pelo menu", async () => {
    expect(L.overlayActionRoute((await menuActions()).get("stop_session") as MenuAction)).toEqual({ kind: "unsupported" });
    expect(L.overlayActionRoute({ key: "x", dangerous: false, fields: [{ name: "a", required: true, kind: "text" }, { name: "b", required: false, kind: "text" }] })).toEqual({ kind: "unsupported" });
  });

  test("toda ação do menu das camadas tem rota (nenhuma cai em silêncio)", async () => {
    const items = await menuActions();
    expect(items.size).toBeGreaterThan(0);
    for (const item of items.values()) expect(["balloon", "dialog", "direct", "unsupported"]).toContain(L.overlayActionRoute(item).kind);
  });

  test("o tipo do menu tira os comandos action:* (as ações vêm do menu) e põe fixar/soltar depois dos do tipo", () => {
    const agentType = { type: "agent", menu: ["action:resume", "action:prompt"] };
    expect(L.overlayMenuType(agentType, "action:").menu).toEqual([...L.READING_NODE_MENU]);
    const note = { type: "note", menu: ["user:edit", "user:remove"] };
    expect(L.overlayMenuType(note, "action:")).toEqual({ type: "note", menu: ["user:edit", "user:remove", ...L.READING_NODE_MENU] });
    expect(L.overlayMenuType({ type: "t", menu: [...L.READING_NODE_MENU] }, "action:").menu).toEqual([...L.READING_NODE_MENU]);
    expect(note.menu).toEqual(["user:edit", "user:remove"]);
  });

  test("os nós das camadas: o do grafo leva o dado das ações, o do usuário só id, tipo e rótulo, e todos o retângulo", () => {
    const nodes = [{ id: "agent:o__r:a", type: "agent", x: 1, y: 2, w: 3, h: 4 }, { id: "n1", type: "note", x: 5, y: 6, w: 7, h: 8 }];
    const out = L.overlayNodes(nodes, (id) => (id === openAgent.id ? openAgent : null));
    expect(out).toEqual([{ node: openAgent, rect: { x: 1, y: 2, w: 3, h: 4 } }, { node: { id: "n1", type: "note", label: "n1" }, rect: { x: 5, y: 6, w: 7, h: 8 } }]);
    expect(L.overlayNodes([], () => null)).toEqual([]);
  });

  test("o contexto das ações só leva herdrAvailable quando o grafo o diz com booleano", () => {
    expect(L.actionContextOf({ herdr: { available: false } })).toEqual({ herdrAvailable: false });
    expect(L.actionContextOf({ herdr: { available: "sim" } })).toEqual({});
    expect(L.actionContextOf({})).toEqual({});
    expect(L.actionContextOf(null)).toEqual({});
  });

  test("os scripts das camadas carregam na ordem do index.html e publicam CanvasOverlays", async () => {
    const html = ui("index.html");
    const at = (rel: string): number => html.indexOf(`<script src="/ui/${rel}.js"></script>`);
    const order = ["lib/canvas-model", ...OVERLAY_SCRIPTS, "pages/argos"];
    for (const rel of order) expect(at(rel)).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i += 1) expect(at(order[i - 1] as string)).toBeLessThan(at(order[i] as string));
    const scope: Record<string, unknown> = { CanvasModel: await loadModel(), React: { createElement: () => null } };
    runScripts(OVERLAY_SCRIPTS, scope);
    expect(typeof (scope.ArgosCanvasOverlays as { CanvasOverlays?: unknown }).CanvasOverlays).toBe("function");
  });

  test("sem o menu carregado antes, as camadas lançam dizendo o que carregar", async () => {
    const scope: Record<string, unknown> = { CanvasModel: await loadModel(), React: { createElement: () => null } };
    expect(() => runScripts(OVERLAY_SCRIPTS.filter((rel) => rel !== "argos/canvas-menu"), scope)).toThrow(/canvas-menu\.js/);
  });

  test("a página monta CanvasOverlays pelas camadas com câmera e tela do motor e as props do contrato", () => {
    const parts = ui("argos/parts.tsx");
    const layers = parts.slice(parts.indexOf("function CanvasLayers"), parts.indexOf("// vista em lista"));
    expect(layers).toContain("window.ArgosCanvasOverlays.CanvasOverlays");
    expect(layers).toContain("<Overlays camera={frame.camera} view={frame.view} {...layers} />");
    expect(layers).toContain("return api.onFrame(read);");
    const page = ui("pages/argos.tsx");
    const mount = page.slice(page.indexOf("<P.CanvasLayers"), page.indexOf("<CC.CanvasControls"));
    expect(mount).toContain("api={canvasApi} nodes={layerNodes}");
    for (const key of ["target: menu.target", "at: menu.at", "registry: commands", "commandCtx: ctxFor(menu.node)", "actionCtx", "onClose:", "onAction:", "onError:"]) expect(mount).toContain(key);
    for (const key of ["nodeId: balloonId", "drafts", "onDrafts: setDrafts", "doc: cstate.doc", "fetch: tokenFetch", "onSent:"]) expect(mount).toContain(key);
    expect(mount).toContain("permission={{ ctx: actionCtx, fetch: tokenFetch, errorText: L.errorText }}");
    expect(mount).toContain("minimap={desk ? { onCamera: (cam) => canvasApi?.setCamera(cam, false) } : undefined}");
    // o toque é do motor (pan e pinça já vêm dele): a camada de toque ligada junto dobraria o gesto
    expect(mount).not.toContain("touch=");
    expect(page).not.toContain("P.ContextMenu");
  });

  test("o grupo da câmera (com o histórico) sobe acima do minimapa, no mesmo canto", () => {
    const src = ui("pages/argos.tsx");
    const controls = src.slice(src.indexOf("<CC.CanvasControls"), src.indexOf("<CC.CanvasControls") + 400);
    expect(controls).toContain("bottom-[8.5rem]");
  });
});

// ---- carga na ordem do index.html: no navegador os scripts clássicos dividem um escopo global, e uma constante repetida
// em dois arquivos derruba o segundo com SyntaxError antes de rodar (o `new Function` dos testes acima não enxerga isso).
describe("scripts da página num escopo global só", () => {
  const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
  const transpiler = createUiTranspiler({ isolate: [join(uiDir, "argos")] });
  const pageScripts = (): string[] =>
    [...readFileSync(join(uiDir, "index.html"), "utf8").matchAll(/<script src="\/ui\/([^"]+)\.js"><\/script>/g)]
      .map((m) => m[1] as string)
      .filter((rel) => existsSync(join(uiDir, `${rel}.tsx`)));

  test("nenhum script redeclara um nome que outro já pôs no escopo global", () => {
    const rels = pageScripts();
    expect(rels).toContain("argos/canvas-menu");
    const context = createContext({});
    const redeclared: string[] = [];
    for (const rel of rels) {
      try {
        new Script(transpiler.transpile(join(uiDir, `${rel}.tsx`)), { filename: `${rel}.js` }).runInContext(context);
      } catch (err) {
        if ((err as Error)?.name === "SyntaxError") redeclared.push(`${rel}: ${(err as Error).message}`);
      }
    }
    expect(redeclared).toEqual([]);
  });

  test("os scripts de argos/ saem com escopo próprio e os de fora, como estão", () => {
    expect(transpiler.transpile(join(uiDir, "argos/canvas-menu.tsx")).startsWith("(() => {")).toBe(true);
    expect(transpiler.transpile(join(uiDir, "app.tsx"))).toBe(createUiTranspiler().transpile(join(uiDir, "app.tsx")));
  });
});

// ---- painel do nó dentro do canvas (canvas-focus.tsx): transpila isolado, expõe ArgosFocus e se comporta com 0, 1 e vários
// selecionados. Sem DOM: o componente é chamado direto (os ganchos e as peças vizinhas entram como dublês) e a árvore de
// elementos é percorrida.
describe("painel do nó no canvas (ArgosFocus)", () => {
  const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
  type El = { tag: string; props: Record<string, any>; kids: Tree[] };
  type Tree = El | string | number | null | undefined | boolean | Tree[];

  const loadReact = (): { createElement: (...a: any[]) => any } => {
    const mod: { exports: any } = { exports: {} };
    new Function("exports", "module", readFileSync(join(uiDir, "vendor/react.js"), "utf8"))(mod.exports, mod);
    return mod.exports;
  };
  const loadModel = async (): Promise<Record<string, any>> => {
    const js = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const scope: Record<string, unknown> = {};
    new Function("globalThis", js as string)(scope);
    return scope.CanvasModel as Record<string, any>;
  };
  const transpiled = createUiTranspiler({ isolate: [join(uiDir, "argos")] }).transpile(join(uiDir, "argos/canvas-focus.tsx"));

  async function load() {
    const React = loadReact();
    const h = React.createElement;
    // ganchos mínimos: as refs persistem entre as chamadas pela ordem em que são pedidas; os efeitos ficam na fila
    const refs: { current: unknown }[] = [];
    let slot = 0;
    const effects: (() => void)[] = [];
    const HadesCore = {
      useRef: (v: unknown) => (refs[slot] ??= { current: v }, refs[slot++]!),
      useEffect: (fn: () => void) => void effects.push(fn),
      cn: (...a: unknown[]) => a.filter(Boolean).join(" "),
      I: new Proxy({}, { get: (_t, name) => () => h("i", { "data-icon": String(name) }) }),
    };
    const ArgosParts = {
      Forma: ({ shape }: { shape: string }) => h("svg", { "data-shape": shape }),
      Icon: ({ name }: { name: string }) => h("i", { "data-icon": name }),
      TONE_ICON: { vivo: "text-vivo", warn: "text-warn", bad: "text-bad", info: "text-info", muted: "text-muted-foreground" },
      TONE_TEXT: { vivo: "text-foreground", warn: "text-warn", bad: "text-bad", info: "text-info", muted: "text-muted-foreground" },
    };
    const win: Record<string, any> = { CanvasModel: await loadModel(), ArgosParts };
    new Function("window", "HadesCore", "React", transpiled)(win, HadesCore, React);
    const api = win.ArgosFocus as { FocusPanel: (p: Record<string, unknown>) => any; FOCUS_PANEL_WIDTH: string };
    /** Uma renderização: zera a ordem dos ganchos e devolve a árvore; `flush` roda os efeitos dela. */
    const render = (p: Record<string, unknown>) => {
      slot = 0;
      effects.length = 0;
      return { tree: expand(api.FocusPanel(p)), flush: () => effects.forEach((fn) => fn()) };
    };
    return { api, render };
  }

  /** Resolve os componentes de função até restar só elementos de tag. */
  function expand(n: any): Tree {
    if (Array.isArray(n)) return n.map(expand);
    if (n === null || typeof n !== "object" || !("type" in n)) return n;
    if (typeof n.type === "function") return expand(n.type(n.props));
    const { children, ...props } = n.props ?? {};
    return { tag: n.type, props: n.ref ? { ...props, ref: n.ref } : props, kids: [children].flat(Infinity).map(expand) };
  }
  const all = (t: Tree, pred: (e: El) => boolean, out: El[] = []): El[] => {
    if (Array.isArray(t)) t.forEach((x) => all(x, pred, out));
    else if (t && typeof t === "object") {
      if (pred(t)) out.push(t);
      t.kids.forEach((k) => all(k, pred, out));
    }
    return out;
  };
  const text = (t: Tree): string => (Array.isArray(t) ? t.map(text).join("") : t && typeof t === "object" ? t.kids.map(text).join("") : typeof t === "string" || typeof t === "number" ? String(t) : "");
  const nodes = [
    { id: "agent:o__r:a", label: "alfa", type: "agent", state: "working" },
    { id: "pr:o__r:7", label: "PR 7", type: "pr", state: "idle", shape: "diamond" },
    { id: "gate:9", label: "fila", type: "gate" },
  ];
  const props = (extra: Record<string, unknown> = {}) => ({ open: true, nodes: [nodes[0]], primaryId: nodes[0]!.id, onPrimary: () => {}, onToggle: () => {}, children: "SIDE", ...extra });
  const region = (t: Tree) => all(t, (e) => e.props.role === "complementary")[0];
  const chips = (t: Tree) => all(t, (e) => e.tag === "button" && "aria-current" in e.props);
  const chipsAll = (t: Tree) => all(t, (e) => e.tag === "li").map((li) => all(li, (e) => e.tag === "button")[0] as El);
  const press = (key: string) => {
    const calls = { stop: 0, prevent: 0 };
    return { calls, ev: { key, defaultPrevented: false, stopPropagation: () => void calls.stop++, preventDefault: () => void calls.prevent++ } };
  };

  test("o arquivo transpila isolado, com escopo próprio, e expõe ArgosFocus com a largura do painel", async () => {
    expect(transpiled.startsWith("(() => {")).toBe(true);
    const { api } = await load();
    expect(typeof api.FocusPanel).toBe("function");
    expect(api.FOCUS_PANEL_WIDTH).toBe("clamp(20rem, 32%, 28rem)");
  });

  test("sem selecionado, nada é desenhado", async () => {
    const { api } = await load();
    expect(expand(api.FocusPanel(props({ nodes: [] })))).toBeNull();
    expect(expand(api.FocusPanel(props({ nodes: [], open: false })))).toBeNull();
  });

  test("com um selecionado, só o conteúdo do primário (sem faixa), numa região ancorada à direita", async () => {
    const { api } = await load();
    const tree = expand(api.FocusPanel(props()));
    const box = region(tree) as El;
    expect(box.props["aria-label"]).toBeTruthy();
    expect(box.props.style.width).toBe(api.FOCUS_PANEL_WIDTH);
    for (const cls of ["absolute", "inset-y-0", "right-0", "overflow-y-auto", "scrollbar-thin", "bg-card", "border-l"]) expect(box.props.className.split(" ")).toContain(cls);
    expect(text(tree)).toContain("SIDE");
    expect(chips(tree)).toHaveLength(0);
    expect(all(tree, (e) => e.tag === "ul")).toHaveLength(0);
  });

  test("com três, a faixa traz forma, rótulo e estado de cada um, com aria-current só no primário", async () => {
    const { api } = await load();
    const tree = expand(api.FocusPanel(props({ nodes, primaryId: nodes[1]!.id })));
    const list = chipsAll(tree);
    expect(list.map((b) => all(b, (e) => e.tag === "svg")[0]!.props["data-shape"])).toEqual(["circle", "diamond", "hexagon"]);
    expect(list.map((b) => b.props["aria-current"])).toEqual([undefined, "true", undefined]);
    expect(text(list[0])).toContain("alfa");
    expect(text(list[1])).toContain("PR 7");
    expect(text(list[2])).toBe("fila");
    expect(all(list[0] as El, (e) => e.tag === "i")).toHaveLength(1);
    expect(all(list[2] as El, (e) => e.tag === "i")).toHaveLength(0);
    expect(text(tree)).toContain("SIDE");
    expect(text(tree)).toContain("3 selecionados");
  });

  test("clicar num selecionado da faixa torna-o primário; o botão é nativo, então Enter faz o mesmo", async () => {
    const { api } = await load();
    const picked: string[] = [];
    const tree = expand(api.FocusPanel(props({ nodes, onPrimary: (id: string) => picked.push(id) })));
    const list = chipsAll(tree);
    expect(list.every((b) => b.props.type === "button")).toBe(true);
    (list[2]!.props.onClick as () => void)();
    (list[0]!.props.onClick as () => void)();
    expect(picked).toEqual([nodes[2]!.id, nodes[0]!.id]);
  });

  test("fechado, só a alça de expandir, rotulada, que abre o painel", async () => {
    const { api } = await load();
    const toggled: boolean[] = [];
    const tree = expand(api.FocusPanel(props({ open: false, nodes, onToggle: (v: boolean) => toggled.push(v) })));
    expect(region(tree)).toBeUndefined();
    expect(text(tree)).not.toContain("SIDE");
    const buttons = all(tree, (e) => e.tag === "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props["aria-label"]).toMatch(/expandir/i);
    expect(buttons[0]!.props["aria-expanded"]).toBe("false");
    (buttons[0]!.props.onClick as () => void)();
    expect(toggled).toEqual([true]);
  });

  test("aberto, o botão do topo recolhe", async () => {
    const { api } = await load();
    const toggled: boolean[] = [];
    const tree = expand(api.FocusPanel(props({ onToggle: (v: boolean) => toggled.push(v) })));
    const collapse = all(tree, (e) => e.tag === "button" && /recolher/i.test(e.props["aria-label"] ?? ""))[0] as El;
    (collapse.props.onClick as () => void)();
    expect(toggled).toEqual([false]);
  });

  test("Escape dentro do painel recolhe e não propaga; outra tecla passa; filho que já tratou o Escape mantém aberto", async () => {
    const { api } = await load();
    const toggled: boolean[] = [];
    const box = region(expand(api.FocusPanel(props({ onToggle: (v: boolean) => toggled.push(v) })))) as El;
    const esc = press("Escape");
    box.props.onKeyDown(esc.ev);
    expect(toggled).toEqual([false]);
    expect(esc.calls).toEqual({ stop: 1, prevent: 1 });
    const other = press("a");
    box.props.onKeyDown(other.ev);
    expect(toggled).toEqual([false]);
    expect(other.calls).toEqual({ stop: 0, prevent: 0 });
    const handled = press("Escape");
    box.props.onKeyDown({ ...handled.ev, defaultPrevented: true });
    expect(toggled).toEqual([false]);
    expect(handled.calls.stop).toBe(1);
    // Escape de um diálogo em portal (fora do DOM do painel) sobe pela árvore do React e não é do painel
    const portal = press("Escape");
    box.props.onKeyDown({ ...portal.ev, currentTarget: { contains: () => false }, target: {} });
    expect(toggled).toEqual([false]);
    expect(portal.calls.stop).toBe(0);
  });

  test("ponteiro e roda dentro do painel (e da alça) não chegam ao canvas", async () => {
    const { api } = await load();
    const open = region(expand(api.FocusPanel(props()))) as El;
    const closed = all(expand(api.FocusPanel(props({ open: false }))), (e) => e.tag === "button")[0] as El;
    for (const el of [open, closed]) {
      for (const name of ["onPointerDown", "onPointerMove", "onPointerUp", "onPointerCancel", "onWheel"]) {
        let stopped = 0;
        el.props[name]({ stopPropagation: () => void stopped++ });
        expect(stopped, name).toBe(1);
      }
    }
  });

  test("o foco acompanha recolher e expandir feitos pelo painel, e não troca vinda da página", async () => {
    const { render } = await load();
    const focused: string[] = [];
    const spy = (name: string) => ({ focus: () => void focused.push(name) });
    let open = true;
    const p = () => props({ open, onToggle: (v: boolean) => { open = v; } });
    // aberto, recolhido pelo botão do topo: o foco vai para a alça
    let r = render(p());
    (all(r.tree, (e) => e.props["aria-label"] === "Recolher painel do nó")[0]!.props.onClick as () => void)();
    r = render(p());
    (all(r.tree, (e) => e.tag === "button")[0]!.props.ref as { current: unknown }).current = spy("alça");
    r.flush();
    expect(focused).toEqual(["alça"]);
    // fechado, expandido pela alça: o foco vai para a região do painel
    (all(r.tree, (e) => e.tag === "button")[0]!.props.onClick as () => void)();
    r = render(p());
    (region(r.tree)!.props.ref as { current: unknown }).current = spy("painel");
    r.flush();
    expect(focused).toEqual(["alça", "painel"]);
    // a página recolhe (atalho, por exemplo): ninguém pediu foco, então nada se mexe
    open = false;
    r = render(p());
    (all(r.tree, (e) => e.tag === "button")[0]!.props.ref as { current: unknown }).current = spy("alça de novo");
    r.flush();
    expect(focused).toEqual(["alça", "painel"]);
  });
});

// ---- Esconder controles do #/argos (reference/argos.md §Esconder controles): o comando canvas:focus no registro e na tecla, e a página
// sem HUD, toolbar, lista nem gaveta; a gaveta do nó desloca o quadro pela largura dela.
describe("esconder controles: comando canvas:focus", () => {
  const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
  const transpiler = createUiTranspiler();
  interface FocusCommand { id: string; group: string; surfaces: readonly string[]; label: string | ((ctx: object) => string); run(ctx: object): unknown }
  interface FocusRegistry {
    get(id: string): FocusCommand | undefined;
    register(def: object): unknown;
    resolveKey(event: object, state: { editable: boolean; ctx: object }): { id: string } | null;
    palette(ctx: object): { id: string; label: string }[];
    canvasMenu(ctx: object): { id: string }[];
  }

  const mountWithFocus = async (withPort = true) => {
    const js = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const holder: Record<string, unknown> = {};
    new Function("globalThis", js as string)(holder);
    const model = holder.CanvasModel as Record<string, Record<string, unknown>>;
    const scope: Record<string, unknown> = { CanvasModel: model, React: { createElement: () => null } };
    for (const rel of ["argos/commands-canvas.tsx", "argos/types-user.tsx", "argos/types-live.tsx"]) {
      new Function("globalThis", "React", transpiler.transpile(join(uiDir, rel)))(scope, scope.React);
    }
    const parts = { canvasCommands: scope.ArgosCanvasCommands, typesUser: scope.ArgosTypesUser, typesLive: scope.ArgosTypesLive };
    const argos = model.argos as unknown as { createArgosRegistries(deps: object): { commands: FocusRegistry; types: object } };
    const reg = argos.createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null });
    for (const def of L.readingCommandDefs()) reg.commands.register(def);
    const docs = model.doc as unknown as { emptyCanvasDoc(): object };
    const s = { on: false, available: true, calls: [] as boolean[] };
    const api: Record<string, unknown> = {
      doc: { doc: () => docs.emptyCanvasDoc(), selection: () => [], select: () => undefined, commit: () => undefined, reveal: () => undefined, notify: () => undefined },
      dialogs: { askText: async () => null, choose: async () => null, confirm: async () => false },
    };
    if (withPort) api.focus = { enabled: () => s.on, available: () => s.available, setEnabled: (on: boolean) => { s.calls.push(on); s.on = on; } };
    const deps = { fetch: () => Promise.reject(new Error("sem rede no teste")), now: () => NOW };
    const report = L.mountCanvasRegistries(reg as never, parts as never, { api, userDeps: deps, liveDeps: deps });
    return { reg, report, s };
  };
  // o contexto que a página passa aos comandos, na forma mínima que as condições dos outros comandos leem
  const ctx = { selectedLabel: null, availableActions: [], canUndo: false, canRedo: false, handlers: {},
    reading: { layout: "free", running: false, nodeId: null, pinned: false, searching: false, filtering: false } };
  const labelOf = (cmd: FocusCommand | undefined): string => (typeof cmd?.label === "function" ? cmd.label(ctx) : String(cmd?.label));

  test("com a porta focus, registra canvas:focus na paleta e no menu do fundo, sem recusa", async () => {
    const { reg, report } = await mountWithFocus();
    expect(report.refused).toEqual([]);
    const cmd = reg.commands.get("canvas:focus");
    expect(cmd?.surfaces).toEqual(["palette", "canvas-menu"]);
    expect(cmd?.group).toBe("Vista");
    expect(reg.commands.palette(ctx).map((e) => e.id)).toContain("canvas:focus");
    expect(reg.commands.canvasMenu(ctx).map((e) => e.id)).toContain("canvas:focus");
  });

  test("Shift+F alterna esconder controles; o f sozinho segue sendo enquadrar", async () => {
    const { reg, s } = await mountWithFocus();
    const shiftF = { key: "F", shiftKey: true };
    expect(reg.commands.resolveKey(shiftF, { editable: false, ctx })?.id).toBe("canvas:focus");
    expect(reg.commands.resolveKey({ key: "f" }, { editable: false, ctx })?.id).toBe("fit");
    expect(labelOf(reg.commands.get("canvas:focus"))).toBe("Esconder controles");
    reg.commands.get("canvas:focus")?.run(ctx);
    expect(labelOf(reg.commands.get("canvas:focus"))).toBe("Mostrar controles");
    reg.commands.get("canvas:focus")?.run(ctx);
    expect(s.calls).toEqual([true, false]);
    // num campo de texto a letra é do campo
    expect(reg.commands.resolveKey(shiftF, { editable: true, ctx })).toBeNull();
  });

  test("com available falso, a tecla não resolve e o comando some da paleta", async () => {
    const { reg, s } = await mountWithFocus();
    s.available = false;
    expect(reg.commands.resolveKey({ key: "F", shiftKey: true }, { editable: false, ctx })).toBeNull();
    expect(reg.commands.palette(ctx).map((e) => e.id)).not.toContain("canvas:focus");
  });

  test("sem a porta focus, o comando não registra e o Shift+F fica livre", async () => {
    const { reg, report } = await mountWithFocus(false);
    expect(report.refused).toEqual([]);
    expect(reg.commands.get("canvas:focus")).toBeUndefined();
    expect(reg.commands.resolveKey({ key: "F", shiftKey: true }, { editable: false, ctx })).toBeNull();
  });
});

describe("esconder controles na página", () => {
  const ui = (rel: string): string => readFileSync(join(import.meta.dir, "../../../kit/panel/ui", rel), "utf8");
  const page = ui("pages/argos.tsx");

  test("o estado vem do endereço (focus=1) ou da preferência lembrada, e volta ao endereço", () => {
    expect(page).toContain("const STORE_FOCUS = 'hades.argos.focus';");
    expect(page).toContain("urlRead.state.focus === true || readStored(STORE_FOCUS) === true");
    expect(page).toContain("writeStored(STORE_FOCUS, on)");
    expect(page).toContain("setFocusState(st.focus === true);");
  });

  test("a página liga a porta do comando e o estado escondido vira `bare`", () => {
    expect(page).toContain("const bare = focus;");
    expect(page).toContain("focus: { enabled: () => focusRef.current.on, available: () => focusRef.current.available, setEnabled: call('setFocus') }");
  });

  test("escondido, HUD, grupo da câmera, ferramentas e lista somem; sobra o botão Mostrar controles com Shift+F", () => {
    expect(page).toContain("{!bare ? <>");
    expect(page).toContain("{!bare ? <P.ListPanel");
    expect(page).toContain('aria-label="Mostrar controles" aria-keyshortcuts="Shift+F"');
    expect(page).not.toContain("FOCUS_CANVAS_H");
  });

  test("a gaveta do nó só abre com controles visíveis, e desloca o quadro pela FOCUS_PANEL_WIDTH", () => {
    expect(page).toContain("const drawerOn = !bare && panelOpen && focusNodes.length > 0;");
    expect(page).toContain("const focusShift = drawerOn && desk && FOCUS ? FOCUS.FOCUS_PANEL_WIDTH : null;");
    expect(page).toContain("style={focusShift ? { right: focusShift } : undefined}");
    expect(page).toContain("<FOCUS.FocusPanel open={panelOpen}");
    expect(page).toContain("sheet={!desk}");
  });

  test("o index.html carrega canvas-focus.js depois de parts.js e antes da página", () => {
    const html = ui("index.html");
    const at = (rel: string): number => html.indexOf(`<script src="/ui/${rel}.js"></script>`);
    expect(at("argos/canvas-focus")).toBeGreaterThan(at("argos/parts"));
    expect(at("argos/canvas-focus")).toBeGreaterThan(at("argos/canvas-overlays"));
    expect(at("argos/canvas-focus")).toBeLessThan(at("pages/argos"));
  });
});

// ---- terminal do nó (node-tty.tsx): o quadro ANSI desenhado, o foco e a tradução de teclas e colagem. Sem DOM: o componente é
// chamado direto, com ganchos mínimos (estado, ref e efeitos com limpeza), `document` e `ResizeObserver` de mentira.
describe("terminal do nó (ArgosNodeTty)", () => {
  const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
  type El = { tag: string; props: Record<string, any>; kids: Tree[] };
  type Tree = El | string | number | null | undefined | boolean | Tree[];
  type Input = { text?: string; keys?: string[] };

  const loadReact = (): { createElement: (...a: any[]) => any } => {
    const mod: { exports: any } = { exports: {} };
    new Function("exports", "module", readFileSync(join(uiDir, "vendor/react.js"), "utf8"))(mod.exports, mod);
    return mod.exports;
  };
  const transpiled = createUiTranspiler({ isolate: [join(uiDir, "argos")] }).transpile(join(uiDir, "argos/node-tty.tsx"));

  function expand(n: any): Tree {
    if (Array.isArray(n)) return n.map(expand);
    if (n === null || typeof n !== "object" || !("type" in n)) return n;
    if (typeof n.type === "function") return expand(n.type(n.props));
    const { children, ...props } = n.props ?? {};
    return { tag: n.type, props: n.ref ? { ...props, ref: n.ref } : props, kids: [children].flat(Infinity).map(expand) };
  }
  const all = (t: Tree, pred: (e: El) => boolean, out: El[] = []): El[] => {
    if (Array.isArray(t)) t.forEach((x) => all(x, pred, out));
    else if (t && typeof t === "object") {
      if (pred(t)) out.push(t);
      t.kids.forEach((k) => all(k, pred, out));
    }
    return out;
  };
  const text = (t: Tree): string => (Array.isArray(t) ? t.map(text).join("") : t && typeof t === "object" ? t.kids.map(text).join("") : typeof t === "string" || typeof t === "number" ? String(t) : "");
  const root = (t: Tree): El => all(t, (e) => e.props.role === "region")[0] as El;
  const grid = (t: Tree): El | undefined => all(t, (e) => "data-tty-grid" in e.props)[0];
  const status = (t: Tree): El | undefined => all(t, (e) => e.props.role === "status")[0];

  async function load() {
    const React = loadReact();
    const bundle = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const scope: Record<string, unknown> = {};
    new Function("globalThis", bundle as string)(scope);

    const slots: { v: any }[] = [];
    let slot = 0;
    let queued: (() => void | (() => void))[] = [];
    let cleanups: (() => void)[] = [];
    const HadesCore = {
      useRef: (v: unknown) => {
        slots[slot] ??= { v: { current: v } };
        return slots[slot++]!.v;
      },
      useState: (v: unknown) => {
        const own = (slots[slot] ??= { v });
        slot += 1;
        return [own.v, (x: unknown) => void (own.v = typeof x === "function" ? (x as (p: unknown) => unknown)(own.v) : x)];
      },
      useEffect: (fn: () => void | (() => void)) => void queued.push(fn),
      cn: (...a: unknown[]) => a.filter(Boolean).join(" "),
    };
    const listeners: { type: string; fn: (e: any) => void; capture: unknown }[] = [];
    const doc = {
      activeElement: null as unknown,
      addEventListener: (type: string, fn: (e: any) => void, capture: unknown) => void listeners.push({ type, fn, capture }),
      removeEventListener: (type: string, fn: (e: any) => void) => void listeners.splice(0, listeners.length, ...listeners.filter((l) => !(l.type === type && l.fn === fn))),
    };
    const observers: { cb: () => void; observed: unknown[]; disconnected: boolean }[] = [];
    class FakeObserver {
      rec: { cb: () => void; observed: unknown[]; disconnected: boolean };
      constructor(cb: () => void) {
        this.rec = { cb, observed: [], disconnected: false };
        observers.push(this.rec);
      }
      observe(el: unknown): void {
        this.rec.observed.push(el);
      }
      disconnect(): void {
        this.rec.disconnected = true;
      }
    }
    const win: Record<string, any> = { CanvasModel: scope.CanvasModel };
    new Function("globalThis", "window", createUiTranspiler().transpile(join(uiDir, "term-logic.tsx")))(win, win);
    new Function("window", "HadesCore", "React", "document", "ResizeObserver", transpiled)(win, HadesCore, React, doc, FakeObserver);
    const api = win.ArgosNodeTty as Record<string, any>;
    const render = (p: Record<string, unknown>) => {
      slot = 0;
      queued = [];
      return expand(api.NodeTty(p));
    };
    /** Roda os efeitos da última renderização; devolve a função que desfaz (o que a desmontagem faz). */
    const flush = () => {
      cleanups.forEach((fn) => fn());
      cleanups = queued.map((fn) => fn()).filter((r): r is () => void => typeof r === "function");
      queued = [];
    };
    return { api, render, flush, unmount: () => cleanups.forEach((fn) => fn()), doc, listeners, observers };
  }

  const frame = (over: Record<string, unknown> = {}) => ({ pane: "w1:p1", revision: 3, cols: 20, rows: 4, ansi: "\x1b[1;31mfalha\x1b[0m ok\r\n\x1b[38;2;215;119;87mlaranja\x1b[0m\r\n", ...over });
  const ev = (key: string, mods: Record<string, unknown> = {}) => {
    const calls = { prevent: 0, stop: 0 };
    return { calls, e: { key, code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault: () => void calls.prevent++, stopPropagation: () => void calls.stop++, ...mods } };
  };

  test("registra window.ArgosNodeTty com o contrato: NodeTty, TTY_GLOBAL_KEYS e minSize", async () => {
    const { api } = await load();
    expect(typeof api.NodeTty).toBe("function");
    expect(typeof api.minSize).toBe("function");
    expect([...api.TTY_GLOBAL_KEYS]).toEqual(["Ctrl+Shift+A", ...Array.from({ length: 9 }, (_, i) => `Alt+${i + 1}`), "Alt", "Ctrl+]"]);
  });

  test("o quadro vira uma região de terminal com o rótulo do painel e o espaço do xterm do tamanho da grade", async () => {
    const { render } = await load();
    const t = render({ frame: frame() });
    expect(root(t).props["aria-label"]).toBe("Terminal w1:p1");
    expect(text(t)).toContain("20×4");
    const g = grid(t) as El;
    expect(g.props["data-tty-engine"]).toBe("xterm");
    expect([g.props["data-tty-cols"], g.props["data-tty-rows"]]).toEqual([20, 4]);
  });

  test("o quadro é escrito como tela inteira: zera atributos, limpa a tela e separa as linhas por CRLF", async () => {
    const { api } = await load();
    const out = api.screenOf("\x1b[1;31mfalha\x1b[0m ok\r\nlaranja\r\n");
    expect(out).toBe("\x1b[?25l\x1b[0m\x1b[H\x1b[2J\x1b[1;31mfalha\x1b[0m ok\r\nlaranja\x1b[0m");
    expect(out.endsWith("\n")).toBe(false);
  });

  test("o cursor do quadro, quando vem, é posicionado (base 1) e mostrado; sem ele a tela o esconde", async () => {
    const { api } = await load();
    expect(api.screenOf("a", { row: 2, col: 5 })).toMatch(/\x1b\[3;6H\x1b\[\?25h$/);
    expect(api.screenOf("a")).not.toContain("?25h");
  });

  test("dois quadros seguidos escrevem cada um a tela inteira, sem depender do anterior", async () => {
    const { api } = await load();
    const first = api.screenOf("um\r\ndois");
    const second = api.screenOf("tres");
    expect(second.startsWith("\x1b[?25l\x1b[0m\x1b[H\x1b[2J")).toBe(true);
    expect(second).not.toContain("dois");
    expect(first).not.toBe(second);
  });

  test("quadro com bytes ou linhas demais não vai ao xterm: o nó avisa", async () => {
    const { render, api } = await load();
    expect(api.oversize("a\r\nb")).toBeNull();
    expect(api.oversize("x".repeat(1_048_577))).toMatch(/grande demais/);
    expect(api.oversize("\n".repeat(600))).toMatch(/linhas demais/);
    const t = render({ frame: frame({ ansi: "\n".repeat(600) }) });
    expect(grid(t)).toBeUndefined();
    expect(text(status(t) as El)).toMatch(/linhas demais/);
  });

  test("escala do nó escolhe o desenho: legível usa o xterm, distante fica no resumo leve", async () => {
    const { api } = await load();
    expect(api.ttyDrawing(false)).toBe("xterm");
    expect(api.ttyDrawing(true)).toBe("summary");
  });

  test("headerOnly desenha o cabeçalho e nenhum texto do quadro", async () => {
    const { render } = await load();
    const t = render({ frame: frame(), headerOnly: true });
    expect(grid(t)).toBeUndefined();
    expect(text(t)).toContain("w1:p1");
    expect(text(t)).not.toContain("falha");
    expect(text(t)).not.toContain("laranja");
  });

  test("scale fixa a escala da grade; sem ela e sem medida, a escala é 1", async () => {
    const { render } = await load();
    expect(grid(render({ frame: frame(), scale: 0.5 }))!.props.style.transform).toBe("scale(0.5)");
    expect(grid(render({ frame: frame() }))!.props.style.transform).toBe("scale(1)");
    expect(grid(render({ frame: frame(), scale: 0 }))!.props.style.transform).toBe("scale(1)");
    expect(grid(render({ frame: frame(), scale: Number.NaN }))!.props.style.transform).toBe("scale(1)");
  });

  test("sem scale, o quadro se ajusta ao espaço medido do nó, e o observador sai com a desmontagem", async () => {
    const { render, flush, unmount, observers } = await load();
    const t = render({ frame: frame({ cols: 40, rows: 10 }) });
    const area = all(t, (e) => e.props.ref && !("role" in e.props) && !("data-tty-input" in e.props) && e.props.className?.includes("overflow-hidden"))[0] as El;
    area.props.ref.current = { clientWidth: 624, clientHeight: 364 };
    flush();
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observed).toHaveLength(1);
    // área útil 612×352; célula 7,8×17 → 40×10 mede 312×170 → escala min(1,96; 2,07) = 1,96
    const again = render({ frame: frame({ cols: 40, rows: 10 }) });
    expect(Number.parseFloat(String(grid(again)!.props.style.transform).slice(6))).toBeCloseTo(612 / 312, 2);
    unmount();
    expect(observers[0]!.disconnected).toBe(true);
  });

  test("fitScale limita a escala e minSize pede cabeçalho mais ~20×6 células", async () => {
    const { api } = await load();
    expect(api.fitScale({ w: 100000, h: 100000 }, { cols: 80, rows: 24 })).toBe(2);
    expect(api.fitScale({ w: 1, h: 1 }, { cols: 80, rows: 24 })).toBe(0.2);
    expect(api.fitScale({ w: 0, h: 0 }, { cols: 80, rows: 24 })).toBe(0.2);
    const big = api.minSize({ cols: 200, rows: 50 });
    expect(big.w).toBeGreaterThanOrEqual(20 * 7);
    expect(big.h).toBeGreaterThan(6 * 17);
    const tiny = api.minSize({ cols: 5, rows: 2 });
    expect(tiny.w).toBeLessThan(big.w);
    expect(tiny.h).toBeLessThan(big.h);
  });

  test("quadro acima do teto ou com grade inválida não desenha e avisa", async () => {
    const { render } = await load();
    const huge = render({ frame: frame({ ansi: "x".repeat(2_000_000) }) });
    expect(grid(huge)).toBeUndefined();
    expect(text(status(huge))).toContain("grande demais");
    for (const bad of [{ cols: 0 }, { rows: 1.5 }, { cols: 100000 }, { ansi: 7 }]) {
      const t = render({ frame: frame(bad) });
      expect(grid(t)).toBeUndefined();
      expect(status(t)).toBeDefined();
    }
    expect(root(render({ frame: null })).props["aria-label"]).toBe("Terminal");
  });

  test("clicar dentro pede o foco uma vez só; já focado, não repete", async () => {
    const { render } = await load();
    let focus = 0;
    const t = render({ frame: frame(), focused: false, onFocus: () => void focus++ });
    root(t).props.onPointerDown();
    expect(focus).toBe(1);
    root(render({ frame: frame(), focused: true, onFocus: () => void focus++ })).props.onPointerDown();
    expect(focus).toBe(1);
    expect(root(t).props["data-tty-focused"]).toBe("false");
    expect(root(render({ frame: frame(), focused: true })).props["data-tty-focused"]).toBe("true");
  });

  test("clicar fora tira o foco; dentro não; só há ouvinte enquanto focado e ele sai na desmontagem", async () => {
    const { render, flush, unmount, listeners } = await load();
    let blur = 0;
    const onBlur = () => void blur++;
    render({ frame: frame(), focused: false, onBlur });
    flush();
    expect(listeners).toHaveLength(0);

    const t = render({ frame: frame(), focused: true, onBlur });
    const inside = { id: "dentro" };
    root(t).props.ref.current = { contains: (n: unknown) => n === inside, focus: () => {}, querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} };
    flush();
    expect(listeners.map((l) => l.type)).toEqual(["pointerdown"]);
    expect(listeners[0]!.capture).toBe(true);
    listeners[0]!.fn({ target: inside });
    expect(blur).toBe(0);
    listeners[0]!.fn({ target: { id: "fora" } });
    expect(blur).toBe(1);
    unmount();
    expect(listeners).toHaveLength(0);
  });

  test("ao ganhar o foco o elemento recebe o foco do navegador, sem rolar a página", async () => {
    const { render, flush, doc } = await load();
    const calls: unknown[] = [];
    const t = render({ frame: frame(), focused: true });
    root(t).props.ref.current = { contains: () => true, focus: (o: unknown) => void calls.push(o), querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} };
    flush();
    expect(calls).toEqual([{ preventScroll: true }]);
    doc.activeElement = root(t).props.ref.current;
    flush();
    expect(calls).toHaveLength(1);
  });

  const press = async (key: string, mods: Record<string, unknown> = {}, focused = true) => {
    const { render } = await load();
    const got: Input[] = [];
    const { e, calls } = ev(key, mods);
    root(render({ frame: frame(), focused, onInput: (i: Input) => void got.push(i) })).props.onKeyDown(e);
    return { got, calls };
  };

  test("caractere imprimível vira text e a tecla é consumida", async () => {
    for (const key of ["a", "Z", "ç", "5", "/", " ", "😀"]) {
      const { got, calls } = await press(key);
      expect(got).toEqual([{ text: key }]);
      expect(calls).toEqual({ prevent: 1, stop: 1 });
    }
  });

  test("teclas nomeadas viram keys", async () => {
    const table: [string, string, Record<string, unknown>?][] = [
      ["Enter", "Enter"], ["Escape", "Escape"], ["Tab", "Tab"], ["Tab", "Shift+Tab", { shiftKey: true }], ["ArrowUp", "Up"], ["ArrowDown", "Down"],
      ["ArrowLeft", "Left"], ["ArrowRight", "Right"], ["Home", "Home"], ["End", "End"], ["PageUp", "PageUp"], ["PageDown", "PageDown"],
      ["Backspace", "Backspace"], ["Delete", "Delete"],
    ];
    for (const [key, name, mods] of table) {
      const { got, calls } = await press(key, mods ?? {});
      expect(got).toEqual([{ keys: [name] }]);
      expect(calls).toEqual({ prevent: 1, stop: 1 });
    }
  });

  test("Ctrl+A..Ctrl+Z viram keys, exceto Ctrl+V (a colagem chega pelo evento paste), Ctrl+L (conexão no canvas) e Ctrl+Shift+letra", async () => {
    for (const letter of "ABCDEFGHIJKMNOPQRSTUWXYZ") {
      expect((await press(letter.toLowerCase(), { ctrlKey: true })).got).toEqual([{ keys: [`Ctrl+${letter}`] }]);
    }
    const v = await press("v", { ctrlKey: true });
    expect(v.got).toEqual([]);
    expect(v.calls).toEqual({ prevent: 0, stop: 0 });
    const l = await press("l", { ctrlKey: true });
    expect(l.got).toEqual([]);
    expect(l.calls).toEqual({ prevent: 0, stop: 0 });
    expect((await press("C", { ctrlKey: true, shiftKey: true })).got).toEqual([]);
  });

  test("AltGr (Ctrl+Alt) que produz caractere vira text", async () => {
    expect((await press("@", { ctrlKey: true, altKey: true })).got).toEqual([{ text: "@" }]);
  });

  test("teclas globais não são consumidas: nada em onInput, sem preventDefault nem stopPropagation", async () => {
    const globals: [string, Record<string, unknown>][] = [
      ["A", { ctrlKey: true, shiftKey: true }], ["a", { ctrlKey: true, shiftKey: true }], ["Alt", { altKey: true }], ["]", { ctrlKey: true }],
      ...Array.from({ length: 9 }, (_, i): [string, Record<string, unknown>] => [String(i + 1), { altKey: true, code: `Digit${i + 1}` }]),
      ["¡", { altKey: true, code: "Digit1" }],
    ];
    for (const [key, mods] of globals) {
      const { got, calls } = await press(key, mods);
      expect(got).toEqual([]);
      expect(calls).toEqual({ prevent: 0, stop: 0 });
    }
  });

  test("o que o contrato não nomeia fica com o navegador: modificador sozinho, Meta, F5, Alt+letra, seta com Ctrl, IME", async () => {
    const ignored: [string, Record<string, unknown>][] = [
      ["Shift", { shiftKey: true }], ["Control", { ctrlKey: true }], ["Meta", { metaKey: true }], ["a", { metaKey: true }], ["F5", {}],
      ["x", { altKey: true }], ["ArrowLeft", { ctrlKey: true }], ["Enter", { altKey: true }], ["a", { isComposing: true }], ["Process", {}], ["Dead", {}],
    ];
    for (const [key, mods] of ignored) {
      const { got, calls } = await press(key, mods);
      expect(got).toEqual([]);
      expect(calls).toEqual({ prevent: 0, stop: 0 });
    }
  });

  test("sem o foco, nenhuma tecla é consumida", async () => {
    const { got, calls } = await press("a", {}, false);
    expect(got).toEqual([]);
    expect(calls).toEqual({ prevent: 0, stop: 0 });
  });

  test("colar envia o texto como text e consome o evento", async () => {
    const { render } = await load();
    const got: Input[] = [];
    const calls = { prevent: 0, stop: 0 };
    const paste = (data: string) => ({ clipboardData: { getData: (t: string) => (t === "text/plain" ? data : "") }, preventDefault: () => void calls.prevent++, stopPropagation: () => void calls.stop++ });
    const t = render({ frame: frame(), focused: true, onInput: (i: Input) => void got.push(i) });
    root(t).props.onPaste(paste("ls -la\nexit"));
    expect(got).toEqual([{ text: "ls -la\nexit" }]);
    expect(calls).toEqual({ prevent: 1, stop: 1 });
    root(t).props.onPaste(paste(""));
    root(t).props.onPaste({ preventDefault: () => void calls.prevent++, stopPropagation: () => void calls.stop++ });
    expect(got).toHaveLength(1);
    expect(calls).toEqual({ prevent: 1, stop: 1 });
  });

  test("colar sem o foco, ou acima do teto, não envia: o teto avisa na região de status", async () => {
    const { render } = await load();
    const got: Input[] = [];
    const paste = (data: string) => ({ clipboardData: { getData: () => data }, preventDefault: () => {}, stopPropagation: () => {} });
    const props = { frame: frame(), onInput: (i: Input) => void got.push(i) };
    root(render({ ...props, focused: false })).props.onPaste(paste("x"));
    expect(got).toEqual([]);
    root(render({ ...props, focused: true })).props.onPaste(paste("x".repeat(20_001)));
    expect(got).toEqual([]);
    expect(text(status(render({ ...props, focused: true })))).toContain("Colagem grande demais");
    root(render({ ...props, focused: true })).props.onPaste(paste("x".repeat(20_000)));
    expect(got).toEqual([{ text: "x".repeat(20_000) }]);
    expect(status(render({ ...props, focused: true }))).toBeUndefined();
  });

  test("o index.html carrega node-tty.js depois de node-terminal.js e antes da página, e o pacote do modelo traz termAnsi", () => {
    const html = readFileSync(join(uiDir, "index.html"), "utf8");
    const at = (rel: string): number => html.indexOf(`<script src="/ui/${rel}.js"></script>`);
    expect(at("argos/node-tty")).toBeGreaterThan(at("argos/node-terminal"));
    expect(at("argos/node-tty")).toBeGreaterThan(at("lib/canvas-model"));
    expect(at("argos/node-tty")).toBeLessThan(at("pages/argos"));
    expect(CANVAS_UI_MODULES.termAnsi).toBe("term-ansi.ts");
  });
});

describe("peças ligadas: comandos de filtros, escopo e esboço", () => {
  const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
  const transpiler = createUiTranspiler();
  interface WiredCommand { id: string; group: string; surfaces: readonly string[]; run(ctx: object): unknown }
  interface WiredRegistry { get(id: string): WiredCommand | undefined; register(def: object): unknown; palette(ctx: object): { id: string }[] }
  interface FilterSet { v: number; rev: number; defaultId: string | null; filters: { id: string; name: string; selection: Record<string, string[]> }[] }
  interface Note { level: string; text: string; code?: string }
  interface Answers { text?: (string | null)[]; choose?: (string | null)[] }
  type SaveResult = { ok: true } | { ok: false; code: string };
  interface SketchNode { id: string; type: string; x: number; y: number; w: number; h: number; data: Record<string, unknown> }

  const ctx = { selectedLabel: null, availableActions: [], canUndo: false, canRedo: false, handlers: {},
    reading: { layout: "free", running: false, nodeId: null, pinned: false, searching: false, filtering: false } };
  // os comandos disparam a promessa e não a devolvem: um macrotask depois, todas as microtarefas dela já rodaram
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const NEW_IDS = ["filters:save", "filters:apply", "filters:delete", "filters:default", "canvas:scope", "canvas:default", "unit:sketch"];

  const mountWired = async (opts: { ports?: boolean; answers?: Answers; set?: FilterSet; current?: Record<string, string[]>; save?: SaveResult; canvasId?: string } = {}) => {
    const js = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const holder: Record<string, unknown> = {};
    new Function("globalThis", js as string)(holder);
    const model = holder.CanvasModel as Record<string, Record<string, unknown>>;
    const scope: Record<string, unknown> = { CanvasModel: model, React: { createElement: () => null } };
    for (const rel of ["argos/commands-canvas.tsx", "argos/types-user.tsx", "argos/types-live.tsx"]) {
      new Function("globalThis", "React", transpiler.transpile(join(uiDir, rel)))(scope, scope.React);
    }
    const parts = { canvasCommands: scope.ArgosCanvasCommands, typesUser: scope.ArgosTypesUser, typesLive: scope.ArgosTypesLive };
    const argos = model.argos as unknown as { createArgosRegistries(deps: object): { commands: WiredRegistry; types: object } };
    const reg = argos.createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null });
    for (const def of L.readingCommandDefs()) reg.commands.register(def);
    const docs = model.doc as unknown as { emptyCanvasDoc(): { nodes: { id: string; type: string; data: Record<string, unknown> }[] } };
    const texts = [...(opts.answers?.text ?? [])];
    const chooses = [...(opts.answers?.choose ?? [])];
    const s = {
      doc: docs.emptyCanvasDoc(), commits: [] as { kind: string; snapshot: { nodes: { item: SketchNode }[] } }[],
      notes: [] as Note[], selected: [] as string[][], revealed: [] as string[],
      set: opts.set ?? { v: 1, rev: 0, defaultId: null, filters: [] }, saves: [] as FilterSet[], applied: [] as unknown[], reloads: 0,
      opened: [] as { kind: string; key: string }[], defaults: 0,
    };
    const api: Record<string, unknown> = {
      doc: { doc: () => s.doc, selection: () => [], select: (ids: string[]) => void s.selected.push(ids), commit: (op: (typeof s.commits)[number]) => void s.commits.push(op),
        reveal: (id: string) => void s.revealed.push(id), notify: (note: Note) => void s.notes.push(note) },
      dialogs: { askText: async () => texts.shift() ?? null, choose: async () => chooses.shift() ?? null, confirm: async () => true },
    };
    if (opts.ports !== false) {
      api.savedFilters = { set: () => s.set, current: () => opts.current ?? {}, apply: (sel: unknown) => void s.applied.push(sel),
        save: async (next: FilterSet) => { s.saves.push(next); return opts.save ?? { ok: true }; }, reload: async () => { s.reloads += 1; } };
      api.scope = { options: () => [{ kind: "worktree", key: "o__r:alfa", label: "alfa (o__r)" }], current: () => opts.canvasId ?? (model.store as { DEFAULT_CANVAS_ID: string }).DEFAULT_CANVAS_ID,
        open: async (choice: { kind: string; key: string }) => void s.opened.push(choice), openDefault: async () => { s.defaults += 1; } };
      api.sketch = { at: () => ({ x: 500, y: 300 }) };
    }
    const deps = { fetch: () => Promise.reject(new Error("sem rede no teste")), now: () => NOW };
    const report = L.mountCanvasRegistries(reg as never, parts as never, { api, userDeps: deps, liveDeps: deps });
    const run = async (id: string): Promise<void> => { reg.commands.get(id)?.run(ctx); await settle(); };
    return { reg, report, s, run, model, typesUser: scope.ArgosTypesUser as { unitSketchView(m: object, n: object): { ok: boolean; text?: string; code?: string } } };
  };
  const created = (commits: { snapshot: { nodes: { item: SketchNode }[] } }[]): SketchNode | undefined => commits[0]?.snapshot.nodes[0]?.item;
  const oneFilter = (): FilterSet => ({ v: 1, rev: 3, defaultId: null, filters: [{ id: "meus", name: "Meus", selection: { role: ["impl"] } }] });

  test("com as portas, os comandos novos registram sem recusa, na paleta e no menu do fundo", async () => {
    const { reg, report } = await mountWired({ set: oneFilter(), current: { state: ["working"] }, canvasId: "wt-x" });
    expect(report.refused).toEqual([]);
    for (const id of NEW_IDS) expect(reg.commands.get(id)?.surfaces).toEqual(["palette", "canvas-menu"]);
    expect(reg.commands.get("filters:save")?.group).toBe("Filtros");
    expect(reg.commands.get("unit:sketch")?.group).toBe("Criar");
    const palette = reg.commands.palette(ctx).map((e) => e.id);
    for (const id of NEW_IDS) expect(palette).toContain(id);
  });

  test("sem as portas, nenhum dos comandos novos registra", async () => {
    const { reg, report } = await mountWired({ ports: false });
    expect(report.refused).toEqual([]);
    for (const id of NEW_IDS) expect(reg.commands.get(id)).toBeUndefined();
  });

  test("dado filtro ativo, quando salva com um nome, então grava o conjunto com o filtro novo", async () => {
    const { s, run } = await mountWired({ current: { state: ["working"] }, answers: { text: ["Trabalhando"] } });
    await run("filters:save");
    expect(s.saves).toHaveLength(1);
    expect(s.saves[0]?.filters.map((f) => [f.name, f.selection])).toEqual([["Trabalhando", { state: ["working"] }]]);
    expect(s.notes).toEqual([]);
  });

  test("dado filtro salvo, quando aplica, então a seleção dele vai para a página", async () => {
    const { s, run } = await mountWired({ set: oneFilter(), answers: { choose: ["meus"] } });
    await run("filters:apply");
    expect(s.applied).toEqual([{ role: ["impl"] }]);
  });

  test("dado revisão velha no servidor, quando salva, então recarrega e avisa com o código", async () => {
    const { s, run } = await mountWired({ current: { role: ["impl"] }, answers: { text: ["Outro"] }, save: { ok: false, code: "saved_filters_stale_revision" } });
    await run("filters:save");
    expect(s.reloads).toBe(1);
    expect(s.notes).toEqual([expect.objectContaining({ level: "warn", code: "saved_filters_stale_revision" })]);
  });

  test("dado outro erro do servidor, quando salva, então avisa erro sem recarregar", async () => {
    const { s, run } = await mountWired({ current: { role: ["impl"] }, answers: { text: ["Outro"] }, save: { ok: false, code: "saved_filters_invalid_shape" } });
    await run("filters:save");
    expect(s.reloads).toBe(0);
    expect(s.notes).toEqual([expect.objectContaining({ level: "error", code: "saved_filters_invalid_shape" })]);
  });

  test("dado filtro salvo, quando marca o padrão e depois Nenhum, então grava o id e depois null", async () => {
    const { s, run } = await mountWired({ set: oneFilter(), answers: { choose: ["meus"] } });
    await run("filters:default");
    expect(s.saves.at(-1)?.defaultId).toBe("meus");
    const again = await mountWired({ set: { ...oneFilter(), defaultId: "meus" }, answers: { choose: ["-"] } });
    await again.run("filters:default");
    expect(again.s.saves.at(-1)?.defaultId).toBeNull();
  });

  test("seletor de escopo: worktree abre direto; Rodada… pede a chave; o padrão só aparece fora dele", async () => {
    const wt = await mountWired({ answers: { choose: ["o__r:alfa"] } });
    await wt.run("canvas:scope");
    expect(wt.s.opened).toEqual([{ kind: "worktree", key: "o__r:alfa" }]);
    const round = await mountWired({ answers: { choose: [""], text: ["r-7"] } });
    await round.run("canvas:scope");
    expect(round.s.opened).toEqual([{ kind: "round", key: "r-7" }]);
    expect(round.reg.commands.palette(ctx).map((e) => e.id)).not.toContain("canvas:default");
    const away = await mountWired({ canvasId: "wt-x" });
    await away.run("canvas:default");
    expect(away.s.defaults).toBe(1);
  });

  test("A6: esboço de skill cria o nó unit-sketch no centro, seleciona, e o tipo gera os comandos", async () => {
    const { s, run, model, typesUser } = await mountWired({ answers: { choose: ["skill"], text: ["nova-peca"] } });
    await run("unit:sketch");
    expect(s.notes).toEqual([]);
    const node = created(s.commits);
    if (node === undefined) throw new Error("o comando não criou o nó");
    expect(node.type).toBe("unit-sketch");
    expect([node.x + node.w / 2, node.y + node.h / 2]).toEqual([500, 300]);
    expect(s.selected).toEqual([[node.id]]);
    expect(s.revealed).toEqual([node.id]);
    const view = typesUser.unitSketchView(model, node);
    expect(view.ok).toBe(true);
    expect(view.text).toBe("hades agent skill-new 'nova-peca' --role 'impl'\nhades agent start-cmd 'nova-peca'");
  });

  test("A6: unidade de projeto pede a branch; nome inválido avisa com código e não cria nada", async () => {
    const proj = await mountWired({ answers: { choose: ["project"], text: ["proj-a", "feat/a"] } });
    await proj.run("unit:sketch");
    expect(created(proj.s.commits)?.data).toEqual({ kind: "project", name: "proj-a", branch: "feat/a" });
    const bad = await mountWired({ answers: { choose: ["skill"], text: ["Nome Ruim"] } });
    await bad.run("unit:sketch");
    expect(bad.s.commits).toEqual([]);
    expect(bad.s.notes).toEqual([expect.objectContaining({ level: "error", code: "create_invalid_name" })]);
  });
});

describe("peças ligadas na página", () => {
  const ui = (rel: string): string => readFileSync(join(import.meta.dir, "../../../kit/panel/ui", rel), "utf8");
  const page = ui("pages/argos.tsx");

  test("N7: o estado abre pelo preset do endereço, volta ao endereço só fora do padrão e o Voltar o restaura", () => {
    expect(page).toContain("useState(() => urlRead.state.preset ?? DEFAULT_STATE)");
    expect(page).toContain("const linkPreset = (state) => (state !== DEFAULT_STATE && M.urlstate.URLSTATE_PRESETS.includes(state) ? state : undefined);");
    expect(page).toContain("if (presetInLink) urlRef.current.preset = presetInLink;");
    expect(page).toContain("}, [presetInLink]);");
    expect(page).toContain("setStateFilter(st.preset ?? DEFAULT_STATE);");
  });

  test("O3 e O7: o CanvasPane recebe as portas de encaixe e de acoplar, e o estado acoplado", () => {
    expect(page).toContain("snap={engineSnap} dock={engineDock} dockState={dockState} onDockState={setDock}");
    expect(page).toContain("const engineSnap = useMemo(() => ({ enabled: () => snapRef.current, move: M.snap.snapSelectionMove }), []);");
    expect(page).toContain("toggleElevated: (id) => host.current.changeDock((state, doc) => M.dock.toggleElevated(state, doc, id)),");
  });

  test("as portas novas dos comandos estão na api dos registros", () => {
    for (const port of ["snap: {", "dock: {", "savedFilters: {", "scope: {", "sketch: {"]) expect(page).toContain(`      ${port}`);
  });

  test("W2: canvas por escopo pela rota _scope, gravação no canvas aberto e seletor na barra do card", () => {
    expect(page).toContain("const SCOPE_URL = '/api/canvases/_scope';");
    expect(page).toContain("put: (doc, options) => { const sent = saveMeta.peek(); return putCanvas(canvasUrl(canvasIdRef.current), doc, options, { ...sent, graphSize: graphSizeRef.current })");
    expect(page).toContain("const SWITCH_UNSAVED = 'canvas_switch_unsaved';");
    expect(page).toContain('<Choice label="Canvas aberto"');
  });

  test("L5: filtros salvos pela rota _filters, e o padrão só sem filtro no endereço", () => {
    expect(page).toContain("const FILTERS_URL = '/api/canvases/_filters';");
    expect(page).toContain("M.savedFilters.defaultSelection(set)");
  });

  test("N8: toque longo do reconhecedor abre o menu no ponto; o tique tem dono e o contextmenu com dedo é ignorado", () => {
    const parts = ui("argos/parts.tsx");
    expect(parts).toContain("M.touch.createTouchRecognizer(() => performance.now())");
    expect(parts).toContain("if (ev.type !== 'longpress') continue;");
    expect(parts).toContain("menuAtClient(ev.at.x, ev.at.y);");
    expect(parts).toContain("useEffect(() => () => stopTicker(), []);");
    expect(parts).toContain("if (touch.current && touch.current.fingers.size > 0) return;");
  });

  test("motor: Ctrl encaixa, soltar na borda acopla, duplo clique no cabeçalho eleva", () => {
    const engine = ui("argos/canvas-engine.tsx");
    expect(engine).toContain("g.snapKey = e.ctrlKey || e.metaKey;");
    expect(engine).toContain("if (!snap || !(g.snapKey || snap.enabled())) return undefined;");
    expect(engine).toContain("opts.dock.dock(g.anchor, g.edge);");
    expect(engine).toContain("emitOp(snapOf(g)?.op ?? S.moveOp(doc, g.ids, g.anchor, g.dx, g.dy));");
    expect(engine).toContain('if (hit?.region !== "header") return;');
    expect(engine).toContain('listen(host, "dblclick", onDoubleClick);');
  });
});

// ---- nó de agente como terminal (node-terminal.tsx: AgentTtyNode e createTtyHost; comandos tty:* de commands-canvas.tsx).
// O host recebe EventSource, envio e timers de mentira; o nó é chamado direto e a árvore de elementos é lida sem DOM.
describe("nó de agente como terminal", () => {
  const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
  type Elem = { type: unknown; props: Record<string, any> };
  type Target = { session: string; pane: string };
  interface TtyHost {
    setTargets(next: Map<string, Target>): void; mount(id: string): () => void; modeOf(id: string): string; attentionOf(id: string): boolean;
    focus(id: string | null): void; focused(): string | null; nextAttention(): string | null; setAlt(on: boolean): void;
    jumpNumbers(): Map<string, number>; jumpTarget(n: number): string | null; setZoom(k: number): void; input(id: string, raw: unknown): void;
    target(id: string): Target | null; destroy(): void;
  }
  interface CommandsRegistry { get(id: string): { id: string; run(ctx: object): void } | undefined; register(def: object): void; resolveKey(e: object, s: { editable: boolean; ctx: object }): { id: string; run(ctx: object): void } | null }

  class FakeStream {
    readyState = 0;
    closed = false;
    private on = new Map<string, ((m: { data?: string }) => void)[]>();
    readonly url: string;
    constructor(url: string) { this.url = url; }
    addEventListener(type: string, fn: (m: { data?: string }) => void): void { this.on.set(type, [...(this.on.get(type) ?? []), fn]); }
    close(): void { this.closed = true; this.readyState = 2; }
    emit(type: string, data?: object): void { for (const fn of this.on.get(type) ?? []) fn(data === undefined ? {} : { data: JSON.stringify(data) }); }
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const id = (name: string): string => `agent:o__r:${name}`;
  const targetsOf = (...names: string[]): Map<string, Target> => new Map(names.map((n) => [id(n), { session: "default", pane: `w1:p${n}` }]));
  const frame = (pane: string) => ({ pane, revision: 1, cols: 40, rows: 10, ansi: "pronto\r\n" });

  async function load() {
    const mod: { exports: any } = { exports: {} };
    new Function("exports", "module", readFileSync(join(uiDir, "vendor/react.js"), "utf8"))(mod.exports, mod);
    const React = mod.exports as { createElement(type: unknown, props: object | null, ...kids: unknown[]): Elem };
    const bundle = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const holder: Record<string, any> = {};
    new Function("globalThis", bundle as string)(holder);
    const effects: (() => unknown)[] = [];
    const stub = (tag: string) => (p: object) => React.createElement(tag, p);
    const HadesCore = {
      useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => undefined],
      useEffect: (fn: () => unknown) => void effects.push(fn),
      useRef: (v: unknown) => ({ current: v }),
      useCallback: (fn: unknown) => fn,
      cn: (...a: unknown[]) => a.filter(Boolean).join(" "),
      I: new Proxy({}, { get: () => stub("svg") }),
      post: () => Promise.reject(new Error("sem rede no teste")), getJSON: () => Promise.reject(new Error("sem rede no teste")),
      Button: stub("button"), Dot: stub("span"), Mono: stub("span"), Tip: stub("span"), Empty: stub("div"), useApp: () => ({}),
    };
    const scope: Record<string, any> = { CanvasModel: holder.CanvasModel };
    const transpiler = createUiTranspiler();
    for (const rel of ["term-logic.tsx", "argos/node-terminal.tsx", "argos/node-tty.tsx", "argos/commands-canvas.tsx", "argos/types-user.tsx", "argos/types-live.tsx"]) {
      new Function("globalThis", "window", "React", "HadesCore", transpiler.transpile(join(uiDir, rel)))(scope, scope, React, HadesCore);
    }
    const NT = scope.ArgosNodeTerminal as Record<string, any>;
    const Tty = scope.ArgosNodeTty as Record<string, any>;

    const streams: FakeStream[] = [];
    const sent: object[] = [];
    const timers = new Map<number, () => void>();
    const rects = new Map<string, { x: number; y: number }>();
    let seq = 0;
    const host = NT.createTtyHost({
      openStream: (url: string) => { const s = new FakeStream(url); streams.push(s); return s; },
      sendInput: async (body: object) => void sent.push(body),
      setTimer: (run: () => void) => { seq += 1; timers.set(seq, run); return seq; },
      clearTimer: (h: number) => void timers.delete(h),
      nodeRect: (nodeId: string) => rects.get(nodeId),
      liveState: () => undefined,
    }) as TtyHost;
    const tick = (): void => { const due = [...timers.values()]; timers.clear(); for (const run of due) run(); };

    const fallback = React.createElement("div", { "data-fallback": true });
    const grown: [string, object][] = [];
    const render = (name: string, size: { w: number; h: number } = { w: 640, h: 400 }): Elem => {
      effects.length = 0;
      const input = { id: id(name), type: "agent", selected: false, data: {}, live: { label: name }, ...size };
      return NT.AgentTtyNode({ input, host, fallback, agentView: () => null, grow: (nodeId: string, min: object) => void grown.push([nodeId, min]) });
    };
    const runEffects = (): void => { for (const fn of effects.splice(0)) fn(); };

    const argos = holder.CanvasModel.argos as { createArgosRegistries(deps: object): { commands: CommandsRegistry } };
    const reg = argos.createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null });
    for (const def of L.readingCommandDefs()) reg.commands.register(def);
    const focusTty = (nodeId: string | null): boolean => { if (!nodeId) return false; host.focus(nodeId); return true; };
    const api = {
      doc: { doc: () => holder.CanvasModel.doc.emptyCanvasDoc(), selection: () => [], select: () => undefined, commit: () => undefined, reveal: () => undefined, notify: () => undefined },
      dialogs: { askText: async () => null, choose: async () => null, confirm: async () => false },
      tty: { nextAttention: () => focusTty(host.nextAttention()), jump: (n: number) => focusTty(host.jumpTarget(n)), release: () => host.focus(null), focused: () => host.focused() !== null },
    };
    const deps = { fetch: () => Promise.reject(new Error("sem rede no teste")), now: () => NOW };
    const report = L.mountCanvasRegistries(reg as never, { canvasCommands: scope.ArgosCanvasCommands, typesUser: scope.ArgosTypesUser, typesLive: scope.ArgosTypesLive } as never,
      { api, userDeps: deps, liveDeps: deps }) as { refused: unknown[] };
    return { NT, Tty, host, streams, sent, tick, rects, render, runEffects, fallback, grown, commands: reg.commands, report };
  }

  const kids = (e: unknown): unknown[] => {
    if (Array.isArray(e)) return e.flatMap(kids);
    if (!e || typeof e !== "object" || !("props" in e)) return [];
    const el = e as Elem;
    return [el, ...kids(el.props.children)];
  };
  const find = (tree: unknown, pred: (e: Elem) => boolean): Elem | undefined => kids(tree).find((e) => pred(e as Elem)) as Elem | undefined;
  const textOf = (e: unknown): string => (typeof e === "string" || typeof e === "number" ? String(e) : Array.isArray(e) ? e.map(textOf).join("") : e && typeof e === "object" && "props" in e ? textOf((e as Elem).props.children) : "");
  const ttyOf = (t: Awaited<ReturnType<typeof load>>, tree: unknown): Elem | undefined => find(tree, (e) => e.type === t.Tty.NodeTty);
  /** Nó montado com fluxo aberto e um quadro do pane. */
  const live = async (...names: string[]) => {
    const t = await load();
    t.host.setTargets(targetsOf(...names));
    for (const n of names) t.host.mount(id(n));
    t.tick();
    for (const n of names) t.streams.at(-1)?.emit("frame", frame(`w1:p${n}`));
    return t;
  };

  test("nó agent com pane do herdr desenha o terminal; sem pane, cai no desenho de antes", async () => {
    const t = await live("a");
    const tty = ttyOf(t, t.render("a"));
    expect(tty?.props.frame.pane).toBe("w1:pa");
    expect(t.render("b")).toBe(t.fallback);
  });

  test("assina só os panes dos nós montados, numa conexão só, e fecha quando nenhum fica", async () => {
    const t = await load();
    t.host.setTargets(targetsOf("a", "b", "c"));
    const offA = t.host.mount(id("a"));
    const offB = t.host.mount(id("b"));
    t.tick();
    expect(t.streams).toHaveLength(1);
    expect(t.streams[0]!.url).toBe("/api/herdr/stream?session=default&panes=w1%3Apa,w1%3Apb");
    offA();
    offB();
    t.tick();
    expect(t.streams[0]!.closed).toBe(true);
    expect(t.streams).toHaveLength(1);
  });

  test("a montagem do nó (efeito) assina o pane; sem fluxo, o nó cai no polling do /api/herdr/read", async () => {
    const t = await load();
    t.host.setTargets(targetsOf("a"));
    t.render("a");
    t.runEffects();
    t.tick();
    expect(t.streams).toHaveLength(1);
    t.streams[0]!.readyState = 2;
    t.streams[0]!.emit("error");
    expect(t.host.modeOf(id("a"))).toBe("polling");
    expect(ttyOf(t, t.render("a"))).toBeUndefined();
    expect(find(t.render("a"), (e) => typeof e.type === "function" && e.props.pane === "w1:pa")).toBeDefined();
  });

  test("com o terminal focado, só os comandos tty:* passam; cada tecla de TTY_GLOBAL_KEYS cai num deles", async () => {
    const t = await live("a");
    expect(t.report.refused).toEqual([]);
    t.host.focus(id("a"));
    const ev = (chord: string) => {
      const parts = chord.split("+");
      const base = parts.at(-1)!;
      const digit = /^[1-9]$/.test(base);
      return { key: digit ? "¡" : base, code: digit ? `Digit${base}` : "", ctrlKey: parts.includes("Ctrl"), altKey: parts.includes("Alt"), shiftKey: parts.includes("Shift"), metaKey: false };
    };
    for (const chord of t.Tty.TTY_GLOBAL_KEYS.filter((k: string) => k !== "Alt")) {
      const cmd = t.commands.resolveKey(t.NT.ttyKeyInput(ev(chord)), { editable: false, ctx: {} });
      expect(cmd && t.NT.ttyLetsCommand(true, cmd.id)).toBe(true);
    }
    expect(t.NT.ttyLetsCommand(true, "palette")).toBe(false);
    expect(t.NT.ttyLetsCommand(false, "palette")).toBe(true);
    expect(t.Tty.translateKey(ev("Escape"))).toEqual({ keys: ["Escape"] });
  });

  test("Ctrl+] e o clique fora soltam o teclado do terminal", async () => {
    const t = await live("a");
    t.host.focus(id("a"));
    expect(ttyOf(t, t.render("a"))?.props.focused).toBe(true);
    t.commands.resolveKey({ key: "]", ctrlKey: true }, { editable: false, ctx: {} })?.run({});
    expect(t.host.focused()).toBeNull();
    t.host.focus(id("a"));
    ttyOf(t, t.render("a"))?.props.onBlur();
    expect(t.host.focused()).toBeNull();
  });

  test("atenção acende em idle e blocked, apaga ao focar e só volta num estado novo", async () => {
    const t = await live("a");
    const status = (agentStatus: string) => t.streams[0]!.emit("status", { pane: "w1:pa", agentStatus });
    status("idle");
    expect(t.host.attentionOf(id("a"))).toBe(true);
    expect(find(t.render("a"), (e) => e.props["aria-label"] === "pede atenção")).toBeDefined();
    status("working");
    expect(t.host.attentionOf(id("a"))).toBe(false);
    status("blocked");
    expect(t.host.attentionOf(id("a"))).toBe(true);
    t.host.focus(id("a"));
    t.host.focus(null);
    expect(t.host.attentionOf(id("a"))).toBe(false);
    status("working");
    status("idle");
    expect(t.host.attentionOf(id("a"))).toBe(true);
  });

  test("Ctrl+Shift+A foca o próximo com atenção em ordem estável e dá a volta", async () => {
    const t = await live("a", "b", "c");
    expect(t.NT.nextAttentionId(["a", "b", "c"], ["a", "c"], "a")).toBe("c");
    expect(t.NT.nextAttentionId(["a", "b", "c"], ["a", "c"], "c")).toBe("a");
    expect(t.NT.nextAttentionId(["a", "b", "c"], [], "a")).toBeNull();
    for (const n of ["a", "c"]) t.streams[0]!.emit("status", { pane: `w1:p${n}`, agentStatus: "idle" });
    t.host.focus(id("b"));
    t.commands.resolveKey({ key: "A", ctrlKey: true, shiftKey: true }, { editable: false, ctx: {} })?.run({});
    expect(t.host.focused()).toBe(id("c"));
  });

  test("Alt mostra 1–9 na ordem de leitura e Alt+<n> foca o n-ésimo", async () => {
    const t = await live("a", "b", "c");
    t.rects.set(id("a"), { x: 0, y: 100 }).set(id("b"), { x: 0, y: 0 }).set(id("c"), { x: 300, y: 0 });
    expect([...t.host.jumpNumbers()]).toEqual([[id("b"), 1], [id("c"), 2], [id("a"), 3]]);
    const kbd = () => find(t.render("c"), (e) => e.type === "kbd");
    expect(kbd()).toBeUndefined();
    t.host.setAlt(true);
    expect(textOf(kbd())).toBe("2");
    t.commands.resolveKey(t.NT.ttyKeyInput({ key: "™", code: "Digit2", altKey: true }), { editable: false, ctx: {} })?.run({});
    expect(t.host.focused()).toBe(id("c"));
  });

  test("Home, End, PageUp, PageDown e Delete não saem para o herdr", async () => {
    const t = await live("a");
    for (const key of ["Home", "End", "PageUp", "PageDown", "Delete"]) expect(t.NT.filterTtyInput({ keys: [key] })).toBeNull();
    const tty = ttyOf(t, t.render("a"))!;
    tty.props.onInput({ keys: ["Home"] });
    tty.props.onInput({ keys: ["End", "Enter"] });
    await settle();
    expect(t.sent).toEqual([{ session: "default", pane: "w1:pa", keys: ["Enter"] }]);
  });

  test("zoom baixo desenha só o cabeçalho; nó abaixo do mínimo oferece ampliar", async () => {
    const t = await live("a");
    t.host.setZoom(0.2);
    expect(ttyOf(t, t.render("a"))?.props.headerOnly).toBe(true);
    t.host.setZoom(1);
    expect(ttyOf(t, t.render("a"))?.props.headerOnly).toBe(false);
    const small = t.render("a", { w: 100, h: 80 });
    expect(ttyOf(t, small)).toBeUndefined();
    find(small, (e) => textOf(e) === "Ampliar para o terminal" && typeof e.props.onClick === "function")?.props.onClick();
    expect(t.grown).toEqual([[id("a"), t.NT.ttyMinNodeSize(frame("w1:pa"))]]);
  });
});

// ---- compositor flutuante (kit/panel/ui/argos/canvas-composer.tsx): posição, foco seguido, repasse de teclas, envio,
// menções e a árvore desenhada. O .tsx é script de navegador: roda aqui sobre o modelo real e um createElement mínimo.
describe("compositor flutuante", () => {
  type El = { type: unknown; props: Record<string, unknown>; children: unknown[] };
  // contorno do que o teste usa do .tsx (o tsconfig do projeto não tem jsx, os tipos dele não entram aqui)
  interface ComposerApi {
    placeComposer(anchor: object, view: object): { x: number; y: number; w: number };
    followTarget(current: string | null, focused: string | null): string | null;
    forwardOf(e: object, empty: boolean): { text?: string; keys?: string[] } | null;
    outgoingInput(message: string): { text?: string; keys?: string[] };
    isShortcut(e: object): boolean;
    filesUrl(t: object, dir: string, q: string): string;
    readFiles(body: unknown): { entries: object[]; truncated: boolean } | null;
    mentionSources(doc: object, terminal: object, terminals: object[]): { terminals: { id: string }[]; notes: { id: string; title: string }[]; orchestrator: boolean };
    renderComposer(ui: object): El;
    COMPOSER_SHORTCUT: string;
  }
  const g = globalThis as unknown as Record<string, unknown>;
  const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: props ?? {}, children: children.flat() });
  const flat = (el: unknown): El[] => (el && typeof el === "object" && "children" in el ? [el as El, ...(el as El).children.flatMap(flat)] : []);
  const terminal = { id: "agent:o__r:a", label: "a", session: "default", pane: "w1:pa" };
  let loaded: { api: ComposerApi; model: Record<string, Record<string, unknown>> } | undefined;
  // carrega uma vez; o modelo só precisa estar em globalThis enquanto o script se registra
  const load = async (): Promise<{ api: ComposerApi; model: Record<string, Record<string, unknown>> }> => {
    if (loaded) return loaded;
    const js = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const scope: Record<string, unknown> = {};
    new Function("globalThis", js as string)(scope);
    const model = scope.CanvasModel as Record<string, Record<string, unknown>>;
    g.CanvasModel = model;
    try {
      // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
      await import("../../../kit/panel/ui/argos/canvas-composer.tsx");
    } finally {
      delete g.CanvasModel;
    }
    loaded = { api: g.ArgosCanvasComposer as ComposerApi, model };
    delete g.ArgosCanvasComposer;
    return loaded;
  };

  test("dado o terminal na tela, então o compositor fica sobre a parte de baixo dele e inteiro dentro da tela", async () => {
    const API = (await load()).api;
    expect(API.placeComposer({ x: 100, y: 100, w: 600, h: 400 }, { w: 1200, h: 800 })).toEqual({ x: 140, y: 308, w: 520 });
    const edge = API.placeComposer({ x: 1100, y: 700, w: 200, h: 200 }, { w: 1200, h: 800 });
    expect(edge.w).toBe(320);
    expect(edge.x + edge.w).toBeLessThanOrEqual(1192);
    expect(edge.y).toBeLessThanOrEqual(800 - 184 - 8);
  });

  test("dado outro terminal focado, então o compositor o segue; sem foco em terminal, fica no que estava", async () => {
    const API = (await load()).api;
    expect(API.followTarget("a", "b")).toBe("b");
    expect(API.followTarget("a", null)).toBe("a");
  });

  test("dado o campo vazio, então setas, Return, Tab e Shift+Tab vão ao terminal e `/` vai como texto", async () => {
    const API = (await load()).api;
    expect(API.forwardOf({ key: "ArrowUp" }, true)).toEqual({ keys: ["Up"] });
    expect(API.forwardOf({ key: "Enter" }, true)).toEqual({ keys: ["Enter"] });
    expect(API.forwardOf({ key: "Tab", shiftKey: true }, true)).toEqual({ keys: ["Shift+Tab"] });
    expect(API.forwardOf({ key: "/" }, true)).toEqual({ text: "/" });
  });

  test("dado texto no campo, Shift+Return ou acorde com Ctrl, então nada vai ao terminal", async () => {
    const API = (await load()).api;
    expect(API.forwardOf({ key: "Enter" }, false)).toBeNull();
    expect(API.forwardOf({ key: "Enter", shiftKey: true }, true)).toBeNull();
    expect(API.forwardOf({ key: "ArrowUp", ctrlKey: true }, true)).toBeNull();
    expect(API.forwardOf({ key: "a" }, true)).toBeNull();
  });

  test("dado o envio, então uma linha vai com Enter e várias linhas vão como colagem com Enter no fim", async () => {
    const API = (await load()).api;
    expect(API.outgoingInput("oi")).toEqual({ text: "oi", keys: ["Enter"] });
    expect(API.outgoingInput("a\nb")).toEqual({ text: "\u001b[200~a\nb\u001b[201~", keys: ["Enter"] });
  });

  test("dado mod+alt+p, então é o atalho do compositor, com Ctrl ou Cmd", async () => {
    const API = (await load()).api;
    expect(API.COMPOSER_SHORTCUT).toBe("mod+alt+p");
    expect(API.isShortcut({ key: "P", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(API.isShortcut({ key: "p", metaKey: true, shiftKey: true })).toBe(true);
    expect(API.isShortcut({ key: "P", shiftKey: true })).toBe(false);
  });

  test("dado o seletor, então a URL leva sessão, pane, pasta e busca codificados; a resposta é validada", async () => {
    const API = (await load()).api;
    expect(API.filesUrl(terminal, "src/a b", "x&y")).toBe("/api/argos/terminal-files?session=default&pane=w1%3Apa&path=src%2Fa%20b&q=x%26y");
    expect(API.readFiles({ entries: [{ path: "a", name: "a", type: "file" }, { path: 1 }, { path: "b", name: "b", type: "socket" }], truncated: true }))
      .toEqual({ entries: [{ path: "a", name: "a", type: "file" }], truncated: true });
    expect(API.readFiles({ error: "x" })).toBeNull();
  });

  test("dadas as arestas, então o menu oferece só os terminais ligados, todas as notas e o orquestrador do papel", async () => {
    const API = (await load()).api;
    const node = (id: string, type: string, data: object = {}) => ({ id, type, x: 0, y: 0, w: 1, h: 1, z: 0, data });
    const doc = { nodes: [node("n1", "note", { text: "Plano\n..." })], edges: [{ id: "e", from: "agent:o__r:b", to: terminal.id, kind: "link" }] };
    const all = [{ id: terminal.id, label: "a" }, { id: "agent:o__r:b", label: "b" }, { id: "agent:o__r:c", label: "c" }];
    const sources = API.mentionSources(doc, { ...terminal, orchestrator: true }, all);
    expect(sources.terminals.map((t) => t.id)).toEqual(["agent:o__r:b"]);
    expect(sources.notes).toEqual([{ id: "n1", title: "Plano" }]);
    expect(sources.orchestrator).toBe(true);
  });

  test("dado rascunho com pílula e menu aberto, então desenha a pílula numerada, a lista ligada ao campo e o aviso", async () => {
    const API = (await load()).api;
    const compose = (await load()).model.compose as unknown as { insertPaste(d: object, s: number, e: number, t: string): { draft: { text: string; pastes: object } }; findPills(d: object): object[] };
    const draft = compose.insertPaste({ text: "ver ", pastes: {} }, 4, 4, "1\n2\n3").draft;
    const noop = (): void => undefined;
    const tree = API.renderComposer({
      h, terminal, place: { x: 1, y: 2, w: 400 }, draft, pills: compose.findPills(draft), status: { kind: "error", text: "falhou" }, dragging: false,
      menu: { kind: "mention", active: 1, note: "", items: [{ key: "t", label: "b", hint: "terminal" }, { key: "f", label: "Arquivo…", hint: "busca no diretório" }] },
      fieldRef: { current: null }, mirrorRef: { current: null }, fileRef: { current: null },
      on: new Proxy({}, { get: () => noop }),
    });
    const all = flat(tree);
    expect(tree.props.role).toBe("dialog");
    expect(all.find((e) => e.type === "mark")?.children).toEqual(["⟦colagem 1 · 3 linhas⟧"]);
    const field = all.find((e) => e.type === "textarea") as El;
    const list = all.find((e) => e.props.role === "listbox") as El;
    expect(field.props["aria-controls"]).toBe(list.props.id);
    expect(field.props["aria-activedescendant"]).toBe(`${String(list.props.id)}-1`);
    expect(all.filter((e) => e.props.role === "option").map((e) => e.props["aria-selected"])).toEqual([false, true]);
    expect(all.find((e) => e.props.role === "alert")?.children).toEqual(["falhou"]);
    expect(all.find((e) => e.props["aria-label"] === "Anexar arquivo")?.type).toBe("button");
  });
});

// ---- nota de verdade (node-note.tsx): Markdown seguro, tabelas e diagramas marcados, menu e ordem dos scripts ----
// bloco da unidade notas: o script transpilado roda num globalThis próprio, com o `marked` do vendor/ como o navegador o
// recebe e o modelo real de src/lib/canvas-note.ts.
import * as NoteModel from "../../../src/lib/canvas-note";

describe("nota do canvas: node-note", () => {
  const UI = join(import.meta.dir, "../../../kit/panel/ui");
  interface Rendered { html: string; tables: string[]; diagrams: { source: string; closed: boolean }[] }
  interface MenuItem { id: string; label: string; disabled?: boolean }
  interface NodeNoteApi {
    renderNoteHtml(marked: object, model: object, input: { text: string; name: string; base: string }): Rendered;
    parseTableRaw(raw: string): { header: string[]; rows: string[][] };
    noteMenuItems(target: { table?: number; cell?: string; diagram?: number }, state: { locked: boolean; mode: "raw" | "formatted"; diagramReady: boolean }): MenuItem[];
    insertAt(text: string, piece: string, at: number | null): { text: string; caret: number };
    initialMode(name: string, text: string): "raw" | "formatted";
    rememberMode(name: string, mode: "raw" | "formatted"): void;
    menuPlacement(at: { x: number; y: number }, size: { width: number; height: number }, view: { w: number; h: number }): { x: number; y: number };
  }
  const load = (): { api: NodeNoteApi; marked: object } => {
    const scope: Record<string, unknown> = {};
    const js = createUiTranspiler().transpile(join(UI, "argos/node-note.tsx"));
    new Function("globalThis", "React", js)(scope, { createElement: () => null });
    const marked: Record<string, unknown> = {};
    new Function("exports", "module", readFileSync(join(UI, "vendor/marked.js"), "utf8"))(marked, { exports: marked });
    return { api: scope.ArgosNodeNote as NodeNoteApi, marked };
  };
  const { api, marked } = load();
  const render = (text: string, base = "nota-a"): Rendered => api.renderNoteHtml(marked, NoteModel, { text, name: "nota-a", base });

  test("o script registra a API sem depender de outro script da página", () => {
    expect(Object.keys(api).sort()).toEqual(expect.arrayContaining(["initialMode", "insertAt", "noteMenuItems", "parseTableRaw", "renderNoteHtml", "rememberMode"]));
  });

  test("conteúdo dos nós pela distância: um limite só, no Vista, guardado e levado ao motor", () => {
    const page = readFileSync(join(UI, "pages/argos.tsx"), "utf8");
    expect(page).toContain("const STORE_DETAIL = 'hades.argos.fullDetail'");
    expect(page).toContain("M.camera.fullDetailScale(readStored(STORE_DETAIL))");
    expect(page).toContain("<R.DetailSwitch value={fullDetail} choices={M.camera.FULL_DETAIL_CHOICES} onChange={setFullDetail} />");
    expect(page).toContain("fullDetail={fullDetail} />");
    expect(readFileSync(join(UI, "argos/parts.tsx"), "utf8")).toContain("fullDetail={fullDetail}");
    const engine = readFileSync(join(UI, "argos/canvas-engine.tsx"), "utf8");
    expect(engine).toContain("C.detailFor(k, opts.fullDetail ?? C.DETAIL_THRESHOLDS.full)");
    expect(engine).not.toContain("C.detailFor(cam.k)");
    expect(engine).toContain('if ("fullDetail" in next) markAll();');
  });

  test("menu da nota: abre no clique e, perto da borda da tela, entra para dentro em vez de cortar", () => {
    const size = { width: 160, height: 200 }, view = { w: 1000, h: 800 };
    expect(api.menuPlacement({ x: 100, y: 100 }, size, view)).toEqual({ x: 100, y: 100 });
    expect(api.menuPlacement({ x: 950, y: 100 }, size, view)).toEqual({ x: 1000 - 160 - 8, y: 100 });
    expect(api.menuPlacement({ x: 100, y: 750 }, size, view)).toEqual({ x: 100, y: 550 });
    expect(api.menuPlacement({ x: 5, y: 100 }, { width: 2000, height: 10 }, view).x).toBe(8);
  });

  test("menu da nota: vai para o body por portal (o nó corta o que passa da borda) e a alça de resize tem cursor", () => {
    const note = readFileSync(join(UI, "argos/node-note.tsx"), "utf8");
    expect(note).toContain("ReactDOM.createPortal(h(\"div\", { ref: menuRef, role: \"menu\"");
    expect(note).toContain("className: \"fixed z-[60]");
    const engine = readFileSync(join(UI, "argos/canvas-engine.tsx"), "utf8");
    expect(engine).toContain("S.resizeCursor(resizeEdge)");
    expect(engine).toContain("trackResizeHover(e)");
    // a alça fica sob o conteúdo do nó rico: o arrasto nela é do canvas, o resto do clique segue com o nó
    expect(engine).toContain("if (overRich && !(e.button === 0 && resizeHitAt(e))) return;");
    expect(readFileSync(join(UI, "index.html"), "utf8")).toContain(".canvas-resize-cursor, .canvas-resize-cursor * { cursor: var(--canvas-resize-cursor, nwse-resize) !important; }");
  });

  test("HTML cru do texto sai escapado e não vira elemento", () => {
    const { html } = render("antes\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> fim");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  test("link javascript: e data: viram texto; http(s), mailto e âncora ficam com rel seguro", () => {
    const { html } = render("[a](javascript:alert(1)) [b](data:text/html,x) [c](https://x.dev) [d](mailto:a@b.c) [e](#topo)");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).toContain('<a href="https://x.dev" target="_blank" rel="noopener noreferrer">c</a>');
    expect(html).toContain('href="mailto:a@b.c"');
    expect(html).toContain('href="#topo"');
  });

  test("imagem: a da pasta da nota vai pela rota, https fica, http e outra pasta viram marcador", () => {
    const file = "0123456789abcdef.png";
    const { html } = render(`![a](nota-a.assets/${file}) ![b](https://x.dev/i.png) ![c](http://x.dev/i.png) ![d](../outra.png)`);
    expect(html).toContain(`src="/api/canvas-notes/nota-a/assets/${file}"`);
    expect(html).toContain('src="https://x.dev/i.png"');
    expect(html).not.toContain("http://x.dev");
    expect(html).toContain('<span class="note-image-missing">[c]</span>');
    expect(html).toContain('<span class="note-image-missing">[d]</span>');
  });

  test("tabelas e diagramas são marcados pela ordem e devolvem o cru; bloco aberto não está fechado", () => {
    const text = "| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph LR\n  A --> B\n```\n\n| c |\n|---|\n| 3 |\n\n```mermaid\ngraph TD\n  X";
    const out = render(text);
    expect(out.tables).toHaveLength(2);
    expect(out.html).toContain('data-note-table="0"');
    expect(out.html).toContain('data-note-table="1"');
    expect(out.diagrams.map((d) => [d.source.split("\n")[0], d.closed])).toEqual([["graph LR", true], ["graph TD", false]]);
    expect(out.html).toContain('data-note-diagram="1"');
  });

  test("bloco de código que não é mermaid sai como código escapado, sem marca de diagrama", () => {
    const out = render("```js\nconst a = '<b>';\n```");
    expect(out.diagrams).toEqual([]);
    expect(out.html).not.toContain("data-note-diagram");
    expect(out.html).toContain("&lt;b&gt;");
  });

  test("parseTableRaw lê colunas com \\| escapado e linha curta", () => {
    expect(api.parseTableRaw("| a | b\\|c |\n|---|---|\n| 1 | x\\|y |\n| só |")).toEqual({ header: ["a", "b|c"], rows: [["1", "x|y"], ["só"]] });
  });

  test("menu: diagrama e tabela primeiro, imagem do diagrama desligada até desenhar; bloquear alterna o rótulo", () => {
    const ids = (items: MenuItem[]) => items.map((i) => i.id);
    const both = api.noteMenuItems({ diagram: 0, table: 1, cell: "x" }, { locked: false, mode: "formatted", diagramReady: false });
    expect(ids(both)).toEqual(["copy-diagram-code", "copy-diagram-image", "copy-table", "copy-table-md", "copy-cell", "toggle-mode", "rename", "lock", "move"]);
    expect(both.find((i) => i.id === "copy-diagram-image")?.disabled).toBe(true);
    const plain = api.noteMenuItems({}, { locked: true, mode: "raw", diagramReady: true });
    expect(ids(plain)).toEqual(["toggle-mode", "rename", "unlock", "move"]);
    expect(plain[0]?.label).toBe("Ver formatada");
  });

  test("insertAt põe a imagem numa linha própria no cursor; fora do texto vai para o fim", () => {
    expect(api.insertAt("ab", "![i](x)", 1)).toEqual({ text: "a\n![i](x)\nb", caret: 10 });
    expect(api.insertAt("", "![i](x)", null)).toEqual({ text: "![i](x)\n", caret: 8 });
    expect(api.insertAt("ab\n", "P", 99).text).toBe("ab\nP\n");
  });

  test("modo inicial: vazia em Raw, com texto Formatada; o lembrado na sessão vence", () => {
    expect(api.initialMode("nota-x", "  ")).toBe("raw");
    expect(api.initialMode("nota-x", "# t")).toBe("formatted");
    api.rememberMode("nota-x", "raw");
    expect(api.initialMode("nota-x", "# t")).toBe("raw");
  });

  test("index.html carrega node-note antes de types-user; o mermaid não entra no carregamento da página", () => {
    const html = readFileSync(join(UI, "index.html"), "utf8");
    const at = (src: string): number => html.indexOf(`<script src="${src}"></script>`);
    expect(at("/ui/argos/node-note.js")).toBeGreaterThan(-1);
    expect(at("/ui/argos/node-note.js")).toBeLessThan(at("/ui/argos/types-user.js"));
    expect(html).not.toContain("vendor/mermaid.js");
  });
});

// ---- popover de conexões (canvas-links.tsx): linhas, troca de estilo, soltar abraçadeira, × sem fechar, pular, Esc, foco e
// clique fora. O .tsx roda sobre um React mínimo (só createElement, useRef e useEffect) e um documento de mentira.
describe("popover de conexões (ArgosLinks)", () => {
  // as props da árvore são lidas e chamadas soltas (onClick, ref, onKeyDown): tipá-las uma a uma só repetiria o .tsx
  type El = { type: unknown; props: Record<string, any>; children: unknown[] };
  interface LinksApi {
    LinksPopover(props: Record<string, unknown>): El;
    popoverRows(doc: unknown, nodeId: string, describe: (id: string) => string | undefined): unknown[];
    popoverSize(rows: number, view: { w: number; h: number }): { w: number; h: number };
    placePopover(at: { x: number; y: number }, view: { w: number; h: number }, size: { w: number; h: number }): { x: number; y: number };
    EMPTY_LABEL: string;
  }
  type Op = { kind: string; ops?: { kind: string }[] };
  const g = globalThis as unknown as Record<string, unknown>;
  const T = "agent:o__r:alfa";
  const doc: import("../../../src/lib/canvas-doc").CanvasDoc = {
    v: 1, rev: 0, groups: [],
    nodes: [T, "n1", "n2"].map((id) => ({ id, type: id === T ? "agent" : "note", x: 0, y: 0, w: 100, h: 60, z: 0, data: {}, locked: false, blurred: false })),
    edges: [
      { id: "l1", from: T, to: "n1", kind: "link" },
      { id: "l2", from: "n1", to: "n2", kind: "link", style: "circuit", clamps: [{ id: "c1", t: 0.5 }] },
    ],
  };
  const LABELS: Record<string, string> = { [T]: "alfa", n1: "Roteiro" };

  let loaded: Promise<{ api: LinksApi; links: typeof import("../../../src/lib/canvas-links") }> | undefined;
  const load = () => (loaded ??= (async () => {
    const links = await import("../../../src/lib/canvas-links");
    const saved = g.CanvasModel;
    g.CanvasModel = { links };
    try {
      // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
      await import("../../../kit/panel/ui/argos/canvas-links.tsx");
    } finally {
      g.CanvasModel = saved;
    }
    return { api: g.ArgosLinks as LinksApi, links };
  })());

  /** Uma montagem: refs persistem pela ordem; os efeitos ficam na fila até `flush`. */
  function mount(api: LinksApi, props: Record<string, unknown>) {
    const refs: { current: unknown }[] = [];
    const effects: (() => void | (() => void))[] = [];
    const cleanups: (() => void)[] = [];
    let slot = 0;
    const fake = {
      createElement: (type: unknown, p: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: p ?? {}, children }),
      useRef: (v: unknown) => (refs[slot] ??= { current: v }, refs[slot++]!),
      useEffect: (fn: () => void | (() => void)) => void effects.push(fn),
    };
    const render = (): El => {
      const saved = g.React;
      g.React = fake;
      slot = 0;
      try {
        return api.LinksPopover(props);
      } finally {
        g.React = saved;
      }
    };
    const tree = render();
    return {
      tree,
      flush: () => effects.splice(0).forEach((fn) => { const c = fn(); if (typeof c === "function") cleanups.push(c); }),
      unmount: () => cleanups.splice(0).forEach((c) => c()),
    };
  }
  const flat = (n: unknown): El[] => {
    if (Array.isArray(n)) return n.flatMap(flat);
    if (typeof n !== "object" || n === null) return [];
    const el = n as El;
    return [el, ...el.children.flatMap(flat)];
  };
  const textOf = (n: unknown): string => (typeof n === "string" ? n : flat(n).flatMap((e) => e.children.filter((c) => typeof c === "string")).join(""));
  const buttons = (tree: El, text: string): El[] => flat(tree).filter((e) => e.type === "button" && (textOf(e) === text || e.props["aria-label"] === text));
  const rowOf = (tree: El, edgeId: string): El => flat(tree).find((e) => e.props["data-edge"] === edgeId) as El;
  const base = (over: Record<string, unknown> = {}) => {
    const calls = { ops: [] as Op[], jumps: [] as string[], closed: 0, errors: [] as string[] };
    const props = {
      doc, nodeId: "n1", at: { x: 10, y: 10 }, view: { w: 1200, h: 800 }, describe: (id: string) => LABELS[id],
      onOp: (op: Op) => void calls.ops.push(op), onJump: (id: string) => void calls.jumps.push(id), onClose: () => void calls.closed++,
      onError: (m: string) => void calls.errors.push(m), ...over,
    };
    return { calls, props };
  };

  test("as linhas dizem o destino (rótulo, ou o id sem rótulo), o que ele é e o que a conexão dá", async () => {
    const { api } = await load();
    expect(api.popoverRows(doc, "n1", (id: string) => LABELS[id])).toEqual([
      { edgeId: "l1", other: T, label: "alfa", end: "Terminal", meaning: "o agente lê e escreve a nota", style: "rope", clamps: [] },
      { edgeId: "l2", other: "n2", label: "n2", end: "Nota", meaning: "nota encadeada: a leitura segue a cadeia", style: "circuit", clamps: ["c1"] },
    ]);
  });

  test("é um diálogo com nome, uma linha por conexão, o estilo atual marcado e soltar só onde há abraçadeira", async () => {
    const { api } = await load();
    const { tree } = mount(api, base().props);
    expect(tree.props.role).toBe("dialog");
    expect(tree.props["aria-label"]).toBe("Conexões de Roteiro");
    const rope = rowOf(tree, "l1");
    const circuit = rowOf(tree, "l2");
    expect(buttons(rope, "Corda")[0]?.props["aria-pressed"]).toBe(true);
    expect(buttons(circuit, "Circuito")[0]?.props["aria-pressed"]).toBe(true);
    expect(buttons(rope, "Soltar abraçadeira")).toHaveLength(0);
    expect(buttons(circuit, "Soltar abraçadeira")).toHaveLength(1);
    expect(buttons(rope, "Remover conexão com alfa")).toHaveLength(1);
  });

  test("trocar o estilo envia a operação do desfazer; o estilo atual não envia nada", async () => {
    const { api, links } = await load();
    const { calls, props } = base();
    const { tree } = mount(api, props);
    buttons(rowOf(tree, "l1"), "Corda")[0]?.props.onClick();
    expect(calls.ops).toHaveLength(0);
    buttons(rowOf(tree, "l1"), "Circuito")[0]?.props.onClick();
    expect(calls.ops).toEqual([links.opSetLinkStyle(doc, "l1", "circuit") as Op]);
  });

  test("× remove a conexão sem fechar o popover", async () => {
    const { api, links } = await load();
    const { calls, props } = base();
    buttons(rowOf(mount(api, props).tree, "l2"), "Remover conexão com n2")[0]?.props.onClick();
    expect(calls.ops).toEqual([links.opRemoveLink(doc, "l2")]);
    expect(calls.closed).toBe(0);
  });

  test("soltar abraçadeira envia a mesma operação do Delete no canvas", async () => {
    const { api, links } = await load();
    const { calls, props } = base();
    buttons(rowOf(mount(api, props).tree, "l2"), "Soltar abraçadeira")[0]?.props.onClick();
    expect(calls.ops).toEqual([links.opReleaseClamp(doc, "c1")]);
  });

  test("clicar na linha pula até o destino e fecha", async () => {
    const { api } = await load();
    const { calls, props } = base();
    const jump = flat(rowOf(mount(api, props).tree, "l1")).find((e) => e.type === "button" && e.props.title === "Ir até alfa");
    jump?.props.onClick();
    expect(calls.jumps).toEqual([T]);
    expect(calls.closed).toBe(1);
  });

  test("operação sobre documento que mudou por baixo vira aviso pela mensagem do código, sem operação", async () => {
    const { api } = await load();
    const { calls, props } = base();
    const live = { ...props, doc: { ...doc, edges: [{ ...doc.edges[1]!, clamps: [{ id: "c9", t: 0.5 }] }] } };
    const { tree } = mount(api, live);
    // a abraçadeira some do documento entre o desenho e o clique
    live.doc = { ...doc, edges: [] };
    buttons(rowOf(tree, "l2"), "Soltar abraçadeira")[0]?.props.onClick();
    expect(calls.ops).toHaveLength(0);
    expect(calls.errors).toEqual(["abraçadeira não existe"]);
  });

  test("nó sem conexão mostra o vazio", async () => {
    const { api } = await load();
    const { tree } = mount(api, { ...base().props, doc: { ...doc, edges: [] } });
    expect(flat(tree).some((e) => textOf(e) === api.EMPTY_LABEL)).toBe(true);
  });

  test("Esc fecha sem chegar ao canvas; outra tecla não faz nada", async () => {
    const { api } = await load();
    const { calls, props } = base();
    const { tree } = mount(api, props);
    const ev = (key: string) => ({ key, stopped: 0, prevented: 0, stopPropagation() { this.stopped++; }, preventDefault() { this.prevented++; } });
    const other = ev("a");
    tree.props.onKeyDown(other);
    expect([calls.closed, other.stopped]).toEqual([0, 0]);
    const esc = ev("Escape");
    tree.props.onKeyDown(esc);
    expect([calls.closed, esc.stopped, esc.prevented]).toEqual([1, 1, 1]);
  });

  test("ao abrir, o foco vai à primeira linha; clique fora fecha; ao fechar, o foco volta a quem abriu e o ouvinte sai", async () => {
    const { api } = await load();
    const { calls, props } = base();
    const log: string[] = [];
    const listeners = new Set<(e: { target: unknown }) => void>();
    const opener = { isConnected: true, focus: () => log.push("opener") };
    const saved = g.document;
    g.document = {
      activeElement: opener,
      addEventListener: (_t: string, fn: (e: { target: unknown }) => void) => listeners.add(fn),
      removeEventListener: (_t: string, fn: (e: { target: unknown }) => void) => listeners.delete(fn),
    };
    try {
      const m = mount(api, props);
      const inside = { tag: "dentro" };
      m.tree.props.ref({ focus: () => log.push("root"), contains: (n: unknown) => n === inside });
      const first = flat(m.tree).find((e) => e.type === "button" && typeof e.props.ref === "function");
      first?.props.ref({ focus: () => log.push("first"), contains: () => false });
      m.flush();
      expect(log).toEqual(["first"]);
      for (const fn of listeners) fn({ target: inside });
      expect(calls.closed).toBe(0);
      for (const fn of listeners) fn({ target: { tag: "fora" } });
      expect(calls.closed).toBe(1);
      m.unmount();
      expect(listeners.size).toBe(0);
      expect(log).toEqual(["first", "opener"]);
    } finally {
      g.document = saved;
    }
  });

  test("o popover abre para dentro da tela perto da borda", async () => {
    const { api } = await load();
    const view = { w: 800, h: 600 };
    const size = api.popoverSize(3, view);
    const at = api.placePopover({ x: 790, y: 590 }, view, size);
    expect(at.x + size.w).toBeLessThanOrEqual(view.w);
    expect(at.y + size.h).toBeLessThanOrEqual(view.h);
    expect(api.popoverSize(500, view).h).toBeLessThanOrEqual(view.h);
  });

  test("o pacote do modelo traz `links` e o index.html carrega canvas-links.js depois do painel do nó e antes da página", () => {
    expect(CANVAS_UI_MODULES.links).toBe("canvas-links.ts");
    const html = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/index.html"), "utf8");
    const at = (rel: string): number => html.indexOf(`<script src="/ui/${rel}.js"></script>`);
    expect(at("argos/canvas-links")).toBeGreaterThan(at("argos/canvas-focus"));
    expect(at("argos/canvas-links")).toBeLessThan(at("pages/argos"));
  });
});

describe("orquestrador no modal e no nó terminal", () => {
  // as peças são scripts clássicos de navegador: rodam num escopo próprio com HadesCore de mentira e sem rede
  type Dict = Record<string, any>;
  const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
  const PANE = { session: "default", pane: "w1:p3" };
  let loaded: Promise<Dict> | undefined;
  const load = (): Promise<Dict> => (loaded ??= (async () => {
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
      cn: (...a: unknown[]) => a.filter(Boolean).join(" "), I: new Proxy({}, { get: () => stub("svg") }),
      post: () => Promise.reject(new Error("sem rede no teste")), getJSON: () => Promise.reject(new Error("sem rede no teste")),
      Button: stub("button"), Input: stub("input"), Dialog: stub("div"), DialogHeader: stub("div"), DialogFooter: stub("div"), Segmented: stub("div"),
      Checkbox: stub("button"), Dot: stub("span"), Mono: stub("span"), Tip: stub("span"), Empty: stub("div"), useApp: () => ({}),
    };
    const scope: Dict = { CanvasModel: holder.CanvasModel };
    const transpiler = createUiTranspiler();
    for (const rel of ["argos/node-terminal.tsx", "argos/terminal-create.tsx"]) {
      new Function("globalThis", "window", "React", "HadesCore", transpiler.transpile(join(uiDir, rel)))(scope, scope, React, HadesCore);
    }
    return scope;
  })());
  /** fetch falso de uma resposta só; guarda o corpo enviado. */
  const replyWith = (body: Dict) => {
    const sent: Dict[] = [];
    const fetch = async (_url: string, init: { body?: string } = {}) => {
      sent.push(init.body ? JSON.parse(init.body) : {});
      return { ok: true, status: 200, json: async () => body };
    };
    return { fetch, sent };
  };

  test("o nó lê a caixa só como true e o recrutador só como id de nó válido", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    expect(NT.readTerminalData({ name: "a", orchestrator: true, recruiter: "term-orq" })).toEqual({ name: "a", orchestrator: true, recruiter: "term-orq" });
    expect(NT.readTerminalData({ name: "a", orchestrator: "true", recruiter: "../x y" })).toEqual({ name: "a" });
  });

  test("o formulário começa com a caixa desligada e, na edição, traz a do nó", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    expect(TC.EMPTY_FORM.orchestrator).toBe(false);
    expect(TC.formOf({ name: "chefe", orchestrator: true }).orchestrator).toBe(true);
    expect(TC.formOf({ name: "comum" }).orchestrator).toBe(false);
  });

  test("o corpo de criar leva orchestrator só com a caixa ligada", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    expect(TC.createBody({ ...TC.EMPTY_FORM, name: "chefe", orchestrator: true })).toEqual({ name: "chefe", orchestrator: true });
    expect(TC.createBody({ ...TC.EMPTY_FORM, name: "comum" })).toEqual({ name: "comum" });
  });

  test("o nó só ganha a caixa quando o servidor confirma que as instruções de gerente entraram", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const form = { ...TC.EMPTY_FORM, name: "chefe", orchestrator: true };
    expect(TC.nodeDataOf(form, { herdr: PANE, agent: "claude", orchestrator: true }).orchestrator).toBe(true);
    expect(TC.nodeDataOf(form, { herdr: PANE, agent: "claude" }).orchestrator).toBeUndefined();
  });

  test("o cliente repassa a confirmação do servidor ao criar e ao trocar o papel", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const created = replyWith({ herdr: PANE, agent: "claude", orchestrator: true });
    expect((await TC.createTerminalClient({ fetch: created.fetch }).create({ name: "chefe", orchestrator: true })).value.orchestrator).toBe(true);
    const plain = replyWith({ herdr: PANE, agent: "claude" });
    expect((await TC.createTerminalClient({ fetch: plain.fetch }).create({ name: "comum" })).value.orchestrator).toBeUndefined();
    const role = replyWith({ herdr: PANE, orchestrator: true });
    expect((await TC.createTerminalClient({ fetch: role.fetch }).setRole({ ...PANE, name: "chefe", role: null })).value).toEqual({ herdr: PANE, orchestrator: true });
  });

  test("trocar a caixa na edição manda o booleano e o nó segue o que o servidor devolveu", async () => {
    const { ArgosTerminalCreate: TC } = await load();
    const on = replyWith({ herdr: PANE, orchestrator: true });
    const ligado = await TC.changeRole({ client: TC.createTerminalClient({ fetch: on.fetch }), data: { name: "chefe", herdr: PANE }, role: null, orchestrator: true, askName: async () => null });
    expect(on.sent[0]).toEqual({ ...PANE, name: "chefe", role: null, orchestrator: true });
    expect(ligado).toEqual({ ok: true, data: { name: "chefe", herdr: PANE, orchestrator: true } });
    const off = replyWith({ herdr: PANE });
    const desligado = await TC.changeRole({ client: TC.createTerminalClient({ fetch: off.fetch }), data: { name: "chefe", herdr: PANE, orchestrator: true }, role: null, orchestrator: false, askName: async () => null });
    expect(off.sent[0]?.orchestrator).toBe(false);
    expect(desligado.data.orchestrator).toBeUndefined();
  });

  test("documento gravado pela CLI: relê só com a aba visível, nada na fila e a revisão do servidor à frente", async () => {
    const { ArgosNodeTerminal: NT } = await load();
    const base = { hidden: false, busy: false, knownRev: 4, serverRev: 5 };
    expect(NT.externalRevReload(base)).toBe(true);
    // edição do dono agendada ou a caminho: não relê (o envio volta stale e o gravador avisa e relê)
    expect(NT.externalRevReload({ ...base, busy: true })).toBe(false);
    expect(NT.externalRevReload({ ...base, hidden: true })).toBe(false);
    expect(NT.externalRevReload({ ...base, serverRev: 4 })).toBe(false);
    expect(NT.externalRevReload({ ...base, serverRev: 3 })).toBe(false);
    expect(NT.externalRevReload({ ...base, serverRev: "5" })).toBe(false);
  });

  test("a conferência da revisão não força envio do gravador e conta o que está agendado", () => {
    const page = readFileSync(join(uiDir, "pages/argos.tsx"), "utf8");
    const check = page.slice(page.indexOf("const swallow = "), page.indexOf("}, [watch]);"));
    expect(check.length).toBeGreaterThan(0);
    expect(check).not.toContain("saver.flush");
    // um agendamento só fala direto com o gravador (scheduleSave); os outros passam por ele e entram na conta
    expect(page.match(/saver\.schedule\(/g)?.length).toBe(1);
  });
});

// ---- supervisor do canvas (supervisor.tsx): transição que gera cartão, comandos do campo, terminal pelo nome, nota
// "Notas do supervisor" (criada 1×, entrada datada, nó como operação do desfazer), monitor só de leitura e o painel.
describe("supervisor do canvas (ArgosSupervisor)", () => {
  // a árvore do painel é lida e os handlers são chamados soltos: tipar cada prop só repetiria o .tsx
  type El = { type: unknown; props: Record<string, any>; children: unknown[] };
  type Card = import("../../../src/lib/canvas-supervisor").SupervisorCard;
  type Doc = import("../../../src/lib/canvas-doc").CanvasDoc;
  type Op = import("../../../src/lib/canvas-history").CanvasOp;
  type Outcome = { ok: boolean; code?: string; message?: string; created?: boolean; nodeId?: string };
  interface NoteClient {
    noteLoad(): Promise<{ ok: true; text: string | null; rev: string | null } | { ok: false; code: string; message: string }>;
    noteSave(text: string, rev: string | null): Promise<{ ok: true; rev: string } | { ok: false; code: string; message: string }>;
  }
  interface Host {
    subscribe(fn: (topic: string) => void): () => void;
    statusOf(id: string): string;
    exitedOf(id: string): boolean;
    target(id: string): { session: string; pane: string } | null;
  }
  interface SupervisorApi {
    transitionOf(prev: { status: string; exited: boolean } | undefined, next: { status: string; exited: boolean }): "end" | "pause" | null;
    parseCommand(raw: string): { kind: "note" | "notes" | "ask"; text: string };
    pickTerminal(text: string, terminals: readonly { id: string; label: string }[]): string | null;
    entryLine(text: string, at: Date): string;
    appendEntry(current: string | null, line: string): string;
    annotate(input: { client: NoteClient; docNow(): Doc; commit(make: (doc: Doc) => Op): boolean; center(): { x: number; y: number }; text: string; at: Date }): Promise<Outcome>;
    createMonitor(deps: { host: Host; client: { peek(t: { session: string; pane: string }, status: string, exited: boolean): Promise<unknown> }; onCard(e: { id: string; label: string; card: Card }): void; onError?(m: string): void }): { setTerminals(t: readonly { id: string; label: string }[]): void; check(): void; destroy(): void };
    renderPanel(ui: Record<string, unknown>): El;
    renderPill(h: unknown, unread: number, onOpen: () => void): El;
    SUPERVISOR_NOTE: string;
    NOTE_TITLE: string;
  }
  const g = globalThis as unknown as Record<string, unknown>;
  const T = "agent:o__r:revisor";

  let loaded: Promise<{ api: SupervisorApi; history: typeof import("../../../src/lib/canvas-history"); note: typeof import("../../../src/lib/canvas-note") }> | undefined;
  const load = () => (loaded ??= (async () => {
    const note = await import("../../../src/lib/canvas-note");
    const history = await import("../../../src/lib/canvas-history");
    const saved = g.CanvasModel;
    g.CanvasModel = { note };
    try {
      // @ts-expect-error o .tsx é script de navegador: ele publica em globalThis, o import é só pelo efeito
      await import("../../../kit/panel/ui/argos/supervisor.tsx");
    } finally {
      g.CanvasModel = saved;
    }
    return { api: g.ArgosSupervisor as SupervisorApi, history, note };
  })());

  const docOf = (nodes: Record<string, unknown>[] = []): Doc => ({ v: 1, rev: 0, groups: [], edges: [], nodes: nodes as unknown as Doc["nodes"] });
  const agentNode = { id: T, type: "agent", x: 0, y: 0, w: 400, h: 300, z: 0, data: {}, locked: false, blurred: false };

  test("de working a parado é pausa, a done ou pane que sai é fim; estado inicial e outras trocas não geram cartão", async () => {
    const { api } = await load();
    const s = (status: string, exited = false) => ({ status, exited });
    expect(api.transitionOf(undefined, s("idle"))).toBeNull();
    expect(api.transitionOf(s("working"), s("idle"))).toBe("pause");
    expect(api.transitionOf(s("working"), s("blocked"))).toBe("pause");
    expect(api.transitionOf(s("working"), s("done"))).toBe("end");
    expect(api.transitionOf(s("idle"), s("idle", true))).toBe("end");
    expect(api.transitionOf(s("idle"), s("blocked"))).toBeNull();
    expect(api.transitionOf(s("idle"), s("working"))).toBeNull();
    expect(api.transitionOf(s("working", true), s("idle", true))).toBe("pause");
  });

  test("a parada que gera cartão na tela é a mesma lista de estados de pausa da heurística do servidor", async () => {
    const { api } = await load();
    const { PAUSE_STATUSES } = await import("../../../src/lib/canvas-supervisor");
    const s = (status: string) => ({ status, exited: false });
    for (const status of PAUSE_STATUSES) expect(api.transitionOf(s("working"), s(status))).not.toBeNull();
    for (const status of ["working", "unknown"]) expect(api.transitionOf(s("working"), s(status))).toBeNull();
  });

  test("'anota que …' anota, 'resume as notas' resume, o resto é pergunta", async () => {
    const { api } = await load();
    expect(api.parseCommand("anota que o rate limit foi resolvido")).toEqual({ kind: "note", text: "o rate limit foi resolvido" });
    expect(api.parseCommand("Anote: revisar amanhã")).toEqual({ kind: "note", text: "revisar amanhã" });
    expect(api.parseCommand("Resume as notas conectadas").kind).toBe("notes");
    expect(api.parseCommand("resumir nota")).toMatchObject({ kind: "notes" });
    expect(api.parseCommand("  veja o que o revisor está fazendo ")).toEqual({ kind: "ask", text: "veja o que o revisor está fazendo" });
    expect(api.parseCommand("anotação do dia?").kind).toBe("ask");
  });

  test("o terminal sai do nome na pergunta, sem acento nem caixa, e o nome mais longo vence; nenhum é null", async () => {
    const { api } = await load();
    const terms = [{ id: "a", label: "revisor" }, { id: "b", label: "Revisor Rápido" }, { id: "c", label: "impl" }];
    expect(api.pickTerminal("veja o que o REVISOR está fazendo", terms)).toBe("a");
    expect(api.pickTerminal("e o revisor rapido?", terms)).toBe("b");
    expect(api.pickTerminal("como vai o impl-2?", terms)).toBeNull();
    expect(api.pickTerminal("qualquer coisa", [])).toBeNull();
  });

  test("a entrada é datada em hora local numa linha só; a primeira ganha o cabeçalho da nota", async () => {
    const { api } = await load();
    const line = api.entryLine("  o rate limit\n  foi resolvido ", new Date(2026, 10, 2, 9, 5));
    expect(line).toBe("- 2026-11-02 09:05 — o rate limit foi resolvido");
    expect(api.appendEntry(null, line)).toBe(`# ${api.NOTE_TITLE}\n\n${line}\n`);
    expect(api.appendEntry("   ", line)).toBe(`# ${api.NOTE_TITLE}\n\n${line}\n`);
    expect(api.appendEntry("# Notas do supervisor\n\n- antes", line)).toBe(`# Notas do supervisor\n\n- antes\n${line}\n`);
  });

  /** A nota em memória, como a rota das notas: revisão por gravação e `note_stale_revision` se a revisão não bate. */
  function memoryNotes(start: string | null = null, staleOnce = false) {
    const state = { text: start, rev: start === null ? null : "r0", n: 0, saves: 0, staleOnce };
    const client: NoteClient = {
      noteLoad: async () => ({ ok: true, text: state.text, rev: state.rev }),
      noteSave: async (text, rev) => {
        if (state.staleOnce) { state.staleOnce = false; state.text = `${state.text ?? ""}- outro escreveu\n`; state.rev = "rX"; return { ok: false, code: "note_stale_revision", message: "" }; }
        if (rev !== state.rev) return { ok: false, code: "note_stale_revision", message: "" };
        state.saves += 1;
        state.text = text;
        state.rev = `r${++state.n}`;
        return { ok: true, rev: state.rev };
      },
    };
    return { state, client };
  }

  test("na primeira anotação cria o nó da nota uma vez (operação que o desfazer volta exatamente); depois só acrescenta", async () => {
    const { api, history } = await load();
    const { state, client } = memoryNotes();
    let doc = docOf([agentNode]);
    const ops: Op[] = [];
    const commit = (make: (d: Doc) => Op): boolean => { const op = make(doc); ops.push(op); doc = history.applyOp(doc, op); return true; };
    const before = doc;
    const first = await api.annotate({ client, docNow: () => doc, commit, center: () => ({ x: 500, y: 400 }), text: "primeira", at: new Date(2026, 10, 2, 10, 0) });
    expect(first).toMatchObject({ ok: true, created: true, nodeId: "supervisor-notas" });
    expect(ops).toHaveLength(1);
    const placed = doc.nodes.find((n) => n.id === "supervisor-notas");
    expect(placed).toMatchObject({ type: "note", data: { note: api.SUPERVISOR_NOTE } });
    expect(history.applyOp(doc, history.invert(ops[0] as Op)).nodes).toEqual(before.nodes);
    const second = await api.annotate({ client, docNow: () => doc, commit, center: () => ({ x: 0, y: 0 }), text: "segunda", at: new Date(2026, 10, 2, 10, 1) });
    expect(second).toMatchObject({ ok: true, created: false, nodeId: "supervisor-notas" });
    expect(ops).toHaveLength(1);
    expect(state.text).toBe(`# ${api.NOTE_TITLE}\n\n- 2026-11-02 10:00 — primeira\n- 2026-11-02 10:01 — segunda\n`);
  });

  test("com o id ocupado, o nó ganha sufixo; nó recusado devolve erro com a entrada já gravada", async () => {
    const { api } = await load();
    const taken = docOf([{ ...agentNode, id: "supervisor-notas", type: "text" }]);
    const ids: string[] = [];
    const r = await api.annotate({
      client: memoryNotes().client, docNow: () => taken, commit: (make) => { const op = make(taken) as { snapshot?: { nodes: { item: { id: string } }[] } }; ids.push(...(op.snapshot?.nodes ?? []).map((n) => n.item.id)); return false; },
      center: () => ({ x: 0, y: 0 }), text: "x", at: new Date(),
    });
    expect(ids).toEqual(["supervisor-notas-2"]);
    expect(r).toMatchObject({ ok: false, code: "supervisor_note_node" });
  });

  test("nó da nota criado enquanto o arquivo era gravado não se duplica: o documento é relido depois da espera", async () => {
    const { api, history } = await load();
    const { client } = memoryNotes();
    let doc = docOf([agentNode]);
    const ops: Op[] = [];
    const commit = (make: (d: Doc) => Op): boolean => { const op = make(doc); ops.push(op); doc = history.applyOp(doc, op); return true; };
    // outra anotação cria o nó durante a gravação desta
    const slow = { ...client, noteSave: async (text: string, rev: string | null) => {
      const saved = await client.noteSave(text, rev);
      doc = history.applyOp(doc, NoteModel.createNoteNode(doc, { id: "supervisor-notas", note: api.SUPERVISOR_NOTE, x: 0, y: 0, w: 360, h: 280 }).op);
      return saved;
    } };
    const r = await api.annotate({ client: slow, docNow: () => doc, commit, center: () => ({ x: 0, y: 0 }), text: "junto", at: new Date(2026, 0, 1, 0, 0) });
    expect(r).toMatchObject({ ok: true, created: false, nodeId: "supervisor-notas" });
    expect(ops).toHaveLength(0);
    expect(doc.nodes.filter((n) => n.type === "note")).toHaveLength(1);
  });

  test("se outro escreveu no meio, relê e grava de novo uma vez, sem perder a entrada alheia", async () => {
    const { api } = await load();
    const { state, client } = memoryNotes("# Notas do supervisor\n\n", true);
    const r = await api.annotate({ client, docNow: () => docOf(), commit: () => true, center: () => ({ x: 0, y: 0 }), text: "minha", at: new Date(2026, 0, 1, 0, 0) });
    expect(r.ok).toBe(true);
    expect(state.text).toContain("- outro escreveu");
    expect(state.text?.endsWith("- 2026-01-01 00:00 — minha\n")).toBe(true);
  });

  test("o monitor só lê o host: cartão uma vez por parada, nenhum no estado inicial, nenhum sem pane", async () => {
    const { api } = await load();
    const status: Record<string, string> = { a: "working", b: "working", c: "idle" };
    let notify: (topic: string) => void = () => undefined;
    const reads: string[] = [];
    // o host não tem `input`: um proxy registra qualquer outra leitura
    const host = new Proxy({
      subscribe: (fn: (topic: string) => void) => { notify = fn; return () => { notify = () => undefined; }; },
      statusOf: (id: string) => status[id] ?? "unknown",
      exitedOf: () => false,
      target: (id: string) => (id === "b" ? null : { session: "proj", pane: `w1:p${id}` }),
    }, { get(t, key: string) { reads.push(key); return (t as Record<string, unknown>)[key]; } }) as Host;
    const peeks: string[] = [];
    let release: () => void = () => undefined;
    const card = { kind: "done", title: "Terminou", summary: "Terminou", preview: [] } as unknown as Card;
    const client = { peek: (t: { pane: string }, s: string) => { peeks.push(`${t.pane}:${s}`); return new Promise((resolve) => { release = () => resolve({ ok: true, card }); }); } };
    const cards: string[] = [];
    const monitor = api.createMonitor({ host, client, onCard: (e) => cards.push(e.id) });
    monitor.setTerminals([{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }]);
    notify("status");
    expect(peeks).toEqual([]);
    status.a = "idle"; status.b = "done";
    notify("status");
    expect(peeks).toEqual(["w1:pa:idle"]);
    status.a = "working"; notify("status"); status.a = "blocked"; notify("status");
    expect(peeks).toEqual(["w1:pa:idle"]);
    release();
    await Promise.resolve(); await Promise.resolve();
    expect(cards).toEqual(["a"]);
    monitor.destroy();
    expect(new Set(reads)).toEqual(new Set(["subscribe", "statusOf", "exitedOf", "target"]));
  });

  const card = (over: Partial<Card> = {}): Card => ({
    kind: "permission", title: "Pede permissão", summary: "Pede permissão: rodar", status: "blocked", permission: "Do you want to proceed? — rm -rf build/",
    steps: ["Bash(rm -rf build/)"], lastLines: [], preview: ["Do you want to proceed?"], source: "local",
    suggestions: [{ label: "Abrir o terminal", action: "jump" }, { label: "Perguntar", action: "ask" }], ...over,
  });
  const ui = (over: Record<string, unknown> = {}) => ({
    h: (type: unknown, p: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: p ?? {}, children }),
    entries: [], terminals: [{ id: T, label: "revisor" }], target: "", text: "", busy: false, claude: true, error: "", confirm: null,
    onText() {}, onTarget() {}, onAsk() {}, onNote() {}, onNotes() {}, onConfirm() {}, onConfirmSubmit() {}, onConfirmCancel() {},
    onSuggestion() {}, onNoteCard() {}, onClose() {}, onKeyDown() {}, ...over,
  });
  const flat = (n: unknown): El[] => {
    if (Array.isArray(n)) return n.flatMap(flat);
    if (typeof n !== "object" || n === null) return [];
    const el = n as El;
    return [el, ...el.children.flatMap(flat)];
  };
  const textOf = (n: unknown): string => flat(n).flatMap((e) => e.children.filter((c) => typeof c === "string")).join(" ");

  test("o cartão automático leva selo local, a permissão detectada, a prévia e as sugestões", async () => {
    const { api } = await load();
    const tree = api.renderPanel(ui({ entries: [{ type: "watch", key: "e1", at: 0, id: T, label: "revisor", card: card() }] }));
    const els = flat(tree);
    expect(els.filter((e) => e.props["data-seal"]).map((e) => e.props["data-seal"])).toEqual(["local"]);
    expect(textOf(els.find((e) => e.props["data-detected"] === "permission"))).toBe("Do you want to proceed? — rm -rf build/");
    expect(textOf(els.find((e) => e.type === "pre"))).toBe("Do you want to proceed?");
    expect(textOf(tree)).toContain("Abrir o terminal");
    expect(textOf(tree)).toContain("Perguntar");
  });

  test("a resposta da consulta leva o selo de que saiu da máquina, com o que foi enviado", async () => {
    const { api } = await load();
    const tree = api.renderPanel(ui({ entries: [{ type: "answer", key: "e2", at: 0, id: T, label: "revisor", question: "o que faz?", text: "roda testes", sent: { lines: 12, chars: 300 } }] }));
    const sealEl = flat(tree).find((e) => e.props["data-seal"] === "claude");
    expect(sealEl?.props.title).toBe("Saiu da máquina pelo claude -p: 12 linhas de revisor, 300 caracteres");
    expect(textOf(tree)).toContain("Enviado ao claude -p: 12 linhas de revisor, 300 caracteres.");
  });

  test("com o claude desligado, Perguntar e Resumir notas ficam desligados e as sugestões de consulta somem", async () => {
    const { api } = await load();
    const tree = api.renderPanel(ui({ claude: false, text: "veja o revisor", entries: [{ type: "watch", key: "e1", at: 0, id: T, label: "revisor", card: card() }] }));
    const els = flat(tree);
    const button = (label: string) => els.find((e) => e.type === "button" && textOf(e) === label);
    expect(button("Perguntar")?.props.disabled).toBe(true);
    expect(button("Resumir notas")?.props.disabled).toBe(true);
    expect(button("Anotar")?.props.disabled).toBe(false);
    expect(els.find((e) => e.props["data-seal-note"])?.props["data-seal-note"]).toBe("off");
  });

  test("pelo acesso remoto, Confirmar só liga com a frase exata", async () => {
    const { api } = await load();
    const confirmOf = (value: string) => flat(api.renderPanel(ui({ confirm: { phrase: "revisor", value } }))).find((e) => e.type === "button" && textOf(e) === "Confirmar");
    expect(confirmOf("revis")?.props.disabled).toBe(true);
    expect(confirmOf("revisor")?.props.disabled).toBe(false);
  });

  test("o aviso com o painel fechado conta os cartões novos", async () => {
    const { api } = await load();
    const h = (type: unknown, p: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: p ?? {}, children });
    expect(textOf(api.renderPill(h, 1, () => undefined))).toBe("Supervisor · 1 novo");
    expect(textOf(api.renderPill(h, 3, () => undefined))).toBe("Supervisor · 3 novos");
  });

  test("o index.html carrega supervisor.js depois do modelo e antes da página", () => {
    const html = readFileSync(join(import.meta.dir, "../../../kit/panel/ui/index.html"), "utf8");
    const at = (rel: string): number => html.indexOf(`<script src="/ui/${rel}.js"></script>`);
    expect(at("argos/supervisor")).toBeGreaterThan(at("lib/canvas-model"));
    expect(at("argos/supervisor")).toBeLessThan(at("pages/argos"));
  });
});

describe("supervisor montado na página (tty:supervisor, mod+shift+o)", () => {
  const uiDir = join(import.meta.dir, "../../../kit/panel/ui");
  interface MountedCommand { id: string; surfaces: readonly string[]; run(ctx: object): unknown }
  interface MountedRegistry {
    get(id: string): MountedCommand | undefined;
    palette(ctx: object): { id: string }[];
    help(ctx: object): { id: string; shortcuts: string[] }[];
    resolveKey(event: object, state: { editable: boolean; ctx: object }): { id: string } | null;
  }
  const ctx = { selectedLabel: null, availableActions: [], canUndo: false, canRedo: false, handlers: {} };
  // o comando dispara a porta sem devolver a promessa: um macrotask depois, ela já rodou
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** Registro montado como a página o monta; `supervisor` dá a porta (que conta os toggles) ou a deixa de fora. */
  const mountWith = async (supervisor: boolean) => {
    const js = await createCanvasModuleBundler(join(import.meta.dir, "../../../src/lib")).bundle(CANVAS_UI_BUNDLE);
    const holder: Record<string, unknown> = {};
    new Function("globalThis", js as string)(holder);
    const model = holder.CanvasModel as Record<string, Record<string, unknown>>;
    const scope: Record<string, unknown> = { CanvasModel: model, React: { createElement: () => null } };
    const transpiler = createUiTranspiler();
    // o terminal (node-terminal, node-tty) entra para conferir o filtro de teclas com o foco nele; sem rede nem DOM
    const unused = () => { throw new Error("não usado no teste"); };
    const HadesCore = new Proxy({ cn: (...a: unknown[]) => a.filter(Boolean).join(" ") }, { get: (t, k) => (k in t ? t[k as "cn"] : unused) });
    for (const rel of ["term-logic.tsx", "argos/commands-canvas.tsx", "argos/types-user.tsx", "argos/types-live.tsx", "argos/node-terminal.tsx", "argos/node-tty.tsx"]) {
      new Function("globalThis", "window", "React", "HadesCore", transpiler.transpile(join(uiDir, rel)))(scope, scope, scope.React, HadesCore);
    }
    const argos = model.argos as unknown as { createArgosRegistries(deps: object): { commands: MountedRegistry; types: object } };
    const reg = argos.createArgosRegistries({ actions: L.ACTIONS, stateFilters: L.STATE_FILTERS, render: () => () => null });
    const docs = model.doc as unknown as { emptyCanvasDoc(): object };
    const toggles: number[] = [];
    const api: Record<string, unknown> = {
      doc: { doc: () => docs.emptyCanvasDoc(), selection: () => [], select: () => undefined, commit: () => undefined, reveal: () => undefined, notify: () => undefined },
      dialogs: { askText: async () => null, choose: async () => null, confirm: async () => false },
    };
    if (supervisor) api.supervisor = { toggle: () => void toggles.push(1) };
    const parts = { canvasCommands: scope.ArgosCanvasCommands, typesUser: scope.ArgosTypesUser, typesLive: scope.ArgosTypesLive };
    const deps = { fetch: () => Promise.reject(new Error("sem rede no teste")), now: () => 0 };
    const report = L.mountCanvasRegistries(reg as never, parts as never, { api, userDeps: deps, liveDeps: deps }) as { refused: unknown[] };
    const NT = scope.ArgosNodeTerminal as { ttyLetsCommand(inTty: boolean, id: string): boolean };
    const Tty = scope.ArgosNodeTty as { translateKey(e: object): object | null };
    return { commands: reg.commands, toggles, report, NT, Tty };
  };
  const ctrlShiftO = { key: "O", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };

  test("dada a porta, o comando registra só na paleta e, quando roda, alterna o painel", async () => {
    const t = await mountWith(true);
    expect(t.report.refused).toEqual([]);
    expect(t.commands.get("tty:supervisor")?.surfaces).toEqual(["palette"]);
    expect(t.commands.palette(ctx).map((e) => e.id)).toContain("tty:supervisor");
    t.commands.get("tty:supervisor")?.run(ctx);
    await settle();
    expect(t.toggles).toHaveLength(1);
  });

  test("sem a porta, o comando não existe", async () => {
    const t = await mountWith(false);
    expect(t.commands.get("tty:supervisor")).toBeUndefined();
    expect(t.commands.resolveKey(ctrlShiftO, { editable: true, ctx })).toBeNull();
  });

  test("Ctrl+Shift+O resolve para o supervisor mesmo com o foco num campo de texto", async () => {
    const t = await mountWith(true);
    expect(t.commands.resolveKey(ctrlShiftO, { editable: true, ctx })?.id).toBe("tty:supervisor");
  });

  test("com o foco num terminal, Ctrl+Shift+O não vai ao agente e o comando passa pelo filtro do terminal", async () => {
    const t = await mountWith(true);
    expect(t.Tty.translateKey({ ...ctrlShiftO, code: "KeyO", isComposing: false })).toBeNull();
    const cmd = t.commands.resolveKey(ctrlShiftO, { editable: true, ctx });
    expect(cmd?.id).toBe("tty:supervisor");
    expect(t.NT.ttyLetsCommand(true, cmd?.id ?? "")).toBe(true);
  });

  test("a ajuda de atalhos lista o supervisor com mod+shift+o", async () => {
    const t = await mountWith(true);
    expect(t.commands.help(ctx).find((r) => r.id === "tty:supervisor")?.shortcuts).toEqual(["mod+shift+o"]);
  });

  test("a página liga a porta ao estado do painel e monta a camada do supervisor com ele", () => {
    const page = readFileSync(join(uiDir, "pages/argos.tsx"), "utf8");
    expect(page).toContain("const SUP = window.ArgosSupervisor;");
    expect(page).toContain("supervisor: { toggle: call('supervisorToggle') }");
    expect(page).toContain("supervisorToggle: () => setSupOpen((o) => !o)");
    expect(page).toMatch(/<SUP\.SupervisorLayer open=\{supOpen\} onOpen=\{\(\) => setSupOpen\(true\)\} onClose=\{\(\) => setSupOpen\(false\)\}/);
  });
});

describe("filtros: ocultos e dimensões do agente no preset", () => {
  const graph: ArgosGraph = {
    v: 1,
    nodes: [
      agent("vivo", { state: "working" }),
      agent("velho", { state: "archived" }),
      agent("feito", { state: "done" }),
      node("pr:o__r:1", "pr"), node("pr:o__r:2", "pr"), node("pr:o__r:3", "pr"), node("unit:o__r:u", "unit", { state: "planned" }),
    ],
    edges: [
      { from: "agent:o__r:vivo", to: "pr:o__r:1", kind: "agent_pr" },
      { from: "agent:o__r:velho", to: "pr:o__r:2", kind: "agent_pr" },
    ],
  };
  const notArchived = (n: ArgosNode): boolean => n.state !== "archived";
  const ids = (f: Partial<ArgosFilters>) => L.filterGraph(graph, { ...ALL, ...f }, NOW).nodes.map((n) => n.id).sort();

  test("dado agente oculto, então ele e o PR ligado só a ele saem, mesmo em 'Todos'", () => {
    expect(ids({ hidden: new Set(["agent:o__r:vivo"]) })).not.toContain("agent:o__r:vivo");
    expect(ids({ hidden: new Set(["agent:o__r:vivo"]) })).not.toContain("pr:o__r:1");
  });
  test("dado nó não agente oculto, então só ele sai", () => {
    expect(ids({ hidden: new Set(["pr:o__r:3"]) })).toEqual(["agent:o__r:feito", "agent:o__r:velho", "agent:o__r:vivo", "pr:o__r:1", "pr:o__r:2", "unit:o__r:u"]);
  });
  test("dado arquivado podado pelo agente em 'Todos', então o PR ligado só a ele sai e o PR solto fica", () => {
    expect(ids({ agent: notArchived })).toEqual(["agent:o__r:feito", "agent:o__r:vivo", "pr:o__r:1", "pr:o__r:3", "unit:o__r:u"]);
  });
  test("dado 'Concluídos' sem os arquivados, então fica só o encerrado", () => {
    expect(ids({ state: "done", agent: notArchived })).toEqual(["agent:o__r:feito"]);
  });
  test("dada janela de atividade (narrowing), então a unidade e o PR soltos saem como em papel e estado", () => {
    expect(ids({ agent: () => true, narrowing: true })).toEqual(["agent:o__r:feito", "agent:o__r:velho", "agent:o__r:vivo", "pr:o__r:1", "pr:o__r:2"]);
  });
  test("sem os campos novos, o resultado é o de antes (preset antigo segue igual)", () => {
    expect(ids({})).toEqual(ids({ hidden: new Set(), narrowing: false }));
    expect(ids({})).toHaveLength(7);
  });
});

describe("desenho dos flutuantes e dos nós: elevação, pulso, papéis de tipo", () => {
  const ui = (rel: string): string => readFileSync(join(import.meta.dir, "../../../kit/panel/ui", rel), "utf8");
  const FLOATING = ["argos/canvas-legend.tsx", "argos/canvas-composer.tsx", "argos/supervisor.tsx", "argos/canvas-toolbar.tsx", "argos/canvas-controls.tsx", "argos/canvas-minimap.tsx", "argos/node-balloon.tsx", "argos/parts.tsx"];

  test.each(FLOATING)("dado %s, então o flutuante usa a elevação única e nenhuma sombra solta", (file) => {
    const src = ui(file);
    expect(src).toContain("elev-float");
    expect(src).not.toMatch(/\bshadow(-sm|-lg)?\b/);
  });
  test("dado o index.html, então elev-float e t-control existem e o pulso só anima sem prefers-reduced-motion", () => {
    const html = ui("index.html");
    expect(html).toContain("@utility elev-float");
    expect(html).toContain("@utility t-control");
    expect(html).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{ \.pulso \{ animation: pulso/);
    expect(html).not.toMatch(/^\.pulso \{ animation/m);
  });
  test("dado o corpo do nó, então só quem pede atenção pulsa", () => {
    const parts = ui("argos/parts.tsx");
    expect(parts).toContain("sev === 'attention' && 'pulso'");
    expect(parts).toContain("k === 'warn' && 'pulso'");
    expect(parts).not.toContain("'vivo' && 'pulso'");
  });
  test("dado o corpo do nó, então o texto longo corta por largura e o título guarda o texto inteiro", () => {
    const parts = ui("argos/parts.tsx");
    expect(parts).not.toMatch(/\bclip\(/);
    expect(parts).toContain("title={role}");
    expect(parts).toContain("t-meta-em");
  });
  test("dado o título do nó, então nota e terminal usam t-body-strong e o papel do terminal não leva borda", () => {
    expect(ui("argos/node-note.tsx")).not.toContain("font-semibold");
    const terminal = ui("argos/node-terminal.tsx");
    expect(terminal).not.toMatch(/truncate font-medium/);
    expect(terminal).not.toContain("border px-1 t-micro\"\n");
  });
  test("dada a legenda, então o cabeçalho da seção é micro em caixa-alta e os itens ficam em t-label", () => {
    const legend = ui("argos/canvas-legend.tsx");
    expect(legend).toContain("t-micro uppercase tracking-[0.04em]");
    expect(legend).toContain("grid gap-1 t-label");
  });
});

describe("estados e textos: erro do grafo, selo de gravação, falha de ação", () => {
  test("dado o código do grafo, então vira frase e o código cru nunca aparece", () => {
    for (const code of ["graph_failed", "graph_unreachable", "http_403", "http_500"]) {
      const text = L.graphErrorText(code);
      expect(text).not.toContain(code);
      expect(text.length).toBeGreaterThan(10);
    }
    expect(L.graphErrorText("codigo_do_futuro")).toBe("O painel recusou a leitura dos agentes.");
    expect(L.graphErrorText(undefined)).toBe("O painel recusou a leitura dos agentes.");
  });

  test("dado poucas falhas de gravação, então o selo é discreto; a partir da terceira, fala por extenso", () => {
    const quiet = L.saveBadgeOf("http_403", L.SAVE_LOUD_AFTER - 1);
    expect(quiet).toMatchObject({ label: "Sem salvar", loud: false });
    expect(quiet.title).toContain("http_403");
    expect(quiet.title).toContain("seguem na tela");
    const loud = L.saveBadgeOf("http_403", L.SAVE_LOUD_AFTER);
    expect(loud.loud).toBe(true);
    expect(loud.label.startsWith("Não deu para gravar o canvas: ")).toBe(true);
    expect(loud.label).not.toContain("http_403");
  });

  test("dado código sem tradução na gravação, então a frase de reserva entra no lugar do código", () => {
    const badge = L.saveBadgeOf("codigo_do_futuro", L.SAVE_LOUD_AFTER);
    expect(badge.label).toBe("Não deu para gravar o canvas: a gravação foi recusada");
  });

  test("dada uma ação, então o aviso de falha é 'Não deu para <verbo>' e toda ação tem verbo", () => {
    expect(L.actionFailTitle("prompt")).toBe("Não deu para enviar o prompt");
    expect(L.actionFailTitle("nao_existe")).toBe("Não deu para rodar a ação");
    for (const a of L.ACTIONS) expect(a.verb.length).toBeGreaterThan(3);
  });

  test("dado o seletor de estado, então um nome por conceito: 'Sem sinal' e 'sem terminal', sem jargão", () => {
    const labels = L.STATE_FILTERS.map((f) => f.label);
    expect(labels).toContain("Sem sinal");
    expect(labels).toContain("Ociosos ou sem terminal");
    expect(labels.join(" ")).not.toMatch(/herdr|sem evento/);
  });

  test("dadas as dicas das ações, então dizem o efeito e o comando vem depois, como 'Equivale a'", () => {
    const hint = (id: string): string => L.ACTIONS.find((a) => a.id === id)?.hint ?? "";
    expect(hint("answer")).toMatch(/^Responde a pergunta/);
    expect(hint("answer")).toContain("Equivale a: hades agent answer");
    expect(L.ACTIONS.map((a) => a.hint).join(" ")).not.toMatch(/send-keys|send-text/);
    expect(L.ACTIONS.find((a) => a.id === "free_prompt")?.label).toBe("Digitar e dar Enter");
  });
});
