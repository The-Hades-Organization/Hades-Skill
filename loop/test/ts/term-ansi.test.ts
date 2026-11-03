// Grupo term-ansi: quadro ANSI do terminal do nó (src/lib/term-ansi.ts) → linhas de spans. Lógica pura.
import { describe, expect, test } from "bun:test";
import { applySgr, colorCss, DEFAULT_STYLE, parseAnsi, TERM_ERRORS, TERM_LIMITS, TermAnsiError, type TermColor, type TermStyle } from "../../../src/lib/term-ansi";

const E = "\x1b[";
const pal = (index: number): TermColor => ({ kind: "palette", index });
const rgb = (r: number, g: number, b: number): TermColor => ({ kind: "rgb", r, g, b });
const style = (over: Partial<TermStyle> = {}): TermStyle => ({ ...DEFAULT_STYLE, ...over });
const only = (ansi: string) => parseAnsi(ansi)[0]!;
const rejects = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TermAnsiError);
    return (err as TermAnsiError).code;
  }
  throw new Error("não lançou");
};

describe("term-ansi: texto e linhas", () => {
  test("texto sem escape é um span de estilo padrão", () => {
    expect(parseAnsi("olá")).toEqual([[{ text: "olá", style: DEFAULT_STYLE }]]);
  });

  test("entrada vazia não tem linhas, e uma quebra sozinha tem uma linha vazia", () => {
    expect(parseAnsi("")).toEqual([]);
    expect(parseAnsi("\n")).toEqual([[]]);
  });

  test("\\r\\n e \\n separam linhas; o \\r é descartado e o fim de linha final não cria linha sobrando", () => {
    expect(parseAnsi("a\r\nb\nc\r\n").map((l) => l.map((s) => s.text).join(""))).toEqual(["a", "b", "c"]);
  });

  test("linha em branco no meio e no começo é mantida", () => {
    expect(parseAnsi("\r\na\r\n\r\nb").map((l) => l.length)).toEqual([0, 1, 0, 1]);
  });

  test("tab anda até a próxima parada de 8 colunas e outros controles somem", () => {
    expect(only("ab\tc\x07\x00\x7f").map((s) => s.text).join("")).toBe("ab      c");
  });

  test("um caractere fora do plano básico (par substituto) fica inteiro", () => {
    expect(only("a😀b")[0]!.text).toBe("a😀b");
  });
});

describe("term-ansi: SGR", () => {
  test("cada atributo liga e o seu par desliga", () => {
    const [bold, italic, underline, inverse] = [1, 3, 4, 7].map((n) => only(`${E}${n}mx`)[0]!.style);
    expect(bold).toEqual(style({ bold: true }));
    expect(italic).toEqual(style({ italic: true }));
    expect(underline).toEqual(style({ underline: true }));
    expect(inverse).toEqual(style({ inverse: true }));
    expect(only(`${E}1;3;4;7mx${E}22;23;24;27my`).map((s) => s.style)).toEqual([style({ bold: true, italic: true, underline: true, inverse: true }), DEFAULT_STYLE]);
  });

  test("reset (0, vazio e ESC[m) volta ao padrão", () => {
    for (const reset of [`${E}0m`, `${E}m`, `${E};m`]) {
      expect(only(`${E}1;31mx${reset}y`).map((s) => s.style)).toEqual([style({ bold: true, fg: pal(1) }), DEFAULT_STYLE]);
    }
  });

  test("16 cores: 30–37 e 40–47 são 0–7, 90–97 e 100–107 são 8–15, 39 e 49 voltam ao padrão", () => {
    expect(only(`${E}31;42mx`)[0]!.style).toEqual(style({ fg: pal(1), bg: pal(2) }));
    expect(only(`${E}97;100mx`)[0]!.style).toEqual(style({ fg: pal(15), bg: pal(8) }));
    expect(only(`${E}31;42mx${E}39mx${E}49mx`).map((s) => s.style)).toEqual([style({ fg: pal(1), bg: pal(2) }), style({ bg: pal(2) }), DEFAULT_STYLE]);
  });

  test("256 cores, frente e fundo, pelas formas com ; e com :", () => {
    expect(only(`${E}38;5;208;48;5;17mx`)[0]!.style).toEqual(style({ fg: pal(208), bg: pal(17) }));
    expect(only(`${E}38:5:208;48:5:17mx`)[0]!.style).toEqual(style({ fg: pal(208), bg: pal(17) }));
    expect(only(`${E}38;5;0mx`)[0]!.style.fg).toEqual(pal(0));
  });

  test("truecolor, frente e fundo, pelas formas com ;, com : e com espaço de cor", () => {
    expect(only(`${E}38;2;215;119;87;48;2;0;0;0mx`)[0]!.style).toEqual(style({ fg: rgb(215, 119, 87), bg: rgb(0, 0, 0) }));
    expect(only(`${E}38:2:1:2:3mx`)[0]!.style.fg).toEqual(rgb(1, 2, 3));
    expect(only(`${E}48:2::10:20:30mx`)[0]!.style.bg).toEqual(rgb(10, 20, 30));
  });

  test("o que vem depois de uma cor estendida continua valendo", () => {
    expect(only(`${E}38;2;1;2;3;1;4mx`)[0]!.style).toEqual(style({ fg: rgb(1, 2, 3), bold: true, underline: true }));
    expect(only(`${E}38;5;9;3mx`)[0]!.style).toEqual(style({ fg: pal(9), italic: true }));
  });

  test("valor fora da faixa ou incompleto não vira cor (nem zero), e o resto da sequência vale", () => {
    expect(only(`${E}38;5;256;1mx`)[0]!.style).toEqual(style({ bold: true }));
    expect(only(`${E}38;2;256;0;0;1mx`)[0]!.style).toEqual(style({ bold: true }));
    expect(only(`${E}38;2;1;2mx`)[0]!.style.fg).toBeNull();
    expect(only(`${E}38;9;1mx`)[0]!.style).toEqual(DEFAULT_STYLE);
  });

  test("código desconhecido é ignorado sem tocar nos vizinhos", () => {
    expect(only(`${E}5;9;53;1;99mx`)[0]!.style).toEqual(style({ bold: true }));
  });

  test("o estilo passa de uma linha para a próxima e spans iguais se fundem", () => {
    const lines = parseAnsi(`${E}31mab${E}31mcd\nef${E}0m`);
    expect(lines[0]).toEqual([{ text: "abcd", style: style({ fg: pal(1) }) }]);
    expect(lines[1]).toEqual([{ text: "ef", style: style({ fg: pal(1) }) }]);
  });

  test("applySgr não muda o estilo recebido", () => {
    const before = style({ bold: true });
    const after = applySgr(before, "3");
    expect(before).toEqual(style({ bold: true }));
    expect(after).toEqual(style({ bold: true, italic: true }));
  });
});

describe("term-ansi: sequências que não são SGR", () => {
  test("movimento de cursor, limpeza e modos privados somem e o texto em volta fica", () => {
    expect(only(`a${E}2Kb${E}1;1Hc${E}?25ld${E}3Ae`).map((s) => s.text).join("")).toBe("abcde");
  });

  test("OSC (BEL ou ST), DCS, charset e ESC solto somem", () => {
    expect(only("a\x1b]0;título\x07b\x1b]8;;http://x\x1b\\c\x1bPq;1\x1b\\d\x1b(Be\x1b=f").map((s) => s.text).join("")).toBe("abcdef");
  });

  test("sequência cortada no fim do quadro é descartada sem lançar", () => {
    expect(only(`ab${E}38;2;1`).map((s) => s.text).join("")).toBe("ab");
    expect(only("ab\x1b]0;sem fim").map((s) => s.text).join("")).toBe("ab");
    expect(only("ab\x1b").map((s) => s.text).join("")).toBe("ab");
  });

  test("sequência privada que termina em m (ESC [ ? … m) não é SGR", () => {
    expect(only(`${E}?1;4mx`)).toEqual([{ text: "x", style: DEFAULT_STYLE }]);
  });

  test("um ESC [ seguido de byte inválido não derruba o parser", () => {
    expect(() => parseAnsi(`a${E}\x01b`)).not.toThrow();
  });
});

describe("term-ansi: teto da entrada", () => {
  test("acima do teto de bytes é recusado com o código estável, sem varrer", () => {
    expect(rejects(() => parseAnsi("a".repeat(TERM_LIMITS.bytes + 1)))).toBe(TERM_ERRORS.tooManyBytes);
  });

  test("o teto conta bytes UTF-8, não unidades", () => {
    expect(rejects(() => parseAnsi("é".repeat(TERM_LIMITS.bytes / 2 + 1)))).toBe(TERM_ERRORS.tooManyBytes);
    expect(() => parseAnsi("é".repeat(TERM_LIMITS.bytes / 2 - 1))).not.toThrow();
  });

  test("no teto de linhas passa, um acima é recusado, com ou sem quebra final", () => {
    const rows = (n: number): string => Array.from({ length: n }, () => "x").join("\n");
    expect(parseAnsi(rows(TERM_LIMITS.lines))).toHaveLength(TERM_LIMITS.lines);
    expect(parseAnsi(`${rows(TERM_LIMITS.lines)}\r\n`)).toHaveLength(TERM_LIMITS.lines);
    expect(rejects(() => parseAnsi(rows(TERM_LIMITS.lines + 1)))).toBe(TERM_ERRORS.tooManyLines);
    expect(rejects(() => parseAnsi(`${rows(TERM_LIMITS.lines + 1)}\n`))).toBe(TERM_ERRORS.tooManyLines);
  });

  test("um quadro do tamanho do teto de bytes com muitas sequências roda rápido", () => {
    const frame = `${E}38;2;1;2;3mx`.repeat(Math.floor(TERM_LIMITS.bytes / 16));
    const t0 = performance.now();
    expect(parseAnsi(frame)[0]).toHaveLength(1);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("term-ansi: cor CSS", () => {
  test("16 cores, cubo, rampa de cinza e rgb direto", () => {
    expect(colorCss(pal(1))).toBe("#cd0000");
    expect(colorCss(pal(15))).toBe("#ffffff");
    expect(colorCss(pal(16))).toBe("#000000");
    expect(colorCss(pal(196))).toBe("#ff0000");
    expect(colorCss(pal(231))).toBe("#ffffff");
    expect(colorCss(pal(232))).toBe("#080808");
    expect(colorCss(pal(255))).toBe("#eeeeee");
    expect(colorCss(rgb(215, 119, 87))).toBe("#d77757");
  });

  test("índice de paleta fora de 0–255 é erro, não preto", () => {
    expect(() => colorCss(pal(256))).toThrow(RangeError);
    expect(() => colorCss(pal(-1))).toThrow(RangeError);
  });
});
