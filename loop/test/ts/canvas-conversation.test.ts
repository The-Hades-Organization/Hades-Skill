// Grupo canvas-conversation: conversa do agente a partir do diário (src/lib/canvas-conversation.ts) — papéis, ordem,
// tetos de entradas e de tamanho, entrada inválida e leitura de JSONL. Lógica pura.
import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_ERRORS,
  CONVERSATION_LIMITS,
  clipLine,
  ConversationError,
  conversationFromEvents,
  conversationFromJsonl,
} from "../../../src/lib/canvas-conversation";

const T0 = Date.parse("2026-11-02T10:00:00.000Z");
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
const event = (seconds: number, kind: string, summary: string, extra: Record<string, unknown> = {}) => ({
  v: 1, ts: at(seconds), agent: "u-terminal", session: "s1", source: "guard", kind, summary, cwd: "/w", ...extra,
});

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof ConversationError ? error.code : "outro-erro";
  }
  return "não lançou";
};

describe("conversationFromEvents: formato", () => {
  test("dado prompt, ferramenta e fim de turno, devolve a conversa com papéis e rótulos", () => {
    const { entries, omitted, invalid } = conversationFromEvents([
      event(0, "prompt", "30 caracteres: faça o item"),
      event(1, "tool_pre", "Read", { tool: "Read" }),
      event(2, "tool_post", "ok: /w/a.ts", { tool: "Read" }),
      event(3, "stop", "fim do turno"),
    ]);
    expect(entries.map((e) => [e.role, e.label, e.kind, e.text])).toEqual([
      ["user", "você", "prompt", "30 caracteres: faça o item"],
      ["agent", "Read", "tool_post", "ok: /w/a.ts"],
      ["agent", "agente", "stop", "fim do turno"],
    ]);
    expect(entries[0]?.ts).toBe(at(0));
    expect(omitted + invalid).toBe(0);
  });

  test("com toolStarts, o início da ferramenta também entra", () => {
    const { entries } = conversationFromEvents([event(0, "tool_pre", "Bash", { tool: "Bash" })], { toolStarts: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("tool_pre");
  });

  test("permissão, bloqueio, gate e watch viram entradas do sistema", () => {
    const { entries } = conversationFromEvents([
      event(0, "permission", "permissão pendente: Bash", { tool: "Bash" }),
      event(1, "tool_blocked", "barrado | rm", { tool: "Bash" }),
      event(2, "gate.done", "rc=0 em 4s", { source: "gate" }),
    ]);
    expect(entries.map((e) => [e.role, e.label])).toEqual([["system", "Bash"], ["system", "Bash"], ["system", "gate.done"]]);
  });

  test("decisão mostra a pergunta e o escolhido, não o resumo cortado", () => {
    const { entries } = conversationFromEvents([
      event(0, "decision", "resumo curto", { decision: { level: 1, needed: 2, question: "qual porta?", chosen: "21278", alternatives: [] } }),
    ]);
    expect(entries[0]).toMatchObject({ role: "system", label: "decisão", text: "qual porta? → 21278" });
  });

  test("decisão sem o objeto cai no resumo", () => {
    const { entries } = conversationFromEvents([event(0, "decision", "resumo")]);
    expect(entries[0]?.text).toBe("resumo");
  });

  test("ordena por instante e mantém a ordem de entrada no empate", () => {
    const { entries } = conversationFromEvents([event(5, "stop", "c"), event(1, "stop", "a"), event(1, "stop", "b")]);
    expect(entries.map((e) => e.text)).toEqual(["a", "b", "c"]);
  });

  test("normaliza o instante para UTC com Z", () => {
    const { entries } = conversationFromEvents([{ ...event(0, "stop", "x"), ts: "2026-11-02T07:00:00-03:00" }]);
    expect(entries[0]?.ts).toBe("2026-11-02T10:00:00.000Z");
  });

  test("não altera a lista de entrada", () => {
    const input = [event(2, "stop", "b"), event(1, "stop", "a")];
    const frozen = structuredClone(input);
    conversationFromEvents(input);
    expect(input).toEqual(frozen);
  });
});

describe("conversationFromEvents: limites", () => {
  test("lista vazia devolve conversa vazia", () => {
    expect(conversationFromEvents([])).toEqual({ entries: [], omitted: 0, invalid: 0, unscanned: 0 });
  });

  test("passou de maxEntries: fica com as mais recentes e conta as omitidas", () => {
    const events = Array.from({ length: 5 }, (_, i) => event(i, "stop", `t${i}`));
    const result = conversationFromEvents(events, { maxEntries: 2 });
    expect(result.entries.map((e) => e.text)).toEqual(["t3", "t4"]);
    expect(result.omitted).toBe(3);
  });

  test("exatamente maxEntries não omite nada", () => {
    const events = [event(0, "stop", "a"), event(1, "stop", "b")];
    expect(conversationFromEvents(events, { maxEntries: 2 }).omitted).toBe(0);
  });

  test("texto maior que maxChars é cortado com reticências e marcado", () => {
    const { entries } = conversationFromEvents([event(0, "prompt", "x".repeat(50))], { maxChars: 10 });
    expect(entries[0]?.text).toBe(`${"x".repeat(9)}…`);
    expect(entries[0]?.truncated).toBe(true);
  });

  test("texto no limite não é cortado", () => {
    const { entries } = conversationFromEvents([event(0, "prompt", "x".repeat(10))], { maxChars: 10 });
    expect(entries[0]?.truncated).toBe(false);
  });

  test("padrões e tetos: 200 entradas e 400 caracteres", () => {
    const events = Array.from({ length: 250 }, (_, i) => event(i, "stop", "y".repeat(500)));
    const result = conversationFromEvents(events);
    expect(result.entries).toHaveLength(CONVERSATION_LIMITS.defaultEntries);
    expect(result.entries[0]?.text).toHaveLength(CONVERSATION_LIMITS.defaultChars);
  });

  test("passou do teto de leitura: só os mais recentes são olhados e o resto é contado", () => {
    const total = CONVERSATION_LIMITS.scanEvents + 3;
    const events = Array.from({ length: total }, (_, i) => event(i, "stop", `t${i}`));
    const result = conversationFromEvents(events, { maxEntries: 1 });
    expect(result.unscanned).toBe(3);
    expect(result.entries[0]?.text).toBe(`t${total - 1}`);
  });

  test("não corta um emoji ao meio", () => {
    const clipped = clipLine(`ab${"😀".repeat(5)}`, 4);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).toBe("ab…");
  });

  test("espaços e quebras de linha viram um espaço só", () => {
    expect(clipLine("a\n\n  b\tc ", 50).text).toBe("a b c");
  });
});

describe("conversationFromEvents: entrada inválida", () => {
  test("eventos sem campos obrigatórios, com instante inválido ou que não são objetos são contados e pulados", () => {
    const result = conversationFromEvents([
      event(0, "stop", "bom"),
      null,
      "texto",
      [],
      { kind: "stop", summary: "sem ts" },
      { ...event(1, "stop", "x"), ts: "ontem" },
      { ...event(1, "stop", "x"), summary: 7 },
      { ...event(1, "stop", "x"), kind: "" },
    ]);
    expect(result.entries.map((e) => e.text)).toEqual(["bom"]);
    expect(result.invalid).toBe(7);
  });

  test("entrada que não é lista lança conversation_invalid_input", () => {
    expect(code(() => conversationFromEvents({ not: "a list" }))).toBe(CONVERSATION_ERRORS.invalidInput);
    expect(code(() => conversationFromEvents(undefined))).toBe(CONVERSATION_ERRORS.invalidInput);
  });

  test("opção fora do intervalo lança conversation_invalid_option", () => {
    for (const options of [{ maxEntries: 0 }, { maxEntries: 1001 }, { maxEntries: 1.5 }, { maxEntries: Number.NaN }, { maxChars: 0 }, { maxChars: 4001 }, { toolStarts: 1 as unknown as boolean }]) {
      expect(code(() => conversationFromEvents([], options))).toBe(CONVERSATION_ERRORS.invalidOption);
    }
  });

  test("os máximos aceitos de cada opção passam", () => {
    expect(() => conversationFromEvents([], { maxEntries: 1000, maxChars: 4000 })).not.toThrow();
  });
});

describe("conversationFromJsonl", () => {
  test("lê uma linha por evento e ignora linhas em branco", () => {
    const text = `${JSON.stringify(event(0, "prompt", "a"))}\n\n${JSON.stringify(event(1, "stop", "b"))}\n`;
    const result = conversationFromJsonl(text);
    expect(result.entries.map((e) => e.text)).toEqual(["a", "b"]);
    expect(result.invalid).toBe(0);
  });

  test("texto vazio devolve conversa vazia", () => {
    expect(conversationFromJsonl("")).toEqual({ entries: [], omitted: 0, invalid: 0, unscanned: 0 });
  });

  test("linha com JSON quebrado ou grande demais entra em invalid e as outras seguem", () => {
    const big = JSON.stringify(event(2, "stop", "z".repeat(CONVERSATION_LIMITS.lineBytes)));
    const text = [JSON.stringify(event(0, "stop", "ok")), "{quebrado", big, "[1,2]"].join("\n");
    const result = conversationFromJsonl(text);
    expect(result.entries.map((e) => e.text)).toEqual(["ok"]);
    expect(result.invalid).toBe(3);
  });

  test("só as últimas linhas dentro do teto são lidas", () => {
    const lines = Array.from({ length: CONVERSATION_LIMITS.scanLines + 2 }, (_, i) => JSON.stringify(event(i, "stop", `t${i}`)));
    const result = conversationFromJsonl(lines.join("\n"), { maxEntries: 1 });
    expect(result.unscanned).toBe(2);
    expect(result.entries[0]?.text).toBe(`t${CONVERSATION_LIMITS.scanLines + 1}`);
  });

  test("texto que não é string lança conversation_invalid_input", () => {
    expect(code(() => conversationFromJsonl(42 as unknown as string))).toBe(CONVERSATION_ERRORS.invalidInput);
  });
});
