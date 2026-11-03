/// <reference path="../../../kit/panel/ui/select-logic.tsx" />
// Select do painel: regra pura do teclado e da seleção (select-logic.tsx), guarda do select nativo e a fiação no app.
// Contrato: reference/panel.md §Select.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SELECT_PENDING, nativeSelectFiles, selectGuardProblems } from "../../../src/panel/select-guard.ts";
import "../../../kit/panel/ui/select-logic.tsx";

type Logic = ReturnType<typeof makeSelectLogic>;
const L = (globalThis as unknown as { SelectLogic: Logic }).SelectLogic;
const UI = join(import.meta.dir, "../../../kit/panel/ui");
const read = (f: string): string => readFileSync(join(UI, f), "utf8");

const it = (value: string, extra: Partial<SelectItem> = {}): SelectItem => ({ value, label: value.toUpperCase(), ...extra });
const ABC = [it("a"), it("b"), it("c")];
const key = (k: string, extra: Partial<SelectKeyEvent> = {}): SelectKeyEvent => ({ key: k, ...extra });
const open = (active: number): SelectState => ({ ...L.initial(), open: true, active });

describe("Select: abrir pelo teclado", () => {
  for (const k of ["ArrowDown", "ArrowUp", "Enter", " "]) {
    test(`dado o gatilho fechado, quando ${JSON.stringify(k)}, então abre na opção selecionada`, () => {
      const s = L.keyStep(ABC, "b", L.initial(), key(k), 0, false);
      expect(s.state).toMatchObject({ open: true, active: 1 });
      expect(s.handled).toBe(true);
    });
  }
  test("dado o valor fora da lista, quando abre, então a ativa é a primeira habilitada", () => {
    const items = [it("a", { disabled: true }), it("b")];
    expect(L.keyStep(items, "", L.initial(), key("Enter"), 0, false).state.active).toBe(1);
  });
  test("dado o gatilho fechado, quando Home e End, então abre na primeira e na última habilitada", () => {
    const items = [it("a", { disabled: true }), it("b"), it("c"), it("d", { disabled: true })];
    expect(L.keyStep(items, "c", L.initial(), key("Home"), 0, false).state.active).toBe(1);
    expect(L.keyStep(items, "b", L.initial(), key("End"), 0, false).state.active).toBe(2);
  });
  test("dado Ctrl+tecla, então não é tratada", () => {
    expect(L.keyStep(ABC, "a", L.initial(), key("ArrowDown", { ctrlKey: true }), 0, false).handled).toBe(false);
  });
});

describe("Select: navegar na lista aberta", () => {
  test("dado Seta para baixo e para cima, então anda uma opção e para nas pontas, sem dar a volta", () => {
    expect(L.move(ABC, 0, "ArrowDown")).toBe(1);
    expect(L.move(ABC, 2, "ArrowDown")).toBe(2);
    expect(L.move(ABC, 2, "ArrowUp")).toBe(1);
    expect(L.move(ABC, 0, "ArrowUp")).toBe(0);
  });
  test("dada opção desabilitada no caminho, então as setas pulam por cima dela", () => {
    const items = [it("a"), it("b", { disabled: true }), it("c")];
    expect(L.move(items, 0, "ArrowDown")).toBe(2);
    expect(L.move(items, 2, "ArrowUp")).toBe(0);
  });
  test("dada desabilitada só no fim, então a seta para baixo fica onde está", () => {
    const items = [it("a"), it("b", { disabled: true })];
    expect(L.move(items, 0, "ArrowDown")).toBe(0);
  });
  test("dado Home e End, então vão à primeira e à última habilitada", () => {
    const items = [it("a", { disabled: true }), it("b"), it("c"), it("d", { disabled: true })];
    expect(L.move(items, 2, "Home")).toBe(1);
    expect(L.move(items, 1, "End")).toBe(2);
  });
  test("dado PageDown e PageUp, então andam um bloco e param nas pontas", () => {
    const many = Array.from({ length: 30 }, (_, i) => it(`v${i}`));
    expect(L.move(many, 0, "PageDown")).toBe(10);
    expect(L.move(many, 25, "PageDown")).toBe(29);
    expect(L.move(many, 12, "PageUp")).toBe(2);
    expect(L.move(many, 3, "PageUp")).toBe(0);
  });
  test("dada lista vazia ou só de desabilitadas, então não há ativa", () => {
    expect(L.move([], 0, "ArrowDown")).toBe(-1);
    expect(L.move([it("a", { disabled: true })], -1, "ArrowDown")).toBe(-1);
    expect(L.initialActive([it("a", { disabled: true })], "a")).toBe(-1);
  });
  test("dada tecla que não navega, então o índice não muda", () => {
    expect(L.move(ABC, 1, "x")).toBe(1);
  });
});

describe("Select: escolher e fechar", () => {
  test("dada a lista aberta, quando Enter, então escolhe a ativa e fecha", () => {
    const s = L.keyStep(ABC, "a", open(2), key("Enter"), 0, false);
    expect(s.pick).toBe("c");
    expect(s.state.open).toBe(false);
  });
  test("dada a lista aberta, quando Espaço sem busca, então escolhe; com busca, o Espaço é texto", () => {
    expect(L.keyStep(ABC, "a", open(1), key(" "), 0, false).pick).toBe("b");
    const withSearch = L.keyStep(ABC, "a", open(1), key(" "), 0, true);
    expect(withSearch.pick).toBeUndefined();
    expect(withSearch.handled).toBe(false);
  });
  test("dada ativa desabilitada ou nenhuma, quando Enter, então fecha sem escolher", () => {
    const disabled = L.keyStep([it("a", { disabled: true })], "", open(0), key("Enter"), 0, false);
    expect(disabled.pick).toBeUndefined();
    expect(disabled.state.open).toBe(false);
    expect(L.keyStep([], "", open(-1), key("Enter"), 0, false).pick).toBeUndefined();
  });
  test("dada a lista aberta, quando Esc, então fecha sem escolher e o evento é tratado", () => {
    const s = L.keyStep(ABC, "a", open(1), key("Escape"), 0, false);
    expect(s.pick).toBeUndefined();
    expect(s.handled).toBe(true);
    expect(s.state.open).toBe(false);
  });
  test("dada a lista aberta, quando Tab, então escolhe a ativa, fecha e deixa o foco seguir", () => {
    const s = L.keyStep(ABC, "a", open(1), key("Tab"), 0, false);
    expect(s).toMatchObject({ pick: "b", handled: false, state: { open: false } });
  });
});

describe("Select: digitar para pular", () => {
  const FRUTAS = [it("m", { label: "Maçã" }), it("l", { label: "Laranja" }), it("l2", { label: "Limão" }), it("u", { label: "Uva", disabled: true }), it("v", { label: "Uvaia" })];
  test("dada a letra, então pula para a próxima que começa por ela, sem acento nem caixa", () => {
    expect(L.typeahead(FRUTAS, 1, "m")).toBe(0);
    expect(L.typeahead(FRUTAS, 1, "l")).toBe(2);
  });
  test("dada a mesma letra repetida, então percorre as que começam por ela e dá a volta", () => {
    expect(L.typeahead(FRUTAS, 1, "ll")).toBe(2);
    expect(L.typeahead(FRUTAS, 2, "lll")).toBe(1);
  });
  test("dado um texto, então acha a que começa por ele a partir da ativa", () => {
    expect(L.typeahead(FRUTAS, 0, "li")).toBe(2);
    expect(L.typeahead(FRUTAS, 0, "mac")).toBe(0);
  });
  test("dada a opção desabilitada, então não pousa nela", () => {
    expect(L.typeahead(FRUTAS, 0, "uva")).toBe(4);
  });
  test("dado texto sem casamento ou vazio, então fica na ativa", () => {
    expect(L.typeahead(FRUTAS, 2, "zz")).toBe(2);
    expect(L.typeahead(FRUTAS, 2, "")).toBe(2);
  });
  test("dada a pausa maior que o limite, então o texto recomeça; dentro dele, acumula", () => {
    const t0 = L.typedAfter({ text: "", at: 0 }, "l", 1000);
    expect(L.typedAfter(t0, "i", 1000 + L.TYPE_RESET_MS).text).toBe("li");
    expect(L.typedAfter(t0, "i", 1001 + L.TYPE_RESET_MS).text).toBe("i");
  });
  test("dada a lista aberta, quando digita, então a ativa pula; fechada, abre já na que casou", () => {
    expect(L.keyStep(FRUTAS, "m", open(0), key("l"), 5000, false).state.active).toBe(1);
    const closed = L.keyStep(FRUTAS, "m", L.initial(), key("l"), 5000, false);
    expect(closed.state).toMatchObject({ open: true, active: 1 });
  });
  test("dada a busca ligada, quando digita, então a regra não trata (o texto vai ao campo)", () => {
    expect(L.keyStep(FRUTAS, "m", open(0), key("l"), 5000, true).handled).toBe(false);
  });
});

describe("Select: busca, grupos e limite", () => {
  const DOCS = [it("a", { label: "Árvore", group: "Mata" }), it("b", { label: "Rio", group: "Água", hint: "doce" }), it("c", { label: "Lago", group: "Água" }), it("d", { label: "Pedra" })];
  test("dado o limite, então a busca só aparece com mais de 10 opções", () => {
    expect(L.SEARCH_MIN_OPTIONS).toBe(10);
    expect(L.searchable(Array.from({ length: 10 }, (_, i) => it(`${i}`)))).toBe(false);
    expect(L.searchable(Array.from({ length: 11 }, (_, i) => it(`${i}`)))).toBe(true);
  });
  test("dado o filtro, então casa rótulo, dica e grupo sem acento nem caixa", () => {
    expect(L.filter(DOCS, "arvore").map((x) => x.value)).toEqual(["a"]);
    expect(L.filter(DOCS, "DOCE").map((x) => x.value)).toEqual(["b"]);
    expect(L.filter(DOCS, "água").map((x) => x.value)).toEqual(["b", "c"]);
    expect(L.filter(DOCS, "  ").length).toBe(4);
    expect(L.filter(DOCS, "zzz")).toEqual([]);
  });
  test("dados os grupos, então as linhas juntam cada grupo na ordem da primeira aparição, com cabeçalho", () => {
    const r = L.rows(DOCS);
    expect(r.map((x) => (x.kind === "group" ? `# ${x.label}` : x.item.value))).toEqual(["# Mata", "a", "# Água", "b", "c", "d"]);
  });
  test("dado grupo salteado, então ordered põe a lista na ordem da tela e o índice ativo segue ela", () => {
    const items = [it("a", { group: "X" }), it("b", { group: "Y" }), it("c", { group: "X" })];
    expect(L.ordered(items).map((x) => x.value)).toEqual(["a", "c", "b"]);
  });
  test("dada a busca que mudou a lista, então a ativa é a selecionada se ainda aparece, senão a primeira habilitada", () => {
    expect(L.afterFilter(L.filter(DOCS, "água"), "c")).toBe(1);
    expect(L.afterFilter(L.filter(DOCS, "água"), "a")).toBe(0);
    expect(L.afterFilter([], "a")).toBe(-1);
  });
});

describe("guarda: select nativo no painel", () => {
  const TAG = "<" + "select";
  const fixture = (files: Record<string, string>): string => {
    const ui = mkdtempSync(join(tmpdir(), "select-guard-"));
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(ui, name, ".."), { recursive: true });
      writeFileSync(join(ui, name), body);
    }
    return ui;
  };
  const run = (files: Record<string, string>, pending: string[] = [], requireEmpty = false): string[] => {
    const ui = fixture(files);
    try { return selectGuardProblems(ui, pending, requireEmpty); } finally { rmSync(ui, { recursive: true, force: true }); }
  };

  test("dado arquivo com o nativo fora da lista, então reprova com o arquivo", () => {
    expect(run({ "pages/x.tsx": `<div>${TAG} value={v}></div>` })).toEqual(["pages/x.tsx: select nativo fora de SELECT_PENDING (use o Select do painel)"]);
  });
  test("dado arquivo da lista com o nativo, então passa", () => {
    expect(run({ "pages/x.tsx": `${TAG}>` }, ["pages/x.tsx"])).toEqual([]);
  });
  test("dado arquivo da lista sem o nativo, então reprova para a lista não mentir", () => {
    expect(run({ "pages/x.tsx": "<div />" }, ["pages/x.tsx"])).toEqual(["pages/x.tsx: está em SELECT_PENDING mas não tem select nativo, tire da lista"]);
  });
  test("dado o nativo em vendor/, então é ignorado", () => {
    expect(run({ "vendor/lib.js": `${TAG} `, "a.tsx": "" })).toEqual([]);
  });
  test("dado o nativo em comentário, então conta (busca de texto): a prosa diz 'select nativo'", () => {
    expect(run({ "a.tsx": `// ${TAG}> assim` }).length).toBe(1);
  });
  test("dado o componente <Select ou outro nome que só começa parecido, então não conta", () => {
    expect(run({ "a.tsx": "<Select value={v} /><selection />" })).toEqual([]);
  });
  test("dado SELECT_REQUIRE_EMPTY e lista cheia, então reprova mesmo com a lista honesta", () => {
    expect(run({ "pages/x.tsx": TAG }, ["pages/x.tsx"], true)).toEqual(["SELECT_PENDING não está vazia (1 arquivo(s))"]);
    expect(run({ "a.tsx": "" }, [], true)).toEqual([]);
  });
});

describe("Select: o painel de verdade", () => {
  test("dado o kit, então o nativo só existe nos arquivos de SELECT_PENDING (vazia com SELECT_REQUIRE_EMPTY=1)", () => {
    expect(selectGuardProblems(UI, SELECT_PENDING, process.env.SELECT_REQUIRE_EMPTY === "1")).toEqual([]);
    expect(nativeSelectFiles(UI).sort()).toEqual([...SELECT_PENDING].sort());
  });
  test("dado o index.html, então select-logic carrega antes do app", () => {
    const html = read("index.html");
    expect(html.indexOf("/ui/select-logic.js")).toBeGreaterThan(-1);
    expect(html.indexOf("/ui/select-logic.js")).toBeLessThan(html.indexOf("/ui/app.js"));
  });
  test("dado o app, então o Select sai em HadesCore e window.HadesPanel e Choice e LogViewer o usam", () => {
    const app = read("app.tsx");
    expect(app).toMatch(/Segmented, Choice, Select, useWide/);
    expect(app).toMatch(/Tracos, Select,\n\s+registerPage/);
    expect(app).toContain("<Select value={value} onChange={onChange} items={items}");
    expect(app).toContain('<Select size="sm" label="Últimas linhas"');
  });
  test("dado o Select, então o gatilho é combobox, a lista é listbox e a folha de baixo atende o celular", () => {
    const app = read("app.tsx");
    expect(app).toContain('role="combobox" aria-haspopup="listbox"');
    expect(app).toContain('role="listbox"');
    expect(app).toContain('role="option"');
    expect(app).toContain('side="bottom"');
    expect(app).toContain("React.forwardRef(function Select");
  });
});
