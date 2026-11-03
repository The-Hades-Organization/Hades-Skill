// Registro de tipos de nó do canvas (src/lib/canvas-types.ts): declaração válida, duplicada, campo faltando ou inválido.
import { describe, expect, test } from "bun:test";
import { createNodeTypeRegistry, REGISTRY_ERRORS, RegistryError, validateNodeType, type NodeTypeDef } from "../../../src/lib/canvas-types.ts";

const render = () => null;
const note = (over: Record<string, unknown> = {}): NodeTypeDef => ({
  type: "note", label: "Nota", icon: "FileText", defaultSize: { w: 160, h: 80 },
  draw: { surface: "html", render }, menu: ["delete"], actions: [], live: false, ...over,
}) as NodeTypeDef;

const codeOf = (run: () => unknown): { code: string; subject: string | undefined } => {
  try {
    run();
  } catch (error) {
    if (error instanceof RegistryError) return { code: error.code, subject: error.subject };
    throw error;
  }
  throw new Error("não lançou");
};
const without = (field: string): NodeTypeDef => {
  const raw: Record<string, unknown> = { ...note() };
  delete raw[field];
  return raw as unknown as NodeTypeDef;
};

describe("registro de tipos de nó", () => {
  test("dado um tipo válido, quando registra, então get/has/list/sizeOf o devolvem na ordem", () => {
    const registry = createNodeTypeRegistry();
    registry.register(note());
    registry.register(note({ type: "image", label: "Imagem", defaultSize: { w: 300, h: 200 } }));
    expect(registry.has("note")).toBe(true);
    expect(registry.get("image")?.label).toBe("Imagem");
    expect(registry.list().map((def) => def.type)).toEqual(["note", "image"]);
    expect(registry.sizeOf("image")).toEqual({ w: 300, h: 200 });
  });

  test("dado o mesmo tipo duas vezes, então a segunda é registry_duplicate e o primeiro continua", () => {
    const registry = createNodeTypeRegistry();
    registry.register(note());
    expect(codeOf(() => registry.register(note({ label: "Outra" })))).toEqual({ code: REGISTRY_ERRORS.duplicate, subject: "note" });
    expect(registry.get("note")?.label).toBe("Nota");
  });

  test.each(["type", "label", "icon", "defaultSize", "draw", "menu", "actions", "live"])("dado o campo %s faltando, então registry_missing_field com o nome do campo", (field) => {
    const registry = createNodeTypeRegistry();
    expect(codeOf(() => registry.register(without(field)))).toEqual({ code: REGISTRY_ERRORS.missingField, subject: field });
    expect(registry.list()).toEqual([]);
  });

  test.each([
    ["type com maiúscula", { type: "Note" }, REGISTRY_ERRORS.invalidType],
    ["type vazio", { type: "" }, REGISTRY_ERRORS.invalidType],
    ["type com 41 caracteres", { type: `a${"b".repeat(40)}` }, REGISTRY_ERRORS.invalidType],
    ["label em branco", { label: "  " }, REGISTRY_ERRORS.invalidField],
    ["label acima de 80", { label: "x".repeat(81) }, REGISTRY_ERRORS.invalidField],
    ["icon fora do padrão", { icon: "file-text" }, REGISTRY_ERRORS.invalidField],
    ["tamanho zero", { defaultSize: { w: 0, h: 80 } }, REGISTRY_ERRORS.invalidField],
    ["tamanho fracionário", { defaultSize: { w: 10.5, h: 80 } }, REGISTRY_ERRORS.invalidField],
    ["tamanho acima do limite do documento", { defaultSize: { w: 1_000_001, h: 80 } }, REGISTRY_ERRORS.invalidField],
    ["superfície desconhecida", { draw: { surface: "webgl", render } }, REGISTRY_ERRORS.invalidField],
    ["render que não é função", { draw: { surface: "html", render: "x" } }, REGISTRY_ERRORS.invalidField],
    ["menu que não é lista", { menu: "delete" }, REGISTRY_ERRORS.invalidField],
    ["menu com id repetido", { menu: ["delete", "delete"] }, REGISTRY_ERRORS.invalidField],
    ["menu com id inválido", { menu: ["a b"] }, REGISTRY_ERRORS.invalidField],
    ["live que não é booleano", { live: "sim" }, REGISTRY_ERRORS.invalidField],
  ])("dado %s, então o código estável certo", (_name, over, code) => {
    expect(codeOf(() => validateNodeType(note(over))).code).toBe(code);
  });

  test("dado tipo vivo declarado sem live, ou tipo livre declarado vivo, então registry_live_mismatch (o documento só aceita agent, unit, pr e gate como vivos)", () => {
    expect(codeOf(() => validateNodeType(note({ type: "agent", live: false }))).code).toBe(REGISTRY_ERRORS.liveMismatch);
    expect(codeOf(() => validateNodeType(note({ live: true }))).code).toBe(REGISTRY_ERRORS.liveMismatch);
    expect(validateNodeType(note({ type: "agent", live: true })).live).toBe(true);
  });

  test("dado lixo que não é objeto, então invalid_field (nunca TypeError)", () => {
    for (const junk of [null, "note", 7, [], undefined]) expect(codeOf(() => validateNodeType(junk)).code).toBe(REGISTRY_ERRORS.invalidField);
  });

  test("dado tipo desconhecido, então sizeOf lança registry_unknown_type e get devolve undefined", () => {
    const registry = createNodeTypeRegistry();
    expect(registry.get("nada")).toBeUndefined();
    expect(codeOf(() => registry.sizeOf("nada"))).toEqual({ code: REGISTRY_ERRORS.unknownType, subject: "nada" });
  });

  test("dado o objeto original alterado depois do registro, então o registro não muda (cópia congelada)", () => {
    const registry = createNodeTypeRegistry();
    const def = note();
    registry.register(def);
    def.defaultSize.w = 999;
    def.menu = ["outro"];
    expect(registry.sizeOf("note")).toEqual({ w: 160, h: 80 });
    expect(registry.get("note")?.menu).toEqual(["delete"]);
    expect(Object.isFrozen(registry.get("note"))).toBe(true);
  });

  test("dado sizeOf alterado pelo chamador, então o tamanho padrão guardado não muda", () => {
    const registry = createNodeTypeRegistry();
    registry.register(note());
    registry.sizeOf("note").w = 1;
    expect(registry.sizeOf("note").w).toBe(160);
  });
});
