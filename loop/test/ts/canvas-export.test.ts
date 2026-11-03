// Grupo canvas-export: exportar um canvas para JSON e importar validando (src/lib/canvas-export.ts). Puro, sem disco.
import { describe, expect, test } from "bun:test";
import { CANVAS_ERRORS, CANVAS_LIMITS, emptyCanvasDoc, type CanvasDoc } from "../../../src/lib/canvas-doc.ts";
import {
  CANVAS_EXPORT_ERRORS, CANVAS_EXPORT_FORMAT, CANVAS_EXPORT_VERSION, exportCanvas, parseCanvasExport,
} from "../../../src/lib/canvas-export.ts";
import { CANVAS_STORE_ERRORS } from "../../../src/lib/canvas-store.ts";

type Dict = Record<string, unknown>;
const note = (id: string, over: Dict = {}): Dict => ({ id, type: "note", x: 1, y: 2, w: 100, h: 50, z: 0, data: { text: "oi" }, locked: false, blurred: false, ...over });
const docWith = (nodes: Dict[], rev = 4): CanvasDoc => ({ ...emptyCanvasDoc(), rev, nodes: nodes as unknown as CanvasDoc["nodes"] });
const NOW = new Date("2026-11-02T12:00:00.000Z");
const file = (over: Dict = {}): string => JSON.stringify({ format: CANVAS_EXPORT_FORMAT, exportVersion: CANVAS_EXPORT_VERSION, name: "Meu mapa", exportedAt: NOW.toISOString(), doc: docWith([note("n1")]), ...over });
const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe("exportar", () => {
  test("dado um canvas, então o arquivo traz formato, versão, nome, data em UTC e o documento", () => {
    const doc = docWith([note("n1")]);
    expect(exportCanvas(doc, " Meu mapa ", NOW)).toEqual({ format: "hades-canvas", exportVersion: 1, name: "Meu mapa", exportedAt: "2026-11-02T12:00:00.000Z", doc });
  });

  test("dado nome inválido, então recusa com canvas_invalid_name", () => {
    expect(codeOf(() => exportCanvas(emptyCanvasDoc(), "", NOW))).toBe(CANVAS_STORE_ERRORS.invalidName);
  });
});

describe("importar", () => {
  test("dado o arquivo exportado, então volta o mesmo canvas, com rev zerada", () => {
    const doc = docWith([note("n1"), note("n2")]);
    const out = parseCanvasExport(JSON.stringify(exportCanvas(doc, "Mapa", NOW)));
    expect(out.name).toBe("Mapa");
    expect(out.doc).toEqual({ ...doc, rev: 0 });
  });

  test("dado nó vivo com conteúdo no arquivo, então volta só como posição (data vazio)", () => {
    const live = note("agent:p:a1", { type: "agent", data: { segredo: "x" } });
    const out = parseCanvasExport(file({ doc: docWith([live]) }));
    expect(out.doc.nodes[0]).toMatchObject({ id: "agent:p:a1", x: 1, y: 2, data: {} });
  });

  const invalid: [string, string, string][] = [
    ["JSON quebrado", "{nope", CANVAS_ERRORS.invalidJson],
    ["texto vazio", "", CANVAS_ERRORS.invalidJson],
    ["raiz que é lista", "[]", CANVAS_EXPORT_ERRORS.invalidFormat],
    ["sem a marca do formato", file({ format: "outro" }), CANVAS_EXPORT_ERRORS.invalidFormat],
    ["documento puro em vez do arquivo", JSON.stringify(docWith([])), CANVAS_EXPORT_ERRORS.invalidFormat],
    ["versão da exportação nova", file({ exportVersion: 2 }), CANVAS_EXPORT_ERRORS.unsupportedVersion],
    ["documento que não é objeto", file({ doc: [] }), CANVAS_ERRORS.invalidShape],
    ["versão do documento desconhecida", file({ doc: { ...docWith([]), v: 9 } }), CANVAS_ERRORS.unsupportedVersion],
    ["nó com forma errada", file({ doc: docWith([note("n1", { w: 0 })]) }), CANVAS_ERRORS.invalidNode],
    ["ids repetidos", file({ doc: docWith([note("n1"), note("n1")]) }), CANVAS_ERRORS.duplicateId],
    ["campo desconhecido no documento", file({ doc: { ...docWith([]), extra: 1 } }), CANVAS_ERRORS.invalidShape],
    ["nome ausente", file({ name: undefined }), CANVAS_STORE_ERRORS.invalidName],
    ["nome vazio", file({ name: "  " }), CANVAS_STORE_ERRORS.invalidName],
  ];
  test.each(invalid)("dado %s, então recusa com o código estável", (_, text, code) => {
    expect(codeOf(() => parseCanvasExport(text))).toBe(code);
  });

  test("dado nós acima do limite, então canvas_limit_exceeded", () => {
    const nodes = Array.from({ length: CANVAS_LIMITS.nodes + 1 }, (_, i) => note(`n${i}`));
    expect(codeOf(() => parseCanvasExport(file({ doc: docWith(nodes) })))).toBe(CANVAS_ERRORS.limitExceeded);
  });

  test("dado arquivo acima do teto de bytes, então canvas_too_large antes de ler o JSON", () => {
    expect(codeOf(() => parseCanvasExport(" ".repeat(CANVAS_LIMITS.bodyBytes + 5000)))).toBe(CANVAS_ERRORS.tooLarge);
  });

  test("dado documento acima do teto de bytes dentro do envelope, então canvas_too_large", () => {
    const fat = docWith([note("n1", { data: { text: "x".repeat(CANVAS_LIMITS.bodyBytes) } })]);
    expect(codeOf(() => parseCanvasExport(file({ doc: fat })))).toBe(CANVAS_ERRORS.tooLarge);
  });

  test("dado documento que cabe no teto com o envelope, então importa", () => {
    const text = "x".repeat(CANVAS_LIMITS.bodyBytes - 1000);
    expect(parseCanvasExport(file({ doc: docWith([note("n1", { data: { text } })]) })).doc.nodes).toHaveLength(1);
  });
});
