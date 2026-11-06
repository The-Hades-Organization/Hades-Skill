// Legenda do canvas do Argos: o modelo (src/lib/canvas-argos.ts) é completo e sem duplicata, todo ícone existe no pacote
// de ícones do painel, a cor de texto e de ícone de cada tom passa no contraste AA nos dois temas, e os scripts do
// painel (parts.tsx, canvas-legend.tsx) são sintaticamente válidos.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { legendModel, stateLook, typeLook, TONE_VAR, type Tone } from "../../../src/lib/canvas-argos.ts";

const UI = new URL("../../../kit/panel/ui/", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, UI), "utf8");

const TONES = Object.keys(TONE_VAR) as Tone[];
const TEXT_MIN = 4.5; // WCAG 2.x AA, texto normal (1.4.3)
const GRAPHIC_MIN = 3; // WCAG 2.x AA, ícone e forma (1.4.11)

// ------------------------------------------------------------------ contraste (oklch → sRGB → luminância relativa)

type Oklch = readonly [number, number, number];

function relativeLuminance([lightness, chroma, hueDeg]: Oklch): number {
  const a = chroma * Math.cos((hueDeg * Math.PI) / 180);
  const b = chroma * Math.sin((hueDeg * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  const r = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bl = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

const contrast = (a: Oklch, b: Oklch): number => {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const html = read("index.html");

/** Os tokens oklch declarados no bloco `selector { … }` do tema (o primeiro bloco com esse seletor). */
function themeTokens(selector: string): Map<string, Oklch> {
  const start = html.indexOf(`\n${selector} {`);
  expect(start, `bloco ${selector} no index.html`).toBeGreaterThan(-1);
  const body = html.slice(start, html.indexOf("\n}", start));
  const tokens = new Map<string, Oklch>();
  for (const m of body.matchAll(/--([a-z-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)\s*;/g)) {
    tokens.set(m[1] as string, [Number(m[2]), Number(m[3]), Number(m[4])]);
  }
  return tokens;
}

const THEMES = [["claro", themeTokens(":root")], ["escuro", themeTokens(".dark")]] as const;
const SURFACES = ["card", "background"] as const;

/** O token que a classe `text-<token>` de cada tom usa, lido das tabelas de parts.tsx (a fonte do que se vê). */
function toneTokens(table: "TONE_TEXT" | "TONE_ICON"): Record<Tone, string> {
  const line = read("argos/parts.tsx").split("\n").find((l) => l.startsWith(`const ${table} =`));
  expect(line, `${table} em parts.tsx`).toBeDefined();
  const out = {} as Record<Tone, string>;
  for (const tone of TONES) {
    const m = new RegExp(`\\b${tone}:\\s*'text-([a-z-]+)'`).exec(line as string);
    expect(m, `${table}.${tone}`).not.toBeNull();
    out[tone] = (m as RegExpExecArray)[1] as string;
  }
  return out;
}

// ------------------------------------------------------------------ modelo

describe("legenda: o modelo", () => {
  const model = legendModel();

  test("dado o modelo, então tipos, estados e indicadores não se repetem", () => {
    expect(new Set(model.types.map((t) => t.type)).size).toBe(model.types.length);
    expect(new Set(model.states.map((s) => s.id)).size).toBe(model.states.length);
    const keys = model.indicators.map((i) => `${i.kind}|${i.label}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("dado o modelo, então cada tipo traz a forma e o ícone que o nó usa", () => {
    expect(model.types.length).toBeGreaterThan(0);
    for (const t of model.types) expect(t).toEqual(typeLook(t.type));
    expect(new Set(model.types.map((t) => t.shape)).size).toBe(model.types.length);
  });

  test("dado o modelo, então cada estado traz a mesma aparência que o nó usa e tem palavra", () => {
    const byId = new Map(model.states.map((s) => [s.id, s.look]));
    expect(byId.get("working")).toEqual(stateLook("working"));
    expect(byId.get("attention")).toEqual(stateLook("working", "attention"));
    expect(byId.get("stalled")).toEqual(stateLook("working", "stalled"));
    for (const s of model.states) expect(s.look.word.trim(), `palavra de ${s.id}`).not.toBe("");
  });

  test("dado o modelo, então nenhum estado se distingue só pela cor (ícone ou palavra difere dos de mesmo tom)", () => {
    for (const tone of TONES) {
      const same = model.states.filter((s) => s.look.tone === tone);
      expect(new Set(same.map((s) => `${s.look.icon}|${s.look.word}`)).size, `tom ${tone}`).toBe(same.length);
    }
  });

  test("dado o modelo, então cobre os nove indicadores do nó e a CI nos três veredictos", () => {
    const kinds = new Set(model.indicators.map((i) => i.kind));
    expect([...kinds].sort()).toEqual(["ci", "closed", "context", "cost", "gate", "herdr", "model", "permission", "pr", "question"]);
    expect(model.indicators.filter((i) => i.kind === "gate")).toHaveLength(3);
    expect(model.indicators.filter((i) => i.kind === "ci")).toHaveLength(3);
    for (const i of model.indicators) expect(i.label.trim(), `rótulo de ${i.kind}`).not.toBe("");
  });

  test("dado o modelo, então todo ícone usado existe no pacote de ícones do painel", () => {
    const vendor = read("vendor/lucide-react.js");
    const icons = new Set([
      ...model.types.map((t) => t.icon),
      ...model.states.map((s) => s.look.icon),
      ...model.indicators.map((i) => i.icon),
      "Shapes", // o botão da legenda
    ]);
    for (const icon of icons) expect(vendor.includes(`${icon}=`) || vendor.includes(`${icon}:`), `ícone ${icon}`).toBe(true);
  });

  test("dado o modelo, então todo tom usado tem variável de cor definida", () => {
    const tones = new Set([...model.states.map((s) => s.look.tone), ...model.indicators.map((i) => i.tone)]);
    for (const tone of tones) expect(TONE_VAR[tone], `tom ${tone}`).toMatch(/^--[a-z-]+$/);
  });
});

// ------------------------------------------------------------------ contraste AA nos dois temas

describe("legenda: contraste nos dois temas", () => {
  const textTokens = toneTokens("TONE_TEXT");
  const iconTokens = toneTokens("TONE_ICON");

  for (const [theme, tokens] of THEMES) {
    for (const surface of SURFACES) {
      test(`dado o tema ${theme} sobre ${surface}, então o texto de cada tom tem contraste ≥ ${TEXT_MIN}`, () => {
        const bg = tokens.get(surface);
        expect(bg, `--${surface} no tema ${theme}`).toBeDefined();
        for (const tone of TONES) {
          const fg = tokens.get(textTokens[tone]);
          expect(fg, `--${textTokens[tone]} no tema ${theme}`).toBeDefined();
          expect(contrast(fg as Oklch, bg as Oklch), `${tone} (${textTokens[tone]}) sobre ${surface}, tema ${theme}`).toBeGreaterThanOrEqual(TEXT_MIN);
        }
      });

      test(`dado o tema ${theme} sobre ${surface}, então o ícone de cada tom tem contraste ≥ ${GRAPHIC_MIN}`, () => {
        const bg = tokens.get(surface);
        expect(bg, `--${surface} no tema ${theme}`).toBeDefined();
        for (const tone of TONES) {
          const fg = tokens.get(iconTokens[tone]);
          expect(fg, `--${iconTokens[tone]} no tema ${theme}`).toBeDefined();
          expect(contrast(fg as Oklch, bg as Oklch), `${tone} (${iconTokens[tone]}) sobre ${surface}, tema ${theme}`).toBeGreaterThanOrEqual(GRAPHIC_MIN);
        }
      });
    }
  }

  test("dado o contraste do preto no branco, então a conta dá 21 (sanidade da fórmula)", () => {
    expect(contrast([0, 0, 0], [1, 0, 0])).toBeCloseTo(21, 0);
  });
});

// ------------------------------------------------------------------ scripts do painel

describe("legenda: scripts do painel", () => {
  for (const file of ["argos/parts.tsx", "argos/canvas-legend.tsx"]) {
    test(`dado ${file}, então transpila sem erro de sintaxe`, () => {
      const out = new Bun.Transpiler({ loader: "tsx" }).transformSync(read(file));
      expect(out.length).toBeGreaterThan(0);
    });
  }

  test("dado o index.html, então o script da legenda carrega depois do parts.js", () => {
    const parts = html.indexOf("argos/parts.js");
    const legend = html.indexOf("argos/canvas-legend.js");
    expect(parts).toBeGreaterThan(-1);
    expect(legend).toBeGreaterThan(parts);
  });
});
