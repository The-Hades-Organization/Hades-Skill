// Grupo canvas-compose: rascunho por agente e referência `@` resolvida no texto enviado (src/lib/canvas-compose.ts).
import { describe, expect, test } from "bun:test";
import { type CanvasNode } from "../../../src/lib/canvas-doc";
import { COMPOSE_ERRORS, COMPOSE_LIMITS, ComposeError, clearDraft, composeMessage, draftAgents, findReferences, getDraft, setDraft } from "../../../src/lib/canvas-compose";

const node = (id: string, type = "note", data: Record<string, unknown> = {}): CanvasNode => ({ id, type, x: 0, y: 0, w: 10, h: 10, z: 0, data, locked: false, blurred: false });
const doc = { nodes: [node("n1", "note", { text: "  usar a fila  " }), node("srv", "service", { label: "api" }), node("bare", "service")] };
const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof ComposeError ? error.code : "other";
  }
  return undefined;
};

describe("rascunhos", () => {
  test("guarda por agente sem mudar o mapa de entrada", () => {
    const base = {};
    const next = setDraft(base, "ana", "oi");
    expect(getDraft(next, "ana")).toBe("oi");
    expect(base).toEqual({});
  });
  test("texto vazio ou só espaço apaga o rascunho", () => {
    expect(setDraft({ ana: "oi" }, "ana", "  \n")).toEqual({});
  });
  test("agente sem rascunho devolve vazio", () => {
    expect(getDraft({}, "ana")).toBe("");
    expect(getDraft({}, "constructor")).toBe("");
  });
  test("clearDraft remove só o agente pedido e draftAgents ordena", () => {
    const drafts = setDraft(setDraft({}, "zed", "a"), "ana", "b");
    expect(draftAgents(drafts)).toEqual(["ana", "zed"]);
    expect(draftAgents(clearDraft(drafts, "zed"))).toEqual(["ana"]);
  });
  test("nome de agente inválido é erro", () => {
    expect(codeOf(() => setDraft({}, "Ana Maria", "x"))).toBe(COMPOSE_ERRORS.invalidAgent);
    expect(codeOf(() => setDraft({}, "__proto__", "x"))).toBe(COMPOSE_ERRORS.invalidAgent);
  });
  test("texto no teto passa e acima dele é erro", () => {
    expect(getDraft(setDraft({}, "ana", "x".repeat(COMPOSE_LIMITS.draftChars)), "ana").length).toBe(COMPOSE_LIMITS.draftChars);
    expect(codeOf(() => setDraft({}, "ana", "x".repeat(COMPOSE_LIMITS.draftChars + 1)))).toBe(COMPOSE_ERRORS.tooLong);
  });
  test("texto que não é string é erro", () => {
    expect(codeOf(() => setDraft({}, "ana", 3 as unknown as string))).toBe(COMPOSE_ERRORS.invalidText);
  });
  test("passar do número de rascunhos é erro, mas trocar um existente não", () => {
    let drafts: Record<string, string> = {};
    for (let i = 0; i < COMPOSE_LIMITS.drafts; i += 1) drafts = { ...setDraft(drafts, `a${i}`, "x") };
    expect(codeOf(() => setDraft(drafts, "novo", "x"))).toBe(COMPOSE_ERRORS.tooManyDrafts);
    expect(getDraft(setDraft(drafts, "a0", "y"), "a0")).toBe("y");
  });
});

describe("findReferences", () => {
  test("acha o id e dispensa a pontuação do fim", () => {
    const [ref] = findReferences("veja @n1.");
    expect(ref).toEqual({ start: 5, end: 8, id: "n1" });
  });
  test("e-mail e @@ não são referência", () => {
    expect(findReferences("a@b.com e @@n1")).toEqual([]);
  });
  test("@ sozinho não é referência", () => {
    expect(findReferences("@ e @, ok")).toEqual([]);
  });
  test("duas referências em ordem", () => {
    expect(findReferences("@a @b").map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("composeMessage", () => {
  test("troca a nota pelo texto dela, aparado", () => {
    const out = composeMessage("faça @n1 agora", doc);
    expect(out.text).toBe("faça [nota n1: usar a fila] agora");
    expect(out.references).toEqual([{ id: "n1", kind: "note" }]);
  });
  test("nó que não é nota vira descrição com o rótulo, quando há", () => {
    expect(composeMessage("@srv e @bare", doc).text).toBe('[nó srv (service) "api"] e [nó bare (service)]');
  });
  test("o mesmo id duas vezes entra uma vez na lista", () => {
    expect(composeMessage("@n1 @n1", doc).references).toHaveLength(1);
  });
  test("referência inexistente é erro e lista todas as que faltam", () => {
    try {
      composeMessage("@n1 @x @y @x", doc);
      throw new Error("devia falhar");
    } catch (error) {
      expect(error).toBeInstanceOf(ComposeError);
      expect((error as ComposeError).code).toBe(COMPOSE_ERRORS.unknownReference);
      expect((error as ComposeError).subjects).toEqual(["x", "y"]);
    }
  });
  test("@@ vira um @ literal", () => {
    expect(composeMessage("mande @@n1", doc).text).toBe("mande @n1");
  });
  test("mensagem vazia é erro", () => {
    expect(codeOf(() => composeMessage("  ", doc))).toBe(COMPOSE_ERRORS.emptyMessage);
  });
  test("referências demais é erro", () => {
    expect(codeOf(() => composeMessage(Array.from({ length: COMPOSE_LIMITS.references + 1 }, () => "@n1").join(" "), doc))).toBe(COMPOSE_ERRORS.tooManyReferences);
  });
  test("nota maior que o teto não é truncada: é erro", () => {
    const big = { nodes: [node("big", "note", { text: "x".repeat(COMPOSE_LIMITS.referenceChars + 1) })] };
    expect(codeOf(() => composeMessage("@big", big))).toBe(COMPOSE_ERRORS.referenceTooLong);
  });
  test("mensagem resolvida acima do teto é erro", () => {
    const body = "y".repeat(COMPOSE_LIMITS.referenceChars);
    const many = { nodes: [node("n", "note", { text: body })] };
    const text = Array.from({ length: COMPOSE_LIMITS.references }, () => "@n").join(" ");
    expect(codeOf(() => composeMessage(text, many))).toBe(COMPOSE_ERRORS.tooLong);
  });
  test("o documento não é mudado", () => {
    const before = JSON.stringify(doc);
    composeMessage("@n1", doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
  test("texto sem referência segue igual", () => {
    expect(composeMessage("oi", doc)).toEqual({ text: "oi", references: [] });
  });
});

// ---- compositor flutuante: rascunho por terminal, pílulas de colagem, menções e o texto que vai ao terminal ----
import * as Composer from "../../../src/lib/canvas-compose";

describe("compositor", () => {
  const empty = Composer.EMPTY_COMPOSER_DRAFT;
  const big = Array.from({ length: 5 }, (_, i) => `linha ${i}`).join("\n");
  const composerCode = (run: () => unknown): string | undefined => {
    try {
      run();
    } catch (error) {
      return error instanceof Composer.ComposerError || error instanceof ComposeError ? error.code : "other";
    }
    return undefined;
  };

  test("dada colagem acima de 800 caracteres ou de 2 linhas, então vira pílula; até o limite, não", () => {
    expect(Composer.isLargePaste("a".repeat(800))).toBe(false);
    expect(Composer.isLargePaste("a".repeat(801))).toBe(true);
    expect(Composer.isLargePaste("um\ndois")).toBe(false);
    expect(Composer.isLargePaste("um\ndois\ntrês")).toBe(true);
  });

  test("dada uma colagem grande, quando inserida, então o texto ganha o marcador numerado e o mapa guarda o conteúdo", () => {
    const { draft, caret } = Composer.insertPaste({ text: "ver: ", pastes: {} }, 5, 5, big);
    expect(draft.text).toBe("ver: ⟦colagem 1 · 5 linhas⟧");
    expect(caret).toBe(draft.text.length);
    expect(draft.pastes).toEqual({ "1": big });
    expect(Composer.findPills(draft)).toEqual([{ start: 5, end: draft.text.length, n: 1, lines: 5 }]);
  });

  test("dado um marcador recortado e colado de volta, então o número e o conteúdo continuam; nova colagem pega o próximo", () => {
    const first = Composer.insertPaste(empty, 0, 0, big).draft;
    const token = first.text;
    const cut = { text: "", pastes: first.pastes };
    const pasted = Composer.replaceRange(cut, 0, 0, `antes ${token}`).draft;
    expect(Composer.findPills(pasted).map((p) => p.n)).toEqual([1]);
    expect(Composer.insertPaste(pasted, pasted.text.length, pasted.text.length, big).draft.pastes).toHaveProperty("2", big);
  });

  test("dado marcador sem conteúdo no rascunho, então é texto comum", () => {
    expect(Composer.findPills({ text: "⟦colagem 9 · 3 linhas⟧", pastes: {} })).toEqual([]);
  });

  test("dado o envio, então a pílula volta ao conteúdo sem alteração e na posição dela", () => {
    const withPill = Composer.insertPaste({ text: "a  b", pastes: {} }, 2, 2, "x@@y\n\n  z\n").draft;
    expect(Composer.composerMessage(withPill, { nodes: [] })).toBe("a x@@y\n\n  z\n b");
  });

  test("dado `@id` de nota no texto digitado, então entra o texto da nota; terminal, orquestrador e `@@` seguem como texto", () => {
    const msg = Composer.composerMessage({ text: "leia @n1 e fale com @ana; @orquestrador @@x", pastes: {} }, doc);
    expect(msg).toBe("leia [nota n1: usar a fila] e fale com @ana; @orquestrador @x");
  });

  test("dada mensagem vazia ou acima do teto do terminal, então falha com o código", () => {
    expect(composerCode(() => Composer.composerMessage({ text: "  ", pastes: {} }, doc))).toBe(COMPOSE_ERRORS.emptyMessage);
    const huge = Composer.insertPaste(empty, 0, 0, "y".repeat(Composer.COMPOSER_LIMITS.pasteChars)).draft;
    expect(composerCode(() => Composer.composerMessage(Composer.replaceRange(huge, 0, 0, "z").draft, doc))).toBe(COMPOSE_ERRORS.tooLong);
  });

  test("dada colagem acima do teto ou colagens demais, então falha com o código e o rascunho não muda", () => {
    expect(composerCode(() => Composer.insertPaste(empty, 0, 0, "y".repeat(Composer.COMPOSER_LIMITS.pasteChars + 1)))).toBe(Composer.COMPOSER_ERRORS.pasteTooLong);
    const full = { text: "", pastes: Object.fromEntries(Array.from({ length: Composer.COMPOSER_LIMITS.pastes }, (_, i) => [String(i + 1), "x"])) };
    expect(composerCode(() => Composer.insertPaste(full, 0, 0, big))).toBe(Composer.COMPOSER_ERRORS.tooManyPastes);
  });

  test("dado o cursor dentro da pílula ou ela inteira selecionada, então pillAt a acha; encostado fora, não", () => {
    const draft = Composer.insertPaste({ text: "ab", pastes: {} }, 1, 1, big).draft;
    const [pill] = Composer.findPills(draft);
    expect(Composer.pillAt(draft, pill!.start + 1)?.n).toBe(1);
    expect(Composer.pillAt(draft, pill!.start, pill!.end)?.n).toBe(1);
    expect(Composer.pillAt(draft, pill!.start)).toBeNull();
    expect(Composer.pillAt(draft, pill!.end)).toBeNull();
  });

  test("dada a pílula expandida, então o conteúdo entra no lugar do marcador e fica selecionado", () => {
    const draft = Composer.insertPaste({ text: "ab", pastes: {} }, 1, 1, big).draft;
    const edit = Composer.expandPill(draft, Composer.findPills(draft)[0]!);
    expect(edit.draft.text).toBe(`a${big}b`);
    expect([edit.selectFrom, edit.caret]).toEqual([1, 1 + big.length]);
  });

  test("dado Backspace logo depois da pílula ou Delete logo antes, então a pílula sai inteira; longe dela, nada", () => {
    const draft = Composer.insertPaste({ text: "ab", pastes: {} }, 1, 1, big).draft;
    const [pill] = Composer.findPills(draft);
    expect(Composer.deletePill(draft, pill!.end, "back")?.draft.text).toBe("ab");
    expect(Composer.deletePill(draft, pill!.start, "forward")?.draft.text).toBe("ab");
    expect(Composer.deletePill(draft, 0, "back")).toBeNull();
    expect(Composer.deletePill(draft, pill!.end, "forward")).toBeNull();
  });

  test("dado o rascunho do terminal, então fica por terminal, sobrevive com pílulas e só o clear tira", () => {
    const withPill = Composer.insertPaste({ text: "oi ", pastes: {} }, 3, 3, big).draft;
    const drafts = Composer.setComposerDraft({}, "agent:r:a", withPill);
    expect(Composer.getComposerDraft(drafts, "agent:r:a")).toEqual(withPill);
    expect(Composer.getComposerDraft(drafts, "agent:r:b")).toBe(empty);
    expect(Composer.clearComposerDraft(drafts, "agent:r:a")).toEqual({});
    expect(Composer.setComposerDraft(drafts, "agent:r:a", { text: "  ", pastes: {} })).toEqual({});
    expect(composerCode(() => Composer.setComposerDraft({}, "", withPill))).toBe(Composer.COMPOSER_ERRORS.invalidTerminal);
  });

  test("dado `@` no começo ou depois de espaço, então há menção até o cursor; `@#` é o modo arquivos; e-mail e espaço encerram", () => {
    expect(Composer.mentionAt("oi @an", 6)).toEqual({ start: 3, query: "an", files: false });
    expect(Composer.mentionAt("@#src/li", 8)).toEqual({ start: 0, query: "src/li", files: true });
    expect(Composer.mentionAt("a@b", 3)).toBeNull();
    expect(Composer.mentionAt("@ana feito", 10)).toBeNull();
    expect(Composer.mentionAt("@@x", 3)).toBeNull();
    expect(Composer.mentionAt("sem nada", 8)).toBeNull();
  });

  test("dadas as fontes, então o menu lista terminais, notas, Arquivo…, orquestrador (com papel) e Nova nota, filtrando sem acento", () => {
    const sources = { terminals: [{ id: "t2", label: "revisor" }], notes: [{ id: "n1", title: "Decisões" }], orchestrator: true };
    expect(Composer.mentionOptions("", sources).map((o) => [o.kind, o.insert])).toEqual([
      ["terminal", "@revisor "], ["note", "@n1 "], ["file", null], ["orchestrator", "@orquestrador "], ["new-note", "@Nova nota "],
    ]);
    expect(Composer.mentionOptions("decis", sources).map((o) => o.kind)).toEqual(["note"]);
    expect(Composer.mentionOptions("orq", { ...sources, orchestrator: false })).toEqual([]);
  });

  test("dadas as arestas, então connectedIds devolve os ligados nos dois sentidos, sem repetir nem o próprio nó", () => {
    const edges = [{ id: "e1", from: "a", to: "b", kind: "x" }, { id: "e2", from: "c", to: "a", kind: "x" }, { id: "e3", from: "a", to: "b", kind: "y" }, { id: "e4", from: "a", to: "a", kind: "x" }];
    expect(Composer.connectedIds({ edges }, "a")).toEqual(["b", "c"]);
  });

  test("dada uma nota, então o título vem do title, senão da primeira linha sem #, senão do id", () => {
    expect(Composer.noteTitle(node("n", "note", { title: " T " }))).toBe("T");
    expect(Composer.noteTitle(node("n", "note", { text: "\n## Plano\nresto" }))).toBe("Plano");
    expect(Composer.noteTitle(node("n9", "note", {}))).toBe("n9");
  });
});

describe("desenho citado", () => {
  const scene = {
    v: 1,
    title: "Fluxo",
    elements: [
      { id: "a", type: "rect", x: 0, y: 0, w: 80, h: 40 },
      { id: "b", type: "ellipse", x: 200, y: 0, w: 60, h: 40 },
      { id: "c", type: "arrow", from: { ref: "a" }, to: { ref: "b" } },
      { id: "t", type: "text", x: 10, y: 80, text: "fila" },
    ],
  };
  const withDrawing = { nodes: [node("d1", "drawing", scene), node("d2", "drawing", { v: 99, elements: [] })] };

  test("dado `@d1`, então a mensagem leva título, contagem por tipo, textos e ligações do desenho", () => {
    const out = composeMessage("veja @d1", withDrawing);
    expect(out.text).toBe('veja [desenho d1 "Fluxo": 1 rect, 1 ellipse, 1 arrow, 1 text; textos "fila"; ligações c: a → b]');
    expect(out.references).toEqual([{ id: "d1", kind: "drawing" }]);
  });
  test("dado desenho com versão desconhecida, então a referência cai no nó genérico em vez de falhar", () => {
    expect(composeMessage("@d2", withDrawing).references).toEqual([{ id: "d2", kind: "node" }]);
  });
  test("dado desenho de texto longo demais, então falha com referenceTooLong", () => {
    const long = { ...scene, elements: [0, 1, 2].map((i) => ({ id: `t${i}`, type: "text", x: 0, y: 0, text: "x".repeat(900) })) };
    expect(codeOf(() => composeMessage("@d1", { nodes: [node("d1", "drawing", long)] }))).toBe(COMPOSE_ERRORS.referenceTooLong);
  });
  test("o compositor troca `@d1` pela leitura do desenho, como faz com nota", () => {
    expect(Composer.composerMessage({ text: "olhe @d1", pastes: {} }, withDrawing)).toContain("[desenho d1 \"Fluxo\":");
  });
  test("o menu de menção lista desenhos depois das notas, com o título ou o id", () => {
    const sources = { terminals: [], notes: [{ id: "n1", title: "Decisões" }], drawings: [{ id: "d1", title: "Fluxo" }], orchestrator: false };
    expect(Composer.mentionOptions("flu", sources).map((o) => [o.kind, o.insert])).toEqual([["drawing", "@d1 "]]);
    expect(Composer.drawingTitle(node("d9", "drawing", { v: 1, elements: [] }))).toBe("d9");
    expect(Composer.drawingTitle(withDrawing.nodes[0] as CanvasNode)).toBe("Fluxo");
  });
});
