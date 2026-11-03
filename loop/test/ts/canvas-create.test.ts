// Grupo canvas-create: esboço de unidade vira texto de comando, validado e sem executar nada (src/lib/canvas-create.ts).
import { describe, expect, test } from "bun:test";
import { CREATE_ERRORS, CreateError, UNIT_SKETCH_TYPE, designUnit, readUnitSketch, shellQuote, type UnitSketch } from "../../../src/lib/canvas-create";

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof CreateError ? error.code : "other";
  }
  return undefined;
};

describe("shellQuote", () => {
  test("aspa simples dentro do valor é fechada e escapada", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
  test("cifrão, crase e ponto e vírgula ficam inertes", () => {
    expect(shellQuote("$(rm -rf /); `x`")).toBe("'$(rm -rf /); `x`'");
  });
});

describe("designUnit — projeto", () => {
  test("gera o new e o start", () => {
    const out = designUnit({ kind: "project", name: "u-um", role: "impl", branch: "feat/um", base: "main", card: "ABC-1", specs: ["a", "b"] });
    expect(out.commands).toEqual([
      "hades agent new 'u-um' --role 'impl' --branch 'feat/um' --base 'main' --card 'ABC-1' --specs 'a,b'",
      "hades agent start-cmd 'u-um'",
    ]);
    expect(out.text).toBe(out.commands.join("\n"));
  });
  test("card novo com título perigoso sai escapado", () => {
    const out = designUnit({ kind: "project", name: "u-um", branch: "b", newCard: { title: "it's $(x)", tags: ["a", "b-c"], desc: "d" } });
    expect(out.commands[0]).toContain(`--new-card 'it'\\''s $(x)' --tags 'a,b-c' --desc 'd'`);
  });
  test("papel padrão é impl", () => {
    expect(designUnit({ kind: "project", name: "u", branch: "b" }).commands[0]).toContain("--role 'impl'");
  });
  test("sem branch é erro", () => {
    expect(codeOf(() => designUnit({ kind: "project", name: "u" }))).toBe(CREATE_ERRORS.missingField);
  });
  test("branch que parece opção, com .. ou com espaço é erro", () => {
    for (const branch of ["--force", "a..b", "a b", "a;b", "x.lock", "a/"]) {
      expect(codeOf(() => designUnit({ kind: "project", name: "u", branch }))).toBe(CREATE_ERRORS.invalidField);
    }
  });
  test("card e card novo juntos, etiqueta inválida, tags vazias e quebra de linha são erro", () => {
    const base: UnitSketch = { kind: "project", name: "u", branch: "b" };
    expect(codeOf(() => designUnit({ ...base, card: "A-1", newCard: { title: "t", tags: ["a"] } }))).toBe(CREATE_ERRORS.invalidField);
    expect(codeOf(() => designUnit({ ...base, newCard: { title: "t", tags: ["A B"] } }))).toBe(CREATE_ERRORS.invalidField);
    expect(codeOf(() => designUnit({ ...base, newCard: { title: "t", tags: [] } }))).toBe(CREATE_ERRORS.invalidField);
    expect(codeOf(() => designUnit({ ...base, newCard: { title: "a\nb", tags: ["a"] } }))).toBe(CREATE_ERRORS.invalidField);
  });
  test("port em unidade de projeto é erro; specs vazio ou com vírgula também", () => {
    const base: UnitSketch = { kind: "project", name: "u", branch: "b" };
    expect(codeOf(() => designUnit({ ...base, port: 3000 }))).toBe(CREATE_ERRORS.invalidField);
    expect(codeOf(() => designUnit({ ...base, specs: [] }))).toBe(CREATE_ERRORS.invalidField);
    expect(codeOf(() => designUnit({ ...base, specs: ["a,b"] }))).toBe(CREATE_ERRORS.invalidField);
  });
});

describe("designUnit — skill", () => {
  test("gera o skill-new e o start", () => {
    const out = designUnit({ kind: "skill", name: "u-dois", role: "consolidate", base: "main", port: 21283 });
    expect(out.commands[0]).toBe("hades agent skill-new 'u-dois' --base 'main' --role 'consolidate' --port '21283'");
    expect(out.commands[1]).toBe("hades agent start-cmd 'u-dois'");
  });
  test("papel spec não existe para skill", () => {
    expect(codeOf(() => designUnit({ kind: "skill", name: "u", role: "spec" }))).toBe(CREATE_ERRORS.invalidField);
  });
  test("porta fora de 1–65535 ou fracionária é erro; 1 e 65535 passam", () => {
    for (const port of [0, 65_536, 1.5, Number.NaN]) expect(codeOf(() => designUnit({ kind: "skill", name: "u", port }))).toBe(CREATE_ERRORS.invalidField);
    expect(designUnit({ kind: "skill", name: "u", port: 1 }).commands[0]).toContain("--port '1'");
    expect(designUnit({ kind: "skill", name: "u", port: 65_535 }).commands[0]).toContain("--port '65535'");
  });
  test("campo de projeto em unidade de skill é erro", () => {
    expect(codeOf(() => designUnit({ kind: "skill", name: "u", branch: "b" }))).toBe(CREATE_ERRORS.invalidField);
  });
});

describe("nome e tipo", () => {
  test("nome segue a regra do hades agent: 31 caracteres passam, 32 não", () => {
    expect(codeOf(() => designUnit({ kind: "skill", name: "a".repeat(31) }))).toBeUndefined();
    expect(codeOf(() => designUnit({ kind: "skill", name: "a".repeat(32) }))).toBe(CREATE_ERRORS.invalidName);
  });
  test("maiúscula, hífen no começo, vazio, espaço e injeção são erro", () => {
    for (const name of ["Abc", "-a", "", "a b", "a;rm", "a'b"]) expect(codeOf(() => designUnit({ kind: "skill", name }))).toBe(CREATE_ERRORS.invalidName);
  });
  test("kind desconhecido e entrada que não é objeto são erro", () => {
    expect(codeOf(() => designUnit({ kind: "x", name: "u" } as unknown as UnitSketch))).toBe(CREATE_ERRORS.invalidField);
    expect(codeOf(() => designUnit(null as unknown as UnitSketch))).toBe(CREATE_ERRORS.invalidField);
  });
});

describe("readUnitSketch", () => {
  const sketchNode = (data: Record<string, unknown>, type = UNIT_SKETCH_TYPE) => ({ id: "s1", type, data });
  test("lê e valida o esboço do nó", () => {
    expect(readUnitSketch(sketchNode({ kind: "skill", name: "u", port: 22000 }))).toEqual({ kind: "skill", name: "u", port: 22000 });
  });
  test("outro tipo de nó é erro", () => {
    expect(codeOf(() => readUnitSketch(sketchNode({ kind: "skill", name: "u" }, "note")))).toBe(CREATE_ERRORS.invalidSketch);
  });
  test("campo que falta ou dado inválido é erro", () => {
    expect(codeOf(() => readUnitSketch(sketchNode({ name: "u" })))).toBe(CREATE_ERRORS.missingField);
    expect(codeOf(() => readUnitSketch(sketchNode({ kind: "skill", name: "U" })))).toBe(CREATE_ERRORS.invalidName);
    expect(codeOf(() => readUnitSketch(sketchNode({ kind: "project", name: "u", branch: 5 })))).toBe(CREATE_ERRORS.invalidField);
  });
});
