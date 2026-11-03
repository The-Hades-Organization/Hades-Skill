// Grupo canvas-supervisor: heurística local do supervisor do canvas (src/lib/canvas-supervisor.ts) — o que o quadro do
// terminal vira em cartão (fim, pergunta, permissão, erro, parou), a limpeza do quadro (ANSI, moldura, rodapé de
// atalhos) e o contexto mínimo que a consulta e o resumo mandam ao claude -p, cortado nos tetos.
import { describe, expect, test } from "bun:test";
import { validateCanvasDoc } from "../../../src/lib/canvas-doc";
import {
  SUPERVISOR_LIMITS, askContext, buildCard, classify, clipAnswer, connectedNoteNames, detectPermission, detectQuestion, meaningfulLines,
  notesContext, previewLines, recentSteps, stripAnsi,
} from "../../../src/lib/canvas-supervisor";

// Três quadros falsos, como o pane os mostra (com cor, moldura e o rodapé de atalhos da CLI).
const FRAME_DONE = [
  "\x1b[1m⏺\x1b[0m Bash(bun test loop/test/ts/canvas-notes-route.test.ts)",
  "  ⎿  42 pass, 0 fail",
  "⏺ Update(src/panel/canvas-notes.ts)",
  "⏺ Pronto: a rota das notas grava com revisão e os 42 testes passam.",
  "╭──────────────────────────────────────────╮",
  "│ >                                        │",
  "╰──────────────────────────────────────────╯",
  "  ? for shortcuts",
].join("\r\n");

const FRAME_QUESTION = [
  "⏺ Read(reference/argos.md)",
  "⏺ Encontrei duas formas de guardar a revisão da nota.",
  "  Prefere guardar a revisão no próprio arquivo ou num índice à parte?",
  "╭──────────────────────────────────────────╮",
  "│ >                                        │",
  "╰──────────────────────────────────────────╯",
  "  ⏵⏵ auto-accept edits on (shift+tab to cycle)",
].join("\n");

const FRAME_PERMISSION = [
  "⏺ Bash(rm -rf build/ && bun run build)",
  "╭──────────────────────────────────────────╮",
  "│ Bash command                             │",
  "│   rm -rf build/ && bun run build         │",
  "│ Do you want to proceed?                  │",
  "│ ❯ 1. Yes                                 │",
  "│   2. No, and tell Claude what to do      │",
  "╰──────────────────────────────────────────╯",
].join("\n");

describe("canvas-supervisor: limpeza do quadro", () => {
  test("dado ANSI, OSC e \\r\\n, quando limpo, então sobra só o texto", () => {
    expect(stripAnsi("\x1b[31mvermelho\x1b[0m\x1b]0;título\x07 ok\r\n")).toBe("vermelho ok\n");
  });

  test("dado moldura, caixa de entrada vazia e rodapé de atalhos, quando filtrado, então nenhum deles sobra", () => {
    const lines = meaningfulLines(FRAME_DONE);
    expect(lines).toContain("⏺ Pronto: a rota das notas grava com revisão e os 42 testes passam.");
    expect(lines.some((l) => /for shortcuts|^[╭╰│]|^>$/u.test(l))).toBe(false);
  });

  test("dado quadro vazio, quando filtrado, então nenhuma linha e o cartão é 'parou' sem detalhe", () => {
    expect(meaningfulLines("")).toEqual([]);
    const card = buildCard({ status: "idle", text: "" });
    expect(card.kind).toBe("idle");
    expect(card.summary).toBe(card.title);
    expect(card.preview).toEqual([]);
  });

  test("dada linha maior que o teto, quando filtrada, então é cortada com reticências", () => {
    const [line] = meaningfulLines("x".repeat(SUPERVISOR_LIMITS.lineChars + 50));
    expect(Array.from(line as string)).toHaveLength(SUPERVISOR_LIMITS.lineChars);
    expect(line?.endsWith("…")).toBe(true);
  });

  test("dada prévia, quando pedida, então guarda o fim da tela e tira as linhas vazias do fim", () => {
    const text = `${Array.from({ length: 30 }, (_, i) => `linha ${i}`).join("\n")}\n\n\n`;
    const preview = previewLines(text);
    expect(preview).toHaveLength(SUPERVISOR_LIMITS.previewLines);
    expect(preview[preview.length - 1]).toBe("linha 29");
  });

  test("dados marcadores de ação, quando lidos, então os últimos passos vêm do mais antigo ao mais novo", () => {
    expect(recentSteps(meaningfulLines(FRAME_DONE))).toEqual([
      "Bash(bun test loop/test/ts/canvas-notes-route.test.ts)",
      "Update(src/panel/canvas-notes.ts)",
      "Pronto: a rota das notas grava com revisão e os 42 testes passam.",
    ]);
  });
});

describe("canvas-supervisor: os três quadros viram cartão", () => {
  test("dado o fim (status done), então cartão 'Terminou' com o último passo, local, e sugestões sem envio ao agente", () => {
    const card = buildCard({ status: "done", text: FRAME_DONE });
    expect(card.kind).toBe("done");
    expect(card.title).toBe("Terminou");
    expect(card.summary).toBe("Terminou: Pronto: a rota das notas grava com revisão e os 42 testes passam.");
    expect(card.source).toBe("local");
    expect(card.suggestions.map((s) => s.action)).toEqual(["jump", "notes", "note"]);
  });

  test("dada a pergunta (status idle), então cartão 'Fez uma pergunta' com a pergunta detectada", () => {
    const card = buildCard({ status: "idle", text: FRAME_QUESTION });
    expect(card.kind).toBe("question");
    expect(card.question).toBe("Prefere guardar a revisão no próprio arquivo ou num índice à parte?");
    expect(card.summary).toBe(`Fez uma pergunta: ${card.question}`);
    expect(card.suggestions[0]?.action).toBe("jump");
  });

  test("dada a permissão (status blocked), então cartão 'Pede permissão' com o pedido e o comando acima dele", () => {
    const card = buildCard({ status: "blocked", text: FRAME_PERMISSION });
    expect(card.kind).toBe("permission");
    expect(card.permission).toBe("Do you want to proceed? — rm -rf build/ && bun run build");
    expect(card.preview.join("\n")).toContain("Do you want to proceed?");
  });

  test("dada permissão e pane que saiu, então a permissão vence o fim", () => {
    expect(classify({ status: "done", exited: true, lines: meaningfulLines(FRAME_PERMISSION) }).kind).toBe("permission");
  });

  test("dado o fim com erro na última linha, então cartão 'Parou com erro'", () => {
    const card = buildCard({ status: "unknown", exited: true, text: "⏺ Bash(bun test)\n  ⎿  3 pass, 1 fail\nerror: expected 2, got 3" });
    expect(card.kind).toBe("error");
    expect(card.error).toBe("error: expected 2, got 3");
  });

  test("dado blocked sem pergunta visível, então cartão de pergunta 'Espera uma resposta'", () => {
    const card = buildCard({ status: "blocked", text: "⏺ Pensando no próximo passo" });
    expect(card.kind).toBe("question");
    expect(card.title).toBe("Espera uma resposta");
    expect(card.question).toBeUndefined();
  });

  test("dadas só as opções numeradas sem a frase do pedido, então ainda é permissão", () => {
    expect(detectPermission(["1. Yes", "2. No"])).toBe("1. Yes · 2. No");
    expect(detectPermission(["1. Yes"])).toBeUndefined();
  });

  test("dada pergunta fora da janela do fim da tela, então não conta", () => {
    const lines = ["Quer continuar?", ...Array.from({ length: SUPERVISOR_LIMITS.detectWindow }, (_, i) => `passo ${i}`)];
    expect(detectQuestion(lines)).toBeUndefined();
  });
});

describe("canvas-supervisor: contexto que sai pelo claude -p", () => {
  test("dada consulta, então o prompt leva a pergunta e só as últimas linhas, e `sent` conta o que saiu", () => {
    const text = Array.from({ length: 200 }, (_, i) => `linha ${i}`).join("\n");
    const ctx = askContext({ name: "revisor", question: "  o que ele está fazendo?  ", text });
    expect(ctx.prompt).toContain('terminal chamado "revisor"');
    expect(ctx.prompt).toContain("Pergunta: o que ele está fazendo?");
    expect(ctx.prompt).toContain("linha 199");
    expect(ctx.prompt).not.toContain("linha 119\n");
    expect(ctx.sent.lines).toBe(SUPERVISOR_LIMITS.askLines);
    expect(ctx.sent.notes).toBeUndefined();
  });

  test("dado terminal com mais caracteres que o teto, então o corte vem do começo e respeita o teto", () => {
    const text = Array.from({ length: 70 }, (_, i) => `${i}:${"y".repeat(230)}`).join("\n");
    const ctx = askContext({ name: "impl", question: "?", text });
    expect(ctx.sent.chars).toBeLessThanOrEqual(SUPERVISOR_LIMITS.askChars + 1);
    expect(ctx.prompt).toContain("69:");
    expect(ctx.prompt).not.toContain("\n0:");
  });

  test("dadas notas (uma vazia), então o prompt leva título e texto das que têm texto e `sent` conta notas", () => {
    const ctx = notesContext([{ title: "Roteiro", text: "fazer A" }, { title: "Vazia", text: "  " }, { title: "Decisões", text: "B antes de C" }]);
    expect(ctx.prompt).toContain("## Roteiro\nfazer A");
    expect(ctx.prompt).toContain("## Decisões\nB antes de C");
    expect(ctx.prompt).not.toContain("## Vazia");
    expect(ctx.sent).toEqual({ notes: 2, chars: "fazer A".length + "B antes de C".length });
  });

  test("dadas notas além do teto total, então para antes de passar e nunca manda mais que o teto", () => {
    const big = "z".repeat(SUPERVISOR_LIMITS.noteChars);
    const ctx = notesContext(Array.from({ length: 10 }, (_, i) => ({ title: `n${i}`, text: big })));
    expect(ctx.sent.chars).toBeLessThanOrEqual(SUPERVISOR_LIMITS.notesChars);
    expect(ctx.sent.notes).toBe(Math.floor(SUPERVISOR_LIMITS.notesChars / SUPERVISOR_LIMITS.noteChars));
  });

  test("dada resposta com ANSI e maior que o teto, então sai limpa e cortada", () => {
    const answer = clipAnswer(`\x1b[1m${"r".repeat(SUPERVISOR_LIMITS.answerChars + 10)}\x1b[0m\n`);
    expect(answer.startsWith("r")).toBe(true);
    expect(Array.from(answer)).toHaveLength(SUPERVISOR_LIMITS.answerChars);
  });
});

describe("canvas-supervisor: notas conectadas", () => {
  const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, w: 100, h: 60, z: 0, data, locked: false, blurred: false });

  test("dado canvas com notas ligadas, soltas e repetidas, então só as ligadas, sem repetir, na ordem do documento", () => {
    const doc = validateCanvasDoc({
      v: 1, rev: 0, groups: [],
      nodes: [node("agent:o__r:t", "agent"), node("a", "note", { note: "roteiro" }), node("b", "note", { note: "solta" }), node("c", "note", { note: "decisoes" }), node("d", "note", { note: "roteiro" })],
      edges: [{ id: "e1", from: "agent:o__r:t", to: "c", kind: "link" }, { id: "e2", from: "a", to: "agent:o__r:t", kind: "link" }, { id: "e3", from: "d", to: "agent:o__r:t", kind: "link" }],
    });
    expect(connectedNoteNames(doc)).toEqual(["roteiro", "decisoes"]);
  });

  test("dado canvas sem arestas, então nenhuma nota", () => {
    const doc = validateCanvasDoc({ v: 1, rev: 0, groups: [], nodes: [node("a", "note", { note: "roteiro" })], edges: [] });
    expect(connectedNoteNames(doc)).toEqual([]);
  });
});
