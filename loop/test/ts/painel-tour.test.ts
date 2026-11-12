/// <reference path="../../../kit/panel/ui/tour-logic.tsx" />
/// <reference path="../../../kit/panel/ui/globals.d.ts" />
// Tour por página do painel (reference/panel.md §Tour por página): registro, prévia de exemplo, bloqueio do post, atalho,
// progresso e a guarda que exige tour em toda página do núcleo (TOUR_PENDING enquanto os lotes não chegaram).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { TOUR_PENDING, tourGuardProblems, tourTargetsIn } from "../../../src/panel/tour-guard.ts";
import { TOURS_MARKER, tourScriptTags } from "../../../src/panel/ui-tours.ts";
import "../../../kit/panel/ui/tour-logic.tsx";

const UI = join(import.meta.dir, "../../../kit/panel/ui");
const read = (rel: string): string => readFileSync(join(UI, rel), "utf8");
const factory = (globalThis as unknown as { TourLogicFactory: () => TourLogicApi }).TourLogicFactory;
const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `t ${id}`, body: `b ${id}`, ...extra });
const memory = (): TourStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};

describe("registro do tour", () => {
  test("dado um tour válido, quando registra, então a página tem tour e os passos voltam como foram", () => {
    const t = factory();
    t.register("x", { steps: [step("a", { command: "hades x", ref: "panel.md", fallback: "falta y", side: "top" })] });
    expect(t.has("x")).toBe(true);
    expect(t.has("y")).toBe(false);
    expect(t.get("x")?.steps[0]).toMatchObject({ id: "a", command: "hades x", side: "top" });
  });
  test("dado tour malformado, então falha ao registrar com a página no texto", () => {
    const t = factory();
    expect(() => t.register("x", { steps: [] })).toThrow("registerTour(\"x\")");
    expect(() => t.register("x", { steps: [step("a", { title: " " })] })).toThrow("id, title e body");
    expect(() => t.register("x", { steps: [step("a", { command: "" })] })).toThrow("command, ref e fallback");
    expect(() => t.register("x", { steps: [step("a", { side: "meio" })] })).toThrow("side inválido");
    expect(() => t.register("x", { steps: [step("a"), step("a")] })).toThrow("passo repetido");
    expect(() => t.register("x", { steps: [step("a")], preview: 3 as unknown as () => unknown })).toThrow("preview deve ser função");
    expect(() => t.register("", { steps: [step("a")] })).toThrow("id vazio");
    expect(t.ids()).toEqual([]);
  });
  test("dada página trocada pelo plugin sem tour, quando solta o tour, então a página fica sem ele", () => {
    const t = factory();
    t.register("x", { steps: [step("a")] });
    t.drop("x");
    expect(t.has("x")).toBe(false);
  });
});

describe("prévia de exemplo", () => {
  test("dado tour com prévia, quando começa, então a página lê o exemplo; ao terminar volta ao real (null)", () => {
    const t = factory();
    const data = { items: [1] };
    t.register("x", { steps: [step("a")], preview: () => data });
    expect(t.previewOf("x")).toBeNull();
    expect(t.begin("x")).toBe(true);
    expect(t.previewOf("x")).toBe(data);
    expect(t.previewing()).toBe(true);
    expect(t.previewOf("outra")).toBeNull();
    t.end();
    expect([t.previewOf("x"), t.previewing(), t.running()]).toEqual([null, false, null]);
  });
  test("dado tour sem prévia, quando começa, então roda na tela real", () => {
    const t = factory();
    t.register("x", { steps: [step("a")] });
    t.begin("x");
    expect([t.running(), t.previewing(), t.previewOf("x")]).toEqual(["x", false, null]);
  });
  test("dada prévia que falha, então o tour roda sem exemplo, sem derrubar", () => {
    const t = factory();
    t.register("x", { steps: [step("a")], preview: () => { throw new Error("quebrou"); } });
    const was = console.error;
    console.error = () => {};
    try { expect(t.begin("x")).toBe(true); } finally { console.error = was; }
    expect([t.running(), t.previewing()]).toEqual(["x", false]);
  });
  test("dada página sem tour, quando pede para começar, então recusa e nada liga", () => {
    const t = factory();
    expect(t.begin("x")).toBe(false);
    expect(t.running()).toBeNull();
  });
  test("dado quem assina, quando liga e desliga, então é avisado em cada mudança e para depois de cancelar", () => {
    const t = factory();
    t.register("x", { steps: [step("a")], preview: () => ({}) });
    let calls = 0;
    const off = t.subscribe(() => { calls += 1; });
    t.begin("x");
    t.end();
    t.end();
    expect(calls).toBe(2);
    off();
    t.begin("x");
    expect(calls).toBe(2);
  });
});

describe("post durante a prévia", () => {
  // o post do app.tsx, extraído do fonte: mesma função que o navegador roda
  const postOf = (t: TourLogicApi, fetchCalls: string[]) => {
    const src = read("app.tsx");
    const from = src.indexOf("async function post(");
    const body = src.slice(from, src.indexOf("\n}\n", from) + 3);
    const fetchStub = async (path: string) => { fetchCalls.push(path); return { status: 200, ok: true, json: async () => ({ ok: true }) }; };
    return new Function("TL", "fetch", "window", `${body}\nreturn post;`)(t, fetchStub, { __TOKEN: "x" }) as (path: string, body: unknown) => Promise<unknown>;
  };
  test("dada a prévia ligada, quando a página faz post, então recusa com código estável e sem rede", async () => {
    const t = factory();
    t.register("x", { steps: [step("a")], preview: () => ({}) });
    const calls: string[] = [];
    const post = postOf(t, calls);
    t.begin("x");
    const err = await post("/api/acao", {}).then(() => null, (e: Error & { code?: string }) => e);
    expect(err?.code).toBe(t.TOUR_PREVIEW_ERROR);
    expect(calls).toEqual([]);
  });
  test("dado o tour encerrado, quando faz post, então vai à rede de novo", async () => {
    const t = factory();
    t.register("x", { steps: [step("a")], preview: () => ({}) });
    const calls: string[] = [];
    const post = postOf(t, calls);
    t.begin("x");
    t.end();
    await post("/api/acao", {});
    expect(calls).toEqual(["/api/acao"]);
  });
  test("dado tour sem prévia rodando, quando faz post, então não bloqueia", async () => {
    const t = factory();
    t.register("x", { steps: [step("a")] });
    const calls: string[] = [];
    const post = postOf(t, calls);
    t.begin("x");
    await post("/api/acao", {});
    expect(calls).toHaveLength(1);
  });
});

describe("atalho Shift+?", () => {
  const free = { hasTour: true, typing: false, dialogOpen: false };
  const t = factory();
  test("dado ? fora de campo e com tour, então abre", () => {
    expect(t.opensTour({ key: "?" }, free)).toBe(true);
  });
  test("dado campo de texto, diálogo aberto ou página sem tour, então não abre", () => {
    expect(t.opensTour({ key: "?" }, { ...free, typing: true })).toBe(false);
    expect(t.opensTour({ key: "?" }, { ...free, dialogOpen: true })).toBe(false);
    expect(t.opensTour({ key: "?" }, { ...free, hasTour: false })).toBe(false);
  });
  test("dado o ? que o Argos já tratou (evento marcado), então o atalho da ajuda dele continua e o tour não abre", () => {
    expect(t.opensTour({ key: "?", defaultPrevented: true }, free)).toBe(false);
  });
  test("dado Ctrl, Meta, Alt, repetição ou outra tecla, então não abre", () => {
    for (const e of [{ key: "?", ctrlKey: true }, { key: "?", metaKey: true }, { key: "?", altKey: true }, { key: "?", repeat: true }, { key: "/" }]) expect(t.opensTour(e, free)).toBe(false);
  });
  test("dado tour já rodando, então não abre outro", () => {
    const run = factory();
    run.register("x", { steps: [step("a")] });
    run.begin("x");
    expect(run.opensTour({ key: "?" }, free)).toBe(false);
  });
  test("dado o Argos, então a captura da página marca o evento antes do atalho do painel", () => {
    const argos = read("pages/argos.tsx");
    expect(argos).toContain("addEventListener('keydown', k, true)");
    expect(argos.slice(argos.indexOf("const cmd = commands.resolveKey("))).toContain("e.preventDefault();\n      if (cmd.id === 'palette')");
    expect(read("app.tsx")).toContain("document.addEventListener('keydown', k);");
  });
});

describe("progresso por página", () => {
  test("dado visto e pulado, então cada página guarda o seu e o resto fica", () => {
    const t = factory(), s = memory();
    t.markProgress(s, "thanatos", "seen");
    t.markProgress(s, "caronte", "skip");
    expect(t.readProgress(s)).toEqual({ thanatos: "seen", caronte: "skip" });
  });
  test("dado armazenamento corrompido ou que lança, então lê vazio e não derruba", () => {
    const t = factory(), s = memory();
    s.setItem(t.TOUR_PROGRESS_KEY, "{ruim");
    expect(t.readProgress(s)).toEqual({});
    s.setItem(t.TOUR_PROGRESS_KEY, JSON.stringify({ a: "seen", b: "qualquer", c: 3 }));
    expect(t.readProgress(s)).toEqual({ a: "seen" });
    const broken: TourStorage = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); } };
    expect(t.readProgress(broken)).toEqual({});
    expect(() => t.markProgress(broken, "x", "seen")).not.toThrow();
  });
});

describe("o app e o index.html", () => {
  const app = read("app.tsx");
  test("dado o cabeçalho, então o botão [ ? ] só existe com tour, num lugar só, com a dica", () => {
    expect(app.match(/<PageTourButton /g)).toHaveLength(1);
    expect(app).toContain("{tourId ? <PageTourButton id={tourId} onClick={startTour} /> : null}");
    expect(app).toContain("const tourId = TL.has(cur.id) ? cur.id : null;");
    expect(app).toContain('<Tip text="Tour desta página" side="bottom">');
  });
  test("dada a paleta Ctrl+K, então 'Tour desta página' só aparece com tour", () => {
    expect(app).toContain("...(tourId ? [{ group: 'Painel', icon: I.CircleHelp, label: 'Tour desta página'");
  });
  test("dado o Empty compartilhado, então 'Ver como funciona' só com tour e pode ser desligado", () => {
    expect(app).toContain("{tour && app?.tourId ? <button type=\"button\" onClick={app.startTour}");
    expect(app).toContain("Ver como funciona");
  });
  test("dado plugin, então registerPage aceita { tour } e o tour do núcleo sai se o plugin troca a página sem tour", () => {
    expect(app).toContain("if (PAGES[id] && !opts.tour) TL.drop(id);");
    expect(app).toContain("TL.register(id, opts.tour)");
  });
  test("dado o index.html, então tour-logic carrega antes do app e os tours entram pelo marcador, sem lista à mão", () => {
    const html = read("index.html");
    expect(html.indexOf("/ui/tour-logic.js")).toBeGreaterThan(-1);
    expect(html.indexOf("/ui/tour-logic.js")).toBeLessThan(html.indexOf("/ui/app.js"));
    expect(html).toContain(TOURS_MARKER);
    expect(html).not.toContain(".tour.js");
    expect(html.indexOf(TOURS_MARKER)).toBeGreaterThan(html.indexOf("/ui/pages/docs.js"));
  });
  test("dada a Argos, então a paleta recebe se a página tem tour", () => {
    expect(read("pages/argos.tsx")).toContain("tour: HadesCore.hasTour('argos')");
    expect(read("pages/argos.tsx")).toContain("HadesCore.startPageTour('argos')");
  });
  test("dado o popover, então cabe no celular, rola o alvo e responde ao toque", () => {
    const tour = read("tour.tsx");
    expect(tour).toContain("Math.min(POPOVER_MAX, view.w - 2 * MARGIN)");
    expect(tour).toContain("max-h-[calc(100dvh-24px)]");
    expect(tour).toContain("scrollIntoView");
    expect(tour).toContain("onTouchStart={onTouchStart}");
  });
});

describe("scripts dos tours", () => {
  test("dada a pasta de páginas, então um script por .tour.tsx, em ordem, e nenhum por página sem tour", () => {
    const ui = mkdtempSync(join(tmpdir(), "tour-ui-"));
    try {
      mkdirSync(join(ui, "pages"));
      for (const f of ["b.tour.tsx", "a.tour.tsx", "c.tsx", "x y.tour.tsx"]) writeFileSync(join(ui, "pages", f), "");
      expect(tourScriptTags(ui)).toBe('<script src="/ui/pages/a.tour.js"></script>\n<script src="/ui/pages/b.tour.js"></script>');
      expect(tourScriptTags(join(ui, "nao-existe"))).toBe("");
    } finally { rmSync(ui, { recursive: true, force: true }); }
  });
});

describe("guarda: toda página do núcleo tem tour", () => {
  const fixture = (files: Record<string, string>): string => {
    const ui = mkdtempSync(join(tmpdir(), "tour-guard-"));
    mkdirSync(join(ui, "pages"));
    writeFileSync(join(ui, "tour-logic.tsx"), readFileSync(join(UI, "tour-logic.tsx"), "utf8"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(ui, name), body);
    return ui;
  };
  const tour = (id: string, steps: string): string => `HadesCore.registerTour(${JSON.stringify(id)}, { steps: [${steps}] });`;
  const stepSrc = (id: string, extra = ""): string => `{ id: ${JSON.stringify(id)}, title: "t", body: "b"${extra} }`;
  const run = async (files: Record<string, string>, pending: string[] = []): Promise<string[]> => {
    const ui = fixture(files);
    try { return await tourGuardProblems(ui, pending); } finally { rmSync(ui, { recursive: true, force: true }); }
  };

  test("dada página sem .tour.tsx e fora de TOUR_PENDING, então falha com o arquivo que falta", async () => {
    expect(await run({ "pages/a.tsx": "" })).toEqual(["página a: falta pages/a.tour.tsx"]);
  });
  test("dada página pendente sem tour, então passa; com tour ainda na lista, pede para tirar", async () => {
    expect(await run({ "pages/a.tsx": "" }, ["a"])).toEqual([]);
    const withTour = { "pages/a.tsx": "", "pages/a.tour.tsx": tour("a", stepSrc("tour-a")) };
    expect(await run(withTour, ["a"])).toEqual(['página a: já tem tour, tire "a" de TOUR_PENDING']);
  });
  test("dada pendência que não é página, então acusa a entrada velha", async () => {
    expect(await run({}, ["fantasma"])).toEqual(['TOUR_PENDING lista "fantasma", que não é página do núcleo']);
  });
  test("dado passo cujo alvo não existe no fonte e sem fallback, então falha; com fallback ou alvo, passa", async () => {
    const page = '<div data-tour-step-id="card-um outro" />\n<p data-tour-step-id={\'card-dois\'} />';
    const bad = await run({ "pages/a.tsx": page, "pages/a.tour.tsx": tour("a", [stepSrc("card-um"), stepSrc("card-dois"), stepSrc("sumiu")].join(",")) });
    expect(bad).toEqual(['página a: o passo "sumiu" aponta para data-tour-step-id que não existe no fonte da página e não tem fallback']);
    const ok = await run({ "pages/a.tsx": page, "pages/a.tour.tsx": tour("a", [stepSrc("card-um"), stepSrc("sumiu", ', fallback: "ligue o recurso"'), stepSrc("tour-a")].join(",")) });
    expect(ok).toEqual([]);
  });
  test("dado alvo em pasta da página (argos/), então conta como existente", async () => {
    const ui = fixture({ "pages/a.tsx": "", "pages/a.tour.tsx": tour("a", stepSrc("no-pasta")) });
    try {
      mkdirSync(join(ui, "a"));
      writeFileSync(join(ui, "a", "parte.tsx"), '<i data-tour-step-id="no-pasta" />');
      expect(await tourGuardProblems(ui, [])).toEqual([]);
    } finally { rmSync(ui, { recursive: true, force: true }); }
  });
  test("dado .tour.tsx que registra outra página ou tour malformado, então falha", async () => {
    expect(await run({ "pages/a.tsx": "", "pages/a.tour.tsx": tour("b", stepSrc("x")) })).toEqual(['página a: a.tour.tsx não chama registerTour("a", …)']);
    const malformed = await run({ "pages/a.tsx": "", "pages/a.tour.tsx": tour("a", "") });
    expect(malformed[0]).toContain("a.tour.tsx não registra");
  });
  test("dada a guarda chamada duas vezes no mesmo processo, depois de importar o mesmo .tour.tsx, então o resultado é igual", async () => {
    const files = { "pages/a.tsx": "", "pages/a.tour.tsx": tour("a", stepSrc("tour-a")) };
    const ui = fixture(files);
    try {
      const first = await tourGuardProblems(ui, []);
      // o import do bun guarda o módulo por caminho: quem já o importou (o navegador de teste, outro arquivo) não pode cegar a guarda
      await import(pathToFileURL(join(ui, "pages/a.tour.tsx")).href).catch(() => undefined);
      await import(pathToFileURL(join(UI, "pages/queue.tour.tsx")).href).catch(() => undefined);
      expect(await tourGuardProblems(ui, [])).toEqual(first);
      expect(first).toEqual([]);
      expect(await tourGuardProblems(UI)).toEqual(await tourGuardProblems(UI));
    } finally { rmSync(ui, { recursive: true, force: true }); }
  });
  test("dado o fonte, então o alvo é a palavra entre aspas na linha do data-tour-step-id", () => {
    expect([...tourTargetsIn('x\n<a data-tour-step-id="um dois"/>\nsec.setAttribute(\'data-tour-step-id\', \'tres\');\nsem')].sort()).toEqual(["dois", "tres", "um"]);
  });

  const core = join(UI, "pages");
  const pages = readdirSync(core).filter((n) => n.endsWith(".tsx") && !n.endsWith(".tour.tsx")).map((n) => n.slice(0, -4)).sort();
  test("dado o kit, então TOUR_PENDING só lista páginas sem tour e a Thanatos tem tour", () => {
    expect(pages).toHaveLength(23);
    const withTour = new Set(readdirSync(core).filter((n) => n.endsWith(".tour.tsx")).map((n) => n.slice(0, -".tour.tsx".length)));
    expect(withTour.has("thanatos")).toBe(true);
    expect(TOUR_PENDING.filter((p) => withTour.has(p))).toEqual([]);
    expect([...TOUR_PENDING, ...withTour].sort()).toEqual(pages);
  });
  test("dado o kit, então nenhuma página do núcleo está sem tour fora de TOUR_PENDING e todo passo tem alvo ou fallback", async () => {
    expect(await tourGuardProblems(UI)).toEqual([]);
  });
  test.skipIf(process.env.TOUR_REQUIRE_EMPTY !== "1")("consolidação: TOUR_PENDING vazio", () => {
    expect(TOUR_PENDING).toEqual([]);
  });

  test("dada a Thanatos, então os passos cobrem lista, linha do tempo, causa, correção, lacunas e o comando, e a prévia traz exemplos marcados", async () => {
    const ui = fixture({});
    try {
      const holder = globalThis as unknown as { HadesCore?: unknown };
      const seen: { id: string; def: PanelTour }[] = [];
      holder.HadesCore = { registerTour: (id: string, def: PanelTour) => { seen.push({ id, def }); } };
      await import(`${join(core, "thanatos.tour.tsx")}?teste=${Date.now()}`);
      holder.HadesCore = undefined;
      const def = seen[0]?.def as PanelTour;
      expect(seen[0]?.id).toBe("thanatos");
      expect(def.steps.map((s) => s.id)).toEqual(["tour-thanatos", "thanatos-lista", "thanatos-filtro", "thanatos-linha", "thanatos-causa", "thanatos-correcao", "thanatos-lacunas", "thanatos-gerar"]);
      expect(def.steps.some((s) => s.command === "hades thanatos new 123")).toBe(true);
      const data = (def.preview as () => { items: { id: string; title: string }[]; docs: Record<string, { markdown: string }> })();
      expect(data.items).toHaveLength(2);
      for (const i of data.items) { expect(i.title.startsWith("Exemplo")).toBe(true); expect(data.docs[i.id]?.markdown).toContain("## Causa"); }
    } finally { rmSync(ui, { recursive: true, force: true }); }
  });
});

describe("um tour por vez", () => {
  const logic = (globalThis as unknown as { TourLogicFactory: () => { register(id: string, d: unknown): void; begin(id: string): boolean; end(): void; offerVisible(offered: boolean): boolean } }).TourLogicFactory();
  test("dada a oferta do tour geral, quando o tour de uma página roda, então some, e volta ao terminar", () => {
    logic.register("p", { steps: [{ id: "tour-p", title: "t", body: "b" }] });
    expect(logic.offerVisible(true)).toBe(true);
    logic.begin("p");
    expect(logic.offerVisible(true)).toBe(false);
    logic.end();
    expect(logic.offerVisible(true)).toBe(true);
  });
  test("dada a oferta já dispensada, quando nenhum tour roda, então continua escondida", () => {
    expect(logic.offerVisible(false)).toBe(false);
  });
});
