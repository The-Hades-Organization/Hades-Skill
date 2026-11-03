// Grupo canvas-search: busca do canvas (src/lib/canvas-search.ts) — nome do agente, card, PR (`#123`/`123`), branch e
// arquivo; sem acento e sem caixa; a caixa que enquadra os achados; teto do termo; entrada que parece regex é só texto.
import { describe, expect, test } from "bun:test";
import { SEARCH_LIMITS, SEARCH_PROBLEMS, createSearchIndex, normalizeText, searchNodes, type SearchItem } from "../../../src/lib/canvas-search";

const ITEMS: SearchItem[] = [
  { id: "agent:p:impl-auth", label: "impl-auth", card: "QTO-412", branch: "feat/login-oauth", files: ["src/auth/login.ts", "docs/Ação.md"], x: 0, y: 0, w: 200, h: 66 },
  { id: "agent:p:rev-db", label: "rev-db", card: null, branch: "fix/db-pool", files: ["src/db/pool.ts"], x: 400, y: 100, w: 200, h: 66 },
  { id: "pr:p:123", label: "#123", number: 123, x: 0, y: 300, w: 200, h: 66 },
  { id: "pr:p:1234", label: "#1234", number: 1234, x: 400, y: 300, w: 200, h: 66 },
  { id: "unit:p:docs", label: "docs", x: 800, y: 0, w: 200, h: 66 },
];
const find = (term: string): string[] => searchNodes(ITEMS, term).ids;

describe("canvas-search: o que casa", () => {
  test("dado o nome do agente, então casa por trecho", () => {
    expect(find("auth")).toEqual(["agent:p:impl-auth"]);
    expect(find("rev")).toEqual(["agent:p:rev-db"]);
  });

  test("dado o card, então casa", () => {
    expect(find("qto-412")).toEqual(["agent:p:impl-auth"]);
  });

  test("dado `#123`, então casa só a PR de número 123 (exato)", () => {
    expect(find("#123")).toEqual(["pr:p:123"]);
    expect(find("#12")).toEqual([]);
  });

  test("dado `123` sem cerquilha, então casa PR cujo número começa por 123", () => {
    expect(find("123")).toEqual(["pr:p:123", "pr:p:1234"]);
  });

  test("dado número que aparece num card, então casa o card também", () => {
    expect(find("412")).toEqual(["agent:p:impl-auth"]);
  });

  test("dado a branch, então casa", () => {
    expect(find("oauth")).toEqual(["agent:p:impl-auth"]);
    expect(find("fix/db")).toEqual(["agent:p:rev-db"]);
  });

  test("dado um arquivo, então casa pelo caminho ou pelo nome", () => {
    expect(find("pool.ts")).toEqual(["agent:p:rev-db"]);
    expect(find("src/auth")).toEqual(["agent:p:impl-auth"]);
  });

  test("dado termo sem acento ou com outra caixa, então casa texto acentuado", () => {
    expect(find("acao")).toEqual(["agent:p:impl-auth"]);
    expect(find("AÇÃO")).toEqual(["agent:p:impl-auth"]);
    expect(find("  QTO-412  ")).toEqual(["agent:p:impl-auth"]);
  });

  test("dado termo que casa em vários campos do mesmo nó, então o id vem uma vez, na ordem dos nós", () => {
    expect(find("docs")).toEqual(["agent:p:impl-auth", "unit:p:docs"]);
    expect(find("auth")).toEqual(["agent:p:impl-auth"]);
  });

  test("dado termo que não casa, então vem vazio e sem caixa", () => {
    expect(searchNodes(ITEMS, "nada-disso")).toEqual({ ids: [], box: undefined, term: "nada-disso" });
  });
});

describe("canvas-search: caixa para a câmera", () => {
  test("dado um achado, então a caixa é a do nó", () => {
    expect(searchNodes(ITEMS, "rev-db").box).toEqual({ x: 400, y: 100, w: 200, h: 66 });
  });

  test("dado vários achados, então a caixa os contém", () => {
    expect(searchNodes(ITEMS, "123").box).toEqual({ x: 0, y: 300, w: 600, h: 66 });
  });
});

describe("canvas-search: vazio, limite e entrada inválida", () => {
  test("dado termo vazio ou só espaços, então não acha nada", () => {
    for (const term of ["", "   ", "\n\t"]) expect(searchNodes(ITEMS, term)).toEqual({ ids: [], box: undefined, term: "" });
  });

  test("dado lista de nós vazia, então não acha nada", () => {
    expect(searchNodes([], "a")).toEqual({ ids: [], box: undefined, term: "a" });
  });

  test("dado termo no teto, então busca; um a mais, então recusa com código estável e sem truncar", () => {
    const atLimit = "a".repeat(SEARCH_LIMITS.termChars);
    expect(searchNodes(ITEMS, atLimit).problem).toBeUndefined();
    const over = searchNodes(ITEMS, "a".repeat(SEARCH_LIMITS.termChars + 1));
    expect(over).toEqual({ ids: [], box: undefined, term: "", problem: SEARCH_PROBLEMS.termTooLong });
  });

  test("dado texto cru gigante, então recusa antes de normalizar", () => {
    const result = searchNodes(ITEMS, " ".repeat(SEARCH_LIMITS.rawChars + 1));
    expect(result.problem).toBe(SEARCH_PROBLEMS.termTooLong);
  });

  test("dado termo com cara de regex, então é texto comum e não trava", () => {
    const items: SearchItem[] = [{ id: "f", label: "a.b+c(d)[e]*", x: 0, y: 0, w: 1, h: 1 }, { id: "g", label: "aXb", x: 0, y: 0, w: 1, h: 1 }];
    expect(searchNodes(items, "a.b+").ids).toEqual(["f"]);
    expect(searchNodes(items, "(d)[e]*").ids).toEqual(["f"]);
    expect(searchNodes(items, "]*").ids).toEqual(["f"]);
    expect(searchNodes(items, "(((((((").ids).toEqual([]);
    const evil: SearchItem[] = [{ id: "e", label: `${"a".repeat(5000)}!`, x: 0, y: 0, w: 1, h: 1 }];
    expect(searchNodes(evil, "(a+)+$").ids).toEqual([]);
  });

  test("dado campos ausentes, nulos ou vazios e número inválido, então o nó só não casa neles", () => {
    const items: SearchItem[] = [{ id: "n", label: "x", card: null, branch: "", files: null, number: Number.NaN, x: 0, y: 0, w: 1, h: 1 }];
    expect(searchNodes(items, "x").ids).toEqual(["n"]);
    expect(searchNodes(items, "#0").ids).toEqual([]);
  });

  test("dado PR número 0, então `#0` casa", () => {
    expect(searchNodes([{ id: "z", label: "#0", number: 0, x: 0, y: 0, w: 1, h: 1 }], "#0").ids).toEqual(["z"]);
  });

  test("dado o índice, então várias buscas dão o mesmo que a busca única", () => {
    const index = createSearchIndex(ITEMS);
    expect(index.size).toBe(ITEMS.length);
    for (const term of ["auth", "123", "#123", "acao", "zzz"]) expect(index.search(term)).toEqual(searchNodes(ITEMS, term));
  });

  test("normalizeText tira acento, caixa e espaços repetidos", () => {
    expect(normalizeText("  Ação   Fôrça\tX ")).toBe("acao forca x");
  });
});
