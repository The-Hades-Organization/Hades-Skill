// Grupo canvas-note: modelo dos nós `note` e `text` (src/lib/canvas-note.ts) — validação do `data`, título e área do texto
// livre, quem pode escrever, criação como operação da pilha de desfazer (ida e volta exata). Lógica pura.
import { describe, expect, test } from "bun:test";
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNode, validateCanvasDoc } from "../../../src/lib/canvas-doc";
import { applyOp, createHistory, invert, perform, redo, undo } from "../../../src/lib/canvas-history";
import {
  canWriteNote,
  checkAnnotationNode,
  checkAnnotations,
  createNoteNode,
  createTextNode,
  findNoteNode,
  freshNoteName,
  isNoteName,
  NOTE_ERRORS,
  NOTE_LIMITS,
  NoteError,
  noteFileOf,
  opEditText,
  opSetNoteAgent,
  notesOfAgent,
  OWNER,
  readNoteData,
  readTextData,
  requireAgentId,
  requireNoteName,
  textFrame,
  textTitle,
} from "../../../src/lib/canvas-note";

const AGENT = "agent:proj:impl-1";
const node = (id: string, type: string, data: Record<string, unknown>, over: Partial<CanvasNode> = {}): CanvasNode => ({
  id, type, x: 0, y: 0, w: 100, h: 60, z: 0, data, locked: false, blurred: false, ...over,
});
const doc = (nodes: CanvasNode[] = []): CanvasDoc => validateCanvasDoc({ v: 1, rev: 3, nodes, edges: [], groups: [] });
const nodeIn = (d: CanvasDoc, at: number): CanvasNode => d.nodes[at] ?? ((): never => { throw new Error(`sem nó na posição ${at}`); })();
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof NoteError) return error.code;
    throw error;
  }
  return "no-throw";
};

describe("canvas-note: nome do arquivo da nota", () => {
  test("aceita letras, números, hífen e sublinhado, até 64 caracteres", () => {
    for (const name of ["a", "nota-1", "Nota_2", "9x", "a".repeat(64)]) expect(isNoteName(name)).toBe(true);
  });

  test("recusa vazio, 65 caracteres, ponto, separador, .., espaço e começo por símbolo", () => {
    const bad = ["", "a".repeat(65), "a.md", "../x", "a/b", "a\\b", "..", ".hidden", "-x", "_x", "a b", "a%2Fb", "a\0b", "nota\n"];
    for (const name of bad) expect([name, isNoteName(name)]).toEqual([name, false]);
  });

  test("requireNoteName lança note_invalid_name e não aceita tipo que não é texto", () => {
    expect(codeOf(() => requireNoteName("../etc"))).toBe(NOTE_ERRORS.invalidName);
    expect(codeOf(() => requireNoteName(42))).toBe(NOTE_ERRORS.invalidName);
    expect(requireNoteName("ok")).toBe("ok");
  });
});

describe("canvas-note: data do nó note", () => {
  test("lê o mínimo (só o arquivo) e o ligado a um agente, e devolve cópia", () => {
    const raw = { note: "nota-abc", agent: AGENT };
    const data = readNoteData(raw);
    expect(data).toEqual(raw);
    expect(data).not.toBe(raw);
    expect(readNoteData({ note: "x" })).toEqual({ note: "x" });
  });

  test("recusa campo desconhecido, não objeto, arquivo inválido e agente que não é nó de agente", () => {
    expect(codeOf(() => readNoteData({ note: "x", body: "# oi" }))).toBe(NOTE_ERRORS.invalidData);
    expect(codeOf(() => readNoteData(null))).toBe(NOTE_ERRORS.invalidData);
    expect(codeOf(() => readNoteData([]))).toBe(NOTE_ERRORS.invalidData);
    expect(codeOf(() => readNoteData({ note: "a/b" }))).toBe(NOTE_ERRORS.invalidName);
    expect(codeOf(() => readNoteData({ note: "x", agent: "pr:1" }))).toBe(NOTE_ERRORS.invalidAgent);
    expect(codeOf(() => readNoteData({ note: "x", agent: "" }))).toBe(NOTE_ERRORS.invalidAgent);
    expect(codeOf(() => readNoteData({ note: "x", agent: `agent:${"a".repeat(CANVAS_LIMITS.idChars)}` }))).toBe(NOTE_ERRORS.invalidAgent);
    expect(codeOf(() => requireAgentId(undefined))).toBe(NOTE_ERRORS.invalidAgent);
  });
});

describe("canvas-note: data do nó text", () => {
  test("lê texto e estilo", () => {
    expect(readTextData({ text: "Fase 1", style: "title" })).toEqual({ text: "Fase 1", style: "title" });
  });

  test("o limite de 2000 caracteres é inclusivo; 2001 é note_too_large", () => {
    expect(readTextData({ text: "a".repeat(NOTE_LIMITS.textChars), style: "label" }).text).toHaveLength(NOTE_LIMITS.textChars);
    expect(codeOf(() => readTextData({ text: "a".repeat(NOTE_LIMITS.textChars + 1), style: "label" }))).toBe(NOTE_ERRORS.tooLarge);
  });

  test("recusa vazio, só espaço, tipo errado, estilo desconhecido e campo a mais", () => {
    for (const text of ["", "   \n\t", 7, undefined]) expect(codeOf(() => readTextData({ text, style: "label" }))).toBe(NOTE_ERRORS.invalidData);
    expect(codeOf(() => readTextData({ text: "x", style: "huge" }))).toBe(NOTE_ERRORS.invalidData);
    expect(codeOf(() => readTextData({ text: "x" }))).toBe(NOTE_ERRORS.invalidData);
    expect(codeOf(() => readTextData({ text: "x", style: "label", extra: 1 }))).toBe(NOTE_ERRORS.invalidData);
  });
});

describe("canvas-note: conferir nós e documento", () => {
  test("nó de outro tipo passa sem mudança; nota e texto são conferidos", () => {
    const other = node("d1", "drawing", { qualquer: [1, 2] });
    expect(checkAnnotationNode(other)).toBe(other);
    expect(codeOf(() => checkAnnotationNode(node("n1", "note", { note: "../x" })))).toBe(NOTE_ERRORS.invalidName);
    expect(codeOf(() => checkAnnotationNode(node("t1", "text", { text: "" , style: "label" })))).toBe(NOTE_ERRORS.invalidData);
  });

  test("checkAnnotations aceita documento sem anotações e acusa o primeiro nó inválido", () => {
    expect(() => checkAnnotations(doc())).not.toThrow();
    const good = node("n1", "note", { note: "a" });
    expect(() => checkAnnotations(doc([good, node("t1", "text", { text: "ok", style: "label" })]))).not.toThrow();
    expect(codeOf(() => checkAnnotations(doc([good, node("n2", "note", {})])))).toBe(NOTE_ERRORS.invalidName);
  });
});

describe("canvas-note: título e área do texto livre", () => {
  test("o título é a primeira linha com conteúdo, aparada", () => {
    expect(textTitle({ text: "\n  \n  Fase 1  \nresto", style: "title" })).toBe("Fase 1");
  });

  test("título acima de 80 caracteres sai cortado com reticências, dentro do limite", () => {
    const title = textTitle({ text: "x".repeat(200), style: "label" });
    expect([...title]).toHaveLength(NOTE_LIMITS.titleChars);
    expect(title.endsWith("…")).toBe(true);
    expect(textTitle({ text: "x".repeat(80), style: "label" })).toBe("x".repeat(80));
  });

  test("o corte não parte um caractere de dois códigos", () => {
    const title = textTitle({ text: "😀".repeat(100), style: "label" }, 10);
    expect([...title]).toEqual([..."😀".repeat(9), "…"]);
  });

  test("a área cresce com o texto e respeita o mínimo e o máximo do estilo", () => {
    const tiny = textFrame({ text: "a", style: "label" });
    const wide = textFrame({ text: "a".repeat(30), style: "label" });
    const huge = textFrame({ text: "a".repeat(2000), style: "label" });
    expect(tiny).toEqual({ w: 40, h: 32 });
    expect(wide.w).toBeGreaterThan(tiny.w);
    expect(huge.w).toBe(400);
    expect(huge.h).toBeGreaterThan(wide.h);
  });

  test("linhas a mais aumentam a altura, e o título é maior que o rótulo para o mesmo texto", () => {
    const one = textFrame({ text: "ab", style: "label" });
    const three = textFrame({ text: "ab\nab\nab", style: "label" });
    expect(three.h - one.h).toBe(2 * 20);
    expect(textFrame({ text: "ab", style: "title" }).h).toBeGreaterThan(one.h);
  });
});

describe("canvas-note: quem pode escrever", () => {
  const d = doc([
    node("n1", "note", { note: "nota-a", agent: AGENT }),
    node("n2", "note", { note: "nota-b" }),
    node("n3", "note", { note: "nota-c", agent: "agent:proj:outro" }),
    node("t1", "text", { text: "oi", style: "label" }),
    node("n4", "note", { note: "../ruim" }),
  ]);

  test("o dono escreve em qualquer nota", () => {
    for (const id of ["n1", "n2", "n3"]) expect(canWriteNote(d, id, OWNER)).toBe(true);
  });

  test("o agente só escreve na nota a que está ligado", () => {
    const agent = { kind: "agent", id: AGENT } as const;
    expect(canWriteNote(d, "n1", agent)).toBe(true);
    expect(canWriteNote(d, "n2", agent)).toBe(false);
    expect(canWriteNote(d, "n3", agent)).toBe(false);
  });

  test("nó que não existe, que não é nota ou de dado inválido nega o agente", () => {
    const agent = { kind: "agent", id: AGENT } as const;
    expect(canWriteNote(d, "nao-existe", agent)).toBe(false);
    expect(canWriteNote(d, "t1", agent)).toBe(false);
    expect(canWriteNote(d, "n4", agent)).toBe(false);
  });

  test("findNoteNode, noteFileOf e notesOfAgent leem a ligação do documento", () => {
    expect(findNoteNode(d, "n1")?.data).toEqual({ note: "nota-a", agent: AGENT });
    expect(findNoteNode(d, "t1")).toBeUndefined();
    expect(noteFileOf(d, "n2")).toBe("nota-b");
    expect(noteFileOf(d, "n4")).toBeUndefined();
    expect(noteFileOf(d, "t1")).toBeUndefined();
    expect(notesOfAgent(d, AGENT)).toEqual(["n1"]);
    expect(notesOfAgent(d, "agent:x:y")).toEqual([]);
  });
});

describe("canvas-note: nome novo", () => {
  test("nota-<pedaço> com o pedaço que vem de fora", () => {
    expect(freshNoteName(doc(), () => "abc123")).toBe("nota-abc123");
  });

  test("pula o nome que o documento já usa e tenta o próximo pedaço", () => {
    const d = doc([node("n1", "note", { note: "nota-abc123" })]);
    const tokens = ["abc123", "def456"];
    expect(freshNoteName(d, () => tokens.shift() as string)).toBe("nota-def456");
  });

  test("pedaço fora da lista (curto, longo, maiúscula, símbolo) é note_invalid_token", () => {
    for (const token of ["abc", "a".repeat(33), "ABC123", "ab-123", ""]) expect([token, codeOf(() => freshNoteName(doc(), () => token))]).toEqual([token, NOTE_ERRORS.tokenInvalid]);
  });

  test("sorteio que só repete nomes usados acaba em note_duplicate_id", () => {
    const d = doc([node("n1", "note", { note: "nota-abc123" })]);
    expect(codeOf(() => freshNoteName(d, () => "abc123"))).toBe(NOTE_ERRORS.duplicateId);
  });
});

describe("canvas-note: criar nós pela pilha de desfazer", () => {
  test("createNoteNode devolve um create; aplicar e inverter volta exatamente ao documento anterior", () => {
    const before = doc([node("a", "drawing", {})]);
    const { op, node: created } = createNoteNode(before, { id: "n1", x: 40, y: 60, note: "nota-abc123", agent: AGENT });
    expect(created).toMatchObject({ id: "n1", type: "note", x: 40, y: 60, w: 280, h: 200, data: { note: "nota-abc123", agent: AGENT }, locked: false });
    const after = applyOp(before, op);
    expect(after.nodes.map((n) => n.id)).toEqual(["a", "n1"]);
    expect(applyOp(after, invert(op))).toEqual(before);
    expect(() => checkAnnotations(after)).not.toThrow();
  });

  test("createTextNode nasce do tamanho da estimativa e também volta pelo desfazer e pelo refazer", () => {
    const before = doc();
    const { op, node: created } = createTextNode(before, { id: "t1", x: 0, y: 0, text: "Fase 1", style: "title" });
    expect({ w: created.w, h: created.h }).toEqual(textFrame({ text: "Fase 1", style: "title" }));
    const first = perform(createHistory(), before, op);
    expect(first.doc.nodes).toHaveLength(1);
    const back = undo(first.history, first.doc);
    expect(back?.doc).toEqual(before);
    expect(redo((back as NonNullable<typeof back>).history, (back as NonNullable<typeof back>).doc)?.doc).toEqual(first.doc);
  });

  test("o estilo padrão do texto é label", () => {
    expect(createTextNode(doc(), { id: "t1", x: 0, y: 0, text: "x" }).node.data).toEqual({ text: "x", style: "label" });
  });

  test("não muda o documento de entrada", () => {
    const before = doc([node("a", "drawing", {})]);
    const snapshot = structuredClone(before);
    createNoteNode(before, { id: "n1", x: 0, y: 0, note: "x" });
    createTextNode(before, { id: "t1", x: 0, y: 0, text: "x" });
    expect(before).toEqual(snapshot);
  });

  test("id repetido é note_duplicate_id; id fora do formato, coordenada fora do limite e nota com nome ruim são recusados", () => {
    const d = doc([node("n1", "note", { note: "x" })]);
    expect(codeOf(() => createNoteNode(d, { id: "n1", x: 0, y: 0, note: "y" }))).toBe(NOTE_ERRORS.duplicateId);
    expect(codeOf(() => createNoteNode(d, { id: "com espaço", x: 0, y: 0, note: "y" }))).toBe(NOTE_ERRORS.invalidNode);
    expect(codeOf(() => createTextNode(d, { id: "t1", x: CANVAS_LIMITS.coordinate + 1, y: 0, text: "x" }))).toBe(NOTE_ERRORS.invalidNode);
    expect(codeOf(() => createNoteNode(d, { id: "n2", x: 0, y: 0, note: "../x" }))).toBe(NOTE_ERRORS.invalidName);
    expect(codeOf(() => createNoteNode(d, { id: "n2", x: 0, y: 0, note: "x", agent: "pr:1" }))).toBe(NOTE_ERRORS.invalidAgent);
    expect(codeOf(() => createTextNode(d, { id: "t2", x: 0, y: 0, text: "  " }))).toBe(NOTE_ERRORS.invalidData);
  });

  test("com o documento no limite de nós, criar é note_limit_exceeded", () => {
    const full = { ...doc(), nodes: Array.from({ length: CANVAS_LIMITS.nodes }, (_, i) => node(`d${i}`, "drawing", {})) };
    expect(codeOf(() => createTextNode(full, { id: "t1", x: 0, y: 0, text: "x" }))).toBe(NOTE_ERRORS.limitExceeded);
  });
});

describe("canvas-note: editar nós pela pilha de desfazer", () => {
  const base = (): CanvasDoc =>
    doc([node("n1", "note", { note: "nota-abc123" }), node("t1", "text", { text: "Fase", style: "label" }), node("a", "drawing", {})]);

  test("ligar e soltar o agente da nota: update do data, o nó não é recriado e o desfazer volta exato", () => {
    const before = base();
    const linked = perform(createHistory(), before, opSetNoteAgent(before, "n1", AGENT)!);
    expect(linked.doc.nodes[0]).toEqual({ ...nodeIn(before, 0), data: { note: "nota-abc123", agent: AGENT } });
    const freed = perform(linked.history, linked.doc, opSetNoteAgent(linked.doc, "n1", undefined)!);
    expect(freed.doc).toEqual(before);
    const back = undo(freed.history, freed.doc)!;
    expect(back.doc).toEqual(linked.doc);
    expect(undo(back.history, back.doc)?.doc).toEqual(before);
  });

  test("já estar assim não gera passo", () => {
    const before = base();
    expect(opSetNoteAgent(before, "n1", undefined)).toBeUndefined();
    const linked = applyOp(before, opSetNoteAgent(before, "n1", AGENT)!);
    expect(opSetNoteAgent(linked, "n1", AGENT)).toBeUndefined();
  });

  test("agente fora do formato, nó que não é nota e nó que não existe são recusados", () => {
    expect(codeOf(() => opSetNoteAgent(base(), "n1", "pr:1"))).toBe(NOTE_ERRORS.invalidAgent);
    expect(codeOf(() => opSetNoteAgent(base(), "t1", AGENT))).toBe(NOTE_ERRORS.invalidNode);
    expect(codeOf(() => opSetNoteAgent(base(), "zz", AGENT))).toBe(NOTE_ERRORS.invalidNode);
  });

  test("data corrompido da nota (nome inválido) é recusado com o código do nome, não é reescrito em silêncio", () => {
    const broken = doc([node("n1", "note", { note: "../x" })]);
    expect(codeOf(() => opSetNoteAgent(broken, "n1", AGENT))).toBe(NOTE_ERRORS.invalidName);
  });

  test("editar o texto troca o data (e o estilo, se vier) sem mexer no tamanho; o desfazer volta exato", () => {
    const before = base();
    const first = perform(createHistory(), before, opEditText(before, "t1", "Fase 2", "title")!);
    expect(first.doc.nodes[1]).toEqual({ ...nodeIn(before, 1), data: { text: "Fase 2", style: "title" } });
    expect(undo(first.history, first.doc)?.doc).toEqual(before);
  });

  test("sem estilo novo o estilo atual fica; texto igual não gera passo", () => {
    const before = base();
    expect(applyOp(before, opEditText(before, "t1", "Outra")!).nodes[1]?.data).toEqual({ text: "Outra", style: "label" });
    expect(opEditText(before, "t1", "Fase")).toBeUndefined();
    expect(opEditText(before, "t1", "Fase", "label")).toBeUndefined();
  });

  test("texto vazio, só espaço e acima do teto são recusados; nó que não é texto também", () => {
    expect(codeOf(() => opEditText(base(), "t1", "   "))).toBe(NOTE_ERRORS.invalidData);
    expect(codeOf(() => opEditText(base(), "t1", ""))).toBe(NOTE_ERRORS.invalidData);
    expect(codeOf(() => opEditText(base(), "t1", "x".repeat(NOTE_LIMITS.textChars + 1)))).toBe(NOTE_ERRORS.tooLarge);
    expect(codeOf(() => opEditText(base(), "n1", "x"))).toBe(NOTE_ERRORS.invalidNode);
    expect(opEditText(base(), "t1", "x".repeat(NOTE_LIMITS.textChars))).toBeDefined();
  });
});

// ---- nota de verdade: nome, imagem, tabela, ferramenta Nota, fechar e arrastar de fora (bloco da unidade notas) ----
import {
  assetDirOf,
  assetOfRef,
  closeNotePlan,
  createNoteFromRect,
  imageMarkdown,
  isAssetFile,
  isNoteFileName,
  NOTE_FILE_LIMITS,
  noteDropPaths,
  noteFrameFromRect,
  noteTitle,
  readNoteTitle,
  sniffImage,
  tableToHtml,
  tableToMarkdown,
  tableToRtf,
  tableToTsv,
} from "../../../src/lib/canvas-note";

describe("nota de verdade: nome pela primeira linha", () => {
  test("dado markdown com título, quando sem nome fixado, então o nome é a 1ª linha sem as marcas", () => {
    expect(noteTitle("# Plano da **rodada**\n\ntexto")).toBe("Plano da rodada");
    expect(noteTitle("\n\n- [x] tarefa feita")).toBe("tarefa feita");
    expect(noteTitle("> citação\nresto")).toBe("citação");
  });

  test("cerca de código, régua e tabela não viram nome; nota vazia dá vazio", () => {
    expect(noteTitle("```mermaid\ngraph LR\n```\nDepois")).toBe("graph LR");
    expect(noteTitle("---\n| a | b |\nTítulo")).toBe("Título");
    expect(noteTitle("")).toBe("");
    expect(noteTitle("   \n\n")).toBe("");
  });

  test("nome fixado vence a primeira linha; fixado só com espaço volta ao automático", () => {
    expect(noteTitle("# Automático", "Meu nome")).toBe("Meu nome");
    expect(noteTitle("# Automático", "   ")).toBe("Automático");
  });

  test("linha acima do teto é cortada com reticências, no teto exato fica inteira", () => {
    const max = NOTE_FILE_LIMITS.titleChars;
    expect(noteTitle("x".repeat(max))).toBe("x".repeat(max));
    const cut = noteTitle("y".repeat(max + 5));
    expect([...cut].length).toBe(max);
    expect(cut.endsWith("…")).toBe(true);
  });

  test("readNoteTitle: vazio e nulo voltam ao automático; não texto, controle e acima do teto são note_invalid_title", () => {
    expect(readNoteTitle(null)).toBeNull();
    expect(readNoteTitle(undefined)).toBeNull();
    expect(readNoteTitle("  ")).toBeNull();
    expect(readNoteTitle("  Nome  ")).toBe("Nome");
    expect(readNoteTitle("n".repeat(NOTE_FILE_LIMITS.titleChars))).toBe("n".repeat(NOTE_FILE_LIMITS.titleChars));
    expect(codeOf(() => readNoteTitle(42))).toBe(NOTE_ERRORS.invalidTitle);
    expect(codeOf(() => readNoteTitle("a\u0007b"))).toBe(NOTE_ERRORS.invalidTitle);
    expect(codeOf(() => readNoteTitle("n".repeat(NOTE_FILE_LIMITS.titleChars + 1)))).toBe(NOTE_ERRORS.invalidTitle);
  });

  test("isNoteFileName aceita .md/.markdown/.txt em qualquer caixa e recusa só a extensão ou outra", () => {
    expect(["a.md", "B.MARKDOWN", "c.Txt"].map(isNoteFileName)).toEqual([true, true, true]);
    expect([".md", "a.mdx", "a.html", "a"].map(isNoteFileName)).toEqual([false, false, false, false]);
  });
});

describe("nota de verdade: imagem colada", () => {
  const bytes = (...b: number[]): Uint8Array => new Uint8Array([...b, 0, 0, 0, 0, 0, 0, 0, 0]);

  test("sniffImage reconhece PNG, JPEG, GIF e WebP pelos bytes", () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("png");
    expect(sniffImage(bytes(0xff, 0xd8, 0xff))).toBe("jpg");
    expect(sniffImage(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("gif");
    expect(sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe("webp");
  });

  test("SVG, RIFF que não é WebP, vazio e bytes curtos ficam de fora", () => {
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeUndefined();
    expect(sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20))).toBeUndefined();
    expect(sniffImage(new Uint8Array())).toBeUndefined();
    expect(sniffImage(new Uint8Array([0x89, 0x50]))).toBeUndefined();
  });

  test("referência relativa da pasta da nota vira o arquivo; outra pasta, ../ e nome fora do formato não", () => {
    const file = "0123456789abcdef.png";
    expect(imageMarkdown("plano", file)).toBe(`![imagem](${assetDirOf("plano")}/${file})`);
    expect(assetOfRef("plano", `plano.assets/${file}`)).toBe(file);
    expect(assetOfRef("plano", `./plano.assets/${file}`)).toBe(file);
    expect(assetOfRef("plano", `outra.assets/${file}`)).toBeUndefined();
    expect(assetOfRef("plano", `plano.assets/../${file}`)).toBeUndefined();
    expect(assetOfRef("plano", "plano.assets/0123456789abcdef.svg")).toBeUndefined();
    expect(isAssetFile("0123456789ABCDEF.png")).toBe(false);
  });
});

describe("nota de verdade: cópia de tabela", () => {
  const table = { header: ["Nome", "Nota"], rows: [["a|b", "<x>"], ["só um"], ["c", "d", "sobra"]] };

  test("TSV sai retangular, sem tabulação nem quebra dentro da célula", () => {
    expect(tableToTsv({ header: ["a\tb", "c"], rows: [["1\n2", "3"]] })).toBe("a b\tc\n1 2\t3");
    expect(tableToTsv(table).split("\n").map((l) => l.split("\t").length)).toEqual([2, 2, 2, 2]);
  });

  test("HTML escapa o conteúdo da célula", () => {
    const html = tableToHtml(table);
    expect(html).toContain("<th>Nome</th>");
    expect(html).toContain("<td>&lt;x&gt;</td>");
    expect(html).not.toContain("<x>");
    expect(html).not.toContain("sobra");
  });

  test("Markdown escapa a barra vertical e tem a linha de separação", () => {
    expect(tableToMarkdown(table).split("\n").slice(0, 3)).toEqual(["| Nome | Nota |", "| --- | --- |", "| a\\|b | <x> |"]);
  });

  test("RTF escapa chaves e barra e codifica fora do ASCII como \\uN?", () => {
    const rtf = tableToRtf({ header: ["{ç}"], rows: [["a\\b"], ["😀"]] });
    expect(rtf.startsWith("{\\rtf1")).toBe(true);
    expect(rtf).toContain("\\{\\u231?\\}");
    expect(rtf).toContain("a\\\\b");
    expect(rtf).toContain("\\u-10179?\\u-8704?");
  });
});

describe("nota de verdade: ferramenta Nota, fechar e arrastar de fora", () => {
  test("retângulo arrastado ao contrário vira caixa normal; pequeno demais nasce no tamanho padrão no mesmo canto", () => {
    expect(noteFrameFromRect({ x: 500, y: 400, w: -300, h: -200 })).toEqual({ x: 200, y: 200, w: 300, h: 200 });
    const small = noteFrameFromRect({ x: 10, y: 20, w: NOTE_FILE_LIMITS.minW - 1, h: 300 });
    expect(small.x).toBe(10);
    expect(small.y).toBe(20);
    expect(small.w).toBeGreaterThanOrEqual(NOTE_FILE_LIMITS.minW);
    expect(noteFrameFromRect({ x: 0, y: 0, w: NOTE_FILE_LIMITS.minW, h: NOTE_FILE_LIMITS.minH })).toEqual({ x: 0, y: 0, w: NOTE_FILE_LIMITS.minW, h: NOTE_FILE_LIMITS.minH });
  });

  test("createNoteFromRect cria o nó com nome livre e desfazer volta exatamente ao anterior", () => {
    const before = doc([node("n1", "note", { note: "nota-abc123" })]);
    const tokens = ["abc123", "def456"];
    const { op, node: created, note } = createNoteFromRect(before, { id: "n2", rect: { x: 0, y: 0, w: 400, h: 300 }, token: () => tokens.shift() as string });
    expect(note).toBe("nota-def456");
    expect(created.data).toEqual({ note: "nota-def456" });
    const done = perform(createHistory(), before, op);
    expect(done.doc.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(undo(done.history, done.doc)?.doc).toEqual(before);
  });

  test("closeNotePlan remove o nó, devolve o arquivo a apagar e desfazer devolve o nó; nó que não é nota não tem plano", () => {
    const before = doc([node("n1", "note", { note: "nota-abc123" }), node("t1", "text", { text: "Fase", style: "label" })]);
    const plan = closeNotePlan(before, "n1");
    expect(plan?.note).toBe("nota-abc123");
    const done = perform(createHistory(), before, plan!.op);
    expect(done.doc.nodes.map((n) => n.id)).toEqual(["t1"]);
    expect(undo(done.history, done.doc)?.doc).toEqual(before);
    expect(closeNotePlan(before, "t1")).toBeUndefined();
    expect(closeNotePlan(before, "nada")).toBeUndefined();
  });

  test("noteDropPaths fica só com file:// local de nota, decodificado, até o teto", () => {
    const list = ["# comentário", "file:///home/u/Notas/plano%20A.md", "file://host/x.md", "https://x.dev/a.md", "file:///tmp/foto.png", "file:///tmp/%E0%A4%A.md", "", "file:///tmp/b.TXT"].join("\r\n");
    expect(noteDropPaths(list)).toEqual(["/home/u/Notas/plano A.md", "/tmp/b.TXT"]);
    expect(noteDropPaths("file:///a.md\nfile:///b.md\nfile:///c.md", 2)).toEqual(["/a.md", "/b.md"]);
    expect(noteDropPaths("")).toEqual([]);
  });
});
