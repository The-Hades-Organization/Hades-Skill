// Grupo canvas-urlstate: estado do canvas na URL e vistas salvas (src/lib/canvas-urlstate.ts) — ida e volta exata de
// câmera, filtros, busca e nó aberto; hash inválido, grande demais ou de versão desconhecida vira o padrão com aviso
// (nunca exceção); vistas de câmera com nome único (adicionar, renomear, remover, ler do armazenamento).
import { describe, expect, test } from "bun:test";
import { CAMERA_LIMITS, DEFAULT_CAMERA } from "../../../src/lib/canvas-camera";
import { CANVAS_LIMITS } from "../../../src/lib/canvas-doc";
import { FILTER_DIMS } from "../../../src/lib/canvas-filters";
import { SEARCH_LIMITS } from "../../../src/lib/canvas-search";
import {
  URLSTATE_BASE, URLSTATE_LIMITS, URLSTATE_VERSION, URLSTATE_WARNINGS, UrlStateError, VIEW_ERRORS, VIEW_LIMITS,
  addView, defaultUrlState, isValidCamera, parseUrlState, readViews, removeView, renameView, serializeUrlState,
  type SavedView, type UrlState,
} from "../../../src/lib/canvas-urlstate";

const FULL: UrlState = {
  camera: { x: -1234.5678901234567, y: 0.1 + 0.2, k: 0.3333333333333333 },
  filters: { state: ["working", "à espera & +"], type: ["agent"], edgeKind: ["stack", "agent_pr"], role: ["-"], registry: ["owner__repo"], age: ["m15"], cost: ["high"] },
  search: "#123 ação=1&x?y#z",
  node: "agent:owner__repo:impl-1",
};

describe("canvas-urlstate: ida e volta", () => {
  test("dado o estado padrão, então o hash é só a base e volta ao padrão sem aviso", () => {
    expect(serializeUrlState(defaultUrlState())).toBe(URLSTATE_BASE);
    expect(parseUrlState(URLSTATE_BASE)).toEqual({ state: defaultUrlState() });
    expect(parseUrlState(`${URLSTATE_BASE}?`)).toEqual({ state: defaultUrlState() });
  });

  test("dado um estado completo, então volta exatamente igual (inclui números de ponto flutuante e texto especial)", () => {
    const read = parseUrlState(serializeUrlState(FULL));
    expect(read.warning).toBeUndefined();
    expect(read.state).toEqual(FULL);
    expect(read.state.camera).toEqual(FULL.camera);
  });

  test("dado cada parte sozinha, então volta igual", () => {
    const parts: UrlState[] = [
      { ...defaultUrlState(), camera: { x: 0, y: 0, k: 1 } },
      { ...defaultUrlState(), filters: { cost: ["low"] } },
      { ...defaultUrlState(), search: "x" },
      { ...defaultUrlState(), node: "gate:99" },
    ];
    for (const state of parts) expect(parseUrlState(serializeUrlState(state)).state).toEqual(state);
  });

  test("dado número em notação científica e zero negativo, então volta exato (menos o sinal do zero)", () => {
    const camera = { x: 1e-7, y: -0, k: 4 };
    const read = parseUrlState(serializeUrlState({ ...defaultUrlState(), camera }));
    expect(read.state.camera).toEqual({ x: 1e-7, y: 0, k: 4 });
    expect(Object.is(read.state.camera?.y, 0)).toBe(true);
  });

  test("dado os limites da câmera, então são aceitos", () => {
    for (const k of [CAMERA_LIMITS.zoomMin, CAMERA_LIMITS.zoomMax]) {
      const state = { ...defaultUrlState(), camera: { x: CANVAS_LIMITS.coordinate, y: -CANVAS_LIMITS.coordinate, k } };
      expect(parseUrlState(serializeUrlState(state)).state).toEqual(state);
    }
  });

  test("dado a ordem dos valores de filtro, então é preservada", () => {
    const state = { ...defaultUrlState(), filters: { state: ["z", "a", "m"] } };
    expect(parseUrlState(serializeUrlState(state)).state.filters.state).toEqual(["z", "a", "m"]);
  });

  test("dado o mesmo estado, então o hash é o mesmo (determinístico) e a versão vai nele", () => {
    expect(serializeUrlState(FULL)).toBe(serializeUrlState(structuredClone(FULL)));
    expect(serializeUrlState(FULL)).toContain(`v=${URLSTATE_VERSION}`);
  });

  test("dado outra base de rota, então serializa e lê com ela", () => {
    const hash = serializeUrlState({ ...defaultUrlState(), search: "x" }, "#/outra");
    expect(hash.startsWith("#/outra?")).toBe(true);
    expect(parseUrlState(hash, "#/outra").state.search).toBe("x");
    expect(parseUrlState(hash).warning).toBe(URLSTATE_WARNINGS.invalid);
  });

  test("dado o link direto que já existe (`?node=<id>`, sem versão), então abre o nó; qualquer outra forma sem versão é recusada", () => {
    expect(parseUrlState(`${URLSTATE_BASE}?node=agent:p:a`)).toEqual({ state: { ...defaultUrlState(), node: "agent:p:a" } });
    for (const hash of [`${URLSTATE_BASE}?node=`, `${URLSTATE_BASE}?node=a/b`, `${URLSTATE_BASE}?node=a&q=x`, `${URLSTATE_BASE}?node=a&node=b`]) {
      expect(parseUrlState(hash)).toEqual({ state: defaultUrlState(), warning: URLSTATE_WARNINGS.invalid });
    }
  });
});

describe("canvas-urlstate: hash inválido", () => {
  const v = `v=${URLSTATE_VERSION}`;
  const invalid = (hash: string): void => {
    const read = parseUrlState(hash);
    expect(read.warning).toBe(URLSTATE_WARNINGS.invalid);
    expect(read.state).toEqual(defaultUrlState());
  };

  test("dado hash de outra rota, vazio ou sem versão, então padrão com aviso", () => {
    for (const hash of ["", "#/outra?v=1", "#/argos2", `${URLSTATE_BASE}?q=x`, "lixo"]) invalid(hash);
  });

  test("dado versão desconhecida (mais nova), então padrão com aviso de versão, mesmo com campos que não conhecemos", () => {
    const read = parseUrlState(`${URLSTATE_BASE}?v=2&futuro=1`);
    expect(read).toEqual({ state: defaultUrlState(), warning: URLSTATE_WARNINGS.unsupportedVersion });
    expect(parseUrlState(`${URLSTATE_BASE}?v=0`).warning).toBe(URLSTATE_WARNINGS.unsupportedVersion);
  });

  test("dado versão que nem é número, então padrão com aviso de inválido", () => {
    for (const bad of ["x", "", "1.5", "-1", "1e3"]) invalid(`${URLSTATE_BASE}?v=${bad}`);
  });

  test("dado campo desconhecido, dimensão desconhecida ou chave repetida, então recusa", () => {
    invalid(`${URLSTATE_BASE}?${v}&zzz=1`);
    invalid(`${URLSTATE_BASE}?${v}&f.nope=1`);
    invalid(`${URLSTATE_BASE}?${v}&f.=1`);
    invalid(`${URLSTATE_BASE}?${v}&q=a&q=b`);
    invalid(`${URLSTATE_BASE}?${v}&node=a&node=b`);
    invalid(`${URLSTATE_BASE}?${v}&v=1`);
  });

  test("dado câmera incompleta, não numérica, não finita ou fora dos limites, então recusa", () => {
    invalid(`${URLSTATE_BASE}?${v}&cx=1&cy=2`);
    for (const bad of ["abc", "NaN", "Infinity", "1e999", "0x10", "", "1,5", ".5", "1."]) invalid(`${URLSTATE_BASE}?${v}&cx=${bad}&cy=0&ck=1`);
    invalid(`${URLSTATE_BASE}?${v}&cx=0&cy=0&ck=0`);
    invalid(`${URLSTATE_BASE}?${v}&cx=0&cy=0&ck=-1`);
    invalid(`${URLSTATE_BASE}?${v}&cx=0&cy=0&ck=${CAMERA_LIMITS.zoomMax + 0.01}`);
    invalid(`${URLSTATE_BASE}?${v}&cx=0&cy=0&ck=${CAMERA_LIMITS.zoomMin / 2}`);
    invalid(`${URLSTATE_BASE}?${v}&cx=${CANVAS_LIMITS.coordinate + 1}&cy=0&ck=1`);
  });

  test("dado filtro com valor vazio, longo demais ou repetido, ou id de nó inválido, então recusa", () => {
    invalid(`${URLSTATE_BASE}?${v}&f.state=`);
    invalid(`${URLSTATE_BASE}?${v}&f.state=${"x".repeat(URLSTATE_LIMITS.valueChars + 1)}`);
    invalid(`${URLSTATE_BASE}?${v}&f.state=a&f.state=a`);
    invalid(`${URLSTATE_BASE}?${v}&node=${encodeURIComponent("a/b")}`);
    invalid(`${URLSTATE_BASE}?${v}&node=`);
    invalid(`${URLSTATE_BASE}?${v}&q=${"x".repeat(SEARCH_LIMITS.termChars + 1)}`);
  });

  test("dado valores demais numa dimensão, então recusa", () => {
    const many = Array.from({ length: URLSTATE_LIMITS.valuesPerDim + 1 }, (_, i) => `f.state=v${i}`).join("&");
    invalid(`${URLSTATE_BASE}?${v}&${many}`);
  });

  test("dado hash acima do teto, então aviso de tamanho, sem ler o resto", () => {
    const read = parseUrlState(`${URLSTATE_BASE}?${v}&q=${"x".repeat(URLSTATE_LIMITS.hashChars)}`);
    expect(read).toEqual({ state: defaultUrlState(), warning: URLSTATE_WARNINGS.tooLong });
  });

  test("dado percentual malformado ou entrada que não é texto, então não lança", () => {
    expect(() => parseUrlState(`${URLSTATE_BASE}?${v}&q=%E0%A4%A`)).not.toThrow();
    expect(parseUrlState(`${URLSTATE_BASE}?${v}&q=%zz`).state.search).toBe("%zz");
    expect(parseUrlState(undefined as unknown as string).warning).toBe(URLSTATE_WARNINGS.invalid);
    expect(parseUrlState(42 as unknown as string).warning).toBe(URLSTATE_WARNINGS.invalid);
  });

  test("dado entrada hostil (`__proto__` como dimensão), então recusa sem poluir nada", () => {
    invalid(`${URLSTATE_BASE}?${v}&f.__proto__=x`);
    invalid(`${URLSTATE_BASE}?${v}&__proto__=x`);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test("toda dimensão de filtro conhecida é aceita", () => {
    for (const dim of FILTER_DIMS) expect(parseUrlState(`${URLSTATE_BASE}?${v}&f.${dim}=a`).state.filters[dim]).toEqual(["a"]);
  });
});

describe("canvas-urlstate: serializar estado inválido", () => {
  const code = (state: UrlState): string | undefined => {
    try {
      serializeUrlState(state);
      return undefined;
    } catch (error) {
      expect(error).toBeInstanceOf(UrlStateError);
      return (error as UrlStateError).code;
    }
  };

  test("dado câmera inválida, busca longa, nó inválido ou filtro inválido, então lança com código estável", () => {
    const base = defaultUrlState();
    expect(code({ ...base, camera: { x: Number.NaN, y: 0, k: 1 } })).toBe(URLSTATE_WARNINGS.invalid);
    expect(code({ ...base, camera: { x: 0, y: 0, k: 100 } })).toBe(URLSTATE_WARNINGS.invalid);
    expect(code({ ...base, search: "x".repeat(SEARCH_LIMITS.termChars + 1) })).toBe(URLSTATE_WARNINGS.invalid);
    expect(code({ ...base, node: "a b" })).toBe(URLSTATE_WARNINGS.invalid);
    expect(code({ ...base, filters: { state: [""] } })).toBe(URLSTATE_WARNINGS.invalid);
    expect(code({ ...base, filters: { state: ["a", "a"] } })).toBe(URLSTATE_WARNINGS.invalid);
    expect(code({ ...base, filters: { bogus: ["a"] } as unknown as UrlState["filters"] })).toBe(URLSTATE_WARNINGS.invalid);
  });

  test("dado estado que estoura o teto do hash, então lança aviso de tamanho", () => {
    const filters: UrlState["filters"] = {};
    const dims = ["state", "type", "edgeKind", "role", "registry"] as const;
    for (const dim of dims) filters[dim] = Array.from({ length: URLSTATE_LIMITS.valuesPerDim }, (_, i) => `${"v".repeat(URLSTATE_LIMITS.valueChars - 4)}${i}`);
    expect(code({ ...defaultUrlState(), filters })).toBe(URLSTATE_WARNINGS.tooLong);
  });

  test("isValidCamera aceita a câmera padrão e recusa não finitos", () => {
    expect(isValidCamera(DEFAULT_CAMERA)).toBe(true);
    expect(isValidCamera({ x: Infinity, y: 0, k: 1 })).toBe(false);
  });
});

describe("canvas-urlstate: vistas salvas", () => {
  const cam = { x: 10, y: 20, k: 0.5 };
  const names = (views: readonly SavedView[]): string[] => views.map((v) => v.name);
  const ok = (change: ReturnType<typeof addView>): SavedView[] => {
    if (!change.ok) throw new Error(`falhou: ${change.code}`);
    return change.views;
  };

  test("dado nome novo, então adiciona ao fim, com nome aparado e câmera copiada", () => {
    const camera = { ...cam };
    const views = ok(addView([], "  Visão   geral ", camera));
    expect(views).toEqual([{ name: "Visão geral", camera: cam }]);
    camera.x = 999;
    expect(views[0]?.camera.x).toBe(10);
    expect(names(ok(addView(views, "Gates", cam)))).toEqual(["Visão geral", "Gates"]);
  });

  test("dado nome repetido (mesma caixa ou outra), então recusa e a lista fica como estava", () => {
    const views = ok(addView([], "Geral", cam));
    expect(addView(views, "geral", cam)).toEqual({ ok: false, code: VIEW_ERRORS.nameTaken });
    expect(addView(views, " GERAL ", cam)).toEqual({ ok: false, code: VIEW_ERRORS.nameTaken });
    expect(views.length).toBe(1);
  });

  test("dado nome vazio, só espaços ou acima do teto, então recusa com o código certo", () => {
    expect(addView([], "", cam)).toEqual({ ok: false, code: VIEW_ERRORS.nameEmpty });
    expect(addView([], " \t ", cam)).toEqual({ ok: false, code: VIEW_ERRORS.nameEmpty });
    expect(addView([], "x".repeat(VIEW_LIMITS.nameChars + 1), cam)).toEqual({ ok: false, code: VIEW_ERRORS.nameTooLong });
    expect(addView([], "x".repeat(VIEW_LIMITS.nameChars), cam).ok).toBe(true);
  });

  test("dado câmera inválida, então recusa", () => {
    expect(addView([], "x", { x: 0, y: 0, k: 0 })).toEqual({ ok: false, code: VIEW_ERRORS.invalidCamera });
    expect(addView([], "x", { x: Number.NaN, y: 0, k: 1 })).toEqual({ ok: false, code: VIEW_ERRORS.invalidCamera });
  });

  test("dado o teto de vistas, então a seguinte é recusada", () => {
    let views: SavedView[] = [];
    for (let i = 0; i < VIEW_LIMITS.count; i++) views = ok(addView(views, `v${i}`, cam));
    expect(addView(views, "a mais", cam)).toEqual({ ok: false, code: VIEW_ERRORS.limit });
  });

  test("dado renomear, então mantém a posição e a câmera; trocar só a caixa do próprio nome vale", () => {
    const views = ok(addView(ok(addView([], "A", cam)), "B", { x: 1, y: 2, k: 1 }));
    const renamed = ok(renameView(views, "a", "  Alfa "));
    expect(names(renamed)).toEqual(["Alfa", "B"]);
    expect(renamed[0]?.camera).toEqual(cam);
    expect(names(ok(renameView(views, "B", "b")))).toEqual(["A", "b"]);
    expect(names(ok(renameView(views, "A", "A")))).toEqual(["A", "B"]);
  });

  test("dado renomear para nome de outra vista, inexistente de origem ou nome inválido, então recusa", () => {
    const views = ok(addView(ok(addView([], "A", cam)), "B", cam));
    expect(renameView(views, "A", "b")).toEqual({ ok: false, code: VIEW_ERRORS.nameTaken });
    expect(renameView(views, "Z", "C")).toEqual({ ok: false, code: VIEW_ERRORS.notFound });
    expect(renameView(views, "A", " ")).toEqual({ ok: false, code: VIEW_ERRORS.nameEmpty });
    expect(renameView(views, "A", "x".repeat(VIEW_LIMITS.nameChars + 1))).toEqual({ ok: false, code: VIEW_ERRORS.nameTooLong });
  });

  test("dado remover, então tira pelo nome (sem caixa) e recusa o inexistente; o nome volta a ficar livre", () => {
    const views = ok(addView(ok(addView([], "A", cam)), "B", cam));
    const rest = ok(removeView(views, " a "));
    expect(names(rest)).toEqual(["B"]);
    expect(removeView(rest, "A")).toEqual({ ok: false, code: VIEW_ERRORS.notFound });
    expect(removeView([], "A")).toEqual({ ok: false, code: VIEW_ERRORS.notFound });
    expect(addView(rest, "A", cam).ok).toBe(true);
  });

  test("não altera a lista recebida", () => {
    const views = ok(addView([], "A", cam));
    const copy = structuredClone(views);
    addView(views, "B", cam);
    renameView(views, "A", "C");
    removeView(views, "A");
    expect(views).toEqual(copy);
  });
});

describe("canvas-urlstate: ler vistas do armazenamento", () => {
  const good = { name: "Geral", camera: { x: 0, y: 0, k: 1 } };

  test("dado lista válida, então volta igual sem descartes", () => {
    expect(readViews([good, { name: "B", camera: { x: 1, y: 2, k: 2 } }])).toEqual({ views: [good, { name: "B", camera: { x: 1, y: 2, k: 2 } }], dropped: 0, notAList: false });
  });

  test("dado lista vazia, então vem vazia sem descartes", () => {
    expect(readViews([])).toEqual({ views: [], dropped: 0, notAList: false });
  });

  test("dado valor que não é lista, então nada é aproveitado e isso é dito", () => {
    for (const raw of [null, undefined, "x", 3, { name: "a" }]) expect(readViews(raw)).toEqual({ views: [], dropped: 0, notAList: true });
  });

  test("dado entradas ruins misturadas, então ficam as boas e as ruins são contadas", () => {
    const raw = [
      good, null, "x", { name: 1, camera: { x: 0, y: 0, k: 1 } }, { name: "sem camera" }, { name: "k ruim", camera: { x: 0, y: 0, k: 0 } },
      { name: "texto", camera: { x: "0", y: 0, k: 1 } }, { name: "geral", camera: { x: 5, y: 5, k: 1 } }, { name: " ", camera: { x: 0, y: 0, k: 1 } },
    ];
    const read = readViews(raw);
    expect(read.views).toEqual([good]);
    expect(read.dropped).toBe(raw.length - 1);
  });

  test("dado mais vistas que o teto, então o excedente é descartado e contado", () => {
    const raw = Array.from({ length: VIEW_LIMITS.count + 7 }, (_, i) => ({ name: `v${i}`, camera: { x: 0, y: 0, k: 1 } }));
    const read = readViews(raw);
    expect(read.views.length).toBe(VIEW_LIMITS.count);
    expect(read.dropped).toBe(7);
  });

  test("dado campo extra na entrada, então não vaza para a vista", () => {
    const read = readViews([{ name: "A", camera: { x: 0, y: 0, k: 1, extra: 1 }, evil: true }]);
    expect(read.views).toEqual([{ name: "A", camera: { x: 0, y: 0, k: 1 } }]);
  });
});

// ---- modo foco (`focus=1`): escalar aditivo; ausente = desligado, e os links já emitidos seguem valendo ----
describe("canvas-urlstate: foco", () => {
  test("dado o foco ligado, então o hash leva focus=1 e volta ligado", () => {
    const state: UrlState = { ...defaultUrlState(), focus: true };
    expect(serializeUrlState(state)).toBe(`${URLSTATE_BASE}?focus=1&v=1`);
    expect(parseUrlState(serializeUrlState(state))).toEqual({ state });
  });

  test("dado o foco junto de câmera, filtro, busca, nó e preset, então tudo volta igual", () => {
    const state: UrlState = { ...FULL, preset: "attention", focus: true };
    expect(parseUrlState(serializeUrlState(state))).toEqual({ state });
  });

  test("dado o foco desligado ou ausente, então o hash não o leva e a leitura não inventa a chave", () => {
    expect(serializeUrlState({ ...defaultUrlState(), focus: false })).toBe(URLSTATE_BASE);
    expect(serializeUrlState({ ...FULL, focus: false })).toBe(serializeUrlState(FULL));
    expect(parseUrlState(`${URLSTATE_BASE}?q=a&v=1`).state).not.toHaveProperty("focus");
    expect(defaultUrlState()).not.toHaveProperty("focus");
  });

  test("dado valor de foco que não é 1, vazio ou repetido, então é o padrão com urlstate_invalid", () => {
    for (const bad of ["focus=0", "focus=", "focus=true", "focus=1&focus=1"]) {
      expect(parseUrlState(`${URLSTATE_BASE}?${bad}&v=1`)).toEqual({ state: defaultUrlState(), warning: URLSTATE_WARNINGS.invalid });
    }
  });

  test("dado estado com foco que não é booleano, então serializar lança urlstate_invalid", () => {
    const state = { ...defaultUrlState(), focus: 1 } as unknown as UrlState;
    expect(() => serializeUrlState(state)).toThrow(UrlStateError);
  });

  test("dado o link antigo `?node=` e um hash emitido antes do foco, então seguem valendo, desligados", () => {
    expect(parseUrlState(`${URLSTATE_BASE}?node=agent:a`)).toEqual({ state: { ...defaultUrlState(), node: "agent:a" } });
    const before = serializeUrlState(FULL);
    expect(parseUrlState(before)).toEqual({ state: FULL });
    // sem versão só o `?node=` antigo vale: o foco não abre exceção nova
    expect(parseUrlState(`${URLSTATE_BASE}?focus=1`).warning).toBe(URLSTATE_WARNINGS.invalid);
  });
});
