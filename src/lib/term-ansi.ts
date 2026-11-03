// Quadro ANSI do terminal de um agente (reference/argos.md §Terminal do nó) → linhas de spans. O herdr entrega o quadro
// pronto (`pane.read source=visible format=ansi`), não um fluxo de bytes: só há SGR (cores e atributos) para converter, sem
// emulação de cursor nem de rolagem. Função pura, sem Node e sem DOM (o módulo também vai ao navegador).

/** Tetos da entrada: um quadro maior que isto é recusado antes de qualquer varredura (não é truncado em silêncio). */
export const TERM_LIMITS = {
  /** Tamanho do quadro em bytes UTF-8. Um terminal de 300×100 com truecolor em cada célula cabe com folga. */
  bytes: 1_048_576,
  /** Linhas de um quadro; o herdr entrega só a janela visível. */
  lines: 500,
} as const;

export const TERM_ERRORS = {
  tooManyBytes: "term_ansi_too_many_bytes",
  tooManyLines: "term_ansi_too_many_lines",
} as const;
export type TermAnsiErrorCode = (typeof TERM_ERRORS)[keyof typeof TERM_ERRORS];

export class TermAnsiError extends Error {
  readonly code: TermAnsiErrorCode;
  constructor(code: TermAnsiErrorCode, message: string) {
    super(message);
    this.name = "TermAnsiError";
    this.code = code;
  }
}

/** Cor de uma célula: posição na paleta de 256 (0–15 são as 16 do terminal) ou RGB direto. */
export type TermColor = { readonly kind: "palette"; readonly index: number } | { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number };

export interface TermStyle {
  readonly fg: TermColor | null;
  readonly bg: TermColor | null;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly inverse: boolean;
}

export interface TermSpan {
  readonly text: string;
  readonly style: TermStyle;
}
export type TermLine = readonly TermSpan[];

export const DEFAULT_STYLE: TermStyle = Object.freeze({ fg: null, bg: null, bold: false, italic: false, underline: false, inverse: false });

const ESC = 0x1b;
const BEL = 0x07;
const TAB_STOP = 8;
// ECMA-48 §5.4: o corpo de um CSI são parâmetros 0x30–0x3F, intermediários 0x20–0x2F e um byte final 0x40–0x7E
const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;
const INTERMEDIATE_MIN = 0x20;
const INTERMEDIATE_MAX = 0x2f;
const PRIVATE_MARKER = /[<=>?]/;
const PALETTE_SIZE = 256;
const CHANNEL_MAX = 255;

const SGR = {
  reset: 0,
  bold: 1,
  italic: 3,
  underline: 4,
  inverse: 7,
  boldOff: 22,
  italicOff: 23,
  underlineOff: 24,
  inverseOff: 27,
  fgFirst: 30,
  fgLast: 37,
  fgExtended: 38,
  fgDefault: 39,
  bgFirst: 40,
  bgLast: 47,
  bgExtended: 48,
  bgDefault: 49,
  fgBrightFirst: 90,
  fgBrightLast: 97,
  bgBrightFirst: 100,
  bgBrightLast: 107,
} as const;
const BRIGHT_OFFSET = 8;
const EXTENDED_PALETTE = 5;
const EXTENDED_RGB = 2;

const sameColor = (a: TermColor | null, b: TermColor | null): boolean =>
  a === b || (a !== null && b !== null && (a.kind === "palette" ? b.kind === "palette" && a.index === b.index : b.kind === "rgb" && a.r === b.r && a.g === b.g && a.b === b.b));

export const sameStyle = (a: TermStyle, b: TermStyle): boolean =>
  a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse && sameColor(a.fg, b.fg) && sameColor(a.bg, b.bg);

const palette = (index: number): TermColor => ({ kind: "palette", index });

function exceedsByteLimit(text: string): boolean {
  // UTF-8 gasta de 1 a 3 bytes por unidade UTF-16 (um par substituto são 4 bytes para 2 unidades): só codifica de fato quando o
  // tamanho pode estar na faixa do teto
  if (text.length > TERM_LIMITS.bytes) return true;
  if (text.length * 3 <= TERM_LIMITS.bytes) return false;
  return new TextEncoder().encode(text).length > TERM_LIMITS.bytes;
}

/** Valor inteiro de um parâmetro SGR; vazio vale 0 (ECMA-48 §8.3.117), mas parâmetro ausente e lixo viram `undefined`, nunca zero. */
function param(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (raw === "") return 0;
  return /^\d{1,5}$/.test(raw) ? Number(raw) : undefined;
}

function channel(raw: string | undefined): number | undefined {
  const n = param(raw);
  return n !== undefined && n <= CHANNEL_MAX ? n : undefined;
}

/** `38;5;n`, `38;2;r;g;b` (parâmetros seguintes) ou `38:5:n`, `38:2:[cs]:r:g:b` (subparâmetros). Devolve a cor e quantos parâmetros consumiu. */
function extendedColor(groups: readonly string[], at: number): { color: TermColor | null; used: number } {
  const first = groups[at] as string;
  if (first.includes(":")) {
    const sub = first.split(":");
    const mode = param(sub[1]);
    if (mode === EXTENDED_PALETTE) {
      const index = param(sub[2]);
      return { color: index !== undefined && index < PALETTE_SIZE ? palette(index) : null, used: 1 };
    }
    if (mode === EXTENDED_RGB) {
      // a forma com espaço de cor (`38:2:cs:r:g:b`) tem um campo a mais antes de r
      const rgb = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5);
      const [r, g, b] = [channel(rgb[0]), channel(rgb[1]), channel(rgb[2])];
      return { color: r !== undefined && g !== undefined && b !== undefined ? { kind: "rgb", r, g, b } : null, used: 1 };
    }
    return { color: null, used: 1 };
  }
  const mode = param(groups[at + 1]);
  if (mode === EXTENDED_PALETTE) {
    const index = param(groups[at + 2]);
    return { color: index !== undefined && index < PALETTE_SIZE ? palette(index) : null, used: 3 };
  }
  if (mode === EXTENDED_RGB) {
    const [r, g, b] = [channel(groups[at + 2]), channel(groups[at + 3]), channel(groups[at + 4])];
    return { color: r !== undefined && g !== undefined && b !== undefined ? { kind: "rgb", r, g, b } : null, used: 5 };
  }
  // modo desconhecido: não se sabe quantos parâmetros ele leva, então o resto da sequência é descartado em vez de lido como atributos
  return { color: null, used: groups.length - at };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Aplica os parâmetros de um `CSI … m` ao estilo corrente. Código desconhecido ou valor inválido é ignorado (o resto vale). */
export function applySgr(style: TermStyle, paramText: string): TermStyle {
  const next: Mutable<TermStyle> = { ...style };
  const groups = paramText === "" ? ["0"] : paramText.split(";");
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i] as string;
    if (group.includes(":") && !group.startsWith("38:") && !group.startsWith("48:")) continue; // subparâmetros só valem em 38/48
    const code = param(group.split(":")[0]);
    if (code === undefined) continue;
    if (code === SGR.reset) Object.assign(next, DEFAULT_STYLE);
    else if (code === SGR.bold) next.bold = true;
    else if (code === SGR.italic) next.italic = true;
    else if (code === SGR.underline) next.underline = true;
    else if (code === SGR.inverse) next.inverse = true;
    else if (code === SGR.boldOff) next.bold = false;
    else if (code === SGR.italicOff) next.italic = false;
    else if (code === SGR.underlineOff) next.underline = false;
    else if (code === SGR.inverseOff) next.inverse = false;
    else if (code >= SGR.fgFirst && code <= SGR.fgLast) next.fg = palette(code - SGR.fgFirst);
    else if (code >= SGR.bgFirst && code <= SGR.bgLast) next.bg = palette(code - SGR.bgFirst);
    else if (code >= SGR.fgBrightFirst && code <= SGR.fgBrightLast) next.fg = palette(code - SGR.fgBrightFirst + BRIGHT_OFFSET);
    else if (code >= SGR.bgBrightFirst && code <= SGR.bgBrightLast) next.bg = palette(code - SGR.bgBrightFirst + BRIGHT_OFFSET);
    else if (code === SGR.fgDefault) next.fg = null;
    else if (code === SGR.bgDefault) next.bg = null;
    else if (code === SGR.fgExtended || code === SGR.bgExtended) {
      const { color, used } = extendedColor(groups, i);
      if (color) {
        if (code === SGR.fgExtended) next.fg = color;
        else next.bg = color;
      }
      i += used - 1;
    }
  }
  return next;
}

/** Posição logo depois de uma sequência que começa em `at` (o ESC), ou `text.length` se ela não termina no quadro. */
function skipEscape(text: string, at: number): number {
  const kind = text.charCodeAt(at + 1);
  if (Number.isNaN(kind)) return text.length;
  // OSC (]), DCS (P), SOS (X), PM (^) e APC (_): corpo livre até BEL ou ST (ESC \)
  if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
    for (let i = at + 2; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c === BEL) return i + 1;
      if (c === ESC && text.charCodeAt(i + 1) === 0x5c) return i + 2;
    }
    return text.length;
  }
  // nF: ESC + intermediários + final (ex.: ESC ( B escolhe o conjunto de caracteres)
  if (kind >= INTERMEDIATE_MIN && kind <= INTERMEDIATE_MAX) {
    let i = at + 2;
    while (i < text.length && text.charCodeAt(i) >= INTERMEDIATE_MIN && text.charCodeAt(i) <= INTERMEDIATE_MAX) i += 1;
    return Math.min(i + 1, text.length);
  }
  return at + 2;
}

/**
 * Converte o quadro em linhas de spans. Spans vizinhos com o mesmo estilo se fundem; linha vazia é `[]`. Sequências que não são
 * SGR (movimento de cursor, OSC, charset…) são descartadas sem quebrar o resto; a sequência cortada no fim do quadro também.
 * O estilo corrente passa de uma linha para a próxima, como no terminal. `\t` anda até a próxima parada de 8 colunas; os demais
 * controles são descartados. Erros: `term_ansi_too_many_bytes`, `term_ansi_too_many_lines`.
 */
export function parseAnsi(ansi: string): TermLine[] {
  if (exceedsByteLimit(ansi)) throw new TermAnsiError(TERM_ERRORS.tooManyBytes, `quadro acima de ${TERM_LIMITS.bytes} bytes`);
  if (ansi === "") return [];
  const tooManyLines = (): TermAnsiError => new TermAnsiError(TERM_ERRORS.tooManyLines, `quadro acima de ${TERM_LIMITS.lines} linhas`);
  const lines: TermSpan[][] = [[]];
  let style: TermStyle = DEFAULT_STYLE;
  let buffer = "";
  let column = 0;

  const flush = (): void => {
    if (buffer === "") return;
    const line = lines[lines.length - 1] as TermSpan[];
    const last = line[line.length - 1];
    if (last && sameStyle(last.style, style)) line[line.length - 1] = { text: last.text + buffer, style };
    else line.push({ text: buffer, style });
    buffer = "";
  };
  const breakLine = (): void => {
    flush();
    if (lines.length > TERM_LIMITS.lines) throw tooManyLines();
    lines.push([]);
    column = 0;
  };

  let i = 0;
  while (i < ansi.length) {
    const code = ansi.charCodeAt(i);
    if (code === ESC) {
      if (ansi.charCodeAt(i + 1) === 0x5b) {
        let end = i + 2;
        while (end < ansi.length && ansi.charCodeAt(end) < CSI_FINAL_MIN) end += 1;
        const final = ansi.charCodeAt(end);
        if (end < ansi.length && final <= CSI_FINAL_MAX) {
          // `<`, `=`, `>` e `?` no começo marcam sequência privada (ECMA-48 §5.4.2): mesmo terminando em m, não é SGR
          if (final === 0x6d && !PRIVATE_MARKER.test(ansi.charAt(i + 2))) {
            flush();
            style = applySgr(style, ansi.slice(i + 2, end));
          }
          i = end + 1;
        } else i = ansi.length; // CSI cortado no fim do quadro, ou byte fora da faixa: nada a desenhar depois dele
      } else i = skipEscape(ansi, i);
      continue;
    }
    i += 1;
    if (code === 0x0a) breakLine();
    else if (code === 0x09) {
      const pad = TAB_STOP - (column % TAB_STOP);
      buffer += " ".repeat(pad);
      column += pad;
    } else if (code >= 0x20 && code !== 0x7f) {
      // um par substituto é uma célula só: copia as duas unidades juntas
      const unit = code >= 0xd800 && code <= 0xdbff && i < ansi.length ? ansi.slice(i - 1, i + 1) : ansi.charAt(i - 1);
      if (unit.length === 2) i += 1;
      buffer += unit;
      column += 1;
    }
  }
  flush();
  // `\r\n` no fim do quadro deixa uma linha vazia sobrando: o herdr termina cada linha, não separa
  if (lines.length > 1 && (lines[lines.length - 1] as TermSpan[]).length === 0 && /[\r\n]$/.test(ansi)) lines.pop();
  if (lines.length > TERM_LIMITS.lines) throw tooManyLines();
  return lines;
}

// Paleta xterm padrão: 0–15 os nomes, 16–231 o cubo 6×6×6, 232–255 a rampa de cinza (XTerm Control Sequences, "Colors").
const BASE_16 = [
  "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
  "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
] as const;
const CUBE_FIRST = 16;
const CUBE_SIDE = 6;
const CUBE_STEP = 40;
const CUBE_BASE = 55;
const GRAY_FIRST = 232;
const GRAY_STEP = 10;
const GRAY_BASE = 8;

const hex2 = (n: number): string => n.toString(16).padStart(2, "0");

/** Cor CSS (`#rrggbb`) de uma cor do quadro. Índice fora de 0–255 é erro, não preto. */
export function colorCss(color: TermColor): string {
  if (color.kind === "rgb") return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
  const n = color.index;
  if (!Number.isInteger(n) || n < 0 || n >= PALETTE_SIZE) throw new RangeError(`índice de paleta fora de 0–255: ${n}`);
  if (n < CUBE_FIRST) return BASE_16[n] as string;
  if (n < GRAY_FIRST) {
    const c = n - CUBE_FIRST;
    const level = (v: number): number => (v === 0 ? 0 : CUBE_BASE + CUBE_STEP * v);
    return `#${hex2(level(Math.floor(c / (CUBE_SIDE * CUBE_SIDE))))}${hex2(level(Math.floor(c / CUBE_SIDE) % CUBE_SIDE))}${hex2(level(c % CUBE_SIDE))}`;
  }
  const gray = GRAY_BASE + GRAY_STEP * (n - GRAY_FIRST);
  return `#${hex2(gray)}${hex2(gray)}${hex2(gray)}`;
}
