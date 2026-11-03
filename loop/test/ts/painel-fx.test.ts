// Componentes fx do painel (kit/panel/ui/fx/, reference/panel.md): o index.html os carrega
// depois do app, a confirmação por segurar continua exposta ao plugin, a abertura respeita as saídas leves e nada vem de CDN.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UI = join(import.meta.dir, "../../../kit/panel/ui");
const read = (rel: string): string => readFileSync(join(UI, rel), "utf8");
const FX = readdirSync(join(UI, "fx")).filter((f) => f.endsWith(".tsx"));

describe("painel fx", () => {
  test("dado o index.html, quando lista os scripts, então hold-button, lazy e intro vêm depois do app.js", () => {
    const html = read("index.html");
    const ordem = ["/ui/app.js", "/ui/fx/hold-button.js", "/ui/fx/lazy.js", "/ui/fx/intro.js"].map((s) => html.indexOf(`<script src="${s}">`));
    expect(ordem.every((i) => i >= 0)).toBe(true);
    expect([...ordem].sort((a, b) => a - b)).toEqual(ordem);
  });

  test("dado o app, quando expõe o núcleo ao plugin, então HoldConfirm está em HadesCore", () => {
    expect(read("app.tsx")).toMatch(/HadesCore[\s\S]*HoldConfirm/);
  });

  test("dado cada fx, então nenhum carrega script ou estilo de URL externa", () => {
    for (const f of FX) expect(read(`fx/${f}`)).not.toMatch(/https?:\/\/(?!www\.w3\.org)[^\s'"`]*\.(js|css|mjs)\b/);
  });

  test("dado a abertura, então pula com prefers-reduced-motion, saveData e sem WebGL2 e roda a cada carregamento, F5 incluso", () => {
    const intro = read("fx/intro.tsx");
    expect(intro).toContain("prefers-reduced-motion");
    expect(intro).toContain("saveData");
    expect(intro).toContain("webgl2");
    expect(intro).not.toContain("sessionStorage");
  });

  test("dado a abertura, então o Metallic Paint pinta o ícone do Hades sem o fundo quadrado, não um texto", () => {
    const intro = read("fx/intro.tsx");
    expect(intro).toContain('imageSrc="/ui/brand/hades-mark.svg"');
    expect(intro).not.toContain("text=");
    const mark = read("brand/hades-mark.svg");
    expect(mark.match(/<path/g)?.length).toBe(1);
    expect(mark).not.toContain("#391a2c");
  });

  test("dado o sw.js e o lazy, então o motion só entra por import() e fica fora do pré-cache", () => {
    expect(read("fx/lazy.tsx")).toContain("import(");
    expect(read("sw.js")).not.toContain("vendor/motion.js");
  });
});
